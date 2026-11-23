---
status: final
release: v1a
stepsCompleted: [step-01-validate-prerequisites, step-02-design-epics, step-03-create-stories, step-04-final-validation]
inputDocuments:
  - _bmad-output/planning-artifacts/prds/prd-mobile-deploy-hub-2026-11-21/prd.md
  - _bmad-output/planning-artifacts/prds/prd-mobile-deploy-hub-2026-11-21/addendum.md
  - _bmad-output/planning-artifacts/architecture/architecture-mobile-deploy-hub-v1a-2026-11-23/ARCHITECTURE-SPINE.md
  - _bmad-output/planning-artifacts/architecture/architecture-mobile-deploy-hub-v1a-2026-11-23/.memlog.md
created: '2026-11-23'
updated: '2026-11-23'
---

# Mobile Deploy Hub: Epic Breakdown, Hub Resource Registry v1a

## Overview

This document breaks the **v1a** release of the Hub Resource Registry into epics and stories. It covers only the v1a scope (PRD §7.1, "stop the starvation and start the history"); v1b (Registry, Hub API, Host Agent) and v1c (Capacity Estimate, Control Surface) get their own breakdowns later. Every story cites the architecture decision (`AD-n`) that governs it. The spine is binding: a story that seems to need something the spine forbids is a spine change, not a local workaround.

There is no UX document: v1a has no UI. Its surfaces are job logs and `hub-device` output.

## Requirements Inventory

### Functional Requirements

- **FR-7:** Every Claimant kind waits in one first-come-first-served Queue per Resource. There are no priority classes. A free Resource with an empty Queue is taken at once. The catch-up waits as a hub job, and its short attempt is recorded as a hub-job request, never as a deploy or a starved Claimant.
- **FR-8:** A deploy job waiting for a Resource holds a place in its Queue.
  - It appears in `hub-device status --json` with its repo, run and job, and never as `undefined` in text.
  - It never loses its place to a later Claimant on the new pin.
  - Its wait ends at least 2 minutes before its own job timeout.
  - The timeout keeps the `host lock <name> is held` wording.
  - Only Registry Resource locks queue. The internal locks (`s3-*`, `s3-index`, `emulator-reaper`) keep today's behaviour and write no events.
- **FR-9:** A deploy run takes a Reservation on each deploy target when it starts: the gate takes the S26's, and `preflight-ios` takes the `ios-lane`'s.
  - The run's Job Holds go through the Reservation.
  - Plan reads the installed version with a Peek, without waiting behind a Lease or behind its own Reservation.
  - Same-run Job Holds (matched by the GitHub run id) never wait behind their own Reservation.
  - A head Reservation gets a one-time grace period (10 min, stored in the record). After it, the Reservation keeps its place but never idles the Resource again.
  - A Reservation ends with the run's last Job Hold, with the final job's release, or at a 3 h ceiling.
  - A rerun reuses a live Reservation.
- **FR-12 (v1a part):** The iOS jobs and the iPad catch-up wait in one FIFO on `mac-ios`, on the Mac. Every timestamp in that Queue comes from the Mac clock.
- **FR-13:** `hub-device` keeps its commands, exit codes (75, 76), `HUB_DEVICE_*` lines and `--json` shapes.
  - The existing suites pass, except for named intended changes.
  - `hub-device status` stays read-only: it writes nothing to the lock dir or the Event Log.
- **FR-15:** Every queued Claimant gets an ETA range: the IQR of matching past holds, combined along the Queue.
  - A Job Hold's expected length comes from the same repo and job.
  - A Lease's expected end is its start plus the median share of the stated duration used, never later than its expiry.
  - With low data, the range widens and is flagged.
  - The ETA at enqueue is recorded in the Event Log.
- **FR-16:** A waiting deploy job prints its position and ETA in its job log, and `hub-device lease --wait` prints them on stderr, as `HUB_LOCK_WAIT <lock name> held by <holder> position=<n> eta=<range>`. The line prints only on a position change or when the ETA moves by more than a minute.
- **FR-17:** One event is appended per request, acquire, release, extend, timeout, cancel, claim, expiry, reclaim and force-release, for Leases, Job Holds and Reservations.
  - Each event carries the Resource, the Claimant, the hub version, the times, `waited_ms`, `held_ms`, the ETA at enqueue and the reason.
  - Exact event sequences are tested for five cases: a deploy run, a Lease, an emulator Lease, a pending delivery and a timed-out wait.
  - A failed write never fails a transition.
  - A reclaim records when the holder was last alive.
- **FR-30:** When a deploy job's wait budget runs out, its delivery goes pending, like an away device.
  - The run is green, and the blocking Holds are named in its summary and in the Event Log.
  - The catch-up installs the build in its turn.
  - If the device's version has moved above the planned one, the delivery is refused and the refusal names who installed it.
- **FR-31:** A Lease cannot be extended while another Claimant waits; the refusal names the waiters and their positions. A Lease on a deploy target lasts at most 60 minutes.

### NonFunctional Requirements

- **NFR-1:** There is one lock, queue and Reservation implementation, in the lock library. The on-disk layout is the contract, and it carries a format version.
- **NFR-2:** Pinned runs stay backward compatible:
  - Old pins can read the layout, and new files sit beside the old ones.
  - A Reservation is never written as an owner.
  - The ticket format freezes at the first queue-joining release, including the remote kind.
  - The catch-ups switch at the first real deploy on the new pin, and `hub-device` switches at `hosts:install`.
  - Fairness is guaranteed only among runs on the new pin.
