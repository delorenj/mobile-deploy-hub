# Review: addendum reconciled against the v1a spine

- **Reviewed:** `ARCHITECTURE-SPINE.md` (draft, 2026-11-23, 19 ADs) and `.memlog.md`
- **Against:** `prds/prd-mobile-deploy-hub-2026-11-21/addendum.md` §A, §B.1-B.11, §C
- **Code checked at:** HEAD `c63c713` (v1.2.43). Every line reference below was read in this pass.
- **Scope:** v1a only (PRD §7.1). v1b and v1c items are listed only to confirm that the spine defers them cleanly, or that v1a has to record something now for them to work later.

## Verdict

**Lands with revisions.** The spine lands every item on the addendum's v1a list (§B.10 step 1). In several places it beats the addendum with code-backed choices:

- Reservations keyed by run.
- Coded timeouts that cover both of `acquireLease`'s message shapes.
- A job-start source for the wait deadline.
- A Peek that cannot start an adb server.
- A rotatable Event Log directory.
- `phone` passes as true tries.

It also contradicts or drops six addendum points that v1a needs:

1. The `reclaim` race fix. Without it, AD-9's exactly-once rule cannot hold.
2. Grace stored in the Reservation record (PRD FR-9's assumption).
3. History of Pool requests (`phone`, and the `emulator` gate).
4. Several event fields and the Reservation-lifecycle events that the spine's own ETA and SM-C4 need.
5. `lease_id` in the frozen ticket body.
6. The "avoid replace-latest pending" rule. The spine dismisses it as outside the hub, but the concurrency groups are in the hub's own workflow.

All six are small edits to existing ADs. None needs a new AD or changes the paradigm.

Legend:
- **LANDS**: the spine adopts it as written.
- **LANDS+**: the spine adopts it and its version is better.
- **CONTRADICTS (spine better)** or **CONTRADICTS (addendum better)**: the two disagree, and the label says which is right.
- **DROPS (deferred)**: correctly left to v1b, v1c or v2.
- **DROPS (gap)**: v1a needs it and the spine does not have it.

---

## §A Where today's behaviour comes from

### Lock model

| # | Addendum fact or mechanism | Spine | Evidence and notes |
|---|---|---|---|
| A1 | A lock is an atomic `mkdir <name>.lock` plus `owner.json`, in `$HUB_LOCK_DIR` or `~/.cache/...` | LANDS | AD-1 and the Structural Seed. Confirmed at `lock.mjs:16,83-84`. |
| A2 | Lease record fields; `MAX_LEASE_MS` 48 h | LANDS | AD-2 keeps every existing key. AD-16 adds the 60-minute deploy-target cap (FR-31). |
| A3 | FIFO tickets `<ms>-<counter>-<pid>.json`, polled every 1 s, pruned on every poll (`:213`) | LANDS | AD-3 keeps `<ms15>-<ctr6>-<pid8>` (`lock.mjs:201`). The Consistency table sets a poll floor of at least 1 s for leases and at least 2 s for jobs. |
| A4 | `staleWaiter` (`:139-146`): foreign host, no pid or a dead pid means stale; no covering test | CONTRADICTS (spine better, with two defects) | AD-3 adds liveness by kind (`remote` and unknown kinds live until `expires_at`), and AD-8 adds `host_id`. Both serve v2 and the Mac's hostname drift. The "one test per AD Rule" convention covers the missing test. **Defect 1:** "live with no `expires_at`" lets one pid-less ticket of an unknown kind block the head forever, on every v1a pin, because only position 0 may `mkdir` (AD-6). **Defect 2:** the AD-3 body drops `lease_id`. See X1. |
| A5 | Owner staleness: a foreign lease is judged by expiry, a foreign job after 4 h (`:49,:53`); a dead Mac job lock blocks for 4 h | LANDS | AD-8's `host_id` stops mDNS drift (`mommymac.local` becoming `mommymac-2.local`) from making a live Mac owner foreign between new versions. Old pins keep the 4 h rule, which the spine accepts. |
| A6 | `withLock` retries `mkdir` with no queue, so it starves; the wait budgets are 20/20, 20/45 and 40+40/120 min | LANDS+ | AD-4 makes it join the queue. AD-12 sets the deadline to job start + job timeout − margin − hold allowance. The addendum gave only an input for the timeout; the spine adds a start-time source, which the brownfield sweep showed no input or context provides. **Caveat:** `processStart()` returns `/proc/<pid>/stat` field 22, which is ticks since boot (`lock.mjs:131`), on Linux and a `ps:` string on the Mac. It is an identity token, not a wall time. AD-12 needs a new `processStartedAt(pid)` seam (Linux: `btime` + ticks/CLK_TCK; Mac: parse `lstart`), and the Seams row should list it. |
| A7 | `withLock` also guards internal locks (`s3-*`, `s3-index`, `emulator-reaper`) | LANDS | AD-4: `QUEUED` is the only queued set, and the rest stay on the bare path with no events. |
| A8 | The catch-up and the reaper parse the wording (`catchup.mjs:469,591`; `emulator.mjs:312,342`) | LANDS+ (rationale off) | AD-5 keeps the `host lock <name> is held` prefix on **both** shapes. The second shape, `has N waiters ahead` at `lock.mjs:251`, does not match the catch-up regexes. AD-15 moves the catch-up to `.code`. The rationale is off, though: AD-5 says *pinned* catch-ups parse the text, but the catch-up imports its own release's library (`catchup.mjs:43`, `../ci/lib/lock.mjs`), so it never sees another version's wording. The live hazard is within one release. The prefix is still cheap insurance for the reaper regexes and for agents that read `HUB_DEVICE_BUSY` on stderr. Low. |
| A9 | `updateLease` race (`:290-299`) | LANDS | AD-16 adds an at-or-after-expiry refusal and routes every later `expires_at` through `extendLease`. The leftover read/rename TOCTOU (`:295-297`) is tiny, and the `lease_id` re-check already stops an overwrite of a *different* holder. |
| A10 | `reclaim` race (`:58-63`): read, compare, `rmSync` | **DROPS (gap)** | `reclaim` uses `rmSync({force:true})` (`lock.mjs:61`), so two reclaimers that judged the same owner both return `true` and both log `HUB_LOCK_RECLAIMED` (`:91`, `:244`). Under AD-9 both would write the `reclaim` event. Worse, the second `rmSync` can delete the lock the first one just made, which leaves two holders. v1a narrows the window, since only the head reclaims in new code, but does not close it. Old-pin bare `withLock` reclaims from any poll for 30 days, and `releaseLease` (`:284`) reclaims too. **Fix (AD-9, or a new rule in AD-1):** reclaim by `mkdir <name>.lock/.reclaim`. That is atomic and has one winner per lock instance. The winner re-reads the owner, `rm`s only if it still equals what was judged, and alone writes the event. A loser gets `EEXIST`, or finds a different owner, and writes nothing. |

### The plan job and the `adb` gap

| # | Addendum | Spine | Evidence and notes |
|---|---|---|---|
| A11 | The gate calls `findPhone` with **no lock** and can start the adb server and mDNS-connect while a Lease holds the S26 | **DROPS (gap)** | AD-13 binds only plan. `quickS26` (`gate.mjs:138-147`) still calls `findPhone`. That always runs `adb.startServer()` (`adb.mjs:107`), and with `nudgeEvery: 2` (`gate.mjs:140`) it runs `adb mdns services` and `adb connect` on the second poll (`adb.mjs:125-130`). This happens on every deploy run, under any Lease. **Fix:** extend AD-13 to the gate. When `adb` is held by a Lease, the presence check uses Peek mode (an existing server only, no start, connect or mDNS), or it reports `leased` and skips the probe. |
| A12 | Plan holds `adb` to read the versionCode and refuses before the bump; an away phone means a blind bump | LANDS+ | AD-13's Peek uses the Lease's `adb_port` and `adb_id` (`hub-device.mjs:155-157,177`), blanks `RUNNER_TRACKING_ID`, and treats no server or no device as `unknown`, with `android.mjs:126` as the guard. **Make one step explicit:** any `adb` invocation auto-starts a server, so the Peek must probe `127.0.0.1:<adb_port>` with `node:net` before its first adb call. |
| A13 | The build runs inside the android job before its `withLock('adb')` (`android.mjs:49-112`) | LANDS | AD-7: android's Job Hold goes through the gate's Reservation. |
| A14 | Android's newer-device guard (`:126`) fires after the version is spent | LANDS | AD-13 names it as the guard when the Peek is `unknown`. |
| A15 | An away S26 means pending, and FR-30 reuses that path for a busy S26 | LANDS+ (Android), CONTRADICTS PRD (iOS, spine better) | AD-14 gives busy its own public reason, `S26 busy`, rather than away's hard-coded reason (`android.mjs:119`). It keeps `latest.json`'s frozen enum (`latest.mjs:18`) and states the Play/Release behaviour change. On iOS, Open Question 1 ships red, because `mac-ios` wraps the build (`ios.mjs:276-301`) and `deliver.mjs:164` publishes nothing without an IPA. The addendum is silent on iOS. The spine's call is right and correctly goes to "Needs Jarad". |

### The `phone` word, `mac-ios`, versions, history, declarations

| # | Addendum | Spine | Evidence and notes |
|---|---|---|---|
| A16 | `phone` = `acquireLease` with `waitMs:0` on each pass, s24 first; no place in line | LANDS+ | AD-6 turns a `waitMs:0` attempt into a true try with no ticket. Today every pass writes and unlinks a ticket on each held phone (`lock.mjs:201-206,257`), which would churn positions and ETAs once jobs share the queue. **Side effect:** Pool demand never reaches the Event Log. See B9. |
| A17 | `mac-ios` covers the Mac build and the iPad install, is taken twice, and is also used by the iPad catch-up | LANDS | AD-7 (the preflight-ios Reservation, passthrough for both takes) and AD-15. Note that the second take happens only when `testflight && spec.store.build` (`ios.mjs:385-388`). **Gap neither document covers:** between take 1's release and take 2's request the run is not "asking". If grace is already spent, and it usually is because the ios job starts after plan plus ios-export, which can take up to 50 min, a later claimant behind the Reservation is served first. That is an SM-1 violation. **Fix (AD-7):** a job that will take the same Resource again writes its next ticket (back-dated per AD-6) *before* it releases the current Hold. |
| A18 | `mac-ios` lives on the Mac's disk | LANDS | AD-1 rule 3. |
| A19 | devicectl and the keychain work only in the GUI session | DROPS (deferred) | This matters for the v1b Host Agent. v1a's only new Mac-side remote action is announce's ssh delete, which needs neither. **But:** that ssh runs whichever code the Mac's `current` holds, and `current` advances only on a real iOS job (`ios.mjs:401-402`). It can therefore predate v1a, for example when plan flipped the lane to skip after preflight-ios reserved. AD-7 should either say the backstop ships its own `lock.mjs` (for example `node --input-type=module` over ssh stdin from the pinned checkout) or say that the ceiling is the backstop in that window. Low. |
| A20 | The iPad catch-up is a one-shot LaunchAgent; `HUB_MAC_BUSY` counts as success | LANDS | AD-15 keeps the attempt to seconds, so the one-shot job stays short and the candybar semantics hold. |
| A21 | Several versions are in play (pins, both `current`s, the `hub-device` release dir) | LANDS | The paradigm ("the on-disk layout is the API"), AD-2, AD-3, AD-6, and the roll-out paragraph. |
| A22 | No history; owners carry `repo`, `run` and `started_at` but no `job` | LANDS (owner gap) | AD-9 adds the Event Log and AD-3 adds `job` to tickets. **But** the Structural Seed adds only `host_id` and `format` to `owner.json`. A `reclaim` event is written by the *next* acquirer (AD-9), which can read only the dead owner's record. So killed Job Holds lose `kind`, `job` and `attempt`, which are the samples AD-18's per-repo-and-job ETA needs most. **Fix:** `owner.json` additively carries `kind: job|hub-job`, `id`, `attempt`, `job`, `enqueued_at` and `eta`. Old pins test only `kind === 'lease'` (`lock.mjs:30`), so `kind:'job'` is safe. |
| A23 | `devices.json` has a fixed shape; the S26 identity and the `adb` and `mac-ios` names are hard-coded; `android_extra` is grep-banned under `tools/ci/{lib,commands}` | LANDS (deferred) | AD-4 keeps the names as one constant, and v1b replaces its source. `QUEUED` names `s24` by lock name, not `android_extra`, so the grep test (`hub-device.test.mjs:332-343`) is unaffected. |
| A24 | The emulator Pool size is runtime config | DROPS (deferred) | v1b Registry. |

---

## §B Suggested mechanism

### B.1 Event Log first

| # | Addendum | Spine | Notes |
|---|---|---|---|
| B1.1 | `<lockDir>/events.jsonl` per host, `O_APPEND` | CONTRADICTS (spine better) | AD-9 uses `events/<YYYY-MM>.jsonl`, with single writes under 4 KiB. Monthly files leave room for compaction without a format change (PRD §7.2). `listLocks` filters `*.lock` (`lock.mjs:305`), so old readers ignore the directory. |
| B1.2 | Record has `claimant_kind: deploy\|hub-job\|agent\|person` **and** `hold_kind: job\|lease\|reservation\|request`, plus `resource`, `enqueued_at`, `started_at`, `position`, `eta_at_enqueue`, `expires_at` and `actor` | **CONTRADICTS (addendum better)** | The Consistency event shape has one `claimant.kind`, taken from the ticket kind (`lease\|job\|hub-job\|remote`). That cannot tell an agent from a person, yet PRD glossary line 76 defines four Claimant kinds and FR-15 keys Lease ETAs on "the same Claimant kind". It also drops `expires_at`. AD-18 computes "the share of their stated duration used" from history, but no event carries the stated duration, so the ETA cannot be built from the Event Log. **Fix:** split `claimant.kind` (deploy, hub-job, agent, person; v1a CLI Leases default to `agent`, a person sets `--person` or `HUB_DEVICE_CLAIMANT=person`) from `hold_kind`. Add `expires_at` to `acquire` and `extend` events, and `enqueued_at` to `acquire`. `position` is derivable, and `resource` equals `lock` in v1a. Both can wait. Events are additive, but history written without these fields cannot be backfilled, and accruing history is v1a's whole point. |
| B1.3 | Events also include `pending`, `override`, registry-*, reachability and `claim` | **DROPS (gap)** for v1a events | Registry, reachability and override belong to v1b and v1c, so dropping them is fine. **Gaps:** (a) `claim` is in the enum with no definition. (b) There are no Reservation-lifecycle events (created, grace started, ended with reason `last-hold\|announce\|ceiling`), yet SM-C4 ("idle while reserved") and FR-18's utilisation split need exactly those, from v1a on. (c) There is no pending marker, yet SM-1 reports contention-pending deliveries separately. **Fix:** define `claim` = Reservation created. Add a `grace` event, written by the process whose stamp won (see B3.5). Give a Reservation `release` a `reason`. Android's `timeout` on `adb` carries `outcome:'pending'`. |
| B1.4 | Emit from `withLock`, `acquireLease`, `reclaim()`, `releaseLease`, a `listWaiters` prune, `updateLease`, and an emulator reap failure | LANDS+ (principle), one drop | AD-9's rule, "only the process whose atomic step succeeded writes", beats a list of call sites. It also makes a prune event fire only when `prune:true` and keeps status read-only. A reap failure is dropped: it is a capacity-loss signal for v1c, on an internal lock. Low. **The rule is unenforceable for `reclaim` until A10 is fixed.** |
| B1.5 | Scope: Registry Resources only | LANDS (gap for the emulator Pool) | `QUEUED` = `adb, s24, mac-ios, emulator-<n>`. The emulator Pool's real queue is the gate lock `emulator` (`emulator.mjs:29,486`), and slot takes are `waitMs:0` (`emulator.mjs:504`), which AD-6 makes ticketless tries. So an emulator Lease's wait and timeout write nothing, which contradicts FR-17 ("an emulator Lease ... exactly the expected event sequence"). **Fix:** add `emulator` (the gate) to the event scope. It never goes through `withLock`, so AD-4's queue role is unaffected. Log the slot `acquire` with `waited_ms` counted from the gate request. |
| B1.6 | A GitHub-killed job: the next reclaim records `last_alive_at` | LANDS+ | AD-19: the holder touches `owner.json`'s mtime at most once a minute, and a reclaim reads it. `stale()` ages from the lock *directory's* mtime (`lock.mjs:44`), so touching `owner.json` cannot change any old pin's staleness. Good. **Caveat:** `hook()`, `run()`, `attempt()` and the adb calls are `spawnSync` (`exec.mjs:9,28,59`), so the `unref`'d timer cannot fire during an Xcode build or a 600 s install. `last_alive_at` can then lag by the longest sync step, which undercounts `held_ms` rather than inflating it. Either state that, or clamp with the AD-12 deadline (a GitHub-killed job died at or before `job_start + job_timeout`). |
| B1.7 | Ship the Event Log in a hub release before anything else | **DROPS (gap)** | The spine has no release order within v1a. An Event-Log-only release before queue-joining would record the *unordered* baseline in the hub's own format. That beats scraping GitHub run logs for SM-1 and SM-2 (PRD §8). **Fix:** either add a roll-out step (release 1: `events.mjs` plus emission from today's `withLock` and `acquireLease`, event `format:1`; release 2: everything that freezes the ticket format), or state that v1a is one release and the baseline comes from GitHub logs. |

