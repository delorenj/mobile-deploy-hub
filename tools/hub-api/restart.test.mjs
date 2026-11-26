// Story 8.6 (FR-23; AD-23, AD-37, AD-45): a restart of the Hub API loses nothing. Every row of the story's matrix runs across two service
// instances that share the same temp lock dir, event dir and registry. The rows about the wire use real loopback sockets and child
// processes: "the caller gets 503", "a crash reads as requeue" and "the second bind is refused" are claims about what the kernel and undici
// do, which a fake cannot show. Those sockets are ephemeral ports of this test (127.0.0.1, port 0), and the one real `fetch` is captured
// before `hermetic()` and wrapped so it reaches nothing else. The live port (8794), the live build bucket, a real systemd scope, the real adb
// server and the real host-key file are never touched.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadDevices } from '../ci/lib/devices.mjs';
import { readEvents } from '../ci/lib/events.mjs';
import { acquireLease, readOwner, releaseLease, reserve, withLock } from '../ci/lib/lock.mjs';
import { loadPolicy } from '../ci/lib/policy.mjs';
import { hermetic } from '../ci/test-fixtures.mjs';
import { liveStart } from '../device/emulator.mjs';
import { fixture } from '../device/emulator-fixtures.mjs';
import { HUB_API_SERVICE, call, requeueable } from '../hub-client.mjs';
import { ID_PATTERN } from './stream.mjs';
import { main, startHubApi } from './server.mjs';

// The one real fetch, taken before hermetic() replaces it. `loopback(port)` is the only way a test here reaches it.
const realFetch = globalThis.fetch;
hermetic();

const policy = loadPolicy().policy;
const HOST = 'test-host';
const MIN = 60_000;
const HOUR = 60 * MIN;
const NODE = process.execPath;
const T0 = Date.parse('2026-11-25T10:00:00Z');
const settle = ms => new Promise(done => setTimeout(done, ms));
const waitFor = async (check, ms = 15_000) => { for (const end = Date.now() + ms; Date.now() < end && !check();) await settle(20); return check(); };
const gone = pid => liveStart(pid) === null;
const PIXEL = { kind: 'phone', name: 'pixel', host: 'linux', identity: { serial: 'PX9', model: 'Pixel 9' }, capabilities: { api_level: 35 }, holder: 'jarad' };
const WAIT = { resource: 's24', for_ms: 30 * MIN, holder: 'agent-a', why: 'proof', id: 'w-1', wait_ms: 30_000 };
const EMPTY_HOST = () => ({ inventory: { adb_servers: [], emulators: [], xvfb: [] }, adb: { port: 5037, note: null, listed: [], serials: new Map() }, starts: new Map(), live_starts: new Map() });

// A fetch that reaches `http://127.0.0.1:<port>/` and nothing else.
const loopback = port => (input, init) => {
  const url = new URL(typeof input === 'string' ? input : (input.url ?? String(input)));
  if (url.origin !== `http://127.0.0.1:${port}`) throw new Error(`a restart test reached ${url.origin}; only http://127.0.0.1:${port} is allowed`);
  return realFetch(input, init);
};
const clientOf = port => ({ policy: { api: { hub_api_port: port } }, fetchImpl: loopback(port) });

function scratch() {
  const root = mkdtempSync(join(tmpdir(), 'hub-api-restart-'));
  const env = { PATH: process.env.PATH, HOME: root, HUB_LOCK_DIR: join(root, 'locks'), HUB_EVENT_DIR: join(root, 'events'), HUB_QA_DEVICES: process.env.HUB_QA_DEVICES };
  const children = new Set();
  const s = {
    root, env, children,
    events: () => [...readEvents({ env })],
    owner: lock => readOwner(join(env.HUB_LOCK_DIR, `${lock}.lock`)),
    tickets: lock => { try { return readdirSync(join(env.HUB_LOCK_DIR, `${lock}.queue`)).filter(file => file.endsWith('.json')); } catch { return []; } },
    ticket: lock => JSON.parse(readFileSync(join(env.HUB_LOCK_DIR, `${lock}.queue`, s.tickets(lock)[0]), 'utf8')),
    // Somebody else's Hold on a lock, the thing a wait waits for.
    hold: (lock, id = `holder-${lock}`) => acquireLease(lock, { holder: `holder-${lock}`, why: 'blocking', forMs: 50 * MIN, id, env, log: () => {} }),
    free: (lock, id = `holder-${lock}`) => releaseLease(lock, id, { env }),
    cleanup: () => {
      for (const child of children) { try { child.proc.kill('SIGKILL'); } catch { /* gone */ } }
      rmSync(root, { recursive: true, force: true });
    },
  };
  return s;
}

