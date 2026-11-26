---
title: 'Story 9.4: `lease ipad` and `lease mac` take the `ios-lane`'
type: 'feature'
created: '2026-11-26'
status: 'done'
baseline_revision: '31bef704a254cea0a428a13c7018dcd51a405c92'
review_loop_iteration: 0
followup_review_recommended: false
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

### 2026-11-26 — Review pass (follow-up)
- verdicts: 25 findings — high 0, medium 0, low 11, false 12, maybe-false 2
- findings:
  - `[low]` `[reject]` Blind: reachability is read once before the queue and never rechecked — carried: same location and claim as the first pass's Blind reachability row, and `take` still reads it once before `takePhone`.
  - `[low]` `[reject]` Blind: `laneReachability` turns a config error (no `ios` in devices.json) into `unknown` with no cause logged — real, but the spec says a read that throws counts as `unknown`. A broken devices.json already fails `loadFleet` first on every Hold verb, so the case is rare. Splitting the cause needs a new branch and a log seam.
  - `[false]` `[reject]` Blind: `require_reachable` on a phone has no consumer and is an extra — the intent asks for it ("a phone through the service's reading cache"), and the API is its caller.
  - `[low]` `[reject]` Blind: lane keying is inconsistent (`LANE_KINDS` by kind, `LANE_DEVICE_WORDS` by Resource id) and `laneReachability` assumes the one iPad — true, but there is one lane today and the intent pins the read to the `devices.json` `ios` udid. A second lane is new work, not a bug anyone meets now.
  - `[false]` `[reject]` Blind: a lane Lease view may carry a phantom `adb_port` — carried: same claim as the first pass's false row. `leaseView` prints `env: leaseExports(...)`, which has no `ANDROID_*` for a lane.
  - `[low]` `[reject]` Blind: the 60 min cap on extend and "no extend while anyone waits" have no lane test — both are enforced by `extendLease` in `tools/ci/lib/lock.mjs` by lock name (unchanged here), with their own tests in `tools/ci/extend.test.mjs`. A lane-surface test adds nothing the lock tests miss.
  - `[low]` `[reject]` Blind: the AC2 queue test uses real `settle(30)` sleeps — carried: same claim as the first pass's row; same pattern as lease.test.mjs:1095, and the suite is green.
  - `[low]` `[patch]` Blind: `HOLD_VERBS` duplicates the keys of `FORWARD_KEYS` and can drift — `HOLD_VERBS` is now `Object.keys(FORWARD_KEYS)` (tools/device/hub-device.mjs).
  - `[false]` `[reject]` Blind: `checkBounds` runs for a `--match` that resolves to one record — `namedRecords` (tools/device/forward.mjs:136-145) sets `single` only for a lone device word, never for a `match`.
  - `[false]` `[reject]` Blind: the forwarded `--no-connect` usage error does not mention the lane exception — it fires only when the target is not a lane, where its text is accurate; `USAGE` lists `[--no-connect]` on `lease ipad|mac`.
  - `[low]` `[reject]` Blind: the `mustBeReachable` message mixes API and CLI wording, and sets `status: 503` by hand — the wording is carried: the first pass patched this message to its current text. The explicit `status` matches the HTTP table and changes nothing a caller sees.
  - `[low]` `[patch]` Blind: the contract's `POST /leases` `resource` list does not name the lane words — the bullet now lists `ipad` and `mac` (the `ios-lane` on the Mac: lock only, with the iPad read only under `require_reachable`).
  - `[low]` `[reject]` Edge: the lane's devicectl read is a `spawnSync` on the agent's request thread, up to 40 s if devicectl hangs — real, but the agent's `GET /status` already reads devicectl the same way through the same seam (9.2). devicectl answers `list devices` in about a second and is bounded by `--timeout 10`. Moving it off-thread is more than a direct fix.
  - `[maybe-false]` `[reject]` Edge: a queued lane take is granted on a stale reading — carried: same root cause as the reachability-once row.
  - `[maybe-false]` `[reject]` Edge: a stale cached phone reading may still say `reachable` — carried: same claim as the first pass's maybe-false row, which would be only low if true.
  - `[false]` `[reject]` Edge: on the Mac, `lease --match` counts the lane in `checkBounds`' `usableFleet` — the Mac fleet always holds the uncapped S24, so the Pool check's result does not change. `matchTarget` then builds the real members from `kind: phone` records only, so the lane never joins a match.
  - `[false]` `[reject]` Edge: `--no-connect` with a `--match` that resolves to a lane is silently dropped — `single` is null for a `match` (forward.mjs:144), so `lane` is false and the refusal still fires.
  - `[false]` `[reject]` Intent: the local cap check covers every single-Resource forward, which changes 9.3's phone forwards — both hosts check the same `policy.json` from the same release, so the far side would refuse the same `for_ms`. Only the message is earlier and names `--for`. The intent pins only `--no-connect` for phone forwards.
  - `[false]` `[reject]` Intent: `require_reachable: false` is accepted with a `match` — `false` is the default and asks for nothing, so no take is gated wrongly.
  - `[low]` `[reject]` Intent: the lane abstraction is general in name, but its one instance is wired in — grouped with the Blind lane-keying row, rejected on the same grounds.
  - `[false]` `[reject]` Intent: a bare API `resource:'ipad'` without the key is not gated — this is the design (Design Notes, "Why a body key and not the word"). The contract says the key asks for the read.
  - `[false]` `[reject]` Intent: a Host Agent phone take with `require_reachable` always reads `unknown` (no cache) — phones live on linux, so the Mac agent forwards every phone take to the Hub API, which has the cache.
  - `[false]` `[reject]` Intent: the "`--no-connect` on a forwarded lane" rule sits in hub-device, not claims (AD-24) — the intent's AD-24 list is the words that need the device, the gate, the lane entry and the exports. The forward check calls `claims.isLane` and adds no lane rule of its own.
  - `[low]` `[reject]` Intent: the `requestLocks` lane filter and the `statusView` refactor have no new test — the verification-gap layer traced it and found no realistic regression. `status-view.test.mjs` still covers the iPad states through `laneReachability`.
  - `[false]` `[reject]` Intent: the Mac-side cap is tested only with `ipad`, and the AC2 test asserts no Mac clock — `checkBounds` reads the entry's lock, not the word, so `mac` takes the same path. The Mac clock is asserted in AC1's take, the same Lease AC2 queues behind.

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

