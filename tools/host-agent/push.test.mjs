// Story 9.5 (AD-49, NFR-3, NFR-8): the Host Agent pushes changes, and only changes. Hermetic: a FakeServer (no port), a fake `watch` and a mocked
// `setTimeout` (the one-shot push debounce is the only timer), an injected `request` (the agent's one transport), devicectl, inventory, host key,
// host id, boot and clock, and a temp lock and event dir per test. The end-to-end rows bridge the agent's transport into the Hub API's `handle()`.
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDevices } from '../ci/lib/devices.mjs';
import { acquireLease } from '../ci/lib/lock.mjs';
import { loadPolicy } from '../ci/lib/policy.mjs';
import { strip } from '../ci/lib/source-scan.mjs';
import { hermetic } from '../ci/test-fixtures.mjs';
import { fakeWire } from '../device/wire-fixtures.mjs';
import { createReadings } from '../hub-api/readings.mjs';
import { createRemotes } from '../hub-api/remotes.mjs';
import { ROUTES, handle } from '../hub-api/routes.mjs';
import { CHANGE_DEBOUNCE_MS } from '../hub-api/stream.mjs';
import { seed } from '../registry/seed.mjs';
import { createKnown } from './known.mjs';
import { createPusher } from './push.mjs';
import { startHostAgent } from './server.mjs';
import { createAgentWatch } from './watch.mjs';

hermetic();

const policy = loadPolicy().policy;
const FAR = Date.parse('2031-06-01T00:00:00Z');
const iso = ms => new Date(ms).toISOString();
const BOOT = 'a1b2c3d4e5f6';
const noServer = () => ({ adb_servers: [], emulators: [], xvfb: [] });
const flush = async (rounds = 25) => { for (let round = 0; round < rounds; round += 1) await new Promise(done => setImmediate(done)); };

class FakeServer extends EventEmitter {
  constructor(listener) { super(); this.listener = listener; }
  listen(port, host, callback) { process.nextTick(callback); return this; }
  address() { return { port: 8795 }; }
  close(callback) { process.nextTick(callback); return this; }
}

function fakeWatch() {
  const all = [];
  const watch = (path, options, listener) => {
    const entry = { path, listener, closed: false };
    all.push(entry);
    return { close() { entry.closed = true; }, on() { return this; } };
  };
  const live = () => all.filter(entry => !entry.closed);
  return { watch, live, paths: () => live().map(entry => entry.path).sort(), fire(path) { for (const entry of live().filter(item => item.path === path)) entry.listener('rename', 'x'); } };
}

const ipadDocument = (patch = {}) => {
  const { udid, model } = loadDevices({}).ios;
  return { result: { devices: [{ identifier: 'IPAD', hardwareProperties: { udid, reality: 'physical', productType: model }, connectionProperties: { pairingState: 'paired', tunnelState: 'connected', transportType: 'wired' }, deviceProperties: { name: 'iPad', developerModeStatus: 'enabled', bootState: 'booted', ...patch } }] } };
};

const respond = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': status < 300 ? 'application/json' : 'application/problem+json' } });

const exchange = (method, url, body) => {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
  const req = { method, url, headers: {}, async *[Symbol.asyncIterator]() { for (const chunk of chunks) yield chunk; } };
  const res = { head: null, text: null, writeHead(status, headers) { this.head = { status, headers }; }, end(text) { this.text = text; } };
  return { req, res };
};

