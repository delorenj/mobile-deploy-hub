---
title: 'Story 2.4: Wait deadlines that beat GitHub''s timeout'
type: 'feature'
created: '2026-11-23'
status: 'done'
route: 'dispatch'
review_loop_iteration: 0
baseline_commit: 'd504f2b1a89381c9b4a78cc84f6a9b99aae311d3'
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-2-context.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** A deploy job's Queue wait runs to the caller's own timeout (plan and android 20 min, ios 40 min per take), which can pass the job's `timeout-minutes` (plan 20, android 45, ios 120). GitHub then kills the job `cancelled`: its `finally` never runs, `deliver-*` is skipped and nobody learns why or who held the device. The `android` and `ios` jobs also keep per-repo `concurrency` groups, which drop all but one pending run of a repo before the Queue could serve it. MOBI-33, epic MOBI-29, FR-8, AD-11, AD-12, AD-21.

**Approach:** The Queue's tuning gets its first strict policy block, `queue: { wait_margin_min, hold_allowance_min: {plan, android, ios} }`. A deadline helper returns `job_start + timeout - margin - hold_allowance[job]`, reading `HUB_JOB_TIMEOUT_MINUTES` (set beside each waiting job's `timeout-minutes` in `mobile-deploy.yml`, equality tested) and `job_start` from the nearest `Runner.Worker` ancestor. A Queued `withLock` for a `job` ends its wait at the earlier of that deadline and its caller's timeout, and the ticket and events carry it as `deadline_at`. The `android` and `ios` concurrency groups go.

