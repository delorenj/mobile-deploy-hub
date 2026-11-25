---
title: 'Story 7.8: Force-release an emulator slot'
type: 'feature'
created: '2026-11-25'
status: done
baseline_revision: '7e87ab643ac226b58ef7b51564055b9e29b7e007'
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-7-context.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-7-6-force-release-a-lease.md'
  - '{project-root}/docs/hub-api-contract.md'
warnings: ['oversized']
deferred:
  - summary: >-
      A slot whose owner or emulator record belongs to another host would be force-released and its record deleted.
    evidence: |-
      Unverified (maybe-false). forceReleaseEmulator and forceReleaseSlot do not check sameHost on the owner or the record, while doomed() does. Settle by confirming whether any supported topology lets a host other than the one running the emulators take an emulator-<n> lock in this lock dir (today emulators run and are served only on big-chungus); if one does, refuse a foreign owner before the force and skip a foreign record in the teardown.
    location: >-
      tools/device/claims.mjs forceReleaseEmulator; tools/device/emulator.mjs forceReleaseSlot
    severity: medium (unverified)
---

<intent-contract>

## Intent

**Problem:** A stuck emulator Lease (a forgotten `lease emulator --for 8h`, an agent that died holding an API Lease with `holder_pid: null`) keeps its slot and its running emulator until expiry. Story 7.6 refuses to force-release an emulator lease id (`HUB_USAGE reason: emulator`, pointing at `force-release emulator-<n>`), and nothing serves that verb or the API equivalent yet.

**Approach:** One Claims function `forceReleaseEmulator(slot, {why, actor}, ctx)` runs AD-38's order: read the slot's owner and emulator record; under the `emulator-reaper` lock call `lock.mjs` `forceRelease(slot, {lease_id})` (the one `force-release` event, carrying `lease_id`); tear down and remove the record with `releaseEmulator(id, {alreadyReleased: true})`; release the reaper lock. `hub-device force-release emulator-<n> --why` and `POST /leases/emulator-<n>/force-release` both call it (belsky-doctrine: one level up from "kill Jarad's stuck emulator-1" is "any slot `emulator-1..MAX_POOL` of this host, from every front door, crash-safe", so the Host Agent and the v1c page inherit it).

## Boundaries & Constraints

**Always:**
- `lock.mjs` stays the only protocol writer (AD-1): the slot ends only through `forceRelease`; `emulator.mjs` owns the reaper lock and teardown; `claims.mjs` owns validation, the order and the answer (AD-24); `routes.mjs` and `hub-device.mjs` only check the body / parse and print.
- An actor `{holder, via}` and a non-empty `why` are required and recorded on the one `force-release` event; no holder check, no confirmation (NFR-6).
- Exactly one hold-ending event per forced Lease, also across crashes: the teardown with `alreadyReleased` writes no `release`; the next reap of the ownerless record finds no slot lock and writes nothing (`releaseLease` → `none`).
- A service runs the reaper lock, the force-release and the teardown in a `node:worker_threads` worker (AD-44, new `emulator-thread.mjs` op `force-release`); the CLI runs them in-process.
- The slot stays unclaimable while its record exists (provision already skips slots with records; keep it).
- Node 24 ESM `.mjs`, no deps, no timers in new non-test code; tests hermetic (`hermetic()`, the emulator fakes in `emulator-fixtures.mjs`, no real emulator/adb/`heavy`). `git diff main -- tools/ci/lib/eta.mjs` stays empty.

