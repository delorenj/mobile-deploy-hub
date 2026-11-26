---
title: 'Query history across both hosts'
type: 'feature'
created: '2026-11-26'
status: 'done'
baseline_revision: 'b719185241664c1e62b782631f788fd3d6872579'
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-10-context.md'
  - '{project-root}/docs/hub-api-contract.md'
warnings: ['oversized']
deferred: []
---

<intent-contract>

## Intent

**Problem:** Story 10.1 fills `replicas/<host>/<YYYY-MM>.jsonl` with the Mac's Event Log, but nothing reads it: there is no route that answers "who held what" over both hosts, and no answer says when the Mac's part may be missing (FR-18, UJ-4, AD-40).

**Approach:** Add `GET /history?resource&pool&claimant&repo&from&to&cursor&limit` to the Hub API. It reads this host's log and every peer host's replica with `readEventsFrom`, filters, merges per-host streams by `ts` for display and pages with an opaque per-host cursor `{<host key>: "<month>/<offset>"}`. When a peer's replica may lack the window, it first calls that host's `POST /agent/sync` with the replica sizes. If the replica still cannot be shown to cover the window, the answer is `partial: true`, with `synced_through` per host and `unreachable_ranges` taken from `host-reachability` events. Everything is keyed by host key, so any peer host in `HOST_KEYS` is covered with no new code.

## Boundaries & Constraints

**Always:**
- Pure logic lives in `tools/registry/history.mjs` (no fs, no clock, no network): the filter, the lock→resource map, the cursor codec, the merge pick and the unreachable-range derivation. 10.3's `utilisation` will go in the same file. I/O lives in `tools/hub-api/history.mjs`.
- Reads only. `/history` never writes, truncates or deletes an event file or a replica. Its only side effects are what a peer call already does: a peer mark or a `host-reachability` event through `noteContact`/`noteFailure` (Story 9.6), and the agent's own pushes.
- Order is total per host: month, then offset. Across hosts, entries are merged by `ts` (ties go by host key order; a missing ts sorts first). The answer carries `cross_host_order: 'display-only'`, and the doc says consumers never derive a cross-host order from it.
- A `/agent/sync` call goes through hub-client's `forward()` over `transportOf(ctx)`, behind `peers.gate`. The replica sizes are read under `replicas.exclusive(host)`, but the call itself is never made under it, because the agent's pushes need it. A test always injects `ctx.request`.
- The window end is `to`, or the request's receipt time `at` when there is no `to`. A host's `synced_through` is the latest of two times: the send time of a `/agent/sync` that answered `synced: true` (kept in memory per service), and the `ts` of the replica's last complete line (rebuilt from disk). This host's own `synced_through` is `at`. `partial` is true iff some peer's `synced_through` is null or before the window end.
- Event reads yield to the event loop (`setImmediate`) between `readEventsFrom` chunks of 256 KiB.
- The contract is additive only (no bump). Doc and tests stay equal.

**Never:** utilisation or `/utilisation` (10.3); a contract freeze or leak sweep (10.4); compaction, deletion or a retention limit; a cross-host total order; a timer, poll or cached aggregate; an on-disk proof store; writing `replicas/` (replica.mjs stays its only writer); Python.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Both hosts, no filter | linux log + mac replica, Mac answers sync `synced: true` | every event once, `{id, host, event}`, merged by ts; `partial: false`, `unreachable_ranges: []` | none |
| Filters | `resource=s26` (v1a `lock: adb` without `resource` matches), `pool=phone`, `claimant=agent` or a holder, `repo=o/a` (claimant or delivery repo) | only matching events (filters are ANDed) | none |
| Paging | `limit=2` over 5 events | `more: true`, then a `cursor` page; all pages together = the full set, no duplicates | none |
| Mac asleep | the sync throws `HUB_DEVICE_AWAY`, or the host is marked and the gate fails fast | `partial: true`, `synced_through.mac` (null or ISO), the ranges clipped to `[max(from, synced_through), window end)` | the peer is marked (one `host-reachability` event) |
| Asleep but synced later | `unreachable → reachable` in the past, replica last ts after it | not partial; no range | none |
| Past window, replica covers it | `to` ≤ replica last ts | no sync call | none |
| Bad query | an unknown, repeated or empty key; bad `from`/`to`, `from > to`; a bad cursor; `limit` not 1..1000 | 400 `HUB_USAGE`, `bad-query` / `bad-range` / `bad-cursor` / `bad-limit` | nothing read |
| Unknown host key | `hostKey()` throws | 503 `HUB_HOST_UNKNOWN` | none |

