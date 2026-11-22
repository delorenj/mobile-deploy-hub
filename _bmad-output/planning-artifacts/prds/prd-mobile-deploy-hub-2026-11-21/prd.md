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

Terms come from the Glossary (§3) and are used exactly. Features are grouped, with globally numbered FRs nested under them. Inferences are tagged `[ASSUMPTION]` and indexed in §9. Mechanism, transport and the queueing math live in `addendum.md`.

## 1. Vision

The hub's device leasing works, and Jarad wants to keep it and grow it. Today it knows two phones by name, a small emulator pool, and an iPad and a Mac it cannot lease. Deploy runs do not stand in line: they keep retrying the lock, so queued leases win every handoff, and a deploy can wait out its 20-minute limit and fail after its version was already bumped. Nobody can see that the deploy is waiting, how long it will wait, or whether one more phone would have prevented it.

The Hub Resource Registry makes every contended thing a **Resource**: phones, the iPad, emulator slots and the Mac. Each one is registered once, and registering needs no hub release. Every **Claimant** stands in the same first-come-first-served **Queue**: a deploy run, an agent or Jarad. A deploy run can take a **Reservation** at plan time and keep its place through the build. Every waiter sees its position and an **ETA**. An append-only **Event Log** records every request, hold and release. From that history the hub answers "how much waiting would one more device save?" with a **Capacity Estimate** instead of a guess.

It is driven through a **Hub API** written in Node, which wraps the existing lock code rather than replacing it. It is managed from a **Control Surface**: its own page in Holocene, the canonical control surface. The hub keeps authority over holds and queues. Holocene shows them and forwards Jarad's actions.

## 2. Target User

### 2.1 Jobs To Be Done

- **A deploy run:** wait its turn for the S26, the iPad or the Mac without being shut out by a stream of leases. It must keep its place across the gap between its plan job and its install job.
- **An agent:** find out which phones and emulators exist, which are reachable and which are free, and take one that fits. If none is free, join the line and learn how long the wait is, instead of guessing from `devices.json` or retrying.
- **Jarad:**
  - register a new phone or emulator profile in a minute and have every app use it, with no hub release;
  - see who holds what and who is waiting, from Holocene, wherever he is;
  - cancel or release a stuck hold;
  - decide with numbers whether another device is worth adding.

### 2.2 Non-Users (v1)

- Anyone but Jarad's own apps, agents and deploy runs. This is not a device farm for other people.
- Hosts other than big-chungus and the hub's Mac (`hub-mac`). Other Macs and remote Linux boxes are out.

### 2.3 Key User Journeys

- **UJ-1. Tower's deploy run is not shut out.**
  - Jarad ships Tower while an agent holds the S26 on a 30-minute lease and a Green In Between deploy is already waiting.
  - Tower's plan job takes a Reservation on the S26 and lands at position 2, with an ETA of about 25 minutes, which its job log prints.
  - The build runs, and the Reservation keeps Tower's place through it. When the S26 frees and Green In Between finishes, Tower's install job claims its Reservation and installs.
  - **Edge case:** the lease holder extends by 15 minutes. Tower's ETA moves in the log and on the page, and its position does not change.
- **UJ-2. An Earshot QA agent finds a phone.**
  - The agent asks the Hub API for any Android phone at API level 34 or higher and gets the S24.
  - When both phones are held, the agent joins the phone Pool's Queue at position 1 with an ETA of 8 minutes. It waits, gets the first phone that frees, and releases it when the run ends.
  - **Edge case:** the agent's process dies mid-wait. Its place is dropped within one heartbeat interval, so nobody waits behind a ghost.
- **UJ-3. Jarad registers a new phone from Holocene.**
  - Jarad plugs a Pixel into big-chungus, opens the Holocene resources page, and sees it listed as a discovered, unregistered device.
  - He registers it with a name, kind, capabilities and whether deploys may install on it.
  - Within a minute an agent can lease it, and `hub-device status --json` shows it. No hub release or `hosts:install` was needed.
