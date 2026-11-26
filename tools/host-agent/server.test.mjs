// Story 9.2: the Host Agent, hermetic: a fake server (no port is bound), injected Node version, PATH check, host key, devicectl, inventory,
// clock and Hub API request, a temp lock and event dir per test. No live adb, devicectl, bucket or host key is reached.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { loadDevices } from '../ci/lib/devices.mjs';
import { acquireLease, buildTicket, reserve, updateLease } from '../ci/lib/lock.mjs';
import { loadPolicy } from '../ci/lib/policy.mjs';
import { hermetic } from '../ci/test-fixtures.mjs';
import { statusView, createContext } from '../device/claims.mjs';
import { HOST_AGENT_SERVICE, HUB_API_CONTRACT } from '../hub-client.mjs';
import { requestListener } from '../hub-api/server.mjs';
import { handle } from '../hub-api/routes.mjs';
import { seed } from '../registry/seed.mjs';
import { AGENT_ROUTES } from './routes.mjs';
import { createKnown } from './known.mjs';
import { main, startHostAgent } from './server.mjs';

hermetic();

const policy = loadPolicy().policy;
const FAR = Date.parse('2031-06-01T00:00:00Z');
const iso = ms => new Date(ms).toISOString();
const noServer = () => ({ adb_servers: [], emulators: [], xvfb: [] });

class FakeServer extends EventEmitter {
  constructor(listener, { busy = false } = {}) {
    super();
    this.listener = listener;
    this.busy = busy;
    this.listened = [];
    this.closed = 0;
  }
  listen(port, host, callback) {
    this.listened.push([port, host]);
    if (this.busy) process.nextTick(() => this.emit('error', Object.assign(new Error('listen EADDRINUSE'), { code: 'EADDRINUSE' })));
    else process.nextTick(callback);
    return this;
  }
  address() { return { port: this.listened.at(-1)?.[0] }; }
  close(callback) { this.closed += 1; process.nextTick(callback); return this; }
}

const ipadDocument = (patch = {}) => {
  const { udid, model } = loadDevices({}).ios;
  return { result: { devices: [{ identifier: 'IPAD', hardwareProperties: { udid, reality: 'physical', productType: model }, connectionProperties: { pairingState: 'paired', tunnelState: 'connected', transportType: 'wired' }, deviceProperties: { name: 'iPad', developerModeStatus: 'enabled', bootState: 'booted', ...patch } }] } };
};

function scratch({ busy = false, qaList = [], key = 'mac', devicectl } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'host-agent-'));
  const env = { PATH: process.env.PATH, HOME: root, HUB_LOCK_DIR: join(root, 'locks'), HUB_EVENT_DIR: join(root, 'events') };
  const out = [];
  const err = [];
  const servers = [];
  const requests = [];
  const calls = [];
  const clock = { t: FAR };
  const signals = new EventEmitter();
  const devices = structuredClone(loadDevices({}));
  const log = { out: line => out.push(line), err: line => err.push(line) };
  const fakeDevicectl = devicectl ?? ((args, timeout) => { calls.push([args, timeout]); return ipadDocument(); });
  const known = createKnown({ env, devices, qaDevices: () => qaList, log });
  const seams = {
    env, policy, now: () => clock.t, devices, qaDevices: () => qaList, hostKey: () => key, devicectl: fakeDevicectl, inventory: noServer,
    versions: { node: '24.15.0' }, onPath: () => false, signals, known,
    request: async args => { requests.push(args); return new Response(JSON.stringify({ rev: 0, source: 'seed', resources: seed(devices, { qaDevices: () => qaList }).resources }), { status: 200 }); },
    createServer: listener => { const server = new FakeServer(listener, { busy }); servers.push(server); return server; },
  };
  const ctx = (more = {}) => ({ env, policy, routes: AGENT_ROUTES, now: () => clock.t, devices, qaDevices: () => qaList, hostKey: () => key, devicectl: fakeDevicectl, inventory: noServer, log, known, ...more });
  const s = {
    root, env, out, err, servers, requests, calls, clock, signals, known, devices, ctx, seams, log,
    start: (more = {}) => startHostAgent({ ...seams, log, ...more }),
    get: (url, more) => handle({ method: 'GET', url }, ctx(more)),
    post: (url, body, more) => handle({ method: 'POST', url, body }, ctx(more)),
    lockDirExists: () => existsSync(env.HUB_LOCK_DIR),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
  return s;
}

