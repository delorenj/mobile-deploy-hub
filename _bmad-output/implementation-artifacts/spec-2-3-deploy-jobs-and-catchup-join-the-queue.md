---
title: 'Story 2.3: Deploy jobs and the catch-up join the Queue'
type: 'feature'
created: '2026-11-23'
status: 'done'
route: 'dispatch'
review_loop_iteration: 0
baseline_commit: '328a1b2bb88f814b9b04c693b1a68e9337beefe0'
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-2-context.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** A deploy job's `withLock` still retries `mkdir` every 2 s with no place in line, so a Lease or a later job can take the S26, the iPad or the Mac ahead of a run that is already waiting. The catch-up shares that path. Its timeouts are uncoded (Story 1.4 left them so on purpose), and a queued Lease's timeout says `host lock X has N waiter(s) ahead` where every other wait says `host lock X is held`. MOBI-32, epic MOBI-29, FR-7, FR-8, FR-12, AD-3/4/5/6/15.

**Approach:** `withLock` on a Queued name writes a `job` (or, for the catch-up's `ctx.lock`, `hub-job`) ticket carrying the run identity, then waits through `queueView` exactly as `acquireLease` does (take only when nothing that blocks is ahead; re-read after `mkdir` and give the lock back by tombstone if something now is). Every other name keeps today's bare `mkdir` path. Every wait that runs out throws `HUB_LOCK_TIMEOUT`, wording `host lock <name> is held by <holder>`, naming the waiters ahead with their places.

**Decisions (autonomous, pre-approved):** `timeoutMs` of 0 or less on a Queued name is a try (no ticket, no event unless it acquires, refused while anyone waits). `acquireLease`'s queued timeout becomes `host lock <name> is held by <holder>; N waiter(s) ahead of lease <id> (1. <who> (<why>), ...); gave up after Ns`. A job's timeout keeps its tail (`gave up after N min. Another deploy is using the device; run again when it finishes.`) with the waiters inserted before it, so with nobody ahead it is byte for byte today's message. The bare path's timeout is coded too. Job events keep `lease_id: null` as pinned in 1.4. Process-start reads are cached per pid for `JOB_POLL_MS` (2 s) inside a job wait so a Mac pass does not spawn `ps` per ticket per poll. The catch-up code is untouched: it already passes `kind: 'hub-job'`.

## Boundaries & Constraints

**Always:** Node 24 ESM, `node:` builtins. Only `lock.mjs` writes protocol paths and appends events. Ticket file name and body (AD-3) unchanged. Internal locks (`s3-*`, `s3-index`, `emulator-reaper`) write no ticket, no queue directory and no event. `hub-device` commands, exit codes, `HUB_DEVICE_*` lines and `--json` shapes unchanged. Hermetic tests with injected clock and temp `HUB_LOCK_DIR`/`HUB_EVENT_DIR`.

**Never:** Wait deadlines or margins (2.4), Reservations (2.5, 2.6), `extendLease` or the Lease cap (2.7), a policy key, a timer, a release or `hosts:install` (2.8), the catch-up's `delivery` block or pending-wait policy (Epic 3).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Job behind a Lease | `withLock('adb')`, a Lease holds | `kind: job` ticket `job:<repo>#<run>.<attempt>/<job>`, one `request`; served in file-name order | N/A |
| Lease behind a job, or the reverse | two waiters | arrival order decides, whichever kind | N/A |
| Free, empty Queue | nothing held, no tickets | taken at once, no sleep, `request`, `acquire` (`waited_ms` 0), `release` | N/A |
| Catch-up | `ctx.lock` (`kind: hub-job`) | ticket and events say `hub-job` | timeout: one `timeout` event, claimant `hub-job` |
| Wait runs out | Queued name | ticket removed, one `timeout`, `HUB_LOCK_TIMEOUT`, message starts `host lock <name> is held` | catch-up regexes still match |
| Late blocker | `mkdir` won, ticket now ahead | lock given back by tombstone, no event, keeps waiting | N/A |
| Try | `timeoutMs: 0` | no ticket; takes a free lock only if nobody waits | `HUB_LOCK_TIMEOUT`, no event |
| Internal name | `s3-*`, `emulator-reaper` | bare `mkdir`, no queue, no event | coded timeout, today's wording |
| Released while waiting | `releaseLease` on the job id | `HUB_LEASE_CANCELLED`, the release wrote the one `cancel` | N/A |

</frozen-after-approval>

## Code Map

- `tools/ci/lib/lock.mjs` -- `withLock` now dispatches: Queued names to `queuedLock` (ticket, FIFO through `queueView`, re-check, give-back, `timeout`/`cancel` by unlink), others to the bare loop. New shared helpers: `writeTicket` (also used by `acquireLease`), `heldText` and `waiterText` (the AD-5 wording), `cachedStart`, `jobIdentity`, `runHeld` (the hold, the AD-19 touch and the release). New exports: `JOB_POLL_MS`. `withLock` gains test seams `afterTake` and `processStart`.
- `tools/catchup/catchup.mjs` -- unchanged: `ctx.lock` already passes `kind: 'hub-job'`; `:469` and `:591` regexes match the unchanged prefix.
- `tools/device/lease.test.mjs` -- three intended message and code changes (named in their tests); the four tests that spawn a child taker give the parent a clock two seconds late so the child stands ahead in the Queue; 8 new tests.
- `tools/catchup/catchup.test.mjs` -- one new test: the catch-up as a `hub-job`.
- `_bmad-output/implementation-artifacts/deferred-work.md` -- closes the 2.1 "no production caller of `buildTicket`" entry; three new entries.

## Tasks & Acceptance

**Execution:**
- [x] `tools/ci/lib/lock.mjs` -- Queued `withLock` joins the FIFO as `job`/`hub-job`; coded timeouts with the AD-5 wording; `acquireLease` timeout wording through the same builder -- AD-3/4/5/6
- [x] `tools/device/lease.test.mjs` -- job ticket identity, FIFO both ways, free-and-empty, `mac-ios` job/catch-up/job order, coded timeout with places and a `hub-job` `timeout`, internal names, try, late-blocker give-back (mutation-checked), cancel -- story ACs
- [x] `tools/catchup/catchup.test.mjs` -- catch-up queues as `hub-job`, idle pass is a `hub-job` `timeout` -- AD-15
- [x] `_bmad-output/implementation-artifacts/deferred-work.md` -- AD-20 note for the stale pitfall in CLAUDE.md/AGENTS.md; `.code` migration and `delivery` for Epic 3; job event `lease_id`

**Acceptance Criteria:**
- Given `withLock` on a Queued name from a deploy job, when it waits, then a `kind: job` ticket with the run identity stands in the Queue and is served in FIFO order with Leases.
- Given the catch-up's `ctx.lock`, when it waits, then it queues as `hub-job`, and its timeout is one `hub-job` `timeout` event.
- Given a Queued wait that runs out, then the error has `code: 'HUB_LOCK_TIMEOUT'` and a message starting `host lock <name> is held`, naming the holder and the waiters ahead with their places; the `catchup.mjs` regexes still match.
- Given an internal name, then no ticket, queue or event is written.
- Given `heavy mise run check`, then it is green and no real state dir is touched.

## Implementation Notes

- Built directly in the build session (no subagent tool was available to this run); the review layers ran as one in-session pass, as in Stories 1.2 to 2.2.
- `queuedLock` mirrors `acquireLease`'s loop on purpose and does not share it: the lease loop's record, claim and messages differ, and the shared parts (ticket write, wording, hold) are extracted instead. Both loops go through `queueView` and `blockersAhead`, so the order has one source.
- Intended test changes, each named in its test: a queued Lease's timeout wording (`has 1 waiter ahead of lease two` becomes `is held by <holder>; 1 waiter ahead of lease two (1. ...)`, two tests); a `withLock` timeout now has `code: 'HUB_LOCK_TIMEOUT'` where 1.4 pinned `undefined`. The four child-process race tests (`two reclaimers`, `the same race through acquireLease`, `a rename that finds the lock gone`, `a lock retaken between the rename and the put-back`) spawn a taker from inside a parent `withLock`; the parent now holds a ticket, so the child would queue behind a blocked parent forever. The parent asks the time two seconds late, so its ticket sorts after the child's (the interleaving the tests mean: the child reached the lock first).
- Mutation check: dropping the post-`mkdir` re-check in `queuedLock` fails the give-back test.

## Spec Change Log

## Review Triage Log

| Finding | Verdict | Evidence |
|---|---|---|
| A job killed while waiting leaves a ticket that blocks the Queue | false | The ticket has a pid: dead on the same host is positive evidence, and every acquirer's `queueView(prune)` removes it; unchanged AD-3 rule |
| The 2 s process-start cache could keep a reused pid live | low, accepted | It is bounded by one poll pass (`JOB_POLL_MS`), as the spine's liveness-cost row asks |
| Catch-up polling at 100 ms hammers `queueView` | low, accepted | Reads a directory and a few small files; `ps` is the cost and it is cached |
| Job events carry `lease_id: null` while the ticket has the job id | low, deferred | Pinned by Story 1.4's sequence tests; recorded in deferred-work.md |
| `withLock` bare path lost its `note` calls | false | They were no-ops for every non-Queued name (`note` checks `isQueued`) |

## Verification

**Commands:**
- `node --test tools/device/lease.test.mjs tools/catchup/catchup.test.mjs tools/device/hub-device.test.mjs tools/device/emulator.test.mjs` -- expected: all pass
- `heavy mise run check` -- expected: green
