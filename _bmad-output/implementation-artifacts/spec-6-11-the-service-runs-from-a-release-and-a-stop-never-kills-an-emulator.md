---
title: 'The service runs from a release, and a stop never kills an emulator'
type: 'feature'
created: '2026-11-25'
status: 'done'
baseline_revision: '93cf258a425613919b3ff3d481626d39b8d318e1'
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-6-context.md'
warnings: ['oversized']
deferred:
  - summary: >-
      No in-suite test runs the real `heavy` / `systemd-run --user --scope`, so pid preservation and batch.slice placement are proven only by the exec-ing shim and one manual check.
    evidence: |-
      tools/ci/test-fixtures.mjs heavyShim encodes the exec assumption; no test reads /proc/<pid>/cgroup. A suite test would need a live user manager, which the hermetic rule (CLAUDE.md "Running and verifying") forbids. Settled live by a 6.12 operator check: lease an emulator, `systemctl --user restart mobile-deploy-hub-api`, and confirm the emulator pid survives in a batch.slice scope.
    location: >-
      tools/device/emulator.mjs bootCommand / tools/ci/lib/heavy.mjs inHeavy
    severity: medium
---

<intent-contract>

## Intent

**Problem:** The Hub API (Stories 6.4 to 6.10) exists only as `node tools/hub-api/server.mjs`. Nothing installs it, keeps it running or restarts it on a release. Emulators boot with a bare `spawn`, so on a systemd stop with `KillMode=mixed` an emulator the service started would die with it (FR-23, AD-45, AD-23).

**Approach:** Add one emulator spawn seam: every long-lived process the emulator pool launches on Linux is wrapped in `heavy` when `heavy` is on PATH. The Hub API already refuses to start without `heavy`. Ship `tools/hosts/units/` (the `mobile-deploy-hub-api.service` template and `install.sh <ref>`, which renders `@REF@` and `@NODE@` and only runs `daemon-reload`). `hosts.mjs` then runs that installer from the release copy, enables and restarts the service, and reads `/health` back for at most 10 s. Belsky level, one up: the seam covers every process the pool launches (the emulator and its adb server, from the CLI or from the API), and the installer renders every `*.service` in `tools/hosts/units/`, so the Host Agent's unit later drops in beside it.

## Boundaries & Constraints

**Always:**
- The seam decides from the launch env's `PATH` and the platform (`linux` only). It execs `heavy <command> <args...>`, and heavy execs all the way down (`systemd-run --scope` execs), so the recorded pid and start time stay the emulator's.
- One PATH resolver (`which`/`onPath` in a new `tools/ci/lib/heavy.mjs`) is shared by the seam and by the service's start check, so they cannot disagree. `server.mjs` keeps exporting `onPath`.
- The unit is `Type=simple`, `Restart=on-failure`, `KillMode=mixed`, `WantedBy=default.target`. `ExecStart` is `@NODE@/bin/node %h/.local/share/mobile-deploy-hub/releases/@REF@/tools/hub-api/server.mjs` (never `current`). Its `PATH` puts `%h/.local/bin` first, so `heavy` is found. It sets no `HUB_LOCK_DIR`, so the default dir is shared with deploys and `hub-device`.
- `@NODE@` is the real directory behind `~/.local/share/mise/installs/node/24` (`pwd -P`, e.g. `.../node/24.15.0`). The installer refuses (exit 2) when that node reports < 24.15.
- `install.sh` must run from `~/.local/share/mobile-deploy-hub/releases/<ref>/tools/hosts/units/`, so it refuses (exit 2) from anywhere else. It copies nothing and deletes nothing: it renders through a `.part` file plus `mv`, and its only `systemctl` call is `--user daemon-reload`.
- `hosts.mjs` runs the catch-up installer from the release copy when `releases/<ref>` already exists, so a same-ref reinstall never replaces the directory a running service reads. It runs the Hub API step only after the catch-up step on big-chungus (which creates the release dir). It never removes a release dir.
- The `/health` readback must see `ok: true`, `service: 'hub-api'` and `hub_version === <ref>`, retrying for at most 10 s within one invocation through injected `now` and `sleep`. When it never gets that answer, the step fails (`HOSTS_FAILED hub api on big-chungus: ...`).
- Tests are hermetic: fake `run` (systemctl and bash), fake `fetchImpl`, a fake `heavy` shim. No real unit, port, systemd scope or 1Password read.

