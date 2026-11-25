# Epic 5 Context: Agents can tell which phone is free, and wait in line for one

<!-- Generated from planning artifacts. Regenerate with compile-epic-context if planning docs change. -->

## Goal

An agent running `hub-device` can see each Resource's Reachability, which phones deploys install to, and which devices are visible but unregistered. It can ask for a phone by Capability, and the `phone` word holds a place in line instead of failing. Everything runs inside `hub-device` and `lock.mjs` with no service. The CLI is rebuilt on one Claims library that the later Hub API and Host Agent will share, so the CLI and the services can never take, refuse or report the same action differently. The epic ships as its own hub release; rolling back is `hosts:install` of the previous tag.

## Stories

- Story 5.1: One Claims library under an unchanged CLI
- Story 5.2: One reserved-word list, one slug rule, `res-*` locks queue
- Story 5.3: A host knows its own key
- Story 5.4: Status through one builder, with Reachability
- Story 5.5: Deploy targets are marked, from the committed declarations
- Story 5.6: Discover unregistered devices from the CLI
- Story 5.7: Ask for a phone by Capability
- Story 5.8: `phone` holds a place in line
- Story 5.9: No extension while a Pool or gate waiter sits behind
- Story 5.10: Ship the CLI release

## Requirements & Constraints

- No regression: `hub-device` keeps its commands, exit codes (75 away, 76 busy, 2 usage), `HUB_DEVICE_*` lines and `--json` shapes. It works with no service up, and `status` stays strictly read-only (no writes to the lock dir or Event Log). Existing suites (`hub-device.test.mjs`, `lease.test.mjs`, `emulator.test.mjs`) pass unchanged except named intended changes (`phone` ordering and wait line).
- Same action through the CLI or the library produces the same Hold, refusals, exit codes and events.
- The deploy path (`tools/ci/commands/*`, `tools/catchup/*`) must never import `claims.mjs`, `tools/registry/*`, `tools/hub-api/*`, `tools/host-agent/*` or `hub-client.mjs`. A conformance test enforces this with an extensible data table.
- Reachability is one enum (`reachable`, `unauthorized`, `offline`, `absent`, `unknown`) with its age shown. `unknown` is never shown as `reachable`. `unauthorized` keeps exit 75.
- In-memory seeding only: every `devices.json` Resource with its existing lock name, deploy targets marked. QA phone serials and allowed users never reach committed files or service-facing views.
- Discovery lists unregistered Android devices from the same read-only query as status, never starts or connects adb, and says "no adb server" when there is none.
- Capability requests: a Claimant gets one free, reachable match, or waits in every match's queue and takes the first that serves it. No match fails at once with the reason. Every match offline, absent or unauthorized fails at once with `HUB_DEVICE_AWAY` (75). A dedicated-QA phone is served only to a request that names it or asks for `dedicated_qa`.
- No Lease extension while any other Claimant waits, in every queue the Resource is served from. The Jarad override is recorded with who and why.
- Node 24 ESM only, no dependencies, no Python. Tests are hermetic (`hermetic()` from `tools/ci/test-fixtures.mjs`, injected seams). Nothing touches the live bucket, real devices or a real `qa-devices.json`. A status read answers in under 200 ms.
- Pinned older runs stay compatible: new fields and files are additive and old readers ignore them.

## Technical Decisions

