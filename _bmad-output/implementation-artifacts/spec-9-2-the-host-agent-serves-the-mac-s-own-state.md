---
title: "Story 9.2: The Host Agent serves the Mac's own state"
type: 'feature'
created: '2026-11-26'
status: 'done'
baseline_revision: '4f66301b0af66d846603cf47e5bc8253ec6d4e43'
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-9-context.md'
warnings: ['oversized']
deferred:
  - summary: >-
      A Hold handler on the agent still reads retirement and the Resource record from the host's own lock-dir Registry file, not from what the agent knows.
    evidence: |-
      refuseRetired and the cancel and force-release paths call readRegistryFile or readRegistry on ctx.env (tools/device/claims.mjs:247, :258, :1271). On a spoke host there is no registry.json, so those paths see the seed. A Resource the Hub API retired would not be refused there. This is Claims behaviour from before this story, and the spec forbids Claims changes. It cannot happen in 9.2, because a Mac agent can take no Resource until 9.4 (the ios-lane take). It matters from 9.4 on.
    location: >-
      tools/device/claims.mjs:247
    severity: medium (unverified)
  - summary: >-
      No test runs the agent's real Hub API client wiring (the default send built from hub-client request, with the agent's hostKey and devices).
    evidence: |-
      Every start in tools/host-agent/server.test.mjs injects a request seam. Broken wiring degrades to one HUB_AGENT_REGISTRY_FAILED line, and the seed keeps answering, so the start test's expected outcome hides it. It would be settled by a start test that leaves request out but injects the ssh and fetch seams, or by the live /health readback that Story 9.7's install adds.
    location: >-
      tools/host-agent/server.mjs
    severity: medium
---

<intent-contract>

## Intent

**Problem:** Nothing on the Mac answers for the Mac's lock dir or the iPad. The `ios-lane` (lock `mac-ios`) can be described only by `ssh` plus `hub-device status`, so stories 9.3 to 9.5 have nothing to forward to or push from.

**Approach:** Add the Host Agent: `tools/host-agent/routes.mjs` (route table and handlers) and `tools/host-agent/server.mjs` (start and process entry). It reuses the Hub API's generic `startService`, `handle()` and the existing Hold route handlers. It serves `GET /health`, `GET /status` (the bare `statusView(<own key>, {audience: 'service', qa_ids})`) and the seven Hold routes. Each Hold route first passes a host gate, which refuses any Resource that lives on another host. The agent is keyed by `hostKey()`, never hard-coded to `mac`. That makes it the front door of any spoke host, and the Mac is the first one (belsky-doctrine).

## Boundaries & Constraints

**Always:**
- The bind is `127.0.0.1:<policy.api.host_agent_port>` (8795), through `startService({service: HOST_AGENT_SERVICE, port, routes: AGENT_ROUTES, ctx, heavy: false, ...})`.
  - `startService` gains `heavy = true`. When it is false, the `heavy`-on-PATH check is skipped, because the Mac boots no emulator. The Hub API's behaviour stays unchanged.
  - The Node >= 24.15 check, the EADDRINUSE singleton (`HUB_API_ALREADY_RUNNING`), the SIGTERM/SIGINT stop and the lease-wait registry are all `startService`'s.
- `main({argv, log, ...seams})` accepts only `--launchd` (anything else prints usage on stderr and returns 2).
  - With `--launchd`, `HUB_API_ALREADY_RUNNING` is logged and returns 0, so `KeepAlive {SuccessfulExit: false}` does not respawn the agent. Without it, it returns the error's `exit` (1).
  - The entry guard uses realpath, like `hub-api/server.mjs:275`, but with `main(...).then(code => { process.exitCode = code; })` instead of top-level await (the 9.1 cycle lesson).
