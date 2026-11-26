---
title: 'Story 8.1: One status document from the API'
type: 'feature'
created: '2026-11-25'
status: 'done'
baseline_revision: '6f570611b4f8ff20806c78f96d07056e5d1d9de8'
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-8-context.md'
  - '{project-root}/docs/hub-api-contract.md'
warnings: ['oversized']
deferred: []
---

<intent-contract>

## Intent

**Problem:** There is no `GET /status`: Holocene and agents cannot read every Resource's Reachability, Hold and Queue in one document, so each would recompute queues itself. A Hold has no `expected_end`, and `hub-device status` on big-chungus knows nothing about hosts other than its own.

**Approach (`belsky-doctrine`, one level up from "a `/status` route": every reader of the status document).** One exported builder, `statusDocument(ctx)`, makes `{format, contract, hosts, registry, stale, checked_at}` from `claims.statusView(hostKey, {audience: 'service', qa_ids})` embedded unchanged. The route serves it today. Story 8.4's `ready`, `status` and `reset` frames carry the same call, so does 8.5's re-read, and Epic 9 adds a host key to `hosts`. `hub-device status` merges remote hosts generically over the host-key map (`HOST_PLATFORMS`), so the Mac shows up with no CLI change. `eta.mjs` gains one pure `expectedEnd`, and the contract test learns a `{name}` map-key notation, so any keyed map can be pinned exactly.

## Boundaries & Constraints

**Always:**
- Node 24 ESM `.mjs`, `node:` builtins only, hermetic tests (injected `adbWire`, `inventory`, `hostKey`, `now`, `fetchImpl`, `qaDevices`; `hermetic()` in every new test file).
- `/status` is `{format: 1, contract: CONTRACT_VERSION, hosts: {<key>: <view>}, registry: {rev, source, resources}, stale: {}, checked_at: <ISO of now>}`.
  - `hosts` has exactly this host's key (`ctx.hostKey ?? claims.hostKey`). If the key is unknown, the answer is 503 `HUB_HOST_UNKNOWN` (`host-unknown`), as `/discovery` does.
  - The view is `await claims.statusView(key, {audience: 'service', qa_ids}, statusCtx)`, embedded byte-for-byte. `statusCtx` comes from `claims.createContext({env, now, sleep, adbWire, devicectl, inventory, policy, hostKey})`, with `fleet = claims.loadFleet(env, {warn: () => {}})` read per request.
  - `qa_ids = dedicatedQaIds(readIt(ctx))`, which is `registry.json`, else the in-memory seed with the QA marks.
  - `registry.resources` is every record `serve(ctx, record)` returns non-null: the same served Resource as `ResourceList` (names, Capabilities, `seeded`, `seed_missing`, `retired_at`, `visibility`), with no `reachability`. Registry fields appear only there.
  - `stale` is an object keyed by host key, `{since}` per stale view. It is always `{}` today, because the one host the Hub API renders is never stale (Story 9.6 fills it).
- Nothing is cached. Every request derives `stale`, expiry and grace from `now`, so a Lease past `expires_at` reads `stale: true` with no file changed.
- A Hold (`locks[]` row) gains `expected_end`, appended after `reachability`. Its value is `eta.mjs` `expectedEnd(owner, events, policy, now)` as ISO, or null when the hold is stale, the ETA's upper bound is unknown, or the policy or history fails. It is never later than the Lease's `expires_at`. The history is the same one windowed `etaHistory` read the waiters use, loaded when a live Hold or waiter exists.
- `hub-device status` (CLI):
  - Only when the host key is `linux` does it call `GET /status` through `hub-client.call` (the `/health` probe, read-only GET, `fetchImpl` and `timeout` seams, policy `context.policy ?? loadPolicy().policy`).
  - `--json` gains a top-level `remote_hosts`. For each `HOST_PLATFORMS` key other than its own, the value is `{state: 'available', reason: null, view, stale}` taken from `/status.hosts[key]` and `/status.stale[key] ?? null`, else `{state: 'unavailable', reason, view: null, stale: null}`.
  - `reason` is `api-down` (any `call` failure), `not-served` (the API answered without that host) or `bad-answer` (the body is not a status document).
  - `remote_hosts` is `{}` when the key is not `linux`.
  - Text output appends a `REMOTE HOSTS` block (linux only). An unavailable host prints `  <key>  unavailable (<why>)`. An available one prints `  <key>  <n> held, <m> waiting (from the Hub API)`, with `  [stale since <since>]` when the host is stale.
  - It stays read-only. No call is made, and nothing is printed, when the key is null or `mac`.

