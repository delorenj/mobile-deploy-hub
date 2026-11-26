---
title: 'Freeze the contract and prove nothing leaks'
type: 'feature'
created: '2026-11-26'
status: 'done'
baseline_revision: '15b20d5c0b54aa2edb65402dd69a47bfd9281900'
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-10-context.md'
  - '{project-root}/docs/hub-api-contract.md'
warnings: ['oversized']
deferred:
  - summary: >-
      The Host Agent redacts a Lease by what its `known` holds, so if `known` is stale it serves a QA phone's adb id.
    evidence: |-
      `withQa` (tools/host-agent/routes.mjs) takes `knownOf(ctx).qaIds()`: the Hub API's last `GET /resources` answer, else the seed.
      `known.refresh` runs once after bind, and again only on a Hold request that names a Resource. `GET /leases/{id}`, and an extend with no `resource`, name none.
      A phone can be in the agent's seed (devices.json) as non-QA and later marked `dedicated_qa` through `POST /registry/resources/{id}`.
      If the boot refresh failed, or the mark came after it, a CLI Lease with a connect on that phone serves `env.ANDROID_SERIAL`. A phone missing from `known` is not in the agent's fleet, so its Lease is 404 and does not leak.
      The agent's `GET /status` depends on `known` the same way (pre-existing, AD-41).
      This cannot happen in today's deployment: the only spoke is the Mac, which has no phones.
      To settle it, add a Host Agent test whose `request` seam fails, plus a seed phone that the Registry marks QA. Then either refresh `known` on Lease reads or redact every phone serial while `known` is the seed.
    location: >-
      tools/host-agent/routes.mjs:28 (withQa); tools/host-agent/known.mjs refresh
    severity: medium (unverified)
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

