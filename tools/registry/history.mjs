// History over the Event Logs (Story 10.2, FR-18, UJ-4, AD-40): the pure half of `GET /history`. No fs, no clock, no network: the
// query check, the filter, the `lock -> resource` map, the per-host cursor codec, the merge pick and the unreachable-range derivation
// live here, and so does Story 10.3's `utilisation` (the fold and the shares of `GET /utilisation`); tools/hub-api/history.mjs reads the logs and the
// replicas and calls the Host Agent, tools/hub-api/utilisation.mjs caches the fold.
//
// Everything is keyed by host key (`HOST_KEYS`), so a second spoke host needs no new code. Order is total per host (month, then byte
// offset); the merge across hosts by `ts` is for display only and no consumer derives a cross-host order from it.
//
// Errors are coded (`code`, `status`, `reason`) and carry no `exit`: the API's one table (claims.mjs) maps the code.
import { HOST_KEYS } from '../hub-client.mjs';
import { EMULATOR_POOL, resourceOf } from '../ci/lib/lock.mjs';
import { retirement } from './match.mjs';

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
    for (const record of registry?.resources ?? []) if (record?.seeded === false && record.kind === 'phone' && record.host === 'linux' && record.capabilities?.dedicated_qa !== true) ids.add(record.id);
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

// ---- utilisation (Story 10.3, FR-18, AD-40, addendum B.7) ----
//
// How a Resource spent a window: the share of it held, idle while reserved, idle, away, or `unknown`. Pure: a fold of Event Log events into a
// per-lock / per-Resource timeline (`createTimeline`, `foldEvent`: incremental, so a cache can advance it over only the lines appended since) and a
// share computation over a folded timeline (`sharesOf`). Everything is keyed by lock and by Resource id, never by host name, so a further host,
// phone or `res-*` Resource is covered with no new code.

export const UTILISATION_KEYS = Object.freeze(['from', 'to']);
export const UTILISATION_CLASSES = Object.freeze(['held', 'idle_while_reserved', 'idle', 'away', 'unknown']);
export const DEFAULT_MAX_AGE_S = 60;
const SLOT = /^emulator-(\d+)$/;
const HOLD_KINDS = ['lease', 'job'];
const HOLD_ENDS = ['release', 'reclaim', 'force-release'];
const RESERVATION_ENDS = ['release', 'expiry', 'force-release'];
const finite = value => Number.isFinite(value);
const msOf = value => (typeof value === 'string' ? Date.parse(value) : NaN);

// The checked query of `GET /utilisation`: `{from, to}` in ms. Only `from` (required) and `to` are keys; an unknown, repeated, empty or missing
// key is 400 `bad-query`, a bad time or an empty window `bad-range`. `to` defaults to, and is clipped to, `at` (the request's receipt time).
export function parseUtilisationQuery(params, { at } = {}) {
  const given = params instanceof URLSearchParams ? params : new URLSearchParams(String(params ?? ''));
  const seen = new Map();
  for (const [key, value] of given.entries()) {
    if (!UTILISATION_KEYS.includes(key)) throw usage('bad-query', `"${key}" is not a query key (${UTILISATION_KEYS.join(', ')})`);
    if (seen.has(key)) throw usage('bad-query', `"${key}" is given twice`);
    if (value === '') throw usage('bad-query', `"${key}" is empty`);
    if (value.length > VALUE_MAX) throw usage('bad-query', `"${key}" is over ${VALUE_MAX} characters`);
    seen.set(key, value);
  }
  if (!seen.has('from')) throw usage('bad-query', '"from" is required');
  const from = timeOf(seen.get('from'), 'from');
  const asked = seen.has('to') ? timeOf(seen.get('to'), 'to') : at;
  const to = finite(at) ? Math.min(asked, at) : asked;
  if (!(from < to)) throw usage('bad-range', 'from must be before to (and before now)');
  return { from, to };
}

// ---- the fold ----

// The empty timeline. Maps keyed by lock unless noted:
//   held      closed Hold intervals `[start, end]` (ms);       open      the open Hold `{start, expires}` (expires is Infinity for a job's)
//   reserved  closed Reservation intervals;                     claims    open Reservations by `lock\0run_key`: `{lock, start, end}`
//   readings  by Resource id: `[{at, to, kind}]` sorted by `at`, kind `track`, `probe` or `lost`
export const createTimeline = () => ({ held: new Map(), open: new Map(), reserved: new Map(), claims: new Map(), readings: new Map() });

