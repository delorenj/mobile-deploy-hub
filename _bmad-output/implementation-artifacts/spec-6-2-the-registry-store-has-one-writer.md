---
title: 'The Registry store has one writer'
type: 'feature'
created: '2026-11-25'
status: 'done'
baseline_revision: 'cd5679de381889db2c0281d9e525683734715bcd'
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-6-context.md'
warnings: ['oversized']
deferred: []
---

<intent-contract>

## Intent

**Problem:** v1b needs `registry.json` (FR-2, AD-27), but nothing can write it safely: `lock.mjs` has no exported atomic write, there is no store module, two edits could race and lose one, and an older Hub API could overwrite newer records. Readers (`hub-device`, the Claims library) only see the in-memory seed.

**Approach:** Export one atomic tmp-plus-rename helper from `lock.mjs`, and add `tools/registry/store.mjs` with `readRegistry` (fresh from disk each call; seed fallback; `HUB_REGISTRY_FORMAT` warning), `writeRegistry` (serialised per path in-process, `if_rev` checked, `rev + 1`, mode `0600`, then the `registry-*` events it derives itself) and `recoverRegistry` (one `registry-edit` `reason: recovered` when the log is behind). Wire the Claims library's `ctx.registry` default to `readRegistry`. belsky-doctrine: one store and one diff-to-events for every Registry writer (seed 6.3, add 6.6, edit/retire 6.7), and one atomic helper for every service-written lock-dir file.

## Boundaries & Constraints

**Always:**
- On disk: `{format: 1, rev, resources: [...], pools: [...]}` (pools an array of `{name, ...}`), mode `0600`, written only through `lock.mjs`'s exported helper. Unknown top-level keys of a format-1 file are carried through a write (additive, AD-2).
- Readers get the matcher's shape: `{format, rev, resources, pools: {<name>: {...}}, source: 'file'|'seed', warnings}`; a missing file is `rev: 0`, `source: 'seed'` (seed.mjs with the caller's `qaDevices`). No caching.
- Errors carry `code`, `status: 409`, `exit: 1`: `HUB_REGISTRY_CONFLICT` (also `rev`, the current one) and `HUB_REGISTRY_FORMAT` (also `reason`). Claims' `EXIT_CODES` lists both.
- A write never deletes a record and never changes a record's `id` or `lock` (AD-28/31): TypeError (caller bug).
- Event write failure never fails a committed write (noteRegistry returns false). Hermetic tests only.

**Never:**
- No Hub API, route, seeding policy (`seed.apply`), QA import, register/edit/retire validation, or CLI verb (Stories 6.3-6.8). No second lock or cross-process lock file; the singleton is the API's port bind (6.4).
- `lock.mjs` never reads `registry.json` (AD-29). The deploy path never imports `tools/registry/*`.
- No change to `writeOwner`/`writeTicket` (their tmp names are part of the on-disk contract older pins share). No dependency, no timers, no Python.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| First write | no file; `writeRegistry({if_rev: 0, resources, pools})` | file `{format:1, rev:1, ...}` mode 0600; one `registry-add` per record with `rev: 1`; returns `{rev: 1, events}` | — |
| Edit | file rev 4; s24 gains `capabilities.api_level` | rev 5; one `registry-edit` `changed: ['capabilities.api_level']`; unchanged records log nothing | — |
| Retire | `retired_at` newly set | one `registry-retire` | — |
| Pools change | `pools.phone.members` changes | one `registry-edit` `resource:'registry', lock:'registry', changed:['pools.phone']` | — |
| No-op | records and pools equal to the file | nothing written, no event, returns current `rev`, `changed: false` | — |
| Stale `if_rev` | file rev 5, `if_rev: 4` | file untouched | `HUB_REGISTRY_CONFLICT`, `rev: 5` |
| Two concurrent writers | two `writeRegistry` with `if_rev: 0` issued together | one rev 1; the other rejects | `HUB_REGISTRY_CONFLICT` |
| Unreadable file | not JSON, `format: 2`, or bad shape | read: seed + one `HUB_REGISTRY_FORMAT` warning (`warn` seam), `unreadable: true`; file bytes unchanged | every write: `HUB_REGISTRY_FORMAT` |
| Half-written temp | `registry.json.<pid>.<hex>.tmp` holding garbage beside a good file | readers and writers ignore it | — |
| Recovery | file rev 3, last logged registry rev 2 (or none) | one `registry-edit` `{resource:'registry', lock:'registry', rev:3, reason:'recovered'}`; second call appends nothing | log ahead or equal / missing or unreadable file → nothing |
| Bad write input | dropped id, changed `lock`, duplicate id, non-array resources | nothing written | TypeError |

