// Story 8.5 (FR-14, NFR-3, AD-43): a change reaches subscribers within two seconds. Unit rows drive `trailing`, `eventsEnd`/`followEvents`,
// `hubPaths`, `createWatchSet` and `createChangeFeed` with a fake watcher, a virtual timer and a fake response. The service rows start
// `startHubApi` with a FakeServer listener, a fake `watch` and a mocked `setTimeout`; the three writers (hub-device's `acquireLease`, a deploy
// job's `withLock` and `POST /leases`) write a real temp lock dir and a notification follows. One Linux-only smoke test runs a real `fs.watch`.
// No port, no real adb server and no real clock in the shared rows.
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, statSync, truncateSync, utimesSync, watch as fsWatch, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadDevices } from '../ci/lib/devices.mjs';
import { appendEvent, eventsEnd, followEvents } from '../ci/lib/events.mjs';
import { acquireLease, processStart, releaseLease, withLock } from '../ci/lib/lock.mjs';
import { loadPolicy } from '../ci/lib/policy.mjs';
import { hermetic } from '../ci/test-fixtures.mjs';
import { createChangeFeed, createWatchSet, hubPaths } from './changes.mjs';
import { startHubApi, watchFor } from './server.mjs';
import { CHANGE_DEBOUNCE_MS, createStream, trailing } from './stream.mjs';

hermetic();

const policy = loadPolicy().policy;
const BOOT = 'abcdef012345';
const T0 = Date.parse('2026-11-25T10:00:00Z');
const flush = async (rounds = 25) => { for (let round = 0; round < rounds; round += 1) await new Promise(done => setImmediate(done)); };

