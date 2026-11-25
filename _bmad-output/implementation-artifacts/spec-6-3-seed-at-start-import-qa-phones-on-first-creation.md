---
title: 'Seed at start, import QA phones on first creation'
type: 'feature'
created: '2026-11-25'
status: 'done'
baseline_revision: '0a7223f9a4f883b5ef17e2be12ae315de87bdaf4'
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-6-context.md'
warnings: ['oversized']
deferred: []
---

<intent-contract>

## Intent

**Problem:** Story 6.2 gave `registry.json` one safe writer. Nothing yet fills it from `devices.json`, and no rule keeps an operator's Capability edits, a retirement or a hand-registered Resource safe across a re-seed (FR-3, AD-30, AD-31). The QA phones also need importing exactly once. Separately, a Resource that has dropped out of `devices.json` (`seed_missing`) or been retired can still be taken by its word, because the Claims library never checks the Registry before a take.

**Approach:** Add a pure `reseed(current, devices, opts)` to `seed.mjs` that merges the derived seed into the file's records, and an `applySeed` in `store.mjs` that does at most one `writeRegistry` at the file's `if_rev`. `applySeed` is the AC's `seed.apply`; it lives in the store so `seed.mjs` stays pure and the two files do not import each other. The Claims library also gains one take refusal, `HUB_RESOURCE_RETIRED` (exit 2, reason `retired`|`seed-missing`), with one pure `retirement`/`visibility` rule in `match.mjs`.

Following belsky-doctrine, the level above "the start" is every Registry reader and every front door. Story 6.4's start calls `applySeed`, `hub-device` refuses now, and 6.5/6.7/6.8/6.9 reuse the same refusal and visibility rule.

## Boundaries & Constraints

**Always:**
- Seeded record (`seeded: true`) present in the derived seed: every seed-declared field (`lock`, `name`, `words`, `display_name`, `kind`, `host`, `identity`, `deploy_target`, `seeded`) comes from the seed. `capabilities`, `created_at`, `retired_at` and any other key the file carries are kept, and `seed_missing` is removed.
- Seeded record absent from the derived seed: kept unchanged except `seed_missing: true`. It is never deleted.
- Runtime records (`seeded: false`) are never touched. `retired_at` is never set or cleared by a seed.
- A new record gets `created_at` (ISO, from the `now` seam).
- Pools: each derived Pool overwrites its own keys, other keys and other Pools are kept (`emulator.size`, for example).
- The QA loader runs only when `registry.json` is missing (first creation). With an existing file it is never called. `allowed_users` never reaches the file or an event.
- `applySeed` returns `{first, rev, changed, events, warnings}` and writes through `writeRegistry` (reason `seed`) only. A no-op re-seed writes and logs nothing.
- `HUB_RESOURCE_RETIRED`: status 409, exit 2, `reason`, `resource`. The CLI prints `HUB_RESOURCE_RETIRED <word> <message>` on stderr and exits 2.

