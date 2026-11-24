---
title: 'Story 2.1: Ticket format v1 and machine identity'
type: 'feature'
created: '2026-11-23'
status: 'done'
route: 'dispatch'
review_loop_iteration: 0
baseline_commit: 'f2bb6fc9012f5ee56cd53f61b172f66530eb2004'
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-2-context.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Queue tickets carry no format, kind or machine id, and `staleWaiter` prunes any ticket without a pid or from another hostname. Once deploy jobs and Reservations queue, a pinned version would strand the Queue behind, or delete, tickets it does not understand, and a Mac whose mDNS hostname drifts would look foreign to itself. MOBI-30, epic MOBI-29, NFR-2, AD-2/3/8.

**Approach:** Freeze ticket v1 in `lock.mjs`: one `buildTicket` constructor with the AD-3 body (Leases use it now, job and hub-job tickets get `job:<repo>#<run>.<attempt>/<job>` ids for Story 2.3), one `ticketStaleness` liveness function in the AD-3 order, and `sameHost` (AD-8) used by tickets and owner liveness. `hostId()` stays the single one in `events.mjs`.

**Decisions (autonomous, pre-approved):** v1 writes no `remote` tickets, so `buildTicket` refuses `remote` and unknown kinds on write while the reader never prunes for kind. A ticket with a pid from another host is stale at once only when it is pre-v1a (no `format`); a v1 one falls to the no-pid rules. A pid-alive ticket without a recorded `process_start` is live (no positive evidence of death).

## Boundaries & Constraints

**Always:** Node 24 ESM, `node:` builtins. The ticket file name stays `<ms15>-<counter6>-<pid8>.json`; every key a v1.2.43 reader uses (`lease_id, holder, why, pid, host, process_start, enqueued_at`) stays with its meaning; new keys are additive. New code takes `{now, host, hostId, processStart, isAlive}` seams, never calls `hostname()` or `Date.now()` on its own beyond a default parameter. `release`/`reclaim` events, owner keys, error codes and `hub-device` output are unchanged.

**Never:** `queueView`, tries, FIFO for `withLock`, coded `withLock` timeouts, Reservations, policy keys (Stories 2.2-2.7). A second `hostId`. Writing `remote` tickets. Pruning a ticket for its `kind` alone. A release, `hosts:install` or tag (Story 2.8).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Lease ticket | `acquireLease` | all 21 AD-3 keys, `format: 1`, `kind: lease`, `host_id`, name unchanged | N/A |
| Job ticket | `buildTicket('job')` | `lease_id = job:<repo>#<run>.<attempt>/<job>`, `holder` and `why` set | `remote`/unknown kind throws |
| No `kind` | v1.2.43 ticket, pid alive | read as `lease`, judged by pid rule | N/A |
| Pid dead / reused start | same host | stale (`gone` / `pid-reused`) | N/A |
| Pid alive, start unreadable or unrecorded | same host | live | N/A |
| No pid, `expires_at` future / past | any kind | live / stale | N/A |
| No pid, no `expires_at` | `enqueued_at` 59.9 s / 60 s ago | live / stale | N/A |
| Unknown `kind` | pid alive | live; pid-less and fresh: live | never pruned for kind |
| Same host | equal `host_id`, different hostnames | same | N/A |
| Same host | one side lacks `host_id` | hostname equality decides | N/A |
| Pre-v1a foreign ticket | pid, other host, no `format` | stale (AD-8) | N/A |

</frozen-after-approval>

## Code Map

- `tools/ci/lib/lock.mjs` -- `staleWaiter` `:273` and `listWaiters` `:283` (replace with `ticketStaleness`); `staleness` `:56` (owner host checks `:63`, `:67`: use `sameHost`); ticket write in `acquireLease` `:343-348`; `processStart` `:262`, `alive` `:31`. Keep `listLocks`, `retire`, events as they are.
- `tools/ci/lib/events.mjs` -- `hostId()` `:30`, already cached per process and injectable; import it, never add another.
- `tools/device/lease.test.mjs` -- `fixture()`, `lease()`, `deadPid()`; the legacy-ticket test `:188` flips (intended change: a live pid with no recorded start is live under AD-3).
- `tools/device/hub-device.mjs:134,393,515` -- callers of `listWaiters({env})`; their output must not change. `hub-device.test.mjs:587` pins read-only stale reporting.

## Tasks & Acceptance

**Execution:**
- [x] `tools/ci/lib/lock.mjs` -- `sameHost`, `ticketKind`, `jobLeaseId`, `buildTicket`, `ticketStaleness`; `listWaiters` uses it with injectable seams; `acquireLease` writes `buildTicket('lease')` and takes `host`/`processStart` seams; owner staleness uses `sameHost` -- AD-2/3/8
- [x] `tools/device/lease.test.mjs` -- table tests for each liveness rule and the matrix, ticket body and file name, job ticket ids, `sameHost`, v1.2.43 ticket read as a lease with `release <id>` matching, pid-less ticket not starving a free lock, owner liveness across hostname drift; update the legacy-ticket test as an intended change -- story ACs
- [x] `_bmad-output/implementation-artifacts/deferred-work.md` -- note emulator.mjs host checks stay on hostname until Story 2.2 -- continuity

**Acceptance Criteria:**
- Given a Lease taken now, when its ticket is read mid-wait, then it has exactly the AD-3 keys and the unchanged file name.
- Given the liveness rule, when applied in each matrix row, then the verdict is as listed.
- Given a v1.2.43 ticket (no `kind`, no `host_id`), when read, then it is a live lease by pid and `releaseLease(name, id)` still cancels it.
- Given `mise run check`, then it is green and no real `~/.local/state` or lock dir is touched.

