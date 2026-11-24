---
title: 'Story 3.1: Peek at the S26 without disturbing a Lease'
type: 'feature'
created: '2026-11-24'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: false
baseline_commit: '604019b350c912d64dc78f0de38b2eed63a82a32'
baseline_revision: '604019b350c912d64dc78f0de38b2eed63a82a32'
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-3-context.md'
warnings: ['oversized']
deferred: []
---

<intent-contract>

## Intent

**Problem:** When a Lease holds `adb` (the S26), plan waits up to 20 min in `withLock('adb')` behind it and goes red, and both plan and the gate's `quickS26` probe call `findPhone`, which runs `adb start-server`, `adb mdns services` and `adb connect`, so a deploy can restart or reconnect the leaseholder's adb session (FR-9, AD-13).

**Approach:** One level up (belsky-doctrine): every deploy-run read of the S26 that does not hold `adb` goes through one shared Peek primitive. `lock.mjs` gains `liveLease(name)` and a `yieldToLease` option on `withLock`; `adb.mjs` gains `peekInstalled`, which runs only `adb -L tcp:127.0.0.1:<port> …` reads with `RUNNER_TRACKING_ID` blank. Plan and the gate use the Peek whenever a live Lease holds `adb`, including a Lease that takes `adb` while plan is queued behind another deploy's Job Hold.

## Boundaries & Constraints

**Always:** Node 24 ESM `.mjs` with `node:` builtins only. Tests stay hermetic: `hermetic()` where the file uses it, a temp `HUB_LOCK_DIR` and `HUB_EVENT_DIR`, and a fake adb or runner. A Peek never throws: any failure is `unknown`. Under a Lease, the only adb argv forms allowed are `-L tcp:127.0.0.1:<port> devices` (only when the Lease recorded no `adb_id`) and `-L tcp:127.0.0.1:<port> -s <id> shell dumpsys package <pkg>`. The port and id come from the Lease owner's `device.adb_port` and `device.adb_id` (written by `hub-device` `takeLease` via `updateLease`), else the default server `Number(env.ANDROID_ADB_SERVER_PORT) || 5037`. The plan's wait behind another deploy's Job Hold keeps its Queue place through the run's Reservation, which is the existing `withLock` behaviour.

**Never:** `start-server`, `connect`, `mdns`, `getprop`, `kill-server` or `reconnect` under a Lease. Never take, release or rewrite the Lease, the lock or a Reservation from the Peek. No second lock or queue. No change to `android.mjs`: its install-time newer-device refusal (around `android.mjs:126`) stays the downgrade guard. No new policy keys. No pending-delivery work (that is Story 3.2). Do not touch the front door's `tools/deploy.mjs` `checkPhone`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Leased, id recorded | live Lease on `adb` with `device {adb_id:'adb-R5GL…', adb_port:5038}`, package installed | plan takes no lock and writes no request/acquire events. The single adb call is `-L tcp:127.0.0.1:5038 -s adb-R5GL… shell dumpsys package <pkg>`. `s26=present`, the receipt `devices.s26` holds `{versionCode, versionName}`, and the plan downgrade check runs against it | none |
| Leased, no id recorded | live Lease with no `device` (taken `--no-connect`) | `-L tcp:127.0.0.1:5037 devices`, the id is picked by `idMatchesSerial(id, serial)` with state `device`, then dumpsys on that id | no match: `unknown` |
| Leased, server or device gone | the `-L` call exits non-zero or times out | `s26=unknown`. Plan proceeds and bumps, and `phone` is null, so no plan downgrade check runs. Log `HUB_S26_PEEK … unknown (<reason>)` | caught; never thrown |
| Job Hold, then a Lease | another deploy's job holds `adb` and a Lease takes it while plan waits | plan leaves the Queue with a `cancel` event (`reason: 'yield-to-lease'`) and then Peeks | `HUB_LOCK_YIELDED` is caught only by plan |
| Job Hold only | another deploy's job holds `adb`, then releases it | plan waits in the Queue, then takes `adb` and reads through `findPhone` as today | the existing timeout |
| Gate under a Lease | live Lease on `adb` | `quickS26` Peeks: `present` if the read worked, else `unknown`. No `findPhone` | never throws |
| Expired or dead Lease | `expires_at` has passed, or the same-host `holder_pid` is gone | not a live Lease. The normal `withLock` path reclaims it | the existing path |

