# Review: input reconciliation (v1b spine vs PRD, addendum, seed)

Verdict: REVISE BEFORE EPICS. The spine lands the structural requirements well (FR-1 to FR-3, FR-10 to FR-12, FR-21 to FR-23, NFR-1 to NFR-3, NFR-6). No critical gaps. Seven high gaps remain, where an in-scope testable consequence is unlanded, contradicted, or left to the builder to invent. Several deliberate departures from the addendum are made but never labelled as departures.

Lens: every in-scope FR/NFR consequence, including the quiet ones (limits, latencies, redaction, "says so" messages, confirmation, partial history), checked against AD-23..AD-46 and the inherited AD-1..AD-22. Sources: prd.md, addendum.md, resource-registry-seed.md, sweep-*.md, v1a spine.

## Critical

None.

## High

### H1. A registered phone never joins the `phone` Pool (AD-33, AD-28; FR-6, UJ-2, UJ-4)
AD-33 says the `phone` Pool is "a seeded named list in preference order (`phone = [s24, s26]`)". A Pixel registered at run time (UJ-3) is therefore reachable only through a Capability query, not the `phone` word. UJ-4's whole premise is that registering one more phone relieves the phone Pool. v1c's Capacity Estimate also needs a Pool whose size grows on registration. The spine says nothing on this.
Fix: add to AD-33: "The `phone` Pool is the seeded list `[s24, s26]` followed by every non-retired runtime `kind: phone` Resource on big-chungus that is not `dedicated_qa`, in `created_at` order. Seeded members keep their place and the deploy phone stays last. A runtime phone therefore joins `phone` at registration with no edit." Add a test: register a phone, `lease phone` with s24 and s26 held, and the new phone is served.

### H2. Time-passing states against a cached snapshot and a no-polling stream (AD-43, AD-44; FR-14)
FR-14 requires expired and grace-ended states to be "computed from timestamps by every reader, so they never wait for an event". AD-44 serves `/status` from an in-memory snapshot, and AD-43 emits only on file or device change with "nothing polls". A Lease expiring or a grace ending changes no file, so the snapshot shows a dead Hold as live forever, and the stream never says otherwise.
Fix: add to AD-44: "The snapshot stores absolute times only. `/status` and every `status` stream payload derive `expired`, `grace.state` and `stale` from `now` at serialisation time. The stream carries those same absolute times, and clients derive the same states. No event is emitted for a state change that only time causes." Add a test with an injected clock: advance past `expires_at` with no file change and assert `/status` shows the Hold expired.

### H3. `statusView` does not cover Registry locks, Pool tickets or expected end (AD-41; FR-14, FR-8, FR-29)
Three gaps against what status shows today (sweep-cli §2).
1. `status` walks only the fleet locks, the gate, `RESERVABLE` and currently held locks. A `res-<slug>.queue/` with waiters, and `emulator-<n>.queue/`, are never shown unless held. FR-14 wants every Queue.
2. AD-33 puts the same Pool ticket in every member's queue. Nothing says it shows once, with its Pool and a position per member. v1a AD-6 already prevents "a run counted twice" for Reservations, but not for Pool tickets.
3. FR-14 lists "expected end" for a Hold. `status --json` has `started_at` and `expires_at` only.
Fix: AD-41 gains "`statusView` walks every Registry lock, retired ones while held or queued, plus the gate and slots. A Pool ticket is listed once per request (`request`, `pool`) with `positions: {<lock>: n}`. Holds carry an additive `expected_end` computed by `eta.mjs` (never later than `expires_at`)." All as additive keys (AD-17).

### H4. Force-release of a Reservation, mandatory `why`, and the run link are not landed (AD-38; FR-11)
FR-11: "Jarad can force-release any Lease or **Reservation**". AD-38's `forceRelease(name, …)` acts on a lock owner, and `cancelRequest` removes only "the caller's own Reservation". Nobody can force-release another Claimant's Reservation. FR-11 also says the Control Surface links a refused Job Hold to its run, so the refusal must carry the run. And it says force-release records who and why. AD-38 does not make `why` required.
Fix: AD-38 adds "`releaseReservation` gains `{actor, why}` and writes `force-release` (`hold_kind: reservation`) when the actor is not the owning run. `forceRelease`, `override` and Reservation force-release require a non-empty `why` (`HUB_USAGE`, exit 2). `HUB_FORCE_RELEASE_JOB` carries `{repo, run, job}` as problem+json extensions, and the CLI prints today's `gh run cancel` hint." Note also that the confirmation step is explicitly deferred to the page (spine Deferred), which is an acceptable departure. Say in AD-38 that the API does not enforce confirmation, only `why`.

