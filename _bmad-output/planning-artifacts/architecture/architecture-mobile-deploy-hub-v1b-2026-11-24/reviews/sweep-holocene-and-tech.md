# Sweep: the Holocene Candybar template, and tech checks for v1b

Date: 2026-11-24. Read-only sweep. Every fact below was checked against the code on disk or a fetched source.
Holocene HEAD `57c2cf5`; `apps/api/src/candybar.ts` last changed in `7d06694` (2026-11-04, HOLOC-24 N4).
Candybar contract last changed in `56f2cfd` (2026-11-11).

Paths: `H` = `~/code/33GOD/holocene`, `C` = `~/code/33GOD/candybar`, `M` = `~/code/mobile-deploy-hub`.

---

## 1. How Holocene's API module calls Candybar (`H/apps/api/src/candybar.ts`)

### 1.1 Base URL, process, registration

- Base URL: `const CANDYBAR_API_URL = (process.env.CANDYBAR_API_URL ?? "https://candybar.delo.sh").replace(/\/$/, "")` (candybar.ts:11). `live.ts:617` reads the same variable with the same default.
- Neither the unit nor `H/.env` sets `CANDYBAR_API_URL`. `H/.env` defines only `HQ_OPERATOR_TELEGRAM_IDS`, `OPENROUTER_API_KEY`, `TELEGRAM_HQ_BOT_TOKEN` and `TEST_SECRETS`; server.ts:1-2 loads it with dotenv. So in production Holocene reaches Candybar through Traefik at `https://candybar.delo.sh`, not on loopback.
- Holocene has a precedent for loopback upstreams: `DIRECTOR_API_URL ?? "http://127.0.0.1:8790"` (director.ts:7), `PJ_REGISTRY_URL ?? "http://127.0.0.1:8764"` (hub.ts:36), `PROMETHEUS_URL ?? "http://127.0.0.1:9472"` (systems.ts:9) and `CANDYSTORE_DEFAULT_URL = "http://127.0.0.1:8683"` (candystore-url.ts:5). The house style for a base URL is: an env var ending in `_URL`, a default, and a trailing slash stripped.
- Registration: `registerCandybarRoutes(app)` (server.ts:60). The signature is `registerCandybarRoutes(app: FastifyInstance, opts: { fetchImpl?: Fetch; baseUrl?: string; pingMs?: number } = {})` (candybar.ts:922). Tests inject `fetchImpl` and `baseUrl`, then use `app.inject` (candybar-actions.test.ts:147-155). The tests are hermetic.
- Framework: Fastify 5 plus `@fastify/sse` (H/apps/api/package.json). Holocene's own code is TypeScript compiled to `dist/server.js`. The hub's "no framework" rule (NFR-4) binds the Hub API, not Holocene.

### 1.2 Timeouts (candybar.ts)

| const | value | use |
|---|---|---|
| `SOURCE_TIMEOUT_MS` | 4_000 | every GET read via `getJson` (L12, L156) |
| `SCHEDULE_TIMEOUT_MS` | 10_000 | `/schedule` slices (L13, L612, L845) |
| `WRITE_TIMEOUT_MS` | 10_000 | every write via `sendJson` (L857, L884) |
| `STREAM_CONNECT_TIMEOUT_MS` | 10_000 | time to get the upstream SSE response headers; the timer is cleared after connect (L715, L1101, L1113) |
| `STREAM_PING_MS` | 15_000 | Holocene's own id-less `event: ping` between frames (L719-720) |

Every timeout is an `AbortSignal.timeout(ms)` (L161, L884). An abort is reported as `timed out after ${ms}ms` (describeError, L147-154).

### 1.3 TTL caches and stale fallback

- `LIST_TTL_MS = 10_000` covers the list, profiles, tasks, and a schedule read that errored (L14, L538, L560, L582, L601).
- `LAST_RUN_TTL_MS = 30_000` is per candybar (L15, L637). `SCHEDULE_TTL_MS = 120_000` (L19).
- Last-good copies: `lastGoodList`, `lastGoodProfiles` and `lastGoodTasks` (L488-498). They are served marked stale when a read fails. A 404 for a route means "an older upstream without it", which clears the last-good copy and leaves nothing to fall back on (`isNotFound`, L557, L574, L592).
- `inflight` lets concurrent `/list` callers share one upstream read (L499, L930-932).
- `generation` is bumped by every write. A read that began before the write does not repopulate the caches (L500-501, L519-526, L552). `invalidateAfterWrite({schedule})` runs after each successful write (L975, L997, L1005).
- `resetCandybarCache()` exists for tests (L503).

