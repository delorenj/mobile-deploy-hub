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
- In a shape's field list, `a.b` is a key of the object `a`; `a[].b` is a key of the objects in the array `a`; `a.*` is an open object whose keys this document does not list (a client reads what it knows and ignores the rest). An array of plain values is listed as the array itself.
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
| POST | `/registry/resources` | Resource | 6.6 |
| POST | `/registry/resources/{id}` | Resource | 6.7 |
| POST | `/registry/resources/{id}/retire` | Retirement | 6.7 |
| POST | `/leases` | Lease | 7.1 |
| GET | `/leases/{id}` | Lease | 7.2 |

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
- `resources[].reachability.source` `probe` (the service read it from the host's adb server), or `null` when there is no reading

`reachability` is on this list only: the `Resource` of the other routes has no such field. A reading is never waited for: a request answers from the service's cache at once, and a missing or stale reading (older than `registry.reachability_max_age_s`, 60 s) starts one refresh in the background (at most one at a time), so the first read after a start shows `unknown` with every other field `null`. Only the Resources on the service's own host are probed; an `ios-lane` or the `emulator` Pool reads `unknown`. A change of state is logged once as a `reachability` event. The service remembers what it logged only for as long as it runs, so the first reading after a service start is logged with `from: null`.

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

`GET /discovery`: the devices on the hub's adb server that no live Resource of the Registry names (FR-4, FR-5), so a freshly paired phone shows up before anyone registers it. Read only: it asks `host:version` and `host:devices-l`, plus one serial read for each `host:port` id in `device` state, and never starts a server, connects or pairs. A Resource that is retired or seed-missing no longer names its phone. A device the private QA file names is left out, so no QA serial appears in the body. An adb server that is not running is `note: no adb server` with `devices: []`, still 200. An unknown host key is 503 `HUB_HOST_UNKNOWN`.

- `format` always `1`
- `host` the host key the service runs on: `linux` (the Hub API on big-chungus). A service on the Mac's key answers `host: mac`, `via: devicectl`, `port: null`
- `via` how the host was asked: `adb` on `linux`, `devicectl` on `mac`
- `port` the adb server port that was asked, or `null` on a host that does not use adb
- `note` `null`, `no adb server` (none is running) or `adb did not answer` (it is wedged or not adb)
- `devices[].serial` the phone's serial, or `null` when it could not be read (an `unauthorized` or `offline` `host:port` id)
- `devices[].model` the model adb lists, or `null`
- `devices[].id` the adb id: the serial over USB, the mDNS service name, or `host:port`
- `devices[].state` the state adb lists it in (`device`, `unauthorized`, `offline`, ...)

### Lease

`POST /leases`: status 200, the Lease that was taken (after a wait, when the body asked for one). It is the Lease `hub-device lease <word> --no-connect --json` would take, and the one view every service route that answers with a Lease uses (`leaseView` in `tools/device/claims.mjs`).

`GET /leases/{id}`: status 200, the same shape for the Lease the id names (a client whose connection dropped after the grant fetches its Hold here). A Lease that is still waiting for its lock holds nothing: 404 `HUB_LEASE_NOT_FOUND` with `reason: waiting`; an id nothing knows is 404 with `reason: unknown`. Only a phone Lease is found here for now.

- `lease_id` the Lease's id (the body's `id`, else one the lock layer minted)
- `resource` the Resource id the lock stands for
- `lock` the lock the Lease holds
- `device` the word a Claimant says for the phone (what `hub-device lease --json` calls `device`)
- `holder` the body's `holder`
- `why` the body's `why`
- `claimant_kind` `agent` or `person`
- `started_at` an ISO time, when the Lease was taken
- `expires_at` an ISO time. An API Lease lives until then or until it is released: it is tied to no process, so a restart of the service never reclaims it
- `env.*` what a Claimant exports to use it (`HUB_LEASE_ID`, `HUB_DEVICE`, `ANDROID_ADB_SERVER_PORT`): the same keys `hub-device lease --json` prints under `env`. No `ANDROID_SERIAL`: a Lease taken here never finds the phone on adb

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
| `HUB_API_RESTARTING` | `retry` | Always `requeue`: the service is stopping, so ask again (a wait is placed again with the same `id`). |

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

