---
title: 'Story 3.3: The catch-up delivers contention-pending builds in its turn'
type: 'feature'
created: '2026-11-24'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: false
baseline_revision: '1859d359329bb3408508a91ae998f1cfad2a0e27'
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-3-context.md'
warnings: ['oversized']
deferred: []
---

<intent-contract>

## Intent

**Problem:** Story 3.2 makes a busy S26 leave a build `pending` with reason `S26 busy`, but the catch-up still makes a 5-second attempt on `adb` every 120 s. Each attempt rejoins the back of the Queue, so back-to-back Leases and deploys can starve that build forever (FR-30, FR-7, AD-15). Its ticket and events also don't say which delivery they are for, and its timeout is logged as a deploy-style `deadline`.

**Approach:** One level up (belsky-doctrine): any Queued `withLock` caller can say which delivery its hold is for (a `delivery {repo, run, version}` option). It goes onto the ticket and onto every event that waiter or holder writes. The catch-up's two waits become strict `queue` policy values (`catchup_attempt_s`, `catchup_pending_wait_min`). Both passes (S26 and iPad) pick the wait from what is pending. A contention-pending build (`isBusyPending`) gets the long wait, bounded by the pass limit, so it stays in line until its turn. Anything else gets the short attempt. A timeout is coded, it is a `hub-job` `timeout` event with `reason: 'catchup-idle'`, and it is reported as `HUB_CATCHUP_IDLE`.

## Boundaries & Constraints

**Always:** Node 24 ESM `.mjs`, `node:` builtins only. Tests are hermetic: a temp `HUB_LOCK_DIR`/`XDG_STATE_HOME`, the fake adb, the fake S3, and no device, bucket or host state. Only `lock.mjs` appends events. The catch-up branches on `error.code` (AD-5), never on message text. The catch-up enqueues only when it has a pending build for that Resource (the Android pass already returns before the lock when nothing is pending). The `delivery` key appears on tickets and events only when the caller gave one, so every existing event and sequence test stays byte-identical. Policy values are read through `settingsFrom(policy)`, never from env or inputs.

**Never:** No change to `latest.json` keys or the status enum, to `transition()`, or to the `ahead`/refused path (story 3.4). No iOS lane change (story 3.5). No `releaseLease` or other second removal of the ticket on timeout: `lock.mjs`'s `timedOut` already unlinks it and writes the one `timeout` event. No new clock, timer or retry loop: the long wait is bounded execution inside one pass. No second lock or queue.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Busy-pending, freed in time | android `device {status:'pending', reason:'S26 busy'}`; a deploy holds `adb` past the short attempt and releases before the pending wait ends | the pass waits in line and gets the lock in its turn, then installs, and `latest.json` android device becomes `installed`, `by: catch-up`. The hub-job events are `request`, `acquire` and `release`, each with `delivery {repo, run, version}` | none |
| Busy-pending, still busy | same, but the holder outlasts the pending wait | `HUB_CATCHUP_IDLE android …` naming the pending builds and how long it waited. The hub-job events are `request` then `timeout` with `reason:'catchup-idle'`, `claimant.kind:'hub-job'`, `delivery`, and `waited_ms` ≥ the pending wait. The `adb.queue` is empty and the pass returns no error | coded `HUB_LOCK_TIMEOUT` → idle |
| Away-pending (not busy) | pending with reason `not on big-chungus's adb`; `adb` held | it waits only the attempt (`waited_ms` well under the pending wait), then idle and a `catchup-idle` timeout | idle |
| Ticket released mid-wait | an operator removed the catch-up's ticket | `HUB_CATCHUP_IDLE … its place in the adb queue was released`, and no error | coded `HUB_LEASE_CANCELLED` → idle |
| Pass limit | the pass has already run near its 45-minute watchdog | wait = min(pending wait, pass limit − reserve − elapsed), never below the attempt | none |
| iPad pass | pending iOS build (never busy in v1a); `mac-ios` held | the short attempt, and its ticket and events carry the iOS build's `delivery` | idle |