### 1.4 Field-by-field validation (allowlist projection)

- The rule is stated at L186: "Allowlists only: nothing the contract does not name reaches the browser."
- Helpers (L179-183, L245-257):
  - `isRecord`, `str`, and `num` (finite numbers only).
  - `stamp` keeps a string only if `Date.parse` accepts it; anything else is dropped.
  - `clip` cuts text at 4,000 characters. `strings` keeps at most 40 items of up to 1,000 characters each.
  - `oneOf` checks enums. `slug` matches `/^[A-Za-z][A-Za-z_-]{0,31}$/`.
- `projectDefinition` drops a row that lacks an `id`, `name` or `schedule` string or a boolean `enabled` (L190-208). Every other field gets a default.
- On writes:
  - Ids must match a `UUID` regex and are lowercased (L858, L956-959).
  - A body that is not a JSON object gets a 400 (L965).
  - Each field is typed: booleans for `noise`, `enabled` and `archived`; `parseFireTime` requires a whole-minute UTC time (L915-920); `expectDate` must match `YYYY-MM-DD` (L985); `action` must be in `STEWARD_ACTIONS` (L1028); `limit` must be an integer from 1 to 200 (L1074).
- The web types are mirrored by hand from the API module, not generated (H/apps/web/app/candybar/types.ts:1).

### 1.5 Error mapping

- Reads (`getJson`, L156-177):
  - non-2xx becomes `{ok:false, error: "HTTP <status>: <first 120 chars>"}`. The code never assumes the error body is JSON, because "a proxy in front may answer bare text" (L165).
  - A body that does not parse becomes `"response was not JSON"`.
  - A network failure becomes `err.message (cause.code)`, or the timeout text.
  - A failed read degrades one part of the payload into `warnings[]` and `source.down`; the list never fails as a whole (L445-475).
- Writes (`sendJson`, L878-898):
  - An upstream refusal becomes `{ok:false, status: <upstream status>, error: problemMessage(text)}`. `problemMessage` takes problem+json `detail`, else `title`, else a 160-character snippet (L864-876).
  - A network failure becomes status **502** with `"${baseUrl}: <reason>"`.
  - `refused()` passes the upstream status through as `{error, taskId?}` (L952-955).
- Status codes Holocene sets itself:
  - 400: Holocene's own validation.
  - 422: the date cannot be computed in the time zone (L991).
  - 409: an `expectDate` mismatch (L993).
  - 404 or 502: the definition is unknown, or the list is down (L989).
  - 502: a `/schedule` failure (L945) and a stream connect failure or upstream non-2xx (L1111, L1120).
  - A steward 409 reads the twin task back and returns it (L1034-1041).
- Browser side: `postJson` returns `{ok:false, status, error, body}`. It uses `json.error` when present, else `"<status> <statusText>"`, and status 0 for a network failure (H/apps/web/app/candybar/candybar-api.ts:17-31).

### 1.6 Writes are narrow POST-only proxies

- Every browser write is `POST /api/modules/candybar/...`, and each one forwards exactly one upstream call (L853-855, L960-968):
  - `/:id/skip`: forwarded as POST `/candybars/{id}/skip`.
  - `/:id/skip-rest-of-day`: forwarded as POST, with the date computed in the candybar's zone.
  - `/:id/noise`: forwarded as PUT or DELETE `/candybars/{id}/noise`.
  - `/:id/enabled`, `/:id/archived` and `/:id/steward`: forwarded as POST.
  - `/tasks/:taskId/cancel`: forwarded as POST `/steward/tasks/{id}/cancel` (L1053-1066).
- There is one extra GET passthrough, `/:id/tasks` (L1068-1079).
- The comments say the browser never talks to Candybar ("The Candybar API sends no CORS headers, so only this process talks to it", L7-10). Holocene never registers, edits or runs a candybar (L9-10).
- Every route sets `Cache-Control: no-store` (L928, L962).

### 1.7 SSE relay and keepalive