</intent-contract>

## Code Map

- `tools/hub-api/routes.mjs:554` -- `ROUTES`. Add `{GET, /history, shape: 'History', handler: historyRoute}` after `/stream`. `historyRoute(ctx, {query, signal})` resolves the own key (503 `HOST_UNKNOWN`, as in `statusDocument`:226), then calls `queryHistory` with `peersOf(ctx)`, `replicasOf(ctx)`, the history state (a new `historyOf` WeakMap fallback, the same pattern as `remotesOf`:202), `readIt(ctx)`, and contact/failure callbacks that wrap `noteContact`/`noteFailure` (:263, reason `call`). `handle()` passes `query` as `URLSearchParams` (:632).
- `tools/hub-api/server.mjs:243` -- the service ctx. Add `history: createHistory()`.
- `tools/hub-api/history.mjs` (new) -- `createHistory()` → `{proofs: Map}`; `listMonths(dir)` (fs/promises readdir, `^YYYY-MM\.jsonl$` only, so `replicas/` is never a month); `openReader({host, root, start, fromMonth, toMonth, accept, hostId, env})` → `{peek(), take(), position()}` over `readEventsFrom({env: {...env, HUB_EVENT_DIR: root}, month, offset, maxBytes: 256 KiB, hostId})`; `replicaLastTs(env, host)` (tail read of the newest non-empty replica month); `syncPeer(...)`; `queryHistory(...)`.
- `tools/registry/history.mjs` (new) -- pure: `parseHistoryQuery(URLSearchParams)`, `lockToResource(registry)` (record.lock→id, then `resourceOf`), `historyFilter(query, registry)`, `encodeCursor`/`decodeCursor` (base64url JSON, canonical re-encode check, keys in `HOST_KEYS`, values `YYYY-MM/<safe int>`), `pickNext(heads)`, `unreachableRanges(events, {own, window, syncedThrough})`.
- `tools/ci/lib/events.mjs:156` -- `readEventsFrom` (read-only reuse): `{offset, events: [{id, offset, event}]}`, RangeError `HUB_EVENT_OFFSET` (a bad cursor is 400) / `HUB_EVENT_LINE_TOO_LONG` (skip to `eventsEnd`, one `HUB_API_HISTORY_SKIPPED <host> <month> <code>` on `log.err`).
- `tools/hub-api/replica.mjs` -- `replicaDir(env, host)`; `createReplicas().exclusive/sizes` for the sync body (read-only use).
- `tools/hub-api/peers.mjs` -- `gate`, `isUnreached`, `isContact`, `failureReason`. A `host-reachability` event is `{host: <peer key> (envelope), from, to: unreachable|reachable, checked_at}` in this host's own log (`lock.mjs:258`).
- `tools/device/forward.mjs:197` -- `transportOf(ctx)`. `tools/hub-client.mjs:299` -- `forward()` (`{status, body}`, or an AWAY/problem error); `HOST_KEYS`.
- `tools/ci/lib/lock.mjs:61` -- `resourceOf`. Claimant kinds are `deploy|hub-job|agent|person`. Events carry `claimant{kind,holder,repo,run}`, `delivery{repo}`, `pool`, `resource`, `lock`.
- `tools/host-agent/routes.mjs:137`, `tools/host-agent/push.mjs:30` -- reword "Story 10.2's /history will call" to "/history calls" (comments only).
- `docs/hub-api-contract.md` -- a route row `| GET | /history | History | 10.2 |`; a `### History` section with its query params and fields; `HUB_USAGE` gains `bad-query`, `bad-range`, `bad-cursor`, `bad-limit`; `HUB_HOST_UNKNOWN` names `/history`; StreamFrame's "not in this contract yet" and AgentSync's "will call" are reworded.
- `tools/hub-api/contract.test.mjs:216` -- `GET_SAMPLES['/history']`: `prepare` writes a past `host-reachability` unreachable event for `mac` (`noteReachability`) and sets `ctx.request` to a transport that throws `HUB_DEVICE_AWAY`; `after` deletes it. This makes every field appear.

