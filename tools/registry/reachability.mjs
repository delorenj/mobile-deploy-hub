// Reachability (AD-35): the one enum a Resource's reading is told in, and the one mapper per transport that produces it. An
// agent that reads `unknown` knows nobody checked (or the transport could not say); it is never shown as `reachable`. Pure: no
// timers, no I/O beyond the `list` a caller injects to `readIpad`. A reading carries its age, computed on the reader's clock
// (`present`), and its staleness is derived when a view is built and never stored.
//
// The deploy path never imports this directory (tools/deploy-path.test.mjs).
import { inspectIpad } from '../ci/lib/devicectl.mjs';

export const REACHABILITY = Object.freeze({
  reachable: 'reachable',
  unauthorized: 'unauthorized',
  offline: 'offline',
  absent: 'absent',
  unknown: 'unknown',
});
const STATES = new Set(Object.values(REACHABILITY));
export const isReachability = value => STATES.has(value);

// ---- the mappers ----

// An adb phone: the state adb lists it in, or null when the server does not list it. `device` is reachable, `unauthorized` and
// `offline` say themselves, a phone the server does not list is absent, and anything else (`no adb server`, `adb did not
// answer`, `recovery`, `no`, undefined) is unknown: the transport could not say.
export function phoneReachability(observed) {
  if (observed === null) return REACHABILITY.absent;
  switch (observed) {
    case 'device': return REACHABILITY.reachable;
    case 'unauthorized': return REACHABILITY.unauthorized;
    case 'offline': return REACHABILITY.offline;
    default: return REACHABILITY.unknown;
  }
}

// The iPad, from `inspectIpad`: pass `{result}` (what it returned) or `{error}` (what it threw). The verdict never reads
// `tunnel`: the tunnel is the transport's own state, not the iPad's. A devicectl failure or timeout carries no `reason` and a
// record of the wrong model is `identity`; both are unknown.
export function ipadReachability({ result, error } = {}) {
  if (error !== undefined && error !== null) {
    switch (error.reason) {
      case 'not-listed': return REACHABILITY.absent;
      case 'unpaired':
      case 'developer-mode': return REACHABILITY.unauthorized;
      default: return REACHABILITY.unknown;
    }
  }
  if (!result || typeof result !== 'object') return REACHABILITY.unknown;
  if (result.proven !== true) return REACHABILITY.unknown;
  if (typeof result.boot_state === 'string' && result.boot_state !== 'booted') return REACHABILITY.offline;
  return REACHABILITY.reachable;
}

// Asks devicectl (`list()` returns its `list devices` document, or a promise of it, and may throw) and maps the iPad's record.
export async function readIpad({ list, udid, model }) {
  let document;
  try { document = await list(); } catch { return REACHABILITY.unknown; }
  try { return ipadReachability({ result: inspectIpad(document, { udid, model }) }); } catch (error) { return ipadReachability({ error }); }
}

// ---- readings ----

const isoOf = value => {
  const ms = typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(ms)) throw new TypeError(`stamp: ${JSON.stringify(value)} is not a time`);
  return new Date(ms).toISOString();
};

// What is stored of one reading: the state, when it was checked (`checked_at`), and the age it already had when this reader
// received it (`age_ms_at_receipt`, 0 for a reading this reader took itself) with the reader's own clock at receipt
// (`received_at`, ms). A state outside the enum is refused.
export function stamp(state, { checkedAt, receivedAt, ageMsAtReceipt = 0 }) {
  if (!isReachability(state)) throw new TypeError(`stamp: "${state}" is not a Reachability (${Object.values(REACHABILITY).join(', ')})`);
  if (!Number.isFinite(receivedAt)) throw new TypeError('stamp: receivedAt is the reader\'s clock in ms');
  if (!Number.isFinite(ageMsAtReceipt) || ageMsAtReceipt < 0) throw new TypeError('stamp: ageMsAtReceipt is 0 or more ms');
  return { state, checked_at: isoOf(checkedAt), age_ms_at_receipt: ageMsAtReceipt, received_at: receivedAt };
}

// A row with no reading: nobody checked.
export const MISSING = Object.freeze({ state: REACHABILITY.unknown, checked_at: null, age_ms: null, stale: true });

// A stored reading as a row shows it: `age_ms` is the age at receipt plus the time since receipt on THIS clock, so a sender's
// clock never decides it. `stale` is derived here: true for no reading, for a limit that is unavailable (no policy), and for an
// age over the limit (exactly the limit is still current). It is never written anywhere.
export function present(stored, { now, maxAgeS } = {}) {
  if (!stored || !isReachability(stored.state) || !Number.isFinite(stored.received_at) || !Number.isFinite(stored.age_ms_at_receipt)) return { ...MISSING };
  const age = Math.max(0, stored.age_ms_at_receipt + now - stored.received_at);
  const limited = Number.isSafeInteger(maxAgeS) && maxAgeS > 0;
  return { state: stored.state, checked_at: stored.checked_at ?? null, age_ms: age, stale: !limited || age > maxAgeS * 1000 };
}
