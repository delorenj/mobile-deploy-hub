// The Event Log (AD-9, AD-10, AD-39): an append-only, local history of every transition on a Queued host lock, and of the
// Registry, Reachability and prune events beside them. One JSON line per
// event, in HUB_EVENT_DIR/<YYYY-MM>.jsonl on the host that owns the lock, written with a single O_APPEND write so
// concurrent processes (several hub versions share one lock dir) never tear a line. A failed write is logged and never
// fails the transition it describes. Only lock.mjs calls appendEvent; callers read through readEvents (the whole log) or readEventsFrom (one month from a
// byte position, for a stream, a replica or a history that resumes).
import { spawnSync } from 'node:child_process';
import { closeSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, writeSync } from 'node:fs';
import { homedir, hostname as osHostname } from 'node:os';
import { join } from 'node:path';
import { hubRef } from './receipt.mjs';

export const EVENT_FORMAT = 1;
export const EVENT_MAX_BYTES = 4096;
const TRUNCATABLE = ['why', 'reason'];

// HUB_EVENT_DIR, else $XDG_STATE_HOME/mobile-deploy-hub/events (an absolute path only, per the XDG spec), else
// ~/.local/state/mobile-deploy-hub/events.
export function eventDir(env = process.env, home = homedir()) {
  if (env.HUB_EVENT_DIR) return env.HUB_EVENT_DIR;
  const state = env.XDG_STATE_HOME?.startsWith('/') ? env.XDG_STATE_HOME : join(home, '.local/state');
  return join(state, 'mobile-deploy-hub/events');
}

// The machine id (AD-8): /etc/machine-id on Linux, IOPlatformUUID on the Mac. Survives hostname drift (mommymac.local
// becoming mommymac-2.local). null when the host will not say. The default lookup is cached per process; a test that
// injects `platform`, `readFile` or `run` gets a fresh lookup.
let cachedHostId;
export function hostId(options) {
  const { platform = process.platform, readFile = readFileSync, run = spawnSync } = options ?? {};
  const injected = options !== undefined;
  if (!injected && cachedHostId !== undefined) return cachedHostId;
  let id = null;
  try {
    if (platform === 'darwin') {
      const out = run('ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'], { encoding: 'utf8', timeout: 5000 });
      id = /"IOPlatformUUID"\s*=\s*"([^"]+)"/.exec(out?.stdout ?? '')?.[1] ?? null;
    } else if (platform === 'linux') {
      id = String(readFile('/etc/machine-id', 'utf8')).trim();
    }
  } catch { id = null; }
  if (!/^[0-9A-Za-z-]{1,64}$/.test(id ?? '')) id = null;
  if (!injected) cachedHostId = id;
  return id;
}

const bytes = text => Buffer.byteLength(text);
const lineOf = record => `${JSON.stringify(record)}\n`;

// A line over 4 KiB loses free text first (the longest of `why` and `reason`, cut at a code point and ended with an
// ellipsis) until it fits. Null when even empty free text does not fit, so the caller skips the write.
function fit(record) {
  if (bytes(lineOf(record)) <= EVENT_MAX_BYTES) return record;
  const out = { ...record };
  const keys = TRUNCATABLE.filter(key => typeof out[key] === 'string').sort((a, b) => out[b].length - out[a].length);
  for (const key of keys) {
    const chars = [...out[key]];
    // count 0 is empty, count n < length is the first n code points plus an ellipsis.
    const fits = count => { out[key] = count === 0 ? '' : `${chars.slice(0, count).join('')}…`; return bytes(lineOf(out)) <= EVENT_MAX_BYTES; };
    if (!fits(0)) continue;
    let lo = 0;
    let hi = chars.length - 1;
    while (lo < hi) { const mid = Math.ceil((lo + hi) / 2); if (fits(mid)) lo = mid; else hi = mid - 1; }
    fits(lo);
    return out;
  }
  return bytes(lineOf(out)) <= EVENT_MAX_BYTES ? out : null;
}