**Never:**
- Edit `tools/catchup/units/*` (the catch-up installer stays untouched; `hub-device.test.mjs` "install.sh installs a hub-device wrapper" must pass unchanged).
- Add a `.timer`, `setInterval` or self-rescheduling `setTimeout`; the readback retry is a bounded loop in one invocation (AD-19).
- Install or restart anything on the Mac for the Hub API (the Host Agent is Epic 7). `install.sh` on Darwin prints one line and exits 0.
- Prune or delete old `releases/*`.
- Wrap processes on macOS, or when `heavy` is absent (the CLI still boots emulators there; only the service refuses).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Seam, Linux with heavy | `PATH` has an executable `heavy` | spawn `heavy`, args `[command, ...args]`; pid is the emulator's | — |
| Seam, no heavy / darwin | no `heavy`, or `platform: 'darwin'` | spawn `command` unchanged | — |
| Units install | run from `releases/t1/tools/hosts/units`, `node/24 -> 24.15.0` | `~/.config/systemd/user/mobile-deploy-hub-api.service` rendered, no `@` tokens left; systemctl log is exactly `--user daemon-reload` | — |
| Units install, wrong place | run from a checkout | nothing written | exit 2, names the release path |
| Units install, old node | `node/24 -> 24.6.0` | nothing written | exit 2, says `>= 24.15` |
| Units install, bad ref | `../x` | nothing written | exit 2 |
| hosts readback ok | refused, then old `hub_version`, then `<ref>` | step `HOSTS hub api on big-chungus: ...` | — |
| hosts readback never | refused until fake clock passes 10 s | `HOSTS_FAILED hub api on big-chungus`, hostsInstall rejects | no more attempts after the deadline |
| Same-ref reinstall | `releases/<ref>/tools/catchup/units/install.sh` exists | catch-up run as `bash <release>/tools/catchup/units/install.sh <ref>` | — |
| Restart | instance A registers + a lease exists; stop A; start B on same dirs | lock dir bytes identical after B's start; B serves the Resource | — |

</intent-contract>

## Code Map

- `tools/device/emulator.mjs`:
  - `launch(command, args, env, logFile)` L418 is the one spawn site for long-lived processes (adb server L569, emulator L588). Route it through the new exported `bootCommand(command, args, {env, platform})`.
  - `liveStart` L135 and `sameProcess` L144 key on pid plus start time, which an exec preserves.
  - The imports L17-27 stay inside `tools/ci/lib` and `tools/device` (layering).
- `tools/hub-api/server.mjs`:
  - `onPath` L45 moves to `tools/ci/lib/heavy.mjs`; re-export it from server.mjs (its tests import it there, L19, L414).
  - The heavy check L99 stays.
- `tools/hosts.mjs`:
  - `hostsInstall` L75: add `run`, `fetchImpl`, `sleep`, `now` and `home` seams.
  - The catch-up step on big-chungus L136 runs the release copy when it exists.
  - Add an exported `installHubApi({ref, run, fetchImpl, sleep, now, home, port, log})` and call it as step `hub api on big-chungus` right after the catch-up step.
  - `releaseName` L30 gives `ref`.
- `tools/ci/lib/receipt.mjs` `hubRef` L26: `/health`'s `hub_version` is the `releases/<ref>` segment, so the readback compares it to `ref`.
- `tools/hub-api/routes.mjs` `health` L80, read only: the keys `ok, service, contract, hub_version, ports, registry`.
- `tools/catchup/units/install.sh`, read only: the pattern to mirror (ref regex L16, `.part` + `mv`, Linux/Darwin case).
- `tools/device/hub-device.test.mjs` ~L1252, read only: the catch-up installer test with shims (`systemctl`, `uname`, fake mise node dir). Copy this shape for the units test.
- `tools/device/emulator.test.mjs` `fixture()` L108: the env `PATH` is `process.env.PATH`, so it must gain a shim dir with a fake `heavy` first.
- `tools/ci/test-fixtures.mjs` `hermetic()` L39: add the same shim to `process.env.PATH`.
- `tools/hub-api/server.test.mjs` `scratch()` L45, `FakeServer`, `exchange`: reuse these for the restart test.
- `tools/clock.test.mjs`: `SERVICE_SCOPES` excludes `tools/hosts.mjs`, but the no-self-reschedule rule applies everywhere. Use `pause.mjs`'s `sleep` in a `for` loop.
- `README.md` L323 (`hosts:install` line) and L326 (Hub API paragraph); `mise.toml` L160 `hosts:install` description.

