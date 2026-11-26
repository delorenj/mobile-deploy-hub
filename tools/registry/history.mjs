// History over the Event Logs (Story 10.2, FR-18, UJ-4, AD-40): the pure half of `GET /history`. No fs, no clock, no network: the
// query check, the filter, the `lock -> resource` map, the per-host cursor codec, the merge pick and the unreachable-range derivation
// live here; tools/hub-api/history.mjs reads the logs and the replicas and calls the Host Agent. Story 10.3's `utilisation` goes in this file.
//
// Everything is keyed by host key (`HOST_KEYS`), so a second spoke host needs no new code. Order is total per host (month, then byte
// offset); the merge across hosts by `ts` is for display only and no consumer derives a cross-host order from it.
//
// Errors are coded (`code`, `status`, `reason`) and carry no `exit`: the API's one table (claims.mjs) maps the code.
import { HOST_KEYS } from '../hub-client.mjs';
import { resourceOf } from '../ci/lib/lock.mjs';

export const HISTORY_KEYS = Object.freeze(['resource', 'pool', 'claimant', 'repo', 'from', 'to', 'cursor', 'limit']);
export const HISTORY_LIMIT_DEFAULT = 100;
export const HISTORY_LIMIT_MAX = 1000;
// The longest filter value or cursor a request may carry.
const VALUE_MAX = 256;
const CURSOR_MAX = 4096;

const usage = (reason, message) => Object.assign(new Error(message), { code: 'HUB_USAGE', status: 400, reason });
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const POSITION = /^(\d{4}-(?:0[1-9]|1[0-2]))\/(0|[1-9]\d*)$/;
const TIME = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2}))?$/;

// ---- the cursor ----

// `{<host key>: {month, offset}}` as the opaque cursor: base64url of the JSON `{<host key>: "<month>/<offset>"}`, keys in HOST_KEYS order.
// A position is the place the next read of that host starts.
export function encodeCursor(positions) {
  const out = {};
  for (const host of HOST_KEYS) {
    const position = positions?.[host];
    if (position === undefined || position === null) continue;
    if (typeof position.month !== 'string' || !MONTH.test(position.month) || !Number.isSafeInteger(position.offset) || position.offset < 0) throw new TypeError(`bad cursor position for ${host}`);
    out[host] = `${position.month}/${position.offset}`;
  }
  return Buffer.from(JSON.stringify(out), 'utf8').toString('base64url');
}

// The positions a cursor names, `{<host key>: {month, offset}}`; a cursor that is not exactly what `encodeCursor` writes is 400 `bad-cursor`
// (not base64url, not JSON, not a plain object, a key outside HOST_KEYS, a value that is not `YYYY-MM/<whole number>`, or any other spelling
// of the same cursor).
export function decodeCursor(text) {
  const bad = why => usage('bad-cursor', `the cursor is not one this API gave out (${why})`);
  if (typeof text !== 'string' || text === '' || text.length > CURSOR_MAX || !/^[A-Za-z0-9_-]+$/.test(text)) throw bad('not base64url');
  let parsed;
  try { parsed = JSON.parse(Buffer.from(text, 'base64url').toString('utf8')); } catch { throw bad('not JSON'); }
  if (!isObject(parsed)) throw bad('not an object');
  const positions = {};
  for (const [host, value] of Object.entries(parsed)) {
    if (!HOST_KEYS.includes(host)) throw bad(`no host "${host}"`);
    const match = typeof value === 'string' ? POSITION.exec(value) : null;
    const offset = match === null ? NaN : Number(match[2]);
    if (match === null || !Number.isSafeInteger(offset)) throw bad(`bad position for ${host}`);
    positions[host] = { month: match[1], offset };
  }
  if (encodeCursor(positions) !== text) throw bad('not canonical');
  return positions;
}

// ---- the query ----

function timeOf(text, key) {
  const ms = TIME.test(text) ? Date.parse(text) : NaN;
  if (!Number.isFinite(ms)) throw usage('bad-range', `${key} must be an ISO time (2026-11-01T00:00:00Z)`);
  return ms;
}

