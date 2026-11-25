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

## Routes

| Method | Path | Shape | Added |
|--------|------|-------|-------|
| GET | `/health` | Health | 6.4 |
| GET | `/resources` | ResourceList | 6.5 |
| GET | `/resources/{id}` | Resource | 6.5 |
| GET | `/pools` | PoolList | 6.5 |
| POST | `/registry/resources` | Resource | 6.6 |

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

### Resource

`GET /resources/{id}`: one Resource, found by `id` only. An unknown id is 404 `HUB_RESOURCE_NOT_FOUND` with `reason: unknown`; a retired or seed-missing Resource that is idle is 404 with `reason: retired`.

`POST /registry/resources` answers the same shape with status 201: `rev` is the Registry's revision after the register, `source` is always `file`, and `resource` is the new Resource as a reader serves it (a `dedicated_qa` Resource's `serial`, `udid` and `adb_id` are `null`). The request body is under "Request bodies".

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

### PoolList

`GET /pools`: every Pool of the Registry, in its stored order.

- `rev` the Registry's revision
- `source` `file` or `seed`
- `pools[].name` the Pool's name (`phone`, `emulator`)
- `pools[].kind` `named` (a list of Resources) or `gate` (one lock, no list)
- `pools[].members` for a `named` Pool the ids a lease of it would try, in order (`[]` when none can serve it); always `[]` for a `gate`
- `pools[].gate` the gate's lock name, or `null`

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

Refusals, in the order they are checked: `HUB_USAGE` 400 for the body (`bad-body`, `bad-kind`, `bad-host`, `bad-identity`, `no-model`, `bad-capabilities`, `bad-if-rev`, `bad-why`, `bad-actor`, `no-holder`); `HUB_REGISTRY_NAME` 400 for a name that is not a slug (`not-slug`) or is over 28 characters (`too-long`); `HUB_REGISTRY_CONFLICT` 409 for a stale `if_rev`; `HUB_REGISTRY_NAME` 409 for a reserved word (`reserved`), a name any Resource already has as a name, id, lock or word (`taken`), or no free `-<n>` up to 999 (`exhausted`); `HUB_REGISTRY_DUPLICATE` 409 for a serial or UDID a live Resource has (`reason: serial` or `udid`, member `holder`). A retired Resource's identity is free, its name is not.

## Error codes

| Code | Status | Exit | Meaning |
|------|--------|------|---------|
| `HUB_NO_ROUTE` | 404, 405 | 2 | No such path (`reason: no-route`), or the path exists and the method is not allowed (`reason: method`, with an `Allow` header). |
| `HUB_RESOURCE_NOT_FOUND` | 404 | 2 | No Resource has this id (`reason: unknown`), or it is retired and idle (`reason: retired`). |
| `HUB_USAGE` | 400, 413 | 2 | The request body is not valid JSON (`bad-json`) or is over 1 MiB (`too-large`), or a register body is wrong (`bad-body`, `bad-kind`, `bad-host`, `bad-identity`, `no-model`, `bad-capabilities`, `bad-if-rev`, `bad-why`, `bad-actor`, `no-holder`). |
| `HUB_REGISTRY_NAME` | 400, 409 | 2 | A register's name is not a slug (`not-slug`) or is too long (`too-long`) with 400; reserved (`reserved`), already used (`taken`) or out of `-<n>` suffixes (`exhausted`) with 409. |
| `HUB_REGISTRY_DUPLICATE` | 409 | 2 | A live Resource already has the serial (`reason: serial`) or UDID (`reason: udid`); `holder` names it. |
| `HUB_REGISTRY_CONFLICT` | 409 | 1 | `if_rev` is not the Registry's revision; `rev` is the current one. |
| `HUB_REGISTRY_FORMAT` | 409 | 1 | `registry.json` exists and cannot be read, or is a format this service does not know. It is never written. |
| `HUB_API_ERROR` | 500 | 1 | A bug in the service. The detail is one line; the journal has the same line. |
| `HUB_API_ALREADY_RUNNING` | none | 1 | Start only: the port is taken. Never an HTTP answer. |
| `HUB_API_NODE` | none | 1 | Start only: Node is older than 24.15. |
| `HUB_API_NO_HEAVY` | none | 1 | Start only: `heavy` is not on `PATH`. |

## For the v1c module (non-binding)

A Holocene module for this service would use module id `mobile-deploy-hub` and read its base URL from `MOBILE_DEPLOY_HUB_API_URL`, defaulting to `http://127.0.0.1:8794`. This is a proposal, not part of the contract (open question Q3).
