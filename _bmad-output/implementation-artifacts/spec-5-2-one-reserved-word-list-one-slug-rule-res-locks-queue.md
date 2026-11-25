---
title: 'One reserved-word list, one slug rule, res-* locks queue'
type: 'feature'
created: '2026-11-24'
status: 'in-progress'
baseline_revision: 'f5bf6d1c9372cc611da339c46ccec9d3a7c33d8b'
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-5-context.md'
warnings: ['oversized']
deferred: []
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
