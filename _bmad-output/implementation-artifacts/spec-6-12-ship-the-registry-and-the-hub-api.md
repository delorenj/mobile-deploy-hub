---
title: 'Story 6.12: Ship the Registry and the Hub API (pre-release half)'
type: 'chore'
created: '2026-11-25'
status: done
operator_actions:
  - 'Merge this story branch into main and push main to origin (main is 22+ commits past origin/main 2f12f8a); the release refuses a main that is not origin/main.'
  - 'Before releasing, confirm `git ls-remote origin refs/tags/v1 refs/tags/v1.2.53` shows v1 on v1.2.52 and no v1.2.53 tag; if v1 moved or 1.2.53 is taken, retitle the `## v1.2.53` section of docs/hub-releases.md first.'
  - 'From a fresh clean clone of main on big-chungus, run `mise run release -- 1.2.53`; confirm every app strict dry run is green, v1 moved to v1.2.53, and `git show v1.2.53` carries the notes and a `Roll back:` line that names v1.2.52 and `systemctl --user disable --now mobile-deploy-hub-api.service` before the `hosts:install`.'
  - 'After the release runner confirms its runs are finished, run `mise run hosts:install` on big-chungus from a clean checkout at tag v1.2.53 (it installs the Hub API service and, through hub-mac, the Mac); confirm the HUB_API readback for v1.2.53, `systemctl --user status mobile-deploy-hub-api`, and the `HOST_KEY=linux` and `HOST_KEY=mac` readbacks.'
  - 'Then run `mise run hosts:smoke` on big-chungus and confirm it ends `HUB_SMOKE_OK v1.2.53 <id> leasable after <n> ms`; it leaves one retired smoke-<id> record in registry.json, which is expected.'
  - 'After the first real deploy on v1.2.53, confirm in the Event Log that it took `adb` or `mac-ios` as before, that its events carry `hub_version` `v1.2.53`, and that it never called the API; then confirm with the service stopped (`systemctl --user stop mobile-deploy-hub-api`) that `hub-device lease`, `status` and `registry list` still work and a registry write fails `HUB_API_DOWN`; start it again.'
  - 'DW-7: run the live emulator check owed from Story 6.11: lease an emulator, `systemctl --user restart mobile-deploy-hub-api`, and confirm the emulator and its adb server (in their own heavy scopes) are still running and the lease stands.'
  - 'If the release is red or anything regresses, run the `Roll back:` line from the v1.2.53 annotation: move v1 back to v1.2.52, run `systemctl --user disable --now mobile-deploy-hub-api.service` on big-chungus, then `mise run hosts:install` from a clean checkout at v1.2.52.'
baseline_revision: 'e081847c5a0ef8bce21f61534c827a69df466c91'
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-6-context.md'
warnings: ['oversized']
deferred:
  - summary: >-
      The release() call that feeds stopUnitsOf into rollbackLine (and so the stop into every tag annotation) is run by no test.
    evidence: |-
      release() has no seams (git, gh, mise run for real), as recorded at Story 5.10; unitsIn, stopUnitsOf and rollbackLine are tested directly, and the wiring at tools/release.mjs:153-154 was read at review. Dropping stopUnits from that call would pass the suite. Settled live by the operator action that reads `git show v1.2.53` for the systemctl stop, or by extracting a rollbackFor(major, previous, run) helper with a fake run.
    location: >-
      tools/release.mjs:153-154
    severity: medium
---

<intent-contract>

## Intent

**Problem:** Stories 6.1 to 6.11 are on local main (22 commits past `origin/main` `2f12f8a`; `v1` is on `v1.2.52`), but nothing ships them. `docs/hub-releases.md` has no `## v1.2.53` section, so the tag would not say that the deploy path ignores the Registry and the API (AD-25). The computed `Roll back:` line (Story 5.10) only says "move `v1` back and run `hosts:install` at the old tag". `v1.2.52`'s `hosts:install` knows no Hub API unit, so after a rollback the service would keep running from `releases/v1.2.53`. And the AC's live check (health, `registry list`, register a test phone, leasable within 60 s, retire removes it from `phone`) is a hand-typed sequence that every later release that touches the API would have to repeat (FR-1, FR-3, NFR-2).