// The Mac, started with a fake watch and a mocked setTimeout. `transport` answers the agent's calls (default: the seed for `GET /resources`, a
// recorded 200 for a push); `pushes` are the bodies it was sent, in order.
async function mac({ transport, key = 'mac', ipad: first = {}, start = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'host-agent-push-'));
  const env = { PATH: process.env.PATH, HOME: root, HUB_LOCK_DIR: join(root, 'locks'), HUB_EVENT_DIR: join(root, 'events') };
  mock.timers.enable({ apis: ['setTimeout'] });
  const clock = { t: FAR };
  const ipad = { patch: first, reads: 0 };
  const devices = structuredClone(loadDevices({}));
  const out = [];
  const err = [];
  const sent = [];
  const pushes = [];
  const signals = new EventEmitter();
  const watcher = fakeWatch();
  let server;
  const known = createKnown({ env, devices, qaDevices: () => [], log: { err: line => err.push(line) } });
  const transported = transport ?? (async args => (args.path === '/agent/push' ? respond(200, { applied: true }) : respond(200, { rev: 0, source: 'seed', resources: seed(devices, { qaDevices: () => [] }).resources })));
  const s = {
    root, env, clock, ipad, out, err, sent, pushes, watcher, signals, known,
    get mode() { return transported; },
    listener: () => server.listener,
    get: url => { const e = exchange('GET', url); return s.listener()(e.req, e.res).then(() => e.res); },
    post: (url, body) => { const e = exchange('POST', url, body); return s.listener()(e.req, e.res).then(() => e.res); },
    // The time of the debounce passes, and every push that started has ended.
    settle: async (ms = CHANGE_DEBOUNCE_MS) => { await flush(); mock.timers.tick(ms); await flush(); },
    cleanup: () => { mock.timers.reset(); rmSync(root, { recursive: true, force: true }); },
  };
  s.begin = async () => {
    s.running = await startHostAgent({
      env, policy, now: () => clock.t, devices, qaDevices: () => [], hostKey: () => key, inventory: noServer, devicectl: () => { ipad.reads += 1; return ipadDocument(ipad.patch); },
      versions: { node: '24.15.0' }, onPath: () => false, signals, known, hostId: () => 'MAC-UUID', boot: BOOT, watch: watcher.watch,
      log: { out: line => out.push(line), err: line => err.push(line) },
      request: async args => {
        sent.push(args);
        if (args.path === '/agent/push') pushes.push(structuredClone(args.body));
        return transported(args);
      },
      createServer: listener => { server = new FakeServer(listener); return server; },
    });
    await flush();
  };
  if (start) await s.begin();
  return s;
}

const pushLines = s => s.err.filter(line => line.startsWith('HUB_AGENT_PUSH_FAILED'));
const iPadReading = (state, at = FAR) => ({ resource: 'ios-lane', state, checked_at: iso(at), age_ms_at_receipt: 0, received_at: at, source: 'probe' });

// ---- the agent ----

test('start: one push within 250 ms, seq 1, the Mac\'s view and the iPad reading, in the AD-49 body, over hub-client\'s request shape', async () => {
  const s = await mac();
  try {
    await flush();
    assert.deepEqual(s.pushes, [], 'nothing before the debounce');
    mock.timers.tick(CHANGE_DEBOUNCE_MS - 1);
    await flush();
    assert.deepEqual(s.pushes, []);
    mock.timers.tick(1);
    await flush();
    assert.equal(s.pushes.length, 1);
    const [body] = s.pushes;
    assert.deepEqual(Object.keys(body), ['format', 'host', 'host_id', 'boot', 'seq', 'sent_at', 'status', 'readings', 'events']);
    assert.equal(body.format, 1);
    assert.equal(body.host, 'mac');
    assert.equal(body.host_id, 'MAC-UUID');
    assert.equal(body.boot, BOOT);
    assert.equal(body.seq, 1);
    assert.equal(body.sent_at, iso(FAR), 'the Mac\'s clock');
    assert.deepEqual(Object.keys(body.status), ['phones', 'locks', 'waiters', 'reservations', 'inventory', 'emulators']);
    assert.deepEqual(body.readings, [iPadReading('reachable')]);
    assert.equal(body.events, null);
    // The call is the one hub-client request shape: the Hub API's front door, POST, the path, the body.
    const call = s.sent.find(args => args.path === '/agent/push');
    assert.deepEqual(Object.keys(call).sort(), ['body', 'host', 'method', 'path']);
    assert.equal(call.host, 'linux');
    assert.equal(call.method, 'POST');
    assert.deepEqual(s.err, []);
    // The start made the dirs a watch needs and armed the whole watch set.
    assert.deepEqual(s.watcher.paths(), [s.env.HUB_EVENT_DIR, s.env.HUB_LOCK_DIR].sort());
  } finally { await s.running.stop(); s.cleanup(); }
});

