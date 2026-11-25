---
title: 'Registry verbs in hub-device, and a clear message when the API is down'
type: 'feature'
created: '2026-11-25'
status: 'done'
baseline_revision: 'b21166285b038eb2c6c07ce1420b4192b3ecc5bc'
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-6-context.md'
warnings: ['oversized']
deferred: []
---

<intent-contract>

## Intent

**Problem:** The Hub API can register, edit and retire Resources (6.6, 6.7), but only over raw HTTP. Jarad has no shell verb for it, and nothing tells a caller plainly when the API is down rather than failing on a socket error (FR-1, FR-2, AD-17, AD-26, AD-27).

**Approach:** Add `tools/hub-client.mjs`, the same-host Hub API client, and the `hub-device registry add|edit|retire|list` verbs. Following belsky-doctrine, the level one up from "four registry verbs" is **every `hub-device` verb that calls the Hub API** (Epic 7's leases through the API, and 6.10's register-from-discovery). So the client is route-generic: one `call()` with the health probe, the `HUB_API_DOWN`/`HUB_API_UNKNOWN` classification, the wait-plus-30 s bound and problem+json decoding. It is shared by one CLI printer for API answers and one per-command flag-ownership table. A later verb adds a row and a print, and nothing else.

## Boundaries & Constraints

**Always:**
- `hub-client.mjs` `call({method, path, body, waitMs = 0}, {policy, fetchImpl, timeout, healthTimeoutMs = 2000, down})`:
  - The URL is `http://127.0.0.1:<policy.api.hub_api_port><path>`. `fetchImpl` defaults to `globalThis.fetch`, read at call time so `hermetic()` catches a leak. `timeout(ms)` defaults to `AbortSignal.timeout`.
  - First, `GET /health` is bounded at `healthTimeoutMs`. Any failure is `HUB_API_DOWN` (exit 1) with the message `down` (default `the Hub API is not answering; registry changes are unavailable, holds still work`) and nothing is sent. That covers a refused connect, a timeout, a non-200, non-JSON, and `service !== 'mobile-deploy-hub-api'`.
  - Then the request itself is bounded at `waitMs + 30_000`. A refused connect (`ECONNREFUSED` on `error.cause.code` or `error.code`) is `HUB_API_DOWN`. For a non-GET, any other transport failure, timeout included, is `HUB_API_UNKNOWN` (exit 1): "the Hub API did not answer after the request was sent; the change may have applied: run `hub-device registry list` to see". A GET failure is always `HUB_API_DOWN`.
  - A 2xx answer returns `{status, body}`. A `application/problem+json` answer throws an error that carries the problem's `code`, `status`, `exit`, `reason`, its `detail` as the message, every other member (`rev`, `holder`), `problem` (the body verbatim) and `api: true`. A non-2xx answer that is not a problem is `HUB_API_ERROR` (exit 1) for a GET, and `HUB_API_UNKNOWN` for a write.
