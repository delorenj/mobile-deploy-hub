---
title: 'Story 7.2: Wait for a Lease through the API'
type: 'feature'
created: '2026-11-25'
status: 'done'
baseline_revision: '8cd4541b5ec8084af48b68e11046e1fe526c4b82'
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-7-context.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-7-1-take-a-lease-through-the-api.md'
  - '{project-root}/docs/hub-api-contract.md'
warnings: ['oversized']
deferred: []
---

<intent-contract>

## Intent

**Problem:** `POST /leases` (7.1) only tries: an agent that wants the next free phone must poll, and nothing ties a waiting place in line to the client that asked for it, so a vanished client could hold a place or be granted a Hold nobody receives.

**Approach:** Accept `wait_ms` on `POST /leases`. The wait runs through the same `serviceLease` (Claims library), bound to the HTTP connection by one per-service wait registry (`createLeaseWaits` in `claims.mjs`) that owns the AD-37/AD-48 rules: client-minted id, disconnect aborts, a grant to a gone client is released, repeat-id returns or takes over, SIGTERM answers `503 HUB_API_RESTARTING`. Add `GET /leases/{id}`. One level up (pillar `belsky-doctrine`): every service front door (Hub API now, Host Agent in Epic 9) gets waits by reusing the registry and `startService`'s stop, and every Pool timeout (CLI and API) now keeps AD-5's `host lock <name> is held …` wording.

## Boundaries & Constraints

**Always:**
- Rules live in `tools/device/claims.mjs`; `routes.mjs` checks the body through claims, calls claims and serialises. `lock.mjs` stays the only lock-dir and Event Log writer (AD-1).
- The server writes nothing (no status line, no header) until the outcome; every answer of `POST /leases` that knows the id (body `id`, or the minted `lease_id` on success) carries `X-Request-Id: <id>`.
- A wait (`wait_ms > 0`) needs a body `id`; a ticket's `pid` is the serving process (`process.pid`, already `buildTicket`'s default) and the ticket gains an additive `claimant_kind`, which `prune` and release-cancel events read (`?? 'agent'`).
- The service passes one cached process-start reader (`cachedProcessStart`, one read per pid per 2 s, shared across waiters) to every wait (AD-44). No `spawnSync` added on the request path.
- Hermetic tests: fake req/res (an `EventEmitter` `res` with `writableFinished`), injected clock/sleep, no socket, adb or emulator.

**Never:**
- No extend, release, cancel, force-release or emulator routes (7.3–7.8); `emulator` stays refused. No `hub-client` requeue logic (Story 8.6). No new `hub-device` verb or flag.
- Do not modify `tools/ci/lib/eta.mjs`, the deploy path (`tools/ci/commands/*`, `tools/catchup/*`), or add dependencies / Python.
- A takeover is not a cancel: no Event Log line, the place in line is kept.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Wait, freed in time | s24 held; `{…, id:'w-1', wait_ms:60000}`; holder releases | Ticket (pid = service, `claimant_kind`) then 200 `Lease`, `X-Request-Id: w-1`; one `request` + one `acquire` | — |
| Wait times out | s24 stays held | 409 `HUB_LOCK_TIMEOUT` exit 76 `busy`, `detail` starts `host lock s24 is held by`; `timeout` event | — |
| Pool wait times out | `phone`/`match`, every member held | Same 409; `detail` starts `host lock <lock> is held by` | — |
| No id with a wait | `wait_ms>0`, no `id` | 400 `HUB_USAGE` `no-id` | nothing written |
| Bad wait | `wait_ms` not a safe integer ≥ 0 | 400 `HUB_USAGE` `bad-wait` | nothing written |
| Disconnect mid-wait | connection closes | wait aborted; `cancel` event `reason: aborted`; ticket gone; nothing written to the socket | — |
| Grant after disconnect | Hold granted after the connection's abort | Hold released at once (`release` event `reason: undelivered`) | — |
| Grant then disconnect | 200 written, then close | Hold stands; `GET /leases/w-1` → 200 `Lease` | — |
| Repeat, held, same holder | `id` held by same `holder` (wait or not) | 200 existing `Lease`; no second take, no event | different holder → 400 `HUB_USAGE` (as 7.1) |
| Repeat, still waiting | same `id` + `holder` while its wait is open | new connection takes over (original resource, `for_ms`, deadline); old gets 409 `HUB_LEASE_SUPERSEDED` exit 1 `superseded`; no event | — |
| SIGTERM with open waits | `stop()` / signal | each open wait 503 `HUB_API_RESTARTING` exit 1 `restarting`, `retry:'requeue'`; tickets aborted (`cancel`); then close + `HUB_API_STOP` | new requests during stop: same 503 |
| Crash leftovers | ticket of a dead pid on this host, `claimant_kind:'person'` | next take prunes it: `prune` event, `claimant.kind: person` | — |
| `GET /leases/{id}` | held / waiting / unknown | 200 `Lease` / 404 `HUB_LEASE_NOT_FOUND` exit 2 `waiting` / same `unknown` | — |

