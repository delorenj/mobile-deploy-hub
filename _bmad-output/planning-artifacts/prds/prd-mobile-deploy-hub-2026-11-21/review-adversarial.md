---
title: Adversarial review of the Hub Resource Registry PRD
reviews: prd.md, addendum.md (2026-11-21 draft)
reviewed: 2026-11-21
verdict: not ready for architecture
---

# Adversarial review: Hub Resource Registry PRD

**Verdict.** The PRD is not ready for architecture. Its flagship journey (UJ-1) can't be built on the code it claims to wrap. Its remote-Claimant model (Heartbeat, FR-23 restart survival) fails both the existing ticket semantics and its own no-clock NFR. Most of its success metrics can't be computed from the Event Log it specifies. v1 scope is the whole roadmap with no cut line.

I checked every claim below against HEAD (`6a38754`), not against the seed's `4cdefdc`. Severities: **critical** means v1 fails its own stated goal as written. **high** means a contradiction or gap that architecture can't resolve without a product decision. **medium** means it will cost a rework loop. **low** means hygiene.

---

## Critical

### C1. UJ-1 is unrealizable: the plan job needs a real Hold on the S26, not a Reservation

*PRD: UJ-1, FR-7, FR-8, FR-9, SM-1. Code: `tools/ci/commands/plan.mjs:228-241`, `:274-276`.*

The plan job holds `adb` for more than a presence check. Inside `withLock('adb')` it reads the S26's installed `versionCode` (`adb.installed`). The bump then refuses any planned code at or below it (plan.mjs:274-276, "Android would refuse the update"). So the plan job needs exclusive possession of the S26 **before** the bump. That is a Job Hold, and under FR-7 it waits in strict arrival order.

Replay UJ-1 under the PRD's own rules:
- An agent holds the S26 on a 30-minute Lease, and Green In Between is queued.
- Tower's plan job must read the S26, so it queues for a Job Hold at position 2 with an ETA of about 25 minutes.
- The plan job's limit is 20 minutes (`mobile-deploy.yml:196`). FR-8 makes the wait shorter than that.
- So **the plan job fails before the build starts**, and the Reservation never gets to protect anything.

The two alternatives are both forbidden by the PRD:
- If the plan job takes the Reservation first and then asks for the Job Hold, it is waiting behind its own Reservation, and FR-9 says that is "detected and refused".
- If the S26 read skips the queue, that breaks FR-7 and NFR-1.

There is a third path that the PRD doesn't name. Plan could treat "busy" like "away" (plan.mjs:236-241 already bumps blind when the S26 is away). The planned code might then sit at or below the installed one, and the android job would fail *after* the bump. That is the exact failure the Vision says this PRD removes.

**Needed:** a product decision on how the plan job learns the installed version without an exclusive FIFO Hold. Options are a shared or read Hold class, reading the last install receipt, or moving the check into the install job. Until that decision exists, the plan-to-install Reservation design rests on nothing.

### C2. Reservation semantics at the head of the Queue are undefined, and every reading breaks FIFO or SM-1

*PRD: FR-9, FR-7, FR-8, FR-10, §6 Non-Goals, SM-1. Addendum B.3, C "Avoid".*

FR-9 says an unclaimed Reservation at the head blocks everyone behind it "until the Reservation's grace period ends" (10 minutes). It never says what happens **after** grace. That is the only interesting case, because builds take longer than 10 minutes.
- **The Reservation keeps the head** and others pass while it builds. Then it jumps ahead of everyone served in the meantime when it claims, which is front-of-queue precedence. The Non-Goal forbids that ("No priority classes, preemption").
- **The Reservation loses its place.** Then UJ-1's "the Reservation keeps Tower's place through [the build]" is false whenever the build outlasts queue wait plus grace. The android job then waits behind whoever took the S26, possibly a 48-hour Lease, and hits its 20-minute `withLock` limit. SM-1 fails.

