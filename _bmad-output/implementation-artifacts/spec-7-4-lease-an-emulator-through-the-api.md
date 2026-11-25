---
title: 'Story 7.4: Lease an emulator through the API'
type: 'feature'
created: '2026-11-25'
status: 'done'
baseline_revision: 'a685f9136dc2946fe7b6f98d33ae33f41829047a'
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-7-context.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-7-3-extend-and-release-a-lease-with-a-recorded-override.md'
  - '{project-root}/docs/hub-api-contract.md'
warnings: ['oversized']
deferred:
  - summary: >-
      An emulator release through the API drops the request's actor: neither the slot `release` nor the gate `cancel` records who released it.
    evidence: |-
      serviceRelease passes only {id, graceMs} to the worker, and releaseEmulator takes no actor. This matches the CLI, whose emulator release records no actor either (the 7.3 README already says "an emulator release records no actor yet"), so it is parity with pre-existing behaviour, not a regression. The fix threads `actor` through releaseEmulator to both releaseLease calls, for the CLI and the API at once.
    location: >-
      tools/device/claims.mjs serviceRelease; tools/device/emulator.mjs releaseEmulator
    severity: low
  - summary: >-
      An emulator take with wait_ms > 0 through the service's wait registry (open waits, supersede, a stop ending a queued emulator request) has no test.
    evidence: |-
      Only no-wait emulator takes run through createLeaseWaits in tools/hub-api/emulator-lease.test.mjs. The open-wait path is the same serviceLease call with the registry's controller signal, so it probably works. To settle it, fill the pool, then POST an emulator with wait_ms through createLeaseWaits(). Assert a grant once a slot frees, a supersede by the same id, and that shutdown() leaves a Pool `cancel` (reason aborted).
    location: >-
      tools/device/claims.mjs createLeaseWaits
    severity: medium (unverified)
  - summary: >-
      An emulator take ignores a retired or seed-missing emulator Pool Resource: the word `emulator` (CLI and API) and the API's `profile=` match lease it anyway; only a `match` that runs the matcher (`kind=emulator-pool`) honours retirement.
    evidence: |-
      `withoutRetired` in claims.take checks only a `phone` target or a word Pool, never the `emulator` kind, so `hub-device lease emulator` has never honoured a retired emulator Pool (pre-existing). The 7.4 `profile=` branch of `matchTarget` with no other clause returns the emulator target without consulting the Registry, inheriting the same gap. The fix belongs in `take`: refuse HUB_RESOURCE_RETIRED for the emulator Pool's Resource when the Registry file marks it retired or seed_missing, so every front door gets it at once.
    location: >-
      tools/device/claims.mjs withoutRetired, matchTarget
    severity: low
---

<intent-contract>

## Intent

**Problem:** `POST /leases` refuses `emulator` (HUB_USAGE), and 7.3's extend/release routes refuse an emulator lease id, so an agent without a shell on big-chungus cannot get, keep or give back a booted emulator. The Pool size ignores the Registry, and `provision` would block the service's event loop on its `/proc` scans if called on the request path.

**Approach:** One Claims path for an emulator through a service: `serviceLease` routes an `emulator` word, or a `match` with a `profile=` clause (or one that matches only the emulator Pool), through `take` to `provision({holderPid: null})` run in a `node:worker_threads` worker (`tools/device/emulator-thread.mjs`), answering a `Lease` that carries `emulator: {slot, serial, profile, console_port, adb_server_port}`. `GET /leases/{id}`, extend and release accept emulator ids too (release tears down off-thread). The Pool size order (`HUB_EMULATOR_POOL` CLI only → `emulator-pool` file → Registry `pools.emulator.size` → 2, each 1..8) lives in one Claims function. One level up (pillar `belsky-doctrine`): every service front door (the Hub API now, the Host Agent in Epic 9) leases, finds, extends and releases an emulator through the same Claims calls as a phone, and every service request (not only waits) is ended by a stop.

## Boundaries & Constraints

