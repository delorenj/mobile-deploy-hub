# Adversary review: Architecture Spine v1b (AD-23..AD-46)

**Verdict: REVISE before epics start.** The layering, the one-owner rules and the inherited-invariant table are sound. But the spine never defines the wire between its own spokes. Four pairs of epics can each follow every AD to the letter and still not interoperate (Host Agent vs Hub API on push, forwarded action vs receiving front door, replica vs source log, CLI status vs API status). Four critical, nine high, eight medium, three low.

Method: for each pair of units one level down I built two builders who each satisfy every AD Rule and then looked for the point where their output stops fitting. Each finding names the pair, the ADs, the break, and tightened wording. Evidence is from the spine and `reviews/sweep-*.md`.

---

## CRITICAL

### C1. Host Agent push vs Hub API ingest vs replica: no wire format, three ADs name one message
- **Pair:** Host Agent epic (`tools/host-agent/push.mjs`) vs Hub API epic (`replica.mjs`, `stream.mjs`).
- **ADs:** AD-26 ("pushes when something changed"), AD-40 ("pushes that carry a cursor... idempotent by offset"), AD-43 ("Host Agent pushes" feed `/stream`), AD-35 (readings).
- **Problem:** The push is one message with three consumers (snapshot, event lines, reachability readings) and none of them is specified: no endpoint, body keys, ack, ordering or resume rule. Both builders comply. Concretely they can diverge on:
  - whether `offset` means the start or end of the lines, and whether the replica file is a byte-identical copy of the source file. AD-39 derives event ids from the byte offset in the *source* file, so a replica that re-serialises lines or skips a malformed one shifts every later id;
  - what the API does with a push whose `from_offset` is past the replica's size (hole), or behind it (overlap, maybe different bytes);
  - a month boundary: the cursor is per `<YYYY-MM>` file but a push can span two;
  - a torn tail: `lock.mjs` appends with `O_APPEND`, and the agent can read a half-written last line. `readEventsFrom` is not told to stop at the last `\n`;
  - how the agent learns, after its own restart, where the API's replica ends (it holds no state, AD-23).
- **Fix (add to AD-40, cross-referenced from AD-26 and AD-43):**
  > The Host Agent pushes exactly one message type, `POST /agent/push`, body `{format:1, host_id, boot, seq, sent_at, status: <statusView(host)>|null, readings: [...]|null, events: {month, from_offset, lines: [<raw source line>...]}|null}`. `readEventsFrom` returns only complete lines (up to and including the last `\n`) and the new end offset. The replica file is a byte-identical prefix copy of the source file. The API appends iff `from_offset == size(replica month file)`; otherwise it answers `409 HUB_REPLICA_GAP` with `{size}` and appends nothing. A push never spans months (one push per month, oldest first). Every push response carries `{replica: {<month>: size}}`, and the agent resumes from it, including at its own start. `seq` is per `boot`; the API ignores `seq <= last` for the same boot. An agent push is the only writer of `replicas/`.

### C2. Forwarded action vs receiving front door: wire, trust, idempotency and the request id are unspecified
- **Pair:** Hub API epic (forwards Mac actions) vs Host Agent epic (receives) vs `hub-device` on the Mac (forwards to the API); all three use `hub-client.mjs`.
- **ADs:** AD-25, AD-32, AD-26, AD-37, AD-24.
- **Problems, each independently legal:**
  1. **Endpoint and body.** "Forwarded to that host's front door" with "the resolved Resource record" does not say whether the forward uses the public `POST /leases` with an extra `resource` body key, or an internal route. Builder A makes the Host Agent expose the same routes as the API; builder B adds `/internal/...`. The Mac CLI's forward to the API then fails against one of them.
  2. **The carried record is trusted, so AD-31 leaks.** The Mac resolves from the in-memory seed when the API is unreachable (AD-32), so its record says `retired_at: null`. The receiving side "never re-resolves". A retired or edited Resource is therefore leasable through any forward from a host with a stale seed. The check "Claims library refuses every new take on it" runs on the receiver against the carried record.
  3. **Retries duplicate Leases.** `hub-client` runs ssh plus curl; the ssh leg can die after the receiver granted. AD-37 turns a dead leg into a cancel/release, but a client retry (Holocene retrying a 502) takes a second Lease. Nothing makes `POST /leases` idempotent.
  4. **The request id is unknowable.** A waiting `POST /leases` holds the connection until served. `POST /requests/<id>/cancel` needs the id, but the response (which would carry it) has not arrived. If the server mints the id the client cannot cancel by id; if the client mints it, nothing says ids are validated or unique across hosts.
  5. **Cancel and release routing.** `release`/`cancel` by id need a Resource; the CLI today searches the fleet (`hub-device.mjs:443-481`). The spec gives only the id.
  6. **Timeouts.** `curl --max-time <s>` is in the template; a wait of 120 s plus provision of 6 min has no stated relation to `<s>`.
