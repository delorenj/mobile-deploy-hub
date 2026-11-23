# Addendum: Hub Resource Registry

This is the mechanism and evidence behind `prd.md`, kept here so the PRD stays about capabilities. It is input for `bmad-architecture`, not a decision of record. Line references are against v1.2.42 (`fc98114`); the four review files in this folder (`review-*.md`, `reconcile-inputs.md`) hold the full code evidence.

## A. Where today's behaviour comes from

### Lock model

- **Implementation:** `tools/ci/lib/lock.mjs`. A lock is an atomic `mkdir <lockDir>/<name>.lock` holding `owner.json`. The lock dir is `$HUB_LOCK_DIR` or `~/.cache/mobile-deploy-hub/locks`.
- **Lease record:** `kind:'lease'`, `lease_id`, `holder`, `why`, `expires_at`, `holder_pid` and `holder_process_start`. The maximum is 48h (`MAX_LEASE_MS`).
- **Lease queue:** first-in-first-out tickets in `<name>.queue/<ms>-<counter>-<pid>.json`, polled every 1s by `acquireLease`, which prunes stale tickets on every poll (`listWaiters(..., {prune:true})`, `:213`).
- **Ticket staleness** (`staleWaiter`, `:139-146`): a ticket from another host, without `pid`/`process_start`, or naming a dead or reused process is stale. Nothing without a live local process can live in `.queue/`. `staleWaiter` has no covering test today.
- **Owner staleness:** a Lease from another host is judged only by its expiry (`:49`); a job owner from another host goes stale after `staleMs` (4 h, `:53`). Only queue tickets are host-bound. Two consequences: the Hub API must run on big-chungus as the runner user (because of the tickets and the local `holder_pid` checks), and a dead Mac-side job lock can block for 4 hours.
- **Deploy job locks:** `withLock` (`:65-97`) retries `mkdir` every 2s and never reads or writes the queue. This is the starvation mechanism. Wait budgets today:
  - plan waits 20 min in a 20 min job (`plan.mjs:234`, `mobile-deploy.yml:196`);
  - android waits 20 min after its build in a 45 min job (`android.mjs:156`, `mobile-deploy.yml:258`);
  - iOS waits 40 + 40 min around in-lock builds in a 120 min job (`ios.mjs:344,390`, `mobile-deploy.yml:377`).
- **`withLock` also guards internal locks:** `s3-index`, `s3-<slug>`, `emulator-reaper` (`s3.mjs:219`, `deliver.mjs:249`, `bucket-policy.mjs:208`, `emulator.mjs:297,340`).
- **Parsed wording:** the catch-up matches `/host lock adb is held/` and `/host lock mac-ios is held/` (`catchup.mjs:469,591`); the reaper matches `/^host lock emulator-reaper /` (`emulator.mjs:312,342`). Any rewording breaks them.
- **`updateLease` race** (`:290-299`): read, check, rename-write, with no `expires_at > now` check. A late renewal can overwrite the record of a holder that reclaimed the lock in between.
- **`reclaim` race** (`:58-63`): read, compare, `rmSync` can delete a holder that took the lock in between.

### The plan job and the `adb` gap

- The gate calls `findPhone` with **no lock** (`gate.mjs:138-147`); it can start the adb server and mDNS-connect while a Lease holds the S26.
- The plan job holds `adb` to read the S26's installed versionCode (`plan.mjs:228-243`) and refuses a planned code at or below it **before** `bumpTransaction` (`:254`, guard at `:274-276`). If the S26 is away, `phone` is null and the bump goes ahead blind.
- The build runs **inside** the android job, before its `withLock('adb')` (`android.mjs:49-112`). The gap between plan's Hold and the install is the whole android job up to the install.
- The android job's own guard (`android.mjs:126`) refuses a device whose versionCode is above the planned one, after the version is spent.
- An away S26 at install time marks the delivery `pending` (`android.mjs:116-121`), and the catch-up installs it later. PRD FR-30 reuses that path for a busy S26.

### The `phone` word

- Each pass is `acquireLease` with `waitMs:0`, s24 first (`hub-device.mjs:199-226`), so a `phone` request holds no place in line. `hub-device.test.mjs:253-312` pins the ordering and the BUSY/AWAY wording.

