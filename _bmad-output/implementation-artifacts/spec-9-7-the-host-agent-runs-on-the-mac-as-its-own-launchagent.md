---
title: 'Story 9.7: The Host Agent runs on the Mac as its own LaunchAgent'
type: 'feature'
created: '2026-11-26'
status: 'done'
baseline_revision: '5fe46109abd25dd1efecf09af9a0e2161b64830b'
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-9-context.md'
warnings: ['oversized']
deferred: []
---

<intent-contract>

## Intent

**Problem:** The Host Agent (Stories 9.2 and 9.5) has no installer. `tools/hosts/units/install.sh` prints "nothing to install on the Mac" on Darwin, and `hosts:install` never starts the agent, never reads its `/health`, and never checks that the two services run the same release. A same-ref reinstall also `rsync --delete`s into the Mac's live `releases/<ref>/tools`, the tree a running agent reads.

**Approach:** Add the LaunchAgent plist `tools/hosts/units/sh.delo.mobile-deploy-hub.host-agent.plist`. The units installer's Darwin branch renders every `*.plist` there for the release and bootstraps it into `gui/<uid>`, the way the Linux branch renders every `*.service`. `hosts.mjs` runs that installer on the Mac over ssh and reads the agent's `/health` back through `hub-client` `request`. At the end it reads `/health` from both services and fails a step when their `contract` or `hub_version` differ. The Mac's release copy is made only when it is missing.

One level up (`belsky-doctrine`): the target is the Host Agent. The level is **every hub service on either host**. The units installer installs any `*.plist` beside any `*.service`, so the next Mac service needs no installer change. One readback helper serves both services. The agreement check goes through `hub-client`, so it reads both services from either host. The release tool's `Roll back:` line also names the LaunchAgents a release adds, as it already names systemd units.

## Boundaries & Constraints

**Always:**
- Plist: `Label` `sh.delo.mobile-deploy-hub.host-agent`; `ProgramArguments` `[@NODE@/bin/node, @HOME@/.local/share/mobile-deploy-hub/releases/@REF@/tools/host-agent/server.mjs, --launchd]`; `RunAtLoad` true; `KeepAlive` `{SuccessfulExit: false}`; `LimitLoadToSessionType` `Aqua`; `WorkingDirectory` `@HOME@`; `EnvironmentVariables` `HOME` and `PATH` (`@NODE@/bin` first, then `/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin`); `StandardOutPath` and `StandardErrorPath` `@HOME@/Library/Logs/mobile-deploy-hub/host-agent.out.log` and `.err.log`. No `StartInterval`, `StartCalendarInterval`, `WatchPaths` or `HUB_LOCK_DIR`, and never `current`.
- `install.sh <ref>` checks the ref, the release copy and Node >= 24.15 at the real `node/24.x` dir on both platforms, as today. Linux is unchanged. On Darwin, for each `*.plist`:
  - it substitutes `@REF@`, `@NODE@` and `@HOME@`, and refuses (exit 2) when a placeholder is left;
  - it writes `~/Library/LaunchAgents/<name>.part`, runs `plutil -lint` on it, then `mv`s it into place;
  - it creates `~/Library/Logs/mobile-deploy-hub`;
  - it runs `launchctl bootout gui/<uid>/<label>` (ignoring failure), waits at most 10 s while `launchctl print` still finds the label, then runs `launchctl bootstrap gui/<uid> <plist>`;
  - it prints one line per agent.

  It never names the catch-up label. It removes nothing and copies no code (no `rm`, `cp` or `ln`), and its only `systemctl` line stays the Linux `daemon-reload`.
