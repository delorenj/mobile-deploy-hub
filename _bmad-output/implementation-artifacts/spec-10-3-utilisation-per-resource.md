---
title: 'Utilisation per Resource'
type: 'feature'
created: '2026-11-26'
status: 'done'
baseline_revision: '5795452885fd91469ccec587463f00e7e3583628'
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-10-context.md'
  - '{project-root}/docs/hub-api-contract.md'
warnings: ['oversized']
deferred:
  - summary: >-
      A cached utilisation source resumes from {month, offset} and never looks back, so bytes appended later to an EARLIER month file than the cached position are never folded.
    evidence: |-
      tools/hub-api/utilisation.mjs advance() opens openReader at the stored position; the host-agent push (tools/host-agent/push.mjs pick()) sends the oldest differing month first, so in normal flow an earlier month is complete before a later one starts. The open case is a month the agent skipped (HUB_AGENT_REPLICA_SKIPPED: HUB_EVENT_OFFSET or HUB_EVENT_NOT_UTF8) that is pushed later, after the cache moved into a newer month. Settle it with a test: cache a replica at month M, then append to month M-1, and check whether the next /utilisation answer includes the M-1 events; if not, rebuild a host whose earlier months' sizes changed.
    location: >-
      tools/hub-api/utilisation.mjs:26
    severity: medium (unverified)
---

<intent-contract>

## Intent

**Problem:** v1c has to show whether a device is the bottleneck, but nothing says how a Resource spent a window: the Event Logs and the Mac replica hold the facts, and no function or route folds them into held / idle-while-reserved / idle / away / unknown shares (FR-18, AD-40, addendum B.7).

**Approach:** A pure `utilisation(events, registry, lockToResource, window, options)` in `tools/registry/history.mjs`, built from an incremental fold (`createTimeline`/`foldEvent`) and a share computation (`sharesOf`) over the folded timeline. `GET /utilisation?from&to` keeps one folded timeline per host source (this host's log, each peer's replica) in memory, advances it only over the bytes appended since its last position, reuses /history's peer-coverage step (sync, `synced_through`, `partial`), and answers per-Resource shares plus per-slot emulator rows rolled up to the Pool. Everything is keyed by host key and lock, so any further host, phone or `res-*` Resource is covered with no new code.

## Boundaries & Constraints

**Always:**
- Pure logic (no fs, no clock, no network) in `tools/registry/history.mjs`; I/O and the cache in `tools/hub-api/utilisation.mjs`.
- Classification of each instant, in this precedence: after the Resource's host's `synced_through` → `unknown`; a Hold covers it → `held`; a Reservation covers it → `idle_while_reserved`; else the Reachability reading in force: `reachable` → `idle`, `unknown`/none/expired → `unknown`, any other state (`absent`, `offline`, `unauthorized`, …) → `away`. An emulator slot has no readings: its free time is `idle`.
- A `track` reading (`reason: track`) holds until the Resource's next `reachability` event; any other reason is a probe and holds until `checked_at + reachability_max_age_s`, then `unknown`. `track-lost` (`to: unknown`) is unknown until the next reading. Time before a Resource's first reading is `unknown`.
- Holds are folded per lock: `acquire` opens; `release`/`force-release`/`reclaim` (hold_kind not `reservation`) close at `min(ts, start + held_ms)` (a reclaimed dead Lease ends where `held_ms` says); a close with no open Hold and a finite `held_ms` back-fills `[ts - held_ms, ts)`; `extend` moves an open Lease's `expires_at`; an open Hold counts until `min(window end, expires_at)`. Reservations per `(lock, run_key)`: `claim` opens until its `expires_at`; `release`/`expiry`/`force-release` with `hold_kind: reservation` close at `min(ts, expires_at)`; a close with no open claim back-fills from its `reserved_at`. The `emulator` gate lock is ignored; `emulator-<n>` locks are slots.
- A lock's Resource is `lockToResource(lock)` (the 10.2 map, so v1a events without `resource` attribute correctly); readings attribute by the event's `resource`.
- The endpoint never walks the whole log per request: each host's cache resumes from its stored `{month, offset}`; only a vanished position (`bad-cursor`/`HUB_EVENT_OFFSET`) rebuilds that host from offset 0. Refreshes of one host are serialized; reads yield every 256 KiB chunk (reuse `openReader`).
- The peer coverage step is factored out of `queryHistory` into one exported function both routes call; /history's behaviour and answers are unchanged.
- Contract additive only (no bump); doc and contract test stay equal. Rows carry `id`, `name`, `kind`, `host` only — no identity, serial or udid.

