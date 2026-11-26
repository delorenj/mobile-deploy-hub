---
title: 'Replicate the Mac''s Event Log'
type: 'feature'
created: '2026-11-26'
status: 'done'
baseline_revision: 'ade5a8d56e515589f133941403967657a1aad998'
review_loop_iteration: 0
followup_review_recommended: true
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

## Auto Run Result

**Status:** done

**Summary.** The Host Agent now replicates its Event Log to the Hub API byte-for-byte (AD-40, AD-49). Each push's `events` carries `{month, from_offset, lines}`: complete lines from `readEventsFrom`, one month per push, at most 256 KiB. The Hub API's new `tools/hub-api/replica.mjs`, the only writer of `HUB_EVENT_DIR/replicas/<host key>/<YYYY-MM>.jsonl`, appends only when `from_offset` equals the settled replica size. A torn tail is truncated first, a failed write is truncated back, and a gap is answered 409 `HUB_REPLICA_GAP {size}` with nothing applied. Every 2xx push answer carries `replica: {month: size}`. The agent keeps no cursor: it resumes from those sizes, drains the oldest differing month in serialized catch-up rounds, and skips a month it cannot push safely (past the source end, mid-line, a line too long, or invalid UTF-8) with one `HUB_AGENT_REPLICA_SKIPPED` line. The new `POST /agent/sync` on the agent adopts the given sizes, drains, and answers `{pushed, synced, replica}`. Everything is keyed by host key, so any spoke host replicates with no new code. The contract change is additive, with no bump.

**Files changed.**
- `tools/hub-api/replica.mjs` (new): the replica writer (`checkEvents`, `createReplicas` with `exclusive`/`sizes`/`append`, `settledSize`, `gapError`, `REPLICA_PUSH_MAX_BYTES`).
- `tools/hub-api/replica.test.mjs` (new): the Hub side of the matrix, the single-writer static scan, and the check that `readEvents` ignores replicas.
- `tools/hub-api/remotes.mjs`: strict `events` validation via `checkEvents`; read-only `seen()`.
- `tools/hub-api/routes.mjs`: async `agentPush` under a per-host replica queue (contact → dup → append → apply → readings → onPush → ack with `replica`); the `HUB_REPLICA_GAP` extension.
- `tools/hub-api/server.mjs`: wires `replicas` into the service ctx.
- `tools/device/claims.mjs`, `claims.test.mjs`: exit code for `HUB_REPLICA_GAP`.
- `tools/host-agent/push.mjs`: acknowledged/skipped maps, month pick, drain loop, serialized chain, `sync()`, UTF-8 byte check.
- `tools/host-agent/routes.mjs`, `server.mjs`: the `POST /agent/sync` route and its wiring (`env`, `sync`).
- `tools/host-agent/replicate.test.mjs` (new): the agent bridged into the Hub API's `handle()`, with hash-equality on every row.
- `tools/host-agent/server.test.mjs`, `push.test.mjs`, `tools/hub-api/agent-push.test.mjs`, `contract.test.mjs`: ack shape, route list, the startHostAgent replication test, a live gap answer, the AgentSync key set, and the e2e race fix.
- `docs/hub-api-contract.md`: AgentPushAck `replica.*`, the events body, the extension and error rows, `/agent/sync`, `### AgentSync`, and a Replication paragraph.

**Review findings breakdown.** 32 findings: high 0, medium 6, low 12, false 14, maybe-false 0.
- Patched: 8 rows in 3 medium groups plus small fixes.
  - Coverage (B5, V1, V2, V3): the wiring, chunking, too-long-line and endless-gap tests.
  - Non-UTF-8 skip (B8, E4).
  - Blank lines accepted (E1).
  - Small fixes: the readEvents-ignores-replicas test (B9), the stale comment and dead helper (B12), and the doc wording (VO1).
- Also fixed (not reviewer findings): `synced` was always true and now carries real meaning; the e2e test raced under load.
- Deferred: none.
- Rejected (low, with reasons in the triage log): B1 (own-dir EACCES aborts the trigger), B3/E3 (per-push re-settle cost), B4 (rollback branch untested; needs an fs seam), B7 (drift is visible only in logs), B10 (contact time captured before the queue), B13 (redundant 1 MiB cap), E2 (400 stalls; unreachable after E1).
- Rejected (false): B2, B6, B11, E5, E6, E7, VO2, I1–I7.

**Follow-up review recommendation: true.** First pass: 3 medium entries patched, 0 high. Patched counts by entry verdict: high 0, medium 3, low 3. Named unverified risk: the agent's drain, skip and sync logic in `tools/host-agent/push.mjs` changed after the review layers read it. The UTF-8 skip and the rewritten `synced` predicate both interact with the skipped map and with each answer replacing `acked` wholesale. No reviewer has checked that combination: a month skipped at one size, then re-acked by a later answer to the same size, together with the `synced` computation.

**Verification.**
- `node --test tools/hub-api/replica.test.mjs tools/host-agent/replicate.test.mjs tools/hub-api/agent-push.test.mjs tools/host-agent/push.test.mjs tools/hub-api/contract.test.mjs tools/host-agent/server.test.mjs`: 108/108 pass.
- `heavy mise run check`: the first post-patch run had 1 failure, the e2e push test racing under load. After the test fix, push.test.mjs passed 5/5 repeats under `heavy`, and `mise run check` passed 1918/1918.

**Residual risks.**
- The truncate-back-on-write-failure path in `replica.mjs` is reviewed but untested.
- `sizes()` re-settles every month file on each push; cheap now, but linear in month count.
- The live Mac↔big-chungus replication over real sleep/wake is proven only in Story 10.5.
