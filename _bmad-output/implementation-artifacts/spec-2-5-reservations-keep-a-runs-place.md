---
title: 'Story 2.5: Reservations keep a run''s place'
type: 'feature'
created: '2026-11-23'
status: 'done'
route: 'dispatch'
review_loop_iteration: 0
baseline_commit: 'bfa5c45c91cf7d919f0a830083cb5d66095344a5'
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-2-context.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** A deploy run takes its device in several jobs (plan, android, ios) separated by long builds, so a Claimant that arrives while the run compiles takes the device first and the run loses its place. MOBI-34, epic MOBI-29, FR-9, AD-6, AD-7, AD-11.

**Approach:** A run reserves its devices when it starts: the gate reserves `adb` (S26 in scope), `preflight-ios` reserves `mac-ios` on the Mac. A Reservation is a directory `<name>.reservations/<owner>--<repo>--<run>/` that old versions never see. `queueView` lists it in line by `reserved_at`, hides it while its run has a live ticket (that ticket sits at its place), and lets only the first Reservation in line block, until its one-time grace ends. The queue policy block gains `grace_min` (10) and `reservation_ceiling_min` (180).

**Decisions (autonomous, pre-approved):** `run_key` is the directory name. Records hold ISO times and `grace_ms`; readers use the record, never policy. A Reservation failure never fails a job (logged `HUB_RESERVATION_FAILED`). Dry runs reserve too (their lanes take the same locks). A try of the Reservation's own run is not blocked by it. Status keeps its output: Reservation entries are filtered from `waiters` and positions renumbered (the Reservations section is Story 4.3). Releasing a Reservation is Story 2.6; this story's expiry prune uses the same rename-then-delete helper. `claim`, `grace` and `expiry` events carry `hold_kind: reservation`.

## Boundaries & Constraints

**Always:** Node 24 ESM, `node:` builtins. Only `lock.mjs` writes protocol paths and events. New state is a sibling path; a Reservation is never `<name>.lock/owner.json`; every record has `format: 1`. Liveness is `now < expires_at` only. Tests hermetic (temp `HUB_LOCK_DIR`/`HUB_EVENT_DIR`, injected clock and policy). No timer.

**Never:** Release verbs, `announce`, `hub-device reservation` (2.6), `extendLease` or the Lease cap (2.7), a status Reservations section (4.3), a release or `hosts:install` (2.8), a policy key beyond `grace_min` and `reservation_ceiling_min`, a change to `templates/deploy.yml`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Gate reserves | S26 in scope, run `o/r#5` | `adb.reservations/o--r--5/reservation.json` (`wx`), one `claim` event | failure logged, job goes on |
| Rerun | live Reservation of the run | reused, no second `claim` | N/A |
| iOS-only run | `scope.android` false | nothing on `adb` | N/A |
| Mac preflight | iOS in scope | `mac-ios` reserved on the Mac's disk | as above |
| Run asks | Job Hold with matching repo and run | ticket `ms15` = `reserved_at`, `enqueued_at` real, Reservation hidden | N/A |
| Grace | free lock, unasking Reservation first | first observer creates `grace.json` (`wx`) and one `grace` event; others blocked until it ends, then not | status computes, creates nothing |
| Expiry | past `expires_at` | an acquirer's prune renames to `.released-<key>-<ms>`; winner alone appends `expiry` | loser silent |
| Old hub | bare `mkdir` of `adb.lock`; `listLocks()` | no owner seen; no Reservation listed | N/A |

</frozen-after-approval>

## Code Map

- `tools/ci/lib/lock.mjs` -- `queueView` (adds Reservation entries, hiding, blocking, prune), `queuedLock` and `acquireLease` loops (grace stamp, own-run place), `writeTicket` (place ms apart from the real request time); new exports `reserve`, `listReservations`, `RESERVABLE`, `runKey`. Reuse `note`, `eventOf`, `iso`, `lastTomb`'s monotonic idea.
- `tools/ci/policy.json`, `tools/ci/lib/policy.mjs`, `tools/ci/policy.test.mjs` -- the two keys, strict.
- `tools/ci/commands/gate.mjs` -- reserve `adb` when `scope.android`; `tools/ci/commands/plan.mjs` `preflightIos` -- reserve `mac-ios`; both take a `reserver` seam.
- `tools/device/hub-device.mjs` -- `status` filters Reservation entries from `waiters`.
- `tools/ci/test-fixtures.mjs` -- `hermetic()` also scratches `HUB_LOCK_DIR`.
- `tools/ci/reservation.test.mjs` (new); `README.md` Queue tuning; `deferred-work.md`.

## Tasks & Acceptance

**Execution:**
- [x] `tools/ci/policy.json`, `tools/ci/lib/policy.mjs`, `tools/ci/policy.test.mjs` -- `grace_min`, `reservation_ceiling_min` -- AD-11
- [x] `tools/ci/lib/lock.mjs` -- Reservation create/reuse/list, `queueView` entries, grace, expiry, own-run ticket place -- AD-6, AD-7
- [x] `tools/ci/commands/gate.mjs`, `tools/ci/commands/plan.mjs`, `tools/device/hub-device.mjs` -- reserve at the gate and `preflight-ios`; status unchanged
- [x] `tools/ci/reservation.test.mjs`, `tools/ci/test-fixtures.mjs` -- matrix and AC tests

