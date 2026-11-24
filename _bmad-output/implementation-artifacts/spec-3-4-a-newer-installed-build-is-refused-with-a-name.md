---
title: 'Story 3.4: A newer installed build is refused with a name'
type: 'feature'
created: '2026-11-24'
status: 'done'
review_loop_iteration: 0
baseline_revision: '16e23fcc542c1a7a6cd6a9ba8fd23a8fac670273'
followup_review_recommended: false
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-3-context.md'
warnings: ['oversized']
deferred: []
---

<intent-contract>

## Intent

**Problem:** When the catch-up finds a newer build on the device than the pending one (the `ahead` path: `HUB_CATCHUP_AHEAD` on the S26, `HUB_IPAD_NEWER` on the iPad), it records `skipped` in `latest.json` and logs one line. Nothing says who put the newer build there, so a skipped delivery is silent (FR-30, AD-15). The Event Log has no `refused` event, although AD-9 lists one.

**Approach:** One level up (belsky-doctrine): any refusal on any Queued lock can name the Lease holders over a window, read from the Event Log. `lock.mjs` gains two readers and one writer. `leaseHoldersSince(name, since)` returns every Lease that held `name` at any moment from `since` until now. `deliveryPendingEvent(name, {repo, run})` finds the deploy's Story 3.2 `timeout` event with `reason: delivery-pending`. `noteRefused(name, …)` appends the AD-9 `refused` event. Both catch-up passes (S26 on `adb`, iPad on `mac-ios`) use one `whoInstalled` helper on their `ahead` result. It counts from the build's pending event, else from `latest.json`'s `device.since`, and records the holders, or `installed_by: 'unknown'` when there are none. Public data stays coarse.

## Boundaries & Constraints

**Always:**
- Node 24 ESM `.mjs`, `node:` builtins only.
- Only `lock.mjs` appends events.
- Tests are hermetic: a temp `HUB_LOCK_DIR`/`XDG_STATE_HOME`/`HUB_EVENT_DIR`, the fake adb, the fake S3, the fake iPad.
- Holder names go only to the Event Log and the host's own log line. Never to `latest.json`, the pages, the receipt copy in the bucket or a bus event.
- The `refused` event is written only in live mode, only after `record` succeeded, and not when `record` reports that nothing changed (`changed: false`). That gives one event per pending→skipped transition.
- Reading the Event Log never fails a pass. On a read error the holders are `[]`, which is recorded as `unknown`.

**Never:**
- No change to `latest.json` keys, the status enum, `transition()` or the public skipped reason text (`the S26 runs X, ahead of this build` and `the iPad runs X, newer than this build` stay as they are).
- No new event writer outside `lock.mjs`.
- No change to the install-time downgrade guard (`android.mjs:131`).
- No iOS lane change (Story 3.5).
- No retry or re-plan of a skipped build. Skipped stays final, and only `retry` restarts a device that is `failed` or `pending`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Busy-pending, Lease installed newer | A deploy of `repo#run` timed out on `adb` (`timeout`, `reason: delivery-pending`) while Lease `mine` of `agent-a` held it. The Lease put 0.2.9 (9) on the S26 and was released. Pending build 0.2.2 (4) | One `refused` event on `adb`: `claimant.kind: hub-job`, `reason: newer-installed`, `delivery {repo, run, version}`, `installed: '0.2.9 (9)'`, `installed_by: [{holder:'agent-a', lease_id:'mine', acquired_at}]`, `pending_since` = the timeout's ts, `pending_from: 'pending-event'`. `latest.json` is `skipped` with reason `the S26 runs 0.2.9 (9), ahead of this build`, and no holder name appears anywhere in it | none |
| Lease ended before the pending event | Lease `early` released before the deploy's timeout; Lease `mine` held it at the timeout | `installed_by` names only `mine` | none |
| No Lease since | Away-pending build (no pending event), no Lease events | `installed_by: 'unknown'`, `pending_from: 'latest.json'`, `pending_since` = `device.since` | none |
| iPad newer | Pending iOS build; Lease `pad` of `agent-b` on `mac-ios` in the Mac's Event Log; the iPad runs 0.3.0 (1) | `refused` on `mac-ios` in the Mac's Event Log naming `agent-b`; `latest.json` ios `skipped` | none |
| Watch mode | Same as row 1, mode watch | Log `HUB_CATCHUP_WATCH … would record skipped (HUB_CATCHUP_AHEAD) …; installed by agent-a (lease mine) …`; no event, no write | none |
| Second pass | After the refusal | Build is `skipped`: no install, no second `refused` event, `latest.json` version/code unchanged | none |
| Record failed | `record` throws | No `refused` event; the next pass finds it again and writes it once | logged `HUB_CATCHUP_ERROR` as today |
| More than 10 holders | 12 Leases since | `installed_by` lists the first 10 by acquire order plus `installed_by_more: 2` | the event stays under 4 KiB |

