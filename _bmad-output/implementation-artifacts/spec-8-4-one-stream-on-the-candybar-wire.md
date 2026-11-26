---
title: 'Story 8.4: One stream on the Candybar wire'
type: 'feature'
created: '2026-11-25'
status: 'done'
baseline_revision: '2854b9fe042996ccacf162a8229b1eca19f566be'
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-8-context.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-8-3-live-reachability-from-one-adb-socket.md'
warnings: ['oversized']
deferred: []
---

<intent-contract>

## Intent

**Problem:** The Hub API has no `GET /stream`. Holocene's future board would have to poll `/status`, or invent a second wire format beside the Candybar SSE wire it already proxies (FR-14, AD-43).

**Approach (`belsky-doctrine`, one level up from "a `/stream` route on the Hub API": any streaming route of any hub service).** A new `tools/hub-api/stream.mjs` is a service-agnostic Candybar-wire hub. It mints the boot id, keeps a ring of frames, plans resumes, writes frames, and gives each connection its own keepalive. `routes.mjs`'s envelope learns one generic kind, the streaming route, so the Host Agent (Epic 9) gets SSE from the same `handle()`. The Hub API mounts `GET /stream` on it. Its openings carry the one `statusDocument(ctx)`, and Story 8.5's watcher calls `stream.status(doc)` / `stream.event(entry)` to emit.

## Boundaries & Constraints

**Always:**
- Node 24 ESM `.mjs`, `node:` builtins only. Tests are hermetic (`hermetic()`): a fake clock, fake timers, a fake response, no port and no real adb.
- **Wire** (`stream.mjs` exports `STREAM_HEADERS`, `RETRY_MS = 3000`, `RING_SIZE = 1024`, `ID_PATTERN = /^[0-9a-f]{12}-[0-9]+$/`, `mintBoot()`, `createStream`):
  - Headers: `Content-Type: text/event-stream`, `Cache-Control: no-store`, `X-Accel-Buffering: no`.
  - The first bytes on every connection are `retry: 3000\n\n`.
  - A frame is `id: <boot>-<seq>\nevent: <type>\ndata: <one-line JSON>\n\n`. The JSON starts with `type`, `seq`, `key`, `at` (ISO).
  - A keepalive is the comment `: keepalive\n\n`, with no id.
