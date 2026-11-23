---
review: rubric
target: ARCHITECTURE-SPINE.md (Hub Resource Registry v1a, draft 2026-11-23)
reviewer: rubric walker
date: 2026-11-23
scope: v1a only (PRD §7.1)
verdict: REVISE. The paradigm is right and most ADs are good. Five high findings would let epics diverge or break mutual exclusion, so it is not ready to break into epics.
---

# Rubric review: Hub Resource Registry v1a spine

## Verdict

**Revise before epics.** "A shared library over a file-system protocol" is the right paradigm, and it ratifies the brownfield well. Most cited lines check out, and AD-4, AD-5, AD-8, AD-11, AD-13 and AD-14 close real gaps the sweep found. But the core of v1a has holes that different epics will fill in different ways:

- the serving order (who is "position 0" once Reservations exist);
- ticket liveness precedence;
- reclaim atomicity under "exactly once";
- how the grace period stays consistent across pins;
- which v1a pieces must ship in the same release.

Each one is an inter-version or inter-unit divergence of exactly the kind the spine exists to prevent (AD-2's "Prevents").

## Checklist walk

| Rubric item | Result | Notes |
| --- | --- | --- |
| Fixes the real divergence points for the epics below it, misses none | **Partial** | Missed: one definition of serving order (F1), event-to-atomic-step mapping (F4), the `emulator` gate queue (F6), the mechanism for announce's ssh release (F7), and which pieces must ship together (F3). |
| Every AD's Rule is enforceable and prevents its stated divergence | **Partial** | AD-3 (precedence, F2), AD-6 (position 0 against a post-grace Reservation, F1), AD-7 (grace read from policy, F5), AD-9 (reclaim, F4), AD-16 (updateLease field rule, F8) and AD-19 (timer cannot fire during spawnSync, F10) do not hold as written. |
| Nothing under Deferred lets two units diverge | **Mostly pass** | The deferrals are clean. Not deferred but should be: Pool queueing for `phone` (it stays try-based in v1a), so the ETA epic does not build a Pool ETA (F19). |
| Named tech is verified-current | **Pass** | Node 24.22.3 "Krypton" is the newest 24.x LTS (nodejs.org dist index, release 2026-11-10, checked today). Note: big-chungus resolves `node = "24"` to 24.6.0 (F20). |
| Ratifies rather than contradicts the brownfield | **Partial** | Cites verified (table below). Contradictions: AD-1, AD-16, AD-17 and the AD-3 body (F8). AD-5's rationale is wrong (F16). AD-10 duplicates an existing resolver (F15). |
| Covers PRD v1a capabilities | **Mostly** | Gaps: FR-30 consequence 3 (catch-up `ahead` on a contention-pending build, F11); FR-8 "never `undefined`" for the existing WAITERS row (F8); FR-17's emulator-Lease sequence (F6); FR-15's stated-duration input (F4). |
| Operational envelope decided, deferred or asked | **Partial** | Deployment: mostly decided (per-host lock dirs, Mac-only writers, `host_id`). Missing: which release dir announce runs on the Mac (F7), and durability of the Event Log location (F9). Rollout: switch points named. Missing: freeze-set grouping and the order of `hosts:install` against the `v1` move (F3). Observability: markers decided. Missing: a grace event, so SM-C4 cannot be measured (F5), and how Jarad reads the log in v1a (F9). |

## Cited-claim verification

| Spine claim | Code | Result |
| --- | --- | --- |
| AD-5 catch-up regexes at `catchup.mjs:469`, `:591` | `/host lock adb is held/` :469, `/host lock mac-ios is held/` :591 | ✓ lines |
| AD-13 newer-device refusal `android.mjs:126` | :126 throws on `before.versionCode > planned` | ✓ |
| OQ-1 `mac-ios` wraps build/export/install `ios.mjs:276` | lock :276-344, `hook('ios.device')` :286 inside | ✓ |
| AD-2 `listLocks` filters to `*.lock` | `lock.mjs:305` | ✓ |
| AD-13 Lease records `adb_port`/`adb_id` | `hub-device.mjs:156-157,177` | ✓ (`adb_id` null on `--no-connect`) |
| AD-14 frozen status enum | `latest.mjs:18` | ✓ |
| AD-12 / OQ-1 job timeouts | `mobile-deploy.yml` :196 (20), :258 (45), :377 (120) | ✓ |
| AD-10 `HUB_REF` is set by the action | `actions/hub/action.yml:209` = `github.action_ref` | ✓ (it is the inner `actions/hub@vX.Y.Z` the reusable workflow pins, not "the caller's" `@v1`) |
| AD-17 "stdout carries only `export` lines" | `hub-device.mjs:245` (`HUB_DEVICE_AWAY`), :342-441 (`RELEASED`/`CANCELLED`/`NOT_HELD`), :293/:323 JSON, :528-562 status | ✗ |
| AD-16 "`updateLease` keeps metadata-only changes" | `emulator.mjs:595-596` rewrites `expires_at`, `holder_pid`, `holder_process_start` through `updateLease` | ✗ (sweep fact "nothing calls it to change expires_at" is wrong) |
| AD-1 lock.mjs is the only mutator under `HUB_LOCK_DIR` | `emulator.mjs:191-202,263,272,466` write `<lockdir>/emulators/*.json`; `emulator-pool` (:66); `inventory.mjs:40` reads `managed.json`; `emulator.mjs:329-331` parses gate tickets | ✗ |
| AD-5 "pinned catch-ups misread a queued timeout" | `catchup.mjs:43` imports `../ci/lib/lock.mjs` relatively, so the catch-up and its lock library are always the same release | ✗ rationale (rule still fine) |
| AD-19 holder touches `owner.json` once a minute while it holds | `exec.mjs:59` `hook()` is `spawnSync` (the Xcode build inside `mac-ios`); `adb.mjs:93` install is a 600 s sync call | ✗ (timer cannot fire) |
| AD-19 / stale age | `lock.mjs:44` ages the lock **directory** mtime, not `owner.json` | note: the touch does not change what old pins measure |

## Findings

Severity: **critical** blocks v1a's goal; **high** lets units or pins diverge, or breaks exclusion; **medium** is a real gap with a bounded blast radius; **low** is a precision or consistency issue.

### F1 [high] AD-6 / AD-7: the serving order is not defined once, and its literal reading deadlocks

- **Gap 1: "position 0" against a post-grace Reservation.** AD-6 says position comes from sorting tickets "together with live Reservations", and "only position 0 may `mkdir`". AD-7 says a post-grace Reservation "keeps its place but never blocks a free Resource again". Read literally, a post-grace Reservation at the head stays at position 0, so no ticket is ever position 0 and the Resource is blocked until the run asks or the ceiling (3 h) passes. That contradicts AD-7.
- **Gap 2: double counting.** A Reservation whose run is asking also has a back-dated ticket at the same `reserved_at` (AD-6). Unless one of them is dropped, every waiter behind it counts it twice, and ETAs count its hold twice.
- **Gap 3: chained grace.** It is not said whether the second Reservation in line gets its own grace once the first is post-grace. "At the head" can mean the literal head or the effective head. Two implementers will pick differently, and one of them idles the Resource 10 min per queued run.
- **Gap 4: no single implementation.** Today `hub-device status` computes position as the `listWaiters` index (`hub-device.mjs:507`). Nothing in the spine makes it use the merged order, so status, `HUB_LOCK_WAIT` and the lock library can disagree.
- **Fix.** Add one exported `queueOf(name, seams)` to `lock.mjs` that returns `{display: [...], servingHead}`. Every caller uses it, including status, eta and extendLease. State three rules:
  1. A Reservation whose run has a live ticket is represented only by that ticket.
  2. A non-asking Reservation is skipped for `servingHead` once its grace ended, but stays in `display`.
  3. Grace applies only to the **first** live Reservation in `display` order. Or decide chained grace explicitly and log it as SM-C4 cost.

### F2 [high] AD-3: liveness precedence is ambiguous and can make a ticket immortal

- **Two overlapping rules.** AD-3 has "a ticket with a pid is live while that process lifetime is alive" and also "`remote`, and any kind this version does not know, is live until `expires_at`, and is live with no `expires_at`". It never says which rule wins.
- **The deadlock.** Today's lease tickets have no `kind` at all (`lock.mjs:205`). If an implementer treats a missing kind as "unknown" and checks kind before pid, then a dead agent's pre-v1a ticket, or any malformed ticket, is live forever. It sits at position 0, and under "only position 0 may mkdir" it blocks `adb` for every v1a+ pin until someone deletes it by hand.
- **The Mac.** Separately, `processStart` returns null when `ps` fails or times out (`lock.mjs:134-136`). Today that makes a live ticket stale, so a waiting iOS job gets `HUB_LEASE_CANCELLED` "lost its place" and goes red. The conventions row caps the spawn rate but does not fix this.
- **Fix.** Write the precedence into AD-3:
  1. With `pid` and `process_start`, the pid rule applies whatever the kind. It is stale only on positive evidence: ESRCH, or a readable start that differs. An unreadable start keeps the ticket.
  2. With no pid, it is live while `expires_at > now`.
  3. With no pid and no `expires_at`, it is stale after 60 s, like today's unparseable files.
  4. A missing `kind` means `lease`, format 0.
  5. A writer whose own `processStart` is null refuses to enqueue rather than write a ticket that old pins prune at once.

### F3 [high] AD-2 / AD-3 / Roll-out: the freeze set is not tied to one release, and `hosts:install` order is open

- **Freeze set.** AD-3 freezes the ticket format "at the v1a release". But PRD §7.1 makes every slice "a hub release that ships on its own", standing approval means agents cut a release per epic, and addendum §B.3 warns that "the serving rule and the reservation format must ship in the same release as queue-joining `withLock`; any later addition is ignored forever by the pins in between". If the epics land as v1.3.0, v1.3.1, ..., the first queue-joining pin may ship without Reservations, `host_id`, try semantics or the unknown-kind rule, and every rerun of that pin ignores them for 30 days.
- **`hosts:install` order.** The roll-out line names the switch points but not the order. Until `hosts:install`, the old `hub-device` (v1.2.43):
  - ignores Reservations and the 60-minute cap, so it can still lease `adb` for 48 h;
  - prints `undefined` rows for job tickets (`hub-device.mjs:553`);
  - shows positions that differ from the deploy job's `HUB_LOCK_WAIT`.
- **Fix.** Add a "v1a freeze set" rule that must all land in the **first** release whose `withLock` joins the Queue:
  - ticket v1 body plus the liveness precedence;
  - Reservation format, `queueOf`, grace record and passthrough;
  - `host_id`;
  - try semantics;
  - `HUB_LOCK_TIMEOUT` on `withLock`.

  The Event Log (AD-9/AD-10) may ship in an earlier release. Add to the roll-out: that release runs `hosts:install` on big-chungus and the Mac before `release.mjs` moves `v1`, and its notes state "fairness only among runs on this pin or later".

### F4 [high] AD-9 / Event shape: exactly-once fails at reclaim, and the events lack fields v1a's own ETA needs

- **Reclaim breaks exactly-once.**
  - `reclaim()` reads, compares, then runs `rmSync(path, {recursive, force})` (`lock.mjs:58-63`). With `force`, both of two racing reclaimers "succeed", so two `reclaim` events are written.
  - Worse, the second `rmSync` can delete the lock the first reclaimer just took, which puts two holders on the S26 (addendum §A lists this race). v1a adds more pollers (job and hub-job tickets), so the race gets more likely.
  - AD-9 lists `rename` as an atomic step but never requires reclaim to use it.
- **Event-to-step mapping is undefined.**
  - When an expired Lease is reclaimed, is that `expiry` or `reclaim`?
  - What atomic step writes `claim`?
  - Who deletes an expired Reservation file and writes its `expiry`?
  - FR-17 demands "exactly the expected event sequence" for five scenarios, but the spine defines none.
- **Missing fields.** The event shape has no stated duration (`for_ms` / `expires_at`). AD-18 needs it ("Leases by kind times the share of their stated duration used") and so does FR-15. It also has no field for what was asked (`s26` against `phone` against `emulator`), which FR-19 needs to split pinned from flexible demand. And `claimant.kind` has no agent/person distinction (glossary), though FR-15 groups Leases "of the same Claimant kind". History from v1a cannot be backfilled.
- **Fix.**
  1. Make reclaim a rename-aside: `rename(<name>.lock, <name>.lock.reclaim-<pid>-<rand>)`. Only one rename wins. The winner checks the moved owner against the judged one, then removes it and writes the event. `*.lock.reclaim-*` does not end in `.lock`, so `listLocks` ignores it.
  2. Add an event table (event, triggering atomic step, writer) and the five canonical FR-17 sequences.
  3. Add `for_ms`, `expires_at`, `request` (the word asked) and `claimant.kind ∈ {deploy, hub-job, agent, person}` to the event shape. That is a separate field from the ticket `kind`.

### F5 [high] AD-7 / AD-11: grace comes from each pin's policy, and the grace stamp can bring a released Reservation back

- **Pins disagree.**
  - AD-11 keeps the grace duration only in `policy.json`. The Reservation stores only `grace_started_at`.
  - Three versions act on one Reservation: the deploy pin, the catch-up's `current`, and `hub-device`'s release dir. If any of them carries a different `queue.grace`, they disagree on whether grace has ended: one idles the Resource and another serves past it.
  - The PRD assumption says the grace is "stored in the Reservation record". The ceiling is already stored as `expires_at`; grace needs the same treatment.
- **The stamp can resurrect.** Grace is stamped by rewriting the Reservation (tmp + rename) after reading it. If android's `finally` unlinks the Reservation between that read and that rename, the rename brings it back. This is likely because android releases the lock and the Reservation in the same moment a poller sees "free, Reservation at head, run not asking". The run is finished, yet it holds a phantom head place for up to 3 h and idles the S26 10 min.
- **Nothing to measure.** There is no `grace` event, so SM-C4 ("idle while reserved") cannot be measured from history once the Reservation file is deleted.
- **Fix.**
  1. Store `grace_ms` (and `ceiling_ms`) in the Reservation when it is created. Readers use the stored value.
  2. Stamp grace by `wx`-creating a sibling `<key>.grace` that holds `{grace_started_at}`. That is create-once and atomic. Its creator writes a `grace` event.
  3. In `finally`, unlink the Reservation and its `.grace` before releasing the lock.

### F6 [medium] AD-4 / AD-9: the emulator Pool's queue (`emulator` gate) is not in QUEUED

- **Where emulator waits happen.** Emulator requests wait FIFO on the `emulator` gate lock (`emulator.mjs:29,486`), and slot takes are `waitMs: 0` tries (`emulator.mjs:504`).
- **What breaks.** `QUEUED = adb, s24, mac-ios, emulator-<n>` leaves out the gate. AD-9 says events cover only Queued locks, so an emulator Lease logs no `request` and no `waited_ms`, and emulator waiters can get no ETA. That misses FR-15 and FR-16 for `lease emulator --wait` and FR-17's "an emulator Lease" sequence.
- **Fix.** Add `emulator` (the gate) to QUEUED as the Pool's queue name. Record slot acquires with the gate request's `id`, so `waited_ms` comes from the gate. Use the existing `isEmulatorLock` (`emulator.mjs:31`) for the matcher, so that `emulator-reaper` cannot match by prefix.

### F7 [medium] AD-7: announce's ssh release names no mechanism or release dir

- **The gap.** "`announce` releases both as a backstop, locally and over ssh to `hub-mac`." It does not say what runs on the Mac. The options diverge:
  - the Mac's `current` may be pre-v1a when the iOS lane was skipped after preflight-ios reserved (`plan.mjs:306-311`), since only a real iOS job advances it (`ios.mjs:402`);
  - a bare `ssh rm` violates AD-1 and writes no event;
  - piping code over stdin duplicates the protocol.
- **Fix.** Name it:
  1. announce runs `ssh hub-mac node ~/.local/share/mobile-deploy-hub/releases/<HUB_REF>/tools/<cli>.mjs reservation release <key>`;
  2. preflight-ios installs that release dir (`installCurrent` minus the symlink move) before it writes the Reservation;
  3. on ssh failure announce logs `::warning::HUB_RESERVATION_ORPHANED`, and the ceiling ends the Reservation.

### F8 [medium] AD-1 / AD-3 / AD-16 / AD-17 contradict the brownfield code

- **AD-1.** The emulator pool writes and deletes `<lockdir>/emulators/*.json` and reads `<lockdir>/emulator-pool` and `managed.json`. It also parses gate tickets by hand (`emulator.mjs:329-331`). **Fix:** scope AD-1 to `*.lock`, `*.queue`, `*.reservations` and `events/`, name `emulators/`, `emulator-pool` and `managed.json` as emulator-owned, and migrate `isEmulatorLease`'s ticket parse to `listWaiters`.
- **AD-3 body.** The frozen body lists `id` but not `lease_id`. `releaseLease` (`lock.mjs:272`), `hub-device.mjs:133,385,507,553` and `emulator.mjs:331` all match on `lease_id`, and AD-2 says existing keys stay. **Fix:** list `lease_id` in the frozen body for `kind: lease`, and require it to be absent on job and hub-job tickets.
- **AD-16.** `emulator.mjs:595-596` re-bases `expires_at` and `holder_pid` through `updateLease` after boot. It normally moves `expires_at` earlier, but later when `forMs` is near 48 h because of the cap at :504. **Fix:** "`updateLease` rejects `expires_at` later than the current one and any change to identity keys; `extendLease` owns later moves; the emulator re-base calls `rebaseLease` (earlier-only) or `extendLease`."
- **AD-17.** stdout also carries `HUB_DEVICE_AWAY`, `HUB_DEVICE_RELEASED`, `HUB_DEVICE_CANCELLED` and `HUB_DEVICE_NOT_HELD`, the `--json` lease object and all status output. The existing WAITERS row (`hub-device.mjs:553`) prints `undefined` for job tickets, which violates FR-8. **Fix:** "on a successful `lease`, stdout is only `export` lines; every stdout line that exists today stays; new output goes to stderr; job and hub-job tickets render in the existing WAITERS section by kind (repo, run, job) and never read `lease_id`, `holder` or `why`."

### F9 [medium] AD-9: a durable, never-compacted Event Log under `~/.cache`

- **Wrong directory class.** FR-18 says every event stays queryable and nothing is deleted in v1. Yet `<lockdir>/events/` sits under `~/.cache/mobile-deploy-hub/locks` on both hosts. That is XDG cache, which disk-maintenance treats as rebuildable (Tier A). The catch-up journal already uses `$XDG_STATE_HOME/mobile-deploy-hub` (`catchup.mjs:198-239`).
- **No v1a reader.** v1a also has no reader besides `jq` on each host, and `HUB_EVENT_LOG_FAILED` shows up only in job logs.
- **Fix.** Either move the log to `$XDG_STATE_HOME/mobile-deploy-hub/events/`, with an `HUB_EVENTS_DIR` seam tests pass explicitly, or keep it and add it as Tier B ("never sweep") in the disk-maintenance machine notes for big-chungus and the Mac. Then state the v1a read path (a `jq` recipe in the README, or a read-only `hub-device events`) as decided or deferred.

### F10 [medium] AD-19: the once-a-minute `owner.json` touch cannot run during the longest holds

- **Why it cannot run.** `hook()` is `spawnSync` (`exec.mjs:59`) and runs the Xcode build inside `mac-ios` (`ios.mjs:286`). The adb install is a 600 s sync call (`adb.mjs:93`). An unref'd in-process interval does not fire while the event loop is blocked.
- **Consequence.** For a holder that dies mid-build, `last_alive_at` can be stale by the whole build (tens of minutes), which undercuts FR-17 consequence 3. Any future rule that reads a stale touch as "dead" would also reclaim live iOS builds.
- **Fix.** State that `last_alive_at` is a lower bound. Touch it before and after each sync step inside a Hold, and forbid freshness-based liveness. Or require the sections inside a Hold to use async spawn.

### F11 [medium] FR-30 consequence 3 is neither decided nor deferred

- **The gap.** A contention-pending build is installed by the catch-up. If the installed version has since moved above it, `androidPlan` gives `ahead`, and `transition()` records `skipped` with `event:false` (`catchup.mjs:148,377,656`). That is silent: no refusal and no "who installed it". The run was already announced `.completed`.
- **Fix.** Either decide that the catch-up writes a `reason` naming the holders since the Peek, taken from the Event Log, and emits a pending-resolution event, or list it under Deferred or Open Questions as a PRD deviation.

### F12 [medium] AD-12: the deadline formula ignores work after the Hold

- **The problem.** `deadline = job_start + job_timeout - margin - hold_allowance[lock]` is keyed by lock only.
  - On iOS, take 1 (build, export and install, ≤40 min) can wait until its deadline and leave no time for take 2 (`ios.mjs:390`, store IPA, ≤40 min) or the TestFlight upload.
  - On `adb`, one allowance has to cover both plan's hold (180 s phone wait) and android's (600 s install), which needlessly shrinks plan's 20-minute budget.
- **Fix.** Key the allowance by `(job, lock)`. Add `after_ms[job]`, the remaining work after the last Hold, so `deadline = job_start + timeout - margin - hold_allowance[job,lock] - after_ms[job]`. On iOS, take 1 also subtracts take 2's allowance when `config.testflight && spec.store.build`.

### F13 [low] AD-15: the catch-up's "turn" is illusory under sustained contention

A catch-up attempt of a few seconds every 120 s or 300 s (`catchup.mjs:467,589`, policy `catch_up`) rejoins the back each time. Back-to-back Leases can starve a pending install indefinitely; this is the sweep's design risk at line 98. The PRD chose the short attempt, so the spine follows it, but it should say so and name SM-C5 as the guard. Optional fix: when android goes pending, it keeps the run's Reservation, and the catch-up claims through it as a hub job until the ceiling.

### F14 [low] AD-17 / AD-18: the ETA trigger and the status ETA are inconsistent

AD-17 prints the wait line "when the ETA moves by more than a minute", but AD-18 recomputes only at enqueue and on a position change, so the ETA can never move on its own. Nor does the spine say whether `status` shows the ticket's stored enqueue `eta` or recomputes (a scan). **Fix:** drop the ETA-move trigger or add a recompute on a holder change; say that status shows `ticket.eta` plus its age; and pin the `eta=` range format (for example `eta=20m-30m[,low_data]`).

### F15 [low] AD-10 duplicates an existing resolver

`hubRef()` in `tools/ci/lib/receipt.mjs:20-23` already resolves `HUB_REF`, then the `_actions/<owner>/<repo>/<ref>/` path. AD-10 adds `hubVersion()` in `events.mjs` without the `_actions` fallback. **Fix:** extend `hubRef()` with the `releases/<ref>/tools/` realpath match, and have events call it, so there is one source.

### F16 [low] AD-5's rationale is wrong; the rule stands

The catch-up imports its own release's `lock.mjs` (`catchup.mjs:43`), so it never reads another version's message. The real reasons to keep `host lock <name> is held` are the in-release regexes during migration, the pinned tests (`lease.test.mjs:107`, `hub-device.test.mjs:119,225,292`) and agents parsing `HUB_DEVICE_BUSY` stderr. **Fix:** correct "Prevents". Also require the catch-up's regexes at :469 and :591 to move to `.code` in the same change.

### F17 [low] OQ-1 cites a cap that cannot apply in v1a

`lease ipad|mac` is v1b, so no Lease can hold `mac-ios` in v1a and the 60-minute cap does not bear on iOS contention. In v1a the only `mac-ios` contention is among deploy jobs and the iPad catch-up. Reword.

### F18 [low] Gate Reservation conditions are unstated

The spine does not say whether dry runs reserve. `release.mjs` runs one strict dry run per app, and each dry run's Reservation can idle the S26 for the grace period. It also does not say whether an iOS-only run reserves `adb`. **Fix:** "the gate reserves `adb` only when the android lane will install (real runs; dry runs queue as plain arrivals)", or the opposite, but decided.

### F19 [low] Pool queueing for `phone` should be deferred explicitly

AD-6 makes `phone` a try, which is right for v1a. But UJ-2 ("waits in the phone Pool's Queue at position 1 with an ETA") is v1b (FR-6). Add it to Deferred so the ETA and status epic does not build it.

### F20 [low] Stack and conventions details

- Hosts run Node 24.6.0 under `node = "24"`. Say "any 24.x; use no API newer than 24.6", or have `hosts:install` run `mise upgrade node`.
- "lease polls ≥ 1 s, job polls ≥ 2 s" should say *defaults*, because tests run with `pollMs: 5` (`lease.test.mjs:19`, `HUB_DEVICE_POLL_MS=5`).
- The seams table should name a timer seam for AD-19, and a `processStartedAtMs` seam separate from the identity token `processStart`, which on Linux returns clock ticks (`lock.mjs:131`).
- The layer table says `eta.mjs` imports nothing, but the diagram has `eta --> events`.
- The memlog says the Reservation file is `<repo-slug>--<run_id>.json` while AD-7 says `<owner>--<repo>--<run_id>.json`, and the memlog's seam list has `fetchImpl` while the spine's does not. Align them.
- Plan's behaviour on `HUB_LOCK_TIMEOUT` behind another deploy's Job Hold should be stated: red before the bump, no version spent.
- `pages.mjs:35` renders pending as "installs when it is back (S26 busy)". Mention it or adjust the wording.

## What is good, and should stay

- The paradigm and the layer table: one protocol owner, with the on-disk layout as the contract between pins.
- AD-5's coded timeout with the legacy prefix, and AD-14's coarse public reason with no new `latest.json` keys. Both match the sweep's privacy and NFR-2 constraints exactly.
- AD-6's back-dated Reservation ticket. Every pin from v1.2.26 on that sorts by file name honours it with no code change.
- AD-8's `host_id`, which fixes the Mac's mDNS drift for new-vs-new records.
- AD-12's start time from `Runner.Worker` and the conformance test on `HUB_JOB_TIMEOUT_MINUTES`.
- AD-13's Peek constraints: an existing server only, a blank `RUNNER_TRACKING_ID`, and the `android.mjs:126` guard as the backstop.
- OQ-1, which surfaces the FR-30 iOS deviation to Jarad instead of hiding it.
