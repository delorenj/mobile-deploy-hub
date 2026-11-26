---
title: 'Story 9.8: Ship the Mac Host Agent (pre-release half)'
type: 'chore'
created: '2026-11-26'
status: 'awaiting-operator'
operator_actions:
  - 'Merge this story branch into main and push main to origin; the release refuses a main that is not origin/main.'
  - 'Confirm `git ls-remote origin refs/tags/v1 refs/tags/v1.2.58` shows v1 on v1.2.57 and no v1.2.58 tag; if v1 moved or 1.2.58 is taken, retitle the `## v1.2.58` section of docs/hub-releases.md (and its test in tools/ci/v11.test.mjs) first.'
  - 'From a fresh clean clone of main on big-chungus, run `mise run release -- 1.2.58`; confirm every app strict dry run is green, v1 moved to v1.2.58, and `git show v1.2.58` carries the notes and a `Roll back:` line that names v1.2.57 and the `ssh hub-mac launchctl bootout` step for the host-agent label.'
  - 'After the release runner confirms its runs are finished, run `mise run hosts:install` on big-chungus from a clean checkout at tag v1.2.58 (the Mac must be awake); confirm the Hub API and Host Agent /health readbacks print equal contract and hub_version, and the services agree step passes.'
  - 'Run the literal `hub-device lease ipad --for 10m` on big-chungus with the iPad plugged in (it exercises devicectl in the Aqua session), see it in `hub-device status --json` under remote_hosts.mac with the Mac clock, and release it with `hub-device release <id> --resource ios-lane`.'
  - 'Run `mise run hosts:smoke -- --lanes` on big-chungus when no iOS deploy holds or waits on mac-ios, and confirm HUB_SMOKE_OK v1.2.58 with a `HUB_SMOKE lanes: ios-lane on mac held as ...` line.'
  - 'Observe the next real iOS deploy and the next iPad catch-up after the install: the deploy behaves as before (v1a AD-22), and the catch-up candybar reports any HUB_MAC_BUSY as a success, with no busy caused by the Host Agent itself (only by a deploy or a Lease someone took).'
  - 'Put the Mac to sleep, run `hub-device lease mac --for 10m --why asleep-check` on big-chungus, and confirm it exits 75 with `HUB_DEVICE_AWAY` `host-unreachable` at once (within the 5 s connect timeout, never a place in line), and that `hub-device status --json` then reads the Mac offline.'
  - 'If the release is red or anything regresses: move v1 back to v1.2.57, run `ssh hub-mac` with the bootout and plist removal for sh.delo.mobile-deploy-hub.host-agent, then `mise run hosts:install` from a clean checkout at v1.2.57.'
baseline_revision: 'bce340727853d3ef29cf142329db90f5de15a8b0'
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-9-context.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-8-7-ship-the-live-status.md'
  - '{project-root}/docs/hub-api-contract.md'
warnings: ['oversized']
deferred: []
---

<intent-contract>

## Intent

**Problem:** Stories 9.1 to 9.7 are on local main (`bce3407`). origin/main is `a7a6247`, `v1` is on `v1.2.57` (tag `dd4d99b` -> `63ba36f`), and there is no `v1.2.58` tag. But nothing ships them:
- `docs/hub-releases.md` has no `## v1.2.58` section.
- The AC's live pair check is a hand-typed sequence: lease the `ios-lane` from big-chungus, see it in `status --json` on the Mac's clock, release it, see the lane free. Every later release that touches forwarding, the Host Agent or pushes would have to repeat it by hand (FR-12, FR-14).

The contract doc already lists the Host Agent routes and `POST /agent/push` (`docs/hub-api-contract.md` "Routes" and "Host Agent"), and `tools/hub-api/contract.test.mjs` checks them against both route tables.

**Approach (`belsky-doctrine`).** "Ship the Mac agent" is one release. One level up is every post-install check of every spoke host's lane.

1. `mise run hosts:smoke` gains an opt-in `--lanes` phase (`laneCheck`). For every lane that `status --json` shows on another host, it takes the lane through `hub-device` (forwarded), sees the Lease in that host's own view with that host's `started_at`, releases it, and sees the lane free.
2. The `## v1.2.58` notes, with their test, plus README and `mise.toml` text.
3. `mise run check` green on Node 24 and Node 26.

