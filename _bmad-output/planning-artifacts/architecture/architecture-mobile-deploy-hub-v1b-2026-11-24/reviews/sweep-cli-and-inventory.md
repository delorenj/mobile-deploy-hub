# Sweep: the hub-device CLI and the device inventory (v1b grounding)

Scope: `tools/device/hub-device.mjs` (835 lines), `tools/device/inventory.mjs`, `tools/device/adb-wire.mjs`,
`tools/device/async-adb.mjs`, `tools/ci/lib/devices.mjs`, `tools/ci/devices.json`, `tools/ci/lib/adb.mjs` (findPhone),
`tools/ci/commands/gate.mjs` (quickS26), the relevant parts of `tools/ci/lib/lock.mjs` and `tools/device/emulator.mjs`,
`tools/catchup/units/install.sh`, `tools/hosts.mjs`, and `tools/device/hub-device.test.mjs`.
Hub at v1.2.51 (HEAD 993e2a7). Everything below was read from the current tree on 2026-11-24. No code was changed. The only
commands run were reads. `hub-device status --json` was run once with `HUB_ADB=/bin/false`, so no adb client ran.

Note on the task's line hints: the `android_extra` guard is at `hub-device.test.mjs:421-432`, not :332-343. :334-362 is the
BUSY/AWAY `phone` test. The install.sh / daemon-reload test is at `:1262-1295`, not :909-941. :909-927 is the old-hub
warning and :929-940 is EPIPE.

---

## 1. Verbs, flags, exit codes, HUB_DEVICE_* lines

### Verbs (dispatch `hub-device.mjs:817-824`)
| verb | handler | notes |
|---|---|---|
| `lease s24\|s26\|phone` | `lease` `:334-362` | `phone` -> `takeAnyPhone`; named -> `takeLease` (`:347`) |
| `lease emulator` | `leaseEmulator` `:302-332` | `--profile default\|playstore`, `--pool N` (may only lower `hostPool`) `:280-290` |
| `release [<id>\|--any]` | `release` `:410-507` | no id: `$HUB_LEASE_ID` (`:436,440`); `job:` id -> exit 2 (`:415-423`) |
| `release emulator [<id>]` | `:426-433` -> `releaseEmulatorCommand` `:367-385` | `--any` refused, id must match `LEASE_ID` (`emulator.mjs:336`) |
| `status [--json]` | `status` `:554-679` | read only (FR-13) |
| `reservation release --run <key> [--name adb\|mac-ios] [--json]` | `reservationCommand` `:391-408` | `RUN_KEY = /^[A-Za-z0-9][A-Za-z0-9-]*--[A-Za-z0-9._-]+--\d{1,20}$/` `:390`. Always exits 0. |
| `run s24\|s26\|phone -- <cmd>` | `runCommand` `:738-790` | default `--for` 1h (`:148`), `why` defaults to `run <cmd>` sliced to 80 chars (`:156`), `holderPid` defaults to `process.pid` (`:762`) |
| `run emulator -- <cmd>` | `runEmulator` `:682-730` | tears down on every exit path |
| anything else | `usage(USAGE)` `:823` | exit 2. USAGE text is at `:114`. |

There is **no `extend` verb** and **no `lease ipad|mac`**. `extendLease` is not imported (`:45`). The v1a spine defers both
to v1b (ARCHITECTURE-SPINE.md:471,474).

### Flags (`parseArgs` `:92-109`)
- Value flags `VALUE_FLAGS` `:88`: `for, why, wait, id, pid, holder, env-serial (repeatable, must match /^[A-Za-z_][A-Za-z0-9_]*$/ :104), profile, pool, run, name`.
- Switches `SWITCHES` `:89`: `no-connect, json, verbose, any`.
- Both `--flag value` and `--flag=value` work. Everything after `--` is the command (`:96`).
- `--run` and `--name` are refused on every verb except `reservation`, as unknown flags (`:814`).
- Durations (`parseDuration` `:80-86`): plain seconds, or a run of `\d+[dhms]`.
- Defaults: `--wait` 120 000 ms (`:158`). `--for` is required for `lease`. `run` defaults to 3 600 000 ms.
- `--for` must be > 0 and <= `MAX_LEASE_MS` = 48 h (`lock.mjs:328`; check `:149`).
- A deploy-target phone (`adb`) over the cap from `deployTargetCapMs` is a usage error that prints `capText` (`:152-155`). `policy.json queue.deploy_target_lease_max_min` = 60.
- `phone` skips the deploy phone when `--for` is over the cap. If that leaves no phone, it is a usage error (`:154-155`).
- `--id` uniqueness: a usage error if any fleet lock's owner or queue (stale tickets included), or any emulator lease, already uses that id (`:137-144`).
- `--pid` must be a positive safe integer (`:159-160`).
- Holder: `--holder`, else `$HUB_DEVICE_HOLDER`, else `${USER}@${hostname()}` (`:338`, `:306`, `:744`).

