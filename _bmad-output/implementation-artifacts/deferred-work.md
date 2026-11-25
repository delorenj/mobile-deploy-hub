# Deferred Work

- source_spec: `_bmad-output/implementation-artifacts/spec-1-2-exactly-once-release-reclaim-tombstones.md`
  summary: `hub-device status` still reaps dead emulator leases, and since Story 1.2 that reap's `releaseLease` writes a `release` event, so status is not yet read-only for the Event Log.
  evidence: `hub-device.mjs` `main()` calls the emulator `reap()` before `status`; `reap()` calls `releaseLease` on `emulator-<n>` (Queued). Story 1.3 (MOBI-26) moves the reap to the emulator acquire paths; no release ships between 1.2 and 1.5.
- source_spec: `_bmad-output/implementation-artifacts/spec-2-1-ticket-format-v1-machine-identity.md`
  summary: Owner liveness in `staleness` (`owner.holder_pid`, `owner.pid`) still takes any safe integer as a pid, so an `owner.json` with pid 0 or -1 reads as alive (`kill(0, 0)` succeeds). Tickets were fixed in the independent review; owners are untouched.
  evidence: Pre-existing before Story 2.1 (the old owner check was the same); an owner is written only by `lock.mjs` from `process.pid`/a real holder pid, so only a hand-edited or corrupt `owner.json` hits it. Fold into Story 2.2/2.3 owner parsing if it recurs.
- source_spec: `_bmad-output/implementation-artifacts/spec-2-2-one-queue-view-and-tries.md`
  summary: A queued Lease's ticket (the emulator gate's included) still carries `pool: null, request: null`, and `queueView` entries therefore cannot yet tell a Pool request's waiters from a plain Lease's.
  evidence: Story 2.2 writes the Pool-level events and tags the slot try, but a gate ticket is a lock-level wait. Position and ETA (FR-15/16) are the first readers that need the ticket tag; add it there with the AD-3 keys that already exist.
- source_spec: `_bmad-output/implementation-artifacts/spec-2-2-one-queue-view-and-tries.md`
  summary: A phone Pool request that probes an away phone writes one Pool-tagged `acquire` (plus its `release`) per probe and then its closing `timeout`; a phone request that fails after a take (`HUB_LEASE_CANCELLED`, an abort) writes a `cancel` after its tagged `acquire`. A consumer pairing `request` with one `acquire` or `timeout` per request id sees two endings for those requests.
  evidence: Story 2.2 tags the successful try's own lock-level `acquire` (so a hold is never counted twice) and `takeAnyPhone` settles on every error; `provision` settles only while no slot is taken. Pinned by the away sequence in `hub-device.test.mjs`. Fix when Holocene or ETA (FR-15/16) first reads Pool outcomes: either settle the phone request only when no probe was taken, or tag only the acquire of the probe that is kept.
- source_spec: `_bmad-output/implementation-artifacts/spec-2-3-deploy-jobs-and-catchup-join-the-queue.md`
  summary: `CLAUDE.md` and `AGENTS.md` (Known pitfalls) still say deploy jobs' `withLock` does not join the FIFO lease queue; the line is true of the released hub until Story 2.8 ships this epic, then it must go.
  evidence: Story 2.3 makes `withLock` on a Queued name join the Queue on main, but nothing is released before 2.8 (AD-20), so rewriting the pitfall now would describe a hub nobody runs.
- source_spec: `_bmad-output/implementation-artifacts/spec-2-3-deploy-jobs-and-catchup-join-the-queue.md`
  summary: The catch-up's idle branches in `catchup.mjs` (`:469`, `:591`) still read `error.message` with a regex; AD-5 says new code branches on `.code`. The `delivery` block (AD-15) is not written on the catch-up's ticket or events yet.
  evidence: Story 2.3 keeps the regexes on purpose (an AC: they must still match) and codes the timeout beside them. `withLock` already accepts the catch-up's `kind: 'hub-job'`; the `catchup_pending_wait` policy, `delivery {repo, run, version}` and the `refused` event belong to the Epic 3 catch-up work.
