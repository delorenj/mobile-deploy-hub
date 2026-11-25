---
title: 'Reachability and discovery through the API'
type: 'feature'
created: '2026-11-25'
status: 'done'
baseline_revision: '6e06a49957d2412226f71334704e92e02a67e1dd'
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-6-context.md'
warnings: ['oversized']
deferred: []
---

<intent-contract>

## Intent

**Problem:** The Hub API serves the Registry but cannot say which Resources are reachable or which devices on the hub's adb server nobody has registered. So a freshly paired Pixel is invisible to Holocene and to agents until someone runs `hub-device discover` on big-chungus (FR-4, FR-5, UJ-3, AD-35, SM-3).

**Approach:** Following belsky-doctrine, the level one up from "the Hub API reports Reachability and discovery" is **every reader and every service of a Reachability reading**. So:
- The serve and receive halves of a reading live in the pure `reachability.mjs`. Every client (hub-device, Holocene, a Host Agent replica) re-stamps one the same way, and clock skew cannot make it look fresh.
- A service-side reading cache (`tools/hub-api/readings.mjs`) is generic over the host's own probe. The Host Agent reuses it for the iPad later.
- Discovery's "no Resource names it" moves into `claims.discover` over the Registry, so the CLI's `discover` also stops listing a phone registered through the API.

## Boundaries & Constraints

**Always:**
- `GET /discovery` returns `claims.discover(hostKey, deviceCtx, {devices, qaDevices})`. Its body is `{format: 1, host, via, port, note, devices: [{serial, model, id, state}]}`.
  - The exclusion set is the **live** Registry records (`retirement(record) === null`), read with `readRegistry`. The API passes its `ctx.devices` and `ctx.qaDevices`; the CLI passes nothing (seed of `devices.json`, QA file never read, exactly as before).
  - The route then drops every device whose serial, UDID or id (`idMatchesSerial`) a QA-file entry names, so a QA serial never reaches a response.
  - An unknown host key is problem 503 `HUB_HOST_UNKNOWN`, exit 1, reason `host-unknown`.
- `GET /resources` rows gain `reachability: {state, checked_at, age_ms_at_receipt, received_at, source}`. This is added to that route only; the `Resource` shape (`/resources/{id}` and the POSTs) is unchanged.
  - The served form is `serve(stored, {now})`: `age_ms_at_receipt = max(0, stored.age_ms_at_receipt + now - stored.received_at)`, `received_at = now` (the service clock, ms), `source: 'probe'`.
  - No reading at all serves `{state: 'unknown', checked_at: null, age_ms_at_receipt: null, received_at: null, source: null}`.
  - `stale` is never served.
- `reachability.mjs` gains the pure `serve(stored, {now})` and `receive(served, {now})`. `receive` keeps `age_ms_at_receipt` and sets `received_at` to the reader's clock; it returns null for an unknown/empty reading. `present(receive(x, {now: t}), {now: t + d})` therefore has `age_ms = x.age_ms_at_receipt + d` whatever the two clocks say.
- `createReadings({env, policy, now, hostId, log, hostKey, probe, note})` in `tools/hub-api/readings.mjs`:
  - `read(records)` is **synchronous**: it returns `Map(id -> served reading)` for every record given.
  - When any own-host `kind: 'phone'` record's cached reading is missing or stale (`present(...).stale` against `policy.registry.reachability_max_age_s`), and no refresh is running, it starts one async refresh. At most one is in flight.
  - `settled()` returns the in-flight promise (for tests).
  - A refresh calls `probe(phones)` (default `claims.phoneReadings(phones, deviceCtx)`) and stores `{...stamp(state), source: 'probe'}` per phone.
  - For each state that differs from the last one this cache logged, it calls `noteReachability({resource, from: last ?? null, to, checked_at, reason: 'probe'})` once. It remembers the state only when the note returned true.
  - A throwing probe or note is one `HUB_API_REACHABILITY_FAILED <message>` line on `log` and never reaches a request.
  - An unknown host key probes nothing.
