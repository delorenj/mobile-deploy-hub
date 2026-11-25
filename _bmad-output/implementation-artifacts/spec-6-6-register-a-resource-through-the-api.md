---
title: 'Register a Resource through the API'
type: 'feature'
created: '2026-11-25'
status: 'done'
baseline_revision: '694fbcb7fc363782a1d587d1f3b7fe7589e2602d'
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-6-context.md'
warnings: ['oversized']
deferred: []
---

<intent-contract>

## Intent

**Problem:** The Hub API (6.4, 6.5) only reads the Registry. Jarad cannot register a new phone (a Pixel) without a hub release, so agents cannot use it (FR-1, UJ-3, AD-27, AD-28).

**Approach:** Add `POST /registry/resources`. Following belsky-doctrine, the level above "the register route" is **every Registry write route**: register now, edit and retire in 6.7, register-from-discovery in 6.10. So this story builds the shared parts once:
- a transactional store primitive `updateRegistry` (read, `if_rev` check, change and commit, all inside the store's one per-path queue);
- a pure planner module `tools/registry/changes.mjs` (body validation, name rules, id minting, the duplicate-identity check);
- Problem extension fields (`rev` on a conflict, `holder` on a duplicate), declared once in a table that the contract doc and test check.

6.7 then adds `planEdit` and `planRetire` and nothing else.

## Boundaries & Constraints

**Always:**
- Body: a JSON object with exactly these keys allowed: `kind` (required: `phone` or `ios-lane`), `name` (required), `host` (required: a key of claims `HOST_PLATFORMS`; an `ios-lane` must be on a `darwin` host), `identity` (an object, optional for `ios-lane`), `capabilities` (optional, default `{}`), `if_rev`, `actor`, `holder`, `why`. Any other key → 400 `HUB_USAGE` `reason: bad-body`.
- `identity` keys are only `serial`, `model`, `udid` and `profile`, each a non-empty string (`bad-identity`). A `phone` needs `identity.model` (`reason: no-model`).
- `capabilities` is a flat object. Keys match `^[a-z][a-z0-9_]*$`. A key may not be `allowed_users` or a matcher intrinsic (`id`, `name`, `kind`, `host`, `model`, `deploy_target`). Values are a string, a finite number or a boolean (`bad-capabilities`).
- The other field rules: `if_rev` is a whole number when present (`bad-if-rev`); `why` is a string when present (`bad-why`); `actor` must pass `checkActor` (`bad-actor`).
- Actor (AD-36): a present `actor` is recorded exactly as given. An absent one becomes `{holder: body.holder, via: 'api'}`, set once. No `actor` and no non-empty `holder` → `reason: no-holder`.
- Name: it must pass `isSlug`, at most `NAME_MAX` characters (`HUB_REGISTRY_NAME` 400 `not-slug` / `too-long`). It must not match `reservedBy` (409 `reserved`; the runtime check has no seeded exemption). It must not equal any record's `name`, `id`, `lock` or `words` entry, retired and seed-missing included (409 `taken`). Exit 2.
- Mint: `id = lock = res-<name>`. If any record (retired included) uses that string as an id or lock, the id is `res-<name>-<n>` with the smallest free `n >= 2`. If `n > 999`, refuse `HUB_REGISTRY_NAME` 409 `exhausted`.
- Duplicate identity: a `serial` or `udid` equal to one held by a live record (`retirement(record) === null`) → `HUB_REGISTRY_DUPLICATE` 409, exit 2, `reason: serial|udid`, extension `holder: <that record's id>`. The detail never echoes the serial or UDID.
- New record: `{id, lock, name, words: [], display_name: name, kind, host, identity (or null), capabilities, deploy_target: false, seeded: false, created_at: ISO(now)}`. It is appended last.
- The name, mint and duplicate checks run inside the store's per-path queue, against the file as it is at commit time. With `if_rev` present and not equal to the file's rev → `HUB_REGISTRY_CONFLICT` 409, extension `rev` = current. With it absent, no rev check.
- A missing file is the seed (AD-27). Before planning, the route runs `applySeed` with the same inputs as at start (`ctx.devices`, `ctx.qaDevices`, actor `{holder: 'hub-api', via: 'api'}`), so the seed and the register are separate, honest events. A client `if_rev` other than `0` on a missing file is a conflict at rev 0. An `if_rev` of `0` is accepted, because the seed materialises what the client read.
- The write goes through `updateRegistry` with `reason: 'register'`, `actor` and `why`. Exactly one `registry-add` is logged, carrying the new `rev`.
- Answer: 201 `{rev, source: 'file', resource}`, where `resource` is `viewRecord(record, {audience: 'service'})`: the `Resource` shape, with QA redaction.
- `problem()` merges the extension fields that `PROBLEM_EXTENSIONS[code]` lists (exported from routes.mjs) when the error carries them, and never overwrites a base field. `docs/hub-api-contract.md` gets a `## Problem extensions` table that the contract test holds equal to `PROBLEM_EXTENSIONS`, both ways.

**Never:**
- No edit, retire or discovery route, no `hub-client.mjs` and no CLI verb (6.7, 6.8, 6.10).
- No change to `noteRegistry`, the seed derivation, `readRegistry` or the matcher.
- No new dependency, no Python, no timer.
- No `identity` key and no identity value (serial, UDID, model) in any `registry-add` line.
- No QA serial in any response. Tests bind no port and open no real QA file.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Register | seeded file rev 1; `{kind:'phone', name:'pixel', host:'linux', identity:{serial:'PX9', model:'Pixel 9'}, capabilities:{api_level:35}, holder:'jarad'}` | 201, `rev: 2`, `resource.id === resource.lock === 'res-pixel'`, `seeded:false`, `visibility:'visible'`; one `registry-add` with `resource/lock: res-pixel`, `rev: 2`, `reason: register`, `actor: {holder:'jarad', via:'api'}` | — |
| Mint suffix | a record already has id `res-pixel` (renamed, or retired) | new id `res-pixel-2`; next free after that is `-3` | — |
| No model | phone without `identity.model` | 400 | `HUB_USAGE` exit 2 `no-model` |
| Duplicate | serial of live `s24` | 409, `holder: 's24'` | `HUB_REGISTRY_DUPLICATE` exit 2 `serial` |
| Retired identity | serial of a retired record | 201, new Resource | — |
| Reserved | `name: 'phone'`, `'s24'`, `'res-x'` | 409 | `HUB_REGISTRY_NAME` exit 2 `reserved` |
| Taken | name of a retired record | 409 | `HUB_REGISTRY_NAME` exit 2 `taken` |
| Not slug | `'Pixel 9'`, 29 chars | 400 | `HUB_REGISTRY_NAME` exit 2 `not-slug` / `too-long` |
| Stale rev | `if_rev: 0` on file rev 1 | 409, `rev: 1`, file unchanged | `HUB_REGISTRY_CONFLICT` exit 1 |
| Rev race | two registers, same `if_rev`, concurrent | one 201, one 409 with the winner's `rev` | `HUB_REGISTRY_CONFLICT` |
| Name race | two registers `name:'pixel'`, no `if_rev`, concurrent | one 201, one 409 `taken` | `HUB_REGISTRY_NAME` |
| Actor given | `actor:{holder:'jarad', via:'control-surface'}` | event `actor` equal to it | — |
| No holder | no `actor`, no `holder` | 400 | `HUB_USAGE` exit 2 `no-holder` |
| Missing file | no `registry.json` | the seed is written (rev 1, `reason: seed`), then the register (rev 2) | `if_rev: 3` → conflict at rev 0 |
| Unreadable file | bad JSON | 409, bytes unchanged | `HUB_REGISTRY_FORMAT` exit 1 |
| QA mark | `capabilities:{dedicated_qa:true}` | response `identity.serial: null`; the file keeps the serial | — |
| Bad body | unknown key, bad capability value, `allowed_users`, intrinsic key | 400 | `HUB_USAGE` with the matching reason |

</intent-contract>

## Code Map

- `tools/registry/store.mjs` -- `writeRegistry` L188 does the validation, then `serialised()` L170, load, `afterRead`, the `if_rev` check, the drop/lock guards, `derive` and the commit. Split it: `updateRegistry({env, if_rev?, change, reason, actor, why, afterRead, now, hostId, log})` runs `change({rev, resources, pools (array), state})` inside the queue. `change` returns `{resources, pools}` or throws. `writeRegistry` becomes `updateRegistry` with `if_rev` required and a constant change, and keeps its TypeErrors and every store.test.mjs row. `REGISTRY_ERRORS` L22 puts `rev` on a conflict.
- `tools/registry/changes.mjs` (new, pure: imports only `lock.mjs` names and `match.mjs` `retirement`) -- `REGISTER_KINDS`, `checkRegisterBody(body, {hosts})` → normalised input `{kind, name, host, identity, capabilities, if_rev, actor, why}` or a coded error, and `planRegister(current, input, {now})` → `{record, resources}`.
- `tools/ci/lib/lock.mjs` L36-76 -- `isSlug`, `NAME_MAX`, `reservedBy` and `checkActor` L195, all reused. `nameRefusal` L70 exempts seeded words, so the runtime path uses `reservedBy` directly.
- `tools/registry/match.mjs` L71 -- `retirement()`, the one live/retired rule.
- `tools/registry/view.mjs` -- `viewRecord` for the answer.
- `tools/device/claims.mjs` L40 -- `EXIT_CODES` (add `HUB_REGISTRY_NAME: 2` and `HUB_REGISTRY_DUPLICATE: 2`; `claims.test.mjs` L59 freezes the table). `HOST_PLATFORMS` L90 is the host-key vocabulary.
- `tools/hub-api/routes.mjs` -- `reply` L27 (201), `problem` L36 (extensions), `ROUTES` L106 (add `POST /registry/resources`, shape `Resource`). Handler `(ctx, {body})`.
- `tools/hub-api/server.mjs` `startHubApi` L141 -- add `hostId` to the route ctx, so a route's events are stamped like the start's.
- `tools/hub-api/contract.test.mjs` -- the GET loop L144 and the snake_case loop L185 skip POST. Add `POST_SAMPLES` (path → body; a POST route with no sample fails), the 201 and field-list check, and the parse and compare of the `Problem extensions` table with live conflict and duplicate answers (fields = Problem ∪ extras).
- `tools/hub-api/resources.test.mjs` `scratch()` L26 -- the harness pattern to copy (temp env, `NOW`, made-up QA serials, `hold`, `queue`).
- `docs/hub-api-contract.md` -- route row (Added 6.6), the 201 note, the request body section, the error rows (`HUB_REGISTRY_NAME`, `HUB_REGISTRY_DUPLICATE`, `HUB_REGISTRY_CONFLICT`, `HUB_REGISTRY_FORMAT`; `HUB_USAGE` gains the body reasons) and the extensions table.

## Tasks & Acceptance

**Execution:**
- `tools/registry/store.mjs` + `store.test.mjs` -- `updateRegistry` as mapped. New tests: the absent-`if_rev` path; a `change` that throws commits nothing; `change` sees the committed file of a write queued before it.
- `tools/registry/changes.mjs` + `changes.test.mjs` (new) -- validation reasons, name rules, minting (including `-2`, `-3` and a retired holder), the duplicate check against live records only, the record shape, no mutation of `current`.
- `tools/device/claims.mjs` + `claims.test.mjs` -- the two exit codes.
- `tools/hub-api/routes.mjs` -- `PROBLEM_EXTENSIONS`, `problem()` merge, the `registerResource` handler (seed-on-missing, `updateRegistry`, 201) and the row.
- `tools/hub-api/server.mjs` -- `hostId` in ctx.
- `tools/hub-api/register.test.mjs` (new) -- every matrix row through `handle()`. Also: a walk proving that no `registry-add` line has an `identity` key or any identity value, and that no response carries the QA serial.
- `tools/hub-api/contract.test.mjs` + `docs/hub-api-contract.md` -- as mapped.

**Acceptance Criteria:**
- Given the contract doc and `ROUTES`, when `contract.test.mjs` runs, then `POST /registry/resources` answers 201 with exactly the `Resource` field list, and every documented Problem extension equals `PROBLEM_EXTENSIONS` and appears on the live answer.
- Given `mise run check`, when it runs, then actionlint and the full suite pass.

## Spec Change Log

## Review Triage Log

### 2026-11-25 — Review pass
- verdicts: 31 findings — high 0, medium 0, low 21, false 10, maybe-false 0
- findings:
  - `[low]` `[patch]` (blind) The documented refusal order (all `HUB_USAGE` before `HUB_REGISTRY_NAME` 400) did not match `checkRegisterBody`, which checked the name right after `kind`. Fixed: the name checks now run after the actor check, so a bad name plus a bad host answers `bad-host`.
  - `[low]` `[reject]` (blind) A register refused by the planner on a missing file still writes the seed. The missing file *is* the seed (AD-27), so materialising it changes no Resource a reader sees, and the start writes it anyway. A missing file at register time needs a failed start seed. Planning against the would-be seed first would add a branch.
  - `[low]` `[reject]` (blind) `holder` on `HUB_REGISTRY_DUPLICATE` confirms which Resource has a guessed serial. The AC requires "refused with the holder's id". The API is loopback only, the caller already holds the serial, and ids are not secret.
  - `[low]` `[reject]` (blind) The 201 has no `Location` header. Nothing asks for one; the body carries `resource.id`, and a header would be new public surface.
  - `[low]` `[reject]` (blind) Caller strings have no length or count limits, and serial or UDID case and whitespace are not normalised. The 1 MiB body cap bounds size, and adb serials are case-sensitive. A single operator registering a phone by hand is unlikely to meet this, and fixing it adds guards.
  - `[low]` `[reject]` (blind) The race handling is not atomic and under-tested (two `registryState` reads, `seeded.first`, retry exhaustion, concurrent `if_rev: 0` on a missing file). `applySeed` always returns `first`. A file is never deleted under the service, so the two reads cannot go from ok to missing. The other two cases need concurrent registers on a missing file, which needs a failed start seed.
  - `[false]` `[reject]` (blind) The extensions contract test is hard-wired to the first POST route. `ROUTES.find(POST)` stays the register route when 6.7 appends routes, and the "every extension code has a live answer" assert failing on a new extension code is the intended forcing function.
  - `[false]` `[reject]` (blind) Name errors split from `HUB_USAGE` buys nothing. This is the spec's chosen contract: a name refusal is its own code with `reason`, documented in both statuses, and the AC asks for exit 2 with a machine-readable reason, which both give.
  - `[low]` `[reject]` (blind) `updateRegistry` awaits `change` with no timeout. Every `change` is an in-process pure planner. A hanging planner is hypothetical, and a timeout is a new clock that the no-new-clock rule forbids here.
  - `[low]` `[patch]` (blind) Contract gaps: idempotency, `Content-Type`, a worked example, and seed-missing identity. Fixed the real gap: the doc now says a retired *or seed-missing* Resource's identity is free. Idempotency and an example are new surface, a retry is answered by the documented `taken` refusal, and the server does not require `Content-Type`, so documenting one would be wrong.
  - `[false]` `[reject]` (blind) Test gaps (413 on this route, profile/udid stored, `dedicated_qa` and `allowed_users`, seed-missing duplicate). The 413 is the route-independent adapter (6.4 tests). Identity is copied whole (`changes.test` asserts the record). A register never stores `allowed_users` (refused key). Seed-missing duplicate and name cases are in `changes.test.mjs`.
  - `[low]` `[reject]` (edge) Concurrent registers on a missing file give the `if_rev: 0` loser a 409. This needs a failed start seed plus a concurrent register. The 409 is a correct "re-read" signal, and tracking who seeded adds state. Grouped with the blind race row.
  - `[low]` `[reject]` (edge) Seed retry exhaustion after 3 conflicts. This needs three consecutive interleaved writers on a missing file. Grouped with the blind race row.
  - `[false]` `[reject]` (edge) The two `registryState` reads can disagree. The only possible change is missing to ok: then the first read already refused a non-zero `if_rev`, or the second skips the seed and `updateRegistry` checks `if_rev` against the real file. No path uses an inconsistent snapshot.
  - `[low]` `[reject]` (edge) A refused register still writes the seed. Grouped with the blind seed row.
  - `[low]` `[patch]` (edge) Bad name wins over a later `HUB_USAGE` field. Same root cause as the blind order row; fixed there.
  - `[low]` `[reject]` (edge) Long identity, capability and why values bloat the file and log. Grouped with the blind limits row.
  - `[low]` `[reject]` (edge) A serial differing only by case or whitespace is not a duplicate. Grouped with the blind limits row.
  - `[low]` `[reject]` (edge) An `ios-lane` with `identity: {}` stores `{}` rather than `null`. `viewRecord` serves both as an object and the matcher reads neither. An operator is unlikely to send `{}`, and the fix is a new branch.
  - `[low]` `[patch]` (edge) `writeRegistry` copied the caller's arrays only inside the queue, so a later mutation leaked into the commit. Fixed: `writeRegistry` keeps `normalise`'s call-time copies, and its `change` returns those.
  - `[low]` `[reject]` (edge) `mint` ignores a leftover `res-<name>` lock dir with no record. Ids are never reused and records are never deleted. Only a hand-deleted `registry.json` could leave one, and checking the lock dir means I/O in a pure planner.
  - `[low]` `[patch]` (verification-gap) The documented 409 precedence (conflict, then name, then duplicate) was unpinned. Added a `register.test.mjs` test: bad name plus bad host is `bad-host`; stale `if_rev` plus taken name plus s24's serial is `HUB_REGISTRY_CONFLICT`; taken name plus s24's serial is `HUB_REGISTRY_NAME` `taken`; the file bytes are unchanged.
  - `[low]` `[reject]` (verification-gap other) No test drives the register through `startHubApi` with the real `ROUTES` and `hostId`. Dropping `hostId` changes only the event's `host_id`, which production does not inject (it defaults to `machineId()`). 6.5's server test already proves the ctx wiring path.
  - `[low]` `[reject]` (verification-gap other) Concurrent `if_rev: 0` registers on a missing file are untested. Grouped with the blind race row.
  - `[false]` `[reject]` (intent) No CLI or Holocene front door. "Through the API" is 6.6's surface; `hub-device registry add` is Story 6.8 and the page is v1c.
  - `[false]` `[reject]` (intent) An absent actor with no `holder` is a 400 rather than an API-derived holder. AD-36: "`holder`, `why` and the claimant kind come from the caller and are recorded as given". The API has no caller identity of its own on loopback (NFR-6).
  - `[false]` `[reject]` (intent) The registered Resource is not leased in a test. "Leasable within a minute" is Story 6.9's own AC; this story's ACs end at the record, the event and the `rev`.
  - `[low]` `[reject]` (intent) The live service's ctx is not exercised for the new route. Grouped with the verification-gap `startHubApi` row.
  - `[false]` `[reject]` (intent) Name collisions are wider than the AC text (ids, locks, words). AD-28: resolution tries an id first, then a name, so a name equal to any id or word would be shadowed. "Collides with an existing record" covers them.
  - `[false]` `[reject]` (intent) Details pinned beyond the AC (ios-lane on mac, `exhausted`, capability rules). Descriptive, not a defect: each is a documented refusal derived from AD-28 and the spine's record shape.
  - `[false]` `[reject]` (intent) The spec file is staged outside the diff. It is the claims file, committed at finalize by design.

## Design Notes

- **`if_rev` is optional on register.** An add cannot lose an update: its name, mint and duplicate checks run under the store's queue against the file as committed. `if_rev` still guards a client that wants "only if nothing changed since I read" (the AC's stale case). 6.7's edit makes it required.
- **Problem extensions, not new Problem fields.** The base `Problem` list stays exact for every error. A code adds named members only (`rev`, `holder`; AD-37's later `{repo, run, job}` adds rows), and the table keeps code and doc equal.
- **`changed` names keys, never values.** A `registry-add` line's `changed` lists top-level key names (`identity` among them, as 6.2 decided). The test checks that the line has no `identity` key and none of the identity values.
- **Seed-missing counts as retired** for the duplicate check (`retirement()`), so a phone dropped from devices.json can be registered at runtime.

## Verification

**Commands:**
- `node --test tools/hub-api/*.test.mjs tools/registry/*.test.mjs tools/device/claims.test.mjs` -- expected: all pass
- `heavy mise run check` -- expected: actionlint clean, full suite green

## Auto Run Result

Status: done

**Summary.** Jarad (or any agent) can now register a phone with no hub release. `POST /registry/resources` with `{kind, name, host, identity, capabilities, holder}` answers 201 `{rev, source: 'file', resource}`. The Resource gets `id = lock = res-<name>`, or `res-<name>-<n>` (the smallest free `n >= 2`; any record, retired included, blocks an id). Exactly one `registry-add` is logged at the new `rev`, and it never carries an identity.

The refusals:
- A phone without `identity.model` → `HUB_USAGE` `no-model`.
- A serial or UDID that a live Resource has → `HUB_REGISTRY_DUPLICATE` 409, exit 2, member `holder`. A retired or seed-missing identity is free.
- A reserved, taken (retired included) or non-slug name → `HUB_REGISTRY_NAME`, exit 2, with `reason`.
- A stale `if_rev` → `HUB_REGISTRY_CONFLICT` with member `rev`.

The actor is `{holder, via: 'api'}` unless the body carries one, which is recorded as given. A missing file is first written as the seed (its own `seed` events), then the register.

Following belsky-doctrine, the level above "the register route" is **every Registry write route**, and it got three shared pieces:
- `updateRegistry`, the one transactional store write. It reads, checks `if_rev`, runs `change` and commits, all inside the per-path queue. `writeRegistry` is now a wrapper around it.
- `tools/registry/changes.mjs`, the pure planners (`checkRegisterBody`, `planRegister`).
- Problem extensions (`PROBLEM_EXTENSIONS`, held equal to the contract doc's table).

6.7 adds only `planEdit` and `planRetire`, and 6.10's discover-and-register reuses the same planner.

**Files changed** (after baseline `694fbcb7fc363782a1d587d1f3b7fe7589e2602d`; commits `99bd3280d064617ceafe0ca69ab9b8fd35dab6c6`, `ba61727fa5a58aaaa92d7846be64a06fe87509bb`)
- `tools/registry/store.mjs`: `updateRegistry` (optional `if_rev`, `change` inside the queue); `writeRegistry` wraps it and copies at call time.
- `tools/registry/changes.mjs` (new): `REGISTER_KINDS`, `IDENTITY_KEYS`, `FORBIDDEN_CAPABILITIES`, `checkRegisterBody`, `planRegister` (name rules, minting, duplicate check).
- `tools/registry/changes.test.mjs` (new): normalisation, every refusal, record shape, minting, names, duplicates.
- `tools/registry/store.test.mjs`: `updateRegistry` without `if_rev`, conflict, throwing change, queued change sees the prior commit.
- `tools/hub-api/routes.mjs`: `PROBLEM_EXTENSIONS` merged by `problem()`; the `registerResource` handler (seeds only a missing file); the `POST /registry/resources` row.
- `tools/hub-api/server.mjs`: `hostId` in the route ctx.
- `tools/hub-api/register.test.mjs` (new): every I/O-matrix row, the refusal order with several faults, the identity-free event walk, the QA serial walk over responses.
- `tools/hub-api/contract.test.mjs`: `POST_SAMPLES`, the 201 field-list check, the Problem extensions table checked both ways against live answers.
- `tools/device/claims.mjs`, `claims.test.mjs`: `HUB_REGISTRY_NAME: 2`, `HUB_REGISTRY_DUPLICATE: 2`.
- `docs/hub-api-contract.md`: the route row, the 201 note, the request body section with the refusal order, the error rows, the Problem extensions table.

**Review findings.** 31 findings: high 0, medium 0, low 21, false 10, maybe-false 0.
- **Patched (4 entries, all low).**
  - The documented refusal order is now the code's: every `HUB_USAGE` check comes before the name shape.
  - A test pins the 409 precedence: conflict, then taken, then duplicate.
  - `writeRegistry` copies its input at call time again.
  - The doc now says a seed-missing identity is free.
  - Separately, during verification I made the route seed only when the file is missing. The implementation had re-seeded on every register.
- **Deferred:** none.
- **Rejected:** 10 false findings: hard-wired extensions test, the split name code, test gaps already covered, the two `registryState` reads, no CLI front door (6.8), holder from the caller (AD-36), no lease test (6.9), wider name collisions (AD-28), extra pinned details, and the spec outside the diff. 17 low findings, each with its reason in the triage log: seed written on a refused register, the `holder` oracle (AC-mandated), no `Location`, no string limits or case folding, missing-file race and retry exhaustion, change timeout, `ios-lane` `{}` identity, orphan lock dirs, and server-level wiring of `hostId`.

**Follow-up review recommended: false.** This was the first pass. No high or medium entry was patched; the patched counts are high 0, medium 0, low 4.

**Verification**
- `node --test tools/hub-api/*.test.mjs tools/registry/*.test.mjs tools/device/claims.test.mjs`: 203/203 pass.
- `heavy mise run check`: exit 0, actionlint clean, 1093/1093 tests pass.
- Matrix audit: every row (Register, Mint suffix, No model, Duplicate, Retired identity, Reserved, Taken, Not slug, Stale rev, Rev race, Name race, Actor given, No holder, Missing file, Unreadable file, QA mark, Bad body) is covered in `tools/hub-api/register.test.mjs`, and all of those tests ran and passed.

**Residual risks**
- With no `registry.json` (a failed start seed), concurrent registers can give an `if_rev: 0` caller a 409, and a refused register still materialises the seed.
- Serial and UDID comparison is exact; case or whitespace variants of the same device are not caught.
- Nothing starts the service in production until 6.11 and 6.12. A registered phone being leasable end to end is Story 6.9's test.
- No operator actions are owed: every acceptance criterion is in-repo.
