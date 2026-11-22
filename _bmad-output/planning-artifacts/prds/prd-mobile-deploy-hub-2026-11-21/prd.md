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
- Jarad's answers of 2026-11-21, recorded in `.memlog.md`.

Terms come from the Glossary (§3) and are used exactly. Features are grouped, with globally numbered FRs nested under them. FR numbers are stable: a new FR takes the next free number even when it sits in an earlier section. Inferences are tagged `[ASSUMPTION]` and indexed in §10. Mechanism, transport and the queueing math live in `addendum.md`.

## 1. Vision

The hub's device leasing works, and Jarad wants to keep it and grow it. Today it knows two phones by name, a small emulator pool, and an iPad and a Mac it cannot lease. Deploy runs do not stand in line: they keep retrying the lock, so queued leases win every handoff, and a deploy can wait out its 20-minute limit and fail after its version was already bumped. Nobody can see that the deploy is waiting, how long it will wait, or whether one more phone would have prevented it. Agents cannot tell which phone deploys install to, or whether it is free.

The Hub Resource Registry makes every contended thing a **Resource**: phones, the iPad, emulator slots and the Mac. Each one is registered once, and registering needs no hub release. The Registry, not a committed file, says which phone and which iPad deploys install to. Every **Claimant** stands in the same first-come-first-served **Queue**: a deploy run, an agent or Jarad. A deploy run takes a **Reservation** at plan time, before its version is bumped, and keeps its place through the build. Every waiter sees its position and an **ETA**. An append-only **Event Log** records every request, hold and release. From that history the hub answers "how much waiting would one more device save?" with a **Capacity Estimate** instead of a guess.

It is driven through a **Hub API** written in Node, which wraps the existing lock code rather than replacing it. Resources on another host are served by a **Host Agent** on that host; v1 runs one on the Mac. It is managed from a **Control Surface**: its own page in Holocene, the canonical control surface. The hub keeps authority over Holds and Queues. Holocene shows them and forwards Jarad's actions.

## 2. Target User

### 2.1 Jobs To Be Done

- **A deploy run** (including the catch-up, which re-delivers a release to a device that was away): wait its turn for the deploy phone, the iPad or the Mac without being shut out by a stream of Leases. It must keep its place across the gap between its plan job and its install job.
- **An agent:** find out which phones and emulators exist, which are reachable, which are free and which one deploys install to, and take one that fits. If none is free, join the line and learn how long the wait is, instead of guessing from `devices.json` or retrying.
- **Jarad:**
  - register a new phone or emulator profile in a minute and have every app use it, with no hub release;
  - see who holds what and who is waiting, from the Holocene page in any browser where he is signed in;
  - cancel or release a stuck Hold;
  - decide with numbers whether another device is worth adding.

### 2.2 Non-Users (v1)

- Anyone but Jarad's own apps, agents and deploy runs. This is not a device farm for other people.
- Resources on hosts without a Host Agent. v1 ships Host Agents on big-chungus (built into the Hub API) and on the hub's Mac (`hub-mac`). A third host joins by running a Host Agent and registering it, not by a redesign; no third host is planned for v1.

### 2.3 Key User Journeys

- **UJ-1. Tower's deploy run is not shut out.**
  - Jarad ships Tower while an agent holds the S26 on a 30-minute Lease and a Green In Between deploy is already waiting.
  - Tower's plan job takes a Reservation on the S26 before it bumps the version and lands at position 2, with an ETA of 20 to 30 minutes, which its job log prints.
  - The build runs, and the Reservation keeps Tower's place through it. When the S26 frees and Green In Between finishes, Tower's install job claims its Reservation and installs.
  - **Edge case:** the Lease holder extends by 15 minutes. Tower's ETA moves in the log and on the page, and its position does not change.
  - **Edge case:** Tower's build is still running when its Reservation reaches the head. The S26 waits free for the grace period, then goes to the next Claimant; Tower stays first in line and gets the S26 when that Claimant releases it.
- **UJ-2. An Earshot QA agent finds a phone.**
  - The agent asks the Hub API for any Android phone at API level 34 or higher and gets the S24.
  - When both phones are held, the agent joins the phone Pool's Queue at position 1 with an ETA of 5 to 10 minutes. It waits, gets the first phone that frees, and releases it when the run ends.
  - **Edge case:** the agent's process dies mid-wait. Its place is dropped within one Heartbeat lapse, so nobody waits behind a ghost.
