// The Event Log replica (Story 10.1, AD-49): the Hub API's byte-for-byte copy of a spoke host's Event Log, in
// HUB_EVENT_DIR/replicas/<host key>/<YYYY-MM>.jsonl. This module is the only writer of replicas/ (the static scan in
// replica.test.mjs proves it): lock.mjs never names it, and readEvents/followEvents list only top-level `YYYY-MM.jsonl`
// files, so the replica is invisible to them. Everything is keyed by host key, so a second spoke host replicates with no new code.
//
// An append is all or nothing, and everything that settles, appends or reports a host's sizes runs in one serialized
// operation per host (`exclusive(host, fn)`): settle the size, compare, write. A torn tail (the file's last byte is not a
// newline: a writer that died mid-line) is truncated to just after the last newline BEFORE the compare, so a size always
// counts complete lines only. A `from_offset` that is not the settled size is a gapError (409 HUB_REPLICA_GAP with `size`:
// the agent adopts it and pushes again from it); a failed write truncates the file back to its prior size.
//
// `checkEvents` is the strict body check of a push's `events` (HUB_USAGE 400 `bad-events`). The agent reads its own log with
// readEventsFrom and pushes one month at a time, at most REPLICA_PUSH_MAX_BYTES (256 KiB, under the API's 1 MiB body limit).
import { mkdir, open, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { eventDir } from '../ci/lib/events.mjs';
import { exitCodeOf } from '../device/claims.mjs';

// The most the agent puts into one push's events lines: under the API's 1 MiB request-body limit (MAX_BODY_BYTES in
// server.mjs). readEventsFrom takes it as maxBytes, so it is never below EVENT_MAX_BYTES.
export const REPLICA_PUSH_MAX_BYTES = 256 * 1024;
// The events check's ceiling: the whole lines payload never out-grows the API's 1 MiB body limit.
const REPLICA_CHECK_MAX_BYTES = 1024 * 1024;

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const MONTH_FILE = /^(\d{4}-(?:0[1-9]|1[0-2]))\.jsonl$/;

// The replica root of one host key: HUB_EVENT_DIR/replicas/<host>. The Hub API is its only writer.
export function replicaDir(env, host) {
  return join(eventDir(env), 'replicas', host);
}

const bad = message => Object.assign(new Error(message), { status: 400, code: 'HUB_USAGE', exit: exitCodeOf({ code: 'HUB_USAGE' }), reason: 'bad-events' });
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const EVENT_KEYS = Object.freeze(['month', 'from_offset', 'lines']);

// The strict check of a push's `events` (throws HUB_USAGE 400 `bad-events`): null, or `{month, from_offset, lines}` with a
// month `YYYY-MM`, a whole number of bytes 0 or more and a non-empty list of complete lines: every line is a string whose
// only newline is its last byte (a torn one and one with a second trailing newline are refused; a blank source line is a
// complete line and qualifies), and their total never passes the body limit. Returns the events as checked, or null.
export function checkEvents(events) {
  if (events === null) return null;
  if (!isObject(events)) throw bad('events must be null or {month, from_offset, lines}');
  for (const key of Object.keys(events)) if (!EVENT_KEYS.includes(key)) throw bad(`events has no key "${key}" (${EVENT_KEYS.join(', ')})`);
  for (const key of EVENT_KEYS) if (!Object.hasOwn(events, key)) throw bad(`events needs "${key}"`);
  if (typeof events.month !== 'string' || !MONTH.test(events.month)) throw bad('events.month must be YYYY-MM');
  if (!Number.isSafeInteger(events.from_offset) || events.from_offset < 0) throw bad('events.from_offset must be a whole number of bytes, 0 or more');
  if (!Array.isArray(events.lines) || events.lines.length === 0) throw bad('events.lines must be a non-empty list of complete lines');
  let total = 0;
  for (const line of events.lines) {
    if (typeof line !== 'string' || line.length < 1 || line.indexOf('\n') !== line.length - 1) throw bad('every events line must be a string whose only newline is its last byte');
    total += Buffer.byteLength(line);
  }
  if (total > REPLICA_CHECK_MAX_BYTES) throw bad(`events lines are over ${REPLICA_CHECK_MAX_BYTES} bytes`);
  return { month: events.month, from_offset: events.from_offset, lines: events.lines };
}

// The gap refusal (409, member `size`): the settled size of the pushed month's replica file, so the agent adopts it and
// pushes again from it. Nothing was appended and nothing of the push was applied, but the push is still contact (Story 9.6).
export function gapError(size) {
  return Object.assign(new Error(`events.from_offset is not the replica's settled size (${size} bytes): push again from ${size}`), { status: 409, code: 'HUB_REPLICA_GAP', exit: exitCodeOf({ code: 'HUB_REPLICA_GAP' }), reason: 'gap', size });
}

export function createReplicas({ env = process.env } = {}) {
  const dirOf = host => replicaDir(env, host);
  const chains = new Map();   // host key -> the promise of the last queued operation (kept alive past a failure)

  // The one serialization point: every settle, append and sizes of a host runs after the previous one has ended. A failed
  // operation never ends the queue. Returns the operation's own promise (its failure rejects it, not the chain).
  function exclusive(host, fn) {
    const next = (chains.get(host) ?? Promise.resolve()).then(() => fn());
    chains.set(host, next.catch(() => {}));
    return next;
  }

  // The settled size of one replica file: its size, or the point just after its last newline when its tail is torn (a
  // writer that died mid-line), which the file is then truncated back to. A missing file is 0.
  async function settledSize(file) {
    let handle;
    try { handle = await open(file, 'r+'); } catch (error) {
      if (error.code === 'ENOENT') return 0;
      throw error;
    }
    try {
      const { size } = await handle.stat();
      if (size === 0) return 0;
      const last = Buffer.alloc(1);
      await handle.read(last, 0, 1, size - 1);
      if (last[0] === 0x0a) return size;
      const chunk = Buffer.alloc(64 * 1024);
      let end = size;
      while (end > 0) {
        const start = Math.max(0, end - chunk.length);
        const want = end - start;
        let got = 0;
        while (got < want) {
          const { bytesRead } = await handle.read(chunk, got, want - got, start + got);
          if (bytesRead === 0) break;
          got += bytesRead;
        }
        const at = chunk.subarray(0, got).lastIndexOf(0x0a);
        if (at !== -1) {
          await handle.truncate(start + at + 1);
          return start + at + 1;
        }
        end = start;
      }
      await handle.truncate(0);
      return 0;
    } finally { await handle.close(); }
  }

  return {
    exclusive,

    // `{<month>: <settled size>}`, sorted by month. A host with no replica dir yet is `{}`.
    async sizes(host) {
      let names;
      try { names = await readdir(dirOf(host)); } catch (error) {
        if (error.code === 'ENOENT') return {};
        throw error;
      }
      const months = names.map(name => MONTH_FILE.exec(name)?.[1]).filter(month => month !== undefined).sort();
      const out = {};
      for (const month of months) out[month] = await settledSize(join(dirOf(host), `${month}.jsonl`));
      return out;
    },

    // The append: settle the size, compare (a gap throws gapError, nothing written), write the lines byte-for-byte, and
    // truncate back to the prior size when the write fails. Run it under `exclusive(host, ...)` where pushes can overlap.
    async append(host, events) {
      const dir = dirOf(host);
      await mkdir(dir, { recursive: true, mode: 0o700 });
      const file = join(dir, `${events.month}.jsonl`);
      const size = await settledSize(file);
      if (events.from_offset !== size) throw gapError(size);
      const data = Buffer.concat(events.lines.map(line => Buffer.from(line, 'utf8')));
      const handle = await open(file, 'a');
      try {
        let written = 0;
        while (written < data.length) {
          const { bytesWritten } = await handle.write(data, written);
          if (bytesWritten === 0) throw new Error('short write');
          written += bytesWritten;
        }
      } catch (error) {
        // All or nothing: whatever the failed write left is cut back to the size the compare was made against.
        try { await handle.truncate(size); } catch { /* a truncate that fails leaves a torn tail: the next settle fixes it */ }
        throw error;
      } finally { await handle.close(); }
    },
  };
}
