---
title: 'Story 7.7: Force-release a Reservation'
type: 'feature'
created: '2026-11-25'
status: 'done'
baseline_revision: 'f36d7df6cf98cb57affeff5dc96827406b1e7afe'
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-7-context.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-7-6-force-release-a-lease.md'
  - '{project-root}/docs/hub-api-contract.md'
warnings: ['oversized']
deferred: []
---

<intent-contract>

## Intent

**Problem:** A deploy run that dies (runner lost, workflow killed before `announce`) leaves its Reservation first in line on `adb` or `mac-ios`, and nothing outside that run can end it: the device idles behind it until the 3 h ceiling. The only verb, `hub-device reservation release --run`, writes a plain `release` with no actor or why, and the Hub API has no route at all.

**Approach:** The existing protocol writer `releaseReservation(name, {key, actor, why})` in `lock.mjs` gains an `actor`: with one it writes `force-release` (`hold_kind: reservation`, `actor`, `why`, `reason: null`) instead of `release`, through the same `.released-<key>-<ms>` rename. One Claims call `forceReleaseReservation(run_key, input, ctx)` serves both `hub-device force-release --reservation <run_key> --why` and `POST /reservations/{run_key}/force-release` (belsky-doctrine: one level up from "free the S26 a dead run is sitting on" is "force-release any run's Reservation on any reservable lock of this host, from every front door", `adb` on big-chungus and `mac-ios` once the Host Agent serves the same call on the Mac).

## Boundaries & Constraints

**Always:**
- `lock.mjs` is the only writer of the reservations dir and its events (AD-1); `claims.mjs` owns validation, codes and the exit/HTTP tables (AD-24); `routes.mjs` only checks the body, defaults the actor and calls Claims; `hub-device.mjs` only parses and prints.
- An actor (`{holder, via}`) and a non-empty `why` are required and recorded on the event; no holder check, no confirmation (NFR-6; the page confirms in v1c).
- The rename decides (`retireReservation`): two concurrent force-releases, or a force-release racing the run's own release or a ceiling prune, end the Reservation exactly once with exactly one event.
- Without an actor `releaseReservation` behaves byte-for-byte as before (same return shape, `release` event, never throws), so `announce`, `withLock`'s `endsReservation`, `android.mjs`'s delivery-pending release and the ssh `reservation release` verb are unchanged.
- Node 24 ESM `.mjs`, no deps, no timers in new non-test code; tests hermetic (`hermetic()`, scratch lock/event dirs). `git diff main -- tools/ci/lib/eta.mjs` stays empty (it already ignores `hold_kind: reservation`).

**Never:**
- Never let a deploy job call a service or Claims to release its Reservation (AD-25): the deploy path keeps calling `releaseReservation` without an actor.
- Never touch a lock owner, a ticket or a Lease here (that is Story 7.6 / 7.5); never search another host.
- Never write `_bmad-output/implementation-artifacts/sprint-status.yaml`. No second store.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Happy path (API) | run `acme/app#77` reserved `adb`; `POST /reservations/acme--app--77/force-release {why:'dead run', holder:'ops'}` | 200 `ReservationForceRelease` `{run_key:'acme--app--77', outcome:'force-released', repo:'acme/app', run:'77', released:[{lock:'adb', resource:'s26', reserved_at, expires_at}], why:'dead run'}`; directory gone (no `.released-*` left); one `force-release` event: `hold_kind:'reservation'`, `run_key`, `held_ms`, `actor:{holder:'ops',via:'api'}`, `why`, `reason:null`, claimant `{kind:'deploy', repo:'acme/app', run:'77', attempt:null, job:null}` | — |
| Happy path (CLI) | same; `hub-device force-release --reservation acme--app--77 --why 'dead run'` | stdout `HUB_DEVICE_RESERVATION_FORCE_RELEASED adb acme--app--77`, exit 0; `--json` prints the same `ReservationForceRelease` | — |
| Parity | same setup twice, once per front door | answers equal; event logs equal ignoring `ts` and `actor.via` | — |
| `--name` / `name` | `name:'adb'` or `'mac-ios'` narrows to one lock; absent tries every reservable name on this host | only that lock is touched | other value → 400 `HUB_USAGE` `bad-name`, exit 2 |
| Empty why | `why:''` / missing / CLI no `--why` or `--why ''` | 400 `HUB_USAGE` `bad-why` / `no-why`; exit 2; nothing written | lock level: actor with empty why throws `HUB_USAGE` `bad-why` before any read |
| Already released / none | no Reservation of that run key (released, never reserved, unreadable record) | 404 `HUB_RESERVATION_NOT_FOUND` `reason: unknown`, exit 2; no event | — |
| Bad run key | `not-a-key`, `../x` | 400 `HUB_USAGE` `bad-run-key`; exit 2 | before anything is read |
| Race | two force-releases at once, or the run's own release first | exactly one event in total; the loser answers 404 | rename decides |
| Bad body | unknown key, bad actor, neither actor nor holder, non-string `name` | 400 `HUB_USAGE` `bad-body` / `bad-actor` / `no-holder` / `bad-name` | — |
| CLI misuse | `force-release --reservation k <id>`, or `--name` without `--reservation` | usage, exit 2 | — |