- Node >= 24.15 at start stays `startService`'s `HUB_API_NODE` check. A second agent started with `--launchd` exits 0 (`HUB_API_ALREADY_RUNNING`), as `main` does today.
- The `hosts.mjs` steps run in this order: catch-up on big-chungus, Hub API on big-chungus, catch-up on the Mac, **host agent on the Mac** (new), **services agree** (new).
- **Catch-up on the Mac** checks for `releases/<ref>/tools` on the Mac. When it exists, nothing is copied and the log says so. When it is missing, `rsync --delete` goes into `releases/<ref>.part/tools/` and then `[ -e <release> ] || mv <release>.part <release>`. In both cases the catch-up installer then runs from `releases/<ref>`.
- **Host agent on the Mac** runs `ssh <mac.host> bash '<release>/tools/hosts/units/install.sh' '<ref>'`. It then reads `/health` through `request({host: 'mac', path: '/health'})` until it answers `ok`, `service` `HOST_AGENT_SERVICE`, `hub_version` `<ref>` and `contract` `HUB_API_CONTRACT`, for at most 20 s. No attempt starts after the deadline, and each attempt is bounded by an abort signal. With no such answer the step fails and names the last reason and the agent's log path.
- **Services agree** reads `/health` once from each service, `request({host: 'linux'})` and `request({host: 'mac'})`, each bounded at 10 s. Each must name its own service (`linux` is `HUB_API_SERVICE`, `mac` is `HOST_AGENT_SERVICE`). The step fails on no answer or on a differing `contract` or `hub_version`, and names both values. Because `request` uses a loopback `fetch` for its own host and ssh for the other, the same check works from either host.
- `installHubApi`'s behaviour and messages are unchanged; its readback loop becomes the one shared helper.
- `hostsInstall` takes the `sshImpl`, `hostKey` and `timers` seams, which go to `request` together with `policy` and `devices`. The default `hostKey` reads `claims.hostKey({home})`.
- Rollback: `release.mjs` lists the `.plist` files at HEAD that the rollback target lacks. The `Roll back:` line then says to run `launchctl bootout gui/$(id -u)/<label>` and remove `~/Library/LaunchAgents/<label>.plist` on the Mac (through `ssh hub-mac`) before the target's `hosts:install`. With no added plist, the line is byte-identical to today's.
- Tests are hermetic:
  - the installer runs as real bash over shims (`uname`, `id`, `launchctl` and `plutil` log their arguments);
  - `hostsInstall` gets a fake `run` (ssh, rsync, bash) and a fake `fetchImpl`, which reaches the Mac through a fake `sshImpl` that runs the real `relay()`;
  - fake timers and a fake clock; no port is bound and no real ssh runs.

**Never:**
- No timer, interval or poll in the agent or the services (`tools/clock.test.mjs` stays green with no new clock file), and no change to the catch-up plist, its installer's Darwin branch or its label.
- No change to the deploy path, the Host Agent's code or routes, or the Hub API's runtime.
- Never bare curl for the readback, never `current` in the plist, and never delete or replace an existing release dir on either host.
- Never write `sprint-status.yaml`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|---|---|---|---|
| Render on the Mac | `install.sh t1` from the release copy, `uname` Darwin, node 24.15.0 | the plist at `~/Library/LaunchAgents/sh.delo.mobile-deploy-hub.host-agent.plist` has no `@` left, the real node path, `releases/t1`; launchctl log is `bootout gui/<uid>/<label>`, `print …`, `bootstrap gui/<uid> <plist>`; the catch-up plist (rendered first by its own installer) is byte-identical and never named | — |
| Old node on the Mac | node 24.6.0 | exit 2, `>= 24.15`, no plist, no launchctl call | — |
| Bad plist | `plutil -lint` fails | non-zero exit, no plist in place, no bootstrap | — |
| Fresh install | `hostsInstall`, Mac release missing | rsync into `<ref>.part`, `mv`, the catch-up install, `ssh … hosts/units/install.sh <ref>`, agent `/health` read through the relay; `HOSTS host agent on the Mac: …`, `HOSTS services agree: …`, `HOSTS_OK` | — |
| Same-ref reinstall | Mac `releases/<ref>/tools` exists | no rsync, no `mv`; the catch-up and units installers still run from it | — |
| Agent never answers | relay answers `ECONNREFUSED` for 20 s | `HOSTS_FAILED host agent on the Mac: … within 20s (last: …) … host-agent.err.log`; run fails, later steps still run | — |
| Versions differ | Hub API `v1.2.3`, agent `v1.2.2` | `HOSTS_FAILED services agree: …` naming both | — |
| Mac asleep | sshImpl exits 255 | the agent step and the agreement step fail with `host-unreachable` text | — |
| Rollback line | HEAD adds the plist | `Roll back:` names `launchctl bootout gui/$(id -u)/sh.delo.mobile-deploy-hub.host-agent` on the Mac | — |

