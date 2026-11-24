# Deferred Work

- source_spec: `_bmad-output/implementation-artifacts/spec-1-2-exactly-once-release-reclaim-tombstones.md`
  summary: `hub-device status` still reaps dead emulator leases, and since Story 1.2 that reap's `releaseLease` writes a `release` event, so status is not yet read-only for the Event Log.
  evidence: `hub-device.mjs` `main()` calls the emulator `reap()` before `status`; `reap()` calls `releaseLease` on `emulator-<n>` (Queued). Story 1.3 (MOBI-26) moves the reap to the emulator acquire paths; no release ships between 1.2 and 1.5.
- source_spec: `_bmad-output/implementation-artifacts/spec-2-1-ticket-format-v1-machine-identity.md`
  summary: `withLock` still writes no ticket, so `buildTicket('job'|'hub-job')` has no production caller until Story 2.3 joins deploy jobs and the catch-up to the Queue.
  evidence: Story 2.1 freezes the format and exports the constructor with tests; AD-4/AD-6 FIFO for `withLock` is Stories 2.2-2.3.
- source_spec: `_bmad-output/implementation-artifacts/spec-2-1-ticket-format-v1-machine-identity.md`
  summary: Owner liveness in `staleness` (`owner.holder_pid`, `owner.pid`) still takes any safe integer as a pid, so an `owner.json` with pid 0 or -1 reads as alive (`kill(0, 0)` succeeds). Tickets were fixed in the independent review; owners are untouched.
  evidence: Pre-existing before Story 2.1 (the old owner check was the same); an owner is written only by `lock.mjs` from `process.pid`/a real holder pid, so only a hand-edited or corrupt `owner.json` hits it. Fold into Story 2.2/2.3 owner parsing if it recurs.
- source_spec: `_bmad-output/implementation-artifacts/spec-2-2-one-queue-view-and-tries.md`
  summary: A queued Lease's ticket (the emulator gate's included) still carries `pool: null, request: null`, and `queueView` entries therefore cannot yet tell a Pool request's waiters from a plain Lease's.
  evidence: Story 2.2 writes the Pool-level events and tags the slot try, but a gate ticket is a lock-level wait. Position and ETA (FR-15/16) are the first readers that need the ticket tag; add it there with the AD-3 keys that already exist.
- source_spec: `_bmad-output/implementation-artifacts/spec-2-2-one-queue-view-and-tries.md`
  summary: A phone Pool request that probes an away phone writes one Pool-tagged `acquire` (plus its `release`) per probe and then its closing `timeout`; a phone request that fails after a take (`HUB_LEASE_CANCELLED`, an abort) writes a `cancel` after its tagged `acquire`. A consumer pairing `request` with one `acquire` or `timeout` per request id sees two endings for those requests.
  evidence: Story 2.2 tags the successful try's own lock-level `acquire` (so a hold is never counted twice) and `takeAnyPhone` settles on every error; `provision` settles only while no slot is taken. Pinned by the away sequence in `hub-device.test.mjs`. Fix when Holocene or ETA (FR-15/16) first reads Pool outcomes: either settle the phone request only when no probe was taken, or tag only the acquire of the probe that is kept.
