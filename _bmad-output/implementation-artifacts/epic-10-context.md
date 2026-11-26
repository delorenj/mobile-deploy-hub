# Epic 10 Context: Ask what happened, on either host

<!-- Generated from planning artifacts. Regenerate with compile-epic-context if planning docs change. -->

## Goal

The Hub API answers history and utilisation questions over both hosts' Event Logs. The Mac's Event Log is replicated byte-for-byte to big-chungus while the Mac is awake, so history stays readable while it is asleep; ranges the replica cannot cover are marked as gaps rather than silently omitted. The epic closes with the whole v1b API contract frozen (exact route table, exact key sets, leak-tested against QA serials) and both services shipped on one release. This is the substrate for v1c's capacity numbers and the Holocene control-surface page; nothing here computes the Capacity Estimate itself.

## Stories

- Story 10.1: Replicate the Mac's Event Log
- Story 10.2: Query history across both hosts
- Story 10.3: Utilisation per Resource
- Story 10.4: Freeze the contract and prove nothing leaks
- Story 10.5: Ship v1b

## Requirements & Constraints

- The Hub API returns the Event Log from both hosts, filtered by Resource, Pool, Claimant, repo and time range, paged with an opaque per-host cursor of the form `{<host key>: "<month>/<offset>"}`.
- Every event since the Event Log shipped stays queryable: v1b never compacts or deletes it (no retention limit; revisit only when the log passes 100 MB).
- History from the Mac must be honest about gaps: a request whose range the replica lacks while the Mac is unreachable answers `partial: true`, with `synced_through` per host and `unreachable_ranges` derived from `host-reachability` events. Time the Mac was asleep but later synced counts as complete (a deliberate narrowing of the full-history requirement).
- Ordering is total per host (month, then offset). Across hosts the merge by `ts` is display only; the response documents that consumers never derive a cross-host order from it.
- Utilisation per Resource reports the share of a window spent held, idle-while-reserved, idle, away, and `unknown`; emulator utilisation is per slot, rolled up to the Pool. The utilisation endpoint answers from cached aggregates, never by walking the whole log per request.
- Every write route returns the resulting state; refusals are `application/problem+json` with a machine-readable `code`, `exit` and `reason`.
- The contract document (`docs/hub-api-contract.md`) must list exactly the frozen v1b route table — health, status, stream, resources, pools, discovery, history, utilisation, the registry writes, `/leases` plus extend/release/force-release, `/requests/<id>/cancel`, `/reservations/<run_key>/force-release`, `GET /leases/<id>`, `/agent/push`, and the Host Agent's `/health` and `/agent/sync` — each mapped to one Claims or store function. A contract test asserts exact key sets against handler output for every route; removals and renames fail, only additions are allowed. `GET /capacity` is reserved for v1c and must be absent from the code.
- Leak-proofing: a test walks every key path of `/status`, `/stream`, `/history`, `/resources` and `/discovery` output with a QA serial seeded in a fixture and finds it nowhere (the `service` audience redaction rules from earlier epics apply everywhere here).
- Ship criteria: `mise run check` green on Node 24 and Node 26, one `mise run release -- X.Y.Z` with per-app strict dry runs, `hosts:install` on both hosts (operator actions) with both `/health` readbacks reporting equal `contract` and `hub_version`, and a live proof that a Mac event from before a sleep/wake cycle shows `partial` first and complete after the replica fills. Release notes state that pinned readers ignore `replicas/` and the new event names, and that deploy jobs and the catch-ups never depend on either service.

## Technical Decisions

- Each host's own Event Log is authoritative. The Hub API is the only writer of `HUB_EVENT_DIR/replicas/<host key>/<YYYY-MM>.jsonl` (never `lock.mjs`), holding a byte-identical prefix copy of each source month file.
- Replication rides the one existing Host Agent push message (`POST /agent/push`, body `{format: 1, host, host_id, boot, seq, sent_at, status, readings, events}`). The `events` field is `{month, from_offset, lines}` with only complete lines from `readEventsFrom`; a push never spans two months and no month is ever closed. The Hub API appends only when `from_offset` equals the replica file's current size; otherwise it answers `409 HUB_REPLICA_GAP` with `{size}` and appends nothing. Every push response carries `{replica: {<month>: size}}`, and the agent keeps no cursor of its own — it resumes from that acknowledgement, including at start (disk and the Hub API are the only state).
- On each trigger the agent compares every source month's size to the acknowledged replica size and pushes the oldest month that differs; the first push for a host starts at offset 0 of its oldest month. Retried or torn deliveries must leave the replica with no duplicate or shifted line — provable by file-hash comparison.
- `POST /agent/sync` on the Host Agent takes replica sizes and makes the agent push from those sizes; `/history` calls it when a range the replica lacks is requested, then reads the replica.
- Utilisation is a pure function in `tools/registry/history.mjs` over the events, given the Registry and a `lock -> resource` map so v1a events without a `resource` field still attribute correctly. A `track` Reachability reading holds until the next event; a `probe` reading holds until `checked_at + reachability_max_age_s`, after which time counts as `unknown`, as does time before a Resource's first reading.
- The Mac is a laptop: its Host Agent sends only changes, never a periodic stream or timer-driven poll, and every consumer treats Mac data as possibly stale. This is why replication is push-based and why gap-marking (`partial`, `unreachable_ranges`) is a first-class part of the answer rather than an error.
- New code is Node 24 ESM `.mjs` with hermetic tests (`hermetic()` fixtures, injected seams); the suite covers empty, sparse and rich history, a Mac gap and a `track-lost` event.

## Cross-Story Dependencies

- Story 10.1 (replica) fills the `events` field that Epic 9's push message left as `null`; 10.2 and 10.3 both read the replica it produces, and 10.2's on-demand sync calls the `/agent/sync` route 10.1 adds to the agent.
- Story 10.3 builds on 10.2's event access and on Epic 6's event vocabulary (`reachability`, `host-reachability`, `resource`-carrying events) and Epic 6's `readEventsFrom` reader with offset-based ids.
- Story 10.4 freezes the contract that Epics 6–9 accumulated; its route table and leak tests span the whole v1b surface, so it must land after the earlier epics' routes are stable.
- Story 10.5 ships everything on one release to both hosts and depends on all prior stories; v1c's `/capacity` endpoint and the Holocene page are downstream consumers of this epic's `/history` and utilisation.