**Never:**
- No Hub API, route, `/health` or start wiring (6.4), no register/edit/retire verbs (6.6-6.8), no status or registry-list rendering of visibility (6.5/6.8/6.9).
- `lock.mjs` never reads `registry.json`, and the deploy path never imports `tools/registry/*`.
- No QA serial in a committed file, a `registry-*` event or a warning. No new dependency, no timers, no Python.
- Existing CLI output, exit codes and `--json` shapes stay unchanged when there is no `registry.json` (AD-17).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| First creation | no file; QA file names the S24 and an unknown `Pixel QA` | rev 1. s24 `capabilities.dedicated_qa: true`. `res-pixel-qa` `seeded: false` with its serial, `dedicated_qa`. Every record has `created_at`. One `registry-add` per record. QA loader called once. | — |
| Re-seed, nothing changed | file from the run above | loader not called, no write, no event, `changed: false` | — |
| Capability edit kept | file s24 has `api_level: 34` and `dedicated_qa` | both kept after re-seed; no event | — |
| Identity drift | devices.json gives s26 a new model | one `registry-edit` for s26, `changed: ['identity']`; capabilities kept | — |
| Seeded phone dropped | devices.json loses `android_extra` | s24 kept with `seed_missing: true`; one `registry-edit` `changed: ['seed_missing']`; `pools.phone` members `[s26]` | — |
| Seeded phone returns | devices.json has S24 again | `seed_missing` removed; one `registry-edit` | — |
| New seeded phone | devices.json adds `Pixel` to `android_extra` | `registry-add` for `pixel` with `created_at` | — |
| Retired kept | file record has `retired_at` | still set after re-seed | — |
| Runtime record | file has `res-foo` (seeded: false) | untouched | — |
| Name clash | runtime `res-x` named `pixel`, seed adds id `pixel` | seeded record added; one warning names both ids (resolution is id-first) | — |
| Unreadable file | garbage `registry.json` | file bytes unchanged; loader not called | `HUB_REGISTRY_FORMAT` |
| Broken QA file at first creation | QA loader throws `HUB_QA_DEVICES` | nothing written (the one import is not lost) | rethrown |
| Take a seed-missing word | registry file s24 `seed_missing`; `hub-device lease s24` | exit 2, nothing held, no event | `HUB_RESOURCE_RETIRED` `reason: seed-missing` |
| Take a word gone from the fleet | devices.json lacks s24, file has s24 `seed_missing` | exit 2 instead of "unknown device" | `HUB_RESOURCE_RETIRED` |
| `phone` with a seed-missing member | file s24 `seed_missing`, `lease phone` | s24 skipped, s26 taken | all members out → `HUB_RESOURCE_RETIRED` |
| No file | today's state | every take as before | — |

</intent-contract>

## Code Map

- `tools/registry/seed.mjs` -- `seed(devices, {qaDevices})` L54. It derives records without `created_at` (`record()` L45), runtime QA records `res-<slug>` L84-93, and pools `{phone: {members, named}, emulator: {gate}}` L99. Add a pure `reseed` here. The header (L1-7) says pure: keep it pure.
- `tools/registry/store.mjs` -- private `loadFile` L52 (`missing|unreadable|ok`, pools as array) and `writeRegistry` L171 (if_rev, diff → `registry-*` events, no-op detection L207; TypeError on a dropped record or changed lock). Add `applySeed` and an exported file-only reader `readRegistryFile(env)` (no seed fallback, no QA read, never throws). The store already imports `seed.mjs`, so `seed.mjs` must not import the store.
- `tools/registry/match.mjs` -- `retired` L68 (`retired_at || seed_missing`). Add exported pure `retirement(record)` → `null|'retired'|'seed-missing'` and `visibility(record, {held, queued})` → `'visible'|'retiring'|'hidden'` (AD-31); `retired` uses `retirement`. The existing `why` text 'is retired' stays (match.test L136).
- `tools/device/claims.mjs` -- `EXIT_CODES` L37 (add `HUB_RESOURCE_RETIRED: 2`). `resolve` L168: before the unknown-word HUB_USAGE (L180), refuse a word whose file record (id, then name, then `words`) is retired/seed-missing. `take` L371: refuse a `phone` target whose record is retired or seed-missing, and narrow a word `pool`'s members, refusing when none are left. Read through `readRegistryFile` only (never the QA file).
- `tools/device/hub-device.mjs` `report` L147-150 -- add `HUB_RESOURCE_RETIRED` to the `HUB_NO_MATCH` branch.
- `tools/device/claims.test.mjs` L64 -- frozen exit table; add the code.
- `tools/registry/store.test.mjs` -- `scratch()` harness L23 (temp lock + event dirs, `write`, `events`, `file`); copy for the apply tests.
- `tools/device/lease-match.test.mjs` -- `side()` L37 and `leaseWord` L55; `writeRegistry` already imported; CLI refusal tests go here.
- `tools/ci/test-fixtures.mjs` `hermetic()` L51-57 -- `HUB_QA_DEVICES` points to a temp empty file; seed.test L104/L114 already prove the real path is never opened.