- source_spec: `_bmad-output/implementation-artifacts/spec-2-3-deploy-jobs-and-catchup-join-the-queue.md`
  summary: A job's `request`, `acquire` and `timeout` events carry `lease_id: null` (as before); the ticket carries the job id `job:<repo>#<run>.<attempt>/<job>`, so an event reader cannot join a job's events to its ticket by id.
  evidence: Story 1.4's sequence tests pin `lease_id: null` for job events, and `eventOf` sets it only for Leases. Position and ETA (FR-15/16) are the first readers that join them; they can use repo, run, attempt and job from the claimant.
- source_spec: `_bmad-output/implementation-artifacts/spec-2-3-deploy-jobs-and-catchup-join-the-queue.md`
  summary: A job or catch-up killed while it waits (a cancelled run, SIGKILL, SIGTERM) leaves a `request` event with no `timeout` or `cancel`: its ticket is pruned by the next acquirer with a forced `rmSync` and no event, and `withLock` has no signal handling. AD-9 lists `prune` among the unlink-decided events, but no epic story writes it.
  evidence: Independent review of Story 2.3 (killed a waiting `withLock` child: events read `request:a`, `request:b`, `acquire:b`). The Queue is not stranded (the dead pid is pruned); only the history has an open request. Story 2.4's deadline (the wait ends before GitHub kills the job) removes the common case; the `prune` event and its exactly-once unlink belong with the Event Log reader work (FR-15/16, FR-17).
- source_spec: `_bmad-output/implementation-artifacts/spec-2-4-wait-deadlines-that-beat-githubs-timeout.md`
  summary: A job has one absolute wait deadline (`job_start + timeout - margin - allowance`), so `ios`'s second `mac-ios` take (the store IPA, `ios.mjs:390`) that starts after that time can only succeed at once: with a busy Mac it times out immediately, though the job still has its allowance left.
  evidence: AD-12 gives one allowance per job covering both takes, and Story 2.4's AC computes one deadline from it. Epic 3 (the second take's timeout leaves the iPad delivery `installed` and only the store step reports contention) is the first reader that needs a per-take deadline; if the first take is slow in practice, compute the second take's deadline as `job_start + timeout - margin` minus the remaining hold only.
- source_spec: `_bmad-output/implementation-artifacts/spec-2-4-wait-deadlines-that-beat-githubs-timeout.md`
  summary: `deliver-android` and `deliver-ios` (timeout 45) wait on the internal `s3-<slug>` lock (`deliver.mjs:249`, 30 min) and have no `hold_allowance_min` entry, so their waits are not cut at a job deadline.
  evidence: The story names plan, android and ios only (AD-12), and an `s3-*` name is the bare path with no Queue (AD-4), so the deadline never applied there; a 30 min wait inside a 45 min job leaves 15 min, so it ends first. Add `deliver-*` to the queue block (and `HUB_JOB_TIMEOUT_MINUTES` to the workflow) only if a deliver wait ever lengthens.
- source_spec: `_bmad-output/implementation-artifacts/spec-2-5-reservations-keep-a-runs-place.md`
  summary: Nothing ends a Reservation yet: until Story 2.6 a run's Reservation lives to its 180 min ceiling, and `hub-device status` neither lists it nor shows its grace.
  evidence: Story 2.5 only creates, reuses, prunes at expiry and honours Reservations (AD-7); the release rules, `announce`, the Mac's `reservation release` verb and the status Reservations section are Stories 2.6 and 4.3. Nothing is released before 2.8 (AD-20), so no hub runs with a Reservation that cannot end.
