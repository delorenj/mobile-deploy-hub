// Story 9.2: the Host Agent, hermetic: a fake server (no port is bound), injected Node version, PATH check, host key, devicectl, inventory,
// clock and Hub API request, a temp lock and event dir per test. No live adb, devicectl, bucket or host key is reached.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
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
import { ROUTES, handle } from '../hub-api/routes.mjs';
import { createReadings } from '../hub-api/readings.mjs';
import { createRemotes } from '../hub-api/remotes.mjs';
import { CHANGE_DEBOUNCE_MS } from '../hub-api/stream.mjs';
import { fakeWire } from '../device/wire-fixtures.mjs';
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
  const forwards = [];
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
  // The agent's one transport (`ctx.request`): the Hub API's `GET /resources` answers the seed; any other call is a forward, recorded and answered 200.
  const send = async args => {
    if (args.path === '/resources') return requests.push(args) && new Response(JSON.stringify({ rev: 0, source: 'seed', resources: seed(devices, { qaDevices: () => qaList }).resources }), { status: 200, headers: { 'content-type': 'application/json' } });
    forwards.push(args);
    return new Response(JSON.stringify({ forwarded_to: args.host }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const ctx = (more = {}) => ({ env, policy, routes: AGENT_ROUTES, now: () => clock.t, devices, qaDevices: () => qaList, hostKey: () => key, devicectl: fakeDevicectl, inventory: noServer, log, known, request: send, sync: async replica => ({ pushed: true, synced: true, replica }), ...more });
  const s = {
    root, env, out, err, servers, requests, forwards, calls, clock, signals, known, devices, ctx, seams, log,
    start: (more = {}) => startHostAgent({ ...seams, log, ...more }),
    get: (url, more) => handle({ method: 'GET', url }, ctx(more)),
    post: (url, body, more, extra = {}) => handle({ method: 'POST', url, body, ...extra }, ctx(more)),
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

test('a public request naming a Resource on another host is forwarded there (door host-agent), and nothing is written here', async () => {
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
      ['/requests/r-1/cancel', { resource: 'phone', pool: 'phone', holder: 'ops' }],
    ];
    for (const [url, body] of cases) {
      const answer = await s.post(url, body);
      assert.equal(answer.status, 200, `${url} ${JSON.stringify(body)}: ${JSON.stringify(answer.body)}`);
      assert.deepEqual(answer.body, { forwarded_to: 'linux' }, `${url} ${JSON.stringify(body)}`);
      const sent = s.forwards.at(-1);
      assert.equal(sent.forwarded, 'host-agent');
      assert.equal(sent.host, 'linux');
      assert.equal(sent.path, url);
      assert.equal(sent.body.actor.via, 'host-agent');
      assert.equal(sent.body.actor.holder, body.holder);
    }
    assert.equal(s.forwards.length, cases.length);
    assert.equal(s.lockDirExists(), false, 'nothing was written to the lock dir');
  } finally { s.cleanup(); }
});

test('a lone word forwards with the carried record at the rev the agent knows; a cancel carries host and pool', async () => {
  const s = scratch();
  try {
    await s.post('/leases', { for_ms: 60_000, holder: 'agent', why: 'x', resource: 's24' });
    const sent = s.forwards.at(-1);
    assert.deepEqual(sent.body.resource, { id: 's24', lock: 's24', host: 'linux', rev: 0, retired_at: null });
    assert.match(sent.body.id, /^l-/);
    await s.post('/requests/r-1/cancel', { resource: 's24', pool: 'phone', holder: 'ops' });
    const cancel = s.forwards.at(-1);
    assert.equal(cancel.body.host, 'linux');
    assert.equal(cancel.body.pool, 'phone');
    assert.equal(cancel.body.resource, 's24', 'a cancel that names a Pool carries no record: the words go as they are');
    await s.post('/requests/r-2/cancel', { resource: 's24', holder: 'ops' });
    assert.deepEqual(s.forwards.at(-1).body.resource, { id: 's24', lock: 's24', host: 'linux', rev: 0, retired_at: null });
    assert.ok(s.requests.length >= 2, 'each public Hold call refreshed the Hub API view first');
  } finally { s.cleanup(); }
});

test('a forward naming a Resource on another host is HUB_WRONG_HOST 409 (exit 2), never forwarded again, and nothing is written', async () => {
  const s = scratch();
  const forwarded = { headers: { 'x-hub-forwarded': 'api' } };
  try {
    const lease = { for_ms: 60_000, holder: 'agent', why: 'x' };
    const record = { id: 's24', lock: 's24', host: 'linux', rev: 3, retired_at: null };
    const cases = [
      ['/leases', { ...lease, resource: record }],
      ['/leases', { ...lease, resource: 's26' }],
      ['/leases', { ...lease, resource: 'phone' }],
      ['/leases', { ...lease, match: 'kind=phone' }],
      ['/leases/emulator-1/force-release', { why: 'x', holder: 'ops' }],
      ['/requests/r-1/cancel', { resource: record, holder: 'ops' }],
      ['/leases/l-1/release', { holder: 'ops', resource: record }],
      ['/leases/l-1/extend', { holder: 'ops', for_ms: 1000, resource: record }],
    ];
    for (const [url, body] of cases) {
      const answer = await s.post(url, body, {}, forwarded);
      assert.deepEqual(problemOf(answer), [409, 'HUB_WRONG_HOST', 2, 'wrong-host'], `${url} ${JSON.stringify(body)}`);
      assert.match(answer.body.detail, /is on host linux; this is host mac/);
    }
    assert.equal(s.forwards.length, 0, 'a forward is never forwarded again');
    assert.equal(s.lockDirExists(), false, 'nothing was written to the lock dir');
  } finally { s.cleanup(); }
});

test('a Reservation on another host is HUB_WRONG_HOST: its force-release is gated by name and never forwarded', async () => {
  const s = scratch();
  try {
    const answer = await s.post('/reservations/acme--app--1/force-release', { why: 'x', holder: 'ops', name: 'adb' });
    assert.deepEqual(problemOf(answer), [409, 'HUB_WRONG_HOST', 2, 'wrong-host']);
    assert.match(answer.body.detail, /is on host linux; this is host mac/);
    assert.equal(s.forwards.length, 0);
    assert.equal(s.lockDirExists(), false);
  } finally { s.cleanup(); }
});

test('the agent acts on a carried record: the carried lock is taken, extended and released; rev 0 only for a seeded Resource; a retired take is refused', async () => {
  const s = scratch();
  const forwarded = { headers: { 'x-hub-forwarded': 'api' } };
  try {
    const ios = { id: 'ios-lane', lock: 'mac-ios', host: 'mac', rev: 7, retired_at: null };
    const taken = await s.post('/leases', { for_ms: 60_000, holder: 'jarad', why: 'ipad proof', resource: ios, id: 'f-1', actor: { holder: 'jarad', via: 'api' } }, {}, forwarded);
    assert.equal(taken.status, 200, JSON.stringify(taken.body));
    assert.equal(existsSync(join(s.env.HUB_LOCK_DIR, 'mac-ios.lock')), true);
    const again = await s.post('/leases', { for_ms: 60_000, holder: 'jarad', why: 'ipad proof', resource: ios, id: 'f-1', actor: { holder: 'jarad', via: 'api' } }, {}, forwarded);
    assert.equal(again.body.lease_id, taken.body.lease_id);
    assert.equal(s.forwards.length, 0);
    const released = await s.post(`/leases/${taken.body.lease_id}/release`, { holder: 'jarad', resource: ios }, {}, forwarded);
    assert.equal(released.status, 200, JSON.stringify(released.body));
    assert.deepEqual(problemOf(await s.post('/leases', { for_ms: 60_000, holder: 'a', why: 'x', resource: { ...ios, retired_at: '2031-01-01T00:00:00Z' }, id: 'f-2' }, {}, forwarded)).slice(0, 2), [409, 'HUB_RESOURCE_RETIRED']);
    const unseeded = { id: 'qa-phone', lock: 'qa-phone', host: 'mac', rev: 0, retired_at: null };
    assert.deepEqual(problemOf(await s.post('/leases', { for_ms: 60_000, holder: 'a', why: 'x', resource: unseeded }, {}, forwarded)).slice(0, 2), [400, 'HUB_USAGE']);
    assert.equal(problemOf(await s.post('/leases', { for_ms: 60_000, holder: 'a', why: 'x', resource: unseeded }, {}, forwarded))[3], 'unseeded');
    const seededZero = await s.post('/leases', { for_ms: 60_000, holder: 'jarad', why: 'x', resource: { ...ios, rev: 0 }, id: 'f-3' }, {}, forwarded);
    assert.equal(seededZero.status, 200, JSON.stringify(seededZero.body));
  } finally { s.cleanup(); }
});

test('a bad forward is 400 HUB_USAGE: a header that is not a door, a malformed record, an object resource without the header', async () => {
  const s = scratch();
  try {
    const lease = { for_ms: 60_000, holder: 'a', why: 'x' };
    const reasonOf = answer => [answer.status, answer.body.code, answer.body.reason];
    assert.deepEqual(reasonOf(await s.post('/leases', { ...lease, resource: 's26' }, {}, { headers: { 'x-hub-forwarded': 'nope' } })), [400, 'HUB_USAGE', 'bad-forward']);
    assert.deepEqual(reasonOf(await s.post('/leases', { ...lease, resource: { id: 's26' } }, {}, { headers: { 'x-hub-forwarded': 'api' } })), [400, 'HUB_USAGE', 'bad-resource']);
    assert.deepEqual(reasonOf(await s.post('/leases', { ...lease, resource: { id: 's26', lock: 's26', host: 'linux', rev: 1, retired_at: null } })), [400, 'HUB_USAGE', 'bad-resource']);
  } finally { s.cleanup(); }
});

test('the gate is the agent\'s key, not a literal mac: a linux-keyed agent forwards the iPad to the Mac and serves its phones', async () => {
  const s = scratch({ key: 'linux' });
  try {
    await s.post('/leases', { for_ms: 60_000, holder: 'a', why: 'x', resource: 'ipad' });
    assert.equal(s.forwards.at(-1).host, 'mac');
    await s.post('/leases', { for_ms: 60_000, holder: 'a', why: 'x', resource: 'mac' });
    assert.equal(s.forwards.at(-1).host, 'mac');
    const before = s.forwards.length;
    const taken = await s.post('/leases', { for_ms: 60_000, holder: 'a', why: 'x', resource: 's24', id: 'own-1' });
    assert.equal(taken.status, 200, JSON.stringify(taken.body));
    assert.equal(taken.body.device, 's24');
    assert.equal(s.forwards.length, before);
  } finally { s.cleanup(); }
});

test('a Hold handler\'s fleet is what the agent knows, never the lock dir\'s Registry: a phone the Hub API no longer serves cannot be taken', async () => {
  const s = scratch({ key: 'linux' });
  try {
    // The Hub API's last answer lacks s24; the lock dir has no registry.json, so a handler reading it would fall back to the seed (s24 included).
    s.known.note({ rev: 9, source: 'file', resources: seed(s.devices, { qaDevices: () => [] }).resources.filter(record => record.id !== 's24') });
    // The refresh the agent makes before it acts answers the same list.
    const gone = seed(s.devices, { qaDevices: () => [] }).resources.filter(record => record.id !== 's24');
    const request = async () => new Response(JSON.stringify({ rev: 9, source: 'file', resources: gone }), { status: 200 });
    const refused = await s.post('/leases', { for_ms: 60_000, holder: 'a', why: 'x', resource: 's24', id: 'gone-1' }, { request });
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
    'GET /health AgentHealth', 'GET /status HostView', 'POST /agent/sync AgentSync', 'POST /leases Lease', 'GET /leases/{id} Lease', 'POST /leases/{id}/extend Lease', 'POST /leases/{id}/release Release',
    'POST /leases/{id}/force-release ForceRelease', 'POST /requests/{id}/cancel Cancel', 'POST /reservations/{run_key}/force-release ReservationForceRelease',
  ]);
  const bodies = {
    '/agent/sync': [{}, { replica: {} }, { replica: { '2026-11': 120 } }, { replica: { '2026-13': 1 } }],
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

test('a public take of a retired Resource of this host is 409 HUB_RESOURCE_RETIRED and writes no lock', async () => {
  const s = scratch();
  try {
    const resources = seed(s.devices, { qaDevices: () => [] }).resources.map(record => (record.id === 'ios-lane' ? { ...record, retired_at: '2026-11-01T00:00:00Z' } : record));
    const request = async () => new Response(JSON.stringify({ rev: 5, source: 'file', resources }), { status: 200 });
    const answer = await s.post('/leases', { for_ms: 60_000, holder: 'a', why: 'x', resource: 'ipad', id: 'ret-1' }, { request });
    assert.deepEqual([answer.status, answer.body.code, answer.body.reason], [409, 'HUB_RESOURCE_RETIRED', 'retired']);
    assert.equal(s.lockDirExists(), false);
    assert.equal(s.forwards.length, 0);
  } finally { s.cleanup(); }
});

test('the agent\'s forward carries the rev the Hub API answered, not 0', async () => {
  const s = scratch();
  try {
    const resources = seed(s.devices, { qaDevices: () => [] }).resources;
    const refresh = async args => (args.path === '/resources' ? new Response(JSON.stringify({ rev: 9, source: 'file', resources }), { status: 200 }) : s.ctx().request(args));
    await s.post('/leases', { for_ms: 60_000, holder: 'a', why: 'x', resource: 's24' }, { request: refresh });
    assert.equal(s.forwards.length, 1);
    assert.deepEqual(s.forwards[0].body.resource, { id: 's24', lock: 's24', host: 'linux', rev: 9, retired_at: null });
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

// A startHostAgent whose one transport is bridged into the Hub API's handle() on a separate temp event dir: the Mac's Event
// Log lands byte-for-byte in the Hub's replica, and POST /agent/sync through the started service's listener answers
// {pushed, synced, replica} (Story 10.1). The debounce's timers seam fires at once, so no real clock is waited on.
test('a start replicates the Mac\'s Event Log to the Hub API\'s replica, and /agent/sync answers with the sizes', async () => {
  const s = scratch();
  const hubRoot = mkdtempSync(join(tmpdir(), 'host-agent-hub-'));
  const hubEnv = { PATH: process.env.PATH, HOME: hubRoot, HUB_LOCK_DIR: join(hubRoot, 'locks'), HUB_EVENT_DIR: join(hubRoot, 'events'), HUB_ADB_SERVER_PORT: '5037' };
  mkdirSync(hubEnv.HUB_EVENT_DIR, { recursive: true });
  mkdirSync(s.env.HUB_EVENT_DIR, { recursive: true });
  const lines = [
    `${JSON.stringify({ format: 1, ts: iso(FAR), host: 'mommymac', host_id: 'MAC-UUID', event: 'lease', n: '1' })}\n`,
    `${JSON.stringify({ format: 1, ts: iso(FAR + 1000), host: 'mommymac', host_id: 'MAC-UUID', event: 'release', n: '2' })}\n`,
  ];
  writeFileSync(join(s.env.HUB_EVENT_DIR, '2031-06.jsonl'), lines.join(''));
  const sha256 = path => createHash('sha256').update(readFileSync(path)).digest('hex');
  const replica = join(hubEnv.HUB_EVENT_DIR, 'replicas', 'mac', '2031-06.jsonl');
  const source = join(s.env.HUB_EVENT_DIR, '2031-06.jsonl');
  // A wall-clock bound, not a count of event-loop turns: under a loaded full suite the push's file I/O (the libuv pool) can take longer than
  // any fixed number of turns, which made this test fail only in `mise run check`.
  const until = async (check, what) => {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      if (check()) return;
      await new Promise(done => setTimeout(done, 2));
    }
    throw new Error(`timed out waiting for ${what}`);
  };
  try {
    const serverUp = () => ({ adb_servers: [{ port: 5037, pid: 4242, cwd: null }], emulators: [], xvfb: [] });
    const hubCtx = {
      env: hubEnv, policy, routes: ROUTES, now: () => FAR, hostId: 'hub-host', devices: structuredClone(loadDevices({})),
      qaDevices: () => [], hostKey: () => 'linux', inventory: serverUp, adbWire: fakeWire({ listed: [] }),
      sleep: () => Promise.resolve(), log: { out: () => {}, err: () => {} },
      readings: createReadings({ env: hubEnv, policy, now: () => FAR, hostId: 'hub-host', hostKey: () => 'linux', probe: async () => new Map() }),
      remotes: createRemotes(),
    };
    // The agent's one transport (`request`): every call, the registry refresh included, is answered by the real Hub API routes.
    const request = async ({ method, path, body }) => {
      const answer = await handle({ method, url: path, body }, hubCtx);
      return new Response(JSON.stringify(answer.body), { status: answer.status, headers: { 'content-type': String(answer.headers['Content-Type']) } });
    };
    // The debounce's timers seam: the poke's one-shot timer fires on the next tick, so the start push runs without a real 250 ms wait.
    const timers = { setTimeout: fn => setImmediate(fn), clearTimeout: immediate => clearImmediate(immediate) };
    const running = await s.start({ request, timers });
    await until(() => existsSync(replica), 'the replica of 2031-06');
    await until(() => sha256(replica) === sha256(source), 'the replica to settle byte-for-byte');
    assert.deepEqual(s.err, [], JSON.stringify(s.err));
    // The Hub API hands the agent its replica sizes: the route answers the push result and the settled sizes.
    const e = exchange('POST', '/agent/sync', { replica: { '2031-06': Buffer.byteLength(lines.join('')) } });
    await s.servers[0].listener(e.req, e.res);
    assert.equal(e.res.head.status, 200, e.res.text);
    assert.deepEqual(e.json(), { pushed: true, synced: true, replica: { '2031-06': Buffer.byteLength(lines.join('')) } });
    await running.stop();
  } finally {
    rmSync(hubRoot, { recursive: true, force: true });
    s.cleanup();
  }
});

test('no interval or poll runs across a start, /health, /status, a forward to the other host and a stop; the only timer is the push debounce, one-shot, armed by the start', async () => {
  const s = scratch();
  const real = { timeout: globalThis.setTimeout, interval: globalThis.setInterval };
  const spied = [];
  globalThis.setTimeout = (fn, ms, ...rest) => { spied.push(`setTimeout ${ms}`); return real.timeout(fn, ms, ...rest); };
  globalThis.setInterval = (...args) => { spied.push('setInterval'); return real.interval(...args); };
  try {
    const running = await s.start();
    await new Promise(done => setImmediate(done));
    const listener = s.servers[0].listener;
    for (const [method, url, body] of [['GET', '/health'], ['GET', '/status'], ['POST', '/leases', { resource: 's26', for_ms: 60_000, holder: 'a', why: 'x' }]]) {
      const e = exchange(method, url, body);
      await listener(e.req, e.res);
      assert.equal(e.res.head.status, 200, `${method} ${url} ${e.res.text}`);
    }
    // The Mac's take of the S26 (a linux phone) is a forward: it reached the injected request seam as the door host-agent, and no lock was written here.
    assert.ok(s.requests.some(args => args.method === 'POST' && args.path === '/leases' && args.host === 'linux' && args.forwarded === 'host-agent'), 'the take was forwarded');
    assert.equal(s.lockDirExists(), false);
    await running.stop();
  } finally {
    globalThis.setTimeout = real.timeout;
    globalThis.setInterval = real.interval;
    s.cleanup();
  }
  // The start pokes once (the Hub API hears of this host), and the requests and the stop arm nothing: one `trailing` debounce, never repeated.
  assert.deepEqual(spied, [`setTimeout ${CHANGE_DEBOUNCE_MS}`]);
});

test('nothing under tools/host-agent/ reads registry.json', () => {
  for (const file of ['known.mjs', 'routes.mjs', 'server.mjs']) {
    const source = readFileSync(new URL(`./${file}`, import.meta.url), 'utf8').split('\n').filter(line => !/^\s*\/\//.test(line)).join('\n');
    assert.ok(!/readRegistry|registryPath|registry\.json/.test(source), file);
  }
});
