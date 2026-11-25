---
title: 'Event Log vocabulary for Registry, Reachability and prune'
type: 'feature'
created: '2026-11-25'
status: 'done'
baseline_revision: '2f12f8ac8f134908a8e14be1fb7514c41601c33b'
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-6-context.md'
warnings: ['oversized']
deferred: []
---

<intent-contract>

## Intent

**Problem:** v1b's Registry, Reachability cache, stream, replica and history need events the log cannot yet hold: there is no way to append a non-hold event (every append goes through the Queued-lock gate), an acquirer's prune of a dead ticket deletes it with a forced `rmSync` and writes nothing (deferred-work: the open `request` with no end), and no reader can resume from a byte position or name an event.

**Approach:** Add `noteRegistry` and `noteReachability` to `lock.mjs` (bypassing the Queued gate, still the only `appendEvent` caller), make ticket pruning unlink-decided with a capped `prune` event, and add `readEventsFrom({month, offset})` to `events.mjs` returning complete lines plus a derived event id. Built for every Resource kind and every future consumer (stream, replica, history) at once — belsky-doctrine: the vocabulary, not one event.

## Boundaries & Constraints

**Always:**
- `lock.mjs` stays the only non-test caller of `appendEvent`; a conformance test walks `tools/**/*.mjs` (non-test) and fails on any other file naming it.
- Every new field is additive; envelope (`format, ts, host, host_id, hub_version`) unchanged in order and source, with the one named exception in Design Notes.
- `registry-*` bodies are built from an allowlist: `resource`, `lock`, `changed` (array of key strings), `rev`, `reason`, `actor`, `why`. An `identity`, serial, udid, adb id or `allowed_users` passed in is never written.
- `actor` is `{holder: non-empty string, via: cli|api|host-agent|control-surface}` (exported `ACTOR_VIA`, `checkActor`); `why` a string. Both allowed on every event the new functions write.
- A write failure is `HUB_EVENT_LOG_FAILED` (appendEvent already logs it) and never throws out of a transition or a prune.
- Bytes already written are never rewritten; the event id is derived on read and never stored.
- Hermetic tests only (`hermetic()`, temp `HUB_EVENT_DIR`/`HUB_LOCK_DIR`).

**Never:**
- No `forceRelease`, `cancelRequest`, Registry store, Hub API or reachability writer in this story (Epics 6.2+, 7); only the names and the append functions.
- Do not change `expiry` events for expired Reservations, `cancel`/`timeout` writers, or any reader's event filters.
- `lock.mjs` never imports `tools/registry/*` (layering): it does not re-declare the Reachability enum.
- No new dependency, no Python, no timers.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Registry add | `noteRegistry('add', {resource:'res-pixel', lock:'res-pixel', changed:['name','capabilities.model'], identity:{serial:'X'}, actor:{holder:'jarad',via:'api'}})` | one `registry-add` line with `resource, lock, changed, actor`; no `identity`/serial anywhere in the line; returns true | bad kind, missing `resource`/`lock`, non-string `changed` entry or bad `actor` → `TypeError` (caller bug) |
| Reachability change | `noteReachability({resource:'s26', from:'reachable', to:'offline', checked_at, reason:'track-lost'})` | one `reachability` line `{resource, from, to, checked_at, reason}`, no Queued gate | append failure → false + `HUB_EVENT_LOG_FAILED` |
| Host reachability | `noteReachability({host:'mac', from:'reachable', to:'unreachable', reason:'connect-timeout'})` | one `host-reachability` line; line's `host` is `mac`, `host_id` is the writer's machine id, `resource: null` | both or neither of `host`/`resource` → `TypeError` |
| Prune ≤ 20 | acquirer's `queueView(...,{prune:true})` finds 3 dead tickets | 3 `unlinkSync`s, 3 `prune` events (`count:1`, `reason` = staleness why or `unreadable`, claimant from ticket, `waited_ms`) | `ENOENT` on unlink → lost race, no event |
| Prune > 20 | 25 dead tickets in one call | 25 removed; 19 individual `prune` events + 1 folded (`count:6`, `reason:'folded'`, null claimant) = 20 | log failure never stops the removals |
| Junk Reservation | unreadable `reservation.json` older than 60 s set aside by `reserve` | one `prune` event `hold_kind:'reservation'`, `run_key`, `reason:'unreadable'` | — |
| Cursor read | `readEventsFrom({month:'2026-11', offset:0})` while a writer is mid-append | only lines up to last `\n`; `offset` = new end; `events[i].id = <host_id>/2026-11/<line byte offset>` | missing file → empty, offset unchanged; offset past EOF or not after a `\n` → `RangeError` code `HUB_EVENT_OFFSET`; bad month → `TypeError` |
| Old reader | log mixing v1a events with every new name | `eta()`, `leaseHoldersSince`, `deliveryPendingEvent` give identical results with and without the new lines | — |

