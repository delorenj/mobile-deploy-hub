---
title: Hub Resource Registry
status: draft
created: 2026-11-21
updated: 2026-11-21
---

# PRD: Hub Resource Registry
*Working title. Covers the registry, its Hub API and the Holocene page.*

## 0. Document Purpose

This PRD is for Jarad, the hub's owner and only operator, and for the downstream architecture and epic workflows that will build it. It extends what mobile-deploy-hub already does well: leases, first-in-first-out queues and the emulator pool in `tools/ci/lib/lock.mjs`, `tools/device/hub-device.mjs` and `tools/device/emulator.mjs`. It turns that into a registry every app, agent and deploy run can rely on. Inputs:
- `_bmad-output/planning-artifacts/resource-registry-seed.md`, which holds the requirements and the gap evidence with file and line references;
- Jarad's answers of 2026-11-21, recorded in `.memlog.md`;
- the four reviews in this folder (`review-rubric.md`, `review-adversarial.md`, `review-feasibility.md`, `reconcile-inputs.md`), checked against the code at v1.2.42.

Terms come from the Glossary (§3) and are used exactly. Features are grouped, with globally numbered FRs nested under them. FR numbers are stable: a new FR takes the next free number even when it sits in an earlier section. Inferences are tagged `[ASSUMPTION]` and indexed in §10. Mechanism, transport, failure modes and the queueing math live in `addendum.md`.

## 1. Vision

The hub's device leasing works, and Jarad wants to keep it and grow it. Today it knows two phones by name, a small emulator pool, and an iPad and a Mac it cannot lease. Deploy runs do not stand in line: they keep retrying the lock, so queued Leases win every handoff, and a deploy can wait out its limit and fail after its version was already bumped. Nobody can see that the deploy is waiting, how long it will wait, or whether one more phone would have prevented it. Agents cannot tell which phone deploys install to, or whether it is free.

The Hub Resource Registry makes every contended thing a **Resource**: phones, the iPad and the Mac's iOS lane, and emulator slots. Each one is registered once, and registering needs no hub release. Every **Claimant** stands in the same first-come-first-served **Queue**: a deploy run, a hub job such as the catch-up, an agent or Jarad. A deploy run takes a **Reservation** when it starts and keeps its place through its build. A deploy that cannot get its device in time no longer fails: its delivery goes pending and the catch-up installs it when the device frees, exactly as it does today for a device that is away. Every waiter sees its position and an **ETA**. An append-only **Event Log** records every request, hold and release. From that history the hub answers "how much waiting would one more device save?" with a **Capacity Estimate** instead of a guess.

It is driven through a **Hub API** written in Node, which wraps the existing lock code rather than replacing it. Each host's locks are owned by a **Host Agent** on that host; v1 runs one on big-chungus (inside the Hub API) and one on the Mac. It is managed from a **Control Surface**: its own page in Holocene, the canonical control surface. The hub keeps authority over Holds and Queues. Holocene shows them and forwards Jarad's actions.

## 2. Target User

### 2.1 Jobs To Be Done

