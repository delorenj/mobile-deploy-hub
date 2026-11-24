---
title: 'Story 4.1: An honest ETA range from history'
type: 'feature'
created: '2026-11-24'
status: 'done'
review_loop_iteration: 0
baseline_revision: '55c40a71cc1ceb77af6678e68ca873d75063972f'
followup_review_recommended: false
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-4-context.md'
warnings: ['oversized']
deferred: []
---

<intent-contract>

## Intent

**Problem:** A waiter on a Queued lock (a Lease, a deploy job, the catch-up) gets no idea how long it will wait, and nothing records what it could have been told. So nobody can decide whether to wait or go elsewhere, and ETA accuracy (SM-4) cannot be measured (FR-15).

**Approach:** One level up (belsky-doctrine): one pure `eta()` in a new `tools/ci/lib/eta.mjs` serves every Queued lock, every Claimant kind and every surface. This story uses it at enqueue. The wait line (4.2) and status (4.3) reuse it unchanged. It returns `{lo_ms, hi_ms, low_data}` from the Event Log's past holds inside a policy window. The bounds are the 25th and 75th percentiles, summed along the Queue: the current holder's expected remaining time, plus each blocking entry ahead. Every enqueue (`acquireLease` and the Queued `withLock` path) stamps that ETA into its ticket's `eta` field and into its `request` event. The policy `queue` block gains `eta_window_days` (30) and `eta_low_data_min_holds` (20).

## Boundaries & Constraints

**Always:**
- `eta.mjs` imports nothing, reads no clock, env or file. Its data comes in as arguments: `eta(queue, events, policy, now)`. `queue` is the Queue snapshot `{owner, view, file = null, deadline_at = null}`:
  - `owner` is the lock's owner record or null;
  - `view` is `queueView(name)`'s entries;
  - `file` is the asker's ticket file name (null means the back of the line);
  - `deadline_at` is the asker's wait deadline, defaulting to its view entry's.