</intent-contract>

## Code Map

- `tools/ci/policy.json` (`queue` block) -- add `"catchup_attempt_s": 5, "catchup_pending_wait_min": 30`.
- `tools/ci/lib/policy.mjs:281-297` -- `queueBlock`: add both keys to `exact(...)` and `positive(...)` for each. Extend the comment ("Story 3.3 adds the catch-up's two waits").
- `tools/ci/policy.test.mjs:158-205` -- the strict-block test: the expected `base.queue`, plus bad cases for each new key (missing, zero, fractional, text), with the good-copy round trip extended.
- `tools/ci/lib/lock.mjs:189-213` -- `withLock`: new option `delivery = null`, validated by a new exported `checkDelivery(delivery)`. A valid value is null, or a plain object with exactly `repo` (`/^[\w.-]+\/[\w.-]+$/`), `run` (`/^\d{1,20}$/` as a string) and `version` (`/^[0-9A-Za-z.+-]{1,40}$/`). Anything else throws `bad delivery`. Pass it to `queuedLock`. The bare path ignores it, because a non-Queued name writes no ticket or event.
- `tools/ci/lib/lock.mjs:856-988` -- `queuedLock`: pass `delivery` to `buildTicket` (line 878; `buildTicket` already takes `delivery`, line 434). Define `const tag = delivery ? { delivery } : {}` and spread it into the `request` (881), `leave` (888, covering timeout and cancel) and `acquire` (951) event fields. Pass it on to `runHeld`.
- `tools/ci/lib/lock.mjs:261-304,145-181` -- `runHeld(…, { fields })` passes `fields` to `retire(..., { as: 'release', fields })`. `retire` gains a `fields = {}` option, spread into its `note(eventOf(...))` after the existing fields. Reclaims by others carry nothing extra.
- `tools/catchup/catchup.mjs:73-89` -- `settingsFrom`: `attemptMs: policy.queue.catchup_attempt_s * 1000` and `pendingWaitMs: policy.queue.catchup_pending_wait_min * 60_000`.
- `tools/catchup/catchup.mjs:1077` -- the 45-minute watchdog. Export `passLimitMs = 45 * 60_000` and `passReserveMs = 10 * 60_000` (install, readback and record after the wait), and use `passLimitMs` in `main`.
- `tools/catchup/catchup.mjs` (new, near `inflightHolds`) -- `export function catchupWait(work, { settings, elapsedMs = 0, attemptMs })`. It returns `{ ms, pending, delivery }`. `pending` is the first item whose `isBusyPending(item.block.device)` is true. `ms` is `max(attempt, min(settings.pendingWaitMs, passLimitMs − passReserveMs − elapsedMs))` when `pending` is set, else the attempt. `delivery` is `{ repo: item.app.repo, run: String(item.block.run.id), version: item.block.version }` for `pending`, else for the first non-`settled` item, else null.
- `tools/catchup/catchup.mjs:443-476` (`androidPass`) and `557-600` (`iosPass`) -- replace `{ timeoutMs: ctx.lockWaitMs ?? 5_000, pollMs: 100 }` with `{ timeoutMs: wait.ms, pollMs: 100, delivery: wait.delivery, timeoutReason: 'catchup-idle' }`. The attempt is `ctx.lockWaitMs ?? ctx.settings.attemptMs`, and elapsed is `ctx.now() − ctx.startedAt`. Log `HUB_CATCHUP_WAIT <platform> <slug> <version>: contention-pending; waiting up to N min for its turn on <lock>` when the long wait applies. Replace the `/host lock … is held/` catches with `error.code === 'HUB_LOCK_TIMEOUT'` (`HUB_CATCHUP_IDLE <platform> <mode>: <items> pending; <lock> stayed held for <waited> (<first holder kind and name>); next pass`) and `error.code === 'HUB_LEASE_CANCELLED'` (idle, place released). Rethrow everything else. After a long wait, re-check `notInFlight` inside the hold before installing.
- `tools/catchup/catchup.mjs:843-858` (`base`) -- add `startedAt: now().getTime()`. In `linuxContext` and `macContext`, change `lockWaitMs = 5_000` to `lockWaitMs` (undefined → policy).
- `tools/ci/lib/latest.mjs:21-26` -- `isBusyPending`, read-only reuse.
- `tools/catchup/catchup.test.mjs:51-61,143-176` -- `androidBlock({device})`, `linuxHost`. `495-516`: the Story 2.3 test, whose timeout reason becomes `catchup-idle` and whose idle wording is updated. `1256-1264`: the hub-job event test.
- `tools/ci/reservation.test.mjs` -- the `withLock` queued tests, the pattern for the lock-level `delivery` test.
- `README.md:84-90` -- the "Queue tuning" section, where a bullet for the two new keys goes.

