---
review: reconcile-prd
target: ARCHITECTURE-SPINE.md (v1a, draft 2026-11-23)
against: prds/prd-mobile-deploy-hub-2026-11-21/prd.md (final 2026-11-23), §7.1 v1a scope
evidence: reviews/brownfield-sweep.md, code at v1.2.43 (lock.mjs, hub-device.mjs, emulator.mjs, lease.test.mjs)
date: 2026-11-23
---

# PRD ↔ Spine reconciliation (v1a)

**Verdict: PASS WITH REVISIONS.** The spine lands the shape of every v1a requirement: one protocol owner, an additive on-disk layout, a frozen ticket, coded timeouts that keep the old wording, timestamp-bound Reservations, the Peek, Android pending-not-red, the 60-minute cap, and a pure ETA. Nothing is critical. Four high findings need fixing before epics. Three of them sit in things that freeze or accrue from day one: the ticket liveness rule, the Event Log fields and what the Event Log covers. History written without those fields can never be backfilled, and a frozen pruning rule can never be fixed. One requirement is contradicted openly rather than silently: FR-30 on iOS (spine OQ1). It needs Jarad's decision.

Legend: **LANDS** = an AD satisfies it, **PARTIAL** = lands with a gap, **DROPS** = silently missing, **CONTRA** = the spine contradicts it, **DEFER-OK** = PRD §7.1 puts it in v1b/v1c and the spine defers it consistently.

## 1. Requirement matrix

### FR-7 First come, first served

| Consequence | Status | Where / gap |
| --- | --- | --- |
| New-pin deploy job waiting before a Lease is served first, and vice versa | LANDS | AD-4 (withLock on QUEUED joins the FIFO), AD-6 (file-name order, only the head may mkdir) |
| Free Resource with an empty Queue is taken at once | LANDS (implicit) | AD-6. Not stated in those words; see F-5 for the post-grace head case, which the wording contradicts |
| Catch-up waits as a hub job; its short attempt is recorded as hub-job, never deploy or starved | LANDS | AD-15 (`kind: hub-job`), event `claimant.kind`. But the claimant taxonomy is mixed up with the hold kind (F-4) |

### FR-8 Deploy jobs stand in the Queue

| Consequence | Status | Where / gap |
| --- | --- | --- |
| status `--json` / Hub API / Control Surface list a waiting deploy job with its position | PARTIAL | AD-17 covers `--json` keys and AD-6 covers position. Hub API and Control Surface are DEFER-OK. `mac-ios` waiters can be seen only from the Mac in v1a; the spine never says so (F-13) |
| Text status shows repo, run and job, **never `undefined`** | PARTIAL | AD-17 adds a job-waiter section for new readers. AD-3's frozen body has `id`, not `lease_id`, and the installed `hub-device` (old until `hosts:install`) prints `waiter.lease_id` unguarded (`hub-device.mjs:553`), so it prints `undefined` for every job ticket during roll-out (F-2) |
| A new-pin job never loses its place to a later arrival; only older pins can overtake | PARTIAL | AD-6 and AD-7. Old installed `hub-device` (v1.2.26–43 `acquireLease`) ignores `.reservations/` and can overtake a Reservation. NFR-2 only licenses *older pinned runs* to overtake (F-2 fix: make `hosts:install` part of the v1a release) |
| Wait ends ≥ 2 min before job timeout, measured from job start | LANDS | AD-12 (margin plus hold allowance, `HUB_JOB_TIMEOUT_MINUTES` with a conformance test, start from the Runner.Worker ancestor). Gap: behaviour when the deadline is already past on entry (a long android build) is unstated. It should be one try, then `HUB_LOCK_TIMEOUT` (F-17) |
| Timeout keeps `host lock <name> is held` wording | LANDS | AD-5. But AD-5 also rewords `acquireLease`'s queued-ahead message, which FR-13 does not name and `lease.test.mjs:203` pins (F-8) |
| Only Registry Resource locks queue; `s3-*`, `s3-index`, `emulator-reaper` unchanged and write no events | LANDS | AD-4 (explicit `QUEUED` constant), AD-9 last bullet. But the emulator Pool's real queue, the `emulator` gate, falls outside `QUEUED` (F-3) |

### FR-9 Reservation across a run's jobs