**Approach (`belsky-doctrine`, one level up from "ship this release"):** every hub release that adds a service, and every post-install check of the Hub API. (1) `rollbackLine` names the `systemctl --user disable --now` of each `tools/hosts/units/*.service` that the release adds and the rollback target lacks, *before* the `hosts:install` of the target. (2) A new `mise run hosts:smoke` (`tools/hosts/smoke.mjs`) runs the AC's live check against the installed service and CLI in one command, cleans up what it registered, and prints `HUB_SMOKE_OK`. (3) Write the `## v1.2.53` notes and prove `mise run check` on Node 24 and Node 26. The release, `hosts:install` and the first real deploy are handed to the operator, because the release refuses a `main` that is not `origin/main` and the orchestrator merges this branch.

## Boundaries & Constraints

**Always:**
- Node 24 ESM, `node:` builtins only, hermetic tests (injected `run`, `cli`, `fetchImpl`, `now`, `sleep`). No `setInterval` and no self-rescheduling `setTimeout`. The smoke's 60 s wait is a bounded `for` loop with `pause.mjs` `sleep` (AD-19).
- `rollbackLine({major, previous, previousTag})` with no `stopUnits` (or an empty list) stays byte-identical to today's output. The unit list is `stopUnits = units(HEAD) − units(previous.commit)`, read with `git ls-tree --name-only <commit> tools/hosts/units/` (`.service` basenames, sorted). When the previous lookup fails, every `.service` at HEAD is listed: stopping first is always safe, because the target's own `hosts:install` re-enables and restarts any unit it does install. The stop is written before `hosts:install`.
- The smoke drives the operator's own surfaces: `GET /health` on `127.0.0.1:<policy.api.hub_api_port>` and the `hub-device` on PATH (`--hub-device <cmd>` overrides it). The one in-process read is a new read-only `claims.phoneWordMembers({env})`: the device words `take` would try for `phone`, after the retired narrowing, and `[]` when none are left.
- The smoke name is `smoke-<base36 of now()>` (a SLUG of at most 28 characters). The phone is registered with `--model 'hub smoke'`, no serial, `--holder hosts:smoke` and `--why 'hosts:smoke <ref>'`. Leases use `--no-connect --wait 0 --for 1m`. If any step fails after the register, the smoke releases any Lease it took and retires the Resource, and both are logged.
- The `## v1.2.53` section states that the deploy path ignores the Registry and the API (AD-25), that a stopped API only disables Registry writes (holds keep working), that deploy targets change only by hub release, that this release installs a service on big-chungus while the Mac gets only the `hub-device` and `host-key` changes, and that rolling back includes `systemctl --user disable --now mobile-deploy-hub-api.service`. It also lists the operator-visible changes, the intended test changes to pre-existing suites, and `mise run hosts:smoke`.

**Never:** run `mise run release`, `hosts:install`, a real deploy, or move or push a tag or main (the orchestrator merges). Never edit `lock.mjs`, the deploy path, `policy.json`, the routes, `AGENTS.md`/`CLAUDE.md` or `sprint-status.yaml`. Never run the smoke from `hosts:install` (it writes a permanent retired record, so it stays a separate, explicit command). Never handle `.plist` units (no Darwin service exists yet; the Host Agent is Epic 9).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Rollback, release adds a service | `stopUnits: ['mobile-deploy-hub-api.service']`, previousTag `v1.2.52` | `Roll back: move v1 back to v1.2.52 (...), then stop what this release added and v1.2.52 does not install (systemctl --user disable --now mobile-deploy-hub-api.service on big-chungus), then run mise run hosts:install on big-chungus from a clean checkout at v1.2.52 (...)` | — |
| Rollback, no new unit | `stopUnits: []` or omitted | today's line, byte for byte | — |
| `unitsIn` | ls-tree output with `install.sh`, `b.service`, `a.service` | `['a.service', 'b.service']` | a failed lookup → `null` |
| Smoke happy | health ok at ref; add → `HUB_DEVICE_REGISTERED res-smoke-x smoke-x`; lease exit 0 JSON; release 0; retire → `HUB_DEVICE_RETIRED res-smoke-x hidden`; re-lease exits 2 `HUB_RESOURCE_RETIRED` | `HUB_SMOKE_OK <ref> res-smoke-x leasable after <n> ms`; the members contained `smoke-x` before the retire and not after; the status phones listed it before and not after | — |
| Smoke slow registry | the first two lease tries exit 2 `unknown device`, the third exits 0 | leasable after the third try, within 60 s by the fake clock | — |
| Smoke never leasable | lease always exits 2 | `HUB_SMOKE_FAILED leasable: ...` after 60 s; the Resource is retired; the call rejects | no try starts after the deadline |
| Smoke API down / wrong ref | `/health` refused, or `hub_version` ≠ ref | `HUB_SMOKE_FAILED health: ...`; nothing registered (the `cli` log is empty) | rejects |
| Smoke add refused | add exits 1 `HUB_API_DOWN` | `HUB_SMOKE_FAILED register: ...`; no lease or retire attempted | rejects |

