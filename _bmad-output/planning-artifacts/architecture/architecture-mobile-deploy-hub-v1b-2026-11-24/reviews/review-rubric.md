# Rubric review: Architecture Spine v1b (AD-23..AD-49)

**Verdict: REVISE (targeted), then start epics.** The spine is in good shape. The layering, the one-owner rules, the Registry and Pool model, and the push contract (AD-49) hold up, and the adversary and reconcile fixes landed cleanly. Most brownfield claims check out against the code. The problems cluster in the newest wiring. AD-37 and AD-48 contradict each other on the HTTP shape of a waiting `POST /leases`. The `ssh … curl` transport line cannot deliver what AD-37 and AD-48 promise. The route table is closed but three ADs need routes it lacks. Some rules (host key, track-fed Reachability, Registry rollback) leave a real fork for builders. Totals: 1 critical, 7 high, 11 medium, 6 low. None of these repeats a finding from `review-adversary.md` or `review-reconcile-inputs.md`.

Method: each AD Rule was checked for enforceability and against its own Prevents line. Inherited v1a ADs AD-1..AD-22 were read in the v1a spine. The brownfield code was spot-checked: `lock.mjs` (`QUEUED`, `isQueued`, `DEPLOY_TARGETS`, `RESERVABLE`, `staleness`, `ticketStaleness`, `poolRequest`, `releaseReservation`, `jobLeaseId`), `events.mjs` (month file by `ts`, `O_APPEND`, 4 KiB), `hub-device.mjs`, `emulator.mjs` (`hostPool`, `provision`, `REAPER`, `recordsDir`), `tools/catchup/units/install.sh`, `tools/hosts.mjs`, `policy.json`/`policy.mjs` (strict) and `devices.json`. `qa-devices.json` was not read.

**Ratified correctly (spot checks):** `QUEUED` and `isQueued` extend by name (lock.mjs:30-31). `DEPLOY_TARGETS` and `RESERVABLE` are both `adb, mac-ios` (:366, :546). `releaseReservation` already takes `key` (:644). Job and hub-job tickets both get a `job:` id (:468), so AD-38's `job:` refusal covers the catch-up. `hostPool` precedence is env, then file, then 2 (emulator.mjs:60-69). Emulator boot holds the slot and gate under the provisioning pid (:503, :523), which matches AD-37's orphan reap. `devices.json` `mac.host: hub-mac` and `linux.host: big-chungus` match AD-26 and AD-47. install.sh runs only `daemon-reload` on Linux and has a Darwin branch (:53-75). `hosts.mjs` collects step failures and throws at the end (:63, :126). The policy parser is strict (policy.mjs:15). v1a AD-9 already lists `prune` and `force-release` in its deciding-step table.

---

## CRITICAL

### C1. AD-37 and AD-48 contradict each other on a waiting `POST /leases`
- **Where:** AD-37 ("its request id is sent in the `X-Request-Id` response header, flushed before the wait begins"; "a Hold granted after the socket was destroyed, before the status line was written, is released at once"; "On `SIGTERM` the service answers every open wait `503 HUB_API_RESTARTING`"). AD-48 ("the server mints it and sends it in `X-Request-Id` before the wait begins"). AD-42 (problem+json carries `status`).
- **Problem:** HTTP cannot flush a header before the status line. Once `X-Request-Id` is flushed, the status line (`200` or `202`) is already on the wire. That breaks three things:
  - The "before the status line was written" release-at-once rule can never fire.
  - The SIGTERM `503` is impossible.
  - A wait that times out cannot answer `409` busy (exit 76), and one that finds the device away cannot answer `503` (exit 75).
  Builder A flushes early and must invent an in-body outcome protocol (NDJSON, trailers). Builder B never flushes early, so the id stays unknowable. The CLI exit mapping, the contract test and Holocene all depend on which one wins.