- **UJ-3. Jarad registers a new phone from Holocene.**
  - Jarad plugs a Pixel into big-chungus, opens the Control Surface, and sees it listed as a discovered, unregistered device.
  - He registers it with a name, kind and Capabilities. He leaves it not deploy-eligible, because the S26 stays the deploy phone.
  - Within a minute an agent can lease it, and `hub-device status --json` shows it. No hub release or `hosts:install` was needed.
- **UJ-4. Jarad decides whether to buy another phone.**
  - The Control Surface's capacity panel shows the phone Pool over the last 14 days: requests per hour, mean hold time, measured mean wait, and the expected mean wait with one more phone.
  - The panel says 9 minutes now and about 1.5 minutes with one more, roughly 4 hours of waiting saved per week, from 212 holds, with the sample size and method shown. Jarad buys the phone and registers it as in UJ-3.
  - **Edge case:** with only 18 holds in the window, the panel shows the measured waits and a replayed range at one more phone, flagged "low data", and no modelled point number.

## 3. Glossary

- **Resource** — one thing Claimants hold exclusively. v1 kinds: `android-phone`, `ios-device` (the iPad), `emulator` (one slot of the emulator Pool) and `mac` (the Mac's iOS build/install lane). A Resource has a stable id, a name, a host, Capabilities, a Reachability and a deploy-eligible flag.
- **Capability** — a declared property a Claimant can ask for: platform, model, OS/API level, profile (for emulators), dedicated-QA, deploy-eligible.
- **Deploy-eligible** — the flag that makes a Resource the one deploys install to for its platform. In v1 at most one `android-phone` and one `ios-device` carry it.
- **Registry** — the hub's authoritative list of Resources, Pools and Host Agents.
- **Pool** — a named set of interchangeable Resources served by one Queue, for example "any Android phone" or the emulator Pool. A Resource can be in several Pools. Dedicated-QA phones are not in the default phone Pool.
- **Claimant** — whoever asks for a Resource. There are three kinds: a deploy run (its jobs, and the catch-up), an agent, or a person.
- **Hold** — one Claimant's exclusive possession of a Resource. It has a start, an expected end and an expiry. There are two kinds:
  - a **Job Hold**, taken by a deploy job for the job's length;
  - a **Lease**, taken by an agent or a person for a stated duration.
- **Queue** — the first-come-first-served line of waiting Claimants for one Resource or one Pool.
- **Reservation** — a deploy run's place in a Queue. It survives the gap between the run's plan job and its install job, and a restart of the Hub API. It ends when it is claimed, cancelled or expired.
- **Grace period** — how long a free Resource waits for an unclaimed Reservation at the head of its Queue before serving the next Claimant.
- **Heartbeat** — a periodic renewal by a remote Claimant that keeps its Lease or Reservation alive when it has no process on the host.
- **In jeopardy** — a Lease whose Heartbeat is late but has not yet lapsed.
- **Quarantine** — the short pause after a Heartbeat lapse before the Resource goes to the next Claimant.
- **Reachability** — whether a Resource can be used right now: `reachable`, `unauthorized`, `offline`, `absent` or `unknown`.
- **ETA** — the estimated time until a queued Claimant receives its Hold, given as a range.
- **Event Log** — the append-only history of every request, acquire, release, extend, timeout, cancel and reclaim, for every Hold and Reservation.
- **Capacity Estimate** — for a Pool, the mean wait at its current size and at one more Resource, from the Event Log.
- **Hub API** — the hub's HTTP service, written in Node, through which the Registry, Holds, Queues and the Event Log are read and changed.
- **Host Agent** — the hub process on a host that owns that host's locks and reports its devices to the Hub API. big-chungus's is part of the Hub API; the Mac's runs on `hub-mac`.
- **Control Surface** — the Holocene page for the Registry. This PRD calls it nothing else.
- **hub-device** — the existing CLI (`tools/device/hub-device.mjs`) for leasing, releasing and status.

## 4. Features

### 4.1 Registry

**Description:** Every Resource is declared in the Registry, and registering one is a runtime action, not a hub release. Today's `tools/ci/devices.json` becomes the seed: the S26, the S24, the iPad and the Mac are imported on first start. After that the Registry is the only source deploys and leases read for which device is which; `devices.json` is not read at run time except as the seed and as the fallback when the Registry is absent. The emulator Pool's profiles (`default`, `playstore`) and its size become Registry entries instead of code constants. Discovery lists devices on a host's adb server (and, later, the Mac's devicectl) that are not registered yet. Realizes UJ-2 and UJ-3.

