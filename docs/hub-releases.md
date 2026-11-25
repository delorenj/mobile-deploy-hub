# Hub release notes

One section per hub release, headed `## vX.Y.Z`. `mise run release -- X.Y.Z` (`tools/release.mjs`) puts the section of the version it tags into that tag's annotation, above the dry-run lines (`git show vX.Y.Z`), so the notes travel with the tag. A release with no section is annotated as before. Write the section before you release: the file is tracked, the release refuses a dirty tree, and the section is read from the commit being tagged.

A section is plain text read in a terminal: everything after its heading up to the next `## ` heading. Use `###` for sub-headings and `-` lists; do not start a section line with `## `.

## v1.2.50

v1.2.49 re-released; no hub code changed. v1.2.49 was tagged and rolled back, never on `v1`: green-in-between's release dry run (45520180065) went red in the `ios` job when the Mac's network dropped. The app's `ios-build.py` timed out after 90 s reading its godot-tests status from big-chungus over ssh, and GitHub's artifact service timed out on the same job. Tower's dry run on v1.2.49 was green. Everything in the v1.2.49 section below ships in this pin; install it on both hosts (`mise run hosts:install`).

## v1.2.49

Story 3.5 (AD-22): iOS contention is red, and says who. Nothing here changes the Queue protocol, the policy, the deadline or `latest.json`; install it on both hosts (`mise run hosts:install`).

### What changed

- The `ios` job's two `mac-ios` takes (the device build, then the store IPA build) go through one `macLane` helper in `ios.mjs`. A wait that runs out before the hold is `HUB_LOCK_TIMEOUT`, rethrown, so the job goes red. The lock writes the one `timeout` event on the Mac with `reason: ios-lane-contention`; the receipt records `contention {lock: mac-ios, reason: ios-lane-contention, blocked_by}` (the same shape Android writes), the job summary lists the holder and the waiters ahead, and the log has `HUB_IOS_LANE_BUSY <device|store> code=HUB_LOCK_TIMEOUT`. An error raised inside a hold fails as before. The run's Reservation is kept for the rerun.
- A store-IPA take that times out after the iPad install was read back is reported at stage `deliver` with a failed `store` record (`mac-ios busy: the App Store IPA was not built; the iPad's delivery stands`). The iPad stays `installed`; only the store step is red.
- Public copies stay coarse. `publicReason(receipt)` (`lib/receipt.mjs`) turns the reason of a lane receipt that recorded `contention` for the wait that failed it into `mac-ios busy: the wait for it ran out (HUB_LOCK_TIMEOUT); the run summary names who held it` for the bucket receipts, `latest.json`'s failed reason and the Bloodbank event. Holder names stay in the receipt, the summary, the log and the Event Log.

## v1.2.48

v1.2.47 plus the Mac disk fix. v1.2.47 was tagged and rolled back, never on `v1`: green-in-between's release dry run stopped in `preflight-ios` with the Mac at 14.9 of the 15 GiB floor. Everything in the v1.2.47 section below ships in this pin; install it on both hosts (`mise run hosts:install`).

### What changed

- The iOS disk check frees stale DerivedData before it refuses. Every CI checkout path gets its own Xcode DerivedData folder (`<Project>-<28 letters>`, ~200 MB each), so every iOS run of every app left one behind until the Mac hit the floor (v1.2.4 died on it too). When `preflight-ios` or the `ios` job finds less than `mac.min_free_gib` free, it removes those per-project folders, oldest first and none used within a day, until there are 5 GiB above the floor, and logs `HUB_DISK_PRUNED <n> DerivedData folder(s) unused for a day; <free> GiB free now`. Xcode's shared caches (`ModuleCache.noindex`, SDK caches) are never touched, and a disk still short after that refuses as before.

## v1.2.47

Epic 3 (deliveries survive contention) and Epic 4 (know where you stand and how long it will be), on top of v1.2.46. The Queue protocol and the Event Log format are unchanged; nothing here needs both hosts on the same hub version at the same instant, but install it on both (`mise run hosts:install`).

### What changed

- Peek under a Lease. The catch-up and the deploy's device checks read the S26 without disturbing a Lease holder.
- `S26 busy` is pending. An Android delivery blocked by a Lease goes `pending` (not failed) and the catch-up delivers it in its turn.
- The catch-up takes its turn in the FIFO with the Leases, so contention-pending builds are delivered when the line reaches it.
- A newer installed build is refused with a name: `refused` is written to the Event Log, naming the Leases that held the device since the build went pending (`installed_by`).
- Enqueue ETA. Every ticket and `request` event carries an `eta` (`{lo_ms, hi_ms, low_data}`): the 25th to 75th percentile of matching past holds in the last `eta_window_days` (30), added along the Queue; fewer than `eta_low_data_min_holds` (20) matching holds widens it to the stated durations and sets `low_data`. Two new keys in the `queue` block of `policy.json`.
- Wait line. A waiter prints `HUB_LOCK_WAIT <name> held by <holder> position=<n> eta=<lo>-<hi>[ low-data]` in the job log (deploy jobs) or on stderr (`hub-device lease --wait`), only when its position changes or the range moves by more than a minute; at most one recompute every 5 minutes.
- `hub-device status`. Every waiter is listed by kind (Lease, `JOB <repo> run <run> job <job>`, `CATCH-UP`) with its position and live ETA, and a RESERVATIONS section shows each run's place, grace state and expiry. `--json` adds `waiters[].kind/repo/run/job/eta` and `reservations[]`; no key is renamed or removed. Status stays read-only and answers from one windowed read of the Event Log.
- `hub-device release job:<repo>#<run>.<attempt>/<job>` exits 2 with `HUB_DEVICE_JOB_ID ...` naming the run to cancel (`gh run cancel <run> --repo <repo>`). It never touched a job before; now it says why.

