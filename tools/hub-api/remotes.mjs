// What the Hub API holds of the spoke hosts that push to it (Story 9.5, AD-49, AD-41): one in-memory record per host key, written by
// `POST /agent/push` and read by `GET /status`. Nothing here is on disk, on a timer or asks a host anything: a view is whatever the host
// last pushed, and `stale` is derived from the push's age on THIS service's clock when `/status` is built (the pushing host's clock never
// decides it). The store is written per host key, so a second spoke host needs no new code.
//
// `checkPushBody(body, {own})` is the strict body check (HUB_USAGE 400 with one reason). `createRemotes()` returns `{apply, views}`:
//   apply(push, {at})              applies a checked push once per `(boot, seq)`: a push of the same boot whose `seq` is not above the applied one
//                                  changes nothing (`{applied: false}`). A non-null `status` replaces the host's view and its receipt time becomes
//                                  `at`; a null one keeps the last view and its receipt time.
//   views({now, maxAgeS, marks})   `{hosts: {<host>: <view>}, stale: {<host>: {since, unreachable}}}`: every pushed view, embedded unchanged, and for a host
//                                  whose view is older than `maxAgeS` seconds at `now` (exactly the limit is still current) or that is marked unreachable
//                                  (`marks`: a Map of host key to `{since, reason}` in ms, from tools/hub-api/peers.mjs) `{since: <ISO receipt time of the
//                                  view, null when it has none>, unreachable: null | {since: <ISO>, reason}}`. `stale` is derived on every call and never stored.
import { exitCodeOf } from '../device/claims.mjs';
import { HOST_KEYS } from '../hub-client.mjs';
import { isReachability } from '../registry/reachability.mjs';

export const PUSH_FORMAT = 1;
export const PUSH_KEYS = Object.freeze(['format', 'host', 'host_id', 'boot', 'seq', 'sent_at', 'status', 'readings', 'events']);
export const PUSH_REASONS = Object.freeze(['bad-body', 'bad-format', 'bad-host', 'bad-host-id', 'bad-boot', 'bad-seq', 'bad-sent-at', 'bad-status', 'bad-readings', 'bad-events']);

const bad = (reason, message) => Object.assign(new Error(message), { status: 400, code: 'HUB_USAGE', exit: exitCodeOf({ code: 'HUB_USAGE' }), reason });
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isText = value => typeof value === 'string' && value.trim() !== '';
const orNull = test => value => value === null || test(value);
const isNumber = value => typeof value === 'number' && Number.isFinite(value);

// One pushed reading: a Resource id and a reading in its served form (`serve` in tools/registry/reachability.mjs). The fields a reading
// nobody could take (state `unknown`) has are `null`, so each of them is a number or text, or null.
function checkReading(reading) {
  return isObject(reading)
    && isText(reading.resource)
    && isReachability(reading.state)
    && orNull(isText)(reading.checked_at)
    && orNull(value => isNumber(value) && value >= 0)(reading.age_ms_at_receipt)
    && orNull(isNumber)(reading.received_at)
    && orNull(isText)(reading.source);
}

// Checks the body of a push into the same fields, or throws HUB_USAGE 400 with a `reason` (checked in this order, before anything is stored):
// bad-body (not an object, a key outside the list or a missing one), bad-format (not 1), bad-host (not a host key, or this service's own: `own` is
// its key), bad-host-id (text or null), bad-boot (12 lowercase hex characters), bad-seq (a whole number of 1 or more), bad-sent-at (an ISO
// time), bad-status (an object or null), bad-readings (an array of readings or null), bad-events (`null`: Epic 10 fills it).
export function checkPushBody(body, { own } = {}) {
  if (!isObject(body)) throw bad('bad-body', 'the body must be a JSON object');
  for (const key of Object.keys(body)) if (!PUSH_KEYS.includes(key)) throw bad('bad-body', `the body has no key "${key}" (${PUSH_KEYS.join(', ')})`);
  for (const key of PUSH_KEYS) if (!Object.hasOwn(body, key)) throw bad('bad-body', `the body needs "${key}"`);
  if (body.format !== PUSH_FORMAT) throw bad('bad-format', `format must be ${PUSH_FORMAT}`);
  if (typeof body.host !== 'string' || !HOST_KEYS.includes(body.host)) throw bad('bad-host', `host must be a host key (${HOST_KEYS.join(', ')})`);
  if (body.host === own) throw bad('bad-host', `host must be another host than this service's own ("${own}"): a host does not push to itself`);
  if (body.host_id !== null && !isText(body.host_id)) throw bad('bad-host-id', 'host_id must be a non-empty string or null');
  if (typeof body.boot !== 'string' || !/^[0-9a-f]{12}$/.test(body.boot)) throw bad('bad-boot', 'boot must be 12 lowercase hex characters');
  if (!Number.isSafeInteger(body.seq) || body.seq < 1) throw bad('bad-seq', 'seq must be a whole number of 1 or more');
  if (typeof body.sent_at !== 'string' || !/^\d{4}-\d\d-\d\dT/.test(body.sent_at) || !Number.isFinite(Date.parse(body.sent_at))) throw bad('bad-sent-at', 'sent_at must be an ISO time');
  if (body.status !== null && !isObject(body.status)) throw bad('bad-status', 'status must be a host view object or null');
  if (body.readings !== null && !(Array.isArray(body.readings) && body.readings.every(checkReading))) {
    throw bad('bad-readings', 'readings must be null or a list of {resource, state, checked_at, age_ms_at_receipt, received_at, source}, each state a Reachability');
  }
  if (body.events !== null) throw bad('bad-events', 'events must be null (the Event Log replica arrives with Epic 10)');
  return {
    format: body.format, host: body.host, host_id: body.host_id, boot: body.boot, seq: body.seq, sent_at: body.sent_at,
    status: body.status, readings: body.readings, events: null,
  };
}

export function createRemotes() {
  const hosts = new Map();   // host key -> {boot, seq, host_id, view, received_at}

  return {
    apply(push, { at } = {}) {
      const held = hosts.get(push.host);
      if (held !== undefined && held.boot === push.boot && push.seq <= held.seq) return { applied: false };
      const fresh = push.status !== null;
      hosts.set(push.host, {
        boot: push.boot,
        seq: push.seq,
        host_id: push.host_id,
        view: fresh ? push.status : held?.view ?? null,
        received_at: fresh ? at : held?.received_at ?? null,
      });
      return { applied: true };
    },

    views({ now, maxAgeS, marks } = {}) {
      const shown = {};
      const stale = {};
      const limited = Number.isSafeInteger(maxAgeS) && maxAgeS > 0;
      const unreachable = host => {
        const mark = marks?.get?.(host);
        return mark === undefined ? null : { since: new Date(mark.since).toISOString(), reason: mark.reason };
      };
      for (const [host, held] of hosts) {
        const down = unreachable(host);
        if (held.view === null) {
          if (down !== null) stale[host] = { since: null, unreachable: down };
          continue;
        }
        shown[host] = held.view;
        // No limit to judge by is never shown as current (the readings' rule).
        if (down !== null || !limited || now - held.received_at > maxAgeS * 1000) stale[host] = { since: new Date(held.received_at).toISOString(), unreachable: down };
      }
      // A marked host that never pushed a view has the key too, with no view to show.
      for (const host of marks?.keys?.() ?? []) if (!hosts.has(host)) stale[host] = { since: null, unreachable: unreachable(host) };
      return { hosts: shown, stale };
    },
  };
}