// Every file and directory under `dir` and its bytes, so two takes compare byte for byte.
function bytesOf(dir) {
  const out = {};
  const walk = path => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const full = join(path, entry.name);
      if (entry.isDirectory()) { out[`${relative(dir, full)}/`] = ''; walk(full); } else out[relative(dir, full)] = readFileSync(full).toString('base64');
    }
  };
  walk(dir);
  return out;
}

// ---- a service in this process, over a fake server (no port) ----

class FakeRes extends EventEmitter {
  chunks = [];
  head = null;
  ended = false;
  destroyed = false;
  writableFinished = false;
  writableLength = 0;
  writeHead(status, headers) { this.head = { status, headers }; }
  write(text) { if (this.destroyed) throw new Error('write after destroy'); this.chunks.push(text); return true; }
  end(text) { if (text !== undefined) this.chunks.push(text); this.ended = true; this.writableFinished = true; this.emit('close'); }
  destroy() { this.destroyed = true; this.emit('close'); }
  get text() { return this.chunks.join(''); }
}

async function boot(env, { now, stream, devices = structuredClone(loadDevices({})), faked = true, port, hostKey = () => 'linux' } = {}) {
  const signals = new EventEmitter();
  const logs = { out: [], err: [] };
  const servers = [];
  class FakeServer extends EventEmitter {
    constructor(listener) { super(); this.listener = listener; servers.push(this); }
    listen(_port, _host, callback) { process.nextTick(callback); return this; }
    address() { return { port: 1 }; }
    close(callback) { process.nextTick(callback); return this; }
  }
  const running = await startHubApi({
    env, policy: port === undefined ? policy : { ...policy, api: { ...policy.api, hub_api_port: port } }, hostId: HOST, devices, qaDevices: () => [], versions: { node: '24.15.0' }, onPath: () => true, signals, hostKey,
    log: { out: line => logs.out.push(line), err: line => logs.err.push(line) }, observe: async () => EMPTY_HOST(), ...(now ? { now } : {}), ...(stream ? { stream } : {}),
    ...(faked ? { createServer: listener => new FakeServer(listener) } : {}),
  });
  const listener = servers[0]?.listener;
  const request = async (method, url, body, headers = {}) => {
    const req = { method, url, headers, async *[Symbol.asyncIterator]() { if (body !== undefined) yield Buffer.from(JSON.stringify(body)); } };
    const res = new FakeRes();
    await listener(req, res);
    return { res, status: res.head.status, body: res.ended && res.text !== '' && !res.head.headers['Content-Type']?.startsWith('text/event-stream') ? JSON.parse(res.text) : undefined };
  };
  const stop = async () => { signals.emit('SIGTERM'); await running.stopped; };
  return { running, logs, listener, request, get: url => request('GET', url), post: (url, body) => request('POST', url, body), stop };
}

// ---- a service in a child process, over a real socket ----

const SERVER = pathToFileURL(join(import.meta.dirname, 'server.mjs')).href;
const POLICY = pathToFileURL(join(import.meta.dirname, '../ci/lib/policy.mjs')).href;
const DEVICES = pathToFileURL(join(import.meta.dirname, '../ci/lib/devices.mjs')).href;
const CHILD = `
  import { loadPolicy } from ${JSON.stringify(POLICY)};
  import { loadDevices } from ${JSON.stringify(DEVICES)};
  import { startHubApi } from ${JSON.stringify(SERVER)};
  const base = loadPolicy().policy;
  const running = await startHubApi({
    policy: { ...base, api: { ...base.api, hub_api_port: 0 } }, env: process.env, hostId: 'child-host', devices: structuredClone(loadDevices({})), qaDevices: () => [],
    hostKey: () => 'linux', onPath: () => true, versions: { node: '24.15.0' },
    observe: async () => ({ inventory: { adb_servers: [], emulators: [], xvfb: [] }, adb: { port: 5037, note: null, listed: [], serials: new Map() }, starts: new Map(), live_starts: new Map() }),
  });
  await running.stopped;
`;