test('lock write: a Lease on mac-ios is one push at most 250 ms after the notification, carrying the Mac clock\'s started_at; a burst is one push', async () => {
  const s = await mac();
  try {
    await s.settle();
    assert.equal(s.pushes.length, 1);
    s.clock.t = FAR + 30_000;
    await acquireLease('mac-ios', { holder: 'agent-a', why: 'lane', forMs: 600_000, id: 'l-mac-1', env: s.env, log: () => {}, now: () => s.clock.t, hostId: 'mac-host' });
    assert.equal(s.pushes.length, 1, 'a write alone pushes nothing: only a notification does');
    for (const path of [s.env.HUB_LOCK_DIR, s.env.HUB_LOCK_DIR, join(s.env.HUB_LOCK_DIR, 'mac-ios.lock'), s.env.HUB_EVENT_DIR, s.env.HUB_LOCK_DIR]) {
      s.watcher.fire(path);
      mock.timers.tick(20);
    }
    await flush();
    assert.equal(s.pushes.length, 1, 'inside the window');
    await s.settle();
    assert.equal(s.pushes.length, 2, 'a burst of notifications is one push');
    const [, second] = s.pushes;
    assert.equal(second.seq, 2);
    assert.equal(second.sent_at, iso(FAR + 30_000));
    const row = second.status.locks.find(lock => lock.lock === 'mac-ios');
    assert.ok(row, JSON.stringify(second.status.locks));
    assert.equal(row.started_at, iso(FAR + 30_000));
    assert.equal(row.resource, 'ios-lane');
    // The lock's own directory is now watched (the watch set re-armed on the notification).
    assert.ok(s.watcher.paths().includes(join(s.env.HUB_LOCK_DIR, 'mac-ios.lock')));
  } finally { await s.running.stop(); s.cleanup(); }
});

test('quiet: ten minutes with no notification is no push, however many requests read the status', async () => {
  const s = await mac();
  try {
    await s.settle();
    assert.equal(s.pushes.length, 1);
    const reads = s.ipad.reads;
    for (let minute = 1; minute <= 10; minute += 1) {
      s.clock.t += 60_000;
      mock.timers.tick(60_000);
      await flush();
    }
    assert.equal(s.pushes.length, 1);
    // A request that reads the iPad as the push carried it changes nothing either. The status reads the iPad only while a row names the lane,
    // so the lane is held first (written with no notification: the watcher is quiet).
    await acquireLease('mac-ios', { holder: 'agent-a', why: 'lane', forMs: 3_600_000, id: 'l-mac-q', env: s.env, log: () => {}, now: () => s.clock.t, hostId: 'mac-host' });
    assert.equal((await s.get('/status')).head.status, 200);
    await s.settle(10 * 60_000);
    assert.equal(s.pushes.length, 1);
    assert.ok(s.ipad.reads > reads, 'the request did read the iPad');
    assert.deepEqual(s.err, []);
  } finally { await s.running.stop(); s.cleanup(); }
});

test('a push that fails is one HUB_AGENT_PUSH_FAILED line and nothing more; the next notification pushes the next seq', async () => {
  for (const [what, failure] of [['the transport throws', async () => { throw new Error('ssh: connection refused'); }], ['the Hub API answers 503', async () => respond(503, { code: 'HUB_API_RESTARTING', detail: 'x' })]]) {
    const state = { fail: true };
    const s = await mac({ transport: async args => (args.path === '/agent/push' ? (state.fail ? failure() : respond(200, { applied: true })) : respond(200, { rev: 0, source: 'seed', resources: [] })) });
    try {
      await s.settle();
      assert.equal(s.pushes.length, 1, what);
      assert.equal(pushLines(s).length, 1, what);
      assert.match(pushLines(s)[0], what === 'the transport throws' ? /^HUB_AGENT_PUSH_FAILED ssh: connection refused$/ : /^HUB_AGENT_PUSH_FAILED the Hub API answered 503 HUB_API_RESTARTING$/);
      await s.settle(10 * 60_000);
      assert.equal(s.pushes.length, 1, `${what}: no retry on a timer`);
      assert.equal(pushLines(s).length, 1);
      state.fail = false;
      s.watcher.fire(s.env.HUB_LOCK_DIR);
      await s.settle();
      assert.equal(s.pushes.length, 2);
      assert.equal(s.pushes[1].seq, 2, 'the failed attempt used up seq 1');
      assert.equal(pushLines(s).length, 1);
    } finally { await s.running.stop(); s.cleanup(); }
  }
});

