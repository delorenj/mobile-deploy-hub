---
title: 'Story 2.7: No extension while others wait; deploy-target Leases are capped'
type: 'feature'
created: '2026-11-24'
status: 'done'
route: 'dispatch'
review_loop_iteration: 0
baseline_commit: '08c9434b2c9a0eaa1c33c4801ee0216512f39962'
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-2-context.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Nothing stops a Lease from starving the Queue: a Lease can be rewritten to any later expiry (`updateLease` takes any field), there is no extend path that looks at who waits, and a Lease on `adb` or `mac-ios` can run 48 h while deploys wait. MOBI-36, epic MOBI-29, FR-31, AD-6, AD-11, AD-16.

**Approach:** `lock.mjs` gains `extendLease(name, id, {forMs})`, the only path that moves a Lease's expiry later; it refuses (`HUB_LEASE_EXTEND_REFUSED`) while any `queueView` entry that blocks waits, at or after expiry, and past the deploy-target cap. `acquireLease` applies the same cap. `updateLease` may only change metadata or move expiry earlier. Every owner rewrite first checks lease id and lock-dir inode (`HUB_LEASE_LOST`). The cap is policy `queue.deploy_target_lease_max_min` (60); `hub-device lease s26 --for 2h` exits 2 naming it.

**Decisions (autonomous, pre-approved):** `forMs` extends by that much past the current expiry. The cap is on the Lease's total length from `started_at` and covers `adb` and `mac-ios` only (`s24`, emulator slots and the pool gate keep the 48 h limit). A Lease records its lock-dir inode as `lock_ino` (additive key, unread by pinned hubs). The acquire-time refusal is code `HUB_LEASE_TOO_LONG`. `updateLease` keeps returning false when the lock is gone and throws `HUB_LEASE_LOST` when another Lease or job holds it; its three callers (`hub-device`, `emulator.mjs`) turn that throw back into their existing cancelled path. `emulator.mjs` clamps its ready-time expiry so it never moves later. `hub-device lease phone` with a duration over the cap skips the deploy phone instead of failing the pool. No CLI verb `extend` (v1b); no change to exit codes, lines or `--json`.

## Boundaries & Constraints

**Always:** Node 24 ESM, `node:` builtins. `lock.mjs` alone mutates owner records and appends `extend`. The cap comes from `loadPolicy` (tests inject `policy`). New owner keys are additive. Tests hermetic (temp `HUB_LOCK_DIR`/`HUB_EVENT_DIR`, injected clock and policy). An extension appends exactly one `extend` event, only after the rewrite succeeded.

**Never:** a CLI `extend` verb, Jarad's override (v1b/v1c), a timer, a policy key besides the cap, a release or `hosts:install` (2.8), another path that moves `expires_at` later.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Extend, nobody waits | live Lease, empty Queue | `expires_at` += forMs, one `extend` event | N/A |
| Extend, a waiter | blocking ticket or head Reservation in grace | refused | `HUB_LEASE_EXTEND_REFUSED`, message lists waiters with places |
| Reservation past grace | head Reservation, grace over | does not block | extension succeeds |
| At or after expiry | `now >= expires_at` | refused | `HUB_LEASE_EXTEND_REFUSED` |
| Over the cap | `adb`/`mac-ios`, total > 60 min | refused | message names the cap, points at `s24` or an emulator |
| Acquire over the cap | `adb`/`mac-ios`, `forMs` > 60 min | refused | `HUB_LEASE_TOO_LONG`; `hub-device lease s26 --for 2h` exits 2 |
| `updateLease` later expiry | `fields.expires_at` later | refused, nothing written | `HUB_LEASE_EXTEND_REFUSED` |
| `updateLease` earlier or metadata | earlier expiry, `{device}` | written | N/A |
| Lock re-taken | other `lease_id` or other inode | nothing written | `HUB_LEASE_LOST` |
| Lock gone | released | `updateLease` false | `extendLease` throws `HUB_LEASE_LOST` |

</frozen-after-approval>

## Code Map

- `tools/ci/lib/lock.mjs` -- `updateLease` (~:1097), `acquireLease` (~:905, `MAX_LEASE_MS` check and `mkdirSync(path)`), `writeOwner`, `queueView`, `waiterText`, `eventOf`, `note`, `failure`; new exports `extendLease`, `deployTargetCapMs`, `DEPLOY_TARGETS`.
- `tools/ci/lib/policy.mjs` + `tools/ci/policy.json` -- `queueBlock` strict keys; add `deploy_target_lease_max_min` (60).
- `tools/device/hub-device.mjs` -- `setup` (the `--for` checks, exit 2 through `Usage`), `lease` for `phone`, `takeLease`'s `updateLease`.
- `tools/device/emulator.mjs` -- `updateLease` callers (`:231`, `:465`, `:606` ready-time `expires_at`).
- Tests: `tools/device/lease.test.mjs` (lock), `tools/device/hub-device.test.mjs` (exit 2), `tools/ci/policy.test.mjs`, `tools/device/emulator.test.mjs`. `README.md`, `deferred-work.md`.

## Tasks & Acceptance

**Execution:**
- [x] `tools/ci/policy.json`, `tools/ci/lib/policy.mjs`, `tools/ci/policy.test.mjs` -- the cap key, strict and positive -- AD-11
- [x] `tools/ci/lib/lock.mjs` -- `extendLease`, the cap in `acquireLease`, `lock_ino`, guarded rewrites, `updateLease` refuses later expiry -- AD-16
- [x] `tools/device/hub-device.mjs`, `tools/device/emulator.mjs` -- exit 2 on an over-cap lease, `phone` skips the deploy phone, callers keep their cancelled path, ready-time expiry clamped
- [x] tests for the matrix; `README.md`, `deferred-work.md`

