# Sweep: hosts, install, services and the Mac (v1b grounding)

Swept 2026-11-24 against hub HEAD `993e2a7` (v1.2.51 installed on both hosts). Read only: no host state was
written. Every claim cites file:line in this repo, or a live read-only command and what it printed.

---

## 1. How `mise run hosts:install` installs things

### 1.1 Entry point

- `mise.toml:159-162`: the `hosts:install` task is `run = "node tools/hosts.mjs"`, with `tools = { node = "24" }`.
- `tools/hosts.mjs:58` `export async function hostsInstall({ log = console.log } = {})`. It runs on big-chungus only
  (`hosts.mjs:2`).
- Exports: `releaseName()` (`hosts.mjs:28`), `seedScript({ base, cache })` (`hosts.mjs:37`), `hostsInstall` (`hosts.mjs:58`).
- ssh options it uses: `['-o','BatchMode=yes','-o','ConnectTimeout=20']` (`hosts.mjs:21`).
- `sh()` runs `spawnSync` with `cwd: hubRoot`, default timeout 120 s, and returns `{ok, out}` (`hosts.mjs:23-26`).
- Steps run in order. Each step is wrapped in `step(name, fn)`, which logs `HOSTS <name>: <result>` or
  `HOSTS_FAILED <name>: <first line>` and keeps going (`hosts.mjs:62-64`). At the end it throws
  `hosts:install: <names> failed` if any step failed; otherwise it logs `HOSTS_OK <ref>` (`hosts.mjs:126-127`).
  The CLI prints `::error::<msg>` and sets exit code 1 (`hosts.mjs:130-131`).
  1. `build directory`: MinIO health check, then the index rendered with the writer keys if `index.html` is missing (`hosts.mjs:68-85`).
  2. `hub-mac`: `ssh hub-mac 'echo ok'`. On failure it prints the alias recipe `Host <host>, ProxyCommand tailscale nc <peer> %p` (`hosts.mjs:87-91`).
  3. `quickdrop .stignore` on the Mac (`hosts.mjs:93-97`).
  4. `handoff cache` seeding on the Mac, `ssh hub-mac 'bash -s'` with `seedScript` (`hosts.mjs:99-103`).
  5. `catch-up on big-chungus`: `bash tools/catchup/units/install.sh <ref>` (`hosts.mjs:109-113`).
  6. `catch-up on the Mac`: `mkdir -p .local/share/mobile-deploy-hub/releases/<ref>/tools/`, then
     `rsync -az --delete --stats -e "ssh -o BatchMode=yes -o ConnectTimeout=20" <hubRoot>/tools/ hub-mac:<that dir>`,
     then `ssh hub-mac "bash '.local/share/mobile-deploy-hub/releases/<ref>/tools/catchup/units/install.sh' '<ref>'"`
     (`hosts.mjs:114-124`).
- If `install.sh` is missing, it skips the catch-up steps with a log line (`hosts.mjs:105-108`).
- The ref is `releaseName()` (`hosts.mjs:28-33`): `git describe --exact-match --tags --match 'v[0-9]*.[0-9]*.[0-9]*' HEAD`
  when it matches `^v\d+\.\d+\.\d+$`, else `main-<7-char sha>`.
- **Working tree, not git:** step 5 runs the install.sh inside the checkout, which copies the checkout's `tools/` with
  `cp -R` (`install.sh:17-18,26-31`). Step 6 rsyncs `<hubRoot>/tools/` (`hosts.mjs:118`). Neither checks for a clean
  tree, and neither filters out tests or untracked files. `release.mjs` requires a clean tree (`release.mjs:74`), but
  `hosts.mjs` does not.
- `release.mjs` never calls hosts:install. It is a separate, manual follow-up (grep: the only hosts:install mention in
  release.mjs is the comment at `release.mjs:89`). v1a AD-20 says hosts:install runs on both hosts right after the
  freeze-set release (v1a spine `ARCHITECTURE-SPINE.md:359,443`).
- No test exercises `hostsInstall` itself. The only test touching `hosts.mjs` asserts that it never mentions
  `android_extra` (`tools/device/hub-device.test.mjs:421-432`).

### 1.2 `tools/catchup/units/install.sh <ref>` (runs on whichever host it is invoked on)

