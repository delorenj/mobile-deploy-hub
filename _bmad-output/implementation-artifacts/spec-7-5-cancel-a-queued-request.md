---
title: 'Story 7.5: Cancel a queued request'
type: 'feature'
created: '2026-11-25'
status: 'done'
baseline_revision: '81856c1ac2079854ff0c1627123670a5ea770814'
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-7-context.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-7-4-lease-an-emulator-through-the-api.md'
  - '{project-root}/docs/hub-api-contract.md'
warnings: ['oversized']
deferred: []
---

<intent-contract>

## Intent

**Problem:** A queued Lease request (a waiting ticket) can only end by being granted, timing out or its own waiter giving up. An agent or operator cannot take back a request it no longer needs, or clear someone else's stuck request, from the CLI or the Hub API, so the line stays blocked behind it.

**Approach:** One protocol writer `cancelRequest` in `lock.mjs` removes a waiting ticket (every member queue for a Pool request), leaves an attribution note the waiter reads so its single ending event names the canceller, and touches no Hold. One Claims call serves `hub-device cancel <id>` and `POST /requests/<id>/cancel`, so every front door cancels every waiter kind (single lock, phone/match Pool, emulator gate) the same way (belsky-doctrine: one level up from "cancel my API wait" is "cancel any queued request from any front door").

## Boundaries & Constraints

