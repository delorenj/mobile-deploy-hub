---
title: '`phone` holds a place in line'
type: 'feature'
created: '2026-11-25'
baseline_revision: '76c4f05aa0dbf2cae139b73fdb3c7fb40d20f960'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-5-context.md'
warnings: ['oversized']
deferred: []
---

<intent-contract>

## Intent

**Problem:** `hub-device lease phone --wait 2m` (and `lease|run --match`) is an ordered try with no ticket: when both phones are held it polls, never holds a place, can be jumped by later takers, and prints no position or ETA, so QA agents retry by hand (FR-6, UJ-2, AD-33, AD-4).

**Approach:** Add one Pool request to `lock.mjs` (`acquirePool`) that writes the identical ticket file into every member's queue, takes the first member that serves it (preference order on a tie), and withdraws the rest only once it has won. The Claims library's Pool take (`phone` and `--match`) runs through it, finding the phone inside an `accept` hook; status lists a Pool waiter once.

## Boundaries & Constraints

**Always:**
- `lock.mjs` exports `acquirePool(pool, members, opts)`. `members`: lock names in preference order (each a valid lock name; one over its deploy-target cap for `forMs` throws `HUB_LEASE_TOO_LONG`). `opts`: `holder`, `why`, `forMs`, `waitMs` (0 = try), `id` (default `newLeaseId()`), `holderPid`, `env`, `pollMs`, `staleMs`, `log`, `sleep`, `now`, `signal`, `host`, `hostId`, `processStart`, `policy`, `afterEta`, `accept`, `giveUp`, plus test seams `afterTake`, `beforeWithdraw`.
- Waiting (`waitMs > 0`): mint one `ticketName`; compute each member's `enqueueEta` for that file and combine them with `eta.mjs` `earliest()` (`lo = min lo_i`, `hi = min hi_i` with null meaning unknown, `low_data` if any member's is; null when no member has an ETA); write the same `buildTicket('lease', {..., lease_id: id, pool, request: id, eta})` body under that file into every member's queue; then `poolRequest(pool, {..., eta})` writes the one Pool-level `request` (with `eta`). A try writes no ticket and its `request` carries no `eta` key.
- Each pass, in member order: a member whose ticket vanished → `HUB_LEASE_CANCELLED`; blocked (a blocking entry ahead of the ticket, every blocking entry for a try, or the lock held and not stale) → state `held`; otherwise take it exactly as `acquireLease` does (mkdir, owner record with `lock_ino`, re-check, claim = unlink that member's ticket, reclaim a stale holder first), writing `acquire` tagged `pool`/`request` with `waited_ms` from the request. Then:
  - Duplicate: if another member's owner is a Lease with this request's id, the just-taken member is released with `reason: 'pool-duplicate'` and the other is kept.
  - `accept(name, record)` (default keep) resolves `{ok: true, value}` → the request has won: every other ticket is withdrawn (rename to `<file>.tomb-<ms>-<pid>`, then remove; ENOENT is fine; no event) and it returns `{name, record, value}`. `{ok: false, state}` → `releaseLease(name, id)` (a `release`, reason `by-id`), state recorded, and a waiting request re-writes its ticket under the same file name (same place) and goes on. A throw → the lock is given back if this Lease still holds it, then the error ends the request.
- No member served: past the deadline every ticket is withdrawn and `giveUp(states)` (a `Map` lock → `held` or away state) supplies the error (default `HUB_LOCK_TIMEOUT` naming each holder); else, when waiting, one wait line `HUB_LOCK_WAIT <pool> held by <holder> position=<n> eta=<range>` through the existing reporter's print/recompute rules, for the `held` member with the fewest blockers ahead (first on a tie), `eta` the combined Pool ETA; then `pause(pollMs)`.
- Every way out but a win withdraws all remaining tickets and calls the request's `settle` once (`timeout` for `HUB_LOCK_TIMEOUT`/`HUB_PHONE_AWAY`, else `cancel`: `aborted`, `released`, `error`), so the log holds one `request` and exactly one `acquire`, `timeout` or `cancel` at Pool level, plus the true `acquire`/`release` pairs of members that were found away (the v1a sequence).
- `releaseLease(name, id)` that unlinks a Pool ticket (`pool` and `request` strings) writes no per-lock `cancel` (the request writes its own). `claims.releasePhone` of a waiting id cancels it on every fleet phone where it waits; the outcome stays `cancelled`.
- `claims.take` of a Pool target calls `acquirePool(target.pool ?? 'phone', locks, …)`: `accept` finds the phone with a slice (`min(HUB_DEVICE_PHONE_SLICE_MS, time left)`) and records the device (`noConnect` keeps at once); a `HUB_PHONE_AWAY` is `{ok: false, state: reason}`; `giveUp` is today's `noPhoneError` (every phone held → BUSY 76, else AWAY 75, same messages). The `--match` reachability pre-filter is unchanged. Exports, `HUB_DEVICE` and `--json` are unchanged.
- `statusView`: tickets with `pool` and `request` strings fold into one waiter row per request, carrying the v1a keys of its best member (fewest place; first walked on a tie) plus additive `request`, `pool`, `positions: {<lock>: n}` (each member's `#n`), with `eta` the `earliest()` of the members' live ETAs. Other rows keep exactly their keys. Text status prints a Pool row once with `  pool <pool> (<lock> #<n>, ...)` appended, and DEPLOY TARGET `waiting` counts it for every lock in `positions`.

**Never:** No change to `acquireLease`, `withLock`, the emulator Pool or its `emulator` gate queue, the ticket file format (only the existing `pool`/`request` keys are filled), the deploy path, `extendLease` (Story 5.9), or any `--json` key of a non-Pool row. No new dependency, no second lock or queue store.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Both free | `lease phone` | s24 taken, no ticket left in either queue | exit 0 |
| s24 held, s26 free | `lease phone` | s26 taken at once; s24 ticket withdrawn | exit 0 |
| Both held, s26 freed | `lease phone --wait 1m` | `HUB_LOCK_WAIT phone held by … position=1 eta=…` on stderr, then s26 | exit 0; events `request`,`acquire adb` |
| Both held, s24 freed | same | s24 taken | exit 0 |
| FIFO | single `lease s26` waiter queued before the Pool | when adb frees, that waiter gets adb; the Pool keeps waiting | — |
| Both held, `--wait 0` | today's test | `HUB_DEVICE_BUSY phone every phone is held: …`, no ticket | exit 76 |
| Free but away | `--wait 0` | v1a event sequence | exit 75 |
| Withdraw race | ticket cancelled before the winner's rename | win still returns, no throw | — |
| Cancel | `release <id>` while waiting | every member's ticket gone, one Pool `cancel` reason `released` | waiter exits 1 `HUB_DEVICE_CANCELLED` |
| Killed waiter | `SIGKILL` | its tickets read stale by pid; an acquirer's prune removes both | — |
| Duplicate | request id already holds adb | the just-taken s24 released `reason: pool-duplicate`, adb returned | — |

</intent-contract>

## Code Map

- `tools/ci/lib/lock.mjs` -- L839 `blockersAhead`, L851 `ticketName`, L855 `writeTicket` (takes `file`), L892 `enqueueEta`, L918 `waitReporter` (generalize with a `recompute`/label seam; default behaviour byte-identical), L972 `poolRequest` (add optional `eta`), L1167-1320 `acquireLease` (the take block to mirror; leave untouched), L1326 `releaseLease` (Pool ticket: no event), L196 `retire`, L792 `startGrace`, L120 `staleness`, L432 `inodeOf`, L407 `writeOwner`. `acquirePool` goes after `poolRequest`.
- `tools/ci/lib/eta.mjs` -- add pure `earliest(values)`.
- `tools/device/claims.mjs` -- L241 `takePhone` (split the find-and-record part into a helper both paths use), L277 `noPhoneError` (keyed by device; feed it from lock states), L295 `takeAnyPhone` (becomes the `acquirePool` call), L372 `take`, L428 `releasePhone` (all phones), L605-626 `statusView` waiter loop (fold Pool rows), L647-654 row enrichment (uses `row.lock`).
- `tools/device/hub-device.mjs` -- header L9-12 (phone now queues), L354-364 WAITERS text, L366-379 DEPLOY TARGET counting.
- `tools/device/hub-device.test.mjs` L234-410 -- `phone` ordering, BUSY/AWAY and Pool-event tests; expected to pass unchanged. Any assertion that has to change is named in the Auto Run Result as the intended text change (FR-13).
- `tools/device/lease-match.test.mjs`, `tools/device/status-view.test.mjs`, `tools/ci/wait-line.test.mjs`, `tools/device/emulator.test.mjs` -- must stay green.
- `tools/ci/wait-line.test.mjs` L1-60 -- fixture pattern (fake clock via `sleep`, `policyOf()`, `HOST_ID`) for lock-level tests.
- `README.md` L241 (`phone` paragraph: now a place in line), L243 (`--match` "no ticket, no place in line"), L257 (WAITERS block: the Pool row); `docs/features.md` L43.

## Tasks & Acceptance

**Execution:**
- `tools/ci/lib/eta.mjs` -- `earliest()` -- AD-18's one ETA module owns the combination.
- `tools/ci/lib/lock.mjs` -- `acquirePool`, `poolRequest` `eta`, reporter seam, Pool-ticket `releaseLease` -- AD-33's Pool request in the one lock module.
- `tools/device/claims.mjs` -- Pool take through `acquirePool`, `releasePhone` on every member, status Pool rows -- every front door shares it.
- `tools/device/hub-device.mjs` -- header, WAITERS Pool suffix, DEPLOY TARGET count.
- `tools/ci/pool-request.test.mjs` -- NEW, hermetic, lock level: served by each member, preference on a tie, FIFO behind a single waiter, identical ticket names, withdrawal (no event, tomb seam, ENOENT race), cancel withdraws every member, killed child waiter pruned by pid, `pool-duplicate`, try writes no ticket, Pool ETA = `earliest`, event sequences.
- `tools/ci/eta.test.mjs` -- `earliest()` cases (unknown hi, low_data, nulls, empty).
- `tools/device/phone-queue.test.mjs` -- NEW, hermetic, through `main`: the wait line, served by s26 and by s24, `release <id>` while waiting, status listing a Pool waiter once (`request`, `pool`, `positions`) with text and DEPLOY TARGET count, and an `emulator` gate waiter keeping its own queue with no Pool ticket in any slot queue.
- `README.md`, `docs/features.md` -- document the place in line.

**Acceptance Criteria:**
- Given both phones held, when `hub-device lease phone --wait 1m` runs and the S26 frees, then it prints `HUB_LOCK_WAIT phone ... position=<n> eta=...` on stderr, exits 0 with `HUB_DEVICE='s26'`, and no Pool ticket remains in any queue.
- Given the existing suites, when `mise run check` runs, then every one passes and any changed `hub-device.test.mjs` assertion is named in the Auto Run Result.
- Given a waiting Pool request, when `status --json` runs, then it lists it once with `request`, `pool` and `positions: {s24: n, adb: m}`.
- Given the hermetic suite, then it covers a Pool request served by each member, the withdrawal race, a killed waiter pruned by pid and the emulator gate keeping its own queue.

## Spec Change Log

## Review Triage Log

### 2026-11-25 — Review pass
- verdicts: 33 findings — high 0, medium 0, low 22, false 11, maybe-false 0
- findings:
  - `low` `reject` (blind) A request found away is released before its ticket is re-written, so a waiter could take the lock in that gap. — Two back-to-back synchronous fs calls make the window microseconds wide, and the member was just found away, so whoever takes it gets a phone this request could not use. Closing it needs a new `releaseLease` option, more than a direct correction.
  - `low` `patch` (blind) `release` of a killed Pool request's stale tickets writes no `cancel`, so its `request` stays open. — Pruning writes no event, and a killed v1a Pool request never settled either, so the behaviour is not new. The README claimed a cancel is always logged, so it was reworded to say the live waiter writes it and a killed request's release writes none.
  - `low` `reject` (blind) `acquirePool.serve` duplicates `acquireLease`'s take block. — Harm: a later fix to one copy must be mirrored in the other. The spec forbids touching `acquireLease` (the deploy path), and sharing the block would mean refactoring it, which is more than a direct correction for a divergence no one meets in everyday use.
  - `false` `reject` (blind) The `pool-duplicate` branch is unreachable from the CLI. — It is an epics AC for the lock-level Pool request, covered by a lock-level test. `checkLeaseId` stops the CLI from reaching it, which is by design.
  - `low` `reject` (blind) The `vanished` retry budget is shared across members. — Once the budget is spent, a member is read `held` for that pass and tried again at the next poll; nothing is lost.
  - `false` `reject` (blind) The `positions` keys are lock names (`adb`), not device words. — The AC specifies `positions: {<lock>: n}`.
  - `low` `reject` (blind) A pooled row carries its nearest member's `deploy_target`, so a request nearest the s24 reads false. — The spec sets the row's keys from its best member, and `positions` names every lock it waits on. Changing this would add semantics, not correct a mistake.
  - `low` `reject` (blind) A pooled row stays at the array index of the first member walked. — Cosmetic only. `#n` and `positions` are correct.
  - `false` `reject` (blind) The wait line takes holder and position from one member and the ETA from all of them. — The AC says the Pool ETA is the earliest member's, and the spec says the line is printed for the held member with the fewest blockers.
  - `false` `reject` (blind) `earliest()` can produce a range that no single member has, and its `low_data` is pessimistic. — `lo = min lo_i`, `hi = min hi_i` and low_data-if-any are exactly the AC.
  - `false` `reject` (blind) Line 49 of `docs/hub-releases.md` was not updated for the new keys. — That file holds per-release notes, and line 49 describes v1.2.47. The notes for these keys belong to the release, Story 5.10.
  - `false` `reject` (blind) The ticket and event format docs were not updated. — `pool`, `request` and `eta` already exist in ticket format v1, and the `eta` on the `request` event is documented in the v1.2.47 notes.
  - `low` `reject` (blind) The README status paragraph is a long run-on sentence. — Cosmetic. It matches the paragraph's existing style.
  - `false` `reject` (blind) A Pool ticket delays later arrivals on both queues. — That is the place in line the story asks for.
  - `low` `reject` (blind) `takeAnyPhone` and `acquirePool` compute their deadlines separately, so the budget skews. — The two are a few milliseconds apart, and the slice is capped by `min(slice, left)`.
  - `low` `reject` (blind) Tests are missing for: the CLI `--wait 0` not jumping, a multi-member `--match` place, `release --any`, a stale Pool row, deploy-job mixing, and the killed waiter's log. — `--wait 0` is covered at lock level. The other cases run the same `acquirePool`, `releasePhone` and fold code that the suites already cover.
  - `low` `patch` (blind) The try test's title claimed a waiter ahead that it never sets up. — Retitled to what it covers.
  - `low` `patch` (blind) The FIFO test accepted `position=1` or `position=2`. — It now asserts `position=1` on every line.
  - `low` `reject` (edge) Place lost between release and rewrite. — Same root cause as the first blind row; same refutation of impact.
  - `low` `reject` (edge) With a duplicate followed by `accept` ok:false, the kept member's ticket is destroyed. — It is reachable only when the id already holds a member, which `checkLeaseId` refuses at the CLI.
  - `low` `patch` (edge) A stale Pool ticket's release writes no cancel. — Grouped with the second blind row; fixed by the README wording.
  - `low` `reject` (edge) Up to one `HUB_ETA_FAILED` line per member at enqueue. — ETA failures are rare and the extra line is cosmetic; suppressing it would mean a new wrapper.
  - `low` `reject` (edge) The pooled row's `deploy_target` comes from the nearest member. — Grouped with the blind `deploy_target` row.
  - `false` `reject` (edge) The `positions` keys leak a QA phone's lock name to a service caller. — `redact()` nulls only serial, udid and adb_id. Lock names appear on every row, and no secret goes out.
  - `low` `patch` (edge) The README said "the next acquirer prunes both tickets". — Corrected: each phone's next acquirer prunes that phone's ticket.
  - `low` `patch` (edge) The README said `release` of a waiting request always logs one cancel. — Grouped with the second blind row; reworded.
  - `low` `patch` (verification-gap) The Pool `recompute` was never exercised. — Added a fake-clock test with one `afterEta` recompute that asserts the second line's eta is the fresh `earliest()` of both members.
  - `low` `patch` (verification-gap) The fewest-blockers choice for the wait line was not discriminated. — Added a test with a waiter ahead on the s24 only that asserts `position=1` and the adb holder.
  - `low` `patch` (verification-gap) The status fold to the nearest member was not exercised. — Added a status test with the request at s24 #2 and adb #1 that asserts the row is adb/s26/1 with `positions {s24: 2, adb: 1}`.
  - `low` `reject` (verification-gap) There is no multi-member `--match` ticket test. — The committed fleet gives a one-member match, and the Pool path is shared with `phone`, so the fixture would only exercise code already covered.
  - `false` `reject` (intent) `hub-device.test.mjs` was left unchanged although the epics file expects ordering assertions to change. — The AC says "any changed assertion is named". None had to change, because the whole suite passes unchanged.
  - `false` `reject` (intent) Other `statusView` consumers are untested. — The keys are additive on Pool rows only, and non-Pool rows are asserted to keep exactly their keys.
  - `false` `reject` (intent) The real `pause` path is untested for the phone take. — `acquirePool` calls `pause()` with a real-sleep default, and the existing `hub-device.test.mjs` `phone` tests and the real-time `phone-queue` cases run it.

## Design Notes

- Withdraw after `accept` wins, not at the take: a found-away member is given back and its ticket re-written under the same file name, so the request keeps its place on every member and a phone that comes back mid-wait is still picked up, as today's loop did.
- "Later" in `pool-duplicate` is the member this request just took: the other was already held when the take was checked.
- A Pool ticket is an ordinary v1 `kind: lease` ticket, so pinned readers see one more Lease waiter and stay correct; the tomb name never ends in `.json`, so no reader lists it.

## Verification

**Commands:**
- `node --test tools/ci/pool-request.test.mjs tools/ci/eta.test.mjs tools/ci/wait-line.test.mjs tools/device/phone-queue.test.mjs tools/device/hub-device.test.mjs tools/device/lease-match.test.mjs tools/device/status-view.test.mjs tools/device/claims.test.mjs tools/device/emulator.test.mjs` -- expected: all pass.
- `mise run check` -- expected: actionlint clean, full suite green.

## Auto Run Result

Status: done

**Summary.** `hub-device lease|run phone` (and `--match`) now holds a place in line. The one Pool request in `lock.mjs`, `acquirePool`, writes the identical Lease ticket (carrying `pool`, `request` and the combined ETA) into every member's queue. It takes the first member that serves it (the S24 on a tie). A member found away is given back and the ticket is re-written under the same name. The winner withdraws the other tickets by tomb, with no event.
- **Event Log:** one Pool-level `request` (with `eta`), then exactly one `acquire`, `timeout` or `cancel`. A request that already holds a member releases the member it just took with `pool-duplicate`. A cancel or abort withdraws the ticket from every member.
- **Wait line and ETA:** the request prints `HUB_LOCK_WAIT phone held by … position=<n> eta=…` for the held member with the fewest blockers ahead. The ETA is `eta.mjs` `earliest()` of the members' ETAs.
- **`status`:** lists a Pool request once, adding `request`, `pool` and `positions: {<lock>: n}`. The text row gets a `pool phone (s24 #n, adb #m)` suffix, and DEPLOY TARGET counts the request for each deploy target it waits on.
- **Unchanged:** exit codes and messages (BUSY 76, AWAY 75, `HUB_DEVICE_CANCELLED`), `acquireLease`, `withLock`, the emulator gate and the deploy path.

**Files changed**
- `tools/ci/lib/eta.mjs`: pure `earliest(values)`.
- `tools/ci/lib/lock.mjs`: `acquirePool`; an optional `eta` on `poolRequest`; a `recompute` seam in `waitReporter` (default behaviour unchanged); `releaseLease` writes no per-lock `cancel` for a Pool ticket.
- `tools/device/claims.mjs`: `connectPhone` split out of `takePhone`. `takeAnyPhone` now calls `acquirePool`, with `accept` finding the phone and `giveUp` set to `noPhoneError`. `releasePhone` cancels on every member, and `statusView` folds Pool rows.
- `tools/device/hub-device.mjs`: the header comment, the WAITERS Pool suffix and the DEPLOY TARGET count.
- `tools/ci/pool-request.test.mjs` (new, 19 tests): the lock-level Pool request.
- `tools/device/phone-queue.test.mjs` (new, 7 tests): `phone` through `main`, including status and the emulator gate.
- `tools/ci/eta.test.mjs`: the `earliest()` cases.
- `README.md`, `docs/features.md`: document the place in line.

**Review findings.** 33 findings: 22 low and 11 false, none high, medium or maybe-false.
- **Patched (low, 7 rows, 6 entries):** tests for the Pool ETA recompute, the fewest-blockers wait-line choice and the status fold to the nearest member; the FIFO test now asserts the exact position; the try test was retitled; two README sentences were corrected (who writes the `cancel` on release, and pruning is per phone).
- **Deferred:** none.
- **Rejected:** 26 rows; the reason for each is in the Review Triage Log. In short:
  - Spec- or AC-mandated behaviour: lock-name `positions`, `earliest` semantics, the mixed wait line, `pool-duplicate`, and both queues delayed.
  - Microsecond or unreachable races: the release-to-rewrite gap, and duplicate with ok:false.
  - Cosmetic or rare: the shared `vanished` budget, deadline skew, duplicate `HUB_ETA_FAILED` lines, row order, the README run-on.
  - The take block duplicated from `acquireLease`: the spec forbids touching the deploy path.
  - Release notes belong to Story 5.10.

**Changed `hub-device.test.mjs` assertions (FR-13):** none. Every existing `phone` ordering, BUSY/AWAY and Pool-event assertion passes unchanged.

**Follow-up review recommended:** false. This was the first pass, and it patched 0 high and 0 medium entries (6 low entries).

**Verification**
- The spec's targeted `node --test …` list passes: 221 of 221.
- `mise run check` exits 0, with actionlint clean and 918 of 918 tests passing. That run came after the review patches.
- Matrix audit: every I/O row has a passing test:
  - both free, s24 held, and the try rows: `pool-request.test.mjs`
  - both held with s26 freed or s24 freed: `pool-request.test.mjs` and `phone-queue.test.mjs`
  - FIFO behind a single waiter: `pool-request.test.mjs`
  - `--wait 0` BUSY: `hub-device.test.mjs:345`
  - free but away: `pool-request.test.mjs` and the existing `hub-device` AWAY tests
  - the withdraw race (ENOENT seam), cancel (lock level and through `release`), killed waiter (SIGKILL child) and duplicate: `pool-request.test.mjs` and `phone-queue.test.mjs`

**Residual risks**
- A killed Pool waiter leaves its `request` event without an ending, as v1a did. Releasing its stale tickets writes no event.
- The emulator-gate test queues a plain Lease on the gate directly; it does not drive `lease emulator` end to end.
- `acquirePool`'s take block mirrors `acquireLease`'s, so a later fix to one must be copied to the other.
- In the Pool path, an `updateLease` error other than `HUB_LEASE_LOST` now gives the member back before it propagates.
- No operator actions; the release is Story 5.10.