- **UJ-4. Jarad decides whether to buy another phone.**
  - The page's capacity panel shows the phone Pool over the last 14 days: requests per hour, mean hold time, current mean wait, and the expected mean wait with one more phone.
  - The panel says 9 minutes now and 1.5 minutes with one more, from 212 holds, with the sample size and method shown. Jarad buys the phone and registers it as in UJ-3.

## 3. Glossary

- **Resource** — one thing Claimants hold exclusively. v1 kinds: `android-phone`, `ios-device` (the iPad), `emulator` (one slot of the emulator Pool) and `mac` (the Mac's iOS build/install lane). A Resource has a stable id, a name, Capabilities, a Reachability and a deploy-eligible flag.
- **Capability** — a declared property a Claimant can ask for: platform, model, OS/API level, profile (for emulators), dedicated-QA, deploy-eligible.
- **Registry** — the hub's authoritative list of Resources and Pools.
- **Pool** — a named set of interchangeable Resources served by one Queue, for example "any Android phone" or the emulator Pool. A Resource can be in several Pools.
- **Claimant** — whoever asks for a Resource. There are three kinds: a deploy run (its jobs), an agent, or a person.
- **Hold** — one Claimant's exclusive possession of a Resource. It has a start, an expected end and an expiry. There are two kinds:
  - a **Job Hold**, taken by a deploy job for the job's length;
  - a **Lease**, taken by an agent or a person for a stated duration.
- **Queue** — the first-come-first-served line of waiting Claimants for one Resource or one Pool.
- **Reservation** — a Claimant's place in a Queue. It survives a gap, such as between a deploy run's plan job and its install job, and a restart of the Hub API. It ends when it is claimed, cancelled or expired.
- **Heartbeat** — a periodic renewal by a remote Claimant that keeps its Lease or Reservation alive when it has no process on the host.
- **Reachability** — whether a Resource can be used right now: `reachable`, `unauthorized`, `offline`, `absent` or `unknown`.
- **ETA** — the estimated time until a queued Claimant receives its Hold, with a confidence range.
- **Event Log** — the append-only history of every request, acquire, release, extend, timeout, cancel and reclaim, for every Hold and Reservation.
- **Capacity Estimate** — for a Pool, the expected mean wait at its current size and at one more Resource, computed from the Event Log.
- **Hub API** — the hub's HTTP service, written in Node, through which the Registry, Holds, Queues and the Event Log are read and changed.
- **Control Surface** — the Holocene page for the Registry.
- **Mac Agent** — the hub process on the Mac that serves the Mac's own locks to the Hub API.

## 4. Features

### 4.1 Registry

**Description:** Every Resource is declared in the Registry, and registering one is a runtime action, not a hub release. Today's `tools/ci/devices.json` becomes the seed: the S26, the S24, the iPad and the Mac are imported on first start, and the committed file stays as the record of the deploy baseline. The emulator Pool's profiles (`default`, `playstore`) and its size become Registry entries instead of code constants. Discovery lists devices on the host's adb server (and, later, the Mac's devicectl) that are not registered yet. Realizes UJ-2 and UJ-3.

`[ASSUMPTION: Jarad delegated the storage call. The Registry is owned by the Hub API and persisted as a file store in the lock dir on big-chungus, beside the locks it governs. devices.json seeds it; the private qa-devices.json is imported as dedicated-QA Capability on the phones it names.]`

#### FR-1: Register a Resource

Jarad, or an agent through the Hub API, can register a Resource with a kind, name, identity (serial, UDID or host), Capabilities and a deploy-eligible flag. Realizes UJ-3.

**Consequences (testable):**
- A registered Resource can be held within 60 seconds of registration, with no hub release and no `hosts:install`.
- Registering a duplicate identity (same serial or UDID) is refused with the existing Resource's id.
- A name that collides with a reserved word (`phone`, `emulator`, `adb`) or an existing Resource is refused.

#### FR-2: Edit and retire a Resource

Jarad can edit a Resource's name, Capabilities and deploy-eligible flag, and retire a Resource.

**Consequences (testable):**
- Retiring a Resource while it is held does not end the Hold. The Resource stops taking new Holds and leaves the Registry when the Hold ends.
- A retired Resource stays in the Event Log under its id.

