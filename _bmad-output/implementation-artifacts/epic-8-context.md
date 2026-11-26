# Epic 8 Context: See every hold and waiter live

<!-- Generated from planning artifacts. Regenerate with compile-epic-context if planning docs change. -->

## Goal

The read half of the Hub API contract: one status document and one change-driven stream that show every Resource's Reachability, Hold and Queue, plus a service that can be restarted at will without losing anything. It lets Holocene's future board (v1c) and agents read one document instead of recomputing queues, and it makes deploying the service safe for running deploys. Until Epic 9, the document holds one host (`linux`); Epic 9 adds the Mac's view without changing a key.

## Stories

- Story 8.1: One status document from the API
- Story 8.2: Reads and waits never block the event loop
- Story 8.3: Live Reachability from one adb socket
- Story 8.4: One stream on the Candybar wire
- Story 8.5: A change reaches subscribers within two seconds
- Story 8.6: A restart loses nothing
- Story 8.7: Ship the live status

## Requirements & Constraints

- `/status` shows each Resource's Reachability, current Hold (Claimant, kind, why, since, expected end, expiry) and Queue (position, Claimant, since, Reservation or queued request). Deploy targets are visibly marked. A waiting Pool request is listed once.
- A change from any process (`hub-device`, a deploy job, the service) reaches stream subscribers within 2 s. Keepalive at least every 30 s, owned by the open connection.
- Anything that passes with time (Hold expiry, grace end, staleness) is derived from `now` by every reader, including at serialisation. No event or frame is ever emitted for a change only time causes.
- Reads answer in under 200 ms from the in-memory snapshot, including on a month of fixture events. An uncontended local `POST /leases` stays under 1 s. A Reachability reading older than 60 s is refreshed on request and shown with its age, never as current.
- No new clock: no `setInterval` outside `stream.mjs`, `hub-client.mjs` and `lock.mjs`, and no recurring work.
- QA privacy: for the `service` audience, `serial`, `udid`, `adb_id` and `device.serial` of a `dedicated_qa` Resource are `null` (keys are never removed). Tests walk every key path of `/status` for a QA serial.
- Fields and routes are only added, never removed or renamed. Responses are `Cache-Control: no-store`; loopback only, `snake_case`.
- Restart safety: no Lease, Job Hold, Reservation or Registry entry is lost, and emulators the service started keep running.
- Tests are hermetic: fake clock, fake response, fake socket and watcher via seams. Node 24 ESM `.mjs`, no dependencies.

## Technical Decisions

- **One status builder (AD-41):** `statusView(hostKey, {audience: 'service', qa_ids})` in the Claims library renders a host's view from disk. `/status` is `{format, contract, hosts: {<host key>: <view>}, registry, stale, checked_at}`, each view embedded unchanged. Registry fields (names, Capabilities, retired and `seed_missing` visibility) appear only under `/status.registry`. `qa_ids` come from `registry.json`. The API never recomputes a queue position or ETA: `queueView` and `eta.mjs` own that (AD-6, AD-18). A Hold gains additive `expected_end` from `eta.mjs`, never later than `expires_at`.
- **`hub-device status` on big-chungus** adds remote hosts from `/status` when the API answers, otherwise lists them `unavailable`. It stays read-only.
- **Event-loop discipline (AD-44):** `/proc` scans, emulator `inventory()`, adb queries, `provision` and service-side wait loops (`acquireLease`, `poolRequest`) run in a `node:worker_threads` worker or use the cached process-start seam (one read per pid per pass, shared). The main thread never calls `spawnSync` or `execSync`; a conformance test scans `tools/hub-api/*.mjs` and `tools/host-agent/*.mjs`. A test injects a 200 ms-blocking `processStart` and asserts `/status` still answers in time.
- **Reachability (AD-35):** one enum `reachable | unauthorized | offline | absent | unknown`, mapped in `reachability.mjs`. The Hub API holds one `host:track-devices-l` socket through `adb-wire.mjs` `trackDevices` on the hub's adb server port; it never starts a server. While open, readings are `source: track`. On close it writes one `reachability` event (`reason: track-lost`) per Resource, falls back to `source: probe`, and reopens only on the next read or request, never by timer. Track updates go through `noteReachability` and update the cache for every reader. A read returns the cached reading and never waits for a refresh.
- **Stream (AD-43), Candybar SSE wire:** `retry: 3000`, headers `text/event-stream`, `no-store`, `X-Accel-Buffering: no`. Frame `id: <boot>-<seq>` matches `^[0-9a-f]{12}-[0-9]+$` (12 hex boot minted at start, `seq` from 1); one-line JSON with `type`, `seq`, `key`, `at`. Types: `ready` (new connection, whole `/status`), `status` (whole document, absolute), `event` (one Event Log line with its id; clients dedupe on it), `reset` (`reason: unresumable`, whole `/status`; the client then refetches `/history`). Ring of the last 1024 frames per boot; exact resume replays strictly after `Last-Event-ID`. A `: keepalive` comment goes out after `api.stream_keepalive_s` idle, cleared with the connection.
- **Change sources:** `fs.watch` via the `watchImpl` seam on the lock dir, `emulators/`, each `<name>.lock`, `<name>.queue`, `<name>.reservations` and the event dir. The parent's notification re-arms watches on create or replace. Filenames from the OS are never trusted; any notification schedules one re-read after a trailing debounce of at most 250 ms, emitting a `status` frame plus `event` frames via `readEventsFrom`.
- **Restart (AD-23, AD-37, AD-45):** disk (lock dir, `registry.json`) is the only state; services are stateless. On `SIGTERM`, open waits get `503 HUB_API_RESTARTING` with `retry: requeue`; after a crash `hub-client` treats a connection reset during a wait as `requeue`. A second API exits `HUB_API_ALREADY_RUNNING` on `EADDRINUSE`. The unit uses `KillMode=mixed` plus the `heavy` scope so emulators survive. A new boot id makes an old `Last-Event-ID` get `reset`.
- **Contract doc:** `docs/hub-api-contract.md` lists `/status` and `/stream` with exact key sets, and the contract test asserts those key sets against handler output.

## Cross-Story Dependencies

- 8.1 is the base. 8.2 hardens its read path; 8.4 and 8.5 reuse the `/status` document as stream payload; 8.3 feeds the cached readings that `/status` serves.
- 8.6 builds on Story 7.2's `SIGTERM` handler and Story 6.11's `heavy` scope. 8.7 ships 8.1 to 8.6: `mise run check` on Node 24 and 26, `mise run release -- X.Y.Z`, `hosts:install` on big-chungus, live `curl -N 127.0.0.1:8794/stream` verification.
- Builds on Epics 5 to 7 (Claims library, `lock.mjs`, Registry, Event Log, Hold routes). Epic 9 later adds the Mac host to `hosts` through the Host Agent's own `/status` and pushes, without changing a key. The deploy path never depends on any of this (AD-25).
