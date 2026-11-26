# Hub API contract

Status: contract 1, 2026-11-25

The Hub API is the one writer of the Registry (design v1.1, AD-42). Holocene's page and every other client code against this document. `tools/hub-api/contract.test.mjs` parses it and fails when a route or a field exists in only one of this document and `tools/hub-api/routes.mjs`, so a route-adding story updates both.

## Base URL

`http://127.0.0.1:8794`, loopback only, no path prefix. The port is `api.hub_api_port` in `tools/ci/policy.json`. There is no authentication: the socket is not reachable from another host.

## Conventions

- Every response carries `Cache-Control: no-store`.
- Keys are `snake_case`.
- A success is `application/json; charset=utf-8`. An error is `application/problem+json` with exactly the `Problem` fields below.
- Paths match exactly: no trailing-slash folding, and the query string is ignored for routing. A `{name}` segment in a path below is a parameter: one non-empty segment, URI-decoded (a bad escape is no route). A literal path wins over a parameterised one, and the literal routes are then the whole answer for a path they match: a method none of them has is 405 with an `Allow` naming only the literal routes' methods, even when a parameterised route would have taken it.
- In a shape's field list, `a.b` is a key of the object `a`; `a[].b` is a key of the objects in the array `a`; `a.*` is an open object whose keys this document does not list (a client reads what it knows and ignores the rest); `a.{name}` is an object keyed by values such as host keys, and every value of it has the fields listed under `a.{name}.` (`hosts.{host}.phones[].device` is the `device` of each phone of each host in `hosts`). An array of plain values is listed as the array itself.
- The contract is additive only: a later release adds routes and fields, never removes or renames one, and never changes what a field means. A client ignores fields it does not know. `contract` in `/health` is the version, and rises only on a change that cannot be additive.
- `exit` in an error is the exit code a CLI front door uses for the same error, so `hub-device` and a Holocene button agree.
- An error the Claims library throws has no HTTP status of its own: it takes its `status` (and, for busy, away, no-match and host-unknown, its `reason`) from the library's one table (`HTTP_ANSWERS` in `tools/device/claims.mjs`), so every service answers the same error the same way. An error code the table does not know is a bug of the service: 500 `HUB_API_ERROR`.

## Routes

| Method | Path | Shape | Added |
|--------|------|-------|-------|
| GET | `/health` | Health | 6.4 |
| GET | `/resources` | ResourceList | 6.5 |
| GET | `/resources/{id}` | Resource | 6.5 |
| GET | `/pools` | PoolList | 6.5 |
| GET | `/discovery` | Discovery | 6.10 |
| GET | `/status` | Status | 8.1 |
| GET | `/stream` | StreamFrame | 8.4 |
| POST | `/registry/resources` | Resource | 6.6 |
| POST | `/registry/resources/{id}` | Resource | 6.7 |
| POST | `/registry/resources/{id}/retire` | Retirement | 6.7 |
| POST | `/leases` | Lease | 7.1 |
| GET | `/leases/{id}` | Lease | 7.2 |
| POST | `/leases/{id}/extend` | Lease | 7.3 |
| POST | `/leases/{id}/release` | Release | 7.3 |
| POST | `/leases/{id}/force-release` | ForceRelease | 7.6, 7.8 |
| POST | `/requests/{id}/cancel` | Cancel | 7.5 |
| POST | `/reservations/{run_key}/force-release` | ReservationForceRelease | 7.7 |

## Shapes

### Health

- `ok` always `true`
- `service` always `mobile-deploy-hub-api`
- `contract` the contract version of this document
- `hub_version` the hub release the service runs from (`v1.2.60`), or `unknown`
- `ports.hub_api` the Hub API's port
- `ports.host_agent` the Host Agent's port
- `registry` `ok`, or `unreadable` when `registry.json` exists and cannot be read; a missing file is `ok` (the in-memory seed answers). Read fresh on every call.

### ResourceList

`GET /resources`: every Resource a reader shows (`visible`, or `retiring`), in the Registry's order. A retired or seed-missing Resource that is neither held nor waited on is left out. The Registry is read fresh on every call.

- `rev` the Registry's revision (`0` when the in-memory seed answers)
- `source` `file` (the Registry file), or `seed` (no readable file: the in-memory seed of `devices.json`)
- `resources[].id` the Resource's id, never reused
- `resources[].lock` the lock a Hold takes
- `resources[].name` the word a Claimant says
- `resources[].kind` `phone`, `ios-lane` or `emulator-pool`
- `resources[].host` the host key the Resource lives on (`linux` or `mac`)
- `resources[].identity.*` what names the hardware (`serial`, `udid`, `adb_id`, `model`), or `null`. For a `dedicated_qa` Resource `serial`, `udid` and `adb_id`, where the record has them, are `null` (the key stays); `allowed_users` is never served.
- `resources[].capabilities.*` the Resource's Capabilities (`{}` when none); `allowed_users` is never served
- `resources[].deploy_target` `true` for a Resource deploys install to
- `resources[].seeded` `true` for a Resource `devices.json` derives, `false` for a runtime Resource
- `resources[].seed_missing` `true` when a seeded Resource is no longer in `devices.json`; always a boolean
- `resources[].created_at` an ISO time, or `null` (the in-memory seed has none)
- `resources[].retired_at` an ISO time, or `null`
- `resources[].visibility` `visible`, or `retiring` (retired or seed-missing but still held or waited on)
- `resources[].reachability.state` `reachable`, `unauthorized`, `offline`, `absent` or `unknown`. `unknown` means nobody checked (or the transport could not say); it is never shown as `reachable`. `stale` is never served: a reader derives it from the age
- `resources[].reachability.checked_at` an ISO time, when the service's probe took the reading, or `null`. A reader never computes an age from it
- `resources[].reachability.age_ms_at_receipt` the reading's age in ms as of this response, or `null` when there is no reading
- `resources[].reachability.received_at` the service's clock when it answered, in ms since the epoch, or `null` when there is no reading
- `resources[].reachability.source` `probe` (the service read it from the host's adb server), `track` (the service's one `host:track-devices-l` socket on that server pushed it), or `null` when there is no reading

`reachability` is on this list only: the `Resource` of the other routes has no such field. A reading is never waited for: a request answers from the service's cache at once. While the service's track socket is open, every own-host phone's reading is current (`source: track`, `age_ms_at_receipt` 0): adb pushes every change, so a silent socket means the state holds, and a push is one `reachability` event with `reason: track`. When the socket closes the service writes one `reachability` event per tracked Resource (`to: unknown`, `reason: track-lost`), drops those readings and probes again, and only the next request opens a new socket (never a timer). Without a live reading, a missing or stale reading (older than `registry.reachability_max_age_s`, 60 s) starts one refresh in the background (at most one at a time), so the first read after a start shows `unknown` with every other field `null`. Only the Resources on the service's own host are probed; an `ios-lane` or the `emulator` Pool reads `unknown`. A change of state is logged once as a `reachability` event. The service remembers what it logged only for as long as it runs, so the first reading after a service start is logged with `from: null`.

The age rule: a reader on the service's host computes `age_ms = age_ms_at_receipt + now - received_at` on its own clock. A client on another host first re-stamps the reading with `receive` (`tools/registry/reachability.mjs`), which keeps `age_ms_at_receipt` and sets `received_at` to the client's own clock, so neither clock's skew can make a reading look fresher than it is.

### Resource

`GET /resources/{id}`: one Resource, found by `id` only. An unknown id is 404 `HUB_RESOURCE_NOT_FOUND` with `reason: unknown`; a retired or seed-missing Resource that is idle is 404 with `reason: retired`.

`POST /registry/resources` answers the same shape with status 201: `rev` is the Registry's revision after the register, `source` is always `file`, and `resource` is the new Resource as a reader serves it (a `dedicated_qa` Resource's `serial`, `udid` and `adb_id` are `null`). The request body is under "Request bodies".

`POST /registry/resources/{id}` (an edit, added in 6.7) answers the same shape with status 200: `rev` is the Registry's revision after the edit (the current one when the edit changed nothing), and `resource` is the edited Resource as a reader serves it. A retired Resource is never answered here: see `Retirement`.

- `rev` the Registry's revision
- `source` `file` or `seed`
- `resource.id` as in `ResourceList`
- `resource.lock` as in `ResourceList`
- `resource.name` as in `ResourceList`
- `resource.kind` as in `ResourceList`
- `resource.host` as in `ResourceList`
- `resource.identity.*` as in `ResourceList`
- `resource.capabilities.*` as in `ResourceList`
- `resource.deploy_target` as in `ResourceList`
- `resource.seeded` as in `ResourceList`
- `resource.seed_missing` as in `ResourceList`
- `resource.created_at` as in `ResourceList`
- `resource.retired_at` as in `ResourceList`
- `resource.visibility` as in `ResourceList`

