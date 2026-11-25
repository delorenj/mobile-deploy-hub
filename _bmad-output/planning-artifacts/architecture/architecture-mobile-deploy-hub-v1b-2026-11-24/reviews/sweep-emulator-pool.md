# Sweep: the emulator pool (v1b grounding)

Scope: `tools/device/emulator.mjs` (638 lines, read in full), `tools/device/emulator.test.mjs` (881 lines, skimmed), the
emulator paths of `tools/device/hub-device.mjs`, and the `tools/ci/lib/lock.mjs` functions the pool calls. Hub v1.2.51, HEAD
`993e2a7`. Every fact below was checked against the current code on 2026-11-24. Host facts come from read-only commands.

Paths are repo-relative. `E` = `tools/device/emulator.mjs`, `HD` = `tools/device/hub-device.mjs`, `L` = `tools/ci/lib/lock.mjs`,
`T` = `tools/device/emulator.test.mjs`.

---

## 0. Module shape

- `E` has no top-level side effects. It only imports and declares. It imports `adbEnv, adbPath` (`tools/ci/lib/adb.mjs`),
  `androidSdk, javaHome` (`tools/ci/lib/android.mjs`), and from `L` `MAX_LEASE_MS, acquireLease, isLease, lockDir, localHost,
  sameHost, poolRequest, processStart, queueView, readOwner, releaseLease, updateLease, withLock` (E:22-27, E:24). It also
  imports `pause` and `sleep` (`tools/ci/lib/pause.mjs`), `createAdbWire` (`./adb-wire.mjs`) and `inventory` (`./inventory.mjs`).
- Exported constants: `GATE = 'emulator'` (E:29), `slotName = k => \`emulator-${k}\`` (E:30), `isEmulatorLock(name)` matching the
  gate or `/^emulator-\d+$/` (E:31), `DEFAULT_POOL = 2` (E:32), `MAX_POOL = 8` (E:33), `PROFILES` (E:42-45), and
  `LEASE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/` (E:336).
- Private constants: `REAPER = 'emulator-reaper'` (E:34), `CONSOLE_PORTS = [5600, 5698]` (E:36), `ADB_SERVER_PORTS = [15000, 15099]` (E:37).
- Error codes set by `E` (`failure(code, message)`, E:47): `HUB_EMULATOR_USAGE`, `HUB_EMULATOR_NO_IMAGE`, `HUB_EMULATOR_NO_PORT`,
  `HUB_EMULATOR_HOST`, `HUB_LOCK_TIMEOUT` and `HUB_LEASE_CANCELLED` (E:52, 57, 69, 100, 126-127, 385, 493, 505, 517, 531).
- CLI exit mapping lives in `HD` `report()` (HD:261-277), not in `E`:
  - `HUB_EMULATOR_USAGE` and `HUB_LEASE_TOO_LONG` exit 2 (HD:264).
  - `HUB_LEASE_CANCELLED` exits 1 and prints `HUB_DEVICE_CANCELLED <device> ...` (HD:266).
  - `HUB_LOCK_TIMEOUT` exits 76 and prints `HUB_DEVICE_BUSY emulator ...` on stderr (HD:274).
  - Everything else exits 1, and for `emulator` only the first line of the message is printed (HD:275-276).
- Log lines (passed to the `log` callback, which goes to stderr in the CLI, HD:810): `HUB_EMULATOR_WAIT` (E:532),
  `HUB_EMULATOR_AVD` (E:565), `HUB_EMULATOR_START` (E:591), `HUB_EMULATOR_READY` (E:623), `HUB_EMULATOR_REAPED` (E:306),
  `HUB_EMULATOR_REAP_FAILED` (E:308) and `HUB_EMULATOR_SIGKILL` (E:178).
- Env knobs read by `E`:
  - `HUB_EMULATOR_POOL` (E:63) and `HUB_LOCK_DIR`, through `lockDir` (L:26).
  - `HUB_EMULATOR_DIR`, through `runtimeRoot` (E:193).
  - `HUB_EMULATOR_CONSOLE_PORTS` (floor 5586) and `HUB_EMULATOR_ADB_PORTS` (floor 1024) (E:461, E:95-102).
  - `HUB_EMULATOR` (the binary, E:582), `HUB_AVDMANAGER` (E:557) and `HUB_ADB` (adb.mjs:12).
  - `ANDROID_HOME`, else `ANDROID_SDK_ROOT`, else `~/Android/Sdk` (android.mjs:18-20). `JAVA_HOME`, else the mise java 17.0.2 (android.mjs:22-26).
  - `TMPDIR` (E:465) and `HOME` (E:48).