### Exit codes (`report` `:261-277`, header `:33-35`)
- `0`: done. `release` exits 0 on NOT_HELD and on CANCELLED. `reservation release` always exits 0.
- `1`: `HUB_LEASE_CANCELLED` (`:266`), any other error (`:275-276`), `release` `unknown-holder` / `changed` / an `--any` refusal (`:474-479,504`), a stuck emulator teardown (`:382-383`). `HUB_LEASE_EXTEND_REFUSED`, `HUB_LEASE_LOST`, `HUB_EMULATOR_NO_IMAGE` and `HUB_EMULATOR_HOST` all fall through to 1.
- `2`: a `Usage` error, `HUB_EMULATOR_USAGE`, or `HUB_LEASE_TOO_LONG` (`:264`). A `release` of a `job:` id (`:422`). `release` with no id and no `$HUB_LEASE_ID` (`:441`).
- `75`: away (`error.code === 'HUB_PHONE_AWAY'`, `:112,267-273`).
- `76`: `HUB_LOCK_TIMEOUT` (`:274`).
- `run`: the child's own code. A spawn error is `127` (`:712,778`). A signal is `128+N` (`:713,779`). A signal during the lease is also 128+N (`:318,350,708,770`).

### Lines on stdout and stderr
- stdout `HUB_DEVICE_AWAY <device>` (exactly this line, `:268`). On stderr: `hub-device: <device> is away: <reason>` (`:270`). With `--verbose`, a detail line follows (`:271`).
- stderr `HUB_DEVICE_BUSY <device> <message>` (`:274`). The message for `phone` is `every phone is held: s24 (s24) is held by ...; ...` (`:206-207`).
- stderr `HUB_DEVICE_CANCELLED <device> <message>` (lease/run, `:266`).
- stdout `HUB_DEVICE_RELEASED <device> <lease_id>` (`:468,489`) and `HUB_DEVICE_RELEASED emulator <id>` (`:372`).
- stdout `HUB_DEVICE_CANCELLED <device> <id> (it was still waiting)` (`:463`) and `HUB_DEVICE_CANCELLED emulator <id> (it was still waiting)` (`:376`).
- stdout `HUB_DEVICE_NOT_HELD phone <id> (no phone lease by that id)` (`:451`), `HUB_DEVICE_NOT_HELD phone <id>` (job holds it, `:471`), `HUB_DEVICE_NOT_HELD phone - (no phone is held)` (`:505`), `HUB_DEVICE_NOT_HELD emulator <id> (no emulator lease by that id)` (`:379`).
- stderr `HUB_DEVICE_JOB_ID <id> is a deploy job's place in line, not a lease; <what>`. `<what>` is `cancel run N of R instead (gh run cancel N --repo R)`, or `it is the local process P, stop that process instead` (`:416-421`).
- stdout `HUB_DEVICE_RESERVATION_NONE <key>` and `HUB_DEVICE_RESERVATION_RELEASED <name> <key>` (`:405-406`).
- A successful `lease` prints only `export NAME='value'` lines (`:354`, `:324`). Phone exports (`exportsOf` `:251-259`): `HUB_LEASE_ID`, `HUB_DEVICE`, `ANDROID_ADB_SERVER_PORT`, and, only when it connected, `ANDROID_SERIAL` plus every `--env-serial` name. Emulator exports (`emulator.mjs:634-638`): `HUB_LEASE_ID`, `ANDROID_ADB_SERVER_PORT`, `ANDROID_SERIAL`, plus `--env-serial`. There is no `HUB_DEVICE`.
- `lease --json`: phone `{lease_id, device, holder, why, expires_at, env}` (`:353`). Emulator `{lease_id, device:'emulator', profile, image, slot, holder, why, expires_at, env, emulator:{serial, console_port, adb_port, adb_server_port, avd, pids}}` (`:323`).
- `reservation release --json`: `{run, released:[{name, key}]}` (`:404`).
- Log lines go to stderr through `context.log` (`:810`): `HUB_LEASE <name> <id> until <ts>` (`lock.mjs:1240`), `HUB_LOCK_WAIT ...` and `HUB_LOCK_RECLAIMED`, and from findPhone with label `HUB_PHONE` (`:178`): `HUB_PHONE_ADB_RETRY`, `HUB_PHONE <model> serial=.. adb=..`, `HUB_PHONE_CONNECT <endpoint>` (`adb.mjs:154,167,175`).
- `leaseSupport` (`:118-123`) warns on stderr when `~/.local/share/mobile-deploy-hub/current/tools/ci/lib/lock.mjs` lacks `export async function acquireLease` (`$HUB_DEVICE_HOME` overrides home): `hub-device: warning: the installed catch-up hub (...) predates leases ...` (`:127`).
- EPIPE on stdout exits quietly (`:833`).