</intent-contract>

## Code Map

- `tools/ci/lib/lock.mjs` -- `lockDir()` L26; `RESERVED` L41 (contains `registry`, so no Resource can take the whole-registry event subject); `noteRegistry` L220 (allowlist: resource, lock, changed, rev, reason, actor, why; TypeError on missing resource/lock); private `writeOwner` L496 and `writeTicket` L991 are the existing tmp+rename lines (leave unchanged). Imports at L15-24 (add `openSync`, `fsyncSync`, `closeSync`, `fchmodSync`, `writeSync`, `dirname`). Header comment L1-14.
- `tools/ci/lib/events.mjs` -- `readEvents({env, log})` L108, whole log ascending, ignores `replicas/` (only `YYYY-MM.jsonl` names); recovery scans it for the last `registry-*` event with a numeric `rev`.
- `tools/registry/seed.mjs` -- `seed(devices, {qaDevices})` → `{resources, pools: {phone: {members, named}, emulator: {gate}}, warnings}`, the fallback; `loadQaDevices` the default QA loader.
- `tools/ci/lib/devices.mjs` -- `loadDevices(env)`, the devices.json the seed derives from.
- `tools/registry/match.mjs` -- `match(registry, …)` reads `registry.resources` and `registry.pools[<name>].members` (keyed object): the reader shape `readRegistry` must return.
- `tools/device/claims.mjs` -- `EXIT_CODES` L34 (add both codes); `matchTarget` L142-144: `ctx.registry?.() ?? seed(...)` is the plug point; replace the seed fallback with `readRegistry({env: ctx.env, qaDevices: ctx.qaDevices ?? default, warn: ctx.warn})`. Other seed callers (`fleetOf`, `phoneMembers`, `discover`, deploy targets) stay on devices.json (6.9 widens them).
- `tools/device/hub-device.mjs` L553-558 -- passes `qaDevices`, `registry`, `warn` (prints `hub-device: warning: …`) into the Claims context; no change expected.
- `tools/device/lease-match.test.mjs` -- `side()` harness (temp HOME/lock/event dirs, `cli()` through `main`): copy for the CLI reader tests.
- `tools/ci/test-fixtures.mjs` `hermetic()` -- shared temp `HUB_LOCK_DIR`; store tests use their own temp dir per test.
- `tools/deploy-path.test.mjs` -- already forbids `tools/registry/*` in the deploy path; covers `store.mjs` automatically.

## Tasks & Acceptance

**Execution:**
- `tools/ci/lib/lock.mjs` -- export `writeFileAtomic(path, data, {mode = 0o600})`: mkdir parent, unique `<path>.<pid>.<hex>.tmp` opened `wx` with `mode` and fchmod, write, fsync, close, rename; on any failure unlink the tmp and rethrow. Update header comment -- the one atomic helper (AD-27).
- `tools/registry/store.mjs` (new) -- `REGISTRY_FILE`, `REGISTRY_FORMAT`, `REGISTRY_ERRORS`, `registryPath(env)`, `readRegistry`, `writeRegistry` (async; module-level per-path promise queue; `afterRead` test seam awaited between read and commit), `recoverRegistry`, per the matrix -- the one writer path.
- `tools/device/claims.mjs` -- `EXIT_CODES` gains `HUB_REGISTRY_CONFLICT: 1`, `HUB_REGISTRY_FORMAT: 1`; `matchTarget` default reads through `readRegistry`; header comment.
- `tools/registry/store.test.mjs` (new) -- every matrix row; mode `0600` (`statSync().mode & 0o777`); concurrent writers where A's `afterRead` yields while B is issued (B must conflict, proving the queue); `writeFileAtomic` leaves no tmp on a failed rename; error table agrees with `claims.exitCodeOf`; a QA serial passed in an identity never appears in an event line.
- `tools/device/lease-match.test.mjs` -- CLI reader tests: a `registry.json` giving s24 `api_level: 34` makes `lease --match api_level>=34` take s24, and a second edit of the file is seen by the next call (fresh read); a garbage `registry.json` prints one `HUB_REGISTRY_FORMAT` warning on stderr and the lease still resolves from the seed.

