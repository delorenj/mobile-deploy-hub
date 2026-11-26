// What the Hub API knows of whether a spoke host can be reached (Story 9.6, AD-35): one in-memory mark per peer host key, set when a forwarded
// call to that host fails at the ssh leg and cleared by contact (a push, or a call that gets any answer). Nothing here is on disk, on a timer or asks
// a host anything: the 5x window is judged by `gate` when a request arrives, on the caller's clock. A restart forgets the marks (the next call is
// tried, bounded by `hub-client`'s connect timeout). Keyed by host key, so a second spoke host needs no new code.
//
// `createPeers({env, now, hostId, policy, log, note})` returns:
//   gate(host, {at})               throws HUB_DEVICE_AWAY (503, exit 75, `host-unreachable`) while `host` is marked and `at - failed_at` is under
//                                  5 x `registry.reachability_max_age_s`; at exactly that age the call is tried. Nothing else.
//   failed(host, {at, reason})     the ssh leg failed: marks the host (one `host-reachability` event on the first failure) or, already marked, moves
//                                  `failed_at` and `reason` (no event). True when the mark appeared.
//   reached(host, {at, reason})    contact (`push` or `call`): clears the mark with one event. True when a mark was cleared.
//   mark(host) / marks()           `{since, failed_at, reason}` (ms) of one host or null, and every mark as a Map.
//   offlineReading(host)           the stored `offline` reading a marked host's Resources read as, stamped at `failed_at`; null when not marked.
// An event write that fails or throws is one `HUB_API_REACHABILITY_FAILED <msg>` line on `log` and never changes a state or an answer.
//
// `failureReason(error)`, `isUnreached(error)` and `isContact(error)` classify what a forward threw; `offlineView(view, reading, {now, maxAgeS})` is
// the one overlay rule for a pushed host view. The deploy path never imports this directory (tools/deploy-path.test.mjs).
import { noteReachability } from '../ci/lib/lock.mjs';
import { present, stamp } from '../registry/reachability.mjs';

// Failures are retried by a request only after this many reachability limits (AD-35).
export const RETRY_AFTER_LIMITS = 5;

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const oneLine = value => String(value?.message ?? value).replace(/\s+/g, ' ').trim();
const lineLog = log => (typeof log === 'function' ? log : typeof log?.err === 'function' ? log.err : () => {});

// One word for why the ssh leg failed, from the raw cause text `hub-client` keeps in `detail`.
export function failureReason(error) {
  const text = String(error?.detail ?? '');
  if (/refused/i.test(text)) return 'refused';
  if (/timed out|timeout|etimedout|no answer within/i.test(text)) return 'timeout';
  return 'ssh-error';
}

// A forward whose ssh leg or transport failed: HUB_DEVICE_AWAY that the far side did not say itself.
export const isUnreached = error => error?.code === 'HUB_DEVICE_AWAY' && error.api !== true;

// A forward that got an answer from the host, whatever the answer: the far side's own problem (`api: true`) or an answer that is no problem.
export const isContact = error => error?.api === true || error?.code === 'HUB_API_UNKNOWN';

export function createPeers({ env = process.env, now = Date.now, hostId, policy, log, note = noteReachability } = {}) {
  const say = lineLog(log);
  const states = new Map();   // host key -> 'reachable' once contacted
  const held = new Map();     // host key -> {since, failed_at, reason}, while unreachable

  const windowMs = () => {
    const limit = policy?.registry?.reachability_max_age_s;
    return Number.isSafeInteger(limit) && limit > 0 ? RETRY_AFTER_LIMITS * limit * 1000 : 0;
  };

  function event(fields, at) {
    const failed = error => { try { say(`HUB_API_REACHABILITY_FAILED ${oneLine(error)}`); } catch { /* the log is best effort */ } };
    try {
      note({ ...fields, checked_at: at }, { env, now, hostId, log: line => failed(line) });
    } catch (error) { failed(error); }
  }

  return {
    gate(host, { at } = {}) {
      const mark = held.get(host);
      if (mark === undefined) return;
      const until = mark.failed_at + windowMs();
      if (at >= until) return;
      const seconds = policy?.api?.peer_connect_timeout_s;
      throw Object.assign(new Error(
        `the ${host} host is unreachable since ${new Date(mark.since).toISOString()} (${mark.reason}); a new attempt is allowed at ${new Date(until).toISOString()} or when it pushes (connect timeout ${seconds} s)`,
      ), { code: 'HUB_DEVICE_AWAY', status: 503, exit: 75, reason: 'host-unreachable', api: false, host });
    },

    failed(host, { at, reason } = {}) {
      const mark = held.get(host);
      if (mark !== undefined) {
        mark.failed_at = at;
        mark.reason = reason;
        return false;
      }
      const from = states.get(host) ?? null;
      held.set(host, { since: at, failed_at: at, reason });
      states.set(host, 'unreachable');
      event({ host, from, to: 'unreachable', reason }, at);
      return true;
    },

    reached(host, { at, reason } = {}) {
      const marked = held.has(host);
      held.delete(host);
      states.set(host, 'reachable');
      if (marked) event({ host, from: 'unreachable', to: 'reachable', reason }, at);
      return marked;
    },

    mark: host => (held.has(host) ? { ...held.get(host) } : null),
    marks: () => new Map([...held].map(([host, mark]) => [host, { ...mark }])),
    offlineReading(host) {
      const mark = held.get(host);
      return mark === undefined ? null : stamp('offline', { checkedAt: mark.failed_at, receivedAt: mark.failed_at });
    },
  };
}

// A pushed host view while its host is unreachable: a copy in which every row of every list that carries a non-null `reachability` reads `reading`
// (an `offline` stored reading) as a status row shows it. The pushed view is never mutated; the same view with the mark gone shows what the host said.
export function offlineView(view, reading, { now, maxAgeS } = {}) {
  if (!isObject(view)) return view;
  const row = () => present(reading, { now, maxAgeS });
  const out = { ...view };
  for (const [key, value] of Object.entries(view)) {
    if (!Array.isArray(value)) continue;
    out[key] = value.map(entry => (isObject(entry) && isObject(entry.reachability) ? { ...entry, reachability: row() } : entry));
  }
  return out;
}
