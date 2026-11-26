---
title: 'Story 10.5: Ship v1b (pre-release half)'
type: 'chore'
created: '2026-11-26'
status: 'awaiting-operator'
operator_actions:
  - 'Merge this story branch into main and push main to origin; the release refuses a main that is not origin/main.'
  - 'Confirm `git ls-remote origin refs/tags/v1 refs/tags/v1.2.60` shows v1 on v1.2.59 and no v1.2.60 tag; if v1 moved or 1.2.60 is taken, retitle the `## v1.2.60` section of docs/hub-releases.md (and its test in tools/ci/v11.test.mjs) first.'
  - 'From a fresh clean clone of main on big-chungus, run `mise run release -- 1.2.60`; confirm every app strict dry run is green, v1 moved to v1.2.60, and `git show v1.2.60` carries the notes and a `Roll back:` line.'
  - 'After the release runner confirms its runs are finished, run `mise run hosts:install` on big-chungus from a clean checkout at tag v1.2.60 (the Mac must be awake); confirm the Hub API and Host Agent /health readbacks print equal contract and hub_version, and the services agree step passes.'
  - 'Run `mise run hosts:smoke -- --lanes --history` on big-chungus when no iOS deploy holds or waits on mac-ios, and confirm HUB_SMOKE_OK v1.2.60 with a `HUB_SMOKE history: ios-lane on mac: ...` line (partial false, nothing in big-chungus own log).'
  - 'Prove the sleep/wake /history path once by hand on big-chungus: note T, take and release the lane (`hub-device lease ios-lane --no-connect --wait 0 --for 2m --why sleep-check`, then `hub-device release <id> --resource ios-lane`), close the Mac lid, run `curl -s "http://127.0.0.1:8794/history?claimant=<your holder>&from=<T>" | jq "{partial, synced_through, unreachable_ranges}"` and see partial: true with a mac range in unreachable_ranges, open the lid, run the same query and see partial: false with the acquire and release under host mac.'
  - 'Run `git unpushed` after the release and land what it lists; a clean report is the definition of done.'
  - 'If the release is red or anything regresses: move v1 back to v1.2.59, then run `mise run hosts:install -- --allow-downgrade` from a clean checkout at v1.2.59; leave replicas/ in place.'
baseline_revision: '02ba0f2221ad018030cfd8237391e70c2fede8c4'
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-10-context.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-9-8-ship-the-mac-host-agent.md'
  - '{project-root}/docs/hub-api-contract.md'
warnings: ['oversized']
deferred: []
---

<intent-contract>

## Intent

**Problem:** Stories 10.1 to 10.4 are on local main (`02ba0f2`). origin/main is `ade5a8d`, which is an ancestor. `v1` is on `v1.2.59`, and there is no `v1.2.60` tag. But nothing ships them:
- `docs/hub-releases.md` has no `## v1.2.60` section, so the tag would carry no notes. The notes must say that pinned readers ignore the Registry, `replicas/` and the new event names, that deploy jobs and the catch-ups never depend on either service, and that v1c adds `/capacity` and the Holocene page.
- The AC's live history proof is a hand-typed query. Every later release that touches replication, `/history` or the Host Agent's push would have to repeat it by hand: a Mac event read back from big-chungus out of the replica, with `partial: false`.

**Approach (`belsky-doctrine`).** "Ship v1b" is one release. One level up is every post-install check that each spoke host's Event Log reaches the hub's `/history`.

1. `mise run hosts:smoke` gains an opt-in `--history` phase (`historyCheck`). It needs `--lanes`. The lanes phase just wrote one `acquire` and one `release` event in each spoke's own log. For every lane it took, the history phase reads `GET /history` on this host's Hub API. It requires both events to come back under that spoke's host key, with `partial: false` and an ISO `synced_through`. It also requires that big-chungus's own log has no event for the id.
2. The `## v1.2.60` notes and their test, plus the README and `mise.toml` text.
3. `mise run check` green on Node 24 and on Node 26.

The release, `hosts:install` on both hosts, the live smoke, the sleep/wake `/history` proof and `git unpushed` after the release go to the operator. The release refuses a `main` that is not `origin/main`, and the orchestrator merges this branch.

## Boundaries & Constraints