**Never:** recompute a queue position, ETA, Pool fold or redaction in `tools/hub-api/` (`queueView`, `waiterEtas`, `eta.mjs` and `redact` own them); add a cache, timer, watcher or stream (Stories 8.2–8.5); serve Registry fields inside a host view; remove or rename any existing key (the v1a `status --json` keys, the view rows); call the API from `hub-device status` on a host that is not `linux`; touch `lock.mjs`'s writers, the deploy path, `policy.json`, `AGENTS.md`/`CLAUDE.md` or `sprint-status.yaml`; bump `CONTRACT_VERSION`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Happy | Lease on `adb`, Lease waiter, Pool waiter, Reservation, emulator record | 200 with exact top keys. `hosts.linux` deep-equals `statusView('linux', service)` from the same ctx. The Pool request is listed once with `request`, `pool`, `positions` | — |
| QA redaction | `qaDevices` names S24 and a runtime `res-qa…` phone; S24 leased with owner `device.serial/adb_id` | No key path or string value anywhere in `/status` contains either serial. Keys stay, with values null. The `registry` identities are redacted | — |
| Time-only change | Lease `for` 60 s; clock moves past expiry, no file touched | The second `/status` shows that lock `stale: true` and `expected_end` null | — |
| expected_end | live Lease, history with `eta_low_data_min_holds: 1` and one agent release event (share 0.5) | `expected_end` is before `expires_at`. With no history it equals `expires_at`, never later | ETA throws: null |
| Host unknown | `hostKey` throws HUB_HOST_UNKNOWN | 503 `HUB_HOST_UNKNOWN` `host-unknown` | problem+json |
| CLI, API down | key `linux`, fetch fails | `remote_hosts.mac` is `unavailable`/`api-down`. Text has `REMOTE HOSTS`, `  mac  unavailable (the Hub API is not answering)`. Exit 0, lock dir unchanged | — |
| CLI, API up | fake fetch: `/health` ok, `/status` with `hosts: {linux, mac}`, `stale: {mac: {since}}` | `remote_hosts.mac` is `available` with that view and stale, and `linux` (own) is not listed. Without `mac` in hosts: `unavailable`/`not-served` | malformed body: `bad-answer` |
| CLI, other key | key null or `mac` | No fetch call. `remote_hosts: {}`, no `REMOTE HOSTS` block | — |

</intent-contract>

## Code Map

- `tools/hub-api/routes.mjs`:
  - Add `export async function statusDocument(ctx)` and the `GET /status` route (shape `Status`) after `/discovery` in `ROUTES` (L335-352).
  - Reuse `readIt` (L102), `serve` (L106), `HOST_UNKNOWN`/`oneLine` (L146), `CONTRACT_VERSION` (L27) and the `realHostKey` import.
  - Import `statusView`, `createContext`, `loadFleet` from `../device/claims.mjs` and `dedicatedQaIds` from `../registry/seed.mjs`.
  - It must not import `eta.mjs` or `queueView`.
- `tools/device/claims.mjs` `statusView` (L1562-1698): `locks` rows are built at L1567. `loadEtaInputs` (L1591) loads history only for live waiters, so widen it to "a live Hold or waiter". Append `expected_end` after the readings loop (L1690). `redact` (L1542) is unchanged. `HOST_PLATFORMS` (L162) is the host-key map.
- `tools/ci/lib/eta.mjs`: add pure `export function expectedEnd(owner, events, policy, now)`. It returns ms or null: `eta({owner, view: [], file: null}, …)`, with `hi_ms === null` giving null, then `now + hi_ms`, clipped to `Date.parse(owner.expires_at)` for a lease. Owner `kind === 'lease'` is a Lease (`lock.mjs` `isLease` L101); `listLocks` (L2140) gives each row's `owner`.
- `tools/device/hub-device.mjs` `status` (L442-532): the JSON at L451 becomes `{...result, remote_hosts}`, and the text gets the `REMOTE HOSTS` block after EMULATORS. Use `call` from `../hub-client.mjs` (`DOWN_MESSAGE`; `HUB_API_DOWN`/`HUB_API_ERROR`). The seams `context.fetchImpl` and `context.timeout` come from `createContext` (claims L185).
- `tools/hub-client.mjs`: `call` is reused unchanged.
- `docs/hub-api-contract.md`:
  - Add a route row `| GET | \`/status\` | Status | 8.1 |` after `/discovery`.
  - Add a `### Status` section with the full field list, using `hosts.{host}.…`. Open entries (`.*`): `phone`, `emulator`, `eta`, `positions`, `grace`, every non-phone `reachability`, `inventory.adb_servers`/`emulators`/`xvfb`, `emulators[].avd` (a string, so list it plainly), `emulators[].pids`, `registry.resources[].identity`/`capabilities`, `stale`.
  - Conventions L17: add `a.{name}`, an object keyed by values such as host keys, every value having the listed fields.
  - Error row `HUB_HOST_UNKNOWN`: add `GET /status`.
