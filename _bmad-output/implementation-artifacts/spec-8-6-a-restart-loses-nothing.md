---
title: 'Story 8.6: A restart loses nothing'
type: 'feature'
created: '2026-11-25'
status: 'done'
baseline_revision: '34271d696979fc998c4ebcd7e825b21e53d32596'
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-8-context.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-8-5-a-change-reaches-subscribers-within-two-seconds.md'
warnings: ['oversized']
deferred: []
---

<intent-contract>

## Intent

**Problem:** FR-23 says a Hub API restart loses nothing (AD-23, AD-37, AD-45). The parts exist: disk-only state, Story 7.2's `SIGTERM` handler, Story 6.11's `heavy` scope, the port-bind singleton and per-boot stream ids. But nothing proves them across a real stop and start. One part is missing: after a crash, `hub-client` reports a connection reset during a wait as `HUB_API_UNKNOWN`, not as `requeue`.

**Approach (`belsky-doctrine`, one level up from "the Hub API survives a restart": every waiting caller of `hub-client`, against any service it calls, which is the Hub API today and the Host Agent in Epic 9).**
- `call()` classifies a reset during a wait as `HUB_API_RESTARTING` with `retry: 'requeue'`, the same answer a `SIGTERM` gives. It exports `requeueable(error)`, so every caller decides to re-place a wait from one predicate.
- A new `tools/hub-api/restart.test.mjs` proves each AC across two service instances that share the same temp dirs. Real sockets and child processes are used where the AC is about the wire.

## Boundaries & Constraints

**Always:**
- Node 24 ESM `.mjs`, `node:` builtins only.
- Tests call `hermetic()`. A test that needs real loopback HTTP uses a fetch captured before `hermetic()`, wrapped so it only reaches `http://127.0.0.1:<the test's own ephemeral port>/`. Anything else throws.
- Child services run from an inline `--input-type=module` script that calls `startHubApi`. The script injects a policy with `api.hub_api_port: 0`, `observe` (a faked host, so there is no `/proc` or adb gather, track or watcher), `hostKey: () => 'linux'`, `onPath: () => true`, and an env of temp `HOME`, `HUB_LOCK_DIR`, `HUB_EVENT_DIR`, `HUB_QA_DEVICES` and `PATH`. The child prints `HUB_API_LISTEN port=<n>`, and the test reads the port from that line.
- `hub-client.mjs` `call()`: when `waitMs > 0` and the request transport fails with a reset, it throws `{code: 'HUB_API_RESTARTING', exit: 1, reason: 'restarting', retry: 'requeue', api: false}`.
  - A reset is `error.code` or `error.cause.code` in `ECONNRESET`, `EPIPE`, `UND_ERR_SOCKET`, `UND_ERR_CLOSED`.
  - The message says the service went away during the wait and to place it again with the same id.
  - Every other failure keeps its current code: a refused connect is `DOWN`, the client's own timeout or abort is `UNKNOWN`, and a reset on a write with no wait is `UNKNOWN`.
- `hub-client.mjs` exports `requeueable = error => error?.retry === 'requeue'`.
- `claims.test.mjs`: the hub-client-errors-equal-the-exit-table check covers the new `HUB_API_RESTARTING`.

