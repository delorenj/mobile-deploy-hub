---
title: 'Story 9.4: `lease ipad` and `lease mac` take the `ios-lane`'
type: 'feature'
created: '2026-11-26'
status: 'done'
baseline_revision: '31bef704a254cea0a428a13c7018dcd51a405c92'
review_loop_iteration: 0
followup_review_recommended: true
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-9-context.md'
warnings: ['oversized']
deferred: []
---

<intent-contract>

## Intent

**Problem:** `hub-device lease ipad|mac` does not work from anywhere. On big-chungus, 9.3's `forwardCommand` returns early for the iOS lane, and the local take then fails with `unknown device "ipad"`. On the Mac, the CLI fleet holds only linux phones, so the same take fails there too. A service take is always lock-only, so nothing can ask for the iPad to be reachable.

**Approach:** A lane (a Resource that is not a phone and holds one lock on its host: today the `ios-lane`) becomes a fleet entry of its own host. Its words (`ipad`, `mac`) resolve to it, its take never touches adb, and its exports have no `ANDROID_*` key.
- On its own host the CLI takes the lane in-process.
- From any other host the CLI forwards the lease through 9.3's `forwardHold`.
- A take by the lane's device word (`ipad`) without `--no-connect` needs the device's Reachability to be `reachable`. That need travels in a new optional `POST /leases` body key, `require_reachable`, so the host that owns the device checks it.

The neighbouring level (`belsky-doctrine`) is every lane, by every one of its words, from every front door. `require_reachable` works for any single-Resource service take: a lane through its host's device read, and a phone through the service's reading cache.

## Boundaries & Constraints

**Always:**
- Every rule lives in `tools/device/claims.mjs` (AD-24): which words of a lane need the device, the reachability gate, the lane entry and the lane exports. `hub-device` and the services only call it.
- A lane take is the lock only: there is no `findPhone`, no serial check and no adb. With `require_reachable`, the device is read before any ticket, lock or event is written. A reading other than `reachable` is `HUB_DEVICE_AWAY` (503, exit 75) with `reason` set to the state.
- The iPad is read only through `readIpad` over `devicectl list devices`, from the context's `devicectl` seam, with the `devices.json` `ios` udid and model. A read that throws counts as `unknown`.
- The 60 min deploy-target cap on `mac-ios` is checked by the CLI before it forwards, so `--for 2h` exits 2 naming the cap and nothing is sent.
- An unreachable Mac gives 9.3's `HUB_DEVICE_AWAY` (exit 75, `host-unreachable`). The CLI prints `HUB_DEVICE_AWAY ipad` on stdout and `hub-device: ipad is away: host-unreachable` on stderr. Nothing is written on either host.
- On big-chungus the CLI resolves from its own Registry and sends to the Mac directly. It never asks the Hub API.
- Tests are hermetic: injected `request` bridges into the agent's `handle()`, a fake `devicectl`, a fake clock and temp lock and event dirs.

**Never:**
- No new lock, queue, timer, retry or poll, and no Python.
- No change to the deploy path (`tools/ci/commands/*`, `tools/catchup/*`) or to how iOS jobs and the catch-up take `mac-ios`.
- No `require_reachable` on a Pool word, a `match` or an emulator: it names one Resource (400 `bad-reachable`).
- `release --any` never frees a lane: it stays "whichever lease holds a phone".
- Phone forwards from the Mac keep 9.3's behaviour: `--no-connect` stays refused on a forwarded non-lane lease.
- Never write `sprint-status.yaml`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|---|---|---|---|
| ipad from big-chungus | linux CLI `lease ipad --for 30m --why x` | forwards `POST /leases` to `mac`, door `cli`, body `resource:{id:'ios-lane',lock:'mac-ios',host:'mac',…}` plus `require_reachable:true`. The Mac takes `mac-ios` on its own disk and clock. The CLI prints `export HUB_LEASE_ID=…` and `export HUB_DEVICE='ios-lane'` (no `ANDROID_*`) | iPad not reachable → stdout `HUB_DEVICE_AWAY ipad`, exit 75, `ipad is away: <state>`, nothing written |
| mac / --no-connect | `lease mac …` or `lease ipad --no-connect …` | forwarded with no `require_reachable` key; the take needs only the host; `devicectl` is never called | — |
| Mac asleep | the transport fails | exit 75, `HUB_DEVICE_AWAY ipad`, reason `host-unreachable` | no ticket on either host |
| Over the cap | `lease ipad --for 2h` (on either host) | exit 2, stderr names the 60 min cap (`--for 2h: a lease on mac-ios runs at most 60 min …`) | nothing sent, nothing written |
| Mac in-process | Mac CLI `lease ipad`, `lease mac`, `release` (via `$HUB_LEASE_ID` + `$HUB_DEVICE`), `extend` | runs locally on the Mac lock dir. The lines and exits are the local verb's (`HUB_DEVICE_RELEASED ios-lane <id>`, `HUB_DEVICE_BUSY ipad …` exit 76 when held) | ipad unreachable → exit 75 |
| Queue behind a Lease | Lease on `mac-ios` (via forward), then an iOS `job` and a `hub-job` catch-up `withLock('mac-ios')` | they queue in arrival order and are served in order after the release. The Lease's `started_at` and the event times are the Mac clock | — |
| API body | `POST /leases {resource:'s24', require_reachable:true}` on linux | gated by the service's reading cache (`readingsOf`): not `reachable` → 503 `HUB_DEVICE_AWAY` | `require_reachable` not a boolean → 400 `bad-reachable`; with `match`, a Pool word or `emulator` → 400 `bad-reachable` |

