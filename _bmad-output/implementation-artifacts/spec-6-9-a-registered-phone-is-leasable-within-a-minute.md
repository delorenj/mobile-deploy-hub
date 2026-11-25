---
title: 'A registered phone is leasable within a minute'
type: 'feature'
created: '2026-11-25'
status: 'done'
baseline_revision: '40cb235fdd7570a4a556741ea974f4cd0da10460'
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-6-context.md'
warnings: ['oversized']
deferred: []
---

<intent-contract>

## Intent

**Problem:** A phone registered through the Hub API (6.6, 6.8) sits in `registry.json`, but `hub-device` still builds its fleet, its `phone` Pool and its status rows from `devices.json`. So `lease pixel` says "unknown device", and `--match name=pixel` says "known only from the QA file". Adding hardware still needs a hub release (FR-1, SM-3, UJ-3, AD-28, AD-33).

**Approach:** Following belsky-doctrine, the level one up from "`hub-device lease` sees a registered phone" is **every Claims library caller that resolves a phone**: the CLI now, and the Hub API and Host Agent lease routes in Epic 7. So the fleet becomes a projection of the Registry inside `claims.mjs` (`loadFleet` reads `registry.json` fresh, and falls back to the in-memory seed). `resolve`, the `phone` word, `matchTarget`, release and `statusView` all read that one fleet. Every front door inherits it, and no caller re-derives it.

## Boundaries & Constraints

**Always:**
- `claims.loadFleet(env, {warn} = {})` reads `readRegistry({env, qaDevices: () => [], warn})`:
  - **With a file:** the fleet is every record with `kind: 'phone'` and `host: 'linux'`, in file order, retired and seed-missing ones included (release, `withoutRetired` and status still need them).
  - **Missing or unreadable file:** the fleet is exactly `fleetOf(loadDevices(env))`, as today. The QA file is never read.
- Each fleet entry keeps today's six keys: `{device, lock, deploy, name, serial, model}`.
  - `device` is the record's `name` (the device word: `s24`, `pixel`).
  - `deploy` is `deploy_target === true`.
  - `name` is `display_name ?? name`.
  - `serial` and `model` come from `identity`, or `null`.
- `fleetOf(devices)` keeps its output. It becomes the same projection over the seed's records.
- `resolve(word)`:
  - `refuseRetired` runs first, unchanged.
  - Then a fleet entry is found by Resource id (`resourceOf(entry.lock) === word`), then by `device`.
- The `phone` word's members come from `match()` over the same Registry read (`qaDevices: () => []`, no warning), with `retired_at`/`seed_missing` stripped. Mapping is by lock to fleet entries, so `withoutRetired` keeps its narrowing and its all-out `HUB_RESOURCE_RETIRED phone` refusal.
  - Membership: `[s24, s26]`, then runtime `linux` phones that are not `dedicated_qa`, in `created_at` order.
  - The S24's named-list exemption is the matcher's own and stays unchanged.
- `matchTarget` excludes a phone record that has no fleet entry:
  - `is a phone on <host>; hub-device leases a phone on linux` when its host is not `linux`;
  - otherwise the existing QA-file message.
- `statusView`'s `phones` drops a fleet phone whose file record is `hidden` (`visibility` with `lockActivity`). A retiring one stays listed. The text status prints `serial -` for a null serial.
- `connectPhone` fails fast on a phone with no serial, unless `--no-connect` is given: `HUB_PHONE_AWAY` (75), reason `no serial registered (lease it --no-connect)`, and the Lease is given back. A `phone` try falls through to the next member.
- `hub-device main` builds `context.fleet = claims.loadFleet(env, {warn: context.warn})`, and its `warn` prints each distinct message once. So an unreadable file gives exactly one `HUB_REGISTRY_FORMAT` warning per invocation, even with `--match` or `registry list`.

