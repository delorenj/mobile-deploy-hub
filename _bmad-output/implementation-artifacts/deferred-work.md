# Deferred Work

- source_spec: `_bmad-output/implementation-artifacts/spec-1-2-exactly-once-release-reclaim-tombstones.md`
  summary: `hub-device status` still reaps dead emulator leases, and since Story 1.2 that reap's `releaseLease` writes a `release` event, so status is not yet read-only for the Event Log.
  evidence: `hub-device.mjs` `main()` calls the emulator `reap()` before `status`; `reap()` calls `releaseLease` on `emulator-<n>` (Queued). Story 1.3 (MOBI-26) moves the reap to the emulator acquire paths; no release ships between 1.2 and 1.5.
- source_spec: `_bmad-output/implementation-artifacts/spec-1-4-record-holds-queued-locks-liveness.md`
  summary: Pool requests (`phone` via takeAnyPhone, the emulator slot probes) write only an `acquire` on success and nothing on a Pool timeout, so Pool contention is invisible until Pool-level events land.
  evidence: Story 1.4 treats every waitMs 0 call as a try (Story 2.2 semantics); AD-4's one Pool-level request plus acquire/timeout with waited_ms from the outer request is Story 2.2's AC.
- source_spec: `_bmad-output/implementation-artifacts/spec-2-1-ticket-format-v1-machine-identity.md`
  summary: `emulator.mjs` `doomed()` (`:279`, `:282`) still compares `record.host`/`owner.host` to `hostname()` instead of using `sameHost`, so an emulator record on a Mac-style drifted hostname is judged foreign.
  evidence: Story 2.1 moves lock.mjs ticket and owner liveness onto `sameHost` (AD-8). Emulator records carry no `host_id` and the emulator pool runs on big-chungus only in v1a, where the hostname does not drift; the parsing moves onto `queueView` and host helpers in Story 2.2 (AD-1).
- source_spec: `_bmad-output/implementation-artifacts/spec-2-1-ticket-format-v1-machine-identity.md`
  summary: `withLock` still writes no ticket, so `buildTicket('job'|'hub-job')` has no production caller until Story 2.3 joins deploy jobs and the catch-up to the Queue.
  evidence: Story 2.1 freezes the format and exports the constructor with tests; AD-4/AD-6 FIFO for `withLock` is Stories 2.2-2.3.
- source_spec: `_bmad-output/implementation-artifacts/spec-2-1-ticket-format-v1-machine-identity.md`
  summary: Owner liveness in `staleness` (`owner.holder_pid`, `owner.pid`) still takes any safe integer as a pid, so an `owner.json` with pid 0 or -1 reads as alive (`kill(0, 0)` succeeds). Tickets were fixed in the independent review; owners are untouched.
  evidence: Pre-existing before Story 2.1 (the old owner check was the same); an owner is written only by `lock.mjs` from `process.pid`/a real holder pid, so only a hand-edited or corrupt `owner.json` hits it. Fold into Story 2.2/2.3 owner parsing if it recurs.
- source_spec: `_bmad-output/implementation-artifacts/spec-2-1-ticket-format-v1-machine-identity.md`
  summary: `emulator.test.mjs` "an emulator Lease is recorded as exactly..." asserts `got[2].waited_ms === 0` for the slot try, which flaked once under `heavy mise run check` load (a millisecond tick between `requested` and the acquire's `now()`); it passed 3 of 3 alone and in the full rerun.
  evidence: Pre-existing from Story 1.4, not touched by Story 2.1. Loosen to a small bound or inject `now` when that test is next edited.