**Always:**
- Node 24 ESM, `node:` builtins only. Tests are hermetic: a fake `cli`, `fetchImpl`, `now` and `sleep`. Every wait is a bounded `for` loop (AD-19) with `pause.mjs` `sleep`. Add no `setInterval` or `setTimeout` under `tools/hub-api/`, `tools/host-agent/` or `tools/hub-client.mjs`.
- `historyCheck({ref, api, lanes, now, sleep, log})` is exported from `tools/hosts/smoke.mjs`.
  - `api` is `apiCaller(fetchImpl, policy)` and is called with `method: 'GET'`.
  - `lanes` is `laneCheck`'s resolved `lanes` array. It must be non-empty, else a `TypeError`.
  - It is read-only, so it has nothing to undo.
- The query is `/history?claimant=hosts:smoke&from=<now() - HISTORY_LOOKBACK_MS ISO>&limit=1000`, with `HISTORY_LOOKBACK_MS = 600_000`.
- One "read" follows `cursor` while `more` is `true`, for at most `HISTORY_MAX_PAGES = 5` pages. A read that is not status 200 with `format: 1` and an `events` array fails at once, naming the status, the `code` and the `detail`.
- A read passes when every lane is satisfied. A lane is satisfied when three things hold:
  - the read has an `events[]` entry with `event.lease_id === lane.id` and `event.event === 'acquire'`, and another with `event.event === 'release'`;
  - every entry for that id has `host === lane.host` and an `id` that matches `^[^/]+/\d{4}-\d{2}/\d+$`;
  - the answer has `partial === false`, and `synced_through[lane.host]` is an ISO time.
- An entry for a lane id with another `host` fails at once with `history: <host> wrote an event for <id>: it is in <entry.host>'s log`.
- Poll one read every `WAITER_POLL_MS` until a read passes, or until `HISTORY_SHOWS_WITHIN_MS = 10_000` from the phase start. No read starts after the deadline.
- On timeout it fails `history: ... within 10 s` and names what is missing for the first lane that is not satisfied:
  - the `acquire` or `release` of `<id>` is not in `<host>`'s history;
  - or the answer is `partial: true`, with its `unreachable_ranges` (and `synced_through`) given as JSON.
- Log one line per lane: `HUB_SMOKE history: <device> on <host>: acquire and release of <id> read back from <host>'s log (<acquire event id>, <release event id>), partial false, <host> synced_through <iso>, in <n> ms`. It resolves `{history: [{host, device, id, eventIds, syncedThrough, shownMs}]}`.
- In `hubSmoke`, `history` defaults to `false`, so the call list is unchanged. It must be a boolean, else a `TypeError`. `history: true` without `lanes: true` is a `TypeError` (`history needs lanes`).
  - The phase runs right after 5d lanes, as step 5e, with the lanes result.
  - It fails through `stop('history', ...)`, so the phone is retired.
  - The `HUB_SMOKE_OK` line is unchanged.
- On the CLI, `--history` turns the phase on. `--history` without `--lanes` is a usage error. `parseSmokeArgs` returns `history`, and `runEntry` forwards it.
- The `## v1.2.60` section goes above `## v1.2.59`. It says:
  - Epic 10 on top of v1.2.59: ask what happened, on either host.
  - The replica: `HUB_EVENT_DIR/replicas/<host>/<YYYY-MM>.jsonl`, written byte-for-byte by the Hub API alone. It rides `POST /agent/push`'s `events`, uses `HUB_REPLICA_GAP`, and the agent keeps no cursor. The Host Agent's `POST /agent/sync`.
  - `GET /history`: its filters, the opaque per-host cursor, `partial`, `synced_through`, `unreachable_ranges`, `cross_host_order: display-only`. Nothing is compacted or deleted.
  - `GET /utilisation`: its five classes, answered from cached folded timelines, never a walk of the whole log per request.
  - The frozen contract: `tools/hub-api/contract-freeze.json` is a floor (only additions pass), every route has a `Calls` cell, and `GET /capacity` is reserved for v1c and absent. The QA-serial leak sweep, and the Lease `env.ANDROID_SERIAL` that is `null` for a `dedicated_qa` Resource.
  - `contract` stays 1.
  - Pinned readers ignore the Registry (`registry.json`), `replicas/` (a reader lists only `<YYYY-MM>.jsonl` at the top of the event dir) and the new event names (`registry-*`, `reachability`, `host-reachability`, `prune` are skipped by name).
  - Deploy jobs and the catch-ups never depend on the Hub API or the Host Agent (AD-22, AD-25, `tools/deploy-path.test.mjs`).
  - v1b is complete. v1c adds `GET /capacity` (the Capacity Estimate) and the Holocene page.
  - No unit or plist is added. Rolling back is moving `v1` back, then `mise run hosts:install -- --allow-downgrade` from a clean checkout at `v1.2.59`. Leave `replicas/` in place: v1.2.59 ignores it, and its agent sends no `events`.
  - `hosts:smoke -- --lanes --history`.
  - "Test changes you will see": each suite changed since `v1.2.59`, from `git diff --name-status v1.2.59 HEAD -- '*.test.mjs'`. That is the `M` suites `claims`, `lease-lane`, `push`, `server`, `agent-push`, `contract` and `unreachable`, plus this story's `smoke` and `v11`, and the `A` suites `lease-view`, `replicate`, `history` (both), `leak`, `replica` and `utilisation` (both).