### B.2 Deploy jobs join the queue

| # | Addendum | Spine | Notes |
|---|---|---|---|
| B2.1 | `withLock` writes a pid-bound ticket `kind:'job'` with `repo`, `run` and `job`, and takes the lock at the head; `acquireLease` ≥ v1.2.26 already honours it | LANDS | AD-3, AD-4, AD-6. Verified: the old `staleWaiter` checks only `host`, `pid` and `process_start` (`lock.mjs:139-146`), so old pins honour job tickets. Old `hub-device` prints `undefined` for them (`hub-device.mjs:553`) until `hosts:install`. |
| B2.2 | Wait budgets relative to job start, through a new action input carrying `timeout-minutes` | LANDS+ | AD-12 uses `HUB_JOB_TIMEOUT_MINUTES` beside each `timeout-minutes`, a conformance test that the two agree, a Runner.Worker-ancestor start, and a per-lock hold allowance. It is better than the addendum because it has a start time. See A6 for the seam caveat. |
| B2.3 | The timeout keeps the `host lock <name> is held` wording and adds a code | LANDS+ | AD-5 covers both message shapes and adds `HUB_LEASE_CANCELLED` and `HUB_LEASE_EXTEND_REFUSED`. |
| B2.4 | Text status prints repo/run/job for job tickets | LANDS (needs one line) | AD-17 adds new sections, printed only when non-empty. It must also say that the existing `WAITERS` loop (`hub-device.mjs:553`, which reads `lease_id`, `holder` and `why` unguarded) lists only `kind:'lease'` tickets, with job tickets going to the new section. Otherwise `undefined` comes back, and the nine-line whole-output test (`hub-device.test.mjs:888`) is the only guard. |

