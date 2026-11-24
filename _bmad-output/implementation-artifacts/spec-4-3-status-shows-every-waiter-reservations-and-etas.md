---
title: 'Story 4.3: Status shows every waiter, Reservations and ETAs'
type: 'feature'
created: '2026-11-24'
status: done
review_loop_iteration: 0
baseline_revision: '51cc70a8100110cc3353a95b7436486f7dae2d98'
followup_review_recommended: true
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-4-context.md'
warnings: ['oversized']
deferred: []
operator_actions:
  - 'After the orchestrator merges stories 4.1, 4.2 and 4.3 to main, cut the hub release from a fresh clean clone of main with `mise run release -- 1.2.47` (if more stories land first, extend the `## v1.2.47` section in docs/hub-releases.md before tagging).'
  - 'Once the release runner reports every app dry run finished, run `mise run hosts:install` from a clean checkout at tag v1.2.47 on big-chungus and on the Mac, then confirm both hosts report `current` at v1.2.47 and no catch-up timer or launchd interval came back.'
  - 'On big-chungus, run `hub-device status` and `hub-device status --json` from the installed release while a deploy waits on `adb`, and confirm the JOB row with repo, run, job and `eta=` and the RESERVATIONS section appear.'
---

<intent-contract>

## Intent

**Problem:** `hub-device status` lists waiter tickets as Lease rows only (`<id> holder=… why=…`) with no ETA, hides Reservations entirely, and `release job:…` falls into the Lease paths, so a person or agent cannot see the whole line for a device or what to do about a deploy job in it (FR-8, FR-13).

**Approach:** One level up (belsky-doctrine): one read-only observer in `lock.mjs` gives the live ETA of every waiter on any Queued lock from one windowed Event Log read, so `status` today and the v1b Hub API later reuse it. `status` renders waiter rows by kind with that ETA (`formatEta`), adds a Reservations section and JSON keys, and `release` refuses `job:` ids naming the run to cancel. The pre-release half of the 4.1–4.3 hub release (the `docs/hub-releases.md` section) is written; the release itself happens once all three are on main.

## Boundaries & Constraints