**Never:**
- Run `mise run release`, `hosts:install`, `launchctl`, `systemctl`, a real deploy, a live Lease or a live `/history` call.
- Touch the installed services, ports 8794 or 8795, either host's lock dir or event dir.
- Move or push a tag, or push main.
- Change a route, a response key, the contract doc or its freeze file, `lock.mjs`, `claims.mjs`, the Hub API, the Host Agent, the deploy path, `policy.json`, `AGENTS.md`, `CLAUDE.md` or `sprint-status.yaml`.
- Add a route, a field or an error code. Implement `/capacity`.
- Run the smoke from `hosts:install`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|---|---|---|---|
| History happy | lanes ran; `/history` has the `acquire` and `release` of `<tag>-l-ios-lane` under `host: mac`, `partial: false` | the `HUB_SMOKE history: ios-lane on mac: ...` line, then retire and the unchanged `HUB_SMOKE_OK` | — |
| `history: false` | the 9.8 world | the exact existing call list (no `/history` fetch) | — |
| Needs lanes | `history: true`, `lanes: false`; `--history` alone | `TypeError` `history needs lanes`; usage error | nothing is registered |
| Shows late | the first reads lack the `release`, then a later one has it | passes; `shownMs` is the time to the passing read | — |
| Never shown | the `release` is never in the answer within 10 s (fake clock) | fails `history: the release of <id> is not in mac's history within 10 s`; no read after the deadline | phone retired |
| Partial | the events are present but `partial: true`, `unreachable_ranges: [{host: 'mac', ...}]` | fails after 10 s, naming `partial: true` and the ranges | phone retired |
| Written locally | an entry for the id has `host: 'linux'` | fails at once: `linux wrote an event for <id>` | phone retired |
| Refused | `/history` answers 503 `HUB_HOST_UNKNOWN`, or status 0 `HUB_API_DOWN` | fails at once, naming the status and the code | phone retired |
| Paged | the first page has `more: true` and the events are on page 2 | passes (the cursor is followed, at most 5 pages) | — |
| Entry flags | `--lanes --history` | `history: true` forwarded; the default is false | — |

</intent-contract>

## Code Map

- `tools/hosts/smoke.mjs`:
  - header comment L1-32: add step 5e (history).
  - constants L43-62: add `HISTORY_SHOWS_WITHIN_MS`, `HISTORY_LOOKBACK_MS`, `HISTORY_MAX_PAGES`.
  - `apiCaller` L81: reuse it with `method: 'GET'` and no body, so `{status, body}` never rejects.
  - `laneCheck` L539: its result `{lanes: [{host, device, id, ...}]}` is the input. Its `poll` (L561) is the bounded-loop pattern. `isoTime` and `isObject` are existing helpers.
  - `hubSmoke` L657: add the `history` option and its type checks next to `lanes` (L680). Keep the lanes result (L792) and run 5e after it, inside the same try/`stop`.
  - `parseSmokeArgs` L834 and `runEntry` L850: `--history`.
