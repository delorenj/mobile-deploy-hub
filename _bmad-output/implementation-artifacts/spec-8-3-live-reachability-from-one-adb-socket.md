---
title: 'Story 8.3: Live Reachability from one adb socket'
type: 'feature'
created: '2026-11-25'
status: 'done'
baseline_revision: '56e6616058924d961dbcc1e24883b16c89503c12'
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-8-context.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-8-2-reads-and-waits-never-block-the-event-loop.md'
warnings: ['oversized']
deferred: []
---

<intent-contract>

## Intent

**Problem:** The Hub API learns phone presence only by asking: a read finds a reading older than 60 s, or the 2 s host snapshot, and starts a probe. A phone that connects or drops shows its old state until somebody's read happens to start a probe. Every reading is `source: probe` (FR-5, AD-35, AD-19).

**Approach (`belsky-doctrine`, one level up from "an S26 that updates live": every reader of every own-host phone Resource).** `adb-wire.mjs` gains a streaming `trackDevices` that speaks only `host:track-devices-l`. A new `tools/hub-api/track.mjs` holds one such socket per service and feeds each pushed listing into the two caches every reader already uses. The first is the host snapshot's adb half (Story 8.2's design note), which `/status`, `/discovery` and the readings probe read through `adbQuery`. The second is the readings cache (`/resources`, Pool matching), whose `noteReachability` writes are already the single writer. Every route therefore agrees, with no new reader path.

## Boundaries & Constraints

**Always:**
- Node 24 ESM `.mjs`, `node:` builtins only. Tests are hermetic: `hermetic()` in every new test file, a fake socket through a `connect` seam, a fake `trackDevices` at the service level, an injected `now`, and no real adb (the dev box runs one on 5037).
- `trackDevices(port, {onDevices, onClose, connect = net.connect, handshakeMs = 5000})` (exported, and as `createAdbWire(port).trackDevices(handlers)`):
  - It connects to `127.0.0.1:<port>` and writes exactly one frame, `host:track-devices-l`. It then waits for `OKAY`. `FAIL` (with `code: 'ADB_FAIL'`), a malformed frame, or no answer within `handshakeMs` closes the socket.
  - After `OKAY`, each length-prefixed payload calls `onDevices(parseDevicesLong(text))`. Payloads that arrive split across chunks, or several in one chunk, are each parsed.
  - `onClose({opened, error})` is called exactly once. `opened` is true once `OKAY` arrived.
  - It returns `{close()}`. The socket is `unref()`ed, never reconnects, and never starts anything.
- `createTrack({env, now, hostKey, records, snapshot, readings, open, log})` in `tools/hub-api/track.mjs`:
  - `ensure()` opens the socket only when no handle exists, the service is not stopped, `open` is set, and `snapshot.read()`'s inventory lists an adb server on the hub port (`HUB_ADB_SERVER_PORT`, default 5037).
  - `onDevices` stores the listing in the snapshot (`snapshot.track(listed)`). It maps each record from `records()` (live, own-host phone Resources) through the shared claims mapper, using the snapshot's endpoint serials, and hands them to `readings.track(entries, {at: now()})`.
    - When a `device`-state `host:port` id has no known serial, it starts one `snapshot.refresh()`. When that refresh settles, and the listing is still the latest, it maps the listing again.
  - `onClose` with `opened` (and not stopped) calls `snapshot.untrack()` and `readings.trackLost({at})`. Without `opened` it writes nothing. In both cases it clears the handle, so only the next `ensure()` reopens.
  - `stop()` closes the socket and writes nothing.
  - An `open` or callback that throws is one `HUB_API_TRACK_FAILED <why>` line and never reaches a request.
