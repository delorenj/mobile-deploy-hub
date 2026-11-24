---
title: 'Story 3.2: A blocked Android delivery goes pending'
type: 'feature'
created: '2026-11-24'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: false
baseline_revision: 'b9e8179fa18db3f4c9410abceeec2e4072619ea8'
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-3-context.md'
warnings: ['oversized']
deferred: []
---

<intent-contract>

## Intent

**Problem:** When the android lane's wait for `adb` (the S26) runs out, `withLock` throws `HUB_LOCK_TIMEOUT`, the lane fails and the whole Android half goes red: no Play upload, no Release, a `failed` device in `latest.json`, and the run's Reservation of `adb` is left to grace and the ceiling. A long Lease turns a good build red (FR-30, AD-14).

**Approach:** One level up (belsky-doctrine): any Queued `withLock` caller can say what its timeout means (`timeoutReason`, written on the `timeout` event) and gets the blocking Holds on the `HUB_LOCK_TIMEOUT` error (`owner`, `holds`), so story 3.5 (iOS) and any later device lane reuse it. `latest.mjs` owns the one public busy wording (`busyReason(name)` → `S26 busy`, `isBusyPending(device)` for story 3.3). The android lane catches a lock-wait timeout on `adb` only, marks the delivery `pending` with reason `S26 busy`, records the Holds in the receipt's `contention` block (never in public copies), releases the run's Reservation, and finishes green.

## Boundaries & Constraints

**Always:** Node 24 ESM `.mjs`, `node:` builtins only. Tests hermetic (temp `HUB_LOCK_DIR`/`HUB_EVENT_DIR`, the `laneHost` fake adb, no bucket or host state). Only `lock.mjs` appends events. `latest.json` keeps the frozen status enum and its exact key set: `device.reason` is the only field that carries the busy state, and it is coarse (`S26 busy`, plus the existing `catchupNote` suffix when the catch-up is off). Holder identity goes only to the lane's own receipt (`contention`), the step summary, logs and the Event Log. The catch covers only a `HUB_LOCK_TIMEOUT` thrown by the `adb` wait itself, never an error raised inside the held function.

**Never:** No change to `validateLatest`/`validateDevice` key lists, to `statuses`, or to the catch-up (`tools/catchup/`, that is story 3.3). No new policy keys. No change to iOS (`ios.mjs`, story 3.5). No `contention` (or holder name) in `notes`, `delivery.reason`, the bucket's `receipt*.json`, `latest.json`, pages or the Bloodbank event. No second lock or queue. `HUB_LEASE_CANCELLED` and every other error keep failing the lane.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Busy S26, real run | run reserved `adb`; another deploy's Job Hold (or a Lease) holds `adb` past the lane's wait | lane resolves; `delivery {status:'pending', verified:false, reason:'S26 busy'}`; receipt `outcome:'success'` and `contention {lock:'adb', reason:'delivery-pending', blocked_by:[{role:'holder',…}, …]}`; run's events: claim, request, timeout(`reason:'delivery-pending'`, `blocked_by`), release (hold_kind reservation); no Reservation left; no adb call | none: green |
| Busy S26 with waiters ahead | a Lease holds `adb` and another ticket sits ahead of the lane | `blocked_by` lists the holder then each blocker ahead (`role:'ahead'`, `place`, `kind`, `holder`) | none |
| Busy S26, dry run | same, `--dry-run true` | same pending `S26 busy` delivery and receipt; nothing installed | none |
| Error inside the hold | lane holds `adb`, then the S26 has a newer versionCode | fails as today (`above the planned`), Reservation kept | rethrown |
| Ticket released mid-wait | `releaseLease` removed the lane's ticket | `HUB_LEASE_CANCELLED`, lane fails as today | rethrown |
| deliver / announce | the pending receipt above | `latest.json` android `device {status:'pending', reason:'S26 busy', by:null}` parses with `parseLatest`; the bucket `receipt-android.json` has no `contention`; announce's delivery is `pending` with reason `S26 busy` | none |

</intent-contract>

## Code Map

