# Sweep: the lock protocol as shipped in v1a (hub v1.2.51)

Read-only sweep for the v1b spine. Every claim cites the current tree (`main` at `993e2a7`). Files read in full:
`tools/ci/lib/lock.mjs` (1456 lines), `tools/ci/lib/events.mjs` (134), `tools/ci/lib/eta.mjs` (179),
`tools/ci/lib/policy.mjs` (359), `tools/ci/policy.json` (60). Skimmed: `tools/device/lease.test.mjs`,
`tools/ci/reservation.test.mjs`, `tools/ci/reservation-release.test.mjs`, `tools/ci/extend.test.mjs`,
`tools/ci/events.test.mjs`, and the callers in `tools/device/hub-device.mjs` and `tools/device/emulator.mjs`.
Live state was only listed (`ls`, a read-only count of the Event Log), never written.

---

## 1. The full exported API of lock.mjs

Module header: `lock.mjs:1-14`. It is "the only caller of appendEvent" (`lock.mjs:14`). In fact `poolRequest` also calls
`appendEvent` directly (`lock.mjs:930`), but that call is still inside lock.mjs. Imports: `events.mjs` (`appendEvent`, `hostId`,
`readEvents`), `pause.mjs`, `deadline.mjs`, `policy.mjs`, `eta.mjs`, plus `node:` builtins (`lock.mjs:15-24`).

### Paths and identity
| Export | Signature / value | Evidence |
| --- | --- | --- |
| `lockDir` | `(env = process.env, home = homedir()) => env.HUB_LOCK_DIR \|\| ~/.cache/mobile-deploy-hub/locks` | `lock.mjs:26` |
| `QUEUED` | `Object.freeze(['adb', 's24', 'mac-ios', 'emulator'])` | `lock.mjs:30` |
| `isQueued` | `name => QUEUED.includes(name) \|\| /^emulator-\d+$/.test(name)` | `lock.mjs:31` |
| `ALIVE_MS` | `60_000` | `lock.mjs:34` |
| `readOwner` | `(path) => object \| null`. `path` is the `<name>.lock` dir; it reads `owner.json`; non-objects are null | `lock.mjs:42-47` |
| `isLease` | `owner => owner?.kind === 'lease'` | `lock.mjs:49` |
| `liveLease` | `(name, {env, now, host, hostId}) => owner \| null`. The live Lease only, judged with `staleMs: Infinity`; it never throws | `lock.mjs:54-60` |
| `sameHost` | `(a, b) => boolean`. Equal `host_id` on both sides wins, else non-empty hostname equality | `lock.mjs:91-94` |
| `localHost` | `({host, hostId}) => ({host, host_id})` | `lock.mjs:96` |
| `processStart` | `(pid) => string \| null`. `/proc/<pid>/stat` field 22 on Linux; `ps:<lstart>` via `spawnSync('ps', ['-o','lstart=','-p',pid])` elsewhere (5 s timeout, `LC_ALL=C TZ=UTC`) | `lock.mjs:421-430` |

### Job holds
| Export | Signature | Evidence |
| --- | --- | --- |
| `JOB_POLL_MS` | `2000` | `lock.mjs:189` |
| `checkDelivery` | `(delivery) => null \| {repo, run, version}`. It throws on any other shape (`repo` must be `owner/name`, `run` must be digits, `version` must match `[0-9A-Za-z.+-]{1,40}`) | `lock.mjs:193-204` |
| `withLock` | `async (name, fn, {env, timeoutMs = 15*60_000, pollMs = 2000, staleMs = 4*3600_000, log = console.log, sleep, now, kind = 'job', hostId, host, timers = {setInterval, clearInterval}, beforeRetire, afterTake, processStart, policy = null, deadlineSeams = {}, endsReservation = false, yieldToLease = false, timeoutReason = 'deadline', delivery = null, afterEta})`. `name` must match `/^[a-z0-9-]+$/`; `kind` must be `job` or `hub-job`; `timeoutReason` must match `/^[a-z][a-z0-9-]{0,39}$/`. A Queued name dispatches to `queuedLock` (`:233`); every other name takes the bare `mkdir` loop (`:234-266`) | `lock.mjs:206-267` |

### Leases
| Export | Signature | Evidence |
| --- | --- | --- |
| `MAX_LEASE_MS` | `48 * 3600_000` | `lock.mjs:328` |
| `holdsOf` | `(owner, blockers = []) => [{role:'holder'\|'ahead', kind, holder, lease_id, why, since, until, place?}]`. Never throws | `lock.mjs:337-355` |
| `DEPLOY_TARGETS` | `Object.freeze(['adb', 'mac-ios'])` | `lock.mjs:366` |
| `deployTargetCapMs` | `(name, {policy}) => ms \| null`. Reads `queue.deploy_target_lease_max_min`; falls back to `loadPolicy()` when the injected policy lacks the key | `lock.mjs:370-375` |
| `capText` | `(name, capMs) => string`. The shared refusal wording | `lock.mjs:378` |
| `newLeaseId` | `() => 'l-' + 12 hex chars` | `lock.mjs:912` |
| `poolRequest` | `(pool, {id = newLeaseId(), holder, why, forMs = null, waitMs = 0, env, now, hostId}) => {id, tag:{name, request, since, deadline}, settle(error, {signal})}`. It writes the Pool-level `request` at once | `lock.mjs:923-953` |
| `acquireLease` | `async (name, {holder, why, forMs, waitMs = 0, id = null, holderPid = null, env, pollMs = 1000, staleMs = 4*3600_000, log = console.log, sleep, now, signal, beforeClaim, afterTake, beforeRetire, hostId, host, processStart, pool = null, policy = null, afterEta}) => ownerRecord` | `lock.mjs:1118-1271` |
| `releaseLease` | `(name, id, {env, now, reason = null, hostId}) => {released, cancelled, reason: 'released'\|'none'\|'unknown-holder'\|'not-a-lease'\|'other-lease'\|'changed', owner?}` | `lock.mjs:1277-1315` |
| `updateLease` | `(name, id, fields, {env, ino = null}) => boolean`. Metadata or an earlier `expires_at` only | `lock.mjs:1322-1337` |
| `extendLease` | `(name, id, {forMs, env, now, policy = null, hostId, host, processStart, ino = null}) => newRecord`. The only path that moves expiry later | `lock.mjs:1348-1370` |

