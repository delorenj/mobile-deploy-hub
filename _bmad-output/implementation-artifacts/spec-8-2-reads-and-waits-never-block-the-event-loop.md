---
title: 'Story 8.2: Reads and waits never block the event loop'
type: 'feature'
created: '2026-11-25'
status: 'done'
baseline_revision: '56b4cc60e4aff9f9f72d0047af289bc599332f03'
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-8-context.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-8-1-one-status-document-from-the-api.md'
warnings: ['oversized']
deferred:
  - summary: >-
      A host-snapshot gather has no deadline, so a worker that hangs (a /proc read stuck on a wedged process) leaves the first gather in flight forever and every /status and /discovery awaiting `snapshot.ready()` hangs with it.
    evidence: |-
      `createSnapshot.gather()` calls `observe({ env })` with no signal or deadline. `ready()` awaits `refresh()` while `current === null`, and single flight keeps `inflight` set. After one success, a hang only freezes the snapshot: reads still answer from it and the fallback readers. Before this story the same `inventory()` scan ran on the main thread, so a hang stalled every request. The change narrows the hang's reach rather than adding it, which makes it pre-existing. A fix needs a gather deadline, and that is a timer, which this spec's Never forbids. That needs a decision: an AbortSignal deadline on `observeOffThread`, or an exemption in tools/clock.test.mjs.
    location: >-
      tools/hub-api/snapshot.mjs:45-70
    severity: medium
---

<intent-contract>

## Intent

**Problem:** The Hub API's reads do their slow host work on the main thread, while the request waits. `/status` and `/discovery` run `inventory()` (a full `/proc` scan that reads every process's `cmdline` and `environ`) and await the adb wire query, which can take up to `PROBE_MS`, 5 s. The `/resources` readings refresh also scans `/proc` on the main thread. Every lock-owner staleness check calls the uncached `processStart`. On the Mac that is a `spawnSync ps`. So one slow read, or a lease wait that is spinning, stalls every other request (NFR-7, AD-44).

**Approach (`belsky-doctrine`, one level up from "make `/status` fast": every read and every wait a service makes).** One generic **host snapshot** per service (`tools/hub-api/snapshot.mjs`, built the same way as `readings.mjs` so that the Host Agent in Epic 9 reuses it). It holds the slow observations: the inventory, the adb listing, and the process starts of every pid the lock dir names. A worker thread gathers them (`tools/device/observe-thread.mjs`). A gather is started by a read that finds the snapshot older than one pass, never by a timer. The Claims library gains `processStart`, `liveStart` and `adbQuery` seams. Through them `statusView`, `discover`, `phoneReadings` and every wait read the snapshot. Disk (the lock dir, `registry.json`, the Event Log) is still read on every request, so anything that passes with time is still derived from `now`.

## Boundaries & Constraints

**Always:**
- Node 24 ESM `.mjs`, `node:` builtins only. Tests are hermetic: `hermetic()` in each new test file, and injected `observe`, `processStart`, `now` and `adbWire`.
- A snapshot is `{taken_at, inventory, adb, starts, live_starts}`, where `adb` is the `queryAdb` result (`{port, note, listed, serials}`) and `starts`/`live_starts` are `Map(pid -> value)`. It is plain data, so it can cross the worker boundary.
- `createSnapshot({env, now, maxAgeMs = JOB_POLL_MS, observe, startOf, liveStartOf, log})` returns these:
  - `read()` returns the current snapshot or null.
  - `ready()` resolves once the first gather has settled (a failed one counts).
  - `refresh()` joins the gather that is in flight, or starts one. At most one gather is ever in flight.
  - `inventory()` is sync. It returns the snapshot's inventory, or an empty one before the first gather.
  - `adbQuery()` is async. It returns the snapshot's `adb` with `checked_at` (the snapshot's `taken_at`), and never waits for a gather that has already settled.
  - `processStart(pid)` and `liveStart(pid)` are sync. While the snapshot is younger than `maxAgeMs` and has the pid, they return its value. Otherwise they use one shared `cachedProcessStart` reader (`startOf`, or `liveStartOf`, with `ttlMs = maxAgeMs`), which preserves today's bound of one read per pid per pass.
  - Every accessor starts one `refresh()` when the snapshot is missing or older than `maxAgeMs`. No accessor except `ready()`/`refresh()` ever awaits a gather.
  - A failed gather logs one `HUB_API_OBSERVE_FAILED <why>` line and keeps the last snapshot. Before any success, it leaves an empty snapshot with `taken_at: null` and `adb.note` set to `the host could not be observed`, so the next read retries.