**Never:** the Capacity Estimate or `/capacity` (v1c); a contract freeze or leak sweep (10.4); a timer, poll or on-disk aggregate; writing any event file or replica; a second event reader; rounding shares; Python.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Empty history | no logs, `from=T-1h` | every Resource all `unknown` (slots all `idle`); `partial` per coverage | none |
| Sparse | one probe `reachable` at T-30m, max age 60 s | 60 s `idle`, the rest `unknown` | none |
| Rich | track readings, a Lease, a deploy job, a Reservation, an extend, a reclaim, two slots | ms per class match a hand-computed table; shares = ms / span | none |
| v1a event | `acquire`/`release` on `adb` with no `resource` | counted as `s26` `held` | none |
| Mac gap | ios-lane Lease open, Mac sync throws AWAY, replica last line at T-2h | ios-lane `held` until its `synced_through`, `unknown` after; `partial: true` | peer marked as in 10.2 |
| track-lost | track `reachable`, then `track-lost` | `idle` then `unknown` | none |
| Cache | two requests, a line appended between | second answer includes it; the first-read bytes are not read again | none |
| Bad query | unknown/repeated/empty key; missing or bad `from`; bad `to`; `from` ≥ effective `to` | 400 `HUB_USAGE` `bad-query` / `bad-range` | nothing read |
| Unknown host key | `hostKey()` throws | 503 `HUB_HOST_UNKNOWN` | none |

</intent-contract>

## Code Map

- `tools/registry/history.mjs` -- add `parseUtilisationQuery(params, {at})` (keys `from` (required) and `to` only; `to` defaults to and is clipped to `at`; reuse `timeOf`/`usage`), `UTILISATION_CLASSES = ['held','idle_while_reserved','idle','away','unknown']`, `createTimeline()`, `foldEvent(timeline, event)`, `sharesOf(timeline, registry, lockToResource, window, {maxAgeS, syncedThrough, slots})`, `utilisation(events, registry, lockToResource, window, options)` = fold all then `sharesOf`. `lockToResource` (:101) and `resourceOf` exist; `EMULATOR_POOL`, the slot shape `/^emulator-\d+$/`.
- `tools/hub-api/history.mjs:191` -- extract step 1 of `queryHistory` (:197-214) into exported `coverPeers({own, env, windowEnd, at, peers, replicas, history, transport, now, signal, contact, failure, log})` → `{through, partial, spokes}`; `queryHistory` calls it. `openReader` (:53) is the reader to reuse (start = cached position; it throws `bad-cursor` for a vanished month/offset).
- `tools/hub-api/utilisation.mjs` (new) -- `createUtilisation()` → `{sources: Map<host, {position, timeline}>, chains: Map}`; `refreshSource(...)`; `queryUtilisation({query, own, env, registry, hostId, now, signal, peers, replicas, history, transport, contact, failure, log, policy, cache, poolSize})`.
- `tools/hub-api/routes.mjs:300` -- `utilisationRoute` beside `historyRoute` (same host-key 503, same callbacks), a `utilisationOf` WeakMap fallback, a `ROUTES` row `{GET, /utilisation, shape: 'Utilisation'}` after `/history`. Resource set: records with `retirement(record) === null` (match.mjs:72) or `retired_at` ≥ `from`. Pool size: `emulatorPool(env, {service: true})` (claims.mjs:502); a throw falls back to the slots seen, one `HUB_API_UTILISATION_POOL` log line.
- `tools/hub-api/server.mjs:245` -- ctx `utilisation: createUtilisation()`, comment clause.
- `tools/ci/lib/lock.mjs:155` -- event bodies (read-only): `eventOf` fields `lock, resource, hold_kind, lease_id, expires_at, held_ms`; reservation fields `run_key, reserved_at, expires_at` (:856); `noteReachability` (:254) `{resource, from, to, checked_at, reason}`; readings reasons are `track`, `probe`, `track-lost` (hub-api/readings.mjs:73,112,121).
- `docs/hub-api-contract.md` -- route row `| GET | /utilisation | Utilisation | 10.3 |`, `### Utilisation` section, `HUB_USAGE` names `GET /utilisation` (`bad-query`, `bad-range`), `HUB_HOST_UNKNOWN` names it.
- `tools/hub-api/contract.test.mjs:238` -- `GET_SAMPLES['/utilisation']` with `query: 'from=…'` (callGet appends `sample.query`), `prepare: prepareHistory, after: afterHistory`; add `/utilisation` to the Hold-route exclusion list (:490).

