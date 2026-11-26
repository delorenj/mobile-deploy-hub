---
title: 'Story 9.3: Forwarded actions reach the right host'
type: 'feature'
created: '2026-11-26'
status: 'done'
baseline_revision: '274205a6077bbf31c5a766d12964406f5b2670a1'
review_loop_iteration: 0
followup_review_recommended: true
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-9-context.md'
warnings: ['oversized']
deferred: []
---

<intent-contract>

## Intent

**Problem:** Every front door (the Hub API, the Host Agent and `hub-device`) acts in-process on whatever it is asked. So big-chungus would write the Mac's `mac-ios` lock dir and the Mac would write big-chungus' phone locks (AD-25). Story 9.2's agent only refuses a foreign Resource with `HUB_WRONG_HOST`.

**Approach:** One forwarding module decides, for each Hold action, where the named Resource lives. A foreign one is forwarded through `hub-client.mjs` to that host's front door. The forward is the public route, plus header `X-Hub-Forwarded: <door>`, plus body key `resource: {id, lock, host, rev, retired_at}` (AD-48). The receiving rules are written once:
- big-chungus re-resolves.
- The agent acts on the carried record.
- A misplaced forward is `HUB_WRONG_HOST` and is never re-forwarded.

The neighbouring level (`belsky-doctrine`) is every Hold verb on every front door: the Hub API, the agent and the CLI. It is not only `lease ipad`, which is 9.4.

## Boundaries & Constraints