## Tasks & Acceptance

**Execution:**
- `tools/registry/match.mjs` -- export `retirement` and `visibility`; route `retired` through `retirement` -- one record-state rule for the matcher, the take refusal and future readers.
- `tools/registry/seed.mjs` -- export pure `reseed({resources, pools} | null, devices, {qaDevices, now})` → `{resources, pools, warnings}` per the Always rules (null = first creation: seed with the QA loader, stamp `created_at`). With a current file, call `seed(devices, {qaDevices: () => []})`.
- `tools/registry/store.mjs` -- export `readRegistryFile(env)` and async `applySeed({env, devices, qaDevices, now, hostId, log})`: load the file (unreadable → `HUB_REGISTRY_FORMAT` before any QA read), `reseed`, then one `writeRegistry({if_rev: file rev or 0, reason: 'seed'})`; return `{first, rev, changed, events, warnings}`.
- `tools/device/claims.mjs` -- add `HUB_RESOURCE_RETIRED: 2`, an exported `refuseRetired(word, {env})`, and wire it into `resolve` and `take` per the Code Map; update the header comment.
- `tools/device/hub-device.mjs` -- print `HUB_RESOURCE_RETIRED <word> <message>`.
- `tools/registry/seed-apply.test.mjs` (new) -- every matrix row above `Take…`. Also: a random QA serial per run (generated, so in no committed file) is walked across every key path of every `registry-*` event and every warning; `allowed_users` appears nowhere in the file; the loader call count is 1 on first creation and 0 after; `git ls-files` lists no `qa-devices.json`; and `retirement`/`visibility` cover every combination.
- `tools/device/lease-match.test.mjs` -- the three `Take…` rows and the `phone` row through `main`, plus no-file regression (lease s24 as before).
- `tools/device/claims.test.mjs` -- exit table gains the code.

**Acceptance Criteria:**
- Given `applySeed` on an existing file whose seed is unchanged, when it runs, then `registry.json` bytes and the event log are unchanged and the QA loader is never called.
- Given a `registry.json` where s24 is `seed_missing: true`, when `hub-device lease s24` runs, then it exits 2 with `HUB_RESOURCE_RETIRED` and `seed-missing` on stderr, holds nothing and appends no event.
- Given `mise run check`, when it runs, then actionlint and the full suite pass.

## Spec Change Log

## Review Triage Log

