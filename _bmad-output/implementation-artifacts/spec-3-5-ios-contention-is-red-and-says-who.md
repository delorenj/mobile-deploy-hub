---
title: 'Story 3.5: iOS contention is red, and says who'
type: 'feature'
created: '2026-11-24'
status: done
baseline_revision: 'd1ee6d6ac309dfded5dda884dadfde7e56193303'
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-3-context.md'
warnings: ['oversized']
deferred:
  - summary: >-
      A lock-timeout failure in a lane that records no `contention` (plan's `adb` Peek wait, gate, preflight-ios) still puts the holder-naming `host lock <name> is held by …` message into public copies.
    evidence: |-
      publicReason (tools/ci/lib/receipt.mjs) redacts only when the receipt carries `contention`, which only the android and ios lanes write. This behaviour predates story 3.5: those lanes' raw lock messages already reached the bucket receipts and announce. One level up would be to have every Queued withLock caller record `contention` on its timeout, or to key publicReason on the AD-5 prefix alone.
    location: >-
      tools/ci/lib/receipt.mjs publicReason; tools/ci/commands/plan.mjs:250
    severity: low
operator_actions:
  - "After the orchestrator merges this story branch to main, cut the hub release from a fresh clean clone of main: `mise run release -- 1.2.49`. The `## v1.2.49` section of docs/hub-releases.md is already written."
  - "Run `mise run hosts:install` from a clean checkout at tag v1.2.49 on big-chungus and on the Mac. Then check that both hosts' `current` is v1.2.49 and that the catch-up candybars still fire."
---

<intent-contract>

## Intent

**Problem:** When the `ios` job's wait for `mac-ios` runs out, it fails with a bare lock message. Nothing records the `contention` the way Android does, the timeout event says `deadline`, and a store-IPA take that times out after a verified iPad install marks the iPad `failed` (stage `build`).

**Approach:** One level up (belsky-doctrine, AD-22): one `macLane` helper in `ios.mjs` wraps both `mac-ios` takes. It passes `timeoutReason: 'ios-lane-contention'` and records the shared `contention {lock, reason, blocked_by}` record built from `holdsOf`. It rethrows `HUB_LOCK_TIMEOUT`, so the job goes red. A store-take timeout is reported at stage `deliver` with a failed `store` record. `receipt.mjs` gets one `publicReason(receipt)`. With it, any lane whose failure was a device wait shows only the coarse `<lock> busy` wording in the bucket copy and in announce. Holder names stay in the receipt, the summary, the log and the Event Log.

## Boundaries & Constraints

**Always:**
- The lock writes the one `timeout` event (via `withLock`'s `timeoutReason`). The lane writes no second event.
- Only a wait that runs out *before* the hold is contention (`entered` guard, as in `android.mjs:114-163`). Any error raised inside a hold, and `HUB_LEASE_CANCELLED`, fail exactly as before.
- The rethrown error keeps `code: 'HUB_LOCK_TIMEOUT'` and its message (which already names the holder and the waiters ahead, `heldText` in `lock.mjs:795`).
- Node 24 ESM. Tests are hermetic, with a temp lock dir and a temp event dir.

**Never:** No change to `lock.mjs`, `policy.json`, the deadline, `latest.json` key lists or the catch-up. No iOS `pending` on contention (FR-30 does not apply to iOS in v1). No holder name in `store.reason`, `delivery.reason`, the bucket receipts or the Bloodbank event. No Reservation release on an iOS timeout: a failed lane keeps it (Story 2.6).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| first take busy | `mac-ios` held by a Lease `agent-a`, plus a ticket ahead; the wait runs out | job rejects with `HUB_LOCK_TIMEOUT`. The receipt has `outcome: failure`, `stage: preflight`, a `contention` record with the holder then the one ahead, and a `reason` naming both. The summary lists them. There is one `timeout` event with `reason: ios-lane-contention`. The log has `HUB_IOS_LANE_BUSY device code=HUB_LOCK_TIMEOUT`. The Reservation is kept | rethrown |
| store take busy after iPad installed | the delivery is `installed` and verified, and the second take times out | the receipt has `stage: deliver`, `store.status: failed` with a coarse reason, and `contention`. `deviceOf` gives `installed`. Announce gives delivery `installed` and failure stage `deliver` with the coarse reason | rethrown |
| public copies | either receipt above | `publicReceipts` has no `contention`, and its `reason` is `mac-ios busy: …`. No holder text in the announce event | — |
| error inside a hold | the hook or build throws | the failure is unchanged, and the receipt has no `contention` | rethrown |

</intent-contract>

## Code Map

- `tools/ci/commands/ios.mjs:276-347` -- first `mac-ios` take (device build/install). Wrap it in `macLane`, and set `track.stage = 'preflight'` before the wait.
- `tools/ci/commands/ios.mjs:388-400` -- second take (`buildStoreIpa`) and the inline `store` record. Extract `storeRecord(...)` and move the take into exported `storeTake(...)` so the test drives the exact code `ios()` runs.
- `tools/ci/commands/ios.mjs:226` -- `ios()` options. Add the `lockOptions = {}` seam (the same as `android()` at `android.mjs:237`).
- `tools/ci/commands/android.mjs:112-173` -- the reference pattern (`entered`, `error.holds ?? holdsOf(error.owner)`).
- `tools/ci/lib/lock.mjs:337` `holdsOf`, `:1004-1009` `timedOut` (event plus error `owner`/`holds`) -- read-only reuse.
- `tools/ci/lib/receipt.mjs:65-83` -- `summaryMarkdown` already prints `contention` and `reason` (no change). Add `publicReason`.
- `tools/ci/lib/latest.mjs:21` `busyReason` -- the one busy wording.
- `tools/ci/commands/common.mjs:73-83` `guarded` -- the failure receipt spreads `track.receipt` (`contention`, `store`, `delivery`, `ipa`) and `track.stage`.
- `tools/ci/commands/deliver.mjs:42-49` `deviceOf` (stage `deliver` ⇒ the delivery stands), `:308-313` `publicReceipts`.
- `tools/ci/lib/announce.mjs:68-86,124` -- `failureOf`, `laterStepFailure`, and the lane fallback read `receipt.reason`. Route them through `publicReason`.
- `tools/ci/ios-token.test.mjs:126-136` `dryFixture` -- a real `ios()` dry run with temp lock/event dirs (the first take fits it).
- `tools/ci/deadline.test.mjs:29` -- already pins that the ios allowance covers both takes (Story 2.4). No change.

## Tasks & Acceptance

**Execution:**
- [x] `tools/ci/lib/receipt.mjs` -- add `publicReason(receipt)`. When `receipt.contention.lock` is set and `receipt.reason` starts with `host lock <lock> is held`, return `` `${busyReason(lock)}: the wait for it ran out (HUB_LOCK_TIMEOUT); the run summary names who held it` ``. Otherwise return `receipt.reason`. -- one public wording for every lane.
- [x] `tools/ci/commands/ios.mjs` -- add `macLane`, `storeRecord` and `storeTake`, use them for both takes, and add the `lockOptions` seam. -- AD-22.
- [x] `tools/ci/commands/deliver.mjs` -- `publicReceipts` also replaces `reason` with `publicReason`. -- keeps holder names off the bucket.
- [x] `tools/ci/lib/announce.mjs` -- use `publicReason` wherever a lane receipt's `reason` becomes an event reason. -- keeps them off Bloodbank.
- [x] `tools/ci/ios-contention.test.mjs` (new) -- cover the matrix rows: a real `ios()` for the first take, `storeTake` under `guarded` for the second, then `deviceOf`, `publicReceipts`, `deliveriesFrom`, `summaryMarkdown` and the events.
- [x] `README.md` (lanes table `ios` row, Reservation paragraph) and `docs/hub-releases.md` (new `## v1.2.49` section) -- document it.

**Acceptance Criteria:**
- Given `ios.mjs` is waiting on `mac-ios` before the build, when `HUB_LOCK_TIMEOUT` is thrown, then the job fails with that code, the job summary names the holder and the waiters ahead, and the Mac's Event Log has exactly one `timeout` event with `reason: ios-lane-contention`.
- Given the store-IPA take times out after the iPad install succeeded, when deliver and announce read the receipt, then the iPad stays `installed` and only the store step (stage `deliver`) reports the contention.
- Given either take times out, when the receipt is written, then it carries `contention {lock: 'mac-ios', reason: 'ios-lane-contention', blocked_by}` built with `holdsOf`, the same shape as Android's.
- Given the job's deadline, when it is computed, then the `ios` allowance covers both takes (already true: `deadline.test.mjs:29`).
- Given the story is on main, when it ships, then it ships as a hub release (an operator action after the orchestrator merges).

## Spec Change Log

## Review Triage Log

### 2026-11-24 — Review pass
- verdicts: 23 findings — high 0, medium 2, low 9, false 12, maybe-false 0
- findings:
  - `[false]` `[reject]` (blind) `publicReason` depends on the lock's message wording, and a free lock with only a queued waiter ahead might word it differently. Refuted: both timeout paths build the message with `heldText`, which always starts `host lock <name> is held by` (`lock.mjs:795-798`). That prefix is the AD-5 contract, and older catch-ups parse it too.
  - `[false]` `[reject]` (blind) The store-take reason "the iPad's delivery stands" is wrong when the iPad was pending, skipped or in a dry run. Refuted: stage `deliver` makes `deviceOf` and announce keep whatever status the delivery recorded (`deliver.mjs:44-45`), so the delivery does stand in every case.
  - `[low]` `[reject]` (blind) The `storeTake` call site inside `ios()` is not run by any test. It is a one-line call to the tested `storeTake`. Covering it needs a full fake of the Apple toolchain and the iPad (inspectIpa, devicectl), which is far more than a direct fix, and the call site is easy to read.
  - `[medium]` `[patch]` (blind) `publicReason` is not applied at every reader of `receipt.reason`. This shares a root cause with the verification-gap finding below (`completion.mjs` `testflightOf`). The other readers named (pages, `latest.json`) go through `deviceOf`, which is already routed. Patched with the gap finding.
  - `[low]` `[reject]` (blind) `lockOptions` can override `timeoutReason` and `endsReservation`. It is a test-only seam, the same shape as `android()`'s `lockOptions`. No production caller passes it.
  - `[false]` `[reject]` (blind) `holdsOf` fallback, a throwing `onBusy` and a missing `::error::` annotation. Refuted: every `HUB_LOCK_TIMEOUT` carries `holds` (`lock.mjs:262,1005`), and `holdsOf` never throws. `onBusy` calls only `storeRecord`, whose `testflightPolicyOf` handles an unknown app (`policy.mjs:337`). `hub.mjs:46` prints `::error::` with the message.
  - `[low]` `[reject]` (blind) The test fixture writes the manifest twice, test 3's title overclaims, and the 150 ms waits might flake. These are cosmetic. Each wait is meant to time out, so it cannot flake into success.
  - `[low]` `[reject]` (blind) The README paragraph is long, `features.md` and the design doc are untouched, and there are new imports between modules. These are cosmetic. The import graph has no cycle: `latest.mjs` has no imports, and `receipt.mjs` imports only `policy` and `latest`.
  - `[false]` `[reject]` (edge) `HUB_LEASE_CANCELLED` or a yield leaves no contention record. Refuted: by design (Boundaries: cancelled fails as before). `ios.mjs` passes no `yieldToLease`, and the cancelled message names no holder.
  - `[low]` `[defer]` (edge) A lock timeout in a lane that records no `contention` (plan's `adb` Peek, gate) still leaks holder text to public copies. This predates the story; it is in the frontmatter `deferred`.
  - `[false]` `[reject]` (edge) A store-take `onBusy` sets stage `deliver` even when the iPad is not installed. Same refutation as the second blind finding: the delivery's own status is kept.
  - `[false]` `[reject]` (edge) `onBusy` could throw from `storeRecord` on a missing policy entry. Refuted: `testflightPolicyOf(undefined)` returns the defaults.
  - `[false]` `[reject]` (edge) A `::error::`-prefixed reason defeats the prefix check. Refuted: `guarded` strips `^::error::` before it writes `reason` (`common.mjs:79`).
  - `[false]` `[reject]` (edge) A null `reason` in `publicReceipts` drops the key. Refuted: `publicReason` returns `receipt.reason` (null), so the key stays null.
  - `[low]` `[patch]` (edge) The v1.2.49 notes overclaim that `publicReason` covers "a lane's device-wait failure". Reworded to say it applies to the reason of a lane receipt that recorded `contention` for the wait that failed it.
  - `[false]` `[reject]` (edge) Forcing stage `preflight` before the first take discards `build`. Refuted: this is by design (Matrix row 1). The wait for the lane is preflight, as Android's is.
  - `[medium]` `[patch]` (verification-gap) `testflightOf` (`completion.mjs:55,62`) read the raw `ios.reason`, so a TestFlight run whose first take timed out put holder names in the Bloodbank TestFlight delivery. Both reads now go through `publicReason`, and the first-take test asserts that `testflightOf` and `testflightDelivery` carry no `agent-a` or `agent-b`.
  - `[low]` `[patch]` (verification-gap) The store-take test did not assert the timeout event's reason. It now asserts `reason: ios-lane-contention`.
  - `[low]` `[reject]` (intent) The store take is tested through `storeTake`, not through `ios()`. This duplicates the third blind finding.
  - `[false]` `[reject]` (intent) The deadline AC has no test in the diff. Refuted: `deadline.test.mjs:29` already pins that the ios allowance covers both takes, and it ran green in `mise run check`.
  - `[low]` `[reject]` (intent) The release AC is not in the diff. It can only happen after the orchestrator merges the branch, so it is recorded under `operator_actions` with the notes section already written.
  - `[false]` `[reject]` (intent) Nothing makes the AD-22 revisit trigger countable. Refuted: every timeout writes one event with `reason: ios-lane-contention` to the Mac's Event Log, and the trigger is a count over those. No AC asks for a counter.
  - `[false]` `[reject]` (intent) The real-Mac path is not exercised. Refuted as a defect: tests are hermetic by repo policy, and the event is written by the same `lock.mjs` code on whichever host runs the lane.

## Design Notes

`publicReason` keys on the AD-5 message prefix (`host lock <name> is held`). Without that check, a lane that recorded `contention` and then failed for another reason would also lose its real reason. The `store` record on a timeout is `storeRecord(...)` with `status: 'failed'`, `build: config.iosBuild || null`, and `reason: 'mac-ios busy: the App Store IPA was not built; the iPad's delivery stands'`.

## Verification

**Commands:**
- `node --test tools/ci/ios-contention.test.mjs tools/ci/ios-token.test.mjs tools/ci/v113.test.mjs tools/ci/v3.test.mjs` -- expected: all pass.
- `mise run check` -- expected: actionlint and the full suite are green.

## Auto Run Result

Status: awaiting-operator

**Summary.** When the `ios` job's wait for `mac-ios` runs out, the job now goes red and names who held the Mac (AD-22).
- Both `mac-ios` takes go through one `macLane` helper. A wait that runs out before the hold rethrows `HUB_LOCK_TIMEOUT` and records the receipt's `contention {lock: 'mac-ios', reason: 'ios-lane-contention', blocked_by}`. `blocked_by` comes from `holdsOf` and has the same shape as Android's.
- The lock writes the one `timeout` event (`reason: ios-lane-contention`). The log says `HUB_IOS_LANE_BUSY <device|store> code=HUB_LOCK_TIMEOUT`, and the job summary lists the holder and the waiters ahead.
- When the store-IPA take times out, the failure is at stage `deliver` with a failed `store` record. The iPad delivery stays `installed`.
- One level up (belsky-doctrine): `publicReason(receipt)` gives every lane that records contention one coarse public wording, `<lock> busy: …`. The bucket receipts, `latest.json`'s failed reason, the Bloodbank event and its TestFlight delivery all use it. Holder names stay in the receipt, the summary, the log and the Event Log.

**Files changed**
- `tools/ci/commands/ios.mjs` -- `macLane`, `storeRecord` and `storeTake`, used by both takes, plus the `lockOptions` seam.
- `tools/ci/lib/receipt.mjs` -- `publicReason`.
- `tools/ci/commands/deliver.mjs` -- `deviceOf` and `publicReceipts` use `publicReason`.
- `tools/ci/lib/announce.mjs` -- failure reasons go through `publicReason`.
- `tools/ci/lib/completion.mjs` -- `testflightOf` goes through `publicReason` (a review patch).
- `tools/ci/ios-contention.test.mjs` -- new. Covers the first take through a real `ios()`, the store take under `guarded`, an error inside a hold, and `storeRecord`.
- `README.md` -- the `ios` row of the lanes table and the Reservation paragraph.
- `docs/hub-releases.md` -- a new `## v1.2.49` section.

**Review findings.** 23 in total.
- Patched: 3 entries. One medium group (`testflightOf` leaked holder names, found by the blind and gap reviewers) and two lows (the docs overclaim, and the timeout-reason assertion).
- Deferred: 1 low, the pre-existing leak for lanes that record no contention.
- Rejected: 19. The 12 false findings and 7 low rejects are recorded with their reasons in the Review Triage Log above.
- Follow-up review recommended: false. One medium entry and no high entry were patched (patched by verdict: high 0, medium 1, low 2).

**Verification**
- `node --test tools/ci/ios-contention.test.mjs tools/ci/ios-token.test.mjs tools/ci/v113.test.mjs tools/ci/v3.test.mjs tools/ci/completion.test.mjs`: 138/138 pass.
- `mise run check`: exit 0, actionlint plus 712/712 tests pass, after the patches.
- Matrix audit: rows 1 and 3 are covered by the first-take test, rows 2 and 3 by the store-take test, and row 4 by the error-inside-a-hold test. All of them ran and passed.

**Residual risks**
- The `storeTake` call site inside `ios()` runs in no test, though `storeTake` itself is tested.
- Lanes that record no contention can still leak lock-holder text to public copies. This is deferred and predates the story.
- The change reaches the apps only after the hub release and the install on both hosts (`operator_actions`).

## Operator Confirmation

Confirmed 2026-11-24: the external actions this story owed were carried out.

- After the orchestrator merges this story branch to main, cut the hub release from a fresh clean clone of main: `mise run release -- 1.2.49`. The `## v1.2.49` section of docs/hub-releases.md is already written.
- Run `mise run hosts:install` from a clean checkout at tag v1.2.49 on big-chungus and on the Mac. Then check that both hosts' `current` is v1.2.49 and that the catch-up candybars still fire.

_Appended by the bmad-loop orchestrator (`bmad-loop confirm`, #335): a human confirmed these external actions out of band, and the story was advanced from `awaiting-operator` to `done`._
