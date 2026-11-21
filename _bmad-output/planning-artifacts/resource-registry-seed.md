# Resource registry, hub API and Holocene page: PRD seed

Status: seed for `bmad-prd`, 2026-11-21. Not a plan of record. Evidence was verified against 4cdefdc plus the
hermetic-tests fix.

## What Jarad asked for (2026-11-21)

- Codify the device leasing that works today, and expand it: "I wanna be able to put more resources in. I want to be able to register."
- What goes wrong today:
  - "Sometimes it doesn't know what phones are available to deploy to."
  - "Sometimes another project will be starved in the presence of contention, and just need to know how long does it have to wait? Or it just needs a formal way to sign up for the next run, so one project doesn't get shut out."
- A control surface for a distributed set of resources: its own page in Holocene, the canonical control surface. It is not a tray app.
- It should sit on a proper API, built in Node, not Python.

## One level up (belsky-doctrine)

The registry covers every resource the hub's jobs contend for: phones, the iPad, emulator pool slots, the Mac's `mac-ios`
lock and the Mac runners. It is not limited to Android phones. Every app the hub serves gets fair queueing and ETAs, not
only the one that was starved.

## What exists (keep it, wrap it)

- **`tools/ci/lib/lock.mjs`**: leases are directories created with `mkdir`, last at most 48h, and are reclaimed when the holder's pid is dead.
  - Leases queue first in, first out in `<name>.queue/`.
  - The S26 is the `adb` lock, and deploys share it.
- **`tools/device/hub-device.mjs`**: the `lease|run|release|status --json` commands.
  - Exit codes: 75 means away, 76 means busy.
  - The `phone` word takes whichever phone is free.
- **`tools/device/emulator.mjs`**: a throwaway emulator pool, 2 slots by default and 8 at most, with a fair first-in-first-out gate and a lazy reaper.
- **`tools/ci/devices.json`**: a fixed shape with one `android` deploy phone, `android_extra` (the S24), one `ios` (the iPad), and the Mac and Linux hosts.
  - The private `~/.config/mobile-deploy-hub/qa-devices.json` is read by no hub code.

## Gaps, with evidence

1. **Discovery.** Deploys hard-code the S26 and the `adb` lock:
   - `plan.mjs:230-232`
   - `android.mjs:94-102`
   - `gate.mjs:138-140`
   - `catchup.mjs:456-460`

   Other gaps:
   - `android_extra` is read only by hub-device.
   - Registering a phone takes a hub release plus `hosts:install`.
   - The iPad and the Mac have no lease path.
   - `status` sees reachability only when the 5037 adb server is already running.
2. **Starvation.** `withLock` (the deploy jobs' lock) only polls `mkdir` every 2s and never joins `<name>.queue/`
   (`lock.mjs:65-97`).
   - Queued leases (polling every 1s) win every handoff, and deploys race each other with no order.
   - The plan and android jobs give up after 20 minutes. A starved android job fails after the version was bumped.
   - A deploy takes `adb` twice with a gap between, and anything can take the lock in that gap.
   - The `phone` word holds no place in line.
   - `mac-ios` (40-minute limit, taken twice per run, plus the Mac catch-up every 300s) is unordered.
   - Per-repo concurrency groups do nothing across repos.
3. **No wait data.** Records are deleted on release (`lock.mjs:61,103`, emulator records `emulator.mjs:263`), so there is
   no history.
   - Deploy waiters write nothing to disk, so `status` cannot show them.
   - There is no basis for an ETA or a capacity estimate.
4. **No API and no UI.** The repo has no HTTP server.

## Proposed slices (for the PRD to confirm or reorder)

1. **Event log first.**
   - Write an append-only `<lockDir>/events.jsonl` with request, acquire, timeout, release, reclaim and cancel events.
   - Cover both leases and job locks, emitted once each in `withLock`, `acquireLease`, `reclaim` and `releaseLease`.
   - Data starts building up immediately, which every ETA or capacity number depends on.
2. **Fair queue for deploys.**
   - `withLock` joins `<name>.queue/` with a `kind:'job'` ticket.
   - Add a durable reservation (`<name>.reservations/`), written by the plan job and adopted by the android job, so a run keeps its place across the gap.
   - Compatibility: pinned runs up to v1.2.41 still race with bare `mkdir`. Land the pin flip first; fairness is only partial until the 7-day rerun window has passed.
3. **Registry.**
   - Declared resources with capabilities: platform, model, API level, deploy-eligible, dedicated, owner and host.
   - One lock per resource instead of the literal `adb`.
   - Registration without a hub release.
   - Deploys target "any registered, free, compatible device". This touches delivery, receipts, catch-up and completion, which assume a single S26 today.
4. **Hub API (Node).**
   - Runs on big-chungus as the runner user, with the runner's `HUB_LOCK_DIR`, because a lock from another host is treated as stale.
   - Wraps the existing `lock.mjs`, `emulator.mjs` and `inventory` functions; it is not a second store.
   - Remote holders keep their place with heartbeats (a short `expires_at` renewed through `updateLease`).
   - `GET /health` returns `{ok, service}`, plus an SSE feed with pings.
   - The `mac-ios` lock needs a Mac-side agent, reached over ssh to `hub-mac` or run as a process on the Mac.
   - hub-device stays CLI-compatible: exit codes, `HUB_DEVICE_*` lines, `--json` shapes and the on-disk layout.
5. **ETA and capacity.**
   - The ETA for a waiter is the holder's expected remaining time plus the hold time of each waiter ahead.
   - "Time saved by adding a resource" is the M/G/c wait (Allen-Cunneen correction to Erlang C) at c and at c+1, with timeouts modelled as abandonment.
6. **Holocene page.**
   - Web side: `apps/web/app/<id>/` plus a `NAV_GROUPS` entry in the "System" group.
   - API side: `apps/api/src/<id>.ts`, served under `/api/modules/<id>/`.
   - Holocene's API calls the hub's API from the server side; the browser never does.
   - The hub keeps authority; Holocene reads and forwards narrow writes.
   - Template: Candybar (`app/candybar/*`, `apps/api/src/candybar.ts`).
   - Holocene sits behind Google OIDC at Traefik, so it can't be opened from a phone webview without SSO.

## Open questions for the PRD

- Which resources are in v1: phones and emulators only, or also the iPad and the Mac?
- Who signs up: a deploy run, an agent, a person, or all three? Should a deploy's place be per run or per app?
- Priority: does a deploy outrank a lease, or is it pure first in, first out?
- Where do registrations live, given they must work without a hub release? The options are a file in the lock dir, the API's own store, or a committed registry file with a hot reload.
- Does Bloodbank need a `mobile` or `device` domain (`bloodbank.evt.mobile.lease.*`) so Holocene's shared event collection sees leases?