### Env knobs read by hub-device (`main` `:804-810`)
`HUB_DEVICE_POLL_MS` (lease poll 1000, phone poll 3000), `HUB_DEVICE_PHONE_SLICE_MS` (10 000, `:222`),
`HUB_ADB_SERVER_PORT` (5037), `HUB_EMULATOR_KILL_GRACE_MS` (15 000), `HUB_EMULATOR_BOOT_TIMEOUT_MS` (360 000),
`HUB_EMULATOR_POLL_MS` (2000), `HUB_DEVICE_KILL_GRACE_MS` (10 000), `HUB_DEVICE_HOLDER`, `HUB_LEASE_ID`, `HUB_DEVICES`
(devices.json path, `devices.mjs:64`), `HUB_DEVICE_HOME`, and indirectly `HUB_LOCK_DIR`, `HUB_EVENT_DIR`, `HUB_ADB`,
`HUB_EMULATOR_POOL`, `HUB_EMULATOR_DIR` and `GITHUB_*` (lock.mjs).

---

## 2. The exact `status --json` shape (`status` `:554-679`; `result` at `:623`)

Top level: `{ phones, locks, waiters, reservations, inventory, emulators }`. This was confirmed against the live wrapper
v1.2.51 with `HUB_ADB=/bin/false`. JSON is printed with 2-space indentation (`:624`).

- **phones[]** (`:607-616`), one per fleet entry in fleet order: `device, lock, deploy, name, model, serial, held ('free' | 'lease' | 'lock'), holder, lease_id, why, expires_at, adb_id, repo, run, presence`.
- **locks[]** (`:558-568`), from `listLocks` (every `*.lock` dir in the lock dir, sorted): `lock, device (nameOf: fleet word, 'emulator' for the gate and slots, else null), kind ('lease' | 'lock'), stale, lease_id, holder, why, repo, run, pid, holder_pid, started_at, expires_at, phone (= owner.device {phone, serial, adb_id, adb_port}), emulator (= owner.emulator)`.
- **waiters[]** (`:593-596`, v1a Story 4.3): `lock, device, position (1-based, Reservations not counted), lease_id, holder, why, since (= enqueued_at), stale, kind ('lease' | 'job' | 'hub-job'), repo, run, job, eta`. `eta` is `{lo_ms, hi_ms (may be null), low_data}` (`eta.mjs:152`), or null when the waiter is stale or the ETA failed (`:571-591`).
- **reservations[]** (`:599-602`, v1a): `lock, device, run_key, repo, run, place, blocking, grace {state: 'pending' | 'running' | 'over', started_at, ends_at}, reserved_at, expires_at, stale`.
- **inventory** (`inventory.mjs:81`): `{adb_servers:[{port, pid, managed, cwd}], emulators:[{avd, console_port, adb_server, pid, managed, cwd}], xvfb:[{display, pid, managed, cwd}]}`. Items that the pool's own records own also get `lease_id` added, with `managed: true` (`:618-622`).
- **emulators[]** (`emulator.mjs:367-373`): `lease_id, slot, profile, serial, console_port, adb_server_port, avd, created_at, pids:[{...entry, alive}]`.

