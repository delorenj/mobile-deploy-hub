---
title: 'Story 2.8: Ship the freeze set (pre-release half)'
type: 'chore'
created: '2026-11-24'
status: 'done'
route: 'dispatch'
review_loop_iteration: 0
baseline_commit: '2be18cb'
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-2-context.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Stories 2.1-2.7 are on main but nothing proves the freeze set is ready to ship as one pin (AD-20): `check.yml` tests Node 24 only (Story 1.5's Node 26 leg was never added) and has not gone green since Story 2.4, the hermetic suite has no event-sequence test for a whole deploy run, and a hub release carries no notes, so nobody reading the `v1.2.46` tag learns that fairness holds only among runs on that pin and later. MOBI-37, epic MOBI-29, AD-3, AD-20, AD-21, NFR-2, FR-17.

**Approach:** One level up, for every future hub release: `check.yml` runs the same `mise run check` task as a Node 24 and Node 26 matrix (`mise run --tool node@<n> check`; `mise.toml` keeps its Node 24 pin), and the suite is made green on a GitHub-hosted runner. `release.mjs` puts the `## vX.Y.Z` section of a tracked `docs/hub-releases.md` into the tag annotation (no section: today's annotation). The v1.2.46 section is written. Two event-sequence tests: a full deploy run through the real gate reservation, plan and android lane code, and a deploy job's timed-out wait.

**Decisions (autonomous, pre-approved):** The release run itself (`mise run release`, `hosts:install`, `v1`, first real deploy) is the parent session's, not this story's half. The full-run sequence pins the true AD-7 order: the Reservation's `release` precedes the lane's own `release` (renamed away before the lock is freed). The run's claim is made by `reserveFor('adb')`, the function the gate calls (the gate's call itself is pinned by `v11.test.mjs`). Tag messages are written with `--cleanup=whitespace` so a `#` line in the notes survives. `AGENTS.md` (the `CLAUDE.md` target) is left unedited; its stale "withLock does not join the FIFO" pitfall is handed to the parent for after the release.

## Boundaries & Constraints

**Always:** Node 24 ESM `.mjs`, `node:` builtins only. Hermetic tests (`hermetic()`, temp `HUB_LOCK_DIR`/`HUB_EVENT_DIR`, fakes; no live bucket, real adb or host state). Existing `tools/device/*.test.mjs` assertions keep their meaning; any changed one is a named intended change or a de-flake that keeps what it asserts. `check.yml` stays on `ubuntu-latest` (public repo). Tuning values only in `policy.json`.

**Never:** run `mise run release`, `hosts:install`, move tags or deploy; weaken the Node 24 pin of the `check` task; add a timer; a GitHub Release object for the hub; edit `AGENTS.md`/`CLAUDE.md`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Notes present | `docs/hub-releases.md` has `## v1.2.46` | tag annotation = header, the section body, then the dry-run lines | N/A |
| Notes absent | no section (or no file) | annotation exactly as today | N/A |
| Section bounds | next `## ` heading or EOF | body stops there, trimmed; `###` lines kept | N/A |
| Full deploy run | gate claim, plan hold, android hold with `endsReservation`, announce | `claim, request, acquire, release` (plan), `request, acquire, release(reservation), release` (android), nothing from announce; every event `hub_version` = `HUB_REF` | N/A |
| Timed-out wait | Lease holds `adb`, one waiter ahead, android job with a deadline | `request, timeout(deadline)`; `HUB_LOCK_TIMEOUT`, message names holder and waiter with place; ticket gone | N/A |

</frozen-after-approval>

## Code Map

- `.github/workflows/check.yml` -- one `check` job; add `strategy.matrix.node: ['24','26']`, `fail-fast: false`, install `node@<n>`, run `mise run --tool node@<n> check`.
- `mise.toml` `[tasks.check]` -- keep `tools = { node = "24", ... }`; print `node --version` first so each leg's log names its Node. `mise run --tool node@26 check` is proven to override the task tool (probe in a temp dir: v26.13.0).
- CI history: last green `d504f2b`; since `e558bd8` (Story 2.4) every run hangs until the 20 min timeout after the `tools/ci/*` files (first unreported file `tools/device/emulator.test.mjs`); earlier red runs were `emulator.test.mjs` timing tests (`status is read-only ...` :650 with a 3 s lease, `an emulator that dies while booting` :465). Diagnose on a 4-CPU reproduction (`taskset -c 0-3`) before changing tests.
- `tools/release.mjs` -- four `git tag -a`/`-f -a` calls build `mobile-deploy-hub ${tag}\n\n...`; add exported `releaseNotes(text, tag)` and `tagMessage(tag, status, notes)`, read `docs/hub-releases.md` once before tagging, log `RELEASE_NOTES`.
- `tools/ci/v11.test.mjs` :629 -- the release tests live here (`flipInnerRefs`); add the notes tests beside it.
- `tools/ci/v3.test.mjs` :719 `laneHost`, :822 real run end to end -- reuse for the full-run sequence (plan, android, announce with fakes); `reserveFor` from `tools/ci/commands/common.mjs`.
- `tools/ci/deadline.test.mjs` :93 `fixture`, :100 `holder` -- reuse for the timed-out wait; existing partial sequences: `lease.test.mjs` :1107, `deadline.test.mjs` :103/:197, `reservation-release.test.mjs` :144.
- `docs/hub-releases.md` (new), `README.md` "Changing a rule" and "Hosts and checks" -- name the notes file and the Node 26 leg.

## Tasks & Acceptance

**Execution:**
- [x] `.github/workflows/check.yml`, `mise.toml` -- Node 24/26 matrix of the same task -- Story 1.5 AC folded into 2.8
- [x] tests that fail or hang on a 4-CPU host -- make them deterministic without changing what they assert -- AC 1 (green in check.yml)
- [x] `tools/release.mjs`, `tools/ci/v11.test.mjs` -- notes section into the annotation, pure helpers tested, `--cleanup=whitespace` round trip in a temp repo -- one mechanism for every hub release
- [x] `docs/hub-releases.md` -- intro and the v1.2.46 section -- AC 4
- [x] `tools/ci/v3.test.mjs`, `tools/ci/deadline.test.mjs` -- the two sequence tests -- AC 2
- [x] `README.md`, `deferred-work.md` -- docs

**Acceptance Criteria:**
- Given main, when `mise run check` and `mise run --tool node@26 check` run locally, then both are green.
- Given a push, when `check.yml` runs, then a Node 24 and a Node 26 job both run `mise run check` and both finish green.
- Given `docs/hub-releases.md` with a `## v1.2.46` section, when that release tags, then the annotation carries the section; the section states that fairness holds only among runs on this pin and later and that older pins age out within 30 days, and summarises the Event Log, Queue, Reservations, deadlines, the Lease cap, AD-21 and the queued-timeout wording change.

## Spec Change Log

None. No loopback.

## Design Notes

Section body for a tag: everything after the `## vX.Y.Z` line up to the next line starting `## `, trimmed. `tagMessage('v1.2.46', status, notes)` = `mobile-deploy-hub v1.2.46\n\n<notes>\n\n<status>`; with no notes it is today's `mobile-deploy-hub v1.2.46\n\n<status>`.

## Verification

**Commands:**
- `node --test tools/ci/v11.test.mjs tools/ci/v3.test.mjs tools/ci/deadline.test.mjs` -- expected: all pass
- `heavy mise run check` and `heavy mise run --tool node@26 check` -- expected: green
- `taskset -c 0-3 node --test 'tools/**/*.test.mjs'` -- expected: finishes, green (the CI shape)
- after push: `gh run list --workflow check.yml` -- expected: both legs green

## Implementation Notes

- `check.yml` is a matrix of `node: ['24','26']` (`fail-fast: false`) running `mise run --tool node@<n> check`; `mise.toml` keeps `node = "24"` and the task prints `node --version` first. Locally both pass: 623 tests on Node 24 (v24.x) and 623 on Node 26.13.0; no test needed a Node-26-only fix.
- Why `check.yml` had not gone green since Story 2.4 (found with a throwaway `ci-diag` branch that ran the device test files on a hosted runner with a test timeout, deleted afterwards): on a GitHub runner each fake emulator lease takes ~5 s (probably the boot loop's 5 s adb re-registration, after a first one that lands before the fake emulator listens; not proven) where it takes under 1 s on big-chungus. `status is read-only` took its first lease for 3 s, so the next take reaped it, the test's premise broke, and its `settle(expires_at - now)` then waited for emulator-1's new 30-minute lease: a pending timer held the node process until the job's 20-minute timeout. The suite's other 616 tests all passed. Fix: the lease is taken for 30m and expired with `updateLease` (an earlier expiry is allowed), so no wall clock decides it. `an emulator that dies while booting` failed on one run in three: the boot loop sees the log's FATAL line and the process exit in one poll and reports whichever it checks first (`failed` or `exited` while booting); the test accepts both wordings of the same report.
- Rejected: `--test-force-exit` and `--test-timeout` in the check task. `--test-force-exit` dropped three listing tests from the count (620 instead of 623), so it hides tests; a per-test timeout cannot print its report while the process stays alive.
- `release.mjs`: `releaseNotes(text, tag)` (the lines after `## vX.Y.Z`, or `## vX.Y.Z <more>`, up to the next `## `, trimmed; null when absent or empty), `tagMessage(tag, status, notes)` and `tagArgs` (every tag call uses `--cleanup=whitespace`, which keeps `#` lines). The notes are read from the commit being tagged (the tree is clean), logged as `RELEASE_NOTES`, and carried into the pending, green, red and unknown annotations. Tests: pure helpers, a temp-repo round trip through real `git tag`, and a check that the v1.2.46 section states what the story requires.
- Event sequences: `v3.test.mjs` runs `reserveFor('adb')` (the gate's call), `plan`, `android` and `announce` with the lane fakes and `HUB_REF=v1.2.46`, and pins `claim | request, acquire, release (plan) | request, acquire, release (reservation), release (job) (android)` with nothing from announce; `deadline.test.mjs` pins one job's timed-out wait whole (request, timeout `deadline`, `HUB_LOCK_TIMEOUT`, holder and waiters with places, `hub_version`, ticket gone, others kept).
- Not done here (the parent's half of the story): `mise run release -- 1.2.46`, `hosts:install` at the tag on both hosts, `v1`, the first real deploy's check of `hub_version`.

## Review Triage Log

In-session review of the diff against Story 2.8's ACs, AD-3, AD-7, AD-20 and AD-21.

| Finding | Verdict | Evidence |
|---|---|---|
| `git tag -a -m` strips `#` lines, so a notes heading (`### Read this first`) would vanish from the annotation | high, fixed | `--cleanup=whitespace` on every tag call; the temp-repo test reads `%(contents)` back |
| `--test-force-exit` in the check task silently drops tests | high, not shipped | 620 of 623 tests counted; three listing tests missing |
| the v1.2.46 notes claim an exact queued-timeout wording | checked | the sentence is the one `lease.test.mjs` and the new deadline test pin |
| `AGENTS.md` still says deploy jobs' `withLock` does not join the FIFO | left | an instruction file; handed to the parent for after the release (deferred-work.md) |

## Review

`heavy mise run check` green on Node 24 (623 tests) and `heavy mise run --tool node@26 check` green on Node 26.13.0 (623 tests). `check.yml` run 45341918045 at 68d98e4: `check (node 24)` and `check (node 26)` both green in 3 minutes (the first green since d504f2b).

## Review (independent)

2026-11-24, adversarial pass over 6a0c0ae, 68d98e4, d3c0499 and the whole freeze set (3ce85f4^..HEAD). Verdict: FIXED (three small defects, no Epic 2 defect).

**Verified as claimed**
- `check.yml`: actionlint clean; CI run 45341918045 shows `check (node 24)` on v24.22.3 and `check (node 26)` on v26.13.1 (the `--tool` override took; mise also installs the task's Node 24 on the 26 leg, which is harmless), 623 tests, 621 pass, 2 skipped (no `bb-emit` on a hosted runner), 0 fail on both. Local `heavy mise run check` on Node 24: 623 of 623, 0 skipped.
- Event-sequence tests run the real `reserveFor`, `plan`, `android`, `announce` and `withLock` code (no hand-written event lists). Mutation proof, each killing the named test: dropping the job `request`, dropping the job `acquire`, turning the `timeout` into a `cancel`, skipping the Reservation release in `runHeld`, and moving it after the lane's own `release`. Both tests also pass 5 of 5 repeats and pinned to one CPU (`taskset -c 0`).
- Old-pin coexistence (v1.2.43 and v1.2.44 share `lock.mjs`): a throwaway harness (outside the repo) ran the tagged `lock.mjs` against state written by the current code, in real processes. All 21 checks passed: an old job waits behind a live new holder and never reclaims it, reclaims a SIGKILLed new holder, lists and releases a new Lease; new waiting tickets survive old pruning and an old Lease queues behind them; an old Lease waiter is served before a later new job; the new code reclaims a dead old job and an old Lease whose `holder_pid` died; a Reservation (advisory to old pins) and a leftover tomb never block an old `mkdir`, and `listLocks` ignores both. Nothing strands the Queue for an older pin.
- The v1.2.46 notes state the pin-fairness and 30-day sentences, and the policy numbers (grace 10, ceiling 180, Lease cap 60, margin 2, allowances) match `policy.json`.

**Defects fixed**
1. `releaseNotes` read a CRLF `docs/hub-releases.md` as having no section (the heading line ends in `\r`), so a release would have tagged silently without notes. Lines now split on CRLF.
2. Notes could still break the tag call: a NUL cannot be a process argument, and a section over ~128 KiB hits the one-argument limit (E2BIG) after the release has made its local commit and run `check`. NULs are dropped, a section is cut at `notesMaxBytes` (60,000) with a line pointing at the file, and an unreadable notes file is logged and the release goes on without notes. Regression test: CRLF, NUL, odd characters (backticks, quotes, `-m`, non-BMP), a huge section through real `git tag`.
3. The Node 26 leg could pass on Node 24 if the override ever stopped taking (the task pins 24). `check.yml` now passes `NODE_MATRIX_MAJOR` per leg and a test fails a leg whose Node major differs (not a `HUB_` name: `hermetic()` clears those).

**Notes corrected** (`docs/hub-releases.md`): the event list lacked `reclaim`; the "Before" wording was a Lease's (`2 waiters`, not `waiter(s)`) and a deploy job's old timeout had no waiter list, so both are now quoted as they were.
