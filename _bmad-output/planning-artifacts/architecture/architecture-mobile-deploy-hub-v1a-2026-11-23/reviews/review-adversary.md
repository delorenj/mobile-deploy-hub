---
review: adversary
target: ARCHITECTURE-SPINE.md (Hub Resource Registry v1a, draft 2026-11-23)
method: for each pair of units one level down, build both so they obey every AD as written, then look for where they still clash. Every lock-dir race below is grounded in tools/ci/lib/lock.mjs at HEAD (c63c713, which matches v1.2.43 for every line cited).
scope: v1a only (PRD §7.1)
date: 2026-11-23
---

# Adversarial review: v1a spine

## Verdict

**Not ready to freeze.** The paradigm is right: one library, with the on-disk layout as the contract between versions. But the ADs leave four things open that two epics will fill in differently, and every AD would still pass:

1. **Who may mutate a Reservation, and how.** Today it is a rewrite-in-place file. A grace stamp can bring it back after release, on the hot path.
2. **Which removals count as the atomic step.** Today's `rmSync({recursive, force})` has no single winner, so AD-9's "exactly once" cannot be built on it.
3. **What "live" means compared with "blocking".** AD-6 tries, AD-16 refusals and positions all diverge on post-grace Reservations.
4. **The frozen ticket format's liveness, key names and encodings.** AD-3 as written can create immortal tickets, and it drops `lease_id`.

Six findings are critical or high. Each fix below tightens an existing AD. None needs a new mechanism outside `lock.mjs`.

## Findings at a glance

| # | Sev | Pair that clashes | AD | Fix in one line |
| --- | --- | --- | --- | --- |
| 1 | critical | grace-stamping waiter vs `android` finally (release) | AD-7, AD-2 | Reservation becomes an immutable per-incarnation directory. Grace is a `wx` file and release is a rename to a tombstone. Release the Reservation **before** the Hold. |
| 2 | high | old `hub-device` waiter (kill -9) vs every v1a reader; AD-3 body vs AD-2 keys | AD-3 | A ticket with no `kind` is a legacy lease. The pid rule applies to every ticket that carries pid+process_start. Writers must set `expires_at`. Keep `lease_id`, and freeze types and the `process_start` encoding. |
| 3 | high | two reclaimers / canceller vs timing-out waiter / `status` vs `reap()` | AD-9 | Add a transition table (event ↔ syscall ↔ emitter). Removals that emit an event are `unlinkSync`/`renameSync` only, never `force`. Reclaim and release go by rename-to-tombstone. Only `lock.mjs` appends. |
| 4 | high | `takeAnyPhone` try vs a post-grace Reservation; status position vs a passthrough ticket; old snapshot vs backdated ticket | AD-6, AD-7, AD-16, AD-17 | Export one `queueView()` that separates **place** (all live entries, a Reservation deduped against its own ticket) from **blocking**. Tries, mkdir eligibility, refusals and positions all use `blocking`. Re-check after mkdir. |
| 5 | high | `hub-device` (hosts:install release) vs catch-up (`current`) vs pinned job, each reading its own `policy.json` | AD-11 | Records carry absolute times (`grace_ends_at`, `expires_at`) computed by the writer. Readers never apply their own policy to an existing record. |
| 6 | high | `android` finally / `announce` `if: always()` vs `gh run rerun --failed`; gate vs an iOS-only run | AD-7, AD-16 | Release only when no later job of the run takes the Resource. On failure, leave the Reservation to grace+ceiling. The gate reserves `adb` only when `scope.android`, and plan becomes a releaser. |
| 7 | medium | ios hold 1 vs ios hold 2; plan/adb vs android/adb | AD-12 | `hold_allowance` is keyed by `job/lock`. The deadline subtracts the allowances of all remaining Holds in the job. |
| 8 | medium | `extendLease` vs at-expiry reclaimer vs the next holder; `extendLease` vs `updateLease`; `extendLease` vs new waiter | AD-16 | Never rewrite owner.json within `queue.owner_write_lead_s` of `expires_at`. Extend is write-then-recheck-then-roll-back (Dekker order). `updateLease` keeps its boolean contract. |
| 9 | medium | AD-4 `QUEUED` constant vs emulator gate queue; vs devices.json extras | AD-4, AD-16 | Add `emulator` (the pool gate) to the Queued set. Gate waiters count as waiters on every `emulator-<n>`. Match with `^emulator-\d+$` and add a fleet ⊆ QUEUED test. |
| 10 | medium | gate `quickS26` vs a Lease; Peek via the adb binary | AD-13 | AD-13 binds every lockless S26 read (gate and plan). Reads go only through `adb-wire.mjs` `shell()` on the recorded port, and the gate never sends a connect/mDNS nudge while `adb` is held. |
| 11 | medium | AD-17 "ETA moved > 1 min" vs AD-18 "compute only at enqueue/position change" | AD-17, AD-18 | Split it into `etaModel(events)` (expensive, at enqueue or on a position change) and `eta(model, snapshot, now)` (cheap, every poll). |
| 12 | medium | `hub-device release <id>` vs a deploy job's ticket; ios hold 1 vs hold 2 event pairing | AD-3, AD-9, conventions | Only `lease` and legacy tickets can be cancelled by id. A Hold's identity is `<lock>/<ticket stem>`, not the job id. |
| 13 | medium | `announce` (pin N, Linux) vs the code that runs on the Mac (`current`, maybe older than v1a) | AD-1, AD-7 | Name a frozen Mac entrypoint, or ship the pinned module over ssh stdin. Release by `run_key` read from the record. |
| 14 | low | AD-10 resolver vs `hub-device` launched from a job hook | AD-10 | Check the module path before `HUB_REF`. |
| 15 | low | AD-16 cap vs `lease phone` | AD-16 | Leave `s26` out of a `phone` pass whose `--for` is above the cap. Never exit 2 for `phone`. |
| 16 | low | passthrough vs a hook's `hub-device lease s26` inside the same run | AD-7 | Passthrough applies only to `kind: job`. |
| 17 | low | AD-1 vs `emulator.mjs` (`emulators/`, `emulator-pool`, hand-parsed gate tickets) | AD-1 | Name the exemption, and move `isEmulatorLease` onto `listWaiters`. |
| 18 | low | AD-19 heartbeat vs `spawnSync` bodies (adb install, Xcode) | AD-19 | Mark `last_alive_at` as advisory, and never use it in a staleness rule. |
| 19 | low | catch-up `hub-job` ticket vs a leaseholder's extend | AD-15, AD-16 | Say explicitly whether hub-job tickets block extension. If they do, the budget has to make that deterministic. |
| 20 | low | AD-5 message when the Resource is free but reserved | AD-5 | Freeze the message grammar, including the reserved-not-held case. |