- `claims.phoneReadings(phones, ctx)` is the one adb-to-Reachability path: inventory, then `phoneObservations` (queryAdb over the wire), then `phoneReachability`. It returns `Map(device -> state)`. `statusView` keeps its own call order and output.
- `startHubApi` builds `ctx.readings` once and passes the device seams (`adbWire`, `inventory`, `hostKey`, `sleep`, `devicectl`) into `ctx`. `handle()` with no `ctx.readings` serves the no-reading form and probes nothing (hermetic default).
- `docs/hub-api-contract.md`:
  - a `GET /discovery` row and a `### Discovery` section;
  - the five `resources[].reachability.*` fields and the age rule (a reader computes `age_ms_at_receipt + now - received_at`, and a client on another host re-stamps with `receive` first);
  - a `HUB_HOST_UNKNOWN` 503/exit 1 error row.
  The contract stays at 1 (additive).

**Never:**
- No `setTimeout`/`setInterval` in `tools/hub-api/` (`clock.test.mjs`). A refresh is started only by a read, never by a timer.
- No adb request other than `host:version`, `host:devices-l`, and, for a `host:port` id in `device` state, `host:transport:<id>` + `shell:getprop ro.serialno`. No server start, no connect, no `findPhone`.
- The CLI never writes a `reachability` event. `statusView`'s output, `hub-device status`, and every existing exit code and `--json` shape stay the same. `hub-device discover` changes only in now excluding live registered Resources.
- No identity, serial or `allowed_users` in a `reachability` event or a served reading. No change to the deploy path (`deploy-path.test.mjs`).
- No `host:track-devices-l` socket (`source: track` is a later story), and no Mac/iPad probe from the Hub API.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected | Error |
|----------|--------------|----------|-------|
| Discovery, new Pixel | adb server up; listed S24, S26 (mDNS ids), `ZY22PIX` (USB, model `Pixel_9`) | `devices` = `[{serial: 'ZY22PIX', model: 'Pixel_9', id: 'ZY22PIX', state: 'device'}]`, `port: 5037`, `note: null`; wire requests exactly `[host:version, host:devices-l]` | — |
| Discovery, host:port | listed `192.168.1.40:41234` (device), serial read `9A1B` | serial `9A1B`, id the endpoint; extra requests only `host:transport:192.168.1.40:41234`, `shell:getprop ro.serialno` | — |
| Discovery, registered | `ZY22PIX` registered as `res-pixel` (file) | not listed; after `retire res-pixel` listed again | — |
| Discovery, QA phone | QA file names `QAPIX1`, listed on adb, not in `registry.json` | not listed; serial in no part of the body | — |
| Discovery, no server | inventory shows no server on the port | `devices: []`, `note: 'no adb server'`, wire never opened, 200 | — |
| Discovery, no host key | `hostKey` throws HUB_HOST_UNKNOWN | 503 problem `HUB_HOST_UNKNOWN`, exit 1, `host-unknown` | problem+json |
| First read | `ctx.readings` with a probe that has not resolved | `/resources` answers at once; every row `reachability.state: 'unknown'`, `source: null`; probe called once for two back-to-back reads | — |
| After refresh | probe resolved S26 `device`, S24 absent | s26 `{state: 'reachable', source: 'probe', age_ms_at_receipt: 0..}`; s24 `absent`; ios-lane and emulator `unknown`/null; two `reachability` events (`from: null`) | — |
| Unchanged refresh | reading aged past 60 s, same states | one new refresh, cached reading returned meanwhile, no new events | — |
| Changed refresh | S26 goes `offline` | one event `{resource: 's26', from: 'reachable', to: 'offline', reason: 'probe'}` | — |
| Skew | stored reading `received_at` R, served at R+70 000 | served `age_ms_at_receipt` ≥ 70 000; `receive` on a clock 1 h behind then `present` 5 s later gives `age_ms` = served + 5000, stale | — |
| Probe throws | probe rejects | read still answers; one `HUB_API_REACHABILITY_FAILED` line; next stale read retries | logged only |

</intent-contract>

## Code Map

- `tools/hub-api/routes.mjs`:
  - `listResources` L97: add the reachability join. `serve()` L90 stays the visibility filter.
  - `ROUTES` L199: add `GET /discovery`, shape `Discovery`. `routeError` L66 is the 503.
  - Imports `hostKey` from claims.
