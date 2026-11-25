---
title: 'One reserved-word list, one slug rule, res-* locks queue'
type: 'feature'
created: '2026-11-24'
status: 'done'
baseline_revision: 'f5bf6d1c9372cc611da339c46ccec9d3a7c33d8b'
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-5-context.md'
warnings: ['oversized']
deferred:
  - summary: >-
      An android_extra phone other than s24 (for example "Pixel") passes the name rule but sits on a bare, non-Queued lock whose events are dropped and whose resource is null.
    evidence: |-
      isQueued covers only the frozen v1a QUEUED set, emulator-<n> and res-<slug>, and SEED_RESOURCES maps only adb, s24 and mac-ios, so a lock named "pixel" gets no queue ticket and no events. This predates Story 5.2 (any extra phone but s24 was already bare). names.test.mjs fails when the committed devices.json gains such a phone, but a HUB_DEVICES override file does not run that test. Settling it means choosing whether devices.json may still declare new phones (then seed and queue them) or new phones must be registered as res-<slug> (then refuse unseeded android_extra names).
    location: >-
      tools/ci/lib/devices.mjs android_extra; tools/ci/lib/lock.mjs isQueued
    severity: medium
---

<intent-contract>

## Intent

**Problem:** Reserved device words live in a private four-word array in `devices.mjs`, `lock.mjs` has no slug rule, and `isQueued` knows only the v1a set, so a lock the Registry mints (`res-<slug>`) would sit on a bare `mkdir` with no queue and no events, and hold events cannot say which Resource they were on (AD-28, AD-29, AD-40).

**Approach:** `lock.mjs` becomes the one owner of names: it exports `SLUG`, one frozen `RESERVED` list with a matcher and one name rule, grows `isQueued` by name only (`res-<slug>`), and stamps every hold event with an additive `resource` from a pure `resourceOf(lock)` seed map. `devices.mjs` and the CLI's fleet builder check names through that one rule; a test keeps the seed map, `DEPLOY_TARGETS` and `RESERVED` in line with `devices.json`.

## Boundaries & Constraints

**Always:**
- `SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/` exactly; a slug is 1 to 32 characters, a name at most 28 (so `res-<28>-999` passes).
- `RESERVED` is one frozen exported array of strings: exact words, `<prefix>*` shapes and the `emulator-<n>` shape. It holds at least the AC's entries.
- A seeded Resource keeps its own word: a reserved name is allowed in `devices.json` only when the seed map maps that lock to a Resource with the same id (today only `s24`).
- `isQueued` and `resourceOf` decide by name only; `lock.mjs` never reads `registry.json` or `devices.json`.
- Additive only: no key of any owner, ticket or event is removed or renamed; old readers ignore `resource` (AD-2).
- Existing messages pinned by tests stay (`android_extra[].name may not be "<name>"`); Node 24 ESM, built-ins only, hermetic tests.

**Never:**
- No change to `QUEUED`'s four entries, the on-disk layout, owner records, the deploy path (`tools/ci/commands/*`, `tools/catchup/*`), `policy.json` or any CLI command, flag, exit code or `--json` shape.
- No Registry store, minting, Reachability, `statusView` or host key work (Stories 5.3-5.5, Epic 6).
- No refusal of `--id` values (they are ids, not names; 5.1 kept `--id s26` accepted).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Queued by name | `adb`, `s24`, `mac-ios`, `emulator`, `emulator-3`, `res-pixel`, `res-<28 chars>-999` | `isQueued` true | No error expected |
| Not queued | `s3-tolt`, `emulator-reaper`, `res-`, `res-Pixel`, `res-a--b`, `res-<33 chars>`, `pixel`, `s26` | false | No error expected |
| Reserved | `phone`, `ipad`, `mac`, `s3-x`, `emulator-7`, `registry`, `res-x`, `l-1`, `e-1`, `job:x` | `reservedBy` returns the matching entry | — |
| Extra phone named `Ipad` / `Registry` | `parseDevices` | refused `android_extra[].name may not be "ipad"` | throws |
| Committed `S24` extra | `parseDevices(devices.json)` | accepted (seeded word) | No error expected |
| Hold event | `acquire` on `adb`, `s24`, `mac-ios`, `emulator-2`, `res-pixel` | `resource` = `s26`, `s24`, `ios-lane`, `emulator`, `res-pixel` | — |
| Pool-level event | `poolRequest('phone')` | `resource: null` (lock is null) | — |
| `res-*` lock | `acquireLease('res-pixel')` with a waiter | ticket in `res-pixel.queue/`, request/acquire/release events written | — |