Lock names walked for waiters and reservations (`:583`): the union of the fleet locks, `GATE` ('emulator'), `RESERVABLE`
(['adb', 'mac-ios'], `lock.mjs:546`) and every currently held lock. A `<name>.queue/` whose lock is outside that set and not held is
never shown, for example a live `emulator-1.queue/` on big-chungus today.

The text output has the sections PHONES / LOCKS / WAITERS / RESERVATIONS (only when there are any) / INVENTORY / EMULATORS
(only when there are any) (`:625-677`). The tests pin it exactly (`hub-device.test.mjs:1237-1254`, `:1086-1126`,
`:1047-1084`).

---

## 3. Reachability today: status vs findPhone

**status** (`phonePresence` `:523-552`):
1. `inventory({lockRoot, hubAdbPort})` reads `/proc` only (`inventory.mjs:45-82`). An adb server is a process whose program is `adb` and whose argv has `fork-server` or `server`. Its port comes from `-L tcp:[host:]N`, else `ANDROID_ADB_SERVER_PORT`, else 5037 (`:22-28,62-64`). It is `managed` when it carries `HUB_MANAGED=1`, when its pid is in `<lockDir>/managed.json {"pids":[...]}`, or when its port is the hub port (`:59,64`).
2. When no server in the inventory is on `HUB_ADB_SERVER_PORT` (default 5037), every phone gets `'no adb server'` and **adb is never called** (`:525-527`; test `:1237-1253`).
3. Otherwise it runs two read-only adb client queries against the hub port. It forces `ANDROID_ADB_SERVER_PORT` to the hub port and drops `ANDROID_SERIAL` (`:528-529`). The queries are `adb devices` (`createAsyncAdb().devices` -> `parseDeviceList`) and `adb mdns services` (`parseMdnsServices`), raced against a 5 s `timing.sleep`. The AbortController kills the children (`:530-551`).
4. Per phone: `idMatchesSerial(id, serial, mdns)` (`adb.mjs:64-66`) gives the match. The id equals the serial over USB, `adb-<serial>-*` over wireless mDNS auto-connect, or a `host:port` that the mDNS list maps to the serial. The result is `'reachable'` when the state is `device`, the raw adb state otherwise (`unauthorized`, `offline`, ...), or `'absent'` (`:543-546`).
5. When a query fails or times out, the result is `'adb did not answer'` (`:540-542`).
- So today's `presence` values are `reachable | <raw adb state> | absent | no adb server | adb did not answer`. They are not the PRD's Reachability enum (`reachable, unauthorized, offline, absent, unknown`).
- There is a time-of-check race: the 5037 check reads `/proc`, then the **adb client binary** runs `devices`. If the server dies between those two steps, the adb client auto-starts a new server. The bypasses already exist: `adb-wire.mjs` speaks `host:devices` over the socket and "a socket never starts anything" (`adb-wire.mjs:1-4,72-73`), and `-L tcp:127.0.0.1:<port>` refuses to launch a server (`adb.mjs:75-81,88`).
- "away": `HUB_PHONE_AWAY` (with `reason`) is thrown only by findPhone. The CLI maps it to 75. AWAY reasons are `absent`, or whatever state adb listed (`unauthorized`, `offline`, ...) (`adb.mjs:185-190`). The test pins `unauthorized` -> 75 (`hub-device.test.mjs:403-411`).

**findPhone** (`adb.mjs:139-191`), used by `takeLease` (`hub-device.mjs:178`), the gate's `quickS26` (`gate.mjs:141-153`) and
deploys. It **starts the server** (`adb.startServer()` on poll 1 and after each server error, `:148`), lists devices, and reads
`ro.serialno` and `ro.product.model` with `adb -s <id> shell getprop` (`:162-164`). Every `nudgeEvery` (5) polls it looks the serial up
in `adb mdns services` and runs **`adb connect <endpoint>`** (`:171-177`). A model mismatch throws a plain Error (exit 1, not
AWAY). If adb never listed once, the last error is rethrown, so the result is red, never AWAY (`:155`). `createAsyncAdb.startServer`
blanks `RUNNER_TRACKING_ID` so the server outlives the caller (`async-adb.mjs:58`). The gate's quickS26 only Peeks
(`peekInstalled`) while a live Lease holds `adb` (`gate.mjs:142-143`).

---

## 4. Discovery of unregistered devices: what exists

