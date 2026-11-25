---
status: final
release: v1b
stepsCompleted: [step-01-validate-prerequisites, step-02-design-epics, step-03-create-stories, step-04-final-validation]
inputDocuments:
  - _bmad-output/planning-artifacts/prds/prd-mobile-deploy-hub-2026-11-21/prd.md
  - _bmad-output/planning-artifacts/prds/prd-mobile-deploy-hub-2026-11-21/addendum.md
  - _bmad-output/planning-artifacts/prds/prd-mobile-deploy-hub-2026-11-21/.memlog.md
  - _bmad-output/planning-artifacts/architecture/architecture-mobile-deploy-hub-v1b-2026-11-24/ARCHITECTURE-SPINE.md
  - _bmad-output/planning-artifacts/architecture/architecture-mobile-deploy-hub-v1b-2026-11-24/.memlog.md
  - _bmad-output/planning-artifacts/architecture/architecture-mobile-deploy-hub-v1a-2026-11-23/ARCHITECTURE-SPINE.md
  - _bmad-output/planning-artifacts/epics-v1a.md
created: '2026-11-24'
updated: '2026-11-24'
---

# Mobile Deploy Hub: Epic Breakdown, Hub Resource Registry v1b

## Overview

This document breaks the **v1b** release of the Hub Resource Registry into epics and stories (PRD §7.1, "the Registry and the Hub API"). It covers FR-1 to FR-6 and FR-29 (Registry, seeding, discovery, Reachability, capability requests, visible deploy targets), FR-10 and FR-11 (Leases through the API, cancel, force-release), FR-14, FR-18 and FR-21 to FR-23 (the Hub API and its contract), and the rest of FR-12 (the Mac Host Agent). v1c (Capacity Estimate, starvation signal, the Holocene Control Surface) is out of scope except for the seams the spine names: the reserved `/capacity` route, `actor.via: control-surface`, and the confirmation step that lives in the page.

The architecture spine for v1b (AD-23 to AD-49) is binding; the v1a spine (AD-1 to AD-22) is settled and shipped. A story that seems to need something the spine forbids is a spine change, not a local workaround. Every story cites the `AD-n` that governs it.

**Neighbouring level (belsky-doctrine).** The asks behind v1b are "an agent cannot tell which phone is free" and "Jarad cannot add a phone without a hub release". Each is built for every Resource and every Claimant kind: any registered phone, emulator profile or the `ios-lane`, taken by any agent, person or job through one Claims library. The asker's real use (Jarad registering a Pixel, an Earshot QA agent waiting for a phone) is the acceptance test. Nothing here adds a Resource kind, a priority class or a host beyond the spine.

There is no UX document: v1b has no UI. Its surfaces are `hub-device` output, the Hub API contract and the Mac's launchd logs. The page is v1c.

## Assumptions and open questions carried into this breakdown

These are the architecture run's undecided points. Each story that touches one states the spine's default and keeps it reversible.

| # | Question (spine "Open Questions") | Default stories assume | Where | Reversal |
| --- | --- | --- | --- | --- |
| Q1 | The S24 is both the dedicated-QA phone and the first member of `phone` | FR-3 wins: a seeded named list ignores the `dedicated_qa` exclusion; queries (`--match`, API `match`) exclude it unless they name it or ask for `dedicated_qa` (AD-33) | 5.5, 5.7, 5.8, 6.9 | One seed constant (`PHONE_POOL_SEED`) and one flag on the named-list rule in `match.mjs`; tests pin both behaviours separately |
| Q2 | Do person Leases count toward Lease ETA history? | No: `acquireLease` records `claimantKind` (`agent` default, `person`) and `eta.mjs` already matches history by claimant kind, so person history stays separate. v1b changes nothing in `eta.mjs` | 7.1 | Change the kind match in `eta.mjs` only; no event or API shape changes |
| Q3 | v1c Holocene module id and env var | Out of v1b. The contract doc carries the spine's proposal (`mobile-deploy-hub`, `MOBILE_DEPLOY_HUB_API_URL`, default `http://127.0.0.1:8794`) as a non-binding note. No v1b story depends on it | 6.4 | Edit one note in `docs/hub-api-contract.md` |

Assumption made by this breakdown (not by the spine):

- **A1. Release cadence.** The spine's roll-out describes one release for the whole of v1b. Every v1b change is additive (pinned readers ignore `registry.json`, `replicas/` and the new event names), so this breakdown ships one hub release per epic (`mise run release -- X.Y.Z`, then `mise run hosts:install`), each ship story being the last of its epic. Until Epic 9 ships, `hosts:install` reads back only the Hub API; Epic 9 adds the Mac Host Agent readback and the check that both services report equal `contract` and `hub_version` (AD-45). To collapse back to one release, skip the ship stories of Epics 5 to 9 and run Story 10.5 only; no story's acceptance depends on an earlier release having been cut.

## Requirements Inventory

### Functional Requirements

Requirements in v1b scope (PRD §4, §7.1). FR-30 and the other v1a requirements shipped in v1a and are untouched.

- **FR-1:** Jarad, or an agent through the Hub API, registers a Resource with kind, name, host, identity and Capabilities. It is holdable within 60 s with no hub release (once one `hosts:install` has shipped a Registry-reading `hub-device`). A duplicate identity is refused with the existing id; a name or lock name colliding with a CLI word, a lock name in use or an existing Resource is refused (seeded Resources exempt).
- **FR-2:** Name and Capabilities are editable; a Resource can be retired. Retiring a held Resource does not end the Hold; the Resource stops taking new Holds from the API and `hub-device` alike and leaves when the Hold ends. A retired Resource stays in the log and file and never returns on re-seed. A `devices.json` Resource cannot be retired or have its identity edited. Registry writes say so when the Hub API is down; Holds still work.
- **FR-3:** At every start the Registry imports every Resource in `tools/ci/devices.json` with its existing lock name and marks the deploy targets; on first start it imports the dedicated-QA phones from `qa-devices.json`. Existing `hub-device lease s24|s26|phone|emulator` behave as before; a `devices.json` change shows at the next start; the QA file's contents never reach a committed file, and the Control Surface-facing views show a QA phone's name and Capabilities, never its serial or allowed users.
- **FR-4:** Discovery lists Android devices visible to a host's adb server that are not registered, with model and serial, using the same read-only query as `hub-device status`. It never starts or connects anything and says "no adb server" instead. A `host:port` device's serial is read with a read-only device query.
- **FR-5:** Each Resource reports its Reachability (`reachable`, `unauthorized`, `offline`, `absent`, `unknown`) and when it was last checked. `unknown` is never shown as `reachable`. A reading older than 60 s is refreshed on request and shown with its age. Phone Reachability uses status's read-only matching, never `findPhone`. The `ios-lane` is reported by the Mac's Host Agent and reads `offline` when the Mac is unreachable.
- **FR-6:** A Claimant can ask for any Resource matching Capabilities and gets one free and reachable, or waits in the Queue of every match and takes the first that serves it. No match fails at once with the reason; every match `offline` or `absent` fails at once with `HUB_DEVICE_AWAY` (75). The `phone` word becomes a Pool request that still prefers the S24 and now holds a place in line. A dedicated-QA phone is served only to a request that names it or asks for `dedicated_qa`.
- **FR-29:** `hub-device status --json`, the Hub API and (v1c) the Control Surface mark the deploy targets with Reachability, current Hold and Queue. The deploy targets come from the committed `devices.json`; the Registry shows them and cannot change them.
- **FR-10:** A Lease for a stated duration (up to 48 h) can be taken, extended and released, including through the Hub API. A process-bound Lease is reclaimed when its process is gone; an API Lease has no process and lasts until expiry or release. Extension past 48 h from the original start, or at or after expiry, is refused.
- **FR-11:** A Claimant can cancel its own Reservation or queued request. Jarad can force-release any Lease or Reservation, recorded with who and why. A Job Hold cannot be force-released (ending it means cancelling the run). The confirmation step is the page's (v1c).
- **FR-12 (rest):** The Mac's iOS lane and the iPad are one Resource, `ios-lane`, lock `mac-ios`, served by the Mac's Host Agent. `hub-device lease ipad` and `lease mac` both take it and exclude iOS deploys and the iPad catch-up. When the Mac is unreachable the `ios-lane` reads `offline` and Lease requests fail at once with `HUB_DEVICE_AWAY`.
- **FR-13:** `hub-device` keeps its commands, exit codes (75, 76), `HUB_DEVICE_*` lines and `--json` shapes, works for local Resources with the Hub API down, and `status` stays read-only. Existing suites pass except for named intended changes.
- **FR-14:** The Hub API returns and streams every Resource's Reachability, current Hold and Queue. A change written on a host with a Host Agent reaches subscribers within 2 s; time-passing states are computed from timestamps by every reader; the stream keepalive is at most 30 s.
- **FR-17 (v1b part):** Registry changes and Reachability changes are appended to the Event Log once; a service restart or a log-write failure never loses or fails a transition.
- **FR-18:** The Hub API returns the Event Log from both hosts, filtered by Resource, Pool, Claimant, repo and time range, and per-Resource utilisation (held, idle while reserved, idle, away) for a window. Every event since the log shipped stays queryable; Mac history is marked partial for any time the Mac was unreachable.
- **FR-21:** The Hub API exposes health, Registry read and write, Hold/Queue/Reservation actions, live status and stream, and history. Every write returns the resulting state or a machine-readable refusal with the matching CLI exit code. The contract lives in the repo, is versioned, and a contract test checks responses against it.
- **FR-22:** Every action through the Hub API has the same effect as the same action through `hub-device`, because both call the same library functions.
- **FR-23:** Restarting the Hub API loses no Hold, Reservation or Registry entry. A request waiting through the API is dropped on restart with a clear re-queue error. Emulators the API started keep running. Only one Hub API runs at a time.
- **FR-31 (v1b part):** No Lease extension while another Claimant waits, in every queue a Resource is served from, with the Jarad override recorded with who and why.

### NonFunctional Requirements

- **NFR-1:** One lock, queue and Reservation implementation (`lock.mjs`); the Hub API, Host Agent, `hub-device`, deploy jobs and the catch-up all call it; the on-disk layout is the versioned contract.
- **NFR-2:** Pinned runs stay compatible: new files sit beside old ones and pinned readers ignore them; nothing in v1b writes `kind: remote` tickets or a Reservation as an owner.
- **NFR-3:** No new clock. Services react to file events, device events and requests; expiry, reclaim and grace are evaluated when called; anything recurring is a Candybar job.
- **NFR-4:** Node 24 ESM only, no Python, no dependencies.
- **NFR-5:** Every new module has hermetic `tools/**/*.test.mjs` tests: no device, bucket or host state, no real port in the shared suite, no real `qa-devices.json`.
- **NFR-6:** Services bind loopback only; Holocene (v1c) reaches the Hub API server-side; agents on big-chungus use the CLI or loopback; Claimant names are recorded as given.
- **NFR-7:** A status read answers in under 200 ms on big-chungus from the last readings; an uncontended API acquire in under 1 s, excluding finding the phone or booting an emulator.
- **NFR-8:** The Mac is a laptop: its Host Agent sends only changes, reconnects only when it has something to send, and every view treats its data as possibly stale.

### Additional Requirements

From the v1b spine. There is no starter template; this is brownfield work on `tools/ci/lib/lock.mjs`, `tools/device/*` and `tools/hosts.mjs`, plus new directories `tools/registry/`, `tools/hub-api/` and `tools/host-agent/`.

