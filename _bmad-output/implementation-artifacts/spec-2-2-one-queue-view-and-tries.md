---
title: 'Story 2.2: One queue view, and tries'
type: 'feature'
created: '2026-11-23'
status: 'done'
route: 'dispatch'
review_loop_iteration: 0
baseline_commit: '4cffecec14bc232213c664b17f7581224584d1dc'
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-2-context.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Every caller orders the Queue its own way: `acquireLease` takes "position 0 of `listWaiters`", `hub-device status` numbers tickets itself, `emulator.mjs` parses gate tickets by hand. A `waitMs: 0` call still writes a ticket, so a probe is a place in line, and Pool requests (`phone`, the emulator slots) leave only an `acquire` on success and nothing when a Pool times out. MOBI-31, epic MOBI-29, FR-7, FR-17, AD-1/4/6/9.

**Approach:** `lock.mjs` exports `queueView(name, {env, now, policy})`, the one reader of the Queue. `acquireLease` uses it to wait and to re-check after `mkdir` (giving the lock back by tombstone when something blocking is ahead). A `waitMs: 0` call becomes a ticketless try. A Pool request writes one Pool-level `request` event and one `acquire` or `timeout` event, `waited_ms` from the outer request.

**Decisions (autonomous, pre-approved):** `queueView` returns live tickets only unless `includeStale` is passed; `hub-device status` and the lease-id lookups pass it so stale tickets stay visible as today, with positions counted over every ticket shown. `queueView` accepts `policy` but reads none until Story 2.5. A try never writes a `request`, `timeout` or `cancel`. A Pool's events are `lock: null` for `request` and `timeout`/`cancel`; the `acquire` is the successful try's own event (lock `s24`, `emulator-1`) tagged with `pool` and `request`, so one hold is never counted twice. A phone that was taken and found away is an `acquire` then a `release` (true history), then the next probe. `HUB_PHONE_AWAY` ends the Pool request as a `timeout` with reason `away`. The deferred emulator `doomed()` host check moves onto `sameHost`.

## Boundaries & Constraints

**Always:** Node 24 ESM, `node:` builtins. Only `lock.mjs` writes protocol paths and appends events. Ticket file name and ticket body (AD-3) unchanged. Queued-timeout messages, `HUB_*` codes, exit codes, `HUB_DEVICE_*` lines and `hub-device` text unchanged; `--json` only grows. Hermetic tests with injected clock and temp `HUB_LOCK_DIR`/`HUB_EVENT_DIR`.

**Never:** FIFO or tickets for `withLock` (Story 2.3), coded `withLock` timeouts, Reservations or `kind: reservation` entries (2.5), policy keys, `extendLease` (2.7), a timer, a release or `hosts:install` (2.8).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| View | tickets, one stale | live ones sorted by file name, each with `place` (1-based), `blocking: true`, `kind`, identity fields | stale hidden (or `stale: true` with `includeStale`) |
| Try, free | `waitMs: 0`, nothing blocks | lock taken, no ticket, one `acquire` | N/A |
| Try, held or a blocker waits | `waitMs: 0` | no ticket, no event | `HUB_LOCK_TIMEOUT`, today's wording |
| Late blocker | `mkdir` won, then a ticket ahead appears | lock given back by tombstone, no event; a waiter keeps waiting, a try fails | N/A |
| Phone Pool | `lease phone` | `request` (pool `phone`), one `acquire` with `pool`, `request`, `waited_ms` from the request | busy or away: one `timeout`; abort or error: one `cancel` |
| Emulator Pool | `provision` | `request` (pool `emulator`), gate events, slot `acquire` tagged | gate or full-pool timeout: one Pool `timeout` |
| Status | stale and live waiters | same text and `--json`; positions from `queueView` | N/A |

</frozen-after-approval>

## Code Map

- `tools/ci/lib/lock.mjs` -- `listWaiters` (the ticket reader beneath the view); `acquireLease` (position logic, ticket write, `leave`, the claim); `eventOf`/`note`. Add `queueView`, `poolRequest`, `newLeaseId`; keep `listWaiters` exported for observers' tests.
- `tools/device/hub-device.mjs` -- `:134`, `:393`, `:515` `listWaiters` callers move to `queueView`; `takeAnyPhone` `:206` opens the Pool request, passes the tag to each try.
- `tools/device/emulator.mjs` -- `isEmulatorLease` gate-ticket parse; `provision` slot loop and gate; `doomed` host checks.
- `tools/device/lease.test.mjs`, `hub-device.test.mjs`, `emulator.test.mjs` -- tests that relied on a try's ticket (`lease()` defaults to `waitMs: 0`) take a wait.
- `_bmad-output/implementation-artifacts/deferred-work.md` -- close the 1.4 Pool entry and the two 2.1 entries this story settles.