- **Fix (new AD-47 "Forwarding contract", or extend AD-25):**
  > Every front door exposes the same write routes. A forward is the public route plus header `X-Hub-Forwarded: <rev>` and body key `resource: {id, rev}`; the carried record is a hint only. The receiver on big-chungus re-resolves against `registry.json` and refuses on `rev` mismatch with `HUB_REGISTRY_STALE`; a Host Agent re-resolves only the lock and `host` it receives and applies the retired check from the `retired_at` the Hub API stamped. When the API was unreachable the forward carries `rev: 0` (seed) and the receiver applies seed rules. `POST /leases` and `POST /requests` accept a client `id` (validated by `LEASE_ID`, `l-`/`e-` prefix for minted ids); a repeat of an `id` held by the same `holder` returns the existing state, `200`, never a second Lease. Without a client `id` the server mints one and returns it in the first response header `X-Request-Id`, flushed before the wait begins. Release, cancel and extend bodies carry `resource`. `hub-client` sets `--max-time = wait_ms/1000 + 30` for waits and 30 otherwise.

### C3. "host" has three namespaces and no mapping
- **Pair:** Registry store/seed epic (`host` field) vs `hub-client`/Claims epic (ssh alias) vs events/replica epic (`host_id`).
- **ADs:** AD-25 ("The Registry's `host` field decides where an action runs"), AD-26 (`<alias>` from `devices.json` `mac.host`/`linux.host`), AD-8/AD-40 (`host_id`), AD-41 (`statusView(host)`), Registry record (`host`).
- **Problem:** The Registry record has `host` and AD-25 compares it to "this host", but the spine never says what the value is. Candidates in the code: the ssh alias (`hub-mac`, `big-chungus`), `os.hostname()` (`mommymac.local`, drifts to `mommymac-2.local`), `host_id`, or the `devices.json` key (`mac`, `linux`). Builder A seeds `host: "hub-mac"`, builder B seeds `host: "mac"`; the replica dir is `host_id`; the stream and `statusView(host)` take a fourth thing. "Am I on that host?" has no function, so the Mac CLI may decide it is local when it is not, and write a Resource's lock dir from the wrong host (the AD-25 violation it exists to prevent). The Mac's `devices.json` `linux.host` is an alias on the Mac, `mac.host` an alias on big-chungus; a Mac-side record cannot even hold the alias that big-chungus needs.
- **Fix (AD-28 or a new line under AD-25):**
  > A Resource's `host` is a **host key**: `linux` or `mac`, the keys of `devices.json`, never an alias, hostname or id. `claims.mjs` exports `hostKey({hostId})` which maps this process's `host_id` to a key through the `host_id` pinned in each `devices.json` host block (new additive key, filled at seed from the first event or `hostId()`); an unknown host is a hard `HUB_HOST_UNKNOWN`. `hub-client` maps key to alias (`linux.host` from the Mac, `mac.host` from big-chungus). Replica dirs, `statusView(hostKey)` and the stream `key` use the host key; `host_id` appears only in event ids and records. A record's `host` never changes (AD-28).

### C4. AD-30's redaction contradicts AD-17 and splits the one status builder
- **Pair:** Claims epic (`statusView`, CLI `--json`) vs Hub API epic (`/status`, `/stream`).
- **ADs:** AD-30 ("Every API response, stream payload and status view omits `serial` and `udid` for a `dedicated_qa` phone"), AD-17 ("`--json` gains keys and never renames or removes one"), AD-41.
- **Problem:** `hub-device status --json` today emits `phones[].serial` for the S24 (sweep-cli section 2). AD-41 says one builder feeds both. Builder A redacts in `statusView` (CLI loses a key, breaking AD-17 and the pinned tests); builder B redacts only in the API (CLI keeps it, but AD-30 says "status view"). Both obey their own AD. The Host Agent snapshot also carries `statusView`, and a push to the API with unredacted serials lands in the replica-adjacent snapshot cache.
- **Fix (AD-30 and AD-41):**
  > `statusView(host, {audience})` takes `audience: 'local'|'service'`. `local` (the CLI on the owning host, same OS user) keeps every v1a key and value. `service` (Host Agent snapshot, Hub API, stream, history, discovery) removes `serial`, `udid`, `device.serial` and `adb_id` of any `dedicated_qa` Resource by deleting the key's value to `null`, never the key. The Host Agent redacts before it pushes. A test walks every key path in the API and stream output against the redaction list.

