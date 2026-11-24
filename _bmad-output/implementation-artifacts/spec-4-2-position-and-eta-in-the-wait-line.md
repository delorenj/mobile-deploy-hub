---
title: 'Story 4.2: Position and ETA in the wait line'
type: 'feature'
created: '2026-11-24'
status: 'done'
review_loop_iteration: 0
baseline_revision: '0313ac0bbbd9abacf72ed8c313e0f6869db626de'
followup_review_recommended: false
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-4-context.md'
warnings: ['oversized']
deferred: []
---

<intent-contract>

## Intent

**Problem:** A waiter on a Queued lock prints one bare `HUB_LOCK_WAIT <name> held by <holder>` (or `queued behind N (...)`) line and then nothing, so a deploy job log or a `hub-device lease --wait` user cannot tell where they stand or how long the wait will be (FR-16).

**Approach:** One level up (belsky-doctrine): one wait reporter in `lock.mjs` serves every waiter on every Queued lock, of every Claimant kind (a Lease, a deploy job, the catch-up), not only `lease --wait`. Both wait loops (`acquireLease` and the Queued `withLock` path, `queuedLock`) call it on each poll. It prints `HUB_LOCK_WAIT <name> held by <holder> position=<n> eta=<lo>-<hi>[ low-data]` through the caller's `log`, which is the job log for deploy jobs and stderr for `hub-device`. It prints only when the position changes or the ETA moves by more than a minute. It recomputes the ETA with Story 4.1's `eta()` only on a position change or once 5 minutes have passed since the last computation. The ETA formatting is one pure exported function that Story 4.3's status reuses.

## Boundaries & Constraints

**Always:**
- `position` = the number of blocking entries ahead of the waiter's ticket (`blockersAhead(view, ticket)`, the same list the loop already computes) + 1. Position 1 means next in line, waiting only on the holder.
- `<holder>` is `describe(owner)` of the current `owner.json`. This is the existing wording, so the prefix `HUB_LOCK_WAIT <name> held by <holder>` is unchanged.
- ETA text comes from a new pure `formatEta(eta)` in `tools/ci/lib/eta.mjs`. Each bound is a duration: under 60 s → `<s>s`, under 60 min → `<m>m`, otherwise `<h>h<mm>m` (whole units, rounded to the nearest). The text is `<lo>-<hi>`, plus ` low-data` when `low_data` is set. A `hi_ms` of null prints `?`, and a null ETA (the computation failed) prints `eta=?`. Examples: `{0, 900000, true}` → `0s-15m low-data`; `{125000, 4500000, false}` → `2m-1h15m`.
- Recompute: the first wait line uses the ETA computed at enqueue (4.1), with no second computation. After that the ETA is recomputed only when the position differs from the position at the last computation, or when at least `ETA_REFRESH_MS` (5 min) has passed since it. A recompute reads the owner, an observer view and the policy window's events, exactly as `enqueueEta` does, with `file` = the waiter's ticket and its own deadline.
- Print: the first wait poll prints. After that, a line is printed only when the position differs from the last printed one, or when `etaMoved(lastPrinted, current)` holds. `etaMoved` is a new pure export in `eta.mjs`: true when `|Δlo_ms| > 60 000`, when `|Δhi_ms| > 60 000`, when `hi_ms` changes between null and a number, or when exactly one of the two ETAs is null.
- A failed recompute logs `HUB_ETA_FAILED` at most once per waiter, and the waiter goes on with `eta: null`. The wait itself never fails or slows because of the ETA.
- `hub-device lease`/`run` keep printing only `export` lines on stdout. The wait line goes to stderr through `context.log` (unchanged wiring).
- `lease.test.mjs:103`, the old wait-line test, is updated to the full new line and carries a comment naming it as the intended text change (FR-13, FR-16, AD-17).
- Node 24 ESM, no new dependency, no new clock or timer (the reporter runs inside the existing poll loop), hermetic tests.

