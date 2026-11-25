---
title: 'Story 5.10: Ship the CLI release (pre-release half)'
type: 'chore'
created: '2026-11-25'
status: 'awaiting-operator'
operator_actions:
  - 'Merge this story branch into main and push main to origin (main is 19+ commits past origin/main d148d7e); the release refuses a main that is not origin/main.'
  - 'Before releasing, confirm `git ls-remote origin refs/tags/v1 refs/tags/v1.2.52` shows v1 on v1.2.51 (commit 084568c) and no v1.2.52 tag; if v1 moved or 1.2.52 is taken, retitle or reword the `## v1.2.52` section of docs/hub-releases.md first.'
  - 'From a fresh clean clone of main on big-chungus, run `mise run release -- 1.2.52`; confirm every app strict dry run is green, v1 moved to v1.2.52, and `git show v1.2.52` carries the notes and a `Roll back:` line naming v1.2.51.'
  - 'After the release runner confirms its runs are finished, run `mise run hosts:install` on big-chungus from a clean checkout at tag v1.2.52 (it installs the Mac through hub-mac); confirm the `HOST_KEY=linux` and `HOST_KEY=mac` readbacks, both hosts current at v1.2.52, no catch-up timer, and the catch-up candybars still firing.'
  - 'After the first real deploy on v1.2.52, confirm in the Event Log that it took `adb` or `mac-ios` as before, then run `hub-device status --json` on big-chungus and on the Mac and confirm every Resource row carries `reachability` (a connected phone reads `reachable`, not `unknown`) and `deploy_target` (true for s26 and ios-lane).'
  - 'If the release is red or anything regresses, run the `Roll back:` line from the v1.2.52 annotation: move v1 back to v1.2.51 and run `mise run hosts:install` on big-chungus from a clean checkout at v1.2.51.'
review_loop_iteration: 0
followup_review_recommended: false
baseline_revision: '2fa130e081d560cc02e40b74ca89853ef76f9162'
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-5-context.md'
warnings: ['oversized']
deferred: []
---

<intent-contract>

## Intent

**Problem:** Stories 5.1-5.9 are on local main (18 commits past `origin/main` `d148d7e`, 25 past `v1.2.51`, the tag `v1` points at) but nothing ships them: `docs/hub-releases.md` has no section for the next release, so its tag would not say that nothing in it is a service or how to roll back, and no run has proven `mise run check` green on Node 24 and Node 26 at this commit. A release annotation also never names its own rollback pin, and "the previous tag" is easy to get wrong: v1.2.47, v1.2.49 and v1.2.50 were tagged, rolled back and never on `v1` (NFR-2, AD-47).

**Approach:** Belsky, one level up (`belsky-doctrine`): every hub release's tag annotation states its rollback, computed from where `v1` pointed before the release, never guessed by number; Epic 5's release is the first to carry it. Write the `## v1.2.52` notes section, prove the check on both Nodes, and hand the release run itself (which needs this story merged and main pushed) to the operator.

## Boundaries & Constraints

**Always:** Node 24 ESM, `node:` builtins only; hermetic tests. Rollback is computed from `remoteTag(major)` read *before* the first tag of the release, and resolved to the highest `vX.Y.Z` tag pointing at that commit (else the short commit; none when `v1` is new). The rollback line goes into every annotation of the tag (pending, green, red, unknown) between the notes and the dry-run lines, and is logged as `RELEASE_ROLLBACK`. `tagMessage(tag, status, notes)` with no rollback stays byte-identical. The v1.2.52 section names `v1.2.51` as the rollback, states that nothing in the release is a service, and lists every operator-visible change and the intended test changes.

