---
title: 'Replicate the Mac''s Event Log'
type: 'feature'
created: '2026-11-26'
status: 'in-review'
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