## Tasks & Acceptance

**Execution:**
- `tools/ci/policy.json`, `tools/ci/lib/policy.mjs` -- add `catchup_attempt_s` (5) and `catchup_pending_wait_min` (30) to the strict `queue` block -- AD-11: the catch-up's waits are policy
- `tools/ci/lib/lock.mjs` -- `delivery` option with `checkDelivery`, carried on the ticket and on request/acquire/timeout/cancel/release events -- AD-15, generic for any Queued caller
- `tools/catchup/catchup.mjs` -- `settingsFrom` waits, `passLimitMs`/`passReserveMs`, `catchupWait`, both passes using it with `delivery` and `timeoutReason: 'catchup-idle'`, coded timeout/cancel handling, in-hold inflight re-check after a long wait, `startedAt` -- FR-30 in its turn
- `tools/ci/policy.test.mjs` -- new keys in the strict-block test -- the policy AC
- `tools/ci/reservation.test.mjs` -- a queued `withLock` with `delivery` puts it on the ticket file and on the request, acquire and release events (and on timeout in a timed-out wait). Without it, no `delivery` key appears. A bad delivery throws `bad delivery` -- the generic option
- `tools/catchup/catchup.test.mjs` -- the matrix rows: the busy-pending build freed in time (installed, `delivery` on acquire/release); busy-pending still busy (pending-length wait, `catchup-idle` hub-job timeout with `delivery`, empty queue, no error); away-pending (attempt-length wait); cancelled ticket (idle); a `catchupWait` unit test for the pass-limit bound and `settingsFrom` values, plus the shipped `catchup_pending_wait_min` fitting within `passLimitMs − passReserveMs`; the iPad pass ticket carries `delivery`; the updated Story 2.3 test
- `README.md` -- document the two keys and the catch-up's turn in the queue tuning section

**Acceptance Criteria:**
- Given the policy `queue` block, when `parsePolicy` reads it, then it requires `catchup_attempt_s` and `catchup_pending_wait_min` as positive whole numbers and refuses the block without them.
- Given a pending build marked `S26 busy`, when the catch-up runs while `adb` is held, then its `adb.queue` ticket is `kind: hub-job` with `delivery {repo, run, version}`, and it waits up to `catchup_pending_wait_min`, bounded by the pass limit.
- Given no contention-pending build, when the catch-up runs while `adb` is held, then it waits only `catchup_attempt_s`.
- Given either wait runs out, when it times out, then the ticket is gone, the log says `HUB_CATCHUP_IDLE`, and the Event Log has a `timeout` event with `claimant.kind: 'hub-job'` and `reason: 'catchup-idle'` (never `deploy`, never `deadline`).
- Given the catch-up gets the lock for a contention-pending build, when it installs, then `latest.json`'s device is `installed` by `catch-up`, and its `acquire` and `release` events carry `delivery`.
- Given the hermetic suite, when `mise run check` runs, then it passes.

## Spec Change Log

## Review Triage Log

