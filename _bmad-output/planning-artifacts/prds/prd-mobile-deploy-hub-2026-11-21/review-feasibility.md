# Feasibility Review (code-grounded): Hub Resource Registry PRD

- **Reviewed:** `prd.md` and `addendum.md` in this folder, against the repo at `fc98114` (v1.2.42; the workflow now pins `actions/hub@v1.2.42`).
- **Code read:** `tools/ci/lib/lock.mjs`, `tools/device/{hub-device,emulator,inventory,adb-wire}.mjs`, `tools/ci/lib/{devices,adb,handoff,policy}.mjs`, `tools/ci/commands/{plan,android,ios,gate,common}.mjs`, `tools/catchup/catchup.mjs`, `tools/catchup/units/*`, `.github/workflows/mobile-deploy.yml`, `.candybars/mobile-deploy-hub-ios-catchup/*`, and the suites `tools/device/*.test.mjs`.
- **Not read:** Holocene's code. FR-24 to FR-28 are assessed only where they depend on the hub. `holocene-api.service` is a host systemd user service on big-chungus, so a Hub API bound to loopback is reachable from it (NFR-6).
- **Scope:** feasibility and hidden cost only. PRD quality issues are in `review-rubric.md`. Where the two overlap, this review adds only the code evidence.

## Verdict

The PRD can be built on the existing lock code. As written, though, four of its promises collide with that code:

1. UJ-1/FR-9 against the plan job's S26 downgrade guard.
2. FR-23/FR-10 against the pid-bound queue-ticket pruning.
3. FR-12 against the Candybar-kicked Mac LaunchAgent.
4. NFR-2, whose list of who reads the on-disk layout is incomplete.

None of these blocks the PRD, but each needs a decision in the PRD before architecture starts.

## Two systemic findings behind most of the rest

### S1. Up to five versions of `lock.mjs` act on one lock dir at once (NFR-1 holds only at the source level)

| Reader/writer | Which version it runs | How it moves |
|---|---|---|
| Deploy jobs | the run's pinned tag (`mobile-deploy.yml:130…529`, now v1.2.42) | pin flip, but every rerun inside GitHub's 30-day window keeps its old pin |
| S26 catch-up (big-chungus) | `~/.local/share/mobile-deploy-hub/current` | **advances on its own** at every real deploy's deliver job (`deliver.mjs:295` → `installCurrent`, `common.mjs:109-129`, newest-wins) |
| iPad catch-up (Mac) | the Mac's `current` | advances at every real iOS job (`ios.mjs:401-402`) |
| `hub-device` | the release dir that `hosts:install` wrote (`install.sh:42-44`; this is *not* `current`) | only at `hosts:install` |
| Hub API, Mac Agent (new) | whichever of the above they are installed from | long-lived processes keep old code in memory until they restart |

Consequences:
- The on-disk layout (`<name>.lock/owner.json`, `<name>.queue/*.json`, and the new `<name>.reservations/`, `events.jsonl`, `registry.json` and fence counter) is the real contract. It needs its own version and forward/backward-compatibility rules.
- "One lock, queue and Reservation implementation" (NFR-1) is true of the source only. At runtime, N frozen copies of the serving rule coexist.
- The addendum's rollout (§B.10: "pin flip, then `hosts:install` turns on the new behaviour") is half right. The catch-up switches to new semantics at the **first real deploy on the new pin**, on both hosts, whether or not `hosts:install` has run. The Hub API and `hub-device` switch only at `hosts:install`. After later releases, the API can lag the layout that `current` writes.

### S2. Queue tickets are bound to a pid and pruned by every acquirer

- `staleWaiter` (`lock.mjs:139-146`) treats as stale any ticket that is from another host, lacks `pid`/`process_start`, or names a dead or reused process.
- `acquireLease` prunes on every 1 s poll (`listWaiters(..., { prune: true })`, `lock.mjs:213`). FR-8 would make every `withLock` do the same.

So:
- Anything without a live local process cannot live in `.queue/`. That covers Reservations (the addendum §B.3 already sees this), remote/heartbeat waiters, and queue positions owned by the API across a restart.
- Any new ticket kind that pruners must respect has to ship **in or before the first release whose `withLock` prunes**. Every later pin's `staleWaiter` is frozen at that release. In effect, the first queue-joining release freezes the ticket format. The PRD should say so in NFR-2.