### Tickets (format v1, frozen)
| Export | Signature | Evidence |
| --- | --- | --- |
| `TICKET_FORMAT` | `1` | `lock.mjs:438` |
| `TICKET_KINDS` | `Object.freeze(['lease', 'job', 'hub-job'])`. `remote` is deliberately absent | `lock.mjs:439` |
| `TICKET_ABSENT_MS` | `60_000` | `lock.mjs:440` |
| `ticketKind` | `ticket => kind \|\| 'lease'` | `lock.mjs:443` |
| `jobLeaseId` | `({repo, run, attempt, job}) => 'job:<repo>#<run>.<attempt>/<job>'` | `lock.mjs:446` |
| `buildTicket` | `(kind, {env, requested, deadline, lease_id, holder, why, host, hostId, pid = process.pid, processStart, expires_at, reservation, request, pool, eta, delivery}) => body`. It throws on `remote` and on unknown kinds | `lock.mjs:451-478` |
| `ticketStaleness` | `(ticket, {now, host, hostId, processStart, isAlive, mtimeMs}) => null \| 'gone' \| 'pid-reused' \| 'foreign-host' \| 'expired' \| 'abandoned'` | `lock.mjs:488-504` |
| `listWaiters` | `(name, {env, prune = false, now, host, hostId, processStart, isAlive}) => tickets[]` (each with `file` and `stale`) | `lock.mjs:507-533` |

### Reservations
| Export | Signature | Evidence |
| --- | --- | --- |
| `RESERVATION_FORMAT` | `1` | `lock.mjs:545` |
| `RESERVABLE` | `Object.freeze(['adb', 'mac-ios'])` | `lock.mjs:546` |
| `runKey` | `(env) => '<owner>--<repo>--<run>' \| null` | `lock.mjs:552-557` |
| `releaseReservation` | `(name, {env, now, hostId, key = null, reason = 'done'}) => {status: 'released'\|'none', key}`. Never throws | `lock.mjs:644-652` |
| `reserve` | `(name, {env, now, policy, hostId, log, wait}) => {status: 'claimed'\|'reused'\|'skipped', key, reservation}` | `lock.mjs:657-693` |
| `listReservations` | `(name, {env, now}) => [{...record, key, live, grace_started_at, grace_ends_at}]`. Read only | `lock.mjs:697-703` |

### Queue view and ETA
| Export | Signature | Evidence |
| --- | --- | --- |
| `queueView` | `(name, {env, now, policy (unused), includeStale = false, prune = false, host, hostId, processStart, isAlive, afterRename}) => entries[]`. Each entry has `place`, `blocking`, `kind`, `stale` and `file`; a Reservation entry adds `key`, `run_key` and `grace` | `lock.mjs:774-784` |
| `etaHistory` | `({env, now, policy}) => events[]`. Reads only the `eta_window_days` window | `lock.mjs:818-821` |
| `waiterEtas` | `({owner, view, events, policy, now}) => Map<file, eta\|null>`. No I/O | `lock.mjs:827-837` |
| `ETA_REFRESH_MS` | `300_000` | `lock.mjs:860` |

### History helpers (refused, Story 3.4)
| Export | Signature | Evidence |
| --- | --- | --- |
| `REFUSED_NAMES_MAX` | `10` | `lock.mjs:1375` |
| `leaseHoldersSince` | `(name, since, {env, log}) => [{holder, lease_id, acquired_at}]` | `lock.mjs:1388-1412` |
| `deliveryPendingEvent` | `(name, {repo, run}, {env, since, log}) => event \| null` | `lock.mjs:1416-1423` |
| `noteRefused` | `(name, {delivery, installed, installedBy, since, from}, {env, now, hostId, host}) => boolean` | `lock.mjs:1429-1444` |
| `listLocks` | `({env, now, staleMs = 4*3600_000, host, hostId}) => [{name, kind:'lease'\|'lock', owner, stale, describe}]`. It lists every `*.lock` entry in the dir | `lock.mjs:1447-1456` |

### Try semantics
- `acquireLease` with `waitMs` 0 or less is a try (`tryOnly = !(waitMs > 0)`, `lock.mjs:1152`). It writes no ticket (`:1158`) and no `request` (`:1168`). It takes the lock only when nothing that blocks is in the view (every live ticket blocks, `blockersAhead(view, null)` returns all of them, `:790`). On failure it throws `HUB_LOCK_TIMEOUT` with no `timeout` event (`timedOut`, `:1179-1180`).
- The rule "a try writes an event only when it acquires" is not strictly true:
  - A try still prunes, with `view()` and `prune: true` (`:1184`). Pruning retires expired Reservations and appends `expiry` (`:726`).
  - It reclaims a stale holder and appends `reclaim` (`:1248`).
  - It may start the head Reservation's grace and append `grace` (`startGrace`, `:1256`). `reservation.test.mjs:371` pins "the first try or acquirer ... creates grace.json once and appends one grace event".
