---
title: 'Deploy targets are marked, from the committed declarations'
type: 'feature'
created: '2026-11-25'
status: 'done'
baseline_revision: '4e1e835a1d65b4f0c6521eb706de6e95e5da3610'
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-5-context.md'
warnings: ['oversized']
deferred:
  - summary: >-
      An android_extra phone other than the S24 gets resource null, and so deploy_target null, on every status row, because resourceOf's seed map is the fixed {adb, s24, mac-ios}.
    evidence: |-
      resourceOf (lock.mjs, Story 5.2) maps only the committed seed's locks, and an extra phone such as `Pixel` (lock `pixel`) already read resource null under Story 5.4. Story 5.5 only derives deploy_target from that resource. This is the known pre-existing gap where a non-S24 devices.json phone sits on a bare lock, and fixing it needs the decision on whether new phones are added in devices.json or through the Registry. seed.test.mjs and names.test.mjs fail the moment devices.json changes, so it cannot ship silently.
    location: >-
      tools/ci/lib/lock.mjs:57 (resourceOf); tools/device/claims.mjs statusView rowsOf loop
    severity: low
---

<intent-contract>

## Intent

**Problem:** `hub-device status --json` marks the deploy phone only on `phones[]` (`deploy`), so a `locks`, `waiters`, `reservations` or `emulators` row cannot say whether it sits on a deploy target, and the text output never warns that a held or waited-on lock is one deploys install to. The Resources `devices.json` declares are derived in two places (`claims.fleetOf` and the hand-kept maps in `lock.mjs`), with no in-memory seed for the matcher (5.7) and Hub API (Epic 6), and nothing in the hub reads the private QA file through a seam (FR-29, FR-3, AD-28, AD-30).

