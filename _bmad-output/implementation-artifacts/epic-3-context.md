# Epic 3 Context: A busy phone doesn't fail the deploy

<!-- Generated from planning artifacts. Regenerate with compile-epic-context if planning docs change. -->

## Goal

When the S26 is held, a deploy run should still learn the installed version without disturbing the leaseholder, and a delivery whose wait runs out should go pending instead of turning the run red. The catch-up then installs the pending build in its turn. If a newer build is already on the device, the catch-up refuses the stale one and the refusal names who installed the newer one. iOS cannot go pending in v1a, so its contention is a clear red job that names the holders.

## Stories

- Story 3.1: Peek at the S26 without disturbing a Lease
- Story 3.2: A blocked Android delivery goes pending
- Story 3.3: The catch-up delivers contention-pending builds in its turn
- Story 3.4: A newer installed build is refused with a name
- Story 3.5: iOS contention is red, and says who

## Requirements & Constraints

- Plan reads the installed version through a Peek: a short read-only device query. It never waits behind a Lease or behind its own run's Reservation. It still waits in the Queue for a Job Hold held by another deploy.
- If the device is unreachable or absent, the version is `unknown`. Plan proceeds and the downgrade guard falls to install time.
- When an Android delivery's wait budget runs out, the run stays green. The delivery is pending and the blocking Holds are named in the receipt and the Event Log. The Play upload and the release proceed for a contention-pending build. This is an intended change, and the receipt test must assert it.
- Public data stays coarse. `latest.json` gets only the public reason `S26 busy` (or a coarse `skipped` reason), uses the frozen status enum and adds no keys, so older catch-ups still parse it. Holder identity goes only to receipts and the Event Log.
- The catch-up installs a pending build in its turn. If the device's version has moved above the planned one, the delivery is refused, the version is not reused, and the refusal names who installed it. It says `installed_by: unknown` when the Event Log has no Lease holder since the pending event.
- iOS (a known PRD deviation, accepted by Jarad 2026-11-24 as AD-22; the receipt uses the same `contention` record as Android): an `ios-lane` wait that runs out fails the iOS job with `HUB_LOCK_TIMEOUT`, and the summary names the holders and the waiters ahead. If the second take (store IPA) times out after the iPad install succeeded, the iPad stays `installed` and only the store step reports contention. A full fix needs splitting the build from the lane hold, which is deferred.
- The catch-up's short attempt and long pending wait are policy values, and its timeout is a `hub-job` event, never a deploy or starved-Claimant event.
- Node 24 ESM `.mjs` only. Tests are hermetic, use a fake exec and never reach the device, bucket or host state.

## Technical Decisions

- Peek and the gate's `quickS26` probe, while `adb` is held by a Lease, take no lock and run only `adb -L tcp:127.0.0.1:<port> -s <id> shell dumpsys package <pkg>`. The `-L` form refuses to launch a server. The port and id come from the Lease's recorded `adb_port` and `adb_id`, else the default server. `RUNNER_TRACKING_ID` is blank. Never run `start-server`, `connect` or mDNS.
- A test with a fake exec must show that none of those argv forms is ever issued under a Lease.
- `android.mjs` catches `HUB_LOCK_TIMEOUT` on `adb`, marks the delivery `pending` and appends a `timeout` event with `reason: delivery-pending` and `blocked_by`. It then releases the run's Reservation (Epic 2). The pinned event sequence is claim, request, timeout(delivery-pending), Reservation release.
- Pending-delivery bookkeeping spans `android.mjs`, `latest.mjs`, the receipt and `catchup.mjs`.
- The catch-up enqueues on `adb` as `kind: hub-job` only when it has a pending build for that Resource. Ticket and events carry `delivery {repo, run, version}`.
  - With a contention-pending build it waits up to `catchup_pending_wait_min`, bounded by its pass limit.
  - Otherwise it waits only `catchup_attempt_s`.
  - On timeout it removes its ticket and reports `HUB_CATCHUP_IDLE`.
  - On success the delivery becomes `installed` and its `acquire` and `release` events carry `delivery`.
  - Story 3.3 adds both keys to the strict `queue` policy block.
- On the catch-up's `ahead` path (`catchup.mjs` around lines 148, 377 and 656), it writes a `refused` event naming the Lease holders on that lock since the pending event, read from the Event Log. `latest.json` records `skipped`.
- iOS contention writes a `timeout` event on the Mac with `reason: ios-lane-contention`, into the Mac's own Event Log. The job deadline reserves the allowance for both `mac-ios` takes (Story 2.4). The Mac's Queue is visible only on the Mac in v1a.
- Install-time newer-device refusal (`android.mjs:126`) remains the downgrade guard, and the catch-up's `ahead` check covers builds that went pending.

## Cross-Story Dependencies

- Epic 3 builds on Epic 2: coded `HUB_LOCK_TIMEOUT`, Reservations and their release (Stories 2.4 to 2.6), the `hub-job` Queue join for the catch-up (Story 2.3) and the deadline allowances (Story 2.4). It uses Epic 1's event writer and the Event Log.
- Story 3.1 stands alone. Story 3.2 produces the pending state that 3.3 consumes. Story 3.4 refines 3.3's `ahead` path and reads Lease holders from the Event Log.
- Story 3.5 is independent of 3.1 to 3.4 and shares only the coded timeout and the deadline allowance.
- Epic 4 (position and ETA) uses the Queue view that these stories wait in.