</intent-contract>

## Code Map

- `tools/ci/lib/lock.mjs` -- protocol owner. `QUEUED`/`isQueued` L30-31 (extend `isQueued`); `eventOf` L107 (the one hold-event body builder: add `resource`); `note` L134 gates appends on `isQueued`, so `res-*` events start flowing with no other change; `withLock` L233/L286 route `isQueued` names through `queuedLock`; `DEPLOY_TARGETS` L366; `poolRequest` L923 calls `eventOf(event, null, …)`.
- `tools/ci/lib/devices.mjs` L33-35 -- the private `['s26','phone','emulator','adb']` array to delete; replace with the shared name rule. Names are `entry.name.toLowerCase()`.
- `tools/device/claims.mjs` `fleetOf` L68 -- the CLI's name source (device word = lowercased `android_extra[].name`); add the same name check so the CLI never builds a reserved word that is not seeded.
- Internal lock names in use (grep `withLock(`/`acquireLease(`): `adb`, `s24`, `mac-ios`, `emulator`, `emulator-<n>`, `emulator-reaper` (`tools/device/emulator.mjs` L34), `s3-index`, `s3-<slug>` (`tools/ci/lib/s3.mjs`). Id shapes minted: `l-<hex>` (`lock.newLeaseId` L912), `e-<hex>`, `run-<pid>-<hex>` (`claims.newLeaseId`), `job:<repo>#…` (`lock.jobLeaseId` L446).
- `tools/ci/devices.json` -- seed source: `android` (S26, lock `adb`, deploy target), `android_extra` (S24, lock `s24`), `ios` (iPad, lock `mac-ios`, deploy target).
- Tests pinning current behaviour (must stay green unedited): `tools/device/lease.test.mjs` L300-303 (`QUEUED` exact list, non-queued examples), `tools/ci/v3.test.mjs` L700-711 (`may not be "phone"`, `may not be "adb"`), `tools/ci/events.test.mjs`.
- v1.2.46 event body (`git show v1.2.46:tools/ci/lib/lock.mjs` L96-111): keys `event, lock, hold_kind, claimant, lease_id, for_ms, expires_at, deadline_at, waited_ms, held_ms, reason, last_alive_at` plus per-call fields; its readers are `readEvents` (JSON per line), `leaseHoldersSince`, `readOwner`/`listLocks`/`liveLease`.

## Tasks & Acceptance