- `withLock` with `timeoutMs <= 0` on a Queued name is a try as well (`tryOnly`, `lock.mjs:970`). On a bare name, `timeoutMs: 0` gives a `deadline = now` loop that throws `HUB_LOCK_TIMEOUT` on the first held pass (`:238`, `:262`). The emulator reaper relies on this and matches `/host lock emulator-reaper/` (`emulator.mjs:313-315`).
- A Pool probe is a try carrying `pool: poolRequest(...).tag`. Its `acquire` event carries `pool` and `request`, and `waited_ms` runs from `pool.since` (`lock.mjs:1236-1238`).

### Anything named force or reclaim
- **No `forceRelease` function exists.** A grep of `tools/` for `force-release`, `forceRelease` and `force_release` finds only readers: `LEASE_EVENTS`/`LEASE_ENDS` (`lock.mjs:1379-1380`), the `ENDS` set (`eta.mjs:22`) and an `eta.test.mjs:98` fixture.
- "Reclaim" is not an export. It is the internal `retire(..., {as: 'reclaim', reason: verdict})` call that every taker makes on a stale lock (`lock.mjs:258`, `:1072`, `:1248`).
- `retire` itself is private (`lock.mjs:147-183`).

---

## 2. The QUEUED constant

- **Definition:** `lock.mjs:28-31`. `QUEUED = ['adb','s24','mac-ios','emulator']`, plus `isQueued` for the `emulator-<n>` slots. The comment says every other name (`s3-*`, `s3-index`, `emulator-reaper`) writes no events.
- **Uses inside lock.mjs**, all through `isQueued`:
  - `note()` gates every event append on it (`lock.mjs:134-136`). A non-Queued name writes nothing.
  - `withLock` dispatches to `queuedLock` (FIFO tickets) or the bare `mkdir` path (`:233`).
  - `runHeld` runs the `alive` touch interval only for Queued names (`:286`).
  - `endsReservation` takes effect only for Queued names (`:313`).
  - `ownReservation` requires `isQueued` and `RESERVABLE` (`:596`).
- **Exception:** `poolRequest` is NOT gated. It calls `appendEvent` directly (`:928-931`), so a Pool request with any pool name writes events. That contradicts its own comment ("No event for a name outside the Queued pools", `:922`).
- **Consumers outside lock.mjs:** only the test `tools/device/lease.test.mjs:300-303`. It pins `[...QUEUED]` deepEqual to `['adb','s24','mac-ios','emulator']`, pins `isQueued` true for `emulator-0` and `emulator-12`, and pins it false for `s3-tolt`, `s3-index`, `emulator-reaper`, `emulator-x`, `s26` and `adbx`. No product code outside lock.mjs imports `QUEUED` or `isQueued` (grep of `tools/`).
- **Pinned readers** (older hub versions acting on the same lock dir) never read `QUEUED`: it is code, not disk. A pre-v1a pin (v1.2.43) has no Queued concept. It takes bare `mkdir` locks and writes tickets only for Leases (`git show v1.2.43:tools/ci/lib/lock.mjs`, `staleWaiter` at `:139-146`). A pin from v1.2.46 or later carries its own frozen copy of the four names.

### How a v1b Registry can become QUEUED's source without breaking anything
1. Keep the exported `QUEUED` as the frozen seed set, and add a Registry-aware predicate beside it. Otherwise `lease.test.mjs:301` changes, and that would have to be a named intended change. The seed set gives the four names, and `emulator-<n>` stays a regex.
2. The Registry read inside `isQueued` must be **synchronous and local**:
   - `note()` runs inside every transition and must never throw or block (`lock.mjs:132-136`). `withLock` and `runHeld` call `isQueued` synchronously.
   - FR-13 requires that holds work while the API is down.
   - Under the layer table, lock.mjs may import only `events.mjs`, `policy.mjs` and builtins (v1a spine, Layer table). A Registry reader module would be a new allowed import, or the predicate becomes an injected seam.
   - So the predicate is a cached read of a Registry file. It is never an HTTP call to the Hub API.
3. **A name's Queued-ness must never flip while it is held or queued.**
   - If `isQueued` turned false mid-hold, the release would write no event (`note`), and a `withLock` caller would take the bare path, which ignores tickets and jumps the FIFO.
   - Retired Resources must therefore stay Queued. FR-2 keeps them in the Registry file as `retired`.
   - Internal names (`s3-*`, `s3-index`, `emulator-reaper`) must stay non-Queued forever (FR-8, AD-4).
4. New Registry Resources are reached only by Registry-aware code: hub-device after `hosts:install`, and the API. Pinned deploy jobs only ever take `adb`, `mac-ios` and `s3-*` (`plan.mjs:250`, `android.mjs:116`, `ios.mjs:234`, `deliver.mjs:249`, `s3.mjs:219`), so no pin ever touches a Registry-only name.
5. `DEPLOY_TARGETS` (`:366`) and `RESERVABLE` (`:546`) are two more frozen copies of `['adb','mac-ios']`. FR-29 says deploy targets come from `devices.json`, so the Registry's "deploy target" flag and these constants must agree.

---

## 3. Lease liveness: holder_pid versus expiry only

`staleness(path, owner, {now, staleMs, host, hostId})` (`lock.mjs:72-87`) checks these in order:
1. The dir is gone: `gone`. There is no owner record and the dir is more than 60 s old: `abandoned` (`:74-76`).
2. **Lease** (finite `expires_at`, `:79`):
   - `expires_at <= now` is `expired`.
   - The Lease is live when the owner is on another host (`sameHost` false), or when `holder_pid` is not a safe integer (`:81`). **A Lease with no `holder_pid` is judged by expiry alone.**
   - A dead `holder_pid` is `holder-gone`. So is a live one whose `processStart` differs from `holder_process_start` (`:82-83`).
   - The Lease's own `pid` (the acquiring process) is never checked. `lease.test.mjs:80-93` pins this: "a lease without a pid is not judged by its caller".