## Tasks & Acceptance

**Execution:**
- [x] `tools/ci/lib/lock.mjs` -- `queueView`; `acquireLease` waits through it, re-checks after `mkdir`, tries write no ticket; `poolRequest` handle (request, settle) and the `pool` tag on acquire events -- AD-4/6/9
- [x] `tools/device/hub-device.mjs` -- status and id lookups through `queueView`; `takeAnyPhone` Pool events -- AD-1/4/17
- [x] `tools/device/emulator.mjs` -- `isEmulatorLease` via `queueView`; Pool request around gate and slot tries; `doomed` on `sameHost` -- AD-1/4/8
- [ ] tests -- view order/shape/stale, late-blocker give-back (mutation-checked), try (no ticket, no event on failure), phone and emulator Pool sequences, status unchanged; fix the flaky `waited_ms === 0` assertion -- story ACs

**Acceptance Criteria:**
- Given a queue with live and stale tickets, when `queueView` is read, then entries are in file-name order with `place`, `blocking` and `kind`.
- Given a try that fails, when it returns, then no ticket and no event exist; given one that succeeds, one `acquire`.
- Given `lease phone` or `lease emulator`, when the Event Log is read, then it holds one Pool `request` and one `acquire` or `timeout`, `waited_ms` from the outer request.
- Given `heavy mise run check`, then it is green and no real state dir is touched.

## Implementation Notes

