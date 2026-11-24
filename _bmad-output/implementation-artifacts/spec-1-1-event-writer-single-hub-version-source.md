---
title: 'Story 1.1: Event writer with a single hub-version source'
type: 'feature'
created: '2026-11-23'
status: 'done'
route: 'dispatch'
review_loop_iteration: 0
baseline_commit: '0e6c92b0f461cbd0603b95d15249fe8fb46a8163'
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-1-context.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Lock transitions leave no record once their lock dir is gone, and the hub version is only resolvable from the `_actions/` runner layout, so a catch-up or `hub-device` running from a release dir cannot name its own version. MOBI-24, epic MOBI-23, AD-9, AD-10.

**Approach:** Add `tools/ci/lib/events.mjs` (`appendEvent`, `readEvents`, `eventDir`, `hostId`) that writes one `O_APPEND` JSON line per event and never throws, and extend `hubRef()` in `receipt.mjs` with the release-dir layout as the one hub-version source. Nothing calls `appendEvent` yet: `lock.mjs` wiring is Stories 1.2 and 1.4.

## Boundaries & Constraints

**Always:** Node 24 ESM, `node:` builtins only. `events.mjs` imports only `receipt.mjs` and builtins (AD layer rule). Seams `{env, now, log, host, hostId, hubFile}` are injected; no direct `Date.now()` or `hostname()` in the logic (defaults only). Envelope keys (`format`, `ts`, `host`, `host_id`, `hub_version`) always win over caller-supplied keys. Every line is valid JSON, ends in `\n`, is at most 4096 bytes including the newline, and is a single `O_APPEND` write. A missing hub version is written as `unknown`. Existing `hubRef` results for `HUB_REF` and `_actions/` paths and the null for a local checkout are unchanged.

**Never:** Read `HUB_VERSION` anywhere. Throw from `appendEvent`. Touch `lock.mjs`, `hub-device` behaviour, `policy.json`, workflows, or add timers. Write outside `HUB_EVENT_DIR` in any test. Cut a release or run `hosts:install` (Story 1.5).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Append | `appendEvent({event:'acquire', lock:'adb'}, seams)` | one line in `<dir>/<YYYY-MM>.jsonl` (UTC month of `now`), envelope first, returns `true` | N/A |
| Default dir | no `HUB_EVENT_DIR` | `$XDG_STATE_HOME/mobile-deploy-hub/events`, else `~/.local/state/mobile-deploy-hub/events` | N/A |
| Unwritable dir | dir is a file, or read-only | logs `HUB_EVENT_LOG_FAILED <reason>`, returns `false` | never throws |
| Oversize | `why` or `reason` pushes line over 4096 B | longest free-text field cut (ends in `…`) until it fits, still valid JSON | if still too big with both empty: log `HUB_EVENT_LOG_FAILED` and skip |
| Concurrent | 20 processes append at once | every line parses, none torn, count equals appended | N/A |
| Hub version | `HUB_REF` > `_actions/` path > `releases/<ref>/` path > `null`; event shows `unknown` for null; `HUB_VERSION=9.9.9` ignored | per AD-10 | N/A |
| Read | `readEvents({env, since, until})` over two months, one bad line | events in file order within `[since, until)`; bad line skipped, counted | logs `HUB_EVENT_LOG_SKIPPED <file> malformed=<n>`; missing dir yields nothing |

</frozen-after-approval>

## Code Map

- `tools/ci/lib/receipt.mjs` -- `hubRef(env, file)` at `:20`; add the release-dir regex between the `_actions` match and `null`. Lock layout of installed releases is `~/.local/share/mobile-deploy-hub/releases/<ref>/tools/` (`common.mjs` `installCurrent`, `hosts.mjs:115`); `import.meta.url` is the real path, so the `current` symlink resolves to it.
- `tools/ci/lib/lock.mjs` -- reference only: seam names (`env`, `now` returning ms, `log`), `lockDir`, `hostname()` usage. Do not edit; its `host` stays `os.hostname()`.
- `tools/ci/hub.test.mjs:451` -- existing hubRef test; extend with the release-dir cases.
- `tools/ci/test-fixtures.mjs` -- `hermetic()`; it deletes every `HUB_*` var, so pass `HUB_EVENT_DIR` explicitly.
- `tools/device/lease.test.mjs` -- style reference for temp-dir fixtures.
- New: `tools/ci/lib/events.mjs`, `tools/ci/events.test.mjs`.

