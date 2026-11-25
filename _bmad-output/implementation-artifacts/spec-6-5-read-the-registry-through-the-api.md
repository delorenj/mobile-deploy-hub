---
title: 'Read the Registry through the API'
type: 'feature'
created: '2026-11-25'
status: 'done'
baseline_revision: '3a283ee8d04b389961f1ee0389ef25c6d5299508'
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-6-context.md'
warnings: ['oversized']
deferred: []
---

<intent-contract>

## Intent

**Problem:** The Hub API (6.4) answers only `/health`; an agent cannot learn which Resources exist, their Capabilities, which phone deploys install to, or the `phone` Pool's order without running a CLI (FR-29, FR-21, AD-30, AD-31).

**Approach:** Add `GET /resources`, `GET /resources/{id}` and `GET /pools`. Following belsky-doctrine, the level above "the API's resource list" is **every Registry reader**: one pure projection (`tools/registry/view.mjs`) turns stored records into the served record shape, computes visibility (AD-31) and redacts by audience (`local` keeps values, `service` nulls QA identity), so 6.8's `hub-device registry list` and Epic 8's `/status.registry` reuse it instead of re-deriving. `handle()` gains `{name}` path parameters once, for every later route story.

## Boundaries & Constraints

**Always:**
- Read through `readRegistry({env, devices: ctx.devices, qaDevices: ctx.qaDevices})` fresh on every call (file when good, in-memory seed at `rev: 0` otherwise; no warning per request — `/health` already reports `unreadable`).
- A served record has exactly `{id, lock, name, kind, host, identity, capabilities, deploy_target, seeded, seed_missing, created_at, retired_at, visibility}`: `seed_missing` is always a boolean (`false` when unset), `created_at`/`retired_at` are a string or `null`, `identity` is the stored object (or `null`), `capabilities` the stored object (or `{}`). `words`, `display_name` and any other stored key are not served.
- Visibility uses `match.mjs` `visibility(record, {held, queued})`: `visible` and `retiring` are served, `hidden` is left out of `/resources` and answers `/resources/{id}` with 404 `HUB_RESOURCE_NOT_FOUND` `reason: retired`. Held/queued is read only for records `retirement()` marks, through a new `claims.lockActivity(lock, {env, now})` → `{held, queued}` (owner present; any non-stale `queueView` entry). The route takes `ctx.lockActivity` when injected.
- Audience `service` (every API response): when `capabilities.dedicated_qa === true`, `identity.serial`, `identity.udid` and `identity.adb_id` are set to `null` where present (keys kept). For every audience, an `allowed_users` key is dropped from `identity` and `capabilities`. The input is never mutated.
- `GET /pools`: every Pool of the Registry in its stored order as `{name, kind, members, gate}`; `kind: 'named'` when it has a `members` array (members = ids from `match(registry, {pool: name}, ctx.policy).members`, `[]` on `HUB_NO_MATCH`), else `kind: 'gate'` with `members: []`; `gate` is the stored string or `null`.
- Route params: a path segment `{name}` matches one non-empty segment, URI-decoded (a bad escape is no match → 404 `HUB_NO_ROUTE`); literal routes win over parameterised ones; params reach the handler as `request.params`. 405/`Allow` work for parameterised paths.
- Unknown id → 404 problem+json `HUB_RESOURCE_NOT_FOUND`, exit 2 (new `EXIT_CODES` entry), `reason: unknown`. Lookup is by `id` only.
- `docs/hub-api-contract.md` lists the three routes (Added 6.5), shapes `ResourceList`, `Resource`, `PoolList` with exact field lists, the new error code, and the notation: `{name}` parameters, `key[].sub` for arrays of objects, `key.*` for an open object.