function push(map, key, start, end) {
  if (!finite(start) || !finite(end) || !(end > start)) return;
  if (!map.has(key)) map.set(key, []);
  map.get(key).push([start, end]);
}

function foldReading(timeline, event, ts) {
  const resource = event.resource;
  if (typeof resource !== 'string' || resource === '' || typeof event.to !== 'string') return;
  const checked = msOf(event.checked_at);
  // A reading holds from when it was taken; one never claims to be taken after it was logged.
  const at = finite(checked) ? Math.min(checked, ts) : ts;
  const kind = event.reason === 'track' ? 'track' : event.reason === 'track-lost' ? 'lost' : 'probe';
  if (!timeline.readings.has(resource)) timeline.readings.set(resource, []);
  const list = timeline.readings.get(resource);
  list.push({ at, to: event.to, kind });
  if (list.length > 1 && list[list.length - 2].at > at) list.sort((a, b) => a.at - b.at);
}

function foldHold(timeline, event, ts) {
  const lock = event.lock;
  if (typeof lock !== 'string' || lock === '' || lock === EMULATOR_POOL) return;
  const open = timeline.open.get(lock);
  const expires = msOf(event.expires_at);
  if (event.event === 'acquire') {
    // A hold whose end was never logged ends where it was last known to run.
    if (open !== undefined) push(timeline.held, lock, open.start, Math.min(ts, open.expires));
    timeline.open.set(lock, { start: ts, expires: finite(expires) ? expires : Infinity });
  } else if (event.event === 'extend') {
    if (open !== undefined && finite(expires)) open.expires = expires;
  } else if (HOLD_ENDS.includes(event.event)) {
    const heldMs = Number.isFinite(event.held_ms) && event.held_ms >= 0 ? event.held_ms : null;
    if (open !== undefined) {
      push(timeline.held, lock, open.start, heldMs === null ? ts : Math.min(ts, open.start + heldMs));
      timeline.open.delete(lock);
    } else if (heldMs !== null) push(timeline.held, lock, ts - heldMs, ts);
  }
}

function foldReservation(timeline, event, ts) {
  const lock = event.lock;
  const runKey = event.run_key;
  if (typeof lock !== 'string' || lock === '' || typeof runKey !== 'string' || runKey === '') return;
  const key = `${lock}\0${runKey}`;
  const open = timeline.claims.get(key);
  const reserved = msOf(event.reserved_at);
  const expires = msOf(event.expires_at);
  if (event.event === 'claim') {
    if (open !== undefined) push(timeline.reserved, lock, open.start, Math.min(ts, open.end));
    timeline.claims.set(key, { lock, start: finite(reserved) ? reserved : ts, end: finite(expires) ? expires : Infinity });
  } else if (RESERVATION_ENDS.includes(event.event)) {
    if (open !== undefined) {
      push(timeline.reserved, lock, open.start, Math.min(ts, open.end));
      timeline.claims.delete(key);
    } else if (finite(reserved)) push(timeline.reserved, lock, reserved, finite(expires) ? Math.min(ts, expires) : ts);
  }
}

// Folds one Event Log event (a parsed object) into the timeline, in place. Events must arrive in log order per host. Anything that is not a
// Reachability reading, a Hold event or a Reservation event, or has no readable `ts`, changes nothing. The `emulator` gate lock is ignored.
export function foldEvent(timeline, event) {
  if (!isObject(event)) return;
  const ts = Date.parse(event.ts);
  if (!finite(ts)) return;
  if (event.event === 'reachability') foldReading(timeline, event, ts);
  else if (event.hold_kind === 'reservation') foldReservation(timeline, event, ts);
  else if (HOLD_KINDS.includes(event.hold_kind)) foldHold(timeline, event, ts);
}