---

## 1. critical: Reservations are a shared mutable file, so release and grace race on the hot path (AD-7, AD-2)

**Pair.** A v1a lease waiter W (`hub-device lease s26 --wait 10m`) against the v1a `android` job's `finally`. Both obey AD-7 as written.

- AD-7 says grace is "stamped once, as `grace_started_at`", inside the Reservation file. The conventions say every write is "tmp + rename". So the stamper reads the Reservation, adds the key and renames over it.
- AD-7 says `android` "releases it in `finally`". Nothing orders that release against the Hold's release.

**Sequence.** `withLock`'s `finally` removes `adb.lock` first (lock.mjs:101-104), and the Reservation is removed after it.

- In that gap the Resource is free, the run's Reservation is at the head, and the run is not asking. That is exactly AD-7's grace-stamp condition.
- W polls every second (`HUB_DEVICE_POLL_MS`), so it is the most likely process to be polling at that instant.

The race runs like this:

1. W reads the Reservation R.
2. `android` unlinks R.
3. W renames `{...R, grace_started_at}` into place.

R is now **resurrected**. It is live until `reserved_at + 180 min`, and it does real damage:

- (a) It blocks the free S26 for the full grace (10 min), because W itself just stamped it.
- (b) AD-16 refuses every extension on `adb` for up to 3 h: "while a live … Reservation waits".
- (c) `status` shows a phantom.
- (d) A later `gh run rerun` of that run passes through at a 3-hour-old place.

The same read-modify-rename also loses updates: two stampers can each write their own `grace_started_at`, which is last-writer-wins.

**ABA.** AD-7 keys the file name by run (`<owner>--<repo>--<run_id>.json`). Suppose a gate on a rerun-all finds R expired and recreates it at the same path, while a pruner that judged the old R expired unlinks by path. The pruner then deletes the fresh Reservation. This is the same TOCTOU shape as `reclaim()` (lock.mjs:58-63).

**Tighten AD-7 (replace the File, Grace and Release bullets):**

- **File:** each Reservation is a directory, `<name>.reservations/<owner>--<repo>--<run_id>--<reserved_ms15>/`.
  - It is created as a tmp dir, then renamed into place.
  - It holds `reservation.json` (`{format, run_key, repo, run, reserved_at, expires_at}`), which is written once and never rewritten.
  - The name embeds the incarnation, so a re-created Reservation never shares a path with a pruned one.
- **Grace:** the stamper creates `grace.json` inside that directory with `wx`. The body is `{format, grace_started_at, grace_ends_at, by}`.
  - EEXIST means someone else stamped first. That stamp is canonical, and the loser reads it.
  - A create inside a directory that was released fails with ENOENT. Grace therefore can never revive a released Reservation.