### B.3 Reservations and the Peek

| # | Addendum | Spine | Notes |
|---|---|---|---|
| B3.1 | `<name>.reservations/<enqueued_at>-<run>.json` | CONTRADICTS (spine better) | AD-7 keys the file by run (`<owner>--<repo>--<run_id>`), so "re-run all jobs", which keeps `GITHUB_RUN_ID`, reuses the file instead of minting a second Reservation. The memlog says `<repo-slug>--<run_id>`; align the two. Say what happens to an *expired* file of the same name: it is replaced, not reused, and `wx` would fail on it. |
| B3.2 | The record holds `grace_s` (PRD FR-9: "grace = 10 minutes, **stored in the Reservation record**") | **CONTRADICTS (addendum better)** | AD-7's record omits grace, and AD-11 has `lock.mjs` read it from `policy.json` through `loadPolicy`. That file is module-relative (`policy.mjs:9`), so each release reads its own. Two pins with different grace values then disagree on whether a Reservation still holds a free Resource: one idles it, the other serves it. That is the cross-version split AD-6 exists to prevent, and the spine already avoids it for the ceiling by storing `expires_at`. **Fix:** the writer stamps `grace_ms` into the record. Readers use the record, and policy only seeds the writer. |
| B3.3 | A separate directory, never `owner.json` | LANDS | AD-2 and AD-7. |
| B3.4 | Writers: the gate writes `adb` (Linux) and preflight-ios writes `mac-ios` (on the Mac) | LANDS (gap: condition) | AD-7. It does not say when the gate reserves. PRD FR-9 says "each deploy target it **will install to**". A `--platform ios` run, or a run whose Android lane is off, would idle the S26 for one grace period. Reserve `adb` only when the gate's own lane decision runs Android, dry runs included, since they take `adb` too (`android.mjs:140-145`). Low. |
| B3.5 | Serving rule: merge by `enqueued_at`; grace once via `head_since` | LANDS+ (gap: atomicity) | AD-6 and AD-7 (`grace_started_at`, with read-only paths computing grace but never stamping it). "Stamped once" names no atomic step. Two acquirers can both rename-write the stamp, and then AD-9 has two writers. **Fix:** stamp with a `wx` create, either `<reservation>.grace` or the stamp inside a create-once file. The winner writes the `grace` event. |
| B3.6 | Same-run passthrough on `GITHUB_RUN_ID` | LANDS+ | AD-7 matches `GITHUB_REPOSITORY` plus `GITHUB_RUN_ID`. AD-6 back-dates the passthrough ticket's `ms15` to `reserved_at`. Safe for old pins: `listWaiters` never ages out valid tickets (it checks age only for unparseable ones, `lock.mjs:162-166`). |
| B3.7 | The Peek: read-only, only under a **Lease**, never a Job Hold, no lock, no server | LANDS+ | AD-13. See A12 (make the TCP probe explicit) and A11 (the gate needs the same rule). |
| B3.8 | Release by the last Job Hold or by `announce` (`if: always()`, verified at `mobile-deploy.yml:511-514`), locally and over ssh; ceiling | LANDS (gap with FR-30) | AD-7. **Gap neither document covers:** with AD-14, a contention-pending android job still releases the run's `adb` Reservation in `finally`. The pending build then reaches the S26 only through the catch-up's seconds-long `hub-job` attempt every 120 s (AD-15). Any later Lease beats it, and SM-1 counts that as lost ("happened only after a Claimant that arrived later was served first"). **Fix:** on contention-pending, android leaves the Reservation alive until its ceiling and announce skips it. The catch-up's ticket for that build passes through it. The `latest.json` platform block already carries `run` (`deliver.mjs:150`). |
| B3.9 | The serving rule and the reservation format ship in the **same** release as queue-joining `withLock` | LANDS (implicitly) | AD-3 says "frozen at the v1a release". Make it a gate: *no hub release may ship queue-joining `withLock` without AD-3 liveness, the AD-7 Reservation format and the serving rule.* This matters if B1.7 splits v1a into two releases. |