- `parseDeviceList` (`adb.mjs:14-18`) parses `adb devices` without `-l`. It keeps only `[id, state]`. `model:`, `product:`, `device:` and `transport_id:` are not read, and **no code calls `adb devices -l`**.
- `createAdbWire(port).devices()` (`adb-wire.mjs:72-73`) sends `host:devices` and also keeps only `{id, state}`. `host:devices-l` is not used. `createAdbWire` is used only by the emulator broker (`emulator.mjs:26,572`).
- How a serial can be recovered without connecting:
  - from the id itself, for USB and wireless auto-connect (`adb-<serial>-<suffix>`), as in `idMatchesSerial`;
  - from `adb mdns services` for a bare `host:port` (`parseMdnsServices` `adb.mjs:48-56`, which only accepts `_adb-tls-connect` endpoints that look like an IPv4 `host:port`);
  - with a read-only device query: `adb -s <id> shell getprop ro.serialno|ro.product.model` (`async-adb.mjs:63`), or `createAdbWire().shell(serial, cmd)` over `host:transport` + `shell:` (`adb-wire.mjs:77`).
- status already holds the full `listed` array, so the unmatched entries are discovery candidates. It just never surfaces them (`:541-546`).
- Only the hub's adb server (5037) is queried. big-chungus runs foreign adb servers on 5043, 5055 and 5093 (`ps`, inventory foreign), and a phone attached to one of them is invisible. The README says "Only one adb server can own a phone's USB interface" (README:239).
- On the Mac, `inventory` finds no `/proc` and returns empty lists, so status reports `no adb server` for every phone there.

---

## 5. takeLease / takeAnyPhone, and what must move into a library (FR-22)

Both are **private** to `hub-device.mjs`. They are not exported, and nothing else calls them.

- `takeLease(phone, options, context)` `:166-198`
  - `phone` = a fleet entry `{device, lock, deploy, name, serial, model}`.
  - `options` = `{holder, why, forMs, waitMs, id, holderPid, noConnect, phoneWaitMs, signal, pool?}`.
  - `context` = `{env, log, timing:{leasePollMs, phonePollMs, sleep, now}, adbFactory?}`.
  - Steps:
    1. `acquireLease(phone.lock, {...options, env, log, pollMs, sleep, now})`.
    2. Unless `noConnect`, `findPhone` runs on `createAsyncAdb({env: {...env, ANDROID_ADB_SERVER_PORT: port}, signal})` with `ANDROID_SERIAL` dropped.
    3. On failure it gives the lease back with `releaseLease` only if it still owns it. Otherwise it throws `HUB_LEASE_CANCELLED`.
    4. `updateLease(lock, id, {device:{phone, serial, adb_id, adb_port}}, {env, ino: lease.lock_ino})`. A false result, or `HUB_LEASE_LOST`, becomes `HUB_LEASE_CANCELLED`.
  - Returns `{phone, lease, device}`.
- `takeAnyPhone(fleet, options, context)` `:220-249`.
  - It opens one `poolRequest('phone', {id, holder, why, forMs, waitMs, env, now})` (`lock.mjs:923`) for the whole wait.
  - It loops over the fleet in order, calling `takeLease(phone, {...options, id: pool.id, pool: pool.tag, waitMs: 0, phoneWaitMs: min(slice, left)})`. `waitMs: 0` makes each call a **try**: no ticket, no event unless it acquires (`lock.mjs:1152-1155`).
  - `HUB_LOCK_TIMEOUT` marks the phone 'held'. AWAY records the phone's reason. Then it pauses `leasePollMs` and loops until the deadline.
  - The end is `noPhoneError` (`:202-212`): BUSY (`HUB_LOCK_TIMEOUT`) only when every phone was held, otherwise AWAY with the deduped reasons in fleet order. `pool.settle(error)` writes one timeout or cancel.
  - It **never queues** (the comment at `:214-219` says so). FR-6 changes this on purpose: "when none is, it now holds a place in line" (PRD FR-6, FR-13).