`[ASSUMPTION: Jarad delegated the storage call. The Registry is owned by the Hub API and persisted as a file store in the lock dir on big-chungus, beside the locks it governs. devices.json seeds it; the private qa-devices.json is imported as the dedicated-QA Capability on the phones it names.]`

#### FR-1: Register a Resource

Jarad, or an agent through the Hub API, can register a Resource with a kind, name, host, identity (serial or UDID for devices; profile for emulators), Capabilities and a deploy-eligible flag. Realizes UJ-3.

**Consequences (testable):**
- A registered Resource can be held within 60 seconds of registration, with no hub release and no `hosts:install`.
- Registering a duplicate identity (same serial or UDID) is refused with the existing Resource's id.
- A name that collides with a reserved word (`phone`, `emulator`, `adb`) or an existing Resource is refused. Seeded Resources keep their existing lock names (FR-3) and are exempt.
- Marking a second Resource of the same platform deploy-eligible is refused in v1, with the current one's id.

#### FR-2: Edit and retire a Resource

Jarad can edit a Resource's name, Capabilities and deploy-eligible flag, and retire a Resource.

**Consequences (testable):**
- Retiring a Resource while it is held does not end the Hold. The Resource stops taking new Holds and leaves the Registry when the Hold ends.
- A retired Resource stays in the Event Log under its id.
- Moving the deploy-eligible flag takes effect for the next deploy run's plan job. A run already past its plan job keeps the device it reserved.

#### FR-3: Seed from the committed declarations

On first start the Registry imports every Resource in `tools/ci/devices.json` and the dedicated-QA phones in `~/.config/mobile-deploy-hub/qa-devices.json`, keeping their existing lock names (`adb` for the S26, `s24` and so on). The S26 and the iPad are imported deploy-eligible.

**Consequences (testable):**
- After the import, existing `hub-device lease s24|s26|phone|emulator` invocations behave exactly as before.
- The private QA file's contents are never written into any committed file.

#### FR-4: Discover unregistered devices

The Registry lists Android devices visible to a host's adb server that are not registered, with model and serial. Realizes UJ-3.

**Consequences (testable):**
- Discovery never starts an adb server or connects anything, and reports "no adb server" rather than starting one.

#### FR-5: Report Reachability

For each Resource the Registry reports its Reachability and when it was last checked.

**Consequences (testable):**
- An unknown Reachability is shown as `unknown`, never as `reachable`.
- A reading older than 60 seconds is shown with its age and is never presented as current. `[ASSUMPTION: 60 s]`
- The iPad and the Mac are reported through the Mac's Host Agent; when the Mac is away they read `offline`.

#### FR-6: Find a Resource by Capability

A Claimant can ask for "any Resource matching these Capabilities", such as an Android phone at API level 34 or higher, or the playstore emulator profile. It gets one that is free and reachable, or joins the matching Pool's Queue. Realizes UJ-2.

**Consequences (testable):**
- A Capability request matching no registered Resource fails at once with the reason, and never waits.
- The existing `phone` word becomes a request on the default phone Pool and keeps its CLI behaviour, now holding a place in line.
- A dedicated-QA phone is served only to a request that names it or asks for the dedicated-QA Capability.

#### FR-29: Deploys install to the deploy-eligible Resource

Every deploy step that today names the S26 or the iPad (plan, gate, install, readback, receipts, catch-up, completion) resolves its device from the Registry's deploy-eligible Resource for that platform. Realizes UJ-1.