- A past hold is a `release`, `reclaim` or `force-release` event with `hold_kind` `job` or `lease` and a finite `held_ms`, whose `ts` is in `[now − eta_window_days, now]`. Nothing outside the window counts, whatever the caller passes. A `reclaim` with `last_alive_at` counts `held_ms − (ts − last_alive_at)`, floored at 0, so a killed job is not inflated.
- Job matching: a Job Hold (a `job` or `hub-job` ticket, or a non-Lease owner) matches past `job` holds with equal `claimant.repo` and `claimant.job`, where a missing value equals null.
- Lease matching: a Lease matches past `lease` holds of the same Claimant kind (`agent`; a Lease's kind is derived as `eventOf` does it) with `for_ms > 0`. Each sample is the share `min(1, held/for_ms)`, and the bound is that share × `for_ms`. A waiting Lease's `for_ms` comes from its own `request` event (same `lease_id`) in `events`. The holder's comes from `expires_at − started_at`, and its expected end is never later than `expires_at`.
- Only `blocking` view entries before `file` add time. A blocking Reservation (first in line, grace not over) adds `[0, grace left]`: `grace.ends_at − now` while running, `grace_ms` while pending. It is never low-data.
- Low data: an entry with fewer matching samples than `eta_low_data_min_holds` contributes:
  - `lo` = the sparse 25th percentile, or 0 when there are none;
  - `hi` = its stated duration (`for_ms`; the holder's `expires_at − now`; a job's `hold_allowance_min[job]`, less elapsed time for the holder), raised to the sparse 75th percentile when that is larger, or *unknown* when no stated duration exists.
  - Any low entry sets `low_data: true`. If any `hi` is unknown, the total `hi_ms` is the asker's `deadline_at − now` (floored at 0), else null.
- Results are whole ms, `0 ≤ lo_ms ≤ hi_ms` (when `hi_ms` is not null). A free lock with nothing blocking ahead gives `{lo_ms: 0, hi_ms: 0, low_data: false}`.
- The ETA never fails or delays an enqueue. Any error in computing it records `eta: null`. History is read once per enqueue, window only (`readEvents({since, until})`), and never per poll.
- Policy keys are strict positive whole numbers, read through `loadPolicy` unless a test injects a policy. Only `lock.mjs` appends events. Node 24 ESM, no new dependency, hermetic tests.

**Never:**
- No wait-line change (4.2), and no `hub-device status` change (4.3).
- No new ticket key: `eta` already exists. No Capacity Estimate math.
- No ETA for tries or Pool-level requests, which have no ticket.
- No `eta` key on any event other than `request`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Empty history, free lock | no owner, no blockers | `{0, 0, false}` | — |
| Empty history, job holds | owner android job, elapsed 3 s, deadline in 60 s | `lo 0`, `hi` = 15 min − 3 s, `low_data` true | — |
| Rich history, job holder | ≥20 matching holds, elapsed 0 | lo/hi = p25/p75 of `held_ms` | — |
| Holder past its median | elapsed beyond some samples | percentiles of samples longer than elapsed, minus elapsed | falls back to low-data if survivors < threshold |
| Lease holder, rich | ≥20 agent shares | `min(start + p·for_ms, expires_at) − now`, floored 0 | — |
| Waiting Lease, no request event | `for_ms` unknown | entry low, `hi` unknown → asker's deadline | `hi_ms` null if no deadline |
| Blocking Reservation | head in grace | adds `[0, grace left]` | — |
| Window | holds older than the window, or `ts > now` | ignored | — |
| Enqueue | `acquireLease` / Queued `withLock` waits | ticket `eta` and `request.eta` are the same object | ETA error → `eta: null`, enqueue proceeds |

</intent-contract>

## Code Map

- `tools/ci/lib/eta.mjs` -- NEW pure module: `eta()`, plus an exported `percentile(sorted, p)` (linear interpolation, `[1..5]` → p25 2, p75 4).
- `tools/ci/lib/lock.mjs:20-23` -- imports. Add `eta` from `./eta.mjs` (`readEvents` and `loadPolicy` are already imported).
- `tools/ci/lib/lock.mjs:106-121` `eventOf` -- event body. Its claimant-kind rule (lease → `agent`; `hub-job`; else `deploy`) is what `eta.mjs` mirrors. Request events get `eta` through `fields`.
- `tools/ci/lib/lock.mjs:123-129` `heldMs` -- `held_ms` semantics, ending no later than `expires_at`.
- `tools/ci/lib/lock.mjs:146-182` `retire` -- writes `release`/`reclaim` with `held_ms` and `last_alive_at`.
- `tools/ci/lib/lock.mjs:449-476` `buildTicket` -- already takes `eta` (default null) and writes it.
- `tools/ci/lib/lock.mjs:772-788` `queueView`, `blockersAhead`/`inOrder` -- the snapshot passed to `eta()`. Use the same ordering (`file` comparison) for "ahead".
- `tools/ci/lib/lock.mjs:800-809` `writeTicket` -- split the file-name minting (`<ms15>-<counter6>-<pid8>.json`) out, so the name is known before the body (the ETA needs the asker's place).
- `tools/ci/lib/lock.mjs:874-901` `queuedLock` -- the job/hub-job enqueue. Its sort key is `reserved ? min(requested, reserved_ms) : requested`. `deadline` is known before the ticket. `policy ?? loadPolicy().policy` is already used here.
- `tools/ci/lib/lock.mjs:1057-1072` `acquireLease` -- the Lease enqueue (ticket at 1065, `request` event at 1072). `policy` param exists (null → `loadPolicy`).
- `tools/ci/lib/events.mjs:116` `readEvents({env, since, until, log})` -- the window read. Pass a silent `log`.
- `tools/ci/lib/policy.mjs:290-300` `queueBlock` -- add the two keys to `exact` and `positive`. Update the comment block above it (Story 4.1).
- `tools/ci/policy.json` (`queue`) -- add `"eta_window_days": 30, "eta_low_data_min_holds": 20`.
- `tools/ci/policy.test.mjs:158-215` -- the exact queue-block assertion, bad-value table and override copy. Extend for the two keys.
- `tools/device/lease.test.mjs:486,586` -- exact `request` event bodies. They gain `eta` (the intended change). Other tests that deepEqual whole tickets or request events may need `eta` too; find them by running the suite.
- `README.md:84-94` -- the "queue block" bullets. Add one for the ETA keys.

## Tasks & Acceptance

**Execution:**
- [ ] `tools/ci/lib/eta.mjs` -- implement `eta()` and `percentile()` per Boundaries, with a header comment stating AD-18 and the rules -- the single ETA every surface uses.
- [ ] `tools/ci/policy.json`, `tools/ci/lib/policy.mjs` -- add and validate `eta_window_days` and `eta_low_data_min_holds` -- AD-11 tuning lives in policy.
- [ ] `tools/ci/lib/lock.mjs` -- add an `enqueueEta(name, {file, deadline, env, now, policy, host, hostId, processStart})` helper that never throws. It reads the owner, an observer `queueView` (no prune), the window's events, then `eta()`, else null. Mint the ticket name first. Pass the ETA into `buildTicket` and the `request` event in both `queuedLock` and `acquireLease` -- recording the enqueue ETA (SM-4).
- [ ] `tools/ci/eta.test.mjs` -- NEW. A table-driven fixture suite over empty, sparse and rich history, plus window filtering, job matching (repo+job, null-safe), Lease share and clamp, conditioning a holder that is past its median, the reclaim `last_alive_at` correction, a blocking Reservation, non-blocking entries ignored, unknown stated → deadline / null, and purity (the same inputs give the same output, and the inputs are not mutated).
- [ ] `tools/ci/eta.test.mjs` (or the closest existing lock test file) -- integration: a waiting `acquireLease` and a waiting Queued `withLock` each write a ticket whose `eta` deep-equals its `request` event's `eta`. A throwing ETA input (a broken policy injected) still enqueues, with `eta: null`.
- [ ] `tools/ci/policy.test.mjs`, `tools/device/lease.test.mjs`, other tests the suite flags -- update for the new keys and the request `eta`, naming it the intended change.
- [ ] `README.md` -- document the two keys and what the enqueue ETA records.

**Acceptance Criteria:**
- Given a `request` event or ticket written by a waiting `acquireLease` or Queued `withLock`, when it is read back, then both carry the same `eta` `{lo_ms, hi_ms, low_data}` computed at enqueue.
- Given `parsePolicy` on a policy whose `queue` block lacks either new key, or holds a zero, fractional or text value, when it is parsed, then it throws `policy.json: …`. The shipped policy loads with `eta_window_days: 30, eta_low_data_min_holds: 20`.
- Given `mise run check`, when it runs, then actionlint and the full suite pass.

## Spec Change Log

## Review Triage Log

### 2026-11-24 — Review pass
- verdicts: 30 findings — high 0, medium 5, low 17, false 8, maybe-false 0
- findings:
  - `[low]` `[reject]` Blind: one sparse sample yields a point range (e.g. 40–40), contrary to "no single-point estimate from <20 samples". Evidence: this happens only when the one sample is above the stated duration or the deadline, and `low_data` is set. The fix would change the spec's low-data `lo` rule, which lives in the intent-contract.
  - `[medium]` `[patch]` Blind: `enqueueEta` swallows errors silently, so SM-4 data would vanish with no trace. Fixed: the error now logs one `HUB_ETA_FAILED <name> <msg>` line through the caller's `log` (stderr for `hub-device`), and the broken-policy test asserts it.
  - `[low]` `[reject]` Blind: a negative `held_ms`, or `last_alive_at` later than `ts`, can make `lo < 0`. Evidence: the only writers floor `held_ms` at 0 (`heldMs`, Reservation retire). `last_alive_at` is the mtime of the alive file, set on the same host before the reclaim. Unlikely, and the fix would add a guard.
  - `[low]` `[reject]` Blind: `force-release` and failed holds count like normal holds. Evidence: a failed hold still occupied the device, so it is a true hold. A rare long force-release barely moves an IQR.
  - `[false]` `[reject]` Blind: raw job names miss `hold_allowance_min`. Evidence: the jobs that wait in the Queue are exactly `plan`, `android` and `ios` (the `queueJobs` policy test refuses `deliver-android`). `deadline.mjs:70-71` does the same raw lookup.
  - `[false]` `[reject]` Blind: a Lease extension makes the share base inconsistent. Evidence: `eventOf` derives `for_ms` from the final record's `expires_at − started_at`, the same base the holder branch uses.
  - `[false]` `[reject]` Blind: the integration tests rely on `settle(60)` and are flaky. Evidence: `acquireLease` and `queuedLock` write the ticket and the `request` event synchronously, before their first `await`.
  - `[low]` `[patch]` Blind: missing integration coverage (real history, more paths). Grouped with the verification-gap findings below. Fixed by the real-history and two-waiter tests.
  - `[low]` `[patch]` Blind: the README claimed the wait line and status already reuse `eta()`. Fixed: it now says "will reuse (Stories 4.2, 4.3)".
  - `[low]` `[patch]` Blind: the policy test title is stale, a comment line is long, and the window has no upper bound. Fixed: the title now reads "every value a positive whole number". The long line is cosmetic, matching its neighbours. An upper bound is a hub-release value judgement, so it was rejected.
  - `[low]` `[reject]` Blind: the history read at enqueue has no cost bound, and owner and view are read separately. Evidence: the read is the policy window of small JSONL files once per enqueue, and the ETA is an estimate.
  - `[medium]` `[patch]` Edge: the silent catch in `enqueueEta`. Same root cause as the Blind finding above. Fixed with the `HUB_ETA_FAILED` line.
  - `[low]` `[reject]` Edge: owner, view and events are read at different instants. Evidence: the ETA is an estimate, and a race costs at most one entry for one recorded ETA.
  - `[low]` `[reject]` Edge: a concurrent earlier-sorting enqueue written after the snapshot is missed. Evidence: this is inherent to computing before the ticket lands (Design Notes) and rare.
  - `[low]` `[reject]` Edge: a waiting Lease's ticket can be visible before its `request` event. Evidence: the window is microseconds, the result degrades to low-data plus the deadline, and the fix would need a new ticket key, which is forbidden.
  - `[low]` `[patch]` Edge: a reused `lease_id` took the oldest `request`'s `for_ms`. Fixed: the latest request per id now wins (events ascend), with a table test.
  - `[medium]` `[patch]` Edge: a job holder past its allowance and past every sample reported 0–0 while it still held the lock. Fixed: a spent allowance is now unknown, so `hi` falls to the asker's deadline (null without one). Tests were updated and added.
  - `[low]` `[reject]` Edge: a lock dir with an unreadable `owner.json` reads as free. Evidence: this is only a take in progress (mkdir then write), which is microseconds. Unlikely, and the fix would add a guard.
  - `[low]` `[reject]` Edge: an unknown `hi` replaces a larger known sum with the deadline. Evidence: the code follows the spec's "total `hi` is the asker's deadline". The case is rare, and `hi ≥ lo` still holds.
  - `[low]` `[reject]` Edge: an uncontended enqueue still reads history. Evidence: the cost is negligible, and a fast path would add a branch.
  - `[false]` `[reject]` Edge: remote or unknown kinds force `hi` to the deadline. Evidence: v1 writes no remote tickets (`buildTicket` refuses them), and the branch is the spec's intended honest fallback.
  - `[false]` `[reject]` Edge: job names outside `plan`/`android`/`ios` lose their allowance. Same refutation as the Blind job-name finding.
  - `[low]` `[patch]` Edge: the README said `hi_ms` "is the waiter's deadline_at". Fixed: it now says "the time left until the waiter's own `deadline_at`".
  - `[medium]` `[patch]` Verification gap: no integration test ran `enqueueEta`'s `readEvents` path with real history. Fixed: a test seeds 20 in-window and 6 out-of-window holds through `appendEvent`, and asserts that the ticket and `request` ETA are equal, not low-data, and equal to the in-window p25/p75.
  - `[medium]` `[patch]` Verification gap: the asker's place was not verified end to end. Fixed: a two-waiter test shows C's ETA adds B's `for_ms` from B's real `request` event, and B's ETA excludes C.
  - `[low]` `[patch]` Verification gap (other): no test showed that the `request` event `eta()` reads is the one `acquireLease` writes. Fixed: covered by the two-waiter test.
  - `[low]` `[patch]` Verification gap (other): the remote/unknown-kind branch was untested. Fixed: a table row was added (deadline and null cases).
  - `[false]` `[reject]` Intent alignment: the first argument is a snapshot object, not the bare `queueView` array. Evidence: the holder and the asker's place cannot come from the view alone. The snapshot carries the view verbatim.
  - `[false]` `[reject]` Intent alignment: "median share" is used as p25/p75 bounds, not a single median. Evidence: FR-15 and the story both make every bound a 25th or 75th percentile. The median is the point inside that range.
  - `[false]` `[reject]` Intent alignment: holder conditioning, the `last_alive_at` correction and the Reservation term go beyond the criteria's text. Evidence: these are spec design choices that serve "honest", and they contradict no criterion.

### 2026-11-24 — Review pass (follow-up)
- verdicts: 32 findings — high 0, medium 1, low 24, false 7, maybe-false 0
- findings:
  - `[low]` `[reject]` Blind: a blocking Reservation adds only `[0, grace left]`, so it leaves out the job hold the Reservation stands for. Evidence: the `[0, grace left]` term is set in the intent-contract. Once the run enqueues, its job ticket takes the Reservation's place and counts its allowance. Changing the term would mean editing the spec.
  - `[low]` `[reject]` Blind: a reclaim with `last_alive_at` later than `ts` inflates `held`. Evidence: carried. Same location and root cause as the earlier "`last_alive_at` later than `ts`" row, and the code is unchanged. `last_alive_at` is a same-host mtime, and the fix would add a guard.
  - `[low]` `[reject]` Blind: a waiting Lease's `for_ms` comes only from the windowed, silently read Event Log. Evidence: carried. This is the earlier "ticket visible before its `request` event" row. The result degrades to low-data plus the deadline. Storing `for_ms` in the ticket would add a ticket key, which the intent forbids.
  - `[false]` `[reject]` Blind: the window filter runs twice, the day constant is duplicated, and the `requests` map is built from unfiltered events. Evidence: `eta()` filters again by design ("whatever the caller passes"). Both constants are the fixed 86 400 000 ms, so no caller can diverge. The window rule covers past holds, and a waiting Lease's `request` lookup is not a past hold.
  - `[low]` `[reject]` Blind: every enqueue reads up to 30 days of events synchronously. Evidence: carried. Same as the earlier "history read at enqueue has no cost bound" row.
  - `[low]` `[reject]` Blind: an unknown part replaces the known summed `hi` with the deadline. Evidence: carried. Same as the earlier "unknown `hi` replaces a larger known sum" row, and the code is unchanged.
  - `[low]` `[patch]` Blind: coverage gaps for a `hub-job` entry, the reserved enqueue path, tries and a `hub-job` owner. Evidence: tries are already asserted ("a try writes no request"). A `hub-job` owner is a non-Lease owner, which the spec makes a Job Hold. The other two were real gaps. Fixed: added a `hub-job` table test and a Reservation-placed `withLock` integration test (grouped with the verification-gap rows below).
  - `[medium]` `[patch]` Blind: `eta.test.mjs` does not call `hermetic()`, and its timing will flake. Evidence: the committed file failed 2 of 3 runs. In "the asker's place counts end to end", B's rejection fired before its `assert.rejects` handler was attached and became an unhandled rejection. Fixed: the file now calls `hermetic()`, that test attaches both rejection handlers before releasing, and the new tests poll with `until` instead of fixed pauses. The file then passed 6 of 6 runs.
  - `[false]` `[reject]` Blind: the `lease.test.mjs` updates assert only part of `eta`, nothing shows `eta` is on `request` only, and the `events.mjs` schema docs omit it. Evidence: `events.mjs` has no per-event field list to update. The README documents `eta` on the `request` event. The exact `request` bodies in `lease.test.mjs` pin its values.
  - `[false]` `[reject]` Blind: maintainability nits (`let own` placement, a long comment line, `ms()` taking a number or ISO string, `HUB_ETA_FAILED` not naming the operation). Evidence: none of them has a named harm. The long line is carried from the earlier pass. The dual `deadline_at` form is documented in the header. The failure line names the lock and the reason.
  - `[low]` `[reject]` Edge: past holds are not filtered by `lock`. Evidence: each host's Event Log holds only that host's locks (`mac-ios` lives on the Mac). A repo and job pin to one lock (android → `adb`). Lease samples are shares normalised by `for_ms`. The intent's matching rule names repo and job only, and a lock filter would add a parameter to the pure contract.
  - `[false]` `[reject]` Edge: the `adb` and `mac-ios` catch-ups (repo and job null) blend their samples. Evidence: the two catch-ups write to different hosts' Event Logs, so `enqueueEta` never reads both.
  - `[low]` `[reject]` Edge: a holder whose ticket is not yet unlinked is counted twice. Evidence: `acquireLease` and `queuedLock` unlink the ticket right after the mkdir re-check, a sub-millisecond window. Unlikely, and the fix would add a guard.
  - `[false]` `[reject]` Edge: an injected partial policy gives `eta: null` and a `HUB_ETA_FAILED` line. Evidence: production callers pass null (`loadPolicy`) or the parsed policy. Only tests pass partial ones, and null plus one line is the specified behaviour.
  - `[low]` `[reject]` Edge: a stale owner (dead pid, not yet reclaimed) is counted as running. Evidence: the next poll reclaims it. Unlikely at the enqueue instant, and the fix would add a staleness branch.
  - `[low]` `[reject]` Edge: a reclaim's `last_alive_at` later than `ts` inflates `held`. Evidence: carried, same as the Blind row above.
  - `[low]` `[reject]` Edge: the synchronous read of the window's events can delay an enqueue. Evidence: carried, same as the earlier cost row.
  - `[low]` `[reject]` Edge: a waiting Lease's `request` event can fall outside the window, or not be written yet. Evidence: carried, same as the earlier "ticket before `request` event" row.
  - `[low]` `[reject]` Edge: the README says the ETA "never delays an enqueue". Evidence: carried, same root cause as the earlier cost row. The read is bounded by the policy window.
  - `[low]` `[patch]` Verification gap: no test checks a Reservation-placed waiter's ETA against its place in line. Fixed: a new `withLock` test reserves for run 9 and enqueues its android job behind a 10-minute Lease. It asserts the ticket names the Reservation, the ETA does not count the run's own grace (`hi_ms` ≤ 10 min), and a later Lease adds the job's 15-minute allowance (about 25 min).
  - `[low]` `[patch]` Verification gap: the `hub-job` kind is not covered. Fixed: a table test shows a `hub-job` entry uses its job's allowance when sparse and the p25/p75 of its job when rich, and never the unknown branch. The catch-up enqueue goes through the same `queuedLock` path that the job integration tests cover.
  - `[low]` `[patch]` Verification gap: the queued-job path does not assert its deadline-bound `hi_ms`. Fixed: a new test puts a `withLock` waiter behind a job holder with no allowance (`deliver`). It asserts `{lo_ms: 0, hi_ms: 30000, low_data: true}`, the waiter's own deadline, in both the ticket and its `request` event.
  - `[low]` `[reject]` Verification gap (other): history is pooled across locks. Evidence: same root cause and refutation as the Edge `lock` row.
  - `[low]` `[reject]` Intent alignment: reading R2, whole-host history rather than per-lock. Evidence: same as the Edge `lock` row.
  - `[false]` `[reject]` Intent alignment: reading R4, where a spent allowance counts as unknown. Evidence: this was a deliberate patch from the earlier pass. Reading (a) would report 0–0 while the lock is still held, which is the dishonest outcome the patch removed.
  - `[false]` `[reject]` Intent alignment: reading R5, where `hi` is raised to `lo` when the deadline is sooner. Evidence: the intent requires `lo ≤ hi`. Capping `lo` at the deadline would understate a wait the history supports, while raising `hi` tells the waiter it will likely time out.
  - `[low]` `[reject]` Intent alignment: reading R6, where the ETA is computed before the ticket lands. Evidence: carried. Same as the earlier "concurrent earlier-sorting enqueue missed" row, and the ordering is set in the Design Notes.
  - `[low]` `[reject]` Intent alignment: reading R7, where the newest `request` per `lease_id` comes from any lock. Evidence: lease ids are random (`l-<12 hex>`), so a cross-lock reuse needs a deliberate `--id`. Unlikely, and the fix would add a filter.
  - `[low]` `[patch]` Intent alignment: the enqueue surface lacks catch-up and Reservation coverage. Evidence: same root cause as the verification-gap rows. Fixed by the same tests.
  - `[low]` `[patch]` Intent alignment: the `withLock` test checks only shape. Fixed by the deadline-bound `withLock` test, which asserts exact values.
  - `[low]` `[reject]` Intent alignment: "read once, window only" is not tested on its own. Evidence: the real-history test shows out-of-window holds do not count. Proving how the read happens would need a new injection seam in `lock.mjs`.
  - `[low]` `[patch]` Intent alignment: the asker's own Reservation is left out only by file-name sort order, and nothing tests that. Fixed: the Reservation-placed `withLock` test pins it.

## Design Notes

**Holder conditioning.** A holder already held for `elapsed`. It matches only past holds that lasted longer than `elapsed` (for a Lease, `share × for_ms > elapsed`). Its remaining bounds are those survivors' p25/p75 minus `elapsed`. At `elapsed = 0` this is exactly "start + percentile". Without it, a holder past p75 would claim `0–0` while still holding the lock, which is dishonest. With too few survivors the entry is low-data and widens to its stated duration.

**Combination.** Bounds add, `lo = Σ lo_i` and `hi = Σ hi_i`. That is the "combined along the Queue" of FR-15. It is not a convolution, and that is deliberate: it is simple and conservative.

**Enqueue ordering.** The ETA must be in the ticket, so it is computed before the ticket lands. Mint the file name, read an observer view, compute, then write. Rewriting a written ticket could resurrect a ticket that `releaseLease` cancelled in between.

## Verification

**Commands:**
- `node --test tools/ci/eta.test.mjs tools/ci/policy.test.mjs tools/device/lease.test.mjs` -- expected: all pass
- `mise run check` -- expected: actionlint clean, the full suite green


## Auto Run Result

Status: done

**Summary:** A new pure function, `eta(queue, events, policy, now)` in `tools/ci/lib/eta.mjs` (AD-18), returns `{lo_ms, hi_ms, low_data}`.
- It takes the 25th and 75th percentiles of matching past holds from the Event Log inside a policy window, added along the Queue: the holder's remaining time (conditioned on how long it has already held) plus each blocking entry ahead.
- Jobs match on repo and job.
- Leases match on the share of `for_ms` that past agent Leases used, clamped to `expires_at`.
- A blocking Reservation adds 0 to its grace left.
- An entry with fewer holds than the threshold widens to its stated duration, or to the asker's deadline when nothing was stated.

Every enqueue (`acquireLease`, and the Queued `withLock` used by jobs and the catch-up) records that ETA in its ticket's `eta` field and its `request` event. An error records `eta: null` and logs `HUB_ETA_FAILED`. The policy `queue` block gains `eta_window_days` (30) and `eta_low_data_min_holds` (20). One level up (belsky-doctrine): every Queued lock and every Claimant kind gets its ETA from this one function, which Stories 4.2 and 4.3 will reuse unchanged.

This follow-up review pass changed only tests. It made `eta.test.mjs` stable and added coverage for the Reservation-placed, `hub-job` and deadline-bound enqueue paths.

**Files changed (whole story):**
- `tools/ci/lib/eta.mjs`: new. The pure ETA function and `percentile()`.
- `tools/ci/lib/lock.mjs`: `ticketName` split out of `writeTicket`, plus `enqueueEta`, which never throws and logs `HUB_ETA_FAILED`. The ETA goes into the ticket and the `request` event in `queuedLock` and `acquireLease`.
- `tools/ci/policy.json` and `tools/ci/lib/policy.mjs`: the two new strict `queue` keys.
- `tools/ci/eta.test.mjs`: new.
  - Table fixtures cover empty, sparse and rich history, the window, matching, `hub-job` entries, Lease share and clamp, holder conditioning, the reclaim correction, Reservations, the remote kind, a reused id and purity.
  - Integration tests cover a Lease, a `withLock`, real history, two waiters, a broken policy, a deadline-bound job waiter and a Reservation-placed run.
  - This pass added `hermetic()`, the polling helper and the race-free cancellation.
- `tools/ci/policy.test.mjs`: the queue-block table covers the new keys.
- `tools/device/lease.test.mjs`: the `request` bodies and the ticket assertion gain `eta`, each named as an intended change.
- `README.md`: a paragraph on the enqueue ETA.

**Review findings (follow-up pass):** 32 in total. Verdicts: high 0, medium 1, low 24, false 7.
- **Patched:** 9 findings in 2 root-cause groups.
  - The medium flaky-test group. "The asker's place" test raced two rejections; the committed file failed 2 of 3 runs, and it is now 6 of 6.
  - The low coverage group: a Reservation-placed waiter, the `hub-job` kind and the deadline-bound `withLock` ETA.
- **Deferred:** 0.
- **Rejected:** 23. Each reason is in the Review Triage Log above.
  - 7 false.
  - 10 carried from the first pass: the `last_alive_at` clamp, the cost of the history read, `for_ms` coming from the `request` event, an unknown `hi` taking the deadline, and the snapshot taken before the ticket lands.
  - 6 low and unlikely, each needing a new guard or parameter: per-lock history, the Reservation term the intent-contract sets, a double-counted holder in a sub-millisecond window, a stale owner, a cross-lock lease id, and testing "read once, window only" on its own.
- **Patched by verdict:** high 0, medium 1, low 1.

**Follow-up review recommended: false.** This is a follow-up pass and it patched no `high`. Every patch here changed tests only, so the work has converged.

**Verification:**
- The committed `eta.test.mjs` failed 2 of 3 runs before the patch. After it, `node --test tools/ci/eta.test.mjs` passed 24 of 24 in each of 6 runs.
- `node --test tools/ci/eta.test.mjs tools/ci/policy.test.mjs tools/device/lease.test.mjs`: 90 of 90 pass.
- `mise run check`: actionlint is clean, and 687 of 687 tests pass (0 fail, 0 skipped).

**Residual risks:**
- The ETA is computed from a snapshot taken before the ticket lands, so a concurrent enqueue in that instant can be missed by one entry.
- History is matched by repo and job (and agent kind for Leases), not by lock. That is safe while each repo and job pins to one lock on each host.
- No live hold history exists yet. Until about 20 holds per repo and job build up in the 30-day window, recorded ETAs will mostly be `low_data`.
