---
title: 'Replicate the Mac''s Event Log'
type: 'feature'
created: '2026-11-26'
status: 'done'
baseline_revision: 'ade5a8d56e515589f133941403967657a1aad998'
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-10-context.md'
  - '{project-root}/docs/hub-api-contract.md'
warnings: ['oversized']
deferred: []
---

<intent-contract>

## Intent

**Problem:** Every Host Agent push carries `events: null`, so a spoke host's Event Log (the Mac's) exists only on its own disk. While the Mac sleeps, its history cannot be read anywhere (FR-18, NFR-8).

**Approach:** Fill the push's `events` field with complete source lines (AD-49). The Hub API appends them byte-for-byte to `HUB_EVENT_DIR/replicas/<host key>/<YYYY-MM>.jsonl` only when `from_offset` equals the replica's size, and every answer reports the replica sizes. The agent keeps no cursor: it resumes from those sizes, and `POST /agent/sync` lets a caller hand it sizes and make it push (AD-40). Everything is keyed by host key, so any spoke host replicates with no new code.

## Boundaries & Constraints

**Always:**
- The Hub API is the only writer of `replicas/`: one module, `tools/hub-api/replica.mjs`. `lock.mjs` never names it.
- An append is all or nothing. It is one serialized operation per host: settle the size, compare, write. If the write fails, the file is truncated back to its prior size.
- A push whose `events` gap-fails changes nothing: no view, no readings, no recorded `seq` and no append. It is still contact (Story 9.6).
- The agent reads with `readEventsFrom` (complete lines only), one month per push, at most `REPLICA_PUSH_MAX_BYTES` (256 KiB, under the API's 1 MiB body limit). It compares each source month's complete-line end (`eventsEnd`) with the acknowledged size and pushes the oldest month that differs. It never closes a month.
- The agent sends `events` only when it knows the replica sizes (from a 2xx `replica` or from `/agent/sync`). So a new agent never sends events to an old Hub API (which answers 400 `bad-events`), and an old agent's `events: null` stays valid.
- Within one trigger, the first push carries `status` and `readings` (read once). Catch-up rounds carry `null` for both once a push of the trigger has been applied. Pushes stay serialized (no overlap), and there is no timer, interval or poll.
- The contract is additive only (no contract bump). Docs and tests stay equal.

**Never:** history reading or `/history` (10.2); utilisation (10.3); compaction, deletion or closing a month; an on-disk agent cursor; touching `readEvents`/`followEvents` semantics; a timer-driven retry; Python.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| First replication | Hub replica empty; agent has months 2026-10 and 2026-11 | Start push `events: null` gets `replica: {}`; next push is `{month: '2026-10', from_offset: 0}`; it drains 10 and then 11, one month per push | none |
| Gap | `from_offset` ≠ replica size | 409 `HUB_REPLICA_GAP`, member `size`; nothing appended or applied | the agent adopts `size` for that month and pushes again in the same trigger |
| Repeated delivery | the same body (same boot+seq) twice | 2nd is 200 `{applied: false, replica}`; nothing appended | none |
| Torn delivery | applied, ack lost (transport throws) | the next trigger starts at `events: null` (acked unknown) or gets a 409, then resumes; the replica's hash equals the source's | push owed, one `HUB_AGENT_PUSH_FAILED` line |
| Torn replica tail | replica's last byte is not `\n` | the size is settled by truncating to the last newline before the compare | none |
| Source shorter or not at a line start | acked size past the source end or mid-line | month skipped: one `HUB_AGENT_REPLICA_SKIPPED <month> <code>` line, not retried until its acked size changes | the rest still replicate |
| Bad events body | wrong month, offset, empty lines, a line without exactly one trailing `\n` | 400 `HUB_USAGE` `bad-events` | nothing stored |
| `/agent/sync` | `{replica: {'2026-11': 120}}` | the agent sets its acked sizes, pushes (draining), and answers `{pushed, synced, replica}` | bad body is 400 `HUB_USAGE` `bad-body`/`bad-replica` |

</intent-contract>

## Code Map

- `tools/ci/lib/events.mjs:156` -- `readEventsFrom({month, offset, maxBytes})` returns `{from, offset, lines}` byte-exact. It throws RangeError `HUB_EVENT_OFFSET` / `HUB_EVENT_LINE_TOO_LONG`. `eventsEnd` (:209) is the complete-line end. `eventDir(env)` (:19). `readEvents`/`followEvents` list only top-level `YYYY-MM.jsonl`, so `replicas/` is invisible to them (read-only, do not change).
- `tools/hub-api/remotes.mjs:43` -- `checkPushBody`. It currently refuses non-null `events` (`bad-events`). Replace this with a strict events check. `createRemotes().apply` dedupes `(boot, seq)`. Add a read-only `seen(push)`.
- `tools/hub-api/routes.mjs:267` -- `agentPush`. Becomes async: body check → Registry places → per-host replica queue → contact → dup → append (gap is 409) → apply → readings → `onPush` → `{applied, host, boot, seq, replica}`. `PROBLEM_EXTENSIONS` (:59) gains `HUB_REPLICA_GAP: ['size']`. `remotesOf`/`peersOf` are the WeakMap fallback pattern for a bare `handle()`.
- `tools/hub-api/replica.mjs` (new) -- `replicaDir(env, host)`, `checkEvents`, `createReplicas({env})` → `{exclusive(host, fn), sizes(host), append(host, events)}`, `REPLICA_PUSH_MAX_BYTES`, `gapError(size)`. Uses fs/promises; dirs are mode 0o700.
- `tools/hub-api/server.mjs:241` -- the service ctx. Add `replicas: createReplicas({env})`. The change watcher on the event dir is non-recursive, so replica writes do not churn the feed.
- `tools/device/claims.mjs:56` -- `EXIT_CODES`. Add `HUB_REPLICA_GAP: 1`.
- `tools/host-agent/push.mjs` -- `createPusher`. Add the acked map, the skipped map, the month pick, the drain loop, the serialized chain and `sync(replica)`. The default transport is `hub-client.request` (returns a fetch `Response`).
- `tools/host-agent/routes.mjs:174` -- `AGENT_ROUTES`. Add `POST /agent/sync` (shape `AgentSync`), whose handler checks the body and calls `ctx.sync`.
- `tools/host-agent/server.mjs:51` -- wire `sync: replica => pusher.sync(replica)` into the route ctx, and pass `env` into the pusher for the event reads.
- `docs/hub-api-contract.md` -- AgentPushAck gets `replica.*`. The `/agent/push` `events` body text, the Problem extensions row, the `HUB_REPLICA_GAP` error row, the Host Agent table row `/agent/sync`, a `### AgentSync` section, and its request body.
- `tools/hub-api/contract.test.mjs:385,462` -- a live `HUB_REPLICA_GAP` answer, `AgentSync` excluded from the "is a Hub API route" loop, and an `/agent/sync` key-set test.
- `tools/hub-api/agent-push.test.mjs`, `tools/host-agent/push.test.mjs` -- existing exact `{applied, host, boot, seq}` asserts gain `replica`. Fake transports without `replica` mean acked stays unknown and nothing drains (no change).

## Tasks & Acceptance

**Execution:**
- `tools/hub-api/replica.mjs` -- create the module above: settle the size (truncate a torn tail), gap check, a looped append with truncate-back on error, `sizes` sorted by month, and a per-host promise chain.
- `tools/hub-api/remotes.mjs` -- validate `events` via `checkEvents` (null, or `{month, from_offset, lines}`: month `YYYY-MM`, a safe int ≥0, a non-empty array of strings each ending in exactly one `\n`, the body total ≤ 1 MiB) and add `seen()`.
- `tools/hub-api/routes.mjs`, `tools/hub-api/server.mjs`, `tools/device/claims.mjs` -- make `agentPush` async as mapped, add the extension and the exit code, and wire `replicas` into the ctx with a `replicasOf` fallback.
- `tools/host-agent/push.mjs`, `routes.mjs`, `server.mjs` -- the agent's replication, the `/agent/sync` route and the wiring.
- `docs/hub-api-contract.md`, `tools/hub-api/contract.test.mjs` -- the contract updates.
- `tools/hub-api/replica.test.mjs` (new) -- the Hub API side of the matrix, plus a static scan: among non-test `.mjs` under `tools/`, only `tools/hub-api/replica.mjs` names `'replicas'`, and `lock.mjs` does not.
- `tools/host-agent/replicate.test.mjs` (new) -- the agent's transport bridged into the Hub API `handle()` on separate temp event dirs: first push from offset 0 of the oldest month; oldest-differing order; never two months per push; resume from the answer with a fresh pusher (no cursor); `/agent/sync` via the agent's `handle()`; torn (ack lost) and repeated deliveries. Each ends with sha256(replica month) == sha256(source month).
- `tools/hub-api/agent-push.test.mjs`, `tools/host-agent/push.test.mjs` -- update the ack asserts to include `replica`.

**Acceptance Criteria:**
- Given a push with `events: {month, from_offset, lines}`, when the Hub API applies it, then it appends iff `from_offset` equals the size of `replicas/<host>/<month>.jsonl`. Otherwise it is 409 `HUB_REPLICA_GAP` with `{size}` and nothing appended.
- Given every push answer, when it is 2xx, then it carries `replica: {<month>: size}`, and the agent resumes from it, including at its own start.
- Given `POST /agent/sync` with replica sizes, when it is called, then the agent pushes from those sizes and answers `AgentSync`.
- Given a retried push after a torn or repeated delivery, when it is applied, then the replica has no duplicate or shifted line, asserted by equal file hashes.
- Given `mise run check`, then it is green.

## Design Notes

Agent drain loop per trigger (serialized):

```
view, lanes = read once; carry = true
loop (≤ 256 rounds, ≤ 3 consecutive 409s):
  events = acked ? pickOldestDiffering() : null
  if (!carry && events === null) return true
  answer = send({..., status: carry ? view : null, readings: carry ? lanes : null, events})
  2xx  -> acked = validMap(answer.replica) ?? null; carry = false; if events === null && nothing differs: return true
  409 HUB_REPLICA_GAP with integer size -> acked.set(month, size); continue
  else -> fail (owed), return false
```

A 2xx answer with no valid `replica` (an old Hub API, or a test fake) leaves acked unknown, so nothing more is sent.

## Verification

**Commands:**
- `node --test tools/hub-api/replica.test.mjs tools/host-agent/replicate.test.mjs tools/hub-api/agent-push.test.mjs tools/host-agent/push.test.mjs tools/hub-api/contract.test.mjs` -- expected: all pass
- `mise run check` -- expected: green

## Review Triage Log

### 2026-11-26 — Review pass
- verdicts: 32 findings — high 0, medium 6, low 12, false 14, maybe-false 0
- findings:
  - `low` `reject` B1: an EACCES/EIO reading the agent's own event dir aborts the whole trigger — the agent's own private dir failing to list is not met in everyday use, and the fix adds a guard branch.
  - `false` `reject` B2: repeated pokes stack drains on the chain — pokes go through the trailing debounce in the watch, which coalesces them into one trigger.
  - `low` `reject` B3: `sizes()` re-settles (opens r+) every month on every push — negligible cost at a handful of month files, and it only writes on a torn tail; fixing it needs a size cache, which is more state.
  - `low` `reject` B4: the truncate-back-on-write-failure branch is untested — testing it needs a new fs seam in replica.mjs (added surface); the branch is short and reviewed by reading.
  - `medium` `patch` B5: coverage gaps (wiring, chunking, too-long line, endless gap) — fixed with V1–V3: new startHostAgent wiring test and the >700 KiB, LINE_TOO_LONG and always-409 rows in replicate.test.mjs.
  - `false` `reject` B6: a missing `ctx.sync` crashes `/agent/sync` — it fails loudly as a 500, and `startHostAgent` always wires `sync`; no reachable path lacks it.
  - `low` `reject` B7: a replica/source size drift is only visible through the skip line — surfacing it would add contract surface; the skip line is the designed signal.
  - `medium` `patch` B8: a source line with invalid UTF-8 decodes lossily, so the replica bytes diverge from the source — push.mjs now compares the decoded lines' byte length with the bytes read and skips the month with `HUB_EVENT_NOT_UTF8` (test row added).
  - `low` `patch` B9: nothing proves `readEvents` ignores `replicas/` — added the "a populated replica is invisible to readEvents" test in replica.test.mjs.
  - `low` `reject` B10: `at`/`places` are captured before the per-host queue, so a queued push records slightly earlier contact — the difference is the queue wait (milliseconds) and changes no reading.
  - `false` `reject` B11: adding `replica` to AgentPushAck needs a contract bump — the change is additive only, which the contract's versioning rule allows without a bump.
  - `low` `patch` B12: a stale comment and an unused `sizes` helper remain — deleted.
  - `low` `reject` B13: the 1 MiB lines check duplicates the body-size limit — harmless belt-and-braces, and removing it widens what `checkEvents` accepts standalone.
  - `medium` `patch` E1: a blank source line (`"\n"`) is refused by `checkEvents` (`length < 2`), so a month with one never replicates — now `length < 1`; a blank-line hash-equal test row added.
  - `low` `reject` E2: any 400 from the push stalls replication — after E1 no data the agent reads can produce a 400, and an extra error path is guarded state not demonstrated.
  - `low` `reject` E3: same as B3 (per-push re-settle cost) — same reason.
  - `medium` `patch` E4: non-UTF-8 bytes break byte-identity — grouped with B8; same fix.
  - `false` `reject` E5: same as B6 — `startHostAgent` always wires `sync`.
  - `false` `reject` E6: a month skipped on divergent bytes stays skipped forever — retrying onto divergent source bytes would corrupt the replica; staying skipped until the acknowledged size changes is the safe and specified behavior.
  - `false` `reject` E7: a fresh `seq` after a gap could be taken as a duplicate — every attempt increments `seq`, and dedupe is on exact `(boot, seq)`, so a new attempt is never a duplicate.
  - `medium` `patch` V1: no test proves `startHostAgent` wires `env` and `sync` — added a server.test.mjs test bridging startHostAgent into the Hub API, proving replica hash equality and the `/agent/sync` answer.
  - `medium` `patch` V2: no test drives a month over the 256 KiB slice limit — added the >700 KiB row asserting slices ≤ REPLICA_PUSH_MAX_BYTES with rising offsets and hash equality.
  - `low` `patch` V3: no test for a too-long line or a Hub that always answers 409 — added both rows (skip with `HUB_EVENT_LINE_TOO_LONG`; one failure line after GAP_MAX).
  - `low` `patch` VO1: the contract doc says `/history` calls `/agent/sync`, but no caller exists yet — reworded to "Story 10.2's `/history` will call `/agent/sync`" in the doc and the agentSync comment.
  - `false` `reject` VO2: AgentSync is excluded from the "is a Hub API route" loop — AgentSync is a Host Agent route only, so the exclusion is correct, and its own key-set test covers it.
  - `false` `reject` I1: the intent expects a live Mac→Hub pair — the live proof is Story 10.5's ship criterion; the hermetic wiring gap is closed by V1.
  - `false` `reject` I2: the first push should start at offset 0 of the oldest month — it does: the start push is `events: null` (sizes unknown), and the first events push is the oldest month from 0, asserted in replicate.test.mjs.
  - `false` `reject` I3: the intent says compare source size, the diff compares the complete-line end — for a file ending in a complete line they are equal, and a torn source tail must not be pushed, so `eventsEnd` is the faithful reading.
  - `false` `reject` I4: resuming from the Hub's answers instead of a local cursor diverges — that is exactly AD-49 ("keeps no cursor of its own").
  - `false` `reject` I5: the single-writer rule is checked by a text scan, not a runtime guard — the spec asked for the static scan, and it runs over every non-test `.mjs` under tools/.
  - `false` `reject` I6: same as VO2 — AgentSync is agent-only.
  - `false` `reject` I7: the `until()` polling in push.test.mjs weakens the e2e asserts — it waits for the observable effect and keeps every assertion; it removes a timing guess, not a check.
  - orchestrator fix (not a reviewer finding): `/agent/sync` answered `synced: true` unconditionally — `synced` now holds only when every source month's complete-line end equals its acknowledged size (false on a failed push, no valid replica, or a skipped month).
  - post-patch verification fix: the e2e push test raced under `heavy mise run check` (the start trigger's catch-up round replicated the lease event with status null, so the poke count reached 2 before the lease view) — the test now waits for the lease view and asserts no further push against the count at that point (commit after 0b7dccf).


### 2026-11-26 — Review pass
- verdicts: 31 findings — high 0, medium 4, low 15, false 12, maybe-false 0
- findings:
  - `low` `reject` BH1: `replicas.sizes()` settles (opens `r+`, may truncate) every month on every answer, so an unreadable replica file makes every push from that host a 500 — the files are created by the Hub API's own user in its own 0o700 dir, so EACCES/EIO is not met in everyday use, and degrading `sizes()` to a stat adds a second size path (grouped with EC4).
  - `low` `reject` BH2: a non-gap append error (ENOSPC, EACCES) throws before `remotes.apply`, so status and readings stop updating — a full or unwritable Hub disk breaks the whole service (state, events) anyway; applying status past a failed append adds an ordering branch the spec never asked for.
  - `false` `reject` BH3: divergence is detected by size only, so a rewritten source month diverges silently — the source Event Log is append-only (`appendEvent` is its only writer, and compaction/deletion is a Never), so a same-length rewrite cannot reach this code.
  - `low` `reject` carried B7: a skipped month has no recovery path and no visible signal beyond the skip line — same claim as B7; the skip line is the designed signal.
  - `false` `reject` BH5: the "past its source end" test contradicts its title by asserting the month recovers — the hinted size came from `/agent/sync`, the Hub's 2xx answer replaced it (a changed acknowledged size), and the test then proves the same hint is not skipped twice and a changed one is retried; the stuck case uses the same `want > end` branch.
  - `low` `reject` carried B4: the "a failed append changes nothing" test fails at `settledSize`'s `open(r+)`, so the truncate-back branch is never run — same claim as B4 (needs an fs seam).
  - `low` `patch` BH7: the single-writer scan matches only the single-quoted literal `'replicas'` — replica.test.mjs now matches `'`, `"` or backtick quoting (still only replica.mjs hits).
  - `false` `reject` BH8: the e2e test's `pokes.length >= 2` lost precision — with replication one change also replicates its event in a catch-up round (another applied push and poke), so an exact count is no longer the invariant; the lease view and `sent` equality carry the asserts.
  - `false` `reject` BH9: JSON escaping can push a 256 KiB slice over the 1 MiB body limit — Event Log lines are JSON with control characters already escaped, so the worst escape is `"`/`\` doubling (512 KiB), and UTF-8-decoded lines hold no lone surrogates.
  - `low` `reject` BH10: no capability signal for `/agent/sync`, and "any spoke host" is untested beyond `mac` — the agent and the Hub API ship in one hub release, and a second spoke host first needs a `HOST_KEYS` entry (hub-client.mjs), which is not this story; the replica paths are keyed by `push.host` (grouped with IA6).
  - `false` `reject` BH11: spec still `in-review`, and push.mjs imports a constant from replica.mjs — `in-review` was this pass's own in-flight state; replica.mjs imports only modules push.mjs already loads, so there is no cost.
  - `medium` `patch` EC1: a truncated multi-byte UTF-8 prefix (`F0 9F 98`) decodes to one 3-byte U+FFFD, so the byte-count check passes and the replica diverges — push.mjs now re-reads the raw range and compares it byte for byte with the re-encoded lines (`rawOf`); a test row with that exact prefix asserts the HUB_EVENT_NOT_UTF8 skip.
  - `low` `reject` EC2: a backlog over 256 rounds × 256 KiB stops the drain as owed until the next trigger — 64 MiB of one host's events in one trigger is not met in everyday use, and a self-poke adds a seam; the failure is one loud line.
  - `false` `reject` EC3: a 2xx whose replica did not advance re-pushes the same slice up to 256 times — the real Hub either appends or answers 409, and every attempt has a fresh `seq`, so a non-advancing 2xx needs a broken Hub, and the drain ends loudly at ROUNDS_MAX.
  - `low` `reject` EC4: `replicas.sizes()` throwing after apply makes the answer a 500 — same as BH1.
  - `low` `reject` EC5: `eventsEnd` throwing in the `synced` computation rejects `/agent/sync` — the drain's final `pick()` ran `eventsEnd` on every month just before, so only a race between them reaches it; a guard adds a branch.
  - `false` `reject` carried E6: a month skipped for LINE_TOO_LONG/NOT_UTF8 never replicates its later lines — same claim as E6; retrying onto divergent bytes would corrupt the replica.
  - `low` `patch` EC7: the new drain read status and lane readings (the devicectl probe) before resolving the host key, a regression from the old `push()` — `drain()` now resolves the host key first (still using up one `seq`), then reads.
  - `false` `reject` EC8: `carry = false` on any 2xx, including `applied: false` — the first push of a trigger always carries a fresh `(boot, seq)`, so it is never answered as a duplicate.
  - `low` `reject` carried B4: the truncate-back path is untested — same claim as B4.
  - `medium` `patch` VG1: `synced` is only ever asserted `true` — replicate.test.mjs now asserts `synced: false` for a 2xx with no valid replica, a throwing transport (`pushed: false`) and a month that stays skipped, plus the honest `true`.
  - `medium` `patch` VG2: "a gap-failed push is still contact" has no assertion — unreachable.test.mjs now marks the Mac unreachable, sends a 409 HUB_REPLICA_GAP push and asserts one restore event (reason push), the poke and a cleared mark.
  - `low` `reject` carried B4: the failed-append test never reaches truncate-back — same claim as B4.
  - `low` `reject` IA1: no test runs the service's `replicas: createReplicas({env})` wiring, only the `replicasOf` fallback — the service ctx is one long-lived object, so the fallback would behave the same; no caller diverges.
  - `medium` `patch` IA2: contact on a gap is not asserted — grouped with VG2; same test.
  - `low` `reject` carried B4: the truncate-back test exercises a different failure — same claim as B4.
  - `false` `reject` carried I5: the single-writer rule is a text scan, not a runtime guard — same claim as I5 (its quoting hole is BH7, patched).
  - `false` `reject` IA5: cross-host `/agent/sync` may be unreachable because the agent binds loopback — the Hub API reaches the Mac through hub-client's ssh relay, which calls the agent's loopback port on the Mac.
  - `low` `reject` IA6: "any spoke host" is only tested as `mac` — same as BH10.
  - `false` `reject` IA7: the wording readings (2xx for "applied", blank lines, extra skip codes) differ from the literal intent — the doc and code agree, E1 settled blank lines, and EC8 shows 2xx and applied coincide for a trigger's first push.
  - `false` `reject` carried I1: the live two-host proof is deferred — same claim as I1 (Story 10.5).
  - post-patch verification fix: the e2e push test's `until()` bounded its wait by 500 loop turns, which `heavy mise run check` outran while the replica's async fs work was still queued — it now waits up to 10 s of wall clock (hrtime; the mocked timers never touch it).

## Auto Run Result

**Status:** done

**Summary.** The Host Agent replicates its Event Log to the Hub API byte-for-byte (AD-40, AD-49). Each push's `events` carries `{month, from_offset, lines}`: complete lines from `readEventsFrom`, one month per push, at most 256 KiB. The Hub API's `tools/hub-api/replica.mjs`, the only writer of `HUB_EVENT_DIR/replicas/<host key>/<YYYY-MM>.jsonl`, appends only when `from_offset` equals the settled replica size. A torn tail is truncated first, a failed write is truncated back, and a gap is answered 409 `HUB_REPLICA_GAP {size}` with nothing applied (still contact). Every 2xx push answer carries `replica: {month: size}`. The agent keeps no cursor: it resumes from those sizes, drains the oldest differing month in serialized catch-up rounds, and skips a month it cannot push byte-for-byte with one `HUB_AGENT_REPLICA_SKIPPED` line. `POST /agent/sync` adopts given sizes, drains, and answers `{pushed, synced, replica}`. Keyed by host key, with an additive contract change and no bump. This follow-up pass closed a byte-identity hole in the UTF-8 check, restored host-key-first ordering, and covered `synced: false` and gap-is-contact.

**Files changed (whole story).**
- `tools/hub-api/replica.mjs` (new): the replica writer (`checkEvents`, `createReplicas` with `exclusive`/`sizes`/`append`, `gapError`, `REPLICA_PUSH_MAX_BYTES`).
- `tools/hub-api/replica.test.mjs` (new): the Hub side of the matrix, the single-writer static scan (now quote-agnostic), and the readEvents-ignores-replicas check.
- `tools/hub-api/remotes.mjs`: strict `events` validation via `checkEvents`; read-only `seen()`.
- `tools/hub-api/routes.mjs`: async `agentPush` under a per-host replica queue; the `HUB_REPLICA_GAP` extension.
- `tools/hub-api/server.mjs`: wires `replicas` into the service ctx.
- `tools/device/claims.mjs`, `claims.test.mjs`: exit code for `HUB_REPLICA_GAP`.
- `tools/host-agent/push.mjs`: acknowledged/skipped maps, month pick, drain loop, serialized chain, `sync()`; this pass: a raw byte-for-byte UTF-8 check (`rawOf`) and the host key resolved before any read.
- `tools/host-agent/routes.mjs`, `server.mjs`: the `POST /agent/sync` route and its wiring.
- `tools/host-agent/replicate.test.mjs` (new): the agent bridged into the Hub API's `handle()`, hash-equal rows; this pass: the truncated-prefix row and the `synced` false/true row.
- `tools/hub-api/unreachable.test.mjs`: this pass: a gap-failed push restores an unreachable host.
- `tools/host-agent/push.test.mjs`, `server.test.mjs`, `tools/hub-api/agent-push.test.mjs`, `contract.test.mjs`: ack shape, route list, startHostAgent replication, a live gap answer, the AgentSync key set; this pass: a wall-clock `until()`.
- `docs/hub-api-contract.md`: AgentPushAck `replica.*`, the events body, extension and error rows, `/agent/sync`, `### AgentSync`, Replication.

**Review findings breakdown (this follow-up pass).** 31 findings: high 0, medium 4, low 15, false 12, maybe-false 0.
- Patched: EC1 (medium, UTF-8 byte compare), VG1 (medium, `synced` coverage), VG2+IA2 (medium, gap-is-contact coverage), EC7 (low, host key first), BH7 (low, quote-agnostic scan).
- Deferred: none.
- Rejected low: BH1/EC4 (unreadable own replica file → 500; not everyday, second size path), BH2 (append I/O error blocks status; a failing Hub disk breaks everything), B7 carried (skip line is the signal), B4 carried ×4 (truncate-back needs an fs seam), BH10/IA6 (second spoke host needs a `HOST_KEYS` entry first), EC2 (64 MiB backlog per trigger; loud failure line), EC5 (race only), IA1 (the long-lived service ctx makes the fallback equivalent).
- Rejected false: BH3, BH5, BH8, BH9, BH11, EC3, E6 carried, EC8, I5 carried, IA5, IA7, I1 carried.

**Follow-up review recommendation: false.** Follow-up pass with no high patched (patched by entry verdict: high 0, medium 3, low 2); the work has converged.

**Verification.**
- `node --test tools/hub-api/replica.test.mjs tools/host-agent/replicate.test.mjs tools/hub-api/agent-push.test.mjs tools/host-agent/push.test.mjs tools/hub-api/contract.test.mjs tools/host-agent/server.test.mjs tools/hub-api/unreachable.test.mjs`: 130/130 pass.
- `heavy mise run check`: first run 1 failure (the e2e push test's turn-counted `until()` under load; it passed 5/5 alone under `heavy`); after the wall-clock fix, 1921/1921 pass.

**Residual risks.**
- The truncate-back-on-write-failure path in `replica.mjs` is reviewed but untested (needs an fs seam).
- An unreadable replica file or a full Hub disk makes that host's pushes 500 until fixed; status and readings stop updating with it.
- A month skipped on a bad source line never replicates its later lines; the only signal is one stderr line per process.
- The live Mac↔big-chungus replication over real sleep/wake is proven only in Story 10.5.