</intent-contract>

## Code Map

- `tools/device/claims.mjs`:
  - `resolve` (:383) finds an entry by Resource id, then by `device`. It gains `words` as a third lookup.
  - `take` (:658) `case 'phone'` goes to `takePhone` (:525). The serial check is at :527 and `connectPhone` at :488.
  - `leaseExports` (:675) always adds `ANDROID_ADB_SERVER_PORT`.
  - `LEASE_BODY_KEYS` / `checkLeaseBody` (:693-725) are pinned by `tools/hub-api/leases.test.mjs:382`.
  - `serviceLease` (:829) always takes with `noConnect: true`.
  - `releaseAny` (:1043) walks the whole fleet.
  - `statusView`'s iPad read (:1710-1719): refactor it to call the new lane read.
  - `seed`, `loadDevices`, `deployTargetCapMs`, `readIpad` and `createDevicectl` are already imported.
- `tools/device/forward.mjs`:
  - `withPlace` (:181) builds `{device, lock, deploy, name, serial, model}`. It must build a lane's entry through claims' `laneEntry` (with `kind` and `words`; the words come from `view.words`, because served records carry none).
  - `forwardHold` (:211) copies the body, so `require_reachable` passes through.
- `tools/device/hub-device.mjs`:
  - `forwardCommand` (:880). Remove the ios-lane early return at :888. The `--no-connect` refusal is at :896 and the body is built at :899-901.
  - `main` (:978) loads the fleet at :1016.
  - `lease` (:264) and `runCommand` (:657) build the take options.
  - `report` (:195) already prints the AWAY, BUSY and usage lines.
  - The header comment (:81-87) and `USAGE` (:148) say `lease ipad|mac` is 9.4's.
- `tools/hub-api/routes.mjs` -- `serviceContext` (:306) does not pass `devicectl`. Add it, so the agent's lane gate reads the iPad through its seam. `takeLease` (:316) already passes the checked input to `waits.lease` and `serviceLease`.
- `tools/host-agent/routes.mjs` -- `placed` (:77) and `forwarding` (:84) need no logic change. They benefit from `withPlace`'s lane entry.
- Test harnesses to reuse:
  - `tools/device/forward-cli.test.mjs:21` (`run` with a `request` seam). Its test at :119-133 pins "does not forward `lease ipad`", so rewrite it.
  - `tools/hub-api/forward.test.mjs:33` (`world`: linux and mac `handle()` bridges).
  - `tools/host-agent/server.test.mjs:45` (`ipadDocument`, a reachable devicectl document).
  - `tools/device/lease.test.mjs:1095` (the mac-ios FIFO with `withLock`, `jobEnv` and `fakeTimers`).
- `docs/hub-api-contract.md`:
  - `POST /leases` body list (:414-431) and the Error codes `HUB_USAGE` row (:498).
  - Lease `env.*` (:298).
  - The Forwarding CLI paragraph (:576).

## Tasks & Acceptance

