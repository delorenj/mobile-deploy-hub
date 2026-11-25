---
title: 'No extension while a Pool or gate waiter sits behind'
type: 'feature'
created: '2026-11-25'
baseline_revision: 'ee030658c563a01a669e0c2eff85d610a104b113'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-5-context.md'
warnings: ['oversized']
deferred: []
---

<intent-contract>

## Intent

**Problem:** `extendLease` reads only the extended lock's own queue. An emulator slot Lease can therefore be extended while an emulator request waits at the `emulator` gate (its holder and its queue), starving it; and a Pool ticket counts even when its request already holds another member, or is the extender's own, so an extension is refused for a waiter that is already served (FR-31, AD-34, AD-16).

**Approach:** Give `extendLease` one waiter check that reads every queue the Resource is served from: the lock's own queue (Pool tickets included) and, for an `emulator-<n>` slot, the `emulator` gate (its live holder, who is next for a slot, then its queue). It drops the extender's own ticket and any Pool ticket whose request already holds a member, and names every remaining waiter with its position.

## Boundaries & Constraints

**Always:**
- Own-queue waiters: `queueView(name)` entries with `blocking`, minus an entry whose `lease_id === id`, minus a Pool entry (`pool` and `request` both strings) whose `request` holds a member. "Holds a member": some lock other than the `emulator` gate has a live (non-stale) Lease owner whose `lease_id` is that request (`listLocks`, read only).
- For `name` matching `/^emulator-\d+$/` only, the gate line is read too: the live Lease holding `emulator` (`liveLease`) is position 1 unless it is the extender or holds a member; each blocking `queueView('emulator')` entry, filtered by the same two rules, is at its `place` plus 1 when a live gate holder exists (else its `place`).
- Refusal text: own-queue waiters exactly as today (`<place>. <holder|lease_id> (<why>)`, joined `, `); gate waiters as `in the emulator line <pos>. <holder> (<why>), ...`, joined to the own group with `; `. The count in `cannot be extended while <n> waiter(s) wait(s)` covers both groups. An own-queue-only refusal is byte-identical to v1a.
- `queueView` keeps listing a Pool ticket exactly once per member queue with its `pool` and `request` keys (the mark status folds on); a test pins it.
- The check stays read-only: no prune, no grace start, no event; the refusal writes nothing.

**Never:** No change to `acquireLease`, `acquirePool`, `withLock`, `queueView`'s output, the ticket format, the deploy path, `statusView`, exit codes or the existing extension caps. No `hub-device extend` verb (v1b scope elsewhere). No override path (AD-38, Control Surface epic). No import of `emulator.mjs` into `lock.mjs`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Pool waiter behind s24 | `mine` holds s24; `phone` request `req` waits (tickets in s24 and adb queues), holds nothing | refused, names `1. <holder> (<why>)` | `HUB_LEASE_EXTEND_REFUSED`, nothing written |
| Pool request already served | same, but `req` holds adb | extended, one `extend` event | — |
| Own ticket | a ticket with `lease_id: mine` in s24's queue | ignored; extended | — |
| Gate holder waits | `mine` holds emulator-1; `e-next` holds `emulator` | refused, `in the emulator line 1. …` | `HUB_LEASE_EXTEND_REFUSED` |
| Gate queue waiter | plus a ticket in `emulator.queue` | refused, names positions 1 and 2 | same |
| Gate holder already has a slot | `e-next` also holds emulator-2, no gate ticket | extended | — |
| Non-slot lock | s24 extended while the gate is held | extended (gate not read) | — |
| Expired / dead gate holder | gate owner past `expires_at` | not a waiter | — |

</intent-contract>

## Code Map