**Never:**
- Never force-release by emulator lease id (`e-…`): 7.6's refusal stays; never force-release the `emulator` gate.
- Never take the reaper lock twice in one call (it is not re-entrant: `alreadyReleased` skips `underReaper`).
- Never kill by name, pattern or group; never touch another host; never add a second lock, queue or store.
- Never write `_bmad-output/implementation-artifacts/sprint-status.yaml`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Happy path (CLI) | `e-a` holds `emulator-1`, booted; `hub-device force-release emulator-1 --why stuck` | stdout `HUB_DEVICE_FORCE_RELEASED emulator-1 e-a holder=<holder>`, exit 0; slot lock gone, record gone, recorded pids dead, AVD/runtime/tmp folders gone; events for `e-a` after its acquire: exactly one `force-release` (`lease_id: 'e-a'`, `hold_kind: 'lease'`, `actor`, `why`) and no `release`/`reclaim` | — |
| Happy path (API) | same; `POST /leases/emulator-1/force-release {why:'stuck', holder:'ops'}` | 200 `ForceRelease` `{lease_id:'e-a', outcome:'force-released', resource:'emulator', lock:'emulator-1', device:'emulator', holder, why}`; teardown ran in a worker (`HUB_EMULATOR_THREAD force-release`) | — |
| Parity | same setup once per front door | answers equal; event logs equal ignoring `ts` and `actor.via` | — |
| Next lease | after a force of `emulator-1` with pool 1 | `lease emulator` gets `emulator-1` with a new record; `status --json` lists no waiter or Hold of `e-a` | — |
| Crash after force-release | seam crashes the process after `forceRelease` (reaper lock left held by a dead pid) | ownerless record left; a `lease emulator --wait 0` while another live process holds the reaper finds the slot unclaimable (pool full); the next `reap` reclaims the stale reaper lock, tears the record down as `orphaned`, writes no event | — |
| Crash after read / after teardown | seam throws after step 1, or after the teardown | after read: nothing changed; after teardown: record and slot gone, reaper lock reclaimable, still one event | — |
| Empty / no slot lease | slot lock absent | 404 `HUB_LEASE_NOT_FOUND` `reason: unknown`, exit 2, nothing written | — |
| Being taken | slot dir exists, no owner record | 409 `HUB_LEASE_LOST` `being-taken`, exit 1, nothing written | — |
| Changed hands | owner replaced between read and rename | 409 `HUB_LEASE_LOST` `changed-hands`, nothing torn down | — |
| Stuck teardown | a recorded process survives SIGKILL | the force stands (event written, slot gone); 503 `HUB_EMULATOR_FAILED`, exit 1, detail names the survivors; record kept so the next reap retries | — |
| Reaper busy | another teardown holds `emulator-reaper` past the wait | `HUB_LOCK_TIMEOUT` 409 exit 76, nothing written | — |
| Bad input | `emulator-0`, `emulator-9` (> `MAX_POOL`), empty/missing why, no actor | 400 `HUB_USAGE` (`bad-slot`, `no-why`/`bad-why`, usage) exit 2 before any read | — |

</intent-contract>

## Code Map