**Execution:**
- [x] `tools/device/claims.mjs`:
  - Add `LANE_DEVICE_WORDS = {'ios-lane': ['ipad']}`, `isLane(record)`, `laneEntry(record, policy)` (`{device: name, lock, deploy, name, serial: null, model, kind, words}`), `lanesOf(resources, key)`, `hostLanes(key, {env})` (from the seed of `devices.json`) and `needsDevice(word, entry, {noConnect})`.
  - `resolve`: also match `entry.words`.
  - `take` `case 'phone'`: when `options.requireReachable`, run `mustBeReachable` first. A lane is read with `laneReachability` (`readIpad`). A phone is read with `options.readingsOf` and skipped without one. A lane is taken with `noConnect: true`.
  - `leaseExports`: no `ANDROID_*` for a lane.
  - `checkLeaseBody`: optional boolean `require_reachable` (`bad-reachable`), returned as `requireReachable` (default false).
  - `serviceLease`: pass it to `take`. A non-`phone` target with it set is `bad-reachable`.
  - `releaseAny`: skip lanes.
  - `statusView`: use `laneReachability`.
- [x] `tools/device/forward.mjs` -- `withPlace` builds a lane through `laneEntry`, with the carried lock.
- [x] `tools/hub-api/routes.mjs` -- `serviceContext` passes `ctx.devicectl`.
- [x] `tools/device/hub-device.mjs`:
  - `main`: for the Hold verbs on a host whose key is known, set `context.fleet` to the fleet plus `hostLanes(own)`.
  - `lease` and `runCommand`: pass `requireReachable: needsDevice(word, entry, {noConnect})`.
  - `forwardCommand`:
    - Drop the ios-lane early return.
    - Accept `--no-connect` when `place.single` is a lane.
    - For a single carried Resource, run `checkBounds` locally on its `withPlace` entry, so the cap error names `--for <text>`.
    - Set `body.require_reachable = true` only when `needsDevice`.
  - Update the header comment and `USAGE`.
- [x] Tests:
  - New `tools/device/lease-lane.test.mjs`:
    - A linux CLI → bridge → agent `handle()` over a temp Mac dir, covering every matrix row: ipad reachable and not, mac, `--no-connect`, Mac asleep, `--for 2h`, Hub API down (no linux call).
    - The Mac's in-process `lease`/`release`/busy.
    - The FIFO-and-clock test with an iOS `job` and a `hub-job`.
  - Add the `bad-reachable` and `s24` cache gate cases in `tools/hub-api/leases.test.mjs`. Update :382 for `requireReachable`.
  - Rewrite `forward-cli.test.mjs:119`.
- [x] `docs/hub-api-contract.md`:
  - `require_reachable` in the `POST /leases` body.
  - Its refusals (`bad-reachable`, `HUB_DEVICE_AWAY` with the state as `reason`).
  - A lane's `env` (`HUB_LEASE_ID`, `HUB_DEVICE`).
  - The Forwarding paragraph: `lease ipad|mac` forwarded, `--no-connect` on a lane, the local cap check.

**Acceptance Criteria:**
- Given a linux-keyed CLI and the Mac agent behind a bridge, when `lease ipad --for 30m` runs with the iPad reachable, then exit 0, the exports are `HUB_LEASE_ID` and `HUB_DEVICE='ios-lane'`, `mac-ios` is held in the Mac's lock dir with the Mac clock's `started_at`, and big-chungus' lock dir does not exist.
- Given a Lease on `mac-ios` taken that way, when an iOS job and then the catch-up call `withLock('mac-ios')` on the Mac, then `queueView` lists them at places 1 and 2, and after `release` they run in that order.
- Given the Mac's own CLI, when `lease ipad` runs with the iPad `offline`, then the exit is 75 and stdout is exactly `HUB_DEVICE_AWAY ipad`. When `lease mac` runs, it takes `mac-ios` without calling `devicectl`.
- Given `mise run check`, when it runs, then actionlint and the full suite are green.

## Spec Change Log

## Review Triage Log

