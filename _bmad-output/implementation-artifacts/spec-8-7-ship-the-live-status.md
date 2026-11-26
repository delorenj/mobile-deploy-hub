---
title: 'Story 8.7: Ship the live status (pre-release half)'
type: 'chore'
created: '2026-11-26'
status: 'awaiting-operator'
operator_actions:
  - 'Merge this story branch into main and push main to origin; the release refuses a main that is not origin/main.'
  - 'Before releasing, confirm `git ls-remote origin refs/tags/v1 refs/tags/v1.2.57` shows v1 on v1.2.56 and no v1.2.57 tag; if v1 moved or 1.2.57 is taken, retitle the `## v1.2.57` section of docs/hub-releases.md (and its test in tools/ci/v11.test.mjs) first.'
  - 'From a fresh clean clone of main on big-chungus, run `mise run release -- 1.2.57`; confirm every app strict dry run is green, v1 moved to v1.2.57, and `git show v1.2.57` carries the notes and a `Roll back:` line that names v1.2.56 (and no service stop).'
  - 'After the release runner confirms its runs are finished, run `mise run hosts:install` on big-chungus from a clean checkout at tag v1.2.57; confirm the HUB_API readback prints `v1.2.57 serves 127.0.0.1:8794, contract 1` and `systemctl --user status mobile-deploy-hub-api`.'
  - 'Run `mise run hosts:smoke -- --restart` on big-chungus and confirm HUB_SMOKE_OK v1.2.57 with a `HUB_SMOKE stream: status frame <n> ms after the lease, keepalive after <m> ms idle` line and a `HUB_SMOKE restart: smoke-<id>-s held across the restart; the reconnect got reset (boot <a> -> <b>)` line (it leaves one retired smoke-<id> record in registry.json; the restart answers any open wait HUB_API_RESTARTING, so run it when nobody is waiting on a Lease).'
  - 'Run the AC live check by hand once: `curl -N 127.0.0.1:8794/stream`, take a Lease with `hub-device lease s24 --no-connect --wait 0 --for 2m --why check`, see a `status` frame within 2 s, see `: keepalive` while idle, `systemctl --user restart mobile-deploy-hub-api`, confirm the Lease survives in `hub-device status` and the reconnect with the last id gets `reset`; release the Lease.'
  - 'If the release is red or anything regresses: move v1 back to v1.2.56, then `mise run hosts:install` from a clean checkout at v1.2.56 (no systemctl disable: no unit is added).'
baseline_revision: 'b5facce1d39ef38a89a1242dbf950a8dcaa0c5bb'
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-8-context.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-7-9-ship-leases-through-the-api.md'
  - '{project-root}/docs/hub-api-contract.md'
warnings: ['oversized']
deferred: []
---

<intent-contract>

## Intent

**Problem:** Stories 8.1 to 8.6 are on main (`b5facce`, pushed; `v1` is on `v1.2.56`, no `v1.2.57` tag), but nothing ships them. `docs/hub-releases.md` has no `## v1.2.57` section; `hosts:install`'s readback checks `hub_version` but never reads back `contract` (the AC asks for both); and the AC's live check (`curl -N .../stream`, take a Lease with `hub-device`, see a `status` frame within 2 s, see keepalives while idle, restart the service, the Lease survives and the reconnect gets `reset`) is a hand-typed sequence every later release touching `/status`, `/stream` or restart safety would repeat (FR-14, FR-21, FR-23).

**Approach (`belsky-doctrine`, one level up from "ship this release": every post-install check of the live status).** (1) `mise run hosts:smoke` gains a `stream` phase (default on in the CLI) that runs the AC's sequence against the installed service on the smoke's own test phone, and an opt-in `--restart` that restarts the unit mid-session and checks the Lease survives and the reconnect gets `reset`. (2) `hosts:install`'s readback and the smoke's health step require and print `contract` equal to the code's one constant. (3) The `## v1.2.57` notes with their test, README/mise text, and `mise run check` green on Node 24 and 26. The release, `hosts:install` and the live runs go to the operator: the release refuses a `main` that is not `origin/main`, and the orchestrator merges this branch.

## Boundaries & Constraints