- **Fix:** In AD-48, replace the server-mint sentence with: "A `POST /leases` with `wait > 0` must carry a client-minted `id` (the v1a Lease id format). `hub-client` and `hub-device` always mint one with `newLeaseId()`. The server writes nothing until the outcome, so the status line *is* the outcome (200 held, 409 busy, 503 away or restarting), and `X-Request-Id` echoes the id on that final response. A server-minted id is allowed only for `wait: 0`." In AD-37, delete "flushed before the wait begins (AD-48)" and keep the status-line rule unchanged.

---

## HIGH

### H1. `ssh -T … curl` never shows the far end a disconnect, and a sleeping Mac hangs the near end (AD-26, AD-37, AD-48)
- **Problem:** AD-37 says "if the ssh leg dies, the far end sees its client disconnect". With `ssh -T` there is no pty, so the remote `curl` gets no SIGHUP when the session drops. sshd only closes its pipes. curl has already read its body from stdin and does not watch stdin again. It keeps its loopback connection to the Host Agent open until the response arrives or `--max-time` (wait + provision + 30 s) runs out.
  - The Host Agent sees a live client, so the ghost waiter keeps its place.
  - If the wait is served, the status line goes to curl, the Hold stands (AD-37), and curl's write then fails. The result is a `mac-ios` Lease granted to nobody that blocks iOS deploys for up to its 60 min cap. That is exactly what AD-37 says it prevents.
  - On the near side, the template has no `ConnectTimeout` (AD-35 names `peer_connect_timeout_s` but not where it goes) and no `ServerAliveInterval`. A Mac that sleeps mid-forward (NFR-8) leaves big-chungus's ssh hanging until TCP gives up.
- **Fix (AD-26):** "A cross-host call runs `ssh -T -o BatchMode=yes -o ConnectTimeout=<api.peer_connect_timeout_s> -o ServerAliveInterval=5 -o ServerAliveCountMax=3 <alias> <abs mise node/24> <peer share>/current/tools/hub-client.mjs relay <method> <path>`. The relay reads the JSON body from stdin, sends it to `127.0.0.1:<port>` and aborts that request when its stdin reaches EOF (the ssh session died). It writes the status line, the headers and the body back on stdout. `hub-client` kills its ssh child at curl-equivalent `max-time + 10 s`." Add a test with an injected `sshImpl` that closes stdin mid-wait and asserts a `cancel` event on the far side.

### H2. The curl template cannot carry the contract (AD-26 vs AD-42, AD-48)
- **Problem:** `curl -sS --max-time <s> -X <method> URL` "with the JSON body on stdin" is missing three things:
  - It sends no body, because there is no `--data-binary @-`.
  - It sets no `Content-Type`.
  - It prints only the body. There is no `-i` or `-w '%{http_code}'`, and without `--fail` curl exits 0 on any 4xx or 5xx.
  So `X-Request-Id`, the HTTP status and `Retry` information are lost on every forward. `hub-client` would have to guess success from the body's shape, and two builders will add different flags.
- **Fix:** This is solved by H1's relay, which returns the status line and headers. If raw curl stays, pin the full line in AD-26: `curl -sS -i --max-time <s> -X <method> -H 'Content-Type: application/json' --data-binary @- http://127.0.0.1:<port><path>`. Also add: "`hub-client` parses the status line and headers from `-i` output and maps them exactly as a same-host `fetch` would. A contract test runs one route through both transports and compares status, headers and body."

### H3. The route table is closed, but three ADs need routes it lacks (AD-42 vs AD-40, AD-37, AD-45)
- **Problem:** AD-42 says the contract "lists exactly these routes", and the Host Agent serves only "the same write routes and `/status`". Three ADs need more:
  - AD-40: "a history request that needs a reachable host pulls the missing range first". There is no Host Agent route that returns event lines, and AD-49 says the agent *sends* only `POST /agent/push`.
  - AD-37: "the client can fetch it by id". There is no `GET /leases/<id>`.
  - AD-45: `hosts:install` "reads `/health` back from both services", but the Host Agent does not serve `/health`.
  Each builder must either break AD-42 by adding a route or leave the other AD unbuildable.