### H5. Redaction contradicts AD-17 and leaks through nested fields and events (AD-30, AD-39; FR-3, FR-17)
- AD-30: "Every API response, stream payload and status view omits `serial` and `udid` for a `dedicated_qa` phone". `hub-device status --json` has `phones[].serial` today, and AD-17 forbids removing a key. FR-13 pins the `--json` shapes. Either the CLI keeps the S24 serial (it is in committed `devices.json` anyway) or the key goes null.
- The serial also appears in `locks[].phone.serial`, `adb_id`, `holder` text and (for runtime phones) `registry-add` and `registry-edit` events. FR-17 says the Event Log carries no secrets, and history returns those events.
Fix: AD-30 becomes "The API, the stream and replicas redact `serial`, `udid`, `adb_id` and `device.*` identity for `dedicated_qa` phones by setting the key to `null` (keys are never removed). The local CLI status keeps today's shape on the host's own terminal. Registry events record `resource`, `lock` and the changed capability keys, never `identity`." Add a test that greps a full `/status`, `/history` and `/stream` capture for the QA serial.

### H6. The endpoint set and the Capability request surface are not fixed (AD-42, AD-24, AD-17; FR-21, FR-6)
FR-21 lists health, Registry read and write, Hold/Queue/Reservation actions, status and stream, ETA, history and Capacity. The spine names `/health`, `/status`, `/stream`, `/history` (only in Deferred), `/leases`, `/leases/<id>/extend`, `/requests/<id>/cancel` and `/registry/resources`. No discovery, ETA, force-release, Reservation, pools or resource-read route is named. The capability map ties FR-21 only to AD-42. How a Claimant asks "any phone at API 34 or higher" is also unspecified, on the CLI and in `POST /leases`. Builders will invent both, and the contract test cannot check an inventory nobody wrote down.
Fix: add to AD-42 a route table (method, path, FR, claims function). Minimum: `GET /health /status /stream /resources /pools /discovery /history`, `POST /registry/resources`, `PATCH`+`POST .../retire`, `POST /leases /leases/<id>/extend /leases/<id>/release /leases/<id>/force-release /requests/<id>/cancel /reservations/<key>/release /reservations/<key>/force-release`. ETA rides on `/status` queue entries (AD-18). AD-17 lists the CLI form, for example `hub-device lease --match key=value[,key>=value] --for … [--wait …]`. Capability matching (AD-33) states its operators: equality for strings and booleans, `>=` and `<=` for numbers (PRD FR-6 "API level 34 or higher").

### H7. Mac reachability: refresh-on-request versus "reads never wait", NFR-8 and "fails at once" (AD-35, AD-44, AD-26, AD-32; FR-5, FR-12, NFR-7, NFR-8)
- AD-35 says a reading older than 60 s "is refreshed once on request ... flagged `stale` meanwhile". For the Mac, a refresh is an ssh plus curl with a 20 s ConnectTimeout (sweep-hosts §3). AD-44 says reads answer from the snapshot and never wait on devices. Read both literally and `/status` either blocks 20 s on a sleeping Mac, or the refresh is async and undefined.
- The Hub API learns the Mac is gone only when a call fails, so every `/status` after 60 s against a sleeping laptop would call it again. That approaches the periodic traffic NFR-8 forbids.
- AD-32 says an action on a Mac Resource "fails at once" `HUB_DEVICE_AWAY` when the Mac is unreachable. "At once" is true only if unreachability is already cached. The first failure costs the ConnectTimeout.
Fix: AD-35 adds "A refresh is always asynchronous: the read returns the snapshot flagged `stale` and starts at most one refresh per host. A failed call marks the host `unreachable` with `since`. No further refresh is attempted for that host until a Host Agent push, a request that must act on the host, or `reachability_max_age_s` x 5 since the failure (evaluated at request time, never on a timer). Actions on an unreachable-cached host fail immediately; the first uncached attempt is bounded by `hub-client`'s connect timeout (policy `api.peer_connect_timeout_s`, default 5)." Add the key to AD-46.

