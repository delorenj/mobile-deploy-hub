// Story 8.2: the host snapshot's unit rules (cold pid, old snapshot, single flight, failure) with an injected `observe`, `now` and start
// readers, and the real worker: `observeOffThread` against a scratch lock dir. No timer, port, adb server or real /proc read but the worker's.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireLease, buildTicket, processStart, releaseLease } from '../ci/lib/lock.mjs';
import { loadPolicy } from '../ci/lib/policy.mjs';
import { hermetic } from '../ci/test-fixtures.mjs';
import * as claims from '../device/claims.mjs';
import { observeHost, observeOffThread } from '../device/observe-thread.mjs';
import { NOT_OBSERVED, createSnapshot } from './snapshot.mjs';

hermetic();

const flush = async (rounds = 6) => { for (let round = 0; round < rounds; round += 1) await new Promise(done => setImmediate(done)); };
const T0 = Date.parse('2026-11-25T10:00:00Z');
const found = () => ({ adb_servers: [{ port: 5037, pid: 4242, managed: true, cwd: null }], emulators: [], xvfb: [] });
const adb = () => ({ port: 5037, note: null, listed: [{ id: 'R5', state: 'device' }], serials: new Map() });

// A fake `observe` the test answers: every call is recorded, and `answer` is what the next gather returns (or throws).
function rig({ starts = [[100, 'a']], live = [[100, 'a']], maxAgeMs } = {}) {
  const clock = { t: T0 };
  const lines = [];
  const calls = [];
  const state = { starts: new Map(starts), live: new Map(live), fail: null, hold: null };
  const reads = { start: [], live: [] };
  const snapshot = createSnapshot({
    env: {}, now: () => clock.t, log: line => lines.push(line), ...(maxAgeMs ? { maxAgeMs } : {}),
    startOf: pid => { reads.start.push(pid); return `read-${pid}`; },
    liveStartOf: pid => { reads.live.push(pid); return `live-${pid}`; },
    observe: async () => {
      calls.push(clock.t);
      if (state.hold) await state.hold;
      if (state.fail) throw state.fail;
      return { inventory: found(), adb: adb(), starts: new Map(state.starts), live_starts: new Map(state.live) };
    },
  });
  return { clock, lines, calls, state, reads, snapshot };
}

test('nothing is gathered until a read asks; ready() starts and waits for the first gather, and a settled one never waits again', async () => {
  const r = rig();
  assert.equal(r.snapshot.read(), null);
  assert.equal(r.calls.length, 0, 'no timer, no gather at construction');
  await r.snapshot.ready();
  assert.equal(r.calls.length, 1);
  assert.equal(r.snapshot.read().taken_at, T0);
  assert.deepEqual([...r.snapshot.read().starts], [[100, 'a']]);
  await r.snapshot.ready();
  await r.snapshot.ready();
  assert.equal(r.calls.length, 1, 'a young snapshot is not gathered again');
});

test('a warm snapshot answers the start of a known pid without calling the reader, from the snapshot', async () => {
  const r = rig();
  await r.snapshot.ready();
  for (let i = 0; i < 5; i += 1) assert.equal(r.snapshot.processStart(100), 'a');
  assert.equal(r.snapshot.liveStart(100), 'a');
  assert.deepEqual([r.reads.start, r.reads.live, r.calls.length], [[], [], 1]);
});

test('a cold pid reads once through the shared cache and starts one refresh; a second read in the pass reads 0', async () => {
  const r = rig();
  await r.snapshot.ready();
  r.clock.t += 500;
  assert.equal(r.snapshot.processStart(200), 'read-200');
  assert.equal(r.snapshot.processStart(200), 'read-200');
  assert.deepEqual(r.reads.start, [200], 'one fallback read for the pid, none for the second');
  assert.equal(r.calls.length, 2, 'one refresh was started');
  await flush();
  assert.equal(r.snapshot.processStart(200), 'read-200', 'the gather that never saw the pid is not asked again for it');
  r.state.starts.set(200, 'seen');
  r.clock.t += 100;
  await r.snapshot.refresh();
  assert.equal(r.snapshot.processStart(200), 'seen', 'a pid the next gather has is read from the snapshot');
  assert.deepEqual(r.reads.start, [200]);
});