**Never:**
- No change to the bare `withLock` path for names that are not Queued (`s3-*`, `s3-index`, `emulator-reaper`). It keeps its single `HUB_LOCK_WAIT <name> held by <holder>` line.
- No wait line for tries or Pool-level requests (they have no ticket and no ETA).
- No `hub-device status` change (4.3), no new event, ticket key or policy key, and no change to the `eta()` math.
- No ETA recompute on every poll.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Lease waiter behind a holder | one Lease holds `adb`, empty history | `HUB_LOCK_WAIT adb held by lease … position=1 eta=0s-<left> low-data` once | — |
| Stable wait | same position, polls inside 5 min | no new line, no recompute | — |
| 5 min passes | the holder's `hi` shrank by about 5 min | recompute, new line with the new ETA | — |
| Position change | a waiter ahead is cancelled | recompute, line with `position` one lower | — |
| ETA moves ≤ 1 min | recompute gives Δ ≤ 60 s, same position | nothing printed | — |
| Job / catch-up waiter | `withLock('adb')` behind a Lease | same line in the job's `log` | — |
| ETA fails | broken policy injected | `eta=?`, one `HUB_ETA_FAILED` per waiter | wait goes on |
| Unknown hi, no deadline | `hi_ms` null | `eta=<lo>-?` | — |

</intent-contract>

## Code Map

- `tools/ci/lib/eta.mjs` -- pure ETA module (Story 4.1). Add the exports `formatEta(eta)` and `etaMoved(a, b)`. It must stay import-free and clock-free (AD-18).
- `tools/ci/lib/lock.mjs:62-66` `describe` -- the `<holder>` text. Reuse it as is.
- `tools/ci/lib/lock.mjs:789` `blockersAhead(view, file, own)` -- the position source. Both loops already hold its result in `blockers`.
- `tools/ci/lib/lock.mjs:815-833` `enqueueEta` -- the read-and-compute path (owner, observer `queueView`, windowed `readEvents`, `eta()`). Reuse it for recomputes, adding a way to suppress the repeated `HUB_ETA_FAILED` log (for example a `log` the reporter wraps to print once).
- `tools/ci/lib/lock.mjs:898-1034` `queuedLock` -- the job/catch-up wait loop. The enqueue ETA is `estimate` (line 923, block-scoped: hoist it). The wait lines are at 1012 (held, no blockers) and 1020 (`queued behind`). Replace both with the reporter call. `ticket` is the waiter's file and `deadline` its deadline.
- `tools/ci/lib/lock.mjs:1053-1206` `acquireLease` -- the Lease wait loop. `estimate` is at 1091 and the wait lines at 1186 and 1193. Replace them the same way. Its `log` is `hub-device`'s stderr.
- `tools/ci/lib/lock.mjs:262` -- the bare non-Queued `withLock` wait line. Leave it unchanged.
- `tools/device/hub-device.mjs:165,747` -- `takeLease` passes `context.log` (`line => stderr(line)`) to `acquireLease`. No change is expected. It is the evidence that the line goes to stderr.
- `tools/device/lease.test.mjs:95-120` -- the old wait-line assertion at line 103 (`/^HUB_LOCK_WAIT adb held by delorenj\/example run 9/`). Tighten it to the full line and name the intended change.
- `tools/device/hub-device.test.mjs:566-583` -- the pattern for a `lease s26 --wait --no-connect` behind a `withLock` job (`f.run` captures `out` and `err`). Model the new stderr/stdout test on it.
- `tools/ci/eta.test.mjs` -- the 4.1 fixture style (`hermetic()`, `NOW`, `policy`). Put the `formatEta`/`etaMoved` table tests here.
- `tools/ci/test-fixtures.mjs:36` `hermetic()` -- required in any new lock test file.
- `tools/ci/lib/pause.mjs` `pause(ms, {signal, sleep})` -- honours an injected `sleep`, so a fake clock can drive `acquireLease` polls (advance the clock inside `sleep`).
- `README.md:96` -- the enqueue-ETA paragraph (it says the wait line "will reuse" `eta()`). Update it to describe the wait line.