| Consequence | Status | Where / gap |
| --- | --- | --- |
| Plan Peeks under a Lease, does not wait behind its own Reservation, still waits for another deploy's Job Hold | LANDS | AD-13 and AD-7 (same-run passthrough). Plan's behaviour when that wait times out (red before the bump) is unstated; brownfield `jobs` risk 191 |
| Same-run Job Holds never wait behind the run's Reservation; iOS's two takes both use it | PARTIAL | AD-7 passthrough by `GITHUB_REPOSITORY` + `GITHUB_RUN_ID`. "Releases it in `finally`" does not say whose `finally`: `withLock`'s finally after the first `mac-ios` take would drop the Reservation before the store-IPA take (`ios.mjs:390`). It must be the command's `finally` after its last take (F-16) |
| Free Resource waits the grace period **once** for a head Reservation; then the next Claimant is served; the Reservation keeps its place | PARTIAL | AD-7 grace. The PRD says the grace is stored in the Reservation record; the spine stores only `grace_started_at` and reads the duration from each version's policy. The stamp is a rewrite that can race, giving two graces or bringing back a released Reservation. AD-6's "only position 0 may mkdir" contradicts "never blocks a free Resource again" (F-5) |
| Ends at the last Job Hold, at the final job's release, or at 3 h | PARTIAL | AD-7 and AD-11 (ceiling 180). Nobody is assigned to unlink an *expired* Reservation or write its `expiry` event, so files left by a failed announce or an offline Mac accumulate (F-10). The gate reserves `adb` unconditionally, and a lane that plan flips to skip leaves the Reservation idling a free Resource for grace (F-11) |
| A rerun reuses a live Reservation; after it ends, the rerun queues as a new arrival | LANDS (implicit) | AD-7 ("if a live one exists for the run, it is reused"; passthrough finds none once released). Worth one explicit line and a test |

### FR-12 (v1a part: the `ios-lane` Queue)

| Consequence | Status | Where / gap |
| --- | --- | --- |
| `lease ipad` / `lease mac` take the ios-lane | DEFER-OK | Spine Deferred (v1b, needs the Mac Host Agent) |
| iOS jobs and the iPad catch-up share one FIFO; needs only the queue code on the Mac | LANDS | AD-15, AD-1, AD-8 (host_id against mDNS drift) |
| Every ios-lane Queue timestamp is Mac clock | LANDS | Conventions "Timestamps"; AD-7 (preflight-ios writes on the Mac; announce releases over ssh, so the release event is also written on the Mac) |
| Mac unreachable → `offline`, Lease fails `HUB_DEVICE_AWAY` | DEFER-OK | v1b |

### FR-13 CLI compatibility

| Consequence | Status | Where / gap |
| --- | --- | --- |
| Existing suites pass except named changes (phone ordering, `HUB_LOCK_WAIT`, additive `--json`) | PARTIAL | AD-17. AD-5's rewording of the queued-ahead timeout (`has N waiter(s) ahead of lease <id>`) breaks `lease.test.mjs:203` and changes the `HUB_DEVICE_BUSY` stderr text, and FR-13 names neither (F-8). `leaseSupport()` greps the installed `lock.mjs` for `export async function acquireLease`, pinned by `hub-device.test.mjs:772-790`; no AD keeps that literal (F-18) |
| Hub API stopped: `lease s24` works and shows in the API later | DEFER-OK / vacuous | No Hub API in v1a |
| `status` stays read-only (no lock-dir or Event Log writes) | LANDS | AD-9 ("status and every read-only path write nothing"), AD-7 ("read-only paths compute grace but never stamp it"). `events/` is created by writers only, so the readdir before/after test (`:878`) holds |

### FR-15 ETA

| Consequence | Status | Where / gap |
| --- | --- | --- |
| Range = IQR of matching past holds, combined along the Queue | LANDS | AD-18 |
| Job Hold length from past holds of the same repo and job | LANDS | AD-18 |
| Lease expected end = start + **median** used share of stated duration for the same **Claimant kind**, **never later than expiry** | DROPS (3 parts) | AD-18 says "Leases by kind times the share". The expiry clamp is missing. "Kind" there is the hold kind (`lease`), not the Claimant kind (agent or person). The event shape has no stated duration or `expires_at`, so the used share cannot be computed from history at all (F-4) |
| Low data: widen to stated durations or job timeouts and flag | PARTIAL | AD-18 widens and flags, but tickets and owners carry no job timeout or deadline for jobs *ahead*, so a waiter cannot widen to their timeouts. The threshold of 20 (glossary: one threshold for ETA and Capacity) is not pinned in the AD-11 policy block (F-4, F-19) |
| ETA given at enqueue recorded in the Event Log | PARTIAL | AD-18 stores it in the ticket and the `request` event. For Reservation-backed Job Holds the spine never says which time is "enqueue", so `waited_ms` and the SM-4 comparison are undefined (F-4) |

### FR-16 ETA where Claimants look