**Acceptance Criteria:**
- Given the policy `queue` block, then it has `grace_min` (10) and `reservation_ceiling_min` (180), strictly parsed.
- Given Reservations, when `queueView` reads, then they sort by `reserved_at`, one whose run has a live ticket is hidden, and only the first in line is `blocking`, only before its grace ends.
- Given a free lock with an unasking head Reservation, when an acquirer or try observes it, then `grace.json` is created with `wx` and one `grace` event follows; read-only paths compute grace and create nothing.
- Given an expired Reservation, when an acquirer prunes it, then the directory is renamed to `.released-<key>-<ms>` and only the winner appends `expiry`.
- Given the hermetic suite, then an old bare `mkdir` sees no owner for a Reservation and `listLocks()` does not list it.

## Implementation Notes

- `lock.mjs` owns every Reservation path and event: `reserve`, `listReservations`, `runKey`, `RESERVABLE` (`adb`, `mac-ios`), and the internal `retireReservation` (rename to `.released-<key>-<ms>` inside the reservations directory, put back if a different `reserved_at` was moved, delete, then the event). Story 2.6 reuses `retireReservation` with `as: 'release'`.
- `queueView` merges Reservation entries (`file` is the `reserved_at` in 15 digits plus `-reservation-<key>`), hides one whose run has a live ticket, and marks only the first live one `blocking` until its grace is over. `startGrace` runs in the blockers branch of `queuedLock` and `acquireLease`; read paths compute grace and create nothing.
- A Job Hold of a run with a live Reservation writes its ticket at the Reservation's `reserved_at` (`enqueued_at` stays the real time) and records `reservation` on the ticket and the `request` event. A try of the Reservation's own run is not blocked by it and starts no grace.
- Gate (`scope.android`) and `preflight-ios` reserve through `reserveFor` (never throws, logs `HUB_RESERVATION_FAILED`); both take a `reserver` seam.
- `hermetic()` now scratches `HUB_LOCK_DIR` so a gate test cannot leave a Reservation in the real lock dir.
- Status keeps its output: Reservation entries are filtered from `waiters` and positions renumbered.
- Deferrals (no end to a Reservation before 2.6, Leases get no same-run passthrough, equal-millisecond tie-break) are in `deferred-work.md`.

## Spec Change Log

None. No loopback.

## Review Triage Log

In-session review of the diff against the spine (AD-6, AD-7, AD-9, AD-11). No finding survived verification as high or medium.

| Finding | Verdict | Evidence |
|---|---|---|
| A Reservation of a run with an unreadable record could block the key forever | false | `reserve` waits 25 ms rounds, sets a record older than 60 s aside, and throws after 8 rounds; the caller logs it and the run goes on |
| `startGrace` races a release (stamp into a renamed dir) | false | the stamp is `wx` on a path inside the Reservation directory, so a renamed-away directory gives ENOENT, which is swallowed; tested |
| Two observers both stamp grace | false | `wx` gives one winner, and only the winner appends `grace`; tested with the EEXIST path |
| Old hub sees the Reservation | false | a Reservation is a directory under `<name>.reservations/`, never `<name>.lock`; tested with a bare `mkdir` and `listLocks()` |
| Leases get no same-run passthrough | low | deliberate; Leases are not run holds; deferred |
| Equal-millisecond ticket-vs-Reservation tie | low | ticket sorts first; harmless and deferred |

## Review

Self-review, one pass; no patches needed. `heavy mise run check` green: 580 tests, 0 fail.

## Verification

**Commands:**
- `node --test tools/ci/reservation.test.mjs tools/ci/policy.test.mjs tools/device/lease.test.mjs` -- expected: all pass
- `heavy mise run check` -- expected: green

## Review (independent)

Adversarial pass against the epic's Story 2.5 ACs and AD-2, AD-6, AD-7, AD-9, AD-11, reading the commit `87f6984` and running the suite with `HOME` pointed at an empty temp dir (nothing was written there: the new tests and the gate and preflight-ios tests are hermetic).

**Checked and sound:** every AC has a test that fails without the behaviour; eight processes reserving one run key give one `claim` and seven `reused`; six processes pruning one expired Reservation give one `expiry`; `wx` on `grace.json` gives one winner and one `grace`; a stamp into a renamed-away directory is ENOENT and silent; an old bare `mkdir` of `<name>.lock` and `listLocks()` never see a Reservation; tickets and owners gained no key; `hub-device status` output is unchanged (Reservations filtered, positions renumbered); the gate and `preflight-ios` log lines are the only new CLI output; `grace_min` and `reservation_ceiling_min` are read from policy only (the 60 s unreadable-record age and the 25 ms retry are protocol constants like `TICKET_ABSENT_MS`).

**Fixed:**
- `retireReservation` set an unreadable record aside without the put-back check it applies to a judged record, so `reserve` could delete a good Reservation a concurrent rerun created between its age check and its rename (the rerun then lost its place and a second `claim` followed). A readable Reservation found in the moved directory now goes back whatever was judged. Regression test: `setting aside an unreadable record never deletes a Reservation another process made after it was judged`.
- Four tests waited a fixed 40 to 60 ms of real time for a ticket, a grace stamp or a served job; they now poll up to 10 s (`until`), so a loaded box cannot flake them.

**Dismissed:** a Lease ticket made inside a deploy run's own environment would hide that run's Reservation (no deploy lane leases, and the AC hides on any live ticket of the run); a grace stamp that fails for a reason other than ENOENT or EEXIST is swallowed, so the head would block until its ceiling (same user owns every lock directory; recorded in `deferred-work.md`); a stamp racing an expiry plus an immediate re-reserve of the same key could start the new Reservation's grace early (needs a rerun within the same millisecond window as an expiry).
