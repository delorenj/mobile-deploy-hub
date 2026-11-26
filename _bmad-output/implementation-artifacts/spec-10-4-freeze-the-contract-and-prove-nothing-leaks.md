---
title: 'Freeze the contract and prove nothing leaks'
type: 'feature'
created: '2026-11-26'
status: 'in-progress'
baseline_revision: '15b20d5c0b54aa2edb65402dd69a47bfd9281900'
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-10-context.md'
  - '{project-root}/docs/hub-api-contract.md'
warnings: ['oversized']
deferred: []
---

<intent-contract>

## Intent

**Problem:** v1c will code against `docs/hub-api-contract.md`, but today the contract test only holds the document and the code equal: a field or route removed from both passes, routes are not mapped to the Claims/store function they run, `/capacity` is not reserved, and QA-serial redaction is proven for `/status` alone. One real leak exists: `GET /leases/{id}` and `POST /leases/{id}/extend` answer `env.ANDROID_SERIAL` with the owner record's `device.adb_id`, so a CLI Lease on a `dedicated_qa` phone that connected serves its serial (claims.mjs:759-770, 866).

**Approach:** Freeze contract 1 as a committed baseline that the test treats as a floor (only additions pass); add a `Calls` column (route → one Claims or store export) checked against code; reserve `GET /capacity` in the doc and prove it absent from code; fix the Lease leak once in the Claims library; and add route-table-driven sweeps (Belsky, one level up: every route present and future, not the five named) proving no QA serial in any answer, every refusal is problem+json, and every write answers the state a fresh read then shows.

## Boundaries & Constraints

