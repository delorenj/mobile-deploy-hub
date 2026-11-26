// The change feed (Story 8.5, AD-43, FR-14, NFR-3): what turns "something changed on disk" into frames on a stream, for any hub service's
// `createStream` (stream.mjs). Three parts, each generic:
//   - `hubPaths(env)`: the directories the Hub API watches (the lock dir, `emulators/`, every `<name>.lock|.queue|.reservations`, the event dir);
//   - `createWatchSet`: a re-arming set of `fs.watch` handles over any list of directories. Every notification re-lists and re-arms, so a
//     directory created or replaced after the start is watched from its first notification on;
//   - `createChangeFeed`: notifications (or `poke()`, for an in-process source such as Epic 9's Mac push) schedule one trailing re-read.
//     It emits the Event Log lines appended since the last one as `event` frames, and a `status` frame only when the document changed for a
//     reason other than time.
//
// Whatever the OS says about a change is never trusted: the event type and the filename are ignored, and every notification means "look
// again". The timer is `trailing` in stream.mjs (the hub's one clock file); nothing here emits from a timer or a poll.
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { eventDir } from '../ci/lib/events.mjs';
import { lockDir } from '../ci/lib/lock.mjs';
import { CHANGE_DEBOUNCE_MS, trailing } from './stream.mjs';

const oneLine = value => String(value?.message ?? value).replace(/\s+/g, ' ').trim();
const WATCHED = /\.(lock|queue|reservations)$/;

// The directories to watch, read fresh on every call: the lock dir, its `emulators/`, every `<name>.lock`, `<name>.queue` and
// `<name>.reservations` directory in it (sorted), and the event dir. A tomb (`<name>.lock.tomb-<ms>-<pid>`) ends in neither suffix and a
// `.released-*` entry is never one, so neither is watched. A path that does not exist yet is listed anyway: the watch set opens it when it appears.
export function hubPaths(env = process.env) {
  const locks = lockDir(env);
  let names = [];
  try {
    names = readdirSync(locks, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && WATCHED.test(entry.name) && !entry.name.startsWith('.released-'))
      .map(entry => entry.name)
      .sort();
  } catch { /* no lock dir yet: only the fixed paths */ }
  return [locks, join(locks, 'emulators'), ...names.map(name => join(locks, name)), eventDir(env)];
}

// A re-arming watch set. `paths` is a list of directories, or a function returning one (called on every sync). `watch(path, {persistent:
// false}, listener)` is `fs.watch`. `stat` is `fs.statSync`. `sync()` closes the watchers of directories that are gone or no longer listed,
// opens one for each listed directory that has none, and reopens one whose inode changed (a replaced directory). Any watcher notification
// or `error` calls `notify()`: a `sync()` (the re-arm), then `onNotify()`. Returns `{sync, notify, close, watched}`.
export function createWatchSet({ paths, watch, stat = statSync, onNotify = () => {}, log = () => {} } = {}) {
  if (typeof watch !== 'function') throw new TypeError('createWatchSet needs a watch function');
  const open = new Map();   // path -> {watcher, id}
  let listed = [];
  let closed = false;
  const say = line => { try { log(line); } catch { /* a broken logger never stops a watch */ } };
  const quiet = watcher => { try { watcher.close(); } catch { /* already closed */ } };
  const identity = path => {
    try {
      const info = stat(path);
      // The birth time rides along: a freed inode number is reused quickly, so a retired and re-made directory can share dev:ino.
      return info.isDirectory() ? `${info.dev}:${info.ino}:${info.birthtimeMs}` : null;
    } catch { return null; }
  };

  function sync() {
    if (closed) return;
    const want = typeof paths === 'function' ? paths() : paths;
    listed = [...new Set(want)];
    for (const [path, entry] of [...open]) {
      if (!listed.includes(path) || identity(path) !== entry.id) { quiet(entry.watcher); open.delete(path); }
    }
    for (const path of listed) {
      if (open.has(path)) continue;
      const id = identity(path);
      if (id === null) continue;
      try {
        const watcher = watch(path, { persistent: false }, () => notify());
        // A watcher that errored is dead even when its directory is not: drop it, so the sync in `notify()` opens a fresh one.
        watcher?.on?.('error', () => {
          if (open.get(path)?.watcher === watcher) { quiet(watcher); open.delete(path); }
          notify();
        });
        open.set(path, { watcher, id });
      } catch (error) { say(`HUB_API_WATCH_FAILED ${path} ${oneLine(error)}`); }
    }
  }

  function notify() {
    if (closed) return;
    try { sync(); } catch (error) { say(`HUB_API_WATCH_FAILED sync ${oneLine(error)}`); }
    onNotify();
  }

  return {
    sync, notify,
    close() {
      closed = true;
      for (const entry of open.values()) quiet(entry.watcher);
      open.clear();
    },
    watched: () => listed.filter(path => open.has(path)),
  };
}

