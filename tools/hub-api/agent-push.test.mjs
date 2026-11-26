// Story 9.5 (AD-49): the Hub API's side of the Host Agent's push, hermetic. `POST /agent/push` through handle() on a temp lock and event dir with a
// fake adb wire, an injected inventory, host key and clock; the stream test starts `startHubApi` with a FakeServer, a fake `watch` and a mocked
// `setTimeout`. No port is bound, no adb server and no host key is reached.
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadDevices } from '../ci/lib/devices.mjs';
import { processStart } from '../ci/lib/lock.mjs';
import { loadPolicy } from '../ci/lib/policy.mjs';
import { hermetic } from '../ci/test-fixtures.mjs';
import { fakeWire } from '../device/wire-fixtures.mjs';
import { createReadings } from './readings.mjs';
import { checkPushBody, createRemotes, PUSH_REASONS } from './remotes.mjs';
import { ROUTES, handle } from './routes.mjs';
import { startHubApi } from './server.mjs';
import { CHANGE_DEBOUNCE_MS } from './stream.mjs';

hermetic();

const policy = loadPolicy().policy;
const T0 = Date.parse('2026-11-26T10:00:00Z');
const iso = ms => new Date(ms).toISOString();
const BOOT_B = 'b0b0b0b0b0b0';
const BOOT_C = 'c0c0c0c0c0c0';
const serverUp = () => ({ adb_servers: [{ port: 5037, pid: 4242, cwd: null }], emulators: [], xvfb: [] });
const flush = async (rounds = 25) => { for (let round = 0; round < rounds; round += 1) await new Promise(done => setImmediate(done)); };

const macView = (extra = {}) => ({
  phones: [], locks: [{ lock: 'mac-ios', device: null, kind: 'lease', started_at: iso(T0 - 5000), resource: 'ios-lane' }], waiters: [], reservations: [], inventory: { adb_servers: [] }, emulators: [], ...extra,
});
const reading = (state, extra = {}) => ({ resource: 'ios-lane', state, checked_at: iso(T0), age_ms_at_receipt: 0, received_at: T0, source: 'probe', ...extra });
const pushBody = (extra = {}) => ({
  format: 1, host: 'mac', host_id: 'MAC-UUID', boot: BOOT_B, seq: 1, sent_at: iso(T0 - 1000), status: macView(), readings: [reading('reachable')], events: null, ...extra,
});

function scratch({ hostKey = () => 'linux' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'hub-api-push-'));
  const env = { PATH: process.env.PATH, HOME: root, HUB_LOCK_DIR: join(root, 'locks'), HUB_EVENT_DIR: join(root, 'events'), HUB_ADB_SERVER_PORT: '5037' };
  const clock = { t: T0 };
  const now = () => clock.t;
  const readings = createReadings({ env, policy, now, hostId: 'test-host', hostKey, probe: async () => new Map() });
  const base = { env, policy, routes: ROUTES, now, hostId: 'test-host', devices: structuredClone(loadDevices({})), qaDevices: () => [], hostKey, inventory: serverUp, adbWire: fakeWire({ listed: [] }), sleep: () => Promise.resolve(), log: { out: () => {}, err: () => {} }, readings, remotes: createRemotes() };
  const pokes = [];
  const ctx = (more = {}) => ({ ...base, onPush: () => pokes.push(clock.t), ...more });
  return {
    root, env, clock, pokes, ctx,
    push: (body, more) => handle({ method: 'POST', url: '/agent/push', body }, ctx(more)),
    status: more => handle({ method: 'GET', url: '/status' }, ctx(more)),
    resources: more => handle({ method: 'GET', url: '/resources' }, ctx(more)),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}
const laneOf = answer => answer.body.resources.find(resource => resource.id === 'ios-lane');

test('the route is POST /agent/push with the AgentPushAck shape', () => {
  const route = ROUTES.find(candidate => candidate.method === 'POST' && candidate.path === '/agent/push');
  assert.equal(route.shape, 'AgentPushAck');
});