| Consequence | Status | Where / gap |
| --- | --- | --- |
| `HUB_LOCK_WAIT <lock> held by <holder> position=<n> eta=<range>` | LANDS | AD-17 |
| Printed on a position change or an ETA move of more than 1 min, not every poll | CONTRA (internal) | AD-17 prints on an ETA move. AD-18 recomputes **only** at enqueue and on a position change, so an ETA can never move without a position change. A Lease ahead that overruns (UJ-1 edge case) never updates the line (F-9) |
| (§7.1) Position and ETA in `hub-device status` | DROPS | AD-18 lists "status" under Binds, but AD-17's status sections carry no ETA, and nothing says whether status shows the stored enqueue ETA or a live one (F-9) |
| `hub-device lease --wait` prints them on stderr | PARTIAL | Holds for `s24` and `s26`. `lease emulator --wait` waits on the `emulator` gate (not QUEUED, so no ETA). `phone` is a ticketless try, so it gets no position or ETA. The second is acceptable until FR-6 (v1b), the first is not (F-3) |

### FR-17 Event Log

| Consequence | Status | Where / gap |
| --- | --- | --- |
| Exact event sequences in tests: full deploy run, Lease, **emulator Lease**, pending delivery, timed-out wait | PARTIAL | The tests row says "one test per AD's Rule", not these five sequence tests. The emulator-Lease sequence cannot come out right: the wait happens on the `emulator` gate, outside QUEUED, and slot takes are tries that emit only `acquire`, so there is no `request` and `waited_ms` ≈ 0 (F-3). There is no transition → event table, for example which step writes `claim` or `expiry`, or what a Reservation emits (F-10) |
| Event write never fails an acquire or release | LANDS | AD-9 (`HUB_EVENT_LOG_FAILED`, the transition proceeds) |
| A reclaim records last-known-alive so `held_ms` is not inflated | PARTIAL | AD-19 (the holder touches `owner.json` mtime each minute; the reclaim records it). That holds only when a hub process stays alive for the Hold. `hub-device lease` exits after printing exports (`hub-device.mjs:304-325`), so pid- or expiry-bound Leases are never touched. Their `last_alive_at` would be the acquire time, which **deflates** `held_ms` to about 0. Also, `stale()` stats the *directory* mtime (`lock.mjs:44`); the reclaimer must stat `owner.json` (F-12) |
| Fields: Resource, Claimant (kind, holder, repo, run, job), hub version, times, `waited_ms`, `held_ms`, ETA at enqueue, reason | PARTIAL | Conventions "Event shape" and AD-10. Claimant kind conflated with hold kind; no `enqueued_at` / `started_at` / `expires_at` (F-4) |

### FR-30 Pending, not red

| Consequence | Status | Where / gap |
| --- | --- | --- |
| Run green for the platform, delivery pending, blocking Holds named in the summary and the Event Log | PARTIAL (Android) / CONTRA (iOS) | AD-14 sends the Holds to the receipt and the Event Log, **not the run summary** (F-15). iOS stays red on contention (spine OQ1), stated openly as a deviation |
| Catch-up installs the pending build once the Resource frees, **in its turn in the Queue** | PARTIAL | AD-15 gives the catch-up a few-second attempt every 120 s or 300 s, so it re-arrives at the back each pass. Back-to-back Leases and deploys can starve a pending install indefinitely (brownfield `pending` risk 98) (F-6) |
| Installed version moved above planned → refused as today, version not reused, refusal names who installed it if known | DROPS | No AD. For a contention-pending build the refusal happens in the catch-up, whose `ahead` path writes `skipped` with `event:false` and no name (`catchup.mjs:148,377,656`). AD-13 names only the deploy-time guard (`android.mjs:126`) (F-6) |

### FR-31 No extension while others wait

| Consequence | Status | Where / gap |
| --- | --- | --- |
| Refusal names the waiters and positions | LANDS | AD-16 and AD-5 (`HUB_LEASE_EXTEND_REFUSED`) |
| Jarad's override, recorded with who and why | DEFER-OK | Deferred with FR-10 and FR-11. Note that no `extend` verb exists in v1a, so FR-31 is vacuously true until v1b |
| Deploy-target Lease ≤ 60 min | PARTIAL | AD-16 caps in `extendLease` and at the CLI (exit 2). It is not enforced in `acquireLease`, so the library, the emulator path and the v1b Hub API can take a 48 h Lease on `adb` (contradicts AD-1). Old installed `hub-device` still allows 48 h until `hosts:install` (F-7) |

### NFRs

