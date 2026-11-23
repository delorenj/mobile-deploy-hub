---
review: reality-check
spine: ARCHITECTURE-SPINE.md (v1a, draft 2026-11-23)
reviewer: reality lens (verify that mechanisms exist and work as claimed, on both hosts)
date: 2026-11-23
verdict: pass-with-fixes
---

# Reality review: Hub Resource Registry v1a spine

**Verdict: PASS WITH FIXES.** Every named mechanism exists, and most work as the spine claims. I checked each one live on
big-chungus and on the Mac (`ssh hub-mac`, read-only), against GitHub's runner and docs, or against the code at HEAD
`c63c713`. There is no blocker, but there are 1 high and 5 medium gaps:

- **High:** two "exactly once" claims (AD-9 events, AD-7 grace stamp) rest on file operations that more than one process can complete.
- **Medium:**
  - The Stack row is wrong about which Node actually runs the deploy jobs.
  - AD-13 names no mechanism that stops `adb` from auto-starting a server.
  - AD-4 leaves the `emulator` gate queue out of its set.
  - AD-7's ssh backstop does not say what runs on the Mac, and `node` is not on the ssh PATH there.
  - Code before v1a prunes exactly the tickets that AD-3 and AD-8 say it honours.

## 1. Mechanism checks

| Claim (spine) | Status | Evidence |
| --- | --- | --- |
| Node 24 LTS, 24.22.3 current (Stack, memlog) | **Verified, with caveat** | `nodejs.org/dist/index.json`: newest v24 is `v24.22.3`, 2026-11-10, `lts: "Krypton"`. But `v26.13.0` (2026-10-28) turned LTS "Lithium", so 24 is now **Maintenance** LTS. |
| Node 24 is what runs the hub (Stack: `mise node = "24"`) | **Wrong for deploy jobs** | Neither `action.yml:224` (`run: node "$HUB_TOOL"`) nor the workflow pins node, so each job uses the node on the runner's `.path`. Linux: `r1`-`r3` run 26.5.0, `gib1` 26.13.0, and `gruvato1`, `cack1`, `chsc1` and towerofdumb 24.6.0. Mac: all four app runners run `/opt/homebrew/bin/node` 26.7.0. Only the catch-up units (`ExecStart=…/mise/installs/node/24/bin/node`, LaunchAgent ProgramArguments) and `~/.local/bin/hub-device` pin `node/24`, which is 24.15.0 on both hosts. `check.yml` tests on 24 only. |
| Linux `host_id` = `/etc/machine-id` (AD-8) | **Verified** | Present, `0444 root`, 33 bytes (32 hex chars and a newline). Every runner and unit on big-chungus shares it. |
| Mac `host_id` = `IOPlatformUUID` via `ioreg` (AD-8) | **Verified** | `ioreg -rd1 -c IOPlatformExpertDevice` returns `"IOPlatformUUID" = "…-235C7719CED9"`. `/usr/sbin` is on the LaunchAgent PATH and on the runner `.path`. Do not use `sysctl kern.uuid`: it is a different, kernel-build UUID. |
| mDNS hostname drift is real on the Mac (AD-8 premise) | **Verified** | `hostname` = `mommymac.local`, and `scutil --get LocalHostName` = `mommymac` (no HostName set), so the name is mDNS-derived. |
| One `O_APPEND` write of a line under 4 KiB is atomic on the local fs (AD-9) | **Verified empirically; the reason needs fixing** | 12 processes × 400 lines × ~4 KiB, alternating `appendFileSync` and `openSync('a')`+`writeSync`: 4800/4800 lines, 0 torn. Ran on ext4 `/` with Node 24.6.0, on APFS with Node 24.15.0, and on APFS with Node 26.7.0. `PIPE_BUF` is 4096 on Linux and **512** on the Mac, and it governs pipes, not regular files. What makes the write atomic is `O_APPEND` (an atomic seek-and-write per POSIX) plus one `write()` on a local fs (the kernel serializes writes per inode). The 4 KiB cap is a budget, not a correctness bound. |
| `Runner.Worker` ancestor is discoverable; its start ≈ GitHub's job clock (AD-12) | **Verified on both hosts** | **Linux, live:** `Runner.Worker` (pid 686023, `/proc/<pid>/comm` = `Runner.Worker`, runner 2.338.2) → `bash -e …/_temp/<id>.sh` → `uv` → `pytest`. Its start was 17:27:59Z; GitHub's `started_at` for that job (`AutomaticAI-io/milkshake` run 45227957876, job `check`) was 17:27:59Z. **Mac:** one Worker per job. `gruvato/_diag/Worker_20261123-125114-utc.log` (12:51:14Z) matches GitHub `started_at` 12:51:14Z for `deploy / ios` (delorenj/gruvato run 45178125468). I did not watch a live Mac process tree; that part rests on the runner being the same code (2.338.x). |
| `GITHUB_RUN_ID`/`GITHUB_REPOSITORY`/`GITHUB_JOB` inside the `workflow_call` reusable workflow (AD-7, AD-12, ids) | **Verified** | The Mac job message for `deploy / ios` carries `system.github.job` = `ios` (the **called** workflow's job id, not the caller's `deploy`), `github.repository` = `delorenj/gruvato`, `run_id` = `45178125468` and `run_attempt` = `1`. `gh api` shows run 45178125468 is the caller's `.github/workflows/deploy.yml` (workflow_dispatch). Docs: "the `github` context is always associated with the caller workflow"; actions/runner#2577 confirms `GITHUB_JOB` is the called job's id. `templates/deploy.yml` calls the hub once per run and the gate refuses any other caller, so `<repo>#<run>.<attempt>/<job>` is unique. |
| GitHub `timeout-minutes` behaviour (AD-12 premise) | **Verified, worth writing into AD-12** | A job killed at `timeout-minutes` concludes **`cancelled`**, not `failure`. Evidence: public repro `j4keh/gha-timeout-cancelled-repro`, run 40462944329: `slow` is `cancelled`, `!cancelled()` dependents run, and `failure()` and no-`if` dependents are skipped. The hub's `deliver-android` and `deliver-ios` gate on `success \|\| failure` (`mobile-deploy.yml:425,469`), so a GitHub-killed lane publishes nothing. That settles the brownfield's "unverified" note (pending §risk 99) and is the strongest argument for AD-12. The kill also lags: the 1-minute job ran 89 s. Cancellation sends SIGINT to the step's **entry process**, which for a `run:` step is the shell, then SIGTERM after 7.5 s, then kills the tree after 2.5 s more. `node` under `bash -e` never sees SIGINT, so a `finally` (Reservation release, events) **does not run on a GitHub kill**. Only the AD-7 ceiling and AD-19 reclaim cover it. |
| adb server reuse "without start-server" (AD-13) | **Mechanism unspecified; a working one exists** | `createAdb` runs plain `adb -s <id> …` (`adb.mjs:76-90`). With no server on the port, any adb client call auto-starts one, keeping the job's `RUNNER_TRACKING_ID` (`adb.mjs:76-78`). Tested here (adb 1.0.41, platform-tools 37.0.0): `adb -L tcp:127.0.0.1:5199 devices` prints `cannot start server on remote host`, exits 1 and leaves no listener. `adb -L tcp:127.0.0.1:5037 devices` lists devices from the live server. |
| Machine-id / UUID read cost "cached per process" (AD-8) | **Plausible** | One file read on Linux, one `ioreg` spawn on the Mac. Not timed. |