const problemOf = answer => [answer.status, answer.body.code, answer.body.exit, answer.body.reason];
const ticket = (s, lock, name, fields) => {
  mkdirSync(join(s.env.HUB_LOCK_DIR, `${lock}.queue`), { recursive: true });
  writeFileSync(join(s.env.HUB_LOCK_DIR, `${lock}.queue`, `${String(FAR).padStart(15, '0')}-${name}.json`), JSON.stringify(buildTicket('lease', { env: s.env, requested: FAR, holder: 'waiter', why: 'queued', expires_at: iso(FAR + 3_600_000), ...fields })));
};
const exchange = (method, url, body) => {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
  const req = { method, url, async *[Symbol.asyncIterator]() { for (const chunk of chunks) yield chunk; } };
  const res = { head: null, text: null, writeHead(status, headers) { this.head = { status, headers }; }, end(text) { this.text = text; } };
  return { req, res, json: () => JSON.parse(res.text) };
};

test('a start binds 127.0.0.1 on the policy port, needs no heavy, prints HUB_API_LISTEN and starts one registry request', async () => {
  const s = scratch();
  try {
    const running = await s.start();
    assert.deepEqual(s.servers[0].listened, [[8795, '127.0.0.1']]);
    assert.equal(s.servers.length, 1);
    assert.deepEqual(s.out, ['HUB_API_LISTEN port=8795']);
    assert.equal(running.port, 8795);
    await new Promise(done => setImmediate(done));
    assert.deepEqual(s.requests, [{ host: 'linux', method: 'GET', path: '/resources' }]);
    assert.deepEqual(s.err, []);
    assert.equal(s.lockDirExists(), false, 'a start writes nothing');
    assert.equal(s.calls.length, 0, 'no iPad read at start');
    await running.stop();
  } finally { s.cleanup(); }
});

test('an old Node is refused with nothing bound', async () => {
  const s = scratch();
  try {
    await assert.rejects(s.start({ versions: { node: '24.6.0' } }), error => error.code === 'HUB_API_NODE');
    assert.equal(s.servers.length, 0);
  } finally { s.cleanup(); }
});

test('a second instance: --launchd returns 0, without it 1, both log HUB_API_ALREADY_RUNNING and write nothing', async () => {
  const s = scratch({ busy: true });
  try {
    assert.equal(await main({ ...s.seams, argv: ['--launchd'], log: s.log }), 0);
    assert.match(s.err.at(-1), /^HUB_API_ALREADY_RUNNING /);
    assert.equal(await main({ ...s.seams, argv: [], log: s.log }), 1);
    assert.equal(s.err.filter(line => line.startsWith('HUB_API_ALREADY_RUNNING')).length, 2);
    assert.deepEqual(s.out, []);
    assert.equal(s.lockDirExists(), false);
    assert.deepEqual(s.requests, [], 'the registry request starts only after a won bind');
  } finally { s.cleanup(); }
});

test('main takes only --launchd: anything else is the usage on stderr and 2, with nothing started', async () => {
  const s = scratch();
  try {
    for (const argv of [['--bogus'], ['--launchd', 'x'], ['serve']]) {
      assert.equal(await main({ ...s.seams, argv, log: s.log }), 2, argv.join(' '));
    }
    assert.equal(s.servers.length, 0);
    assert.match(s.err[0], /^usage: /);
    const run = spawnSync(process.execPath, [fileURLToPath(new URL('./server.mjs', import.meta.url)), '--bogus'], { encoding: 'utf8', env: { PATH: process.env.PATH } });
    assert.equal(run.status, 2);
    assert.match(run.stderr, /usage: /);
    assert.equal(run.stdout, '');
  } finally { s.cleanup(); }
});

test('GET /health has exactly ok, service, contract, hub_version and ports, and no registry', async () => {
  const s = scratch();
  try {
    const answer = await s.get('/health', { env: { ...s.env, HUB_REF: 'v9.9.9' } });
    assert.equal(answer.status, 200);
    assert.deepEqual(Object.keys(answer.body), ['ok', 'service', 'contract', 'hub_version', 'ports']);
    assert.deepEqual(answer.body, { ok: true, service: HOST_AGENT_SERVICE, contract: HUB_API_CONTRACT, hub_version: 'v9.9.9', ports: { hub_api: 8794, host_agent: 8795 } });
    assert.equal((await s.get('/health')).body.hub_version, 'unknown');
    assert.equal(answer.headers['Cache-Control'], 'no-store');
  } finally { s.cleanup(); }
});