**Always:**
- The freeze is a floor, not an equality: every frozen route (method, path, shape, calls), shape field, error code (with its exit) and problem extension member must still be in the document; additions are allowed. The existing doc==code==live-answer tests stay as they are. The baseline records `contract: 1`; a document whose version differs fails with a message saying a new version needs a new freeze file.
- `Calls` cells name `<module>.<export>` with modules `claims` (tools/device/claims.mjs), `store` (tools/registry/store.mjs), `events` (tools/ci/lib/events.mjs), `replica` (tools/hub-api/replica.mjs), `receipt` (tools/ci/lib/receipt.mjs). Each ROUTES / AGENT_ROUTES row carries the same string as `calls`; the test checks doc==row, the export is a function, and some non-test module under `tools/hub-api/` or `tools/host-agent/` imports that name from that module.
- One force-release dispatch: `claims.serviceForceRelease(id, input, ctx)` (slot id → `forceReleaseEmulator`, else `forceReleaseLease`), called by routes.mjs and hub-device.mjs; behaviour unchanged.
- Lease redaction follows AD-30: keys stay, values become `null`. A Lease view served to a service for a Resource in the `dedicated_qa` set has `env.ANDROID_SERIAL` (and any other env value equal to the device's `adb_id`) `null`. The CLI (`local`) keeps today's values.
- The leak sweep boots the real `startHubApi` (FakeServer listener, no port bound; pattern at tools/hub-api/track.test.mjs:270-317) with a fixture QA list of two serials (one seeded phone, `s24`; one runtime QA phone) and searches the raw response text and headers, case-insensitively, for each serial and for an adb id embedding it.
- Hermetic: `hermetic()`, temp dirs, fake adb wire/observe/track; no live bucket, host key or QA file.

**Never:** implement `/capacity` or any v1c route; change a route's shape, path or meaning; bump `CONTRACT_VERSION`; a runtime scrub of answers in `handle()`; redact by anything other than the `dedicated_qa` set (a serial a caller registers itself is echoed by design); write the baseline from the code at test time (it is a committed file); Python.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Field removed | a frozen field deleted from doc and code | freeze test fails naming the shape and field | none |
| Route renamed | a frozen route path changed in doc and ROUTES | freeze test fails naming the missing route | none |
| Field added | a new field in doc and code | all contract tests pass | none |
| Capacity | `GET /capacity` on Hub API and Host Agent | 404 `HUB_NO_ROUTE`; no ROUTES/AGENT_ROUTES row and no non-test `.mjs` under `tools/` contains `/capacity` | none |
| QA Lease | CLI Lease on `res-pixel-qa` with `device.adb_id` = QA serial; `GET /leases/{id}`, extend | `env.ANDROID_SERIAL: null`, key present | none |
| Non-QA Lease | same on `s26` (not QA) | `env.ANDROID_SERIAL` is the adb id | none |
| Leak sweep | QA phones held, queued, listed on adb, tracked, in events | no serial in any GET (incl. `/stream` frames) or POST answer of Hub API and Host Agent; a non-QA control serial does appear in `/discovery` | none |
| Refusals | every POST route with body `[]`; GET `/nope`; wrong method | `Content-Type: application/problem+json`, keys exactly `Problem` (+ extensions), `code`/`exit`/`reason` set | none |
| Write readback | every POST route's success | answer equals a fresh read (see Design Notes) | none |

</intent-contract>

## Code Map

- `docs/hub-api-contract.md:22-45` -- Hub API route table (`| Method | Path | Shape | Added |`); add a `Calls` column; `:718-729` Host Agent table, same. Add a `## Reserved` section (`GET /capacity`, v1c, absent from code) and a one-paragraph `Calls` legend (the five module names). Header status line stays `contract 1`, add a dated additive note.
- `tools/hub-api/contract.test.mjs:32-46` -- `routeTable()`: header regex must accept the optional `Calls` column; return `callsOf`. `:302-637` existing tests stay; add the freeze, calls, capacity, error-envelope and write-readback tests here (or a sibling `contract-freeze.test.mjs` importing `parseContract`/`flatten`, which this file already exports). `:221-244` POST_SAMPLES/GET_SAMPLES and `callPost`/`callGet` are the reuse points for every-route sweeps.
- `tools/hub-api/contract-freeze.json` (new) -- the committed v1b baseline: `{contract: 1, frozen_at, routes: {"GET /health": {shape, calls}}, agent_routes, shapes: {Health: [...]}, codes: {CODE: exit}, extensions}`; generated once from the parsed doc after the `Calls` column lands, then hand-owned.
- `tools/hub-api/routes.mjs:616-638` -- add `calls` to each row (mapping in Design Notes). `:530-535` force-release handler → `serviceForceRelease(params.id, {why, actor}, {...serviceContext(ctx), offThread: true})`. `:477-485` `serviceContext`: add a lazy `qaIds: () => dedicatedQaIds(readIt(ctx))` (import exists, :21).
- `tools/host-agent/routes.mjs:161-166` -- `calls` on `/health` (`receipt.hubRef`), `/status` (`claims.statusView`), `/agent/sync` (`events.readEventsFrom`); Hold rows inherit from ROUTES via spread.
- `tools/device/claims.mjs:759-825` -- `leaseExports`/`leaseView`: take an optional `{qaIds}` (a Set or array) and null the adb-id-valued env keys for a QA Resource; `:875` `findLease`, `:916-940` `serviceLease` (repeat-of-id returns an existing Lease), `:1291-1300` `serviceExtend` pass `ctx.qaIds?.()`. `:1485`/`:1522` the two force-release functions; add exported `serviceForceRelease` beside them. `:1665` `redact` is the status precedent.
- `tools/device/hub-device.mjs:410-411` -- call `claims.serviceForceRelease`.
- `tools/hub-api/status.test.mjs:24-60,117-141` -- existing QA fixture and `walk()`; reuse the serials' shape (`usbId`).
- `tools/hub-api/track.test.mjs:270-317` -- `boot()` harness for `startHubApi` with FakeServer, `observe`, `trackDevices`; `tools/hub-api/stream.test.mjs:453` -- reading `/stream` frames from a started service.
- `tools/ci/lib/lock.mjs:160-176,219-275` -- read-only: event bodies are allowlists (no serial field); `updateLease` (status.test.mjs:121) records `device` on an owner.

## Tasks & Acceptance

**Execution:**
- `tools/device/claims.mjs` -- `serviceForceRelease`; QA-aware `leaseView`/`leaseExports`; thread `qaIds` through `findLease`, `serviceLease`, `serviceExtend` -- one fix covers every Lease-answering route on both services.
- `tools/hub-api/routes.mjs`, `tools/host-agent/routes.mjs`, `tools/device/hub-device.mjs` -- `calls` on every row, the force-release dispatch, `qaIds` in `serviceContext`.
- `docs/hub-api-contract.md` -- `Calls` columns, legend, `## Reserved`, dated note; note in `Lease` that a `dedicated_qa` Resource's `env.ANDROID_SERIAL` is `null`.
- `tools/hub-api/contract-freeze.json` -- the baseline.
- `tools/hub-api/contract.test.mjs` (and/or `contract-freeze.test.mjs`) -- freeze floor (+ synthetic removal/rename detected, addition accepted), calls, capacity, refusal envelope over every route, write readback over every POST route (a POST route with no readback entry fails).
- `tools/hub-api/leak.test.mjs` (new) -- the QA sweep over every GET route of ROUTES (stream frames included) and AGENT_ROUTES and every POST sample answer, plus the QA/non-QA Lease rows of the matrix; a GET route with no sweep sample fails.
- `tools/device/*.test.mjs` touching force-release or `leaseView` -- keep green; add a unit test for `serviceForceRelease` dispatch and QA `leaseView`.

**Acceptance Criteria:**
- Given `docs/hub-api-contract.md`, when parsed, then its route tables list exactly the AD-42 routes with a `Calls` cell each, equal to ROUTES/AGENT_ROUTES `calls`, each an imported Claims or store export, and `GET /capacity` appears only under `## Reserved`.
- Given the contract test, when any frozen route, shape field, code or extension member is removed or renamed, then it fails; when one is added, it passes.
- Given every route of both services, when it refuses, then the answer is `application/problem+json` with exactly the `Problem` fields (plus its extensions) and non-empty `code`, integer `exit`, non-empty `reason`.
- Given a fixture with QA serials, when every GET route of both services (and `/stream` frames) and every POST sample is answered, then no answer contains a QA serial.
- Given every POST route, when it succeeds, then its answer equals the state a following read shows.
- Given the change, when `heavy mise run check` runs, then it is green.

## Spec Change Log

## Review Triage Log

## Design Notes

`calls` mapping: `/health` `store.registryState`; `/resources`, `/resources/{id}`, `/pools` `store.readRegistry`; `/discovery` `claims.discover`; `/status`, `/stream` `claims.statusView`; `/history`, `/utilisation` `events.readEventsFrom`; `/agent/push` `replica.createReplicas`; the three `/registry/*` writes `store.updateRegistry`; `POST /leases` `claims.serviceLease`; `GET /leases/{id}` `claims.findLease`; extend `claims.serviceExtend`; release `claims.serviceRelease`; force-release `claims.serviceForceRelease`; cancel `claims.cancel`; reservation force-release `claims.forceReleaseReservation`. Agent: `/health` `receipt.hubRef`, `/status` `claims.statusView`, `/agent/sync` `events.readEventsFrom`. The import check must accept `name as alias` imports.

Write readback (each on a fresh scratch, after the sample call): register/edit → `GET /resources/{id}` `.resource` deep-equals the answer's `resource` and `rev` matches `GET /resources`; retire → `GET /resources/{id}` is 404 `retired` when `visibility: hidden`, and `rev` matches; lease/extend → `GET /leases/{id}` deep-equals the answer; release/force-release → `GET /leases/{id}` 404 and the lock is free in `GET /status`; cancel → each `queues[]` waiter list matches the `GET /status` waiters on that lock (ids, order); reservation force-release → `GET /status` has no reservation with that `run_key`; `/agent/push` → `replica` equals a second duplicate push's `replica` and `GET /status` `hosts.mac` exists when the push carried a status.

## Verification

**Commands:**
- `node --test tools/hub-api/contract.test.mjs tools/hub-api/leak.test.mjs tools/hub-api/leases.test.mjs tools/hub-api/force-release.test.mjs tools/hub-api/emulator-force-release.test.mjs tools/hub-api/extend-release.test.mjs` -- expected: all pass
- `heavy mise run check` -- expected: green