</intent-contract>

## Code Map

- `tools/hosts/units/install.sh` -- the units installer. Its Darwin early exit (:13-17) becomes the plist branch after the shared ref, release and node checks (:19-37). The Linux loop is at :39-54.
- `tools/catchup/units/install.sh` -- its Darwin branch (:58-70) is the bootout, wait and bootstrap pattern to copy. **Read-only**, as is `tools/catchup/units/sh.delo.mobile-deploy-hub.catchup.plist`, the style to copy (no `RunAtLoad` there).
- `tools/hosts.mjs`:
  - `installHubApi` (:92-118): the readback loop to extract into one helper;
  - `hostsInstall` (:120-208): the step list. The Mac catch-up step is at :193-205; `ssh` opts are at :31.
  - The rm-scan test forbids `rm`, `rmSync`, `rmdir` and `unlink` in the file's code lines.
- `tools/hub-client.mjs`:
  - `request()` (:271): a loopback fetch for its own host, the ssh relay otherwise;
  - `HOST_AGENT_SERVICE`, `HUB_API_SERVICE`, `HUB_API_CONTRACT` (:35-39); `relay()` (:326); `PEER_SCRIPT` runs from `current` on the peer.
- `tools/host-agent/server.mjs` -- `main` (:75-89) already exits 0 on `HUB_API_ALREADY_RUNNING` with `--launchd`. `startService` checks Node >= 24.15 (`tools/hub-api/server.mjs:128`). Its tests are at `tools/host-agent/server.test.mjs:124-141`.
- `tools/host-agent/routes.mjs` -- `agentHealth` (:36): `hub_version` comes from `hubRef` (the `releases/<ref>` path).
- `tools/device/claims.mjs` -- `hostKey({home})` (:167).
- `tools/release.mjs`:
  - `rollbackLine` (:65), `unitsIn` (:74), `stopUnitsOf` (:82); the call site is at :153.
  - Tests are in `tools/ci/v11.test.mjs:836-886`.
- Tests:
  - `tools/hosts/hosts.test.mjs`: `unitsHome` (:93) is the shim harness and gains `id`, `launchctl` and `plutil`. The Darwin "touching nothing" test (:165) is replaced. `hostsRun` (:282) gains the seams. The assertions at :330-331 ("nothing goes to the Mac") change, so that nothing of the systemd unit goes to the Mac.
  - `tools/hostkey.test.mjs:180-265`: `fakeHosts` and `offline` must answer the agent's `/health` through a fake `sshImpl`, so the expected failure lists stay `build directory`.
  - The fake ssh child and relay are in `tools/hub-client.test.mjs:256-284`.
- Docs:
  - `README.md:339` (the Hub API service paragraph, "The Mac gets no Hub API"): add the Host Agent LaunchAgent paragraph;
  - `README.md:136` rollback sentence;
  - `mise.toml:160` the `hosts:install` description.

## Tasks & Acceptance

**Execution:**
- [x] `tools/hosts/units/sh.delo.mobile-deploy-hub.host-agent.plist` (new) -- the LaunchAgent per Always -- the agent gets the GUI session `devicectl` needs.
- [x] `tools/hosts/units/install.sh` -- the Darwin branch renders, lints and bootstraps every `*.plist`; update the header -- one installer for every hub service on either host.
- [x] `tools/hosts.mjs` -- a shared `/health` readback helper; `installHostAgent`; `servicesAgree`; the Mac copy only when missing; the new steps and seams; the header comment -- the AC's install, readback and agreement.
- [x] `tools/ci/test-fixtures.mjs` -- `peerSsh({key, fetchImpl, policy})`, a fake `sshImpl` that runs the real `relay()`, plus an `unreachable` variant (stderr line and exit 255) -- shared by both hosts tests.
- [x] `tools/release.mjs` -- `unitsIn`/`stopUnitsOf` take a suffix; `rollbackLine` takes `stopAgents` -- a rollback stops a LaunchAgent a release added.
- [x] `tools/hosts/hosts.test.mjs` -- the plist assertions (keys, no interval, logs, `releases/@REF@`, `--launchd`, no `current`); Darwin installer tests (render, launchctl order, old node, bad lint, catch-up plist untouched over both rendered files); a busy port with the plist's argv makes `main` return 0; every `hostsInstall` matrix row; update the existing assertions.
- [x] `tools/hostkey.test.mjs` -- pass `sshImpl`, `hostKey` and `timers`, and answer the agent's `/health` -- the existing expectations stay.
- [x] `tools/ci/v11.test.mjs` -- `unitsIn` with `.plist`; `rollbackLine` with `stopAgents`; byte-identical without it.
- [x] `README.md`, `mise.toml` -- the Host Agent LaunchAgent, its logs, the readback and agreement, the same-ref rule, the rollback.