Three more problems sit on top of that:
- **Dead runs block the head.** "A run that is cancelled or fails releases its Reservations" (FR-9) has no actor. A run cancelled mid-build, or whose build job fails, runs no hub code that could release anything. Under NFR-3, nothing reaps the Reservation on a timer. So every dead run leaves the Resource idle at the head for the full grace period, and the Event Log records none of that waste.
- **Reruns jump the line.** "A rerun ... keeps its original place in the Queue" lets a failed-then-rerun run cut ahead of everyone who queued in between. That is the anti-pattern the addendum itself lists under C "Avoid" ("Holding a slot between retries with no TTL").
- **The Reservation's own expiry is never given.** Only grace is assumed. A Reservation's expiry has to exceed the longest build, which for the iOS lane is up to 120 minutes (`mobile-deploy.yml:377`), yet stay short enough not to strand the Queue. The PRD doesn't attempt that trade-off.

### C3. SM-1 "0 failed waits per 30 days" is impossible by construction, and gameable

*PRD: SM-1, FR-7, FR-8, FR-10, UJ-1 edge case.*

Strict FIFO (FR-7), no preemption (§6), Leases up to 48 hours with unbounded extension while others wait (FR-10, UJ-1 edge case), and a deploy wait capped under 20 minutes (FR-8) together guarantee the result. Any Lease ahead of a deploy with more than 20 minutes left fails that deploy. UJ-1's own edge case ("the lease holder extends by 15 minutes") is the failure.

Extending while others wait is exactly how "one project gets shut out", which is the seed's complaint. The PRD has no rule tying extension to the Queue, such as "no extension while a deploy waits" or "an extension goes to the back".

**Gaming.** The cheapest way to hit SM-1 is to turn a busy timeout into a "pending" delivery, the way away already is (plan.mjs:236-241, android.mjs:116-121). SM-1 would then read 0 while deploys still don't install. SM-1 must count *runs whose device delivery didn't happen because of contention*, not runs that failed.

### C4. The remote-Claimant model fails FR-23 and UJ-2 against the actual ticket code, under NFR-3

*PRD: FR-10, FR-23, UJ-2 edge case, NFR-3, §4.2. Addendum B.4. Code: `lock.mjs:139-146`, `:149-171`, `:290-299`; `tools/device/lease.test.mjs:183`.*

The addendum's Heartbeat design: "the Hub API process owns the pid-bound ticket and the remote Claimant owns the heartbeat", with "a short `expires_at`, renewed through `updateLease`". Checked against the code:

1. **`updateLease` renews only a held lock's `owner.json`** (lock.mjs:290-299). It can't touch a queue ticket. No Heartbeat mechanism exists for a remote Claimant that is still *waiting*, which is the UJ-2 case.
2. **Ghost waiters persist.** While the Hub API is alive, its tickets have a live pid and `process_start`, so every other acquirer (deploy jobs, `hub-device`, the catch-up) judges them live (`staleWaiter`, :139-146). Only the Hub API knows a Heartbeat lapsed. NFR-3 forbids a timer, so a lapsed remote waiter at the head blocks a deploy job, which evaluates staleness in its own process, until someone happens to call the Hub API. UJ-2's "nobody waits behind a ghost" is false.
3. **Restarts delete positions.** The moment the Hub API process exits (restart, crash, big-chungus reboot), its tickets name a dead pid. The next `listWaiters({prune: true})` from *any* acquirer deletes them (:157-158). A queued deploy job prunes every 2 seconds. "On restart, the Hub API re-adopts its tickets from the store" re-adopts tickets that are already gone. FR-23 ("loses no ... Queue position") is false.
4. **FR-23 contradicts itself.** Its headline says restarts lose nothing. Its only consequence limits that to restarts "shorter than its Heartbeat lapse" (90 seconds). A big-chungus reboot is never under 90 seconds, so every remote Lease lapses.
5. **UJ-2 contradicts FR-10.** UJ-2 says a dead waiter is dropped "within one heartbeat interval" (30 seconds). FR-10 says lapse after 90 seconds, plus a 15-second quarantine.
6. **A person's Lease from Holocene dies with the browser tab.** FR-26 lets Jarad lease from the page. FR-10 says anything "held through the Hub API without a local process is reclaimed when its Heartbeat lapses". Nothing sends that Heartbeat once he closes the tab. If Holocene's server sends it for him, Holocene becomes a clock and the Heartbeat proves nothing.
7. **The addendum's run mode can't own tickets.** B.7 says the Hub API is "started on demand or always on". A process started on demand can't own pid-bound tickets or keep FR-14's stream open.