**Acceptance Criteria:**
- Given `lock.mjs`, when imported, then `writeFileAtomic` is exported and `store.mjs` contains no `writeFileSync`/`renameSync` of its own (asserted by a source scan in the test).
- Given a `registry.json` written through the store, when `hub-device lease --match` runs, then it resolves against the file's records, re-read on every call.
- Given an unreadable `registry.json`, when `hub-device lease --match` runs, then it warns `HUB_REGISTRY_FORMAT` once, falls back to the seed, and the file's bytes are unchanged after a refused write.
- Given `mise run check`, when it runs, then actionlint and the full suite pass.

## Spec Change Log

## Review Triage Log

### 2026-11-25 — Review pass
- verdicts: 39 findings — high 0, medium 1, low 26, false 12, maybe-false 0
- findings:
  - `[low]` `[reject]` (blind) if_rev check is not atomic across processes; two writer processes can lose an edit — AD-27/AD-45: only the Hub API writes, its singleton is the port bind (6.4); no writer process exists yet, and a cross-process lock file is a second lock the repo forbids.
  - `[low]` `[reject]` (blind) writeFileAtomic unlinks a tmp it did not create when `wx` hits EEXIST — the tmp name is `<pid>.<8 hex>`; a collision needs the same live pid and the same 32 random bits. Tracking creation adds a branch for a case nobody meets.
  - `[low]` `[reject]` (blind) writeFileAtomic stringifies `undefined`/Uint8Array — the one caller passes a JSON string; a type guard is added surface for an unreachable input.
  - `[low]` `[reject]` (blind) no parent-dir fsync; log-ahead-of-file is silent — power loss inside the rename window is rare, and the event log is not fsynced either; `recoverRegistry` returns both `rev` and `logged_rev`, so the Hub API start (6.4) can report a log-ahead state.
  - `[low]` `[reject]` (blind) recovery compares only the highest rev (partial logging), and recoverRegistry has no caller — the rule is AD-27's own ("compares rev with the last logged rev"); each write result carries per-event `logged` so a caller can react; the start that calls it is the Hub API's (6.4).
  - `[low]` `[reject]` (blind) EACCES/EIO surface as HUB_REGISTRY_FORMAT — the warning and the error `reason` say `cannot read it (EACCES)`; refusing writes on a file the writer cannot read is the AD-27 fail-safe; the spine's code table has no separate code.
  - `[low]` `[reject]` (blind) store does not enforce the reserved `registry` subject or unique locks — ids and locks are minted by registration (6.6), which checks RESERVED; seeded ids are fixed; no caller can write either today, and the guard is added surface.
  - `[false]` `[reject]` (blind) canonical() treats absent and null as equal, dropping a write — absent and null mean the same to every reader (matcher `usable()`, `retired` truthiness); a retired_at going from a value to null is still a difference, so nothing meaningful is lost.
  - `[false]` `[reject]` (blind) a Registry file ignores the QA marks — AD-30: the QA file is read only when registry.json is first created (6.3) and by the in-memory fallback; this is the specified behaviour.
  - `[low]` `[reject]` (blind) shallow shape validation on read; `unreadable` absent on success — only the store writes the file and it writes validated records; deep validation of every field is new surface for hand edits nobody makes.
  - `[false]` `[reject]` (blind) concurrency test is timing-dependent (one setImmediate) — B is chained behind A's queue promise regardless of ticks; without the queue B commits synchronously at call (no afterRead) and A then overwrites, which the test catches.
  - `[low]` `[reject]` (blind) no multi-process test — grouped with the cross-process finding; out of the store's guarantee by design (AD-45).
  - `[false]` `[reject]` (blind) lock-dir scanners may pick up registry.json or its tmp — `listLocks` keeps only `*.lock`, claims' `walkSet` only `<name>.(lock|queue|reservations)`, the emulator scan only `emulator-<n>.lock`; neither name matches.
  - `[false]` `[reject]` (blind) the warning may repeat across repeated matchTarget calls in one lease — hub-device calls `matchTarget` once per invocation (hub-device.mjs:135).
  - `[low]` `[reject]` (blind) an orphan tmp from a crash is never swept — needs a kill inside a microsecond window; a sweeper is new surface.
  - `[low]` `[reject]` (edge) cross-process lost update — grouped with the blind cross-process finding.
  - `[low]` `[reject]` (edge) partial event logging not recovered — grouped with the blind recovery finding.
  - `[low]` `[reject]` (edge) an unlogged earlier rev hidden by later logged revs — grouped with the blind recovery finding (AD-27's rule; per-rev accounting is new surface).
  - `[low]` `[reject]` (edge) a `changed` list over 4 KiB is not logged — needs ~200 capability keys in one write (carried reasoning from 6.1's E2BIG row); the file then reads ahead of the log and start recovery logs it.
  - `[low]` `[reject]` (edge) id/lock `registry` not refused — grouped with the blind reserved-subject finding.
  - `[low]` `[reject]` (edge) inner shapes not validated in loadFile — grouped with the blind shallow-validation finding.
  - `[low]` `[reject]` (edge) no directory fsync after rename — grouped with the blind durability finding.
  - `[low]` `[reject]` (edge) undefined data written as "undefined" — grouped with the blind input-type finding.
  - `[low]` `[reject]` (edge) file deleted or rolled back below the log is undetected — grouped with the blind durability/log-ahead finding.
  - `[low]` `[reject]` (edge) the same file through two paths gets two queues — one process has one HUB_LOCK_DIR; realpath keying adds code for a setup nobody runs.
  - `[false]` `[reject]` (edge) `ctx.env` null makes lockDir throw — createContext defaults `env` to process.env and no caller passes null.
  - `[low]` `[reject]` (edge claim) "every rev bump leaves an event, which keeps recovery exact" overstates partial-logging cases — grouped with the blind recovery finding.
  - `[false]` `[reject]` (edge claim) "the rename is the deciding step" is not optimistic locking — in AD-27 the phrase means the rename is the commit point recovery keys on (file ahead of log), which the code implements; exclusion is the single writer.
  - `[low]` `[reject]` (edge claim) the reserved-subject comment is not enforced in the store — grouped with the blind reserved-subject finding.
  - `[medium]` `[patch]` (verification-gap) loadFile's structural rejections (duplicate id, record without lock, duplicate pool, nameless pool) were untested — added four fixtures to the unreadable-file test; mutation-checked: disabling the duplicate-id check fails it.
  - `[low]` `[patch]` (verification-gap) `fchmodSync` unobserved under the default umask — the writeFileAtomic test now writes 0o640 under `umask(0o077)` and restores the umask; mutation-checked: removing fchmodSync fails it.
  - `[low]` `[reject]` (verification-gap other) good-file shapes the matcher dereferences are unchecked — grouped with the blind shallow-validation finding.
  - `[false]` `[reject]` (intent) recovery is not wired to a start — there is no service start in this story; the epic puts the server in 6.4 and says 6.1-6.3 need no service.
  - `[low]` `[reject]` (intent) single-writer rests on in-process serialisation — grouped with the cross-process finding.
  - `[low]` `[reject]` (intent) only `--match` reads the Registry; fleet, `phone` members, discovery and deploy targets still derive from devices.json — nothing writes registry.json until the Hub API ships; Story 6.9 moves lease resolution onto the Registry, and rewiring every reader is not a direct correction.
  - `[false]` `[reject]` (intent) a no-op write does not raise rev — nothing is written, so "rev rises by one per write" holds for every write that happens; AD-30 requires seeding to write only when the seed differs.
  - `[false]` `[reject]` (intent) unreadable also covers shape failures — a format-1 file that breaks the format-1 shape is an unknown format; the fail-safe (seed + refuse writes) is the intent's.
  - `[false]` `[reject]` (intent) additions beyond the AC (immutability TypeErrors, carried keys, derived events) — descriptive; each serves AD-27/28/31 or a named later story, no defect.
  - `[false]` `[reject]` (intent) the 409 is only an error property — no HTTP surface exists until 6.4, which maps library errors through the same table.

## Design Notes

- **Whole-registry subject.** `noteRegistry` requires `resource` and `lock`. Events about the registry as a whole (pools change, `recovered`) use `resource: 'registry', lock: 'registry'`; `registry` is in `RESERVED`, so no Resource can ever share the subject.
- **Derived events.** The store diffs the file it read against the new records by `id`: new → `registry-add` (changed = its keys), `retired_at` newly truthy → `registry-retire`, any other difference → `registry-edit`. `changed` lists top-level keys, with `capabilities.<key>` expanded and `identity` kept whole (key names only, never values). Every event carries the new `rev` plus the caller's `reason`, `actor`, `why`. So every rev bump leaves at least one event, which keeps recovery exact; a no-op write commits nothing.
- **In-process serialisation.** A module-level `Map<path, Promise>` chains writes, so two store users in one process still serialise. Cross-process exclusion is the Hub API's port bind (AD-45), not a lock file.

## Verification

**Commands:**
- `node --test tools/registry/store.test.mjs tools/device/lease-match.test.mjs` -- expected: all pass
- `mise run check` -- expected: actionlint clean, full suite green

## Auto Run Result

Status: done

**Summary.** `registry.json` now has one writer path, built for every Registry writer at once: the seed (6.3), register (6.6), and edit and retire (6.7) (belsky-doctrine).
- `lock.mjs` exports `writeFileAtomic`, the one tmp-plus-rename helper for a service-written lock-dir file. It creates a unique tmp with `wx` and the given mode, runs fchmod and fsync, then renames. On failure it removes the tmp.
- `tools/registry/store.mjs` adds three functions:
  - `readRegistry` reads fresh from disk on every call. A missing file falls back to the seed at rev 0. An unreadable or unknown-format file falls back to the seed with one `HUB_REGISTRY_FORMAT` warning.
  - `writeRegistry` serialises writes per path in-process. It checks `if_rev` (`HUB_REGISTRY_CONFLICT`, 409, exit 1), writes rev + 1 at mode 0600, refuses any write to an unreadable file, and derives its own `registry-add|edit|retire` events, which carry the new rev.
  - `recoverRegistry` appends one `registry-edit` with `reason: recovered` when the file is ahead of the log.
- The Claims library's `--match` resolution reads through `readRegistry`, and `EXIT_CODES` lists both new codes.

**Files changed** (code commit `f4e6928def1b532ccf3a9d472e807dcd631695ae`, plus the review patch commit)
- `tools/ci/lib/lock.mjs`: exported `writeFileAtomic` and a header note. `writeOwner` and `writeTicket` are unchanged.
- `tools/registry/store.mjs` (new): the Registry store.
- `tools/registry/store.test.mjs` (new): every matrix row, the source scan, the error-table agreement, the check that no QA serial reaches an event, and the review-pass fixtures and umask test.
- `tools/device/claims.mjs`: `matchTarget` reads the Registry, and two new exit codes.
- `tools/device/claims.test.mjs`: the frozen exit table includes the two codes.
- `tools/device/lease-match.test.mjs`: CLI reader tests. One covers a file edit that the next call sees; the other covers a garbage file, which warns once, falls back to the seed and is left untouched.

**Review findings.** 39 findings: high 0, medium 1, low 26, false 12, maybe-false 0.
- **Patched (2):**
  - Medium: four structural-rejection fixtures for `loadFile`.
  - Low: an fchmod-under-umask assertion.

  Both were mutation-checked: disabling the code each one covers makes it fail.
- **Deferred:** none.
- **Rejected (37):** each has its reason in the triage log above.
  - The 12 false findings are refuted there.
  - The 25 low findings are mostly unreachable with today's callers, or need added surface, such as:
    - a cross-process lock (forbidden: the singleton is the Hub API port bind);
    - per-rev recovery accounting (AD-27 specifies max-rev comparison);
    - input type guards;
    - a directory fsync;
    - a tmp sweeper;
    - deep shape validation;
    - reserved-subject guards (registration in 6.6 enforces RESERVED).

**Follow-up review recommended: false.** This was the first pass. It patched no high finding and only one medium. Patched counts by verdict: high 0, medium 1, low 1.

**Verification**
- `node --test tools/registry/store.test.mjs tools/device/lease-match.test.mjs`: 44/44 pass.
- Mutation checks: with `fchmodSync` removed, 1 test fails. With the duplicate-id check disabled, 1 test fails. Both were restored afterwards.
- `mise run check`: exit 0, actionlint clean, 975/975 tests pass.

**Residual risks**
- Nothing calls `recoverRegistry` at start, and nothing writes `registry.json` in production, until the Hub API lands (Story 6.4). Story 6.4 must call `recoverRegistry` at start and report its `rev`/`logged_rev` (a log ahead of the file means the file was restored or deleted).
- Cross-process exclusion rests entirely on the Hub API's port bind (AD-45). Two writer processes would lose an edit silently.
- Only `--match` reads the Registry. The fleet, the `phone` word, discovery and deploy targets still derive from `devices.json` until Story 6.9.
