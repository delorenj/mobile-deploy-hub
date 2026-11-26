---
title: 'Story 9.5: The Host Agent pushes changes, and only changes'
type: 'feature'
created: '2026-11-26'
status: 'done'
baseline_revision: '767516806c8cca00534d73ddeb3300b404b03b31'
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-9-context.md'
warnings: ['oversized']
deferred:
  - summary: >-
      A Hub API restart loses every pushed spoke view and reading until that host next pushes.
    evidence: |-
      createRemotes() and readings.remote() are in memory only (tools/hub-api/remotes.mjs, tools/hub-api/readings.mjs). The agent
      pushes only on a change, its start, or a request after a failure, and the Hub API may never call it (spec Never). So after a
      Hub API restart, /status has no hosts.mac and no stale.mac, and ios-lane reads unknown, until something on the Mac changes.
      That state is honest ("not known") but it is a gap in a service meant to be restartable at will. Possible fixes: persist the
      remotes store on the Hub's own disk, or have the agent learn of a new Hub boot (for example from the push ack or the stream
      boot) and re-push on its next request. Both need a design decision, likely alongside Story 9.6 or Epic 10's /agent/sync.
    location: >-
      tools/hub-api/remotes.mjs:createRemotes
    severity: medium
---

<intent-contract>

## Intent

**Problem:** The Hub API on big-chungus never sees the Mac. `/status.hosts` holds only `linux`, the `ios-lane` reads `unknown` in `/resources`, and the board cannot show the Mac without someone opening ssh. The Mac is a laptop that sleeps, so it cannot stream or be polled.

**Approach:** The Host Agent pushes one message, `POST /agent/push`, to the Hub API through `hub-client.mjs`. It pushes at its own start, when its lock dir or event dir is written, and when one of its Reachability readings changes. A push is never on a timer and a failed one is never retried on a timer. The Hub API applies a push once per `(boot, seq)`. It embeds the pushed view as `/status.hosts.<host>` and stores the readings in its cache. It marks the view `stale` from the push age on its own clock, and it pokes the change feed so a stream frame follows.

One level up (`belsky-doctrine`): this works for every spoke host, not only the Mac. The agent is keyed by `hostKey()`, and the Hub API takes a push from any host key but its own. The receiving side (the remotes store, `stale` and the readings) is written per host key, so a second spoke host needs no new code.

## Boundaries & Constraints

**Always:**
- Body (AD-49): `{format: 1, host, host_id, boot, seq, sent_at, status, readings, events}`.
  - `host` is the agent's `hostKey()`. `host_id` is `events.mjs` `hostId()`, or null.
  - `boot` is 12 lowercase hex characters (`mintBoot`), minted once per agent start.
  - `seq` is 1, 2, … per boot. Every push attempt uses up one number.
  - `sent_at` is an ISO time on the agent's clock.
  - `status` is `agentStatus(ctx)`, or `null` when it throws.
  - `readings` is `[{resource, state, checked_at, age_ms_at_receipt, received_at, source}]`: each lane of this host is read once through the raw `devicectl` seam and given in `serve()` form. It is `null` when this host's key is unknown.
  - `events` is always `null` (Epic 10 fills it).