## Per-FR verdicts

Legend: **F** = feasible as written; **C** = needs a change to the PRD; **B** = blocked as written.

### 4.1 Registry

| FR | Verdict | Evidence | Hidden cost |
|---|---|---|---|
| FR-1 Register | **C** | The fleet is built only from `devices.json` (`hub-device.mjs:50-57, 698`). The lock-name regex `^[a-z0-9-]+$` (`lock.mjs:74,110`) fits `res-<slug>`. | <ul><li>"No `hosts:install`" holds only after one `hosts:install` has shipped a registry-reading `hub-device` (S1).</li><li>The reserved words must include `s26` (already reserved at `devices.mjs:35`) and the new `ipad` and `mac` words (FR-12), not just `phone`, `emulator` and `adb`.</li><li>Seeding code must not live under `tools/ci/{lib,commands}` or `tools/catchup`: `hub-device.test.mjs:332-343` fails if any file there mentions `android_extra`.</li></ul> |
| FR-2 Edit/retire | **C** | Deploys hard-code `adb` and `mac-ios`: `plan.mjs:230`, `android.mjs:112`, `ios.mjs:276,390`, `catchup.mjs:456,574`. | <ul><li>Retiring a seeded, deploy-eligible Resource cannot stop deploys, and pinned versions never read the Registry. State that the seeded deploy Resources cannot be retired, or that retiring affects Leases only.</li><li>"Stops taking new Holds" must be enforced where `hub-device` and `lock.mjs` read `registry.json`, not only in the API. The CLI must also honour it with the API down (FR-13).</li></ul> |
| FR-3 Seed | **F** | Lock names are preserved by `fleetOf` (`adb` for the S26, the lowercased name for extras). The QA file path and `$HUB_QA_DEVICES` are documented in `README.md:219`. | <ul><li>Copying the private QA file into `<lockDir>/registry.json` satisfies "never committed", but its serial and `allowed_users` will then reach the Holocene page. Decide what the page shows.</li></ul> |
| FR-4 Discover | **C** | `inventory.mjs` reads only `/proc` (adb servers, emulators, Xvfb). It lists **no devices**. The device listing is `phonePresence` (`hub-device.mjs:459-488`: `adb devices` plus `adb mdns services`, only when the hub's server is already running). | <ul><li>Say "reuses status's read-only adb query", not "the inventory".</li><li>A bare `host:port` id with no mDNS record has no serial without a `getprop`. That is a device query, not a connect, but the PRD should allow it.</li></ul> |
| FR-5 Reachability | **C** | `findPhone` **starts the adb server** (`adb.mjs:107`) and makes mDNS `adb connect` nudges (`adb.mjs:125-131`). Status uses read-only `idMatchesSerial` over `adb devices` (`hub-device.mjs:479-482`). The iPad needs devicectl, which works only in the logged-in GUI session (`kick.mjs:4-6`, plist comment). | <ul><li>"Uses the same `findPhone` matching" contradicts FR-4 and status's "never starts or connects". Name `idMatchesSerial` instead.</li><li>iPad Reachability cannot be read over plain ssh. See FR-12.</li></ul> |
| FR-6 Capability | **C** | Today `phone` is deliberately **not** first-come-first-served: each pass is `waitMs: 0` (`hub-device.mjs:199-226`). Its exact BUSY/AWAY verdicts are pinned by `hub-device.test.mjs:253-312`. | <ul><li>A Pool Queue spanning `s24` and `adb` needs an ordering across queues that the PRD does not define, and pinned deploys' `withLock('adb')` will never consult a Pool queue.</li><li>Recommended: a Pool waiter puts a pid-bound ticket in **every** member's `.queue/` and drops the others when it wins. Existing acquirers already honour such tickets.</li><li>Change "keeps its CLI behaviour" to "keeps its exit codes and messages". The ordering will change, correctly.</li><li>API level is not in `devices.json`: it must be declared at registration or read with `getprop`.</li><li>An emulator profile is a request parameter, not a property of a slot (`emulator.mjs:42-45, 476-505`).</li></ul> |

### 4.2 Holds, Queues and Reservations

| FR | Verdict | Evidence | Hidden cost |
|---|---|---|---|
| FR-7 FIFO | **F** among Claimants on the new semantics | Old pins (≤ v1.2.42) take bare `mkdir` locks (`lock.mjs:81-97`). The gate calls `findPhone` with **no lock at all** (`gate.mjs:138-147`). | <ul><li>The catch-up is an unnamed Claimant kind. Its 5 s window (`catchup.mjs:467,589`) means a timeout on most passes once it queues. Classify it, or it inflates λ and abandonment in FR-19 and fires FR-20.</li></ul> |
| FR-8 Deploy jobs queue | **C** | The addendum §B.2 mechanism works: `acquireLease` ≥ v1.2.26 honours any non-stale ticket. Verified: v1.2.25's `lock.mjs` has no `acquireLease`, v1.2.26's has one. | <ul><li>**Timeout wording is an interface.** The catch-up matches `/host lock adb is held/` and `/host lock mac-ios is held/` (`catchup.mjs:469,591`), and the reaper matches `/^host lock emulator-reaper /` (`emulator.mjs:312,342`). Copying `acquireLease`'s queued wording ("host lock adb has N waiters ahead…", `lock.mjs:251`) makes the catch-up throw. Keep "host lock X is held" or add an error code.</li><li>`withLock` also guards `s3-index`, `s3-<slug>` and `emulator-reaper` (`s3.mjs:219`, `deliver.mjs:249`, `bucket-policy.mjs:208`, `emulator.mjs:297,340`). Scope queue-joining to Registry Resources, or those locks pollute the Event Log.</li><li>Text status prints `undefined` for a job ticket (`hub-device.mjs:553`), because job tickets have no `lease_id`, `holder` or `why`.</li><li>**Wait budgets:** plan waits 20 min in a 20 min job (`plan.mjs:234` vs `yml:196`). Android waits 20 min **after** the build in a 45 min job (`android.mjs:156` vs `yml:258`). iOS waits 40 + 40 min around in-lock builds in a 120 min job (`ios.mjs:344,390` vs `yml:377`). "Shorter than the job timeout" needs a budget relative to the job's start, and the action does not know its `timeout-minutes` today. That is a new action input (a hub-side change; the caller template is unaffected).</li><li>The consequence "held only by Claimants behind it" can be guaranteed only when those Claimants are on the new semantics.</li></ul> |
| FR-9 Reservation | **C**, UJ-1 **B** as written | Plan needs the phone **before the bump**: the S26 versionCode downgrade guard (`plan.mjs:228-243, 274-276`). Android takes `adb` only after export, editions and the Play bundle (`android.mjs:49-112`). | See the FR-9 deep dive. |
| FR-10 Leases/Heartbeat/fencing | **C** | Encoding the Heartbeat in `expires_at` works for every version ≥ v1.2.26 (`lock.mjs:47-48`). `updateLease` has **no expiry check** and is read-check-write (`lock.mjs:290-299`). Nothing sits between a job and adb or devicectl that could check a token. | See the FR-10 deep dive. |
| FR-11 Cancel/force-release | **F** | `releaseLease` cancels by id and refuses a job's lock (`lock.mjs:263-286`, `reason: 'not-a-lease'`). | <ul><li>Force-releasing a Reservation means deleting a file. Cancelling a run frees its Reservations only if `announce` (`if: always()`, `yml:511-514`) deletes them: locally for `adb`, over ssh for the Mac's.</li></ul> |
| FR-12 iPad/Mac | **C** | `mac-ios` covers the Mac **build** and the iPad install (`ios.mjs:276-344`) and the iPad catch-up (`catchup.mjs:574-592`). It lives on the Mac's disk. | See the FR-12 deep dive. |
| FR-13 CLI compat | **C** | The lock dir is the store of Holds, so local Leases work with the API down. | See the FR-13 deep dive. Several existing tests break under other FRs. |

### 4.3 Visibility and ETA

| FR | Verdict | Evidence | Hidden cost |
|---|---|---|---|
| FR-14 Live status/stream | **C** | Changes from the CLI and from jobs bypass the API, so the API must watch the lock dir (recursive `fs.watch` on Linux works in Node 24). | <ul><li>Expiry, Heartbeat jeopardy and lapse, grace end and quarantine are **time** transitions. No file event marks them, and NFR-3 forbids timers. Either render them from timestamps (the page computes "in jeopardy" from `last_heartbeat`) or allow one-shot wakeups at known deadlines.</li><li>Mac-side changes cannot arrive within 2 s unless something on the Mac pushes them (FR-12).</li><li>The SSE ping every 30 s is a protocol keepalive, not recurring work. Say so explicitly so it is not read as a second clock.</li></ul> |
| FR-15 ETA | **F** with a change | The owner record holds `repo`, `run` and `started_at` but **no job** (`lock.mjs:78,218`). | <ul><li>Add `job: GITHUB_JOB` to owners and tickets. Holds by old pins cannot be attributed to a job.</li><li>A deploy computes its ETA in its pinned code (NFR-1), so different pins print different ETAs.</li><li>Reading 90 days of `events.jsonl` on every 2 s poll needs cached aggregates.</li></ul> |
| FR-16 ETA in logs | **C** | `lease.test.mjs:98` asserts `^HUB_LOCK_WAIT adb held by delorenj/example run 9`. | <ul><li>The shape `HUB_LOCK_WAIT <resource> position=<n> eta=<range>` breaks that test, which FR-13 says passes unchanged. Keep `held by …` first and append `position= eta=`, or print a second line.</li><li>"Whenever either changes": the ETA changes every second, so give a threshold.</li></ul> |

### 4.4 Event Log and Capacity Estimate

| FR | Verdict | Evidence | Hidden cost |
|---|---|---|---|
| FR-17 Record once | **F** | The hook points in addendum §B.1 match the code. Small JSONL appends with `O_APPEND` are safe across processes. | <ul><li>Pinned runs emit no events until they age out, so history under-counts holds for about 30 days after the pin flip.</li><li>The Mac's events live on the Mac's disk.</li><li>A pre-existing race in `reclaim` (`lock.mjs:58-63`: read, compare, `rmSync`) can delete a holder that took the lock in between and log a second reclaim. Rare, but it makes "exactly once" tests flaky under concurrency.</li></ul> |
| FR-18 History | **F** | — | <ul><li>Compaction (a Candybar job, NFR-3) must not rewrite the live file while others append. Rotate by period.</li><li>Two hosts: a Mac compaction job is another kick over ssh.</li></ul> |
| FR-19 Capacity | **F** (math); data caveats | — | <ul><li>λ is biased by missing old-pin holds and by catch-up attempts every 5 min (FR-7).</li><li>Holds on `s3-*` and `emulator-reaper` must be excluded (FR-8).</li></ul> |
| FR-20 Starvation | **F** | A timed-out deploy appends its own event, so `fs.watch` gives it within 2 s. | — |

### 4.5 Hub API

| FR | Verdict | Evidence | Hidden cost |
|---|---|---|---|
| FR-21 Endpoints | **F** | Plain `node:http` matches the zero-dependency tools. | — |
| FR-22 Same semantics | **F** with refactor | `takeLease` and `takeAnyPhone` are private to `hub-device.mjs:153-226`. | <ul><li>Extract them into a library.</li><li>`acquireLease` run in the API ties tickets to the **API's** pid (`lock.mjs:205`). That feeds the FR-23 problem.</li></ul> |
| FR-23 Survive restarts | **B** for queued remote Claimants | Tickets owned by the API die with its pid and are pruned on the next poll of any acquirer (S2). | <ul><li>Emulators that the API spawned die on restart: `launch` uses `detached: true` (`emulator.mjs:407-418`), but systemd kills the unit's whole cgroup by default. The catch-up unit already needed `KillMode=process` (`mobile-deploy-hub-catchup.service:17`).</li><li>The in-flight emulator boot (up to 6 min, `bootTimeoutMs`) is lost.</li></ul> |

### 4.6 Control Surface

Not assessed against Holocene code. **FR-26 hides a hub cost.** Under FR-10, every Lease held through the API without a local process lapses 90 s after its last Heartbeat. A Lease Jarad takes from the page therefore needs Holocene, or the open tab, to send Heartbeats every 30 s. That is a private recurring loop (NFR-3), and closing the tab loses a 2 h Lease. Make the Heartbeat opt-in: for agents' Leases and queued remote waiters only, while a page Lease is bound to its expiry like a CLI `--no-connect` Lease today.

## Deep dives

### FR-8 and FR-9: `withLock` joining the queue, and Reservations surviving `staleWaiter`

**What works.**
- A `withLock` that writes a pid-bound ticket with `{kind:'job', repo, run, job, pid, host, process_start}` and takes the lock only at the head is honoured both ways by every `acquireLease` ≥ v1.2.26. No layout change is needed for that.
- Keeping Reservations in `<name>.reservations/`, outside `staleWaiter`'s reach, is the right call.

**What the PRD must still decide.**

1. **UJ-1 conflicts with the plan job's downgrade guard (critical).**
   - UJ-1 has the plan job take position 2 behind a 30 min Lease and go on to build.
   - But plan reads the S26's installed versionCode under `adb` and refuses a planned code at or below it **before the bump** (`plan.mjs:228-243, 274-276`).
   - If plan does not wait, `phone` is null and the guard is skipped, as for an away phone. The only remaining check is `android.mjs:126`, **after** the version is spent. That recreates the failure the Vision names: failing after the version was already bumped.
   - The case is likeliest exactly when a Lease holds the S26, because a QA agent may install a higher dev build.
   - If plan does wait in first-come-first-served order behind a 30 min Lease, it times out at 20 min (`plan.mjs:234`, `yml:196`).
   - Pick one:
     - (a) a read-only peek at the versionCode, allowed while a *Lease* holds the S26;
     - (b) plan waits, with a larger plan budget;
     - (c) accept a refusal after the bump, and say so.
2. **Grace against the build.**
   - The run's earliest arrival is plan time. Its install claim comes after the whole android job: GitHub queueing for a runner, `applyBump`, export, editions and the Play bundle (`android.mjs:49-112`).
   - With a 10 min grace, a Reservation that reaches the head during the build often lapses, after idling the S26 for 10 min. The PRD does not say what happens after the grace (`review-rubric.md` already flags this). The code adds that the gap is a full build, not a short handoff.
3. **Self-deadlock is structural, not an edge case.** Plan's own `withLock('adb')` comes after its Reservation in the order, so it waits on itself unless `withLock` recognises a Reservation of the same run (`GITHUB_RUN_ID`, constant across attempts) and goes through it. The iOS job also takes `mac-ios` twice (`ios.mjs:276`, `:390`), and in a first-come-first-served queue its second take goes to the back.
4. **Where the iOS Reservation is written.**
   - Plan runs on Linux, so a `mac-ios` Reservation from plan needs ssh and the Mac's `current` `lock.mjs`, which is a different version (S1).
   - `preflight-ios` already runs on the Mac before plan (`yml:159-190`). Writing the Reservation there keeps it local and in the run's own pinned version.
   - The same reasoning puts the earliest `adb` Reservation in the gate (Linux, `yml:107`).
5. **The serving rule must ship with queue-joining.** Every acquirer must merge `.queue/` and `.reservations/`. If Reservations land in a later release than queue-joining `withLock`, the pins in between ignore them forever (S2).
6. **Store the grace in the Reservation record** (`grace_s`, `head_since`). A policy-pinned value differs between pins, and `policy.json` is parsed strictly (`policy.mjs:15, 232`). The evaluator must use the writer's number.

### FR-10: the fencing token reaching install and readback

- **No verifier exists.** The install is `adb.install(id, apk)` inside the `withLock` callback (`android.mjs:146-152`; the callback gets no argument, `lock.mjs:100`), and on the iPad `ipad.install` (`ios.mjs:331`). Neither adb nor devicectl can refuse a token. "A stale token is refused" can only mean the job re-reads `owner.json` and compares just before the install, and compares again at readback. At readback it can only *report*, because the install has already happened.
- **Low value for Job Holds.** A Job Hold belongs to a live pid. It is lost mid-callback only through:
  - the `reclaim` race (`lock.mjs:58-63`);
  - age over `staleMs` (4 h, impossible inside a 45 min or 120 min job);
  - a force-release, which FR-11 forbids.

  The holders that fencing is designed for are remote holders whose Heartbeat lapsed. They drive adb themselves (§6), so the hub cannot fence them.
- **Cost.** The counter must live outside `<name>.lock/`, because release `rmSync`s that directory (`lock.mjs:103,61`). Old pins never increment it, so "every Hold carries a token" is false for them. The catch-up's installs (`catchup.mjs:394-401`) are out of FR-10's scope.
- **Recommendation.** Reword as "re-check the hold immediately before the install, and report at readback", and fix the `reclaim` race. Or defer the token.
- **The real Heartbeat hazard is `updateLease`** (`lock.mjs:290-299`). It reads, checks and then rename-writes, with no `expires_at > now` check:
  1. A late Heartbeat reads a nearly expired Lease L.
  2. A waiter reclaims L and writes its own `owner.json`.
  3. The Heartbeat's rename **overwrites the new holder's record** with L, and returns true.

  Two fixes: refuse a renewal at or after `expires_at`, and **encode the quarantine in the on-disk `expires_at`** (lapse + 15 s). Pinned `stale()` (v1.2.26–v1.2.42) reclaims exactly at `expires_at` and knows nothing of a quarantine. Keep the Lease's stated end in a separate `ends_at`, or FR-15's "expected end is its expiry" reads the 90 s TTL.

### FR-12: the Mac Agent against the Candybar-kicked LaunchAgent and the single-clock rule

**Today's shape.**
- `sh.delo.mobile-deploy-hub.catchup` is a one-shot `catchup.mjs ios` with no `StartInterval`, `RunAtLoad` or `KeepAlive` (plist; `install.sh` Darwin branch).
- Candybar on big-chungus kickstarts it over ssh every 5 min (`.candybars/...candybar.toml`, currently `enabled = false` pending the cutover).
- `kick.mjs` treats `state = running` as a pass in flight and returns `HUB_MAC_BUSY` as a **success** (`kick.mjs:79`). It judges a run by `runs` and `last exit code` (`kick.mjs:43-48`).

**Open Question 2, option 1 (host the Mac Agent inside the catch-up LaunchAgent): infeasible.**
- A long-lived agent under that label leaves the job `running` forever. Every Candybar fire then reports a green `HUB_MAC_BUSY`, and the iPad catch-up silently stops.
- launchd runs one instance per label. `kickstart` on a running job does nothing, and `kickstart -k` kills an in-flight install.

**Option (a), ssh per call (addendum §B.6).**
- Works for lock-file operations, which need no GUI session.
- Cannot read iPad Reachability: devicectl works only in the GUI session (`kick.mjs:4-6`). Kicking a separate label per check serializes the checks and takes seconds.
- Cannot push Mac-side changes such as an iOS job taking `mac-ios`, so FR-14's 2 s needs polling, which NFR-3 forbids.
- Every remote Lease on the Mac costs one ssh round-trip per 30 s Heartbeat over a link that may be metered or relayed through DERP. `retried()` backs off 15, 45 and 90 s (`handoff.mjs:83`), longer than the 90 s lapse.
- A ticket written by a process started over ssh dies with that process (S2). So queued waits on the Mac need a process that lives on the Mac.

**Option (b), a separate KeepAlive LaunchAgent in the GUI session.**
- This is the only shape that meets FR-5 for the iPad and FR-14 for the Mac. It is consistent with the Candybar rule: a service, not a clock, as long as it watches the lock dir with FSEvents, reads devicectl only on request, and never reaps or polls on a timer.
- Costs:
  - a second plist in the `install.sh` Darwin branch;
  - a push channel to the Hub API, with reconnects only on demand;
  - it must restart, or exit lazily, when the Mac's `current` moves (`ios.mjs:402` advances it), or it serves old code.

**The iPad lock name (needs a decision).**
- *A new `ipad` lock.* Ignored by every pinned iOS job and by the Mac's `current` catch-up, which take only `mac-ios`. An iPad Lease would then not exclude deploys (contradicting FR-22) until those age out.
- *The iPad Lease takes `mac-ios`.* Compatible, but an iPad QA Lease then blocks 40 min Mac builds.

**FR-12's first-come-first-served for iOS jobs needs no Mac Agent.** It is the queue-joining `withLock` running on the Mac. The Agent is needed only for visibility, remote Leases and Reachability.

### FR-13: the CLI working with the API down while the API is the only Registry writer

**Not a contradiction for Holds.**
- Holds, Queues, Reservations and events live in the lock dir and are written by `lock.mjs` in whichever process acts: the CLI, a job, the catch-up or the API.
- With the API stopped, `hub-device lease s24` works, and the API reads that Lease from disk when it returns.
- The Registry is metadata. `hub-device` reads `registry.json` and falls back to `devices.json` (addendum §B.5).

**A contradiction in three narrower places.**
1. **Registry writes stop with the API.** FR-1, FR-2 and FR-25 are unavailable while it is down; say so. Retirement must be enforced by readers of `registry.json` (FR-2), or a retired phone stays leaseable from the CLI.
2. **The remote Claimants' state lives in the API process.** Heartbeats cannot be received, and API-owned queue tickets are pruned by the first CLI or job poll after the API's pid dies (S2). FR-23's "keeps its position across a restart shorter than its Heartbeat lapse" fails even for a 1 s restart if anyone else polls.
3. **Remote tickets need a liveness rule all pruners honour.** Ticket keepers re-adopted from a store (addendum §B.4) are a second store of Queue positions, contrary to NFR-1. The real fix is a remote-ticket rule (`kind:'remote'` plus `expires_at`) that every pruner honours. It must ship with or before queue-joining `withLock` (S2), and it changes `staleWaiter`, which has **no covering test today** (per CodeGraph).

**"Existing `tools/device/*.test.mjs` pass unchanged" collides with other FRs.**
- `lease.test.mjs:98`: the `HUB_LOCK_WAIT … held by` prefix (FR-16).
- `hub-device.test.mjs:909-941`: `install.sh` may tell systemd only `--user daemon-reload` (enable or start is refused). A Hub API unit enabled or socket-activated from `install.sh` fails it, so enable it from `hosts.mjs`, or change the test.
- `hub-device.test.mjs:332-343`: no `android_extra` under `tools/ci/{lib,commands}` or `tools/catchup` (affects where the Registry code lives).
- `hub-device.test.mjs:842-878`: `status` must leave the lock dir untouched (no lazy seeding or event writes), and `phones` must stay exactly `[s24, s26]`. The iPad and the Mac go elsewhere in the JSON.
- `hub-device.test.mjs:253-312`: `phone` ordering and the BUSY/AWAY wording (FR-6).
- `emulator.test.mjs:375-380`: pool-size precedence `$HUB_EMULATOR_POOL` > `<lockDir>/emulator-pool`, with its exact error text. A pool size kept in the Registry must rank below both.
- `hub-device.test.mjs:903-907`: a source scan for kill, launch and disconnect patterns.

## NFRs

| NFR | Verdict | Evidence and cost |
|---|---|---|
| NFR-1 One implementation | **C** | True of the source only; see S1. Name the on-disk protocol as the contract, with a version field. |
| NFR-2 Pinned compatibility | **C** | <ul><li>**Confirmed:** v1.2.25's `lock.mjs` has no Leases (an old `stale()` sees a Lease's dead pid as a dead job). Every pin through v1.2.42 takes bare locks.</li><li>**The list of readers is incomplete:** `current` advances on its own (`deliver.mjs:295`, `ios.mjs:402`), and the Hub API and Mac Agent lag at the release dir of `hosts:install` (S1).</li><li>**Unstated constraints:**<ul><li>the ticket format freezes at the first release whose `withLock` prunes (S2);</li><li>the quarantine must be encoded in `expires_at` (FR-10);</li><li>the iPad lock-name choice (FR-12);</li><li>the "host lock X is held" wording parsed by the catch-up (FR-8);</li><li>never express a Reservation as an `owner.json`: every pin's `stale()` reclaims an owner with no live pid (`lock.mjs:53`) or, from v1.2.26, honours only `kind:'lease'`.</li></ul></li><li>**The layout stays readable:** old readers filter on `*.lock` and `queue/*.json` (`lock.mjs:152,305`), so new sibling files are ignored.</li></ul> |
| NFR-3 No new clock | **C** | <ul><li>Expiry and lapse handled lazily work, and match the lazy emulator reaper (`hub-device.mjs:700-702`).</li><li>They conflict with FR-14 and FR-24's 2 s for *time* transitions (see FR-14).</li><li>The Mac Agent must be option (b), with no timers (FR-12).</li><li>Holocene's page Leases would need a Heartbeat loop (§4.6).</li><li>The SSE ping is fine if declared as a protocol keepalive.</li></ul> |
| NFR-4 Node only | **F** | — |
| NFR-5 Hermetic | **F** | The fixtures already use `HUB_LOCK_DIR` and an injected `now`/`sleep`. Mac Agent tests must mock ssh and launchctl, as the `install.sh` test does with shims. |
| NFR-6 Reach | **F** | `holocene-api.service` is a host user service, so loopback is reachable. |
| NFR-7 Latency | **C** | <ul><li>Live phone presence costs up to 5 s (`hub-device.mjs:475`), and a Mac read over ssh has a `ConnectTimeout` of 30 s (`kick.mjs:31`). A status read under 200 ms must serve cached Reachability with its "last checked" time (FR-5).</li><li>Exclude emulator boot (up to 360 s) from "acquire < 1 s", along with finding the phone.</li></ul> |