3. **Job**: a dead `pid` on the same host is `holder-gone`. Otherwise `too-old` once the dir's mtime age exceeds `staleMs` (`:85-86`).

A Lease is judged by expiry and holder only, never by age (`liveLease` passes `staleMs: Infinity`, `:58`).

**No-pid Leases are the normal case today.**
- `hub-device lease s24|s26|phone` passes `holderPid` only from `--pid` (`hub-device.mjs:159-161`), and it is null by default (`:346`).
- `--no-connect` is orthogonal: it only skips `findPhone` and the `device` metadata write (`hub-device.mjs:171-196`).
- `hub-device run` ties the Lease to `holderPid ?? process.pid` (`:707`, `:762`).
- Emulator Leases take the gate and the slot with `holderPid: process.pid` (`emulator.mjs:503`, `:523`). At ready they rewrite `holder_pid` to the caller's `holderPid`, which is null for `lease emulator` without `--pid` (`emulator.mjs:615-622`). That rewrite goes through `updateLease`, which forbids a later expiry (`:618-620`).

**How a no-pid Lease is reclaimed.** Only lazily, by the next Claimant that finds it stale: `acquireLease`, `withLock` or a try. The verdict is `expired`, and the result is `retire(name, path, owner, {as: 'reclaim', reason: 'expired'})`, which renames the lock to a tomb and appends `reclaim` (`lock.mjs:1243-1249`, `:257-258`, `:1070-1073`). No clock exists (AD-19).
- Until a Claimant comes, the expired dir stays. `listLocks` shows it `stale: true` (`:1454`), status prints `EXPIRED ... ago` (`hub-device.mjs:642`) and `liveLease` returns null.
- `held_ms` of a reclaimed Lease ends at `min(at, expires_at)` (`heldMs`, `lock.mjs:126-130`).

**What an API process taking an expiry-bound Lease writes.** `acquireLease(name, {holder, why, forMs, waitMs, id, holderPid: null, env})` writes `owner.json` through `writeOwner` (`lock.mjs:1198-1209`):

```
{ pid: <API pid>, host: os.hostname(), repo: env.GITHUB_REPOSITORY ?? null, run: env.GITHUB_RUN_ID ?? null,
  started_at, kind: 'lease', lease_id, holder, why, expires_at: started + forMs,
  holder_pid: null, holder_process_start: null, format: 1,
  attempt: env.GITHUB_RUN_ATTEMPT ?? null, job: env.GITHUB_JOB ?? null, host_id, lock_ino: "<inode>" }
```

- `repo`, `run`, `attempt` and `job` come from the **process env**. No parameter carries a remote caller's identity: only `holder` and `why` are free text. The only way to stamp a caller's repo or run is to pass a per-request `env` object with `GITHUB_*` set. The same `env` also selects `HUB_LOCK_DIR` and `HUB_EVENT_DIR`.
- The API's service env must not carry `GITHUB_*`, or every API Lease and event would inherit them.
- `eventOf` always labels a Lease claimant `kind: 'agent'` (`lock.mjs:113`, comment `:104-105`: "v1a has no person surface"). The spine's event shape lists `person` (Consistency Conventions), but no code writes it.
- Such a Lease survives an API restart (FR-23), because `holder_pid` is null and the Lease's `pid` is ignored.
- Passing `holderPid: process.pid` from the API would tie every Lease to the API's lifetime. That violates FR-10 ("has no process") and FR-23.
- `pid` and `host` remain the API's, so `describe()` and status show the API pid for a Lease record (`hub-device.mjs:564`).
- A pre-v1a pin honours the same Lease until expiry: `v1.2.43 stale()` returns false when `holder_pid` is not an integer (`git show v1.2.43:tools/ci/lib/lock.mjs:47-52`).
- `MAX_LEASE_MS` caps the total (`:1143`). Deploy targets are capped at 60 min by policy (`:1145-1146`, `policy.json:59`). `extendLease` counts its cap from `started_at` (`:1360-1365`). So **no Lease can hold longer than 48 h**, which rules out a Lease as a long-lived daemon singleton.

---

## 4. How a queued ticket is tied to a process, and an API holding tickets for many callers

- `acquireLease` waiters write `buildTicket('lease', {env, requested, deadline, lease_id, holder, why, host, hostId, processStart, eta})` with no `pid` argument (`lock.mjs:1161`). So `pid = process.pid` and `process_start = startOf(process.pid)` (`:453`, `:474`).
- The file name is `<ms15>-<counter6>-<pid8>.json` (`ticketName`, `:802`). `ticketCounter` is module-level (`:416`), so many tickets from one process never collide.
- The ticket is written tmp-then-rename (`writeTicket`, `:806-814`).
- Liveness follows `ticketStaleness` (`:488-504`):
  - A positive `pid` on the same host is live while that pid is alive with the same start. It is stale only on positive evidence: `gone` or `pid-reused`. An unreadable or unrecorded start keeps it live.
  - A v1 ticket from another host falls to rule 3 (`expires_at`) or rule 4 (60 s after `enqueued_at`).
  - A ticket from before v1a on another host is `foreign-host`.
  - The rows are pinned in `lease.test.mjs:732-780`.