### Wording change you will see

The wait line is new text on the same `HUB_LOCK_WAIT <name> held by <holder>` prefix: it now ends with `position=<n> eta=<lo>-<hi>`. A caller that matched the whole line must match the prefix only (the old wait-line test was updated as an intended text change, AD-17).

- `hub-device release job:<repo>#<run>.<attempt>/<job>` used to exit 0 with `HUB_DEVICE_NOT_HELD`; it now exits 2 with `HUB_DEVICE_JOB_ID`. A script that checked `release`'s exit code for a job id now sees 2.

## v1.2.46

Freeze set of the v1a queue protocol (design AD-20): the Event Log from v1.2.45 (tagged, rolled back, never on `v1`), and all of Epic 2. v1.2.44 was the last release on `v1`; this one carries every change since it, in one pin so no pin ever holds half the format.

### Read this first: fairness needs this pin

Fairness holds only among runs on this pin and later. A run still on an older pin (a caller pinned to an exact earlier tag, or a job that started before `v1` moved) does not write tickets, Reservations or events in the new format and does not look at them, so it can take a device ahead of the Queue. Older pins age out within 30 days: every app's caller pins `@v1`, so each new deploy run moves to this pin by itself, and the last holdout is a run started from an old exact tag. Until then, treat the Queue as advisory for those runs. Install this release on both hosts (`mise run hosts:install`, from a clean checkout at the tag, on big-chungus and on the Mac): the Mac's `hub-device` needs the `reservation release` verb, and a Mac without it logs `HUB_RESERVATION_RELEASE_SKIPPED` and leaves the Reservation to its 180-minute ceiling.

### What changed

- Event Log. Every hold of a lock, ticket and Reservation writes one JSON line (`format`, `ts`, `host`, `host_id`, `hub_version`, `event`, `lock`, `hold_kind`, `claimant`, waits and holds in ms) to `HUB_EVENT_DIR/<YYYY-MM>.jsonl` on the host that owns the lock. Events are `request`, `acquire`, `release`, `reclaim` (a dead holder's lock taken back), `timeout`, `cancel`, `claim`, `grace`, `expiry`, `extend`, each written once by whoever won the unlink or rename that decided it. `hub_version` is the hub ref the run pinned.
- Queue. Deploy jobs (`plan`, `android`, `ios`), the iPad catch-up and every Lease take a ticket and are served first come, first served on `adb`, `s24`, `mac-ios` and the emulator slots. One `queueView` answers who holds, who waits and in which place; a ticket carries a machine identity and a liveness order, so a dead waiter never blocks the line.
- Reservations. The gate reserves `adb` for a run with an Android lane, and `preflight-ios` reserves `mac-ios` on the Mac, when the run starts, so a build does not lose its place while it compiles. Only the first Reservation in line blocks, and only for `grace_min` (10); the ceiling is `reservation_ceiling_min` (180). A lane releases its Reservation inside its last hold, before the lock is freed; `announce` backstops it, over ssh on the Mac. By hand: `hub-device reservation release --run <owner--repo--run> [--name adb|mac-ios]`. A failed lane keeps its Reservation, so `gh run rerun --failed` is served at the original place.
- Deadlines. A deploy job that waits in the Queue stops at `job_start + timeout - wait_margin_min - hold_allowance_min` and reports its own reason before GitHub kills it (a killed job ends `cancelled`: no `finally`, no `deliver-*`).
- Lease cap. A Lease on `adb` (the S26) or `mac-ios` may run at most `deploy_target_lease_max_min` (60 minutes). `hub-device lease s26 --for 2h` exits 2, naming the cap and pointing at `s24` or an emulator; `lease phone` over the cap skips the S26. `s24`, emulators and every other lock keep the 48 h limit. A Lease can be extended only by `extendLease`, which refuses while anyone waits (`HUB_LEASE_EXTEND_REFUSED`); there is no CLI verb yet (v1b). An owner rewrite checks the lock is still the writer's (`HUB_LEASE_LOST`).
- Concurrency groups. `android` and `ios` no longer carry a GitHub `concurrency` group (AD-21): the Queue orders them, and GitHub's group could cancel a pending job the Queue still held a place for. `plan`, `ios-export` and `deliver-*` keep theirs.

### Wording change you will see

A queued timeout now names the holder and, when anyone waits ahead, each waiter with its place, for a deploy job and the catch-up as well as a Lease; and every `withLock` and Lease timeout carries the code `HUB_LOCK_TIMEOUT`.

- Before (v1.2.44), a Lease: `host lock adb has 2 waiters ahead of lease <id> (held by ...); gave up after Ns`. A deploy job: `host lock adb is held by ...; gave up after N min. Another deploy is using the device; run again when it finishes.`
- Now, all three: `host lock adb is held by <holder>; 2 waiters ahead of <self> (1. <holder> (why), 2. ...); gave up after ...`; a deploy job's with its own deadline ends `gave up after M min, ahead of this job's N-minute timeout. ...`. With nobody ahead the wording is the old `host lock adb is held by ...; gave up after ...`.

Anything that matches the old sentence by regex must match the code (`HUB_LOCK_TIMEOUT`) instead. The catch-up's own idle checks were moved with it and still match.

### Proven by

`mise run check` is green on Node 24 and Node 26 (`mise run --tool node@26 check`; `check.yml` runs both), including two event-sequence tests: a whole deploy run (claim, request, acquire, release, Reservation release, every event stamped with the pinned `hub_version`) and a timed-out wait (request, timeout, `HUB_LOCK_TIMEOUT`, holder and waiters named).