test('apply: the pushed view is /status.hosts.mac after the service\'s own, the lane reading is served, and no reachability event is written', async () => {
  const s = scratch();
  try {
    assert.deepEqual(Object.keys((await s.status()).body.hosts), ['linux']);
    const answer = await s.push(pushBody({ seq: 3 }));
    assert.equal(answer.status, 200, JSON.stringify(answer.body));
    assert.deepEqual(answer.body, { applied: true, host: 'mac', boot: BOOT_B, seq: 3 });
    const status = await s.status();
    assert.deepEqual(Object.keys(status.body.hosts), ['linux', 'mac']);
    assert.deepEqual(status.body.hosts.mac, macView());
    assert.deepEqual(status.body.stale, {});
    // The reading was received on this service's clock: its age grows from the push, whatever the Mac's clock said.
    s.clock.t = T0 + 7000;
    const lane = laneOf(await s.resources());
    assert.equal(lane.reachability.state, 'reachable');
    assert.equal(lane.reachability.age_ms_at_receipt, 7000);
    assert.equal(lane.reachability.source, 'probe');
    assert.equal(s.pokes.length, 1, 'the change feed was poked once');
    assert.ok(!existsSync(s.env.HUB_EVENT_DIR) || readdirSync(s.env.HUB_EVENT_DIR).length === 0, 'a pushed reading logs no reachability event');
  } finally { s.cleanup(); }
});

test('before any push the lane reads unknown', async () => {
  const s = scratch();
  try { assert.equal(laneOf(await s.resources()).reachability.state, 'unknown'); } finally { s.cleanup(); }
});

test('duplicate: the same boot with a seq not above the applied one is 200 {applied: false}, changes nothing and pokes nothing', async () => {
  const s = scratch();
  try {
    await s.push(pushBody({ seq: 3 }));
    const pokes = s.pokes.length;
    for (const seq of [3, 2, 1]) {
      const answer = await s.push(pushBody({ seq, status: macView({ phones: [{ device: 'other' }] }), readings: [reading('offline')] }));
      assert.equal(answer.status, 200);
      assert.deepEqual(answer.body, { applied: false, host: 'mac', boot: BOOT_B, seq });
    }
    assert.deepEqual((await s.status()).body.hosts.mac, macView());
    assert.equal(laneOf(await s.resources()).reachability.state, 'reachable');
    assert.equal(s.pokes.length, pokes);
    assert.equal((await s.push(pushBody({ seq: 4, readings: [reading('offline')] }))).body.applied, true, 'a higher seq applies');
    assert.equal(laneOf(await s.resources()).reachability.state, 'offline');
  } finally { s.cleanup(); }
});

test('a new boot applies from seq 1 even after seq 9 of the old one', async () => {
  const s = scratch();
  try {
    await s.push(pushBody({ seq: 9 }));
    const answer = await s.push(pushBody({ boot: BOOT_C, seq: 1, status: macView({ emulators: [] }), readings: [reading('absent')] }));
    assert.deepEqual(answer.body, { applied: true, host: 'mac', boot: BOOT_C, seq: 1 });
    assert.equal(laneOf(await s.resources()).reachability.state, 'absent');
    assert.equal((await s.push(pushBody({ boot: BOOT_B, seq: 10 }))).body.applied, true, 'each boot is its own sequence');
  } finally { s.cleanup(); }
});

test('stale: {since: <receipt ISO>} past reachability_max_age_s on this clock, none at the limit, and never stored', async () => {
  const s = scratch();
  try {
    const limit = policy.registry.reachability_max_age_s * 1000;
    assert.equal(limit, 60_000);
    await s.push(pushBody());
    s.clock.t = T0 + limit;
    assert.deepEqual((await s.status()).body.stale, {}, 'at 60 s the view is still current');
    s.clock.t = T0 + limit + 1000;
    const late = await s.status();
    assert.deepEqual(late.body.stale, { mac: { since: iso(T0) } });
    assert.deepEqual(late.body.hosts.mac, macView(), 'the stale view is still shown, unchanged');
    assert.ok(!('stale' in late.body.hosts.mac));
    // A new push is a new receipt: the view is current again.
    await s.push(pushBody({ seq: 2 }));
    assert.deepEqual((await s.status()).body.stale, {});
  } finally { s.cleanup(); }
});