- `observeHost({env})` (in the worker) runs the real `inventory()`. It calls `queryAdb` only when that inventory shows the hub's adb server running, the same rule `phoneObservations` follows. It records `processStart`/`liveStart` for every pid that `listLocks`, `queueView(name, {includeStale: true})` (for each name in the lock dir) and `emulatorStatus` would read, using recording seams over the real readers. `observeOffThread({env, signal})` runs it in a `node:worker_threads` worker. A worker crash or exit without an answer rejects with `HUB_API_OBSERVE_FAILED`.
- The Hub API (`startHubApi`) builds one snapshot. It starts the first `refresh()` after the bind and puts `snapshot`, `inventory`, `adbQuery`, `processStart` and `liveStart` into the request context unless a test injected them. The readings probe is `refresh()` followed by `phoneReadings` over the snapshot seams. `createLeaseWaits` and `serviceContext` pass the same `processStart`, so waits and reads share one reader.
- `statusDocument` and `discovery` `await ctx.snapshot?.ready()` first. A reachability reading built from the snapshot is stamped with the adb answer's `checked_at`, never with the time of the request.
- Every new seam defaults to today's reader. The CLI (`hub-device`) and the deploy path behave exactly as before.

**Never:** add a timer, interval or recurring gather (tools/clock.test.mjs); call `spawnSync`, `execSync` or `execFileSync` from `tools/hub-api/*.mjs` or `tools/host-agent/*.mjs`; cache anything derived from time (`stale`, `expected_end`, grace) or the lock dir's contents; change the on-disk layout, an event, a response key, `CONTRACT_VERSION` or `policy.json`; touch the deploy path, `AGENTS.md`/`CLAUDE.md` or `sprint-status.yaml`; build forwards. "A forward reports its own `duration_ms`" binds Story 9.3, where the first forward appears. No forward route exists in v1b yet.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Blocking start, wait spinning | `processStart` seam that busy-waits 200 ms and counts calls. Lease on `adb` with `holder_pid: process.pid` and its start. A `POST /leases` waiter (`wait_ms`) spinning on `adb`. Snapshot warmed by a fake `observe` | 5 sequential `GET /status` each answer in < 200 ms. The seam is called 0 times during them. The waiter is still waiting | — |
| Cold pid | Warm snapshot, then a new lock owner whose pid is not in it | One fallback read for that pid. A second `/status` in the same pass reads 0. One refresh is started | — |
| Old snapshot | Clock moved past `maxAgeMs` | The read answers from the old snapshot at once (adb `checked_at` keeps its age) and starts exactly one refresh. Concurrent reads start no second one | — |
| Gather fails | `observe` rejects | One `HUB_API_OBSERVE_FAILED` line. `/status` still answers 200, with reachability `unknown`/stale | never a 500 |
| Month of events | ~15k release lines over 30 days, a Lease plus 2 waiters | best of 3 `/status` < 200 ms; Event Log bytes unchanged | — |
| Uncontended take | `POST /leases` `{resource: 's24'}` against fakes | 200 in < 1 s. `observe` is not called on the request path | — |
| Real worker | Scratch lock dir with a Lease whose `holder_pid` is `process.pid` | `observeOffThread` resolves with `starts.get(process.pid) === processStart(process.pid)` and an inventory with the three lists, from a thread other than the main one | crash: `HUB_API_OBSERVE_FAILED` |

</intent-contract>

## Code Map

- `tools/ci/lib/lock.mjs`:
  - `staleness` (L124-147) calls the global `processStart` at L135. Give it a `startOf = processStart` option.
  - Pass `startOf` from `liveLease` (L106, which gains a `processStart` param), from `listLocks` (L2140, gains `processStart`), and from the acquire paths at L395, L1395, L1533, L1590 and L1771, where `startOf` is already in scope.
  - `cachedProcessStart` (L1186) and `JOB_POLL_MS` (L331, 2000) are reused. This is a reader seam only, with no layout change.
- `tools/device/emulator.mjs`:
  - `liveStart` (L145) and `sameProcess` (L153).
  - `emulatorStatus(env, {liveStart})` (L407) takes the seam, defaulting to `liveStart`.
- `tools/device/claims.mjs`:
  - `lockActivity` (L149) gains a `processStart` pass-through.
  - `createContext` (L185) gains `processStart`, `liveStart` and `adbQuery`.
  - `phoneObservations` (L1498) uses `ctx.adbQuery ?? queryAdb` and returns the time it asked.
  - `statusView` (L1562):
    - pass `ctx.processStart` at L1567 (`listLocks`), L1601 (`queueView`) and L1644 (`lockActivity`);
    - pass `ctx.liveStart` at L1656 (`emulatorStatus`);
    - stamp the readings at L1671 with the observation time.
  - `discover` (L1729) uses the same `adbQuery` seam.
  - `createLeaseWaits` (L896) already takes `ctx.processStart` (L939).