- `tools/hub-api/contract.test.mjs`:
  - `flatten` (L76) gets a 4th param `maps` (prefix → name) from a new exported `mapPrefixes(fields)`; under a map path each child is flattened at `${path}.{name}`. `shapeFields` (L93) passes it.
  - `keysOf` (L374) drops `{…}` segments.
  - `callGet` (L203) honours `prepare`. `GET_SAMPLES['/status']` prepares state on `adb`/`s26` only: a Lease, a lease ticket, a Pool ticket (`buildTicket` with `request`/`pool`), a Reservation on `adb`, and an emulator record. s24 stays free for the `/leases/{id}` sample.
  - Add a flatten map unit case.
- `tools/device/status-view.test.mjs`:
  - L95 and L102: `locks` rows expect `expected_end` last.
  - L510: compare text with the `REMOTE HOSTS` block stripped, and assert the linux run has it.
  - `side()` (L48) builds the ctx the API would.
- New `tools/hub-api/status.test.mjs`: every matrix row except the CLI rows, plus a source check that `routes.mjs` imports neither `eta.mjs` nor `queueView`. New CLI cases go in `status-view.test.mjs` (fake `fetchImpl`).
- `README.md` L253 and L260: `status` remote hosts and `expected_end`. Add a `GET /status` sentence to the Hub API paragraph (L338 area).

## Tasks & Acceptance

**Execution:**
- [x] `tools/ci/lib/eta.mjs` -- `expectedEnd` -- the Hold's end, from the one ETA
- [x] `tools/device/claims.mjs` -- `expected_end` on `locks` rows, with history loaded for live Holds -- AD-41 additive field
- [x] `tools/hub-api/routes.mjs` -- `statusDocument` and the `GET /status` route -- the one document every reader gets
- [x] `tools/device/hub-device.mjs` -- `remote_hosts`, and the `REMOTE HOSTS` text on linux -- FR-14 for the CLI
- [x] `docs/hub-api-contract.md` -- route row, `### Status`, `{name}` notation, HUB_HOST_UNKNOWN row -- contract
- [x] `tools/hub-api/contract.test.mjs` -- map notation, `/status` sample, exact keys -- contract test
- [x] `tools/hub-api/status.test.mjs`, `tools/device/status-view.test.mjs` -- the matrix rows and the updated key and text tests
- [x] `README.md` -- `status` remote hosts, `expected_end`, `GET /status`
- [x] verification -- `heavy mise run check`

**Acceptance Criteria:**
- Given `GET /status`, when it is called, then the top-level keys are exactly `format, contract, hosts, registry, stale, checked_at`, `hosts.linux` deep-equals the service-audience `statusView` built from the same seams, and Registry fields appear only under `registry`.
- Given the contract doc and `contract.test.mjs`, when `node --test tools/hub-api/contract.test.mjs` runs, then `/status` is in the route table and its live answer's flattened key set equals the `### Status` list exactly.
- Given HEAD, when `mise run check` runs, then it is green.

## Spec Change Log

## Review Triage Log