**Always:**
- `lock.mjs` and `emulator.mjs` stay the only writers (AD-1); rules in `tools/device/claims.mjs`; `routes.mjs` only parses, calls and serialises.
- The service's emulator take calls `provision` with `holderPid: null` inside a worker; the main thread never calls `provision`, `reap`, `teardown` or `markedProcesses`. During boot the slot is tied to the service pid (`process.pid` is the same in the worker), so a service that dies mid-boot leaves an orphan the next `reap` tears down (`holder gone`).
- `PROFILES` and `MAX_POOL` stay code constants; slots stay derived locks (`emulator-<n>`), never Registry records; the `emulator` gate is unchanged.
- A profile that is unknown or not installed fails at once as `HUB_NO_MATCH` (404, exit 2) with the reason, before any ticket, lock or event. The CLI keeps its current no-image message and exit 1.
- `actor` and `claimant_kind` of a service emulator take are recorded on its Pool request and acquire events (threaded through `provision` to `poolRequest`/`acquireLease`); the CLI passes none, as today.
- A disconnect mid-boot aborts the worker's provision (it tears down what it made); a Hold granted after the signal aborted is released at once (slot release reason `undelivered`) and torn down. A repeat id the same holder already holds answers the existing Lease.
- Hermetic tests: the emulator fakes now in `tools/device/emulator.test.mjs` (moved verbatim to `tools/device/emulator-fixtures.mjs` and imported by both), temp dirs, `handle()`; no real emulator, adb, `heavy` (the heavy shim only), port bind or socket.

**Never:**
- No cancel, force-release or forwarding routes (7.5–7.8, Epic 9); no new route; no new body key on `POST /leases`.
- Do not change the CLI's `--match` (it still refuses the emulator Pool), `lease|run emulator` output, `--pool`/`--profile` rules or exit codes, other than the Registry size fallback.
- Do not modify `tools/ci/lib/eta.mjs` or the deploy path (`tools/ci/commands/*`, `tools/catchup/*`); no dependencies, no Python, no `setTimeout`/`setInterval` in new non-test code.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Word | `POST /leases {resource:'emulator', for_ms:1800000, holder, why}` (fakes) | 200 `Lease`: `resource:'emulator'`, `lock:'emulator-1'`, `device:'emulator'`, `env` `{HUB_LEASE_ID, ANDROID_ADB_SERVER_PORT, ANDROID_SERIAL}`, `emulator:{slot:'emulator-1', serial:'emulator-<port>', profile:'default', console_port, adb_server_port}`; slot owner `holder_pid: null`; Pool request + `acquire` events carry the api actor | — |
| Match | `match:'profile=playstore'` (playstore image installed) | as above, `profile:'playstore'` | — |
| Match pool only | `match:'kind=emulator-pool'` | emulator Lease, profile `default` | — |
| Bad profile clause | `profile>=1`, two `profile` clauses | 400 HUB_USAGE | nothing written |
| Not installed / unknown | `profile=playstore` without the image, `profile=pixel` | 404 HUB_NO_MATCH, reason names the image (or the known profiles) | no ticket, lock or event |
| Pool full | every slot held, `wait_ms` 0 | 409 HUB_LOCK_TIMEOUT exit 76 | — |
| Boot fails | fake `crash` | 503 `HUB_EMULATOR_FAILED` exit 1, everything it made torn down | — |
| Disconnect mid-boot | signal aborts while booting | worker aborts; record, slot and pids gone; a `cancel` event | answer dropped |
| Granted after abort | signal aborted when provision returns | released (`undelivered`) and torn down | signal reason thrown |
| Repeat id, same holder | id already holds an emulator slot | 200 the existing Lease, no event | — |
| Pool size | env 3 (service) / file 2 / Registry `size: 4` / none | service uses file, else Registry, else 2; CLI uses env first | out of 1..8 → HUB_EMULATOR_USAGE naming the source |
| Service died mid-boot | child process provisioning is SIGKILLed | next `reap` tears it down (`holder gone`), pids gone, slot free | — |
| GET / extend / release | emulator id | `GET` 200 emulator `Lease`; extend 200 emulator `Lease`; release 200 `Release {outcome:'released', resource:'emulator', lock:'emulator-1', device:'emulator'}`, teardown in the worker | waiting id → `cancelled` |
| Phone Lease | any phone answer | gains `emulator: null`; nothing else changes | — |

</intent-contract>

## Code Map

