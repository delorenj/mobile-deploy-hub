// Story 10.4: no answer of either service carries the serial of a dedicated QA phone. The sweep boots the real `startHubApi` and `startHostAgent` (a FakeServer
// listener each, no port bound) over a fixture QA list of two serials, one seeded phone (`s24`) and one runtime QA phone (Pixel-QA, `res-pixel-qa`), puts those
// phones through every state a serial could ride in (held by a CLI Lease that connected, queued on, listed on adb, tracked, in events), and searches the raw
// text and headers of every answer, case-insensitively, for each serial and for an adb id embedding it. It is driven by the route tables: a GET route with no
// sweep sample, or a POST route with none, fails, so a route added later is swept or the build is red. Hermetic: temp dirs, a fake adb wire and track socket,
// an ssh that always fails, no port, no real adb, QA file or host key.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadDevices } from '../ci/lib/devices.mjs';
import { acquireLease, buildTicket, lockDir, reserve, updateLease } from '../ci/lib/lock.mjs';
import { loadPolicy } from '../ci/lib/policy.mjs';
import { hermetic } from '../ci/test-fixtures.mjs';
import { findLease } from '../device/claims.mjs';
import { fakeWire } from '../device/wire-fixtures.mjs';
import { createKnown } from '../host-agent/known.mjs';
import { AGENT_ROUTES } from '../host-agent/routes.mjs';
import { startHostAgent } from '../host-agent/server.mjs';
import { applySeed } from '../registry/store.mjs';
import { ROUTES, handle } from './routes.mjs';
import { startHubApi } from './server.mjs';

hermetic();

const policy = loadPolicy().policy;
const S24 = 'R5CX31AEJDA';
const S26 = 'R5GL43A7PCH';
const PIXEL = 'QAPIXEL7777';
const CONTROL = 'ZY22CTRL01';
const usbId = serial => `adb-${serial}-zz._adb-tls-connect._tcp`;
const QA = [{ name: 'S24', serial: S24, allowed_users: [0, 10] }, { name: 'Pixel-QA', model: 'Pixel 7', serial: PIXEL, allowed_users: [0] }];
// What must never appear: each QA serial and the adb id that embeds it.
const NEEDLES = [S24, PIXEL, usbId(S24), usbId(PIXEL)];
const LISTED = [S24, PIXEL, S26].map(serial => ({ id: usbId(serial), state: 'device', model: 'SM_FIXTURE' })).concat([{ id: CONTROL, state: 'device', model: 'Control_1' }]);
const SERIALS = { [usbId(S24)]: S24, [usbId(PIXEL)]: PIXEL, [usbId(S26)]: S26, [CONTROL]: CONTROL };
const serverUp = () => ({ adb_servers: [{ port: 5037, pid: 4242, cwd: null }], emulators: [], xvfb: [] });
const noServers = () => ({ adb_servers: [], emulators: [], xvfb: [] });
const quiet = { out: () => {}, err: () => {} };
const tick = ms => new Promise(done => setTimeout(done, ms));
const until = async (check, what) => {
  for (let tries = 0; tries < 400; tries += 1) { if (check()) return; await tick(10); }
  assert.fail(`never happened: ${what}`);
};

// The raw bytes a client sees, lowercased: the status line's headers and the body text. A serial is found in either, in any case.
const rawOf = ({ status, headers, text }) => `${status}\n${JSON.stringify(headers)}\n${text}`.toLowerCase();
export function leaks(answer) { return NEEDLES.filter(needle => rawOf(answer).includes(needle.toLowerCase())); }
function assertClean(label, answer) {
  assert.deepEqual(leaks(answer), [], `${label} carries a QA serial: ${rawOf(answer).slice(0, 400)}`);
}

