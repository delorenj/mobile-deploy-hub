---
title: 'Ask for a phone by Capability'
type: 'feature'
created: '2026-11-25'
status: 'done'
baseline_revision: 'ea7c7f99dec34b61289d0c9403c22373c97c4832'
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-5-context.md'
warnings: ['oversized']
deferred: []
---

<intent-contract>

## Intent

**Problem:** An agent that needs "a phone with API 34+" has to read `devices.json` and guess a device word; nothing in the hub matches a request against Resources, and the `phone` Pool's member list is a hand-built fleet order rather than a rule (FR-6, AD-33).

**Approach:** Add one pure matcher, `tools/registry/match.mjs` (`parseQuery`, `match(registry, request, policy)`), that resolves both a seeded named list (`{pool: 'phone'}`) and a Capability query. The Claims library resolves `--match` through it against the in-memory seed (QA marks included), drops what the CLI cannot hold, fails fast on no match or every match away, and takes with today's ordered Pool try. `lease|run --match key=value[,key>=n]` is the CLI form; the `phone` word's members now come from the same matcher.

## Boundaries & Constraints

**Always:**
- `parseQuery(text)`: comma-separated clauses `key=value`, `key>=n`, `key<=n`; key `^[a-z][a-z0-9_]*$`; value non-empty; `>=`/`<=` need a finite decimal number. Empty text, empty clause or bad clause → `HUB_USAGE` (exit 2) naming the clause. Returns `[{key, op, value}]` (value the raw text).
- Facets a clause reads: `id`, `name`, `kind`, `host`, `model` (`identity.model`), `deploy_target`, then every `capabilities` key (an intrinsic facet wins a name clash). `=` compares by the facet's type: boolean needs `true|false`, number needs a numeric value (numeric equality), string is exact. `>=`/`<=` match only a finite number facet. A missing facet never matches.
- `match(registry, request, policy)` is pure (no I/O). `registry` is `{resources, pools}` (a `seed()` result). `request` is `{pool: <name>}` or `{query: clauses}`, plus optional `for_ms`. Returns `{pool: {kind: 'named'|'query', name}, members: [record...], host, excluded: [{id, why}]}` with members in registry/list order:
  - Named `phone`: `registry.pools.phone.members` in order, then every runtime (`seeded === false`) `kind: phone`, `host: linux` record that is not `dedicated_qa` and not retired, by `created_at`. Seeded named members ignore `dedicated_qa`. An unknown pool name → `HUB_USAGE`.
  - Query: every record whose facets satisfy every clause, excluding retired (`retired_at` or `seed_missing`) and `dedicated_qa: true` records unless the request names it (an `id=` or `name=` clause equal to its id/name) or has any `dedicated_qa` clause.
  - Both: a `deploy_target` record is dropped when `for_ms` exceeds `policy.queue.deploy_target_lease_max_min` minutes (why names the cap). No members → throws `HUB_NO_MATCH` with `reason` (`<id> <why>` joined by `; `, or `the Registry has no Resources`) and `excluded`. Members on more than one `host` → throws `HUB_POOL_CROSS_HOST` naming each host and its ids.