| NFR | Status | Where / gap |
| --- | --- | --- |
| NFR-1 one implementation; layout has a format version and written compatibility rules | LANDS | AD-1 and AD-2. Brownfield conflicts AD-1 leaves unnamed: `emulator.mjs:329-332` parses gate tickets by hand, and `emulator.mjs` writes `emulators/` and `emulator-pool` under `HUB_LOCK_DIR` outside `lock.mjs` (F-18) |
| NFR-2 pins keep working; a Reservation is never an owner; the ticket freezes at v1a with a remote kind; switch points; release states the fairness limit | PARTIAL | AD-2, AD-3, AD-7 and the roll-out note. **AD-3's liveness rule is ambiguous in a way that freezes badly** (F-1). The release-notes statement of the fairness limit is not assigned to anything (F-19) |
| NFR-3 no new clock | LANDS | AD-19. Gap: nothing assigns cleanup of expired Reservations to callers (F-10) |
| NFR-4 Node only | LANDS | Stack table and Layer table |
| NFR-5 hermetic tests | PARTIAL | Seams row. AD-12's job start reads the process tree (`/proc` or `ps`), which has no seam in the list. `hostId` is a seam, which is good (F-17) |

## 2. Findings

Each finding gives a severity (critical, high, medium or low), the AD it touches, the PRD clause it fails, and a concrete fix.

### F-1 [high] AD-3: the liveness precedence is ambiguous, and an unknown kind with no expiry lives forever. Both get frozen.

- **PRD:** NFR-2 ("the ticket format freezes … every later rerun of that pin prunes by its rules"), FR-8 (nobody waits behind a ghost; UJ-2 edge case).
- **Gap:** AD-3 gives two rules: a pid rule, and "`remote` and any kind this version does not know is live until `expires_at`, and live with no `expires_at`". Two cases are left open.
  - **Tickets without a `kind`.** Every ticket that v1.2.26–43 `hub-device` writes has no `kind` (`lock.mjs:205`), and those installs run until `hosts:install`. An implementer who treats a missing kind as "a kind this version does not know" makes a dead legacy waiter **immortal**. With "only position 0 may mkdir" (AD-6), that is a permanent block with no reaper, because NFR-3 forbids one.
  - **A ticket that carries a pid *and* is `remote` or unknown.** The precedence is unstated. If the pid rule wins, a v2 remote ticket from another host is judged foreign and pruned, which defeats the reason for freezing the format in v1a.
  - A v2 bug that writes a remote ticket without `expires_at` blocks the Queue forever, under a rule frozen for every later pin.
- **Fix:** state the frozen rule as an ordered decision.
  1. No `kind`, or `kind ∈ {lease, job, hub-job}`: the pid rule (with AD-8's same-host test). Off-host means stale for kindless tickets (today's rule); off-host `job` or `hub-job` also means stale.
  2. `kind = remote` or unknown: live while `now < expires_at`.
  3. `remote` or unknown with no valid `expires_at`: stale once `enqueued_at + policy.queue.reservation_ceiling` has passed. That bounds the damage without a reaper.
  - Add three table tests: a kindless legacy ticket, a remote ticket with a foreign pid, and an unknown kind with no expiry.

### F-2 [high] AD-3 / AD-17: old installed `hub-device` prints `undefined` for job tickets, and an old `hub-device` can overtake Reservations.

- **PRD:** FR-8 ("Text status shows its repo, run and job, never `undefined`"; "only runs pinned to older versions can still overtake it"), NFR-2 (`hub-device` switches at `hosts:install`).
- **Gap:**
  - AD-3's frozen body has `id`, not `lease_id`. The installed `hub-device` interpolates `waiter.lease_id`, `holder` and `why` unguarded (`hub-device.mjs:553`), and keys `--id` uniqueness and `release <id>` on `lease_id` (`:129-135`, `:385`).
  - The spine's own roll-out lets new-pin deploy jobs write job tickets before `hosts:install` moves `hub-device`, so every status in that window prints `undefined`.
  - The same old `hub-device` (v1.2.26–43 `acquireLease`) ignores `.reservations/` and overtakes Reservations. NFR-2 does not license that, because it is not an older *pinned run*.
  - In the new `hub-device`, AD-17's separate job-waiter section needs the existing WAITERS section to exclude job tickets, and that is not stated.
- **Fix:**
  - Job and hub-job tickets also write `lease_id` with a synthetic id that cannot match the lease-id regex `/^[a-z0-9][a-z0-9-]{0,63}$/`, for example `<repo>#<run>.<attempt>/<job>` (it contains `#`), so no `--id` or `release <id>` can collide. Always set `holder` (`<repo>#<run>/<job>`) and `why` (`deploy <job>` / `catch-up <platform>`).
  - The new WAITERS section lists `kind` absent or `lease` only. Positions are computed over the merged order (AD-6).
  - Make `hosts:install` on both hosts a step of the v1a release procedure (before the `v1` move), so the old-`hub-device` window is minutes long, not open-ended.

### F-3 [high] AD-4 / AD-6 / AD-9: emulator Pool waits and `phone` waits are invisible to the Event Log and to ETA.