</intent-contract>

## Code Map

- `tools/device/claims.mjs` -- `EXIT_CODES` (l.46) and `HTTP_ANSWERS` (l.86): add `HUB_LEASE_NOT_FOUND` (2; 404), `HUB_LEASE_SUPERSEDED` (1; 409 `superseded`), `HUB_API_RESTARTING` (1; 503 `restarting`). `noPhoneError` (l.468) is the Pool timeout text. `takeAnyPhone` (l.485) passes acquirePool options explicitly (add `processStart`); `takePhone` (l.452) spreads options. `phoneOwning`/`phoneWaiting` (l.244–245) find a Lease/waiter by id. `checkLeaseBody` (l.604, `LEASE_BODY_KEYS` l.594), `leaseView` (l.627), `serviceLease` (l.641, today `waitMs: 0`), `connectPhone`'s noConnect device shape (l.418).
- `tools/ci/lib/lock.mjs` -- `buildTicket` (l.624) body; `notePruned` (l.725) and `releaseLease`'s cancel (l.1760) build the ticket subject; `acquirePool` default timeout text (l.1394); `acquireLease` (l.1576): ticket written l.1624, abort → `cancel` `aborted` in `finally` (l.1729), `signal.throwIfAborted()` throws `signal.reason`; `acquirePool` settle → `poolRequest.settle` (l.1163) `aborted`. `cachedStart` (l.1119) is the cache to export. `heldText` (l.1013) is AD-5's wording.
- `tools/hub-api/routes.mjs` -- `takeLease` (l.258), `ROUTES` (l.269), `handle` (l.311: add `signal` to the handler request and `X-Request-Id` via an optional route `requestId`), `PROBLEM_EXTENSIONS` (l.52).
- `tools/hub-api/server.mjs` -- `requestListener` (l.68): per-request `AbortController` aborted on `res` `close` before `writableFinished`; skip writing when aborted. `startService` (l.85): context gets `waits` (default `createLeaseWaits()`), `stop()` awaits `waits.shutdown()` before `server.close`.
- `docs/hub-api-contract.md` + `tools/hub-api/contract.test.mjs` -- route row, `Lease` text, request body, error rows, extension row; the test's GET routes take a sample with setup (`/leases/{id}` needs a held id), `POST_SAMPLES['/leases']` gains `id`, and the extensions test needs a live `HUB_API_RESTARTING`.
- Tests to update: `tools/hub-api/leases.test.mjs` (the `wait_ms` refusal cases, the `HTTP_ANSWERS` list), `tools/device/hub-device.test.mjs:345` (Pool busy wording).

## Tasks & Acceptance