### B.4 Remote tickets

| # | Addendum | Spine | Notes |
|---|---|---|---|
| B4.1 | The first queue-joining release recognises `kind:'remote'` with an `expires_at` that every pruner honours; v1 writes none | LANDS+ | AD-3 also protects unknown kinds. See the A4 defect: "live with no `expires_at`" is a permanent wedge on pins that cannot be patched. **Fix:** unknown kind with a pid → the pid rule. No pid and no `expires_at` → stale once the ticket's file-name `ms15` is older than the Reservation ceiling. |
| B4.2 | v2: Heartbeats renew `expires_at`, quarantine encoded on disk, the Lease's stated end in `ends_at` | DROPS (deferred) | Spine "Deferred". `ends_at` is additive later. v1a keeps `expires_at` as the stated end, which the v2 split leaves readable. |
| B4.3 | `updateLease` expiry check in v1a | LANDS | AD-16. |

### B.5 to B.8 Registry, Host Agents, Hub API, Holocene

All of this is v1b or v1c. The spine defers it correctly ("Deferred"; AD-4 keeps the `QUEUED` role stable). Notes that touch v1a:

- **B5, lock names stay; new Resources get `res-<slug>`.** This is consistent with `QUEUED`. v1b's Pool ticket (a pid-bound lease ticket in every member's queue) fits the AD-3 freeze, as long as `pool` is an additive key (AD-2) and `lease_id` stays in the body (X1).
- **B7, `takeLease`/`takeAnyPhone` move to a library.** This is v1b. Whatever v1a does to `lock.mjs` must keep the literal `export async function acquireLease`, which `leaseSupport()` greps for in the installed release (`hub-device.mjs:110-116`). Consider adding a second sniffable marker for queue-joining support, so a new `hub-device` warns when the installed catch-up still uses bare `mkdir`. Low.
- **B6, the Mac Host Agent with a separate label.** Not touched. AD-15 keeps the catch-up LaunchAgent short, so it does not conflict.