**With the API as the waiter for N remote callers:**
- Every ticket carries `pid = API pid` and `host = big-chungus`. The rows are distinct (separate counter and file) and FIFO among themselves by file name.
- The process does **not** release the tickets. Each one is removed only by its own in-process `acquireLease` loop: on acquire (unlink at `:1226-1233`), on timeout (`leave('timeout')`, `:1179-1182`), on abort or error (`finally`, `:1262-1270`), or by `releaseLease(name, id)` from any process (`:1280-1301`).
- So the API must keep one live `acquireLease` promise per remote waiter. Each polls `queueView(prune: true)` every `pollMs` (default 1000 ms, `:1126`).
- `acquireLease` does **not** use `cachedStart`; only `queuedLock` does (`:976`). Every poll of every waiter reads the process start of every ticket. On Linux that is a `/proc` read. On the Mac it is a `ps` spawn, which matters for the Host Agent.
- A remote caller that disconnects is invisible to the protocol. Its ticket stays live while the API lives, until the API aborts that waiter's `signal` (giving `cancel`, reason `aborted`) or its `waitMs` runs out (giving `timeout`, reason `deadline`).
- **On an API crash or restart**, every ticket becomes `gone`, or `pid-reused` if the pid is recycled, and the next acquirer prunes them.
  - That matches FR-23 ("A request waiting in line through the API is tied to the API's process. A restart drops it").
  - But a prune writes **no event**: `listWaiters` with `prune` calls `rmSync(..., {force: true})` and nothing else (`lock.mjs:521`, `:530`). The Event Log would hold `request` events with no ending.
  - The v1a spine's AD-9 table lists `prune` with the deciding step "`unlinkSync` of the ticket", and says nothing on these paths uses a forced `rmSync`. Neither is implemented.
- A pre-v1a pin honours API tickets: v1.2.43 `staleWaiter` requires the same hostname, an integer pid and a truthy `process_start` (`git show v1.2.43:tools/ci/lib/lock.mjs:139-146`). An API ticket meets all three.
- `kind: 'remote'` (pid-less, expiry-bound) is reserved and refused by `buildTicket` (`lock.mjs:456`, pinned in `lease.test.mjs:726`). AD-3 permits it only after every pre-freeze pin has aged out (30 days).
  - The freeze shipped in v1.2.46, tagged 2026-11-24. `git tag --contains 0832ee1` and `--contains 3ce85f4` both start at v1.2.46.
  - So pins from v1.2.45 or earlier, whose `staleWaiter` deletes pid-less tickets, run until about 2026-12-24.
- `mac-ios` requests must be written on the Mac (AD-1), so the Host Agent is the waiter process there, and its restart drops Mac-side queued requests in the same way.

---

## 5. Cancel a queued request, force-release, and which events they write

There is **no force-release** and **no cancel-only function**. The cancel paths that exist today:

| Path | Who | Event (written by the deciding unlink or rename) | Evidence |
| --- | --- | --- | --- |
| `releaseLease(name, id)`, ticket branch | any process on the host | unlinks every ticket in `<name>.queue` whose `lease_id === id`, and writes one `cancel` per ticket (`reason: 'released'`, `waited_ms` from `enqueued_at`). A job or hub-job ticket cancels as that job; a Lease ticket as `{kind:'lease', lease_id, holder}` | `lock.mjs:1280-1300` |
| `releaseLease(name, id)`, hold branch | any process | the same call also releases the hold when `owner.lease_id === id`, with a `release` event and `reason ?? 'by-id'`. If it cancelled the id's own ticket in that same call, the retire writes nothing (`as = null`) | `lock.mjs:1302-1314` |
| `releaseLease(name, null)` (`--any`) | any process | releases whichever **Lease** holds the lock: `release`, reason `any`. It refuses a job's lock (`not-a-lease`) | `lock.mjs:1308`, `:1313` |
| Waiter aborted (`signal`) | the waiter process | `cancel`, reason `aborted` | `lock.mjs:1191`, `:1264-1267`; pinned `lease.test.mjs:527-548` |
| Waiter error | the waiter | `cancel`, reason `error` | `lock.mjs:1266` (Lease), `:1093` (job) |
| Job wait meets a Lease with `yieldToLease` | the job | `cancel`, reason `yield-to-lease`, and the job throws `HUB_LOCK_YIELDED` | `lock.mjs:1011-1015`, `:270` |
| Waiter's ticket vanished | the waiter | throws `HUB_LEASE_CANCELLED` (`was released while it waited for`, `lost its place in the queue for`). It writes no event of its own: the releaser wrote the `cancel`, and a prune writes nothing | `lock.mjs:1192-1194`, `:1028-1030` |
| `poolRequest().settle(error, {signal})` | the requester | a Pool-level `timeout` (reason `deadline`, or `away` for `HUB_PHONE_AWAY`, with `blocked_by`) or `cancel` (reason `aborted`, `released` for `HUB_LEASE_CANCELLED`, else `error`), with `lock: null`, `pool` and `request` | `lock.mjs:940-951` |
| `releaseReservation(name, {key, reason})` | any process on the host | renames the dir to `.released-<key>-<ms>`, and the winner writes `release` with `hold_kind: 'reservation'` and `reason` (default `done`; the `hub-device reservation release` verb passes `released`) | `lock.mjs:644-652`, `:615-637`; `hub-device.mjs:401` |
| Emulator reaper | the reaper | `releaseLease(slot, id, {reason: 'reaped-<why>'})`, a `release` with that reason | `emulator.mjs:305` |

