# Addendum: Hub Resource Registry

This is the mechanism and evidence behind `prd.md`, kept here so the PRD stays about capabilities. It is input for `bmad-architecture`, not a decision of record.

## A. Where today's behaviour comes from

All references are against 4cdefdc plus the hermetic-tests fix.

### Lock model

- **Implementation:** `tools/ci/lib/lock.mjs`. A lock is an atomic `mkdir <lockDir>/<name>.lock` holding `owner.json`. The lock dir is `$HUB_LOCK_DIR` or `~/.cache/mobile-deploy-hub/locks`.
- **Lease record:** `kind:'lease'`, `lease_id`, `holder`, `why`, `expires_at`, `holder_pid` and `holder_process_start` (`:217-221`). The maximum is 48h (`MAX_LEASE_MS`, `:109`).
- **Lease queue:** first-in-first-out tickets in `<name>.queue/<ms>-<counter>-<pid>.json`, polled every 1s (`acquireLease`, `:178-260`).
- **Deploy job locks:** `withLock` (`:65-97`) retries `mkdir` every 2s and never reads or writes the queue. This is the starvation mechanism. The plan and android jobs wait up to 20 minutes (`plan.mjs:234`, `android.mjs:142`). The plan job's own timeout is also 20 minutes (`mobile-deploy.yml:196`), so GitHub kills the job before the lock's error can print.

### The `adb` gap

- The plan job holds `adb` for its S26 check (`plan.mjs:230-234`) and then releases it.
- The build runs.
- The android job takes `adb` again (`android.mjs:98`).
- In between, a lease, another deploy, or the catch-up (a 5s window polling every 100ms, `catchup.mjs:467`) can take the lock.

### The `phone` word

- Each pass is `acquireLease` with `waitMs:0` (`hub-device.mjs:214`), so a `phone` request holds no place in line.

### `mac-ios`

- It is a `withLock` with a 40-minute limit, taken twice per run (`ios.mjs:276/344, 390`), plus the Mac catch-up every 300s.
- It lives on the Mac's disk, so big-chungus cannot see it.

### Host-bound staleness

- An owner whose `host` is not this host is treated as stale, and so is a ticket from another host (`lock.mjs:49,53,142,157-158`).
- So the Hub API must run on big-chungus as the runner user, with the same lock dir. The Mac's locks need the Mac's Host Agent.

### History

- None is kept. Release deletes the record (`lock.mjs:61,103`), tickets are unlinked (`:233,257`), and emulator records are removed (`emulator.mjs:263`).

### Declarations

- `tools/ci/devices.json` has a fixed shape: one `android`, `android_extra[]`, one `ios`, `mac` and `linux` (`devices.mjs:11-40`).
- The `adb` lock name is the S26, and deploys hard-code it:
  - `plan.mjs:230-232`
  - `android.mjs:94-102`
  - `gate.mjs:138-140`
  - `catchup.mjs:456-460`

## B. Suggested mechanism (for architecture to confirm)

### 1. Event Log first

- An append-only `<lockDir>/events.jsonl`. Each record:

  ```
  {ts, host, resource, event, kind: job|lease|reservation, id, repo, run, job, holder, enqueued_at, started_at, waited_ms, held_ms, position, reason, expires_at}
  ```

- Emit each event once:
  - **`withLock`:** a request before its loop (`:79`), then acquire (`:98`), timeout (`:94`), and release or lost in its `finally` (`:102-103`).
  - **`acquireLease`:** a request after the ticket rename (`:206`), then acquire (`:239`) and timeout (`:247,251`). Cancel or abort goes into its `finally` (`:257`).
  - **`reclaim()`:** given a reason argument (`:58-63`).
  - **The rest:** `releaseLease` (`:272`), `listWaiters` prune (`:158,165`), `updateLease` extend (`emulator.mjs:595`), and emulator reap failure as a capacity-loss event (`:305`).
- Ship this in a hub release before anything else, so history starts building up.

### 2. Deploy jobs join the queue

- `withLock` writes a ticket in the existing pid-bound format with `kind:'job'`, `repo`, `run` and `job`, and takes the lock only at the head of the queue.
- `acquireLease` from v1.2.26 on already honours such tickets.