- `tools/device/observe-thread.mjs` (new) -- `observeHost` and `observeOffThread`. Use `emulator-thread.mjs` as the model: plain env, `execArgv: []`, terminate on settle, and do nothing when imported on the main thread.
- `tools/hub-api/snapshot.mjs` (new) -- `createSnapshot`. The pattern is `readings.mjs`: one gather in flight, started only by a read.
- `tools/hub-api/readings.mjs` -- `deviceCtx` (L20) also forwards `adbQuery`, `processStart` and `liveStart`.
- `tools/hub-api/routes.mjs`:
  - `statusDocument` (L173) awaits `ready()` and forwards the seams into `createContext` (L180).
  - `discovery` (L148) awaits `ready()`.
  - `serviceContext` (L296) forwards `processStart`.
- `tools/hub-api/server.mjs` `startHubApi` (L159) -- build the snapshot, the ctx seams, the readings probe and the first refresh after the bind. `startService` (L111) builds `createLeaseWaits`; pass `startOf` from the snapshot.
- Tests:
  - model the scaffold on `tools/hub-api/status.test.mjs` (`scratch()` at L31);
  - the month fixture is `tools/device/hub-device.test.mjs` L1147. Extract it to `tools/ci/test-fixtures.mjs` `writeMonthOfEvents(dir, {now, lines})` and use it in both;
  - waits are driven as in `tools/hub-api/waits.test.mjs`;
  - `strip` comes from `tools/clock.test.mjs`.

## Tasks & Acceptance

**Execution:**
- [ ] `tools/ci/lib/lock.mjs` -- a `startOf` seam on `staleness`, `liveLease` and `listLocks`, passed by the acquire paths -- so every staleness check of a service uses its one cached reader
- [ ] `tools/device/emulator.mjs` -- a `liveStart` seam on `emulatorStatus` -- so emulator pid checks are read from the snapshot
- [ ] `tools/device/claims.mjs` -- the seams in `createContext`, `lockActivity`, `phoneObservations`, `statusView` and `discover`, with readings stamped at observation time -- one library, the same answers
- [ ] `tools/device/observe-thread.mjs` -- `observeHost` and `observeOffThread` -- the `/proc` scan and adb query off the main thread
- [ ] `tools/hub-api/snapshot.mjs` -- `createSnapshot` -- the in-memory snapshot every read answers from
- [ ] `tools/hub-api/server.mjs`, `tools/hub-api/routes.mjs`, `tools/hub-api/readings.mjs` -- wire the snapshot into the context, the waits and the readings probe -- AD-44 for every read and wait
- [ ] `tools/ci/test-fixtures.mjs` -- `writeMonthOfEvents`, and switch `tools/device/hub-device.test.mjs` L1147 to it -- one month fixture
- [ ] `tools/hub-api/snapshot.test.mjs` (new) -- the snapshot's unit rules (cold pid, old snapshot, single flight, failure) and the real-worker row
- [ ] `tools/hub-api/event-loop.test.mjs` (new) -- the blocking-start-while-waiting, month-of-events and uncontended-take rows, plus a conformance scan: no `spawnSync`/`execSync`/`execFileSync` in non-test `tools/hub-api/*.mjs` and `tools/host-agent/*.mjs` (when that directory exists), and no import of `inventory.mjs` there. Prove the detector on a synthetic sample.
- [ ] `tools/ci/process-start-seam.test.mjs` (new) -- `listLocks`, `liveLease` and `emulatorStatus` with an injected start reader use it (a Lease whose recorded start differs reads `stale`/`holder-gone` only through the seam), and an acquire that finds a holder-pid Lease consults the seam it was given
- [ ] `README.md` -- one Hub API sentence: reads come from a host snapshot gathered in a worker, which a read refreshes once per 2 s pass
- [ ] verification -- `heavy mise run check`