test('GET /status with the lane held: the lock, the waiters and the times are this agent\'s clock and lock dir, and the iPad is read once', async () => {
  const s = scratch();
  try {
    await acquireLease('mac-ios', { holder: 'agent-m', why: 'ipad proof', forMs: 3_600_000, id: 'held', env: s.env, log: () => {}, now: () => FAR });
    ticket(s, 'mac-ios', '000001-00000001', { lease_id: 'w-1' });
    ticket(s, 'mac-ios', '000002-00000002', { lease_id: 'w-2', holder: 'waiter-2' });
    const answer = await s.get('/status');
    assert.equal(answer.status, 200);
    const view = answer.body;
    assert.deepEqual(Object.keys(view), ['phones', 'locks', 'waiters', 'reservations', 'inventory', 'emulators']);
    const lock = view.locks.find(entry => entry.lock === 'mac-ios');
    assert.equal(lock.resource, 'ios-lane');
    assert.equal(lock.started_at, iso(FAR));
    assert.equal(lock.expires_at, iso(FAR + 3_600_000));
    assert.deepEqual(view.waiters.map(waiter => [waiter.lease_id, waiter.position, waiter.since]), [['w-1', 1, iso(FAR)], ['w-2', 2, iso(FAR)]]);
    assert.deepEqual(lock.reachability, { state: 'reachable', checked_at: iso(FAR), age_ms: 0, stale: false });
    assert.deepEqual(s.calls, [[['list', 'devices'], 10]]);
    assert.deepEqual(view.phones, [], 'the Mac owns no phone');
    // Embedded unchanged: the Claims library's own answer for the same seams.
    const ctx = createContext({ env: s.env, now: () => FAR, policy, devicectl: () => ipadDocument(), hostKey: () => 'mac', inventory: noServer, fleet: [] });
    assert.deepEqual(view, JSON.parse(JSON.stringify(await statusView('mac', { audience: 'service', qa_ids: [] }, ctx))));
  } finally { s.cleanup(); }
});

test('a devicectl that throws makes the iPad unknown, and a free lane never asks devicectl', async () => {
  const bad = scratch({ devicectl: () => { throw new Error('devicectl list devices did not succeed'); } });
  try {
    await acquireLease('mac-ios', { holder: 'agent-m', why: 'x', forMs: 60_000, id: 'held', env: bad.env, log: () => {}, now: () => FAR });
    const lock = (await bad.get('/status')).body.locks.find(entry => entry.lock === 'mac-ios');
    assert.equal(lock.reachability.state, 'unknown');
  } finally { bad.cleanup(); }
  const free = scratch({ devicectl: () => { throw new Error('devicectl must not be asked: no row names the iPad'); } });
  try {
    const answer = await free.get('/status');
    assert.equal(answer.status, 200);
    assert.deepEqual([answer.body.locks, answer.body.waiters, answer.body.reservations], [[], [], []]);
  } finally { free.cleanup(); }
});

test('QA redaction: a Resource the agent knows is dedicated_qa has its serial and adb id nulled, the keys stay', async () => {
  const s = scratch();
  try {
    const resources = seed(s.devices, { qaDevices: () => [] }).resources.map(record => (record.id === 'ios-lane' ? { ...record, capabilities: { dedicated_qa: true } } : record));
    s.known.note({ rev: 4, source: 'file', resources });
    assert.deepEqual(s.known.qaIds(), ['ios-lane']);
    await acquireLease('mac-ios', { holder: 'agent-m', why: 'x', forMs: 60_000, id: 'held', env: s.env, log: () => {}, now: () => FAR });
    updateLease('mac-ios', 'held', { device: { phone: 'ipad', serial: 'IPADSERIAL1', adb_id: 'adb-IPADSERIAL1' } }, { env: s.env });
    const { body } = await s.get('/status');
    const lock = body.locks.find(entry => entry.lock === 'mac-ios');
    assert.deepEqual(lock.phone, { phone: 'ipad', serial: null, adb_id: null });
    assert.ok(!JSON.stringify(body).includes('IPADSERIAL1'));
  } finally { s.cleanup(); }
});