- **Fix:** Add rows to AD-42: `GET /leases/<id>` (a Hold or waiting ticket by id, body carries `resource`) | FR-10. On the Host Agent only: `GET /health`, and `POST /agent/sync {replica: {<month>: size}}`, which makes the agent push from those sizes now and answers when the push is acked. Then AD-40 reads "pulls the missing range first by calling the Host Agent's `/agent/sync` with the replica sizes".

### H4. On the Mac, `statusView` has no Registry to walk, and slots beyond one door's pool size are invisible (AD-41 vs AD-32, AD-33)
- **Problem:** AD-41 says `statusView` "walks every Registry lock on that host". AD-32 says only big-chungus reads `registry.json`. So the Host Agent snapshot and the Mac `hub-device status` have no source for the Registry's Mac locks. Builders can pick the seed only, an ssh call to the API (which breaks "works with no service up"), or a disk walk, and each produces a different snapshot.
  - The same fork exists for emulator slots. A CLI with `HUB_EMULATOR_POOL=4` can hold `emulator-3` and `emulator-4`, while a service sized 2 walks only slots 1 and 2. A held slot then disappears from `/status`.
- **Fix (AD-41):** "`statusView` walks what is on disk, never a Registry it cannot read. That means the seed's locks for that host, every `res-*` and `emulator-<n>` (`1..MAX_POOL`) lock, queue or reservations dir present in that lock dir, the gate and the v1a set. `resource` is filled from the lock (a runtime id equals its lock, AD-28; seeded ids from the seed). It never calls a service. The Hub API puts Registry fields (name, capabilities, `retired_at`, `seed_missing`) only under `/status.registry` and never edits an embedded view."

### H5. Track-fed readings age out: utilisation turns stable phones `unknown` and `/status` shows them `stale` (AD-35 vs AD-40)
- **Problem:** AD-35 appends a `reachability` event only "on each change", and stores readings with `checked_at`. AD-40 says "a reading holds until `checked_at + reachability_max_age_s`, after which time counts as `unknown`".
  - On big-chungus, `host:track-devices` reports only changes. A phone that sits `reachable` for three hours produces one event, so utilisation counts it `unknown` after 60 s.
  - In `/status`, its reading goes `stale` after 60 s even though a live subscription is vouching for it, and every read then starts a refresh.
  Nothing says whether a live track socket keeps a reading current, or who reopens the socket when the adb server restarts (deploy jobs restart it). One builder bumps `checked_at`, another lets it age, a third polls.
- **Fix (AD-35 and AD-40):** "On big-chungus the Hub API holds one `host:track-devices-l` connection to the hub's server port. While it is open, its readings are current (`source: track`, `stale` false), and their age counts from the socket's close. When the socket closes (server gone) the API appends one `reachability`, `reason: track-lost`, for each tracked Resource. It reopens the socket only on the next read or request that needs a reading, never on a timer and never by starting a server. In `history.mjs`, a `track` reading holds until the next `reachability` event for that Resource; the `checked_at + max_age` rule applies only to on-demand readings (the Mac)."

### H6. A corrupt or newer-format `registry.json` gets overwritten by the seed write (AD-27, AD-30 vs AD-28)
- **Problem:** AD-27 covers a missing file and an unknown `format`, which both fall back to the in-memory seed. It does not cover a file that fails to parse. It also does not say whether the start-up seed write ("only when the derived seed differs") may run against a file it cannot read.
  - On a rollback, `hosts:install` of an older ref puts an older Hub API in front of a `format: 2` file it cannot read. That API compares the seed with an empty set and writes the seed over the file.
  - This loses every runtime Resource and every retired record. `res-<slug>` ids then become free again, which breaks AD-28's "ids and locks are never reused" and attaches old Event Log history to new Resources.
