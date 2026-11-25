---
title: 'The Hub API runs, answers /health and has a contract'
type: 'feature'
created: '2026-11-25'
status: 'done'
baseline_revision: '44e6e8b972cfd93d19b3e98c6f43089026d4f67b'
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-6-context.md'
warnings: ['oversized']
deferred: []
---

<intent-contract>

## Intent

**Problem:** v1b has a Registry store and a seed, but no service: nothing binds `127.0.0.1:8794`, nothing calls `recoverRegistry`/`applySeed` at start, `policy.json` has no `api` block, and there is no contract document for Holocene to code against (FR-21, AD-42, AD-45, AD-46).

**Approach:** Add `tools/hub-api/server.mjs` (start sequence, port-bind singleton, node `http` adapter) and `tools/hub-api/routes.mjs` (pure `handle()` over an exported route table, problem+json, `GET /health`), the strict `api` policy block, `docs/hub-api-contract.md`, and two conformance tests (contract ↔ code, no new clock). Following belsky-doctrine, the level above "the Hub API" is every hub service: the start checks, singleton bind, response envelope and contract test are written once, parameterised by service name, port and route table, so the Host Agent (Epic 7) reuses them and every route story (6.5, 6.6, 6.7, 6.10) only adds a row and a field list.

## Boundaries & Constraints

**Always:**
- Bind `127.0.0.1` only, port `policy.api.hub_api_port`. `EADDRINUSE` → `HUB_API_ALREADY_RUNNING` (exit 1). No lock-dir singleton.
- Start order: assert Node >= 24.15 (`HUB_API_NODE`, exit 1), assert `heavy` on `PATH` (`HUB_API_NO_HEAVY`, exit 1), bind, `recoverRegistry`, `applySeed`, then log `HUB_API_LISTEN port=<n>` on stdout. On SIGTERM/SIGINT: close, log `HUB_API_STOP`, exit 0.
- A seed failure never stops the service: `HUB_REGISTRY_FORMAT` or any other seed error logs one `HUB_API_SEED_FAILED <code> <message>` line on stderr and the service keeps serving (holds never depend on the Registry; the next start retries).
- `GET /health` → exactly `{ok: true, service: 'mobile-deploy-hub-api', contract: 1, hub_version, ports: {hub_api, host_agent}, registry: 'ok'|'unreadable'}`. `hub_version` is `hubRef(env) ?? 'unknown'` (AD-10). `registry` is read fresh per call: `unreadable` only when the file exists and cannot be read (missing = `ok`).
- Every response: `Cache-Control: no-store`, `snake_case` keys. Success is `application/json; charset=utf-8`. Errors are `application/problem+json` with exactly `{type, title, status, detail, code, exit, reason}`; `exit` comes from the error or `claims.exitCodeOf`. Unknown path → 404 `HUB_NO_ROUTE` exit 2 reason `no-route`; known path, wrong method → 405 `HUB_NO_ROUTE` exit 2 reason `method` with an `Allow` header; a thrown handler error without `status` → 500 `HUB_API_ERROR` exit 1. Paths match exactly (no prefix, no trailing-slash folding); the query string is ignored for routing.
- `policy.json` gains `api: {hub_api_port: 8794, host_agent_port: 8795, stream_keepalive_s: 15, peer_connect_timeout_s: 5}`, required and strict: unknown keys refused, ports whole numbers 1..65535 and different from each other, `stream_keepalive_s` 1..30, `peer_connect_timeout_s` positive.
- Every seam is injected (`env`, `policy`, `log`, `versions`, `onPath`, `createServer`, `now`, `hostId`, `devices`, `qaDevices`, `signals`); tests bind no real port, open no real QA file and reach no network.