**Execution:**
- `tools/ci/lib/lock.mjs` -- `buildTicket` takes `claimant_kind` (default `null`, written last); `acquireLease`/`acquirePool` pass theirs. `notePruned` and `releaseLease` put `claimant_kind: ticket.claimant_kind ?? 'agent'` in a lease subject. `acquirePool`'s default timeout text becomes `heldText` per held member. Export `cachedProcessStart({startOf, now, ttlMs})` (the existing `cachedStart`, real clock by default).
- `tools/device/claims.mjs` -- codes above; `noPhoneError` busy text starts `host lock <lock> is held by …` per held member, then `(every phone is held)`; `takeAnyPhone` passes `processStart`. `checkLeaseBody` accepts `wait_ms` (`bad-wait`, then `no-id` after `bad-id`) and returns `waitMs`. Add `heldLease(id, ctx)` (fleet owner → `{kind:'phone', phone, lease, device}`, device from the record or the noConnect shape) and `findLease(id, ctx)` → `leaseView` or 404. `serviceLease`: same-holder repeat of a held id returns its view first; takes with `waitMs`, `signal: ctx.signal`, `processStart: ctx.processStart`; if `ctx.signal.aborted` after the take, `releaseLease(…, {reason:'undelivered'})` and throw `signal.reason`. Add `createLeaseWaits()` → `{lease(input, ctx, {signal}), shutdown(), size}`: closed → `HUB_API_RESTARTING` (`retry:'requeue'`); open same id + holder → supersede old subscriber, attach new; `waitMs>0` → register, own `AbortController` (aborted with `HUB_LEASE_CANCELLED` `reason:'disconnected'` when the current subscriber's signal aborts, or with the restarting error on shutdown), delete on settle; else run directly with the connection signal. One shared `cachedProcessStart` per registry.
- `tools/hub-api/routes.mjs` -- `takeLease` uses `ctx.waits ?? fallback` and the request `signal`; add `getLease` (`GET /leases/{id}`, shape `Lease`); `requestId` on the lease routes; `PROBLEM_EXTENSIONS.HUB_API_RESTARTING = ['retry']`.
- `tools/hub-api/server.mjs` -- the adapter and stop changes in the Code Map.
- `docs/hub-api-contract.md`, `tools/hub-api/contract.test.mjs` -- as in the Code Map; document waits, `X-Request-Id`, repeat rules, restart, the `undelivered` release.
- `tools/hub-api/waits.test.mjs` (new) -- every matrix row through `handle()`/`requestListener` with fake req/res, plus the registry directly; `tools/device/lease.test.mjs` or `tools/ci/pool-request.test.mjs` -- ticket `claimant_kind`, prune/release-cancel kind, the Pool `host lock` text.

**Acceptance Criteria:**
- Given a waiting `POST /leases` driven through `requestListener` with a fake `res`, when the wait is still open, then `res` has had neither `writeHead` nor `end` called, and the ticket's `pid` is `process.pid`.
- Given an open wait, when the fake `res` emits `close` with `writableFinished: false`, then the ticket is gone, the Event Log ends with `cancel` (`reason: aborted`) and nothing is written to `res`.
- Given an open wait and a second request with the same `id` and `holder`, when the first's lock frees, then the first answer is 409 `HUB_LEASE_SUPERSEDED`, the second is 200, and the Event Log has exactly one `request` and one `acquire` and no `cancel` for that id.
- Given open waits, when `startService`'s `stop()` runs, then each answers 503 `HUB_API_RESTARTING` with `retry: 'requeue'` before `HUB_API_STOP` is logged, and no ticket is left.
- Given `mise run check`, when it runs, then it is green and `git diff main -- tools/ci/lib/eta.mjs` is empty.

## Design Notes

- **Takeover keeps the original request.** The wait is one in-flight `serviceLease` promise per id; a repeat only swaps which connection receives its outcome, so its place, `for_ms` and deadline stay. A repeat by another holder falls through to `checkLeaseId` (400, as 7.1).
- **Grant-vs-close ordering.** A grant reaches the adapter through microtasks only, so a `close` processed before the grant is seen by the post-take `signal.aborted` check; a grant whose answer was written stands (AD-37). The test triggers the "after" case by aborting from the `HUB_LEASE` log line, which `acquireLease` prints synchronously at the grant.
- **Exit 1 for superseded and restarting:** service-side transient answers, like `HUB_API_DOWN`; 75 stays "device away".

## Verification

**Commands:**
- `node --test tools/hub-api/waits.test.mjs tools/hub-api/leases.test.mjs tools/hub-api/contract.test.mjs tools/hub-api/server.test.mjs tools/device/lease.test.mjs tools/device/hub-device.test.mjs tools/ci/pool-request.test.mjs` -- expected: all pass
- `heavy mise run check` -- expected: actionlint and the full suite green

## Spec Change Log

_No bad_spec loopbacks: the code was derived once._

## Review Triage Log

### 2026-11-25 — Review pass
- verdicts: 28 findings — high 0, medium 1, low 16, false 11, maybe-false 0
- findings:
  - `[low]` `[reject]` (blind) `wait_ms` has no upper bound; ~9e15 overflows `Date` → 500 — real for an absurd input only; a cap is a new rule plus a guard, not a direct correction.
  - `[false]` `[reject]` (blind) a Hold can be orphaned between the grant and the write — from `serviceLease`'s post-take `signal.aborted` check to `res.writeHead` there are only microtasks (`.then(finish)` → `attach` → `handle` → listener), and a socket `close` is a macrotask, so none can land in between.
  - `[low]` `[reject]` (blind) a repeat with different terms is honoured with the original ones — that is AD-48 and the matrix's "Repeat" rows; changing it means editing this build's spec.
  - `[low]` `[reject]` (blind) a `wait_ms: 0` repeat of an open wait takes it over — the matrix's takeover row is the same id + holder whatever the terms; spec-mandated.
  - `[low]` `[reject]` (blind) a same-holder repeat or GET can answer an expired, not yet reclaimed Lease — the view carries its past `expires_at`; a repeat id normally arrives seconds after a lost answer; fixing it adds a guard.
  - `[false]` `[reject]` (blind) `getLease` gets less context than `takeLease` (`qaDevices`) — both build the fleet with `loadFleet`, which always reads the Registry with `qaDevices: () => []`, and `matchTarget` excludes QA-only phones, so POST can never grant a Lease that GET cannot find.
  - `[low]` `[reject]` (blind) the CLI Pool timeout wording changed and its two suffixes differ — the change is the spec's AD-5 rule (only the `host lock … is held by` prefix is pinned); the suffixes were already different; no client parses them.
  - `[low]` `[reject]` (blind) the `cachedProcessStart` map never evicts — one small entry per distinct pid over the uptime; negligible memory, and eviction is new code.
  - `[low]` `[reject]` (blind) shutdown has no drain timeout — no adb or spawn is on the request path (AD-44), systemd's stop timeout bounds it anyway, and server.mjs is not allowed a timer (clock rule).
  - `[false]` `[reject]` (blind) the real-socket disconnect and answer semantics are unproven — checked by hand over a real `http.createServer` on 127.0.0.1:0 (`/tmp/sock-check-40559/check.mjs`, not committed: the spec forbids sockets in tests). A client abort mid-wait left 0 tickets, 0 waits and events `request`, `cancel:aborted`; a freed wait answered 200 with `X-Request-Id: s-2`, and the Hold stood after the answer.
  - `[low]` `[patch]` (blind) vestigial/misleading tests (one-element `['phone']` loop, a "stop()" test that only calls `waits.shutdown()`, a "released too" try test that proves nothing was taken) — unwrapped the loop and retitled both tests to what they check.
  - `[low]` `[reject]` (blind) the contract is thin (X-Request-Id on an id-less 503, an emulator id on GET, exit 2 for `waiting`) — exit 2/`waiting` is the matrix's own; the doc already says only a phone Lease is found and that only an answer that knows the id echoes it.
  - `[low]` `[reject]` (edge) `wait_ms` has no upper bound — same as the blind row above.
  - `[low]` `[reject]` (edge) `heldLease` ignores `expires_at` — same as the blind row above.
  - `[low]` `[reject]` (edge) a repeat with different terms — same as the blind row; spec-mandated.
  - `[low]` `[reject]` (edge) a try attaches to an open wait — same as the blind row; spec-mandated.
  - `[false]` `[reject]` (edge) a throwing `releaseLease` on an undelivered Hold replaces the 503 with a 500 — failing loudly on a lock-dir I/O error nobody showed reachable is the right behaviour; it is not a silent loss.
  - `[false]` `[reject]` (edge) a client that closes during the body read still reaches `handle()` — in node an aborted request makes the body iterator throw (a `bodyError`, so no handler runs), and once the body is read `handle` starts in the same microtask chain. If one did arrive aborted, the registry test shows a wait keeps no ticket, and the try test shows nothing is written.
  - `[false]` `[reject]` (edge) a request still reading its body at stop is cut off by `server.close` — `server.close` stops accepting connections but lets active ones finish (only idle ones close); that request then meets the closed registry and gets the 503.
  - `[low]` `[reject]` (edge) the `cachedStart` map never evicts — same as the blind row above.
  - `[false]` `[reject]` (edge) a Pool timeout detail could start `s24 absent; …` — on the API/CLI path `takeAnyPhone`'s `giveUp` (`noPhoneError`) answers HUB_LOCK_TIMEOUT only when every member is held (otherwise HUB_PHONE_AWAY), so a HUB_LOCK_TIMEOUT detail always starts `host lock`.
  - `[medium]` `[patch]` (verification-gap) the "repeat while the aborted wait is still unwinding" branch of `createLeaseWaits().lease` was untested (deleting it kept the suite green) — added a registry test: abort, repeat the same id + holder at once, and check for a fresh ticket and a `request, cancel(aborted), request, acquire` sequence ending 200. It fails with the branch deleted.
  - `[low]` `[patch]` (verification-gap) `heldLease`'s recorded-`device` branch was untested — added a GET test on an owner record with `device: {phone, serial, adb_id, adb_port}`, checking that `env` exports the recorded port and serial, not the defaults.
  - `[low]` `[patch]` (verification-gap, other) the stop test's title does not match what it checks — fixed with the blind row above (same root cause).
  - `[false]` `[reject]` (verification-gap, other) the doc's "whether or not it asks for a wait" repeat rule — the reviewer found both paths tested; no defect.
  - `[false]` `[reject]` (intent-alignment) disconnect and grant are only simulated, never over a real socket — the epic and the spec require hermetic fakes; the real-socket behaviour was confirmed by hand (see the blind row above).
  - `[false]` `[reject]` (intent-alignment) SIGTERM and crash rows run through injected signals and a planted dead-pid ticket — that is the epic's stated test strategy, and the code path is the one a real signal takes (`signals.on('SIGTERM')` → `stop`).
  - `[false]` `[reject]` (intent-alignment) `mise run check` and the empty `eta.mjs` diff are not evidenced in the diff — both were run: 1299/1299 tests green and an empty `git diff main -- tools/ci/lib/eta.mjs`.

## Auto Run Result

Status: done

**Summary.** `POST /leases` now accepts `wait_ms`. A wait goes through the same Claims `serviceLease`, bound to its HTTP connection by one per-service wait registry, `createLeaseWaits` in `tools/device/claims.mjs`:
- The client mints the id, and nothing is written until the outcome. `X-Request-Id` echoes the id.
- A disconnect aborts the wait (`cancel`, `aborted`). A Hold granted after that is released (`release`, `undelivered`).
- A same-holder repeat of a held id answers the Lease. A repeat of an open wait takes it over (the old connection gets 409 `HUB_LEASE_SUPERSEDED`).
- SIGTERM answers every open wait 503 `HUB_API_RESTARTING` (`retry: requeue`) before `HUB_API_STOP`.

`GET /leases/{id}` is added. One level up (`belsky-doctrine`):
- Any service front door (the Host Agent in Epic 9) gets waits by reusing the registry and `startService`'s stop.
- Every Pool timeout, CLI and API, now keeps AD-5's `host lock <name> is held by …` wording.
- Tickets carry `claimant_kind`, which `prune` and release-cancel events read.

**Files changed**
- `tools/ci/lib/lock.mjs` — ticket `claimant_kind`, the kind in prune and release-cancel subjects, `heldText` and `cachedProcessStart` exported, AD-5 Pool timeout text.
- `tools/device/claims.mjs` — three new codes, the `wait_ms` body rules (`bad-wait`, `no-id`), `heldLease`/`findLease`/`leaseRequestId`, `serviceLease` repeat and undelivered release, `createLeaseWaits`, AD-5 `noPhoneError` text.
- `tools/hub-api/routes.mjs` — `takeLease` through `ctx.waits` with the request signal, `GET /leases/{id}`, `X-Request-Id` through a route `requestId`, the `HUB_API_RESTARTING` `retry` extension.
- `tools/hub-api/server.mjs` — a per-request `AbortController` on `res` `close`, aborted answers dropped, `listener.drain()`, and a stop that runs `waits.shutdown()` and the drain before `server.close`.
- `docs/hub-api-contract.md` — route row, `wait_ms`/`id` rules, Waits section, new reasons, error and extension rows.
- `tools/hub-api/waits.test.mjs` (new) — every matrix row through `requestListener`/`handle()` with fake req/res, plus the registry directly.
- `tools/hub-api/{contract,leases}.test.mjs`, `tools/device/{claims,lease,hub-device}.test.mjs`, `tools/ci/pool-request.test.mjs` — updated for the codes, the body rules, the ticket kind and the AD-5 wording.

**Review findings.** 28 findings in total:
- 3 patches applied (1 medium, 2 low), all test-only in `tools/hub-api/waits.test.mjs`: the abort-unwind repeat test, the recorded-`device` GET test, and the vestigial loop and misleading titles.
- 0 items deferred.
- 25 rejected, each with its reason in the Review Triage Log above:
  - 11 false.
  - 14 low that are either spec-mandated (AD-48 repeat terms, exit 2 `waiting`) or unlikely and need a new guard (`wait_ms` cap, expiry check, pid-cache eviction, drain timeout, doc detail).

**Follow-up review recommendation:** false. This pass patched 0 high, 1 medium and 2 low, all of them test-only.

**Verification**
- The spec's targeted command passed 228/228.
- `heavy mise run check` (actionlint and the full suite) passed 1299/1299.
- `git diff main -- tools/ci/lib/eta.mjs` is empty.
- I also checked one thing by hand over a real loopback `http.Server`: a client abort mid-wait leaves no ticket and logs `cancel:aborted`, and a freed wait answers 200 with `X-Request-Id`.

**Residual risks**
- `wait_ms` has no ceiling. An absurd value (~9e15) answers 500 instead of 400.
- A same-holder repeat or a GET can return a Lease that has expired but is not yet reclaimed.
- Superseded and restarting both use exit 1. `hub-client`'s requeue on `retry: requeue` is Story 8.6.