</intent-contract>

## Code Map

- `tools/ci/lib/lock.mjs` -- `reservationsPath` l.801, `readReservation` l.823, `reservationFields` l.856 (sets `hold_kind: 'reservation'`, takes `extra`), `reservationSubject` l.860, `retireReservation` l.869 (rename-decides; writes `as` event l.889; `own` only for `as === 'release'` so a force-release names no attempt/job), `releaseReservation` l.898 (add `actor`, `why`; existing tests deepEqual its `{status, key}` return, so add `reservation` only on a force-release), `checkActor` l.195, `failure` (HUB_USAGE shape as in `forceRelease` l.1865), `cancelRequest` l.1891 (its `HUB_CANCEL_RESERVATION` message l.1901 says "force-release it": name the new verb and route).
- `tools/device/claims.mjs` -- `EXIT_CODES` l.51 / `HTTP_ANSWERS` l.102 (add `HUB_RESERVATION_NOT_FOUND` exit 2, 404); `RUN_KEY` l.1064 and `releaseReservations` l.1068 (model; unchanged); `bodyUsage` l.681, `isText` l.682, `bodyActor` l.1105, `serviceLocal` l.1150 (strips `GITHUB_*`); `checkWhy` ~l.1326 and `checkForceReleaseBody` l.1335 (model for `checkReservationForceReleaseBody`); `forceReleaseLease` l.1363 (model); `resourceOf` imported from lock.mjs.
- `tools/hub-api/routes.mjs` -- import line l.17, `forceReleaseLeaseRoute` l.317 (pattern), `serviceContext` l.265, `ROUTES` l.326; the param matcher accepts `{run_key}` (`/^\{([a-z_]+)\}$/` l.358).
- `tools/device/hub-device.mjs` -- header l.62–65 (force-release lines), `VALUE_FLAGS` l.100, `USAGE` l.127, `report` coded-error list l.188, `forceRelease` l.372, `FLAG_OWNERS` l.731 (`name` owners; add `reservation`).
- `docs/hub-api-contract.md` -- route table l.24–39, `### ForceRelease` l.171 (model), request-body paragraphs l.298–305 (model), error codes l.325+ (`HUB_USAGE`, `HUB_CANCEL_RESERVATION` rows).
- `tools/hub-api/contract.test.mjs` -- `POST_SAMPLES` l.116 (`params: {run_key}` plus a `prepare` that calls `reserve('adb', …)` with `GITHUB_REPOSITORY`/`GITHUB_RUN_ID` in a copy of `ctx.env`).
- `tools/deploy-path.test.mjs` -- AD-25 conformance (DEPLOY_PATH, `entriesOf`): add the no-actor / no-route assertion.
- `tools/hub-api/force-release.test.mjs` -- `scratch()` model; `tools/hub-api/cancel.test.mjs` l.177 shows `reserve('adb', {env:{...env, GITHUB_REPOSITORY, GITHUB_RUN_ID}, now, log})` in a test.
- `tools/ci/reservation-release.test.mjs` -- existing `releaseReservation` tests that must stay green unchanged.
- `tools/device/claims.test.mjs` l.53 (export list) and l.59 (EXIT_CODES pin), `tools/hub-api/leases.test.mjs` l.362 (HTTP_ANSWERS pin).
- `README.md` -- l.282 the Story 7.6 paragraph: add the Story 7.7 paragraph after it.