## Tasks & Acceptance

**Execution:**
- `tools/registry/history.mjs` -- the pure helpers above.
- `tools/registry/history.test.mjs` (new) -- unit table: the filter (a v1a lock, a pool via members and via `event.pool`, a gate pool, claimant kind and holder, repo via claimant and delivery), the cursor round trip and each bad cursor, `pickNext` ties, and ranges (open, closed, clipped by `synced_through`, by `from` and by the window end).
- `tools/hub-api/history.mjs` -- the reader, the sync and `queryHistory`.
- `tools/hub-api/routes.mjs`, `tools/hub-api/server.mjs` -- the route, `historyOf` and the ctx `history`.
- `tools/hub-api/history.test.mjs` (new) -- the matrix through `handle()` on temp dirs (hermetic). A multi-month own log plus a mac replica paged at a small limit returns every line exactly once (ids equal to the full set: nothing is compacted). A sync bridged to a real Host Agent `handle()` whose pusher posts into this Hub API `handle()` fills the replica, so a Mac event written after the last push shows with `partial: false`. A `partial` row when the transport throws AWAY; a no-sync row for a past window; the 400s and the 503.
- `docs/hub-api-contract.md`, `tools/hub-api/contract.test.mjs` -- the contract updates and the sample.
- `tools/host-agent/routes.mjs`, `tools/host-agent/push.mjs` -- the comment rewording.

**Acceptance Criteria:**
- Given `GET /history` with any mix of `resource`, `pool`, `claimant`, `repo`, `from`, `to`, `cursor`, when it runs, then it answers `History` with this host's log and each peer's replica, filtered, and paged by a cursor that decodes to `{<host key>: "<month>/<offset>"}`.
- Given a window a peer's replica may lack, when the request arrives, then the API calls that peer's `POST /agent/sync` with the replica sizes before it reads the replica; with the peer unreachable, it answers `partial: true` with `synced_through` and `unreachable_ranges`.
- Given two hosts' entries, when they are shown, then each host's subsequence stays in (month, offset) order and the answer says `cross_host_order: display-only`.
- Given every event since the log shipped, when it is paged through, then each one is returned exactly once.
- Given the contract doc and test, when this lands, then both include `/history`, and `mise run check` is green.

## Spec Change Log

## Review Triage Log