- `tools/device/emulator.mjs` -- `hostPool` (l.63): add `{useEnv = true, registrySize}` (order env → file → Registry size → `DEFAULT_POOL`, each 1..8, source named in the error). `provision` (l.505): accept and pass `claimantKind`, `actor` to `poolRequest` (l.516), the gate and slot `acquireLease` (l.519, l.539). `releaseEmulator` (l.352): optional `reason` for the slot `releaseLease`. `resolveImage` (l.51) reused for the up-front check.
- `tools/device/claims.mjs` -- `emulatorPool(env, {service})` reads `readRegistryFile(env)?.pools?.emulator?.size` and calls `hostPool`; `emulatorBounds` (l.401) takes `{service}` and uses it. `matchTarget` (l.273) gains `{emulators}` option (service only): lift one `profile=` clause; with it, or when every member is `kind: emulator-pool`, return `{kind: EMULATOR, by: 'match', profile}`. `take` (l.570) passes `service`/`offThread` to `takeEmulator` (l.528), which off-thread calls `ctx.provisionOffThread ?? offThread('provision', …)`. `serviceLease` (l.700): drop the emulator refusal; emulator branch: image check → HUB_NO_MATCH, repeat-id via `heldEmulator`, `take(…, {service:true, offThread:true, profile})`, undelivered release, `emulatorLeaseView`. `leaseView` (l.641) adds `emulator: null`. `heldLease`/`findLease` (l.652/667) also find an emulator slot. `serviceHold` (l.986) stops refusing emulator ids; `serviceExtend` builds the emulator view for a slot; `serviceRelease` releases an emulator through the worker and answers `Release`. `EXIT_CODES`/`HTTP_ANSWERS` (l.46/91): `HUB_EMULATOR_FAILED` 503 `emulator-failed` exit 1. `createLeaseWaits` (l.741): track no-wait requests so `shutdown()` aborts them too.
- `tools/device/emulator-thread.mjs` (new) -- main side `offThread(op, args, {env, log, signal})` (`op` `provision` = reap then provision, or `release`) and the worker side (`!isMainThread`): posts `log`, `done`, `error {message, code, reason}`; an `abort` message aborts its controller; an uncoded error or a worker crash is `HUB_EMULATOR_FAILED`.
- `tools/hub-api/routes.mjs` -- `getLease` passes the fleet context; route comments; no new rows.
- `docs/hub-api-contract.md` -- Lease `emulator.*` (null for a phone, the five keys for an emulator), `env` text (`ANDROID_SERIAL` for an emulator), `resource`/`match` body text (emulator, `profile=`), error rows (`HUB_NO_MATCH` profile, `HUB_EMULATOR_FAILED`, drop `reason: emulator`).
- `README.md` l.92, l.282 -- the API refusal sentence and the cap order (Registry `pools.emulator.size`, CLI-only env).
- `tools/device/emulator.test.mjs` l.26–159 -- fakes and `fixture()` move to `tools/device/emulator-fixtures.mjs` (exported), imported back.
- Tests to update: `tools/hub-api/leases.test.mjs:64,263`, `waits.test.mjs:300`, `extend-release.test.mjs:71,284` (emulator no longer refused, `emulator` key).

## Tasks & Acceptance

**Execution:**
- `tools/device/emulator-fixtures.mjs` + `tools/device/emulator.test.mjs` -- move the fakes and `fixture()` unchanged; the emulator suite stays green.
- `tools/device/emulator.mjs` -- `hostPool` options, `provision` actor/claimantKind, `releaseEmulator` reason.
- `tools/device/emulator-thread.mjs` -- the worker bridge as in the Code Map.
- `tools/device/claims.mjs` -- everything in the Code Map.
- `tools/hub-api/routes.mjs` -- as in the Code Map.
- `docs/hub-api-contract.md`, `README.md` -- as in the Code Map.
- `tools/hub-api/emulator-lease.test.mjs` (new) -- every matrix row through `handle()` with the real worker and the fakes (the granted-after-abort row through the `provisionOffThread` seam), the mid-boot SIGKILL row with a child process, the exact `emulator` keys, and a CLI/API parity check (`hub-device lease emulator --json` vs `POST /leases`: same owner keys and values minus ports, pids, serial, times, `lock_ino`; same event kinds and locks minus `ts`/`actor`); update the tests listed in the Code Map; pool-size order cases in `tools/device/claims.test.mjs`.