**Acceptance Criteria:**
- Given the running Hub API context, when `GET /status`, `GET /discovery` or `GET /resources` answer, then none of them calls `inventory()`, the adb wire or the injected `processStart` on the request path once the snapshot is warm, and `/status` answers in under 200 ms with a 200 ms blocking `processStart` while a lease wait spins.
- Given `node --test tools/hub-api/event-loop.test.mjs`, when the conformance scan runs, then no service file calls `spawnSync`, `execSync` or `execFileSync`, and the detector fails on a sample that does.
- Given an uncontended `POST /leases` against fakes, when it runs, then it answers in under 1 s.
- Given HEAD, when `mise run check` runs, then it is green and every existing status, discovery, readings and wait test passes unchanged, apart from the extracted fixture.

## Spec Change Log

## Review Triage Log

### 2026-11-25 — Review pass
- verdicts: 29 findings — high 0, medium 5, low 17, false 7, maybe-false 0
- findings:
  - `medium` `defer` (Blind) A gather has no timeout, and the stop path never aborts it. A hung worker leaves `inflight` set forever. — Real: `ready()` hangs on the first gather. After one success the snapshot just stops refreshing. It is pre-existing, because the same `inventory()` hung the main thread before this story. The fix is a timer, which the spec's Never forbids. Deferred with that note.
  - `low` `reject` (Blind) A failing gather retries on every read with no backoff. — Single flight bounds it to one worker at a time, which is the same rate as a healthy refresh. The spec mandates "the next read retries". Persistent failure is rare and backoff adds state.
  - `low` `reject` (Blind) The snapshot's age is not exposed on the status document. — Only an old snapshot after repeated logged `HUB_API_OBSERVE_FAILED` lines makes this matter. Exposing it needs a new response key, which is forbidden.
  - `low` `patch` (Blind) The README's retained 8.1 text ("Nothing is cached", "reads its own host fresh") contradicts the 8.2 sentence. — Reworded: `/status` is rebuilt per request from the snapshot, and nothing derived from time is cached.
  - `low` `patch` (Blind) `docs/hub-api-contract.md` says nothing about the snapshot or its log lines. — Added a snapshot sentence to the `/discovery` paragraph covering the worker gather, the 2 s pass, the first read waiting and `HUB_API_OBSERVE_FAILED`. Reworded "Nothing is cached". Release notes are written at release time.
  - `low` `reject` (Blind) `/discovery` and Pool selection use a possibly old snapshot. — `/discovery` is at most one 2 s pass old, by design. The Pool half is false: the service's `reachableMembers` goes through `statesOf`, the readings cache (claims.mjs:626-630), not the snapshot.
  - `low` `reject` (Blind) The `chased` map can grow without bound. — It holds one small entry per distinct lock-owner pid that leaves before the next gather. That is negligible for a service, and pruning needs new settle logic.
  - `low` `reject` (Blind) The cold-pid path is untested at the service level. — The matrix row is unit-tested in snapshot.test.mjs, and the fallback reader is the existing `cachedProcessStart`.
  - `low` `reject` (Blind) The NFR timing tests are weak and flaky, and `etaHistory` parses the Event Log synchronously. — The matrix specifies best of 3. Event Log reads are disk reads the spec keeps on the request path. The full check ran green.
  - `low` `patch` (Blind) The conformance scan is narrow, and `strip` is imported from a test file. — Real: importing clock.test.mjs re-ran its tests. `strip` moved to `tools/ci/lib/source-scan.mjs`. The rest is rejected. The scan's reach is exactly the AC's (`tools/hub-api/*.mjs`, `tools/host-agent/*.mjs`). The `//` strip in the import check is deliberate, because `strip()` blanks the specifier string.
  - `low` `patch` (Blind) Several assertions are loose: the busy predicate, `lease_id ?? id`, and unused imports. — The busy check now asserts `HUB_LOCK_TIMEOUT` and the take asserts `lease_id`. The unused-import claim is false: `mkdirSync` and `writeFileSync` are still used 33 times in hub-device.test.mjs.
  - `false` `reject` (Blind) Wait load is not bounded, because waits poll the lock dir synchronously. — The AC requires wait loops to use the cached process-start seam, and they do (`createLeaseWaits({startOf})`). Lock-dir reads are small disk reads the spec keeps on purpose.
  - `medium` `defer` (Edge) A worker hang means `inflight` never clears and `ready()` never resolves. — Same root cause as the first row, and deferred with it.
  - `low` `reject` (Edge) The readings probe stamps an old snapshot's reachability as freshly probed. — This happens only after a failed refresh. On the normal path `refresh()` has just settled, so the age is under one gather. Fixing it adds a freshness branch to the probe.
  - `low` `reject` (Edge) The inventory is served indefinitely old with no marker. — Same root cause as the status-age row: rare, logged, and it would need a forbidden new key.
  - `false` `reject` (Edge) If the clock steps backward, every read starts a gather. — The next gather stamps `taken_at` from the stepped clock, so the age is non-negative again after one gather. Single flight bounds it meanwhile.
  - `low` `patch` (Edge) `strip` is imported from `../clock.test.mjs`. — Same root cause as the conformance-scan row, and fixed by the same move to `tools/ci/lib/source-scan.mjs`.
  - `low` `patch` (Edge) Service write paths still call the uncached global `processStart`: `phoneWaiting`, the registryList `lockActivity`, extend, release, the no-phone error and force-release. — `ctx.processStart` is now threaded through all of them (`extendLease` takes the reader). The default with no ctx reader is unchanged, so the CLI is unchanged.
  - `low` `reject` (Edge) `/resources` readings discard the snapshot's `at`. — Same root cause as the readings-probe row, and rejected with it.
  - `medium` `patch` (Verification gap) No test detects a `statusView` site that bypasses the start-reader seam. — Added a hermetic test in process-start-seam.test.mjs: a Lease holder pid, a waiter ticket and an emulator record must reach recording `processStart`/`liveStart`. Mutation-checked: dropping each seam fails it.
  - `medium` `patch` (Verification gap) `/discovery`'s use of the snapshot `adbQuery` is unasserted. — Added a `startHubApi` test with a fake `observe` that holds an unnamed device and no `adbWire`. Mutation-checked: dropping `adbQuery` from `deviceCtx` fails it.
  - `medium` `patch` (Verification gap) `observeHost`'s recording of ticket and emulator pids is not pinned. — The test now also covers a live ticket, a stale ticket and an emulator record. Mutation-checked: removing the `lockNames` loop or the `emulatorStatus` recording fails it.
  - `low` `patch` (Verification gap) process-start-seam.test.mjs:73 accepts any error. — Same root cause as the loose-assertions row. It now asserts `HUB_LOCK_TIMEOUT`.
  - `false` `reject` (Verification gap) The source-text scans are not behavioral verification. — The AC itself specifies a conformance scan, and the behavioral property is tested separately in event-loop.test.mjs.
  - `false` `reject` (Intent) Cache extent: the snapshot covers host observations only, while the lock dir, registry and Event Log are read per request. — AC2 lists exactly what must leave the main thread (`/proc` scans, `inventory()`, adb queries, `provision`, wait loops), and the diff moves all of them. The measurable ACs are met.
  - `false` `reject` (Intent) The 200 ms seam test proves only the warm path. — The AC asks for an injected 200 ms `processStart` with `/status` under 200 ms. That is what the test asserts, and the cold path is a unit-test row.
  - `low` `reject` (Intent) No single end-to-end test combines the real worker and the real listener. — Each half is tested (the real worker in snapshot.test.mjs, the listener in event-loop.test.mjs). Joining them would add host state to a hermetic suite.
  - `false` `reject` (Intent) The conformance scan does not follow imports. — The AC names the scan's reach as `tools/hub-api/*.mjs` and `tools/host-agent/*.mjs`, which is exactly what it scans.
  - `false` `reject` (Intent) Nothing asserts that a forward reports `duration_ms`. — No forward route exists in the Hub API (routes.mjs has none). The clause binds the first forward, in Story 9.3.