test('a null status keeps the last view and its receipt time, and still applies the readings', async () => {
  const s = scratch();
  try {
    await s.push(pushBody());
    s.clock.t = T0 + 40_000;
    const answer = await s.push(pushBody({ seq: 2, status: null, readings: [reading('offline')] }));
    assert.equal(answer.body.applied, true);
    s.clock.t = T0 + 61_000;
    const status = await s.status();
    assert.deepEqual(status.body.hosts.mac, macView());
    assert.deepEqual(status.body.stale, { mac: { since: iso(T0) } }, 'the receipt time is the last view\'s');
    assert.equal(laneOf(await s.resources()).reachability.state, 'offline');
  } finally { s.cleanup(); }
});

test('a null status from a host with no view shows no host and no stale key', async () => {
  const s = scratch();
  try {
    assert.equal((await s.push(pushBody({ status: null, readings: null }))).body.applied, true);
    const status = await s.status();
    assert.deepEqual(Object.keys(status.body.hosts), ['linux']);
    assert.deepEqual(status.body.stale, {});
  } finally { s.cleanup(); }
});

test('readings: a Resource of another host is ignored, an unknown reading drops the stored one, and an unknown Resource is ignored', async () => {
  const s = scratch();
  try {
    await s.push(pushBody({ readings: [reading('reachable'), reading('offline', { resource: 's26' }), reading('reachable', { resource: 'res-nothing' })] }));
    const list = await s.resources();
    assert.equal(laneOf(list).reachability.state, 'reachable');
    const s26 = list.body.resources.find(resource => resource.id === 's26');
    assert.equal(s26.reachability.state, 'unknown', 'a phone of the service\'s own host is never set by a push');
    await s.push(pushBody({ seq: 2, readings: [{ resource: 'ios-lane', state: 'unknown', checked_at: null, age_ms_at_receipt: null, received_at: null, source: null }] }));
    assert.equal(laneOf(await s.resources()).reachability.state, 'unknown');
    assert.equal(laneOf(await s.resources()).reachability.checked_at, null);
  } finally { s.cleanup(); }
});

test('bad body: each reason is 400 HUB_USAGE with exit 2, and nothing is stored or poked', async () => {
  const s = scratch();
  try {
    const cases = [
      ['bad-body', null], ['bad-body', []], ['bad-body', { ...pushBody(), extra: 1 }], ['bad-body', (({ events, ...rest }) => rest)(pushBody())],
      ['bad-format', pushBody({ format: 2 })],
      ['bad-host', pushBody({ host: 'linux' })], ['bad-host', pushBody({ host: 'windows' })], ['bad-host', pushBody({ host: null })],
      ['bad-host-id', pushBody({ host_id: '' })], ['bad-host-id', pushBody({ host_id: 7 })],
      ['bad-boot', pushBody({ boot: 'ABCDEF012345' })], ['bad-boot', pushBody({ boot: 'abc' })],
      ['bad-seq', pushBody({ seq: 0 })], ['bad-seq', pushBody({ seq: 1.5 })], ['bad-seq', pushBody({ seq: '1' })],
      ['bad-sent-at', pushBody({ sent_at: 'yesterday' })], ['bad-sent-at', pushBody({ sent_at: '2026' })], ['bad-sent-at', pushBody({ sent_at: 'March 7' })], ['bad-sent-at', pushBody({ sent_at: 5 })],
      ['bad-status', pushBody({ status: [] })], ['bad-status', pushBody({ status: 'ok' })],
      ['bad-readings', pushBody({ readings: {} })], ['bad-readings', pushBody({ readings: [(({ checked_at, ...rest }) => rest)(reading('reachable'))] })], ['bad-readings', pushBody({ readings: [reading('asleep')] })], ['bad-readings', pushBody({ readings: [reading('reachable', { resource: '' })] })], ['bad-readings', pushBody({ readings: [reading('reachable', { age_ms_at_receipt: -1 })] })],
      ['bad-events', pushBody({ events: {} })], ['bad-events', pushBody({ events: [] })],
    ];
    const seen = new Set();
    for (const [reason, body] of cases) {
      const answer = await s.push(body);
      assert.equal(answer.status, 400, `${reason} ${JSON.stringify(answer.body)}`);
      assert.equal(answer.body.code, 'HUB_USAGE');
      assert.equal(answer.body.exit, 2);
      assert.equal(answer.body.reason, reason);
      seen.add(reason);
    }
    assert.deepEqual([...seen].sort(), [...PUSH_REASONS].sort(), 'every reason is exercised');
    assert.deepEqual(Object.keys((await s.status()).body.hosts), ['linux']);
    assert.equal(laneOf(await s.resources()).reachability.state, 'unknown');
    assert.deepEqual(s.pokes, []);
    // A request with a body that is not JSON never reaches the check.
    assert.equal((await handle({ method: 'POST', url: '/agent/push', bodyError: Object.assign(new Error('x'), { status: 400, code: 'HUB_USAGE', reason: 'bad-json' }) }, s.ctx())).body.reason, 'bad-json');
  } finally { s.cleanup(); }
});

