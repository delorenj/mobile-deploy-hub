---
title: 'Story 1.3: hub-device status is truly read-only'
type: 'bugfix'
created: '2026-11-23'
status: 'done'
route: 'dispatch'
review_loop_iteration: 0
baseline_commit: 'f224071'
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-1-context.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** `main()` in `hub-device.mjs` (`:699-702`) runs the emulator `reap()` before `lease`, `release`, `run` and `status`. A dead or expired emulator lease is therefore torn down, its slot released (and, since Story 1.2, a `release` event appended) just because an agent looked at `status`. Looking alters the thing looked at. MOBI-26, epic MOBI-23, FR-13, AD-9 ("Read-only status").

**Approach:** Remove the reap from `main()` and run it where an emulator lease is acquired: `leaseEmulator` and `runEmulator`, before `provision`. `status` then reads lock dir, emulator records and process tables and writes nothing to them or to the Event Log.

## Boundaries & Constraints

**Always:** Node 24 ESM, `node:` builtins. `reap()` itself, `provision()`'s own in-loop reap, every command, exit code, `HUB_DEVICE_*` line, `--json` shape and `status` output stay as they are. The acquire-path reap keeps the old guard: `wait: false`, and a failure is a `hub-device: warning: the emulator reaper failed: ...` line on stderr, never a failed command. Hermetic tests only (temp `HUB_LOCK_DIR`, `HUB_EVENT_DIR`; fake emulator binaries already in `emulator.test.mjs`).

**Never:** A reap, tombstone, queue prune, record delete or event append reachable from `status`. New timers, policy keys or `lock.mjs` changes. Touching the existing status tests at `hub-device.test.mjs:861-941`. A release, `hosts:install` (Story 1.5).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Status over a dead lease | emulator lease expired or holder gone | lease listed (`stale: true` for the lock); lock dir tree, emulator records and Event Log byte-identical before and after | N/A |
| Acquire reaps | same state, then `lease emulator` or `run emulator` | `HUB_EMULATOR_REAPED ... (expired)` logged, victim torn down, slot freed, its `release` event written | reaper failure: stderr warning, acquire continues |
| Non-emulator commands | `lease s26`, `release`, `status` | no reap | N/A |

</frozen-after-approval>

## Code Map

- `tools/device/hub-device.mjs` -- `main()` `:699-702` holds the reap; `leaseEmulator` `:273` and `runEmulator` `:568` call `provision`; header comment `:15`. `status()` `:480` only reads (`listLocks`, `listWaiters` without `prune`, inventory, `emulatorStatus`).
- `tools/device/emulator.mjs` -- `reap()` `:293` (reuse, unchanged); `provision()` already reaps in its gate loop `:499`; header comment `:15` says every invocation reaps.
- `tools/device/emulator.test.mjs` -- `:319`, `:602`, `:675` use `status` as the reaper trigger; they must trigger through an emulator acquire instead. Fixture env already has `HUB_EVENT_DIR`.
- `tools/device/hub-device.test.mjs:861-941` -- existing status tests: must pass unchanged.

## Tasks & Acceptance

**Execution:**
- [x] `tools/device/hub-device.mjs` -- drop the `main()` reap; add `reapBeforeAcquire(context)` (same guard and warning) called in `leaseEmulator` and `runEmulator` before `provision`; fix the header comment -- AD-9, FR-13
- [x] `tools/device/emulator.mjs` -- fix the header comment (reaping happens on emulator acquire, not every invocation) -- accuracy
- [x] `tools/device/emulator.test.mjs` -- re-point the three reaper-trigger tests at an emulator acquire; add a test: status over expired and holder-gone leases leaves lock tree, records and Event Log untouched, the next `lease emulator` reaps them and the log gains the `release` events, and `run emulator` reaps too -- story ACs

**Acceptance Criteria:**
- Given a dead emulator lease, when `hub-device status` runs (text and `--json`), then a snapshot of the lock dir (names and file contents), emulator records and Event Log files is identical before and after.
- Given the same state, when `lease emulator` or `run emulator` acquires, then the reap runs and the Event Log gains one `release` event for the reaped slot.

## Implementation Notes

- Built directly in the build session: no subagent was available, so the review layers were done as one in-session pass (log below).
- `hub-device.mjs`: the `main()` reap is gone; `reapBeforeAcquire(context)` (same `wait: false` guard, same warning line) runs at the head of `leaseEmulator` and `runEmulator`. `provision()`'s in-loop reap is unchanged. Header comments in `hub-device.mjs` and `emulator.mjs` corrected.
- Per AD-9 the reap also no longer runs before `lease s24|s26|phone`, `release` and `run <phone>`: it only ever concerned emulator leases, and every emulator acquire still reaps. `release emulator <id>` tears down its own lease.
- The reap's event is a `release` (it ends through `releaseLease`), not a `reclaim`; the story's "the reclaim writes its event" is met by that release event. Story 1.4 may refine the reason.
- Tests (`emulator.test.mjs`): the three tests that used `status` as the reaper trigger now trigger through `lease emulator` (then `release emulator`); new "status is read-only" test snapshots lock dir, records and Event Log byte for byte around `status` and `status --json`, then shows the next acquire reaps three kinds of dead lease and logs the release; new "run emulator reaps" test. The new status test fails on the old `main()` (checked).
- `hub-device.test.mjs:861-941` untouched and passing.
- `mise run check`: actionlint clean, 501 tests pass, 0 fail; `~/.local/state/mobile-deploy-hub/events` not created.

## Spec Change Log

## Review Triage Log

| Finding | Verdict | Evidence |
|---|---|---|
| Dropping the reap from `release` and phone paths changes behaviour | low, accepted | AD-9 moves it to emulator acquire paths; it only touched emulator leases, `release emulator` tears down its own, and the next acquire reaps the rest |
| A reaper failure could fail an acquire | false | `reapBeforeAcquire` keeps the old try/catch and warning |
| `status` still writes via `listWaiters` prune or `listLocks` | false | `prune` is off in `status`; `listLocks`/`stale` only read; the snapshot test proves lock dir and Event Log unchanged |

## Verification

**Commands:**
- `node --test tools/device/emulator.test.mjs tools/device/hub-device.test.mjs` -- expected: all pass
- `mise run check` -- expected: green
