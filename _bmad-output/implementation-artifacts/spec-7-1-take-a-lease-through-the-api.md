---
title: 'Story 7.1: Take a Lease through the API'
type: 'feature'
created: '2026-11-25'
status: 'done'
baseline_revision: '3999f38c42bb3c13f1285c1038336ac82ee2c790'
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-7-context.md'
  - '{project-root}/docs/hub-api-contract.md'
warnings: ['oversized']
deferred: []
---

<intent-contract>

## Intent

**Problem:** A Lease can only be taken from a shell on big-chungus (`hub-device lease`). The Hub API has no Hold write route, and the Claims library's errors have no HTTP status, so a lease-route error would answer 500.

**Approach:** Add `POST /leases` (by word, Resource id or `match`, no wait). Every service front door calls the same Claims function, which takes the Lease the way `hub-device lease <word> --no-connect` does: `holderPid: null`, no `findPhone`, expiry-bound, no `GITHUB_*` identity. It records `claimant_kind` and `actor`. One HTTP table in `claims.mjs` gives library errors their status. One level up (pillar `belsky-doctrine`): the Hub API's lease takes, and every Epic 7 route and the Host Agent (Epic 9), reuse that function, its body check, its Lease view and the HTTP table.

## Boundaries & Constraints

**Always:**
- Any rule about resolving, taking, bounds, ids or the error-to-exit/HTTP table lives in `tools/device/claims.mjs`. `routes.mjs` only checks the body through claims, calls claims and serialises the result (AD-24).
- `lock.mjs` stays the only writer of the lock dir and the Event Log (AD-1). New `acquireLease`/`acquirePool` options are additive: `claimantKind` (`agent` default, or `person`; anything else is a TypeError) and `actor` (checked by `checkActor`).
- An API Lease has `holderPid: null`, `noConnect: true` and `waitMs: 0`, and its env has no `GITHUB_*` key. The owner record gains an additive `claimant_kind`. `eventOf` takes the claimant kind from `subject.claimant_kind ?? 'agent'`.
- The actor is the body's `actor` when present, else `{holder, via: 'api'}`. The library never rewrites a present actor.
- Hermetic tests only. Code under test gets injected seams (`now`, `readings`, fake `createServer`). No real socket, adb or emulator.

**Never:**
- No `wait_ms`, emulator leases, extend, release, cancel or `GET /leases/<id>` (Stories 7.2 to 7.8). `wait_ms` is refused as an unknown key, and `emulator` (word or match) is refused `HUB_USAGE`.
- Do not modify `tools/ci/lib/eta.mjs` (open question Q2: person history stays separate by kind).
- No change to the deploy path (`tools/ci/commands/*`, `tools/catchup/*`). No Python and no dependencies.
- Do not change `hub-device` CLI flags or output, except the status `pid` nulling below.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Word lease, free | `{resource:'s24', for_ms:1800000, holder:'h', why:'w'}` | 200 `Lease`. Owner record `holder_pid:null`, `claimant_kind:'agent'`, no `device.adb_id`. One `acquire` event with `actor:{holder:'h',via:'api'}` | — |
| Resource id / Pool word | `resource:'res-…'` or `'phone'` | Same as above, via `claims.resolve`. `phone` over 60 min narrows to the S24 | — |
| Match | `match:'kind=phone'` | Lease on the first member. Members whose cached reading is `absent`, `offline` or `unauthorized` are dropped | All dropped → 503 `HUB_DEVICE_AWAY`, exit 75, reason `away` |
| Person | `claimant_kind:'person'` | Record and `acquire` `claimant.kind` are `person` | Other value → 400 `HUB_USAGE` `bad-claimant-kind` |
| Busy | lock held | 409 `HUB_LOCK_TIMEOUT`, exit 76, reason `busy`. `detail` keeps `host lock <name> is held …`. No event | — |
| Retired | Registry marks it retired or seed-missing | 409 `HUB_RESOURCE_RETIRED`, exit 2, reason `retired`/`seed-missing` | — |
| Unmatched | match finds nothing | 404 `HUB_NO_MATCH`, exit 2, reason `no-match` | — |
| Over cap | `s26` with `for_ms` > 60 min, or anything > 48 h | 400 `HUB_USAGE` naming the cap. The deploy-target one ends `lease s24 or an emulator for longer` (`capText`) | Nothing written |
| Bad body | not an object; unknown key (incl. `wait_ms`); both or neither of `resource`/`match`; bad `for_ms`/`id`/`actor`; no `holder`; empty `why` | 400 `HUB_USAGE` with reasons `bad-body`, `bad-target`, `bad-for`, `bad-id`, `bad-actor`, `no-holder`, `bad-why` | Checked before anything is read |