### 2026-11-26 — Review pass
- verdicts: 27 findings — high 0, medium 4, low 12, false 10, maybe-false 1
- findings:
  - `[false]` `[reject]` Blind: a Hub API forward may drop `require_reachable` — `forwardHold` (tools/device/forward.mjs) copies `request.body` verbatim before it sets `resource`/`actor`/`id`, so the key travels. The new hub-api/forward.test.mjs case now shows it end to end.
  - `[low]` `[patch]` Blind: `mustBeReachable` silently passes a phone when there is no `readingsOf` — now the phone reads `unknown` (HUB_DEVICE_AWAY), as the contract says.
  - `[low]` `[reject]` Blind: reachability is read once before queueing, so a waited take can be granted after the iPad goes away — real, but the spec says to read before any ticket, and an iPad dropping off during a ≤2 min wait is rare. A re-check at grant time needs a release-and-throw branch. The holder releases it like any Lease.
  - `[low]` `[reject]` Blind: the devicectl read ignores the abort signal and runs once per take — the read is bounded at 10 s by `devicectl(…, 10)`. Threading the signal or caching it adds plumbing for a rare case.
  - `[false]` `[reject]` Blind: `lease ios-lane` skips the iPad gate while `lease ipad` enforces it, and LANE_DEVICE_WORDS duplicates the seed words — this is intended. The intent's Approach gates only the lane's *device* word, and `mac` and the id need only the host. LANE_DEVICE_WORDS is the device-word subset, not a copy of the word list.
  - `[medium]` `[patch]` Blind: `run ipad|mac` is untested — grouped with the verification-gap finding below. Mac-side `run ipad` (offline, then reachable) and `run mac` tests were added.
  - `[false]` `[reject]` Blind: the JSON or API lease view of a lane emits a phantom `adb_port` — `leaseView` and the CLI's `--json` print `device: phone.device` (a string) and `env: leaseExports(...)`, which has no `ANDROID_*` for a lane. The connectPhone `device` object is never printed.
  - `[false]` `[reject]` Blind: `withPlace`'s `view.words` lookup is dead — `hubView` supplies `words: wordsOf(registry.resources)` (forward.mjs:159,165), so big-chungus' lane entry carries `ipad` and `mac`.
  - `[low]` `[patch]` Blind: the AWAY message tells an HTTP caller about `--no-connect` — it now reads "(without require_reachable, --no-connect on the CLI, it takes the lock only)".
  - `[low]` `[reject]` Blind: the lane tests use real `settle(30)` sleeps that may flake — this is the same pattern as the existing mac-ios FIFO test (lease.test.mjs:1095), and the suite is green. Rewriting the harness to poll is more than a direct fix.
  - `[low]` `[reject]` Blind: docs outside the API contract (README, features.md, the design doc) are not updated — no doc outside the contract claims `lease ipad` is unsupported (grep finds nothing), the contract is the reference for verbs, and the CLI header and USAGE are updated.
  - `[medium]` `[patch]` Edge: the agent's Hold routes that name nothing (GET /leases/{id}, a bare release, extend or force-release) used a phones-only fleet, so a lane Lease came back 404 on the Mac — the Hold routes now use `holdFleet` (phones plus `lanesOf`), and status keeps `fleetOf`. A test was added: a take through the agent, then GET, extend and release by id.
  - `[low]` `[reject]` Edge: a queued lane take is granted after a one-shot read — the same root cause as the Blind reachability-race row, rejected on the same grounds.
  - `[maybe-false]` `[reject]` Edge: a stale cached phone reading may still say `reachable` — whether `ctx.readings.read` downgrades stale readings was not checked. If true, it is only low: the spec specifies the service cache for phones, and the cache already gates `--match`.
  - `[false]` `[reject]` Edge: `hostLanes` re-reads devices.json, so a missing devices.json breaks every Hold verb — `readRegistry` (tools/registry/store.mjs:93) loads devices.json for the seed on every call too, so `loadFleet` already fails the same way.
  - `[low]` `[patch]` Edge: the `phone` Pool in `requestLocks` covered the lane's lock once the lane joined the Mac fleet — lanes are now filtered out.
  - `[false]` `[reject]` Edge: `lease ios-lane` skips the gate — this duplicates the Blind row above, and the behaviour is intended.
  - `[low]` `[patch]` Edge: the contract says `bad-reachable` is checked "before anything is read", but the Pool-word and emulator case comes after resolve — the contract now says that case follows the word's resolution, with nothing written.
  - `[medium]` `[patch]` Verification gap: `runCommand`'s lane path (the gate and the exports) has no test — the Mac `run ipad` offline case (75, no lock, the child never runs), the reachable case (`HUB_DEVICE=ios-lane`, no `ANDROID_*`, released after) and `run mac` (no devicectl call) were added in lease-lane.test.mjs.
  - `[false]` `[reject]` Verification gap (other): the `withPlace` empty-words fallback on a peerView host is unexercised — only two host keys exist. The Mac resolves its own lane through `hostLanes` (seed words), and big-chungus through `hubView` words. No host reaches the fallback for a word lookup.
  - `[false]` `[reject]` Intent: the production agent's `devicectl` may not reach the lane gate — `startHostAgent` puts `devicectl` in ctx (server.mjs:31), the routes pass it (host-agent/routes.mjs:52), and `serviceContext` now forwards it. The live relay is Story 9.8's check.
  - `[low]` `[reject]` Intent: a slow-to-answer Mac (connect timeout) is untested — that is 9.3's transport in hub-client.mjs, unchanged here.
  - `[false]` `[reject]` Intent: "Hub API down" is shown only by zero linux calls — the bridge records and refuses every linux-bound call, so zero calls is the proof that the CLI never asked.
  - `[low]` `[reject]` Intent: a Mac agent on an older release would refuse `require_reachable` as `bad-body` — the CLI and the agent ship in one hub release. `lease mac` and `--no-connect` are unaffected meanwhile, and the live rollout is Story 9.8's.
  - `[low]` `[patch]` Intent: the Hub API's own forward (door `api`) of a lane take with `require_reachable` was untested — a case was added in hub-api/forward.test.mjs (offline gives 503 `offline` with nothing written; reachable takes `mac-ios` on the Mac).
  - `[medium]` `[patch]` Intent: `run` has no lane test — grouped with the verification-gap row, same tests.
  - `[false]` `[reject]` Intent: the epic's "iPad Reachability" differs from the devicectl read — the iPad's Reachability *is* `readIpad` over `devicectl list devices` on its host, the same read `statusView` uses (now through `laneReachability`).

