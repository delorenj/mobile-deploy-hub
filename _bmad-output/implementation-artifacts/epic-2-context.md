# Epic 2 Context: Deploys wait their turn, and keep it

<!-- Compiled from planning artifacts. Edit freely. Regenerate with compile-epic-context if planning docs change. -->

## Goal

Deploy jobs, the catch-up, `hub-device` Leases and the emulator pool wait in one fair first-in-first-out Queue per device, so a later arrival can never take a device ahead of a run that is already waiting. A deploy run reserves its devices when it starts, so its build never loses its place while it compiles. Nobody can extend a Lease while others wait, and Leases on deploy targets are capped at 60 minutes. The whole epic is the freeze set: it lands on main story by story but ships as one hub release (Story 2.8), followed by `hosts:install` on both hosts. No story in it ships alone.

## Stories

- Story 2.1: Ticket format v1 and machine identity
- Story 2.2: One queue view, and tries
- Story 2.3: Deploy jobs and the catch-up join the Queue
- Story 2.4: Wait deadlines that beat GitHub's timeout
- Story 2.5: Reservations keep a run's place
- Story 2.6: Reservations end when the run is done with the device
- Story 2.7: No extension while others wait; deploy-target Leases are capped
- Story 2.8: Ship the freeze set

## Requirements & Constraints

- Every Claimant kind (deploy job, catch-up, Lease, pool probe) waits in one FIFO per Resource with no priority classes. A free Resource with an empty Queue is taken at once.
- A waiting deploy job holds a visible place with its repo, run and job (never `undefined`), and its wait ends at least 2 minutes before its own job timeout. Timeouts keep today's `host lock <name> is held` wording and are coded.
- Internal locks (`s3-*`, `s3-index`, `emulator-reaper`) keep today's bare path and write no events.
- A run's Reservation is taken at its start (gate for the S26, `preflight-ios` for the Mac), grants a one-time grace to a head Reservation, ends with the run's last hold or a 3 h ceiling, and is reused by a rerun.
- A Lease cannot be extended while another Claimant that blocks is waiting; the refusal names the waiters.
- Pinned older hub versions share the same lock dir on the same hosts for about 30 days, so the on-disk layout is the contract: new state goes in sibling paths, new keys are additive, and nothing a pinned version reads may change meaning. A ticket must never leave a dead or unfamiliar entry blocking the Queue.
- `hub-device` keeps its commands, exit codes, `HUB_DEVICE_*` lines and `--json` shapes; the CLI only grows. Each intended text change is named in its test.
- Every transition on a Queued lock, Pool request and Reservation appends one event through Epic 1's writer, exactly once, never fatal.
- Node 24 ESM `.mjs`, `node:` builtins only. Hermetic tests with injected clock, env, host identity and process lookups. Tuning values only in `tools/ci/policy.json`, added by the story that needs them. No new timer, cron or launchd interval.

## Technical Decisions

- `lock.mjs` is the only module that mutates protocol paths and the only caller of the event append. `queueView(name, {env, now, policy})` is the one reader of the Queue; callers never parse tickets. `eta.mjs` is pure.
- Ticket v1 keeps the file name `<ms15>-<counter6>-<pid8>.json`. Its body is `{format, kind, lease_id, holder, why, pid, host, host_id, process_start, enqueued_at, deadline_at, expires_at, repo, run, attempt, job, reservation, request, pool, eta, delivery}`; `kind` is `lease`, `job`, `hub-job` or `remote` (v1 writes no `remote`). A job's `lease_id` is `job:<repo>#<run>.<attempt>/<job>`.
- Ticket liveness order: a missing `kind` means `lease`; a ticket with a pid follows the pid rule (stale only on positive evidence of death, an unreadable process start keeps it live); a pid-less ticket is live while `expires_at` is in the future; with neither it is stale 60 s after `enqueued_at`. Nothing is pruned for its kind alone.
- Same-host identity (AD-8): records carry `host_id` (`/etc/machine-id` on Linux, `IOPlatformUUID` on the Mac) beside `host`. Same host when both carry a `host_id` and they are equal, otherwise hostname equality. A pre-v1a ticket from another host is pruned; an owner from another host is honoured until its expiry (Lease) or 4 h (job).
- `QUEUED = adb, s24, mac-ios, emulator, emulator-<n>`. `withLock` on a Queued name joins the FIFO as `job` or `hub-job`. A `waitMs: 0` call is a try: no ticket, succeeds only when the lock is free and nothing blocks.
- Place is not blocking: every live ticket blocks, only the first Reservation in line blocks and only until its grace ends. After `mkdir` an acquirer re-reads the view and gives the lock back by tombstone if something blocking is ahead.
- Reservations are directories `<name>.reservations/<owner>--<repo>--<run>/` (`reservation.json`, `grace.json`, both created once with `wx`), liveness from timestamps only, released by renaming the directory before the lock is freed. Same-run requests are served at the Reservation's place.
- Errors are `Error` with `.code` `HUB_*` (`HUB_LOCK_TIMEOUT`, `HUB_LEASE_CANCELLED`, `HUB_LEASE_EXTEND_REFUSED`, `HUB_LEASE_LOST`); callers branch on codes. Logs start with an UPPER_SNAKE marker. New protocol code takes `{env, now, sleep, log, host, hostId, processStart, policy}` seams and never calls `hostname()` or `Date.now()` directly.
- `extendLease` is the only path that moves a Lease's expiry later; every owner rewrite first checks the lease id and lock inode.
- The queue policy block in `policy.json` is strict and grows story by story (margin and hold allowances in 2.4, grace and ceiling in 2.5, the Lease cap in 2.7); readers use the absolute times stamped into records.

## Cross-Story Dependencies

- 2.1 is the foundation: the ticket format and host identity are used by 2.2 (`queueView`), 2.3 (job tickets), 2.5 (Reservations).
- 2.2 precedes 2.3 and 2.5; 2.4 adds `deadline_at` inputs and the first policy keys that 2.5 and 2.7 extend.
- 2.6 depends on 2.5; 2.7 depends on `queueView` (2.2).
- 2.8 ships 2.1 to 2.7 together and runs `hosts:install` on both hosts.
- Epic 1's event writer and tombstone release are used throughout; Epic 3 uses 2's coded timeouts and Reservations; Epic 4 uses `queueView`.