### B.9 Capacity math (v1c, but v1a must record its inputs)

| # | Addendum | Spine | Notes |
|---|---|---|---|
| B9.1 | λ from `request` events, excluding hub-job attempts and internal locks | LANDS | `claimant.kind` and AD-4's scope. |
| B9.2 | E[S] and Var[S] from `held_ms` | LANDS (killed-job gap) | See A22: reclaimed holds lose their `job` identity. |
| B9.3 | Only **flexible demand (Pool requests)** moves to a new Resource; pinned demand is reported separately | **DROPS (gap)** | AD-6 (tries write no ticket and emit only on acquire) combined with AD-9 means a `phone` request that waits and times out writes **nothing**, and a winning one looks like a named acquire. The same holds for the emulator Pool (B1.5). The c+1 estimate (UJ-4) needs exactly this demand, and v1a's stated job is to start that history. **Fix:** `takeAnyPhone` (and the emulator gate path) writes one Pool-level `request` (`lock:'phone'`, `pool:'phone'`, members) and one `acquire` or `timeout` carrying `waited_ms` and `served_by`. Member tries stay ticketless. AD-9 names the requesting process as the sole writer of Pool events. |
| B9.4 | Timeouts and pending deliveries count as abandonment | LANDS (with the B1.3 fix) | `timeout` is logged. Pending needs the `outcome:'pending'` marker. |
| B9.5 | A low-data threshold of 20 holds | LANDS (unquantified) | AD-18 says "thin history" without a number. Add `eta.min_samples: 20` to AD-11's `queue` block. |