**Never:**
- Change a route, a response key, `CONTRACT_VERSION`, the on-disk layout, an event key, `policy.json`, the unit file, `AGENTS.md`/`CLAUDE.md` or `sprint-status.yaml`. The deploy path never imports `hub-client.mjs`.
- Bind port 8794, reach the live build bucket, open a real systemd scope, or read the real adb server or host-key file.
- Retry inside `call()`. Requeue is the caller's decision, and it is safe because a repeated wait `id` from the same holder returns the existing Lease (AD-48).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Disk survives | Instance A (fake server) records: a registered phone (`POST /registry/resources`), an API Lease on `s24` (`POST /leases`, 47 h), a Job Hold on `adb` (`withLock`, fake timers, held across the restart), and run Y's Reservation on `adb` (`reserve`). Then SIGTERM, the clock moves 3 h, and instance B starts on the same dirs | Every file under the lock dir, plus `registry.json`, is byte-identical after A's stop and again after B's start (recovery and seed included). B's `/status` shows the Lease, the Job Hold and the Reservation, and B's `/resources/<id>` shows the phone | — |
| SIGTERM mid-wait | A real child API; the test holds `s24`; `call()` POSTs a wait (`id` w-1, `wait_ms` 30 s); then `SIGTERM` to the child | `call` rejects `HUB_API_RESTARTING`, `retry: requeue`, `api: true`; `requeueable` is true; the child exits 0; the ticket is withdrawn (`cancel`, `reason: aborted`) | — |
| Crash mid-wait | Same, but `SIGKILL` | `call` rejects `HUB_API_RESTARTING`, `retry: requeue`, `api: false`; the dead pid's ticket is still on disk | — |
| Requeue after a crash | A new child on the same dirs; `call()` again with the same `id`; the test frees `s24` | 200 with `lease_id` w-1; the dead ticket is `prune`d; one Lease | — |
| Client only | Fakes: wait + `ECONNRESET` / `UND_ERR_SOCKET`; wait + own timeout; wait + refused; no-wait write + reset | `RESTARTING`/requeue, `UNKNOWN`, `DOWN`, `UNKNOWN` | — |
| Emulators survive | The emulator fixture env (ports 25200-25299 / 5800-5898); instance A grants an emulator Lease through the listener; SIGTERM | `heavy.log` names the emulator launch; every recorded emulator and adb pid is alive; the record and the slot owner are unchanged; instance B's `GET /leases/<id>` is 200 for the same Lease; then release, and every pid is gone | — |
| Unit directives | `tools/hosts/units/mobile-deploy-hub-api.service` and `tools/device/emulator.mjs` source | `KillMode=mixed`, `Restart=on-failure`, no `ExecStop`/`ExecStopPost`/`KillMode=control-group`. The only `detached: true` spawn in `emulator.mjs` is in `launch`, which spawns `bootCommand`'s result | — |
| Second API | A runs with real `createServer` on ephemeral port P; B starts with policy port P | B rejects `HUB_API_ALREADY_RUNNING` exit 1, prints no LISTEN line and writes nothing new; A still answers `GET /health` 200 `hub-api` over loopback | — |
| Stream after restart | A subscriber on A has `Last-Event-ID` `<bootA>-0`; A stops; B starts (default `createStream`) | The reconnect to B gets `reset`, `reason: unresumable`, an id `<bootB>-0` where bootB ≠ bootA, and the whole `/status` | — |

</intent-contract>

## Code Map