- `tools/device/emulator.mjs` -- `REAPER` l.35 (private); `slotName`/`isEmulatorLock` l.31–32 (add `isEmulatorSlot`, `emulator-<n>` with 1 ≤ n ≤ `MAX_POOL`); `teardown` l.257; `reap` l.304 (orphan path `releaseLease(record.slot, id, {reason: reaped-orphaned})` l.313: writes nothing when the slot lock is gone); `underReaper` l.347 (wraps `withLock(REAPER, …, {timeoutMs: 120_000})`); `releaseEmulator` l.360 (add `alreadyReleased`: skip gate/slot `releaseLease` and `underReaper`, tear down directly; caller holds the reaper); `provision` l.514 (skips slots with records l.545–547; its `stillOurs`/`rewritten` already ends a boot whose slot vanished as CANCELLED).
- `tools/ci/lib/lock.mjs` -- `forceRelease(name, {actor, why, lease_id, env, now, log, beforeRetire})` l.1873 (returns `{released, owner}` / `{released:false, reason: none|unknown-holder|other-lease|changed}`; throws `HUB_FORCE_RELEASE_JOB` for a job owner); `withLock` l.348 (bare mkdir for `emulator-reaper`, not re-entrant; a dead-pid owner is stale and reclaimed); `releaseLease` l.1804.
- `tools/device/emulator-thread.mjs` -- `THREAD_OPS` l.18 and `work()` l.70: add op `force-release` calling the new emulator.mjs composite; `carried` keeps `code`/`reason`.
- `tools/device/claims.mjs` -- imports l.29/34–35; `checkWhy` l.1330, `checkForceReleaseBody` l.1339 (reuse unchanged); `forceReleaseLease` l.1367 (refusal text l.1375 for `e-…` ids: also name `POST /leases/emulator-<n>/force-release`); `emulatorFailure` l.584; `serviceLocal` l.1154; `leaseNotFound`, `failure`, `usage`, `bodyUsage`, `readOwnerOf` l.140, `resourceOf`. Add `forceReleaseEmulator` and re-export `isEmulatorSlot`.
- `tools/hub-api/routes.mjs` -- `forceReleaseLeaseRoute` l.317 (dispatch: `isEmulatorSlot(params.id)` → `forceReleaseEmulator(id, …, {...serviceContext(ctx), offThread: true})`); `serviceContext` l.265 (pass a `forceReleaseOffThread` seam through like `releaseOffThread`).
- `tools/device/hub-device.mjs` -- header l.63–66, `forceRelease` l.377 (make async, dispatch slot ids), `main` dispatch l.814 (`return await`), `USAGE` l.132.
- `docs/hub-api-contract.md` -- route row l.38, `### ForceRelease` l.172, force-release paragraph l.313–320, error rows l.354/360/363 (+ `HUB_EMULATOR_FAILED`, `HUB_LOCK_TIMEOUT` rows mention the slot case).
- Tests: `tools/device/emulator-fixtures.mjs` (`fixture()`: `run`, `owner`, `record`, `records`, `clean`, `cleanup`, `state`); `tools/hub-api/emulator-lease.test.mjs` l.30–60 (`service()` helper with its own port ranges 25100-25199 / 5700-5798, `s.gone()`); `tools/device/emulator.test.mjs` l.607 (holding the reaper lock from a live process to keep `--wait 0` prompt); `tools/hub-api/force-release.test.mjs` l.210 (7.6 emulator refusal; must stay green); `tools/hub-api/contract.test.mjs` l.153 `POST_SAMPLES` (one sample per route path; slot case is exercised in the new suite); `tools/device/claims.test.mjs` l.53 export list.
- `README.md` -- l.284 Story 7.7 paragraph: add the Story 7.8 paragraph after it.

## Tasks & Acceptance