- `tools/ci/lib/lock.mjs:61-65` -- `describe(owner)`, the existing holder wording (Lease: `lease <id> of <holder> … until <expires_at>`; job: `<repo> run <run> (pid …)`).
- `tools/ci/lib/lock.mjs:189-245` -- `withLock`. Add option `timeoutReason = 'deadline'` (validate `/^[a-z][a-z0-9-]{0,39}$/`, else throw `bad timeout reason`), pass it to `queuedLock`. The bare path's timeout (line 240) attaches `owner` and `holds` too.
- `tools/ci/lib/lock.mjs:311` -- `failure(code, message)`. Add exported `holdsOf(owner, blockers = [])`: `[{role:'holder', kind, holder, lease_id, why, since, until}]` for a non-null owner (kind `lease`, else `owner.kind ?? 'job'`; holder = the Lease's `holder`, else `<repo>#<run>`; since `started_at`, until `expires_at ?? null`), then one `{role:'ahead', place, kind, holder, lease_id, why, since: enqueued_at ?? reserved_at, until: expires_at ?? deadline_at ?? null}` per blocker. Plain data, never throws.
- `tools/ci/lib/lock.mjs:832-961` -- `queuedLock`. `timedOut(message, owner)` (868-872) becomes `timedOut(message, owner, blockers = [])`: the `leave('timeout', …)` uses `reason: timeoutReason`; the returned `HUB_LOCK_TIMEOUT` error gets `.owner` and `.holds = holdsOf(owner, blockers)` (try-only too). Call sites 938 (no blockers) and 946 (pass `blockers`).
- `tools/ci/lib/lock.mjs:600-608` -- `releaseReservation(name, {env, reason})`: reused by the lane, with `reason: 'delivery-pending'`.
- `tools/ci/lib/latest.mjs:18` -- beside `statuses`, add `busyReason = name => \`${name} busy\`` and `isBusyPending(device)` (status `pending` and reason equal to `busyReason(device.name)` or starting with it plus `; `). No validator change.
- `tools/ci/commands/android.mjs:107-156` -- the S26 step. Add an `android(config, { …, lockOptions = {} })` dep threaded to `androidLane`, spread last into the `adb` `withLock` options; pass `timeoutReason: 'delivery-pending'`. Set `entered = true` first thing in the held fn; catch around `withLock` only `!entered && error.code === 'HUB_LOCK_TIMEOUT'`: delivery `pending`/`busyReason(devices.android.name)`, `track.receipt.contention = { lock: 'adb', reason: 'delivery-pending', blocked_by: error.holds ?? holdsOf(error.owner) }`, a holder-free note, `log('HUB_S26_BUSY …')` with the error message, then `releaseReservation('adb', { env, reason: 'delivery-pending' })` (log `HUB_RESERVATION_RELEASED adb <key>` when released). Line 181's `buildReceipt` gets `contention` when set.
- `tools/ci/commands/deliver.mjs:42-49,308-312` -- `deviceOf` already maps the receipt's pending delivery and reason (no change). `publicReceipts` also drops each receipt's `contention`.
- `tools/ci/lib/receipt.mjs:66-79` -- `summaryMarkdown`: when `receipt.contention`, add `- contention on <lock> (<reason>): <role> <kind> <holder>[ until <until>]; …`.
- `tools/ci/lib/pages.mjs:35` -- a pending line whose device `isBusyPending` reads `installs when it is free` instead of `installs when it is back`.
- `tools/ci/lib/announce.mjs:119-121` -- read-only: copies only `from.reason` (sanitized), so announce shows `S26 busy` and nothing of `contention`.
- `tools/ci/v3.test.mjs:731-789` -- `fakeAdb`, `laneHost`; `1090-1107` -- `holdS26`, `otherJob`, `planEvents`; `889-917` -- the whole-run event-sequence test (must stay green, unchanged); `1150-1165` -- the away-pending Reservation test, the template.
- `tools/ci/reservation.test.mjs` -- the queued `withLock` tests with fake `sleep`/`now`, the pattern for a lock-level `timeoutReason`/`holds` test.
- `tools/ci/latest.test.mjs`, `tools/ci/v11.test.mjs` (deliver/announce/pages tests; grep `publicReceipts`, `deviceLine`, `deviceOf`) -- where the public-data assertions go.

## Tasks & Acceptance

**Execution:**
- `tools/ci/lib/lock.mjs` -- `timeoutReason` option, `holdsOf`, `owner`/`holds` on every `HUB_LOCK_TIMEOUT` from `withLock` -- one generic way for any device lane to turn a timed-out wait into a named, reasoned outcome
- `tools/ci/lib/latest.mjs` -- `busyReason`, `isBusyPending` -- the one public busy wording that 3.3's catch-up and the pages key on
- `tools/ci/commands/android.mjs` -- the `lockOptions` dep and the busy-to-pending catch with the Reservation release -- FR-30 / AD-14
- `tools/ci/commands/deliver.mjs` -- `publicReceipts` drops `contention` -- holder identity stays off the bucket
- `tools/ci/lib/receipt.mjs` -- `summaryMarkdown` renders `contention` -- the run summary names the blocking Holds
- `tools/ci/lib/pages.mjs` -- busy wording on the pending line -- the page does not claim the phone is away
- `tools/ci/v3.test.mjs` -- end-to-end lane tests with `lockOptions: { timeoutMs: 150, pollMs: 20 }`: (a) a Job Hold of another deploy plus the run's Reservation → the pinned run event sequence `claim, request, timeout(delivery-pending), release(reservation)` with `blocked_by` naming `delorenj/other run 1`, the receipt `outcome:'success'`, `delivery.reason:'S26 busy'`, `contention.blocked_by[0]` the holder, no adb call, no Reservation left; (b) a Lease holder with another ticket ahead → `blocked_by` holder `agent-a` then an `ahead` entry; (c) then `release()` still publishes (the Play and Release steps proceed: the receipt test asserts this intended change) and `deliver`'s `deviceOf` + `mergeLatest` give a block that `parseLatest` accepts with `device.reason` `S26 busy`; (d) an error inside the hold (newer versionCode) still rejects -- the matrix rows
- `tools/ci/reservation.test.mjs` -- lock-level: a queued wait with `timeoutReason: 'delivery-pending'` writes `timeout` with that reason and `blocked_by`, its error has `owner` and `holds` (holder plus one ahead entry); without the option the reason stays `deadline` -- the generic option
- `tools/ci/latest.test.mjs` (or `v11.test.mjs` where `publicReceipts`/`deviceLine` are tested) -- `busyReason('S26') === 'S26 busy'`, `isBusyPending` true for `S26 busy` and `S26 busy; catch-up off …`, false for the away reason; `publicReceipts` drops `contention`; `deviceLine` busy wording; `summaryMarkdown` lists the holder -- public data stays coarse

**Acceptance Criteria:**
- Given `android.mjs` waiting on `adb`, when `HUB_LOCK_TIMEOUT` is thrown by that wait, then the lane resolves with a `pending` delivery whose reason is `S26 busy`, the receipt's `contention.blocked_by` names the blocking Holds, a `timeout` event with `reason: 'delivery-pending'` and `blocked_by` is appended, and the run's Reservation is released.
- Given a contention-pending Android build, when the run continues, then the `android` command resolves (so the workflow's later Play and Release steps, which follow a successful android step, run), its receipt is `outcome: 'success'`, and the `release` command run on that output publishes; a receipt test asserts this as an intended change.
- Given the `latest.json` that deliver builds from that receipt, when `parseLatest` reads it, then it accepts it: status `pending`, reason `S26 busy`, no extra keys.
- Given the hermetic suite, when `mise run check` runs, then it passes, including the pinned pending-delivery sequence `claim, request, timeout(delivery-pending), release` and the unchanged whole-run sequence test.

## Spec Change Log

## Review Triage Log

### 2026-11-24 — Review pass
- verdicts: 16 findings — high 0, medium 0, low 10, false 6, maybe-false 0
- findings:
  - `[low]` `[reject]` (blind) Holder names reach the job log and the step summary, which are public for a public repo. AD-14 sends holder identity to receipts and logs and keeps it off the bucket. Every `HUB_LOCK_TIMEOUT` message already named the holder in the log before this change.
  - `[low]` `[patch]` (blind) The `HUB_S26_BUSY` log carried the timeout's advice "run again when it finishes" on a run that now goes green. Fixed: the trailing sentence is stripped and the line says the catch-up installs the build.
  - `[false]` `[reject]` (blind) `releaseReservation` is unguarded in the catch and could turn the lane red. It never throws: its body is wrapped in try/catch and returns `{status:'none'}` (`lock.mjs:600-608`).
  - `[low]` `[reject]` (blind) `error.holds ?? holdsOf(error.owner)` is a dead fallback, and `holdsOf` swallows errors. Both `withLock` throw sites attach `holds`, so no caller reaches the fallback, and the catch only guards plain property reads. There is no named harm.
  - `[low]` `[reject]` (blind) `isBusyPending` matches the `; catch-up off` suffix that `catchupNote` writes in another module. The separator is verified at `commands/common.mjs:175`. If it ever changed, only the page wording would fall back to "when it is back".
  - `[low]` `[patch]` (blind) The failure-receipt assertion was tautological. Fixed: the test now reads the receipt unconditionally and asserts `outcome: 'failure'` and no `contention`. The other half of this finding, the mid-file imports and the one-use helper, is cosmetic and rejected.
  - `[low]` `[patch]` (blind) The operating docs described only an away S26 as pending. Fixed: README now covers `S26 busy` in three places: the deploy summary, the Reservation "who releases when" paragraph, and the `android` job row.
  - `[false]` `[reject]` (blind) The 20-min `adb` wait is hard-coded, and a dry run waits it too. Both are pre-existing and unchanged. The AD-12 job deadline already caps the wait under `timeout-minutes` (`queuedLock`, `lock.mjs:843-845`).
  - `[false]` `[reject]` (blind) iOS has the same gap. Epic 3 and AD-14 make iOS contention a red job in v1a (Story 3.5). The generic `timeoutReason` and `holds` are ready for it.
  - `[low]` `[reject]` (edge) A holder string with a newline or markdown could inject lines into the step summary. Holders are agent names set by `hub-device`, so this is unlikely, and the fix adds a sanitizing guard.
  - `[low]` `[reject]` (edge) `...lockOptions` spread last can override `endsReservation` and `timeoutReason`. It is a test-only seam: the CLI (`hub.mjs`) never passes it.
  - `[low]` `[reject]` (edge) The catch's `releaseReservation` ignores a clock or host id injected through `lockOptions`. This is the same test-only seam. Production uses the real clock in both places.
  - `[low]` `[reject]` (edge) The raw `hub-receipt-android.json` on a public `devicePublic` repo's Release carries `contention`. This exposure is accepted in Design Notes: AD-14 names the bucket, and a fix needs a sanitized copy written for the Release.
  - `[false]` `[reject]` (intent) The tests do not exercise the workflow surface. The Play and Release steps are later steps of the android job with the default `success()` gate (`mobile-deploy.yml`, android job). The `android` command resolving is the step succeeding, and the test runs `release` on its output.
  - `[false]` `[reject]` (intent) The one-level-up is only half carried, because iOS gets nothing. This is the same refutation as the blind-hunter iOS row: v1a makes iOS contention red by design (Story 3.5).
  - `[false]` `[reject]` (intent) Other block paths, such as `HUB_LEASE_CANCELLED`, are excluded. AD-14 and the story's AC name `HUB_LOCK_TIMEOUT` on `adb` only, and a cancelled ticket is not a busy device.

## Design Notes

The `timeout` event is written by `lock.mjs` (only it appends events), so the lane cannot add a second one: the reason travels in as `timeoutReason` and the event comes out once, already saying `delivery-pending`. The default `deadline` keeps every other wait's event unchanged.

`contention` is a top-level receipt block, not a `delivery` field and not a note, because `notes` and `delivery` are copied to the public bucket and to announce. `publicReceipts` drops it in one place. The GitHub Release asset `hub-receipt-android.json` is the raw lane receipt; it rides only a private repo's Release, or a public one whose policy already publishes the device edition (`access.devicePublic`). That residual exposure is accepted and noted, since AD-14 names the bucket.

`isBusyPending` accepts the `catchupNote` suffix (`S26 busy; catch-up off on …`) because deliver appends it to a pending reason when the host's catch-up is off.

## Verification

**Commands:**
- `node --test tools/ci/v3.test.mjs tools/ci/reservation.test.mjs tools/ci/latest.test.mjs tools/ci/v11.test.mjs` -- expected: all pass
- `mise run check` -- expected: actionlint and the full suite are green

## Auto Run Result

Status: done

**Summary.** When the android lane's wait for `adb` (the S26) runs out, the lane no longer fails. The delivery goes `pending` with the public reason `S26 busy`, the receipt stays `outcome: 'success'`, and the run goes green, so the Play upload and the Release proceed. The blocking Holds go only to the lane's receipt as a `contention` block (the bucket copy drops it), the step summary, the log, and the Event Log. In the Event Log, `lock.mjs` writes the one `timeout` event with `reason: 'delivery-pending'` and `blocked_by`. Then the lane releases the run's Reservation. The run's pinned sequence is claim, request, timeout(delivery-pending), Reservation release. An error raised inside the hold, or a cancelled ticket, still fails the lane.

One level up (belsky-doctrine): any Queued `withLock` caller can now name what its timeout means (`timeoutReason`), and every `HUB_LOCK_TIMEOUT` carries `owner` and `holds` (`holdsOf`: the holder, then each blocker ahead). `latest.mjs` owns the one public busy wording (`busyReason`, `isBusyPending`). Story 3.3's catch-up and Story 3.5's iOS lane reuse these without new plumbing.

**Files changed**
- `tools/ci/lib/lock.mjs`: adds the `timeoutReason` option and `holdsOf`. Every `HUB_LOCK_TIMEOUT` from `withLock` now carries `owner` and `holds`.
- `tools/ci/lib/latest.mjs`: adds `busyReason` and `isBusyPending`. The validators are unchanged.
- `tools/ci/commands/android.mjs`: the `lockOptions` test seam, and the busy-to-pending catch, limited to the wait itself. It writes the `contention` receipt block, logs `HUB_S26_BUSY`, and releases the Reservation.
- `tools/ci/commands/deliver.mjs`: `publicReceipts` drops `contention`.
- `tools/ci/lib/receipt.mjs`: `summaryMarkdown` names the Holds.
- `tools/ci/lib/pages.mjs`: a busy-pending device reads "installs when it is free".
- `README.md`: documents `S26 busy` pending, its Reservation release and where the Holds go.
- Tests:
  - `tools/ci/v3.test.mjs`: three end-to-end lane tests:
    - green run sequence, receipt, Release, `latest.json` and announce;
    - Lease plus a waiter ahead, as a dry run;
    - an error inside the hold, and a cancelled ticket.
  - `tools/ci/reservation.test.mjs`: `timeoutReason` and `holds`.
  - `tools/ci/latest.test.mjs`: busy wording and the frozen contract.
  - `tools/ci/v113.test.mjs`: public copies, the summary and the page line.

**Review findings.** 16 findings: 10 low and 6 false (no high, medium or maybe-false).
- Patched: 3 low. They fixed the stale "run again" advice in the busy log, the tautological failure-receipt assertion, and the README coverage.
- Deferred: none.
- Rejected: 13. Each one has its reason in the Review Triage Log.
  - The false ones: the unguarded release (it never throws); the hard-coded wait (pre-existing and capped by AD-12); iOS (red by design in v1a); the workflow surface (later steps follow a successful android step); and other block paths (AD-14 names `HUB_LOCK_TIMEOUT` only).
  - The rejected low ones: holder text in the log and summary (by design); the dead fallback; the separator coupling; markdown injection; the test-only `lockOptions` seam (two findings); and the Release-asset exposure (accepted in Design Notes).
- Patched counts by verdict: high 0, medium 0, low 3.

**Follow-up review: false.** No high was patched, and no medium was patched at all, so no unverified risk is left to name.

**Verification**
- `node --test tools/ci/v3.test.mjs tools/ci/reservation.test.mjs tools/ci/latest.test.mjs tools/ci/v11.test.mjs tools/ci/v113.test.mjs`: 169 of 169 tests pass.
- `mise run check`: actionlint, then 642 of 642 tests pass. It ran twice, once after implementation and again after the review patches.
- Matrix audit: every I/O row has a passing test.
  - Busy real run: the first v3 test.
  - Waiters ahead and the dry run: the second v3 test.
  - Error inside the hold and the cancelled ticket: the third v3 test.
  - deliver and announce: the first v3 test, plus the v113 test.

**Residual risks**
- On a public repo whose policy publishes the device edition, the GitHub Release asset `hub-receipt-android.json` carries `contention` with holder names. This was accepted (AD-14 scopes the bucket).
- The public job log and step summary name the holder, as timeout messages already did.
- The real 20-min wait and the workflow gating were not run live. The tests use a 150 ms seam and call the later commands directly. The first real busy deploy on a release carrying this change is the live proof.
- Runs pinned to v1.2.46 keep the old red behaviour until the next hub release.