- **Release and expiry:** rename the directory to `<name>.reservations/.gone-<stem>-<pid>-<rand>`, then `rm -r` it.
  - Exactly one releaser's rename succeeds, and only that one emits `release` (or `expiry`).
  - ENOENT means someone else already did it.
- **Order:** a Claimant that holds the Resource through its run's Reservation and releases the Reservation removes the Reservation **while still holding the lock**, then releases the Hold.
- **Never** rewrite a Reservation file. AD-2 gains: "Reservation and ticket bodies are immutable after their rename into place."

The same immutability rule must cover tickets: AD-18 stores the ETA "in the ticket", and refreshing it by rewrite would revive a ticket that `releaseLease` cancelled (lock.mjs:270-273).

## 2. high: AD-3's frozen liveness can create immortal tickets, and AD-3 contradicts AD-2 on keys (AD-3)

**Pair A.** An old `hub-device` (a pre-v1a release dir, which keeps running until `hosts:install`) is killed with SIGKILL while it waits. Its ticket is today's shape, `{lease_id, holder, why, pid, host, process_start, enqueued_at}` (lock.mjs:205): no `kind`, no `expires_at`. A v1a reader that follows AD-3 to the letter sees "any kind this version does not know … is live with no `expires_at`". An absent `kind` is not one of `lease | job | hub-job | remote`, so the ticket is **live forever**.

Every v1a waiter on `adb` then sits behind it. Old readers would prune it on their next poll (`staleWaiter`, lock.mjs:139-146), but once everyone has upgraded, no old reader is left. The result is a permanent FIFO wedge, and every deploy goes contention-pending until a person deletes the file. The same thing happens to a future kind (say v1b `registry-job`) written without `expires_at`, against v1a pins that keep running for 30 days of reruns.

**Pair B.** The lock epic writes AD-3's body literally, with `id` and no `lease_id`. Three existing callers match `lease_id`:

- `releaseLease` (lock.mjs:272)
- `hub-device` `--id` uniqueness and `release` (hub-device.mjs:129-135, :385)
- `emulator.mjs` `isEmulatorLease`, which hand-parses gate tickets (emulator.mjs:326-330)

AD-2 says "existing files keep every key they have today", but the body that AD-3 freezes drops one of those keys. Whichever rule the epic follows, it breaks the other.

**Pair C.** AD-12 needs process start *times* (the Runner.Worker start). The lock epic generalizes the `processStart` seam to return epoch ms on both hosts and writes that into `process_start`. Pinned old readers (v1.2.26+ `acquireLease` in old hub-device or emulator code) compare that value to their own `processStart()` string (lock.mjs:145). They prune every v1a ticket on every poll. The v1a waiter then finds its own ticket gone (lock.mjs:212) and throws `HUB_LEASE_CANCELLED`, which `android` turns red rather than pending.

**Tighten AD-3:**

- **Liveness:**
  1. A ticket with no `kind` is a legacy lease ticket.
  2. Any ticket that carries an integer `pid` and a `process_start` follows the pid rule, whatever its kind. A dead process means the ticket is stale.
  3. On top of that, a ticket is live only while `now < expires_at` when it has one.
  4. A ticket of an unknown kind with neither pid nor `expires_at` is live until `enqueued_at + 4 h`. The age comes from the **body**, never from the file name, because backdated names look old.
- **Writers:** every v1a+ writer sets `expires_at` to its own wait deadline plus margin. v1 writers never omit it.
- **Keys:** the body keeps `lease_id` on `kind: lease` tickets. `id` is additive.
- **Types and encodings, frozen:**

  | Field | Frozen as |
  | --- | --- |
  | `run`, `attempt` | decimal strings, exactly as the env gives them |
  | times | ISO-8601 UTC with ms |
  | `eta` | `{lo_ms, hi_ms, low_data}` |
  | `process_start` | byte-identical to today's `processStart(pid)` output (Linux `/proc` field 22; Mac `ps:<lstart>`) |

  AD-12's start time uses a separate `processStartedAtMs()`.
- **Tmp names:** the shared atomic-write helper names tmp files so they never end in `.json` (old `listWaiters` filters on `.json`, lock.mjs:152).

## 3. high: AD-9 "exactly once" is impossible with today's removal primitives, and it has no transition table (AD-9)

AD-9 says only the process whose atomic step succeeded writes the event. Five concrete pairs obey that rule and still double-emit, emit nothing, or contradict another AD:

