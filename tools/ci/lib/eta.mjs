// The one ETA (AD-18, Story 4.1): how long a Claimant waits on a Queued lock, as an honest range built from real past holds.
// Every Queued lock, every Claimant kind and every surface (the enqueue record, the wait line, status) calls this one function,
// so none computes its own. It is pure: it imports nothing, reads no clock, env or file, and never mutates its arguments. Its
// data comes in as `eta(queue, events, policy, now)` and the answer is `{lo_ms, hi_ms, low_data}`.
//
//   queue   {owner, view, file = null, deadline_at = null}: the lock's owner record (or null), `queueView(name)`'s entries, the
//           asker's ticket file name (null: the back of the line) and its wait deadline (ms or ISO; default: its view entry's).
//   events  Event Log lines. Only past holds (`release`, `reclaim`, `force-release` of a `job` or `lease` with a finite `held_ms`)
//           whose `ts` is inside [now - eta_window_days, now] count, whatever the caller passes. A `reclaim` that records
//           `last_alive_at` counts to that sign of life, so a killed job is not inflated.
//   policy  the policy object: `queue.eta_window_days`, `queue.eta_low_data_min_holds` and `queue.hold_allowance_min`.
//
// The bounds are the 25th and 75th percentiles of matching past holds, added along the Queue: the holder's expected remaining
// time (conditioned on how long it has already held), plus each blocking entry ahead (a Job Hold by repo and job, a Lease by the
// share of its stated `for_ms` that past agent Leases used; a blocking Reservation adds 0 to its grace left). An entry with fewer
// matching holds than `eta_low_data_min_holds` widens to its stated duration and sets `low_data`; a duration nobody stated is
// unknown, and the total upper bound is then the asker's own deadline (null without one).
const DAY_MS = 86_400_000;
const ENDS = new Set(['release', 'reclaim', 'force-release']);

// The p-quantile (0..1) of an ascending list by linear interpolation; null for an empty list. [1..5]: p25 2, p75 4.
export function percentile(sorted, p) {
  const n = sorted.length;
  if (n === 0) return null;
  const at = p * (n - 1);
  const below = Math.floor(at);
  const above = Math.min(n - 1, below + 1);
  return sorted[below] + (sorted[above] - sorted[below]) * (at - below);
}

const positiveWhole = (value, key) => {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`eta: ${key} must be a positive whole number`);
  return value;
};
const ms = value => (typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN);
const byValue = (a, b) => a - b;

// The past holds inside the window, as { kind: 'job' | 'lease', held, repo, job, claimant, for_ms }; held is in ms.
function pastHolds(events, from, now) {
  const out = [];
  for (const event of events) {
    if (!event || typeof event !== 'object' || !ENDS.has(event.event)) continue;
    if (event.hold_kind !== 'job' && event.hold_kind !== 'lease') continue;
    const ts = Date.parse(event.ts);
    if (!Number.isFinite(ts) || ts < from || ts > now) continue;
    if (typeof event.held_ms !== 'number' || !Number.isFinite(event.held_ms)) continue;
    let held = event.held_ms;
    if (event.event === 'reclaim') {
      const alive = Date.parse(event.last_alive_at);
      if (Number.isFinite(alive)) held = Math.max(0, held - (ts - alive));
    }
    const claimant = event.claimant && typeof event.claimant === 'object' ? event.claimant : {};
    out.push({ kind: event.hold_kind, held, repo: claimant.repo ?? null, job: claimant.job ?? null, claimant: claimant.kind ?? null, for_ms: event.for_ms });
  }
  return out;
}

// What an entry contributes: { lo, hi (null: unknown), low }. `samples` are its matching durations, `stated` its stated
// duration (null when none was stated), `min` the low-data threshold.
function bounds(samples, stated, min) {
  const sorted = [...samples].sort(byValue);
  const p25 = percentile(sorted, 0.25);
  const p75 = percentile(sorted, 0.75);
  if (sorted.length >= min) return { lo: p25, hi: p75, low: false };
  const hi = stated === null ? null : Math.max(stated, p75 ?? 0);
  return { lo: p25 ?? 0, hi, low: true };
}