## Medium

### M1. Keepalive wording, bound and timer exception (AD-43, AD-46, AD-19; FR-14)
FR-14: "at least every 30 seconds". AD-43: "a `: keepalive` comment goes out at most every `api.stream_keepalive_s`" (15). "At most every" reads as a minimum interval, the opposite of FR-14. A per-connection keepalive is also a timer, and AD-19 allows only one in-process interval; the PRD calls it "part of the connection, not recurring work", but the spine does not say so.
Fix: "A keepalive comment is written whenever `api.stream_keepalive_s` passes with no bytes, so no gap exceeds it. The policy parser rejects values above 30 (FR-14, and Holocene's proxy drops silent responses after 30 s). The interval is owned by the open connection and cleared when it closes; it is a connection property, not a recurring job (a named exception to AD-19)."

### M2. The 2 s change latency has no budget (AD-43, AD-26; FR-14)
Three unspecified parts: how long "coalesced" waits, whether `fs.watch` is recursive, and the Host Agent's push path. Sweep-holocene §5.2: a watch follows an inode, so a recreated path is unseen; the Linux recursive watcher is a per-directory JS watcher; locks and queues are created and removed constantly. A non-recursive watch on the lock dir sees `adb.queue` appear but not tickets inside it, nor an `owner.json` rewrite on extend. The Mac push is `ssh big-chungus curl`, with a fresh connection cost on every push unless ControlMaster is reused.
Fix: AD-43: "Watches are `recursive: true` on the lock dir and the event dir; a watcher error or a rename of a watched root re-arms it and forces a re-read. Coalescing is a trailing debounce of at most 250 ms. A Host Agent push uses `ssh -o ControlMaster=auto -o ControlPersist` (already the Mac's config for `big-chungus`) so a push after the first is one round trip." State the budget: watch to subscriber under 2 s on big-chungus, and for the Mac a push is attempted within 250 ms of the change.

### M3. NFR-7's 200 ms and 1 s figures appear nowhere (AD-44, AD-36)
The capability map ties NFR-7 to AD-44, but the spine states neither limit. Without them there is no test. Fix: AD-44 adds "A `/status` read answers in under 200 ms from the snapshot on big-chungus. An uncontended `POST /leases` on a local Resource answers in under 1 s, excluding `findPhone` (never used, AD-36) and emulator boot. A forward to the Mac is excluded from the 1 s figure and reports its own `duration_ms`." Test: handler-level, injected clock, with a snapshot built over the 2,868-process-scale `inventory` fixture to prove no scan sits on the read path.

### M4. Departures from the addendum are made but not labelled (spine-wide; addendum B.6, B.7, B.11, §B.8)
Each departure below is a good decision, but a builder reading the addendum cannot tell it is deliberate. Add a short "Departures from addendum.md" table (addendum item, spine decision, AD).
- B.6 "pushes changes over the tailnet": spine uses ssh plus loopback curl (AD-26).
- B.6 "restarts or exits lazily when the Mac's `current` moves": spine switches only at `hosts:install` (AD-45; NFR-2 wins).
- B.7 "a `hub-api` lock makes a second instance refuse": spine uses the port bind (AD-45). Add the reason: a bare lock is reclaimed as too old after 4 h.
- B.7 route list `/holds /queues /reservations /events /capacity`: replaced by a smaller set (see H6).
- B.11 "Event Log merge across hosts orders by host then `ts`, and flags skew": AD-40 orders by `ts` then host and has no skew flag. Either adopt the addendum or state the departure. If kept, add "a replica event whose `ts` is later than its push receipt time, or earlier than the host's previous event, sets `skew_suspected: true` on the history response."
- B.11 "Two Hub API instances": same as B.7.

