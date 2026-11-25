---
title: 'Discover unregistered devices from the CLI'
type: 'feature'
created: '2026-11-25'
status: 'done'
baseline_revision: '2ba81905094519cac212461ea6fb2f32eb52151e'
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-5-context.md'
warnings: ['oversized']
deferred: []
---

<intent-contract>

## Intent

**Problem:** Nothing in the hub tells Jarad which phones are visible to the hub's adb server but named by no Resource, so registering the next phone means reading `adb devices` by hand, and a bare adb client call can start a server (FR-4, AD-13, AD-35).

**Approach:** Move status's read-only adb wire query out of `claims.mjs` into `reachability.mjs` as the one query (`queryAdb`), keep status on it unchanged, and add `discover({seed, ...})` there: the listed devices whose serial no seeded Resource names, with model, serial and adb id, from the hub's port only (or, on the Mac, `devicectl` devices whose UDID is not seeded). `claims.discover(key, ctx)` wires the seams; `hub-device discover [--json]` prints it.

## Boundaries & Constraints

**Always:**
- One query. `reachability.queryAdb({port, running, wire, sleep})` is the code status always ran (`host:version`, `host:devices-l`, one `host:transport:<id>` + `shell:getprop ro.serialno` per `host:port` id in `device` state, each serial read bounded at 1.5 s, the whole query at 5 s, every socket closed by abort). It returns `{port, note, listed, serials}`: `note` is null, `'no adb server'` (`running` false: no wire is even opened) or `'adb did not answer'` (any failure or the 5 s bound). `wire` is the `adbWire(port, {signal})` factory, always injected. `claims.statusView` maps its phones' observations from it with no change to any status output.
- `reachability.discover({seed, host, adb, ipads})` (pure over its inputs, `seed` a `seed()` result or a resources array) returns `{format: 1, port, devices, host, via, note}` (first three keys in that order, the rest additive):
  - `host: 'linux'`, `via: 'adb'`, `port` = `adb.port`, `note` = `adb.note`. `devices` is every `listed` entry, in listing order, except `emulator-<n>` ids (the emulator Pool Resource names emulators) and entries a phone Resource names: `idMatchesSerial(id, resource.identity.serial)` or the read serial equals it. Each is `{serial, model, id, state}`: `serial` is the `ro.serialno` read for a `host:port` id (null when unreadable or not read), the serial inside an mDNS id `adb-<serial>-…._adb-tls-connect._tcp`, else the id itself; `model` is `host:devices-l`'s model or null; `state` is adb's own word.
  - `host: 'mac'`, `via: 'devicectl'`, `port: null`. `ipads` is `{document}` (devicectl's `list devices` result) or `{error}`. `devices` is each record whose `hardwareProperties.udid` is not a seeded `identity.udid`, as `{serial: udid ?? null, model: productType ?? null, id: identifier ?? null, state: connectionProperties.pairingState ?? null}`. `note` is null, or `'devicectl did not answer'` with `devices: []` on an error.
- `claims.discover(key, ctx)`: the seed is `seed(loadDevices(env), {qaDevices: () => []})` (the CLI never reads the QA file). `key` null throws `HUB_HOST_UNKNOWN` (exit 1). `linux`: `running` is the inventory showing an adb server on `HUB_ADB_SERVER_PORT` (default 5037), exactly status's test; `wire` is `ctx.adbWire ?? createAdbWire`. `mac`: `devicectl(['list', 'devices'], 10)` (`ctx.devicectl ?? createDevicectl({env})`), never adb.
- `hub-device discover [--json]`: takes `hostKey` like `status`, but an unknown key fails (exit 1, the hostKey message). `--json` prints the document as two-space JSON. Text:
  - Linux: `DISCOVER (read only; adb server port <port>, never started or connected)`, then one `  <serial|->  <model|->  id <id>  <state>` per device, or `  none unregistered`, or `  no adb server (nothing was started)`, or `  adb did not answer`.
  - Mac: `DISCOVER (read only; devicectl on this Mac)`, then `  discovery of the iPad is by devicectl; the Mac's adb is not the hub's, so no Android device is listed`, then the device lines (same form), `  none unregistered` or `  devicectl did not answer`.
  - Exit 0, except 1 when `note` is `adb did not answer` or `devicectl did not answer` (the document still prints).
- `USAGE` keeps its `usage: hub-device lease ` prefix and gains `| discover [--json]`.

**Never:**
- No adb client process, `start-server`, `connect`, `findPhone`, mDNS nudge or any wire request beyond the four above; no lock-dir or Event Log write; no Registry, `registry.json`, Hub API or `/discovery` route (Story 6.10); no new exit-table code; no change to the deploy path, `devices.json`, `lock.mjs` or any `status` output (text or JSON).
- Never read `qa-devices.json` from the CLI.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Only seeded phones | S24 + S26 listed (mDNS ids) | `devices: []`, text `none unregistered` | exit 0 |
| New USB phone | id `ZY22ABC`, model `Pixel_8`, device | `{serial:'ZY22ABC', model:'Pixel_8', id:'ZY22ABC', state:'device'}` | — |
| Wireless `host:port` | `192.168.1.40:41234` device, `ro.serialno` `9A1B` | serial `9A1B`, id the host:port | — |
| Wireless known phone | `host:port` whose serial reads S24's | not listed | — |
| Unreadable `host:port` | unauthorized, or read fails/hangs | `serial: null`, id the host:port | bounded at 1.5 s |
| mDNS unknown | `adb-ZZ9-x._adb-tls-connect._tcp` | serial `ZZ9` | — |
| Emulator | `emulator-5554` | not listed | — |
| No server | inventory has no server on the port | `no adb server`, `devices: []`, wire never opened, fake exec sees no argv | exit 0 |
| Wedged server | `version` rejects or hangs | `note: 'adb did not answer'`, `devices: []` | exit 1 |
| Port | `HUB_ADB_SERVER_PORT=15037` | only port 15037 opened, `port: 15037`, printed | — |
| Mac | key `mac`; devicectl lists the seeded iPad + an iPhone | only the iPhone; adb wire never opened | — |
| Mac devicectl fails | list throws | `devicectl did not answer` | exit 1 |
| Unknown host | hostKey throws `HUB_HOST_UNKNOWN` | its message on stderr | exit 1 |

</intent-contract>

## Code Map

- `tools/device/claims.mjs`:
  - L462-508: `NO_SERVER`, `NO_ANSWER`, `PROBE_MS`, `SERIAL_READ_MS`, `readWire`, `phoneObservations`. Move the query into `reachability.queryAdb`; `phoneObservations` keeps only the fleet mapping (`idMatchesSerial(id, phone.serial)` or read serial equal) and returns the same Map (`NO_SERVER`/`NO_ANSWER` note per phone when `note` is set).
  - L608-609: the inventory call and `hubPort` test status already does; reuse it in `discover`.
  - L629: the seed build pattern (`seed(loadDevices(env), { qaDevices: () => [] })`).
  - L644-653: the Mac devicectl call pattern (`ctx.devicectl ?? createDevicectl({ env })`, `['list', 'devices'], 10`).
  - Add `export async function discover(key, ctx)`; `claims.test.mjs` L53 pins functions by presence only, and `EXIT_CODES` must stay as is (deep-equal at L58).
- `tools/registry/reachability.mjs`: add `NO_SERVER`, `NO_ANSWER`, `queryAdb`, `discover`. May import `idMatchesSerial` from `../ci/lib/adb.mjs`; must not import `claims.mjs` or `tools/device/*` (wire is injected).
- `tools/device/hub-device.mjs`: L299-308 `status` shows the `hostKey` call pattern; add a `discover` command and a `case 'discover'` in `main` (L506-513); extend `USAGE` (L87) and the header comment (L18-33).
- `tools/device/adb-wire.mjs`: `createAdbWire` default factory, `parseDevicesLong`; read only.
- `tools/ci/lib/devicectl.mjs`: `inspectIpad` record field paths (`hardwareProperties.udid/productType`, `connectionProperties.pairingState`, `identifier`); read only.
- `tools/device/wire-fixtures.mjs`: `fakeWire` (records requests, `opened` ports, `serials`, `fail`, `hang`, `hangShell`) and `fakeHub` for child-process runs; reuse.
- `tools/device/status-view.test.mjs` L47 `side()` and `quickSleep()`: the fixture pattern for CLI and library cases (fake `adbFactory` that throws, a fake `adb` binary that logs argv).
- `tools/ci/reservation-release.test.mjs` L247: relies on the `usage: hub-device lease` prefix.
- `README.md` L248 (command list) and L253 (status paragraph): add `discover`.
- `docs/features.md` L43: mention `discover`.

## Tasks & Acceptance

**Execution:**
- `tools/registry/reachability.mjs` -- add `queryAdb` (moved from claims) and `discover` -- the one read-only query, shared by status, discovery and later the Hub API.
- `tools/device/claims.mjs` -- `phoneObservations` uses `queryAdb`; add `discover(key, ctx)` -- seams and seed in one place.
- `tools/device/hub-device.mjs` -- `discover [--json]` command, USAGE and header -- the CLI front door.
- `tools/registry/discover.test.mjs` -- NEW: every matrix row for `queryAdb`/`discover` (pure, with `fakeWire`) plus, through `main`: text and JSON, the port printed, no-server exit 0 with the fake `adbFactory` never called and the fake `adb` binary never run, wedged exit 1, Mac, unknown host, and one child-process run against `fakeHub` asserting only `host:version`, `host:devices-l`, `host:transport:*` and `shell:getprop ro.serialno` requests.
- `README.md`, `docs/features.md` -- document `hub-device discover`.

**Acceptance Criteria:**
- Given the existing suites, when they run, then `status-view.test.mjs`, `hub-device.test.mjs`, `claims.test.mjs`, `lease.test.mjs`, `reservation-release.test.mjs` and `deploy-path.test.mjs` pass unchanged.
- Given `hub-device discover` on Linux with the hub's server running, when it runs, then it lists devices from that port's `host:devices-l` that no seeded Resource names, with model and serial, and prints the port it used.
- Given no adb server, when `discover` runs, then it prints `no adb server`, exits 0 with an empty list, and no exec, `start-server` or `connect` argv is ever produced.
- Given `--json`, then the shape is `{format: 1, port, devices: [{serial, model, id, state}]}` plus the additive `host`, `via`, `note`.
- Given the Mac, when `discover` runs, then it says iPad discovery is by `devicectl`, lists no Android device, and lists the iPad only if its UDID is not seeded.

## Spec Change Log

## Review Triage Log

### 2026-11-25 — Review pass
- verdicts: 24 findings — high 0, medium 1, low 6, false 17, maybe-false 0 (outcomes: 3 patch, 0 defer, 21 reject)
- findings:
  - `[false]` `[reject]` (blind) The CLI ignores runtime (QA) Resources, so a QA phone shows as unregistered. By design: the CLI never reads the QA file (AD-41, Story 5.5), the AC says "no seeded Resource names", and QA runtime records are `seeded: false` and exist only for the Hub API's loader. The README states "The QA file is never read".
  - `[low]` `[reject]` (blind) One phone on USB and wireless at once prints two rows. Each row is a distinct adb transport with its own id, so both are true listings. Merging would drop an id, it is rare, and the fix adds a branch.
  - `[false]` `[reject]` (blind) The Mac lists every devicectl record, not only iPads, and shows `pairingState`. The spine says the Mac "lists `devicectl` devices the same way", and the AC only requires that the seeded iPad be left out. Any unseeded Apple device is a candidate to register.
  - `[low]` `[patch]` (blind) `hub-device discover` decided its exit code and no-server line from string literals. Patched: it imports `NO_ANSWER`, `NO_DEVICECTL` and `NO_SERVER` from `reachability.mjs`.
  - `[false]` `[reject]` (blind) `discover()` throws without `adb`, and any host but `mac` is read as linux. Its only caller, `claims.discover`, always passes `adb` and refuses every key but `linux`/`mac`, so the state is unreachable, and a TypeError on a programming error is a loud failure.
  - `[false]` `[reject]` (blind) Exit 0 for both "none unregistered" and "no adb server". The AC mandates exit 0 for no server, and `--json`'s `note` tells the two apart.
  - `[low]` `[reject]` (blind) The output offers no next step for registering. Registration does not exist yet (Epic 6), so there is nothing to point to. Cosmetic.
  - `[false]` `[reject]` (blind) The status path lacks a regression test after the move to `queryAdb`. `status-view.test.mjs` L170-200 and L268 pin `no adb server` and `adb did not answer` per phone, and they pass unchanged.
  - `[false]` `[reject]` (blind) The Mac devicectl call is unbounded. `createDevicectl` passes `10` as devicectl's own `--timeout` and hard-kills at +30 s through `runBounded`, exactly as status's iPad read.
  - `[false]` `[reject]` (blind) The README never says an unknown host fails while status degrades. It does: "a host without one fails (`HUB_HOST_UNKNOWN`, exit 1)", and the status paragraph says status shows unknown readings.
  - `[false]` `[reject]` (edge) A missing `adb` gives a TypeError for the Hub API. This duplicates the blind row, with the same refutation. Story 6.10 composes `queryAdb` and `discover` the way `claims.discover` does.
  - `[false]` `[reject]` (edge) A known phone on a `host:port` whose serial read fails is listed as unregistered. The AC requires exactly this: "an unreadable one is listed with `serial: null` and its `host:port`".
  - `[low]` `[reject]` (edge) An IPv6 endpoint id `[fe80::1]:5555` is not matched as `host:port`. The regex is status's pre-existing one, the LAN is IPv4 (`192.168.1.0/24`), and it would take a new regex in two places for an id never seen here.
  - `[low]` `[reject]` (edge) Duplicate rows for one phone. This duplicates the blind row, with the same reason.
  - `[false]` `[reject]` (edge) A registered QA phone is shown as unregistered. This duplicates the blind QA row, with the same refutation.
  - `[false]` `[reject]` (edge) The inventory can throw and leave a raw error. `inventory()` wraps every `/proc` and `managed.json` read in try/catch, and `readdirSync` of the proc root is guarded, so it does not throw.
  - `[low]` `[reject]` (edge) An out-of-range `HUB_ADB_SERVER_PORT` is used as is. This is status's existing parse. The value is an operator-set variable, the outcome is a truthful `adb did not answer` or `no adb server`, and a guard adds branches for an unseen value.
  - `[false]` `[reject]` (edge) A devicectl document without `result.devices` reads as answered. `createDevicectl` returns only documents whose `info.outcome` is `success`, so a successful listing with no devices key has no devices. A null record prints a dash row, never a wrong one.
  - `[low]` `[patch]` (edge, claim) The README said discover "never touches the lock dir", but the inventory reads `managed.json`. Patched: it now says discover writes nothing to the lock dir or the Event Log.
  - `[medium]` `[patch]` (verification-gap) Nothing pinned that `claims.discover` and `hub-device discover` never read the QA file. Patched: a new `discover.test.mjs` case points `HUB_QA_DEVICES` at a sentinel file that names a listed serial, then at a broken file. `claims.discover` and `discover --json` stay identical to the baseline, `SENTINEL9` stays listed, nothing mentions `res-sentinel` or `dedicated_qa`, and the broken file still exits 0.
  - `[false]` `[reject]` (verification-gap, other) A devicectl document without `result.devices` prints "none unregistered". This duplicates the edge row, with the same refutation.
  - `[false]` `[reject]` (intent) `discover({seed})` is pure and does not query adb itself. The AC's surface is `reachability.mjs`, which holds both `queryAdb` and `discover`, and the listing comes from that port's `host:devices-l`. The split lets status, the CLI and Story 6.10 share the one query. No caller passes only `seed`.
  - `[false]` `[reject]` (intent) There is no fake `exec` seam. Three things stand in for it: the stub `HUB_ADB` binary logs any argv the adb client would run, which is a fake exec, the throwing `adbFactory`, and the child-process request allow-list. Together they prove no `start-server` or `connect`.
  - `[false]` `[reject]` (intent) The tests mostly inject, and the additions go beyond the AC (exit 1 on no answer, `HUB_HOST_UNKNOWN`, `host`/`via`/`note`). This is descriptive only: a real child process covers the CLI end to end, and every addition is additive or a documented spec decision (Design Notes), with no harm named.

## Design Notes

- Why exit 1 on "did not answer" but 0 on "no adb server": no server is a definite answer (nothing can be visible); a wedged server means nothing could be discovered, and an empty list with exit 0 would read as "nothing new". Status stays tolerant because it shows many things; discover has one job.
- Why an unknown host key fails: which transport to ask is the host's identity (AD-47); guessing from the platform is what AD-47 forbids, and asking the Mac's adb would list devices that are not the hub's.
- Why emulators are skipped: the seeded emulator Pool Resource names emulators, and an emulator is never registered as a phone.
- `discover` takes the seed as an argument so the Hub API (Story 6.10) can pass its non-retired Registry Resources to the same function.

## Verification

**Commands:**
- `node --test tools/registry/discover.test.mjs tools/registry/reachability.test.mjs tools/device/status-view.test.mjs tools/device/hub-device.test.mjs tools/device/claims.test.mjs tools/deploy-path.test.mjs tools/ci/reservation-release.test.mjs` -- expected: all pass.
- `mise run check` -- expected: actionlint clean, full suite green.

## Auto Run Result

- **status:** done
- **summary:** Running `hub-device discover [--json]` lists every device the host can see that no seeded Resource names (FR-4).
  - **Linux:** it sends the hub's adb server, on `HUB_ADB_SERVER_PORT`, the same read-only wire query `status` uses. That query now lives once in `reachability.queryAdb`, and status runs on it with output unchanged. A server is asked only when the inventory already shows it running. Each listed device comes with its serial, model, adb id and state. A `host:port` id is tied to its `ro.serialno` read, an unreadable one shows `serial: null`, and `emulator-<n>` ids are skipped.
  - **No server:** with no server running, it prints `no adb server (nothing was started)` and exits 0 with an empty list. A server that does not answer exits 1.
  - **Mac:** it says iPad discovery is by `devicectl`, lists no Android device, and lists the devicectl records whose UDID is not seeded.
  - **Unknown host key:** it fails with `HUB_HOST_UNKNOWN` (exit 1).
  - **`--json`:** the output is `{format: 1, port, devices: [{serial, model, id, state}], host, via, note}`.
  - **Story 6.10:** the pure `reachability.discover({seed, host, adb, ipads})` is the function the Hub API's `/discovery` will call with its Registry Resources.
- **files changed:**
  - `tools/registry/reachability.mjs`: adds `queryAdb` (moved from claims), `discover`, and the `NO_SERVER`/`NO_ANSWER`/`NO_DEVICECTL` notes.
  - `tools/device/claims.mjs`: `phoneObservations` now runs on `queryAdb`; adds the `discover(key, ctx)` seams.
  - `tools/device/hub-device.mjs`: the `discover` command, plus its USAGE and header lines.
  - `tools/registry/discover.test.mjs`: new, 25 tests.
  - `README.md`, `docs/features.md`: document `discover`.
- **review:** 24 findings across the four layers (blind 10, edge 9, verification-gap 2, intent 3): high 0, medium 1, low 6, false 17.
  - **Patched (3):**
    - A test now pins that discover never reads the QA file, checked against a sentinel file and a broken one (medium).
    - The exit code is decided from the exported note constants rather than string literals (low).
    - The README now says discover writes nothing to the lock dir, rather than "touches" (low).
  - **Deferred:** none.
  - **Rejected (21):** each has a row in the Review Triage Log.
    - The AC itself refutes several: an unreadable `host:port` must be listed with a null serial, exit 0 on no server, and the seeded-only Resources with no QA file.
    - Others are unreachable states: `discover` without `adb`, an inventory throw, a devicectl success document with no devices.
    - Others are already covered: the status no-server and no-answer tests, the devicectl bound, the README host-key sentence.
    - The low ones are rare and would add branches: duplicate transports, an IPv6 endpoint, an out-of-range port, the next-step hint.
- **followup_review_recommended:** false. One medium and two lows were patched, all of them a test, a constant swap or a wording change, and none was high.
- **verification:**
  - The targeted set (`discover`, `reachability`, `status-view`, `hub-device`, `claims`, `deploy-path`, `reservation-release`) passed 164/164 before the patches.
  - After the patches, `mise run check` exits 0: 852/852 pass, 0 skipped, and actionlint is clean.
  - Every I/O matrix row has a test that passes.
- **residual risks:**
  - `discover` fails on a live host until Story 5.10's `hosts:install` writes `host-key`. This is the same state in which status shows only unknown readings.
  - A phone seen over two transports prints two rows.
  - A known phone on an unreadable `host:port` is listed as unregistered with `serial: null`, as the AC requires.