### 2026-11-26 — Review pass
- verdicts: 25 findings — high 0, medium 3, low 7, false 15, maybe-false 0
- findings:
  - `[medium]` `[defer]` (blind) The Host Agent's Lease redaction fails open when `known` is stale. A runtime `dedicated_qa` mark the agent has not seen leaves the serial in `env`. — Real, but inherited from `known`'s freshness model, which `/status` shares (AD-41). It needs a seed phone marked QA at runtime on a spoke that has phones, and the Mac has none. Deferred with what would settle it.
  - `[false]` `[reject]` (blind) `GET /leases/{id}` now breaks on a corrupt `registry.json`. — `readRegistry` (tools/registry/store.mjs:89-102) never throws. An unreadable file falls back to the seed, with `unreadable` and a warning.
  - `[low]` `[patch]` (blind) The Additive note says "no route, shape or meaning changed" while it changes what `env.ANDROID_SERIAL` carries. — Reworded: no route or shape changed, and the `null` is AD-30's existing redaction rule applied to the Lease (commit 3276468).
  - `[low]` `[patch]` (blind) The `env.*` row says the key stays whoever took the Lease, but a Lease with no adb id has no `ANDROID_SERIAL` key. — Reworded: the key stays with a `null` value only when the Lease recorded an adb id (commit 3276468).
  - `[low]` `[reject]` (blind) The freeze does not pin request bodies, status codes, types or headers. — The epic AC scopes the floor to the key sets of handler output ("a field or route"). The doc's request bodies are prose, not a parsed shape, so freezing them needs a new parser. Removing a request key from both doc and code is a deliberate act and unlikely in everyday use.
  - `[low]` `[reject]` (blind) `freezeOf` is exported but unused. — It is the documented generator a contract-2 freeze file is cut from. Deleting it loses that, and a drift test adds complexity for a function nothing calls at runtime.
  - `[false]` `[reject]` (blind) The `/capacity` substring scan could fail on a future legitimate string. — The spec requires that no non-test `.mjs` under `tools/` contains `/capacity`. A future hit fails loudly by design, which is the guard.
  - `[false]` `[reject]` (blind) The leak sweep never feeds a QA serial in through `/agent/push` or `/agent/sync`. — A push's `status` is the agent's own `agentStatus` (service audience, `qa_ids` redacted; tools/host-agent/push.mjs:35,167), and its events are allowlists with no serial field (lock.mjs:160-176). Nothing unredacted is replicated.
  - `[false]` `[reject]` (blind) Detection gaps: encoded serials, no read of a retired Resource, the stream never closed, a 4 s poll. — No code encodes or truncates a serial. Both services are stopped by SIGTERM in `finally`, which ends the stream. The poll passed in both full runs (2008/2008), and a retired read is part of the write-readback test.
  - `[low]` `[patch]` (blind) Smaller issues: an orphaned `ownKey` comment, `slot` computed in hub-device, `offThread` passed to `forceReleaseLease`, and three shapes for `qaIds`. — Moved the comment back above `ownKey` (commit 3276468). `slot` only formats the output line and is not a second dispatch. `forceReleaseLease` ignores `offThread`. `qaIds` is a function on a context and a Set or array on `leaseView`, as documented.
  - `[false]` `[reject]` (edge) A `qaOf` Registry read after take or extend could throw and leave an orphan Lease. — `readRegistry` never throws (store.mjs:89-102), so the view is always built.
  - `[false]` `[reject]` (edge) `qaOf` ignores an array or Set `ctx.qaIds` and fails open. — Every context sets `qaIds` as a function: `qaIdsOf` in tools/hub-api/routes.mjs:479 and `withQa` in tools/host-agent/routes.mjs. No caller passes a list.
  - `[medium]` `[defer]` (edge) The Host Agent never refreshes before `GET /leases/{id}`, so a stale `known` leaks. — The same root cause as the first blind finding. Deferred.
  - `[false]` `[reject]` (edge) Only exact-equality env values are nulled, so an embedded serial would leak. — A phone Lease's env is `HUB_LEASE_ID`, `HUB_DEVICE` (the device word), `ANDROID_ADB_SERVER_PORT` and adb-id-valued keys. None embeds the serial except the adb-id values, and those are nulled.
  - `[false]` `[reject]` (edge) Emulator Lease views bypass the QA redaction. — An emulator is never a `dedicated_qa` phone. Its serial is `emulator-<port>` and carries no phone serial.
  - `[false]` `[reject]` (edge) `GET_REFUSALS` maps `/health`, `/resources` and `/pools` to null. — Those routes take no parameters and have no refusal but wrong-method, which the test exercises.
  - `[false]` `[reject]` (edge) The `/capacity` scan covers only `tools/**/*.mjs`. — That is the scope the spec requires. The ROUTES/AGENT_ROUTES rows and both services' 404 are checked as well.
  - `[low]` `[reject]` (edge) `importsOf` misses double-quoted, namespace and commented-out imports. — The repo uses only single-quoted named imports. A miss fails the Calls test loudly, not silently. Widening the regex adds complexity for a case nobody writes.
  - `[false]` `[reject]` (edge) The Calls check admits `events`, `replica` and `receipt` beyond "Claims or store". — The spec's Always rule names those five modules on purpose, because `/history`, `/agent/push` and the agent's `/health` really call them. Any fix would edit this spec.
  - `[medium]` `[defer]` (verification-gap) No test covers a Host Agent Lease view with a stale `known`. — The same root cause as the first blind finding. Deferred with the test that would settle it.
  - `[low]` `[reject]` (verification-gap) The Calls cell is a label: no assertion ties a handler to its export. — The dispatch is covered by behaviour (lease-view.test.mjs and the force-release tests). Tracing handler bodies would need an AST walk, and a silently wrong label is unlikely while the import check holds.
  - `[false]` `[reject]` (verification-gap) The eager `qaOf` Registry read on emulator Leases could fail `GET /leases/{id}`. — `readRegistry` never throws. It costs one file read per view and does not fail.
  - `[false]` `[reject]` (intent) Refusal and readback run through `handle()`, not the listener. — The listener sends `handle()`'s headers unchanged. The leak sweep reads raw headers and bodies from the booted `startHubApi` and `startHostAgent`.
  - `[false]` `[reject]` (intent) The "exact key sets per route" assertions are not new in this diff. — They already existed (the doc==code==live-answer tests), and the spec keeps them as they are. The diff adds the floor beside them.
  - `[false]` `[reject]` (intent) The Lease leak rows go through `handle()` rather than the booted service. — The booted-service sweep also reads `GET /leases/{id}` from its GET sample on both services, and finds no serial.

## Design Notes

`calls` mapping: `/health` `store.registryState`; `/resources`, `/resources/{id}`, `/pools` `store.readRegistry`; `/discovery` `claims.discover`; `/status`, `/stream` `claims.statusView`; `/history`, `/utilisation` `events.readEventsFrom`; `/agent/push` `replica.createReplicas`; the three `/registry/*` writes `store.updateRegistry`; `POST /leases` `claims.serviceLease`; `GET /leases/{id}` `claims.findLease`; extend `claims.serviceExtend`; release `claims.serviceRelease`; force-release `claims.serviceForceRelease`; cancel `claims.cancel`; reservation force-release `claims.forceReleaseReservation`. Agent: `/health` `receipt.hubRef`, `/status` `claims.statusView`, `/agent/sync` `events.readEventsFrom`. The import check must accept `name as alias` imports.

Write readback (each on a fresh scratch, after the sample call): register/edit → `GET /resources/{id}` `.resource` deep-equals the answer's `resource` and `rev` matches `GET /resources`; retire → `GET /resources/{id}` is 404 `retired` when `visibility: hidden`, and `rev` matches; lease/extend → `GET /leases/{id}` deep-equals the answer; release/force-release → `GET /leases/{id}` 404 and the lock is free in `GET /status`; cancel → each `queues[]` waiter list matches the `GET /status` waiters on that lock (ids, order); reservation force-release → `GET /status` has no reservation with that `run_key`; `/agent/push` → `replica` equals a second duplicate push's `replica` and `GET /status` `hosts.mac` exists when the push carried a status.

