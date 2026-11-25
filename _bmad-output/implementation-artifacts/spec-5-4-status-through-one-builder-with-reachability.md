---
title: 'Status through one builder, with Reachability'
type: 'feature'
created: '2026-11-25'
status: 'done'
baseline_revision: '2f72c74ea2caaa4ebe904b3470b76667bb071ad1'
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-5-context.md'
warnings: ['oversized']
deferred:
  - summary: >-
      A phone listed twice by the adb server (a stale USB or offline entry plus a live host:port id) takes the first listed entry's state, so it can read offline or absent while it is usable.
    evidence: |-
      readWire matches with listed.find(...), first match wins; the v1a phonePresence had the same find-first semantics over `adb devices`, so this predates Story 5.4 (status now also derives reachability from it). Fix would prefer a `device` entry among the matches.
    location: >-
      tools/device/claims.mjs:readWire
    severity: low
---

<intent-contract>

## Intent

**Problem:** `hub-device status --json` reports a phone's `presence` as a mix of adb states and excuses (`no adb server`, `adb did not answer`), so an agent cannot tell "nobody checked" from "reachable". Status is assembled by `claims.statusData`, which asks adb through the adb client (`adb devices` plus `adb mdns services`), and it skips `res-*` and `emulator-<n>` queues whose lock is free (FR-5, FR-13, AD-35, AD-41).

**Approach:** Add `tools/registry/reachability.mjs`: one enum, one mapper for phones and one for the iPad, and readings whose age is computed on the reader's clock. Replace `statusData` with `claims.statusView(hostKey, {audience})`. It walks the disk only, reads phones over the read-only adb wire, and adds `resource` and `reachability` to every row while keeping every v1a key and value. `policy.json` gains the strict `registry: {reachability_max_age_s: 60}` block.

## Boundaries & Constraints

**Always:**
- Reachability is `reachable | unauthorized | offline | absent | unknown` (frozen `REACHABILITY`). Phone mapper: adb `device` → reachable, `unauthorized`, `offline` → same, not listed (`null`) → absent, anything else (`no adb server`, `adb did not answer`, `recovery`, `undefined`) → unknown. iPad mapper, from `inspectIpad` (the logic `pickIpad` already has): UDID not listed → absent; listed without live hardware details → unknown; unpaired or Developer Mode off → unauthorized; `bootState` present and not `booted` → offline; otherwise reachable. A devicectl failure or timeout, or a listed record of the wrong model, maps to unknown.
- A row's reading is `{state, checked_at, age_ms, stale}`. It comes from a stored `{state, checked_at, age_ms_at_receipt, received_at}` and is presented with `age_ms = age_ms_at_receipt + now - received_at`, on the reader's clock. `stale` is true when there is no reading, when `registry.reachability_max_age_s` is unavailable, or when `age_ms` exceeds it. It is derived when the view is built and is never written anywhere. A missing reading is `{state: 'unknown', checked_at: null, age_ms: null, stale: true}`.
- `statusView(key, {audience: 'local'|'service', qa_ids = []}, ctx)` returns exactly today's root keys (`phones, locks, waiters, reservations, inventory, emulators`) and every v1a value. `phones[]`, `locks[]`, `waiters[]`, `reservations[]` and `emulators[]` rows gain `resource` (`resourceOf(lock)`, null for a non-Resource lock such as `s3-*`) and then `reachability` (null when `resource` is null). `presence` stays, unchanged in value, beside them. `service` sets `serial`, `udid`, `adb_id` and nested `phone`/`device` `serial`/`adb_id` to null on rows whose resource is in `qa_ids`; no key is ever removed. Any other audience is `HUB_USAGE`.
- Walk set: today's names (fleet locks, `emulator`, `RESERVABLE`, every held lock, in that order), then every `<name>.lock|.queue|.reservations` in the lock dir whose name is a seeded lock, `res-<slug>` or `emulator-<n>` with 1 ≤ n ≤ `MAX_POOL`, sorted. Never a service, never `registry.json`.
- Readings are taken only on the host that owns the Resource. Fleet phones belong to `linux`, `ios-lane` to `mac`. With key `linux`, phones are read from the probe status already runs. With key `mac`, the iPad is read through a `devicectl` seam (`['list','devices']`, 10 s), and only when a row names `ios-lane`. A null key (`hostKey()` threw `HUB_HOST_UNKNOWN`) reads nothing: every reading is missing, and `presence` is still today's.
- The phone transport is only `adb-wire.mjs`: `host:version`, then `host:devices-l`, plus `host:transport:<id>` + `shell:getprop ro.serialno` for a `host:port` id in `device` state. It is still gated on the inventory showing the hub port's server, and the whole probe is bounded at 5 s, with its timer and sockets cleared. No adb binary, `findPhone`, `start-server`, `connect` or `mdns`.
- `hub-device status` keeps its text output byte-for-byte; `--json` prints `statusView` output. The CLI resolves the key with `claims.hostKey` (a `hostKey` seam on `main`) and passes null on `HUB_HOST_UNKNOWN`; status never fails for a missing key.
- `policy.json` gains `"registry": { "reachability_max_age_s": 60 }`. `parsePolicy` requires the block and refuses an unknown or missing key, or a value that is not a positive whole number.
- Node 24 ESM with built-ins only. Tests are hermetic: temp dirs, injected `adbWire`/`devicectl`/`hostKey`/`now`, and an in-test TCP fake adb server for the child-process tests. They never reach a real adb server (5037), devicectl or a real host key.