</intent-contract>

## Code Map

- `tools/ci/lib/lock.mjs:41-76` -- `readOwner`, `isLease` and `staleness`. A live Lease is `isLease(owner) && staleness(...) === null`; use `staleMs: Infinity`, since a Lease is judged by expiry and holder only. Add `export function liveLease(name, { env, now, host, hostId })` near `isLease`. It returns the owner record or null and never throws.
- `tools/ci/lib/lock.mjs:179-233` -- `withLock`. Add the `yieldToLease = false` option and pass it to `queuedLock`. The bare mkdir path (lines 219-230) gets the same check before its deadline check.
- `tools/ci/lib/lock.mjs:817-938` -- `queuedLock`. In the waiting branches (lines 916 and 922-923), read `owner` before the deadline check. If `yieldToLease` and `owner` is a live Lease, then:
  - a ticketed wait calls `leave('cancel', { reason: 'yield-to-lease', blocked_by: describe(owner) })`; if `leave` returns false, throw `cancelled(...)`;
  - then throw `failure('HUB_LOCK_YIELDED', \`${heldText(name, owner)}; yielded to the Lease\`)`, with `.owner = owner` attached.
  The `finally` block already removes the ticket.
- `tools/ci/lib/adb.mjs:12,14-29,64-73` -- reuse `adbPath`, `parseDeviceList`, `parsePackage`, `idMatchesSerial` and `adbEnv`. Add `export function peekInstalled({ pkg, serial, lease = null, env, home, runner = runBounded })`, which returns `{ state: 'read'|'unknown', installed: {versionCode,versionName}|null, adb_id, adb_port, reason }`. Every call is `runner(adb, ['-L', \`tcp:127.0.0.1:${port}\`, ...args], { env: { ...adbEnv(env), RUNNER_TRACKING_ID: '' }, timeout, label })`, with a 15 s timeout for `devices` and 60 s for `dumpsys`.
- `tools/ci/commands/plan.mjs:231-249` -- the S26 block. Add a dep `adbRunner = runBounded` to `plan(...)`.
  - First, `liveLease('adb', { env })`: if it returns a Lease, Peek.
  - Otherwise, `withLock('adb', …, { env, timeoutMs: 20*60_000, yieldToLease: true })`. On `HUB_LOCK_YIELDED`, Peek with `error.owner`.
  - The Peek result sets `phone` (when read), `s26` (`present` or `unknown`), a note naming the Lease id, holder and port, and a log line `HUB_S26_PEEK lease=<id> adb=<id|-> port=<port> <result>`.
  - The plan downgrade check at line 280 is unchanged and runs only when `phone` is set.
- `tools/ci/commands/gate.mjs:138-147,178` -- `quickS26`. Add the args `manifest` and `adbRunner` (a new `gate` dep, `adbRunner = runBounded`). If `liveLease('adb', { env })`, return `peekInstalled(...).state === 'read' ? 'present' : 'unknown'`, logging `HUB_S26_PEEK`. Otherwise keep `findPhone` unchanged.
- `tools/ci/lib/exec.mjs:44` -- `runBounded(command, args, { label, timeout, env })` returns stdout or throws.
- `tools/device/hub-device.mjs:163-195` -- read-only evidence: a Lease's `device` record is `{phone, serial, adb_id, adb_port}`, written only when the phone was found. `--no-connect` records none.
- `tools/ci/v3.test.mjs:700-760` -- `fakeAdb` and `laneHost` write each argv to `phone/calls.log`. Teach `fakeAdb` to `shift 2` a leading `-L tcp:…` and to record it, so a test can assert the exact argv. Lines 941-970 are the away-S26 plan tests, a template for the new ones.
- `tools/ci/v11.test.mjs:140-160` -- the gate fixture `deps()`, which already injects `adbFactory`. Add `adbRunner`.
- `tools/ci/reservation.test.mjs` and `tools/ci/deadline.test.mjs` -- existing `withLock` and Queue tests, the pattern for a lock-level `yieldToLease` test with a fake `sleep` and `now`.