- Built directly in the build session (no subagent tool was available to this run); the three review layers ran as one in-session pass, as in Stories 1.2 to 2.1.
- `lock.mjs`: new exports `queueView`, `poolRequest`, `newLeaseId`, `localHost`. `queueView` wraps `listWaiters` (kept as the ticket reader beneath it and for observers' tests): entries are the ticket plus `file`, `kind`, `place`, `blocking`; sorted by `sortKey` (the file name) then the full name, so Story 2.5 swaps in a Reservation's key. `acquireLease` waits through the view, re-reads it after the `mkdir` and gives the lock back with `retire` (a tombstone, no event) when a blocking entry now stands ahead; a `waitMs: 0` call writes no ticket (the queue directory is not even created), records only its `acquire`, and fails with today's messages. New seam `afterTake` (between the `mkdir` and the re-check) and option `pool` (a `poolRequest` tag).
- `poolRequest(pool, {...})` writes the Pool-level `request` (lock null, `pool`, `request` = lease id, `for_ms`, `deadline_at`) and returns `{id, tag, settle}`; `settle(error, {signal})` writes the one ending: `timeout` (reason `deadline`, or `away` for `HUB_PHONE_AWAY`, `blocked_by` = the message) or `cancel` (`aborted`, `released`, `error`). The try that takes the lock writes the Pool's `acquire` itself (tagged `pool`, `request`; `waited_ms` and `deadline_at` from the outer request), so a hold is counted once. `takeAnyPhone` and `provision` own one request each; `provision` settles only while no slot is taken.
- `hub-device.mjs`: status, `--id` collision and `release` lookups read `queueView(..., {includeStale: true})`; positions are `entry.place`. `emulator.mjs`: `isEmulatorLease` reads the gate through `queueView`; `doomed` uses `sameHost` with `localHost()` for the record and the owner.
- Decisions beyond the frozen block: a failed Pool request with the gate still held writes its Pool `timeout` before the gate's `release` (the `finally`). The tagged-acquire-per-take rule means an away phone shows `acquire`, `release`, then the next probe, as it did before this story.
- Deferred entries closed: the 1.4 Pool-events entry, the 2.1 `doomed()` hostname entry, the 2.1 flaky `waited_ms === 0` assertion (the test now compares the slot acquire to the gate's). New entry: gate tickets still carry `pool: null`.
- Intended test changes: tests that used a try's ticket now wait (`lease.test.mjs` claim races take `waitMs`; `hub-device.test.mjs` reads the queue through `queued()` since a try makes no queue directory; the 1.4 emulator sequence test gains the Pool request and the tagged slot acquire).
- Tests: `lease.test.mjs` +4 (view order and shape, tries, late-blocker give-back, Pool request endings), `hub-device.test.mjs` +1 (phone Pool sequences), `emulator.test.mjs` +1 and a `doomed` host-id check. Mutation-checked: dropping the re-check fails the give-back test.

## Spec Change Log

## Review Triage Log

| Finding | Verdict | Evidence |
|---|---|---|
| A try that wins the `mkdir` and gives the lock back could let a pinned `withLock` see a held lock for a moment | low, rejected | It is a microsecond window; the pinned reader sees EEXIST and polls, exactly as it does for any lease take |
| A ticketless try can no longer be cancelled by `release <id>` | false | The try returns within one call; the take-then-release race on its id is already handled by callers (`updateLease` false then `HUB_LEASE_CANCELLED`) |
| Pool `timeout` and the gate's own `timeout` double-count a full emulator pool | false | They differ by `lock` (null vs `emulator`) and `pool`; the gate's is lock-level history, the Pool's is the request's |
| An away phone writes more than one `acquire` for one Pool request | low, intended | Each is a real take paired with a `release`; this is today's history, now tagged; recorded in the decisions |
| `queueView` ignores `policy` | low, intended | Story 2.5 reads the grace there; the signature is the AC's |
| `stale` entries counted in `place` for status | low, intended | Keeps status text and `--json` positions as they were |
| `doomed()` on `sameHost` changes which owners are judged | medium, intended | With no `host_id` on either side it is the old hostname check; with ids it only stops a drifted hostname reading as foreign; a test pins both directions |
| Event write failure could fail a Pool request | false | `poolRequest` goes through `appendEvent`, which never throws |

## Verification

**Commands:**
- `node --test tools/device/lease.test.mjs tools/device/hub-device.test.mjs tools/device/emulator.test.mjs tools/catchup/catchup.test.mjs` -- expected: all pass
- `heavy mise run check` -- expected: green

## Review (independent)

Reviewer re-read the commit `a8f8763` against epics-v1a "Story 2.2" and AD-4, AD-6, AD-9 without trusting the builder summary.

**Checked, no defect:** every AC of Story 2.2 maps to code and a test (view order, shape, `kind`, room for Reservation entries; give-back by tombstone with no event; a try writes no ticket and no queue directory; a failed try writes nothing; Pool `request` plus one ending with `waited_ms` from the outer request; `emulator.mjs` and `hub-device status`, `--id` and `release` lookups through `queueView`; timeout wording, exit codes and `HUB_DEVICE_*` text unchanged). The re-check mutation fails its test as claimed. Tests are hermetic (temp `HUB_LOCK_DIR` and `HUB_EVENT_DIR`, injected clocks). No tuning value moved outside `policy.json`. Compatibility with pinned v1.2.43 readers holds: ticket name and body untouched, a give-back is a tombstone outside `*.lock`, and 3 old-code waiters mixed with new waiters and tries on one lock dir (stress, 3 runs) gave no double hold, no stray tomb and request/acquire/release counts in step.

**Confirmed and fixed (1):** ticketless tries race the `mkdir` of every other taker, which the old per-try ticket had serialised. A loser that read the lock at the instant its holder released it saw `owner` null and `stat` failing (`staleness` verdict `gone`) and called `retire(path, null)`. `retire` compares the owner it reads now with the owner it judged, null and null, so a fresh ownerless directory made by a third taker in between was renamed away as "stale". Effects, reproduced with 8 try workers on one lock (5 and 17 error lines per run before, 0 in 7 runs after): two holders at once, a taker dying with `ENOENT` on its owner write, and a bogus `reclaim` event. The same hole was in `withLock`. `acquireLease` and `withLock` now retire nothing on `gone` (nothing is left to retire) and go round again, at most 3 times per call before a path that is not a lock waits like a held one, so a dangling path never spins. Regression tests (dangling symlink as the deterministic stand-in, `beforeRetire` as the third taker): "a try that finds the lock gone under it does not retire it" and its `withLock` twin; both fail on the pre-fix code.

**Test gap closed:** the AC "`emulator.mjs:329-332` reads waiters through `queueView`" had no test on the gate-ticket arm of `isEmulatorLease`; added (live ticket, dead ticket, junk file, free id, no pruning).

**Dismissed:** a try giving back a lock for a ticket that arrived after it (AD-6 says a blocking entry that "now sits ahead", and a try has no place, so it fails); stale tickets counted in status places (the old numbering, kept on purpose); `doomed()` on `sameHost` (hostname fallback when ids differ is AD-8 as written); event body lacking null `pool`/`request` keys on lock-level events (every earlier event already omits keys that are null).

**Left for later (deferred-work.md):** a Pool request that probes an away phone has one tagged `acquire` per probe plus its closing `timeout`, and a phone request that fails after a take (`HUB_LEASE_CANCELLED`, abort) writes a `cancel` after its tagged `acquire`; AD-4's "one `acquire` or `timeout`" holds only for a request whose probes were all kept or all untaken.