## 2. Code-claim spot checks (HEAD `c63c713`)

| Spine citation | Status | Note |
| --- | --- | --- |
| `catchup.mjs:469` `/host lock adb is held/`, `:591` `/host lock mac-ios is held/` (AD-5) | ✓ lines and regexes exact | The *rationale* is wrong; see F9. |
| `android.mjs:126` newer-device refusal (AD-13) | ✓ | `throw … above the planned … (the hub never downgrades)`, inside `withLock('adb')` at `:112-156`. |
| `ios.mjs:276` `mac-ios` wraps build, export and install (Open Q1) | ✓ | `hook('ios.device')` at :286, `exportIpa` at :291, `inspectIpa` at :294 and the outbox at :301 all run inside the lock. The second take at `:390` happens only when `config.testflight && spec.store.build` (:385-388). |
| `latest.json` status enum frozen (AD-14) | ✓ | `latest.mjs:18` gives `installed, pending, skipped, failed`. `:113` has exact keys (plus `event_pending`), and `:119` caps `reason` at 300 characters. |
| `listLocks` filters to `*.lock` (AD-2) | ✓ | `lock.mjs:305`. The other lock-dir readers also ignore `events/` and `<name>.reservations/`: `listWaiters` `.json` filter (`lock.mjs:152`), `emulator.mjs:320` `/^emulator-\d+\.lock$/`, and `inventory.mjs:40` (`managed.json` only). |
| Ticket name `<ms15>-<counter6>-<pid8>.json` (AD-3) | ✓ | `lock.mjs:201`. Readers sort names lexicographically (`:152`) and never age a parsed ticket by its name, so a backdated Reservation ticket (AD-6) is honoured from v1.2.26 on. `git tag --contains 5eb2487` gives v1.2.26 as the first release. |
| `withLock` timeout has no `.code` (AD-5 premise) | ✓ | `lock.mjs:94`. `acquireLease` has two messages, at `:247` (`is held by`) and `:251` (`has N waiter(s) ahead`). |
| Job timeouts 20 / 45 / 120 min; gate and plan on Linux, preflight-ios and ios on Mac | ✓ | `mobile-deploy.yml:108/196/258/377`, `:162/376`. |
| `HUB_REF` from the action (AD-10) | ✓ mechanism / ✗ wording | `action.yml:209` sets `HUB_REF: ${{ github.action_ref }}` through `env`, which is the form the docs require for composite actions. `gate.mjs:59` refuses a real run whose `HUB_REF` is not `vX.Y.Z`, so it works in production. It is the workflow's **inner** pin (`actions/hub@v1.2.43`, `mobile-deploy.yml:130` …), not "the caller's `@vX.Y.Z`": the caller pins `@v1` (`templates/deploy.yml`). |
| Release dir name in the module path (AD-10 step 2) | ✓ | Node's default realpath turns a script run through a symlinked `current/` into `releases/vX.Y.Z/…` in `import.meta.url` (tested). `~/.local/bin/hub-device` execs `releases/v1.2.43/tools/device/hub-device.mjs` directly. |
| `deliver.mjs:44-45` keeps a success receipt's `pending` (AD-14) | ✓ | `pages.mjs:35` renders it as "pending, installs when it is back (…)"; see F13. |
| `takeAnyPhone` passes are `waitMs: 0` (AD-6) | ✓ | `hub-device.mjs:214`. Emulator slots are also `waitMs: 0` (`emulator.mjs:504`), so they become tries under AD-6. |