Notes:
- The library will cancel a **job ticket** by its `job:` id. Only the CLI refuses that, with exit 2 and `HUB_DEVICE_JOB_ID` (`hub-device.mjs:413-423`). An API cancel endpoint must refuse `job:` ids the same way (FR-11: Job Holds end by cancelling the run).
- `releaseLease(name, id)` cannot express "cancel my request but keep my Lease". A cancel that races the serve releases the just-acquired Lease.
- `force-release` is reserved but never written. Readers already treat it as a hold ending (`eta.mjs:22`, `lock.mjs:1379-1380`), and AD-9 gives its deciding step: the rename of `<name>.lock` to a tomb.
- FR-11 needs "who and why". The event body has no actor field beyond `claimant`, which describes the subject, not the actor (`eventOf`, `lock.mjs:107-122`). FR-31's override recorded "with who and why" has nowhere to go either: `extendLease` has no override option and refuses outright while anything blocks (`:1356-1359`).

---

## 6. events.mjs: append and read API, layout, fields, names

- **Layout.** `eventDir(env, home)` returns:
  - `HUB_EVENT_DIR`, else `$XDG_STATE_HOME/mobile-deploy-hub/events` when that is absolute, else `~/.local/state/mobile-deploy-hub/events` (`events.mjs:17-21`).
  - Inside it, one file per UTC month, `<YYYY-MM>.jsonl` (`record.ts.slice(0,7)`, `:88`). The dir is mode `0o700` and the files `0o600` (`:87-88`).
- **Live state:** big-chungus has `~/.local/state/mobile-deploy-hub/events/2026-11.jsonl` (1317 lines on 2026-11-24).
- **Append.** `appendEvent(event, {env, now, log = console.error, host, hostId, hubFile}) => boolean` (`events.mjs:71-97`):
  - One `writeSync` on an `'a'` (O_APPEND) fd; a short write throws.
  - The envelope is `format: 1`, `ts` (ISO), `host` (the `host` option or `os.hostname()`), `host_id` (the option or `hostId()`) and `hub_version` (`hubRef(env)`, else `'unknown'`). It overrides any caller keys of the same name and is serialized first (`:74-85`).
  - A record is capped at `EVENT_MAX_BYTES = 4096` (`:12`). `fit()` trims `why`, then `reason` (`TRUNCATABLE`, `:13`, `:50-66`); a line that still cannot fit is skipped (`E2BIG`).
  - It never throws. A failure logs `HUB_EVENT_LOG_FAILED <code> <msg>` (`:93-96`).
  - lock.mjs's `note()` passes `{env, now, hostId}` and **not `host`** (`lock.mjs:135`). So an injected `host` seam never reaches the event, and the envelope host is always `os.hostname()`.
- **Read.** `readEvents({env, since, until, log, stats})` is a **generator** (`events.mjs:106-134`):
  - It reads files in month order and lines in write order, restricted to `ts` in [since, until).
  - Months outside the bounds are not opened.
  - It counts malformed lines and logs one `HUB_EVENT_LOG_SKIPPED <file> malformed=<n>` per file.
  - It reads each month file whole (`readFileSync`). It has **no tail, follow, offset or cursor API**, and events carry **no id or sequence number**.
- **`hostId(options)`** reads `/etc/machine-id` on Linux and `IOPlatformUUID` from `ioreg` on the Mac (`events.mjs:27-43`). It is cached per process, and injected options bypass the cache.
- **Event body.** `eventOf(event, name, subject, fields)` builds it (`lock.mjs:107-122`). Keys: `event, lock, hold_kind ('lease'|'job'|null; 'reservation' via fields), claimant {kind: 'agent'|'deploy'|'hub-job'|null, holder, repo, run, attempt, job}, lease_id, for_ms, expires_at, deadline_at, waited_ms, held_ms, reason, last_alive_at`. Optional extras: `eta`, `blocked_by`, `pool`, `request`, `delivery`, `approx`, `reservation`, `run_key`, `reserved_at`, `grace_ms`, `grace_started_at`, `installed`, `installed_by`, `installed_by_more`, `pending_since`, `pending_from` (`:180`, `:603-605`, `:991`, `:1435-1442`). The pinned exact bodies are in `lease.test.mjs:489-493`.
- **Event names written today** (grep of `eventOf(`, `as:`, `write(`, `leave(` in lock.mjs):
  - `request` (`:991`, `:1168`, Pool `:933`)
  - `acquire` (`:1062`, `:1238`)
  - `release` (`:322`, `:650`, `:1312`)
  - `reclaim` (`:258`, `:1072`, `:1248`)
  - `cancel` (`:949`, `:1013`, `:1093`, `:1266`, `:1298`)
  - `timeout` (`:946`, `:1007`, `:1181`)
  - `extend` (`:1368`)
  - `claim` (`:689`)
  - `grace` (`:751`)
  - `expiry` (`:679`, `:726`)
  - `refused` (`:1435`)
- **Read but never written:** `force-release`.
- **Listed in AD-9 but not implemented:** `prune`.
- **There are no Registry or Reachability events.** FR-17 asks for "each Registry change and Reachability change". No name, `hold_kind` or `claimant.kind` exists for them, and `note()` would drop any event whose `lock` is not Queued.
- **Live distribution** in big-chungus `2026-11.jsonl` (read-only count):

  | `event \| lock \| hold_kind` | count |
  | --- | --- |
  | `request\|adb\|job` | 428 |
  | `acquire\|adb\|job` | 373 |
  | `release\|adb\|job` | 373 |
  | `timeout\|adb\|job` | 55 |
  | `claim\|adb\|reservation` | 35 |
  | `release\|adb\|reservation` | 33 |
  | `grace\|adb\|reservation` | 14 |
  | `expiry\|adb\|reservation` | 1 |
  | `request\|adb\|lease` | 2 |
  | `acquire\|adb\|lease` | 1 |
  | `release\|adb\|lease` | 1 |
  | `timeout\|adb\|lease` | 1 |

  Requests balance exactly: 428 = 373 + 55.