---

## HIGH

### H1. Stream ids, replay and history cursors do not compose (AD-43 vs AD-40/AD-39)
- **Pair:** `stream.mjs` vs `history` endpoint vs a Holocene client written to the contract.
- **Problems:**
  - Two id systems on one wire: SSE `id: <boot>-<seq>` and the event's own `<host_id>/<YYYY-MM>/<offset>` inside payloads. `Last-Event-ID` can only carry the first. AD-43 copies Candybar's `reset` but not its 1024-event replay buffer, so builder A keeps a ring buffer and builder B always sends `reset`. A client written against A silently loses `event` frames against B.
  - `event` payloads are not "absolute state" (the Candybar rule AD-43 cites); applying one twice is not harmless unless the client dedupes on the event id.
  - AD-40 orders history "by `ts` then host", the memlog says "host then ts". Across hosts `ts` comes from two clocks, so a merged page can put a Mac `release` before its own `acquire`. There is no pagination cursor: an offset cursor is per host-file, a `ts` cursor skips late-pushed replica lines.
- **Fix:**
  > The stream keeps a ring of the last 512 frames per boot. A known `Last-Event-ID` replays strictly after it; an unknown boot or an evicted seq gets `reset`, and the client refetches `/history?after=<cursor>`. `event` frames dedupe on `event.id`. `/history` order is, per host key, by offset (a total order per host); across hosts it is a display merge by `ts`, and `partial`/`synced_through` is per host. Its cursor is an opaque `{<hostkey>: "<month>/<offset>"}` map; a page returns the next cursor. Consumers never derive a cross-host order from `ts`.

### H2. `fs.watch` coverage cannot see the changes AD-43 promises (AD-43 vs AD-1 layout)
- **Pair:** Hub API watcher vs the protocol layout.
- **Problem:** AD-43 says "`fs.watch` on the local lock and event dirs". Almost every status-relevant change is below the top level: tickets in `<name>.queue/`, `owner.json` rewrites by `extendLease`/`updateLease` inside `<name>.lock/`, Reservation dirs. A non-recursive watch on the lock dir sees none of the owner rewrites and no ticket creates. Builder A watches `lockDir` flat and the stream goes stale on extend, force-release metadata, queue position change. Builder B uses `recursive: true`, which on Linux is the JS watcher (one inotify watch per dir, new dirs raced) and on node 24.6 (the global mise pin) lacks options the stack table assumes. The watch also follows the inode, so a recreated `<name>.queue/` is missed.
- **Fix (AD-43):**
  > Watch set: `lockDir` and each `<name>.lock`, `<name>.queue`, `<name>.reservations` directory, re-established whenever the parent watch reports a child create. Each notification schedules one coalesced re-read (never trusted for content). Services run only on the mise `node/24` path with `>= 24.15`, asserted at start. `watchImpl` takes the dir list so tests inject it.

### H3. Force-release of an emulator slot is two steps across two layers with no order (AD-38)
- **Pair:** `lock.mjs` `forceRelease` vs `emulator.mjs` `releaseEmulator`.
- **Problems:** `lock.mjs` cannot import `emulator.mjs` (layer table: `emulator.mjs` imports `lock.mjs`), so the Claims library must orchestrate. `forceRelease(name, ...)` takes a lock name; teardown needs the record keyed by `lease_id`; the slot owner may be unreadable. `releaseEmulator` releases the slot first by id, which now finds nothing and returns `none`, skipping the teardown or writing a second `release`. If the process dies between the two, the next reap sees `orphaned` and writes nothing. Whether the reaper lock is held across both is unsaid, so the slot can be re-taken (ports reused, `choosePorts` only checks claimed records) while old pids still run.
- **Fix (AD-38):**
  > `forceReleaseResource` in the Claims library runs, in this order: (1) read the slot owner and its record by slot (`listRecords`), (2) under the `emulator-reaper` lock `forceRelease(slot)` (one `force-release` event whose body carries `lease_id`), (3) `teardown(record)` and remove the record, (4) release the reaper lock. `releaseEmulator` gains `{alreadyReleased: true}` to skip its release. Any crash between 2 and 3 leaves a record with no owner, which the next reap tears down as `orphaned` and logs `reaped-orphaned` (the force-release event already exists, so no second hold-ending event). The slot is not claimable while its record exists (`unreaped`, E:519).