**Execution:**
- `tools/ci/lib/lock.mjs` -- add `SLUG`, `SLUG_MAX = 32`, `NAME_MAX = 28`, `isSlug(text, max)`; frozen `RESERVED` (`phone`, `emulator`, `adb`, `s24`, `s26`, `ipad`, `mac`, `mac-ios`, `ios-lane`, `emulator-reaper`, `s3-*`, `emulator-<n>`, `registry`, `hub-api`, `host-agent`, `res-*`, `l-*`, `e-*`, `run-*`, `job:*`) and `reservedBy(name)`; frozen `SEED_RESOURCES = {adb: 's26', s24: 's24', 'mac-ios': 'ios-lane'}`, `EMULATOR_POOL = 'emulator'`, pure `resourceOf(lock)`; `nameRefusal(name)` (null, or a reason: not a slug / over 28 / reserved and not seeded); `isQueued` adds `res-<slug>` (slug ≤ 32); `eventOf` adds `resource: resourceOf(name)`; update the Queued-set comment. -- AD-28/AD-29/AD-40 single owner.
- `tools/ci/lib/devices.mjs` -- delete the reserved array; refuse an `android_extra` name for which `nameRefusal` gives a reason, keeping the `may not be "<name>"` message form (reason in the parenthesis). -- one list.
- `tools/device/claims.mjs` -- `fleetOf` throws a plain Error with no `code` (a broken fleet is a tool failure, exit 1, like a broken `devices.json`) when an extra phone's word fails `nameRefusal`. -- the CLI checks names against the same list.
- `tools/ci/names.test.mjs` -- NEW, hermetic (temp `HUB_LOCK_DIR`/`HUB_EVENT_DIR`): the I/O matrix; `RESERVED` frozen and containing every AC entry; `resourceOf` purity (no fs reads: works with a nonexistent lock dir) and its map; seed-map test deriving from the committed `devices.json` (android → `s26`@`adb`, each `android_extra` → its lowercase@itself, ios → `ios-lane`@`mac-ios`) asserting `SEED_RESOURCES` equals that map, `DEPLOY_TARGETS` equals `[android lock, ios lock]`, every seeded lock is `isQueued` and every seeded word is in `RESERVED`; a `res-pixel` Lease with a waiter queues and writes events with `resource: 'res-pixel'`; the v1.2.46-shape fixture (owner and event lines with exactly the v1.2.46 keys, with and without `resource`) read through `readEvents`, `leaseHoldersSince`, `listLocks`, `liveLease` gives identical results, and a current hold event's keys are the v1.2.46 keys plus `resource` only. -- one test per AD rule.

**Acceptance Criteria:**
- Given `lock.mjs` is imported, when its exports are read, then `SLUG` is exactly `/^[a-z0-9]+(-[a-z0-9]+)*$/`, `RESERVED` is frozen and holds every AC entry, and `devices.mjs` contains no reserved-word array of its own.
- Given an `android_extra` phone named after any reserved word except its own seeded one, when `parseDevices` or `claims.fleetOf` reads it, then it is refused; the committed `devices.json` still loads.
- Given `isQueued`, when called with the v1a set, `emulator-<n>` or `res-<slug>`, then it is true without reading any file, a bare name is false, and `res-<28-char slug>-999` is true.
- Given a hold event appended on any Queued lock, when it is read back, then it carries `resource` from `resourceOf`, and the seed-map test fails if `SEED_RESOURCES` or `DEPLOY_TARGETS` drift from `devices.json`.
- Given a v1.2.46-shape owner and event carrying `resource`, when the shared readers read them, then their results equal those for the same records without it.

## Spec Change Log

## Review Triage Log