#### FR-3: Seed from the committed declarations

On first start the Registry imports every Resource in `tools/ci/devices.json` and the dedicated-QA phones in `~/.config/mobile-deploy-hub/qa-devices.json`, keeping their existing lock names (`adb` for the S26, `s24` and so on).

**Consequences (testable):**
- After the import, existing `hub-device lease s24|s26|phone|emulator` invocations behave exactly as before.
- The private QA file's contents are never written into any committed file.

#### FR-4: Discover unregistered devices

The Registry lists Android devices visible to the hub's adb server that are not registered, with model and serial. Realizes UJ-3.

**Consequences (testable):**
- Discovery never starts an adb server or connects anything.
- Discovery reuses the existing read-only inventory, and reports "no adb server" rather than starting one.

#### FR-5: Report Reachability

For each Resource the Registry reports its Reachability and when it was last checked.

**Consequences (testable):**
- Phones use the same `findPhone` matching that deploys use; the iPad and the Mac are reported through the Mac Agent.
- An unknown Reachability is shown as `unknown`, never as `reachable`.

#### FR-6: Find a Resource by Capability

A Claimant can ask for "any Resource matching these Capabilities", such as an Android phone at API level 34 or higher, or the playstore emulator profile. It gets one that is free and reachable, or joins the matching Pool's Queue. Realizes UJ-2.

**Consequences (testable):**
- A Capability request matching no registered Resource fails at once with the reason, and never waits.
- The existing `phone` word becomes a Pool request and keeps its CLI behaviour.

### 4.2 Holds, Queues and Reservations

**Description:** One first-come-first-served Queue per Resource and per Pool serves every Claimant kind. Deploy jobs join it like leases do instead of retrying `mkdir`. A deploy run takes a Reservation in its plan job and claims it in its install job, so the build gap no longer loses its place. Remote Claimants (Holocene users, agents on other hosts) keep their place with Heartbeats. A local Claimant can still tie its Lease to a process, as it does today. Realizes UJ-1 and UJ-2.

#### FR-7: First come, first served for every Claimant

Every Claimant kind (deploy run, agent, person) waits in the same Queue and is served strictly in arrival order. There are no priority classes in v1. Realizes UJ-1.

**Consequences (testable):**
- A deploy job that starts waiting before a Lease request gets the Resource first.
- A Lease that starts waiting first is served first, even though the other Claimant is a deploy.
- A free Resource with an empty Queue is taken at once.

#### FR-8: Deploy jobs stand in the Queue

A deploy job waiting for a Resource holds a place in its Queue and appears in every status view, with its repo, run and job.

**Consequences (testable):**
- `hub-device status --json`, the Hub API and the Control Surface all list a waiting deploy job with its position.
- No deploy job on the new semantics fails on its lock timeout while it is first in line and the Resource is held only by Claimants behind it.
- A deploy job's longest wait is shorter than its job timeout, so a timed-out wait always reports its own reason instead of being killed silently by GitHub. Today both are 20 minutes.

#### FR-9: Reservation across a deploy run's jobs

A deploy run's plan job takes a Reservation on the Resources it will install to, and its install job claims that Reservation. Realizes UJ-1.

**Consequences (testable):**
- While the Reservation is unclaimed and has reached the head of the Queue, the Resource is not handed to anyone behind it until the Reservation's grace period ends. `[ASSUMPTION: grace = 10 minutes, policy-pinned]`
- A run that is cancelled or fails releases its Reservations, or they expire on their own.
- A rerun of a failed job reuses the run's Reservation if it is still live, and keeps its original place in the Queue.
- When a run would wait behind its own Hold or Reservation on the same Resource, it is detected and refused, never left to deadlock.

#### FR-10: Leases with expiry, extension and Heartbeat

An agent or a person can take a Lease for a stated duration (up to 48 hours, as today), extend it, and release it.