## Tasks & Acceptance

**Execution:**
- `tools/ci/lib/lock.mjs` -- `retireReservation` takes `fields = {}` merged into the event's extra fields; `releaseReservation(name, {…, actor = null, why = null})`: with an actor, `checkActor` (TypeError when malformed) and a non-empty string `why` (else throw `HUB_USAGE` `reason: bad-why`) before anything is read, then retire `as: 'force-release'`, `reason: null`, `fields: {actor, why}`, and return `{status, key, reservation: <record>}` when released; without an actor unchanged. Update `cancelRequest`'s `HUB_CANCEL_RESERVATION` message to name `hub-device force-release --reservation <key>` -- single protocol writer.
- `tools/device/claims.mjs` -- `HUB_RESERVATION_NOT_FOUND` in both tables; `checkReservationForceReleaseBody(body)` (keys `why`, `holder`, `actor`, `name`; `bad-body`, `no-why`, `bad-why`, `bad-actor`, `no-holder`, `bad-name` for a non-string/empty name); `forceReleaseReservation(runKey, {why, actor, name}, ctx)`: actor required, `checkWhy`, `RUN_KEY` else `HUB_USAGE` `bad-run-key`, `name` in `RESERVABLE` else `bad-name`; for each name `releaseReservation(lock, {env, key, now, actor, why})` on `serviceLocal(ctx)`; none released → `HUB_RESERVATION_NOT_FOUND` `reason: unknown`; answer `{run_key, outcome:'force-released', repo, run, released:[{lock, resource, reserved_at, expires_at}], why}` -- one rule owner.
- `tools/hub-api/routes.mjs` -- `POST /reservations/{run_key}/force-release`, shape `ReservationForceRelease`, actor default `{holder, via:'api'}` -- thin route.
- `tools/device/hub-device.mjs` -- `force-release --reservation <run_key> --why TEXT [--name adb|mac-ios] [--holder WHO] [--json]`; `reservation` a value flag owned by `force-release`, `name` also owned by `force-release` (only with `--reservation`); one stdout line per released lock `HUB_DEVICE_RESERVATION_FORCE_RELEASED <lock> <run_key>`; `report` lists `HUB_RESERVATION_NOT_FOUND`; header and USAGE updated -- CLI front door.
- `docs/hub-api-contract.md` -- route row (7.7), `### ReservationForceRelease`, request-body/refusal paragraph, `HUB_RESERVATION_NOT_FOUND` row; `HUB_USAGE` and `HUB_CANCEL_RESERVATION` rows mention it -- the contract test parses it.
- `tools/hub-api/contract.test.mjs` -- POST sample for the route (prepare reserves `adb` for a run).
- `tools/hub-api/reservation-force-release.test.mjs` -- new: every matrix row through the API and the CLI; lock-level `releaseReservation` with an actor (exact event fields, empty why throws before any read, malformed actor TypeError); concurrent force-releases yield one event; CLI/API parity; `hub-device status --json` no longer lists the Reservation; the next waiter is no longer blocked by it (a `tryLock`/`acquireLease` try on `adb` succeeds where it was blocked by the head Reservation's grace).
- `tools/deploy-path.test.mjs` -- assert no DEPLOY_PATH file calls `releaseReservation` with an `actor` or names `/reservations/` or `force-release`, so deploy jobs never force-release or call a service for their own Reservation (AD-25).
- `tools/device/claims.test.mjs`, `tools/hub-api/leases.test.mjs` -- extend the export list and table pins.
- `README.md` -- "Force-release a Reservation (Story 7.7)" paragraph: both front doors, the actor/why rule, the 404, that deploy jobs never use it.

**Acceptance Criteria:**
- Given `POST /reservations/<run_key>/force-release` and `hub-device force-release --reservation <run_key>` with an actor and a why, when they run, then both call `releaseReservation(name, {key, actor, why})`, the directory is renamed to `.released-<key>-<ms>` and removed, and exactly one `force-release` event with `hold_kind: reservation`, `actor` and `why` is written.
- Given a deploy job, when it runs, then it never calls a service or passes an actor to release its Reservation; `announce`'s release and the ssh `reservation release` verb still write a plain `release` (existing `reservation-release.test.mjs` green unchanged, plus the new deploy-path assertion).
- Given an empty `why`, when it is sent through either front door, then it is refused `HUB_USAGE` (exit 2) and nothing is written.
- Given a Reservation already released, when the force-release arrives, then it answers 404 `HUB_RESERVATION_NOT_FOUND` (exit 2) and writes no event.
- Given `mise run check`, when it runs, then actionlint and all tests pass, including the contract test with the new route.

## Spec Change Log

## Review Triage Log

### 2026-11-25 — Review pass
- verdicts: 24 findings — high 0, medium 0, low 16, false 8, maybe-false 0
- findings:
  - `[low]` `[patch]` README and CLI header promise `mac-ios` force-release though nothing serves the Mac's lock dir yet — added the caveat (reachable only once the Host Agent serves the call, Epic 9) to the README paragraph and the `hub-device.mjs` header.
  - `[low]` `[reject]` The race test runs two force-releases one after the other rather than interleaved — a true interleave needs a seam (new parameter) in the shared `retireReservation` rename that the release suites already cover; not worth the complexity.
  - `[low]` `[reject]` A run that re-reserves while its old Reservation is being force-released can see a misleading 404 — requires a rerun to land inside the rename window; vanishingly unlikely, and the fix would add a guard.
  - `[low]` `[patch]` Force-releasing a Reservation already past its 3 h ceiling (not yet pruned) is claimed in Design Notes but untested — added a test that force-releases a past-ceiling Reservation and checks the `force-release` event.
  - `[low]` `[patch]` The deploy-path AD-25 regex was broad and its self-check circular — narrowed to `ACTOR_RELEASE = /\breleaseReservation\s*\([^)]*\bactor\b/` with positive and negative self-checks.
  - `[false]` `[reject]` `releaseReservation` should not take an actor (a second entry point would be cleaner) — the epic prescribes `releaseReservation(name, {key, actor, why})` verbatim, and AD-1 keeps one protocol writer.
  - `[low]` `[reject]` The event is appended after the directory is deleted, so a crash between them loses the event — the same order holds for every retire in `lock.mjs`, `appendEvent` never throws, and changing it means reordering shared code.
  - `[false]` `[reject]` No liveness check before force-releasing a running deploy's Reservation — the intent requires no holder check and no confirmation (NFR-6); the page confirms in v1c.
  - `[low]` `[patch]` A CLI misuse test used a convoluted assertion — replaced it with a plain usage/exit-2 assertion; the claims that `--reservation` without a value or with `--holder`/a job misbehave are false (it already answers "needs a value").
  - `[low]` `[patch]` The not-found message omitted the unreadable-record case — message now reads "(already released, never reserved, or its record is unreadable)"; the why-trim and hint-drift parts match existing messages and were left.
  - `[low]` `[reject]` A failed event append is silent — pre-existing for every event in `lock.mjs`; `appendEvent` is best-effort by design.
  - `[false]` `[reject]` Force-releasing a run holding both `adb` and `mac-ios` writes two events — that is one event per Reservation ended, as the contract documents.
  - `[false]` `[reject]` No confirmation before ending a live run's Reservation — same as the liveness finding; the intent excludes confirmation here.
  - `[low]` `[reject]` `bad-name` is checked after `bad-run-key`, so a body with both errors reports only one — both are 400 `HUB_USAGE`, the order is documented, and nobody meets it in everyday use.
  - `[low]` `[patch]` The deploy-path assertion could false-positive on comments or unrelated words — same root cause as the regex finding; fixed by the narrowed `ACTOR_RELEASE` pattern.
  - `[low]` `[reject]` `retireReservation` swallows an event-write failure — same as the silent-append finding; pre-existing.
  - `[low]` `[patch]` (verification-gap) No test of the past-ceiling force-release claim — fixed with the past-ceiling test above.
  - `[low]` `[patch]` (verification-gap, filed as defer) No behavioural test that the deploy path still writes a plain `release` — added a test that `releaseFor`, `releaseReservations` and the CLI `reservation release` each write `release` with no actor or why.
  - `[low]` `[reject]` (verification-gap other) The updated `HUB_CANCEL_RESERVATION` pointer text is not pinned by a test — cosmetic message text; pinning it adds churn for no behaviour.
  - `[low]` `[reject]` (verification-gap other) The race test is sequential — same as the interleave finding.
  - `[false]` `[reject]` (intent) The Story 5.1 conformance test was not extended — `tools/deploy-path.test.mjs` is the Story 5.1 test (commit 1f85211) and gains the AD-25 actor/route assertion.
  - `[false]` `[reject]` (intent) The route is exercised only through `handle()`, not a socket — the epic requires hermetic tests with no socket; `handle()` is the server's dispatch.
  - `[false]` `[reject]` (intent) The front doors call `forceReleaseReservation`, not `releaseReservation` directly — AD-24 makes Claims the rule owner, and `forceReleaseReservation` calls `releaseReservation(name, {key, actor, why})`.
  - `[false]` `[reject]` (intent) The operator outcome (freeing the S26) is not live — it goes live with the hub release/deploy (Story 7.9), outside this story.

## Design Notes

The epic names the route and verb but not a refusal code for "already released"; `HUB_RESERVATION_NOT_FOUND` (404, exit 2, `reason: unknown`) mirrors `HUB_REQUEST_NOT_FOUND`/`HUB_LEASE_NOT_FOUND`. An expired-but-unpruned Reservation is still a directory and is force-released like a live one (the existing `release` behaves the same), so the event records what actually ended it.

A run key can hold Reservations on both `adb` (big-chungus) and `mac-ios` (the Mac's own lock dir); without `name` the call tries every reservable name in this host's lock dir, exactly as `releaseReservations` does, so the answer's `released` is a list. `repo`/`run` come from the released record.

`releaseReservation` returns `reservation` only on a force-release so the existing `{status, key}` deepEqual pins keep passing and the deploy path's return is unchanged.

## Verification

**Commands:**
- `node --test tools/hub-api/reservation-force-release.test.mjs tools/ci/reservation-release.test.mjs tools/hub-api/contract.test.mjs tools/deploy-path.test.mjs` -- expected: all pass
- `heavy mise run check` -- expected: actionlint clean, full suite green
- `git diff main -- tools/ci/lib/eta.mjs` -- expected: empty

## Auto Run Result

**Status:** done. Blocking condition: none. Operator actions: none. No acceptance criterion needs a human outside the repo.

**Summary:** A dead deploy run's Reservation on `adb` (or `mac-ios`) can now be ended by anyone who names themselves and a reason, through `hub-device force-release --reservation <run_key> --why TEXT [--name adb|mac-ios]` or `POST /reservations/{run_key}/force-release`. Both front doors call one Claims rule, `forceReleaseReservation`. That rule calls `releaseReservation(name, {key, actor, why})` in `lock.mjs`. With an actor, `releaseReservation` writes a `force-release` event (`hold_kind: reservation`, actor, why, `reason: null`) through the same rename that decides every release. Without an actor its behaviour is unchanged, so the deploy path still writes a plain `release` and never calls a service (AD-25). Belsky-doctrine level: this works for any run's Reservation, on any reservable lock, from every front door, not just for one S26 incident.

**Files changed:**
- `tools/ci/lib/lock.mjs`: `releaseReservation` accepts an optional actor and why (it checks them before reading anything). `retireReservation` merges extra event fields. The `HUB_CANCEL_RESERVATION` message now names the new verb and route.
- `tools/device/claims.mjs`: adds `HUB_RESERVATION_NOT_FOUND` (exit 2, HTTP 404), `checkReservationForceReleaseBody` and `forceReleaseReservation`.
- `tools/hub-api/routes.mjs`: adds the thin route `POST /reservations/{run_key}/force-release` (shape `ReservationForceRelease`, actor defaults to via `api`).
- `tools/device/hub-device.mjs`: adds `force-release --reservation` (`--name`, `--holder`, `--json`), plus usage, header and report codes.
- `docs/hub-api-contract.md`: adds the route row, the `ReservationForceRelease` shape, the body and refusal rules and the new error row, and updates the `HUB_USAGE` and `HUB_CANCEL_RESERVATION` rows.
- `README.md`: adds the "Force-release a Reservation (Story 7.7)" paragraph, including the mac-ios caveat.
- `tools/hub-api/reservation-force-release.test.mjs` (new): covers every matrix row through the API and the CLI, parity between them, races, lock-level behaviour with and without an actor, the past-ceiling case, plain `release` on the deploy path, and status and waiter unblocking.
- `tools/hub-api/contract.test.mjs`: adds a POST sample for the new route.
- `tools/deploy-path.test.mjs`: adds the AD-25 assertion that no deploy-path file passes an actor or names the route or verb.
- `tools/device/claims.test.mjs`, `tools/hub-api/leases.test.mjs`: extend the export and table pins.

**Review findings:** 24 total (high 0, medium 0, low 16, false 8).
- Six patch entries were applied, all low:
  - the mac-ios caveat in the README and CLI header;
  - a past-ceiling force-release test (B4 and VG1);
  - a narrowed AD-25 regex with real self-checks (B5 and E5);
  - a plain CLI-misuse assertion;
  - a not-found message that names the unreadable case;
  - a behavioural test that the deploy path writes a plain `release` (VG2).
- Deferred: none.
- Rejected:
  - The race test is not interleaved (B2 and VG other 2). Interleaving would need a seam in the shared rename.
  - A rerun mid-force could see a misleading 404 (B3). This is vanishingly unlikely.
  - The event is appended after the delete, and a failed append is silent (B7, E1, E6). The same pattern is in every retire, and `appendEvent` is best-effort.
  - `bad-name` and `bad-run-key` are checked in a fixed order (E4). Both answer 400, and the order is documented.
  - The `HUB_CANCEL_RESERVATION` text is not pinned by a test (VG other 1). This is cosmetic.
  - Eight false findings were refuted, mostly on the intent's own terms: B6, B8, E2, E3, I1, I2, I3, I4. The details are in the triage log.

**Follow-up review recommended:** false. This pass patched high 0, medium 0, low 6.

**Verification:**
- The targeted suite (`reservation-force-release`, `reservation-release`, `contract`, `deploy-path`) passes 52/52.
- `heavy mise run check` passed after the patches: actionlint clean, 1395/1395 tests passing.
- `git diff main -- tools/ci/lib/eta.mjs` is empty.
- The matrix audit passed: every row has a passing test.

**Residual risks:**
- `mac-ios` Reservations cannot be force-released until the Host Agent serves this call on the Mac (Epic 9).
- Concurrent force-releases are covered only sequentially. The rename is the same one the release suites prove.
- The event is still written after the rename and delete, so a crash in between drops the event. This is pre-existing.
- The capability goes live only with the next hub release and host install (Story 7.9).