</intent-contract>

## Code Map

- `tools/ci/lib/events.mjs` -- `appendEvent` (L71, `host` option sets envelope host; envelope wins over payload keys), `readEvents` (L106). Add `readEventsFrom` here; update header comment.
- `tools/ci/lib/lock.mjs` -- `note()` L183 (Queued gate, used for hold events and `prune`); `eventOf()` L156 (already adds `resource: resourceOf(lock)`; `fields` overrides, so `actor`/`why` pass through); `listWaiters()` L556 (the prune: `rmSync(...,{force:true})` at L570 and L579 → unlink-decided + events); `retireReservation()` L664 with `record: null` call in `reserve()` L733 (junk set-aside, writes nothing today); `ticketKind`, `releaseLease` L1560 shows how a ticket becomes a cancel subject (reuse for prune subject). Header comment L13-14.
- `tools/ci/lib/eta.mjs` -- `ENDS` L22 (`release, reclaim, force-release`), `pastHolds` filters `hold_kind` job/lease; old reader under test.
- `tools/ci/lib/lock.mjs` L1698-1735 -- `leaseHoldersSince`, `deliveryPendingEvent`: old readers under test.
- `tools/registry/reachability.mjs` -- owns `REACHABILITY` enum; lock.mjs must not import it (registry imports lock).
- `tools/ci/events.test.mjs` -- `fixture()` and the 20-process spawn pattern (L118) to copy for the concurrent read test.
- `tools/deploy-path.test.mjs` -- pattern for a source-walking conformance test.
- `_bmad-output/implementation-artifacts/deferred-work.md` L25-26 -- the prune deferral this resolves.

## Tasks & Acceptance

**Execution:**
- `tools/ci/lib/events.mjs` -- add `readEventsFrom({env, month, offset = 0, maxBytes = 1 MiB})` → `{month, from, offset, lines, events:[{id, offset, event}]}` (raw `lines` kept byte-exact for the replica; unparseable line → `event: null`, `id: null`; `maxBytes` ≥ `EVENT_MAX_BYTES`) and `eventId(hostId, month, offset)` -- one cursor reader for stream/replica/history.
- `tools/ci/lib/lock.mjs` -- add `ACTOR_VIA`, `checkActor`, `PRUNE_EVENTS_MAX = 20`, `noteRegistry(kind, fields, opts)`, `noteReachability(fields, opts)` (direct `appendEvent`, no Queued gate); make `listWaiters` prune via `unlinkSync` with `prune` events capped and folded; junk-Reservation set-aside writes `prune`; update header comments -- AD-39 vocabulary with one appender.
- `tools/ci/event-vocabulary.test.mjs` (new) -- matrix rows above, the identity-never-written walk, the >20 fold, the ENOENT race (two pruners, one event per ticket), the concurrent append-while-`readEventsFrom` child-process test (no torn line, ids unique and stable), the old-reader fixture, and the `appendEvent`-caller conformance walk.
- Existing tests that asserted a silent prune -- update only where they now see the intended `prune` events.
- `_bmad-output/implementation-artifacts/deferred-work.md` -- mark the prune-event deferral resolved by this story.