- **`createStream({boot = mintBoot(), now = Date.now, ringSize = RING_SIZE, keepaliveMs, timers = {setInterval, clearInterval}, maxBufferedBytes = 8 MiB})`** returns `{boot, cursor(), status(doc), event(entry), plan(lastEventId), attach(sink, opening), close(), closed, subscribers()}`:
  - `boot` is 12 lowercase hex characters (`randomBytes(6)`).
  - `status(doc)` and `event({id, event})` each take the next `seq` (from 1), append one frame to the ring, drop the oldest frame past `ringSize`, and write the frame to every attached sink. The payloads:
    - `status`: `{type:'status', seq, key:'status', at: now, status: doc}`.
    - `event`: `{type:'event', seq, key: id, at: event.ts ?? now, event_id: id, event}`.
    - An `event` entry whose `id` is not a non-empty string is a TypeError, and nothing is emitted.
  - `plan(lastEventId)` returns `{kind: 'ready'}` when the id is missing or blank. It returns `{kind: 'resume', after: n}` when the id matches `ID_PATTERN`, its boot is this boot, and `floor ≤ n ≤ cursor()`, where `floor` is the oldest ring seq − 1, or `cursor()` when the ring is empty. Anything else returns `{kind: 'reset'}`.
  - `attach(sink, {kind, after, status})` is synchronous: it registers the sink and takes the replay in one step, so nothing is lost or written twice. It writes `retry: 3000\n\n`. For `ready` and `reset` it then writes one opening frame, `id: <boot>-<after>`, with `{type, seq: after, key: type, at, ...(reset ? {reason: 'unresumable'} : {}), status}`. It then writes every ring frame with `seq > after`. An opening frame is never put in the ring.
  - Each sink has its own keepalive. One `timers.setInterval(keepaliveMs)` is (re)armed after every write to that sink (the interval is unref'd), so a keepalive goes out whenever `keepaliveMs` passes with no bytes sent. A sink's `close` event, `close()`, or a sink whose `writableLength` passes `maxBufferedBytes` (which is destroyed) clears its interval and detaches it.
  - `close()` ends every sink, clears every interval and sets `closed`. After it, `status` and `event` emit nothing.
- **Envelope** (`routes.mjs`, generic over any route table):
  - A route row may carry `stream: true`. Its handler returns `streamReply(open)`.
  - `handle()` answers it as `{status: 200, headers: {...BASE_HEADERS, ...STREAM_HEADERS}, stream: {open}}`, with no `body`.
  - Dispatch (404, 405, problem+json) is unchanged.
  - `handle()` takes `headers` (the request's, lower-cased) and hands them to the handler.
- **`GET /stream`** (`shape: 'StreamFrame'`):
  - `ctx.stream` missing is a 500 `HUB_API_ERROR`. `ctx.stream.closed` is 503 `HUB_API_RESTARTING`, `retry: requeue` (claims.mjs exports `restartingError`).
  - Otherwise the handler plans from `headers['last-event-id']`. For `ready` or `reset` it takes `after = cursor()` first, then awaits `statusDocument(ctx)`: a 503 `HUB_HOST_UNKNOWN` answers as a problem, and no stream is opened. For `resume` it does neither.
  - It returns `streamReply(sink => ctx.stream.attach(sink, {...plan, after, status}))`.
- **`requestListener`**: for an answer with `stream`, it calls `res.writeHead(status, headers)` with no Content-Length, then `answer.stream.open(res)`. The request's work ends there, so `drain()` never waits on a stream. An answer for a request already aborted is dropped as before.
- **`startHubApi`** builds one stream at start: `createStream({now, keepaliveMs: policy.api.stream_keepalive_s * 1000})`, or a `stream` seam. It goes into the request context, and `onStop` calls `stream.close()` after `track.stop()`, so a stop never hangs on an open subscriber.

**Never:**
- Emit a `status` or `event` frame from a watcher, a timer or a poll in this story (Story 8.5 owns the change sources), or emit one for a change that only time causes.
- Add a `setInterval` or `setTimeout` outside `stream.mjs` in `tools/hub-api/`, or a self-rescheduling `setTimeout` (tools/clock.test.mjs stays unchanged except for its stale comment).
- Change an existing route, a response key, `CONTRACT_VERSION`, the on-disk layout, an event key or `policy.json`.
- Touch the deploy path, `AGENTS.md`/`CLAUDE.md` or `sprint-status.yaml`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Ready | no `Last-Event-ID`, cursor 2 | headers as above. `retry: 3000`. A `ready` frame with id `<boot>-2` carrying the whole `/status` (it equals a `GET /status` key set). Then nothing until a new frame | — |
| Exact resume | `Last-Event-ID: <boot>-3`, ring 1..5 | `retry: 3000`, then frames 4 and 5 only, with no opening frame. `statusDocument` is never called | — |
| Resume at cursor | `<boot>-5`, cursor 5 | only `retry: 3000` | — |
| Reset: boot | another boot, or a malformed id (`abc`, `<boot>-x`, `<boot>-9` above the cursor) | a `reset` frame with `reason: unresumable` and the whole `/status`, id `<boot>-<cursor>` | — |
| Eviction | ringSize 4, frames 1..10 emitted | ring holds 7..10. `<boot>-6` resumes with 7..10. `<boot>-5` gets `reset`. At the default size, 1030 frames keep exactly 7..1030 | — |
| Live fan-out | two sinks attached; `status(doc)`, then `event({id:'h/2026-11/0', event:{ts,…}})` | both sinks get seq 1 (`status`), then seq 2 (`event`, `key` = `event_id` = the id). Each `data:` is one line | an entry with no id: TypeError, cursor unchanged |
| Keepalive | keepaliveMs 15000, fake timers; a frame written at t=10 s | `: keepalive` at 25 s and 40 s, and none before 25 s. The sink closes, so its interval is cleared and nothing more is written | — |
| Slow client | sink `writableLength` past the bound | the sink is destroyed and detached. The others still get frames | — |
| Stop | SIGTERM with a subscriber open | the subscriber's response ends. `HUB_API_STOP` is printed. A later `GET /stream` gets 503 `HUB_API_RESTARTING` | — |
| Host unknown | `hostKey` throws, no `Last-Event-ID` | 503 `HUB_HOST_UNKNOWN` problem+json, and no stream | — |

</intent-contract>

## Code Map

- `tools/hub-api/routes.mjs`:
  - `BASE_HEADERS` (L34), `REPLY`/`reply` (L37-38), `respond` (L40) and `problem` (L59) are the envelope. Add a `STREAM` marker and `streamReply` beside `reply`.
  - `statusDocument` (L175-198) is the one `/status` builder. Its comment at L174 already names Story 8.4.
  - `handle` (L420-455) gains `headers` in its request object and in the handler's argument. In the `try` (L442-448) a stream route's marker becomes the stream answer.
  - The `ROUTES` table is L370-388. Add `GET /stream` after `GET /status`.
  - `HOST_UNKNOWN` is at L146.
- `tools/hub-api/server.mjs`:
  - `requestListener` (L80-101): its `work` closure writes JSON at L92-94. Branch for `answer.stream` there, and pass `headers: req.headers` into `handle` (L90).
  - `startHubApi` (L175-214): build the stream next to `track` (L212). Add it to `ctx` and to `onStop` (L213).
  - The header comment at L11-12 names stream.mjs as the future keepalive home. Update it.
- `tools/hub-api/stream.mjs` (new): modelled on `~/code/33GOD/candybar/src/candybar/api/stream.py` (`_resume_after` L493-501, `_attach` L503-516, `frames` L518-536, `sse_frame` L123-132), which is the wire Holocene's proxy (`holocene/apps/api/src/candybar.ts` L1088-1124) already pipes through. Two differences from Candybar: `Cache-Control: no-store`, and there is no window filter.
- `tools/device/claims.mjs` L887 `restartingError`: export it for the closed-stream 503.
- `tools/ci/lib/events.mjs` L156 `readEventsFrom` yields `{id, offset, event}` entries. That is the shape `stream.event` takes (8.5 feeds it). Event bodies are allowlisted by their writers, with no serials (lock.mjs L218-275), so an event frame needs no QA redaction.
- `tools/clock.test.mjs` L1-16: `CLOCK_FILES` already lists `tools/hub-api/stream.mjs`. Only the "not yet written" comment changes.
- `tools/ci/policy.json` L61: `api.stream_keepalive_s: 15`. It is parsed strictly (≤ 30) by `tools/ci/lib/policy.mjs` L320.
- `tools/hub-api/contract.test.mjs`:
  - `callGet` is at L237. The GET-route loops are at L324 ("each GET route…") and L441 (snake_case). Both filter out `route.stream`.
  - The `scratch()` ctx (L252-259) gains a `stream`.
  - Add one stream test: drive `handle` for `GET /stream` into a fake sink, emit `status` and `event`, force a `reset`, then compare the union of the parsed frame payloads' key sets with `### StreamFrame`, and each frame's `status` with `### Status`.
- `docs/hub-api-contract.md`:
  - Route table (L24-41): add `| GET | \`/stream\` | StreamFrame | 8.4 |`.
  - Add a `### StreamFrame` section after `### Status` (L143). It lists the wire (headers, `retry`, id rule, types, ring, resume, reset → refetch `/history`, keepalive) and the fields `type`, `seq`, `key`, `at`, `reason`, `status.*`, `event_id`, `event.*`.
  - Add `HUB_API_RESTARTING`'s stream case to its error row (L488).
- Test scaffolds: the FakeServer/`exchange` pattern in `tools/hub-api/event-loop.test.mjs` L30-68. The fake res there needs `write`, `destroy` and `writableLength` for streams.

## Tasks & Acceptance

**Execution:**
- [ ] `tools/hub-api/stream.mjs` -- `createStream`, `mintBoot` and the wire constants -- the one Candybar-wire hub
- [ ] `tools/device/claims.mjs` -- export `restartingError` -- one restarting error for waits and streams
- [ ] `tools/hub-api/routes.mjs` -- `streamReply`, a stream route in `handle`, `headers` passed through, and the `GET /stream` route and handler -- a generic streaming route for every route table
- [ ] `tools/hub-api/server.mjs` -- the stream branch in `requestListener`, and the stream in `startHubApi`'s ctx and `onStop` -- mounted, and closed on stop
- [ ] `tools/hub-api/stream.test.mjs` (new) -- every matrix row: unit rows on `createStream` with fake timers and sinks, and service rows through `startHubApi` with a FakeServer (ready, host unknown, stop) -- AC1-AC4
- [ ] `tools/hub-api/contract.test.mjs` -- skip stream routes in the GET JSON loops, and add the StreamFrame key-set test -- the contract stays equal to the code
- [ ] `docs/hub-api-contract.md`, `README.md` -- the `/stream` route and shape, plus one Hub API sentence -- the contract doc lists `/stream`
- [ ] `tools/clock.test.mjs` -- comment only -- stream.mjs now exists
- [ ] verification -- `heavy mise run check`

**Acceptance Criteria:**
- Given `GET /stream` through `startHubApi`'s listener, when it answers, then the head is 200 with `Content-Type: text/event-stream`, `Cache-Control: no-store` and `X-Accel-Buffering: no`, the body starts with `retry: 3000`, and every frame id matches `^[0-9a-f]{12}-[0-9]+$` with the service's boot.
- Given a connection with no `Last-Event-ID`, when it opens, then it gets `ready` carrying a document whose key set equals `GET /status`'s, and the hermetic suite covers ready, exact resume, reset, eviction and the keepalive with fake timers and a fake response.
- Given a subscriber and a SIGTERM, when the service stops, then the subscriber's response is ended, `stopped` resolves, and no interval is left armed.
- Given HEAD, when `heavy mise run check` runs, then it is green, `tools/clock.test.mjs` passes with only its comment changed, and the contract test holds the document's `StreamFrame` and route table equal to the code.

## Spec Change Log

## Review Triage Log

### 2026-11-25 — Review pass
- verdicts: 27 findings — high 0, medium 1, low 12, false 14, maybe-false 0
- findings:
  - `false` `reject` (Blind) Nothing in production calls `stream.status()`/`stream.event()`, so a live stream only sends openings and keepalives. — By design. Story 8.5 owns the change sources (the watcher and debounce), and Story 8.7 ships 8.4 and 8.5 together. The contract describes the wire, not a producer.
  - `low` `patch` (Blind) The 8 MiB slow-client check also ran during the opening replay, so a resume whose replay of whole-status frames passed 8 MiB was destroyed on every reconnect with the same id. — The replay writes of `attach` are now unbounded, and the bound applies to live frames and keepalives only. There is a new test: a large replay is delivered, and a later live frame still drops the sink.
  - `low` `patch` (Blind) The slow-client threshold was undocumented. — The contract now says "more than 8 MiB buffered", and that the opening replay is not held to it.
  - `false` `reject` (Blind) A missing `api.stream_keepalive_s` gives a NaN interval. — `policy.mjs` parses the `api` block strictly (`exact`, an integer from 1 to 30), and every caller passes a loaded policy, so the key cannot be missing.
  - `low` `patch` (Blind) The "built from the policy" test never checked the keepalive. — Same root cause as the Verification-gap finding below, and fixed there.
  - `false` `reject` (Blind) Real HTTP is unproven, and `server.close()` might wait on an open stream. — `startService`'s stop awaits `onStop` (which calls `stream.close()`) before `server.close()`, and `writeHead` followed by `write` is standard node http.
  - `false` `reject` (Blind) The sink has no `error` listener, so a write after a disconnect is an uncaught exception. — A probe against real node 24 `http` (writes inside the socket's close handler, and a write after `end`) returned `false` and emitted nothing uncaught.
  - `false` `reject` (Blind) A reset points clients at a `/history` route that does not exist. — The AC names `/history`, it is Epic 10's story (epics-v1b L1625), and the contract already says it is not in the contract yet.
  - `false` `reject` (Blind) There is no query-parameter fallback for `Last-Event-ID`. — The Candybar wire resumes on the header, and Holocene's proxy turns its own `after` into that header (candybar.ts L1092-1106).
  - `low` `patch` (Blind) The README stream sentence was spliced into the readings sentences, and "will carry" was future tense. — The sentence was moved after the `receive` sentence, and the builder sentence is now present tense.
  - `low` `patch` (Blind) Test hygiene: a no-op `continue`, the contract test's `close()` sitting outside `finally`, and a duplicated JSON stub. — The first two were fixed. The duplicated stub was rejected: it is a cosmetic refactor of test-only code.
  - `false` `reject` (Blind) `STREAM_HEADERS` repeats `Cache-Control`, and `Content-Type` has no charset. — The AC names exactly `text/event-stream` and `no-store`. The module states its own headers so it stays service-agnostic, and `{...BASE_HEADERS, ...STREAM_HEADERS}` yields the same value.
  - `low` `reject` (Blind) `event()` validates even when closed, and `status()` accepts anything. — An id-less event is a caller bug and should throw loudly. Both are unreachable from the route, and changing them adds branches for nobody.
  - `low` `patch` (Edge) `emit` advanced the cursor before serialising, so a payload JSON rejects left a seq gap. — `seq = last + 1`, then the text is built, then `last = seq`. A test was added.
  - `low` `patch` (Edge) `close()` only ends a sink whose client stopped reading, so its socket could keep `server.close()` waiting. — A sink with `writableLength > 0` after `end()` is now also destroyed. The close test asserts it.
  - `low` `reject` (Edge) More than 1024 frames emitted while `statusDocument` is awaited would be lost. — With 8.5's 250 ms debounce that needs over 1024 frames inside one sub-200 ms read. That is unreachable, and the guard is a new branch.
  - `false` `reject` (Edge) A `close()` between the plan and `open` gives a 200 with an empty body. — Between `handle` resolving and `open` there are only microtasks, and a stop arrives as a signal (a macrotask). The ready/reset path re-checks `closed` after its one real await.
  - `low` `reject` (Edge) A client whose writes return false below 8 MiB holds its buffer and interval. — That is the designed bound: the connection is freed by its close or by the bound, and a dead peer is reaped by TCP.
  - `low` `patch` (Edge) The contract said every host-unknown open is 503 with no stream, but an exact resume never reads the host key. — The doc now limits it to connections that need the document.
  - `false` `reject` (Edge) The README and contract claim live `status`/`event` frames that nothing emits. — Same root cause as the first Blind row: 8.5 is the producer and ships in the same release.
  - `medium` `patch` (Verification gap) No test tied `api.stream_keepalive_s` to the default stream's interval, so a dropped `* 1000` would ship silently. — The default-stream row now boots `startHubApi` with `stream_keepalive_s: 7` and `mock.timers` on `setInterval`. It asserts no keepalive at 6999 ms and one at 7000 ms.
  - `false` `reject` (Verification gap, other) Nothing feeds the stream. — Same root cause as the first Blind row.
  - `false` `reject` (Verification gap, other) No real-socket test. — Same root cause as the Blind real-HTTP row. The service tests follow the repo's FakeServer convention ("never by binding a real port in the shared suite").
  - `false` `reject` (Intent) The frame producers are missing (reading C). — Story 8.5's ACs own the change-to-frame path, so reading A is the story's.
  - `low` `reject` (Intent) Nothing mechanically checks compatibility with Candybar's `stream.py`. — A test that imports another repo would break hermeticity. The wire is pinned by this repo's tests and contract, and was modelled line by line on `stream.py`.
  - `false` `reject` (Intent) `Cache-Control: no-store` differs from Candybar's `no-cache`. — The AC mandates `no-store`. Holocene's proxy sets its own headers, and EventSource ignores the field.
  - `false` `reject` (Intent) The service rows use a FakeServer. — Same root cause as the Blind real-HTTP row.

## Design Notes

Why an opening frame names the cursor and takes no seq: this is Candybar's rule. A `ready` or `reset` frame is per connection, so putting it in the ring would replay one client's opening to another. Its id `<boot>-<cursor>` is the resume point. Before the first frame that is `<boot>-0`, which matches the id pattern, and resuming from it replays seq 1 onward. Ring frames are numbered from 1.

Why `after` is taken before the status document: `statusDocument` awaits, and frames can be emitted meanwhile. Because the cursor is captured first and every ring frame after it is replayed, a frame emitted during that await is never lost. Frames carry absolute state, and clients dedupe events on `event_id`, so a frame that overlaps the document is harmless.

Why the interval is re-armed on every write: "whenever the interval passes with no bytes sent" then holds exactly. One `setInterval` per connection is what AD-19 allows, and `stream.mjs` is the one file `CLOCK_FILES` names for it. A re-armed one-shot `setTimeout` would look like a hand-made interval to the self-rescheduling check.

## Verification

**Commands:**
- `node --test tools/hub-api/stream.test.mjs tools/hub-api/contract.test.mjs tools/hub-api/server.test.mjs tools/hub-api/status.test.mjs tools/clock.test.mjs` -- expected: all pass
- `heavy mise run check` -- expected: green

## Auto Run Result

Status: done

**Summary:**
- The Hub API serves `GET /stream` on the Candybar SSE wire:
  - Headers: `text/event-stream`, `Cache-Control: no-store`, `X-Accel-Buffering: no`.
  - Every connection starts with `retry: 3000`.
  - Frame ids are `<boot>-<seq>`, with a 12-hex boot minted at start and `seq` counted from 1.
  - Payloads are one-line JSON starting with `type`, `seq`, `key` and `at`.
  - A connection without `Last-Event-ID` gets `ready` with the whole `/status`.
  - An exact resume replays strictly after its id.
  - An unknown boot, a malformed id, or an evicted or future seq gets `reset` (`reason: unresumable`, with the whole `/status`).
  - The ring keeps the last 1024 frames of the boot.
  - Each connection has its own keepalive: one `setInterval` per connection, re-armed after every write and cleared with the connection.
  - A stop ends every stream, and a later `GET /stream` is 503 `HUB_API_RESTARTING`.
- Belsky one level up: `tools/hub-api/stream.mjs` is service-agnostic, and `routes.mjs`'s envelope gained a generic streaming-route kind (`stream: true` plus `streamReply`). Any hub service's route table, including the Host Agent in Epic 9, gets SSE through the same `handle()`. Story 8.5 only needs to call `stream.status(doc)` / `stream.event(entry)`.

**Files changed:**
- `tools/hub-api/stream.mjs` (new): `createStream`, `mintBoot` and the wire constants. It covers the ring, resume planning, the synchronous attach-and-replay, the per-connection keepalive, the slow-client bound and close.
- `tools/hub-api/routes.mjs`: `streamReply`, the stream-route answer in `handle()`, request `headers` passed through, and the `GET /stream` route (`streamRoute`, which takes the cursor before it awaits `statusDocument`).
- `tools/hub-api/server.mjs`: `requestListener` writes a stream head and opens it, so `drain()` never waits on it. `startHubApi` builds one stream from `api.stream_keepalive_s` (with a `stream` seam) and closes it in `onStop`.
- `tools/device/claims.mjs`: exports `restartingError`.
- `tools/hub-api/stream.test.mjs` (new): unit, envelope and service rows for every matrix row.
- `tools/hub-api/contract.test.mjs`: the GET JSON loops skip stream routes, and a new StreamFrame key-set test compares each frame's `status` with `Status`.
- `docs/hub-api-contract.md`: the `/stream` route row, the `### StreamFrame` section, and the `HUB_API_RESTARTING` stream case.
- `README.md`: one Hub API sentence on `/stream`.
- `tools/clock.test.mjs`: the stale comment only.

**Review findings breakdown (27: high 0, medium 1, low 12, false 14, maybe-false 0):**
- **Patched (8 entries):**
  - medium (1): the policy keepalive is now asserted on the default stream (Verification gap and Blind).
  - low (7):
    - the opening replay is unbounded;
    - the slow-client bound is documented;
    - the README splice and tense;
    - test hygiene (the no-op `continue`, and the `close()` in `finally`);
    - no seq gap on a serialisation throw;
    - `close()` destroys stuck sinks;
    - the host-unknown wording for an exact resume.
- **Deferred:** none.
- **Rejected (19: 5 low, 14 false):**
  - low (5):
    - the duplicated JSON stub (cosmetic);
    - `event()`/`status()` input handling (a caller bug should fail loudly);
    - over 1024 frames during one status read (unreachable);
    - stalled writes below the bound (the designed bound);
    - no mechanical Candybar cross-check (it would break hermeticity).
  - false (14):
    - no producer (Story 8.5 owns it; 4 rows across layers);
    - a NaN keepalive (strict policy);
    - real HTTP and close ordering (onStop runs before `server.close`; 3 rows);
    - an uncaught `error` (a node 24 probe showed none);
    - `/history` (Epic 10, and the doc says so);
    - no query-parameter resume (the header is the wire);
    - the duplicated or charset headers (the AC's exact text);
    - a close between plan and open (microtasks only);
    - `no-store` vs `no-cache` (the AC mandates it).

**Follow-up review recommendation: false.** This was the first pass. It patched 0 high and 1 medium entry, plus 7 low, which is below the threshold. No unverified risk remains that a pass could name.

**Verification:**
- `node --test tools/hub-api/stream.test.mjs tools/hub-api/contract.test.mjs tools/hub-api/server.test.mjs tools/hub-api/status.test.mjs tools/clock.test.mjs`: 92/92 pass.
- `heavy mise run check` (actionlint and the full suite): green, 1553/1553, after the review patches. The pre-review run was also green, at 1551/1551.
- Matrix audit: every row has a covering test that ran and passed:
  - Ready, Exact resume, Resume at cursor, Reset (boot or malformed), Eviction (ring 4, and the default at 1030);
  - Live fan-out (with the TypeError case), Keepalive (25 s and 40 s), Slow client;
  - Stop (`HUB_API_STOP`, no armed interval, then 503), Host unknown.
- No operator action is owed: every AC is in-repo. The live `curl -N 127.0.0.1:8794/stream` check belongs to Story 8.7's release and `hosts:install`.

**Residual risks:**
- Until Story 8.5 lands, a live `/stream` sends only openings and keepalives. Nothing yet emits `status` or `event` frames.
- The service rows use the repo's FakeServer convention. Real-socket flushing and `writableLength` behaviour rely on node http semantics; a node 24 probe confirmed that a write after a disconnect returns `false` without throwing.
- The ring holds up to 1024 whole-status frames in memory (tens of MB at most), and a far-behind resume replays them unbounded.