- `claims.EXIT_CODES` gains `HUB_NO_MATCH: 2` and `HUB_POOL_CROSS_HOST: 2` (the only change to `claims.test.mjs`'s deep-equal, named as intended).
- `claims.matchTarget(text, {forMs}, ctx)`: registry is `ctx.registry?.() ?? seed(loadDevices(env), {qaDevices: ctx.qaDevices ?? (() => loadQaDevices({env}))})`; policy `ctx.policy ?? loadPolicy().policy`. Members are mapped to `ctx.fleet` by lock; a non-phone member is excluded (`is a <kind>; --match takes a phone`), a phone not in the fleet is excluded (`is known only from the QA file; hub-device cannot lease it yet`); none left → `HUB_NO_MATCH` with those whys added. Returns `{kind: 'pool', by: 'match', pool: 'match:<canonical query>', members}` (canonical = clauses re-joined as `key op value` with `,`).
- `take()` of a `by: 'match'` target, after its usual checks and before any event: on host key `linux` (`ctx.hostKey ?? hostKey`, an unknown key reads nothing) it reads the members over the same read-only wire query status uses; members reading `absent`, `offline` or `unauthorized` are dropped; if all are → throws `HUB_DEVICE_AWAY` (75) with `reason` `<id> <state>, ...`. `unknown` never drops a member. The rest go to the ordered Pool try (`takeAnyPhone`) under one Pool request named by `pool`: same exports, `HUB_DEVICE` the phone taken, one `request` + one `acquire`/`timeout`/`cancel`, no ticket.
- `resolve('phone')` takes its members from `match(seed(loadDevices(env), {qaDevices: () => []}), {pool: 'phone'})` mapped to the fleet; for the committed `devices.json` it equals today's `[s24, s26]`.
- CLI: `--match <query>` is a value flag for `lease` and `run` only (any other command: `unknown flag --match`). With `--match`, no device word (`lease takes a device word or --match, not both`, exit 2); `emulator` with `--match` is a usage error. Usage checks (`--for`, `--why`, `--wait`, `--pid`, `--id`) run before matching. The device label in every report line is `match:<canonical query>`. `HUB_NO_MATCH` and `HUB_POOL_CROSS_HOST` print one stderr line `<CODE> <label> <message>` and exit 2. `USAGE` keeps its `usage: hub-device lease ` prefix and gains `--match`.

**Never:**
- No ticket, no place in line, no new lock-dir layout, no `lock.mjs` change (Story 5.8). No `registry.json` read, Hub API or service. No change to the deploy path, `devices.json`, `seed.mjs`'s output, `status`, `discover`, or any existing command's output or exit code. Only `lease|run --match` read the QA file; never its `allowed_users`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Operator `>=` | api_level 35 / 33, `api_level>=34` | only the 35 | — |
| Operator `<=` | `api_level<=33` | only the 33 | — |
| String `=` | `model=SM-S928U` | the S24 | — |
| Boolean `=` | `deploy_target=false` | phones that are not targets | `deploy_target=yes` → no match (why names it) |
| Missing key | `api_level>=34`, nothing has it | — | `HUB_NO_MATCH`, reason `s24 has no api_level; ...`, exit 2, no events |
| QA excluded | S24 `dedicated_qa`, `kind=phone` | `[s26]` | — |
| QA asked / named | `kind=phone,dedicated_qa=true` / `name=s24` | `[s24]` | — |
| Named list Q1 | `{pool:'phone'}`, S24 `dedicated_qa` | `[s24, s26]` | — |
| Cap drop | `for_ms` 2h, `kind=phone` | s26 dropped | only s26 matched → `HUB_NO_MATCH` naming the cap |
| Cross host | `deploy_target=true` | — | `HUB_POOL_CROSS_HOST`, exit 2 |
| All away | every member absent/offline/unauthorized | stdout `HUB_DEVICE_AWAY match:<q>` | exit 75, no events, nothing held |
| Unknown reading | no adb server / no host key | not dropped; ordered try runs | today's AWAY/BUSY verdicts |
| Free + reachable | `kind=phone`, S24 QA, S26 free | `export HUB_DEVICE='s26'`… | exit 0; events `request`,`acquire` with `pool: match:kind=phone` |
| Bad query | `--match api_level>=abc` / `--match ''` | — | `HUB_USAGE`, exit 2 |
| Word + match | `lease s24 --match kind=phone` | — | exit 2 |

</intent-contract>

## Code Map

- `tools/registry/seed.mjs` -- `seed()` record shape (L45-48: `capabilities`, `seeded`, `deploy_target`, `identity.model`), `pools.phone` (L99), `PHONE_POOL_SEED`, `loadQaDevices`; read only. Seeded Resources carry no Capabilities.
- `tools/registry/match.mjs` -- NEW. May import nothing that does I/O; must not import `claims.mjs` or `tools/device/*`.
- `tools/device/claims.mjs`:
  - L33-46 `EXIT_CODES`: add the two codes.
  - L82-92 `createContext`: add `qaDevices`, `registry` seams.
  - L129-143 `resolve`: `phone` members through `match`.
  - L160-173 `overCap`/`checkBounds`: unchanged; a match target is already narrowed.
  - L255-290 `takeAnyPhone`: take the Pool name from the target (today hard-coded `PHONE` at L266).
  - L311-324 `take`: the away check for `by: 'match'`.
  - L466-475 `phoneObservations` + `phoneReachability` (reachability.mjs): reuse for the away check, with the inventory call pattern at L575.
  - L64 `hostKey`; status's tolerant pattern is in `hub-device.mjs` L308-309.
- `tools/ci/lib/lock.mjs` L419-427 `deployTargetCapMs`/`capText` (cap wording), L972 `poolRequest(pool, …)` (event `pool` field); read only.
- `tools/ci/lib/policy.mjs` `loadPolicy` -- `policy.queue.deploy_target_lease_max_min`.
- `tools/device/hub-device.mjs`: L66 `VALUE_FLAGS`; L91 `USAGE`; L109-125 `setup` (add the match branch); L127-144 `report` (label, two new codes); L182-211 `lease`, L456-507 `runCommand`; L529-531 per-command flag refusal; header comment L18-28.
- `tools/device/wire-fixtures.mjs` `fakeWire`; `tools/device/status-view.test.mjs` L20-70 `side()`, `serverUp`, `phone()` patterns for a hermetic CLI run with readings.
- `tools/device/claims.test.mjs` L50-60 the exported-name list and the `EXIT_CODES` deep-equal.
- `tools/deploy-path.test.mjs` `FORBIDDEN` already covers `tools/registry/`; nothing to add.
- `README.md` L239 (QA file sentence: now read by `lease|run --match`), L241-251 (`phone` paragraph and command list); `docs/features.md` (the hub-device line).

## Tasks & Acceptance

**Execution:**
- `tools/registry/match.mjs` -- `parseQuery`, `canonical`, `match` and the facet rule -- the one matcher (AD-33).
- `tools/device/claims.mjs` -- exit codes, `matchTarget`, `phone` via `match`, Pool name from the target, the away check in `take` -- the Claims layer every front door shares.
- `tools/device/hub-device.mjs` -- `--match` on `lease`/`run`, label, refusals, USAGE and header -- the CLI form.
- `tools/registry/match.test.mjs` -- NEW: a table test over a synthetic registry for each operator, the facet types, the QA exclusion (excluded, asked, named), the named-list Q1 exemption, runtime phones in the `phone` list, retired, the cap drop, `HUB_NO_MATCH` reason text, `HUB_POOL_CROSS_HOST`, and `parseQuery` refusals.
- `tools/device/lease-match.test.mjs` -- NEW, hermetic, through `main`: every I/O matrix row that reaches the CLI (QA through an injected `qaDevices`, api_level through an injected `registry`), exports equal to `lease s26`'s, events, no events on a fail-fast, `run --match`, and `resolve('phone')` equal to `[s24, s26]`.
- `tools/device/claims.test.mjs` -- add the two codes to the `EXIT_CODES` deep-equal and `matchTarget` to the exported-name list.
- `README.md`, `docs/features.md` -- document `--match`.

**Acceptance Criteria:**
- Given the existing suites, when they run, then every one passes, with the `EXIT_CODES` deep-equal as the only edited assertion.
- Given `hub-device lease --match kind=phone --for 30m --why x` with the S24 dedicated and the S26 free and reachable, when it runs, then it prints the same export lines `lease s26` prints and exits 0.
- Given a request that no Resource matches, when `lease --match` runs, then it exits 2 at once with `HUB_NO_MATCH` and a reason naming why each Resource was left out, writing no event and holding nothing.
- Given `tools/registry/match.test.mjs`, when it runs, then it covers each operator, the QA exclusion, the cap drop and each refusal.

## Spec Change Log

## Review Triage Log

### 2026-11-25 — Review pass
- verdicts: 31 findings — high 0, medium 1, low 23, false 6, maybe-false 1
- findings:
  - `[low]` `[reject]` Blind: the unquoted `HUB_DEVICE_AWAY match:<query>` stdout line runs as a command (a `>=` becomes a redirect) if eval'd unchecked — the spec fixes the line's form, the README already says check `$?` before `eval` (exit 75 gates the documented `vars=... && eval` pattern), and quoting would change a stdout contract.
  - `[low]` `[reject]` Blind: the pre-filter drops a phone that reads absent on the wire though `findPhone`'s mDNS nudge might have reconnected it — the contract's Always clause makes `absent` a drop (fail fast on definitive away); changing it means editing this build's spec.
  - `[low]` `[reject]` Blind: `--wait` is not spent on away members — same contract decision (fail-fast AWAY), Design Notes record it; fix would edit the spec.
  - `[low]` `[reject]` Blind: the query text is written unbounded into the event `pool` field — a query is a short operator-typed string; no consumer limits the field; a cap is new complexity for a case nobody meets.
  - `[low]` `[reject]` Blind: a Resource without a boolean facet never matches `=false` — the contract says "A missing facet never matches"; fix edits the spec.
  - `[low]` `[reject]` Blind: matching is case-sensitive (`model=sm-s928u` misses) — the contract says string `=` is exact, and the why text shows the actual value; fix edits the spec.
  - `[low]` `[patch]` Blind: `--no-connect` with `--match` is untested — added a CLI test: `lease --match kind=phone --no-connect` with nothing on the wire exits 0 holding the S26, events `request`,`acquire` under `match:kind=phone`.
  - `[low]` `[reject]` Blind: `resolve('phone')` now goes through the matcher, re-reads `devices.json` and drops fleet phones not in the seeded Pool — the contract mandates the named list; for the committed `devices.json` it is `[s24, s26]` (tested); a third `android_extra` phone is a hub release away and Epic 6 adds runtime phones to the list.
  - `[false]` `[reject]` Blind: `checkBounds` in `setup` is discarded and the cap is checked twice — `setup`'s call is the `--for` bounds check (its throw is the point, run before matching per the contract); the cap drop in `match` and `take`'s `checkBounds` read the same `policy.queue.deploy_target_lease_max_min` from one loaded policy, so no divergent outcome.
  - `[low]` `[reject]` Blind: brittle/vacuous tests (the `take()` library test's title overclaims, the intended-change comment in `claims.test.mjs`, no concurrency test) — the comment is the spec's "named as intended"; the `take()` test now passes `noConnect: false` (see the `--no-connect` patch) and asserts the away verdict; concurrency is `takeAnyPhone`'s existing, tested path.
  - `[low]` `[reject]` Blind: the README paragraph is dense and the "only `--match` reads the QA file" claim needs nuance — the sentence is accurate (no other command opens the file); density is cosmetic.
  - `[medium]` `[patch]` Edge: `lease --match <q> --no-connect` exits 75 when every match reads absent, though `--no-connect` promises "the lock only, phone away or not" and `lease s26 --no-connect` succeeds — `take()` now skips `reachableMembers` when `options.noConnect` is set; comment updated; CLI test added.
  - `[low]` `[reject]` Edge: the reachability snapshot is read once, so a phone that appears mid-wait is not considered — the contract's fail-fast reads once before any event; members that read reachable or `unknown` still get the full ordered try with `--wait`; fix edits the spec.
  - `[low]` `[reject]` Edge: the signal is not passed into the reachability read — `queryAdb` is the bounded, timed wire query `status` uses; a SIGINT during it waits at most that bound and still holds nothing.
  - `[maybe-false]` `[reject]` Edge: an inventory throw becomes exit 1 — would need a case where `realInventory` throws (it reads `/proc` and sockets; `status` calls it unguarded too); if true it is low (a tool failure named as one, holding nothing).
  - `[low]` `[reject]` Edge: cross-host is checked before non-phones are dropped, so `deploy_target=true` is `HUB_POOL_CROSS_HOST` though the S26 alone could serve — that is the I/O matrix's own "Cross host" row; fix edits the spec.
  - `[low]` `[reject]` Edge: "is known only from the QA file" is the wrong reason for a phone from an injected registry — the text is the contract's; today only the test seam can supply such a record, and Story 6.9 owns the registry path.
  - `[low]` `[reject]` Edge: `phoneMembers` drops fleet phones not in the seeded Pool — same root as the `resolve('phone')` row; contract-mandated, equal for the committed file.
  - `[false]` `[reject]` Edge: the cap source differs (`match` reads `policy.queue` directly, elsewhere `deployTargetCapMs`) — `matchTarget` always passes `ctx.policy ?? loadPolicy().policy` (strict, always has the key), and `deployTargetCapMs` reads that same key from that same object, so they cannot disagree.
  - `[low]` `[reject]` Edge: whitespace in a value (`kind= phone`) never matches — strict exact compare per the contract; the why text shows the mismatch; trimming is new behavior.
  - `[low]` `[reject]` Edge: `dedicated_qa=false` lifts the QA exclusion but then matches nothing (non-QA records lack the facet) — follows the contract's missing-facet and "any `dedicated_qa` clause" rules; fix edits the spec.
  - `[low]` `[reject]` Edge: the Pool label is free text in events — same root as the unbounded-`pool` row.
  - `[low]` `[reject]` Edge: the spec says only the `EXIT_CODES` assertion changed, but the export-name list changed too — the Tasks list names that edit; fixing the wording means editing this build's spec.
  - `[low]` `[reject]` Edge: the README's SIGINT and mid-wait claims do not hold for `--match` — the new paragraph says members are dropped before the try; the general SIGINT sentence still holds (cancel test added: SIGINT while waiting exits 130 with a `cancel` event, holding nothing).
  - `[low]` `[reject]` Edge: deletion — fleet phones outside the seeded Pool are no longer served by `phone` — same root as the `resolve('phone')` row.
  - `[low]` `[patch]` Verification gap: no `--match` test for a held phone — added BUSY (S26 held → 76, `HUB_DEVICE_BUSY match:kind=phone`, events `request`,`timeout`), held-then-freed (exit 0, `HUB_DEVICE='s26'`) and cancel (SIGINT → 130, `request`,`cancel`, nothing new held).
  - `[low]` `[patch]` Verification other: "is a emulator-pool" — `matchTarget` now writes "an" before a vowel-initial kind; the assertion at `lease-match.test.mjs:161` updated.
  - `[false]` `[reject]` Intent: Resources carry no real Capability data yet — descriptive; the contract and Design Notes scope Capabilities to Epic 6 with the `registry` seam.
  - `[false]` `[reject]` Intent: `--match` reads the QA file — descriptive; the contract requires it (Design Notes say why).
  - `[false]` `[reject]` Intent: the away pre-filter runs on Linux only — descriptive; the contract scopes it to host key `linux`, `unknown` elsewhere.
  - `[false]` `[reject]` Intent: no Hub API surface — descriptive; the contract's Never excludes a Hub API or service.

## Design Notes

- Seeded Resources have no Capabilities until the Registry (Epic 6) lets them be set, so `--match api_level>=34` against the real seed answers `HUB_NO_MATCH` ("s24 has no api_level; ...") today. That is the honest answer; `kind`, `model`, `host`, `name` and `deploy_target` queries work now, and the `registry` seam is where Story 6.9 plugs `registry.json` in.
- Why `--match` reads the QA file when no other command does: FR-6 serves a dedicated-QA phone only to a request that names it, and AD-27's in-memory fallback carries the `dedicated_qa` marks. Without the file the S24 would be served to any query. A broken file fails the request (`HUB_QA_DEVICES`, exit 1) rather than guess.
- Fail-fast AWAY reads only definitive states: `unknown` (no server, wedged server, no host key) keeps today's behaviour, where `findPhone` looks within `--wait`.
- Example: `match(seed, {query: parseQuery('kind=phone'), for_ms: 7_200_000}, policy)` with the S24 dedicated throws `HUB_NO_MATCH`, reason `s24 is dedicated_qa (name it or ask for dedicated_qa); s26 is a deploy target capped at 60 min, under the 120 min asked; ios-lane kind is ios-lane, not phone; emulator kind is emulator-pool, not phone`.

## Verification

**Commands:**
- `node --test tools/registry/match.test.mjs tools/device/lease-match.test.mjs tools/device/claims.test.mjs tools/device/hub-device.test.mjs tools/device/lease.test.mjs tools/device/status-view.test.mjs tools/registry/discover.test.mjs tools/deploy-path.test.mjs` -- expected: all pass.
- `mise run check` -- expected: actionlint clean, full suite green.

## Auto Run Result

Status: done

**Summary.** `hub-device lease|run --match <query>` takes a phone by Capability. One pure matcher, `tools/registry/match.mjs` (`parseQuery`, `canonical`, `match`), resolves both the seeded `phone` named list and a query. The Claims library's `matchTarget` runs it against the in-memory seed with the QA marks, drops what the CLI cannot hold, and fails fast with `HUB_NO_MATCH` (2), `HUB_POOL_CROSS_HOST` (2) or, when every member reads away on the Linux wire, `HUB_DEVICE_AWAY` (75). Otherwise `take` runs today's ordered Pool try under one Pool request named `match:<query>`. The `phone` word's members now come from the same matcher, and are still `[s24, s26]`.

**Files changed.**
- `tools/registry/match.mjs`: new. The query grammar, the facet rule, the named list and query resolution, the QA exclusion, the cap drop and both refusals.
- `tools/registry/match.test.mjs`: new. Table tests for every operator, facet type, QA case, the named-list Q1 exemption, runtime phones, retired, the cap drop and each refusal.
- `tools/device/claims.mjs`: the two exit codes, the `qaDevices`/`registry` seams, `matchTarget`, `phone` through the matcher, the Pool name taken from the target, and the away pre-filter, which `--no-connect` now skips.
- `tools/device/hub-device.mjs`: the `--match` value flag on `lease`/`run`, the refusals, the `match:<query>` label, and USAGE and the header.
- `tools/device/lease-match.test.mjs`: new. 24 hermetic tests through `main`, including BUSY, held-then-freed, SIGINT cancel and `--no-connect`.
- `tools/device/claims.test.mjs`: the two codes and `matchTarget` in the export list.
- `README.md`, `docs/features.md`: document `--match`.

**Review findings.** There were 31 findings: high 0, medium 1, low 23, false 6 and maybe-false 1.
- Patched, 4 entries (1 medium, 3 low):
  - (medium) `--match --no-connect` no longer fails as away.
  - (low) A test for `--no-connect` was added.
  - (low) BUSY, freed and cancel tests were added.
  - (low) The "an emulator-pool" grammar is fixed.
- Deferred: none.
- Rejected, each with its reason in the triage log:
  - Low items that are fixed by the contract: the fail-fast AWAY snapshot, missing-facet and exact-string matching, `dedicated_qa=false`, cross-host before the phone filter, the QA-file reason text, `phone` taken from the seeded Pool, and the spec wording on edited assertions.
  - Low items unlikely to come up in normal use, or cosmetic: the eval hazard, which docs already guard; the unbounded label in events; whitespace values; README density and claims; test naming; and a signal during the bounded wire read.
  - False: the discarded `checkBounds` call, the second cap source, and four descriptive intent rows.
  - Maybe-false: an inventory throw, which would be low if true.

**Follow-up review recommended:** false. This pass patched no high item and only one medium.

**Verification.**
- The targeted `node --test` list passed 235 of 235.
- `mise run check` exited 0: actionlint is clean and the full suite passed 891 of 891.

**Residual risks.**
- Seeded Resources carry no Capabilities until Epic 6, so `api_level` queries answer `HUB_NO_MATCH` today.
- A phone whose wireless adb dropped reads `absent`. `--match` reports it as away at once, where `lease phone` might have reconnected it through mDNS within `--wait`. The contract chose to fail fast.
- A third `android_extra` phone would not join the `phone` word until it is added to the seeded Pool or registered at runtime.