### 2026-11-25 — Review pass
- verdicts: 29 findings — high 0, medium 4, low 14, false 11, maybe-false 0
- findings:
  - `[low]` `[patch]` (blind) README and header say status shows each Hold's `expected_end`, but the text never prints it. Patched: both now say `--json` only.
  - `[false]` `[reject]` (blind) `expected_end` is only on `locks[]`, not on `phones[]`/`emulators[]`. The spec and contract define the Hold as the `locks[]` row, and a phone row names its `lock`, so a reader looks it up and never recomputes anything.
  - `[low]` `[patch]` (blind) REMOTE HOSTS counts stale Holds and stale tickets as held/waiting. Patched: `remoteLine` counts only rows whose `stale` is not `true`, with a test.
  - `[low]` `[reject]` (blind) every `call` failure reads `api-down` ("not answering"), even a problem answer. The matrix fixes `api-down` for any `call` failure, so changing it would mean editing the spec.
  - `[low]` `[patch]` (blind) `bad-answer` does not check `format`. Patched: `body.format !== 1` is now `bad-answer`, with test cases. Rejecting a non-object `stale` stays, as the spec says: the body is not a status document.
  - `[medium]` `[patch]` (blind) `status` has no explicit bound on the API call. Patched: a default `timeout` caps every exchange at 5 s, and a hang test is added (grouped with the edge and verification-gap timeout rows).
  - `[low]` `[patch]` (blind) `checked_at` was sampled after `statusView`. Patched: it is read once, before the view.
  - `[false]` `[reject]` (blind) an unreadable registry fails `/status` and this is undocumented. The `HUB_REGISTRY_FORMAT` error row names no route ("`registry.json` exists and cannot be read"), and failing closed keeps QA redaction safe.
  - `[false]` `[reject]` (blind) the `listed[index]` alignment is fragile, and `expectedEnd` can return a past time. `locks` is a 1:1 `map` of `listed` with no filter. A non-stale Lease is never past `expires_at`, because `listLocks` derives `stale` from it, so a past value never reaches a row.
  - `[false]` `[reject]` (blind) the hub-device.test "none of them calls the client" title is stale. That fixture has no host key, so `status` calls no client and the title still holds.
  - `[low]` `[patch]` (blind) weak tests. Patched: the QA test asserts `adb_id: null` unconditionally. The source-grep check is the one the spec asks for and was kept.
  - `[false]` `[reject]` (blind) the global dedupe in `flatten` hides duplicates for old shapes. Only the map branch can produce a repeated path: object keys are unique, and array items were already Set-deduped. The full contract suite passes unchanged.
  - `[false]` `[reject]` (blind) the contract lacks a redaction guarantee for `registry.resources`. The doc lists `registry.resources[].identity.*` as "(QA redacted)", and the QA test walks every key and string.
  - `[low]` `[reject]` (edge) add an `api-error` reason. Same root as the `api-down` row above: the matrix fixes the reason set.
  - `[medium]` `[patch]` (edge) the `/status` GET can wait 30 s after a healthy `/health`. Patched with the 5 s default cap (grouped with the timeout entry).
  - `[false]` `[reject]` (edge) force-release.test `status --json` reaches the live API. The file calls `hermetic()` and hub-client reads the global `fetch` at call time, so the call throws locally and both reads say `api-down`.
  - `[low]` `[patch]` (edge) no `format` check. Patched together with the blind `format` row.
  - `[low]` `[patch]` (edge) `remoteLine` counts stale rows. Patched together with the blind stale-count row.
  - `[low]` `[reject]` (edge) a registry write between `readIt` and `statusView` could make one document disagree. It needs a write inside the same few ms, and the fix (threading the registry through `statusView`) adds a parameter.
  - `[low]` `[patch]` (edge) `checked_at` after the view. Patched together with the blind `checked_at` row.
  - `[false]` `[reject]` (edge) an ownerless lock passes `null` to `expectedEnd`. `eta` throws, the throw is caught and the row gets `null`, as intended. The history is loaded once per view.
  - `[medium]` `[patch]` (verification-gap) a job Hold's `expected_end` was untested through `statusView`. Patched: the status-view test covers a live job lock (equal to `T0 + hi` from the same `eta`) and a stale one (`null`).
  - `[low]` `[reject]` (verification-gap) `api-down` also covers an answering API. Same root as the `api-down` row.
  - `[low]` `[patch]` (verification-gap) the text never prints `expected_end`. Patched together with the README wording row.
  - `[low]` `[patch]` (verification-gap) the `[stale]` branch and a non-object `stale` were untested. Patched: test cases were added.
  - `[medium]` `[patch]` (verification-gap) no test for a `/status` that hangs. Patched: a hang test that aborts through the `timeout` seam.
  - `[false]` `[reject]` (intent) `hosts` carries only `linux`. The story owes one host's view, and the epic plan adds the Mac's key in Epic 9 with no key change. The document is what 8.1 promises.
  - `[false]` `[reject]` (intent) the tests are in-process, not against the live service. Tests are hermetic by repo rule, and live install verification is the ship story (8.7).
  - `[false]` `[reject]` (intent) the CLI does not read its own host from the API. `status` must work with the API down (Story 6.8), so the local view stays local.