### B.10 Roll-out order

| # | Addendum | Spine | Notes |
|---|---|---|---|
| B10.1 | v1a = Event Log, queue-joining `withLock`, Reservations, Peek, FR-30 pending, FR-31, frozen ticket format, `updateLease` fix | LANDS | Each item has an AD: AD-9, AD-4, AD-7, AD-13, AD-14, AD-16, AD-3, AD-16. |
| B10.2 | Pin flip; the catch-ups switch at the first real deploy, `hub-device` at `hosts:install` | LANDS | Roll-out paragraph under the Structural Seed. |
| B10.3 | Fairness is partial for 30 days | LANDS | "Fairness holds only among runs on the new pin." |
| B10.4 | Event Log first | DROPS | See B1.7. |

### B.11 Failure modes (rows that apply to v1a)

| Failure | Spine | Notes |
|---|---|---|
| Mac unreachable: Mac-local jobs keep using `mac-ios` on the Mac | LANDS | AD-1. Announce's ssh delete fails and the ceiling ends the Reservation (AD-7). `offline` and stale views are v1b. |
| Hub API down | N/A in v1a | There is no daemon in v1a; Holds live in the lock dir. |
| big-chungus reboot: no release, the next acquirer reclaims with `last_alive_at`, Reservations survive | LANDS | AD-19, and AD-7 (timestamp-only liveness). Pid reuse after a reboot is caught by `process_start` (`lock.mjs:51,145`). |
| Clock skew: each queue on one host's clock | LANDS | AD-7 writers and the Timestamps convention. The cross-host merge is deferred to v1b. |
| Two Hub API instances | N/A | v1b. |