## Tasks & Acceptance

**Execution:**
- `tools/registry/history.mjs` -- the pure fold, shares and query check.
- `tools/registry/utilisation.test.mjs` (new) -- the fixture table: empty, sparse, rich, v1a event, Mac gap, track-lost, probe expiry, slot rollup, back-filled closes, the query 400s.
- `tools/hub-api/history.mjs` -- extract `coverPeers`.
- `tools/hub-api/utilisation.mjs` -- the cache and `queryUtilisation`.
- `tools/hub-api/routes.mjs`, `tools/hub-api/server.mjs` -- the route and ctx.
- `tools/hub-api/utilisation.test.mjs` (new) -- through `handle()` on temp dirs: shape, both hosts, Mac gap partial, cache resumes (spy the reader position / count bytes read), rebuild after a vanished position, 400s, 503.
- `docs/hub-api-contract.md`, `tools/hub-api/contract.test.mjs` -- the contract.

**Acceptance Criteria:**
- Given `utilisation(events, registry, lockToResource, window)`, when called, then it is pure and returns per-Resource `held`, `idle_while_reserved`, `idle`, `away`, `unknown` ms and shares, attributing lock-only v1a events through the map.
- Given readings, when walked, then track holds until the next event, probe until `checked_at + reachability_max_age_s`, and time before the first reading or after expiry is `unknown`.
- Given the emulator Pool, when computed, then each `emulator-<n>` slot has a row and the Pool's row is their sum over `slots × window`.
- Given `GET /utilisation?from&to`, when called twice, then it answers `Utilisation` from the per-host cached timelines, reading only bytes appended since the previous request.
- Given the contract doc and test, when this lands, then both include `/utilisation`, `/history` answers are unchanged, and `mise run check` is green.

## Spec Change Log

## Review Triage Log

