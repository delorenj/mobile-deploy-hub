---
title: 'Edit and retire a Resource'
type: 'feature'
created: '2026-11-25'
status: 'done'
baseline_revision: 'f03fe433043e8708a1b1b6f337226c05f6188b9c'
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-6-context.md'
warnings: ['oversized']
deferred: []
---

<intent-contract>

## Intent

**Problem:** The Hub API can register a Resource (6.6) but cannot rename one, change its Capabilities or retire it. So the Registry drifts from the hardware: a phone that leaves the desk keeps taking Leases (FR-2, AD-28, AD-31).

**Approach:** Add `POST /registry/resources/{id}` (edit) and `POST /registry/resources/{id}/retire`. Following belsky-doctrine, the level one up from "these two routes" is **every Registry write route** (register, edit, retire, and 6.10's register-from-discovery). They share one route helper, `writeThrough`: the missing-file seed, the `if_rev` handling and `updateRegistry`. They also share one actor rule, `checkWho`. `registerResource` moves onto the helper. `tools/registry/changes.mjs` gains `checkEditBody`, `planEdit`, `checkRetireBody` and `planRetire`, and nothing else.

## Boundaries & Constraints

**Always:**
- Edit body keys: `name`, `capabilities`, `if_rev` (**required**: absent is `no-if-rev`, not a whole number is `bad-if-rev`), `actor`, `holder`, `why`. Keys `id`, `lock`, `kind`, `host` and `identity` are allowed through the body check but always refused by the plan (below). Any other key is `bad-body`. If neither `name` nor `capabilities` nor an immutable key is present, the answer is `HUB_USAGE` `no-change`.
- `capabilities` on edit is a merge patch: each key is set to a scalar, or removed by `null`. Key rules are the register's (regex, `FORBIDDEN_CAPABILITIES`); a bad key or value is `bad-capabilities`. Keys the patch does not name are kept, `dedicated_qa` included.
- Edit `name`: `isSlug` and `NAME_MAX` (`HUB_REGISTRY_NAME` 400 `not-slug`/`too-long`). A name different from the record's must pass `reservedBy` (409 `reserved`). It must not equal another record's `name`, `id`, `lock` or `words` entry, retired and seed-missing included (409 `taken`). `display_name` follows `name`.
- Retire body keys: `if_rev` (optional, as in register), `actor`, `holder`, `why`. Anything else is `bad-body`.
- Actor (AD-36), for every write route: a given `actor` is recorded as given; otherwise it is `{holder, via: 'api'}`; neither gives `no-holder`. The body checks run before the name shape, which runs before anything in the queue.
- Planned inside `updateRegistry`'s queue, against the file at commit time, after the `if_rev` check (`HUB_REGISTRY_CONFLICT` with `rev`), in this order:
  1. An unknown id → `HUB_RESOURCE_NOT_FOUND` 404 `unknown`.
  2. A retired or seed-missing record (`retirement() !== null`): an edit → `HUB_RESOURCE_RETIRED` 409, exit 2, `reason` from `retirement()`.
  3. Seeded: retire → `HUB_REGISTRY_SEEDED` 409, exit 2, `reason: retire`. An edit with an immutable key → `HUB_REGISTRY_SEEDED` `reason: <first key>`. A different name → `HUB_REGISTRY_SEEDED` `name`, because AD-28 fixes seeded names and AD-30 overwrites them at each start. Capability edits on a seeded record are allowed and survive a re-seed (AD-30).
  4. Runtime with an immutable key → `HUB_USAGE` 400 `immutable`.
  5. The name rules.
- Retire sets `retired_at = ISO(now)` and changes nothing else. It touches nothing in the lock dir: the Hold stays, and queued waiters are served. Retiring an already-retired record is a no-op that answers 200 with the stored `retired_at`, the unchanged `rev` and no event.
- Events: the store derives them. An edit logs exactly one `registry-edit` (`reason: edit`, `changed` lists key names). A retire logs exactly one `registry-retire` (`reason: retire`). A no-op edit commits and logs nothing and answers the current `rev`. Neither event carries `identity` or an identity value.
- Answers: an edit is 200 with shape `Resource` (`{rev, source: 'file', resource}`, service audience). A retire is 200 with the new shape `Retirement`: `{rev, source: 'file', id, retired_at, visibility}`, where `visibility` is `retiring` (the lock is held or waited on, read via `ctx.lockActivity ?? lockActivity`) or `hidden`.
- `EXIT_CODES` gains `HUB_REGISTRY_SEEDED: 2`. The contract doc gets both route rows (Added 6.7), the `Retirement` shape, both request bodies with their refusal order, and the error rows `HUB_REGISTRY_SEEDED` and `HUB_RESOURCE_RETIRED`. The new `HUB_USAGE` reasons are added, and `HUB_RESOURCE_NOT_FOUND` notes the write routes.

**Never:**
- No change to `updateRegistry`'s contract, `derive`, `reseed`, `readRegistry`, the matcher, `refuseRetired` or `lock.mjs`. Retirement visibility and take refusal already exist (6.3, 6.5); this story only sets `retired_at`.
- No CLI verb or `hub-client.mjs` (6.8), and no un-retire. `retired_at` is never cleared.
- No dependency, Python or timer. Tests bind no port and open no real QA file.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected | Error |
|----------|--------------|----------|-------|
| Rename | `res-pixel` at rev 2; `{if_rev:2, name:'pixel-9', holder:'jarad'}` | 200, rev 3, name `pixel-9`, id and lock still `res-pixel`; one `registry-edit` with `changed` holding `name`, rev 3, actor `{jarad, api}` | — |
| Capability patch | `{if_rev, capabilities:{api_level:36, old:null}}` | `api_level` 36, `old` gone, other keys kept | — |
| Seeded capability | s24 `{if_rev, capabilities:{lab:'a'}}` then `applySeed` | 200; after re-seed `lab` still `'a'` | — |
| No if_rev | edit without it | 400 | `HUB_USAGE` `no-if-rev` |
| Stale rev | `if_rev:1` at rev 2 | 409 `rev: 2`, file unchanged | `HUB_REGISTRY_CONFLICT` |
| Immutable runtime | `{identity:{…}}` or `host` on `res-pixel` | 400 | `HUB_USAGE` `immutable` |
| Seeded identity / name / retire | s24 edit `identity`, s24 `name:'x'`, retire s24 | 409 | `HUB_REGISTRY_SEEDED` `identity` / `name` / `retire`, exit 2 |
| Taken | rename to a retired record's name, or `s26` | 409 | `HUB_REGISTRY_NAME` `taken` |
| Unknown | `/registry/resources/res-nope` (edit or retire) | 404 | `HUB_RESOURCE_NOT_FOUND` `unknown` |
| Edit retired | edit a retired record | 409 | `HUB_RESOURCE_RETIRED` `retired` |
| Retire idle | `res-pixel` idle | 200 `visibility: hidden`, `retired_at` = now; one `registry-retire`; `GET /resources` omits it | — |
| Retire held | Lease on `res-pixel` and a queued waiter | 200 `retiring`; owner and ticket untouched; `claims.resolve('pixel' / 'res-pixel')` → `HUB_RESOURCE_RETIRED`; holder releases, the waiter acquires; after its release, `GET` hides it | — |
| Retire twice | already retired | 200, same `retired_at` and rev, no event | — |
| Re-seed | retired `res-pixel`, then `applySeed` | still in the file with `retired_at`; `registry-retire` still in the log | — |
| Missing file | no `registry.json`; edit s24 caps with `if_rev:0` | seed written (rev 1), edit is rev 2 | `if_rev:3` → conflict at rev 0 |

</intent-contract>

## Code Map

- `tools/registry/changes.mjs`: `checkWho` L57 (generalise its message), `checkCapabilities` L43 (reuse its key and value rule for the patch, where `null` deletes), the `taken` rule L118 (extract `nameTaken(name, resources, exceptId)` and share it with register), `reservedBy`, `retirement`. Add `EDIT_KEYS`, `IMMUTABLE_KEYS = ['id','lock','kind','host','identity']`, `checkEditBody`, `planEdit(current, id, input) → {record, resources, changed: bool}`, `checkRetireBody`, and `planRetire(current, id, input, {now}) → {record, resources}`. Pure; never mutates `current`.
- `tools/hub-api/routes.mjs`: `registerResource` L137 holds the missing-file block (L140-149) to extract as `writeThrough(ctx, {if_rev, reason, actor, why, plan})`. `serve` L90 and `lockActivity` give the retire visibility (import `visibility` from match.mjs). Add `editResource` and `retireResource`, and add both `ROUTES` rows (shapes `Resource` and `Retirement`). `matchPath` already handles `{id}` and the differing segment counts.
- `tools/registry/store.mjs` `updateRegistry` L214: used as is. `derive` L141 already gives `retire` when `retired_at` is newly set, and `edit` otherwise. A no-op returns `changed: false`.
- `tools/registry/seed.mjs` `reseed` L118: never touches a runtime record, and keeps a seeded record's capabilities. Read-only evidence for the re-seed rows.
- `tools/device/claims.mjs` `EXIT_CODES` L40 (add `HUB_REGISTRY_SEEDED: 2`); `claims.test.mjs` L59 freezes the table. `refuseRetired` L166 / `resolve` L254 is the take refusal the retire test drives. `lockActivity` L80.
- `tools/ci/names.test.mjs` L146-163: the pattern for a real `res-pixel` holder plus waiter (`acquireLease` with `pollMs: 5`, `releaseLease`).
- `tools/hub-api/register.test.mjs` `scratch()` L29: the harness to copy (add `hostId`, `NOW`, made-up QA serials).
- `tools/hub-api/contract.test.mjs`: `POST_SAMPLES` L115 and `PARAM_SAMPLES` L112. A sample must be able to name its own setup (register `pixel` first), its params (`id: 'res-pixel'`) and its success status (201 or 200). Rename "answers 201" to "answers its success status". The snake_case loop L203 uses the same samples.
- `docs/hub-api-contract.md`: route table, `### Resource` (edit note), the new `### Retirement`, `## Request bodies`, and `## Error codes`.

## Tasks & Acceptance

**Execution:**
- `tools/registry/changes.mjs` + `changes.test.mjs`: the planners and the shared helpers above. Tests cover every refusal reason and its order, the merge patch, that `current` is not mutated, rename uniqueness against own vs other records, and retire idempotence.
- `tools/device/claims.mjs` + `claims.test.mjs`: `HUB_REGISTRY_SEEDED: 2`.
- `tools/hub-api/routes.mjs`: `writeThrough`, with register moved onto it (register.test.mjs unchanged and green), `editResource`, `retireResource`, and the two rows.
- `tools/hub-api/edit-retire.test.mjs` (new): every matrix row through `handle()`, plus an event walk showing no `registry-edit` or `registry-retire` line carries `identity` or an identity value, and that no response carries a QA serial.
- `tools/hub-api/contract.test.mjs` + `docs/hub-api-contract.md`: as mapped.

**Acceptance Criteria:**
- Given the contract doc and `ROUTES`, when `contract.test.mjs` runs, then both new routes are in the table both ways, and each answers its success status with exactly its shape's field list.
- Given a retired Resource still held, when any caller resolves it by id or name through the Claims library, then it is refused `HUB_RESOURCE_RETIRED` (exit 2), and the Hold and the queued waiter proceed untouched.
- Given `mise run check`, when it runs, then actionlint and the full suite pass.

## Spec Change Log

## Review Triage Log

### 2026-11-25 — Review pass
- verdicts: 23 findings — high 0, medium 0, low 13, false 10, maybe-false 0
- findings:
  - `[false]` `[reject]` (blind) The QA leak-walk test fails early: `res-pixel-qa` is never registered and the `if_rev`s are off. The seed imports `res-pixel-qa` from the injected QA list (resources.test.mjs lists it in the seed). The chain goes rev 2→3→4, `res-pixel-qa` edit to 5, s24 caps to 6, then the two runtime retires. Only the immutable and seeded refusals are meant to fail, so the QA edit and retire events are written and walked.
  - `[low]` `[patch]` (blind) `planEdit` returned an unused `changed` flag, a second definition of "changed" beside the store's diff. Fixed: the field is dropped, and the tests assert the records instead.
  - `[low]` `[patch]` (blind) A seeded record that already has `retired_at` got 409 `HUB_REGISTRY_SEEDED` instead of the documented idempotent retire. Fixed: the already-retired no-op now runs before the seeded refusal, and a test pins it.
  - `[false]` `[reject]` (blind) Retire should require `if_rev`. Retire sets one field and is idempotent, so it cannot lose an update. The spec deliberately keeps `if_rev` optional, as for register.
  - `[low]` `[reject]` (blind) `lockActivity` runs after the commit, so the answered `visibility` can be stale, or a throw could 500 a committed retire. `lockActivity` never throws (claims.mjs L76-85). A momentary race on an informational field is inherent to any read-after-write, and a client re-reads `GET /resources/{id}`.
  - `[low]` `[reject]` (blind) The `resource` member on `HUB_RESOURCE_RETIRED` is not a documented Problem extension, so it is dropped. The id is already in the request path. Documenting it adds public surface no client needs.
  - `[false]` `[reject]` (blind) Stored Pools are not reconciled on retire or capability edit. The stored `phone` Pool lists only seeded ids. Runtime members and the retired exclusion are computed by the matcher on every read (match.mjs L117-128), so nothing in a stored Pool goes stale.
  - `[low]` `[reject]` (blind) The contract test hard-codes `if_rev: 2`. It is test-only brittleness, and a change to the seed or setup order fails loudly with a 409.
  - `[low]` `[patch]` (blind) The documented edit refusal order did not match `checkEditBody` (it checks `bad-why` before `bad-capabilities`). Fixed: the doc order now matches the code.
  - `[false]` `[reject]` (blind) No CLI or bound-server test, and a possible `retire` id collision. The CLI verbs are Story 6.8. The HTTP adapter is route-independent and tested in 6.4. `/registry/resources/retire` is a 3-segment path, so it reaches the edit route with id `retire` (404 `unknown`); it can never collide with the 4-segment retire route.
  - `[low]` `[reject]` (edge) Clearing `dedicated_qa` un-redacts that phone's serial in responses. The operator has to unmark the phone deliberately, and after that it is no longer a QA phone. The data stays on a loopback API, and register already serves the serial of a phone not marked `dedicated_qa`. A guard would add a new refusal reason.
  - `[low]` `[reject]` (edge) A refused edit or retire on a missing file still writes the seed. Carried from 6.6's identical row: the missing file is the seed (AD-27), and the start writes it anyway.
  - `[false]` `[reject]` (edge) `lockActivity` throwing after the commit gives a 500. It never throws (claims.mjs L76-85). Grouped with the blind visibility row.
  - `[low]` `[patch]` (edge) The edit refusal order: `bad-why` came before `bad-capabilities`. Same root cause as the blind order row; fixed there.
  - `[low]` `[patch]` (edge) A seeded record that was already retired is refused rather than answered idempotently. Same root cause as the blind row; fixed there.
  - `[low]` `[reject]` (edge) Stored `capabilities` that are not an object get replaced by `{}`. Only a hand-edited file can reach this, and the fix is a new guard.
  - `[low]` `[reject]` (edge) The `resource` extra on `HUB_RESOURCE_RETIRED` is dropped by `problem()`. Grouped with the blind extension row.
  - `[low]` `[reject]` (edge) `callPost` gives an unhelpful TypeError for a setup path that is not a POST route. It is a test-helper diagnostic only, and the failure still points at the sample.
  - `[low]` `[patch]` (edge, claim) "Retire is idempotent" did not hold for a seeded retired record. Fixed by the same reorder.
  - `[low]` `[patch]` (verification-gap) No test pinned `retiring` for a queued-only lock. Added an `edit-retire.test.mjs` case that injects `lockActivity: () => ({held: false, queued: true})` and asserts `retiring`.
  - `[false]` `[reject]` (intent) Take refusal is asserted only through `resolve()`. Every word take (hub-device, and later the API, through claims) resolves the word first, and `resolve` calls `refuseRetired` before `take` (claims.mjs L254). A runtime Resource has no take path that skips it. 6.3's tests cover the CLI front door.
  - `[false]` `[reject]` (intent) The Hold, the waiter and visibility are observed on the reader and the lock dir, not the lock layer. That is descriptive, not a defect. The test drives real `acquireLease` and `releaseLease`, so the lock layer is exercised.
  - `[false]` `[reject]` (intent) The criteria depend on library code outside the diff. AD-31's refusal and visibility shipped in 6.3 and 6.5, and the spec chose to reuse them. The end-to-end retire test proves they hold for an API-retired Resource.

## Design Notes

- **Immutable keys are refused by presence, not by value.** A body that echoes `host` unchanged is still refused. One rule, with no comparison of identity against a redacted QA view.
- **Capabilities patch rather than replace.** A replace that forgot `dedicated_qa` would silently unmark a QA phone. `if_rev` is still required, because a patch based on a stale read can still collide.
- **Retire answers `Retirement`, not `Resource`.** An idle retired record is hidden: `viewRecord` returns null, and `visibility` never says `hidden` in the `Resource` shape. A new shape keeps that field's meaning unchanged.

## Verification

**Commands:**
- `node --test tools/hub-api/*.test.mjs tools/registry/*.test.mjs tools/device/claims.test.mjs tools/ci/names.test.mjs` -- expected: all pass
- `heavy mise run check` -- expected: actionlint clean, full suite green

## Auto Run Result

Status: done

**Summary.** Jarad (or any agent) can now edit and retire Registry Resources through the Hub API.
- `POST /registry/resources/{id}` takes `if_rev`, which is required. It renames a runtime Resource (`display_name` follows, and `id` and `lock` never change) and patches Capabilities (a scalar sets a key, `null` removes it, and other keys are kept). It answers 200 `Resource` and logs exactly one `registry-edit`. An edit that changes nothing commits and logs nothing.
- `POST /registry/resources/{id}/retire` sets `retired_at` and nothing else, and logs exactly one `registry-retire`. It answers 200 `Retirement` `{rev, source, id, retired_at, visibility}`, where `visibility` is `retiring` (held or waited on) or `hidden`. Retiring again is a no-op.
- The lock dir is never touched. A held Resource keeps its Hold, its queued waiter is served, and new takes by id or name are refused `HUB_RESOURCE_RETIRED` by the Claims library. Once idle it leaves `GET /resources`. A re-seed keeps it retired, and the `registry-retire` stays in the log.

The refusals:
- `HUB_REGISTRY_SEEDED` (409, exit 2), new: a seeded Resource's retire, identity, host, kind, id or lock edit, or rename. Its Capability edits are allowed and survive a re-seed.
- `HUB_USAGE` `immutable`: any of those keys on a runtime Resource.
- `HUB_REGISTRY_NAME` `taken` or `reserved`: a name used by any other record, retired ones included, or a reserved word.
- `HUB_RESOURCE_NOT_FOUND` `unknown`: no Resource with that id.
- `HUB_RESOURCE_RETIRED`: an edit of a retired Resource.

Following belsky-doctrine, the level one up from "these two routes" is **every Registry write route**. It got one write path, `writeThrough` in routes.mjs (the missing-file seed, the `if_rev` rule and `updateRegistry`), and register now runs on it. It also got shared `checkWho` and `nameTaken`, so 6.10's register-from-discovery adds a planner and nothing else.

**Files changed** (after baseline `f03fe433043e8708a1b1b6f337226c05f6188b9c`)
- `tools/registry/changes.mjs`: `IMMUTABLE_KEYS`, `EDIT_KEYS`, `RETIRE_KEYS`, `checkEditBody`, `planEdit`, `checkRetireBody`, `planRetire`, and the shared `nameTaken`. `checkWho` is now exported, and the capability check gained a patch mode.
- `tools/registry/changes.test.mjs`: every edit and retire refusal and its order, the merge patch, no mutation, rename uniqueness, and retire idempotence (seeded-retired included).
- `tools/hub-api/routes.mjs`: `writeThrough`, with register moved onto it, plus `editResource`, `retireResource` and the two `ROUTES` rows.
- `tools/hub-api/edit-retire.test.mjs` (new): every I/O-matrix row through `handle()`. That includes a real `acquireLease` holder and waiter on `res-pixel`, the queued-only `retiring` case, and the identity-free event walk with the QA-serial walk over responses.
- `tools/hub-api/contract.test.mjs`: POST samples carry `status`, `params` and `setup`, and each POST route must answer its own success status with exactly its shape.
- `tools/device/claims.mjs`, `claims.test.mjs`: `HUB_REGISTRY_SEEDED: 2`.
- `docs/hub-api-contract.md`: two route rows, the edit note on `Resource`, the `Retirement` shape, both request bodies with their refusal order, and the error rows (`HUB_RESOURCE_RETIRED`, `HUB_REGISTRY_SEEDED`, the new `HUB_USAGE` reasons).

**Review findings.** 23 findings: high 0, medium 0, low 13, false 10, maybe-false 0.
- **Patched (4 entries, all low):**
  - `planEdit`'s unused `changed` flag is dropped.
  - A retire of an already-retired seeded record is now the idempotent no-op.
  - The documented edit refusal order now matches the code (`bad-why` before `bad-capabilities`).
  - A new test pins `retiring` for a lock that is only waited on.
- **Deferred:** none.
- **Rejected, false (10):** the QA walk failing early, required `if_rev` on retire, stored Pools going stale, no CLI or bound-server test (6.8 and 6.4), the `lockActivity` throw, and three intent rows that were descriptive (take refusal through `resolve`, reader-side observation, reuse of library code).
- **Rejected, low (9),** each with its reason in the triage log: stale `visibility` race, the undocumented `resource` member (two rows), hard-coded `if_rev` in the contract test, clearing `dedicated_qa` un-redacting a serial, the seed written on a refused request (carried from 6.6), non-object stored capabilities, and the `callPost` diagnostic.

**Follow-up review recommended: false.** This was the first pass, and only low entries were patched: high 0, medium 0, low 4.

**Verification**
- `node --test tools/hub-api/*.test.mjs tools/registry/*.test.mjs tools/device/claims.test.mjs tools/ci/names.test.mjs`: 250/250 pass.
- `heavy mise run check`: exit 0, actionlint clean, 1126/1126 tests pass.
- Matrix audit: the following rows are covered in `edit-retire.test.mjs` (plus `changes.test.mjs` for the planner refusals), and all those tests ran and passed:
  - Rename, Capability patch, Seeded capability (with a real re-seed)
  - No if_rev, Stale rev, Immutable runtime, Seeded identity/name/retire
  - Taken, Unknown, Edit retired
  - Retire idle, Retire held (real holder and waiter), Retire twice
  - Re-seed, Missing file
  
  The one discrepancy is in the Taken row. Renaming to a retired record's name gives `taken`, as the matrix says. Renaming to `s26` gives 409 `HUB_REGISTRY_NAME` with `reason: reserved`, because `s26` is in lock.mjs's `RESERVED` CLI words (AD-28), and the reserved check runs before the taken check, the same order register documents. The code and the test follow that established order; the matrix's `taken` for `s26` was imprecise.

**Residual risks**
- With no `registry.json` (a failed start seed), a refused edit or retire still writes the seed first, as register does.
- Clearing `dedicated_qa` on a QA-imported phone makes its serial servable from then on. That is a deliberate operator action on a loopback API.
- A `--match` query never offers a retired Resource. It answers `HUB_NO_MATCH` ("is retired") rather than `HUB_RESOURCE_RETIRED`. This is the matcher's existing behaviour, unchanged here.
- No operator actions are owed: every acceptance criterion is in-repo.
