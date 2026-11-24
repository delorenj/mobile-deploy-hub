---
title: 'Story 1.2: Exactly-once release and reclaim through tombstones'
type: 'feature'
created: '2026-11-23'
status: 'done'
route: 'dispatch'
review_loop_iteration: 0
baseline_commit: '1e3b8699e394252e918b3bd7983b9b1536090db3'
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-1-context.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** `lock.mjs` removes a lock with a forced `rmSync` (`reclaim()` `:61`, `withLock` finally `:103`) after a read-compare, so two reclaimers that judged the same stale owner can both "win", and the loser can delete a lock a third process took in between. Nothing records a release or reclaim, so history would double-count or miss holds. MOBI-25, epic MOBI-23, AD-9, AD-2, AD-1.

**Approach:** One helper in `lock.mjs` retires a lock by renaming `<name>.lock` to `<name>.lock.tomb-<ms>-<pid>`, verifies the tomb holds the owner that was judged (else renames it back), and only then deletes the tomb and appends one `release` or `reclaim` event via Story 1.1's `appendEvent`. Every lock-dir removal in `lock.mjs` goes through it.

## Boundaries & Constraints

**Always:** Node 24 ESM, `node:` builtins. Only `lock.mjs` renames or removes `<name>.lock` and only it calls `appendEvent`. Events only for Queued names (`QUEUED` = `adb`, `s24`, `mac-ios`, `emulator`, plus `emulator-<n>`, exported once from `lock.mjs`, AD-4); non-Queued names (`s3-*`, `s3-index`, `emulator-reaper`) still retire through tombs but write no event. A rename failing with ENOENT returns "lost", writes nothing, throws nothing. The tomb name never ends in `.lock`. The winner deletes only its own tomb, recursively, without `force`. A failed event write never fails the release/reclaim. Existing return values, log lines (`HUB_LOCK_RECLAIMED`, ...), `releaseLease` reasons, `listLocks` shapes and `hub-device` output stay unchanged. Tests use temp `HUB_LOCK_DIR` and `HUB_EVENT_DIR`; no test may append to the real `~/.local/state`.

**Never:** Forced `rmSync` of a live `<name>.lock`. An event from the rollback in `acquireLease` (a give-back, not a release). New timers, policy keys, owner.json keys (Story 1.4), `acquire`/`request`/`timeout` events (Story 1.4), touching `hub-device status`/reap (Story 1.3), a release or `hosts:install` (Story 1.5).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Release | holder's `releaseLease(id)` or `withLock` finally on `adb` | lock gone, no tomb left, exactly one `release` event | releasing twice: `none`, no second event |
| Reclaim | stale owner on `adb`, next taker reclaims | one `reclaim` event with the reclaimed owner's claimant, `held_ms` and a `reason` | N/A |
| Racing reclaimers | A reclaims S, C then takes the lock, B (judged S) renames | B's tomb holds C, not S: B renames it back, writes nothing; C still holds | if the name was retaken meanwhile, B drops the tomb, logs `HUB_LOCK_LOST`, writes nothing |
| Lost rename | lock vanished before the rename | no event, no error, caller loops on | ENOENT swallowed |
| Non-Queued | `withLock('s3-x')` | tomb release, no event | N/A |
| Tomb beside lock | `adb.lock.tomb-1-2/` exists | `listLocks` omits it; a bare `mkdirSync(adb.lock)` succeeds | N/A |

</frozen-after-approval>

## Code Map

- `tools/ci/lib/lock.mjs` -- `reclaim(path, judged)` `:58` (callers: `withLock` `:91`, `acquireLease` `:236` rollback and `:244`, `releaseLease` `:284`); `withLock` finally `:103`; `stale()` `:42` (keep its boolean for `listLocks`, add a reason beside it); `listLocks` `:305` already filters `.endsWith('.lock')`; `writeOwner` is the tmp+rename helper. Imports `events.mjs` (`appendEvent`) — allowed direction.
- `tools/ci/lib/events.mjs` -- `appendEvent(event, {env, now, log, host, hostId})`, never throws; failure logs to `console.error` by default (keep that default: `hub-device lease` stdout is reserved).
- `tools/device/emulator.mjs` `:302,:352,:358,:518,:603`, `tools/device/hub-device.mjs` `:174,:319,:397,:422,:618,:644` -- `releaseLease` callers; unchanged API.
- `tools/device/lease.test.mjs` -- fixture env is bare (`{HUB_LOCK_DIR,...}`): add `HUB_EVENT_DIR`; home of the new tests.
- Env fixtures that drive Queued locks and must gain `HUB_EVENT_DIR`: `tools/device/hub-device.test.mjs` `:60,:437,:636,:924`, `tools/device/emulator.test.mjs` `:125`, `tools/ci/editions.test.mjs` `:246,:362`, `tools/ci/v11.test.mjs` `:148,:372`, `tools/ci/v113.test.mjs` `:194`, `tools/ci/v3.test.mjs` `:717`, `tools/ci/testflight.test.mjs` `:61`, `tools/ci/ios-token.test.mjs` `:67`. `catchup.test.mjs` sets `XDG_STATE_HOME` already.
- `tools/ci/test-fixtures.mjs` `hermetic()` -- safety net: set `process.env.HUB_EVENT_DIR` to a per-process temp dir after deleting `HUB_*`.

## Tasks & Acceptance