- **A deploy run:** wait its turn for its deploy target (the S26, or the Mac's iOS lane with the iPad) without being shut out by a stream of Leases, keep its place through its build, and never spend a version on a delivery that contention blocks.
- **An agent:** find out which phones and emulators exist, which are reachable, which are free and which ones deploys install to, and take one that fits. If none is free, join the line and learn how long the wait is, instead of guessing from `devices.json` or retrying.
- **Jarad:**
  - register a new phone or emulator profile in a minute and have every agent use it, with no hub release;
  - see who holds what and who is waiting, from the Control Surface in any browser where he is signed in;
  - cancel or release a stuck Hold;
  - decide with numbers whether another device is worth adding.

### 2.2 Non-Users (v1)

- Anyone but Jarad's own apps, agents and deploy runs. This is not a device farm for other people.
- Resources on hosts without a Host Agent. v1 ships Host Agents on big-chungus and on the hub's Mac (`hub-mac`). A third host joins by running a Host Agent and registering it, not by a redesign; no third host is planned for v1.

### 2.3 Key User Journeys

- **UJ-1. Tower's deploy run is not shut out.**
  - Jarad ships Tower while an agent holds the S26 on a 30-minute Lease and a Green In Between deploy is already waiting.
  - Tower's gate job takes a Reservation on the S26 and lands at position 2, with an ETA of 20 to 30 minutes, which its job log prints.
  - Tower's plan job peeks at the S26's installed version without waiting for the Lease to end, bumps, and the android job builds. The Reservation keeps Tower's place through all of it.
  - When the S26 frees and Green In Between finishes, Tower's android job claims its Reservation and installs.
  - **Edge case:** the Lease holder tries to extend while Tower and Green In Between wait. The extension is refused with the names of the waiters, unless Jarad overrides it from the Control Surface.
  - **Edge case:** the Lease ahead runs long and Tower's install wait runs out. Tower's delivery is marked pending, the build is published, and the catch-up installs it on the S26 when the S26 frees. The version is not wasted.
- **UJ-2. An Earshot QA agent finds a phone.**
  - The agent runs `hub-device lease phone --wait` on big-chungus and gets the S24.
  - When both phones are held, the agent waits in the phone Pool's line at position 1 with an ETA of 5 to 10 minutes, gets the first phone that frees, and releases it when the run ends.
  - **Edge case:** the agent's process dies mid-wait. Its place is dropped by the next Claimant that looks at the line, as today, so nobody waits behind a ghost.
- **UJ-3. Jarad registers a new phone from Holocene.**
  - Jarad pairs a Pixel with big-chungus over wireless debugging, opens the Control Surface, and sees it listed as a discovered, unregistered device.
  - He registers it with a name, kind and Capabilities.
  - Within a minute an agent can lease it, and `hub-device status --json` shows it. No hub release or `hosts:install` was needed.
- **UJ-4. Jarad decides whether to buy another phone.**
  - The Control Surface's capacity panel shows the phone Pool over the last 14 days: requests per hour, mean hold time, measured mean wait, and the expected mean wait with one more phone.
  - The panel says 9 minutes now and about 1.5 minutes with one more, roughly 4 hours of waiting saved per week, from 212 holds, with the method shown. It notes that deploys wait for the S26 by name, so another phone helps them only by drawing agents off the S26. Jarad buys the phone and registers it as in UJ-3.
  - **Edge case:** with only 18 holds in the window, the panel shows the measured waits and a replayed range at one more phone, flagged "low data", and no modelled point number.

## 3. Glossary

- **Resource** — one thing Claimants hold exclusively. v1 kinds: `android-phone`; `ios-lane` (the Mac's iOS build and install lane, which includes the iPad); `emulator` (one slot of the emulator Pool). A Resource has a stable id, a name, a host, a lock name, Capabilities and a Reachability.
- **Lock name** — the on-disk name of a Resource's lock (`adb` for the S26, `s24`, `mac-ios`, `emulator-N`). It is how pinned hub versions see the Resource.
- **Deploy target** — the Resource a platform's deploys install to: the S26 for Android and the `ios-lane` for iOS. It is pinned in the committed `tools/ci/devices.json` and changes only by hub release, like everything else that decides what a device receives.
- **Capability** — a declared property a Claimant can ask for: platform, model, OS/API level, profile (for emulators), dedicated-QA.
- **Dedicated-QA** — a phone named in the private `~/.config/mobile-deploy-hub/qa-devices.json`. It is served only to a request that names it or asks for the dedicated-QA Capability.
- **Registry** — the hub's authoritative list of Resources, Pools and Host Agents.
- **Pool** — a named set of interchangeable Resources, for example "any Android phone" or the emulator Pool. A Resource can be in several Pools.
- **Claimant** — whoever asks for a Resource. There are four kinds: a deploy run (its jobs), a hub job (the catch-up and the hub's own maintenance), an agent, or a person.
- **Hold** — one Claimant's exclusive possession of a Resource. It has a start, an expected end and an expiry. There are two kinds:
  - a **Job Hold**, taken by a deploy job or a hub job for one section of its work and tied to its process;
  - a **Lease**, taken by an agent or a person for a stated duration.
- **Peek** — a short, read-only device query (for example the installed version of one package) that a deploy's plan job may make while a Lease, but not a Job Hold, holds the Resource. It installs, connects and changes nothing.
- **Queue** — the first-come-first-served line of waiting Claimants for one Resource. A Pool request waits in the Queue of every member at once and takes the first that serves it.
- **Reservation** — a deploy run's place in a Queue, taken at the start of the run and kept with no process behind it until the run's last Job Hold on that Resource. Every other waiting Claimant is a **queued request**, tied to its process.
- **Grace period** — how long a free Resource waits, once, for a Reservation at the head of its Queue whose run is not yet ready.
- **Reachability** — whether a Resource can be used right now: `reachable`, `unauthorized`, `offline`, `absent` or `unknown`. "Away" in CLI messages (`HUB_DEVICE_AWAY`) means `offline` or `absent`.
- **ETA** — the estimated time until a queued Claimant receives its Hold, given as a range.
- **Low data** — fewer than 20 past holds behind an ETA or a Capacity Estimate. One threshold for both.
- **Event Log** — the append-only history of every request, acquire, release, extend, timeout, cancel, claim, expiry, reclaim and force-release, plus Registry changes and Reachability changes.
- **Capacity Estimate** — for a Pool or a Resource, the mean wait at its current size and at one more Resource, from the Event Log.
- **Hub API** — the hub's HTTP service, written in Node, through which the Registry, Holds, Queues and the Event Log are read and changed.
- **Host Agent** — the hub process on a host that owns that host's locks and reports its devices to the Hub API. big-chungus's is part of the Hub API; the Mac's is a long-lived service on `hub-mac`.
- **Pin** — the hub version a deploy run executes (`actions/hub@vX.Y.Z`, fixed when the run starts and kept by its reruns). "The new pin" means the first release with the queueing in §4.2, or later.
- **Control Surface** — the Holocene page for the Registry. This PRD calls it nothing else.
- **hub-device** — the existing CLI (`tools/device/hub-device.mjs`) for leasing, releasing and status.

## 4. Features

### 4.1 Registry

**Description:** Every Resource is declared in the Registry, and registering one is a runtime action, not a hub release. Today's `tools/ci/devices.json` stays the source for the deploy targets and the hub's own hosts. The Registry imports those entries at every start and keeps them in step; everything else (extra phones, QA phones, emulator profiles) is registered at run time. The emulator Pool's profiles (`default`, `playstore`) become Registry entries; its size keeps today's precedence (`$HUB_EMULATOR_POOL`, then `<lockDir>/emulator-pool`), with the Registry value below both. Discovery lists devices on a host's adb server that are not registered yet. Realizes UJ-2 and UJ-3.

`[ASSUMPTION: Jarad delegated the storage call. The Registry is owned by the Hub API and persisted as a file store in the lock dir on big-chungus, beside the locks it governs. devices.json seeds and re-syncs the deploy targets; the private qa-devices.json is imported as the dedicated-QA Capability on the phones it names.]`

#### FR-1: Register a Resource

Jarad, or an agent through the Hub API, can register a Resource with a kind, name, host, identity (serial or UDID for devices; profile for emulators) and Capabilities. Realizes UJ-3.

**Consequences (testable):**
- A registered Resource can be held within 60 seconds of registration, with no hub release. This holds once one `hosts:install` has shipped a Registry-reading `hub-device`.
- Registering a duplicate identity (same serial or UDID) is refused with the existing Resource's id.
- A name or lock name that collides with a CLI word or a lock name in use (`phone`, `emulator`, `adb`, `s24`, `s26`, `ipad`, `mac`, `mac-ios`, `emulator-N`, `emulator-reaper`, `s3-*`) or with an existing Resource is refused. Seeded Resources keep their existing lock names and are exempt.

#### FR-2: Edit and retire a Resource

Jarad can edit a registered Resource's name and Capabilities, and retire it.

**Consequences (testable):**
- Retiring a Resource while it is held does not end the Hold. The Resource stops taking new Holds, from the Hub API and from `hub-device` alike, and leaves the Registry when the Hold ends.
- A retired Resource stays in the Event Log and in the Registry file as retired, so it never comes back on a re-seed.
- A Resource imported from `devices.json` cannot be retired or have its identity edited from the Registry; that is a hub release.
- Registry writes are unavailable while the Hub API is down, and say so; Holds still work (FR-13).

#### FR-3: Seed and re-sync from the committed declarations

At every start the Registry imports every Resource in `tools/ci/devices.json`, keeping their existing lock names (`adb` for the S26, `s24`, `mac-ios`), and marks the deploy targets. On first start it also imports the dedicated-QA phones in `~/.config/mobile-deploy-hub/qa-devices.json`.

**Consequences (testable):**
- After the import, existing `hub-device lease s24|s26|phone|emulator` invocations behave exactly as before.
- A hub release that changes `devices.json` is reflected in the Registry at the next start.
- The private QA file's contents are never written into any committed file. The Control Surface shows a QA phone's name and Capabilities, not its serial or allowed users.

#### FR-4: Discover unregistered devices

The Registry lists Android devices visible to a host's adb server that are not registered, with model and serial. Realizes UJ-3.

**Consequences (testable):**
- Discovery uses the same read-only adb query `hub-device status` uses. It never starts an adb server or connects anything, and reports "no adb server" rather than starting one.
- A device listed only by `host:port` has its serial read with a read-only device query.

#### FR-5: Report Reachability

For each Resource the Registry reports its Reachability and when it was last checked.

**Consequences (testable):**
- An unknown Reachability is shown as `unknown`, never as `reachable`.
- A status read serves the last reading with its age. A reading older than 60 seconds is refreshed when someone asks for it, and is never presented as current. `[ASSUMPTION: 60 s]`
- Phone Reachability uses status's read-only matching, never the deploy's `findPhone`, which starts the adb server and connects.
- The `ios-lane` is reported by the Mac's Host Agent. When the Mac is unreachable it reads `offline`.

#### FR-6: Find a Resource by Capability

A Claimant can ask for "any Resource matching these Capabilities", such as an Android phone at API level 34 or higher, or the playstore emulator profile. It gets one that is free and reachable, or waits in the Queue of every matching Resource and takes the first that serves it. Realizes UJ-2.

**Consequences (testable):**
- A request matching no registered Resource fails at once with the reason, and never waits.
- A request whose every match is `offline` or `absent` fails at once with `HUB_DEVICE_AWAY` (exit 75).
- The `phone` word becomes a Pool request: when several phones are free it still prefers the S24, and when none is, it now holds a place in line. It keeps its exit codes and messages.
- A dedicated-QA phone is served only to a request that names it or asks for the dedicated-QA Capability.

#### FR-29: Deploy targets are visible

`hub-device status --json`, the Hub API and the Control Surface mark the deploy targets, with their Reachability, their current Hold and their Queue, so any agent can tell which phone deploys install to and whether it is free. Realizes UJ-1.

**Consequences (testable):**
- The deploy targets come from the committed `devices.json`. The Registry shows them and cannot change them.

### 4.2 Holds, Queues and Reservations

**Description:** One first-come-first-served Queue per Resource serves every Claimant kind. Deploy jobs and hub jobs join it like Leases do instead of retrying `mkdir`. A deploy run takes a Reservation when it starts and uses it for every Job Hold it takes on that Resource, so the build no longer loses its place. A deploy that cannot get its device within its wait budget marks the delivery pending and leaves it to the catch-up, instead of failing. v1 Holds and queued requests are tied to a local process or to a stated expiry; waiting in line without a local process (remote waiting with Heartbeats) is v2. Realizes UJ-1 and UJ-2.

#### FR-7: First come, first served for every Claimant

Every Claimant kind waits in the same Queue and is served strictly in arrival order. There are no priority classes in v1. Realizes UJ-1.

**Consequences (testable):**
- Among Claimants on the new pin, a deploy job that starts waiting before a Lease request gets the Resource first, and a Lease that starts waiting first is served first.
- A free Resource with an empty Queue is taken at once.
- The catch-up waits in the Queue as a hub job. Its short attempt (a few seconds) is recorded as a hub-job request, never as a deploy or as a starved Claimant.

#### FR-8: Deploy jobs stand in the Queue

A deploy job waiting for a Resource holds a place in its Queue and appears in every status view, with its repo, run and job.

**Consequences (testable):**
- `hub-device status --json`, the Hub API and the Control Surface all list a waiting deploy job with its position. Text status shows its repo, run and job, never `undefined`.
- A deploy job on the new pin never loses its place to a Claimant that arrived after it. Only runs pinned to older versions can still overtake it (NFR-2).
- A deploy job's wait ends at least 2 minutes before its own job timeout, measured from the job's start, so a timed-out wait always reports its own reason and the Holds ahead of it instead of being killed by GitHub. `[ASSUMPTION: 2-minute margin]`
- The timeout message keeps today's `host lock <name> is held` wording, which the catch-up parses.
- Queueing covers the locks of Registry Resources only. The hub's internal locks (`s3-*`, `s3-index`, `emulator-reaper`) keep today's behaviour and write nothing to the Event Log.

#### FR-9: Reservation across a deploy run's jobs

A deploy run takes a Reservation on each deploy target it will install to when it starts: the S26's in the gate job, the `ios-lane`'s in the Mac's `preflight-ios` job. Every Job Hold the run later takes on that Resource goes through its Reservation. Realizes UJ-1.

**Consequences (testable):**
- The plan job reads the S26's installed version with a Peek, without waiting behind a Lease and without waiting behind its own Reservation. It still waits for a Job Hold held by another deploy.
- A Job Hold of the same run (recognised by its GitHub run id, which reruns keep) never waits behind the run's own Reservation. The iOS job's two takes of the `ios-lane` both use it.
- While the Reservation is at the head of the Queue and its run is not yet asking, a free Resource waits for it for the grace period, once. When the grace period ends, the next Claimant is served. The Reservation keeps its arrival place, the Resource never idles for it again, and its run's next request is served at that place. `[ASSUMPTION: grace = 10 minutes, stored in the Reservation record]`
- A Reservation ends when the run's last Job Hold on the Resource ends, when the run's final job (which runs even on failure or cancel) releases it, or 3 hours after it was taken if nothing else ended it. `[ASSUMPTION: 3-hour ceiling, longer than the slowest iOS job]`
- A rerun of a failed job reuses the run's Reservation while it is live. Once it has ended, the rerun queues as a new arrival.

`[NOTE FOR PM]` The grace period buys fairness with idle time: a reserved Resource can sit free for up to 10 minutes once per run. SM-C4 watches the cost. Shorten the grace period if it dominates idle time.

#### FR-30: A blocked delivery goes pending, not red

When a deploy job's wait budget runs out because the Resource is held, its delivery to that Resource is marked pending, exactly as for an away device, and the catch-up installs it when the Resource frees. Realizes UJ-1.

**Consequences (testable):**
- The run is green for that platform, with the delivery pending and the blocking Holds named in its summary and in the Event Log.
- The catch-up installs a pending build once the Resource frees, in its turn in the Queue, as it does today for a device that comes back.
- If the installed version on the device has moved above the planned one since the Peek (for example, an agent installed a higher dev build), the delivery is refused as today, the version is not reused, and the refusal names who installed it if the Event Log knows.

#### FR-10: Leases with expiry and extension

An agent or a person can take a Lease for a stated duration (up to 48 hours, as today), extend it, and release it.

**Consequences (testable):**
- A Lease tied to a process is reclaimed when the process is gone, as today.
- A Lease taken through the Hub API (from the Control Surface or an agent's API call) has no process; it lasts until its expiry or its release.
- An extension past 48 hours from the original start is refused.
- An extension or renewal at or after the Lease's expiry is refused, so a late renewal never overwrites the next holder's record.

#### FR-31: No extension while others wait

A Lease cannot be extended while another Claimant waits for its Resource. Realizes UJ-1.

**Consequences (testable):**
- The refusal names the waiters and their positions.
- Jarad can override it from the Control Surface; the override is recorded with who and why in the Event Log.
- A Lease on a deploy target is limited to 60 minutes. `[ASSUMPTION: 60 minutes]` Long holds belong on the S24 or an emulator, as today's guidance already says.

#### FR-11: Cancel and force-release

A Claimant can cancel its own Reservation or queued request. Jarad can force-release any Lease or Reservation from the Control Surface.

**Consequences (testable):**
- Force-release asks for confirmation and records who and why in the Event Log.
- A Job Hold cannot be force-released from the Control Surface. Ending it means cancelling the run, and the Control Surface links to the run.

#### FR-12: The iPad and the Mac as one Resource

The Mac's iOS lane and the iPad are one Resource, `ios-lane`, with its lock `mac-ios` on the Mac's disk, served by the Mac's Host Agent. Realizes UJ-1.

**Consequences (testable):**
- `hub-device lease ipad` and `hub-device lease mac` both take a Lease on the `ios-lane`. Either excludes iOS deploys and the iPad catch-up, as today's `mac-ios` does.
- A deploy run's iOS jobs and the iPad catch-up wait in the same first-come-first-served Queue, replacing today's unordered `mac-ios` retry. This needs only the queue-joining lock code running on the Mac.
- Every timestamp in the `ios-lane`'s Queue comes from the Mac's clock, because every Claimant of it writes on the Mac.
- When the Mac is unreachable, the `ios-lane` reports `offline` and Lease requests for it fail at once with `HUB_DEVICE_AWAY`.

#### FR-13: CLI compatibility

`hub-device` keeps its commands, exit codes (75 away, 76 busy), `HUB_DEVICE_*` lines and `--json` shapes, and works when the Hub API is down for every Resource local to big-chungus.

**Consequences (testable):**
- The existing `tools/device/*.test.mjs` suites pass, except for assertions this PRD changes on purpose, each named in the change that changes it: the `phone` ordering when none is free (FR-6), the `HUB_LOCK_WAIT` line (FR-16), and new `--json` fields, which are additions only.
- With the Hub API stopped, `hub-device lease s24` still works, and the Lease shows in the Hub API when it comes back.
- `hub-device status` stays read-only: it writes nothing to the lock dir or the Event Log.

### 4.3 Visibility and ETA

**Description:** Anyone can see, for every Resource and Pool, who holds it, until when, and who is waiting in what order, including deploy jobs. Each waiter gets an ETA as a range, and the ETA is honest about how little data there is. Realizes UJ-1 and UJ-2.

#### FR-14: Live status

The Hub API returns, and streams as changes, every Resource's Reachability, current Hold (Claimant, kind, why, since, expected end, expiry) and Queue (position, Claimant, since, Reservation or queued request).

**Consequences (testable):**
- A change written on a host with a Host Agent (acquire, release, enqueue, cancel, Reachability) reaches stream subscribers within 2 seconds, whichever process made it.
- States that pass with time (expired, grace ended) are computed from timestamps by every reader, so they never wait for an event.
- The stream sends a keepalive at least every 30 seconds. It is part of the connection, not recurring work.

#### FR-15: ETA for a waiter

Every queued Claimant gets an ETA, built from the expected remaining time of the Holds ahead of it and the expected hold time of each Claimant ahead of it, across the Resources it is waiting on. Realizes UJ-1 and UJ-2.

**Consequences (testable):**
- The ETA is a range: the 25th to 75th percentile of the matching past holds, combined along the line. `[ASSUMPTION: interquartile range]`
- A Job Hold's expected length comes from past holds of the same repo and job.
- A Lease's expected end is its start plus the median share of their stated duration that past Leases of the same Claimant kind used, never later than its expiry.
- With low data, the range widens to the stated durations or job timeouts and is flagged "low data".
- The ETA given at enqueue is recorded in the Event Log, so SM-4 can be measured.

#### FR-16: ETA where Claimants already look

A waiting deploy job prints its position and ETA in its job log, and `hub-device lease --wait` prints them on stderr. Realizes UJ-1.

**Consequences (testable):**
- The line keeps today's prefix and adds the new fields: `HUB_LOCK_WAIT <lock name> held by <holder> position=<n> eta=<range>`.
- It is printed when the position changes or the ETA moves by more than a minute, not on every poll.

### 4.4 Event Log and Capacity Estimate

**Description:** Every Hold and Reservation transition is appended once to the Event Log on the host that owns the lock. It carries no secrets and is the single source for ETAs, history and the Capacity Estimate. The Event Log ships before anything else, so history builds up while the rest is built. Realizes UJ-4.

#### FR-17: Record every transition once

The hub appends one event for each request, acquire, release, extend, timeout, cancel, claim, expiry, reclaim and force-release, for Leases, Job Holds and Reservations, and for each Registry change and Reachability change. Each event records the Resource, the Claimant (kind, holder, repo, run, job), the hub version that wrote it, the times, `waited_ms`, `held_ms`, the ETA at enqueue where there is one, and the reason.

**Consequences (testable):**
- A full deploy run, a Lease, an emulator Lease, a pending delivery and a timed-out wait each produce exactly the expected event sequence in tests.
- Writing the Event Log never makes an acquire or release fail. A write error is logged and the transition still happens.
- A Hold reclaimed after its holder died records when the holder was last known alive, so `held_ms` is not inflated by however long nobody looked.

#### FR-18: Query history

The Hub API returns the Event Log, from both hosts, filtered by Resource, Pool, Claimant, repo and time range, and per-Resource utilisation (the share of the window each Resource was held, idle while reserved, idle, and away) for a window.

**Consequences (testable):**
- Every event since the Event Log shipped stays queryable. v1 does not compact or delete it. `[ASSUMPTION: no retention limit in v1; revisit when the log passes 100 MB]`
- History from the Mac is marked partial for any time the Mac was unreachable.

#### FR-19: Capacity Estimate

For any Pool, or single Resource, the hub reports over a chosen window:
- the arrival rate, the mean and variance of hold time, and the measured mean and p95 wait;
- the mean wait with one more Resource, as a range, and the waiting it would save per week in hours;
- how much of the demand names a single Resource (deploys on their target, requests by name) and so cannot move to a new one.

Realizes UJ-4.

**Consequences (testable):**
- The estimate always reports its sample size, window, utilisation and method.
- With low data, it shows no modelled point number and gives the one-more-Resource wait as a range from replaying the logged arrivals and holds.
- Hub-job attempts, the internal locks and long administrative holds (for example `--no-connect` holds) are excluded and listed separately.

#### FR-20: Starvation signal

The hub flags any Claimant that waited longer than 15 minutes, and any deploy delivery that went pending because of a Hold, and shows it on the Control Surface. `[ASSUMPTION: 15 minutes]`

**Consequences (testable):**
- A pending-by-contention delivery appears on the Control Surface within 2 seconds, with the Holds that blocked it.

### 4.5 Hub API

**Description:** The Hub API is a Node 24 ESM service with no runtime framework, always on as a user service. It runs on big-chungus as the deploy runner's user, with the runner's lock dir, because the lock code treats queue tickets from other hosts, and holders whose process it cannot check, as stale. It is the only writer of the Registry, and it wraps the existing `lock.mjs` and `emulator.mjs` functions, so there is one lock and queue implementation. It reaches the Mac's locks through the Mac's Host Agent. Its contract is a versioned markdown document that Holocene codes against, following the Candybar pattern.

#### FR-21: Endpoints

The Hub API exposes:
- health (`GET /health` → `{ok, service}`);
- Registry read and write (FR-1 to FR-6, FR-29);
- Hold, Queue and Reservation actions (FR-7 to FR-12, FR-31);
- live status and stream (FR-14);
- ETA (FR-15), history (FR-18) and Capacity Estimate (FR-19).

**Consequences (testable):**
- Every write returns the resulting state, or a refusal with a machine-readable reason and the matching CLI exit code (75, 76 or 2).
- The contract document lives in the hub repo and is versioned, and a contract test checks the API's responses against it.

#### FR-22: Same semantics as the CLI

Every action through the Hub API has the same effect as the same action through `hub-device`, because both call the same library functions.

**Consequences (testable):**
- A Lease taken through the Hub API excludes a deploy job's Job Hold, and the other way round, as today.
- The same request through the CLI and through the API produces the same Hold, the same refusal reasons and the same events.

#### FR-23: Survive restarts

Restarting the Hub API loses no Hold, Reservation or Registry entry.

**Consequences (testable):**
- Holds and Reservations live in the lock dir, not in the API process, so they survive a restart of any length.
- A request waiting in line through the API is tied to the API's process. A restart drops it, and the caller gets a clear "re-queue" error instead of waiting forever. Keeping such places across restarts comes with remote waiting in v2.
- Emulators the API started keep running across its restart.
- Only one Hub API runs at a time; a second one refuses to start.

### 4.6 Control Surface (Holocene page)

**Description:** The Control Surface is a Holocene page under the "System" navigation group, built like the Candybar page. Holocene's own API calls the Hub API server-side and relays its stream; the browser never calls the Hub API. It shows Resources, Holds, Queues, ETAs, history and Capacity Estimates, and lets Jarad register, edit, retire, lease, release, cancel, override and force-release. This work lands in the Holocene repo (`~/code/33GOD/holocene`) against the Hub API contract. Realizes UJ-3 and UJ-4.

#### FR-24: Resource board

The Control Surface shows every Resource and Pool with its Reachability, current Hold (Claimant, why, since, expected end) and Queue (position, Claimant, ETA), updating live, and marks the deploy targets.

**Consequences (testable):**
- The board updates within 2 seconds of a change.
- When the Hub API is unreachable, the board says so, shows the time of the last good data, and offers no write actions.
- Mac data is marked stale while the Mac is unreachable.

#### FR-25: Register and edit from the Control Surface

Jarad can register a discovered device, register one by hand, edit it and retire it. Realizes UJ-3.

**Consequences (testable):**
- Registering from the Control Surface produces the same Registry entry as FR-1 through the Hub API, and the Resource appears on the board within 2 seconds.
- Every FR-1 and FR-2 refusal is shown with its reason, and the form keeps what Jarad typed.

#### FR-26: Act on Holds

Jarad can lease a Resource for himself, release his own Leases, cancel Reservations, override FR-31, and force-release with confirmation (FR-11).

**Consequences (testable):**
- A Lease taken from the Control Surface is bound to its expiry, like a CLI `--no-connect` Lease, and survives closing the tab. It shows as Jarad's on `hub-device status`.
- Each action shows its result or its refusal, and the board reflects it within 2 seconds.

#### FR-27: History and capacity panel

The Control Surface shows per-Resource utilisation and wait history over a chosen window, and the Capacity Estimate for each Pool. Realizes UJ-4.

**Consequences (testable):**
- The window can be set to 1, 7, 14 or 30 days. `[ASSUMPTION]`
- The panel shows every FR-19 figure with its sample size, method and "low data" flag, and never hides the flag.

#### FR-28: Starvation and away alerts on the Control Surface

The Control Surface surfaces FR-20 starvation signals and Resources that have been `offline` or `absent` too long.

**Consequences (testable):**
- A Resource whose last readings have been `offline` or `absent` for more than 30 minutes is flagged; after 14 days `absent` the Control Surface suggests retiring it. `[ASSUMPTION: 30 minutes and 14 days]`

## 5. Cross-Cutting NFRs

- **NFR-1 One implementation.** There is exactly one lock, queue and Reservation implementation in the hub's source, in its lock library. The Hub API, Host Agents, `hub-device`, deploy jobs and the catch-up all call it, and no second store of Holds exists. At run time several released versions of it act on one lock dir at once (NFR-2), so the on-disk layout is the real contract: it carries a format version and has written compatibility rules.
- **NFR-2 Backward compatibility with pinned runs.**
  - Pinned hub versions up to v1.2.42 still take bare locks, and v1.2.25 and earlier reclaim Leases as dead jobs. The on-disk layout stays readable by them; new files sit beside the old ones, which old readers ignore.
  - A Reservation is never written as a lock owner, because every older version reclaims an owner with no live process.
  - The ticket format freezes at the first release whose deploy jobs join the Queue, because every later rerun of that pin prunes by its rules. That release therefore ships the full ticket format, including a ticket kind with its own expiry for v2's remote waiting, even though v1 writes none.
  - The catch-up and the Mac's catch-up switch to the new code at the first real deploy on the new pin, because a real deploy advances the installed hub; `hub-device`, the Hub API and the Mac's Host Agent switch at `hosts:install`.
  - The release that brings the new semantics states that fairness holds only among runs on the new pin. Reruns of older pins age out within GitHub's 30-day rerun window.
- **NFR-3 No new clock.**
  - Expiry, reclaim and grace are evaluated when the hub is called, from timestamps. Nothing is reaped on a timer.
  - Host Agents and the Hub API are services: they react to file changes, device events and requests, and never poll or reap on a timer.
  - Anything recurring is a Candybar job.
- **NFR-4 Node only.** All new hub code is Node 24 ESM. The Hub API and Host Agents add no Python.
- **NFR-5 Hermetic tests.** Every new module is covered by tests under `tools/**/*.test.mjs` that run on a GitHub-hosted runner with no device, bucket or host state.
- **NFR-6 Reach and access.**
  - The Hub API listens on loopback on big-chungus. `[ASSUMPTION]`
  - Holocene reaches it server-side, and Holocene's Google sign-in at Traefik is the only gate for people.
  - Agents on big-chungus use the CLI or loopback. The Claimant names they give are recorded as given.
- **NFR-7 Latency.** A status read answers in under 200 ms on big-chungus from the last readings, and an uncontended acquire through the Hub API in under 1 s, not counting finding the phone or booting an emulator.
- **NFR-8 The Mac is a laptop.** The Mac's Host Agent sends only changes, never a periodic stream, and reconnects only when it has something to send. Every view treats the Mac's data as possibly stale.

## 6. Non-Goals (Explicit)

- Not a device farm or remote-screen tool, nothing like STF's browser control of devices. Claimants use the device through adb or devicectl themselves.
- Not a test orchestrator or CI scheduler. Deploy runs stay GitHub workflows; the hub only orders their access to Resources.
- No priority classes, preemption or fair-share weighting in v1. Pure first come, first served.
- The Registry does not decide what a device may receive or which device deploys install to. `policy.json` still pins packages, signers and bundle ids, and `devices.json` pins the deploy targets.
- No lock that spans hosts. Each lock lives on one host and is owned by that host's Host Agent.
- No standing per-app sign-up. A Reservation belongs to one run.
- No purchase automation. The Capacity Estimate informs Jarad and does not order hardware.

## 7. MVP Scope

### 7.1 In Scope (v1), in delivery order

Each slice is a hub release that ships on its own. The order follows `addendum.md` §B.10.

- **v1a, stop the starvation and start the history:**
  - Event Log (FR-17), so history accrues from the first release.
  - Deploy jobs and the catch-up in the Queue, Reservations, the Peek, pending instead of red, no extension while others wait (FR-7 to FR-9, FR-30, FR-31; the `ios-lane` Queue of FR-12).
  - Position and ETA in job logs and `hub-device status` (FR-15, FR-16).
  - CLI compatibility (FR-13).
  - The frozen ticket format (NFR-2).
- **v1b, the Registry and the Hub API:**
  - Registry, seeding, discovery, Reachability, Capability requests and visible deploy targets (FR-1 to FR-6, FR-29).
  - Leases through the API, cancel and force-release (FR-10, FR-11).
  - The Hub API and its contract (FR-14, FR-18, FR-21 to FR-23).
  - The Mac's Host Agent (the rest of FR-12).
- **v1c, the Control Surface and the numbers:**
  - Capacity Estimate and starvation signal (FR-19, FR-20).
  - The Holocene page (FR-24 to FR-28), in the Holocene repo.

The starvation fix depends only on v1a.

### 7.2 Out of Scope for v1

- Priority or fair-share policies. Revisit if the Event Log shows first-come-first-served starving something.
- Deploys choosing among several free devices, or a deploy target set from the Registry at run time. Deploy targets stay pinned in `devices.json`. Revisit when Jarad wants two deploy phones; it touches delivery, receipts, catch-up and completion, and the hub's rule that what a device receives is a hub release.
- Remote waiting: a place in line held without a local process, kept alive by Heartbeats, with jeopardy and quarantine states. v1 waits are process-bound; v1 API Leases are expiry-bound. The v1a ticket format already allows it. Revisit when an agent off big-chungus needs to wait in line.
- Fencing tokens checked at install and readback. Every v1 install comes from a local job whose Hold is tied to its process, and adb and devicectl cannot check a token. Revisit with remote waiting.
- The iPad and the Mac's build lane as separate Resources. That needs a fixed lock order or an all-or-nothing acquire. Revisit when an iPad Lease blocking Mac builds becomes a real cost.
- Bloodbank events for Holds. The Control Surface uses the Hub API's stream in v1. Revisit when another 33GOD component needs Hold events.
- Access to the Control Surface from a phone. Holocene already serves `/hq` to phones outside Google sign-in; revisit if Jarad wants the board there.
- Event Log compaction. Revisit when the log passes 100 MB.

## 8. Success Metrics

The baseline is the deploy history in GitHub's run logs for the 30 days before v1a, and the first 14 days of Event Log data from v1a on.

**Primary**
- **SM-1:** Deliveries lost to contention: deploy runs on the new pin whose delivery to a Resource never happened, or happened only after a Claimant that arrived later was served first. Target: 0. Deliveries that went pending behind a legitimately earlier Hold and were installed by the catch-up are reported separately, with how long they took. Validates FR-7, FR-8, FR-9, FR-12 and FR-30.
- **SM-2:** Deploy wait. Target: p95 deploy-job wait on the new pin at or below the baseline p95, with every waiting Claimant on the new pin listed with position and ETA in status, the Hub API and the Control Surface. Validates FR-8, FR-14 and FR-15.
- **SM-3:** Time to register a Resource. Target: under 1 minute from a device appearing in discovery to its first Lease, with no hub release. Validates FR-1, FR-4 and FR-25.

**Secondary**
- **SM-4:** ETA accuracy. Target: after 14 days of history, the actual wait falls inside the ETA range given at enqueue for at least half of waits over 2 minutes. Validates FR-15.
- **SM-5:** Capacity Estimate credibility, checked whenever a Resource is added: the measured mean wait over the next 14 days falls inside the estimate's stated range. Validates FR-19.

**Counter-metrics (do not optimize)**
- **SM-C1:** Utilisation. A Pool near 100% busy means waits are exploding, not that it is efficient. Counterbalances SM-1 and SM-5.
- **SM-C2:** Lease length. Do not push Claimants to shorter Leases just to lower ETAs. Releasing early is good; cutting real work short is not. Counterbalances SM-4.
- **SM-C3:** "Low data" flags. Never hide them to make the estimate look confident. Counterbalances SM-4 and SM-5.
- **SM-C4:** Idle while reserved. The share of time a Resource sat free waiting for a Reservation. Fairness should not cost more than the starvation it prevents. Counterbalances SM-1.
- **SM-C5:** Pending deliveries. Turning a wait into "pending" must not become the way deploys stop installing. Track how many go pending and how long the catch-up takes to install them. Counterbalances SM-1.

## 9. Open Questions

None block architecture. The decisions taken in place of the earlier questions are in `.memlog.md`; the ones Jarad has not confirmed are listed there as needing him.

## 10. Assumptions Index

- §4.1: the Registry is a file store in the lock dir on big-chungus, owned by the Hub API, seeded and re-synced from `devices.json` and seeded from `qa-devices.json` (Jarad delegated this call).
- FR-5: a Reachability reading older than 60 s is refreshed on request and shown with its age.
- FR-8: a deploy job's wait ends 2 minutes before its own job timeout.
- FR-9: the grace period is 10 minutes, stored in the Reservation; a Reservation ends at most 3 hours after it was taken.
- FR-15: the ETA range is the interquartile range of matching past holds.
- FR-18: no Event Log retention limit in v1.
- FR-20: the starvation threshold is 15 minutes.
- FR-27: history windows of 1, 7, 14 and 30 days.
- FR-28: away flagged after 30 minutes, retirement suggested after 14 days absent.
- FR-31: a Lease on a deploy target lasts at most 60 minutes.
- NFR-6: the Hub API listens on loopback only; people reach it only through Holocene.
