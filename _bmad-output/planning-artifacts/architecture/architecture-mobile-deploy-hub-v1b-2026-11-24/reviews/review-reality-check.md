# Review: reality check (v1b spine vs the live hosts, the repo and upstream sources)

**Verdict: REVISE (one critical, four high).** Most of the spine's technical claims hold up. Node 24, the ports, the ssh aliases, curl, linger, the launchd and systemd keys, the adb services and the Candybar wire basics all check out. The cross-host transport does not work as written. A remote command run over a non-pty ssh session outlives its client (tested on the live Mac). Both login shells are zsh, which rejects the unquoted query URLs the curl template would send (tested). The iPad has no Reachability mapping, and the obvious mapping is wrong for an idle iPad (tested). Findings the adversary and input-reconcile reviews already raised are not repeated here.

Method: probes ran on 2026-11-24 on big-chungus and over `ssh hub-mac`. Upstream sources: `nodejs.org/dist/index.json`, adb `docs/dev/services.md` (googlesource main), local `man systemd.kill` / `systemd.unit` / `ssh_config` (systemd 257, Ubuntu OpenSSH), the Mac's `man launchd.plist`, and `~/code/33GOD/candybar/src/candybar/api/stream.py` plus `~/code/33GOD/holocene/apps/api/src/candybar.ts`.

---

## Critical

### C1. A dead ssh leg does not end the far-end wait (AD-37, AD-48, AD-26)
- **Claim:** AD-37: "A forwarded wait is the same chain end to end: if the ssh leg dies, the far end sees its client disconnect."
- **Reality (tested):** From big-chungus I ran `timeout 6 ssh -T -o BatchMode=yes hub-mac "perl -e '\$0=q(mdhprobe); select(undef,undef,undef,40)'"`. The local ssh was killed (exit 124), and the Mac still had `3164 mdhprobe` running afterwards. sshd does not signal a non-pty command when its client goes away. The remote `curl` in AD-26 writes nothing while it waits, so it never takes a SIGPIPE either. It keeps its loopback connection open until its own `--max-time`, which AD-48 sets to wait + provision budget + 30 s. Silent drops are worse. The Mac's sshd sets no `ClientAliveInterval` (it is off by default), so a laptop that sleeps or loses Wi-Fi is never noticed on the Mac side. big-chungus's sshd has `ClientAliveInterval 30` x `CountMax 4`, so it notices after about 120 s.
- **Consequence:** The ghost waiter keeps its place in the queue, which is the failure AD-37 says it prevents. If the ghost is served, the API Lease is lock-only and bound only by its expiry (AD-36). That holds `adb` or `mac-ios` for up to 60 min, or a runtime Resource for up to 48 h, for nobody.
- **Fix wording (AD-26 and AD-37):** "The remote end of a cross-host call is never a bare `curl`. It is `<abs mise node/24> <release>/tools/hub-client.mjs relay <method> <path>`, which reads the JSON body as its first stdin line and then keeps reading stdin. The caller writes a newline every `api.stream_keepalive_s` for the life of the call. This interval belongs to the call, like AD-43's keepalive. The relay aborts its loopback request when stdin hits EOF or when 3 intervals pass with no byte. Aborting closes the socket, so the server records `cancel` (AD-37). The client also sets `-o ServerAliveInterval=15 -o ServerAliveCountMax=2`. A test runs the relay against a fake server, closes its stdin mid-wait and asserts that the abort reaches the handler." The absolute node 24 path exists on both hosts (`node/24 -> 24.15.0`, verified). Update the Stack row "`curl` on both hosts" to match.

## High