- **NFR-3:** No new clock. Expiry, reclaim and grace are evaluated when the hub is called; anything recurring is a Candybar job.
- **NFR-4:** Node 24 ESM only, with no Python.
- **NFR-5:** Tests are hermetic `tools/**/*.test.mjs` that run with no device, bucket or host state.

### Additional Requirements

These come from the architecture spine (AD-1 to AD-21). There is no starter template; this is brownfield work in `tools/ci/lib/lock.mjs` and its callers.

- **Ownership (AD-1):** `lock.mjs` alone creates, renames and deletes `*.lock`, `*.queue/` and `*.reservations/`, and alone appends events. `emulator.mjs` moves its gate-ticket parsing onto `queueView`.
- **Layout (AD-2):** the layout is additive and versioned. `owner.json` gains `format`, `kind`, `repo`, `run`, `attempt`, `job` and `host_id`.
- **Ticket v1 (AD-3):** the body and liveness order are frozen. Every ticket keeps `lease_id`, and job ids take the form `job:<repo>#<run>.<attempt>/<job>`.
- **Queued set (AD-4):** `QUEUED = adb, s24, mac-ios, emulator, emulator-<n>`. Pool requests write one request event and then one acquire or timeout event.
- **Error codes (AD-5):** `HUB_LOCK_TIMEOUT`, `HUB_LEASE_CANCELLED`, `HUB_LEASE_EXTEND_REFUSED`, `HUB_LEASE_LOST`. Timeout messages start `host lock <name> is held`.
- **One view of the queue (AD-6):** `queueView(name)` separates a Claimant's place from what blocks it. Tries write no ticket. A Claimant re-checks after `mkdir`.
- **Reservations (AD-7):** a Reservation is a directory holding a write-once `reservation.json` and a create-once `grace.json`.
  - It is released by renaming the directory before the lock is freed.
  - The release rules are per job.
  - `announce` releases it on the Mac over ssh with the `hub-device reservation release` verb.
- **Host identity (AD-8):** `host_id` comes from `/etc/machine-id` on Linux and `IOPlatformUUID` on the Mac.
- **Event Log (AD-9):** it lives in `HUB_EVENT_DIR`, default `~/.local/state/mobile-deploy-hub/events/<YYYY-MM>.jsonl`.
  - Each event is a single `O_APPEND` line of at most 4 KiB.
  - A table maps each event to the step that decides it.
  - Reclaim and release go through a tombstone rename, never `rmSync` with `force`.
  - Status no longer reaps.
- **Hub version (AD-10):** `hubRef()` in `receipt.mjs` is the only resolver, extended with the release-dir path.
- **Policy (AD-11):** a strict `queue` block in `policy.json`. Writers stamp absolute times and durations into their records.
- **Deadlines (AD-12):** `deadline = job_start + timeout - margin - hold_allowance[job]`.
  - `HUB_JOB_TIMEOUT_MINUTES` is set beside each job's `timeout-minutes`, and a check test keeps the two equal.
  - `job_start` is the start of the nearest `Runner.Worker` ancestor.
- **Device reads under a Lease (AD-13):** reads go through `adb -L tcp:127.0.0.1:<port> -s <id>` only. A failure means `unknown`.
- **Android pending (AD-14):** the delivery is marked `pending` with the reason `S26 busy`. Holder details go only to the receipt and the events, and the Play upload proceeds.
- **Catch-up (AD-15):** it queues as a hub-job and waits longer when a build is pending on contention. On `ahead` it writes a `refused` event, and `latest.json` shows `skipped`.
- **Extensions (AD-16):** `extendLease` is the only way to move expiry later. Owner rewrites check the lease id and the inode. The 60-minute cap is enforced at acquire and at extend.
- **CLI (AD-17):** the CLI only grows. The intended text changes are the wait line and the queued-timeout message. `release` refuses `job:` ids.
- **ETA (AD-18):** `eta()` is pure. It is recomputed at enqueue, on a position change, and every 5 minutes at most.
- **Liveness (AD-19):** each holder touches `<name>.lock/alive`. A reclaim records `last_alive_at`.
- **Freeze set (AD-20):** the freeze set ships in one release, followed immediately by `hosts:install` on both hosts. The Event Log may ship earlier.
- **Concurrency groups (AD-21):** drop the `android` and `ios` concurrency groups in `mobile-deploy.yml`.
- **Node versions:** Node 24 or later. Check runs on both Node 24 and Node 26.
- **Release process (hub policy):** every epic ships as a hub release, `mise run release -- X.Y.Z`, with one strict dry run per app. Never bump an app version by hand.

### UX Design Requirements

None. v1a has no user interface.

### FR Coverage Map