## Verification

**Commands:**
- `node --test tools/hub-api/contract.test.mjs tools/hub-api/leak.test.mjs tools/hub-api/leases.test.mjs tools/hub-api/force-release.test.mjs tools/hub-api/emulator-force-release.test.mjs tools/hub-api/extend-release.test.mjs` -- expected: all pass
- `heavy mise run check` -- expected: green

## Auto Run Result

Status: done

**Summary.**
- Contract 1 is frozen in a committed baseline, `tools/hub-api/contract-freeze.json`. The contract test treats it as a floor: removing or renaming a route, a shape field, a code or an extension member fails, and an addition passes.
- Every route row in the doc and in `ROUTES` / `AGENT_ROUTES` carries a `Calls` cell naming one `<module>.<export>`. The test checks that doc and code agree and that the export is imported.
- `GET /capacity` is reserved under `## Reserved`. It is absent from code and answers 404 `HUB_NO_ROUTE`.
- The Lease serial leak is fixed once, in the Claims library. A service's Lease view on a `dedicated_qa` Resource now has `env.ANDROID_SERIAL` (and every env value equal to the adb id) set to `null`. Before the fix it leaked through `GET /leases/{id}`, extend and a repeat take, on both services.
- Force-release has one dispatch, `claims.serviceForceRelease`.
- The new sweeps are driven by the route tables, so they cover every route of both services, present and future:
  - no QA serial appears in any GET (including `/stream` frames) or POST answer;
  - every refusal is `application/problem+json`;
  - every POST success equals a fresh read.

**Files changed.**
- `tools/device/claims.mjs`: QA-aware `leaseExports` and `leaseView`; `qaOf` threaded through `findLease`, `serviceLease` and `serviceExtend`; new `serviceForceRelease`.
- `tools/hub-api/routes.mjs`: `calls` on every row, a lazy `qaIds` in `serviceContext` and `getLease`, and force-release now goes through `serviceForceRelease`.
- `tools/host-agent/routes.mjs`: `withQa` from `known`, and `calls` on the agent's own rows.
- `tools/device/hub-device.mjs`: force-release calls `claims.serviceForceRelease`.
- `docs/hub-api-contract.md`: the `Calls` columns and their legend, `## Reserved`, the dated additive note, and the Lease redaction note.
- `tools/hub-api/contract-freeze.json`: the committed baseline for contract 1.
- `tools/hub-api/contract.test.mjs`: the freeze floor and its synthetic cases, Calls, capacity, the refusal envelope and write readback.
- `tools/hub-api/leak.test.mjs`: the QA sweep over both booted services, plus the QA and non-QA Lease rows.
- `tools/device/lease-view.test.mjs`: QA `leaseView` and the `serviceForceRelease` dispatch.
- `tools/device/claims.test.mjs`: the export list.

**Review findings.** 25 findings: high 0, medium 3, low 7, false 15.
- 3 low patches applied in commit 3276468:
  - the contract's additive note wording;
  - the `env.*` row wording about when the key exists;
  - the orphaned `ownKey` comment.
- 1 entry deferred (3 medium findings with one root cause): the Host Agent redacts by `known`, which can be stale. It cannot happen in today's deployment, because the Mac spoke has no phones.
- Rejected:
  - 4 low findings: the freeze covers handler-output fields, not request bodies or status codes; `freezeOf` is kept as the generator; `importsOf` only handles the import form the repo uses; the Calls cell is a label backed by behaviour tests.
  - 15 false findings: refuted in the triage log (`readRegistry` never throws, pushes are redacted at source, and so on).

**Follow-up review recommended:** false. Patched this pass: high 0, medium 0, low 3.

**Verification.**
- The focused `node --test` list (contract, leak, leases, force-release, emulator-force-release, extend-release) passed 108/108 after the patches. `lease-view.test.mjs` passed earlier, and in the full run.
- `heavy mise run check` (actionlint plus the full suite) was green: 2008/2008, 0 failures.
- Matrix audit: every I/O row has a covering test, and each one ran and passed.
  - The field-removed and route-renamed rows are covered by the freeze floor's synthetic removal and rename cases; the field-added row by its addition case.
  - The capacity row is covered by the capacity test.
  - The QA Lease and non-QA Lease rows are covered by `leak.test.mjs` and `lease-view.test.mjs`.
  - The leak sweep row is covered by the Hub API and Host Agent sweeps.
  - The refusals and write readback rows are covered by the contract tests.

**Residual risks.**
- The Host Agent's stale-`known` redaction gap is deferred (above).
- The leak test boots the agent with host key `linux` so it owns QA phones.
- Agent-to-Hub pushes are not exercised end to end in the sweep.
- The `/stream` sweep waits on a real 250 ms debounce.
- `contract-freeze.json` is hand-owned from now on. Any change to a frozen shape needs a new contract version and a new freeze file.