**Acceptance Criteria:**
- Given the plist rendered by `install.sh <ref>` on Darwin, then it has `KeepAlive {SuccessfulExit: false}`, `RunAtLoad`, `LimitLoadToSessionType Aqua`, no `StartInterval`, both log paths and `releases/<ref>` with the install-time Node path; Node >= 24.15 is required at install and at start; and a test over both rendered files shows the catch-up label and plist untouched.
- Given `hosts.mjs` installing on the Mac, then it bootstraps the LaunchAgent beside the untouched catch-up installer, reads the agent's `/health` back, and fails the step on no answer.
- Given `hosts:install` finishing, then it reads `/health` from both services and fails when `contract` or `hub_version` differ.
- Given a running agent and a second `hosts:install` of the same ref, then the Mac's release dir is never deleted or rewritten, and the agent switches only through the installer's bootout and bootstrap.
- Given a second agent started by launchd, then it exits 0.
- Given `mise run check`, then actionlint and the full suite are green, with `hosts.mjs` tested through a fake `launchctl` and a fake `fetchImpl`.

## Spec Change Log

## Review Triage Log

### 2026-11-26 — Review pass
- verdicts: 41 findings — high 0, medium 0, low 31, false 10, maybe-false 0
- findings:
  - `[false]` `[reject]` B1: every `hosts:install` bootouts and re-bootstraps the agent even on a same-ref install — the bounce is the intended switch (AC "switches only through the installer's bootout and bootstrap"), the same as the Hub API restart on every install.
  - `[low]` `[reject]` B2: a failed `launchctl bootstrap` gives no extra diagnostic — launchctl's own error goes back through ssh into `HOSTS_FAILED host agent on the Mac: <output>` and the step fails loudly; a better message adds branches for a rare case.
  - `[low]` `[reject]` B3: a stale or partial same-ref Mac copy is never repaired — intended (Design Notes: the same-ref copy is skipped so a live tree is never rewritten), matching big-chungus; repair needs a new verification mechanism.
  - `[low]` `[reject]` B4: two concurrent installs can race on `<release>.part` — `hosts:install` is run by hand from one host; the `[ -e ] || mv` guard already keeps an existing release; a lock adds surface for a case nobody meets.
  - `[low]` `[reject]` B5: when the agent step fails, `services agree` also fails — always-run steps are the existing `hostsInstall` pattern (the Hub API step likewise); the second failure names its own reason.
  - `[false]` `[reject]` B6: the readback accepts a stale agent still on the old release — `readBack` requires `hub_version === ref` (`tools/hosts.mjs` readback predicate), so an old agent never satisfies it.
  - `[low]` `[patch]` B7a: the rollback text `launchctl bootout gui/$(id -u)/…` expands `$(id -u)` on big-chungus when typed as `ssh hub-mac …` — fixed: the line is now one single-quoted remote command `ssh hub-mac 'launchctl bootout gui/$(id -u)/<label>; rm -f ~/Library/LaunchAgents/<label>.plist'`; v11 tests and README updated, the no-agent line byte-identical.
  - `[low]` `[reject]` B7b: the rollback line hardcodes `hub-mac`, ignores removed plists, and reuses `stopUnitsOf` naming — the existing line already hardcodes big-chungus/hub-mac, a removed plist needs no stop, and the naming is cosmetic.
  - `[low]` `[patch]` B8: `release()`'s wiring of `stopAgents` is untested — fixed together with VG1: `rollbackFor({major, previous, previousTag, run})` is exported, used by `release()`, and tested with a fake `ls-tree`.
  - `[low]` `[reject]` B9: the `peerSsh` fixture's `.catch` swallows relay errors into a generic exit — test-only, and every test asserting on it checks the visible outcome; changing it adds fixture branches with no failing case.
  - `[low]` `[patch]` B10a: the default-hostKey test writes `mac` into `h.home`'s host-key and never reads it — fixed: line deleted.
  - `[low]` `[reject]` B10b: an either/or regex in one assertion, a hand-rolled `parsePlist`, and no real `plutil` in tests — the tests are hermetic by rule (Linux CI has no plutil); the parser covers the keys asserted; tightening is cosmetic.
  - `[false]` `[reject]` B11a: the plist PATH lacks `~/.local/bin`/platform-tools, and has no `ThrottleInterval` — the agent spawns nothing from those dirs (Host Agent reads state through absolute paths and node), and launchd's default throttle is 10 s.
  - `[low]` `[reject]` B11b: README does not say the agent needs a logged-in session, and `hosts:smoke` does not cover the agent — `LimitLoadToSessionType Aqua` is documented in the plist paragraph; live smoke is Story 9.8.
  - `[low]` `[reject]` E1: `servicesAgree` would compare undefined fields from a malformed body — it checks `ok` and `service` first and names both values; an undefined pair still fails or reports plainly.
  - `[false]` `[reject]` E2: an agent from an older release answers the readback — refuted as B6: `hub_version` must equal `ref`.
  - `[low]` `[reject]` E3: a Mac release dir present without `tools/` is treated as missing and `mv` is skipped — unreachable: the old catch-up step always created `releases/<ref>/tools`.
  - `[low]` `[reject]` E4: a same-ref copy missing files is never re-synced — as B3.
  - `[low]` `[reject]` E5: a same-ref copy with local edits keeps them — as B3; by design.
  - `[low]` `[reject]` E6: a leftover `<release>.part` from an interrupted run is reused by rsync `--delete` — rsync converges it, and `mv` happens only when the release is missing; harmless.
  - `[low]` `[reject]` E7: bootstrap error 5 (already loaded) after the 10 s wait is not specially handled — as B2: it fails loudly with launchctl's message.
  - `[low]` `[reject]` E8: the bootout wait exits after 10 s without saying so — bootstrap then fails or succeeds visibly; adding a message is a new branch for a rare case.
  - `[low]` `[reject]` E9: a `plutil -lint` failure leaves `<name>.part` in `~/Library/LaunchAgents` — launchd ignores `.part`; the next install overwrites it; cleaning it needs `rm`, which the installer is forbidden.
  - `[low]` `[reject]` E10: an empty `*.plist` glob or mixed state is not reported — the units dir ships the plist in the same release; guarding adds a branch for an impossible tree.
  - `[low]` `[reject]` E11: `$HOME` with `|` or `&` breaks the `sed` substitution — the Mac's home is `/Users/<user>`; not met in practice.
  - `[low]` `[reject]` E12: the plist pins the install-time `node/24.x` path, so removing that node breaks the agent until reinstall — by design per AD-45 (the catch-up plist does the same).
  - `[low]` `[reject]` E13: the readback relay runs `current/tools/hub-client.mjs` on the Mac, not the new release — the relay is transport only and the Mac's `current` is updated by the catch-up step before it; the answer checked is the agent's own `/health`.
  - `[low]` `[reject]` E14: `readBack` does not consume a non-ok response body — pre-existing behaviour of the extracted Hub API loop; no leak in a short-lived CLI.
  - `[low]` `[reject]` E15: the fixture `.catch` — as B9.
  - `[low]` `[reject]` E16: `mac.host` alias vs `hub-mac` literal in the rollback text — as B7b.
  - `[false]` `[reject]` E17: older hub releases ran this units installer on the Mac and printed "nothing to install" — old `hosts.mjs` never ran `tools/hosts/units/install.sh` over ssh, so no old path changes behaviour.
  - `[false]` `[reject]` E18: Node >= 24.15 is not checked at agent start — it is: `startService` (`tools/hub-api/server.mjs:128`, `HUB_API_NODE`), which the agent's `main` calls.
  - `[low]` `[patch]` VG1: no test covers `release()` computing `stopAgents` with the `.plist` suffix — fixed with B8: `rollbackFor` test with a fake `ls-tree` (HEAD adds two plists and a `.service`), plus the no-additions and new-major cases.
  - `[low]` `[patch]` VG2: no test covers a failing units-installer ssh in `installHostAgent` — fixed: new `hostsInstall` test expects `HOSTS_FAILED host agent on the Mac: install.sh: plutil: bad plist` and only the agreement step's relay call.
  - `[low]` `[reject]` VG-other1: lint failure leaves `.part` — as E9.
  - `[low]` `[reject]` VG-other2: release dir without `tools` — as E3.
  - `[false]` `[reject]` IA reading B (the live install on a real Mac is owed) — the intent's live install and smoke are Story 9.8; this story's ACs are hermetic (`mise run check` with fake launchctl and fetchImpl).
  - `[false]` `[reject]` IA "a test over both rendered files" is only partly exercised — the Darwin render test renders the catch-up plist with its own installer first and asserts it byte-identical and never named after the units installer runs.
  - `[false]` `[reject]` IA the rollback `.plist` change exceeds the intent — deliberate one-level-up scope stated in the intent (`belsky-doctrine`).
  - `[false]` `[reject]` IA step order differs from the README — the steps run catch-up linux, Hub API, catch-up Mac, host agent, services agree, matching the README and the spec.
  - `[low]` `[reject]` IA the default-hostKey test runs only as Linux — the seam is platform-neutral (`claims.hostKey({home})`); a Mac-side variant adds a duplicate test with no new path.