// The checked query of `GET /history`: `{resource, pool, claimant, repo, from, to, cursor, limit}` (strings or null; `from` and `to` in ms or
// null; `cursor` the decoded positions or null; `limit` a whole number). `params` is a URLSearchParams (or its text). An unknown, repeated or
// empty key is `bad-query`, a `limit` outside 1 to 1000 `bad-limit`, a bad time or `from` after `to` `bad-range`, a bad cursor `bad-cursor`.
// `from` is inclusive and `to` exclusive.
export function parseHistoryQuery(params) {
  const given = params instanceof URLSearchParams ? params : new URLSearchParams(String(params ?? ''));
  const seen = new Map();
  for (const [key, value] of given.entries()) {
    if (!HISTORY_KEYS.includes(key)) throw usage('bad-query', `"${key}" is not a query key (${HISTORY_KEYS.join(', ')})`);
    if (seen.has(key)) throw usage('bad-query', `"${key}" is given twice`);
    if (value === '') throw usage('bad-query', `"${key}" is empty`);
    if (key !== 'cursor' && value.length > VALUE_MAX) throw usage('bad-query', `"${key}" is over ${VALUE_MAX} characters`);
    seen.set(key, value);
  }
  let limit = HISTORY_LIMIT_DEFAULT;
  if (seen.has('limit')) {
    const text = seen.get('limit');
    limit = /^[1-9]\d{0,3}$/.test(text) ? Number(text) : NaN;
    if (!(limit >= 1 && limit <= HISTORY_LIMIT_MAX)) throw usage('bad-limit', `limit must be a whole number from 1 to ${HISTORY_LIMIT_MAX}`);
  }
  const from = seen.has('from') ? timeOf(seen.get('from'), 'from') : null;
  const to = seen.has('to') ? timeOf(seen.get('to'), 'to') : null;
  if (from !== null && to !== null && from > to) throw usage('bad-range', 'from is after to');
  const cursor = seen.has('cursor') ? decodeCursor(seen.get('cursor')) : null;
  return { resource: seen.get('resource') ?? null, pool: seen.get('pool') ?? null, claimant: seen.get('claimant') ?? null, repo: seen.get('repo') ?? null, from, to, cursor, limit };
}

// ---- the filter ----

// `lock -> Resource id`: the Registry's records by lock first (a retired one too: its history is still history), then the lock-name rule
// (`resourceOf`: the seed's locks, the emulator slots, `res-*`). A v1a event with no `resource` field still attributes correctly.
export function lockToResource(registry) {
  const byLock = new Map();
  for (const record of registry?.resources ?? []) if (typeof record?.lock === 'string' && typeof record?.id === 'string') byLock.set(record.lock, record.id);
  return lock => (typeof lock !== 'string' ? null : byLock.get(lock) ?? resourceOf(lock));
}

// The Resource ids a Pool stands for, or null when the Registry has no such Pool: a named Pool's members, plus the runtime phones on linux that
// the matcher adds to any named Pool (tools/registry/match.mjs); a gate Pool's own Resource (its lock's).
function poolMembers(registry, name) {
  const pool = registry?.pools?.[name];
  if (!isObject(pool)) return null;
  const ids = new Set();
  if (Array.isArray(pool.members)) {
    for (const id of pool.members) ids.add(id);
    for (const record of registry?.resources ?? []) if (record?.seeded === false && record.kind === 'phone' && record.host === 'linux') ids.add(record.id);
  }
  if (typeof pool.gate === 'string') { const id = resourceOf(pool.gate); if (id !== null) ids.add(id); }
  return { ids, gate: typeof pool.gate === 'string' ? pool.gate : null };
}

