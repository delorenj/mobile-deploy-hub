---
title: 'Story 2.6: Reservations end when the run is done with the device'
type: 'feature'
created: '2026-11-24'
status: 'done'
route: 'dispatch'
review_loop_iteration: 0
baseline_commit: '1996a3588dba6d66d585b4db7e5371347e09b89b'
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-2-context.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** After Story 2.5 nothing ends a Reservation, so the next Claimant waits behind a run that no longer needs the device until the 3 h ceiling. MOBI-35, epic MOBI-29, FR-9, AD-7, AD-17.

**Approach:** `lock.mjs` gains `releaseReservation` (rename the directory to `.released-<key>-<ms>`, then the winner appends `release`; nothing reserved is a no-op). A lane that ends well releases its own Reservation: `withLock` takes an `endsReservation` option and renames the Reservation before the run's lock is freed. `plan` releases `adb` when the run skips the Android lane. `announce` releases finished lanes as a backstop: `adb` locally, `mac-ios` over `ssh hub-mac` running the installed `hub-device reservation release --run <key>`. A new `hub-device reservation release --run <key>` verb does the release through `lock.mjs`.

**Decisions (autonomous, pre-approved):** Release is never fatal and never `rm` over ssh. A failed lane never releases (grace and the ceiling end it, so `gh run rerun --failed` keeps its place: its job asks at the Reservation's place from Story 2.5). The verb takes `--run <key>` (validated) and an optional `--name adb|mac-ios`; without it every reservable name on this host. It prints `HUB_DEVICE_RESERVATION_RELEASED <name> <key>` per release or `HUB_DEVICE_RESERVATION_NONE <key>`, exit 0; `--json` gives `{run, released: [{name, key}]}`. A release event is `release` with `hold_kind: reservation`, and carries the run's attempt and job only when the releaser is that run. A Mac without the verb (old hub-device) is logged `HUB_RESERVATION_RELEASE_SKIPPED` and left to the ceiling. The Android contention-pending release belongs to Epic 3, which adds that outcome (nothing produces it yet); `announce` already covers it as a successful job. No policy key.

## Boundaries & Constraints

**Always:** Node 24 ESM, `node:` builtins. Only `lock.mjs` mutates Reservation paths and appends their events. New state is none: the layout is Story 2.5's. Tests hermetic (temp `HUB_LOCK_DIR`/`HUB_EVENT_DIR`, injected clock, releaser and ssh runner seams). Existing `hub-device` commands, exit codes, lines and `--json` shapes stay; only the verb and one USAGE clause are added. No timer.

**Never:** `extendLease` or the Lease cap (2.7), a status Reservations section (4.3), a release or `hosts:install` (2.8), `rm` over ssh, a change to `templates/deploy.yml` or the workflow, a new policy key.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Release | live Reservation of the run | directory renamed to `.released-<key>-<ms>`, deleted, one `release` event; a later grace stamp is ENOENT and silent | N/A |
| Nothing reserved | no directory, or already released | `{status: 'none'}`, no event, verb exits 0 and prints `HUB_DEVICE_RESERVATION_NONE` | N/A |
| Two releasers | lane and announce at once | one rename wins and appends the event | loser silent |
| Android lane | success or pending (S26 away) | released inside the hold, before `adb` is freed | thrown install, readback or version error: kept |
| iOS lane | last take ends, no device error | released inside that take before `mac-ios` is freed | `HUB_IPAD_FAILED` or a throw: kept; a store-build app releases after its second take |
| Plan | run skips the Android lane | `adb` released | N/A |
| Announce | android `success` | local release of `adb` | logged, never throws |
| Announce | ios `success` | `ssh hub-mac '~/.local/bin/hub-device reservation release --run <key> --name mac-ios'` | verb missing: `HUB_RESERVATION_RELEASE_SKIPPED`; ssh down: `HUB_RESERVATION_RELEASE_FAILED`; both left to the ceiling |
| Failed lane | job `failure` | nothing released | a rerun is served at the original place |

</frozen-after-approval>

## Code Map

- `tools/ci/lib/lock.mjs` -- `retireReservation` (reuse with `as: 'release'`), `readReservation`, `runKey`, `RESERVABLE`; new export `releaseReservation(name, {env, now, hostId, key, reason})`; `withLock` / `queuedLock` / `runHeld` gain `endsReservation` (boolean or function, honoured only after a successful `fn`, called before the lock is retired).
- `tools/ci/commands/common.mjs` -- `reserveFor` neighbour: `releaseFor(name, {releaser, env, log})`, never throws, logs `HUB_RESERVATION_RELEASED`.
- `tools/ci/commands/android.mjs` -- the S26 hold passes `endsReservation: true`. `tools/ci/commands/ios.mjs` -- the last `mac-ios` take passes a closure that is false after a device error.
- `tools/ci/commands/plan.mjs` -- `releaser` seam; releases `adb` when `!scope.android`.
- `tools/ci/commands/announce.mjs` -- `releaseFinished`: android `success` local, ios `success` over ssh (`runner` seam, `runBounded` options as `metered.mjs`: `BatchMode=yes`, `ConnectTimeout=15`).
- `tools/device/hub-device.mjs` -- `reservation release --run <key> [--name N] [--json]`; `run` and `name` flags.
- Tests: `tools/ci/reservation.test.mjs` (lock), `tools/device/hub-device.test.mjs` (verb), plan/announce/android/ios lane tests as fit. `README.md`, `deferred-work.md`.

## Tasks & Acceptance

**Execution:**
- [x] `tools/ci/lib/lock.mjs` -- `releaseReservation`; `endsReservation` in `withLock` -- AD-7 rename before the lock is freed
- [x] `tools/ci/commands/common.mjs`, `android.mjs`, `ios.mjs`, `plan.mjs` -- lane releases per the table
- [x] `tools/ci/commands/announce.mjs` -- finished lanes released, Mac over ssh
- [x] `tools/device/hub-device.mjs` -- the `reservation release` verb
- [x] tests for the matrix, `README.md`, `deferred-work.md`

**Acceptance Criteria:**
- Given a Reservation, when it is released, then the directory is renamed to `.released-<key>-<ms>` before the run's lock is freed and a later grace stamp fails with ENOENT and is ignored.
- Given the end of a lane, when it finishes, then android releases on success or pending, ios on success, plan when the run skips Android, and a failed lane never releases.
- Given `announce`, when a lane ended in success or pending, then it releases that lane's Reservation locally, runs `ssh hub-mac '<installed hub-device> reservation release --run <key>'` for `mac-ios`, never runs `rm` over ssh, and logs a Mac without the verb and leaves it to the ceiling.
- Given `hub-device reservation release --run <key>`, when it runs, then it releases through `lock.mjs`, exits 0 when nothing is reserved, and prints a `HUB_DEVICE_*` line.
- Given `gh run rerun --failed` of a failed android job within the ceiling, when the job asks for `adb`, then it is served at the original Reservation's place.

## Implementation Notes

- `lock.mjs`: `releaseReservation(name, {env, now, hostId, key, reason})` reads the Reservation of `key` (default: this run) and calls the Story 2.5 `retireReservation` with `as: 'release'` (rename, put-back check, delete, event). It never throws, and an unreadable record is left alone (its owner may be writing it). `withLock(..., { endsReservation })` is honoured in `runHeld`'s `finally`, only after a hold that did not throw and only for a Queued name, before the lock is retired; it may be a function that decides after the hold.
- Android: the S26 hold passes `endsReservation: true` (every return inside it is success or pending; every failure throws). iOS: the last `mac-ios` take passes `() => !deviceError && !needsStoreTake`; the store build's second take passes `true`.
- `plan` releases `adb` right after it computes its scope when the Android lane is out. `announce` calls `releaseFinished` first (before anything that can throw): android `success` local, ios `success` over ssh with `BatchMode=yes`/`ConnectTimeout=15` and a 40 s bound. Verb-missing is read from `usage:` or exit 2 or 127.
- `hub-device reservation release --run <key> [--name N] [--json]`; the key matches `owner--repo--run`; `release` events of the verb carry `reason: released`, a lane's `done`, a plan's `skipped`.
- `completion.test.mjs` injects a no-op releaser and runner into `announce` so a run-shaped env never touches ssh or the real lock dir.
- Deviation (named in `deferred-work.md`): a lane releases inside its last hold, so a step that fails after the hold leaves nothing to keep for the rerun. No deviation from the spine's rules otherwise.

## Spec Change Log

None. No loopback.

## Review Triage Log

In-session review of the diff against AD-7 and AD-17.

| Finding | Verdict | Evidence |
|---|---|---|
| A release racing a rerun's `reserve` deletes the new Reservation | false | `retireReservation` puts back a directory whose `reserved_at` differs from the one judged; tested in Story 2.5 and by the six-process release test |
| Announce's ssh runs in tests | high, fixed | `completion.test.mjs` builds a run-shaped env with `ios` success; it now injects `releaser` and `runner` |
| `announce` throws before releasing | false | `releaseFinished` runs first and is wrapped; a release failure only logs |
| An injection through the run key into the ssh command | false | the key is `runKey(env)`: GitHub-allowed characters only; the verb validates `--run` too |
| Failure after the last hold loses the place | low | named in `deferred-work.md`; the table's "failure: never" holds for every failure inside the hold |
| `release` events confuse an Event Log reader | false | every Reservation event carries `hold_kind: reservation`, as `claim`, `grace` and `expiry` do |

## Review

Self-review, one pass; no patches needed beyond the announce test seam. `heavy mise run check` green: 600 tests, 0 fail.

## Review (independent)

Adversarial pass over `e6b69cb` against the epics-v1a Story 2.6 ACs, AD-7, AD-9 and AD-17.

Checked and held: the rename-before-free order (`runHeld`'s `finally`, release event before the job's); one `release` event under six racing processes; ENOENT on a late grace stamp (the test releases from inside `startGrace`); the put-back of a Reservation made after the one judged; an unreadable record never taken; android success and S26-away release inside the hold, every failure keeps it; ios keeps it across a device error and across the first take of a store build; plan releases only when `scope.android` is false; `announce` runs first, never `rm`, ssh argv is a fixed shape over a validated key and host, an old Mac verb is `SKIPPED` and a dead Mac `FAILED`; no new on-disk path (the layout is Story 2.5's, so v1.2.43 bare-`mkdir` callers and ticket readers never see `.released-*`); tests are hermetic (temp lock and event dirs, injected releaser and ssh runner, `completion.test.mjs` injects both); no `release` consumer exists in the tools that a `hold_kind: reservation` release could confuse.

| Finding | Verdict | Evidence |
|---|---|---|
| `--run` and `--name` were added to the global flag set, so `hub-device status --run X` or `lease s26 --name Y` stopped being exit 2 "unknown flag" and were silently accepted | confirmed, fixed | AD-17 keeps exit codes; `main` now refuses both outside `reservation`; test `--run and --name are the reservation verb's flags alone` |
| The pending-S26 android release had no test (only the success path did) | confirmed gap, fixed | new v3 test: plan keeps the Reservation, the pending lane releases it, events `claim`, `release` |
| `announce`'s log line and the README hard-coded "the 3 h ceiling" outside `policy.json` | confirmed nit, fixed | wording now names the ceiling without its value |
| README claimed a failed lane is always served at the original place | confirmed overstatement, fixed | the README now names the post-hold failure case already in `deferred-work.md` |
| A step that fails after a lane's last hold (Play, Release, IPA send, TestFlight) finds the Reservation released, so a failed-job rerun queues normally | dismissed as a deviation, kept in `deferred-work.md` | releasing outside the hold would leave a free lock with the finished run's Reservation first in line, starting a grace that blocks the next Claimant, which is the harm AD-7's rename-before-free exists to prevent; the two AC lines only meet inside the hold |
| `~/.local/bin/hub-device` is not literally absolute | dismissed | the wrapper `install.sh` writes lives there, the remote shell expands `~`, and `completion.mjs` addresses the Mac's catch-up the same way |
| Two retires of one key in the same millisecond choose one `.released-<key>-<ms>` name | dismissed | needs a release, a rerun's re-reserve and a second retire inside one ms; the loser's rename fails and it returns false, nothing is lost |

## Verification

**Commands:**
- `node --test tools/ci/reservation.test.mjs tools/device/hub-device.test.mjs` -- expected: all pass
- `heavy mise run check` -- expected: green