**Never:** run `mise run release`, `hosts:install`, move a tag, deploy or push main (the orchestrator merges; main is not yet on origin); change `lock.mjs`, the claims library, the deploy path or `policy.json`; edit `AGENTS.md`/`CLAUDE.md`; write `sprint-status.yaml`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| v1 on a release tag | `v1` commit carries `v1.2.51` (and `v1.2.51` only) | `Roll back: move v1 back to v1.2.51 ... then mise run hosts:install ... at v1.2.51` | N/A |
| several tags on that commit | `v1.2.9`, `v1.2.10`, `v1`, `foo` | picks `v1.2.10` (numeric, not lexical; ignores non-release names) | N/A |
| v1 on an untagged commit | moved by hand | names the 8-char commit | N/A |
| v1 is new | `remoteTag('v1')` null | `Roll back: none: v1 is new with this release.` | N/A |
| no rollback | `tagMessage(tag, status, notes)` | exactly today's annotation | N/A |

</intent-contract>

## Code Map

- `tools/release.mjs` -- L77-149 `release()`: `previous = remoteTag(major)` is read at L117 after the pending tag; move it before L111's first `tagArgs` call. L42 `tagMessage`, L45 `tagArgs` (all four annotation writes: L111, L131, L144, L147). L62 `remoteTag` returns `{object, commit}`. `git(['fetch', ... '--tags'])` at L82 makes local tags current.
- `tools/ci/v11.test.mjs` L659-735 -- the release-notes tests (pure helpers, temp-repo round trip, the v1.2.46 section check at L723); add the rollback helpers' tests and a v1.2.52 section check beside them.
- `docs/hub-releases.md` -- one section per release, newest first; `## v1.2.51` at L7.
- Epic 5 content for the notes (from specs 5.1-5.9 Auto Run Results): claims library (no CLI change), `RESERVED`/`SLUG`/`res-*` queue, `resource` on hold events, `host-key` written by `hosts:install` (`HUB_HOST_UNKNOWN` exit 1), status `resource`/`reachability`/`deploy_target` + `DEPLOY TARGET` text lines + adb wire only, `discover`, `--match` (`HUB_NO_MATCH`/`HUB_POOL_CROSS_HOST` 2, AWAY 75), `phone` Pool tickets in every member queue with one Pool-level `request`, extension refused for Pool and gate waiters, strict `registry.reachability_max_age_s` policy key.
- Intended test changes since `v1.2.51` (`git diff v1.2.51 HEAD -- tools/device/{hub-device,lease,emulator}.test.mjs`): `hub-device.test.mjs` status fixtures answer on the adb wire instead of the adb binary (5.4); `lease.test.mjs` `body()` strips `resource` (5.2); `emulator.test.mjs` unchanged; no `phone` ordering assertion changed (5.8).
- `tools/hosts.mjs` L7, L62-L111 -- `hosts:install` already writes each host's key (5.3); one run on big-chungus covers the Mac through `hub-mac`. `mise.toml` L160 task description omits the key.
- `README.md` "Changing a rule" / release paragraph -- mention the rollback line.

## Tasks & Acceptance

**Execution:**
- [x] `tools/release.mjs` -- export pure `pinTag(names)` and `rollbackLine({ major, previous, previousTag })`; extend `tagMessage(tag, status, notes, rollback)`; read `previous` before the first tag, resolve its tag with `git tag --points-at <commit> --list 'v*'`, log `RELEASE_ROLLBACK`, pass the line to all four annotations -- every release states its own rollback
- [x] `tools/ci/v11.test.mjs` -- matrix rows for `pinTag`/`rollbackLine`/`tagMessage`; temp-repo round trip keeps the rollback line on re-annotation; v1.2.52 section check -- proves both halves
- [x] `docs/hub-releases.md` -- `## v1.2.52` section above v1.2.51 -- AC 4
- [x] `mise.toml`, `README.md` -- `hosts:install` description names the host key; release docs name the rollback line
- [x] verification -- `mise run check` on Node 24 and `mise run --tool node@26 check`; a throwaway probe (outside the repo) of `v1.2.51`'s `lock.mjs` against lock-dir state written by HEAD (a Pool ticket in `adb` and `s24` queues, a held `s24` Lease with `resource`) -- AC 1 and AC 3's old-pin clause