---

## §C Comparables

### What to adopt

| Pattern | Spine | Notes |
|---|---|---|
| Availability flags separate from Hold state (STF) | DROPS (deferred) | v1b (FR-5, FR-14). |
| Capabilities as labels (Jenkins, Nomad) | DROPS (deferred) | v1b (FR-6). |
| FIFO stated outright (GitLab `oldest_first`) | LANDS | AD-6, for `QUEUED`. Internal locks stay unordered, per PRD FR-8. |
| A lock held across jobs, with self-deadlock avoidance (GitLab mirror, Buildkite gates) | LANDS | AD-7 passthrough. No v1a path nests two `QUEUED` locks, so the only self-wait left is A17's gap between takes. |
| Retries keep their place (Buildkite, Selenium) | LANDS | A gate re-run reuses the live Reservation (B3.1). Android's `finally` and announce always end the Reservation before any `gh run rerun --failed` can start, so job reruns always arrive as new. That matches the PRD ("no place across a gap"), but it should be said once in AD-7. |
| Bounded queue, wait shorter than the CI timeout, a stats endpoint | LANDS (wait) | AD-12. The bound is not adopted (the PRD does not ask for one). Stats are v1b. |
| TTL with Heartbeat, jeopardy, lock-delay, fencing | DROPS (deferred) | Spine "Deferred" (v2). AD-19's touch is telemetry, not a TTL, which is consistent. |
| Steal with audit (Jenkins) | DROPS (deferred) | FR-11 is v1b and v1c. AD-16 fixes the call the override must use. |
| Holder, queue and Reservations visible to everyone | LANDS | AD-17. |
| Device health separate from lease state | DROPS (deferred) | v1b. |

### Avoid

| Anti-pattern | Spine | Notes |
|---|---|---|
| **Replace-latest pending** (GitHub concurrency cancels the older pending run) | **CONTRADICTS (addendum better)** | The spine's "Deferred" section says it is "outside the hub, and not counted by SM-1". Both halves are wrong. The groups are the hub's own: per-repo groups with `cancel-in-progress: false` in the reusable workflow (`mobile-deploy.yml:197-199, 259-261, 340-342, 378-380, 428-430, 472-474`). And PRD SM-1 counts any new-pin run "whose delivery to a Resource never happened". A third same-app run cancels the pending second one, after its plan bumped the version if the cancel lands on a lane group. **Fix:** decide in the spine. Either drop the lane-level groups (android, ios-export, ios) now that the hub Queue orders the devices: runners are repo-scoped and queue without cancelling, and deliver is serialised by `s3-<slug>`. Keep plan's group, which guards the version push. Or log the SM-1 exclusion as a PRD deviation under "Needs Jarad". Check GitHub's concurrency `queue:` option, which §C flags as uncertain, as a third route. |
| Unordered by default | LANDS | Only internal locks, deliberately. |
| Priority or front-of-queue | LANDS | None in v1a. |
| A slot held between retries with no TTL | LANDS | Reservation `expires_at` = `reserved_at` + ceiling. |
| Release on process exit as the only liveness once remote holders exist | N/A (v2) | v1a tickets are pid-bound. `remote` is reserved. |
| A point estimate from fewer than about 20 samples | LANDS (number missing) | AD-18 `low_data`. See B9.5. |