- Usage and validation:
  - `ref` must match `^[A-Za-z0-9._-]{1,64}$`, else exit 2 (`install.sh:15-16`).
  - It must run from a hub `tools/` tree (`catchup/catchup.mjs` and `ci/lib/adb.mjs` present), else exit 2 (`install.sh:17-19`).
  - Node must be at `$HOME/.local/share/mise/installs/node/24/bin/node`, else exit 2 (`install.sh:20-21`).
- **Release dirs:**
  - `share=$HOME/.local/share/mobile-deploy-hub` and `release=$share/releases/$ref` (`install.sh:23-24`).
  - When the tree is not already `$release/tools` (true on big-chungus), it does `rm -rf $release.part`, `cp -R tools`
    to `$release.part/tools`, `rm -rf $release`, then `mv $release.part $release` (`install.sh:26-32`).
  - On the Mac, hosts.mjs already rsynced into `$release/tools`, so nothing is copied twice (`install.sh:9-11`).
- **`current`:** `ln -sfn "releases/$ref" "$share/current"`, a relative symlink (`install.sh:33`).
- **Wrapper at an absolute path:** `~/.local/bin/hub-device` is a `#!/bin/sh` wrapper that runs
  `exec "<abs node 24>" "<abs $release>/tools/device/hub-device.mjs" "$@"`.
  - It is written to `.part`, made executable with `chmod +x`, then moved into place with `mv -f` (`install.sh:39-43`).
  - It deliberately points at the release dir, not at `current`, "so a session that started with it keeps the code it
    started with" (`install.sh:36-38`).
  - Live on big-chungus: `/home/delorenj/.local/bin/hub-device` runs `.../releases/v1.2.51/tools/device/hub-device.mjs`.
  - Live on the Mac: `/Users/delorenj/.local/bin/hub-device` runs `/Users/delorenj/.local/share/mobile-deploy-hub/releases/v1.2.51/...`.
- **Mode file:** `${XDG_CONFIG_HOME:-$HOME/.config}/mobile-deploy-hub/catchup.json`. It is created with
  `{"mode":"watch",...}` only if missing, and is never set to live (`install.sh:45-50`). It then runs
  `<node> $share/current/tools/catchup/catchup.mjs mode` (`install.sh:51`).
- **Linux branch** (`install.sh:54-63`):
  - `cp` copies `mobile-deploy-hub-catchup.service` and `mobile-deploy-hub-macwatch.service` into
    `${XDG_CONFIG_HOME:-~/.config}/systemd/user/`.
  - `rm -f` removes the retired `.timer` copies.
  - It runs `systemctl --user daemon-reload`. It runs no enable and no start.
- **Darwin branch** (`install.sh:64-76`):
  - `label=sh.delo.mobile-deploy-hub.catchup`, `domain=gui/$(id -u)`, `plist=~/Library/LaunchAgents/$label.plist`.
  - It runs `mkdir -p ~/Library/Logs/mobile-deploy-hub`.
  - It runs `sed "s#@HOME@#$HOME#g"` to `.part`, then `plutil -lint` and `mv`.
  - Then `launchctl bootout $domain/$label`, a wait of up to 20 x 0.5 s until `launchctl print` fails, then
    `launchctl bootstrap $domain $plist`, then it prints the job state.
  - Only one label is hard-coded.
- Any other `uname` value exits 2 (`install.sh:77-80`).

### 1.3 Test constraints on install.sh (what v1b must not break, or must change on purpose)