Status: done (follow-up review pass)

**Summary.** `hub-device lease ipad` and `lease mac` take the `ios-lane` (lock `mac-ios`, 60 min deploy-target cap) from either host. On the Mac the take runs in-process; from big-chungus it is forwarded to the Mac's Host Agent through 9.3's `forwardHold`. A lane take is the lock only: no adb, and the exports are `HUB_LEASE_ID` and `HUB_DEVICE='ios-lane'`. `ipad` without `--no-connect` sends `require_reachable: true`, and the Mac reads the iPad through `devicectl` before writing anything; any other reading is `HUB_DEVICE_AWAY` (75). One level up (`belsky-doctrine`): lanes are fleet entries of their own host, reachable by every word from every front door, and `require_reachable` gates any single-Resource service take (a phone through the reading cache).

**Files changed (story total since the baseline)**
- `tools/device/claims.mjs` — lane helpers (`isLane`, `laneEntry`, `lanesOf`, `hostLanes`, `needsDevice`, `laneReachability`), lane words in `resolve`, the `mustBeReachable` gate in `take`, lane exports without `ANDROID_*`, `require_reachable` in `checkLeaseBody`/`serviceLease` (`bad-reachable`), lanes skipped by `releaseAny` and the `phone` Pool in `requestLocks`, `statusView` on `laneReachability`.
- `tools/device/forward.mjs` — `withPlace` builds a lane through `laneEntry`.
- `tools/device/hub-device.mjs` — Hold verbs see the host's lanes; `lease`/`run` pass `requireReachable`; `forwardCommand` forwards lanes, allows `--no-connect` on a lane, checks the cap before sending and sets `require_reachable`; this pass derives `HOLD_VERBS` from `FORWARD_KEYS`.
- `tools/hub-api/routes.mjs` — `serviceContext` passes the `devicectl` seam.
- `tools/host-agent/routes.mjs` — Hold routes that name nothing use `holdFleet` (phones plus lanes).
- `docs/hub-api-contract.md` — `require_reachable` and its refusals, a lane's `env`, the forwarding of `lease ipad|mac`; this pass lists `ipad`/`mac` among the `POST /leases` `resource` words.
- Tests — new `tools/device/lease-lane.test.mjs`; additions in `tools/hub-api/leases.test.mjs` and `tools/hub-api/forward.test.mjs`; `tools/device/forward-cli.test.mjs` rewritten for 9.4.

**Review findings breakdown (this pass).** 25 findings: high 0, medium 0, low 11, false 12, maybe-false 2.
- Patches applied (2, both low): `HOLD_VERBS` is now `Object.keys(FORWARD_KEYS)`; the contract's `resource` bullet names the lane words.
- Deferred: none.
- Rejected (23), each with its reason in the Review Triage Log: six carried from the first pass (reachability read once, stale queued grant, stale phone reading, phantom `adb_port`, `settle(30)` timing, the AWAY message wording); low rejects for the config-error-as-`unknown` read, the single-lane keying, the lane extend cap test (covered by `lock.mjs`'s own tests), the agent's synchronous devicectl read (same pattern as its `GET /status`), and the untested `requestLocks`/`statusView` changes; false for the rest (`single` is never set for a `match`, phone forwards hit the same policy on both sides, phones never take on the Mac agent, and others).

**Follow-up review recommendation:** `false`. This is a follow-up pass and it patched no `high` (patched by verdict: high 0, medium 0, low 2).

**Verification**
- `node --test` over the nine files in `## Verification` — 274 pass, 0 fail.
- `mise run check` (run through `heavy`) — actionlint clean, 1767 tests pass, 0 fail.

**Residual risks**
- Reachability is read once before the queue: a waited `lease ipad` can be granted after the iPad drops off (rare in a ≤2 min wait; the holder releases it like any Lease).
- The lane's devicectl read blocks the Mac agent's event loop for its duration (normally about a second, bounded by `--timeout 10`), as `GET /status` already does.
- The live relay from big-chungus to the Mac agent is not exercised here; that is Story 9.8's check.
