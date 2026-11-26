---
title: 'Story 9.3: Forwarded actions reach the right host'
type: 'feature'
created: '2026-11-26'
status: 'in-progress'
baseline_revision: '274205a6077bbf31c5a766d12964406f5b2670a1'
review_loop_iteration: 0
followup_review_recommended: false
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