### 2026-11-25 — Review pass (follow-up)
- verdicts: 36 findings — high 0, medium 3, low 25, false 8, maybe-false 0
- findings:
  - `medium` `defer` (Blind) A gather has no timeout, and the service stop never aborts it, so a hung worker hangs the first `ready()` or freezes the snapshot. — carried: same location (snapshot.mjs `gather()`, no signal) and same claim as the first pass's deferred row; the code still reads that way. Not deferred again.
  - `low` `reject` (Blind) There is no backoff after a failed gather. — carried: first pass rejected it (single flight bounds it; the spec says the next read retries).
  - `low` `patch` (Blind) The README says "a snapshot is never more than one pass old for what it holds", but an old snapshot is served at once after an idle spell. — Real: `ready()` resolves immediately once any snapshot exists, and `inventory()`/`adbQuery()` answer from it while the refresh runs. Reworded the README: an old snapshot answers at once and that read starts the refresh; the inventory and adb listing can be as old as the last read; a process start is trusted only within one pass.
  - `low` `patch` (Blind) The contract doc is only half updated for `/status`. — Partly real. The per-row `checked_at` text ("when the host read it") is already right, and `HUB_API_REACHABILITY_FAILED`, the sibling log line, isn't listed either. The `/status` paragraph listed its sources as the lock dir, the Registry, the Event Log and the clock, and left out the snapshot. Added the snapshot to that sentence.
  - `false` `reject` (Blind) Lease-wait polling is a hidden timer that gathers every 2 s. — A wait is a read: the intent says every wait reads the snapshot, and a read that finds the snapshot old starts one gather. The gathers last only as long as the open request and stay single flight. Nothing reschedules itself.
  - `low` `reject` (Blind) Every gather starts a new Worker. — The startup cost is real but bounded, at one worker per pass at most. A long-lived worker is a design change with its own lifecycle and crash handling, and nobody meets this cost in everyday use.
  - `low` `reject` (Blind) The `chased` map grows without bound. — carried: first pass rejected it (one small entry per departed pid).
  - `low` `reject` (Blind) The conformance scan is too narrow, its file count is a magic number, and comment stripping is imperfect. — carried: the scan's reach is the AC's, and the `//` strip is deliberate. Both were logged on the first pass.
  - `low` `reject` (Blind) The wall-clock timing assertions can flake on a shared box. — carried: the matrix specifies best of 3. The full check is green.
  - `low` `reject` (Blind) `emulatorStatus` inlines its own copy of `sameProcess`. — The copy is a one-line predicate. Unifying them adds a parameter to `sameProcess` and all its kill and boot callers, and nothing there drifts today.
  - `low` `patch` (Blind) The test scaffolding is loose: `boot()` spreads frozen copies of `observed` and `started`, and clock.test.mjs still re-exports `strip`. — Both are real dead code. A test asserting `svc.started` would always see 0, and nothing imports `strip` from clock.test.mjs. Deleted the `...state` spread and the `export { strip }` re-export. `state.blocked` is the log sink and stays.
  - `low` `reject` (Blind) No test covers a stop while a gather is in flight, or a worker that cannot start. — A stop waits for at most one gather, and a worker that cannot start rejects through the same `HUB_API_OBSERVE_FAILED` path the rejecting-`observe` test covers. The hung case is the deferred row.
  - `false` `reject` (Blind) The snapshot's `adbQuery` ignores its port argument. — The service's env is fixed at `startHubApi`, and `discover` reads its port from that same env. The gather also asked `HUB_ADB_SERVER_PORT` from that env, so the two ports cannot differ.
  - `low` `reject` (Edge) A gather that takes longer than 2 s is born old, so reads keep refreshing and starts go through the fallback. — Real only when a gather exceeds `JOB_POLL_MS`, such as a wedged adb probe. Even then a start costs one cached read per pid per pass, which is the bound from before this story, and single flight bounds the gathers. Fixing it needs a separate settled-at clock: new state for a rare case.
  - `low` `reject` (Edge) The readings probe stamps an old or empty snapshot after a failed gather as fresh. — carried: first pass rejected it.
  - `low` `reject` (Edge) The `/resources` readings take the probe time and drop the snapshot's `at`. — carried: first pass rejected it.
  - `low` `reject` (Edge) After an idle spell `ready()` serves an arbitrarily old inventory, so `/discovery` needs a second request to show a just-paired phone. — Real, but the intent's "Old snapshot" row mandates it: the read answers from the old snapshot at once and starts one refresh. The README now says so (the README patch above).
  - `low` `patch` (Edge) The README claims a snapshot is at most one pass old. — Same root cause as the Blind README row. Fixed by the same rewording.
  - `low` `patch` (Edge) Asking again for a pid while its gather is in flight re-stamps the chase. That gather can then never settle it, so every poll starts another. (The growth half is carried, rejected.) — Real: `chased.set(pid, now())` ran on every unsettled ask, after `refresh()`. Now only the first ask is stamped, before `refresh()`, so the gather it started or joined settles it. New snapshot.test.mjs case; mutation-checked: restoring the old line fails it.
  - `low` `reject` (Edge) A persistent failure has no retry backoff. — carried: same as the Blind backoff row.
  - `low` `reject` (Edge) A stop while a worker is in flight never aborts it, which delays exit and lets a late gather write the snapshot. — The delay is at most one gather, which ends and terminates the worker on its own. A write into a stopped service's memory reaches nobody. Abort plumbing in `stop()` is new surface; the hung case is deferred.
  - `medium` `patch` (Verification gap) Nothing pins `startHubApi`'s default gather to a worker thread. — Added an event-loop.test.mjs case. It boots with no `observe`, `inventory` or `adbWire` and an adb port nobody listens on, subscribes to the `worker_threads` diagnostics channel, and asserts that `/status` was served after a gather in a worker (threadId ≥ 1). Mutation-checked: making the default the in-thread `observeHost` fails it.
  - `medium` `patch` (Verification gap) The reader seam on the `acquirePool` and claims write paths is unasserted. — Added two process-start-seam.test.mjs cases. In the first, a Pool take on a holder-pid Lease consults the given reader (`HUB_LOCK_TIMEOUT`) and takes the member over when the reader says the pid was reused. In the second, `forceReleaseLease` finds the Lease through `ctx.processStart`. Mutation-checked: dropping `startOf` from the `acquirePool` staleness call, or `readerOf(local)` from `forceReleaseLease`, fails them.
  - `low` `reject` (Verification gap) The default-path service tests start a real worker that reads `/proc` and may ask an adb server on 5037. — The host reads aren't new: before this story, the same `/status` path ran the same `inventory()` and adb rule on the main thread. Nothing asserts the gather's result. The fix rewrites three existing tests' scaffolding, which the AC holds unchanged.
  - `low` `reject` (Verification gap) The conformance scan misses `claims.mjs` fallbacks. — carried: the scan's reach is the AC's.
  - `low` `reject` (Intent) The cold-pid row is tested only at module level. — carried: first pass rejected it.
  - `low` `reject` (Intent) The old-snapshot row is tested only at module level. — The service delegates to the snapshot's accessors unchanged, and the module test pins the rule. An HTTP-level copy adds no coverage of new code.
  - `false` `reject` (Intent) The diff does not implement the outcome reading: the fallback reads on the main thread, and the first request waits for the first gather. — The intent's Always mandates both: the shared `cachedProcessStart` fallback for an old snapshot or an unseen pid, and `await ctx.snapshot?.ready()` before the first answer.
  - `false` `reject` (Intent) No test runs a slow gather alongside a read. — carried: same as the first pass's warm-path row (the AC asks for the warm-path proof).
  - `false` `reject` (Intent) The real-worker thread id is inferred on the main side. — `worker.threadId` is the id of the thread the gather ran on, so it is direct evidence. The new default-path test checks the same thing through the diagnostics channel.
  - `false` `reject` (Intent) `spawnSync` is still reachable at runtime through the fallback. — The Never clause is about source in `tools/hub-api/*.mjs`, and the fallback through `lock.mjs`'s reader is the one the intent mandates. The in-thread gather runs only under injected test seams.
  - `low` `reject` (Intent) The `/resources` readings are stamped at probe time. — carried: first pass rejected it.
  - `low` `patch` (Intent) The README claims more freshness than the code gives. — Same root cause as the Blind README row. Fixed by the same rewording.
  - `false` `reject` (Intent) Reachability's `checked_at` can now be older than `received_at`. — The intent requires exactly that: a reading is stamped with the adb answer's `checked_at`, never with the request time. No key changed.
  - `low` `reject` (Intent) `createLeaseWaits` wraps the snapshot reader in a second `cachedProcessStart`. — It is redundant, but both layers use the same pass-long TTL, so no answer changes. Removing it changes `startService`'s default for injected contexts.
  - `false` `reject` (Intent) `lock.mjs`, which the deploy path shares, was edited. — Every edit is a reader seam that defaults to the global `processStart`, so the deploy path's behaviour is unchanged. The full check is green.