- Env knobs that `HD` parses and passes into `provision`, which `E` never reads itself: `HUB_EMULATOR_KILL_GRACE_MS` (default 15000),
  `HUB_EMULATOR_BOOT_TIMEOUT_MS` (360000), `HUB_EMULATOR_POLL_MS` (2000) and `HUB_DEVICE_POLL_MS` (1000) (HD:804-809).

## 1. Pool size precedence

`hostPool(env = process.env)` (E:62-71):

1. `env.HUB_EMULATOR_POOL`, when it is neither `undefined` nor `''` (E:63-65).
2. Otherwise `readFileSync(join(lockDir(env), 'emulator-pool'), 'utf8').trim()` (E:66).
3. Otherwise, on any read failure (missing or unreadable), `return DEFAULT_POOL` (2) (E:66, the `catch`).
4. Validation: `Number(text)` must be a safe integer from 1 to `MAX_POOL` (8). If it is not, `hostPool` throws `HUB_EMULATOR_USAGE`
   with `<source>: the emulator pool is 1 to 8 emulators, not "<text>"` (E:68-69). The CLI exits 2 on that.
   The `DEFAULT_POOL` branch skips validation.

Where a Registry value slots in: it replaces the `catch { return DEFAULT_POOL; }` fallback at E:66, giving
`env > file > Registry > DEFAULT_POOL`. It has to go through the same 1..`MAX_POOL` check at E:68-69, which today only
the env and file values pass. Constraints on that seam:

- `hostPool` takes only `env`. A Registry source needs a new parameter, or `hostPool` must read the Registry file itself. FR-13
  says `hub-device` keeps working when the Hub API is down, so the CLI must read the Registry value from disk directly, not over HTTP.
- `provision()` does NOT call `hostPool`. Its own `pool` option defaults to `DEFAULT_POOL` (E:490). The CLI calls `hostPool` in
  `emulatorOptions` (HD:284) and applies the "`--pool` may only lower" rule (HD:285-289). An API that calls `provision()` directly
  gets a pool of 2 unless it calls `hostPool` itself.
- `MAX_POOL = 8` is a code constant. No Registry value can exceed it without a hub release.
- The env value belongs to each process. An agent shell with `HUB_EMULATOR_POOL=4` and an API unit without it disagree on the
  same lock dir. That is pre-existing for two CLIs, but the API becomes a long-lived second reader.
- Nothing in the code ever writes `emulator-pool`. It is read only (E:66). The only other mentions are README:274 and the tests
  (T:386-393). The file does not exist on big-chungus today (`cat ~/.cache/mobile-deploy-hub/locks/emulator-pool` gives ENOENT),
  so the live pool is 2.
- Slots are probed only for `k = 1..pool` (E:520). A slot above a lowered pool keeps its lease until release or expiry. The
  "full" message lists only 1..pool (E:530). `reap()` covers every record whatever the pool size (E:297).
- Tests pin the rule: file `1` wins over the default, `lots` fails, `--pool 3` above the host's 2 exits 2, and the env wins
  over the file (T:365-401).

## 2. Profiles

- Declared only in code. `PHONE = { api: 36, abi: 'x86_64', width: 1080, height: 2400, density: 420, ram_mb: 2048, cores: 4,
  data_partition: '6G' }` (E:41). `PROFILES = { default: { ...PHONE, tag: 'google_apis' }, playstore: { ...PHONE, tag:
  'google_apis_playstore' } }` (E:42-45).
- `tools/ci/devices.json` has no emulator entries. It holds `android`, `android_extra`, `ios`, `apple`, `mac` and `linux` only.
  `devices.mjs:33-35` only reserves the word `emulator`.
- A profile is a system-image spec plus a hardware spec. It is NOT an AVD name.
  - `resolveImage(profileName, { env, home })` (E:50-58) maps a profile to
    `sysdir = system-images/android-<api>/<tag>/<abi>/` and `package = system-images;android-<api>;<tag>;<abi>`.
  - It requires `source.properties` or `package.xml` under the SDK sysdir (E:56). It never downloads and never falls back.
  - It returns `{ profile, sdk, tag, sysdir, package }`.
  - An unknown name throws `HUB_EMULATOR_USAGE` (E:52). A missing image throws `HUB_EMULATOR_NO_IMAGE`, naming the `sdkmanager`
    command (E:57).
- The AVD is made per Lease. Its name is `hub-<lease_id>` (E:467), in its own AVD home `<runtimeRoot>/<lease_id>/avd` (E:463-471).
  It is built by `avdmanager create avd -n hub-<id> -k <package> --force` (E:558).