## 3. Findings (most severe first)

### F1 (high): AD-9 "exactly once" and AD-7 "grace stamped once" rest on non-exclusive operations

- **Reclaim and release.** Both use `rmSync(path, {recursive, force})` (`lock.mjs:61`, `:103`), after a readOwner compare in reclaim (`:59-60`). Two reclaimers that read the same stale owner before either removes it both return `true`, because `force` swallows ENOENT. Both would emit `reclaim`. (Today both already log `HUB_LOCK_RECLAIMED`.) There is also an older TOCTOU: a reclaimer that compared before another process removed and re-made the lock can `rm` the new holder's lock.
- **Grace.** Stamping `grace_started_at` into the Reservation file is a read-modify-write plus tmp/rename:
  - two Claimants can both stamp, and both emit;
  - a stamp that renames over the path after `android`'s `finally` unlinked the Reservation **brings it back**, stamped "now", and it holds the free S26 for the grace period.
- **Fix.**
  - Add "rename-to-tomb" to AD-9's atomic steps: reclaim and release `renameSync('<name>.lock', '<name>.tomb-<pid>-<rand>')`, then rm. Only the process whose rename succeeded emits, and the event describes the tomb's owner. The tomb name must not end in `.lock`, so `lock.mjs:305` and `emulator.mjs:320` ignore it.
  - Stamp grace with an exclusive `wx` create of `<reservation>.grace`, holding `{grace_started_at}`. Only the creator emits. Release unlinks both files. A marker with no Reservation is ignored.