- `claims.mjs` gains the following:
  - `EXIT_CODES` `HUB_API_DOWN: 1` and `HUB_API_UNKNOWN: 1`.
  - `registryWrite(op, {id, body}, ctx)`, where `op` is `add` (`POST /registry/resources`), `edit` (`POST /registry/resources/{id}`, id URI-encoded) or `retire` (`POST /registry/resources/{id}/retire`). It goes through `call()` with `ctx.fetchImpl` and the policy (`ctx.policy ?? loadPolicy().policy`).
  - `registryList({audience = 'local'}, ctx)`, which returns `{rev, source, resources, pools}`. The registry comes from `readRegistry` (fresh, with the QA loader `ctx.qaDevices ?? loadQaDevices`, and an unreadable-file warning through `ctx.warn`). Each record goes through `viewRecord` (hidden ones are dropped; a marked record's lock is read with `lockActivity`), and the pools through `viewPools`. It reads only the disk, and no service.
- CLI verbs. Every write sends `actor: {holder, via: 'cli'}`, where the holder is `--holder ?? $HUB_DEVICE_HOLDER ?? user@hostname`. `--why` passes through.
  - `registry add --kind K --name N [--model M] [--serial S] [--udid U] [--profile P] [--host H] [--cap k=v]... [--if-rev N] [--why T] [--holder W] [--json]`. The identity holds only the given `model`, `serial`, `udid` and `profile`, and is absent when none is given. `--host` defaults to this host's key (`hostKey()`; an unknown one is `HUB_HOST_UNKNOWN`, exit 1). It prints `HUB_DEVICE_REGISTERED <id> <name>` and `HUB_DEVICE_REV <rev>`, and exits 0.
  - `registry edit <id> [--name N] [--cap k=v]... [--uncap k]... [--if-rev N] ...` prints `HUB_DEVICE_EDITED <id> <name>` and `HUB_DEVICE_REV <rev>`. When `--if-rev` is absent, it sends the rev of `registry.json` on disk (`readRegistryFile`), or `0` when there is no file.
  - `registry retire <id> [--if-rev N] ...` prints `HUB_DEVICE_RETIRED <id> <visibility>` and `HUB_DEVICE_REV <rev>`.
  - `registry list [--json]` prints `REGISTRY rev <n> (<source>)`, one line per Resource (id, name, kind, host, lock, model, caps `k=v` comma-joined, plus `deploy target`, `seeded` and `[retiring]` where they apply), then `POOLS` with one line per Pool.
  - `--json` on any verb prints the response body (`list`: its object) as one JSON line on stdout.
  - `--cap k=v` takes `true` or `false` as a boolean, `-?\d+(\.\d+)?` as a number, and anything else as a string. `k=` or no `=` is `HUB_USAGE`. `--uncap k` is a `null` in the edit patch. A key given to both flags is `HUB_USAGE`. `--if-rev` must be a whole number.
- API errors on a registry verb go to stderr as one line, `<code> registry <detail> (reason: <reason>)`. `HUB_API_DOWN` and `HUB_API_UNKNOWN` print `<code> <message>`. The exit code is the problem's `exit`, else `exitCodeOf`. With `--json`, a problem body also goes to stdout. A local parse error stays `hub-device: <message>` and exits 2.
- Flags are owned per command in one table: `run` belongs to `reservation`; `name` to `reservation` and `registry`; `match` to `lease` and `run`; `kind`, `model`, `serial`, `udid`, `host`, `cap`, `uncap` and `if-rev` to `registry`. Each registry verb also refuses any flag outside its own list. Every refusal is `unknown flag --X` and exits 2, so every existing command keeps refusing the new flags.
- `docs/hub-api-contract.md` gets the error rows `HUB_API_DOWN` and `HUB_API_UNKNOWN` (status `none`, exit 1, client-side, never an HTTP answer). The README's Hub API paragraph names the verbs and both messages. The header usage block of `hub-device.mjs` and `USAGE` (appended at the end) name the verbs.

**Never:**
- No change to the routes, `handle()`, the store, the planners, the matcher, `lock.mjs` or any existing command's output, exit code or `--json` shape (AD-17).
- No cross-host transport, ssh or relay (Epic 7). No retry loop. No `setInterval`. No dependency and no Python.
- The deploy path (`tools/ci/commands/*`, `tools/catchup/*`) never imports `hub-client.mjs` (`deploy-path.test.mjs` already forbids it). `lease`, `run`, `release` and `status` never call the client.
- No test binds a port, reaches `globalThis.fetch` or opens the real QA file.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected | Error |
|----------|--------------|----------|-------|
| Add | `registry add --kind phone --name pixel --model "Pixel 9" --cap api_level=35`; fetchImpl routes into `handle()` | `HUB_DEVICE_REGISTERED res-pixel pixel`, `HUB_DEVICE_REV <n>`, exit 0. The file holds `api_level: 35` (number) and actor `{tester, cli}`. `--json` prints the 201 body | — |
| List after add | `registry list` (no fetchImpl at all) | a `res-pixel` line from the file; `--json` `{rev, source:'file', resources, pools}` | — |
| List no file | no `registry.json` | `REGISTRY rev 0 (seed)`, s24 and s26 listed | — |
| Edit | `registry edit res-pixel --name pixel-9 --cap api_level=36 --uncap old` | `HUB_DEVICE_EDITED res-pixel pixel-9`, rev +1 | — |
| Retire | `registry retire res-pixel` | `HUB_DEVICE_RETIRED res-pixel hidden` | — |
| API refusal | add `--name s26` | stderr `HUB_REGISTRY_NAME registry … (reason: reserved)`; exit 2 | problem exit |
| Refused | fetchImpl throws `{cause:{code:'ECONNREFUSED'}}` | stderr `HUB_API_DOWN the Hub API is not answering; registry changes are unavailable, holds still work`, exit 1; one fetch call (`/health`) | `HUB_API_DOWN` |
| Health silent | `/health` never settles (aborts on the injected timeout) | `HUB_API_DOWN`, the write never sent | `HUB_API_DOWN` |
| Write timed out | `/health` ok, the POST aborts on its timeout | exit 1 | `HUB_API_UNKNOWN` |
| Bound | `call({waitMs: 5000})` | the request's timeout is 35 000 ms and the health timeout is 2 000 ms | — |
| Lease with API down | `lease s24 …` with a fetchImpl that fails the test if called | exit 0; `lockActivity('s24')` held and `statusView` lists the Lease | — |
| Flag ownership | `lease s24 --kind phone …`, `status --cap a=1`, `registry list --for 1m` | exit 2, `unknown flag --kind` / `--cap` / `--for` | `HUB_USAGE` |
| Bad cap | `--cap api_level`, `--cap k=`, the same key in `--cap` and `--uncap` | exit 2, nothing sent | `HUB_USAGE` |

</intent-contract>

## Code Map

- `tools/device/hub-device.mjs`:
  - `VALUE_FLAGS` L73 and `parseArgs` L77 (repeatables: `env-serial` today; add `cap` and `uncap` as arrays `out.cap` and `out.uncap`, leaving `flags` and `envSerial` unchanged for the L92-95 test).
  - The `--run`/`--name`/`--match` ownership checks in `main` L563-566 become the table. `report` L145 is the error printer. `USAGE` L98. `main` seams L540 (add `fetchImpl`, put it on `context`). The holder default is the pattern at L206.
- `tools/device/claims.mjs`:
  - `EXIT_CODES` L40 (the frozen table, pinned by `claims.test.mjs` L59).
  - `createContext` L118. `lockActivity` L80. The policy load pattern `ctx.policy ?? loadPolicy().policy` is at L686. The QA loader pattern is `matchTarget` L225.
  - Imports already present: `readRegistry`, `readRegistryFile`, `loadQaDevices`. Add `viewRecord`, `viewPools` (`tools/registry/view.mjs`) and `call` (`tools/hub-client.mjs`).
- `tools/hub-api/routes.mjs` (read only): `SERVICE` L20, which the client's `HUB_API_SERVICE` must equal (assert it in a test); `handle()` L239, the in-process target of the fake fetch; the shapes of the register, edit and retire answers, L167-196.
- `tools/hub-api/edit-retire.test.mjs`: the harness to copy, with `scratch()`, `hermetic()`, made-up QA serials and `ctx` (`policy`, `now`, `hostId`, `devices`, `qaDevices`).
- `tools/clock.test.mjs` L15: `tools/hub-client.mjs` is already in `CLOCK_FILES` and `SERVICE_SCOPES`, so `AbortSignal.timeout` and `setTimeout` are allowed there. A self-rescheduling function is never allowed.
- `tools/deploy-path.test.mjs` L16: `hub-client.mjs` is already forbidden on the deploy path.
- `tools/hub-api/contract.test.mjs` L285-286: every `HUB_API_*` code in `EXIT_CODES` must have a row in the doc's Error codes table, with the same exit.
- `tools/ci/test-fixtures.mjs` `hermetic()` L39: it replaces `globalThis.fetch` with one that throws.
- `tools/device/hub-device.test.mjs` `fixture()` L58: the fake adb and the wire fixture, for the lease-with-API-down test.
- `README.md` L324: the Hub API paragraph.

## Tasks & Acceptance

**Execution:**
- `tools/hub-client.mjs` (new): `HUB_API_SERVICE`, `HEALTH_TIMEOUT_MS`, `CALL_MARGIN_MS`, `DOWN_MESSAGE`, `hubUrl(policy)` and `call()` as above.
- `tools/hub-client.test.mjs` (new): it is hermetic. It covers refused, health timeout, health non-200, a wrong service, write timeout (UNKNOWN), write refused (DOWN), GET failure (DOWN), problem decoding with extensions, the bound arithmetic (via the injected `timeout`), no fetch after a failed health check, and `HUB_API_SERVICE === routes.SERVICE`.
- `tools/device/claims.mjs` and `claims.test.mjs`: the two exit codes, `registryWrite` and `registryList`.
- `tools/device/hub-device.mjs`: the `registry` command, the flag table, the repeatables, the `fetchImpl` seam, the printer, `USAGE` and the header comment.
- `tools/device/registry-verbs.test.mjs` (new): every matrix row except "Lease with API down" goes through `main()`, with a fetchImpl that routes into `handle()` over the same temp lock dir. A QA-serial walk checks that a seed-imported QA phone's serial appears in `list` output (local audience) but in no API `--json` answer.
- `tools/device/hub-device.test.mjs`: the "Lease with API down" row.
- `docs/hub-api-contract.md` and `README.md`: as mapped.

**Acceptance Criteria:**
- Given the CLI suites (`hub-device.test.mjs`, `lease.test.mjs`, `lease-match.test.mjs`, `phone-queue.test.mjs`, `status-view.test.mjs`), when they run unchanged, then they pass (AD-17).
- Given `contract.test.mjs`, `clock.test.mjs` and `deploy-path.test.mjs`, when they run, then they pass with the new codes and file.
- Given `mise run check`, when it runs, then actionlint and the full suite pass.

## Spec Change Log

## Review Triage Log

### 2026-11-25 — Review pass
- verdicts: 31 findings — high 0, medium 0, low 21, false 10, maybe-false 0
- findings:
  - `[low]` `[patch]` (blind) `parseCap` turned `0123`, `1.10` and long digit strings into numbers that differ from the text. Fixed: a value becomes a number only when `String(Number(v)) === v` and it is finite. Tests cover `0123`, `1.10`, a 20-digit value, `1e999` and `+5`.
  - `[low]` `[reject]` (blind) `edit` without `--if-rev` sends the rev on disk, which defeats optimistic concurrency. This is a deliberate spec choice (Design Notes): the CLI has read nothing, and the patch is a merge. The CLI and the API share one `HUB_LOCK_DIR` by the hub's rules (AGENTS.md), so "a different lock dir" is outside any supported setup.
  - `[low]` `[patch]` (blind) `--cap __proto__=1` was swallowed by the prototype setter and the verb reported success. Fixed: `capabilitiesOf` builds on `Object.create(null)`, so the key reaches the API, which refuses it (`bad-capabilities`, exit 2). A test is added.
  - `[false]` `[reject]` (blind) `registry edit <id>` with nothing to change is sent. The API's `checkEditBody` answers `HUB_USAGE` `no-change` (exit 2) before any write (changes.mjs L167). The user gets a plain usage refusal, and the rev never moves.
  - `[false]` `[reject]` (blind) `HUB_API_ERROR` is not in the exit table or the doc. It is: `EXIT_CODES.HUB_API_ERROR: 1` (Story 6.4), and the doc has its 500 row. The client throws it only for a GET, and no verb issues one yet.
  - `[low]` `[patch]` (blind) The header says claims.test.mjs holds the client's hard-coded `exit: 1` equal to the table, but nothing compared a thrown error's `.exit`. Fixed: claims.test.mjs asserts `.exit` against `EXIT_CODES` for both DOWN and UNKNOWN. The deploy-path half of the claim is false: `deploy-path.test.mjs` walks imports transitively, with both `claims.mjs` and `hub-client.mjs` in FORBIDDEN.
  - `[low]` `[reject]` (blind) `HUB_API_DOWN` does not say which probe failed. The spec fixes one plain message (AD-27), and a cause field is new public surface that no caller needs yet.
  - `[low]` `[reject]` (blind) `--json` prints nothing on stdout for DOWN or UNKNOWN. The spec's `--json` is "the response", and there is none. A client-side JSON error shape would be new public surface. The exit code and the stderr code already tell DOWN (nothing applied) from UNKNOWN.
  - `[false]` `[reject]` (blind) After an UNKNOWN retire, `registry list` cannot show it. A retire targets a listed Resource. Afterwards `list` shows it `[retiring]` while it is held or waited on, or not at all once it is idle and hidden, and both mean the retire applied.
  - `[low]` `[patch]` (blind) Problem extension members named `message`, `name`, `stack` or `cause` overwrote the Error's own fields. Fixed: those four keys are added to the excluded `BASE` set, and a test is added.
  - `[low]` `[patch]` (blind) Weak tests. Fixed:
    - The vacuous `named`/`assert.ok` lines are removed.
    - The `--uncap` twice case asserts exit 0.
    
    Not changed:
    - The `user@hostname` default is the lease path's tested pattern.
    - Last-wins for repeated scalar flags is the existing `parseArgs` behaviour of every command.
  - `[low]` `[patch]` (edge) The API-answer printer was gated on the `registry` word and printed it literally, so a later API verb would fall through. Fixed: the branch keys on `error.api` or the DOWN/UNKNOWN codes alone, and prints the command word.
  - `[low]` `[patch]` (edge) `UNKNOWN_MESSAGE` names a registry command and could not be overridden. Fixed: `call()` takes an `unknown` option beside `down`, used on all three UNKNOWN paths, and a test is added.
  - `[low]` `[patch]` (edge) `--cap` numeric corruption (`1.10`, `007`, an overflow to Infinity serialising as null). Same root cause as the blind `parseCap` row; fixed there.
  - `[low]` `[patch]` (edge) A `__proto__` key is dropped. Same root cause as the blind row; fixed there.
  - `[false]` `[reject]` (edge) `--cap` keys are not validated client-side. The API validates them (`bad-capabilities`, exit 2) before any write, so no malformed key is stored. One rule in one place is the point (changes.mjs).
  - `[low]` `[reject]` (edge) An id of `.` or `..` is normalised by fetch to another path. Every resulting path answers a refusal, never a wrong write: `/registry` is 404, and `/registry/resources/retire` reaches the edit route with id `retire` and no change (`no-change`/`unknown`). Nobody types `.` as a Resource id, and the fix is a new guard.
  - `[false]` `[reject]` (edge) A no-op edit is sent or bumps the rev. The API refuses it with `no-change` (exit 2), and a no-op edit commits nothing (store `changed: false`).
  - `[false]` `[reject]` (edge) An unreadable file makes `edit` send `if_rev: 0`. The API refuses every write on an unreadable file with `HUB_REGISTRY_FORMAT` (exit 1), whatever the rev, so nothing is written.
  - `[low]` `[reject]` (edge) `--json` prints nothing on stdout for DOWN/UNKNOWN. Same as the blind `--json` row. The "(reason: undefined)" half is false, because `problem()` always sets `reason` (routes.mjs L56).
  - `[low]` `[patch]` (edge) Problem members could overwrite the Error's fields. Same root cause as the blind row; fixed there.
  - `[low]` `[patch]` (edge) The `--host` "never asked" assertion was vacuous. Same root cause as the blind weak-tests row; fixed there.
  - `[low]` `[patch]` (edge, claim) The exit-code equality claim was unenforced. Same root cause as the blind row; fixed there.
  - `[low]` `[patch]` (edge, claim) "One CLI printer for API answers" was registry-gated. Same root cause as the edge printer row; fixed there.
  - `[low]` `[patch]` (verification-gap) `registryList`'s lock read for a retired Resource (`retiring`, `[retiring]`) was never exercised. Fixed: a new test takes a real `acquireLease` on `res-pixel` and retires it through the CLI (answer `retiring`). `list` shows `[retiring]` and `--json` has `visibility: 'retiring'`. After `releaseLease` the line is gone.
  - `[low]` `[patch]` (verification-gap, other) The `--host` "never asked" assertion was vacuous. Same root cause as the blind weak-tests row; fixed there.
  - `[false]` `[reject]` (intent) No test exercises the real transport (port, real `ECONNREFUSED`). The epic forbids the shared suite from binding a port (epic-6-context). The real Node `fetch` refusal shape was checked by hand on this host: `TypeError` with `cause.code === 'ECONNREFUSED'` against a closed loopback port. `call()` against it answered `HUB_API_DOWN` with the AC message.
  - `[low]` `[reject]` (intent) "The Lease shows in the API when it returns" is checked only through the lock-dir readers. No route serves Leases until Epic 7/8, and the API keeps no state beyond the lock dir (AD-23). The test proves the lease never touches the client, and that `lockActivity` and `statusView` (the API's own readers) see it. The spec's Design Notes record this.
  - `[false]` `[reject]` (intent) `registry list` does not enforce "on big-chungus". Only big-chungus has `registry.json` (AD-32). Elsewhere `list` honestly answers `source: seed`, rev 0.
  - `[false]` `[reject]` (intent) The `waitMs` term has no caller. It is not a defect: the client is route-generic on purpose, and Epic 7's waiting lease calls pass it. The bound is tested with `waitMs: 5000` → 35 000 ms.
  - `[false]` `[reject]` (intent) The output line names are the implementer's choice. The AC asks for "the new id and `rev` as `HUB_DEVICE_*` lines", and `HUB_DEVICE_REGISTERED <id> <name>` plus `HUB_DEVICE_REV <rev>` satisfy it, as the spec specified.

## Design Notes

- **Health first, for every call.** AD-27 defines down as "refused, or `/health` silent for 2 s". Probing first is what makes `HUB_API_DOWN` mean that nothing was sent. Once the write is on the wire, only a refused connect can still prove that nothing applied.
- **"The Lease shows in the API when it returns."** The Hub API keeps no state beyond the lock dir (AD-23), and no route serves Leases until Epic 7/8. The test therefore checks the readers the API itself uses (`lockActivity`, `statusView`) over the same lock dir, and checks that the lease path never touches the client.
- **`edit` without `--if-rev`.** The CLI has read nothing, so the rev on disk is the honest base. The patch is a merge, and a concurrent writer still collides through `if_rev` at commit.

## Verification

**Commands:**
- `node --test tools/hub-client.test.mjs tools/device/*.test.mjs tools/hub-api/*.test.mjs tools/clock.test.mjs tools/deploy-path.test.mjs` -- expected: all pass
- `heavy mise run check` -- expected: actionlint clean, full suite green

## Auto Run Result

Status: done

**Summary.** Jarad (or any agent) can now register, edit, retire and list Registry Resources from the shell. When the Hub API is down, they are told so plainly.
- `hub-device registry add --kind phone --name pixel --model "Pixel 9" --cap api_level=35` prints `HUB_DEVICE_REGISTERED res-pixel pixel` and `HUB_DEVICE_REV <rev>`, and exits 0.
  - `--json` prints the API's response.
  - `--host` defaults to this host's key.
  - Every write records actor `{holder, via: 'cli'}`.
- `registry edit <id> [--name] [--cap k=v]... [--uncap k]...` prints `HUB_DEVICE_EDITED`. Without `--if-rev` it is based on the rev on disk.
- `registry retire <id>` prints `HUB_DEVICE_RETIRED <id> <hidden|retiring>`.
- `registry list [--json]` reads `registry.json` from disk (or the seed) and calls no service.
- An API refusal is one stderr line, `<CODE> registry <detail> (reason: <reason>)`, with the API's own exit code.
- With the API down, a write fails `HUB_API_DOWN` (exit 1), "the Hub API is not answering; registry changes are unavailable, holds still work", and nothing is sent. A write that was sent but never answered fails `HUB_API_UNKNOWN` (exit 1, "may have applied").
- Leases, runs, releases and status never call the API.

Following belsky-doctrine, the level one up from "four registry verbs" is **every `hub-device` verb that calls the Hub API** (Epic 7's leases through the API, 6.10's register-from-discovery). That level got three things:
- **One route-generic client**, `tools/hub-client.mjs` `call()`. It probes `/health` first (2 s), bounds the call at wait + 30 s, classifies DOWN and UNKNOWN, and decodes problem+json. Its messages can be overridden per caller.
- **One CLI printer** for API answers, keyed on the error, not the verb.
- **One flag-ownership table** (`FLAG_OWNERS`). A later verb adds a row and a print.

**Files changed** (after baseline `b21166285b038eb2c6c07ce1420b4192b3ecc5bc`)
- `tools/hub-client.mjs` (new): the same-host client.
- `tools/hub-client.test.mjs` (new): probe failures, the bounds, DOWN vs UNKNOWN, problem decoding, custom messages, and the service name equal to `routes.SERVICE`.
- `tools/device/claims.mjs`: `HUB_API_DOWN: 1`, `HUB_API_UNKNOWN: 1`, `registryWrite`, `registryList`, `registryRev`, and the `fetchImpl` and `timeout` seams on `createContext`.
- `tools/device/claims.test.mjs`: the exit table pin, the `registryWrite` routes and `.exit` equality, and `registryList` from the seed.
- `tools/device/hub-device.mjs`: the `registry` command, `--cap`/`--uncap` repeatables, `FLAG_OWNERS`, the API-answer printer, the `fetchImpl` and `timeout` seams, `USAGE` and the header.
- `tools/device/registry-verbs.test.mjs` (new): every matrix row through `main()` with `fetchImpl` routed into `handle()`. It also covers `[retiring]` with a real lease, `__proto__`, cap typing and the QA-serial walk.
- `tools/device/hub-device.test.mjs`: lease, status and release with the API down (the client is never called).
- `docs/hub-api-contract.md`: `HUB_API_DOWN` and `HUB_API_UNKNOWN` error rows (client side, status none, exit 1).
- `README.md`: the Hub API paragraph names the verbs and both messages.

**Review findings.** 31 findings: high 0, medium 0, low 21, false 10, maybe-false 0.
- **Patched (8 entries, all low):**
  - cap number typing keeps `0123`, `1.10` and long ids as strings;
  - `__proto__` keys reach the API;
  - the API-answer printer is keyed on the error, not the `registry` word;
  - the client takes an `unknown` message option;
  - problem members can no longer overwrite the Error's fields;
  - `.exit` equality with `EXIT_CODES` is tested;
  - vacuous and weak test assertions are fixed;
  - a `[retiring]` list test uses a real lease.
- **Deferred:** none.
- **Rejected, false (10):**
  - a no-op edit (two rows; the API answers `no-change`);
  - `HUB_API_ERROR` undocumented (it is);
  - UNKNOWN retire unverifiable via `list`;
  - client-side cap-key validation (the API validates);
  - unreadable file with `if_rev` 0 (the API refuses `HUB_REGISTRY_FORMAT`);
  - no real transport test (the suite binds no port; the real refused shape was checked by hand);
  - `list` not enforcing big-chungus;
  - `waitMs` with no caller;
  - the output line names.
- **Rejected, low (6),** each with its reason in the triage log:
  - `edit` without `--if-rev` (a deliberate spec choice);
  - DOWN with no cause field;
  - `--json` with no stdout on DOWN or UNKNOWN (two rows);
  - `.`/`..` ids (they only ever produce a refusal);
  - Lease visibility checked through the lock-dir readers (no Lease route until Epic 7/8).

**Follow-up review recommended: false.** This was the first pass, and only low entries were patched: high 0, medium 0, low 8.

**Verification**
- `node --test tools/hub-client.test.mjs tools/device/*.test.mjs tools/hub-api/*.test.mjs tools/clock.test.mjs tools/deploy-path.test.mjs`: 376/376 pass.
- `heavy mise run check`: exit 0, actionlint clean, 1163/1163 tests pass.
- Matrix audit: every row is covered by a test that ran and passed:
  - Add, List after add, List no file, Edit, Retire, API refusal, Refused, Health silent, Write timed out, Flag ownership and Bad cap, in `registry-verbs.test.mjs`;
  - Bound, in `hub-client.test.mjs`;
  - Lease with API down, in `hub-device.test.mjs`.
- Manual check: on this host a real `fetch` to a closed loopback port fails with `cause.code === 'ECONNREFUSED'`, and `call()` against it answers `HUB_API_DOWN` with the AC message.

**Residual risks**
- Nothing runs the Hub API in production yet; the systemd unit is Story 6.11. Until then every registry write on big-chungus answers `HUB_API_DOWN`, which is the intended message. `registry list` works now.
- `edit` without `--if-rev` is based on the rev on disk at send time, so it does not guard against a change the operator never saw. The merge-patch semantics limit the impact.
- No operator actions are owed: every acceptance criterion is in-repo.