**Acceptance Criteria:**
- Given `lock.mjs` is imported, when a test inspects its exports, then `noteRegistry` and `noteReachability` are functions, and the conformance walk finds `appendEvent` named only in `tools/ci/lib/lock.mjs` and `tools/ci/lib/events.mjs` among non-test sources.
- Given a dead ticket that two acquirers prune at once, when both run, then exactly one `prune` event exists for it.
- Given a child process appending events in a loop, when the parent calls `readEventsFrom` repeatedly from each returned offset, then every returned line parses, the concatenation equals the file's final prefix byte for byte, and no id repeats.
- Given `mise run check`, when it runs, then actionlint and the full suite pass.

## Spec Change Log

## Review Triage Log

### 2026-11-25 — Review pass
- verdicts: 44 findings — high 0, medium 7, low 20, false 17, maybe-false 0
- findings:
  - `[medium]` `[patch]` (blind) readEventsFrom stalls forever on a complete line longer than maxBytes — fixed: a full window with no newline throws RangeError `HUB_EVENT_LINE_TOO_LONG`; a short window at EOF stays an empty read; test added.
  - `[low]` `[reject]` (blind) `lines` are decoded strings, so invalid UTF-8 would not be byte-exact — every line is written by appendEvent from JSON.stringify in one O_APPEND write, so the log is always valid UTF-8; returning Buffers adds public surface for a case nobody meets.
  - `[low]` `[patch]` (blind) event id trusts a line's host_id verbatim (`/` makes ids ambiguous) — fixed: host part used only when it matches hostId()'s `[0-9A-Za-z-]{1,64}`, else the caller's `hostId`, else `unknown`; tests added.
  - `[low]` `[reject]` (blind) `host` means the peer on host-reachability lines — a deliberate Design Notes decision forced by the AC's `{host, from, to, reason}` shape and the envelope-wins rule; the fix is a spec edit.
  - `[false]` `[reject]` (blind) noteReachability throws TypeError on a new state name — every REACHABILITY value and `unreachable` match STATE_WORD, and states come from the one enum in reachability.mjs; no caller can produce an unmatched word.
  - `[low]` `[reject]` (blind) a huge `changed` list makes the registry event E2BIG — needs ~100+ capability keys per edit; truncation logic is more than a direct correction for a case nobody meets.
  - `[false]` `[reject]` (blind) actor should be required on registry events — seeding (Story 6.3) writes registry-add/edit with no front door; AD-36 requires actor on manual actions only.
  - `[medium]` `[patch]` (blind) paging test never exceeds maxBytes — same root cause as the verification-gap paging finding; fixed by the new paging test.
  - `[medium]` `[patch]` (blind) prune coverage thin: no hub-job ticket — same root cause as the verification-gap hub-job finding; fixed. The other sub-points (abandoned reason, non-Queued lock, folded `at`) rejected low: covered by ticketStaleness/note gate tests elsewhere, no named harm.
  - `[low]` `[reject]` (blind) missing month vs stale offset; no "sealed month" hint — month files are never deleted or rewritten (AD-39) and AD-49 says no month is ever closed, so the hint would contradict the spine.
  - `[low]` `[reject]` (blind) reservation prune written outside retireReservation with a second now() — same rename-winner rule, timestamps differ by microseconds; moving it adds a parameter for no named harm.
  - `[false]` `[reject]` (blind) folded prune loses claimant detail — AD-39 specifies folding the rest into one event with `count`; that is the intended shape.
  - `[low]` `[patch]` (blind) concurrent test flakes across a UTC month boundary — fixed: child passes a fixed `now` and the parent reads that month.
  - `[low]` `[reject]` (blind) new event names undocumented in docs/ — the binding vocabulary is AD-39 in the v1b spine; the Hub API contract doc arrives in Story 6.4.
  - `[low]` `[patch]` (blind) RESOLVED glued into the deferred-work `summary` — fixed: summary restored, separate `resolved_by:` key added.
  - `[medium]` `[patch]` (edge) oversize line stall — grouped with the blind finding; fixed as above.
  - `[low]` `[reject]` (edge) invalid UTF-8 breaks byte-exact lines — as the blind finding.
  - `[low]` `[patch]` (edge) null host_id line read as a replica takes the reader's machine id — grouped with the id fix; the default machine-id lookup is gone.
  - `[low]` `[patch]` (edge) host_id with `/` makes ids ambiguous — grouped with the id fix.
  - `[low]` `[reject]` (edge) a huge caller-chosen maxBytes allocates a large buffer — caller-controlled; no caller passes more than the 1 MiB default.
  - `[low]` `[reject]` (edge) changed list E2BIG — as the blind finding.
  - `[false]` `[reject]` (edge) STATE_WORD rejects digits/underscores — no REACHABILITY state contains either.
  - `[false]` `[reject]` (edge) long claimant strings make a prune E2BIG — the same claimant already rides that ticket's `request` event; pre-existing and not caused here.
  - `[false]` `[reject]` (edge) notePruned throwing in `finally` masks errors — it calls only eventOf (pure) and note→appendEvent, which never throws.
  - `[false]` `[reject]` (edge) pool without request drops the pool fields — acquirePool always writes both; the partial state is unreachable.
  - `[low]` `[reject]` (edge) crash between rm and note loses the reservation prune — the same window exists in every retire path since AD-9 (delete, then record); tiny window, no new harm.
  - `[low]` `[patch]` (edge) concurrent test month-boundary flake — grouped with the blind finding; fixed.
  - `[low]` `[reject]` (edge) conformance walk follows symlinks / scans only .mjs — tools/ has no symlinks and the rule is about .mjs sources.
  - `[false]` `[reject]` (edge claim) "byte-exact" claim fails on invalid UTF-8 — the log is valid UTF-8 by construction (see above).
  - `[medium]` `[patch]` (edge claim) "one line always fits" — grouped with the oversize-line fix; doc comment corrected.
  - `[low]` `[patch]` (edge claim) "a host that cannot name itself reads as unknown" did not hold — grouped with the id fix; now true without a `hostId` option.
  - `[false]` `[reject]` (edge claim) noteRegistry validation partial — oversize input failing as a logged false is the specified never-fatal behaviour.
  - `[medium]` `[patch]` (verification-gap) maxBytes cap and trailing-partial trim never exercised — fixed: paging test with 12 ~1.5 KB events and a half line, ≤ maxBytes pages ending on `\n`, byte-exact prefix, ids equal to an unbounded read.
  - `[medium]` `[patch]` (verification-gap) hub-job prune claimant unasserted — fixed: dead hub-job ticket asserts `claimant.kind: hub-job`, `hold_kind: job`, `lease_id: null`.
  - `[low]` `[patch]` (verification-gap other) month-boundary flake — grouped; fixed.
  - `[false]` `[reject]` (intent) no producers for the new names — the epic states 6.1 needs no service; Stories 6.2, 6.3, 6.6, 6.7 and 6.10 wire the producers.
  - `[false]` `[reject]` (intent) force-release has no writer — `forceRelease` is Epic 7 (AD-38); this story owns only the name.
  - `[false]` `[reject]` (intent) other ticket removals bypass prune — those sites remove a caller's own ticket after `leave()` writes its `cancel`/`timeout`; they are not prunes.
  - `[false]` `[reject]` (intent) actor/why only on the new functions — eventOf `fields` and appendEvent pass both through on any event.
  - `[false]` `[reject]` (intent) conformance test is a text match — it fails on any other non-test file naming appendEvent, which is stricter than "calls".
  - `[false]` `[reject]` (intent) registry identity — a confirmation that the AC is met, not a defect.
  - `[false]` `[reject]` (intent) host-reachability adds `resource: null`, `checked_at` — additive; AD-39 puts `resource` on every v1b event.
  - `[low]` `[reject]` (intent) envelope `host` overloaded — as the blind finding (spec decision).
  - `[false]` `[reject]` (intent) housekeeping (spec, context file, sprint-status untouched) — no defect.

