// The Host Agent's one message to the Hub API (Story 9.5, AD-49; the Event Log replication is Story 10.1): `POST /agent/push`,
// built and sent here and nowhere else. A push is the agent's whole view of this host at one instant: `agentStatus` (the Mac's
// own view, on the Mac's clock), one reading per lane of this host (the iPad, read through the RAW devicectl seam, in the
// served form), and `events`, the next slice of this host's Event Log for the Hub API's replica. It is sent only through the
// injected `send`, which defaults to `hub-client.request` (AD-26): no socket, `fetch` or child process is opened under tools/host-agent/.
//
// Replication (Story 10.1): the agent keeps no cursor of its own — disk and the Hub API are the only state. Every 2xx push
// answer carries `replica: {<month>: <settled size>}` (and `/agent/sync` hands the same sizes over), and the agent resumes
// from those acknowledged sizes, including at its start: on each trigger it compares every source month's complete-line end
// (eventsEnd) with the acknowledged size and pushes the oldest month that differs, one month per push, at most
// REPLICA_PUSH_MAX_BYTES, until nothing differs. A month whose acknowledged size is past its source end, or not at a line
// start (or holds a line too long to push), is skipped with one `HUB_AGENT_REPLICA_SKIPPED <month> <code>` line and is not
// retried until its acknowledged size changes; the rest still replicate. A month is never closed. The agent sends `events`
// only when it knows the replica sizes, so an old Hub API (a 2xx without a valid `replica`) never gets one, and an old
// agent's `events: null` stays valid. Catch-up rounds carry `null` for `status` and `readings` once a push of the trigger has
// been answered 2xx; the first push of a trigger carries both (read once). A `409 HUB_REPLICA_GAP` with an integer `size`
// adopts that size for the pushed month and the trigger goes on.
//
// `createPusher({policy, env, hostKey, hostId, boot, now, send, status, readings, log})` -> `{push, owed, carried, sync}`:
//   push()      one trigger: a serialized drain (never overlapping another push or a sync). Each attempt uses up the next
//               `seq` (1, 2, ... per `boot`, a failed attempt included). A transport that throws or an answer that is not 2xx
//               is one stderr line, `HUB_AGENT_PUSH_FAILED <message>`, and the push stays owed; it is never retried here or on
//               a timer (the next change notification or the next request to the agent pushes again, tools/host-agent/watch.mjs
//               and server.mjs). It never rejects. A host that does not know its key has no name to push under: that is the
//               same one line and nothing is sent.
//   owed()      true when the last attempt failed and none is running now.
//   carried()   null before the first body was built (or when it carried no readings: nothing to compare to), else a Map of
//               Resource id -> the state the last push carried. A reading seen later that differs is a change worth a push.
//   sync(replica)  `POST /agent/sync` (Story 10.1): adopts the given replica sizes as the acknowledged ones, then runs one
//               trigger (serialized like a push) and answers `{pushed, synced, replica}`: `pushed` whether the drain succeeded,
//               `synced` always true (the sizes were adopted), `replica` the acknowledged sizes after the push.
// `status()` and `readings()` are the agent's own reads (`agentStatus(ctx)`, `laneReadings(ctx)`); a `status` that throws is
// sent as null, a `readings` that throws as null.
import { readdirSync } from 'node:fs';
import { isLane, isLocal, laneReachability, hostKey as realHostKey } from '../device/claims.mjs';
import { eventDir, eventsEnd, readEventsFrom } from '../ci/lib/events.mjs';
import { request as hubRequest } from '../hub-client.mjs';
import { REPLICA_PUSH_MAX_BYTES } from '../hub-api/replica.mjs';
import { serve, stamp } from '../registry/reachability.mjs';

const oneLine = value => String(value?.message ?? value).replace(/\s+/g, ' ').trim();

// The bounds of one trigger's drain: at most this many pushes, and at most this many consecutive gap answers (each adopted
// size moves the offset on, so a persistent gap means the replica and the source disagree beyond this trigger's repair).
const ROUNDS_MAX = 256;
const GAP_MAX = 3;

const MONTH = /^(\d{4}-(?:0[1-9]|1[0-2]))\.jsonl$/;
const SKIPPED = new Set(['HUB_EVENT_OFFSET', 'HUB_EVENT_LINE_TOO_LONG']);

// The source months of this host's Event Log, ascending. Only top-level `YYYY-MM.jsonl` files count.
function monthsOf(env) {
  try {
    return readdirSync(eventDir(env)).map(name => MONTH.exec(name)?.[1]).filter(month => month !== undefined).sort();
  } catch { return []; }
}

// The acknowledged sizes of a 2xx answer's `replica`: null when it is not a valid map of month to a whole number of bytes
// (an old Hub API, or a test fake), so nothing more is sent this trigger.
function validReplica(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const entries = Object.entries(value);
  if (!entries.every(([month, size]) => MONTH.test(`${month}.jsonl`) && Number.isSafeInteger(size) && size >= 0)) return null;
  return new Map(entries);
}

// The readings of this host's lanes in the served form (`serve`), or null when this host's key is unknown. `ctx` is the agent's context
// with its RAW `devicectl` (a read here must not look like a request-path read: see watch.mjs). The iPad is asked once, however many lanes
// the host has; a host with no lane asks nothing. A devicectl that cannot answer reads `unknown` (laneReachability never throws).
export async function laneReadings(ctx) {
  const env = ctx.env ?? process.env;
  let key;
  try { key = (ctx.hostKey ?? realHostKey)({ env }); } catch { return null; }
  const lanes = ctx.known.current().resources.filter(record => isLane(record) && isLocal(record, { hostKey: () => key }));
  if (lanes.length === 0) return [];
  const state = await laneReachability(ctx);
  const at = (ctx.now ?? Date.now)();
  return lanes.map(record => ({ resource: record.id, ...serve({ ...stamp(state, { checkedAt: at, receivedAt: at }), source: 'probe' }, { now: at }) }));
}