- Route: `GET /api/modules/candybar/schedule/stream` (L1088-1125).
  - It validates the window with `parseWindow`; a bad window gets a 400.
  - It forwards `Last-Event-ID` (or `?after=`, when the page reconnects by hand), but only if the value matches `/^[\w-]{1,64}$/` (L1092-1094, L1106).
  - It opens one upstream `fetch` per viewer with an `AbortController` (L1095-1108). The controller is aborted when the viewer's socket closes (L1097-1100), and all open controllers are aborted in the Fastify `preClose` hook (L1084-1087).
- On upstream non-2xx, the code reads the upstream reason first and aborts after; the comment notes that an aborted signal fails the body read too (L1115-1120).
- The pipe is `reply.send(withPings(Readable.fromWeb(upstream.body), pingMs))`. Its headers come from `streamHeaders(reply)`: `Cache-Control: no-cache, no-transform` and `X-Accel-Buffering: no` (event-stream.ts:19-22), plus `Content-Type: text/event-stream; charset=utf-8` (L1122-1124).
- `withPings(source, intervalMs)` (L726-760):
  - It forwards only whole frames, cut at the last `\n\n`.
  - After `intervalMs` of quiet it writes `event: ping\ndata: {}\n\n`, and only between frames. The ping has no id, so the browser's Last-Event-ID never moves.
  - An upstream error or end ends the output; an output close destroys the source.
- Why there is a ping at all (L716-718): "the Next.js rewrite drops a proxied response after 30 s without bytes, silently". Candybar's own keepalive comes once a minute, so Holocene pings every 15 s.
- Browser client (H/apps/web/app/candybar/schedule-stream.ts):
  - `SILENCE_MS = 45_000` declares a silent line dead and replaces it (L21, L40-43).
  - Backoff runs from 1 s, doubling, up to 30 s (L35, L57).
  - The page owns recovery, because "a proxy's 502 stops a browser's own retries" (L2).
  - Each reconnect passes `after=<lastId>` (L63-64).
  - It listens for the named events `ready`, `invocation.started`, `invocation.completed`, `skip.applied`, `definition.changed`, `current.advanced`, `reset` and `ping` (L11-19, L92).
- The Definitions list is not streamed. The browser polls it every 15 s with `usePoll` (candybar-app.tsx:26 `POLL_MS = 15_000`, L368; hub/hub-app.tsx:35-60, 4x slower when the tab is hidden).
- The page is down-aware. When `source.down` is set, it shows "Candybar is not answering. From the last good read: …", and when nothing was ever read it shows an empty state (candybar-app.tsx:140-142, L457, L535). `Source = {name, value?, ageSeconds?, maxSeconds?, down?, detail?}` (hub/types.ts:5).

---

## 2. Candybar's contract document and contract test

- Where it lives: in the **upstream** repo, `C/_bmad-output/specs/spec-cron-framework/holocene-view-contract.md` (77 lines). There is a second one for writes, `steward-contract.md`. Holocene's module names both in its header comment (candybar.ts:5-6). The view contract is headed "DELEGATED (owner: `holocene` repo)" and specifies only what Candybar must expose (L1-3).
- How it is versioned:
  - There is **no** URL prefix (no `/v1`) and no version header. FastAPI is built with `openapi_url=None, docs_url=None, redoc_url=None` (C/src/candybar/api/app.py:442).
  - The view contract versions by dated, additive annotations, for example "`timezone` (added 2026-10-26 …)", "`archived` (added 2026-11-03 …)", "`cost` (added 2026-11-11)" and "Wire format (added 2026-10-27 …)" (holocene-view-contract.md:23-26, 40).
  - The steward contract carries a status line, "Status: v1.2, 2026-11-04 (round-2 review fixes …). v1.1, 2026-11-03", followed by its consumers and owner (steward-contract.md:3-6).
  - Compatibility comes from route presence: Holocene treats a 404 for a route as "older Candybar" (candybar.ts:556-557).
- Base and transport, stated once (L17): REST over HTTPS at `https://candybar.delo.sh`, plus one SSE channel. All timestamps are ISO 8601 UTC. "No in-app auth in v1: access is edge-only (Traefik/Cloudflare)."
- Error envelope: `application/problem+json` with `{ type, title, status, detail }` (contract L17).
  - Code: `problem(status, title, detail, **extra)` with `type: "about:blank"` (app.py:335-346).
  - Validation errors become 422 "Invalid request body"; unknown routes speak RFC 7807 too; anything unhandled becomes 500 "Internal error" (app.py:498-514). Extra keys ride along, for example `taskId` on a steward 409.