- **Claims library (AD-24):** `tools/device/claims.mjs` owns resolve (id first, then word), take (Lease, phone, emulator), release, extend, `newLeaseId`, bounds checks (48 h max, 60 min cap for deploy targets) and the code-to-exit table as exported data. `hub-device.mjs` keeps only argument parsing and output. `takeLease` and `takeAnyPhone` are removed from it.
- **Names (AD-28, AD-29):** `lock.mjs` exports `SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/` (1 to 32 chars) and one frozen `RESERVED` list (CLI words, internal lock names, `s3-*`, `emulator-<n>`, `emulator-reaper`, `registry`, `hub-api`, `host-agent`, and the id shapes `res-*`, `l-*`, `e-*`, `job:*`). `devices.mjs`'s own reserved array is deleted. `isQueued(name)` is true for the v1a Queued set, `emulator-<n>` and `res-<slug>`, decided by name only. `lock.mjs` never reads `registry.json`. Hold events gain an additive `resource` field from a pure `resourceOf(lock)` seed map (`adb` to `s26`, `s24`, `mac-ios` to `ios-lane`, `emulator*` to the emulator Pool, or the `res-*` lock). A test keeps that map and `DEPLOY_TARGETS` in line with what `devices.json` derives.
- **Host key (AD-47):** `hosts:install` writes `~/.config/mobile-deploy-hub/host-key` (`linux` or `mac`). `claims.hostKey()` reads it behind a seam and checks it against `{linux: 'linux', mac: 'darwin'}`. A missing file or mismatch throws `HUB_HOST_UNKNOWN` (exit 1). "Is this action local?" is only `record.host === hostKey()`. `devices.json` is unchanged.
- **Reachability (AD-35):** one mapping function in `reachability.mjs`. adb `device` maps to `reachable`, `unauthorized` to `unauthorized`, `offline` to `offline`, not listed to `absent`, anything else to `unknown`. `status --json` keeps `presence` and adds `reachability` beside it. Only read-only transports are used (adb wire `host:version` and `host:devices-l` through `adb-wire.mjs`, never `findPhone`, never a server start). The CLI's status builder calls `reachability.mjs` itself on its own host. Ages are computed on the reader's clock.
- **Matcher (AD-33):** `tools/registry/match.mjs` is one pure `match(registry, request, policy)`. The `phone` Pool is `[s24, s26]` then runtime `kind: phone` Resources on `linux` that are not `dedicated_qa`. A seeded named list ignores the `dedicated_qa` exclusion, while a query applies it (Q1 default: FR-3 wins, the S24 stays in `phone`). Query form is `hub-device lease --match key=value[,key>=n]` (equality, `>=`, `<=`). A deploy target whose cap the request exceeds is dropped. All candidates share one host, otherwise `HUB_POOL_CROSS_HOST` (exit 2). No match is `HUB_NO_MATCH` (exit 2). A Pool request writes an identical ticket in every member's queue, and the winner alone withdraws the others (no event). The log gets one Pool-level `request` and one `acquire`, `timeout` or `cancel`. If a request ends up holding two members, the later is released with `reason: pool-duplicate`. A Pool request's ETA is the earliest member's range. The emulator Pool keeps its `emulator` gate.
- **Extension (AD-34):** `extendLease` reads the Resource's own queue (which holds Pool tickets) and, for an `emulator-<n>` slot, the `emulator` gate queue. It ignores the extender's own ticket and Pool tickets whose request already holds a member. `queueView` counts a Pool request once per member queue and marks it `pool`. The refusal names every waiter with its position.
- **Seeding source:** deploy targets and the seed come from the committed `tools/ci/devices.json`. QA phones come from `qa-devices.json` at runtime only, never importing `allowed_users`, behind a `qaDevices` seam.
- **Conventions:** problem-style codes follow the spine table (`HUB_DEVICE_AWAY` 75, busy 76). Test seams are `fetchImpl`, `sshImpl`, `watchImpl`, `qaDevices` and `hostKey`. One test per AD rule.

## Cross-Story Dependencies

- Story 5.1 comes first. Its Claims library and the conformance table are used by 5.3 (`hostKey`, `isLocal`), 5.7, 5.8 and 5.9, and by Epics 6 to 9.
- Story 5.2 (`RESERVED`, `isQueued`, `resourceOf`) must land before the `res-*` queueing and the matcher work in 5.7 and 5.8.
- Story 5.4 (status builder and Reachability) underlies 5.5 (deploy-target marks), 5.6 (discovery) and the away checks in 5.7 and 5.8.
- Story 5.5's in-memory seed feeds the matcher in 5.7.
- Story 5.10 ships only after 5.1 to 5.9 are on main. Release is `mise run release -- X.Y.Z`, then `hosts:install` on both hosts, which also writes each `host-key`.
- Epic 6 builds on this epic's Claims library, matcher, `RESERVED` list and status builder. The deploy path depends on none of it.