### `mac-ios`

- It covers the Mac **build** and the iPad install (`ios.mjs:276-344`), taken twice per iOS job (`:276`, `:390`), and the iPad catch-up (`catchup.mjs:574-592`). `preflight-ios` reads the iPad's version with no lock.
- It lives on the Mac's disk, so big-chungus cannot see it.
- devicectl and the keychain work only inside the Mac's logged-in GUI session, never over plain ssh (`.candybars/mobile-deploy-hub-ios-catchup/kick.mjs:4-6`).
- The iPad catch-up is a one-shot LaunchAgent (`sh.delo.mobile-deploy-hub.catchup`, no interval) kicked by a candybar every 5 minutes; `kick.mjs` reports a running job as `HUB_MAC_BUSY`, which counts as a success.

### Versions in play at once

| Reader/writer | Which version it runs | How it moves |
|---|---|---|
| Deploy jobs | the run's pinned tag | pin flip; reruns keep their pin for GitHub's 30-day window |
| S26 catch-up (big-chungus) | `~/.local/share/mobile-deploy-hub/current` | advances at every real deploy's deliver job (`deliver.mjs:295`) |
| iPad catch-up (Mac) | the Mac's `current` | advances at every real iOS job (`ios.mjs:401-402`) |
| `hub-device` | the release dir `hosts:install` wrote | only at `hosts:install` |
| Hub API, Mac Host Agent (new) | whichever release they were started from | until they restart |

### History

- None is kept. Release deletes the record (`lock.mjs:61,103`), tickets are unlinked, and emulator records are removed (`emulator.mjs:263`). Owners carry `repo`, `run` and `started_at` but no `job`.

### Declarations

- `tools/ci/devices.json` has a fixed shape: one `android`, `android_extra[]`, one `ios`, `mac` and `linux` (`devices.mjs:11-40`). `s26` is already a reserved word (`devices.mjs:35`).
- Deploys hard-code the S26 identity and the `adb` lock: `plan.mjs:230`, `android.mjs:112`, `gate.mjs:138-147` (identity only), `catchup.mjs:456`; and `mac-ios`: `ios.mjs:276,390`, `catchup.mjs:574`.
- `hub-device.test.mjs:332-343` fails if any file under `tools/ci/{lib,commands}` or `tools/catchup` mentions `android_extra`, so Registry seeding code lives under `tools/device/` or a new `tools/registry/`.
- The emulator Pool size is already runtime config: `$HUB_EMULATOR_POOL` > `<lockDir>/emulator-pool` (`emulator.mjs:62-69`, pinned by `emulator.test.mjs:375-380`). Only `MAX_POOL` is a constant.

## B. Suggested mechanism (for architecture to confirm)

### 1. Event Log first

- An append-only `<lockDir>/events.jsonl` on each host, written with `O_APPEND` (small appends are safe across processes). Each record:

  ```
  {v, ts, host, hub_version, resource, lock, event, claimant_kind: deploy|hub-job|agent|person, hold_kind: job|lease|reservation|request,
   id, repo, run, job, holder, enqueued_at, started_at, last_alive_at, waited_ms, held_ms, position, eta_at_enqueue, reason, expires_at, actor}
  ```

- Events: request, acquire, release, extend, timeout, cancel, claim, expire, reclaim, force-release, override, pending (FR-30), registry-add/edit/retire, reachability.
- Emit each event once, from these places: `withLock` (request before its loop, acquire, timeout, release in `finally`), `acquireLease` (request after the ticket rename, acquire, timeout, cancel in `finally`), `reclaim()` (with a reason), `releaseLease`, `listWaiters` prune, `updateLease`, emulator reap failure (capacity loss).
- Scope: Registry Resources only. The internal locks write nothing.
- A GitHub-killed job writes no release; the next acquirer's reclaim records `last_alive_at` from the dead owner's record so `held_ms` is not inflated.
- Ship this in a hub release before anything else, so history starts building up.

### 2. Deploy jobs join the queue