test('a host that does not know its own key is 503 HUB_HOST_UNKNOWN', async () => {
  const s = scratch({ hostKey: () => { throw Object.assign(new Error('no host key'), { code: 'HUB_HOST_UNKNOWN' }); } });
  try {
    const answer = await s.push(pushBody());
    assert.equal(answer.status, 503);
    assert.equal(answer.body.code, 'HUB_HOST_UNKNOWN');
    assert.equal(answer.body.reason, 'host-unknown');
  } finally { s.cleanup(); }
});

test('a service on the Mac refuses a push from mac and takes one from linux: the store is per host key, not per Mac', async () => {
  const s = scratch({ hostKey: () => 'mac' });
  try {
    assert.equal((await s.push(pushBody())).body.reason, 'bad-host');
    const answer = await s.push(pushBody({ host: 'linux', readings: [] }));
    assert.equal(answer.body.applied, true);
  } finally { s.cleanup(); }
});

test('a handler hook that throws never changes the answer', async () => {
  const s = scratch();
  try {
    const answer = await s.push(pushBody(), { onPush: () => { throw new Error('boom'); } });
    assert.equal(answer.status, 200);
    assert.equal(answer.body.applied, true);
  } finally { s.cleanup(); }
});

test('a bare handle() with no remotes keeps one store per context', async () => {
  const s = scratch();
  try {
    const bare = { ...s.ctx(), remotes: undefined };
    const send = ctx => handle({ method: 'POST', url: '/agent/push', body: pushBody() }, ctx);
    assert.equal((await send(bare)).body.applied, true);
    assert.equal((await send(bare)).body.applied, false);
    assert.equal((await send({ ...s.ctx(), remotes: undefined })).body.applied, true, 'another context is another store');
  } finally { s.cleanup(); }
});

test('checkPushBody returns the body as it is and createRemotes holds views by host key', () => {
  const body = pushBody();
  assert.deepEqual(checkPushBody(body, { own: 'linux' }), body);
  const remotes = createRemotes();
  assert.deepEqual(remotes.apply(checkPushBody(body, { own: 'linux' }), { at: T0 }), { applied: true });
  assert.deepEqual(remotes.views({ now: T0 + 60_000, maxAgeS: 60 }), { hosts: { mac: macView() }, stale: {} });
  assert.deepEqual(remotes.views({ now: T0 + 60_001, maxAgeS: 60 }).stale, { mac: { since: iso(T0) } });
  assert.deepEqual(remotes.views({ now: T0, maxAgeS: undefined }).stale, { mac: { since: iso(T0) } }, 'no limit to judge by is never current');
});

// ---- the stream ----