## Tasks & Acceptance

**Execution:**
- `tools/ci/lib/lock.mjs` -- add `liveLease`, and the `withLock`/`queuedLock` `yieldToLease` option with the `HUB_LOCK_YIELDED` code and the `cancel` event -- the shared "is a Lease holding this" check and the Queue exit
- `tools/ci/lib/adb.mjs` -- add `peekInstalled` (only `-L` reads, `RUNNER_TRACKING_ID` blank, never throws) -- the one Peek primitive (AD-13)
- `tools/ci/commands/plan.mjs` -- Peek under a live Lease, `yieldToLease: true` on the `adb` hold, the `adbRunner` dep, and the `unknown` outcome -- plan never waits behind a Lease
- `tools/ci/commands/gate.mjs` -- `quickS26` Peeks under a live Lease, plus the `adbRunner` dep -- the gate probe never runs `start-server`, `mdns` or `connect` under a Lease
- `tools/ci/v3.test.mjs` -- teach `fakeAdb` the `-L` form, and add plan tests:
  - a Lease with an id: one `-L … -s <id> shell dumpsys package` call, no lock events for plan, the receipt version, and the downgrade refusal still firing on a peeked newer code;
  - a Lease without an id: a `devices` lookup, then dumpsys;
  - a peek failure: `s26=unknown` and the bump proceeds;
  - for each case, a regex assertion that no `start-server|connect|mdns|getprop` appears in `calls.log` -- the matrix rows and the hermetic AC
- `tools/ci/reservation.test.mjs` (or the file where queued `withLock` tests live) -- `yieldToLease`:
  - a ticketed wait behind a job, which then becomes a Lease, throws `HUB_LOCK_YIELDED` with `owner` set, writes `request` then `cancel` (`reason: 'yield-to-lease'`) and leaves no ticket;
  - without the option, it keeps waiting;
  - an expired Lease is reclaimed, not yielded to -- the Queue behaviour
- `tools/ci/v11.test.mjs` -- a gate under a Lease: `adbFactory` is never called, `adbRunner` sees only `-L` argv, and `s26` is `present`, or `unknown` when the runner throws -- the gate AC

**Acceptance Criteria:**
- Given a live Lease on `adb`, when plan or the gate needs the S26, then no `adb.lock` is taken, no `request`/`acquire`/`release` event is written for plan, and every adb argv starts with `-L tcp:127.0.0.1:<port>` and runs with `RUNNER_TRACKING_ID` set to `''`.
- Given another deploy's Job Hold on `adb` and no Lease, when plan runs, then it waits in the Queue through its run's Reservation, as before. The existing event-sequence test in `v3.test.mjs:857` stays green, unchanged.
- Given the hermetic suite, when `mise run check` runs, then it passes, and the new tests show that no `start-server`, `connect` or `mdns` argv is ever issued under a Lease.

## Spec Change Log

## Review Triage Log

