---
title: 'Story 7.6: Force-release a Lease'
type: 'feature'
created: '2026-11-25'
status: 'done'
baseline_revision: '8b0f96a636718af5674b8a779e831830f97cb632'
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-7-context.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-7-5-cancel-a-queued-request.md'
  - '{project-root}/docs/hub-api-contract.md'
warnings: ['oversized']
deferred:
  - summary: >-
      A force-released forgotten Lease's held_ms (up to its 48 h expiry) counts as a past Lease hold in the enqueue ETA, which can widen later waiters' ETAs.
    evidence: |-
      eta.mjs ENDS already includes force-release (tools/ci/lib/eta.mjs:8, :22; README "The enqueue ETA"), a design that predates Story 7.6; this story is the first writer of lease force-release events, so the data now reaches it. Whether abandoned holds should count is an ETA design decision (the hold did block waiters that long), not a force-release defect.
    location: >-
      tools/ci/lib/eta.mjs:22
    severity: low
---

<intent-contract>

## Intent

**Problem:** A forgotten or stuck Lease (an agent that died, a person who walked away) holds its phone until `expires_at`, up to 48 h, and starves every deploy and waiter behind it. Nothing outside the holder can end it, and nothing says plainly that a deploy job's Hold must never be ended from outside its run.

**Approach:** One protocol writer `forceRelease(name, {actor, why})` in `lock.mjs` renames the Lease's owner to a tomb through the existing `retire()` (the rename decides) and writes one `force-release` event; it refuses a `job`/`hub-job` owner with `HUB_FORCE_RELEASE_JOB` carrying `{repo, run, job}`. One Claims call `forceReleaseLease(id, input, ctx)` finds the Lease by id on this host and serves both `hub-device force-release <id> --why` and `POST /leases/{id}/force-release` (belsky-doctrine: one level up from "free my stuck S24" is "force-release any Lease on any lock of this host from every front door", phones, registered phones and the iOS lane alike; the Host Agent will call the same function).

## Boundaries & Constraints