- source_spec: `_bmad-output/implementation-artifacts/spec-2-5-reservations-keep-a-runs-place.md`
  summary: A Lease taken inside a run (a `hub-device lease` from a job with the runner's `GITHUB_*` variables) gets no same-run passthrough: it waits behind the run's own Reservation like any Claimant. Only Job Holds (`withLock`) are served at the Reservation's place.
  evidence: AD-7 and the Story 2.5 AC name Job Hold requests; no deploy job takes a Lease. Revisit if a job ever leases `adb` or `mac-ios` through `hub-device`.
- source_spec: `_bmad-output/implementation-artifacts/spec-2-5-reservations-keep-a-runs-place.md`
  summary: A job ticket and a Reservation with the same millisecond sort ticket first (a digit sorts before `r` in `<ms15>-reservation-<key>`), and a pinned hub orders only tickets, so a Claimant that asks in the very millisecond a Reservation is made can stand ahead of it.
  evidence: AD-6 breaks ties on the full name string; the tie is a one-in-a-million coincidence for a human-paced queue and harmless (the ticket really did ask first). Not worth a rule.

## From the independent review of Story 2.5 (MOBI-34)

- A grace stamp that fails for a reason other than ENOENT or EEXIST (a directory the caller cannot write) is swallowed, so the head Reservation would block until its ceiling. Every lock directory belongs to one user today; when that stops being true, make an unwritable Reservation count as grace over.
- A grace stamp can land in a re-reserved directory of the same key if an expiry and an immediate rerun fall between the view and the stamp; the stamp only starts that Reservation's grace early.

## From Story 2.6 (MOBI-35)

- source_spec: `_bmad-output/implementation-artifacts/spec-2-6-reservations-end-when-the-run-is-done.md`
  summary: A lane releases its Reservation inside its last hold, when that hold ends well, so a step that fails after the hold (the android job's Play or Release step, the ios lane's IPA send or TestFlight upload) leaves the run's Reservation already gone: `gh run rerun --failed` then asks like any Claimant, at the back of the queue.
  evidence: AD-7 wants release on lane success and the rename before the lock is freed; those two only meet inside the hold, and the ios lane's steps after its last take run for minutes while a Reservation would block the next Claimant for its grace. The android lane's own steps after the hold are seconds; Play and Release are separate steps. Revisit if reruns of a post-hold failure turn out to matter; the fix is a lane-end release (outside the hold) for that case.
- source_spec: `_bmad-output/implementation-artifacts/spec-2-6-reservations-end-when-the-run-is-done.md`
  summary: The Android contention-pending release has no call site: nothing produces a "contention-pending" outcome yet (a `HUB_LOCK_TIMEOUT` of the android hold is still a red job), and an iOS Reservation of a run whose plan turns the iPad lane into `skip-lost` is left to the ceiling (the Mac is offline anyway).
  evidence: FR-30 pending-not-red is Epic 3 (the spine's `HUB_LOCK_TIMEOUT --> PEND` edge); when it adds that outcome it calls `releaseFor('adb', ...)` there. `announce` already releases a successful android job, which a pending S26 is.
- source_spec: `_bmad-output/implementation-artifacts/spec-2-6-reservations-end-when-the-run-is-done.md`
  summary: The Mac release over ssh uses `~/.local/bin/hub-device`, the wrapper `install.sh` writes, so it works only once `hosts:install` (Story 2.8) has put a hub with the verb on the Mac; until then `announce` logs `HUB_RESERVATION_RELEASE_SKIPPED` and the Mac's own ios lane release (inside the `mac-ios` hold, local to the Mac) is what ends it.
  evidence: AD-7 ("a Mac release without the verb is logged and left to the ceiling"). The pinned `actions/hub@vX` runs `announce` on big-chungus with the new code, but the Mac's installed `hub-device` is whatever `hosts:install` last put there.

## From Story 2.7 (MOBI-36)

- source_spec: `_bmad-output/implementation-artifacts/spec-2-7-no-extension-while-others-wait-deploy-target-leases-capped.md`
  summary: Nothing calls `extendLease` yet (the `hub-device extend` verb and Jarad's override are v1b/v1c), so no live Lease is extended on any host; and `hub-device lease s26|phone --for` over 60 min is now a usage error, so an adapter that holds the S26 for hours (the README's green-in-between loop-ship hold took `--for 12h`) must move to `s24`, an emulator, or re-lease within the cap.
  evidence: AD-16 fixes the rule v1b's verb will call; the cap is the story's explicit AC and is policy, so a longer deploy-target hold is a hub release. Nothing is released before Story 2.8 (AD-20), so no adapter has hit the refusal yet; the adapter's own repo is outside this one.
- source_spec: `_bmad-output/implementation-artifacts/spec-2-7-no-extension-while-others-wait-deploy-target-leases-capped.md`
  summary: An owner rewrite is checked twice (before the temp file is written and right before its rename into place), but a window of one `rename` remains in which the lock can be reclaimed and re-taken between the last check and the rename, so a rewrite could land in the new holder's directory.
  evidence: `rename` of a file into a directory cannot be made conditional on the directory's identity in `node:fs`. The window is microseconds, the rewrites are the phone-connect update and v1b's extension, and the new holder's next read-back (`updateLease`'s final `lease_id` check) reports it. A lock-level mutex would be a second protocol (AD-1).
- source_spec: `_bmad-output/implementation-artifacts/spec-2-7-no-extension-while-others-wait-deploy-target-leases-capped.md`
  summary: Two extensions racing each other both read the same expiry and both write it plus their own `forMs`, so one extension is lost and two `extend` events exist. A Lease older than this story records no `lock_ino`, so for it the lease id alone guards a rewrite.
  evidence: v1a has no caller of `extendLease`; v1b's verb is one person at a shell. Serialising extenders would need a lock beside the lock, which AD-1 forbids; the cap and the waiter check are re-evaluated by each call from its own read.
- source_spec: `_bmad-output/implementation-artifacts/spec-2-7-no-extension-while-others-wait-deploy-target-leases-capped.md`
  summary: A refused acquire on a deploy target is `HUB_LEASE_TOO_LONG`, a code the spine does not list (AD-5 names `HUB_LEASE_EXTEND_REFUSED` for extensions and says nothing of acquire).
  evidence: The AC says the acquire is "refused" without a code; reusing `HUB_LEASE_EXTEND_REFUSED` would name an extension that never happened. Additive and branched on by `hub-device` only; fold into AD-5's list at the next spine edit.
- source_spec: `_bmad-output/implementation-artifacts/spec-2-7-no-extension-while-others-wait-deploy-target-leases-capped.md`
  summary: The emulator's ready-time rewrite can no longer move `expires_at` later (AD-16), so when AVD creation plus boot overran the slot Lease's 2-minute allowance, the Lease the maker prints lasts less than `--for` from ready.
  evidence: The slot is taken for boot + `--for` + 2 min and the rewrite sets `now + --for`, which is earlier unless prep + boot exceed boot timeout + 2 min; the clamp keeps the slot's own expiry. Widening the slot allowance is a tuning decision for the emulator story; the fake-emulator suite cannot reach the branch.

## From Story 2.8 (MOBI-37)

- source_spec: `_bmad-output/implementation-artifacts/spec-2-8-ship-the-freeze-set.md`
  summary: `AGENTS.md` (and `CLAUDE.md`, its symlink) still say deploy jobs' `withLock` does not join the FIFO lease queue; after v1.2.46 is released and `hosts:install` has run on both hosts the line is false and must go (Known pitfalls, the starvation line). 2.8 leaves the instruction file unedited.
  evidence: `docs/hub-releases.md` v1.2.46 now says the Queue serves every Claimant. The same note was filed under Story 2.3; nothing is released until the parent runs the release.
- source_spec: `_bmad-output/implementation-artifacts/spec-2-8-ship-the-freeze-set.md`
  summary: The emulator fixture's boots are real child processes and a hosted runner needs ~5 s per lease (probably the boot loop's 5 s adb re-registration; not proven), so `tools/device/emulator.test.mjs` takes minutes there; other tests in it still take a short real `--for` or wait on wall-clock expiry (the reaper and `run emulator reaps` tests use 1 s leases).
  evidence: Only `status is read-only` (3 s lease) and `dies while booting` (wording race) failed on the runner; the others have one lease each, so a slow take cannot expire a neighbour. A suite-wide fake clock for the emulator tests would remove the class.

