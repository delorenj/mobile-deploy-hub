---
title: 'One Claims library under an unchanged CLI'
type: 'refactor'
created: '2026-11-24'
status: 'done'
baseline_revision: 'd148d7e2af62ee6c223a89fb6a895fad26be3def'
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-5-context.md'
warnings: ['oversized']
deferred:
  - summary: >-
      The repo's agent rules ("Where things are" in AGENTS.md, read through the CLAUDE.md symlink) still name hub-device.mjs as the place to extend device checkout and do not mention tools/device/claims.mjs.
    evidence: |-
      After this story every action and rule lives in claims.mjs (AD-24); an agent that follows the "Where things are" line would add new take/release logic to hub-device.mjs, the front door that must stay parsing and output only. The fix edits an agent-context file, so it is out of this build's reach.
    location: >-
      AGENTS.md (Where things are)
    severity: low
  - summary: >-
      The emulator reaper-failure warning now reaches stderr through the new ctx.warn seam, and no test makes reap throw and pins the text or the silent default.
    evidence: |-
      claims.reapBeforeAcquire calls ctx.warn?.(...); main supplies warn => stderr('hub-device: warning: ' + message). No test in tools/ has the reaper fail (grep "reaper failed" hits only claims.mjs). The gap predates the move (the old stderr call was untested too), and the path is warning-only.
    location: >-
      tools/device/claims.mjs reapBeforeAcquire
    severity: low
---

<intent-contract>

## Intent

**Problem:** Resolve, take, release, extend, Lease id minting, bounds checks and the error-to-exit mapping live inside `hub-device.mjs` (`takeLease`, `takeAnyPhone`, `setup`, `report`), so the Hub API and Host Agent that Epics 6-9 add would have to re-implement them and could take, refuse or report one action differently (FR-13, FR-22, AD-24).

**Approach:** Move every action and every rule into a new `tools/device/claims.mjs` (one library, three future front doors) and leave `hub-device.mjs` as argument parsing plus output, with byte-identical CLI behaviour. Add a data-table conformance test that keeps the deploy path from ever importing v1b code (AD-25).

## Boundaries & Constraints