## Design Notes

**Why the installer bootstraps and `hosts.mjs` does not run `launchctl` itself.** AD-45 puts the bootstrap in the units installer's Darwin branch, the same place the catch-up installer has its own. A LaunchAgent has no `enable`/`restart` split like systemd: bootout then bootstrap *is* the restart. So the installer owns it, and `hosts.mjs` only runs it and reads back. The fake `launchctl` is a shim on the installer's PATH. The `hosts.mjs` tests see the installer as one `ssh` call.

**Why the Mac copy is skipped when present.** `hub_version` comes from the path, so a same-ref copy can only differ in its working-tree edits. `rsync --delete` into a live tree can remove a module the agent imports later (`hub-client.mjs` loads `claims.mjs` at run time). big-chungus already behaves this way.

```text
HOSTS host agent on the Mac: v1.2.3 serves 127.0.0.1:8795 on mac, contract 1 (hosts agent: … bootstrapped)
HOSTS services agree: contract 1, hub_version v1.2.3 on linux and mac
```

## Verification

**Commands:**
- `node --test tools/hosts/hosts.test.mjs tools/hostkey.test.mjs tools/ci/v11.test.mjs tools/host-agent/server.test.mjs tools/clock.test.mjs tools/deploy-path.test.mjs` -- expected: all pass
- `mise run check` -- expected: actionlint clean, the full suite green