export function createPusher({ policy, env = process.env, hostKey, hostId = () => null, boot, now = Date.now, send, status, readings, log = {} } = {}) {
  const transport = send ?? (args => hubRequest(args, { policy }));
  const say = line => { try { log.err?.(line); } catch { /* a broken log seam never changes a push */ } };
  let seq = 0;
  let failed = false;
  let running = false;
  let held = null;
  let acked = null;      // null (unknown) or a Map of month -> the replica size the Hub API acknowledged
  const skipped = new Map();   // month -> the acknowledged size that could not be pushed (retried when it changes)
  let chain = Promise.resolve();

  const fail = reason => {
    failed = true;
    say(`HUB_AGENT_PUSH_FAILED ${oneLine(reason)}`);
    return false;
  };
  const attempt = async read => { try { return await read(); } catch { return null; } };

  // A month whose acknowledged size is past its source end, or not at a line start, cannot be pushed: one line, and it is
  // left out until the acknowledged size changes.
  const skip = (month, want, code) => {
    skipped.set(month, want);
    say(`HUB_AGENT_REPLICA_SKIPPED ${month} ${code}`);
  };

  // The events of the oldest source month whose complete-line end differs from its acknowledged size, or null when every
  // month is replicated. The month is never closed and a push never spans two months.
  function pick() {
    for (const month of monthsOf(env)) {
      const want = acked.get(month) ?? 0;
      if (skipped.get(month) === want) continue;
      const end = eventsEnd({ env, month });
      if (want > end) { skip(month, want, 'HUB_EVENT_OFFSET'); continue; }
      if (want === end) continue;
      let read;
      try { read = readEventsFrom({ env, month, offset: want, maxBytes: REPLICA_PUSH_MAX_BYTES }); } catch (error) {
        if (SKIPPED.has(error?.code)) { skip(month, want, error.code); continue; }
        throw error;
      }
      if (read.lines.length === 0) continue;
      return { month, from_offset: want, lines: read.lines };
    }
    return null;
  }

  // One trigger, serialized: the drain loop. Reads `status` and `readings` once; the first push carries both, the catch-up
  // rounds carry null for them once one push of the trigger was answered 2xx. Returns true when the trigger finished (a 2xx
  // was seen and nothing differs), false when the push stays owed.
  async function drain() {
    running = true;
    try {
      const view = await attempt(status);
      const lanes = await attempt(readings);
      let carry = true;
      let gaps = 0;
      for (let round = 0; round < ROUNDS_MAX; round += 1) {
        const events = acked === null ? null : pick();
        if (!carry && events === null) return true;
        seq += 1;
        let host;
        try { host = hostKey(); } catch (error) { return fail(error); }
        const body = {
          format: 1, host, host_id: (() => { try { return hostId() ?? null; } catch { return null; } })(), boot, seq,
          sent_at: new Date(now()).toISOString(), status: carry ? (view ?? null) : null, readings: carry ? (lanes ?? null) : null, events,
        };
        // Only a round that carries readings replaces what `carried()` reports; a catch-up round leaves it untouched.
        if (carry) held = body.readings === null ? null : new Map(body.readings.map(reading => [reading.resource, reading.state]));
        let response;
        try { response = await transport({ host: 'linux', method: 'POST', path: '/agent/push', body }); } catch (error) { return fail(error); }
        let text = '';
        try { text = await response.text(); } catch { /* an unreadable body says nothing */ }
        let answer = null;
        try { answer = JSON.parse(text); } catch { /* not a JSON answer */ }
        if (response?.ok) {
          acked = validReplica(answer?.replica);
          carry = false;
          gaps = 0;
          failed = false;
          // An old Hub API (or a test fake) answers no valid replica: it never learns of events, so this trigger is done.
          if (events === null && acked === null) return true;
          continue;
        }
        // A gap carries the replica's settled size of the pushed month: adopt it and push again in the same trigger.
        if (response?.status === 409 && answer?.code === 'HUB_REPLICA_GAP' && Number.isSafeInteger(answer.size) && answer.size >= 0 && events !== null && acked !== null) {
          acked.set(events.month, answer.size);
          gaps += 1;
          if (gaps >= GAP_MAX) return fail(`the Hub API keeps answering HUB_REPLICA_GAP for ${events.month}`);
          continue;
        }
        const code = typeof answer?.code === 'string' ? ` ${answer.code}` : '';
        return fail(`the Hub API answered ${response?.status ?? 'nothing'}${code}`);
      }
      return fail(`replication did not settle in ${ROUNDS_MAX} pushes`);
    } catch (error) { return fail(error); } finally { running = false; }
  }

  // The one serialization point: a trigger runs after the previous one has ended, so two pushes never overlap. A failed
  // trigger never ends the chain.
  function enqueue(fn) {
    const next = chain.then(() => fn());
    chain = next.catch(() => {});
    return next;
  }

  function push() {
    return enqueue(() => drain());
  }

  async function sync(replica) {
    return enqueue(async () => {
      acked = new Map(Object.entries(replica));
      const pushed = await drain();
      const sizes = Object.fromEntries([...(acked ?? new Map())].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
      return { pushed, synced: true, replica: sizes };
    });
  }

  return { push, owed: () => failed && !running, carried: () => held, sync };
}