---

## 7. Atomic write helpers in lock.mjs

All of them are **private**. None is exported.

| Helper | What it does | Evidence |
| --- | --- | --- |
| `writeOwner(path, owner)` | `owner.json.<pid>.tmp`, then `renameSync` to `owner.json` | `lock.mjs:357-362` |
| `rewriteOwner(name, path, id, ino, next)` | writes the tmp, re-checks `ownLease` (lease_id and inode), renames, and removes the tmp on loss. It throws `HUB_LEASE_LOST` | `lock.mjs:399-414` |
| `writeTicket(name, body, {env, requested, file})` | `<file>.tmp` with `flag: 'wx'`, then rename. `listWaiters` reads only `*.json`, so a `.json.tmp` is never parsed | `lock.mjs:806-814`, `:510` |
| create-once with `wx` | `reservation.json` (`:669`) and `grace.json` (`:749`) | |
| `retire(name, path, judged, {...})` | renames the lock to `<path>.tomb-<ms>-<pid>`. The `lastTomb` counter is monotonic per process (`:138`, `:152`). Only the winner deletes the tomb and appends the event; a put-back logs `HUB_LOCK_LOST` | `lock.mjs:147-183` |
| `retireReservation` | renames to `.released-<key>-<ms>` (`lastReleased`, `:608`) | `lock.mjs:615-637` |

- **Inconsistency:** the bare `withLock` path writes `owner.json` with a plain `writeFileSync`, not `writeOwner` (`lock.mjs:247`). `queuedLock` and `acquireLease` use `writeOwner` (`:1038`, `:1209`).
- The v1a spine's convention reads "One helper in lock.mjs: tmp plus rename ... No new copies". In fact there are several private helpers and no exported one. A v1b Registry file writer outside lock.mjs would have to export one of these, or else become the copy the convention forbids.
- `events.mjs` keeps its own O_APPEND writer (`:88-91`).

---

## 8. The injected seams

The convention is `{env, now, sleep, log, host, hostId, processStart, policy}` (v1a spine, Consistency Conventions). What the code actually takes:
- `withLock`: `env, now, sleep, log, host, hostId, processStart, policy, timers {setInterval, clearInterval}, deadlineSeams`. Test hooks: `beforeRetire, afterTake, afterEta` (`lock.mjs:206-228`).
- `acquireLease`: `env, now, sleep` (via `pause`, `:1260`), `log, host, hostId, processStart, policy, signal`. Hooks: `beforeClaim, afterTake, beforeRetire, afterEta` (`:1118-1141`).
- `queueView`: `env, now, host, hostId, processStart, isAlive`, hook `afterRename` (`:774`).
- `listWaiters`: `env, now, host, hostId, processStart, isAlive` (`:507`).
- `ticketStaleness`: `now, host, hostId, processStart, isAlive, mtimeMs` (`:488`).
- `buildTicket`: `env, host, hostId, pid, processStart` (`:451-455`).
- `extendLease`: `env, now, policy, hostId, host, processStart, ino` (`:1348`).
- `releaseLease`: `env, now, reason, hostId` only (`:1277`). `updateLease`: `env, ino` only (`:1322`).
- `reserve`: `env, now, policy, hostId, log, wait` (`:657`). `releaseReservation`: `env, now, hostId, key, reason` (`:644`).
- `listLocks`: `env, now, staleMs, host, hostId` (`:1447`). `liveLease`: `env, now, host, hostId` (`:54`).
- `poolRequest`: `env, now, hostId` (`:923`).
- `appendEvent`: `env, now, log, host, hostId, hubFile`. `readEvents`: `env, since, until, log, stats`.
- `pause(ms, {signal, sleep})` (`pause.mjs`).

Gaps in the seams:
- The owner `staleness()` reads `alive()` and `processStart()` from module scope (`lock.mjs:82-83`, `:85`), so an injected `processStart` never reaches owner liveness. It reaches only ticket liveness and the `holder_process_start` stamp.
- `note()` drops `host` (section 6).
- The hermetic test fixture (`test-fixtures.mjs:36-49`) clears `GITHUB_*`, points `HUB_EVENT_DIR` and `HUB_LOCK_DIR` at scratch dirs, and replaces `globalThis.fetch` with a thrower.

---

## 9. Lock names, reserved and internal, and a `hub-api` singleton

- **The name grammar** is `/^[a-z0-9-]+$/` (`withLock` `lock.mjs:229`; `leaseName` `:329`).
- **Names in use:**

  | Name | Kind | Evidence |
  | --- | --- | --- |
  | `adb` (the S26), `s24`, `mac-ios`, `emulator` (the pool gate, `GATE`), `emulator-<n>` (slots) | Queued | `lock.mjs:30-31`; `emulator.mjs:29-31`; `hub-device.mjs:57-64` |
  | `emulator-reaper` | bare | `emulator.mjs:34`, `:300`, `:341` |
  | `s3-<slug>` | bare | `deliver.mjs:249`, `bucket-policy.mjs:208`, `catchup.mjs:774/838/852` |
  | `s3-index` | bare | `s3.mjs:219` |

  - `s24` is `android_extra[].name.toLowerCase()`, so every extra phone's lock name derives from `devices.json`.
  - Slugs follow `/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/` (`policy.mjs:194`).