### 2026-11-25 — Review pass (follow-up)
- verdicts: 28 findings — high 0, medium 1, low 13, false 14, maybe-false 0
- findings:
  - `[low]` `[reject]` (blind) a dead API adds latency to every linux `status`, and the 5 s cap is per exchange. The real worst case is the 2 s `/health` probe plus the 5 s exchange (7 s), on a loopback service that rarely hangs. No doc states a total bound, and the fix adds a shared deadline or concurrency.
  - `[low]` `[reject]` (blind) `api-down` hides an API that answered with a problem. carried: same claim as the first pass's `api-down` row; the matrix fixes the reason set.
  - `[false]` `[reject]` (blind) `/status` fails whole on an unreadable `registry.json`, and the `HUB_REGISTRY_FORMAT` row does not name it. carried: same claim as the first pass's registry row; failing closed keeps QA redaction safe.
  - `[low]` `[reject]` (blind) `remoteLine` trusts the remote view's shape, so a view without `locks`/`waiters` arrays prints `0 held, 0 waiting`. The only producer is `statusDocument`, which always embeds `statusView`'s arrays. The fix adds shape guards for an answer nobody sends.
  - `[low]` `[reject]` (blind) `checked_at` and the view read the clock separately. They are milliseconds apart. Pinning one `now` into `statusCtx` would make reachability ages taken after it negative, so the fix is not a direct correction.
  - `[false]` `[reject]` (blind) `expectedEnd` tests `kind !== 'lease'` while `statusView` uses `isLease`. `isLease` is `owner => owner?.kind === 'lease'` (`lock.mjs:101`), the same predicate.
  - `[low]` `[reject]` (blind) one live Hold now triggers the windowed Event Log read on every status. The spec requires the history "loaded when a live Hold or waiter exists", so the fix edits the spec. Read cost is Story 8.2's.
  - `[false]` `[reject]` (blind) the contract test's `/status` sample is not safe to run twice on one scratch. Every test builds its own scratch, and each walk calls `/status` once (`contract.test.mjs` L296, L328, L413, L448).
  - `[false]` `[reject]` (blind) the source-grep test's marker slice can check the wrong text. A missing marker gives either `''` (fails `length > 200`) or more of the file (a stricter check). It never passes silently.
  - `[false]` `[reject]` (blind) the spec frontmatter is stale. `review_loop_iteration: 0` is right (no bad_spec loopback), `followup_review_recommended: true` was the first pass's outcome, and `oversized` still holds. This pass rewrites the frontmatter at finalize.
  - `[false]` `[reject]` (blind) the Spec Change Log is empty after patches. The change log records bad_spec loopbacks. Patches are recorded in this triage log, and there was no loopback.
  - `[low]` `[reject]` (blind) the README `status` paragraph is one enormous line. It has always been one line per command. Cosmetic, and reflowing it is a docs-wide change.
  - `[false]` `[reject]` (blind) the `hub-device.test` title "none of them calls the client" is a trap. carried: same claim as the first pass's title row; that fixture has no host key.
  - `[false]` `[reject]` (blind) the text-output test was weakened. `known.out.slice(0, at)` deep-equals the whole non-linux output, which pins every pre-8.1 line. The null and `mac` keys have their own no-call, no-block test.
  - `[low]` `[patch]` (edge) a non-stale lock with no owner record (mid-creation for up to 60 s, or an unreadable `owner.json`) got `expected_end = now`, because `eta` returns `hi_ms: 0` with no parts. Patched: `expectedEnd` returns `null` for a missing or non-object owner, with unit cases in `eta.test.mjs`.
  - `[low]` `[patch]` (edge) no test covered the ownerless Hold. Patched with the row above (same root).
  - `[low]` `[reject]` (edge) the probe and the exchange can stall `status` past 5 s. Same root and reason as the blind latency row.
  - `[low]` `[reject]` (edge) a malformed host view reads as an idle host. Same root and reason as the blind `remoteLine` row.
  - `[low]` `[reject]` (edge) `checked_at` and the view do not share an instant. Same root and reason as the blind clock row.
  - `[false]` `[reject]` (edge) `prepareStatus` re-acquires `adb` when `/status` runs twice on one scratch. No test does that (see the blind contract row).
  - `[low]` `[patch]` (edge) the claim that `expected_end` is null when unknown was false for an ownerless lock. The first pass's row said `eta` throws for a null owner, and it does not. Patched with the ownerless row (same root).
  - `[medium]` `[patch]` (verification-gap) the default 5 s cap on the `/status` exchange was never exercised, because the hang test replaces the whole `timeout` seam. Patched: a status-view test runs with no seam, records every `AbortSignal.timeout` bound and asserts each is at most 5 s. Changing `5000` to `30000` makes it fail.
  - `[false]` `[reject]` (intent) the tests drive `handle()` in-process, never through `server.mjs`. carried: same claim as the first pass's live-service row; live install is Story 8.7.
  - `[false]` `[reject]` (intent) `statusDocument` does not use the server's cached `readings`. The spec forbids any cache in 8.1, and Story 8.3 owns the cached reachability feed.
  - `[false]` `[reject]` (intent) the Happy test compares against a second context, not "the same ctx". It is built from the same injected seams, and those seams are deterministic, so the views are equal by construction. The `registry.json` route to `qa_ids` is covered by the QA test.
  - `[low]` `[reject]` (intent) the CLI tests use hand-written status bodies and never feed `statusDocument`'s output into `remoteHosts`. The contract test pins the producer's keys, and the CLI checks only `format`, `hosts` and `stale`. An end-to-end harness is more than a direct correction.
  - `[false]` `[reject]` (intent) the CLI cannot show the Mac yet. carried: same claim as the first pass's `hosts`-only-linux row; Epic 9 adds the key.
  - `[false]` `[reject]` (intent) `sprint-status.yaml` is modified in the working tree. That is the orchestrator's bookkeeping, outside the reviewed diff, and this story neither writes nor commits it.