**Consequences (testable):**
- `hub-device status --json` and the Control Surface mark which Resource deploys install to, and whether it is reachable and free.
- With the Registry absent, deploys resolve the same device from `devices.json`, as today.
- With no deploy-eligible Resource for a platform, that platform's delivery is pending, the same as an away device today, and the reason names the missing flag.

### 4.2 Holds, Queues and Reservations

**Description:** One first-come-first-served Queue per Resource and per Pool serves every Claimant kind. Deploy jobs and the catch-up join it like Leases do instead of retrying `mkdir`. A deploy run takes a Reservation in its plan job and claims it in its install job, so the build gap no longer loses its place. Remote Claimants (Holocene users, agents off the host) keep their place with Heartbeats. A local Claimant can still tie its Lease to a process, as it does today. Realizes UJ-1 and UJ-2.

#### FR-7: First come, first served for every Claimant

Every Claimant kind (deploy run, agent, person) waits in the same Queue and is served strictly in arrival order. There are no priority classes in v1. Realizes UJ-1.

**Consequences (testable):**
- A deploy job that starts waiting before a Lease request gets the Resource first.
- A Lease that starts waiting first is served first, even though the other Claimant is a deploy.
- A free Resource with an empty Queue is taken at once.
- The catch-up waits in the Queue like a deploy job and holds no place it is not using.

#### FR-8: Deploy jobs stand in the Queue

A deploy job waiting for a Resource holds a place in its Queue and appears in every status view, with its repo, run and job.

**Consequences (testable):**
- `hub-device status --json`, the Hub API and the Control Surface all list a waiting deploy job with its position.
- A deploy job on the new semantics never loses its place to a Claimant that arrived after it. The only Claimants that can still overtake it are runs pinned to hub versions without queueing (NFR-2).
- A deploy job's wait ends at least 2 minutes before its job timeout, so a timed-out wait always reports its own reason and the Holds ahead of it instead of being killed silently by GitHub. `[ASSUMPTION: 2-minute margin]` Today both limits are 20 minutes.

#### FR-9: Reservation across a deploy run's jobs

A deploy run's plan job takes a Reservation on the Resources it will install to, before it bumps the version, and its install job claims that Reservation. Realizes UJ-1.

**Consequences (testable):**
- The version is bumped only after the run's Reservations are taken. A run that cannot take one (the Resource is retired or not registered) stops before the bump; an away Resource is pending, as today.
- While the Reservation is unclaimed and at the head of the Queue, a free Resource is not handed to anyone behind it until the grace period ends. `[ASSUMPTION: grace = 10 minutes, policy-pinned]`
- When the grace period ends unclaimed, the next Claimant is served and the Reservation stays first in line. It is never pushed further back, and it gets the Resource when that Claimant releases it.
- A Reservation ends when it is claimed, when its run is cancelled or fails, or when it is still unclaimed 3 hours after it was taken. `[ASSUMPTION: 3-hour ceiling]`
- A rerun of a failed job reuses the run's Reservation if it is still live, and keeps its original place in the Queue.
- When a run would wait behind its own Hold or Reservation on the same Resource, it is detected and refused, never left to deadlock.

`[NOTE FOR PM]` The grace period buys fairness with idle time: a reserved Resource can sit free for up to 10 minutes. SM-C4 watches the cost. Shorten the grace period if it dominates idle time.

#### FR-10: Leases with expiry, extension and Heartbeat

An agent or a person can take a Lease for a stated duration (up to 48 hours, as today), extend it, and release it.

**Consequences (testable):**
- A Lease tied to a process is reclaimed when the process is gone, as today.
- A Lease or Reservation held through the Hub API without a local process is reclaimed when its Heartbeat lapses. `[ASSUMPTION: Heartbeat every 30 s, lapse after 90 s]`
- An extension past 48 hours from the original start is refused.
- A Lease in jeopardy shows so on every status view. After a lapse, the Resource goes to the next Claimant only after the quarantine, so a slow holder and a new one never overlap. `[ASSUMPTION: quarantine 15 s]`

#### FR-11: Cancel and force-release

A Claimant can cancel its own Reservation or queued request. Jarad can force-release any Lease or Reservation from the Control Surface.

**Consequences (testable):**
- Force-release asks for confirmation and records who and why in the Event Log.
- A deploy job's Job Hold cannot be force-released from the Control Surface. Ending it means cancelling the run, and the Control Surface links to the run.