## Tasks & Acceptance

**Execution:**
- `tools/ci/lib/heavy.mjs` (new) -- `which(name, env)`, `onPath(name, env)`, `inHeavy(command, args, {env, platform})` returning `{command, args, heavy}` -- one PATH resolver for the seam and the start check.
- `tools/hub-api/server.mjs` -- import and re-export `onPath` from heavy.mjs; header comment names the seam.
- `tools/device/emulator.mjs` -- export `bootCommand` (delegates to `inHeavy`); `launch` spawns through it; a header or function comment on why (KillMode=mixed, batch.slice).
- `tools/hosts/units/mobile-deploy-hub-api.service` (new) -- the unit template above.
- `tools/hosts/units/install.sh` (new, executable) -- renders every `*.service` in its dir into `${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/`, then `daemon-reload`; on Darwin it prints one line and exits 0; refusals as in the matrix.
- `tools/hosts.mjs` -- seams, release-copy catch-up, `installHubApi` (installer, `systemctl --user enable`, `systemctl --user restart`, readback), header comment.
- `tools/ci/test-fixtures.mjs` -- `heavyShim(dir)` (a `#!/bin/sh` that appends `$*` to `dir/heavy.log` and `exec "$@"`); `hermetic()` prepends one.
- `tools/device/emulator.test.mjs` -- `fixture()` prepends a `heavyShim`; add one test that a lease's emulator and adb server both went through it (heavy.log) and that the recorded pids are the live emulator's and adb server's.
- `tools/hosts/hosts.test.mjs` (new, hermetic) -- `bootCommand`/`inHeavy` matrix rows; units `install.sh` rows (real bash, shims, Linux branch only); unit-file directives; `installHubApi` readback rows with a fake clock; `hostsInstall` with a fake `run`/`fetchImpl` showing the call order (catch-up then units installer then enable then restart) and the same-ref release-copy row; source checks that `hosts.mjs` and `install.sh` hold no `rm` of a release dir and `tools/hosts/units/` holds no `.timer`.
- `tools/hub-api/server.test.mjs` -- the restart test: A registers a Resource and a Lease is taken in the lock dir; stop A; snapshot the lock dir; start B; the snapshot is unchanged and `GET /resources/{id}` answers the Resource.
- `README.md`, `mise.toml` -- `hosts:install` now installs and restarts the Hub API; how the service runs (release dir, journald, `systemctl --user status mobile-deploy-hub-api`), and why emulators survive a stop.

**Acceptance Criteria:**
- Given the emulator spawn seam, when an emulator boots on Linux with `heavy` on PATH, then the fake `heavy` saw both the adb server's and the emulator's command lines, and the lease's recorded pids are those processes.
- Given `tools/hosts/units/`, when the story lands, then it holds `mobile-deploy-hub-api.service` (`Type=simple`, `Restart=on-failure`, `KillMode=mixed`) and `install.sh <ref>`, and the rendered unit runs `releases/<ref>` with the real `node/24.x` path.
- Given `hosts.mjs` on big-chungus, when it installs, then it runs the units installer after the untouched catch-up installer, enables and restarts the service, and reads `/health` back for at most 10 s, failing the step on no answer.
- Given `hub-device.test.mjs`'s catch-up `install.sh` test, when it runs, then it passes unchanged.
- Given `heavy mise run check`, when it runs, then actionlint and the full suite pass.

## Spec Change Log

## Review Triage Log