### 2026-11-25 — Review pass
- verdicts: 34 findings — high 0, medium 1, low 16, false 17, maybe-false 0
- findings:
  - `[false]` `[reject]` (blind) `applySeed` has no caller, so nothing seeds at start — the AC allows "a direct `seed.apply` in a test"; the epic says 6.1-6.3 need no service, and the start that calls it is the Hub API's (6.4).
  - `[low]` `[reject]` (blind) `applySeed` has no retry on `HUB_REGISTRY_CONFLICT` — the only writer is the Hub API, whose singleton is the port bind (AD-45); a conflict at start fails loudly, and a retry loop adds a branch for a case nobody meets.
  - `[false]` `[reject]` (blind) the refusal in `resolve` also blocks release/status/extend of a retired device — only `hub-device` `setup` (lease, run) resolves a device word; release and extend take ids (`claims.release` L~540), and status never resolves.
  - `[false]` `[reject]` (blind) the `emulator` word and the iOS lane skip the retired check — `seed()` always derives `emulator` and `ios-lane`, so neither can be `seed_missing`, and seeded Resources cannot be retired (AD-31, enforced by 6.7).
  - `[low]` `[reject]` (blind) `refuseRetired` looks up by id/name/words and `withoutRetired` by lock/id — for every fleet phone the seeded id, name and lock agree; sharing a helper is a refactor with no caller that diverges today.
  - `[low]` `[reject]` (blind) a corrupt `registry.json` silently stops refusals — failing open is the specified behaviour (Design Notes): no writer can mark anything on an unreadable file, and `--match` already warns `HUB_REGISTRY_FORMAT`.
  - `[low]` `[patch]` (blind) the all-members-out error was patched after construction and read "phone is seed-missing" — the error is now built once: `every remaining <pool> member is retired or seed-missing (<id> <reason>, …); it takes no new lease`.
  - `[false]` `[reject]` (blind) `visibility()` is exported but unused — the spec puts its consumers in 6.5/6.8/6.9; this story ships the one rule.
  - `[false]` `[reject]` (blind) reseed edge cases (runtime id clash, runtime Pool members dropped, retired plus drift) — runtime ids are `res-*`, which `nameRefusal` refuses for a seeded name; runtime phones join `phone` through the matcher (AD-33), never through `pools.phone.members`; retired plus model drift is in "retired_at is kept and a runtime Resource is untouched".
  - `[low]` `[patch]` (blind) weak tests: `run s24` checked only exit 2, and the "QA file is never read" title asserted nothing — `run` now asserts the `HUB_RESOURCE_RETIRED s24` line, and the lookup test points `HUB_QA_DEVICES` at a directory, so any QA read would throw. The `git ls-files` portability part is rejected: the suite runs from a checkout.
  - `[low]` `[patch]` (blind) `HUB_RESOURCE_RETIRED` is undocumented, and it shares exit 2 — exit 2 is AD-31's code; README's hub-device section now names the refusal and its stderr line.
  - `[false]` `[reject]` (blind) retirement is checked only before queueing — AD-31: waiters already queued are served normally.
  - `[false]` `[reject]` (edge) the refusal in `resolve` blocks later word callers — grouped with the blind `resolve` finding.
  - `[false]` `[reject]` (edge) a retired `emulator` is never checked — grouped with the blind emulator finding.
  - `[low]` `[patch]` (edge) after cap narrowing the message says "every" member — now "every remaining".
  - `[low]` `[patch]` (edge) a mixed-reason Pool refusal reports only the first member — grouped with the blind message finding: the message now names each member's reason, and `reason`/`resource` stay the first member's.
  - `[low]` `[reject]` (edge) the first-creation race loser fails with a conflict — grouped with the blind retry finding.
  - `[low]` `[reject]` (edge) a hand-edited seeded record with a different lock makes every start throw TypeError — only the store writes the file and seeded locks are fixed (AD-28); a loud failure on a hand edit is the safe outcome.
  - `[false]` `[reject]` (edge) the Pool overwrite drops runtime members — grouped with the blind reseed finding (AD-33).
  - `[false]` `[reject]` (edge) a new seeded lock may equal a runtime lock — runtime locks are `res-*` and seeded locks never are.
  - `[false]` `[reject]` (edge) a phone added after first creation is never marked `dedicated_qa` — AD-30 reads the QA file only when `registry.json` is first created; this is the specified behaviour.
  - `[low]` `[patch]` (edge) `visibility` treated a truthy non-boolean held/queued as hidden — it now uses truthiness.
  - `[medium]` `[patch]` (verification-gap) the take-level phone branch of `withoutRetired` (the defence for non-CLI front doors) was untested — a new test calls `claims.take` with a hand-built s24 target marked `seed_missing` and asserts the refusal fields with nothing new held. The same test shows a lease taken before the mark still releases.
  - `[low]` `[patch]` (verification-gap) `applySeed`'s defaults never ran — a new first-creation test calls it with `HUB_DEVICES` and `HUB_QA_DEVICES` temp files and no seams. It covers the broken-QA no-write case and shows a second start never reads the QA file.
  - `[low]` `[patch]` (verification-gap other) the "QA file is never read" title — grouped with the blind weak-tests finding.
  - `[false]` `[reject]` (verification-gap other) `visibility` has no consumer — grouped with the blind `visibility` finding.
  - `[low]` `[patch]` (verification-gap other) no test showed a held lease ends as usual after a mark — covered by the `claims.take` test above (the release succeeds).
  - `[false]` `[reject]` (intent) no start calls `applySeed` — grouped with the blind no-caller finding.
  - `[false]` `[reject]` (intent) the in-memory fallback has no new test — `readRegistry`'s seed path is unchanged, and the Story 5.5/6.2 tests already cover its QA marks (`seed.test.mjs` QA entries, `store.test.mjs`).
  - `[low]` `[patch]` (intent) the chain from devices.json dropping s24, to `applySeed`, to the lease refused was never run as one flow — added as one end-to-end test through `main`.
  - `[false]` `[reject]` (intent) `visibility` is not surfaced — grouped with the blind `visibility` finding.
  - `[low]` `[reject]` (intent) the QA walk covers only this suite's events, and "no committed file contains a QA serial" checks file names only — a content scan for real serials would mean opening the private file, which the hermetic rule forbids; a per-run random serial is the strongest check available.
  - `[false]` `[reject]` (intent) the reason shows only in message text on the CLI — the error carries `reason`, `resource` and `status`, and the CLI line prints the reason.
  - `[false]` `[reject]` (intent) the refusal's scope (retired wins over "unknown device") — descriptive; the retired answer is the more precise one and the matrix specifies it.

