# Epic 6 Context: Jarad registers a device and every agent can use it

<!-- Generated from planning artifacts. Regenerate with compile-epic-context if planning docs change. -->

## Goal

Jarad can register new hardware (a Pixel, say) through a Hub API, and every agent can lease it by name or through the `phone` word within 60 seconds, with no hub release and no reinstall. The Hub API is the Registry's only writer. Stories 6.1 to 6.3 need no service (Event Log vocabulary, the Registry store, seeding); 6.4 onward are the service. Story 6.9 is the payoff. The deploy path never depends on any of it, and a stopped API only disables Registry writes; holds keep working.

## Stories

- Story 6.1: Event Log vocabulary for Registry, Reachability and prune
- Story 6.2: The Registry store has one writer
- Story 6.3: Seed at start, import QA phones on first creation
- Story 6.4: The Hub API runs, answers `/health` and has a contract
- Story 6.5: Read the Registry through the API
- Story 6.6: Register a Resource through the API
- Story 6.7: Edit and retire a Resource
- Story 6.8: Registry verbs in `hub-device`, and a clear message when the API is down
- Story 6.9: A registered phone is leasable within a minute
- Story 6.10: Reachability and discovery through the API
- Story 6.11: The service runs from a release, and a stop never kills an emulator
- Story 6.12: Ship the Registry and the Hub API

## Requirements & Constraints

- Registry changes (add, edit, retire), Reachability changes and prunes are each logged exactly once, with ids a consumer can resume from. Old pinned readers must skip the new event names without breaking.
- Registering mints `res-<slug>` (or `res-<slug>-<n>`) ids and locks that are never reused. A phone requires a model. Duplicate serial or UDID among live Resources is refused with the holder's id; reserved, colliding or malformed names are refused with a machine-readable reason (exit 2).
- Seeded Resources cannot be retired or have identity edited; a hub release changes them. Retired Resources keep their Hold, serve queued waiters, refuse new takes, and disappear once idle.
- `hub-device` keeps every existing command, exit code, `HUB_DEVICE_*` line and `--json` shape. It works with the API down; `registry list` reads the file from disk. Registry writes with the API down fail plainly (`HUB_API_DOWN`; `HUB_API_UNKNOWN` if the write may have applied).
- QA phone serials, UDIDs, adb ids and `allowed_users` never reach a committed file, a `registry-*` event or any API response. Tests walk every key path for a QA serial. Keys are nulled, never removed.
- A missing or unreadable `registry.json` falls back to the in-memory seed; an unreadable or unknown-format file is never written, so an older API cannot clobber newer records.
- Reachability is one enum with its age, computed on the reader's clock. A read never waits for a refresh. Only the Hub API writes `reachability` events, never the CLI. Discovery never starts or connects adb and says "no adb server" when none is running.
- API contract: loopback only (`127.0.0.1:8794`), `snake_case` JSON, `application/problem+json` errors with `code`, `exit` and `reason`, `Cache-Control: no-store`, no path prefix. Fields and routes are only ever added.
- Node 24 ESM `.mjs`, no dependencies, no Python. Tests are hermetic with injected seams (`fetchImpl`, `qaDevices`, `hostKey`, `policy`); the shared suite binds no real port and opens no real QA file. No `setInterval` or `setTimeout` loops outside the files the no-new-clock rule names.

## Technical Decisions