**Needed:** queue tickets get their own lease-style expiry that every lock.mjs caller honours. That is a ticket-format change, and NFR-2's old pins will prune it. Otherwise, drop "remote waiting" from v1.

---

## High

### H1. The 2-second, last-checked and 200 ms promises need a clock NFR-3 forbids, and FR-5 contradicts FR-4

*PRD: FR-4, FR-5, FR-14, FR-20, FR-24, FR-28, NFR-3, NFR-7. Code: `tools/ci/lib/adb.mjs:99-131`; `.candybars/mobile-deploy-hub-ios-catchup/README.md`.*

- **FR-14 needs a watcher.** Most transitions happen in other processes: deploy jobs, `hub-device`, the catch-up, and the Mac's own jobs. Pushing those within 2 seconds needs a watcher on the lock dir or a poll loop, and the PRD names neither. For the Mac it means polling over ssh, a recurring poll loop that the global "Candybar is the single clock" rule forbids. Expiry and Heartbeat lapse are "changes" that, under NFR-3, *nobody observes* until someone calls. They can't reach subscribers in 2 seconds.
- **FR-5 breaks FR-4 and NFR-7.** FR-5 requires Reachability through "the same `findPhone` matching that deploys use". `findPhone` calls `adb.startServer()` first, runs `adb connect` on mDNS endpoints, and blocks up to `waitMs` (180 seconds by default) for an absent phone (adb.mjs:105-131). That breaks FR-4's "never starts an adb server or connects anything" and NFR-7's 200 ms status read. A status read that doesn't probe needs a cache refreshed on a schedule, which is a clock.
- **FR-28 needs a clock too.** "Offline longer than a threshold" requires periodic Reachability probing. With lazy evaluation, nothing probes a Resource nobody asks about.
- **The iPad can't be reached over plain ssh.** iPad Reachability "through the Mac Agent" runs into a hard constraint the hub documented 3 minutes before this PRD: "devicectl and the keychain work inside the logged-in GUI session, never over plain ssh". So addendum B.6 option (a), ssh to `hub-mac`, *cannot* report iPad Reachability. And if the Mac Agent reuses the catch-up LaunchAgent (Open Question 2), it is single-instance and answers `HUB_MAC_BUSY` for up to 20 minutes during an install pass.
- **The Mac is a laptop.** `hub-mac` is `carries-macbook-air` (devices.json `mac.peer`). It routinely goes away on hotspot, on DERP, or asleep. The hub already treats its link as metered (`tools/ci/lib/metered.mjs`). An always-on 2-second status stream to it ignores the hub's own metered-link policy.

### H2. The iPad and the Mac as separate exclusive Resources don't match how the lanes work, and the split brings deadlock

*PRD: Glossary (Resource kinds `ios-device`, `mac`), FR-12, FR-9. Code: `ios.mjs:276-344`, `:390`; `plan.mjs:36-95`.*

- **Nothing a deploy does takes an `ipad` lock.** Today's iPad install runs *inside* `withLock('mac-ios')` (ios.mjs:276-344). `preflight-ios` reads the iPad's installed version with **no lock at all**. The Mac catch-up installs to the iPad under `mac-ios` (catchup.mjs:574). So `hub-device lease ipad` (FR-12) excludes nothing. The Glossary's "exclusive possession" is false for the iPad on day one.
- **Making it real creates a deadlock.** Making `ipad` exclusive means the iOS job holds `mac` and `ipad` at once. An agent holding `ipad` that then leases `mac` deadlocks against an iOS job holding `mac-ios` and waiting for `ipad`. FR-9 detects only a run waiting on *itself*. No lock order and no all-or-nothing multi-Resource acquire is specified.
- **Plan can't reserve an away Mac.** When the Mac is away at plan time, the plan job can't write a `mac-ios` Reservation, because the Queue lives on the Mac's disk. FR-12's "Reservations keep their place" covers only Reservations that already exist. A new one either fails the plan, which breaks v1.1's "away is pending, not a stop", or is skipped, which leaves the iOS job unordered when the Mac returns.
- **Clock skew reorders a cross-host Queue.** A Reservation written by the Linux plan job carries big-chungus's `enqueued_at`. Mac-local tickets (iOS jobs, the Candybar-kicked catch-up) carry the Mac's clock. B.3 "merges tickets and reservations by `enqueued_at`", so skew reorders FIFO directly. Expiry is also judged on the Mac's clock against a timestamp from big-chungus. A 15-second quarantine (FR-10) is meaningless across hosts with no skew bound stated.