**Always:**
- Node 24 ESM, `node:` builtins only; hermetic tests (injected `fetchImpl`, `cli`, `now`, `sleep`, `restart`); every wait a bounded `for` loop (AD-19); no `setInterval`/`setTimeout` added under `tools/hub-api/`, `tools/host-agent/` or `tools/hub-client.mjs` (`tools/clock.test.mjs` stays green). Timeouts in `tools/hosts/smoke.mjs` use `pause.mjs` `sleep`.
- One contract constant: `tools/hub-client.mjs` exports `HUB_API_CONTRACT = 1`; `routes.mjs` `CONTRACT_VERSION` is that constant (same pattern as `HUB_API_SERVICE`/`SERVICE`). `installHubApi` accepts `/health` only when `ok`, `service`, `hub_version === ref` **and** `contract === HUB_API_CONTRACT`; its success line is `<ref> serves 127.0.0.1:<port>, contract <n> (...)`; the `last` text names the contract seen. `hubSmoke`'s health step fails `health` when `contract !== HUB_API_CONTRACT`.
- The stream phase (`streamCheck`, exported) runs on the smoke's test phone after the holds phase and before the retire. Holder `hosts:smoke`, why `hosts:smoke <ref> stream`, Lease id `<tag>-s`, `--no-connect --wait 0 --for 2m`. Sequence:
  1. `GET /stream` (header `accept: text/event-stream`, an `AbortController` it owns): status 200 and `content-type` starts `text/event-stream`; the first item is `retry: 3000`, then a `ready` frame whose id matches `ID_PATTERN` (import it from `tools/hub-api/stream.mjs`) and whose data has an object `status.hosts`; both within `HEALTH_TIMEOUT_MS`.
  2. `hub-device lease <tag> ... --id <tag>-s --json` (a separate process: the change reaches the service through the disk). From the moment the CLI answers, a `status` frame whose document lists the phone (in any host view's `phones[]`, `device === tag`) with `lease_id === <tag>-s` must arrive within `STATUS_WITHIN_MS = 2000`; `event` frames are skipped.
  3. With `restart` only: call the `restart()` seam (default `systemctl --user restart mobile-deploy-hub-api.service`, `HUB_API_UNIT` from `tools/hosts.mjs`); the old stream must end (bounded `RESTART_WITHIN_MS = 30_000`); `/health` must answer `ok`, the service name, `hub_version === ref` and the contract within `RESTART_WITHIN_MS` (one try every 500 ms); `hub-device status --json` must show the phone `held: lease` with `lease_id === <tag>-s`; a new `GET /stream` with `Last-Event-ID` = the last frame id seen must open with a `reset` frame, `reason: unresumable`, whose boot (id before `-`) differs from the first connection's boot. All further reads use this connection.
  4. `hub-device release <tag>-s`; a `status` frame showing the phone with `lease_id` null or absent must arrive within `STATUS_WITHIN_MS`.
  5. Idle: a `: keepalive` comment must arrive within `keepalive + 5 s` of the last item received (`keepalive` = `policy.api.stream_keepalive_s`); a frame restarts the window; at most 3 windows, else fail `the stream was never idle`.
  It logs `HUB_SMOKE stream: status frame <n> ms after the lease, keepalive after <m> ms idle` and, with restart, `HUB_SMOKE restart: <tag>-s held across the restart; the reconnect got reset (boot <a> -> <b>)`. Any failure aborts the stream, releases `<tag>-s` if it was taken (logged), then throws `HUB_SMOKE_FAILED stream: ...` (or `restart: ...`); `hubSmoke` then retires the phone as for any step.
- `hubSmoke({stream, restart})`: both default `false` (the function's existing call list is unchanged); `restart: true` without `stream` is a TypeError. CLI: `stream` defaults `true`, `--no-stream` skips it, `--restart` turns restart on, `--restart` with `--no-stream` is a usage failure (exit 1, no hub-device call). The `HUB_SMOKE_OK` line is unchanged.
- The `## v1.2.57` section (above `## v1.2.56`) says: Epic 8 on top of v1.2.56; `GET /status` and `GET /stream` (Candybar SSE wire, `retry: 3000`, `ready`/`status`/`event`/`reset`, keepalive every `stream_keepalive_s` 15 s, a change reaches subscribers within 2 s); restart safety (disk is the only state, `HUB_API_RESTARTING` with `retry: requeue`, `hub-client`'s reset-during-wait requeue, a new boot means `reset`, emulators survive); worker-thread observation and the one adb track socket; `contract` stays 1 (additive) and `hosts:install` now reads it back; no service unit is added; rollback is `hosts:install` of `v1.2.56`; the smoke's stream phase, `--no-stream` and `hosts:smoke -- --restart`; "Test changes you will see" naming each pre-existing suite changed since `v1.2.56` (`git diff v1.2.56 HEAD -- '*.test.mjs'`: `eta`, `clock`, `claims`, `hub-device`, `status-view`, `contract`, `hub-client`, plus this story's `hosts.test.mjs`, `hostkey.test.mjs`, `smoke.test.mjs`) and the new suites.

**Never:** run `mise run release`, `hosts:install`, `systemctl`, a real deploy, or touch the installed service, port 8794 or the live lock dir; move or push a tag or main. Never change a route, a response key, `CONTRACT_VERSION`'s value, the stream wire, `lock.mjs`, `claims.mjs`, the deploy path, `policy.json`, `AGENTS.md`/`CLAUDE.md` or `sprint-status.yaml`. Never run the smoke from `hosts:install`. Never add a route, a field or an error code.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Stream happy | fake `/stream` body (a controllable `ReadableStream`) that emits `retry`, `ready`, then a `status` frame showing `<tag>-s` after the CLI lease, one after release, then `: keepalive` | `HUB_SMOKE stream: ...` line; then retire and `HUB_SMOKE_OK` as before | — |
| `stream: false` | the 7.9 world | the exact existing call list; no `/stream` fetch | — |
| No status frame | the fake never shows `<tag>-s` (only `event` frames or nothing) | `HUB_SMOKE_FAILED stream: no status frame showed <tag>-s within 2 s`; `<tag>-s` released, phone retired | rejects |
| Bad opening | `/stream` answers 503, or a non-SSE type, or the first frame is not `ready` / bad id | `HUB_SMOKE_FAILED stream: ...` naming what was seen; no lease taken | phone retired |
| Never idle | a frame every 10 s with keepalive 15 s | `HUB_SMOKE_FAILED stream: the stream was never idle ...` after 3 windows (fake clock) | lease already released |
| Restart happy | `restart` seam ends the first body, `/health` answers again, status shows the lease, the second `/stream` (with `Last-Event-ID` = last id) opens `reset` with a new boot | `HUB_SMOKE restart: ... (boot a -> b)`; release, keepalive, OK | — |
| Lease lost / no reset | after restart status shows the phone free, or the reconnect opens `ready`, or `reset` with the same boot | `HUB_SMOKE_FAILED restart: ...` naming it | lease released, phone retired |
| Health back late | `/health` never answers the ref within 30 s | `HUB_SMOKE_FAILED restart: ...`, no status read after the deadline | lease release attempted |
| Contract readback | `installHubApi` `/health` with `contract` 2 (or missing) | keeps retrying, then throws naming `contract`; with 1 the line includes `contract 1` | — |
| Smoke contract | `/health` `contract` not `HUB_API_CONTRACT` | `HUB_SMOKE_FAILED health: ...contract...`; nothing registered | — |
| Entry flags | `--no-stream`, `--restart`, both | `stream` false; `restart` true; both is a usage failure, exit 1 | — |

</intent-contract>

## Code Map

- `tools/hosts/smoke.mjs` -- `hubSmoke` (L249): add `stream`/`restart` options; call the phase after 5b holds (L348-357) and before 6 retire (L359), via `stop('stream'|'restart', ...)` on failure like holds (L355). Health step L271-282: add the contract check. Reuse `failure`, `brief`, `parseJson`, `hubUrl(policy)`, `HEALTH_TIMEOUT_MS`, `HOLDER`, `hubDeviceCli`. `parseSmokeArgs` (L396) and `runEntry` (L408): `--no-stream`, `--restart`, forward both. Header comment (L1-22): add step 5c. Add a small SSE reader (blocks split on a blank line; `retry:`, `: comment`, `id:`, `event:`, `data:`) over `response.body.getReader()` + `TextDecoder`, whose `next(ms)` races one kept pending read against `sleep(ms)` and returns `{kind: retry|comment|frame|end|timeout, ...}`.
- `tools/hub-api/stream.mjs` -- `ID_PATTERN`, `RETRY_MS` exports (read-only). Frame text: `id: <boot>-<seq>\nevent: <type>\ndata: <json>\n\n`; `retry: 3000\n\n`; `: keepalive\n\n`. Opening frame data `{type, seq, key, at, [reason], status}`.
- `tools/hub-api/server.mjs` L235 -- keepalive is `policy.api.stream_keepalive_s * 1000` (15 s in `tools/ci/policy.json` L61). Read-only.
- `/status` document (`docs/hub-api-contract.md` "Status", L144): `{format, contract, hosts: {<key>: view}, registry, stale, checked_at}`; a view's `phones[]` rows carry `device`, `held`, `holder`, `lease_id`.
- `tools/hub-client.mjs` L20-30 -- add `HUB_API_CONTRACT` next to `HUB_API_SERVICE`. `tools/hub-api/routes.mjs` L28 -- `CONTRACT_VERSION = HUB_API_CONTRACT` (imports `HUB_API_SERVICE` from hub-client already, L30).
- `tools/hosts.mjs` `installHubApi` (L91-118) -- the readback condition (L107), success line, `last` (L108), failure line (L117). `HUB_API_UNIT` (L83) is the restart seam's unit.
- Tests: `tools/hosts/smoke.test.mjs` -- `world()` (L28-51) and `health()` fake (L24, `contract: '1.0'` must become `1`); add a fake `fetchImpl` routing `/health` and `/stream` (a `Response` over a `ReadableStream` the test pushes chunks into), and a fake sleep that yields (`setImmediate`) before advancing the clock so stream reads and timeouts race deterministically. `tools/hosts/hosts.test.mjs` L190 `health()` (`contract: '1'` → `1`) and add the contract-mismatch row. `tools/hostkey.test.mjs` L183 `offline` /health fake: add `contract: HUB_API_CONTRACT`.
- `tools/ci/v11.test.mjs` L975 -- the v1.2.56 notes test is the pattern; add a v1.2.57 one above it.
- `docs/hub-releases.md` L7 -- new `## v1.2.57` section above `## v1.2.56`. Source of "what changed": `git log v1.2.56..HEAD` (stories 8.1-8.6) and the six `spec-8-*.md` Auto Run Results.
- `README.md` L334-335 (`hosts:smoke` lines) and L338 (install readback "answers `hub-api` with `hub_version`..." → add contract; smoke paragraph → stream phase and `--restart`). `mise.toml` L164-165 `hosts:smoke` description: the stream phase, `--no-stream`, `--restart`.

## Tasks & Acceptance

**Execution:**
- [x] `tools/hub-client.mjs`, `tools/hub-api/routes.mjs` -- `HUB_API_CONTRACT`, `CONTRACT_VERSION` aliases it -- one contract constant
- [x] `tools/hosts.mjs` -- readback requires and prints `contract` -- AC2's readback
- [x] `tools/hosts/smoke.mjs` -- SSE reader, `streamCheck`, `stream`/`restart` options, health contract check, entry flags, header -- the repeatable live check
- [x] `tools/hosts/smoke.test.mjs`, `tools/hosts/hosts.test.mjs`, `tools/hostkey.test.mjs` -- every matrix row; fakes answer `contract` 1
- [x] `docs/hub-releases.md`, `tools/ci/v11.test.mjs` -- the `## v1.2.57` section and its test
- [x] `README.md`, `mise.toml` -- smoke and readback text
- [x] verification -- `heavy mise run check` and `heavy mise run --tool node@26 check` (sequential); then, if `sudo unshare -n` works, a live pre-merge run of this checkout's `server.mjs` and `hub-device` in their own network namespace with temp `HUB_LOCK_DIR`/`HUB_EVENT_DIR`/`HOME` (as Story 7.9 did), running `node tools/hosts/smoke.mjs --ref <its hub_version> --hub-device "node tools/device/hub-device.mjs" --no-holds` to `HUB_SMOKE_OK` with the stream line

**Acceptance Criteria:**
- Given HEAD, when `mise run check` runs on Node 24 and on Node 26, then both are green, and the contract document lists `GET /status` and `GET /stream` and the contract test asserts their key sets against handler output.
- Given `docs/hub-releases.md`, when `releaseNotes(text, 'v1.2.57')` reads it, then it names `/status`, `/stream`, the 2 s change delivery, keepalive, restart safety (`HUB_API_RESTARTING`, `reset`), `contract` stays 1 and is read back, the rollback to `v1.2.56`, `hosts:smoke -- --restart` and the test changes.
- Given an installed Hub API, when `mise run hosts:install` reads it back, then it succeeds only when `/health` names the release's `hub_version` and the code's `contract`, and its line prints both.
- Given an installed Hub API, when `mise run hosts:smoke -- --restart` runs, then it ends `HUB_SMOKE_OK` only when a `hub-device` Lease shows in a `status` frame within 2 s, keepalives arrive while idle, the Lease survives a unit restart and the reconnect with the old id gets `reset`.
- Given the operator-owed half (merge and push, release 1.2.57, `hosts:install` readback, the live smoke), when this story finishes, then the spec is `awaiting-operator` with each listed under `operator_actions`.

## Spec Change Log

## Review Triage Log

### 2026-11-26 — Review pass
- verdicts: 26 findings — high 0, medium 1, low 18, false 7, maybe-false 0
- findings:
  - `[false]` `[reject]` blind: the frontmatter status (`in-review`) contradicts the awaiting-operator AC — `in-review` is the review step's transitional state; finalization writes `awaiting-operator`, matching `operator_actions` and the Auto Run Result.
  - `[low]` `[reject]` blind: the `/health` acceptance predicate is written three times (install readback, smoke health, restart loop) — each site already shares `HUB_API_SERVICE`/`HUB_API_CONTRACT`; a shared predicate is new public surface for a rare field addition.
  - `[false]` `[reject]` blind: no test ties the fakes to the real `/health` handler — `tools/hub-api/server.test.mjs:186` pins the real handler's body with `contract: 1`, and `CONTRACT_VERSION` is `HUB_API_CONTRACT` by aliasing, so the readback compares the server's own constant.
  - `[low]` `[patch]` blind: `sseReader` has no direct tests — grouped with the verification-gap reader finding; fixed in 8d81fd3 by a test that feeds the real `createStream` output through `sseReader`. The parse nits (`\r`, `__proto__`, unflushed decoder, the 10 000-spin fallthrough) are unreachable with the hub's own writer, which emits `\n` only and whole blocks.
  - `[low]` `[reject]` blind: the default `restartHubApiUnit` seam is never executed by a test — the spec forbids running `systemctl`; it mirrors the tested `hubDeviceCli` mapping, and the operator's `hosts:smoke -- --restart` run exercises it.
  - `[low]` `[reject]` blind: cleanup releases a Lease that was never taken — a deliberate safe superset (the same as Story 7.9's `live` set): the id `<tag>-s` is unique to this run and releasing an unknown id is harmless; it also covers a CLI that timed out after taking.
  - `[low]` `[patch]` blind: weak or tautological test assertions — fixed in 8d81fd3: the idle-window test now asserts exactly 20 000 ms. The loose notes regexes follow the established `v11.test.mjs` pattern and were not changed.
  - `[low]` `[reject]` blind: the notes' test-changes list omits `tools/ci/v11.test.mjs` — every release edits that suite for its own notes test, and the v1.2.56 section omits it by the same convention.
  - `[low]` `[patch]` blind: the status-frame predicates are loose — grouped with the verification-gap content finding (fixed in 8d81fd3). Checking `held`/holder too, and logging the release latency, were not added: the test phone carries no Job Hold or Reservation, and the release frame is already bounded by 2 s.
  - `[low]` `[reject]` blind: the default stream phase adds ~15 s, and `--restart` has no waiter guard — the 15 s is the keepalive the AC asks to see; `--restart` is opt-in and documented (README, mise, notes, operator action), and a guard adds branches.
  - `[low]` `[reject]` blind: the `response.text` fallback is test-driven dead code, and smoke imports server constants — the fallback matches the existing health step in the same file; importing `ID_PATTERN`/`RETRY_MS` from their one owner keeps a single source.
  - `[low]` `[reject]` blind: the README paragraph grows — cosmetic; it follows the paragraph's one-sentence-per-story convention.
  - `[low]` `[reject]` edge: the Lease is held 2 min but the restart budget is longer — a real restart plus health plus reconnect takes seconds (the live sandbox run: tens of ms to the frame); only a pathological restart near the 120 s systemctl timeout could outlast it, where a failure is the right answer; 2 min is the intent-contract's value.
  - `[low]` `[reject]` edge: `leaseTaken` set before the CLI call — same as the blind row above.
  - `[false]` `[reject]` edge: `state.lastId` may be null at the reconnect — `open()` refuses any opening frame whose id fails `ID_PATTERN`, and `read()` records that id in `state.lastId`, so it is always set before the restart branch.
  - `[false]` `[reject]` edge: a `\r\n` pair split across chunks — `tools/hub-api/stream.mjs` writes `\n` only (`frameText`, `RETRY_TEXT`, `KEEPALIVE_TEXT`), now pinned by the real-writer test.
  - `[low]` `[reject]` edge: a busy service fails `never idle` — the 3-window bound is the spec's; hub traffic is human-scale, keepalives go out after 15 s of silence per connection, and the operator reruns.
  - `[low]` `[reject]` edge: a missing phone row after release gives a generic message — cosmetic; the test phone is registered for the whole phase.
  - `[low]` `[reject]` edge: `v11.test.mjs` is missing from the notes' list — same as the blind row above.
  - `[medium]` `[patch]` verification-gap: the step-2 and step-4 status-frame content was never pinned by a failing case — fixed in 8d81fd3: a `staleStatus` knob ('lease', 'release') with two tests expecting the `no status frame showed ...` failures, cleanup and retire; both tests were shown to fail with the predicates replaced by `() => true`.
  - `[low]` `[patch]` verification-gap: the smoke's SSE reader was only fed hand-written wire text — fixed in 8d81fd3: a test drives the real `createStream` (fake timers and sink) and reads `retry` 3000, `ready`, `status`, `keepalive`, then `end` through `sseReader`.
  - `[low]` `[reject]` verification-gap (other): `restartHubApiUnit` untested — same as the blind row above.
  - `[low]` `[patch]` verification-gap (other): the tautological idle-window assertion — same fix as the blind row above (8d81fd3).
  - `[false]` `[reject]` intent: AC1 is not shown in the diff — the contract document already lists `GET /status` and `GET /stream` and `tools/hub-api/contract.test.mjs` (L409, L426, from Stories 8.1 and 8.4) asserts their key sets against handler output; `mise run check` is 1628/1628 on Node 24 and on Node 26.13.0 in this run.
  - `[false]` `[reject]` intent: the working-copy frontmatter says `in-review` — the review step's transitional state; finalized to `awaiting-operator`.
  - `[false]` `[reject]` intent: the live surfaces (release, `v1`, the installed service on 8794, the real unit restart) were not exercised — owed by the operator by design (the release refuses a `main` that is not `origin/main`, and the orchestrator merges this branch); each is listed under `operator_actions`, and a sandboxed live run covered the code paths.

## Design Notes

Why the smoke phone and not the S24: the stream check takes one Lease and, with `--restart`, bounces the unit. On the test phone it touches no device anyone holds; the AC's "takes a Lease with `hub-device`" is the same CLI path whatever the target. Why `--restart` is opt-in: a restart answers every open wait `HUB_API_RESTARTING` (callers requeue, Story 8.6), so a routine post-install smoke should not do it unasked; the release check asks for it.

Why the status frame is timed from the CLI's answer: the hub-device process has written the lock by then, so the window measures the change feed (watch + 250 ms debounce + render), which is what "within 2 s" promises.

## Verification

**Commands:**
- `node --test tools/hosts/smoke.test.mjs tools/hosts/hosts.test.mjs tools/hostkey.test.mjs tools/hub-api/contract.test.mjs tools/clock.test.mjs` -- expected: all pass
- `node --test --test-name-pattern v1.2.57 tools/ci/v11.test.mjs` -- expected: pass
- `heavy mise run check` and `heavy mise run --tool node@26 check` -- expected: green

## Auto Run Result

**status: awaiting-operator.** Everything an agent can do is done on the story branch. The release, `hosts:install`, the live smoke on the installed service and publishing the notes are owed by the operator, listed under `operator_actions` in the frontmatter.

### Summary

- **For this release:** the `## v1.2.57` notes are written and pinned by a test (`/status`, `/stream`, the 2 s, keepalive, restart safety, `contract` stays 1 and is read back, the rollback to `v1.2.56`, `hosts:smoke -- --restart`, the test changes). `hosts:install`'s readback now requires and prints `contract`, and `routes.mjs`'s `CONTRACT_VERSION` is the one `HUB_API_CONTRACT` constant exported from `tools/hub-client.mjs`.
- **For the level above, every post-install check of the live status (`belsky-doctrine`):** `mise run hosts:smoke` has a `stream` phase (default on, `--no-stream` skips it) and an opt-in `--restart`: `streamCheck` runs the AC's sequence on the smoke's own test phone (open, Lease within 2 s in a `status` frame, release the same way, keepalive idle) and, with `--restart`, restarts the unit mid-session and requires the old stream to end, `/health` to answer again, the Lease to be held and the reconnect with the old `Last-Event-ID` to open `reset` on a new boot. The smoke's health step also requires the contract.

### Files changed

- `tools/hub-client.mjs`, `tools/hub-api/routes.mjs`: `HUB_API_CONTRACT`; `CONTRACT_VERSION` aliases it.
- `tools/hosts.mjs`: the readback requires and prints `contract`.
- `tools/hosts/smoke.mjs`: `sseReader`, `streamCheck`, `restartHubApiUnit`, the `stream`/`restart`/`restartUnit` options of `hubSmoke`, the health contract check, `--no-stream`/`--restart`, header comment.
- `tools/hosts/smoke.test.mjs`, `tools/hosts/hosts.test.mjs`, `tools/hostkey.test.mjs`: every matrix row; fakes answer `contract` 1; (review) the status-frame content cases, the exact idle window and the real-writer `sseReader` test.
- `docs/hub-releases.md`, `tools/ci/v11.test.mjs`: the `## v1.2.57` section and its test.
- `README.md`, `mise.toml`: the smoke and readback text.

### Review findings

- **Totals:** 26 findings (blind 12, edge 7, verification-gap 4, intent 3): high 0, medium 1, low 18, false 7.
- **Patches applied (commit 8d81fd3, tests only):**
  - medium: the status-frame content of steps 2 and 4 is pinned by two failing cases (`staleStatus` 'lease' and 'release').
  - low: `sseReader` is tested against the real `createStream` output.
  - low: the idle-window test asserts exactly 20 000 ms.
- **Deferred:** none.
- **Rejected, false (7):** the transitional `in-review` status (two rows); fakes not tied to the real handler (`server.test.mjs:186` pins it); a null `lastId` (the opening id is validated and recorded); a split `\r\n` (the writer emits `\n` only); AC1 not in the diff (8.1/8.4 tests already assert it, check green on both Nodes); live surfaces not exercised (operator-owed by design).
- **Rejected, low (13), each with its reason in the triage log:** the triplicated `/health` predicate; the untested default restart seam (two rows); the release of a not-taken Lease (two rows); `v11.test.mjs` missing from the notes list (two rows); the extra 15 s and no `--restart` waiter guard; the `response.text` fallback and the server-constant import; the README length; the 2 min Lease against the restart budget; a busy service never idle; the generic missing-row message.

### Follow-up review

`followup_review_recommended: false`. This was the first pass; patched by verdict: high 0, medium 1, low 2. That is fewer than two medium patches and no high.

### Verification

- `heavy mise run check` on Node 24 and `heavy mise run --tool node@26 check` on Node 26.13.0 (run one after the other), after the review patches: 1628/1628 each, exit 0. Before them: 1625/1625 each.
- Focused: `node --test tools/hosts/smoke.test.mjs tools/hosts/hosts.test.mjs tools/hostkey.test.mjs tools/hub-api/contract.test.mjs tools/clock.test.mjs` 125/125; `node --test --test-name-pattern v1.2.57 tools/ci/v11.test.mjs` 1/1.
- Matrix audit: every I/O row has a passing test (stream happy, `stream: false`, no status frame, bad opening, never idle, restart happy, lease lost / no reset, health back late, contract readback in `hosts.test.mjs`, smoke contract, entry flags).
- Live pre-merge run of this checkout's `server.mjs` and `hub-device` in their own network namespace (`sudo unshare -n`, temp `HUB_LOCK_DIR`/`HUB_EVENT_DIR`/`HOME`, `HUB_REF=v1.2.57-pre`): `node tools/hosts/smoke.mjs --ref v1.2.57-pre --hub-device "node tools/device/hub-device.mjs" --no-holds` ended `HUB_SMOKE_OK` with `HUB_SMOKE stream: status frame 169 ms after the lease, keepalive after 15003 ms idle`. The restart half was run live the same way through `streamCheck({restart: true})` with a restart seam that stops and starts that server: `statusMs` 49, `keepaliveMs` 15003, boots `4108c0bcaff8 -> 3ad44f5bf5d5`.

### Residual risks

- The installed service, the real `systemctl --user restart` default seam (`restartHubApiUnit`) and the S24 have not been touched: they are the operator's checks.
- `--restart` answers any open wait `HUB_API_RESTARTING`; callers requeue (Story 8.6), but run it when nobody is mid-wait.