### H4. Pool tickets: cancel, position, withdraw, crash (AD-33, AD-34, AD-38 pair)
- **Pair:** `poolRequest`/cancel owner vs `extendLease` and `queueView` owners.
- **Problems:**
  - `cancelRequest(name, id)` is per lock; the API's `/requests/<id>/cancel` and a Pool request spans N queues. Builder A calls it for the first candidate only; builder B for each. A Pool ticket is left behind and later wins a slot for a dead request.
  - The identical file name in N queues means a Pool request counts as a waiter ahead in every member. A member's position/ETA for a later Lease waiter is inflated by tickets that will be withdrawn, and AD-34 makes every holder's extend refuse because "a waiter sits behind" even when that waiter can be served by another member, and the extender's own Pool ticket (it holds one member and still waits in the others) blocks itself.
  - "Withdraws the other tickets without an event" conflicts with AD-9's rule that the deciding `unlinkSync` writes the event (`cancel`/`prune`). A crash after taking member A and before withdrawing B leaves B stale by pid only if the process is gone; with the API alive (pid live) B persists and can later be granted to the same request id, giving the request two Holds.
- **Fix (AD-33/AD-34/AD-38):**
  > `cancelRequest` and `releaseLease` take either a lock `name` or `{pool: true}`; with `pool` they withdraw every ticket carrying the `lease_id` in every member. Tickets of one Pool request carry `pool` and `request`; `queueView` counts them once for `place` and `blocking` purposes in the member being served and as non-blocking everywhere else; `extendLease`'s waiter check ignores a ticket whose `lease_id` equals the extender's own, and a Pool ticket whose request already holds a member. Withdrawal is one step: the winner `rename`s its own tickets to tombs and removes them, and is the only writer. If a request finds itself holding two members it releases the later one, `release` with `reason: pool-duplicate`.

### H5. `res-<slug>` ids can collide with retired Resources (AD-28 vs AD-31)
- **Pair:** Registry `add` epic vs retirement.
- **Problem:** `id = lock = res-<slug>`, and the duplicate-identity check is "against non-retired Resources". Retire `res-pixel`, register another "pixel": same slug, same id, same lock, same queue dir. `registry.json` now has two records with one id, or the add overwrites the retired record (violating "stays in registry.json" and "seeding never clears `retired_at`"), and the old queue and Event Log history attach to the new Resource.
- **Fix (AD-28):**
  > The id is `res-<slug>` for the first Resource with that slug and `res-<slug>-<n>` (smallest `n >= 2` not used by *any* record, retired included) otherwise. Ids and locks are never reused. The slug check runs against every record. `RESERVED` forbids a name whose slug matches `/-\d+$/` shape collisions with `emulator-<n>` and `s3-*`.

### H6. "Offline" is never pushed, and staleness has no common clock (AD-35, AD-41, AD-19)
- **Pair:** Hub API reachability refresh vs `/stream` consumer.
- **Problem:** Change-driven and timer-free means a sleeping Mac sends nothing. The Hub API learns the Mac is gone only when a request forces a refresh. `/stream` clients (Holocene) therefore see `reachable` forever. "Flagged `stale`" is evaluated against `checked_at` stamped on the Mac's clock and compared on big-chungus: clock skew makes fresh readings stale or stale ones fresh. AD-41 requires queue positions to be Mac-clocked but says nothing for reading age.
- **Fix (AD-35):**
  > A reading is stored as `{state, age_ms_at_receipt, received_at}`; age is `age_ms_at_receipt + (now_api - received_at)` on the API's clock only. The stream's keepalive tick (already a timer AD-43 allows) also re-derives staleness from stored readings, with no probe, and emits a `status` frame when any Resource's `stale` flag flips. `host-reachability` is only appended on an actual failed contact. No other timer.