test('a push that fails stays owed: the next request to the agent pushes, a request when nothing is owed does not', async () => {
  const state = { fail: true };
  const s = await mac({ transport: async args => (args.path === '/agent/push' ? (state.fail ? respond(500, { code: 'HUB_API_ERROR' }) : respond(200, { applied: true })) : respond(200, { rev: 0, source: 'seed', resources: [] })) });
  try {
    await s.settle();
    assert.equal(s.pushes.length, 1);
    assert.equal((await s.get('/health')).head.status, 200);
    await s.settle();
    assert.equal(s.pushes.length, 2, 'the request after a failure pushed');
    assert.equal(pushLines(s).length, 2, 'and failed again: one line each');
    state.fail = false;
    await s.get('/health');
    await s.settle();
    assert.equal(s.pushes.length, 3);
    assert.equal(s.pushes[2].seq, 3);
    assert.equal(pushLines(s).length, 2);
    await s.get('/health');
    await s.settle(10 * 60_000);
    assert.equal(s.pushes.length, 3, 'nothing is owed any more: a request pushes nothing');
  } finally { await s.running.stop(); s.cleanup(); }
});

test('reading change: an iPad read on a request that differs from what the last push carried is one push with the new state', async () => {
  const s = await mac();
  try {
    await s.settle();
    assert.deepEqual(s.pushes[0].readings.map(reading => reading.state), ['reachable']);
    // A lane take's reachability gate reads the iPad on the request path. It reads `offline`: the request is refused (the iPad is away) and the change is pushed.
    s.ipad.patch = { bootState: 'shutdown' };
    s.clock.t += 5000;
    const away = await s.post('/leases', { resource: 'ipad', for_ms: 60_000, holder: 'agent-a', why: 'lane', require_reachable: true });
    assert.equal(away.head.status, 503, away.text);
    await s.settle();
    assert.equal(s.pushes.length, 2);
    assert.deepEqual(s.pushes[1].readings, [iPadReading('offline', FAR + 5000)]);
    // The push read the iPad itself (through the raw seam) and did not poke: nothing follows.
    await s.settle(10 * 60_000);
    assert.equal(s.pushes.length, 2);
    // The iPad is back: the same gate reads `reachable`, the take succeeds, and that change is pushed too.
    s.ipad.patch = {};
    const take = await s.post('/leases', { resource: 'ipad', for_ms: 60_000, holder: 'agent-a', why: 'lane', require_reachable: true });
    assert.equal(take.head.status, 200, take.text);
    await s.settle();
    assert.equal(s.pushes.length, 3);
    assert.equal(s.pushes[2].readings[0].state, 'reachable');
    // The lane is held now, so `GET /status` names it and reads the iPad: the same state is no change, a different one is.
    const reads = s.ipad.reads;
    await s.get('/status');
    await s.settle();
    assert.ok(s.ipad.reads > reads, 'the status read the iPad');
    assert.equal(s.pushes.length, 3);
    s.ipad.patch = { bootState: 'shutdown' };
    await s.get('/status');
    await s.settle();
    assert.equal(s.pushes.length, 4);
    assert.equal(s.pushes[3].readings[0].state, 'offline');
    assert.equal(s.pushes[3].status.locks[0].reachability.state, 'offline', 'the pushed view and its reading agree');
    assert.deepEqual(s.pushes.map(body => body.seq), [1, 2, 3, 4]);
  } finally { await s.running.stop(); s.cleanup(); }
});