</intent-contract>

## Code Map

- `tools/ci/lib/lock.mjs:106-121` -- `eventOf(event, name, subject, fields)`: the AD-9 body. The `refused` event uses it with the catch-up's own `jobIdentity({kind:'hub-job'})` subject (`:270-275`), so `claimant.kind` is `hub-job`.
- `tools/ci/lib/lock.mjs:132-134` -- `note()`: make it return `appendEvent`'s boolean, or `false` for a name that is not Queued. Existing callers ignore it.
- `tools/ci/lib/lock.mjs:191-202` -- `checkDelivery`: reuse it to validate the refused event's `delivery`.
- `tools/ci/lib/lock.mjs:325` -- `MAX_LEASE_MS` (48 h): the lookback before `since`, so a Lease that started earlier but still held at `since` is found.
- `tools/ci/lib/lock.mjs` (new, after `extendLease`) -- `leaseHoldersSince(name, since, {env, log})`. It reads `readEvents({since: since − MAX_LEASE_MS})` and keeps events with `lock === name`, `hold_kind === 'lease'`, a `lease_id`, and `event` in `acquire|extend|release|reclaim|force-release`. A hold opens per `lease_id` on `acquire` (or on a first `extend`/end seen without an acquire), takes `claimant.holder` and the latest `expires_at`, and closes on an end event. It keeps holds whose end (the earlier of `ended_at` and `expires_at`, else open) is ≥ `since`, and returns `[{holder, lease_id, acquired_at}]` in log order. `deliveryPendingEvent(name, {repo, run}, {env, since, log})` returns the last `timeout` event with `reason === 'delivery-pending'` on `name` whose `claimant.repo === repo` and `String(claimant.run) === run`, else null. `noteRefused(name, {delivery, installed, installedBy, since, from}, {env, now, hostId, host})` writes one `refused` event with fields `reason: 'newer-installed'`, `delivery` (only when given), `installed`, `installed_by` (the first `REFUSED_NAMES_MAX = 10` as `{holder, lease_id, acquired_at}`, or `'unknown'` when empty), `installed_by_more` (only when cut), `pending_since` and `pending_from`. It returns `note`'s boolean.
- `tools/ci/lib/events.mjs:106` -- `readEvents`: import it into `lock.mjs` (events.mjs must not import lock.mjs: that would be circular).
- `tools/ci/commands/android.mjs:161-173` -- read-only. Story 3.2 writes the `delivery-pending` timeout with `claimant.repo = GITHUB_REPOSITORY` and `claimant.run = GITHUB_RUN_ID`, which equal `latest.json`'s `app.repo` and `block.run.id`.
- `tools/catchup/catchup.mjs:384` (androidApp) and `:559` (iosApp) -- the `ahead` outcomes. Add `was: plan.was`. The marker, reason and message are unchanged.
- `tools/catchup/catchup.mjs:295-317` (`settle`) -- for `kind === 'ahead'`, compute `whoInstalled(ctx, result)` once. Append `; installed by <names | unknown> (Leases on <lock> since <since>)` to the watch line and to the live marker line. In live mode, after `ctx.record` resolves with anything but `{changed: false}`, call `noteRefused(lock, …, {env: ctx.env})`. `ctx.record` on the Mac resolves `undefined`, which counts as changed.
- `tools/catchup/catchup.mjs` (new, near `catchupWait`) -- `const lockOf = {android:'adb', ios:'mac-ios'}`, `export const pendingLookbackMs = 6 * 3600_000`, `export function whoInstalled(ctx, result)`. It returns `{lock, delivery, since, from, holders}`, never throws, and builds `delivery` with `checkDelivery` (null on failure).
- `tools/catchup/catchup.test.mjs:143-176` (`linuxHost`), `:734-771` (`macHost`), `:350-372` (existing AHEAD test), `:798-819` (existing iPad newer test) -- fixtures and the tests that must stay green. Lease events come from `acquireLease`/`releaseLease` with `env: host.env`. The pending event comes from a `withLock('adb', …, {env: {...host.env, GITHUB_REPOSITORY: repo, GITHUB_RUN_ID: runId, GITHUB_JOB: 'android'}, timeoutMs: 200, timeoutReason: 'delivery-pending'})` that times out behind the Lease.
- `tools/ci/extend.test.mjs:21-33` -- the fixture pattern (temp `HUB_LOCK_DIR`/`HUB_EVENT_DIR`, injected clock) for the new lock-level test file.
- `README.md:94` -- the catch-up Queue paragraph. A sentence on the refusal goes after it.

