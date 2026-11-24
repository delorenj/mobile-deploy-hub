# Epic 4 Context: Know where you stand and how long it'll be

<!-- Generated from planning artifacts. Regenerate with compile-epic-context if planning docs change. -->

## Goal

Every waiter on a contended device sees its position in the Queue and an honest ETA range built from real past holds, in deploy job logs, in `hub-device lease --wait` and in `hub-device status`. A wait stops being a black box, so a person or agent can decide whether to wait or go elsewhere. The range admits how little data it has (a "low data" flag) rather than faking confidence. The CLI only grows: nothing existing is renamed or removed.

## Stories

- Story 4.1: An honest ETA range from history
- Story 4.2: Position and ETA in the wait line
- Story 4.3: Status shows every waiter, Reservations and ETAs

## Requirements & Constraints

- Every queued Claimant gets an ETA range: the interquartile range (25th to 75th percentile) of matching past holds, combined along the Queue. That means the current holder's expected remaining time plus the expected hold time of each blocking entry ahead.
- A Job Hold's expected length comes from past holds of the same repo and job. A Lease's expected end is its start plus the median share of its stated duration (`for_ms`) that past Leases of the same Claimant kind actually used, never later than its expiry.
- Low data: fewer matching holds than the policy threshold (the PRD's one threshold is 20 holds) widens the range to the stated durations or `deadline_at` and sets `low_data`. Research guidance: never give a single-point wait estimate from fewer than about 20 samples. Never hide the flag to look confident. The modelled Erlang and Allen-Cunneen capacity math is for the later Capacity Estimate, not for this epic.
- The ETA computed at enqueue is stored in the ticket (`eta` field) and in the `request` event, so ETA accuracy can be measured later. The success target is that the actual wait falls inside the enqueue range for at least half of waits over 2 minutes, after 14 days of history.
- The wait line is `HUB_LOCK_WAIT <name> held by <holder> position=<n> eta=<lo>-<hi>[ low-data]`. It keeps today's prefix, goes to the job log for deploy jobs and to stderr for `hub-device lease --wait`, and prints only when the position changes or the recomputed ETA moves by more than a minute. A stable waiter prints nothing, and the ETA is recomputed at most every 5 minutes. A successful `lease` still prints only `export` lines on stdout.
- `hub-device` keeps its commands, exit codes (75, 76, 1, 2, 127, 128+N), `HUB_DEVICE_*` lines and `--json` shapes. `status` stays read-only: it writes nothing to the lock dir or the Event Log, and it answers in under 200 ms on big-chungus with a month of fixture events.
- Status changes:
  - Waiter rows render by kind (repo, run and job for jobs, never `undefined`), with position and live ETA.
  - A Reservations section (run key, place, grace state, expiry) prints only when non-empty.
  - The existing nine-line status fixture (`hub-device.test.mjs:888`) stays unchanged when nothing new is present.
  - `--json` adds `waiters[].kind/repo/run/job/position/eta` and `reservations[]` as new keys only.
  - `hub-device release <id>` refuses `job:` ids with exit 2 and a `HUB_DEVICE_*` line naming the run to cancel.
- The old wait-line test is updated as an intended text change and named as such in the change.
- Stories 4.1 to 4.3 ship together as a hub release (`mise run release -- X.Y.Z`), followed by `hosts:install` on both hosts.

## Technical Decisions

- **AD-18, pure ETA:** a new `tools/ci/lib/eta.mjs` exports `eta(queueView, events, policy, now)` returning `{lo_ms, hi_ms, low_data}`. It imports nothing, and data comes in as arguments. Every surface (enqueue, wait line, status) uses it, so none computes its own. It reads only events inside the policy window, never the whole log per poll, and reads no clock itself (`now` is injected).
- **AD-11, policy:** tuning lives in the strict `queue` block of `tools/ci/policy.json`. Story 4.1 adds `eta_window_days` and `eta_low_data_min_holds`. `lock.mjs` reads them via `loadPolicy`, callers never pass them, tests inject a policy object, and changing a value is a hub release.
- **AD-6, queueView:** `queueView(name)` is the single Queue source and `hub-device status` must use it. Only live tickets and the first Reservation in grace block. Other Reservations hold a place but block nothing, so they add no time to an ETA.
- **History source:** the Event Log (`events.mjs`, `<lockDir>/events.jsonl`) holds `held_ms`, `waited_ms`, `for_ms`, `expires_at`, `deadline_at`, `eta` and `claimant:{kind, holder, repo, run, attempt, job}`. Event shape is `format:1`. A killed job writes no release, so reclaim records `last_alive_at`, and `held_ms` is not inflated.
- Layering: `lock.mjs` may import `events.mjs` and `policy.mjs`. Claimants (`hub-device`, deploy commands) import `lock.mjs`, `eta.mjs` and `policy.mjs`.
- Conventions: log lines start with an UPPER_SNAKE marker followed by `key=value`. Timestamps are ISO-8601 UTC in files and `*_ms` integers for durations. Every `ios-lane` timestamp is the Mac clock. Seams are injected (`{env, now, sleep, log, host, hostId, processStart, policy}`), with no direct `Date.now()` or `hostname()`.
- Tests: `node --test`, `hermetic()`, temp lock and event dirs. 4.1 needs a table of fixture tests covering empty, sparse and rich history, plus window filtering. One test per AD rule.
- Node 24 ESM `.mjs` only, no Python, no new dependency, no new clock or daemon (NFR-3).

## Cross-Story Dependencies

- 4.1 builds on Epic 1's event history and Epic 2's `queueView` and ticket `eta` field. 4.2 and 4.3 both consume 4.1's `eta()`.
- 4.2's wait line and the enqueue-time recording (4.1) both live in the `lock.mjs` wait and enqueue paths.
- 4.3 depends on Epic 2's Reservations and job tickets for the waiter and Reservation rows.
- Later work (v1b and v1c: Hub API, Capacity Estimate, Control Surface) reuses `eta()` over cached aggregates. Do not build that here.