### 2026-11-24 — Review pass
- verdicts: 28 findings — high 0, medium 3, low 18, false 7, maybe-false 0
- findings:
  - `[low]` `[patch]` (blind) `passLimitMs` and `passReserveMs` are hard-coded, a policy pending wait above 35 min would be clamped silently, and the watchdog message hard-codes "45 minutes". The clamp cannot ship silently, because the `catchupWait` test asserts the shipped value fits within `passLimitMs − passReserveMs`, so `mise run check` goes red first. Patched the message: its minutes now come from `passLimitMs`.
  - `[low]` `[reject]` (blind) Only one delivery is named when several builds are pending. AD-15 and the AC give the ticket a single `{repo, run, version}`. This is recorded in Design Notes, and every other install is still recorded through `record()`.
  - `[false]` `[reject]` (blind) A bad delivery is swallowed silently in `catchupWait`. This is unreachable: `latestProblems` runs `validateLatest`, which pins `run.id` to `/^\d{1,20}$/` and `version` to semver (`latest.mjs:114,140`), and `repo` comes from the policy.
  - `[medium]` `[patch]` (blind) The in-hold `inflight.json` re-read is untested and keyed on the configured wait. It shares a root cause with the verification-gap row below, and the test was added there. The keying works as designed: a 5 s attempt needs no re-read.
  - `[low]` `[patch]` (blind) The README's `extendLease` claim has no test. Added a `hub-job` ticket case to `extend.test.mjs`. The extension is refused with the catch-up named.
  - `[false]` `[reject]` (blind) Overlapping passes could stack tickets. Candybar skips a fire while the pass is still running (units comment, `mobile-deploy-hub-catchup.service`). The unit is a systemd oneshot, and the iPad kick returns `HUB_MAC_BUSY` without kicking again.
  - `[low]` `[reject]` (blind) The iOS contention-pending path is untested. It is unreachable in v1a, because the iPad is never marked busy (Story 3.5 makes iOS contention red). The shared `catchupWait`/`queueWait` path is tested through Android.
  - `[false]` `[reject]` (blind) The idle log reports the planned wait, and a cancel is logged as the full wait. A hub-job wait is never deadline-capped, so its timeout fires at `requested + timeoutMs`, which is the planned wait. The cancelled message prints no duration at all.
  - `[low]` `[reject]` (blind) The tests are timing-based, and a delivery passed to a non-Queued lock is dropped. The margins are generous (a 900 ms release against a 5 s wait, and a 2 s bound against a 300 ms attempt). A non-Queued lock writes no ticket or event, so there is nothing to carry the delivery.
  - `[false]` `[reject]` (edge) A `HUB_LOCK_TIMEOUT` from an inner `s3-<slug>` lock could be misreported as adb idle. No `withLock` runs inside the `adb`/`mac-ios` holds: `record()` runs in `settle()` after the hold returns (`catchup.mjs:311`).
  - `[false]` `[reject]` (edge) The swallowed `checkDelivery` failure loses the tag. Same refutation as the blind row: upstream validation makes it unreachable.
  - `[low]` `[reject]` (edge) After a long wait only `inflight.json` is re-read, not `latest.json`. A deploy that finished during the wait took `adb` first and installed a newer build, so `androidPlan` returns `ahead` and `record()` leaves a moved pointer alone. Hitting the residual case requires a deploy to go pending behind the catch-up's own ticket, which is rare, and the fix would add a guard.
  - `[low]` `[reject]` (edge) The re-check is keyed on the configured wait, not the time actually waited. An immediate acquire costs one extra S3 read, which does no harm.
  - `[false]` `[reject]` (edge) The idle line overstates the wait if the lock timed out early. A hub-job is never deadline-capped (`queuedLock` caps only `kind === 'job'`), so it never times out early.
  - `[low]` `[reject]` (edge) Builds installed in the same hold carry no delivery tag. This duplicates the one-delivery design row.
  - `[low]` `[patch]` (edge) The README's "never past the pass limit less the reserve" contradicts the floor at the short attempt. The README now says the wait is bounded by that limit but is never shorter than the short attempt.
  - `[medium]` `[patch]` (verification-gap) The post-wait `inflight.json` re-read was unpinned: deleting it kept the suite green. Added a test that puts `inflight.json` during the wait. The build is not installed, `latest.json` stays pending, and the log says `HUB_CATCHUP_IDLE … is publishing`. I verified that it fails with the re-read disabled.
  - `[low]` `[patch]` (verification-gap) The pass-level elapsed bound was not exercised. Added a test with `ctx.startedAt` 20 min back and the shipped wait. `HUB_CATCHUP_WAIT` says `waiting up to 15 min`.
  - `[low]` `[patch]` (verification-gap) A catch-up ticket blocking `extendLease` was unpinned. Added the `hub-job` case to `extend.test.mjs`, and the same patch covers the blind row.
  - `[false]` `[reject]` (verification-gap) The idle log uses the planned wait. Same refutation as the blind row: for a hub-job the planned wait is the actual one.
  - `[low]` `[reject]` (verification-gap) The busy-pending test relies on real timers. Its margins are wide (release at 900 ms, a 600 ms floor, a 5 s limit), and the suite passed twice on the shared box.
  - `[low]` `[reject]` (intent) The shipped 30 min and 5 s waits are checked only arithmetically. A hermetic test cannot wait 30 min. The `settingsFrom` values and the pass-limit fit are asserted, and the wiring is exercised with smaller values through the same code.
  - `[low]` `[reject]` (intent) The tests fabricate `S26 busy` instead of going through the Story 3.2 deploy path. Story 3.2's tests pin the writer side, and both sides key on the one shared `busyReason`/`isBusyPending`.
  - `[medium]` `[patch]` (intent) No new test triggered the in-hold re-read. This duplicates the verification-gap row, and the test was added.
  - `[low]` `[reject]` (intent) `main`, the watchdog and the Mac kick are untested. Only a constant changed there, and the entry points are host-only (`requireHost`).
  - `[low]` `[reject]` (intent) A contention-pending iOS wait is untested. This duplicates the blind iOS row, since the path is unreachable in v1a.
  - `[low]` `[patch]` (intent) The README `extendLease` claim was not re-tested. This duplicates the blind and verification-gap rows, and the `hub-job` extend test was added.
  - `[low]` `[reject]` (intent) There is one delivery per ticket. This duplicates the design row (AD-15 is singular).
