---
title: 'Story 9.6: An asleep Mac reads `offline`, and fails fast'
type: 'feature'
created: '2026-11-26'
status: 'done'
baseline_revision: '7573926371516253b390c91da6125b7505dab155'
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-9-context.md'
warnings: ['oversized']
deferred: []
---

<intent-contract>

## Intent

**Problem:** When the Mac sleeps, every Hold action the Hub API forwards to it pays the full ssh connect timeout again, `/resources` keeps showing the `ios-lane` reading the Mac last pushed (often `reachable`), and `/status.hosts.mac` shows the last pushed view as if it were current for up to 60 s. Nothing records that the Mac went away or came back.

**Approach:** The Hub API keeps one in-memory reachability mark per peer host key (new `tools/hub-api/peers.mjs`). A forwarded call whose ssh leg fails marks the host `unreachable` with `since`, appends one `host-reachability` event, and from then on every action on that host fails at once with `HUB_DEVICE_AWAY`. No new contact is tried until a push arrives or a request comes 5 × `registry.reachability_max_age_s` after the last failure (judged at request time, never by a timer). A successful push or call restores the host with one event. While marked, every Resource on the host reads `offline` in `/resources` and in the embedded `/status.hosts.<host>` view, and `stale.<host>` says it is unreachable.

One level up (`belsky-doctrine`): the target is the Mac; the level is **any spoke host and every Resource on it**. The mark is keyed by host key, the offline overlay covers every Resource the Registry places on a marked host (not only `ios-lane`), and both restore paths (push and call) are generic, so a second spoke host needs no new code.

## Boundaries & Constraints

**Always:**
- Only the Hub API keeps marks and writes `host-reachability` events (AD-35). The CLI and the Host Agent keep their direct forwarding, bounded by `hub-client`'s connect timeout (Story 9.4: the CLI on big-chungus never asks the Hub API).
- A **failure** is a forward that throws `HUB_DEVICE_AWAY` with `api !== true` (the ssh leg or transport failed). A far side's own problem (`api: true`, e.g. the Mac answering 503 `HUB_DEVICE_AWAY reason offline` for the iPad) and `HUB_API_UNKNOWN` (the host answered something) are **contact**: they restore, never mark. An aborted request (the client went away) does neither.
- Failure `reason` is one word from the error's `detail`: `refused` (text matches `refused`), `timeout` (`timed out`, `timeout`, `no answer within`), else `ssh-error`. `hub-client` adds `detail` (the raw cause text) to the `HUB_DEVICE_AWAY` errors `away()` and `goneAway()` make; it never reaches a problem body.
- States per host: unset (never contacted), `reachable`, `unreachable`. Events (through `lock.mjs` `noteReachability({host, from, to, reason})`):
  - first failure: `{from: <prior state or null>, to: 'unreachable', reason: <failure reason>}`; the mark is `{since: at, failed_at: at, reason}`.
  - another failure while marked: no event; `failed_at` and `reason` update, `since` stays.
  - contact while marked: `{from: 'unreachable', to: 'reachable', reason: 'push' | 'call'}`, mark cleared.
  - contact while not marked: state `reachable`, no event.
  - an event write that fails or throws is one `HUB_API_REACHABILITY_FAILED <msg>` line on `ctx.log.err`; the state still changes and the answer never does.
- Gate: an action whose place is a marked host with `at - failed_at < 5 * reachability_max_age_s * 1000` fails at once, before any transport call, with `HUB_DEVICE_AWAY` (503, exit 75, `reason: host-unreachable`). Its message names the host, `since`, the reason, the time a new attempt is allowed, and `connect timeout <api.peer_connect_timeout_s> s`. At exactly 5 × the limit the call is tried. Nothing is written on either host.
- Any push that passes `checkPushBody` (applied or a duplicate) is contact for its `host`.
- A mark change (marked or restored) pokes the change feed: `ctx.onPeerChange?.()`, wired in `startHubApi` to `feed.poke()` like `onPush`. A throw there is logged, never answered.
- Offline overlay while a host is marked, from one stamped reading `stamp('offline', {checkedAt: failed_at, receivedAt: failed_at})`:
  - `/resources` (and the Pool-member readings `readingsOf` gives a `match`): each Resource whose `host` is marked is served as `serve({...reading, source: 'host'}, {now})`.
  - `/status.hosts.<host>`: the pushed view is copied and every row in its array lists with a non-null `reachability` object gets `present(reading, {now, maxAgeS})`. The pushed view itself is never mutated.
  - When the mark clears, the stored readings and the pushed view show again unchanged.