- `withLock` writes a ticket in the existing pid-bound format with `kind:'job'`, `repo`, `run`, `job` (`GITHUB_JOB`), and takes the lock only at the head. `acquireLease` from v1.2.26 on already honours such tickets.
- Wait budgets become relative to the job's start: a new action input carries the job's `timeout-minutes` (hub-side change; the caller template is unaffected).
- The timeout keeps the `host lock <name> is held` wording, and adds a machine-readable code.
- Text status prints repo/run/job for job tickets (today it prints `undefined`, `hub-device.mjs:553`).

### 3. Reservations and the Peek

- `<name>.reservations/<enqueued_at>-<run>.json` holding `{run, repo, taken_at, grace_s, head_since, expires_at}`. A separate directory, because `staleWaiter` deletes tickets with no live pid, and never an `owner.json`, because every pin's `stale()` reclaims an owner with no live pid.
- Written early and locally: the `adb` Reservation in the gate (Linux), the `mac-ios` Reservation in `preflight-ios` (on the Mac, so every `mac-ios` timestamp is the Mac's clock).
- Serving rule: merge `.queue/` and `.reservations/` by `enqueued_at`. A Reservation at the head whose run is not asking idles a free Resource for `grace_s`, once (`head_since` records it). After that the next ticket is served; the Reservation keeps its `enqueued_at` and never idles the Resource again.
- Same-run passthrough: a `withLock` whose `GITHUB_RUN_ID` matches a live Reservation goes through it, so plan, android, and iOS's two takes never wait on their own run.
- The Peek: plan reads the installed versionCode with a read-only `adb shell` query while a **Lease** holds the S26 (never while a Job Hold does). It takes no lock and starts no server.
- Release: the run's last Job Hold, or the `announce` job (`if: always()`, `mobile-deploy.yml:511-514`) deletes the run's Reservations, locally for `adb` and over ssh for the Mac's; the `expires_at` ceiling covers a run that never reaches `announce`.
- The serving rule and the reservation format must ship in the **same** release as queue-joining `withLock`; any later addition is ignored forever by the pins in between.

### 4. Remote tickets (format only in v1)

- The first queue-joining release freezes the ticket format, so it must already recognise `kind:'remote'` tickets, with their own `expires_at` that every pruner honours, even though v1 writes none.
- v2 remote waiting uses them with Heartbeats renewing `expires_at`, the quarantine encoded in the on-disk `expires_at` (pinned `stale()` reclaims exactly at it), and the Lease's stated end in a separate `ends_at`.
- `updateLease` gets an expiry check in v1a regardless (PRD FR-10).

### 5. Registry store

- `<lockDir>/registry.json`, written atomically (temp file plus rename) by the Hub API, with a format version.
- `hub-device` reads it, honours retirement, and falls back to `devices.json` when the file is absent.
- Seeded entries are re-synced from `devices.json` at every start; hand registrations and retirement tombstones are kept.
- Lock names stay as today for the seeded Resources (`adb`, `s24`, `mac-ios`, `emulator-N`). New Resources get `res-<slug>`.
- A Pool request writes a pid-bound ticket in **every** member's `.queue/` and withdraws the others when one serves it, so existing acquirers honour it unchanged.

### 6. Host Agents

- big-chungus's is the Hub API process. It watches the lock dir with `fs.watch` (recursive works in Node 24) and phone presence with `adb track-devices` when the adb server is running; both are events, not polls.
- The Mac's is a separate KeepAlive LaunchAgent in the GUI session (never the catch-up's label: a long-lived job there would make every candybar fire a green `HUB_MAC_BUSY` and silently stop the iPad catch-up). It watches its lock dir with FSEvents, runs devicectl only on request, pushes changes to the Hub API over the tailnet, reconnects only when it has something to send, and restarts or exits lazily when the Mac's `current` moves.
- A third host runs the same agent and is registered.

### 7. Hub API shape

- Node 24 `node:http` with no framework, matching the repo's zero-dependency tools. Always on, as a user service with `KillMode=process` so emulators it started survive its restart (the catch-up unit already needed it). Enabled from `hosts.mjs`, because `install.sh` may only `daemon-reload` (`hub-device.test.mjs:909-941`).
- A `hub-api` lock in the lock dir makes a second instance refuse to start.
- `/health`; `/resources`, `/pools`, `/holds`, `/queues`, `/reservations`; `/events`; `/capacity`; `/stream` (SSE with a keepalive every ≤30s).
- `takeLease` and `takeAnyPhone` move out of `hub-device.mjs` into a library both call.
- ETAs and capacity read cached aggregates, never the whole `events.jsonl` per request.