export function eta(queue, events, policy, now) {
  const { owner = null, view = [], file = null } = queue ?? {};
  const settings = policy?.queue;
  const days = positiveWhole(settings?.eta_window_days, 'queue.eta_window_days');
  const min = positiveWhole(settings?.eta_low_data_min_holds, 'queue.eta_low_data_min_holds');
  if (!Number.isFinite(now)) throw new TypeError('eta: now must be a time in ms');
  const holds = pastHolds(events ?? [], now - days * DAY_MS, now);
  const jobHolds = holds.filter(hold => hold.kind === 'job');
  const leaseHolds = holds.filter(hold => hold.kind === 'lease' && hold.claimant === 'agent' && Number.isFinite(hold.for_ms) && hold.for_ms > 0);
  const shares = leaseHolds.map(hold => Math.min(1, hold.held / hold.for_ms));
  const allowance = job => {
    const minutes = settings.hold_allowance_min && Object.hasOwn(settings.hold_allowance_min, job) ? settings.hold_allowance_min[job] : null;
    return Number.isFinite(minutes) && minutes > 0 ? minutes * 60_000 : null;
  };
  const sameJob = (repo, job) => jobHolds.filter(hold => hold.repo === (repo ?? null) && hold.job === (job ?? null));
  const parts = [];

  // The holder: only the past holds that lasted longer than it already has can still be its answer.
  if (owner && typeof owner === 'object') {
    const started = Date.parse(owner.started_at);
    const elapsed = Number.isFinite(started) ? Math.max(0, now - started) : 0;
    if (owner.kind === 'lease') {
      const expires = Date.parse(owner.expires_at);
      const forMs = expires - started;
      const left = Number.isFinite(expires) ? Math.max(0, expires - now) : null;
      if (Number.isFinite(forMs) && forMs > 0) {
        // Its end is start + share x for_ms, never later than expires_at; what is left is that, less now.
        const remaining = shares.filter(share => elapsed === 0 || share * forMs > elapsed).map(share => Math.max(0, Math.min(started + share * forMs, expires) - now));
        parts.push(bounds(remaining, left, min));
      } else {
        parts.push({ lo: 0, hi: left, low: true });
      }
    } else {
      const alive = sameJob(owner.repo, owner.job).filter(hold => elapsed === 0 || hold.held > elapsed).map(hold => hold.held - elapsed);
      const total = typeof owner.job === 'string' ? allowance(owner.job) : null;
      // A holder past its whole allowance has no stated remaining time: unknown, not 0 while it still holds the lock.
      parts.push(bounds(alive, total === null || total - elapsed <= 0 ? null : total - elapsed, min));
    }
  }

  // The blocking entries ahead of the asker (all of them for the back of the line).
  // The latest request per lease id (events arrive in ascending order): a reused id takes its newest for_ms.
  const requests = new Map();
  for (const event of events ?? []) {
    if (event?.event === 'request' && typeof event.lease_id === 'string' && Number.isFinite(event.for_ms) && event.for_ms > 0) requests.set(event.lease_id, event.for_ms);
  }
  let own = null;
  for (const entry of view) {
    if (entry?.blocking !== true || (file !== null && !(entry.file < file))) continue;
    if (entry.kind === 'reservation') {
      const ends = Date.parse(entry.grace?.ends_at);
      const left = entry.grace?.state === 'running' && Number.isFinite(ends) ? Math.max(0, ends - now) : Number.isFinite(entry.grace_ms) ? Math.max(0, entry.grace_ms) : 0;
      parts.push({ lo: 0, hi: left, low: false });
    } else if (entry.kind === 'job' || entry.kind === 'hub-job') {
      parts.push(bounds(sameJob(entry.repo, entry.job).map(hold => hold.held), typeof entry.job === 'string' ? allowance(entry.job) : null, min));
    } else if (entry.kind === 'lease') {
      const forMs = requests.get(entry.lease_id) ?? null;
      if (forMs === null) parts.push({ lo: 0, hi: null, low: true });
      else parts.push(bounds(shares.map(share => share * forMs), forMs, min));
    } else {
      parts.push({ lo: 0, hi: null, low: true });
    }
  }
  if (file !== null) own = view.find(entry => entry?.file === file) ?? null;

  let lo = 0;
  let hi = 0;
  let unknown = false;
  let low = false;
  for (const part of parts) {
    lo += part.lo;
    if (part.hi === null) unknown = true; else hi += part.hi;
    if (part.low) low = true;
  }
  if (unknown) {
    const deadline = ms(queue?.deadline_at ?? own?.deadline_at ?? null);
    hi = Number.isFinite(deadline) ? Math.max(0, deadline - now) : null;
  }
  lo = Math.round(lo);
  if (hi !== null) hi = Math.max(lo, Math.round(hi));
  return { lo_ms: lo, hi_ms: hi, low_data: low };
}