## Implementation Notes

- Built directly in the build session: no implementation or reviewer subagent was available, so the three review layers ran as one in-session pass (as in Stories 1.2-1.4); the log is below.
- `lock.mjs`: new exports `sameHost`, `ticketKind`, `jobLeaseId`, `buildTicket`, `ticketStaleness`, `TICKET_FORMAT`, `TICKET_KINDS`, `TICKET_ABSENT_MS`. `staleWaiter` is gone; `listWaiters` calls `ticketStaleness` and takes `{now, host, hostId, processStart, isAlive}` seams (observing still never prunes). `acquireLease` writes `buildTicket('lease')` (21 AD-3 keys in order, name unchanged) and takes `host`/`processStart` seams; `withLock`, `acquireLease` and `listLocks` pass `host`/`hostId` to the owner `staleness`, which now uses `sameHost`. `hostId` is still the one in `events.mjs` (cached per process, injectable); nothing was added there.
- Decisions: a ticket whose pid is alive and whose `process_start` was never recorded or is unreadable is live (AD-3 rule 2). That flips Story 1.x's legacy-ticket test, an INTENDED CHANGE named in that test. A pre-v1a ticket from another host is pruned (`foreign-host`); a v1 one falls to rules 3 and 4. A job ticket with no GITHUB_* identity gets `job:local#local-<pid>.1/job` so two local catch-ups never share an id. `sameHost` follows AD-8 literally: two different ids with equal hostnames fall to the hostname.
- Tests: `lease.test.mjs` +8 tests (ticket body and name, job ids, 32-row liveness table, `sameHost`, `hostId` cache, v1.2.43 ticket read as a lease and cancelled by id, pid-less tickets, owner liveness over hostname drift); mutation-checked on the 60 s boundary, the pre-v1a prune, the machine-id match and the start-unreadable rule.

## Spec Change Log

## Review Triage Log

| Finding | Verdict | Evidence |
|---|---|---|
| A v1.2.43 pin misreads a v1 ticket and prunes or blocks on it | false | Old `staleWaiter` reads only `host`, `pid`, `process_start`; all three keep their meaning, and new keys are ignored by it |
| `listWaiters` read-only status could now write | false | `prune` stays opt-in and the only new stat is a read; the hub-device read-only test passes |
| Owner `staleness` change alters existing job/Lease verdicts | false | With no `host_id` on a side `sameHost` reduces to the old hostname equality; the 1.4 v1.2.43-owner test passes unchanged |
| `emulator.mjs` `doomed()` still compares hostnames | low, deferred | Emulator records carry no `host_id` and the pool is Linux-only in v1a; recorded in deferred-work.md |
| `buildTicket` job kinds have no production caller yet | low, deferred | Story 2.3 wires `withLock`; recorded in deferred-work.md |
| A pid-alive ticket with no recorded start is now live (was stale) | medium, intended | AD-3 rule 2 (positive evidence of death only); the replaced test names the change |

## Design Notes

A v1 ticket from another host with a pid cannot be pid-checked here, so it falls to rules 3 and 4 (`expires_at`, else 60 s). A pre-v1a one is pruned, as AD-8 states and as `staleWaiter` did.

## Verification

**Commands:**
- `node --test tools/device/lease.test.mjs tools/device/hub-device.test.mjs tools/device/emulator.test.mjs tools/catchup/catchup.test.mjs` -- expected: all pass
- `heavy mise run check` -- expected: green

## Review (independent)

Reviewed `3ce85f4` against Story 2.1's ACs (epics-v1a.md) and AD-2, AD-3, AD-8, with the lock.mjs diff, the 8 new tests and the callers in `hub-device.mjs` and `emulator.mjs`.

**Checked, no defect:** ticket body (21 AD-3 keys in order, file name unchanged, `deadline_at` and `expires_at` null-safe); job id `job:<repo>#<run>.<attempt>/<job>` can never be a valid Lease id; `remote` and unknown kinds refused on write, never pruned on read; liveness order and the 59.999 s / 60 s boundary; same-host by `host_id` then hostname for tickets and owners; the old `staleness` verdicts are unchanged when a side lacks `host_id`; a v1.2.43 pin reading a v1 ticket (reads only `host`, `pid`, `process_start`, which keep their meaning; `process_start` is still recorded); tmp-rename ticket writes (`.json.tmp` is not listed); `listWaiters` observing never prunes; `releaseLease` by id on a no-kind ticket; no event, exit-code or `hub-device` output change beyond the named legacy-ticket flip; no policy values, timers or real host state in the tests (they read `/etc/machine-id` through the cached `hostId()` only); no race added (no new mkdir, rename or tombstone path; pruning is the same unlink-by-name).

**Confirmed and fixed:** a ticket whose `pid` is 0 or negative was judged live for ever on its own host. `kill(0, 0)` and `kill(-1, 0)` succeed, so `alive()` is true, and AD-3 rule 2 (unreadable or unrecorded start keeps it live) then leaves nothing to prune it. v1.2.43 pruned such a ticket because its `process_start` was missing or unreadable, so the story introduced a way for one malformed ticket to strand the Queue (the exact thing AD-3 "Prevents"). `ticketStaleness` now treats a pid that is not a positive integer as no pid, so rules 3 and 4 apply. Regression test: "a ticket whose pid is 0 or negative is no pid" (fails without the fix).

**Dismissed:** foreign-host v1 ticket with a pid falls to the 60 s rule (AD-3 does not define it; recorded design, a v1 ticket is only foreign across machines). A Mac whose `ioreg` fails (null `host_id`) and whose hostname drifts reads its own v1 ticket as foreign: needs two faults, no spec fix without a second identity source. Owner pid 0: pre-existing, deferred.