// The predicate of a checked query over one event (a parsed Event Log object): the filters are ANDed.
//   resource  the event's Resource is the one named (an id or a name), by its `resource` field or else by its `lock`;
//   pool      the event's own `pool` is it, or its Resource is a member of it (a gate Pool: its lock's Resource);
//   claimant  the event's claimant kind (`agent`, `person`, `deploy`, `hub-job`) or holder is it;
//   repo      the event's claimant repo or delivery repo is it;
//   from, to  `ts` in [from, to); an event with no readable `ts` is out when either is set.
export function historyFilter(query, registry) {
  const toResource = lockToResource(registry);
  const resourceOfEvent = event => (typeof event.resource === 'string' && event.resource !== '' ? event.resource : toResource(event.lock));
  const has = value => value !== null && value !== undefined;
  let wanted = null;
  if (has(query.resource)) {
    wanted = new Set([query.resource]);
    for (const record of registry?.resources ?? []) if (record?.name === query.resource || record?.id === query.resource) wanted.add(record.id);
  }
  const pool = has(query.pool) ? { name: query.pool, ...(poolMembers(registry, query.pool) ?? { ids: new Set(), gate: null }) } : null;
  const bounded = has(query.from) || has(query.to);
  return event => {
    if (!isObject(event)) return false;
    if (bounded) {
      const ts = Date.parse(event.ts);
      if (!Number.isFinite(ts)) return false;
      if (has(query.from) && ts < query.from) return false;
      if (has(query.to) && ts >= query.to) return false;
    }
    if (wanted !== null && !wanted.has(resourceOfEvent(event))) return false;
    if (pool !== null && event.pool !== pool.name && !pool.ids.has(resourceOfEvent(event)) && !(pool.gate !== null && event.lock === pool.gate)) return false;
    if (has(query.claimant) && event.claimant?.kind !== query.claimant && event.claimant?.holder !== query.claimant) return false;
    if (has(query.repo) && event.claimant?.repo !== query.repo && event.delivery?.repo !== query.repo) return false;
    return true;
  };
}

// ---- the merge ----

// The index of the next entry to show among the hosts' heads, given in host key order: `heads[i]` is `{ts}` (ms, or null for a line with no
// readable ts) or null when that host has nothing left. The smallest `ts` goes first, a missing `ts` before any, a tie to the earlier host key.
// -1 when every head is null. Display order only.
export function pickNext(heads) {
  let best = -1;
  for (const [index, head] of heads.entries()) {
    if (head === null || head === undefined) continue;
    if (best === -1) { best = index; continue; }
    const a = Number.isFinite(head.ts) ? head.ts : null;
    const b = Number.isFinite(heads[best].ts) ? heads[best].ts : null;
    if (a === null ? b !== null : b !== null && a < b) best = index;
  }
  return best;
}

// ---- unreachable ranges ----

const iso = ms => new Date(ms).toISOString();

// The ranges a peer host could not be asked, from the `host-reachability` events of this host's own log (`{host: <peer key>, to: unreachable |
// reachable, ts}`): an `unreachable` opens a range at its `ts` and the next `reachable` closes it (a range still open ends at the window's end);
// a `reachable` with nothing open and an `unreachable` while open say nothing new. Each range is then clipped to
// `[max(window.from, syncedThrough[host]), window.to)` (what the replica already covers is not a gap, so a Mac that was asleep and later synced
// leaves none) and an empty one is dropped. `own` (this host's key) is skipped. `window` is `{from: ms|null, to: ms}`, `syncedThrough` maps a
// host key to ms or null. Returns `[{host, from, to}]` (ISO), by host key order and then by time.
export function unreachableRanges(events, { own, window, syncedThrough = {} } = {}) {
  const ordered = (events ?? []).filter(event => isObject(event) && event.event === 'host-reachability' && typeof event.host === 'string' && event.host !== own && Number.isFinite(Date.parse(event.ts)))
    .map(event => ({ host: event.host, to: event.to, at: Date.parse(event.ts) }))
    .sort((a, b) => a.at - b.at);
  const open = new Map();
  const raw = [];
  for (const event of ordered) {
    if (event.to === 'unreachable') {
      if (!open.has(event.host)) open.set(event.host, event.at);
    } else if (event.to === 'reachable' && open.has(event.host)) {
      raw.push({ host: event.host, from: open.get(event.host), to: event.at });
      open.delete(event.host);
    }
  }
  for (const [host, from] of open) raw.push({ host, from, to: window.to });
  const out = [];
  for (const range of raw) {
    const floor = Math.max(window.from ?? -Infinity, syncedThrough[range.host] ?? -Infinity);
    const from = Math.max(range.from, floor);
    const to = Math.min(range.to, window.to);
    if (from < to) out.push({ host: range.host, from, to });
  }
  const rank = host => { const index = HOST_KEYS.indexOf(host); return index === -1 ? HOST_KEYS.length : index; };
  return out.sort((a, b) => rank(a.host) - rank(b.host) || a.host.localeCompare(b.host) || a.from - b.from).map(({ host, from, to }) => ({ host, from: iso(from), to: iso(to) }));
}