1. **Two reclaimers.** `reclaim()` reads owner.json, compares, then calls `rmSync(path, {recursive:true, force:true})` (lock.mjs:58-63). With `force`, the call succeeds even when there is nothing to remove, so two waiters that both judged the same dead holder both "succeed". That produces two `reclaim` events. In the window between the compare and the `rm`, a third process can `mkdir` and write its owner, and the late `rm` deletes that **fresh** lock. Nobody notices the double holder.
2. **Canceller vs timing-out waiter.** `releaseLease` unlinks the waiting ticket (lock.mjs:272) and emits `cancel`. The waiter's own `finally` calls `rmSync(ticketFile, {force:true})` (lock.mjs:257). If its deadline passed in the same poll, it emits `timeout`. The result is two terminal events for one ticket.
3. **Catch-up vs lock.mjs.** AD-15 says "on `HUB_LOCK_TIMEOUT` it removes its ticket". If the catch-up epic does that itself (for example with `releaseLease(name, id)`), it emits `cancel` on top of lock.mjs's `timeout`.
4. **`hub-device status` vs AD-9's "status writes nothing".**
   - `main()` runs `reap()` before every `status` (hub-device.mjs:700-702).
   - `reap()` calls `releaseLease(record.slot, …)` on `emulator-<n>` (emulator.mjs:302), and `emulator-<n>` is Queued (AD-4).
   - That release is an atomic step that succeeded, so AD-9 requires an event. The other rule in the same AD forbids it.
   - The CLI epic adds a test that `events/` is untouched by status; the events epic emits from `reap`. Both cannot pass.
5. **Unnamed transitions.** Several transitions have no event assigned, so each epic will pick its own:
   - a mkdir that succeeded but whose claim unlink hit ENOENT and was rolled back (lock.mjs:233-237);
   - a prune of a dead waiter's ticket (lock.mjs:158, `rmSync force` again);
   - a Lease past `expires_at`: is that `expiry` or `reclaim`?
   - Reservation create, grace and expiry.

   The event shape also has no field that says whether the subject is a Hold, a ticket or a Reservation. AD-18's ETA, which pairs `acquire`/`release`, would then count Reservation releases as Holds.

**Tighten AD-9 (add):**

- **Transition table** (normative, one row per event): event, subject (`hold | ticket | reservation`), the syscall that decides it, the path, the emitter, and what the loser sees.

  | Event | Subject | Deciding syscall |
  | --- | --- | --- |
  | `request` | ticket | rename into place |
  | `acquire` | hold | ticket `unlinkSync` after mkdir+owner, or the mkdir itself for a try |
  | `release` | hold | rename of `<name>.lock` to `<name>.lock.gone-<pid>-<rand>` by the holder |
  | `reclaim` | hold | that same rename by a non-holder, then verify that the moved owner equals the judged owner |
  | `expiry` | hold or reservation | that rename (or the Reservation dir rename) where the reason is time |
  | `timeout` | ticket | the waiter's own `unlinkSync` of its ticket |
  | `cancel` | ticket | another process's `unlinkSync` of the ticket |
  | `claim` | reservation | the Reservation dir rename into place |

  If the verify step in a `reclaim` fails, the lock changed hands: move it back with `rename`, and on EEXIST or ENOTEMPTY drop the tombstone without an event.
- **No `force`:** no step that emits an event may use `force: true` or a recursive delete on a live path. ENOENT and EEXIST mean "lost the race": the step emits nothing and maps to the right code (`HUB_LEASE_CANCELLED` for a waiter whose ticket vanished).
- **Ownership of ticket removal:** the ticket is removed only by lock.mjs inside the waiting call. AD-15's "removes its ticket" means exactly that path.
- **Who appends:** `appendEvent` is imported only by `lock.mjs`. Add a conformance test that greps for any other importer. Claimants import only the read API.
- **Status and reap:** `hub-device status` is read-only *after* its pre-command reap. The reap is a writer and emits its own `expiry`/`release` events. Alternatively, `status` stops calling `reap()`. Choose one, and make the test match it.
- **File month:** the month in `events/<YYYY-MM>.jsonl` is the UTC month of `ts`.

## 4. high: "live" and "blocking" are conflated, so tries, refusals and positions disagree, and backdating breaks position 0 (AD-6, AD-7, AD-16, AD-17)

AD-7 defines a Reservation's liveness as `now < expires_at` (up to 180 min). After grace, it "keeps its place but never blocks a free Resource again". Three units consume "live" differently, and all three obey the ADs:

- **AD-6 try** (`takeAnyPhone`, hub-device.mjs:205-226, and emulator slot tries, emulator.mjs:504). A try "succeeds only if the lock is free and **nothing live is ahead**". A post-grace Reservation is live, so `hub-device lease phone` can never take a free S26 for up to 3 h after any run that left an `adb` Reservation (a failed run, an iOS-only run, a run where plan decided to skip). Meanwhile a queued `lease s26` on the same free phone is let through, because the Reservation no longer blocks it.
- **AD-16 refusal** counts "a live Reservation". A post-grace Reservation of a cancelled run therefore refuses every extension for 3 h.
- **AD-17 position and AD-18 ETA** sort "ticket file names together with live Reservations". A run that asks through its Reservation writes a backdated ticket at the **same place**. Unless the two are deduped, everyone behind sees the run twice: the position is off by one and the ETA counts that hold twice. AD-3 already carries a `reservation` key on the ticket, but AD-6 never says to use it.
- **Tie-break.** A Reservation's sort key is the ISO string `reserved_at`, while a ticket's key is its `<ms15>-<ctr6>-<pid8>` name. AD-6 does not say how a Reservation and a ticket with the same ms order, which is exactly the "two versions disagreeing on who is next" that AD-6 exists to prevent.