**Never:**
- No change to `lock.mjs`, the matcher, the store, the Hub API routes or the deploy path. Deploys never read the Registry, and `deploy-path.test.mjs` stays green.
- No change to any existing command's output, exit code or `--json` shape when `registry.json` is missing (FR-13, AD-17).
- No caching of the Registry across invocations: each CLI run reads the file fresh, so a registration is visible on the next call with no install.
- No API call from `lease`, `run`, `release` or `status`. No new dependency, no Python, no `setInterval`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected | Error |
|----------|--------------|----------|-------|
| Lease by name | `registry add --kind phone --name pixel --model "Pixel 9" --serial PIXEL9SN` through `handle()`, then `lease pixel --wait 0` | exit 0. `HUB_DEVICE='pixel'`, `ANDROID_SERIAL=<pixel adb id>`. `res-pixel.lock` is owned. One `acquire` event on lock `res-pixel` | — |
| Lease by id | `lease res-pixel` | the same lock taken, `HUB_DEVICE='pixel'` | — |
| Phone Pool | s24 and s26 held; `lease phone --wait 0` | takes `res-pixel`. `resolve('phone')` members are `[s24, s26, pixel-a, pixel-b]` in `created_at` order | — |
| QA runtime phone | file first created with a QA phone `Pixel-QA` → `res-pixel-qa` `dedicated_qa` | not a `phone` member. `lease pixel-qa` and `--match name=pixel-qa` take it | — |
| Status | `status --json` with `res-pixel` registered (and again when leased) | the `phones` row `device: 'pixel'` has `resource: 'res-pixel'`, `reachability` `{state, checked_at, age_ms, stale}` and `deploy_target: false`. The held lock row is the same | — |
| Retired | retire `res-pixel`, then `lease pixel` / `lease res-pixel` | exit 2, `HUB_RESOURCE_RETIRED pixel …retired`, nothing held. Status no longer lists it | `HUB_RESOURCE_RETIRED` |
| Retiring | held, then retired | status still lists it. `release <id>` → `HUB_DEVICE_RELEASED pixel <id>` | — |
| No serial | registered with model only; `lease nosn` | exit 75 `HUB_DEVICE_AWAY nosn`, at once, nothing held. With `--no-connect` exit 0 | `HUB_PHONE_AWAY` |
| No file | no `registry.json` | `lease s24|s26|phone|emulator` and `status --json` as before; `loadFleet` equals `fleetOf` | — |
| Unreadable file | `registry.json` = `not json{`; `lease s24`, `lease phone`, `status`, `lease --match kind=phone` | the seed fleet is used, behaviour as before, and exactly one `hub-device: warning: HUB_REGISTRY_FORMAT:` line each | warning only |

</intent-contract>

## Code Map

- `tools/device/claims.mjs`:
  - `fleetOf` L141 and `loadFleet` L148: the projection, made Registry-backed.
  - `resolve` L285 and `phoneMembers` L217: id-then-name lookup; the matcher over the Registry.
  - `matchTarget` L228: the exclusion message, L238.
  - `withoutRetired` L185 and `refuseRetired` L173: unchanged, and they rely on retired records being in the fleet.
  - `connectPhone` L365: the no-serial fast fail.
  - `statusView` L704: the `phones` build, L780. `phoneObservations` L650 already handles a null serial (it reads absent).
  - `lockActivity` L87.
  - Imports already present: `readRegistry`, `readRegistryFile`, `retirement`, `match`, `seed`, `loadDevices`, `resourceOf`. Add `visibility` from `../registry/match.mjs`.
- `tools/device/hub-device.mjs`:
  - `main` L680. The `warn` seam is at L700 (dedupe there), and `context.fleet` at L707 (pass `warn`).
  - The status phones text line is L363.
  - Header comment L9-25: name registered phones.