## Tasks & Acceptance

**Execution:**
- [ ] `tools/ci/lib/eta.mjs` -- add `formatEta(eta)` and `etaMoved(a, b)` per Boundaries, and extend the header comment -- the one ETA text that the wait line and 4.3's status share.
- [ ] `tools/ci/lib/lock.mjs` -- add `export const ETA_REFRESH_MS = 300_000` and a `waitReporter(name, {ticket, deadline, estimate, requested, env, now, policy, host, hostId, processStart, log, afterEta})` that returns `report(owner, blockers)`. It applies the recompute and print rules, and `afterEta` is a test seam called once per recompute. Use it in `queuedLock` and `acquireLease` in place of the four `HUB_LOCK_WAIT` lines and the `waiting` flag. Thread `afterEta` (default no-op) through `acquireLease` and `withLock` → `queuedLock` options -- one reporter for every Queued waiter.
- [ ] `tools/ci/eta.test.mjs` -- table tests for `formatEta` (s/m/h boundaries, rounding, `low-data`, null `hi`, null ETA) and `etaMoved` (exactly 60 s is not moved, 60 001 ms is, null transitions).
- [ ] `tools/ci/wait-line.test.mjs` -- NEW, `hermetic()`. (a) A fake-clock `acquireLease` waiter behind a 60-min Lease prints exactly one full line during the first 5 min of polls, with `afterEta` not called. At 5 min it recomputes once and prints a new line whose `hi` is about 5 min lower. The holder is then released from inside `sleep` and the waiter takes the lock. (b) Two waiters behind a holder: the second prints `position=2`, and cancelling the first gives `position=1` with a recompute. (c) A `withLock('adb')` job behind a Lease prints the same line shape to its `log`. (d) An ETA recompute that throws (a broken policy) logs `HUB_ETA_FAILED` once and prints `eta=?`.
- [ ] `tools/device/lease.test.mjs` -- line 103: assert the full new line (`position=1 eta=… `) and add a comment naming the intended text change (FR-16, AD-17).
- [ ] `tools/device/hub-device.test.mjs` -- new test: `lease s26 --wait 30s --no-connect` behind a `withLock` job. It asserts that stderr has `HUB_LOCK_WAIT adb held by … position=1 eta=` and that stdout, after the job finishes, holds only `export` lines.
- [ ] `README.md` -- document the wait line, its print and recompute rules, and the `eta=` format.

**Acceptance Criteria:**
- Given a deploy job (`withLock` on a Queued lock) or `hub-device lease --wait` that has to wait, when it first waits, then its log (job log, or stderr for `hub-device`) has exactly one `HUB_LOCK_WAIT <name> held by <holder> position=<n> eta=<lo>-<hi>[ low-data]` line.
- Given a waiter whose position and ETA are stable, when it polls repeatedly within 5 minutes, then it prints nothing more and does not recompute the ETA.
- Given a successful `hub-device lease` that waited, when it ends, then stdout holds only `export` lines.
- Given `mise run check`, when it runs, then actionlint and the full suite pass.

## Spec Change Log

## Review Triage Log