### 3. Reservations

- `<name>.reservations/<enqueued_at>-<run>.json` holding `{run, repo, expires_at}`.
- The plan job writes it and the android or iOS job adopts it. It lives in a separate directory because `staleWaiter` deletes tickets that have no live pid.
- The serving rule merges tickets and reservations by `enqueued_at`. A reservation at the head that has not been claimed holds the lock for up to the grace period. After that the next ticket is served, and the reservation keeps the head: it is never re-sorted behind later arrivals (PRD FR-9).
- The plan job takes its reservation inside today's `withLock('adb', …)` block (`plan.mjs:230`), which runs before `bumpTransaction` (`plan.mjs:254`). So "reserve before the bump" needs no reordering of the plan job.
- An unclaimed reservation also carries a ceiling (`expires_at` = taken + 3 h), so a run whose install job never starts cannot hold the head forever.

### 4. Heartbeat for remote Claimants

- A short `expires_at`, renewed through `updateLease` on each heartbeat, instead of `holder_pid`.
- The Hub API process owns the pid-bound ticket and the remote Claimant owns the heartbeat. On restart, the Hub API re-adopts its tickets from the store.

### 5. Registry store

- `<lockDir>/registry.json`, written atomically (temp file plus rename) by the Hub API.
- `hub-device` reads it, and falls back to `devices.json` when the file is absent.
- Lock names stay as today for the seeded Resources (`adb`, `s24`, `emulator-N`). New Resources get `res-<slug>`.

### 6. Host Agent (the Mac's first)

- A Host Agent owns one host's lock dir and reports that host's devices. big-chungus's is the Hub API process itself; the Mac's serves `mac-ios` and an `ipad` lock on the Mac's disk.
- A third host is the same agent plus a Registry entry for it. No lock spans hosts, which keeps `lock.mjs`'s host-bound staleness rule intact.
- Option (a): the Hub API reaches it over `ssh hub-mac` using the same retried-connection classification as `tools/ci/lib/handoff.mjs`.
- Option (b): a long-lived Mac process behind a tailnet port.
- Either way, it adds no clock.

### 7. Hub API shape

- Node 24 `node:http` with no framework, matching the repo's zero-dependency tools.
- `/health`; `/resources`, `/pools`, `/holds`, `/queues`, `/reservations`; `/events`; `/capacity`; `/stream` (SSE with a ping every ≤30s).
- It runs as a user service on big-chungus, started on demand or always on. That is a service, not a clock.

### 8. Holocene wiring (Candybar pattern)

- **Web side:** `apps/web/app/<id>/` (`page.tsx`, `<id>-app.tsx` inside `<HubShell current="<id>">`, plus `types.ts`, `model.ts` and tests), and a `NAV_GROUPS` "System" entry in `app/hub/navigation-model.ts`.
- **API side:** `apps/api/src/<id>.ts` exporting `register<Id>Routes`, served under `/api/modules/<id>/`. It reads `HUB_API_URL` (default `http://127.0.0.1:<port>`), validates field by field with timeouts and TTL caches, uses narrow POST proxies, and pipes SSE with pings.
- **Contract:** a markdown contract in the hub repo; Holocene hand-writes its types.
- **Templates:** `app/candybar/*` and `apps/api/src/candybar.ts:924-1126`.

### 9. Capacity math

v1 ships measured waits always, the replayed range at c+1 always, and the modelled number only with 30 or more holds in the window (PRD FR-19). Savings are also shown as hours of waiting per week: (Wq(c) − Wq(c+1)) × arrivals per week.

- λ is requests per hour from request events. E[S] and Var[S] come from `held_ms`, and c is the number of Resources in the Pool.
- Erlang C gives P(wait) and Wq for M/M/c.
- The Allen-Cunneen approximation for M/G/c is Wq ≈ Wq(M/M/c) · (Ca² + Cs²)/2, where Cs² = Var[S]/E[S]² and Ca² comes from the inter-arrival times.
- Report Wq at c and at c+1.
- Treat timeouts as abandonment, and flag that M/M/c overstates the wait when abandonment is high (the Erlang A note).
- For small c (1-3) and small samples, show a bootstrap range over the observed holds rather than a point estimate.