## Auto Run Result

**Status: done.** All acceptance criteria are hermetic and met. The live install on the real Mac is Story 9.8.

**Summary.** The Host Agent now ships as the LaunchAgent `sh.delo.mobile-deploy-hub.host-agent`. Its settings: `RunAtLoad`, `KeepAlive {SuccessfulExit:false}`, `LimitLoadToSessionType Aqua`, no interval, logs under `~/Library/Logs/mobile-deploy-hub/`, and it runs `releases/<ref>` with the install-time `node/24.x`. The units installer's Darwin branch renders every `*.plist`, lints it, and bootstraps it into `gui/<uid>` (bootout, then a bounded wait, then bootstrap), just as the Linux branch handles every `*.service`. `hosts:install` makes three changes:
- It copies the Mac release only when that release is missing, using `.part` and then `mv`, so a live tree is never rsync'd over.
- It runs the units installer on the Mac and reads the agent's `/health` back through `hub-client` `request`, for up to 20 s with abort-bounded attempts.
- It finishes with `services agree`, which reads both services' `/health` and fails on any `contract` or `hub_version` mismatch.

The `Roll back:` line also names LaunchAgents a release adds. One level up (`belsky-doctrine`), this covers every hub service on either host: the next Mac or Linux service needs no change to the installer, the readback or the rollback.