### 2026-11-24 — Review pass
- verdicts: 25 findings — high 0, medium 1, low 14, false 10, maybe-false 0
- findings:
  - `[low]` `[reject]` Blind: `etaMoved` ignores a `low_data` flip, so the flag can stay out of date on screen. Evidence: the intent-contract print rule is "position changes or the range moves over a minute", and `etaMoved`'s definition leaves out the flag. Changing that means editing the spec.
  - `[low]` `[reject]` Blind: a holder can change with the position and range the same, so the line keeps naming the old holder. Evidence: a holder change normally moves the position (the head ticket takes the lock and leaves the Queue). The same position needs a try or a reclaim to take over. The print rule lives in the intent-contract, and the AC says to print only on a position or ETA change.
  - `[low]` `[reject]` Blind: a failed recompute drops the last good ETA for `eta=?`. Evidence: the spec's matrix row "ETA fails → `eta=?`" sets this. Failures come from a broken policy or an unreadable log, which are rare. Keeping a stale value would add state.
  - `[low]` `[reject]` Blind: the first printed ETA may have been computed for a different position than the first printed one. Evidence: the first poll runs in the same tick as the enqueue, microseconds later, and the intent says the first line uses the enqueue ETA "with no second computation". Unlikely, and the fix would add a parameter.
  - `[false]` `[reject]` Blind: the recompute's observer view and the poll's pruned view can disagree about stale tickets. Evidence: `queueView` drops stale tickets unless `includeStale` is set (`lock.mjs:778`), with or without prune. Both views list the same live entries.
  - `[low]` `[patch]` Blind: the README showed `ETA_REFRESH_MS` in the same format as a policy key. Fixed: the paragraph now says the 5-minute refresh and the one-minute move are fixed constants in `lock.mjs` and `eta.mjs` (FR-16, AD-18), not `policy.json` keys.
  - `[false]` `[reject]` Blind: `afterEta` is a test seam on public APIs. Evidence: it follows the existing `afterTake` and `beforeRetire` seams on the same functions, and no harm was named.
  - `[low]` `[patch]` Blind: the `hub-device` `lease --wait` test released the job after a fixed `settle(120)` and could flake. Fixed: it now polls until the ticket is queued and the wait line is on stderr before it releases.
  - `[low]` `[reject]` Blind: there are no tests for `hub-job`, an `eta=<lo>-?` line, a `withLock` 5-minute recompute, or a fail-then-recover case, and `etaMoved` gives NaN for an undefined `hi`. Evidence: `queuedLock` uses the same reporter for `job` and `hub-job`. `formatEta` covers `?`. `eta()` only ever returns a number or null for `hi_ms`, so an undefined `hi` cannot happen.
  - `[low]` `[reject]` Blind: `docs/features.md` has no wait-line entry. Evidence: it does not list the 4.1 ETA either, so the epic's feature-map entry belongs with the 4.3 release. The README documents the line.
  - `[false]` `[reject]` Blind: the README overstates scope ("every Claimant kind", Pool waits). Evidence: the README says "Tries and Pool-level requests have no wait line". A Pool's takes are `waitMs: 0` tries, which never build a reporter.
  - `[low]` `[reject]` Edge: the first-poll position and the enqueue ETA can disagree. Same root cause and refutation as the Blind first-position row.
  - `[low]` `[reject]` Edge: a holder or blocker identity change within 5 minutes neither recomputes nor prints. Same refutation as the Blind holder-change row.
  - `[false]` `[reject]` Edge: a throwing `log` marks the line printed but never shows it. Evidence: the throw propagates out of `report()` and ends the wait, exactly as the old inline `log()` calls did. No later poll is suppressed.
  - `[false]` `[reject]` Edge: `formatEta` prints a negative `hi`. Evidence: `eta()` guarantees `0 ≤ lo_ms ≤ hi_ms` (`eta.mjs`: held values are floored at 0, and `hi = max(lo, …)`).
  - `[false]` `[reject]` Edge: `etaMoved` NaN with an undefined or NaN bound. Evidence: `eta()` returns whole numbers or a null `hi`. A null ETA is handled by the `!a || !b` branch.
  - `[false]` `[reject]` Edge: a persistent failure re-reads the log every 5 minutes. Evidence: that is the bounded cadence AD-18 allows. One read every 5 minutes is the designed cost, and no harm was named.
  - `[low]` `[reject]` Edge (claim): the enqueue position is never recorded, so the recompute gate starts from the first poll. Same root cause as the first-position rows.
  - `[false]` `[reject]` Edge (deletion): the `queued behind N` wording is gone. Evidence: AD-17 names the new wait line as the one intended text change. A repository grep finds no reader of `queued behind`.
  - `[medium]` `[patch]` Verification gap: no test shows the print gate suppressing a line, so dropping either clause at `lock.mjs:179` passed. Fixed: a fake-clock waiter behind a hand-written job ticket recomputes at 5 minutes with an unchanged `0s-15m low-data` range and prints nothing new. A 30-second waiter ahead is cancelled, and the waiter behind it prints `position=1` on a sub-minute move. Both catch the matching mutation, as the implementer checked.
  - `[low]` `[patch]` Verification gap: nothing asserted that tries have no wait line. Fixed: an `acquireLease` try and a `withLock` try on a held `adb` log neither `HUB_LOCK_WAIT` nor `HUB_ETA_FAILED`.
  - `[low]` `[reject]` Verification gap (other): `hub-job` has no wait-line assertion. Evidence: it is the same `queuedLock` reporter path as `job`, and the layer did not file it as a gap.
  - `[low]` `[reject]` Verification gap (other): the once-per-waiter `HUB_ETA_FAILED` is tested only through `acquireLease`. Evidence: the latch lives in the shared `waitReporter`, and both loops build it the same way.
  - `[false]` `[reject]` Intent alignment: the deploy-job and catch-up job-log surface is not exercised end to end. Evidence: the real callers (`android.mjs:116`, `plan.mjs:250`, `ios.mjs:279`, `catchup.mjs:961`) pass their job `log`, or the default `console.log`, to `withLock`. The reporter writes through that `log`, so the line reaches the job log.
  - `[false]` `[reject]` Intent alignment: the epic's "nothing is printed" for a stable wait conflicts with printing on the first poll. Evidence: that AC is about a waiter's later polls. FR-16 and the first AC require the line to appear when the waiter starts waiting.

