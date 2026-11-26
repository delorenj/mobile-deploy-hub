# Hub release notes

One section per hub release, headed `## vX.Y.Z`. `mise run release -- X.Y.Z` (`tools/release.mjs`) puts the section of the version it tags into that tag's annotation, above the dry-run lines (`git show vX.Y.Z`), so the notes travel with the tag. A release with no section is annotated as before. Write the section before you release: the file is tracked, the release refuses a dirty tree, and the section is read from the commit being tagged.

A section is plain text read in a terminal: everything after its heading up to the next `## ` heading. Use `###` for sub-headings and `-` lists; do not start a section line with `## `.

## v1.2.57

Epic 8 (see every hold and waiter live), on top of v1.2.56. Agents, Holocene's future board and Jarad can read one status document and one change-driven stream of every Resource's Reachability, Hold and Queue, and the Hub API can be restarted at will without losing anything. The read half is two Hub API routes on one Claims library: `statusView` renders a host from disk, and nothing recomputes a queue position or an ETA. `contract` stays 1: every change to `docs/hub-api-contract.md` is additive, and `hosts:install` now reads it back. No service unit is added: `mobile-deploy-hub-api` is the unit v1.2.53 installed, and `mise run hosts:install` restarts it onto this release.

### What changed

- `GET /status`: one document, `{format, contract, hosts: {<host key>: view}, registry, stale, checked_at}`. Each Resource shows its Reachability (`reachable`, `unauthorized`, `offline`, `absent` or `unknown`), its Hold (Claimant, kind, why, since, `expires_at` and the new `expected_end`, never later than the expiry) and its Queue (position, Claimant, since, the Reservation or queued request); deploy targets are marked and a waiting Pool request is listed once. Everything that passes with time (expiry, grace, staleness) is derived from `now` on every read. For the `service` audience the serial, udid and adb id of a QA device are `null`. Until Epic 9 the document holds one host, `linux`; `hub-device status` on big-chungus adds the Mac from `/status` when the API answers and lists it `unavailable` (`api-down`, `not-served`, `bad-answer`) otherwise.
- `GET /stream`: the Candybar SSE wire (`text/event-stream`, `Cache-Control: no-store`, `X-Accel-Buffering: no`). Every connection starts `retry: 3000`, then its opening frame: `ready` (the whole `/status`) for a new connection, `reset` (`reason: unresumable`, the whole `/status`, after which the client refetches `/history`) for an unknown boot, a malformed id or an evicted one. Frames are `id: <boot>-<seq>` (12 hex characters minted at start), one-line JSON; types `status` (the whole document, absolute) and `event` (one Event Log line, deduped by its id). An exact resume with `Last-Event-ID` replays strictly after it from a ring of the last 1024 frames. A `: keepalive` comment goes out after `api.stream_keepalive_s` (15 s) with nothing sent, owned by the open connection.
- A change reaches subscribers within 2 s, from any process: the service watches the lock dir, `emulators/`, every `<name>.lock`, `<name>.queue` and `<name>.reservations` and the event dir with `fs.watch`, and any notification schedules one re-read after a trailing debounce of at most 250 ms (an `event` frame per new Event Log line, then a `status` frame). No frame is emitted for a change only time causes.
- Reads and waits never block the event loop: the `/proc` scan, the emulator inventory, the adb queries and the service-side waits run in a worker thread, or use the cached process-start seam, and a read answers from an in-memory snapshot. The service holds one `host:track-devices-l` socket on the hub's adb server (never starting a server, never by timer): while it is open the readings are live (`source: track`); when it closes one `reachability` event (`reason: track-lost`) is written per Resource and the probe takes over until the next request reopens it.
- Restart safety: the disk (the lock dir and `registry.json`) is the only state, so no Lease, Job Hold, Reservation or Registry entry is lost, and the emulators the service started keep running (`KillMode=mixed`, the `heavy` scope). On `SIGTERM` an open wait is answered `HUB_API_RESTARTING` with `retry: requeue`; after a crash `hub-client` treats a connection reset during a wait the same way (`requeueable(error)` is the one predicate a waiting caller uses to place the wait again with the same id, and a dead process's waiter ticket no longer blocks that id). A second service exits `HUB_API_ALREADY_RUNNING`. A new boot id means an old `Last-Event-ID` gets `reset`.
- `mise run hosts:install` now reads `contract` back as well as `hub_version`: it succeeds only when `/health` names this release and the code's one `HUB_API_CONTRACT`, and its line prints both (`<ref> serves 127.0.0.1:<port>, contract 1 (...)`). `mise run hosts:smoke` requires the same in its health step.
- `mise run hosts:smoke` gains a stream phase (on by default; `--no-stream` skips it): on the smoke phone, `GET /stream` opens (`retry: 3000`, then `ready`), a `hub-device` Lease shows in a `status` frame within 2 s, the release shows in another, and a `: keepalive` arrives while the stream is idle. `mise run hosts:smoke -- --restart` adds the restart half: it restarts the unit mid-session, then requires the old stream to end, `/health` to answer as this release and contract, the Lease to be still held, and a reconnect with the old `Last-Event-ID` to open `reset` on a new boot. It bounces the service (a wait in flight is answered `HUB_API_RESTARTING` and requeues), so ask for it at release time, not after every install. The `HUB_SMOKE_OK` line is unchanged.

Rolling back is `hosts:install` of `v1.2.56`: move `v1` back, then run `mise run hosts:install` from a clean checkout at `v1.2.56`; no `systemctl disable` step is needed, because no unit is added (the tag's computed `Roll back:` line has no stop step). `v1.2.56`'s service has no `/status` or `/stream`, so a reader of either gets a 404 until it is installed again; Leases, Reservations and the Registry are on disk and are untouched by the rollback.

### Test changes you will see

- `tools/ci/eta.test.mjs`: `expectedEnd` (the Hold's end from the one ETA, never past `expires_at`).
- `tools/clock.test.mjs`: the stream's one-shot change debounce joins the keepalive as a named clock in `tools/hub-api/stream.mjs`, and the comment stripper moved to `tools/ci/lib/source-scan.mjs`.
- `tools/device/claims.test.mjs`: `status --json` carries `remote_hosts`, the client's `HUB_API_RESTARTING` has the exit table's code, and `checkLeaseId` ignores a dead process's waiter ticket.
- `tools/device/hub-device.test.mjs`: the month of Event Log fixtures moved to `writeMonthOfEvents` in `tools/ci/test-fixtures.mjs` (no assertion changed).
- `tools/device/status-view.test.mjs`: remote hosts from `/status` and `expected_end` on every Hold.
- `tools/hub-api/contract.test.mjs`: `GET /status` and `GET /stream` are in the route table and their key sets are asserted against handler output, with a map notation (`a.{name}`) for keyed objects.
- `tools/hub-client.test.mjs`: a reset during a wait is `HUB_API_RESTARTING` with `retry: requeue`, and the other failures of a wait keep their codes.
- `tools/hosts/hosts.test.mjs`, `tools/hostkey.test.mjs`: the `/health` fakes answer `contract` 1, and the readback rejects another contract; `tools/hosts/smoke.test.mjs`: the stream phase, `--restart` and the entry flags.
- New suites: `tools/ci/process-start-seam.test.mjs` and `tools/device/track-devices.test.mjs`, and `tools/hub-api/{snapshot,event-loop,track,stream,changes,status,restart}.test.mjs`.

## v1.2.56

Epic 7 (Leases through the API, cancel and force-release), on top of v1.2.55. Agents and Jarad can take, wait for, extend, release, cancel and force-release holds through the Hub API with the semantics of `hub-device`, without a shell on big-chungus: the routes and the CLI verbs are two front doors on one Claims library (`tools/device/claims.mjs`), and `lock.mjs` stays the only protocol writer. `contract` stays 1: every change to `docs/hub-api-contract.md` is additive. No service unit is added: `mobile-deploy-hub-api` is the unit v1.2.53 installed, and `mise run hosts:install` restarts it onto this release.

Two limits to know before you use it:

- A Job Hold (a deploy job's lock, or its place in line: a `job` or `hub-job` Hold, ids `job:...`) cannot be force-released, released, extended or cancelled through the hub, by the API or by `hub-device`. The answer names the run and points to `gh run cancel <run> --repo <repo>` (`HUB_FORCE_RELEASE_JOB`, or `HUB_DEVICE_JOB_ID` for a `job:` id; a local run or the catch-up says to stop the process). Deploy jobs never call a service to release their Reservation: `announce` and the ssh `reservation release` verb are unchanged, and `tools/deploy-path.test.mjs` fails if a deploy-path file names the force-release route or passes an actor to `releaseReservation`.
- A Lease on a deploy target (the S26, `adb`) is capped at 60 min in total, and any Lease at 48 h; a longer request is refused naming the cap and pointing to the S24 or an emulator. An extension is refused while anyone waits (`HUB_LEASE_EXTEND_REFUSED`, `reason: waiters`; `cap`, `too-long` and `expired` also refuse), unless it is sent with an override that says why, which skips the waiters check and nothing else.

Rolling back is `hosts:install` of `v1.2.55`: move `v1` back, then run `mise run hosts:install` from a clean checkout at `v1.2.55`; no `systemctl disable` step is needed, because no unit is added (the tag's computed `Roll back:` line has no stop step). An API Lease already taken keeps its expiry under `v1.2.55` (it is a lock with `holder_pid: null` and an `expires_at`) and ends at that time; `v1.2.55`'s service has no Hold routes.

### What changed

- Hub API routes (all additive, Lease views through `leaseView`): `POST /leases` (take, with `wait_ms` and a client-minted `id` to wait; by word, Resource id or `match`; `claimant_kind` `agent` or `person`; phones and emulators), `GET /leases/{id}`, `POST /leases/{id}/extend`, `POST /leases/{id}/release`, `POST /leases/{id}/force-release` (a Lease, or an emulator slot `emulator-<n>`), `POST /requests/{id}/cancel`, `POST /reservations/{run_key}/force-release`. Loopback only, `snake_case`, problem+json errors with `code`, `exit` and `reason`.
- API Leases are lock-only and expiry-bound: a phone Lease is `hub-device lease <word> --no-connect` (no `adb_id`), is never reclaimed on a service restart, and status shows its `holder`, never the service pid. The service strips every `GITHUB_*` variable from its environment. A wait keeps its HTTP connection open and is bound to it: a disconnect withdraws the place in line (`cancel`, `reason: aborted`), a Hold granted after the socket closed is released at once, and `SIGTERM` answers open waits `HUB_API_RESTARTING` (`retry: requeue`).
- `hub-device` verbs on the same library: `extend [<id>] --for <dur> [--override <why>]`, `release <id>` (refuses a `job:` id, exit 2), `cancel <id> [--resource R] [--pool P] [--why <text>]`, `force-release <id> --why <text>`, `force-release emulator-<n> --why <text>` and `force-release --reservation <run_key> --why <text> [--name adb|mac-ios]`. Every manual action records `actor {holder, via}` and `why` on its event; a force-release writes one `force-release` event (`hold_kind` `lease`, `reservation` or the emulator slot's Lease) with `lease_id` or `run_key`, `held_ms`, `actor` and `why`.
- The emulator Pool through the API: the emulator boots and tears down in a worker thread, so no other request waits for it. The Pool's size is the `emulator-pool` file, the Registry's `pools.emulator.size`, then 2 (each 1 to 8; `HUB_EMULATOR_POOL` is the CLI's alone).
- `mise run hosts:smoke` gains a holds phase (on by default; `--no-holds` skips it): the same Hold sequence through the API and through `hub-device` on one target, `status --json` read after every step, and the two traces required equal: take A, B waits first in line, extend A refused while B waits, force-release A and B is granted, extend B by exactly 60 s, release B and the target is free. By default it runs on the smoke phone, so it touches no real device and can run after every `hosts:install`; `hosts:smoke -- --holds-on s24` runs it on the S24 (the target must be free with nobody waiting, else nothing is taken). Its ids are `smoke-<id>-<a|b>-<api|cli>`, its holder `hosts:smoke`, and a failure releases every id it started before it retires the phone. The `HUB_SMOKE_OK` line is unchanged.

### Operator-visible changes

- `HUB_LEASE_EXTEND_REFUSED` now exits 76 (busy), not 1, on `hub-device extend` and in the API's `exit`; the refusal names each waiter and its place. An extension at or after `expires_at` is refused (`expired`); extending a Lease that does not exist is `HUB_LEASE_NOT_FOUND` (exit 2) with `reason` `waiting` or `unknown`, where it was `HUB_LEASE_LOST`. `HUB_LEASE_LOST` (exit 1) now means the lock changed hands between the read and the write.
- `hub-device lease phone` with every phone held says `HUB_DEVICE_BUSY phone host lock s24 is held by ...; host lock adb is held by ... (every phone is held); gave up after <n>s`: each held member is named with the library's own `host lock <name> is held by` wording, the same text the API puts in `detail`.

### Test changes you will see

- `tools/device/claims.test.mjs`: `HUB_LEASE_EXTEND_REFUSED` exits 76 (it was 1); an extend of a waiting or unknown id is `HUB_LEASE_NOT_FOUND` (it was `HUB_LEASE_LOST`); `HUB_LEASE_LOST` is only a change of hands; the exit table lists the new codes; the Pool size order has its own test.
- `tools/device/hub-device.test.mjs`: the `phone` busy line keeps `host lock <name> is held by` for each member (one assertion).
- `tools/device/lease.test.mjs`: `claimantKind` and `actor` on the owner record and the events.
- `tools/ci/pool-request.test.mjs`: a Pool timeout keeps the `host lock <name> is held by` wording for every held member, and tickets carry `claimant_kind`.
- `tools/device/emulator.test.mjs`: the emulator fixtures moved to `tools/device/emulator-fixtures.mjs` (no assertion changed).
- `tools/deploy-path.test.mjs`: no deploy-path file force-releases a Reservation or names its route (AD-25).
- `tools/hub-api/contract.test.mjs`: the AD-42 Hold routes are frozen with their field lists.
- New suites: `tools/ci/extend.test.mjs`, `tools/ci/cancel-request.test.mjs`, `tools/ci/force-release.test.mjs` and `tools/hub-api/{leases,waits,extend-release,cancel,force-release,reservation-force-release,emulator-lease,emulator-force-release}.test.mjs`; `tools/hosts/smoke.test.mjs` covers the holds phase.

## v1.2.55

v1.2.54 plus an installer readback fix. v1.2.54 is on `v1` with all six dry runs green, but its `mise run hosts:install` reported `HOSTS_FAILED hub api on big-chungus` although the service was up and healthy: the readback waited for `/health` to say `service: hub-api`, while the server answers `mobile-deploy-hub-api` (the name in `docs/hub-api-contract.md`). The tests faked the readback with the same wrong name, so they agreed with it.

### What changed

- `installHubApi` (`tools/hosts.mjs`) checks `/health` for `HUB_API_SERVICE` from `tools/hub-client.mjs`, and the server's `SERVICE` (`tools/hub-api/routes.mjs`) is that same constant, so the server, the installer's readback and `hosts:smoke` share one name. The failure line now reads `did not report mobile-deploy-hub-api <ref> within 10s`.
- Rolling back is the same as for v1.2.54: the `Roll back:` line names `v1.2.54`.

### Test changes you will see

- `tools/hosts/hosts.test.mjs` and `tools/hostkey.test.mjs`: the `/health` fakes answer with `HUB_API_SERVICE`; the timeout test matches the new wording.

## v1.2.54

v1.2.53 (Epic 6: the Registry and the Hub API) plus a dispatch retry. v1.2.53 was tagged and rolled back, never on `v1`: no lane ran. GitHub answered the dispatch of Tower's release dry run with `HTTP 500` (`could not create workflow dispatch event`), and the release took the failed dispatch as a red dry run. Everything in the v1.2.53 section below ships in this pin, including its install steps and its rollback to `v1.2.52` with the `systemctl --user disable --now mobile-deploy-hub-api.service` step; install it on both hosts (`mise run hosts:install` on big-chungus), then run `mise run hosts:smoke`.

### What changed

- `dispatchRun` (`tools/deploy.mjs`), the one dispatch path for `mise run deploy`, the release dry runs and `ship`, sends a DRY dispatch again when GitHub answers it with a 5xx or drops the connection: at most twice more, each only after waiting up to 30 s for the dry run the failed attempt may have started anyway (a failing run list during that wait counts as nothing seen yet). If that run appears it is used (`DEPLOY_DISPATCH_RECOVERED` / `SHIP_DISPATCH_RECOVERED`) and nothing is sent again; otherwise it logs `DEPLOY_DISPATCH_RETRY attempt <n> of 3: ...` and sends again. A REAL dispatch is never sent twice (a run GitHub created late would be a second real run and a second bump): it fails as before. A 4xx (bad inputs, no such workflow) is thrown at once, as before.

### Test changes you will see

- `tools/ci/v11.test.mjs`: two new tests for the retry (5xx with and without a run started, a failing run list, a foreign REAL run never adopted, a real dispatch never resent, 4xx, three 5xx) and for the front door riding out one `HTTP 500` on a dry run. No existing assertion changed.

## v1.2.53

Epic 6 (Jarad registers a device and every agent can use it), on top of v1.2.52: the Registry and the Hub API. This release installs a service on big-chungus: `mobile-deploy-hub-api`, a systemd user service on `127.0.0.1:8794`, the Registry's only writer. The Mac gets no service: only the `hub-device` and `host-key` changes (its Host Agent is Epic 9); `mise run hosts:install` on big-chungus installs both hosts as before.

The deploy path ignores the Registry and the API (AD-25). The workflow, `actions/hub`, `tools/ci/commands/*` and `tools/catchup/*` never import the Claims library, `tools/registry/*`, `tools/hub-api/*` or `tools/hub-client.mjs` (`tools/deploy-path.test.mjs` and conformance check it), so what a deploy may install and where it may go is unchanged: deploy targets change only by hub release (`devices.json`, `policy.json`), never by a Registry write. A stopped API only disables Registry writes: `hub-device lease`, `run`, `release` and `status` never call it, and `registry list` reads `registry.json` from disk, so holds keep working and no deploy waits on it. A write with the API down fails plainly (`HUB_API_DOWN`, exit 1; `HUB_API_UNKNOWN` when it may have applied).

Rolling back is `hosts:install` of `v1.2.52`, with one extra step first: `v1.2.52`'s installer knows no Hub API unit, so it would leave the service running from `releases/v1.2.53`. Move `v1` back to `v1.2.52`, run `systemctl --user disable --now mobile-deploy-hub-api.service` on big-chungus, then run `mise run hosts:install` from a clean checkout at `v1.2.52` (it installs the Mac through hub-mac). The tag's own annotation carries the computed `Roll back:` line, which now names that stop for every service unit a release adds and its rollback target lacks. `registry.json` and the `registry-*` events stay in the lock directory and are harmless to `v1.2.52`: its `lock.mjs` skips event names it does not know, and its `hub-device` reads the lock directory by lock name, so it leases the S24 and the S26 and ignores a registered phone.

### What changed

- The Registry. `<lock dir>/registry.json` (mode 0600, `{format, rev, resources, pools}`) holds every Resource the hub knows, written only by the Hub API with `if_rev` checks. At each start the service seeds it from `devices.json` (seeded identity, lock, name and `deploy_target` follow the file; Capabilities, retirements and runtime Resources are kept; a Resource `devices.json` drops is marked `seed_missing`, never deleted). The QA phones are imported once, when the file is first created, as `dedicated_qa`; their serials, UDIDs, adb ids and `allowed_users` never reach the file, an event or an API answer. A missing or unreadable file falls back to the in-memory seed, and an unreadable one is never written.
- The Hub API (`tools/hub-api/server.mjs`, contract in `docs/hub-api-contract.md`, contract 1): `GET /health`, `/resources`, `/resources/{id}`, `/pools`, `/discovery`, and `POST /registry/resources` (register), `/registry/resources/{id}` (edit) and `/registry/resources/{id}/retire`. Loopback only, `snake_case` JSON, `application/problem+json` errors with `code`, `exit` and `reason`, `Cache-Control: no-store`. A second instance is refused on the port bind (`HUB_API_ALREADY_RUNNING`). Each `/resources` row carries a `reachability` reading from a cache the service refreshes in the background (a read never waits for a probe).
- `hub-device registry add|edit|retire|list`. `add` mints `res-<slug>` ids and locks that are never reused; a phone needs `--model`; a duplicate serial or UDID among live Resources is refused with the holder's id, and a reserved, taken or malformed name with a machine-readable reason (exit 2). Seeded Resources cannot be retired or have their identity edited (a hub release changes them). `retire` hides a Resource once it is idle: it keeps its Hold, serves queued waiters and refuses new takes (`HUB_RESOURCE_RETIRED`, exit 2, `reason` `retired` or `seed-missing`). `registry add` prints `HUB_DEVICE_REGISTERED <id> <name>`, `edit` `HUB_DEVICE_EDITED <id> <name>`, `retire` `HUB_DEVICE_RETIRED <id> <visibility>`, then `HUB_DEVICE_REV <rev>`.
- A registered phone is leasable by name or by Resource id on the next call, with no release and no reinstall (the fleet is read from `registry.json` on every call), and it joins the `phone` word after the S24 and the S26 (`dedicated_qa` ones only when asked for by name or `dedicated_qa`). One registered without a serial leases only with `--no-connect`.
- Event Log. New names `registry-add`, `registry-edit`, `registry-retire`, `reachability`, `host-reachability`, `prune` and `force-release`, and additive fields `resource`, `actor {holder, via}` and `why`. Each change is logged exactly once, with an id a consumer can resume from. Old pins skip the names they do not know.
- `hub-device discover` and `GET /discovery` list the devices on the hub's adb server that no live Resource names (read only; a QA phone is never listed), so a freshly paired phone is visible before anyone registers it.
- The service runs from a release, never from a checkout: `hosts:install` puts `releases/<ref>` in place, renders `~/.config/systemd/user/mobile-deploy-hub-api.service` for it (`Type=simple`, `Restart=on-failure`, `KillMode=mixed`, no timer), enables and restarts it, and reads `/health` back for at most 10 s until it answers as this release. A stop never kills an emulator: on Linux every emulator and adb server the pool launches goes through `heavy`, which gives each its own systemd scope.
- `policy.json` gains the strict `api` block (`hub_api_port` 8794, `host_agent_port` 8795, `stream_keepalive_s` 15, `peer_connect_timeout_s` 5); no rule a deploy reads changed.
- `mise run hosts:smoke` (new, `tools/hosts/smoke.mjs`): after `hosts:install`, run it on big-chungus. It reads `/health` as this release, lists the Registry, registers a test phone `smoke-<id>`, leases it by name within 60 s, checks the `phone` word and `status` list it, releases it, retires it and checks it is gone, and ends `HUB_SMOKE_OK <ref> <id> leasable after <n> ms` (exit 1 and `HUB_SMOKE_FAILED <step>: ...` otherwise; a failure after the register releases and retires first). It is a separate command on purpose: every run leaves one retired record in `registry.json` (names and ids are never reused).
- The release tool: the `Roll back:` line also names `systemctl --user disable --now <unit>` for each `tools/hosts/units/*.service` this release adds and the rollback target does not have, before the `hosts:install` of the target.

### Test changes you will see

- `tools/ci/reservation.test.mjs`: a set-aside unreadable Reservation is now one `prune` event before the `claim` (Story 6.1).
- `tools/device/emulator.test.mjs`: a fake `heavy` goes first on PATH, plus one seam test (Story 6.11).
- `tools/device/hub-device.test.mjs`: one added test, "lease, status and release work with the Hub API down" (Story 6.8).
- `tools/hostkey.test.mjs`: the `hostsInstall` tests answer the Hub API `/health` and pass `home` (Story 6.11).
- `tools/ci/test-fixtures.mjs`: `heavyShim`, and `hermetic()` puts it first on PATH.
- `claims`, `lease-match` and `policy` gained cases; new suites cover `tools/hub-api/*`, `tools/hub-client.mjs`, the Registry store, changes, seed and view, the Event Log vocabulary, the no-new-clock rule, `tools/hosts/*` and the smoke.

## v1.2.52

Epic 5 (agents can tell which phone is free, and wait in line for one), on top of v1.2.51. Nothing in this release is a service: everything runs inside `hub-device` and `lock.mjs` on the host that runs it, and nothing listens, polls or starts at boot. The deploy path (the workflow, `actions/hub`, `tools/ci/commands/*`, `tools/catchup/*`), `policy.json`'s rules, the Queue protocol, the Event Log format and every `HUB_DEVICE_*` line, exit code (75 away, 76 busy, 2 usage) and existing `--json` key are unchanged. Install it on both hosts (`mise run hosts:install`); that also writes each host's key.

Rolling back is `hosts:install` of `v1.2.51`: move `v1` back to `v1.2.51` and run `mise run hosts:install` on big-chungus from a clean checkout at `v1.2.51` (it installs the Mac through hub-mac). The tag's own annotation carries the computed `Roll back:` line, from where `v1` pointed before this release. An older pin keeps working against what this release writes (new fields and files are additive): `v1.2.51`'s `lock.mjs` reads the lock directory and Event Log of this release, sees a `phone` Pool ticket as an ordinary waiter ahead of it (and so waits behind it and refuses an extension while it waits), and ignores the `resource` field.

### What changed

- One Claims library (`tools/device/claims.mjs`). `hub-device` keeps only argument parsing and output; resolving a name, taking a Lease or a phone, releasing, extending, the 48 h and 60 min bounds and the code-to-exit table live in the library, so the CLI and the later services refuse and report the same action the same way. The deploy path never imports it (a conformance table in `tools/deploy-path.test.mjs` checks).
- Names. `lock.mjs` has one `RESERVED` list and one `SLUG` rule (`devices.mjs`'s own list is gone); a `res-<slug>` lock is a Queued lock like `adb`. Every Hold event gains an additive `resource` field (the Resource the lock belongs to).
- `host-key`. `hosts:install` writes `~/.config/mobile-deploy-hub/host-key` (`linux` on big-chungus, `mac` on the Mac) and reads it back. A command that must know which host it is on, with no file or a file that disagrees with the OS, fails with `HUB_HOST_UNKNOWN` (exit 1). Until `hosts:install` has run after this release, `hub-device status` on that host shows every reading as `unknown` (and stale), and `hub-device discover` fails with `HUB_HOST_UNKNOWN`.
- `hub-device status`: every row of `phones`, `locks`, `waiters`, `reservations` and `emulators` has a `resource`, a `deploy_target` and a `reachability` `{state, checked_at, age_ms, stale}` beside the unchanged `presence`. `state` is `reachable`, `unauthorized`, `offline`, `absent` or `unknown`; `unknown` is never shown as `reachable`. The text view gets a `DEPLOY TARGET <resource> ...` line for each deploy target that is held, waited on or reserved. `stale` follows the new strict `policy.json` key `registry.reachability_max_age_s` (60).
- Status reads the phones on the adb wire only (`host:version`, `host:devices-l`): it never runs the adb binary, starts a server or connects. `deploy_target` is true for `s26` and `ios-lane`, false for `s24`, the emulators and `res-<slug>`.
- `hub-device discover` lists the devices adb sees that no declaration names, from the same read-only query, and says `no adb server` when there is none.
- `hub-device lease --match key=value[,key>=n]` asks for a phone by Capability (equality, `>=`, `<=`). No match is `HUB_NO_MATCH` and candidates on two hosts are `HUB_POOL_CROSS_HOST`, both exit 2; every match offline, absent or unauthorized is `HUB_DEVICE_AWAY` (75). A dedicated-QA phone is served only to a request that names it or asks for `dedicated_qa`; a deploy target whose cap the request exceeds is dropped.
- `phone` holds a place in line. `lease phone` and `run phone` write one identical ticket in every member's queue (the S24 and the S26, then Resources of kind `phone` on `linux`) and take the first member that serves them; the Event Log gets one Pool-level `request` and one `acquire`, `timeout` or `cancel`. It fails at once with `HUB_DEVICE_AWAY` only when every member is away. A request that ends up holding two members releases the later one (`reason: pool-duplicate`). `status` lists a Pool request once, with `pool` and `positions` in `--json`.
- No extension while anyone waits. The library's `extend` (`lock.mjs` `extendLease`; `hub-device` has no extend command) refuses with `HUB_LEASE_EXTEND_REFUSED`, naming every waiter with its position, while a Pool request waits in the Resource's queue or a waiter sits in the `emulator` gate behind an emulator slot; the extender's own ticket and a Pool request that already holds a member do not count.

### Test changes you will see

- `tools/device/hub-device.test.mjs`: the status fixtures answer on the adb wire (`wire-fixtures.mjs`) instead of through the adb binary, and the tests assert the binary never ran (Story 5.4).
- `tools/device/lease.test.mjs`: `body()` strips the additive `resource` field (Story 5.2).
- `tools/device/emulator.test.mjs`: unchanged. No `phone` ordering assertion changed (Story 5.8).
- New suites: `claims`, `lease-match`, `phone-queue`, `status-view`, `hostkey`, `names`, `pool-request`, `deploy-path`, and `tools/registry/*`; `extend`, `eta` and `policy` grew by this epic's cases.

## v1.2.51

v1.2.49 (story 3.5) plus an adb fix; install it on both hosts (`mise run hosts:install`). v1.2.50 was tagged and rolled back, never on `v1`: Tower's release dry run (45523879648) went red in `plan` because big-chungus's adb server died while it was starting (`daemon started successfully`, then `daemon still not running`), and the first `adb devices` failure killed the job.

### What changed

- `findPhone` (`lib/adb.mjs`), which the plan, the android lane, the gate, the catch-up and `hub-device` all use, retries a server that will not start or list: it logs `HUB_S26_ADB_RETRY poll <n>: <error>`, runs `adb start-server` again on the next poll and keeps waiting until the usual deadline. An adb that never lists once in the whole wait still fails with its own error (a broken adb is red, never "the phone is away"); a server that listed and then died ends as `HUB_PHONE_AWAY`, as before.

## v1.2.50

v1.2.49 re-released; no hub code changed. v1.2.49 was tagged and rolled back, never on `v1`: green-in-between's release dry run (45520180065) went red in the `ios` job when the Mac's network dropped. The app's `ios-build.py` timed out after 90 s reading its godot-tests status from big-chungus over ssh, and GitHub's artifact service timed out on the same job. Tower's dry run on v1.2.49 was green. Everything in the v1.2.49 section below ships in this pin; install it on both hosts (`mise run hosts:install`).

## v1.2.49

Story 3.5 (AD-22): iOS contention is red, and says who. Nothing here changes the Queue protocol, the policy, the deadline or `latest.json`; install it on both hosts (`mise run hosts:install`).

### What changed

- The `ios` job's two `mac-ios` takes (the device build, then the store IPA build) go through one `macLane` helper in `ios.mjs`. A wait that runs out before the hold is `HUB_LOCK_TIMEOUT`, rethrown, so the job goes red. The lock writes the one `timeout` event on the Mac with `reason: ios-lane-contention`; the receipt records `contention {lock: mac-ios, reason: ios-lane-contention, blocked_by}` (the same shape Android writes), the job summary lists the holder and the waiters ahead, and the log has `HUB_IOS_LANE_BUSY <device|store> code=HUB_LOCK_TIMEOUT`. An error raised inside a hold fails as before. The run's Reservation is kept for the rerun.
- A store-IPA take that times out after the iPad install was read back is reported at stage `deliver` with a failed `store` record (`mac-ios busy: the App Store IPA was not built; the iPad's delivery stands`). The iPad stays `installed`; only the store step is red.
- Public copies stay coarse. `publicReason(receipt)` (`lib/receipt.mjs`) turns the reason of a lane receipt that recorded `contention` for the wait that failed it into `mac-ios busy: the wait for it ran out (HUB_LOCK_TIMEOUT); the run summary names who held it` for the bucket receipts, `latest.json`'s failed reason and the Bloodbank event. Holder names stay in the receipt, the summary, the log and the Event Log.

## v1.2.48

v1.2.47 plus the Mac disk fix. v1.2.47 was tagged and rolled back, never on `v1`: green-in-between's release dry run stopped in `preflight-ios` with the Mac at 14.9 of the 15 GiB floor. Everything in the v1.2.47 section below ships in this pin; install it on both hosts (`mise run hosts:install`).

### What changed

- The iOS disk check frees stale DerivedData before it refuses. Every CI checkout path gets its own Xcode DerivedData folder (`<Project>-<28 letters>`, ~200 MB each), so every iOS run of every app left one behind until the Mac hit the floor (v1.2.4 died on it too). When `preflight-ios` or the `ios` job finds less than `mac.min_free_gib` free, it removes those per-project folders, oldest first and none used within a day, until there are 5 GiB above the floor, and logs `HUB_DISK_PRUNED <n> DerivedData folder(s) unused for a day; <free> GiB free now`. Xcode's shared caches (`ModuleCache.noindex`, SDK caches) are never touched, and a disk still short after that refuses as before.

## v1.2.47

Epic 3 (deliveries survive contention) and Epic 4 (know where you stand and how long it will be), on top of v1.2.46. The Queue protocol and the Event Log format are unchanged; nothing here needs both hosts on the same hub version at the same instant, but install it on both (`mise run hosts:install`).

### What changed

- Peek under a Lease. The catch-up and the deploy's device checks read the S26 without disturbing a Lease holder.
- `S26 busy` is pending. An Android delivery blocked by a Lease goes `pending` (not failed) and the catch-up delivers it in its turn.
- The catch-up takes its turn in the FIFO with the Leases, so contention-pending builds are delivered when the line reaches it.
- A newer installed build is refused with a name: `refused` is written to the Event Log, naming the Leases that held the device since the build went pending (`installed_by`).
- Enqueue ETA. Every ticket and `request` event carries an `eta` (`{lo_ms, hi_ms, low_data}`): the 25th to 75th percentile of matching past holds in the last `eta_window_days` (30), added along the Queue; fewer than `eta_low_data_min_holds` (20) matching holds widens it to the stated durations and sets `low_data`. Two new keys in the `queue` block of `policy.json`.
- Wait line. A waiter prints `HUB_LOCK_WAIT <name> held by <holder> position=<n> eta=<lo>-<hi>[ low-data]` in the job log (deploy jobs) or on stderr (`hub-device lease --wait`), only when its position changes or the range moves by more than a minute; at most one recompute every 5 minutes.
- `hub-device status`. Every waiter is listed by kind (Lease, `JOB <repo> run <run> job <job>`, `CATCH-UP`) with its position and live ETA, and a RESERVATIONS section shows each run's place, grace state and expiry. `--json` adds `waiters[].kind/repo/run/job/eta` and `reservations[]`; no key is renamed or removed. Status stays read-only and answers from one windowed read of the Event Log.
- `hub-device release job:<repo>#<run>.<attempt>/<job>` exits 2 with `HUB_DEVICE_JOB_ID ...` naming the run to cancel (`gh run cancel <run> --repo <repo>`). It never touched a job before; now it says why.

### Wording change you will see

The wait line is new text on the same `HUB_LOCK_WAIT <name> held by <holder>` prefix: it now ends with `position=<n> eta=<lo>-<hi>`. A caller that matched the whole line must match the prefix only (the old wait-line test was updated as an intended text change, AD-17).

- `hub-device release job:<repo>#<run>.<attempt>/<job>` used to exit 0 with `HUB_DEVICE_NOT_HELD`; it now exits 2 with `HUB_DEVICE_JOB_ID`. A script that checked `release`'s exit code for a job id now sees 2.

## v1.2.46

Freeze set of the v1a queue protocol (design AD-20): the Event Log from v1.2.45 (tagged, rolled back, never on `v1`), and all of Epic 2. v1.2.44 was the last release on `v1`; this one carries every change since it, in one pin so no pin ever holds half the format.

### Read this first: fairness needs this pin

Fairness holds only among runs on this pin and later. A run still on an older pin (a caller pinned to an exact earlier tag, or a job that started before `v1` moved) does not write tickets, Reservations or events in the new format and does not look at them, so it can take a device ahead of the Queue. Older pins age out within 30 days: every app's caller pins `@v1`, so each new deploy run moves to this pin by itself, and the last holdout is a run started from an old exact tag. Until then, treat the Queue as advisory for those runs. Install this release on both hosts (`mise run hosts:install`, from a clean checkout at the tag, on big-chungus and on the Mac): the Mac's `hub-device` needs the `reservation release` verb, and a Mac without it logs `HUB_RESERVATION_RELEASE_SKIPPED` and leaves the Reservation to its 180-minute ceiling.

### What changed

- Event Log. Every hold of a lock, ticket and Reservation writes one JSON line (`format`, `ts`, `host`, `host_id`, `hub_version`, `event`, `lock`, `hold_kind`, `claimant`, waits and holds in ms) to `HUB_EVENT_DIR/<YYYY-MM>.jsonl` on the host that owns the lock. Events are `request`, `acquire`, `release`, `reclaim` (a dead holder's lock taken back), `timeout`, `cancel`, `claim`, `grace`, `expiry`, `extend`, each written once by whoever won the unlink or rename that decided it. `hub_version` is the hub ref the run pinned.
- Queue. Deploy jobs (`plan`, `android`, `ios`), the iPad catch-up and every Lease take a ticket and are served first come, first served on `adb`, `s24`, `mac-ios` and the emulator slots. One `queueView` answers who holds, who waits and in which place; a ticket carries a machine identity and a liveness order, so a dead waiter never blocks the line.
- Reservations. The gate reserves `adb` for a run with an Android lane, and `preflight-ios` reserves `mac-ios` on the Mac, when the run starts, so a build does not lose its place while it compiles. Only the first Reservation in line blocks, and only for `grace_min` (10); the ceiling is `reservation_ceiling_min` (180). A lane releases its Reservation inside its last hold, before the lock is freed; `announce` backstops it, over ssh on the Mac. By hand: `hub-device reservation release --run <owner--repo--run> [--name adb|mac-ios]`. A failed lane keeps its Reservation, so `gh run rerun --failed` is served at the original place.
- Deadlines. A deploy job that waits in the Queue stops at `job_start + timeout - wait_margin_min - hold_allowance_min` and reports its own reason before GitHub kills it (a killed job ends `cancelled`: no `finally`, no `deliver-*`).
- Lease cap. A Lease on `adb` (the S26) or `mac-ios` may run at most `deploy_target_lease_max_min` (60 minutes). `hub-device lease s26 --for 2h` exits 2, naming the cap and pointing at `s24` or an emulator; `lease phone` over the cap skips the S26. `s24`, emulators and every other lock keep the 48 h limit. A Lease can be extended only by `extendLease`, which refuses while anyone waits (`HUB_LEASE_EXTEND_REFUSED`); there is no CLI verb yet (v1b). An owner rewrite checks the lock is still the writer's (`HUB_LEASE_LOST`).
- Concurrency groups. `android` and `ios` no longer carry a GitHub `concurrency` group (AD-21): the Queue orders them, and GitHub's group could cancel a pending job the Queue still held a place for. `plan`, `ios-export` and `deliver-*` keep theirs.

### Wording change you will see

A queued timeout now names the holder and, when anyone waits ahead, each waiter with its place, for a deploy job and the catch-up as well as a Lease; and every `withLock` and Lease timeout carries the code `HUB_LOCK_TIMEOUT`.

- Before (v1.2.44), a Lease: `host lock adb has 2 waiters ahead of lease <id> (held by ...); gave up after Ns`. A deploy job: `host lock adb is held by ...; gave up after N min. Another deploy is using the device; run again when it finishes.`
- Now, all three: `host lock adb is held by <holder>; 2 waiters ahead of <self> (1. <holder> (why), 2. ...); gave up after ...`; a deploy job's with its own deadline ends `gave up after M min, ahead of this job's N-minute timeout. ...`. With nobody ahead the wording is the old `host lock adb is held by ...; gave up after ...`.

Anything that matches the old sentence by regex must match the code (`HUB_LOCK_TIMEOUT`) instead. The catch-up's own idle checks were moved with it and still match.

### Proven by

`mise run check` is green on Node 24 and Node 26 (`mise run --tool node@26 check`; `check.yml` runs both), including two event-sequence tests: a whole deploy run (claim, request, acquire, release, Reservation release, every event stamped with the pinned `hub_version`) and a timed-out wait (request, timeout, `HUB_LOCK_TIMEOUT`, holder and waiters named).