// Starts a child API on `s.env`; resolves when it printed its LISTEN line. `exited` settles with `{code, signal}`.
async function child(s) {
  const proc = spawn(NODE, ['--input-type=module', '-e', CHILD], { env: s.env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  const exited = new Promise(done => proc.on('close', (code, signal) => done({ code, signal })));
  const listening = new Promise((resolve, reject) => {
    proc.stdout.on('data', chunk => { out += chunk; const found = /HUB_API_LISTEN port=(\d+)/.exec(out); if (found) resolve(Number(found[1])); });
    proc.stderr.on('data', chunk => { err += chunk; });
    exited.then(({ code, signal }) => reject(new Error(`the child API ended (${code ?? signal}) before it listened: ${err}`)));
  });
  const entry = { proc, exited, out: () => out, err: () => err };
  s.children.add(entry);
  entry.port = await listening;
  return entry;
}

const wait = (port, body = WAIT, waitMs = 30_000) => call({ method: 'POST', path: '/leases', body, waitMs }, clientOf(port)).catch(error => error);

// ---- the disk survives ----

test('the disk survives: a Lease, a Job Hold, a Reservation and a registered phone are byte-identical after A stops and after B starts, and B serves them', async () => {
  const s = scratch();
  let a;
  let b;
  let job;
  try {
    let at = T0;
    const now = () => at;
    const fakeTimers = { setInterval: () => ({ unref() {} }), clearInterval() {} };
    const jobEnv = { ...s.env, GITHUB_REPOSITORY: 'acme/app', GITHUB_RUN_ID: '41', GITHUB_RUN_ATTEMPT: '1', GITHUB_JOB: 'android' };
    const runY = { ...s.env, GITHUB_REPOSITORY: 'acme/app', GITHUB_RUN_ID: '42', GITHUB_RUN_ATTEMPT: '1', GITHUB_JOB: 'plan' };
    a = await boot(s.env, { now });
    const registered = await a.post('/registry/resources', PIXEL);
    assert.equal(registered.status, 201, JSON.stringify(registered.body));
    const leased = await a.post('/leases', { resource: 's24', for_ms: 47 * HOUR, holder: 'agent-a', why: 'proof', id: 'l-1' });
    assert.equal(leased.status, 200, JSON.stringify(leased.body));
    // Run X holds adb as a Job Hold across the restart (fake heartbeat timers, the test's clock); run Y holds a place in line.
    let release;
    job = withLock('adb', () => new Promise(done => { release = done; }), { env: jobEnv, log: () => {}, now, hostId: HOST, timers: fakeTimers, pollMs: 5 });
    assert.ok(await waitFor(() => s.owner('adb')?.run === '41'), 'run X holds adb');
    // The ceiling is raised past the 3 h the clock moves, so the Reservation is still live at B's start: only the restart is under test.
    const reserved = reserve('adb', { env: runY, now, policy: { ...policy, queue: { ...policy.queue, reservation_ceiling_min: 600 } }, hostId: HOST, log: () => {} });
    assert.equal(reserved.status, 'claimed');

    await a.stop();
    at += 3 * HOUR;
    const afterStop = bytesOf(s.env.HUB_LOCK_DIR);
    assert.ok(Object.keys(afterStop).some(file => file.endsWith('registry.json')), 'the registry is in the lock dir');
    assert.ok(Object.keys(afterStop).some(file => file.startsWith('s24.lock')) && Object.keys(afterStop).some(file => file.startsWith('adb.lock')) && Object.keys(afterStop).some(file => file.startsWith('adb.reservations')));

    b = await boot(s.env, { now });
    assert.deepEqual(bytesOf(s.env.HUB_LOCK_DIR), afterStop, 'recovery and the seed of the new instance wrote nothing');

    const status = await b.get('/status');
    assert.equal(status.status, 200);
    const view = status.body.hosts.linux;
    const lock = name => view.locks.find(entry => entry.lock === name);
    assert.equal(lock('s24').lease_id, 'l-1');
    assert.equal(lock('s24').holder, 'agent-a');
    assert.deepEqual([lock('adb').run, lock('adb').lease_id, lock('adb').stale], ['41', null, false], 'the Job Hold of run X');
    assert.deepEqual(view.reservations.map(entry => entry.run_key), ['acme--app--42']);
    const phone = await b.get(`/resources/${registered.body.resource.id}`);
    assert.equal(phone.status, 200);
    assert.equal(phone.body.resource.name, 'pixel');
    assert.equal(phone.body.resource.identity.serial, 'PX9');
    assert.deepEqual(bytesOf(s.env.HUB_LOCK_DIR), afterStop, 'serving them wrote nothing either');
    release();
    await job;
  } finally { await a?.stop().catch(() => {}); await b?.stop().catch(() => {}); s.cleanup(); }
});

// ---- the wire: a SIGTERM, a crash and a requeue ----

test('SIGTERM mid-wait: the caller gets 503 HUB_API_RESTARTING (requeue, api true), the child exits 0 and the ticket is withdrawn', async () => {
  const s = scratch();
  try {
    await s.hold('s24');
    const svc = await child(s);
    const pending = wait(svc.port);
    assert.ok(await waitFor(() => s.tickets('s24').length === 1), 'the wait is placed');
    svc.proc.kill('SIGTERM');
    const error = await pending;
    assert.deepEqual([error.code, error.status, error.exit, error.reason, error.retry, error.api], ['HUB_API_RESTARTING', 503, 1, 'restarting', 'requeue', true]);
    assert.equal(requeueable(error), true);
    assert.deepEqual(await svc.exited, { code: 0, signal: null });
    assert.match(svc.out(), /HUB_API_STOP/);
    assert.deepEqual(s.tickets('s24'), []);
    assert.deepEqual(s.events().filter(event => event.event === 'cancel').map(event => [event.lease_id, event.reason]), [['w-1', 'aborted']]);
    assert.equal(s.owner('s24').lease_id, 'holder-s24', 'nothing was granted');
  } finally { s.cleanup(); }
});

test('a crash mid-wait reads as requeue (api false), the dead ticket stays, and placing the same id again after the restart is granted exactly one Lease', async () => {
  const s = scratch();
  try {
    await s.hold('s24');
    const first = await child(s);
    const pending = wait(first.port);
    assert.ok(await waitFor(() => s.tickets('s24').length === 1), 'the wait is placed');
    const dead = s.ticket('s24');
    first.proc.kill('SIGKILL');
    const error = await pending;
    assert.deepEqual([error.code, error.exit, error.reason, error.retry, error.api], ['HUB_API_RESTARTING', 1, 'restarting', 'requeue', false]);
    assert.equal(requeueable(error), true);
    assert.equal((await first.exited).signal, 'SIGKILL');
    assert.equal(s.tickets('s24').length, 1, 'the dead pid\'s ticket is still on disk');
    assert.equal(dead.pid, first.proc.pid);

    // The restart: the same id again from the same holder, then the lock is freed.
    const second = await child(s);
    const again = wait(second.port);
    assert.ok(await waitFor(() => s.tickets('s24').length === 1 && s.ticket('s24').pid === second.proc.pid), 'the wait is placed again');
    s.free('s24');
    const granted = await again;
    assert.equal(granted.status, 200, JSON.stringify(granted));
    assert.equal(granted.body.lease_id, 'w-1');
    assert.equal(s.owner('s24').lease_id, 'w-1');
    assert.deepEqual(s.tickets('s24'), [], 'the dead ticket was pruned by the take');
    assert.ok(s.events().some(event => event.event === 'prune'), 'a prune event names it');
    assert.equal(s.events().filter(event => event.event === 'acquire' && event.lease_id === 'w-1').length, 1, 'one Lease');
    second.proc.kill('SIGTERM');
    assert.equal((await second.exited).code, 0);
  } finally { s.cleanup(); }
});

// ---- emulators survive ----

test('emulators survive a stop: the launch went through heavy, the fake processes stay alive, the record and slot owner are unchanged, B serves the Lease, a release tears them down', async () => {
  const f = fixture();
  // Its own port ranges: the other emulator suites use 25000-25199 and 5600-5798, and 25200-25299 / 5800-5898 belong to emulator-force-release.
  Object.assign(f.env, { HUB_EMULATOR_ADB_PORTS: '25300-25399', HUB_EMULATOR_CONSOLE_PORTS: '5900-5998', HUB_QA_DEVICES: process.env.HUB_QA_DEVICES });
  let a;
  let b;
  try {
    a = await boot(f.env);
    const leased = await a.post('/leases', { resource: 'emulator', for_ms: 30 * MIN, holder: 'agent-a', why: 'proof', id: 'emu-1' });
    assert.equal(leased.status, 200, JSON.stringify(leased.body));
    const record = f.record('emu-1');
    const owner = f.owner(record.slot);
    assert.match(f.heavyLog(), new RegExp(`${f.env.HUB_EMULATOR.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} `), 'heavy.log names the emulator launch');
    const pids = record.pids.map(entry => entry.pid);
    assert.ok(record.pids.some(entry => entry.role === 'emulator') && record.pids.some(entry => entry.role.startsWith('adb')), `the record names an emulator and an adb server: ${JSON.stringify(record.pids)}`);
    for (const pid of pids) assert.ok(!gone(pid), `${pid} runs`);
    const recordText = JSON.stringify(record);
    const ownerText = JSON.stringify(owner);

    await a.stop();
    for (const pid of pids) assert.ok(!gone(pid), `${pid} outlived the stop`);
    assert.equal(JSON.stringify(f.record('emu-1')), recordText);
    assert.equal(JSON.stringify(f.owner(record.slot)), ownerText);

    b = await boot(f.env);
    const served = await b.get('/leases/emu-1');
    assert.equal(served.status, 200, JSON.stringify(served.body));
    assert.equal(served.body.lease_id, 'emu-1');
    assert.equal(JSON.stringify(f.record('emu-1')), recordText, 'B\'s start changed nothing');
    for (const pid of pids) assert.ok(!gone(pid), `${pid} still runs under B`);

    const released = await b.post('/leases/emu-1/release', { holder: 'agent-a' });
    assert.equal(released.status, 200, JSON.stringify(released.body));
    assert.ok(await waitFor(() => pids.every(gone)), 'every pid is gone after the release');
    f.clean();
  } finally { await a?.stop().catch(() => {}); await b?.stop().catch(() => {}); f.cleanup(); }
});

// ---- the unit and the spawn seam ----

test('the unit says KillMode=mixed and Restart=on-failure with no ExecStop and no control-group kill; the one detached spawn of the emulator pool is `launch`, which spawns bootCommand\'s result', () => {
  const unit = readFileSync(join(import.meta.dirname, '../hosts/units/mobile-deploy-hub-api.service'), 'utf8');
  const directives = unit.split('\n').filter(line => /^[A-Za-z]+=/.test(line));
  assert.ok(directives.includes('KillMode=mixed'));
  assert.ok(directives.includes('Restart=on-failure'));
  assert.deepEqual(directives.filter(line => /^(ExecStop|ExecStopPost)=/.test(line)), []);
  assert.ok(!directives.includes('KillMode=control-group'));

  const source = readFileSync(join(import.meta.dirname, '../device/emulator.mjs'), 'utf8');
  assert.equal(source.match(/detached:\s*true/g)?.length, 1, 'one detached spawn in the pool');
  const start = source.indexOf('async function launch(');
  assert.ok(start > 0);
  const body = source.slice(start, source.indexOf('\n}\n', start));
  assert.match(body, /detached:\s*true/, 'it is in launch');
  assert.match(body, /const boot = bootCommand\(command, args/);
  assert.match(body, /spawn\(boot\.command, boot\.args,/, 'it spawns what bootCommand returned');
});

// ---- a second API ----

test('a second API on the same port exits HUB_API_ALREADY_RUNNING (exit 1), prints no LISTEN line, writes nothing, and the first still answers', async () => {
  const s = scratch();
  let a;
  try {
    // A is the real server on an ephemeral loopback port; a faked host, so nothing reads /proc or adb.
    a = await boot(s.env, { faked: false, port: 0 });
    const port = a.running.port;
    assert.ok(port > 0 && port !== policy.api.hub_api_port);
    const footprint = () => JSON.stringify([bytesOf(s.env.HUB_LOCK_DIR), readdirSync(s.env.HUB_EVENT_DIR)]);
    await settle(100);
    const before = footprint();
    const logs = { out: [], err: [] };
    const code = await main({
      log: { out: line => logs.out.push(line), err: line => logs.err.push(line) }, env: s.env, policy: { ...policy, api: { ...policy.api, hub_api_port: port } }, hostId: HOST,
      devices: structuredClone(loadDevices({})), qaDevices: () => [], versions: { node: '24.15.0' }, onPath: () => true, signals: new EventEmitter(), hostKey: () => 'linux', observe: async () => EMPTY_HOST(),
    });
    assert.equal(code, 1);
    assert.match(logs.err.join('\n'), /^HUB_API_ALREADY_RUNNING .*is already running/m);
    assert.deepEqual(logs.out, [], 'no LISTEN line');
    assert.equal(footprint(), before, 'the second wrote nothing');
    const health = await call({ path: '/health' }, clientOf(port)).catch(error => error);
    assert.equal(health.status, 200, health.message);
    assert.equal(health.body.service, HUB_API_SERVICE);
    assert.equal(health.body.ok, true);
  } finally { await a?.stop().catch(() => {}); s.cleanup(); }
});

// ---- the stream ----

function parse(text) {
  return text.split('\n\n').filter(block => block !== '').map(block => {
    const lines = block.split('\n');
    if (lines.length === 1 && lines[0].startsWith('retry: ')) return { retry: Number(lines[0].slice(7)) };
    if (lines.length === 1 && lines[0].startsWith(': ')) return { comment: lines[0].slice(2) };
    const field = name => lines.find(line => line.startsWith(`${name}: `))?.slice(name.length + 2);
    return { id: field('id'), event: field('event'), data: JSON.parse(field('data')) };
  });
}

test('a stream after a restart: the old Last-Event-ID gets reset (unresumable) with the new boot\'s id and the whole /status', async () => {
  const s = scratch();
  let a;
  let b;
  try {
    mkdirSync(s.env.HUB_LOCK_DIR, { recursive: true });
    a = await boot(s.env);
    const subscribed = await a.get('/stream');
    const [, readyA] = parse(subscribed.res.text);
    assert.equal(readyA.event, 'ready');
    assert.match(readyA.id, ID_PATTERN);
    const bootA = readyA.id.split('-')[0];
    assert.equal(readyA.id, `${bootA}-0`);
    await a.stop();
    assert.ok(subscribed.res.ended, 'the stop ended the subscriber\'s stream');

    b = await boot(s.env);
    const reconnected = await b.request('GET', '/stream', undefined, { 'last-event-id': readyA.id });
    assert.equal(reconnected.res.head.status, 200);
    const [retry, reset, ...rest] = parse(reconnected.res.text);
    assert.deepEqual(retry, { retry: 3000 });
    assert.deepEqual(rest, []);
    assert.equal(reset.event, 'reset');
    assert.equal(reset.data.reason, 'unresumable');
    assert.match(reset.id, ID_PATTERN);
    const bootB = reset.id.split('-')[0];
    assert.notEqual(bootB, bootA);
    assert.equal(reset.id, `${bootB}-0`);
    const status = (await b.get('/status')).body;
    assert.deepEqual(Object.keys(reset.data.status), Object.keys(status));
    assert.deepEqual(Object.keys(reset.data.status.hosts), Object.keys(status.hosts));
    assert.deepEqual(Object.keys(reset.data.status.hosts.linux), Object.keys(status.hosts.linux));
  } finally { await a?.stop().catch(() => {}); await b?.stop().catch(() => {}); s.cleanup(); }
});