## Tasks & Acceptance

**Execution:**
- `tools/ci/lib/lock.mjs` -- `note` returns its boolean; add `leaseHoldersSince`, `deliveryPendingEvent`, `noteRefused`, `REFUSED_NAMES_MAX`, importing `readEvents` -- AD-9 `refused`, generic for any Queued lock
- `tools/catchup/catchup.mjs` -- `was` on both `ahead` outcomes, `lockOf`, `pendingLookbackMs`, `whoInstalled`, and `settle` naming the holders in the log and writing the `refused` event after a successful record -- AD-15, FR-30
- `tools/ci/refused.test.mjs` (new, `hermetic()`) -- `leaseHoldersSince`: a Lease that ended before `since` is excluded, one held across `since` and one acquired after are included, an expired-but-unreclaimed Lease past `since` is excluded, an extended Lease uses its later expiry, other locks and waiter events are ignored. `deliveryPendingEvent` matches by repo and run and returns the last one. `noteRefused`: the event body, `'unknown'` when empty, the cut at 10 with `installed_by_more`, no event for a name that is not Queued, a bad delivery throws `bad delivery`
- `tools/catchup/catchup.test.mjs` -- the matrix rows: busy-pending with a Lease installer (the event fields, `latest.json` skipped and free of the holder name); Lease before the pending event excluded; unknown with `pending_from: 'latest.json'`; iPad on `mac-ios`; watch mode (the log names the holder, no event); second pass (no second event, version and code unchanged); record failure (no event)
- `README.md` -- document the refusal: the `refused` event, its fields, `unknown`, and that `latest.json` keeps the coarse reason

**Acceptance Criteria:**
- Given a pending build whose planned version is below the device's installed version, when the catch-up evaluates it in live mode, then the host's Event Log gets exactly one `refused` event on that device's lock naming the Lease holders since the build's pending event, `latest.json` records `skipped` with the coarse public reason and no holder names, and a later pass neither installs that version nor refuses it again.
- Given no Lease held the lock since the pending event, when it refuses, then the event says `installed_by: 'unknown'`.
- Given the hermetic suite, when `mise run check` runs, then it passes.

## Spec Change Log

## Review Triage Log