### H3. Most success metrics can't be computed from the Event Log as specified

*PRD: §8, FR-17, FR-18. Addendum B.1 schema.*

| Metric / FR | What it needs | In the B.1 schema or event set? | Result |
|---|---|---|---|
| SM-1 "among runs on the new pin" | hub version per event | no `hub_version` / pin field | can't filter |
| SM-1 failures | jobs GitHub killed at `timeout-minutes` | a killed job's `finally` doesn't run, so no event | undercounts the very failure it targets |
| SM-2 "100% visible" | proof a waiter *was shown* in three views | no visibility record; old-pin waiters (NFR-2) never write tickets; Mac waiters invisible while away | unmeasurable, and false during transition |
| SM-3 "plug-in to first Lease < 1 min" | a plug-in or discovery time and a registration time | register, edit and retire aren't event types; discovery isn't logged | unmeasurable |
| SM-4 ETA error | the ETA given at enqueue | no `eta` field; FR-16 re-prints ETAs as they change, so which one counts? | unmeasurable; "error of a range" undefined |
| SM-5 "falls inside the stated range" | a range on the Capacity Estimate | FR-19 never requires a range; only B.9 does, for small c | metric points at nothing |
| FR-18 "away fractions", SM-C1 | Reachability history | Reachability isn't an event | can't compute |
| FR-11 force-release "who and why" | a force-release event with an actor | the event set has no force-release, claim, expire, lapse or quarantine | the Reservation lifecycle can't be logged |

**Bias the PRD ignores:**
- **Lazy reclaim distorts hold times.** Under NFR-3, a crashed holder's `held_ms` runs until the *next caller* notices: hours for a job lock owner from another host (staleMs 4 hours, lock.mjs:53), or the whole downtime after a reboot. E[S] then depends on the arrival rate.
- **Arrivals are double-counted.** The catch-up emits a request and a timeout every pass (5-second wait, catchup.mjs:467). Emulator Leases emit events twice, once for the `emulator` gate and once for the slot (emulator.mjs:486, :504). `withLock` also covers `s3-*`, `s3-index` and `emulator-reaper`, which aren't Resources. All of this inflates λ and the abandonment rate that drives the Erlang A switch.
- **Old pins write nothing**, so λ is undercounted for months.

**SM-5 also answers the wrong question in v1.** Deploys hard-code the S26 (§7.2 defers "any free compatible device"). Adding a phone can't shorten a deploy's wait for the S26 except indirectly, by moving agents off it. UJ-4's "buy the phone" decision is modelled on a phone Pool as M/G/c, but some of that Pool's Claimants are pinned to one member: deploys on the S26, and `s24`/`s26` by name. A queue like that isn't M/G/c. Add induced demand after the purchase and a sample of one purchase event, and SM-5 is unfalsifiable. It is also gameable by widening the range.

**Low-data thresholds contradict each other.** FR-15 uses fewer than 5 past holds. B.9 and C use about 20, below which "a single-point wait estimate" is something to avoid. FR-19 uses fewer than 30. UJ-4 then shows a *point* estimate ("1.5 minutes") for c=2→3, where B.9 says "show a bootstrap range ... rather than a point estimate".

### H4. The deploy-eligible flag is dead in v1, wrong in v2, and the Registry forks the source of truth

*PRD: UJ-3, FR-1, FR-2, FR-3, FR-25, Glossary (Capability, Resource), §6 Non-Goal 4, §7.2. Addendum B.5.*