- **Fix (AD-27):** "A `registry.json` that fails to parse, or carries an unknown `format`, is never written. Readers use the seed fallback with one `HUB_REGISTRY_FORMAT` warning. The Hub API refuses every Registry write, the start-up seed write included, with `HUB_REGISTRY_FORMAT` (409, exit 1) until the file is readable again. `/health` reports `registry: unreadable`." Add a test with a `format: 2` file: start the API and assert the bytes are unchanged.

### H7. `hostKey()` by `process.platform` does not stop a door deciding it is local when it is not (AD-47; Deferred)
- **Problem:** AD-47's Prevents line includes "a front door deciding it is local when it is not". But `hostKey()` maps `linux` to `linux` and `darwin` to `mac`:
  - Any other Linux machine running `hub-device` (a dev box, a second runner host) believes it is big-chungus and acts in-process on its own lock dir. That is the AD-25 violation.
  - Any other Mac believes it is the Mac.
  - `devices.json` host blocks declare no OS (they carry `host`, `peer`, `staging_dir` and so on), so "the key whose block declares that OS" names a field that does not exist. One builder hardcodes the mapping; another adds `os` and must change the strict `devices.mjs` parser.
  - Deferred says "the design takes any `devices.json` host block (AD-47)". Platform mapping supports at most one host per OS, so that claim is false.
- **Fix (AD-47):** "`hostKey()` reads `~/.config/mobile-deploy-hub/host-key` (`linux` or `mac`), which `hosts:install` writes on each host it installs, behind the `hostKey` seam. A missing or unknown key is `HUB_HOST_UNKNOWN` (exit 1), and a key whose OS disagrees with `process.platform` is the same error. `devices.json` is unchanged." In Deferred, change "takes any host block" to "takes one host per host key; a second host needs a hub release and a new key".

---

## MEDIUM

### M1. The AD-19 row says "no timers, no polling", which contradicts AD-43, AD-44 and v1a AD-19's literal rule (inherited table, AD-43)
v1a AD-19 says "the only in-process interval is a holder touching `<name>.lock/alive`". v1b adds three timers:
- the per-connection keepalive interval (AD-43);
- the 250 ms debounce timers (AD-43);
- `lock.mjs`'s own sleep-loop waits running inside services (AD-44 names them).

AD-43 sidesteps this by saying the keepalive "is not a recurring job under AD-19", while the inherited row states the opposite ("no timers, no polling"). This weakens an inherited AD without saying so. A strict builder may also reject the wait loops.
**Fix:** In the inherited row, write: "Services add no clock. Allowed in-process timers are exactly: v1a's `alive` touch, a request-bound `lock.mjs` wait loop, one keepalive interval per open stream connection and one-shot debounce timeouts. Each is cleared with its request or connection. Nothing else may call `setInterval`." Add a conformance test that greps `tools/hub-api` and `tools/host-agent` for `setInterval` outside `stream.mjs`.

### M2. The SSE `<boot>` format is undefined, and Holocene drops ids that are not `[\w-]` (AD-43)
`sweep-holocene-and-tech.md:93` shows Holocene forwards `Last-Event-ID` only if it matches `/^[\w-]{1,64}$/`. If a builder makes `<boot>` an ISO time, its colons and dots fail that check, so every reconnect becomes a `reset` and a full refetch.
**Fix:** "`<boot>` is the service start in base-36 milliseconds. The frame id `<boot>-<seq>` matches `/^[\w-]{1,64}$/`."

