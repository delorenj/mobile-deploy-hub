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