### 2026-11-25 — Review pass
- verdicts: 26 findings — high 0, medium 2, low 13, false 11, maybe-false 0
- findings:
  - `[low]` `[patch]` (blind) the names comment says `res-<name>-999` is "a slug of at most 32", but the lock is 36 characters; the bound is on the part after `res-` — comment reworded to say the part after `res-` is at most 32 and the whole lock at most 36 (fc3bd76).
  - `[false]` `[reject]` (blind) `resourceOf('res-pixel')` returns the lock, not the word `pixel` — AD-28 fixes `id = lock = res-<slug>` for a runtime Resource; the name is an editable word, the id is the lock.
  - `[false]` `[reject]` (blind) the `emulator` gate returns `'emulator'` while the comment says Pool-level events carry null — "Pool-level" means a `poolRequest` event with `lock: null`; an event on the `emulator` lock is a lock event, and the AC maps `emulator` to the emulator Pool.
  - `[medium]` `[patch]` (blind) `parseDevices` is stricter (slug, 28 characters) with no test of those halves through the caller — tests added: a 29-character extra is refused and a 28-character one loads, through `parseDevices` and `fleetOf` (fc3bd76). Spaces and underscores were already refused by the existing `^[A-Za-z][A-Za-z0-9]*$` rule, so only the 28 cap (AD-28) is new.
  - `[low]` `[reject]` (blind) `fleetOf` and `parseDevices` each build the `may not be` message — the rule itself is one function (`nameRefusal`); a shared message helper adds exported surface for a check that today only meets the committed file.
  - `[false]` `[reject]` (blind) `devices.mjs` imports all of `lock.mjs` for `nameRefusal` — no named harm: no import cycle, and every deploy-path consumer of `devices.mjs` already loads `lock.mjs`.
  - `[false]` `[reject]` (blind) `RESERVED` is not the only list: `REAPER`, `DEPLOY_TARGETS`, `RESERVABLE`, `QUEUED` repeat names — those are role sets (which lock is capped, reservable, Queued), not reserved-word lists; every name in them is in `RESERVED`.
  - `[low]` `[patch]` (blind) nothing ties claims.mjs's own `PHONE`/`EMULATOR` words to `RESERVED` — test added asserting both are reserved (fc3bd76).
  - `[false]` `[reject]` (blind) `job:*` can never match a slug and the shape language is undocumented; `l-*`/`e-*` block `e-ink` — the AC lists every one of these entries; the shapes are documented in the comment above `RESERVED`.
  - `[low]` `[reject]` (blind) the `lease.test.mjs` `body()` helper now strips `resource`, so reclaim/extend/refused `resource` values go unchecked — every hold event is built by the single `eventOf`, whose `resource` depends only on the lock name, which names.test pins across five lock shapes.
  - `[low]` `[patch]` (blind) the res-pixel queue test gives up after 2 s on real timers; the `cwdBefore` check asserts nothing — bound raised to 10 s with the waiter at 30 s, `cwdBefore` lines deleted (fc3bd76).
  - `[low]` `[reject]` (blind) `nameRefusal('s24')` is null for any caller, so a future Registry Resource could take `s24` — no non-seed caller exists yet; Story 6.6's store refuses names that collide with any record, and the seeded `s24` is a record. A `seeded` flag adds a parameter for a caller that does not exist; noted under residual risks.
  - `[low]` `[patch]` (edge) same claim as the blind comment-arithmetic row — same fix (fc3bd76).
  - `[false]` `[reject]` (edge) `res-pixel-2` reports `resource: 'res-pixel-2'` — same as the blind `resourceOf` row: by AD-28 that lock is that Resource's id.
  - `[low]` `[reject]` (edge) a devices.json extra with a space, underscore or over 28 characters stops loading — spaces and underscores were already refused before this change; the 28 cap is AD-28's name limit and no declared phone comes near it.
  - `[low]` `[reject]` (edge) same claim as the blind `nameRefusal('s24')` row — same reason.
  - `[medium]` `[defer]` (edge) an `android_extra` phone that is not `s24` (e.g. `pixel`) passes the name rule but sits on a bare, non-Queued lock with `resource: null` — this predates the story (any extra phone but `s24` was already bare); the seed test fails when the committed file gains one, but a `HUB_DEVICES` override does not; deferred.
  - `[low]` `[reject]` (edge) `job:x` is refused as "not a slug" rather than "reserved" — the name is refused either way; the reason text is the only difference and no caller branches on it.
  - `[medium]` `[patch]` (verification-gap) the slug and 28-character halves of the rule are untested through `parseDevices` and `fleetOf` — same root cause and fix as the blind `parseDevices` row (fc3bd76); `fleetOf` also refuses `Pixel 7`.
  - `[low]` `[patch]` (verification-gap) the names comment claims ownership of Lease id names while `leaseId`/emulator `LEASE_ID` keep their own regex — comment reworded: lock and Resource word names, plus the id shapes no word may take; Lease ids keep their own rules (fc3bd76).
  - `[false]` `[reject]` (intent) no CLI/`status` test for a `res-*` lock — the AC's surface is `lock.mjs` (`isQueued`, events); the CLI cannot reach a `res-*` lock until the Registry stories, and status is Story 5.4.
  - `[low]` `[patch]` (intent) the `withLock` deploy-job route on a `res-*` lock is not exercised — test added: `withLock('res-pixel')` writes request, acquire, release with `resource: 'res-pixel'` and `hold_kind: 'job'` (fc3bd76).
  - `[false]` `[reject]` (intent) `SLUG` has one real consumer — the AC asks for the export; the Registry store (Story 6.6) is the next consumer.
  - `[false]` `[reject]` (intent) `resource` on owners is only test-written — by design (Design Notes): owners are unchanged, and the fixture proves readers tolerate the key.
  - `[false]` `[reject]` (intent) `SEED_RESOURCES` is a literal and drift is caught only when the test runs — that is exactly the AC's mechanism ("a test fails if …").
  - `[low]` `[reject]` (intent) same claim as the edge `job:x` reason-text row — same reason.