- `tools/device/hub-device.test.mjs:1262-1296` (Linux only):
  - It shims `systemctl`, `launchctl`, `plutil` and `uname=Linux`, and runs install.sh in a temp HOME with
    `HUB_LOCK_DIR` and `HUB_EVENT_DIR` set.
  - **It asserts the systemctl log is exactly `'--user daemon-reload\n'`** ("systemd was only told to re-read units: no
    enable, no start", `:1282`). It also asserts launchctl was never touched (`:1283`).
  - It asserts the wrapper's exact text, that it is a file and not a symlink, and that it is executable (`:1284-1286`).
  - Then it runs `status --json` and a `lease s26 ... --no-connect` through the wrapper (`:1288-1294`).
  - **This is the "daemon-reload restriction".** Any new `systemctl --user enable|restart|start` inside install.sh
    breaks this test.
  - Note: the PRD addendum cites this as `hub-device.test.mjs:909-941` (`addendum.md:119`). That line reference is stale.
- `tools/catchup/catchup.test.mjs:1151-1172`:
  - The catch-up `.service` is `Type=oneshot` with `KillMode=process`, and ExecStart is through `current`.
  - No `.timer` files exist.
  - **The catch-up plist has no `StartInterval|StartCalendarInterval|RunAtLoad|KeepAlive|WatchPaths` key** (`:1159`).
  - install.sh contains `launchctl bootstrap "$domain" "$plist"` and `domain="gui/$(id -u)"`.
  - **install.sh contains no `systemctl --user enable` anywhere, comments included** (`:1168`), and no `cp ... .timer`.
  - install.sh still sweeps the stray timers, creates watch mode, and never writes `"mode":"live"`.
- `tools/ci/v113.test.mjs:444-450`:
  - The macwatch service ExecStart runs through `current`.
  - The install.sh line must match `cp "$units/mobile-deploy-hub-catchup.service" "$units/mobile-deploy-hub-macwatch.service" "$dest/"`
    exactly (adjacent tokens), so a new unit needs its own `cp` line.
  - `doesNotMatch(installer, /systemctl --user enable/)`.

---

## 2. The Mac's catch-up LaunchAgent and how the candybar kicks it

- **Label:** `sh.delo.mobile-deploy-hub.catchup`. Template plist:
  `tools/catchup/units/sh.delo.mobile-deploy-hub.catchup.plist:13-14`.
  - `ProgramArguments`: `@HOME@/.local/share/mise/installs/node/24/bin/node`,
    `@HOME@/.local/share/mobile-deploy-hub/current/tools/catchup/catchup.mjs`, `ios` (`:15-20`).
  - `EnvironmentVariables`: HOME, and a PATH that includes node 24's bin, the mise shims and `/opt/homebrew/bin` (`:21-27`).
  - `LimitLoadToSessionType` is `Aqua` (`:28-29`).
  - `WorkingDirectory` is `@HOME@`.
  - stdout and stderr go to `@HOME@/Library/Logs/mobile-deploy-hub/catchup.log` (`:32-35`).
  - It has no StartInterval, RunAtLoad or KeepAlive. The comment explains: devicectl and the keychain work only in the
    GUI session (`:4-9`).
- **Live on the Mac:**
  - `launchctl list` shows `-  0  sh.delo.mobile-deploy-hub.catchup`.
  - `launchctl print gui/502/...` shows `state = not running`, `program = /Users/delorenj/.local/share/mise/installs/node/24/bin/node`,
    `domain = gui/502`, `runs = 1` (reset by the 21:16 re-bootstrap), `last exit code = 0`, and no `run interval` line.
- **The candybar** (project candybar in the hub):
  - The manifest is `.candybars/mobile-deploy-hub-ios-catchup.candybar.toml`.
  - `schedule = "*/5 * * * *"`, America/New_York, `enabled = false` at creation (`:8-11`).
  - Runner: `kind = "exec"`, `argv = ["/home/delorenj/.local/share/mise/installs/node/24/bin/node", ".candybars/mobile-deploy-hub-ios-catchup/kick.mjs"]`,
    `timeout_s = 1500` (`:13-17`).
  - It is live: the Mac's catchup.log shows passes at 02:20:08Z and 02:25:01Z, 5 minutes apart.
- **`kick.mjs`** (`.candybars/mobile-deploy-hub-ios-catchup/kick.mjs`):
  - Constants: `HOST = process.env.HUB_MAC_HOST ?? 'hub-mac'` (`:22`), `LABEL` (`:23`),
    `WAIT_MS = HUB_KICK_WAIT_MS ?? 20 min` (`:24`), `START_GRACE_MS = 60 s` (`:25`).
  - ssh options: `BatchMode=yes, ConnectTimeout=30, ServerAliveInterval=15, ServerAliveCountMax=4` (`:27`), "the same
    ssh options handoff.mjs uses".
  - The flow, in `main()`:
    - It reads `launchctl print gui/$(id -u)/<label>` over ssh (`:28,58-62`).
    - If the job is running, it finishes `pass` with `HUB_MAC_BUSY`.
    - Otherwise it sends `launchctl kickstart gui/$(id -u)/<label>` (`:76`), then polls `read()` every 2 s, then every
      10 s (`:79-86`).
    - The verdict comes from `verdict(before, after)` (`:41-46`), which compares `runs` and `last exit code`.
  - Exit codes and markers:
    - Exit 0 for `HUB_IOS_CATCHUP ...`, which covers pass, busy, and `HUB_MAC_AWAY` when `connectionError()` matches.
    - Exit 1 for `HUB_IOS_CATCHUP_FAIL ...` (`:64-69,88-89`).
  - It writes `{status, message}` to `CANDYBAR_RESULT_FILE` (`:67`).
  - Exports: `parseJob(text)`, `verdict(before, after, {elapsedMs, graceMs})` and `main(argv)`.
  - `--check` is read-only (`:74`).
- The cutover record is in candybar's `deploy/migration/remote-natives.md:7-36`. `candybar doctor --live` cannot see the
  Mac (`:28`).
- The two Linux catch-up clocks are candybar `systemd`-runner manifests in the candybar repo, not in this hub:
  - `~/code/33GOD/candybar/deploy/migration/manifests/mobile-deploy-hub-catchup/candybar.toml`: `*/2`, unit `mobile-deploy-hub-catchup.service`.
  - `.../mobile-deploy-hub-macwatch/candybar.toml`: `1-59/2`, unit `mobile-deploy-hub-macwatch.service`.
  - Candybar drops `~/.config/systemd/user/<unit>.d/50-candybar.conf` (`EnvironmentFile=-%t/candybar/inv/%n.env`) on both.
- Candybar's policy says KeepAlive is not a clock:
  `~/code/33GOD/candybar/src/candybar/scheduling_policy.py:42-45` reads "WatchPaths, QueueDirectories, StartOnMount and
  KeepAlive are events and supervision, not clocks, and are never flagged". `LAUNCHD_CLOCK_KEYS = ("StartInterval","StartCalendarInterval")`.

---

## 3. Reachability between the hosts

### big-chungus to the Mac

- `tools/ci/devices.json:7-9`: `mac.host = "hub-mac"` (an ssh alias on big-chungus) and `mac.peer = "carries-macbook-air"`
  (tailscale MagicDNS name). `devices.mjs:42-43` validates both.
- `~/.ssh/config:46-57` on big-chungus defines `Host hub-mac` with:
  - `HostName carries-macbook-air`
  - `User delorenj`
  - `IdentityFile ~/.ssh/id_ed25519`
  - `IdentitiesOnly yes`
  - `ProxyCommand tailscale nc carries-macbook-air %p`
  - `HostKeyAlias carries-macbook-air.burro-salmon.ts.net`
  - `ConnectTimeout 20`
  - `ServerAliveInterval 15`
  - `ServerAliveCountMax 4`
- The comment above it explains the alias: "this host's resolver has no MagicDNS, and mommymac.local is LAN-only".
- Live check: `getent hosts carries-macbook-air.burro-salmon.ts.net` on big-chungus fails (rc 2). Only
  `big-chungus.burro-salmon.ts.net` resolves, through `/etc/hosts:18`. A separate alias, `Host mac`, hard-codes
  `100.81.162.91` (`~/.ssh/config:17-20`). Use `hub-mac`, never `mac`.
- `tailscale status`:
  - big-chungus is `100.66.29.76`.
  - `carries-macbook-air` is `100.81.162.91`, macOS, "active; direct 192.168.1.62:41641" at sweep time.
  - The tailnet is `burro-salmon.ts.net`.
- The design doc (`docs/design-hub-v1.1.md:463-465,889`) records `hub-mac`, the DERP banner timeouts and the retries
  (`HUB_MAC_RETRY`).
- Existing primitives for reaching and judging the Mac:
  - `connectionError(error)`, regex-based (`tools/ci/lib/handoff.mjs:81`).
  - `retried(fn, {attempts, delaysMs, ...})` (`handoff.mjs:83`).
  - `tailscaleStatus()` (`tools/ci/lib/metered.mjs:63`).
  - `macLink({status, peer, lanCidr, probe, github})`, which returns `{link: offline|home|metered, addr, reason, catchup}` (`metered.mjs:45-61`).
  - `macProbeOver(host, {runnerDir, tries})` (`metered.mjs:81-92`).
  - `announce` runs `ssh hub-mac '~/.local/bin/hub-device reservation release --run <key> --name mac-ios'`
    (`tools/ci/commands/announce.mjs:70,86`, with `MAC_HUB_DEVICE = '~/.local/bin/hub-device'`).

### The Mac to big-chungus

- `devices.json:21`: `linux.host = "big-chungus"`, described as "an ssh alias on the Mac" (`devices.mjs:58`).
- The Mac's `~/.ssh/config:5-25` defines `Host big-chungus` with:
  - `HostName big-chungus.burro-salmon.ts.net`
  - `User delorenj`
  - `Port 22`
  - Ciphers and Kex settings
  - `ServerAliveInterval 30`
  - `Compression yes`
  - **`ControlMaster auto`, `ControlPath ~/.ssh/cm-%r@%h:%p`, `ControlPersist 30m`**
  - `SendEnv ...`
  - `SetEnv VOX_SINK=carries-macbook-air`
  - **`RequestTTY yes`**
- A live mux socket `~/.ssh/cm-delorenj@big-chungus.burro-salmon.ts.net:22` exists on the Mac.
- On the Mac, `dscacheutil` resolves `big-chungus.burro-salmon.ts.net` to `100.66.29.76`. MagicDNS works on the Mac.
  The bare `big-chungus` name resolves to a LAN address there, but the ssh alias uses the FQDN.
- The Mac has `/Applications/Tailscale.app` but no `tailscale` CLI on PATH (`which tailscale` reports not found).
- **Existing Mac-to-big-chungus paths are all ssh. None is an HTTP client:**
  - `catchup.mjs record`: `sshRecordCommand(facts, host)` returns
    `['-T','-o','BatchMode=yes','-o','ConnectTimeout=20','-o','ServerAliveInterval=15', host, '<remoteRecord> <quoted args>']`
    (`tools/catchup/catchup.mjs:937-944`).
    - `remoteRecord` prefers `$HOME/.local/share/mise/installs/node/24/bin/node` and falls back to `node`, then runs
      `$HOME/.local/share/mobile-deploy-hub/current/tools/catchup/catchup.mjs record`. So big-chungus's **`current`**
      receives it.
    - `-T` is needed because the Mac alias has `RequestTTY yes`.
    - It works from the GUI LaunchAgent with no ssh agent (`docs/design-hub-v1.1.md:855`). The Mac's catchup.log has
      `HUB_CATCHUP_REPORTED` lines echoed back from big-chungus (latest 2026-11-23T14:00:18Z).
  - `readOverSsh({host, url})` runs `ssh -T ... big-chungus "curl -s --max-time 20 -w '\n%{http_code}' 'http://127.0.0.1:<port>/...'"`.
    It is restricted by regex to `latest|inflight.json` on `127.0.0.1` (`catchup.mjs:1088-1098`).
    **This is the precedent for the Mac reaching a big-chungus loopback HTTP service: through ssh, then curl on loopback.**
  - `sendIpa`: rsync and ssh to `devices.linux.host` staging (`tools/ci/commands/ios.mjs:120-142`), with ssh options at `ios.mjs:91`.
- The only public HTTP path is `https://s3.delo.sh` through Cloudflare, for the bucket (`policy.json` `delivery.s3.public`).
  MinIO itself is `127.0.0.1:9012` only (`ss -ltn` shows `127.0.0.1:9012`).

---

## 4. Node on the Mac (and on big-chungus)

- Mac:
  - In a non-interactive ssh shell, `which node` prints "node not found" and `node -v` gives "command not found".
  - `~/.local/share/mise/installs/node/24 -> ./24.15.0`, and `.../24/bin/node -v` prints `v24.15.0`. Versions 25.9.0 and
    26.7.0 are also installed, with `latest -> 26.7.0`.
  - macOS 26.7.3 (25G342). uid 502. `hostname` is `mommymac.local`.
- Every hub entry point uses the absolute mise path `$HOME/.local/share/mise/installs/node/24/bin/node`:
  - install.sh (`:20`)
  - the plist (`:17`)
  - the systemd units (`mobile-deploy-hub-catchup.service:14`, `-macwatch.service:14`)
  - `remoteRecord` (`catchup.mjs:938`)
  - the candybar argv (`.toml:15`)
  - the Linux unit's PATH (`.service:12`)
- big-chungus: `24 -> 24.15.0` (v24.15.0). `/usr/bin/node` is v20.19.4. The design doc says a bare `node` in a unit is
  the system node (`docs/design-hub-v1.1.md:866`).

---

## 5. Long-lived service precedent, and how a hub-api unit and a KeepAlive agent would install

- **No long-lived service exists in this repo.**
  - A grep of tools/.candybars for `KeepAlive|Restart=|Type=simple|createServer|node:http|listen(` finds nothing outside tests.
  - The only `net.createServer` is in `tools/device/emulator.test.mjs:39`.
  - Both systemd units are `Type=oneshot` (`mobile-deploy-hub-catchup.service:10`, `-macwatch.service:11`).
  - The plist has no KeepAlive or RunAtLoad.
- **KillMode precedent:** `mobile-deploy-hub-catchup.service:15-17` has `KillMode=process` ("an adb server the pass
  starts must outlive it"), `TimeoutStartSec=50min` and `Nice=10`. Macwatch has `TimeoutStartSec=5min` and `Nice=10`.
- **Always-on user services elsewhere on big-chungus (other repos):**
  - `candybar-executor.service`: `Type=simple`, `Restart=always`, `RestartSec=3`, `KillMode=mixed`,
    `StartLimitIntervalSec=0`, `[Install] WantedBy=default.target`, enabled.
  - `hook-hub.service`: `Restart=on-failure`, `StartLimitBurst=5`.
  - `holocene-api.service`: node on `0.0.0.0:4000`, `Restart=on-failure`.
  - Linger for delorenj is `yes` (`loginctl show-user delorenj -p Linger`).
- **Always-on LaunchAgents elsewhere on the Mac:**
  - `sh.delo.vinyl.server`: KeepAlive true, RunAtLoad true, binds `127.0.0.1:7733`.
  - `sh.delo.gruvato.backend`: `KeepAlive = {SuccessfulExit...}`, RunAtLoad, `LimitLoadToSessionType Aqua`.
  - `com.delo.voxxy-listen`: KeepAlive true, RunAtLoad true.
- **Holocene API** runs on the host as `holocene-api.service`, not in a container, so it can reach a big-chungus loopback
  port. Its Candybar module defaults to `CANDYBAR_API_URL ?? "https://candybar.delo.sh"`
  (`~/code/33GOD/holocene/apps/api/src/candybar.ts:11`).
- **`batch.slice`** exists ("Batch workloads launched through `heavy`"). The README tells people to prefix
  `heavy hub-device run emulator` to put the boot in batch.slice (README "Emulators", last bullet). A hub-api user
  service would land in `app.slice` by default.
- **How a new hub-api user service would be installed:**
  - The PRD addendum says it would be "Enabled from `hosts.mjs`, because `install.sh` may only `daemon-reload`", with
    `KillMode=process` (`prds/.../addendum.md:119`).
  - Seam: install.sh copies the new unit with its own `cp` line and still runs `daemon-reload` only.
  - `hosts.mjs` adds a step after `catch-up on big-chungus` that runs `systemctl --user enable` and `restart` for the
    unit through `sh()`, then reads `/health` on loopback.
  - No test constrains hosts.mjs here, apart from the `android_extra` ban.
- **How a KeepAlive Mac agent would be installed:**
  - Seam: a second plist template in `tools/catchup/units/` (or a new units dir) with its own label, never the catch-up
    label (`addendum.md:114`).
  - It would have KeepAlive, RunAtLoad and `LimitLoadToSessionType Aqua`.
  - The Darwin branch of install.sh would run `sed`, `plutil -lint`, `bootout`, wait and `bootstrap` for it too. It is
    already run over ssh by hosts.mjs, and bootstrapping into gui/502 from ssh works (`docs/design-hub-v1.1.md:854`).
  - The ban on a KeepAlive key in `catchup.test.mjs:1159` covers only the catch-up plist.

---

## 6. How `current` advances, and which release a long-lived service should run from

- **`installCurrent({hubRef, home, source, log})`** (`tools/ci/commands/common.mjs:140-163`):
  - It acts only when `hubRef` matches `releaseRef = /^v\d+\.\d+\.\d+$/` (`common.mjs:19,144`).
  - It is forward-only: it keeps `current` if that points at a newer `releases/vX.Y.Z` (`:148-152`). A `main-*` target
    reads as `now = null`, so any tag replaces it.
  - It runs `cpSync(source, releases/<ref>/tools, {recursive, force})` and skips `node_modules` and `.git` (`:154-156`).
  - It then does an atomic symlink swap (temp link plus rename) (`:157-160`) and logs `HUB_CURRENT ...`.
  - It touches no units, plist or wrapper.
- **big-chungus:** `deliver.mjs:295` calls it after a real publish. A dry run returns at `deliver.mjs:218-244` before it is reached.
- **Mac:** `ios.mjs:443-445` calls it inside `if (!config.dryRun)`.
- **hosts:install:** `install.sh:33` sets `current -> releases/<ref>` unconditionally, even backwards, and even to `main-<sha>`.
- **Live:**
  - Both hosts have `current -> releases/v1.2.51`. On big-chungus, `current` and `~/.local/bin/hub-device` both have
    mtime 2026-11-24 21:16:51 EST, so hosts:install ran then. The Mac has the same mtime.
  - 33 release dirs on each host, `main-315e7ca` through `v1.2.51`. **Nothing prunes `releases/`.**
- **Which code each consumer runs:**

  | Consumer | Runs from | Moves at |
  |---|---|---|
  | S26 catch-up, macwatch (systemd) | `%h/.local/share/mobile-deploy-hub/current/...` (`.service:14`) | every real deliver; hosts:install |
  | iPad catch-up (LaunchAgent) | `@HOME@/.../current/...` (`plist:18`) | every real ios job; hosts:install |
  | `catchup.mjs record` over ssh from the Mac | big-chungus `current` (`catchup.mjs:938`) | as above |
  | `hub-device` (both hosts) | `releases/<ref>` absolute in the wrapper (`install.sh:40`) | hosts:install only |
  | deploy jobs | the runner's `_actions/.../<tag>` | pin flip |

  - NFR-2 (`prd.md:420`) says the Hub API and the Mac Host Agent switch at **hosts:install**.
  - The addendum's Versions table says "whichever release they were started from, until they restart" (`addendum.md:43-51`).
- **Symlink resolution:**
  - Node ESM resolves the main entry's realpath.
  - The guards for running as a script use a realpath compare: `catchup.mjs:1206-1208`, `macwatch.mjs:101-103`, and
    `hub-device.mjs:830` (`pathToFileURL(realpathSync(argv[1]))`).
  - `hubRef()` reads the ref from the realpath `.../mobile-deploy-hub/releases/<ref>/tools/ci/lib/receipt.mjs`
    (`receipt.mjs:21-31`).
  - So a process started through `current` keeps reading its own release's `policy.json`. `loadPolicy()` reads the file
    on every call (`policy.mjs:9,323-324`), and so does `loadDevices()` (`devices.mjs:63-64`).
  - Event `hub_version` is `v1.2.51` in both hosts' latest events.
- **Hazard for a service running from `releases/<ref>`:**
  - Re-running hosts:install with the **same ref** runs `rm -rf $release` and then `mv .part` on big-chungus
    (`install.sh:30-31`). The release dir disappears briefly under any running process that reads policy or devices per call.
  - On the Mac, `rsync --delete` rewrites the files in place (`hosts.mjs:118`).
  - `installCurrent`'s `cpSync(force)` also overwrites files in a release dir that may be running (`common.mjs:156`).

---

## 7. Lock dir and event dir paths (both hosts)

- Lock dir: `lockDir(env, home) = env.HUB_LOCK_DIR || join(home, '.cache/mobile-deploy-hub/locks')` (`tools/ci/lib/lock.mjs:26`).
- Event dir: `eventDir(env, home) = env.HUB_EVENT_DIR || ($XDG_STATE_HOME if absolute) /mobile-deploy-hub/events || ~/.local/state/mobile-deploy-hub/events`
  (`tools/ci/lib/events.mjs:15-21`). Files are `<YYYY-MM>.jsonl`, mode 0600 in a 0700 dir (`events.mjs:86-88`).
- **Mac (live):**
  - `/Users/delorenj/.cache/mobile-deploy-hub/locks/` holds `mac-ios.queue/` and `mac-ios.reservations/`.
  - `/Users/delorenj/.local/state/mobile-deploy-hub/events/2026-11.jsonl` is 356 KB.
  - `HUB_LOCK_DIR`, `HUB_EVENT_DIR` and `XDG_STATE_HOME` are unset in ssh.
  - The latest event envelope is `"host":"mommymac.local","host_id":"D0BB14E9-ECF4-5105-899C-235C7719CED9","hub_version":"v1.2.51"`.
- **big-chungus (live):**
  - `~/.cache/mobile-deploy-hub/locks/` holds `adb.queue`, `adb.reservations`, `emulator-1.queue`, `emulator.queue`,
    `emulators/` and `s24.queue`.
  - `~/.local/state/mobile-deploy-hub/events/2026-11.jsonl`. The envelope is `"host":"big-chungus","host_id":"7819b25afd00478fb5dc3666022f6962"`.
  - No `HUB_*` override in any `~/actions-runner/*/.env`, and none in the workflows.
- The mode file on both hosts: `~/.config/mobile-deploy-hub/catchup.json`. The Mac's reads `{"mode":"live","changed_at":"2026-10-09T21:09:44Z"}`.
- The QA declarations are at `~/.config/mobile-deploy-hub/qa-devices.json` on big-chungus, mode 0600
  (README:239, `$HUB_QA_DEVICES`).
- Cross-host rules in lock.mjs:
  - `sameHost(a, b)` matches on `host_id`, else on `host` (`lock.mjs:90-94`). `localHost()` is at `lock.mjs:96`.
  - A Lease from another host is honoured until `expires_at` (`staleness`, `lock.mjs:72-87`).
  - A ticket with no format is `foreign-host` (`lock.mjs:497`).
  - The Mac has three names: ssh alias `hub-mac`, tailnet peer `carries-macbook-air`, and `os.hostname()` `mommymac.local`.
    Its stable id is the IOPlatformUUID `host_id` (`events.mjs:23-43`).

---

## Gaps and conflicts found

1. **Loopback vs tailnet.**
   - NFR-6 says the Hub API listens on loopback on big-chungus (`prd.md:429`, marked `[ASSUMPTION]`).
   - The addendum says the Mac agent "pushes changes to the Hub API over the tailnet" (`addendum.md:114`).
   - A loopback socket is not reachable over the tailnet, and no Mac-to-big-chungus HTTP path exists today. Every
     existing path is ssh: `record`, `readOverSsh` curl on loopback, and rsync.
2. **When the Mac agent switches code.**
   - The addendum says it "restarts or exits lazily when the Mac's `current` moves" (`addendum.md:114`).
   - NFR-2 says the Host Agent switches at hosts:install (`prd.md:420`).
   - `current` on the Mac moves at every real ios job (`ios.mjs:443-445`), not only at hosts:install.
3. **Requests from big-chungus to the Mac's GUI-session agent.** ssh lands outside the GUI session, so devicectl and the
   keychain do not work there (`plist:4-9`, `kick.mjs:4-6`). The only existing way to make GUI-session work happen from
   big-chungus is `launchctl kickstart` of a labelled job. No mechanism exists today to deliver an arbitrary request,
   such as lease or release on mac-ios or "check the iPad", to a long-lived GUI agent.
4. **The install.sh tests forbid enable and restart.** `hub-device.test.mjs:1282`, `catchup.test.mjs:1168` and
   `v113.test.mjs:449` together forbid any enable or restart in install.sh. Enabling has to live in hosts.mjs, as the
   addendum says, but the addendum's line citation is stale (909-941; the real lines are 1262-1296).
5. **hosts:install copies the working tree under a tag name.** It never checks that the tree is clean, so a dirty tree
   can be installed and labelled `vX.Y.Z`. A re-run with the same ref also deletes the release dir out from under
   running processes.
6. **No release pruning** on either host (33 dirs each).