- **PRD:** FR-17 (the named "emulator Lease" event sequence, `waited_ms`), FR-15 and FR-16 (`hub-device lease --wait` prints position and ETA), and §4.4 ("the Event Log ships before anything else, so history builds up"). The phone and emulator Pools are UJ-4's headline estimate.
- **Gap:**
  - An emulator request queues FIFO on the `emulator` gate (`GATE = 'emulator'`, `emulator.mjs:29`, `acquireLease` at `:486`). It then takes a slot with `waitMs: 0` (`:504`). `QUEUED` lists `emulator-<n>` but not the gate, and AD-9 limits events to QUEUED. So an emulator Lease emits only `acquire` (a try) and `release`: no `request`, no `timeout`, `waited_ms` ≈ 0, and no ETA on the wait line.
  - `phone` (`takeAnyPhone`) becomes ticketless tries (AD-6). A `phone --wait 10m` that finally gets the S24 records one `acquire` with no request and no wait.
  - Fourteen days of v1a history would show every Pool wait as zero.
- **Fix:**
  - Add the gate to the event scope as the emulator Pool's Queue (`lock: 'emulator'`, `pool: 'emulator'`). It is already a FIFO `acquireLease`, so no queue behaviour changes.
  - Give `takeAnyPhone` one Pool-level `request` (`lock: 'phone'`, `pool: 'phone'`), and a `timeout` or `cancel` on give-up, through an `events.mjs` helper. Tries take a `request_started_at` option, so the try that wins writes `acquire` with `waited_ms` from the outer request.
  - Amend AD-9's "only the atomic-step writer" rule: the request and timeout of a ticketless Pool request are written by the requesting process. Its own start and give-up are the steps.
  - Name the five FR-17 sequence tests in the Tests row.

### F-4 [high] AD-3 / AD-6 / AD-18 / Event shape: the ticket and event schemas cannot support FR-15 and corrupt `waited_ms`.

- **PRD:** FR-15 (median used share of the stated duration, per Claimant kind, never later than expiry; low data widens to stated durations or job timeouts; ETA at enqueue recorded), FR-17 (Claimant kind, "the times"), SM-2, SM-4.
- **Gaps** (all permanent for history written before they are fixed):
  1. **Reservation-backed Job Holds.** AD-6 names the ticket file with `ms15 = reserved_at`, but never says whether the body's `enqueued_at` is the real request time. If it is `reserved_at`, every android job's `waited_ms` includes its 20–40 min build. SM-2's p95 then explodes and every deploy reads as starved under FR-20's 15 min. SM-4 then compares the ETA against the wrong wait.
  2. **No stated duration.** The Event shape has no `expires_at` and no stated duration (`for_ms`). The "share of stated duration used" cannot be computed from history, and the "never later than expiry" clamp is missing from AD-18.
  3. **No job deadline on tickets or owners.** A waiter cannot widen to the job timeouts of the jobs ahead of it.
  4. **Claimant kind and hold kind are one field.** `claimant.kind` takes AD-3's hold kinds (`lease|job|hub-job`), but FR-15 and FR-17 need the Claimant kind (`deploy|hub-job|agent|person`). Agent and person Leases cannot be told apart.
- **Fix:**
  - Ticket body: `enqueued_at` = the real request time (only the file name is backdated), plus `deadline_at` for job and hub-job tickets.
  - Owner gains `deadline_at` for Job Holds. Leases already have `expires_at`.
  - Event shape: add `hold_kind ∈ job|lease|reservation|request`, `claimant.kind ∈ deploy|hub-job|agent|person`, `enqueued_at`, `started_at`, `expires_at` (Leases), `stated_ms`, `deadline_at`. `hub-device` sets `person` when stdin is a TTY and `HUB_DEVICE_HOLDER` is unset, otherwise `agent`. `waited_ms = acquire_ts - enqueued_at`.
  - AD-18 clamps a Lease's expected end to its `expires_at`, uses the median for the holder's expected end and the IQR for the range, and reads `low_data_holds: 20` from policy.

### F-5 [medium] AD-6 / AD-7: grace is not stored in the record, the stamp races, and "only position 0" contradicts post-grace serving.

- **PRD:** FR-9 ("grace = 10 minutes, stored in the Reservation record"; "once"; "the next Claimant is served"), FR-31 (refusal while others wait).
- **Gap:**
  1. AD-7 stores only `grace_started_at`, and AD-11 makes every version read the grace from its own policy. Two pins with different values disagree on when grace ends, which is exactly what the PRD's "stored in the record" prevents.
  2. The stamp is a rewrite of the Reservation (tmp + rename). Two acquirers can each stamp, so the later write restarts grace. A stamp landing after `android` or `announce` unlinked the Reservation **brings it back**: it then shows in positions and ETAs, and blocks `extendLease` on `adb` until the 3 h ceiling.
  3. AD-6 says "only position 0 may mkdir", while AD-7 says a post-grace Reservation keeps its place but never blocks. Taken literally, a Reservation whose run never asks again blocks the head for 3 h.
  4. Whether a ticketless try (`phone` or an emulator slot) stamps grace is unstated. If it does not, a pre-grace Reservation shuts `phone` out of the S26 for hours.