**Files changed**
- `tools/hosts/units/sh.delo.mobile-deploy-hub.host-agent.plist` (new): the LaunchAgent template, with `@REF@`, `@NODE@` and `@HOME@` placeholders.
- `tools/hosts/units/install.sh`: the shared ref, release and Node ≥ 24.15 checks, plus the Darwin plist render, lint and bootstrap branch. Linux is unchanged.
- `tools/hosts.mjs`: the shared `readBack` helper, `installHostAgent`, `servicesAgree`, the Mac copy made only when missing, the new steps, and the `sshImpl`, `hostKey` and `timers` seams.
- `tools/release.mjs`: `unitsIn` and `stopUnitsOf` take a suffix, `rollbackLine` takes `stopAgents` as a single-quoted `ssh hub-mac '…'` command, and a new `rollbackFor` is used by `release()`.
- `tools/ci/test-fixtures.mjs`: `peerSsh`, a fake sshImpl that runs the real `relay()`, and `unreachable`.
- `tools/hosts/hosts.test.mjs`: plist key tests, Darwin installer tests over `launchctl`, `plutil` and `id` shims, the `main` busy-port exit 0 test, and every `hostsInstall` matrix row including an installer failure.
- `tools/hostkey.test.mjs`: answers the agent's `/health` through `peerSsh`.
- `tools/ci/v11.test.mjs`: `.plist` suffix, `stopAgents`, `rollbackFor` wiring, and the real units dir.
- `README.md`, `mise.toml`: the Host Agent LaunchAgent paragraph, the rollback sentence, and the hosts:install description.

**Review findings breakdown.** 41 findings: low 31, false 10; no high or medium.
- Patched (4 entries, all low): the rollback `$(id -u)` quoting (B7a), the `release()` stopAgents wiring test via `rollbackFor` (B8 and VG1), the installer-ssh-failure test (VG2), and dead code in the default-hostKey test (B10a).
- Deferred: none.
- Rejected as false (10): B1, B6, B11a, E2, E17, E18 and four intent-alignment observations, each refuted in the Review Triage Log.
- Rejected as low (26): bootstrap diagnostics, the same-ref copy that is never repaired, `.part` races and leftovers, cascading step failures, fixture `.catch`, test-style nits, README and smoke coverage (9.8), malformed-body fields, `$HOME` special characters, the pinned node path (AD-45), the relay running from `current`, the unconsumed readback body (pre-existing), the alias, and the Linux-only hostKey test. Each is unlikely in everyday use, or its fix would add branches; the per-row reasons are in the Review Triage Log.

**Follow-up review recommended: false.** Only 4 low entries were patched; none were high or medium.

**Verification**
- `node --test tools/hosts/hosts.test.mjs tools/hostkey.test.mjs tools/ci/v11.test.mjs tools/host-agent/server.test.mjs tools/clock.test.mjs tools/deploy-path.test.mjs` passed 151 of 151 after the patches.
- `heavy mise run check`: actionlint is clean and the full suite passes 1837 of 1837.
- Matrix audit: every I/O row has a passing test (render, old node, bad lint, fresh install, same-ref reinstall, agent never answers, versions differ, Mac asleep, rollback line).

**Residual risks**
- The plist and the Darwin installer have never run on a real Mac. The real `launchctl`, `plutil` and Aqua-session behaviour is first exercised by Story 9.8.
- A `plutil -lint` failure leaves `~/Library/LaunchAgents/<name>.part` behind. It is harmless and overwritten on the next install.
- A stale or partial same-ref Mac copy is never repaired; the fix is a new release ref.
- Each readback attempt over ssh is bounded at 8 s, so a slow ssh can use up the 20 s window in about 3 attempts.