## Design Notes

- `ios-lane` and `run-*` go beyond the AC's list: `ios-lane` is a seeded Resource id and `run-*` an id shape `claims.newLeaseId` mints; resolution is id-first, so a name in either shape would be shadowed. Both are superset entries, no reader breaks.
- `RESERVED` stays data (strings), matched by one function, so the Registry store (Story 6.6) imports the same list and matcher; "seeded Resources are exempt" there is the same `SEED_RESOURCES` rule.
- Pool-level events (`poolRequest`, lock null) carry `resource: null`; the Pool is already in `pool`. AD-33's Pool events are Story 5.7's.
- Owner records are not changed; the v1.2.46 fixture includes an owner with `resource` only to prove readers tolerate a future writer.

## Verification

**Commands:**
- `node --test tools/ci/names.test.mjs` -- expected: all pass
- `node --test tools/device/lease.test.mjs tools/ci/v3.test.mjs tools/ci/events.test.mjs tools/device/claims.test.mjs tools/device/hub-device.test.mjs` -- expected: all pass, no assertion edited
- `mise run check` -- expected: actionlint clean, full suite green

**Manual checks (if no CLI):**
- Probe once against real v1.2.46 code (`git archive v1.2.46 tools | tar -x -C <tmp>`): its `readEvents`, `leaseHoldersSince`, `listLocks` read a lock dir and event log written by this change with no error and the same holds; record the outcome in the Auto Run Result.

## Auto Run Result

Status: done

**Summary.** `tools/ci/lib/lock.mjs` now owns names (AD-28, AD-29). It exports `SLUG` (exactly `/^[a-z0-9]+(-[a-z0-9]+)*$/`), `SLUG_MAX` 32, `NAME_MAX` 28 and `isSlug`; one frozen `RESERVED` list (every AC entry plus `ios-lane` and `run-*`) with `reservedBy`; and one name rule, `nameRefusal`, under which a seeded Resource keeps its own word. `isQueued` grows `res-<slug>` by name only, so a Registry lock queues from its first use through both `acquireLease` and `withLock`. Every hold event carries an additive `resource` from the pure `resourceOf` seed map (`adb`→`s26`, `s24`, `mac-ios`→`ios-lane`, `emulator`/`emulator-<n>`→`emulator`, `res-*`→itself, `null` on a Pool-level event). `devices.mjs`'s private reserved array is gone; it and the CLI's `claims.fleetOf` both check names through `nameRefusal`.

