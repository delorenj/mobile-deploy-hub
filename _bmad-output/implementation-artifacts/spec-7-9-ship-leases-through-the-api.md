---
title: 'Story 7.9: Ship Leases through the API (pre-release half)'
type: 'chore'
created: '2026-11-25'
status: 'awaiting-operator'
operator_actions:
  - 'Merge this story branch into main and push main to origin (main is 16+ commits past origin/main 3999f38); the release refuses a main that is not origin/main.'
  - 'Before releasing, confirm `git ls-remote origin refs/tags/v1 refs/tags/v1.2.56` shows v1 on v1.2.55 and no v1.2.56 tag; if v1 moved or 1.2.56 is taken, retitle the `## v1.2.56` section of docs/hub-releases.md (and its test in tools/ci/v11.test.mjs) first.'
  - 'From a fresh clean clone of main on big-chungus, run `mise run release -- 1.2.56`; confirm every app strict dry run is green, v1 moved to v1.2.56, and `git show v1.2.56` carries the notes and a `Roll back:` line that names v1.2.55 (and no service stop).'
  - 'After the release runner confirms its runs are finished, run `mise run hosts:install` on big-chungus from a clean checkout at tag v1.2.56; confirm the HUB_API readback for v1.2.56 and `systemctl --user status mobile-deploy-hub-api`.'
  - 'Run `mise run hosts:smoke` on big-chungus and confirm HUB_SMOKE_OK v1.2.56 with a `HUB_SMOKE holds: api and cli match on smoke-<id>` line (it leaves one retired smoke-<id> record in registry.json).'
  - 'Run the AC live check on the S24: `mise run hosts:smoke -- --holds-on s24` (s24 must be free with nobody waiting) and confirm HUB_SMOKE_OK with `holds: api and cli match on s24`; optionally watch `hub-device status` in another shell while it runs.'
  - 'If the release is red or anything regresses: move v1 back to v1.2.55, then `mise run hosts:install` from a clean checkout at v1.2.55 (no systemctl disable: no unit is added).'
baseline_revision: '853107356acab1dda9351519aca4de7e4fb87eff'
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-7-context.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-6-12-ship-the-registry-and-the-hub-api.md'
  - '{project-root}/docs/hub-api-contract.md'
warnings: ['oversized']
deferred: []
---

<intent-contract>

## Intent

**Problem:** Stories 7.1 to 7.8 are on local main (16 commits past `origin/main` `3999f38`; `v1` is on `v1.2.55`), but nothing ships them. `docs/hub-releases.md` has no `## v1.2.56` section, so the tag would not say that a Job Hold cannot be force-released or that a deploy-target Lease is capped at 60 min. Nothing pins that the contract lists AD-42's Hold routes. And the AC's live check (take, wait for, extend and force-release a Lease on the S24 through the API, see each state in `hub-device status`, and match the same actions through the CLI) is a hand-typed sequence every later release touching the Hold routes would repeat (FR-10, FR-11, FR-21).

**Approach (`belsky-doctrine`, one level up from "ship this release"):** every post-install check of the Hold routes. (1) `mise run hosts:smoke` gains a `holds` phase, `holdParity`: the same Hold sequence through the API and through the CLI on one target, `hub-device status --json` read after each step, and the two normalised traces required equal. It runs on the smoke's own test phone by default (touches no real device), or on a named word with `--holds-on s24` (the AC's S24 run). (2) The contract test pins AD-42's Hold routes. (3) The `## v1.2.56` notes, and `mise run check` green on Node 24 and Node 26. The release, `hosts:install` and the live S24 run go to the operator, because the release refuses a `main` that is not `origin/main` and the orchestrator merges this branch.

## Boundaries & Constraints