| Requirement | Epic | Where |
| --- | --- | --- |
| FR-17 | Epic 1 (all non-queue transitions), Epic 2 (queue, Reservation and Pool events) | 1.1–1.4, 2.2–2.7 |
| FR-7 | Epic 2 | 2.2, 2.3, 2.5 |
| FR-8 | Epic 2 | 2.3, 2.4 |
| FR-9 | Epic 2 (Reservations); Epic 3 (Peek) | 2.5, 2.6, 3.1 |
| FR-12 (v1a part) | Epic 2 | 2.3, 2.6 |
| FR-31 | Epic 2 | 2.7 |
| FR-30 | Epic 3 | 3.2, 3.3, 3.4 |
| FR-15 | Epic 4 | 4.1 |
| FR-16 | Epic 4 | 4.2 |
| FR-13 | Epic 1 (status read-only); Epic 2 (no regression); Epic 4 (status growth) | 1.3, 2.8, 4.3 |
| NFR-1, NFR-2 | Epic 2 | 2.1–2.8 |
| NFR-3 | Epics 1, 2 | 1.4, 2.5 |
| NFR-4, NFR-5 | all | every story |

Out of v1a by the PRD's own split: FR-17's `force-release` event (the override lives in the v1c Control Surface) and its Registry and Reachability events (v1b Registry). The `extend` event ships in 2.7 through `extendLease`; the CLI verb itself is v1b (FR-10).

## Epic List

### Epic 1: Every hold leaves a record

Jarad and his agents get a durable, exactly-once history of who held each device, for how long, and how each hold ended. It starts accruing with the first release, before anything else changes. The Event Log is additive, so it ships as its own hub release ahead of the Queue (AD-20 allows this).
**FRs covered:** FR-17 (existing transitions), FR-13 (status read-only)
**Decisions:** AD-1, AD-2 (owner fields), AD-9, AD-10, AD-11 (policy block seeded), AD-19

### Epic 2: Deploys wait their turn, and keep it

Deploy jobs, the catch-up and Leases wait in one fair FIFO per device. A deploy run reserves its devices at the start, so its build never loses its place. Nobody can extend a Lease while others wait, and Leases on deploy targets are capped at 60 minutes. This epic is the **freeze set** (AD-20): it ships as one hub release, followed by `hosts:install` on both hosts.
**FRs covered:** FR-7, FR-8, FR-9 (Reservations), FR-12 (v1a part), FR-31, FR-17 (queue, Reservation and Pool events), NFR-1, NFR-2
**Decisions:** AD-2 to AD-8, AD-11, AD-12, AD-16, AD-20, AD-21

### Epic 3: A busy phone doesn't fail the deploy

When the S26 is held, plan still learns the installed version without disturbing the leaseholder. A delivery whose wait runs out goes pending, and the catch-up installs it in its turn, instead of the run going red. A newer build already on the device is refused, and the refusal names who installed it.
**FRs covered:** FR-9 (Peek), FR-30
**Decisions:** AD-13, AD-14, AD-15; iOS behaviour per Open Question 1

### Epic 4: Know where you stand and how long it'll be

Every waiter sees its position and an honest ETA range, in job logs, in `hub-device lease --wait` and in `hub-device status`. The CLI only grows.
**FRs covered:** FR-15, FR-16, FR-13
**Decisions:** AD-17, AD-18

**Dependencies:** each epic builds on the ones before it and works without the ones after it.
- Epic 2 uses Epic 1's event writer.
- Epic 3 uses Epic 2's coded timeouts and Reservations.
- Epic 4 uses Epic 1's history and Epic 2's `queueView`.

---

## Epic 1: Every hold leaves a record

Ship the Event Log as an additive hub release, so history starts accruing before the Queue changes. It covers the transitions that already exist today: Lease acquire, release, timeout, cancel and reclaim, plus `withLock` takes of Queued names.

### Story 1.1: Event writer with a single hub-version source

As an agent analysing device contention,
I want every lock transition to be appended to a local, append-only Event Log,
So that history exists from the first release and can't be lost with a cache wipe.

**Acceptance Criteria:**

**Given** a new module `tools/ci/lib/events.mjs`
**When** `appendEvent(event, {env, now, log})` is called
**Then** it writes exactly one JSON line ending in `\n`, of at most 4 KiB, with one `O_APPEND` write to `HUB_EVENT_DIR/<YYYY-MM>.jsonl`
**And** `HUB_EVENT_DIR` defaults to `$XDG_STATE_HOME/mobile-deploy-hub/events`, falling back to `~/.local/state/mobile-deploy-hub/events` (AD-9)
**And** every event carries `format: 1`, `ts`, `host`, `host_id` and `hub_version`.