test('a pid asked again while its gather is in flight is settled by that gather: no second refresh for it', async () => {
  const r = rig();
  await r.snapshot.ready();
  r.clock.t += 500;
  let release;
  r.state.hold = new Promise(done => { release = done; });
  r.snapshot.processStart(200);
  r.clock.t += 100;
  r.snapshot.processStart(200);
  assert.equal(r.calls.length, 2, 'the second ask joins the gather in flight');
  r.state.hold = null;
  release();
  await flush();
  r.clock.t += 100;
  assert.equal(r.snapshot.processStart(200), 'read-200');
  assert.equal(r.calls.length, 2, 'the gather the first ask started has shown the pid cannot be observed: it is not asked again');
});

test('an old snapshot answers at once from what it has (its adb keeps its age) and starts exactly one refresh, whoever asks', async () => {
  const r = rig();
  await r.snapshot.ready();
  r.clock.t += 5000;
  let release;
  r.state.hold = new Promise(done => { release = done; });
  const first = await r.snapshot.adbQuery();
  assert.equal(first.checked_at, T0, 'the answer is the old snapshot with its own age');
  assert.deepEqual(first.listed, [{ id: 'R5', state: 'device' }]);
  assert.equal(r.snapshot.processStart(100), 'read-100', 'an old snapshot is not trusted for a start: the shared reader answers');
  r.snapshot.liveStart(100);
  r.snapshot.inventory();
  await r.snapshot.ready();
  assert.equal(r.calls.length, 2, 'concurrent reads start no second gather');
  assert.equal(r.snapshot.read().taken_at, T0, 'the old snapshot is still the one served while the gather is in flight');
  release();
  await flush();
  assert.equal(r.snapshot.read().taken_at, T0 + 5000);
  assert.equal((await r.snapshot.adbQuery()).checked_at, T0 + 5000);
});

test('at most one gather is in flight: refresh() joins it', async () => {
  const r = rig();
  let release;
  r.state.hold = new Promise(done => { release = done; });
  const a = r.snapshot.refresh();
  const b = r.snapshot.refresh();
  const c = r.snapshot.ready();
  assert.equal(a, b);
  assert.equal(r.calls.length, 1);
  release();
  await Promise.all([a, b, c]);
  assert.equal(r.calls.length, 1);
  await r.snapshot.refresh();
  assert.equal(r.calls.length, 2, 'once settled, the next refresh is a new gather');
});

test('inventory() is sync, empty before the first gather, and a copy: a reader that marks it never changes the snapshot', async () => {
  const r = rig();
  assert.deepEqual(r.snapshot.inventory(), { adb_servers: [], emulators: [], xvfb: [] });
  await r.snapshot.ready();
  const one = r.snapshot.inventory();
  Object.assign(one.adb_servers[0], { managed: false, lease_id: 'x' });
  assert.deepEqual(r.snapshot.inventory().adb_servers[0], { port: 5037, pid: 4242, managed: true, cwd: null });
});

test('a failed gather is one HUB_API_OBSERVE_FAILED line, never throws, and before any success leaves an empty snapshot the next read retries', async () => {
  const r = rig();
  r.state.fail = new Error('the /proc scan\nfell over');
  await r.snapshot.ready();
  assert.deepEqual(r.lines, ['HUB_API_OBSERVE_FAILED the /proc scan fell over']);
  const empty = r.snapshot.read();
  assert.equal(empty.taken_at, null);
  assert.equal(empty.adb.note, NOT_OBSERVED);
  assert.deepEqual(await r.snapshot.adbQuery(), { ...empty.adb, checked_at: null });
  await flush();
  assert.equal(r.calls.length, 2, 'the read that found no good snapshot started the retry');
  r.state.fail = null;
  await r.snapshot.refresh();
  assert.equal(r.snapshot.read().taken_at, T0);
  assert.equal((await r.snapshot.adbQuery()).note, null);
});

test('a failed gather keeps the last good snapshot', async () => {
  const r = rig();
  await r.snapshot.ready();
  r.clock.t += 5000;
  r.state.fail = new Error('boom');
  await r.snapshot.refresh();
  assert.equal(r.snapshot.read().taken_at, T0);
  assert.deepEqual(r.lines, ['HUB_API_OBSERVE_FAILED boom']);
});