## Design Notes

One `delivery` per hold: a pass holds `adb` once for every pending app. The ticket names the build that set the wait length (the contention-pending one) or else the first pending build, because AD-15 gives the ticket a single `{repo, run, version}`. Other builds installed in the same hold are still recorded through `record()` as today.

Why the bound is 35 minutes: the watchdog kills a pass at 45 minutes, and systemd's `TimeoutStartSec` is 50. The reserve covers the download, install, readback and `record()` after the lock is won. Candybar skips a fire while a pass is still running, so the long wait never stacks passes. While the catch-up's ticket waits, `extendLease` refuses extensions. That is the deterministic behaviour AD-16 and adversary review #19 asked for.

Story 3.2 released the run's Reservation, so the catch-up's ticket queues FIFO from its own arrival. The wait can outlast a deploy that starts meanwhile, so the hold re-reads `inflight.json` before it installs an older build.

## Verification

**Commands:**
- `node --test tools/catchup/catchup.test.mjs tools/ci/reservation.test.mjs tools/ci/policy.test.mjs` -- expected: all pass
- `mise run check` -- expected: actionlint and the full suite are green

## Auto Run Result

Status: done

**Summary.** A build that went pending as `S26 busy` (Story 3.2) now waits its turn in the `adb` Queue instead of making a 5 s attempt every 120 s from the back of the line. When the catch-up has a contention-pending build, it waits up to the policy's `catchup_pending_wait_min` (30), bounded by the 45-minute pass limit less a 10-minute reserve and never shorter than the attempt. Any other pending build makes only the `catchup_attempt_s` (5) attempt. The ticket and every event of that hold (`request`, `acquire`, `timeout`/`cancel`, `release`) carry `delivery {repo, run, version}`. When a wait runs out, `lock.mjs` removes the ticket and writes one `hub-job` `timeout` event with `reason: catchup-idle`, and the pass logs `HUB_CATCHUP_IDLE` and ends without an error. A ticket an operator released idles the pass the same way. The catch-up now branches on `error.code` (AD-5), not on message text. After a long wait, the hold reads `inflight.json` again before it installs, so it never installs an older build while a deploy is publishing.