// Timers a test never fires (the history peer sync's), and an ssh whose every connection is refused: no request ever reaches a real host.
function fakeTimers() {
  const t = {};
  t.setInterval = (fn, ms) => ({ fn, ms });
  t.clearInterval = () => {};
  t.setTimeout = (fn, ms) => ({ fn, ms, refresh() { return this; } });
  t.clearTimeout = () => {};
  return t;
}
function refusedSsh() {
  const child = new EventEmitter();
  Object.assign(child, { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), killed: false, kill() { this.killed = true; } });
  setImmediate(() => { child.stderr.write('ssh: connect to host mac port 22: Connection refused\n'); setImmediate(() => setImmediate(() => child.emit('close', 255))); });
  return child;
}

// The minimal node `res`: what `requestListener` writes to, whether one answer or a stream's frames.
class Sink extends EventEmitter {
  head = null;
  chunks = [];
  writableFinished = false;
  writeHead(status, headers) { this.head = { status, headers }; }
  write(chunk) { this.chunks.push(String(chunk)); return true; }
  end(text) { if (text !== undefined) this.chunks.push(String(text)); this.writableFinished = true; this.emit('close'); }
  destroy() { this.writableFinished = true; this.emit('close'); }
  get answer() { return { status: this.head.status, headers: this.head.headers, text: this.chunks.join(''), json: () => JSON.parse(this.chunks.join('')) }; }
}
function open(listener, { method = 'GET', url, body, headers = {} }) {
  const req = { method, url, headers, async *[Symbol.asyncIterator]() { if (body !== undefined) yield Buffer.from(JSON.stringify(body)); } };
  const sink = new Sink();
  return { sink, done: listener(req, sink) };
}
async function call(listener, request) {
  const opened = open(listener, request);
  await opened.done;
  return opened.sink.answer;
}

class FakeServer extends EventEmitter {
  constructor(handler, hold) { super(); hold.listener = handler; }
  listen(port, host, callback) { process.nextTick(callback); return this; }
  address() { return { port: 1 }; }
  close(callback) { process.nextTick(callback); return this; }
}