## Tasks & Acceptance

**Execution:**
- [x] `tools/ci/lib/receipt.mjs` -- `hubRef` resolves `HUB_REF`, the `_actions` path, then `…/mobile-deploy-hub/releases/<ref>/tools/ci/lib/receipt.mjs`, then `null` -- AD-10 single resolver
- [x] `tools/ci/lib/events.mjs` -- `eventDir`, `hostId` (Linux `/etc/machine-id`, Mac `IOPlatformUUID` via `ioreg`, `null` on failure, default cached per process), `appendEvent`, `readEvents` -- AD-8, AD-9; also the one `hostId` for Story 2.1 to import, since `lock.mjs` may import `events.mjs` but not the reverse
- [x] `tools/ci/events.test.mjs` -- hermetic tests for every matrix row, including a 20-process concurrent append -- NFR-5
- [x] `tools/ci/hub.test.mjs` -- release-dir `hubRef` cases and the `HUB_VERSION` guard -- AD-10

**Acceptance Criteria:**
- Given a temp `HUB_EVENT_DIR`, when `appendEvent` runs, then the file holds one valid line ending in `\n` with `format: 1`, `ts`, `host`, `host_id`, `hub_version`.
- Given an unwritable event dir, when `appendEvent` runs, then it logs `HUB_EVENT_LOG_FAILED` and does not throw.
- Given 20 concurrent appender processes, when all finish, then there are zero torn lines.
- Given `mise run check`, when it runs, then it is green.

## Implementation Notes

- Built directly in the build session: no implementation subagent was available to the run. The review layers (blind, edge-case, verification-gap) were done as one in-session pass; findings are in the triage log.
- Files: `tools/ci/lib/receipt.mjs` (hubRef release-dir layout, anchored on `mobile-deploy-hub/releases/<ref>/`), `tools/ci/lib/events.mjs` (new), `tools/ci/events.test.mjs` (new, 10 tests), `tools/ci/hub.test.mjs` (+1 test).
- Exports of `events.mjs` for later stories: `appendEvent`, `readEvents` (generator; `since` inclusive, `until` exclusive; a `stats` object and one `HUB_EVENT_LOG_SKIPPED <file> malformed=<n>` line per file), `eventDir`, `hostId`, `EVENT_FORMAT`, `EVENT_MAX_BYTES`. `appendEvent` returns a boolean; its extra seams are `host`, `hostId`, `hubFile`. `host_id` is `null` when the machine id is unreadable; `hub_version` is `unknown` when `hubRef` is null.
- Event files are created `0600` in a `0700` dir.
- `mise run check`: 490 tests pass, 0 fail.

## Spec Change Log

## Review Triage Log

| Finding | Verdict | Evidence |
|---|---|---|
| A caller key could forge `format`, `ts`, `host`, `host_id` or `hub_version` | false | Envelope keys are spread after the caller's event; test "the envelope wins over caller keys" |
| A bad clock (`NaN`) or a throwing logger could escape `appendEvent` | false | Both inside try/catch; asserted in the unwritable-dir test |
| Over-limit line with nothing truncatable (huge `blocked_by`) is dropped | low, accepted | Logged as `HUB_EVENT_LOG_FAILED E2BIG`; no producer builds such an event, and a later story can cap its own arrays; tested |
| `readEvents` reads whole month files into memory | low, accepted | Rotation is deferred by the spine until 100 MB; monthly files bound it |
| `hostId` could be a second host-identity resolver beside Story 2.1's | low, resolved | Recorded in Design Notes: Story 2.1 imports it from `events.mjs` |
| `release-dir` regex could mis-match an unrelated `releases/` dir | false | Anchored on `mobile-deploy-hub/releases/`; negative test for `/srv/releases/` |

## Design Notes

`hostId` lives in `events.mjs` rather than `lock.mjs` because the spine's import direction (`lock` to `events`) forbids the reverse and `events` needs it for the envelope. Story 2.1 (machine identity) must import it, not add a second resolver. The failure marker defaults to `console.error` so a stray call can never pollute the stdout that `hub-device lease` reserves for `export` lines; `lock.mjs` will pass its own `log`.

## Verification

**Commands:**
- `node --test tools/ci/events.test.mjs tools/ci/hub.test.mjs` -- expected: all pass
- `mise run check` -- expected: green