- `tools/hub-api/server.mjs` `startHubApi` L141: build `ctx.readings` and pass the device seams into `ctx`. No timers here.
- `tools/hub-api/readings.mjs` (new): `createReadings`, plus `deviceCtx(ctx)`, which builds `{env, timing: {sleep, now}, inventory, adbWire, devicectl, warn}` for the claims calls. Both are used by routes and server.
- `tools/registry/reachability.mjs`: `stamp` L160, `present` L173, `MISSING` L168; add `serve` and `receive` beside them. `queryAdb` L87 and `discover` L123 are unchanged.
- `tools/device/claims.mjs`:
  - `phoneObservations` L675: reuse it in the new exported `phoneReadings`.
  - `discover` L873: change its exclusion set from `seed(loadDevices)` to the live `readRegistry` records, with options `{devices, qaDevices}`.
  - Imports `readRegistry`, `retirement` and `phoneReachability` (all already present).
- `tools/ci/lib/lock.mjs` `noteReachability` L258 (read only): returns appendEvent's true/false; the shape is `{resource, from, to, checked_at, reason}`.
- `tools/ci/lib/adb.mjs` `idMatchesSerial` L64 (read only).
- `tools/device/wire-fixtures.mjs` `fakeWire` (read only): `requests` log, `opened`.
- `tools/registry/discover.test.mjs` L21-37: `serverUp`/`serverDown` inventories and `quickSleep`, to copy.
- `tools/hub-api/resources.test.mjs` L26-45: the `scratch()` with `ctx(more)`. L62 pins row keys to `RECORD_KEYS`; that becomes `[...RECORD_KEYS, 'reachability']`.
- `tools/hub-api/contract.test.mjs` L147-152 `scratch()`: add `hostKey: () => 'linux'`, a `serverUp` inventory and a `fakeWire` with one unregistered device, so `GET /discovery` has a non-empty `devices[]`.
- `tools/clock.test.mjs`: no `setTimeout` in `tools/hub-api/`; `pause.mjs`'s `sleep`, reached through queryAdb, is outside that scope.
- `docs/hub-api-contract.md` routes table L23 and shapes; `README.md` L261 (discover) and L326 (Hub API).

## Tasks & Acceptance

**Execution:**
- `tools/registry/reachability.mjs` -- add `serve`, `receive` and the `NO_READING` served form -- the one way every reader moves a reading across a boundary.
- `tools/device/claims.mjs` -- export `phoneReadings`; Registry-backed `discover(key, ctx, {devices, qaDevices} = {})` -- one adb path, and one exclusion rule for the CLI and the API.
- `tools/hub-api/readings.mjs` (new) -- `createReadings` and `deviceCtx` -- the service cache: synchronous reads and at most one refresh in flight.
- `tools/hub-api/routes.mjs` -- reachability on `/resources` rows, the `discovery` handler with the QA filter, the `ROUTES` row, header comment -- the AC surface.
- `tools/hub-api/server.mjs` -- `startHubApi` seams and `ctx.readings` -- the live service gets the cache.
- `docs/hub-api-contract.md` -- route row, Discovery shape, Reachability fields and age rule, `HUB_HOST_UNKNOWN` -- the contract test holds it equal.
- `tools/hub-api/contract.test.mjs` -- scratch seams only.
- `tools/hub-api/resources.test.mjs` -- the row-keys assertion only.
- `tools/hub-api/reachability-discovery.test.mjs` (new, hermetic) -- every matrix row through `handle()`, plus a `serve`/`receive` skew unit test and a CLI `hub-device discover --json` case that excludes a registered phone.
- `README.md` -- the discover paragraph (Registry exclusion) and the Hub API paragraph (`/discovery`, Reachability on `/resources`).

**Acceptance Criteria:**
- Given `docs/hub-api-contract.md`, when this story lands, then it lists `/discovery` and the Reachability fields, and `contract.test.mjs` passes.
- Given the hermetic suite, when it runs, then a fake adb wire proves only `host:version` and `host:devices-l` are issued for USB/mDNS ids (and only the read-only serial read for a `host:port` id), and no server is started or connected.
- Given the existing suites (`discover.test.mjs`, `status-view.test.mjs`, `hub-device.test.mjs`, `registered-phone.test.mjs`, `tools/hub-api/*.test.mjs`, `deploy-path.test.mjs`, `clock.test.mjs`), when they run, then they pass. Only the two scratch/keys edits named above touch an existing test.
- Given `heavy mise run check`, when it runs, then actionlint and the full suite pass.