## Design Notes

`stale` is a host-keyed object, not a boolean, because Story 9.6 shows "the last view marked stale, with `since`" while the view itself stays unchanged. `{}` keeps the key stable now. A remote host the API does not list reads `unavailable` with reason `not-served`. That way a reader can tell "API down" from "the API has no view of the Mac yet": until Epic 9 the CLI on big-chungus always shows `mac  unavailable`, which is the truth.

`expected_end` uses the ETA's upper bound (`hi_ms`, the 75th percentile, or the stated duration on low data). It says "over by", so it is clipped at `expires_at` and is null when unknown. No caching is done here. Story 8.2's snapshot must keep deriving `stale`, `expected_end` and the grace state at serialisation.

The map notation, golden: `hosts: {linux: {phones: [{device: 's24'}]}}` flattens to `hosts.{host}.phones[].device` when the doc has an entry starting `hosts.{host}.`.

## Verification

**Commands:**
- `node --test tools/hub-api/status.test.mjs tools/hub-api/contract.test.mjs tools/device/status-view.test.mjs` -- expected: all pass
- `heavy mise run check` -- expected: green


## Auto Run Result

Status: done

**Summary.** `GET /status` serves one status document, `{format, contract, hosts: {<host key>: view}, registry, stale, checked_at}`.
- Each view is `claims.statusView(key, {audience: 'service', qa_ids})`, embedded unchanged. The route never recomputes a queue, an ETA, a Pool fold or a redaction.
- Nothing is cached. Expiry, grace and staleness are derived from the clock on every read.
- Every `locks[]` row gains `expected_end` from the one ETA (`eta.mjs` `expectedEnd`). It is never later than `expires_at`. It is `null` when the Hold is stale, when its end is unknown, or (since the follow-up pass) when the lock has no owner record.
- `hub-device status` on the linux host reads the document once and adds `remote_hosts` / `REMOTE HOSTS` for every other `HOST_PLATFORMS` key. Each exchange is capped at 5 s, and the `/health` probe at 2 s.
  - A remote host is `available` with its view and stale marker, or `unavailable` with reason `api-down`, `not-served` or `bad-answer`.
  - On other hosts the CLI makes no call.