// Appends one event. Returns true when the line was written, false when it was not (the failure is logged as
// HUB_EVENT_LOG_FAILED <reason>). Never throws. The envelope (format, ts, host, host_id, hub_version) is the writer's and
// wins over any key of the same name in `event`. hub_version is hubRef()'s answer, `unknown` when there is none.
export function appendEvent(event, { env = process.env, now = Date.now, log = console.error, host, hostId: id, hubFile } = {}) {
  try {
    const at = new Date(now());
    const record = fit({
      ...event,
      format: EVENT_FORMAT,
      ts: at.toISOString(),
      host: host ?? osHostname(),
      host_id: id === undefined ? hostId() : id,
      hub_version: (hubFile === undefined ? hubRef(env) : hubRef(env, hubFile)) ?? 'unknown',
    });
    if (!record) throw Object.assign(new Error(`event exceeds ${EVENT_MAX_BYTES} bytes`), { code: 'E2BIG' });
    // Envelope first, so a reader scanning a line sees the identity before the payload.
    const { format, ts, host: h, host_id, hub_version, ...rest } = record;
    const data = Buffer.from(lineOf({ format, ts, host: h, host_id, hub_version, ...rest }));
    const dir = eventDir(env);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const fd = openSync(join(dir, `${record.ts.slice(0, 7)}.jsonl`), 'a', 0o600);
    try {
      if (writeSync(fd, data) !== data.length) throw new Error('short write');
    } finally { closeSync(fd); }
    return true;
  } catch (error) {
    try { log(`HUB_EVENT_LOG_FAILED ${error?.code ?? ''} ${String(error?.message ?? error).split('\n')[0]}`.replace(/ {2,}/g, ' ')); } catch { /* a broken logger is not a reason to fail */ }
    return false;
  }
}

const monthOf = ms => new Date(ms).toISOString().slice(0, 7);
const toMs = value => (value === undefined || value === null ? null : typeof value === 'number' ? value : Date.parse(value instanceof Date ? value.toISOString() : value));

// Yields the parsed events in file order (months ascending, lines as written), restricted to ts in [since, until) when
// given. A line that is not a JSON object, or has no readable ts while a bound is set, is skipped and counted: one
// HUB_EVENT_LOG_SKIPPED <file> malformed=<n> line per file, and `stats.skipped` when a stats object is passed. A missing
// event dir yields nothing. Months outside the bounds are not opened.
export function* readEvents({ env = process.env, since, until, log = console.error, stats } = {}) {
  const from = toMs(since);
  const to = toMs(until);
  if ((from !== null && !Number.isFinite(from)) || (to !== null && !Number.isFinite(to))) throw new TypeError('since and until must be dates');
  const dir = eventDir(env);
  let files = [];
  try { files = readdirSync(dir).filter(name => /^\d{4}-\d{2}\.jsonl$/.test(name)).sort(); } catch { return; }
  for (const name of files) {
    const month = name.slice(0, 7);
    if (from !== null && month < monthOf(from)) continue;
    if (to !== null && month > monthOf(to)) continue;
    let text = '';
    try { text = readFileSync(join(dir, name), 'utf8'); } catch { continue; }
    let skipped = 0;
    for (const line of text.split('\n')) {
      if (line === '') continue;
      let event = null;
      try { event = JSON.parse(line); } catch { /* counted below */ }
      const ts = Date.parse(event?.ts);
      if (!event || typeof event !== 'object' || Array.isArray(event) || ((from !== null || to !== null) && !Number.isFinite(ts))) { skipped += 1; continue; }
      if ((from !== null && ts < from) || (to !== null && ts >= to)) continue;
      yield event;
    }
    if (skipped > 0) {
      if (stats) stats.skipped = (stats.skipped ?? 0) + skipped;
      try { log(`HUB_EVENT_LOG_SKIPPED ${name} malformed=${skipped}`); } catch { /* see appendEvent */ }
    }
  }
}

// An event's id (AD-39): `<host_id>/<YYYY-MM>/<byte offset of its line>`. Derived on read from where the line sits and never
// written, so bytes already in the log are never touched. A host that cannot name itself reads as `unknown`.
export const eventId = (id, month, offset) => `${id ?? 'unknown'}/${month}/${offset}`;

export const EVENT_READ_MAX_BYTES = 1024 * 1024;

