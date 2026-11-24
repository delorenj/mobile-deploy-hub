---
title: 'Story 1.4: Record holds on Queued locks, with liveness'
type: 'feature'
created: '2026-11-23'
status: 'done'
route: 'dispatch'
review_loop_iteration: 0
baseline_commit: 'e6f02ccc3bcb7eaa26c7eaa1062d483ce27c8a66'
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-1-context.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Since 1.1-1.2 only `release` and `reclaim` reach the Event Log, with a thin body. Nobody can see who waited for a device, how long, or who timed out, and a dead job's last sign of life is lost. MOBI-27, epic MOBI-23, FR-17, AD-2/4/9/19.

**Approach:** `lock.mjs` appends `request`, `acquire`, `release`, `timeout`, `cancel` and `reclaim` for every Queued name at each AD-9 deciding step, with the full AD-9 body. `owner.json` gains the AD-2 keys. A `withLock` holder touches `<name>.lock/alive` from an unref'd timer, and a job reclaim reports its mtime.

**Decisions (autonomous, pre-approved):** A Lease's `claimant.kind` is `agent` (v1a has no person surface). A `withLock` job is `deploy`, and the catch-up passes `kind: 'hub-job'`. A call with `waitMs: 0` is a try, as Story 2.2 defines it: it appends `acquire` on success and writes no event on failure. This keeps the phone and emulator pool probes out of the log.

## Boundaries & Constraints

**Always:** Node 24 ESM, `node:` builtins. Every append goes through `lock.mjs` after the deciding step wins, and it never fails or alters a transition. Log lines, error messages, error codes, `hub-device` output and old owner keys stay as they are. New owner keys are additive. Hermetic tests use temp `HUB_LOCK_DIR`/`HUB_EVENT_DIR` and injected `now`/`hostId`/timer.

**Never:** Events or `alive` for non-Queued names (`s3-*`, `s3-index`, `emulator-reaper`). Ticket body changes (AD-3, Story 2.1). FIFO for `withLock`, Pool-level events, coded `withLock` timeouts, same-host by `host_id` (Epic 2). New policy keys. A timer other than the unref'd touch. A release or `hosts:install` (Story 1.5).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Lease | acquire wait>0, release | `request`, `acquire` (waited_ms, for_ms, expires_at), `release` (held_ms, by-id) | N/A |
| Lease times out | lock held past waitMs | the ticket unlink wins, then `timeout` (waited_ms) | unlink ENOENT: cancelled by a release, no event, `HUB_LEASE_CANCELLED` |
| Waiter cancelled | `releaseLease(name, id)` removes the ticket | `cancel` reason `released`, from the releaser | N/A |
| Waiter aborted | signal or error while queued | `cancel` reason `aborted`/`error` | N/A |
| Try | `waitMs: 0` | `acquire` on success, nothing on failure | N/A |
| withLock Queued | adb job | `request`, `acquire`, `release` (`done`, or `error` when fn threw); a timeout writes `timeout` | message unchanged |
| Job reclaim | dead job with `alive` | `reclaim` with `last_alive_at` = alive mtime, `approx: true` | no `alive` (older pin): `last_alive_at: null` |
| Lease reclaim | expired / holder gone | held_ms ends at min(expires_at, reclaim time) | N/A |
| v1.2.43 owner | no format/kind/host_id | judged as before | N/A |

</frozen-after-approval>

## Code Map

- `tools/ci/lib/lock.mjs` -- `holdEvent` `:72` (widen to the AD-9 body); `retire` `:93` (read tomb `alive` mtime before the delete for a job reclaim); `withLock` `:123` (owner keys, `kind` option, request/acquire/timeout, alive touch); `acquireLease` `:239` (request after the ticket rename, acquire after the claim unlink, timeout and cancel through a ticket unlink); `releaseLease` `:327` (cancel events for unlinked tickets, `reason` option). Import `hostId` from `events.mjs`. Keep `staleness`, `listWaiters` and `listLocks` unchanged.
- `tools/catchup/catchup.mjs:854` -- `ctx.lock` passes `kind: 'hub-job'`.
- `tools/device/emulator.mjs:303` -- the reap's `releaseLease` passes `reason: reaped-<why>`.
- `tools/device/lease.test.mjs` -- `fixture()` has event dir. Update the Story 1.2 sequence assertions (`:285-395`), which gain request/acquire. This is an intended change.
- `tools/device/emulator.test.mjs` -- `fixture()`, `f.run`, `logged(f)`: home of the emulator-Lease sequence test.

## Tasks & Acceptance