### 2026-11-26 — Review pass
- verdicts: 32 findings — high 0, medium 2, low 17, false 12, maybe-false 1
- findings:
  - `[low]` `[reject]` Blind: per-request CPU is not bounded by the window (mergeTimelines copies and classify scans all folded intervals) — real, but the I/O is incremental as the AC asks, and hub volume is a few thousand events a month; pruning or indexing adds complexity for a cost nobody meets in everyday use.
  - `[false]` `[reject]` Blind: an open job Hold with no logged release counts as held forever — lock.mjs logs a `reclaim` (with held_ms to the reclaim) when a stale job lock is retired (lock.mjs:317,400); until then the lock really is held on disk, so the fold matches the lock state.
  - `[false]` `[reject]` Blind: Holds keyed by lock, not lease_id, so a stale release/reclaim cuts a newer Hold — releaseLease refuses a lease_id that is not the owner's (lock.mjs:569) and reclaim retires the current owner, so every logged close names the open Hold.
  - `[false]` `[reject]` Blind: cache invalidation only detects a shrinking log; a rewritten log that regrows is folded from the wrong place — the Event Log is append-only and a replica is a byte-for-byte mirror of it (replica.mjs only cuts a torn tail or a failed write back to its prior size, and re-pushes identical bytes), so any byte at a read offset never changes.
  - `[low]` `[reject]` Blind: time after a Resource's retirement inside the window is still classified — real, but retirement is rare and the post-retirement time reads as unknown/away, which is not false; clipping the span changes the row's semantics for an edge nobody meets day to day.
  - `[low]` `[reject]` Blind: a pool-size failure is invisible to the caller — the spec chose the fallback plus one HUB_API_UTILISATION_POOL line; only a malformed pool env var triggers it, and flagging it in the answer adds public surface.
  - `[low]` `[reject]` Blind: client abort is not passed into the refresh, so a cold rebuild runs after a disconnect — the rebuild result is cached and reused by the next request, so the work is not wasted; one cold fold per service restart.
  - `[low]` `[reject]` Blind: a refresh that fails part-way discards the host's whole fold — real, but only a non-vanished read error (rare) triggers it, the rebuild is correct, and per-chunk commit adds complexity.
  - `[low]` `[patch]` Blind: thin coverage where the code is subtle — patched: checked_at clamp/out-of-order re-sort, warm-cache serialization and the non-vanished error branch now have tests (see the VG rows); the remaining parts were rejected: lease_id mismatch is false (row above), the chunk boundary is covered by openReader's 10.2 tests, and the contract sample checks shape only by design.
  - `[false]` `[reject]` Blind: an unrelated flaky-test fix is bundled in, and coverPeers has no own test — the host-agent fix is its own commit (bc1615f), named in this result; coverPeers is exercised unchanged by the whole /history suite, which stayed green.
  - `[false]` `[reject]` Edge: a release/reclaim with a different lease_id truncates the new Hold — same refutation as the Blind lease_id row (lock.mjs:569).
  - `[false]` `[reject]` Edge: a close with held_ms null after expires_at overcounts — lock.mjs writes held_ms on every close (lock.mjs:322, capped at expires_at per :177), so a real close never has held_ms null.
  - `[false]` `[reject]` Edge: a replaced file at least as long as the offset corrupts the cached fold — same refutation as the Blind rewritten-log row (append-only source, byte-for-byte replica).
  - `[maybe-false]` `[defer]` Edge: a replica that gains bytes in an earlier month after the cache moved to a later one never folds them — push.mjs pushes the oldest differing month first, so normal flow cannot reach it; a skipped month pushed later might. Settle with a test that appends to month M-1 after caching at M (deferred, medium unverified).
  - `[low]` `[reject]` Edge: an aborted request still folds the whole log — same as the Blind abort row: the fold is cached and reused.
  - `[low]` `[patch]` Edge: registry() is read after coverPeers, so a broken Registry still costs a peer sync — patched: `registry()` now runs right after the query check, before coverPeers.
  - `[low]` `[reject]` Edge: memory and per-request CPU grow with all history — same root as the Blind per-request-cost row.
  - `[low]` `[reject]` Edge: a Resource retired inside the window is classified past retired_at — same root as the Blind retirement row.
  - `[low]` `[patch]` Edge: mergeTimelines drops a second host's open Hold or claim on a shared key — patched: a colliding open Hold joins out.held as [start, expires] and a colliding claim joins out.reserved as [start, end]; test added.
  - `[false]` `[reject]` Edge: a Resource host missing from syncedThrough is treated as unlimited — coverPeers sets through for every HOST_KEYS host (own = at), and a host outside HOST_KEYS has no log folded at all, so its time is unknown anyway (no readings).
  - `[false]` `[reject]` Edge (claim): a close with held_ms null ignores expires_at — same refutation as the held_ms row: lock.mjs never writes a close without held_ms.
  - `[low]` `[reject]` Edge (claim): any non-vanished read error forces a full re-fold — same root as the Blind part-way-failure row; correct behaviour, rare trigger.
  - `[medium]` `[patch]` VG: foldReading's checked_at clamp and out-of-order re-sort are unverified — patched: test with a probe logged at T-30m taken at T-31m, a checked_at after ts, and two readings logged in reverse checked_at order, with exact ms asserted.
  - `[medium]` `[patch]` VG: the route's reachability_max_age_s wiring is unobserved — patched: route test with a policy clone at 600 s and one probe reading asserts exactly 600 000 ms idle.
  - `[low]` `[patch]` VG: the serialized-per-host test does not observe serialization — patched: warm-cache test (one request, append, two concurrent requests) asserts each appended Hold interval is folded once; mutation-checked: removing the chain fails it.
  - `[low]` `[patch]` VG other: advance's non-vanished error branch and abort checks are untested — patched the error branch (month file replaced by a directory: 500, host forgotten, next request answers full history); the abort checks are trivial guards, left as is.
  - `[low]` `[reject]` VG other: mergeTimelines/classify walk all history per request — same root as the Blind per-request-cost row.
  - `[low]` `[reject]` VG other: a seed_missing record with no retired_at is hidden even if held in the window — this is the spec's and the contract's rule ("live, or retired at or after from"); seed_missing is rare.
  - `[low]` `[patch]` Intent: the route never calls utilisation() and no test ties the two — patched: a route test over a mixed event set deep-equals the pure utilisation() over the same events.
  - `[false]` `[reject]` Intent: `unknown` past synced_through and the `away` definition go beyond the story text — the story leaves away undefined and unknown "time we cannot know"; the intent contract (Mac gap row) settles both, and no story AC is contradicted.
  - `[false]` `[reject]` Intent: extras (options argument, partial/slots/synced_through fields, contract doc edits) — additive: the four-argument call still works (options defaults), and the contract doc must change with the route because contract.test.mjs holds them equal.
  - `[false]` `[reject]` Intent: the operator-action reading — no AC needs a human outside the repo, so no operator_actions; the run ends `done`.