test('a devicectl that throws on a request reads unknown, which differs from reachable and is pushed once', async () => {
  const root = mkdtempSync(join(tmpdir(), 'host-agent-push-throw-'));
  mock.timers.enable({ apis: ['setTimeout'] });
  const pushes = [];
  let server;
  const state = { throws: false };
  const env = { PATH: process.env.PATH, HOME: root, HUB_LOCK_DIR: join(root, 'locks'), HUB_EVENT_DIR: join(root, 'events') };
  const devices = structuredClone(loadDevices({}));
  const running = await startHostAgent({
    env, policy, now: () => FAR, devices, qaDevices: () => [], hostKey: () => 'mac', inventory: noServer, devicectl: () => { if (state.throws) throw new Error('xcrun missing'); return ipadDocument(); },
    versions: { node: '24.15.0' }, onPath: () => false, signals: new EventEmitter(), hostId: () => null, boot: BOOT, watch: fakeWatch().watch, log: { out: () => {}, err: () => {} },
    known: createKnown({ env, devices, qaDevices: () => [] }),
    request: async args => { if (args.path === '/agent/push') pushes.push(args.body); return respond(200, { rev: 0, source: 'seed', resources: seed(devices, { qaDevices: () => [] }).resources }); },
    createServer: listener => { server = new FakeServer(listener); return server; },
  });
  try {
    await flush();
    mock.timers.tick(CHANGE_DEBOUNCE_MS);
    await flush();
    assert.equal(pushes.length, 1);
    assert.equal(pushes[0].host_id, null);
    state.throws = true;
    const e = exchange('POST', '/leases', { resource: 'ipad', for_ms: 60_000, holder: 'agent-a', why: 'lane', require_reachable: true });
    await server.listener(e.req, e.res);
    assert.equal(e.res.head.status, 503, 'the gate reads unknown: the iPad is away');
    await flush();
    mock.timers.tick(CHANGE_DEBOUNCE_MS);
    await flush();
    assert.equal(pushes.length, 2);
    assert.equal(pushes[1].readings[0].state, 'unknown');
  } finally { await running.stop(); mock.timers.reset(); rmSync(root, { recursive: true, force: true }); }
});

test('pushes never overlap: a notification during a push waits for it, then one more push follows', async () => {
  let release;
  const gate = new Promise(done => { release = done; });
  let slow = true;
  const s = await mac({ transport: async args => {
    if (args.path !== '/agent/push') return respond(200, { rev: 0, source: 'seed', resources: [] });
    if (slow) { slow = false; await gate; }
    return respond(200, { applied: true });
  } });
  try {
    await s.settle();
    assert.equal(s.pushes.length, 1, 'the first push is in flight');
    s.watcher.fire(s.env.HUB_LOCK_DIR);
    s.watcher.fire(s.env.HUB_LOCK_DIR);
    mock.timers.tick(10 * CHANGE_DEBOUNCE_MS);
    await flush();
    assert.equal(s.pushes.length, 1, 'no second push while the first runs');
    release();
    await flush();
    await s.settle();
    assert.equal(s.pushes.length, 2);
    assert.deepEqual(s.pushes.map(body => body.seq), [1, 2]);
  } finally { await s.running.stop(); s.cleanup(); }
});

test('a stop closes the watchers and the pending debounce: nothing pushes after it', async () => {
  const s = await mac();
  try {
    assert.ok(s.watcher.live().length >= 2);
    await s.running.stop();
    assert.deepEqual(s.watcher.live(), []);
    s.watcher.fire(s.env.HUB_LOCK_DIR);
    await s.settle(10 * 60_000);
    assert.deepEqual(s.pushes, []);
  } finally { s.cleanup(); }
});

test('a host that does not know its key pushes nothing: one failure line, and it stays owed', async () => {
  const lines = [];
  const pusher = createPusher({ hostKey: () => { throw Object.assign(new Error('this host does not know which host it is'), { code: 'HUB_HOST_UNKNOWN' }); }, boot: BOOT, send: async () => { throw new Error('never sent'); }, status: async () => ({}), readings: async () => [], log: { err: line => lines.push(line) } });
  assert.equal(await pusher.push(), false);
  assert.deepEqual(lines, ['HUB_AGENT_PUSH_FAILED this host does not know which host it is']);
  assert.equal(pusher.owed(), true);
  assert.equal(await pusher.push(), false);
  assert.equal(lines.length, 2, 'every attempt is its own line, never a retry');
});