**Acceptance Criteria:**
- Given a Lease and a blocking waiter, when `extendLease` runs, then it throws `HUB_LEASE_EXTEND_REFUSED` naming the waiters and places and writes nothing.
- Given a successful extension, then the owner record's `expires_at` moved later by `forMs` and one `extend` event exists.
- Given `hub-device lease s26 --for 2h`, then exit 2, the message names the cap (60 min) and `s24` or an emulator.
- Given `emulator.mjs`'s ready-time update, then it still succeeds.
- Given a Lease re-taken by another id, then `updateLease` and `extendLease` throw `HUB_LEASE_LOST` and the new holder's record is untouched.

## Implementation Notes

- The inode check cannot be tautological: the writer's own `ino` (from the record `acquireLease` returned) is compared to the directory's current inode; owners without `lock_ino` (older Leases) skip it.
- The check runs again immediately before the rename of the temp file (a tight window remains between that and the rename; named in `deferred-work.md`).
- Deviation from the spine (named in `deferred-work.md`): an acquire over the cap is `HUB_LEASE_TOO_LONG`, a code AD-5 does not list. No other deviation.

## Spec Change Log

None. No loopback.

## Review Triage Log

In-session review of the diff against AD-16, AD-11, AD-17 and the Story 2.7 ACs.

| Finding | Verdict | Evidence |
|---|---|---|
| `lock_ino` was first added to every `mkdir` + `writeOwner` pair, including a deploy job's owner in `queuedLock` | high, fixed | the existing AD-2 key-set test for a job's owner failed; the key is now written by `acquireLease` alone |
| Six `deadline.test.mjs` tests took a 6 h Lease on `adb` | high, fixed | they now take 60 min (the cap); nothing else in them depends on the length |
| `hub-device lease s26 --no-connect --for 12h` (an existing test, and README's adapter example) is now exit 2 | intended | it is the story's AC; the test and README use 1 h, the adapter impact is in `deferred-work.md` |
| `updateLease` now throws `HUB_LEASE_LOST` where it returned false for a re-taken lock | handled | `hub-device` and `emulator.mjs` turn the throw back into their cancelled path; a gone lock is still false |
| `emulator.mjs` ready-time `expires_at = now + forMs` could move later | handled | clamped to the slot lease's own expiry (the slot is taken for boot + forMs + 2 min, so only an overrun boot is clamped); the emulator tests pass unchanged |
| Race of the last check and the rename into place | accepted | named in `deferred-work.md` (a `node:fs` rename cannot be conditional on the directory) |

## Review

`heavy mise run check` green: 615 tests, 0 fail (14 new in `extend.test.mjs` and `hub-device.test.mjs`, plus policy cases).

## Verification

**Commands:**
- `node --test tools/device/lease.test.mjs tools/device/hub-device.test.mjs tools/ci/policy.test.mjs tools/device/emulator.test.mjs` -- expected: all pass
- `heavy mise run check` -- expected: green

## Review (independent)

Checked against Story 2.7's nine ACs, AD-6, AD-11 and AD-16, and hunted for races, older-hub compatibility, liveness, hermeticity, CLI drift, event exactly-once and hard-coded policy.

**Confirmed and fixed**

- `emulator.mjs` rewrote its slot Lease (`recordPids`, `claim`, the ready-time rewrite) with the lease id alone: it never passed the lock directory inode its maker recorded at acquire, so AD-16's "lease id and inode recorded at acquire" held for `hub-device` only. A slot reclaimed and re-taken under the same lease id (a `--id` reused, or a pre-v1a record without `lock_ino`) was written into silently. `provision` now keeps the inode `acquireLease` returned, stores it as an additive `lock_ino` key on the emulator record (read by `recordPids`, so the reaper's teardown checks it too) and passes it to `updateLease`. Regression test in `emulator.test.mjs` (fails without the fix: the maker reported HUB_EMULATOR_READY into the replaced lock).
- Test gap: the `HUB_LEASE_LOST` to cancelled conversion in `hub-device` `takeLease` (the lock re-taken by another lease while the phone is being found) had no test; added to `hub-device.test.mjs`, asserting exit 1, the CANCELLED line and the other holder's record untouched.

**Checked and dismissed**

- Races: `extendLease` and `updateLease` write nothing when the lock is gone, re-taken by a Lease or a job, or mid-take; a rewrite racing `retire` either fails the `sameOwner` judgement (restored) or hits ENOENT on the renamed directory. The remaining one-rename window and two racing extenders are the builder's accepted deferrals (not 2.7 ACs, AD-1 forbids a second lock).
- Older hubs: `lock_ino` is an additive key on Lease owners only, a v1.2.43 `updateLease` keeps it through `{...current, ...fields}`, tickets without `kind`/`host_id` are untouched by this diff (`queueView` is read-only in `extendLease`, no prune), the temp file name is the one `writeOwner` already used.
- Liveness: `extendLease` never prunes; stale tickets and an expired Reservation do not block; a Reservation head whose grace has not started (the lock is held) does block, as AD-6 says.
- Events: one `extend` event, written only after the rename succeeded; refusals and LOST write none.
- Policy: the 60 lives only in `policy.json`; `DEPLOY_TARGETS` is the lock identity, not tuning.
- CLI: `lease phone` over the cap skipping the S26 and `run s26 --for 3h` exiting 2 are consequences of the AC, documented; `status`/`--json` print no `lock_ino`.
- Tests: new ones are hermetic (temp lock/event dirs, injected clock and policy).

**Left (deferred-work.md)**: the emulator ready-time `expires_at` is clamped to the slot Lease's expiry, so a boot that overruns its 2-minute allowance leaves a Lease shorter than `--for`; the branch is not reachable in the fake-emulator suite.