#### FR-12: The iPad and the Mac as Resources

The iPad (`ios-device`) and the Mac (`mac`) are Resources with Queues, Reservations and Leases, served on the Mac's side by its Host Agent. Realizes UJ-1.

**Consequences (testable):**
- `hub-device lease ipad` and `hub-device lease mac` take a Lease through the Hub API.
- A deploy run's iOS jobs and the Mac catch-up wait in the same first-come-first-served Queue, replacing today's unordered `mac-ios` retry.
- When the Mac is away, its Resources report `offline` and Lease requests for them fail at once with `HUB_DEVICE_AWAY`. Reservations keep their place until they end under FR-9.

#### FR-13: CLI compatibility

`hub-device` keeps its commands, exit codes (75 away, 76 busy), `HUB_DEVICE_*` lines and `--json` shapes, and works when the Hub API is down for every Resource local to big-chungus.

**Consequences (testable):**
- The existing `tools/device/*.test.mjs` suites pass unchanged.
- With the Hub API stopped, `hub-device lease s24` still works, and the Lease shows in the Hub API when it comes back.

### 4.3 Visibility and ETA

**Description:** Anyone can see, for every Resource and Pool, who holds it, until when, and who is waiting in what order, including deploy jobs. Each waiter gets an ETA as a range, and the ETA is honest about how little data there is. Realizes UJ-1 and UJ-2.

#### FR-14: Live status

The Hub API returns, and streams as changes, every Resource's Reachability, current Hold (Claimant, kind, why, since, expected end, expiry, in jeopardy) and Queue (position, Claimant, since).

**Consequences (testable):**
- A change (acquire, release, enqueue, cancel, Reachability) reaches stream subscribers within 2 seconds.
- The stream sends a keepalive at least every 30 seconds.

#### FR-15: ETA for a waiter

Every queued Claimant gets an ETA, built from the current holder's expected remaining time and the expected hold time of each Claimant ahead of it. Realizes UJ-1 and UJ-2.

**Consequences (testable):**
- The ETA is a range: the 25th to 75th percentile of the matching past holds, summed along the line. `[ASSUMPTION: interquartile range]`
- A Job Hold's expected length comes from past holds of the same repo and job.
- A Lease's expected end is its start plus the median share of their stated duration that past Leases of the same Claimant kind used, never later than its expiry.
- With fewer than 5 past holds of a type, the range is widened to the stated duration or job timeout and flagged "low data".

#### FR-16: ETA where Claimants already look

A waiting deploy job prints its position and ETA in its job log whenever either changes, and `hub-device lease --wait` prints them on stderr. Realizes UJ-1.

**Consequences (testable):**
- The log line has a stable, greppable shape (`HUB_LOCK_WAIT <resource> position=<n> eta=<range>`).

### 4.4 Event Log and Capacity Estimate

**Description:** Every Hold and Reservation transition is appended once to the Event Log on the host that owns the lock. It carries no secrets and is the single source for ETAs, history and the Capacity Estimate. The Event Log ships before anything else, so history builds up while the rest is built. Realizes UJ-4.

#### FR-17: Record every transition once

The hub appends one event for each request, acquire, release, extend, timeout, cancel and reclaim, for Leases, Job Holds and Reservations. Each event records the Resource, the Claimant (kind, holder, repo/run/job), the times, `waited_ms` and `held_ms`, and the reason.

**Consequences (testable):**
- A full deploy run, a Lease, an emulator Lease and a timed-out wait each produce exactly the expected event sequence in tests.
- Writing the Event Log never makes an acquire or release fail. A write error is logged and the transition still happens.

#### FR-18: Query history

The Hub API returns the Event Log filtered by Resource, Pool, Claimant, repo and time range, and per-Resource utilisation (the share of the window each Resource was held, idle while reserved, idle, and away) for a window.

**Consequences (testable):**
- Every event since the Event Log shipped stays queryable. v1 does not compact or delete it. `[ASSUMPTION: no retention limit in v1; revisit when the log passes 100 MB]`

#### FR-19: Capacity Estimate