### F2 (medium): the Stack row does not match the Node that runs deploy jobs

- See the table in §1. All iOS and preflight-ios jobs run on Node 26.7.0, and two of the four apps' Linux lanes run on 26.5.0 or 26.13.0. The lock protocol will execute under 24.6 to 26.13 at once, but CI tests only 24.
- **Fix.** Pin the runtime in `actions/hub/action.yml`: run `"$HOME/.local/share/mise/installs/node/24/bin/node" "$HUB_TOOL" …`. This is the same path the catch-up units and the hub-device wrapper already use; it exists on both hosts (24.15.0), and the gate should refuse when it is missing.
- If pinning is rejected, change the Stack row to "≥ 24 (runner PATH), tested on 24" and add Node 26 to `check.yml`.
- Either way, note that 24 is now Maintenance LTS and 26 is Active LTS.

### F3 (medium): AD-13's Peek has no mechanism that prevents adb from starting a server

- "Never runs `start-server`" is not enough, because every adb client command auto-starts a server.
- The existing status guard is check-then-query (`hub-device.mjs:459-465`: an inventory of listening servers, then a query with `ANDROID_ADB_SERVER_PORT`), which leaves a window.
- **Fix.** Write the form into AD-13: `adb -L tcp:127.0.0.1:<adb_port> -s <adb_id|serial> shell dumpsys package <pkg>`.
  - Tested: it refuses to launch a server ("cannot start server on remote host") and reads from a live one.
  - A connect failure means `installed = unknown`.
  - Use the literal `127.0.0.1`. adb may count `localhost` as local and auto-start; that is untested.
  - Blanking `RUNNER_TRACKING_ID` then becomes a second safeguard rather than the mechanism.

### F4 (medium): AD-4's `QUEUED` set omits the `emulator` gate, the one emulator lock that actually queues

- Emulator requests wait FIFO on `GATE = 'emulator'` through `acquireLease` with `waitMs > 0` (`emulator.mjs:29`, `:486`). The slots `emulator-<n>` are `waitMs: 0` tries (`:504`).
- As written:
  - emulator waits produce no `request`/`timeout` events and no ETA (AD-9 covers only QUEUED);
  - "every other name keeps today's bare path" is false for `emulator`, which is already a lease queue;
  - `emulator.mjs:329-332` reads the gate's tickets by hand, against AD-1.
- **Fix.** `QUEUED = adb, s24, mac-ios, emulator` (the gate), plus `emulator-<n>` for acquire and release only. Move `emulator.mjs:329-332` onto `listWaiters`.

### F5 (medium): AD-7's ssh backstop to the Mac is unspecified, and `node` is not on the ssh PATH there