**Always:**
- The CLI is unchanged: same commands, flags, stdout/stderr lines, exit codes (75 away, 76 busy, 2 usage, 1 otherwise, the child's code for `run`), `--json` shapes, check order (device word first, then `--id` uniqueness, `--for` bounds, deploy-target cap, `why`, `--wait`, `--pid`).
- `hub-device.test.mjs`, `lease.test.mjs`, `emulator.test.mjs` and `tools/ci/reservation-release.test.mjs` pass with no assertion edited. `hub-device.mjs` keeps exporting `main`, `parseArgs`, `parseDuration`, `leaseSupport`.
- `status` writes nothing to the lock dir or the Event Log.
- `claims.mjs` mutates protocol paths only through `lock.mjs`/`emulator.mjs` exports (AD-1). Library errors carry a `code`; a usage refusal is `code: 'HUB_USAGE'` with today's message text.
- Node 24 ESM, built-ins only; tests hermetic (temp lock dir, fake adb, injected seams).

**Never:**
- No new CLI command or flag (no `hub-device extend` yet); no change to `lock.mjs`, `emulator.mjs`, the deploy path, `policy.json` or any on-disk format.
- No Registry, `res-*`, `RESERVED`, `hostKey`, Reachability enum or `statusView` shape work: those are Stories 5.2-5.4.
- `tools/ci/commands/*` and `tools/catchup/*` never import `claims.mjs`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Parity: take | `claims.take` and `hub-device lease s24 --no-connect` on twin temp lock dirs | Same owner record (ids/times normalised), same event names and fields | No error expected |
| Parity: busy | s24 held, both ask with no wait | Same message; `exitCodeOf(err)` equals CLI exit 76 | HUB_LOCK_TIMEOUT |
| Parity: over cap | `s26 --for 2h` | Same cap text; exit 2 both ways; nothing written | HUB_USAGE |
| Parity: away | phone absent | CLI prints `HUB_DEVICE_AWAY`; library error maps to 75 | HUB_PHONE_AWAY |
| Release outcomes | id held / queued / unknown / `job:` id / `--any` | Same lines as today | job id exit 2 via table |
| Extend | live Lease, no waiters | `claims.extend` returns the new record, one `extend` event | waiters or cap: HUB_LEASE_EXTEND_REFUSED, exit 1 |
| Import rule | fixture file in a scanned dir imports `claims.mjs` (direct or transitive) | Conformance check reports it | test fails |

</intent-contract>

## Code Map

- `tools/device/hub-device.mjs` -- today's owner of everything; source of the move. `fleetOf` L57, `resolveDevice` L70, `setup` L130 (bounds + `--id` uniqueness), `takeLease` L166, `noPhoneError` L202, `takeAnyPhone` L220, `exportsOf` L251, `report` L261 (exit mapping), `emulatorOptions` L280, `reapBeforeAcquire` L298, release flow L410-507, `reservationCommand` L391, status assembly L523-623 (`phonePresence` + data build) then rendering L624-678, `releaseEmulatorSlotNow` L732, `main` L792 (context: `timing`, `emulator`, `adbFactory`, `inventory`, `policy`, `log`).
- `tools/ci/lib/lock.mjs` -- protocol owner (read-only here): `MAX_LEASE_MS` L327, `DEPLOY_TARGETS`/`deployTargetCapMs`/`capText` L366-378, `newLeaseId` L912, `poolRequest` L923, `acquireLease` L1118 (throws HUB_LEASE_TOO_LONG, HUB_LOCK_TIMEOUT), `releaseLease` L1277, `updateLease` L1322, `extendLease` L1348 (HUB_LEASE_EXTEND_REFUSED, HUB_LEASE_LOST), `listLocks` L1447, `queueView`, `RESERVABLE`, `releaseReservation`, `waiterEtas`, `etaHistory`.
- `tools/device/emulator.mjs` -- read-only: `provision`, `releaseEmulator`, `reap`, `readRecord`, `teardownNow`, `isEmulatorLease`, `LEASE_ID`, `PROFILES`, `hostPool`, `exportsOf`, `emulatorStatus`, `GATE`, `isEmulatorLock`; error codes HUB_EMULATOR_USAGE (exit 2), HUB_LOCK_TIMEOUT, HUB_LEASE_CANCELLED.
- `tools/ci/lib/adb.mjs` -- `findPhone` (throws HUB_PHONE_AWAY with `reason`), `idMatchesSerial`; `tools/device/async-adb.mjs` `createAsyncAdb`; `tools/device/inventory.mjs` `inventory`; `tools/ci/lib/devices.mjs` `loadDevices` (honours `HUB_DEVICES`).
- `tools/device/hub-device.test.mjs` L48-75 -- the `fixture()` pattern to copy (fake adb script, `HUB_LOCK_DIR`, `HUB_EVENT_DIR`, injected `inventory`); `tools/ci/test-fixtures.mjs` `hermetic()`.
- `tools/ci/commands/*.mjs`, `tools/catchup/*.mjs` -- the deploy path the conformance test scans; today they import only `../lib/*` and node built-ins.
- Today's exit mapping (must be the table): usage/HUB_EMULATOR_USAGE/HUB_LEASE_TOO_LONG -> 2; HUB_PHONE_AWAY -> 75; HUB_LOCK_TIMEOUT -> 76; HUB_LEASE_CANCELLED -> 1; a `job:` id on release -> 2; anything else -> 1.

## Tasks & Acceptance

**Execution:**
- `tools/device/claims.mjs` -- NEW. Export: `PHONE`, `EMULATOR`; `fleetOf`, `loadFleet(env)`; `resolve(target, {fleet, env, words=true, ids=true})` (id first: emulator lease, phone owner, phone waiter; then word: a fleet device, the `phone` Pool, `emulator`; unknown word -> HUB_USAGE with today's message); `checkLeaseId`, `checkBounds`/`usableFleet` (48 h, deploy-target cap with `capText`, `phone` with no usable member), `emulatorBounds` (profile, `--pool`); `newLeaseId(kind = 'lease'|'emulator'|'run')` (exact formats `l-<12hex>`, `e-<12hex>`, `run-<pid>-<8hex>`); `take(resolved, options, ctx)` (one phone, the `phone` Pool as today's ordered try with one `poolRequest`, or an emulator incl. the lazy reap); `leaseExports`; `release` family (emulator, phone by id with not-found notes, `--any`, `jobTicket(id)` parse); `releaseEmulatorNow`; `releaseReservations`; `extend(id, {forMs, ...})` over `extendLease` for a phone or emulator-slot Lease; `statusData(ctx)` (today's data assembly incl. adb presence, unchanged JSON); `EXIT_CODES` frozen data and `exitCodeOf(error)`. -- the one library every front door calls (AD-24).
- `tools/device/hub-device.mjs` -- reduce to parsing, flag-to-option mapping, signal handling, child spawning and output; call `claims.*` for every action; exit codes only via `exitCodeOf`; delete `takeLease`, `takeAnyPhone`, `noPhoneError`, `resolveDevice`, the status data build. -- AD-24 "parsing and output only".
- `tools/device/claims.test.mjs` -- NEW, hermetic: parity cases from the I/O matrix (claims vs `main` on twin temp lock dirs), the exit table values, `newLeaseId` formats, `extend` success/refusal, `resolve` id-first, and a source check that `hub-device.mjs` defines no `takeLease`/`takeAnyPhone` and imports no `lock.mjs`/`emulator.mjs`/`adb.mjs` directly. -- FR-22 proof.
- `tools/deploy-path.test.mjs` -- NEW: exported frozen `DEPLOY_PATH` (dirs scanned) and `FORBIDDEN` (`tools/device/claims.mjs`, `tools/registry/`, `tools/hub-api/`, `tools/host-agent/`, `tools/hub-client.mjs`) tables; follows relative static and literal dynamic imports transitively; asserts the live tree is clean and that a temp fixture importing a forbidden path is caught. -- AD-25, extended by later stories.

**Acceptance Criteria:**
- Given `claims.mjs` is imported, when its exports are read, then `resolve`, `take`, `release`, `extend`, `newLeaseId`, the bounds checks and `EXIT_CODES` (`HUB_DEVICE_AWAY`/`HUB_PHONE_AWAY` 75, `HUB_DEVICE_BUSY`/`HUB_LOCK_TIMEOUT` 76, `HUB_USAGE` 2, the rest as today) are present, and `hub-device.mjs` has no `takeLease` or `takeAnyPhone`.
- Given the four existing device suites, when `node --test` runs them after the move, then all pass with no assertion edited and `status` still writes nothing.
- Given one temp lock dir per side, when a Lease is taken through `claims.take` and through `hub-device lease`, then Hold, refusal reasons, exit codes and events match.
- Given the conformance test, when any file reachable from `tools/ci/commands/*.mjs` or `tools/catchup/*.mjs` imports a `FORBIDDEN` path, then it fails, and the tables are exported data.

## Spec Change Log

## Review Triage Log

### 2026-11-24 — Review pass
- verdicts: 38 findings — high 0, medium 7, low 21, false 10, maybe-false 0
- findings:
  - `[medium]` `[patch]` (blind) `take` does not run the bounds/id checks, so a library caller's `phone` Pool over the cap fails on s26 instead of narrowing — take now runs `checkLeaseId` and `checkBounds` and uses the narrowed target (c22f6d7).
  - `[medium]` `[patch]` (blind) release rules live only in the CLI; `releaseEmulator('')` reaches emulator.mjs, which reads an empty id as any lease — `release()` refuses no-target with HUB_USAGE and `releaseEmulator` validates the id (c22f6d7).
  - `[low]` `[patch]` (blind) `release({id:'job:…'})` returns `none` instead of refusing; `jobTicket` message carries the CLI marker — library throws HUB_DEVICE_JOB_ID, the CLI prints the marker, stderr unchanged (c22f6d7).
  - `[low]` `[reject]` (blind) a lease id equal to a device word shadows it under id-first `resolve` — the AC asks for id first; no front door calls the default; refusing such ids would change the CLI (`--id s26` is accepted today).
  - `[medium]` `[patch]` (blind) `extend` takes no ctx, and a missing `fleet` turns a live Lease into HUB_LEASE_LOST; it falls through to waiter ids — now `extend(id, {forMs}, ctx)`, owners only (c22f6d7).
  - `[low]` `[patch]` (blind) `take`'s default branch throws synchronously — `take` is async (c22f6d7).
  - `[false]` `[reject]` (blind) `report()` branches on exit numbers, so aliased codes share a print branch — intended: the exit class picks the print form (HUB_LEASE_TOO_LONG always printed as usage; a future HUB_DEVICE_AWAY should print the AWAY line); only HUB_PHONE_AWAY/HUB_LOCK_TIMEOUT throw 75/76 today.
  - `[low]` `[reject]` (blind) deploy-path scan is non-recursive, misses computed imports/spawned processes, uses a `>5` count, and exports tables from a test file — the AC scans `commands/*.mjs` and `catchup/*.mjs` literally; the deploy path has no computed imports; later stories edit the table in place; fixes add machinery.
  - `[medium]` `[patch]` (blind) waiter tests run `acquireLease` on a frozen clock and hang forever if an assertion throws first — `startWaiter` helper aborts through an AbortController in `finally` and asserts the ticket appeared (c22f6d7).
  - `[low]` `[patch]` (blind) large parts of claims.mjs untested — most moved verbatim and stay covered by hub-device/emulator suites; the real gaps (`releaseEmulatorNow` behaviour, single-line import regex) were patched with a behavioural test and a multi-line scan (c22f6d7).
  - `[low]` `[reject]` (blind) claims tests depend on the committed devices.json — same as the existing hub-device suite; only a devices.json edit would break it, and that is a hub release that updates tests anyway.
  - `[low]` `[reject]` (blind) `createContext` accepts no `fleet`, so a context without one fails with a TypeError — loud failure on a caller bug; the fix adds validation for a state nothing reaches.
  - `[low]` `[defer]` (blind) agent docs still point at hub-device.mjs; `fleetOf` export dropped — `fleetOf` has no importer (grep); the AGENTS.md line is agent context, deferred.
  - `[low]` `[patch]` (blind) small inconsistencies: unused `stdout` destructure, double `now()`, `kind:'phone'` literal, `resolve` name — unused binding removed (c22f6d7); the double clock read only shifts relative ages by ms; `kind` and the `phone` word are different concepts; `resolve` names never meet in one module.
  - `[low]` `[patch]` (edge) `import('…', {with})` and `?query`/`#hash` specifiers escape the scan — regex accepts `[,)]`, specifiers stripped before resolve, fixtures added (c22f6d7).
  - `[low]` `[reject]` (edge) `file:`/absolute specifiers and `createRequire` are not followed — nothing on the deploy path uses them; following them adds branches.
  - `[low]` `[reject]` (edge) an unreadable reachable file fails open — the file was just stat'ed as a file; a read failure mid-scan is not an everyday case and handling it adds a branch.
  - `[false]` `[reject]` (edge) an unresolved relative import drops the edge — Node ESM refuses extensionless and directory imports, so such a file cannot run on the deploy path at all.
  - `[low]` `[reject]` (edge) nested directories and `.js`/`.cjs` entries are not entry points — AC scans `*.mjs` in the two directories; none exist today.
  - `[low]` `[reject]` (edge) imports in comments over-report — fails closed (a false violation, never a miss).
  - `[low]` `[reject]` (edge) `>5` entry count instead of named commands — a rename would make a named list fail for no reason; the scan already proves it read the directory.
  - `[low]` `[patch]` (edge) `take`/`checkBounds` with a null target is a TypeError (exit 1, not 2) — take refuses a null target with HUB_USAGE (c22f6d7).
  - `[medium]` `[patch]` (edge) `release({})`/`{emulator:''}` falls through differently than the CLI — same root cause and fix as the blind release finding (c22f6d7).
  - `[medium]` `[patch]` (edge) `extend` without fleet reports HUB_LEASE_LOST — same root cause and fix as the blind extend finding (c22f6d7).
  - `[low]` `[patch]` (edge) `exitCodeOf` returns a function for inherited keys — `Object.hasOwn` (c22f6d7).
  - `[false]` `[reject]` (edge) `HUB_DEVICE_POLL_MS=0` falls to the default — unchanged from before the move; 0 is not a valid poll.
  - `[false]` `[reject]` (edge) aliased 75/76 codes take the AWAY/BUSY branch — same as the blind `report()` finding: intended.
  - `[medium]` `[patch]` (edge) frozen-clock waiter can hang; queue appearance not asserted — same root cause and fix as the blind waiter finding (c22f6d7).
  - `[low]` `[patch]` (edge) try/finally prints notes when the verdict write throws; unused destructure — verdict, then notes, no try/finally (c22f6d7).
  - `[false]` `[reject]` (edge) `fleetOf` removed from hub-device.mjs breaks importers — no importer in the repo; Holocene reads the hub through its API, never hub-device internals.
  - `[false]` `[reject]` (edge) "exit codes only via exitCodeOf" while `return 0`/127 and the cancelled branch stay — the table maps errors; success, a spawn failure and the child's own code are not library errors.
  - `[low]` `[patch]` (edge) source-scan regex misses multi-line imports — scan matches `from '…'` across lines, bare and dynamic imports (c22f6d7).
  - `[low]` `[patch]` (verification-gap) `releaseEmulatorNow` and `releaseHeld` have only a `typeof` check — behavioural test added for no-record, dead-pid record and a foreign gate lease (c22f6d7); `releaseHeld` is a one-line pass-through exercised by every existing lease test's signal paths.
  - `[low]` `[defer]` (verification-gap) the reaper-failure warning through `ctx.warn` has no test — pre-existing gap, warning-only; deferred.
  - `[false]` `[reject]` (verification-gap) the stdout-before-stderr ordering fix is unobservable — the tests capture the streams separately by design; the two streams' contents are each unchanged, which is what the suites pin.
  - `[false]` `[reject]` (verification-gap) the "parsing and output" test asserts source text — it is a layering guard by intent (AC: `takeLease`/`takeAnyPhone` are gone), backed by the behavioural parity tests.
  - `[false]` `[reject]` (verification-gap) computed imports escape the deploy-path scan — none exist on the deploy path; same as the blind scan finding.
  - `[false]` `[reject]` (intent) parity covers single-phone take only; id-first `resolve` and `extend` are exercised only through the library — the AC's parity scenario is one Lease taken both ways; the CLI has no extend command (unchanged CLI) and resolves ids through `claims.release`.

### 2026-11-24 — Review pass (follow-up)
- verdicts: 37 findings — high 0, medium 8, low 22, false 7, maybe-false 0
- findings:
  - `[medium]` `[patch]` (blind) `take()` skips `emulatorBounds`, so a library caller can ask for a pool above the host's, an unknown profile or `noConnect` on an emulator — the emulator branch now runs `emulatorBounds(options, ctx.env)` and takes with its profile and pool; tests cover pool 99, profile `nope` and `noConnect` (entry P1: take enforces every option rule the CLI's `setup` enforces).
  - `[low]` `[patch]` (blind) a context with no `fleet` fails open in `take` (`ctx.fleet ?? []` skips the `--id` uniqueness check) and `extend` (`fleet = []` reads a live phone Lease as HUB_LEASE_LOST) — both defaults deleted, so a missing fleet fails loudly (entry P2).
  - `[low]` `[reject]` (blind) `extend()` does not validate its id before `readRecord(env, id)` — `readRecord` returns a record only when its `lease_id` equals the id, and `extendLease` refuses an owner that does not match, so a bad id ends as HUB_LEASE_LOST; a shape guard adds a branch for no reachable harm.
  - `[low]` `[patch]` (blind) the header says everything that "touches" the lock dir goes through lock.mjs, but `lockExists`/`readOwnerOf` read it directly — reworded to "writes … reads may look at it directly", which is what AD-1 requires.
  - `[low]` `[reject]` (blind) a refusal through `take` reads `--for 7200000:` (raw ms) where the CLI says `--for 2h:` — the CLI never reaches that text (its `setup` refuses first); a front-door-neutral duration format is the Hub API story's wording choice and adds a formatter.
  - `[false]` `[reject]` (blind) the same checks run twice per CLI call, leaving a gap where state can change — the library check is the later, authoritative one and runs immediately before `acquireLease`, which is itself atomic; the earlier CLI check only fixes message order.
  - `[medium]` `[patch]` (blind) `DEPLOY_PATH` leaves out the deploy path's own entry points (`tools/ci/hub.mjs`, `macwatch.mjs`, `deploy.mjs`) — `DEPLOY_PATH` now takes entry files as well as directories and lists those three; fixtures prove a forbidden import in `tools/ci/hub.mjs` and `tools/deploy.mjs` is caught (entry P3). The non-recursive part is carried: the earlier pass rejected it (low).
  - `[low]` `[reject]` (blind) carried — subprocess routes, `new URL`, `createRequire`, `file:`/`#imports` and comment matches are not followed — same claim as the earlier pass's scan-limits and `createRequire`/`file:` rows; nothing on the deploy path uses them.
  - `[low]` `[patch]` (blind) carried — several library branches have no direct test — same claim as the earlier pass's "large parts of claims.mjs untested" row; the moved branches stay covered by the hub-device/emulator suites.
  - `[low]` `[patch]` (blind) the "Idempotent for a named lease…" comment is stranded above `printEmulatorRelease` — moved back above `release()`, which it describes.
  - `[false]` `[reject]` (blind) carried — `report()` branches on numeric exit codes, so a future code mapped to 75/76 prints AWAY/BUSY — same claim as the earlier pass's `report()` row: intended, the exit class picks the print form.
  - `[low]` `[reject]` (blind) `releaseEmulatorNow` swallows every error and returns nothing — it is the process-exit last resort (moved verbatim), and the reaper finishes what it leaves; a return value is new surface for a caller that does not exist yet.
  - `[false]` `[reject]` (blind) the first deploy-path test restates the constants it freezes — it is a pin: it fails when an entry is dropped from either table, which is its job (it was updated here when `DEPLOY_PATH` grew).
  - `[low]` `[reject]` (blind) `cliLease('s24', []).map(…)` is an awkward way to change the id — cosmetic test style, no defect.
  - `[low]` `[patch]` (edge) a library `forMs` that is undefined or NaN passes `checkBounds` — the cap and 48 h are not bypassed (`acquireLease` refuses), but the refusal had no `code` and exited 1 — `checkBounds` now refuses a non-finite `forMs` with today's `--for must be …` text (entry P1).
  - `[medium]` `[patch]` (edge) a `phone` Pool take with `waitMs` missing or NaN polls for ever (`deadline` is NaN, `now >= deadline` is never true) — `take` refuses a non-finite or negative `waitMs` with HUB_USAGE (entry P1).
  - `[low]` `[patch]` (edge) `take` with no `ctx.fleet` silently accepts a duplicate `--id` — same root cause and fix as the blind fleet finding (entry P2).
  - `[low]` `[patch]` (edge) `resolve` of an id nothing holds throws `unknown device` under the default `words: true`, against its comment's "resolves to null" — comment corrected: null with `words: false`, otherwise read as a word; no front door calls the default.
  - `[low]` `[reject]` (edge) a multi-line import with a quote or parenthesis in a comment between the braces and `from` escapes the scan — no such import exists on the deploy path; stripping comments first adds a pre-pass that can itself mangle strings.
  - `[low]` `[patch]` (edge) a substitution-free template-literal dynamic import escapes the scan — the dynamic-import pattern now accepts backticks and excludes `$`; `importsOf` and fixture tests cover it.
  - `[low]` `[reject]` (edge) the library's no-target release text differs from the CLI's — the CLI's text names `$HUB_LEASE_ID` and `--any`, inputs only the CLI has; the CLI refuses before the library, so its stderr is unchanged.
  - `[medium]` `[patch]` (verification-gap) the import guard never scans `tools/ci/hub.mjs`, `macwatch.mjs` or `deploy.mjs` — same root cause and fix as the blind `DEPLOY_PATH` finding (entry P3). `release.mjs` and `conformance.mjs` are release tooling, not the deploy path, and stay out.
  - `[low]` `[patch]` (verification-gap) `claims.extend` on an emulator Lease is untested — new test: a held `emulator-1` slot plus its record extends, the slot's `expires_at` moves (the lock `doomed()` judges an emulator by) and one `extend` event is written.
  - `[low]` `[defer]` (verification-gap) carried — the reaper-failure warning through `ctx.warn` is untested — same claim as the earlier pass's deferred row; not deferred again.
  - `[false]` `[reject]` (verification-gap) carried — `report()` keys off `exitCodeOf`, so `HUB_DEVICE_AWAY`/`HUB_DEVICE_JOB_ID` would take the AWAY/usage branch — same claim as the earlier pass's `report()` row.
  - `[medium]` `[patch]` (intent) `take` without `why` refuses with a code-less Error (exit 1) where the CLI exits 2 — `take` refuses a missing `why` with HUB_USAGE `--why <text> is required` (entry P1).
  - `[low]` `[patch]` (intent) `take` without `forMs` refuses code-less (exit 1) — same root cause and fix as the edge `forMs` finding (entry P1).
  - `[medium]` `[patch]` (intent) `take` with `holderPid: -1` takes the Lease and writes `holder_pid -1` (probe confirmed) — `take` runs `checkPid` (entry P1).
  - `[medium]` `[patch]` (intent) `takeEmulator` never calls `emulatorBounds` — same root cause and fix as the blind emulator-bounds finding (entry P1).
  - `[low]` `[reject]` (intent) "same cap text" holds for `checkBounds` with `forText`, not through `take` — same as the blind raw-ms finding.
  - `[medium]` `[patch]` (intent) the import rule's entry points exclude `tools/ci/hub.mjs`, the deploy path's real dispatcher — same root cause and fix as the blind `DEPLOY_PATH` finding (entry P3).
  - `[low]` `[reject]` (intent) carried — `announce.mjs` runs `hub-device reservation release` over ssh, so the deploy path now runs `claims.mjs` code on the Mac — the earlier pass rejected spawned processes; AD-25's rule is the import graph plus "never call a service", and claims.mjs calls no service.
  - `[false]` `[reject]` (intent) the status no-writes test runs with no waiters, so the ETA event-log read is unexercised — `hub-device.test.mjs` "status with a month of events (~15k lines) and waiters … writes nothing" drives that path through `claims.statusData`.
  - `[low]` `[patch]` (intent) `extend` is tested for phones only — same as the verification-gap emulator-extend finding; test added.
  - `[false]` `[reject]` (intent) carried — the "parsing and output only" test is a text scan — same claim as the earlier pass's layering-guard row.
  - `[low]` `[reject]` (intent) `run` with no `--for` under a cap below 60 min now prints `--for 3600000:` where it printed `--for undefined:` — needs a policy the hub does not ship (the default 60 min equals the cap), and the old text was worse.
  - `[false]` `[reject]` (intent) `EXIT_CODES` lists `HUB_DEVICE_AWAY`/`HUB_DEVICE_BUSY`, which nothing throws, and a `HUB_DEVICE_JOB_ID` through `report()` would print as usage — the AC names those table entries; the CLI handles `jobTicket` before calling the library, so `report()` never sees that code.

## Design Notes

- `claims.mjs` imports `adb.mjs`/`async-adb.mjs`/`inventory.mjs`/`devices.mjs` besides the spine's listed layers: the CLI's connect step (`findPhone`) and today's status presence are part of take and status assembly, and front doors must not import them. Stories 5.4/AD-35 later move presence to `reachability.mjs`; services call take with `noConnect` (AD-36).
- Usage errors from the library are plain `Error`s with `code: 'HUB_USAGE'`; the CLI keeps its own `Usage` for parse errors and routes both to exit 2 through the table, so stderr stays `hub-device: <message>`.
- Context shape passed into claims is today's `context` object (`env`, `log`, `timing`, `emulator`, `adbFactory`, `inventory`, `policy`, `warn`), so the seams tests inject keep working unchanged.

## Verification

**Commands:**
- `node --test tools/device/claims.test.mjs tools/deploy-path.test.mjs` -- expected: all pass
- `node --test tools/device/hub-device.test.mjs tools/device/lease.test.mjs tools/device/emulator.test.mjs tools/ci/reservation-release.test.mjs` -- expected: 159+ pass, 0 fail, `git diff` shows no change to these files
- `mise run check` -- expected: actionlint clean, full suite green

## Auto Run Result

Status: done

**Summary.** Story 5.1 moved every action and rule out of `hub-device.mjs` into `tools/device/claims.mjs` (AD-24): resolve, take (phone, `phone` Pool, emulator), release, extend, Lease id minting, bounds checks, status data and the frozen `EXIT_CODES` table with `exitCodeOf`. `hub-device.mjs` now only parses, handles signals, spawns children and prints, and the CLI is byte-identical. `tools/deploy-path.test.mjs` enforces AD-25 with exported frozen `DEPLOY_PATH`/`FORBIDDEN` tables. This follow-up review pass closed the library-side gaps a direct caller (the future Hub API or Host Agent) would hit:
- `take` now refuses, as HUB_USAGE (exit 2) with the CLI's text, what the CLI's `setup` refuses: a non-finite `forMs`, a missing `why`, a bad `waitMs` (previously an endless Pool loop), a bad `holderPid` (previously written as `holder_pid -1`), and an emulator's `noConnect`/profile/pool (`emulatorBounds`).
- A missing `ctx.fleet` now fails loudly instead of skipping the `--id` uniqueness check.
- The deploy-path scan now also covers the entry files `tools/ci/hub.mjs`, `tools/ci/macwatch.mjs` and `tools/deploy.mjs`, and template-literal dynamic imports.

**Files changed (whole story).**
- `tools/device/claims.mjs`: new, the Claims library. This pass added the extra `take` refusals, deleted the silent fleet defaults and corrected two comments.
- `tools/device/hub-device.mjs`: parsing and output over `claims.*`. This pass moved a stranded comment back above `release()`.
- `tools/device/claims.test.mjs`: new, covering parity, release, extend, the exit table, ids and layering. This pass added tests for the new `take` refusals and for extending an emulator Lease.
- `tools/deploy-path.test.mjs`: new, the AD-25 import rule. This pass added entry files in `DEPLOY_PATH`, template-literal imports, and fixtures for `hub.mjs`/`deploy.mjs`.

**Review findings (this pass).**
- 37 findings: high 0, medium 8, low 22, false 7.
- 8 entries patched:
  - P1, medium: `take` enforces every option rule.
  - P2, low: fleet defaults deleted.
  - P3, medium: deploy-path entry files.
  - Five low entries: the header comment, the stranded comment, the `resolve` comment, template-literal imports, and the emulator-extend test.
- Nothing newly deferred. The reaper-warning row is carried from the earlier pass's deferral.
- Rejected, each with its reason in the triage log:
  - `extend` id shape: `readRecord`/`extendLease` already refuse a mismatched id.
  - Raw-ms cap text through `take`: the CLI never reaches it; a formatter is the API story's call.
  - The double check: the library check is the later, authoritative one.
  - Carried: scan limits and subprocesses; `report()` numeric branches; the text-scan layering guard.
  - `releaseEmulatorNow` return value: new surface for no caller yet.
  - The frozen-table pin test: it does its job.
  - `cliLease(...).map` style: cosmetic.
  - Comments containing quotes inside multi-line imports: none exist on the deploy path, and stripping comments risks more.
  - Library vs CLI no-target text: the CLI's names CLI-only inputs.
  - Subprocess via announce: carried; claims.mjs calls no service.
  - Status test with no waiters: covered by the hub-device suite.
  - `run` default `--for` text: needs a policy the hub does not ship.
  - Unthrown table codes: required by the AC.

**Follow-up review: not recommended (false).** This was a follow-up pass and it patched no `high` entry. Patched entries by verdict: high 0, medium 2, low 6.

**Verification.**
- `node --test tools/deploy-path.test.mjs tools/device/claims.test.mjs`: 21/21 pass.
- `node --test tools/device/hub-device.test.mjs tools/device/lease.test.mjs tools/device/emulator.test.mjs tools/ci/reservation-release.test.mjs`: 159/159 pass. `git diff` of those four files against the baseline is empty.
- `mise run check`: exit 0, actionlint clean, 734/734 pass.
- A throwaway probe in a temp dir confirmed the pre-patch behaviour: `holderPid -1` was taken, and a missing `why`/`forMs` exited 1 with no code.

**Residual risks.**
- `claims.mjs` still imports `adb.mjs`/`async-adb.mjs`/`inventory.mjs`/`devices.mjs` beyond the spine's layer table. Story 5.4 moves presence to `reachability.mjs`.
- A refusal through `take` names `--for <ms>` in raw milliseconds. The Hub API story owns its front-door wording.
- The deploy-path scan follows only literal relative imports. A spawned `hub-device` (announce over ssh) runs claims code on the Mac by design.
- All proof is hermetic (fake adb, temp lock and event dirs). There was no live-device run.
- No operator action is owed. The release that ships this is Story 5.10.