### M3. Event lines can land in a month the agent has already left (AD-49, AD-39 vs events.mjs)
`appendEvent` picks the file by `record.ts.slice(0, 7)` (events.mjs:88). `lock.mjs` passes `now: () => at`, with `at` captured before the deciding step. An event decided at 23:59:59.9 and appended after midnight therefore goes to the *old* month file. AD-49's "a push never spans two months (oldest month first)" lets a builder treat older months as closed, and those late lines then never reach the replica.
**Fix (AD-49):** "No month is ever closed. On every trigger the agent compares each source month file's size with the replica sizes from the last ack, and pushes the oldest month that differs."

### M4. Forwarding edge cases left open (AD-48)
1. "`retired_at`, which only the Hub API stamps" conflicts with AD-32's direct forward from `hub-device` on big-chungus while the API is down. That record comes from `registry.json` on disk, with a real `rev`, and nobody from the API stamped it. One Host Agent refuses it; another accepts it.
   **Fix:** "stamped by whichever big-chungus door read `registry.json`".
2. "A repeat of an `id` that the same holder … waits with returns the existing state with `200`" does not say whether the retry joins the wait or returns at once while the ticket still waits.
   **Fix:** "a repeat whose id is still waiting takes over that wait. The older connection gets `409 HUB_LEASE_SUPERSEDED` and its abort is not treated as a cancel".
3. "Release, cancel and extend bodies carry `resource`" does not say what a Pool request's cancel carries.
   **Fix:** "a Pool request's cancel carries `pool` and its host key; the receiver withdraws from every member (AD-33)".

### M5. An API phone Lease skips `findPhone`, but what it returns is undefined (AD-36 vs AD-13, AD-17)
The CLI's `lease s26` exports come from `findPhone` (`adb_id`, port). AD-36 bans `findPhone` through a service, so builders will return different exports: the seed serial, a presence probe, or nothing.
**Fix:** "A phone Lease through a service has exactly the semantics and exports of `hub-device lease <word> --no-connect`, with no `adb_id` recorded. A parity test compares the two."

### M6. Names and ids share one resolution namespace, and the slug grammar is unstated (AD-28, AD-24, AD-29)
`resolve` takes a "word or id". Nothing stops Resource B being named `res-pixel` while A has the id `res-pixel`, because `RESERVED` lists no `res-*`. `isQueued`, the store and `RESERVED` each need the slug regex, and none is given.
**Fix:** Add `res-*` and the Lease id shapes (`l-*`, `e-*`, `job:*`) to `RESERVED` for names. Add: "`lock.mjs` exports `SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/` (1 to 32 characters), used by `isQueued`, the store and the CLI. Resolution tries the id first, then the name."

### M7. `seed_missing` takes and QA-only phones are undecided (AD-30, AD-31)
1. AD-31 refuses new takes only on retired Resources. Whether a `seed_missing` one can be leased is open.
   **Fix:** "takes on a `seed_missing` Resource are refused `HUB_RESOURCE_RETIRED`, `reason: seed-missing`".
2. "A phone absent from `devices.json` is added with its serial" does not say whether it is seeded (and then turns `seed_missing` on the next start, because it is not in `devices.json`) or a runtime `res-<slug>`.
   **Fix:** "added as a runtime Resource (`seeded: false`, id `res-<slug>` of its name)".

### M8. `qa-devices.json` has no test seam (AD-27, AD-30 vs Conventions "Seams" and CLAUDE.md hermetic rule)
`seed.mjs` and the in-memory fallback read `~/.config/mobile-deploy-hub/qa-devices.json`, but the Seams row adds only `fetchImpl`, `sshImpl` and `watchImpl`. A seed test with no seam reads the operator's real file, which is host state and a QA serial.
**Fix:** Add `qaDevices` (a loader seam, default reading `$HOME`) to the Seams row, and add: "`hermetic()` points it at a temp file; a test asserts no test opens the real path."