### H7. History and utilisation need a Resource key that events do not have (AD-39, AD-40)
- **Pair:** `history.mjs` vs `lock.mjs` `noteRegistry`/`noteReachability` vs pool events.
- **Problem:** Hold events are keyed by `lock`; Pool-level events have `lock: null`; `reachability` events belong to a Resource whose `lock` may be a gate or a slot; `host-reachability` has no lock; `note()` gates every event on `isQueued(lock)` and would drop the new ones. `history.mjs` is pure over events and cannot map `emulator-3` to the emulator Resource or `mac-ios` to `ios-lane` without the Registry, which the spec says is data passed in as arguments, but retired or renamed Resources are not.
- **Fix (AD-39):**
  > Every v1b event, and every hold event written from v1b on, carries additive `resource: <id>`. `noteRegistry`/`noteReachability` bypass the Queued gate. `history.mjs` receives `registry` and a `lock -> resource` map as arguments and attributes events without `resource` (v1a history) by that map. The emulator pool's utilisation is per slot, rolled up by the Pool Resource; a slot is never its own Resource.

### H8. Waits inside the services block the event loop (AD-37/AD-44 vs `acquireLease`)
- **Pair:** Hub API wait handler (calls `acquireLease`) vs the read path.
- **Problem:** AD-44 moves scans and `provision` to a worker. `acquireLease` waiters are not covered: each poll reads `processStart` for every ticket (`/proc` on Linux; `spawnSync ps` with a 5 s timeout on the Mac, sweep-lock section 4, and `acquireLease` does not use `cachedStart`). N concurrent waiters in the Host Agent each block reads for up to the `ps` time every second. NFR-7 breaks on the Mac first.
- **Fix (AD-44):**
  > Every service wait (`acquireLease`, `withLock` for Queued names, `poolRequest` loops) runs in a `worker_threads` worker or with the cached process-start seam (one `ps`/`/proc` read per pid per pass, shared across waiters). The main thread never calls `spawnSync`. A test injects a `processStart` that blocks 200 ms and asserts `/status` still answers within 200 ms.

