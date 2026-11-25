# Epic 7 Context: Leases through the API, cancel and force-release

<!-- Generated from planning artifacts. Regenerate with compile-epic-context if planning docs change. -->

## Goal

Agents and Jarad can take, wait for, extend, release, cancel and force-release holds through the Hub API with exactly the semantics of `hub-device`, without a shell on big-chungus. These are the Hold write routes of the contract, built on the Claims library so the CLI and the API cannot drift. Every route is also served by the Mac's Host Agent (Epic 9) for its own host, so each story targets the library function, not the HTTP layer. It unblocks Holocene (v1c) and agents that need the write half of the contract.

## Stories

- Story 7.1: Take a Lease through the API
- Story 7.2: Wait for a Lease through the API
- Story 7.3: Extend and release a Lease, with a recorded override
- Story 7.4: Lease an emulator through the API
- Story 7.5: Cancel a queued request
- Story 7.6: Force-release a Lease
- Story 7.7: Force-release a Reservation
- Story 7.8: Force-release an emulator slot
- Story 7.9: Ship Leases through the API

## Requirements & Constraints

- The API and CLI take, refuse and report the same action identically. A parity test per action compares Hold, refusal reason and events. No front door re-implements resolve, take, bounds checks or the code-to-exit table.
- Errors are `application/problem+json` `{type, title, status, detail}` plus `code`, `exit`, `reason`. Busy is 409/exit 76, away is 503/exit 75, `HUB_RESOURCE_RETIRED` 409/exit 2, `HUB_NO_MATCH` 404/exit 2, `HUB_USAGE` 400/exit 2 (empty `why`), `HUB_FORCE_RELEASE_JOB` 409/exit 2, `HUB_LEASE_SUPERSEDED` 409, `HUB_API_RESTARTING` 503 with `retry: requeue`. Queue-wait timeouts keep the `HUB_LOCK_TIMEOUT` wording `host lock <name> is held …` in `detail`.
- Caps: a Lease on a deploy target is at most 60 min, any Lease at most 48 h; over-cap requests are refused naming the cap and pointing to the S24 or an emulator. A deploy-target Lease cannot be extended while anyone waits.
- Every write returns the resulting state. Responses are `Cache-Control: no-store`; fields and routes are only added. Loopback only, `snake_case`.
- Manual actions record `actor: {holder, via}` (set once by the first front door, passed through unchanged) and `why` on events. Names are recorded as given; there is no authentication (NFR-6).
- A Job Hold (`job` or `hub-job`) can never be force-released or cancelled through the hub; the answer points to `gh run cancel`. Deploy jobs never call a service to release their Reservation; `announce` and the ssh `reservation release` verb stay unchanged (the 5.1 conformance test asserts it).
- The API never asks for confirmation on force-release; that is the page's job in v1c.
- Tests are hermetic: fake requests, no real socket, port, emulator, adb or `heavy`. Node 24 ESM `.mjs`, no dependencies.

## Technical Decisions