- **Dead in v1.** UJ-3 has Jarad set "whether deploys may install on it". v1 deploys hard-code `adb` and the S26 (plan.mjs:230, android.mjs:112, gate, catch-up), and hub-device's own test asserts that no deploy-side reader touches `android_extra` (hub-device.test.mjs:332). In v1 the flag changes nothing. It is a UI control that lies.
- **Wrong in v2.** In v2, a runtime-writable flag that any loopback agent can set through the Hub API (FR-1) decides which device receives deploys. That breaks Non-Goal 4 ("The Registry does not decide what a device may receive"). It also breaks the hub's core rule: what a device may receive is pinned in `policy.json`, parsed strictly, "never taken from an input", and changed only by a hub release.
- **Two sources of truth.** `hub-device` reads `registry.json` (B.5). Deploy code keeps reading `devices.json`. FR-3 imports "on first start" only. Edit the S26 in the Registry and deploys never see it. Replace the S26 by a hub release and the Registry keeps the old serial forever. Delete `registry.json` and the next start re-seeds, bringing retired Resources back.
- **A Glossary double entry.** "deploy-eligible" is listed as a Capability *and* as a separate Resource flag. FR-1 then lists both.

### H5. v1 scope is the entire roadmap

*PRD: §7.1. Addendum B.10.*

§7.1 puts every FR in v1: Registry, Capability matching, Pools, the FIFO protocol change, Reservations, Heartbeats, fencing, quarantine, jeopardy, the Mac Agent with its transport undecided, SSE streaming, ETAs, the Event Log with retention and compaction, Erlang C, Allen-Cunneen and bootstrap capacity math, starvation signals, and five Holocene FRs in another repo.
- **No cut line.** The addendum gives a rollout order. The PRD gives no MVP cut, so the first cut that matters (fix starvation) ships last-equal with the Holocene capacity panel.
- **Capacity work ships with no data.** The Capacity Estimate can't be credible until weeks of Event Log data exist, which by FR-19's own threshold means 30 or more holds per Pool. Building it in v1 is building the low-data flag.

**Suggested cut:**
- **v1:** Event Log, queue-joining `withLock`, a solution to C1, and status visibility of waiting deploy jobs.
- **v1.1:** Registry and Hub API (local Claimants only).
- **v1.2:** Mac Agent.
- **v1.3:** Holocene page.
- **v2:** Capacity Estimate, remote Heartbeat Claimants, and any-device deploys.

---

## Medium

### M1. Overlapping Queues make "strict arrival order" undefined, and the `phone` word contradicts itself

*PRD: Glossary (Pool, Queue), FR-6, FR-7, FR-13, FR-15. Code: `hub-device.mjs:47-57`, `:199-216`; `hub-device.test.mjs:253`.*

- **One phone, several Queues.** "A Resource can be in several Pools", each Pool has its own Queue, and each Resource has its own too. When the S24 frees, the head of *which* Queue gets it? FR-7's "served strictly in arrival order" has no single order to be strict about.
- **Ad-hoc Capability requests have no Pool.** FR-6 requests like "API level 34 or higher" "join the matching Pool's Queue", but Pools are *named* Registry entries. An ad-hoc expression has no Pool.
- **The default phone Pool includes the S26.** `fleetOf` lists the deploy phone, so Pool-queued agents compete head-to-head with deploys for it. Open Question 3 asks only about QA phones.
- **`phone` can't keep its behaviour and become a Pool request.** FR-6 says `phone` "becomes a Pool request and keeps its CLI behaviour". Today's behaviour is an ordered try, s24 first, that "does not queue FIFO behind another `phone` taker" (hub-device.mjs:199-203), and a test asserts "s24 first" (hub-device.test.mjs:253). FR-13 requires those suites to pass unchanged. The requirement contradicts itself.
- **FR-15's ETA is single-server**: the holder's remaining time plus each waiter's hold time. It's wrong for any Pool with c ≥ 2.

### M2. FR-16's log shape breaks FR-13's "tests pass unchanged"

*Code: `tools/device/lease.test.mjs:98`; `catchup.mjs:469`.*