- `tools/ci/lib/lock.mjs` -- L1624-1655 `extendLease` (L1641 the one-queue check to replace; keep cap/expiry checks and order), L823 `queueView`, L843 `waiterText` (reuse), L102 `liveLease`, L97 `isLease`, L1732 `listLocks` (has `stale`), L56 `EMULATOR_POOL = 'emulator'` (the gate's lock name; `emulator.mjs` L29 `GATE` is the same string), L60 slot regex precedent.
- `tools/device/emulator.mjs` L489-541 -- read only: a request takes the `emulator` gate Lease (why `next for an emulator: …`, holder_pid its own pid) and holds it while it polls slots, releasing it in `finally` after taking one; so the gate holder is the next waiter.
- `tools/device/claims.mjs` L512-518 `extend` -- resolves the slot or phone lock, then calls `extendLease`; no change expected.
- `tools/ci/extend.test.mjs` -- fixture (`fixture`, `take`, `extend`, `putTicket`, `refused`) to extend with the new cases; existing assertions stay unchanged.
- `tools/ci/pool-request.test.mjs` L1-45 -- `acquirePool` fixture pattern if a real Pool waiter is wanted at lock level.
- `tools/device/claims.test.mjs` L246-277 -- `claims.extend` test pattern (`side()`, `startWaiter`).
- `README.md` L92 -- the `extendLease` paragraph: add the Pool and gate rules.

## Tasks & Acceptance

**Execution:**
- `tools/ci/lib/lock.mjs` -- add a read-only `waitersBehind(name, id, opts)` helper used by `extendLease` for its waiter check and refusal text, per Always -- AD-34 in the one lock module.
- `tools/ci/extend.test.mjs` -- add hermetic cases for every I/O matrix row, plus a `queueView` assertion that a Pool request's identical ticket is listed once in each member queue with `pool` and `request`.
- `tools/device/claims.test.mjs` -- one `claims.extend` case: s24 held, a real `acquirePool('phone', ['s24','adb'])` waiter (adb held by another), extension refused naming it; the waiter is then aborted.
- `README.md` -- document the extended waiter check (Pool tickets, own ticket, the gate line).

**Acceptance Criteria:**
- Given a Lease on `s24` and a `phone` request waiting in the s24 and adb queues, when `extendLease('s24', …)` runs, then it throws `HUB_LEASE_EXTEND_REFUSED` naming the request's holder with its position and writes nothing.
- Given the same request already holding `adb`, when the s24 Lease is extended, then it succeeds with one `extend` event.
- Given a Lease on `emulator-1` while the `emulator` gate is held by a waiting request (and/or has a queued ticket), when it is extended, then it is refused naming each gate waiter `in the emulator line` with its position.
- Given `mise run check`, then every existing suite passes unchanged.

## Spec Change Log

## Review Triage Log

### 2026-11-25 — Review pass
- verdicts: 18 findings — high 0, medium 0, low 10, false 8, maybe-false 0
- findings:
  - `low` `reject` (blind) A live gate holder is counted for every slot even when another slot is free. — The holder polls slots every second and takes a free one at once; then it holds a member and is ignored. A slot left by an unreaped record is skipped by the holder, so it really waits. The refusal lasts at most one poll, and fixing it adds a slot scan.
  - `low` `reject` (blind) `/^emulator-\d+$/` repeats the slot naming. — `lock.mjs` already uses that exact regex at L46, L60 and L79, and it may not import `emulator.mjs`. Factoring all four out is a refactor, not a correction, for a rename nobody plans.
  - `low` `reject` (blind) The queue, lock-dir and gate reads are separate snapshots. — The holding set is read after the queue, so a win between the reads is seen as served. No ordering makes a waiting request look served, so an extension is never wrongly allowed. The only effect is a refusal for one poll's width.
  - `low` `patch` (blind) Branches of `waitersBehind` are uncovered: the stale filter, malformed tickets, holder-is-extender, the served-holder shift, the pass-through, and no direct unit test. — The stale filter was the one that could defeat the guard; it is now pinned (grouped with the verification-gap row). The rest are rejected: tickets are written only by `lock.mjs`, and the other branches are microsecond windows.
  - `low` `patch` (blind) Tests hand-build the winner's state, the claims Pool test uses real timers, and there is no recovery assertion. — Added a test through the real `acquirePool` winner path (grouped with the verification-gap "other" row). The real-timer pattern is the one the 5.8 suites use and has been green, and recovery is the existing no-waiter extension path.
  - `false` `reject` (blind) The README's "`hub-device extend` verb is v1b" is stale. — `hub-device.mjs` has no `extend` verb; `claims.extend` is library only, so the sentence is still true. The density point is cosmetic, in the paragraph's existing style.
  - `low` `reject` (edge) Gate holder refused while a free slot exists. — Same as the first blind row; at most one poll's width.
  - `low` `reject` (edge) A served or self gate holder still shifts queue places, so the text can read `2.` with no `1.`. — The spec's Always sets the shift on a live holder. It happens only between a request taking a slot and releasing the gate in its `finally`, a window of milliseconds.
  - `false` `reject` (edge) A plain gate-queue ticket whose lease holds a slot is counted. — A request takes the gate before it probes any slot (`emulator.mjs` L503-523), so a ticket still in the gate queue holds no slot.
  - `false` `reject` (edge) One emulator request is both the gate holder and a ticket in a slot queue. — Slot probes are tries (`waitMs: 0`, `emulator.mjs` L523) and write no ticket.
  - `false` `reject` (edge) The claims test poll can see a `.tmp` file and run before the ticket lands. — `writeTicket` writes and renames synchronously in this same process, so the test's `readdir` cannot run between the two calls.
  - `low` `patch` (verification-gap) No test has an expired, unreaped member Lease of a Pool request, so dropping `!lock.stale` passes. — Added a test where `req`'s adb Lease expired: s24's extension is refused naming the pooler. The implementer confirmed it fails with the clause removed.
  - `low` `patch` (verification-gap, other) No test runs the real `acquirePool` winner path followed by an extend. — Added a test that extends s24 from the `beforeWithdraw` seam while the request holds adb and its s24 ticket is still there: the extension succeeds with one `extend` event.
  - `false` `reject` (intent) `queueView` was only verified, not changed. — AD-34's `pool` mark is the ticket's own `pool` and `request` keys, which `queueView` already passes through and which `statusView` folds on (Story 5.8). A test now pins it.
  - `low` `patch` (intent) The "already holding a member" case is exercised only by simulation. — Grouped with the verification-gap "other" row; a real `acquirePool` test was added.
  - `false` `reject` (intent) Counting the gate holder goes beyond AD-34's wording. — A request holds the gate exactly while it waits for a slot, so reading only the gate queue would never see the first emulator waiter. That would break the story's "never starved"; the Design Notes record it.
  - `false` `reject` (intent) The gate group's message format is the diff's own choice. — AD-34 asks only that each waiter be named with its position, and own-queue refusals stay byte-identical to v1a.
  - `false` `reject` (intent) No CLI or Hub API surface is tested. — Neither exists yet: there is no `hub-device extend` verb, and the Hub API is Epic 6. `claims.extend` is tested.

## Design Notes

- The gate holder counts as a waiter: a request holds the gate exactly while it waits for a slot, so reading only `emulator.queue` would never see the first emulator waiter and the slot could be extended past it, which AD-34 exists to prevent.
- "Holds a member" looks at every non-gate lock's live owner by lease id: lock ids are unique per request, and the lock layer does not know a Pool's member list (the held member's ticket is already claimed, so a file-name scan would miss it).

## Verification

**Commands:**
- `node --test tools/ci/extend.test.mjs tools/ci/pool-request.test.mjs tools/device/claims.test.mjs tools/ci/refused.test.mjs` -- expected: all pass.
- `mise run check` -- expected: actionlint clean, full suite green.

## Auto Run Result

Status: done

**Summary.** `extendLease` now reads every queue the Resource is served from (AD-34), through one new read-only helper, `waitersBehind` in `lock.mjs`.
- **Own queue:** the lock's own queue, where a Pool ticket counts once per member queue. The extender's own ticket does not count, and neither does a Pool ticket whose request already holds a live member.
- **Emulator gate:** for an `emulator-<n>` slot the check also reads the `emulator` gate. The gate's live holder is position 1, because it is next for a slot, unless it is the extender or already holds a slot. The gate's queue follows.
- **Refusal text:** a refusal names every waiter with its position. Own-queue waiters read as before, byte-identical to v1a. Gate waiters read `in the emulator line <n>. <holder> (<why>)`, joined with `; `.
- **Unchanged:** `queueView` already lists a Pool ticket once per member queue with its `pool` and `request` keys; a test now pins that. The refusal still writes nothing, and caps, expiry checks and exit codes are unchanged.

**Files changed**
- `tools/ci/lib/lock.mjs`: the new `waitersBehind`; `extendLease` uses it for the check and the refusal text.
- `tools/ci/extend.test.mjs`: 9 new hermetic cases, covering every I/O matrix row, the `queueView` Pool mark, an expired unreaped member Lease, and a real `acquirePool` winner extended mid-withdrawal.
- `tools/device/claims.test.mjs`: `claims.extend` refused by a real `acquirePool('phone')` waiter.
- `README.md`: the `extendLease` paragraph documents the Pool, own-ticket and gate rules.

**Review findings.** 18 findings: 10 low and 8 false, none high, medium or maybe-false.
- **Patched (2 low entries):**
  - A test where a Pool request's member Lease has expired but was not reaped; it still blocks. It was verified to fail without the `!lock.stale` filter.
  - A test through the real `acquirePool` winner path, extended from the `beforeWithdraw` seam; the extension is allowed.
- **Deferred:** none.
- **Rejected:** 14 rows; the reason for each is in the Review Triage Log. In short:
  - Transient windows of one poll or a few milliseconds: a gate holder with a free slot, the served-holder shift, and separate snapshots.
  - Matching the module's own pattern: the slot regex.
  - Impossible states: a gate ticket that holds a slot, a slot-queue ticket, and the `.tmp` race in a single thread.
  - Surfaces that do not exist yet: the CLI verb and the Hub API.
  - Readings the spec settles: the gate holder counts, and `queueView` is unchanged.

**Follow-up review recommended:** false. This was the first pass, and it patched 0 high and 0 medium entries (2 low entries).

**Verification**
- `node --test tools/ci/extend.test.mjs tools/ci/pool-request.test.mjs tools/device/claims.test.mjs tools/ci/refused.test.mjs`: 62 of 62 pass.
- `mise run check` exits 0, with actionlint clean and 928 of 928 tests passing. That run came after the review patches.
- Matrix audit: every I/O row has a passing test in `tools/ci/extend.test.mjs`. The Pool waiter row is also covered through `claims.extend` in `claims.test.mjs`.

**Residual risks**
- A live gate holder refuses a slot extension for up to one poll (1 s) even when another slot is free, until it takes that slot.
- In the milliseconds between a request taking a slot and releasing the gate, gate-queue positions can read one higher than they will be.
- No operator actions. The release is Story 5.10.