// Reads one month of the log from byte `offset`: only the lines that are complete (end in a newline), up to `maxBytes`, so a
// writer that is mid-append is never read torn. Returns {month, from, offset, lines, events}: `from` is where the read started,
// `offset` the new end (pass it back to continue), `lines` the raw lines byte-exact with their newline (a replica concatenates
// them), and `events` one {id, offset, event} per line, in the same order. A line that is not a JSON object has event null and
// id null; its bytes are still in `lines`. The id's host part is the line's own `host_id` when that is a machine id (hostId()'s
// rule: 1 to 64 of letters, digits and dashes), so a replica of another host's log keeps that host's ids; otherwise the `hostId`
// option when the caller passed one that is a machine id too, else `unknown`. This reader never looks up its own machine id. A missing month file is an
// empty read that leaves `offset` where it was. An offset past the end of the file, or not just after a newline, is a RangeError
// with code HUB_EVENT_OFFSET (the caller holds a position this log never had). A complete line longer than `maxBytes` (appendEvent
// never writes one: a hand edit or a foreign writer did) cannot be returned and would stall a resuming reader, so it is a
// RangeError with code HUB_EVENT_LINE_TOO_LONG. Bad arguments are a TypeError. `maxBytes` is at least EVENT_MAX_BYTES, so every
// line appendEvent wrote fits.
export function readEventsFrom({ env = process.env, month, offset = 0, maxBytes = EVENT_READ_MAX_BYTES, hostId: id } = {}) {
  if (typeof month !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new TypeError('month must be YYYY-MM');
  if (!Number.isSafeInteger(offset) || offset < 0) throw new TypeError('offset must be a whole number of bytes, 0 or more');
  if (!Number.isSafeInteger(maxBytes) || maxBytes < EVENT_MAX_BYTES) throw new TypeError(`maxBytes must be at least ${EVENT_MAX_BYTES}`);
  const fallback = typeof id === 'string' && /^[0-9A-Za-z-]{1,64}$/.test(id) ? id : null;
  const empty = { month, from: offset, offset, lines: [], events: [] };
  let fd;
  try { fd = openSync(join(eventDir(env), `${month}.jsonl`), 'r'); } catch (error) {
    if (error.code === 'ENOENT') return empty;
    throw error;
  }
  try {
    const size = fstatSync(fd).size;
    const bad = why => Object.assign(new RangeError(`offset ${offset} ${why} in ${month}.jsonl (${size} bytes)`), { code: 'HUB_EVENT_OFFSET' });
    if (offset > size) throw bad('is past the end');
    if (offset > 0) {
      const before = Buffer.alloc(1);
      if (readSync(fd, before, 0, 1, offset - 1) !== 1 || before[0] !== 0x0a) throw bad('is not at the start of a line');
    }
    const want = Math.min(size - offset, maxBytes);
    const buffer = Buffer.alloc(want);
    let got = 0;
    while (got < want) {
      const n = readSync(fd, buffer, got, want - got, offset + got);
      if (n === 0) break;
      got += n;
    }
    const end = buffer.subarray(0, got).lastIndexOf(0x0a) + 1;
    if (end === 0) {
      if (got === maxBytes) throw Object.assign(new RangeError(`the line at offset ${offset} in ${month}.jsonl is longer than ${maxBytes} bytes`), { code: 'HUB_EVENT_LINE_TOO_LONG' });
      return empty;
    }
    const lines = [];
    const events = [];
    let start = 0;
    while (start < end) {
      const stop = buffer.indexOf(0x0a, start) + 1;
      const line = buffer.toString('utf8', start, stop);
      let event = null;
      try { event = JSON.parse(line); } catch { /* not JSON: kept as a line, no event */ }
      if (!event || typeof event !== 'object' || Array.isArray(event)) event = null;
      lines.push(line);
      // The id names the writer: the line's own host_id when it is a machine id (never a forged `a/b`), else what the caller named.
      const writer = typeof event?.host_id === 'string' && /^[0-9A-Za-z-]{1,64}$/.test(event.host_id) ? event.host_id : fallback;
      events.push({ id: event ? eventId(writer, month, offset + start) : null, offset: offset + start, event });
      start = stop;
    }
    return { month, from: offset, offset: offset + end, lines, events };
  } finally { closeSync(fd); }
}
