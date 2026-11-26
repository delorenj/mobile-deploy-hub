---
title: 'Story 9.4: `lease ipad` and `lease mac` take the `ios-lane`'
type: 'feature'
created: '2026-11-26'
status: 'in-progress'
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
- [ ] `tools/device/claims.mjs`:
  - Add `LANE_DEVICE_WORDS = {'ios-lane': ['ipad']}`, `isLane(record)`, `laneEntry(record, policy)` (`{device: name, lock, deploy, name, serial: null, model, kind, words}`), `lanesOf(resources, key)`, `hostLanes(key, {env})` (from the seed of `devices.json`) and `needsDevice(word, entry, {noConnect})`.
  - `resolve`: also match `entry.words`.
  - `take` `case 'phone'`: when `options.requireReachable`, run `mustBeReachable` first. A lane is read with `laneReachability` (`readIpad`). A phone is read with `options.readingsOf` and skipped without one. A lane is taken with `noConnect: true`.
  - `leaseExports`: no `ANDROID_*` for a lane.
  - `checkLeaseBody`: optional boolean `require_reachable` (`bad-reachable`), returned as `requireReachable` (default false).
  - `serviceLease`: pass it to `take`. A non-`phone` target with it set is `bad-reachable`.
  - `releaseAny`: skip lanes.
  - `statusView`: use `laneReachability`.
- [ ] `tools/device/forward.mjs` -- `withPlace` builds a lane through `laneEntry`, with the carried lock.
- [ ] `tools/hub-api/routes.mjs` -- `serviceContext` passes `ctx.devicectl`.
- [ ] `tools/device/hub-device.mjs`:
  - `main`: for the Hold verbs on a host whose key is known, set `context.fleet` to the fleet plus `hostLanes(own)`.
  - `lease` and `runCommand`: pass `requireReachable: needsDevice(word, entry, {noConnect})`.
  - `forwardCommand`:
    - Drop the ios-lane early return.
    - Accept `--no-connect` when `place.single` is a lane.
    - For a single carried Resource, run `checkBounds` locally on its `withPlace` entry, so the cap error names `--for <text>`.
    - Set `body.require_reachable = true` only when `needsDevice`.
  - Update the header comment and `USAGE`.
- [ ] Tests:
  - New `tools/device/lease-lane.test.mjs`:
    - A linux CLI → bridge → agent `handle()` over a temp Mac dir, covering every matrix row: ipad reachable and not, mac, `--no-connect`, Mac asleep, `--for 2h`, Hub API down (no linux call).
    - The Mac's in-process `lease`/`release`/busy.
    - The FIFO-and-clock test with an iOS `job` and a `hub-job`.
  - Add the `bad-reachable` and `s24` cache gate cases in `tools/hub-api/leases.test.mjs`. Update :382 for `requireReachable`.
  - Rewrite `forward-cli.test.mjs:119`.
- [ ] `docs/hub-api-contract.md`:
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
