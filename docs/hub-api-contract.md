# Hub API contract

Status: contract 1, 2026-11-25

The Hub API is the one writer of the Registry (design v1.1, AD-42). Holocene's page and every other client code against this document. `tools/hub-api/contract.test.mjs` parses it and fails when a route or a field exists in only one of this document and `tools/hub-api/routes.mjs`, so a route-adding story updates both.

## Base URL

`http://127.0.0.1:8794`, loopback only, no path prefix. The port is `api.hub_api_port` in `tools/ci/policy.json`. There is no authentication: the socket is not reachable from another host.

## Conventions

- Every response carries `Cache-Control: no-store`.
- Keys are `snake_case`.
- A success is `application/json; charset=utf-8`. An error is `application/problem+json` with exactly the `Problem` fields below.
- Paths match exactly: no trailing-slash folding, and the query string is ignored for routing.
- The contract is additive only: a later release adds routes and fields, never removes or renames one, and never changes what a field means. A client ignores fields it does not know. `contract` in `/health` is the version, and rises only on a change that cannot be additive.
- `exit` in an error is the exit code a CLI front door uses for the same error, so `hub-device` and a Holocene button agree.

## Routes

| Method | Path | Shape | Added |
|--------|------|-------|-------|
| GET | `/health` | Health | 6.4 |

## Shapes

### Health

- `ok` always `true`
- `service` always `mobile-deploy-hub-api`
- `contract` the contract version of this document
- `hub_version` the hub release the service runs from (`v1.2.60`), or `unknown`
- `ports.hub_api` the Hub API's port
- `ports.host_agent` the Host Agent's port
- `registry` `ok`, or `unreadable` when `registry.json` exists and cannot be read; a missing file is `ok` (the in-memory seed answers). Read fresh on every call.

### Problem

- `type` `urn:mobile-deploy-hub:problem:<code>`
- `title` the HTTP status text
- `status` the HTTP status
- `detail` a one-line message
- `code` the error code, from the list below
- `exit` the CLI exit code for this error
- `reason` a short machine-readable reason. The service's own are `no-route`, `method`, `bad-json`, `too-large` and `internal`; a library error carries its own `reason`, and an error with none gets its `code` in lower case

## Error codes

| Code | Status | Exit | Meaning |
|------|--------|------|---------|
| `HUB_NO_ROUTE` | 404, 405 | 2 | No such path (`reason: no-route`), or the path exists and the method is not allowed (`reason: method`, with an `Allow` header). |
| `HUB_USAGE` | 400, 413 | 2 | The request body is not valid JSON (`bad-json`) or is over 1 MiB (`too-large`). |
| `HUB_API_ERROR` | 500 | 1 | A bug in the service. The detail is one line; the journal has the same line. |
| `HUB_API_ALREADY_RUNNING` | none | 1 | Start only: the port is taken. Never an HTTP answer. |
| `HUB_API_NODE` | none | 1 | Start only: Node is older than 24.15. |
| `HUB_API_NO_HEAVY` | none | 1 | Start only: `heavy` is not on `PATH`. |

## For the v1c module (non-binding)

A Holocene module for this service would use module id `mobile-deploy-hub` and read its base URL from `MOBILE_DEPLOY_HUB_API_URL`, defaulting to `http://127.0.0.1:8794`. This is a proposal, not part of the contract (open question Q3).