For any Pool, or single Resource, the hub reports over a chosen window:
- the arrival rate, the mean and variance of hold time, and the measured mean and p95 wait;
- the mean wait with one more Resource, and the waiting it would save per week in hours.

Realizes UJ-4.

**Consequences (testable):**
- The estimate always reports its sample size, window, utilisation and method.
- With fewer than 30 holds in the window, it is flagged "low data", shows no modelled point number, and gives the one-more-Resource wait as a range from replaying the logged arrivals and holds.
- With 30 or more holds, it shows the modelled number and the replayed range side by side.
- Long administrative holds (for example `--no-connect` holds) can be excluded and are listed separately.

#### FR-20: Starvation signal

The hub flags any Claimant that waited longer than 15 minutes, and any deploy job whose wait timed out, and shows it on the Control Surface. `[ASSUMPTION: 15 minutes]`

**Consequences (testable):**
- A timed-out deploy wait appears on the Control Surface within 2 seconds, with the Holds that blocked it.

### 4.5 Hub API

**Description:** The Hub API is a Node 24 ESM service with no runtime framework. It runs on big-chungus as the deploy runner's user, with the runner's lock dir, because the lock code treats owners from other hosts as stale. It is the only writer of the Registry, and it wraps the existing `lock.mjs` and `emulator.mjs` functions, so there is one lock and queue implementation. It reaches each other host's locks through that host's Host Agent. Its contract is a versioned markdown document that Holocene codes against, following the Candybar pattern.

#### FR-21: Endpoints

The Hub API exposes:
- health (`GET /health` → `{ok, service}`);
- Registry read and write (FR-1 to FR-6, FR-29);
- Hold, Queue and Reservation actions (FR-7 to FR-12);
- live status and stream (FR-14);
- ETA (FR-15), history (FR-18) and Capacity Estimate (FR-19).

**Consequences (testable):**
- Every write returns the resulting state, or a refusal with a machine-readable reason and the matching CLI exit code (75, 76 or 2).
- The contract document lives in the hub repo and is versioned.

#### FR-22: Same semantics as the CLI

Every action through the Hub API has the same effect as the same action through `hub-device`, because both call the same functions.

**Consequences (testable):**
- A Lease taken through the Hub API excludes a deploy job's Job Hold, and the other way round, as today.

#### FR-23: Survive restarts

Restarting the Hub API loses no Hold, Reservation or Queue position, and no Registry entry.

**Consequences (testable):**
- A remote Claimant's Heartbeat lapse is measured from the later of its last Heartbeat and the Hub API's start, so a restart of any length drops nobody who resumes heartbeating within one lapse after it.

### 4.6 Control Surface (Holocene page)

**Description:** The Control Surface is a Holocene page under the "System" navigation group, built like the Candybar page. Holocene's own API calls the Hub API server-side and relays its stream; the browser never calls the Hub API. It shows Resources, Holds, Queues, ETAs, history and Capacity Estimates, and lets Jarad register, edit, retire, lease, release, cancel and force-release. This work lands in the Holocene repo (`~/code/33GOD/holocene`) against the Hub API contract. Realizes UJ-3 and UJ-4.

#### FR-24: Resource board

The Control Surface shows every Resource and Pool with its Reachability, current Hold (Claimant, why, since, expected end) and Queue (position, Claimant, ETA), updating live, and marks the deploy-eligible Resources.

**Consequences (testable):**
- The board updates within 2 seconds of a change.
- When the Hub API is unreachable, the board says so, shows the time of the last good data, and offers no write actions.

#### FR-25: Register and edit from the Control Surface

Jarad can register a discovered device, register one by hand, edit it and retire it. Realizes UJ-3.

**Consequences (testable):**
- Registering from the Control Surface produces the same Registry entry as FR-1 through the Hub API, and the Resource appears on the board within 2 seconds.
- Every FR-1 and FR-2 refusal is shown with its reason, and the form keeps what Jarad typed.
- Changing the emulator Pool's size takes effect for new Leases and never stops a running emulator.

#### FR-26: Act on Holds

Jarad can lease a Resource for himself, release his own Leases, cancel Reservations, and force-release with confirmation (FR-11).

**Consequences (testable):**
- A Lease taken from the Control Surface is a remote Lease with a Heartbeat held by Holocene's server, and shows as Jarad's on `hub-device status`.
- Each action shows its result or its refusal, and the board reflects it within 2 seconds.