One level up (belsky-doctrine): any Queued `withLock` caller can pass `delivery` (validated by `checkDelivery`), and it lands on the ticket and on every event of that hold only when given. Both catch-up passes (S26 and iPad) choose their wait through the one `catchupWait`.

**Files changed**
- `tools/ci/policy.json`, `tools/ci/lib/policy.mjs`: `catchup_attempt_s` and `catchup_pending_wait_min` in the strict `queue` block.
- `tools/ci/lib/lock.mjs`: the `delivery` option and `checkDelivery`. The delivery goes on the ticket and on the request, acquire, timeout, cancel and release events.
- `tools/catchup/catchup.mjs`:
  - `settingsFrom` waits, `passLimitMs`/`passReserveMs`, `catchupWait`, `queueWait`, `idleOnQueue`
  - coded timeout and cancel handling in both passes
  - the in-hold inflight re-check, `startedAt`, and a policy-derived attempt
- `README.md`: the catch-up's turn in the Queue tuning section.
- Tests: `tools/catchup/catchup.test.mjs`, `tools/ci/reservation.test.mjs`, `tools/ci/policy.test.mjs`, `tools/ci/extend.test.mjs`.

**Review findings.** 28 findings: medium 3, low 18, false 7.
- Patched: 5 entries.
  - The in-hold inflight re-read test (medium; 3 rows).
  - The pass-level elapsed-bound test (low).
  - The `hub-job` `extendLease` refusal test (low; 3 rows).
  - README wording on the attempt floor (low).
  - The watchdog message from `passLimitMs` (low).
- Deferred: none.
- Rejected, each with its reason in the Review Triage Log:
  - The false ones: the swallowed delivery (×2, unreachable after validateLatest), overlapping passes (Candybar skips overlaps), the idle-log wait time (×3, hub-job waits are never capped), and the inner s3 timeout (no lock inside the hold).
  - The low ones: one delivery per hold (×3, AD-15 is singular), the untested iOS contention path (×2, unreachable in v1a), timing-based tests (×2), no `latest.json` re-read, keying the re-check on the configured wait, arithmetic-only checks of the shipped waits, fabricated `S26 busy`, and the untested `main`.

Patched counts by verdict: high 0, medium 1 entry (3 rows), low 4 entries.

**Follow-up review: false.** No high was patched and only one medium entry was patched, so no unverified risk is left to name.

**Verification**
- `node --test tools/catchup/catchup.test.mjs tools/ci/reservation.test.mjs tools/ci/policy.test.mjs tools/ci/extend.test.mjs`: 101 of 101 pass.
- `mise run check`: actionlint, then 649 of 649 after implementation and 651 of 651 after the review patches.
- Matrix audit, every row covered by a passing test:
  - busy-pending freed in time;
  - busy-pending still busy;
  - away-pending short attempt;
  - ticket released mid-wait;
  - the pass-limit bound (the `catchupWait` unit test and the pass-level elapsed test);
  - the iPad pass delivery.

**Residual risks**
- The real 30-minute wait was not run live. The tests use millisecond seams, and the first busy deploy on a release carrying this change is the live proof.
- With several apps pending, the ticket names one delivery: the contention-pending build, else the first one.
- While the catch-up waits, `extendLease` refuses on that device for up to 30 min. This is intended (AD-16), but leaseholders will notice it.
- Runs and catch-ups on hub pins older than this release keep the 5 s attempt until the next hub release and `hosts:install`.