**Acceptance Criteria:**
- Given the fakes, when `POST /leases {resource:'emulator'}` runs through `handle()`, then it answers 200 with `emulator.slot`, `emulator.serial`, `emulator.profile`, the slot owner has `holder_pid: null`, and the boot ran in a worker (the service log has `HUB_EMULATOR_THREAD provision <id> thread=<n>` with `n` ≥ 1, written by `offThread` with the worker's `threadId`).
- Given `profile=playstore` with only the default image, when it is requested, then it answers 404 HUB_NO_MATCH with the reason and the lock dir and Event Log are unchanged.
- Given a provisioning service process killed mid-boot, when the next `reap` runs, then the record, its processes and the slot are gone.
- Given `mise run check`, when it runs, then it is green and `git diff main -- tools/ci/lib/eta.mjs` is empty.

## Spec Change Log

## Review Triage Log

### 2026-11-25 — Review pass
- verdicts: 32 findings — high 0, medium 5, low 13, false 13, maybe-false 1
- findings:
  - `[low]` `[defer]` (blind) An emulator release through the API drops the actor. Evidence: this is pre-existing CLI parity (the 7.3 README says an emulator release records no actor yet). It is deferred to thread `actor` through `releaseEmulator` for both front doors.
  - `[low]` `[patch]` (blind) A failed or stuck `undelivered` teardown was silent, because `serviceContext`'s `warn` is a no-op. Fix: `serviceEmulator` now writes `HUB_EMULATOR_UNDELIVERED_STUCK` / `HUB_EMULATOR_UNDELIVERED_FAILED` to the service log.
  - `[false]` `[reject]` (blind) A repeat id sent while the first is still booting takes a second slot. Refutation: `take` calls `checkLeaseId` (claims.mjs:635). `isEmulatorLease` is true for the record, the slot or the gate owner, so the repeat is refused as a taken id (400) and writes nothing.
  - `[medium]` `[patch]` (blind) Extend and GET disagree on a booting emulator. The extension is answered 200, then lost when `provision` sets the expiry at ready (`min(now+forMs, owner.expires_at)`). Fix: `serviceExtend` answers 404 `waiting` for an emulator that holds nothing yet, the same answer GET gives, and writes nothing. The disconnect test asserts it, and the contract text was updated.
  - `[low]` `[reject]` (blind) A record left after a stuck teardown reads as `waiting` on GET. This is rare (only a teardown whose processes would not die), and telling it apart needs a new branch and reason.
  - `[false]` `[reject]` (blind) `emulatorLeaseView` emits `'undefined'` ports. Refutation: `claim()` writes the record and `emulator: summary(record)` onto the slot owner before any later read, so `heldEmulator` always has the record or the summary.
  - `[low]` `[patch]` (blind) The `stuck` release answer was untested. Fix: a `releaseAnswer` table test covers released, cancelled, none and stuck → `HUB_EMULATOR_FAILED`.
  - `[maybe-false]` `[defer]` (blind) An emulator wait (`wait_ms` > 0) through the wait registry is untested. Recorded as maybe-false: the same `serviceLease` path probably works. A full-pool wait test through `createLeaseWaits()` would settle it.
  - `[low]` `[patch]` (blind) `s.record('emu-ps').profile ?? 'playstore'` was tautological. Fix: it now asserts `record.profile === 'playstore'`.
  - `[low]` `[patch]` (blind) The `profile=` branch of `matchTarget` dropped `for_ms`, unlike the pool-only branch. Fix: it now passes `for_ms: forMs` to `match`.
  - `[false]` `[reject]` (blind) Long boots have no polling mode, so a proxy idle-timeout kills them. Refutation: aborting on a closed connection is the matrix's own row ("Disconnect mid-boot → worker aborts"). The contract tells a client to set a long timeout, and GET `/leases/{id}` recovers a Hold after a lost answer.
  - `[false]` `[reject]` (blind) The Code Map says `getLease` passes the fleet context, but the code does not. Refutation: `findLease` loads the fleet itself with the same result. The fix would edit this spec.
  - `[low]` `[reject]` (blind) The worker drops `retry`/`excluded` and has no hard deadline. No worker error carries those fields (an abort answers the signal's own reason on the main side), and a deadline needs a timer, which the spec forbids in new non-test code.
  - `[low]` `[reject]` (edge) A worker that truly crashes (OOM) mid-boot leaves its slot tied to the live service pid until expiry. A worker crash with no answer is rare, `provision`'s own catch tears down on every thrown error, and a fix would add a recovery path.
  - `[low]` `[patch]` (edge) A stuck `undelivered` teardown was silently dropped. Same root cause and fix as the blind finding above.
  - `[medium]` `[patch]` (edge) Extend answers 200 on a booting id while GET answers 404. Same root cause and fix as the blind finding above.
  - `[false]` `[reject]` (edge) A same-holder repeat while booting starts a second provision. Refutation as above: `checkLeaseId` → `isEmulatorLease` refuses it as a taken id.
  - `[low]` `[reject]` (edge) A same-holder repeat id that holds a phone but asks for an emulator is answered with the phone Lease. These are the 7.2 semantics: an id names one lease, and a repeat answers what it holds.
  - `[false]` `[reject]` (edge) Worker errors lose a numeric `status`. Refutation: no lock or emulator error carries `status`. Coded errors keep `code`, which `httpAnswerOf` maps.
  - `[false]` `[reject]` (edge) A non-cloneable `ctx.emulator` raises DataCloneError. Refutation: `createContext`'s `emulator` holds only numbers (`graceMs`, `bootTimeoutMs`, `bootPollMs`), and the suite runs the real worker with it.
  - `[false]` `[reject]` (edge) The worker's `exit` can arrive before its last message. Refutation: Node drains both message ports in the worker's exit handler before it emits `exit`, so a posted `done`/`error` is always delivered first.
  - `[low]` `[reject]` (edge) A stop during a plain emulator release exits mid-teardown. The slot is freed first, so the next reap tears down the left-over record ("slot no longer holds them"). Tracking release workers in shutdown is new machinery.
  - `[medium]` `[patch]` (edge) After a service crash mid-boot, a ready-looking Lease is answered for the orphan (GET, and a same-holder repeat id), because its owner is tied to the dead old pid. Fix: `heldEmulator` returns null for a slot the reaper's own `doomed()` predicate condemns. The SIGKILL test asserts GET is 404 before the reap.
  - `[low]` `[patch]` (edge) `heldEmulator` joined an unvalidated id into a record path. Fix: it returns null unless the id matches `LEASE_ID`.
  - `[medium]` `[patch]` (verification-gap) `claimant_kind`/`actor` on the Pool request and the gate and slot acquires were not pinned. Fix: a new test posts `claimant_kind: 'person'` with an explicit actor and asserts the owner, the request, the gate acquire and the slot acquire.
  - `[medium]` `[patch]` (verification-gap) The connection-abort bridge in `createLeaseWaits` for no-wait requests was untested on the production path. Fix: the disconnect-mid-boot test now goes through `createLeaseWaits()`, as `startService` does.
  - `[low]` `[patch]` (verification-gap) The stuck release path was unasserted. Same fix as the blind finding: the `releaseAnswer` table test.
  - `[false]` `[reject]` (intent) The scope is wider than the ACs (GET/extend/release, the shutdown change, `emulator: null`). Refutation: the spec's Approach and Design Notes choose this one level up (7.3 deferred emulator ids to this story), and the Never list is respected.
  - `[false]` `[reject]` (intent) No real HTTP service or socket is exercised. Refutation: the spec's hermetic rule forbids port binds. `handle()` is the route, and `server.mjs` stays the unchanged adapter.
  - `[false]` `[reject]` (intent) `holder_pid` is null only after the boot. Refutation: the Always rule requires the service pid during boot so that a dead service's orphan is reaped. Both phases are asserted.
  - `[false]` `[reject]` (intent) `contract.test.mjs` is not in the diff. Refutation: it parses the contract doc's field lists against handler output, the doc gained `emulator.*`, and it passed (13/13).
  - `[false]` `[reject]` (intent) The fakes bind loopback ports, a wider reading of "hermetic". Refutation: they are the same fakes the existing `emulator.test.mjs` uses, as the spec's Always rule names, and the file uses its own port ranges.

### 2026-11-25 — Review pass (follow-up)
- verdicts: 37 findings — high 0, medium 5, low 19, false 10, maybe-false 3
- findings:
  - `[medium]` `[patch]` (blind) An expired emulator Lease not yet reaped answers 404 `waiting` on GET and extend, not the contract's 409 `expired`. Verified: the first pass's `doomed()` guard in `heldEmulator` also nulls `expired`, so `serviceExtend`'s precheck threw `leaseNotFound` → `isEmulatorLease` → `waiting`. Fix: `heldEmulator` now ignores the `expired` doom (holder-gone orphans stay null), so GET answers the expired Lease as it does a phone's and the extend reaches `extendLease`, which refuses `expired`. New test: an expired emulator, GET 200, extend 409 `HUB_LEASE_EXTEND_REFUSED` `expired`, no `extend` event.
  - `[low]` `[reject]` (blind) A worker that crashes leaves the slot tied to the live service pid until expiry. carried: the 2026-11-25 pass rejected the same claim (OOM worker crash, rare; `provision`'s catch tears down on every thrown error) and the code reads as described.
  - `[low]` `[reject]` (blind) A bad `emulator-pool` file or Registry size answers 400 `HUB_EMULATOR_USAGE`, blaming the client for host config. Real, but an operator meets it only after writing a bad size, the detail names the source, and remapping it adds a branch.
  - `[low]` `[reject]` (blind) Through the API a `profile=` clause always names the emulator, so a phone Resource with a `profile` Capability cannot be matched that way. Real by design (Design Notes: `profile` is a clause), and no declared phone carries a `profile` Capability (`tools/ci/devices.json`, the seed); a split rule would add a branch.
  - `[low]` `[defer]` (blind) An emulator release records no actor. carried: already in the `deferred` list from the 2026-11-25 pass; not deferred again.
  - `[low]` `[reject]` (blind) `shutdown()` does not wait for an in-flight emulator release. carried: the 2026-11-25 pass rejected "a stop during a plain emulator release" (the slot is freed first, the next reap cleans up).
  - `[maybe-false]` `[defer]` (blind) No test for an emulator `wait_ms` > 0 through the wait registry. carried: already deferred (medium, unverified).
  - `[false]` `[reject]` (blind) Spreading `ctx.emulator` into the worker args can raise DataCloneError. carried: refuted on the 2026-11-25 pass (`createContext`'s `emulator` holds only numbers).
  - `[false]` `[reject]` (blind) TOCTOU between `serviceExtend`'s precheck and `extendHeld`. Refutation: both outcomes of the race are valid refusals (a released or reaped id makes `extendHeld` throw `leaseNotFound`), and `extendLease`'s inode check guards the rewrite itself; the extra `phoneOwning` read is a cost, not a wrong answer.
  - `[low]` `[patch]` (blind) `offThread`'s second `signal.aborted` check is dead after the early reject; no overall deadline. Fix: the dead branch is gone (one `addEventListener`, with a comment). The deadline part is carried from the 2026-11-25 pass (rejected: a timer is forbidden in new non-test code).
  - `[low]` `[reject]` (blind) The 404 `HUB_NO_MATCH` detail carries the SDK path and the `sdkmanager` hint. The intent's matrix asks for exactly this answer ("404 HUB_NO_MATCH, reason names the image"), and the API serves the operator's own homelab; changing it would edit the spec's intent.
  - `[low]` `[patch]` (blind) The post-release GET asserted only 404, not `reason: unknown`; `emulatorLeaseView` null members. Fix: the test now asserts `[404, HUB_LEASE_NOT_FOUND, unknown]`. The null-member part is carried false from the 2026-11-25 pass (`claim()` writes the record and summary before any read).
  - `[medium]` `[patch]` (edge) An expired, holder-gone or orphaned emulator answers `waiting`. Same root cause and fix as the first blind row for `expired`. The holder-gone part (a service that died mid-boot reads `waiting` until the next reap) is a rejected low: rare, and telling it apart needs a new reason branch in `leaseNotFound`.
  - `[low]` `[reject]` (edge) An emulator the CLI is booting has its owner tied to the CLI's pid, so a service GET answers it as held and an extend would be overwritten at ready. Real, but it needs an agent to extend through the API an id it is still booting through the CLI, and a fix needs a new ready marker.
  - `[maybe-false]` `[reject]` (edge) Two no-wait POSTs with one id and holder that land before the first writes its gate ticket both pass `checkLeaseId`. Not settled: `lock.mjs` has a `pool-duplicate` release path, and phone takes share the same window. If true it is low (it needs a client to send the same id twice within the worker's startup, tens of ms); rejected with this note.
  - `[low]` `[reject]` (edge) A worker crash or silent exit strands the slot. carried: same as the rejected blind row and the 2026-11-25 pass.
  - `[low]` `[defer]` (edge) A `profile=` match with no other clause leases the emulator even when the Registry marks the emulator Pool retired. Pre-existing at the root: `withoutRetired` in `take` never checks the emulator kind, so the word `emulator` (CLI and API) has always ignored it. Deferred with the fix located in `take`.
  - `[low]` `[reject]` (edge) `checkProfile` (404) runs before `take`'s `checkLeaseId`/`checkBounds` (400), so a request with both faults gets 404. Real, but a client meets it only when sending two faults at once, both answers are true refusals, and reordering means moving the image check into `take`.
  - `[low]` `[reject]` (edge, claim) The contract's refusal order puts `HUB_USAGE` before `HUB_NO_MATCH`. Same root cause as the row above; rejected with it.
  - `[medium]` `[patch]` (edge, claim) The contract's `expired` extend refusal never fired for an emulator. Same root cause and fix as the first blind row; the new test pins the contract's answer.
  - `[medium]` `[patch]` (verification-gap) A stuck or failing teardown on the release route, and the `HUB_EMULATOR_UNDELIVERED_*` log lines, were unverified. Fix: a new test drives `POST /leases/{id}/release` with a `releaseOffThread` stub that answers `stuck` and one that throws, asserting 503 `HUB_EMULATOR_FAILED` exit 1 `emulator-failed` with the detail; then a late-abort grant with each stub, asserting the caller sees the signal's reason and the service log has `HUB_EMULATOR_UNDELIVERED_STUCK` / `_FAILED`.
  - `[low]` `[reject]` (verification-gap) The worker's crash and no-answer paths in `offThread` are untested. The layer filed it as `defer`, but it is caused by this change; a worker that dies without answering is rare, the handlers are two one-line rejects, and a test needs a dedicated crashing-worker harness.
  - `[low]` `[reject]` (intent) A stop does not end an in-flight emulator release (reading R1b). carried: same as the rejected blind `shutdown()` row.
  - `[low]` `[defer]` (intent) An emulator release carries no actor (reading R2b). carried: already deferred.
  - `[false]` `[reject]` (intent) "Reason names the image" lands in `detail`, the body's `reason` is `no-match`. Refutation: the error's own `reason` names the image, and the body's `reason` is the HTTP table's slug for every `HUB_NO_MATCH`, phone ones included; the image name reaches the client.
  - `[false]` `[reject]` (intent) The granted-after-abort test uses the seam, not the real `offThread` race. Refutation: in `offThread` a `done` that arrives after the abort was posted resolves with the result, and `serviceEmulator`'s `signal.aborted` branch (the one the seam test drives) then gives it back; there is no separate path the seam skips.
  - `[false]` `[reject]` (intent) "Answer dropped" is asserted at `handle()`, not a socket. carried: refuted on the 2026-11-25 pass (the hermetic rule forbids port binds; `server.mjs` is the unchanged adapter).
  - `[false]` `[reject]` (intent) The fakes bind ports and use sockets. carried: refuted on the 2026-11-25 pass.
  - `[false]` `[reject]` (intent) The Pool size order's logic sits in `emulator.mjs` `hostPool`, not in Claims. Refutation: `emulatorPool` in `claims.mjs` is the only non-test caller of `hostPool` (`grep`), so the order has one entry and no front door can diverge; the Code Map placed the logic in `hostPool`.
  - `[false]` `[reject]` (intent) GET and extend on a booting emulator answer 404 `waiting`. Refutation: this is the contract's stated answer (patched deliberately on the 2026-11-25 pass so an extension is never lost at ready), not a divergence.
  - `[low]` `[reject]` (intent) An orphan the reaper will tear down reads `waiting`. Same as the rejected holder-gone part of the edge row.
  - `[low]` `[reject]` (intent) A CLI-booted emulator seen from the service answers as held while booting. Same as the rejected edge row.
  - `[medium]` `[patch]` (intent) A stuck release is only tested through the pure `releaseAnswer`. Same root cause and fix as the verification-gap row.
  - `[maybe-false]` `[defer]` (intent) No emulator `wait_ms` > 0, supersede or worker-crash test. carried: the wait part is already deferred; the worker-crash part is the rejected verification-gap row.
  - `[false]` `[reject]` (intent) `findLease` → `doomed` → `liveStart` reads `/proc` on the main thread. Refutation: it is one `/proc/<pid>` stat for a slot whose owner names another process, not a scan; the Always rule bars `provision`, `reap`, `teardown` and `markedProcesses`, none of which runs there.
  - `[low]` `[reject]` (intent) A phone `profile` clause now routes to the emulator through the API. Same as the rejected blind `profile=` row.
  - `[false]` `[reject]` (intent) No-wait phone requests now run under a controller that `shutdown()` aborts. Refutation: the Approach asks for exactly this ("every service request (not only waits) is ended by a stop"); phone answers are unchanged.

## Design Notes

- **`profile` is a clause, not a body key.** The epic's "`match` with `profile`" is read as a query clause (`profile=playstore`), so `POST /leases` keeps its keys. Only a service passes `{emulators: true}`; the CLI's `--match` keeps refusing the emulator Pool (its tests pin it), and `lease emulator --profile` stays its door.
- **One `Lease` shape.** An emulator answer is the same keys plus `emulator`; a phone answer gains `emulator: null` (fields are only added). The contract lists `emulator.*` (open: null or the object) and the new test pins the five keys.
- **Extend/release/GET included.** 7.3 deferred emulator ids on those routes to this story; a Lease the API can take but not give back would live until expiry.

## Verification

**Commands:**
- `node --test tools/hub-api/emulator-lease.test.mjs tools/device/emulator.test.mjs tools/hub-api/leases.test.mjs tools/hub-api/waits.test.mjs tools/hub-api/extend-release.test.mjs tools/hub-api/contract.test.mjs tools/device/claims.test.mjs` -- expected: all pass
- `heavy mise run check` -- expected: actionlint and the full suite green


## Auto Run Result

**Status: done** (follow-up review pass). No acceptance criterion needs a human outside the repo, so there are no `operator_actions`.

**Summary.** Story 7.4 lets an agent with no shell on big-chungus take, find, extend and release a booted emulator through the Hub API. It uses the same Claims calls as a phone: `POST /leases` accepts the `emulator` word, a `profile=` match, or a match only the emulator Pool satisfies. The boot and teardown run in a `node:worker_threads` worker. The answer is a `Lease` carrying `emulator: {slot, serial, profile, console_port, adb_server_port}`, and a phone Lease gains `emulator: null`. The Pool size order lives in `emulatorPool`. A stop ends every service request, not only waits. One level up (`belsky-doctrine`): every service front door (the Hub API now, the Host Agent in Epic 9) gets the same emulator take/find/extend/release. This follow-up pass fixed one contract regression the first pass introduced: an expired emulator Lease answered `waiting`. It also closed two verification gaps.

**Files changed in this pass**
- `tools/device/claims.mjs`: `heldEmulator` no longer nulls an `expired` emulator. GET answers it as it answers a phone's, and an extend is refused 409 `expired` as the contract says, instead of 404 `waiting`. Holder-gone orphans are still never answered as a Lease.
- `tools/device/emulator-thread.mjs`: removed the dead `signal.aborted` branch after the early reject.
- `tools/hub-api/emulator-lease.test.mjs`: three test changes:
  - a new expired-emulator test (GET 200, extend 409 `expired`, no event);
  - a new failing-teardown test (the release route answers 503 `HUB_EMULATOR_FAILED` for a `stuck` and a throwing teardown, and an undelivered grant whose teardown sticks or fails logs `HUB_EMULATOR_UNDELIVERED_STUCK` / `_FAILED`);
  - the post-release GET now asserts `reason: unknown`.

(The story's full change set since `a685f9136dc2946fe7b6f98d33ae33f41829047a` is listed in the first pass: `tools/device/{claims,emulator,emulator-thread,emulator-fixtures}.mjs`, `tools/hub-api/{routes.mjs,emulator-lease.test.mjs}`, the updated hub-api and claims tests, `docs/hub-api-contract.md` and `README.md`.)

**Review findings breakdown.** 37 findings: high 0, medium 5, low 19, false 10, maybe-false 3.
- **Patched: 4 entries, 2 medium and 2 low.**
  1. An expired emulator answered `waiting` (medium; 3 rows across blind, edge and edge-claim).
  2. A failing or stuck teardown and the undelivered log lines were untested (medium; verification-gap and intent rows).
  3. The dead branch in `offThread` (low).
  4. The weak post-release assertion (low).
- **Deferred:** one new item. An emulator take ignores a retired emulator Pool. This is pre-existing at `withoutRetired` in `take`, and the new `profile=` branch inherits it. Five carried rows point at items already deferred (the release actor, and the emulator `wait_ms` > 0 test). They were not deferred again.
- **Rejected:**
  - False, refuted:
    - DataCloneError (carried)
    - the extend TOCTOU (both race outcomes are valid refusals)
    - "reason names the image" (the error's own reason does)
    - the granted-after-abort seam (no path skipped)
    - answer dropped at `handle()` (carried)
    - the fakes' ports (carried)
    - the Pool order living in `hostPool` (one caller)
    - booting answers `waiting` (the contract's choice)
    - the main-thread `liveStart` (one stat, not a scan)
    - phone requests aborted by shutdown (the intent asks for it)
  - Low, not worth new machinery or unlikely in use:
    - a worker crash strands the slot (carried)
    - a bad pool size answers 400
    - `profile=` shadows a phone `profile` Capability (no phone has one)
    - shutdown does not wait for releases (carried)
    - the SDK path in the 404 detail (the intent asks for it)
    - a CLI-booted emulator seen from the service
    - the refusal order of 404 before 400 (two rows)
    - the untested `offThread` crash handlers
    - a holder-gone orphan reads `waiting`
  - Maybe-false, rejected: concurrent same-id no-wait POSTs (low even if true).

**Follow-up review recommendation: `false`.** This is a follow-up pass, and it patched no `high` entry. Patched counts by verdict: high 0, medium 2, low 2. The work has converged.

**Verification**
- `node --test tools/hub-api/emulator-lease.test.mjs`: 16/16 pass, including the two new tests.
- `node --test tools/hub-api/emulator-lease.test.mjs tools/device/emulator.test.mjs tools/hub-api/leases.test.mjs tools/hub-api/waits.test.mjs tools/hub-api/extend-release.test.mjs tools/hub-api/contract.test.mjs tools/device/claims.test.mjs`: 141/141 pass.
- `heavy mise run check`: exit 0, actionlint clean, 1338/1338 tests pass.
- `git diff main -- tools/ci/lib/eta.mjs` is empty.

**Residual risks**
- The emulator tests use the real clock and fakes that are real loopback processes, so they are slower and timing-sensitive under heavy load. The new expired test waits about 1 s for a 1 s Lease to run out.
- An emulator worker that dies without answering (OOM) leaves its slot until expiry.
- An orphan that a service left when it died mid-boot reads `waiting` until the next emulator reap.
- A retired emulator Pool is not refused (deferred).
