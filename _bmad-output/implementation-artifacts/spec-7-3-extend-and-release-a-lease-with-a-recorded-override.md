---
title: 'Story 7.3: Extend and release a Lease, with a recorded override'
type: 'feature'
created: '2026-11-25'
status: 'done'
baseline_revision: '1161ce5e83831839df1c4ffa56cb969f8ef36580'
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-7-context.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-7-2-wait-for-a-lease-through-the-api.md'
  - '{project-root}/docs/hub-api-contract.md'
warnings: ['oversized']
deferred: []
---

<intent-contract>

## Intent

**Problem:** A Lease can only be extended through `lock.mjs` directly (there is no `hub-device extend` verb and no API route), release exists only on the CLI, and the no-extension-while-waiters rule (AD-16) has no recorded way around it when Jarad must finish real work.

**Approach:** Add `extendLease`'s `override: {actor, why}` (skips only the waiters check) and an `actor` on extend, release and release-cancel events in `lock.mjs`; one Claims function each for a service extend and a service release, shared by `hub-device extend` / `hub-device release` and `POST /leases/{id}/extend` / `POST /leases/{id}/release`. One level up (pillar `belsky-doctrine`): every front door — the CLI, the Hub API and the Host Agent (Epic 9) — extends and releases through the same two Claims calls, and every Lease extend/release event records who did it.

## Boundaries & Constraints

**Always:**
- `lock.mjs` stays the only lock-dir and Event Log writer (AD-1); expiry only moves later through `extendLease` (AD-16). The override skips only the waiters check: never the expiry check, the deploy-target cap or the 48 h limit.
- Rules live in `tools/device/claims.mjs`; `routes.mjs` and `hub-device.mjs` only parse, call and print/serialise.
- `HUB_LEASE_EXTEND_REFUSED` exits 76 and answers 409; each refusal carries a `reason`: `waiters`, `expired`, `cap`, `too-long`. A refusal writes nothing.
- Actor: API `actor` as given, else `{holder, via:'api'}`, else 400 `no-holder`; CLI `{holder: --holder ?? $HUB_DEVICE_HOLDER ?? user@host, via:'cli'}`. Override `why` must be non-empty (`HUB_USAGE`, 400/exit 2).
- Hermetic tests: temp lock/event dirs, `handle()` with fake bodies, `main()` of `hub-device` with fake seams; no socket, adb or emulator.

**Never:**
- No cancel, force-release, emulator or forwarding routes (7.4–7.8, Epic 9). The API refuses an emulator lease id on extend/release (`HUB_USAGE`, reason `emulator`); the CLI keeps extending and releasing emulators.
- No holder-match check on extend/release (no authentication, NFR-6; the id is the handle, as on the CLI today).
- Do not modify `tools/ci/lib/eta.mjs`, the deploy path (`tools/ci/commands/*`, `tools/catchup/*`); no dependencies, no Python.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Extend, nobody waits | s24 held as `x-1` (30 min); `extend x-1 --for 10m` / `POST /leases/x-1/extend {for_ms:600000, holder}` | expiry +10 min; one `extend` event with `actor`; CLI `HUB_DEVICE_EXTENDED s24 x-1 until <iso>` exit 0; API 200 `Lease` | — |
| Waiters | s24 queue has a ticket (or Pool ticket) | `HUB_LEASE_EXTEND_REFUSED` reason `waiters`, message names each waiter with its place; exit 76 / 409 | nothing written |
| Override with waiters | same + `--override "finish proof"` / `override:{why}` | extends; `extend` event has `actor`, `why`, `reason:'override'` | — |
| Override, empty why | `--override ""` / `override:{why:''}` | `HUB_USAGE` exit 2 / 400 `bad-override` | nothing written |
| Override past a cap | s26 Lease 50 min + override for 20 min | refused reason `cap` (60 min), 48 h → `too-long` | nothing written |
| At/after expiry | now ≥ `expires_at` | refused reason `expired` | nothing written |
| Unknown / waiting id | id holds nothing | `HUB_LEASE_NOT_FOUND` exit 2 / 404, reason `unknown` / `waiting` | — |
| `job:` id | `extend job:…` or `release job:…` (either door) | `HUB_DEVICE_JOB_ID` exit 2 / 400, names the run to cancel | — |
| Release | `release x-1` / `POST /leases/x-1/release {holder}` | lock released through `releaseLease`; one `release` event (`by-id`) with `actor`; API 200 `Release` `{lease_id, outcome:'released', resource, lock, device}` | — |
| Release a waiter / nothing | id only queued / unknown | `cancelled` (cancel event with `actor`) / `none`; CLI exit 0, API 200 | — |
| Release, lock mid-take or changed hands | `unknown-holder` / `changed-hands` | CLI exit 1 (as today); API 409 `HUB_LEASE_LOST` reason `being-taken` / `changed-hands` | — |
| Parity | same state, CLI vs API extend (ok and refused) and release | same owner record (minus `lock_ino`), same refusal code+reason, same events (minus `ts`, `actor.via`) | — |