- Triggers. The watch set covers `hubPaths(env)`: the lock dir, `emulators/`, every `.lock`, `.queue` and `.reservations` dir, and the event dir. `createWatchSet` re-arms it.
  - A notification schedules one push through `trailing(push, {delayMs: CHANGE_DEBOUNCE_MS})` from `stream.mjs`. That is the hub's one clock file, so no timer lives under `tools/host-agent/`.
  - The agent's start pokes once.
  - A request-path iPad read (`list devices` through the agent's wrapped `devicectl`) whose state differs from what the last push carried pokes once.
  - Nothing else pushes.
- A failed push is one stderr line, `HUB_AGENT_PUSH_FAILED <message>`. It fails when the transport throws or the answer is not 2xx. It is not retried. It stays owed: the next notification pushes, and so does the next request to the agent (`ctx.onRequest` pokes when owed).
- Pushes never overlap (`trailing` runs one at a time and marks a poke during a run as dirty). The push-time devicectl read goes around the observer, so a push never triggers itself.
- The agent calls the Hub API only through `hub-client.mjs` `request({host: 'linux', method: 'POST', path: '/agent/push', body})`: the context's `request` seam.
- Hub API `POST /agent/push`:
  - The body is checked strictly. Anything wrong is `HUB_USAGE` 400 with one of these reasons: `bad-body`, `bad-format`, `bad-host`, `bad-host-id`, `bad-boot`, `bad-seq`, `bad-sent-at`, `bad-status`, `bad-readings`, `bad-events`.
  - `host` must be a host key other than this service's own. An unknown own key is 503 `HUB_HOST_UNKNOWN`.
  - A `(boot, seq)` already applied (same boot, `seq` ≤ the applied one) answers 200 `{applied: false, host, boot, seq}` and changes nothing.
  - Otherwise it answers `{applied: true, …}`.
  - A non-null `status` replaces the host's view, and its receipt time becomes the API's `now`. A `null` status keeps the last view and its receipt time.
  - Each reading of a Resource the Registry places on `host` goes into the cache as `receive(entry, {now})`, and an `unknown` reading drops it. Other readings are ignored. No `reachability` event is written for them: only a host's own service logs one.
  - Then `ctx.onPush()` pokes the change feed, so a stream frame follows within the 250 ms debounce.
- `/status`:
  - `hosts` is the service's own view first, then each pushed view, embedded unchanged.
  - `stale.<host>` is `{since: <ISO receipt time>}` when `now - received_at > registry.reachability_max_age_s * 1000` on the API's clock (`ctx.now`, so a feed render at an old instant agrees). Otherwise the host has no key.
  - `stale` is never pushed and never stored.
- Tests are hermetic. They use a fake `watch`, `mock.timers` or a fake `timers`, an injected `request` bridging into the Hub API's `handle()`, a fake `devicectl`, a fake clock, and temp lock and event dirs.

**Never:**
- No `setTimeout`, `setInterval`, poll or retry loop under `tools/host-agent/`. No `fetch`, `node:http(s)`, `node:net` or `child_process` there either.
- No new policy key, lock, queue or Python.
- The Hub API never calls the agent to refresh a view.
- No change to the deploy path (`tools/ci/commands/*`, `tools/catchup/*`).
- No `/agent/sync`, no replica, no `events` other than `null`, no `409 HUB_REPLICA_GAP` (Epic 10).
- No unreachable marking (Story 9.6).
- Never write `sprint-status.yaml`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|---|---|---|---|
| Agent start | agent bound, Hub API answering | one push within 250 ms, `seq: 1`, `status` = the Mac view, `readings: [{resource: 'ios-lane', state: 'reachable', …}]` | — |
| Lock write | `withLock('mac-ios')` or a Lease on the Mac | one push ≤ 250 ms after the notification; a burst of notifications is one push; the pushed `locks` row carries the Mac clock's `started_at` | — |
| Quiet | no notification for 10 min (mocked clock) | no push | — |
| Push fails | the transport throws / the Hub API answers 503 | one `HUB_AGENT_PUSH_FAILED …` line; nothing more after 10 min | the next notification or agent request pushes `seq+1` |
| Reading change | a GET `/status` or lane take reads the iPad `offline` after a push carried `reachable` | one push carrying `offline` | — |
| Apply | push `seq: 3` boot B | `/status.hosts.mac` = its status; `/resources` `ios-lane.reachability.state` = pushed state; a stream subscriber gets a `status` frame within 250 ms | — |
| Duplicate | same boot, `seq` ≤ applied | 200 `{applied: false}`; view unchanged; no frame | — |
| New boot | boot C, `seq: 1` after B/9 | applied | — |
| Stale | API clock 61 s past receipt | `stale.mac = {since: <receipt ISO>}`; at 60 s none | — |
| Bad body | `host: 'linux'` on linux, `seq: 0`, `events: {}`, an unknown key | 400 `HUB_USAGE` with the matching reason; nothing stored | — |

</intent-contract>

## Code Map

- `tools/host-agent/server.mjs` -- `startHostAgent` (:26) builds `ctx` (:31) and `afterBind` (:33), then calls `startService`. This is where the watcher, the pusher, `ctx.onRequest`, `onStop` and the wrapped `devicectl` get wired. `send` (:30) is the hub-client `request` seam that pushes use.
- `tools/host-agent/routes.mjs` -- `agentStatus(ctx)` (:171) is the push's `status`. Its `statusView` reads the iPad only when a row names `ios-lane`.
- `tools/host-agent/known.mjs` -- `known.current().resources` gives this host's lanes for `readings` (`claims.lanesOf`).
- `tools/hub-api/changes.mjs`:
  - `hubPaths` (:24) and `createWatchSet` (:40) are reused as they are by the agent's watch.
  - `createChangeFeed().poke` (:159) is the Hub API's frame scheduler.
- `tools/hub-api/stream.mjs` -- `trailing` (:166), `CHANGE_DEBOUNCE_MS` (:159) and `mintBoot` (:34). This is the only clock file the agent may use.
- `tools/hub-api/server.mjs`:
  - `startService` (:120) already calls `ctx.onRequest` (:87) and `onStop` (:151).
  - `watchFor` (:188) is the faked-host rule. The agent applies it with `faked` = an injected `inventory` or `devicectl`.
  - `startHubApi` builds `ctx` (:237) and `feed` (:250). Add `remotes` and `onPush: () => feed.poke()` there.
- `tools/hub-api/routes.mjs`:
  - `statusDocument` (:182) merges the remote views and `stale`.
  - Add the route `POST /agent/push` to `ROUTES` (:432).
  - `routeError` (:89) makes the 400s. `readIt` (:109) places a reading's Resource.
- `tools/hub-api/readings.mjs` -- `createReadings` (:37) gets a `remote(entries, {at})` writer. It stores `receive()` readings and never calls `noteChange`. `read()` already serves stored readings for any record and probes only own-host phones.
- `tools/registry/reachability.mjs` -- `serve`/`receive`/`stamp` (:160-203): the boundary forms of a reading.
- `tools/device/claims.mjs` -- `laneReachability(ctx)` (:254) and `lanesOf` (:244). `readIpad` (reachability.mjs :54) maps a `list devices` document.
- `tools/ci/lib/events.mjs` -- `hostId()` (:29).
- `tools/hub-client.mjs` -- `HOST_KEYS` (:131) and `request` (:271).
- Tests to update or reuse:
  - `tools/hub-api/contract.test.mjs`:
    - `POST_SAMPLES` (:199) needs an `/agent/push` sample (status 200).
    - The exclusion list of Hub routes the agent must serve (:463) gains `/agent/push`.
  - `tools/host-agent/server.test.mjs`:
    - `scratch` (:54) is the harness.
    - :105 ("a start writes nothing", requests exactly `[GET /resources]`) stays true because the faked host has no watcher and the push is 250 ms away. Keep it and add a stop-before-push note if needed.
    - :518 spies global `setTimeout`. Update it: the only timer allowed is the one-shot `CHANGE_DEBOUNCE_MS` debounce, and there is no `setInterval`.
  - `tools/hub-api/changes.test.mjs:615` (`boot`, `withService`, FakeSink, `fakeWatch`, `mock.timers`) is the pattern for the Hub-side frame test.
- `docs/hub-api-contract.md`:
  - The routes table (:26-42).
  - `### Status` (:144): the `hosts` and `stale.*` text (:151).
  - `### ResourceList` (:81): the `ios-lane` reading text.
  - Request bodies (:382).
  - The `## Host Agent` section (:578).

## Tasks & Acceptance

**Execution:**
- [x] `tools/hub-api/remotes.mjs` (new):
  - `checkPushBody(body, {own})` gives the strict check and the reasons.
  - `createRemotes()` returns `{apply(body, {at}) -> {applied}, views({now, maxAgeS}) -> {hosts, stale}}`, held in memory per host key.
- [x] `tools/hub-api/readings.mjs` -- `remote(entries, {at})`.
- [x] `tools/hub-api/routes.mjs`:
  - `agentPush` handler: check, apply, store readings for Resources on `host`, then `ctx.onPush?.()` in a try block. A bare `handle()` with no `ctx.remotes` uses a per-ctx fallback store.
  - The `ROUTES` row `{method: 'POST', path: '/agent/push', shape: 'AgentPushAck'}`.
  - `statusDocument` merges `views()` into `hosts` and `stale`.
- [x] `tools/hub-api/server.mjs` -- `startHubApi`: `ctx.remotes = createRemotes()`, and `ctx.onPush = () => feed.poke()` once the feed exists.
- [x] `tools/host-agent/push.mjs` (new) -- `createPusher({policy, hostKey, hostId, boot, now, send, status, readings, log})` returns `{push, owed, carried}`.
  - It builds and sends the body.
  - On failure it logs `HUB_AGENT_PUSH_FAILED` and sets owed.
  - After it builds the body it records the readings it carried.
- [x] `tools/host-agent/watch.mjs` (new):
  - `createAgentWatch({env, watch, push, timers, log})` returns `{start, poke, settled, close}` over `createWatchSet(hubPaths)` and `trailing`.
  - `observeDevicectl(devicectl, {env, onState})`, the wrapper that maps every `list devices` answer (or throw) through `readIpad`.
- [x] `tools/host-agent/server.mjs` -- wire it all up:
  - mkdir the lock and event dirs only when a real watcher runs.
  - After the bind: `known.refresh`, then `watch.start()` (sync, plus one poke).
  - `ctx.onRequest` pokes when owed.
  - The `devicectl` in the request ctx is wrapped. A state that differs from the carried one pokes.
  - `onStop` closes the watch.
  - New seams: `watch`, `timers`, `hostId`, `boot`.
- [x] Tests:
  - New `tools/host-agent/push.test.mjs` covers each agent matrix row: start, lock write, burst, quiet 10 min, fail then carry by notification and by request, reading change, body shape and the Mac clock.
  - It also holds an end-to-end test: agent → bridge → Hub API `handle()` → `/status.hosts.mac`, `/resources` `ios-lane` reading and `stale` at 60 and 61 s.
  - It also holds a conformance scan: no `fetch`, `node:http`, `node:https`, `node:net` or `child_process` in `tools/host-agent/*.mjs`, and `push.mjs` sends only through the injected `send`, which defaults to hub-client `request`.
  - New `tools/hub-api/agent-push.test.mjs` covers the Apply, Duplicate, New boot, Stale and Bad body rows, plus a foreign-host reading that is ignored, a `null` status that keeps the view, and a stream `status` frame within 250 ms of a push through `startHubApi`.
  - Update `contract.test.mjs` (:199 sample, :463 list) and `server.test.mjs:518`.
- [x] `docs/hub-api-contract.md`:
  - Add the `/agent/push` row and the `### AgentPushAck` fields (`applied`, `host`, `boot`, `seq`).
  - Add the `POST /agent/push` body and its refusals under Request bodies.
  - Rewrite the Status `hosts` and `stale.*` text, and the `ios-lane` reading in ResourceList.
  - Add a Host Agent "Pushes" paragraph: the triggers, `HUB_AGENT_PUSH_FAILED`, and no retry.

**Acceptance Criteria:**
- Given the agent started with a bridge to the Hub API, when a Lease is taken on `mac-ios` on the Mac and the watcher notifies, then within 250 ms (mocked) the Hub API's `/status.hosts.mac.locks` shows it with the Mac clock's `started_at`. There is no further push until the next notification, the next reading change or the next request after a failure.
- Given `mise run check`, when it runs, then actionlint and the full suite are green, `tools/clock.test.mjs` included, with no new clock file.

## Spec Change Log

## Review Triage Log

### 2026-11-26 — Review pass
- verdicts: 37 findings — high 0, medium 7, low 14, false 16, maybe-false 0
- findings:
  - `[medium]` `[patch]` (blind) The `## Error codes` table header lost its `| Code` cell and the blank line after the heading — fixed: the heading, blank line and `| Code | Status | Exit | Meaning |` are restored to their baseline form.
  - `[false]` `[reject]` (blind) An idle Mac reads stale after 60 s — this is the intended behaviour: the intent says "marks `stale` from the push age", and Design Notes give the NFR-8 reason (every reader treats quiet Mac data as possibly stale).
  - `[medium]` `[defer]` (blind) A Hub API restart loses every pushed view until the next push — real: the store is in memory and the Hub API may not call the agent. The Mac's absence from `/status` is the state from before this story, so this is a remaining gap, not something this story caused. It needs a design choice (persist the store, or have the agent detect a new Hub boot). Deferred.
  - `[medium]` `[patch]` (blind) The Status doc says nothing time-derived is cached, but a pushed view is embedded frozen — fixed: one sentence now limits the claim to the service's own view. It says a pushed view's `stale`, `expected_end` and queue positions are as of its push, and that `stale.<host>` flags an old one. Embedding unchanged is what the intent asks for ("`/status.hosts.mac` is that status").
  - `[low]` `[reject]` (blind) `status` is only checked as an object — the only sender is `agentStatus`. A malformed view from some other client is unlikely, and checking the HostView shape adds guards.
  - `[low]` `[patch]` (blind) `apply()` records `(boot, seq)` before `readIt` runs, so a throw there loses that push's readings — fixed: the Registry places are now read before `apply`, so a throw applies nothing.
  - `[low]` `[reject]` (blind) `readings.remote` swallows a malformed `checked_at` while the push reports applied — our pusher always sends ISO times from `serve()`. Validating each field's format adds guards for a sender that does not exist.
  - `[false]` `[reject]` (blind) No timeout around the transport, so a hung call blocks pushes forever — `hub-client.request` has its own heartbeat, relay idle timeout and bound kill (`tools/hub-client.mjs:19`), so a hung call ends as a thrown failure.
  - `[low]` `[reject]` (blind) Boot order is undefined, so a delayed push from an older boot can overwrite a newer one — this needs an ssh relay to deliver a dead process's push after the new agent's first push. That is unlikely, and the fix (ordering by `sent_at` or per-boot marks) adds state.
  - `[low]` `[patch]` (blind) `checkReading` lets missing keys through via `?? null` — fixed: the four `?? null` are deleted, so a missing key is `bad-readings`, and a test case was added. Unknown keys, duplicates and size limits were rejected as added guards with no sender.
  - `[false]` `[reject]` (blind) `host_id` and `sent_at` are checked but never used — the AD-49 body requires both. `host_id` is held for Epic 10's replica, and the doc already says `sent_at` is not used by the receiver.
  - `[false]` `[reject]` (blind) `carried() === null` makes every request push — `carried` is null only before the first body or when the host key is unknown. In that case nothing is sent and `owed()` already pokes on each request, as the spec requires.
  - `[false]` `[reject]` (blind) `carried` is updated before a failed send, so it can reflect a body the Hub never received — while a push is owed, every request pokes anyway (`onRequest`), and the next push reads the iPad fresh, so no change can be missed.
  - `[false]` `[reject]` (blind) No `HUB_API_CONTRACT` bump — the route is additive. `HUB_API_CONTRACT` has stayed 1 through the routes added in Stories 9.2–9.4, and no key changed meaning for an existing reader.
  - `[low]` `[reject]` (blind) `observeDevicectl` has no direct unit test — the reading-change and devicectl-throws tests exercise it on the request path. A pass-through unit test adds little for a change nobody will meet.
  - `[low]` `[reject]` (blind) The conformance test pins the exact file list — this is deliberate: the list proves the scan saw every agent file. A new file fails with a clear diff, and that is how the next story adds it to the scan on purpose.
  - `[false]` `[reject]` (blind) `afterBind` reuses `HUB_API_WATCH_FAILED` — it is the same failure (a watch could not be armed) with the same code. The agent is the Hub API's generic start, so sharing the code is correct.
  - `[false]` `[reject]` (blind) The lock dir is made without the `0o700` mode — `lock.mjs:377` makes it with no mode as well. Only the event dir is 0700 anywhere.
  - `[medium]` `[patch]` (edge) Error codes table header broken — grouped with the first row. Same fix.
  - `[medium]` `[defer]` (edge) A Hub API restart loses the views and readings with no stale marker — grouped with the restart row. Deferred.
  - `[false]` `[reject]` (edge) A quiet healthy Mac reads stale — this is intended (see the matching blind row).
  - `[medium]` `[patch]` (edge) An embedded pushed Lease keeps reading live after `expires_at` — grouped with the Status-doc row. The doc now states that a pushed view is as of its push. Embedding unchanged is required by the intent.
  - `[low]` `[reject]` (edge) An older boot's delayed push overwrites a newer one — grouped with the blind boot-order row. Unlikely, and the fix adds state.
  - `[low]` `[reject]` (edge) A `status` of `{}`, or a reachable reading with a null `checked_at`, is accepted — no sender produces either. Checking the shape and state of each reading adds branches.
  - `[low]` `[patch]` (edge) `sent_at` accepts any text that `Date.parse` takes — fixed: an ISO `YYYY-MM-DDT` shape is now required before the parse, with `'2026'` and `'March 7'` test cases added.
  - `[low]` `[patch]` (edge) `readIt` throws after `apply` — grouped with the blind ordering row. Same fix.
  - `[false]` `[reject]` (edge) `carried() === null` pokes on every request — see the matching blind row. Nothing is sent and `owed()` already pokes.
  - `[low]` `[reject]` (edge) `close()` does not wait for an in-flight push — the worst case is one push or one log line after stop. Waiting for or aborting the send adds machinery for a case with no harm.
  - `[false]` `[reject]` (edge) `held` is set before the send — see the matching blind row. The owed request poke covers it.
  - `[medium]` `[patch]` (verification-gap) The Error codes header cell was dropped, and the contract test only matches data rows — grouped with the first row. Same fix.
  - `[low]` `[patch]` (verification-gap) `apply` runs before `readIt`, so a retry of the same `(boot, seq)` drops the readings — grouped with the blind ordering row. Same fix.
  - `[false]` `[reject]` (intent) The "no timer" acceptance criterion is met by a changed `server.test.mjs` expectation — the intent bans a timer, `setInterval` or poll in the agent. The scan shows none under `tools/host-agent/`. The one debounce is the hub's single clock file (`stream.mjs`), which `clock.test.mjs` enforces. A one-shot debounce on a poke is not a poll.
  - `[false]` `[reject]` (intent) "Within 250 ms" is measured on the debounce with mocked timers — the intent's 250 ms is from the notification. The push is dispatched at exactly `CHANGE_DEBOUNCE_MS`, and the Hub frame test asserts a frame within 250 ms, inside the 2 s budget.
  - `[false]` `[reject]` (intent) A reading change is seen only on the request path — AD-35 has the agent read the iPad only on request, and the intent forbids a poll. So the request path is the only place a change can be observed.
  - `[low]` `[reject]` (intent) The agent's watch runs against a fake `fs.watch` — the watch set is the hub's shared `createWatchSet`, which is already exercised. A live Mac `fs.watch` belongs to the device-level stories (9.7, 9.8), and a hermetic test cannot cover it.
  - `[false]` `[reject]` (intent) The diff adds surfaces beyond the acceptance criteria (refusal reasons, own-host refusal, foreign-Resource filtering) — these all sit on the receive surface that "the Hub API receives a push" implies, and none adds a policy key or route beyond `/agent/push`.
  - `[false]` `[reject]` (intent) A failed push is carried by any request, not only one "that needs the host" — every request to the agent needs this host. Any request is the widest honest reading, and it still pushes only when the push is owed.

## Design Notes

**Why `stale` uses `reachability_max_age_s`.** It is the one age limit the policy has for "this observation may no longer hold" (AD-35). The Mac pushes only on change, so a quiet Mac's view goes stale 60 s after its last push. That is NFR-8 told honestly: every reader treats Mac data as possibly stale. `since` is when this service received the view, which is the newest moment the view is known to be true. No frame is sent when the view turns stale (AD-41: time alone causes no frame). Story 9.6 adds `since` for unreachable.

**Why reading changes are seen through a wrapped `devicectl`.** The agent reads the iPad only on request (AD-35). The only time a change can be seen is when some request reads it. Wrapping the request ctx's seam sees every read: `GET /status` and a lane take's `require_reachable` gate. The push's own read uses the raw seam and records what it carried. A push therefore never triggers a second push.

```js
// one push
{ format: 1, host: 'mac', host_id: '8F3…', boot: '1f0c9a2b3d4e', seq: 4, sent_at: '2026-11-26T10:00:00.000Z',
  status: { phones: [], locks: [/* mac-ios */], waiters: [], reservations: [], inventory: {…}, emulators: [] },
  readings: [{ resource: 'ios-lane', state: 'reachable', checked_at: '…', age_ms_at_receipt: 0, received_at: 1764151200000, source: 'probe' }],
  events: null }
```

## Verification

**Commands:**
- `node --test tools/host-agent/push.test.mjs tools/hub-api/agent-push.test.mjs tools/host-agent/server.test.mjs tools/hub-api/contract.test.mjs tools/hub-api/changes.test.mjs tools/hub-api/status.test.mjs tools/clock.test.mjs` -- expected: all pass
- `mise run check` -- expected: actionlint clean, the full suite green

## Auto Run Result

**Status: done**

**Summary.** The Host Agent now pushes its host's view to the Hub API: one message, `POST /agent/push`, using the AD-49 body. It pushes at its start, on a write to its lock dir or event dir (through the hub's `createWatchSet` over `hubPaths`), and when an iPad Reachability read on a request differs from what the last push carried.
- Every push goes through one trailing debounce of `CHANGE_DEBOUNCE_MS`, borrowed from `tools/hub-api/stream.mjs`, so no timer lives under `tools/host-agent/`.
- A failed push is one `HUB_AGENT_PUSH_FAILED` line. It is never retried on a timer, and it stays owed until the next notification or the next request to the agent.
- The Hub API checks the body strictly (ten `HUB_USAGE` reasons, plus its own host key refused). It applies a push once per `(boot, seq)`, embeds the view as `/status.hosts.<host>`, stores the readings for Resources the Registry places on that host, marks `stale.<host>` from the push age on its own clock, and pokes the change feed.