- **Fix:**
  - Stamp grace by `wx`-creating a sidecar `<reservation>.grace` holding `{grace_started_at, grace_ms}`. The first stamper wins, a release unlinks both files, and readers ignore a sidecar with no Reservation.
  - The gate also writes `grace_ms` into the Reservation at creation.
  - AD-6: define *blocking position* over live tickets plus Reservations that are pre-grace or in grace. Position 0 of that order may mkdir. The displayed position still counts every live Reservation.
  - Tries stamp grace like any acquirer.

### F-6 [medium] AD-14 / AD-15: FR-30's "in its turn" and "refused, naming who" are not landed.

- **PRD:** FR-30 consequences 2 and 3, SM-1 (pending deliveries reported "with how long they took"), SM-C5.
- **Gap:**
  - AD-15 keeps the few-second attempt each 120 s or 300 s pass, so the catch-up re-arrives at the back every pass. Back-to-back Holds starve a contention-pending install indefinitely.
  - A contention-pending build later found `ahead` (a higher build installed under a Lease) goes through the catch-up's `skipped`, `event:false` path (`catchup.mjs:148,377,656`): no event and no name. AD-13 covers only the deploy-time guard.
  - Nothing links the catch-up's hub-job Hold to the run whose delivery it completes, so SM-1 and SM-C5 cannot measure time-to-install.
- **Fix:**
  - When latest.json holds a contention-pending build for the Resource, the catch-up waits as `hub-job` with a budget up to its in-process watchdog minus margin (the 45 min watchdog, `catchup.mjs:1076`). That is bounded execution inside one invocation, not a clock. Otherwise it keeps the short attempt.
  - Catch-up tickets and events carry the `repo`, `run` and version they deliver.
  - On `ahead` for a contention-pending build, write a `release` event with `reason: refused-newer-installed`, naming the Lease holders of that lock since the pending event (from the Event Log). Set latest.json `skipped` with a coarse public reason (`newer build on S26`); the enum stays frozen.

### F-7 [medium] AD-16: the 60-minute deploy-target cap is enforced in the CLI and `extendLease`, not at acquire.

- **PRD:** FR-31 consequence 3, NFR-1.
- **Gap:** AD-16 caps in `extendLease` and makes the CLI exit 2. `acquireLease` itself still accepts 48 h (`MAX_LEASE_MS`), so `emulator.mjs`, any library caller and v1b's Hub API (which must have "same semantics", FR-22) can take a 48 h Lease on `adb`. Old installed `hub-device` also allows 48 h until `hosts:install`.
- **Fix:** `acquireLease` refuses `forMs > policy.queue.deploy_target_lease_max` on `adb` and `mac-ios` with a coded `HUB_LEASE_TOO_LONG`. The CLI maps that code to exit 2. Pair this with F-2's release-time `hosts:install`.

### F-8 [medium] AD-5 vs FR-13 / AD-17: a second, unnamed CLI text change.

- **PRD:** FR-13 ("except for assertions this PRD changes on purpose, each named").
- **Gap:** AD-5 makes *every* timeout on a QUEUED lock start `host lock <name> is held`. That rewrites `acquireLease`'s queued-ahead message `host lock <name> has N waiter(s) ahead of lease <id> …` (`lock.mjs:251`), which `lease.test.mjs:203` pins (`/has 1 waiter ahead of lease two/`) and `hub-device` prints after `HUB_DEVICE_BUSY`. AD-17 claims the wait line is the only text change.
- **Fix:** keep both substrings: `host lock <name> is held by <holder|its queue>; it has N waiter(s) ahead of lease <id> (…); gave up after Ns`. Both the catch-up regexes and the test still match. Otherwise, name the change in AD-17 and the test.

### F-9 [medium] AD-17 vs AD-18: ETA refresh contradiction, and no ETA in status.