### H9. Seed, writer and the emulator pool have more than one owner (AD-27/AD-30, AD-33)
- **Pair:** `seed.mjs` vs the Hub API write path; Registry emulator-pool vs `hostPool`.
- **Problems:**
  - Seeding runs "at every start" and overwrites identity, lock, name and `deploy_target`. Does it go through the same `if_rev` path, bump `rev`, and emit `registry-edit` each start (noise, and a rev bump invalidating an operator's open `if_rev`)? When `devices.json` drops a phone (a release change or rollback to an older API), is the seeded record orphaned, retired (AD-31 forbids), or silently deleted?
  - The Registry holds an `emulator-pool` Resource with `slots`, while `hostPool` reads `HUB_EMULATOR_POOL`, then the `emulator-pool` file, then 2, and nothing writes the file. Builder A stores slots as records; builder B derives them. The CLI and the API unit may carry different env, so the same lock dir has two pool sizes (sweep-emulator section 1).
- **Fix (AD-27/AD-30/AD-33):**
  > Seeding is one `store.write` with `if_rev`, applied only if the derived seed differs from the stored seeded records, and writes `registry-edit` only for changed records. A seeded Resource missing from the new `devices.json` is kept and marked `seed_missing: true`; it stays held-or-hidden under AD-31 and never revives. Pool slots are derived from `hostPool(env)` on read and are never Registry records; the pool's size is read by `claims.mjs` only, from the file `emulator-pool`, then the Registry Resource's `capabilities.pool_size`, then 2; `HUB_EMULATOR_POOL` is honoured only by the CLI process that sets it and never by a service.

---

## MEDIUM

### M1. Status document embedding shape is unstated (AD-41)
"Embeds each host's view unchanged" can mean the big-chungus view at the root (so v1a consumers keep working) or `hosts.<key>`. Rows are keyed by `lock` (`waiters`, `locks`), `device` (`phones`) and now Resource id; a consumer joins them by guessing.
**Fix:** `/status` is `{format, contract, hosts: {linux: <view>, mac: <view>}, registry, reachability, stale, checked_at}`; every row in every view gains additive `resource: <id>`; v1a root keys stay in the CLI document only.

### M2. Actor and `via` through forwarding (AD-38, Conventions)
"As given by the caller" does not say what a forwarder does. The Mac CLI forwards through the API; the API may stamp `via: api` over `via: cli`, or the Host Agent may overwrite with its own. **Fix:** forwarders pass `actor` through byte for byte; a missing `actor` is defaulted once by the first front door to `{holder: <caller>, via: <its own door>}`; the Claims library never rewrites a present one.

### M3. `cancelRequest` id namespaces (AD-38)
"Removes a ticket or the caller's own Reservation" mixes `lease_id` (ticket) with `run_key` (`<owner>--<repo>--<run>`, Reservation). Which parameter is it? A Reservation is not "the caller's own" for a person. **Fix:** `cancelRequest(name, {lease_id} | {run_key}, {actor})`; a Reservation cancel needs an `actor` equal to its owner or `via: control-surface`; a job ticket is refused by id prefix `job:`.

### M4. Registry write and its event are not ordered (AD-27/AD-39)
`registry.json` is renamed, then `noteRegistry` appends. A crash between leaves a change with no event, and `history` shows no `registry-edit`. Neither AD names the deciding step as AD-9 does. **Fix:** the atomic rename is the deciding step; the writing process appends `registry-*` immediately after, with the new `rev`; startup compares `rev` to the last logged `rev` and appends a `registry-edit` with `reason: recovered` if behind.

### M5. Policy ports and release skew (AD-46, AD-45)
`hub-client` on the Mac takes the API port from its own release's `policy.json`; both switch only at `hosts:install`, but if one host's install fails (hosts.mjs keeps going on failure) the Mac pushes to the old port and `HUB_AGENT_PUSH_FAILED` loops silently. **Fix:** `/health` returns `{ports}`; the agent logs `HUB_AGENT_PORT_MISMATCH` and `hosts:install` reads both services back and fails the step if `contract`/`hub_version` differ between hosts.

### M6. Prune events from deploy-path callers (AD-39)
`prune` is now written by whichever process pruned, including pinned and deploy-path callers on newer releases. A crashed API with 40 tickets produces 40 events in the first deploy's `queueView`, in a deploy job's hot path (AD-25 says the deploy path must never depend on v1b). **Fix:** `prune` appends are capped at 20 per call (one `prune` with `count` over the cap), and failure is `HUB_EVENT_LOG_FAILED`, never fatal (AD-9).

### M7. Waiting-service pid and the "released at once" rule (AD-36/AD-37)
A Lease granted after the client left is "released at once", but the grant, the response write and the disconnect are three events; a client that only lost its response (not disconnected) then has a Lease it never learned of, and the release removes one it could still use. **Fix:** release-at-once applies only when the socket is destroyed before the status line is written; otherwise the Lease stands and the client may fetch it by `id` (C2).

### M8. Capability match vs the cap filter (AD-33, AD-24)
The existing `takeAnyPhone` skips the deploy phone when `--for` exceeds the 60 min cap; AD-24 lists the bounds checks but `match()` is pure and does not know the cap. Two front doors can disagree on which member is a candidate. **Fix:** `match(registry, request)` takes `request.for_ms` and `policy` and drops deploy targets whose cap it exceeds; "no usable member" is `HUB_NO_MATCH` with `reason: cap`.

---

## LOW

- **L1. Event ids on rotation:** AD-39's id is `<host_id>/<YYYY-MM>/<offset>`; `Event Log rotation` (Deferred) changes offsets. State that compaction creates a new month-file name suffix (`<YYYY-MM>.1`) and never rewrites bytes of an existing file.
- **L2. `person` Lease ETA history (Open Q2):** the default must be named in the contract so Holocene does not compute its own range: `/status` waiter ETAs are always `eta.mjs` output with claimant kind of the *waiter*, history matched by kind.
- **L3. `HUB_API_DOWN` detection:** define it as `ECONNREFUSED` or a `/health` timeout under 2 s; a timeout on a write whose body was sent is `HUB_API_UNKNOWN` (exit 1), because the write may have applied (see C2 idempotency).

---

## Pair index (what was tried)

| Pair | Result |
| --- | --- |
| Hub API epic vs Host Agent epic (push, forward) | C1, C2, C3, H8 |
| Claims library vs `hub-device` (status, redaction, pool size) | C4, H9, M8 |
| Registry store vs seed | H5, H9, M4 |
| Stream vs status | H1, H2, H6, M1 |
| History vs replica | C1, H1, H7 |
| Force-release vs emulator teardown | H3 |
| Pool request vs `extendLease` | H4, M3 |
| Actor, ids, time sources | C2, M2, H6 |