</intent-contract>

## Code Map

- `tools/release.mjs`:
  - `rollbackLine` (L71) gains the optional `stopUnits`. Add the exported pure `unitsIn(lsTreeOutput)`.
  - `release()` (L128-131) computes `stopUnits` from `git(['ls-tree', '--name-only', <commit>, 'tools/hosts/units/'], {allowFail: true})` for HEAD and for `previous.commit`, only when `previous` is set.
  - `hubRoot` (L25) is the cwd of every git call.
- `tools/ci/v11.test.mjs` L624 imports. L740-765 are the rollback tests (`tagMessage`, golden line). Add the `unitsIn` and `stopUnits` rows and a `## v1.2.53` section check beside the v1.2.52 one (search `v1.2.52` in that file).
- `tools/device/claims.mjs`:
  - `resolve` (L300) with `PHONE` returns `{members}`.
  - `withoutRetired` (L197) is private. It narrows those members and throws `HUB_RESOURCE_RETIRED` when none are left.
  - `loadFleet` (L160).
  - Export `phoneWordMembers({env})` next to them.
- `tools/device/hub-device.mjs` outputs, which the smoke parses:
  - registry add prints `HUB_DEVICE_REGISTERED <id> <name>` (L661), and retire prints `HUB_DEVICE_RETIRED <id> <visibility>` (L660).
  - `lease --json` prints `{lease_id, device, ...}` (L246).
  - `release <id>` exits 0.
  - `status --json` has `phones[].device`.
  - Retired → exit 2, and stderr starts `HUB_RESOURCE_RETIRED`.
- `tools/hosts.mjs`:
  - `releaseName(run)` (L37) is the default ref, the same one `hosts:install` uses.
  - Its `sh` helper (L32) is the shape for the default `cli`. `pause`/`sleep` come from `./ci/lib/pause.mjs`.
- `tools/hub-client.mjs` `hubUrl(policy)` builds the health URL. `tools/ci/lib/policy.mjs` `loadPolicy()`.
- `tools/hosts/hosts.test.mjs` is the hermetic pattern (fake `run`, fake `fetchImpl`, fake clock). Put the smoke tests in a new `tools/hosts/smoke.test.mjs`.
- `tools/clock.test.mjs` enforces the no-self-reschedule rule repo-wide.
- `mise.toml` L159 `hosts:install`. Add `hosts:smoke` after it (`tools = { node = "24" }`, `run = "node tools/hosts/smoke.mjs"`).
- `README.md`:
  - L136 (release paragraph, `Roll back:` line) gets the service stop.
  - L323/L326 (hosts:install and Hub API paragraphs) get `mise run hosts:smoke`.
- `docs/hub-releases.md`: add `## v1.2.53` above `## v1.2.52`.
- Pre-existing suites edited since `v1.2.52` (for the notes; `git diff v1.2.52 HEAD`):
  - `tools/ci/reservation.test.mjs`: a set-aside unreadable Reservation is now one `prune` event before the `claim` (6.1).
  - `tools/device/emulator.test.mjs`: a fake `heavy` goes first on PATH, plus one seam test (6.11).
  - `tools/device/hub-device.test.mjs`: one added test, "lease, status and release work with the Hub API down" (6.8).
  - `tools/hostkey.test.mjs`: the `hostsInstall` tests answer the Hub API `/health` and pass `home` (6.11).
  - `tools/ci/test-fixtures.mjs`: `heavyShim`, and `hermetic()` prepends it.
  - `claims`, `lease-match` and `policy` gained cases.

## Tasks & Acceptance