## Design Notes

**Why recompute only on a position change or every 5 min.** AD-18 bounds the history reads: the window read costs one pass over up to 30 days of JSONL, and a poll runs every 1–2 s. The ETA still moves on its own, because time passes and the holder's remaining time shrinks. The 5-minute recompute catches that, and the line then prints because the range moved by more than a minute. A stable wait therefore prints at most about once every 5 minutes, and only when the range really moved.

**Compare with the last printed ETA, not the last computed one.** If the comparison used the last computed ETA, small drifts would each stay under a minute and never print. Comparing with the last printed ETA lets them add up until the line is due.

**Line shape:**
```
HUB_LOCK_WAIT adb held by lease l-3f2a of agent-a (device proof) until 2026-11-24T13:00:00.000Z position=2 eta=12m-41m low-data
```

## Verification

**Commands:**
- `node --test tools/ci/eta.test.mjs tools/ci/wait-line.test.mjs tools/device/lease.test.mjs tools/device/hub-device.test.mjs` -- expected: all pass
- `mise run check` -- expected: actionlint clean, full suite green

## Auto Run Result

Status: done

**Summary:** Every waiter on a Queued lock (a Lease, a deploy job, the catch-up) now prints `HUB_LOCK_WAIT <name> held by <holder> position=<n> eta=<lo>-<hi>[ low-data]` through its own `log`. That is the job log for deploy jobs and the catch-up, and stderr for `hub-device lease --wait`. A successful `lease` still prints only `export` lines on stdout.
- One `waitReporter` in `lock.mjs` serves both wait loops (`acquireLease` and the Queued `withLock` path).
- The first poll prints the ETA computed at enqueue (Story 4.1).
- The ETA is recomputed only on a position change, or once `ETA_REFRESH_MS` (5 min) has passed.
- A line prints only when the position changes, or when the range moves by more than a minute from the last printed one (`etaMoved`).
- A failed recompute logs one `HUB_ETA_FAILED` per waiter and prints `eta=?`.
- Tries, Pool-level requests and the bare wait line of locks that are not Queued are unchanged.

One level up (belsky-doctrine): `lease --wait` asked for this, and every Claimant kind on every Queued lock got the same line. The ETA text, `formatEta()` in the pure `eta.mjs`, is the one text Story 4.3's status will reuse.