**Execution:**
- `tools/device/emulator.mjs` -- export `isEmulatorSlot`; `releaseEmulator(id, {…, alreadyReleased = false})`: with it, no gate/slot release and no `underReaper`, teardown of `readRecord(env, id)` directly (no record → `released` with nothing torn down); add `forceReleaseSlot(slot, {lease_id, actor, why, env, log, graceMs, sleep, now, afterStep})` that under `withLock(REAPER, …, {timeoutMs: 120_000})` calls `forceRelease(slot, {actor, why, lease_id, env, now, log})`, `afterStep('force-release')`, then (only when released) `releaseEmulator(lease_id, {alreadyReleased: true, …})`, `afterStep('teardown')`; returns `{released, reason, owner, outcome, survivors}` -- the composite lives beside the reaper it needs.
- `tools/device/emulator-thread.mjs` -- op `force-release` (args `slot, lease_id, actor, why, graceMs`) runs `forceReleaseSlot` in the worker; update header comment -- AD-44.
- `tools/device/claims.mjs` -- `forceReleaseEmulator(slot, input, ctx)`: actor required, `checkWhy`, `isEmulatorSlot` else `bodyUsage('bad-slot')`; `serviceLocal`; step 1 read owner (absent: lock dir exists → `HUB_LEASE_LOST being-taken`, else `HUB_LEASE_NOT_FOUND unknown`; job owner → `forceReleaseJobError`) and `readRecord(env, owner.lease_id)`; `ctx.afterStep?.('read')`; run `forceReleaseSlot` in-process, or with `ctx.offThread` via `ctx.forceReleaseOffThread ?? offThread('force-release', …)` (worker failures through `emulatorFailure`); map `changed`/`other-lease` → `HUB_LEASE_LOST changed-hands`, `unknown-holder` → `being-taken`, `none` → `HUB_LEASE_NOT_FOUND`; `stuck` → `HUB_EMULATOR_FAILED` naming survivors and that the force stands; answer `{lease_id, outcome:'force-released', resource, lock: slot, device: 'emulator', holder, why}`. Re-export `isEmulatorSlot`; tweak 7.6's refusal text -- one rule owner.
- `tools/hub-api/routes.mjs` -- dispatch slot ids in `forceReleaseLeaseRoute`; `serviceContext` passes `forceReleaseOffThread` -- thin route.
- `tools/device/hub-device.mjs` -- async `forceRelease` dispatching slot ids to `claims.forceReleaseEmulator` (same stdout line and `--json`); `return await` in `main`; header and `USAGE` add `force-release emulator-<n> --why TEXT [--holder WHO] [--json]` -- CLI front door.
- `docs/hub-api-contract.md`, `README.md` -- route row/paragraph: `{id}` may be `emulator-<n>`, the order, crash behaviour, the refusals; "Force-release an emulator slot (Story 7.8)" paragraph.
- `tools/hub-api/emulator-force-release.test.mjs` -- new: every matrix row through the CLI (in-process, `afterStep` seam) and the API (real worker); crash after force-release in a child `node` process (seam calls `process.exit`), then the not-claimable check while a live process holds the reaper, then `reap` with one-event assertion; parity; next-lease/status check; `tools/device/claims.test.mjs` export list gains `forceReleaseEmulator`.