- Snapshot (`tools/hub-api/snapshot.mjs`) gains `track(listed)` and `untrack()`. While a listing is tracked, `adbQuery()` returns it with `note: null`, the last gather's `serials` and `checked_at: now()`. A gather never overwrites a tracked listing. After `untrack()`, `adbQuery()` answers from the gathers as before.
- Readings (`tools/hub-api/readings.mjs`) gains `track` and `trackLost`. They share the `logged` map with the probe.
  - `track(entries, {at})`: stores `source: 'track'` readings, marks those ids live, and notes each change from the last logged state with `reason: 'track'`.
  - `read()`: serves a live reading as current, stamped at the read's `now` (age 0). A live reading never starts a probe.
  - `refresh()`: a probe never overwrites a live reading.
  - `trackLost({at})`: writes exactly one `reachability` event per live id, `{from: <last logged>, to: 'unknown', reason: 'track-lost', checked_at: at}`. It then drops those readings and clears the live set, so the next read probes (`source: probe`).
- `claims.mjs` exports the per-serial adb mapper (`adbStateOf(adb, serial)`: the note, the listed entry's state or null), and `phoneObservations` uses it. The answers stay the same.
- `startHubApi` builds one track:
  - It calls `ensure()` after the first gather settles, and on every request: `requestListener` calls `ctx.onRequest?.()` in a try block before handling.
  - `startService` gains an `onStop` hook. It is awaited before the server closes, and calls `track.stop()`.
  - The `trackDevices` seam defaults to the real `trackDevices`. It is null when a test fakes the host (`observe`, `inventory`, `adbWire`, `snapshot` or `adbQuery` injected without `trackDevices`).

**Never:**
- Add a timer, interval, backoff or reconnect loop in `tools/hub-api/` (tools/clock.test.mjs). The handshake bound lives in `tools/device/adb-wire.mjs`.
- Start, connect or kill an adb server, or use the adb client binary.
- Have the CLI write reachability.
- Cache anything derived from time.
- Change the on-disk layout, an existing event key, a response key, `CONTRACT_VERSION` or `policy.json`.
- Touch the deploy path, `AGENTS.md`/`CLAUDE.md` or `sprint-status.yaml`.
- Write a `track-lost` event on a deliberate stop or on a socket that never opened.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Wire request | fake socket; `OKAY` then two payloads split across three chunks | exactly one write, `0014host:track-devices-l`, to 127.0.0.1:<port>; `onDevices` twice with the parsed lists | `FAIL`, ECONNREFUSED or handshake silence: `onClose({opened:false})` once |
| Connect | track open, s26 `device` | `/status` `hosts.linux` s26 reachability `reachable`, age 0 and not stale even 10 min later; `/resources` `source: track`; one event `reason: track`; the probe is never called | — |
| Unauthorized / drop | the next push lists s26 `unauthorized`, then not at all | `unauthorized`, then `absent`, on `/status` and `/resources`; one event each | — |
| Close | the open socket closes | one `track-lost` event per tracked Resource (`to: unknown`); the next read probes (`source: probe`); no reopen until a request; that request opens exactly one socket | — |
| No server | snapshot inventory has no server on the hub port | `open` is never called | — |
| Stop | SIGTERM while open | socket closed, no `track-lost` event, the process is not held open | — |
| Endpoint | push lists `10.0.0.5:5555 device`, its serial not yet read | one snapshot refresh; mapped again after it, s26 reads `reachable` | an unreadable serial reads `absent`, with no second refresh |

</intent-contract>

## Code Map

- `tools/device/adb-wire.mjs`:
  - `frame` (L8) and `parseDevicesLong` (L69) are reused.
  - `exchange` (L12-57) is the socket model. `trackDevices` is a new long-lived sibling and does not use `exchange`, which resolves on close.
  - `setTimeout` is allowed in `tools/device/`.
- `tools/device/wire-fixtures.mjs` `fakeAdbServer` (L45) -- add `host:track-devices-l` support: `OKAY` plus the current listing as a payload, the socket kept open, and `push()`/`dropTracks()` helpers. This is for one real-socket test.
- `tools/device/claims.mjs`:
  - `phoneObservations` (L1505-1519) has the inline matcher at L1514. Extract it as `adbStateOf`.
  - `phoneReachability` comes from `tools/registry/reachability.mjs` L25.
  - `statusView` (L1574) reads adb only through `ctx.adbQuery` (L1651 -> L1508), so a tracked snapshot makes `/status` live with no statusView change.
- `tools/hub-api/snapshot.mjs`:
  - `createSnapshot` (L37); `adbQuery` (L104) gains the tracked branch.
  - `gather` (L45) keeps the tracked listing.
- `tools/hub-api/readings.mjs`:
  - `createReadings` (L30); `refresh` (L41) skips live ids; `read` (L59) serves live ids as current.
  - Events go through `note` (default `noteReachability`, `tools/ci/lib/lock.mjs` L258).
  - `stamp`/`serve` come from `tools/registry/reachability.mjs` (L160, L191).
- `tools/hub-api/track.mjs` (new) -- `createTrack`, modelled on `readings.mjs`: one handle, opened only by `ensure()`.
- `tools/hub-api/server.mjs`:
  - `requestListener` (L76) gains `ctx.onRequest`.
  - `startService` (L103) gains `onStop`, awaited in `stop` (L133-135) before `server.close`.
  - `startHubApi` (L169) builds `records` with `readRegistry({env, devices, qaDevices, warn: () => {}})`. It filters with `retirement(record) === null`, kind `phone` and host equal to the host key (`tools/registry/store.mjs`, `tools/registry/match.mjs`).
  - It also builds the track and the `trackDevices` seam rule, and chains `ensure()` after `snapshot.refresh()` in `afterBind` (L180).
- Docs:
  - `docs/hub-api-contract.md` L78: add `track` to `reachability.source`.
  - L80: when the socket is open, readings are current.
  - The `/status` paragraph: its readings come from the socket while it is open.
- Test scaffolds:
  - `tools/hub-api/event-loop.test.mjs` `boot()` (L45) is the FakeServer and listener pattern.
  - `tools/hub-api/reachability-discovery.test.mjs` L171 shows `createReadings` with a fake `probe` and `note`.
  - `tools/device/status-view.test.mjs` L731 is the real-socket wire test.

## Tasks & Acceptance

**Execution:**
- [ ] `tools/device/adb-wire.mjs` -- `trackDevices` export plus the `createAdbWire` method -- the streaming read-only transport
- [ ] `tools/device/wire-fixtures.mjs` -- the track request in `fakeAdbServer`, with `push`/`dropTracks` -- a real-socket proof
- [ ] `tools/device/claims.mjs` -- export `adbStateOf` and use it in `phoneObservations` -- one mapper for probe and track
- [ ] `tools/hub-api/snapshot.mjs` -- `track`/`untrack` and the tracked `adbQuery` -- `/status` and `/discovery` go live
- [ ] `tools/hub-api/readings.mjs` -- `track`/`trackLost`, live serving, and a probe that skips live ids -- `/resources` goes live, and events have one writer
- [ ] `tools/hub-api/track.mjs` -- `createTrack` -- the one socket and its open, close and stop rules
- [ ] `tools/hub-api/server.mjs` -- `onRequest`, `onStop`, the track wiring and the seam default -- reopened only by a request
- [ ] `tools/device/track-devices.test.mjs` (new) -- the Wire request row (fake socket: chunking, FAIL, refused, handshake silence, `close()`), plus one `fakeAdbServer` run whose `requests` equals `['host:track-devices-l']` -- AC1
- [ ] `tools/hub-api/track.test.mjs` (new) -- the remaining matrix rows. Unit rows use real `createSnapshot`/`createReadings` with a fake `observe`, a recording `note` and a fake `open`. Service rows use `startHubApi` with a FakeServer listener and a fake `trackDevices` -- AC2-AC5
- [ ] `docs/hub-api-contract.md`, `README.md` -- `source: track`, and one Hub API sentence on the track socket -- the contract stays equal to the code
- [ ] verification -- `heavy mise run check`

**Acceptance Criteria:**
- Given `node --test tools/device/track-devices.test.mjs`, when the wire test runs, then `trackDevices` sends only `host:track-devices-l` on the given port, and `adb-wire.mjs` imports no `node:child_process`.
- Given a running Hub API whose snapshot shows the hub's adb server, when it starts, then exactly one track socket is open, and `/status` and `/resources` show its readings as current, `source: track`.
- Given that socket closes, when the next requests arrive, then one `track-lost` event per tracked Resource was written, readings come from the probe, and exactly one new socket is opened by the first request and by nothing else.
- Given a pushed state change, when `/status` is read next, then the change shows, and exactly one `reachability` event was appended through `noteReachability`.
- Given HEAD, when `heavy mise run check` runs, then it is green with tools/clock.test.mjs unchanged, and every existing test passes unchanged.

## Spec Change Log

## Review Triage Log

### 2026-11-25 — Review pass
- verdicts: 36 findings — high 0, medium 1, low 27, false 8, maybe-false 0
- findings:
  - `low` `patch` (Blind) The `trackDevices:` entry in `createAdbWire` separated `shell` from its comment. — Moved the entry, with its own comment, above the shell comment.
  - `low` `patch` (Blind) A close before OKAY reached `onClose` as `{opened: false, error: null}`, which reads as a clean close. — A pre-OKAY close now carries "closed the connection before answering host:track-devices-l". A fake-socket assertion was added.
  - `low` `patch` (Blind) The FAIL length was parsed with a bare `parseInt`, so `FAIL12zz` read as 0x12. — It is now held to the same 4-hex-digit rule as a frame length, and malformed is the malformed-FAIL error. Assertion added.
  - `low` `reject` (Blind) A socket that never opens leaves no log line, and every request retries silently. — This only happens with an adb that FAILs `host:track-devices-l`, which no current adb does. Each retry is one refused loopback connect. A rate limit or failure memory adds state for a case nobody meets.
  - `low` `reject` (Blind) A silent socket is taken as proof the state holds, with no keepalive, so a wedged server reads current. — AD-35 and the story's AC2 mandate this: while the socket is open its readings are current. A liveness probe would be the timer the AC forbids.
  - `false` `reject` (Blind) `snapshot.read().adb.listed` differs from `adbQuery()` while tracking, so a `read()` consumer sees older data. — The only production reader of `read()` is track.mjs, and it reads `inventory` and `serials`, never `listed`. Every route reads adb through `adbQuery`.
  - `low` `patch` (Blind) `track()` dropped an uncovered id from `live` but kept its stored `source: 'track'` reading. — Now `stored.delete(id)` too, so the next read probes it. There is a new unit row (shrinking `records()`).
  - `low` `reject` (Blind) The `faked` denylist could let a future test reach the real 5037. — Every current `startHubApi` test sets `HOME` to a scratch dir, so `hostKey` throws and `ensure()` never opens. The track also requires the inventory to list the hub port. Neither guard is reached today, and an opt-in flag is new surface.
  - `low` `patch` (Blind) The `afterBind` chain had no rejection handler, and `records()` reads `registry.json` on each push. — The chain now starts with `Promise.resolve().then(...)` and has a `.catch` that logs one `HUB_API_TRACK_FAILED` line. The registry read half is rejected: it is the same small sync disk read every request already makes, and Story 8.2 keeps disk reads on the request path.
  - `low` `reject` (Blind) `snapshot.track`, `adbStateOf` and `noteChange`'s non-true branch have no direct unit tests. — They are exercised through track.test.mjs's unit and service rows, and `adbStateOf` through every existing status test (an unchanged mapper).
  - `low` `reject` (Blind) The tests are brittle: a source grep for child_process, and real-timer settles. — The grep is the AC's own check. The 20 ms handshake timer always expires before the 60 ms settle timer, because node fires timers in expiry order.
  - `low` `reject` (Blind) There is no contract bump for the `track` source and reasons, and `HUB_API_TRACK_FAILED` is undocumented. — The epic says fields are only added and `CONTRACT_VERSION` is unchanged, and the contract doc now lists `track`. Its sibling log lines (`HUB_API_REACHABILITY_FAILED`, `HUB_API_OBSERVE_FAILED`) are not listed either.
  - `low` `patch` (Blind) The `onRequest` sentence was spliced into the `requestListener` comment as one overlong line. — Rewrapped.
  - `low` `patch` (Edge) A `records()` throw after `snapshot.track(listed)` left `/status` on the new listing and `/resources` on the old live states. — The mapping is computed first, and both caches are updated only after it succeeds. The throw test now asserts that the snapshot did not take the listing.
  - `low` `reject` (Edge) A registry edit (a serial change) while the socket is open, with no push after it, keeps the old mapping live. — A serial edit of a live phone is rare, and the next push or reconnect remaps it. A newly added phone is not live, so it is probed through the live listing. A re-map on registry rev adds a watcher this story does not own (Story 8.5).
  - `low` `patch` (Edge) An uncovered id keeps an orphaned `source: track` reading. — Same root cause as the Blind `track()` row, and fixed there.
  - `low` `reject` (Edge) An adb server that refuses or FAILs dials a new socket on every request, unlogged. — Same root cause as the Blind never-opened row, and rejected with it.
  - `low` `reject` (Edge) A flapping endpoint makes each push trigger a gather. — The spec mandates one refresh per update, and the snapshot is single flight, so gathers are bounded by the push rate and never overlap.
  - `low` `patch` (Edge) The FAIL length parse is lenient. — Same root cause as the Blind FAIL row, and fixed there.
  - `false` `reject` (Edge) If `parseDevicesLong` or `onDevices` throws, a push is silently dropped. — `parseDevicesLong` is total over a string: it splits and maps, with no throwing path. track.mjs guards `onDevices` and logs a throw as `HUB_API_TRACK_FAILED`.
  - `false` `reject` (Edge) `createAdbWire(port, {signal})` ignores the signal for `trackDevices`. — No caller passes a signal to a wire it tracks on: the service calls the bare `trackDevices(port, handlers)`, and its stop closes the handle.
  - `low` `patch` (Edge) A rejecting injected `snapshot.refresh` is an unhandled rejection. — Same root cause as the Blind afterBind row, and fixed there.
  - `low` `reject` (Edge) The default `open` is real unless a test fakes the host, so a test with only real observation could dial 5037. — Same root cause as the Blind denylist row, and rejected with it: scratch `HOME` makes `hostKey` unknown in every such test.
  - `low` `reject` (Edge) A probe started before the socket that resolves after `trackLost` stores an older state. — Its `checked_at` is the probe's own start time, so its age is honest, and the next probe or push corrects it. Guarding needs a generation stamp for a three-event race.
  - `low` `patch` (Edge) The shell comment was displaced. — Same root cause as the Blind comment row, and fixed there.
  - `low` `patch` (Edge) A live reading is shown current after a failed map or a registry change. — The failed-map half shares a root cause with the Edge records()-throw row and is fixed there. The registry-change half is rejected with the registry-edit row.
  - `low` `patch` (Verification gap) No test exercises the prune of an uncovered live id. — Added the shrinking-`records()` unit row. Mutation-proof: without `stored.delete` the dropped id serves `source: track`.
  - `medium` `patch` (Verification gap) No test runs `startHubApi`'s default track wiring. — Added a service row with `fakeHub`: a loopback adb-protocol server plus a decoy `adb … server` that the real `/proc` inventory finds. Only `hostKey` is injected. It asserts exactly one `host:track-devices-l`, and a push reaching `/status` and `/resources`. The implementer mutation-checked it: a null default `open` fails the row.
  - `low` `patch` (Verification gap, other) The shell comment was displaced. — Same root cause as the Blind comment row, and fixed there.
  - `low` `reject` (Verification gap, other) The child_process check is source text. — The AC names that exact check, and the behaviour is separately proven by the real-socket refused-port and `requests` rows.
  - `false` `reject` (Intent) `source: track` is visible only on `/resources`, not on `/status`. — No `/status` row has ever carried a `source` key. The status reachability shape is `{state, checked_at, age_ms, stale}`, and a new key is out of scope. "Current" on `/status` is `age_ms: 0, stale: false`, which the service rows assert.
  - `false` `reject` (Intent) Two caches, not one cached reading. — One `onDevices` feeds both, after one mapping, and tests assert `/status` and `/resources` agree after each push. No reader sees a different state.
  - `false` `reject` (Intent) The `reason: track` is an inference, and the first push logs unchanged phones with `from: null`. — The first reading logged with `from: null` is the existing probe convention (contract doc). AC4 names no reason, and `track` mirrors `probe`.
  - `false` `reject` (Intent) "Per Resource" is read as per tracked Resource. — Only own-host phones have an adb reading. `ios-lane` and the emulator Pool are never read over adb, so they have nothing to lose.
  - `low` `reject` (Intent) No real-wire test of a request reopening after a drop. — The reopen rule lives in track.mjs and is proven with the fake seam. The real-wire rows prove open, push and drop to `track-lost`, so the join is covered on both sides.
  - `false` `reject` (Intent) The handshake timer could count as a timer. — It is a one-shot, `unref`ed bound in `tools/device/`, which tools/clock.test.mjs allows. It is cleared on OKAY and never reopens anything.

## Design Notes

Why live readings are stamped at read time: adb pushes a listing on every change while the socket is open, so a silent socket means the state still holds. Serving the stored update time would make an unchanged phone read stale after 60 s. That would start probes, which the track exists to replace. The stamp is derived from `now` when the reading is served and is never stored.

Why `to: 'unknown'` on `track-lost`: once the socket is gone nobody is watching. The cache drops the reading, so the row shows `unknown` until the probe answers, and the event says the same thing. The next probe or track reading then logs `unknown -> <state>`.

Why the snapshot carries the listing: `statusView`, `discover` and `phoneReadings` already read adb only through `adbQuery`. Swapping the answer behind that seam makes `/status`, `/discovery` and `presence` live with no change to the Claims library's views.

## Verification

**Commands:**
- `node --test tools/device/track-devices.test.mjs tools/hub-api/track.test.mjs tools/hub-api/snapshot.test.mjs tools/hub-api/reachability-discovery.test.mjs tools/hub-api/status.test.mjs tools/hub-api/event-loop.test.mjs` -- expected: all pass
- `heavy mise run check` -- expected: green

## Auto Run Result

Status: done

**Summary:**
- The Hub API holds one `host:track-devices-l` socket on the hub's adb server.
  - It opens after the first host gather, and again on a request. It opens only when the snapshot inventory shows the hub's server, and never through a timer or a server start.
  - Each push is mapped by the same function the probe uses (`claims.adbStateOf`). It then feeds two caches every reader already uses:
    - the host snapshot's adb half, which serves `/status`, `/discovery` and `presence`;
    - the readings cache, which serves `/resources` and Pool matching, and is the single `noteReachability` writer.
  - While the socket is open, phone readings are current (`source: track`, age 0, stamped when served).
  - When it closes, the service writes one `track-lost` event per tracked Resource (`to: unknown`) and falls back to the probe. The next request reopens it.
  - A stop closes the socket and writes nothing.
- Belsky one level up: this covers every own-host phone Resource, including registered `res-*` phones, on every route, and not just the S26 on `/status`.

**Files changed:**
- `tools/device/adb-wire.mjs`: a streaming `trackDevices` (one frame, chunked parsing, `onClose` exactly once, a 5 s handshake bound, `unref`, no reconnect), plus a `createAdbWire().trackDevices` method.
- `tools/device/wire-fixtures.mjs`: `fakeAdbServer` answers `host:track-devices-l`, with `push`/`dropTracks`.
- `tools/device/claims.mjs`: the exported `adbStateOf` mapper, used by `phoneObservations` (same answers).
- `tools/hub-api/snapshot.mjs`: `track`/`untrack`. A tracked `adbQuery` returns the pushed listing with `checked_at: now()`.
- `tools/hub-api/readings.mjs`: `track`/`trackLost`.
  - Live readings are served current.
  - A probe never overwrites a live reading.
  - An uncovered id drops back to the probe.
- `tools/hub-api/track.mjs` (new): `createTrack`, which covers the open, close, stop and endpoint-serial chase rules.
- `tools/hub-api/server.mjs`: the `onRequest` hook in `requestListener`, `startService`'s `onStop`, the track wiring and the seam default (null when a test fakes the host).
- `tools/device/track-devices.test.mjs` (new) and `tools/hub-api/track.test.mjs` (new): every matrix row, plus real-socket rows and the default-wiring row.
- `docs/hub-api-contract.md`, `README.md`: `source: track`, live while open, and `track-lost`.

**Review findings breakdown (36: high 0, medium 1, low 27, false 8, maybe-false 0):**
- **Patched (8 entries, 15 rows):**
  - medium (1): a test now exercises the default track wiring.
  - low (7):
    - the shell comment;
    - an error on a close before OKAY;
    - the FAIL length is validated;
    - an uncovered live id drops its stored reading;
    - the mapping runs before either cache is updated;
    - a `.catch` on the `afterBind` chain;
    - the comment rewrap.
- **Deferred:** none.
- **Rejected (21: 13 low, 8 false):**
  - low (13):
    - a silent retry when the socket never opens (2 rows);
    - a wedged server reads as current (mandated by AD-35);
    - the `faked` denylist (2 rows; scratch `HOME` keeps tests hermetic);
    - no direct unit tests for the new exports;
    - test brittleness;
    - contract and doc versioning (fields are only added);
    - a registry edit with no push after it (rare; a watcher belongs to 8.5);
    - a flapping endpoint (single-flight, spec-mandated);
    - a probe that resolves after `trackLost` (honest age);
    - the child_process source check (the AC's own check);
    - no real-wire reopen test (both halves covered).
  - false (8):
    - `read()` vs `adbQuery` (no consumer of `listed`);
    - `parseDevicesLong` throwing (it is total);
    - the ignored wire signal (no caller passes one);
    - no `source` on `/status` (no such key);
    - two caches (one mapping feeds both);
    - the `reason: track` inference (existing convention);
    - per-Resource scope (only adb phones are read);
    - the handshake timer (allowed one-shot).

**Follow-up review recommendation: false.** This was the first pass. It patched 0 high and 1 medium entry, plus 7 low, which is below the threshold. No unverified risk remains that a pass could name.

**Verification:**
- `node --test tools/device/track-devices.test.mjs tools/hub-api/track.test.mjs tools/hub-api/snapshot.test.mjs tools/hub-api/reachability-discovery.test.mjs tools/hub-api/status.test.mjs tools/hub-api/event-loop.test.mjs`: 87/87 pass.
- `heavy mise run check` (actionlint and the full suite): green, 1522/1522. That is 35 new tests on top of 1487.
- Mutation checks:
  - removing the probe-skips-live guard fails a unit row;
  - dropping the faked-host null default fails the faked-host row;
  - a null default `open` fails the default-wiring row;
  - dropping the prune's `stored.delete` fails the shrinking-records row.
- Matrix audit: every row (Wire request, Connect, Unauthorized/drop, Close, No server, Stop, Endpoint) has a covering test that ran and passed.
- No operator action is owed: every AC is in-repo. The live socket on big-chungus arrives with Story 8.7's release and `hosts:install`.

**Residual risks:**
- A wedged adb server that keeps the socket open would keep readings current. This is AD-35's accepted trade-off: there is no keepalive, because that would be a timer.
- The default-wiring and real-socket rows use real loopback sockets, and a decoy process that the real `/proc` inventory reads. They never touch 5037.
- A registry serial edit of a live phone is picked up only at the next push or reconnect.
