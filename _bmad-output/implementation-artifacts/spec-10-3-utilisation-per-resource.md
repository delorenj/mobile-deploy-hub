---
title: 'Utilisation per Resource'
type: 'feature'
created: '2026-11-26'
status: 'done'
baseline_revision: '5795452885fd91469ccec587463f00e7e3583628'
review_loop_iteration: 0
followup_review_recommended: true
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

**Summary.** The Hub API now answers `GET /utilisation?from&to`: for each Resource, how much of the window it spent `held`, `idle_while_reserved`, `idle`, `away` and `unknown`, as integer ms plus unrounded shares. Emulator slots get their own rows and roll up into the Pool's row. The pure `utilisation(events, registry, lockToResource, window, options)` in `tools/registry/history.mjs` is built from an incremental fold (`createTimeline`/`foldEvent`) and `sharesOf`. The route keeps one folded timeline per host source (this host's log, each peer's replica) in memory and advances each from its cached `{month, offset}`, so a request reads only newly appended bytes. It reuses /history's peer-coverage step (`coverPeers`, now shared), so a Mac gap reads `unknown` past its `synced_through` with `partial: true`. Everything is keyed by host key and lock, so any further host, phone or `res-*` Resource is covered with no new code.

**Files changed.**
- `tools/registry/history.mjs`: `parseUtilisationQuery`, `UTILISATION_CLASSES`, the fold (`createTimeline`, `foldEvent`, `mergeTimelines`), `shownInWindow`, the classification sweep, `sharesOf` and `utilisation`.
- `tools/hub-api/history.mjs`: `coverPeers` extracted from `queryHistory` (answers unchanged); `abortError` exported.
- `tools/hub-api/utilisation.mjs` (new): the in-memory per-host cache, serialized refreshes, and `queryUtilisation`.
- `tools/hub-api/routes.mjs`, `tools/hub-api/server.mjs`: the `/utilisation` route and its ctx cache.
- `docs/hub-api-contract.md`, `tools/hub-api/contract.test.mjs`: the route row, the `Utilisation` shape, and the `HUB_USAGE`/`HUB_HOST_UNKNOWN` rows, held equal by the contract test.
- `tools/registry/utilisation.test.mjs`, `tools/hub-api/utilisation.test.mjs` (new): the fixture matrix (pure) and the route, cache and error paths (through `handle()`).
- `tools/host-agent/server.test.mjs`: a flaky wait bound fixed (commit bc1615f): it now uses a 10 s wall-clock deadline, not 500 loop turns.

**Review findings.** 32 findings: high 0, medium 2, low 17, false 12, maybe-false 1.
- Patches applied (commit 9d7ad76), counted by verdict: medium 2 and low 7.
  - Code: `mergeTimelines` keeps a second host's open Hold or claim on a shared key, and `registry()` is now read before the peer sync.
  - Tests: the checked_at clamp and re-sort, the route's max-age wiring, warm-cache serialization (mutation-checked), the non-vanished error branch, and the route matching the pure function.
- Deferred, 1: an earlier-month append after the cache moved on (medium, unverified).
- Rejected false, 12:
  - Holds by lease_id, open job Holds, and held_ms null (×2): lock.mjs always names the owner and writes held_ms.
  - A rewritten log (×2): the source is append-only and the replica mirrors it byte for byte.
  - The bundled test fix: its own commit.
  - A host missing from syncedThrough: a host outside HOST_KEYS has nothing folded.
  - Intent extras and semantics (×3) and the operator-action reading (×1): see the triage log.
- Rejected low, 10:
  - Per-request CPU over all history (×3): the I/O is incremental, and the volume is small.
  - Retired-in-window time (×2): rare, and it reads unknown or away.
  - The pool-size fallback: as specified.
  - Abort during a cold fold (×2): the result is cached and reused.
  - A part-way failure forcing a full re-fold (×2): rare and correct.
  - seed_missing hidden: the contract's rule.

**Follow-up review: recommended (`true`).** Two medium entries were patched. The unverified risk is the `mergeTimelines` collision change and the registry read-order change in `queryUtilisation`: both were patched after review and have not been through a review layer, only their own new tests and the full suite.

**Verification.**
- The focused tests pass: `node --test tools/registry/utilisation.test.mjs tools/hub-api/utilisation.test.mjs tools/hub-api/history.test.mjs tools/registry/history.test.mjs tools/hub-api/contract.test.mjs` gives 89/89.
- `heavy mise run check` is green after the patches, 1989/1989, exit 0.
- Mutation check: removing the per-host refresh chain fails the new warm-cache test.
- Earlier runs:
  - Twice, the full check failed on `tools/host-agent/server.test.mjs:515`. It was bounded by loop turns under load, which bc1615f fixed.
  - Once, it failed on `tools/host-agent/push.test.mjs:420`. That flake predates this story and passed 3/3 in isolation.

**Residual risks.**
- The cache is in memory, so the first request after a service restart folds each host's whole history once.
- Per-request CPU grows with the intervals folded over the service's life.
- The ios-lane's reachability is never logged, so its free time reads `unknown`. That is correct for the data but not useful until a reading source exists.
- The deferred earlier-month append case.