**Always:**
- `lock.mjs` is the only writer of queue files, notes and lock-level events (AD-1); `claims.mjs` owns rules, codes and the exit/HTTP table (AD-24); `routes.mjs` only parses, calls Claims and serialises; `hub-device.mjs` only parses and prints.
- An actor is required for every cancel and recorded on the ending event; a caller that is not the request's holder may cancel (NFR-6), its actor recorded.
- A Pool request ends with exactly one Pool-level ending event (written by the request's own `settle`, AD-33); a single-lock request ends with exactly one lock-level `cancel` event.
- The API body names `resource` (and for a Pool cancel the `pool`; optional `host` key checked against this host); the receiver never searches the fleet by id. The CLI may locate the request on its own host.
- The answer is the resulting queue(s) of the affected lock(s).
- Node 24 ESM `.mjs`, no deps, no `setTimeout`/`setInterval` in new non-test code; tests hermetic (`hermetic()`, injected fakes, scratch lock dirs). `git diff main -- tools/ci/lib/eta.mjs` stays empty.

**Never:**
- Never touch an owner record or Hold (a granted request is not a queued request: answer "held, release it").
- Never cancel a `job:` id or a job / hub-job ticket (deploy jobs are cancelled through GitHub, not here).
- Never cancel a Reservation (point to `POST /reservations/<key>/force-release` / `hub-device reservation force-release`).
- Never write `_bmad-output/implementation-artifacts/sprint-status.yaml`.
- No second lock, queue or device store; no search of other hosts.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Single-lock waiter | `s24` held by A, B waits with lease id `b-1`; `POST /requests/b-1/cancel {resource:'s24', holder:'ops'}` | 200 `Cancel`: `outcome:'cancelled'`, `queues[0].lock:'s24'`, B gone from `waiters`; one `cancel` event on `s24` with `actor.holder:'ops'`, `reason:'cancelled'`; B's wait rejects `HUB_LEASE_CANCELLED` naming `ops`; A's Hold untouched | — |
| Phone Pool request | `phone` request id `p-1` waiting in `s24` and `s26` queues | Ticket removed from both queues; one Pool-level cancel event (reason `cancelled`, canceller's actor); no lock-level `cancel` event | Body without `pool:'phone'` or with wrong `pool` → 404 `HUB_REQUEST_NOT_FOUND` |
| Emulator request | id waiting on the `emulator` gate | gate ticket removed; Pool request settles `cancelled` with canceller actor | — |
| Unknown id | no ticket with that id | 404 `HUB_REQUEST_NOT_FOUND`, reason `unknown`; CLI exit 2 | — |
| Already granted | id holds the lock/slot | 404 `HUB_REQUEST_NOT_FOUND`, reason `held`, detail says release it | — |
| Job id | `job:123` or ticket of kind job/hub-job | 400 `HUB_DEVICE_JOB_ID`; CLI exit 2 | — |
| Reservation | id is a Reservation key on the lock | 409 `HUB_CANCEL_RESERVATION`, detail names force-release; CLI exit 2 | — |
| Wrong host | body `host` ≠ this host's key | 409 `HUB_WRONG_HOST`; unknown own key → 503 `HUB_HOST_UNKNOWN` | — |
| Bad body | unknown key, non-string `resource`/`pool`/`why`, missing holder/actor | 400 `HUB_API_BAD_REQUEST` with reasons `bad-body`, `no-resource`/`bad-resource`, `bad-pool`, `bad-host`, `bad-why`, `no-holder`/`bad-actor` | — |
| Race | waiter granted/withdrew between find and unlink | `{cancelled:false, reason:'gone'}` → 404 `unknown`; Pool partly removed but request now holds a member → `held` | own note removed |

</intent-contract>

## Code Map

- `tools/ci/lib/lock.mjs` -- protocol writer. Reuse: `poolRequest` l.1150 (its `settle(reason)` maps aborted|released|error; `write()` adds request actor — add `cancelled` reason using `error.cancel.actor/why`), `acquirePool` l.1198 (`withdraw` l.1256 renames ticket to tomb; `cancelled()` l.1279 fires when member ticket missing), `acquireLease` l.1583 (`leave()`, `cancelled()` l.1655, finally writes cancel aborted/error; supports `pool` tag), `releaseLease` l.1747 (per-ticket lock-level cancel with actor, skips Pool tickets; parses every file in queue dir — notes must lack `lease_id` or be skipped), `listWaiters` l.686 (`.json` filter, prune writes `prune`), `queueView` l.994, `ticketName` l.1022, `writeFileAtomic` l.512, `eventOf` l.160, `note` l.187, `checkActor` l.195, `failure` l.475, `readReservations` l.798, `reservationEntry` l.928, `resourceOf` l.61, `EMULATOR_POOL`, `RESERVABLE`.
- `tools/device/claims.mjs` -- `EXIT_CODES` l.51, `HTTP_ANSWERS` l.98, `hostKey` l.147, `phoneMembers` l.268, `matchTarget`, `jobTicket` l.954, `releasePhone` l.986, `release` l.1038, `bodyActor` l.1090, `checkReleaseBody` l.1126 (model for `checkCancelBody`), `serviceRelease` l.1171 / `releaseAnswer` l.1181 (model). Do not call `resolve` l.359 (it refuses retired words). `GATE`, `isEmulatorLock` come from `emulator.mjs`.
- `tools/device/emulator.mjs` -- `provision` l.505–564: `poolRequest('emulator')` then `acquireLease(GATE,…)`; catch → `request.settle(out,{signal})`. Gets the attributed Pool cancel through settle once `HUB_LEASE_CANCELLED` carries `cancel`.
- `tools/hub-api/routes.mjs` -- `ROUTES` l.306, `serviceContext` l.265, `releaseLeaseRoute` l.299 (pattern: check body, default actor `{holder, via:'api'}`, call Claims); host key via `ctx.hostKey ?? realHostKey`.
- `tools/device/hub-device.mjs` -- `VALUE_FLAGS` l.93 (has `why`, `holder`), `USAGE` l.120, `report` l.167, `cliActor` l.326, `release` l.352 (model), `FLAG_OWNERS` l.698, command switch l.755.
- `docs/hub-api-contract.md` -- route table l.24–37, `### <Shape>` sections, request bodies l.191+, error codes l.264+.
- `tools/hub-api/contract.test.mjs` -- `POST_SAMPLES` l.116 needs a sample per POST route; `callPost` l.147 runs only POST setups, so add a `prepare(ctx)` hook (create a live waiter) and `after` cleanup.
- `tools/hub-api/extend-release.test.mjs` -- `scratch()` with `api`, `take`, `cli`, `events`, `wait(lock,id,holder,why)`: model for `cancel.test.mjs`.
- `README.md` -- l.92 actor sentence, l.241 phone pool release/cancel semantics, l.250 release usage.

## Tasks & Acceptance

**Execution:**
- `tools/ci/lib/lock.mjs` -- add exported `cancelRequest(name, lease_id, {actor, why=null, env, now, hostId, host, processStart})` returning `{cancelled:true, pool, request, locks}` or `{cancelled:false, reason:'none'|'gone'|'held'}`; throw `HUB_DEVICE_JOB_ID` / `HUB_CANCEL_RESERVATION` as typed failures; write the `<file>.cancel` attribution note before unlinking; teach `acquireLease`/`acquirePool` `cancelled()` and `poolRequest.settle` to read it; waiters remove notes; `listWaiters` prune removes orphan notes older than `TICKET_ABSENT_MS` -- single protocol writer.
- `tools/ci/cancel-request.test.mjs` -- new, modelled on `tools/ci/pool-request.test.mjs` -- unit tests: single cancel event + waiter rejection naming canceller; Pool cancel across members with one Pool ending; job/reservation refusals; held/gone; orphan note pruned; `releaseLease` ignores notes.
- `tools/device/claims.mjs` -- add `HUB_REQUEST_NOT_FOUND` (404, exit 2), `HUB_CANCEL_RESERVATION` (409, exit 2), `HUB_WRONG_HOST` (409, exit 2) to the tables; `checkCancelBody`; `requestLocks(resource)`; `cancel(id, input, ctx)` shared by CLI and API returning the `Cancel` answer -- one rule owner.
- `tools/hub-api/routes.mjs` -- `POST /requests/{id}/cancel`, shape `Cancel` -- thin route.
- `tools/device/hub-device.mjs` -- `cancel <id> [--resource R] [--pool P] [--why TEXT] [--holder WHO] [--json]`; locate on this host when `--resource` is absent; print `HUB_DEVICE_CANCELLED <resource> <id>` or JSON `Cancel`; update USAGE/header -- CLI front door.
- `docs/hub-api-contract.md` -- route row, `### Cancel` field list, request body section, error code rows -- contract test parses it.
- `tools/hub-api/contract.test.mjs` -- POST sample for `/requests/{id}/cancel` with a `prepare` hook that starts a live waiter and awaits its rejection -- route set stays covered.
- `tools/hub-api/cancel.test.mjs` -- new: every I/O matrix row through the API, plus CLI/API parity test -- surface-level acceptance.
- `README.md` -- document `hub-device cancel` and `POST /requests/<id>/cancel`, the actor rule and the Pool single-ending rule.

**Acceptance Criteria:**
- Given a waiter on `s24` and an API caller that is not its holder, when it posts `/requests/<id>/cancel` with `resource:'s24'`, then the answer is 200 with the resulting `s24` queue without that waiter, one `cancel` event records the caller's actor and the waiter's own wait ends `HUB_LEASE_CANCELLED`.
- Given the same setup run twice (once via `hub-device cancel`, once via the API), when the answers and event logs are compared ignoring timestamps and `actor.via`, then queues and events are equal.
- Given a phone Pool request waiting in both phone queues, when cancelled with `pool:'phone'`, then no phone queue keeps its ticket and the event log holds exactly one Pool ending for it.
- Given a Hold on a lock, when any cancel is attempted against its holder's lease id, then the owner record is byte-identical afterwards.
- Given `mise run check`, when it runs, then actionlint and all tests pass, including the contract test with the new route.

## Spec Change Log

## Review Triage Log

### 2026-11-25 — Review pass
- verdicts: 35 findings — high 0, medium 2, low 27, false 6, maybe-false 0
- findings:
  - `low` `reject` Blind: two concurrent cancellers of one id can drop each other's note (B's ENOENT dropNote removes A's) — needs a CLI and an API cancel of the same id in the same instant (one service serialises its own, `cancelRequest` is synchronous); the lock-level event still carries A's actor; fix adds an ownership guard.
  - `low` `reject` Blind: a crash between unlink and the lock-level `cancel` event loses the ending — same order and class as `releaseLease`'s waiter cancel (pre-existing pattern); writing first would log a spurious ending on ENOENT.
  - `low` `patch` Blind: the CLI's no-`--resource` lookup listed only `*.queue` dirs, so a held id with no queue answered `unknown` and a Reservation key `unknown` — `queuedLocks` now lists `.queue`, `.lock` and `.reservations` names; tests added in `tools/hub-api/cancel.test.mjs`.
  - `low` `reject` Blind: `HUB_DEVICE_CANCELLED <resource> <id>` is both the waiter's failure marker and the canceller's success line — the spec fixes that marker; exit codes (0 vs non-zero) tell them apart; changing it means editing the spec.
  - `low` `patch` Blind: `Cancel.resource` for a Pool request was the alphabetically first member (`adb`'s Resource for `phone`) — grouped with Edge E7; a Pool request (and the emulator gate) now answers `resource` = its Pool word; contract `### Cancel` and tests updated.
  - `low` `reject` Blind: a Resource on another host answers `unknown` unless the body names `host` — not wrong (nothing waits under it here); a host comparison per Registry record adds a branch for a rare call.
  - `false` `reject` Blind: cancel is not idempotent, a retry gets 404 — the story's AC makes a missing request 404; `unknown` for a request already gone is the contract.
  - `low` `patch` Blind: stale docs (no `HUB_LEASE_CANCELLED` row, `HUB_DEVICE_JOB_ID` "never extends or releases", `cancel()` comment claiming a Host Agent route) — row added, row reworded to "extends, releases or cancels", comment corrected.
  - `low` `reject` Blind: `why`/`holder` have no length cap beyond the 1 MiB body — the same holds for every existing write route's `why`/`holder`; adding caps is a new guard for an unlikely input.
  - `low` `reject` Blind: a note can be pruned while a paused waiter lives (>60 s) — a live waiter polls every `pollMs` (1 s default); `TICKET_ABSENT_MS` is the established absence threshold.
  - `low` `reject` Blind: lease-id regex and lock-name listing duplicated (`lockNames` / `queuedLocks`) — developer-only; no caller diverges today.
  - `low` `reject` Blind: a non-ENOENT unlink error on a later Pool member half-cancels — EPERM/EIO inside the hub's own lock dir; fix needs rollback machinery.
  - `low` `reject` Blind: test gaps (`match:` Pool, API waiter 409, existence-only claims test, real short sleeps, contract `host: 'linux'`) — the contract scratch stubs `hostKey: () => 'linux'` (that part is false); a `match:` ticket takes the same tagged-ticket path as `phone`; the rest names no defect.
  - `low` `reject` Edge: a Pool request granted a member mid-cancel answers `held` while notes remain — the granted request withdraws its other tickets and drops their notes (`acquirePool` withdraw); `held` is the true state; covered by the new race test.
  - `low` `reject` Edge: non-ENOENT throw on a later member (same as Blind B12) — same reasoning.
  - `low` `reject` Edge: crash after unlink before the event (same as Blind B2) — same reasoning.
  - `low` `reject` Edge: orphan notes accumulate where nobody prunes; a reused ticket name inherits a stale note — ticket names carry ms time, a counter and the pid, so reuse cannot happen; the next acquirer's prune removes the note.
  - `low` `reject` Edge: the answer's `queues` omit a member the waiter withdrew itself mid-cancel — cosmetic; the listed queues are correct.
  - `low` `patch` Edge: `cancel <emulator-id> --pool emulator` without `--resource` answered `unknown` — the pool option is now computed per lock (gate: absent or `emulator` → no check); CLI test added.
  - `low` `patch` Edge: `resource` named an arbitrary member for a Pool cancel — grouped with Blind B5; same fix.
  - `low` `reject` Edge: CLI `--resource ''` / `--pool ''` skip the API's body checks — answers `unknown` (exit 2) either way; an unlikely input, and the fix adds guards.
  - `false` `reject` Edge: a malformed id is 404 after reads, contradicting the "name's shape before the Registry" sentence — that sentence is about Registry names on Registry writes; for a cancel an id nothing waits under is `unknown` by the matrix.
  - `low` `reject` Edge: `why`/`holder` length (same as Blind B9) — same reasoning.
  - `low` `reject` Edge: the spec matrix says `HUB_API_BAD_REQUEST` but the code emits `HUB_USAGE` — no `HUB_API_BAD_REQUEST` code exists; every body check uses `HUB_USAGE` and the contract documents it; the fix is a spec edit.
  - `medium` `patch` Verification-gap: the emulator `slotHolding`/`readRecord` `held` fallback was untested — `tools/device/emulator.test.mjs` now cancels the request once it owns `emulator-1` and asserts exit 2 `HUB_REQUEST_NOT_FOUND ... release it`.
  - `low` `patch` Verification-gap: the CLI's id-alone lookup of a Pool request was untested — `tools/hub-api/cancel.test.mjs` now cancels a planted phone Pool request by id alone and asserts both queues empty and `pool: 'phone'`.
  - `low` `reject` Verification-gap (other): a waiter whose ticket a release removed in the note window could read our note — needs a release and a cancel of the same id within microseconds; misattribution only of the error text.
  - `false` `reject` Verification-gap (other): `timedOut` through `cancelled()` names a canceller at the deadline — the ticket was in fact removed by that cancel (`leave` failed), so naming the canceller is correct.
  - `false` `reject` Intent: the CLI has no `--host` — the CLI acts on its own host only; the API checks `host`.
  - `low` `reject` Intent: the host key is optional rather than required for a Pool cancel — Pools never span hosts (`HUB_POOL_CROSS_HOST`) and each service acts on its own host; a given key is checked; no harm named.
  - `false` `reject` Intent: the CLI's missing request is exit 2, not 404 — that is the repo's HTTP-to-exit table.
  - `low` `reject` Intent: the Reservation refusal points at `hub-device reservation release --run`, not a force-release route — that route belongs to a later story; the detail says force-release and names the command that exists.
  - `low` `reject` Intent: the parity test covers the single-lock case only — both front doors call the one `cancel()`; Pool and emulator paths are tested on each door.
  - `false` `reject` Intent: the CLI's lookup without `--resource` goes beyond "body carries resource" — the AC binds the API body; the CLI searches only its own host, never the fleet.
  - `medium` `patch` Intent: the emulator `held` answer depends on state outside the queue and is tested only on the fake gate — grouped with the verification-gap finding; same test added.

## Design Notes

Attribution note: the canceller cannot write the waiter's ending event without racing it, so it leaves `<queue>/<ticket>.cancel` (atomic, `{format:1, cancel:{actor, why, at}}`, no `lease_id`, not `.json` so every reader ignores it), then unlinks the ticket. The waiter, noticing its ticket gone, reads the note and raises `HUB_LEASE_CANCELLED` "cancelled by <holder>" with `reason:'cancelled'` and `cancel:{actor, why}`. Non-Pool: `cancelRequest` itself writes the lock-level `cancel` event (as `releaseLease` does for queued tickets). Pool: no lock-level event; the request's own `settle` writes the one Pool ending with the canceller as actor. If the note's ticket ENOENTs, the canceller removes its own note.

Residual risk: a waiter that dies between cancel and noticing leaves no Pool ending (pre-existing class) and an orphan note, which prune removes.

## Verification

**Commands:**
- `node --test tools/hub-api/cancel.test.mjs tools/hub-api/contract.test.mjs tools/ci/cancel-request.test.mjs` -- expected: all pass
- `heavy mise run check` -- expected: actionlint clean, full suite green
- `git diff main -- tools/ci/lib/eta.mjs` -- expected: empty

## Auto Run Result

Status: done

**Summary.** A waiting request can now be cancelled from both front doors through one Claims call: `hub-device cancel <id>` and `POST /requests/{id}/cancel` both call `cancel()` in `tools/device/claims.mjs`, which calls the one protocol writer `cancelRequest` in `tools/ci/lib/lock.mjs`. One level up (belsky-doctrine): every waiter kind is covered the same way — a single lock, a `phone`/`match` Pool request (removed from every member queue), and an emulator request on the gate. The actor is always recorded; a non-holder may cancel. The canceller writes an attribution note beside the ticket before unlinking it, so the waiter's own wait fails `HUB_LEASE_CANCELLED` "cancelled by <holder>". A single-lock request ends with one lock-level `cancel` event and a Pool request with one Pool-level `cancel` event. An emulator request gets both, as a release does: the gate's lock-level event and the Pool event, each naming the canceller. A Hold is never touched (`404 HUB_REQUEST_NOT_FOUND reason: held`). Job ids and job tickets are refused (`HUB_DEVICE_JOB_ID`), as are Reservation keys (`HUB_CANCEL_RESERVATION`); a wrong `host` gets `HUB_WRONG_HOST`.

**Files changed**
- `tools/ci/lib/lock.mjs` — `cancelRequest` (with an `unlink` test seam); attribution notes read by `acquireLease`, `acquirePool` and `poolRequest.settle`; prune removes orphan notes.
- `tools/device/claims.mjs` — `checkCancelBody`, `requestLocks`, `cancel`; three new codes in the exit and HTTP tables.
- `tools/hub-api/routes.mjs` — `POST /requests/{id}/cancel` (shape `Cancel`); `serviceContext` passes `hostKey`.
- `tools/device/hub-device.mjs` — the `cancel` command, the `--resource` flag, usage text.
- `docs/hub-api-contract.md`, `README.md` — route, `Cancel` shape, body, refusals, error codes, CLI usage.
- `tools/ci/cancel-request.test.mjs` (new), `tools/hub-api/cancel.test.mjs` (new) — lock-level tests, every matrix row through the API and CLI, and CLI/API parity.
- `tools/hub-api/contract.test.mjs` — a POST sample with `prepare`/`after` hooks that start live waiters.
- `tools/device/emulator.test.mjs` — a real (fake-binary) emulator gate cancel, plus the `held` answer once a slot is held.
- `tools/device/claims.test.mjs`, `tools/hub-api/leases.test.mjs` — the export and table pins extended.

**Review findings.** 35 findings from 4 layers: high 0, medium 2, low 27, false 6.
- **Patched (6 entries; 1 medium, 5 low):**
  - The CLI lookup now includes lock and reservation names.
  - A Pool request is answered under its Pool word.
  - The emulator pool option is computed per lock.
  - Stale contract rows and comments are corrected.
  - New tests cover the emulator `held` fallback (medium) and the CLI's id-alone Pool lookup.
- **Deferred:** none.
- **Rejected:** every other finding, each with its reason in the Review Triage Log. They are mostly narrow races or crashes that follow `releaseLease`'s existing pattern, missing length caps that match the other routes, the spec-fixed success marker, and descriptive intent divergences.

**Follow-up review recommended:** false. One medium and five low entries were patched, and no high.

**Verification.**
- `heavy mise run check`: exit 0, actionlint clean, 1358/1358 tests pass. It ran after the implementation, again after the verify fixes, and again after the review patches.
- `node --test tools/hub-api/cancel.test.mjs tools/hub-api/contract.test.mjs tools/ci/cancel-request.test.mjs`: all pass.
- `git diff main -- tools/ci/lib/eta.mjs`: empty.

**Residual risks.**
- **Dead waiter:** a waiter that dies between a cancel and noticing it leaves no Pool ending and an orphan note. Prune removes the note after 60 s. This is the same class as a waiter dying today.
- **Crash after unlink:** a crash between the unlink and the lock-level event loses that ending, the same order as `releaseLease`.
- **Concurrent cancels:** two simultaneous cancels of one id from different processes can drop the attribution note. The lock-level event keeps the actor.
- **No length cap:** `why`/`holder` have no cap beyond the 1 MiB body, as on the other write routes.