### 2026-11-26 — Review pass (follow-up)
- verdicts: 31 findings — high 0, medium 1, low 21, false 8, maybe-false 1
- findings:
  - `[low]` `[reject]` Blind: cost grows with all history (first fold reads every month; merge and classify walk every interval; nothing is pruned) — carried: same as the first pass's per-request-cost row; the I/O is incremental and hub volume is small.
  - `[false]` `[reject]` Blind: a log rewritten to the same or a larger size is not detected — carried: the Event Log is append-only and a replica mirrors it byte for byte.
  - `[low]` `[patch]` Blind: the contract's Classes table says `unknown` is checked first, including "no reading", but a Hold or Reservation with no reading reads `held`/`idle_while_reserved` — patched: docs/hub-api-contract.md now splits `unknown` into a first row (not synced) and a last row (no reading), and the note says a Hold or Reservation wins over having no reading.
  - `[false]` `[reject]` Blind: emulator slots, and time before a host's log began, read `idle` while phones read `unknown` — the intent contract says "an emulator slot has no readings: its free time is `idle`", and this host's `synced_through` is the request time by the 10.2 coverage rule.
  - `[low]` `[reject]` Blind: time after a Resource's retirement inside the window is still classified, and a seed-missing record is hidden — carried: same as the first pass's retirement and seed_missing rows.
  - `[false]` `[reject]` Blind: a `track` reading holds forever if the tracker dies without a `track-lost`, and an open job Hold has no expiry — the intent contract says a track reading holds until the Resource's next reachability event; the open job Hold half is carried from the first pass (lock.mjs logs a `reclaim` when it retires a stale job lock).
  - `[false]` `[reject]` Blind: Hold closes are not matched by lease_id, so a late reclaim/force-release for lease A closes B's Hold — carried: releaseLease refuses a lease_id that is not the owner's and reclaim retires the current owner (lock.mjs:569); the append-order variant is the Intent row below.
  - `[low]` `[reject]` Blind: `advance` folds the cached timeline in place, so a request waiting on another host can read events newer than its own `at` — real, but the fold is synchronous per chunk (a consistent prefix), events after `to` are clipped by the window, and a Mac event past `synced_through` reads `unknown` anyway; copy-and-swap adds complexity for an answer no worse than one taken a moment later.
  - `[low]` `[reject]` Blind: the abort signal is not passed into the refresh — carried: the fold is cached and reused by the next request.
  - `[low]` `[reject]` Blind: untested chunk boundary, replica torn tail, partial for an older replica with a successful sync, the abort path, HUB_REGISTRY_FORMAT from registry() — test gaps, no defect shown; openReader's chunking is covered by history.test.mjs (chunkBytes 8192) and the coverage step by the /history suite.
  - `[low]` `[reject]` Blind: `DEFAULT_MAX_AGE_S = 60` duplicates a policy value as a fallback — policy.mjs:310-311 requires `registry.reachability_max_age_s` (strict, positive), so the route's fallback never applies in service; the pure function's option default is documented.
  - `[low]` `[reject]` Blind: the contract leaves out the VALUE_MAX `bad-query`, HUB_REGISTRY_FORMAT for /utilisation, the HUB_API_UTILISATION_POOL line and the pool-less slot fallback — the HUB_REGISTRY_FORMAT row names no routes (it applies to any Registry read); the over-length refusal is worded the same as /history's; the log line and the fallback are internal; cosmetic.
  - `[low]` `[reject]` Blind: a bad Pool file logs HUB_API_UTILISATION_POOL on every request — only a malformed Pool size triggers it (hostPool refuses outside 1 to 8), and one line per request is the visible signal the spec chose.
  - `[low]` `[reject]` Edge: one host's refresh throwing makes the whole answer 500 — the intended, tested behaviour from the first pass (month file replaced by a directory: 500, host forgotten, next request rebuilds); only a non-vanished read error triggers it, and a partial answer would add branches.
  - `[maybe-false]` `[defer]` Edge: bytes appended to an earlier month than the cached position are never folded — carried: already in the deferred list (medium, unverified); not deferred again.
  - `[false]` `[reject]` Edge: a huge Pool size builds millions of slot rows — emulatorPool goes through hostPool, which refuses a pool outside 1 to MAX_POOL (8) (emulator.mjs:79), and the route then falls back to the slots seen.
  - `[low]` `[reject]` Edge: an emulator Pool retired before `from` leaves slots[] pointing at a Resource absent from resources[] — the Pool is a runtime Resource that is not retired in practice, and the slot rows then name `emulator`, its id.
  - `[low]` `[reject]` Edge: readings lists are never pruned — carried: same as the first pass's memory/per-request-cost row.
  - `[false]` `[reject]` Edge: a claim with an unparsable expires_at stays open forever — readReservation (lock.mjs:823-834) refuses a record without a finite expires_at, so every logged claim carries one.
  - `[low]` `[reject]` Edge: per-request CPU scales with all history — carried: same root as the per-request-cost row.
  - `[low]` `[reject]` Edge (claim): any non-vanished read error forces a full re-fold — carried: correct behaviour, rare trigger.
  - `[low]` `[reject]` Edge (claim): "never walks the whole log per request" holds for I/O only — carried: same root as the per-request-cost row.
  - `[low]` `[patch]` VG: a seed-missing record's exclusion is not pinned by a test — patched: the retired-resources test in tools/registry/utilisation.test.mjs now includes a `seed_missing: true` record with no retired_at and asserts it has no row.
  - `[low]` `[reject]` VG: the abort path of /utilisation is untested — server.mjs:100 already drops an answer once its signal aborted, so no client sees a difference; /history has the same untested guard.
  - `[medium]` `[patch]` Intent: the route folds in log order while utilisation() sorts by ts, and they disagree when a lock's events are out of ts order — verified: retire() in lock.mjs removes the lock (rmSync) before it logs the close, so the next holder's `acquire` can be appended first; folding `acquire B`, then `release A` closed B's open Hold at a time before its start, which dropped B's whole Hold (read as idle). Patched: foldHold only lets a close end the open Hold when `ts >= open.start`; an older close back-fills its own held_ms instead. Test added; mutation-checked (reverting the guard fails it).
  - `[low]` `[patch]` Intent: a reclaim of an unreadable owner is logged with `hold_kind: null` (lock.mjs:164) and the fold ignored it, so the open Hold stayed open, a job's to the window's end — the intent says a close with hold_kind not `reservation` ends the Hold. Patched: foldEvent passes a release/reclaim/force-release with a null or missing hold_kind to foldHold. Test added; mutation-checked.
  - `[false]` `[reject]` Intent: readings follow the time they were taken, not log order — the intent's probe rule runs from `checked_at`, so taken-time is the intent's own clock; the first pass tested this on purpose.
  - `[low]` `[reject]` Intent: "any further host" holds only while lock names stay unique and there is one emulator Pool — lock names come from the one Registry, which keys Resources and locks uniquely; a second Pool is not in v1 scope.
  - `[low]` `[reject]` Intent: matrix rows not asserted at the route (the peer mark, empty history with a successful sync, chunking, a /history regression) — coverPeers is the unchanged /history step whose own suite asserts the mark; the rest are covered at the pure surface or by openReader's tests.
  - `[low]` `[reject]` Intent: memory is unbounded — carried: same root as the per-request-cost row.
  - `[false]` `[reject]` Intent: an unrelated host-agent test change is bundled — carried: its own commit (bc1615f).