</intent-contract>

## Code Map

- `tools/ci/lib/lock.mjs` -- `extendLease` (l.1842): add `actor`, `override` options; tag every `failure('HUB_LEASE_EXTEND_REFUSED', …)` with `reason`; waiters block (l.1850–1855) skipped when `override`; event at l.1864 via `eventOf('extend', name, record, fields)`. `releaseLease` (l.1745): add `actor`, put it on the per-ticket `cancel` (l.1768) and on `retire`'s `fields` (l.1783). `checkActor` (l.195), `failure` helper, `eventOf` (l.160). `updateLease` (l.1792) unchanged.
- `tools/device/claims.mjs` -- `EXIT_CODES` (l.46: `HUB_LEASE_EXTEND_REFUSED` 1→76), `HTTP_ANSWERS` (l.90: add `HUB_LEASE_EXTEND_REFUSED` 409, `HUB_LEASE_LOST` 409). `extend` (l.905): job-id refusal, not-held → `HUB_LEASE_NOT_FOUND` (reuse `phoneWaiting`/`findLease` wording), pass `actor`/`override`. `release`/`releasePhone` (l.876/825): thread `actor` to `releaseLease`. `heldLease`/`leaseView`/`jobTicket`/`isEmulatorLease` reused. `serviceLease` (l.690) is the template for env stripping and the context.
- `tools/hub-api/routes.mjs` -- add `extendLeaseRoute`, `releaseLeaseRoute` handlers and two `ROUTES` rows (`/leases/{id}/extend` shape `Lease`, `/leases/{id}/release` shape `Release`).
- `tools/device/hub-device.mjs` -- `release` (l.322) passes the actor; new `extend` verb, `override` flag in `VALUE_FLAGS` (owned by `extend` in `FLAG_OWNERS`), `report` (l.163) prints `HUB_LEASE_EXTEND_REFUSED …` and `HUB_LEASE_NOT_FOUND …` instead of `HUB_DEVICE_BUSY`/`hub-device:`; header comment, `USAGE`, dispatch (l.723).
- `docs/hub-api-contract.md` + `tools/hub-api/contract.test.mjs` -- route rows, `Release` shape, request bodies, error rows; `POST_SAMPLES` for both new routes with `setup: ['/leases']`.
- `README.md` l.92 -- "The `hub-device extend` verb is v1b" → describe the verb, override and exit 76.
- Tests to update: `tools/device/claims.test.mjs:280` (exit 1 → 76; waiter/unknown id → `HUB_LEASE_NOT_FOUND`), `tools/hub-api/leases.test.mjs:363` (`HTTP_ANSWERS` list), `tools/ci/extend.test.mjs` (add reason/override cases).

## Tasks & Acceptance