## Corrections to the addendum's evidence

- `android.mjs:98` is now `:112`, and `:142` is now `:156`. The pin is v1.2.42 (`fc98114`), not the `4cdefdc` baseline.
- "`gate.mjs:138-140` hard-codes the `adb` lock": the gate takes **no lock**. `quickS26` calls `findPhone` with no lock (`gate.mjs:138-147`), so it can start the adb server and mDNS-connect while a Lease holds the S26. It hard-codes the S26 identity, not the lock.
- "An owner whose `host` is not this host is treated as stale" (§A) is wrong for owners; `AGENTS.md:23` repeats the claim.
  - A Lease from another host is judged only by its expiry (`lock.mjs:49`).
  - A job owner from another host goes stale only after `staleMs` of 4 h (`lock.mjs:53-54`).
  - Only **queue tickets** from another host are stale (`lock.mjs:142`).
  - The conclusion still holds (the API must run on big-chungus as the runner user), because of the tickets and the local `holder_pid` checks.
- "The plan job holds `adb` … then the build runs … then the android job takes `adb`": the build runs **inside** the android job, before its `withLock` (`android.mjs:49-112`). The gap is the whole android job up to its install, not a separate build job.

## Recommended PRD edits

1. **UJ-1/FR-9:** choose how the plan job's downgrade guard works under a Reservation (peek, wait, or a refusal after the bump). Say what happens after the grace. Write the Reservations in the gate and in `preflight-ios`. Store the grace in the record.
2. **FR-10:** turn the fencing token into "re-check before install, report at readback", or defer it. Add "a renewal at or after lapse is refused", encode the quarantine in `expires_at`, and add `ends_at`.
3. **FR-12 and Open Question 2:** close the question as "a separate KeepAlive GUI LaunchAgent that is a service, never the catch-up label". Decide the iPad lock name.
4. **FR-13 and FR-23:**
   - Add the Registry-write outage and the remote-ticket liveness rule.
   - Scope FR-23 to Holds and Reservations, or require the remote-ticket rule in the first queue-joining release.
   - Name the existing tests that the new FRs must keep green.
5. **NFR-2:** add S1's list of readers, the ticket-format freeze, the quarantine encoding and the parsed timeout wording. Correct the rollout: `current` flips at the first real deploy on the new pin.
6. **NFR-3 and FR-14:** time transitions are derived from timestamps, not pushed. The SSE ping is declared a keepalive. Heartbeats are opt-in.
7. **FR-4 and FR-5:** reuse status's read-only adb query and `idMatchesSerial`, not the inventory or `findPhone`.
8. **FR-6:** define how a Pool waiter is ordered against per-device queues (recommended: a ticket in every member's queue). Change "keeps its CLI behaviour" to "keeps its exit codes and messages".
9. **FR-8:** wait budgets relative to the job's start. Keep the "host lock X is held" wording. Queue-joining for Registry Resources only. Add `job` to owners and tickets.