**Never:**
- No write to the lock dir or Event Log from status. No `noteReachability`, no reachability event, no refresh, timer or cache.
- No change to the deploy path (`tools/ci/commands/*`, `tools/catchup/*`). `pickIpad`'s return value and error messages stay byte-identical (`v3.test.mjs` pins them); errors gain only an additive `reason`.
- No new rows (Resource rows, deploy-target marks and the iPad row are Story 5.5), no discovery (5.6), no Pool view (5.8), no `api` policy block, no text-output change.
- No `lease`/`run` behaviour change: an `unauthorized` phone still exits 75 (`hub-device.test.mjs:403-411`).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Phone listed `device` | key `linux`, wire lists s26 `device` | s26 row `presence: reachable`, `reachability.state: reachable`, `checked_at` = probe time, `age_ms` 0, `stale` false | — |
| Phone unauthorized/offline | wire state `unauthorized`/`offline` | presence = raw state; reachability same | — |
| Phone not listed | wire answers without it | presence `absent`; reachability `absent` | — |
| No hub adb server | inventory lacks the hub port | presence `no adb server`; reachability `unknown`; no socket opened | — |
| Wire fails / hangs | `version` rejects, or no answer in 5 s | presence `adb did not answer`; reachability `unknown`; timer cleared | never fails status |
| `host:port` id | `192.168.1.50:41234 device`, getprop → `R5GL43A7PCH` | that phone matched and `reachable` | unreadable serial → not matched |
| Unknown host key | no key file | every reachability `{unknown, null, null, true}`; presence as today | — |
| Mac with ios-lane row | key `mac`, `mac-ios` held, fake devicectl paired+booted | lock row `resource: ios-lane`, `reachable` | devicectl throws → `unknown` |
| Non-Resource lock | `s3-index.lock` held | row `resource: null, reachability: null` | — |
| Free `emulator-3`/`res-foo` queue | queue dir, no lock | its waiters listed | `emulator-9` (> MAX_POOL) skipped |
| Broken policy | `policy: {queue: {}}` | status exits 0, readings `stale: true`, `eta` null | — |
| Bad policy block | missing/extra/zero/text `reachability_max_age_s`, missing block | `parsePolicy` throws naming the key | — |

</intent-contract>

## Code Map