### 2026-11-24 — Review pass
- verdicts: 27 findings — high 0, medium 1, low 12, false 14, maybe-false 0
- findings:
  - `[false]` `[reject]` (blind) `installed_by` over-attributes: every Lease in the window is named, not only the one that installed. The epic AC asks for exactly this ("naming the Lease holders on that lock since the build's pending event") and calls the field `installed_by`. The README says these are the Leases that held the lock in the window.
  - `[low]` `[reject]` (blind) A crash between `record` and the append loses the event, and a failed write is silent. A crash loss is accepted by AD-9 (never fatal), and a reconcile step would add a new mechanism. A failed write is not silent: `appendEvent` itself logs `HUB_EVENT_LOG_FAILED`.
  - `[low]` `[patch]` (blind) `recorded?.changed !== false` fails open. Group G1, the record-result rule: a moved pointer and the Mac's ssh record (no result) both write the event, while the README and the code comment claimed "once the record took". The README paragraph and the `settle()` comment now state the real rule. The event is written unless record reports `changed: false`. A moved pointer is still a refusal, because the device does run a newer build. The Mac's record counts as taken, and a repeat there is unreachable, because a skipped build never comes back as `ahead`.
  - `[false]` `[reject]` (blind) A missing or garbled `device.since` makes the window start now. This is unreachable: `validateDevice` requires `since` as a non-null ISO string (`latest.mjs:125`), and `latestProblems` refuses the pointer before a pass acts on it.
  - `[false]` `[reject]` (blind) `reclaim` or `force-release` creates phantom holds, or takes the reclaimer as the holder. Retirement is exactly once (AD-9 rename), so a closed Lease never gets a second end event. A reclaim event's claimant is the judged owner (`retire` → `eventOf(as, name, judged)`), not the reclaimer.
  - `[false]` `[reject]` (blind) `installed_by` has two shapes, and the 4 KiB line is not tested at the maximum. The AC fixes `installed_by: unknown`. Ten entries clipped to 64-character holder and lease ids, plus a policy repo `delivery` and the envelope, stay near 2 KiB, well under 4 KiB.
  - `[low]` `[reject]` (blind) Test gaps: iPad pending-event, an unreadable log, a month rollover, more than 10 via `settle`, real sleeps. Month rollover is covered in `events.test.mjs`. A missing log dir yields nothing (readEvents). More than 10 holders goes through the same `noteRefused` call that is tested. The timings have wide margins (a 200 ms timeout).
  - `[false]` `[reject]` (blind) The privacy assertion contradicts the log-line assertion. `host.events` is the bus `emit` list, not the host log, so asserting that no name is there and that the name is in `host.lines` is consistent.
  - `[false]` `[reject]` (blind) A null lock prints "Leases on null". `result.platform` is always `android` or `ios` (the `platforms` enum, and each pass sets its own), so `lockOf` always resolves.
  - `[low]` `[reject]` (blind) Docs beyond the README are not updated. AD-9's table already lists `refused`, and the README documents the fields and `unknown`. The 64-character clip is an internal bound.
  - `[low]` `[reject]` (blind) Two Event Log reads per refusal. Refusals are rare and the monthly files are small, and merging the reads would couple the two generic helpers.
  - `[low]` `[patch]` (edge) The Mac's record resolves undefined, so the guard never fires on the iPad. Group G1, and the wording was patched as above.
  - `[low]` `[patch]` (edge) A `{moved: true}` record writes the event. Group G1. This is kept by design, because the device does run a newer build, and it is now documented.
  - `[false]` `[reject]` (edge) A `noteRefused` that returns false is unlogged. `appendEvent` logs `HUB_EVENT_LOG_FAILED` on every failed write. `note` is called with no `log`, so the default `console.error` goes to journald.
  - `[false]` `[reject]` (edge) An unparsable `since`. Same refutation as the blind row: `validateDevice` requires an ISO `since`.
  - `[low]` `[reject]` (edge) The log line is unbounded with many holders, and a holder name could inject log lines. This needs many Leases in one window on a 60-minute-capped device. It is the host's own log, and holders are named by agents on this host.
  - `[false]` `[reject]` (edge) The window has no upper bound at the install time, so later Leases are named. The AC defines the window as "since the build's pending event", and the install time is not observable.
  - `[false]` `[reject]` (edge) An orphan hold takes its holder from the reclaimer. Same refutation as the blind row: reclaim events carry the judged owner as the claimant.
  - `[low]` `[patch]` (edge) The README claimed one event "not when latest.json already said so" on the iPad too. Group G1, and the wording was patched.
  - `[medium]` `[patch]` (verification-gap) `leaseHoldersSince` was never tested with a `reclaim` event. Added a case to `refused.test.mjs`: a 40-minute Lease whose holder pid is dead is reclaimed by a taker at +10 min. It is included for a `since` before the reclaim and excluded after. I verified that it fails with `reclaim` dropped from `LEASE_ENDS`.
  - `[low]` `[patch]` (verification-gap) A moved pointer passes the `changed` guard, which the README did not say. Group G1, and the wording was patched.
  - `[low]` `[patch]` (verification-gap) On the Mac, `changed: false` never reaches `settle`. Group G1, and the wording was patched. A duplicate there is unreachable, because a skipped iOS build is checked as `settled`, whose newer-build branch returns `idle`.
  - `[false]` `[reject]` (intent) The write is in `settle` after `record`, not at evaluation. It is the same pass's evaluation result, written after the record so the event is exactly once (Design Notes).
  - `[false]` `[reject]` (intent) The plan-time `HUB_IPAD_NEWER` in `plan.mjs` is untouched. The epic ACs pin the catch-up's `ahead` path (`catchup.mjs:148/377/656`), and AD-13 keeps the install and plan guards as they are.
  - `[false]` `[reject]` (intent) There is no Holocene, page or bus change. The ACs name only the Event Log, and the public surfaces must stay free of names (AD-14).
  - `[false]` `[reject]` (intent) There is no schema validator for `refused`. `events.mjs` validates no event type, only the envelope and the size, and `refused` uses the same `eventOf` body as every other event.
  - `[low]` `[reject]` (intent) The 6 h lookback for the pending event is a design choice. The deploy's timeout precedes `device.since` by minutes, and a miss falls back to `device.since`, which only widens the window to the publish time.