**Never:**
- No route beyond `/health` (6.5+), no unit file or `hosts.mjs` change (6.11), no `hub-client.mjs` (6.8), no host-key requirement.
- No `setInterval`/`setTimeout` in `tools/hub-api/` (stream.mjs, later, is the named exception). No dependency, no Python, no framework.
- The deploy path never imports `tools/hub-api/*` (already enforced by `tools/deploy-path.test.mjs` FORBIDDEN).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Clean start | Node 24.15.0, heavy on PATH, no registry.json | binds 127.0.0.1:8794; file created at rev 1; stdout `HUB_API_LISTEN port=8794` | — |
| Second instance | fake server emits `EADDRINUSE` | no seed write, no LISTEN line | `HUB_API_ALREADY_RUNNING`, exit 1 |
| Old Node | `versions.node = '24.6.0'` | nothing bound | `HUB_API_NODE`, exit 1 |
| No heavy | PATH without `heavy` | nothing bound | `HUB_API_NO_HEAVY`, exit 1 |
| Log behind file | registry.json rev 3, log max rev 1 | one `registry-edit` `reason: recovered` before the seed | — |
| Unreadable file | garbage registry.json | service up, file bytes unchanged, `/health.registry = unreadable` | stderr `HUB_API_SEED_FAILED HUB_REGISTRY_FORMAT …` |
| Health | `GET /health` | 200, exact keys, `no-store` | — |
| Health with ref | `HUB_REF=v1.2.60` | `hub_version: 'v1.2.60'`; no ref → `'unknown'` | — |
| Unknown route | `GET /nope`, `GET /health/` | 404 problem+json | `HUB_NO_ROUTE` exit 2 |
| Wrong method | `POST /health` | 405, `Allow: GET` | `HUB_NO_ROUTE` exit 2 |
| Handler throws | route handler throws plain Error | 500 problem+json, stderr one line | `HUB_API_ERROR` exit 1 |
| Stop | SIGTERM after start | server closed, stdout `HUB_API_STOP` | — |

</intent-contract>

## Code Map

- `tools/ci/lib/policy.mjs` -- `parsePolicy` L159, top-level `exact('policy', …)` L162 (add `'api'` to required keys), `queueBlock` L292/`registryBlock` L308 are the pattern for a new `apiBlock`; `loadPolicy` L331.
- `tools/ci/policy.json` -- add the `api` block after `registry`.
- `tools/ci/policy.test.mjs` L233-256 -- the registry-block test is the template for the api-block test.
- `tools/ci/lib/receipt.mjs` `hubRef(env, file)` L26 -- the one hub-version resolver (AD-10).
- `tools/registry/store.mjs` -- private `loadFile` L52 (`missing|unreadable|ok`, never throws); `applySeed` L239 (throws `HUB_REGISTRY_FORMAT` on unreadable); `recoverRegistry` L265. Add exported `registryState(env)` → `'missing'|'unreadable'|'ok'` for `/health`.
- `tools/device/claims.mjs` `EXIT_CODES` L40, `exitCodeOf` L59 -- the one exit table; add `HUB_API_ALREADY_RUNNING: 1`, `HUB_API_NODE: 1`, `HUB_API_NO_HEAVY: 1`, `HUB_NO_ROUTE: 2`, `HUB_API_ERROR: 1`. `claims.test.mjs` L64 freezes the table: update it.
- `tools/deploy-path.test.mjs` -- `FORBIDDEN` already lists `tools/hub-api/`; nothing to change.
- `tools/ci/lib/lock.mjs` L359/L440 -- today's only `setInterval`; `tools/hub-api/stream.mjs` and `tools/hub-client.mjs` are AD-19's other named files (not yet present).
- `tools/registry/store.test.mjs` `scratch()` L23 -- temp lock/event dir harness to copy. `tools/ci/test-fixtures.mjs` `hermetic()` L39.
- Local Node is 24.6.0 (mise also has 24.15.0); tests must inject `versions`, never rely on the running Node.

## Tasks & Acceptance

