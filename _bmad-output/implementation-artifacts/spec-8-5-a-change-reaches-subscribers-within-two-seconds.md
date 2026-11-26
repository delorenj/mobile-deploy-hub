---
title: 'Story 8.5: A change reaches subscribers within two seconds'
type: 'feature'
created: '2026-11-25'
status: 'done'
baseline_revision: '5fdd3ab0cef3f671fa6a69fd8cc74c605bf8a1f6'
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-8-context.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-8-4-one-stream-on-the-candybar-wire.md'
warnings: ['oversized']
deferred: []
---

<intent-contract>

## Intent

**Problem:** `GET /stream` (Story 8.4) sends only openings and keepalives: nothing calls `stream.status(doc)` or `stream.event(entry)`, so a Hold, queue or Reachability change made by `hub-device`, a deploy job or the service never reaches a subscriber (FR-14, NFR-3, AD-43).

**Approach (`belsky-doctrine`, one level up from "a watcher for the Hub API's stream": a change feed for any hub service's stream).** A new `tools/hub-api/changes.mjs` holds a generic re-arming watch set (any list of directories, re-armed on every notification) and a change feed that turns notifications into frames for any `createStream`: one coalesced re-read, new Event Log lines as `event` frames, and a `status` frame only when the document changed for a reason other than time. It also has `poke()`, so an in-process source (Epic 9's Mac push) schedules the same re-read. The one-shot debounce timer lives in `stream.mjs` (the hub's one clock file). Following the Event Log across months lives in `events.mjs` (the log's owner). The Hub API mounts the feed on its lock dir, `emulators/`, every `<name>.lock|.queue|.reservations` dir and its event dir.

## Boundaries & Constraints

**Always:**
- Node 24 ESM `.mjs`, `node:` builtins only. Tests are hermetic (`hermetic()`): a fake `watchImpl`, a fake or mocked clock, a fake response.
- **`stream.mjs`** adds `CHANGE_DEBOUNCE_MS = 250` and `trailing(work, {delayMs, timers = {setTimeout, clearTimeout}, onError})`, which returns `{poke(), settled(), close()}`:
  - `poke()` arms one unref'd `setTimeout(delayMs)` when no timer is armed and no run is in flight. Later pokes never push the run back, so the run is at most `delayMs` after the first poke of a burst.
  - A poke during a run marks it dirty, and the run's end pokes once.
  - Nothing arms without a poke. `close()` clears the timer, and later pokes do nothing.