- `ssh hub-mac` runs with `PATH=…/.rokit/bin:…/.cargo/bin:/usr/bin:/bin:/usr/sbin:/sbin`, and `command -v node` finds nothing.
- The Mac's `current` is `releases/v1.2.43`. During roll-out it can be a pre-v1a release that does not know Reservations.
- To keep AD-1 (only `lock.mjs` mutates) and AD-9 (the lock's host writes the event), the remote side must run the Mac's `lock.mjs`.
- **Fix.** Name the command: `ssh hub-mac ~/.local/share/mise/installs/node/24/bin/node ~/.local/share/mobile-deploy-hub/releases/$HUB_REF/tools/<release-reservation entry> <run_key>`.
  - Fall back to `current` only if it exports the Reservation API, using the same source-sniff as `leaseSupport`.
  - Otherwise leave the Reservation to the ceiling.
  - Never `rm` over ssh.

### F6 (medium): code before v1a prunes the tickets that AD-3 and AD-8 say it honours

- `staleWaiter` (`lock.mjs:139-146`, in every pin since v1.2.26) treats as stale, and `acquireLease` prunes on every poll (`:213`), any ticket that:
  - has no integer `pid`;
  - has no `process_start`;
  - has a `host` other than `hostname()`.
- So:
  - (a) AD-3's v2 `kind: remote` tickets (no pid) will be deleted by any pre-v1a `acquireLease` still running: pinned reruns for 30 days, or a hub-device that was never reinstalled.
  - (b) AD-8's "older versions fall back to their conservative rule" holds for owners (`stale()` `:47-54`), but **not for tickets**. A ticket from a foreign or drifted host is pruned at once.
  - (b) is latent today: on the Mac, no code before v1a calls `acquireLease` (Mac takers use `withLock`), and big-chungus's hostname does not drift.
- **Fix.**
  - AD-3 "Prevents": "for v1a+ readers. v2 may write `remote` only after no pre-v1a `acquireLease` can run (pins older than 30 days, and hosts:install done)". Record this under Deferred/v2.
  - AD-8: correct the fallback sentence for tickets.

### F7 (low): AD-10 creates a second resolver while claiming "one source"

- `receipt.mjs:19-22` `hubRef()` already resolves `HUB_REF`, then the `_actions/<o>/<r>/<ref>/` path. AD-10 adds `hubVersion()` in `events.mjs`, and AD-1's layer table forbids `events.mjs` from importing `receipt.mjs`.
- **Fix.** Make one leaf module (for example `tools/ci/lib/hub-version.mjs`, `node:` builtins only). It reads `HUB_REF`, then `releases/(vX.Y.Z)/tools/`, then `_actions/…/<ref>/tools/`, then `unknown`. Both `receipt.mjs` and `events.mjs` import it.
- Reword step 1 to "the workflow's inner `actions/hub@vX.Y.Z` pin". It is not the caller's ref, which is `@v1`.

### F8 (low): AD-12's start time needs a new helper; the "conformance test" lives in the wrong place

- `processStart()` returns an identity token, not a time. On Linux it is field 22, clock ticks since boot (`lock.mjs:131`); on the Mac it is `ps:<lstart>`.
- **Fix.** Add a `processStartedAt(pid)` seam:
  - Linux: `btime` from `/proc/stat` plus ticks / `CLK_TCK` (100 here), and ppid from field 4;
  - Mac: one `ps -axo pid=,ppid=,lstart=,comm=` with `LC_ALL=C TZ=UTC`, then `Date.parse(lstart + ' UTC')`.
  - Match the basename `Runner.Worker`, because Mac `comm=` is a full path.
- "Conformance test" here means `tools/conformance.mjs`, the gh-api caller checks. Put the `timeout-minutes == HUB_JOB_TIMEOUT_MINUTES` assertion in a `tools/ci/*.test.mjs` run by `mise run check`; `hub.test.mjs` and `v11.test.mjs` already parse the workflow.
- Add to AD-12 that a GitHub kill concludes `cancelled`, which skips deliver, and that `finally` does not run.

### F9 (low): AD-5's rationale names a cross-version path that does not exist

- `catchup.mjs:43` imports `../ci/lib/lock.mjs` from its own release, and the units run `current/tools/catchup/catchup.mjs`. A catch-up only ever parses messages from its own `withLock`.
- Keeping the `host lock <name> is held` prefix is still right, for:
  - the pinned tests (`lease.test.mjs:107`, `hub-device.test.mjs:119/225/292`);
  - the `emulator.mjs:312/342` regexes;
  - the human-facing `HUB_DEVICE_BUSY` line.
- **Fix.** Change the "Prevents" line to cite those, and require the v1a catch-up to branch on `.code`.

### F10 (low): AD-19 touches the wrong mtime for older readers

- `stale()` ages the lock **directory** (`statSync('<name>.lock')`, `lock.mjs:44`). Touching `owner.json` does not change it.
- **Fix.** `utimesSync` both the lock dir and `owner.json`. The pre-v1a 4 h age rule (`:54`) then sees a live holder as fresh, which matters for the Mac's drift case. Take `last_alive_at` from the newer of the two.

### F11 (low): AD-9 writer and reader details

- Specify one `openSync(file, 'a')` plus a single `writeSync`, and check that the byte count equals the length; otherwise log `HUB_EVENT_LOG_FAILED`. `appendFileSync` loops on a short write, which would split the line.
- Create `events/` with `mkdirSync(…, {recursive: true})`.
- Readers (`eta.mjs`, v1b) skip an unparsable line, such as a torn tail after ENOSPC or a crash.
- Drop any `PIPE_BUF` reasoning (it is 512 on the Mac).

### F12 (low): AD-13 cites the wrong guard for contention-pending builds

- A contention-pending build (AD-14) is installed by the catch-up. There, a newer S26 is `ahead`, which leads to status `skipped` with `event: false` (`catchup.mjs:148`, `:377`, `:656`). That is a silent skip, not the `android.mjs:126` refusal.
- **Fix.** Cite both paths, and state that the pending path skips silently in v1a (or emit an event).

### F13 (low): the page wording for a busy S26

- `pages.mjs:35` would print "pending, installs when it is back (S26 busy …)".
- **Fix.** Either accept that wording in AD-14 or make the suffix depend on the reason.

### F14 (low): drift between the spine and the memlog

- The memlog gives the Reservation file as `<repo-slug>--<run_id>.json`; the spine gives `<owner>--<repo>--<run_id>.json`.
- The memlog's seams include `fetchImpl`; the spine's do not.
- **Fix.** Align the memlog to the spine.

## 4. What I ran

All of this was read-only, apart from temp dirs I created and then removed.

- **Node versions:** `curl nodejs.org/dist/index.json`; the `.path` of each runner on both hosts, resolved with `command -v node`; the catch-up unit and LaunchAgent; the `~/.local/bin/hub-device` wrapper.
- **Host identity:** `ioreg`, `scutil` and `hostname` on the Mac; `/etc/machine-id`, `findmnt`, `getconf PIPE_BUF` and `getconf CLK_TCK` on Linux. The PIPE_BUF value came from both hosts.
- **Append test:** a concurrent `O_APPEND` probe on ext4 (Node 24.6) and APFS (Node 24.15 and 26.7).
- **Runner timing:** the live `Runner.Worker` tree and the environment of its step shell, compared with `gh api …/jobs` `started_at`. On the Mac, Worker `_diag` log timestamps and job messages compared with `gh api`.
- **GitHub sources:** docs pages on contexts, reusable workflows and workflow cancellation; actions/runner#2577; community discussion #37414; the jobs of the public repro `j4keh/gha-timeout-cancelled-repro`.
- **adb:** `-L tcp:127.0.0.1:<port>` against a free port (5199) and against the live 5037 server.
- **Code:** read at every line the spine cites.

Sources: https://nodejs.org/dist/index.json ·
https://docs.github.com/en/actions/reference/workflows-and-actions/reusing-workflow-configurations ·
https://docs.github.com/en/actions/reference/workflows-and-actions/contexts ·
https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-cancellation ·
https://github.com/actions/runner/issues/2577 · https://github.com/orgs/community/discussions/37414 ·
https://github.com/j4keh/gha-timeout-cancelled-repro