function scratchDir(prefix = 'hub-api-changes-') {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const env = { PATH: process.env.PATH, HOME: root, HUB_LOCK_DIR: join(root, 'locks'), HUB_EVENT_DIR: join(root, 'events'), HUB_ADB_SERVER_PORT: '5037' };
  return { root, env, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

// A virtual one-shot clock: `advance(ms)` fires every due timer in time order.
function fakeTimeouts() {
  const state = { t: 0, next: 1, armed: new Map(), created: 0 };
  return {
    setTimeout(fn, ms) {
      const id = state.next++;
      state.created += 1;
      state.armed.set(id, { fn, due: state.t + ms });
      return { id, unref() { this.unrefd = true; } };
    },
    clearTimeout(handle) { state.armed.delete(handle?.id); },
    advance(ms) {
      const end = state.t + ms;
      for (;;) {
        const due = [...state.armed.entries()].filter(([, timer]) => timer.due <= end).sort((a, b) => a[1].due - b[1].due)[0];
        if (!due) break;
        state.armed.delete(due[0]);
        state.t = due[1].due;
        due[1].fn();
      }
      state.t = end;
    },
    armed: () => state.armed.size,
    created: () => state.created,
    now: () => state.t,
  };
}

// A fake `fs.watch`: records every open, plays notifications and errors, and counts closes.
function fakeWatch() {
  const all = [];
  const watch = (path, options, listener) => {
    const entry = { path, options, listener, closed: false, onError: [] };
    all.push(entry);
    return { close() { entry.closed = true; }, on(name, fn) { if (name === 'error') entry.onError.push(fn); return this; } };
  };
  const live = () => all.filter(entry => !entry.closed);
  return {
    watch, all, live,
    paths: () => live().map(entry => entry.path).sort(),
    fire(path, ...args) { for (const entry of live().filter(item => item.path === path)) entry.listener(...args); },
    error(path) { for (const entry of live().filter(item => item.path === path)) for (const fn of entry.onError) fn(new Error('watch failed')); },
  };
}

// A response-shaped sink (as stream.test.mjs).
class FakeSink extends EventEmitter {
  chunks = [];
  ended = false;
  destroyed = false;
  writableFinished = false;
  writableLength = 0;
  head = null;
  writeHead(status, headers) { this.head = { status, headers }; }
  write(text) { if (this.destroyed) throw new Error('write after destroy'); this.chunks.push(text); return true; }
  end() { this.ended = true; this.writableFinished = true; this.emit('close'); }
  destroy() { this.destroyed = true; this.emit('close'); }
  get text() { return this.chunks.join(''); }
}
function parse(text) {
  return text.split('\n\n').filter(block => block !== '').map(block => {
    const lines = block.split('\n');
    if (lines.length === 1 && lines[0].startsWith('retry: ')) return { retry: Number(lines[0].slice(7)) };
    if (lines.length === 1 && lines[0].startsWith(': ')) return { comment: lines[0].slice(2) };
    const field = name => lines.find(line => line.startsWith(`${name}: `))?.slice(name.length + 2);
    return { id: field('id'), event: field('event'), data: JSON.parse(field('data')) };
  });
}
const frames = sink => parse(sink.text).filter(frame => frame.id);
const live = sink => frames(sink).filter(frame => frame.event === 'status' || frame.event === 'event');

const ts = text => Date.parse(text);
const put = (env, at, extra = {}) => appendEvent({ event: 'release', lock: 'adb', ...extra }, { env, now: () => ts(at), hostId: 'h1', log: () => {} });

// ---- trailing ----

test('trailing: five pokes within 100 ms run once, 250 ms after the first and not at 249', async () => {
  const timers = fakeTimeouts();
  let runs = 0;
  const t = trailing(() => { runs += 1; }, { delayMs: CHANGE_DEBOUNCE_MS, timers });
  for (let n = 0; n < 5; n += 1) { t.poke(); timers.advance(20); }
  assert.equal(timers.now(), 100);
  assert.equal(timers.created(), 1, 'one timer for the whole burst');
  timers.advance(149);
  await t.settled();
  assert.equal(runs, 0, 'nothing at 249 ms');
  timers.advance(1);
  await t.settled();
  assert.equal(runs, 1);
  assert.equal(timers.armed(), 0);
  timers.advance(10_000);
  await t.settled();
  assert.equal(runs, 1, 'nothing arms without a poke');
});

test('trailing: a steady stream of pokes cannot push the run back, and the timer is unref\'d', async () => {
  const timers = fakeTimeouts();
  let runs = 0;
  let handle;
  const t = trailing(() => { runs += 1; }, { delayMs: 250, timers: { ...timers, setTimeout: (...args) => { handle = timers.setTimeout(...args); return handle; } } });
  for (let n = 0; n < 24; n += 1) { t.poke(); timers.advance(10); }
  assert.equal(runs, 0);
  t.poke();
  timers.advance(10);
  await t.settled();
  assert.equal(runs, 1, 'it ran at 250 ms although pokes never stopped');
  assert.equal(handle.unrefd, true);
});

test('trailing: a poke during a run marks it dirty and a second run follows, never two at once', async () => {
  const timers = fakeTimeouts();
  let release;
  let active = 0;
  let most = 0;
  let runs = 0;
  const t = trailing(async () => {
    runs += 1;
    active += 1;
    most = Math.max(most, active);
    if (runs === 1) await new Promise(resolve => { release = resolve; });
    active -= 1;
  }, { delayMs: 250, timers });
  t.poke();
  timers.advance(250);
  await flush(2);
  assert.equal(runs, 1);
  t.poke();
  t.poke();
  timers.advance(1000);
  assert.equal(runs, 1, 'no run starts while one is in flight');
  release();
  await t.settled();
  assert.equal(timers.armed(), 1, 'the run\'s end poked once');
  timers.advance(250);
  await t.settled();
  assert.equal(runs, 2);
  assert.equal(most, 1);
  assert.equal(timers.armed(), 0);
});

test('trailing: close clears the timer, later pokes do nothing, and a failing work goes to onError and never stops it', async () => {
  const timers = fakeTimeouts();
  const errors = [];
  let runs = 0;
  const t = trailing(() => { runs += 1; throw new Error(`boom ${runs}`); }, { delayMs: 250, timers, onError: error => errors.push(error.message) });
  t.poke();
  timers.advance(250);
  await t.settled();
  t.poke();
  timers.advance(250);
  await t.settled();
  assert.deepEqual(errors, ['boom 1', 'boom 2']);
  t.poke();
  t.close();
  assert.equal(timers.armed(), 0);
  t.poke();
  timers.advance(1000);
  await t.settled();
  assert.equal(runs, 2);
  assert.equal(timers.armed(), 0);
  assert.throws(() => trailing(() => {}, { delayMs: -1 }), RangeError);
});

// ---- the Event Log tail ----

test('eventsEnd: the offset just past the last complete line, 0 for a missing file, and across chunk boundaries', () => {
  const s = scratchDir();
  try {
    assert.equal(eventsEnd({ env: s.env, month: '2026-11' }), 0);
    mkdirSync(s.env.HUB_EVENT_DIR, { recursive: true });
    const file = join(s.env.HUB_EVENT_DIR, '2026-11.jsonl');
    writeFileSync(file, '{"a":1}\n{"b":2}\n{"torn":');
    assert.equal(eventsEnd({ env: s.env, month: '2026-11' }), 16, 'a torn tail is not complete');
    writeFileSync(file, 'no newline at all');
    assert.equal(eventsEnd({ env: s.env, month: '2026-11' }), 0);
    // A last newline further back than one 64 KiB chunk.
    const head = `${'x'.repeat(10)}\n`;
    writeFileSync(file, `${head}${'y'.repeat(200_000)}`);
    assert.equal(eventsEnd({ env: s.env, month: '2026-11' }), head.length);
    writeFileSync(file, `${head}${'y'.repeat(200_000)}\n`);
    assert.equal(eventsEnd({ env: s.env, month: '2026-11' }), head.length + 200_001);
    assert.throws(() => eventsEnd({ env: s.env, month: 'nope' }), TypeError);
  } finally { s.cleanup(); }
});

test('followEvents: starts at the end, returns only what was appended since the last read, and skips a line that is not an event', () => {
  const s = scratchDir();
  try {
    put(s.env, '2026-11-25T09:00:00Z', { run: 'old' });
    const tail = followEvents({ env: s.env, now: () => T0, hostId: 'h1', log: () => {} });
    assert.deepEqual(tail.read(), [], 'history is not replayed');
    put(s.env, '2026-11-25T10:00:01Z', { run: 'a' });
    appendFileSync(join(s.env.HUB_EVENT_DIR, '2026-11.jsonl'), 'this is not json\n');
    put(s.env, '2026-11-25T10:00:02Z', { run: 'b' });
    const read = tail.read();
    assert.deepEqual(read.map(entry => entry.event.claimant?.run ?? entry.event.run), ['a', 'b']);
    assert.ok(read.every(entry => /^h1\/2026-11\/\d+$/.test(entry.id) && Number.isInteger(entry.offset)));
    assert.deepEqual(tail.read(), []);
    put(s.env, '2026-11-25T10:00:03Z', { run: 'c' });
    assert.equal(tail.read().length, 1);
  } finally { s.cleanup(); }
});

test('followEvents: with no event dir it starts at now\'s month, and the first lines are read from 0', () => {
  const s = scratchDir();
  try {
    const tail = followEvents({ env: s.env, now: () => T0, hostId: 'h1', log: () => {} });
    assert.deepEqual(tail.read(), []);
    put(s.env, '2026-11-25T10:00:01Z', { run: 'first' });
    const read = tail.read();
    assert.equal(read.length, 1);
    assert.equal(read[0].offset, 0);
  } finally { s.cleanup(); }
});

test('followEvents: month change reads the rest of November, then December from offset 0', () => {
  const s = scratchDir();
  try {
    put(s.env, '2026-11-30T12:00:00Z', { run: 'seed' });
    const tail = followEvents({ env: s.env, now: () => ts('2026-11-30T12:00:00Z'), hostId: 'h1', log: () => {} });
    put(s.env, '2026-11-30T23:59:58Z', { run: 'nov-1' });
    put(s.env, '2026-11-30T23:59:59Z', { run: 'nov-2' });
    put(s.env, '2026-12-01T00:00:01Z', { run: 'dec-1' });
    put(s.env, '2026-12-01T00:00:02Z', { run: 'dec-2' });
    const read = tail.read();
    assert.deepEqual(read.map(entry => entry.id.split('/').slice(1, 2).join()), ['2026-11', '2026-11', '2026-12', '2026-12']);
    assert.equal(read[2].offset, 0);
    put(s.env, '2026-12-01T00:00:03Z', { run: 'dec-3' });
    const later = tail.read();
    assert.equal(later.length, 1);
    assert.match(later[0].id, /\/2026-12\//);
  } finally { s.cleanup(); }
});

test('followEvents: a truncated month (HUB_EVENT_OFFSET) is one HUB_EVENT_FOLLOW_SKIPPED line and the tail jumps to the end', () => {
  const s = scratchDir();
  try {
    put(s.env, '2026-11-25T09:00:00Z', { run: 'one' });
    put(s.env, '2026-11-25T09:00:01Z', { run: 'two' });
    const lines = [];
    const tail = followEvents({ env: s.env, now: () => T0, hostId: 'h1', log: line => lines.push(line) });
    truncateSync(join(s.env.HUB_EVENT_DIR, '2026-11.jsonl'), 10);
    assert.deepEqual(tail.read(), []);
    assert.deepEqual(lines, ['HUB_EVENT_FOLLOW_SKIPPED 2026-11 HUB_EVENT_OFFSET']);
    writeFileSync(join(s.env.HUB_EVENT_DIR, '2026-11.jsonl'), `${'z'.repeat(2 * 1024 * 1024)}\n`);
    assert.deepEqual(tail.read(), []);
    assert.deepEqual(lines.slice(1), ['HUB_EVENT_FOLLOW_SKIPPED 2026-11 HUB_EVENT_LINE_TOO_LONG'], 'the tail was at 0 of the replaced file, and its first line is over the bound');
  } finally { s.cleanup(); }
});

test('followEvents: a line over the read bound is skipped with HUB_EVENT_LINE_TOO_LONG and later lines are read', () => {
  const s = scratchDir();
  try {
    put(s.env, '2026-11-25T09:00:00Z', { run: 'one' });
    const lines = [];
    const tail = followEvents({ env: s.env, now: () => T0, hostId: 'h1', log: line => lines.push(line) });
    appendFileSync(join(s.env.HUB_EVENT_DIR, '2026-11.jsonl'), `${'z'.repeat(2 * 1024 * 1024)}\n`);
    assert.deepEqual(tail.read(), []);
    assert.deepEqual(lines, ['HUB_EVENT_FOLLOW_SKIPPED 2026-11 HUB_EVENT_LINE_TOO_LONG']);
    put(s.env, '2026-11-25T10:00:00Z', { run: 'after' });
    assert.equal(tail.read().length, 1);
  } finally { s.cleanup(); }
});

// ---- hubPaths and the watch set ----

test('hubPaths: the lock dir, emulators, each .lock/.queue/.reservations directory (sorted) and the event dir; never a tomb, a file or a .released path', () => {
  const s = scratchDir();
  try {
    const locks = s.env.HUB_LOCK_DIR;
    for (const name of ['s24.reservations', 'adb.queue', 'adb.lock', 'adb.lock.tomb-1-2', '.released-k-1.lock', 'res-x.queue.tomb-3-4']) mkdirSync(join(locks, name), { recursive: true });
    writeFileSync(join(locks, 'x.lock'), 'a file');
    assert.deepEqual(hubPaths(s.env), [locks, join(locks, 'emulators'), join(locks, 'adb.lock'), join(locks, 'adb.queue'), join(locks, 's24.reservations'), s.env.HUB_EVENT_DIR]);
    rmSync(locks, { recursive: true });
    assert.deepEqual(hubPaths(s.env), [locks, join(locks, 'emulators'), s.env.HUB_EVENT_DIR], 'read fresh on every call, and a missing lock dir is not an error');
  } finally { s.cleanup(); }
});

test('createWatchSet: arms the existing directories only, and persistent is false', () => {
  const s = scratchDir();
  try {
    const locks = s.env.HUB_LOCK_DIR;
    for (const name of ['adb.lock', 'adb.queue', 's24.reservations', 'adb.lock.tomb-1-2']) mkdirSync(join(locks, name), { recursive: true });
    writeFileSync(join(locks, 'x.lock'), 'a file');
    mkdirSync(s.env.HUB_EVENT_DIR, { recursive: true });
    const fake = fakeWatch();
    const set = createWatchSet({ paths: () => hubPaths(s.env), watch: fake.watch });
    set.sync();
    assert.deepEqual([...set.watched()].sort(), [locks, join(locks, 'adb.lock'), join(locks, 'adb.queue'), join(locks, 's24.reservations'), s.env.HUB_EVENT_DIR].sort());
    assert.equal(set.watched().includes(join(locks, 'emulators')), false, 'emulators/ is absent: not watched');
    assert.ok(fake.all.every(entry => entry.options.persistent === false));
  } finally { s.cleanup(); }
});

test('createWatchSet: a create re-arms whatever filename the notification carried, and a notification calls onNotify once', () => {
  const s = scratchDir();
  try {
    const locks = s.env.HUB_LOCK_DIR;
    mkdirSync(locks, { recursive: true });
    const fake = fakeWatch();
    let notified = 0;
    const set = createWatchSet({ paths: () => hubPaths(s.env), watch: fake.watch, onNotify: () => { notified += 1; } });
    set.sync();
    mkdirSync(join(locks, 's24.lock'));
    assert.equal(set.watched().includes(join(locks, 's24.lock')), false);
    fake.fire(locks, 'rename', 'junk/../name');
    assert.equal(notified, 1);
    assert.ok(set.watched().includes(join(locks, 's24.lock')));
    rmSync(join(locks, 's24.lock'), { recursive: true });
    fake.fire(locks, 'change', null);
    assert.equal(set.watched().includes(join(locks, 's24.lock')), false, 'a gone directory is closed');
    assert.equal(fake.all.filter(entry => entry.path === join(locks, 's24.lock')).every(entry => entry.closed), true);
  } finally { s.cleanup(); }
});

test('createWatchSet: a replaced directory (new inode) is reopened, the old watcher closed, and the tomb is not watched', () => {
  const s = scratchDir();
  try {
    const locks = s.env.HUB_LOCK_DIR;
    mkdirSync(join(locks, 'adb.lock'), { recursive: true });
    const fake = fakeWatch();
    const set = createWatchSet({ paths: () => hubPaths(s.env), watch: fake.watch });
    set.sync();
    const first = fake.all.find(entry => entry.path === join(locks, 'adb.lock'));
    renameSync(join(locks, 'adb.lock'), join(locks, 'adb.lock.tomb-1-2'));
    mkdirSync(join(locks, 'adb.lock'));
    fake.fire(locks, 'rename', 'adb.lock');
    assert.equal(first.closed, true);
    const opened = fake.all.filter(entry => entry.path === join(locks, 'adb.lock'));
    assert.equal(opened.length, 2);
    assert.equal(opened[1].closed, false);
    assert.equal(fake.paths().some(path => path.includes('tomb')), false);
    // A repeat with nothing changed opens nothing.
    fake.fire(locks, 'change', 'alive');
    assert.equal(fake.all.filter(entry => entry.path === join(locks, 'adb.lock')).length, 2);
  } finally { s.cleanup(); }
});

test('createWatchSet: a directory that kept its dev:ino but was born again (a reused inode number) is reopened', () => {
  const s = scratchDir();
  try {
    const locks = s.env.HUB_LOCK_DIR;
    mkdirSync(join(locks, 'adb.lock'), { recursive: true });
    const fake = fakeWatch();
    const born = { ms: 1000 };
    const stat = path => { const info = statSync(path); return { isDirectory: () => info.isDirectory(), dev: 1, ino: 7, birthtimeMs: born.ms }; };
    const set = createWatchSet({ paths: () => hubPaths(s.env), watch: fake.watch, stat });
    set.sync();
    const adb = () => fake.all.filter(entry => entry.path === join(locks, 'adb.lock'));
    set.sync();
    assert.equal(adb().length, 1, 'the same dev:ino and birth time opens nothing');
    born.ms = 2000;
    set.sync();
    assert.equal(adb().length, 2);
    assert.equal(adb()[0].closed, true);
    assert.equal(adb()[1].closed, false);
  } finally { s.cleanup(); }
});

test('watchFor: node\'s fs.watch when nothing is injected and the host is real, null when faked, the injected value when one is passed', () => {
  assert.equal(watchFor({ watch: undefined, faked: false }), fsWatch);
  assert.equal(watchFor({ watch: undefined, faked: true }), null);
  const injected = () => {};
  assert.equal(watchFor({ watch: injected, faked: true }), injected);
  assert.equal(watchFor({ watch: injected, faked: false }), injected);
  assert.equal(watchFor({ watch: null, faked: false }), null, 'an explicit null turns the watcher off');
});

test('createWatchSet: an error calls notify, a failing watch is logged and skipped, and close closes everything and silences the rest', () => {
  const s = scratchDir();
  try {
    const locks = s.env.HUB_LOCK_DIR;
    mkdirSync(join(locks, 'adb.lock'), { recursive: true });
    mkdirSync(s.env.HUB_EVENT_DIR, { recursive: true });
    const fake = fakeWatch();
    const lines = [];
    let notified = 0;
    const flaky = (path, options, listener) => { if (path === s.env.HUB_EVENT_DIR) throw new Error('EMFILE'); return fake.watch(path, options, listener); };
    const set = createWatchSet({ paths: () => hubPaths(s.env), watch: flaky, onNotify: () => { notified += 1; }, log: line => lines.push(line) });
    set.sync();
    assert.equal(set.watched().includes(s.env.HUB_EVENT_DIR), false);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /^HUB_API_WATCH_FAILED .*events EMFILE$/);
    const before = fake.all.filter(entry => entry.path === locks);
    fake.error(locks);
    assert.equal(notified, 1);
    // The errored watcher is dead even though its directory is not: it is closed and a fresh one is open on the same path.
    assert.equal(before.every(entry => entry.closed), true);
    assert.equal(fake.live().filter(entry => entry.path === locks).length, 1);
    assert.equal(set.watched().includes(locks), true);
    set.close();
    assert.deepEqual(fake.live(), []);
    fake.fire(locks);
    set.notify();
    assert.equal(notified, 1);
  } finally { s.cleanup(); }
});

// ---- the change feed ----

// A feed over a fake document: `state.v` is the document's version, `age` a time-derived field, `tail` the entries the next read returns.
function feedFixture(options = {}) {
  const timers = fakeTimeouts();
  const state = { v: 1, clock: T0, tail: [], renders: [], failing: null, gate: null };
  const stream = createStream({ boot: BOOT, now: () => state.clock, timers: { setInterval: () => ({ unref() {} }), clearInterval: () => {} } });
  const lines = [];
  const feed = createChangeFeed({
    stream, timers, now: () => state.clock, log: line => lines.push(line),
    render: async at => {
      state.renders.push(at);
      if (state.gate) await state.gate;
      if (state.failing) throw state.failing;
      return { v: state.v, age: at - T0 };
    },
    follow: () => ({ read: () => state.tail.splice(0) }),
    ...options,
  });
  const sink = new FakeSink();
  stream.attach(sink, { kind: 'resume', after: 0 });
  const change = async () => { feed.poke(); timers.advance(CHANGE_DEBOUNCE_MS); await feed.settled(); };
  return { feed, stream, timers, state, lines, sink, change };
}

test('createChangeFeed: a debounce outside 0..250 ms is a RangeError', () => {
  for (const debounceMs of [251, -1, Number.NaN, Infinity, '100']) {
    assert.throws(() => createChangeFeed({ stream: createStream({ boot: BOOT }), render: async () => ({}), follow: () => ({ read: () => [] }), debounceMs }), RangeError, String(debounceMs));
  }
  createChangeFeed({ stream: createStream({ boot: BOOT }), render: async () => ({}), follow: () => ({ read: () => [] }), debounceMs: 0 });
  createChangeFeed({ stream: createStream({ boot: BOOT }), render: async () => ({}), follow: () => ({ read: () => [] }), debounceMs: 250 });
});

test('createChangeFeed: start primes the baseline with one render and emits nothing; a real change is one status frame rendered now', async () => {
  const f = feedFixture();
  await f.feed.start();
  assert.equal(f.state.renders.length, 1);
  assert.deepEqual(live(f.sink), []);
  f.state.v = 2;
  f.state.clock += 5000;
  await f.change();
  const out = live(f.sink);
  assert.equal(out.length, 1);
  assert.equal(out[0].event, 'status');
  assert.deepEqual(out[0].data.status, { v: 2, age: 5000 });
  assert.deepEqual(f.state.renders, [T0, T0, T0 + 5000, T0 + 5000], 'primed, the same-instant compare, then the steady and the plain render at now');
  f.feed.close();
});

test('createChangeFeed: only time moved (a duplicate notification, a touch after the clock moved) sends no frame and no event', async () => {
  const f = feedFixture();
  await f.feed.start();
  f.state.clock += 3_600_000;
  await f.change();
  await f.change();
  assert.deepEqual(live(f.sink), []);
  assert.equal(f.stream.cursor(), 0);
  // The baseline did not move: a later real change still renders and is sent.
  f.state.v = 2;
  await f.change();
  assert.equal(live(f.sink).length, 1);
  f.feed.close();
});

test('createChangeFeed: new log lines go out as event frames first, then one status frame; a status-less change still sends the events', async () => {
  const f = feedFixture();
  await f.feed.start();
  f.state.tail.push({ id: 'h1/2026-11/0', offset: 0, event: { ts: '2026-11-25T10:00:00.500Z', event: 'request' } }, { id: 'h1/2026-11/90', offset: 90, event: { ts: '2026-11-25T10:00:00.600Z', event: 'acquire' } });
  f.state.v = 2;
  await f.change();
  assert.deepEqual(live(f.sink).map(frame => `${frame.event}:${frame.data.key}`), ['event:h1/2026-11/0', 'event:h1/2026-11/90', 'status:status']);
  f.state.tail.push({ id: 'h1/2026-11/180', offset: 180, event: { ts: '2026-11-25T10:00:00.700Z', event: 'note' } });
  await f.change();
  assert.deepEqual(live(f.sink).slice(3).map(frame => frame.event), ['event'], 'an event with no document change sends no status frame');
  f.feed.close();
});

test('createChangeFeed: five notifications within 100 ms are one re-read at 250 ms, none at 249', async () => {
  const f = feedFixture();
  await f.feed.start();
  const before = f.state.renders.length;
  f.state.v = 2;
  for (let n = 0; n < 5; n += 1) { f.feed.poke(); f.timers.advance(20); }
  f.timers.advance(149);
  await f.feed.settled();
  assert.equal(f.state.renders.length, before, 'none at 249 ms');
  f.timers.advance(1);
  await f.feed.settled();
  assert.equal(live(f.sink).length, 1);
  assert.equal(f.state.renders.length, before + 3, 'one compare, then the steady and the plain render of the change');
  f.feed.close();
});

test('createChangeFeed: a notification during a re-read gives a second re-read after it, never two at once', async () => {
  const f = feedFixture();
  await f.feed.start();
  let release;
  f.state.gate = new Promise(resolve => { release = resolve; });
  f.state.v = 2;
  f.feed.poke();
  f.timers.advance(250);
  await flush(3);
  f.state.v = 3;
  f.feed.poke();
  f.timers.advance(500);
  await flush(3);
  assert.equal(live(f.sink).length, 0, 'the first re-read is still in flight');
  f.state.gate = null;
  release();
  await f.feed.settled();
  assert.deepEqual(live(f.sink).map(frame => frame.data.status.v), [3], 'the first re-read renders after the release, so it already sees version 3');
  const rendered = f.state.renders.length;
  assert.equal(f.timers.armed(), 1, 'the poke during the re-read armed a second one');
  f.timers.advance(250);
  await f.feed.settled();
  assert.ok(f.state.renders.length > rendered, 'a second re-read ran after the first ended');
  assert.deepEqual(live(f.sink).map(frame => frame.data.status.v), [3], 'and found nothing new to send');
  f.feed.close();
});

test('createChangeFeed: a render that fails is one HUB_API_STREAM_FAILED line (repeated only when the message changes) and the events still go out', async () => {
  const f = feedFixture();
  await f.feed.start();
  f.state.failing = Object.assign(new Error('no host key'), { code: 'HUB_HOST_UNKNOWN' });
  f.state.tail.push({ id: 'h1/2026-11/0', offset: 0, event: { ts: '2026-11-25T10:00:00Z', event: 'acquire' } });
  await f.change();
  await f.change();
  assert.deepEqual(live(f.sink).map(frame => frame.event), ['event']);
  assert.deepEqual(f.lines, ['HUB_API_STREAM_FAILED HUB_HOST_UNKNOWN no host key']);
  f.state.failing = new Error('another reason');
  await f.change();
  assert.equal(f.lines.length, 2);
  assert.equal(f.lines[1], 'HUB_API_STREAM_FAILED another reason');
  f.state.failing = null;
  f.state.v = 2;
  await f.change();
  assert.equal(live(f.sink).at(-1).event, 'status');
  f.state.failing = new Error('another reason');
  await f.change();
  assert.equal(f.lines.length, 3, 'a success in between lets the same message log again');
  f.feed.close();
});

test('createChangeFeed: a failing tail is one line and never throws; a failing prime still lets a later change send its status', async () => {
  let reads = 0;
  const f = feedFixture({ follow: () => ({ read: () => { reads += 1; throw new Error('torn'); } }) });
  f.state.failing = new Error('not yet');
  await f.feed.start();
  assert.deepEqual(f.lines, ['HUB_API_STREAM_FAILED not yet']);
  f.state.failing = null;
  await f.change();
  assert.equal(reads, 1);
  assert.deepEqual(f.lines.slice(1), ['HUB_API_STREAM_FAILED torn']);
  assert.equal(live(f.sink).filter(frame => frame.event === 'status').length, 1, 'with no baseline the first re-read sends the document');
  f.feed.close();
});

test('createChangeFeed: close closes the watchers and the debounce, and a later notification does nothing', async () => {
  const s = scratchDir();
  try {
    mkdirSync(s.env.HUB_LOCK_DIR, { recursive: true });
    mkdirSync(s.env.HUB_EVENT_DIR, { recursive: true });
    const fake = fakeWatch();
    const f = feedFixture({ watch: fake.watch, paths: () => hubPaths(s.env) });
    await f.feed.start();
    assert.deepEqual(f.feed.watched().sort(), [s.env.HUB_LOCK_DIR, s.env.HUB_EVENT_DIR].sort());
    fake.fire(s.env.HUB_LOCK_DIR, 'rename', 'x');
    assert.equal(f.timers.armed(), 1);
    f.feed.close();
    assert.equal(f.timers.armed(), 0);
    assert.deepEqual(fake.live(), []);
    f.state.v = 2;
    f.feed.poke();
    fake.fire(s.env.HUB_LOCK_DIR);
    assert.equal(f.timers.armed(), 0);
    f.timers.advance(1000);
    await f.feed.settled();
    assert.deepEqual(live(f.sink), []);
  } finally { s.cleanup(); }
});

// ---- the service ----

async function boot(s, { hostKey = () => 'linux', stream, watch, clock = { t: T0 }, observeStarts = true, adbQuery } = {}) {
  const signals = new EventEmitter();
  const logs = { out: [], err: [] };
  let listener;
  class FakeServer extends EventEmitter {
    constructor(handler) { super(); listener = handler; }
    listen(port, host, callback) { process.nextTick(callback); return this; }
    address() { return { port: 1 }; }
    close(callback) { process.nextTick(callback); return this; }
  }
  const real = processStart(process.pid);
  const running = await startHubApi({
    env: s.env, policy, now: () => clock.t, hostId: 'test-host', devices: structuredClone(loadDevices({})), qaDevices: () => [], versions: { node: '24.15.0' }, onPath: () => true, signals, hostKey,
    log: { out: line => logs.out.push(line), err: line => logs.err.push(line) },
    createServer: handler => new FakeServer(handler),
    observe: async () => ({
      inventory: { adb_servers: [{ port: 5037, pid: 4242, managed: true, cwd: null }], emulators: [], xvfb: [] }, adb: { port: 5037, note: null, listed: [], serials: new Map() },
      starts: new Map(observeStarts ? [[process.pid, real]] : []), live_starts: new Map(),
    }),
    ...(stream ? { stream } : {}), ...(watch ? { watch } : {}), ...(adbQuery ? { adbQuery } : {}),
  });
  return { listener, logs, running, clock, stop: async () => { signals.emit('SIGTERM'); await running.stopped; } };
}

function open(listener, url, headers = {}, method = 'GET', body) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
  const req = { method, url, headers, async *[Symbol.asyncIterator]() { for (const chunk of chunks) yield chunk; } };
  const res = new FakeSink();
  const done = listener(req, res);
  return { res, done };
}
async function call(listener, url, headers, method, body) { const e = open(listener, url, headers, method, body); await e.done; return e.res; }

// A service with a fake watcher and a mocked setTimeout, a subscriber past its ready frame. The lock and event dirs exist (afterBind made them).
async function withService(options, run) {
  const s = scratchDir();
  mock.timers.enable({ apis: ['setTimeout'] });
  let svc;
  try {
    const fake = fakeWatch();
    svc = await boot(s, { watch: fake.watch, ...options });
    await flush();
    const sink = await call(svc.listener, '/stream');
    assert.equal(sink.head.status, 200);
    const ready = frames(sink);
    assert.equal(ready[0].event, 'ready');
    const notify = async (path = s.env.HUB_LOCK_DIR) => { fake.fire(path, 'rename', 'x'); mock.timers.tick(CHANGE_DEBOUNCE_MS); await flush(); };
    await run({ s, svc, fake, sink, notify, since: () => live(sink) });
  } finally {
    await svc?.stop();
    mock.timers.reset();
    s.cleanup();
  }
}
const doc = frame => JSON.stringify(frame.data.status);

test('service: the watch set is the lock dir, each lock/queue/reservations directory and the event dir, with no tomb', async () => {
  const s = scratchDir();
  mock.timers.enable({ apis: ['setTimeout'] });
  let svc;
  try {
    mkdirSync(join(s.env.HUB_LOCK_DIR, 'adb.lock.tomb-1-2'), { recursive: true });
    mkdirSync(join(s.env.HUB_LOCK_DIR, 's24.queue'), { recursive: true });
    const fake = fakeWatch();
    svc = await boot(s, { watch: fake.watch });
    await flush();
    const paths = fake.paths();
    assert.ok(paths.includes(s.env.HUB_LOCK_DIR));
    assert.ok(paths.includes(join(s.env.HUB_LOCK_DIR, 's24.queue')));
    assert.ok(paths.includes(s.env.HUB_EVENT_DIR));
    assert.equal(paths.some(path => path.includes('tomb')), false);
    assert.ok(fake.all.every(entry => entry.options.persistent === false));
  } finally { await svc?.stop(); mock.timers.reset(); s.cleanup(); }
});

test('service: a faked host runs no watcher unless the test passes one, and a stop closes every watcher', async () => {
  const s = scratchDir();
  let svc;
  try {
    svc = await boot(s);
    await flush();
    const none = await call(svc.listener, '/stream');
    assert.equal(frames(none).length, 1);
    await svc.stop();
    svc = null;
  } finally { await svc?.stop(); s.cleanup(); }
  await withService({}, async ({ svc: running, fake }) => {
    assert.ok(fake.live().length >= 2);
    await running.stop();
    assert.deepEqual(fake.live(), []);
  });
});

test('service: hub-device\'s acquireLease reaches a subscriber in 250 ms with the acquire event and one status frame showing the Hold', async () => {
  await withService({}, async ({ s, svc, sink, notify, since }) => {
    const before = doc(frames(sink)[0]);
    assert.equal(before.includes('agent-a'), false);
    await acquireLease('adb', { holder: 'agent-a', why: 'device proof', forMs: 3_600_000, id: 'l-1', env: s.env, log: () => {}, now: () => svc.clock.t, hostId: 'test-host' });
    assert.deepEqual(since(), [], 'nothing is sent before a notification');
    await notify();
    const out = since();
    assert.ok(out.some(frame => frame.event === 'event' && frame.data.event.event === 'acquire'), JSON.stringify(out.map(frame => frame.event)));
    const statuses = out.filter(frame => frame.event === 'status');
    assert.equal(statuses.length, 1);
    assert.ok(doc(statuses[0]).includes('agent-a'));
    assert.ok(out.findIndex(frame => frame.event === 'status') > out.findIndex(frame => frame.event === 'event'), 'events first');
    releaseLease('adb', 'l-1', { env: s.env, log: () => {}, now: () => svc.clock.t });
  });
});

test('service: no frame before 250 ms of a burst, one re-read at 250 ms for five notifications', async () => {
  await withService({}, async ({ s, svc, fake, since }) => {
    await acquireLease('adb', { holder: 'agent-a', why: 'burst', forMs: 3_600_000, id: 'l-b', env: s.env, log: () => {}, now: () => svc.clock.t, hostId: 'test-host' });
    for (let n = 0; n < 5; n += 1) { fake.fire(s.env.HUB_LOCK_DIR, 'rename', `n${n}`); mock.timers.tick(20); }
    mock.timers.tick(149);
    await flush();
    assert.deepEqual(since(), [], 'nothing at 249 ms');
    mock.timers.tick(1);
    await flush();
    assert.equal(since().filter(frame => frame.event === 'status').length, 1);
  });
});

test('service: a deploy job\'s withLock reaches a subscriber (its acquire event and a status frame), then its release does too', async () => {
  await withService({}, async ({ s, svc, notify, since }) => {
    const intervals = { setInterval: () => ({ unref() {} }), clearInterval: () => {} };
    await withLock('adb', async () => {
      await notify();
      const out = since();
      assert.ok(out.some(frame => frame.event === 'event' && frame.data.event.event === 'acquire'));
      assert.equal(out.filter(frame => frame.event === 'status').length, 1);
    }, { env: s.env, log: () => {}, now: () => svc.clock.t, hostId: 'test-host', timers: intervals, sleep: () => Promise.resolve() });
    await notify();
    assert.ok(since().some(frame => frame.event === 'event' && frame.data.event.event === 'release'));
    assert.equal(since().filter(frame => frame.event === 'status').length, 2, 'the Hold ending is a document change too');
  });
});

test('service: POST /leases reaches a subscriber (the service\'s own writes), and releasing it does too', async () => {
  await withService({}, async ({ svc, notify, since }) => {
    const answer = await call(svc.listener, '/leases', {}, 'POST', { resource: 's24', for_ms: 600_000, holder: 'agent-svc', why: 'proof', id: 'l-take-1' });
    assert.equal(answer.head.status, 200);
    await notify();
    const out = since();
    assert.ok(out.some(frame => frame.event === 'event' && frame.data.event.event === 'acquire'));
    const statuses = out.filter(frame => frame.event === 'status');
    assert.equal(statuses.length, 1);
    assert.ok(doc(statuses[0]).includes('agent-svc'));
  });
});

test('service: only time passing (a Lease expiring, a heartbeat touch, a duplicate notification) sends no frame and no event', async () => {
  await withService({}, async ({ s, svc, notify, since }) => {
    await acquireLease('adb', { holder: 'agent-a', why: 'short', forMs: 60_000, id: 'l-t', env: s.env, log: () => {}, now: () => svc.clock.t, hostId: 'test-host' });
    await notify();
    const settled = since().length;
    assert.ok(settled > 0);
    svc.clock.t += 3_600_000;
    await notify();
    const alive = join(s.env.HUB_LOCK_DIR, 'adb.lock', 'alive');
    // A heartbeat: the lock's alive file is rewritten and its mtime moves, with nothing else changing.
    writeFileSync(alive, '');
    const when = new Date(svc.clock.t);
    utimesSync(alive, when, when);
    await notify(join(s.env.HUB_LOCK_DIR, 'adb.lock'));
    await notify();
    assert.equal(since().length, settled);
  });
});

test('service: a heartbeat touch and a listing stamped by a live clock (the track socket\'s) are time only: no frame, while a real Hold change still is one', async () => {
  let ticks = 0;
  const live = () => ({ port: 5037, note: null, listed: [], serials: new Map(), checked_at: T0 + 10_000 * (ticks += 1) });
  await withService({ adbQuery: async () => live() }, async ({ s, svc, notify, since }) => {
    const intervals = { setInterval: () => ({ unref() {} }), clearInterval: () => {} };
    await withLock('adb', async () => {
      await notify();
      const settled = since().length;
      assert.equal(since().filter(frame => frame.event === 'status').length, 1);
      const alive = join(s.env.HUB_LOCK_DIR, 'adb.lock', 'alive');
      const when = new Date(Date.now() + 120_000);
      utimesSync(alive, when, when);
      await notify(join(s.env.HUB_LOCK_DIR, 'adb.lock'));
      await notify();
      assert.equal(since().length, settled, 'the touch and the moving listing stamp are not a change');
    }, { env: s.env, log: () => {}, now: () => svc.clock.t, hostId: 'test-host', timers: intervals, sleep: () => Promise.resolve() });
    await notify();
    assert.equal(since().filter(frame => frame.event === 'status').length, 2, 'releasing the Hold is');
  });
});

test('service: a render that fails (HUB_HOST_UNKNOWN) still sends the event frames, with one HUB_API_STREAM_FAILED line', async () => {
  const stream = createStream({ boot: BOOT });
  const s = scratchDir();
  mock.timers.enable({ apis: ['setTimeout'] });
  let svc;
  try {
    const fake = fakeWatch();
    svc = await boot(s, { stream, watch: fake.watch, hostKey: () => { throw Object.assign(new Error('no host key'), { code: 'HUB_HOST_UNKNOWN' }); } });
    await flush();
    const sink = await call(svc.listener, '/stream', { 'last-event-id': `${BOOT}-0` });
    assert.equal(sink.head.status, 200);
    const before = svc.logs.err.filter(line => line.startsWith('HUB_API_STREAM_FAILED'));
    assert.equal(before.length, 1, 'the baseline prime failed once');
    put(s.env, '2026-11-25T10:00:00Z', { run: 'x' });
    fake.fire(s.env.HUB_EVENT_DIR, 'rename', 'x');
    mock.timers.tick(250);
    await flush();
    assert.equal(live(sink).filter(frame => frame.event === 'event').length, 1);
    assert.equal(live(sink).filter(frame => frame.event === 'status').length, 0);
    assert.equal(svc.logs.err.filter(line => line.startsWith('HUB_API_STREAM_FAILED')).length, 1, 'the same message is not repeated');
    assert.match(before[0], /HUB_HOST_UNKNOWN/);
  } finally { await svc?.stop(); mock.timers.reset(); s.cleanup(); }
});

test('service: a stop closes the watchers and the debounce first, a later notification does nothing, and nothing is left armed', async () => {
  const s = scratchDir();
  mock.timers.enable({ apis: ['setTimeout'] });
  let svc;
  try {
    const fake = fakeWatch();
    svc = await boot(s, { watch: fake.watch });
    await flush();
    const sink = await call(svc.listener, '/stream');
    fake.fire(s.env.HUB_LOCK_DIR, 'rename', 'x');
    await svc.stop();
    assert.equal(sink.ended, true);
    assert.deepEqual(fake.live(), []);
    const count = frames(sink).length;
    fake.fire(s.env.HUB_LOCK_DIR);
    mock.timers.tick(10_000);
    await flush();
    assert.equal(frames(sink).length, count);
    assert.ok(svc.logs.out.includes('HUB_API_STOP'));
    svc = null;
  } finally { await svc?.stop(); mock.timers.reset(); s.cleanup(); }
});

test('service: the lock dir and the event dir are created at start, the event dir mode 0700', async () => {
  const s = scratchDir();
  let svc;
  try {
    svc = await boot(s);
    assert.deepEqual(readdirSync(s.root).sort().includes('events'), true);
    assert.deepEqual(readdirSync(s.root).sort().includes('locks'), true);
    assert.equal(statSync(s.env.HUB_EVENT_DIR).mode & 0o777, 0o700);
  } finally { await svc?.stop(); s.cleanup(); }
});

// ---- real fs.watch ----

test('real fs.watch (Linux): a directory replaced and a file written re-arm the watch, and a frame follows within 2 s of real time', { skip: process.platform !== 'linux' }, async () => {
  const s = scratchDir('hub-api-watch-');
  const locks = s.env.HUB_LOCK_DIR;
  mkdirSync(join(locks, 'adb.lock'), { recursive: true });
  mkdirSync(s.env.HUB_EVENT_DIR, { recursive: true });
  const stream = createStream({ boot: BOOT });
  const listing = () => JSON.stringify({ locks: readdirSync(locks).sort(), inner: readdirSync(join(locks, 'adb.lock')).sort() });
  const feed = createChangeFeed({
    stream, now: Date.now, render: async () => ({ listing: listing() }),
    paths: () => hubPaths(s.env), watch: fsWatch, follow: () => followEvents({ env: s.env, hostId: 'h1', log: () => {} }),
  });
  const sink = new FakeSink();
  try {
    await feed.start();
    stream.attach(sink, { kind: 'resume', after: 0 });
    const next = async predicate => {
      const until = Date.now() + 2000;
      while (Date.now() < until) { if (live(sink).some(predicate)) return Date.now(); await new Promise(done => setTimeout(done, 20)); }
      return null;
    };
    // A write inside the watched lock dir.
    const t1 = Date.now();
    writeFileSync(join(locks, 'adb.lock', 'owner.json'), '{}');
    assert.ok(await next(frame => frame.event === 'status' && frame.data.status.listing.includes('owner.json')), 'a frame within 2 s');
    // Replace the directory: the old inode's watcher is closed, the new one is re-armed.
    renameSync(join(locks, 'adb.lock'), join(locks, 'adb.lock.tomb-1-2'));
    mkdirSync(join(locks, 'adb.lock'));
    assert.ok(await next(frame => frame.event === 'status' && frame.data.status.listing.includes('tomb')), 'the replace is seen');
    const seen = live(sink).length;
    writeFileSync(join(locks, 'adb.lock', 'alive'), 'x');
    assert.ok(await next(frame => frame.event === 'status' && frame.data.status.listing.includes('alive')), 'a write in the replaced directory is seen: it was re-armed');
    assert.ok(live(sink).length > seen);
    // An Event Log line.
    put(s.env, new Date().toISOString(), { run: 'real' });
    assert.ok(await next(frame => frame.event === 'event'), 'an event frame within 2 s');
    assert.ok(Date.now() - t1 < 10_000);
  } finally {
    feed.close();
    s.cleanup();
  }
});