**Files changed:**
- `tools/ci/lib/eta.mjs`: adds the pure `formatEta()` (`<s>s` / `<m>m` / `<h>h<mm>m`, ` low-data`, `?`) and `etaMoved()` (more than 60 s on either bound, or null changing sides).
- `tools/ci/lib/lock.mjs`: adds `ETA_REFRESH_MS` and `waitReporter`. It replaces the four old `HUB_LOCK_WAIT` lines and the `waiting` flags in `queuedLock` and `acquireLease`. The `afterEta` test seam is threaded through `withLock` and `acquireLease`.
- `tools/ci/wait-line.test.mjs`: new, `hermetic()`. It covers:
  - a fake-clock Lease waiter, quiet for 5 minutes and then a recompute;
  - two waiters, with a position change;
  - a deploy job behind a Lease;
  - an ETA failure;
  - print-gate suppression (a recompute with no move);
  - a position change with a sub-minute move;
  - tries with no wait line.
- `tools/ci/eta.test.mjs`: table tests for `formatEta` and `etaMoved`.
- `tools/device/lease.test.mjs`: the old wait-line test (line 103) now asserts the full new line, and a comment names it as the intended text change (FR-13, FR-16, AD-17).
- `tools/device/hub-device.test.mjs`: a new `lease --wait` test checks that the line is on stderr and stdout holds only `export` lines.
- `README.md`: a paragraph on the wait line, its print and recompute rules, the `eta=` format, and the fixed constants.

**Review findings:** 25 in total. Verdicts: high 0, medium 1, low 14, false 10.
- **Patched:** 4.
  - Medium, test gap: the print gate is now pinned at the reporter level.
  - Low, test gap: tries are shown to print no wait line.
  - Low, docs: the README now marks `ETA_REFRESH_MS` as a constant.
  - Low, test flake: the `hub-device` test polls for the ticket instead of a fixed pause.
- **Deferred:** 0.
- **Rejected:** 21. The full reasons are in the Review Triage Log.
  - 10 false: the views do not skew (`includeStale`), the seam style is established, the README already scopes Pools, a throwing `log` behaves as before, negative or NaN bounds cannot happen, the 5-minute re-read is the designed cost, the `queued behind` removal is the AD-17 intended change, the real callers pass their job `log`, and the first-poll print is required.
  - 11 low:
    - The `low_data` flip and a holder change at the same position, which the intent's print rule excludes.
    - The first-poll position against the enqueue ETA (3 rows), which lands in the same tick.
    - `eta=?` replacing the last good range, which the matrix sets.
    - Test coverage on paths that share the code.
    - `docs/features.md` waits for the 4.3 release.
- **Patched by verdict:** high 0, medium 1, low 3.

**Follow-up review recommended: false.** This first pass patched no `high` and only one `medium`. Every patch changed tests or docs only, and `lock.mjs` is unchanged since the first implementation.

**Verification:**
- `node --test tools/ci/eta.test.mjs tools/ci/wait-line.test.mjs tools/device/lease.test.mjs tools/device/hub-device.test.mjs`: 141 of 141 pass.
- `tools/ci/wait-line.test.mjs` run alone: 7 of 7 in each of 8 runs.
- `mise run check`: exit 0, actionlint clean, 697 of 697 pass (0 fail, 0 skipped).
- The I/O matrix audit covered every row:
  - the first line, the stable wait and the 5-minute recompute (test a);
  - the position change (test b and the sub-minute case);
  - a move of a minute or less (the gate test, plus the `etaMoved` table);
  - the job waiter (test c);
  - the ETA failure (test d);
  - an unknown `hi` (the `formatEta` table).

**Residual risks:**
- A holder replaced at the same position, which takes a try or a reclaim, keeps its old name on screen until the next position change or until the range moves.
- A `low_data` flip alone does not reprint.
- Until about 20 holds per repo and job build up in the 30-day window, most lines will read `low-data`.
- Stories 4.1 to 4.3 ship together as one hub release (`mise run release -- X.Y.Z`, then `hosts:install`) at Story 4.3. Nothing here is released yet.