test('an unknown host key is 503 HUB_HOST_UNKNOWN on /status and on a Hold route', async () => {
  const unknown = () => { throw Object.assign(new Error('this host does not know which host it is'), { code: 'HUB_HOST_UNKNOWN' }); };
  const s = scratch({ key: 'mac' });
  try {
    assert.deepEqual(problemOf(await s.get('/status', { hostKey: unknown })).slice(0, 2), [503, 'HUB_HOST_UNKNOWN']);
    assert.deepEqual(problemOf(await s.get('/leases/x', { hostKey: unknown })).slice(0, 2), [503, 'HUB_HOST_UNKNOWN']);
  } finally { s.cleanup(); }
});

test('a Resource on another host is HUB_WRONG_HOST 409 (exit 2) and nothing is written', async () => {
  const s = scratch();
  try {
    const lease = { for_ms: 60_000, holder: 'agent', why: 'x' };
    const cases = [
      ['/leases', { ...lease, resource: 's26' }],
      ['/leases', { ...lease, resource: 's24' }],
      ['/leases', { ...lease, resource: 'phone' }],
      ['/leases', { ...lease, resource: 'emulator' }],
      ['/leases', { ...lease, match: 'kind=phone' }],
      ['/leases', { ...lease, match: 'host=linux' }],
      ['/leases', { ...lease, match: 'profile=default' }],
      ['/leases/emulator-1/force-release', { why: 'x', holder: 'ops' }],
      ['/requests/r-1/cancel', { resource: 's24', holder: 'ops' }],
      ['/requests/r-1/cancel', { resource: 'mac-ios', pool: 'phone', holder: 'ops' }],
      ['/reservations/acme--app--1/force-release', { why: 'x', holder: 'ops', name: 'adb' }],
    ];
    for (const [url, body] of cases) {
      const answer = await s.post(url, body);
      assert.deepEqual(problemOf(answer), [409, 'HUB_WRONG_HOST', 2, 'wrong-host'], `${url} ${JSON.stringify(body)}`);
      assert.match(answer.body.detail, /is on host linux; this is host mac/);
    }
    assert.equal(s.lockDirExists(), false, 'nothing was written to the lock dir');
  } finally { s.cleanup(); }
});

test('the gate is the agent\'s key, not a literal mac: a linux-keyed agent refuses the iPad and serves its phones', async () => {
  const s = scratch({ key: 'linux' });
  try {
    assert.deepEqual(problemOf(await s.post('/leases', { for_ms: 60_000, holder: 'a', why: 'x', resource: 'ipad' })), [409, 'HUB_WRONG_HOST', 2, 'wrong-host']);
    assert.deepEqual(problemOf(await s.post('/leases', { for_ms: 60_000, holder: 'a', why: 'x', resource: 'mac' })), [409, 'HUB_WRONG_HOST', 2, 'wrong-host']);
    const taken = await s.post('/leases', { for_ms: 60_000, holder: 'a', why: 'x', resource: 's24', id: 'own-1' });
    assert.equal(taken.status, 200, JSON.stringify(taken.body));
    assert.equal(taken.body.device, 's24');
  } finally { s.cleanup(); }
});

test('a Hold handler\'s fleet is what the agent knows, never the lock dir\'s Registry: a phone the Hub API no longer serves cannot be taken', async () => {
  const s = scratch({ key: 'linux' });
  try {
    // The Hub API's last answer lacks s24; the lock dir has no registry.json, so a handler reading it would fall back to the seed (s24 included).
    s.known.note({ rev: 9, source: 'file', resources: seed(s.devices, { qaDevices: () => [] }).resources.filter(record => record.id !== 's24') });
    const refused = await s.post('/leases', { for_ms: 60_000, holder: 'a', why: 'x', resource: 's24', id: 'gone-1' });
    assert.ok(refused.status >= 400 && refused.status < 500, JSON.stringify(refused.body));
    assert.notEqual(refused.body.code, 'HUB_WRONG_HOST');
    const taken = await s.post('/leases', { for_ms: 60_000, holder: 'a', why: 'x', resource: 's26', id: 'own-2' });
    assert.equal(taken.status, 200, JSON.stringify(taken.body));
    assert.equal(taken.body.device, 's26');
  } finally { s.cleanup(); }
});