- `tools/ci/lib/lock.mjs`: read-only. The event body is built by `eventOf` (L158): `event`, `lock`, `resource`, `claimant.holder` (`hosts:smoke` for the smoke's leases) and `lease_id`. A Lease's take is `acquire`. Its release is `retire(..., {as: 'release'})`, which writes event `release`. `mac-ios` is in `QUEUED` (L81), so the Mac's lane lease writes both events in the Mac's own log.
- `tools/hub-api/history.mjs`, and `docs/hub-api-contract.md` L309-339: the History answer `{format, events: [{id, host, event}], cursor, more, partial, synced_through, unreachable_ranges, cross_host_order, checked_at}`. The `claimant` filter matches `claimant.holder`. With no `to`, every call makes the Hub API `/agent/sync` the Mac before it reads the replica.
- `tools/hosts/smoke.test.mjs`:
  - `world()` L29 is the fake CLI. `w.fetch` (around L263-364) is the fake `fetchImpl` the holds tests use.
  - The lanes tests (search `laneCheck` / `lanes:`) give `status` a `remote_hosts.mac` and lease/release hooks.
  - Add a `/history` route to a fake fetch, answering from a script of pages keyed on the call count. Cover every matrix row, the `history: false` call list and the arg parsing (near the `--lanes` parse tests).
- `docs/hub-releases.md` L7: the new section above `## v1.2.59`. Sources: the 10.1-10.4 spec Auto Run Results, the contract L309-363, and the README.
- `tools/ci/v11.test.mjs` L1027: the v1.2.58 test is the pattern. Add a `v1.2.60` test above it. Scope the suite-name checks to the text after `### Test changes you will see`.
- `README.md` L336-339 (the `hosts:smoke` lines) and the long smoke paragraph (L344, after the lanes phase sentence), and `mise.toml` L165 (the `hosts:smoke` description): add `--history`.
- Live facts (2026-11-26):
  - `git ls-remote` shows `v1` and `v1.2.59` both peeling to `359bd65`, and no `v1.2.60`.
  - origin/main `ade5a8d` is an ancestor of HEAD.
  - `git diff --stat v1.2.59 HEAD` adds no unit and no plist.

## Tasks & Acceptance

**Execution:**
- [x] `tools/hosts/smoke.mjs` -- `historyCheck`, the constants, the `history` option, step 5e, `--history`, the header -- the repeatable live check that a spoke's events reach `/history` complete.
- [x] `tools/hosts/smoke.test.mjs` -- every matrix row, the `history: false` call list, and the parsing and forwarding.
- [x] `docs/hub-releases.md`, `tools/ci/v11.test.mjs` -- the `## v1.2.60` section and its test.
- [x] `README.md`, `mise.toml` -- the `--history` text.
- [x] Verification -- `heavy mise run check`, then `heavy mise run --tool node@26 check`, one after the other.

**Acceptance Criteria:**
- Given HEAD, when `mise run check` runs on Node 24 and on Node 26, then both are green.
- Given `docs/hub-releases.md`, when `releaseNotes(text, 'v1.2.60')` reads it, then it names each of these:
  - `replicas/`, `POST /agent/sync`, `HUB_REPLICA_GAP`, `GET /history`, `partial`, `synced_through`, `unreachable_ranges`, `GET /utilisation`;
  - `contract-freeze.json`, `GET /capacity` reserved, the QA leak sweep, and that `contract` stays 1;
  - that pinned readers ignore the Registry, `replicas/` and the new event names;
  - that deploy jobs and the catch-ups never depend on either service;
  - that v1c adds `/capacity` and the Holocene page;
  - the rollback to `v1.2.59` with `--allow-downgrade`, `hosts:smoke -- --lanes --history`, and the test changes.
- Given an installed pair, when `mise run hosts:smoke -- --lanes --history` runs on big-chungus, then it ends `HUB_SMOKE_OK` only when the lane's `acquire` and `release` come back from `/history` under the Mac's host key, with `partial: false` and nothing in big-chungus's own log.
- Given the operator-owed half, when this story finishes, then the spec is `awaiting-operator` with each item under `operator_actions`. That half is:
  - merge and push;
  - release 1.2.60;
  - `hosts:install` on both hosts with equal readbacks;
  - the smoke with `--lanes --history`;
  - the sleep/wake `/history` proof (`partial` before, complete after);
  - `git unpushed` clean.

## Spec Change Log

## Review Triage Log

### 2026-11-26 — Review pass
- verdicts: 27 findings — high 0, medium 0, low 14, false 13, maybe-false 0
- findings:
  - `[low]` `[patch]` blind: the v1.2.60 notes test matched suites by bare word, so `hub-api/history` and `registry/history` (and the two utilisation suites) counted as one — fixed: each suite is asserted by its path as the notes write it, brace groups included, so dropping any one fails.
  - `[false]` `[reject]` blind: a missing `### Test changes` heading gives a misleading suite failure — the word loop asserts `/Test changes you will see/` first, so a missing heading fails there by name.
  - `[low]` `[reject]` blind: `historyCheck` does not require exactly one acquire/release, their order, the lock or the holder — duplicates and shifted lines are what 10.1's hash tests prove; the query already filters `claimant=hosts:smoke`, and more checks add branches for a state not shown.
  - `[low]` `[reject]` blind: `EVENT_ID` does not tie `<host_id>` to the host key — the host id is a machine UUID the smoke cannot know; the host key is checked through `entry.host`.
  - `[low]` `[reject]` blind: a hanging `/history` page can overrun 10 s (5 pages x 30 s) — a hang still ends at `apiCaller`'s timeout, and every other phase bounds its waits the same way (no read starts after the deadline).
  - `[false]` `[reject]` blind: `partial` is ORed over pages but `synced_through` comes from the last page — every page answers the same query; the last page's `synced_through` is the newest, and any partial page fails the read.
  - `[low]` `[patch]` blind: the `push.test.mjs` flake fix ticked the mocked debounce on every poll, loosening the 250 ms claim — grouped with edge's extra-tick row; fixed: the check reads first and ticks only while the lease is not yet shown.
  - `[low]` `[reject]` blind: no `hubSmoke` test with two lanes into history, and `laned.lanes` unguarded — `history` requires `lanes`, and `laneCheck` either resolves `{lanes}` or throws, so `laned` is never null there; two lanes are tested in `laneCheck` and in `historyCheck` alone.
  - `[false]` `[reject]` blind: the notes' pinned-reader claims are not tied to code — checked: `readEvents` in v1.2.52 and v1.2.59 lists only `/^\d{4}-\d{2}\.jsonl$/` at the top of the event dir, and v1.2.52's fold acts only on `LEASE_EVENTS` names, so `replicas/` and the v1b event names are ignored.
  - `[low]` `[reject]` blind: the README smoke paragraph is huge and duplicated across four places — the existing style for every phase since 6.12; a restructure is out of this story.
  - `[false]` `[reject]` blind: the sleep/wake proof has no automation — nothing can wake a sleeping laptop; it is an operator action with the exact query in `operator_actions`.
  - `[low]` `[reject]` edge: a read stopped at 5 pages with `more` still true can miss events — 5000 `hosts:smoke` events within 10 min is unreachable; a miss fails loudly as "not in history".
  - `[low]` `[reject]` edge: the 10 s bound can be exceeded by slow pages — as blind's hang row.
  - `[false]` `[reject]` edge: `synced_through` judged from the last page only — as blind's paging row.
  - `[false]` `[reject]` edge: a local write without `lease_id` passes — every event a Lease writes carries `lease_id` (`eventOf`, lock.mjs:158), and the forward writes only on the Mac.
  - `[low]` `[reject]` edge: several acquire/release entries for one id pick a stale one — as blind's exactly-one row; a lane id is client-minted per run and never reused.
  - `[low]` `[reject]` edge: Mac clock skew over 10 min filters the events out — the Mac runs NTP and `laneCheck` reports the skew; widening the window adds a parameter for a state not shown.
  - `[false]` `[reject]` edge: `laned` may be null when `history` is true — `hubSmoke` refuses `history` without `lanes`, and `laneCheck` resolves `{lanes}` or throws.
  - `[low]` `[patch]` edge: the `until` ticks after the condition already holds, so an extra push may fire after `sent` is captured — grouped with blind's flake-fix row; fixed as there.
  - `[false]` `[reject]` edge: the rollback and pinned-reader claims are untested — verified against v1.2.52 and v1.2.59 (see blind's row); v1.2.59's Host Agent predates replication and always pushes `events: null` (its push.mjs:73).
  - `[false]` `[reject]` edge: the notes test only matches wording — release notes are prose; the behaviour they name is tested by its own suites.
  - `[low]` `[reject]` edge: `EVENT_ID` never ties the host_id prefix to the lane's host — as blind's row.
  - `[low]` `[patch]` verification-gap: `historyCheck` was tested only against hand-built answers — fixed: `tools/hub-api/history.test.mjs` writes a real `acquireLease` and release on `mac-ios` through `lock.mjs`, copies the month file byte-for-byte into `replicas/mac/`, and runs `historyCheck` through `handle()`; it passes with both event ids and `partial: false`.
  - `[false]` `[reject]` intent: the spec frontmatter is `in-review`, not `awaiting-operator` — transitional; finalization writes `awaiting-operator`.
  - `[false]` `[reject]` intent: the notes describe a release that does not exist yet — by design: `docs/hub-releases.md` requires the section to be written before the release, which reads it from the tagged commit.
  - `[false]` `[reject]` intent: the push → replica → sync → `/history` chain is only claimed, not run — the real-route test now runs the replica read, the sync and the merge; the live chain is the operator's smoke.
  - `[false]` `[reject]` intent: the `push.test.mjs` change is outside the task list — AC1 needs `mise run check` green, and that test failed about one run in three under load before the fix.

## Design Notes

**Why `--history` needs `--lanes`.** The lanes phase is the one way the smoke writes a known event in a spoke's own log: the forwarded take and release write `acquire` and `release` on the Mac. Reading those exact events back proves the whole chain on each install: the agent's push, the replica's append, `/agent/sync` on demand, and `/history`'s merge and host key. Using a fresh event, rather than "some Mac event", means an old replica cannot pass it.

**Why the sleep/wake proof stays by hand.** Nothing can wake a sleeping laptop on demand. The smoke proves the awake path on every release. The operator proves the gap path once:
1. Take and release the lane.
2. Close the lid.
3. Query `/history`: it is `partial: true`, with a `mac` range in `unreachable_ranges`.
4. Open the lid.
5. Query again: it is `partial: false`, with the events.

```text
HUB_SMOKE history: ios-lane on mac: acquire and release of smoke-x-l-ios-lane read back from mac's log (m1/2026-11/88210, m1/2026-11/88807), partial false, mac synced_through 2026-11-26T15:00:01.400Z, in 620 ms
```

## Verification

**Commands:**
- `node --test tools/hosts/smoke.test.mjs tools/clock.test.mjs tools/deploy-path.test.mjs` -- expected: all pass
- `node --test --test-name-pattern 'v1.2.60' tools/ci/v11.test.mjs` -- expected: pass
- `heavy mise run check` and `heavy mise run --tool node@26 check` -- expected: green

## Auto Run Result

**Status: awaiting-operator.** Everything an agent can do is done and committed on the story branch. What is still owed needs the real hosts, or comes after the orchestrator's merge:
- the release;
- `hosts:install` on both hosts;
- the live `--lanes --history` smoke;
- the sleep/wake `/history` proof (someone has to close and open the Mac's lid);
- `git unpushed` after the release.

Each one is listed under `operator_actions` in the frontmatter.

### Summary

- **For this release:**
  - The `## v1.2.60` notes are written and pinned by a test. They cover the replica and `POST /agent/sync`, `GET /history`, `GET /utilisation` and the frozen contract (`contract-freeze.json`, `GET /capacity` reserved, the QA leak sweep).
  - They also state that `contract` stays 1, and that pinned readers ignore the Registry, `replicas/` and the v1b event names (checked against `readEvents` in v1.2.52 and v1.2.59).
  - They state that deploy jobs and the catch-ups never depend on either service, and that v1b is complete, with v1c adding `GET /capacity` and the Holocene page.
  - They give the rollback to `v1.2.59` with `--allow-downgrade`, and list the test changes.
- **For the level above, every post-install check that each spoke's Event Log reaches `/history` (`belsky-doctrine`):** `mise run hosts:smoke -- --lanes --history` runs `historyCheck`, which is opt-in and needs `--lanes`.
  - The lanes phase writes one `acquire` and one `release` in each spoke's own log.
  - The history phase reads them back from this host's `GET /history?claimant=hosts:smoke`. It follows the cursor for at most 5 pages per read, and polls for at most 10 s.
  - It requires both events under the spoke's host key, `partial: false`, an ISO `synced_through`, and no entry for the id in big-chungus's own log.
  - A second spoke host needs no change.
- **A flaky test fixed:** `mise run check` failed about one run in three under load. The cause was a race in `tools/host-agent/push.test.mjs`: a poke during the start drain re-armed the debounce on the mocked clock, and nothing ticked it again. The test now ticks while the Lease is not yet shown. Product code is unchanged.

### Files changed

- `tools/hosts/smoke.mjs`: `historyCheck` and `HISTORY_SHOWS_WITHIN_MS`, `HISTORY_LOOKBACK_MS`, `HISTORY_MAX_PAGES`; the `history` option of `hubSmoke` (step 5e); `--history` (needs `--lanes`); the header.
- `tools/hosts/smoke.test.mjs`: every matrix row, plus two lanes, entry checks, argument checks, and `runEntry` forwarding.
- `tools/hub-api/history.test.mjs`: `historyCheck` run against the real `/history` route, with a Lease written by the real `lock.mjs` and copied byte-for-byte into the Mac's replica.
- `tools/host-agent/push.test.mjs`: the debounce-tick fix for the load flake.
- `docs/hub-releases.md`, `tools/ci/v11.test.mjs`: the `## v1.2.60` section and its test. Suites are asserted by path.
- `README.md`, `mise.toml`: the `--history` text.
- `_bmad-output/implementation-artifacts/spec-10-5-ship-v1b.md`: this spec.

### Review findings

- **Totals:** 27 findings (blind 11, edge 11, verification-gap 1, intent 4): high 0, medium 0, low 14, false 13, maybe-false 0.
- **Patches applied (low, 3 entries):**
  - the notes test asserts suites by path;
  - the push test ticks only while the Lease is not yet shown;
  - `historyCheck` is run against the real route.
- **Deferred:** none.
- **Rejected, false (13):**
  - a heading the word loop already asserts;
  - per-page `synced_through` (two rows);
  - the pinned-reader and rollback claims (two rows, verified against v1.2.52 and v1.2.59);
  - automating sleep/wake;
  - a local write without `lease_id`;
  - a null `laned`;
  - the notes test as prose;
  - four intent rows (the transitional status, notes written before the tag, a live chain that is operator-owed, the flake fix in scope).
- **Rejected, low (11):**
  - exactly-one/order/lock checks (two rows);
  - host_id tied to the host key (two rows);
  - a hanging page (two rows);
  - a two-lane `hubSmoke` test;
  - README size;
  - the 5-page cap;
  - Mac clock skew over 10 min.

  Each reason is in the Review Triage Log.

### Follow-up review

`followup_review_recommended: false`. This was the first pass, and it patched high 0, medium 0, low 3 entries.

### Verification

- After the review patches, run one after the other:
  - `heavy mise run check` on Node 24.15.0: 2027/2027, exit 0.
  - `heavy mise run --tool node@26 check` on Node 26.13.0: 2027/2027, exit 0.
- Before the flake fix, both runs failed one test, the same one each time (`push.test.mjs` end to end, "the triggered push carried the lease"). It also failed 1 run in 3 when its file ran alone. After the fix it passed 8 runs in a row and 6 concurrent runs.
- Focused runs:
  - `node --test tools/hosts/smoke.test.mjs tools/clock.test.mjs tools/deploy-path.test.mjs tools/hub-api/history.test.mjs`: 139/139.
  - `node --test --test-name-pattern v1.2.60 tools/ci/v11.test.mjs`: 1/1.
- Matrix audit: every I/O row has a passing test. The rows are history happy, `history: false`, needs lanes, shows late, never shown, partial, written locally, refused (503 and status 0), paged, and entry flags.
- Live facts (read-only, 2026-11-26):
  - `v1` and `v1.2.59` both peel to `359bd65`, and there is no `v1.2.60`.
  - origin/main `ade5a8d` is an ancestor of the branch.
  - `git diff --stat v1.2.59 HEAD` adds no unit and no plist.

### Residual risks

- The history phase has never run live. Its first live run is the operator's `hosts:smoke -- --lanes --history`. The real-route test covers the field names and the replica read, but not the agent's real push over ssh.
- The sleep/wake gap path (`partial: true`, then complete) has only been proven in hermetic tests (10.2's suite). The live proof is an operator action.
- Local main (`02ba0f2`) is ahead of origin/main (`ade5a8d`) by the whole of Epic 10, so the release must wait for the merge and push.