**Execution:**
- `tools/ci/lib/policy.mjs` + `tools/ci/policy.json` -- `apiBlock` per the Always rules; comment in the same style as `registryBlock`.
- `tools/registry/store.mjs` -- export `registryState(env)`.
- `tools/device/claims.mjs` + `tools/device/claims.test.mjs` -- the five new exit codes.
- `tools/hub-api/routes.mjs` (new) -- export `CONTRACT_VERSION = 1`, `SERVICE`, `ROUTES` (`[{method, path, shape, handler}]`), `problem(error)` and async `handle({method, url, body}, ctx)` → `{status, headers, body}`; `health(ctx)`.
- `tools/hub-api/server.mjs` (new) -- export `startService({service, port, routes, …seams})` (generic: checks, bind, `HUB_API_LISTEN`, stop), `startHubApi(opts)` (policy port, recover, seed, then `startService`), `requestListener(ctx)` (node req/res adapter; reads a JSON body up to 1 MiB for POST, bad JSON → 400 `HUB_USAGE`), `onPath(name, env)`, `nodeAtLeast(version, '24.15')`, and a guarded `main` that maps an error to `<CODE> <message>` on stderr and its `exit`.
- `docs/hub-api-contract.md` (new) -- `Status:` line with contract 1 and date, base URL `http://127.0.0.1:8794` with no path prefix, conventions (no-store, snake_case, problem+json, additive only), a route table `| Method | Path | Shape | Added |`, one `### <Shape>` section per shape with a `- \`dotted.key\`` field list (`Health`, `Problem`), the error-code list, and the non-binding v1c note proposing module id `mobile-deploy-hub` and `MOBILE_DEPLOY_HUB_API_URL` (default `http://127.0.0.1:8794`, open question Q3).
- `tools/hub-api/contract.test.mjs` (new) -- parses the doc; route set equals `ROUTES` both ways (and fails on a synthetic extra route either side); each route's flattened dotted key set equals its doc field list exactly; a 404 matches `Problem`; every key is snake_case; `Status:` version equals `CONTRACT_VERSION`.
- `tools/hub-api/server.test.mjs` (new) -- every matrix row with a fake `createServer` (EventEmitter with `listen`/`close`), fake `onPath`, injected `versions`, temp lock/event dirs and a `signals` emitter; the request adapter driven with fake req/res.
- `tools/clock.test.mjs` (new) -- exported `CLOCK_FILES = ['tools/ci/lib/lock.mjs', 'tools/hub-api/stream.mjs', 'tools/hub-client.mjs']`: no `setInterval` in any non-test `tools/**/*.mjs` outside it; no `setTimeout` in `tools/hub-api/`, `tools/host-agent/` or `tools/hub-client.mjs` outside it; and no self-rescheduling `setTimeout` (a named function whose own body passes itself to `setTimeout`) anywhere under `tools/`; the detector is proven on synthetic positive and negative samples.
- `README.md` -- one short paragraph naming the Hub API, its port and the contract doc.

**Acceptance Criteria:**
- Given `startHubApi` with seams for Node 24.15, `heavy` and a free fake port, when it starts, then the fake server was asked to listen on `127.0.0.1:8794` only, `registry.json` exists, and stdout has `HUB_API_LISTEN port=8794`.
- Given `docs/hub-api-contract.md` and `ROUTES`, when a route or field exists in only one of them, then `contract.test.mjs` fails.
- Given `policy.json` with `api.stream_keepalive_s: 31` or an unknown `api` key, when parsed, then `parsePolicy` throws naming `api`.
- Given `mise run check`, when it runs, then actionlint and the full suite pass.

## Spec Change Log

## Review Triage Log