## Design Notes

"Since the pending event" covers overlap, not only start: the Lease that blocked the deploy (so the delivery went pending) is usually the one that installed a newer dev build, and it started before the pending event. So a Lease counts when its hold overlaps [pending event, now]. Its end is the earlier of its end event and `expires_at`, as `heldMs` does.

Exactly once: the event follows a successful `record`. A skipped build is never pending again: the S26 pass reads only pending builds, and the iPad's settled check returns `idle`, not `ahead`, for a newer build. So the refusal cannot repeat. A crash between `record` and the append loses the event, and that is accepted: the Event Log is never fatal (AD-9).

"The version is not reused": the catch-up never re-plans, re-mints or re-installs the refused version. `skipped` is final for that build, and the next deploy bumps above the device as `plan.mjs` already does.

## Verification

**Commands:**
- `node --test tools/ci/refused.test.mjs tools/catchup/catchup.test.mjs` -- expected: all pass
- `mise run check` -- expected: actionlint and the full suite are green

## Auto Run Result

Status: done

**Summary.** When the catch-up finds a newer build on the device than the pending one (`HUB_CATCHUP_AHEAD` on the S26, `HUB_IPAD_NEWER` on the iPad), it now names who could have put it there. It reads the Event Log on that device's lock (`adb` or `mac-ios`) for every Lease that held the lock from the build's pending event until now. The window starts at the deploy's Story 3.2 `delivery-pending` timeout for that repo and run, else at `latest.json`'s `device.since`. In live mode, after the record, it appends one AD-9 `refused` event with these fields:
- `claimant.kind: hub-job`
- `reason: newer-installed`
- `delivery {repo, run, version}`
- `installed`
- `installed_by`: up to 10 `{holder, lease_id, acquired_at}` with `installed_by_more`, or `'unknown'`
- `pending_since`
- `pending_from`

