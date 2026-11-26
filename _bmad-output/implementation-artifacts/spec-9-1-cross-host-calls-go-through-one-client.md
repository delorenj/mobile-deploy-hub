---
title: 'Story 9.1: Cross-host calls go through one client'
type: 'feature'
created: '2026-11-26'
status: 'done'
baseline_revision: 'a7a6247e0e267684aaa16d0cf8c4dd851684eb23'
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-9-context.md'
warnings: ['oversized']
deferred: []
---

<intent-contract>

## Intent

**Problem:** `tools/hub-client.mjs` only reaches the Hub API on this host's loopback. Epic 9 needs big-chungus and the Mac to call each other's loopback service, and AD-26 allows exactly one way to do it: ssh plus a relay that notices a vanished client, so no forwarded wait is left as a ghost waiter.

**Approach:** Add a host-addressed `request()` to `hub-client.mjs`. A same-host call is `fetch` to the host's own front door on loopback. A peer call is ssh, with the fixed AD-26 option set, running `hub-client.mjs relay <method> <path>` on the peer. The relay reads the body from stdin, takes a newline heartbeat, calls the peer's own loopback front door and writes status, headers and body back. The client turns that into a `fetch` `Response`. Any failure of the ssh leg is `HUB_DEVICE_AWAY` (exit 75, `reason: host-unreachable`).

## Boundaries & Constraints