</intent-contract>

## Code Map

- `tools/device/claims.mjs` -- the library. `take` (l.526) passes `options` to `takePhone`→`acquireLease` (spread, l.434) and to `takeAnyPhone`→`acquirePool` (explicit fields, l.471: add `claimantKind`, `actor`). `reachableMembers` (l.507) is the away filter and is skipped for `noConnect` (l.536). `checkBounds` (l.352) hard-codes `--for` in its 48 h text. `leaseExports` (l.543) is the CLI's exports. `statusView` lock rows (l.756–766) render `pid`. `EXIT_CODES` (l.46) is the exit table. `createContext` (l.127), `loadFleet` (l.160), `resolve` (l.300), `matchTarget` (l.243).
- `tools/ci/lib/lock.mjs` -- `acquireLease` (l.1563, record l.1643, `asked` l.1610, `acquire` note l.1683) and `acquirePool` (l.1183, record l.1280, `acquire` note l.1314, `poolRequest` l.1259). `eventOf` hard-codes `claimant.kind: 'agent'` for leases (l.166). `checkActor`/`ACTOR_VIA` (l.192–202). `staleness` never judges a lease by `pid` (l.124–136), so `holder_pid:null` is never reclaimed on restart.
- `tools/hub-api/routes.mjs` -- `ROUTES` (l.241): add one row. `problem()` (l.54) treats an error with no `status` as 500, so it must consult the claims HTTP table. `readIt` (l.96). Registry handlers are the model for a write handler.
- `tools/hub-api/server.mjs` -- `startService` (l.85) builds `context.env`. `startHubApi` (l.135) passes `env` to recovery, the seed and readings. `requestListener` (l.68) can be driven with fake req/res.
- `tools/hub-api/readings.mjs` -- `ctx.readings.read(records)` returns `Map(id → {state,…})` synchronously and never waits (AD-44).
- `tools/device/hub-device.mjs` -- `lease` (l.230) JSON is `{lease_id, device, holder, why, expires_at, env}`: the parity reference.
- `tools/hub-api/contract.test.mjs` -- `POST_SAMPLES` (l.116) needs a `/leases` sample. The test checks the doc's routes, shapes, codes and exits against code.
- `docs/hub-api-contract.md` -- the route table, shapes, `Request bodies` and `Error codes`.
- Test patterns: `tools/hub-api/register.test.mjs` (scratch env and `handle()`), `tools/hub-api/server.test.mjs` (fake server), `tools/device/hub-device.test.mjs` (CLI `main` with seams), `tools/ci/lib/events.mjs` `readEvents`.

## Tasks & Acceptance