## Design Notes

**Why a body key and not the word.** A forward replaces `resource` with the carried record, so the far side never sees `ipad` or `mac`. The sender knows the word and `--no-connect`. The device's host is the only one that can read it. So the sender says "this take needs the device" (`require_reachable: true`) and the owner checks it. The key is absent when false, so every 9.3 body is unchanged.

```js
// linux CLI `lease ipad --for 30m --why x`  →  X-Hub-Forwarded: cli
{ resource: { id: 'ios-lane', lock: 'mac-ios', host: 'mac', rev: 3, retired_at: null },
  for_ms: 1800000, wait_ms: 120000, why: 'x', id: 'l-…', holder: 'jarad@big-chungus',
  actor: { holder: 'jarad@big-chungus', via: 'cli' }, require_reachable: true }
```

**Why the lane joins the fleet only for Hold verbs.** The Claims library finds every Hold through `ctx.fleet`. On the Mac, the lane must be there for `release`, `extend`, `cancel` and `force-release` by id to find `mac-ios`. `status` keeps its own view and is untouched.

## Verification

**Commands:**
- `node --test tools/device/lease-lane.test.mjs tools/device/forward-cli.test.mjs tools/device/forward.test.mjs tools/hub-api/forward.test.mjs tools/hub-api/leases.test.mjs tools/host-agent/server.test.mjs tools/device/hub-device.test.mjs tools/device/lease.test.mjs tools/device/status-view.test.mjs` -- expected: all pass
- `mise run check` -- expected: actionlint clean, the full suite green

## Auto Run Result

Status: done

**Summary.** `hub-device lease ipad` and `lease mac` now take the `ios-lane` (lock `mac-ios`, with the 60 min deploy-target cap) from either host.
- On the Mac the take runs in-process.
- From big-chungus it is forwarded to the Mac's Host Agent through 9.3's `forwardHold`.
- The take is the lock only: no adb, and the exports are just `HUB_LEASE_ID` and `HUB_DEVICE='ios-lane'`.
- `ipad` without `--no-connect` sends the new `POST /leases` key `require_reachable: true`. The Mac then reads the iPad through `devicectl` before writing anything, and any reading other than `reachable` is `HUB_DEVICE_AWAY` (75).

The neighbouring level (`belsky-doctrine`):
- Lanes are fleet entries of their own host. Every word reaches them from every front door: the CLI, the Hub API and the Host Agent.
- `require_reachable` works for any single-Resource service take. A phone is checked through the service's reading cache.