### 2026-11-26 — Review pass
- verdicts: 26 findings — high 0, medium 3, low 14, false 9, maybe-false 0
- findings:
  - `[medium]` `[patch]` (blind) A cursor naming a month the log has no file for is accepted, not 400 `bad-cursor` as the contract says. — Confirmed: `openReader` filtered the months `>= start.month` and read the next month from 0. Fixed: a start month not among the host's unfiltered months is now `badCursor` (history.mjs `fill`), with a test case added.
  - `[false]` `[reject]` (blind) `poolMembers` adds runtime phones to every named Pool and hardcodes `linux`. — Refuted: the matcher does exactly the same for any named Pool (`match.mjs:119-120`, runtime phones `host === 'linux'`), so history mirrors serving.
  - `[low]` `[patch]` (blind) The contract's "reads only: never writes, truncates or deletes" is false: the peer mark appends a `host-reachability` event. — Fixed: the doc and the `historyRoute` comment now say /history never compacts or deletes and writes nothing of its own; its only writes are the peer mark and the replica writer's.
  - `[false]` `[reject]` (blind) The cursor is not bound to its filters. — Refuted as a defect: the contract states the precondition ("with the same filters"). A cursor is a byte position, and a client that changes the filters breaks a documented rule.
  - `[low]` `[reject]` (blind) Every partial answer scans the whole own log for `host-reachability` events. — Real but small: logs are KB to MB per month, reads are chunked and yield. Bounding it needs persisted open-range state, which the spec forbids (no cached aggregate). Not worth the complexity now.
  - `[low]` `[reject]` (blind) A line over 256 KiB drops the rest of its month while the answer reads complete. — Only a hand edit can produce such a line, since the writers allowlist the fields. The spec's Code Map prescribes skipping to `eventsEnd`, and the skip is logged as `HUB_API_HISTORY_SKIPPED`. Flagging it would add a branch and public surface.
  - `[low]` `[patch]` (blind) The contract does not document that an unknown Pool name matches by `event.pool` only. — Fixed: the `pool` row in the contract now says so.
  - `[false]` `[reject]` (blind) An empty cursor `{}` is accepted. — No bad outcome: `{}` names no position, so it reads exactly like no cursor.
  - `[low]` `[reject]` (blind) `unreachableRanges` ignores the event's `from`. — Only corrupted or out-of-order logs could cause a phantom range. The single writer (`noteReachability`) emits transitions in order. The guard would add complexity for a case that does not happen.
  - `[low]` `[patch]` (blind) The Registry is read even when no filter needs it, so a time-only query fails on an unreadable `registry.json`. — Fixed: `registry()` is called only when `resource` or `pool` is set.
  - `[false]` `[reject]` (blind) The contract-test fixture uses the wall clock around month boundaries. — Refuted: `afterHistory` snapshots and restores every month file. `/history` without `from` reads every month, so the month the event lands in does not matter.
  - `[low]` `[patch]` (blind) The `server.mjs` ctx comment does not mention `history`. — Fixed: one clause about the in-memory sync proofs, which are lost on restart.
  - `[medium]` `[patch]` (edge) A cursor month absent from the host's log causes a silent rescan. Same root cause as the first blind finding. — Fixed by the same `badCursor` guard.
  - `[low]` `[patch]` (edge) The "reads only" claim is false: `replicas.sizes()` (settledSize) truncates a torn replica tail. Same root cause as the blind doc finding. — Fixed by the same doc rewording, which names the replica writer's settling.
  - `[low]` `[patch]` (edge) `poolMembers` counts `dedicated_qa` runtime phones as named-Pool members, but the matcher keeps them out (`match.mjs:96,126`). — Fixed: added the `dedicated_qa !== true` condition and a test assertion.
  - `[low]` `[reject]` (edge) A replica whose last line is over 256 KiB under-reports `synced_through`. — Only a hand edit can produce it. The fix needs a re-read loop that widens the window, and the result is an honest `partial`.
  - `[low]` `[patch]` (edge) A client abort during a peer sync is logged as `HUB_API_ERROR` (a service-bug line). — Confirmed: the abort error carries no status, so `handle` logged it, although the server drops the answer. Fixed: `handle` skips that log line when `signal.aborted` (routes.mjs catch), which holds for every route.
  - `[low]` `[reject]` (edge) A local fs error in `replicas.sizes` during a sync is masked as `partial`. — The answer is honestly partial, the cause is logged on `HUB_API_HISTORY_SYNC_FAILED`, and the reader then hits the same fs fault and throws. Classifying the errors would add branches.
  - `[medium]` `[patch]` (verification-gap, other) A cursor for a month with no file returns 200. Same root cause as the first blind finding. — Fixed by the same guard.
  - `[low]` `[patch]` (verification-gap, other) The doc's "never writes a log" overstates. Same root cause as the blind doc finding. — Fixed by the same rewording.
  - `[false]` `[reject]` (intent) The live ssh/two-host surface is exercised only through the in-process seam. — The repo mandates hermetic tests (CLAUDE.md), and the epic's Story 10.5 operator checks own the live verification. Not a defect in this diff.
  - `[false]` `[reject]` (intent) The diff generalizes to N hosts keyed by host key. — The spec's Approach and the epic require host-key keying. Linux plus mac is the concrete instance.
  - `[false]` `[reject]` (intent) It adds a `limit` key the AC does not list. — It is additive, documented, and in the matrix (`bad-limit`), and paging needs it.
  - `[low]` `[reject]` (intent) "Every event" has the codified over-bound-line exception. Same root cause as the blind 256 KiB finding. — Rejected for the same reason: hand-edit only, logged, and prescribed by the spec.
  - `[false]` `[reject]` (intent) The process and meta evidence sits outside the reviewed diff. — Process, not code: the spec file is committed at finalize with its Auto Run Result.
  - `[false]` `[reject]` (intent) It diverges from FR-18's raw "partial for any unreachable time". — The epic documents this narrowing as deliberate (asleep but later synced counts as complete).