- `tools/registry/store.mjs` (read only): `readRegistry` L89 (`source: 'file'|'seed'` and the warning text) and `readRegistryFile` L107.
- `tools/registry/match.mjs` (read only): `match` L102, the named-list runtime rule L119-127; `visibility` L76.
- `tools/ci/lib/lock.mjs` (read only): `resourceOf` L61 (a `res-*` lock is its own id); `isQueued` L83 (`res-*` is queued).
- `tools/hub-api/routes.mjs` (read only): `handle()`, and `registerResource` and `retireResource` L167-196, which seed the file on its first write.
- `tools/device/registry-verbs.test.mjs` L25-49: the `scratch()` harness to copy (a `fetchImpl` into `handle()`, `apiCtx` with `devices`, `qaDevices`, `now`).
- `tools/device/lease-match.test.mjs` L32-51: `adbWith` and `side()` (the fake adb client and wire); `fakeWire` is in `wire-fixtures.mjs`.
- Hermetic gap: `lease-match.test.mjs` L401-412 call `loadFleet({})`, `resolve(..., {env: {}})` and `matchTarget` with `env: {}`. That resolves the lock dir to the real `~/.cache/mobile-deploy-hub/locks`. Point those at `{HUB_LOCK_DIR: process.env.HUB_LOCK_DIR}` (scratched by `hermetic()`).
- `tools/registry/seed.test.mjs` L153: pins `fleetOf`'s six keys and values. It must stay green.
- `README.md` L241-243 (`phone`, `--match`): the paragraph to extend.

## Tasks & Acceptance

**Execution:**
- `tools/device/claims.mjs`:
  - `phonesOf(resources)`, with `fleetOf` built on it, and the Registry-backed `loadFleet`.
  - id-then-name in `resolve`, and the Registry-backed `phoneMembers`.
  - The `matchTarget` host message, the status hidden filter and the no-serial fast fail.
  - Header comments updated.
- `tools/device/hub-device.mjs`: the deduping `warn`, `loadFleet(env, {warn})`, `serial ?? '-'`, and the header comment.
- `tools/device/registered-phone.test.mjs` (new, hermetic): every matrix row. The end-to-end rows register through `handle()` (via `registry add` with the routed `fetchImpl`) and lease through `main()` against one temp lock dir, with the fake adb client and wire extended with the Pixel.
- `tools/device/lease-match.test.mjs`: the hermetic `env` fix only (L401-412).
- `README.md`: one paragraph, "Registered phones": leasable by name or id with no release, in `phone` after the seeded phones, retired ones refused, and the fallback to `devices.json` when the file is missing or unreadable. Also correct the "only `--match` reads the QA file" and "`phone` … still the S24, then the S26" lines where they are now incomplete.

**Acceptance Criteria:**
- Given the existing suites (`hub-device.test.mjs`, `lease.test.mjs`, `lease-match.test.mjs`, `phone-queue.test.mjs`, `status-view.test.mjs`, `claims.test.mjs`, `seed.test.mjs`, `names.test.mjs`, `registry-verbs.test.mjs`, `tools/hub-api/*.test.mjs`), when they run, then they pass. Only the hermetic env fix touches an existing test.
- Given `deploy-path.test.mjs`, `clock.test.mjs` and `contract.test.mjs`, when they run, then they pass.
- Given `mise run check`, when it runs, then actionlint and the full suite pass.

## Spec Change Log

## Review Triage Log