- `tools/device/claims.mjs` -- L460-571 `phonePresence` + `statusData`: the builder to become `statusView`. Imports L13-20 (add `resourceOf` from lock.mjs, `MAX_POOL` from emulator.mjs, `createAdbWire`, `loadDevices` already, `createDevicectl`, reachability exports). `createContext` L78 gains `adbWire`, `devicectl`. Header comment L1-8 lists the context keys.
- `tools/device/hub-device.mjs` -- L297-357 `status`: the only change is `claims.statusData(context)` → resolve key + `claims.statusView(key, {audience:'local'}, context)`. `main` L460 options gain `adbWire`, `devicectl`, `hostKey` seams passed to `createContext`. Text rendering untouched.
- `tools/device/adb-wire.mjs` -- `createAdbWire(port, {signal})`: add `devicesLong()` (`host:devices-l`, 5 s) and export `parseDevicesLong(text)` → `[{id, state, model, product, device, transport_id}]`. `version()` and `shell()` exist. emulator.mjs L572 uses `devices()`; keep it.
- `tools/ci/lib/devicectl.mjs` -- `pickIpad` L26-48: refactor into exported `inspectIpad(document, {udid, model})` returning pickIpad's fields + `proven` + `boot_state` (`deviceProperties.bootState ?? null`), with `reason` on each thrown Error (`not-listed`, `unpaired`, `developer-mode`, `identity`). `pickIpad` = `inspectIpad` minus the two extra keys. Messages unchanged.
- `tools/ci/lib/lock.mjs` -- read only: `resourceOf` L57, `SEED_RESOURCES` L55, `RESERVABLE` L595, `queueView` L823, `listLocks` L1496, `lockDir` L26.
- `tools/device/emulator.mjs` -- read only: `MAX_POOL` L33, `GATE` L29.
- `tools/ci/lib/policy.mjs` -- `parsePolicy` L159-162 top-level `exact` list (add required `registry`); add `registryBlock` beside `queueBlock` L291.
- `tools/ci/policy.json` -- add the `registry` block after `queue`.
- `tools/device/hub-device.test.mjs` -- fixture L56-77 (`run` injects `inventory`; add a fake `adbWire` mirroring `fakeAdb`'s away/unauth flags). Named intended changes: L471-500 and L502-541 (child-process decoy tests now need an in-test TCP fake adb server on the hub port and assert the adb binary is never run), L1004-1044 (`/^devices$/` on the binary becomes the fake wire's `host:devices-l`). L1237-1255 stays byte-identical.
- `tools/device/claims.test.mjs` -- L53 pinned export list (`statusData` → `statusView`), L343-357 status test → `statusView(null, {audience:'local'}, ctx)`. Named intended changes.
- `tools/ci/policy.test.mjs` -- L158 pattern for a strict-block test.
- `tools/ci/v3.test.mjs` L496-506 -- pins `pickIpad`; must stay green unchanged.
- `tools/deploy-path.test.mjs` -- `FORBIDDEN` already has `tools/registry/`; `devicectl.mjs` is not forbidden; must stay green.
- `README.md` L253 -- documents status's PHONES query (`adb devices` + mDNS): update to the wire and the new `--json` fields.

## Tasks & Acceptance