The release, `hosts:install` on both hosts, the live runs, the iOS-deploy observation and the sleeping-Mac check go to the operator. The release refuses a `main` that is not `origin/main`, and the orchestrator merges this branch.

## Boundaries & Constraints

**Always:**
- Node 24 ESM, `node:` builtins only. Tests are hermetic: a fake `cli`, `now` and `sleep`. Every wait is a bounded `for` loop (AD-19), with `pause.mjs` `sleep`. No `setInterval` or `setTimeout` is added under `tools/hub-api/`, `tools/host-agent/` or `tools/hub-client.mjs`, so `tools/clock.test.mjs` stays green.
- `laneCheck({tag, ref, cli, lanesOf, now, sleep, log})` is exported from `tools/hosts/smoke.mjs`. `lanesOf(host)` defaults to `hostLanes(host)` from `claims.mjs` (the seed's lanes of that host, read-only). Sequence:
  1. Read `hub-device status --json`. The spokes are the keys of `remote_hosts`; the lanes are `lanesOf(spoke)` for each spoke. It fails `lanes: no other host in status (run it on big-chungus)` when `remote_hosts` is empty, and `lanes: no lane on <hosts>` when there are no lanes. Nothing is taken in either case.
  2. For each lane, in order. The "view" is `remote_hosts[<host>].view`, and it must be `state: 'available'`. The lane must be free: no `locks[]` row and no `waiters[]` row with `lock === lane.lock`. When it is not available, or not free, the phase fails naming the state, holder or waiter, and takes nothing.
  3. `hub-device lease <lane.device> --no-connect --wait 0 --for 2m --id <tag>-l-<lane.device> --why 'hosts:smoke <ref> lanes' --holder hosts:smoke --json`. The answer must be exit 0 with `lease_id` equal to the id.
  4. Poll `status --json` (one read every `WAITER_POLL_MS`, bounded by `LANE_SHOWS_WITHIN_MS = 10_000` from the CLI's answer; no read after the deadline). The host's view must show a `locks[]` row with `lock === lane.lock`, `lease_id === id`, `kind: 'lease'` and an ISO `started_at`. The local `locks[]` must have no row with that id: big-chungus wrote nothing.
  5. `hub-device release <id> --resource <lane.device>` must exit 0 with stdout `HUB_DEVICE_RELEASED`. Then poll the same way until the host's view has no `locks[]` row for `lane.lock`.
  6. Log one line per lane: `HUB_SMOKE lanes: <device> on <host> held as <id> (<host> clock started_at <iso>, <skew> ms from this host), shown in <n> ms, free again in <m> ms`. The skew is `Date.parse(started_at)` minus this host's `now()` at the CLI's answer.
  - On any failure, it releases a taken id with `--resource` and logs that, then throws `HUB_SMOKE_FAILED lanes: ...` with `detail`. It resolves `{lanes: [{host, device, id, shownMs, freedMs, startedAt, skewMs}]}`.
- `hubSmoke({lanes})` defaults to `false`, so the existing call list is unchanged. It must be a boolean (a `TypeError` otherwise). The phase runs after 5c stream and before 6 retire, and fails through `stop('lanes', ...)` so the phone is retired. CLI: `--lanes` turns it on, and the default is off. It is opt-in because a sleeping laptop fails it and the lane is a deploy target. `parseSmokeArgs` returns `lanes`, `runEntry` forwards it, and the `HUB_SMOKE_OK` line is unchanged.
- The `## v1.2.58` section goes above `## v1.2.57`. It says:
  - Epic 9 on top of v1.2.57: the Mac and its iPad, visible and leasable from big-chungus.
  - `hub-client.mjs` is the one cross-host transport: ssh to the peer's loopback, the relay, `HUB_DEVICE_AWAY` `host-unreachable`, the connect timeout.
  - The Host Agent on `127.0.0.1:8795` and its routes.
  - Forwarding (`X-Hub-Forwarded`, carried `resource`, `HUB_WRONG_HOST`).
  - `lease ipad` and `lease mac` take the `ios-lane`, capped at 60 min, with the iPad gate on `ipad`.
  - `POST /agent/push`: changes only, no timer, `stale` from push age.
  - An unreachable host reads `offline` and fails fast, with the `host-reachability` events.
  - The LaunchAgent `sh.delo.mobile-deploy-hub.host-agent`, its logs, and `hosts:install`'s host agent and services agree steps.
  - `contract` stays 1, and deploy jobs and the iPad catch-up are unchanged (AD-22, AD-25, `tools/deploy-path.test.mjs`).
  - Rolling back is `hosts:install` of `v1.2.57`, after the computed `Roll back:` line's `ssh hub-mac 'launchctl bootout ...'` step, because this release adds the plist.
  - `hosts:smoke -- --lanes`.
  - "Test changes you will see", naming each pre-existing suite changed since `v1.2.57` (`git diff --name-status v1.2.57 HEAD -- '*.test.mjs'`: `v11`, `deploy-path`, `claims`, `lease-match`, `hostkey`, `hosts`, `cancel`, `contract`, `extend-release`, `force-release`, `leases`, `hub-client`, plus this story's `smoke.test.mjs`) and the new suites (`forward-cli`, `forward`, `lease-lane`, `host-agent/push`, `host-agent/server`, `agent-push`, `hub-api/forward`, `unreachable`, `hub-client-forward`).

**Never:**
- Run `mise run release`, `hosts:install`, `launchctl`, `systemctl`, a real deploy or a live Lease.
- Touch the installed services, ports 8794 or 8795, or either host's lock dir.
- Move or push a tag or main.
- Change a route, a response key, the contract, `lock.mjs`, `claims.mjs`, the deploy path, `policy.json`, the Host Agent, `AGENTS.md` or `CLAUDE.md`, or `sprint-status.yaml`.
- Run the smoke from `hosts:install`.
- Add a route, a field or an error code.
- Lease the lane with `--wait` above 0. Take it without `--no-connect`. Hold it longer than 2 min.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|---|---|---|---|
| Lanes happy | `remote_hosts.mac` available, `ios-lane` free, the lease answers the id, the next status shows the row with `started_at`, the release frees it | the `HUB_SMOKE lanes: ios-lane on mac held as ...` line; then retire and the unchanged `HUB_SMOKE_OK` | — |
| `lanes: false` | the 8.7 world | the exact existing call list | — |
| No spoke | `remote_hosts` `{}` | `HUB_SMOKE_FAILED lanes: no other host in status ...`; no lease | phone retired |
| Mac unavailable | `remote_hosts.mac` `unavailable` (`not-served`) | fails naming the state and reason; no lease | phone retired |
| Lane busy | a `mac-ios` lock row (a deploy) or a waiter | fails naming the holder or waiter; no lease | phone retired |
| Take refused | lease exit 75 `HUB_DEVICE_AWAY ... host-unreachable` | fails with what the CLI said; the id is released anyway (logged) | phone retired |
| Never shown | status never shows the id in the Mac view within 10 s (fake clock) | fails `... not shown in mac's view within 10 s`; released; no read after the deadline | phone retired |
| Written locally | the id shows in local `locks[]` | fails `big-chungus wrote the lane's lock` | released |
| Never freed | after release the row stays for 10 s | fails `... still held ... 10 s` | phone retired |
| Entry flags | `--lanes` | `lanes: true` forwarded; default false | — |

</intent-contract>

## Code Map

- `tools/hosts/smoke.mjs`:
  - `hubSmoke` (L524): add the `lanes` option. The phase goes after the 5c stream block (L641-650) and before 6 retire (L652), and fails through `stop`.
  - Reuse `failure`, `brief`, `parseJson`, `HOLDER`, `WAITER_POLL_MS` (L48) and `realSleep`.
  - `parseSmokeArgs` (L690) and `runEntry` (L706): `--lanes` goes in the `bare` set and the usage text.
  - Header comment (L1-25): add step 5d.
- `tools/device/claims.mjs`:
  - `hostLanes(key, {env, policy})` (L247): read-only. The seed lane is `{device: 'ios-lane', lock: 'mac-ios', words: ['ipad','mac'], ...}` (`tools/registry/seed.mjs` L65).
  - `statusView` lock rows (L1660) carry `lock`, `kind`, `lease_id`, `holder` and `started_at`.
- `tools/device/hub-device.mjs`:
  - `status --json` (L504) prints `{...view, remote_hosts}`. `remoteHosts` (L472) gives `{state, reason, view, stale}` per other host, only on `linux`.
  - A forwarded `lease --json` prints `{lease_id, device, holder, why, expires_at, env}` (L868).
  - A forwarded release needs `--resource` (a bare release runs locally; contract "Forwarding a Hold action"), and prints `HUB_DEVICE_RELEASED <device> <id>` (L878).
  - `--no-connect` is allowed on a forwarded lane, and `--id` is forwarded (L904, L915).
- `tools/hosts/smoke.test.mjs`: `world()` (L28) is the fake CLI. Give it a `status` hook returning `remote_hosts`, and lease/release hooks keyed on the lane word. Every matrix row; `parseSmokeArgs`/`runEntry` rows near L549-577; the `lanes` TypeError.
- `docs/hub-releases.md` L7: the new section above `## v1.2.57`. Sources: the 9.1-9.7 spec Auto Run Results and `git diff --name-status v1.2.57 HEAD`.
- `tools/ci/v11.test.mjs` L1027: the v1.2.57 notes test is the pattern. Add a v1.2.58 test above it.
- `README.md` L333-336 (the hosts:smoke lines) and the smoke paragraph L339; `mise.toml` L165 (the `hosts:smoke` description): `--lanes`.
- Live facts (read-only ssh, 2026-11-26): the Mac is awake; `node/24.15.0`, host-key `mac`, `current -> releases/v1.2.57`; there is no host-agent plist yet, only the catch-up one.

## Tasks & Acceptance

**Execution:**
- [x] `tools/hosts/smoke.mjs` -- `laneCheck`, `LANE_SHOWS_WITHIN_MS`, the `lanes` option, `--lanes`, the header -- the repeatable live pair check for every spoke lane.
- [x] `tools/hosts/smoke.test.mjs` -- every matrix row, the call list for `lanes: false`, the arg parsing and forwarding.
- [x] `docs/hub-releases.md`, `tools/ci/v11.test.mjs` -- the `## v1.2.58` section and its test.
- [x] `README.md`, `mise.toml` -- the `--lanes` text.
- [x] Verification -- `heavy mise run check`, then `heavy mise run --tool node@26 check`.

**Acceptance Criteria:**
- Given HEAD, when `mise run check` runs on Node 24 and on Node 26, then both are green, and the contract doc's tables list the Host Agent routes and `POST /agent/push`, checked by `contract.test.mjs`.
- Given `docs/hub-releases.md`, when `releaseNotes(text, 'v1.2.58')` reads it, then it names each of these:
  - the Host Agent, its port and its LaunchAgent label;
  - `hub-client`, forwarding, `lease ipad`/`lease mac` and the `ios-lane`;
  - `/agent/push`, `offline` and `host-unreachable`;
  - the services agree step, `contract` stays 1, the deploy path unchanged;
  - the rollback to `v1.2.57` with the launchctl bootout, `hosts:smoke -- --lanes`, and the test changes.
- Given an installed pair, when `mise run hosts:smoke -- --lanes` runs on big-chungus, then it ends `HUB_SMOKE_OK` only when a forwarded lane Lease shows in the Mac's own view with the Mac's `started_at`, big-chungus wrote no lock, and the release frees the lane.
- Given the operator-owed half, when this story finishes, then the spec is `awaiting-operator` with each item under `operator_actions`. That half is:
  - merge and push;
  - release 1.2.58;
  - `hosts:install` on both hosts with equal readbacks;
  - the literal `lease ipad --for 10m`;
  - the smoke with `--lanes`;
  - the next iOS deploy and catch-up `HUB_MAC_BUSY`;
  - the sleeping-Mac `lease mac` exit 75.

## Spec Change Log

## Review Triage Log

### 2026-11-26 — Review pass
- verdicts: 30 findings — high 0, medium 0, low 18, false 12, maybe-false 0
- findings:
  - `[false]` `[reject]` blind: the `Roll back:` line has no code behind it — Story 9.7's `rollbackFor` (`tools/release.mjs:81`) lists the `.plist` files HEAD has and the rollback target lacks, and is tested in `tools/ci/v11.test.mjs`; `v1.2.57` has no host-agent plist, so the computed line names the bootout.
  - `[low]` `[patch]` blind: the per-suite `\b<suite>\b` notes assertions match prose (`forward`, `server`, `push`) — fixed: they now run only on the text after `### Test changes you will see`.
  - `[false]` `[reject]` blind: the hand-written suite list may not match the diff — checked against `git diff --name-status v1.2.57 HEAD -- '*.test.mjs'`: `claims` and `lease-match` are `M`, and every `A` suite is named.
  - `[low]` `[reject]` blind: `skewMs` is not bounded — the intent asks to show the Mac's clock, not to judge skew; the local-write check already catches a row stamped by big-chungus, and a threshold adds a branch and a policy number.
  - `[low]` `[reject]` blind: one failed `status --json` read aborts the poll — on big-chungus `status --json` reads the local lock dir and the Hub API's cached `/status` (`remoteHosts` turns an API failure into `unavailable`, never an error exit), so a non-zero exit is not a transient; tolerating it adds a branch.
  - `[low]` `[reject]` blind: no signal handler releases the lane — the Lease is capped at 2 min and expires on its own; `streamCheck` has the same shape; signal handlers add surface.
  - `[low]` `[patch]` blind: the multi-lane path is untested — grouped with verification-gap 1; fixed with two two-lane tests (both taken and released in order; lane 2 refused after lane 1 passed, only lane 2's id cleaned up).
  - `[low]` `[patch]` blind: a row with the right id but another `kind` is untested — grouped with verification-gap 2; fixed with the `shownAs` knob.
  - `[low]` `[reject]` blind: the other edge cases (a waiter while held, an id against `ID_PATTERN`, a "not held" cleanup) — the id is `smoke-<base36>-l-<name>`, at most 39 lowercase characters against the 64-character Lease id rule; releasing an id that was never granted is the 8.7 smoke's deliberate safe superset.
  - `[false]` `[reject]` blind: `HUB_SMOKE_OK` is the same with and without `--lanes` — the intent contract fixes the OK line unchanged (as 8.7 did); the `HUB_SMOKE lanes:` line is the evidence.
  - `[false]` `[reject]` blind: the spec's `in-review` status contradicts `awaiting-operator` — `in-review` is the review step's transitional state; finalization writes `awaiting-operator`. The Code Map line numbers are the baseline's.
  - `[low]` `[patch]` blind: the test title "lanes: false is the 7.9 world" — renamed to the 8.7 world.
  - `[low]` `[reject]` blind: smaller points (`1.5m` for a fractional constant, a local ISO regex, long README and mise lines) — `LANE_FOR_MS` is 120 000; the rest is cosmetic and follows the file's existing style.
  - `[low]` `[patch]` edge: the freed poll fails a good release when a deploy takes `mac-ios` right after it — fixed: the lane counts as freed when no row on its lock carries this run's id; a new test puts a job row, and another Lease, on the lane after the release and the phase passes.
  - `[low]` `[reject]` edge: the CLI answering a different `lease_id` makes cleanup release the wrong id — a forwarded take sends the client-minted `id` and the far side keeps it (Story 7.2), so a different id is unreachable; tracking it adds a branch for an undemonstrated state.
  - `[low]` `[reject]` edge: the pre-check ignores a `stale` view or a Reservation row — the take is judged on the Mac; a Reservation blocks a `--wait 0` take, which then fails with the CLI's own message and the id is released; extra checks add branches.
  - `[low]` `[reject]` edge: `started_at` is only format-checked — as blind's skew row.
  - `[low]` `[reject]` edge: a transient status read aborts the poll — as blind's row.
  - `[false]` `[reject]` edge: two spokes with lanes of the same name collide on the id — Resource names are unique across the Registry and never reused (AD-28), so two lanes cannot share a `device`.
  - `[low]` `[reject]` edge: a local write that appears after the Mac row is missed — the forward writes only on the Mac before the CLI answers, so a local write would come before the answer, not after; another read adds a step for an unreachable order.
  - `[low]` `[patch]` verification-gap: the two-lane iteration is never exercised — fixed (see blind's multi-lane row); the tests were shown to fail when the loop was cut to one lane.
  - `[low]` `[patch]` verification-gap: the shown predicate's `lease_id` and `kind` checks are unpinned — fixed: the `shownAs` knob shows a foreign Lease id, and a job row, with a valid ISO `started_at`, and the phase fails "was not shown in mac's view within 10 s"; deleting the checks makes the test fail.
  - `[low]` `[reject]` verification-gap (other): `undo()` logs `released` on exit 0 even for `HUB_DEVICE_NOT_HELD` — the same exit-code rule as the existing `hubSmoke` cleanup (`released.code === 0`); the log line is cosmetic.
  - `[false]` `[reject]` verification-gap (other): a Lease seen in a `stale` view counts as shown — the pre-check saw the lane free, so a row with this run's id in the Hub API's view can only come from a push after the take; `stale` is about age, not truth.
  - `[false]` `[reject]` intent: AC1 is not shown in the diff — the contract already lists the Host Agent table and `POST /agent/push` (`docs/hub-api-contract.md` Routes, Host Agent), checked by `tools/hub-api/contract.test.mjs`; `mise run check` is 1861/1861 on Node 24.15.0 and Node 26.13.0.
  - `[false]` `[reject]` intent: AC2 (release, `v1`, both installs) is not exercised — operator-owed by design; the release refuses a `main` that is not `origin/main`, and each step is under `operator_actions`.
  - `[false]` `[reject]` intent: AC3 uses the lane name with `--no-connect` and 2 min, not the literal `lease ipad --for 10m` — a deliberate Design Notes choice so an unplugged iPad cannot fail the repeatable smoke; the literal command is an operator action.
  - `[false]` `[reject]` intent: AC4 is only asserted in notes prose — a real deploy and the catch-up are operator observations; the deploy path is already pinned by `tools/deploy-path.test.mjs`, unchanged here.
  - `[false]` `[reject]` intent: AC5 is only the smoke's failure path — the CLI forwards straight over ssh, and an ssh leg that fails to connect (exit 255) is `HUB_DEVICE_AWAY` `host-unreachable` within the connect timeout, tested in `tools/hub-client.test.mjs` and `tools/device/forward-cli.test.mjs`; the Hub API's marks are tested in `tools/hub-api/unreachable.test.mjs`; the live check is an operator action.
  - `[false]` `[reject]` intent: the spec is `in-review`, not `awaiting-operator` — transitional; finalized to `awaiting-operator`.

## Design Notes

**Why `--no-connect` and the lane's own name.** The smoke proves the cross-host path: the forward, the Mac's lock dir and clock, the push, and the release. It does not prove that the iPad is plugged in. So it takes the lane by its name with `--no-connect`, and an unplugged or locked iPad cannot fail it. The operator runs the literal `lease ipad --for 10m` once, which also exercises `devicectl` in the Aqua session.

**Why opt-in.** `mac-ios` is a deploy target. The smoke holds it only for seconds, with `--wait 0` and only when it is free. A laptop asleep in a bag would still fail every routine smoke, so the release check asks for it.

```text
HUB_SMOKE lanes: ios-lane on mac held as smoke-x-l-ios-lane (mac clock started_at 2026-11-26T15:00:00.120Z, 120 ms from this host), shown in 840 ms, free again in 610 ms
```

## Verification

**Commands:**
- `node --test tools/hosts/smoke.test.mjs tools/clock.test.mjs tools/hub-api/contract.test.mjs` -- expected: all pass
- `node --test --test-name-pattern 'v1.2.58' tools/ci/v11.test.mjs` -- expected: pass
- `heavy mise run check` and `heavy mise run --tool node@26 check` -- expected: green

## Auto Run Result

**Status: awaiting-operator.** Everything an agent can do is done on the story branch. The release, `hosts:install` on both hosts, the live lane Lease, the smoke with `--lanes`, the next iOS deploy and the sleeping-Mac check are owed by the operator. Each one is listed under `operator_actions` in the frontmatter.

### Summary

- **For this release:**
  - The `## v1.2.58` notes are written and pinned by a test. They cover the Host Agent on `127.0.0.1:8795` and its routes, `hub-client` as the one transport, forwarding, `lease ipad`/`lease mac` on the `ios-lane`, `POST /agent/push`, offline and fail-fast, and the LaunchAgent with its readback and the services agree step.
  - They also record that `contract` stays 1, that the deploy path is unchanged, the rollback to `v1.2.57` with the `launchctl bootout` step, `hosts:smoke -- --lanes`, and the test changes.
  - The contract doc already lists the Host Agent routes and `POST /agent/push`, and `contract.test.mjs` checks them.
- **For the level above, every post-install check of every spoke host's lane (`belsky-doctrine`):** `mise run hosts:smoke -- --lanes` runs a `laneCheck` (opt-in). For every lane that `status --json` shows on another host (today the Mac's `ios-lane`), it:
  1. requires the host's view available and the lane free;
  2. takes the lane through `hub-device` (forwarded, `--no-connect --wait 0 --for 2m`, id `<phone>-l-<lane>`);
  3. requires the Lease in that host's own view within 10 s, with that host's `started_at`, and no local lock row;
  4. releases it with `--resource`, and requires no row for that id within 10 s.

  A second spoke host or lane needs no change.

### Files changed

- `tools/hosts/smoke.mjs`: `laneCheck`, `LANE_SHOWS_WITHIN_MS`, `LANE_FOR_MS`, the `lanes`/`lanesOf` options of `hubSmoke`, `--lanes`, the header step 5d.
- `tools/hosts/smoke.test.mjs`: every matrix row plus, from review, two-lane runs, a foreign row on the lane, and a next holder after the release.
- `docs/hub-releases.md`, `tools/ci/v11.test.mjs`: the `## v1.2.58` section and its test. Suite names are checked within the test-changes subsection.
- `README.md`, `mise.toml`: the `--lanes` text.
- `_bmad-output/implementation-artifacts/spec-9-8-ship-the-mac-host-agent.md`: this spec.

### Review findings

- **Totals:** 30 findings (blind 13, edge 7, verification-gap 4, intent 6): high 0, medium 0, low 18, false 12, maybe-false 0.
- **Patches applied (low, 6 rows in 5 entries):**
  - the freed poll judges only this run's id;
  - two-lane tests;
  - the shown predicate is pinned by a foreign row;
  - the notes' suite assertions are scoped;
  - a test title is renamed.
- **Deferred:** none.
- **Rejected, false (12):** the rollback line (9.7's `rollbackFor` computes it); the suite list (checked against the diff); the unchanged OK line (the intent contract); the transitional status (two rows); colliding lane ids (names are unique, AD-28); a stale view counted as shown; and four intent rows for live surfaces that are operator-owed by design.
- **Rejected, low (12):** an unbounded skew (two rows); a transient status read (two rows); no signal handler; small edge cases; cosmetic points; a different answered id; stale or Reservation pre-checks; a later local write; the cleanup log wording. Each reason is in the Review Triage Log.

### Follow-up review

`followup_review_recommended: false`. This was the first pass, and it patched high 0, medium 0, low 5 entries.

### Verification

- `heavy mise run check` on Node 24.15.0 and `heavy mise run --tool node@26 check` on Node 26.13.0, run one after the other after the review patches: 1861/1861 each, exit 0. Before the patches: 1857/1857 each.
- Focused: `node --test tools/hosts/smoke.test.mjs tools/clock.test.mjs tools/hub-api/contract.test.mjs` 113/113; `node --test --test-name-pattern v1.2.58 tools/ci/v11.test.mjs` 1/1.
- Matrix audit: every I/O row has a passing test. The rows are lanes happy, `lanes: false`, no spoke, Mac unavailable, lane busy (lock and waiter), take refused, never shown, written locally, never freed, and entry flags.
- Live, read-only (ssh, 2026-11-26): the Mac is awake with `node/24.15.0`, host-key `mac` and `current -> releases/v1.2.57`. Only the catch-up plist is installed, so the Host Agent's first install is the operator's `hosts:install`.

### Residual risks

- The plist, the Darwin units installer, `devicectl` in the Aqua session and the big-chungus → Mac relay have never run on the real pair. The operator's `hosts:install`, the literal `lease ipad --for 10m` and `hosts:smoke -- --lanes` are their first live run.
- `--lanes` holds `mac-ios`, a deploy target, for seconds (at most 2 min if the process dies mid-phase). A deploy arriving then waits in line behind it, so run it when no iOS deploy is due.
- local main (`bce3407`) is ahead of origin/main (`a7a6247`) by the whole of Epic 9, so the release must follow the merge and push.