- **s24-first ordering** comes from `fleetOf(devices)` `:57-64`, which returns `[...android_extra (in file order, lock = lowercase name), {device:'s26', lock:'adb', deploy:true}]`. So it is extras-first, deploy-phone-last, not "s24" by name. Tests: `hub-device.test.mjs:303-332` (both free: s24; s24 held: s26 at once; s24 away: s26 after one slice, with the s24 lock given back) and `:434-451` (no android_extra: `phone` means s26, and `s24` is unknown).
- What the Hub API must call instead of copying, all currently in `hub-device.mjs`:
  - the fleet and word resolution (`fleetOf` `:57`, `resolveDevice` `:70`, `nameOf` `:67`);
  - the `setup` validation (`:130-162`: the duration and cap rules, the cross-fleet and emulator `--id` uniqueness, the `usable` cap filter);
  - `takeLease`, `takeAnyPhone`, `noPhoneError`, and `exportsOf` (`:251`);
  - the release-by-id search (`:443-481`), which finds an id across fleet owners, then fleet queues, then emulator (`isEmulatorLease` `:437`), and `--any` (`:484-506`);
  - `phonePresence` (`:523-552`) and the status assembly (`:554-623`).

  The signal, stdout and AbortController handling in `lease`/`run` stays CLI-only. `report()` (`:261-277`) is the one error-to-exit-code mapping, and the API needs the same codes (FR-21: "the matching CLI exit code (75, 76 or 2)"), so that mapping should move as data.
- An API Lease is "no process" (FR-10). That means `holderPid: null`, which is already how `lease` behaves without `--pid` (`:159,346`). But `acquireLease` stamps `pid: process.pid` and `host` into owner.json (`lock.mjs:1199`). Lease staleness ignores `pid` (`lock.mjs:68-87`), so that is safe.
- `findPhone` inside an API process calls `adb start-server`. The server is forked as a child of the API's systemd unit. The catch-up unit already sets `KillMode=process` for this reason (`tools/catchup/units/mobile-deploy-hub-catchup.service`: "An adb server the pass starts must outlive it"). The live 5037 server currently sits in a runner service cgroup (`/ci.slice/actions.runner.delorenj-green-in-between.delonet-gib-r1.service`).

---

## 6. devices.json, the devices.mjs loader, reserved words, ipad/mac, qa-devices.json

- `tools/ci/devices.json` (schema 1, 22 lines):
  - `android {name:'S26', model:'SM-S948U', serial, syncthing}`
  - `android_extra [{name:'S24', model:'SM-S928U', serial}]`
  - `ios {name:'iPad', model:'iPad14,5', udid}`
  - `apple {team, dev_signer_sha1, profile_min_days}`
  - `mac {host:'hub-mac', peer, handoff_dir, handoff_cache, outbox, min_free_gib, runners{owner/repo:{name, dir}}}`
  - `linux {host:'big-chungus', staging_dir}`
- `parseDevices(source)` / `loadDevices(env)` (`devices.mjs:11-65`). The path is `$HUB_DEVICES`, else `../devices.json` next to the module, i.e. **the release's copy** when it runs through the wrapper (`:8,64`). Validation:
  - `android.serial` must be `^[A-Za-z0-9]+$` and `model` must be `^[A-Za-z0-9_-]+$`.
  - `android_extra`, when present, is a non-empty list. Each `name` matches `^[A-Za-z][A-Za-z0-9]*$`, which allows **no dashes** (`:27`). Serials must be unique across android and the extras (`:22-29`), and names must be unique by lowercase (`:32`).
  - **Reserved words: `['s26','phone','emulator','adb']`** (`:35`). This is the only collision list in the code.