- Health: `GET /healthz` returns `{"status": "ok"}`. It is liveness only and deliberately touches neither the database nor the bus (app.py:484-489). `/healthz` is not in the view contract. **The PRD instead fixes the hub's health as `GET /health → {ok, service}` (prd.md:341).**
- SSE wire (contract L40-61; C/src/candybar/api/stream.py):
  - The stream opens with `retry: 3000` (stream.py:105, 493), then `ready` on a fresh connect or `reset` when it cannot resume (L476-482).
  - Frames are `id: <boot>-<seq>` / `event:` / `data: <one-line JSON>` (sse_frame, L118-127).
  - Every payload carries `type`, `seq`, `key` and `at`. Every payload is absolute state, so applying it twice is harmless.
  - The replay buffer holds 1024 events (`BUFFER_SIZE`, L103), with a 1024-event cap per subscriber (L104).
  - Headers: `Cache-Control: no-cache` and `X-Accel-Buffering: no` (L107-108).
  - The keepalive `: keepalive` comment is driven by the scheduler's minute tick, not a timer (`_on_tick` broadcasts `_PING`, L300-305; L500-501).
  - Outside the client's window, row events arrive as id-only frames (L509-511).
- Contract test: `C/tests/contract_shapes.py` **parses the markdown itself**.
  - `CONTRACT` holds the file path (L17-23).
  - `_brace_fields(route)` finds the bullet that starts with `` `GET /candybars` → `` and regex-parses its `` `{ … }` `` field list into `(name, kind)` (L28-40). This yields `LIST_KEYS`, `SINGLE_KEYS` and `STREAM_DEFINITION_KEYS` (L43-50).
  - `FIELD_CHECKS` must cover exactly the key set: "a field added to the contract fails loudly here" (L66-82).
  - `assert_contract_shape(body, keys)` asserts `set(body) == keys` and checks each value (L85-88). Schedule rows get the same treatment, plus optional `?` fields and quoted unions (L96-154).
  - Further parsers pull from the contract text: the stream triggers (L170-183), noise routes and batch body (L189-212), and skip routes and bodies (L219-242).
  - Users: `tests/test_api_definitions.py` (L45-50 pins the parsed key set; L171-180 asserts list rows), `test_registry_integration.py` (the live round trip), `test_schedule_stream.py`, `test_api_noise.py`, `test_api_schedule_next.py` and others.
  - **Holocene runs no contract test of its own.** Its tests use fixture `fetchImpl` fakes.

---

## 3. Auth, and how Holocene reaches a service on big-chungus

- Auth between Holocene and Candybar: **none.**
  - The fetch sends only `accept` and `content-type` (candybar.ts:160, 882). The Candybar contract says access is edge-only (L17).
  - Candybar's Traefik router labels are `traefik.http.routers.candybar.rule=Host(candybar.delo.sh)`, entrypoint websecure, TLS, port 8700, with **no `middlewares` label**, so it has no google-auth (`docker inspect candybar`). Candybar also publishes `127.0.0.1:8700->8700` and sits on `bloodbank-network`.
- The people gate is at the web container only. The `holocene-web` router has `middlewares=google-auth@file` (H/compose.yml:31). `/hq` and `/_next/static` bypass it at priority 350 (compose.yml:36-48).
- Process topology:
  - **holocene-api is a host process, not a container.** It runs as `systemd --user` unit `~/.config/systemd/user/holocene-api.service` with `Environment=HOST=0.0.0.0` and `PORT=4000`, and `ExecStart=…/mise/installs/node/latest/bin/node …/apps/api/dist/server.js`. That Node is **v26.13.0**.
  - `ss -ltnp` shows `node-MainThread` on `0.0.0.0:4000`. server.ts:557-558 uses `PORT ?? 4000` and `HOST ?? "0.0.0.0"`.
  - It runs as user `delorenj`. So do all GitHub runners (`Runner.Listener` processes under `/home/delorenj/actions-runner/*`).
  - `holocene-web` is the container (`node:22`) on the `proxy` network, with `extra_hosts host.docker.internal:host-gateway` (compose.yml:2-20, 49-51). Its Next rewrite sends `/api/modules/:path*` to `${HOLOCENE_API_INTERNAL_URL ?? "http://localhost:4000"}/api/modules/:path*` (H/apps/web/next.config.mjs:2, 26-28). Compose sets that URL to `http://host.docker.internal:4000` (compose.yml:18).