### 10. Rollout order

1. Event Log release.
2. Pin flip, so callers are on a version with queue-joining `withLock`.
3. `hosts:install`, which puts the new `hub-device` and the Hub API on big-chungus.
4. Mac Host Agent.
5. Holocene page.

The PRD groups these as v1a (step 1 plus the queue-joining `withLock` and reservations), v1b (registry, Hub API, Mac Host Agent) and v1c (capacity and the Holocene page).

Fairness is partial until reruns of runs pinned to older hub versions age out.

## C. Comparables research (2026-11-21 digest)

### What to adopt, and where it comes from

| Pattern | Source | Where it lands here |
|---|---|---|
| Availability as separate flags (present, ready, leased, claimed), and a separate renewable automation lease | DeviceFarmer STF API, https://github.com/DeviceFarmer/stf/blob/master/doc/API.md | Reachability kept separate from Hold state (FR-5, FR-14) |
| Capabilities as labels matched by expression, plus properties handed to the holder (serial, host, adb endpoint) | Jenkins Lockable Resources, https://plugins.jenkins.io/lockable-resources/ ; Nomad `constraint` and `affinity` | FR-6; exports such as `ANDROID_SERIAL` stay as today |
| FIFO stated outright, never "whoever polls first" | GitLab `resource_group` `oldest_first` (default `unordered`), https://docs.gitlab.com/ci/resource_groups/ | FR-7; today's `withLock` is the "unordered" anti-pattern |
| A lock held across a multi-job span, plus self-deadlock detection | GitLab `strategy: mirror`; Buildkite concurrency gates, https://buildkite.com/docs/pipelines/configure/workflows/controlling-concurrency | FR-9: Reservation from plan to install, and refusal when a run would wait on itself |
| Retries keep their original place | Buildkite `ordered`; Selenium Grid 4 puts a failed match back at the front, https://www.selenium.dev/documentation/grid/configuration/cli_options/ | FR-9: a rerun keeps its original place |
| A bounded queue, a wait timeout set apart from CI credential lifetime, and a queue-stats endpoint | BrowserStack queue, https://www.browserstack.com/docs/automate/selenium/queue-tests ; AWS Device Farm `PENDING_CONCURRENCY` | FR-8 (wait shorter than job timeout), FR-14 and FR-21 |
| A TTL with heartbeat at about TTL/3, a jeopardy (grace) state, a lock-delay before reassigning, and a monotonic fencing token | etcd leases, https://etcd.io/docs/v3.5/learning/api/ ; Consul sessions with lock-delay, https://developer.hashicorp.com/consul/docs/automate/session ; Chubby (12 s lease, 45 s grace) | FR-10 (jeopardy, quarantine); the fencing token is deferred past v1 (PRD §7.2) because every v1 install comes from a local, pid-bound deploy job |
| An owner override ("steal") with an audit trail | Jenkins Reserve, Steal and Reassign | FR-11 force-release |
| Holder, queue and Reservations visible to everyone | The counterexample: STF bookings hidden from other users, https://github.com/openstf/stf/issues/1251 | FR-14 and FR-24 |
| Device health kept separate from lease state | Selenium node heartbeat; Kubernetes device plugins, where unhealthy devices lower allocatable capacity | FR-5 |

### Avoid

- Replace-latest pending. The GitHub Actions concurrency default cancels the older pending run, which starves older work.
- Unordered by default.
- Priority or front-of-queue precedence in v1. It contradicts "no project starved". If ever needed, let only ready waiters bypass, Buildkite `eager` style.
- Holding a slot between retries with no TTL.
- Release-on-process-exit as the only liveness check, because remote holders have no local process.
- A single-point wait estimate from fewer than about 20 samples.

### Capacity math, refined

- **Erlang C:** with offered load E = λ·h and E < c, Wq = P_w·h/(c − E).
- **Allen-Cunneen:** Wq ≈ ((Ca² + Cs²)/2)·Wq(M/M/c). It is exact for c = 1 (Pollaczek-Khinchine).
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