**Execution:**
- `tools/ci/lib/lock.mjs` -- `acquireLease` and `acquirePool`: add `claimantKind` (validated) and `actor` (`checkActor`). Write `claimant_kind` into the owner record, the `asked` subject and the Pool subject. Add `actor` to every event the call writes. In `eventOf`, a lease's `claimant.kind` becomes `subject.claimant_kind ?? 'agent'` -- the kind must survive into later release, extend and reclaim events.
- `tools/device/claims.mjs`:
  - Add `HTTP_ANSWERS`, `code → {status, reason?}` data: `HUB_USAGE`/`HUB_EMULATOR_USAGE`/`HUB_LEASE_TOO_LONG`/`HUB_DEVICE_JOB_ID` 400; `HUB_NO_MATCH` 404 `no-match`; `HUB_LOCK_TIMEOUT`/`HUB_DEVICE_BUSY` 409 `busy`; `HUB_POOL_CROSS_HOST`/`HUB_RESOURCE_RETIRED`/`HUB_LEASE_CANCELLED` 409; `HUB_PHONE_AWAY`/`HUB_DEVICE_AWAY` 503 `away`; `HUB_HOST_UNKNOWN` 503 `host-unknown`. Export `httpAnswerOf(error)` (null when the code is not in the table).
  - Add `withoutDeployIdentity(env)`, which drops every `GITHUB_*` key.
  - `checkBounds` gains a `flag` option (default `--for`) for its 48 h text.
  - `reachableMembers` takes an optional states function. `take` uses `options.readingsOf` for a `match` Pool when `noConnect`.
  - `takeAnyPhone` passes `claimantKind` and `actor`.
  - Add `checkLeaseBody(body)`, which applies the matrix's body rules and returns `{resource, match, forMs, holder, why, claimantKind, id, actor}`.
  - Add `leaseView(taken)` → `{lease_id, resource, lock, device, holder, why, claimant_kind, started_at, expires_at, env}`.
  - Add `serviceLease(input, ctx)`. It strips the env and loads the fleet. It resolves through `resolve`/`matchTarget` and refuses `emulator`. It runs `take` with `{waitMs:0, holderPid:null, noConnect:true, claimantKind, actor, readingsOf}` and returns `leaseView`.
  - `statusView`: a lease lock row renders `pid: null`.