**Backdating breaks the invariant that "only position 0 may mkdir" depends on.**

- Today tickets only ever append, because names are `now()`-ordered (lock.mjs:201). A waiter that saw itself at position 0 stays at 0, so checking before mkdir is race-free.
- AD-6's backdated ticket **inserts ahead**. Waiter W snapshots the queue and sees the post-grace Reservation R, which is non-blocking, with no ticket for R's run, so W is effectively first.
- `android` then writes its ticket at R's place, so `android` is now position 0.
- Both call mkdir, and W can win. The run that held the place waits behind a Lease of up to 60 min and goes contention-pending.

**Tighten AD-6 (replace the Position bullet):**

- **One view:** `lock.mjs` exports `queueView(name)`, which returns ordered entries. Each entry has `{source: ticket|reservation, key, live, blocking}`.
- **Key:** a ticket's key is its file stem. A Reservation's key is `<ms15(reserved_at)>-000000-00000000`. At equal ms, a Reservation sorts before tickets, and Reservations among themselves sort by `run_key`.
- **Dedupe:** a Reservation is hidden from the view while any live ticket carries `reservation == its run_key`.
- **Blocking:**
  - A ticket blocks while it is live.
  - A Reservation blocks while it is live **and** one of these holds: grace is unstamped, `now < grace_ends_at`, or its run is asking.
- **Single rule for every consumer:** mkdir eligibility, the try's "nothing ahead", AD-16's refusal, AD-17's `position=` and AD-18's input all use **blocking** entries. "Place" (all live entries) is used only for sorting.
- **Post-mkdir verify:** after mkdir and the owner write, a v1a acquirer re-reads `queueView`.
  - If a blocking entry now sorts ahead of it, it gives the lock back (rename to a tombstone, no event) and waits again.
  - A backdater writes its ticket, then waits at least one poll before its own mkdir.

## 5. high: queue tuning read from each process's own policy, by three coexisting releases (AD-11)

**Pair.** Up to three versions act on one lock dir at once, each loading its own `policy.json`:

| Process | Runs from |
| --- | --- |
| `hub-device` | `releases/<ref>/` that `hosts:install` wrote (hosts.mjs:61), possibly `main-<sha>` |
| the catch-up | `current`, forward-only (common.mjs:106-129) |
| a pinned deploy job | `_actions/…/<ref>/` |

AD-11 says "`lock.mjs` reads them through `loadPolicy` itself" and "changing a value is a hub release". But a hub release does not replace the other two versions. AD-7 stores only `grace_started_at`, so each reader adds **its own** `grace`.

Say one release ships grace 10 min and the next ships 5 min. Between minute 5 and minute 10 the new hub-device treats the Reservation as non-blocking and mkdirs, while a pinned job treats it as blocking and waits. That is the exact disagreement AD-6 is meant to prevent. The same applies to the deploy-target cap when it is checked against an existing Lease, and to any future value that a reader applies to a record somebody else wrote.

**Tighten AD-11 (add):** "A tuning value that decides something about a record is resolved **once, by the writer**, and stored in the record as an absolute time: `expires_at` (Reservation, ticket, Lease) and `grace_ends_at` (in `grace.json`). Readers never apply their own policy to someone else's record. Policy values reach only decisions the reader makes about itself: its own wait deadline, its own request cap and its own ETA window."

## 6. high: AD-7's release rule contradicts its own "a rerun losing its place", and the gate reserves blindly (AD-7, AD-16)

**Pairs.** Three units obey AD-7 and together break its Prevents clause.

- **The releasers.** `android` and `ios` release in `finally`, and `announce` (`if: always()`, mobile-deploy.yml:511) releases as a backstop. Both happen whether the job succeeded or failed.
- **The mandated rerun.** The house procedure for finishing a failed deploy is `gh run rerun <id> --failed` (CLAUDE.md). That reruns `android` and `announce`, but **not** the gate. The rerun's `android` finds no Reservation and joins at the back.
- **The memlog's assumption.** The memlog says "reruns keep run id" in support of passthrough, but by the time the rerun asks, nothing is left to pass through.

**The gate.**

- AD-7 says "the gate writes `adb`", unconditionally. For iOS-only runs, and for runs where plan then decides the Android lane will not run (plan.mjs:306-316 can also drop the iOS lane after preflight-ios has reserved `mac-ios`), the Reservation blocks the free S26 for grace (10 min) on every such run.
- Under AD-16 as written ("live Reservation"), it also refuses every extension for 3 h.
- The gate already knows the scope: `scope.android ? quickS26(...) : 'n/a'` (gate.mjs:178).