### 2026-11-25 — Review pass
- verdicts: 25 findings — high 1, medium 1, low 12, false 11, maybe-false 0
- findings:
  - `[low]` `[reject]` (blind) No test runs the real `heavy` / `systemd-run --scope` or a real stop. — Same gap as the verification-gap row, which is deferred. A suite test would break the hermetic rule. A manual check with the real `heavy` was done instead (Verification below).
  - `[false]` `[reject]` (blind) The API's own adb calls could fork a daemon in the service cgroup that a stop kills. — The API's reachability and discovery only read the adb wire (`queryAdb`, `host:version`/`host:devices-l`) and never start a server. `adb start-server` exists only in CLI and deploy paths (`claims.mjs:389`, `deploy.mjs:216`).
  - `[false]` `[reject]` (blind) A `heavy` that dies after spawn goes unnoticed. — `launch`'s callers check every process with `lost()` (`emulator.mjs`, the adb-server wait and the boot loop). A process that is gone throws with the tail of its log.
  - `[false]` `[reject]` (blind) The CLI now puts emulators in batch.slice, with no opt-out. — This is intended. AD-45 says every emulator boot on Linux goes through `heavy` "so no emulator runs at full weight".
  - `[false]` `[reject]` (blind) The unit lacks DISPLAY, WAYLAND_DISPLAY and ANDROID_HOME. — Emulators are headless by design: `-no-window`, and DISPLAY/WAYLAND are deleted from their env. `androidSdk` defaults to `~/Android/Sdk`.
  - `[false]` `[reject]` (blind) The node path is pinned at install time. — AD-45 mandates it: "the real `node/24.x` dir, not the mise symlink", and the switch happens only at `hosts:install`.
  - `[low]` `[reject]` (blind) `Restart=on-failure` loops on a refusal exit. — Refusals exit 1, the same as a crash, so `RestartPreventExitStatus` cannot tell them apart. Retrying is AD-45's intended recovery for `HUB_API_ALREADY_RUNNING`, and the `hosts:install` readback fails loudly.
  - `[false]` `[reject]` (blind) Linger is not handled, so the service dies at logout. — `loginctl show-user delorenj -p Linger` reads `Linger=yes`. The spine's service-manager row says "linger on".
  - `[low]` `[patch]` (blind) The Hub API step fails with a bare "No such file" when the release copy is missing, and is skipped silently inside the catch-up else-branch. — Group MISSING. `installHubApi` now checks for the installer and throws `release copy missing: <path> (the catch-up step puts releases/<ref> there)`. The step moved out of the else-branch so it always runs. hosts.test has rows for both.
  - `[low]` `[patch]` (blind) "At most 10 s" breaks when a 2 s attempt starts near the deadline. — Group DEADLINE. The per-attempt timeout is now `Math.max(1, Math.min(2000, deadline - now()))`.
  - `[low]` `[reject]` (blind) A failed readback leaves no rollback. — The rollback is the release's `Roll back:` line plus `hosts:install` at the old tag. An automatic re-point would add a branch to the installer.
  - `[low]` `[reject]` (blind) Brittle or weak test assertions: the identity check, the rm grep, `lines.length === 2`, a restart without emulator pids. — Each assertion is deliberate. End-to-end restart with a live emulator is Story 8.6.
  - `[high]` `[patch]` (edge) The emulator's private `XDG_RUNTIME_DIR` stops the real `heavy` from reaching the user manager. It falls back to nice/ionice, and the emulator stays in the service cgroup. — Reproduced with `XDG_RUNTIME_DIR=/tmp/x heavy true`. Group XDG: `inHeavy` takes a `manager` env. heavy is spawned with the manager's `XDG_RUNTIME_DIR`/`DBUS_SESSION_BUS_ADDRESS`, and the process's own values come back through an `env NAME=value` prefix, which execs. `emulator.mjs` passes `base` as manager. Tests are in hosts.test and emulator.test. The fix was verified live (Verification).
  - `[low]` `[reject]` (edge) Nothing checks that the process really left the service cgroup. — The fallback fires only without a user manager, and the service always runs under one. A cgroup check would add a guard for a state that is not reached.
  - `[low]` `[patch]` (edge) The readback can overrun 10 s. — Group DEADLINE (fixed above).
  - `[low]` `[reject]` (edge) A stale `releases/<ref>` from a dirty `main-<sha>` checkout is reused. — The standing rule is to install from a clean checkout at the tag, and a ref names its code.
  - `[low]` `[patch]` (edge) The Hub API step sits inside the catch-up else-branch. — Group MISSING (fixed above).
  - `[low]` `[reject]` (edge) A refused start restart-loops. — Same as the blind restart-loop row.
  - `[false]` `[reject]` (edge) The user manager is not lingering. — `Linger=yes` (see above).
  - `[false]` `[reject]` (edge) A later adb client call could auto-start an unwrapped daemon. — The pool talks to its server only through `createAdbWire`, which never starts one, and the adb binary is run only as `-L ... server nodaemon` through `launch`.
  - `[medium]` `[defer]` (verification-gap) No in-suite test exercises the real `heavy` scope and pid preservation. — The hermetic rule forbids a live user manager in the suite. A manual check confirmed pid, start time and batch.slice placement (Verification). The live check is deferred to 6.12's operator verification (frontmatter `deferred`).
  - `[false]` `[reject]` (intent) Live-host reading: the service is not installed on big-chungus, and there is no awaiting-operator. — Story 6.11's ACs ask for `hosts.mjs` "tested with a fake systemctl and a fake fetchImpl". The live install is Story 6.12's operator action ("`mise run hosts:install` has run from a clean checkout at the tag on big-chungus (operator actions)").
  - `[false]` `[reject]` (intent) `hub_version === ref` is untested under the real unit. — `hubRef` derives the ref from `receipt.mjs`'s own path (`releaseLayout`, `.../mobile-deploy-hub/releases/<ref>/tools/ci/lib/receipt.mjs`), which is the tree `ExecStart` runs.
  - `[false]` `[reject]` (intent) The catch-up installer's replace of `releases/<ref>` is not examined. — `hosts.mjs` runs it from the release copy when that exists, and the same-ref row tests it. A first install creates the dir before any service uses it.
  - `[low]` `[reject]` (intent) The restart test is in-process, not a real service restart. — It is exactly the AD-23 test shape the epic names: "stops one handler instance and starts another over the same temp dirs".