test('the route\'s own body check runs before the gate, and an unknown name passes to the handler', async () => {
  const s = scratch();
  try {
    assert.deepEqual(problemOf(await s.post('/leases', { resource: 's26', holder: 'a' })).slice(0, 2), [400, 'HUB_USAGE']);
    assert.deepEqual(problemOf(await s.post('/requests/r-1/cancel', { holder: 'ops' })).slice(0, 2), [400, 'HUB_USAGE']);
    const unknown = await s.post('/leases', { for_ms: 60_000, holder: 'a', why: 'x', resource: 'toaster' });
    assert.notEqual(unknown.body.code, 'HUB_WRONG_HOST');
    assert.ok(unknown.status >= 400 && unknown.status < 500, JSON.stringify(unknown.body));
  } finally { s.cleanup(); }
});

test('a Resource on this host passes the gate: a waiter is cancelled and a Reservation force-released, as the Hub API answers', async () => {
  const s = scratch();
  try {
    await acquireLease('mac-ios', { holder: 'agent-m', why: 'ipad proof', forMs: 3_600_000, id: 'held', env: s.env, log: () => {}, now: () => FAR });
    ticket(s, 'mac-ios', '000001-00000001', { lease_id: 'w-ios' });
    const cancelled = await s.post('/requests/w-ios/cancel', { resource: 'mac-ios', host: 'mac', holder: 'ops' });
    assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
    assert.equal(cancelled.body.request_id, 'w-ios');
    assert.equal(cancelled.body.resource, 'ios-lane');
    reserve('mac-ios', { env: { ...s.env, GITHUB_REPOSITORY: 'delorenj/gruvato', GITHUB_RUN_ID: '9' }, now: () => FAR, policy, log: () => {} });
    const released = await s.post('/reservations/delorenj--gruvato--9/force-release', { why: 'dead run', holder: 'ops', name: 'mac-ios' });
    assert.equal(released.status, 200, JSON.stringify(released.body));
    assert.equal(released.body.outcome, 'force-released');
    assert.deepEqual(released.body.released.map(entry => entry.resource), ['ios-lane']);
  } finally { s.cleanup(); }
});

test('the Registry and every other Hub API route are 404 HUB_NO_ROUTE', async () => {
  const s = scratch();
  try {
    for (const [method, url] of [['GET', '/registry/resources'], ['POST', '/registry/resources'], ['POST', '/registry/resources/s24'], ['GET', '/resources'], ['GET', '/pools'], ['GET', '/discovery'], ['GET', '/stream']]) {
      const answer = await handle({ method, url, body: method === 'POST' ? {} : undefined }, s.ctx());
      assert.deepEqual(problemOf(answer), [404, 'HUB_NO_ROUTE', 2, 'no-route'], `${method} ${url}`);
    }
  } finally { s.cleanup(); }
});

test('the route table is the Hub API\'s Hold routes plus Health and Status, and every route answers on a Mac with no 500', async () => {
  assert.deepEqual(AGENT_ROUTES.map(route => `${route.method} ${route.path} ${route.shape}`), [
    'GET /health AgentHealth', 'GET /status HostView', 'POST /leases Lease', 'GET /leases/{id} Lease', 'POST /leases/{id}/extend Lease', 'POST /leases/{id}/release Release',
    'POST /leases/{id}/force-release ForceRelease', 'POST /requests/{id}/cancel Cancel', 'POST /reservations/{run_key}/force-release ReservationForceRelease',
  ]);
  const bodies = {
    '/leases': [{}, { resource: 'mac-ios', for_ms: 60_000, holder: 'a', why: 'x' }, { resource: 's26', for_ms: 60_000, holder: 'a', why: 'x' }, { match: 'kind=ios-lane', for_ms: 60_000, holder: 'a', why: 'x' }],
    '/leases/{id}/extend': [{}, { for_ms: 60_000, holder: 'a' }],
    '/leases/{id}/release': [{}, { holder: 'a' }],
    '/leases/{id}/force-release': [{}, { why: 'x', holder: 'a' }],
    '/requests/{id}/cancel': [{}, { resource: 'mac-ios', holder: 'a' }, { resource: 's24', holder: 'a' }],
    '/reservations/{run_key}/force-release': [{}, { why: 'x', holder: 'a' }, { why: 'x', holder: 'a', name: 'mac-ios' }],
  };
  const s = scratch();
  try {
    for (const route of AGENT_ROUTES) {
      const url = route.path.replace('{id}', 'e-aaaaaaaaaaaa').replace('{run_key}', 'acme--app--1');
      for (const body of route.method === 'POST' ? bodies[route.path] : [undefined]) {
        const answer = await handle({ method: route.method, url, body }, s.ctx());
        assert.notEqual(answer.status, 500, `${route.method} ${route.path} ${JSON.stringify(body)}: ${JSON.stringify(answer.body)}`);
      }
    }
  } finally { s.cleanup(); }
});