- **The test pins the current shape.** `lease.test.mjs:98` asserts `/^HUB_LOCK_WAIT adb held by delorenj\/example run 9/`. FR-16 mandates `HUB_LOCK_WAIT <resource> position=<n> eta=<range>`. Both can't hold.
- **The catch-up parses the error text.** It matches `/host lock adb is held/` (catchup.mjs:469) to tell busy from failure, so any rewording of `withLock`'s error turns a busy pass into a hard failure.
- **`<resource>` is ambiguous.** It could be the Resource id, the name (`S26`) or the lock name (`adb`).

### M3. The Claimant and Hold taxonomy is incomplete

*PRD: Glossary (Claimant, Hold, Job Hold).*

- **The catch-up fits no Claimant kind.** It is none of deploy run, agent or person, yet it takes `adb` (Linux, every 120 seconds) and `mac-ios` (Mac, Candybar every 5 minutes). FR-17 can't record its "kind".
- **A Job Hold isn't "for the job's length".** `withLock` wraps a section: plan's S26 read is seconds long, and `mac-ios` is taken twice per iOS job (ios.mjs:276, :390).
- **The PRD has more Hold kinds than its Glossary defines:**
  - a Reservation "holding the lock" during grace (B.3);
  - the emulator `emulator` gate Lease, a Hold on a non-Resource;
  - `--no-connect` "administrative holds" (FR-19);
  - `s3-*` locks.
- **"Reservation" is ambiguous.** The Glossary defines it as "a Claimant's place in a Queue", which makes every queued request a Reservation. FR-11 and FR-23 then treat "Reservation" and "queued request" or "Queue position" as different things.
- **"Heartbeat" covers more than the FRs use.** The Glossary says a Heartbeat keeps a Reservation alive when there is no local process. A deploy's Reservation spends the whole build with no process and no Heartbeat (it relies on `expires_at`).

### M4. The fencing token and quarantine claims are overreach

*PRD: FR-10.*

- **Nothing validates the token.** `adb install` and devicectl don't check it. A fencing token only protects a resource that validates it, and the phone can't. The hub can pre-check before calling adb, but that is a time-of-check-to-time-of-use gate, not fencing.
- **Agents never present one.** They use adb directly (Non-Goal 1).
- **"A slow holder and a new one never overlap" is untestable.** A partitioned holder can keep running adb for minutes past a 15-second quarantine.
- **The counter has nowhere to live.** The lock directory is deleted on every release (lock.mjs:61, :103), and old pins never increment the counter.

### M5. NFR-1 "exactly one implementation" is false while pins are in flight, and the rollout gives up a lever it has

*PRD: NFR-1, NFR-2, FR-7, SM-2. Code: `mobile-deploy.yml:130` (`actions/hub@v1.2.42`).*