**Execution:**
- [x] `tools/ci/lib/lock.mjs` -- event builder (`lock, hold_kind, claimant{kind,holder,repo,run,attempt,job}, lease_id, for_ms, expires_at, deadline_at, waited_ms, held_ms, reason, last_alive_at`); owner keys `format:1, kind, attempt, job, host_id`; events at each deciding step; `ALIVE_MS = 60_000` unref'd touch while `withLock` runs fn on a Queued name; `hostId`/`timers` seams -- AD-2/4/9/19
- [x] `tools/catchup/catchup.mjs`, `tools/device/emulator.mjs` -- hub-job kind; reap reason -- FR-7, history accuracy
- [x] `tools/device/lease.test.mjs` -- exact Lease sequence; timeout, cancel (released, aborted), try, withLock job + timeout, non-Queued silent, job reclaim `last_alive_at`, lease reclaim cap, v1.2.43 owners, owner keys, touch via fake timer (unref'd, ≤ once/min); update 1.2 sequences -- story ACs
- [x] `tools/device/emulator.test.mjs` -- exact emulator-Lease sequence: `request emulator`, `acquire emulator`, `acquire emulator-1`, `release emulator`, then `release emulator-1` -- story AC

**Acceptance Criteria:**
- Given a Lease taken with a wait and then released, when the Event Log is read, then its sequence is exactly `request, acquire, release`, each carrying every AD-9 field named in the story.
- Given `mise run check`, when it runs, then it is green and the real `~/.local/state/mobile-deploy-hub/events` is not created.

## Implementation Notes

- Built directly in the build session: no implementation or reviewer subagent was available. The three review layers ran as one in-session pass, as in 1.2 and 1.3; the log is below.
- `lock.mjs`: `eventOf()` builds the AD-9 body and replaces `holdEvent`. `heldMs()` keeps the Lease expiry cap. `note()` is the single Queued-only append. `retire()` reads `<tomb>/alive` before deleting the tomb. On a job reclaim it adds `last_alive_at` + `approx: true`, and nothing when `alive` is missing (an older pin).
- `withLock` gains `kind` (`job` | `hub-job`; anything else throws), `hostId` and `timers` (`{setInterval, clearInterval}`) seams. It writes `request` at entry, `acquire` at the take (`waited_ms`), `timeout` at the deadline (with `blocked_by`), and `release` reason `done`, or `error` when fn threw. On a Queued name it touches `alive` at the take and every `ALIVE_MS` (60 s, exported) from an unref'd interval, cleared in `finally`. A touch only runs while `owner.json` still has this take's pid and `started_at`.
- `acquireLease` gains a `hostId` seam. `request` follows the ticket rename and `acquire` follows the claim unlink. `timeout` and `cancel` (`aborted`/`error`) go through the waiter's own ticket unlink. If that unlink hits ENOENT at the deadline, the waiter now throws `HUB_LEASE_CANCELLED` instead of `HUB_LOCK_TIMEOUT`, because a release removed the ticket and recorded the cancel. That is the only behaviour change, and it sits in a narrow race. Tries (`waitMs <= 0`) write `acquire` only.
- `releaseLease` gains `reason` and `hostId` options and writes one `cancel` (reason `released`) per ticket it unlinks. A record whose ticket the same call cancelled was mid-take: it is retired with no `release`, so that request's history is just the cancel. This is an intended change to the 1.2 give-back test.
- `owner.json` (jobs and Leases) appends `format: 1`, `kind`, `attempt` (`GITHUB_RUN_ATTEMPT`), `job` (`GITHUB_JOB`) and `host_id` after the existing keys. A job's `kind` is now `job`: the `hub-device.test.mjs` "release --any" assertion is updated as an intended change. Non-Queued owners get the same keys and still no events or `alive`.
- `catchup.mjs` `ctx.lock` passes `kind: 'hub-job'`. The reaper in `emulator.mjs` releases with reason `reaped-expired`, `reaped-holder-gone` and so on.
- Tests: `lease.test.mjs` gets 10 new tests: the exact Lease sequence with the full body and owner keys; timeout; the timeout-vs-release race (mutation-checked); cancel by release and by abort; try; withLock sequence plus the alive touch through fake timers; hub-job, error and timeout; non-Queued silence; reclaim `last_alive_at`/held_ms; v1.2.43 owners. The 1.2 exactly-once assertions now filter to release/reclaim (`holds()`). `emulator.test.mjs` gets the exact emulator-Lease sequence and the reap reasons. `catchup.test.mjs` checks that the catch-up's events are `hub-job`.
- `mise run check`: actionlint clean, 513 tests pass, 0 fail. `~/.local/state/mobile-deploy-hub/events` was not created.

## Spec Change Log

## Review Triage Log

| Finding | Verdict | Evidence |
|---|---|---|
| The catch-up's `kind: 'hub-job'` had no test, so dropping it would pass the suite | low, patched | Added a catch-up test over the real `linuxContext` lock; it asserts `claimant.kind` `hub-job` for request, acquire and release |
| The timeout-vs-release ENOENT branch (`timedOut`) was untested | low, patched | Added the race test; the mutation that returns TIMEOUT there fails it |
| `phone` (takeAnyPhone) writes only `acquire` on success and nothing when the Pool times out, so Pool contention is invisible | low, deferred to Story 2.2 | AD-4 Pool-level request/acquire/timeout events with tries are Story 2.2's AC; logging each probe now would flood the log |
| A `releaseLease` cancel of a try's ticket writes a `cancel` with no `request` | low, rejected | A try's ticket lives for microseconds between write and claim; the 2.2 tries write no ticket at all |
| `withLock` writes `request` before `mkdir`; a non-EEXIST mkdir error leaves a request with no terminal event | low, rejected | It needs a lock dir that cannot be written, which already fails the deploy loudly; this is the same as today's error path |
| A touch could write `alive` into a lock dir that changed hands between the owner check and the write | low, rejected | The window is microseconds; `alive` is advisory and only read on a job reclaim; writeFileSync never creates the dir, so a retired lock is never resurrected |
| A failed event write could fail a transition | false | Every append goes through `note()` → `appendEvent`, which never throws (1.1); `eventOf` is pure over optional chaining |
| v1.2.43 readers misjudge the new owner keys | false | Old `isLease` checks `kind === 'lease'` only; job owners' `kind: 'job'` reads as a job; the v1.2.43-owner test pins both directions |

## Verification

**Commands:**
- `node --test tools/device/lease.test.mjs tools/device/emulator.test.mjs tools/catchup/catchup.test.mjs` -- expected: all pass
- `mise run check` -- expected: green