### 2026-11-25 — Review pass (follow-up)
- verdicts: 25 findings — high 0, medium 1, low 18, false 6, maybe-false 0
- findings:
  - `[low]` `[reject]` (blind) The live `heavy` check named in the triage log has no evidence row under `## Verification`. — Its fix is an edit to this build's spec. The manual check (pid, start time, `batch.slice` cgroup) is recorded in the Auto Run Result below, and DW-7 owns the live proof.
  - `[low]` `[reject]` (blind) The spec's contract text, AC and Code Map still describe the plain `heavy <command> <args...>` shape and the 4-argument `launch`. — Its fix is an edit to this build's spec. The `env` prefix is a recorded patch (XDG row above), and the code comments in `heavy.mjs` and `emulator.mjs` describe it.
  - `[low]` `[patch]` (blind) The unit's header says `install.sh` "copies it into ~/.config/systemd/user/", which contradicts the installer's "copies nothing". — Reworded in `tools/hosts/units/mobile-deploy-hub-api.service`: the installer "writes the result to ~/.config/systemd/user/ (a rendered file, no code is copied)".
  - `[low]` `[reject]` (blind) The `/health` readback can pass against a stray process on the port. — The stray process would have to run from the same `releases/<ref>`, because `hub_version` comes from the release path (`receipt.mjs` `hubRef`). A unit instance from another release answers another `hub_version`. An `is-active`/`MainPID` check would add a branch for a state nobody reaches in everyday use.
  - `[low]` `[reject]` (blind) `hosts:install` restarts the API on every run, and the step is not gated on catch-up success. — The restart is the spec'd behaviour ("enables and restarts the service"). An ungated run can only use an existing `releases/<ref>`, and a failed catch-up step still fails `hostsInstall`. Skipping the restart conditionally would add branches.
  - `[low]` `[reject]` (blind) carried — A `heavy` fallback to nice/ionice goes unlogged, and the emulator stays in the service cgroup. — Same claim as the earlier edge row "Nothing checks that the process really left the service cgroup". The code still reads as that row says: the fallback needs a missing user manager, and the service always runs under one.
  - `[low]` `[reject]` (blind) The README Hub API paragraph is dense, states the guarantee unconditionally, and gives no rollback or stop command. — These are documentation style points. The rollback is the release's `Roll back:` line (earlier row). The guarantee is the design, and DW-7 tracks its live proof.
  - `[low]` `[reject]` (blind) The `sed` rendering in `install.sh` breaks on `&`, `\` or `#` in `node_dir`, and old units are not cleaned up. — `ref` is regex-limited to `[A-Za-z0-9._-]`. `node_dir` is the `pwd -P` of the mise node install under `$HOME`, which holds none of those characters on any host here. Escaping would add complexity for an unreachable input. Deleting old units is outside the installer's "deletes nothing" rule.
  - `[low]` `[reject]` (blind) carried — The emulator test's assertions are brittle (`lines.length === 2`, `"$*"` logging). — Same claim as the earlier "Brittle or weak test assertions" row, and the code still reads as described. The `$*` shim is the spec'd shape, and no fixture argv contains a space.
  - `[low]` `[reject]` (blind) `releasesDir()` duplicates the release layout that `receipt.mjs` holds. — `receipt.mjs` holds only a private matching regex, not a path builder. `hosts.mjs` already spelled `.local/share/mobile-deploy-hub/releases/${ref}` in its Mac step before this change. A shared helper would be new public surface for no named divergence.
  - `[low]` `[reject]` (blind) The hosts tests have gaps: no "catch-up installer absent" row, no `XDG_CONFIG_HOME` row, and a weak `rm` grep. — The checkout always has the catch-up installer, and the "release copy missing" row covers the failure. The installer's default `XDG_CONFIG_HOME` branch is the one it uses. The `rm` grep is the carried brittle-assertion row.
  - `[false]` `[reject]` (blind) `hermetic()` puts a fake `heavy` on PATH, so a fixture with its own env gets no wrapping. — Without heavy the seam leaves the command unchanged, which is the spec's matrix row "Seam, no heavy". No test depends on wrapping it did not declare, and the shim shadows the real `heavy` for every fixture that inherits PATH.
  - `[low]` `[reject]` (edge) The readback succeeds against a foreign instance answering as `hub-api` with this ref. — Same reasoning as the blind stray-process row.
  - `[low]` `[reject]` (edge) carried — `inHeavy` silently falls back when the manager env lacks `XDG_RUNTIME_DIR`. — Same claim as the earlier "Nothing checks that the process really left the service cgroup" row. A systemd user service always has `XDG_RUNTIME_DIR`.
  - `[low]` `[reject]` (edge) A `sed` metacharacter or `%` in `node_dir` corrupts the unit. — Same reasoning as the blind `sed` row.
  - `[low]` `[reject]` (edge) carried — A stale `releases/<ref>` is reused on a same-ref reinstall. — Same claim as the earlier "stale `releases/<ref>` from a dirty `main-<sha>` checkout" row. The clean-checkout-at-tag rule covers it.
  - `[false]` `[reject]` (edge) The emulator's argv (`heavy env XDG_RUNTIME_DIR=… <emulator>`) differs from the spec'd shape, and pid preservation depends on `env` execing. — coreutils `env NAME=value cmd` replaces itself with `cmd` (execvp), so the pid is kept. The earlier pass checked this by hand with the real `heavy`: pid and start time were unchanged, and the process landed in `batch.slice`. The adb server keeps the literal shape.
  - `[false]` `[reject]` (intent) carried — The live install (reading A2) is not done. — Same as the earlier "Live-host reading" row. The live install is Story 6.12's operator action.
  - `[medium]` `[defer]` (intent) carried — A real `systemctl stop` that leaves a leased emulator alive (reading B2) is not exercised. — Same as the earlier verification-gap row, already in frontmatter `deferred` (DW-7). It is not re-added.
  - `[false]` `[reject]` (intent) The seam departs from the literal `[command, ...args]` shape for the emulator. — Same reasoning as the edge argv-shape row: an exec chain that keeps the pid is what the contract's "pid is the emulator's" requires.
  - `[low]` `[reject]` (intent) "Only after the catch-up step" is ordering, not a gate. — Same reasoning as the blind ungated-step row.
  - `[false]` `[reject]` (intent) "From the API" is not exercised on an API boot path. — No route in `tools/hub-api/` boots an emulator. `launch` is the pool's only long-lived spawn, so any future API caller goes through the seam.
  - `[false]` `[reject]` (intent) The restart test's snapshot is taken after A stops. — The matrix row asks for "lock dir bytes identical after B's start", which is exactly what it compares.
  - `[low]` `[reject]` (intent) carried — The shared resolver is checked by identity only. — Same as the earlier brittle-assertion row (the identity check). The code is unchanged.
  - `[low]` `[patch]` (intent) The unit's `Description` hardcodes port 8794, while the server and readback take `policy.json` `api.hub_api_port`. — The `Description` now reads "on 127.0.0.1 (port: policy.json api.hub_api_port)", so a policy port change cannot leave it stale.