## Design Notes

Shape of the answer (all ms integers; shares unrounded `ms / span_ms`):

```
{format:1, from, to, window_ms,
 resources:[{id:'s26', name:'s26', kind:'phone', host:'linux', span_ms, ms:{held,idle_while_reserved,idle,away,unknown}, shares:{…same keys}}],
 slots:[{resource:'emulator', slot:'emulator-1', span_ms, ms:{…}, shares:{…}}],
 partial, synced_through:{linux, mac}, checked_at}
```

The `emulator` Resource row is the rollup (`span_ms = window_ms × slot count`). Share computation sweeps the sorted breakpoints of the window (holds, reservations, readings, probe expiries, `synced_through`) and classifies each elementary interval at its start; only intervals overlapping the window are considered.

## Verification

**Commands:**
- `node --test tools/registry/utilisation.test.mjs tools/hub-api/utilisation.test.mjs tools/hub-api/history.test.mjs tools/registry/history.test.mjs tools/hub-api/contract.test.mjs` -- expected: all pass
- `heavy mise run check` -- expected: green


## Auto Run Result

Status: done

**Summary.** The Hub API answers `GET /utilisation?from&to`: for each Resource, how much of the window it spent `held`, `idle_while_reserved`, `idle`, `away` and `unknown`, as whole ms plus unrounded shares, with per-slot emulator rows rolled up into the Pool's row. The pure `utilisation(events, registry, lockToResource, window, options)` in `tools/registry/history.mjs` is built from the incremental fold (`createTimeline`/`foldEvent`/`mergeTimelines`) and `sharesOf`; the route keeps one folded timeline per host source in memory, advances it from its cached `{month, offset}`, and shares /history's peer-coverage step (`coverPeers`). Keyed by host key and lock, so any further host, phone or `res-*` Resource is covered with no new code. This follow-up review pass fixed two fold rules that real logs reach: a close that lock.mjs appends after the next holder's `acquire` no longer drops the new Hold, and a reclaim of an unreadable owner (`hold_kind: null`) now ends the open Hold.