**Always:**
- One module: the transport, the relay and the `relay` CLI entry all live in `tools/hub-client.mjs`. Seams: `sshImpl` (spawns ssh: `(argv) => child` with `stdin`, `stdout`, `stderr`, `kill`, `on('close'|'error')`), `fetchImpl`, `hostKey` (a function returning this host's key), `devices`, `policy`, and `timers` (`setInterval`, `clearInterval`, `setTimeout`, `clearTimeout`). The defaults are `/usr/bin/ssh` via `child_process.spawn`, the global `fetch` read at call time, `loadDevices()`, `loadPolicy()` and the global timers.
- ssh argv, exactly: `-T -o BatchMode=yes -o ConnectTimeout=<api.peer_connect_timeout_s> -o ControlMaster=no -o ControlPath=none -o ServerAliveInterval=15 -o ServerAliveCountMax=2 <alias> <command>`. `<alias>` is `devices[<target key>].host` (`mac.host` = `hub-mac` from big-chungus, `linux.host` = `big-chungus` from the Mac). It must match `/^[A-Za-z0-9.-]+$/`, and the target key must be `linux` or `mac`.
- `<command>` is one string of single-quoted words joined by spaces, with `'` written as `'\''` (the `catchup.mjs:943` escaping): `<peer node> <peer script> relay <METHOD> <path>`. The peer node is `.local/share/mise/installs/node/24/bin/node` and the peer script is `.local/share/mobile-deploy-hub/current/tools/hub-client.mjs`. Both are fixed paths under the login home, which is where ssh starts the command (the `hosts.mjs:201` precedent). Neither ever goes through a `PATH` lookup.
- Front-door port by key: `linux` uses `api.hub_api_port`, `mac` uses `api.host_agent_port`. The relay takes its own key from `hostKey()` and calls `http://127.0.0.1:<that port><path>`.
- Call bound = `waitMs + budgetMs + CALL_MARGIN_MS` (30 s). Same host: the fetch signal aborts at the bound. Peer: ssh is killed at the bound + 10 s.
- Relay wire, stdin: line 1 is the JSON body, or empty for none. After that, every byte is a heartbeat. The client writes `\n` every `api.stream_keepalive_s` seconds from one `setInterval`, cleared when the call ends. The relay aborts its loopback request on stdin EOF or when 3 intervals pass with no byte. Its idle timer is one `setTimeout` re-armed with `.refresh()`, never a self-rescheduling function.
- Relay wire, stdout: line 1 is a JSON head, either `{"format":1,"status":<n>,"headers":{…}}` followed by the raw body bytes to EOF, or `{"format":1,"error":{"code":"<cause code>","message":"…"}}`. The client rejects an error head as `Object.assign(new TypeError('fetch failed'), {cause: {code}})`, so callers classify a peer-side failure exactly as they would a same-host `fetch` failure.
- Errors are built in `hub-client.mjs` with `exit` written literally (it must not import `claims.mjs` statically). `claims.test.mjs` keeps `HUB_DEVICE_AWAY`'s `exit` equal to `EXIT_CODES`. The `relay` entry may `await import('./device/claims.mjs')` for `hostKey` at run time only.

**Never:** no bare `curl` or second transport, no retry, no timer other than the call's heartbeat interval, the relay's idle timeout and the bound kill (all cleared with the call), no `ssh` control socket reuse, no change to `call()`'s classification, and no caller wiring (forwarding is Story 9.3). The deploy path (`tools/ci/commands/*`, `tools/catchup/*`) still never imports this file.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Same host | `request({host: hostKey(), …})` | `fetchImpl('http://127.0.0.1:<own port><path>')` with a JSON body/headers and a signal at the bound; no ssh is spawned | fetch errors propagate unchanged |
| Peer | `host` ≠ `hostKey()` | one ssh spawn with the exact argv; body line written, then a heartbeat per interval; a `Response` equal to the relay's head and body | none |
| Path `/x?a=1&b='c'` | peer call | the command run by `sh -c` and `zsh -c` yields the words `relay`, `POST`, `/x?a=1&b='c'` intact | none |
| Peer service refused | relay fetch gets ECONNREFUSED | error head; client rejects with a TypeError whose `cause.code` is `ECONNREFUSED` | caller classifies it as for a same-host fetch |
| ssh cannot connect | child exits 255 with no head | `HUB_DEVICE_AWAY`, exit 75, `reason: host-unreachable`, `api: false`; the message names the host, its alias and `connect timeout 5 s` | no hang, no retry |
| ssh spawn error, unparsable head, bound + 10 s passes | as stated | same `HUB_DEVICE_AWAY`; on the bound path ssh is killed | heartbeat cleared |
| Client vanishes mid-wait | relay stdin EOF, or 3 intervals with no byte | relay aborts its loopback request, and the server records `cancel` (`reason: aborted`) | relay writes nothing and exits non-zero |
| Bad relay args | method not GET/POST/PUT/PATCH/DELETE, path not starting `/`, path with whitespace or control characters, body line not JSON | error head with code `HUB_RELAY_USAGE`, exit 2 | no request is made |

</intent-contract>

## Code Map

- `tools/hub-client.mjs` -- the existing same-host `call()`, `hubUrl`, `bounded()`, `CALL_MARGIN_MS` and `requeueable`. The new transport, the relay and the CLI entry go here. Header comment line 15 ("cross-host transport is Epic 7") is stale and must be rewritten.
- `tools/hub-client.test.mjs` -- the hermetic style to follow: `fake()` fetch and an injected `timeout`, with `hermetic()` making the global fetch throw.
- `tools/hub-api/server.mjs:84` `requestListener(ctx)` -- aborts the handler's signal when `res` closes before the answer is written. `tools/hub-api/waits.test.mjs:67-86,199-215` shows the fake req/res, the driven clock and the disconnect→`cancel` assertion. Reuse that pattern to build a listener-backed `fetchImpl` for the cancel and two-transport tests.
- `tools/hub-api/routes.mjs:447` `handle()` and `ROUTES` -- the routes both transports call in tests.
- `tools/catchup/catchup.mjs:937-944` -- the single-quote escaping and home-anchored remote path precedent. Do not import it: catchup is the deploy path, so copy the rule.
- `tools/ci/lib/devices.mjs:67` `loadDevices()` -- `mac.host: 'hub-mac'`, `linux.host: 'big-chungus'`.
- `tools/ci/lib/policy.mjs` `loadPolicy()` -- `api: {hub_api_port: 8794, host_agent_port: 8795, stream_keepalive_s: 15, peer_connect_timeout_s: 5}`.
- `tools/device/claims.mjs:55-105,163-180` -- `EXIT_CODES` (`HUB_DEVICE_AWAY: 75`), `hostKey()` and `isLocal`. `claims.mjs` imports `call` from hub-client, so hub-client must not import it statically.
- `tools/device/claims.test.mjs:89,475-480` -- where hub-client error exits are held equal to `EXIT_CODES`. Add AWAY here.
- `tools/clock.test.mjs:16-17` -- `hub-client.mjs` is already in `CLOCK_FILES`. Rule 3 forbids self-rescheduling `setTimeout`.
- `tools/deploy-path.test.mjs:16` -- hub-client is forbidden for the deploy path. No change.
- `docs/hub-api-contract.md` -- client-side error table (line ~523). Add the cross-host transport and the relay wire.

## Tasks & Acceptance

**Execution:**
- `tools/hub-client.mjs` -- add the exported `quoteWord`, `remoteCommand({method, path}, {node, script})`, `sshArgv(alias, command, policy)`, `aliasFor(key, devices)`, `frontDoorPort(policy, key)`, `boundMs({waitMs, budgetMs})`, `request({host, method, path, body, waitMs, budgetMs}, seams)` → `Response`, `relay({method, path, stdin, stdout, policy, hostKey, fetchImpl, timers})` → exit code, and `main(argv)` plus the realpath entry guard (as in `server.mjs:275`). Rewrite the header comment -- the one cross-host client (AD-26, AD-47, AD-48).
- `tools/hub-client.test.mjs` -- add hermetic tests for every matrix row: exact argv and command; the quoting through real `sh -c` and `zsh -c`, with node `printf` and script `%s\n` (skip zsh only when it is not installed); one route through both transports gives equal status, body, `X-Request-Id` and content type (a fake `sshImpl` runs `relay()` in-process over PassThrough streams); the heartbeat count under fake timers; stdin EOF mid-wait and 3 silent intervals each produce a `cancel` event over a temp lock dir; the AWAY cases; the bound-plus-10 s kill; relay usage errors.
- `tools/device/claims.test.mjs` -- assert that an AWAY from `request()` carries `exit === EXIT_CODES.HUB_DEVICE_AWAY`.
- `docs/hub-api-contract.md` -- add a "Cross-host calls" section covering the ssh argv, the command, the relay wire and AWAY `host-unreachable`.

**Acceptance Criteria:**
- Given the full suite, when `mise run check` runs, then it is green, including the clock, deploy-path and hub-client tests.
- Given `main(['relay', 'GET', '/health'], seams)` with injected stdin (an empty first line), stdout, `hostKey` and a fake `fetchImpl`, when it runs, then stdout's first line is the JSON head with status 200, the remaining bytes are the health body exactly, and the fetch went to `127.0.0.1:<front-door port of that key>/health`.
- Given `node tools/hub-client.mjs` with no `relay` or bad arguments, when it runs, then it prints usage on stderr and exits 2.

## Spec Change Log

## Review Triage Log

### 2026-11-26 — Review pass
- verdicts: 20 findings — high 3, medium 2, low 10, false 5, maybe-false 0
- findings:
  - `[low]` `[patch]` (blind) After the relay forwards a write, a failed ssh leg (bound kill, or ssh dying mid-call) is AWAY, yet the doc said "nothing was sent" — the AWAY row now says AWAY does not prove a write did not apply.
  - `[low]` `[reject]` (blind) `request()` does not validate method or path, so the two transports reject bad input differently — rejected because callers are hub code passing literal routes, so nobody meets this in normal use, and the fix adds a guard branch. Grouped with the edge-case finding on the same point.
  - `[false]` `[reject]` (blind) Output from shell startup files would corrupt the stdout head line — ran `ssh -T hub-mac ':'`, `ssh -T big-chungus ':'` and `zsh -c ':'` and each printed 0 bytes.
  - `[high]` `[patch]` (blind) The default ssh spawn, `hostKey` and `devices` paths never run in a test — the untested default `hostKey` path hid a real deadlock: the relay entry's top-level await plus the dynamic import of `claims.mjs`, which imports hub-client back. Grouped with verification-gap #2. The fix is listed there.
  - `[false]` `[reject]` (blind) "One client" is not enforced, since other files still use ssh or curl — those calls (`catchup.mjs`, `hosts.mjs`, `ci/*`) are deploy-path or install ssh. None of them calls a Hub service. AD-25 keeps the deploy path off services.
  - `[low]` `[reject]` (blind) Bodies are buffered without a cap on both sides — Hub answers are small JSON documents, nobody meets this in normal use, and a cap adds a guard.
  - `[low]` `[patch]` (blind) stderr is capped before appending, the error codes are not all in the table, and the relay's exit codes are only partly documented — stderr is now capped after appending, and the docs list relay exits 0, 1 and 2 and the `HUB_*` error-head mapping.
  - `[low]` `[reject]` (blind) Redirects are followed, repeated headers collapse, HEAD and OPTIONS are unsupported, and there is no `child.stdout` error handler — Hub routes never redirect or repeat headers, nobody meets this in normal use, and each fix adds a guard.
  - `[low]` `[patch]` (edge) An alias starting with `-` would be parsed by ssh as an option — `aliasFor` now requires a leading alphanumeric, and a test covers `-oProxyCommand=x`.
  - `[low]` `[reject]` (edge) `request()` does not validate method or path — rejected for the same reason as the matching blind finding.
  - `[low]` `[reject]` (edge) A `waitMs` or `budgetMs` that is NaN or over 2^31 ms makes the kill timer fire at once — callers pass waits bounded by policy, nobody meets this in normal use, and the fix adds a guard.
  - `[low]` `[patch]` (edge) A vanish between the first line and the resumed await let the relay continue — the check is now `if (text === null || gone) return done(1)`.
  - `[low]` `[reject]` (edge) The relay's idle limit uses the peer's own `stream_keepalive_s` — the two only differ mid-rollout of a policy change, which is a hub release installed on both hosts. Carrying the interval on the wire is more than a direct fix.
  - `[medium]` `[patch]` (edge) The relay's own refusals (`HUB_HOST_UNKNOWN`, a policy load failure) reached callers as `TypeError('fetch failed')`, not AWAY — an error head whose code starts `HUB_` (other than `HUB_RELAY_USAGE`) is now `HUB_DEVICE_AWAY` carrying the relay's message, and a test covers it.
  - `[medium]` `[patch]` (verification-gap) The entry guard was never run through a symlink, though production runs it via `current` — a new test spawns the real entry through a temp symlink with stdin held open.
  - `[high]` `[patch]` (verification-gap) The relay never ran as a real process with stdin open — verified live: `node tools/hub-client.mjs relay GET /health` printed nothing and never exited (module-cycle deadlock under top-level await). The entry now uses `main().then(...)`. Rerun live against big-chungus's Hub API it answered in 49 ms and exited in 54 ms, and a new test spawns the real entry and asserts it exits by itself.
  - `[false]` `[reject]` (intent) `PEER_NODE` is a home-relative path, not an absolute one — sshd starts the command in the login home, so the path names one fixed interpreter and never goes through `PATH`. The `hosts.mjs:201` precedent works in production.
  - `[high]` `[patch]` (intent) Tests exercise only seams, never the real transport — grouped with verification-gap #2: the real relay process is now covered. A real ssh leg needs the peer to run a release that has the relay, which is Story 9.8's install.
  - `[false]` `[reject]` (intent) No caller is migrated to `request()` — the story's acceptance criteria are the client itself. Wiring callers is Story 9.3.
  - `[false]` `[reject]` (intent) The operator-gated reading (awaiting-operator) — Story 9.1 has no step that only a human can perform.

### 2026-11-26 — Review pass
- verdicts: 30 findings — high 1, medium 4, low 14, false 11, maybe-false 0
- findings:
  - `[low]` `[patch]` (blind) ssh stderr was named only for exit 255, and only its first line, so a missing peer node (exit 127) or a "Warning: Permanently added" banner hid the cause — the client now keeps the last 500 stderr characters, names the last non-empty line for every exit with no answer, and a test covers exit 127 behind a banner.
  - `[false]` `[reject]` (blind) `main(...).then(...)` has no `.catch`, so a relay throw is an unhandled rejection — every throwing step in `relay()` is already caught and becomes an error head. An unexpected throw would still exit non-zero with no head, which the client reports as AWAY, the documented answer for a relay that cannot run. That is a loud failure, not a defect.
  - `[low]` `[reject]` (blind) The relay has no `stdout` error handler, so EPIPE crashes it when the client dies mid-write — the client is already gone, and its loopback request is already finished, so only a process that is exiting anyway prints a stack. Nobody meets this in normal use, and the fix adds a guard.
  - `[low]` `[reject]` (blind) Memory is unbounded on both ends, and there is no streaming — carried: same claim as the earlier "Bodies are buffered without a cap on both sides" row. Hub answers are small JSON documents.
  - `[low]` `[patch]` (blind) New error codes are missing from the error table, and `HUB_USAGE`'s exit 2 from `request()` is not held equal to `EXIT_CODES` — the table half is carried from the earlier patched row (the docs now list the relay exits and the `HUB_*` mapping). The pinning half is real, because the header says every error's exit is held equal. `claims.test.mjs` now asserts `request({host:'nope'})` gives `exit === EXIT_CODES.HUB_USAGE`.
  - `[low]` `[patch]` (blind) The relay cannot be driven by hand, because stdin EOF counts as a vanished client — the contract's relay section now gives the recipe `(echo; sleep 60) | node tools/hub-client.mjs relay GET /health`.
  - `[low]` `[patch]` (blind) The evil-path quoting test ran `sh -c` in the repo cwd, so a quoting regression would drop `pwned` into the checkout — it now runs in a scratch dir that is removed afterwards.
  - `[false]` `[reject]` (blind) The relay-entry test could reach real host state through a host-key env override — `claims.hostKey()` reads only `$HOME/.config/mobile-deploy-hub/host-key`, there is no env override, and the test sets `HOME` to a scratch dir.
  - `[false]` `[reject]` (blind) The claims AWAY test is fragile: dynamic imports and one `setImmediate` — `request()` spawns after a single microtask, and `setImmediate` runs after every pending microtask, so the test is deterministic. The import style alone names no harm.
  - `[false]` `[reject]` (blind) Relay head and body edge cases are untested: a `null` body, `\r\n`, a 1xx or >599 status, HEAD and OPTIONS — each behaves consistently. `null` is sent as the JSON `null` by both transports. `JSON.parse` tolerates a trailing `\r`. `parseHead` turns an out-of-range status into AWAY. HEAD and OPTIONS are outside the five methods the intent lists.
  - `[false]` `[reject]` (blind) The relay forwards any route with no allow-list — the relay reaches only its own host's loopback front door, which serves its own route table, and only over key-authenticated ssh, which already grants a shell. No exposure is added.
  - `[low]` `[reject]` (edge) A same-host `request()` path is not checked to start with `/`, so `@other.host` would rewrite the URL host — carried: same location and claim as the earlier "`request()` does not validate method or path" rows. Callers are hub code that pass literal routes.
  - `[false]` `[reject]` (edge) In `request()`, a `hostKey()` that throws lets raw `HUB_HOST_UNKNOWN` escape, and an unexpected key silently takes ssh — `claims.hostKey()` returns only `linux` or `mac` or throws `HUB_HOST_UNKNOWN`. That code is the established vocabulary, mapped to 503 `host-unknown`, and callers can tell it apart from AWAY by its code.
  - `[medium]` `[patch]` (edge) A peer fetch failure with no cause code defaulted to `HUB_RELAY_FETCH`, which starts with `HUB_`, so the client classified it as AWAY instead of a TypeError — grouped with verification-gap #1/#3 and intent #1, all from the ad hoc `HUB_` prefix split. The default is now `RELAY_FETCH_FAILED`, which is not `HUB_`. The relay's own refusals always send a `HUB_` code through `refusalCode()`. A test drives a code-less fetch failure through both transports to a TypeError.
  - `[low]` `[patch]` (edge) `JSON.stringify(body)` ran after ssh was spawned, so a BigInt or circular body became AWAY "ssh did not start" — the body line is now serialized before the spawn, so the error is the caller's TypeError and no ssh is started. Tested. Grouped with the next row.
  - `[low]` `[patch]` (edge) The spawn `catch` path did not kill the ssh child — the catch now kills the child before reporting AWAY. It shares the root cause and the fix with the row above.
  - `[low]` `[reject]` (edge) An unhandled relay `stdout` EPIPE — same claim as the blind EPIPE row. Rejected for the same reason.
  - `[false]` `[reject]` (edge) `main()` has no rejection handler in the real entry — refuted the same way as the blind `.catch` row.
  - `[low]` `[reject]` (edge) Repeated headers collapse in `Object.fromEntries` — carried: same claim as the earlier "repeated headers collapse" row. Hub routes never repeat a header.
  - `[low]` `[reject]` (edge) The client's `chunks` are unbounded — carried: same claim as the earlier buffering row.
  - `[low]` `[reject]` (edge) `request()` passes a bad verb or path through to the peer — carried: same claim as the earlier request-side validation rows.
  - `[medium]` `[patch]` (verification-gap) The relay's "no policy" refusal had no test, and an edit at `hub-client.mjs:264` would pass every test — grouped with edge #3. There is now a real-process test: a copy of the module runs with no `policy.json` beside it and must exit 1 with a `HUB_RELAY_ERROR` head, and its stdout is fed to the client, which must read it as `HUB_DEVICE_AWAY`.
  - `[low]` `[patch]` (verification-gap) The "drops only hop headers" test never supplied a hop header — the fake peer response now carries `connection`, `keep-alive`, `transfer-encoding`, `content-encoding` and `content-length`, and the head must contain only `content-type` and `x-keep`.
  - `[medium]` `[patch]` (verification-gap) A missing `policy.json` throws `ENOENT`, which the relay sent as the head code, so the client turned it into `TypeError` (cause `ENOENT`), not the AWAY the contract states — confirmed: `loadPolicy` uses `readFileSync`. Grouped with edge #3. `refusalCode()` now sends `HUB_RELAY_ERROR` for any refusal without a `HUB_` code, and the real-process test above covers it.
  - `[medium]` `[patch]` (intent) The hybrid `HUB_`-prefix classification has a side effect: a code-less fetch failure (`HUB_RELAY_FETCH`) becomes AWAY — same defect as edge #3. Fixed there.
  - `[false]` `[reject]` (intent) The alias regex is stricter than the literal `/^[A-Za-z0-9.-]+$/` — every real alias (`hub-mac`, `big-chungus`) passes. The only names refused in addition start with `.` or `-`, and those are ssh option injection, which the intent's rule exists to stop. No bad outcome.
  - `[high]` `[patch]` (intent) No test reaches real ssh, a real socket or the installed peer — carried: same claim as the earlier "Tests exercise only seams" row, which is already patched (the real relay process is spawned). The real two-host ssh leg needs Story 9.8's install. No new action.
  - `[false]` `[reject]` (intent) The contract doc records the diff's readings (AWAY for `HUB_` refusals, dropped hop headers, the GET-body refusal) — each reading is consistent with the intent's text. Hop and encoding headers describe bytes `fetch` already decoded. A GET body is not valid usage. AWAY for "the relay cannot run" is the intent's "any failure of the ssh leg".
  - `[false]` `[reject]` (intent) `request()` defaults `hostKey` through a dynamic import of `claims.mjs` — `hostKey` is in the intent's seam list. The import is run-time only, so it keeps the "never statically" rule and avoids the module cycle.
  - `[false]` `[reject]` (intent) A `timeout` seam was added for the same-host signal — it is a seam over `AbortSignal.timeout`, not a timer, and it adds no runtime clock. The intent's timer rule holds.

## Design Notes

"Absolute node path" is read as one fixed interpreter, never a `PATH` lookup. Single-quoted words cannot expand `$HOME`, and the two homes differ (`/home/…` and `/Users/…`), so the words are anchored at the login home, where sshd starts every command. The catch-up and `hosts.mjs` already rely on that.

The relay's head-line framing keeps the body byte-exact, so the client can build a real `Response`. A 204 or 304 status gets a `null` body.

## Verification

**Commands:**
- `node --test tools/hub-client.test.mjs tools/clock.test.mjs tools/deploy-path.test.mjs tools/device/claims.test.mjs` -- expected: all pass.
- `mise run check` -- expected: green.

## Auto Run Result

Status: done (follow-up review pass)

**Summary:** `tools/hub-client.mjs` is the one cross-host client (AD-26).
- `request({host, method, path, body, waitMs, budgetMs})` returns a `fetch` `Response`.
  - A call to this host's own front door is a loopback `fetch`, bounded at wait + budget + 30 s.
  - A call to the peer is one ssh spawn with the exact AD-26 option set. It runs `hub-client.mjs relay <METHOD> <path>` from the peer's installed release. The client writes the body line, then a heartbeat each interval, and kills ssh at the bound + 10 s.
- The relay calls its own host's front door. It aborts on stdin EOF or after 3 silent intervals, so the far service records `cancel (aborted)`. It answers with a JSON head line and then the raw body.
- Any failure of the ssh leg, and any refusal by the relay itself, is `HUB_DEVICE_AWAY` (exit 75, `host-unreachable`). A failed peer-side fetch is re-raised as the same `TypeError` (`cause.code`) that a same-host fetch would give.

This follow-up pass tightened that split. Every relay refusal now carries a `HUB_` code, so a missing `policy.json` (`ENOENT`) is AWAY. A peer fetch that fails with no cause code now carries `RELAY_FETCH_FAILED` (not `HUB_`), so it stays a TypeError.

**Files changed (this pass):**
- `tools/hub-client.mjs`:
  - `refusalCode()` makes every relay refusal a `HUB_` code, and `RELAY_FETCH_FAILED` is the fetch-failure default.
  - The body line is serialized before ssh is spawned.
  - The spawn `catch` kills the child.
  - stderr keeps its last 500 characters, and its last line is named for every exit with no answer.
- `tools/hub-client.test.mjs`: 4 new tests and 2 tightened ones.
  - New: exit 127 behind an ssh banner; a BigInt body spawns no ssh; a code-less peer fetch failure stays a TypeError; a real-process relay with no `policy.json`, whose head the client reads as AWAY.
  - Tightened: the hop-header test now supplies the five hop headers; the evil-path quoting test runs in a scratch cwd.
- `tools/device/claims.test.mjs`: `request()`'s `HUB_USAGE` exit is held equal to `EXIT_CODES.HUB_USAGE`.
- `docs/hub-api-contract.md`:
  - `RELAY_FETCH_FAILED` and `HUB_RELAY_ERROR` on the wire
  - the recipe for running the relay by hand
  - AWAY messages name ssh's last stderr line

Files changed by the story overall: `tools/hub-client.mjs`, `tools/hub-client.test.mjs`, `tools/device/claims.test.mjs`, `docs/hub-api-contract.md`.

**Review findings (this pass):** 30 findings — high 1 (carried), medium 4, low 14, false 11.
- **Patched (7 entries):**
  - medium 1 entry, the `HUB_`-prefix split, with 4 members: a code-less fetch became AWAY; `ENOENT` refusals became TypeErrors; the no-policy branch had no test; the intent's note on the same side effect
  - low 6 entries: the stderr cause, body serialization plus the child kill, the `HUB_USAGE` exit pin, the by-hand relay recipe, the quoting test cwd, the hop-header test
- **Deferred:** none.
- **Rejected as low (8):**
  - relay `stdout` EPIPE, raised twice: the client is already gone and the fix adds a guard
  - carried from the first pass: unbounded buffering (twice), request-side validation (twice, one of them the `@host` rewrite), repeated headers
- **Rejected as false (11):**
  - no `.catch` on `main()`, raised twice: every throwing step is caught, and an unexpected throw is a loud AWAY
  - a host-key env override: none exists
  - claims-test fragility: the test is deterministic
  - untested head edge cases: each behaves consistently
  - no route allow-list: loopback only, behind key-authenticated ssh
  - a throwing `hostKey`: established vocabulary
  - the stricter alias regex: it refuses only option-injection names
  - the doc recording the diff's readings: each is consistent with the intent
  - the dynamic `hostKey` default: run-time only
  - the `timeout` seam: not a timer
- **Carried high (1):** no test reaches real ssh. The first pass already patched it with a real-process relay test, and the two-host leg is Story 9.8's install.

**Follow-up review recommended:** false. This was a follow-up pass and it patched no high entry. Patched counts by verdict: high 0, medium 1, low 6. The work has converged.

**Verification:**
- `node --test tools/hub-client.test.mjs tools/clock.test.mjs tools/deploy-path.test.mjs tools/device/claims.test.mjs`: 85 of 85 pass.
- `mise run check`: green, 1658 of 1658 tests, actionlint included.

**Residual risks:**
- No caller uses `request()` yet (Story 9.3).
- The real two-host ssh leg (`BatchMode` with the `hub-mac` and `big-chungus` aliases, the Mac's mise Node 24 path, a vanish seen from the Mac) is unproven until 9.8 installs a release with the relay on both hosts.
- Heartbeat timing on a sleeping Mac is untested (Story 9.6).
