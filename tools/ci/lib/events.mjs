// The Event Log (AD-9, AD-10): an append-only, local history of every transition on a Queued host lock. One JSON line per
// event, in HUB_EVENT_DIR/<YYYY-MM>.jsonl on the host that owns the lock, written with a single O_APPEND write so
// concurrent processes (several hub versions share one lock dir) never tear a line. A failed write is logged and never
// fails the transition it describes. Only lock.mjs calls appendEvent; callers read through readEvents.
import { spawnSync } from 'node:child_process';
import { closeSync, mkdirSync, openSync, readFileSync, readdirSync, writeSync } from 'node:fs';
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