- `HOST_AGENT_SERVICE = 'mobile-deploy-hub-host-agent'` is exported from `tools/hub-client.mjs`, beside `HUB_API_SERVICE`.
- `GET /health` returns exactly `{ok: true, service: HOST_AGENT_SERVICE, contract: HUB_API_CONTRACT, hub_version: hubRef(env) ?? 'unknown', ports: {hub_api, host_agent}}`, with no `registry` key.
- `GET /status` is `statusView(key, {audience: 'service', qa_ids: known.qaIds()}, createContext({env, now, policy, devicectl, hostKey, inventory, processStart, liveStart, fleet}))`, embedded unchanged.
  - `fleet` is this host's phones: `phonesOf(resources.filter(r => isLocal(r, {hostKey})))`, which is `[]` on the Mac.
  - Every timestamp comes from the agent's own `now` and lock dir. An unknown key is 503 `HUB_HOST_UNKNOWN`, as in `routes.mjs:152`.
- The iPad is read only inside `statusView`'s existing `key === 'mac'` branch (`readIpad` → `inspectIpad`, `devicectl(['list','devices'])`), and only when a row names `ios-lane`. There is no read at start, no read on a timer and no other devicectl verb.
- Registry knowledge (`tools/host-agent/known.mjs`, `createKnown({env, devices, qaDevices, log})`) keeps the last Hub API answer, or else the in-memory seed (`seed(devices ?? loadDevices(env), {qaDevices})`).
  - Its interface is `note(answer)`, `current()` (Hub answer resources when noted, else the seed's; pools and `words` always from the seed), `qaIds()` (`dedicatedQaIds(current().resources)`) and `refresh({request})`.
  - `refresh` makes one `GET /resources` through `hub-client.request({host: 'linux', ...})`. The server calls it once after the bind and never awaits it.
  - A failure is one `HUB_AGENT_REGISTRY_FAILED <message>` line on stderr, and the seed keeps answering. There is no retry.
  - The agent never reads `registry.json`. Its fleet and gate come from `known`.
- Host gate, before every Hold handler:
  - The route's own pure body check runs first (`checkLeaseBody`, `checkExtendBody`, `checkReleaseBody`, `checkForceReleaseBody`, `checkCancelBody`, `checkReservationForceReleaseBody`), so a bad body is still the 400.
  - Then the named Resource is found in `known`: by id, name or lock, then by seed `words`, and a Pool word stands for its members. A `match` is resolved with `match()` over `known.current()`. An `emulator-<n>` id (`namesEmulatorSlot`) and a Reservation `name` are found the same way.
  - Any of these on a host other than `hostKey()` is `HUB_WRONG_HOST` (409, exit 2), naming the Resource, its host and this host.
  - An unknown name passes to the handler, which refuses it as it always does.
  - The handler then runs with `ctx.fleet` set to this host's phones.
- `routes.mjs` `serviceContext` and `getLease` forward `ctx.fleet` when it is set. The Hub API sets none, so its behaviour is unchanged.

**Never:**
- No push, watch, `/agent/*`, forwarding or `ios-lane` take. Those are 9.3, 9.4 and 9.5.
- No change to `statusView` or to the Claims functions.
- No timer, interval or poll anywhere under `tools/host-agent/`.
- No `/registry/*`, `/resources`, `/discovery` or `/stream` route on the agent.
- No env-read port. The agent is never imported from the deploy path.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Start | fake `createServer` | listens `[8795, '127.0.0.1']`, prints `HUB_API_LISTEN port=8795`, starts one `refresh` | none |
| Second instance | EADDRINUSE | `main({argv: ['--launchd']})` returns 0; `main({argv: []})` returns 1; both log `HUB_API_ALREADY_RUNNING` | nothing written |
| Health | `GET /health` | keys exactly `ok, service, contract, hub_version, ports` | none |
| Status, lane held | `mac-ios` Lease plus waiter tickets, written with an injected far-off clock; `hostKey: () => 'mac'` | waiter `since` and Lease times equal that clock; `ios-lane` reachability is mapped from the fake devicectl, called exactly once with `['list','devices']` | devicectl throws → `unknown` |
| Status, lane free | no `mac-ios` rows | devicectl is never called | none |
| QA redaction | `known.note` marks `ios-lane` `dedicated_qa`; the `mac-ios` Lease owner carries a device serial and adb id | those values are `null`, the keys stay | none |
| Foreign Resource | `POST /leases` `s26`, `phone`, `emulator` or a `match` with linux members; force-release `emulator-1`; cancel `resource: s24`; Reservation `name: adb` | 409 `HUB_WRONG_HOST` `wrong-host`, exit 2; nothing written to the lock dir | none |
| Own Resource | a `mac-ios` waiter cancelled; a `mac-ios` Reservation force-released | 200 `Cancel` / `ReservationForceRelease`, same shapes as the Hub API | none |
| Registry route | `GET /registry/resources`, `POST /registry/resources` | 404 `HUB_NO_ROUTE` | none |
| Hub API unreachable | `refresh` rejects | one `HUB_AGENT_REGISTRY_FAILED` line; `qaIds()` come from the seed | no retry |

</intent-contract>

## Code Map

- `tools/hub-api/server.mjs:119-169` `startService` -- the generic start; add `heavy`. `:264-276` `main` and the entry are the pattern.
- `tools/hub-api/server.test.mjs:25-73` -- `FakeServer`, the `scratch()` seams and `exchange()`. Copy them for the agent tests.
- `tools/hub-api/routes.mjs:94-104` `health` (copy its shape, minus `registry`); `:152` `HOST_UNKNOWN`; `:306-314` `serviceContext` and `:325` `getLease` (add `fleet`); `:316-373` the seven Hold handlers to wrap; `:395` `ROUTES`; `:447` `handle(…, ctx)` takes `ctx.routes`.
- `tools/device/claims.mjs`:
  - `:162-180` `hostKey` and `isLocal`; `:207` `phonesOf`; `:185` `createContext`.
  - `:704`, `:1130`, `:1154`, `:1245`, `:1348` and `:1456` are the body checkers.
  - `:49` `namesEmulatorSlot`; `:1576-1729` `statusView` (the `mac` iPad branch is at `:1699`, and redaction at `:1724`).
  - `:128` gives `HUB_WRONG_HOST` 409 `wrong-host`.
- `tools/registry/seed.mjs:56` `seed` gives `ios-lane` host `mac`, words `ipad` and `mac`; the emulator Pool and the phones are `linux`. `:150` has `dedicatedQaIds`.
- `tools/registry/match.mjs` -- `match`, `parseQuery`; `tools/registry/view.mjs:13` -- the served record has no `words`.
- `tools/hub-client.mjs:29` `HUB_API_SERVICE`, `:248` `request()` -- the agent's only path to the Hub API.
- `tools/ci/lib/receipt.mjs:26` `hubRef`.
- `tools/hub-api/contract.test.mjs:30-75` `parseContract`, `:287` the "no shape orphaned" test, which must count the agent's shapes.
- `docs/hub-api-contract.md` -- add a `## Host Agent` section.
- `tools/clock.test.mjs:17` and `tools/deploy-path.test.mjs:16` already cover `tools/host-agent/`.

## Tasks & Acceptance

**Execution:**
- `tools/hub-client.mjs` -- export `HOST_AGENT_SERVICE`.
- `tools/hub-api/server.mjs` -- add the `heavy` option to `startService`.
- `tools/hub-api/routes.mjs` -- forward `ctx.fleet` in `serviceContext` and `getLease`.
- `tools/host-agent/known.mjs` -- `createKnown`, as above.
- `tools/host-agent/routes.mjs` -- `agentHealth`, `agentStatus`, the gate, and `AGENT_ROUTES`. `AGENT_ROUTES` has the same method, path and shape as the Hub's Hold routes, plus Health → `AgentHealth` and Status → `HostView`.
- `tools/host-agent/server.mjs` -- `startHostAgent(seams)`, `main` and the entry.
- `tools/host-agent/server.test.mjs` -- hermetic tests for every matrix row, through `handle()` and `requestListener` with fakes: no port bound, a temp lock dir, `hermetic()`. A timer spy wraps `globalThis.setTimeout` and `setInterval` across start, `/health`, `/status`, a gate refusal and stop, and asserts zero calls.
- `docs/hub-api-contract.md` and `tools/hub-api/contract.test.mjs`:
  - The doc gets a `## Host Agent` section: base URL `127.0.0.1:8795`, its own `| Method | Path | Shape | Added |` table, `### AgentHealth` fields, and `### HostView` described as Status's `hosts.{host}.` fields, unprefixed. It also covers the gate and `HUB_WRONG_HOST` for the Hold routes, and states that `/registry/*` is 404.
  - `parseContract` returns `agentRoutes` from that section. The orphan test counts the agent's shapes. A new test holds that table equal to `AGENT_ROUTES`, `/health` keys equal to `AgentHealth`, and `/status` keys to a subset of `HostView` whose root keys are exactly the six v1a lists.

**Acceptance Criteria:**
- Given the full suite, when `mise run check` runs, then it is green, including the clock, deploy-path, contract and host-agent tests.
- Given `node tools/host-agent/server.mjs --bogus`, when it runs, then usage goes to stderr and it exits 2.
- Given an agent context with `hostKey: () => 'mac'`, when every route in `AGENT_ROUTES` is called through `handle()`, then no answer is a 500.

## Spec Change Log

## Review Triage Log

### 2026-11-26 — Review pass
- verdicts: 23 findings — high 0, medium 4, low 9, false 10, maybe-false 0
- findings:
  - `[medium]` `[reject]` Blind: what the agent knows is fixed at start. One refresh, so qa_ids and the gate go stale until restart. — Real, but the intent contract mandates exactly one refresh, after the bind, with no retry and no timer under tools/host-agent/. The fix is to edit this build's spec. Updates arrive with 9.3's push.
  - `[low]` `[reject]` Blind: the gate re-implements Resource resolution and does not skip retired records. — A retired foreign Resource is still refused, only as HUB_WRONG_HOST. A shared resolver would need a Claims change, which the spec forbids. It adds structure for a rare case.
  - `[false]` `[reject]` Blind: a `host` field in the cancel body is ignored. — checkCancelBody returns `host` (claims.mjs:1256), and the cancel handler requires `input.host` to be this host's key (claims.mjs:1298).
  - `[false]` `[reject]` Blind: the `POST /leases` gate breaks when `match` is undefined. — checkLeaseBody always returns `match: null` when there is none (claims.mjs:724), so `names` takes the resource path.
  - `[false]` `[reject]` Blind: gate coverage is partial and undocumented (extend, release, GET lease). — The doc names exactly what each route names. A lease id lives in this host's own lock dir, so a foreign one is not found by construction.
  - `[low]` `[reject]` Blind: the doc hard-codes `v1.2.60` in `hub_version`. — It mirrors the Hub API's Health entry (hub-api-contract.md:51) as an example value. It is cosmetic.
  - `[false]` `[reject]` Blind: there is no way to start the agent (no plist, installer or readback). — Story 9.7 (epics-v1b.md:1528) owns the LaunchAgent plist, `install.sh`'s Darwin branch and the `/health` readback.
  - `[false]` `[reject]` Blind: refresh has no timeout, and the start test is racy. — hub-client `request` bounds every call (ssh ConnectTimeout, the relay idle timeout, AbortSignal.timeout). The test's fake request resolves in one tick, and the test passes deterministically.
  - `[low]` `[reject]` Blind: duplication (`oneLine`, `say`) and the WeakMap fallback in `knownOf`. — Cosmetic. The fallback serves only a bare `handle()` with no `known`, and the server always passes one.
  - `[low]` `[reject]` Blind: `/status` is not tested on a linux-keyed agent. — The linux fleet in statusView is the Claims library's own tested path. The Mac `/status` test pins the fleet `[]` against the library's answer.
  - `[low]` `[reject]` Blind: no test of a concurrent `/status` with a devicectl timeout. — The iPad read is statusView's existing, tested code, and the throw-to-`unknown` mapping is covered.
  - `[low]` `[reject]` Blind: the "nothing reads registry.json" source regex is easy to bypass. — It backs a review rule. The new fleet test now pins the behaviour itself.
  - `[false]` `[reject]` Edge: a Hub API answer with `resources: []` or null items empties the gate or crashes it. — The Hub API serves `readRegistry`, which always applies the seed, so an empty or holey list is not reachable. `refresh` checks `Array.isArray`.
  - `[medium]` `[reject]` Edge: the seed answers until restart when the Hub API is down at start. — Same root as the first Blind finding. The intent contract mandates no retry, so this is a spec edit.
  - `[low]` `[reject]` Edge: `loadDevices` sits outside the try, so a broken devices.json makes every call a 500. — devices.json is tracked and parsed strictly, so a broken one fails loudly everywhere. That is the intended behaviour.
  - `[low]` `[reject]` Edge: a `match` that throws (HUB_NO_MATCH or HUB_POOL_CROSS_HOST) skips the gate. — The handler still refuses it, only with a different code. The fix adds branches for a rare case.
  - `[false]` `[reject]` Edge: a foreign lease id is HUB_LEASE_NOT_FOUND, not HUB_WRONG_HOST. — Lease ids live in this host's lock dir. The spec ungates these routes, and NOT_FOUND is the correct answer for an id this host never issued.
  - `[low]` `[defer]` Edge: Hold handlers read retirement from the lock dir's Registry file, not from what the agent knows. — This is Claims behaviour from before this story (claims.mjs:247, :258, :1271), and the spec forbids Claims changes. It cannot happen in 9.2, since a Mac agent takes no Resource. Deferred for 9.4.
  - `[false]` `[reject]` Edge: the doc claims every Hold route is gated. — The doc lists which route names which Resource. It never says the lease-id routes are gated.
  - `[medium]` `[patch]` Gap: dropping the fleet pass-through (in `gated()`, `serviceContext` or `getLease`) passed every test. — Added the test "a Hold handler's fleet is what the agent knows, never the lock dir's Registry" to tools/host-agent/server.test.mjs: a linux-keyed agent whose noted Hub API answer lacks s24 cannot take s24 but can take s26. Mutation-checked: removing the fleet in `gated()` fails it, and so does removing it in `serviceContext`.
  - `[medium]` `[defer]` Gap: the agent's real Hub API client wiring is never run. — As filed: broken wiring degrades to one log line by design, and there is no ssh seam at start. It would be settled by a seam-injected start test, or by Story 9.7's live `/health` readback.
  - `[false]` `[reject]` Gap (other): a Mac-keyed agent cannot lease `mac-ios` or `ipad`. — Expected and recorded in Design Notes: the ios-lane take is Story 9.4.
  - `[false]` `[reject]` Intent: the "on the Mac" part (a running LaunchAgent, a live iPad) is not demonstrated. — epics-v1b.md Story 9.7 owns the install and the live readback, and the epic's ship story owns the Mac `hosts:install` operator actions. 9.2's acceptance criteria are all agent-checkable, so no operator action is owed here.

## Design Notes

"For its host only" is read as the gate rather than a forward. 9.2 refuses with the existing `HUB_WRONG_HOST`, and 9.3 later forwards the same requests through the same gate. Until 9.4, a take of `ipad` passes the gate and is refused by Claims as an unknown device. That is expected.

`refresh` at start is the one Hub API call 9.2 makes. AD-26 allows an agent to call at its own start, so qa_ids from the "last Hub API answer" are real, not a seam with no caller.

## Verification

**Commands:**
- `node --test tools/host-agent/server.test.mjs tools/hub-api/contract.test.mjs tools/hub-api/server.test.mjs tools/clock.test.mjs tools/deploy-path.test.mjs` -- expected: all pass.
- `mise run check` -- expected: green.

## Auto Run Result

Status: done

**Summary.** The Host Agent now exists. It is a loopback service on `127.0.0.1:8795`, keyed by `hostKey()`, so it fronts any spoke host. The Mac is the first. It reuses the Hub API's `startService` (with `heavy: false`) and `handle()`. It serves:
- `GET /health` (AgentHealth, with no `registry`).
- `GET /status` (the bare `statusView(<own key>, {audience: 'service', qa_ids})` from its own lock dir and clock; the iPad is read only when a row names `ios-lane`).
- The seven Hold routes behind a host gate. A Resource on another host is `HUB_WRONG_HOST` (409, exit 2), and nothing is written.

Its Registry knowledge (`known.mjs`) is the Hub API's last `GET /resources` answer, or else the in-memory seed. One non-awaited refresh runs after the bind. There are no timers and no `/registry/*` routes, and it never reads `registry.json`. `main` accepts only `--launchd`. With it, ALREADY_RUNNING exits 0; anything else is usage and exit 2.

**Files changed.**
- `tools/hub-client.mjs`: exports `HOST_AGENT_SERVICE`.
- `tools/hub-api/server.mjs`: `startService` gains `heavy` (default true; false skips the `heavy`-on-PATH check).
- `tools/hub-api/routes.mjs`: `serviceContext` and `getLease` forward `ctx.fleet` when it is set.
- `tools/host-agent/known.mjs` (new): `createKnown` (note, current, qaIds, refresh).
- `tools/host-agent/routes.mjs` (new): `agentHealth`, `agentStatus`, the host gate and `AGENT_ROUTES`.
- `tools/host-agent/server.mjs` (new): `startHostAgent`, `main`, and the realpath entry guard.
- `tools/host-agent/server.test.mjs` (new): 20 hermetic tests covering every matrix row, a linux-keyed agent, the no-500 sweep, the zero-timer spy and the fleet source.
- `docs/hub-api-contract.md`: a `## Host Agent` section (route table, AgentHealth, HostView, the gate).
- `tools/hub-api/contract.test.mjs`: `parseContract` reads the agent's table and shapes. The orphan test counts them, and 3 agent contract tests were added.

**Review findings (23).** 1 patch, 2 deferred, 20 rejected.
- Patch:
  - (medium) A test that a Hold handler's fleet is what the agent knows. It is mutation-checked against `gated()` and `serviceContext`.
- Deferred:
  - (medium, unverified) Hold handlers read retirement from the lock-dir Registry file. This is Claims behaviour from before this story, and it matters from 9.4.
  - (medium) The agent's real hub-client wiring is not run by a test.
- Rejected: every rejected finding and its reason is logged in the Review Triage Log above.
  - 10 false.
  - 2 medium whose fix edits the intent contract (one refresh, no retry).
  - 8 low, cosmetic or rare, where the fix would add complexity.

**Follow-up review recommendation:** false. Only one medium was patched, and no high (patched by verdict: high 0, medium 1, low 0).

**Verification.**
- `node --test tools/host-agent/server.test.mjs tools/hub-api/contract.test.mjs tools/hub-api/server.test.mjs tools/clock.test.mjs tools/deploy-path.test.mjs`: 83/83 pass.
- `mise run check`: green, 1681/1681 tests plus actionlint.
- `node tools/host-agent/server.mjs --bogus`: usage on stderr, exit 2.
- Matrix audit: all 10 rows are covered by tests that ran and passed.

**Residual risks.**
- The agent learns the Registry once, at start. If the Hub API is down then, the seed's QA marks answer until restart, as the spec mandates. 9.3's push is where updates arrive.
- No test runs the agent against real ssh or a real iPad. The install and the live `/health` readback are Story 9.7's.
- The hub release and the Mac `hosts:install` belong to the epic's ship story. This story owes no operator action.
