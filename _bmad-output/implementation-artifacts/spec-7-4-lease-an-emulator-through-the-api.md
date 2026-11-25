---
title: 'Story 7.4: Lease an emulator through the API'
type: 'feature'
created: '2026-11-25'
status: 'in-progress'
baseline_revision: 'a685f9136dc2946fe7b6f98d33ae33f41829047a'
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-7-context.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-7-3-extend-and-release-a-lease-with-a-recorded-override.md'
  - '{project-root}/docs/hub-api-contract.md'
warnings: ['oversized']
deferred: []
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

## Design Notes

- **`profile` is a clause, not a body key.** The epic's "`match` with `profile`" is read as a query clause (`profile=playstore`), so `POST /leases` keeps its keys. Only a service passes `{emulators: true}`; the CLI's `--match` keeps refusing the emulator Pool (its tests pin it), and `lease emulator --profile` stays its door.
- **One `Lease` shape.** An emulator answer is the same keys plus `emulator`; a phone answer gains `emulator: null` (fields are only added). The contract lists `emulator.*` (open: null or the object) and the new test pins the five keys.
- **Extend/release/GET included.** 7.3 deferred emulator ids on those routes to this story; a Lease the API can take but not give back would live until expiry.

## Verification

**Commands:**
- `node --test tools/hub-api/emulator-lease.test.mjs tools/device/emulator.test.mjs tools/hub-api/leases.test.mjs tools/hub-api/waits.test.mjs tools/hub-api/extend-release.test.mjs tools/hub-api/contract.test.mjs tools/device/claims.test.mjs` -- expected: all pass
- `heavy mise run check` -- expected: actionlint and the full suite green