**Execution:**
- `tools/registry/reachability.mjs` -- NEW: `REACHABILITY`; `phoneReachability(observed)`; `ipadReachability({result}|{error})`; `readIpad({list, udid, model})` (list failure → unknown, else `inspectIpad` → mapper); `stamp(state, {checkedAt, receivedAt, ageMsAtReceipt})` (rejects a non-enum state); `present(stored, {now, maxAgeS})`; `MISSING`. Pure, no timers, no I/O beyond the injected `list`. -- AD-35's one mapping owner.
- `tools/ci/lib/devicectl.mjs` -- `inspectIpad` plus error `reason`s, with `pickIpad` delegating to it and keeping its exact output. -- lets the iPad map without reading `tunnelState`.
- `tools/device/adb-wire.mjs` -- `devicesLong` + `parseDevicesLong`. -- the read-only phone transport.
- `tools/device/claims.mjs` -- replace `phonePresence` with a wire probe that returns per-phone observations (`device`/state/null/note) and the check time. Replace `statusData` with `statusView` (walk set, rows + `resource`/`reachability`, host-owned readings, audience handling, policy max age read without failing). Add the `adbWire`/`devicectl` context keys and update the header. -- the one builder.
- `tools/device/hub-device.mjs` -- `status` calls `statusView` with the soft-resolved key; add the `adbWire`, `devicectl` and `hostKey` seams to `main`; update the header comment. -- the CLI front door.
- `tools/ci/lib/policy.mjs`, `tools/ci/policy.json` -- the strict `registry` block. -- AD-46.
- `tools/registry/reachability.test.mjs` -- NEW: phone and iPad mapper tables (every row above, including `reason`-less errors and wrong-model records), `readIpad` with a throwing/timeout `list`, `stamp`/`present` (age on the reader's clock with skewed `received_at`, stale at max age + 1 ms, missing reading, bad max age), a check that `inspectIpad` never reads `tunnelState` for its verdict (a record that differs only in tunnelState maps the same), and a check that `pickIpad`'s output equals `inspectIpad` minus `proven`/`boot_state`.
- `tools/device/status-view.test.mjs` -- NEW: hermetic `statusView` and CLI cases. Root keys and v1a values equal to the same build with the reachability fields removed. Every I/O matrix row. A walk of `emulator-3`/`res-foo` queues and the skipped `emulator-9`. The service-audience redaction. An unknown audience giving `HUB_USAGE`. A fake `exec`/`adbFactory` and `HUB_ADB` binary that record no argv at all (no `start-server`, `connect`, `mdns`), with the wire requests limited to `host:version`, `host:devices-l`, `host:transport:*` and `shell:getprop ro.serialno`. The lock dir and Event Log byte-identical (sha256 of every file) before and after `status` and `status --json` with a Lease, a job waiter, a Reservation and `res-*`/`emulator-<n>` queues. The CLI's `hostKey` seam: a missing key still exits 0. An `unauthorized` s24 `lease` still exits 75 with `HUB_DEVICE_AWAY s24`.
- `tools/device/hub-device.test.mjs`, `tools/device/claims.test.mjs` -- the named intended changes in the Code Map; nothing else.
- `tools/ci/policy.test.mjs` -- the `registry` block is strict, with every refusal in the matrix and the shipped value 60.
- `README.md` -- the status paragraph names the wire transport, `resource`/`reachability`, and `registry.reachability_max_age_s`.

**Acceptance Criteria:**
- Given `tools/registry/reachability.mjs`, when presence is mapped, then each phone and iPad case maps as Always states, in one function per transport, with a table test.
- Given `statusView(hostKey, {audience: 'local'})`, when it is built, then it walks only the lock dir (no service, no `registry.json`), its root keys and every v1a value are exactly today's, and each row has additive `resource` and `reachability` `{state, checked_at, age_ms, stale}` with `presence` beside it.
- Given a reading, when it is read, then `stale` comes from its age on the reader's clock and is never stored; a missing reading, or one older than `registry.reachability_max_age_s`, is shown with its age and never as current; and status starts no refresh and no adb server.
- Given the phone transport, when status reads it, then only the wire requests listed in Always are made, and a fake `exec` shows no `start-server`, `connect` or `mdns` argv.
- Given an `unauthorized` phone, when `lease` is attempted, then it exits 75.
- Given `status`, when the hermetic suite runs it, then the Event Log and lock dir are byte-identical before and after.
- Given `policy.json`, when it is parsed, then `registry: {reachability_max_age_s: 60}` is required and strict.

## Spec Change Log

## Review Triage Log

### 2026-11-25 — Review pass
- verdicts: 35 findings — high 0, medium 2, low 9, false 23, maybe-false 1
- findings:
  - `[false]` `[reject]` Service redaction fails open when `qa_ids` is omitted — the intent contract defines `qa_ids = []` as the default, and no service caller exists yet; an empty QA set redacting nothing is the specified behaviour.
  - `[false]` `[reject]` Redaction misses `locks[].emulator`, `inventory`, `why`/`holder` — those carry pool serials (`emulator-5554`, console ports), pids and free text, not a QA device's serial, UDID or adb id; the identifying keys the contract names are all nulled.
  - `[false]` `[reject]` A probe that could not say is stamped as a fresh `unknown` with `stale: false` — the probe did run, so it is a reading, not a missing one; the state stays `unknown` (never reachable), and the README says `unknown` means "nobody checked, or the transport could not say".
  - `[false]` `[reject]` Freshness machinery has no live effect (age always ~0) — readings taken by this reader have age 0 by definition; the stored `age_ms_at_receipt`/`received_at` shape is what lets a relayed reading age correctly, and the README's claim (age on the reader's clock) is accurate.
  - `[false]` `[reject]` `checked_at` is taken after the probe — the state is what `host:devices-l` answered, which arrives at the end of the probe, so the end is when it was read.
  - `[low]` `[reject]` Mac iPad read can block status up to ~40 s — `devicectl list devices` lists CoreDevice's known devices without waiting on the iPad, so the hard kill only matters if CoreDevice itself wedges; the spec chose the 10 s call, and an async runner adds complexity for a rare case.
  - `[false]` `[reject]` adb states beyond the four named ones fall to `unknown`; `no permissions` reads as `no` — the contract maps anything else to `unknown`, and v1a's `adb devices` parser also split the state on whitespace, so presence is unchanged.
  - `[false]` `[reject]` Reachability is invisible in the text status — the story asks for `hub-device status --json`, and the contract forbids a text-output change.
  - `[false]` `[reject]` A free iPad shows no reachability — no row names it until Story 5.5 adds Resource rows (contract's Never); with no row there is nothing to show.
  - `[false]` `[reject]` `pickIpad`'s `void proven; void boot_state` and the deploy-path change — no bad outcome: `void` is the unused-binding idiom, `pickIpad`'s output and messages are pinned by `v3.test.mjs` (green) and the new parity test, and an additive `reason` is permitted.
  - `[false]` `[reject]` Broken policy and iPad failures are swallowed silently — the matrix requires a broken policy to leave status exiting 0; a broken `policy.json` is refused loudly by every gate and by `policy.test.mjs`, and the enum has one word for "could not say".
  - `[false]` `[reject]` An unknown host key reads nothing without a signal — `checked_at: null, stale: true` is the documented "nobody checked" signal, and status must never fail for a missing key.
  - `[low]` `[reject]` The freshness-limit test depends on how often `now()` is called — deterministic today; a future extra call fails loudly in that test, a test-only cost not worth a rewrite.
  - `[false]` `[reject]` `s.rows(...)` is called after `s.cleanup()` — `rows` is a pure mapping over the returned view and reads nothing from disk.
  - `[medium]` `[patch]` No test for a hung `ro.serialno` read (with fan-out failure) — same root as the wedged-serial-read finding below; fixed and covered there.
  - `[maybe-false]` `[reject]` `elapsed < 1500` child-process assertion is flaky under load — pre-existing (present at baseline in `hub-device.test.mjs`) and never seen failing; settling it needs repeated loaded runs, and if true it is only low.
  - `[false]` `[reject]` The required `registry` block breaks older `policy.json` copies — each hub pin ships its own `policy.json`, and AD-46 makes the block required and strict by design.
  - `[medium]` `[patch]` One wedged `host:port` phone's serial read (15 s wire timeout) loses the whole 5 s probe, so every phone reads `adb did not answer` — patched: each serial read in `readWire` now races its own 1.5 s `timing.sleep` on the probe's `giveUp` signal and counts as unmatched on timeout; new `hangShell` fake option and a status-view test (other phone stays reachable, timers and sockets aborted).
  - `[low]` `[defer]` A phone listed twice takes the first entry's state — pre-existing find-first semantics from v1a `phonePresence`; deferred.
  - `[false]` `[reject]` Service sees `locks[].emulator` serial/adb ids — same refutation as the redaction finding above: pool serials are not a QA device's identifiers.
  - `[low]` `[patch]` `statusView(key, null, ctx)` throws TypeError instead of `HUB_USAGE` — patched: destructures `options ?? {}`; null added to the HUB_USAGE test.
  - `[low]` `[reject]` `present` with a non-finite `now` gives NaN age and `stale: false` — unreachable: `now` is always `timing.now()` (Date.now or an injected clock); the fix is a new guard.
  - `[false]` `[reject]` iPad ignores `tunnelState`, so a disconnected tunnel reads reachable — the contract (AD-35) forbids reading `tunnelState`: the tunnel is the transport's state and comes up on demand.
  - `[false]` `[reject]` `unknown` notes stamped fresh instead of missing — duplicate of the Blind Hunter claim; same refutation.
  - `[false]` `[reject]` `readAt` after the probe understates staleness — duplicate; same refutation.
  - `[low]` `[reject]` Synchronous devicectl blocks status for tens of seconds — duplicate of the Mac-block finding; same reason.
  - `[low]` `[reject]` Removing the mDNS tie-back turns a bare `host:port` id in unauthorized/offline state from that state into `absent` — real, but the contract forbids mDNS and the Design Notes record this; such a phone is unusable either way and wireless debugging implies authorization, so it is rare, and the fix needs another transport.
  - `[low]` `[reject]` `presence` therefore changes value for those phones — same root and reason as the row above.
  - `[low]` `[patch]` The Mac iPad read is untested for a `mac-ios` waiter-only or Reservation-only row — patched: one new test covers a queue ticket and a Reservation with the lock free under key `mac`, asserting one devicectl call and a current `reachable` reading on the row.
  - `[false]` `[reject]` (intent) Text status does not show Reachability — the story's surface is `--json`.
  - `[false]` `[reject]` (intent) Phones read `unknown` on the Mac or with an unknown key — readings are taken only on the owning host, as the contract requires; `presence` is still shown.
  - `[false]` `[reject]` (intent) The real `claims.hostKey` is never exercised — the CLI test runs `status --json` with no `hostKey` seam and no key file, so the real resolver reports HUB_HOST_UNKNOWN and status exits 0.
  - `[false]` `[reject]` (intent) A stale reading keeps its state, not demoted to `unknown` — the AC says "shown with its age and never as current", which `stale: true` does.
  - `[false]` `[reject]` (intent) `presence` and `reachability` both appear on each row — the contract requires `presence` to stay beside the new field.
  - `[false]` `[reject]` (intent) Strict `registry` block makes fixtures without it throw — required by AD-46; status survives via `policyOf()`, as the matrix's broken-policy row requires.

## Design Notes

- Why the wire replaces `adb devices` + `adb mdns services`: the AC forbids mdns argv and any adb-client exec in status. A `host:port` id is tied to its phone by reading `ro.serialno` over the wire, as AD-35 prescribes for discovery. One that cannot be read (unauthorized or offline) is not matched, so that phone reads `absent`.
- The inventory gate stays. With no hub-port server in `/proc`, no socket is opened, which keeps "with no adb server running, does not ask adb at all" literally true and makes the Mac (no `/proc`) behave as it does today.
- Readings exist only for Resources whose host is this key. The emulator Pool and `res-*` Resources have no transport yet, so their reading is missing. That is honest: "nobody checked" is `unknown` with `stale: true`, never reachable.
- The iPad is probed only when a row names `ios-lane`. Story 5.5 adds the always-present Resource rows; until then, probing an iPad nobody shows would only cost status a devicectl call (up to 40 s) for no output.

## Verification

**Commands:**
- `node --test tools/registry/reachability.test.mjs tools/device/status-view.test.mjs tools/device/hub-device.test.mjs tools/device/claims.test.mjs tools/ci/policy.test.mjs tools/ci/v3.test.mjs tools/deploy-path.test.mjs` -- expected: all pass
- `mise run check` -- expected: actionlint clean, full suite green

## Auto Run Result

Status: done

**Summary.** `hub-device status` now runs on one builder, `claims.statusView(hostKey, {audience, qa_ids}, ctx)`, which replaces `statusData`.
- The root keys, the v1a keys and their values, and the text output are all unchanged.
- Every row of `phones`, `locks`, `waiters`, `reservations` and `emulators` gains `resource` (from `resourceOf`) and `reachability` (`{state, checked_at, age_ms, stale}`). Both are null for a lock that is not a Resource.
- The walk also covers free `res-<slug>` and `emulator-<n>` queues, with n up to MAX_POOL. It never walks a service or `registry.json`.
- Phones are read over the read-only adb wire only (`host:version`, `host:devices-l`, plus `ro.serialno` for bare `host:port` ids). There is no adb binary, `start-server`, `connect` or mDNS. The read happens only when the inventory shows the hub's server, and it is bounded at 5 s, with each serial read bounded at 1.5 s.
- Readings are taken only on the host that owns the Resource. `linux` reads the phones. `mac` reads the iPad through `devicectl`, and only when a row names `ios-lane`. A null key reads nothing.
- `stale` is derived from the age on the reader's clock against the new strict policy key `registry.reachability_max_age_s` (60). It is never stored.
- A `service` audience nulls the serial, UDID and adb id of `qa_ids` Resources. Any other audience is `HUB_USAGE`.

**Files changed.**
- `tools/registry/reachability.mjs`: new. The AD-35 enum, the phone and iPad mappers, `readIpad`, `stamp`, `present` and `MISSING`.
- `tools/registry/reachability.test.mjs`: new. Mapper tables, stamp/present, the tunnelState independence check and pickIpad parity.
- `tools/device/claims.mjs`: `statusView` replaces `statusData`, with the wire probe, `walkSet`, `redact`, audiences, host-owned readings, and the `adbWire`/`devicectl`/`hostKey` context keys.
- `tools/device/hub-device.mjs`: `status` resolves the host key softly (null on HUB_HOST_UNKNOWN) and calls `statusView`. `main` gains the `adbWire`, `devicectl` and `hostKey` seams.
- `tools/device/adb-wire.mjs`: `devicesLong()` and `parseDevicesLong()`.
- `tools/ci/lib/devicectl.mjs`: `inspectIpad` (pickIpad plus `proven` and `boot_state`, with errors carrying `reason`). `pickIpad` delegates to it, and its output is byte-identical.
- `tools/ci/lib/policy.mjs` and `tools/ci/policy.json`: the strict `registry` block.
- `tools/ci/policy.test.mjs`: registry block strictness.
- `tools/device/status-view.test.mjs`: new. Hermetic statusView and CLI cases: every matrix row, audiences, wire-only requests, byte-identical lock dir and Event Log, the host-key seam, and unauthorized `lease` exiting 75.
- `tools/device/wire-fixtures.mjs`: new. `fakeWire`, `fakeAdbServer` and `fakeHub` test doubles.
- `tools/device/hub-device.test.mjs` and `tools/device/claims.test.mjs`: the named fixture and export changes only.
- `README.md`: the status paragraph covers the wire transport, `resource`/`reachability` and the policy key.

**Review findings.** 35 in total: high 0, medium 2, low 9, false 23, maybe-false 1.

Patches applied:
- **Medium (grouped):** one wedged `host:port` serial read no longer voids the whole probe. Each read has its own 1.5 s bound, and a test covers it.
- **Low:** `statusView(key, null)` is now refused as HUB_USAGE instead of throwing a TypeError.
- **Low:** new tests for a Mac `mac-ios` row that is only a waiter or only a Reservation.

Deferred: the find-first match for a phone listed twice. This is low and predates this story.

Rejected, with reasons as recorded in the Review Triage Log:
- **False (23):**
  - Redaction concerns: fail-open with no QA set, and the emulator, inventory and free-text fields.
  - Probe readings: an `unknown` probe result treated as fresh, the age always being 0, and `checked_at` taken at the end of the probe.
  - State mapping: other adb states, `tunnelState`, and a stale reading keeping its state.
  - Surface: the text output, a free iPad with no row, and the unknown-key signal.
  - Code and policy: pickIpad's `void`, silent policy errors, the required `registry` block, and `rows` called after cleanup.
  - The intent-alignment divergences.
- **Low (6):**
  - The devicectl blocking time. `list devices` does not wait on the device.
  - The freshness test counting `now()` calls.
  - A NaN `now` in `present`, which cannot be reached.
  - The mDNS tie-back removal, recorded twice. The contract forbids mDNS, the case is rare, and that phone is unusable either way.
- **Maybe-false (1):** the pre-existing `elapsed < 1500` flake claim. It has never been seen failing, and it would only be low.

**Follow-up review recommendation:** false. This was the first pass, and it patched 0 high and 1 medium entry; the other patches were low. A follow-up would need a high, or two or more mediums.

**Verification.**
- `node --test tools/registry/reachability.test.mjs tools/device/status-view.test.mjs tools/device/hub-device.test.mjs tools/device/claims.test.mjs tools/ci/policy.test.mjs tools/ci/v3.test.mjs tools/deploy-path.test.mjs` gave 190 out of 190 passing after the patches.
- `mise run check` exited 0 with 801 out of 801 tests passing and actionlint clean.
- The matrix test audit passed: every I/O row has a covering test that ran and passed.

**Residual risks.**
- On the Mac, the iPad read uses the synchronous devicectl runner. A wedged CoreDevice could hold `status` for up to about 40 s, but only while a row names `ios-lane`.
- A bare `host:port` phone in unauthorized or offline state now reads `absent`, because mDNS is no longer used.
- Until Story 5.10 writes the host key files, every live `status --json` shows readings as missing (`unknown`, stale). That output is honest, but it contains no live reachability yet.
- There are no operator actions. The release is Story 5.10.
