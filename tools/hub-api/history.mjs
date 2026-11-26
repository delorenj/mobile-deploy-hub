// `GET /history`'s reader (Story 10.2, FR-18, UJ-4, AD-40): this host's Event Log and every peer host's replica, read with `readEventsFrom`
// (read only: nothing here writes, truncates or deletes an event file or a replica), filtered, merged by `ts` for display and paged by an
// opaque per-host cursor. The pure half (query check, filter, cursor codec, merge pick, range derivation) is tools/registry/history.mjs.
//
// When a peer's replica may lack the window, the peer's `POST /agent/sync` is called first (through hub-client's `forward()` over the
// context's transport, behind the peers' gate), so a Mac that is awake fills the replica before it is read; one that is not leaves the answer
// `partial: true` with `synced_through` per host and the `unreachable_ranges` the `host-reachability` events give. A host's `synced_through`
// is the latest of the send time of a `/agent/sync` that answered `synced: true` (kept in memory: `history.proofs`) and the `ts` of the
// replica's last complete line (rebuilt from disk). This host's own is the request's receipt time.
import { open, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { eventDir, eventsEnd, readEventsFrom } from '../ci/lib/events.mjs';
import { forward, HOST_KEYS } from '../hub-client.mjs';
import { encodeCursor, historyFilter, parseHistoryQuery, pickNext, unreachableRanges } from '../registry/history.mjs';
import { failureReason, isContact, isUnreached } from './peers.mjs';
import { replicaDir } from './replica.mjs';

// Event reads are chunks of this many bytes, and the event loop runs between two of them.
export const HISTORY_CHUNK_BYTES = 256 * 1024;
const TAIL_BYTES = 256 * 1024;
const MONTH_FILE = /^(\d{4}-(?:0[1-9]|1[0-2]))\.jsonl$/;
const SKIPPED = new Set(['HUB_EVENT_OFFSET', 'HUB_EVENT_LINE_TOO_LONG']);

const oneLine = value => String(value?.message ?? value).replace(/\s+/g, ' ').trim();
const monthOf = ms => new Date(ms).toISOString().slice(0, 7);
const turn = () => new Promise(resolve => setImmediate(resolve));
const latest = (...values) => values.reduce((best, value) => (value === null || value === undefined ? best : best === null || value > best ? value : best), null);

// The state `/history` keeps for as long as the service runs: `proofs` maps a peer host key to the send time (ms) of the last `/agent/sync` that
// answered `synced: true`. Nothing of it is on disk.
export const createHistory = () => ({ proofs: new Map() });

// The months of one event dir (`YYYY-MM.jsonl`, top level only, so `replicas/` is never a month), ascending. A missing dir has none.
export async function listMonths(dir) {
  let names;
  try { names = await readdir(dir); } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  return names.map(name => MONTH_FILE.exec(name)?.[1]).filter(month => month !== undefined).sort();
}

const badCursor = message => Object.assign(new Error(message), { code: 'HUB_USAGE', status: 400, reason: 'bad-cursor' });

// A reader of one host's months (`root` is the event dir: this host's own, or `replicas/<host>`), yielding the entries `accept` takes.
//   start      `{month, offset}` from a cursor, or null (the first month in range, from 0); a position this log never had is 400 `bad-cursor`
//   fromMonth, toMonth   the months that can hold the window (`YYYY-MM`, or null)
//   accept     the predicate over a parsed event
// `peek()` -> the next matching `{host, month, offset, id, event, ts}` or null (it scans on, in chunks, yielding to the event loop between two);
// `take()` -> that entry, and the reader moves past it; `position()` -> `{month, offset}`, where a read for the rest starts: the pending entry's
// own place while one is waiting, else the point after the last byte scanned (null for a host with no log and no start).
// A line over the chunk bound (a hand edit) is one `HUB_API_HISTORY_SKIPPED <host> <month> <code>` line and the rest of that month is skipped.
export function openReader({ host, root, env = process.env, start = null, fromMonth = null, toMonth = null, accept, hostId, log = () => {}, chunkBytes = HISTORY_CHUNK_BYTES }) {
  const readEnv = { ...env, HUB_EVENT_DIR: root };
  let months = null;
  let index = 0;
  let offset = 0;
  let pending = [];
  let cursor = 0;
  let pendingMonth = null;
  let at = start === null ? null : { month: start.month, offset: start.offset };
  let head = null;
  let done = false;
  let firstRead = true;

  async function fill() {
    if (months === null) {
      const all = await listMonths(root);
      if (start !== null && !all.includes(start.month)) throw badCursor(`the cursor's month ${start.month} is not one ${host}'s log has`);
      months = all.filter(month => (fromMonth === null || month >= fromMonth) && (toMonth === null || month <= toMonth) && (start === null || month >= start.month));
      offset = months[0] !== undefined && start !== null && months[0] === start.month ? start.offset : 0;
    }
    while (head === null && !done) {
      while (cursor < pending.length) {
        const entry = pending[cursor];
        cursor += 1;
        if (entry.event !== null && accept(entry.event)) {
          const ts = Date.parse(entry.event.ts);
          head = { host, month: pendingMonth, offset: entry.offset, id: entry.id, event: entry.event, ts: Number.isFinite(ts) ? ts : null };
          break;
        }
      }
      if (head !== null) break;
      if (index >= months.length) { done = true; break; }
      const month = months[index];
      await turn();
      let read;
      try {
        read = readEventsFrom({ env: readEnv, month, offset, maxBytes: chunkBytes, ...(hostId === undefined ? {} : { hostId }) });
      } catch (error) {
        if (!SKIPPED.has(error?.code)) throw error;
        if (firstRead && start !== null && month === start.month && offset === start.offset && error.code === 'HUB_EVENT_OFFSET') throw badCursor(`the cursor's position ${month}/${offset} is not one ${host}'s log has`);
        try { log(`HUB_API_HISTORY_SKIPPED ${host} ${month} ${error.code}`); } catch { /* a broken log never changes an answer */ }
        offset = eventsEnd({ env: readEnv, month });
        at = { month, offset };
        pending = [];
        cursor = 0;
        index += 1;
        offset = 0;
        firstRead = false;
        continue;
      }
      firstRead = false;
      if (read.events.length === 0) {
        at = { month, offset: read.offset };
        index += 1;
        offset = 0;
        pending = [];
        cursor = 0;
        continue;
      }
      pending = read.events;
      cursor = 0;
      pendingMonth = month;
      offset = read.offset;
      at = { month, offset: read.offset };
    }
  }

  return {
    async peek() { await fill(); return head; },
    take() { const taken = head; head = null; return taken; },
    position() { return head !== null ? { month: head.month, offset: head.offset } : at; },
  };
}

// The `ts` (ms) of the last complete line of a host's replica that has a readable one: the newest non-empty month's tail, else an older month's;
// null when the replica holds none. A torn tail (no newline after it) is not a line.
export async function replicaLastTs(env, host) {
  const dir = replicaDir(env, host);
  for (const month of (await listMonths(dir)).reverse()) {
    let handle;
    try { handle = await open(join(dir, `${month}.jsonl`), 'r'); } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    try {
      const { size } = await handle.stat();
      if (size === 0) continue;
      const begin = Math.max(0, size - TAIL_BYTES);
      const buffer = Buffer.alloc(size - begin);
      let got = 0;
      while (got < buffer.length) {
        const { bytesRead } = await handle.read(buffer, got, buffer.length - got, begin + got);
        if (bytesRead === 0) break;
        got += bytesRead;
      }
      const last = buffer.subarray(0, got).lastIndexOf(0x0a);
      if (last === -1) continue;
      const lines = buffer.toString('utf8', 0, last).split('\n');
      // A tail that starts mid-line has a partial first segment.
      if (begin > 0) lines.shift();
      for (let i = lines.length - 1; i >= 0; i -= 1) {
        let parsed = null;
        try { parsed = JSON.parse(lines[i]); } catch { /* not an event */ }
        const ts = Date.parse(parsed?.ts);
        if (Number.isFinite(ts)) return ts;
      }
    } finally { await handle.close(); }
  }
  return null;
}

export const abortError = signal => signal?.reason ?? Object.assign(new Error('the request was aborted'), { name: 'AbortError' });

// Asks one peer to push what its replica lacks: `POST /agent/sync` with the replica's settled sizes. The marks gate it (`peers.gate` throws the
// fast-fail HUB_DEVICE_AWAY of a marked host, before any transport call), the sizes are read under the replica's queue and the call is made
// outside it (the agent's own pushes need it). A call that fails at the ssh leg marks the host, one that gets any answer is contact. A synced
// answer is remembered with the time it was sent. Throws whatever the call threw; the caller decides what it means for the answer.
async function syncPeer({ host, peers, replicas, history, transport, now, signal, contact, failure }) {
  peers.gate(host, { at: now() });
  const sizes = await replicas.exclusive(host, () => replicas.sizes(host));
  const sent = now();
  let answer;
  try {
    answer = await forward({ host, method: 'POST', path: '/agent/sync', body: { replica: sizes }, signal }, { request: transport });
  } catch (error) {
    if (signal?.aborted !== true) {
      if (isUnreached(error)) failure(host, { at: now(), reason: failureReason(error) });
      else if (isContact(error)) contact(host, { at: now(), reason: 'call' });
    }
    throw error;
  }
  contact(host, { at: now(), reason: 'call' });
  if (answer.body?.synced === true) history.proofs.set(host, sent);
}

// Where each peer's replica stands, and a sync for the ones that may lack the window `[.., windowEnd]` (Story 10.2; `GET /utilisation` calls the same
// step, Story 10.3). Returns `{through, partial, spokes}`: `through` maps every host key to its `synced_through` in ms or null (this host's own is
// `at`, the request's receipt time), `partial` is true when some peer's is null or before `windowEnd`, `spokes` the peer host keys. A peer that
// cannot be reached is the expected case (partial), not a fault; anything else is one `HUB_API_HISTORY_SYNC_FAILED` line.
export async function coverPeers({ own, env = process.env, windowEnd, at, peers, replicas, history, transport, now = Date.now, signal, contact = () => {}, failure = () => {}, log = () => {} }) {
  const spokes = HOST_KEYS.filter(host => host !== own);
  const through = {};
  for (const host of spokes) {
    const covered = async () => latest(await replicaLastTs(env, host), history.proofs.get(host) ?? null);
    through[host] = await covered();
    if (through[host] === null || through[host] < windowEnd) {
      try {
        await syncPeer({ host, peers, replicas, history, transport, now, signal, contact, failure });
      } catch (error) {
        if (signal?.aborted === true) throw abortError(signal);
        // An unreachable host is the expected case (partial), not a fault; anything else is one line.
        if (!(error?.code === 'HUB_DEVICE_AWAY')) { try { log(`HUB_API_HISTORY_SYNC_FAILED ${host} ${oneLine(error)}`); } catch { /* a broken log never changes an answer */ } }
      }
      through[host] = await covered();
    }
  }
  through[own] = at;
  const partial = spokes.some(host => through[host] === null || through[host] < windowEnd);
  return { through, partial, spokes };
}

// The whole of `GET /history`: the checked query, the on-demand syncs, the merged and paged read, and the gaps. `registry` is a function (the
// Registry is read only for a query that passed the check); `transport` the context's one transport (`transportOf(ctx)`); `contact` and `failure`
// the callbacks that note a peer's mark; `now` the clock. Answers `History`.
export async function queryHistory({ query: params, own, env = process.env, registry, hostId, now = Date.now, signal, peers, replicas, history, transport, contact = () => {}, failure = () => {}, log = () => {} }) {
  const query = parseHistoryQuery(params);
  const at = now();
  const windowEnd = query.to ?? at;

  // 1. Where each peer's replica stands, and a sync for the ones that may lack the window.
  const { through, partial, spokes } = await coverPeers({ own, env, windowEnd, at, peers, replicas, history, transport, now, signal, contact, failure, log });

  // 2. The k-way read: one reader per host in host key order, one matched head each.
  // The Registry is read only for a filter that needs it (a time-only query never fails on it).
  const accept = historyFilter(query, query.resource !== null || query.pool !== null ? registry() : null);
  const fromMonth = query.from === null ? null : monthOf(query.from);
  const toMonth = query.to === null ? null : monthOf(query.to);
  const readers = HOST_KEYS.map(host => openReader({
    host, root: host === own ? eventDir(env) : replicaDir(env, host), env, start: query.cursor?.[host] ?? null, fromMonth, toMonth, accept,
    ...(host === own && hostId !== undefined ? { hostId } : {}), log,
  }));
  const events = [];
  let heads;
  for (;;) {
    heads = await Promise.all(readers.map(reader => reader.peek()));
    if (events.length >= query.limit) break;
    const next = pickNext(heads);
    if (next === -1) break;
    const entry = readers[next].take();
    events.push({ id: entry.id, host: entry.host, event: entry.event });
  }
  const more = heads.some(head => head !== null);
  const positions = {};
  for (const [index, host] of HOST_KEYS.entries()) {
    const position = readers[index].position();
    if (position !== null) positions[host] = position;
  }

  // 3. The gaps, from this host's own `host-reachability` events, only when something is missing.
  let ranges = [];
  if (partial) {
    const reachability = openReader({
      host: own, root: eventDir(env), env, toMonth: monthOf(windowEnd), hostId, log,
      accept: event => event.event === 'host-reachability' && spokes.includes(event.host),
    });
    const seen = [];
    for (let entry = await reachability.peek(); entry !== null; entry = await reachability.peek()) { seen.push(reachability.take().event); }
    ranges = unreachableRanges(seen, { own, window: { from: query.from, to: windowEnd }, syncedThrough: through });
  }

  return {
    format: 1,
    events,
    cursor: Object.keys(positions).length === 0 ? null : encodeCursor(positions),
    more,
    partial,
    synced_through: Object.fromEntries(HOST_KEYS.map(host => [host, through[host] === null || through[host] === undefined ? null : new Date(through[host]).toISOString()])),
    unreachable_ranges: ranges,
    cross_host_order: 'display-only',
    checked_at: new Date(at).toISOString(),
  };
}