- **Other entries in the lock dir that are not locks:**
  - `emulators/` (the records dir, `emulator.mjs:191`)
  - `emulator-pool` (a file, `emulator.mjs:66`)
  - `<name>.queue/`, `<name>.reservations/` and transient `<name>.lock.tomb-*`
  - Live on big-chungus: `adb.queue`, `adb.reservations`, `emulator.queue`, `emulator-1.queue`, `emulators` and `s24.queue`. No lock is held right now.
- **CLI words that are not lock names:** `phone`, `s26`, and `ipad`/`mac` (planned, FR-12). FR-1's refusal list is `phone`, `emulator`, `adb`, `s24`, `s26`, `ipad`, `mac`, `mac-ios`, `emulator-N`, `emulator-reaper` and `s3-*` (PRD `prd.md:110`).

**Would `hub-api` collide?** Not with any current name, and not with `s3-*`, which is prefixed. But:
1. It is **not on FR-1's refused list**, so a Registry Resource could later be registered as `hub-api`. If the singleton uses a lock name, add that name to the list.
2. `listLocks` lists **every** `*.lock` in the dir (`lock.mjs:1450`). `hub-device status` would then print the singleton forever under LOCKS, as `hub-api  JOB LOCK  a local run run -  pid=...` (`hub-device.mjs:635-646`), and add it to `--json` `locks`. It would also run `queueView` on it (`:583`). That is a permanent status text change, and AD-17 freezes status text apart from named changes. `phones[].held` is unaffected.
3. If the singleton is held with `withLock('hub-api', serve)` (the bare path), the default `staleMs` of 4 h makes it `too-old`: a second starter **reclaims it from a live first instance** after 4 h (`lock.mjs:85-86`).
   - The age is the dir mtime. The `alive` touch runs only for Queued names (`:286`), and touching an existing file does not move the dir mtime anyway.
   - Such a singleton needs `staleMs: Infinity`. A crashed holder on the same host is still reclaimed (`holder-gone`).
4. A Lease cannot be the singleton, because no Lease lasts past 48 h (section 3).
5. A loopback port bind (EADDRINUSE) or a pidfile outside `HUB_LOCK_DIR` meets FR-23 ("a second one refuses to start") without touching the protocol dir or status output.

---

## 10. owner.json fields today

- **Job or hub-job** (`withLock`, `jobIdentity`, `lock.mjs:273-278`, `:246`, `:1034`):

  ```
  {pid, host, repo, run, started_at, format: 1, kind: 'job'|'hub-job', attempt, job, host_id}
  ```

  The older-reader keys `pid, host, repo, run, started_at` come first (`:272`; pinned for Leases at `lease.test.mjs:483-484`).
- **Lease** (`acquireLease`, `lock.mjs:1198-1203`, `:1208`):

  ```
  {pid, host, repo, run, started_at, kind: 'lease', lease_id, holder, why, expires_at, holder_pid, holder_process_start, format: 1, attempt, job, host_id, lock_ino}
  ```

  `lock_ino` is a string inode, used by `ownLease` (`:383-397`).
- **Added later through `updateLease`:**
  - `device: {phone, serial, adb_id, adb_port}` (`hub-device.mjs:170`, `:191`)
  - `emulator: summary(record)`, with a rewritten `holder_pid`, `holder_process_start` and an earlier `expires_at` (`emulator.mjs:621-622`)
- `OWNER_FORMAT = 1` (`lock.mjs:35`).
- **Pre-v1a owners** (no `format`, no `kind` for jobs, no `host_id`) still parse and are judged by hostname (`lock.mjs:41`, `:77-78`; pinned at `lease.test.mjs:127`, `:655`).
- **`AD3_KEYS`, the ticket body in order:** `format, kind, lease_id, holder, why, pid, host, host_id, process_start, enqueued_at, deadline_at, expires_at, repo, run, attempt, job, reservation, request, pool, eta, delivery` (`lease.test.mjs:683`, `lock.mjs:472-477`).
- **Reservation record:** `{format, run_key, repo, run, reserved_at, expires_at, grace_ms}`, plus `grace.json {format, grace_started_at}` (`lock.mjs:667`, `:749`).

---

## policy.json `queue` block, and the strict parser

- **Values:** `policy.json:59`:

  ```
  {wait_margin_min: 2, hold_allowance_min: {plan: 5, android: 15, ios: 60}, grace_min: 10, reservation_ceiling_min: 180,
   deploy_target_lease_max_min: 60, catchup_attempt_s: 5, catchup_pending_wait_min: 30, eta_window_days: 30, eta_low_data_min_holds: 20}
  ```

- `queueBlock` is `exact()`: it refuses unknown keys, requires every key, and requires positive integers (`policy.mjs:290-303`).
- The top level is also `exact()` over `schema, bump, event, manifest_schema, apps, callers, runners, devices, delivery, mac, catch_up, queue`, with `completion` and `shared_bundle_allowlist` optional (`policy.mjs:162`).
- So any v1b tunable placed in policy is a parser change and a hub release: Reachability max age (PRD's 60 s assumption), an API port, or the SSE keepalive. Examples are a `registry` or `api` block.
- `loadPolicy(file)` returns `{policy, sha256, short}` (`policy.mjs:323-328`).

## eta.mjs (pure)

- `eta(queue, events, policy, now) => {lo_ms, hi_ms, low_data}` (`eta.mjs:72-153`). It imports nothing.
- Past holds are `release`, `reclaim` and `force-release` events of `hold_kind` `job` or `lease` with a finite `held_ms` (`:22`, `:42-59`).
- Lease shares count only for `claimant.kind === 'agent'` (`:80`). A Lease labelled `person` (FR-11, Control Surface) would contribute no history samples unless `eta.mjs` changes.
- `formatEta(value)` (`:166-170`) and `etaMoved(a, b)` (`:174-179`).