**Never:**
- No write route, no `hub-client.mjs`, no CLI verb (6.6–6.8). No change to `readRegistry`, the store or the seed. No dependency, no Python, no timer.
- No QA serial, UDID or adb id of a `dedicated_qa` Resource in any response; tests open no real QA file and bind no port.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| No file | `GET /resources` | `{rev: 0, source: 'seed', resources}`: s24, s26 (`deploy_target: true`), ios-lane, emulator; `created_at: null` | — |
| Seeded file | after `applySeed` | `source: 'file'`, file `rev`, `created_at` set | — |
| One record | `GET /resources/s26` | `{rev, source, resource}` with `deploy_target: true`, `lock: 'adb'` | — |
| Unknown id | `GET /resources/nope` | 404 problem+json | `HUB_RESOURCE_NOT_FOUND` exit 2 `unknown` |
| Retired idle | record with `retired_at`, no owner/ticket | absent from list | `/resources/{id}` 404 `reason: retired` |
| Retired held / queued | owner dir, or live ticket | listed, `visibility: 'retiring'` | — |
| seed_missing idle | `seed_missing: true` | hidden like retired | — |
| QA phones | qaDevices marks s24 + one unknown phone | `identity.serial: null` for both, key present; no QA serial anywhere in any response | — |
| Pools | seed | `phone` `{kind: 'named', members: ['s24','s26'], gate: null}`, `emulator` `{kind: 'gate', members: [], gate: 'emulator'}` | — |
| Pool all retired | every phone member retired | `members: []` | — |
| Param edge | `GET /resources/`, `GET /resources/%E0` | 404 | `HUB_NO_ROUTE` |
| Wrong method | `POST /resources/s26` | 405, `Allow: GET` | `HUB_NO_ROUTE` exit 2 |

</intent-contract>

## Code Map

- `tools/hub-api/routes.mjs` -- `ROUTES` L75 (add three rows), `handle()` L93 (exact `route.path === path` match at L96 → pattern match with params, literal first), `routeError` L50 for the 404. Handler signature `(ctx, {method, path, query, body})` gains `params`.
- `tools/hub-api/server.mjs` `startHubApi` L139 -- ctx is `{policy, now}`; add `devices`, `qaDevices` so the routes read the same seed the start wrote.
- `tools/hub-api/contract.test.mjs` -- `flatten` L58 recurses objects only; extend for `key[]` arrays of objects (union of item paths; scalar/empty arrays stay leaves) and open prefixes (`key.*` doc entries stop recursion and emit `key.*` whatever the value). The GET loop L119/L139 calls `route.path` literally: substitute `{id}` from a test-local sample map (fail on an unknown param). The snake_case test must ignore `[]` and `*`.
- `tools/registry/store.mjs` `readRegistry` L89 -- `{rev, resources, pools: {<name>: {...}}, source}`; pools keyed by name in file order.
- `tools/registry/match.mjs` -- `visibility` L239, `retirement` L234, `match` L265 (`{pool}` request; throws `HUB_NO_MATCH`). Pure: view.mjs may import it, never lock.mjs or claims.
- `tools/registry/seed.mjs` `seed()` L54 -- seeded records carry `words`, `display_name`; QA runtime phones are `res-<slug>`, `seeded: false`, `capabilities.dedicated_qa`.
- `tools/device/claims.mjs` -- `EXIT_CODES` L40 (add `HUB_RESOURCE_NOT_FOUND: 2`; `claims.test.mjs` freezes the table), imports `readOwner`, `queueView`, `lockDir` already; `readOwnerOf` L64. `redact` L626 is the status-row redaction (same null-not-remove rule).
- `tools/ci/lib/lock.mjs` -- `readOwner(path)` L94 reads `<path>/owner.json`; `queueView(name, {env, now})` L985 returns non-stale entries by default (a ticket with `pid: 0` and a future `expires_at` is live, `ticketStaleness` rule 3).
- `tools/hub-api/server.test.mjs` `scratch()` L43 -- temp env + `ctx()` harness to copy for the new route tests; `tools/registry/store.mjs` `writeRegistry` to plant retired/seed_missing/runtime records.
- `tools/deploy-path.test.mjs` already forbids the deploy path from importing `tools/registry/*` and `tools/hub-api/*`.

## Tasks & Acceptance