class FakeSink extends EventEmitter {
  chunks = [];
  writableFinished = false;
  writableLength = 0;
  head = null;
  writeHead(status, headers) { this.head = { status, headers }; }
  write(text) { this.chunks.push(text); return true; }
  end(text) { if (typeof text === 'string') this.chunks.push(text); this.writableFinished = true; this.emit('close'); }
  destroy() { this.emit('close'); }
  get text() { return this.chunks.join(''); }
}
const framesOf = sink => sink.text.split('\n\n').filter(block => block.startsWith('id: ') || block.includes('\nid: ')).map(block => {
  const field = name => block.split('\n').find(line => line.startsWith(`${name}: `))?.slice(name.length + 2);
  return { event: field('event'), data: JSON.parse(field('data')) };
});

test('stream: a push is a status frame within 250 ms (mocked), carrying the Mac\'s view; a duplicate is no frame', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hub-api-push-stream-'));
  const env = { PATH: process.env.PATH, HOME: root, HUB_LOCK_DIR: join(root, 'locks'), HUB_EVENT_DIR: join(root, 'events'), HUB_ADB_SERVER_PORT: '5037' };
  mock.timers.enable({ apis: ['setTimeout'] });
  const signals = new EventEmitter();
  let listener;
  class FakeServer extends EventEmitter {
    constructor(handler) { super(); listener = handler; }
    listen(port, host, callback) { process.nextTick(callback); return this; }
    address() { return { port: 1 }; }
    close(callback) { process.nextTick(callback); return this; }
  }
  const call = async (url, method = 'GET', body) => {
    const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
    const req = { method, url, headers: {}, async *[Symbol.asyncIterator]() { for (const chunk of chunks) yield chunk; } };
    const res = new FakeSink();
    await listener(req, res);
    return res;
  };
  let running;
  try {
    const real = processStart(process.pid);
    running = await startHubApi({
      env, policy, now: () => T0, hostId: 'test-host', devices: structuredClone(loadDevices({})), qaDevices: () => [], versions: { node: '24.15.0' }, onPath: () => true, signals, hostKey: () => 'linux',
      log: { out: () => {}, err: () => {} }, createServer: handler => new FakeServer(handler), watch: () => ({ close() {}, on() { return this; } }),
      observe: async () => ({ inventory: { adb_servers: [{ port: 5037, pid: 4242, managed: true, cwd: null }], emulators: [], xvfb: [] }, adb: { port: 5037, note: null, listed: [], serials: new Map() }, starts: new Map([[process.pid, real]]), live_starts: new Map() }),
    });
    await flush();
    const sink = await call('/stream');
    assert.equal(sink.head.status, 200);
    const opening = framesOf(sink);
    assert.equal(opening[0].event, 'ready');
    assert.deepEqual(Object.keys(opening[0].data.status.hosts), ['linux']);

    const answer = await call('/agent/push', 'POST', pushBody({ seq: 5 }));
    assert.equal(JSON.parse(answer.text).applied, true);
    mock.timers.tick(CHANGE_DEBOUNCE_MS - 1);
    await flush();
    assert.equal(framesOf(sink).length, 1, 'nothing before the debounce');
    mock.timers.tick(1);
    await flush();
    const after = framesOf(sink).slice(1);
    assert.deepEqual(after.map(frame => frame.event), ['status']);
    assert.deepEqual(after[0].data.status.hosts.mac, macView());
    assert.deepEqual(after[0].data.status.stale, {});

    const duplicate = await call('/agent/push', 'POST', pushBody({ seq: 5, status: macView({ phones: [{ device: 'x' }] }) }));
    assert.equal(JSON.parse(duplicate.text).applied, false);
    mock.timers.tick(CHANGE_DEBOUNCE_MS * 2);
    await flush();
    assert.equal(framesOf(sink).length, 2, 'a duplicate sends no frame');
  } finally {
    signals.emit('SIGTERM');
    await running?.stopped;
    mock.timers.reset();
    rmSync(root, { recursive: true, force: true });
  }
});