**Always:**
- Status stays read-only: no write to the lock dir, queue, Reservations or Event Log (observer `queueView`, no prune, no grace start). Events are read once per `status` call, only the policy window (`eta_window_days`), never per waiter.
- ETA is `eta()` from `eta.mjs` per live waiter, with `file` = its ticket and `deadline_at` = its own; text is `formatEta()`. A stale waiter has `eta: null` and prints no `eta=`; a live one whose ETA fails prints `eta=?`. Status never fails because of an ETA (bad policy, unreadable log).
- `waiters[]` keeps every existing key with its existing meaning (`position` stays the 1-based index among the lock's ticket waiters, stale included, as Story 2.5 pinned) and adds `kind`, `repo`, `run`, `job`, `eta` (`{lo_ms, hi_ms, low_data}` or null). New top-level `reservations[]`: `{lock, device, run_key, repo, run, place, blocking, grace: {state, started_at, ends_at}, reserved_at, expires_at, stale}` from the observer `queueView` entries of kind `reservation`, on every name status already walks plus `RESERVABLE`.
- Text: a Lease row keeps its prefix (`  <dev> #<n>  <lease_id>  holder=<h>  why="<w>"  waiting since <t>`), and a job row is `  <dev> #<n>  JOB <repo> run <run> job <job>  waiting since <t>` (hub-job: `CATCH-UP` instead of `JOB`); both append `  eta=<formatEta>` when live, `  [stale]` when stale. Missing values print `-`, never `undefined`. A `RESERVATIONS` section (after WAITERS, before INVENTORY) prints only when `reservations[]` is non-empty: `  <dev or lock>  <run_key>  place <n>  grace <pending|running until <iso>|over>  expires in <age> (<iso>)`, `[blocking]` when it blocks, `[expired]` when stale.
- `hub-device release <id>` where the id (argument or `$HUB_LEASE_ID`) starts with `job:` exits 2 with one stderr line `HUB_DEVICE_JOB_ID <id> is a deploy job's place in line, not a lease; cancel run <run> of <repo> instead (gh run cancel <run> --repo <repo>)`; when the id does not parse as `job:<repo>#<run>.<attempt>/<job>` or the repo is `local`, it names what it can and omits the `gh` hint. It touches nothing.
- Node 24 ESM, no new dependency, no new clock or policy key; hermetic tests.

**Never:**
- No change to the nine-line empty status fixture (`hub-device.test.mjs:1046`), to existing exit codes, `HUB_DEVICE_*` lines, or existing JSON keys.
- No change to `eta()` math, the wait line, ticket or event formats.
- No hub release, tag or `hosts:install` from this worktree (story branches merge to main through the orchestrator first).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Job waiter behind Lease | Lease holds `adb`, `withLock('adb')` job of `o/a` run 9 job android waits | row `s26 #1  JOB o/a run 9 job android  waiting since … eta=…`; JSON `kind:'job', repo:'o/a', run:'9', job:'android', eta:{…}` | — |
| Lease waiter | as today | old prefix + `  eta=0s-…` | — |
| Stale waiter | dead ticket | `[stale]`, `eta: null`, file untouched | — |
| Live Reservation | `reserve('adb')` for a run, lock free | RESERVATIONS section with run key, `place 1`, `grace pending`, expiry, `[blocking]`; nothing written | — |
| Nothing new | empty lock dir | nine-line output unchanged, `reservations: []` | — |
| ETA fails | broken policy / unreadable events | `eta=?`, JSON `eta: null`, exit 0 | swallowed |
| release job id | `release job:o/a#9.1/android` | exit 2, `HUB_DEVICE_JOB_ID …cancel run 9 of o/a…` | nothing released |
| Month of history | ~15k events over 30 days, waiters on two locks | status completes < 200 ms | — |

</intent-contract>

## Code Map

- `tools/ci/lib/lock.mjs:820-834` `enqueueEta` -- the read-and-compute path (owner, observer view, windowed `readEvents`, `eta()`). Factor the window read into an exported `etaHistory({env, now, policy})` (returns the event array; `log: () => {}`) and use it here.
- `tools/ci/lib/lock.mjs` (new export, next to `enqueueEta`) -- `waiterEtas({owner, view, events, policy, now})`: a Map from each live ticket entry's `file` (kind ≠ reservation, not stale) to `eta({owner, view: view.filter(e => !e.stale), file, deadline_at: entry.deadline_at}, events, policy, now)` or null on throw. No I/O. The observer every surface (status now, Hub API later) uses.
- `tools/ci/lib/lock.mjs:774` `queueView` -- the single Queue source (AD-6). `includeStale: true` view filtered by `!stale` equals the observer view for ETA purposes (ticket `blocking = !stale`; reservation head is the first non-stale).
- `tools/ci/lib/lock.mjs:708-716` `reservationEntry` -- fields for `reservations[]` (`key`, `run_key`, `repo`, `run`, `place`, `blocking`, `grace`, `reserved_at`, `expires_at`, `stale`).
- `tools/ci/lib/lock.mjs:446` `jobLeaseId` -- the `job:<repo>#<run>.<attempt>/<job>` shape `release` parses.
- `tools/ci/lib/policy.mjs:323` `loadPolicy` -- status loads the policy once; a failure means every ETA is null.
- `tools/ci/lib/eta.mjs:166` `formatEta` -- the one ETA text.
- `tools/device/hub-device.mjs:540-617` `status` -- waiters loop at 555-560 (add RESERVABLE to the names, collect reservations, read owner per lock, compute ETAs), JSON at 579, WAITERS text at 603-605. `readOwnerOf` (line 49) reads an owner.
- `tools/device/hub-device.mjs:407-427` `release` -- add the `job:` refusal before the emulator check; `report` (258) is the usage path, but this line is its own `HUB_DEVICE_JOB_ID` on stderr with `return 2`.
- `tools/device/hub-device.test.mjs:57` `fixture()` -- `f.env` has `HUB_LOCK_DIR`, `HUB_EVENT_DIR`; `f.run` captures out/err. Tests at 981 (Reservations stay out of waiters), 1004 (status lists), 1046 (nine-line fixture) must stay green unchanged.
- `tools/device/hub-device.test.mjs:585` -- pattern for a job (`withLock`) and a Lease waiter coexisting.
- `README.md:248,253` -- `status` description; `README.md:98` says status "will reuse" `formatEta` -- update.
- `docs/features.md:43` -- `hub-device` feature line; add status ETAs/Reservations and the wait line.
- `docs/hub-releases.md` -- add a `## v1.2.47` section (Epic 3 stories 3.1–3.4 and Epic 4 since v1.2.46; `git log v1.2.46..HEAD`).

## Tasks & Acceptance

**Execution:**
- [ ] `tools/ci/lib/lock.mjs` -- add `etaHistory` and `waiterEtas` per Code Map; `enqueueEta` uses `etaHistory` -- one observer ETA path for every surface.
- [ ] `tools/device/hub-device.mjs` -- `status`: walk `RESERVABLE` too; per name read owner and `queueView(includeStale)`, compute `waiterEtas` with one `etaHistory` and one policy (`main`'s new optional `policy` seam, else `loadPolicy()`; both in try/catch → no ETAs); waiter objects gain `kind`, `repo`, `run`, `job`, `eta`; build `reservations[]`; render rows by kind and the RESERVATIONS section. `release`: `job:` refusal. Update the header usage comment.
- [ ] `tools/device/hub-device.test.mjs` -- new tests: (a) a `withLock('adb')` job waiting behind a Lease shows its JOB row with repo/run/job and `eta=`, JSON keys, no `undefined` anywhere in the text; the Lease waiter row carries `eta=`; (b) a live Reservation prints the RESERVATIONS section and `reservations[]` with run key, place, grace, expiry, and the lock tree is unchanged; (c) `release job:o/a#9.1/android` exits 2 with `HUB_DEVICE_JOB_ID` naming run 9 and o/a, and a waiting job ticket stays; (d) a month of fixture events (~15k lines across 30 days) plus waiters: status (fake inventory) best of 3 runs < 200 ms, and the events dir bytes are unchanged; (e) with an injected broken policy (`main(argv, {policy: {queue: {}}})`) a live waiter prints `eta=?`, JSON `eta: null`, exit 0; a stale waiter has `eta: null` and no `eta=`.
- [ ] `tools/ci/eta.test.mjs` or `tools/ci/lock.test.mjs` -- unit test `waiterEtas`: stale and reservation entries get no ETA, each live ticket uses its own file and deadline, a throwing policy yields null.
- [ ] `README.md`, `docs/features.md` -- document the status waiter rows, ETA, RESERVATIONS section, new JSON keys and the `job:` refusal.
- [ ] `docs/hub-releases.md` -- `## v1.2.47` section: what changed since v1.2.46 (Peek under a Lease, `S26 busy` pending, catch-up in its turn, newer-installed refusal named, enqueue ETA, wait line, status), and the wording change (wait line, AD-17).

**Acceptance Criteria:**
- Given a deploy job waiting on `adb`, when `hub-device status` runs, then its row shows repo, run and job (never `undefined`) with its position and live ETA, and `--json` carries `kind/repo/run/job/position/eta`.
- Given live Reservations, when status runs, then a RESERVATIONS section shows run key, place, grace state and expiry; with none, the nine-line fixture is byte-identical.
- Given `hub-device status --json`, when it runs, then every pre-existing key is present with its old meaning and only `waiters[].kind/repo/run/job/eta` and `reservations[]` are new.
- Given `hub-device release job:…`, when it runs, then it exits 2 with a `HUB_DEVICE_JOB_ID` line naming the run to cancel and changes nothing.
- Given a month of fixture events, when status computes ETAs, then it writes nothing and answers in under 200 ms.
- Given `mise run check`, when it runs, then actionlint and the full suite pass.

## Spec Change Log

## Review Triage Log

### 2026-11-24 — Review pass
- verdicts: 27 findings — high 0, medium 4, low 20, false 3, maybe-false 0
- findings:
  - `[low]` `[patch]` Blind: status `#n` and the wait line's `position=` number differently (stale tickets, blocking Reservations). Evidence: `position` keeps the Story 2.5 meaning that the AC's "no renames" protects, so the fix is documentation. Fixed: the README now says what `#n` counts and how it differs from `position=` and a Reservation's `place`.
  - `[false]` `[reject]` Blind: the Reservation expiry text can print `NaN` for a missing `expires_at`. Evidence: `readReservation` (`lock.mjs:573`) drops any record without a finite `expires_at`, so every `reservation` entry status sees has one.
  - `[low]` `[patch]` Blind: the `release job:` line is unhelpful for local and malformed ids. Evidence: the catch-up's own ticket id is `job:local#local-<pid>.1/job` (`buildTicket`), which status shows. Fixed: a local id now says `it is the local process <pid>, stop that process instead`. The malformed case (`cancel its run`) is rare and stays as is.
  - `[low]` `[patch]` Blind: the release notes did not list the exit-code change of `release job:` (exit 0 `HUB_DEVICE_NOT_HELD` → exit 2). Fixed: a bullet under "Wording change you will see".
  - `[low]` `[reject]` Blind: an ETA failure in status leaves no reason. Evidence: the spec makes status swallow it (`eta=?`). The `etaHistory` throw path is tested, because `{queue: {}}` gives `readEvents` a `NaN` `since`, which throws. A reason line would add output surface for a rare case.
  - `[low]` `[patch]` Blind: several status branches are untested (CATCH-UP, running and expired grace, `mac-ios`, unknown kind). Fixed: tests now cover CATCH-UP, running grace, an expired Reservation and `mac-ios` (same group as the verification-gap rows). The unknown-kind part is rejected: v1 writes no other kind (`TICKET_KINDS`).
  - `[low]` `[reject]` Blind: the 200 ms wall-clock test may flake on the shared box. Evidence: measured at 30, 24 and 23 ms at load average 6.9. Best of 3 leaves about 8x headroom, and the AC requires the bound.
  - `[low]` `[reject]` Blind: status on big-chungus cannot see the Mac's `mac-ios` queue. Evidence: by design, the `mac-ios` lock lives on the Mac's disk (AGENTS.md), and status on the Mac walks it through `RESERVABLE`.
  - `[low]` `[reject]` Blind: smaller consistency gaps (no value list for `kind`, no `grace` shape in the README, `now` passed as a function to `queueView` against the `nowMs` snapshot). Evidence: cosmetic, and the clock skew is microseconds within one call.
  - `[low]` `[reject]` Edge: a dead holder's owner is passed to `eta()` unchecked. Evidence: same rule as `enqueueEta` in Story 4.1. Status shows the lock `[stale]` on its own line, and changing the holder rule would change the 4.1 ETA math.
  - `[low]` `[patch]` Edge: `position` counts stale tickets while the ETA ignores them. Same root cause and fix as the first Blind row: the README note.
  - `[low]` `[reject]` Edge: a ticket of an unknown kind renders as a Lease row. Evidence: v1 writes only lease, job and hub-job (`buildTicket`), and the row prints `-` rather than `undefined`.
  - `[false]` `[reject]` Edge: `NaN` expiry. Same refutation as the Blind row (`lock.mjs:573`).
  - `[low]` `[reject]` Edge: a job id with a newline breaks the one-line stderr. Evidence: it is the caller's own argument echoed back, with no privilege involved. Sanitizing would add a branch for input nobody passes.
  - `[low]` `[reject]` Edge: `waiterEtas` costs waiters × events. Evidence: `eta()` is linear in the windowed events. Two waiters over 15k events take about 25 ms, and a lock rarely has more than a few waiters.
  - `[low]` `[reject]` Edge: the 200 ms test may flake. Same evidence as the Blind row (measured 23–30 ms).
  - `[low]` `[patch]` Edge (claim): `place` and `#n` are different numberings. Same root cause as the first Blind row. Fixed by the same README sentence.
  - `[medium]` `[patch]` Verification gap: the `CATCH-UP` (hub-job) row is untested. Fixed: the first 4.3 status test now adds a `hub-job` waiter and asserts JSON `kind: 'hub-job'`, position 3, an ETA and the `CATCH-UP … eta=` text row.
  - `[medium]` `[patch]` Verification gap: the RESERVATIONS running-grace and expired branches are untested. Fixed: a hand-written `grace.json` asserts `grace running until <iso>` and `state: 'running'`. An injected `now` 4 h ahead asserts `expired <age> ago`, `[expired]`, `stale: true` and `blocking: false`.
  - `[medium]` `[patch]` Verification gap: the `...RESERVABLE` walk (`mac-ios`) is untested. Fixed: the Reservation test reserves `mac-ios` with no lock present and asserts its `reservations[]` entry and its RESERVATIONS line.
  - `[low]` `[patch]` Verification gap (other): `eta !== null` does not prove the history was read. Fixed: the month-of-events test asserts the job waiter's `eta.low_data === false`.
  - `[low]` `[patch]` Verification gap (other): the numberings are inconsistent within one status output. Same root cause as the first Blind row. Fixed by the same README sentence.
  - `[low]` `[patch]` Intent: position reading D (the wait line's) against E (the status index). Same group. The diff implements E, which the "no renames" AC protects. The README sentence documents the difference.
  - `[low]` `[reject]` Intent: the release AC is not run, and the spec is not at awaiting-operator. Evidence: the fix is this spec's finalization, not code. The spec is finalized to `awaiting-operator` with `operator_actions` for the release and the installs.
  - `[false]` `[reject]` Intent: the nine-line fixture is not re-asserted. Evidence: `hub-device.test.mjs` "status with nothing held says so" asserts the nine lines verbatim and passes unchanged, and the Reservation test asserts no RESERVATIONS line without one.
  - `[low]` `[reject]` Intent: the perf bound is checked in-process, not as a spawned CLI on big-chungus. Evidence: the suite runs on big-chungus (self-hosted CI and local), and process start is not part of "answers".
  - `[medium]` `[patch]` Intent: `hub-job` JSON and text are not exercised. Same group as the CATCH-UP verification-gap row. Fixed by the same test.

## Design Notes

**Why `position` keeps its meaning.** The AC asks for "no renames or removals", and Story 2.5's test pins the numbering (a Reservation is not a waiter, a stale ticket keeps its number). The wait line's `position` counts blocking entries ahead; status shows the Reservation in its own section with its `place`, and the waiter's ETA already includes a blocking Reservation's grace. The two agree whenever no stale ticket or blocking Reservation sits ahead.

**Why the release is owed, not done.** The last AC is "Given stories 4.1–4.3 are on main … ship as a hub release". This story runs on a bmad-loop branch the orchestrator merges; a release must be cut from a clean clone of main (`mise run release -- 1.2.47`) and installed from the tag on both hosts. The section in `docs/hub-releases.md` is written here so the tag carries it.

Example rows:
```
WAITERS
  s26 #1  JOB o/a run 9 job android  waiting since 2026-11-24T12:00:00.000Z  eta=0s-15m low-data
  s26 #2  next  holder=agent-b  why="next in line"  waiting since 2026-11-24T12:00:01.000Z  eta=0s-1h00m low-data
RESERVATIONS
  s26 (adb)  delorenj--example--5  place 1  grace pending  expires in 3.0h (2026-11-24T15:00:00.000Z)  [blocking]
```

## Verification

**Commands:**
- `node --test tools/device/hub-device.test.mjs tools/ci/eta.test.mjs` -- expected: all pass
- `mise run check` -- expected: actionlint clean, full suite green

## Auto Run Result

Status: awaiting-operator

**Summary:** `hub-device status` now shows the whole line for a device.
- Every waiter appears by kind:
  - a Lease row with the same prefix as before;
  - `JOB <repo> run <run> job <job>` for a deploy job;
  - `CATCH-UP` for the catch-up.
- Each waiter shows its position and a live ETA (`eta=` through `formatEta`). A stale ticket shows `[stale]` and no ETA, and an ETA that fails shows `eta=?`.
- A RESERVATIONS section appears only when a Reservation exists. It shows the run key, the place in line, the grace state (`pending`, `running until <iso>` or `over`), the expiry, `[blocking]` and `[expired]`.
- `--json` adds `waiters[].kind/repo/run/job/eta` and a top-level `reservations[]`. No key is renamed or removed, and `position` keeps its Story 2.5 meaning.
- `hub-device release job:…` exits 2 with one `HUB_DEVICE_JOB_ID` line. It names the run to cancel (`gh run cancel <run> --repo <repo>`), or the local process for the catch-up's `job:local#local-<pid>` id, and touches nothing.
- Status stays read-only. It reads the Event Log once, only within the policy window, and only when a live waiter exists. A failing policy or log never fails status.

One level up (belsky-doctrine): Jarad asked to see the line for the S26. Every Queued lock got the same view, including `mac-ios` and its Reservations through `RESERVABLE`. The observer is in `lock.mjs`: `etaHistory` does the one windowed read, and `waiterEtas` maps each live waiter to `eta()`. `enqueueEta` now uses it, and the v1b Hub API can reuse it without a second ETA path.

**Files changed:**
- `tools/ci/lib/lock.mjs`: `etaHistory` (one read of the policy window) and `waiterEtas` (the live ETA per waiter, null on a throw, no I/O). `enqueueEta` uses `etaHistory`.
- `tools/device/hub-device.mjs`:
  - `status`: walks `RESERVABLE`, renders waiter rows by kind with their ETA, builds `reservations[]` and prints RESERVATIONS.
  - `main`: an optional `policy` seam.
  - `release`: the `job:` refusal.
  - The usage header is updated.
- `tools/device/hub-device.test.mjs`: new status tests:
  - JOB, Lease and CATCH-UP rows with their ETAs and JSON keys;
  - RESERVATIONS: pending, running grace, expired, and `mac-ios` with no lock;
  - the `job:` refusal: GitHub, `$HUB_LEASE_ID`, local and malformed ids;
  - a month of events (15k lines): best of 3 under 200 ms, with `low_data: false` and the Event Log untouched;
  - a broken policy and a stale waiter.
- `tools/ci/eta.test.mjs`: a unit test for `waiterEtas`.
- `README.md`: the status WAITERS and RESERVATIONS output, the JSON keys, how `#n`, `position=` and `place` differ, and the `job:` refusal.
- `docs/features.md`: the `hub-device` line covers the wait line, status ETAs, Reservations and the refusal.
- `docs/hub-releases.md`: the `## v1.2.47` section (Epic 3 stories 3.1–3.4 and Epic 4), with a wording-change list that includes the wait line and the `release job:` exit code.

**Commits:** `2120a2e83090831304d9613e5a78f1f565eca9fe` (implementation), `bddbe61f213e53f29f407b3039679c21bbb6f705` (review fixes), then the spec commit. None are pushed: the orchestrator merges story branches.

**Review findings:** 27 in total. Verdicts: high 0, medium 4, low 20, false 3.
- **Patched (5 entries):**
  - Medium: CATCH-UP row test.
  - Medium: running-grace and expired Reservation tests.
  - Medium: `mac-ios` walk test.
  - Low: README note on `#n`, `position=` and `place` (grouped from 6 rows).
  - Low: local-process wording of `release job:`.
  - Low: the release notes list the exit-code change.
  - Low: the month-of-events test asserts `low_data: false`.
- **Deferred:** 0.
- **Rejected:** 15. Full reasons are in the Review Triage Log.
  - 3 false: two rows on a `NaN` expiry (`readReservation` requires a finite `expires_at`), and the nine-line fixture, which is asserted verbatim and passes.
  - 12 low:
    - No ETA failure reason is printed (the spec swallows the error, and the throw path is tested).
    - The 200 ms flake risk, raised twice (measured 23–30 ms).
    - `mac-ios` cannot be seen from big-chungus (by design: the lock is on the Mac).
    - Cosmetic README and clock nits.
    - A dead holder in `eta()` (the 4.1 rule).
    - An unknown ticket kind (v1 writes none).
    - Newline injection in the caller's own argument.
    - `waiterEtas` cost (measured).
    - The release AC (handed off through `operator_actions`).
    - The perf test runs in-process.
- **Patched by verdict:** high 0, medium 3 entries (4 rows), low 4 entries.

**Follow-up review recommended: true.** This first pass patched three `medium` entries. The named unverified risk is that no reviewer has seen the review-pass changes: the new `release` local-process branch in `hub-device.mjs` and the tests added in `bddbe61`.

**Verification:**
- `node --test tools/device/hub-device.test.mjs tools/ci/eta.test.mjs`: 82 of 82 pass, before and after the patches.
- `mise run check` after the patches: exit 0, actionlint clean, 703 of 703 pass (0 fail, 0 skipped).
- The status perf test was measured at 30, 24 and 23 ms at load average 6.9.
- The I/O matrix audit covered every row:
  - job and Lease waiters (test 1);
  - a stale waiter (the broken-policy test and the existing stale test);
  - a live Reservation (the Reservation test);
  - nothing new (the nine-line fixture);
  - an ETA failure (the broken-policy test);
  - `release` with a job id (the refusal test);
  - a month of history (the perf test).

**Operator actions owed (frontmatter `operator_actions`):** the last AC ("Given stories 4.1–4.3 are on main … ship as a hub release … followed by `hosts:install` on both hosts") can only run after the orchestrator merges this branch to main. Releases must be cut from a fresh clean clone of main, never a story worktree. The release notes for it are written.
- Cut `mise run release -- 1.2.47` from a clean clone of main.
- Run `hosts:install` from the tag on big-chungus and the Mac, and verify both hosts.
- Check `hub-device status` live on big-chungus while a deploy waits.

**Residual risks:**
- Status `#n` and the wait line's `position=` differ when a stale ticket or a blocking Reservation is ahead. This is documented and intended: `position` keeps its old meaning.
- On big-chungus, status shows nothing for `mac-ios`, because that lock lives on the Mac. Run status on the Mac to see the iPad line.
- Until about 20 holds per repo and job accumulate in the 30-day window, most status ETAs read `low-data`.
- v1.2.46 has still not been proven by a real deploy (see the hub memory), and v1.2.47 stacks on it.

## Operator Confirmation

Confirmed 2026-11-24: the external actions this story owed were carried out.

- After the orchestrator merges stories 4.1, 4.2 and 4.3 to main, cut the hub release from a fresh clean clone of main with `mise run release -- 1.2.47` (if more stories land first, extend the `## v1.2.47` section in docs/hub-releases.md before tagging).
- Once the release runner reports every app dry run finished, run `mise run hosts:install` from a clean checkout at tag v1.2.47 on big-chungus and on the Mac, then confirm both hosts report `current` at v1.2.47 and no catch-up timer or launchd interval came back.
- On big-chungus, run `hub-device status` and `hub-device status --json` from the installed release while a deploy waits on `adb`, and confirm the JOB row with repo, run, job and `eta=` and the RESERVATIONS section appear.

_Appended by the bmad-loop orchestrator (`bmad-loop confirm`, #335): a human confirmed these external actions out of band, and the story was advanced from `awaiting-operator` to `done`._