**Tighten AD-7 (Writers and Release):**

- **Writers:** the gate writes `adb` only when `scope.android`, and `preflight-ios` writes `mac-ios` only when the iOS device lane will run.
- **Release:** the Reservation is released by the job that knows **no later job of this run will take the Resource**:
  - plan, when it sets the lane not to run;
  - `android`/`ios` on success or on a pending hand-off (AD-14);
  - `ios` after its last take: after :344 when there is no store build, otherwise after :390.
- **Failure:** on a failure the Reservation stays, so `rerun --failed` passes through at its place. After grace it no longer blocks (finding 4), and the ceiling ends it.
- **announce:** it releases only Resources whose lane concluded success or skipped.
- **AD-16:** counts only **blocking** Reservations (finding 4).

## 7. medium: one wait deadline per lock cannot fit the jobs' actual hold shapes (AD-12)

**Pair: the `ios` job's two takes (ios.mjs:276 and :390).**

- Both takes wrap Xcode builds: the build, export and install inside the first, then the store IPA build inside the second.
- AD-12's deadline is `job_start + job_timeout - margin - hold_allowance[lock]`. It subtracts **one** allowance per lock name.
- Suppose `hold_allowance['mac-ios']` is sized for the first take (about 50 min). The first take may wait until minute 68 and finish at minute 118. The second take then starts, and GitHub kills the job at 120.
- The iPad is installed, but no receipt is written (`guarded` never runs), so the outcome is worse than today's red.

**Pair: plan/adb vs android/adb.**

- plan holds `adb` for up to 180 s of phone wait plus a read.
- android holds it for a 30 s find plus an `adb install` of up to 600 s.
- One `hold_allowance['adb']` cannot fit both: sized for plan, it lets GitHub kill `android` mid-install; sized for android, it wastes most of plan's 20 min.

**Tighten AD-11 and AD-12:**

- `hold_allowance` is keyed by `"<job>/<lock>"` (`plan/adb`, `android/adb`, `ios/mac-ios#1`, `ios/mac-ios#2`).
- A take's deadline is `job_start + job_timeout − margin − Σ allowance(this take and every later take this job will make)`.
- Each take recomputes its own deadline.
- The conformance test also asserts that each job's `timeout-minutes` exceeds the sum of its allowances plus the margin.

## 8. medium: owner.json rewrites race the reclaimer and the next holder (AD-16)

In v1a, `extendLease` has no caller; the CLI verb ships in v1b, per the brownfield notes. AD-16 is the rule v1b must call, so the race has to be closed now.

- **`extendLease` vs an at-expiry reclaimer vs the next holder.**
  1. The extender reads the owner at `E − ε`, so its "at or after expiry" check passes.
  2. A reclaimer at `E` judges the Lease expired and removes the dir.
  3. Waiter C, at position 0, mkdirs and writes its owner.
  4. The extender's `writeOwner` (tmp + rename into `<name>.lock/`, lock.mjs:117-121) now **overwrites C's owner.json** with the extended Lease.

  C is running its body on the S26 while the record says the Lease holds it. That is a double holder, which is exactly what AD-16's Prevents clause names. `updateLease` has the same TOCTOU today (lock.mjs:290-299).
- **`extendLease` vs `updateLease`.** Both read, modify and rename. A late `updateLease({device})` writes back the old `expires_at`, so the extension is lost. A late extend drops `device.adb_port`, which AD-13's Peek reads.
- **`extendLease` vs a new waiter.** It checks for waiters, then writes. A waiter that enqueues in between gets the extension anyway, and its ETA was computed against the old expiry.

**Tighten AD-16 (add):**

- **Lead time:** "No process rewrites a Lease's owner.json within `queue.owner_write_lead_s` (policy, ≥ 60 s) of its `expires_at`. Reclaim by expiry happens only at or after `expires_at`." This puts a fixed gap between the last legal write and the earliest reclaim.
- **Write order:** `extendLease` writes first, then re-reads `queueView`. If it finds any blocking entry, it restores the prior record and refuses. Waiters create their ticket before they read the owner. In this Dekker order at least one side always sees the other.
- **Field ownership:** extend changes only `expires_at`. `updateLease` re-reads after its write and retries once if `expires_at` moved.
- **updateLease contract:** `updateLease` keeps its boolean contract and returns `false` at or after expiry; it never throws. hub-device.mjs:177 and emulator.mjs `recordPids` treat a falsy return as "cancelled".

## 9. medium: the Queued set misses the emulator FIFO and hard-codes the fleet (AD-4)