## Design Notes

- **Why the refusal reads the file only.** The in-memory seed never holds a retired or `seed_missing` record, so a missing or unreadable file can never refuse a take. Reading only the file keeps `lease` from opening the QA file and adds no warning to today's output.
- **First creation is the only QA read.** `reseed(null, …)` is the only call that passes the real loader. A broken QA file fails the seed so the one import is retried at the next start instead of being skipped for ever.
- **Order.** File order is kept and new records are appended. `writeRegistry` diffs by id, so order alone never writes.

## Verification

**Commands:**
- `node --test tools/registry/seed-apply.test.mjs tools/registry/store.test.mjs tools/registry/match.test.mjs tools/device/lease-match.test.mjs tools/device/claims.test.mjs` -- expected: all pass
- `mise run check` -- expected: actionlint clean, full suite green

## Auto Run Result

Status: done

**Summary.** The Registry now has a seed at start, covering FR-3 and AD-30, and one take refusal for retired and seed-missing Resources, covering AD-31. Following belsky-doctrine, both are built for every caller at the level above this story. Story 6.4's start calls `applySeed`. Every front door that calls `claims.take` gets `HUB_RESOURCE_RETIRED`. Stories 6.5, 6.8 and 6.9 read records through one `retirement`/`visibility` rule.

- **`reseed` in `seed.mjs` (pure).**
  - **First creation:** the whole seed plus the QA phones, read through the loader. The S24 gets `dedicated_qa`, and an unknown QA phone becomes `res-<slug>` with `seeded: false` and its serial. Every record is stamped `created_at`.
  - **Later starts:** the QA loader is never called.
    - Seeded fields follow `devices.json`. Capabilities, `created_at`, `retired_at` and extra keys stay.
    - A seeded record that has left `devices.json` gets `seed_missing: true` and is never deleted. The mark is cleared when the record returns.
    - Runtime records are untouched, and derived Pools overwrite only their own keys.
- **`applySeed` in `store.mjs`.**
  - It makes one `writeRegistry` at the file's rev, with reason `seed`, and only when something differs, so an unchanged seed writes and logs nothing.
  - An unreadable file is `HUB_REGISTRY_FORMAT` before any QA read. A broken QA file fails before anything is written, so the one import is retried at the next start.
  - `readRegistryFile` is the file-only reader: no seed fallback, no QA read, and it never throws.