**Files changed (story).**
- `tools/registry/history.mjs`: query check, the fold, `mergeTimelines`, `shownInWindow`, the classification sweep, `sharesOf`, `utilisation`. This pass: `foldHold` lets a close end the open Hold only when `ts >= open.start`; `foldEvent` routes a close with a null/missing `hold_kind` to `foldHold`.
- `tools/hub-api/history.mjs`: `coverPeers` extracted from `queryHistory` (answers unchanged); `abortError` exported.
- `tools/hub-api/utilisation.mjs` (new): the in-memory per-host cache, serialized refreshes, `queryUtilisation`.
- `tools/hub-api/routes.mjs`, `tools/hub-api/server.mjs`: the `/utilisation` route and its ctx cache.
- `docs/hub-api-contract.md`, `tools/hub-api/contract.test.mjs`: the route row, the `Utilisation` shape and error rows. This pass: the Classes table now shows the real precedence (`unknown` for "not synced" first, `unknown` for "no reading" last).
- `tools/registry/utilisation.test.mjs`, `tools/hub-api/utilisation.test.mjs` (new): the fixture matrix and the route, cache and error paths. This pass: a test for the raced close and the null-kind reclaim, and a seed-missing record in the retired-resources test.
- `tools/host-agent/server.test.mjs`: a flaky wait bound fixed in its own commit (bc1615f).