**Execution:**
- `tools/registry/view.mjs` (new) -- export `AUDIENCES`, `RECORD_KEYS`, `viewRecord(record, {audience, held, queued})` → served record or `null` when hidden, and `viewPools(registry, policy)` → `[{name, kind, members, gate}]` -- the one projection every Registry reader shares.
- `tools/registry/view.test.mjs` (new) -- exact keys, defaults, local vs service redaction, `allowed_users` dropped, no mutation, visibility rows, pools rows.
- `tools/device/claims.mjs` + `claims.test.mjs` -- `HUB_RESOURCE_NOT_FOUND: 2`; export `lockActivity(lock, {env, now})`, tested with a real owner dir and a live/stale ticket in a temp lock dir.
- `tools/hub-api/routes.mjs` -- path params in `handle()`; handlers `listResources`, `getResource`, `listPools`; three `ROUTES` rows (literal before parameterised).
- `tools/hub-api/server.mjs` -- pass `devices`, `qaDevices` into ctx.
- `tools/hub-api/resources.test.mjs` (new) -- every matrix row through `handle()`, and a QA walk: with qaDevices naming s24's serial and an unknown phone, every string value at every key path of `/health`, `/resources`, every `/resources/{id}` and `/pools` (seed and file) contains neither serial.
- `tools/hub-api/contract.test.mjs` -- array/open flattening, param samples, snake_case filter; prove the new flatten on synthetic samples.
- `docs/hub-api-contract.md` -- rows, shapes, notation, `HUB_RESOURCE_NOT_FOUND`.

**Acceptance Criteria:**
- Given `docs/hub-api-contract.md` and `ROUTES`, when `contract.test.mjs` runs, then the three routes and their exact field lists match handler output, including array items and open objects.
- Given `mise run check`, when it runs, then actionlint and the full suite pass.

## Spec Change Log

## Review Triage Log