## Spec Change Log

## Review Triage Log

### 2026-11-25 — Review pass
- verdicts: 27 findings — high 0, medium 3, low 20, false 4, maybe-false 0
- findings:
  - `[low]` `[reject]` (blind) `/discovery` falls back to the seed when `registry.json` is unreadable, so a registered phone is listed as undiscovered. — Real, but this is the AD-27 fallback every read route shares. `/resources` and `/pools` also answer from the seed (not 409, as the finding claims), and `/health` reports `registry: unreadable`. Changing it adds a branch for an operator-broken file.
  - `[low]` `[reject]` (blind) The QA filter cannot match an `unauthorized`/`offline` `host:port` QA phone (serial null). — The row carries `serial: null`, so no QA serial reaches the body, which is the rule. Recognising the device as QA would need a serial adb cannot give.
  - `[low]` `[reject]` (blind) A probe that throws or omits a record re-probes on every read (probe storm). — Bounded by the one-in-flight guard. The real probe never throws (`queryAdb` catches) and answers every phone given, including `unknown` for no server, which is then cached for 60 s.
  - `[low]` `[patch]` (blind) The in-memory `logged` re-announces every Resource (`from: null`) after a restart, contradicting "logged once". — Group RESTART. Intended (Design Notes). The contract now says the cache's memory is per process and the first reading after a start is logged with `from: null`.
  - `[low]` `[patch]` (blind) The Discovery contract documents only `host: linux`/`via: adb`, but the route passes a Mac key through. — Group MAC. The contract now says a Mac-keyed service answers `host: mac`, `via: devicectl`, `port: null`.
  - `[low]` `[patch]` (blind) `checked_at` is taken after the probe returns, so a slow probe looks fresher; field naming and format are confusing. — Group CHECKED. `at = now()` is now taken before `await ask(...)`. The naming and format half is rejected: the names are AD-35's, and `received_at` in ms is `stamp`'s existing form.
  - `[medium]` `[patch]` (blind) No test boots `startHubApi`, so its wiring of `readings` and the device seams is unverified. — Group WIRING. Added a `server.test.mjs` case. It starts the service with a fake wire, sees `s26` go from `unknown` to `reachable` across `/resources` reads through the listener, and gets the fake device from `/discovery`.
  - `[low]` `[patch]` (blind) The CLI discover test title says "never asks the API" without asserting it. — The test now injects a recording `fetchImpl` and asserts it was never called.
  - `[low]` `[reject]` (blind) The README discover paragraph is long, and the `HUB_HOST_UNKNOWN` row placement is odd. — Cosmetic, and nothing is wrong in the text. The table is not ordered by status.
  - `[low]` `[patch]` (blind) The name-or-id lookup in refresh is untested for a registered phone (`res-pixel`/`pixel`). — Group REGISTERED. Added a case that registers `pixel` through `POST /registry/resources` and asserts the probe got `device: 'pixel'`, the row reads `reachable` with `source: probe`, and one event is logged.
  - `[low]` `[patch]` (edge) An unreadable `registry.json` writes a `HUB_REGISTRY_FORMAT` line on every `/discovery`. — The route now passes a no-op `warn` to `discover`, like `readIt`; `/health` already reports it.
  - `[low]` `[reject]` (edge) A malformed QA file makes `/discovery` a 500 after the adb query. — A loud failure on an operator-broken private file. Every seed read with the QA loader fails the same way, and answering without the filter could leak a QA serial.
  - `[low]` `[reject]` (edge) A null-serial `host:port` QA phone appears with its id and model. — The same as the blind QA finding. No serial leaks, and the device cannot be identified as QA.
  - `[low]` `[reject]` (edge) A failing probe restarts on every stale read, and a hung custom probe pins `inflight` forever. — The same root as the probe-storm finding. The real probe is bounded at 5 s by `queryAdb`, and custom probes exist only in tests.
  - `[low]` `[patch]` (edge) `stored`/`logged` grow without bound, and a restart re-logs. — Group RESTART for the re-log half (the doc fix above). The growth half is negligible: one entry per phone ever registered.
  - `[low]` `[reject]` (edge) A probe with no entry for an own phone keeps serving the old reading and refreshes on every read. — Not reachable with the real probe, which answers every phone it is given (`phoneReadings` maps each one).
  - `[low]` `[patch]` (edge) `checked_at` is taken after the probe. — Group CHECKED (fixed above).
  - `[false]` `[reject]` (edge) A probed `unknown` is stored with a timestamp and `source: probe`, contradicting the contract. — The contract's all-null form is for *no reading*. A checked `unknown` ("the transport could not say") with its time is AD-35's own meaning, and the doc says both.
  - `[low]` `[patch]` (edge) The Discovery contract does not cover the Mac key. — Group MAC (fixed above).
  - `[false]` `[reject]` (edge) A noter returning a truthy non-`true` value writes a duplicate every refresh. — `noteReachability` returns `appendEvent`'s strict `true`/`false` (`tools/ci/lib/events.mjs:94,97`), and only it is wired.
  - `[medium]` `[patch]` (verification-gap) `startHubApi`'s readings and seam wiring have no test through the service. — Group WIRING (fixed above).
  - `[low]` `[patch]` (verification-gap) Reachability of a registered phone whose id differs from its name is never tested. — Group REGISTERED (fixed above).
  - `[medium]` `[patch]` (intent) The behaviour is shown only through `handle()`, never through the running service. — Group WIRING (fixed above).
  - `[false]` `[reject]` (intent) `hub-device discover` changes too: the CLI surface moved. — Intended, one level up (belsky-doctrine): the CLI and API now share one exclusion rule. It is in the spec's Approach and covered by the CLI test.
  - `[false]` `[reject]` (intent) A row with no reading has `source: null`, not `probe`. — The AC covers rows "when they carry Reachability" (a reading). A row nobody checked carries the no-reading form, and it never claims a probe.
  - `[low]` `[patch]` (intent) "The last one the service logged" is held in process memory. — Group RESTART (doc fix above).
  - `[low]` `[reject]` (intent) "The CLI never writes a reachability event" is checked only by a CLI `discover` that never wrote events. — The CLI has no call path to `noteReachability`; only `tools/hub-api/readings.mjs` calls it. A source-grep would add a test for a path that does not exist.