- **`events.mjs`** adds two functions:
  - `eventsEnd({env, month})`: the offset just past the last complete line of `<month>.jsonl`, or 0 when the file is missing.
  - `followEvents({env, now, hostId, log})`: it starts at the latest month file (or `now`'s month) at `eventsEnd`. `read()` returns the `{id, offset, event}` entries appended since the last call (null-id lines skipped), draining the current month through `readEventsFrom` and then every later month file from 0. On `HUB_EVENT_OFFSET` or `HUB_EVENT_LINE_TOO_LONG` it logs one `HUB_EVENT_FOLLOW_SKIPPED <month> <code>` line and jumps to `eventsEnd`.
- **`changes.mjs`**:
  - `hubPaths(env)` returns `[lockDir, lockDir/emulators, ...every <name>.lock|.queue|.reservations directory in lockDir (sorted), eventDir]`, read fresh on every call. A tomb (`*.tomb-*`) or a `.released-*` path never matches.
  - `createWatchSet({paths, watch, stat, onNotify, log})` returns `{sync, notify, close, watched}`. `sync()` closes the watchers of paths that are gone or no longer listed. It opens `watch(path, {persistent: false}, listener)` for each listed directory without one, and reopens one whose inode changed (a replaced dir). Any watcher notification or `error` calls `notify()`, which runs `sync()` (the re-arm) and then `onNotify()`. The listener's `eventType` and `filename` are ignored.
  - `createChangeFeed({stream, render, now, paths, watch, follow, debounceMs = CHANGE_DEBOUNCE_MS, timers, log})` returns `{start, poke, settled, close, watched}`. A `debounceMs` that is not between 0 and 250 is a RangeError.
    - `start()` creates the tail (`follow()`), arms the watch set, and primes a baseline `{at, text}` from `render(at)`.
    - A re-read (after the primed baseline) emits every new tail entry through `stream.event`. It then renders at the baseline's `at`. When that equals the baseline text, nothing changed but time, and no `status` frame goes out. Otherwise it renders at `now()`, emits `stream.status(doc)` and stores the new baseline.
    - A render or tail failure is one `HUB_API_STREAM_FAILED <why>` line, repeated only when the message changes. It never throws.
    - `close()` closes the watchers and the debounce.
- **`startHubApi`** gains a `watch` seam. It is real `fs.watch` unless the test faked the host (the same `faked` rule the track uses), and then null, so no watcher runs.
  - It builds the feed with `render = at => statusDocument({...ctx, env, now: () => at})` and `follow = () => followEvents({env, now, hostId})`.
  - `afterBind`, after the seed, creates the lock and event dirs (`mkdirSync` recursive, the event dir `0o700`, a failure logged) and calls `feed.start()`.
  - `onStop` closes the feed first, then the track and the stream.

**Never:**
- Emit a frame or an event from a timer, a poll or a change that only time causes. Never add a `setInterval` anywhere, or a `setTimeout` in `tools/hub-api/` outside `stream.mjs`.
- Trust a filename or event type from the OS, or use `recursive: true`.
- Change an existing route, a response key, `CONTRACT_VERSION`, the on-disk layout, an event key or `policy.json`. Never touch the deploy path, `AGENTS.md`/`CLAUDE.md` or `sprint-status.yaml`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Arm | lock dir holds `adb.lock`, `adb.queue`, `s24.reservations`, `adb.lock.tomb-1-2`, a file `x.lock` | `watched()` = lock dir, each of the three dirs, event dir (`emulators/` absent: not watched) | — |
| Create re-arms | `mkdir s24.lock`, lock-dir watcher fires `('rename', 'junk/../name')` | `s24.lock` is watched, and one re-read follows | — |
| Replace re-arms | `adb.lock` renamed aside and recreated, parent fires | the old watcher is closed and a new one is open on the new inode; the tomb is not watched | — |
| Burst | 5 notifications within 100 ms | exactly one re-read, which runs at 250 ms after the first; none at 249 ms | — |
| Lease by any writer | `acquireLease` (hub-device), `withLock` (deploy job) or `POST /leases` (service), then a notification | within ≤ 250 ms of virtual time a subscriber gets the `event` frames for the new log lines (`acquire`) and one `status` frame whose doc shows the Hold | — |
| Time only | a Lease passes `expires_at` and no file changes; or a touch notification after time moved | no frame, no event | — |
| Notify during a re-read | a poke while a re-read is in flight | a second re-read after it ends, never two at once | — |
| Month change | lines appended to `2026-11.jsonl`, then `2026-12.jsonl` created | event frames for the rest of November, then December's from offset 0 | — |
| Render fails | `hostKey` throws `HUB_HOST_UNKNOWN` | event frames still go out, and one `HUB_API_STREAM_FAILED` line | logged, not thrown |
| Stop | SIGTERM | watchers closed, debounce cleared, a later notify does nothing | — |

</intent-contract>

## Code Map

- `tools/hub-api/stream.mjs` -- add `CHANGE_DEBOUNCE_MS` and `trailing` beside `createStream`. The header comment names it as the second clock (one-shot, poke-driven). `createStream`'s `status(doc)` and `event({id, event})` are the emit points; `event` throws on a missing id.
- `tools/hub-api/server.mjs` `startHubApi` (around L165-L230) -- the `faked` rule (the `trackDevices` choice) is reused for `watch`. `afterBind` runs recover and seed, then the snapshot and track kick. `onStop` is currently `track.stop(); stream.close()`. The ctx object passed to `startService` is the render ctx. Note that `startService` adds `env`, so pass `env` explicitly to the render.
- `tools/hub-api/routes.mjs` `statusDocument(ctx)` (L175-198) -- the one builder. Every time read goes through `createContext({now: ctx.now})`, so a frozen `now` reproduces a document exactly. Its comment already names 8.5's re-read.
- `tools/ci/lib/events.mjs` -- `readEventsFrom` (L156) is the byte-exact month reader; `monthOf` (L96) and `eventDir` (L19). Months are `YYYY-MM.jsonl`, named by the writer's UTC `ts`.
- `tools/ci/lib/lock.mjs` -- `lockDir` (L30). The layout: `<name>.lock/owner.json` + `alive`, which the heartbeat rewrites every 60 s (L425-441: a notification with no state change); `<name>.queue/<ticket>.json`; and `<name>.reservations/<key>/{reservation,grace}.json`. A grace start writes a `grace` event (L1022), so the event dir covers nested writes. Tombs are `<path>.tomb-<ms>-<pid>` (L296). `acquireLease` (L1639), `withLock` (L348, with a `timers` seam for the heartbeat) and `noteReachability` (L258) are the writers.
- `tools/hub-api/readings.mjs`, `track.mjs` -- every Reachability state change writes one `reachability` event via `noteReachability`, so it reaches the feed through the event dir.
- `tools/clock.test.mjs` -- `CLOCK_FILES` is unchanged. The scan forbids `setTimeout` in `tools/hub-api/` outside `stream.mjs`, and `trailing` must pass `selfRescheduling` (the timer's callback is not `poke`). Update the header comment only.
- `tools/hub-api/stream.test.mjs` L436-472 -- the `scratch`/`boot`/`open` FakeServer harness and `FakeSink`/`parse`, to copy into the new test.
- `docs/hub-api-contract.md` `### StreamFrame` (L258-279) and `README.md` L340 (the `/stream` sentence) -- the live-frame sources.

## Tasks & Acceptance

**Execution:**
- [ ] `tools/hub-api/stream.mjs` -- `CHANGE_DEBOUNCE_MS`, `trailing` -- the debounce lives in the one clock file
- [ ] `tools/ci/lib/events.mjs` -- `eventsEnd`, `followEvents` -- the log owner follows itself
- [ ] `tools/hub-api/changes.mjs` (new) -- `hubPaths`, `createWatchSet`, `createChangeFeed` -- a generic change feed for any stream
- [ ] `tools/hub-api/server.mjs` -- the `watch` seam, ensuring the dirs exist, the feed started in `afterBind` and closed first in `onStop` -- mounted
- [ ] `tools/hub-api/changes.test.mjs` (new) -- every matrix row: unit rows on `trailing`, `followEvents`, `createWatchSet` and `createChangeFeed`, plus service rows through `startHubApi` with a fake watcher and mocked `setTimeout` for the three writers, time only, and stop. Add one Linux-only real `fs.watch` smoke test on a temp dir (replace and re-arm, then a frame within 2 s of real time) -- AC1-AC4
- [ ] `docs/hub-api-contract.md`, `README.md`, `tools/clock.test.mjs` (comment) -- name the change sources, the 250 ms debounce and the 2 s bound
- [ ] verification -- `heavy mise run check`

**Acceptance Criteria:**
- Given the service with a fake watcher, when a dir under the lock dir is created or replaced and the parent notifies, then the watch set holds exactly the current dirs (new inode re-armed, gone ones closed), whatever filename the notification carried.
- Given any burst of notifications, when they arrive, then exactly one re-read runs, at most 250 ms after the first, and its `status` frame plus one `event` frame per new log line reach a subscriber.
- Given a Hold taken by `acquireLease`, `withLock` or `POST /leases`, when it lands and the watcher notifies, then the subscriber has the frames within 2 s of virtual time.
- Given only time passing (an expiry, a heartbeat touch), when it happens, then no frame and no event go out.
- Given HEAD, when `heavy mise run check` runs, then it is green and `tools/clock.test.mjs` finds no `setInterval` outside the three clock files and no `setTimeout` in `tools/hub-api/` outside `stream.mjs`.

## Spec Change Log

## Review Triage Log

### 2026-11-25 — Review pass
- verdicts: 28 findings — high 0, medium 1, low 20, false 7, maybe-false 0
- findings:
  - `low` `reject` (Blind) A status frame can carry an inventory or adb listing as old as the last snapshot pass, and nothing re-reads when the refresh lands. — This is the documented Story 8.2 snapshot rule, and `GET /status` behaves the same way. Hold and queue data is read from disk on every render. A Reachability change writes a `reachability` event, which is a notification. Fixing it would mean new wiring from the snapshot to the feed, for a field the contract already says may be one pass old.
  - `low` `reject` (Blind) A render that never resolves blocks every later re-read, including the event frames. — A hung `statusDocument` hangs `GET /status` and `ready` the same way; the hang is in the snapshot, not in the feed. The fix would be a timeout race, a new branch for a state nobody has shown can happen.
  - `false` `reject` (Blind) Worst-case latency can pass 2 s. — Each run costs at most three renders, and Story 8.2 bounds a render at under 200 ms. A change that lands mid-run costs at most one run, plus 250 ms, plus one run: about 1.45 s.
  - `low` `reject` (Blind) A failed watch is only a log line, with nothing on `/health`. — Exposing it means adding a key to the `/health` contract. `HUB_API_WATCH_FAILED` is on stderr in journald, the same place as `HUB_API_TRACK_FAILED`.
  - `low` `reject` (Blind) Heartbeat touches cause re-reads even with no subscriber. — The cost is one render per held lock per 60 s. Skipping re-reads with no subscriber would let the baseline drift, so a reconnecting subscriber would need special handling.
  - `low` `reject` (Blind) `HUB_EVENT_OFFSET` / `HUB_EVENT_LINE_TOO_LONG` jump to the month's end and drop the lines after it. — Neither happens in normal use. `appendEvent` never writes a line over 4 KiB, against a 1 MiB read bound, and nothing truncates a month file. The spec mandates the jump, and it is logged.
  - `low` `patch` (Blind) The "only time passing" service test touched `alive` inside a try/catch, and a Lease has no `alive` file, so its heartbeat half did nothing. — The test now writes `alive` and then `utimesSync`s it unconditionally (06c412e).
  - `low` `patch` (Blind) The "dirs created at start" test promised mode 0700 but never checked it. — It now asserts `statSync(eventDir).mode & 0o777 === 0o700` (06c412e).
  - `low` `patch` (Blind) Weak assertions: `docs.length >= 1 && <= 2`, and the real-fs test's final `< 10_000`. — The dirty-rerun test now asserts exactly `[3]`, one armed timer, and a second re-read from the render count (06c412e). The `< 10_000` line was left alone: it is redundant but harmless, because every `next()` in that test already enforces 2 s.
  - `false` `reject` (Blind) Production defaults (`hostId` and `now` undefined) are untested, so event ids might not match. — An event id's host part is the line's own `host_id` (`readEventsFrom`). The `hostId` option is only the fallback for a line that lacks one, and `appendEvent` always writes one. `now` falls back to `Date.now` in both places.
  - `low` `reject` (Blind) The README paragraph is long and repeats the contract. — The README's Hub API paragraph already carries one sentence per story in this style, and the change follows it.
  - `low` `reject` (Edge) In `followEvents`, a non-skip I/O error after earlier chunks were read loses those entries. — It needs an EIO or EACCES mid-read on a file the service owns. The fix adds a partial-return branch.
  - `low` `reject` (Edge) A straggler line in the old month after the next month's file appears is never read. — The window is milliseconds of clock skew, once a month. The fix would track an offset per month.
  - `low` `reject` (Edge) A skip drops the valid lines after the bad position. — Same root cause and reason as the Blind skip row.
  - `low` `reject` (Edge) A future-dated month file makes the tail start on it. — It needs a stray file or a clock months off. Writers name the month by their own UTC `ts`.
  - `low` `reject` (Edge) If the lock dir or the event dir is deleted and recreated, it is re-armed only on another notification. — Nothing deletes either directory, and the service creates both at start.
  - `low` `patch` (Edge) A retired `<name>.lock` re-made with a reused dev:ino keeps its dead watcher. — Ext4 reuses freed inode numbers quickly, and a release followed by an immediate take is the FIFO's normal path. The identity is now `dev:ino:birthtimeMs`, and a `stat`-seam test shows that a same-ino directory with a different birthtime is reopened (06c412e).
  - `low` `reject` (Edge) A watcher that errors persistently could loop or spam the log. — An `error` event is async, so a loop is bounded by event-loop turns, and the debounce coalesces the pokes. A persistent `watch()` throw is logged once per notification. The fix would add per-path dedupe state.
  - `low` `reject` (Edge) A hung render or primed baseline stops the feed. — Same root cause and reason as the Blind hung-render row.
  - `low` `reject` (Edge) If `follow()` throws at start and succeeds later, the lines between are lost. — It needs a non-ENOENT error from `eventsEnd`, such as EACCES on the service's own dir. Once it succeeds, the tail starts from that point.
  - `low` `reject` (Edge) A snapshot that refreshes after a frame sends no later frame. — Same root cause and reason as the Blind stale-snapshot row.
  - `false` `reject` (Edge) A `close()` during an in-flight render still touches the stream. — After `close()`, `stream.status()` returns null without emitting, because the stream is closed in the same `onStop`. The baseline write that follows is inert.
  - `false` `reject` (Edge) The 2 s claim in the docs is unbounded. — Same refutation as the Blind latency row: the bound rests on Story 8.2's render budget.
  - `medium` `patch` (Verification gap) No test asserted the production default `fs.watch` in `startHubApi`, and a mutation to `null` passed. — The choice is now `watchFor({watch, faked})`, which `startHubApi` uses. A test asserts node's `fs.watch` when nothing is injected, `null` when the host is faked, and pass-through for an injected value or an explicit `null` (06c412e).
  - `false` `reject` (Intent) The tests notify by hand and run the writers in-process, so they do not prove that a cross-process write is delivered. — inotify watches are per inode and see writes from every process alike. The Linux real-`fs.watch` test proves delivery and re-arm on real notifications, and `watchFor` pins the production default. The AC asks for a fake watcher and a fake clock.
  - `false` `reject` (Intent) The change is not deployed, so live `/stream` is still frame-less. — Story 8.7 owns the release, `hosts:install` and the live `curl -N` check (epic-8 context).
  - `low` `reject` (Intent) How a grace start appears on the wire is not shown. — A `grace` start is an Event Log line, the same path the `acquire` and release frames prove. A test for each event kind adds no coverage.
  - `false` `reject` (Intent) The conformance AC is met only by the existing scan. — The AC is that scan. `tools/clock.test.mjs` scans every non-test `tools/**/*.mjs`, including the new `changes.mjs`, and it passes with `CLOCK_FILES` unchanged.

## Design Notes

Why the debounce is fixed from the first poke and is not reset by every poke: a classic debounce that restarts on each notification never fires while a deploy writes steadily, which breaks the 2 s bound. A fixed window gives at most 250 ms of wait plus one re-read (under 200 ms, Story 8.2), plus at most one queued re-read.

Why the "time only" check renders at the baseline's instant: every time-derived field (`stale`, `expected_end`, ETAs, grace, reading ages, `checked_at`) comes from `ctx.now`. Rendering the current disk at the previous frame's instant gives a byte-identical document exactly when nothing but time moved. So a heartbeat touch, a dead tomb or a duplicate notification sends no frame, and every real change does, with no hand-kept list of time fields to rot. It costs one extra render only when something changed.

Why the feed is off when a test fakes the host: it matches the track socket's rule. Existing service tests count frames and seqs, and a real watcher on their temp dirs would add frames nondeterministically. A test opts in with `watch`.

## Verification

**Commands:**
- `node --test tools/hub-api/changes.test.mjs tools/hub-api/stream.test.mjs tools/clock.test.mjs tools/hub-api/contract.test.mjs` -- expected: all pass
- `heavy mise run check` -- expected: green

## Auto Run Result

Status: done

**Summary:**
- `GET /stream` is now live. Any Hold, queue or Reachability change on big-chungus reaches a subscriber within 2 s, whether `hub-device`, a deploy job or the service itself made it. The service watches the lock dir, `emulators/`, every `<name>.lock|.queue|.reservations` dir and the event dir with `fs.watch`. It re-arms on every notification and never trusts a filename or event type. Any notification schedules one re-read, at most 250 ms after the first notification of a burst. The re-read sends one `event` frame per new Event Log line, then one `status` frame. The `status` frame goes out only when the document changed for a reason other than time.
- Belsky one level up: `tools/hub-api/changes.mjs` is a change feed for any hub service's `createStream`. It has a generic re-arming watch set, plus `poke()` for in-process sources, so Epic 9's Mac push schedules the same re-read. The one-shot debounce `trailing` lives in `stream.mjs`, the clock file. The month-rolling Event Log tail `followEvents` lives in `events.mjs`, the log's owner.
- Deviation in detail (the contract's intent holds): the "time only" check renders at the baseline's instant as specced, but with the adb listing's `checked_at` pinned to that instant (`render(at, {steady: true})`). That stamp comes from the snapshot's own clock, or from the live clock while the track socket is open, not from `ctx.now`. Unpinned, every heartbeat touch would have sent a frame, and a test caught it. A frame sent to subscribers clamps that stamp to no later than its `at`.

**Files changed:**
- `tools/hub-api/changes.mjs` (new): `hubPaths`, `createWatchSet` (whose identity is `dev:ino:birthtime`, and which reopens an errored watcher) and `createChangeFeed`.
- `tools/hub-api/stream.mjs`: `CHANGE_DEBOUNCE_MS = 250` and `trailing`, a fixed-window, poke-driven one-shot debounce.
- `tools/ci/lib/events.mjs`: `eventsEnd` and `followEvents`, the Event Log tail across months.
- `tools/hub-api/server.mjs`:
  - `watchFor`, the production default watcher;
  - the dirs are created at start;
  - the feed is started in `afterBind` and closed first in `onStop`;
  - the steady/stamped render.
- `tools/hub-api/changes.test.mjs` (new): 38 tests covering unit, service and real Linux `fs.watch` rows.
- `docs/hub-api-contract.md`, `README.md`, `tools/clock.test.mjs` (comment only): the change sources, the 250 ms debounce and the 2 s bound.

**Review findings breakdown (28: high 0, medium 1, low 20, false 7, maybe-false 0):**
- **Patched (5 entries):**
  - medium (1): the production default `fs.watch` is now asserted through `watchFor`.
  - low (4):
    - the watch identity includes birthtime (inode reuse);
    - the heartbeat test touch is no longer vacuous;
    - the 0700 mode is asserted;
    - the exact frames and the second re-read are asserted.
  - I also patched one gap during verification, before review: an errored watcher is now closed and reopened (a93f11f).
- **Deferred:** none.
- **Rejected (16 low, 7 false):**
  - low (16):
    - the snapshot can be one pass old (Story 8.2's rule; 2 rows);
    - an unbounded or hung render (the same hang hits `/status`; 2 rows);
    - no watch-failure flag on `/health` (a contract change);
    - re-reads with no subscriber (baseline drift);
    - a skip jumps to the month's end (unreachable in normal use; 2 rows);
    - the README length (the existing style);
    - partial entries lost on an I/O error;
    - a straggler line in the old month;
    - a future month file;
    - a root dir recreated;
    - a watcher error loop or log spam;
    - `follow()` failing at start;
    - a grace start on the wire (the same path as `acquire`).
  - false (7):
    - latency over 2 s (bounded by Story 8.2's render budget; 2 rows);
    - production `hostId` and ids (ids come from the line's `host_id`);
    - a close during a render (the closed stream emits nothing);
    - cross-process delivery (inotify is per inode, and there is a real-watch test);
    - not deployed (Story 8.7);
    - conformance by the existing scan (that scan is the AC).

**Follow-up review recommendation: false.** First pass, with 0 high and 1 medium patched, which is below the threshold. No unverified risk can be named.

**Verification:**
- `node --test tools/hub-api/changes.test.mjs tools/hub-api/stream.test.mjs tools/clock.test.mjs tools/hub-api/contract.test.mjs`: 89/89 before review. `changes.test.mjs` alone was 38/38 after the patches.
- `heavy mise run check` (actionlint and the full suite) is green:
  - 1589/1589 after implementation;
  - 1591/1591 after the review patches;
  - 0 skipped, so the Linux real-`fs.watch` test ran.
- Matrix audit: every row has a covering test that ran and passed:
  - Arm (`hubPaths` and the service watch set);
  - Create re-arms; Replace re-arms;
  - Burst (`trailing`, the feed and the service);
  - Lease by any writer (`acquireLease`, `withLock`, `POST /leases`);
  - Time only (the feed and two service rows);
  - Notify during a re-read; Month change; Render fails (the feed and the service); Stop.
- No operator action is owed: every AC is in-repo. The live `curl -N 127.0.0.1:8794/stream` check belongs to Story 8.7's release and `hosts:install`.

**Residual risks:**
- A status frame's inventory or adb listing can be one snapshot pass old (Story 8.2's documented rule). Hold and queue data is always read from disk.
- Each held job lock's 60 s heartbeat costs one re-read render, and no frame.
- The end-to-end bound depends on a render staying within Story 8.2's 200 ms budget. A hung render stalls the feed, as it would stall `/status`.
- Nothing has been run against the live service yet; that is Story 8.7.