**Approach:** Add `tools/registry/seed.mjs`: a pure `seed(devices, {qaDevices})` that derives the seeded Resources (records shaped like the spine's Registry record), the `phone` Pool from `PHONE_POOL_SEED`, and `dedicated_qa` marks from a `qaDevices` loader seam. `claims.fleetOf` derives from it. `statusView` adds `deploy_target` to every row from the seed. The text status prints one `DEPLOY TARGET` line per deploy target that is held, waited on or reserved.

## Boundaries & Constraints

**Always:**
- `seed(devices, {qaDevices = defaultLoader} = {})` returns `{resources, pools, warnings}` and never mutates `devices`. Resources, in this order:
  - each `android_extra` phone: `id = lock = name.toLowerCase()`, `kind: 'phone'`, `host: 'linux'`, `deploy_target: false`;
  - the deploy phone: `id: 's26'`, `lock: 'adb'`, `kind: 'phone'`, `host: 'linux'`, `deploy_target: true`;
  - `ios-lane`: `lock: 'mac-ios'`, `words: ['ipad', 'mac']`, `kind: 'ios-lane'`, `host: 'mac'`, `identity: {udid, model}`, `deploy_target: true`;
  - the emulator Pool: `id = lock = 'emulator'`, `kind: 'emulator-pool'`, `host: 'linux'`, `deploy_target: false`.
- Every record has the keys `{id, lock, name, words, display_name, kind, host, identity, capabilities, deploy_target, seeded}`. A phone's `identity` is `{serial, model}`. `seeded` is true. An extra phone's name goes through `nameRefusal`, and a refused one throws the plain Error `devices.json: android_extra[].name may not be "<name>" (<reason>)`, today's `fleetOf` message.
- `PHONE_POOL_SEED = Object.freeze(['s24', 's26'])`. `pools.phone = {members, named: true}`, where `members` is `PHONE_POOL_SEED` filtered to the ids the seed has. A `dedicated_qa` mark never removes a member. `pools.emulator = {gate: 'emulator'}`.
- `qaDevices` is a function returning `[{name, model, serial}]`, called once per `seed`. The default `loadQaDevices({env, home, readFile})` reads `env.HUB_QA_DEVICES`, else `<home>/.config/mobile-deploy-hub/qa-devices.json`.
  - A missing file gives `[]`.
  - Unparsable JSON, a schema other than 1, a `devices` value that is not an array, or an entry without a valid `serial` (`/^[A-Za-z0-9]+$/`) or `name` throws `code: 'HUB_QA_DEVICES'`. The message names the file and the entry index, never a serial.
  - It returns only `name`, `model` and `serial`, so `allowed_users` and every other key are dropped.
- A QA entry is matched to a phone by serial:
  - an extra phone gets `capabilities.dedicated_qa = true`;
  - the deploy phone is skipped with a warning (it can never be dedicated);
  - an entry matching no phone becomes a runtime record: `id = lock = 'res-' + slug`, where `slug` is the lowercased name, which must pass `nameRefusal`. It gets `kind: 'phone'`, `host: 'linux'`, `seeded: false`, `deploy_target: false`, `capabilities: {dedicated_qa: true}`;
  - a name that is refused, or already used by another record, is skipped with a warning.
  - Warnings name the entry, never a serial.
- `dedicatedQaIds(seeded)` returns the ids with `capabilities.dedicated_qa === true`. It is the `qa_ids` a service caller passes.
- `claims.fleetOf(devices)` builds from `seed(devices, {qaDevices: () => []})`'s phones. Its output and errors stay identical: `[{device, lock, deploy, name, serial, model}]`, extras first, `name` the display name. Neither the CLI nor `statusView` ever reads the QA file.
- `statusView` builds the seed once from `loadDevices(env)` with no QA. Every row of `phones`, `locks`, `waiters`, `reservations` and `emulators` gains `deploy_target` right after `resource` and before `reachability`. Its value is the seeded record's `deploy_target` when `resource` is seeded, `false` for any other Resource (`res-*`), and `null` when `resource` is null. Every other key and value is unchanged, on both audiences.
- In text status, the block is placed after WAITERS (and its `none`) and before RESERVATIONS. It has one unindented line per deploy-target resource, in first-seen order across `locks`, `waiters` and `reservations`, and only when that resource has a lock row, a non-stale waiter or a non-stale Reservation:
  `DEPLOY TARGET <resource> (lock <lock>)  <held>  <n> waiting[  <r> reserved]  deploys install here; a lease on it holds deploys back`. Here `<held>` is one of:
  - `held by LEASE <lease_id> holder=<holder>`;
  - `held by JOB LOCK <repo|a local run> run <run|->`, with `  [stale]` appended when the lock row is stale;
  - `free`.
- `hermetic()` creates a temp `qa-devices.json` (`{"schema":1,"devices":[]}`) once per process and sets `process.env.HUB_QA_DEVICES` to it.

**Never:**
- No change to `lock.mjs`'s `SEED_RESOURCES`, `DEPLOY_TARGETS` or `resourceOf`, and no `lock.mjs` import of `tools/registry`. No `registry.json` read or write, no Hub API, no host records (ids `linux`/`mac` would collide with the `mac` word; Epic 6), no matcher or `match.mjs` flag (5.7), no discovery (5.6).
- No change to the deploy path (`tools/ci/commands/*`, `tools/catchup/*`) or to `devices.json`. The nine-line nothing-held fixture (`hub-device.test.mjs` "status with nothing held") stays byte-identical, and no existing text line changes.
- Never put a QA serial in a warning, an error message, a committed file or any `statusView` output beyond what `devices.json` already holds. Never import `allowed_users`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Committed seed | `devices.json`, no QA | resources `s24, s26, ios-lane, emulator`; deploy targets `s26, ios-lane`; `pools.phone.members` `[s24, s26]` | — |
| No `android_extra` | devices without it | resources `s26, ios-lane, emulator`; phone Pool `[s26]` | — |
| Reserved extra name | `android_extra[0].name: 'Adb'` | plain Error `devices.json: android_extra[].name may not be "adb" (...)` | thrown, no `code` |
| QA names S24 serial | QA `[{name:'S24', serial:S24, allowed_users:[0]}]` | s24 `capabilities.dedicated_qa: true`, still first in `pools.phone`; `dedicatedQaIds` `['s24']`; no `allowed_users` anywhere | — |
| QA names S26 serial | QA entry with the deploy serial | s26 unmarked; one warning, no serial in it | — |
| QA unknown phone | `{name:'Pixel', serial:'ABC123'}` | runtime `res-pixel`, `seeded:false`, `dedicated_qa:true`, not in the phone Pool | — |
| QA bad name / clash | `name:'Pixel 7'` or a non-S24 serial named `S24` | skipped with a warning | — |
| QA file missing | no file at the path | `[]` | — |
| QA file broken | bad JSON, schema 2, bad serial | throws `HUB_QA_DEVICES` naming file and index | no serial in the message |
| Rows marked | adb held + job waiter + Reservation, an emulator lease, `res-foo` waiter, `s3-index` held | s26 rows `deploy_target: true`; s24 and emulator rows `false`; `res-foo` `false`; `s3-index` `null` | — |
| Mac rows | key `mac`, `mac-ios` held | lock row `resource: ios-lane, deploy_target: true` | — |
| Text: free | nothing held | nine-line fixture unchanged, no `DEPLOY TARGET` line | — |
| Text: held/waited | lease on adb, one live waiter, one Reservation | `DEPLOY TARGET s26 (lock adb)  held by LEASE held holder=agent-a  1 waiting  1 reserved  deploys install here; ...` between WAITERS and RESERVATIONS | — |
| Text: s24 held | lease on s24 only | no `DEPLOY TARGET` line | — |

</intent-contract>

## Code Map

- `tools/registry/seed.mjs`: new. Imports `nameRefusal` from `../ci/lib/lock.mjs` and `homedir`/`readFileSync`/`join`. Must not import `claims.mjs`.
- `tools/registry/reachability.mjs`: style reference for module headers and frozen exports.
- `tools/device/claims.mjs`:
  - L95-108 `fleetOf` is to become a projection of the seed. Keep its comment intent, which now reads "nothing but the seed reads android_extra".
  - L111 `loadFleet` is unchanged.
  - L629-631 is the `rowsOf` loop that sets `resource`: add `deploy_target` there.
  - L15 already imports `loadDevices`.
  - Do not add exports. `claims.test.mjs` L53 pins functions by presence only, but keep the surface unchanged.
- `tools/device/hub-device.mjs` L297-357 `status`: add the DEPLOY TARGET lines after the WAITERS loop (L339) and before `if (reservations.length > 0)` (L341). Output only; it reads `result` rows.
- `tools/ci/lib/lock.mjs`: read only.
  - L55 `SEED_RESOURCES` and L57 `resourceOf`.
  - L415 `DEPLOY_TARGETS`.
  - L66 `nameRefusal`, whose message reasons are reused.
- `tools/ci/lib/devices.mjs` L67 `loadDevices(env)` honours `HUB_DEVICES`. `parseDevices` validates `android_extra` already.
- `tools/ci/test-fixtures.mjs` L27-42 `hermetic()`: add the QA scratch file beside `eventScratch`/`lockScratch`. It already deletes every `HUB_*` var first.
- `tools/device/status-view.test.mjs`:
  - L101 key-order assertion `[...keys, 'resource', 'reachability']` and the L103 `strip` helper are named intended changes: insert `deploy_target`, and strip it.
  - `side()` L47 is the fixture to reuse for new cases.
- `tools/device/hub-device.test.mjs`:
  - L1227-1244 is the nine-line fixture, which must stay green untouched.
  - L1096-1097 asserts `lines[indexOf('RESERVATIONS') + 3]` is INVENTORY, so the new line must sit before RESERVATIONS.
  - L424-435 scans the deploy side for `android_extra`, and `tools/registry` is outside it.
- `tools/ci/names.test.mjs` L87-96 (fleetOf refusals and order) and L114-125 (seed map vs devices.json) must stay green unchanged.
- `tools/deploy-path.test.mjs`: `FORBIDDEN` has `tools/registry/`, and it must stay green.
- `README.md` L239 (Dedicated QA phones) and L253 (status paragraph): document `deploy_target`, the DEPLOY TARGET line, and that the seed reads the QA file only through its loader (`$HUB_QA_DEVICES`), never the CLI or status.

## Tasks & Acceptance

**Execution:**
- `tools/registry/seed.mjs`: NEW. `PHONE_POOL_SEED`, `QA_DEVICES_FILE`, `qaDevicesPath(env, home)`, `loadQaDevices`, `seed`, `dedicatedQaIds`, `deployTargetIds(seeded)` (Set of ids) and `deployTargetLocks(seeded)` (locks in seed order). It is the AD-30 seed and the one derivation from `devices.json`.
- `tools/device/claims.mjs`: `fleetOf` projects the seed. `statusView` marks `deploy_target`. Update the status header comment.
- `tools/device/hub-device.mjs`: print the DEPLOY TARGET line(s).
- `tools/ci/test-fixtures.mjs`: point `hermetic()` at a temp QA file.
- `tools/registry/seed.test.mjs`: NEW. Cover every seed/QA matrix row. Also cover:
  - `DEPLOY_TARGETS` deep-equals `deployTargetLocks(seed(loadDevices()))`, and `SEED_RESOURCES` equals the seed's `{lock: id}` for non-Pool records;
  - `resourceOf(r.lock) === r.id` for each seeded record;
  - `fleetOf` equals the seed's phones projection;
  - `PHONE_POOL_SEED` is frozen and equals `fleetOf(devices).map(p => p.device)`;
  - the loader is called exactly once;
  - the loader output keys are exactly `name, model, serial`;
  - `JSON.stringify(seed(...))` contains no `allowed_users`;
  - after `hermetic()`, `HUB_QA_DEVICES` names an existing file under `tmpdir()`, and a `readFile` spy passed to `loadQaDevices` sees only that path, never `join(homedir(), QA_DEVICES_FILE)`;
  - a child process (env from `process.env` plus a temp `HOME` holding a sentinel `qa-devices.json`) prints a seed with no sentinel serial and no `dedicated_qa`. A control run without `HUB_QA_DEVICES` does pick the sentinel up, which proves the test can see a read.
- `tools/device/status-view.test.mjs`: the named L101/L103 changes. New cases:
  - the "Rows marked" and "Mac rows" matrix rows;
  - local status with a QA-marked s24 keeps every v1a key and value, while `service` with `dedicatedQaIds(...)` redacts it;
  - the three text rows (held/waited/reserved line, s24-only no line, a stale-free nothing-held run with no line).
- `README.md`: document the above.

**Acceptance Criteria:**
- Given `seed(devices, {qaDevices})`, when called on the committed `devices.json`, then it derives `s26` (lock `adb`), `ios-lane` (lock `mac-ios`, words `ipad` and `mac`), `s24` (lock `s24`) and the emulator Pool with fixed ids, locks and names, and a test asserts `lock.mjs`'s `DEPLOY_TARGETS` equals the deploy-target set it derives.
- Given `status --json`, when it lists a seeded Resource, then the row's additive `deploy_target` is true for `s26` and `ios-lane` and false for `s24` and the emulator slots, with every v1a key and value kept.
- Given text status, when a deploy target is held or waited on, then one `DEPLOY TARGET` line says so. When none is, the output is exactly today's, including the nine-line fixture.
- Given the private QA file, when the seed reads it, then it does so only through the `qaDevices` seam, `hermetic()` points that seam at a temp file, the real path is never opened, each phone it names gets `dedicated_qa`, and `allowed_users` is never imported.
- Given `PHONE_POOL_SEED`, when the seed builds the `phone` Pool, then it is `[s24, s26]` with the S24 first even when it is `dedicated_qa`.
- Given local status, when a `dedicated_qa` phone is listed, then it keeps every v1a key and value, and only the `service` audience redacts it.

## Spec Change Log

## Review Triage Log

### 2026-11-25 — Review pass
- verdicts: 30 findings — high 0, medium 1, low 10, false 19, maybe-false 0 (outcomes: 4 patch rows covering 3 fixes, 2 defer rows covering 1 item, 24 reject)
- findings:
  - `[false]` `[reject]` (blind) `fleetOf` now needs `devices.ios` and throws a TypeError for a hand-built object without it. Every `devices` that reaches `fleetOf` comes from `parseDevices`, which refuses a file with no `ios.udid`/`ios.model`. The tests' hand-built objects spread the parsed file, so the input never occurs.
  - `[false]` `[reject]` (blind) `PHONE_POOL_SEED` is hard-coded, so a second extra phone would be missing from the Pool. The AC requires the named constant (Q1 is "reversible by that one constant"). `pools.phone` has no consumer until 5.7, and `seed.test.mjs` fails as soon as devices.json changes, so the drift cannot ship.
  - `[false]` `[reject]` (blind) `deploy` and `deploy_target` duplicate each other on phone rows. `deploy` is a v1a key that must stay (AD-17), and the AC asks for additive `deploy_target` on every row. Both come from the same seed record, so they cannot disagree.
  - `[false]` `[reject]` (blind) The DEPLOY TARGET line mislabels some cases (the lease suffix on a job lock, a non-lease kind printed as JOB LOCK, no expiry). The suffix is general advice and true for any holder. The LEASE/JOB LOCK split copies the LOCKS block's own rule. Expiry and why are printed one block above.
  - `[low]` `[patch]` (blind) The stale-job-lock test made `[stale]` optional, so it could not fail. This is grouped with the verification-gap stale row below. Patched: the test asserts the exact line after confirming `stale: true` in the view.
  - `[low]` `[reject]` (blind) No tests for `emulator-<n>`/ios-lane waiter rows, the CLI `--json` path, or a null key, plus a `.sort()` over nulls. The mark is one generic per-row expression of `resource`. Emulator and `mac-ios` rows are covered, and the sort is deterministic. No defect was shown, and further tests add no coverage of a distinct path.
  - `[false]` `[reject]` (blind) Seed warnings reach no user, and `loadQaDevices`/`dedicatedQaIds` have no production caller. By design (AD-30/AD-41), their caller is the Hub API in Epic 6. No production path reads the QA file today, so nothing is silently dropped.
  - `[false]` `[reject]` (blind) The README promises model agreement and mode 0600 that the seed does not check. Both are the pre-existing README sentence, unchanged and never enforced. Serial is the identity, and the long line matches the paragraph's existing style.
  - `[false]` `[reject]` (blind) `loadQaDevices` strictness: a serial regex without `-`/`_`, an untrimmed slug, and duplicate serials collapsing. The serial rule is `parseDevices`' own `^[A-Za-z0-9]+$`. An untrimmed name is skipped with a warning. A second entry with the same serial matches the first entry's runtime record in the phone lookup, so no duplicate record is created.
  - `[low]` `[reject]` (edge) `statusView` now throws when `devices.json` is unreadable, even with an injected fleet. In the CLI, `loadFleet` reads the same file first and fails earlier, and no library caller passes a fleet with a broken file. The guard would add branches for an unreached state.
  - `[low]` `[reject]` (edge) The `ctx.fleet` read and the seed read could disagree. That needs devices.json edited mid-call or a test-injected fake fleet. Both are rare, and the fix would thread a new context key.
  - `[low]` `[defer]` (edge) An extra phone other than s24 reads resource null, so deploy_target is null. This predates the story (`resourceOf`'s fixed map, Story 5.2) and is the known bare-lock gap. Deferred.
  - `[low]` `[patch]` (edge) An expired Lease on a deploy target printed `held by LEASE …` with no stale marker, though LOCKS marks it. Patched: the LEASE form appends `  [stale]` like the JOB LOCK form, and a test asserts the exact line.
  - `[false]` `[reject]` (edge) Several lock rows per resource, or a lock name taken from a waiter row. Each deploy-target resource has exactly one lock (`adb` for s26, `mac-ios` for ios-lane), so every row for it carries the same lock name.
  - `[false]` `[reject]` (edge) `pools.phone` omits a non-S24 extra phone. This is a duplicate of the blind PHONE_POOL_SEED row, with the same refutation.
  - `[false]` `[reject]` (edge) A devices object with no `ios` throws. This is a duplicate of the blind `fleetOf`/`ios` row, with the same refutation.
  - `[false]` `[reject]` (edge) A QA slug equal to a word like `ipad`/`mac` relies on `nameRefusal` alone. `RESERVED` holds both words, so `nameRefusal` refuses them and nothing is created.
  - `[low]` `[reject]` (edge) The QA file's mode is unchecked, and duplicates get through. Mode 0600 is an operator instruction that was never enforced, and the file has no production reader yet. Duplicate serials do not create records (see above). A mode guard adds a branch for no current consumer.
  - `[false]` `[reject]` (edge) An empty `HUB_QA_DEVICES` falls back to the real path. Empty-means-unset is the repo convention (`env.HUB_DEVICES || defaultFile`, `HUB_LOCK_DIR`), and `hermetic()` always sets a non-empty path.
  - `[low]` `[defer]` (edge, claim) A seeded Resource that `resourceOf` does not map is marked null, not its record's false. This has the same root as the deferred extra-phone row and is grouped with it.
  - `[medium]` `[patch]` (verification-gap) Nothing pinned that `fleetOf`, `statusView` and `hub-device status` never read the QA file. Patched: a new status-view test runs `loadFleet`, `statusView` and `status --json` against the empty, a sentinel and a broken QA file. The outputs are identical, with no `res-sentinel` or `SENTINEL9`, and the broken file still exits 0. The implementer also confirmed the test fails when `qaDevices: () => []` is dropped.
  - `[low]` `[patch]` (verification-gap) The stale marker and the stale waiter/Reservation exclusions were unobserved. Patched: exact stale-job-lock and expired-lease lines, plus a case where only a stale waiter and an expired Reservation exist and no DEPLOY TARGET line prints. This is grouped with the blind stale-test row.
  - `[low]` `[reject]` (verification-gap, other) `statusView` builds its own seed instead of using `ctx.fleet`. This is a duplicate of the edge fleet/seed divergence row, with the same reason.
  - `[low]` `[reject]` (verification-gap, other) The ios-lane DEPLOY TARGET text line is untested. The line code is generic per Resource, and the ios-lane JSON mark is tested. A text test would exercise the same branch.
  - `[false]` `[reject]` (intent) `DEPLOY_TARGETS` is hand-kept rather than derived from the seed. The AC asks for exactly this, a test asserting equality, and AD-29 forbids lock.mjs from importing the Registry.
  - `[false]` `[reject]` (intent) The `deploy_target` mark is cross-checked only through the seed test. That equality test is the AC's own mechanism, and the marks and `deploy` share one seed record.
  - `[false]` `[reject]` (intent) `dedicated_qa` is not shown in status rows. The AC says local status keeps every v1a key and value and redaction is service-only. No AC asks to show the capability.
  - `[false]` `[reject]` (intent) The `match.mjs` exemption flag is not touched. `match.mjs` is Story 5.7's file (AD-33). This story declares `PHONE_POOL_SEED` and keeps the S24 first, which the seed test asserts.
  - `[false]` `[reject]` (intent) The text line also prints for a reserved target. A Reservation is a deploy run holding its place in that target's line, which is being waited on.
  - `[false]` `[reject]` (intent) The README claims "`hub-device` and status never read" the QA file. The claim is accurate, and the new status-view test now pins it.

## Design Notes

- Why `deploy_target` comes from the seed rather than `DEPLOY_TARGETS.includes(lock)`: the story asks for the marks "from the committed declarations". `DEPLOY_TARGETS` stays the cap list lock.mjs needs without importing the Registry (AD-29). The seed test keeps the two equal, so a `devices.json` change that moves a deploy target fails at once.
- Why no `resources` root list: AD-41 keeps Registry fields under the Hub API's `/status.registry`, and on Linux the `mac-ios` hold lives on the Mac's disk. A Linux-side `ios-lane` row would claim "free" for a lock it cannot see. Rows are marked where they already appear.
- Why the CLI and status never read the QA file: local status keeps every value (AD-17), and `qa_ids` is passed in by service callers (AD-41). The seed's default loader is for the Hub API (Epic 6). Using `() => []` in `fleetOf` and `statusView` keeps the private file out of every CLI run, including child-process tests that build their env from scratch.
- Host records (AD-30's "and the hosts") are left to Epic 6. Nothing consumes them yet, and an id `mac` would clash with `ios-lane`'s word.

## Verification

**Commands:**
- `node --test tools/registry/seed.test.mjs tools/device/status-view.test.mjs tools/device/hub-device.test.mjs tools/device/claims.test.mjs tools/ci/names.test.mjs tools/deploy-path.test.mjs`: all pass.
- `mise run check`: actionlint clean, full suite green.

## Auto Run Result

- **status:** done
- **summary:** The new `tools/registry/seed.mjs` derives the AD-28 Resources from the committed `devices.json`: `s26`/`adb` and `ios-lane`/`mac-ios` as deploy targets, `s24`, and the emulator Pool. It also builds `PHONE_POOL_SEED` `[s24, s26]` and reads the private QA file only through the `qaDevices` seam. `fleetOf` is now a projection of that seed. `hub-device status --json` adds `deploy_target` to every row, and text status prints one `DEPLOY TARGET` line per held or waited-on target. Otherwise the output is byte-identical to today's. A test pins `lock.mjs`'s `DEPLOY_TARGETS`/`SEED_RESOURCES`/`resourceOf` to the seed, so the hand-kept name maps cannot drift. `hermetic()` points the QA seam at a temp file, so no test reads the real QA file.
- **files changed:** `tools/registry/seed.mjs` (new), `tools/registry/seed.test.mjs` (new, 16 tests), `tools/device/claims.mjs`, `tools/device/hub-device.mjs`, `tools/device/status-view.test.mjs`, `tools/ci/test-fixtures.mjs`, `README.md`.
- **review:** 30 findings from the four layers (blind 9, edge 11, verification-gap 4, intent 6): high 0, medium 1, low 10, false 19.
  - **Patched:**
    - A test now pins that `fleetOf`, `statusView` and `hub-device status --json` never read the QA file, checked against the empty, sentinel and broken files (medium).
    - An expired Lease on a deploy target now prints `[stale]` (low).
    - The stale tests now assert exact lines and cover the stale-waiter and expired-Reservation exclusions (low).
  - **Deferred (1):** An `android_extra` phone other than the S24 reads resource and deploy_target null. Cause: `resourceOf`'s fixed seed map, which predates this story (Story 5.2).
  - **Rejected (24):** Most are refuted by the AC itself (the hand-kept `DEPLOY_TARGETS` plus an equality test, the `PHONE_POOL_SEED` constant, additive `deploy_target` next to v1a `deploy`), by `parseDevices`' guarantees (ios is always present, the serial rule), or by later stories (`match.mjs` in 5.7, the warnings consumer in Epic 6). The rest are duplicates or untestable-branch nits. There is one row each in the Review Triage Log.
- **followup_review_recommended:** false. Only one medium finding was patched, the patches are tests plus a one-token text change, and the full suite is green.
- **verification:** The targeted set (`seed`, `status-view`, `hub-device`, `claims`, `names`, `deploy-path` tests) passes 143/143. `mise run check` passes 827/827, and actionlint is clean.
- **residual risks:**
  - `statusView` re-reads `devices.json` to build its seed rather than reusing `ctx.fleet`. Both read the same file, so a divergence would need an edit mid-call.
  - Seed warnings (a skipped QA entry, the deploy phone in QA) have no consumer until the Epic 6 Hub API.
  - `match.mjs`'s Q1 S24 exemption flag is untouched; it belongs to Story 5.7.