**Acceptance Criteria:**
- Given a slot `emulator-<n>` holding a Lease, when `forceReleaseEmulator` runs, then it reads the owner and record, takes `emulator-reaper`, writes one `force-release` event carrying `lease_id`, tears the emulator down and removes its record, then releases the reaper lock (the order is observable through `afterStep` and the reaper lock being held during `forceRelease`).
- Given a crash after each step, when the next reap runs, then an ownerless record is torn down as an orphan with no second hold-ending event, and the slot is not claimable while its record exists.
- Given a forced slot, when the next `lease emulator` runs, then it gets a clean slot and `status` shows no waiter of the forced Hold ahead of it.
- Given `hub-device force-release emulator-<n> --why` and `POST /leases/emulator-<n>/force-release`, when they run, then both call `forceReleaseEmulator` and produce equal answers and events.
- Given `mise run check`, when it runs, then actionlint and the full suite pass (7.6's emulator-lease-id refusal test unchanged and green).

## Spec Change Log

## Review Triage Log

### 2026-11-25 — Review pass
- verdicts: 29 findings — high 0, medium 2, low 13, false 12, maybe-false 2
- findings:
  - `[false]` `[reject]` (blind) A Job Hold racing in through the worker surfaces as 503 HUB_EMULATOR_FAILED — `carried()` keeps the `HUB_` code, the main side rebuilds it, and `emulatorFailure` passes any error with an HTTP answer (HUB_FORCE_RELEASE_JOB is 409 in `HTTP_ANSWERS`); also no Job Hold ever takes an emulator slot.
  - `[low]` `[reject]` (blind) `HUB_EMULATOR_REAPER_WAIT_MS=0` falls back to 2 min and the knob is undocumented — an internal test knob nobody sets to 0; honouring 0 needs an empty-string guard branch.
  - `[low]` `[reject]` (blind) No verb retries a stuck teardown; a second force answers 404 — the matrix's own design (record kept, the next acquire's reap retries); a SIGKILL survivor is rare and a retry verb is new public surface.
  - `[false]` `[reject]` (blind) The event can't record the teardown outcome; a record without `pids` throws a TypeError in the log line — the event before the teardown is AD-38's order, and `readRecord` returns null unless `pids` is an array, so the log line cannot throw.
  - `[low]` `[reject]` (blind) Being-taken/not-found messages are written twice in Claims — cosmetic duplication of two literal messages; no caller diverges today, and a refactor helper is more than a direct correction.
  - `[low]` `[reject]` (blind) A user-chosen lease id `emulator-<n>` collides with slot dispatch — real (`checkLeaseId` does not reserve the shape), but lease ids are generated (`l-…`/`e-…`) and a custom `--id emulator-3` is very unlikely; the fix is a new acquire-time refusal (public surface). Recorded as a residual risk.
  - `[medium]` `[patch]` (blind) Missing tests: force-release of a booting emulator, concurrent forces, races with release/reap — grouped with the verification-gap booting finding; concurrent forces and races are settled by `forceRelease`'s rename (7.6 tests). Patched: booting test added.
  - `[low]` `[reject]` (blind) Missing tests for a slot above the configured pool and the CLI default actor — both reach already-tested paths (absent slot lock → 404; default actor is 7.6's CLI code).
  - `[false]` `[reject]` (blind) `settle(50)` makes the reaper-lock tests flaky; pid 1 needs /proc — `withLock`'s mkdir/stale-reclaim loop runs synchronously before its first await, so the lock is held when the call returns; the suite runs on Linux runners only.
  - `[low]` `[reject]` (blind) Doc hygiene: long README line, thread header wording, README/contract wording, contract rows, `lease_id` casing, silenced reaper log — cosmetic; the HUB_LEASE_LOST and HUB_FORCE_RELEASE_JOB rows already cover any `/force-release`, and the README's one-line paragraphs match the file's style.
  - `[false]` `[reject]` (blind) The record is read only for logging and can be stale — reading the owner and record is AD-38's step 1 as the spec orders it; decisions are made by `forceRelease`'s rename and the teardown's own `readRecord`, not by this read.
  - `[false]` `[reject]` (edge) The worker drops `repo`/`run`/`job` on a racing Job Hold refusal — unreachable: the only `withLock` takers are `adb`, `mac-ios`, `s3-*` and `emulator-reaper`, so no Job Hold can take `emulator-<n>` between the read and the rename.
  - `[low]` `[reject]` (edge) A teardown that throws (rmSync EACCES) after the event gives a bare error — every rmSync is `force: true` inside the lease's own folders; the same exposure exists in `releaseEmulator`'s normal path, and the fix is a new catch branch.
  - `[false]` `[reject]` (edge) HUB_EMULATOR_USAGE out of the worker becomes 503 — it has an HTTP answer (400) in `HTTP_ANSWERS`, and Claims checks the slot before the worker runs.
  - `[low]` `[reject]` (edge) The reaper timeout text says "Another deploy is using the device" — `withLock`'s pre-existing wording, shared with `underReaper`; `detail` still starts `host lock emulator-reaper is held`.
  - `[maybe-false]` `[defer]` (edge) A foreign-host owner or record of a slot would be forced and its record deleted — settle by whether any supported topology lets another host provision into this host's lock dir (today emulators run and are served only on big-chungus); medium if true. Deferred.
  - `[low]` `[reject]` (edge) Lease ids shaped `emulator-<n>` collide with slot dispatch — same root cause and route as the blind finding above.
  - `[false]` `[reject]` (edge) A booting Lease's gate hold lingers after a force — `provision` releases the gate in its `finally` once it has the slot, before the boot; a request still waiting holds no slot to force.
  - `[maybe-false]` `[reject]` (edge) A crash between `retire`'s rename and its event write leaves zero hold-ending events — settle by fault-injecting `lock.mjs` `retire`; pre-existing 7.6 code and only low if true (a sub-millisecond crash window).
  - `[medium]` `[patch]` (verification-gap) Force-release of a slot whose emulator is still booting is untested — patched: test spawns a booting `lease emulator` (`FAKE_BOOT_MS=60000`), forces `emulator-1`, asserts the force's line, the maker's `HUB_DEVICE_CANCELLED`, every pid gone, no record/slot/reaper lock, events `['acquire','force-release']`.
  - `[low]` `[patch]` (verification-gap) The `alreadyReleased` branch with no record is unasserted — patched: test kills the recorded pids and deletes the record, forces `emulator-1`, asserts exit 0, the slot and reaper locks gone, events `['acquire','force-release']`.
  - `[false]` `[reject]` (verification-gap other) Nothing pins the `bad-slot` vs `unknown` boundary for `emulator-reaper` — the dispatch test asserts `namesEmulatorSlot('emulator-reaper') === false`, so it goes to 7.6's path.
  - `[low]` `[reject]` (verification-gap other) `contract.test.mjs` has no emulator-slot sample of the route — one sample per path by design; the slot answer is the same `ForceRelease` shape and is deep-equalled in the new suite.
  - `[low]` `[reject]` (verification-gap other) The stuck-survivor test is skipped as root — CI and the dev box do not run the suite as root; the service-path stand-in covers the mapping.
  - `[false]` `[reject]` (intent) The route is overloaded on `/leases/{id}/force-release` rather than a slot route — AD-42 lists one force-release route; the contract documents `{id}` = `emulator-<n>`.
  - `[false]` `[reject]` (intent) The steps live in `emulator.mjs`, and the worker calls `forceReleaseSlot` — both front doors call `forceReleaseEmulator` (routes.mjs, hub-device.mjs); the worker is AD-44's executor of that same call.
  - `[false]` `[reject]` (intent) Tests use `handle()`/`main()` and fakes, not a live server or the installed binary — the repo's hermetic-test rule forbids live hosts; `handle()` is the HTTP handler and `main()` the CLI.
  - `[low]` `[reject]` (intent) No crash test between taking the reaper lock and the force — such a crash leaves only a dead-pid reaper lock, which `withLock` reclaims as stale (exercised by the crash-after-force test).
  - `[false]` `[reject]` (intent) Part A (awaiting-operator) — the story names no human-only action; status is `done` and sprint-status.yaml is untouched.

## Design Notes

The API reuses `POST /leases/{id}/force-release` (AD-42 lists no separate emulator route) with `{id}` = `emulator-<n>`, so the answer is the existing `ForceRelease` shape with the forced Lease's id; no new route, shape or error code. The dispatch predicate `isEmulatorSlot` is one export used by both front doors.

`forceReleaseSlot` sits in `emulator.mjs` because `REAPER`, `withLock` usage and `teardown` live there and the worker imports only `emulator.mjs`; `forceReleaseEmulator` in Claims owns the order's first step, the refusals and the answer, so both front doors still call one Claims function.

A forced slot whose emulator is still booting: `provision` sees the slot gone (`stillOurs`/`rewritten`), throws CANCELLED and its own teardown waits on the reaper lock, then finds nothing left. An ownerless slot (crash leftover) is 404; the next emulator acquire's reap tears it down.

## Verification

**Commands:**
- `node --test tools/hub-api/emulator-force-release.test.mjs tools/hub-api/force-release.test.mjs tools/device/emulator.test.mjs tools/hub-api/emulator-lease.test.mjs tools/hub-api/contract.test.mjs tools/device/claims.test.mjs` -- expected: all pass
- `heavy mise run check` -- expected: actionlint clean, full suite green
- `git diff main -- tools/ci/lib/eta.mjs` -- expected: empty

## Auto Run Result

Status: done
Operator actions: none (no acceptance criterion needs a human outside the repo).

**Summary.** `hub-device force-release emulator-<n> --why` and `POST /leases/emulator-<n>/force-release` now end the Lease holding any slot `emulator-1`..`emulator-8` of this host and tear its emulator down, through one Claims function `forceReleaseEmulator` in AD-38's order:
1. Read the owner and the record.
2. Under the `emulator-reaper` lock, write the one `force-release` event (`lock.mjs` `forceRelease`, carrying `lease_id`).
3. `releaseEmulator(id, {alreadyReleased: true})` tears the emulator down and removes its record, writing no second event.
4. Release the reaper lock.

A service runs steps 2-4 in the AD-44 worker (op `force-release`). A crash after the force leaves an ownerless record that keeps the slot out of the pool, and the next reap tears it down as `orphaned` with no event. Story 7.6's refusal of emulator lease ids stays and now also names the slot route.

**Files changed.**
- `tools/device/emulator.mjs`: `isEmulatorSlot`, `releaseEmulator`'s `alreadyReleased`, and `forceReleaseSlot` (reaper lock → force → teardown).
- `tools/device/emulator-thread.mjs`: worker op `force-release`.
- `tools/device/claims.mjs`: `forceReleaseEmulator` (validation, read, refusals, answer), the `namesEmulatorSlot` dispatch predicate, the `HUB_EMULATOR_REAPER_WAIT_MS` knob, and the 7.6 refusal text.
- `tools/hub-api/routes.mjs`: `forceReleaseLeaseRoute` dispatches slot ids; `serviceContext` passes the `forceReleaseOffThread` seam.
- `tools/device/hub-device.mjs`: async `forceRelease` dispatching slot ids, plus usage and header.
- `docs/hub-api-contract.md`: route row, the slot paragraph, the error rows.
- `README.md`: the "Force-release an emulator slot (Story 7.8)" paragraph.
- `tools/hub-api/emulator-force-release.test.mjs` (new, 20 tests): every matrix row, plus the booting and no-record cases.
- `tools/device/claims.test.mjs`: export list.

**Review findings.** 29 findings: high 0, medium 2, low 13, false 12, maybe-false 2.
- Patches applied (2 entries; patched counts: medium 1, low 1):
  - A test for force-releasing an emulator that is still booting. The maker ends `HUB_DEVICE_CANCELLED`, nothing leaks, there is one event. This also covers the blind layer's missing-test finding.
  - A test for the `alreadyReleased` no-record branch.
- Deferred (1): a foreign-host owner or record of a slot is not refused. Maybe-false; medium if true.
- Rejected, each with its reason in the Review Triage Log:
  - Low and unlikely, or the fix would add public surface: the reaper-wait knob at 0, no retry verb for a stuck teardown, duplicated messages, the `emulator-<n>` lease-id collision (blind and edge), missing pool/default-actor tests, doc hygiene, a teardown that throws, the reaper-timeout wording, the contract sample, the root-only skip, a crash between the reaper lock and the force.
  - False, refuted at the code: the 503 for a racing Job Hold, the record-log TypeError, the `settle(50)` flake, a stale record read, worker members lost (unreachable), HUB_EMULATOR_USAGE becoming 503, a lingering gate hold, the `emulator-reaper` boundary, the four intent-alignment divergences.
  - Maybe-false and low if true: the pre-existing 7.6 `retire` crash window.

**Follow-up review recommended:** false. The pass patched one medium and one low, both test-only, with no high.

**Verification.**
- Targeted suites (`emulator-force-release`, `force-release`, `emulator`, `emulator-lease`, `contract`, `claims`): 115/115 pass, 0 skipped.
- `heavy mise run check`: actionlint clean, 1415/1415 pass, 0 skipped.
- `git diff main -- tools/ci/lib/eta.mjs`: empty.
- Matrix audit: every row has a covering test that ran and passed.

**Residual risks.**
- A user-chosen lease id shaped `emulator-<n>` cannot be force-released by id, because the slot dispatch takes it. Lease ids are generated (`l-…`/`e-…`), so this needs a deliberate `--id emulator-3`.
- A teardown whose processes outlive SIGKILL leaves the slot out of the pool until the next emulator acquire's reap. A second force answers 404.
- Foreign-host slots are not refused (deferred above).