### 8. Holocene wiring (Candybar pattern)

- **Web side:** `apps/web/app/<id>/` (`page.tsx`, `<id>-app.tsx` inside `<HubShell current="<id>">`, plus `types.ts`, `model.ts` and tests), and a `NAV_GROUPS` "System" entry in `app/hub/navigation-model.ts`.
- **API side:** `apps/api/src/<id>.ts` exporting `register<Id>Routes`, served under `/api/modules/<id>/`. It reads `HUB_API_URL` (default `http://127.0.0.1:<port>`), validates field by field with timeouts and TTL caches, uses narrow POST proxies, and pipes SSE with keepalives.
- **Contract:** a markdown contract in the hub repo with a contract test; Holocene hand-writes its types.
- **Templates:** `app/candybar/*` and `apps/api/src/candybar.ts`.

### 9. Capacity math

v1 ships measured waits always, the replayed range at c+1 always, and the modelled number only above the low-data threshold (20 holds). Savings are also shown as hours of waiting per week: (Wq(c) − Wq(c+1)) × arrivals per week.

- λ is requests per hour from request events, excluding hub-job attempts and internal locks. E[S] and Var[S] come from `held_ms`, and c is the number of Resources in the Pool.
- Only flexible demand (Pool requests) moves to a new Resource. Demand pinned to one Resource (deploys on their target, requests by name) is reported separately; the phone Pool with a pinned S26 is not a pure M/G/c.
- The formulas (Erlang C, the Allen-Cunneen correction, Erlang A) and the small-sample fallback are in "Capacity math, refined" in Section C.
- Treat timeouts and pending deliveries as abandonment, and flag that Erlang C overstates the wait when abandonment is high.

### 10. Rollout order

1. **v1a release:** Event Log, queue-joining `withLock`, Reservations, the Peek, FR-30 pending, FR-31, the frozen ticket format, `updateLease` fix.
2. Pin flip (callers pick it up through `@v1`). The catch-ups switch at the first real deploy on the new pin; `hub-device` at `hosts:install`.
3. **v1b:** Registry, Hub API, Mac Host Agent, then `hosts:install`.
4. **v1c:** Capacity Estimate and the Control Surface.

Fairness is partial until reruns of runs pinned to older hub versions age out (30 days).

### 11. Failure modes

| Failure | Behaviour |
|---|---|
| Mac unreachable | `ios-lane` reads `offline`; Mac-local jobs keep using `mac-ios` on the Mac; big-chungus shows Mac data as stale; Mac history marked partial for the gap. |
| Hub API down | CLI works for local Resources; Registry writes refused; Holds unaffected (they live in the lock dir); the Control Surface is read-only with the last good data. |
| big-chungus reboot | In-flight jobs die with no release; the next acquirer reclaims and records `last_alive_at`; API-held waits are dropped with a re-queue error; Reservations survive until their run's `announce` or ceiling. |
| Clock skew | Each Queue is written on one host's clock (Reservations are written where the lock lives), so FIFO never compares two clocks. Event Log merge across hosts orders by host then `ts`, and flags skew. |
| Two Hub API instances | The `hub-api` lock refuses the second. |

## C. Comparables research (2026-11-21 digest)

### What to adopt, and where it comes from