- `tools/hub-api/routes.mjs` -- Add a `takeLease` handler: `checkLeaseBody`, default actor `{holder, via:'api'}`, a `readingsOf` adapter over `ctx.readings` (fleet member → Registry record by lock → served state, `unknown` when missing), `serviceLease` with `HUB_LEASE` lines to `ctx.log.out`, and a 200 `Lease`. Add the route row `POST /leases` with shape `Lease`. In `problem()`, an error without a `status` takes its status from `httpAnswerOf`. Its reason is the table's reason, else `error.reason`, else the lowercased code.
- `tools/hub-api/server.mjs` -- `startService` and `startHubApi` apply `withoutDeployIdentity` to `env` before using it.
- `docs/hub-api-contract.md` -- Add the `POST /leases` route row (Added 7.1), a `### Lease` field list (`env.*` open), the request body and refusal order, the error-code rows `HUB_LOCK_TIMEOUT` (409, 76), `HUB_DEVICE_AWAY` (503, 75), `HUB_NO_MATCH` (404, 2) and `HUB_POOL_CROSS_HOST` (409, 2), the lease reasons on `HUB_USAGE`, and take refusal on `HUB_RESOURCE_RETIRED`. Note that library errors take their status from the table.
- `tools/hub-api/contract.test.mjs` -- Add the `/leases` sample (`{resource:'s24', for_ms:1800000, holder:'contract-test', why:'contract'}`, status 200).
- `tools/hub-api/leases.test.mjs` (new) -- Cover every row of the I/O matrix through `handle()`, and the ACs below.
- `tools/device/lease.test.mjs` or `tools/ci/pool-request.test.mjs` -- Cover lock-level `claimantKind` and `actor` (record, `acquire` event, a later `release` event's kind, TypeError on a bad kind).

**Acceptance Criteria:**
- Given a free s24, when `POST /leases` takes it, then the owner record has `holder_pid: null` and no `adb_id`, and the Event Log's one `acquire` carries `actor: {holder, via: 'api'}` and `claimant.kind` as given.
- Given the same `id`, `holder`, `why`, `for` and `now`, when `hub-device lease s24 --no-connect --json` and `POST /leases {resource:'s24'}` each run on a fresh scratch, then their `env` exports are equal and their owner records are equal.
- Given a service started through `startHubApi` with `GITHUB_REPOSITORY`/`GITHUB_RUN_ID` injected into `env` and a fake `createServer`, when a lease is taken through its listener, then no owner record or event carries those values (`repo`/`run` null).
- Given an API Lease whose record `pid` is a dead process, when another try takes the same lock before `expires_at`, then it is refused busy: the Lease is not reclaimed. `hub-device status --json` shows the lease's `holder`, and its lock row has `pid: null`.
- Given `mise run check`, when it runs, then it is green, and `git diff main -- tools/ci/lib/eta.mjs` is empty.

## Design Notes

- **Busy and away keep the library's codes** (`HUB_LOCK_TIMEOUT`, `HUB_DEVICE_AWAY`). `reason` `busy`/`away` comes from the table. `detail` keeps the wording 7.2 needs.
- **The away filter applies only to `match`.** For a word, AD-36 requires exact `--no-connect` semantics, so a word lease is never away. A `match` asks for a phone that can serve, so it drops members the service's cache already knows are away (no `/proc` or adb on the request path, AD-44). `unknown` drops nothing, as in `reachableMembers`.
- **48 h vs the 60 min cap.** Both refusals name their cap. Only the deploy-target cap points to the S24 or an emulator (`capText`), because those also stop at 48 h.

## Verification

**Commands:**
- `node --test tools/hub-api/leases.test.mjs tools/hub-api/contract.test.mjs tools/device/lease.test.mjs` -- expected: all pass
- `heavy mise run check` -- expected: actionlint and the full suite green

## Spec Change Log

## Review Triage Log

### 2026-11-25 — Review pass
- verdicts: 30 findings — high 0, medium 1, low 15, false 14, maybe-false 0
- findings:
  - `[low]` `[patch]` (blind) epic-7-context.md says 7.1 adds the `GET /leases/<id>` contract entry; the story puts it in 7.2 — corrected the Cross-Story line: 7.1 adds `POST /leases` (no wait), `claimant_kind` and the caps; 7.2 adds waits, the repeat-`id` rules and `GET /leases/<id>`.
  - `[low]` `[reject]` (blind) a lost response cannot be retried: a repeated `id` is 400 and there is no `GET /leases/<id>` — the intent places repeat-`id` 200 and `GET /leases/<id>` in Story 7.2's ACs (epics-v1b.md:926-930); out of 7.1's scope.
  - `[low]` `[reject]` (blind) `statusView` nulls `pid` on CLI lease rows too — no reader uses a lease row's `pid` (the text renderer prints `pid` only for a JOB LOCK, hub-device.mjs:380; no Holocene reader), `holder_pid` still names the holding process; gating adds a branch for no named harm.
  - `[low]` `[reject]` (blind) library usage refusals answer `reason: hub_usage`, so over-cap and taken-id share a reason — documented in the contract's `HUB_USAGE` row with `detail` saying why; distinct reasons would add library error surface for a case no client branches on yet.
  - `[false]` `[reject]` (blind) the table's `away` overwrites `HUB_PHONE_AWAY`'s specific `absent` — unreachable from `POST /leases`: `serviceLease` is always `noConnect`, so `connectPhone` never runs; `HUB_DEVICE_AWAY` keeps each member's state in `detail`, and the AC requires `503 away`.
  - `[false]` `[reject]` (blind) the `match` away filter is inert on a cold cache — by design: `unknown` drops nothing (reachableMembers' rule and the contract's "every member the service's cache knows is away"); the take is then the lock-only `--no-connect` Lease.
  - `[false]` `[reject]` (blind) `readingsOf` reads the Registry per call and an unreadable Registry would 500 — `readRegistry` falls back to the seed for an unreadable file and never throws for it (store.mjs:89-101); `matchTarget` reads it first on the same path.
  - `[low]` `[reject]` (blind) `holder`/`why` have no length or control-character limits — the Event Log is JSON-encoded (a newline cannot forge a record), names are recorded as given with no authentication (NFR-6) and the CLI and Registry routes accept the same; a guard adds new refusals for no seen case.
  - `[low]` `[reject]` (blind) the parity test compares only the word path's exports and record, not events or refusals — the story AC pins exactly exports and record; refusals come from the one `take`, and events differ by the API actor by design.
  - `[low]` `[patch]` (blind) test quality: misleading title/`byId` at leases.test.mjs:92, vacuous `registryPath` assertion, a duplicate `lock.mjs` import in lease.test.mjs, and no API test of the Pool path's kind/actor — renamed the test and variable, deleted the assertion and import, folded the import (2fe3062); the Pool-path part is the verification-gap entry below.
  - `[false]` `[reject]` (blind) the service-wide `GITHUB_*` strip is broader than needed, and `hostId` is not forwarded — the AC requires the service's environment to carry no `GITHUB_*`; production `startHubApi` (server.mjs:156) passes no `hostId` or `devices`, so the lease and the service use the same machine id.
  - `[low]` `[reject]` (edge) wait tickets carry no `claimant_kind`, so a person waiter's cancel reads `agent` — unreachable in 7.1 (the API takes with `waitMs: 0`, the CLI passes no `claimantKind`); Story 7.2 adds API waits and owns the ticket shape.
  - `[low]` `[reject]` (edge) `match: 'kind=emulator'` answers 404 `HUB_NO_MATCH`, not 400 — the same answer `hub-device lease --match kind=emulator` gives (CLI parity), with `detail` "--match takes a phone"; a special case adds a branch.
  - `[low]` `[reject]` (edge) two concurrent requests with one `id` can take two locks — the `checkLeaseId`-then-acquire gap predates this story (two CLI processes race the same way), needs a client to reuse its own id concurrently, and the fix adds in-process reservation state.
  - `[false]` `[reject]` (edge) `ctx.devices` seam vs the env's devices.json splits the fleet and the readings — production passes no `devices` (server.mjs:156), so both read `loadDevices(env)`; records are looked up by lock.
  - `[false]` `[reject]` (edge) `readIt` throwing inside `statesOf` gives a 500 — `readRegistry` falls back to the seed for an unreadable file (store.mjs:89-101) and `readings.read` is a synchronous cache read.
  - `[false]` `[reject]` (edge) `HUB_LEASE_EXTEND_REFUSED`, `HUB_LEASE_LOST` and lock.mjs TypeErrors are not in the table — none is reachable from `serviceLease` (no extend, no connect; `checkLeaseBody` validates kind and actor first); the routes that reach them add their codes.
  - `[low]` `[reject]` (edge) `statusView` drops `pid` on CLI lease rows — same as the blind finding above: no reader of a lease row's `pid`; `holder_pid` stays.
  - `[low]` `[reject]` (edge) `eventOf` passes an out-of-set `claimant_kind` from a hand-edited record — every writer validates the kind; only a hand-edited lock file reaches it, and a guard adds a branch.
  - `[medium]` `[patch]` (verification-gap) the Pool path (`takeAnyPhone` → `acquirePool`) of a service Lease is untested for `claimant_kind` and `actor` — added "the Pool path records claimant_kind and actor" (match with a person and a given actor; `phone` with the default actor), which fails with the plumbing deleted (2fe3062).
  - `[false]` `[reject]` (intent) no test binds a real socket — the repo's hermetic rule forbids it; `requestListener` and `startHubApi` with fake req/res and `createServer` cover body parsing and headers.
  - `[false]` `[reject]` (intent) the answer is a `Lease` view rather than the raw owner record ("the resulting Hold") — the Lease is the Hold; the documented `Lease` shape carries its fields plus the CLI's exports.
  - `[false]` `[reject]` (intent) the actor default lives in the route, so a second front door repeats it — AD-36 sets the actor at the first front door and `via` names that door; `serviceLease` passes it through unchanged.
  - `[false]` `[reject]` (intent) "never reclaimed on restart" is tested with a dead pid, not a restart — `staleness` never judges a Lease by pid (lock.mjs:124-136), so the dead-pid test is the only path a restart could take.
  - `[low]` `[reject]` (intent) `statusView` nulls `pid` for every lease row — same as the blind finding above.
  - `[low]` `[reject]` (intent) a word lease on a phone the cache knows is away answers 200, so away is reachable only through `match` — the AC requires a word lease to equal `hub-device lease <word> --no-connect`, which never checks reachability.
  - `[false]` `[reject]` (intent) the 48 h refusal names the cap but no pointer to the S24 or an emulator — those stop at 48 h too, so a pointer would send the caller to the same refusal; the deploy-target refusal carries it.
  - `[false]` `[reject]` (intent) no worker-thread offload or under-1 s assertion — not a 7.1 AC; the path runs no adb, no `spawnSync` and reads cached readings.
  - `[low]` `[patch]` (intent) test oddities: the vacuous `registryPath` assertion and the duplicate import — fixed with the blind test-quality entry (2fe3062).
  - `[false]` `[reject]` (intent) `mise run check` and the `eta.mjs` diff are not shown — both ran: 1272/1272 green, `git diff main -- tools/ci/lib/eta.mjs` empty.

## Auto Run Result

**Status: done.** No acceptance criterion needs a human outside the repo.

**Summary.** `POST /leases` takes a Lease on a phone by word, Resource id or `match`, with no wait. The route checks the body with `claims.checkLeaseBody` and calls `claims.serviceLease`, the one function every service front door will call (the Hub API now, the Host Agent in Epic 9). That function takes the Lease exactly as `hub-device lease <word> --no-connect` does: `holderPid: null`, no `findPhone`, no adb on the request path, an env with no `GITHUB_*` key. It records `claimant_kind` (`agent` or `person`) and the `actor` (`{holder, via: 'api'}` by default). One HTTP table in `claims.mjs` (`HTTP_ANSWERS`) gives library errors their status: busy 409/76, away 503/75, retired 409/2, no-match 404/2. A `match` drops the members the service's cache knows are away.

**Files changed.**
- `tools/ci/lib/lock.mjs`: `claimantKind` and `actor` options on `acquireLease`, `acquirePool` and `poolRequest`. `claimant_kind` is written to the owner record, and `eventOf` keeps the kind on later events.
- `tools/device/claims.mjs`: adds `HTTP_ANSWERS`/`httpAnswerOf`, `withoutDeployIdentity`, `checkLeaseBody`, `leaseView` and `serviceLease`. `reachableMembers` takes a cached-states function and `checkBounds` gains a `flag`. Status lease rows render `pid: null`.
- `tools/hub-api/routes.mjs`: the `POST /leases` route and handler. `problem()` consults the HTTP table, and a table-known error is no `HUB_API_ERROR`.
- `tools/hub-api/server.mjs`: the service environment drops every `GITHUB_*` key.
- `docs/hub-api-contract.md`: the route, the `Lease` shape, the request body, the refusal order and the new error rows.
- `tools/hub-api/contract.test.mjs`: the `/leases` sample.
- `tools/hub-api/leases.test.mjs` (new, 20 tests): every I/O row, CLI parity, `GITHUB_*` stripping, dead-pid no-reclaim, the HTTP table and the Pool path's kind and actor.
- `tools/device/lease.test.mjs`: lock-level `claimantKind`/`actor` tests.
- `_bmad-output/implementation-artifacts/epic-7-context.md` (new): the Epic 7 context.

**Review findings.** 30 findings from 4 layers: 0 high, 1 medium, 15 low, 14 false.
- **Patched (3 entries, 1 medium and 2 low):**
  - The Pool path's `claimant_kind` and `actor` now have an API test. It fails if the plumbing is deleted.
  - Test titles and imports were tidied.
  - The epic context's `GET /leases/<id>` line was corrected to name 7.2.
- **Deferred:** none.
- **Rejected:** every other finding, each with its reason in the Review Triage Log. In short:
  - Out of 7.1's scope: retry-safety and `GET /leases/<id>` belong to Story 7.2.
  - Low, with no named harm, and the fix would add a branch or surface: the status `pid` on CLI lease rows, the `hub_usage` reason, holder/why limits, the narrow parity test, wait-ticket kind (7.2), `kind=emulator` answering 404 as the CLI does, the same-id race, and an out-of-set kind in a hand-edited record.
  - False, disproved at the cited code: the rest.

**Follow-up review recommended: false.** This was a first pass. It patched 1 medium and 2 low entries and no high, which is below the threshold.

**Verification.**
- `node --test tools/hub-api/leases.test.mjs tools/hub-api/contract.test.mjs tools/device/lease.test.mjs`: 95/95 pass.
- `heavy mise run check`: actionlint and 1272/1272 green.
- `git diff main -- tools/ci/lib/eta.mjs`: empty.
- The implementer deleted the Pool-path plumbing and confirmed that only the new test failed, then restored it.

**Residual risks.**
- Wait tickets carry no `claimant_kind` or `actor`. Story 7.2, which adds API waits, must write both into the ticket so a person waiter's `cancel` or `timeout` keeps its kind.
- Library usage refusals share `reason: hub_usage`. A client tells an over-cap from a taken `id` only by `detail`.
- A `match` taken before the readings cache has filled drops nothing, which is by design. The first match after a service start may lease a phone that is away, as `--no-connect` would.
- Nothing is shipped until Story 7.9 (`hosts:install` and a live S24 check).