## Design Notes

The k-way page loop: each reader keeps one matched head. The loop repeats `pickNext` and `take` until it has taken `limit` entries or every head is null. `more` is whether any head remains. A host's cursor position is its head's `{month, offset}` while a head is pending; otherwise it is the reader's end, the position after the last byte it scanned (a host with no log and no start has no key). So skipped non-matching lines are never scanned twice.

```
GET /history?from=2026-11-01T00:00:00Z&limit=2
{format:1, events:[{id:'<host_id>/2026-11/0', host:'linux', event:{...}}, {id:'<mac_id>/2026-11/0', host:'mac', event:{...}}],
 cursor:'eyJsaW51eCI6…', more:true, partial:false, synced_through:{linux:'…', mac:'…'}, unreachable_ranges:[],
 cross_host_order:'display-only', checked_at:'…'}
```

## Verification

**Commands:**
- `node --test tools/registry/history.test.mjs tools/hub-api/history.test.mjs tools/hub-api/contract.test.mjs` -- expected: all pass
- `heavy mise run check` -- expected: green

## Auto Run Result

Status: done

**Summary.** The Hub API now serves `GET /history?resource&pool&claimant&repo&from&to&cursor&limit`. It reads this host's Event Log and each peer's replica (`replicas/<host>/`) with `readEventsFrom` in 256 KiB chunks, yielding to the event loop between chunks. It filters with the ANDed filters, attributing a v1a `lock` with no `resource` through `resourceOf` and the Registry. The hosts' streams are merged by `ts` for display (`cross_host_order: 'display-only'`, ties going to host key order, a missing ts first). Pages use an opaque, canonical base64url cursor `{<host key>: "<month>/<offset>"}`. When a peer's replica may lack the window, the route first calls that host's `POST /agent/sync` with the replica sizes: through `forward()` over `transportOf(ctx)`, behind `peers.gate`, with the sizes read under `replicas.exclusive` and the call made outside it. If the window still cannot be shown covered, the answer is `partial: true`, with `synced_through` per host and `unreachable_ranges` derived from `host-reachability` events and clipped to `[max(from, synced_through), window end)`. The contract doc and the contract test include `/history` (additive, no version bump).