**Decisions (autonomous, pre-approved):** Starting values: margin 2, allowances plan 5, android 15, ios 60 (ios holds `mac-ios` up to twice). The deadline caps only `kind: job` waits (the catch-up and Leases keep their own timeouts), only on a Queued name, never a try, and only for a job the policy gives an allowance. A malformed or absent `HUB_JOB_TIMEOUT_MINUTES` caps nothing. A free lock with an empty Queue is taken at once even after the deadline. The capped timeout reads `host lock <name> is held by ...; gave up after N min, ahead of this job's M-minute timeout. Another deploy is using the device; run again when it finishes.` (uncapped waits keep today's text byte for byte). `templates/deploy.yml` is untouched.

## Boundaries & Constraints

**Always:** Node 24 ESM, `node:` builtins. `lock.mjs` reads the policy through `loadPolicy` itself and tests inject a `policy`; no caller passes a value, no env or input overrides one. The helper is pure with every input injectable (`policy`, `env`, `startedMs`, `lookup`, `now`, `uptime`). Tests are hermetic (temp `HUB_LOCK_DIR`/`HUB_EVENT_DIR`, injected clock). No new timer.

**Never:** Reservations (2.5, 2.6), `extendLease` or the Lease cap (2.7), a release or `hosts:install` (2.8), a change to `templates/deploy.yml` (its hash is in `callers.accept`), removing the `plan`, `ios-export` or `deliver-*` groups, a policy key beyond this story's own.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| plan behind a Lease | `GITHUB_JOB=plan`, timeout 20, start T0, wait timeout 20 min | gives up at T0+13 min (20 - 2 - 5); ticket and `request`/`timeout` events carry that `deadline_at` | `HUB_LOCK_TIMEOUT`, message names the 20-minute timeout |
| Late arrival | job already ran 10 min before it asked | deadline still counts from `job_start`: 3 min left | same |
| Caller timeout sooner | `timeoutMs` 5 min, deadline 58 min | the caller's 5 min wins, today's wording | N/A |
| Free lock after the deadline | nobody ahead, clock past the deadline | taken at once, `waited_ms` 0 | N/A |
| No cap | no `HUB_JOB_TIMEOUT_MINUTES`, `deliver-*`, a `hub-job`, a try, a malformed value | caller's timeout, today's text | N/A |
| `job_start` unknown | no `Runner.Worker` above | own process start, else now minus uptime | N/A |

</frozen-after-approval>

## Code Map

- `tools/ci/lib/deadline.mjs` -- new, pure: `systemProcess` (/proc on Linux, `ps` on the Mac, both injectable), `jobStart` (nearest `Runner.Worker` ancestor, bounded walk), `jobTimeoutMs`, `jobDeadline`.
- `tools/ci/lib/policy.mjs`, `tools/ci/policy.json` -- the strict `queue` block (`queueJobs`); required, no unknown keys.
- `tools/ci/lib/lock.mjs` -- `queuedLock` caps a `job` wait at the deadline, stamps it on the ticket and events, logs `HUB_LOCK_DEADLINE`, words the timeout; `withLock` gains `policy` and `deadlineSeams` options.
- `.github/workflows/mobile-deploy.yml` -- `HUB_JOB_TIMEOUT_MINUTES` on plan (20), android (45), ios (120); the `android` and `ios` concurrency groups removed.
- `tools/ci/deadline.test.mjs` (new), `tools/ci/policy.test.mjs`, `tools/ci/hub.test.mjs` -- helper, Queue, workflow and policy tests; the hardened-workflow test's group list is the intended change.
- `README.md` -- "Queue tuning" under Deploy policy. `deferred-work.md` -- two entries.

## Tasks & Acceptance

**Execution:**
- [x] `tools/ci/policy.json`, `tools/ci/lib/policy.mjs`, `tools/ci/policy.test.mjs` -- strict `queue` block and its rejection cases -- AD-11
- [x] `tools/ci/lib/deadline.mjs` -- the deadline helper -- AD-12
- [x] `tools/ci/lib/lock.mjs` -- queued job waits end at the deadline; ticket and events carry `deadline_at` -- AD-12
- [x] `.github/workflows/mobile-deploy.yml`, `tools/ci/hub.test.mjs`, `tools/ci/deadline.test.mjs` -- job timeout env, equality test, concurrency removal -- AD-12, AD-21

**Acceptance Criteria:**
- Given `mobile-deploy.yml`, when plan, android and ios run, then each sets `HUB_JOB_TIMEOUT_MINUTES` equal to its `timeout-minutes`, and a test in `mise run check` fails if they differ.
- Given `policy.json`, then it has a strict `queue` block with `wait_margin_min` (2) and `hold_allowance_min` per job, and `policy.mjs` and its test reject unknown or missing keys.
- Given the deadline helper, then it returns `job_start + timeout - margin - hold_allowance[job]`, `job_start` is the nearest `Runner.Worker` ancestor's start else the process start, and every input is injectable.
- Given a job's ticket, then it carries `deadline_at`.
- Given `mobile-deploy.yml`, then `android` and `ios` have no `concurrency` group, and `plan`, `ios-export` and `deliver-*` keep theirs. Actionlint passes.

## Implementation Notes

- Built directly in the build session (no subagent tool was available); the review layers ran as one in-session pass, as in Stories 1.2 to 2.3.
- Mutation check: disabling the cap in `queuedLock` fails three deadline tests. `heavy mise run check`: 553 tests, green, actionlint clean.
- The ticket already carried `deadline_at` (the wait's own end, since Story 2.1); this story makes it the job's deadline for a capped wait.
- Intended test change, named in its test: the hardened-workflow test in `hub.test.mjs` now expects four concurrency groups, not six.
- `HUB_JOB_TIMEOUT_MINUTES` is a job-level `env` in the reusable workflow; composite-action steps inherit it, and `hermetic()` strips `HUB_*` so no test sees a runner's value.

## Spec Change Log

## Review Triage Log

| Finding | Verdict | Evidence |
|---|---|---|
| ios's second `mac-ios` take can start after the one absolute deadline and then cannot wait | real, deferred | AD-12 gives one allowance for both takes; per-take deadlines belong with Epic 3's second-take contention work (deferred-work.md) |
| `deliver-*` waits are not capped | false | they wait on the internal `s3-<slug>` lock (no Queue, AD-4) for 30 min inside a 45 min job; noted in deferred-work.md |
| A pinned older hub reading the new policy.json | false | each hub version parses the policy file at its own tag; the `queue` block exists only in the tag that ships it |
| A malformed `HUB_JOB_TIMEOUT_MINUTES` silently disables the cap | accepted | a bad value must never shorten or break a wait; the workflow test pins the real values equal |

## Verification

**Commands:**
- `node --test tools/ci/deadline.test.mjs tools/ci/policy.test.mjs tools/ci/hub.test.mjs tools/device/lease.test.mjs` -- expected: all pass
- `heavy mise run check` -- expected: green

## Review (independent)

Checked against Story 2.4's ACs in epics-v1a.md and AD-11, AD-12, AD-21, reading `e558bd8` rather than its summary.

- ACs: the workflow equality test (a mismatch fails it), the strict `queue` block (missing and unknown keys, non-integers and non-objects rejected; spot-checked arrays, null, 1e400), the helper formula and its injectable inputs, `deadline_at` on the ticket and on `request`/`acquire`/`timeout`, and the removal of exactly the `android` and `ios` groups all hold. Disabling the cap fails the new tests.
- Protocol and compatibility: the story writes no new on-disk state. `deadline_at` is an existing ticket key; ticket liveness (`ticketStaleness`) never reads it, so a capped waiter's ticket cannot be pruned early or stranded, and a v1.2.43 reader sees the same file shape. No new mkdir, rename or tombstone path was added; the capped wait reuses the existing loop, so event exactly-once (one `request`, one terminal event by the waiter's own unlink) is unchanged. A deadline already past still takes a free lock with an empty Queue (tested) and times out at once, ticket removed, behind a holder (new test).
- Pinned hubs: the reusable workflow's composite action is pinned at a tag, so the `HUB_JOB_TIMEOUT_MINUTES` env is inert until Story 2.8 re-pins; it cannot affect a pinned run.
- Policy: the margin and allowances are read only from `policy.json` (`queueJobs` names jobs, not tuning); no env or caller supplies them.
- Dismissed: the new `HUB_LOCK_DEADLINE` log line appears only on capped waits (a case that did not exist before), so no existing output changed; ios's second `mac-ios` take and `deliver-*` waits stay in deferred-work.md.

Confirmed and fixed (test-only):
1. The "no policy and no start injected" test read the real process tree and asserted a 25 to 29 minute window from the test's own start. Inside a CI job the nearest `Runner.Worker` is the job (check.yml runs the suite on a hosted runner), so a job already more than 3 minutes old would fail it. It now asks `jobStart()` for the expected deadline.
2. `deadline.test.mjs` did not call `hermetic()`; it does now.
3. No test covered a job arriving after its deadline behind a holder; added (immediate timeout, "0 min", no sleep, no ticket, one `request` and one `timeout`).
4. Nothing stopped a later tuning change (margin plus allowance at or over a job's `timeout-minutes`) from making every wait time out at once; a workflow test now requires a positive wait for each waiting job.