**Execution:**
- `tools/ci/lib/lock.mjs` -- `extendLease(name, id, {…, actor = null, override = null})`: `override` must be `{actor, why}` with a valid actor and non-empty string `why` (else TypeError, a caller bug); reasons on refusals; with `override` the waiters check is skipped; event fields `actor` (override's, else `actor`), and with override `why` plus `reason: 'override'`. `releaseLease(…, {actor})` records it on `release` and `cancel`.
- `tools/device/claims.mjs` -- exit/HTTP table changes; `extend(id, {forMs, actor, override}, ctx)` with the job/not-found refusals; `checkExtendBody(body)` (keys `for_ms`, `holder`, `actor`, `override`; reasons `bad-body`, `bad-for`, `bad-actor`, `bad-override`, `no-holder`) and `checkReleaseBody(body)` (keys `holder`, `actor`; `bad-body`, `bad-actor`, `no-holder`); `serviceExtend(id, input, ctx)` → `leaseView` and `serviceRelease(id, input, ctx)` → `{lease_id, outcome, resource, lock, device}`; both strip `GITHUB_*`, refuse an emulator id, call `extend`/`release`.
- `tools/hub-api/routes.mjs` -- the two handlers and rows (body checked first, actor defaulted, override actor defaults to the request actor).
- `tools/device/hub-device.mjs` -- `extend [<id>] --for <dur> [--override <why>] [--holder WHO] [--json]` (no id: `$HUB_LEASE_ID`); `--json` prints `{lease_id, lock, device, expires_at}`; release records the cli actor.
- `docs/hub-api-contract.md`, `tools/hub-api/contract.test.mjs`, `README.md` -- as in the Code Map.
- `tools/hub-api/extend-release.test.mjs` (new) -- every matrix row through `handle()` and `hub-device main()`, including the parity tests; `tools/ci/extend.test.mjs` -- override and reasons at the lock layer; update the tests listed in the Code Map.

**Acceptance Criteria:**
- Given a Lease with a waiter, when `hub-device extend <id> --for 10m` runs, then it exits 76, stderr starts `HUB_LEASE_EXTEND_REFUSED`, names the waiter with its place, and the owner record and Event Log are unchanged.
- Given the same state and `POST /leases/<id>/extend` with `override: {why: 'finish'}`, when it runs, then it answers 200 with the later `expires_at`, and the one new event is `extend` with `actor`, `why: 'finish'` and `reason: 'override'`.
- Given two scratch dirs in the same state, when the CLI and the API extend (once granted, once refused) and release the same id, then the owner records, refusal code and reason, and events (minus `ts` and `actor.via`) are equal.
- Given `mise run check`, when it runs, then it is green and `git diff main -- tools/ci/lib/eta.mjs` is empty.

## Spec Change Log

## Review Triage Log

### 2026-11-25 — Review pass
- verdicts: 26 findings — high 0, medium 0, low 15, false 11, maybe-false 0
- findings:
  - `[low]` `[reject]` (blind) exit 76 is the "retry" exit but `expired`, `cap`, `too-long` never succeed on retry — the intent's AC pins exit 76 on `HUB_LEASE_EXTEND_REFUSED` and the table maps by code; the `reason` tells them apart; changing it means editing this build's spec.
  - `[false]` `[reject]` (blind) the library `extend` changes exit codes for existing callers — there was no `hub-device extend` verb and no caller of `claims.extend` outside its own tests (grep), so no adapter could test `$? -eq 1`.
  - `[low]` `[patch]` (blind) `serviceExtend` re-reads the lock after the write and can answer a committed extension as 409 `HUB_LEASE_LOST` — fixed: the view is built from the record `extendHeld` returned (new `leaseDevice` helper shared with `heldLease`), no second read.
  - `[low]` `[patch]` (blind) README claims every Lease release event carries `actor`, but emulator releases do not — fixed: the README sentence now says phone Lease extend/release/cancel and emulator extend events carry it, and an emulator release records no actor yet.
  - `[low]` `[patch]` (blind) no test of a CLI emulator extend — added a `main()` test: emulator slot Lease + record, `extend <e-id> --for 10m --holder jarad` exits 0, prints `HUB_DEVICE_EXTENDED emulator …`, and the slot's `extend` event has the cli actor.
  - `[false]` `[reject]` (blind) override `why` has no length bound — `events.mjs` `fit()` truncates `why` so every line stays under 4 KiB, exactly as a lease `why`.
  - `[false]` `[reject]` (blind) the override is not authorised — no authentication by design (NFR-6), stated in the epic and the contract.
  - `[false]` `[reject]` (blind) `job-held` hidden as `none` — `job-held` is reachable only when the waiter's ticket vanished between `releasePhone`'s read and `releaseLease` (a found ticket otherwise returns `cancelled` first); nothing is then held or waited under this id, which is what `none` says, and it mirrors the CLI's `HUB_DEVICE_NOT_HELD` exit 0.
  - `[low]` `[patch]` (blind) `USAGE` and the header omit `--holder` on `release` — added `[--holder WHO]` to both.
  - `[low]` `[reject]` (blind) extend is not idempotent on a retried request — a guard field (`expected_expires_at`) is new public surface; a client can `GET /leases/{id}` after a lost answer.
  - `[low]` `[patch]` (edge) an empty `--holder ''` or `HUB_DEVICE_HOLDER=''` makes `release` die on `checkActor`'s TypeError — fixed: `cliActor` falls back with `||`.
  - `[low]` `[patch]` (edge) post-write re-read in `serviceExtend` — same root cause as the blind row; same fix.
  - `[low]` `[patch]` (edge) emulator release/reaper/holder-exit events carry no actor though README says every one does — same root cause as the blind README row; same fix.
  - `[low]` `[patch]` (edge, claim) "every Lease release event records who did it" is untrue for `releaseHeld`, teardown and reaper — same root cause; same fix.
  - `[low]` `[reject]` (edge) `--override --json` swallows the next flag as the why — that is `parseArgs`' rule for every value flag (`--why --json` does the same); a special case for one flag is a new guard.
  - `[low]` `[patch]` (verification-gap) emulator release/cancel events carry no actor and nothing checks it — disposition taken as "narrow the README" (same root cause as the blind README row); same fix.
  - `[false]` `[reject]` (verification-gap) other-member Pool cancels' actor unverified — `releaseLease` writes no `cancel` for a Pool ticket at all (it `continue`s on `pool`+`request`; the request writes its own), so deleting `actor` from that loop changes no event.
  - `[low]` `[patch]` (verification-gap) CLI emulator extend untested through the front door — same as the blind row; the test was added.
  - `[low]` `[reject]` (verification-gap, other) `HUB_LEASE_LOST` from extend is not produced in an API test — after the patch the only source is `extendLease`'s read-then-rewrite race, pre-existing lock code a fixture cannot reach without a new seam.
  - `[false]` `[reject]` (intent-alignment) the library refuses an empty override `why` with TypeError, not HUB_USAGE — the AC's 400/exit 2 is observed at the front doors (both tested); a TypeError at the lock layer is a caller bug, as `checkActor`'s.
  - `[false]` `[reject]` (intent-alignment) `override.actor` defaults and the CLI uses `--override <why>` — the library receives `override: {actor, why}` from both doors; the defaults are the contract's actor rule.
  - `[false]` `[reject]` (intent-alignment) unknown-id extend became `HUB_LEASE_NOT_FOUND` — a spec Design Note; descriptive, no defect.
  - `[low]` `[reject]` (intent-alignment) API tests do not exercise the Pool-ticket waiter — `waitersBehind` (unchanged) is covered by `claims.test.mjs` and `extend.test.mjs`, and the API calls the same function; another API fixture adds no coverage of new code.
  - `[false]` `[reject]` (intent-alignment) the API refuses emulator ids — the spec's boundary (Story 7.4 owns emulators through the API); descriptive.
  - `[false]` `[reject]` (intent-alignment) release gains `cancelled`/`none` outcomes — these are the CLI's existing outcomes, answered as data; descriptive.
  - `[false]` `[reject]` (intent-alignment) Host Agent mentioned only in comments — Epic 9 serves these functions; descriptive.

## Design Notes

- **Exit 76 for every `HUB_LEASE_EXTEND_REFUSED`.** The table maps by code; the `reason` tells a waiter refusal from an expired or capped one. No caller used the old exit 1 (there was no extend verb).
- **Not-held is `HUB_LEASE_NOT_FOUND`, not `HUB_LEASE_LOST`.** Same answer as `GET /leases/{id}`; `HUB_LEASE_LOST` (409) stays for a lock that changed hands between the read and the rewrite.
- **`reason: 'override'` only when waiters were skipped.** An override sent with nobody waiting still records `actor` and `why` but no `reason`, so the log shows when the rule was actually overridden.

## Verification

**Commands:**
- `node --test tools/hub-api/extend-release.test.mjs tools/hub-api/leases.test.mjs tools/hub-api/contract.test.mjs tools/ci/extend.test.mjs tools/device/claims.test.mjs tools/device/hub-device.test.mjs` -- expected: all pass
- `heavy mise run check` -- expected: actionlint and the full suite green

## Auto Run Result

**Status:** done

**Summary.** A Lease can now be extended and released through every front door with one set of Claims calls. `hub-device extend [<id>] --for <dur> [--override <why>]` and `POST /leases/{id}/extend` share `claims.extendHeld`. `hub-device release` and `POST /leases/{id}/release` share `claims.release`. `lock.mjs` `extendLease` takes `override: {actor, why}`, which skips only the waiters check (never expiry, the 60 min deploy cap or 48 h). Every refusal carries a `reason` (`waiters`, `expired`, `cap`, `too-long`) and exits 76 / answers 409. Phone Lease extend, release and cancel events, plus emulator extend events, record the `actor`. An override records `why`, and `reason:'override'` when waiters were actually skipped. One level up (`belsky-doctrine`): the Epic 9 Host Agent gets the same two calls with no new rules.

**Files changed:**
- `tools/ci/lib/lock.mjs` -- `extendLease` override, actor and refusal reasons; `releaseLease` actor on release and cancel events.
- `tools/device/claims.mjs` -- exit 76 and HTTP 409 rows; `extendHeld` (job-id and not-held refusals); body checkers; `serviceExtend` and `serviceRelease`; `leaseDevice` helper; actor threaded through `release`.
- `tools/hub-api/routes.mjs` -- `POST /leases/{id}/extend` and `POST /leases/{id}/release` handlers and ROUTES rows.
- `tools/device/hub-device.mjs` -- `extend` verb, `--override` flag, cli actor on release, new report lines, USAGE.
- `docs/hub-api-contract.md` -- the two routes, `Release` shape, request bodies, error rows.
- `README.md` -- the extend verb, the override, exit 76, and which events carry an actor.
- `tools/hub-api/extend-release.test.mjs` (new) -- every matrix row through `handle()` and `main()`, CLI/API parity, CLI emulator extend.
- `tools/ci/extend.test.mjs`, `tools/device/claims.test.mjs`, `tools/hub-api/leases.test.mjs`, `tools/hub-api/contract.test.mjs` -- override, reason and actor cases; updated exit codes and HTTP tables; POST samples.

**Review breakdown.** There were 26 findings: high 0, medium 0, low 15, false 11, maybe-false 0.
- **Patched:** 5 entries (10 rows), all low.
  - `serviceExtend` no longer re-reads the lock after writing.
  - The README actor claim was narrowed to what is actually recorded.
  - A CLI emulator extend test was added.
  - `--holder` was added to the release usage text.
  - An empty holder now falls back instead of throwing.
- **Deferred:** none.
- **Rejected low (5):**
  - Exit 76 for non-retryable reasons: the AC pins it, and `reason` tells the refusals apart.
  - Extend is not idempotent: fixing it needs new public surface.
  - `--override --json` swallows the next flag: every value flag behaves this way.
  - No API test produces `HUB_LEASE_LOST` from extend: that race lives in pre-existing lock code with no seam to reach it.
  - API tests lack a Pool-ticket waiter: `waitersBehind` is already covered at the lock and claims layers.
- **Rejected false (11):** each refutation is in the triage log above.

**Follow-up review recommended:** false. Patched by verdict: high 0, medium 0, low 5 entries.

**Verification:**
- The targeted `node --test` run (6 files) passed 149/149.
- `heavy mise run check` passed 1319/1319 before the patches and 1320/1320 after (actionlint plus the full suite).
- `git diff main -- tools/ci/lib/eta.mjs` is empty.

**Residual risks:**
- Emulator release, reaper and holder-exit events still record no actor.
- A retried extend after a lost answer extends twice.
- The `HUB_LEASE_LOST` answer on release is tested only through the pure `releaseAnswer`, not a live race.
- The empty-holder fallback in `cliActor` has no dedicated test.
- Exit 76 also covers refusals that will never succeed on retry, so a script must read `reason`.