### Capacity math refined, and the uncertain list

These are v1c formulas and are not v1a decisions. v1a's only obligation is to log the inputs: B9.1-B9.4, B1.2 and B1.3. Of the uncertain list, GitHub's `queue: max` bears directly on the replace-latest row above.

---

## Spine-internal inconsistencies the reconciliation exposed

- **X1. AD-3 drops `lease_id`.** AD-3's frozen body lists `id` but not `lease_id`, while AD-2 says "existing files keep every key". Live readers match queued tickets on `lease_id`: `releaseLease` (`lock.mjs:272`), `isEmulatorLease` (`emulator.mjs:330-331`), and `hub-device` `--id` uniqueness and `release` (`hub-device.mjs:133,385`). **Fix:** the body keeps `lease_id` on `kind:'lease'` tickets, with `id` equal to it. Job tickets get a synthetic `id` and no `lease_id`, so they never match a release by lease id.
- **X2. AD-1 vs existing callers.** AD-1 says callers never parse lock-dir files, but `emulator.mjs:330-331` reads gate tickets by hand and the emulator writes `<lockDir>/emulators/` records. Add a migration line: `isEmulatorLease` moves to `listWaiters`, and `emulators/` and `emulator-pool` are named as emulator-owned paths beside `events/`.
- **X3. AD-10 vs `hubRef`.** AD-10's "one source" would be a second resolver, because `receipt.mjs:19-22` `hubRef()` already resolves `HUB_REF` and the `_actions/<owner>/<repo>/<ref>/` path. **Fix:** extend `hubRef` with the `releases/<vX.Y.Z>/tools/` realpath case and have `events.mjs` import it.
- **X4. Reservation file name.** The spine (`<owner>--<repo>--<run_id>`) and the memlog (`<repo-slug>--<run_id>`) disagree. Pick one.

## Proposed edits, ranked

1. **High: AD-9 + AD-1, reclaim.** Atomic reclaim through a `mkdir <name>.lock/.reclaim` marker with an owner re-check. Only the winner removes the lock and writes the `reclaim` event (A10).
2. **High: AD-7 + AD-11, grace.** Store `grace_ms` in the Reservation record and have readers use the record. Policy only seeds the writer (B3.2).
3. **High: AD-6 + AD-9 + AD-4, Pool history.** Pool-level `request`/`acquire`/`timeout` events for `phone` and the `emulator` gate, written by the requester. Add the `emulator` gate to the event scope (B9.3, B1.5).
4. **Medium: Consistency event shape + Structural Seed.** Separate `claimant.kind` (deploy, hub-job, agent, person) from `hold_kind`. Add `expires_at` and `enqueued_at`. Add Reservation `claim`/`grace`/`release` with a reason, and `outcome:'pending'`. `owner.json` carries `kind`, `id`, `job`, `attempt`, `enqueued_at` and `eta` (B1.2, B1.3, A22).
5. **Medium: AD-3.** Keep `lease_id` in the body. An unknown kind without pid or `expires_at` goes stale after the ceiling instead of living forever (X1, A4, B4.1).
6. **Medium: Deferred / SM-1, concurrency.** Stop calling the concurrency groups outside the hub. Drop the lane-level groups (keep plan's), or record the exclusion as a PRD deviation for Jarad.
7. **Medium: AD-13, the gate.** Apply the Peek rule to the gate's `quickS26` (A11).
8. **Medium: AD-7 + AD-14, the place in line.** A contention-pending delivery keeps the run's Reservation for the catch-up. A job that will retake a Resource enqueues before it releases (B3.8, A17).
9. **Medium: roll-out.** Add the same-release gate (B3.9) and decide whether the Event Log ships first (B1.7).
10. **Low: AD-12, AD-10, AD-18, AD-5, AD-7.** Add a `processStartedAt` seam; reuse `hubRef`; add `min_samples: 20`; fix AD-5's rationale; state when the gate reserves; say what code backs announce's ssh delete; align the Reservation file name.