- **One appender (AD-9, AD-39):** `lock.mjs` stays the only `appendEvent` caller. New `noteRegistry` and `noteReachability` bypass the Queued gate. New names: `registry-add|edit|retire`, `reachability`, `host-reachability`, `prune`, `force-release`. Additive fields: `resource`, `actor: {holder, via}`, `why`. A prune writes at most 20 `prune` events per call and folds the rest into one with `count`; a log write failure is `HUB_EVENT_LOG_FAILED`, never fatal. Event id `<host_id>/<YYYY-MM>/<byte offset>` is derived on read and never written. `events.mjs` gains `readEventsFrom({month, offset})`, which returns only complete lines plus the new end offset.
- **Store (AD-27):** `<HUB_LOCK_DIR>/registry.json`, mode `0600`, `{format: 1, rev, resources, pools}`. It is written only by the Hub API, through `lock.mjs`'s exported atomic tmp-plus-rename helper, serialised in-process, with `if_rev` checks (`HUB_REGISTRY_CONFLICT`). The rename is the deciding step; at start a log that is behind gets one `registry-edit` with `reason: recovered`.
- **Identity (AD-28, AD-29):** `id` and `lock` are immutable; only `name` and Capabilities are editable. `RESERVED` and `SLUG` live in `lock.mjs` (from Epic 5). `isQueued` is decided by name, and `lock.mjs` never reads the Registry.
- **Seeding (AD-30):** at each start, one `if_rev` write, only when the derived seed differs. Seeded identity, lock, name and `deploy_target` are overwritten; Capability edits are kept. A Resource missing from `devices.json` is kept and marked `seed_missing: true`, never deleted. QA phones are imported only when the file is first created, as `dedicated_qa` (unknown ones become runtime Resources). `retired_at` is never cleared (AD-31). Redaction is by audience (`local` vs `service`).
- **Layering (AD-24, AD-25):** the Claims library is the only place that takes, refuses or retires; the API maps library errors to HTTP through the same table. The deploy path (`tools/ci/commands/*`, `tools/catchup/*`) never imports `claims.mjs`, `tools/registry/*`, `tools/hub-api/*` or `hub-client.mjs`; a conformance test enforces it.
- **Actor (AD-36):** the first front door sets `actor` once and nothing rewrites it.
- **Same-host client (AD-26):** `tools/hub-client.mjs` uses `fetch` to loopback with an injected `fetchImpl`, bounded at the wait plus 30 s. Cross-host transport is out of scope here.
- **Policy (AD-46):** `policy.json` gains strict `registry: {reachability_max_age_s: 60}` and `api: {hub_api_port: 8794, host_agent_port: 8795, stream_keepalive_s: 15, peer_connect_timeout_s: 5}` blocks. Unknown keys are refused, and `stream_keepalive_s` above 30 is refused.
- **Lifecycle (AD-45):** the singleton is the port bind (`HUB_API_ALREADY_RUNNING` on `EADDRINUSE`). The service asserts Node >= 24.15 and `heavy` on PATH, runs from `releases/<ref>` with the real `node/24.x` path, and switches only at `hosts:install`. `KillMode=mixed` is safe because emulators boot through a `heavy` spawn seam. The service holds no state beyond the lock dir (AD-23). `hub-device.test.mjs:909-941` must still pass (`install.sh` may only `daemon-reload`).
- **Contract doc:** `docs/hub-api-contract.md` has a `Status:` line with the contract version and a route table. Every route-adding story updates it, and a `node --test` contract test fails when a route or field exists in only one of code and doc.
- **Reachability (AD-35):** a reading is `{state, checked_at, age_ms_at_receipt, received_at, source}`. It is read through the read-only adb wire only (`host:version`, `host:devices-l`). At most one async refresh per host.

## Cross-Story Dependencies

- Builds on Epic 5: the Claims library, matcher (`phone` Pool), `RESERVED`, status builder with Reachability, and the in-memory seed (Story 5.5). Epic 7 (leases through the API) and later epics build on this epic's API server, contract doc and Registry.
- 6.1 comes first. Its `noteRegistry`, `noteReachability` and `readEventsFrom` are used by 6.2 (recovery event), 6.3 and 6.6/6.7 (`registry-*`), 6.10 (`reachability`), and later by the stream, replica and history.
- 6.2 (store and atomic helper) precedes 6.3 (seed writes), 6.6 and 6.7 (writes) and 6.8 (`registry list` reads the file).
- 6.4 (server, policy block, contract doc and test) precedes every route story (6.5, 6.6, 6.7, 6.10).
- 6.6 and 6.7 feed 6.8 (CLI verbs) and 6.9 (end-to-end register-then-lease test).
- 6.11 needs the API (6.4) and ships the emulator spawn seam. 6.12 ships only after 6.1 to 6.11 are on main (`mise run release -- X.Y.Z`, then `hosts:install` on big-chungus; the Mac only for the `hub-device` and `host-key` change). The release notes must say that the deploy path ignores the Registry and API.
