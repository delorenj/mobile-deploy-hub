---
title: 'Story 2.8: Ship the freeze set (pre-release half)'
type: 'chore'
created: '2026-11-24'
status: 'in-progress'
route: 'dispatch'
review_loop_iteration: 0
baseline_commit: '2be18cb'
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-2-context.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Stories 2.1-2.7 are on main but nothing proves the freeze set is ready to ship as one pin (AD-20): `check.yml` tests Node 24 only (Story 1.5's Node 26 leg was never added) and has not gone green since Story 2.4, the hermetic suite has no event-sequence test for a whole deploy run, and a hub release carries no notes, so nobody reading the `v1.2.46` tag learns that fairness holds only among runs on that pin and later. MOBI-37, epic MOBI-29, AD-3, AD-20, AD-21, NFR-2, FR-17.

**Approach:** One level up, for every future hub release: `check.yml` runs the same `mise run check` task as a Node 24 and Node 26 matrix (`mise run --tool node@<n> check`; `mise.toml` keeps its Node 24 pin), and the suite is made green on a GitHub-hosted runner. `release.mjs` puts the `## vX.Y.Z` section of a tracked `docs/hub-releases.md` into the tag annotation (no section: today's annotation). The v1.2.46 section is written. Two event-sequence tests: a full deploy run through the real gate reservation, plan and android lane code, and a deploy job's timed-out wait.

**Decisions (autonomous, pre-approved):** The release run itself (`mise run release`, `hosts:install`, `v1`, first real deploy) is the parent session's, not this story's half. The full-run sequence pins the true AD-7 order: the Reservation's `release` precedes the lane's own `release` (renamed away before the lock is freed). The run's claim is made by `reserveFor('adb')`, the function the gate calls (the gate's call itself is pinned by `v11.test.mjs`). Tag messages are written with `--cleanup=whitespace` so a `#` line in the notes survives. `AGENTS.md` (the `CLAUDE.md` target) is left unedited; its stale "withLock does not join the FIFO" pitfall is handed to the parent for after the release.

## Boundaries & Constraints

**Always:** Node 24 ESM `.mjs`, `node:` builtins only. Hermetic tests (`hermetic()`, temp `HUB_LOCK_DIR`/`HUB_EVENT_DIR`, fakes; no live bucket, real adb or host state). Existing `tools/device/*.test.mjs` assertions keep their meaning; any changed one is a named intended change or a de-flake that keeps what it asserts. `check.yml` stays on `ubuntu-latest` (public repo). Tuning values only in `policy.json`.

**Never:** run `mise run release`, `hosts:install`, move tags or deploy; weaken the Node 24 pin of the `check` task; add a timer; a GitHub Release object for the hub; edit `AGENTS.md`/`CLAUDE.md`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Notes present | `docs/hub-releases.md` has `## v1.2.46` | tag annotation = header, the section body, then the dry-run lines | N/A |
| Notes absent | no section (or no file) | annotation exactly as today | N/A |
| Section bounds | next `## ` heading or EOF | body stops there, trimmed; `###` lines kept | N/A |
| Full deploy run | gate claim, plan hold, android hold with `endsReservation`, announce | `claim, request, acquire, release` (plan), `request, acquire, release(reservation), release` (android), nothing from announce; every event `hub_version` = `HUB_REF` | N/A |
| Timed-out wait | Lease holds `adb`, one waiter ahead, android job with a deadline | `request, timeout(deadline)`; `HUB_LOCK_TIMEOUT`, message names holder and waiter with place; ticket gone | N/A |

</frozen-after-approval>

## Code Map

- `.github/workflows/check.yml` -- one `check` job; add `strategy.matrix.node: ['24','26']`, `fail-fast: false`, install `node@<n>`, run `mise run --tool node@<n> check`.
- `mise.toml` `[tasks.check]` -- keep `tools = { node = "24", ... }`; print `node --version` first so each leg's log names its Node. `mise run --tool node@26 check` is proven to override the task tool (probe in a temp dir: v26.13.0).
- CI history: last green `d504f2b`; since `e558bd8` (Story 2.4) every run hangs until the 20 min timeout after the `tools/ci/*` files (first unreported file `tools/device/emulator.test.mjs`); earlier red runs were `emulator.test.mjs` timing tests (`status is read-only ...` :650 with a 3 s lease, `an emulator that dies while booting` :465). Diagnose on a 4-CPU reproduction (`taskset -c 0-3`) before changing tests.
- `tools/release.mjs` -- four `git tag -a`/`-f -a` calls build `mobile-deploy-hub ${tag}\n\n...`; add exported `releaseNotes(text, tag)` and `tagMessage(tag, status, notes)`, read `docs/hub-releases.md` once before tagging, log `RELEASE_NOTES`.
- `tools/ci/v11.test.mjs` :629 -- the release tests live here (`flipInnerRefs`); add the notes tests beside it.
- `tools/ci/v3.test.mjs` :719 `laneHost`, :822 real run end to end -- reuse for the full-run sequence (plan, android, announce with fakes); `reserveFor` from `tools/ci/commands/common.mjs`.
- `tools/ci/deadline.test.mjs` :93 `fixture`, :100 `holder` -- reuse for the timed-out wait; existing partial sequences: `lease.test.mjs` :1107, `deadline.test.mjs` :103/:197, `reservation-release.test.mjs` :144.
- `docs/hub-releases.md` (new), `README.md` "Changing a rule" and "Hosts and checks" -- name the notes file and the Node 26 leg.

## Tasks & Acceptance

**Execution:**
- [ ] `.github/workflows/check.yml`, `mise.toml` -- Node 24/26 matrix of the same task -- Story 1.5 AC folded into 2.8
- [ ] tests that fail or hang on a 4-CPU host -- make them deterministic without changing what they assert -- AC 1 (green in check.yml)
- [ ] `tools/release.mjs`, `tools/ci/v11.test.mjs` -- notes section into the annotation, pure helpers tested, `--cleanup=whitespace` round trip in a temp repo -- one mechanism for every hub release
- [ ] `docs/hub-releases.md` -- intro and the v1.2.46 section -- AC 4
- [ ] `tools/ci/v3.test.mjs`, `tools/ci/deadline.test.mjs` -- the two sequence tests -- AC 2
- [ ] `README.md`, `deferred-work.md` -- docs

**Acceptance Criteria:**
- Given main, when `mise run check` and `mise run --tool node@26 check` run locally, then both are green.
- Given a push, when `check.yml` runs, then a Node 24 and a Node 26 job both run `mise run check` and both finish green.
- Given `docs/hub-releases.md` with a `## v1.2.46` section, when that release tags, then the annotation carries the section; the section states that fairness holds only among runs on this pin and later and that older pins age out within 30 days, and summarises the Event Log, Queue, Reservations, deadlines, the Lease cap, AD-21 and the queued-timeout wording change.

## Spec Change Log

## Design Notes

Section body for a tag: everything after the `## vX.Y.Z` line up to the next line starting `## `, trimmed. `tagMessage('v1.2.46', status, notes)` = `mobile-deploy-hub v1.2.46\n\n<notes>\n\n<status>`; with no notes it is today's `mobile-deploy-hub v1.2.46\n\n<status>`.

## Verification

**Commands:**
- `node --test tools/ci/v11.test.mjs tools/ci/v3.test.mjs tools/ci/deadline.test.mjs` -- expected: all pass
- `heavy mise run check` and `heavy mise run --tool node@26 check` -- expected: green
- `taskset -c 0-3 node --test 'tools/**/*.test.mjs'` -- expected: finishes, green (the CI shape)
- after push: `gh run list --workflow check.yml` -- expected: both legs green