### H1. The AD-26 curl template fails on both hosts as written (AD-26, AD-32, AD-35, AD-48)
- **Reality (tested):** The login shell is `/bin/zsh` on the Mac and `/usr/bin/zsh` on big-chungus, and ssh runs the remote command string through it. `ssh hub-mac 'echo http://127.0.0.1:8795/history?resource=a&pool=b'` printed `zsh:1: no matches found: http://127.0.0.1:8795/history?resource=a`. Every query route (`/history`, `/utilisation`, `/resources?...`) breaks, and `&` would background the command.
- The template also loses data. curl reads no body from stdin without `--data-binary @-` and a `content-type: application/json` header. `-sS` without `-D -` or `-w '\n%{http_code}'` drops the status code and `X-Request-Id`. The precedent `catchup.mjs:1092` uses `-w '\n%{http_code}'` and single-quotes the URL.
- The connect timeout is not what AD-32 and AD-35 assume. `api.peer_connect_timeout_s` (5) is never passed. The aliases' own values apply instead: `hub-mac` has `ConnectTimeout 20` and the Mac's `big-chungus` alias has `ConnectTimeout none`. With `tailscale nc` as the ProxyCommand, `ConnectTimeout` still bounds the handshake (`man ssh_config`), so passing it works.
- **Fix wording (AD-26):** "`hub-client` builds argv `ssh -T -o BatchMode=yes -o ConnectTimeout=<api.peer_connect_timeout_s> -o ControlMaster=no -o ControlPath=none <alias> <one command string>`. Every word of the command string is single-quoted, with `'` written as `'\''` (the `catchup.mjs:943` precedent). The body goes on stdin, and the status and headers come back on the response. A hermetic test builds the string for a path containing `?`, `&` and `'` and runs it through both `zsh -c` and `sh -c`." If C1's relay is adopted, the command string is just the relay argv and the curl flags disappear.