**Execution:**
- [ ] `tools/release.mjs` -- `unitsIn`, `rollbackLine` `stopUnits`, wiring in `release()`, header comment -- every release that adds a service rolls back cleanly
- [ ] `tools/device/claims.mjs` -- export read-only `phoneWordMembers({env})` -- the `phone` word as `take` sees it
- [ ] `tools/hosts/smoke.mjs` (new, executable entry) -- `hubSmoke({ref, cli, fetchImpl, now, sleep, log, policy, members, name})`. It runs the steps health → list → register → leasable (bounded at 60 s) → release → retire → gone, with cleanup on failure. On the CLI it prints `HUB_SMOKE <step>: ...` lines and ends with `HUB_SMOKE_OK` (exit 0) or `HUB_SMOKE_FAILED` (exit 1). It takes `--hub-device <cmd>` and `--ref <ref>`.
- [ ] `tools/hosts/smoke.test.mjs` (new, hermetic) -- the smoke matrix rows. Add a source check that `hosts.mjs` never imports or calls the smoke.
- [ ] `tools/ci/v11.test.mjs` -- rows for `unitsIn` and `rollbackLine` with `stopUnits`, and the `v1.2.53` section check
- [ ] `docs/hub-releases.md` -- the `## v1.2.53` section
- [ ] `mise.toml`, `README.md` -- the `hosts:smoke` task, and the rollback-stop wording
- [ ] verification -- `heavy mise run check` and `heavy mise run --tool node@26 check`. Run a live pre-merge smoke: start this checkout's `server.mjs` on the policy port with a temp `HUB_LOCK_DIR`/`HUB_EVENT_DIR` (8794 is free: the service is not installed), then run `node tools/hosts/smoke.mjs --hub-device 'node tools/device/hub-device.mjs' --ref <its hub_version>` against it. Run an old-pin probe: `v1.2.52`'s `hub-device status`/`lease s24 --no-connect` against a lock dir HEAD wrote (`registry.json`, `registry-*` events).