### 2026-11-24 — Review pass
- verdicts: 30 findings — high 0, medium 4, low 15, false 10, maybe-false 1
- findings:
  - `[false]` `[reject]` (blind) `-L` may still launch a server on a dead port. Refuted: adb only starts a server for a `localhost` or empty-host spec. Running the real adb 37.0.0 on big-chungus with `-L tcp:127.0.0.1:59997 devices` printed "cannot start server on remote host", and no listener appeared. A comment now explains why the host must stay `127.0.0.1`.
  - `[low]` `[reject]` (blind) A recorded `adb_id` is not checked against the serial. It was recorded by `findPhone` in `takeLease`, which checked serial and model on the `adb` (S26) lock. A reused `ip:port` within one Lease is not an everyday case, and the fix adds a guard that would also turn valid manual-connect ids into `unknown`.
  - `[low]` `[reject]` (blind) A hung adb server can stall the gate for up to about 75 s under a Lease. That needs a hung server during a Lease, which is rare. The bounded timeouts still end it, and a fix needs a new knob.
  - `[low]` `[reject]` (blind) `s26=unknown` is not carried into receipts, the workflow or the docs. Nothing branches on `s26`: the workflow and `android.mjs` never read it, and it only appears in gate and plan logs and receipts.
  - `[false]` `[reject]` (blind) Nothing proves the install-time guard after an `unknown` plan. The android lane's newer-device refusal is pinned by the v3 test "Re-run failed jobs…" (`/versionCode 9, above the planned 5/`), and it runs whatever plan saw.
  - `[maybe-false]` `[reject]` (blind) Other fixed-T0 tests may also be time bombs. To settle it, find a test that compares the real clock against T0 plus more than 180 min. The full suite is green at T0+5 h, and any such test would only be `low`.
  - `[medium]` `[patch]` (blind) Test gaps for `peekInstalled`'s validation and fallbacks. Grouped with the verification-gap finding below. A direct `peekInstalled` unit test was added.
  - `[false]` `[reject]` (blind) Flaky tests: the non-atomic `owner.json` write, the hand-written Lease and the 150 ms timeout. A half-read `owner.json` parses as a null owner, which counts as held, not stale, for 60 s, so the next poll is correct. A Lease with no `holder_pid` is live until it expires, by design. The 150 ms test waits on a Lease that lasts 60 s, so it times out deterministically.
  - `[low]` `[reject]` (blind) The gate's Peek log omits the holder and passes the raw adb reason through. These are cosmetic log details. Plan's notes name the holder, and the reason is capped at 200 characters on one line.
  - `[false]` `[reject]` (edge) `-L` may spawn a server. Same refutation as the first row: the real adb was run.
  - `[low]` `[reject]` (edge) A stale recorded id (a new mDNS suffix) gives `unknown` while the phone is reachable. That is the safe outcome, and the install-time guard still runs. The spec limits the `devices` lookup to Leases with no recorded id.
  - `[low]` `[reject]` (edge) A valid id with an invalid port uses 5037. `hub-device` always records `Number(port)` with the id, so this is not an everyday case.
  - `[low]` `[reject]` (edge) The recorded id is not compared to the serial. Same as the blind-hunter row above.
  - `[low]` `[reject]` (edge) A dumpsys reply with no package header reads as "not installed". `parsePackage` already behaves this way on the existing `findPhone` path, and the install-time guard remains.
  - `[low]` `[patch]` (edge) A missing `versionName` prints `null (4)`. Fixed with `versionName ?? '-'` in the `HUB_S26_PEEK` line and the plan's Peek note.
  - `[false]` `[reject]` (edge) The `unknown` path does not release the Reservation. Plan's `away` path does not release it either, because the Android lane still runs and needs its place. Only `!scope.android` releases.
  - `[false]` `[reject]` (edge) A version is spent before the install-time refusal. This is the behaviour the acceptance criteria specify ("the downgrade guard falls to install time").
  - `[low]` `[reject]` (edge) `unknown` is a new state for consumers. Same as the blind-hunter row above: no consumer branches on it.
  - `[low]` `[reject]` (edge) An invalid `ANDROID_ADB_SERVER_PORT` gives a bad `-L` spec. This needs an operator to set a nonsensical value, and the result is a safe `unknown`.
  - `[medium]` `[patch]` (verification-gap) The device filter, id and port validation, and env port fallback had no test. Added a `peekInstalled` unit test in `v3.test.mjs`: offline gives `unknown`; a malformed id and port fall back to `devices` on 5037; the env port 5040 is honoured; no pkg makes no call; and `RUNNER_TRACKING_ID` is `''` on every call.
  - `[medium]` `[patch]` (verification-gap) "Read, package not installed" was never asserted under a Lease. Added a plan test: `s26=present`, receipt `s26=null`, and the log shows `read (not installed)`.
  - `[low]` `[reject]` (verification-gap, other) The `yieldTo` branch where the ticket was already released is untested. Reaching that race needs a new test seam.
  - `[false]` `[reject]` (intent) The extra `-L devices` argv goes beyond "only". The AC's "only" exists to prevent disturbing the leaseholder (AD-13 "Prevents"), and `devices` over `-L 127.0.0.1` neither starts nor reconnects anything. AD-13's "a missing device means unknown" requires a listing when no id is recorded.
  - `[false]` `[reject]` (intent) `-L` is always passed, even on the default server. That is AD-13's rule: the `-L` form is what refuses to launch.
  - `[low]` `[patch]` (intent) The Job Hold plan test did not exercise the run's Reservation. It now reserves `adb` first, and asserts that the plan's `request` carries `reservation: delorenj--example-app--777`.
  - `[false]` `[reject]` (intent) `yieldToLease` is wider than the AC. The story's "so that I neither block behind the Lease" covers a Lease that takes `adb` while plan is queued.
  - `[low]` `[reject]` (intent) The gate's `present` changes meaning under a Lease. It is an informational receipt and log field that nothing branches on.
  - `[medium]` `[patch]` (intent) There are no `peekInstalled` unit tests. Grouped with the verification-gap patch above.
  - `[false]` `[reject]` (intent) Other S26 read sites (`android.mjs`, `deploy.mjs`) are untouched. The AC names plan and `quickS26`, and keeps the lane's guard at install time.
  - `[low]` `[reject]` (intent) An unrelated clock fix is in `reservation-release.test.mjs`. It is needed for a green suite: the fixed T0 passed its 180-min ceiling on 2026-11-24. Kept.

