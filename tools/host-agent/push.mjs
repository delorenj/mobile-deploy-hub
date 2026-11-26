// The Host Agent's one message to the Hub API (Story 9.5, AD-49): `POST /agent/push`, built and sent here and nowhere else. A push is the
// agent's whole view of this host at one instant: `agentStatus` (the Mac's own view, on the Mac's clock), one reading per lane of this host
// (the iPad, read through the RAW devicectl seam, in the served form), and `events: null` (Epic 10 fills it). It is sent only through the
// injected `send`, which defaults to `hub-client.request` (AD-26): no socket, `fetch` or child process is opened under tools/host-agent/.
//
// `createPusher({policy, hostKey, hostId, boot, now, send, status, readings, log})` -> `{push, owed, carried}`:
//   push()      one attempt: it uses up the next `seq` (1, 2, ... per `boot`, a failed attempt included), builds the body, records the readings it
//               carried, sends it, and resolves true on a 2xx answer. A transport that throws or an answer that is not 2xx is one stderr line,
//               `HUB_AGENT_PUSH_FAILED <message>`, and the push stays owed; it is never retried here or on a timer (the next change notification
//               or the next request to the agent pushes again, tools/host-agent/watch.mjs and server.mjs). It never rejects. A host that does
//               not know its key has no name to push under: that is the same one line and nothing is sent.
//   owed()      true when the last attempt failed and none is running now.
//   carried()   null before the first body was built (or when it carried no readings: nothing to compare to), else a Map of Resource id -> the
//               state the last push carried. A reading seen later that differs is a change worth a push.
// `status()` and `readings()` are the agent's own reads (`agentStatus(ctx)`, `laneReadings(ctx)`); a `status` that throws is sent as null, a
// `readings` that throws as null.
import { isLane, isLocal, laneReachability, hostKey as realHostKey } from '../device/claims.mjs';
import { request as hubRequest } from '../hub-client.mjs';
import { serve, stamp } from '../registry/reachability.mjs';

const oneLine = value => String(value?.message ?? value).replace(/\s+/g, ' ').trim();

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

// What a refused answer says, for the stderr line: its status, and the problem's code when the body is one.
async function refusal(response) {
  let more = '';
  try {
    const text = await response.text();
    const parsed = JSON.parse(text);
    if (typeof parsed?.code === 'string') more = ` ${parsed.code}`;
  } catch { /* a body that is not a problem adds nothing */ }
  return `the Hub API answered ${response?.status ?? 'nothing'}${more}`;
}

export function createPusher({ policy, hostKey, hostId = () => null, boot, now = Date.now, send, status, readings, log = {} } = {}) {
  const transport = send ?? (args => hubRequest(args, { policy }));
  const say = line => { try { log.err?.(line); } catch { /* a broken log seam never changes a push */ } };
  let seq = 0;
  let failed = false;
  let running = false;
  let held = null;

  const fail = reason => {
    failed = true;
    say(`HUB_AGENT_PUSH_FAILED ${oneLine(reason)}`);
    return false;
  };
  const attempt = async read => { try { return await read(); } catch { return null; } };

  async function push() {
    running = true;
    try {
      seq += 1;
      let host;
      try { host = hostKey(); } catch (error) { return fail(error); }
      const view = await attempt(status);
      const lanes = await attempt(readings);
      const body = {
        format: 1, host, host_id: (() => { try { return hostId() ?? null; } catch { return null; } })(), boot, seq,
        sent_at: new Date(now()).toISOString(), status: view ?? null, readings: lanes ?? null, events: null,
      };
      held = body.readings === null ? null : new Map(body.readings.map(reading => [reading.resource, reading.state]));
      let response;
      try { response = await transport({ host: 'linux', method: 'POST', path: '/agent/push', body }); } catch (error) { return fail(error); }
      if (!response?.ok) return fail(await refusal(response));
      failed = false;
      return true;
    } finally { running = false; }
  }

  return { push, owed: () => failed && !running, carried: () => held };
}