### 2026-11-25 — Review pass
- verdicts: 31 findings — high 0, medium 0, low 19, false 12, maybe-false 0
- findings:
  - `[low]` `[reject]` (blind) redaction is a denylist (serial/udid/adb_id) and needs `dedicated_qa === true` — the key set is AD-30's exact list and the spine's identity keys are `serial, model, udid, profile`; no writer stores another hardware key or a string `"true"` (the seed writes a boolean, and the matcher's one `dedicated` rule is the same `=== true`). An allowlist changes the documented rule.
  - `[low]` `[reject]` (blind) `lockActivity` treats an unreadable lock dir as idle — `readOwner` (pre-existing) already maps every read error to "no owner", as `statusView` does; an EACCES on the runner's own lock dir is not everyday, and logging or failing is a new branch.
  - `[false]` `[reject]` (blind) `queueView` is called without `host`/`hostId` — `listWaiters`/`ticketStaleness` default them to `hostname()`/`machineId()`, the same values the lease code uses in production.
  - `[low]` `[reject]` (blind) `viewPools` turns `HUB_POOL_CROSS_HOST` into `members: []` — unreachable: the only named Pool is the seed's `phone` (seeded members on `linux`, runtime members filtered to `linux`), and no write route edits Pools; a lease of such a Pool cannot be served either, which is what `[]` says. A distinguishing field is new public surface.
  - `[low]` `[patch]` (blind) the contract does not say the literal tier answers 405/`Allow` for its path — the Conventions line now says so. The same-count tie-break part is rejected: no two routes tie.
  - `[false]` `[reject]` (blind) hidden Resources cannot be read — AD-31 and the AC: hidden means gone from every list; 404 `reason: retired` is the designed answer.
  - `[low]` `[reject]` (blind) tests hard-code devices.json serials and order, and the contract test sees only the seed path — the suite's seed tests already do this; the served key set is the same on both paths (always-present keys, asserted against `RECORD_KEYS` in seed and file modes in resources.test.mjs).
  - `[false]` `[reject]` (blind) `serve()` and `viewRecord` can disagree on "marked" — both call the one `retirement()` of match.mjs (`visibility` is built on it), so they cannot diverge.
  - `[low]` `[reject]` (edge) a broken QA file with no registry.json makes the three routes answer 500 `HUB_API_ERROR` — needs a malformed private QA file on a host whose first seed failed (already one `HUB_API_SEED_FAILED` line); a coded 503 is a new contract error code and a seed change the spec excludes. The behaviour is now pinned by a test (verification-gap row below).
  - `[false]` `[reject]` (edge) an injected `lockActivity` seam returning undefined throws — test-only seam; the production function always returns `{held, queued}`.
  - `[low]` `[reject]` (edge) a stale owner (expired Lease) counts as held, so a retired Resource stays `retiring` — needs a retired or seed-missing Resource whose Lease expired unreleased; `hub-device status` shows the same stale Hold, and Epic 7's force-release clears it. The spec's Always rule defines held as "owner present"; changing it edits the spec.
  - `[low]` `[reject]` (edge) unreadable lock or queue dir is idle — grouped with the blind `lockActivity` row.
  - `[low]` `[reject]` (edge) cross-host Pool reported as `[]` — grouped with the blind `viewPools` row.
  - `[low]` `[reject]` (edge) other QA identity keys (imei, android_id) are served — grouped with the blind denylist row.
  - `[low]` `[reject]` (edge) `dedicated_qa: "true"` skips redaction — grouped with the blind denylist row.
  - `[low]` `[reject]` (edge) integer-like Pool names lose stored order through `Object.entries` — Pool names come only from the seed (`phone`, `emulator`); fixing it changes `readRegistry`, which the spec excludes.
  - `[low]` `[reject]` (edge) two parameterised routes with equal counts tie by table order — no such pair exists; a table check is new code for a future authoring error.
  - `[low]` `[reject]` (edge) a repeated `{id}` in one pattern overwrites — no route repeats a name; an authoring guard is new code with no caller.
  - `[low]` `[patch]` (edge, claim) the doc says `udid` and `adb_id` keys "stay" for every dedicated_qa record, but only present keys are nulled — reworded to "where the record has them, are `null` (the key stays)".
  - `[low]` `[reject]` (edge, claim) `members` is `[]` on cross-host too — grouped with the blind `viewPools` row.
  - `[low]` `[reject]` (edge, claim) any owner counts as held — grouped with the edge stale-owner row.
  - `[low]` `[patch]` (verification-gap) nothing proves `startHubApi` passes `devices`/`qaDevices` into the route context — server.test.mjs now starts the service with an unknown QA phone, removes the file, drives the started server's listener for `/resources` and `/resources/s26`, and asserts the injected phone is served with `serial: null` and its serial nowhere; proven to fail with the wiring removed.
  - `[low]` `[patch]` (verification-gap) the routes' answer with no file and an unbuildable QA seed is unpinned — server.test.mjs now asserts 500 problem+json `HUB_API_ERROR`, exit 1, a one-line detail and one journal line per request for `/resources`, `/resources/s26` and `/pools`. No production change.
  - `[low]` `[reject]` (verification-gap other) the routes do not degrade like `/health` — grouped with the edge broken-QA row.
  - `[low]` `[patch]` (verification-gap other) the literal-tier 405 is undocumented — grouped with the blind literal-tier row.
  - `[low]` `[patch]` (intent) the new routes are not exercised through the started service — grouped with the verification-gap ctx-wiring row.
  - `[false]` `[reject]` (intent) `seed_missing`/`retired_at` are always served though the epic marks them optional — the spec's stable-keys decision (Design Notes); changing it edits the spec.
  - `[false]` `[reject]` (intent) identity keys a record never had are not added as null — the AC says keys are never removed; nothing asks for keys to be invented.
  - `[false]` `[reject]` (intent) a hidden id answers 404 `reason: retired` rather than `unknown` — the spec's documented choice; changing it edits the spec.
  - `[false]` `[reject]` (intent) the deployed service is not shown answering — Story 6.11 owns the unit and `hosts:install`; this story's AC is met at the handler and adapter.
  - `[false]` `[reject]` (intent) `view.mjs` has one consumer — by design (belsky-doctrine): 6.8 and Epic 8 are the named next readers; the story's own routes use it.

## Design Notes

- **Stable keys, not `?`.** The spine marks `seed_missing?`/`retired_at?` optional in storage; the API serves them always (`false`/`null`), the same "keys are never removed" rule as QA redaction, so a client and the exact-key contract test see one shape.
- **Hidden is hidden everywhere.** A hidden record answers 404 with `reason: retired` (not `unknown`), so a caller learns the id exists but is gone, without the list ever showing it.
- **Pool members are the matcher's.** `/pools` shows what a `phone` lease would try, in order, so the API and the CLI cannot disagree.

## Verification

**Commands:**
- `node --test tools/hub-api/*.test.mjs tools/registry/*.test.mjs tools/device/claims.test.mjs` -- expected: all pass
- `heavy mise run check` -- expected: actionlint clean, full suite green

## Auto Run Result

Status: done

**Summary.** The Hub API now serves the Registry: `GET /resources` (every Resource a reader shows, in Registry order), `GET /resources/{id}` (by id; unknown → 404 `HUB_RESOURCE_NOT_FOUND` exit 2 `reason: unknown`, hidden → `reason: retired`) and `GET /pools` (each Pool in stored order; a named Pool's members are what the 5.7 matcher would try for a lease, so the API and the CLI cannot disagree). Every served record has the fixed shape `{id, lock, name, kind, host, identity, capabilities, deploy_target, seeded, seed_missing, created_at, retired_at, visibility}`. A retired or seed-missing Resource is `retiring` while its lock is held or waited on, and is hidden otherwise (AD-31). A `dedicated_qa` Resource's serial, UDID and adb id are null with the keys kept, and `allowed_users` is never served. Following belsky-doctrine, the level above "the API's resource list" is **every Registry reader**: `tools/registry/view.mjs` is the one pure projection (visibility, defaults and audience redaction, `local` vs `service`). 6.8's `hub-device registry list` and Epic 8's `/status.registry` read through it. `handle()` gained `{name}` path parameters once, for every later route story.

**Files changed** (after baseline `3a283ee8d04b389961f1ee0389ef25c6d5299508`; commits `6c33a9c`, `88e5316`)
- `tools/registry/view.mjs` (new): `AUDIENCES`, `RECORD_KEYS`, `viewRecord`, `viewPools`.
- `tools/registry/view.test.mjs` (new): exact keys and defaults, local vs service redaction, `allowed_users`, no mutation, visibility, Pools.
- `tools/hub-api/routes.mjs`: path parameters (literal tier first, 405 on parameterised paths), `listResources`, `getResource`, `listPools`, three `ROUTES` rows.
- `tools/hub-api/server.mjs`: `devices` and `qaDevices` reach the route context.
- `tools/hub-api/resources.test.mjs` (new): every I/O-matrix row and the QA serial walk over every response, seed and file.
- `tools/hub-api/server.test.mjs`: the started service serves the injected seed; the unbuildable-seed answer is pinned.
- `tools/hub-api/contract.test.mjs`: `a[].b` arrays, `a.*` open objects, `{id}` samples, snake_case filter.
- `tools/device/claims.mjs`, `claims.test.mjs`: `HUB_RESOURCE_NOT_FOUND: 2`, `lockActivity(lock, {env, now})`.
- `docs/hub-api-contract.md`: three routes, `ResourceList`/`Resource`/`PoolList`, the notation, the new error code.

**Review findings.** 31 findings: high 0, medium 0, low 19, false 12, maybe-false 0.
- **Patched (4 entries, all low):** the contract now states that the literal tier answers 405/`Allow`; the QA identity wording now reads "where the record has them"; a server test proves the ctx wiring through the started service (and fails without it); a server test pins the answer when the seed cannot be built.
- **Deferred:** none.
- **Rejected:** 12 false findings: `queueView` host defaults, hidden-by-design, a single `retirement()` rule, a test-only seam, the spec's stable-keys and 404-retired choices, keys never invented, 6.11 owning the live service, and the view's single consumer. 15 low findings, each with its reason in the triage log: denylist redaction and the string `"true"`, unreadable lock dirs, cross-host Pools as `[]`, a stale owner counted as held (spec rule), broken QA → 500, integer Pool names, route tie and duplicate-param guards, and test coupling to devices.json.

**Follow-up review recommended: false.** This was the first pass. No high or medium entry was patched; the patched counts are high 0, medium 0, low 4.

**Verification**
- `node --test tools/hub-api/*.test.mjs tools/registry/*.test.mjs tools/device/claims.test.mjs`: 173/173 pass.
- `heavy mise run check`: exit 0, actionlint clean, 1063/1063 tests pass.
- Matrix audit: every row is covered in `tools/hub-api/resources.test.mjs`, and every one of those tests ran and passed.

**Residual risks**
- With no `registry.json` and a malformed private QA file, the three routes answer 500 `HUB_API_ERROR`, which is labelled a service bug, rather than a coded configuration error. A coded 503 would need a new contract code and a seed change.
- A retired or seed-missing Resource whose Lease expired without a release stays `retiring` until the stale Hold is cleared, because the spec defines held as "owner present".
- `view.mjs` has one consumer until 6.8 and Epic 8 adopt it. Nothing starts the service in production until 6.11 and 6.12.
- No operator actions are owed: every acceptance criterion is in-repo.