- **PRD:** FR-16 ("or the ETA moves by more than a minute"), §7.1 ("Position and ETA in job logs and `hub-device status`").
- **Gap:** AD-18 recomputes only at enqueue and on a position change, so AD-17's ETA-move trigger cannot fire. In UJ-1's overrunning-Lease edge case the line never updates. Status has no ETA field or column, and nothing says whether it shows the stored enqueue ETA or a live one.
- **Fix:**
  - AD-18: recompute at enqueue, on a position change, and at most once a minute inside the waiter's own poll loop. Print when it moves by more than 1 min.
  - Status `--json` gains `eta {lo_ms, hi_ms, low_data, computed_at}` per waiter, computed read-only from the snapshot and a bounded tail of the current month's log.
  - Text status shows `eta=` only in the new job-waiter section, so existing lines stay unchanged (FR-13).

### F-10 [medium] AD-7 / AD-9 / AD-19: no transition → event table, and nobody cleans up expired Reservations.

- **PRD:** FR-17 (`claim` and `expiry` for Leases, Job Holds and Reservations; exact sequences), NFR-3.
- **Gap:**
  - The spine lists the event names but not which atomic step writes each. Open questions include:
    - Is a Job Hold taken through a Reservation a `claim`?
    - Does an expired Lease taken over produce `expiry` or `reclaim`?
    - What does a Reservation emit when it is created or released?
  - Reservation liveness is timestamp-only, and no AD tells any caller to unlink an expired Reservation. Files from a run whose announce failed (Mac offline, ssh refused) accumulate forever, and their `expiry` is never recorded.
- **Fix:** add the table to AD-9. Suggested mapping:
  - Reservation create (`wx`): `request` with `hold_kind: reservation`.
  - A Job Hold's mkdir through the Reservation: `claim`.
  - Release unlink: `release`.
  - An acquirer's unlink of an expired Reservation it passes: `expiry`.
  - Lease taken over after `expires_at`: `expiry`.
  - Dead pid: `reclaim` with `last_alive_at`.
  - Ticket unlink by its owner on give-up: `timeout` or `cancel`.
  - Pruned ticket: `reclaim` (only when `prune: true`, never from status).

### F-11 [medium] AD-7: the gate reserves `adb` unconditionally, and lanes that plan flips to skip keep their Reservation.

- **PRD:** FR-9 ("on each deploy target it will install to"), SM-C4.
- **Gap:** AD-7 says the gate writes `adb`, with no lane condition. An iOS-only run, or a dry run, idles a free S26 for the 10 min grace. Plan can flip the iOS lane to skip after preflight-ios reserved `mac-ios` (`plan.mjs:306-316`), and that Reservation idles the Mac for grace and lives to its ceiling.
- **Fix:**
  - Reserve only for lanes that will install: the gate's android lane decision, and `ios_lane == run` for preflight-ios.
  - Plan releases a Reservation for any lane it turns to skip.
  - Dry runs without a device handoff reserve nothing.

### F-12 [medium] AD-19: `last_alive_at` is wrong for Leases with no hub process alive.

- **PRD:** FR-17 consequence 3.
- **Gap:** The mtime touch runs only while a hub process holds. `hub-device lease` prints exports and exits (`hub-device.mjs:304-325`). A pid- or expiry-bound Lease is never touched, so on reclaim `last_alive_at` is the acquire time, which deflates `held_ms` to about 0. Also, `stale()` stats the lock *directory* (`lock.mjs:44`). Touching `owner.json` does not change it, so the reclaimer must stat `owner.json` explicitly.
- **Fix:**
  - For Holds with an in-process holder (`withLock`, `hub-device run`, the catch-up), keep the touch and record `last_alive_at` from `owner.json`.
  - For external-pid or expiry-bound Leases, record `last_alive_at: null`, `held_ms` = min(now, `expires_at`) − `started_at`, and `held_ms_bound: 'upper'`. The ETA and capacity code treat it as censored.
  - Name the `owner.json` path in AD-19.

### F-13 [medium] FR-8 visibility of `mac-ios` waiters in v1a is unstated.

- **PRD:** FR-8 ("appears in every status view").
- **Gap:** `mac-ios` lives only on the Mac's disk. Big-chungus `hub-device status` cannot see an iOS deploy waiting in v1a, and the spine never says how anyone sees it before the v1b Host Agent.
- **Fix:** one line under Deferred or AD-17. In v1a, `mac-ios` waiters show only in `hub-device status` run on the Mac (`ssh hub-mac hub-device status --json`), and in the iOS job log's `HUB_LOCK_WAIT` line. Confirm `hosts:install` puts the new `hub-device` on the Mac.

### F-14 [medium, needs Jarad] OQ1: FR-30 on iOS is contradicted openly; the second-take regression is not mentioned.