## Design Notes

When no `adb_id` is recorded, a `-L … devices` listing finds the id. AD-13 says "else the default server" and "a missing device means `unknown`": both imply a server-side lookup, and `devices` neither starts nor reconnects anything. The id match is a pure string match (`idMatchesSerial` with no mDNS map), so it needs no `getprop`. A manual `host:port` id therefore cannot match, and the result is `unknown`.

`yieldToLease` is a generic `withLock` option, not plan-specific code. A Lease that takes `adb` between plan's queued polls would otherwise hold plan for up to 60 min, the deploy-target cap. The `cancel` event keeps the Event Log's request/ending pairing intact.

Plan's `s26` output gains the value `unknown` next to `present`, `away` and `n/a`. Nothing downstream branches on it: the workflow and `android.mjs` do not read it.

## Verification

**Commands:**
- `node --test tools/ci/v3.test.mjs tools/ci/v11.test.mjs tools/ci/reservation.test.mjs` -- expected: all pass
- `mise run check` -- expected: actionlint and the full suite are green
- `grep -nE "start-server|'connect'|mdns" tools/ci/lib/adb.mjs` -- expected: no hit inside `peekInstalled`
</content>
</invoke>

## Auto Run Result

Status: done

**Summary.** Under a live Lease on `adb`, plan and the gate's `quickS26` no longer take a lock or touch the leaseholder's adb server. They Peek instead, using one shared read-only primitive (`peekInstalled`). It runs only `adb -L tcp:127.0.0.1:<port> …` reads, with `RUNNER_TRACKING_ID` blank, using the Lease's recorded `adb_port` and `adb_id`. With no recorded id it falls back to the default server and a `devices` lookup. A failed read is `unknown` and plan proceeds, leaving the downgrade guard to install time. A plan queued behind another deploy's Job Hold still waits in the Queue through its Reservation. If a Lease takes `adb` during that wait, `withLock`'s new `yieldToLease` makes plan leave the Queue with a `cancel` event (`yield-to-lease`) and Peek. One level up (belsky-doctrine): every deploy-run read of a leased S26 goes through one primitive, and `yieldToLease`/`liveLease` work for any Queued lock.