### 2026-11-25 — Review pass
- verdicts: 41 findings — high 0, medium 2, low 30, false 9, maybe-false 0
- findings:
  - `[low]` `[patch]` (blind) the contract test skips routes whose path contains `:` — the filters are deleted, so every GET route is checked and a future parameterised route fails visibly.
  - `[low]` `[reject]` (blind) `/health` says `registry: ok` after a seed failure left no file — the shape is fixed by AD-42 and the AC (exact keys; missing = in-memory seed = ok); the `HUB_API_SEED_FAILED` journal line is the signal (Design Notes). Fixing it means editing the spec's contract.
  - `[low]` `[reject]` (blind) requests are served while recovery and the seed run — the only route is `/health`; future writes go through `writeRegistry`, which is serialised per path in-process and `if_rev`-checked, so a race fails loudly with `HUB_REGISTRY_CONFLICT`. A ready gate adds a branch for a sub-second window.
  - `[low]` `[reject]` (blind) a coded library error without `status` becomes a 500 `HUB_API_ERROR` — no route in this story calls the Claims library; the first one (6.5, "problem+json 404 with code and the matching exit") must map its errors when it adds the route, and a status table now would be public surface with no caller.
  - `[low]` `[patch]` (blind) the contract's `Problem.reason` list is closed but library errors carry their own reason and the fallback is the lower-cased code — the doc line now says so.
  - `[low]` `[patch]` (blind) `detail` passes a multi-line message raw though the contract says one line — `problem()` collapses whitespace (shared `oneLine`); the 500 test asserts `it broke badly`.
  - `[low]` `[reject]` (blind) `readJson` ignores `Content-Type`, so a browser simple POST could reach a future write route — no write route exists; a content-type guard is new branching for a homelab-loopback threat the operator has ruled out.
  - `[false]` `[reject]` (blind) bodies are read only for POST — AD-42/HTTP conventions: every write is `POST` on a noun; there is no PUT/PATCH/DELETE route by design.
  - `[low]` `[patch]` (blind) the `HEAD` branch in `requestListener` is dead (HEAD gets 405) — removed; it always `res.end(text)`.
  - `[low]` `[patch]` (blind) a 413 aborts the body mid-stream, so a real client can see ECONNRESET — `readJson` keeps reading and discarding past 1 MiB and throws after the loop; multi-chunk oversized and exactly-1-MiB tests added.
  - `[low]` `[reject]` (blind) no `Content-Length` pre-check — the drain fix already caps memory at 1 MiB; a pre-check is an extra branch with no demonstrated harm.
  - `[low]` `[patch]` (blind) `closeAllConnections()` right after `close()` resets in-flight responses — deleted; `server.close()` closes idle connections on Node >= 19.
  - `[false]` `[reject]` (blind) `stream_keepalive_s`, `peer_connect_timeout_s` and `ports.host_agent` have no consumer — the story's AC requires exactly that `api` block and that `/health` `ports`; the doc names `ports.host_agent` as the Host Agent's port.
  - `[false]` `[reject]` (blind) `CLOCK_FILES` lists files that do not exist yet — AD-19 names exactly those three files; the story AC says "outside the files AD-19 names".
  - `[low]` `[reject]` (blind) `strip()` mishandles regex literals and nested templates, and class methods escape the self-reschedule check — a heuristic conformance check; every current file scans correctly (the suite is green and the lock heartbeat is found), and a real tokenizer is a dependency or a large parser for a rare false negative.
  - `[low]` `[reject]` (blind) the contract test checks key names, not types, values, the Status or Added columns — the AC asks for "exact key sets"; statuses and values are asserted in `server.test.mjs`. Value checks add parser branches.
  - `[medium]` `[patch]` (blind) the real HTTP stack and process entry are never exercised — grouped with verification-gap #1 and intent #1. Binding a real port is excluded by the AC ("binds no real port"); the entry guard is now spawned directly and through a symlink with an empty `PATH`, asserting exit 1, one `HUB_API_(NODE|NO_HEAVY)` line, no LISTEN and no registry.json (it refuses before any bind). Arg swap, a non-loopback host and a dropped `error` listener are already caught by `FakeServer` (recorded `[port, host]`; an unhandled `error` emit throws).
  - `[false]` `[reject]` (blind) no operational wiring (unit, `hosts:install`, `HUB_REF`) — Story 6.11 owns the unit, the release path (which `hubRef` reads) and `hosts:install`; this story's AC has none of it.
  - `[low]` `[patch]` (edge) a handler returning `undefined` makes `Buffer.byteLength(undefined)` throw in the async listener — `handle()` now treats a non-object result as a handler bug: one `HUB_API_ERROR` log line and a 500; tested with undefined, null, string and number.
  - `[low]` `[patch]` (edge) a handler returning null/scalar sends a contract-violating 200 — same fix as the row above.
  - `[low]` `[patch]` (edge) the 413 path destroys the request socket — grouped with the blind drain finding.
  - `[false]` `[reject]` (edge) PUT/PATCH/DELETE bodies are dropped — grouped with the blind POST-only finding.
  - `[low]` `[reject]` (edge) a scalar JSON body or a non-JSON content type reaches handlers — each future route validates its own body; no route takes a body yet.
  - `[low]` `[reject]` (edge) requests are served before the seed — grouped with the blind ready-gate finding.
  - `[low]` `[reject]` (edge) SIGTERM during the seed prints LISTEN after STOP — cosmetic log order in a sub-second window; the process still ends 0 and the seed write is atomic. A guard branch is not worth it.
  - `[low]` `[patch]` (edge) `closeAllConnections` kills in-flight responses — grouped with the blind finding; deleted.
  - `[low]` `[patch]` (edge) a thrown `status: 302` becomes an unlogged 500 — `handle()` and `problem()` share one `hasStatus` (400..599) predicate; tested.
  - `[low]` `[patch]` (edge) multi-line `detail` reaches clients — grouped with the blind detail finding.
  - `[low]` `[reject]` (edge) a non-EADDRINUSE listen failure keeps its errno code — `main` still prints `<code> <message>` and exits 1 (`exitCodeOf` → 1); wrapping it is a new branch with no different outcome.
  - `[low]` `[reject]` (edge) `strip()` misses a setInterval after a regex literal containing a quote — grouped with the blind `strip()` finding.
  - `[low]` `[reject]` (edge) an arrow with a parenthesised default parameter escapes `namedFunctions` — grouped with the blind `strip()` finding.
  - `[low]` `[reject]` (edge) methods and object members escape "anywhere under tools/" — grouped with the blind `strip()` finding.
  - `[false]` `[reject]` (edge) `CLOCK_FILES` exemptions for missing files — grouped with the blind finding; AD-19 names them.
  - `[medium]` `[patch]` (verification-gap) the real socket, bind and process entry are unverified — grouped with the blind real-stack row; the spawn test pins the entry guard, the real-port part is excluded by the AC.
  - `[low]` `[patch]` (verification-gap) `startService`'s failed-`afterBind` cleanup is unpinned — a test now throws from `afterBind` and asserts the same error, `closed === 1` and no signal listeners left.
  - `[low]` `[patch]` (verification-gap other) the HEAD branch is dead — grouped with the blind HEAD finding.
  - `[low]` `[patch]` (verification-gap other) only a single-chunk oversized body is tested — grouped with the drain fix; a five-chunk test added.
  - `[low]` `[reject]` (verification-gap other) the error table's Status column is parsed but never compared — grouped with the blind value-checks finding.
  - `[false]` `[reject]` (intent) "runs" is evidenced through seams, not a running process — grouped with the blind real-stack row (patched where the AC allows); the AC itself specifies seams and no real port.
  - `[false]` `[reject]` (intent) the contract test does not assert the doc's prose (no-store, 1 MiB, exact paths, `Allow`) — each is asserted in `server.test.mjs` through `handle()` and the adapter.
  - `[false]` `[reject]` (intent) the real `hubRef` file fallback is untested — `hubRef` is the pre-existing AD-10 resolver, unchanged here; this story only calls it.