function world() {
  const root = mkdtempSync(join(tmpdir(), 'hub-api-leak-'));
  const sideEnv = name => ({ PATH: process.env.PATH, HOME: join(root, name), HUB_LOCK_DIR: join(root, name, 'locks'), HUB_EVENT_DIR: join(root, name, 'events'), HUB_ADB_SERVER_PORT: '5037' });
  return { root, hubEnv: sideEnv('hub'), agentEnv: sideEnv('agent'), cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

// The states a QA phone is in: a Lease a CLI took with a connect (its owner record carries the adb id), a waiter queued behind it.
async function seedState(env) {
  const hold = (lock, id) => acquireLease(lock, { holder: 'agent-a', why: 'qa proof', forMs: 3_600_000, id, env, log: () => {} });
  const device = (phone, serial) => ({ phone, serial, adb_id: usbId(serial), adb_port: 5037 });
  await hold('res-pixel-qa', 'qa-pixel');
  updateLease('res-pixel-qa', 'qa-pixel', { device: device('res-pixel-qa', PIXEL) }, { env });
  await hold('s24', 'qa-s24');
  updateLease('s24', 'qa-s24', { device: device('s24', S24) }, { env });
  const now = Date.now();
  for (const [lock, id, n] of [['s24', 'wait-s24', 1], ['res-pixel-qa', 'wait-pixel', 2]]) {
    mkdirSync(join(lockDir(env), `${lock}.queue`), { recursive: true });
    writeFileSync(join(lockDir(env), `${lock}.queue`, `${String(now).padStart(15, '0')}-00000${n}-0000000${n}.json`), JSON.stringify(buildTicket('lease', { env, requested: now, lease_id: id, holder: 'waiter', why: 'queued behind a QA phone', expires_at: new Date(now + 3_600_000).toISOString() })));
  }
}

// A deploy run's Reservation of the S26's lock (it would hold a Lease on `adb` back, so it is made just before the step that force-releases it).
const reserveAdb = env => reserve('adb', { env: { ...env, GITHUB_REPOSITORY: 'acme/app', GITHUB_RUN_ID: '77' }, policy, log: () => {} });

const trackSocket = () => {
  const opens = [];
  return { opens, open: (port, handlers) => { const socket = { port, handlers, close() { handlers.onClose({ opened: true, error: null }); } }; opens.push(socket); return socket; } };
};

async function bootHub(w) {
  const hold = {};
  const signals = new EventEmitter();
  const track = trackSocket();
  const running = await startHubApi({
    env: w.hubEnv, policy, hostId: 'leak-host', devices: structuredClone(loadDevices({})), qaDevices: () => QA, versions: { node: '24.15.0' }, onPath: () => true, signals, hostKey: () => 'linux',
    log: quiet, createServer: handler => new FakeServer(handler, hold),
    inventory: serverUp, adbWire: fakeWire({ listed: LISTED, serials: SERIALS }), sleep: () => Promise.resolve(), trackDevices: track.open, sshImpl: refusedSsh, timers: fakeTimers(),
  });
  return { hold, track, running, stop: async () => { signals.emit('SIGTERM'); await running.stopped; }, request: request => call(hold.listener, request) };
}

// The Host Agent of a spoke host (keyed `linux` here, so it owns the QA phones and its own lock dir holds them): its Registry knowledge is the Hub API's `GET /resources`
// answer alone (its own seed has no QA phone), so a runtime QA phone is known to it only through that.
async function bootAgent(w, hub) {
  const hold = {};
  const signals = new EventEmitter();
  const request = async ({ method = 'GET', path, body }) => {
    const answer = await hub.request({ method, url: path, body });
    return new Response(answer.text, { status: answer.status, headers: { 'content-type': answer.headers['Content-Type'] ?? 'application/json' } });
  };
  const known = createKnown({ env: w.agentEnv, devices: structuredClone(loadDevices({})), qaDevices: () => [] });
  assert.equal(known.qaIds().includes('res-pixel-qa'), false, 'the agent\'s own seed does not know the runtime QA phone');
  const running = await startHostAgent({
    env: w.agentEnv, policy, hostId: 'leak-agent', boot: '0123456789ab', devices: structuredClone(loadDevices({})), qaDevices: () => [], versions: { node: '24.15.0' }, signals, hostKey: () => 'linux',
    log: quiet, createServer: handler => new FakeServer(handler, hold), known, request, timers: fakeTimers(),
    inventory: noServers, devicectl: () => ({ result: { devices: [] } }),
  });
  assert.equal(await known.refresh({ request }), true);
  assert.equal(known.qaIds().includes('res-pixel-qa'), true, 'the agent learned the runtime QA phone from the Hub API');
  return { hold, running, stop: async () => { signals.emit('SIGTERM'); await running.stopped; }, request: req => call(hold.listener, req) };
}

// ---- sweep samples: every GET route and every POST route of each table must have one ----

const LEASE_BODY = { for_ms: 600_000, holder: 'sweeper', why: 'sweep' };
// GET: the urls to ask (over the state `seedState` made), each answered 200.
const HUB_GETS = Object.freeze({
  '/health': ['/health'],
  '/resources': ['/resources'],
  '/resources/{id}': ['/resources/s24', '/resources/res-pixel-qa', '/resources/s26'],
  '/pools': ['/pools'],
  '/discovery': ['/discovery'],
  '/status': ['/status'],
  '/stream': ['/stream'],
  '/history': ['/history'],
  '/utilisation': ['/utilisation?from=2020-01-01'],
  '/leases/{id}': ['/leases/qa-pixel', '/leases/qa-s24'],
});
const AGENT_GETS = Object.freeze({
  '/health': ['/health'],
  '/status': ['/status'],
  '/leases/{id}': ['/leases/qa-pixel', '/leases/qa-s24'],
});

// POST, in the order they run: `body` (a function of the service's request seam when it reads state), `status` its success. The QA Leases are extended and
// force-released; the waiter behind a QA phone is cancelled; every answer is swept.
const POST_STEPS = side => [
  ...(side === 'hub' ? [['/agent/push', '/agent/push', { format: 1, host: 'mac', host_id: null, boot: '0123456789ab', seq: 1, sent_at: new Date().toISOString(), status: null, readings: null, events: null }, 200]] : []),
  ...(side === 'hub' ? [
    ['/registry/resources', '/registry/resources', { kind: 'phone', name: 'pixel', host: 'linux', identity: { serial: 'PX9', model: 'Pixel 9' }, capabilities: { api_level: 35 }, holder: 'sweeper' }, 201],
    ['/registry/resources/{id}', '/registry/resources/res-pixel', async ask => ({ if_rev: (await ask({ url: '/resources' })).json().rev, name: 'pixel-9', capabilities: { api_level: 36 }, holder: 'sweeper' }), 200],
    ['/registry/resources/{id}/retire', '/registry/resources/res-pixel/retire', { holder: 'sweeper' }, 200],
  ] : []),
  ['/leases', '/leases', { ...LEASE_BODY, resource: 's26', id: 'sweep-1' }, 200],
  ['/leases/{id}/extend', '/leases/sweep-1/extend', { for_ms: 600_000, holder: 'sweeper' }, 200],
  ['/requests/{id}/cancel', '/requests/wait-pixel/cancel', { resource: 'res-pixel-qa', host: 'linux', why: 'sweep', holder: 'sweeper' }, 200],
  ['/leases/{id}/extend', '/leases/qa-pixel/extend', { for_ms: 600_000, holder: 'sweeper' }, 200],
  ['/leases/{id}/release', '/leases/sweep-1/release', { holder: 'sweeper' }, 200],
  ['/leases/{id}/force-release', '/leases/qa-s24/force-release', { why: 'sweep', holder: 'sweeper' }, 200],
  // A take of a QA phone that is held is refused as busy: its refusal names the holder and the queue, never a serial.
  ['/leases', '/leases', { ...LEASE_BODY, resource: 'pixel-qa', id: 'sweep-2' }, 409],
  ['/leases', '/leases', { ...LEASE_BODY, resource: 's26', id: 'sweep-3' }, 200],
  ['/reservations/{run_key}/force-release', '/reservations/acme--app--77/force-release', { why: 'sweep', holder: 'sweeper' }, 200, reserveAdb],
  ...(side === 'agent' ? [['/agent/sync', '/agent/sync', { replica: {} }, 200]] : []),
];

function coverage(routes, gets, steps) {
  for (const route of routes.filter(candidate => candidate.method === 'GET')) assert.ok(Object.hasOwn(gets, route.path), `no leak sweep sample for GET ${route.path}: add it to the sweep samples`);
  for (const route of routes.filter(candidate => candidate.method === 'POST')) assert.ok(steps.some(([path]) => path === route.path), `no leak sweep sample for POST ${route.path}: add it to POST_STEPS`);
  assert.deepEqual(Object.keys(gets).sort(), routes.filter(candidate => candidate.method === 'GET').map(route => route.path).sort(), 'a sample for a GET route that is gone');
}

// Every POST sample, then every refusal a route can give (a body that is no object, a missing path, a wrong method): the answer and its headers swept.
async function sweepPosts(side, ask, routes, env) {
  const answers = [];
  for (const [path, url, given, status, before] of POST_STEPS(side)) {
    before?.(side === 'hub' ? env.hub : env.agent);
    const body = typeof given === 'function' ? await given(ask) : given;
    const answer = await ask({ method: 'POST', url, body });
    assert.equal(answer.status, status, `POST ${url}: ${answer.text}`);
    assertClean(`${side} POST ${url}`, answer);
    answers.push([path, answer]);
  }
  for (const route of routes.filter(candidate => candidate.method === 'POST')) {
    const url = route.path.replace('{id}', 'qa-pixel').replace('{run_key}', 'acme--app--77');
    assertClean(`${side} POST ${url} with []`, await ask({ method: 'POST', url, body: [] }));
    assertClean(`${side} DELETE ${url}`, await ask({ method: 'DELETE', url }));
  }
  assertClean(`${side} GET /nope`, await ask({ method: 'GET', url: '/nope' }));
  return answers;
}

test('the detector finds a serial in a body, in a header, in either case, and an adb id; and finds none in a clean answer', () => {
  const clean = { status: 200, headers: { 'Content-Type': 'application/json' }, text: '{"serial":null,"adb_id":null}' };
  assert.deepEqual(leaks(clean), []);
  assert.deepEqual(leaks({ ...clean, text: `{"serial":"${S24.toLowerCase()}"}` }), [S24]);
  assert.deepEqual(leaks({ ...clean, headers: { 'X-Echo': PIXEL } }), [PIXEL]);
  assert.deepEqual(leaks({ ...clean, text: usbId(PIXEL).toUpperCase() }).sort(), [PIXEL, usbId(PIXEL)].sort());
  assert.throws(() => assertClean('synthetic', { ...clean, text: S24 }), /carries a QA serial/);
});

test('every route of both tables has a sweep sample', () => {
  coverage(ROUTES, HUB_GETS, POST_STEPS('hub'));
  coverage(AGENT_ROUTES, AGENT_GETS, POST_STEPS('agent'));
  assert.throws(() => coverage([...ROUTES, { method: 'GET', path: '/ghost' }], HUB_GETS, POST_STEPS('hub')), /no leak sweep sample for GET \/ghost/);
  assert.throws(() => coverage([...ROUTES, { method: 'POST', path: '/ghost' }], HUB_GETS, POST_STEPS('hub')), /no leak sweep sample for POST \/ghost/);
});

test('the Hub API: no GET route (stream frames included) and no POST answer carries a QA serial, while a non-QA control serial is in /discovery', async () => {
  const w = world();
  let hub;
  try {
    hub = await bootHub(w);
    // The phones are tracked: the one socket pushes a listing with both QA phones.
    await until(() => hub.track.opens.length > 0, 'the track socket opened');
    hub.track.opens.at(-1).handlers.onDevices(LISTED.map((entry, index) => ({ ...entry, product: null, device: null, transport_id: String(index + 1) })));
    await seedState(w.hubEnv);

    // The stream stays open for the whole sweep: its ready frame, then the frames the POSTs' events and a poke cause.
    const stream = open(hub.hold.listener, { url: '/stream' });
    await stream.done;
    assert.equal(stream.sink.head.status, 200);

    for (const route of ROUTES.filter(candidate => candidate.method === 'GET' && !candidate.stream)) {
      for (const url of HUB_GETS[route.path]) {
        const answer = await hub.request({ url });
        assert.equal(answer.status, 200, `GET ${url}: ${answer.text}`);
        assertClean(`GET ${url}`, answer);
      }
    }
    for (const url of ['/nope', '/resources/ghost', '/leases/ghost', '/history?bogus=1', '/utilisation']) assertClean(`GET ${url}`, await hub.request({ url }));

    // The sweep is not vacuous: the QA phones are in these answers, with their serials null.
    const status = (await hub.request({ url: '/status' })).json();
    const rows = Object.fromEntries(status.hosts.linux.phones.map(phone => [phone.device, phone]));
    assert.deepEqual([rows.s24.serial, rows.s24.adb_id, rows.s24.held], [null, null, 'lease']);
    assert.ok(rows['pixel-qa'], 'the runtime QA phone is a row (by its word)');
    assert.equal(rows['pixel-qa'].serial, null);
    assert.equal(rows.s26.serial, S26, 'a phone that is not dedicated keeps its serial');
    const discovery = (await hub.request({ url: '/discovery' })).json();
    assert.ok(JSON.stringify(discovery).includes(CONTROL), 'the control serial (not a QA phone, not registered) is in /discovery');
    const resource = (await hub.request({ url: '/resources/res-pixel-qa' })).json().resource;
    assert.deepEqual([resource.capabilities.dedicated_qa, resource.identity.serial], [true, null]);

    await sweepPosts('hub', hub.request, ROUTES, { hub: w.hubEnv });

    // The frames: one more push pokes the change feed, which re-reads and emits the events the POSTs wrote and the document that changed.
    const poke = await hub.request({ method: 'POST', url: '/agent/push', body: { format: 1, host: 'mac', host_id: null, boot: '0123456789ab', seq: 2, sent_at: new Date().toISOString(), status: null, readings: null, events: null } });
    assert.equal(poke.status, 200);
    await until(() => /"type":\s*"event"/.test(stream.sink.chunks.join('')) && /"type":\s*"status"/.test(stream.sink.chunks.join('')), 'the change feed emitted event and status frames');
    const frames = stream.sink.answer;
    assertClean('GET /stream (ready, event and status frames)', { ...frames, status: stream.sink.head.status, headers: stream.sink.head.headers });
    assert.match(frames.text, /^retry: /m);
  } finally { await hub?.stop(); w.cleanup(); }
});

test('the Host Agent: no GET route and no POST answer carries a QA serial, a runtime QA phone known only from the Hub API included', async () => {
  const w = world();
  let hub;
  let agent;
  try {
    hub = await bootHub(w);
    agent = await bootAgent(w, hub);
    await seedState(w.agentEnv);
    for (const route of AGENT_ROUTES.filter(candidate => candidate.method === 'GET')) {
      for (const url of AGENT_GETS[route.path]) {
        const answer = await agent.request({ url });
        assert.equal(answer.status, 200, `agent GET ${url}: ${answer.text}`);
        assertClean(`agent GET ${url}`, answer);
      }
    }
    for (const url of ['/nope', '/leases/ghost', '/capacity']) assertClean(`agent GET ${url}`, await agent.request({ url }));

    const status = (await agent.request({ url: '/status' })).json();
    const qaRows = status.phones.filter(phone => ['s24', 'pixel-qa'].includes(phone.device));
    assert.ok(qaRows.length > 0 && qaRows.every(phone => phone.serial === null && phone.adb_id === null), 'the QA phones are rows of the agent\'s status, serials null');
    const lease = (await agent.request({ url: '/leases/qa-pixel' })).json();
    assert.equal(lease.env.ANDROID_SERIAL, null, 'through known.qaIds, from the Hub API\'s answer');

    await sweepPosts('agent', agent.request, AGENT_ROUTES, { agent: w.agentEnv });
  } finally { await agent?.stop(); await hub?.stop(); w.cleanup(); }
});

// ---- the Lease rows of the matrix ----

function lane() {
  const root = mkdtempSync(join(tmpdir(), 'hub-api-leak-lease-'));
  const env = { PATH: process.env.PATH, HOME: root, HUB_LOCK_DIR: join(root, 'locks'), HUB_EVENT_DIR: join(root, 'events'), HUB_ADB_SERVER_PORT: '5037' };
  const devices = structuredClone(loadDevices({}));
  const ctx = { env, policy, routes: ROUTES, devices, qaDevices: () => QA, hostKey: () => 'linux', hostId: 'leak-host', inventory: serverUp, adbWire: fakeWire({ listed: LISTED, serials: SERIALS }), sleep: () => Promise.resolve(), log: quiet };
  return { env, ctx, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
async function cliLease({ env }, lock, id, phone, serial, forMs = 3_600_000) {
  await acquireLease(lock, { holder: 'agent-a', why: 'qa proof', forMs, id, env, log: () => {} });
  updateLease(lock, id, { device: { phone, serial, adb_id: usbId(serial), adb_port: 5037 } }, { env });
}

test('a CLI Lease on a dedicated_qa Resource serves env.ANDROID_SERIAL as null on GET, on extend and on a repeated take, the key kept; the CLI itself keeps the adb id', async () => {
  const l = lane();
  try {
    await applySeed({ env: l.env, devices: structuredClone(loadDevices({})), qaDevices: () => QA, hostId: 'leak-host', log: () => {} });
    await cliLease(l, 'res-pixel-qa', 'qa-pixel', 'res-pixel-qa', PIXEL);
    await cliLease(l, 's24', 'qa-s24', 's24', S24);
    for (const [id, resource] of [['qa-pixel', 'res-pixel-qa'], ['qa-s24', 's24']]) {
      const got = await handle({ method: 'GET', url: `/leases/${id}` }, l.ctx);
      assert.equal(got.status, 200, JSON.stringify(got.body));
      assert.ok('ANDROID_SERIAL' in got.body.env, 'the key stays');
      assert.equal(got.body.env.ANDROID_SERIAL, null);
      assert.equal(got.body.resource, resource);
      assert.equal(got.body.env.ANDROID_ADB_SERVER_PORT, '5037');
      assertClean(`GET /leases/${id}`, { status: got.status, headers: got.headers, text: JSON.stringify(got.body) });
      const extended = await handle({ method: 'POST', url: `/leases/${id}/extend`, body: { for_ms: 600_000, holder: 'agent-a' } }, l.ctx);
      assert.equal(extended.status, 200, JSON.stringify(extended.body));
      assert.ok('ANDROID_SERIAL' in extended.body.env);
      assert.equal(extended.body.env.ANDROID_SERIAL, null);
      assertClean(`extend ${id}`, { status: extended.status, headers: extended.headers, text: JSON.stringify(extended.body) });
      // A client that lost its answer asks again with its id: the existing Lease, redacted the same way.
      const again = await handle({ method: 'POST', url: '/leases', body: { resource, ...LEASE_BODY, holder: 'agent-a', id } }, l.ctx);
      assert.equal(again.status, 200, JSON.stringify(again.body));
      assert.equal(again.body.env.ANDROID_SERIAL, null);
      assertClean(`repeat take ${id}`, { status: again.status, headers: again.headers, text: JSON.stringify(again.body) });
      // The CLI's own view (no qaIds) keeps today's values: it is the person's own machine.
      assert.equal(findLease(id, { env: l.env, warn: () => {} }).env.ANDROID_SERIAL, usbId(id === 'qa-pixel' ? PIXEL : S24));
    }
  } finally { l.cleanup(); }
});

test('the same Lease on a phone that is not dedicated_qa (s26) keeps env.ANDROID_SERIAL, on GET and on extend', async () => {
  const l = lane();
  try {
    await applySeed({ env: l.env, devices: structuredClone(loadDevices({})), qaDevices: () => QA, hostId: 'leak-host', log: () => {} });
    await cliLease(l, 'adb', 'plain-1', 's26', S26, 1_200_000);   // the deploy target's cap is 60 minutes in total
    const got = await handle({ method: 'GET', url: '/leases/plain-1' }, l.ctx);
    assert.equal(got.status, 200, JSON.stringify(got.body));
    assert.equal(got.body.resource, 's26');
    assert.equal(got.body.env.ANDROID_SERIAL, usbId(S26));
    const extended = await handle({ method: 'POST', url: '/leases/plain-1/extend', body: { for_ms: 600_000, holder: 'agent-a' } }, l.ctx);
    assert.equal(extended.status, 200, JSON.stringify(extended.body));
    assert.equal(extended.body.env.ANDROID_SERIAL, usbId(S26));
  } finally { l.cleanup(); }
});

test('the redaction follows the Registry file: a phone marked dedicated_qa after the fact is redacted on the next read, and one unmarked is not', async () => {
  const l = lane();
  try {
    // No QA file entry at the start: the runtime phone is registered by a caller, not dedicated, so its Lease keeps the adb id it recorded.
    await applySeed({ env: l.env, devices: structuredClone(loadDevices({})), qaDevices: () => [], hostId: 'leak-host', log: () => {} });
    const registered = await handle({ method: 'POST', url: '/registry/resources', body: { kind: 'phone', name: 'pixel', host: 'linux', identity: { serial: 'PX9', model: 'Pixel 9' }, holder: 'sweeper' } }, l.ctx);
    assert.equal(registered.status, 201, JSON.stringify(registered.body));
    await cliLease(l, 'res-pixel', 'reg-1', 'res-pixel', 'PX9');
    const got = await handle({ method: 'GET', url: '/leases/reg-1' }, { ...l.ctx, qaDevices: () => [] });
    assert.equal(got.status, 200, JSON.stringify(got.body));
    assert.equal(got.body.env.ANDROID_SERIAL, usbId('PX9'), 'a serial a caller registered itself is echoed by design');
  } finally { l.cleanup(); }
});