## Design Notes

- **Why heavy keeps the pid.** `heavy` ends in `exec systemd-run --user --scope ... -- "$@"`, and a `--scope` run execs the command after moving itself into the scope. The pid that `spawn` returns becomes the emulator. Its `/proc/<pid>/stat` start time never changes across exec, so `liveStart`, `stopProcesses` and the reaper keep working. The emulator then lives in its own scope under `batch.slice`, outside the service's cgroup, so `KillMode=mixed` (SIGTERM to the main process, then SIGKILL only to the service cgroup) cannot reach it.
- **Why the adb server goes through the seam too.** It is the lease's own server. If it died with the service, the emulator would survive and the lease would still be broken.
- **Why run the catch-up installer from the release copy.** That installer replaces `releases/<ref>` (`rm -rf` + `mv`) whenever it runs from another tree. Running it from the release copy is a mode it already supports (its `$tools == $release/tools` branch), so the file stays untouched.

## Verification

**Commands:**
- `node --test tools/hosts/hosts.test.mjs tools/device/emulator.test.mjs tools/hub-api/server.test.mjs tools/device/hub-device.test.mjs tools/clock.test.mjs tools/deploy-path.test.mjs` -- expected: all pass
- `heavy mise run check` -- expected: actionlint clean, full suite green