- `config.ini` is rewritten from the profile (E:560-564): `image.sysdir.1`, `hw.lcd.width/height/density`, `hw.ramSize`,
  `hw.cpu.ncore` and `disk.dataPartition.size`. The rest is hard-coded and not part of the profile: `hw.gpu.mode=swangle_indirect`,
  cold boot, no frame and `hw.keyboard=yes`.
- The emulator is started with `-memory ram_mb -cores cores` from the profile (E:583).
- How a request selects a profile:
  - The CLI takes `--profile NAME` (default `'default'`) and checks it against `PROFILES` in `emulatorOptions` (HD:282-283).
  - It then passes `profileName` to `provision` (HD:315, HD:707). `provision` defaults `profileName = 'default'` (E:490) and calls
    `resolveImage` before it takes anything (E:494).
- A profile is not bound to a slot. The slot loop has no profile in it (E:520-528), so any free slot serves any profile.
- The profile name and image package are stored in the record (`profile`, `image`, E:469) and in the slot's `owner.json`
  `emulator` summary (`profile`, `image`, E:218-221).
- On big-chungus both images are installed (README:272).
- Tests: the default profile never uses the Play image, `--profile playstore` asks for it (T:234), and a missing image is one
  line before anything is taken (T:255).

Registry implication: a profile is a Capability of an emulator Pool request (FR-6, "the playstore emulator profile"), served by
any slot `emulator-N`. It is not a holdable thing. To make profiles Registry entries, `resolveImage` and `emulatorOptions` must accept
a profile record (api/tag/abi plus hardware) from the Registry instead of the `PROFILES` key lookup. `PROFILES` stays as the
seed, the same way `devices.json` seeds phones.

## 3. Gate, slots, reaper, records

### Gate: the `emulator` lock

- It is a Queued name (`QUEUED = ['adb', 's24', 'mac-ios', 'emulator']`, L:30). Its queue is `<lockDir>/emulator.queue/`.
- `provision` takes it as a Lease (E:503):
  `acquireLease(GATE, { id, holder, why: \`next for an emulator: ${why}\`, forMs: Math.min(MAX_LEASE_MS, waitMs + 600_000),
  waitMs, holderPid: process.pid, env, log, pollMs, sleep, now, signal })`.
- It is FIFO. The head of the line holds it while it probes the slots.
- If the gate times out, the error is rewrapped as `HUB_LOCK_TIMEOUT` `the emulator pool is full, with other requests ahead of <id>
  (...)` (E:505).
- While holding the gate, each round (E:515-534) does the following:
  1. Checks that the gate is still its own. If it is not, it throws `HUB_LEASE_CANCELLED` (E:517).
  2. Runs `reap({ wait: false })` (E:518).
  3. Skips slots that still have a record (`unreaped`, E:519-521).
  4. Tries each slot.
  5. If none is free, throws `HUB_LOCK_TIMEOUT` `the emulator pool is full (<n> of <n>: <holders>); gave up after <s>s` once
     past the deadline (E:531). Otherwise it logs `HUB_EMULATOR_WAIT` once and pauses `pollMs`.
- The gate is let go in `finally` right after `claim()` (E:541). It is held only until the ports and record are claimed, never
  through the boot.

### Slots: `emulator-1` .. `emulator-<pool>`

- They are Queued through `isQueued`'s regex `/^emulator-\d+$/` (L:31).
- Each probe is a try (E:523):
  `acquireLease(slotName(k), { id, holder, why, forMs: Math.min(MAX_LEASE_MS, bootTimeoutMs + forMs + 120_000), waitMs: 0,
  holderPid: process.pid, ..., pool: request.tag })`.
- `waitMs: 0` means no ticket and no event unless it acquires (L:1152-1158, T:835-860).
- The probe keeps `lock_ino` from the returned record (E:523), so later rewrites check the inode (AD-16).
- On READY the slot's `owner.json` is rewritten through `updateLease` (E:615-622). The rewrite sets:
  - `holder_pid` to the caller's `holderPid`, or null, meaning "until release or expiry".
  - `holder_process_start`.
  - `expires_at = min(now + forMs, current expiry)`, so `--for` runs from READY (T:789-805).
  - The `emulator` summary.

### Reaper: the `emulator-reaper` lock

- It is not Queued. `withLock('emulator-reaper')` takes the bare mkdir path and writes no events (L:28-29, L:233, L:186).
- `reap({ env, log, graceMs, sleep, now = Date.now, wait = true })` (E:296-318):
  - It lists the records whose `doomed()` verdict is non-null (E:297). If there are none, it returns `[]` and takes no lock (E:298).
  - Otherwise it runs `withLock(REAPER, ..., { timeoutMs: wait ? 120_000 : 0, pollMs: 200 })` (E:300-313).
  - With `wait: false`, a busy reaper lock returns `[]` (E:315).