One level up (`belsky-doctrine`): the agent is keyed by `hostKey()` and the receiving store is keyed per host. Any spoke host pushes, and a second one needs no new code.

**Files changed**
- `tools/host-agent/push.mjs` (new): `createPusher` (body, `seq`, the failure line, owed, carried) and `laneReadings`.
- `tools/host-agent/watch.mjs` (new): `createAgentWatch` (watch set plus trailing debounce) and `observeDevicectl` (sees request-path iPad reads).
- `tools/host-agent/server.mjs`: wires the pusher, watch, observed devicectl, `onRequest` and `onStop`, with new seams `watch`, `timers`, `hostId` and `boot`.
- `tools/hub-api/remotes.mjs` (new): `checkPushBody` and `createRemotes` (`apply` once per `(boot, seq)`; views and `stale`).
- `tools/hub-api/readings.mjs`: the `remote(entries, {at})` writer for pushed readings.
- `tools/hub-api/routes.mjs`: the `POST /agent/push` handler and route row. `statusDocument` merges the pushed views and `stale`.
- `tools/hub-api/server.mjs`: `ctx.remotes` and `ctx.onPush = () => feed.poke()`.
- `tools/host-agent/push.test.mjs` (new): the agent matrix rows, an end-to-end test into `handle()`, and the conformance scans.
- `tools/hub-api/agent-push.test.mjs` (new): Apply, Duplicate, New boot, Stale and Bad body; foreign readings; a null status; the stream frame.
- `tools/hub-api/contract.test.mjs`: the `/agent/push` sample and the route added to the agent-exclusion list.
- `tools/host-agent/server.test.mjs`: the timer test now allows exactly one `setTimeout 250`.
- `docs/hub-api-contract.md`: the route row, `AgentPushAck`, the request body and its refusals, the Status `hosts`/`stale` text and the pushed-view time note, the `ios-lane` reading, and the Host Agent "Pushes" paragraph.