test('createPusher: a status that throws is null, readings that throw are null, seq rises per attempt, and the carried readings are those of the last body', async () => {
  const bodies = [];
  const pusher = createPusher({
    hostKey: () => 'mac', hostId: () => { throw new Error('no id'); }, boot: BOOT, now: () => FAR,
    send: async ({ body }) => { bodies.push(body); return respond(200, { applied: true }); },
    status: async () => { throw new Error('no status'); }, readings: async () => { throw new Error('no readings'); },
  });
  assert.equal(pusher.carried(), null);
  assert.equal(await pusher.push(), true);
  assert.deepEqual(bodies[0], { format: 1, host: 'mac', host_id: null, boot: BOOT, seq: 1, sent_at: iso(FAR), status: null, readings: null, events: null });
  assert.equal(pusher.carried(), null);
  const again = createPusher({
    hostKey: () => 'mac', boot: BOOT, now: () => FAR, send: async ({ body }) => { bodies.push(body); return respond(200, {}); },
    status: async () => ({ phones: [] }), readings: async () => [iPadReading('offline')],
  });
  await again.push();
  await again.push();
  assert.deepEqual(bodies.slice(1).map(body => body.seq), [1, 2]);
  assert.deepEqual([...again.carried()], [['ios-lane', 'offline']]);
});

test('createAgentWatch: with no watcher only a poke pushes, and a failing push is one line and never stops the debounce', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    let runs = 0;
    const lines = [];
    const watch = createAgentWatch({ watch: null, push: async () => { runs += 1; throw new Error('boom'); }, log: { err: line => lines.push(line) } });
    mock.timers.tick(10 * 60_000);
    await flush();
    assert.equal(runs, 0, 'nothing arms without a poke');
    watch.start();
    mock.timers.tick(CHANGE_DEBOUNCE_MS);
    await flush();
    assert.equal(runs, 1);
    assert.deepEqual(lines, ['HUB_AGENT_PUSH_FAILED boom']);
    watch.poke();
    mock.timers.tick(CHANGE_DEBOUNCE_MS);
    await flush();
    assert.equal(runs, 2);
    watch.close();
  } finally { mock.timers.reset(); }
});

// ---- end to end: the agent, the bridge, the Hub API ----

test('end to end: a Lease on the Mac reaches /status.hosts.mac within 250 ms with the Mac\'s started_at; the iPad reading is served; stale at 61 s, not at 60 s', async () => {
  const hubRoot = mkdtempSync(join(tmpdir(), 'hub-api-e2e-'));
  const hubEnv = { PATH: process.env.PATH, HOME: hubRoot, HUB_LOCK_DIR: join(hubRoot, 'locks'), HUB_EVENT_DIR: join(hubRoot, 'events'), HUB_ADB_SERVER_PORT: '5037' };
  const hub = { t: FAR + 5000 };
  const hubNow = () => hub.t;
  const readings = createReadings({ env: hubEnv, policy, now: hubNow, hostId: 'hub-host', hostKey: () => 'linux', probe: async () => new Map() });
  const pokes = [];
  const hubCtx = { env: hubEnv, policy, routes: ROUTES, now: hubNow, hostId: 'hub-host', devices: structuredClone(loadDevices({})), qaDevices: () => [], hostKey: () => 'linux', inventory: () => ({ adb_servers: [{ port: 5037, pid: 4242, cwd: null }], emulators: [], xvfb: [] }), adbWire: fakeWire({ listed: [] }), sleep: () => Promise.resolve(), log: { out: () => {}, err: () => {} }, readings, remotes: createRemotes(), onPush: () => pokes.push(hub.t) };
  const bridge = async ({ method, path, body }) => {
    const answer = await handle({ method, url: path, body }, hubCtx);
    return new Response(JSON.stringify(answer.body), { status: answer.status, headers: { 'content-type': String(answer.headers['Content-Type']) } });
  };
  const s = await mac({ transport: bridge });
  const hubGet = url => handle({ method: 'GET', url }, hubCtx);
  try {
    await s.settle();
    let status = await hubGet('/status');
    assert.deepEqual(Object.keys(status.body.hosts), ['linux', 'mac']);
    assert.deepEqual(status.body.hosts.mac.locks, []);
    s.clock.t = FAR + 20_000;
    await acquireLease('mac-ios', { holder: 'agent-a', why: 'lane', forMs: 600_000, id: 'l-mac-1', env: s.env, log: () => {}, now: () => s.clock.t, hostId: 'mac-host' });
    status = await hubGet('/status');
    assert.deepEqual(status.body.hosts.mac.locks, [], 'the Hub API has not heard yet');
    hub.t = FAR + 25_000;
    s.watcher.fire(s.env.HUB_LOCK_DIR);
    mock.timers.tick(CHANGE_DEBOUNCE_MS);
    await flush();
    assert.equal(pokes.length, 2, 'each applied push poked the change feed');
    status = await hubGet('/status');
    const [row] = status.body.hosts.mac.locks;
    assert.equal(row.lock, 'mac-ios');
    assert.equal(row.started_at, iso(FAR + 20_000), 'the Mac\'s clock');
    assert.deepEqual(status.body.stale, {});
    // The agent also asked the Hub API for the Registry through the same bridge, and the Hub API serves the pushed reading for the lane.
    const list = await hubGet('/resources');
    const lane = list.body.resources.find(resource => resource.id === 'ios-lane');
    assert.equal(lane.reachability.state, 'reachable');
    assert.equal(lane.reachability.source, 'probe');
    assert.equal(lane.reachability.age_ms_at_receipt, 0);
    // Staleness is the Hub API's clock since the receipt (hub time FAR + 25 s).
    hub.t = FAR + 25_000 + 60_000;
    assert.deepEqual((await hubGet('/status')).body.stale, {});
    hub.t += 1000;
    assert.deepEqual((await hubGet('/status')).body.stale, { mac: { since: iso(FAR + 25_000) } });
    assert.equal(s.pushes.length, 2, 'no push for the passing of time');
    assert.deepEqual(s.err, []);
  } finally { await s.running.stop(); s.cleanup(); rmSync(hubRoot, { recursive: true, force: true }); }
});