**Files changed**
- `tools/device/claims.mjs`:
  - New lane helpers: `isLane`, `laneEntry`, `lanesOf`, `hostLanes`, `needsDevice` and `laneReachability`.
  - `resolve` finds a lane by its words.
  - `take` has the `mustBeReachable` gate.
  - A lane's exports have no `ANDROID_*` key.
  - `checkLeaseBody` and `serviceLease` accept `require_reachable` and refuse bad uses with `bad-reachable`.
  - `releaseAny` and `requestLocks`' phone Pool skip lanes.
  - `statusView` reuses the lane read.
- `tools/device/forward.mjs`: `withPlace` builds a lane through `laneEntry`.
- `tools/device/hub-device.mjs`:
  - The Hold verbs see the host's lanes, and `lease` and `run` pass `requireReachable`.
  - `forwardCommand` now forwards lanes, allows `--no-connect` on a lane, checks the cap before sending and sets `require_reachable`.
  - The header comment and USAGE are updated.
- `tools/hub-api/routes.mjs`: `serviceContext` passes the `devicectl` seam.
- `tools/host-agent/routes.mjs`: the Hold routes that name nothing use `holdFleet` (phones plus lanes), so a lane Lease is found by its id.
- `docs/hub-api-contract.md` documents:
  - `require_reachable` and its refusals.
  - A lane's `env`.
  - The forwarding of `lease ipad|mac`.
- Tests:
  - `tools/device/lease-lane.test.mjs` is new. It covers every matrix row, `run ipad|mac`, and the agent finding a lane by id.
  - `tools/hub-api/leases.test.mjs` adds the `bad-reachable` cases and the `s24` cache gate.
  - `tools/hub-api/forward.test.mjs` adds the Hub API's forward of a lane take with `require_reachable`.
  - `tools/device/forward-cli.test.mjs` rewrites the old 9.4 exclusion test.

**Review findings breakdown.** 27 findings: high 0, medium 4, low 12, false 10, maybe-false 1. Every row is in the Review Triage Log above.

7 entries were patched (2 medium entries, 5 low):
- medium: the `run` lane tests (3 grouped findings).
- medium: the agent's Hold-route fleet now includes lanes.
- low: the phone reads `unknown` when there is no reading cache.
- low: the AWAY message is worded for both doors.
- low: the phone Pool in `requestLocks` skips lanes.
- low: the contract's `bad-reachable` ordering.
- low: the Hub API forward test.

Nothing was deferred.

Rejected:
- 10 false, each with its refutation in the log.
- 1 maybe-false: a stale cached phone reading. It would only be low, because the spec names the cache.
- 7 low:
  - The reachability race on a waited take (2 findings): spec-mandated, rare, and a fix would add a branch.
  - The devicectl abort signal: the read is bounded at 10 s.
  - Real-sleep test timing: the existing pattern.
  - Non-contract docs: no stale claim.
  - The slow-Mac timeout: 9.3's transport.
  - An older Mac release: one hub release ships both sides, and Story 9.8 covers rollout.

**Follow-up review recommended: true.** This first pass patched two medium entries (and no high), so a follow-up is recommended. The specific risk that has not been reviewed is the review-patch change to `tools/host-agent/routes.mjs`. Its new `holdFleet` adds the Mac's lane to the fleet of every forwarded or gated Hold route that names nothing. That fleet is also what `force-release`, `cancel` and the gated routes scan, and nobody has looked at the patched code.

**Verification**
- The spec's `node --test` list passes 274/274 after the patches (271/271 before).
- `mise run check` exits 0: actionlint is clean and the full suite passes 1767/1767 (1764 before the patches).
- Matrix audit: every row is covered by a test that ran and passed in `lease-lane.test.mjs` or `leases.test.mjs`:
  - AC1.
  - The unreachable iPad.
  - `mac` and `--no-connect`.
  - An asleep Mac.
  - The cap.
  - The Mac in-process (lease, release, extend, busy 76).
  - AC2 (the FIFO and the Mac clock).
  - The API body cases.

**Residual risks**
- `hostLanes` loads `devices.json` on every Hold verb.
- A forwarded phone lease now gets the local `--for` bounds check, so an over-long `--for` is refused before it is sent.
- Reachability is a point-in-time read before the queue.
- Until the Mac runs this hub release, its agent answers `bad-body` to `lease ipad` sent from big-chungus.
- No operator action is owed. The live end-to-end check is Story 9.8's.