- Each victim gets `teardown()`. On success that is followed by
  `releaseLease(record.slot, record.lease_id, { reason: \`reaped-${why}\` })`, which gives `reaped-orphaned`, `reaped-expired` or
  `reaped-holder-gone` (E:303-306).
- `underReaper(id, fn, env)` (E:339-346) runs release and failure teardowns under the same lock (120 s).
- `doomed(record, owner, now)` (E:278-290):
  - Returns null for a record that is not on this host. It checks `sameHost(record, localHost())`, and a pool record has no
    `host_id`, so the hostname decides (E:279-282).
  - Returns `'orphaned'` when the slot owner is not a Lease or has another `lease_id` (E:283).
  - Returns `'expired'` (E:284).
  - Returns `'holder gone'` when the owner's `holder_pid` is dead or now another process (E:285-288).
  - It does NOT check whether the emulator's own pids are alive. A Lease whose emulator crashed after READY keeps its slot
    until expiry or release.
- Callers of `reap`:
  - `HD` `reapBeforeAcquire` before every `lease emulator` and `run emulator` (HD:298-300, HD:314, HD:706). It turns failures
    into a warning.
  - `provision`'s gate loop (E:518).
  - Never `status` (AD-9, HD header :15-16, T:652). README:275 still says "`status` included", which is stale since MOBI-26
    (`e6f02cc`).

### Records under `<lockDir>/emulators/`

- `recordsDir = <lockDir>/emulators` (E:191). `recordPath = <lockDir>/emulators/<lease_id>.json` (E:192).
- Written by tmp+rename: `<path>.<pid>.tmp` (E:197-202).
- The `listRecords` filename filter is `/^[a-z0-9][a-z0-9-]*\.json$/` (E:213).
- `readRecord` accepts a record only when `record.lease_id === id` and `pids` is an array (E:204-209).
- Record body, written by `claim()` (E:468-475):
  - `schema: 1`. Note that this is `schema`, not the `format` key that AD-2 puts on new records.
  - `lease_id`, `marker: '<id>.<16 hex>'`, `slot`, `host` (hostname, no `host_id`), `profile`, `image`, `serial: 'emulator-<console>'`.
  - `console_port`, `adb_port` (console+1), `adb_server_port`.
  - `dir` (`<runtimeRoot>/<id>`) and `tmp` (`$TMPDIR/hub-emu-XXXXXX`).
  - `avd: { name, home, ini, dir }`, `pids: []`, `created_at`, and `lock_ino` when known.