- **Each deploy run brings its own lock code.** Every run executes the `lock.mjs` of its pinned hub tag, so several protocol versions share one lock dir at once.
- **Old pins break the new protocol.**
  - v1.2.25 and earlier reclaim Leases as dead jobs.
  - Everything up to v1.2.42 bypasses the Queue with bare `mkdir`, and would reclaim a lock held by a Reservation (its owner pid isn't alive).
- **FR-7 and SM-2 are stated without that qualifier.** FR-7's "strictly in arrival order" and SM-2's "100%" don't say "on the new pin".
- **The hub can enforce the floor itself.** It owns `callers.accept` and the gate. A minimum-version floor in `policy.json` would close the transition deliberately. The PRD relies on old runs aging out instead.

### M6. Premises in the PRD and addendum that are factually wrong at HEAD

- **Stale owners (§4.5 and addendum A).** "The lock code treats owners from other hosts as stale" is false for owners. A Lease from another host is honoured until `expires_at` (lock.mjs:49). A job owner from another host is honoured for 4 hours (:53). Only queue *tickets* are host-bound (:142). The conclusion (run the Hub API on big-chungus) survives. The reasoning doesn't, and it hides the real hazard: a dead Mac-side job lock blocks for 4 hours.
- **"Today both are 20 minutes" (FR-8)** holds only for plan. The android job's limit is 45 minutes *including the build* (`mobile-deploy.yml:258`). The invariant has to be against the *remaining* job time, not the job timeout.
- **The emulator Pool's size is already runtime config.** §4.1 says it is a code constant, but it already lives in the `<lockDir>/emulator-pool` file (emulator.mjs:62-69). Only `MAX_POOL` is a code constant.
- **Stale line references.** Addendum line refs have drifted from HEAD (`android.mjs:98` → `:112`). The addendum says it targets `4cdefdc` while the repo has moved.

### M7. "Mac away", "Hub API down", reboot and two-host failure modes are mostly unspecified

| Failure | What the PRD says | What is missing |
|---|---|---|
| Mac away | FR-12: Leases fail `HUB_DEVICE_AWAY`, Reservations keep their place | New Reservations at plan time; Mac-local jobs keep taking `mac-ios` while big-chungus is blind (split view); FR-18 history and Capacity for `mac` silently partial; whether the board marks Mac data stale |
| Hub API down | FR-13: CLI works for local Resources; FR-24: board read-only | Every remote Lease and waiter lapses after 90 s (C4); Pool requests and `registry.json` writes; who notices a crash loop (no clock) |
| big-chungus reboot | nothing | In-flight jobs die with no release event (their `finally` never runs); lazily reclaimed holds inflate `held_ms` by the downtime; Hub-API-owned tickets are pruned before re-adoption; how runner restart interacts with Reservations |
| Clock skew | nothing | Cross-host `enqueued_at` merge (H2); expiry judged on the other host's clock; Event Log merge order across two `events.jsonl`; wall-clock `waited_ms` across processes (a Reservation from plan claimed in android) goes negative on an NTP step |
| Two Hub API instances | "the only writer of the Registry" | Nothing enforces a single instance: temp-plus-rename is last-writer-wins, so a second instance (a stray `node` run, on-demand plus always-on) silently loses registrations and forks ticket ownership |

### M8. Event Log retention contradicts "append-only"

FR-18 compacts after 90 days, through a Candybar job (NFR-3). Rewriting an append-only JSONL file while deploy jobs, `hub-device`, the catch-up and the Hub API append to it loses events unless every writer coordinates, and FR-17 forbids the Event Log from ever blocking an acquire. Daily aggregates also destroy the per-hold data that the B.9 bootstrap ranges need.

The Mac's `events.jsonl` needs its own compaction. That is a remote Candybar job, the same shape that already needed a migration ledger entry ("the ledger cannot drive a remote launchd job").

### M9. Consequences that can't be tested, or that are missing

- **FR-25 to FR-28 have no "Consequences (testable)" at all.**
- **FR-8's second consequence is vacuous.** It forbids a deploy job failing "while it is first in line and the Resource is held only by Claimants behind it". Under new semantics, only a Queue-bypassing old pin could be both holder and "behind", and NFR-2 says that is expected.
- **FR-21's "contract document ... is versioned"** is checkable only as "a file exists". Holocene hand-writes its types (B.8). There is no conformance test between the contract and either side.
- **FR-22** claims "same effect" and tests only mutual exclusion.
- **FR-20 and FR-28 thresholds are unset.** FR-15's "such Leases" (same holder? Resource? duration?) is undefined.
- **FR-6 doesn't cover offline matches.** It says nothing about a Capability request that matches only `offline` or `absent` Resources: wait (behind nothing, until timeout) or fail with AWAY (exit 75)?

---

## Low

### L1. Glossary violations

| Term used | Where | Problem |
|---|---|---|
| lock, lock name, lock dir, lock timeout | §4.1, FR-3, FR-8, FR-13, NFR-1, §4.5 | Undefined. It is the implementation of a Hold, and the PRD uses it interchangeably with Hold. "Lock name" is a third identifier beside id and name. |
| waiter | §1, §4.3, FR-15 | A synonym for a queued Claimant |
| holder | FR-10, FR-15, B.1 schema | A synonym for the Claimant holding a Hold |
| away, away fractions | FR-12, FR-18, `HUB_DEVICE_AWAY` | Not a Reachability value (`offline` or `absent`) |
| in jeopardy, quarantine, grace period, fencing token | FR-9, FR-10 | Load-bearing states and terms with no Glossary entry |
| dedicated-QA, deploy baseline | Glossary (Capability), §4.1 | Undefined |
| pin, new pin, pin flip, new semantics | NFR-2, FR-8, SM-1 | Undefined domain nouns that SM-1 depends on |
| the catch-up | NFR-1, addendum | An undefined Claimant (M3) |
| control surface (lowercase, meaning Holocene) | §1 | Collides with **Control Surface**, which means the page |
| Holocene users (plural), agents on other hosts | §4.2 | Contradicts §0 ("only operator"), §2.2 (no other hosts) and NFR-6 (loopback) |
| administrative holds | FR-19 | A new Hold kind |
| the hub | throughout | Ambiguous: the repo, the Hub API, or lock.mjs. NFR-3 "when the hub is called" changes meaning depending on which one. |

### L2. "Who" in the Event Log can't be established

FR-11 records "who and why". FR-2 says "Jarad can edit". But NFR-6 puts every agent on unauthenticated loopback, and Holocene would forward an identity the Hub API has to take on trust. This isn't a security ask. It is attribution: the Event Log's `holder` and "who" fields are whatever the caller typed, so starvation attribution (FR-20) can be wrong.

### L3. UJ-3 assumes USB plug-in

The hub's phones run on Wireless debugging with mDNS auto-connect (adb.mjs:99-103). A new phone isn't on the hub's adb server until someone pairs it, and no FR covers pairing. FR-4 discovery "never connects anything", so it never sees an unpaired phone. SM-3's clock starts at "plugging it in", which no system observes.

### L4. FR-1's reserved words are incomplete

FR-1 reserves `phone`, `emulator` and `adb`. Also live: `s24`, `s26`, `mac`, `ipad`, `mac-ios`, `emulator-N`, `emulator-reaper`, `s3-index` and `s3-<slug>`, plus every future CLI device word. A Resource named `Mac` or `iPad` collides with FR-12's CLI words.

### L5. Holocene already has a phone route

§7.2 and Open Question 5 treat phone access as blocked by Google sign-in. Holocene already serves `/hq` outside google-auth, gated by Telegram `initData` (`holocene/compose.yml`). The pattern exists, so the open question is a choice, not a blocker.

### L6. The capacity math is overstated as "exact"

Allen-Cunneen "is exact for c = 1 (Pollaczek-Khinchine)" holds only with Poisson arrivals (Ca² = 1), not G/G/1. Erlang C also needs ρ < 1 and no server vacations. Reservation grace periods are vacations, so the modelled wait understates reality exactly when Reservations are busiest.

---

## What has to change before `bmad-architecture`

1. **Decide C1.** Pick how the plan job reads the S26 without an exclusive FIFO Hold, or drop the plan-time Reservation and reserve at android-job start instead.
2. **Decide C2.** Write the full Reservation state machine: taken, at head, grace, after grace, claimed, expired, cancelled. Name the actor that releases each transition when no hub process is running.
3. **Make SM-1 achievable (C3).** Pick one of three: Lease extension rules that respect a waiting deploy, a deploy-eligible-Resource Lease cap, or a deploy wait budget derived from ETA. Then redefine SM-1 to count lost *deliveries*, not failed runs.
4. **Decide C4.** Either drop remote waiting Claimants from v1 (local CLI and loopback, process-bound only), or specify a ticket-level expiry that every pinned version honours.
5. **Cut scope (H5).** Ship the starvation fix first.
6. **Make the Event Log measure the metrics (H3).** Add `hub_version`, `eta_at_enqueue`, register and edit events, Reachability transitions, claim, expire, lapse and force-release events, and a Claimant kind for the catch-up and internal locks. Unify the low-data thresholds.
7. **Remove the deploy-eligible flag (H4)** until v2. Make `registry.json` the one source that deploy code also reads, or keep deploy targets in `devices.json` and `policy.json` and say so.
8. **Model the iPad under `mac-ios` (H2).** Or specify multi-Resource acquire with a fixed lock order.