**Acceptance Criteria:**
- Given HEAD, when `mise run check` runs on Node 24 and on Node 26, then both are green.
- Given `docs/hub-releases.md`, when `releaseNotes(text, 'v1.2.53')` reads it, then the section states AD-25 (the deploy path ignores the Registry and the API), that a stopped API only disables Registry writes, that deploy targets change only by hub release, the Mac's scope, the service stop in the rollback, and `hosts:smoke`.
- Given a release whose `v1` pointed at a commit without `mobile-deploy-hub-api.service`, when it tags, then every annotation's `Roll back:` line stops that unit before the `hosts:install` of the old tag.
- Given an installed Hub API and `hub-device`, when `mise run hosts:smoke` runs, then it ends `HUB_SMOKE_OK` only when health answers at the ref and the registered test phone is leasable by name within 60 s and in `phone`, then gone from `phone` and from status after the retire.
- Given the operator-owed half (release, `hosts:install`, smoke, first deploy, DW-7's live emulator check), when this story finishes, then the spec is `awaiting-operator` with each listed under `operator_actions`.

## Spec Change Log

## Review Triage Log

### 2026-11-25 — Review pass
- verdicts: 36 findings — high 0, medium 1, low 26, false 9, maybe-false 0 (patch 7, defer 1, reject 28)
- findings:
  - `low` `patch` (blind) README says the Mac's Host Agent is "Epic 7"; the notes and epics-v1b.md say Epic 9. — README sentence corrected to Epic 9.
  - `low` `reject` (blind) No SIGINT/SIGTERM cleanup, so a killed smoke leaves the test phone live in `phone`. — The phone has no serial, so `phone` and `--match` skip it unless `--no-connect` is given (README "phone" paragraph); its lease is 1 m. Signal handlers add branches for an operator interrupting a 1-second command.
  - `low` `reject` (blind) Non-retryable lease errors are retried for the full 60 s. — The failure is still reported with the last error's code; it is only slower. Classifying transient vs hard errors adds branches.
  - `low` `reject` (blind) An operator shell with `HUB_LOCK_DIR` exported reads one lock dir while the API writes another. — No operator or agent workflow here exports `HUB_LOCK_DIR` on big-chungus; a guard adds a branch for an unreached state.
  - `low` `reject` (blind) The smoke never calls `GET /resources`, `/pools` or `/discovery`. — The AC names `/health`, `registry list`, register, lease and retire, which is what the smoke runs; the routes have their own suites (`tools/hub-api/*.test.mjs`).
  - `low` `patch` (blind) `/health` with `ok: false` or no `registry` passes. — Now requires `ok === true` and `registry === 'ok'` (the real route always sends both, `routes.mjs:80-89`); two test rows added.
  - `low` `patch` (blind) `hubDeviceCli` and the argv block are untested. — Grouped with the verification-gap row below; tests added.
  - `low` `reject` (blind) The rollback stop covers only `.service`. — No `.timer`/`.socket`/`.path` unit can ship: recurring work is a Candybar and `hosts.test.mjs` forbids a `.timer` in `tools/hosts/units/`; `.plist` is Epic 9 by the spec.
  - `low` `reject` (blind) The fallback when the target's ls-tree fails is not logged. — The fallback is the safe superset, and the full line is logged as `RELEASE_ROLLBACK`; a separate note adds a branch.
  - `low` `patch` (blind) The real-git test asserts an exact unit list and returns silently when `v1.2.52` is absent. — Now asserts `includes` and calls `t.skip(...)`.
  - `low` `reject` (blind) Loose assertions in a few smoke tests (`.catch(() => {})`, `leasable || gone`, unused param, source-text check). — Cosmetic; each test still fails on the regression it names.
  - `low` `reject` (edge) A `registry add` that applied but answered `HUB_API_UNKNOWN` gets no cleanup. — Needs the API to stop answering mid-write on a loopback call; the smoke then fails `register` with the UNKNOWN text, which tells the operator to `registry list`. Recovery adds a branch.
  - `low` `reject` (edge) A taken lease with unparseable output, or killed by the 90 s timeout, is orphaned. — The lease is `--for 1m` and expires; hub-device prints one JSON line on success (`hub-device.mjs:246`).
  - `low` `reject` (edge) A try that starts just before the deadline can end after 60 s, so OK prints with more than 60000 ms. — Each try is a local CLI call (35 ms live); the reported `leasable after <n> ms` shows the real figure. A post-check is a guard for an unreached state.
  - `low` `reject` (edge) Hard lease failures are retried. — Same as the blind retry row.
  - `low` `patch` (edge) A warning line on stderr before `HUB_RESOURCE_RETIRED` fails the `gone` step. — Now `/^HUB_RESOURCE_RETIRED\b/m`; test row added.
  - `low` `reject` (edge) No signal handling. — Same as the blind signal row.
  - `low` `reject` (edge) An empty or space-containing `--hub-device`. — The empty one fails loudly as `HUB_SMOKE_FAILED`; the installed wrapper is `~/.local/bin/hub-device`, with no space.
  - `low` `patch` (edge) A missing `registry` field passes health. — Grouped with the blind health row.
  - `false` `reject` (edge) `phoneWordMembers` skips the host and cap narrowing that `take` applies. — The fleet is already `linux` phones only (`phonesOf`), and the cap narrowing drops only deploy targets over their cap; a registered smoke phone is neither, so the check matches what `lease phone` would offer it.
  - `low` `reject` (edge) Non-`.service` units are not stopped. — Same as the blind `.service` row.
  - `low` `reject` (edge) A same-name unit at both commits keeps a newer ExecStart if the old installer does not restart it. — The only unit is the Hub API, which `installHubApi` re-renders and restarts at any target that has it (`hosts.mjs:91-99`).
  - `low` `reject` (edge, claim) The notes say a failure "after the register" cleans up, but a refused or ambiguous add, a kill or an unparseable lease reply do not. — A refused add registered nothing; the other cases are the rejected rows above.
  - `false` `reject` (edge, claim) "Within 60 s" is not bounded for a try already running. — Same as the deadline row: no try starts after the deadline, and the elapsed time is printed.
  - `medium` `defer` (verification-gap) The `release()` call that feeds `stopUnitsOf` into `rollbackLine` is run by no test. — `release()` has had no seams since before this story (the same gap was recorded at 5.10); the helpers are tested, the wiring was read at review (`release.mjs:153-154`), and an operator action checks `git show v1.2.53` for the stop. Deferred in frontmatter.
  - `low` `patch` (verification-gap) `hubDeviceCli` and the CLI entry block are untested. — Added a stub-script test (argv pass-through after the command's own words, exit code, stdout/stderr, 127) and a `smoke.mjs --bogus` spawn test (exit 1, `HUB_SMOKE_FAILED`, no hub-device call).
  - `low` `reject` (verification-gap, other) The fake hub-device's outputs are not tied to the real command. — The reviewer checked each shape against the real code and found it matching; `registered-phone.test.mjs` runs the real outputs, and the live pre-merge smoke ran the real CLI.
  - `low` `reject` (verification-gap, other) The "never runs the smoke" test is a source-text check. — That is its purpose: it guards the wiring in `hosts.mjs`.
  - `low` `reject` (verification-gap, other) `leasable || gone` is a weak assertion. — Same as the blind loose-assertions row.
  - `false` `reject` (intent) The live smoke has not run against an installed service. — Installing the service is the release's operator action; the smoke ran live against this checkout's server (Verification) and is listed under `operator_actions` for the installed one.
  - `false` `reject` (intent) AC 1's green check is not visible in the diff. — Run in this session after the patches: 1246/1246 on Node 24 and on Node 26.13.0.
  - `false` `reject` (intent) The diff goes beyond the literal AC (rollback stop, smoke, `phoneWordMembers`). — Intended: the belsky-doctrine level one up, named in the spec's Approach.
  - `false` `reject` (intent) The notes are published only when the tag is cut. — Correct and intended; that publication is the operator's release.
  - `false` `reject` (intent) The first real deploy has no code surface. — It is an operator action by the invocation's design.
  - `false` `reject` (intent) The frontmatter read `in-review` while the result said `awaiting-operator`. — The snapshot was mid-review; finalization sets both to `awaiting-operator`.
  - `false` `reject` (intent) `sprint-status.yaml` untouched. — A compliance observation, not a defect.

## Design Notes

Why stop *before* `hosts:install`: `installHubApi` at a target that has the unit runs `enable` and `restart`, which undoes the stop. A target without the unit never touches it. So the order "stop, then install the target" is right in both cases. That is also why a failed unit lookup can safely list every HEAD unit.

Why the smoke is not part of `hosts:install`: names and ids are never reused (AD-28), so each run leaves one retired record in `registry.json`. That cost is fine when someone asks for the check, and not on every install.

## Verification

**Commands:**
- `node --test tools/hosts/smoke.test.mjs tools/ci/v11.test.mjs tools/clock.test.mjs tools/deploy-path.test.mjs` -- expected: all pass
- `heavy mise run check` and `heavy mise run --tool node@26 check` -- expected: green

## Auto Run Result

Status: awaiting-operator

**Summary.** The pre-release half of Story 6.12 is done and reviewed. Still owed (see `operator_actions`): the release, `hosts:install`, the smoke against the installed service, the first real deploy, and DW-7's live emulator check. The release refuses a `main` that is not `origin/main`, and Epic 6 stays on local main until the orchestrator merges this story and pushes.
- **What the asker gets (`belsky-doctrine`):** Epic 6 is ready to ship as v1.2.53. `docs/hub-releases.md` has its section, which covers:
  - AD-25: a stopped API only disables Registry writes, and deploy targets change only by hub release.
  - The service runs on big-chungus; the Mac gets only `hub-device`/`host-key`.
  - The rollback stop.
  - What changed for operators, what changed in the tests, and `hosts:smoke`.
- **What the level gets (every hub release that adds a service, and every post-install check of the Hub API):**
  - The `Roll back:` line now stops each `tools/hosts/units/*.service` that the release adds and the rollback target lacks (`unitsIn`, `stopUnitsOf`, `rollbackLine` `stopUnits`).
  - `mise run hosts:smoke` runs the live check in one command: health, list, register, leasable within 60 s, phone word, release, retire, gone. It cleans up after itself and uses the read-only `claims.phoneWordMembers`.

**Files changed**
- `tools/release.mjs`, `tools/ci/v11.test.mjs`: `unitsIn`, `stopUnitsOf`, `rollbackLine` `stopUnits`, the wiring in `release()`, their tests, and the `v1.2.53` notes check.
- `tools/device/claims.mjs`: `phoneWordMembers({env})`.
- `tools/hosts/smoke.mjs` and `tools/hosts/smoke.test.mjs` (new), `mise.toml` (`hosts:smoke`).
- `docs/hub-releases.md` (`## v1.2.53`), `README.md`.

**Review.** One pass, 36 findings: 0 high, 1 medium, 26 low, 9 false.
- 7 patched, all low (commit `41c1008`):
  - The health check is now strict: it requires `ok === true` and `registry === 'ok'`.
  - The retirement refusal is matched per line, so a warning on stderr before it no longer fails the step.
  - New tests cover `hubDeviceCli` and the CLI entry.
  - The real-git test asserts `includes` and skips (rather than passing) when `v1.2.52` is not fetched.
  - The README says Epic 9 (not 7) for the Mac's Host Agent.
- 1 deferred, medium: no test runs the `release()` wiring (see frontmatter `deferred`).
- 28 rejected.
- `followup_review_recommended: false`: every patch was low and local, and each one was re-verified.

**Verification**
- After the patches, `heavy mise run check` passed on Node 24 and on Node 26.13.0: 1246/1246 each, actionlint clean.
- The focused suites pass 80/80.
- A live pre-merge smoke ended `HUB_SMOKE_OK v1.2.53-presmoke res-smoke-mwwajj6r leasable after 35 ms`. It ran this checkout's `server.mjs` on 8794, with a temp `HUB_LOCK_DIR`/`HUB_EVENT_DIR`/`HOME`. A wrong `--ref` ended `HUB_SMOKE_FAILED health`.
- Old-pin probe: the `v1.2.52` `hub-device` ran `status --json`, `lease s24 --no-connect` and `release` against the lock dir HEAD wrote. A phone registered by HEAD is an unknown device to it.

**Residual risks**
- Only the live operator action (`git show v1.2.53`) checks the `release()` wiring.
- Each `hosts:smoke` run leaves one retired `smoke-<id>` record, because names are never reused (AD-28).
- DW-7 and every operator step are still unrun.

## Operator Confirmation

Confirmed 2026-11-25: the external actions this story owed were carried out.

- Merge this story branch into main and push main to origin (main is 22+ commits past origin/main 2f12f8a); the release refuses a main that is not origin/main.
- Before releasing, confirm `git ls-remote origin refs/tags/v1 refs/tags/v1.2.53` shows v1 on v1.2.52 and no v1.2.53 tag; if v1 moved or 1.2.53 is taken, retitle the `## v1.2.53` section of docs/hub-releases.md first.
- From a fresh clean clone of main on big-chungus, run `mise run release -- 1.2.53`; confirm every app strict dry run is green, v1 moved to v1.2.53, and `git show v1.2.53` carries the notes and a `Roll back:` line that names v1.2.52 and `systemctl --user disable --now mobile-deploy-hub-api.service` before the `hosts:install`.
- After the release runner confirms its runs are finished, run `mise run hosts:install` on big-chungus from a clean checkout at tag v1.2.53 (it installs the Hub API service and, through hub-mac, the Mac); confirm the HUB_API readback for v1.2.53, `systemctl --user status mobile-deploy-hub-api`, and the `HOST_KEY=linux` and `HOST_KEY=mac` readbacks.
- Then run `mise run hosts:smoke` on big-chungus and confirm it ends `HUB_SMOKE_OK v1.2.53 <id> leasable after <n> ms`; it leaves one retired smoke-<id> record in registry.json, which is expected.
- After the first real deploy on v1.2.53, confirm in the Event Log that it took `adb` or `mac-ios` as before, that its events carry `hub_version` `v1.2.53`, and that it never called the API; then confirm with the service stopped (`systemctl --user stop mobile-deploy-hub-api`) that `hub-device lease`, `status` and `registry list` still work and a registry write fails `HUB_API_DOWN`; start it again.
- DW-7: run the live emulator check owed from Story 6.11: lease an emulator, `systemctl --user restart mobile-deploy-hub-api`, and confirm the emulator and its adb server (in their own heavy scopes) are still running and the lease stands.
- If the release is red or anything regresses, run the `Roll back:` line from the v1.2.53 annotation: move v1 back to v1.2.52, run `systemctl --user disable --now mobile-deploy-hub-api.service` on big-chungus, then `mise run hosts:install` from a clean checkout at v1.2.52.

_Appended by the bmad-loop orchestrator (`bmad-loop confirm`, #335): a human confirmed these external actions out of band, and the story was advanced from `awaiting-operator` to `done`._