**Always:**
- `lock.mjs` is the only writer of the lock dir and lock-level events (AD-1); `claims.mjs` owns locating, rules, codes and the exit/HTTP tables (AD-24); `routes.mjs` only checks the body, defaults the actor and calls Claims; `hub-device.mjs` only parses and prints.
- An actor (`{holder, via}`) and a non-empty `why` are required and recorded on the event; there is no holder check and no confirmation step (NFR-6; confirmation is the page's, v1c).
- The `force-release` event carries `hold_kind: 'lease'`, `lease_id`, `claimant` of the released Lease, `held_ms`, `actor`, `why`, `reason: null` (via `eventOf` through `retire(…, {as: 'force-release'})`).
- The rename decides: if the owner changed between the read and the rename (reclaimed, released, re-taken), nothing of the force-release is written and the new owner is untouched (put back by `retire`).
- Node 24 ESM `.mjs`, no deps, no `setTimeout`/`setInterval` in new non-test code; tests hermetic (`hermetic()`, scratch lock/event dirs, fake seams). `git diff main -- tools/ci/lib/eta.mjs` stays empty.

**Never:**
- Never force-release a Job Hold (`job`, `hub-job`, or a pre-v1a owner with no `kind`): refuse before anything is written.
- Never force-release an emulator slot or the `emulator` gate here: that is Story 7.8's `forceReleaseEmulator` (teardown under the reaper lock). Refuse with `HUB_USAGE` `reason: emulator`.
- Never touch a waiter's ticket (a waiting id is `HUB_LEASE_NOT_FOUND` `waiting`: cancel it instead) or a Reservation (Story 7.7).
- Never write `_bmad-output/implementation-artifacts/sprint-status.yaml`. No second lock or store; no search of other hosts.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Happy path | `s24` leased by `agent-a` as `a-1`; `POST /leases/a-1/force-release {why:'stuck', holder:'ops'}` | 200 `ForceRelease` `{lease_id:'a-1', outcome:'force-released', resource:<s24 Resource>, lock:'s24', device:'s24', holder:'agent-a', why:'stuck'}`; lock gone; one `force-release` event with `actor:{holder:'ops',via:'api'}`, `why`, `lease_id:'a-1'`, `hold_kind:'lease'` | — |
| Next waiter | B waits on `s24` (real `acquireLease` wait) | after the force-release B acquires `s24` normally (its `acquire` event follows the `force-release`) | — |
| Empty why | body `why:''` / missing / CLI no `--why` | 400 `HUB_USAGE` `bad-why` / `no-why`; CLI exit 2; nothing written | lock.mjs `forceRelease` with empty why throws `HUB_USAGE` |
| Job id | `POST /leases/job:o%2Fr%2341.1%2Fandroid/force-release` | 409 `HUB_FORCE_RELEASE_JOB` exit 2, problem+json members `repo:'o/r'`, `run:'41'`, `job:'android'`; detail has `gh run cancel 41 --repo o/r`; CLI stderr `HUB_FORCE_RELEASE_JOB … gh run cancel …`, exit 2 | local / catch-up job: `repo`/`run` null, detail says stop the process |
| Job owner (lock.mjs) | `forceRelease('adb', …)` on a deploy-job or hub-job owner | throws `HUB_FORCE_RELEASE_JOB` with `{repo, run, job}`; owner byte-identical; no event | — |
| Unknown / waiting id | no Lease holds the id / id only waits | 404 `HUB_LEASE_NOT_FOUND` `unknown` / `waiting`; CLI exit 2 | — |
| Emulator lease id | id holds `emulator-1` or the gate, or has an emulator record | 400 `HUB_USAGE` `reason: emulator`, detail points to `force-release emulator-<n>` (Story 7.8) | nothing written |
| Race | owner replaced (another Lease) or removed between read and rename (`beforeRetire` seam) | no `force-release` event; the new owner stays; Claims answers 409 `HUB_LEASE_LOST` `changed-hands` | lock-level result `{released:false, reason:'changed'}` |
| Bad body | unknown key, bad actor, neither actor nor holder | 400 `HUB_USAGE` `bad-body` / `bad-actor` / `no-holder` | — |

</intent-contract>

## Code Map

- `tools/ci/lib/lock.mjs` -- `retire` l.289 (rename to tomb, put-back on mismatch, writes `as` event with `held_ms`; `beforeRetire` seam), `eventOf` l.160, `checkActor` l.195, `failure` l.475, `readOwner` l.94, `isLease` l.101, `lockPath` l.473, `leaseName` l.471, `releaseLease` l.1793 (model for result shape `{released, reason, owner}`), `cancelRequest` l.1850 (model for actor/why checks), `jobLeaseId` l.648, `listLocks` l.2087 (read-only scan of `*.lock` with owners), `LEASE_ENDS` l.2020 already includes `force-release`.
- `tools/device/claims.mjs` -- `EXIT_CODES` l.51 / `HTTP_ANSWERS` l.102 (add `HUB_FORCE_RELEASE_JOB` 409, exit 2); `jobTicket` l.962 (job-id regex and `gh run cancel` hint — reuse its parse); `usage` l.129; `serviceHold` l.1144 (strips `GITHUB_*`, but it throws `HUB_DEVICE_JOB_ID` for `job:` ids — check the job id before calling it, or build the context without it); `leaseNotFound` l.781; `nameOf` l.208; `bodyActor` l.1098, `checkReleaseBody` l.1134 (model for `checkForceReleaseBody`); `releaseAnswer` l.1189 (model); imports of `GATE`, `isEmulatorLock`, `isEmulatorLease` from `emulator.mjs` l.34.
- `tools/hub-api/routes.mjs` -- `PROBLEM_EXTENSIONS` l.52 (add `HUB_FORCE_RELEASE_JOB: ['repo','run','job']`; `problem()` copies members from the error), `releaseLeaseRoute` l.299 (pattern), `serviceContext` l.265, `ROUTES` l.314.
- `tools/device/hub-device.mjs` -- header comment l.25–66, `USAGE` l.123, `report` l.170 (coded-error list l.185), `cliActor` l.329, `cancel` l.355 (model), `FLAG_OWNERS` l.714, command switch l.765.
- `docs/hub-api-contract.md` -- route table l.24–37, `### Release` l.160 (model for `### ForceRelease`), Problem extensions table l.207, request bodies l.282 (release model), error codes l.300.
- `tools/hub-api/contract.test.mjs` -- `POST_SAMPLES` l.116 (add `/leases/{id}/force-release` with `setup: ['/leases']`), Problem-extensions test l.267 requires one live answer per extension code (add `HUB_FORCE_RELEASE_JOB` via a `job:` id).
- `tools/hub-api/extend-release.test.mjs` / `tools/hub-api/cancel.test.mjs` -- `scratch()` with `api`, `take`, `cli`, `events`, `wait`: model for `force-release.test.mjs`.
- `tools/ci/cancel-request.test.mjs` -- model for the lock-level unit test file.
- `README.md` -- l.280 the Story 7.5 cancel paragraph: add a force-release paragraph after it.

## Tasks & Acceptance

**Execution:**
- `tools/ci/lib/lock.mjs` -- export `forceReleaseJobError({kind, repo, run, job, pid})` (code `HUB_FORCE_RELEASE_JOB`, members `repo`, `run`, `job`; message names `gh run cancel <run> --repo <repo>` when both are known, else says stop the local process / the catch-up) and `forceRelease(name, {actor, why, lease_id = null, env, now, hostId, log, beforeRetire})`: TypeError without an actor; `HUB_USAGE` for an empty/non-string `why`; `{released:false, reason:'none'|'unknown-holder'}` for no owner; job owner → throw `forceReleaseJobError`; `lease_id` given and different → `{released:false, reason:'other-lease', owner}`; else `retire(…, {as:'force-release', fields:{actor, why}})` → `{released:true, owner}` or `{released:false, reason:'changed'}` -- single protocol writer.
- `tools/ci/force-release.test.mjs` -- new: one event with exact fields; next real waiter acquires; empty why; job and hub-job owners refused with owner byte-identical and no event; race via `beforeRetire` (owner replaced → put back, no event; lock removed → no event); `other-lease`.
- `tools/device/claims.mjs` -- `HUB_FORCE_RELEASE_JOB` in both tables; `checkForceReleaseBody(body)` (keys `why`, `holder`, `actor`; `no-why`, `bad-why`, `bad-body`, `bad-actor`, `no-holder`); `forceReleaseLease(id, input, ctx)` shared by CLI and API: actor/why checks, `job:` id → `forceReleaseJobError` from the parsed id (`local` repo / `local-<pid>` run → null), emulator refusal, locate via `listLocks` (lease owner whose `lease_id === id`), else `leaseNotFound`; map lock results to the `ForceRelease` answer or `HUB_LEASE_LOST` (`changed-hands`, `being-taken`) -- one rule owner.
- `tools/hub-api/routes.mjs` -- `POST /leases/{id}/force-release`, shape `ForceRelease`, actor default `{holder, via:'api'}`; `PROBLEM_EXTENSIONS.HUB_FORCE_RELEASE_JOB` -- thin route.
- `tools/device/hub-device.mjs` -- `force-release <id> --why <text> [--holder WHO] [--json]`; `--why` required (usage exit 2); prints `HUB_DEVICE_FORCE_RELEASED <device|lock> <id> holder=<holder>` or JSON `ForceRelease`; `report` prints `HUB_FORCE_RELEASE_JOB <detail>` and exits 2; header/USAGE updated -- CLI front door.
- `docs/hub-api-contract.md` -- route row (7.6), `### ForceRelease`, Problem extensions row, request body section, error-code row; `HUB_USAGE`/`HUB_LEASE_NOT_FOUND`/`HUB_LEASE_LOST` rows mention force-release -- the contract test parses it.
- `tools/hub-api/contract.test.mjs` -- POST sample and a live `HUB_FORCE_RELEASE_JOB` answer in the extensions test.
- `tools/hub-api/force-release.test.mjs` -- new: every matrix row through the API and the CLI, CLI/API parity (answers and events equal ignoring `ts` and `actor.via`), and `hub-device status --json` no longer listing the forced Lease while `readEvents` and `leaseHoldersSince` show it ended by `force-release`.
- `tools/device/claims.test.mjs`, `tools/hub-api/leases.test.mjs` -- extend any export/table pins that enumerate exports or codes.
- `README.md` -- document `hub-device force-release` and `POST /leases/<id>/force-release`, the actor/why rule, the Job refusal and the emulator pointer.

**Acceptance Criteria:**
- Given a Lease on `s24` held by `agent-a`, when `forceRelease('s24', {actor, why})` runs, then the lock is renamed to a tomb, exactly one `force-release` event with `actor`, `why`, `lease_id` and `hold_kind: lease` is written, and a waiter already in line acquires `s24` next.
- Given a `job` or `hub-job` owner, when it is force-released through the CLI or the API, then the answer is `HUB_FORCE_RELEASE_JOB` (409, exit 2) with `repo`, `run`, `job` in the problem+json, and the CLI prints the `gh run cancel` hint.
- Given the same Lease setup run twice (once via `hub-device force-release <id> --why`, once via the API), when answers and event logs are compared ignoring `ts` and `actor.via`, then they are equal, and the CLI line names the id and the released holder.
- Given a lock reclaimed between read and rename, when the force-release runs, then only the owner it read could be affected and the loser records nothing.
- Given `hub-device status --json` after a force-release, when it runs, then the Lease is not listed, and the Event Log (what `history` reads, Epic 10) carries the `force-release` event.
- Given `mise run check`, when it runs, then actionlint and all tests pass, including the contract test with the new route.

## Spec Change Log

## Review Triage Log

### 2026-11-25 — Review pass
- verdicts: 20 findings — high 0, medium 0, low 14, false 6, maybe-false 0
- findings:
  - `[low]` `[patch]` (blind) `JOB_ID` was inserted between `jobTicket`'s comment block and the function, so the comment documented the regex — moved `JOB_ID` above the block with its own one-line comment (80259da).
  - `[low]` `[reject]` (blind) a malformed `job:` id (`job:garbage`) gets "stop the local process instead" with null members — nobody types an unparseable job id in everyday use (job ids are minted by `jobLeaseId`), and a neutral message needs a new branch in the shared `forceReleaseJobError`.
  - `[low]` `[patch]` (blind) README and contract said "a lock held by a job" is 409 `HUB_FORCE_RELEASE_JOB`, but a lock name is no Lease id (404 `unknown`, as the test asserts); the lock-level refusal is reached only by a Job Hold taking the Lease's lock between the find and the rename — both sentences corrected (80259da).
  - `[low]` `[reject]` (blind) a Lease held on another host's lock answers 404 `unknown` with no `HUB_WRONG_HOST` — the intent searches this host only; the Mac serves no Hub API until the Host Agent (Epic 9), and the fix adds a body key and a host check.
  - `[low]` `[reject]` (blind) `why` is not trimmed or length-bounded — the same as every other `why` (lease, cancel); the service caps the body at 1 MiB and `appendEvent`'s `fit` bounds the stored line at 4 KiB; a bound adds guards for no everyday case.
  - `[false]` `[reject]` (blind) refused attempts leave no audit trail — writing nothing on a refusal is the specified behaviour (matrix rows "nothing written"), the same as cancel and release refusals.
  - `[low]` `[reject]` (blind) test gaps: non-zero `held_ms`, an expired-but-unreclaimed Lease, a double force-release, `being-taken` through Claims, a Pool-taken Lease — `heldMs` and `retire`'s rename-decides are shared and covered by the release/reclaim suites, a Pool-taken Lease is an ordinary lease owner on its lock, and `being-taken` needs a new seam (see the verification-gap row).
  - `[false]` `[reject]` (blind) `device` for a registered phone is undocumented — the contract states the rule (the Claimant's word for a fleet phone, `null` for a lock that is no phone of the fleet), the same `nameOf` the Release answer uses.
  - `[false]` `[reject]` (blind) "the Host Agent's too" comment with no Host Agent route — that is the file-wide convention for the Epic 9 caller (claims.mjs l.799, 879, 1165, 1181 say the same); features.md needs no event-type list change.
  - `[false]` `[reject]` (blind) `forceReleaseLease` rejects a missing actor with an untagged usage — no front door reaches it: the route defaults the actor after the `no-holder` check and the CLI always builds one with `cliActor`.
  - `[low]` `[patch]` (edge) same root cause as the doc row above: a job-held lock is not addressable by Lease id, so the documented "lock whose holder is a Job Hold" refusal was misleading — fixed by the same doc correction.
  - `[low]` `[reject]` (edge) malformed `job:` id guidance — same as the blind row above.
  - `[low]` `[reject]` (edge) a `why` over 4 KiB is echoed in full but truncated in the event — same root cause as the unbounded-`why` row; pre-existing for every `why` in the hub.
  - `[low]` `[defer]` (edge) a force-released forgotten Lease's long `held_ms` feeds the ETA percentiles — `eta.mjs` counting `force-release` predates this story (eta.mjs:8, :22); deferred as an ETA design question.
  - `[low]` `[reject]` (edge) `forceRelease` on a non-Queued lock writes no event (AD-4 `note`) — every Lease a front door takes is on a Queued name (phones, `mac-ios`, emulator, `res-*` registry locks); only a direct lock-layer call on another name reaches it, matching `releaseLease`.
  - `[low]` `[reject]` (verification-gap) the `unknown-holder` → `being-taken` mapping in `forceReleaseLease` is never exercised — the window is between `listLocks` and the owner read inside `forceRelease`, which no seam reaches; adding one is new surface for a two-way ternary checked by reading.
  - `[low]` `[patch]` (verification-gap) the emulator-record branch of the emulator refusal was untested — added a case with `emulators/e-3.json` (slot `emulator-2`, no lock held): 400 `HUB_USAGE` `emulator`, detail names `force-release emulator-2`, no event (80259da).
  - `[false]` `[reject]` (verification-gap, other) the waiter race tests may flake if `request` is noted after the ticket appears — `acquireLease` writes the ticket and notes `request` in one synchronous run before its first await (lock.mjs:1673-1683), so the test's poll sees both.
  - `[low]` `[patch]` (intent) the epic AC puts the Job Hold refusal at the CLI/API surface while the docs implied a lock name reaches it — same root cause as the doc row; through the front doors a Job Hold is addressed by its `job:` id, which is 409 with `repo`/`run`/`job` (tested); docs corrected.
  - `[false]` `[reject]` (intent) "history carries the event" is checked only via `readEvents`/`leaseHoldersSince` — `history` (`GET /history`) is Epic 10 and does not exist; the Event Log is what it will read (Design Notes).

## Design Notes

`history` is not a command yet (`GET /history` is Epic 10, Story 10.2); the AC's "history carries the event" is verified against the Event Log through `readEvents` and `leaseHoldersSince`, which already close a hold at `force-release`.

Locating by id uses `listLocks` (every `*.lock` on this host) rather than the phone fleet, so a Lease on a registered phone, `mac-ios` (on the Mac) or any `res-*` lock is reachable from the same call. An emulator lock is refused because freeing it without teardown would leave a live emulator behind until Story 7.8 composes `forceRelease` with the reaper.

The `job:` id refusal is built from the id alone (no read), with the same parse as `jobTicket`; the lock-level refusal is built from the owner record. Both use one `forceReleaseJobError`, so the text and members cannot drift.

## Verification

**Commands:**
- `node --test tools/ci/force-release.test.mjs tools/hub-api/force-release.test.mjs tools/hub-api/contract.test.mjs` -- expected: all pass
- `heavy mise run check` -- expected: actionlint clean, full suite green
- `git diff main -- tools/ci/lib/eta.mjs` -- expected: empty

## Auto Run Result

Status: done
Blocking condition: none
Operator actions: none. Nothing in Story 7.6 needs a human outside the repo.

**Summary.** A stuck or forgotten Lease can now be ended by anyone who gives an actor and a non-empty `why`, through `hub-device force-release <id> --why TEXT [--holder WHO] [--json]` and `POST /leases/{id}/force-release`. Both call one Claims function, `forceReleaseLease`, which uses one protocol writer, `forceRelease` in `lock.mjs`.
- The writer renames the owner to a tomb through `retire`, so the rename decides who wins. It writes one `force-release` event carrying `hold_kind: lease`, `lease_id`, `claimant`, `held_ms`, `actor` and `why`.
- The Lease is found by id on every lock of this host, so a phone, a registered phone, the iOS lane and any `res-*` lock all work (belsky-doctrine: one level up from "free my stuck S24").
- These are refused before anything is written:
  - A deploy job's Hold: 409 `HUB_FORCE_RELEASE_JOB`, exit 2, with `repo`, `run` and `job`, plus a `gh run cancel` hint.
  - An emulator lease: 400 `HUB_USAGE` with `reason: emulator`. That case belongs to Story 7.8.
  - An id that is only waiting: 404 `waiting`.
  - An unknown id: 404 `unknown`.
- If the lock changes hands mid-way, the call answers `HUB_LEASE_LOST` and leaves the new owner alone.

**Files changed.**
- `tools/ci/lib/lock.mjs` adds `forceRelease`, the single protocol writer, and `forceReleaseJobError`, the shared Job refusal.
- `tools/device/claims.mjs` adds `forceReleaseLease`, `checkForceReleaseBody`, `HUB_FORCE_RELEASE_JOB` in the exit and HTTP tables, a shared `JOB_ID` regex and `serviceLocal`.
- `tools/hub-api/routes.mjs` adds the `POST /leases/{id}/force-release` route and the `HUB_FORCE_RELEASE_JOB` problem extensions.
- `tools/device/hub-device.mjs` adds the `force-release` command, updates USAGE and the header, and reports the new code.
- `docs/hub-api-contract.md` adds the route row, the `ForceRelease` shape, the request body and refusal order, the extension and the error-code rows.
- `README.md` adds the "Force-release a Lease (Story 7.6)" paragraph.
- `tools/ci/force-release.test.mjs` is new: lock-level tests.
- `tools/hub-api/force-release.test.mjs` is new. It covers every matrix row through the API and the CLI, CLI/API parity, status and the Event Log.
- `tools/hub-api/contract.test.mjs`, `tools/device/claims.test.mjs` and `tools/hub-api/leases.test.mjs` extend the POST sample, add a live extension answer and update the table/export pins.

**Review findings.** There were 20 findings: 14 low, 6 false, none high or medium.
- **Patched** (4 rows, 3 root causes, all low; commit 80259da):
  - The `JOB_ID` comment was in the wrong place.
  - The README and contract wording on the Job Hold refusal was misleading. Blind, edge and intent reviewers each raised it, and it is one fix.
  - The emulator-record branch had no test.
- **Deferred** (1, low): the ETA counts the `held_ms` of a force-released Lease. That comes from the existing `eta.mjs` design.
- **Rejected:**
  - Low:
    - A malformed `job:` id gets the wrong guidance (raised twice).
    - Another host's Lease answers 404 with no wrong-host code.
    - `why` is not trimmed or capped, and the event truncates it at 4 KiB (raised twice). This is the same as every other `why` in the hub.
    - The test-gap list.
    - A non-Queued lock writes no event (AD-4, unreachable from the front doors).
    - The `being-taken` mapping has no test; covering it needs a new seam.
  - False:
    - Refused attempts leave no audit trail. That is by design.
    - The `device` doc is fine.
    - The Host Agent comment follows the convention.
    - The untagged actor usage cannot be reached from a front door.
    - The waiter tests are not racy: the ticket and the `request` event are written in the same synchronous step.
    - History is checked through the Event Log, because Epic 10 does not exist yet.
  - Every row and its reason is in the Review Triage Log.

**Follow-up review recommendation:** false. The patched entries were 3 low, 0 medium and 0 high.

**Verification.**
- `node --test tools/ci/force-release.test.mjs tools/hub-api/force-release.test.mjs tools/hub-api/contract.test.mjs`: 34/34 pass, both before and after the patches.
- `git diff main -- tools/ci/lib/eta.mjs`: empty.
- `heavy mise run check`:
  - Before the patches: green, 1379/1379.
  - After the patches, first run: 1378/1379. The failure was `tools/device/emulator.test.mjs:308` ("waiting requests are served first in, first out", `one is queued`), a timing test that spawns a subprocess and that this story does not touch. That file passed 5/5 on its own.
  - After the patches, re-run: green, 1379/1379, with actionlint clean.
- Matrix audit: every I/O row is covered by a test in `tools/hub-api/force-release.test.mjs` or `tools/ci/force-release.test.mjs`, and every one ran and passed.

**Residual risks.**
- The `being-taken` answer of `forceReleaseLease` is checked only by reading the code.
- A Lease on a Mac-hosted lock cannot be force-released from big-chungus until the Host Agent (Epic 9) serves the same call there.
- `tools/device/emulator.test.mjs:308` can fail on timing under a loaded box. The flake was there before this story.