## Design Notes

- **Why serve re-stamps.** A stored reading's `received_at` is on the service's clock. Serving it raw would make a client on another host compute `now_client - received_at_service`, which is skew. Serving the age *as of the response* and the service's `now` keeps the same-host formula exact. `receive()` lets a cross-host reader drop the service clock entirely. Readers never touch `checked_at` for age.
- **Why reachability only on `/resources`.** `Resource` is shared by the read and the three write answers, and the contract test pins each shape exactly. The AC names the list. `/resources/{id}` can gain it later additively.
- **Why the cache is generic over `probe`.** AD-35 gives each host one owner of its readings. The Hub API passes the adb probe; the Host Agent (Epic 7/9) passes the devicectl one and gets the same at-most-one-refresh and log-on-change rules.
- **The first reading after a start logs `from: null`.** The cache keeps no log cursor across restarts; that is `noteReachability`'s documented first-reading form.

## Verification

**Commands:**
- `node --test tools/hub-api/*.test.mjs tools/registry/*.test.mjs tools/device/*.test.mjs tools/deploy-path.test.mjs tools/clock.test.mjs` -- expected: all pass
- `heavy mise run check` -- expected: actionlint clean, full suite green

## Auto Run Result

Status: done

**Summary.** The Hub API now reports Reachability and discovery (FR-4, FR-5, AD-35):
- `GET /discovery` lists the devices on the hub's adb server that no live Resource names, with serial, model, adb id and state, and the port asked. It uses the read-only wire only. It answers `no adb server` rather than starting one, never shows a QA serial, and an unknown host key is 503 `HUB_HOST_UNKNOWN`.
- `GET /resources` rows carry `reachability: {state, checked_at, age_ms_at_receipt, received_at, source}` from a service cache. A read never waits: a missing or stale reading starts at most one background refresh.
- Each change of state is one `reachability` event, through `noteReachability`, from the service only.