The host log line names the same holders. `latest.json` still records `skipped` with the coarse reason, and no holder name reaches the bucket, the pages or the bus. A skipped build is final: a later pass neither installs nor refuses it again.

One level up (belsky-doctrine): `lock.mjs` gains generic `leaseHoldersSince`, `deliveryPendingEvent` and `noteRefused`. Any Queued lock can now name its Lease holders over a window, and both catch-up passes share `whoInstalled`.

**Files changed**
- `tools/ci/lib/lock.mjs`: `note` returns whether it wrote. Adds `leaseHoldersSince` (Leases overlapping a window; release, reclaim and expiry close a hold; extend moves the expiry), `deliveryPendingEvent`, `noteRefused` and `REFUSED_NAMES_MAX`.
- `tools/catchup/catchup.mjs`: `was` on both `ahead` outcomes, `whoInstalled`, `pendingLookbackMs` and `lockOf`. `settle` names the holders on the watch and live lines and writes `refused` unless record reports `changed: false`.
- `tools/ci/refused.test.mjs` (new): the holder window (before, across, after, expiry, extension, reclaim, other locks), the pending-event lookup and the `noteRefused` body, `unknown`, the cut at 10, a name that is not Queued, and a bad delivery.
- `tools/catchup/catchup.test.mjs`: six end-to-end tests for the matrix rows.
- `README.md`: the refusal paragraph.

**Review findings.** 27 findings: high 0, medium 1, low 12, false 14.
- Patched: 2 entries.
  - The `reclaim` holder-window test (medium). I verified that it fails without `reclaim` in `LEASE_ENDS`.
  - The record-result rule wording in the README and the `settle` comment (low; 6 rows, G1).
- Deferred: none.
- Rejected, each with its reason in the Review Triage Log:
  - The false ones:
    - over-attribution (×2, the AC defines the window);
    - an unparsable `since` (×2, validateDevice requires ISO);
    - reclaim phantom holders (×2, exactly-once and the judged-owner claimant);
    - the shape and size of `installed_by` (the AC fixes `unknown`, under 4 KiB);
    - the privacy assertion (`host.events` is the bus);
    - a null lock (an unreachable platform);
    - an unlogged write failure (appendEvent logs it);
    - the four intent-surface notes (scope pinned by the epic ACs and AD-13/14).
  - The low ones:
    - a crash between record and append (AD-9 never fatal);
    - test gaps (covered elsewhere or by the same path);
    - docs beyond the README;
    - two log reads;
    - the length of the log line;
    - the 6 h lookback.

Patched counts by verdict: high 0, medium 1, low 1 entry (6 rows).

**Follow-up review: false.** No high was patched and only one medium was patched, so no unverified risk is left to name.

**Verification**
- `node --test tools/ci/refused.test.mjs tools/catchup/catchup.test.mjs`: 67 of 67 pass.
- `mise run check`: actionlint, then 663 of 663 (662 before the review patch).
- Matrix audit, every row covered by a passing test:
  - busy-pending with a Lease installer, and the earlier Lease excluded (catch-up test 1);
  - unknown from `latest.json` (test 2);
  - iPad on `mac-ios` (test 6);
  - watch mode (test 3);
  - second pass (tests 1 and 6);
  - record failed (test 4);
  - more than 10 holders (`noteRefused` in `refused.test.mjs`).

**Residual risks**
- `installed_by` is a list of suspects, not proof: every Lease in the window is named, including one that only read the device. A non-Lease install (a person with a cable) reads as `unknown`, or names a Lease that happened to overlap.
- A crash between the record and the append loses the event for good, because the build is then `skipped` and final.
- The iPad's refusal lands in the Mac's Event Log only. In v1a it is visible on the Mac, not from big-chungus.
- No real refusal has run yet. The first `ahead` on a release carrying this change is the live proof.