**Files changed.**
- `tools/ci/lib/lock.mjs`: names, `RESERVED`, seed map, `resourceOf`, `nameRefusal`, `isQueued` for `res-<slug>`, `resource` in `eventOf`. A private `NAME_MAX = 64` (refused-event clip length) was renamed `CLIP_MAX` to free the name.
- `tools/ci/lib/devices.mjs`: the reserved-word array is replaced by `nameRefusal`, and the `may not be "<name>"` message is kept.
- `tools/device/claims.mjs`: `fleetOf` refuses an extra phone's word through the same rule, with a plain Error (exit 1).
- `tools/ci/names.test.mjs`: new, 14 hermetic tests. They cover the I/O matrix, `RESERVED`, the slug and 28 rules through both callers, the CLI words, `resourceOf` purity, the seed map, `DEPLOY_TARGETS` and `RESERVED` against `devices.json`, `res-pixel` queueing (Lease and `withLock`), and v1.2.46-shape reader tolerance.
- `tools/device/lease.test.mjs`: the `body()` helper also strips `resource`, an intended additive change. No assertion was edited.

**Review findings.** There were 26: high 0, medium 2, low 13, false 11.
- **Patched (7 entries, fc3bd76).**
  - Comment arithmetic (blind and edge).
  - Comment scope for Lease ids.
  - Slug and 28 tests through `parseDevices` and `fleetOf` (blind and verification-gap, medium).
  - CLI words reserved.
  - The queue-test bound and `cwdBefore`.
  - The `withLock` `res-*` route.
- **Deferred (1).** An unseeded `android_extra` phone sits on a bare lock. This predates the story and is medium; it is in the `deferred` frontmatter.
- **Rejected, with reasons in the triage log.**
  - `resourceOf` returns the lock for `res-*`: AD-28 says id = lock.
  - The emulator gate versus Pool-level null: these are different event kinds.
  - The duplicated `may not be` message: a helper would add surface.
  - The `devices.mjs` import of `lock.mjs`: no harm.
  - Role sets versus reserved list: they are not word lists.
  - `job:*` and the shape entries: the AC requires them.
  - The `body()` helper strips `resource`: there is one builder, and it is pinned.
  - `nameRefusal('s24')` for a non-seed caller: there is no such caller yet (residual risk).
  - Stricter devices.json: spaces were already refused, and 28 is AD-28's limit.
  - The `job:x` reason text: no caller branches on it.
  - No CLI or status test for `res-*`: those are Story 5.4 and Epic 6.
  - `SLUG` has one consumer: Story 6.6 is next.
  - Owner `resource` is test-written only: by design.
  - Literal seed map: this is the AC's own mechanism.

**Follow-up review: not recommended (false).** On a first pass, 0 high and 1 medium entry were patched (5 low).

**Verification.**
- `node --test tools/ci/names.test.mjs`: 14/14 pass.
- `node --test tools/device/lease.test.mjs tools/ci/v3.test.mjs tools/ci/events.test.mjs tools/device/claims.test.mjs tools/device/hub-device.test.mjs`: 208/208 pass, with no assertion edited.
- `mise run check`: exit 0, actionlint clean, 748/748 pass.
- I ran a manual probe against real v1.2.46 code (`git archive v1.2.46 tools` into a temp dir). This change wrote Leases on `adb` and `res-pixel` with events carrying `resource`. The old `readEvents`, `listLocks` and `queueView` read them with no error and the same holds, and the old `listLocks` lists `res-pixel`. `leaseHoldersSince` and `liveLease` do not exist at v1.2.46, so they are covered only by the committed v1.2.46-shape fixture.
- Every I/O-matrix row has a covering test that ran and passed.

**Residual risks.**
- `nameRefusal('s24')` is null for any caller. When the Registry store (Story 6.6) calls it for a runtime Resource, it must still refuse a name that collides with the seeded `s24` record. AD-28's uniqueness rule covers this, but it is not in `nameRefusal`.
- An unseeded `android_extra` phone stays on a bare lock (deferred).
- The proof is hermetic plus one local probe of v1.2.46 readers. There was no live host run. The release that ships this is Story 5.10, and no operator action is owed.