- `pids[]` entries are `{ pid, start, role: 'adb-server'|'emulator'|'helper', program }` (E:570, E:589, E:593).
- The slot's `owner.json` gets the `emulator` summary: `{ profile, image, serial, console_port, adb_port, adb_server_port,
  avd: <name>, pids }` (E:218-221).
- The runtime tree is outside the lock dir: `runtimeRoot = HUB_EMULATOR_DIR || join(dirname(lockDir), 'emulators')` (E:193).
  By default that is `~/.cache/mobile-deploy-hub/emulators/<id>/`, holding `avd/`, `adb-server.log` and `emulator.log`
  (E:463-464, E:569, E:588).
- On big-chungus now: `~/.cache/mobile-deploy-hub/locks/emulators/` and `~/.cache/mobile-deploy-hub/emulators/` are both empty.
  `locks/emulator.queue/` exists, and so does an empty leftover `locks/emulator-1.queue/` (dated Nov 12, from before MOBI-31, when
  probes still queued).

### Ports

- `choosePorts()` (E:107-129) picks an even console port in 5600-5698 with console+1 free, never 5554, and an adb-server port in
  15000-15099, never 5037.
- It avoids ports that are in use (`/proc/net/tcp*`, E:76-91), ports claimed in records, and ports of emulators or adb servers
  that `inventory()` sees (E:456-462).
- It is called inside `claim()` while the gate is held (E:453-454), so two Leases never pick the same ports.

## 4. Process start, ownership, survival; systemd implications

- `launch(command, args, env, logFile)` (E:418-429) runs
  `spawn(command, args, { env, detached: true, stdio: ['ignore', out, out] })` and then `child.unref()`. The pid is resolved once
  the child emits `spawn`.
  - `detached: true` on POSIX means the child calls `setsid()`: a new session and process group, no controlling terminal. The
    header comment calls this "its own session (a terminal's ^C never reaches it)" (E:416-417).
  - stdout and stderr go to the log files. The parent closes its fd at once (E:421).
  - `unref()` means the Node parent never waits for it and can exit while it runs.
- Two long-lived processes are launched per Lease:
  - The adb server: `adb -L tcp:localhost:<adb_server_port> server nodaemon` (E:569).
  - The emulator: `-avd hub-<id> -port <console> -no-window -no-audio -gpu swangle_indirect -no-snapshot -wipe-data
    -no-boot-anim -no-metrics -memory <ram> -cores <n>` (E:583, E:588).
  - Helpers that the emulator daemonizes (crashpad_handler, netsimd) are found by `markedProcesses(record.marker)`, which reads
    every `/proc/<pid>/environ` for `HUB_EMULATOR_LEASE=<marker>` (E:148-166). They are added to the record during boot and at
    teardown (E:593, 598, 614, 250-258).
- Environment of those processes (E:544-549, E:586-587):
  - The caller's env minus credential variables (`adbEnv`, adb.mjs:69-73).
  - `ANDROID_SDK_ROOT`, `ANDROID_HOME`, `ANDROID_AVD_HOME`, `ANDROID_ADB_SERVER_PORT`.
  - `ADB_LOCAL_TRANSPORT_MAX_PORT=5553`, `ADB_MDNS=0`, `ADB_MDNS_AUTO_CONNECT=0`, `ADB_USB=0`.
  - `HUB_MANAGED=1`, `HUB_EMULATOR_LEASE=<marker>`, and `RUNNER_TRACKING_ID=''`. The blank tracking id means the GitHub runner's
    orphan cleanup skips them.
  - `ANDROID_SERIAL`, `ADB_SERVER_SOCKET` and `ANDROID_ADB_SERVER_ADDRESS` are deleted.
  - For the emulator only: `TMPDIR=<tmp>`, `XDG_RUNTIME_DIR=<tmp>/run`, and `DISPLAY`, `WAYLAND_DISPLAY`, `XAUTHORITY` deleted.
    It needs no GUI session, which suits a systemd user service.
- Who owns them:
  - The OS parent is the process that called `provision`. When that process exits, the children are reparented to the nearest
    child subreaper. That is the systemd user manager for user units and panes; for the runner, whichever subreaper sits above it.
  - Nothing in `E` kills them when the starter exits. They keep running.
  - The hub-level owner is the record plus the slot Lease. Teardown is only by recorded pid plus start time
    (`stopProcesses`, E:170-182). It never uses a name, a pattern or a process group (E:9-10, T:573).
- What happens when the starter exits:
  - `hub-device lease emulator` returns after READY and the CLI exits. The emulator keeps running (T:169, in-process `main()`;
    the fakes outlive it).
  - With `holderPid` null the Lease lives until release or expiry. With `--pid N` it lives until that process is gone, and the
    next acquire reaps it as `holder gone` (T:320-363).
  - `hub-device run emulator` registers `signals.once('exit', lastResort)`, which SIGKILLs the recorded pids
    (`teardownNow`, E:268-274) and frees the slot (HD:700-704, HD:732-735). Its `finally` calls `releaseEmulator` (HD:720-726).
    `lease emulator` registers no exit handler.
  - If the starter dies before READY, the slot's `holder_pid` is still the starter's pid (E:523), so the next acquire's reap
    tears it down as `holder gone`. Teardown rescans the marker, so even helpers that were never recorded are found.
  - A SIGTERM handled as an abort `signal` makes `provision`'s `catch` tear down whatever it started (E:625-631, T:497-518).
- Implications for a long-lived Hub API under systemd (FR-23: "emulators the API started keep running across its restart"):
  1. `setsid` does not leave the cgroup. With systemd's default `KillMode=control-group`, and with `mixed`, a stop or restart
     of the API unit SIGKILLs every process in the unit's cgroup, emulators included. FR-23 needs `KillMode=process` on the
     API unit, or the emulators must be launched into their own cgroup.
     - Precedent: `tools/catchup/units/mobile-deploy-hub-catchup.service:15-17` ("An adb server the pass starts must outlive
       it" then `KillMode=process`). The runner system units are also `KillMode=process`, `User=delorenj` (checked with
       `systemctl show actions.runner.AutomaticAI-io.delonet-r1.service`).
     - The own-cgroup alternative is `systemd-run --user --scope --slice=batch.slice`, which `~/.local/bin/heavy` already uses
       (heavy:40-46). README:276 already recommends `heavy hub-device run emulator`.
  2. With `KillMode=process`, emulators stay in the API unit's cgroup after a restart. systemd logs the left-over processes, and
     any `MemoryMax`, `CPUQuota` or `TasksMax` on the API unit counts the emulators (2 GB RAM each, E:41). The emulators would
     also sit outside `batch.slice`, at full CPU weight.
  3. For a READY emulator to survive, the API must call `provision({ holderPid: null })`. FR-10 says an API Lease "has no
     process". Mid-boot, the slot is tied to the API's pid (E:523), so a restart during boot gets it reaped. That matches
     FR-23's "a request waiting in line through the API is tied to the API's process; a restart drops it".
  4. `markedProcesses` and `liveStart` read `/proc/<pid>/environ` and `/proc/<pid>/stat`. `environ` is readable only by the
     same uid, so the API must run as the same user as every emulator starter (delorenj, like the runners and panes). If it
     cannot read a helper's environ, that helper is silently left out (E:156).
  5. Node's libuv reaps exited children the API spawned. `liveStart` treats a zombie (`Z`/`X`) as gone in any case (E:139).
  6. All pool state is on disk (records plus slot locks). An API restart rebuilds its view from `listRecords` and `listLocks`.
     No in-memory registry of emulators is needed or allowed.
  7. The `/proc` scans block the event loop. Measured read-only on big-chungus with 2868 processes: `inventory({})` took
     126 ms and `markedProcesses(...)` took 50 ms. `markedProcesses` runs every boot poll (2 s) for each booting Lease
     (E:593-598), and `claim()` runs `inventory()` (E:456). Inside an always-on API that streams SSE and promises a status read
     under 200 ms (NFR-7), these block every other request while they run. `emulatorStatus()` is cheap: it reads only
     `/proc/<pid>/stat` of the recorded pids (E:367-373). `hub-device status` also runs `inventory()`, a full scan (HD:605).

## 5. What an API calls to lease and release, and whether it can import it

Everything needed is exported from `E` and has no CLI coupling (E:17-27):

- `provision({ id, holder, why, forMs, waitMs = 120_000, holderPid = null, profileName = 'default', pool = DEFAULT_POOL, env,
  log, signal, sleep, now, pollMs = 1000, graceMs = 15_000, bootTimeoutMs = 360_000, bootPollMs = 2000 })`
  returns `Promise<{ lease: <slot owner.json>, record }>` (E:489-492, E:624).
  - It resolves only after `sys.boot_completed=1`, which takes up to `bootTimeoutMs` plus the wait.
  - It is Linux only (E:493).
  - **`id` is required in practice.** `poolRequest` mints its own id when `id` is undefined (L:923), and `acquireLease(GATE)`
    mints a different one (L:1148). The check `readOwnerOf(GATE)?.lease_id !== id` at E:517 then always fails, and the call
    throws `HUB_LEASE_CANCELLED`. The CLI always mints one: `e-<12 hex>` (HD:307) or `run-<pid>-<8 hex>` (HD:687). The id must
    match `/^[a-z0-9][a-z0-9-]{0,63}$/` (L:330).
- `releaseEmulator(id, { env, log, graceMs, sleep, now })` returns `{ outcome: 'released'|'cancelled'|'none'|'stuck', slot,
  record, result }` (E:351-364).
  - It refuses a non-`LEASE_ID` id with `HUB_EMULATOR_USAGE` (E:352).
  - A waiter is cancelled through `releaseLease(GATE, id)` (E:353). The slot lease is released first (E:359), then the processes
    are torn down under the reaper lock (E:361).
  - There is no holder check: any process with the id can release. `releaseLease` is called with no `reason`, so the event
    reason is `by-id` (L:1313).
  - There is no option for a `force-release` event or for who and why.
  - A teardown can take a long time: up to 3 x `stopProcesses` phases (15 s grace + 5 s settle each, E:176-181, E:252-258),
    plus up to 120 s waiting for the reaper lock (E:341).
- Read side: `emulatorStatus(env)` (E:367-373, fields `lease_id, slot, profile, serial, console_port, adb_server_port, avd,
  created_at, pids[{pid,start,role,program,alive}]`), `listRecords(env)`, `readRecord(env, id)`, `isEmulatorLease(env, id)`
  (E:329-334, which already reads gate waiters through `queueView(GATE, { includeStale: true })`, so the AD-1 item is done),
  `hostPool(env)`, `resolveImage(name, { env })`, and `exportsOf(record, envSerial)`, which returns `{ HUB_LEASE_ID,
  ANDROID_ADB_SERVER_PORT, ANDROID_SERIAL, ...envSerial }` (E:634-638).
- Maintenance: `reap(...)`, `teardown(record, ...)`, `teardownNow(record, ...)`, `doomed(record, owner, now)`, `stopProcesses`,
  `stopProcessesNow`, `markedProcesses`, `liveStart`, `choosePorts`, `portsInUse`, `listenerOwnedBy`, `runtimeRoot`.
- Not exported: `claim`, `launch`, `runTool`, `slotHolding`, `summary`, `writeRecord`, `recordPids`, `removeFiles`, `rewritten`,
  `configure`, `underReaper`, `REAPER`, `CONSOLE_PORTS`, `ADB_SERVER_PORTS`.
- Logic that lives only in `HD`, is not exported, and an API would otherwise copy:
  - `emulatorOptions`: the profile check plus the `--pool` only-lowers rule (HD:280-290).
  - `setup()`'s `--id` uniqueness check across phone locks, phone queues and `isEmulatorLease` (HD:137-144).
  - The `forMs` bounds check (HD:149) and the `waitMs` default of 120 s (HD:158).
  - The holder default `${USER}@${hostname()}` (HD:306).
  - Id minting (HD:307).
  - `reapBeforeAcquire`, which turns reap failures into warnings (HD:298-300).
  - The `--json` Lease shape `{ lease_id, device: 'emulator', profile, image, slot, holder, why, expires_at, env, emulator:
    { serial, console_port, adb_port, adb_server_port, avd, pids } }` (HD:321-323).
  - The release-outcome lines `HUB_DEVICE_RELEASED|CANCELLED|NOT_HELD emulator <id>` (HD:367-385).
  - The exit-code mapping (HD:261-277), and the timing env parsing (HD:804-809).
  FR-21 and FR-22 (same refusals, same exit codes 75/76/2) mean these must be extracted and shared, not re-implemented.
- `HD` itself is importable: `main` runs only when `entry === import.meta.url` (HD:830-835), and the tests import `main`
  (T:18). Its internals are not exported.
- Test seams are env-var binaries, not injected functions:
  - `HUB_EMULATOR`, `HUB_AVDMANAGER` and `HUB_ADB` point at fakes that are real processes (T:26-106).
  - The fixture sets `HUB_LOCK_DIR`, `HUB_EVENT_DIR`, `HUB_EMULATOR_DIR`, `TMPDIR` and `HUB_EMULATOR_ADB_PORTS=25000-25099` (T:125-130).
  - `provision` takes no injected `inventory` or `procRoot`. `claim()` calls the real `inventory()` over `/proc` (E:456),
    read-only, even though the fixture passes a fake `inventory` to `main` (T:134).

## 6. Event writes (AD-4)

`E` never calls `appendEvent`. Every event comes from `L`. Sequence for one successful Lease (pool=1, `--wait` > 0), pinned by
T:809-833:

1. Pool-level `request`: `lock: null, pool: 'emulator', request: <id>, lease_id: <id>, for_ms, deadline_at`. Written by
   `poolRequest('emulator', ...)` (E:500, L:923-933).
2. `request` on lock `emulator` (the gate), from `acquireLease`. Only when `waitMs > 0` (L:1168).
3. `acquire` on `emulator` (L:1238).
4. `acquire` on `emulator-<k>` with `pool: 'emulator', request: <id>` and `waited_ms` counted from the Pool request's `since`
   (L:1236-1238, E:523 `pool: request.tag`).
5. `release` on `emulator`, reason `by-id`, when the gate is let go after `claim` (E:541).
6. Later, `release` on `emulator-<k>`:
   - reason `by-id` from `releaseEmulator` (E:359);
   - `reaped-expired|reaped-orphaned|reaped-holder-gone` from `reap` (E:305);
   - `by-id` from `provision`'s failure path (E:629).

Other sequences:

- Pool full with `--wait 0`: Pool `request`, gate `acquire` (a try, so no gate `request`), Pool `timeout` (reason `deadline`,
  `blocked_by` containing "the emulator pool is full"), then gate `release`. The failed slot try writes nothing and leaves no
  ticket (T:835-860, E:531, E:538, L:944-946).
- Cancelled while queued on the gate: `releaseLease(GATE, id)` writes gate `cancel` with reason `released` (L:1298). The waiter
  gets `HUB_LEASE_CANCELLED`, and `request.settle` writes Pool `cancel` with reason `released` (E:506, L:949). An abort gives Pool
  `cancel` with reason `aborted`.
- A boot that fails after the slot was taken: the Pool already has its `acquire`. The slot `release` says `by-id` (E:629), so in
  the Event Log a failed boot looks the same as a short successful hold.
- `emulator-reaper` writes no events (L:28-29, L:134-136).
- Every emulator event has `hold_kind: 'lease'` and `claimant.kind: 'agent'` (T:826). `eventOf` hard-codes `'agent'` for any
  Lease (L:113, "v1a has no person surface", L:104-106).

## 7. Writes outside `lock.mjs` (AD-1)

Writes made by `E` itself, none of them under `<name>.lock`, `<name>.queue/` or `<name>.reservations/`:

- `<lockDir>/emulators/` (mkdir), `<id>.json`, `<id>.json.<pid>.tmp` (rename), and their removal (E:197-202, E:263, E:272, E:479).
  AD-1 allows these.
- `<runtimeRoot>/<id>/` and `avd/` (mkdir), the `avd/hub-<id>.ini` and `.avd/` that avdmanager creates, the `config.ini` rewrite,
  and the `adb-server.log` and `emulator.log` appends. All are removed by `removeFiles` (E:463-464, E:443-451, E:560, E:419,
  E:235-245).
  - With the default `runtimeRoot` this tree is outside the lock dir (`dirname(lockDir)/emulators`, E:193). AD-1 names only
    `emulators/` "and `emulator-pool`" and is silent on this sibling tree.
- `$TMPDIR/hub-emu-XXXXXX/` and `run/` at mode 0700 (E:465-466). Removed by `removeFiles` (E:244).
- Process signals: `process.kill(pid, SIGTERM|SIGKILL)` on recorded and marked pids only (E:173, E:186).
- `emulator-pool` is never written by any code. It is read only (E:66).

Reads that touch the protocol layout directly (AD-1 says to read through `listLocks`, `queueView` and `listReservations`):

- `readOwnerOf(name) = readOwner(join(lockDir(env), \`${name}.lock\`))` (E:195). It uses the exported `readOwner`, but builds the
  `.lock` path itself.
- `slotHolding()` calls `readdirSync(lockDir)` and filters `/^emulator-\d+\.lock$/` (E:321-326). That parses the lock-dir
  listing directly instead of going through `listLocks`. It is a minor AD-1 deviation and read only.

Every lock-dir mutation goes through exported `L` functions: `acquireLease`, `releaseLease`, `updateLease` (through `rewritten`,
E:390-395) and `withLock`.

## 8. Other cross-cutting findings for v1b

- **Extension (FR-10, FR-31)**: `E` has no extend path, and no `HD` verb calls `extendLease`. `grep extendLease tools` finds only
  its definition (L:1348).
  - `extendLease(slotName(k), id, { forMs, ino: record.lock_ino })` works mechanically. Its "nobody waits" check, though, reads
    `queueView(<slot>)` (L:1356). Slot probes are tries and write no tickets, so the slot queue is always empty, while emulator
    waiters actually wait in the `emulator` gate queue.
  - Read literally, FR-31 for an emulator would allow an extension while others wait for the Pool.
- **Force-release (FR-11)**: `force-release` is in `LEASE_EVENTS` and `LEASE_ENDS` (L:1379-1380) and in eta's `ENDS`
  (eta.mjs:22), but no code writes it. `releaseLease` always writes `release` (L:1312-1313). An emulator force-release has to
  run `releaseEmulator`'s teardown, since a bare slot release only leaves an `orphaned` record for the next reap. It also needs
  a new `as` or `reason` pass-through in both `releaseLease` and `releaseEmulator`.
- **Dead emulator, live Lease**: `doomed` ignores pid liveness (E:278-290). For FR-5, emulator-slot Reachability can be derived
  from `emulatorStatus()[].pids[].alive`, and from `resolveImage` succeeding for a profile.
- **Expired emulators keep running until the next emulator acquire** (no clock, AD-19). An always-on API must not add a timer.
  If a periodic reap is wanted, it is a Candybar job that runs `reap()`. The API's status endpoint must not reap (AD-9 read-only
  status, T:652).
- **Discovery (FR-4)**: pool emulators never appear on the hub's 5037 server. Their own adb server runs with
  `ADB_LOCAL_TRANSPORT_MAX_PORT=5553` and mDNS and USB off, and their console ports start at 5600, outside 5555-5585
  (E:35-37, E:546-547). A foreign emulator on 5554 would show on 5037 as `emulator-5554`. `inventory()` marks processes
  `managed` (via `HUB_MANAGED=1` or `<lockDir>/managed.json`) or `foreign` (inventory.mjs:38-60).
- **Pool ETA**: `status` computes gate waiters' ETAs from the `emulator` lock's own past holds (HD:583-596 with `waiterEtas`),
  that is, the gate holds (head-of-line waits). It does not use slot holds.
- **Stale copies**: `.worktrees/towe-76-all-target/` and `.worktrees/tolt-76-strict-policy-20261115/` contain older copies of
  `emulator.mjs`, `hub-device.mjs` and README. The directory is gitignored (`~/.agents/git/ignore:96`), but grep finds them.
- **Version skew**: `install.sh` points `~/.local/bin/hub-device` at a release-pinned copy (tools/catchup/units/install.sh:36-42).
  An API that runs `current` and CLIs that run older releases read and write the same `emulators/*.json` records (`schema: 1`)
  and slot locks, so any record change must be additive.