### 2026-11-25 — Review pass (follow-up)
- verdicts: 35 findings — high 0, medium 1, low 17, false 17, maybe-false 0
- findings:
  - `[false]` `[reject]` (blind) no `force-release` writer and no exported event-name list — carried: `forceRelease` is Epic 7 (AD-38), this story owns only the name; no reader needs a name list (old readers filter on their own names).
  - `[low]` `[reject]` (blind) the registry allowlist filters keys, not values (a serial could ride in `why` or `changed`) — `why` is human free text and `changed` is computed key names by the Registry store (6.2); no caller exists yet, and value-shape validation is new guard surface for a case nobody meets.
  - `[false]` `[reject]` (blind) noteReachability throws on unexpected state words — carried: every REACHABILITY value matches STATE_WORD.
  - `[false]` `[reject]` (blind) noteRegistry omits absent fields while noteReachability writes nulls — the matrix fixes the reachability line as `{resource, from, to, checked_at, reason}` with `resource: null` on host-reachability, and the registry body is an allowlist; each follows its specified shape, no reader is harmed.
  - `[low]` `[reject]` (blind) envelope `host` means the peer on host-reachability — carried: deliberate Design Notes decision; the fix is a spec edit.
  - `[false]` `[reject]` (blind) folded prune loses the reason breakdown — carried: AD-39 specifies one folded event with `count`.
  - `[false]` `[reject]` (blind) notePruned in `finally` can mask the original error — carried: it calls only eventOf (pure) and note→appendEvent, which never throws.
  - `[low]` `[reject]` (blind) `lines` not byte-exact on invalid UTF-8 — carried: the log is valid UTF-8 by construction.
  - `[low]` `[reject]` (blind) no signal that a month is finished — carried: AD-49, no month is ever closed.
  - `[low]` `[patch]` (blind) the caller's `hostId` fallback is unvalidated (`'a/b'` gives a four-part id) — fixed: the fallback passes the same machine-id rule as the line's `host_id`, else `unknown`; test asserts `'a/b'`, `''`, 65 chars and a number read as `unknown`.
  - `[low]` `[patch]` (blind) concurrent-append test imports lock.mjs by raw path and the child looks up the real machine id — fixed: import via `pathToFileURL(...).href`, child passes `hostId: 'child-host'`. The comment-scanning sub-point is carried false (conformance text match, stricter than "calls"); the child-timeout sub-point is rejected low (node's test runner reports a hang; a kill timer is added code for no observed hang).
  - `[low]` `[reject]` (blind) no docs for the new names; epic-6-context committed with code — carried: the binding vocabulary is AD-39, the Hub API contract doc arrives in 6.4; the context file is the workflow's planning cache.
  - `[false]` `[reject]` (blind) other retireReservation callers remove records with no event — they are release (`as: 'release'`) and expiry (`as: 'expiry'`), which write their own events; the spec keeps them unchanged.
  - `[low]` `[reject]` (edge) invalid UTF-8 breaks byte-exact lines — carried.
  - `[low]` `[patch]` (edge) unvalidated `hostId` fallback — grouped with the blind fallback finding; fixed as above.
  - `[false]` `[reject]` (edge) ENOTDIR/EACCES escape readEventsFrom while readEvents returns empty — a cursor reader that loudly fails on an unreadable log is correct; nothing shows either state is reachable from hub code (HUB_EVENT_DIR is a directory the hub creates).
  - `[low]` `[reject]` (edge) missing month with a nonzero offset reads as empty — carried: month files are never deleted (AD-39/AD-49).
  - `[false]` `[reject]` (edge) a `remote`/unknown ticket kind is logged as a lease — ticketKind yields only `lease`, `job`, `hub-job` (no writer creates another kind), and the mapping is the same one releaseLease's `cancel` uses.
  - `[false]` `[reject]` (edge) uppercase peer host keys throw — host keys are `linux`/`mac` (claims.mjs HOST_PLATFORMS), written lowercase by hosts.mjs.
  - `[low]` `[reject]` (edge) `from === to` is logged as a change — deciding what is a change is the reachability writer's job (6.6); no caller exists, and the guard is added surface.
  - `[false]` `[reject]` (edge) STATE_WORD rejects digits/underscores — carried.
  - `[false]` `[reject]` (edge) notePruned throwing in `finally` — carried.
  - `[low]` `[reject]` (edge) crash between rm and note loses the reservation prune — carried.
  - `[low]` `[reject]` (edge) huge `changed` list goes E2BIG — carried.
  - `[false]` `[reject]` (edge claim) byte-exact claim fails on invalid UTF-8 — carried.
  - `[medium]` `[patch]` (verification-gap) the unreadable-Reservation `prune` is guarded by the rename winner, but no test runs the loser — fixed: new test where a rival renames the junk record away inside retireReservation's clock read; the loser claims and writes only `claim`. Mutation-checked: dropping the guard fails it.
  - `[low]` `[reject]` (verification-gap other) `docs/hub-releases.md:93` event list omits the new names — carried as the undocumented-names row.
  - `[false]` `[reject]` (intent) no test kills a real waiter on withLock/acquireLease — all three acquirers prune through `queueView(..., {prune: true})` (lock.mjs acquire paths), the surface the matrix names and the tests drive.
  - `[low]` `[reject]` (intent) a Lease prune's claimant lacks the GITHUB_* fields; nothing ends a Pool-level `request` — Lease events pair by `lease_id` (the same subject releaseLease's `cancel` uses), and per-lock Pool prunes carry `pool` and `request`, so a reader can pair; no reader pairs prunes yet, and a Pool-level prune writer is new surface.
  - `[low]` `[reject]` (intent) readEventsFrom reads one month; rollover left to the caller — carried.
  - `[false]` `[reject]` (intent) prune events carry no `actor`/`why` — carried: eventOf `fields` pass both through on any event; a prune has no front-door actor.
  - `[low]` `[patch]` (intent) event-id host part for a missing/forged `host_id` — carried: fixed in the first pass; the code reads as described.
  - `[false]` `[reject]` (intent) "null claimant" read literally as `claimant: null` — eventOf's subject-null convention is an all-null claimant object (holder null), as every v1a event without a subject; the matrix is met.
  - `[false]` `[reject]` (intent) old-reader fixture writes prune/force-release with raw appendEvent — eta filters on ENDS, leaseHoldersSince on LEASE_EVENTS, deliveryPendingEvent on `timeout`; none reads a `prune` line, so field sets cannot change their answers.
  - `[false]` `[reject]` (intent) a non-ENOENT unlink error still throws out of listWaiters — unchanged from the former `rmSync({force:true})`; prunes recorded before it are still written.