**Files changed**
- `tools/ci/lib/lock.mjs`: `liveLease(name)`, plus the `withLock`/`queuedLock` `yieldToLease` option (`HUB_LOCK_YIELDED`, with a `cancel` event).
- `tools/ci/lib/adb.mjs`: `peekInstalled`, the AD-13 Peek. It never throws.
- `tools/ci/commands/common.mjs`: `peekS26`, a wrapper that logs `HUB_S26_PEEK`.
- `tools/ci/commands/plan.mjs`: Peeks under a live Lease, yields to a Lease mid-wait, takes an `adbRunner` dep, and can now output `s26=unknown`.
- `tools/ci/commands/gate.mjs`: `quickS26` Peeks under a live Lease, and takes an `adbRunner` dep.
- `tools/ci/v3.test.mjs`: `fakeAdb` now understands `-L`. Adds a `peekInstalled` unit test and plan tests:
  - a Lease with a recorded id, with no recorded id, unreadable, and with the package not installed;
  - a plan behind a Job Hold, with its Reservation;
  - a Job Hold that a Lease then takes, so plan yields.
- `tools/ci/v11.test.mjs`: a gate test under a Lease, covering `present` and `unknown`, using only `-L` argv.
- `tools/ci/reservation.test.mjs`: `liveLease`, the `yieldToLease` events, the bare path, and an expired Lease being reclaimed.
- `tools/ci/reservation-release.test.mjs`: fixed a time bomb. The test now stamps its Reservation on the real clock, because the fixed T0 of 2026-11-24T10:00Z passed the 180-min ceiling that day.

**Review findings.** There were 30 findings: 4 medium, 15 low, 10 false, 1 maybe-false.
- **Patched (4 entries):** two medium test gaps (`peekInstalled` unit coverage, and the not-installed Peek) and two low items (`versionName ?? '-'`, and the Job Hold test now exercises the Reservation).
- **Deferred:** none.
- **Rejected:** each one has its reason in the Review Triage Log. The headline rejection is "`-L` may still launch a server". It is refuted by the real adb 37.0.0 on big-chungus, which printed "cannot start server on remote host" for `-L tcp:127.0.0.1:59997`.
- **Patched counts by verdict:** high 0, medium 2, low 2.

**Follow-up review: false.** The rule counts the two patched mediums, but both were test-coverage gaps and are now covered and green. The one risk no hermetic test could reach, `-L` launching a server, was checked against the real adb binary. No unverified risk remains to name.

**Verification**
- `node --test tools/ci/v3.test.mjs tools/ci/v11.test.mjs tools/ci/reservation.test.mjs`: all pass.
- `mise run check`: actionlint, then 636 of 636 tests pass.
- `grep -nE "start-server|'connect'|mdns" tools/ci/lib/adb.mjs`: no hit inside `peekInstalled`.
- Real adb 37.0.0, run as `-L tcp:127.0.0.1:59997 devices` on an unused port, printed "cannot start server on remote host", and no listener appeared.

**Residual risks**
- A recorded `adb_id` is trusted without a serial check, but `findPhone` checked it when the Lease was taken.
- A manual `host:port` id cannot be found by the `devices` lookup, so it gives `unknown`.
- The front door, `tools/deploy.mjs` `checkPhone`, still runs `start-server`. It was out of scope, and on its default server that call is a no-op.
- This ships in the next hub release. Runs pinned to v1.2.46 keep the old behaviour.