test('an observe that throws before its first await still settles (the in-flight slot is always released)', async () => {
  const lines = [];
  let calls = 0;
  const snapshot = createSnapshot({ env: {}, now: () => T0, log: line => lines.push(line), observe: () => { calls += 1; throw new Error('sync'); } });
  await snapshot.refresh();
  await snapshot.refresh();
  assert.equal(calls, 2);
  assert.equal(lines.length, 2);
});

test('observeHost gathers the inventory, asks adb only when the hub server is running, and records the pids the lock dir names', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hub-observe-'));
  const env = { PATH: process.env.PATH, HOME: root, HUB_LOCK_DIR: join(root, 'locks'), HUB_EVENT_DIR: join(root, 'events'), HUB_ADB_SERVER_PORT: '5037' };
  try {
    await acquireLease('s24', { holder: 'agent-a', why: 'proof', forMs: 60_000, id: 'held', env, log: () => {}, holderPid: process.pid });
    let asked = 0;
    const wire = () => { asked += 1; return { devicesLong: async () => [], close() {} }; };
    const none = await observeHost({ env, inventory: () => ({ adb_servers: [], emulators: [], xvfb: [] }), adbWire: wire, startOf: pid => `s${pid}`, liveStartOf: pid => `l${pid}` });
    assert.equal(asked, 0, 'no server in the inventory: adb is not asked');
    assert.equal(none.adb.note, 'no adb server');
    assert.equal(none.starts.get(process.pid), `s${process.pid}`);
    assert.deepEqual([...none.live_starts], []);
    const up = await observeHost({ env, inventory: found, adbWire: wire, startOf: pid => `s${pid}`, liveStartOf: pid => `l${pid}` });
    assert.equal(asked, 1, 'the hub server is in the inventory: adb is asked once');
    assert.equal(up.inventory.adb_servers[0].port, 5037);
    // A live waiter ticket (the parent process, start as recorded), a stale one (pid 1, whose recorded start is not the pid's now) on a
    // queue with no lock, and an emulator record: every pid they name is read through the recording readers.
    const ticket = (queue, name, pid, started) => {
      mkdirSync(join(env.HUB_LOCK_DIR, `${queue}.queue`), { recursive: true });
      const body = buildTicket('lease', { env, requested: T0, holder: 'waiter', why: 'queued', lease_id: `w-${pid}`, expires_at: new Date(T0 + 3_600_000).toISOString(), pid, processStart: () => started });
      writeFileSync(join(env.HUB_LOCK_DIR, `${queue}.queue`, `${String(T0).padStart(15, '0')}-${name}.json`), JSON.stringify(body));
    };
    ticket('adb', '000001-00000001', process.ppid, `s${process.ppid}`);
    ticket('res-extra', '000001-00000002', 1, 'an older process');
    mkdirSync(join(env.HUB_LOCK_DIR, 'emulators'), { recursive: true });
    writeFileSync(join(env.HUB_LOCK_DIR, 'emulators', 'e-aaaaaaaaaaaa.json'), JSON.stringify({
      lease_id: 'e-aaaaaaaaaaaa', slot: 'emulator-1', profile: 'default', serial: 'emulator-5554', console_port: 5554, adb_server_port: 15170, avd: { name: 'hub-a' }, created_at: '2026-11-25T10:00:00Z',
      pids: [{ pid: 424242, start: 'E1', role: 'emulator' }],
    }));
    const startCalls = [];
    const liveCalls = [];
    const full = await observeHost({
      env, inventory: found, adbWire: wire,
      startOf: pid => { startCalls.push(pid); return `s${pid}`; }, liveStartOf: pid => { liveCalls.push(pid); return 'E1'; },
    });
    assert.deepEqual([...full.starts.keys()].sort((a, b) => a - b), [...new Set([1, process.ppid, process.pid])].sort((a, b) => a - b), 'the Lease holder, the live ticket and the stale ticket');
    assert.equal(full.starts.get(process.ppid), `s${process.ppid}`);
    assert.equal(full.starts.get(1), 's1');
    assert.deepEqual([...full.live_starts], [[424242, 'E1']]);
    assert.deepEqual(liveCalls, [424242]);
    assert.ok(startCalls.includes(1) && startCalls.includes(process.ppid));
    releaseLease('s24', 'held', { env });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('real worker: observeOffThread reads the start of a lock owner and the inventory from a thread other than the main one', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hub-observe-'));
  // A port nothing listens on, so the worker never asks a real adb server.
  const env = { PATH: process.env.PATH, HOME: root, HUB_LOCK_DIR: join(root, 'locks'), HUB_EVENT_DIR: join(root, 'events'), HUB_ADB_SERVER_PORT: '59371' };
  try {
    await acquireLease('s24', { holder: 'agent-a', why: 'proof', forMs: 60_000, id: 'held', env, log: () => {}, holderPid: process.pid });
    const lines = [];
    const seen = await observeOffThread({ env, log: line => lines.push(line) });
    assert.equal(seen.starts.get(process.pid), processStart(process.pid));
    assert.ok(seen.starts.get(process.pid), 'a real start time');
    assert.deepEqual(Object.keys(seen.inventory).sort(), ['adb_servers', 'emulators', 'xvfb']);
    assert.ok(Array.isArray(seen.inventory.adb_servers) && Array.isArray(seen.inventory.emulators) && Array.isArray(seen.inventory.xvfb));
    assert.equal(seen.adb.port, 59371);
    const thread = /^HUB_API_OBSERVE_THREAD thread=(\d+)$/.exec(lines[0]);
    assert.ok(thread && Number(thread[1]) >= 1, `from worker thread ${thread?.[1]}, not the main thread (0)`);
    releaseLease('s24', 'held', { env });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('real worker: a signal that is aborted before or during the gather rejects with its reason', async () => {
  const controller = new AbortController();
  controller.abort(new Error('gone'));
  await assert.rejects(observeOffThread({ signal: controller.signal }), /gone/);
  const root = mkdtempSync(join(tmpdir(), 'hub-observe-'));
  try {
    const later = new AbortController();
    const pending = observeOffThread({ env: { HUB_LOCK_DIR: join(root, 'x'), HUB_ADB_SERVER_PORT: '59371' }, signal: later.signal });
    later.abort(new Error('stopped'));
    await assert.rejects(pending, /stopped/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('real worker: one that crashes or ends without an answer rejects with HUB_API_OBSERVE_FAILED', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hub-observe-script-'));
  try {
    const crash = join(dir, 'crash.mjs');
    const silent = join(dir, 'silent.mjs');
    writeFileSync(crash, "throw new Error('the worker fell over');\n");
    writeFileSync(silent, 'process.exit(3);\n');
    await assert.rejects(observeOffThread({ env: {}, script: crash }), error => error.code === 'HUB_API_OBSERVE_FAILED' && /crashed: the worker fell over/.test(error.message));
    await assert.rejects(observeOffThread({ env: {}, script: silent }), error => error.code === 'HUB_API_OBSERVE_FAILED' && /ended without an answer \(exit 3\)/.test(error.message));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a reading made from the snapshot is stamped with the adb answer\'s checked_at, never the request\'s time; no observation is no reading', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hub-observe-'));
  const env = { PATH: process.env.PATH, HOME: root, HUB_LOCK_DIR: join(root, 'locks'), HUB_EVENT_DIR: join(root, 'events'), HUB_ADB_SERVER_PORT: '5037' };
  const listed = [{ id: 'adb-R5GL43A7PCH-zz._adb-tls-connect._tcp', state: 'device', model: 'SM_S948U' }];
  const readingOf = async answer => {
    const ctx = claims.createContext({
      env, now: () => T0, sleep: () => Promise.resolve(), policy: loadPolicy().policy, fleet: claims.loadFleet(env, { warn: () => {} }), inventory: found,
      adbQuery: async () => ({ port: 5037, serials: new Map(), ...answer }),
    });
    return (await claims.statusView('linux', { audience: 'service', qa_ids: [] }, ctx)).phones.find(phone => phone.device === 's26').reachability;
  };
  try {
    const old = await readingOf({ note: null, listed, checked_at: T0 - 30_000 });
    assert.deepEqual([old.state, old.checked_at, old.age_ms, old.stale], ['reachable', new Date(T0 - 30_000).toISOString(), 30_000, false]);
    const none = await readingOf({ note: NOT_OBSERVED, listed: [], checked_at: null });
    assert.deepEqual([none.state, none.checked_at, none.stale], ['unknown', null, true]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