- **Claims refusal:** `HUB_RESOURCE_RETIRED` (409, exit 2, `reason` retired|seed-missing, `resource`).
  - `resolve` refuses such a word before the unknown-device error.
  - `take` refuses a phone target and narrows a word Pool.
  - `hub-device` prints `HUB_RESOURCE_RETIRED <word> …` on stderr.
  - With no `registry.json`, every take behaves as before.

**Files changed** (one commit on this branch, after baseline `0a7223f9a4f883b5ef17e2be12ae315de87bdaf4`)
- `tools/registry/seed.mjs`: `reseed`.
- `tools/registry/store.mjs`: `applySeed` and `readRegistryFile`.
- `tools/registry/match.mjs`: `retirement` and `visibility`, the one record-state rule. The matcher uses `retirement`.
- `tools/device/claims.mjs`: `HUB_RESOURCE_RETIRED`, `refuseRetired`, and the take-time narrowing.
- `tools/device/hub-device.mjs`: the refusal's stderr line and the header's exit-code note.
- `tools/registry/seed-apply.test.mjs` (new): every seeding matrix row, the default-args first creation, the random-per-run QA serial walk across every `registry-*` event, result and warning, no `allowed_users` in the file, loader call counts, no tracked `qa-devices.json`, and the `retirement`/`visibility` truth table.
- `tools/device/lease-match.test.mjs`: the CLI refusals (seed-missing, retired, a word gone from `devices.json`, `phone` narrowing and all members out), the no-file and garbage-file regressions, a direct `claims.take` refusal with release of an earlier lease, and the end-to-end chain from `applySeed` dropping s24 to `lease s24` being refused.
- `tools/device/claims.test.mjs`: the frozen exit table gains the code.
- `README.md`: the refusal is documented in the hub-device section.

**Review findings.** 34 findings: high 0, medium 1, low 16, false 17, maybe-false 0.
- **Patched (12 rows, in 8 fixes):**
  - the Pool refusal message, built once and saying "every remaining" member, with each member's reason;
  - `visibility` uses truthiness;
  - the `run` stderr assertion;
  - the QA-never-read test now uses a directory as the QA path;
  - a direct `claims.take` test (medium);
  - a test of `applySeed`'s defaults;
  - the end-to-end test;
  - the README sentence.
- **Deferred:** none.
- **Rejected (22):** each has its reason in the triage log.
  - The 17 false findings are refuted by AD-30, AD-31 and AD-33, the `res-*` namespace, or existing tests.
  - The 5 rejected low findings are:
    - a conflict retry at start (the port-bind singleton);
    - one shared lookup helper;
    - failing open on an unreadable file (as specified);
    - a hand-edited seeded lock;
    - a content scan for real QA serials (forbidden by the hermetic rule).

**Follow-up review recommended: false.** This was the first pass. It patched no high finding and one medium. Patched counts by verdict: high 0, medium 1, low 11.

**Verification**
- `node --test tools/registry/seed-apply.test.mjs tools/registry/store.test.mjs tools/registry/match.test.mjs tools/device/lease-match.test.mjs tools/device/claims.test.mjs`: 100/100 pass.
- `mise run check`: exit 0, actionlint clean, 999/999 tests pass.

**Residual risks**
- Nothing calls `applySeed` (or `recoverRegistry`) at start until the Hub API lands in Story 6.4. Until then no `registry.json` exists in production, and every reader uses the in-memory seed.
- **Matrix wording:** the first-creation row names the unknown QA phone `Pixel QA`. Story 5.5's tested slug rule refuses a name with a space (it is skipped with a warning), so the covering test uses `Pixel-QA`, which gives `res-pixel-qa`. With a space-named entry, a real QA file would lose that phone's one-time import, and only a warning would show it.
  - Whether the QA import should kebab-case display names is a 5.5 rule change, left for Jarad.
- Only the `phone` word's members come from `devices.json`. The fleet, discovery and deploy targets still derive from `devices.json` until Story 6.9.
- A take refusal reads `registry.json` once per lease or run.