- **One library (AD-24):** `tools/device/claims.mjs` owns resolve, take, release, cancel, extend, force-release and the error-to-exit table. `lock.mjs` remains the only protocol writer (AD-1); new writers `forceRelease(name, {actor, why})` and `cancelRequest(name, lease_id, {actor, why?})` are `lock.mjs` exports, as is `extendLease`'s new `override: {actor, why}` option. `releaseReservation(name, {key, actor, why})` with an `actor` writes `force-release` with `hold_kind: reservation`.
- **API Leases are lock-only and expiry-bound (AD-36):** `holderPid: null`; they live until `expires_at` or release, are never reclaimed on service restart, and status shows `holder`, never the service pid. They never call `findPhone`: a phone Lease equals `hub-device lease <word> --no-connect` (no `adb_id`), pinned by a parity test. The service environment carries no `GITHUB_*` variable (tested by injecting one). `acquireLease` gains `claimantKind` (`agent` default, or `person`); `eta.mjs` stays unchanged, so person history is separate (open question).
- **Waits are bound to the connection (AD-37, AD-48):** a wait keeps its HTTP connection open; the ticket carries the serving pid; the client mints the `id` (`newLeaseId`; a server-minted id only without a wait). The server writes nothing until the outcome, and `X-Request-Id` echoes the id. A disconnect aborts the wait and records `cancel`. A Hold granted after the socket was destroyed is released at once; one granted before stands and is fetched with `GET /leases/<id>`. A repeat `id` already held by the same `holder` returns `200` with the existing state. A repeat of an `id` still waiting takes over, and the old connection gets `409 HUB_LEASE_SUPERSEDED`. On `SIGTERM` open waits get `503 HUB_API_RESTARTING`, tickets are aborted, then it exits. After a crash the next pruner removes stale tickets with a `prune` event.
- **Event-loop discipline (AD-44):** waits, `provision`, `/proc` scans and adb run in a `node:worker_threads` worker or use the cached process-start seam; the main thread never calls `spawnSync`. An uncontended local `POST /leases` answers in under 1 s.
- **Extend (AD-16, AD-34):** expiry only moves later through `extendLease`. The waiter check covers every queue the Resource is served from (its own queue including Pool tickets, and the `emulator` gate for a slot), ignoring the extender's own tickets. The refusal `HUB_LEASE_EXTEND_REFUSED` (exit 76) names waiters and positions. The override skips only the waiters check, never the expiry check, the 48 h limit or the 60 min cap. Extension at or after expiry is refused.
- **Cancel and force-release (AD-38):** cancel removes a ticket (from every Pool member, AD-33), touches no Hold and refuses `job:` tickets and Reservations. Force-release renames the owner to a tomb and writes one `force-release` event with `actor`, `why`, `lease_id` and `hold_kind`. If the lock was reclaimed between read and rename, the rename decides and the loser records nothing. `HUB_FORCE_RELEASE_JOB` carries `{repo, run, job}`.
- **Emulator Pool (AD-33, AD-44):** an emulator request calls `provision({holderPid: null})` off the request path, expiry-bound, and returns slot, adb serial and profile. Pool size order is `HUB_EMULATOR_POOL` (CLI only), the `emulator-pool` file, the Registry's `pools.emulator.size`, then 2, each within 1..8. Slots are derived, never Registry records. `PROFILES` and `MAX_POOL` stay code constants. A profile not installed fails at once with `HUB_NO_MATCH`. An emulator booting when the service dies is reaped as an orphan.
- **Force-release of an emulator slot** is one Claims function, `forceReleaseEmulator`, in this order: read the owner and emulator record; under the `emulator-reaper` lock call `forceRelease(slot)`; tear down and remove the record (`releaseEmulator(id, {alreadyReleased: true})`); release the reaper lock. A crash leaves an ownerless record that the next reap tears down with no second hold-ending event, and the slot is unclaimable while the record exists.
- **Forwarding (AD-48):** the same Hold routes run on both services. A forward is the public route plus `X-Hub-Forwarded` and a `resource: {id, lock, host, rev, retired_at}` body key. Release, cancel and extend bodies carry `resource`, and a Pool cancel also carries `pool` and the host key, so no receiver searches the fleet by id. The retired check applies on every front door.
- **Route set (AD-42):** `POST /leases` (by word, id or `match`), `/leases/<id>/extend`, `/leases/<id>/release`, `/leases/<id>/force-release`, `POST /requests/<id>/cancel`, `POST /reservations/<run_key>/force-release`, `GET /leases/<id>`. The doc `docs/hub-api-contract.md` lists exact field lists, and a contract test asserts exact key sets against handler output.
- **CLI verbs** in `hub-device`: `extend <id> --for`, `release <id>` (refuses `job:` ids, exit 2), `cancel <id>`, `force-release <id> --why` (and `--reservation <run_key>`), `force-release emulator-<n> --why`.

## Cross-Story Dependencies

- 7.1 is the base: it adds `POST /leases` (no wait), `claimant_kind` and the caps. 7.2 (waits, the repeat-`id` rules and `GET /leases/<id>`), 7.3 and 7.4 build on it.
- 7.6 adds `forceRelease`. 7.8 composes it with the emulator reaper. 7.7 reuses `releaseReservation`. 7.5 and 7.6 share the Job-ticket refusal rules.
- 7.9 ships 7.1 to 7.8: contract doc, `mise run check` on Node 24 and 26, `mise run release -- X.Y.Z`, `hosts:install` readback on big-chungus, and live S24 verification.
- Builds on Epics 5 and 6 (Claims library, `lock.mjs` exports, Hub API server, Registry, Event Log vocabulary including `force-release`, `actor` and `why`). Epic 9's Host Agent serves these same routes, and Epic 8's status and stream read the results. The deploy path does not depend on any of this (AD-25).