**Always:**
- Node 24 ESM, `node:` builtins only, hermetic tests (injected `cli`, `fetchImpl`, `now`, `sleep`). Every wait is a bounded `for` loop with `pause.mjs` `sleep` (AD-19); `tools/clock.test.mjs` stays green.
- The smoke drives the operator's surfaces only: the Hub API at `hubUrl(policy)` and `hub-device` on PATH. The holds phase uses holder `hosts:smoke` and why `hosts:smoke <ref> holds` on both doors, client-minted ids `<tag>-<a|b>-<api|cli>` (`tag` is the smoke phone's name), `for` 2 min on takes and 1 min on the extend, a 30 s wait, and `--no-connect` on every CLI lease (an API phone Lease is `--no-connect`, contract "Lease").
- The sequence, per door: target must be free with nobody waiting (else fail, nothing taken) → take A (no wait) → start B waiting → status shows B first in line → extend A is refused `HUB_LEASE_EXTEND_REFUSED` (API 409 `reason: waiters`; CLI exit 76) → force-release A → B is granted → extend B (status `expires_at` moves later by exactly 60 000 ms) → release B → status shows the target free. A snapshot after each step is `{step, held, holder, why, lease, waiters: [{lease, position, holder}]}` with ids mapped to `A`/`B` (any other id is `other`); the Lease answers are compared on `{lease, device, holder, why, env keys}`. The API trace must deep-equal the CLI trace.
- Any holds failure releases every id it started (`hub-device release <id>`, which also withdraws a waiter), awaits the pending wait, logs each, then the smoke's own cleanup retires the phone.
- `hubSmoke({holds})`: `false` (the function's default) skips the phase; `true` runs it on the smoke phone after step 5 (release) and before the retire; a word runs it there on that word. The CLI entry defaults to `true`, takes `--holds-on <word>` and `--no-holds`. The `HUB_SMOKE_OK` line is unchanged; the phase logs `HUB_SMOKE holds: api and cli match on <target> (...)`.
- The `## v1.2.56` section states that a Job Hold (a deploy job's lock or its place in line) cannot be force-released or cancelled through the hub and points to `gh run cancel`, that a deploy-target Lease is capped at 60 min (any Lease 48 h; extend refused while anyone waits), the new routes and CLI verbs, that `contract` stays 1 (additive), that no service unit is added (rollback is `hosts:install` of `v1.2.55`; API Leases already taken keep their expiry under it), the operator-visible changes (`HUB_LEASE_EXTEND_REFUSED` exits 76, not 1; the `phone` busy wording), the test changes to pre-existing suites, and `hosts:smoke -- --holds-on s24`.

**Never:** run `mise run release`, `hosts:install`, a real deploy, or touch the installed service, its port 8794 or the live lock dir; move or push a tag or main. Never edit `lock.mjs`, `claims.mjs`, the routes, the deploy path, `policy.json`, `AGENTS.md`/`CLAUDE.md` or `sprint-status.yaml`. Never run the smoke from `hosts:install`. Never add a route, a field or an error code.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Holds happy | fake hub where both doors share one lock state | `HUB_SMOKE holds: api and cli match on smoke-x ...`; the API and CLI traces are equal and have 6 snapshots; then retire and `HUB_SMOKE_OK` as before | — |
| `holds: false` | the 6.12 world | the exact 6.12 call list (no API Hold call, no extra status) | — |
| Target busy | status shows the target held by someone else | `HUB_SMOKE_FAILED holds: <target> is not free ...`; no take was sent; the phone is retired | rejects |
| Doors differ | the fake API grants B but status shows it still waiting on the CLI side, or the API extend is allowed while waiting | `HUB_SMOKE_FAILED holds: api and cli differ at <step>: ...` naming both snapshots | ids released, phone retired |
| Waiter never shows | status never lists B | `HUB_SMOKE_FAILED holds: B never waited ...` after a bounded wait (10 s, fake clock); B released (withdrawn), A released | no status read after the deadline |
| Extend not moved | status `expires_at` after the extend is not +60 000 ms | `HUB_SMOKE_FAILED holds: ... extend` | ids released |
| `--holds-on s24` | entry argv | `hubSmoke` gets `holds: 's24'`; `--no-holds` gives `false`; `--holds-on` without a value or with both flags is a usage failure, exit 1, no hub-device call | — |

</intent-contract>

## Code Map

- `tools/hosts/smoke.mjs` -- `hubSmoke` (L51): add the `holds` option and call the phase between step 5 (L142-146) and step 6 (L148). `cleanup`/`stop` (L85-97) stay the phone's; the phase owns its ids' cleanup. `brief`, `parseJson`, `hubUrl(policy)` (L73) and `HEALTH_TIMEOUT_MS` are reused. Entry argv (L183-194): `known` set, `option()`. Export `holdParity` and a small `apiCaller(fetchImpl, policy)` (`{status, body}`; a timeout of wait + 30 s, else 30 s, AD-48).
- Hub API shapes (`docs/hub-api-contract.md`): `POST /leases {resource, for_ms, holder, why, id, wait_ms}` → Lease `{lease_id, resource, lock, device, holder, why, claimant_kind, started_at, expires_at, env, emulator}`; busy 409 `HUB_LOCK_TIMEOUT`. `POST /leases/{id}/extend {for_ms, holder}` → Lease; 409 `HUB_LEASE_EXTEND_REFUSED` `reason: waiters`. `POST /leases/{id}/force-release {why, holder}` → ForceRelease. `POST /leases/{id}/release {holder}` → Release. Errors are problem+json with `code`, `reason`.
- `tools/device/hub-device.mjs` outputs: `lease --json` L272 `{lease_id, device, holder, why, expires_at, env}`; busy exit 76; `extend --json` L360 `{lease_id, lock, device, expires_at}`, refused exit 76 with stderr `HUB_LEASE_EXTEND_REFUSED`; `force-release --json` L392; `release <id>` exits 0 and withdraws a waiter. USAGE L136.
- `hub-device status --json` (`tools/device/status-view.test.mjs` L92-96): `phones[]` `{device, lock, held: free|lease|job, holder, lease_id, why, expires_at, ...}`; `waiters[]` `{lock, device, position, lease_id, holder, ...}`.
- `tools/hosts/smoke.test.mjs` -- the `world()` fake (L28-51): extend it with one shared lock state that the fake `cli` and a fake `fetchImpl` (routing `/health` and the four Hold routes) both mutate, waits as promises resolved on force-release. Existing tests keep `holds` unset.
- `tools/hub-api/contract.test.mjs` -- route table test (L227). Add a frozen AD-42 Hold route list (`POST /leases`, `GET /leases/{id}`, `POST /leases/{id}/extend`, `/release`, `/force-release`, `POST /requests/{id}/cancel`, `POST /reservations/{run_key}/force-release`) asserted present in the document's table.
- `tools/ci/v11.test.mjs` -- L958 the v1.2.53 notes test is the pattern; add a v1.2.56 one (newest first, above `## v1.2.55`).
- `docs/hub-releases.md` -- add `## v1.2.56` above `## v1.2.55` (L7). Pre-existing suites changed since v1.2.55 (`git diff 24e56e6 HEAD`): `claims.test.mjs` (`HUB_LEASE_EXTEND_REFUSED` exit 1 → 76, `HUB_LEASE_LOST` on changed hands, the Pool size order), `hub-device.test.mjs` (the `phone` busy wording keeps `host lock <name> is held by`), `lease.test.mjs` (`claimantKind`, `actor`), `pool-request.test.mjs` (Pool timeout wording, `claimant_kind` on tickets), `emulator.test.mjs` (helpers moved to `emulator-fixtures.mjs`), `deploy-path.test.mjs` (no deploy file force-releases a Reservation), `contract.test.mjs` (the Hold routes).
- `README.md` L334 (`hosts:smoke` line) and the Hub API paragraph: the holds phase and `--holds-on s24`. `mise.toml` L164 unchanged (args pass through).

## Tasks & Acceptance

**Execution:**
- [x] `tools/hosts/smoke.mjs` -- `apiCaller`, `holdParity({target, tag, ref, cli, api, now, sleep, log})` returning `{target, traces: {api, cli}}`, the `holds` option in `hubSmoke`, entry flags `--holds-on`/`--no-holds`, header comment -- the repeatable live Hold check
- [x] `tools/hosts/smoke.test.mjs` -- every matrix row (shared fake state; no port)
- [x] `tools/hub-api/contract.test.mjs` -- the AD-42 Hold routes are in the document's table
- [x] `docs/hub-releases.md`, `tools/ci/v11.test.mjs` -- the `## v1.2.56` section and its test
- [x] `README.md` -- the holds phase and `--holds-on s24`
- [x] verification -- `heavy mise run check` and `heavy mise run --tool node@26 check`; a live pre-merge smoke of this checkout's `server.mjs` and `hub-device` with temp `HUB_LOCK_DIR`/`HUB_EVENT_DIR`/`HOME`, isolated from the installed service (its own network namespace via `sudo unshare -n`, loopback up, run as the user), with holds on the smoke phone and `--holds-on s24`

**Acceptance Criteria:**
- Given HEAD, when `mise run check` runs on Node 24 and on Node 26, then both are green and the contract test asserts every AD-42 Hold route with its exact field list.
- Given `docs/hub-releases.md`, when `releaseNotes(text, 'v1.2.56')` reads it, then it states a Job Hold cannot be force-released (and names `gh run cancel`) and a deploy-target Lease is capped at 60 min, and lists the rollback to `v1.2.55` and `hosts:smoke -- --holds-on s24`.
- Given an installed Hub API and `hub-device`, when `mise run hosts:smoke -- --holds-on s24` runs, then it ends `HUB_SMOKE_OK` only when take, wait, refused extend, force-release, extend and release on the S24 show the same `status` states through the API and through the CLI.
- Given the operator-owed half (merge and push, release 1.2.56, `hosts:install` readback, the S24 smoke, published notes), when this story finishes, then the spec is `awaiting-operator` with each listed under `operator_actions`.

## Spec Change Log

## Review Triage Log

### 2026-11-25 — Review pass
- verdicts: 29 findings — high 0, medium 1, low 15, false 13, maybe-false 0
- findings:
  - `[low]` `[reject]` blind: the parity snapshot omits `claimant_kind` and the event log — the AC asks for the same `status` states; per-action events and `claimant_kind` are already pinned by the 7.x hermetic suites, so adding them to the snapshot is new comparison surface for a rare divergence.
  - `[false]` `[reject]` blind: the expected checks run only after both doors finish, so a failure names the wrong step — `holdParity` checks each door's trace against `HOLD_EXPECTED` and the failure message names the first differing or wrong step and both snapshots.
  - `[low]` `[reject]` blind: `POST /requests/{id}/cancel` is not exercised by the smoke — the AC names take, wait, extend and force-release; cancel is covered by its own story's tests and pinned in the contract test; adding a step lengthens every post-install smoke.
  - `[low]` `[reject]` blind: an id joins `live` before its take is confirmed — a deliberate safe superset; `hub-device release` of an unknown id exits 0, so undo stays correct.
  - `[low]` `[reject]` blind: no retry and no signal handler around the holds phase — same as the 6.12 smoke; the Leases expire after 2–3 min on their own, and a handler adds branches for an operator Ctrl-C.
  - `[low]` `[reject]` blind: `--holds-on` does not validate the word — the operator types `s24`; an unknown word fails at "status does not list <target>" before anything is taken.
  - `[false]` `[reject]` blind: a busy target fails the whole smoke — that is the spec's intended behaviour (matrix row "Target busy"): fail, take nothing.
  - `[low]` `[reject]` blind: the contract test does not pin the Hold routes' error codes — the codes are pinned by the existing error-codes test in `contract.test.mjs`, and the live smoke checks the refused-extend reason.
  - `[low]` `[reject]` blind: the notes undersell breaking changes — the exit 1 → 76 change and the `phone` busy wording are listed under "Operator-visible changes"; restructuring is cosmetic.
  - `[false]` `[reject]` blind: `hubSmoke` defaults `holds: false` while the CLI defaults to true — intended by the spec (Boundaries: "`false` (the function's default) ... The CLI entry defaults to `true`"); no programmatic caller exists.
  - `[low]` `[reject]` blind: the v1.2.56 notes test is regex-brittle — it follows the established v1.2.53/v1.2.55 pattern in `v11.test.mjs`.
  - `[low]` `[reject]` blind: the duration formatting in the log line is fragile for non-whole values — the constants are whole minutes/seconds; no caller passes anything else.
  - `[false]` `[reject]` blind: `HOLD_WAIT_MS` (30 s) is not tied to `WAITER_SHOWS_WITHIN_MS` (10 s) — measured: a live `hub-device status --json` takes 0.11 s, so the steps before force-release take about 1 s against a 30 s wait.
  - `[low]` `[reject]` blind: the `apiCaller` fallback body and the long README paragraph — cosmetic.
  - `[low]` `[reject]` edge: undo can miss B's ticket if B is not yet registered when a status read fails — needs a status failure inside a millisecond window; release of B's id is still attempted and B's wait resolves or expires in 30 s; a fix adds a branch.
  - `[false]` `[reject]` edge: `HOLD_WAIT_MS` against real step timing — measured 0.11 s per status read live; the wait cannot lapse before force-release.
  - `[low]` `[reject]` edge: the "free" pre-check ignores a Reservation on the target — only `adb`/`s26` carry Reservations; the smoke phone and the S24 have none.
  - `[low]` `[reject]` edge: a repeated `--holds-on` or the `--holds-on=s24` form — the `=` form gets a usage error; a repeat takes the last value; operator-only input.
  - `[low]` `[reject]` edge: wait-b's deadline claim — a 30 s wait cannot end inside the 10 s shows-within window except by an immediate error, which the next iteration catches.
  - `[medium]` `[patch]` verification-gap: the entry's forwarding of `holds` into `hubSmoke` was untested — fixed in 57f91ac: the entry block became `runEntry(argv, {smoke, makeCli, defaultRef})` and a new in-process test asserts `holds` true / `'s24'` / `false` reach `hubSmoke`.
  - `[low]` `[patch]` verification-gap: the `mise.toml` `hosts:smoke` description no longer described the task — fixed in 57f91ac: it names the holds phase, `--holds-on <word>` and `--no-holds`.
  - `[false]` `[reject]` verification-gap: `holdParity` runs only against fakes — the pre-merge live run against this checkout's `server.mjs` and `hub-device` (isolated netns, temp lock dir) ended `HUB_SMOKE_OK` on the smoke phone and with `--holds-on s24`.
  - `[false]` `[reject]` intent: AC1 has no check evidence — `mise run check` is 1438/1438 on Node 24.15.0 and Node 26.13.0.
  - `[false]` `[reject]` intent: the contract document already listed the routes, so nothing changed — the AC asks the test to pin them; the frozen `HOLD_ROUTES` list is asserted in the document, `ROUTES` and the live handler.
  - `[false]` `[reject]` intent: AC2 (release, `v1` moved, `hosts:install`) is not exercised — operator-owed by design (the release refuses a `main` that is not `origin/main`); listed under `operator_actions`.
  - `[false]` `[reject]` intent: AC3 is shown on fakes and the default target is not the S24 — the live netns run covered it, and `--holds-on s24` on the real S24 is an operator action.
  - `[false]` `[reject]` intent: a script replaces the operator's hand check and adds expectations — that is the one-level-up the intent's approach chose (`belsky-doctrine`); the extra checks are the AC's states.
  - `[false]` `[reject]` intent: AC4's notes exist only as a file — `mise run release` publishes `docs/hub-releases.md`'s section in the tag annotation; publishing is an operator action.
  - `[false]` `[reject]` intent: "new contract" against `contract` stays 1 — AD-42 raises `contract` only on a non-additive change; every Epic 7 route is additive, and the readback checks `hub_version` v1.2.56 with `contract` 1.

## Design Notes

Why the smoke phone by default: the parity run takes four Leases and two waits. On the test phone it can run after every `hosts:install` without touching a device someone may hold. `--holds-on s24` is the same code on the AC's device. A busy target fails before anything is taken.

Why both doors in one run: parity is about one code path (Claims) answering two front doors. Running them back to back on the same target, with the same holder and why, makes "equal snapshots" a real check and not a comparison against a stored golden.

## Verification

**Commands:**
- `node --test tools/hosts/smoke.test.mjs tools/hub-api/contract.test.mjs tools/ci/v11.test.mjs tools/clock.test.mjs` -- expected: all pass
- `heavy mise run check` and `heavy mise run --tool node@26 check` -- expected: green

## Auto Run Result

**status: awaiting-operator.** Everything an agent can do is done and committed on the story branch. The release, `hosts:install`, the real-S24 smoke and publishing the notes are owed by the operator, listed under `operator_actions` in the frontmatter.

### Summary

- **For this release:** the `## v1.2.56` notes are written and pinned by a test. They cover the Job Hold rule (no force-release or cancel through the hub, use `gh run cancel`), the 60 min cap on a deploy-target Lease (48 h for any Lease, and no extend while anyone waits), the new routes and CLI verbs, `contract` staying at 1, the rollback to `v1.2.55` and `hosts:smoke -- --holds-on s24`. The contract test pins all seven AD-42 Hold routes with their exact field lists.
- **For the level above, every post-install check of the Hold routes (`belsky-doctrine`):** `mise run hosts:smoke` now has a `holds` phase, `holdParity`. On one target it runs the steps take A, wait B, refused extend of A, force-release A, extend B and release B, once through the Hub API and once through `hub-device`. It reads `hub-device status --json` after each step and requires the two normalised traces to be equal. By default it runs on the smoke's own test phone, so it touches no real device. `--holds-on s24` runs it on the AC's device and `--no-holds` skips it. Any later release that touches the Hold routes gets this check from one command.

### Files changed

- `tools/hosts/smoke.mjs`: adds `apiCaller`, `holdParity`, `parseSmokeArgs`, `runEntry`, the `holds` option in `hubSmoke`, and the `--holds-on` and `--no-holds` flags.
- `tools/hosts/smoke.test.mjs`: adds the `holdsWorld()` shared fake lock state, one test for every matrix row, and tests for argument parsing, the entry spawn and `runEntry` forwarding.
- `tools/hub-api/contract.test.mjs`: adds a frozen `HOLD_ROUTES` list and asserts it against the document table, `ROUTES` and the live handler output.
- `docs/hub-releases.md`: adds the `## v1.2.56` section.
- `tools/ci/v11.test.mjs`: adds a test for the v1.2.56 notes.
- `README.md`: the `hosts:smoke` lines and the Hub API paragraph now describe the holds phase.
- `mise.toml`: the `hosts:smoke` description now names the holds phase and its flags.

### Review findings

- **Totals:** 29 findings (blind 14, edge 5, verification-gap 3, intent 7): high 0, medium 1, low 15, false 13.
- **Patches applied (commit 57f91ac):**
  - medium: the entry's forwarding of `holds` was untested. It is now `runEntry`, covered by an in-process test.
  - low: the `mise.toml` description was out of date. It is fixed.
- **Deferred:** none.
- **Rejected, false (13):**
  - Expected checks run after both doors: false, because the failure message names the first wrong step.
  - A busy target fails the smoke: false, because the spec intends that.
  - The library and entry defaults differ: false, because the spec intends that.
  - The wait window is not linked to the shows-within window (two findings): false, measured at 0.11 s per status read.
  - `holdParity` is tested only against fakes: false, because the live netns run passed.
  - Seven intent findings:
    - AC1 evidence: false, both Node versions pass 1438/1438.
    - The document already listed the routes: false, the AC asks for the test to pin them.
    - AC2 is not exercised: false, it is owed by the operator.
    - AC3 rests on fakes with a non-S24 default: false, the netns run covered it and the S24 run is owed by the operator.
    - A script replaced the hand check: false, that is the intended one-level-up.
    - The AC4 notes exist only as a file: false, the tag annotation publishes them.
    - The contract number: false, Epic 7 is additive, so it stays 1.
- **Rejected, low (14), each with its reason in the triage log:**
  - claimant_kind and events are not in the snapshot: the 7.x suites already pin them.
  - cancel is not exercised: it is outside the AC and the contract test pins it.
  - An id joins `live` before its take is confirmed: a safe superset, because releasing an unknown id exits 0.
  - No signal handler: the Leases expire in 2 to 3 min.
  - `--holds-on` is not validated: it fails at the status check before anything is taken.
  - Error codes are not pinned in the contract test: the error-codes test pins them.
  - The notes undersell breaking changes: they are listed under Operator-visible changes.
  - The notes test is brittle: it follows the existing pattern.
  - Duration formatting is fragile: every constant is a whole unit.
  - The `apiCaller` fallback and the README length: cosmetic.
  - Undo can miss B's ticket: it needs a failure in a millisecond window.
  - A Reservation is not counted in the free check: the S24 and the smoke phone have none.
  - Repeated flags or the `=` form: operator input, and the `=` form is a usage error.
  - The wait-b deadline: caught at the next iteration.

### Follow-up review

`followup_review_recommended: false`. Patched by verdict: high 0, medium 1, low 1. That is fewer than two medium patches and no high, so no follow-up is needed.

### Verification

- `heavy mise run check` passes on Node v24.15.0: 1438/1438.
- `heavy mise run --tool node@26 check` passes on Node v26.13.0: 1438/1438. Both runs were sequential.
- An earlier run that put both checks in parallel showed 3 failures in each suite. They were different emulator tests each time, and the failures went away when the runs were sequential. They come from sharing the emulator fakes and timing, not from this diff.
- Focused suites, each run alone: smoke 40/40, contract 14/14, v11 53/53, clock 6/6.
  - All four together exceed a 2 min tool timeout, because the gate tests in `tools/ci/v11.test.mjs` take about 6 s each (about 152 s in total). This is from the environment and predates this story.
- Live pre-merge smoke: this checkout's `server.mjs` and `hub-device` ran in their own network namespace (`sudo unshare -n`) with a temp `HUB_LOCK_DIR`, `HUB_EVENT_DIR` and `HOME`, isolated from the installed service on 8794. It ended `HUB_SMOKE_OK` with the holds line on the smoke phone and with `--holds-on s24`.

### Residual risks

- The real-S24 run (`hosts:smoke -- --holds-on s24` against the installed v1.2.56) has not been done yet. API/CLI parity is proven only in the sandbox and the hermetic tests until the operator runs it.
- The withdrawal of the CLI waiter is exercised only on the failure paths.
- The v11 gate tests are slow (about 6 s each) and can push focused runs past short timeouts.
- If `v1` moves or 1.2.56 is taken before the release, the notes section and its test need a new title first. The operator actions include that check.