### 2026-11-25 — Review pass
- verdicts: 26 findings — high 0, medium 1, low 15, false 10, maybe-false 0
- findings:
  - `[false]` `[reject]` (blind) Id-then-name lookup lets a phone named like another's id (`res-pixel`) shadow it, and a retired name can be re-registered beside its old record. — `nameTaken` (`tools/registry/changes.mjs:98`) refuses a name that equals any record's name, id, lock or word, retired ones included. Neither collision can be registered.
  - `[false]` `[reject]` (blind) Registering the S24's or S26's serial under a new name makes the same hardware leasable on two locks. — `identityHolder` refuses a serial that a live record holds (HUB_REGISTRY_DUPLICATE 409). `writeThrough` seeds the S24 and S26 records, with their serials, before the first registration.
  - `[low]` `[patch]` (blind) A no-serial `lease nosn --wait 5m` queues for the lock before it says AWAY, so it is not "at once". — Group NS. The no-serial refusal now runs in `takePhone` before `acquireLease`, so nothing is queued or held and no event is written.
  - `[low]` `[patch]` (blind) The status text prints the literal `null` for a phone with no model. — Group M. A QA-file phone may have no model and is now in the fleet. Fixed with `phone.model ?? '-'` (`tools/device/hub-device.mjs`).
  - `[low]` `[patch]` (blind) The README `phone` paragraph still describes two phones ("both", "the two phones'", "the other"). — Reworded to every member, the members' earliest ETA and the others. Added that `phone` and `--match` skip a no-serial phone unless `--no-connect` is given.
  - `[low]` `[reject]` (blind) The Registry is read several times per invocation, so a registration landing between reads can be dropped from `phone` by `.filter(Boolean)`. — The race window is milliseconds inside one CLI process, and the next invocation sees the record. Fixing it means threading one snapshot through `resolve` and `statusView`, which adds parameters for a defect nobody will hit.
  - `[false]` `[reject]` (blind) `'linux'` is hard-coded instead of using the injected host key, and the comment works around a guard. — `'linux'` names the host the phones are attached to (the seed's `host`), not the host running the CLI. The host key gates the wire query, as it did before. The comment is accurate: `tools/hostkey.test.mjs` allows `claims.mjs` one record-host comparison.
  - `[low]` `[patch]` (blind) Test assertions are looser than their titles. The `--match name=` test queries `api_level`, the QA `--match name=` case only shows exit 76, and the unreadable-file test accepts `[0, 76]`. — The QA test now releases and asserts that `--match name=pixel-qa` takes the phone (exit 0). The match test also asserts that `--match name=pixel` takes it. The unreadable-file test asserts exact codes 0, 0, 0, 76, 0.
  - `[low]` `[reject]` (blind) No test of a registered phone under contention (`--wait` > 0, FIFO with three or more members, registered mid-wait). — Queueing is `acquirePool`'s, which this story does not change, and `phone-queue.test.mjs` covers it over N members. Registration is visible on the next read, and the e2e test registers and then leases with no step between.
  - `[low]` `[reject]` (blind) `release <name>`, `release --any`, `run` and `--env-serial` are untested for a registered phone. — These paths walk the same fleet entries, and release by id is tested. A per-verb test for a registered phone adds suite time without a new path.
  - `[false]` `[reject]` (blind) `lease-match` tests depend on ambient `HUB_LOCK_DIR`. — Every lane test file calls `hermetic()`, which always scratches `HUB_LOCK_DIR`. The fix replaced the `{}` that did reach the real cache.
  - `[low]` `[patch]` (edge) A no-serial `phone` member turns BUSY (76) into AWAY (75) when every phone that can be served is held. — Group NS. No-serial members are dropped from the Pool before `acquirePool` unless `--no-connect` is given, so all-held is BUSY. The test now asserts 76.
  - `[medium]` `[patch]` (edge) `lease phone --wait N` with a free no-serial member takes it and gives it back on every poll pass, writing an acquire/release event pair each time. — Group NS. Confirmed in `acquirePool` (`tools/ci/lib/lock.mjs:1342-1370`), which retries a refused member every poll. Members are now filtered in `takeAnyPhone`, and the tests assert that no lock event names `res-nosn`.
  - `[low]` `[reject]` (edge) The Registry is read more than once: a mid-invocation registration is dropped from the Pool. — The same root cause as the blind finding above, rejected for the same reason.
  - `[low]` `[reject]` (edge) A `registry.json` with no `phone` Pool makes `lease phone` a usage error. — The API writes the file only through `seed` plus planned changes, and the `phone` Pool is always present. Only a hand-edit removes it, and that fails loudly.
  - `[low]` `[reject]` (edge) A hidden retired phone is still probed for reachability. — The readings are built per call and no row shows a hidden phone. The probe is a read-only wire query, and filtering earlier would add a branch for no visible effect.
  - `[false]` `[reject]` (edge) `deploy_target` in status comes from the seed while the fleet uses the Registry, so they could disagree. — `planRegister` forces `deploy_target: false`, and `FORBIDDEN_CAPABILITIES` keeps edits from setting it. Seeded records carry `devices.json`'s value, so the two sources agree.
  - `[low]` `[patch]` (edge) The status text prints `null` for a missing model. — Group M (the same defect as the blind finding), fixed by the same `?? '-'`.
  - `[false]` `[reject]` (edge) Id-then-name lookup leases a different phone when an id equals another phone's name. — Refuted by `nameTaken`, as for the blind finding.
  - `[low]` `[patch]` (edge) The claim that a `phone` try "falls through" a no-serial phone ends AWAY (75), not BUSY. — Group NS. With the filter, a no-serial member is skipped before any take, and the request is BUSY when the rest are held.
  - `[low]` `[patch]` (verification-gap) No test that a retired phone with a live queued waiter and no owner stays in `status`, which is the AD-31 retiring rule. — Added a test that writes a `buildTicket` ticket to `res-pixel.queue`, retires the phone and asserts that `status --json` still lists `pixel`.
  - `[false]` `[reject]` (intent) The installed `hub-device` (release plus `hosts:install`) is not exercised. — The AC says "with no `hosts:install` after the one that shipped this story", so the shipping install is a precondition, not part of the story. It is an agent-run hub release (`mise run release -- X.Y.Z`), not a human-only action, so there are no operator actions.
  - `[false]` `[reject]` (intent) The seeded dedicated-QA exclusion and the S24 named-list exemption are untested. — The QA test's `registry.json` is created with the QA phone imported, which is the seeded dedicated-QA path. It asserts that the phone is not a `phone` member. The S24 exemption is the unchanged matcher's own, covered in `tools/registry/match.test.mjs`.
  - `[low]` `[reject]` (intent) Nothing measures the 60-second window. — Nothing caches: each invocation reads the file fresh, and the test leases right after registering. A wall-clock timing test would add flakiness and prove nothing more.
  - `[false]` `[reject]` (intent) The status `resource`, `reachability` and `deploy_target` fields come from the existing builder, not this diff. — This describes the code, not a defect. The story's claim is that the registered phone gets those rows, and the test asserts it.
  - `[false]` `[reject]` (intent) The plain status text `serial -` is covered only for the no-serial row. — The serial-present text line was unchanged before this story and is covered by `status-view.test.mjs` and `hub-device.test.mjs`. The changed `??` branch is tested.

## Design Notes

- **Why retired records stay in the fleet.** The fleet is also what `release` and `checkLeaseId` walk, and what `withoutRetired` narrows. A retired phone that is still held must release by id, and a `phone` request whose members are all retired must say `HUB_RESOURCE_RETIRED`, not "unknown device". Only the display (`status` phones) drops a hidden one.
- **Why `device` is the name, not the id.** For seeded phones they are the same, so every existing line is unchanged. For a runtime phone, `HUB_DEVICE=pixel` is the word the caller typed, and the id still resolves (id first). Names are never reused (`nameTaken` counts retired records), so id-then-name lookup is unambiguous.
- **Within 60 s.** Nothing caches: `readRegistry` reads the file on each call, and every `hub-device` run is a new process. The Hub API commits with an atomic rename, so the next invocation sees the record. The e2e test registers, then leases with no step in between.

## Verification

**Commands:**
- `node --test tools/device/*.test.mjs tools/registry/*.test.mjs tools/hub-api/*.test.mjs tools/ci/names.test.mjs tools/deploy-path.test.mjs tools/clock.test.mjs` -- expected: all pass
- `heavy mise run check` -- expected: actionlint clean, full suite green

## Auto Run Result

Status: done

**Summary.** `hub-device` now builds its phone fleet from the Registry (`registry.json` in the lock dir, read fresh on every invocation) through `claims.loadFleet`. A phone registered through the Hub API can be leased on the next call, with no hub release and no install.

Following belsky-doctrine, the projection lives in the Claims library, so every front door that resolves a phone inherits it: the CLI now, and the Hub API and Host Agent lease routes in Epic 7. What changed:
- **Lookup.** `resolve` finds a phone by Resource id, then by name.
- **The `phone` Pool.** Members come from the matcher: S24, S26, then runtime `linux` phones that are not dedicated QA, in `created_at` order.
- **`matchTarget`.** It explains why a phone on another host cannot be leased here.
- **`status`.** It hides retired phones that nobody holds or waits on, and keeps a retiring one listed.
- **Phones with no serial.** They are refused before any lock is taken (`HUB_DEVICE_AWAY`, or a lock-only lease with `--no-connect`).
- **Warnings.** An unreadable file falls back to the `devices.json` seed with one warning per command.
- **No file.** With no file, every output is unchanged.

**Files changed:**
- `tools/device/claims.mjs`: `phonesOf`, the Registry-backed `loadFleet`/`fleetOf`, id-then-name `resolve`, the matcher-backed `phoneMembers`, the other-host message in `matchTarget`, the hidden filter in `statusView`, and the pre-acquire no-serial refusal (`noSerialAway` in `takePhone` and `takeAnyPhone`).
- `tools/device/hub-device.mjs`: the deduping `warn`, `loadFleet(env, {warn})`, and `-` for a missing serial or model in the status text. Header comment updated.
- `tools/device/registered-phone.test.mjs` (new): 14 hermetic end-to-end tests, registering through `handle()` and leasing through `main()`, covering every matrix row plus the queued-retiring status case.
- `tools/device/lease-match.test.mjs`: the hermetic env fix only. The library tests use the scratched `HUB_LOCK_DIR`.
- `README.md`: a new "Registered phones" paragraph. The `phone` and `--match` text is updated for N members, the no-serial skip, and which commands read the QA file.

**Review findings.** 26 findings in total.
- **Patched (6 entries).** These grouped 11 finding rows:
  - The no-serial check ran after acquisition (medium; 4 rows): event spam per poll, AWAY instead of BUSY, and a direct lease that queued.
  - `null` model in the status text (low; 2 rows).
  - Stale two-phone README wording (low).
  - Loose test assertions (low).
  - The missing queued-retiring status test (low).
- **Deferred.** None.
- **Rejected as false (10):**
  - id/name collision, twice: `nameTaken` forbids it;
  - duplicate S26 serial: `identityHolder` 409;
  - hard-coded `linux`: it is the phones' host;
  - ambient `HUB_LOCK_DIR`: `hermetic()` sets it;
  - the `deploy_target` source split: runtime records are forced `false`;
  - the installed surface not exercised: the AC presupposes the shipping install, which is agent-run, so there are no operator actions;
  - seeded QA exclusion untested: it is covered;
  - status fields come from the existing builder: descriptive, not a defect;
  - status text covered only for no-serial: the unchanged line is covered elsewhere.
- **Rejected as low (5 rows):**
  - the multi-read race, twice: a millisecond window, and the fix threads a snapshot through two APIs;
  - a hand-edited file with no `phone` Pool: it fails loudly;
  - hidden phones still probed: no visible effect;
  - no contention tests: `acquirePool` is unchanged and covered over N members;
  - no per-verb tests for release/run/env-serial: same fleet path, and release by id is tested;
  - no 60-second timing test: no caching, and a wall-clock test would only add flake.
- **Follow-up review recommended: false.** This first pass patched 1 medium and 4 low entries, and no high.

**Verification:**
- `node --test tools/device/*.test.mjs tools/registry/*.test.mjs tools/hub-api/*.test.mjs tools/ci/names.test.mjs tools/deploy-path.test.mjs tools/clock.test.mjs`: 514 of 514 pass after the patches; 529 of 529 before them, with `tools/hostkey.test.mjs` included.
- `heavy mise run check`: actionlint clean, and 1177 of 1177 tests pass after the patches.
- Matrix audit: each of the 10 rows maps to a passing test in `registered-phone.test.mjs`.

**Residual risks:**
- Each CLI invocation reads the Registry up to three times (`loadFleet`, `phoneMembers`, `statusView`). A registration landing between reads can miss the `phone` Pool for that one invocation.
- A hand-edited `registry.json` with no `phone` Pool makes `lease phone` a usage error, not a fallback.
- The deployed surface needs the next hub release and `hosts:install` before the installed `hub-device` reads the Registry. That is the normal agent-run release, not an operator action.