## Design Notes

The snapshot holds only *observations of the host*. It never holds the lock dir, which is read from disk on every request (small sync reads that AD-44 does not name) so that a lease written a millisecond ago shows at once and `stale`/`expected_end`/grace stay derived from `now` (Story 8.1's note). Process starts are the bridge: a start value is trusted only within one pass (`JOB_POLL_MS`, 2 s), which is the bound `cachedProcessStart` already gives the waits. A snapshot start older than that falls through to the cached reader, so a pid reused between a gather and a take can never read as `holder-gone` for longer than today's cache allows.

Why a gather can't use the test's blocking seam: functions do not cross into a worker. The worker always uses the real readers, and the injected `processStart` is the main-thread fallback. That is exactly what the 200 ms test must prove is never called once the snapshot is warm.

Story 8.3 replaces the adb half of the snapshot with the track socket. Story 8.5's watcher re-read will call `refresh()`. Both keep this module.

## Verification

**Commands:**
- `node --test tools/hub-api/snapshot.test.mjs tools/hub-api/event-loop.test.mjs tools/hub-api/status.test.mjs tools/hub-api/reachability-discovery.test.mjs tools/hub-api/waits.test.mjs` -- expected: all pass
- `heavy mise run check` -- expected: green


## Auto Run Result

Status: done (follow-up review pass)

**Summary:**
- Story 8.2 was already implemented. The Hub API's reads and waits answer from one in-memory host snapshot: the `/proc` inventory, the adb listing, and the process starts of the pids the lock dir names. A worker thread gathers it, at most once per 2 s pass, and a read starts each gather; no timer does.
- This pass re-reviewed the whole change since `56b4cc60e4aff9f9f72d0047af289bc599332f03` with four layers. It fixed one snapshot bug, added three regression tests, and corrected two docs that claimed more freshness than the code gives.

**Files changed in this pass:**
- `tools/hub-api/snapshot.mjs`: a chase records only the first ask for a pid, before the refresh, so the gather that ask started or joined settles it. Before, a re-ask during the gather re-stamped the chase, and every poll started another gather.
- `tools/hub-api/snapshot.test.mjs`: a case pinning that rule.
- `tools/hub-api/event-loop.test.mjs`: a default-wiring case. It boots with no `observe`, `inventory` or `adbWire`, and the `worker_threads` diagnostics channel must show the gather ran in a worker. The dead `...state` spread in `boot()` is removed.
- `tools/ci/process-start-seam.test.mjs`: two cases, an `acquirePool` take and `forceReleaseLease`, each of which must consult the reader it was given.
- `tools/clock.test.mjs`: the unused `export { strip }` re-export is removed.
- `README.md`: the Hub API sentence now says an old snapshot answers at once and that read starts the refresh, and that a process start is trusted only within one pass.
- `docs/hub-api-contract.md`: the `/status` paragraph names the host snapshot as a source.

**Review findings breakdown (36: high 0, medium 3, low 25, false 8, maybe-false 0):**
- **Patched (6 entries, 8 rows):**
  - medium: the default gather is pinned to a worker; the reader seam is pinned on `acquirePool` and `forceReleaseLease`.
  - low:
    - the README freshness claim (3 rows);
    - the contract doc's `/status` sources;
    - dead test scaffolding and the `strip` re-export;
    - the chase re-stamp.
- **Deferred:** nothing new. The gather with no deadline is carried from the first pass and already in `deferred`.
- **Rejected (27: 19 low, 8 false):**
  - low, carried from the first pass (10):
    - backoff after a failed gather (2 rows);
    - `chased` growth;
    - scan narrowness (2 rows);
    - timing flake;
    - the probe stamping after a failure;
    - `/resources` stamped at probe time (2 rows);
    - the cold pid tested at module level only.
  - low, new (9):
    - a Worker per gather (bounded cost, needs a redesign);
    - the `sameProcess` duplicate (one line; unifying adds a parameter);
    - the stop and failure test gaps (one gather at most; the hung case is deferred);
    - a slow gather born old (falls back to the pre-story bound; rare);
    - `/discovery` after idle (mandated by the intent's Old snapshot row);
    - stop not aborting the worker (at most one gather; new surface);
    - default-path hermeticity (the same host reads as before the story; changing it rewrites tests the AC holds unchanged);
    - the old-snapshot row tested at module level only (the service delegates unchanged);
    - the double `cachedProcessStart` in waits (same TTL, no answer changes).
  - false (8):
    - wait polling is a timer (a wait is a read);
    - the `adbQuery` port (the env is fixed);
    - the outcome reading (the intent mandates the fallback and the first-read wait);
    - the slow gather alongside a read (carried);
    - the thread-id inference (it is the worker's own id);
    - runtime `spawnSync` (the mandated fallback);
    - `checked_at` older than `received_at` (intended);
    - `lock.mjs` edits (they default to the global reader).

**Follow-up review recommendation: false.** This is a follow-up pass and it patched no high entry (0 high, 2 medium, 4 low). The work has converged.

**Verification:**
- The spec's targeted command over snapshot, event-loop, status, reachability-discovery and waits: 76/76 pass.
- `heavy mise run check` (actionlint and the full suite): green, 1487/1487. That is 4 new tests on top of the first pass's 1483.
- Each new test was mutation-checked:
  - restoring the old chase line fails the snapshot case;
  - dropping `startOf` from `acquirePool`'s staleness call fails the Pool case;
  - dropping `readerOf(local)` from `forceReleaseLease` fails the force-release case;
  - making the default gather the in-thread `observeHost` fails the worker case.

**Residual risks:**
- The gather has no deadline (deferred). A hung worker hangs the first `ready()`.
- The new default-wiring test, and three existing service tests, start a real worker that reads the host's `/proc`. The new test points the adb port at one nobody listens on, so it never asks an adb server.
- The 200 ms and month-of-events budgets are wall-clock assertions on a shared box.