- **Conclusion:** a Hub API that listens only on `127.0.0.1:<port>` on big-chungus **is reachable** from Holocene's API process. They share the host, the network namespace and the user. The browser path is browser → Traefik (google-auth) → holocene-web (Next rewrite) → host.docker.internal:4000 (holocene-api) → 127.0.0.1:<hub>. No container needs to reach the Hub API.
- The Mac cannot reach big-chungus loopback. The Mac has an ssh alias `Host big-chungus` in its `~/.ssh/config` and a direct tailnet path to big-chungus (100.66.29.76). Today big-chungus reaches the Mac with `ssh hub-mac` over `tailscale nc` (M/tools/hosts.mjs:4, 88-90; `~/.ssh/config:48-51`). See "conflicts" below.

---

## 4. Module id, route prefix and navigation conventions

- API routes are `/api/modules/<id>/…`. The ids in use are `transcripts`, `candybar`, `genesis`, **`hub`**, `hooks`, `products`, `hermes-fleet`, `tooling`, `systems`, `avatars`, `live`, `artifacts`, `voice`, `wax`, `org`, `director` and `containers` (grep over H/apps/api/src). **`/api/modules/hub` is already taken** by Holocene's own agents, projects and voices (server.ts:391, 395; agent-voices.ts:192-210). The web shell directory is also `app/hub/`. The mobile-deploy-hub module must not use the id `hub`.
- Candybar's routes: `GET /api/modules/candybar/list`, `GET …/schedule?from&to`, `GET …/schedule/stream?from&to[&after]`, `POST …/:id/<action>`, `POST …/tasks/:taskId/cancel` and `GET …/:id/tasks?limit` (candybar.ts:927-1125).
- The Next rewrite proxies every `/api/modules/*` path (next.config.mjs:26-28), so a new module needs no rewrite change.
- Page: `H/apps/web/app/candybar/page.tsx` sets `metadata.title "Holocene · Candybar"` and renders `<CandybarApp/>`. The app wraps itself in `<HubShell current="candybar">` (candybar-app.tsx:490).
- Navigation (H/apps/web/app/hub/navigation-model.ts):
  - `NavItem = { id, label, href, icon: IconName }` (L2). The "system" group is `candybar`, `settings`, `mini`, `hooks`, `legacy` (L21-27).
  - `IconName = keyof typeof PATHS` (nav-icons.tsx:25), so a new item needs a new `PATHS` key or must reuse one (`candybar` is at L14).
  - The test asserts that a list of hrefs exists and that ids are unique (navigation-model.test.ts:4-10). A new item should be added to that href list.
- Holocene has **nothing** for mobile-deploy-hub yet. A grep for `mobile-deploy`, `hub-device` and `deploy-hub` over apps, packages and services finds nothing, and the git log has no such commit. The hub repo has no HTTP server yet either (no `node:http` or `createServer` under M/tools).

---

## 5. Tech verification (web, with URLs)

### 5.1 Node.js 24 LTS

- The newest v24 release is **v24.22.3** 'Krypton' (LTS), a security release dated 2026-11-10 in `https://nodejs.org/dist/index.json` and 2026-11-11 in `CHANGELOG_V24.md:79`. Its previous patches were 24.22.2 (2026-10-28) and 24.22.1 (2026-10-21) (`https://raw.githubusercontent.com/nodejs/node/v24.x/doc/changelogs/CHANGELOG_V24.md`).
- Status: 24.x is **Maintenance LTS**. Active LTS started 2025-10-28, maintenance started 2026-10-20, and end of life is 2028-04-30. 26.x is **Active LTS** ('Lithium', since 2026-10-28, EOL 2029-04-30). Source: `https://github.com/nodejs/Release` (schedule table).
- Installed versions:
  - big-chungus has mise node 20.20.2, 22.22.2, 24.6.0, 24.15.0, 26.4.0, 26.5.0 and 26.13.0.
  - **The global mise pin is 24.6.0** (`mise ls node`: `24.6.0 ~/.config/mise/config.toml`). `node --version` in M shows v24.6.0.
  - The repo pins `node = "24"` only inside tasks (M/mise.toml:77, 129, 141).
  - hub-mac (macOS 26.7.3) has mise node 24.15.0, 25.9.0 and 26.7.0, plus Homebrew node 26.13.1 at `/opt/homebrew/bin/node`. There is no `node` on the non-interactive ssh PATH.