### M9. Unit file location vs the only installer (AD-45, Structural Seed)
The seed puts `tools/hosts/mobile-deploy-hub-api.service` and the plist under `tools/hosts/`. But the only `install.sh` is `tools/catchup/units/install.sh`, and it copies from its own `$units` dir. One builder extends the catch-up installer with a second path; another writes a new `tools/hosts/install.sh` that `hosts.mjs` does not run. AD-45 also needs the unit's `ExecStart` to name `releases/<ref>`, which means install-time templating like the plist's `@HOME@` sed. That is not stated.
**Fix:** "Units live in `tools/hosts/units/`. `tools/hosts/units/install.sh <ref>` renders `@REF@` and `@NODE@` and is run by `hosts.mjs` beside the catch-up installer, which stays untouched."

### M10. Observability and operations of the two services are neither decided nor deferred (AD-45, Consistency Conventions)
The spine names log markers but does not say:
- where service logs go (journald for the user unit; launchd `StandardOutPath` and `StandardErrorPath` on the Mac);
- who notices the Hub API or Host Agent being down or crash-looping (`KeepAlive` and `Restart=on-failure` hide it);
- whether `HUB_AGENT_PUSH_FAILED` reaches anyone;
- whether metrics or Bloodbank facts are in scope.

The altitude owns this dimension.
**Fix:** Add to AD-45: "Logs go to journald (`mobile-deploy-hub-api`) and to `~/Library/Logs/mobile-deploy-hub/host-agent.{out,err}.log`." Then add a Deferred item: "Prometheus series, Loki shipping, Bloodbank facts and down alerts for both services: v1c, via the monitoring-stack conventions. v1b is observable only through `/health`, logs and the Event Log." Alternatively, list it as an Open Question.

### M11. Structural Seed contradicts AD-40 and AD-47 on the replica key
The seed reads `HUB_EVENT_DIR/replicas/<host_id>/<YYYY-MM>.jsonl`. AD-40, AD-47 and AD-49 say `replicas/<host key>/`. Builders copy the tree.
**Fix:** Change the seed line to `replicas/<host key>/<YYYY-MM>.jsonl`.

---

## LOW

- **L1. Who appends `reachability`, and when (AD-35, AD-39, layer table).** `reachability.mjs` may not import `lock.mjs`, and CLI status is read-only (AD-41, v1a AD-9).
  **Fix:** "Only the host's service appends `reachability`, through `noteReachability`, from the Claims layer. 'Change' is judged against the last logged reading for that Resource, so a restart does not re-emit every Resource. A missing reading counts as older than `reachability_max_age_s`."
- **L2. The AD-43 watch set omits `<lock dir>/emulators/`** (emulator.mjs:191). An orphan reap changes only that dir, so `/status` lags until another file changes. Add it to the watch set.
- **L3. The Stack row lists `host:devices`; AD-35 requires `host:devices-l`** (and `host:track-devices-l`, per H5). Align the Stack row.
- **L4. Frontmatter and map.** `binds` omits FR-13, FR-17 and FR-31, which AD-25, AD-32, AD-33, AD-34, AD-38 and AD-39 cite. NFR-4 (Node only) and NFR-5 (hermetic tests) are bound but have no map row. Add them to `binds` and map NFR-4 and NFR-5 to Stack and Conventions.
- **L5. Mermaid.** Both diagrams are valid by inspection: subgraph ids, cylinder nodes, dotted labelled edges, and labels containing `:`, `+` and `,` are all legal. Content gaps:
  - Diagram 1 lacks `claims --> client` (the layer table allows it), `front doors --> events` (read) and the store's event write through `lock.mjs`.
  - Diagram 2 lacks the big-chungus CLI's own read-only adb read (AD-35) and `LDb --> EVb`.
  Add the edges so "Nothing points back up" can be checked against the picture.
- **L6. Who calls `POST /reservations/<run_key>/cancel` (AD-38, AD-42)?** "A Reservation may be cancelled by its owning run", but the owning run is a deploy job, and AD-25 forbids it calling a service. Say the route serves the operator and the page only (`actor` required), or drop `cancel` and keep `force-release`.