**Always:**
- One transport (`hub-client.mjs` `request`/`forward`) and one forwarding module (`tools/device/forward.mjs`), used by all three front doors.
- The actor is set by the first front door that sees none: `{holder, via: cli|api|host-agent}`. A forwarder passes it unchanged.
- A forwarded `POST /leases` carries a client-minted `id`. Story 7.2's repeat rules make a retried forward take no second Lease.
- A cancel carries `host` (the target's key) and its `pool` when it has one.
- An unknown host key on the Hub API or the CLI means no forwarding: they act in-process as in v1a. The agent stays strict (503).
- Tests are hermetic. Every forward goes through an injected `request` seam (a bridge to the other side's `handle()`). No ssh, port or live host is touched.

**Never:**
- No re-forward, no retry, no new timer.
- No Python and no new lock or queue.
- Reservation force-release is not forwarded. On the agent it stays gated by `name` (`HUB_WRONG_HOST`); on the Hub API it is unchanged.
- No `lease ipad|mac` take semantics on the CLI. The ios-lane CLI path is 9.4.
- Never write `sprint-status.yaml`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|---|---|---|---|
| Hub API forwards | linux Hub API, `POST /leases {resource:'ipad', wait_ms, id}` | Mac agent gets `X-Hub-Forwarded: api` and `resource:{id:'ios-lane',lock:'mac-ios',host:'mac',rev,retired_at}`, actor `{holder, via:'api'}`; its answer is relayed unchanged | Mac unreachable → 503 `HUB_DEVICE_AWAY` exit 75 `host-unreachable` |
| Agent forwards | Mac agent, public `POST /leases {resource:'s24'}` | refreshes `GET /resources` through `request`, then forwards to linux with door `host-agent` | Hub API down → resolves from the seed (`rev:0`) |
| Big-chungus receives | forward whose carried record lies (wrong lock) | the record is replaced by `id` and re-resolved against `registry.json`; it acts on the real lock | id resolves to another host → 409 `HUB_WRONG_HOST`, nothing written |
| Agent receives | carried `{host:'mac', lock:'mac-ios'}` | acts on the carried lock (release, extend, cancel, take) | `host`≠own → `HUB_WRONG_HOST`; `rev:0` and not seeded → 400 `HUB_USAGE` `unseeded`; `retired_at` set on `POST /leases` → 409 `HUB_RESOURCE_RETIRED` |
| Retry | same forwarded `id`+`holder` twice | one `acquire` event; the second answer is the existing Lease | — |
| Pool cancel | `cancel --resource phone --pool phone` from the Mac | forwarded body carries `pool:'phone'`, `host:'linux'` | — |
| CLI | Mac-keyed `lease --match kind=phone`, `release <id> --resource s24`, `cancel <id> --resource s24`, `extend`, `force-release` | forwarded with door `cli`; prints the same `HUB_DEVICE_*` lines and exit codes as local | `--pid`/`--env-serial` on a forward → exit 2; `run` on a foreign target → `HUB_WRONG_HOST` exit 2 |
| Bad forward | header value not a door, or a malformed `resource` object | 400 `HUB_USAGE` `bad-forward` / `bad-resource` | an object `resource` without the header → `bad-resource` |

</intent-contract>

## Code Map

- `tools/hub-client.mjs` -- `request()` (:250; it adds no headers and has no signal), `viaSsh` (:188), `remoteCommand` (:148), `relay` (:270), `main` (:339), `problemError` (:83, not exported) and `away` (:173). Add `FORWARD_HEADER`, `FORWARD_DOORS`, the `forwarded` and `signal` options, the relay's door word, and `forward()`.
- `tools/host-agent/routes.mjs` -- the 9.2 gate: `GATES`, `resourcesOfWord`, `resourcesOfMatch`, `gated()` and `wrongHost`. Move the naming into `forward.mjs` and rebuild `gated` as the agent's forwarding wrapper.
- `tools/host-agent/known.mjs` -- `createKnown`. `current()` gains `rev` (0 for the seed) and `seeded` (the seed's ids). It is reused by `peerView` for the CLI.
- `tools/host-agent/server.mjs` -- puts `send` on `ctx.request`, so the routes refresh and forward through it.
- `tools/hub-api/routes.mjs` -- the Hold handlers (:316-373), `ROUTES` (:395) and `handle()` (:447, header keys lower-cased). Wrap the six forwardable Hold routes. Keep the raw handler as `route.local` for the agent.
- `tools/device/claims.mjs` -- body checks: `checkLeaseBody` (:704), `EXTEND/RELEASE_BODY_KEYS` (:1113), `checkCancelBody` (:1245) and `FORCE_RELEASE_BODY_KEYS` (:1336). Add an optional string `resource` to extend, release and force-release, refused as `bad-resource`. Most Hold calls find their lock through `ctx.fleet` (`phoneOwning`, `releasePhone`, `requestLocks`, `resolve`); force-release scans every lock. So the agent acts on a carried lock by adding that record to the fleet.
- `tools/device/hub-device.mjs` -- `lease` (:255), `release` (:415), `extend` (:349), `cancel` (:371), `forceRelease` (:386), `runCommand` and `runEmulator`, `report` (:186), `FLAG_OWNERS` (:800) and `main` (:822; it gains a `request` seam).
- `tools/registry/store.mjs` -- `readRegistry` (:89) gives `{rev, resources, pools}`, which is big-chungus' view.
- `tools/deploy-path.test.mjs` -- add `tools/device/forward.mjs` to FORBIDDEN.
- `docs/hub-api-contract.md` -- Request bodies (:417-485), Error codes, `## Cross-host calls` (:527) and the agent's host gate paragraph (:572).
- Tests that change or must hold:
  - `tools/host-agent/server.test.mjs:230-268,317-335` (WRONG_HOST → forward; ctx gains a fake `request`).
  - `tools/device/lease-match.test.mjs:222-241` ("a Mac key" now forwards).
  - `tools/hub-api/cancel.test.mjs:192`, `force-release.test.mjs:125` and `reservation-force-release.test.mjs:128` stay as they are.

## Tasks & Acceptance

**Execution:**
- [ ] `tools/hub-client.mjs`:
  - Export `FORWARD_HEADER='X-Hub-Forwarded'` and `FORWARD_DOORS=['cli','api','host-agent']`.
  - `request({..., forwarded, signal})`:
    - Loopback: the header, and an abort on `signal`.
    - ssh: the door is appended as a relay word. An abort kills ssh and rejects with `signal.reason`.
  - `relay` takes an optional door (it validates it and sets the header on its loopback fetch). `main` accepts `relay <M> <path> [<door>]`. `RELAY_USAGE` is updated.
  - `forward({host, method, path, body, door, waitMs, budgetMs, signal}, seams)` (`seams.request` overrides the transport) gives `{status, body}`:
    - A problem+json answer → `problemError`.
    - A transport failure → `HUB_DEVICE_AWAY` (exit 75, `host-unreachable`, `status: 503`).
    - An abort → `signal.reason`.
    - A non-problem answer → `HUB_API_UNKNOWN` (`status: 502`).
- [ ] `tools/device/forward.mjs` (new):
  - `forwardedDoor(headers)` (`bad-forward`) and `carried(record, rev)`.
  - `checkCarried(value)` (`bad-resource`; `rev` is an integer ≥0, `retired_at` is null or a string).
  - `unwrapCarried(request)` (an object `resource` is allowed only with the header).
  - `NAMED` (route key → `{check, names, forward}`), `namedRecords(key, input, request, view, policy)` (the moved word and match naming, which never throws) and `placeOf(records, own)` (one foreign host, else null).
  - `hubView(ctx)` (`readRegistry`) and `peerView({env, devices, qaDevices, request})` (`createKnown` + `refresh`; rev 0 on the seed).
  - `forwardHold({key, request, input, place, rev, door, ctx})`. It builds the body: actor defaulted, the carried record when one Resource is named, the word or match otherwise, `host` on a cancel. Its bound is the wait plus the emulator boot budget for an emulator take. Its transport is `ctx.request`, else hub-client `request` with the ctx's policy, devices and key.
  - `withPlace(fleet, record, view)` and the errors `wrongHost`, `unseeded` and `retiredCarried`.
- [ ] `tools/device/claims.mjs` -- an optional `resource` (a non-empty string) on the extend, release and force-release bodies. The returned input carries it.
- [ ] `tools/hub-api/routes.mjs` -- `hubHold(route)` for the six forwardable routes:
  - A forward: the carried record is unwrapped to its id and re-resolved through `hubView`. If it is foreign → `HUB_WRONG_HOST`.
  - A public request with a foreign place → `forwardHold(door 'api', signal)`.
  - An unknown key → local.
  - `ROUTES` keeps `local` (the raw handler).
- [ ] `tools/host-agent/routes.mjs` -- the agent wrapper over `route.local`:
  - A forward: `checkCarried`, host = own, the `rev:0` seeded rule, the retired check on `POST /leases`, then local with `withPlace`.
  - A public request: `known.refresh` through `ctx.request` when the route names something. Foreign → forward (door `host-agent`), local → its retirement checked for leases.
  - A forwarded request naming a foreign Resource → `HUB_WRONG_HOST`. Reservation force-release is gated, never forwarded.
- [ ] `tools/host-agent/known.mjs` and `tools/host-agent/server.mjs` -- `current().rev` and `.seeded`; `ctx.request = send`.
- [ ] `tools/device/hub-device.mjs`:
  - `--resource` is owned by release, extend, cancel and force-release.
  - The view is `hubView` on linux and `peerView` on any other key. An unknown key means no forwarding.
  - Forward a foreign `lease <word>|--match|emulator`, and release, extend, cancel and force-release with `--resource`. The id is minted with `newLeaseId`. SIGINT aborts the forward. The answers are printed as the local `HUB_DEVICE_*` lines. Problem errors are reported through `report()` with their code, reason and exit.
  - `run` on a foreign target → `HUB_WRONG_HOST`.
  - A `request` seam on `main`.
- [ ] Tests:
  - `tools/hub-client-forward.test.mjs`: the header on fetch and over ssh (argv door word), the relay door validation, the signal kill, and `forward()` classification.
  - `tools/device/forward.test.mjs`: unit tests of check, place and body.
  - `tools/hub-api/forward.test.mjs`: Hub API ↔ agent through bridges, covering every matrix row and retried ids (one `acquire`), and the actor via.
  - `tools/device/forward-cli.test.mjs`: Mac- and linux-keyed CLI forwards and their printed lines.
  - Update server.test (WRONG_HOST cases → forwarded) and lease-match.
  - Add forward.mjs to deploy-path FORBIDDEN.
- [ ] `docs/hub-api-contract.md`:
  - A `### Forwarding` section under Cross-host calls.
  - The relay door word.
  - The agent gate paragraph → forwarding.
  - The optional `resource` on extend, release and force-release.
  - Error rows: `HUB_DEVICE_AWAY` (503 when a front door forwards), `HUB_WRONG_HOST` and `HUB_USAGE` reasons.
  - Update the CLI usage and header comments in hub-device.

**Acceptance Criteria:**
- Given a linux-keyed Hub API and the Mac agent behind a bridge, when `POST /leases {resource:'ipad'}` and then `POST /leases/{id}/release {resource:'ios-lane'}` arrive, then the agent receives the public route with `x-hub-forwarded: api` and the carried record, the lock written is `mac-ios` in the agent's lock dir only, and the Hub API's lock dir gets no `mac-ios` entry.
- Given the same forwarded `id` and `holder` sent twice, when both reach the agent, then exactly one `acquire` event exists and both answers name the same `lease_id`.
- Given a Mac-keyed CLI with the Hub API unreachable, when `lease s24` runs, then it resolves from the seed and forwards with `rev: 0`. Given the Hub API answers, then `rev` is the answered rev.
- Given `mise run check`, when it runs, then actionlint and the full suite are green.

## Spec Change Log

## Review Triage Log

### 2026-11-26 — Review pass
- verdicts: 38 findings — high 0, medium 7, low 21, false 10, maybe-false 0
- findings:
  - Blind Hunter:
    - `[low]` `[reject]` A minted id gives no retry safety when the caller sent none and the forward answered AWAY. — The AC's retry rule is for a client-minted id the client keeps, and the CLI's `--id` pins one. Printing the id on AWAY would add output surface for a rare race.
    - `[medium]` `[patch]` An id-only release, extend or GET of a Lease that lives on another host runs locally and answers NOT_HELD or 404 (group "bare id"). — Fixed: a CLI `release`/`extend` that takes its id from `$HUB_LEASE_ID` now takes its Resource from `$HUB_DEVICE`, both of which the lease exported, so the lease-then-release flow forwards. An explicit id with no Resource is answered by the receiving host, as the contract documents.
    - `[false]` `[reject]` `run ipad|mac` now fails where it used to work. — `run` never took the iOS lane's words: the local verb refused it as a usage error (exit 2), and it is now `HUB_WRONG_HOST` (exit 2).
    - `[low]` `[reject]` SIGINT after the far side has granted the Lease leaves it held. — The window between the far grant and the abort is tiny. The abort closes ssh stdin, so a far waiter cancels. A compensating release path is new complexity.
    - `[low]` `[reject]` Signal handlers are installed after the peer refresh, and usage is checked after it. — During the refresh the process keeps its default SIGINT disposition and still ends, and hub-client's connect timeout bounds the refresh.
    - `[false]` `[reject]` The agent refreshes `GET /resources` on every public Hold call. — The epic AC requires it: off big-chungus the agent asks the Hub API when it resolves a word.
    - `[false]` `[reject]` The agent trusts a carried record at `rev > 0`. — The intent says the Host Agent acts on `lock` and `host` as carried.
    - `[false]` `[reject]` The `NAME` slug regex may reject real ids. — Resource ids are slugs: the seed ids, and `res-<slug>` of at most 36 characters (`tools/registry/changes.mjs:23`).
    - `[low]` `[reject]` A forwarded emulator release or force-release is bounded at 30 s. — Emulator Leases live only on linux, so only a non-linux host forwards one. Its exported adb port points at linux's local server, so no real flow does this.
    - `[low]` `[patch]` `hubHold` reads `registry.json` (and warns on a bad file) on every Hold call, including GET and bare release. — Fixed: it returns to the handler before `hubView` when the request names nothing.
    - `[false]` `[reject]` Mixed-host Pools get `POOL_CROSS_HOST` when public but `WRONG_HOST` when forwarded. — A sender forwards only when every Resource is on one host. A forward naming a foreign Resource is `HUB_WRONG_HOST` by the contract.
    - `[low]` `[reject]` CLI extend and cancel do not refuse a job id before forwarding, and the forwarded `wait_ms` default is hard-coded. — The far side's Claims refuses job ids with the same code, which is relayed. The drift risk is speculative.
    - `[low]` `[reject]` Some test assertions are weak or their titles do not match. — Test-only. The behaviours have other covering tests (for example, the unknown-key forward-cli test). The stale "no timer" test was fixed under the verification-gap rows.
    - `[low]` `[reject]` Missing coverage: problem extras, Hub API client disconnect, emulator over the Hub API, view units. — The CLI emulator gap was patched (see V2). The rest are low-risk pass-through paths covered by `forward()` classification tests.
    - `[false]` `[reject]` The spec is left half-finished, and forward.mjs imports `host-agent/known.mjs`. — The spec was finalized in this step. The import is the one shared cache of the Hub API's answer, and the deploy-path FORBIDDEN test guards it.
  - Edge Case Hunter:
    - `[low]` `[reject]` The emulator release budget (same as the Blind Hunter row). — Same reason as that row.
    - `[medium]` `[patch]` GET, or a bare release, of a foreign Lease answers 404 or outcome none (group "bare id"). — The `$HUB_DEVICE` fix above.
    - `[low]` `[reject]` SIGINT can orphan a granted Lease. — Same reason as the Blind Hunter row.
    - `[medium]` `[patch]` Far problems print `HUB_LOCK_TIMEOUT lease …` instead of `HUB_DEVICE_BUSY <device>`, and print no stdout `HUB_DEVICE_AWAY` (group "far lines"). — Fixed: `forwardCommand` clears `api` on a far `HUB_LOCK_TIMEOUT`, `HUB_PHONE_AWAY`, `HUB_DEVICE_AWAY` or `HUB_LEASE_CANCELLED`, so `report()` prints the local lines and exits. New forward-cli tests cover busy, away and cancelled.
    - `[low]` `[reject]` A `rev: 0` forward with a seeded id but a different lock is accepted. — The senders are the hub's own front doors, which build the record with `carried()`. A seed cross-check is a new guard against a sender that does not exist.
    - `[low]` `[reject]` A peer on an older hub that rejects the relay door word reports AWAY. — Both hosts update from the same hub release, so this is transient during a rollout.
    - `[low]` `[reject]` A typo in `--resource` gives NOT_HELD with exit 0. — A local release acts by lease id. NOT_HELD with exit 0 is the documented answer for an id this host does not hold.
    - `[false]` `[reject]` A Mac `cancel <id> --pool phone` with no `--resource` runs locally. — `checkCancelBody` requires `resource` (`tools/device/claims.mjs:1258`), so a pool-only cancel is refused on every front door.
    - `[low]` `[reject]` The CLI refresh runs before argument validation and has no short bound. — Same reason as the Blind Hunter signal row.
    - `[false]` `[reject]` The agent refresh has no short bound. — The refresh is the AC's mandated Hub API ask, bounded by hub-client's connect timeout. Down, it falls back to the seed.
    - `[low]` `[reject]` Claim: a retry without an id can take a second Lease. — Same reason as the first Blind Hunter row.
    - `[medium]` `[patch]` Claim: forwarded verbs do not print the local `HUB_DEVICE_*` lines on problems (group "far lines"). — The same fix as the far-problems row above.
  - Verification Gap:
    - `[medium]` `[patch]` The agent's public take of a retired local Resource is untested. — Added a `server.test.mjs` case: a rev 5 answer with `ios-lane` retired, then a public `ipad` take, gives 409 `HUB_RESOURCE_RETIRED` with no lock and no forward.
    - `[medium]` `[patch]` The CLI's forwarded emulator take and `force-release emulator-<n>` are untested. — Added the forward-cli cases. They exposed the `emulator` word being carried as a single record, so `namedRecords` now treats the emulator Pool as a Pool, with no carried record.
    - `[low]` `[patch]` No test pins that the agent's forward carries a non-zero rev from the Hub API. — Added an agent-side case at rev 9.
    - `[low]` `[patch]` The `lease-match.test.mjs:221` title still says "or a Mac key". — The title is fixed.
    - `[low]` `[patch]` The server "no timer" test still says "gate refusal" and asserts `200 || 409`. — It now asserts the forward reached the seam as door `host-agent`, and that no lock was written.
  - Intent Alignment:
    - `[medium]` `[patch]` Release, extend and cancel forward only when a Resource is named (group "bare id"). — The `$HUB_DEVICE` fix above. Naming the Resource is the AD-48 routing contract.
    - `[low]` `[reject]` The CLI does not forward `lease ipad|mac`. — Out of scope: Story 9.4 of the same epic owns `lease ipad|mac`.
    - `[false]` `[reject]` `retired_at` is stamped by non-big-chungus senders. — Only linux senders forward to the agent, and they read `registry.json` through `hubView`. Forwards from the Mac go to big-chungus, which discards the record.
    - `[low]` `[reject]` Local resolution on the Mac does not go through the Hub API. — The Mac's only local Resource is `ios-lane`, whose CLI take is Story 9.4's. The agent's local path uses the Hub API's answer.
    - `[low]` `[reject]` Retry idempotency holds only for a client-supplied id. — Same reason as the first Blind Hunter row.
    - `[false]` `[reject]` Additions beyond the intent. — These are descriptive, not defects. Each is a spec rule (unknown key, `run` on a foreign target, refused flags, relay door word).

## Auto Run Result

Status: done

**Summary:** Every Hold action now runs on the host that owns its Resource, and each front door forwards a foreign one. The front doors are the Hub API, the Host Agent and `hub-device`.
- One module (`tools/device/forward.mjs`) decides where an action runs. One transport (`hub-client.mjs` `forward`) carries it.
- A forward is the public route, plus `X-Hub-Forwarded: <door>`, plus `resource: {id, lock, host, rev, retired_at}`.
- big-chungus re-resolves the id against `registry.json`.
- The agent acts on the carried lock. It refuses a carried retired take, and refuses `rev: 0` for a Resource its seed lacks.
- A misplaced forward is `HUB_WRONG_HOST` and is never re-forwarded.
- A take carries a client-minted id, so a retried forward takes no second Lease.
- One abstraction level up (`belsky-doctrine`): every Hold verb, on all three front doors.

**Files changed:**
- `tools/device/forward.mjs` (new): the header and carried-record checks; what each Hold route names (`NAMED`, `namedRecords`, `placeOf`); the views (`hubView`, `peerView`); `withPlace`; `forwardHold`; and the errors.
- `tools/hub-client.mjs`: `FORWARD_HEADER` and `FORWARD_DOORS`, the `forwarded` and `signal` options on `request`, the ssh door word, the relay door, and `forward()`.
- `tools/hub-api/routes.mjs`: `hubHold` wraps the six forwardable Hold routes. The raw handler is kept as `route.local`.
- `tools/host-agent/routes.mjs`: the agent's forwarding wrapper. The Reservation force-release stays gated.
- `tools/host-agent/known.mjs`: `current()` gains `rev` and `seeded`.
- `tools/host-agent/server.mjs`: `ctx.request = send`.
- `tools/device/claims.mjs`: an optional `resource` on the extend, release and force-release bodies.
- `tools/device/hub-device.mjs`: CLI forwarding.
  - `--resource` works on release, extend and force-release.
  - A bare release or extend uses `$HUB_DEVICE` as its Resource.
  - Far problems print the local `HUB_DEVICE_*` lines.
  - SIGINT aborts a forward.
- `docs/hub-api-contract.md`: the Forwarding section, the relay door, the agent forwarding paragraph and the error rows.
- Tests:
  - New: `tools/hub-client-forward.test.mjs`, `tools/device/forward.test.mjs`, `tools/device/forward-cli.test.mjs`, `tools/hub-api/forward.test.mjs`.
  - Updated: `tools/host-agent/server.test.mjs`, `tools/device/lease-match.test.mjs`, `tools/hub-api/cancel.test.mjs`, `tools/hub-api/force-release.test.mjs`, `tools/hub-client.test.mjs`, `tools/deploy-path.test.mjs`.

**Review:** 38 findings: 7 medium, 21 low, 10 false, no high.
- **Patched:** 4 medium entries and 4 low entries. The medium entries are the "bare id" group, the "far lines" group, the retired public take test, and the CLI emulator tests (which also fixed the emulator word being carried as a record). The low entries are `hubHold`'s registry read, the agent rev-9 test, and two stale test titles.
- **Deferred:** none.
- **Rejected:** every rejected finding and its reason is listed in the Review Triage Log above.

**Follow-up review recommended: true.** Patched by verdict: 0 high, 4 medium, 4 low. Two changes made during review have not been through a review pass:
- the `$HUB_DEVICE` default for a bare `release` or `extend`;
- the emulator Pool no longer being carried as a single record in `namedRecords`, which affects all three front doors.

**Verification:**
- `node --test tools/hub-client*.test.mjs tools/device/forward*.test.mjs tools/hub-api/forward.test.mjs tools/host-agent/*.test.mjs tools/device/lease-match.test.mjs`: 172/172 pass.
- `mise run check` (actionlint and the full suite) exits 0, with 1750/1750 tests passing.
- Matrix audit: every I/O row is covered by a passing test in `tools/hub-api/forward.test.mjs`, `tools/device/forward-cli.test.mjs` and `tools/host-agent/server.test.mjs`.

**Residual risks:**
- No test crosses real ssh between the hosts. The door word and abort are tested against a fake ssh.
- An explicit lease id given with no Resource still runs on the receiving host. Only the `$HUB_LEASE_ID` + `$HUB_DEVICE` flow forwards without `--resource`.
- On the agent, each public Hold call that names something costs one `GET /resources`.
- `lease ipad|mac` on the CLI is Story 9.4.

## Design Notes

**Why a fleet entry carries the lock.** Claims finds every Hold through `ctx.fleet`: `phoneOwning`, `releasePhone`, `requestLocks` and `resolve`. On the agent, the named local record is added to the fleet as `{device: name, lock, deploy}`. Then release, extend, cancel and take act on exactly the carried lock, with no new Claims signature. Taking `ios-lane` this way gives it the 60 min deploy cap through `checkBounds`. That cap is 9.4's to exercise end to end.

**The forwarded lease body:**

```js
{ resource: { id: 'ios-lane', lock: 'mac-ios', host: 'mac', rev: 7, retired_at: null },
  for_ms: 1800000, wait_ms: 120000, id: 'l-3f9a…', holder: 'jarad@big-chungus', why: 'ipad proof',
  actor: { holder: 'jarad@big-chungus', via: 'cli' } }   // header X-Hub-Forwarded: cli
```

A Pool word or a `match` names no single Resource. It is forwarded unchanged (with no carried record) when every member lives on that one host. Members on mixed hosts stay local, and Claims refuses them (`HUB_POOL_CROSS_HOST`).

## Verification

**Commands:**
- `node --test tools/hub-client*.test.mjs tools/device/forward*.test.mjs tools/hub-api/forward.test.mjs tools/host-agent/*.test.mjs tools/device/lease-match.test.mjs` -- expected: all pass
- `mise run check` -- expected: actionlint clean, the full suite green