// The change feed of one stream. `render(at)` builds the document as of the instant `at` (every time-derived field comes from `at`, so a
// render at an old instant of the current disk is identical to the old document exactly when nothing but time moved). `render(at, {steady:
// true})` is the same document with the one clock the caller cannot freeze (a reading stamped by a live source) pinned to `at` too: the feed
// compares only steady renders, and sends only plain ones, so a heartbeat touch or a duplicate notification is never a frame. `follow()`
// makes the Event Log tail (`{read()}`). `watch` is `fs.watch`, or null (no watcher: only `poke()` schedules a re-read). `paths` is what to
// watch. Returns `{start, poke, settled, close, watched}`; `start()` resolves once the baseline is primed (it never throws).
export function createChangeFeed({ stream, render, now = Date.now, paths, watch = null, follow, debounceMs = CHANGE_DEBOUNCE_MS, timers, log = () => {} } = {}) {
  if (!Number.isFinite(debounceMs) || debounceMs < 0 || debounceMs > CHANGE_DEBOUNCE_MS) throw new RangeError(`debounceMs must be between 0 and ${CHANGE_DEBOUNCE_MS}`);
  let tail = null;
  let baseline = null;    // {at, text}: the steady render of the last document sent (or primed)
  let primed = Promise.resolve();
  let started = false;
  let closed = false;
  let failure = null;

  // One line per distinct failure: a render that keeps failing the same way is not repeated until something succeeds.
  const fail = error => {
    const why = oneLine(`${error?.code ? `${error.code} ` : ''}${error?.message ?? error}`);
    if (why === failure) return;
    failure = why;
    try { log(`HUB_API_STREAM_FAILED ${why}`); } catch { /* a broken logger never stops the feed */ }
  };
  const steady = async at => JSON.stringify(await render(at, { steady: true }));

  async function reread() {
    await primed;
    if (closed) return;
    let ok = true;
    try { tail ??= follow(); } catch (error) { ok = false; fail(error); }
    let entries = [];
    try { entries = tail ? tail.read() : []; } catch (error) { ok = false; fail(error); }
    for (const entry of entries) {
      try { stream.event(entry); } catch (error) { ok = false; fail(error); }
    }
    try {
      if (baseline !== null && await steady(baseline.at) === baseline.text) { if (ok) failure = null; return; }
      // The comparison text is taken before the document is sent: a change that lands between the two is then a difference the next
      // re-read finds (a repeated absolute frame at worst), never one it swallows.
      const at = now();
      const text = await steady(at);
      stream.status(await render(at));
      baseline = { at, text };
    } catch (error) { ok = false; fail(error); }
    if (ok) failure = null;
  }

  const debounce = trailing(reread, { delayMs: debounceMs, ...(timers ? { timers } : {}), onError: fail });
  const set = watch ? createWatchSet({ paths, watch, onNotify: () => debounce.poke(), log }) : null;

  return {
    // Creates the tail (so nothing written from now on is missed), arms the watchers and primes the baseline from one render.
    start() {
      if (started || closed) return primed;
      started = true;
      try { tail = follow(); } catch (error) { fail(error); }
      try { set?.sync(); } catch (error) { try { log(`HUB_API_WATCH_FAILED sync ${oneLine(error)}`); } catch { /* see fail */ } }
      primed = (async () => {
        try {
          const at = now();
          baseline = { at, text: await steady(at) };
        } catch (error) { fail(error); }
      })();
      return primed;
    },
    poke: debounce.poke,
    settled: debounce.settled,
    close() {
      closed = true;
      set?.close();
      debounce.close();
    },
    watched: () => set?.watched() ?? [],
  };
}
