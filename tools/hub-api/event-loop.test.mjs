// Story 8.2 (NFR-7, AD-44): a read or a wait never blocks the event loop. Through `startHubApi`'s own request listener with a fake server,
// a fake `observe` that warms the host snapshot and an injected `processStart` that busy-waits 200 ms and counts its calls. No port, no real
// /proc scan and no adb server is reached; the clock is the real one because the point is real elapsed time on the one event loop.
import test from 'node:test';
import assert from 'node:assert/strict';
import diagnostics from 'node:diagnostics_channel';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDevices } from '../ci/lib/devices.mjs';
import { acquireLease, processStart, releaseLease, withLock } from '../ci/lib/lock.mjs';
import { loadPolicy } from '../ci/lib/policy.mjs';
import { hermetic, writeMonthOfEvents } from '../ci/test-fixtures.mjs';
import { strip } from '../ci/lib/source-scan.mjs';
import { startHubApi } from './server.mjs';

hermetic();

const policy = loadPolicy().policy;
const settle = (ms = 0) => new Promise(done => setTimeout(done, ms));

function scratch() {
  const root = mkdtempSync(join(tmpdir(), 'hub-api-loop-'));
  const env = { PATH: process.env.PATH, HOME: root, HUB_LOCK_DIR: join(root, 'locks'), HUB_EVENT_DIR: join(root, 'events'), HUB_DEVICE_POLL_MS: '50', HUB_ADB_SERVER_PORT: '5037' };
  return { root, env, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

// A fake node request and response, as waits.test.mjs drives the listener.
function exchange(listener, method, url, body) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
  const req = { method, url, async *[Symbol.asyncIterator]() { for (const chunk of chunks) yield chunk; } };
  const res = Object.assign(new EventEmitter(), {
    writableFinished: false, head: null, text: null,
    writeHead(status, headers) { this.head = { status, headers }; },
    end(text) { this.text = text; this.writableFinished = true; this.emit('close'); },
  });
  const done = listener(req, res);
  return { res, done, status: () => res.head?.status, json: () => JSON.parse(res.text) };
}
const call = async (listener, method, url, body) => { const e = exchange(listener, method, url, body); await e.done; return e; };

// The service under test: its listener, the count of `observe` calls and of the injected (blocking) `processStart`.
async function boot(s, { block = 200, hostKey = () => 'linux', listed = [] } = {}) {
  const state = { observed: 0, started: 0, blocked: [] };
  const signals = new EventEmitter();
  let listener;
  class FakeServer extends EventEmitter {
    constructor(handler) { super(); listener = handler; }
    listen(port, host, callback) { process.nextTick(callback); return this; }
    address() { return { port: 1 }; }
    close(callback) { process.nextTick(callback); return this; }
  }
  const real = processStart(process.pid);
  const running = await startHubApi({
    env: s.env, policy, hostId: 'test-host', devices: structuredClone(loadDevices({})), qaDevices: () => [], versions: { node: '24.15.0' }, onPath: () => true, signals, hostKey,
    log: { out: () => {}, err: line => state.blocked.push(line) },
    createServer: handler => new FakeServer(handler),
    observe: async () => {
      state.observed += 1;
      return { inventory: { adb_servers: [{ port: 5037, pid: 4242, managed: true, cwd: null }], emulators: [], xvfb: [] }, adb: { port: 5037, note: null, listed, serials: new Map() }, starts: new Map([[process.pid, real]]), live_starts: new Map() };
    },
    // The blocking reader: only the snapshot's fallback may ever call it, and a warm snapshot never does.
    processStart: pid => { state.started += 1; const until = performance.now() + block; while (performance.now() < until) { /* busy */ } return processStart(pid); },
  });
  return { state, listener, stop: async () => { signals.emit('SIGTERM'); await running.stopped; } };
}

test('with a 200 ms blocking processStart and a lease wait spinning, /status answers in under 200 ms and never calls the reader', async () => {
  const s = scratch();
  let svc;
  try {
    svc = await boot(s);
    const warm = await call(svc.listener, 'GET', '/status');
    assert.equal(warm.status(), 200, 'the first read waits for the first gather, once');
    await acquireLease('adb', { holder: 'agent-a', why: 'device proof', forMs: 3_600_000, id: 'held', env: s.env, log: () => {}, holderPid: process.pid });
    const waiter = exchange(svc.listener, 'POST', '/leases', { resource: 's26', for_ms: 600_000, holder: 'agent-w', why: 'next in line', id: 'w-1', wait_ms: 30_000 });
    await settle(300);   // the wait has joined the line and polled several times
    assert.equal(waiter.res.head, null, `the waiter is still waiting: ${waiter.res.text}`);
    const times = [];
    for (let i = 0; i < 5; i += 1) {
      const started = performance.now();
      const answer = await call(svc.listener, 'GET', '/status');
      times.push(performance.now() - started);
      assert.equal(answer.status(), 200);
      const view = answer.json().hosts.linux;
      assert.deepEqual(view.locks.map(lock => [lock.lock, lock.lease_id, lock.stale]), [['adb', 'held', false]]);
      assert.deepEqual(view.waiters.map(waiter => [waiter.lock, waiter.lease_id, waiter.stale]), [['adb', 'w-1', false]]);
      await settle(20);
    }
    assert.ok(times.every(ms => ms < 200), `every read under 200 ms: ${times.map(ms => ms.toFixed(0)).join(', ')}`);
    assert.equal(svc.state.started, 0, 'the blocking processStart was never called: not by the warm-up, the waiter joining the line, its polls or a read');
    assert.equal(waiter.res.head, null, 'the waiter is still waiting');
    const discovery = await call(svc.listener, 'GET', '/discovery');
    assert.equal(discovery.status(), 200);
    assert.equal(svc.state.started, 0);
    await svc.stop();
    svc = null;
    await waiter.done;
    assert.equal(waiter.status(), 503, 'the stop ended the wait');
    releaseLease('adb', 'held', { env: s.env });
  } finally { await svc?.stop(); s.cleanup(); }
});

test('a month of events (~15k lines), a Lease and two waiters: best of 3 /status under 200 ms, Event Log bytes unchanged', async () => {
  const s = scratch();
  let svc;
  try {
    const events = s.env.HUB_EVENT_DIR;
    writeMonthOfEvents(events);
    const bytes = () => readdirSync(events).sort().map(name => `${name}:${statSync(join(events, name)).size}`).join();
    svc = await boot(s, { block: 0 });
    await call(svc.listener, 'GET', '/status');
    await acquireLease('adb', { holder: 'agent-a', why: 'hold', forMs: 3_600_000, id: 'held', env: s.env, log: () => {} });
    const jobEnv = { ...s.env, GITHUB_REPOSITORY: 'o/a', GITHUB_RUN_ID: '9', GITHUB_RUN_ATTEMPT: '1', GITHUB_JOB: 'android' };
    const job = withLock('adb', async () => {}, { env: jobEnv, log: () => {}, pollMs: 5 });
    const second = acquireLease('adb', { holder: 'agent-b', why: 'next', forMs: 600_000, id: 'next', waitMs: 20_000, env: s.env, log: () => {}, pollMs: 5 });
    await settle(100);
    const sizes = bytes();
    const times = [];
    let doc;
    for (let i = 0; i < 3; i += 1) {
      const started = performance.now();
      const answer = await call(svc.listener, 'GET', '/status');
      times.push(performance.now() - started);
      doc = answer.json();
    }
    assert.equal(doc.hosts.linux.waiters.length, 2);
    assert.ok(doc.hosts.linux.waiters.every(waiter => waiter.eta !== null), 'both waiters got an ETA from the month of history');
    assert.ok(Math.min(...times) < 200, `best of 3 was ${Math.min(...times).toFixed(0)} ms (${times.map(ms => ms.toFixed(0)).join(', ')})`);
    assert.equal(bytes(), sizes, 'a read writes nothing to the Event Log');
    releaseLease('adb', 'next', { env: s.env });
    await assert.rejects(second, error => error.code === 'HUB_LEASE_CANCELLED');
    releaseLease('adb', 'held', { env: s.env });
    await job;
  } finally { await svc?.stop(); s.cleanup(); }
});

test('an uncontended POST /leases answers 200 in under 1 s and starts no gather on the request path', async () => {
  const s = scratch();
  let svc;
  try {
    svc = await boot(s);
    await call(svc.listener, 'GET', '/status');   // the first gather, once
    const before = svc.state.observed;
    const started = performance.now();
    const answer = await call(svc.listener, 'POST', '/leases', { resource: 's24', for_ms: 600_000, holder: 'agent-a', why: 'proof', id: 'l-take-1' });
    const elapsed = performance.now() - started;
    assert.equal(answer.status(), 200);
    assert.equal(answer.json().lease_id, 'l-take-1');
    assert.ok(elapsed < 1000, `took ${elapsed.toFixed(0)} ms`);
    assert.equal(svc.state.observed, before, 'observe was not called on the request path');
    assert.equal(svc.state.started, 0);
    releaseLease('s24', 'l-take-1', { env: s.env });
  } finally { await svc?.stop(); s.cleanup(); }
});

test('/discovery lists what the snapshot\'s adb listing shows that no Resource names, with no adbWire injected', async () => {
  const s = scratch();
  let svc;
  try {
    svc = await boot(s, { block: 0, listed: [{ id: 'ZZ9999NEWPHONE', state: 'device', model: 'Pixel_9' }] });
    const answer = await call(svc.listener, 'GET', '/discovery');
    assert.equal(answer.status(), 200);
    assert.deepEqual(answer.json().devices, [{ serial: 'ZZ9999NEWPHONE', model: 'Pixel_9', id: 'ZZ9999NEWPHONE', state: 'device' }]);
    assert.equal(answer.json().note, null);
  } finally { await svc?.stop(); s.cleanup(); }
});

test('an observe that fails never makes /status a 500: one HUB_API_OBSERVE_FAILED line and reachability unknown and stale', async () => {
  const s = scratch();
  const signals = new EventEmitter();
  const lines = [];
  let listener;
  class FakeServer extends EventEmitter {
    constructor(handler) { super(); listener = handler; }
    listen(port, host, callback) { process.nextTick(callback); return this; }
    address() { return { port: 1 }; }
    close(callback) { process.nextTick(callback); return this; }
  }
  try {
    const running = await startHubApi({
      env: s.env, policy, hostId: 'test-host', devices: structuredClone(loadDevices({})), qaDevices: () => [], versions: { node: '24.15.0' }, onPath: () => true, signals, hostKey: () => 'linux',
      log: { out: () => {}, err: line => lines.push(line) }, createServer: handler => new FakeServer(handler), observe: async () => { throw new Error('the worker fell over'); },
    });
    const answer = await call(listener, 'GET', '/status');
    assert.equal(answer.status(), 200);
    const phones = answer.json().hosts.linux.phones;
    assert.ok(phones.length > 0);
    for (const phone of phones) assert.deepEqual([phone.reachability.state, phone.reachability.stale], ['unknown', true]);
    assert.ok(lines.includes('HUB_API_OBSERVE_FAILED the worker fell over'), lines.join('\n'));
    assert.equal((await call(listener, 'GET', '/discovery')).status(), 200);
    signals.emit('SIGTERM');
    await running.stopped;
  } finally { s.cleanup(); }
});

test('with no observe, inventory or adbWire injected, the service gathers the host in a worker thread, not on the event loop', async () => {
  const s = scratch();
  // An adb port no server listens on: the worker's /proc scan finds no hub adb server there, so it never asks one.
  s.env.HUB_ADB_SERVER_PORT = '1';
  const signals = new EventEmitter();
  const workers = [];
  const onWorker = ({ worker }) => workers.push(worker.threadId);
  let listener;
  class FakeServer extends EventEmitter {
    constructor(handler) { super(); listener = handler; }
    listen(port, host, callback) { process.nextTick(callback); return this; }
    address() { return { port: 1 }; }
    close(callback) { process.nextTick(callback); return this; }
  }
  diagnostics.subscribe('worker_threads', onWorker);
  try {
    const running = await startHubApi({
      env: s.env, policy, hostId: 'test-host', devices: structuredClone(loadDevices({})), qaDevices: () => [], versions: { node: '24.15.0' }, onPath: () => true, signals, hostKey: () => 'linux',
      log: { out: () => {}, err: () => {} }, createServer: handler => new FakeServer(handler),
    });
    const answer = await call(listener, 'GET', '/status');
    assert.equal(answer.status(), 200);
    assert.ok(workers.length >= 1 && workers.every(id => id >= 1), `the first gather ran in a worker (threads: ${workers.join(',') || 'none'})`);
    assert.ok(Array.isArray(answer.json().hosts.linux.inventory?.adb_servers), 'the status inventory came from that gather');
    signals.emit('SIGTERM');
    await running.stopped;
  } finally { diagnostics.unsubscribe('worker_threads', onWorker); s.cleanup(); }
});

// ---- the conformance scan ----

const BLOCKING = /\b(spawnSync|execSync|execFileSync)\b/;
const INVENTORY_IMPORT = /\b(?:from|import)\s*\(?\s*['"][^'"]*inventory\.mjs['"]/;
// What a service file may not do: call a blocking child-process function, or import the /proc scan (a service reaches it only through the snapshot).
export const blockingUses = source => (BLOCKING.test(strip(source)) ? ['blocking child process'] : []).concat(INVENTORY_IMPORT.test(source.replace(/\/\/.*$/gm, '')) ? ['inventory import'] : []);

const root = fileURLToPath(new URL('../', import.meta.url));
function serviceFiles() {
  const files = [];
  for (const dir of ['hub-api', 'host-agent']) {
    const path = join(root, dir);
    if (!existsSync(path)) continue;
    for (const name of readdirSync(path)) if (name.endsWith('.mjs') && !name.endsWith('.test.mjs')) files.push(join(path, name));
  }
  return files;
}

test('no service file calls spawnSync, execSync or execFileSync, or imports the /proc inventory', () => {
  const files = serviceFiles();
  assert.ok(files.length >= 4, `found ${files.length} service files`);
  assert.ok(files.some(file => file.endsWith('snapshot.mjs')));
  for (const file of files) assert.deepEqual(blockingUses(readFileSync(file, 'utf8')), [], file);
});

test('the detector fails on a sample that blocks and passes on comments and strings', () => {
  assert.deepEqual(blockingUses("import { spawnSync } from 'node:child_process';\nconst out = spawnSync('ps', []);"), ['blocking child process']);
  assert.deepEqual(blockingUses("const { execSync } = require('x'); execSync('ls');"), ['blocking child process']);
  assert.deepEqual(blockingUses('execFileSync(file, args);'), ['blocking child process']);
  assert.deepEqual(blockingUses("import { inventory } from '../device/inventory.mjs';"), ['inventory import']);
  assert.deepEqual(blockingUses("const found = await import('../device/inventory.mjs');"), ['inventory import']);
  assert.deepEqual(blockingUses("// spawnSync and inventory.mjs are named here\nconst text = 'execSync';\n"), []);
  assert.deepEqual(blockingUses("import { spawn } from 'node:child_process';"), []);
});