#### FR-27: History and capacity panel

The Control Surface shows per-Resource utilisation and wait history over a chosen window, and the Capacity Estimate for each Pool. Realizes UJ-4.

**Consequences (testable):**
- The window can be set to 1, 7, 14 or 30 days. `[ASSUMPTION]`
- The panel shows every FR-19 figure with its sample size, method and "low data" flag, and never hides the flag.

#### FR-28: Starvation and away alerts on the Control Surface

The Control Surface surfaces FR-20 starvation signals and Resources that have been `offline` or `absent` too long.

**Consequences (testable):**
- A Resource `offline` or `absent` for more than 30 minutes is flagged; after 14 days `absent` the Control Surface suggests retiring it. `[ASSUMPTION: 30 minutes and 14 days]`

## 5. Cross-Cutting NFRs

- **NFR-1 One implementation.** There is exactly one lock, queue and Reservation implementation, in the hub's lock code. The Hub API, Host Agents, `hub-device`, deploy jobs and the catch-up all call it, and no second store of Holds exists.
- **NFR-2 Backward compatibility with pinned runs.**
  - Pinned hub versions up to the current one still take bare locks; v1.2.25 and earlier still reclaim Leases as dead jobs.
  - The on-disk lock layout stays readable by them.
  - The release that brings the new semantics states that fairness holds only for runs on the new pin. The pin flip lands before `hosts:install` turns on the new behaviour.
- **NFR-3 No new clock.**
  - Expiry, reclaim and Heartbeat lapse are handled when the hub is called, and through the Hub API's own request handling. Nothing is reaped on a timer.
  - Host Agents add no schedule. Anything recurring is a Candybar job.
- **NFR-4 Node only.** All new hub code is Node 24 ESM. The Hub API and Host Agents add no Python.
- **NFR-5 Hermetic tests.** Every new module is covered by tests under `tools/**/*.test.mjs` that run on a GitHub-hosted runner with no device, bucket or host state.
- **NFR-6 Reach and access.**
  - The Hub API listens on loopback on big-chungus. `[ASSUMPTION]`
  - Holocene reaches it server-side, and Holocene's Google sign-in at Traefik is the only gate for people.
  - Agents on big-chungus use the CLI or loopback.
- **NFR-7 Latency.** A status read answers in under 200 ms on big-chungus, and an uncontended acquire through the Hub API in under 1 s, not counting finding the phone.

## 6. Non-Goals (Explicit)

- Not a device farm or remote-screen tool, nothing like STF's browser control of devices. Claimants use the device through adb or devicectl themselves.
- Not a test orchestrator or CI scheduler. Deploy runs stay GitHub workflows; the hub only orders their access to Resources.
- No priority classes, preemption or fair-share weighting in v1. Pure first come, first served.
- The Registry does not decide what a device may receive. `policy.json` still pins packages, signers and bundle ids.
- No lock that spans hosts. Each lock lives on one host and is owned by that host's Host Agent.
- No standing per-app sign-up. A Reservation belongs to one run.
- No purchase automation. The Capacity Estimate informs Jarad and does not order hardware.

## 7. MVP Scope

### 7.1 In Scope (v1), in delivery order

Each slice is a hub release that ships on its own. The order follows `addendum.md` §B.10.

- **v1a, stop the starvation and start the history:**
  - Event Log (FR-17), so history accrues from the first release.
  - Deploy jobs and the catch-up in the Queue, Reservations, waits shorter than the job timeout (FR-7 to FR-9).
  - Position and ETA in job logs and `hub-device status` (FR-15, FR-16).
  - CLI compatibility (FR-13).
- **v1b, the Registry and the Hub API:**
  - Registry, seeding, discovery, Reachability, Capability requests and the deploy target from the Registry (FR-1 to FR-6, FR-29).
  - Leases with Heartbeats, cancel and force-release (FR-10, FR-11).
  - The Hub API and its contract (FR-14, FR-18, FR-21 to FR-23).
  - The Mac's Host Agent, with the iPad and the Mac as Resources (FR-12).