**Review findings (follow-up pass).** 31 findings: high 0, medium 1, low 21, false 8, maybe-false 1.
- Patches applied, by verdict: medium 1 (the raced close dropping a Hold), low 3 (null-kind reclaim, the contract's class order, the seed-missing test).
- Deferred: none new. The earlier-month append case is carried in the existing deferred entry, not deferred again.
- Rejected false, 8: rewritten log (append-only source); slots idle before the log (the intent's rule); track reading with no track-lost (the intent's rule); lease_id matching (lock.mjs:569); a huge Pool (hostPool caps at 8); a claim with no expires_at (readReservation refuses it); readings by taken-time (the intent's clock); the bundled test fix (its own commit).
- Rejected low, 18: per-request CPU and memory over all history (×5, carried); retirement and seed_missing rows (carried); the in-place fold read by a waiting request (clipped by the window, no worse than a later answer); abort not passed into the refresh (carried); test gaps without a defect (×2); the dead `DEFAULT_MAX_AGE_S` fallback (policy.mjs requires the key); contract wording omissions (cosmetic); the Pool log line per request; one host's read error making a 500 (intended, tested); a retired Pool's orphan slots; the untested abort guard (server.mjs drops aborted answers); a non-vanished error re-fold (carried); lock-name uniqueness for further hosts.
- The full per-finding record is the second entry of `## Review Triage Log`; the first pass's record (32 findings, patched in 9d7ad76) is the first entry.

**Follow-up review: not recommended (`false`).** This is a follow-up pass and it patched no `high`; patched counts: high 0, medium 1, low 3.

**Verification.**
- Focused: `node --test tools/registry/utilisation.test.mjs tools/hub-api/utilisation.test.mjs tools/hub-api/history.test.mjs tools/registry/history.test.mjs tools/hub-api/contract.test.mjs`: 90/90 pass.
- Mutation checks: removing the `ts >= open.start` guard, or the null-kind close routing, each fails the new test (16 pass, 1 fail).
- `heavy mise run check`: green, 1990/1990, exit 0.

**Residual risks.**
- The cache is in memory: the first request after a restart folds each host's whole history once, and per-request CPU grows with the intervals folded over the service's life.
- In the raced-close case the previous Hold reads as held until the next holder's acquire (milliseconds later than its real end), not until its own release.
- The ios-lane's reachability is never logged, so its free time reads `unknown`.
- The deferred earlier-month append case (medium, unverified).
