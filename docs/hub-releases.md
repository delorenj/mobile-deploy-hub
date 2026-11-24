# Hub release notes

One section per hub release, headed `## vX.Y.Z`. `mise run release -- X.Y.Z` (`tools/release.mjs`) puts the section of the version it tags into that tag's annotation, above the dry-run lines (`git show vX.Y.Z`), so the notes travel with the tag. A release with no section is annotated as before. Write the section before you release: the file is tracked, the release refuses a dirty tree, and the section is read from the commit being tagged.

A section is plain text read in a terminal: everything after its heading up to the next `## ` heading. Use `###` for sub-headings and `-` lists; do not start a section line with `## `.

## v1.2.46

Freeze set of the v1a queue protocol (design AD-20): the Event Log from v1.2.45 (tagged, rolled back, never on `v1`), and all of Epic 2. v1.2.44 was the last release on `v1`; this one carries every change since it, in one pin so no pin ever holds half the format.

### Read this first: fairness needs this pin

Fairness holds only among runs on this pin and later. A run still on an older pin (a caller pinned to an exact earlier tag, or a job that started before `v1` moved) does not write tickets, Reservations or events in the new format and does not look at them, so it can take a device ahead of the Queue. Older pins age out within 30 days: every app's caller pins `@v1`, so each new deploy run moves to this pin by itself, and the last holdout is a run started from an old exact tag. Until then, treat the Queue as advisory for those runs. Install this release on both hosts (`mise run hosts:install`, from a clean checkout at the tag, on big-chungus and on the Mac): the Mac's `hub-device` needs the `reservation release` verb, and a Mac without it logs `HUB_RESERVATION_RELEASE_SKIPPED` and leaves the Reservation to its 180-minute ceiling.

### What changed

- Event Log. Every hold of a lock, ticket and Reservation writes one JSON line (`format`, `ts`, `host`, `host_id`, `hub_version`, `event`, `lock`, `hold_kind`, `claimant`, waits and holds in ms) to `HUB_EVENT_DIR/<YYYY-MM>.jsonl` on the host that owns the lock. Events are `request`, `acquire`, `release`, `timeout`, `cancel`, `claim`, `grace`, `expiry`, `extend`, each written once by whoever won the unlink or rename that decided it. `hub_version` is the hub ref the run pinned.
- Queue. Deploy jobs (`plan`, `android`, `ios`), the iPad catch-up and every Lease take a ticket and are served first come, first served on `adb`, `s24`, `mac-ios` and the emulator slots. One `queueView` answers who holds, who waits and in which place; a ticket carries a machine identity and a liveness order, so a dead waiter never blocks the line.
- Reservations. The gate reserves `adb` for a run with an Android lane, and `preflight-ios` reserves `mac-ios` on the Mac, when the run starts, so a build does not lose its place while it compiles. Only the first Reservation in line blocks, and only for `grace_min` (10); the ceiling is `reservation_ceiling_min` (180). A lane releases its Reservation inside its last hold, before the lock is freed; `announce` backstops it, over ssh on the Mac. By hand: `hub-device reservation release --run <owner--repo--run> [--name adb|mac-ios]`. A failed lane keeps its Reservation, so `gh run rerun --failed` is served at the original place.
- Deadlines. A deploy job that waits in the Queue stops at `job_start + timeout - wait_margin_min - hold_allowance_min` and reports its own reason before GitHub kills it (a killed job ends `cancelled`: no `finally`, no `deliver-*`).
- Lease cap. A Lease on `adb` (the S26) or `mac-ios` may run at most `deploy_target_lease_max_min` (60 minutes). `hub-device lease s26 --for 2h` exits 2, naming the cap and pointing at `s24` or an emulator; `lease phone` over the cap skips the S26. `s24`, emulators and every other lock keep the 48 h limit. A Lease can be extended only by `extendLease`, which refuses while anyone waits (`HUB_LEASE_EXTEND_REFUSED`); there is no CLI verb yet (v1b). An owner rewrite checks the lock is still the writer's (`HUB_LEASE_LOST`).
- Concurrency groups. `android` and `ios` no longer carry a GitHub `concurrency` group (AD-21): the Queue orders them, and GitHub's group could cancel a pending job the Queue still held a place for. `plan`, `ios-export` and `deliver-*` keep theirs.

### Wording change you will see

A deploy job's queued timeout now names the holder and the places ahead of it, and every `withLock` timeout carries the code `HUB_LOCK_TIMEOUT`.

- Before (v1.2.44): `host lock adb has 2 waiter(s) ahead of lease <id> (held by ...)`.
- Now: `host lock adb is held by <holder>; 2 waiter(s) ahead of <self> (1. <holder> (why), 2. ...); gave up after N min`; with a job deadline it ends `ahead of this job's M-minute timeout`.

Anything that matches the old sentence by regex must match the code (`HUB_LOCK_TIMEOUT`) instead. The catch-up's own idle checks were moved with it and still match.

### Proven by

`mise run check` is green on Node 24 and Node 26 (`mise run --tool node@26 check`; `check.yml` runs both), including two event-sequence tests: a whole deploy run (claim, request, acquire, release, Reservation release, every event stamped with the pinned `hub_version`) and a timed-out wait (request, timeout, `HUB_LOCK_TIMEOUT`, holder and waiters named).