- `tools/hub-client.mjs` `call()` (L68-94) -- the transport `catch` maps `refused(error)` to DOWN and everything else to `unclear()`. Add the reset-during-wait branch before `unclear()`. `bounded()` rejects with `signal.reason` (a TimeoutError or the caller's Error) on the client's own abort, which is never a reset. There is no claims import here, so the exit code `1` is written literally, like DOWN and UNKNOWN.
- `tools/hub-client.test.mjs` -- `fake(routes)`, `healthy`, `code()`, `clock()` (L120-185). The existing "reset on a write is UNKNOWN" row stays true because it has no `waitMs`.
- `tools/device/claims.test.mjs` L460-476 -- registryWrite DOWN/UNKNOWN exit checks; add a direct `call()` wait-reset check against `EXIT_CODES.HUB_API_RESTARTING` (L71 in claims.mjs is 1).
- `tools/hub-api/server.mjs` `startService` (L119-169: bind → EADDRINUSE → `HUB_API_ALREADY_RUNNING`, then the SIGTERM `stop`: `onStop` → `waits.shutdown()` → `drain` → close) and `startHubApi` (L189-261: `faked` when `observe` is given; `stream` defaults to `createStream` with a fresh `mintBoot()`). Read-only for this story.
- `tools/hub-api/waits.test.mjs` L22-90 -- the `scratch`, `clockOf`, `exchange`, `start`, `BODY`/`WAIT` harness. L468-507 is the in-process SIGTERM proof that this story extends to the wire.
- `tools/hub-api/stream.test.mjs` L436-470 -- the `boot()` FakeServer and `open`/`call`/`parse` helpers for the stream rows.
- `tools/hub-api/emulator-lease.test.mjs` L30-60 and L373-403 -- the `service()` emulator fixture wrapper, `waitFor`, `gone` (`liveStart(pid) === null`), and an inline child-script pattern (`spawn(NODE, ['--input-type=module', '-e', script])`).
- `tools/device/emulator-fixtures.mjs` `fixture()` -- the fake adb/emulator/avdmanager and the heavy shim (`heavyLog()`), `record`, `owner`, `clean`, `cleanup`.
- `tools/hub-api/register.test.mjs` L26 `PIXEL` -- a valid register body.
- `tools/ci/lib/lock.mjs`:
  - `withLock` (L348) takes a `timers` seam; the job identity comes from `GITHUB_*` in its `env`.
  - `reserve` (L922) needs `GITHUB_REPOSITORY` and `GITHUB_RUN_ID` in its env.
  - `acquireLease`, `releaseLease`, `readOwner` and `lockDir`.
  - The service strips `GITHUB_*` from its own env (`withoutDeployIdentity`), so the test passes the job env directly to `withLock` and `reserve`.
- `tools/hosts/units/mobile-deploy-hub-api.service` and `tools/device/emulator.mjs` `launch`/`bootCommand` (L457-485) -- read for the static checks. `tools/hosts/hosts.test.mjs` L82 already checks the unit's basic directives, and this story adds the restart-specific ones.
- `docs/hub-api-contract.md` L379 and L513 (`HUB_API_RESTARTING` rows) and L440 (the SIGTERM sentence); `README.md` L340 (the Hub API paragraph, one sentence per story).

## Tasks & Acceptance

**Execution:**
- [ ] `tools/hub-client.mjs` -- the reset-during-wait branch, `RESTARTING_MESSAGE`, `requeueable` and header comment -- a crash reads as requeue for every waiting caller
- [ ] `tools/hub-client.test.mjs` -- the "Client only" rows, `requeueable` on a problem error and on a client error
- [ ] `tools/device/claims.test.mjs` -- the exit-table check for the new client error
- [ ] `tools/hub-api/restart.test.mjs` (new) -- every other matrix row (two instances over the same temp dirs; real loopback and child processes for the SIGTERM, crash, requeue and second-API rows) -- AC1-AC5
- [ ] `docs/hub-api-contract.md`, `README.md` -- the client's requeue on a reset, and one sentence naming what a restart keeps
- [ ] verification -- `heavy mise run check`

**Acceptance Criteria:**
- Given a restart of any length, when one handler instance stops and another starts over the same temp dirs, then every Lease, Job Hold, Reservation and Registry entry written before it is byte-for-byte unchanged and served by the new instance.
- Given a wait through the API, when the service gets `SIGTERM`, then the `hub-client` caller gets `503 HUB_API_RESTARTING` with `retry: requeue`; and when it crashes instead, the caller's `hub-client` gives `HUB_API_RESTARTING` with `retry: requeue`, and re-placing the same id after the restart is granted exactly one Lease.
- Given emulators the service started, when it restarts, then they keep running, which is shown by the unit's directives, the spawn seam and a live fake emulator surviving the stop.
- Given a running Hub API, when a second starts on its port, then the second exits `HUB_API_ALREADY_RUNNING` and the first still answers.
- Given a stream subscriber, when the service restarts, then a reconnect with the old `Last-Event-ID` gets `reset` with `reason: unresumable`.
- Given HEAD, when `heavy mise run check` runs, then it is green.

## Spec Change Log

## Review Triage Log

### 2026-11-26 — Review pass
- verdicts: 23 findings — high 0, medium 0, low 15, false 8, maybe-false 0
- findings:
  - `low` `reject` `requeueable` has no consumer in the diff — no in-repo waiting `hub-client` caller exists yet; the contract doc states the predicate, and wiring a caller is Epic 9 work, not a direct correction.
  - `low` `patch` The `checkLeaseId` change to ignore stale tickets has no direct unit test — added "checkLeaseId: a ticket naming the id throws for a live pid, and not for a dead pid or a reused one" in `tools/device/claims.test.mjs` (dead pid, live pid with own start, live pid with no start, live pid with a different start).
  - `false` `reject` Crash after the grant is untested — `serviceLease` → `heldLease` answers a same-holder repeat before `take`/`checkLeaseId` runs, and the existing waits tests cover the repeated id.
  - `false` `reject` No proof for a crash during a disk write — `writeFileAtomic` renames into place and `recoverRegistry` (Story 6.2) handles leftovers; a torn write cannot occur at the cited code.
  - `low` `reject` "Byte-for-byte" overstates what the test asserts — the test compares every file's bytes, which is accurate; time-derived response fields are re-derived by design and are not state.
  - `low` `reject` The source grep for `detached: true` is brittle — the spec mandated this static check, and the `heavy.log` assertion covers the behaviour independently.
  - `low` `reject` Fixed emulator ports and sleeps in the restart test — follows the existing per-suite port convention; the disk is quiet after start with a faked host and cleanup is idempotent.
  - `false` `reject` The reset classification is broad with no guardrail — the `/health` probe turns a dead service into DOWN, which ends any requeue loop, and a server never closes an open wait except when it dies.
  - `low` `reject` `api: false` sits oddly in the server error table row — cosmetic wording in the doc table; no caller misreads it.
  - `low` `patch` README length and test nits, including a no-op `Object.assign(new DOMException(...))` wrapper — removed the no-op wrapper in `tools/hub-client.test.mjs`; the remaining nits follow existing file patterns and were not changed.
  - `false` `reject` Pid reuse blocks requeue after a crash — `ticketStaleness` returns `pid-reused` on a `process_start` mismatch, so the reused pid's ticket is stale and ignored (now covered by the new unit test).
  - `low` `reject` The stale-ticket exemption applies to any holder — after any prune the id is already free, so ignoring a stale ticket exposes nothing a take would not.
  - `low` `patch` An emulator request a crash cut short mid-boot keeps its id refused — narrowed the crash/requeue sentence in `docs/hub-api-contract.md` and `README.md` to phone waits and stated that an emulator id stays taken until the next emulator reap (holder gone); a code branch for this rare case was not added.
  - `low` `reject` A requeue placed before the new service is up gets DOWN — DOWN correctly means "not back yet"; when to retry is the caller's policy.
  - `low` `reject` Truncated-response error codes are unclassified — a wait writes nothing until its outcome, so there is no partial body to misread.
  - `low` `reject` A hung service makes the wait time out as UNKNOWN — the spec chose that the client's own timeout stays UNKNOWN; it is not a reset.
  - `low` `reject` `requeueable` has no caller (edge layer restatement) — same as the first row.
  - `low` `reject` No end-to-end requeue after SIGTERM over the wire — the waits test (request, cancel aborted, request, acquire) already covers it in process, and the SIGTERM wire row proves the 503.
  - `low` `reject` The smoke `apiCaller` uses raw fetch, not `hub-client` — it is a live one-shot check that never spans a restart.
  - `false` `reject` The `KillMode=mixed` runtime effect is unproven hermetically — inherent to hermetic tests; the spec proves it by the unit directive, the spawn seam and a live fake emulator surviving the stop, which is what the AC asks.
  - `false` `reject` Tests exercise the in-process or faked surface, not the live installed service — the live `hosts:install` and `curl` check is Story 8.7, and the hermetic rule forbids touching the live service here.
  - `false` `reject` `checkLeaseId` in `claims.mjs` is a surface outside the Code Map — the spec's "Requeue after a crash" matrix row requires the id to be grantable, and the Never list does not exclude it.
  - `low` `reject` Classification only, with no automatic requeue — same as the first row; the spec's Never list forbids retrying inside `call()`.

## Design Notes

Why the client reports a crash as `HUB_API_RESTARTING`, not as a new code: a caller has one branch for "place the wait again" (`requeueable`), whether the service said so (SIGTERM, `api: true`) or went silent mid-wait (`api: false`). Requeue is safe even if the crash came after a grant. The repeated `id` from the same holder returns the existing Lease (AD-48), and if the crash came before the grant, the dead pid's ticket is pruned by the next take. A no-wait write that resets keeps `UNKNOWN`: it may have applied, and no id makes the repeat safe.

Why real sockets for three rows: "the first is unaffected" and "the caller gets 503" are claims about the wire. A fake server cannot show that the kernel refused the second bind, or what undici sees when the process dies. These sockets are ephemeral loopback ports the test owns, so the tests stay hermetic.

## Verification

**Commands:**
- `node --test tools/hub-api/restart.test.mjs tools/hub-client.test.mjs tools/device/claims.test.mjs` -- expected: all pass
- `heavy mise run check` -- expected: green

## Auto Run Result

**Status:** done

**Summary:** A Hub API restart now provably loses nothing (FR-23). `hub-client` `call()` classifies a connection reset during a wait as `HUB_API_RESTARTING` with `retry: 'requeue'` and `api: false`, matching what a `SIGTERM` returns, and exports one `requeueable(error)` predicate for every waiting caller of any hub service (the Hub API now, the Host Agent in Epic 9). `checkLeaseId` ignores a dead process's waiter ticket, so the same id can be placed again after a crash and gets exactly one Lease. A new `tools/hub-api/restart.test.mjs` proves each AC across two service instances on the same temp dirs, using real loopback sockets and child processes for the wire rows.

**Files changed:**
- `tools/hub-client.mjs` — adds the reset-during-wait branch, `RESTARTING_MESSAGE`, the `RESET_CODES` set, the `requeueable` export, and an updated header comment.
- `tools/device/claims.mjs` — `checkLeaseId` skips stale waiter tickets (dead pid or reused pid).
- `tools/hub-client.test.mjs` — the "Client only" rows (each reset code, own timeout, refused, no-wait reset) and `requeueable`.
- `tools/device/claims.test.mjs` — the exit-table check for the new client error, plus a direct `checkLeaseId` stale-ticket unit test.
- `tools/hub-api/restart.test.mjs` (new) — 7 tests: disk survives, SIGTERM mid-wait, crash and requeue, emulators survive, unit directives and spawn seam, second API, and stream after restart.
- `docs/hub-api-contract.md` — the client-side `HUB_API_RESTARTING` (`api: false`) and the crash/requeue rule for phone waits, including the emulator caveat.
- `README.md` — one sentence on what a restart keeps (Story 8.6).

**Review findings breakdown:** 23 findings in total: high 0, medium 0, low 15, false 8.
- Patched, 3 entries (all `low`):
  - a `checkLeaseId` unit test;
  - removal of the no-op DOMException wrapper;
  - the emulator mid-boot caveat in the contract and README.
- Deferred: 0.
- Rejected, with reasons:
  - **`requeueable` has no consumer, and there is no automatic requeue** (3 rows). No in-repo waiting caller exists yet, and the spec forbids retrying inside `call()`.
  - **"Byte-for-byte" wording.** It is accurate about the files.
  - **Brittle source grep.** The spec mandated it, and `heavy.log` covers the behaviour.
  - **Fixed ports and sleeps.** They follow the existing suite convention.
  - **`api: false` in the doc table.** Cosmetic.
  - **The stale exemption applies to any holder.** Once a ticket is pruned the id is already free.
  - **A requeue placed before the restart gets DOWN.** That is the correct answer.
  - **Truncated responses.** A wait writes nothing until its outcome.
  - **A hung service gives UNKNOWN.** The spec chose this.
  - **No wire-level requeue after SIGTERM.** The in-process waits test covers it.
  - **The smoke `apiCaller` uses raw fetch.** It never spans a restart.
  - **False findings (8).** Crash after the grant, a crash during a write, a broad classification, pid reuse, the KillMode runtime, the live surface (that is Story 8.7), the unlisted `checkLeaseId` surface, and the remaining VG2 row.

**Follow-up review recommended:** false. This was the first pass, and it patched high 0, medium 0, low 3.

**Verification:**
- `node --test tools/hub-api/restart.test.mjs tools/hub-client.test.mjs tools/device/claims.test.mjs`: 50/50 pass.
- `heavy mise run check`: exit 0, with 1602 tests: 1602 pass, 0 fail, 0 skipped, 0 cancelled.

**Residual risks:**
- `requeueable` has no in-repo consumer yet. The first waiting caller, likely the Epic 9 Host Agent, must use it.
- An emulator request that a crash cut short mid-boot keeps its id taken until the next emulator reap ("holder gone"). The caller places it again with a new id, as the docs say.
- Nothing has been run against the live installed service. `KillMode=mixed` is proven only by the unit directive and a fake emulator. The live `hosts:install` and `curl` verification is Story 8.7.

**Operator actions:** none. Every AC is in-repo.