- `stale.<host>` is `{since, unreachable}` for every key: `since` the ISO receipt time of the last view (`null` when there is none), `unreachable` `null` or `{since: <ISO>, reason}`. A host has a key when its view is older than the limit or it is marked; a marked host with no view gets the key with `since: null` and still no `hosts` entry.
- Marks live in memory only; a Hub API restart forgets them (the next call is tried, bounded by the connect timeout).
- A bare `handle()` with no `ctx.peers` uses a per-ctx fallback store, as `remotesOf` does.
- Tests are hermetic: the transport is the real `hub-client` `request` with a fake `sshImpl` (failure: stderr line + exit 255; success: the real `relay()` with a `fetchImpl` bridged into the Host Agent's `handle()`), fake timers and a fake clock, temp lock and event dirs.

**Never:**
- No timer, interval, poll or background retry anywhere (`tools/clock.test.mjs` stays green with no new clock file). The 5× window is judged only when a request arrives.
- The Hub API never calls the agent to refresh or probe; no new route, policy key, lock, queue or Python.
- No change to the deploy path (`tools/ci/commands/*`, `tools/catchup/*`), to the CLI's forwarding, or to the Host Agent.
- No persistence of marks or pushed views (the 9.5 restart gap stays deferred).
- Never write `sprint-status.yaml`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|---|---|---|---|
| First failure | `POST /leases {resource: 'ipad'}`, ssh exits 255 `Connection refused` | 503 `HUB_DEVICE_AWAY` exit 75 `host-unreachable`; one `host-reachability {host: mac, from: null, to: unreachable, reason: refused}`; `/resources` `ios-lane.reachability` = `{state: offline, source: host, checked_at: <failure ISO>}` | — |
| Fast fail | same request 10 s later | 503 at once, no ssh spawned, message has `connect timeout 5 s`; no second event; no ticket on the Mac | — |
| Window edge | 299 s after the failure / 300 s after | fails at once / ssh is tried | — |
| Retry fails again | at 300 s, ssh times out | 503; no event; `failed_at` moves, so the next try is 300 s later | — |
| Recovery by request | at 300 s, the Mac answers | 200 Lease; one event `{from: unreachable, to: reachable, reason: call}`; `/resources` shows the stored reading again | — |
| Recovery by push | marked, then a valid push (even a duplicate `seq`) | one event `reason: push`; the next request is tried at once | — |
| Status while marked | view pushed, then a failure | `hosts.mac` = the last view with every row's `reachability.state` `offline`; `stale.mac = {since: <receipt ISO>, unreachable: {since, reason}}` | — |
| Far problem | the Mac answers 503 `HUB_DEVICE_AWAY reason offline` (iPad off) | relayed as before; no mark, no event | — |
| Never contacted, fresh push | — | `stale` has no key; a pushed view older than 60 s has `{since, unreachable: null}` | — |

</intent-contract>

## Code Map

- `tools/hub-client.mjs` -- `away()` (:183) and `goneAway()` (:291): add `detail` to the error. `request()` (:271) and `forward()` (:299) are the transport; `HOST_KEYS` (:131).
- `tools/device/forward.mjs` -- `transportOf` (:194) builds the `hubRequest` seams from ctx: also pass `ctx.timers` when set. `forwardHold` (:208) is the only Hub API → peer call.
- `tools/hub-api/routes.mjs`:
  - `hubHold` (:421): after `placeOf` gives a foreign `host`, gate, then `forwardHold`, then record failure or contact. This is the only place the Hub API contacts a peer.
  - `listResources` (:123) and `readingsOf` (:333): apply the offline overlay through one helper.
  - `statusDocument` (:192): pass marks into `remotes.views`, overlay marked views.
  - `agentPush` (:224): after `checkPushBody`, record contact `reason: 'push'`; poke `onPeerChange` when restored.
  - `remotesOf` (:178) is the fallback-store pattern to copy for `peersOf`.
- `tools/hub-api/remotes.mjs` -- `views({now, maxAgeS})` (:79): takes `marks` and returns `stale` entries `{since, unreachable}`.
- `tools/hub-api/server.mjs` -- `startHubApi` ctx (:239): add `peers: createPeers({env, now, hostId, policy, log})` and `onPeerChange: () => feed.poke()`.
- `tools/ci/lib/lock.mjs` -- `noteReachability` (:258): the one appender; `{host, from, to, reason}` writes `host-reachability`.
- `tools/registry/reachability.mjs` -- `stamp`, `present`, `serve` (:160-203).
- Tests to update or reuse:
  - `tools/hub-client.test.mjs:247-284` -- `fakeTimers`, `sshChild`, `wordsOf`, `relaying`: the fake-ssh pattern.
  - `tools/hub-api/forward.test.mjs:33` -- the two-host `world()`; :174 stays green.
  - `tools/hub-api/agent-push.test.mjs` (:73-159, :254-256, :321) and `tools/host-agent/push.test.mjs` (:443-454): `stale` assertions gain `unreachable: null`.
- `docs/hub-api-contract.md` -- ResourceList `reachability.source` (:80) and the `ios-lane` text (:82); Status `stale.*` (:152) and the pushed-view sentence (:147); `HUB_DEVICE_AWAY` row (:553); Forwarding (:600).

## Tasks & Acceptance

**Execution:**
- [x] `tools/hub-client.mjs` -- add `detail` to `away()` and `goneAway()` errors -- the failure reason needs the cause without parsing the message.
- [x] `tools/hub-api/peers.mjs` (new) -- `failureReason(error)`, `isUnreached(error)`, `isContact(error)`, and `createPeers({env, now, hostId, policy, log, note})` returning `{gate(host, {at}), failed(host, {at, reason}) -> changed, reached(host, {at, reason}) -> changed, mark(host), marks(), offlineReading(host)}`; `offlineView(view, reading, {now, maxAgeS})` -- one store and one overlay rule for every peer host.
- [x] `tools/device/forward.mjs` -- `transportOf` passes `ctx.timers` -- hermetic ssh tests.
- [x] `tools/hub-api/remotes.mjs` -- `views({now, maxAgeS, marks})` with the `{since, unreachable}` entries.
- [x] `tools/hub-api/routes.mjs` -- `peersOf`, the gate and record in `hubHold`, the overlay in `listResources`/`readingsOf`/`statusDocument`, push contact in `agentPush`.
- [x] `tools/hub-api/server.mjs` -- `ctx.peers` and `ctx.onPeerChange`.
- [x] `tools/hub-api/unreachable.test.mjs` (new) -- every matrix row with a fake `sshImpl` and fake clock, the reason words, the feed poke on mark and restore, and a `startHubApi` test that a mark change produces a stream `status` frame.
- [x] Update `stale` assertions in `tools/hub-api/agent-push.test.mjs` and `tools/host-agent/push.test.mjs`.
- [x] `docs/hub-api-contract.md` -- `source: host`, the overlay, `stale.*` shape, the unreachable paragraph under Forwarding, the `HUB_DEVICE_AWAY` row (cached fast fail).

**Acceptance Criteria:**
- Given a call to the Mac that fails (connect refused, timeout, ssh error), when the Hub API records it, then it marks the host `unreachable` with `since`, every Resource on it reads `offline`, one `host-reachability` event `{host, from, to, reason}` is appended, and actions on it fail at once.
- Given a host marked unreachable, when requests arrive, then no contact is tried until a push arrives or a request comes 5 × `registry.reachability_max_age_s` after the failure, judged at request time.
- Given a successful push or call, when it arrives, then the host is restored and one `host-reachability` event records it.
- Given `/status` while the Mac is unreachable, then `hosts.mac` is the last view with `ios-lane` reachability `offline`, and `stale.mac` carries `since` and `unreachable.since`.
- Given `mise run check`, then actionlint and the full suite are green, `tools/clock.test.mjs` included, with no new clock file.

## Spec Change Log

## Review Triage Log

### 2026-11-26 — Review pass
- verdicts: 28 findings — high 0, medium 0, low 11, false 17, maybe-false 0
- findings:
  - `[low]` `[reject]` (blind) A forward that started before a restoring push can fail after it and re-mark the host — real but needs a call to fail after the Mac just pushed. The agent's next change or request pushes again and restores it. The fix needs per-call start tracking, which adds state.
  - `[false]` `[reject]` (blind) The `stale.<host>` shape changed with no contract bump — the change is additive (`unreachable` key; `since: null` only for a marked host with no view, which has no `hosts` entry). `HUB_API_CONTRACT` stayed 1 through the additive routes of 9.2–9.5, and `hub-device status` (`tools/device/hub-device.mjs:490`) still reads `stale.since` correctly.
  - `[false]` `[reject]` (blind) `source: 'host'` may be rejected by validators — `receive()` and `serve()` never check `source` (`source ?? 'probe'`), and `checkReading` only requires text.
  - `[false]` `[reject]` (blind) The `host-reachability` event may not be emitted — `noteReachability({host, ...})` writes it (`tools/ci/lib/lock.mjs:258`, pinned by `event-vocabulary.test.mjs:120`), and the new tests read it back from the Event Log.
  - `[false]` `[reject]` (blind) The 5× window is hardcoded and fails open on a bad policy — 5× is AD-35's fixed rule, not a deploy-policy knob. `registry.reachability_max_age_s` and `api.peer_connect_timeout_s` are required by the strict policy parse, so neither can be missing.
  - `[false]` `[reject]` (blind) The CLI still pays the connect timeout — Story 9.4 settled that the CLI on big-chungus forwards directly. The story's AC is "when the Hub API records it", and a CLI failure is bounded at the 5 s connect timeout with it named in the message, which is the epic's "fails fast".
  - `[false]` `[reject]` (blind) A bound-kill timeout marks the host, and `HUB_API_UNKNOWN` counts as contact — `forward()` throws `HUB_API_UNKNOWN` only after it read a status and body, so it is contact. A bound kill is a host that gave no answer, which is the AC's "timeout".
  - `[false]` `[reject]` (blind) `detail` may leak into the problem body — `problem()` copies only the base fields and `PROBLEM_EXTENSIONS`. The body's `detail` is the error message, as before.
  - `[low]` `[reject]` (blind) The test file copies harness code, and lacks a second spoke host and the track-closed status — the copies are test-only. The store is keyed by host key with no Mac special case. The fixes add test surface with no named defect.
  - `[false]` `[reject]` (blind) While marked, release or cancel through the Hub API fails for up to 5 minutes — this is the AC ("actions on it fail at once"). The holder's CLI release goes to the Mac directly and is never gated.
  - `[false]` `[reject]` (edge) Non-connect AWAY causes (bound kill, relay refusal, far loopback refused) mark the host — each is the Mac's front door not answering, which the AC names ("connect refused, timeout, ssh error"). Same root as the blind classification row.
  - `[low]` `[reject]` (edge) An in-flight call that started before a push fails after it — same as the blind ordering row.
  - `[low]` `[reject]` (edge) Concurrent requests at the window's end each spawn ssh — they run in parallel, so each is bounded by the same 5 s. Allowing only one probe at a time adds state.
  - `[low]` `[patch]` (edge) A retry that fails again moves `failed_at` and `reason` with no feed poke — fixed: `noteFailure` now pokes on every recorded failure (the feed sends a frame only when the document differs), and the retry test expects 2 pokes.
  - `[false]` `[reject]` (edge) A missing `reachability_max_age_s` turns fast fail off — the strict policy parse requires it (see the blind row).
  - `[low]` `[reject]` (edge) A clock that steps back holds the mark longer — negligible on an NTP host, and the fix adds a branch.
  - `[false]` `[reject]` (edge) `HUB_API_UNKNOWN` is also used for timeouts and resets — not in `forward()`: a transport failure there is `goneAway` (AWAY). UNKNOWN is only an answered non-JSON, non-problem response.
  - `[false]` `[reject]` (edge) The docs say "the ssh leg" but other causes mark too — the doc defines a failure as `HUB_DEVICE_AWAY` with `api: false`, which is exactly the predicate `isUnreached`.
  - `[low]` `[patch]` (verification-gap) The overlay test's title claims a Pool match reads offline, but the test never exercises `readingsOf` — fixed: the clause was dropped from the title. No public request reaches `readingsOf` with a marked member, because a cross-host Pool is refused and an all-Mac Pool is forwarded and gated.
  - `[low]` `[patch]` (verification-gap) The no-timer test is vacuous when empty and cannot see a global timer — fixed: it asserts the fake timers seam saw timeouts, and it spies on global `setTimeout`/`setInterval` for the scenario, asserting neither was called.
  - `[low]` `[patch]` (verification-gap, other) A bare `ETIMEDOUT` cause was classified `ssh-error` — fixed: the timeout pattern matches `etimedout`, and the unit case uses a bare `'ETIMEDOUT'`.
  - `[low]` `[reject]` (verification-gap, other) The `hub-device status` text ignores `stale.unreachable` — it still prints `[stale since …]` for a marked host's view. The CLI text is outside this story's surfaces, and nothing breaks.
  - `[false]` `[reject]` (intent) A mark is set only by forwarded Hold actions — that is the only Hub API → Mac call. The Hub API never probes the Mac (9.5 Never).
  - `[false]` `[reject]` (intent) "A request that must act on the host" is collapsed into the 5× window — the Design Notes settle it: "actions fail at once" leaves no other coherent reading.
  - `[low]` `[reject]` (intent) Marks are process-local — intended and documented. A restart costs one bounded connect attempt.
  - `[false]` `[reject]` (intent) The derived overlay is invisible to a bare `ctx.readings` reader — every served surface (`/resources`, `/status`, `readingsOf`) goes through `readingsFor` or `offlineView`, and no other reader serves peer records.
  - `[false]` `[reject]` (intent) The `stale.*` schema widened — same as the blind contract row: an additive key.
  - `[false]` `[reject]` (intent) No operator-only actions are present — correct: the story needs none, so `awaiting-operator` does not apply.

## Design Notes

**Reading of "a request that must act on that host".** AD-35 lists it beside the push and the 5× window as what may end the quiet period, and in the same breath says actions on a marked host fail at once. Read together (and with the epic's hermetic AC "5x recovery by request"), a request is the only thing that may try contact, and only once the 5× window has passed; before that it fails at once. Any other reading makes "fail at once" empty.

**Why overlay instead of writing `offline` into the caches.** The mark is derived when a reader asks, so clearing it shows exactly what the Mac last pushed, with its honest age. Writing `offline` into the readings cache would need a second write to undo it and could hide a newer push. The `/status` view is copied, never mutated, so the store keeps the Mac's own words.

```js
// stale while marked
{ mac: { since: '2026-11-26T10:00:00.000Z', unreachable: { since: '2026-11-26T10:00:40.000Z', reason: 'refused' } } }
```

## Verification

**Commands:**
- `node --test tools/hub-api/unreachable.test.mjs tools/hub-api/forward.test.mjs tools/hub-api/agent-push.test.mjs tools/host-agent/push.test.mjs tools/hub-api/contract.test.mjs tools/hub-client.test.mjs tools/hub-client-forward.test.mjs tools/clock.test.mjs` -- expected: all pass
- `mise run check` -- expected: actionlint clean, the full suite green

## Auto Run Result

**Status: done**

### Summary

The Hub API now records when a spoke host (the Mac today; the store is keyed by host for any spoke host, per `belsky-doctrine`) stops answering. A forwarded Hold action that fails with `HUB_DEVICE_AWAY` (`api: false`) marks the host `unreachable` with `since` and `reason` (`refused`, `timeout` or `ssh-error`). It also writes a `host-reachability` event to the Event Log and pokes the `/status` stream. While the host is marked:
- every Resource on it reads `offline` (`source: host`) in `/resources` and `/status`;
- `/status.stale.<host>` carries `unreachable: {since, reason}`;
- actions on it fail at once with a 503 `HUB_DEVICE_AWAY` whose message names the connect timeout.

Any valid push from the host's agent clears the mark. So does a request that arrives once 5 × `reachability_max_age_s` has passed since the last failure, and then succeeds. Readers judge the mark when they ask, so nothing runs on a timer.

### Files changed

- `tools/hub-api/peers.mjs` (new): the per-host mark store (`gate`, `failed`, `reached`, `marks`, `offlineReading`), failure classification, and the `offlineView` overlay.
- `tools/hub-api/routes.mjs`: gates the forwarded holds and records failure or contact. It overlays offline readings on `/resources`, `readingsOf` and `/status`, counts an agent push as contact, and pokes the feed on every change.
- `tools/hub-api/remotes.mjs`: `views()` adds `unreachable` to each `stale` entry. A marked host with no view gets `since: null`.
- `tools/hub-api/server.mjs`: wires `createPeers` into ctx, plus the `onPeerChange` feed poke and the `sshImpl` and `timers` seams.
- `tools/hub-client.mjs`: AWAY errors carry `detail`, which the failure classification reads.
- `tools/device/forward.mjs`: passes `ctx.timers` to the transport.
- `tools/hub-api/unreachable.test.mjs` (new): 19 tests covering every I/O matrix row, including the stream frame through `startHubApi`.
- `tools/hub-api/agent-push.test.mjs`, `tools/host-agent/push.test.mjs`: the `stale` expectations include `unreachable: null`.
- `docs/hub-api-contract.md`: documents `source: host`, the new `stale.*` shape, the unreachable-host rule, and the updated `HUB_DEVICE_AWAY` row.

### Review findings

The review raised 28 findings: high 0, medium 0, low 11, false 17, maybe-false 0.

**Patches applied (4, all low):**
- `noteFailure` pokes the feed on every failure, so a failed retry is pushed to the stream.
- The overlay test's title no longer claims Pool coverage.
- The no-timer test asserts that the timers seam was used, and spies on global `setTimeout`/`setInterval`.
- A bare `ETIMEDOUT` is classified as `timeout`.

**Deferred:** none.

**Rejected:** 24 findings, with full reasons in the Review Triage Log above.
- **Low, not worth the added state or branches:**
  - A late in-flight failure can come after a push (raised by two reviewers).
  - Concurrent retries can arrive when the window ends.
  - The clock can step backwards.
  - The test harness is duplicated.
  - Marks live only in process memory, as intended.
  - The CLI status text ignores `unreachable`; this is out of scope.
- **False, refuted at the code:**
  - The contract or schema bump is additive (raised twice).
  - The `source` validators accept `host`.
  - The event catalog already covers the new event.
  - The 5× factor is fixed in AD-35, and the strict policy parse requires both of its inputs (raised twice).
  - The CLI's connect timeout was settled in Story 9.4.
  - The `UNKNOWN`/`AWAY` classification is correct (raised three times).
  - The `detail` field does not leak into problem bodies.
  - Release-while-marked is required by the AC.
  - The doc wording matches the predicate.
  - Detection only through holds matches the spec.
  - The request-trigger reading is the one the Design Notes settled.
  - The derived overlay covers every surface that is served.
  - No operator actions are needed.

### Follow-up review recommendation

`false`. This pass patched high 0, medium 0, low 4.

### Verification

- The targeted suite (`node --test` on the 8 files in Verification) passed 157/157, both before and after the patches.
- `heavy mise run check` (actionlint plus the full suite) exited 0 with 1817/1817 passing, both before and after the patches.
- The matrix audit found a passing test in `tools/hub-api/unreachable.test.mjs` for every I/O matrix row.

### Residual risks

- Marks are held in process memory, so after a Hub API restart the first action on an asleep Mac pays one bounded connect timeout.
- The CLI on big-chungus forwards to the Mac directly and keeps no marks, so it still pays up to the 5 s connect timeout each time (the Story 9.4 design).
- A forward that started before a restoring push and fails after it can re-mark the host until the next push.
- A Mac that wakes but sends no push keeps failing fast until the 5× window (300 s) ends.