Following belsky-doctrine, each piece serves the level one up, not just this route:
- **Readers.** `serve`/`receive` in `reachability.mjs` are how every reader moves a reading across a boundary: hub-device, Holocene, a Host Agent replica. Clock skew cannot make a reading look fresh.
- **Services.** The cache (`createReadings`) is generic over the host's own probe, so the Host Agent reuses it for the iPad.
- **The CLI.** `claims.discover` now excludes the live Registry, so `hub-device discover` also stops listing a phone registered through the API.

**Files changed:**
- `tools/registry/reachability.mjs`: `NO_READING`, `serve`, `receive`.
- `tools/device/claims.mjs`: exported `phoneReadings` (the one adb-to-Reachability path); `discover` excludes live Registry records (`{devices, qaDevices}` options).
- `tools/hub-api/readings.mjs` (new): `createReadings` (synchronous read, one refresh in flight, log-on-change, no timer) and `deviceCtx`.
- `tools/hub-api/routes.mjs`: reachability on `/resources` rows; the `GET /discovery` route with the QA filter and 503 host-unknown.
- `tools/hub-api/server.mjs`: `startHubApi` builds the one cache and threads the device seams into the context.
- `docs/hub-api-contract.md`: the `/discovery` row and `Discovery` shape, the five reachability fields with the age rule and restart note, and `HUB_HOST_UNKNOWN`.
- `README.md`: the discover paragraph (Registry exclusion) and the Hub API paragraph.
- `tools/hub-api/reachability-discovery.test.mjs` (new): every matrix row, the registered-phone reading, skew, and the CLI `discover` exclusion.
- `tools/hub-api/server.test.mjs`: the `startHubApi` wiring case (review patch).
- `tools/hub-api/contract.test.mjs` and `resources.test.mjs`: the scratch seams and the row-keys assertion only.

**Review findings.** 27 findings in total: high 0, medium 3, low 20, false 4.
- **Patched (7 entries):**
  - The `startHubApi` wiring was untested (medium; 3 rows).
  - The registered phone's reading was untested (low).
  - `checked_at` was stamped after the probe (low).
  - Restart re-logging was undocumented (low; 3 rows).
  - The Mac-key Discovery shape was undocumented (low; 2 rows).
  - A `HUB_REGISTRY_FORMAT` line was written on every `/discovery` (low).
  - The CLI test title was unasserted (low).
- **Deferred:** none.
- **Rejected as false (4):**
  - A probed `unknown` contradicts the contract: no-reading and checked-unknown are different, and both are documented.
  - A truthy-noter duplicate: `noteReachability` returns strict booleans.
  - The CLI surface moved: intended (belsky-doctrine) and tested.
  - `source: null` on rows nobody checked: the AC covers rows that carry a reading.
- **Rejected as low (9 rows):**
  - The unreadable-file seed fallback: shared AD-27 behaviour, and `/health` reports it.
  - A null-serial QA `host:port` row, twice: no serial leaks.
  - Probe storm or hung probe, twice: bounded by the in-flight guard and `queryAdb`'s 5 s.
  - A malformed QA file gives a 500: a loud failure beats a possible leak.
  - A probe omitting a phone: not reachable with the real probe.
  - README length and row order: cosmetic.
  - The weak CLI-never-writes assertion: no code path exists.
- **Follow-up review recommended: false.** This first pass patched one medium entry and no high.

**Verification:**
- `node --test tools/hub-api/*.test.mjs tools/registry/*.test.mjs tools/device/*.test.mjs tools/deploy-path.test.mjs tools/clock.test.mjs`: 522 of 522 pass after the patches.
- `heavy mise run check`: exit 0, actionlint clean, 1199 of 1199 tests pass.
- Matrix audit: each of the 12 rows maps to a passing test in `reachability-discovery.test.mjs`.

**Residual risks:**
- The cache's "last logged" memory is per process, so each service start writes one `from: null` event per phone (documented).
- A phone registered with no serial reads `absent`, not `unknown`. This is status's existing mapping, kept for one mapping.
- `/resources/{id}` and the write answers carry no Reachability yet; it can be added later.
- No `host:track-devices-l` stream and no Mac probe from the API: later stories (AD-35 `source: track`, the Host Agent).
- The installed service needs the Story 6.12 release and `hosts:install`. That is the normal agent-run release, so there are no operator actions.