test('known: the last Hub API answer wins for Resources, the seed keeps the Pools and words; a failed refresh is one line and the seed answers', async () => {
  const devices = structuredClone(loadDevices({}));
  const serial = devices.android_extra[0].serial;
  const err = [];
  const known = createKnown({ env: {}, devices, qaDevices: () => [{ name: 'S24', serial }], log: { err: line => err.push(line) } });
  assert.deepEqual(known.qaIds(), ['s24'], 'the seed marks the QA phone');
  assert.deepEqual(Object.keys(known.current().pools), ['phone', 'emulator']);
  assert.deepEqual(known.current().words, [{ id: 'ios-lane', words: ['ipad', 'mac'] }]);
  assert.equal(await known.refresh({ request: async () => { throw new TypeError('fetch failed'); } }), false);
  assert.deepEqual(err, ['HUB_AGENT_REGISTRY_FAILED fetch failed']);
  assert.deepEqual(known.qaIds(), ['s24'], 'the seed keeps answering');
  assert.equal(await known.refresh({ request: async () => new Response('{}', { status: 503 }) }), false);
  assert.equal(err.length, 2);
  const answered = seed(devices, { qaDevices: () => [] }).resources.map(record => (record.id === 's26' ? { ...record, capabilities: { dedicated_qa: true } } : record));
  assert.equal(await known.refresh({ request: async args => { assert.deepEqual(args, { host: 'linux', method: 'GET', path: '/resources' }); return new Response(JSON.stringify({ rev: 7, source: 'file', resources: answered }), { status: 200 }); } }), true);
  assert.deepEqual(known.qaIds(), ['s26']);
  assert.deepEqual(Object.keys(known.current().pools), ['phone', 'emulator']);
  known.note(null);
  known.note({ resources: 'nope' });
  assert.deepEqual(known.qaIds(), ['s26'], 'a malformed answer is ignored');
});

test('a Hub API that is unreachable at start is one HUB_AGENT_REGISTRY_FAILED line and the agent still serves', async () => {
  const s = scratch();
  try {
    const running = await s.start({ request: async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }); } });
    await new Promise(done => setImmediate(done));
    assert.deepEqual(s.err, ['HUB_AGENT_REGISTRY_FAILED fetch failed']);
    const e = exchange('GET', '/health');
    await requestListener(s.ctx())(e.req, e.res);
    assert.equal(e.res.head.status, 200);
    await running.stop();
  } finally { s.cleanup(); }
});

test('no timer, interval or poll runs across a start, /health, /status, a gate refusal and a stop', async () => {
  const s = scratch();
  const real = { timeout: globalThis.setTimeout, interval: globalThis.setInterval };
  const spied = [];
  globalThis.setTimeout = (...args) => { spied.push('setTimeout'); return real.timeout(...args); };
  globalThis.setInterval = (...args) => { spied.push('setInterval'); return real.interval(...args); };
  try {
    const running = await s.start();
    await new Promise(done => setImmediate(done));
    const listener = s.servers[0].listener;
    for (const [method, url, body] of [['GET', '/health'], ['GET', '/status'], ['POST', '/leases', { resource: 's26', for_ms: 60_000, holder: 'a', why: 'x' }]]) {
      const e = exchange(method, url, body);
      await listener(e.req, e.res);
      assert.ok(e.res.head.status === 200 || e.res.head.status === 409, `${method} ${url} ${e.res.text}`);
    }
    await running.stop();
  } finally {
    globalThis.setTimeout = real.timeout;
    globalThis.setInterval = real.interval;
    s.cleanup();
  }
  assert.deepEqual(spied, []);
});

test('nothing under tools/host-agent/ reads registry.json', () => {
  for (const file of ['known.mjs', 'routes.mjs', 'server.mjs']) {
    const source = readFileSync(new URL(`./${file}`, import.meta.url), 'utf8').split('\n').filter(line => !/^\s*\/\//.test(line)).join('\n');
    assert.ok(!/readRegistry|registryPath|registry\.json/.test(source), file);
  }
});