- `resource` or `match` (exactly one): `resource` is a device word (`s24`, `s26`, a registered phone's name, or the Pool word `phone`) or a Resource id (`res-…`); `match` is a Capability query (`kind=phone`). `emulator` is refused (`HUB_USAGE`): an emulator lease is a later route. A lease id is never a target.
- `for_ms` (required): a whole number of milliseconds, more than 0. At most 48 h for any Lease and at most 60 min on a deploy target (the S26); the `phone` Pool is narrowed to the phones that allow it, so over 60 min it is the S24.
- `holder` (required): who holds the Lease, recorded as given.
- `why` (required): a non-empty string, what the Lease is for.
- `claimant_kind`: `agent` (the default) or `person`. Recorded on the owner record and on every event of the Lease.
- `wait_ms`: a whole number of milliseconds, 0 or more (default 0, no wait). With more than 0 the request waits for its place in line up to that long, with the connection open and nothing written until the outcome; it needs an `id`.
- `id`: the Lease's id: lowercase letters, digits and dashes, at most 64. An id that already names a Lease or a waiter on any phone is refused, except by the same `holder` (see "Waits"). When absent one is minted (a request with no wait only).
- `actor`: `{holder, via}`, recorded as given on the take's events. When absent the actor is `{holder: <holder>, via: 'api'}`.

A key not listed is `bad-body`. The take is `hub-device lease <word> --no-connect`: the lock only (the owner record has `holder_pid: null` and no `device.adb_id`), `findPhone` never runs and adb is never asked. The service's environment is stripped of every `GITHUB_*` key before it is used, so no Lease or event of the API names a repo or a run. For a `match` the members whose reading in the service's own cache is `absent`, `offline` or `unauthorized` are dropped (an `unknown` or missing reading drops nothing); a word is never away, as for `--no-connect` on the CLI.

Refusals, in the order they are checked: `HUB_USAGE` 400 for the body (`bad-body`, `bad-target`, `bad-for`, `bad-wait`, `bad-claimant-kind`, `bad-id`, `no-id`, `bad-actor`, `no-holder`, `bad-why`), all before anything is read; `HUB_USAGE` 400 for an unknown device word, `emulator`, an `id` that is already taken, and a `for_ms` over 48 h or over a deploy target's cap (the message names the cap; the deploy-target one ends `lease s24 or an emulator for longer`), with nothing written; `HUB_RESOURCE_RETIRED` 409 (`retired`, `seed-missing`) for a Resource the Registry marks retired or seed-missing; `HUB_NO_MATCH` 404 (`no-match`) when a `match` finds nothing; `HUB_POOL_CROSS_HOST` 409 when its members span hosts; `HUB_DEVICE_AWAY` 503 (`away`) when every member of a `match` is known away; `HUB_LOCK_TIMEOUT` 409 (`busy`) when the lock is held or anyone waits and no wait was asked for: `detail` keeps `host lock <name> is held …`, and no event is written. A wait that runs out of time is the same answer (the `timeout` event is written, and for a Pool `detail` starts `host lock <lock> is held by …` for each held member).

**Waits** (`wait_ms` more than 0, `POST /leases`). The wait is the CLI's `hub-device lease --wait`: one place in line in the queue of the Resource (of every member of a Pool), a `request` event, then one `acquire`, `timeout` or `cancel`. It is bound to the HTTP connection, so a vanished client holds no place and is granted no Hold nobody receives:

- The client mints the `id`, so it can ask again after a lost answer. The server writes nothing, no status line and no header, until the outcome. Every answer of `POST /leases` that knows the id (the body's `id`, else the minted `lease_id` of a success) carries `X-Request-Id: <id>`.
- The ticket's `pid` is the serving process and it carries `claimant_kind`, so a `prune`, `cancel` or `timeout` names the right kind. Nothing is asked of the system for a pid more than once per 2 s.
- The connection closing before the answer is written ends the wait: the ticket is gone and the Event Log has a `cancel` with `reason: aborted`. A Hold granted after that is released at once (a `release` with `reason: undelivered`); a Hold granted before it, with its answer written, stands, and `GET /leases/{id}` returns it.
- A repeat of an `id` already held by the same `holder` answers 200 with the existing Lease (no second take, no event), whether or not it asks for a wait. A repeat of an `id` held by another `holder` is `HUB_USAGE` 400 as any taken id.
- A repeat with the `id` and `holder` of a wait that is still open takes it over: the wait goes on with its original Resource, `for_ms` and deadline and keeps its place (no event), the new connection gets the outcome, and the old connection gets `HUB_LEASE_SUPERSEDED` 409.
- When the service stops (`SIGTERM`), every open wait gets `HUB_API_RESTARTING` 503 with `retry: requeue` and its ticket is withdrawn (a `cancel` with `reason: aborted`); a request that arrives while it stops gets the same. A client places its wait again with the same `id` when the service is back.

For every write route the actor is `actor` as given, else `{holder, via: 'api'}`, else `no-holder`; the body is checked before the name's shape, which is checked before anything is read from the Registry.

## Error codes

| Code | Status | Exit | Meaning |
|------|--------|------|---------|
| `HUB_NO_ROUTE` | 404, 405 | 2 | No such path (`reason: no-route`), or the path exists and the method is not allowed (`reason: method`, with an `Allow` header). |
| `HUB_RESOURCE_NOT_FOUND` | 404 | 2 | No Resource has this id (`reason: unknown`), or on a read it is retired and idle (`reason: retired`). The write routes (`/registry/resources/{id}` and `/retire`) answer only `unknown`. |
| `HUB_RESOURCE_RETIRED` | 409 | 2 | An edit of a Resource that is retired (`reason: retired`) or no longer in `devices.json` (`reason: seed-missing`). Also what `POST /leases` refuses a take of one with, with the same reasons. |
| `HUB_REGISTRY_SEEDED` | 409 | 2 | A retire (`reason: retire`), an edit of `id`, `lock`, `kind`, `host` or `identity` (`reason` is that key) or a different name (`reason: name`) of a seeded Resource: a hub release changes those. |
| `HUB_USAGE` | 400, 413 | 2 | The request body is not valid JSON (`bad-json`) or is over 1 MiB (`too-large`), or a write body is wrong (`bad-body`, `bad-kind`, `bad-host`, `bad-identity`, `no-model`, `bad-capabilities`, `bad-if-rev`, `no-if-rev`, `bad-why`, `bad-actor`, `no-holder`, `no-change`), or an edit names a key a runtime Resource keeps for good (`immutable`). A lease body is wrong with `bad-body`, `bad-target`, `bad-for`, `bad-wait`, `bad-claimant-kind`, `bad-id`, `no-id`, `bad-actor`, `no-holder` or `bad-why`; a lease request the library refuses (an unknown word, `emulator`, a taken `id`, a `for_ms` over a cap) has `reason: hub_usage` and a `detail` that says why. |
| `HUB_LOCK_TIMEOUT` | 409 | 76 | `POST /leases`: the lock is held or someone waits (`reason: busy`), or a wait ran out of time. `detail` keeps the library's wording, `host lock <name> is held …` (for a Pool, once per held member); a try writes no event, a wait ends with its `timeout` event. |
| `HUB_DEVICE_AWAY` | 503 | 75 | `POST /leases` with a `match` whose every member the service's cache knows is away: `absent`, `offline` or `unauthorized` (`reason: away`). |
| `HUB_NO_MATCH` | 404 | 2 | `POST /leases` with a `match` nothing can serve (`reason: no-match`); `detail` says what excluded each Resource. |
| `HUB_POOL_CROSS_HOST` | 409 | 2 | `POST /leases` with a `match` whose members are on more than one host. |
| `HUB_LEASE_NOT_FOUND` | 404 | 2 | `GET /leases/{id}`: no Lease holds this id. `reason: waiting` when a waiter has it (it holds nothing yet), `reason: unknown` otherwise. |
| `HUB_LEASE_SUPERSEDED` | 409 | 1 | `POST /leases`: a newer request with the same `id` and `holder` took over this wait (`reason: superseded`). The wait itself goes on. |
| `HUB_API_RESTARTING` | 503 | 1 | The service is stopping (`reason: restarting`; member `retry: requeue`). Every open wait gets it, and so does a lease request that arrives while it stops. |
| `HUB_REGISTRY_NAME` | 400, 409 | 2 | A register's or edit's name is not a slug (`not-slug`) or is too long (`too-long`) with 400; reserved (`reserved`), already used (`taken`) or out of `-<n>` suffixes (`exhausted`) with 409. |
| `HUB_REGISTRY_DUPLICATE` | 409 | 2 | A live Resource already has the serial (`reason: serial`) or UDID (`reason: udid`); `holder` names it. |
| `HUB_REGISTRY_CONFLICT` | 409 | 1 | `if_rev` is not the Registry's revision; `rev` is the current one. |
| `HUB_HOST_UNKNOWN` | 503 | 1 | `GET /discovery` on a host that does not know which host it is (`reason: host-unknown`): `~/.config/mobile-deploy-hub/host-key` is missing, empty, unknown or for another platform. `mise run hosts:install` writes it. |
| `HUB_REGISTRY_FORMAT` | 409 | 1 | `registry.json` exists and cannot be read, or is a format this service does not know. It is never written. |
| `HUB_API_ERROR` | 500 | 1 | A bug in the service. The detail is one line; the journal has the same line. |
| `HUB_API_ALREADY_RUNNING` | none | 1 | Start only: the port is taken. Never an HTTP answer. |
| `HUB_API_NODE` | none | 1 | Start only: Node is older than 24.15. |
| `HUB_API_NO_HEAVY` | none | 1 | Start only: `heavy` is not on `PATH`. |
| `HUB_API_DOWN` | none | 1 | Client side only (`tools/hub-client.mjs`), never an HTTP answer: `GET /health` was refused, silent for 2 s, not a 200 or not this service, or the request itself was refused, so nothing was sent. |
| `HUB_API_UNKNOWN` | none | 1 | Client side only, never an HTTP answer: a write was sent and the answer did not come (timeout, reset, or something that is not a problem document), so it may have applied. `hub-device registry list` shows. |

## For the v1c module (non-binding)

A Holocene module for this service would use module id `mobile-deploy-hub` and read its base URL from `MOBILE_DEPLOY_HUB_API_URL`, defaulting to `http://127.0.0.1:8794`. This is a proposal, not part of the contract (open question Q3).