### M5. History: partial semantics, backfill and "away" between readings (AD-40; FR-18)
- FR-18: "History from the Mac is marked partial for any time the Mac was unreachable." AD-40: partial only when the replica lacks the range while the host is unreachable. If the replica caught up after the gap, nothing is lost, so the narrower rule is sensible, but it is a departure and should be stated. The response also needs `unreachable_ranges` from `host-reachability` events so the PRD's wording can still be shown.
- Backfill is unstated. The Mac already holds a 356 KB log. "Every event since the Event Log shipped stays queryable" needs the first push to start at offset 0 of each month file. Say so.
- Utilisation "away" depends on `reachability` events. Mac readings happen only on request (NFR-8), so time between readings has no events. Add: "between readings the last reading holds until `checked_at` plus `reachability_max_age_s`, after which time counts as `unknown`." `unknown` is also a fifth category beyond the PRD's four; say so in the contract.
- FR-18 filters (Resource, Pool, Claimant, repo, time range) are not listed; put them in the `/history` route row.

### M6. Discovery has no source for model and serial, and misses other servers and the iPad (AD-35; FR-4)
FR-4 requires model and serial, and that a `host:port`-only device has its serial read by a read-only query. The spine says only "lists devices the same transport sees that no Resource names". Today `parseDeviceList` and `adb-wire.devices()` return only `{id, state}`; no code asks for `-l` (sweep-cli §4). Also only the hub's 5037 server is queried, while foreign servers on 5043, 5055 and 5093 hide phones, and `adb -L tcp:127.0.0.1` still kills and restarts a server on a version mismatch (sweep-holocene §5.4).
Fix: AD-35 adds "Discovery reads `host:devices-l` for model, and for a `host:port` id reads `ro.serialno` over `host:transport` plus `shell:` on the wire. It queries the hub's adb server port only and says so in its result. The wire socket is the primary transport. `adb -L tcp:127.0.0.1` is allowed only after a `host:version` check shows the client and server versions match." The iPad (UDID via `devicectl list`) is discoverable by the Mac Host Agent the same way, or explicitly excluded.

### M7. Reachability mapping from today's presence strings, and who computes it (AD-35, AD-41; FR-5)
`status` presence today is `reachable | <raw adb state> | absent | no adb server | adb did not answer`. AD-35 says "one function" maps presence to the enum but gives no table. Specify: `device`→reachable, `unauthorized`→unauthorized, `offline`→offline, `absent`→absent, `no adb server`/`adb did not answer`/anything else→unknown. Keep `presence` in `status --json` and add `reachability` beside it (AD-17). Also say the CLI's `statusView` calls `reachability.mjs` directly on its own host, so `hub-device status` still reports when the API is down (FR-13). AD-35 reads as if only the services read devices. Emulator slots (liveness from `emulatorStatus` pids) and the iPad beside the `ios-lane` host reading are also unspecified (memlog assumption not in the spine).

### M8. Registry identity lacks what `findPhone` needs (AD-28, Registry record; FR-1, UJ-3)
`findPhone` is called with `{serial, model}` and throws on a model mismatch. The record's `identity` is `{serial?, udid?, profile?}`. State that `model` is required for `kind: phone` and is stored in `identity` (not redacted as a secret), or that `findPhone` skips the check when absent. UJ-3's "within a minute an agent can lease it" depends on this.

### M9. Pool request ETA is undefined (AD-33, AD-18; FR-15, UJ-2)
FR-15 builds an ETA "across the Resources it is waiting on". AD-18 computes per queue. Add: "A Pool request's ETA is the earliest member's range: `lo = min(lo_i)`, `hi = min(hi_i)`, `low_data` if any contributing member is low-data." UJ-2 expects position 1 with an ETA for the phone Pool.

### M10. Emulator Pool size and profiles from the Registry (PRD 4.1; AD-33, Deferred)
PRD 4.1: the Pool's profiles become Registry entries, and its size keeps today's precedence with "the Registry value below both" (`$HUB_EMULATOR_POOL`, then `emulator-pool`, then Registry). The spine says `MAX_POOL` stays a constant and the gate stays, and says nothing of the size order. Sweep-emulator §1 shows `provision()` defaults to 2 unless the caller reads `hostPool`, so an API caller gets the wrong size. Fix: AD-33 or a new rule: "`hostPool(env, registry)` returns env, then `emulator-pool`, then `registry.pools.emulator.size`, then 2, with the same 1..8 check on every source. Claims calls it for every front door." Runtime profile registration lives only in Deferred; either give it an AD or mark FR-1's emulator-profile case as seeded-only in v1b.