**Consequences (testable):**
- A Lease tied to a process is reclaimed when the process is gone, as today.
- A Lease or Reservation held through the Hub API without a local process is reclaimed when its Heartbeat lapses. `[ASSUMPTION: Heartbeat every 30 s, lapse after 90 s]`
- An extension past 48 hours from the original start is refused.
- A Lease whose Heartbeat is late but not yet lapsed shows as "in jeopardy" on every status view. After a lapse, the Resource goes to the next Claimant only after a short quarantine, so a slow holder and a new one never overlap. `[ASSUMPTION: quarantine 15 s]`
- Every Hold carries a fencing token that increases with each new Hold on that Resource. A deploy job's install and readback steps present their token, and a stale token is refused.

#### FR-11: Cancel and force-release

A Claimant can cancel its own Reservation or queued request. Jarad can force-release any Lease or Reservation from the Control Surface.

**Consequences (testable):**
- Force-release asks for confirmation and records who and why in the Event Log.
- A deploy job's Job Hold cannot be force-released from the Control Surface. Ending it means cancelling the run, and the page links to the run.

#### FR-12: The iPad and the Mac as Resources

The iPad (`ios-device`) and the Mac (`mac`) are Resources with Queues, Reservations and Leases, served on the Mac's side by the Mac Agent. Realizes UJ-1.

**Consequences (testable):**
- `hub-device lease ipad` and `hub-device lease mac` take a Lease through the Hub API.
- A deploy run's iOS jobs wait in the same first-come-first-served Queue, replacing today's unordered `mac-ios` retry.
- When the Mac is away, its Resources report `offline`, Lease requests for them fail at once with `HUB_DEVICE_AWAY`, and Reservations keep their place.

#### FR-13: CLI compatibility

`hub-device` keeps its commands, exit codes (75 away, 76 busy), `HUB_DEVICE_*` lines and `--json` shapes, and works when the Hub API is down for every Resource local to big-chungus.

**Consequences (testable):**
- The existing `tools/device/*.test.mjs` suites pass unchanged.
- With the Hub API stopped, `hub-device lease s24` still works, and the Lease shows in the Hub API when it comes back.

### 4.3 Visibility and ETA

**Description:** Anyone can see, for every Resource and Pool, who holds it, until when, and who is waiting in what order, including deploy jobs. Each waiter gets an ETA with a range, and the ETA is honest about how little data there is. Realizes UJ-1 and UJ-2.

#### FR-14: Live status

The Hub API returns, and streams as changes, every Resource's Reachability, current Hold (Claimant, kind, why, since, expected end, expiry) and Queue (position, Claimant, since).

**Consequences (testable):**
- A change (acquire, release, enqueue, cancel, Reachability) reaches stream subscribers within 2 seconds.
- The stream sends a keepalive at least every 30 seconds.

#### FR-15: ETA for a waiter

Every queued Claimant gets an ETA, built from the current holder's expected remaining time and the expected hold time of each Claimant ahead of it. Realizes UJ-1 and UJ-2.

**Consequences (testable):**
- A Lease's expected end is its expiry, adjusted by how early such Leases are usually released.
- A Job Hold's expected end comes from past holds of the same repo and job.
- With fewer than 5 past holds of a type, the ETA is reported as a range with a "low data" flag, never as a single number.

#### FR-16: ETA where Claimants already look

A waiting deploy job prints its position and ETA in its job log whenever either changes, and `hub-device lease --wait` prints them on stderr. Realizes UJ-1.

**Consequences (testable):**
- The log line has a stable, greppable shape (`HUB_LOCK_WAIT <resource> position=<n> eta=<range>`).

### 4.4 Event Log and Capacity Estimate

**Description:** Every Hold and Reservation transition is appended once to the Event Log on the host that owns the lock. It carries no secrets and is the single source for ETAs, history and the Capacity Estimate. The Capacity Estimate uses a standard queueing approximation. The method and sample size are always shown with the number. Realizes UJ-4.

#### FR-17: Record every transition once

The hub appends one event for each request, acquire, release, extend, timeout, cancel and reclaim, for Leases, Job Holds and Reservations. Each event records the Resource, the Claimant (kind, holder, repo/run/job), the times, `waited_ms` and `held_ms`, and the reason.

**Consequences (testable):**
- A full deploy run, a Lease, an emulator Lease and a timed-out wait each produce exactly the expected event sequence in tests.
- Writing the Event Log never makes an acquire or release fail. A write error is logged and the transition still happens.