### DW-1: A lock-timeout failure in a lane that records no `contention` (plan's `adb` Peek wait, gate, preflight-ios) still puts the holder-naming `host lock <name> is held by …` message into public copies.
origin: spec-deferred 3d11c5a8124e
location: tools/ci/lib/receipt.mjs publicReason; tools/ci/commands/plan.mjs:250
source_spec: `spec-3-5-ios-contention-is-red-and-says-who.md`
severity: low
reason: publicReason (tools/ci/lib/receipt.mjs) redacts only when the receipt carries `contention`, which only the android and ios lanes write. This behaviour predates story 3.5: those lanes' raw lock messages already reached the bucket receipts and announce. One level up would be to have every Queued withLock caller record `contention` on its timeout, or to key publicReason on the AD-5 prefix alone.
status: open

### DW-2: The repo's agent rules ("Where things are" in AGENTS.md, read through the CLAUDE.md symlink) still name hub-device.mjs as the place to extend device checkout and do not mention
origin: spec-deferred c104e71be151
location: AGENTS.md (Where things are)
source_spec: `spec-5-1-one-claims-library-under-an-unchanged-cli.md`
severity: low
reason: After this story every action and rule lives in claims.mjs (AD-24); an agent that follows the "Where things are" line would add new take/release logic to hub-device.mjs, the front door that must stay parsing and output only. The fix edits an agent-context file, so it is out of this build's reach.
status: open