- **v1c, the Control Surface and the numbers:**
  - Capacity Estimate and starvation signal (FR-19, FR-20).
  - The Holocene page (FR-24 to FR-28), in the Holocene repo.

The starvation fix depends only on v1a.

### 7.2 Out of Scope for v1

- Priority or fair-share policies. Revisit if the Event Log shows first-come-first-served starving something.
- Deploys choosing among several free deploy-eligible devices. v1 installs to the one deploy-eligible Resource per platform (FR-29), which the Registry can move without a release. Choosing among several touches delivery, receipts, catch-up and completion, which all assume one device per platform. Revisit when Jarad wants two deploy phones.
- Fencing tokens checked at install and readback. In v1 every install comes from a local deploy job whose Hold is tied to its process, so a stale holder cannot install. Revisit when a remote Claimant installs to a device.
- Bloodbank events for Holds. The Control Surface uses the Hub API's stream in v1. Revisit when another 33GOD component needs Hold events.
- Access to the Control Surface from a phone webview without Google sign-in.
- Event Log compaction. Revisit when the log passes 100 MB.

## 8. Success Metrics

The baseline for SM-1 and SM-2 is the first 14 days of Event Log data after v1a, read from the runs still on the old pin, plus the deploy failures in GitHub's run history for the 30 days before v1a.

**Primary**
- **SM-1:** Deploy runs on the new pin that fail because a Claimant that arrived later was served first. Target: 0. Deploy waits that time out behind a legitimately long Hold are counted separately and shown with the Hold. Validates FR-7, FR-8, FR-9 and FR-12.
- **SM-2:** Deploy wait. Target: p95 deploy-job wait on the new pin at or below the baseline p95, with every waiting Claimant listed with position and ETA in status, the Hub API and the Control Surface. Validates FR-8, FR-14 and FR-15.
- **SM-3:** Time to register a Resource. Target: under 1 minute from plugging it in to its first Lease, with no hub release. Validates FR-1, FR-4 and FR-25.

**Secondary**
- **SM-4:** ETA accuracy. Target: after 14 days of history, the actual wait falls inside the ETA range for at least half of waits over 2 minutes. Validates FR-15.
- **SM-5:** Capacity Estimate credibility, checked whenever a Resource is added: the measured mean wait over the next 14 days falls inside the estimate's stated range. Validates FR-19.

**Counter-metrics (do not optimize)**
- **SM-C1:** Utilisation. A Pool near 100% busy means waits are exploding, not that it is efficient. Counterbalances SM-1 and SM-5.
- **SM-C2:** Lease length. Do not push Claimants to shorter Leases just to lower ETAs. Releasing early is good; cutting real work short is not. Counterbalances SM-4.
- **SM-C3:** "Low data" flags. Never hide them to make the estimate look confident. Counterbalances SM-4 and SM-5.
- **SM-C4:** Idle while reserved. The share of time a Resource sat free waiting for an unclaimed Reservation. Fairness should not cost more than the starvation it prevents. Counterbalances SM-1.

## 9. Open Questions

1. Does the Mac's Host Agent run behind the Mac's existing catch-up LaunchAgent, as an on-demand ssh call, or as its own long-lived process? It must not add a clock (NFR-3). See `addendum.md` §B.6.

## 10. Assumptions Index

- §4.1: the Registry is a file store in the lock dir on big-chungus, owned by the Hub API, seeded from `devices.json` and `qa-devices.json` (Jarad delegated this call).
- FR-5: a Reachability reading older than 60 s is shown with its age.
- FR-8: a deploy job's wait ends 2 minutes before its job timeout.
- FR-9: the grace period is 10 minutes and policy-pinned; an unclaimed Reservation ends 3 hours after it was taken.
- FR-10: Heartbeat every 30 s, lapse after 90 s; a 15 s quarantine before a lapsed Resource is reassigned.
- FR-15: the ETA range is the interquartile range of matching past holds.
- FR-18: no Event Log retention limit in v1.
- FR-20: the starvation threshold is 15 minutes.
- FR-27: history windows of 1, 7, 14 and 30 days.
- FR-28: away flagged after 30 minutes, retirement suggested after 14 days absent.
- NFR-6: the Hub API listens on loopback only; people reach it only through Holocene.