## Design Notes

- **`host-reachability`'s `host`.** The envelope wins over payload keys, so a payload `host` would be overwritten by the writer's hostname. `noteReachability` passes the peer's host key as appendEvent's `host` option: on this one event `host` names the host the event is about (`linux`/`mac`), as the AD-39 shape requires, and the writer stays identified by `host_id` (which also keys the event id).
- **Fold arithmetic.** "At most 20 events per call": ≤ 20 removals → one event each; > 20 → the first 19 individually plus one `{event:'prune', lock, resource, count: rest, reason:'folded'}`. Individual events carry `count: 1` so a reader sums `count`.
- **Reservation prune.** An expired Reservation is already removed rename-decided with its `expiry` event (AD-7/AD-9); that stays. Only the unreadable-record set-aside (today silent) gains `prune`. Directories cannot be `unlinkSync`'d; tickets can.
- **Reachability states** are validated as short lowercase words or `null` (first reading), not against the enum, because `lock.mjs` must not import `tools/registry/`.

## Verification

**Commands:**
- `node --test tools/ci/event-vocabulary.test.mjs tools/ci/events.test.mjs` -- expected: all pass
- `mise run check` -- expected: actionlint clean, full suite green


## Auto Run Result

Status: done

**Summary.** This was a follow-up review pass on Story 6.1, the AD-39 Event Log vocabulary. The story is built for every Resource and every future reader at once (belsky-doctrine).
- `lock.mjs` exports `noteRegistry` (`registry-add|edit|retire`, allowlisted body, never an identity) and `noteReachability` (`reachability`, `host-reachability`). Both skip the Queued gate, and `lock.mjs` stays the only `appendEvent` caller.
- Ticket pruning is unlink-decided and writes capped and folded `prune` events. An unreadable-Reservation set-aside writes one `prune`.
- `events.mjs` gains `readEventsFrom` and `eventId`, with byte-exact complete lines and ids derived on read.