- **Paradigm (AD-23, AD-25):** disk is the only state; services are stateless; an action runs on the Resource's own host; `tools/ci/commands/*` and `tools/catchup/*` never import anything v1b adds, asserted by a conformance test.
- **Claims library (AD-24):** `tools/device/claims.mjs` owns resolve, take, release, cancel, extend, force-release, status assembly, Lease id minting, bounds checks and the code-to-exit table as data. `hub-device.mjs` keeps argument parsing and output.
- **Transport (AD-26, AD-47, AD-48):** loopback-only services (8794 Hub API, 8795 Host Agent); cross-host calls are `ssh` plus a `hub-client.mjs relay` on the peer, never bare curl; a Resource's `host` is the key `linux` or `mac`; forwards carry `X-Hub-Forwarded` and the resolved record; waiting `POST /leases` carries a client-minted id.
- **Registry (AD-27 to AD-31):** `<HUB_LOCK_DIR>/registry.json` mode 0600, `{format: 1, rev, resources, pools}`, one writer (the Hub API), `if_rev` conflicts, unreadable file never overwritten; immutable ids and locks, one `RESERVED` list in `lock.mjs`, `res-<slug>[-<n>]` ids; `isQueued` by name only (`res-*`, `emulator-<n>`); seeding from `devices.json` each start and from `qa-devices.json` on first creation, never importing `allowed_users`; retirement stored, visibility computed.
- **Resolution and matching (AD-32, AD-33, AD-34):** only big-chungus reads `registry.json`; off-host resolution asks the Hub API or falls back to the in-memory seed; one pure matcher; Pool requests write one identical ticket per member and the winner withdraws the rest; `extendLease` reads every queue a Resource is served from.
- **Reachability (AD-35):** one enum, one mapping function, read-only transports only (adb wire `host:version`, `host:devices-l`, `host:track-devices-l`; `devicectl` on the Mac), ages computed on the reader's clock, a failed host marked unreachable, `unauthorized` keeps exit 75.
- **Leases and waits (AD-36, AD-37, AD-38):** API Leases are lock-only, `holderPid: null`, with `claimantKind` and `actor`; waits are bound to the connection; `forceRelease`, `cancelRequest` and the `extendLease` override are `lock.mjs` functions; a Job Hold is never force-released.
- **Event Log (AD-39, AD-40, AD-49):** new event names (`registry-add|edit|retire`, `reachability`, `host-reachability`, `prune`, `force-release`), `resource` on every hold event, event ids derived from offsets, `readEventsFrom` cursor reader; remote history is a byte-identical replica filled by the single Host Agent push message.
- **Status and stream (AD-41, AD-43, AD-44):** one `statusView` builder with `local` and `service` audiences (QA serials nulled for `service`); Candybar SSE wire; change-driven `fs.watch`; reads and waits never block the event loop.
- **Contract (AD-42):** `docs/hub-api-contract.md` with a `Status:` line, exactly the AD-42 route table, problem+json errors, additive only, enforced by a contract test.
- **Lifecycle (AD-45, AD-46):** systemd user unit `mobile-deploy-hub-api.service` (`KillMode=mixed`) and the Mac LaunchAgent `sh.delo.mobile-deploy-hub.host-agent` (never the catch-up's label, no `StartInterval`), both run from `releases/<ref>` with the install-time Node path and switch only at `hosts:install`; emulators boot through `heavy`; strict `registry` and `api` blocks in `policy.json`.
- **Tests (NFR-5):** `hermetic()` from `tools/ci/test-fixtures.mjs`, injected `fetchImpl`, `sshImpl`, `watchImpl`, `qaDevices`, `hostKey`, `processStart` and `policy` seams; services are tested by calling their handlers.
- **Release process (hub policy):** each ship story is `mise run release -- X.Y.Z` from a clean clone of main, then `mise run hosts:install` on the hosts named; every app's strict dry run stays green; Node 24 and Node 26 checks stay green.

### UX Design Requirements

None. v1b has no user interface; the Control Surface is v1c.

### FR Coverage Map

| Requirement | Epic | Stories |
| --- | --- | --- |
| FR-13 (no regression, read-only status) | Epic 5, every later epic | 5.1, 5.4, 5.9; ship stories |
| FR-22 (same semantics) | Epic 5, Epic 7 | 5.1, 7.1 |
| FR-3 (seed, in-memory then stored) | Epic 5, Epic 6 | 5.5, 6.3 |
| FR-29 (deploy targets visible) | Epic 5, Epic 6, Epic 8 | 5.5, 6.5, 8.1 |
| FR-5 (Reachability) | Epic 5, 6, 8, 9 | 5.4, 6.10, 8.3, 9.2, 9.6 |
| FR-4 (discovery) | Epic 5, Epic 6 | 5.6, 6.10 |
| FR-6 (capability requests, `phone` queues) | Epic 5, Epic 7 | 5.7, 5.8, 7.1 |
| FR-31 (v1b part) | Epic 5, Epic 7 | 5.9, 7.3 |
| FR-1 (register) | Epic 6 | 6.6, 6.8, 6.9 |
| FR-2 (edit, retire) | Epic 6 | 6.7 |
| FR-17 (v1b events) | Epic 6, 7, 8, 9 | 6.1, 6.3, 6.7, 6.10, 7.5 to 7.8, 8.3, 9.6 |
| FR-10 (Leases through the API) | Epic 7 | 7.1 to 7.4 |
| FR-23 (also) | Epic 7 | 7.2 (SIGTERM and re-queue) |
| FR-11 (cancel, force-release) | Epic 7 | 7.5 to 7.8 |
| FR-21 (endpoints, contract) | Epic 6 to Epic 10 | 6.4, 6.5, 7.9, 8.7, 10.4 |
| FR-14 (live status, stream) | Epic 8, Epic 9 | 8.1, 8.4, 8.5, 9.5 |
| FR-23 (survive restarts) | Epic 6, Epic 8 | 6.11, 8.6 |
| FR-12 (rest: `ios-lane`, Mac Host Agent) | Epic 9 | 9.1 to 9.8 |
| FR-18 (history, utilisation) | Epic 10 | 10.1 to 10.3 |
| NFR-1, NFR-2 | all | every story (AD-1, AD-2, AD-25 conformance in 5.1) |
| NFR-3 | Epic 8, Epic 9 | 8.5, 9.5 (no-timer conformance), 9.7 |
| NFR-4, NFR-5 | all | every story |
| NFR-6 | Epic 6, Epic 9 | 6.4, 9.1 |
| NFR-7 | Epic 8 | 8.2 |
| NFR-8 | Epic 9 | 9.5, 9.6 |

Out of v1b by the PRD's own split: FR-19, FR-20 (Capacity Estimate, starvation signal) and FR-24 to FR-28 (Control Surface) are v1c. FR-7 to FR-9, FR-15, FR-16, FR-30 shipped in v1a.

## Epic List

Numbering starts at 5 so sprint keys never collide with v1a's epics 1 to 4.

### Epic 5: Agents can tell which phone is free, and wait in line for one

Without any new service, an agent running `hub-device` sees each Resource's Reachability, which phone deploys install to, and which devices are visible but unregistered. It can ask for a phone by Capability, and `phone` now holds a place in line instead of failing. The CLI is rebuilt on one Claims library that the later services share.
**FRs covered:** FR-3 (in-memory), FR-4, FR-5, FR-6, FR-13, FR-22, FR-29, FR-31
**Decisions:** AD-24, AD-25, AD-28, AD-29, AD-30, AD-33, AD-34, AD-35, AD-47

### Epic 6: Jarad registers a device and every agent can use it

Jarad pairs a new phone and registers it through the Hub API with a name, kind and Capabilities. Within a minute any agent can lease it, `phone` includes it, and no hub release is needed. The Hub API runs as an always-on user service on big-chungus with the first slice of its contract.
**FRs covered:** FR-1, FR-2, FR-3, FR-4, FR-5, FR-17 (Registry and Reachability events), FR-21 (Registry routes, health), FR-23 (singleton), FR-29
**Decisions:** AD-23, AD-26 (same host), AD-27, AD-28, AD-29, AD-30, AD-31, AD-35, AD-39, AD-42, AD-44, AD-45, AD-46

### Epic 7: Leases through the API, cancel and force-release

Agents and people take, wait for, extend and release Leases through the Hub API with the same semantics as the CLI. A stuck request can be cancelled and a stuck Lease, Reservation or emulator slot force-released with a recorded actor and reason, while a Job Hold can never be ended from outside its run.
**FRs covered:** FR-6 (API), FR-10, FR-11, FR-21 (Hold routes), FR-22, FR-31
**Decisions:** AD-24, AD-36, AD-37, AD-38, AD-48 (local part)

### Epic 8: See every hold and waiter live

The Hub API serves one status document and a live stream of every Resource's Reachability, Hold and Queue, never blocking, and survives its own restarts without losing a Hold, Reservation or Registry entry.
**FRs covered:** FR-5 (live), FR-14, FR-21 (`/status`, `/stream`), FR-23, FR-29
**Decisions:** AD-23, AD-35, AD-41, AD-43, AD-44, AD-45

### Epic 9: The iPad and the Mac, from big-chungus

The Mac runs its own Host Agent. From big-chungus, `hub-device lease ipad` and `lease mac` take the one `ios-lane`, the Mac's lane and Reachability show in the API, and an asleep Mac reads `offline` and fails Leases at once. The agent only pushes changes.
**FRs covered:** FR-5 (Mac), FR-12 (rest), FR-14 (Mac), FR-21
**Decisions:** AD-25, AD-26, AD-32, AD-35, AD-41, AD-45, AD-47, AD-48, AD-49

### Epic 10: Ask what happened, on either host

The Hub API answers history and utilisation questions over both hosts' Event Logs, marks the gaps when the Mac was away, and the whole v1b contract is frozen and leak-tested. v1c builds the capacity numbers and the page on this.
**FRs covered:** FR-18, FR-21
**Decisions:** AD-39, AD-40, AD-42, AD-49

**Dependencies:** each epic builds on the ones before it and works without the ones after it.
- Epic 6 uses Epic 5's Claims library, matcher, `RESERVED` list and status builder.
- Epic 7 uses Epic 6's service and Registry.
- Epic 8 uses Epic 7's Holds and Epic 6's Reachability cache.
- Epic 9 uses Epic 6's service, Epic 7's routes (forwarded) and Epic 8's `/status` and stream.
- Epic 10 uses Epic 9's push message and Epic 6's event vocabulary.
- The deploy path (`tools/ci/commands/*`, `tools/catchup/*`) depends on none of them (AD-25).

**File-churn check.** `lock.mjs` and `claims.mjs` are touched by Epics 5, 6, 7 and 9. This is meaningful overlap on one component, and the split is kept for risk and feedback reasons, not file isolation: Epic 5 ships with no service (rollback is a `hosts:install` of the previous tag), Epic 6 introduces the first long-lived process, Epic 7 adds the only destructive operators (force-release), and Epic 9 adds the only cross-host dependency. Each ship in between is real user value (a queueing `phone`, a registered phone, API Leases, a live board feed, the iPad lane), and a spine change after any of them would not invalidate the later epics.

---

## Epic 5: Agents can tell which phone is free, and wait in line for one

Everything in this epic runs inside `hub-device` and the lock library, with no service. It ships as its own hub release (Story 5.10). The deploy path never imports anything new (AD-25).

### Story 5.1: One Claims library under an unchanged CLI

As the hub maintainer,
I want resolve, take, release, extend and the error table to live in one library the CLI calls,
So that the Hub API and Host Agent that come later cannot take, refuse or report the same action differently (FR-13, FR-22, AD-24).

**Acceptance Criteria:**

**Given** a new `tools/device/claims.mjs`
**When** it is imported
**Then** it exports `resolve` (word or id to Resource, id first), `take` (Lease, phone, emulator), `release`, `extend`, `newLeaseId`, the bounds checks (48 h, the 60 min deploy-target cap) and the code-to-exit table as exported data (`HUB_DEVICE_AWAY` 75, busy 76, usage 2, the rest as today)
**And** `hub-device.mjs` keeps only argument parsing and output, and `takeLease` and `takeAnyPhone` are gone from it.

**Given** the existing suites (`hub-device.test.mjs`, `lease.test.mjs`, `emulator.test.mjs`)
**When** the suite runs after the move
**Then** every one passes unchanged, with no assertion edited, and `status` still writes nothing to the lock dir or the Event Log (FR-13).

**Given** a Lease taken through `claims.take` and the same through the CLI
**When** both run against one temp lock dir
**Then** they produce the same Hold, the same refusal reasons, the same exit codes and the same events (FR-22).

**Given** a conformance test
**When** it scans `tools/ci/commands/*.mjs` and `tools/catchup/*.mjs`
**Then** it fails if any imports `claims.mjs`, `tools/registry/*`, `tools/hub-api/*`, `tools/host-agent/*` or `hub-client.mjs`, and the list is a data table later stories extend (AD-25).

### Story 5.2: One reserved-word list, one slug rule, `res-*` locks queue

As Jarad,
I want one list of words and lock names that can never be registered, and every lock the Registry will mint to queue from its first use,
So that a new phone can never collide with a CLI word or sit on a bare lock (AD-28, AD-29).

**Acceptance Criteria:**

**Given** `lock.mjs`
**When** it is imported
**Then** it exports `SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/` (1 to 32 characters) and one frozen `RESERVED` list holding the CLI words (`phone`, `emulator`, `adb`, `s24`, `s26`, `ipad`, `mac`, `mac-ios`), every internal lock name, `s3-*`, `emulator-<n>`, `emulator-reaper`, `registry`, `hub-api`, `host-agent`, and the id shapes `res-*`, `l-*`, `e-*`, `job:*`
**And** `devices.mjs` and the CLI check names against that list, with `devices.mjs`'s own reserved-word array deleted.

**Given** `isQueued(name)`
**When** it is called with a v1a `QUEUED` name, `emulator-<n>` or `res-<slug>`
**Then** it is true, and it never reads `registry.json`
**And** a bare name is false, and `res-<28-char slug>-999` still passes.

**Given** a hold event on a lock
**When** it is appended
**Then** it carries additive `resource: <id>` from a pure `resourceOf(lock)` (the seed map: `adb` to `s26`, `s24`, `mac-ios` to `ios-lane`, `emulator` and `emulator-<n>` to the emulator Pool, or the `res-*` lock itself)
**And** a test fails if `resourceOf`'s seed map and `DEPLOY_TARGETS` differ from what `devices.json` derives.

**Given** an old pinned reader
**When** it reads an owner or event carrying `resource`
**Then** it ignores the field (AD-2, additive), asserted by a v1.2.46-shape fixture.

### Story 5.3: A host knows its own key

As the hub maintainer,
I want each host to know whether it is `linux` or `mac` from a file `hosts:install` writes,
So that "is this action local?" has one answer and another machine never believes it is big-chungus or the Mac (AD-47).

**Acceptance Criteria:**

**Given** `claims.mjs`
**When** `hostKey()` is called
**Then** it reads `~/.config/mobile-deploy-hub/host-key` behind a seam and checks it against `{linux: 'linux', mac: 'darwin'}`
**And** a missing file or a mismatch throws `HUB_HOST_UNKNOWN` (exit 1) naming the file and `hosts:install`.

**Given** `tools/hosts.mjs`
**When** `hosts:install` runs for a host
**Then** it writes that host's key to the file, with the existing dry-run and readback behaviour unchanged
**And** a hermetic test asserts the file's content for each host block without writing outside a temp home.

**Given** a Resource record with `host: 'mac'`
**When** `claims.isLocal(record)` runs on `linux`
**Then** it is false, and `record.host === hostKey()` is the only test any front door applies.

**Given** `devices.json`
**When** this story lands
**Then** it is unchanged.

### Story 5.4: Status through one builder, with Reachability

As an agent,
I want `hub-device status --json` to say whether each Resource is reachable, unauthorized, offline, absent or unknown, and how old that reading is,
So that I never mistake "nobody checked" for "reachable" (FR-5, FR-13, AD-35, AD-41).

**Acceptance Criteria:**

**Given** a new `tools/registry/reachability.mjs`
**When** it maps presence
**Then** adb `device` is `reachable`, `unauthorized` is `unauthorized`, `offline` is `offline`, not listed is `absent`, and `no adb server`, `adb did not answer` or anything else is `unknown`, in one function with a table test
**And** the iPad maps from `pickIpad`'s result, never from `tunnelState`: UDID not listed is `absent`, listed without live hardware details `unknown`, unpaired or Developer Mode off `unauthorized`, not booted `offline`, otherwise `reachable`, and a devicectl failure or timeout is `unknown`.

**Given** `statusView(hostKey, {audience: 'local'})` in `claims.mjs`
**When** it is built
**Then** it walks the disk (seeded locks, every `res-*` and `emulator-<n>` lock, queue or reservations dir, the emulator gate), never a service and never `registry.json`
**And** its root keys and every v1a value are exactly today's, with additive `resource` and `reachability` on each row (`{state, checked_at, age_ms}`); `presence` stays beside it.

**Given** a reading
**When** it is read
**Then** `stale` is derived from its age on the reader's clock and never stored, a reading missing or older than `registry.reachability_max_age_s` is shown with its age and never as current, and `status` starts no refresh and no adb server.

**Given** the phone transport
**When** status reads it
**Then** it uses only the read-only wire (`host:version`, `host:devices-l`) or `adb -L tcp:127.0.0.1:<port>` after matching versions, never `findPhone`, and a fake `exec` shows no `start-server`, `connect` or mdns argv.

**Given** an `unauthorized` phone
**When** `lease` is attempted
**Then** it still exits 75, as `hub-device.test.mjs:403-411` pins.

**Given** `status`
**When** the hermetic suite runs it
**Then** the Event Log and lock dir are byte-identical before and after.

**And** `policy.json` gains the strict `registry: {reachability_max_age_s: 60}` block with `policy.mjs` rejecting unknown or missing keys (AD-46).

### Story 5.5: Deploy targets are marked, from the committed declarations

As an agent,
I want status to say which phone deploys install to, with its Hold and Queue,
So that I do not lease the deploy target by mistake, and know whether it is free (FR-29, FR-3, AD-30).

**Acceptance Criteria:**

**Given** a new `tools/registry/seed.mjs` under `tools/registry/` (not `tools/ci`, because `hub-device.test.mjs:332-343` forbids `android_extra` there)
**When** `seed(devices, {qaDevices})` is called
**Then** it derives in memory the deploy targets (Android to lock `adb` as `s26`, iOS to `mac-ios` as `ios-lane` with words `ipad` and `mac`), the extra phones (`s24`, lock `s24`) and the emulator Pool, with fixed ids, locks and names (AD-28)
**And** a test asserts `lock.mjs`'s `DEPLOY_TARGETS` equals the set derived from `devices.json`.

**Given** `status --json`
**When** it lists a seeded Resource
**Then** the row has additive `deploy_target: true|false`, so `s26` and `ios-lane` are marked and `s24` and the emulator slots are not
**And** the existing nine-line text fixture is unchanged, with deploy targets annotated only in `--json` and in a text line printed when a deploy target is held or waited on.

**Given** the private QA file
**When** the seed reads it
**Then** it goes through a `qaDevices` loader seam, `hermetic()` points that seam at a temp file, and a test asserts the real `~/.config/mobile-deploy-hub/qa-devices.json` is never opened
**And** each phone it names gets Capability `dedicated_qa`, and `allowed_users` is never imported.

**Given** the `phone` Pool seed
**When** it is declared
**Then** it is the named list `[s24, s26]` in `PHONE_POOL_SEED`, and the S24 stays first and is exempt from the `dedicated_qa` exclusion (open question Q1: FR-3 wins, reversible by that one constant and one flag in `match.mjs`).

**Given** local status on the owning host
**When** a `dedicated_qa` phone is listed
**Then** it keeps every v1a key and value (AD-17); redaction applies only to the `service` audience, which the Hub API's status document introduces.

### Story 5.6: Discover unregistered devices from the CLI

As Jarad,
I want `hub-device discover` to list phones visible to the hub's adb server that no Resource names,
So that I know what I can register next (FR-4, AD-35).

**Acceptance Criteria:**

**Given** `reachability.mjs`
**When** `discover({seed})` runs
**Then** it lists devices from `host:devices-l` on the hub's adb server port whose serial no seeded Resource names, with model and serial
**And** it queries only that port and prints which one it used.

**Given** a device listed only as `host:port` (wireless debugging)
**When** it is listed
**Then** its serial is read over the wire with a read-only `ro.serialno` query, and an unreadable one is listed with `serial: null` and its `host:port`.

**Given** no adb server is running
**When** `discover` runs
**Then** it prints `no adb server` and exits 0 with an empty list, never starting one, and a fake `exec` proves no `start-server` or `connect` argv.

**Given** `--json`
**When** it is used
**Then** the shape is `{format: 1, port, devices: [{serial, model, id, state}]}`, additive only.

**Given** the Mac
**When** `discover` runs there
**Then** it says discovery of the iPad is by `devicectl` and lists no Android devices (the Mac's adb is not the hub's), with the iPad listed only if its UDID is not seeded.

### Story 5.7: Ask for a phone by Capability

As an agent,
I want `hub-device lease --match api_level>=34` to find a free, reachable phone that fits,
So that I do not guess from `devices.json` (FR-6, AD-33).

**Acceptance Criteria:**

**Given** a new pure `tools/registry/match.mjs`
**When** `match(registry, request, policy)` is called
**Then** it is the only matcher, taking equality for strings and booleans and `>=` and `<=` for numbers, with the CLI form `--match key=value[,key>=n]`
**And** a Pool is a seeded named list in preference order or a Capability query, and a query excludes retired and `dedicated_qa` Resources unless the request names one or asks for `dedicated_qa`; a seeded named list ignores the exclusion (Q1).

**Given** a request whose `for_ms` exceeds a deploy target's 60 min cap
**When** `match` runs
**Then** it drops that target from the candidates (AD-33).

**Given** no registered Resource matches
**When** `lease --match` runs
**Then** it fails at once with `HUB_NO_MATCH` (exit 2) and a `reason` naming why, and never waits.

**Given** every match is `offline`, `absent` or `unauthorized`
**When** it runs
**Then** it fails at once with `HUB_DEVICE_AWAY` (exit 75).

**Given** candidates on more than one host key
**When** `match` runs
**Then** the request is refused `HUB_POOL_CROSS_HOST` (exit 2).

**Given** at least one reachable free match
**When** the request runs
**Then** it takes it with the same exports as `lease <word>` (this story keeps today's one-pass-per-member try and holds no place in line).

**Given** the hermetic suite
**When** it runs
**Then** a table test covers each operator, the QA exclusion, the cap drop and each refusal.

### Story 5.8: `phone` holds a place in line

As an Earshot QA agent,
I want `hub-device lease phone --wait` to queue for the first phone that frees and show my position,
So that I stop retrying by hand when both phones are held (FR-6, UJ-2, AD-33, AD-4).

**Acceptance Criteria:**

**Given** `lock.mjs`
**When** a Pool request is made
**Then** it writes one ticket of the same file name, carrying `pool` and `request`, into every candidate's queue, takes the first that serves it, and only the winner withdraws its other tickets (rename to a tomb, then remove) with no event of their own
**And** the Event Log gets one Pool-level `request` and exactly one `acquire`, `timeout` or `cancel` (AD-4), the same sequence v1a's tries wrote.

**Given** a request that finds itself holding two members
**When** it detects it
**Then** it releases the later one with `reason: pool-duplicate`.

**Given** a cancel or abort of a Pool request
**When** it runs
**Then** it withdraws its ticket from every member.

**Given** the Pool request's ETA
**When** it is computed
**Then** it is the earliest member's range (`lo = min lo_i`, `hi = min hi_i`, `low_data` if any member is), via `eta.mjs` (AD-18).

**Given** the `phone` word
**When** several phones are free
**Then** it still prefers the S24, and when none is free it now holds a place in line and prints `HUB_LOCK_WAIT` with position and ETA on stderr, keeping its exit codes and messages
**And** the changed `phone` ordering assertions in `hub-device.test.mjs:253-312` are updated and named in the change as the intended text change (FR-13).

**Given** `status`
**When** a Pool request is waiting
**Then** it is listed once, with `request`, `pool` and `positions: {<lock>: n}`, not once per member.

**Given** the hermetic suite
**When** it runs
**Then** it covers a Pool request served by each member, the withdrawal race, a killed waiter whose tickets are pruned by pid, and the emulator gate keeping its own queue.

### Story 5.9: No extension while a Pool or gate waiter sits behind

As a waiter in a Pool request,
I want a Lease that blocks me to be unextendable even though my ticket sits in another member's queue,
So that a Pool or emulator waiter is never starved by an extension (FR-31, AD-34, AD-16).

**Acceptance Criteria:**

**Given** `extendLease`
**When** it checks for waiters
**Then** it reads the Resource's own queue (including Pool tickets) and, for an `emulator-<n>` slot, the `emulator` gate queue
**And** it ignores a ticket whose `lease_id` is the extender's own and a Pool ticket whose request already holds a member.

**Given** `queueView`
**When** a Pool request sits in several member queues
**Then** it counts it once per member queue and marks it `pool`, so status lists it once.

**Given** an extension refused for a Pool waiter
**When** it is reported
**Then** `HUB_LEASE_EXTEND_REFUSED` names every waiter with its position, as v1a does.

**Given** the hermetic suite
**When** it runs
**Then** it covers a Lease on `s24` extended while a `phone` request waits (refused), the same request already holding `s26` (allowed), and an emulator slot extended while the gate has a waiter (refused).

### Story 5.10: Ship the CLI release

As Jarad,
I want Epic 5 out on both hosts,
So that every agent gets the Reachability field, `--match` and a queueing `phone` now (NFR-2).

**Acceptance Criteria:**

**Given** stories 5.1 to 5.9 are on main
**When** `mise run check` runs on Node 24 and Node 26
**Then** it is green, and the `tools/device/*.test.mjs` suites pass except the named intended changes (the `phone` ordering and wait line).

**Given** `mise run release -- X.Y.Z`
**When** it completes
**Then** every app's strict dry run is green, `v1` has moved, and `mise run hosts:install` has run from a clean checkout at the tag on big-chungus and on the Mac (operator actions), writing each host's `host-key`.

**Given** the first real deploy and the next `hub-device status --json` on each host
**When** they run
**Then** the deploy takes `adb` or `mac-ios` as before, the status carries `reachability` and `deploy_target`, and an older pin's bare `mkdir` still sees only locks it understands.

**Given** the release notes
**When** they are published
**Then** they state that nothing in this release is a service, and that rolling back is `hosts:install` of the previous tag.

---

## Epic 6: Jarad registers a device and every agent can use it

The Hub API arrives as the Registry's only writer. Story 6.9 is the payoff: a phone registered through the API is holdable by `hub-device` within 60 seconds with no hub release. Stories 6.1 to 6.3 need no service; 6.4 onward are the service.

### Story 6.1: Event Log vocabulary for Registry, Reachability and prune

As an analyst reading history,
I want Registry changes, Reachability changes and prunes to be logged once, with ids I can resume from,
So that the stream, the replica and history can follow the log without guessing (FR-17, AD-39).

**Acceptance Criteria:**

**Given** `lock.mjs`
**When** it is imported
**Then** it exports `noteRegistry` and `noteReachability`, which append through the existing `appendEvent` bypassing the Queued gate, so `lock.mjs` stays the only `appendEvent` caller (AD-9) and a conformance test finds none elsewhere.

**Given** the new names `registry-add`, `registry-edit`, `registry-retire`, `reachability`, `host-reachability`, `prune` and `force-release`
**When** an event is written
**Then** it carries additive `resource: <id>`, `reachability` has `{resource, from, to, checked_at, reason}`, `host-reachability` has `{host, from, to, reason}`, and `actor: {holder, via}` and `why` are allowed on any event
**And** `registry-*` events record `resource`, `lock` and the changed capability keys, never `identity`.

**Given** a prune of tickets or Reservations
**When** one call prunes more than 20
**Then** it writes at most 20 `prune` events and folds the rest into one with `count`, each removal using `unlinkSync`, and a write failure is `HUB_EVENT_LOG_FAILED`, never fatal.

**Given** `events.mjs`
**When** `readEventsFrom({month, offset})` is called
**Then** it returns only complete lines (up to the last `\n`) and the new end offset, and an event id `<host_id>/<YYYY-MM>/<byte offset>` is derived on read, never written
**And** bytes already written are never rewritten, and a hermetic test appends concurrently while reading and sees no torn line.

**Given** an old pinned reader
**When** it reads a log with the new names
**Then** it skips them, asserted by a fixture.

### Story 6.2: The Registry store has one writer

As the hub maintainer,
I want `registry.json` written by exactly one process with revision checks,
So that two edits cannot race and a rollback cannot overwrite newer records (FR-2, AD-27).

**Acceptance Criteria:**

**Given** `lock.mjs`
**When** this story lands
**Then** it exports its atomic helper (tmp plus rename), and `tools/registry/store.mjs` writes only through it.

**Given** `<HUB_LOCK_DIR>/registry.json`
**When** the store writes it
**Then** it is mode `0600`, `{format: 1, rev, resources: [], pools: []}`, serialised in-process, and every write names the `rev` it read as `if_rev`; a mismatch is `HUB_REGISTRY_CONFLICT` (409, exit 1) and `rev` rises by one per write.

**Given** a missing file
**When** a reader (`hub-device`, the Claims library) loads the Registry
**Then** it gets the in-memory seed (Story 5.5), read from disk fresh each call.

**Given** an unparsable file or an unknown `format`
**When** it is read
**Then** the reader falls back to the seed with one `HUB_REGISTRY_FORMAT` warning
**And** every write, the seed write included, is refused `HUB_REGISTRY_FORMAT` (409, exit 1), and the file is never written, so an older Hub API cannot overwrite newer records.

**Given** a write that renamed but crashed before its event
**When** the next start compares `rev` with the last logged `rev`
**Then** it appends one `registry-edit` with `reason: recovered` (the rename is the deciding step, AD-27).

**Given** the hermetic suite
**When** it runs
**Then** it covers two concurrent writers (one conflicts), a half-written temp file ignored by readers, and mode `0600`.

### Story 6.3: Seed at start, import QA phones on first creation

As Jarad,
I want the Registry to import `devices.json` at every start and the QA phones once,
So that existing `hub-device lease s24|s26|phone|emulator` behave as before while hand-registered Resources are kept (FR-3, AD-30).

**Acceptance Criteria:**

**Given** a Hub API start (or a direct `seed.apply` in a test)
**When** it seeds
**Then** it does one `if_rev` write, only when the derived seed differs, and appends `registry-add` or `registry-edit` only for the records that changed
**And** a seeded Resource's identity, lock, name and `deploy_target` are overwritten each start while its Capability edits are kept.

**Given** a seeded Resource missing from the new `devices.json`
**When** the next start runs
**Then** it is kept and marked `seed_missing: true`, shown only while held or queued, new takes are refused `HUB_RESOURCE_RETIRED` with `reason: seed-missing`, and it is never deleted.

**Given** `registry.json` is first created (and in the in-memory fallback)
**When** the QA file names a phone
**Then** it gets Capability `dedicated_qa`, and a phone absent from `devices.json` is added as a runtime Resource (`res-<slug>`, `seeded: false`) with its serial
**And** `allowed_users` is never imported, and a later start does not re-read the QA file.

**Given** the hermetic suite
**When** it runs
**Then** the `qaDevices` seam is a temp file, the real path is never opened, no committed file contains a QA serial, and a test walks every `registry-*` event for one.

**Given** a re-seed
**When** a record has `retired_at`
**Then** it is never cleared (AD-31).

### Story 6.4: The Hub API runs, answers `/health` and has a contract

As Holocene's future author,
I want a documented Hub API that I can see is alive,
So that I code against a contract, not against handlers (FR-21, AD-42, AD-45, AD-46).

**Acceptance Criteria:**

**Given** `tools/hub-api/server.mjs`
**When** it starts
**Then** it binds `127.0.0.1:<api.hub_api_port>` (8794) only, asserts Node >= 24.15 and `heavy` on PATH, and exits with `HUB_API_ALREADY_RUNNING` (exit 1) on `EADDRINUSE`, with no lock-dir singleton
**And** it logs `HUB_API_LISTEN port=<n>` and, on stop, `HUB_API_STOP`.

**Given** `policy.json`
**When** this story lands
**Then** it gains the strict `api: {hub_api_port: 8794, host_agent_port: 8795, stream_keepalive_s: 15, peer_connect_timeout_s: 5}` block, and `policy.mjs` refuses unknown keys and `stream_keepalive_s` above 30.

**Given** `GET /health`
**When** it is called
**Then** it returns `{ok, service, contract, hub_version, ports, registry: ok|unreadable}` (a superset of FR-21's `{ok, service}`), with `hub_version` from `hubRef` (AD-10)
**And** every response is `Cache-Control: no-store`, bodies are `snake_case` JSON, and errors are `application/problem+json` `{type, title, status, detail}` plus `code`, `exit` and `reason`.

**Given** `docs/hub-api-contract.md`
**When** this story lands
**Then** it has a `Status:` line with the contract version, no path prefix, the route table so far, dated additive annotations, and a note proposing module id `mobile-deploy-hub` and `MOBILE_DEPLOY_HUB_API_URL` for v1c as non-binding (open question Q3)
**And** a `node --test` contract test parses the markdown field lists and asserts exact key sets against handler output, and fails when a route exists in code but not in the document or the reverse.

**Given** the shared suite
**When** it tests the service
**Then** it calls handlers with injected seams and binds no real port, and a conformance test finds no `setInterval` or `setTimeout` loop outside the files AD-19 names.

### Story 6.5: Read the Registry through the API

As an agent,
I want `GET /resources` to list every Resource with its Capabilities and deploy-target mark,
So that I can tell what exists and which phone deploys install to without running a CLI (FR-29, FR-21, AD-30, AD-31).

**Acceptance Criteria:**

**Given** `GET /resources`, `GET /resources/<id>` and `GET /pools`
**When** they are called
**Then** they return the Registry record shape (`id`, `lock`, `name`, `kind`, `host`, `identity`, `capabilities`, `deploy_target`, `seeded`, `seed_missing?`, `created_at`, `retired_at?`) and Pools with their members in preference order, the `phone` Pool computed by Story 5.7's matcher.

**Given** a retired Resource
**When** it is neither held nor queued
**Then** it is hidden; when held or queued it shows as `retiring` (visibility computed at read time, AD-31).

**Given** a `dedicated_qa` Resource
**When** the API serves it
**Then** `identity.serial`, `identity.udid` and any adb id are `null`, keys are never removed, and `allowed_users` never appears
**And** a test walks every key path of every response for a QA serial.

**Given** an unknown id
**When** it is requested
**Then** the answer is a problem+json 404 with `code` and the matching `exit`.

**Given** the contract doc
**When** this story lands
**Then** it lists these routes with exact field lists, and the contract test passes.

### Story 6.6: Register a Resource through the API

As Jarad,
I want to register a Pixel with a name, kind and Capabilities,
So that agents can use it with no hub release (FR-1, UJ-3, AD-28).

**Acceptance Criteria:**

**Given** `POST /registry/resources` with kind, name, host, identity and Capabilities
**When** it succeeds
**Then** the Resource gets `id = lock = res-<slug>` (or `res-<slug>-<n>`, the smallest `n >= 2`, when any record, retired included, already uses it), one `registry-add` event is appended with the new `rev`, and the response is the resulting record and `rev`
**And** a `kind: phone` record requires `identity.model` (`findPhone` checks it).

**Given** a duplicate serial or UDID among non-retired Resources
**When** it is registered
**Then** it is refused with the holder's id; a retired identity may be registered again as a new Resource.

**Given** a name that is in `RESERVED`, collides with an existing record (retired included) or breaks `SLUG`
**When** it is registered
**Then** it is refused with a machine-readable reason and exit 2; seeded Resources are exempt.

**Given** an `actor` absent from the body
**When** the request arrives
**Then** the first front door sets `actor: {holder, via: 'api'}` once and nothing rewrites it.

**Given** a stale `if_rev`
**When** it is sent
**Then** the answer is `HUB_REGISTRY_CONFLICT` with the current `rev`.

**Given** the hermetic suite
**When** it runs
**Then** it covers minting, both refusals, the model rule, the `rev` race, and that no `registry-add` event contains `identity`.

### Story 6.7: Edit and retire a Resource

As Jarad,
I want to rename a Resource, change its Capabilities and retire one,
So that the Registry matches the hardware (FR-2, AD-31).

**Acceptance Criteria:**

**Given** `POST /registry/resources/<id>` with `if_rev`
**When** it edits `name` or Capabilities
**Then** it applies, appends `registry-edit`, and refuses any change to `id`, `lock`, `host` or `identity` (immutable, AD-28), and names stay unique across every record, retired included.

**Given** `POST /registry/resources/<id>/retire`
**When** the Resource is held
**Then** the Hold does not end, `retired_at` is set, waiters already queued are served normally, and `registry-retire` is appended
**And** the Claims library refuses every new take on it with `HUB_RESOURCE_RETIRED` (409, exit 2), whichever front door asked, and the Resource leaves the visible set when the Hold ends.

**Given** a seeded Resource
**When** it is retired, or its identity is edited
**Then** it is refused `HUB_REGISTRY_SEEDED` (409, exit 2) (a hub release changes it).

**Given** a retired Resource
**When** a later start re-seeds
**Then** it stays retired and in the file and log.

**Given** the contract doc and test
**When** this story lands
**Then** both include these routes.

### Story 6.8: Registry verbs in `hub-device`, and a clear message when the API is down

As Jarad,
I want `hub-device registry add|edit|retire|list` to work from the shell,
So that I can register a phone without a browser, and am told plainly when the service is down (FR-1, FR-2, AD-17, AD-27).

**Acceptance Criteria:**

**Given** a new `tools/hub-client.mjs`
**When** it makes a same-host call
**Then** it uses `fetch` to loopback with an injected `fetchImpl` and bounds the call at the request's wait plus 30 s, and cross-host transport is outside this story.

**Given** `hub-device registry add --kind phone --name pixel --model "Pixel 9" --cap api_level=35`
**When** the API answers
**Then** it prints the new id and `rev` as `HUB_DEVICE_*` lines and exits 0, and `--json` prints the response.

**Given** the connect is refused or `/health` gives no answer within 2 s
**When** a registry write is attempted
**Then** it fails with `HUB_API_DOWN` (exit 1): "the Hub API is not answering; registry changes are unavailable, holds still work"
**And** a write that timed out after its body was sent fails `HUB_API_UNKNOWN` (exit 1), because it may have applied.

**Given** the API is down
**When** `hub-device lease s24` runs
**Then** it still works and the Lease shows in the API when it returns (FR-13).

**Given** `registry list`
**When** it runs
**Then** it reads `registry.json` from disk on big-chungus and needs no service.

**Given** the new verbs
**When** the CLI suites run
**Then** every existing command, exit code and `--json` shape is unchanged (AD-17).

### Story 6.9: A registered phone is leasable within a minute

As an Earshot QA agent,
I want a phone Jarad just registered to show up in `hub-device status` and be leasable by name and by `phone`,
So that adding hardware needs no hub release (FR-1, SM-3, UJ-3, AD-28, AD-33).

**Acceptance Criteria:**

**Given** a registered `kind: phone` Resource
**When** `hub-device lease <name>` runs
**Then** it resolves the name (id first, then name) from `registry.json`, takes `res-<slug>` as a queued lock, and works within 60 s of registration with no `hosts:install` after the one that shipped this story.

**Given** the `phone` word
**When** a runtime phone on `linux` is not `dedicated_qa` and not retired
**Then** it is a member of the `phone` Pool after `[s24, s26]`, in `created_at` order, with no further edit
**And** a seeded `dedicated_qa` phone stays served only to a request that names it or asks for `dedicated_qa` (query rule); the S24's named-list exemption is unchanged (Q1).

**Given** `hub-device status --json`
**When** it lists the new Resource
**Then** the row has `resource`, `reachability` and `deploy_target: false`.

**Given** a retired Resource
**When** `lease <name>` runs
**Then** it exits 2 with `HUB_RESOURCE_RETIRED`.

**Given** `registry.json` is missing or unreadable
**When** `hub-device` runs
**Then** it resolves from the in-memory seed, with one `HUB_REGISTRY_FORMAT` warning for an unreadable file, and `lease s24|s26|phone|emulator` behave exactly as before (FR-3, FR-13).

**Given** the hermetic suite
**When** it runs
**Then** an end-to-end test registers through the API handler and leases through the CLI against one temp lock dir.

### Story 6.10: Reachability and discovery through the API

As Jarad,
I want the API to say which devices are reachable and which are unregistered,
So that I see a freshly paired Pixel before I register it (FR-4, FR-5, UJ-3, AD-35).

**Acceptance Criteria:**

**Given** `GET /discovery`
**When** it is called
**Then** it lists devices from the hub's adb server port that no non-retired Resource names, with model, serial (the `ro.serialno` read for a `host:port` id) and the port used, reports `no adb server` instead of starting one, and never connects anything.

**Given** `GET /resources` rows
**When** they carry Reachability
**Then** each has `{state, checked_at, age_ms_at_receipt, received_at, source: probe}`, and the reader computes the age as `age_ms_at_receipt + now - received_at`, so host clock skew never makes a reading look fresh.

**Given** a read
**When** the cached reading is missing or older than `registry.reachability_max_age_s`
**Then** it returns the cached reading at once and starts at most one asynchronous refresh per host, so a read never waits for a refresh.

**Given** a reading that differs from the last one the service logged
**When** it is noted
**Then** the Hub API appends one `reachability` event through `noteReachability`, and the CLI never writes one.

**Given** `docs/hub-api-contract.md`
**When** this story lands
**Then** it lists `/discovery` and the Reachability fields, and the contract test passes.

**Given** the hermetic suite
**When** it runs
**Then** a fake adb wire proves only `host:version` and `host:devices-l` are issued.

### Story 6.11: The service runs from a release, and a stop never kills an emulator

As Jarad,
I want the Hub API installed as an always-on user service that survives `hosts:install` and a restart,
So that agents and the page can count on it (FR-23, AD-45).

**Acceptance Criteria:**

**Given** the emulator spawn seam in `emulator.mjs`
**When** an emulator boots on Linux
**Then** it goes through the seam, which wraps it in `heavy` (its own scope under `batch.slice`) when `heavy` is on PATH, and the Hub API refuses to start when `heavy` is absent (so `KillMode=mixed` never kills an emulator).

**Given** `tools/hosts/units/`
**When** this story lands
**Then** it holds `mobile-deploy-hub-api.service` (`Type=simple`, `Restart=on-failure`, `KillMode=mixed`) and `install.sh <ref>`, which renders `@REF@` and `@NODE@` (the real `node/24.x` dir, not the mise symlink)
**And** the service runs from `releases/<ref>` and switches only at `hosts:install`.

**Given** `tools/hosts.mjs`
**When** it installs on big-chungus
**Then** it runs the units installer beside the untouched catch-up installer, enables and restarts the service, and reads `/health` back, retrying for at most 10 s within that one invocation, and fails the step on no answer
**And** it never deletes the release dir a running service uses.

**Given** a restart
**When** the service comes back
**Then** it holds no state beyond what it reads (AD-23): Registry, Holds and Reservations are in the lock dir.

**Given** `hub-device.test.mjs:909-941`
**When** it runs
**Then** it still passes (`install.sh` may only `daemon-reload`).

**Given** the hermetic suite
**When** it runs
**Then** `hosts.mjs` is tested with a fake systemctl and a fake `fetchImpl`, never a real unit.

### Story 6.12: Ship the Registry and the Hub API

As Jarad,
I want the Registry and the service live on big-chungus,
So that I can register a device and every agent sees it (FR-1, FR-3, NFR-2).

**Acceptance Criteria:**

**Given** stories 6.1 to 6.11 are on main
**When** `mise run check` runs on Node 24 and Node 26
**Then** it is green.

**Given** `mise run release -- X.Y.Z`
**When** it completes
**Then** every app's strict dry run is green, `v1` has moved, and `mise run hosts:install` has run from a clean checkout at the tag on big-chungus (operator actions) and, for the `hub-device` and `host-key` change only, on the Mac.

**Given** the service after install
**When** an operator runs `curl 127.0.0.1:8794/health`, `hub-device registry list` and registers a test phone
**Then** the phone is leasable within 60 s, and retiring it removes it from `phone`.

**Given** the first real deploy after this release
**When** it takes `adb`
**Then** it behaves as before and the Event Log shows its events with the new `hub_version`.

**Given** the release notes
**When** they are published
**Then** they state that the deploy path ignores the Registry and the API (AD-25), that a stopped API only disables Registry writes, and that the deploy targets still change only by hub release.

---

## Epic 7: Leases through the API, cancel and force-release

The Hold write routes of the Hub API, built on the Claims library so the CLI and the API cannot drift. Every route here is also served by the Mac's Host Agent in Epic 9 for its own host (AD-42), so each story is written against the library, not the HTTP layer.

### Story 7.1: Take a Lease through the API

As an agent or a person,
I want `POST /leases` to give me a Lease by word, id or Capability match,
So that I can lease without a shell on big-chungus, with the same result as `hub-device` (FR-6, FR-10, FR-22, AD-36).

**Acceptance Criteria:**

**Given** `POST /leases` with `resource` (word or id) or `match`, `for_ms`, `holder`, `why` and `claimant_kind`
**When** the Resource is free
**Then** the Lease is taken by `claims.take`, answers `200` with the resulting Hold, and the Event Log carries `acquire` with `actor: {holder, via: 'api'}`.

**Given** an API Lease
**When** it is recorded
**Then** it has `holderPid: null` and lasts until its `expires_at` or its release, status renders its `holder` and never the service pid, and it is never reclaimed because the service restarted
**And** the service's environment carries no `GITHUB_*` variable, asserted by a test that injects one and finds it in no record.

**Given** a phone Lease through the API
**When** it is taken
**Then** it never calls `findPhone`, has no `adb_id`, and a parity test pins that its exports and record equal `hub-device lease <word> --no-connect` for the same Resource.

**Given** `claimant_kind`
**When** it is `person` or `agent` (default `agent`)
**Then** `acquireLease` records it as given, and `eta.mjs` is unchanged (open question Q2: person history stays separate by kind).

**Given** a request whose Resource is busy, away, retired or unmatched
**When** it is made without a wait
**Then** it returns `409` busy (exit 76), `503` away (exit 75), `409 HUB_RESOURCE_RETIRED` (exit 2) or `404 HUB_NO_MATCH` (exit 2) as the Claims table maps them, in problem+json.

**Given** a Lease on a deploy target longer than 60 min, or any Lease over 48 h
**When** it is requested
**Then** it is refused with the cap named and a pointer to the S24 or an emulator.

**Given** the contract doc and test
**When** this story lands
**Then** both include `POST /leases`.

### Story 7.2: Wait for a Lease through the API

As an Earshot QA agent calling the API,
I want a `POST /leases` that waits in line and answers when I get a phone,
So that I do not poll, and a client that vanishes never holds a place (FR-10, AD-37, AD-48).

**Acceptance Criteria:**

**Given** a `POST /leases` with `wait_ms`
**When** it arrives
**Then** the body carries a client-minted `id` (a server-minted one is allowed only without a wait), the ticket carries the serving process's pid, and the server writes nothing until the outcome, so the status line is the outcome (200, 409 busy, 503 away or restarting) with `X-Request-Id` echoing the id.

**Given** the client disconnects during the wait
**When** the server notices
**Then** it aborts the wait and `lock.mjs` records `cancel`
**And** a Hold granted after the socket was destroyed is released at once, while a Hold granted before stands and the client can fetch it with `GET /leases/<id>`.

**Given** a repeat of an `id` that the same `holder` already holds
**When** it arrives
**Then** the existing state returns with `200` and no second Lease is taken; a repeat of an `id` still waiting takes over the wait and the old connection gets `409 HUB_LEASE_SUPERSEDED` (not a cancel).

**Given** `SIGTERM`
**When** the service has open waits
**Then** it answers each `503 HUB_API_RESTARTING` with `retry: requeue`, aborts their tickets, then exits; after a crash the stale tickets are removed by the next pruner with a `prune` event.

**Given** the Hub API's `wait_ms`
**When** a queued wait times out
**Then** the `detail` carries the `HUB_LOCK_TIMEOUT` wording `host lock <name> is held …` (AD-5).

**Given** the hermetic suite
**When** it runs
**Then** it covers disconnect mid-wait, a grant to a destroyed socket, the supersede, and the SIGTERM answer, calling the handler with a fake request and no real socket.

### Story 7.3: Extend and release a Lease, with a recorded override

As Jarad,
I want to extend or release a Lease from the CLI or the API, and to override the no-extension rule with a reason,
So that I can finish real work without starving others by accident (FR-10, FR-31, AD-16, AD-38).

**Acceptance Criteria:**

**Given** `hub-device extend <id> --for <duration>` and `POST /leases/<id>/extend`
**When** no one waits and the new expiry stays within 48 h of the original start
**Then** the expiry moves later through `extendLease` only and an `extend` event is appended.

**Given** waiters (any queue the Resource is served from, AD-34)
**When** an extension is requested
**Then** it is refused `HUB_LEASE_EXTEND_REFUSED` (exit 76) naming the waiters and positions.

**Given** `override: {actor, why}`
**When** it is sent with an extension
**Then** `extendLease` skips only the waiters check, never the expiry check, the 48 h limit or the 60 min deploy-target cap, and the `extend` event carries `actor` and `why`
**And** an empty `why` is refused `HUB_USAGE` (400, exit 2).

**Given** an extension at or after the Lease's expiry
**When** it is requested
**Then** it is refused, so a late renewal never overwrites the next holder.

**Given** `hub-device release <id>` and `POST /leases/<id>/release`
**When** they run
**Then** they release through `lock.mjs`, record `release`, and refuse a `job:` id as v1a does (exit 2).

**Given** the CLI and the API
**When** they take the same extension request
**Then** a parity test shows the same Hold, refusal reason and events.

### Story 7.4: Lease an emulator through the API

As an agent,
I want `POST /leases` for the emulator Pool to give me a booted emulator slot,
So that I do not need a shell to test on an emulator (FR-6, FR-10, AD-36, AD-44).

**Acceptance Criteria:**

**Given** a request for the emulator Pool (by word `emulator`, or `match` with `profile`)
**When** it is made through the service
**Then** it calls `provision({holderPid: null})` off the request path in a `node:worker_threads` worker, the Lease is expiry-bound, and the response carries the slot, its adb serial and the profile.

**Given** the Pool size
**When** the Claims library reads it
**Then** the order is `HUB_EMULATOR_POOL` (CLI process only, never a service), then the `emulator-pool` file, then the Registry's `pools.emulator.size`, then 2, each checked against 1..8
**And** the emulator Pool keeps its `emulator` gate and slots are derived, never Registry records.

**Given** a profile not installed on the host
**When** it is requested
**Then** it fails at once `HUB_NO_MATCH` with the reason, and `PROFILES` and `MAX_POOL` stay code constants.

**Given** an emulator booting for a request when the service dies
**When** the next reap runs
**Then** it is torn down like any orphan.

**Given** the hermetic suite
**When** it runs
**Then** it uses the emulator fakes already in `emulator.test.mjs`, and no real emulator, adb or `heavy` is started.

### Story 7.5: Cancel a queued request

As an agent or Jarad,
I want to cancel a request that is waiting in line,
So that nobody waits behind a place that no longer matters (FR-11, AD-38).

**Acceptance Criteria:**

**Given** `lock.mjs`
**When** `cancelRequest(name, lease_id, {actor, why?})` is called
**Then** `opts.actor` is required, the ticket is removed (for a Pool request from every member, AD-33), a `cancel` event with `actor` is appended, and no Hold is touched
**And** a `job:` ticket is refused (deploy jobs are cancelled by cancelling the run).

**Given** `POST /requests/<id>/cancel` and `hub-device cancel <id>`
**When** the body carries `resource`, and a Pool cancel also `pool` and the host key
**Then** no receiver searches the fleet by id, the answer is the resulting queue, and a missing request is `404`.

**Given** the caller is not the request's `holder`
**When** it cancels
**Then** it is allowed (the actor is recorded, NFR-6: names are recorded as given, no authentication).

**Given** a Reservation
**When** `cancelRequest` is pointed at it
**Then** it is refused and pointed at `force-release`.

**Given** the CLI and the API
**When** they cancel the same request
**Then** a parity test shows the same queue and events.

### Story 7.6: Force-release a Lease

As Jarad,
I want to force-release a stuck Lease with a recorded reason, and be told when I cannot end a deploy job's Hold,
So that a forgotten Lease never starves a deploy, and a Job Hold is never ended from outside its run (FR-11, AD-38, AD-15).

**Acceptance Criteria:**

**Given** `lock.mjs`
**When** `forceRelease(name, {actor, why})` is called on a Lease
**Then** it renames the owner to a tomb, writes one `force-release` event with `actor`, `why`, `lease_id` and `hold_kind: lease`, and the next waiter is served normally
**And** an empty `why` is refused `HUB_USAGE` (exit 2).

**Given** a `job` or `hub-job` owner
**When** it is force-released
**Then** it is refused `HUB_FORCE_RELEASE_JOB` (409, exit 2), the problem+json carries `{repo, run, job}`, and the CLI prints the `gh run cancel` hint.

**Given** `POST /leases/<id>/force-release` and `hub-device force-release <id> --why <text>`
**When** they run
**Then** the API never asks for confirmation (that is the page's step in v1c), and the CLI requires `--why` and prints the id and holder released.

**Given** a lock that was reclaimed between read and rename
**When** the force-release runs
**Then** it affects only the owner it read (the rename decides), and the loser records nothing.

**Given** `hub-device status`
**When** a force-released Lease is gone
**Then** it is not listed, and `history` carries the event.

### Story 7.7: Force-release a Reservation

As Jarad,
I want to end a Reservation that a dead run left in line,
So that a stuck Reservation does not idle a device until its 3 h ceiling (FR-11, AD-38, AD-7).

**Acceptance Criteria:**

**Given** `POST /reservations/<run_key>/force-release` and `hub-device force-release --reservation <run_key>`
**When** they run with an `actor` and `why`
**Then** they call the existing `releaseReservation(name, {key, actor, why})`, which with an `actor` writes `force-release` with `hold_kind: reservation` and renames the directory to `.released-<key>-<ms>` as v1a does.

**Given** a deploy job
**When** it runs
**Then** it never calls a service to release its Reservation (AD-25); `announce`'s release and the ssh `reservation release` verb are unchanged, asserted by the Story 5.1 conformance test.

**Given** an empty `why`
**When** it is sent
**Then** it is refused `HUB_USAGE` (exit 2).

**Given** a Reservation already released
**When** the force-release arrives
**Then** it answers `404` and writes no event.

### Story 7.8: Force-release an emulator slot

As Jarad,
I want to force-release a stuck emulator slot cleanly,
So that the slot becomes claimable again with its emulator torn down (FR-11, AD-38).

**Acceptance Criteria:**

**Given** a slot `emulator-<n>` and a Claims function `forceReleaseEmulator`
**When** it runs
**Then** in this order it reads the slot's owner and emulator record; under the `emulator-reaper` lock calls `forceRelease(slot)` (its event carries `lease_id`); tears down and removes the record (`releaseEmulator(id, {alreadyReleased: true})`); and releases the reaper lock.

**Given** a crash between those steps (a test crashes after each step)
**When** the next reap runs
**Then** it tears an ownerless record down as an orphan with no second hold-ending event, and the slot is not claimable while its record exists.

**Given** a forced slot
**When** the next `lease emulator` runs
**Then** it gets a clean slot, and `status` shows no waiter ahead of it for the forced Hold.

**Given** `hub-device force-release emulator-<n> --why <text>` and the API route
**When** they run
**Then** both call that one Claims function.

### Story 7.9: Ship Leases through the API

As Jarad,
I want API Leases, cancel and force-release live,
So that Holocene (v1c) and agents have the write half of the contract (FR-10, FR-11, FR-21).

**Acceptance Criteria:**

**Given** stories 7.1 to 7.8 are on main
**When** `mise run check` runs on Node 24 and Node 26
**Then** it is green, `docs/hub-api-contract.md` lists every Hold route in AD-42's table with exact field lists, and the contract test passes.

**Given** `mise run release -- X.Y.Z`
**When** it completes
**Then** every app's strict dry run is green, `v1` has moved, and `mise run hosts:install` has run on big-chungus (operator actions), reading `/health` back with the new `contract`.

**Given** the live service
**When** an operator takes, waits for, extends and force-releases a Lease on the S24 and `hub-device status` shows each state
**Then** each matches the same action through the CLI.

**Given** the release notes
**When** they are published
**Then** they state that a Job Hold cannot be force-released and a deploy-target Lease is capped at 60 min.

---

## Epic 8: See every hold and waiter live

The read half of the contract: one status document and one stream, both change-driven and non-blocking, and a service that can be restarted at will. Until Epic 9 the document holds one host (`linux`); Story 9.5 adds the Mac's view without changing a key.

### Story 8.1: One status document from the API

As Holocene's future author and as an agent,
I want `GET /status` to return every Resource's Reachability, Hold and Queue in one document,
So that nothing recomputes a queue another host owns (FR-14, FR-29, AD-30, AD-41).

**Acceptance Criteria:**

**Given** `GET /status`
**When** it is called
**Then** it returns `{format, contract, hosts: {<host key>: <view>}, registry, stale, checked_at}`, each view being `statusView(hostKey, {audience: 'service', qa_ids})` embedded unchanged, with Registry fields (names, Capabilities, retired and `seed_missing` visibility) only under `/status.registry`
**And** the API never recomputes a queue position or an ETA (`queueView` and `eta.mjs` do, AD-6, AD-18).

**Given** the `service` audience
**When** a `dedicated_qa` Resource is rendered
**Then** `serial`, `udid`, `adb_id` and `device.serial` are `null` and keys are never removed; the `qa_ids` come from `registry.json`
**And** a test walks every key path of `/status` for a QA serial and finds none.

**Given** a Hold
**When** it is rendered
**Then** it carries additive `expected_end` from `eta.mjs`, never later than `expires_at`
**And** expired, grace and `stale` are derived from `now` at serialisation, so a dead Hold is never shown live because no file changed.

**Given** a waiting Pool request
**When** `/status` lists it
**Then** it appears once, with `request`, `pool` and `positions`.

**Given** `hub-device status` on big-chungus
**When** the API answers
**Then** it adds remote hosts from `/status` and stays read-only; when the API does not answer, it lists remote hosts as `unavailable`.

**Given** the contract doc and test
**When** this story lands
**Then** both include `/status` with its exact key sets.

### Story 8.2: Reads and waits never block the event loop

As an agent,
I want a status read to answer in under 200 ms while a lease wait is spinning,
So that the service stays usable under load (NFR-7, AD-44).

**Acceptance Criteria:**

**Given** `/status` and every read endpoint
**When** they answer
**Then** they answer from the in-memory snapshot, and a test injects a `processStart` seam that blocks 200 ms and asserts `/status` still answers in under 200 ms.

**Given** the service code
**When** a conformance test scans `tools/hub-api/*.mjs` and `tools/host-agent/*.mjs`
**Then** no `spawnSync` or `execSync` is called on the main thread; `/proc` scans, emulator `inventory()`, adb queries, `provision` and every service-side wait loop (`acquireLease`, `poolRequest`) run in a `node:worker_threads` worker or use the cached process-start seam (one read per pid per pass, shared across waiters).

**Given** an uncontended `POST /leases` on a local Resource
**When** it runs against fakes
**Then** it answers in under 1 s, excluding emulator boot, and a forward reports its own `duration_ms` outside that figure.

**Given** `/status` on a month of fixture events
**When** it runs
**Then** it answers in under 200 ms.

### Story 8.3: Live Reachability from one adb socket

As Jarad,
I want phone presence to update when a phone connects or drops,
So that Reachability is current without polling (FR-5, AD-35, AD-19).

**Acceptance Criteria:**

**Given** `adb-wire.mjs`
**When** it gains a streaming `trackDevices`
**Then** it issues only `host:track-devices-l` on the hub's adb server port and never starts a server.

**Given** the Hub API
**When** an adb server is running
**Then** it holds one `host:track-devices-l` socket; while it is open its readings are `source: track` and current.

**Given** the socket closes
**When** that happens
**Then** one `reachability` event with `reason: track-lost` is written per Resource, readings fall back to `source: probe`, and the socket is reopened only by the next read or request, never by a timer and never by starting a server.

**Given** a track update
**When** a phone's state changes
**Then** the Hub API appends one `reachability` event through `noteReachability` and the cached reading is updated for every reader of `/status`.

**Given** the hermetic suite
**When** it runs
**Then** a fake socket drives connect, drop, unauthorized and close, with no real adb and no `setInterval`.

### Story 8.4: One stream on the Candybar wire

As Holocene's future author,
I want `GET /stream` to speak the same SSE wire Candybar's page already consumes,
So that the page reuses a proxy that is already written (FR-14, AD-43).

**Acceptance Criteria:**

**Given** `GET /stream`
**When** it answers
**Then** `Content-Type: text/event-stream`, `Cache-Control: no-store` and `X-Accel-Buffering: no`, with `retry: 3000`
**And** each frame has `id: <boot>-<seq>` matching `^[0-9a-f]{12}-[0-9]+$` (12 hex boot minted at service start, decimal `seq` from 1) and a one-line JSON payload with `type`, `seq`, `key` and `at`.

**Given** frame types
**When** the stream emits
**Then** `status` carries the whole `/status` document (absolute state) and `event` carries one Event Log line with its event id (clients dedupe on it); the stream keeps the last 1024 frames of its boot.

**Given** a connection with no `Last-Event-ID`
**When** it opens
**Then** it gets `ready` carrying the whole `/status`.

**Given** an exact resume
**When** `Last-Event-ID` names a frame in the ring
**Then** it gets only the replay strictly after it; an unknown boot or evicted `seq` gets `reset` with `reason: unresumable`, carrying the whole `/status`, after which the client refetches `/history`.

**Given** `api.stream_keepalive_s`
**When** that interval passes with no bytes sent
**Then** a `: keepalive` comment is written; the timer belongs to the open connection and is cleared with it.

**Given** the hermetic suite
**When** it runs
**Then** it covers ready, exact resume, reset, eviction and the keepalive using a fake clock and a fake response.

### Story 8.5: A change reaches subscribers within two seconds

As Jarad watching the board (v1c),
I want any Hold, queue or Reachability change on big-chungus to appear on the stream within 2 s,
So that the view is live without anyone polling (FR-14, NFR-3, AD-43).

**Acceptance Criteria:**

**Given** `fs.watch` through the `watchImpl` seam on the lock dir, its `emulators/` dir, each `<name>.lock`, `<name>.queue` and `<name>.reservations` dir, and the event dir
**When** a path is created or a watched dir is replaced
**Then** the parent's notification re-arms the watch, and filenames from the OS are never trusted (any notification triggers a re-read).

**Given** any notification
**When** it arrives
**Then** one re-read is scheduled after a trailing debounce of at most 250 ms, and the resulting `status` frame (plus `event` frames for new log lines read through `readEventsFrom`) is emitted.

**Given** a change written by `hub-device`, a deploy job or the service itself
**When** it lands
**Then** a subscriber receives the frame within 2 s, whichever process made it, asserted with a fake watcher and a fake clock.

**Given** a change that only time causes (a Lease expiring, a grace period ending)
**When** it happens
**Then** no frame or event is emitted; every reader derives it from `now`.

**Given** a conformance test
**When** it scans for timers
**Then** it finds no `setInterval` outside `stream.mjs`, `hub-client.mjs` and `lock.mjs`, and no recurring work (NFR-3).

### Story 8.6: A restart loses nothing

As Jarad,
I want to restart the Hub API at any time without losing a Hold, Reservation or Registry entry,
So that deploying the service is never a risk to a running deploy (FR-23, AD-23, AD-37).

**Acceptance Criteria:**

**Given** a restart of any length
**When** the service stops and starts
**Then** every Lease, Job Hold, Reservation and Registry entry written before it is unchanged, because they live in the lock dir and `registry.json`, asserted by a test that stops one handler instance and starts another over the same temp dirs.

**Given** a request waiting through the API at restart
**When** the service receives `SIGTERM`
**Then** (end to end, on top of Story 7.2's handler) the caller gets `503 HUB_API_RESTARTING` with `retry: requeue`, and after a crash the caller's `hub-client` treats a connection reset during a wait as `requeue` too.

**Given** emulators the service started
**When** it restarts
**Then** they keep running (`KillMode=mixed` plus the `heavy` scope, Story 6.11), asserted by a test over the unit file's directives and the spawn seam.

**Given** a second Hub API
**When** it starts while one runs
**Then** it exits `HUB_API_ALREADY_RUNNING` on `EADDRINUSE` and the first is unaffected.

**Given** a stream subscriber
**When** the service restarts
**Then** its reconnect with the old `Last-Event-ID` gets `reset` with `reason: unresumable`, because the boot id changed.

### Story 8.7: Ship the live status

As Jarad,
I want `/status` and `/stream` live,
So that the board in v1c has a feed and agents have one document to read (FR-14, FR-21).

**Acceptance Criteria:**

**Given** stories 8.1 to 8.6 are on main
**When** `mise run check` runs on Node 24 and Node 26
**Then** it is green, the contract doc lists `/status` and `/stream` and the contract test passes.

**Given** `mise run release -- X.Y.Z`
**When** it completes
**Then** every app's strict dry run is green, `v1` has moved, and `mise run hosts:install` has run on big-chungus (operator actions), with `/health` reading back the new `contract` and `hub_version`.

**Given** the live service
**When** an operator runs `curl -N 127.0.0.1:8794/stream` and takes a Lease with `hub-device`
**Then** a `status` frame appears within 2 s and the stream shows keepalive comments while idle.

**Given** a restart of the service during that session
**When** it comes back
**Then** the operator's Lease is still held and the stream reconnect gets `reset`.

---

## Epic 9: The iPad and the Mac, from big-chungus

The only cross-host work in v1b. The Mac's lane keeps its lock on the Mac's disk; every cross-host action is a forward over ssh to that host's own service, and the Mac pushes only changes. Deploy jobs and the iPad catch-up never call any of this (AD-25).

### Story 9.1: Cross-host calls go through one client

As the hub maintainer,
I want one `hub-client.mjs` that reaches the peer's loopback service over ssh,
So that no caller invents a second transport or leaves a ghost waiter behind (NFR-6, AD-26).

**Acceptance Criteria:**

**Given** `hub-client.mjs`
**When** it calls a peer
**Then** it runs `ssh -T -o BatchMode=yes -o ConnectTimeout=<api.peer_connect_timeout_s> -o ControlMaster=no -o ControlPath=none -o ServerAliveInterval=15 -o ServerAliveCountMax=2 <alias> <remote command>` through an `sshImpl` seam, with `<alias>` mapped from the host key (`mac.host` from big-chungus, `linux.host` from the Mac)
**And** the remote command runs `hub-client.mjs relay <method> <path>` from the peer's installed release with its absolute node path, every word single-quoted (the `catchup.mjs` escaping) because both login shells are zsh.

**Given** the relay
**When** it runs
**Then** the JSON body is its first stdin line, `hub-client` then writes one newline every `api.stream_keepalive_s` for the life of the call, and the relay calls the peer's loopback port and aborts that request on stdin EOF or after 3 intervals with no byte
**And** it writes status, headers and body back, which `hub-client` parses as a `fetch` response, and kills ssh at the call's bound plus 10 s.

**Given** same-host calls
**When** they run
**Then** they use `fetch` to loopback.

**Given** a hermetic test
**When** it runs one route through both transports
**Then** the results are equal; a path containing `?`, `&` and `'` survives `zsh -c` and `sh -c`; and closing stdin mid-wait yields a `cancel` event.

**Given** a failed call to a host
**When** it fails
**Then** the error is `HUB_DEVICE_AWAY` (exit 75, reason `host-unreachable`) with the connect timeout in the message, never a hang.

### Story 9.2: The Host Agent serves the Mac's own state

As Jarad,
I want a Host Agent on the Mac that answers for the Mac's lock dir and the iPad,
So that the Mac's `ios-lane` is described by the host that owns it (FR-5, FR-12, AD-25, AD-35, AD-41).

**Acceptance Criteria:**

**Given** `tools/host-agent/server.mjs`
**When** it starts
**Then** it binds `127.0.0.1:<api.host_agent_port>` (8795) only, answers `GET /health` (`{ok, service, contract, hub_version, ports}`, no `registry`), and on `EADDRINUSE` exits `HUB_API_ALREADY_RUNNING` with exit 0 under launchd.

**Given** `GET /status` on the agent
**When** it is called
**Then** it returns `statusView('mac', {audience: 'service', qa_ids})` rendered by the Mac itself, with every timestamp in the `ios-lane` Queue from the Mac's clock (FR-12), and the agent serves `/leases…`, `/requests/<id>/cancel`, `/reservations/…` and `GET /leases/<id>` for its host only; `/registry/*` is a `404`.

**Given** the iPad
**When** the agent reads its Reachability
**Then** it uses `devicectl.mjs` and `pickIpad` (the only transport, read-only), runs it only on request, and maps per Story 5.4.

**Given** the agent
**When** it needs `qa_ids`
**Then** it takes them from its last Hub API answer or the in-memory seed (AD-32), and redacts before it answers.

**Given** the hermetic suite
**When** it runs
**Then** the agent's handler is called with fakes (`devicectl`, `hostKey`, clock), no port is bound, and a test asserts it never starts a timer.

### Story 9.3: Forwarded actions reach the right host

As an agent on big-chungus,
I want an action on a Mac Resource to run on the Mac,
So that no host ever writes another host's lock dir (FR-12, AD-25, AD-32, AD-48).

**Acceptance Criteria:**

**Given** a Claims action on a Resource whose `host` is not `hostKey()`
**When** it runs
**Then** it is forwarded to that host's front door as the public route plus header `X-Hub-Forwarded: <door>` and body key `resource: {id, lock, host, rev, retired_at}`, and the receiving Hold routes are the same on both services.

**Given** a forward received on big-chungus
**When** it carries a record
**Then** the receiver ignores it and re-resolves `id` against `registry.json`; the Host Agent acts on `lock` and `host` as carried and applies the retired check to the carried `retired_at`, which only a big-chungus front door that read `registry.json` stamps.

**Given** a record with `rev: 0` (the seed fallback)
**When** the Host Agent receives it
**Then** it accepts it only for a seeded Resource.

**Given** off big-chungus
**When** `hub-device` or the agent resolves a word or Capability request
**Then** it asks the Hub API through `hub-client.mjs`, and when the API cannot be reached it resolves from the in-memory seed only (AD-32).

**Given** a release, cancel or extend
**When** it is forwarded
**Then** its body carries `resource`, and a Pool cancel carries `pool` and the host key.

**Given** a retried forward carrying the same client-minted `id` and `holder`
**When** it arrives
**Then** it takes no second Lease (Story 7.2's repeat rules hold across the forward).

### Story 9.4: `lease ipad` and `lease mac` take the `ios-lane`

As Jarad,
I want `hub-device lease ipad` and `lease mac` from big-chungus to take the Mac's one `ios-lane`,
So that I can hold the iPad or the Mac without ssh by hand, excluding iOS deploys and the iPad catch-up as `mac-ios` does today (FR-12, UJ-1, AD-32).

**Acceptance Criteria:**

**Given** `hub-device lease ipad` and `lease mac`
**When** they run
**Then** both take the `ios-lane` (lock `mac-ios`) with the 60 min deploy-target cap, through the forward of Story 9.3; `lease ipad` also needs the iPad Reachability `reachable` unless `--no-connect`, and `lease mac` needs only the host.

**Given** the Mac does not answer within `api.peer_connect_timeout_s`
**When** a Lease request for the `ios-lane` is made
**Then** it fails with `HUB_DEVICE_AWAY` (exit 75, `reason: host-unreachable`) without waiting in line.

**Given** the Hub API is down
**When** `hub-device lease ipad` runs on big-chungus
**Then** it forwards to the Mac directly through `hub-client.mjs`.

**Given** a Lease on the `ios-lane` held on the Mac
**When** an iOS job or the iPad catch-up wants `mac-ios`
**Then** it queues behind the Lease and is served in arrival order, with every timestamp from the Mac's clock (asserted by a hermetic test over a temp Mac lock dir).

**Given** `lease ipad --for 2h`
**When** it runs
**Then** it exits 2 naming the 60 min cap.

**Given** the Mac's own `hub-device`
**When** it runs `lease ipad|mac`
**Then** it acts locally in-process, and the exit codes and `HUB_DEVICE_*` lines are unchanged (AD-17).

### Story 9.5: The Host Agent pushes changes, and only changes

As Jarad,
I want the Mac to tell the Hub API when something on the Mac changed,
So that the board sees the Mac without the Mac streaming while it is asleep (FR-14, NFR-3, NFR-8, AD-26, AD-49).

**Acceptance Criteria:**

**Given** `tools/host-agent/watch.mjs`
**When** a write lands in the Mac's lock dir or event dir, or a Reachability reading changes, or the agent starts
**Then** it pushes within 250 ms of the notification, and at no other time
**And** a failed push logs `HUB_AGENT_PUSH_FAILED`, is not retried on a timer, and is carried by the next change or the next request that needs the host.

**Given** `push.mjs`
**When** it sends
**Then** it sends exactly one message type, `POST /agent/push`, body `{format: 1, host, host_id, boot, seq, sent_at, status, readings, events}`, with `status` from `statusView('mac', service)` or `null`, `readings` or `null`, and `events` is `null` in this story (the replica is filled by the history epic)
**And** `seq` rises per `boot`, and the Hub API ignores a `seq` it has already applied for that boot.

**Given** the Hub API receives a push
**When** it applies it
**Then** `/status.hosts.mac` is that status, the Mac's Reachability readings update the cache (Story 6.10's shape), and a stream frame is scheduled (Story 8.5) within the 2 s budget.

**Given** the Mac's data
**When** the Hub API renders it
**Then** it marks `stale` from the push age on the reader's clock, never pushed (NFR-8).

**Given** a push and a conformance test
**When** it scans the agent
**Then** no timer, `setInterval` or poll appears, and the agent calls the Hub API only through `hub-client.mjs`.

### Story 9.6: An asleep Mac reads `offline`, and fails fast

As an agent,
I want the `ios-lane` to read `offline` when the Mac is not answering,
So that I do not wait on a laptop that is closed (FR-5, FR-12, NFR-8, AD-35).

**Acceptance Criteria:**

**Given** a call to the Mac that fails (connect refused, timeout, ssh error)
**When** the Hub API records it
**Then** it marks the host `unreachable` with `since`, every Resource on it reads `offline`, one `host-reachability` event (`{host, from, to, reason}`) is appended, and actions on it fail at once.

**Given** a host marked unreachable
**When** a refresh would be attempted
**Then** none is tried until a Host Agent push arrives, a request that must act on that host, or 5 x `registry.reachability_max_age_s` since the failure, judged at request time and never by a timer.

**Given** a successful push or call
**When** it arrives
**Then** the host is restored and one `host-reachability` event records it.

**Given** `/status.hosts.mac`
**When** the Mac is unreachable
**Then** the last view is shown marked stale, with `since`, and the `ios-lane` reachability is `offline`.

**Given** the hermetic suite
**When** it runs
**Then** a fake `sshImpl` drives failure, 5x recovery by request and push recovery, with a fake clock.

### Story 9.7: The Host Agent runs on the Mac as its own LaunchAgent

As Jarad,
I want the Host Agent installed as an always-on login agent on the Mac,
So that it has the GUI session `devicectl` needs, and never disturbs the iPad catch-up (AD-45, NFR-8).

**Acceptance Criteria:**

**Given** `tools/hosts/units/sh.delo.mobile-deploy-hub.host-agent.plist`
**When** it is rendered by `install.sh <ref>`'s Darwin branch
**Then** it has `KeepAlive: {SuccessfulExit: false}`, `RunAtLoad`, `LimitLoadToSessionType Aqua`, no `StartInterval`, `StandardOutPath` and `StandardErrorPath` at `~/Library/Logs/mobile-deploy-hub/host-agent.{out,err}.log`, runs from `releases/<ref>` with the install-time Node path, and requires Node >= 24.15 at start
**And** the catch-up label and plist are untouched, asserted by a test over both rendered files.

**Given** `tools/hosts.mjs`
**When** it installs on the Mac
**Then** it bootstraps the LaunchAgent beside the untouched catch-up installer, reads `/health` back from the agent, and fails the step on no answer.

**Given** `hosts:install` on either host
**When** it finishes
**Then** it reads `/health` back from both services and fails the step when their `contract` or `hub_version` differ (assumption A1 begins this check here, not earlier).

**Given** a running agent
**When** `hosts:install` runs again
**Then** it never deletes the release dir the agent uses, and the agent switches only at the install.

**Given** the singleton refusal
**When** a second agent starts
**Then** it exits 0 so `KeepAlive` does not respawn it.

**Given** the hermetic suite
**When** it runs
**Then** `hosts.mjs` is tested with a fake `launchctl` and a fake `fetchImpl`.

### Story 9.8: Ship the Mac Host Agent

As Jarad,
I want the Mac visible and leasable from big-chungus,
So that the iPad is as easy to hold as a phone (FR-12, FR-14).

**Acceptance Criteria:**

**Given** stories 9.1 to 9.7 are on main
**When** `mise run check` runs on Node 24 and Node 26
**Then** it is green and the contract doc lists the Host Agent routes and `/agent/push`.

**Given** `mise run release -- X.Y.Z`
**When** it completes
**Then** every app's strict dry run is green, `v1` has moved, and `mise run hosts:install` has run on big-chungus and on the Mac (operator actions), with both `/health` readbacks equal.

**Given** the live pair
**When** an operator runs `hub-device lease ipad --for 10m`, then `hub-device status --json`
**Then** the Lease shows on the `ios-lane` with the Mac's clock, and releasing it frees the lane.

**Given** an iOS job or the iPad catch-up after the install
**When** the next real iOS deploy runs
**Then** it behaves as before (v1a AD-22 unchanged), and the iPad catch-up's candybar still reports `HUB_MAC_BUSY` as a success, not caused by the agent.

**Given** the Mac is put to sleep
**When** an operator runs `hub-device lease mac`
**Then** it exits 75 with `host-unreachable` at once.

---

## Epic 10: Ask what happened, on either host

### Story 10.1: Replicate the Mac's Event Log

As an analyst,
I want the Mac's events copied byte for byte to big-chungus when the Mac is awake,
So that history is readable when the Mac is not (FR-18, NFR-8, AD-40, AD-49).

**Acceptance Criteria:**

**Given** a push with `events: {month, from_offset, lines}`
**When** the Hub API applies it
**Then** it appends iff `from_offset` equals the replica month file's size at `HUB_EVENT_DIR/replicas/<host key>/<YYYY-MM>.jsonl`; otherwise it answers `409 HUB_REPLICA_GAP` with `{size}` and appends nothing
**And** the Hub API is the only writer of `replicas/`, never `lock.mjs`.

**Given** the agent
**When** it triggers a push
**Then** it compares each source month's size with the acknowledged replica size and pushes the oldest month that differs; no month is ever closed, a push never spans two months, and the first push for a host starts at offset 0 of its oldest month file.

**Given** every push response
**When** it carries `{replica: {<month>: size}}`
**Then** the agent resumes from it, including at its own start (it keeps no cursor, AD-23).

**Given** `POST /agent/sync` on the agent
**When** it is called with replica sizes
**Then** the agent pushes from those sizes.

**Given** a retried push after a torn or repeated delivery
**When** it is applied
**Then** the replica has no duplicate or shifted line, and its bytes equal the source prefix, asserted by a test that compares file hashes.

### Story 10.2: Query history across both hosts

As Jarad,
I want `GET /history` to return events from both hosts, filtered, with gaps marked,
So that I can see who held what, and trust what I am told (FR-18, UJ-4, AD-40).

**Acceptance Criteria:**

**Given** `GET /history?resource&pool&claimant&repo&from&to&cursor`
**When** it runs
**Then** it filters by Resource, Pool, Claimant, repo and time range and pages with an opaque cursor `{<host key>: "<month>/<offset>"}`, reading big-chungus's log with `readEventsFrom` and the Mac's replica.

**Given** a range a replica lacks
**When** the request arrives
**Then** the API calls the Host Agent's `POST /agent/sync` with the replica sizes and then reads the replica; with the Mac unreachable it answers `partial: true`, with `synced_through` per host and `unreachable_ranges` from `host-reachability` events (time the Mac was asleep but later synced is complete, a deliberate narrowing of FR-18).

**Given** the merge
**When** results from two hosts are shown
**Then** order is total per host (month, then offset), and across hosts `/history` merges by `ts` for display only; the response documents that consumers never derive a cross-host order from it.

**Given** every event since the log shipped
**When** it is queried
**Then** it is returned: v1b does not compact or delete.

**Given** the contract doc and test
**When** this story lands
**Then** both include `/history`.

### Story 10.3: Utilisation per Resource

As Jarad,
I want each Resource's share of a window spent held, idle while reserved, idle and away,
So that v1c can show whether a device is the bottleneck (FR-18, AD-40).

**Acceptance Criteria:**

**Given** `tools/registry/history.mjs`
**When** `utilisation(events, registry, lockToResource, window)` is called
**Then** it is a pure function returning held, idle-while-reserved, idle, away and `unknown` shares, attributing v1a events without `resource` through the `lock -> resource` map.

**Given** Reachability readings
**When** the function walks them
**Then** a `track` reading holds until the next event, a `probe` reading holds until `checked_at + reachability_max_age_s`, after which time counts as `unknown`, as does time before a Resource's first reading.

**Given** an emulator Pool
**When** utilisation is computed
**Then** it is per slot, rolled up to the Pool.

**Given** `GET /utilisation?from&to`
**When** it is called
**Then** it returns the per-Resource shares and answers from cached aggregates, never the whole log per request (the addendum's B.7).

**Given** the hermetic suite
**When** it runs
**Then** a table of fixtures covers empty, sparse and rich history, a Mac gap and a `track-lost` event.

### Story 10.4: Freeze the contract and prove nothing leaks

As Holocene's future author,
I want the contract to list exactly the routes the code serves and no QA serial anywhere,
So that v1c codes against a stable, safe surface (FR-21, AD-42, AD-30).

**Acceptance Criteria:**

**Given** `docs/hub-api-contract.md`
**When** it is checked
**Then** it lists exactly the AD-42 route table (health, status, stream, resources, pools, discovery, history, utilisation, the registry writes, `/leases` and its extend, release and force-release, `/requests/<id>/cancel`, `/reservations/<run_key>/force-release`, `GET /leases/<id>`, `/agent/push`, and the Host Agent's `/health` and `/agent/sync`), each mapped to one Claims or store function
**And** `/capacity` is reserved for v1c and absent from code.

**Given** the contract test
**When** it runs
**Then** it asserts exact key sets against handler output for every route and fails if a field or route was removed or renamed (only additions allowed); errors are `application/problem+json` with `code`, `exit` and `reason`.

**Given** a QA serial seeded in a fixture
**When** a test walks every key path of `/status`, `/stream`, `/history`, `/resources` and `/discovery` output
**Then** it finds the serial in none.

**Given** every write route
**When** it succeeds
**Then** it returns the resulting state (FR-21).

### Story 10.5: Ship v1b

As Jarad,
I want v1b closed out with both services on one release and checked,
So that v1c has a complete, running substrate (FR-18, NFR-2).

**Acceptance Criteria:**

**Given** stories 10.1 to 10.4 are on main
**When** `mise run check` runs on Node 24 and Node 26
**Then** it is green.

**Given** `mise run release -- X.Y.Z`
**When** it completes
**Then** every app's strict dry run is green, `v1` has moved, and `mise run hosts:install` has run on big-chungus and on the Mac (operator actions), with both services' `/health` reporting equal `contract` and `hub_version`.

**Given** the live pair
**When** an operator queries `/history` for a Mac event after the Mac slept and woke
**Then** the replica fills and the gap is marked `partial` before and complete after.

**Given** the release notes
**When** they are published
**Then** they state that the Registry, `replicas/` and the new event names are ignored by pinned readers, that deploy jobs and the catch-ups never depend on either service, and that v1c adds `/capacity` and the Holocene page.

**Given** `git unpushed`
**When** it runs after the release
**Then** it lists nothing.