**Acceptance Criteria:**
- Given HEAD, when `mise run check` and `mise run --tool node@26 check` run, then both are green and the only `tools/device/*.test.mjs` edits since `v1.2.51` to the three pre-existing suites are the named intended changes.
- Given `docs/hub-releases.md`, when `releaseNotes(text, 'v1.2.52')` reads it, then the section states that nothing in this release is a service, that rolling back is `hosts:install` of `v1.2.51`, and names `reachability`, `deploy_target`, `--match`, `phone`, `discover` and `host-key`.
- Given a release whose `v1` pointed at `v1.2.51`, when it tags, then every annotation carries the computed rollback line naming `v1.2.51`.
- Given the operator-owed half (release, `hosts:install`, first deploy), when this story finishes, then the spec is `awaiting-operator` with each step listed under `operator_actions`.

## Spec Change Log

## Review Triage Log

### 2026-11-25 — Review pass
- verdicts: 23 findings — high 0, medium 2, low 14, false 7, maybe-false 0
- findings:
  - `medium` `patch` (blind) A failed `ls-remote` reads as "v1 is new", so the annotation says `Roll back: none` (and, pre-existing, a red dry run would delete `v1`). — `remoteTag` now throws when `ls-remote` itself fails and returns null only for a successful empty lookup; hermetic test with an injected runner.
  - `false` `reject` (blind) `previousTag` reads local tags that were never fetched. — `release()` runs `git fetch -q origin main --tags` (non-`allowFail`) before any of this, so the local tags are origin's; the `RELEASE_ROLLBACK` log line shows whichever target was chosen.
  - `low` `patch` (blind) The untagged-commit fallback names an 8-character abbreviation that can be ambiguous or missing. — `rollbackLine` now puts the full `previous.commit` in the command and the checkout reference; assertion updated.
  - `low` `reject` (blind) The RED and UNKNOWN annotations still carry the `Roll back:` line although `v1` was already moved back. — The target is the same commit `v1` was returned to, so following it is a no-op for `v1`, never a move to an older pin; status-aware wording would add a branch for cosmetic gain.
  - `low` `reject` (blind) No test drives `release()` itself, so dropping the rollback from one of the four calls or moving the `remoteTag` read would pass. — `release()` has never had seams (origin, mise, GitHub); adding them is a refactor. The first live release checks it: an operator action reads `git show v1.2.52` for the line.
  - `low` `reject` (blind) The v1.2.52 section hard-codes `v1.2.51`, which could disagree with the computed line if `v1` moves first; `/Roll back:/` is a weak assertion. — `v1` is on `v1.2.51` now; an operator action checks it before the release, and the section already says the annotation's computed line is the authority.
  - `low` `reject` (blind) The notes carry story numbers, and the test-file list is not cross-checked. — Earlier sections (v1.2.49 "Story 3.5") do the same; a file rename breaking the prose is cosmetic.
  - `low` `reject` (blind) `pinTag` accepts leading zeros (`v01.2.3`). — No such tag exists or can come from `release.mjs` (`/^\d+\.\d+\.\d+$/` from the operator's argument only); a guard adds complexity for nothing reachable.
  - `medium` `patch` (edge) Same as the first blind row: `ls-remote` failure → "v1 is new", red path deletes `v1`. — Grouped with it; same fix.
  - `low` `patch` (edge) v1's commit object missing locally makes `--points-at` empty and falls back to the abbreviation. — Grouped with the abbreviation row; the full sha is now named.
  - `low` `patch` (edge) An unqualified 8-char abbreviation may be ambiguous. — Grouped with the abbreviation row.
  - `low` `reject` (edge) A local-only tag deleted on origin could still point at v1's commit. — Rolled-back release tags are kept on origin (v1.2.47, v1.2.49, v1.2.50 all exist); a deleted tag on v1's exact commit has never happened, and the fix needs a remote intersection.
  - `low` `reject` (edge) A new major gives no undo step. — A new major (`v2`) is not planned; the line says plainly that there is nothing to go back to.
  - `low` `reject` (edge) `release()` wiring is untested. — Same as the blind row; first live release verifies via operator action.
  - `low` `reject` (edge) The notes hard-code `v1.2.51`. — Same as the blind row.
  - `false` `reject` (edge) The notes test checks wording, not truth. — Each claim was checked against code at review (DEPLOY TARGET condition `hub-device.mjs:374-390`, `deploy_target` doc `claims.mjs:573-576`, the exit codes in `EXIT_CODES`), and one inaccurate sentence (host-key fallback) was corrected before review; behaviour is pinned by the story suites, not by the notes test.
  - `low` `reject` (verification-gap) The `release()` wiring that feeds the rollback into all four annotations is run by no test (filed `defer`). — Same root as the blind row; the seams are a refactor of a never-unit-tested function. Not deferred because the first live release (an operator action) checks the annotation directly.
  - `false` `reject` (verification-gap, other) The v1.2.52 test is a source-text assertion. — That is its purpose (AC 4 is about the published text); behaviour lives in the 5.1-5.9 suites.
  - `false` `reject` (intent) AC 1 has no check run in the diff. — The run is recorded here: `mise run check` 933/933 on Node 24 and `mise run --tool node@26 check` 933/933 on v26.13.0, after the patches.
  - `false` `reject` (intent) AC 2 (release, `v1`, `hosts:install`) is not exercised. — It cannot be until this story is merged and main pushed; it is listed under `operator_actions`, as the invocation directs.
  - `low` `reject` (intent) AC 3's old-pin clause is shown only by a throwaway probe, not a repo test. — The probe ran `v1.2.51`'s `lock.mjs` against HEAD-written state (Pool tickets, `resource`); `names.test.mjs` already pins the v1.2.46 reader on `resource`. Importing a tagged tree into the suite would be new infrastructure; the first real deploy (operator action) is the live check.
  - `false` `reject` (intent) AC 4 is "published" only when the tag is cut. — Correct and intended: the text is in the file the release reads; publishing is the operator's release.
  - `false` `reject` (intent) "Previous tag" is reinterpreted as where `v1` pointed. — Deliberate (Design Notes): for v1.2.52 both readings name v1.2.51, and the `v1` reading is the one that is right when a release was rolled back.

## Design Notes

Why from `v1` and not "the previous version tag": a red release moves `v1` back, so the live pin is what `v1` named before this release started (while v1.2.50 was released, `v1` stood on v1.2.48, because v1.2.49 had rolled back; "the previous tag" by number would have named v1.2.49). The rollback restores the same thing on both sides: the callers' pin (`v1`) and the hosts' tools (`hosts:install` at that tag).

Golden line: `Roll back: move v1 back to v1.2.51 (git tag -f v1 'v1.2.51^{commit}' && git push -f origin refs/tags/v1), then run mise run hosts:install on big-chungus from a clean checkout at v1.2.51 (it installs the Mac through hub-mac).`

## Verification

**Commands:**
- `node --test tools/ci/v11.test.mjs` -- expected: all pass
- `heavy mise run check` and `heavy mise run --tool node@26 check` -- expected: green

## Auto Run Result

Status: awaiting-operator

**Summary.** The pre-release half of Story 5.10 is done; the release itself is owed (see `operator_actions`). It cannot run from here: the release refuses a `main` that is not `origin/main`, and Epic 5 sits on local main until the orchestrator merges this story and pushes.
- **What the asker gets (`belsky-doctrine`):** Epic 5 is ready to ship as v1.2.52: `docs/hub-releases.md` has its section (nothing in it is a service; rolling back is `hosts:install` of v1.2.51; every operator-visible change; the intended test changes), and the check is green on Node 24 and Node 26 at this commit.
- **What the level gets (every hub release):** each tag annotation now carries a `Roll back:` line (logged `RELEASE_ROLLBACK`), computed from where `v1` pointed before the release, resolved to the highest release tag on that commit, the full commit when untagged, `none` for a new major. Never the previous version number, which v1.2.47/49/50 show can be a tag `v1` never stood on.
- **Hardening found in review:** `remoteTag` throws when `git ls-remote` fails instead of returning null, so a network blip can no longer read as "v1 is new" (which also used to let a red dry run delete `v1`) or "the tag is free".

**Files changed**
- `tools/release.mjs`: `pinTag`, `rollbackLine`, `tagMessage`'s optional `rollback` argument, rollback computed before the first tag and written into all four annotations, `remoteTag` throws on a failed lookup (optional `run` seam).
- `tools/ci/v11.test.mjs`: tests for `pinTag`, `rollbackLine`, `tagMessage`, `remoteTag`, a temp-repo round trip through pending/unknown/red/green (with `v1` on v1.2.48 while v1.2.49 exists), and the v1.2.52 section.
- `docs/hub-releases.md`: the `## v1.2.52` section.
- `README.md`: the release paragraph names the `Roll back:` line.
- `mise.toml`: the `hosts:install` description names each host's key.

**Review findings.** 23 findings: high 0, medium 2, low 14, false 7, maybe-false 0.
- **Patched (2 entries):** the `ls-remote` failure (medium; blind and edge rows), and the abbreviated commit in the rollback command (low; three rows).
- **Deferred:** none.
- **Rejected:** 17 rows, each with its reason in the Review Triage Log. In short: `release()` has no seams, so its wiring is checked by the first live release (an operator action reads `git show v1.2.52`); the hard-coded v1.2.51 is checked before the release (an operator action); the RED-annotation wording, local-only stale tags, a new major and leading-zero tags are cosmetic or unreachable; the AC 2/3/4 live surfaces are operator actions by the invocation's design; the old-pin clause rests on a probe plus `names.test.mjs`.

**Follow-up review recommended:** false. First pass; patched 1 medium and 1 low entry, no high.

**Verification**
- `heavy mise run check`: exit 0, 933/933 pass, 0 skipped, actionlint clean (Node 24), after the review patches.
- `heavy mise run --tool node@26 check`: exit 0, v26.13.0, 933/933 pass, after the review patches.
- `node --test tools/ci/v11.test.mjs`: 44/44 before the patches; the patched release tests pass in both full runs above.
- Test changes since v1.2.51 in the three pre-existing device suites: `hub-device.test.mjs` (status fixtures answer on the adb wire, Story 5.4), `lease.test.mjs` (`body()` strips `resource`, Story 5.2), `emulator.test.mjs` unchanged; no `phone` ordering assertion changed.
- Old-pin probe (throwaway, `/tmp/probe-5-10`, outside the repo): `v1.2.51`'s `lock.mjs` against HEAD-written state reads a `phone` Pool ticket as an ordinary waiter, refuses the held `s24` (`HUB_LOCK_TIMEOUT`) and an extension while the ticket waits, reads HEAD's events (ignoring `resource`), releases a HEAD-taken Lease, and sees a dead requester's ticket as stale.
- Matrix audit: all five I/O rows are covered by passing `v11.test.mjs` tests.

**Residual risks**
- `release()`'s new wiring (reading `previous` before the first tag, passing the line to all four annotations) is exercised only by the first live release.
- The host-key steps of `hosts:install` have never run over real ssh to the Mac (Story 5.3); until they do, live `status` shows every reading `unknown` and `discover` fails with `HUB_HOST_UNKNOWN`.
- The operator actions are agent-runnable under the standing release approval once main is pushed; they are listed here only because they must follow the orchestrator's merge.