**Review findings.** There were 37 findings: medium 7, low 14, false 16.
- **Patches applied** (5 entries: 2 medium, 3 low):
  - The Error codes table header was restored (medium).
  - The Status doc now scopes "nothing derived from time is cached" to the service's own view, and says a pushed view is as of its push (medium).
  - `agentPush` reads the Registry places before `apply` (low).
  - `checkReading` requires all six reading keys (low).
  - `sent_at` must be an ISO shape (low).
- **Deferred** (1): a Hub API restart loses pushed views until the next push (medium). This needs a design decision.
- **Rejected low findings:** status shape checking, `checked_at` format checking, boot ordering, extra reading-shape guards, a direct `observeDevicectl` unit test, the pinned conformance file list, waiting for an in-flight push on close, and the fake `fs.watch`. Each is unlikely to be met in use and its fix adds guards or machinery. The reason for each is in the triage log.
- **Rejected false findings:** idle stale (intended, NFR-8), the transport timeout (hub-client has its own), `host_id`/`sent_at` (required by AD-49), the two `carried` cases (owed covers them), the contract version (additive), the watch-failed code, the lock dir mode, and four intent divergences that the intent itself settles.

**Follow-up review recommendation: false.** Patched entries were high 0, medium 2, low 3. Both medium patches are documentation corrections that were checked by reading the result, so no unverified risk can be named. The code patches were each low, are covered by new test cases, and are green in the full suite.

**Verification**
- `node --test tools/host-agent/push.test.mjs tools/hub-api/agent-push.test.mjs tools/host-agent/server.test.mjs tools/hub-api/contract.test.mjs tools/hub-api/changes.test.mjs tools/hub-api/status.test.mjs tools/clock.test.mjs`: 130/130 pass, both before and after the patches.
- `mise run check` (through `heavy`): actionlint clean and 1798/1798 tests pass, both before and after the patches. `tools/clock.test.mjs` is green and there is no new clock file.
- Matrix test audit: every I/O row (Agent start, Lock write, Quiet, Push fails for both a throw and a 503, Reading change, Apply, Duplicate, New boot, Stale, Bad body) has a named test that ran and passed.

**Residual risks**
- A Hub API restart drops the Mac's view and readings until the Mac next changes (deferred above).
- A pushed view's time-derived fields are frozen at the push. Readers are told so by the doc and by `stale.<host>` after 60 s.
- A delayed push from a dead boot could overwrite a newer one (unlikely, last write wins).
- A real `fs.watch` on the Mac and the real ssh path to the Hub API are not exercised here. Live Mac verification belongs to Stories 9.7 and 9.8.