### Retirement

`POST /registry/resources/{id}/retire`: status 200. Retiring sets `retired_at` and changes nothing else: a Hold the Resource has stays, its queued waiters are served, and a new take is refused (`HUB_RESOURCE_RETIRED`). Retiring a Resource that is already retired answers the same shape with the stored `retired_at` and the unchanged `rev`.

- `rev` the Registry's revision after the retire (unchanged for a Resource that was already retired)
- `source` always `file`
- `id` the Resource's id
- `retired_at` the ISO time the Resource was retired
- `visibility` `retiring` (the Resource's lock is held or waited on) or `hidden` (idle: no list shows it any more)

### PoolList

`GET /pools`: every Pool of the Registry, in its stored order.

- `rev` the Registry's revision
- `source` `file` or `seed`
- `pools[].name` the Pool's name (`phone`, `emulator`)
- `pools[].kind` `named` (a list of Resources) or `gate` (one lock, no list)
- `pools[].members` for a `named` Pool the ids a lease of it would try, in order (`[]` when none can serve it); always `[]` for a `gate`
- `pools[].gate` the gate's lock name, or `null`

### Discovery

`GET /discovery`: the devices on the hub's adb server that no live Resource of the Registry names (FR-4, FR-5), so a freshly paired phone shows up before anyone registers it. Read only: it asks `host:version` and `host:devices-l`, plus one serial read for each `host:port` id in `device` state, and never starts a server, connects or pairs. A Resource that is retired or seed-missing no longer names its phone. A device the private QA file names is left out, so no QA serial appears in the body. An adb server that is not running is `note: no adb server` with `devices: []`, still 200. An unknown host key is 503 `HUB_HOST_UNKNOWN`. `/status` and `/discovery` take the host observations (the process inventory, the adb listing and the process starts of the lock owners) from an in-memory snapshot gathered in a worker thread, which a read refreshes at most once per 2 s pass; the first read after a start waits for the first gather, and a failed gather logs `HUB_API_OBSERVE_FAILED` and keeps the last snapshot.

- `format` always `1`
- `host` the host key the service runs on: `linux` (the Hub API on big-chungus). A service on the Mac's key answers `host: mac`, `via: devicectl`, `port: null`
- `via` how the host was asked: `adb` on `linux`, `devicectl` on `mac`
- `port` the adb server port that was asked, or `null` on a host that does not use adb
- `note` `null`, `no adb server` (none is running) or `adb did not answer` (it is wedged or not adb)
- `devices[].serial` the phone's serial, or `null` when it could not be read (an `unauthorized` or `offline` `host:port` id)
- `devices[].model` the model adb lists, or `null`
- `devices[].id` the adb id: the serial over USB, the mDNS service name, or `host:port`
- `devices[].state` the state adb lists it in (`device`, `unauthorized`, `offline`, ...)

### Status

`GET /status`: every Resource's Reachability, Hold and Queue in one document (FR-14, AD-41), so a reader never recomputes a queue. `hosts` holds one view for each host the service has: today only its own (`linux`), and a later release adds the Mac's key with no change to any key here. A host's view is exactly what `hub-device status --json` would print on that host for a service reader: the v1a lists (`phones`, `locks`, `waiters`, `reservations`, `inventory`, `emulators`), each row naming its `resource`, `deploy_target` (a Resource deploys install to is visibly marked) and `reachability`. A Resource's Registry fields (names, Capabilities, retired and seed-missing visibility) are under `registry` only, never in a view. Nothing derived from time is cached: every answer is derived from the lock dir, the Registry file, the Event Log and the clock at the moment of the request (and from the host snapshot described under `GET /discovery` for the inventory, the adb listing and process starts; while the service's track socket is open its adb listing is the socket's latest push, so a phone's `reachability` here is current), so a Lease past its `expires_at` reads `stale: true` and has no `expected_end` with no file changed. For a `dedicated_qa` Resource the `serial`, `udid` and `adb_id` of its rows, and a Lease's `phone` and `device` serial and adb id, are `null` (the keys stay). An unknown host key is 503 `HUB_HOST_UNKNOWN`.

- `format` always `1`
- `contract` the contract version of this document
- `checked_at` an ISO time, the service's clock when it built the document
- `stale.*` the views the service shows from an earlier read, keyed by host key, each `{since}` (an ISO time). Always `{}` today: the service reads its own host fresh on every request
- `hosts.{host}.phones[].device` the word a Claimant says for the phone
- `hosts.{host}.phones[].lock` the lock a Hold takes
- `hosts.{host}.phones[].deploy` `true` for the phone deploys install to
- `hosts.{host}.phones[].name` the phone's display name
- `hosts.{host}.phones[].model` the phone's model, or `null`
- `hosts.{host}.phones[].serial` the phone's serial, or `null` (always `null` for a `dedicated_qa` phone)
- `hosts.{host}.phones[].held` `free`, `lease` or `lock` (a Job Hold)
- `hosts.{host}.phones[].holder` the Lease's holder, or `null`
- `hosts.{host}.phones[].lease_id` the Lease's id, or `null`
- `hosts.{host}.phones[].why` the Lease's `why`, or `null`
- `hosts.{host}.phones[].expires_at` the Lease's expiry (ISO), or `null`
- `hosts.{host}.phones[].adb_id` the adb id recorded on the Lease, or `null`
- `hosts.{host}.phones[].repo` the repo of a Job Hold, or `null`
- `hosts.{host}.phones[].run` the run of a Job Hold, or `null`
- `hosts.{host}.phones[].presence` what adb says: `reachable`, `unauthorized`, `offline` or `absent`
- `hosts.{host}.phones[].resource` the Resource id
- `hosts.{host}.phones[].deploy_target` `true` for a Resource deploys install to
- `hosts.{host}.phones[].reachability.state` `reachable`, `unauthorized`, `offline`, `absent` or `unknown`
- `hosts.{host}.phones[].reachability.checked_at` an ISO time, when the host read it, or `null`
- `hosts.{host}.phones[].reachability.age_ms` the reading's age in ms as of this document, or `null`
- `hosts.{host}.phones[].reachability.stale` `true` when the reading is older than `registry.reachability_max_age_s` or there is none: a reader never shows a stale reading as current
- `hosts.{host}.locks[].lock` the lock
- `hosts.{host}.locks[].device` the word for the phone it stands for, or `null`
- `hosts.{host}.locks[].kind` `lease` or `lock` (a Job Hold)
- `hosts.{host}.locks[].stale` `true` for a Hold the next taker reclaims (a Lease past its `expires_at`, a dead job)
- `hosts.{host}.locks[].lease_id` the Lease's id, or `null` for a Job Hold
- `hosts.{host}.locks[].holder` the Claimant of a Lease, or `null`
- `hosts.{host}.locks[].why` what the Lease is for, or `null`
- `hosts.{host}.locks[].repo` the repo of a Job Hold, or `null`
- `hosts.{host}.locks[].run` the run of a Job Hold, or `null`
- `hosts.{host}.locks[].pid` a Job Hold's process, or `null`
- `hosts.{host}.locks[].holder_pid` the process a Lease is tied to, or `null` (an API Lease has none)
- `hosts.{host}.locks[].started_at` an ISO time, when the Hold was taken, or `null`
- `hosts.{host}.locks[].expires_at` the Lease's expiry (ISO), or `null` for a Job Hold
- `hosts.{host}.locks[].phone.*` the phone a Lease holds (`serial`, `adb_id`, ...), or `null`
- `hosts.{host}.locks[].emulator.*` the emulator a Lease holds, or `null`
- `hosts.{host}.locks[].resource` the Resource id, or `null` for a lock that is no Resource
- `hosts.{host}.locks[].deploy_target` `true` for a Resource deploys install to, or `null` with no Resource
- `hosts.{host}.locks[].reachability.*` the Resource's Reachability as for a phone, or `null`
- `hosts.{host}.locks[].expected_end` an ISO time: when the Hold is expected to end, from the one ETA (`tools/ci/lib/eta.mjs`), never later than the Lease's `expires_at`; `null` for a stale Hold, when the upper bound is unknown or when the ETA cannot be computed
- `hosts.{host}.waiters[].lock` the lock the waiter queues on
- `hosts.{host}.waiters[].device` the word for the phone, or `null`
- `hosts.{host}.waiters[].position` its place in that queue (1 is next; a Reservation is not counted)
- `hosts.{host}.waiters[].lease_id` the request id, or `null`
- `hosts.{host}.waiters[].holder` who waits, or `null`
- `hosts.{host}.waiters[].why` what for, or `null`
- `hosts.{host}.waiters[].since` an ISO time, when it took its place
- `hosts.{host}.waiters[].stale` `true` for a ticket nobody serves any more
- `hosts.{host}.waiters[].kind` `lease`, `job` or `hub-job`
- `hosts.{host}.waiters[].repo` a deploy job's repo, or `null`
- `hosts.{host}.waiters[].run` a deploy job's run, or `null`
- `hosts.{host}.waiters[].job` a deploy job's job name, or `null`
- `hosts.{host}.waiters[].eta.*` the live ETA `{lo_ms, hi_ms, low_data}`, or `null`
- `hosts.{host}.waiters[].request` a Pool request's id; only on the row of a Pool request, which is listed once
- `hosts.{host}.waiters[].pool` the Pool the request waits on; only on the row of a Pool request
- `hosts.{host}.waiters[].positions.*` the request's place in each member's queue, by lock; only on the row of a Pool request
- `hosts.{host}.waiters[].resource` the Resource id, or `null`
- `hosts.{host}.waiters[].deploy_target` `true` for a Resource deploys install to, or `null`
- `hosts.{host}.waiters[].reachability.*` the Resource's Reachability, or `null`
- `hosts.{host}.reservations[].lock` the lock the Reservation holds a place on
- `hosts.{host}.reservations[].device` the word for the phone, or `null`
- `hosts.{host}.reservations[].run_key` the run key (`owner--repo--run`)
- `hosts.{host}.reservations[].repo` the run's repo, or `null`
- `hosts.{host}.reservations[].run` the run's id, or `null`
- `hosts.{host}.reservations[].place` its place in the queue
- `hosts.{host}.reservations[].blocking` `true` while it holds the lock back from the waiters behind it
- `hosts.{host}.reservations[].grace.*` where its grace period stands (`state`, `ends_at`, ...)
- `hosts.{host}.reservations[].reserved_at` an ISO time
- `hosts.{host}.reservations[].expires_at` an ISO time, its ceiling
- `hosts.{host}.reservations[].stale` `true` once past its ceiling
- `hosts.{host}.reservations[].resource` the Resource id, or `null`
- `hosts.{host}.reservations[].deploy_target` `true` for a Resource deploys install to, or `null`
- `hosts.{host}.reservations[].reachability.*` the Resource's Reachability, or `null`
- `hosts.{host}.inventory.adb_servers.*` the adb servers running on the host
- `hosts.{host}.inventory.emulators.*` the emulator processes running on the host
- `hosts.{host}.inventory.xvfb.*` the Xvfb displays running on the host
- `hosts.{host}.emulators[].lease_id` the emulator Lease's id
- `hosts.{host}.emulators[].slot` the slot lock (`emulator-<n>`)
- `hosts.{host}.emulators[].profile` `default` or `playstore`
- `hosts.{host}.emulators[].serial` the adb serial (`emulator-<console port>`)
- `hosts.{host}.emulators[].console_port` the console port
- `hosts.{host}.emulators[].adb_server_port` the emulator's own adb server port
- `hosts.{host}.emulators[].avd` the AVD's name, or `null`
- `hosts.{host}.emulators[].created_at` an ISO time
- `hosts.{host}.emulators[].pids.*` the recorded processes (`role`, `pid`, `alive`, ...)
- `hosts.{host}.emulators[].resource` always `emulator`
- `hosts.{host}.emulators[].deploy_target` always `false`
- `hosts.{host}.emulators[].reachability.*` the Pool's Reachability (`unknown`: it has no transport yet)
- `registry.rev` the Registry's revision (`0` when the in-memory seed answers)
- `registry.source` `file` or `seed`
- `registry.resources[].id` as in `ResourceList`
- `registry.resources[].lock` as in `ResourceList`
- `registry.resources[].name` as in `ResourceList`
- `registry.resources[].kind` as in `ResourceList`
- `registry.resources[].host` as in `ResourceList`
- `registry.resources[].identity.*` as in `ResourceList` (QA redacted)
- `registry.resources[].capabilities.*` as in `ResourceList`
- `registry.resources[].deploy_target` as in `ResourceList`
- `registry.resources[].seeded` as in `ResourceList`
- `registry.resources[].seed_missing` as in `ResourceList`
- `registry.resources[].created_at` as in `ResourceList`
- `registry.resources[].retired_at` as in `ResourceList`
- `registry.resources[].visibility` as in `ResourceList`

`registry.resources` is the same list `GET /resources` serves (visible and retiring Resources, in the Registry's order), with no `reachability`: a Resource's Reachability is in its host's view only.

### StreamFrame

`GET /stream`: the change stream of the status document (FR-14, AD-43), the Candybar SSE wire. It is not JSON: the response is `text/event-stream` with `Cache-Control: no-store` and `X-Accel-Buffering: no`, and it stays open until the client or the service ends it. Loopback only, like every route.

- The first bytes of every connection are `retry: 3000` (a client reconnects after 3 s). A frame is `id: <boot>-<seq>`, `event: <type>` and one line `data: <JSON>`, ended by a blank line. The id matches `^[0-9a-f]{12}-[0-9]+$`: `<boot>` is 12 hex characters the service mints at each start, `<seq>` counts the frames of that boot from 1. The data starts with `type`, `seq`, `key` and `at`.
- Types. `ready` is the opening of a new connection (no `Last-Event-ID`) and carries the whole `/status` document in `status`. `status` is the whole document again (absolute: a client that has one needs no earlier one). `event` is one Event Log line, `event` with its id as `event_id` (its id in the Event Log, whichever way a client read it: a client dedupes on it). `reset` is the opening of a connection that cannot resume, with `reason: unresumable` and the whole document, and the client then refetches `/history` (the Event Log's read route, which is not in this contract yet).
- An opening frame (`ready` or `reset`) is per connection: its id is `<boot>-<cursor>` (the last seq emitted, `<boot>-0` before the first frame), it takes no seq of its own and is never replayed to another client.
- The service keeps the last 1024 frames of its boot. A `Last-Event-ID` of this boot whose seq is still covered by them (at least the oldest kept seq minus one, at most the cursor) resumes: the connection gets `retry: 3000` and then every frame after that seq, with no opening frame and no document. Any other id (another boot, so after a restart; a malformed id; an evicted or future seq) gets `reset`.
- A comment line `: keepalive` (no id) is sent after `api.stream_keepalive_s` (15 s) of silence on a connection, whatever else the other connections got. A client that falls far behind (more than 8 MiB buffered for it) is disconnected and reconnects with its last id; the replay of a connection's opening is not held to that bound.
- When the service stops, every stream ends, and a `GET /stream` that arrives while it stops is 503 `HUB_API_RESTARTING` (`retry: requeue`). A connection that needs the document (no `Last-Event-ID`, or one that gets `reset`) on a host that does not know its key is 503 `HUB_HOST_UNKNOWN`, with no stream; an exact resume never builds the document and does not read the host key.
- Live frames come from the change feed (Story 8.5, `tools/hub-api/changes.mjs`). The service watches (`fs.watch`, never `recursive`) the lock dir, `emulators/`, every `<name>.lock`, `<name>.queue` and `<name>.reservations` directory and the Event Log dir, and re-arms those watches on every notification, so a directory created or replaced later is watched from then on. Whatever name or kind of change the OS reports is ignored: any notification, from any writer (`hub-device`, a deploy job, the service itself), schedules one re-read after a fixed window of 250 ms from the first notification of a burst, so a change reaches a subscriber in well under 2 s. The re-read sends one `event` frame per new Event Log line (a month that rolls over is followed into the next file), then one `status` frame when the document changed.
- Nothing is emitted for a change that only time causes (a Hold's expiry, a grace end, a reading going stale, a heartbeat touching a lock's `alive` file): a re-read renders the document again as of the previous frame's instant, and sends no `status` frame when it is the same. A reader derives those fields from `at` and its own clock.

The fields of a frame's data:

- `type` `ready`, `status`, `event` or `reset`
- `seq` the frame's seq (for an opening frame, the cursor it resumes from)
- `key` `status` for a `status` frame, the event's id for an `event` frame, else the frame's type
- `at` an ISO time: when the frame was made, or the event's own `ts` for an `event` frame
- `reason` `unresumable`; only on a `reset` frame
- `status.*` the whole `/status` document, exactly the fields of `Status` above; on `ready`, `status` and `reset` frames
- `event_id` the Event Log line's id; only on an `event` frame
- `event.*` the Event Log line as its writer allowlisted it (no serials); only on an `event` frame

### Lease

`POST /leases`: status 200, the Lease that was taken (after a wait, when the body asked for one). For a phone it is the Lease `hub-device lease <word> --no-connect --json` would take; for an emulator (7.4) it is the Lease `hub-device lease emulator --json` would take, answered once the emulator is booted. It is the one view every service route that answers with a Lease uses (`leaseView` in `tools/device/claims.mjs`).

`POST /leases/{id}/extend`: status 200, the same shape for the Lease after the extension: `expires_at` is the later one (see "Request bodies").

`GET /leases/{id}`: status 200, the same shape for the Lease the id names, a phone's or an emulator's (a client whose connection dropped after the grant fetches its Hold here). A Lease that is still waiting for its lock holds nothing: 404 `HUB_LEASE_NOT_FOUND` with `reason: waiting` (so does an emulator that is still booting); an id nothing knows is 404 with `reason: unknown`.

- `lease_id` the Lease's id (the body's `id`, else one the lock layer minted)
- `resource` the Resource id the lock stands for (`emulator` for an emulator slot)
- `lock` the lock the Lease holds (`emulator-<n>`, the slot, for an emulator)
- `device` the word a Claimant says for the phone (what `hub-device lease --json` calls `device`), or `emulator`
- `holder` the body's `holder`
- `why` the body's `why`
- `claimant_kind` `agent` or `person`
- `started_at` an ISO time, when the Lease was taken
- `expires_at` an ISO time. An API Lease lives until then or until it is released: it is tied to no process, so a restart of the service never reclaims it
- `env.*` what a Claimant exports to use it: the same keys `hub-device lease --json` prints under `env`. A phone's are `HUB_LEASE_ID`, `HUB_DEVICE`, `ANDROID_ADB_SERVER_PORT`, and no `ANDROID_SERIAL`: a phone Lease taken here never finds the phone on adb. An emulator's are `HUB_LEASE_ID`, `ANDROID_ADB_SERVER_PORT` (the emulator's own adb server) and `ANDROID_SERIAL` (`emulator-<console port>`)
- `emulator.*` `null` for a phone. For an emulator an object with exactly `slot` (the slot lock, as `lock`), `serial` (the adb serial), `profile` (`default`, `playstore`), `console_port` and `adb_server_port`

### Release

`POST /leases/{id}/release`: status 200, what the release did with the id. It is `hub-device release <id>`: idempotent, so an id that holds nothing and waits for nothing is `outcome: none`, not an error.

- `lease_id` the id that was released
- `outcome` `released` (the Lease held its lock and gave it back), `cancelled` (the id was only a waiter: its place in line is withdrawn and it never held anything) or `none` (nothing held or waited under this id)
- `resource` the Resource id the lock stands for, or `null` for `none`
- `lock` the lock that was released or waited on, or `null` for `none`
- `device` the word a Claimant says for the phone, or `null` for `none`

### ForceRelease

`POST /leases/{id}/force-release`: status 200, the Lease `id` held, ended by force. It is `hub-device force-release <id> --why ...`: the Lease's lock is gone (the next waiter in line is served as after any release) and one `force-release` event records the actor and the `why`. Unlike a release it is not idempotent: an id that holds nothing is 404. `{id}` may also be an emulator slot, `emulator-<n>` (Story 7.8): the answer is the same shape for the Lease that held the slot, with `lease_id` that Lease's id, `lock` the slot and `device` `emulator`, and its emulator is torn down too.

- `lease_id` the id that was force-released
- `outcome` always `force-released`
- `resource` the Resource id the lock stands for
- `lock` the lock the Lease held
- `device` the word a Claimant says for the phone, or `null` for a lock that is no phone of this host's fleet (the iOS lane)
- `holder` who held the Lease
- `why` the `why` the force-release was given

### ReservationForceRelease

`POST /reservations/{run_key}/force-release`: status 200, a deploy run's Reservation ended by force. It is `hub-device force-release --reservation <run_key> --why ...`: a run that died (runner lost, workflow killed before `announce`) leaves its Reservation first in line on `adb` or `mac-ios` until its 3 h ceiling, and nothing outside the run could end it. The Reservation's directory is gone and one `force-release` event (`hold_kind: reservation`) records the actor and the `why`. Unlike a release by the run it is not idempotent: a run key with no Reservation is 404.

- `run_key` the run key that was force-released (`owner--repo--run`)
- `outcome` always `force-released`
- `repo` the run's repository (`owner/name`), from the released record
- `run` the run's id, from the released record
- `released[].lock` a lock whose Reservation of this run was ended (`adb`, `mac-ios`)
- `released[].resource` the Resource id the lock stands for
- `released[].reserved_at` an ISO time, when the Reservation was made
- `released[].expires_at` an ISO time, when its ceiling ends it
- `why` the `why` the force-release was given

### Cancel

`POST /requests/{id}/cancel`: status 200, a waiting request taken out of the line, and the queue of every lock it was taken out of as it stands afterwards. It is `hub-device cancel <id> --resource ...`. The request's own wait ends `HUB_LEASE_CANCELLED` and names the canceller. A Hold is never touched: a request that already holds its lock is 404 `HUB_REQUEST_NOT_FOUND` with `reason: held` (release it).

- `request_id` the id that was cancelled
- `outcome` always `cancelled`
- `resource` the Pool word for a Pool request (`phone`, `emulator`, `match:<query>`, as `pool`), else the Resource id of the lock the request was taken out of
- `pool` the Pool of a Pool request (`phone`, `emulator`, `match:<query>`), or `null` for a request on one lock
- `queues[].lock` a lock the request was taken out of (one for a request on one lock, one per member for a Pool request)
- `queues[].resource` the Resource id the lock stands for
- `queues[].waiters[].place` the waiter's place in that queue (1 is next)
- `queues[].waiters[].lease_id` the waiter's request id
- `queues[].waiters[].holder` who waits
- `queues[].waiters[].why` what the waiter wants it for
- `queues[].waiters[].kind` `lease`, `job` or `hub-job`
- `queues[].waiters[].enqueued_at` an ISO time, when the waiter took its place
- `queues[].waiters[].deadline_at` an ISO time, when it gives up, or `null`
- `queues[].waiters[].pool` the waiter's Pool when it is a Pool request, else `null`

`waiters` lists tickets only (a deploy job's included), never a Reservation, and a queue with nobody left is the empty array `waiters: []`.

### Problem

- `type` `urn:mobile-deploy-hub:problem:<code>`
- `title` the HTTP status text
- `status` the HTTP status
- `detail` a one-line message
- `code` the error code, from the list below
- `exit` the CLI exit code for this error
- `reason` a short machine-readable reason. The service's own are `no-route`, `method`, `bad-json`, `too-large` and `internal`; a library error carries its own `reason`, and an error with none gets its `code` in lower case

A code may add members to these fields (see "Problem extensions"); an extension never replaces one of them.

## Problem extensions

An error of these codes carries the named members besides the `Problem` fields above. The members only ever grow: a later story adds a row or a member, never removes one.

| Code | Members | Meaning |
|------|---------|---------|
| `HUB_REGISTRY_CONFLICT` | `rev` | The Registry's current revision, so a client can read again and retry. |
| `HUB_REGISTRY_DUPLICATE` | `holder` | The id of the live Resource that already has the serial or UDID. |
| `HUB_API_RESTARTING` | `retry` | Always `requeue`: the service is stopping, so ask again (a wait is placed again with the same `id`). `hub-client` raises the same code, with `api: false`, for a connection reset during a wait (the service died). |
| `HUB_FORCE_RELEASE_JOB` | `repo`, `run`, `job` | The run to cancel instead (`owner/name`, the run id, the job name); each is `null` when unknown (a local run, the catch-up). |

## Request bodies

**`POST /registry/resources`** registers a Resource. The body is a JSON object with only these keys:

- `kind` (required): `phone` or `ios-lane`.
- `name` (required): a slug of at most 28 characters (lowercase letters and digits, single dashes between). It becomes the word a Claimant says.
- `host` (required): a host key (`linux` or `mac`). An `ios-lane` must be on `mac`.
- `identity`: an object with only `serial`, `model`, `udid` and `profile`, each a non-empty string. A `phone` needs `model`; an `ios-lane` needs no identity.
- `capabilities`: a flat object (default `{}`). Keys match `^[a-z][a-z0-9_]*$` and are not `allowed_users`, `id`, `name`, `kind`, `host`, `model` or `deploy_target`. A value is a string, a finite number or a boolean.
- `if_rev`: a whole number. When present, the register is refused unless the Registry is at that revision (`HUB_REGISTRY_CONFLICT`). When absent there is no revision check: the name and identity checks run against the Registry as it is when the write commits. A missing Registry file is revision 0, and `if_rev: 0` is accepted for it.
- `actor`: `{holder, via}`, recorded as given. When absent the actor is `{holder: <holder>, via: 'api'}`.
- `holder`: who is registering, used when there is no `actor`. One of the two is required.
- `why`: a string, recorded with the change.

The Resource gets the id and lock `res-<name>`, or `res-<name>-<n>` (the smallest free `n` from 2) when a record, retired ones included, already has that id or lock. A missing Registry file is first written as the seed, as its own revision, then the register is the next one. Exactly one `registry-add` event is logged for the register; it names no identity.

Refusals, in the order they are checked: `HUB_USAGE` 400 for the body (`bad-body`, `bad-kind`, `bad-host`, `bad-identity`, `no-model`, `bad-capabilities`, `bad-if-rev`, `bad-why`, `bad-actor`, `no-holder`); `HUB_REGISTRY_NAME` 400 for a name that is not a slug (`not-slug`) or is over 28 characters (`too-long`); `HUB_REGISTRY_CONFLICT` 409 for a stale `if_rev`; `HUB_REGISTRY_NAME` 409 for a reserved word (`reserved`), a name any Resource already has as a name, id, lock or word (`taken`), or no free `-<n>` up to 999 (`exhausted`); `HUB_REGISTRY_DUPLICATE` 409 for a serial or UDID a live Resource (neither retired nor seed-missing) has (`reason: serial` or `udid`, member `holder`). A retired or seed-missing Resource's identity is free, its name is not.

**`POST /registry/resources/{id}`** edits a Resource's name and Capabilities. The body is a JSON object with only these keys:

- `name`: a slug of at most 28 characters. `display_name` follows it. `id` and `lock` never change.
- `capabilities`: a merge patch. Each key is set to a string, a finite number or a boolean, or removed by `null`; keys it does not name are kept (`dedicated_qa` included). Key rules are the register's.
- `if_rev` (required): a whole number, the revision the edit is based on. Absent is `no-if-rev`; a stale one is `HUB_REGISTRY_CONFLICT` (with `rev`). A missing Registry file is revision 0, and `if_rev: 0` is accepted for it (the seed is written first).
- `actor`, `holder`, `why`: as for a register.
- `id`, `lock`, `kind`, `host` and `identity` are accepted by the body check and always refused, by presence and not by value.

The body must name at least `name`, `capabilities` or one of the refused keys (`no-change` otherwise). An edit that changes nothing commits nothing, logs nothing and answers the current `rev`. Exactly one `registry-edit` event is logged for an edit that changes something; it names no identity.

Refusals, in the order they are checked: `HUB_USAGE` 400 for the body (`bad-body`, `no-if-rev`, `bad-if-rev`, `bad-why`, `bad-capabilities`, `bad-actor`, `no-holder`, `no-change`); `HUB_REGISTRY_NAME` 400 for a name that is not a slug (`not-slug`) or is over 28 characters (`too-long`); `HUB_REGISTRY_CONFLICT` 409 for a stale `if_rev`; `HUB_RESOURCE_NOT_FOUND` 404 (`unknown`); `HUB_RESOURCE_RETIRED` 409 for a retired (`retired`) or seed-missing (`seed-missing`) Resource; for a seeded Resource `HUB_REGISTRY_SEEDED` 409 (`reason` the first refused key of `id`, `lock`, `kind`, `host`, `identity`; or `name` for a different name: a hub release changes those, and the seed overwrites them at each start; its Capabilities stay editable and survive a re-seed); for a runtime Resource `HUB_USAGE` 400 `immutable` for any of those keys; then `HUB_REGISTRY_NAME` 409 for a different name that is reserved (`reserved`) or that any other Resource has as a name, id, lock or word (`taken`, retired ones included).

**`POST /registry/resources/{id}/retire`** retires a Resource. The body is a JSON object with only these keys: `if_rev` (optional, as for a register), `actor`, `holder` and `why`. Exactly one `registry-retire` event is logged, none for a Resource that is already retired.

Refusals, in the order they are checked: `HUB_USAGE` 400 for the body (`bad-body`, `bad-if-rev`, `bad-why`, `bad-actor`, `no-holder`); `HUB_REGISTRY_CONFLICT` 409 for a stale `if_rev`; `HUB_RESOURCE_NOT_FOUND` 404 (`unknown`); `HUB_REGISTRY_SEEDED` 409 (`reason: retire`) for a seeded Resource. A retire is never undone: `retired_at` is not cleared.

**`POST /leases`** takes a Lease on a phone, with no wait. The body is a JSON object with only these keys:

- `resource` or `match` (exactly one): `resource` is a device word (`s24`, `s26`, a registered phone's name, the Pool word `phone`, or `emulator`) or a Resource id (`res-…`); `match` is a Capability query (`kind=phone`). An emulator is leased by the word `emulator`, or by a `match` with one `profile=<name>` clause (`profile=playstore`; the profile is a clause, not a body key) or one that only the emulator Pool satisfies (`kind=emulator-pool`, profile `default`). A lease id is never a target.
- `for_ms` (required): a whole number of milliseconds, more than 0. At most 48 h for any Lease and at most 60 min on a deploy target (the S26); the `phone` Pool is narrowed to the phones that allow it, so over 60 min it is the S24.
- `holder` (required): who holds the Lease, recorded as given.
- `why` (required): a non-empty string, what the Lease is for.
- `claimant_kind`: `agent` (the default) or `person`. Recorded on the owner record and on every event of the Lease.
- `wait_ms`: a whole number of milliseconds, 0 or more (default 0, no wait). With more than 0 the request waits for its place in line up to that long, with the connection open and nothing written until the outcome; it needs an `id`.
- `id`: the Lease's id: lowercase letters, digits and dashes, at most 64. An id that already names a Lease or a waiter on any phone is refused, except by the same `holder` (see "Waits"). When absent one is minted (a request with no wait only).
- `actor`: `{holder, via}`, recorded as given on the take's events. When absent the actor is `{holder: <holder>, via: 'api'}`.

A key not listed is `bad-body`. A phone take is `hub-device lease <word> --no-connect`: the lock only (the owner record has `holder_pid: null` and no `device.adb_id`), `findPhone` never runs and adb is never asked. The service's environment is stripped of every `GITHUB_*` key before it is used, so no Lease or event of the API names a repo or a run. For a `match` the members whose reading in the service's own cache is `absent`, `offline` or `unauthorized` are dropped (an `unknown` or missing reading drops nothing); a word is never away, as for `--no-connect` on the CLI.

An emulator take (7.4) is `hub-device lease emulator` through the same Claims calls, with the Hold lock-only and expiry-bound like a phone's (its slot owner has `holder_pid: null` once it is ready, and is never reclaimed for a dead process). It answers when the emulator has booted, which takes minutes, so a client sets a long timeout; the boot and the reap run in a worker thread, so no other request waits for it. The pool's size is the host's, in this order: the `emulator-pool` file in the lock dir, the Registry's `pools.emulator.size`, then 2, each 1 to 8 (`HUB_EMULATOR_POOL` is the CLI's alone; the service ignores it). The Pool request and the `acquire` events carry the `actor` and `claimant_kind`. A client that goes away while the emulator boots aborts the boot: what was made is torn down, the slot is released and the Pool request ends with a `cancel` (`reason: aborted`), and nothing is answered; a Hold granted after the connection closed is released at once (`release`, `reason: undelivered`) and torn down. A repeat of an `id` the same `holder` already holds answers the existing Lease. A stop of the service ends every request still being served (a boot included) as `HUB_API_RESTARTING`; an emulator the service leaves booting when it dies is torn down by the next emulator reap (`holder gone`).

Refusals, in the order they are checked: `HUB_USAGE` 400 for the body (`bad-body`, `bad-target`, `bad-for`, `bad-wait`, `bad-claimant-kind`, `bad-id`, `no-id`, `bad-actor`, `no-holder`, `bad-why`), all before anything is read; `HUB_USAGE` 400 for an unknown device word, an `id` that is already taken, a `profile` clause that is not `profile=<name>` or is given twice, and a `for_ms` over 48 h or over a deploy target's cap (the message names the cap; the deploy-target one ends `lease s24 or an emulator for longer`), with nothing written; `HUB_RESOURCE_RETIRED` 409 (`retired`, `seed-missing`) for a Resource the Registry marks retired or seed-missing; `HUB_NO_MATCH` 404 (`no-match`) when a `match` finds nothing, or when an emulator's profile is unknown or its system image is not installed (`detail` names the image, or the known profiles), with no ticket, lock or event written; `HUB_POOL_CROSS_HOST` 409 when its members span hosts; `HUB_DEVICE_AWAY` 503 (`away`) when every member of a `match` is known away; `HUB_LOCK_TIMEOUT` 409 (`busy`) when the lock is held or anyone waits and no wait was asked for: `detail` keeps `host lock <name> is held …`, and no event is written (a full emulator Pool is the same answer, `detail` `the emulator pool is full …`, with its Pool `request` and `timeout` events); `HUB_EMULATOR_FAILED` 503 (`emulator-failed`) when the emulator does not boot (everything it made is torn down). A wait that runs out of time is the same answer (the `timeout` event is written, and for a Pool `detail` starts `host lock <lock> is held by …` for each held member).

**Waits** (`wait_ms` more than 0, `POST /leases`). The wait is the CLI's `hub-device lease --wait`: one place in line in the queue of the Resource (of every member of a Pool), a `request` event, then one `acquire`, `timeout` or `cancel`. It is bound to the HTTP connection, so a vanished client holds no place and is granted no Hold nobody receives:

- The client mints the `id`, so it can ask again after a lost answer. The server writes nothing, no status line and no header, until the outcome. Every answer of `POST /leases` that knows the id (the body's `id`, else the minted `lease_id` of a success) carries `X-Request-Id: <id>`.
- The ticket's `pid` is the serving process and it carries `claimant_kind`, so a `prune`, `cancel` or `timeout` names the right kind. Nothing is asked of the system for a pid more than once per 2 s.
- The connection closing before the answer is written ends the wait: the ticket is gone and the Event Log has a `cancel` with `reason: aborted`. A Hold granted after that is released at once (a `release` with `reason: undelivered`); a Hold granted before it, with its answer written, stands, and `GET /leases/{id}` returns it.
- A repeat of an `id` already held by the same `holder` answers 200 with the existing Lease (no second take, no event), whether or not it asks for a wait. A repeat of an `id` held by another `holder` is `HUB_USAGE` 400 as any taken id.
- A repeat with the `id` and `holder` of a wait that is still open takes it over: the wait goes on with its original Resource, `for_ms` and deadline and keeps its place (no event), the new connection gets the outcome, and the old connection gets `HUB_LEASE_SUPERSEDED` 409.
- When the service stops (`SIGTERM`), every open wait gets `HUB_API_RESTARTING` 503 with `retry: requeue` and its ticket is withdrawn (a `cancel` with `reason: aborted`); a request that arrives while it stops gets the same. A client places its wait again with the same `id` when the service is back. When the service dies instead (a crash, `SIGKILL`), `hub-client`'s `call()` turns a connection reset during a wait (`waitMs > 0`) into the same `HUB_API_RESTARTING` with `retry: requeue` and `api: false` (a service's own 503 has `api: true`), and `requeueable(error)` is the one test a caller uses to place the wait again; a reset on a write with no wait stays `HUB_API_UNKNOWN`. For a phone wait the dead service's ticket no longer names the `id` (a stale ticket is ignored by the id check), so the repeat is granted exactly one Lease, and the take prunes the dead ticket. An emulator request the crash cut short keeps its `id` taken until the next emulator reap (`holder gone`) tears the orphan down, so it is placed again with a new `id`.

**`POST /leases/{id}/extend`** moves a phone or an emulator Lease's expiry later (AD-16). `{id}` is the Lease's id; there is no holder check (no authentication, so the id is the handle, as on the CLI). The body is a JSON object with only these keys:

- `for_ms` (required): a whole number of milliseconds, more than 0, added to the Lease's current `expires_at`.
- `holder`: who is extending, used when there is no `actor`.
- `actor`: `{holder, via}`, recorded as given. When absent the actor is `{holder: <holder>, via: 'api'}`; one of the two is required (`no-holder`).
- `override`: `{why, actor?}`. `why` is a non-empty string. The override skips the waiters check and nothing else: an expired Lease, the deploy-target cap (60 min) and the 48 h limit still refuse. Its `actor` defaults to the request's actor.

Refusals, in the order they are checked: `HUB_USAGE` 400 for the body (`bad-body`, `bad-for`, `bad-actor`, `bad-override`, `no-holder`), before anything is read; `HUB_DEVICE_JOB_ID` 400 for a `job:` id (a deploy job's place in line, not a lease: the message names the run to cancel); `HUB_LEASE_NOT_FOUND` 404 (`waiting`, `unknown`) for an id that holds nothing (an emulator still booting is `waiting`: its expiry is set when it is ready); `HUB_LEASE_EXTEND_REFUSED` 409 with a `reason`: `expired` (now is at or after `expires_at`), `waiters` (anyone waits in the Resource's queue, a Pool request included; `detail` names each waiter with its place), `cap` (a deploy target would run over 60 min in total, counted from `started_at`) or `too-long` (over 48 h in total). A refusal writes nothing. An extension writes one `extend` event with `actor`; an override also records `why`, and `reason: override` when it skipped waiters that were there (an override sent with nobody waiting records no `reason`, so the log shows when the rule was actually overridden). `HUB_LEASE_LOST` 409 when the lock changed hands between the read and the rewrite.

**`POST /leases/{id}/release`** gives a phone or an emulator Lease back, or withdraws a waiter. The body is a JSON object with only `holder` and `actor`, as for an extend (`bad-body`, `bad-actor`, `no-holder`); there is no holder check. A `job:` id is `HUB_DEVICE_JOB_ID` 400. A phone's lock is released through the library's `releaseLease`: a Lease writes one `release` event (`reason: by-id`) with `actor`, a waiter one `cancel` event with `actor`. An emulator lease id is released as `hub-device release <id>` does, its teardown (its processes, AVD and ports) run in a worker thread: `released` (the answer's `lock` is the slot), or `cancelled` for a request still waiting its turn (`lock` is `emulator`, `device` `emulator`); an emulator whose processes would not stop is `HUB_EMULATOR_FAILED` 503. An emulator release records no `actor` yet. A lock that is being taken or changed hands since the read is left alone: `HUB_LEASE_LOST` 409 (`reason: being-taken`, `changed-hands`).

**`POST /leases/{id}/force-release`** ends a Lease by force (Story 7.6). `{id}` is the Lease's id; it is looked for on every lock of this host (a phone's, a registered phone's, the iOS lane's, any `res-*` lock), never on another host. There is no holder check and no confirmation step: the caller says who and why, and both are recorded. The body is a JSON object with only these keys:

- `why` (required): a non-empty string, recorded on the event and answered back.
- `actor`, `holder`: as for an extend (`actor` as given, else `{holder, via: 'api'}`; one of the two is required).

The Lease's owner is renamed to a tomb by the one writer (`forceRelease`, `tools/ci/lib/lock.mjs`: the rename decides) and one `force-release` event is written with `hold_kind: lease`, `lease_id`, the Lease's `claimant` and `held_ms`, `actor` and `why` (`reason` is `null`). A waiter already in line is served next. A deploy job's Hold is never ended from outside its run, and a waiter or a Reservation is not a Lease.

**`{id}` = `emulator-<n>` (Story 7.8)** force-releases an emulator slot (`emulator-1` to `emulator-8`; `hub-device force-release emulator-<n> --why ...` is the same call, one Claims function, `forceReleaseEmulator`). The slot's Lease is found by the slot, not by its id (an emulator lease id, `e-...`, is still refused above). The order is fixed: read the slot's owner and emulator record; under the `emulator-reaper` lock write the one `force-release` event (the owner's `lease_id`, `actor`, `why`); tear the emulator down (its recorded processes, AVD, folders) and remove its record; release the reaper lock. The reaper lock, the force and the teardown run in a worker thread. The teardown writes no `release`, so the Lease ends with exactly one event, also across a crash: a crash after the force leaves an ownerless record that the next emulator acquire's reap tears down as an orphan, writing nothing, and the slot stays out of the pool while the record exists. The body is the same. Refusals, before anything is written: `HUB_USAGE` 400 `bad-slot` (`emulator-0`, `emulator-9`, `emulator-01`); `HUB_LEASE_NOT_FOUND` 404 `unknown` (the slot holds nothing); `HUB_LEASE_LOST` 409 (`being-taken`; `changed-hands`: the owner changed between the read and the rename, nothing was torn down); `HUB_LOCK_TIMEOUT` 409 when another teardown holds the reaper lock for more than 2 min. A recorded process that outlives SIGKILL is `HUB_EMULATOR_FAILED` 503: the force stands (the event is written and the slot lock is gone), the record stays, and the next reap retries.

Refusals, in the order they are checked: `HUB_USAGE` 400 for the body (`bad-body`, `no-why`, `bad-why`, `bad-actor`, `no-holder`), before anything is read; `HUB_FORCE_RELEASE_JOB` 409 for a `job:` id (a deploy job's place in line), or for a Job Hold that took the Lease's lock between the find and the rename (a lock name is no Lease id: naming a lock a job holds is `HUB_LEASE_NOT_FOUND` `unknown`), with `repo`, `run` and `job` and a `detail` that names `gh run cancel <run> --repo <repo>` (a local run or the catch-up has none: it says to stop the process); `HUB_USAGE` 400 with `reason: emulator` for an id that holds an emulator slot or the `emulator` gate or has an emulator record (its slot's force-release tears it down: Story 7.8); `HUB_LEASE_NOT_FOUND` 404 (`waiting` for an id that only waits: cancel it instead; `unknown`); `HUB_LEASE_LOST` 409 (`changed-hands`, `being-taken`) when the lock changed hands between the read and the rename: nothing was written and the new owner is untouched.

**`POST /reservations/{run_key}/force-release`** ends a deploy run's Reservation by force (Story 7.7). `{run_key}` is the run's key, `owner--repo--run`; it is looked for on the reservable locks of this host (`adb` on big-chungus, `mac-ios` once the Mac's Host Agent serves the same call), never on another host. There is no holder check and no confirmation step: the caller says who and why, and both are recorded. The body is a JSON object with only these keys:

- `why` (required): a non-empty string, recorded on the event and answered back.
- `name`: `adb` or `mac-ios`, to touch one lock only; absent tries every reservable lock of this host (a run key can hold one on each host), and `released` lists each one ended.
- `actor`, `holder`: as for an extend (`actor` as given, else `{holder, via: 'api'}`; one of the two is required).

The Reservation's directory is renamed to `.released-<key>-<ms>` and removed by the one writer (`releaseReservation` with an `actor`, `tools/ci/lib/lock.mjs`: the rename decides) and one `force-release` event is written with `hold_kind: reservation`, `run_key`, `held_ms`, the run as its `claimant`, `actor` and `why` (`reason` is `null`). Two force-releases at once, or one racing the run's own release or the ceiling's prune, end the Reservation once with one event; the loser is the 404. A Reservation past its ceiling that nothing pruned yet is still a directory and is force-released like a live one. A deploy job never calls this: `announce` and the ssh `reservation release` verb write a plain `release`.

Refusals, in the order they are checked: `HUB_USAGE` 400 for the body (`bad-body`, `no-why`, `bad-why`, `bad-actor`, `no-holder`, `bad-name`), before anything is read; `HUB_USAGE` 400 `bad-run-key` for a key that is not `owner--repo--run`, and `bad-name` for a `name` that is not `adb` or `mac-ios`; `HUB_RESERVATION_NOT_FOUND` 404 (`unknown`) when no Reservation of that run key exists on this host (already released, never reserved, or its record is unreadable), with no event written.

**`POST /requests/{id}/cancel`** takes a waiting request out of the line (Story 7.5). `{id}` is the request's id (the Lease id of a waiter, the Lease id an emulator request was made with); there is no holder check (no authentication, so the id is the handle, as on the CLI). The body is a JSON object with only these keys:

- `resource` (required): a non-empty string naming the Resource the request waits on: a device word (`s24`, a registered phone's name, `phone`, `emulator`) or a Resource id. The service never searches the fleet by request id.
- `pool`: a non-empty string, the Pool of a Pool request (`phone`, `match:<query>`). A request made on a Pool is found only with its `pool`, and a request on one lock only without one: a Pool request cancelled without its `pool` (or with another) is `HUB_REQUEST_NOT_FOUND`. The emulator request is a Pool request whose one queue is the gate's: `emulator` is its Pool, and giving it is accepted.
- `host`: a non-empty string, a host key. It must be this host's key (`HUB_WRONG_HOST` 409 otherwise); a service whose own key is unreadable answers `HUB_HOST_UNKNOWN` 503. A cancel never reaches another host.
- `why`: a non-empty string, recorded on the ending event.
- `actor`, `holder`: as for an extend (`actor` as given, else `{holder, via: 'api'}`; one of the two is required).

The request is taken out of its queue (out of every member's queue for a Pool request) by the one writer of the queue (`cancelRequest`, `tools/ci/lib/lock.mjs`), which first leaves a note naming the actor and `why` for the waiter. A request on one lock ends with one lock-level `cancel` event (`reason: cancelled`, with `actor` and `why`); a Pool request ends with its one Pool-level `cancel` event (`lock: null`, `reason: cancelled`, with `actor` and `why`, written by the request's own wait), and no lock-level one. An emulator request ends as a release of one does: its gate wait with the gate's lock-level `cancel` and the Pool request around it with its Pool-level `cancel`, both with the canceller's `actor` and `why`. The waiter's own wait fails `HUB_LEASE_CANCELLED` (`reason: cancelled`) saying `cancelled by <holder>`.

Refusals, in the order they are checked: `HUB_USAGE` 400 for the body (`bad-body`, `no-resource`, `bad-resource`, `bad-pool`, `bad-host`, `bad-why`, `bad-actor`, `no-holder`), before anything is read; `HUB_DEVICE_JOB_ID` 400 for a `job:` id or the ticket of a deploy job (deploy jobs are cancelled through GitHub: `gh run cancel`); `HUB_WRONG_HOST` 409; `HUB_HOST_UNKNOWN` 503; `HUB_REQUEST_NOT_FOUND` 404 with `reason: unknown` for a Resource this host does not know, an id nothing waits under (also a request that was granted or withdrew as the cancel ran), a Pool request named without its Pool; `HUB_CANCEL_RESERVATION` 409 for a Reservation key (force-release it); `HUB_REQUEST_NOT_FOUND` 404 with `reason: held` for a request that already holds its lock (release it: `POST /leases/{id}/release`).

For every write route the actor is `actor` as given, else `{holder, via: 'api'}`, else `no-holder`; the body is checked before the name's shape, which is checked before anything is read from the Registry.

## Error codes

| Code | Status | Exit | Meaning |
|------|--------|------|---------|
| `HUB_NO_ROUTE` | 404, 405 | 2 | No such path (`reason: no-route`), or the path exists and the method is not allowed (`reason: method`, with an `Allow` header). |
| `HUB_RESOURCE_NOT_FOUND` | 404 | 2 | No Resource has this id (`reason: unknown`), or on a read it is retired and idle (`reason: retired`). The write routes (`/registry/resources/{id}` and `/retire`) answer only `unknown`. |
| `HUB_RESOURCE_RETIRED` | 409 | 2 | An edit of a Resource that is retired (`reason: retired`) or no longer in `devices.json` (`reason: seed-missing`). Also what `POST /leases` refuses a take of one with, with the same reasons. |
| `HUB_REGISTRY_SEEDED` | 409 | 2 | A retire (`reason: retire`), an edit of `id`, `lock`, `kind`, `host` or `identity` (`reason` is that key) or a different name (`reason: name`) of a seeded Resource: a hub release changes those. |
| `HUB_USAGE` | 400, 413 | 2 | The request body is not valid JSON (`bad-json`) or is over 1 MiB (`too-large`), or a write body is wrong (`bad-body`, `bad-kind`, `bad-host`, `bad-identity`, `no-model`, `bad-capabilities`, `bad-if-rev`, `no-if-rev`, `bad-why`, `bad-actor`, `no-holder`, `no-change`), or an edit names a key a runtime Resource keeps for good (`immutable`). An extend body is wrong with `bad-body`, `bad-for`, `bad-actor`, `bad-override` or `no-holder`, a release body with `bad-body`, `bad-actor` or `no-holder`, a cancel body with `bad-body`, `no-resource`, `bad-resource`, `bad-pool`, `bad-host`, `bad-why`, `bad-actor` or `no-holder`, a force-release body with `bad-body`, `no-why`, `bad-why`, `bad-actor` or `no-holder` (`reason: emulator` for an emulator lease id, which is the slot's to force-release, and `bad-slot` for `emulator-<n>` outside 1 to 8), a Reservation force-release body with `bad-body`, `no-why`, `bad-why`, `bad-actor`, `no-holder` or `bad-name`, and a run key that is not `owner--repo--run` with `bad-run-key`. A lease body is wrong with `bad-body`, `bad-target`, `bad-for`, `bad-wait`, `bad-claimant-kind`, `bad-id`, `no-id`, `bad-actor`, `no-holder` or `bad-why`; a lease request the library refuses (an unknown word, a bad `profile` clause, a taken `id`, a `for_ms` over a cap) has `reason: hub_usage` and a `detail` that says why. |
| `HUB_LOCK_TIMEOUT` | 409 | 76 | `POST /leases`: the lock is held or someone waits (`reason: busy`), or a wait ran out of time; `POST /leases/emulator-<n>/force-release` while another teardown holds the `emulator-reaper` lock for 2 min (nothing was written). `detail` keeps the library's wording, `host lock <name> is held …` (for a Pool, once per held member; a full emulator Pool says `the emulator pool is full …`); a try writes no event, a wait ends with its `timeout` event. |
| `HUB_DEVICE_AWAY` | 503 | 75 | `POST /leases` with a `match` whose every member the service's cache knows is away: `absent`, `offline` or `unauthorized` (`reason: away`). |
| `HUB_NO_MATCH` | 404 | 2 | `POST /leases` with a `match` nothing can serve, or an emulator profile that is unknown or whose image is not installed (`reason: no-match`); `detail` says what excluded each Resource, or names the image. |
| `HUB_EMULATOR_FAILED` | 503 | 1 | `POST /leases` for an emulator that did not boot (the message says why; everything it made is torn down), `POST /leases/{id}/release` of one whose processes would not stop, or `POST /leases/emulator-<n>/force-release` of a slot whose emulator would not die (the force stands; `reason: emulator-failed`). |
| `HUB_POOL_CROSS_HOST` | 409 | 2 | `POST /leases` with a `match` whose members are on more than one host. |
| `HUB_LEASE_NOT_FOUND` | 404 | 2 | `GET /leases/{id}`, an extend and a force-release (the release answers `none`): no Lease holds this id. `reason: waiting` when a waiter has it (it holds nothing yet), `reason: unknown` otherwise. |
| `HUB_LEASE_EXTEND_REFUSED` | 409 | 76 | `POST /leases/{id}/extend`: the extension is refused and nothing was written. `reason` is `waiters`, `expired`, `cap` or `too-long`. |
| `HUB_LEASE_CANCELLED` | 409 | 1 | `POST /leases`: a wait ended without a Hold: its place was released while it waited, or it was taken out of the line by `POST /requests/{id}/cancel` (`reason: cancelled`; `detail` says `cancelled by <holder>` and the `why` given). |
| `HUB_LEASE_LOST` | 409 | 1 | `POST /leases/{id}/extend`, `/release` or `/force-release`: the lock changed hands between the read and the write (`reason` is `hub_lease_lost` on an extend, `being-taken` or `changed-hands` on a release or a force-release). Nothing of this request's was written. |
| `HUB_REQUEST_NOT_FOUND` | 404 | 2 | `POST /requests/{id}/cancel`: no waiting request has this id on the Resource (`reason: unknown`), or the request already holds its lock and is a Lease to release (`reason: held`). |
| `HUB_CANCEL_RESERVATION` | 409 | 2 | `POST /requests/{id}/cancel` with the key of a deploy run's Reservation (`reason: reservation`): a cancel never takes one; `detail` says to force-release it: `POST /reservations/{run_key}/force-release` (`hub-device force-release --reservation <key> --why ...`). |
| `HUB_WRONG_HOST` | 409 | 2 | `POST /requests/{id}/cancel` whose `host` is not this host's key (`reason: wrong-host`): a cancel never reaches another host. |
| `HUB_DEVICE_JOB_ID` | 400 | 2 | `POST /leases/{id}/extend`, `/release` or `POST /requests/{id}/cancel` with a `job:` id (or, for a cancel, the id of a deploy job's ticket): a deploy job's place in line is not a lease, and the hub never extends, releases or cancels it; `detail` names the run to cancel (`gh run cancel`). |
| `HUB_FORCE_RELEASE_JOB` | 409 | 2 | `POST /leases/{id}/force-release` of a deploy job's Hold (`reason: job`): a Job Hold is only ended by cancelling its run; `repo`, `run` and `job` name it and `detail` says `gh run cancel`. |
| `HUB_RESERVATION_NOT_FOUND` | 404 | 2 | `POST /reservations/{run_key}/force-release`: no Reservation of this run key exists on this host (`reason: unknown`): already released or pruned, never reserved, or its record is unreadable. Nothing was written. |
| `HUB_LEASE_SUPERSEDED` | 409 | 1 | `POST /leases`: a newer request with the same `id` and `holder` took over this wait (`reason: superseded`). The wait itself goes on. |
| `HUB_API_RESTARTING` | 503 | 1 | The service is stopping (`reason: restarting`; member `retry: requeue`). Every open wait gets it, and so does a lease request that arrives while it stops; every open `GET /stream` is ended, and a `GET /stream` that arrives while it stops gets it too. |
| `HUB_REGISTRY_NAME` | 400, 409 | 2 | A register's or edit's name is not a slug (`not-slug`) or is too long (`too-long`) with 400; reserved (`reserved`), already used (`taken`) or out of `-<n>` suffixes (`exhausted`) with 409. |
| `HUB_REGISTRY_DUPLICATE` | 409 | 2 | A live Resource already has the serial (`reason: serial`) or UDID (`reason: udid`); `holder` names it. |
| `HUB_REGISTRY_CONFLICT` | 409 | 1 | `if_rev` is not the Registry's revision; `rev` is the current one. |
| `HUB_HOST_UNKNOWN` | 503 | 1 | `GET /discovery` or `GET /status` on a host that does not know which host it is (`reason: host-unknown`): `~/.config/mobile-deploy-hub/host-key` is missing, empty, unknown or for another platform. `mise run hosts:install` writes it. |
| `HUB_REGISTRY_FORMAT` | 409 | 1 | `registry.json` exists and cannot be read, or is a format this service does not know. It is never written. |
| `HUB_API_ERROR` | 500 | 1 | A bug in the service. The detail is one line; the journal has the same line. |
| `HUB_API_ALREADY_RUNNING` | none | 1 | Start only: the port is taken. Never an HTTP answer. |
| `HUB_API_NODE` | none | 1 | Start only: Node is older than 24.15. |
| `HUB_API_NO_HEAVY` | none | 1 | Start only: `heavy` is not on `PATH`. |
| `HUB_API_DOWN` | none | 1 | Client side only (`tools/hub-client.mjs`), never an HTTP answer: `GET /health` was refused, silent for 2 s, not a 200 or not this service, or the request itself was refused, so nothing was sent. |
| `HUB_API_UNKNOWN` | none | 1 | Client side only, never an HTTP answer: a write was sent and the answer did not come (timeout, reset, or something that is not a problem document), so it may have applied. `hub-device registry list` shows. |
| `HUB_DEVICE_AWAY` | none | 75 | Client side only (`request()`, see Cross-host calls), never an HTTP answer: the ssh leg to the other host failed (`reason: host-unreachable`, `api: false`). Nothing was sent to the far service, or the call's bound passed. |

## Cross-host calls

`tools/hub-client.mjs` is the one way a host calls the other host's loopback service (AD-26). `request({host, method, path, body, waitMs, budgetMs}, seams)` returns a `fetch` `Response`; `host` is `linux` or `mac`. There is no second transport, no retry and no bare `curl`.

- **Same host.** `fetch` to this host's own front door on loopback: `http://127.0.0.1:<port>` where the port is `api.hub_api_port` for `linux` and `api.host_agent_port` for `mac`. The signal aborts at the call's bound, which is `waitMs + budgetMs + 30 s`. A failure is the `fetch` error, unchanged.
- **Peer.** One ssh call to the peer's alias (`devices.<key>.host`: `hub-mac` from big-chungus, `big-chungus` from the Mac), killed at the bound plus 10 s:

  `ssh -T -o BatchMode=yes -o ConnectTimeout=<api.peer_connect_timeout_s> -o ControlMaster=no -o ControlPath=none -o ServerAliveInterval=15 -o ServerAliveCountMax=2 <alias> <command>`

  `<command>` is single-quoted words joined by spaces (`'` is written `'\''`): `.local/share/mise/installs/node/24/bin/node .local/share/mobile-deploy-hub/current/tools/hub-client.mjs relay <METHOD> <path>`. Both fixed paths are under the login home, where ssh starts the command, and never go through a `PATH` lookup.

### The relay wire

`hub-client.mjs relay <method> <path>` runs on the peer and calls that host's own front door (`http://127.0.0.1:<its port><path>`, the port of its own host key).

- **stdin.** Line 1 is the JSON body, or empty for none. After it every byte is a heartbeat: the client writes `\n` every `api.stream_keepalive_s` seconds. The relay aborts its loopback request on stdin EOF, or when 3 intervals pass with no byte; it then writes nothing and exits 1. The far service sees a client disconnect, so a wait the client abandoned records `cancel` (`reason: aborted`) and is never a ghost waiter.
- **stdout.** Line 1 is a JSON head, then the raw body bytes to EOF: `{"format":1,"status":<n>,"headers":{...}}` (hop headers and `content-length` are not carried), or `{"format":1,"error":{"code":"<cause code>","message":"..."}}` when the peer-side fetch failed. The client rejects an error head as a `TypeError('fetch failed')` with `cause.code` set to that code, so a caller classifies it as it does a same-host failure. A 204, 205 or 304 has a `null` body.
- **Usage.** A method that is not GET, POST, PUT, PATCH or DELETE, a path that does not start with `/` or holds whitespace or control characters, or a body line that is not JSON (or a body on a GET) is an error head with code `HUB_RELAY_USAGE` and exit 2; no request is made. Run with no `relay` or other arguments, it prints the usage on stderr and exits 2.

### When the ssh leg fails

A failure to connect (ssh exit 255), an ssh that does not start, a stdout whose first line is not a valid head, an exit with no head, or the bound plus 10 s passing is `HUB_DEVICE_AWAY`: exit 75, `reason: host-unreachable`, `api: false`. The message names the host, its alias and `connect timeout <n> s`. ssh is killed on the bound path, and the heartbeat is cleared on every path.

## For the v1c module (non-binding)

A Holocene module for this service would use module id `mobile-deploy-hub` and read its base URL from `MOBILE_DEPLOY_HUB_API_URL`, defaulting to `http://127.0.0.1:8794`. This is a proposal, not part of the contract (open question Q3).