### 5.2 `fs.watch(dir, {recursive: true})`

- Linux: recursive support was added in **v19.1.0** ("Added recursive support for Linux, AIX and IBMi", nodejs/node#45098). Source: `https://raw.githubusercontent.com/nodejs/node/v24.x/doc/api/fs.md` lines 5248-5250 (fs.watch YAML history). The rendered page is `https://nodejs.org/docs/latest-v24.x/api/fs.html#fswatchfilename-options-listener`.
- Implementation: in Node 24 `lib/fs.js` (watch, ~L2599-2614), `if (options.recursive && !isMacOS && !isWindows)` uses the **non-native JS watcher** `internal/fs/recursive_watch`. That watcher keeps one watch per directory and per symlink, using inotify on Linux. macOS and Windows go native. Source: `https://raw.githubusercontent.com/nodejs/node/v24.x/lib/fs.js` and `.../lib/internal/fs/recursive_watch.js` (L60-72).
- Availability (fs.md 5323-5337): Linux uses `inotify(7)`. macOS uses `kqueue(2)` for files and **FSEvents** for directories. Network filesystems and Docker host mounts are unreliable.
- Caveats (fs.md 5348-5369): the watch follows the inode, so a deleted and recreated path is not seen. `filename` may be `null` and needs a fallback.
- Version-gated options:
  - `ignore` arrived in **24.14.0** (CHANGELOG_V24.md:2312/2320).
  - `throwIfNoEntry` for fs.watch arrived in **24.16.0** (fs.md:5245-5247).
  - The Linux fallback was changed to "watch directories, not files" in **24.22.0** (CHANGELOG_V24.md:197/332).
  - The installed 24.6.0 and 24.15.0 lack some of these: 24.6.0 has neither option, and 24.15.0 lacks `throwIfNoEntry`.
- Host limits on big-chungus: `fs.inotify.max_user_watches = 2097152` and `max_user_instances = 1024`.

### 5.3 SSE served from `node:http` with no library

- The format needs only `Content-Type: text/event-stream` and `event`/`data`/`id`/`retry` lines. A line starting with `:` is a comment that "can be used to prevent connections from timing out". Source: `https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events`.
- The HTML spec adds three rules (`https://html.spec.whatwg.org/multipage/server-sent-events.html`):
  - `Last-Event-ID` reports the last id on reconnect.
  - Legacy proxies drop idle connections, so send "a comment line … every 15 seconds or so".
  - HTTP 204 stops reconnection. A status other than 200, or a Content-Type other than `text/event-stream`, fails the connection.
- What node:http provides (`https://raw.githubusercontent.com/nodejs/node/v24.x/doc/api/http.md`):
  - `response.flushHeaders()` (L2170) and `response.write()` (L2508).
  - `server.timeout` defaults to **0, no socket inactivity timeout**, since v13 (L1967-1977).
  - `server.requestTimeout` (300 s by default) covers only *receiving* the request (L1902-1923), so it does not cut a long response.
  - `server.close()` leaves in-flight responses open (L1738-1755), so shutdown needs `server.closeAllConnections()` *after* `close` (since v18.2.0, L1776-1789).
- MDN adds that browsers allow only 6 SSE connections per domain without HTTP/2.
- Candybar (FastAPI StreamingResponse) and Holocene (Fastify) both stream with plain headers, so neither adds anything the hub would need a library for.

### 5.4 `adb track-devices` / `host:track-devices`, and `-L tcp:…`

- The service exists. `docs/dev/services.md:24-32` lists `host:track-devices`, `-proto-binary` and `-proto-text`: "variants of host:devices which doesn't close the connection. Instead, a new device list description is sent each time a device is added/removed or the state of a given device changes." Source: `https://android.googlesource.com/platform/packages/modules/adb/+/refs/heads/main/docs/dev/services.md`.
- The CLI wraps it: `adb track-devices [-l][--proto-text][--proto-binary]` becomes `host:track-devices` / `host:track-devices-l` / `-proto-text` / `-proto-binary`, and calls `adb_connect_command(query)` (client/commandline.cpp:2142-2158).
- Server behaviour (transport.cpp, `https://android.googlesource.com/platform/packages/modules/adb/+/refs/heads/main/transport.cpp`):
  - The current list is sent **immediately on connect** (L667-675).
  - The full list is sent again on every `update_transports()` (L713-721).
  - Each message is a 4-hex-digit length plus the list (L655-665).
  - **If the client writes anything after the request, the server closes the tracker** (L649-652).
- Does `-L tcp:127.0.0.1:<port>` start a server? Sources: `client/adb_client.cpp` and `socket_spec.cpp`, both under `https://android.googlesource.com/platform/packages/modules/adb/+/refs/heads/main/`.
  - `tcp_host_is_local(h)` is `h.empty() || h == "localhost"` (socket_spec.cpp:155-158). `is_local_socket_spec` uses it for `tcp:` specs (L170-184). So `tcp:127.0.0.1:5037` is **not local**.
  - In `__adb_check_server_version`, a connect failure (`fd == -2`) on a non-local spec prints `* cannot start server on remote host` and returns false. **No server is started** (adb_client.cpp:254-261). A local spec prints `* daemon not running; starting now` and launches one (L262-281).
  - **Caveat:** if a server *is* running and its version differs from the client's, the client prints "adb server version (%d) doesn't match this client (%d); killing...", calls `adb_kill_server()` and does `goto start_server`, **whatever the spec** (L311-336). The non-local guard covers only the "no server" case.
  - Today both adb clients report `Android Debug Bridge version 1.0.41`: the SDK's `~/Android/Sdk/platform-tools/adb`, which is 37.0.0 (`~/.local/bin/adb` links to it), and the distro's `/usr/bin/adb`, which is 34.0.5-debian. So both use server protocol 41 and no mismatch occurs. The 5037 server's exe is the SDK binary.
  - Live servers: `adb -L tcp:5037|5041|5043|5055|5093 fork-server server` (ps).
- The hub already speaks the wire protocol with a raw socket, in `M/tools/device/adb-wire.mjs`:
  - `createAdbWire(port, {signal})` provides `version()` (`host:version`), `devices()` (`host:devices`), `registerEmulator(adbPort)` and `shell(serial, cmd)` (L66-79), over `node:net` to `127.0.0.1` (L15).
  - Its header (L1-4) says: "a socket never starts anything".
  - `exchange()` resolves only on socket close (L52-55). A long-lived track-devices stream therefore needs a new streaming function in this module, not a reuse of `exchange`.
  - The hub's existing comment matches the source check: "`-L` refuses to launch a server (adb treats only `localhost` or an empty host as a local server spec …)" (M/tools/ci/lib/adb.mjs:75-77). The same claim appears in the v1a spine (ARCHITECTURE-SPINE.md:254).
  - `hub-device status` already refuses to query when no server is running (`phonePresence`, M/tools/device/hub-device.mjs:516-527, using `HUB_ADB_SERVER_PORT || 5037`).

---

## 6. Seams, risks and gaps for v1b (summary; detail in the structured return)

- Seams:
  - Holocene module `H/apps/api/src/<id>.ts`, cloned from candybar.ts, with `register<Id>Routes(app, {fetchImpl, baseUrl, pingMs})` and a line in server.ts.
  - Page at `H/apps/web/app/<id>/`, plus a NAV_GROUPS "system" item, a nav icon and a nav test href.
  - Hub side: track-devices goes into `adb-wire.mjs`.
  - The contract document and its markdown-parsing contract test live in the hub repo, after Candybar's `contract_shapes.py`.
- Risks:
  - Module id collision with `hub`.
  - Env var naming: `HUB_*` collides with `HUB_REDIS_URL` in Holocene.
  - Keepalive cadence against the 30 s Next drop.
  - Error envelope: problem+json or `{error}`.
  - Path versioning: `/v1` or none.
  - Health shape: `/healthz` or `/health`.
  - Board liveness: a 15 s poll or SSE (FR-24 needs ≤2 s).
- Gaps:
  - NFR-6 says loopback only, but the Mac Host Agent must push to the Hub API.
  - adb version-mismatch kill.
  - Discovering an adb server that comes up later, without polling (NFR-3).
  - The global Node pin is 24.6.0, which lacks the newer fs.watch options.