### M11. `lease ipad` versus `lease mac` and Mac action details (AD-25, AD-32, AD-24; FR-12)
FR-12: both words take a Lease on `ios-lane`. The memlog records an assumption that `lease ipad` needs the iPad reachable (unless `--no-connect`) and `lease mac` needs only the host. The spine lands none of it, nor the exports/`--json` for these words. Also: the 60 min deploy-target cap applies to `mac-ios`; `hub-client`'s `curl --max-time` must exceed the caller's `wait` or a forwarded wait dies early; and a forwarded request from big-chungus needs the Mac's reading `host-unreachable` reason text (`hub-device: ipad is away: host-unreachable`). Add one sentence for each.

### M12. S24 is `dedicated_qa` yet in the `phone` list; fallback seed lacks the flag (AD-30, AD-33; FR-3, FR-6)
FR-6 says a dedicated-QA phone is served only to a request naming it or asking for the capability. FR-3 says `phone` behaves exactly as before, S24 first. The PRD contradicts itself; the memlog records the assumption that FR-3 wins, but the spine's Open Questions omit it. Fix: AD-33 "a seeded named list ignores the `dedicated_qa` exclusion; queries do not", and list it under Open Questions for Jarad. Also AD-27's in-memory fallback seed (no `registry.json`) is built from `devices.json` alone, so S24 has no `dedicated_qa` and a Capability query would serve it. Make the fallback also read `qa-devices.json`.

### M13. FR-1 and FR-2 refusals and messages (AD-28, AD-27, AD-31)
- FR-1 refuses a name that collides "with an existing Resource". AD-28 checks only duplicate identity and the reserved list. Add name uniqueness against all Resources, including retired ones (so a retired name cannot be silently reused for another lock).
- FR-2: Registry writes "are unavailable while the Hub API is down, and say so; Holds still work". AD-27 gives the code but not the text. Add the message: `HUB_API_DOWN the Hub API is not answering; registry changes are unavailable, holds still work`.
- Queued waiters on a Resource that is retired while queued are not addressed: say they are served normally (retirement stops only new takes).

## Low

- L1. AD-35 and AD-33 keep `unauthorized` at exit 75, extending PRD FR-6's "offline or absent". Explicit already; add "(departs from the glossary's definition of away; pinned by `hub-device.test.mjs:403-411`)".
- L2. `GET /health` returns `{ok, service, contract, hub_version}`, a superset of FR-21's `{ok, service}`. Say it is additive.
- L3. FR-22: add one parity test running the same request through the CLI and the handler and asserting the same Hold, refusal code and event sequence, ignoring `actor.via`.
- L4. FR-13: name the intended `hub-device.test.mjs` changes in the spine: `phone` when none is free queues, and the Pool-request tests at `:303-332`.
- L5. PRD §2.2 says a third host "joins by registering it"; the spine allows only `devices.json` hosts. State it as a v1b limit (Deferred has it, without the PRD wording).
- L6. API Lease records carry the API's `pid` and hostname, so `hub-device status` shows the API pid for them. Say status renders `holder` for `holderPid: null` Leases.
- L7. A crashed or killed API gives the client a connection reset, not `HUB_API_RESTARTING`. State that the client library treats reset as `requeue` (FR-23: "a clear re-queue error").
- L8. `reachability` and `host-reachability` event bodies are not specified (`resource`, `from`, `to`, `checked_at`, `reason`). Add them to AD-39 so history and v1c FR-28 can rely on them.
- L9. A restart during an emulator boot leaves the slot tied to the API's pid and it is reaped (sweep-emulator §4.3); say so under AD-37.

## Landed correctly (spot checks)
60 s registration (roll-out paragraph, AD-27 read-per-call), duplicate identity refusal, reserved list (AD-28), retirement not ending a Hold (AD-31), seeded exemption, no adb start in reads (AD-13, AD-35), `unknown` never `reachable`, 60 s freshness in policy (AD-46), 48 h and 60 min caps (AD-24, AD-38 override never skips them), waiters named with positions (AD-34), override and force-release with actor and why (AD-38), job holds not force-releasable (AD-38), connection-bound waits and restart error (AD-37), second API refused (AD-45), loopback (AD-26), contract test and problem+json (AD-42), the Mac's own LaunchAgent label (AD-45), Mac clock for the `mac-ios` queue (AD-25), `prune` event drift (AD-39), Event Log never fatal (inherited AD-9).