## Design Notes

- **Bind before writing.** The port bind is the singleton (AD-45), so `recoverRegistry` and `applySeed` run only after the bind succeeds: a second instance never writes. Recovery runs before the seed because a seed write logs a new rev and would hide a gap.
- **Seed failure is not fatal.** Under `Restart=on-failure` a fatal seed error would crash-loop the service while holds still work; the line on stderr (journald) and `/health.registry` say what is wrong.
- **Contract format.** Field lists are dotted key paths of objects (arrays are not expanded), e.g. `ports.hub_api`. Later stories add a table row plus a `### Shape` section and the test covers them with no test change.

## Verification

**Commands:**
- `node --test tools/hub-api/*.test.mjs tools/clock.test.mjs tools/ci/policy.test.mjs tools/device/claims.test.mjs tools/registry/store.test.mjs` -- expected: all pass
- `mise run check` -- expected: actionlint clean, full suite green

## Auto Run Result

Status: done

**Summary.** The Hub API exists and answers `GET /health` (FR-21, AD-42, AD-45, AD-46). `node tools/hub-api/server.mjs` asserts Node >= 24.15 and `heavy` on `PATH`, binds `127.0.0.1:8794` only (the bind is the singleton: `EADDRINUSE` → `HUB_API_ALREADY_RUNNING`, exit 1), then runs `recoverRegistry` and `applySeed` (Story 6.2/6.3's start work) and logs `HUB_API_LISTEN port=<n>`; SIGTERM/SIGINT log `HUB_API_STOP`. A seed failure is one `HUB_API_SEED_FAILED` line and the service keeps serving. Every response is `no-store` JSON; errors are problem+json `{type, title, status, detail, code, exit, reason}`. `docs/hub-api-contract.md` is the contract, held equal to the code by `contract.test.mjs`. Following belsky-doctrine, the level above "the Hub API" is every hub service and every route story: `startService` (checks, bind, stop) and `handle()` (envelope, 404/405/500) take a name, port and route table, so the Host Agent reuses them and 6.5/6.6/6.7/6.10 each add a `ROUTES` row plus a doc row and `### Shape` section, with no test change.

**Files changed** (after baseline `44e6e8b972cfd93d19b3e98c6f43089026d4f67b`)
- `tools/hub-api/server.mjs` (new): `startService`, `startHubApi`, `requestListener`, `onPath`, `nodeAtLeast`, `main` and the guarded entry.
- `tools/hub-api/routes.mjs` (new): `CONTRACT_VERSION`, `SERVICE`, `ROUTES`, `handle`, `problem`, `reply`, `health`.
- `tools/hub-api/server.test.mjs` (new): every matrix row with a fake server, the adapter, the spawned entry, the failed-`afterBind` cleanup.
- `tools/hub-api/contract.test.mjs` (new): doc ↔ `ROUTES` both ways, exact field sets, `Problem`, snake_case, error-code exits, Status version.
- `tools/clock.test.mjs` (new): AD-19 conformance (`CLOCK_FILES`), with proven detectors.
- `docs/hub-api-contract.md` (new): Status line (contract 1), base URL, conventions, route table, shapes, error codes, the non-binding Q3 note.
- `tools/ci/lib/policy.mjs`, `tools/ci/policy.json`, `tools/ci/policy.test.mjs`: the strict `api` block.
- `tools/registry/store.mjs`, `tools/registry/store.test.mjs`: `registryState(env)`.
- `tools/device/claims.mjs`, `tools/device/claims.test.mjs`: five exit codes (`HUB_API_ALREADY_RUNNING`, `HUB_API_NODE`, `HUB_API_NO_HEAVY`, `HUB_API_ERROR` exit 1; `HUB_NO_ROUTE` exit 2).
- `README.md`: one paragraph naming the API, its port and the contract.

**Review findings.** 41 findings: high 0, medium 2, low 30, false 9, maybe-false 0.
- **Patched (10 entries):** the `:` carve-out deleted from the contract test; one-line `detail`; the `reason` doc line; the dead HEAD branch removed; the 413 drains the body (multi-chunk test); `closeAllConnections` removed; a non-object handler result is a logged 500; one `hasStatus` predicate for logging and `problem()`; the process entry spawned directly and through a symlink (medium); the failed-`afterBind` cleanup test.
- **Deferred:** none.
- **Rejected:** 9 false findings (POST-only writes by design, AC-mandated `api` keys and `CLOCK_FILES`, 6.11 owns the unit wiring, prose and `hubRef` covered elsewhere) and 15 low ones, each with its reason in the triage log: the `/health` seed-failure flag (spec contract), a ready gate, a library status table (no caller yet), a content-type guard, a Content-Length pre-check, the `strip()` tokenizer limits, value checks in the contract test, scalar bodies, the STOP/LISTEN order during a seed, and the errno code of a non-EADDRINUSE listen failure.

**Follow-up review recommended: false.** First pass; one medium entry patched (the entry-guard test), no high. Patched counts by verdict: high 0, medium 1, low 9.

**Verification**
- `node --test tools/hub-api/*.test.mjs tools/clock.test.mjs tools/ci/policy.test.mjs tools/device/claims.test.mjs tools/registry/store.test.mjs`: 88/88 pass.
- `heavy mise run check` (Node v24.15.0): exit 0, actionlint clean, 1043/1043 tests pass.
- The implementer also ran the real service once on Node 24.15.0 against a temp lock dir and port 18794: `/health` 200 with `no-store`, `/health/` 404, `POST /health` 405, a second instance `HUB_API_ALREADY_RUNNING` exit 1, SIGTERM → `HUB_API_STOP` exit 0.

**Residual risks**
- The machine's default Node is 24.6.0, so `node tools/hub-api/server.mjs` refuses with `HUB_API_NODE` unless run on 24.15+ (mise has 24.15.0). Story 6.11's `install.sh` must render `@NODE@` to a 24.15+ `node/24.x` dir.
- No unit, `hosts:install` step or `hub-client` yet (6.8, 6.11): nothing starts the service in production, so `registry.json` is still not created on big-chungus until 6.11/6.12 ship.
- Coded Claims errors carry no HTTP `status` (only `HUB_RESOURCE_RETIRED` and the store's codes do); the first route that calls the library (6.5) must give its errors a status or they answer 500.
- The server accepts requests while recovery and the seed run (sub-second; only `/health` today).