The pass found 35 issues. It patched 3: one medium, which was a missing test for the losing side of a rename race, and two low. Nothing was deferred and nothing outside the repo is owed.

**Files changed (this pass)**
- `tools/ci/lib/events.mjs`: `readEventsFrom`'s `hostId` fallback must pass the machine-id rule, otherwise the id reads as `unknown`. The doc comment is updated to match.
- `tools/ci/event-vocabulary.test.mjs`:
  - New test: the reserver that loses the set-aside rename writes no `prune`.
  - Fallback-validation assertions.
  - The concurrent child imports `lock.mjs` through `pathToFileURL` and passes a fixed `hostId`.
- `_bmad-output/implementation-artifacts/spec-6-1-…md`: the follow-up triage log and this result.

Files changed by the story overall (commit `4e4e78cf2b2bc26ebcb570c9841efe95413692f8`): `tools/ci/lib/lock.mjs`, `tools/ci/lib/events.mjs`, `tools/ci/event-vocabulary.test.mjs` (new), `tools/ci/reservation.test.mjs`, `deferred-work.md` (`resolved_by: Story 6.1`) and `epic-6-context.md` (new).

**Review findings.** 35 findings: high 0, medium 1, low 17, false 17, maybe-false 0.
- **Patched (3 entries):**
  - Medium: the rename-loser path of the unreadable-Reservation prune had no test. I added one and mutation-checked it: dropping the guard makes it fail.
  - Low: the unvalidated `hostId` fallback in `readEventsFrom`.
  - Low: the concurrent test's raw-path import, and its child looking up the real machine id.