- **Emulator gate.** Emulator requests wait FIFO on the **gate**: `acquireLease('emulator', …)` at emulator.mjs:486. Slots are taken by `waitMs: 0` tries (emulator.mjs:504), and AD-6 says tries write no ticket. AD-4's set (`adb, s24, mac-ios, emulator-<n>`) leaves out `emulator`, which means:
  - an emulator wait writes no `request`/`timeout`/`cancel` and gets no ETA;
  - `extendLease('emulator-1')` never sees a waiter, because nobody queues on slots, so FR-31 is void for emulators.
- **Fleet extras.** `s24` comes from devices.json `android_extra`. A second extra phone added to devices.json is not Queued, so it gets no events and no AD-16 refusal. `lock.mjs` cannot read the fleet, because hub-device.test.mjs:332-343 bans `android_extra` under tools/ci/lib.

**Tighten AD-4:**

- `QUEUED = adb, s24, mac-ios, emulator, /^emulator-\d+$/`. Spell out the regex: `emulator-reaper` shares the prefix.
- AD-16 and AD-17 treat waiters on `emulator` as waiters on every `emulator-<n>`.
- Add a tools/device test asserting that every fleet lock, and the emulator gate, is in `QUEUED`.

## 10. medium: AD-13 protects the Lease only from plan, and it names a mechanism that cannot keep its promise (AD-13)

- **The gate is not bound.** The gate's `quickS26` (gate.mjs:138-140) takes no lock and calls `findPhone` with `nudgeEvery: 2`. That runs `adb start-server` (adb.mjs:83), then `adb mdns services` and `adb connect` on the second poll, while a Lease may hold the S26. AD-13 binds only plan, so the gate epic stays compliant and still reconnects the leaseholder's adb.
- **The adb binary auto-starts servers.** "It goes through the adb server that is already listening … never runs `start-server`" cannot be kept with the adb binary: any client call auto-starts a server when none answers.
  - Suppose the server dies between a probe and the call.
  - With `RUNNER_TRACKING_ID` blank, the Peek then leaves behind an orphan server that outlives the job.
  - The repo already has the right tool: `adb-wire.mjs` `shell(serial, command)` speaks the protocol directly and never starts anything (adb-wire.mjs:1-4, :48).

**Tighten AD-13:**

- **Scope:** every S26 read that does not hold `adb` (gate probe and plan Peek) talks only to `127.0.0.1:<lease.device.adb_port>` through `adb-wire.mjs`.
- **No binary:** it never spawns the adb binary.
- **Gate:** while `adb` is held by anyone, the gate skips the connect/mDNS nudge, and its S26 state comes from the Peek or is `unknown`.

## 11. medium: the wait line's trigger needs an ETA that AD-18 forbids computing (AD-17 vs AD-18)

- **The conflict.** AD-17 prints `HUB_LOCK_WAIT` "when the ETA moves by more than a minute". AD-18 says the ETA "is computed at enqueue and on a position change, never on every poll". The ETA moves without a position change, because the holder's elapsed time grows, so the line can only notice a move by recomputing.
- **How the two epics split.** The CLI epic recomputes every poll, rescanning `events/*.jsonl` and breaking AD-18. The ETA epic never recomputes, so AD-17's second trigger is dead code.
- **Tighten AD-18:**
  - `etaModel(events, policy)` reads history. It runs at enqueue and on a position change.
  - `eta(model, queueView, now)` is O(queue), touches no files, and runs every poll.
  - The ticket stores the enqueue `eta`.
  - AD-17's "moved > 1 min" compares consecutive `eta()` results.

## 12. medium: identities that collide (AD-3, AD-9, conventions)

- **Two Holds, one id.** The conventions define a job ticket id as `<repo>#<run>.<attempt>/<job>`, so `ios`'s two takes share one id. Events paired by `id` then fold hold 2's `request` into hold 1's `release`, and AD-18's hold durations come out wrong.
  - **Fix:** a Hold's identity is `<lock>/<ticket stem>`, carried as `hold_id` in every ticket and event. `id` stays the human id.
- **Cancelling a deploy job by id.**
  - Suppose the lock epic generalizes `releaseLease(name, id)` to match the new `id` key.
  - Then `hub-device release delorenj/gib#123.1/android` cancels a deploy job's ticket.
  - `withLock` throws `HUB_LEASE_CANCELLED`, and `android` goes red, not pending, because AD-14 catches only `HUB_LOCK_TIMEOUT`.
  - **Fix (AD-3):** only `kind: lease` and legacy tickets can be cancelled by id. `job` and `hub-job` tickets are removed only by their own process.

## 13. medium: announce's Mac release has no named code path (AD-1, AD-7)