**Files changed**
- `tools/registry/history.mjs` (new): the pure half. Query check, lock-to-resource map, filter, cursor codec, `pickNext`, `unreachableRanges`.
- `tools/registry/history.test.mjs` (new): unit tables for the above.
- `tools/hub-api/history.mjs` (new): `createHistory` (in-memory sync proofs), `listMonths`, `openReader`, `replicaLastTs`, `syncPeer`, `queryHistory`.
- `tools/hub-api/history.test.mjs` (new): the I/O matrix through `handle()` on temp dirs, plus a sync bridged to a real Host Agent `handle()` and pusher.
- `tools/hub-api/routes.mjs`: the `GET /history` route, `historyRoute`, the `historyOf` fallback. `handle` no longer logs `HUB_API_ERROR` for a request the client aborted.
- `tools/hub-api/server.mjs`: `history: createHistory()` in the service ctx, plus its comment.
- `docs/hub-api-contract.md`: the route row, the `### History` section, the `HUB_USAGE` reasons (`bad-query`, `bad-range`, `bad-cursor`, `bad-limit`), `HUB_HOST_UNKNOWN` for `/history`, and the StreamFrame/AgentSync wording.
- `tools/hub-api/contract.test.mjs`: the `/history` GET sample (prepare/after) and the Hold-route exclusion (`/history` is the Hub API's alone).
- `tools/host-agent/routes.mjs`: comment reworded ("/history calls").

**Review findings.** There were 26 findings: high 0, medium 3, low 14, false 9.
- Patches applied (commit a04a2c0), grouped by root cause:
  - A cursor for a missing month is now 400 `bad-cursor` (medium).
  - The "reads only" wording in the doc and the comment is corrected (low).
  - The doc now says how an unknown Pool name matches (low).
  - `dedicated_qa` runtime phones are excluded from a named Pool (low).
  - The Registry is read only for the `resource`/`pool` filters (low).
  - A client abort no longer logs `HUB_API_ERROR` (low).
  - The `server.mjs` ctx comment mentions `history` (low).
- Deferred: none.
- Rejected:
  - Pool membership hardcoding (it mirrors the matcher).
  - The cursor not being bound to its filters (a documented precondition).
  - The empty cursor (no bad outcome).
  - The contract-fixture clock (`after` restores every month).
  - Five intent-alignment divergences: the live ssh surface (hermetic mandate; Story 10.5 owns it), N-host keying, `limit`, the process evidence, and the FR-18 narrowing (documented in the epic).
  - The whole-log reachability scan (small logs; bounding it needs a cache the spec forbids).
  - The over-256 KiB line skip, raised twice (hand-edit only, logged, spec-prescribed).
  - `from` validation in `unreachableRanges` (single in-order writer).
  - The replica tail over 256 KiB (hand edit, honest partial).
  - The masking of local fs errors (logged; the reader rethrows).

**Follow-up review recommended:** false. Patched: high 0, medium 1 entry (the cursor month guard), low 6 entries.

**Verification**
- `node --test tools/registry/history.test.mjs tools/hub-api/history.test.mjs tools/hub-api/contract.test.mjs` passed 56/56, both before and after the patches.
- `heavy mise run check`, after the patches: 1956/1956 pass, exit 0.
- Before the patches, two full runs each had one different failure. Both were timing-bound host-agent tests this story does not touch: `tools/host-agent/server.test.mjs:515` (500 `setImmediate` turns) and `tools/host-agent/push.test.mjs:420` (a 250 ms real-time bound). The box was at load average ~10. Each passed 3 to 5 out of 3 to 5 times in isolation.
- Matrix audit: every row has a passing covering test in `tools/hub-api/history.test.mjs`:
  - both hosts
  - filters
  - two paging tests
  - Mac asleep, plus an empty replica
  - asleep but synced later, plus the bridged real-agent sync
  - a past window with no sync
  - bad query (11 cases)
  - unknown host key (503)

**Residual risks**
- Without `to`, every request whose replica tail is older than the request time calls the Mac's `/agent/sync` over ssh. That is the spec'd design (window end = receipt time); the peers' gate fast-fails a host already marked unreachable.
- The live two-host path (real ssh to a sleeping Mac) is proven only through injected transports. Story 10.5's operator checks cover the live surface.
- The two pre-existing host-agent timing tests are flaky under load.