// One timeline of several hosts' (each host folded on its own): the union of their maps. Locks and Resources are disjoint per host in practice; a
// key two hosts share has its intervals and readings joined.
export function mergeTimelines(timelines) {
  const out = createTimeline();
  for (const timeline of timelines) {
    for (const name of ['held', 'reserved']) {
      for (const [lock, intervals] of timeline[name]) out[name].set(lock, [...(out[name].get(lock) ?? []), ...intervals]);
    }
    for (const [lock, open] of timeline.open) if (!out.open.has(lock)) out.open.set(lock, open);
    for (const [key, claim] of timeline.claims) if (!out.claims.has(key)) out.claims.set(key, claim);
    for (const [resource, readings] of timeline.readings) {
      out.readings.set(resource, [...(out.readings.get(resource) ?? []), ...readings].sort((a, b) => a.at - b.at));
    }
  }
  return out;
}

// ---- the shares ----

// Whether a Resource record is shown for a window starting at `from`: live (neither retired nor seed-missing), or retired at or after `from`.
export const shownInWindow = (record, from) => retirement(record) === null || msOf(record.retired_at) >= from;

const zeros = () => Object.fromEntries(UTILISATION_CLASSES.map(name => [name, 0]));
const sharesFrom = (ms, span) => Object.fromEntries(UTILISATION_CLASSES.map(name => [name, span > 0 ? ms[name] / span : 0]));

// How one subject (a Resource, or one emulator slot) spent `[from, to)`: ms per class. `held` and `reserved` are interval lists (an open one
// ends at its expiry or, with none, at the window's end), `readings` the Resource's sorted Reachability readings (null for a slot: its free time
// is `idle`), `through` the host's `synced_through` in ms (`undefined`: no limit; `null`: never synced).
// The window is swept over its breakpoints (the intervals' ends, each reading, each probe's expiry and `through`) and each elementary interval is
// classified at its start, in this precedence: past `through` -> unknown; a Hold -> held; a Reservation -> idle_while_reserved; else the reading in
// force (reachable -> idle, unknown, none or expired -> unknown, any other state -> away).
function classify({ held, reserved, readings, through, from, to, maxAgeMs }) {
  const points = new Set([from, to]);
  const delta = new Map();
  const note = (at, by) => { delta.set(at, (delta.get(at) ?? 0) + by); };
  const cover = (intervals, kind) => {
    for (const [start, end] of intervals) {
      const a = Math.max(start, from);
      const b = Math.min(end, to);
      if (!(a < b)) continue;
      points.add(a);
      points.add(b);
      note(`${kind}${a}`, 1);
      note(`${kind}${b}`, -1);
    }
  };
  cover(held, 'h');
  cover(reserved, 'r');
  const cutoff = through === undefined ? Infinity : through === null ? -Infinity : through;
  if (cutoff > from && cutoff < to) points.add(cutoff);
  for (const reading of readings ?? []) {
    if (reading.at > from && reading.at < to) points.add(reading.at);
    if (reading.kind === 'probe') {
      const expiry = reading.at + maxAgeMs;
      if (expiry > from && expiry < to) points.add(expiry);
    }
  }
  const sorted = [...points].filter(finite).sort((x, y) => x - y);
  const ms = zeros();
  let holds = 0;
  let reservations = 0;
  let index = -1;
  for (let i = 0; i < sorted.length - 1; i += 1) {
    const at = sorted[i];
    holds += delta.get(`h${at}`) ?? 0;
    reservations += delta.get(`r${at}`) ?? 0;
    let name;
    if (at >= cutoff) name = 'unknown';
    else if (holds > 0) name = 'held';
    else if (reservations > 0) name = 'idle_while_reserved';
    else if (readings === null) name = 'idle';
    else {
      while (index + 1 < readings.length && readings[index + 1].at <= at) index += 1;
      const reading = index === -1 ? null : readings[index];
      if (reading === null || reading.kind === 'lost' || reading.to === 'unknown' || (reading.kind === 'probe' && at >= reading.at + maxAgeMs)) name = 'unknown';
      else name = reading.to === 'reachable' ? 'idle' : 'away';
    }
    ms[name] += sorted[i + 1] - at;
  }
  return ms;
}

// The intervals of a lock: its closed ones and its open Hold (until `expires`, or forever).
const holdsOf = (timeline, lock) => {
  const open = timeline.open.get(lock);
  return [...(timeline.held.get(lock) ?? []), ...(open === undefined ? [] : [[open.start, open.expires]])];
};
const reservationsOf = (timeline, lock) => {
  const claims = [...timeline.claims.values()].filter(claim => claim.lock === lock).map(claim => [claim.start, claim.end]);
  return [...(timeline.reserved.get(lock) ?? []), ...claims];
};