#### FR-18: Query history

The Hub API returns the Event Log filtered by Resource, Pool, Claimant, repo and time range, and per-Resource utilisation (held, idle and away fractions) for a window.

**Consequences (testable):**
- At least 90 days of history stay queryable. `[ASSUMPTION: retention 90 days, then compacted to daily aggregates]`

#### FR-19: Capacity Estimate

For any Pool, or single Resource, the hub reports over a chosen window:
- the arrival rate, the mean and variance of hold time, and the current mean wait (both measured and modelled);
- the modelled mean wait with one more Resource.

Realizes UJ-4.

**Consequences (testable):**
- The estimate reports its sample size, window and method.
- With fewer than 30 holds in the window, it is flagged "low data".
- Long administrative holds (for example `--no-connect` holds) can be excluded and are listed separately.

#### FR-20: Starvation signal

The hub flags any Claimant that waited longer than a threshold, or any deploy job that timed out while waiting, and shows it on the Control Surface.

**Consequences (testable):**
- A timed-out deploy wait appears on the page within 2 seconds, with the Holds that blocked it.

### 4.5 Hub API

**Description:** The Hub API is a Node 24 ESM service with no new runtime framework requirement. It runs on big-chungus as the deploy runner's user, with the runner's lock dir, because the lock code treats owners from other hosts as stale. It is the only writer of the Registry, and it wraps the existing `lock.mjs` and `emulator.mjs` functions, so there is one lock and queue implementation. It reaches the Mac's locks through the Mac Agent. Its contract is a versioned markdown contract that Holocene codes against, following the Candybar pattern.

#### FR-21: Endpoints

The Hub API exposes:
- health (`GET /health` → `{ok, service}`);
- Registry read and write (FR-1 to FR-6);
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
- A Claimant queued through the Hub API keeps its position across a Hub API restart shorter than its Heartbeat lapse.

### 4.6 Control Surface (Holocene page)

**Description:** The Control Surface is a Holocene page under the "System" navigation group, built like the Candybar page. Holocene's own API calls the Hub API server-side and relays its stream; the browser never calls the Hub API. It shows Resources, Holds, Queues, ETAs, history and Capacity Estimates, and lets Jarad register, edit, retire, lease, release, cancel and force-release. Realizes UJ-3 and UJ-4.

#### FR-24: Resource board

The page shows every Resource and Pool with its Reachability, current Hold (Claimant, why, since, expected end) and Queue (position, Claimant, ETA), updating live.

**Consequences (testable):**
- The board updates within 2 seconds of a change.
- When the Hub API is unreachable, the board says so, shows the time of the last good data, and offers no write actions.

#### FR-25: Register and edit from the page

Jarad can register a discovered device, register one by hand, edit it and retire it. Realizes UJ-3.

#### FR-26: Act on Holds

Jarad can lease a Resource for himself, release his own Leases, cancel Reservations, and force-release with confirmation (FR-11).

#### FR-27: History and capacity panel

The page shows per-Resource utilisation and wait history over a chosen window, and the Capacity Estimate for each Pool, with sample size and method. Realizes UJ-4.

#### FR-28: Starvation and away alerts on the page

The page surfaces FR-20 starvation signals and Resources that have been `offline` or `absent` longer than a threshold.

## 5. Cross-Cutting NFRs

- **NFR-1 One implementation.** There is exactly one lock, queue and Reservation implementation, in the hub's lock code. The Hub API, `hub-device`, deploy jobs and the catch-up all call it, and no second store of Holds exists.
- **NFR-2 Backward compatibility with pinned runs.**
  - Pinned hub versions up to the current one still take bare locks; v1.2.25 and earlier still reclaim Leases as dead jobs.
  - The on-disk lock layout stays readable by them.
  - The release that brings the new semantics states that fairness holds only for runs on the new pin. The pin flip lands before `hosts:install` turns on the new behaviour.
- **NFR-3 No new clock.**
  - Expiry, reclaim and Heartbeat lapse are handled when the hub is called, and through the Hub API's own request handling. Nothing is reaped on a timer.
  - Anything recurring (Event Log compaction, for example) is a Candybar job.