**Execution:**
- [x] `tools/ci/lib/lock.mjs` -- add `QUEUED`/`isQueued`; replace `reclaim()` and the finally `rmSync` with `retire(name, path, judged, {as: 'release'|'reclaim'|null, reason, env, now})`: rename to tomb (monotonic per-process ms), ENOENT is lost, verify tomb owner equals judged, else rename back (on failure drop tomb, `HUB_LOCK_LOST`), delete tomb, append event when `as` and `isQueued`; `stale` gains a reason (`abandoned`, `expired`, `holder-gone`, `too-old`); `releaseLease` gains optional `now`; `beforeRetire` test seam on `withLock`/`acquireLease` -- AD-9, AD-1
- [x] `tools/device/lease.test.mjs` -- events dir in fixture; tests for every matrix row, the race via a child process inside `beforeRetire` -- story ACs
- [x] test fixture files listed in Code Map, `tools/ci/test-fixtures.mjs` -- `HUB_EVENT_DIR` everywhere a Queued lock is driven -- hermeticity

**Acceptance Criteria:**
- Given two reclaimers racing on one stale lock, when both run, then exactly one `reclaim` event exists and a third process's lock taken afterwards survives.
- Given `mise run check` with a watched real event dir, when it runs, then it is green and `~/.local/state/mobile-deploy-hub/events` is not created.

## Implementation Notes

- Built directly in the build session: no implementation or reviewer subagent was available to the run. The three review layers (blind, edge-case, verification-gap) were done as one in-session pass; findings are in the triage log.
- `tools/ci/lib/lock.mjs`: `QUEUED` + `isQueued` exported (Story 1.4 reuses them); `staleness()` returns a reason, `stale()` stays boolean for `listLocks`; `retire()` replaces `reclaim()` and the `withLock` finally `rmSync`; `releaseLease` gains `now`; `withLock`/`acquireLease` gain the `beforeRetire(step)` test seam (`'rename'`, `'restore'`). The `acquireLease` give-back writes no event.
- `withLock` now writes `started_at` at the moment it takes the lock, not when its wait began (review finding), so a job's `held_ms` excludes its wait. Same key, truer value (AD-2 additive); a waiter's `HUB_LOCK_WAIT ... since <t>` shows the take time.
- `HUB_LOCK_LOST` goes to the caller's `log` (stderr in `hub-device`); `releaseLease` has no `log`, so it defaults to `console.error`.
- Hermeticity: every env fixture driving a Queued lock gained `HUB_EVENT_DIR`; `hermetic()` sets `process.env.HUB_EVENT_DIR` to a per-process temp dir (removed on exit). Verified: after `mise run check`, `~/.local/state/mobile-deploy-hub/events` does not exist and no `hub-test-events-*` dir is left in `/tmp`.
- Interim until Story 1.3: `hub-device status` still reaps dead emulator leases, and that reap's `releaseLease` now writes a `release` event. Story 1.3 moves the reap off `status`.
- Tests: `tools/device/lease.test.mjs` +9 (Queued set, release once, reclaim once with reason and expiry cap, two races via `withLock` and `acquireLease`, lost rename, `HUB_LOCK_LOST` put-back failure, non-Queued no event, tomb beside lock) and event assertions in the give-back test.
- `mise run check`: actionlint clean, 499 tests pass, 0 fail.

## Spec Change Log

## Review Triage Log

| Finding | Verdict | Evidence |
|---|---|---|
| A job's `held_ms` included its wait: `withLock` stamped `started_at` before the wait loop | medium, patched | `me.started_at` was computed at entry; now stamped at the take; test "a release is recorded exactly once" pins a 5 s wait out of `held_ms` |
| The `acquireLease` reclaim path's `beforeRetire` passthrough and race were untested (only `withLock` races) | low, patched | Added "the same race through acquireLease" test |
| An ownerless (abandoned) lock: B's tomb verify is `null == null`, so if A reclaims and C has just `mkdir`ed (no owner yet), B can retire C's fresh dir and both write `reclaim` | low, rejected | Needs a crash-orphaned lock and a three-process interleave inside microseconds; the old `rmSync` path had the same window; an inode/birthtime check adds a branch for a case not seen in use |
| A crash between the tomb rename and its delete leaves a tomb forever | low, rejected | A tomb never ends in `.lock`, so it blocks nothing and is never listed (tested); sweeping it would need a reaper (AD-19 forbids a new clock) |
| `HUB_LOCK_LOST` on stdout could break `eval "$(hub-device lease)"` | false | `hub-device` passes `log: line => stderr(line)` (`hub-device.mjs:694`); `releaseLease` defaults to `console.error` |
| `hub-device status` now writes release events through its emulator reap | low, deferred to Story 1.3 | Story 1.3's AC moves the reap off `status`; no release ships between the two (Story 1.5) |
| A failed event write could fail a release | false | `appendEvent` never throws (Story 1.1) and is called after the tomb delete |
| Tests could write host history under the real `~/.local/state` | false | Every Queued-lock fixture passes `HUB_EVENT_DIR`; `hermetic()` sets a temp one; checked after the full suite |

## Design Notes

Event body (Story 1.4 enriches it): `{event, lock, hold_kind: 'lease'|'job', claimant: {holder, repo, run}, lease_id, held_ms, reason}`. `held_ms` = `now - started_at` (a job's `started_at` is its take time), for a Lease capped at `expires_at`. `reason` for a reclaim is the staleness verdict: `abandoned`, `expired`, `holder-gone`, `too-old`. Release reasons: `by-id`, `any` (releaseLease without id), `done` (job). Tombs are used for non-Queued names too: the double-reclaim bug is the same there, and the tomb never blocks a name for older pins. Accepted residual: a three-way interleave (B renames C's lock while D is between `mkdir` and its owner write) can't be made atomic on a plain filesystem; it is narrower than today's read-then-`rmSync` window.

## Verification

**Commands:**
- `node --test tools/device/lease.test.mjs tools/ci/events.test.mjs` -- expected: all pass
- `mise run check` -- expected: green; afterwards `ls ~/.local/state/mobile-deploy-hub/events` fails (not created)