- Belsky level: "every reader of the status document". `statusDocument(ctx)` is the one builder that the 8.4 stream frames, the 8.5 re-read and Epic 9's Mac key reuse. The CLI is generic over host keys, and the contract test's new `a.{name}` notation pins any keyed map exactly.

**Files changed.**
- `tools/ci/lib/eta.mjs`: pure `expectedEnd(owner, events, policy, now)`, null for a missing owner.
- `tools/device/claims.mjs`: `expected_end` on `locks[]` rows. The ETA history now loads for a live Hold or a live waiter.
- `tools/hub-api/routes.mjs`: `statusDocument` and the `GET /status` route (shape `Status`).
- `tools/device/hub-device.mjs`: `remote_hosts` in `--json` and the `REMOTE HOSTS` text block on linux.
- `docs/hub-api-contract.md`: route row, `### Status` field list, `a.{name}` notation and the `HUB_HOST_UNKNOWN` row.
- `README.md`: `expected_end` (`--json`), remote hosts and `GET /status`.
- `tools/hub-api/contract.test.mjs`: map notation (`mapPrefixes`, the `flatten` maps param), the `/status` sample and the exact key set.
- `tools/hub-api/status.test.mjs` (new): matrix rows happy, QA redaction, time-only change, expected_end and host-unknown, plus a no-cache/no-eta source check and a read that writes nothing.
- `tools/device/status-view.test.mjs`: key order, the text test, CLI api-down/up/other-key/hang, the default 5 s cap, and `expected_end` for a Lease and for a job Hold.
- `tools/device/claims.test.mjs`, `tools/device/hub-device.test.mjs`, `tools/ci/eta.test.mjs`: `remote_hosts` strip, a comment, and `expectedEnd` unit cases (including the ownerless Hold).

**Review findings.**
- First pass: 29 findings (high 0, medium 4, low 14, false 11). Patched 7 entries, deferred none, and rejected 2 lows and 11 falses. Each reason is in the triage log.
- Follow-up pass: 28 findings (high 0, medium 1, low 13, false 14, maybe-false 0).
  - Patched 2 entries:
    - Medium (verification-gap): the default 5 s cap is now tested with no seam, by recording every `AbortSignal.timeout` bound. A mutation to 30 s fails the test.
    - Low (edge, 3 rows): an ownerless non-stale lock's `expected_end` was "now". `expectedEnd` now returns null, with unit cases.
  - Deferred: none.
  - Rejected lows, with reasons:
    - Status latency of up to 7 s on a hung API (twice). The fix adds a shared deadline.
    - The `remoteLine` shape trust (twice). The only producer always sends arrays.
    - The `checked_at`/view clock skew (twice). It is milliseconds, and pinning `now` would make reachability ages negative.
    - The Event Log read per live Hold. The spec mandates it.
    - The long README line. Cosmetic.
    - No producer-to-consumer CLI test. The contract test pins the producer.
    - `api-down` on a problem answer. Carried from the first pass.
  - Rejected falses: 14. Each refutation is in the triage log. Five rows were carried from the first pass.

**Follow-up review recommended: false.** This was a follow-up pass, and it patched no `high` (patched by entry verdict: high 0, medium 1, low 1), so the work has converged.

**Verification.**
- `node --test tools/ci/eta.test.mjs tools/device/status-view.test.mjs tools/hub-api/status.test.mjs tools/hub-api/contract.test.mjs`: 98/98.
- Mutation check: with `Math.min(ms, 30000)` the new cap test fails (1 fail), and it passes once the file is restored.
- `heavy mise run check`: green, 1457/1457 (1456 after the first pass, plus the cap test).
- Matrix audit: every row has a passing test (`status.test.mjs` and `status-view.test.mjs`).

**Residual risks.**
- `hosts` carries only `linux` until Epic 9, so the CLI always lists the Mac `unavailable`/`not-served` on big-chungus. That is the truth, but operators will see it on every status.
- With a hung Hub API, linux `status` can wait up to about 7 s (a 2 s probe plus a 5 s exchange) before it prints.
- The live `/status` exists only after the next hub release and `hosts:install` (Story 8.7).
- Story 8.2's snapshot must keep deriving `stale`, `expected_end` and grace at serialisation, never caching them.