## Auto Run Result

Status: done (follow-up review pass, 2026-11-25)

**Summary.** The Hub API is an always-on systemd user service that runs from a release, and stopping it never kills an emulator (FR-23, AD-45, AD-23):
- **Spawn seam.** On Linux, with `heavy` on PATH, `bootCommand` (in `tools/device/emulator.mjs`, built on `inHeavy` in `tools/ci/lib/heavy.mjs`) wraps every long-lived process the emulator pool starts in `heavy`. That covers the emulator and its lease's adb server. Each gets its own `batch.slice` scope outside the service cgroup, and its pid and start time stay its own. The emulator's private `XDG_RUNTIME_DIR` is restored with an `env` prefix.
- **Units.** `tools/hosts/units/` holds the `mobile-deploy-hub-api.service` template and `install.sh <ref>`. The installer renders the template from the release copy only, with the real `node/24.x` dir (>= 24.15). Its only `systemctl` call is `daemon-reload`.
- **hosts:install.** On big-chungus, `hosts.mjs` runs these steps in order:
  1. The untouched catch-up installer, from the release copy when that copy exists.
  2. The units installer.
  3. `systemctl --user enable`, then `restart`.
  4. A `/health` readback, bounded to 10 s, that must see `hub_version === <ref>`.
- **Restart.** The lock dir is byte-identical after a new instance starts on the same dirs.

**This pass.** A follow-up review of the `done` spec ran four layers: blind, edge, verification-gap and intent. It found two cosmetic issues and patched both. Nothing high was found.