- What a missing reserved word allows today: an extra named `ipad` or `mac` passes validation. `mac-ios`, `emulator-N`, `emulator-reaper` and `s3-*` cannot collide, but only because the name regex forbids dashes, not by policy.
- Lock-name syntax lives in `lock.mjs`: `leaseName` `^[a-z0-9-]+$` (`:329`), lease id `^[a-z0-9][a-z0-9-]{0,63}$` (`:330`; also `emulator.mjs:336 LEASE_ID`). `isEmulatorLock` is `name === 'emulator' || /^emulator-\d+$/` (`emulator.mjs:31`). `REAPER = 'emulator-reaper'` (`emulator.mjs:34`, not exported). `s3-<slug>` and `s3-index` are built inline at `deliver.mjs:249`, `s3.mjs:219`, `catchup.mjs:774,838,852` and `bucket-policy.mjs:208`. `QUEUED = ['adb','s24','mac-ios','emulator']` (`lock.mjs:30`; pinned by `lease.test.mjs:300-304`).
- Non-lock entries in the lock dir: `managed.json` (`inventory.mjs:40`), `emulator-pool` (`emulator.mjs:66`), `emulators/` (the lease records dir, `emulator.mjs:191`), and `<name>.queue/` and `<name>.reservations/<run_key>/{reservation.json, grace.json}`. Separately, `runtimeRoot` is `dirname(lockDir)/emulators` (`emulator.mjs:193`).
- **ipad/mac**: no CLI word handles them. `lease ipad` fails `resolveDevice` with `unknown device "ipad" (known: s24, s26, phone, emulator)` and exits 2 (`:73`). `mac-ios` is taken only by `withLock('mac-ios')` in `ios.mjs:234` and by the Mac catch-up (`catchup.mjs:298,673`), and reserved by `plan.mjs:49`. hub-device touches `mac-ios` only through `reservation release --name mac-ios` (`RESERVABLE`). `announce` calls it over ssh: ``ssh hub-mac '~/.local/bin/hub-device reservation release --run <key> --name mac-ios'`` (`announce.mjs:70,86`). `status` on big-chungus walks `mac-ios` (`:583`) but reads big-chungus's own lock dir, so it never sees the Mac's Queue (spine Deferred, ARCHITECTURE-SPINE.md:472).
- **qa-devices.json is read by no hub code.** Grep shows only `README.md:239` and `AGENTS.md:18`.
  - The live file `~/.config/mobile-deploy-hub/qa-devices.json` (mode 0600) has keys `{schema, devices:[{name, model, serial, dedicated, allowed_users}]}`, with one entry, `S24`.
  - Its only reader is outside the hub: `~/code/green-in-between/native/tools/qa/qa_devices.py`. It reads `$HUB_QA_DEVICES` or that path. It cross-checks against `$HUB_DEVICES` or `~/.local/share/mobile-deploy-hub/current/tools/ci/devices.json` (`android` + `android_extra`, lock = lowercase name).
  - It also **reads the lock dir directly**: `<lockDir>/<name>.lock/owner.json` (`kind == 'lease'`, `expires_at`, `lease_id`/`why`) and `<name>.queue`, where lockDir is `$HUB_LOCK_DIR` or `~/.cache/mobile-deploy-hub/locks`. That makes it a client of the on-disk contract outside this repo.

---

## 7. HUB_LOCK_DIR, the release dir and the wrapper

- `lockDir(env, home = os.homedir())` = `env.HUB_LOCK_DIR || ~/.cache/mobile-deploy-hub/locks` (`lock.mjs:26`). hub-device has no lock-dir logic of its own. It passes `env` to everything (`readOwnerOf` `:52`, `listLocks`, `queueView`, `inventory({lockRoot: lockDir(env)})` `:605`).
- Nothing in the units sets `HUB_LOCK_DIR`. The runner (`User=delorenj`), the catch-up service (`Environment=HOME=%h`, PATH only) and the wrapper all use the default.
- `eventDir` = `HUB_EVENT_DIR`, else `$XDG_STATE_HOME/mobile-deploy-hub/events`, else `~/.local/state/mobile-deploy-hub/events` (`events.mjs:17-21`).
- `install.sh <ref>` (`tools/catchup/units/install.sh`):
  - It copies `tools/` to `~/.local/share/mobile-deploy-hub/releases/<ref>/tools` (`:27-33`) and points `current` at it with `ln -sfn` (`:35`).
  - It writes `~/.local/bin/hub-device` as `#!/bin/sh\nexec "<~/.local/share/mise/installs/node/24/bin/node>" "<release>/tools/device/hub-device.mjs" "$@"` (`:41-44`). The wrapper pins **the release, not `current`**.
  - On Linux it copies the two `.service` units and runs `systemctl --user daemon-reload` only (`:59-66`; test `hub-device.test.mjs:1262-1295` asserts the log is exactly `--user daemon-reload\n` and that launchctl is untouched). On Darwin it bootstraps `sh.delo.mobile-deploy-hub.catchup` into `gui/<uid>` (`:67-77`).