// ---- conformance ----

const AGENT_DIR = fileURLToPath(new URL('.', import.meta.url));
const read = name => readFileSync(join(AGENT_DIR, name), 'utf8');
const names = () => readdirSync(AGENT_DIR).filter(name => name.endsWith('.mjs') && !name.endsWith('.test.mjs'));
// `tokens` has comments and string contents blanked (nothing named in a comment or a string counts); `code` keeps strings, with the comment lines gone.
const sources = () => names().map(name => ({ name, tokens: strip(read(name)), code: read(name).split('\n').filter(line => !/^\s*\/\//.test(line)).join('\n') }));

test('conformance: nothing under tools/host-agent/ opens a socket, fetch or child process, or keeps a clock', () => {
  const found = sources();
  assert.deepEqual(found.map(file => file.name), ['known.mjs', 'push.mjs', 'routes.mjs', 'server.mjs', 'watch.mjs']);
  for (const { name, tokens: text, code } of found) {
    assert.ok(!/\bfetch\b/.test(text), `${name} uses fetch`);
    assert.ok(!/node:(http|https|net|child_process|dgram|tls)\b|\bchild_process\b/.test(code), `${name} imports a network or process module`);
    assert.ok(!/\b(setTimeout|setInterval|setImmediate)\b/.test(text), `${name} keeps a timer`);
  }
});

test('conformance: the push goes only through the injected send, which defaults to hub-client\'s request, and only push.mjs names the route', () => {
  const found = sources();
  const push = found.find(file => file.name === 'push.mjs').code;
  assert.match(push, /import \{ request as hubRequest \} from '\.\.\/hub-client\.mjs'/);
  assert.match(push, /const transport = send \?\? \(args => hubRequest\(args, \{ policy \}\)\)/);
  assert.equal((strip(push).match(/\btransport\(/g) ?? []).length, 1, 'one call site');
  assert.deepEqual(found.filter(file => file.code.includes('/agent/push')).map(file => file.name), ['push.mjs']);
  const server = found.find(file => file.name === 'server.mjs').code;
  assert.match(server, /createPusher\(\{[^}]*\bsend\b/s, 'the agent\'s one transport is the pusher\'s');
  // The only timer the agent's pushes use is the hub's one clock file.
  assert.match(found.find(file => file.name === 'watch.mjs').code, /from '\.\.\/hub-api\/stream\.mjs'/);
});