**Files changed (whole story, since 93cf258):**
- `tools/ci/lib/heavy.mjs` (new): `which`, `onPath` and `inHeavy`, the one PATH resolver and the seam logic.
- `tools/device/emulator.mjs`: exports `bootCommand`. `launch` spawns through it, and the emulator passes `base` as the manager env.
- `tools/hub-api/server.mjs`: re-exports `onPath` from `heavy.mjs`.
- `tools/hosts/units/mobile-deploy-hub-api.service` (new): the unit template. In this pass its header wording and `Description` were corrected.
- `tools/hosts/units/install.sh` (new): renders every `*.service` from the release copy, then runs `daemon-reload`.
- `tools/hosts.mjs`: adds `installHubApi`, runs the catch-up installer from the release copy, and adds the `sleep`/`now`/`home`/`credentials` seams.
- `tools/ci/test-fixtures.mjs`: adds `heavyShim`. `hermetic()` now puts a fake `heavy` first on PATH.
- `tools/hosts/hosts.test.mjs` (new), `tools/device/emulator.test.mjs`, `tools/hub-api/server.test.mjs`, `tools/hostkey.test.mjs`: tests for the seam, the installer, the readback, the step order and the restart.
- `README.md`, `mise.toml`: document the service and `hosts:install`.

**Review findings (this pass).** 25 findings: high 0, medium 1, low 18, false 6, maybe-false 0.
- **Patched: 2 low entries.**
  - The unit header claimed the installer "copies" the unit. It now says the installer writes a rendered file.
  - The unit `Description` hardcoded port 8794. It now points to `policy.json api.hub_api_port`.
- **Deferred: nothing new.** DW-7 (no in-suite test runs the real `heavy` scope) is carried and already in `deferred`.
- **Rejected, with reasons (each finding has its own row in the Review Triage Log):**
  - **Spec-text findings** (Verification evidence, the contract's argv shape): the fix would edit this build's spec.
  - **Stray-process readback** (blind and edge): it needs a foreign process from the same `releases/<ref>`, which nobody reaches in everyday use.
  - **Restart on every run, and the step not gated on catch-up:** the restart is spec'd. The step can only reuse an existing release copy, and a failed catch-up still fails the install.
  - **`sed` metacharacters** (blind and edge): unreachable, because the `ref` regex and the `node_dir` path exclude them.
  - **README density:** a style point, and the rollback is the release's `Roll back:` line.
  - **`releasesDir` duplication:** there is no shared builder, and the path was already spelled out in `hosts.mjs`.
  - **hosts test gaps:** the cases are covered, or the inputs are unreachable.
  - **Carried rows**, each matching an earlier row with unchanged code: the silent heavy fallback (×2), brittle assertions, the identity check, the stale same-ref release, and the live install.
  - **Ordering versus gate:** handled as in the ungated-step row.
- **False (6):**
  - The `hermetic()` shim leaves an unshimmed fixture unwrapped, which is the spec'd "no heavy" behaviour.
  - The `env`-prefixed argv (×2): `env` execs, so the pid is kept.
  - The live install belongs to 6.12.
  - No API route boots emulators.
  - The restart snapshot matches the matrix row.

**Follow-up review: not recommended (false).** On a follow-up pass, only a patched `high` would call for another one. This pass patched 0 high, 0 medium and 2 low.

**Verification:**
- `node --test tools/hosts/hosts.test.mjs tools/device/emulator.test.mjs tools/hub-api/server.test.mjs tools/device/hub-device.test.mjs tools/clock.test.mjs tools/deploy-path.test.mjs` after the patches: 148 of 148 pass.
- `heavy mise run check` after the patches: exit 0, actionlint clean, 1222 of 1222 tests, 0 skipped.
- The previous pass also checked the seam by hand with the real `heavy`:
  - The command was `bootCommand('sh', …, {env: private XDG, manager: process.env})`, which spawned `~/.local/bin/heavy env XDG_RUNTIME_DIR=/tmp/xr-611 sh -c …`.
  - The process kept its pid and start time.
  - `/proc/<pid>/cgroup` read `.../user@1000.service/batch.slice/heavy-env-<pid>.scope`.

**Residual risks:**
- DW-7: the real `heavy` scope under a running service with a live emulator lease is proven only by hand. The live check is owed at 6.12.
- The service is not installed on any host until the 6.12 release runs `hosts:install` on big-chungus.
- When the `env` prefix is used, the heavy scope is named `heavy-env-<pid>`. This is cosmetic.