- `mise run hosts:install` -> `node tools/hosts.mjs` (`mise.toml:159-162`). `releaseName()` is the exact `vX.Y.Z` tag at HEAD, else `main-<sha7>` (`hosts.mjs:28-33`). It runs `install.sh` locally (`:109-113`), then rsyncs `tools/` to `hub-mac:.local/share/mobile-deploy-hub/releases/<ref>/tools/` and runs install.sh there over ssh (`:114-124`).
- Live state: the big-chungus wrapper runs `releases/v1.2.51`, and `current -> releases/v1.2.51`. The Mac wrapper runs `/Users/delorenj/.local/share/mobile-deploy-hub/releases/v1.2.51/...`, and `current -> releases/v1.2.51`. The Mac lock dir holds `mac-ios.queue` and `mac-ios.reservations`. `launchctl list` on hub-mac shows `sh.delo.mobile-deploy-hub.catchup` with no pid, which is right for an on-demand agent. **No Host Agent LaunchAgent exists yet.**
- The entry check `pathToFileURL(realpathSync(argv[1])) === import.meta.url` (`:830-831`) means a symlinked entrypoint also runs.

---

## 8. Name and lock-name collision lists today vs FR-1

FR-1 wants refused: `phone, emulator, adb, s24, s26, ipad, mac, mac-ios, emulator-N, emulator-reaper, s3-*`, plus existing Resources,
with seeded names exempt. Today:

| word | where it is refused or known today |
|---|---|
| s26, phone, emulator, adb | `devices.mjs:35` (android_extra names only) |
| s24 | only as android_extra name uniqueness (`devices.mjs:32`). `QUEUED` hardcodes it (`lock.mjs:30`). |
| ipad, mac | **nowhere** |
| mac-ios | `RESERVABLE`/`DEPLOY_TARGETS` (`lock.mjs:546,366`), `QUEUED`. Not a refused name. |
| emulator-N | `isEmulatorLock` (`emulator.mjs:31`), `isQueued` (`lock.mjs:31`). Not a refused name. |
| emulator-reaper | `REAPER` const, private (`emulator.mjs:34`) |
| s3-* | inline template strings at 5 call sites, with no constant |
| CLI words | `resolveDevice` builds its known list from the fleet, plus `phone` and `emulator` (`hub-device.mjs:73`) |

No single exported "reserved names" constant exists, so v1b has to create one.

---

## Other facts v1b must respect

- The `android_extra` guard test (`hub-device.test.mjs:421-432`) fails the suite if any `.mjs` in `tools/ci/commands`, `tools/ci/lib` (except `devices.mjs`), `tools/catchup`, `tools/deploy.mjs`, `tools/hosts.mjs` or `tools/ci/macwatch.mjs` contains the text `android_extra`. A Registry seeder that sits in `tools/ci/lib/` and names that key breaks it.
- Events are written only for Queued names (`note` `lock.mjs:134-135`), and `QUEUED` is the hardcoded `['adb','s24','mac-ios','emulator']`. A runtime-registered phone lock would queue FIFO, because `acquireLease` writes tickets for any name when `waitMs > 0` (`:1152-1161`), but it would write **no events**. The spine says the Registry replaces QUEUED's source (ARCHITECTURE-SPINE.md:111,471).
- `eventOf` always records a Lease's claimant kind as `'agent'` ("v1a has no person surface", `lock.mjs:110-113`). The PRD has four Claimant kinds, person included.
- There is no force-release writer. `'force-release'` appears only in the reader lists `LEASE_EVENTS`/`LEASE_ENDS` (`lock.mjs:1379-1380`). `releaseLease(name, id, {reason})` (`:1277`) writes `release` with `reason` `by-id` or `any`. `releaseReservation(name, {key, reason})` exists (`:644`).
- `release` without `emulator` searches only fleet locks (`:445-449`), so a Lease on a lock outside the fleet (`mac-ios`, a registered phone) cannot be released by id through hub-device.
- `report()` defaults the device word to `'s26'` when `words[1]` is missing (`:263`).
- README:237 says status reaps the emulator pool's expired leases. The code does not: status never reaps (header `:15-16`, MOBI-26 `e6f02cc`, spine AD-15). The README is stale.
- Tests are fixture-based (`fixture()` `hub-device.test.mjs:57-80`): a fake adb shell script, a temp `HUB_LOCK_DIR`/`HUB_EVENT_DIR`, and an injected `inventory`. `main(argv, {env, stdout, stderr, signals, adbFactory, inventory, sleep, now, policy})` is the injection seam (`:792-802`).