| Pattern | Source | Where it lands here |
|---|---|---|
| Availability as separate flags (present, ready, leased, claimed), and a separate renewable automation lease | DeviceFarmer STF API, https://github.com/DeviceFarmer/stf/blob/master/doc/API.md | Reachability kept separate from Hold state (FR-5, FR-14) |
| Capabilities as labels matched by expression, plus properties handed to the holder (serial, host, adb endpoint) | Jenkins Lockable Resources, https://plugins.jenkins.io/lockable-resources/ ; Nomad `constraint` and `affinity` | FR-6; exports such as `ANDROID_SERIAL` stay as today |
| FIFO stated outright, never "whoever polls first" | GitLab `resource_group` `oldest_first` (default `unordered`), https://docs.gitlab.com/ci/resource_groups/ | FR-7; today's `withLock` is the "unordered" anti-pattern |
| A lock held across a multi-job span, plus self-deadlock detection | GitLab `strategy: mirror`; Buildkite concurrency gates, https://buildkite.com/docs/pipelines/configure/workflows/controlling-concurrency | FR-9: a Reservation from the gate to the run's last Job Hold, with same-run Job Holds passing through it so a run never waits on itself |
| Retries keep their original place | Buildkite `ordered`; Selenium Grid 4 puts a failed match back at the front, https://www.selenium.dev/documentation/grid/configuration/cli_options/ | FR-9: a rerun reuses its run's live Reservation; once that has ended it queues as a new arrival (v1 keeps no place across a gap) |
| A bounded queue, a wait timeout set apart from CI credential lifetime, and a queue-stats endpoint | BrowserStack queue, https://www.browserstack.com/docs/automate/selenium/queue-tests ; AWS Device Farm `PENDING_CONCURRENCY` | FR-8 (wait shorter than job timeout), FR-14 and FR-21 |
| A TTL with heartbeat at about TTL/3, a jeopardy (grace) state, a lock-delay before reassigning, and a monotonic fencing token | etcd leases, https://etcd.io/docs/v3.5/learning/api/ ; Consul sessions with lock-delay, https://developer.hashicorp.com/consul/docs/automate/session ; Chubby (12 s lease, 45 s grace) | Deferred to v2 remote waiting (PRD §7.2): v1 Leases are process- or expiry-bound with no Heartbeat (FR-10), and the fencing token waits too because every v1 install comes from a local, pid-bound deploy job |
| An owner override ("steal") with an audit trail | Jenkins Reserve, Steal and Reassign | FR-11 force-release |
| Holder, queue and Reservations visible to everyone | The counterexample: STF bookings hidden from other users, https://github.com/openstf/stf/issues/1251 | FR-14 and FR-24 |
| Device health kept separate from lease state | Selenium node heartbeat; Kubernetes device plugins, where unhealthy devices lower allocatable capacity | FR-5 |

### Avoid

- Replace-latest pending. The GitHub Actions concurrency default cancels the older pending run, which starves older work.
- Unordered by default.
- Priority or front-of-queue precedence in v1. It contradicts "no project starved". If ever needed, let only ready waiters bypass, Buildkite `eager` style.
- Holding a slot between retries with no TTL.
- Release-on-process-exit as the only liveness check once remote holders exist (v2); v1 API Leases are expiry-bound for that reason.
- A single-point wait estimate from fewer than about 20 samples.

### Capacity math, refined

- **Erlang C:** with offered load E = λ·h and E < c, Wq = P_w·h/(c − E).
- **Allen-Cunneen:** Wq ≈ ((Ca² + Cs²)/2)·Wq(M/M/c). It is exact for M/G/1 (Pollaczek-Khinchine: Poisson arrivals, Ca² = 1) and an approximation for G/G/c. Grace periods act as server vacations, so the modelled wait understates reality when Reservations are busy.
- **Savings from one more device:** Wq(c) − Wq(c+1) at the same λ, h and Cs².
- **Erlang A** (abandonment rate θ): use it once timeouts are frequent, because Erlang C overstates the wait.
- **Small samples:** for c ≤ 3 and fewer than about 20 holds, report the empirical median wait, or replay the logged arrivals and holds through a small simulation at c and c+1. Report ρ next to the result, and compute per Pool.
- **Sources:**
  - https://en.wikipedia.org/wiki/M/M/c_queue
  - https://en.wikipedia.org/wiki/M/G/k_queue
  - https://aviman.technion.ac.il/files/References/MMNM_IAO.pdf
  - https://arxiv.org/abs/2504.18705

### Flagged uncertain by the research

- GitHub's `queue: max` option.
- Jenkins timeout semantics.
- Firebase Test Lab concurrency.
- How STF's lease cap differs between forks.
- The small-c guidance, which is judgment rather than a sourced rule.