**Given** the event directory cannot be written (it is read-only or missing and can't be created)
**When** `appendEvent` runs
**Then** it logs `HUB_EVENT_LOG_FAILED <reason>` and returns without throwing.

**Given** `hubRef()` in `receipt.mjs`
**When** it is extended
**Then** it resolves `HUB_REF`, then the `_actions/…/<ref>/` path, then the release-dir name in the module path, then `null`
**And** `events.mjs` imports it, and `hub_version` is never read from `HUB_VERSION` (AD-10).

**Given** a line that would exceed 4 KiB
**When** it is appended
**Then** the free-text fields (`why`, `reason`) are truncated until the line fits, and the line is still valid JSON.

**Given** `readEvents({env, since, until})`
**When** it is called over month boundaries
**Then** it yields parsed events in file order and skips a malformed line with a counted warning.

All of this is covered by hermetic tests using a temp `HUB_EVENT_DIR`, including 20 concurrent appenders producing zero torn lines.

### Story 1.2: Exactly-once release and reclaim through tombstones

As an agent reading history,
I want each release and reclaim to be recorded exactly once,
So that hold times aren't double-counted and two reclaimers can never both "win" a lock.

**Acceptance Criteria:**

**Given** `lock.mjs` release and reclaim paths (today `rmSync({force})` at `:61` and `:103`)
**When** a holder releases or a reclaimer reclaims
**Then** the lock dir is renamed to `<name>.lock.tomb-<ms>-<pid>`, and only the process whose rename succeeded deletes the tomb and appends the `release` or `reclaim` event (AD-9)
**And** a rename that fails with ENOENT writes no event and is not an error.

**Given** two reclaimers race on the same stale lock in a test
**When** both run
**Then** exactly one `reclaim` event is written, and the lock taken afterwards by a third process is never removed by the losing reclaimer.

**Given** `listLocks()`
**When** a tomb exists
**Then** it is not listed, because the tomb name doesn't end in `.lock`.

**Given** an old pinned version's bare `mkdir` of `<name>.lock`
**When** a tomb exists beside it
**Then** the `mkdir` succeeds, because the tomb never blocks the lock name.

### Story 1.3: `hub-device status` is truly read-only

As an agent polling status,
I want `hub-device status` to change nothing,
So that looking never alters the thing I'm looking at (FR-13).

**Acceptance Criteria:**

**Given** `hub-device status` (today it calls the emulator `reap()` at `hub-device.mjs:701`)
**When** it runs
**Then** it performs no reap and writes nothing to the lock dir, the emulator state or the Event Log.

**Given** a dead emulator lease
**When** the next `hub-device lease emulator` or `run emulator` acquires
**Then** the reap runs on that acquire path and the reclaim writes its event.

**Given** the existing status tests (`hub-device.test.mjs:861-941`)
**When** the suite runs
**Then** they pass unchanged, and a new test asserts that the Event Log file is untouched by status.

### Story 1.4: Record holds on Queued locks, with liveness

As Jarad,
I want every Lease and every deploy-job take of a device lock to be logged with who held it, why and for how long,
So that I can see contention before the Queue even ships.

**Acceptance Criteria:**

**Given** `QUEUED = adb, s24, mac-ios, emulator, emulator-<n>`, exported once from `lock.mjs` (AD-4)
**When** `acquireLease`, `releaseLease`, a Lease timeout, a cancel, or `withLock` on a Queued name succeeds at its deciding step
**Then** `lock.mjs` appends the matching event: `request`, `acquire`, `release`, `timeout`, `cancel` or `reclaim`
**And** the event carries `lock`, `hold_kind`, `claimant {kind, holder, repo, run, attempt, job}`, `lease_id`, `for_ms`, `expires_at`, `waited_ms` and `held_ms`.

**Given** `withLock` on `s3-*`, `s3-index`, `emulator-reaper` or any non-Queued name
**When** it runs
**Then** no event is written and behaviour is unchanged.

**Given** a holder process
**When** it holds a Queued lock
**Then** it touches `<name>.lock/alive` at most once a minute from an `unref`'d timer (AD-19).

**Given** a reclaim
**When** it is recorded
**Then**
- a job's reclaim carries `last_alive_at` = the mtime of `alive`, with `approx: true`;
- a Lease's reclaim ends `held_ms` at the earlier of `expires_at` and the observed death.

**Given** `owner.json`
**When** it is written by this release
**Then** it adds `format`, `kind`, `repo`, `run`, `attempt`, `job` and `host_id` (additive, AD-2), and `stale()` still reads owners written by v1.2.43.

**Given** the hermetic suite
**When** it runs
**Then** event-sequence tests pin the exact sequence for a Lease and for an emulator Lease.

### Story 1.5: Ship the Event Log release

As Jarad,
I want the Event Log out on both hosts now,
So that history accrues while the Queue is built.

**Acceptance Criteria:**

**Given** stories 1.1–1.4 are on main and `mise run check` is green on Node 24 and Node 26 (`check.yml` gains the Node 26 leg)
**When** `mise run release -- X.Y.Z` runs
**Then** every app's strict dry run passes, `v1` moves, and `mise run hosts:install` runs from a clean checkout at the tag on both hosts.

**Given** the first real deploy after the release
**When** it takes `adb` or `mac-ios`
**Then** the event files on the owning host show its `acquire` and `release` with `hub_version` equal to the tag.

---

## Epic 2: Deploys wait their turn, and keep it

The freeze set (AD-20). Every story here lands on main behind a single release. Story 2.8 is that release. Nothing in this epic ships in a release on its own.

### Story 2.1: Ticket format v1 and machine identity

As the hub maintainer,
I want one frozen ticket format with an unambiguous liveness order,
So that no pinned version can strand the Queue behind a dead or unfamiliar ticket (NFR-2).

**Acceptance Criteria:**

**Given** a ticket written by this version
**When** it is created
**Then**
- its file name is still `<ms15>-<counter6>-<pid8>.json`;
- its body has the AD-3 fields: `format`, `kind`, `lease_id`, `holder`, `why`, `pid`, `host`, `host_id`, `process_start`, `enqueued_at`, `deadline_at`, `expires_at`, `repo`, `run`, `attempt`, `job`, `reservation`, `request`, `pool`, `eta`, `delivery`;
- job tickets use `lease_id = job:<repo>#<run>.<attempt>/<job>`, and `holder` and `why` are always set.

**Given** the liveness rule
**When** it is applied to a ticket
**Then** it follows this order, each case with a table test:
1. A missing `kind` is treated as `lease`.
2. A ticket with a pid uses the pid rule. It is stale only on positive evidence of death; an unreadable process start keeps it live.
3. A ticket with no pid is live while `expires_at` is in the future.
4. A ticket with no pid and no `expires_at` goes stale 60 s after `enqueued_at`.

**And** a ticket whose `kind` is unknown is never pruned for its kind alone.

**Given** `hostId()`
**When** it runs on Linux, or on the Mac
**Then** it returns the contents of `/etc/machine-id` on Linux, or the `IOPlatformUUID` from `ioreg` on the Mac, cached per process and injectable as a seam
**And** two records are on the same host when both carry a `host_id` and those ids are equal; otherwise hostname equality decides (AD-8).

**Given** a v1.2.43 lease ticket (no `kind`, no `host_id`) in the queue
**When** the new code reads it
**Then** it is judged by the pid rule as a lease, and `lease_id` matching for `release <id>` keeps working.

### Story 2.2: One queue view, and tries

As any Claimant,
I want one shared answer to "who is ahead of me and who is blocking",
So that every caller and every version orders the Queue the same way (AD-6).

**Acceptance Criteria:**

**Given** `queueView(name, {env, now, policy})` exported from `lock.mjs`
**When** it is called
**Then** it returns live tickets sorted by file name (ties broken on the full name), and each entry carries `place`, `blocking`, `kind` and its identity fields
**And** the shape leaves room for Reservation entries (`kind: reservation`, `grace`), which story 2.5 adds.

**Given** an acquirer whose `mkdir` succeeded
**When** it re-reads `queueView` and finds a blocking entry ahead of it
**Then** it releases the lock (by tombstone) and keeps waiting.

**Given** a call with `waitMs: 0` (a try)
**When** the lock is free and nothing blocks
**Then** it acquires without writing a ticket and appends an `acquire` event.

**Given** a try that fails
**When** it returns
**Then** it has written no ticket and no event.

**Given** `takeAnyPhone` and the emulator gate
**When** they request a Pool
**Then** they use tries for each pass, write one Pool-level `request` event and one `acquire` or `timeout` event with `waited_ms` measured from the outer request (AD-4)
**And** `emulator.mjs:329-332` reads waiters through `queueView` instead of parsing tickets.

**Given** `hub-device status`
**When** it computes positions (today at `:507`)
**Then** it uses `queueView`, and its text output is unchanged for the existing fixtures.

### Story 2.3: Deploy jobs and the catch-up join the Queue

As a deploy run,
I want my plan, android and ios jobs to stand in line instead of retrying `mkdir`,
So that a later arrival can never take the device ahead of me (FR-7, FR-8, FR-12).

**Acceptance Criteria:**

**Given** `withLock(name)` with a name in `QUEUED`
**When** it is called from a deploy job
**Then** it writes a `kind: job` ticket carrying the identity from `GITHUB_REPOSITORY`, `GITHUB_RUN_ID`, `GITHUB_RUN_ATTEMPT` and `GITHUB_JOB`, then waits in FIFO order through `queueView`.

**Given** the catch-up's `ctx.lock`
**When** it is called
**Then** it queues as `kind: hub-job`.

**Given** a wait that runs out on a Queued lock
**When** it throws
**Then** the error has `code: 'HUB_LOCK_TIMEOUT'` and a message beginning `host lock <name> is held`, naming the holder and the waiters ahead with their positions (AD-5)
**And** the `catchup.mjs:469` and `:591` regexes still match.

**Given** `acquireLease`'s queued timeout (today `host lock X has N waiter(s) ahead`)
**When** it times out
**Then** it uses the same `host lock <name> is held …` wording, and `lease.test.mjs:203` is updated and named as an intended change.

**Given** `mac-ios` on the Mac
**When** an iOS job and the iPad catch-up both want it
**Then** they are served in arrival order from tickets written on the Mac.

**Given** `withLock` on internal names
**When** it is called
**Then** the bare `mkdir` path is unchanged.

**Given** the hermetic suite
**When** it runs
**Then** it covers:
- a deploy job enqueued before a Lease is served first, and the reverse;
- a free Resource with an empty Queue is taken at once;
- the catch-up's timeout is recorded as a `hub-job` `timeout`.

### Story 2.4: Wait deadlines that beat GitHub's timeout

As a deploy job,
I want my wait to end before GitHub kills me,
So that a timed-out wait always reports its own reason and the Holds ahead (FR-8).

**Acceptance Criteria:**

**Given** `mobile-deploy.yml`
**When** a job that may wait for a device runs (plan, android, ios)
**Then** it sets `HUB_JOB_TIMEOUT_MINUTES` equal to its `timeout-minutes`
**And** a test in `mise run check` parses the workflow and fails if they differ.

**Given** `tools/ci/policy.json`
**When** this story lands
**Then** it gains a strict `queue` block with `wait_margin_min` (2) and `hold_allowance_min` per job, and `policy.mjs` and its test reject unknown or missing keys (AD-11)
**And** each later story adds only its own keys to this block.

**Given** the deadline helper
**When** it computes a job's deadline
**Then**
- it returns `job_start + timeout - margin - hold_allowance[job]`, with the allowance taken from policy and covering every remaining hold (ios takes `mac-ios` up to twice);
- `job_start` is the start of the nearest `Runner.Worker` ancestor, or the process start otherwise;
- every input is injectable.

**Given** the ticket
**When** it is written
**Then** it carries `deadline_at`.

**Given** `mobile-deploy.yml`
**When** this story lands
**Then** the per-repo `concurrency` groups on `android` and `ios` are removed, and `plan`, `ios-export` and `deliver-*` keep theirs (AD-21). Actionlint and conformance pass.

### Story 2.5: Reservations keep a run's place

As a deploy run,
I want to reserve my devices at the start of the run,
So that my build doesn't lose its place to Claimants that arrive while it compiles (FR-9).

**Acceptance Criteria:**

**Given** the policy `queue` block
**When** this story lands
**Then** it adds `grace_min` (10) and `reservation_ceiling_min` (180).

**Given** `queueView`
**When** Reservations exist
**Then**
- they sort by `reserved_at`;
- a Reservation whose run has a live ticket is hidden, and that ticket stands at its place;
- only the first Reservation in line may be marked `blocking`, and only before its grace ends.

**Given** the gate job of a run that will install to the S26
**When** it starts
**Then**
- it creates `adb.reservations/<owner>--<repo>--<run>/reservation.json` with `wx`, holding `{format, run_key, repo, run, reserved_at, expires_at = reserved_at + ceiling, grace_ms}`;
- it appends a `claim` event;
- it reuses a live Reservation of the same run, for example on a rerun.

**Given** an iOS-only run
**When** the gate runs
**Then** it reserves nothing on `adb`.

**Given** `preflight-ios` on the Mac
**When** iOS is in scope
**Then** it reserves `mac-ios` the same way, on the Mac's disk.

**Given** a Job Hold request whose `GITHUB_REPOSITORY` and `GITHUB_RUN_ID` match a live Reservation
**When** it enqueues
**Then** its ticket's `ms15` is the Reservation's `reserved_at`, so it sits at the Reservation's place
**And** `enqueued_at` holds the real request time.

**Given** a free lock with an unasking Reservation first in line
**When** the first acquirer or try observes it
**Then**
- it creates `grace.json` with `wx` and appends a `grace` event;
- others are blocked until `grace_started_at + grace_ms`;
- after that the Reservation keeps its place but blocks nothing.

**Given** a read-only path (status)
**When** it sees the same state
**Then** it computes grace but creates nothing.

**Given** a Reservation past `expires_at`
**When** any acquirer prunes it
**Then** the directory is renamed to `.released-<key>-<ms>`, and only the winner appends `expiry`.

**Given** the hermetic suite
**When** it runs
**Then** it covers:
- an old pinned bare `mkdir` sees no owner for a Reservation;
- `listLocks()` does not list a Reservation.

### Story 2.6: Reservations end when the run is done with the device

As the next Claimant in line,
I want a finished run's Reservation to go away promptly,
So that I'm not held up by a run that no longer needs the device, while a failed job that might be rerun keeps its place.

**Acceptance Criteria:**

**Given** a Reservation
**When** it is released
**Then** the directory is renamed to `.released-<key>-<ms>` before the run's lock is freed, and a later grace stamp fails with ENOENT and is ignored.

**Given** the end of a lane
**When** it finishes
**Then** the release follows this table:

| Who | When it releases |
| --- | --- |
| `android` | success or contention-pending |
| `ios` | success |
| `plan` | the run skips the Android lane |
| any lane | on failure: never; grace and the ceiling end it |

**Given** `announce` (which always runs)
**When** a lane ended in success or pending
**Then**
- it releases that lane's Reservation locally;
- for `mac-ios`, it runs `ssh hub-mac '<absolute path to installed hub-device> reservation release --run <key>'`;
- it never runs `rm` over ssh;
- a Mac release without the verb is logged and left to the ceiling.

**Given** the new `hub-device reservation release --run <key>` verb
**When** it runs
**Then** it releases through `lock.mjs`, exits 0 when nothing is reserved, and prints a `HUB_DEVICE_*` line.

**Given** `gh run rerun --failed` on a failed android job within the ceiling
**When** the job asks for `adb`
**Then** it is served at the original Reservation's place.

### Story 2.7: No extension while others wait; deploy-target Leases are capped

As a deploy waiting behind a Lease,
I want the leaseholder unable to extend while I wait, and deploy-target Leases capped at 60 minutes,
So that a Lease can't starve the deploy queue (FR-31).

**Acceptance Criteria:**

**Given** `extendLease(name, lease_id, {forMs})` in `lock.mjs`
**When** any entry in `queueView` that blocks is waiting
**Then** it throws `HUB_LEASE_EXTEND_REFUSED`, with the waiters and their positions in the message.

**Given** an extension
**When** it is requested at or after the Lease's `expires_at`
**Then** it is refused.

**Given** an extension
**When** it succeeds
**Then** it appends an `extend` event.

**Given** the policy `queue` block
**When** this story lands
**Then** it adds `deploy_target_lease_max_min` (60).

**Given** a Lease on `adb` or `mac-ios`
**When** it is acquired or extended past the policy cap (60 min)
**Then** it is refused, and `hub-device lease s26 --for 2h` exits 2 with a message naming the cap and pointing at `s24` or an emulator.

**Given** `updateLease`
**When** it is asked to move expiry later
**Then** it refuses; only metadata changes and earlier expiry are allowed. `emulator.mjs:595` keeps working.

**Given** any owner rewrite
**When** the lock was reclaimed and re-taken since the writer acquired it (a different `lease_id` or lock-dir inode)
**Then** it throws `HUB_LEASE_LOST` and writes nothing.

**Given** a Reservation past its grace
**When** it is in line
**Then** it does not block extensions.

### Story 2.8: Ship the freeze set

As Jarad,
I want the whole queue protocol released at once and installed on both hosts,
So that no pin ever carries half the format (AD-20, NFR-2).

**Acceptance Criteria:**

**Given** stories 2.1–2.7 are on main
**When** `mise run check` runs on Node 24 and Node 26
**Then** it is green, and the existing `tools/device/*.test.mjs` suites pass except for the named intended changes (the queued-timeout wording).

**Given** the hermetic suite
**When** it runs
**Then** it contains event-sequence tests for a full deploy run (claim, request, acquire, release, Reservation release) and for a timed-out wait.

**Given** `mise run release -- X.Y.Z`
**When** it completes
**Then** every app's strict dry run is green, `v1` has moved, and `mise run hosts:install` has run from a clean checkout at the tag on big-chungus and on the Mac before any real deploy.

**Given** the release notes
**When** they are published
**Then** they state that fairness holds only among runs on this pin and later, and that older pins age out within 30 days.

**Given** the first real deploy on the new pin
**When** it runs on each host
**Then** its tickets, Reservation and events appear with the new `hub_version`.

---

## Epic 3: A busy phone doesn't fail the deploy

### Story 3.1: Peek at the S26 without disturbing a Lease

As a deploy run,
I want plan to learn the S26's installed version while someone holds a Lease on it,
So that I neither block behind the Lease nor break the leaseholder's adb session (FR-9).

**Acceptance Criteria:**

**Given** `adb` held by a Lease when plan runs (or the gate's `quickS26` probe)
**When** the installed version is needed
**Then**
- the read takes no lock;
- it runs only `adb -L tcp:127.0.0.1:<port> -s <id> shell dumpsys package <pkg>`, with `RUNNER_TRACKING_ID` blank, using the Lease's recorded `adb_port` and `adb_id`, or the default server otherwise;
- it never runs `start-server`, `connect` or mDNS (AD-13).

**Given** no adb server or no device
**When** the Peek runs
**Then** it returns `unknown`, plan proceeds, and the downgrade guard falls to install time (`android.mjs:126`).

**Given** `adb` held by another deploy's Job Hold
**When** plan needs it
**Then** plan waits in the Queue through its run's Reservation.

**Given** the hermetic suite
**When** it runs against a fake exec
**Then** it shows that no `start-server`, `connect` or mdns argv is ever issued under a Lease.

### Story 3.2: A blocked Android delivery goes pending

As Jarad,
I want an Android deploy whose S26 stayed busy to finish green, with the delivery pending,
So that a long Lease never turns a good build red (FR-30).

**Acceptance Criteria:**

**Given** `android.mjs` waiting on `adb`
**When** `HUB_LOCK_TIMEOUT` is thrown
**Then**
- the delivery is marked `pending`, with the public reason `S26 busy`, in `latest.json`, using the frozen status enum and adding no keys;
- the receipt names the blocking Holds;
- a `timeout` event is appended with `reason: delivery-pending` and `blocked_by`;
- the run's Reservation is released (story 2.6).

**Given** a contention-pending Android build
**When** the run continues
**Then** the job succeeds, so the Play upload and the release proceed. The receipt test asserts this as an intended change.

**Given** an older catch-up reading `latest.json`
**When** it parses the pending record
**Then** it accepts it, because no extra keys were added.

**Given** the hermetic suite
**When** it runs
**Then** it pins the event sequence for a pending delivery: claim, request, timeout(delivery-pending), Reservation release.

### Story 3.3: The catch-up delivers contention-pending builds in its turn

As Jarad,
I want the catch-up to install a build that went pending because the S26 was busy, as soon as it's that build's turn,
So that pending builds don't sit indefinitely behind a busy queue (FR-30, FR-7).

**Acceptance Criteria:**

**Given** the policy `queue` block
**When** this story lands
**Then** it adds `catchup_attempt_s` and `catchup_pending_wait_min`.

**Given** a pending build marked `S26 busy`
**When** the catch-up runs
**Then** it enqueues on `adb` as `hub-job` with `delivery {repo, run, version}` and waits up to the policy's `catchup_pending_wait`, bounded by its pass limit.

**Given** no contention-pending build
**When** the catch-up runs
**Then** it waits only the short policy attempt.

**Given** either wait runs out
**When** it times out
**Then** it removes its ticket, reports `HUB_CATCHUP_IDLE`, and writes a `hub-job` `timeout` event, never a deploy one.

**Given** the catch-up gets the lock
**When** it installs
**Then** the delivery becomes `installed`, and its `acquire` and `release` events carry `delivery`.

### Story 3.4: A newer installed build is refused with a name

As Jarad,
I want to know who installed a newer build when the catch-up refuses to downgrade,
So that a skipped delivery is explained, not silent (FR-30).

**Acceptance Criteria:**

**Given** a pending build whose planned version is now below the version installed on the device (the catch-up's `ahead` path, `catchup.mjs:148/377/656`)
**When** the catch-up evaluates it
**Then**
- it writes a `refused` event naming the Lease holders on that lock since the build's pending event, read from the Event Log;
- `latest.json` records `skipped` with a coarse public reason and no holder names;
- the version is not reused.

**Given** no Lease holders since the pending event
**When** it refuses
**Then** the event says `installed_by: unknown`.

### Story 3.5: iOS contention is red, and says who

As Jarad,
I want an iOS job that couldn't get the `ios-lane` in time to fail clearly, naming who held it,
So that the known v1a gap (Open Question 1) is visible and countable rather than mysterious.

**Acceptance Criteria:**

**Given** `ios.mjs` waiting on `mac-ios` before the build
**When** `HUB_LOCK_TIMEOUT` is thrown
**Then**
- the iOS job fails with that code;
- the job summary names the holders and the waiters ahead;
- a `timeout` event is written on the Mac with `reason: ios-lane-contention`.

**Given** the second take (store IPA, `ios.mjs:390`)
**When** it times out after the iPad install succeeded
**Then** the iPad delivery stays `installed`, not `failed`, and only the store step reports the contention.

**Given** the job's deadline
**When** it is computed
**Then** it reserves the allowance for both takes (story 2.4).

---

## Epic 4: Know where you stand and how long it'll be

### Story 4.1: An honest ETA range from history

As a waiter,
I want an ETA range built from real past holds,
So that I can decide whether to wait or go elsewhere (FR-15).

**Acceptance Criteria:**

**Given** a new pure module `tools/ci/lib/eta.mjs`
**When** `eta(queueView, events, policy, now)` is called
**Then** it returns `{lo_ms, hi_ms, low_data}`
**And** each bound is the 25th or 75th percentile of the matching past holds, combined along the Queue:
- the current holder's expected remaining time;
- plus the expected hold time of each blocking entry ahead.

**Given** a Job Hold
**When** its expected length is estimated
**Then** it matches on repo and job.

**Given** a Lease
**When** its expected end is estimated
**Then** it is start plus the median share of `for_ms` that past Leases of the same Claimant kind used, clamped to `expires_at`.

**Given** the policy `queue` block
**When** this story lands
**Then** it adds `eta_window_days` and `eta_low_data_min_holds`.

**Given** fewer matching holds than the policy's low-data threshold
**When** the ETA is computed
**Then** the range widens to the stated durations or `deadline_at`, and `low_data` is true.

**Given** an enqueue
**When** the ticket and `request` event are written
**Then** both carry the ETA computed at enqueue.

**Given** the policy window
**When** `eta()` reads history
**Then** it reads only events inside the window. A table of fixture tests covers empty, sparse and rich history.

### Story 4.2: Position and ETA in the wait line

As a deploy job or `hub-device lease --wait` user,
I want my position and ETA printed where I'm already looking,
So that a wait is never a black box (FR-16).

**Acceptance Criteria:**

**Given** a waiter on a Queued lock
**When** its position changes, or its recomputed ETA moves by more than a minute
**Then** it prints `HUB_LOCK_WAIT <name> held by <holder> position=<n> eta=<lo>-<hi>[ low-data]`: to the job log for deploy jobs, and to stderr for `hub-device lease --wait`.

**Given** a waiter whose position and ETA are stable
**When** it polls
**Then** nothing is printed, and the ETA is recomputed at most every 5 minutes.

**Given** stdout of a successful `lease`
**When** it ends
**Then** it still contains only `export` lines.

**Given** the old wait-line test
**When** it is updated
**Then** it is named in the change as the intended text change (FR-13).

### Story 4.3: Status shows every waiter, Reservations and ETAs

As Jarad or an agent,
I want `hub-device status` to list deploy jobs, the catch-up and Reservations with positions and ETAs,
So that I can see the whole line for a device at a glance (FR-8, FR-13).

**Acceptance Criteria:**

**Given** a deploy job waiting on `adb`
**When** `hub-device status` runs
**Then** its waiter row shows repo, run and job (never `undefined`), with its position and live ETA.

**Given** live Reservations
**When** status runs
**Then**
- a Reservations section prints only when non-empty, showing run key, place, grace state and expiry;
- the existing nine-line fixture (`hub-device.test.mjs:888`) is unchanged when nothing new is present.

**Given** `hub-device status --json`
**When** it runs
**Then** it adds `waiters[].kind/repo/run/job/position/eta` and `reservations[]` as new keys only, with no renames or removals.

**Given** `hub-device release <id>`
**When** `<id>` is a `job:` id
**Then** it refuses with exit 2 and a `HUB_DEVICE_*` line naming the run to cancel instead.

**Given** status runs
**When** it computes ETAs
**Then** it stays read-only and answers in under 200 ms on big-chungus with a month of fixture events.

**Given** stories 4.1–4.3 are on main
**When** they ship
**Then** they ship as a hub release through `mise run release -- X.Y.Z`, followed by `hosts:install` on both hosts.
