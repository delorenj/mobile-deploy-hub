# Epic 1 Context: Every hold leaves a record

<!-- Compiled from planning artifacts. Edit freely. Regenerate with compile-epic-context if planning docs change. -->

## Goal

Give Jarad and his agents a durable, local, append-only history of who held each device lock, why, for how long and how the hold ended. It starts accruing with the first release, before the Queue (Epic 2) changes any behaviour. The Event Log is purely additive, so it ships as its own hub release ahead of the freeze set. Today nothing records a hold once its lock directory is gone.

## Stories

- Story 1.1: Event writer with a single hub-version source
- Story 1.2: Exactly-once release and reclaim through tombstones
- Story 1.3: `hub-device status` is truly read-only
- Story 1.4: Record holds on Queued locks, with liveness
- Story 1.5: Ship the Event Log release

## Requirements & Constraints

- One event per transition (request, acquire, release, extend, timeout, cancel, reclaim) on a Queued lock. Each carries the Resource, the Claimant, hub version, times, `waited_ms`, `held_ms`, and the reason. A failed write never fails a transition.
- A reclaim records when the holder was last alive.
- `hub-device` keeps its commands, exit codes, `HUB_DEVICE_*` lines and `--json` shapes. `hub-device status` stays read-only: it writes nothing to the lock dir, emulator state or Event Log.
- Pinned runs stay compatible: older hub versions read and write the same lock dir, so new state goes in sibling paths and new keys are additive.
- No new clock: expiry and reclaim are decided when the hub is called. The only in-process interval is a holder's unref'd liveness touch.
- Node 24 ESM `.mjs`, `node:` builtins only, no Python. Tests are hermetic (`hermetic()`, temp `HUB_LOCK_DIR` and `HUB_EVENT_DIR`, injected env, clock and fakes); they never touch real `~/.local/state`, `~/.cache`, the live bucket, adb or host state.
- Tuning values live only in `tools/ci/policy.json`.

## Technical Decisions

- `lock.mjs` is the only module that mutates protocol paths and the only caller of the event append. `events.mjs` is the writer and reader; it may import `receipt.mjs` and `node:` builtins only.
- Event Log lives in `HUB_EVENT_DIR`, default `$XDG_STATE_HOME/mobile-deploy-hub/events/<YYYY-MM>.jsonl` (fallback `~/.local/state/...`), on the host that owns the lock. One JSON line per event, under 4 KiB, one `O_APPEND` write.
- Only the process whose deciding step succeeded writes the event. Release and reclaim go through a tombstone rename (`<name>.lock.tomb-<ms>-<pid>`), never a forced `rmSync`; the winner deletes its own tomb. A tomb name never ends in `.lock`, so it never blocks the lock name for older versions.
- `hub_version` has one source: `hubRef()` in `receipt.mjs` (order: `HUB_REF`, the `_actions/.../<ref>/` path, the release-dir name, then `unknown`). It is never read from `HUB_VERSION` (that is the app version).
- Event shape is `{format:1, ts, host, host_id, hub_version, event, lock, pool, request, hold_kind, claimant:{kind, holder, repo, run, attempt, job}, lease_id, for_ms, expires_at, deadline_at, waited_ms, held_ms, eta, reason, blocked_by, last_alive_at, delivery}`.
- `QUEUED = adb, s24, mac-ios, emulator, emulator-<n>` is one exported constant in `lock.mjs`. `s3-*`, `s3-index` and `emulator-reaper` write no events.
- `owner.json` gains `format, kind, repo, run, attempt, job, host_id` additively; `stale()` must keep reading owners written by v1.2.43. Each holder touches `<name>.lock/alive` at most once a minute; a job reclaim records `last_alive_at` with `approx: true`; a Lease reclaim ends `held_ms` at the earlier of `expires_at` and observed death.
- `host_id` comes from `/etc/machine-id` on Linux and `IOPlatformUUID` on the Mac.
- Conventions: errors are `Error` with `.code` `HUB_*`; log lines start with an UPPER_SNAKE marker (`HUB_EVENT_LOG_FAILED`); timestamps are ISO-8601 UTC strings and durations are `*_ms`; new protocol code takes `{env, now, sleep, log, host, hostId, processStart, policy}` seams and never calls `hostname()` or `Date.now()` directly.

## Cross-Story Dependencies

- 1.1 is the foundation: 1.2 and 1.4 call its `appendEvent`; 1.4 adds the Queued-lock events.
- 1.2 (tombstones) must land before 1.4 records release and reclaim, so each is recorded exactly once.
- 1.5 ships 1.1-1.4 as one hub release (`mise run release`, then `hosts:install` on both hosts); it needs Node 26 added to `check.yml`.
- Epic 2 uses Epic 1's event writer; Epic 4's ETA reads Epic 1's history.