// Per-Resource and per-slot shares of `window` (`{from, to}` ms) over a folded timeline.
//   registry          the Registry (`{resources}`): the rows are its records shown for the window (`shownInWindow`), in its order
//   toResource        `lock -> Resource id` (`lockToResource(registry)`); a v1a lock with no `resource` field still attributes through it
//   options.maxAgeS   `registry.reachability_max_age_s` (default 60): how long a probe reading holds
//   options.syncedThrough   `{<host key>: ms | null}`: a host listed there is `unknown` from its value on (null: everywhere); an unlisted host has no limit
//   options.slots     the emulator slot locks the host's Pool has (`emulator-<n>`); slots seen in the timeline are added
// Returns `{window_ms, resources, slots}`: `resources[]` is `{id, name, kind, host, span_ms, ms, shares}`, and the emulator Pool's row is the sum of
// its slots' (`span_ms` is `window_ms` times the slot count); `slots[]` is `{resource, slot, span_ms, ms, shares}`. ms are whole numbers and
// shares are `ms / span_ms`, unrounded (0 for an empty span).
export function sharesOf(timeline, registry, toResource, window, { maxAgeS = DEFAULT_MAX_AGE_S, syncedThrough = {}, slots = [] } = {}) {
  const { from, to } = window;
  const windowMs = Math.max(0, to - from);
  const maxAgeMs = maxAgeS * 1000;
  const mapped = typeof toResource === 'function' ? toResource : lockToResource(registry);
  const records = (registry?.resources ?? []).filter(record => isObject(record) && shownInWindow(record, from));
  const locksOf = new Map();
  const slotLocks = new Set(slots.filter(lock => typeof lock === 'string' && SLOT.test(lock)));
  for (const lock of new Set([...timeline.held.keys(), ...timeline.open.keys(), ...timeline.reserved.keys(), ...[...timeline.claims.values()].map(claim => claim.lock)])) {
    if (SLOT.test(lock)) { slotLocks.add(lock); continue; }
    const id = mapped(lock);
    if (id === null || id === undefined) continue;
    if (!locksOf.has(id)) locksOf.set(id, []);
    locksOf.get(id).push(lock);
  }
  const throughOf = host => (typeof host === 'string' && Object.hasOwn(syncedThrough, host) ? syncedThrough[host] : undefined);
  const row = (ms, span) => ({ span_ms: span, ms, shares: sharesFrom(ms, span) });
  const pool = records.find(record => record.kind === 'emulator-pool') ?? null;
  const slotNames = [...slotLocks].sort((a, b) => Number(SLOT.exec(a)[1]) - Number(SLOT.exec(b)[1]));
  const slotRows = slotNames.map(lock => ({
    resource: pool?.id ?? EMULATOR_POOL, slot: lock,
    ...row(classify({ held: holdsOf(timeline, lock), reserved: reservationsOf(timeline, lock), readings: null, through: throughOf(pool?.host), from, to, maxAgeMs }), windowMs),
  }));
  const resources = records.map(record => {
    const head = { id: record.id, name: record.name, kind: record.kind, host: record.host };
    if (record.kind === 'emulator-pool') {
      const ms = zeros();
      for (const slotRow of slotRows) for (const name of UTILISATION_CLASSES) ms[name] += slotRow.ms[name];
      return { ...head, ...row(ms, windowMs * slotRows.length) };
    }
    const locks = locksOf.get(record.id) ?? [];
    const ms = classify({
      held: locks.flatMap(lock => holdsOf(timeline, lock)), reserved: locks.flatMap(lock => reservationsOf(timeline, lock)),
      readings: timeline.readings.get(record.id) ?? [], through: throughOf(record.host), from, to, maxAgeMs,
    });
    return { ...head, ...row(ms, windowMs) };
  });
  return { window_ms: windowMs, resources, slots: slotRows };
}

// The whole of it for a list of events: fold them in `ts` order (a stable sort; an event with no readable `ts` is dropped), then `sharesOf`.
// Pure: no fs, no clock, no network.
export function utilisation(events, registry, toResource, window, options = {}) {
  const timeline = createTimeline();
  const ordered = (events ?? []).filter(event => isObject(event) && finite(Date.parse(event.ts))).sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
  for (const event of ordered) foldEvent(timeline, event);
  return sharesOf(timeline, registry, toResource, window, options);
}