### DW-3: The emulator reaper-failure warning now reaches stderr through the new ctx.warn seam, and no test makes reap throw and pins the text or the silent default.
origin: spec-deferred a52b30589b5f
location: tools/device/claims.mjs reapBeforeAcquire
source_spec: `spec-5-1-one-claims-library-under-an-unchanged-cli.md`
severity: low
reason: claims.reapBeforeAcquire calls ctx.warn?.(...); main supplies warn => stderr('hub-device: warning: ' + message). No test in tools/ has the reaper fail (grep "reaper failed" hits only claims.mjs). The gap predates the move (the old stderr call was untested too), and the path is warning-only.
status: open

### DW-4: An android_extra phone other than s24 (for example "Pixel") passes the name rule but sits on a bare, non-Queued lock whose events are dropped and whose resource is null.
origin: spec-deferred 953763633f12
location: tools/ci/lib/devices.mjs android_extra; tools/ci/lib/lock.mjs isQueued
source_spec: `spec-5-2-one-reserved-word-list-one-slug-rule-res-locks-queue.md`
severity: medium
reason: isQueued covers only the frozen v1a QUEUED set, emulator-<n> and res-<slug>, and SEED_RESOURCES maps only adb, s24 and mac-ios, so a lock named "pixel" gets no queue ticket and no events. This predates Story 5.2 (any extra phone but s24 was already bare). names.test.mjs fails when the committed devices.json gains such a phone, but a HUB_DEVICES override file does not run that test. Settling it means choosing whether devices.json may still declare new phones (then seed and queue them) or new phones must be registered as res-<slug> (then refuse unseeded android_extra names).
status: open

### DW-5: A phone listed twice by the adb server (a stale USB or offline entry plus a live host:port id) takes the first listed entry's state, so it can read offline or absent while it is usable.
origin: spec-deferred c0614269caff
location: tools/device/claims.mjs:readWire
source_spec: `spec-5-4-status-through-one-builder-with-reachability.md`
severity: low
reason: readWire matches with listed.find(...), first match wins; the v1a phonePresence had the same find-first semantics over `adb devices`, so this predates Story 5.4 (status now also derives reachability from it). Fix would prefer a `device` entry among the matches.
status: open

### DW-6: An android_extra phone other than the S24 gets resource null, and so deploy_target null, on every status row, because resourceOf's seed map is the fixed {adb, s24, mac-ios}.
origin: spec-deferred eb1821317a63
location: tools/ci/lib/lock.mjs:57 (resourceOf); tools/device/claims.mjs statusView rowsOf loop
source_spec: `spec-5-5-deploy-targets-are-marked-from-the-committed-declarations.md`
severity: low
reason: resourceOf (lock.mjs, Story 5.2) maps only the committed seed's locks, and an extra phone such as `Pixel` (lock `pixel`) already read resource null under Story 5.4. Story 5.5 only derives deploy_target from that resource. This is the known pre-existing gap where a non-S24 devices.json phone sits on a bare lock, and fixing it needs the decision on whether new phones are added in devices.json or through the Registry. seed.test.mjs and names.test.mjs fail the moment devices.json changes, so it cannot ship silently.
status: open