- **NFR-4 Node only.** All new hub code is Node 24 ESM. The Hub API adds no Python.
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
- No federation of locks across hosts beyond big-chungus and the hub's Mac.
- No purchase automation. The Capacity Estimate informs Jarad and does not order hardware.

## 7. MVP Scope

### 7.1 In Scope (v1)

- Registry with every v1 Resource kind (phones, the iPad, emulator slots, the Mac), seeded from today's declarations (FR-1 to FR-6).
- First-come-first-served Queues for every Claimant kind, deploy jobs included. Reservations across a run's jobs, and Heartbeats (FR-7 to FR-13).
- Live status and ETAs (FR-14 to FR-16).
- Event Log, history and Capacity Estimate (FR-17 to FR-20).
- Hub API with its markdown contract (FR-21 to FR-23).
- The Holocene page (FR-24 to FR-28).

### 7.2 Out of Scope for v1

- Priority or fair-share policies. Revisit if the Event Log shows first-come-first-served starving something.
- Deploys targeting "any free compatible device" instead of the S26 and the iPad. It touches delivery, receipts, catch-up and completion, which all assume one S26. Deferred to v2. `[NOTE FOR PM]` This is the natural next step once the Registry exists. Revisit when a second deploy-eligible phone is registered.
- Bloodbank events for Holds. The page uses the Hub API's stream in v1. Revisit when another 33GOD component needs Hold events.
- Mobile-friendly access to the page from a phone webview without Google sign-in.

## 8. Success Metrics

**Primary**
- **SM-1:** Deploy runs that fail waiting for a Resource. Target: 0 per 30 days among runs on the new pin. Validates FR-7, FR-8, FR-9 and FR-12.
- **SM-2:** Visible waiters. Target: 100% of waiting Claimants, deploy jobs included, appear with position and ETA in status, the Hub API and the page. Validates FR-8, FR-14 and FR-15.
- **SM-3:** Time to register a Resource. Target: under 1 minute from plugging it in to its first Lease, with no hub release. Validates FR-1, FR-4 and FR-25.

**Secondary**
- **SM-4:** ETA accuracy. Target: after 14 days of history, the median absolute error for waits over 2 minutes is under 30% of the actual wait. Validates FR-15.
- **SM-5:** Capacity Estimate credibility. Target: after a Resource is added, the measured mean wait over the next 14 days falls inside the estimate's stated range. Validates FR-19.

**Counter-metrics (do not optimize)**
- **SM-C1:** Utilisation. A Pool near 100% busy means waits are exploding, not that it is efficient. Counterbalances SM-1 and SM-5.
- **SM-C2:** Lease length. Do not push Claimants to shorter Leases just to lower ETAs. Releasing early is good; cutting real work short is not. Counterbalances SM-4.
- **SM-C3:** "Low data" flags. Never hide them to make the estimate look confident. Counterbalances SM-4 and SM-5.

## 9. Open Questions

1. Is the Reservation grace period (FR-9) policy-pinned like other hub limits, or a per-Resource setting? Which value?
2. Does the Mac Agent run as part of the Mac's existing catch-up LaunchAgent, or as its own on-demand job? It must not add a clock (NFR-3).
3. Should a dedicated-QA phone (from `qa-devices.json`) be in the default phone Pool, or only reachable by name?
4. How long should Holocene keep showing a Resource that has been `absent` for weeks before suggesting it be retired?
5. Does the page need a phone-friendly layout for v1, given Google sign-in blocks a phone webview?

## 10. Assumptions Index

- §4.1: the Registry is a file store in the lock dir on big-chungus, owned by the Hub API, seeded from `devices.json` and `qa-devices.json` (Jarad delegated this call).
- FR-9: the Reservation grace period is 10 minutes and policy-pinned.
- FR-10: Heartbeat every 30 s, lapse after 90 s; a 15 s quarantine before a lapsed Resource is reassigned.
- FR-18: Event Log retention is 90 days, then daily aggregates.
- NFR-6: the Hub API listens on loopback only; people reach it only through Holocene.