- **The rules as written.** AD-7 says `announce` releases `mac-ios` "over ssh to `hub-mac`". AD-1 says only Mac processes write the Mac lock dir. Neither says **which code** runs on the Mac.
- **The likely choice fails.** The obvious target, `~/.local/share/mobile-deploy-hub/current`, is advanced only by a real `ios` job (ios.mjs:401-402). On the first v1a run whose iOS lane plan skipped after preflight reserved, `current` on the Mac still predates v1a. The backstop then fails, or it recomputes the file name with older rules.
- **Tighten AD-7:**
  - `announce` releases on the Mac by running **its own pinned** `lock.mjs` there: the module is sent over `ssh hub-mac node --input-type=module` stdin, and the process writing the Mac dir is still a Mac process, so AD-1 holds.
  - Alternatively, use a Mac entrypoint whose argv is frozen under AD-17.
  - Either way, the target is found by reading `run_key` from each Reservation, never by recomputing a file name. APFS is case-insensitive while Linux is not, so the two hosts must never derive names separately.

## 14–20. low

- **14 (AD-10).** `HUB_REF` comes first, so a `hub-device` started from a deploy hook inherits the action's ref and records the wrong version. Under `_actions/…/<ref>/` the path already names the ref. **Fix:** order the sources as module-path release (`releases/<ref>/` or `_actions/…/<ref>/`), then `HUB_REF`, then `unknown`. Also make `receipt.mjs` `hubRef()` a thin wrapper over `hubVersion()` that keeps the `null` value receipts rely on.
- **15 (AD-16).** `lease phone --for 4h` runs through `takeAnyPhone`. If acquireLease throws a usage-class error for `adb` above the cap, the whole `phone` request exits 2 even though `s24` may free in a minute. **Fix:** above the cap, a `phone` pass treats `s26` like a held phone and says why. Exit 2 is reserved for an explicit `s26`.
- **16 (AD-7).** Passthrough keys on `GITHUB_REPOSITORY`+`GITHUB_RUN_ID`. A deploy hook that runs `hub-device lease s26` inside the run inherits both, backdates to the Reservation, and then waits behind its own job's Hold until timeout. **Fix:** passthrough and backdating apply only to `kind: job`.
- **17 (AD-1).** `emulator.mjs` writes `emulators/` and reads `emulator-pool` under `HUB_LOCK_DIR` (emulator.mjs:66, :191-202). `isEmulatorLease` hand-parses gate tickets (emulator.mjs:326-330). Read literally, AD-1 forbids all three, so a "one test per AD rule" conformance check fails on day one. **Fix:** name `emulators/` and `emulator-pool` as owned by `emulator.mjs` (they are not protocol state), and require `isEmulatorLease` to use `listWaiters`.
- **18 (AD-19).** The heartbeat is an `unref`'d timer. It cannot fire while `fn` blocks in `spawnSync`, for example the `adb install` of up to 600 s or Xcode work. `last_alive_at` then understates life by up to the longest synchronous call. **Fix:** label it advisory (it is only for `held_ms`), forbid any staleness rule built on it, and touch only after confirming `owner.pid` is self.
- **19 (AD-15/AD-16).** With a contention-pending build, the catch-up enqueues a `hub-job` for a few seconds every 120 s, so a leaseholder's extend is refused at random. **Fix:** state whether `hub-job` tickets block extension. If they do, give the catch-up a budget long enough to make the refusal deterministic. The 45-min watchdog (catchup.mjs:1076) bounds it.
- **20 (AD-5).** When the Resource is free but a Reservation blocks, there is no holder for "is held by <holder>". Each epic will word it differently, and tests pin the prefix with `by lease`. **Fix:** freeze the grammar:
  - Held: `host lock <name> is held by <describe(owner)>; <n> ahead: <kind id pos>…; gave up after <dur>`.
  - Free but reserved: `host lock <name> is held by reservation <run_key> (grace until <iso>)`.

## Checked and holding

These pairs were constructed and found compatible as written:

- **Old pruners vs backdated tickets.** Old `staleWaiter` judges by host, pid and process_start, never by name age (lock.mjs:139-146). A backdated v1a ticket is safe from old pruners, provided finding 2's frozen encoding holds.
- **v1.2.42 pinned `withLock` vs v1a owners.** Pinned `withLock` releases by `pid` and `!isLease` only (lock.mjs:103). It judges age by the dir mtime, not owner.json (lock.mjs:44), so AD-19's touch is invisible to it, and v1a's additive owner keys do not change its staleness.
- **Old `listLocks`/status vs new paths.** Old `listLocks` and status ignore `<name>.reservations/` and `events/` (the `*.lock` filter, lock.mjs:305).
- **Exclusion across versions.** The mkdir on `<name>.lock` is still the one exclusion point across all versions. Barging by pins older than v1a is acknowledged in the Roll-out paragraph.
- **Cross-host clocks.** `adb` tickets and Reservations are all Linux-clock, and `mac-ios` ones are all Mac-clock, so FIFO never compares across hosts.