### H2. The iPad has no Reachability mapping, and "listed" is not "present" (AD-35, FR-5, FR-12)
- **Claim:** AD-35 defines one mapping function, but it covers only adb states. For the Mac it says only "`xcrun devicectl list devices`".
- **Reality (tested on hub-mac, Xcode 27.2, devicectl 651.32, run from an ssh session with `outcome: success`):**
  - `iPad14,5` (the lane's iPad): `tunnelState disconnected`, `pairingState paired`, `bootState booted`.
  - `iPad17,4`: `disconnected`, `paired`, `shutdown`.
  - `iPhone19,2`: `disconnected`, `paired`, `shutdown`.
- So devicectl lists devices it has paired with in the past, and `tunnelState: disconnected` is the normal idle state of a working iPad, not offline. The repo already owns this parsing in `tools/ci/lib/devicectl.mjs`: `--timeout` plus `--json-output` and a hard kill, and `pickIpad`. `pickIpad` treats a listing with no live hardware details as tunnel `unavailable`, meaning pending, after the incident on 2026-10-24.
- **Fix wording (AD-35):** "On the Mac the mapping takes `pickIpad`'s result through `devicectl.mjs`, the only devicectl transport:
  - UDID not listed: `absent`.
  - Listed without live hardware details: `unknown`.
  - `pairingState != paired` or Developer Mode off: `unauthorized`.
  - `bootState != booted`: `offline`.
  - Otherwise: `reachable`.
  - A devicectl failure or timeout: `unknown`.

  `tunnelState` is never a Reachability input. Discovery lists only `reality: physical` devices that no Resource names." Side note: `list devices` worked from a plain ssh session, so the GUI-session rule (plist:4-9) is about the keychain and installs, not listing. The Host Agent still belongs in Aqua.

### H3. The layer table forbids the imports AD-35 needs (Design Paradigm table, AD-35)
- **Claim:** The row for `tools/registry/reachability.mjs` may import "`tools/ci/lib/adb*.mjs` read-only helpers, `node:` builtins".
- **Reality:** `tools/ci/lib` holds only `adb.mjs` and `devicectl.mjs`. The wire client AD-35 mandates is `tools/device/adb-wire.mjs` (beside `tools/device/async-adb.mjs`), and `devicectl.mjs` is not allowed at all. A builder who obeys the table re-implements the adb wire and the devicectl parsing, which breaks the one-owner rule. A conformance test written from the table would also reject the correct import.
- Also note that `adb-wire.mjs`'s `exchange()` resolves only when the socket closes (sweep 5.4), so `host:track-devices` needs a new streaming export.
- **Fix wording:** The row reads "`tools/device/adb-wire.mjs` (gains a streaming `trackDevices`), `tools/ci/lib/adb.mjs` (the Peek), `tools/ci/lib/devicectl.mjs`, `node:` builtins". Add `device/adb-wire.mjs # + trackDevices` to the Structural Seed.

### H4. Flushing `X-Request-Id` before the wait commits the status code (AD-37, AD-48, AD-42)
- **Reality (HTTP/1.1 and `node:http`):** Headers cannot go out without the status line, and `res.flushHeaders()` writes both. AD-37 and AD-48 flush `X-Request-Id` "before the wait begins", so every waiting `POST /leases` commits `200` before its outcome is known.
- **Consequences:**
  - (a) A wait that ends busy (409, exit 76), away (503, exit 75), `HUB_LOCK_TIMEOUT` or `503 HUB_API_RESTARTING` cannot carry the problem+json status that AD-42 and the Claims code-to-HTTP table promise.
  - (b) AD-37's "a Hold granted after the socket was destroyed, before the status line was written, is released at once" can never fire, because the status line is always written first.
- **Fix wording (AD-48, AD-37):**
  - "`hub-client` always mints the Lease `id` (the v1a format), so a waiting client never needs a header before the outcome. The server writes the status line and `X-Request-Id` only with the outcome. A server-minted id is used only for a request that does not wait (`wait: 0`)."
  - "A Hold granted after the socket closed is released at once. Otherwise it stands and is fetchable by `id`."

  The alternative is a documented `200` plus a streamed outcome object, which then needs its own contract row.

## Medium

### M1. `hostKey()` reads an OS field that no host block has (AD-47)
- **Claim:** "maps `process.platform` to the key whose block declares that OS".
- **Reality:** In the live `tools/ci/devices.json`, the `mac` block has the keys `handoff_cache, handoff_dir, host, min_free_gib, outbox, peer, runners`, and the `linux` block has `host, staging_dir`. Neither declares an OS. (`mac.host = hub-mac`, `linux.host = big-chungus` and `mac.peer = carries-macbook-air`, the `tailscale nc` peer, all agree with AD-26.)
- **Fix wording:** "`hostKey()` uses a frozen map `{linux: 'linux', darwin: 'mac'}`, checked against the `devices.json` blocks by a test." Or add `os` to each host block in the same hub release.

### M2. The Mac's `big-chungus` alias multiplexes, and a stale master is not bounded by ConnectTimeout (AD-26, AD-49, NFR-8)
- **Reality:** On the Mac, `ssh -G big-chungus` gives `ControlMaster auto`, `ControlPath ~/.ssh/cm-delorenj@big-chungus.burro-salmon.ts.net:22`, `ControlPersist 1800`, `ConnectTimeout none` and `RequestTTY true`. The Host Agent's pushes and forwards would ride a master that may be dead after the Mac sleeps. A session attached to an existing master is not covered by `ConnectTimeout`, and only `ServerAliveInterval 30` x 3 (about 90 s) clears it. The master is also forked by whichever caller came first, a CI job included, and lives in that caller's process tree.
- I did not observe the stale-master hang, because I did not sleep the Mac. Measured times:

  | Path | Time |
  | --- | --- |
  | Mac to big-chungus `ssh true`, no mux | 582 ms |
  | Mac to big-chungus `ssh true`, mux | 51 ms |
  | big-chungus to Mac ssh plus loopback curl, no mux | 256 ms |
- **Fix wording (AD-26):** "`hub-client` passes `-o ControlMaster=no -o ControlPath=none`. Every call is its own connection, bounded by `api.peer_connect_timeout_s`." This costs about 0.6 s per push, inside AD-43's 2 s budget.

### M3. A launchd `KeepAlive` plus an exit-1 singleton refusal is a 10 s retry clock (AD-45, AD-19)
- **Reality:** The Mac's `man launchd.plist` says jobs "will not be spawned more than once every 10 seconds" (ThrottleInterval) and that `KeepAlive` "implicitly implies RunAtLoad". With `KeepAlive` true, an agent that exits 1 on `EADDRINUSE` restarts every 10 s forever, which contradicts "Neither service adds a timer". The systemd side stops on its own: `Restart=on-failure` with the default `StartLimitBurst` and `StartLimitIntervalSec` puts the unit in `failed`.
- **Fix wording:** "The plist uses `KeepAlive = {SuccessfulExit = false}` (the precedent is `sh.delo.gruvato.backend`). A singleton refusal logs `HUB_API_ALREADY_RUNNING` and exits 0 under launchd, so it is not respawned. A crash exits non-zero and is." Or keep exit 1 and record the 10 s respawn as a named exception.

### M4. Emulators the service provisions run at full weight inside the API unit (AD-45, AD-36, the host's heavy-jobs rule)
- **Reality:** `tools/device/emulator.mjs` has no `heavy` or `systemd-run`. `~/.local/bin/heavy` moves a job into a transient scope under `batch.slice` (CPUWeight=10, MemoryHigh=40G). The README tells CLI users to prefix `heavy`, but an API Lease cannot. Emulators started by `mobile-deploy-hub-api.service` would therefore sit in its `app.slice` cgroup at full weight. That cgroup is also the only reason `KillMode=process` is needed, and systemd 257's `man systemd.kill` marks that setting "(not recommended!)".
- **Fix wording (AD-36 or AD-45):** "On Linux, a service-side `provision` launches the emulator through `heavy` (a `batch.slice` scope), which also takes it out of the unit's cgroup. The unit may then keep `KillMode=mixed`." The alternative is to keep `KillMode=process` and state in the unit file that emulators are deliberately left in its cgroup.

### M5. Stream ids must survive Holocene's Last-Event-ID filter (AD-43)
- **Reality:** Holocene's Candybar proxy, the declared template for the v1c module, forwards `Last-Event-ID` only when it matches `^[\w-]{1,64}$` (`candybar.ts:1106`). The spine does not say what `<boot>` looks like. A boot built from an ISO time (`:`) or a `host_id` path (`/`) would be dropped silently, and every reconnect would become a `reset`. Candybar uses `uuid4().hex[:12]` (`stream.py:180`).
- **Fix wording:** "`<boot>` is 12 lowercase hex characters, chosen at service start, and `<seq>` is decimal from 1, so every SSE id matches `^[0-9a-f]{12}-[0-9]+$`."

### M6. `ready` and `reset` do not behave the way Candybar's do (AD-43)
- **Reality:** In Candybar (`stream.py:470-493`, `holocene-view-contract.md:48-59`):
  - `ready` is sent only on a connection without `Last-Event-ID`.
  - An exact resume gets the replay and nothing else.
  - `reset` (with `reason`) goes to a connection that cannot resume.
  - Both carry state (`cut`, `current`).
  - The buffer is 1024 events, and the contract tells clients that number.

  The spine says "`ready` first" unconditionally, gives neither payload, and keeps 512 frames while claiming "the Candybar SSE wire".
- **Fix wording:** "`ready` only on a connection without `Last-Event-ID`. An exact resume sends only the replay, and anything else gets `reset` with `reason: unresumable`. `ready` and `reset` carry `{type, seq, key, at, status: <whole /status>}`. The ring keeps 512 frames, a deliberate departure from Candybar's 1024, and the contract says so." Or use 1024.

### M7. "Pulls the missing range first" names no route (AD-40 vs AD-42, AD-49)
- **Reality:** AD-42 gives the Host Agent only the write routes and `/status`, and AD-49's only message goes from the agent to the API. Nothing defines how the Hub API pulls a range.
- **Fix wording:** Either "the Host Agent serves `POST /agent/sync`, which answers by sending an immediate `/agent/push` from the replica size it is given", added to the AD-42 table, or drop "pulls" and serve `partial: true` with `synced_through`.

## Low

- **L1. Stack row vs AD-35 (Stack: Device transports).** The Stack row lists `host:devices` and `host:track-devices`, while AD-35 uses `host:devices-l`. All of `host:version`, `host:devices`, `host:devices-l` and `host:track-devices` exist (services.md lines 8, 16, 17, 24). `host:track-devices` sends the short form without a model, and `host:track-devices-l` (`adb track-devices -l`) includes it. Fix: make the Stack row repeat AD-35's set exactly, and say which tracker variant is used.
- **L2. `adb -L tcp:127.0.0.1` has no port (AD-35).** adb's socket_spec refuses a `tcp:` spec with no port. Only `localhost` or an empty host counts as a local spec, which auto-starts a server. Fix: write "`adb -L tcp:127.0.0.1:<hub adb server port>`, never `localhost`", as `tools/ci/lib/adb.mjs:75-77` already says. Both clients here speak protocol 41 (`adb version` 1.0.41, 37.0.0), so the version-mismatch kill path, which ignores the spec (sweep 5.4), stays latent.
- **L3. The Node version wording and runtime drift (Stack, AD-45).** The claim is correct: the newest 24.x is v24.22.3 (2026-11-10, Krypton, a security release), 24.x is Maintenance LTS, 26.x is Active LTS, and a v27 alpha exists. But the Stack says ">= 24" while AD-45 asserts ">= 24.15", so make the Stack say >= 24.15. Also, `node/24` is a mise symlink (`24 -> ./24.15.0` on both hosts; the Mac also has `lts -> 24.15.0`). Installing a newer 24.x moves the services' runtime at their next restart, not at `hosts:install`. Either say so or record the resolved node path at install time.
- **L4. `Type=simple` and the `/health` readback race (AD-45).** `systemctl restart` returns at fork, before the bind. Fix: "`hosts.mjs` retries `/health` for at most 10 s within its one invocation." (`Type=notify` is not available here: `node:dgram` has no AF_UNIX datagram socket for `sd_notify`, and the hub takes no dependencies.)
- **L5. The stream's headers (AD-42, AD-43).** "Every response is `Cache-Control: no-store`" is harmless on loopback. The contract should still spell out the `/stream` headers: `Content-Type: text/event-stream`, plus `X-Accel-Buffering: no` as Candybar and Holocene send it. Holocene pings every 15 s itself because the Next rewrite drops a response after 30 s without bytes (`candybar.ts:716-719`). The 30 s parser cap is therefore safe behind Holocene, but it is borderline for any direct client.

## Verified as claimed

- Ports 8794 and 8795 are free on big-chungus (`ss -ltnp`) and on the Mac (`lsof`). The only other mention of either number under `~/docker`, `~/code/33GOD` and the user units is an unrelated gluetun `servers.json`.
- The ssh aliases exist. `hub-mac` is in big-chungus's `~/.ssh/config:48` (ProxyCommand `tailscale nc carries-macbook-air`, ServerAliveInterval 15). `big-chungus` is in the Mac's `~/.ssh/config:5` (`big-chungus.burro-salmon.ts.net`). BatchMode ssh from the Mac to big-chungus works.
- curl is `/usr/bin/curl` on both hosts (8.14.1 and 8.7.1).
- Linger is `yes`, and systemd is 257.
- The launchd keys `KeepAlive`, `RunAtLoad` and `LimitLoadToSessionType` are valid for agents.
- `fs.watch` on directories uses inotify on Linux and FSEvents on macOS (sweep 5.2, fs.md). The spine watches per directory and never uses `recursive`, which is right.
- The adb wire services exist.
- Candybar's `retry: 3000`, `id: <boot>-<seq>`, `: keepalive` and one-line JSON payloads with `type`, `seq`, `key` and `at` match the spine.

Side effects of the probes: the `perl` probe process on the Mac was killed. My timing run used, and refreshed, the Mac's ControlPersist master socket `~/.ssh/cm-delorenj@big-chungus.burro-salmon.ts.net:22`, which expires after 30 min idle.
