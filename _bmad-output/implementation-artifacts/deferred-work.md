# Deferred Work

- source_spec: `_bmad-output/implementation-artifacts/spec-1-2-exactly-once-release-reclaim-tombstones.md`
  summary: `hub-device status` still reaps dead emulator leases, and since Story 1.2 that reap's `releaseLease` writes a `release` event, so status is not yet read-only for the Event Log.
  evidence: `hub-device.mjs` `main()` calls the emulator `reap()` before `status`; `reap()` calls `releaseLease` on `emulator-<n>` (Queued). Story 1.3 (MOBI-26) moves the reap to the emulator acquire paths; no release ships between 1.2 and 1.5.
- source_spec: `_bmad-output/implementation-artifacts/spec-1-4-record-holds-queued-locks-liveness.md`
  summary: Pool requests (`phone` via takeAnyPhone, the emulator slot probes) write only an `acquire` on success and nothing on a Pool timeout, so Pool contention is invisible until Pool-level events land.
  evidence: Story 1.4 treats every waitMs 0 call as a try (Story 2.2 semantics); AD-4's one Pool-level request plus acquire/timeout with waited_ms from the outer request is Story 2.2's AC.