- **PRD:** FR-30, §9 decision 2 ("A delivery that loses its Resource to an earlier Hold goes pending").
- **Assessment:** The spine is right that it cannot be met while `mac-ios` wraps the build (`ios.mjs:276-301`), and FR-12 or §7.2 keeps the iPad and build lane as one Resource. The deviation is flagged, not silent. It misses one related regression: a timeout on the store-IPA take (`ios.mjs:390`) *after* a successful iPad install turns that install into `failed` in latest.json and the event (`deliver.mjs:44`, `announce.mjs:113,127-130`).
- **Fix:** ask Jarad to amend FR-30 to "Android in v1a; iOS when the build splits from the ios-lane".
  - Same-run passthrough already keeps the second take behind only Holds that arrived before preflight.
  - Report a second-take timeout at stage `deliver` (TestFlight lane only), so an installed iPad stays `installed`.
  - Count iOS contention reds as an SM-C5 sibling metric.

### F-15 [low] AD-14: blocking Holds go to the receipt, not the run summary.

- **PRD:** FR-30 ("blocking Holds named in its summary").
- **Fix:** the android job appends `S26 busy: held by <hold_kind> <holder> since <ts>; N ahead` to `GITHUB_STEP_SUMMARY`, which `receipt.mjs` already writes. Use holder *kind* and lock only when the caller repo is public, so the public bucket stays coarse as AD-14 intends.

### F-16 [low] AD-7: "releases it in `finally`" is ambiguous for the iOS job's two takes.

- **Fix:** the Reservation is released in the *command's* `finally`, after its last take (`ios.mjs` after `:390`, `android.mjs` after `:156`), never in `withLock`'s `finally`. Add a test where `ios` makes two takes with a Lease queued between them.

### F-17 [low] AD-12 / NFR-5: an already-past deadline, and the job-start seam.

- **Gap:** When the android build eats the budget, the deadline is already past on entry, and the behaviour is unstated. Job start comes from the Runner.Worker ancestor (`/proc` or `ps`), and the Seams row has no seam for it.
- **Fix:** with the deadline ≤ now, make one try, then `HUB_LOCK_TIMEOUT`, which goes pending on Android. Add `jobStart` (or `processTree`) to the Seams row so CI on ubuntu-latest can test the macOS branch.

### F-18 [low] AD-1 / AD-17: brownfield exceptions not named.

- **Gap:**
  - `emulator.mjs:329-332` parses gate tickets by hand, against AD-1's "never parse the files".
  - `emulator.mjs` writes `emulators/` records and `emulator-pool` under `HUB_LOCK_DIR` outside `lock.mjs`, against AD-1's "every create, rename or delete".
  - `leaseSupport()` (`hub-device.mjs:115`) relies on the literal `export async function acquireLease` in the installed `lock.mjs` (test `:772-790`).
- **Fix:**
  - Move the gate-ticket read to `listWaiters`.
  - Carve `emulators/` and `emulator-pool` out of AD-1 explicitly (emulator records, not protocol).
  - Add to AD-17: keep `export async function acquireLease` in `lock.mjs`.

### F-19 [low] Small unassigned items.

- **AD-11:** add `low_data_holds: 20` (the glossary's one threshold) and `eta_recompute_s: 60` to the `queue` block.
- **NFR-2:** the release notes must state "fairness holds only among runs on the new pin". Make it a checklist line in `mise run release` for the v1a tag.
- **FR-31 override:** in v1c, record it as `extend` with `reason: override` plus actor. Reserve that now in the event `reason` vocabulary.
- **FR-9:** add an explicit test that a rerun after the Reservation ended queues as a new arrival.

## 3. Quiet requirements checklist (as asked)

| Quiet requirement | Verdict |
| --- | --- |
| Status text "never `undefined`" | PARTIAL: new `hub-device` fine; old installed `hub-device` prints it during roll-out (F-2) |
| ETA recorded at enqueue | PARTIAL: stored in ticket and `request` event (AD-18); the enqueue time for Reservation-backed Holds is undefined (F-4) |
| Last-known-alive on reclaim | PARTIAL: AD-19 for in-process holders; wrong for exported Leases, and a dir-vs-file mtime trap (F-12) |
| Mac clock for the ios-lane | LANDS: Conventions plus AD-7 (preflight-ios and the ssh release both run on the Mac) |
| Refusal naming waiters | LANDS: AD-16 and AD-5 |
| Status read-only | LANDS: AD-9 and AD-7 (grace computed, never stamped, by readers) |
| Grace stored in the Reservation record | DROPS (F-5) |
| Lease expected end never later than expiry | DROPS (F-4) |
| Catch-up recorded as hub-job, never starved | LANDS (AD-15); the Claimant-kind taxonomy needs F-4 |
| Internal locks write nothing | LANDS (AD-4, AD-9) |
| Timeout keeps the parsed wording | LANDS (AD-5), with an unnamed CLI text change (F-8) |
| Ticket format includes a remote kind with its own expiry | LANDS in shape; the liveness precedence must be fixed before freezing (F-1) |