- **Deferred:** none.
- **Rejected:** 30 rows, each with its reason in the follow-up triage log above. Seventeen are false. Thirteen are low; nine of those were carried from the first pass. The four new low rejections:
  - registry value-shape validation;
  - `from === to` guarding;
  - Lease and Pool prune pairing;
  - a kill timer on the test child.

  Each is added surface for a case no current caller meets.

**Follow-up review recommended: false.** This is a follow-up pass and it patched no high entry, so the work has converged. Patched counts by verdict: high 0, medium 1, low 2.

**Verification**
- `node --test tools/ci/event-vocabulary.test.mjs tools/ci/events.test.mjs`: 32/32 pass.
- Mutation check: with the `if (retireReservation(...))` guard removed, the new loser test fails. Restored afterwards.
- `mise run check`: exit 0, actionlint clean, 955/955 tests pass.

**Residual risks**
- No producer calls `noteRegistry`, `noteReachability` or `readEventsFrom` yet. Stories 6.2, 6.3, 6.6, 6.7 and 6.10 wire them up, so for now only tests pin their shapes.
- On `host-reachability` lines, the envelope `host` is the peer and the writer is `host_id`.
- Reviewers did not raise this one; I found it while triaging. A reserver can judge a record junk while the winner is in a tiny window between its `mkdirSync` and `writeFileSync` of the fresh record. That reserver can then set aside the winner's still-empty directory and write a second `prune`; the winner retries on ENOENT. The removal race predates this story (Story 2.x's `record: null` path), and this story only makes it visible as an extra event. The window is microseconds wide.
