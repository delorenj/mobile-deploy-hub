// Story 9.6 (AD-35): an asleep Mac reads `offline` and fails fast, hermetic. The Hub API is `handle()` over a temp lock and event dir; its transport is the real
// hub-client `request` with a fake `sshImpl` (a failure is a stderr line and exit 255; success is the real `relay()` with a `fetchImpl` bridged into the Host
// Agent's `handle()`), fake timers and a fake clock. No port, ssh, adb or live host is touched, and nothing here starts a timer of its own.
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadDevices } from '../ci/lib/devices.mjs';
import { readEvents } from '../ci/lib/events.mjs';
import { processStart } from '../ci/lib/lock.mjs';
import { loadPolicy } from '../ci/lib/policy.mjs';
import { hermetic } from '../ci/test-fixtures.mjs';
import { fakeWire } from '../device/wire-fixtures.mjs';
import { FORWARD_HEADER, relay } from '../hub-client.mjs';
import { createKnown } from '../host-agent/known.mjs';
import { AGENT_ROUTES } from '../host-agent/routes.mjs';
import { createPeers, failureReason, isContact, isUnreached, offlineView } from './peers.mjs';
import { createReadings } from './readings.mjs';
import { createRemotes } from './remotes.mjs';
import { ROUTES, handle } from './routes.mjs';
import { startHubApi } from './server.mjs';
import { CHANGE_DEBOUNCE_MS } from './stream.mjs';

hermetic();

const policy = loadPolicy().policy;
const T0 = Date.parse('2026-11-26T10:00:00Z');
const SEC = 1000;
const MIN = 60_000;
const WINDOW = 5 * policy.registry.reachability_max_age_s * SEC;
const iso = ms => new Date(ms).toISOString();
const BOOT = 'b0b0b0b0b0b0';
const HEADER = FORWARD_HEADER.toLowerCase();
const flush = async (rounds = 25) => { for (let round = 0; round < rounds; round += 1) await new Promise(done => setImmediate(done)); };
const serverUp = () => ({ adb_servers: [{ port: 5037, pid: 4242, cwd: null }], emulators: [], xvfb: [] });
const problemOf = answer => [answer.status, answer.body.code, answer.body.exit, answer.body.reason];
const LEASE = { for_ms: 30 * MIN, holder: 'jarad@big-chungus', why: 'ipad proof' };

const REFUSED = 'ssh: connect to host mac port 22: Connection refused';
const TIMED_OUT = 'ssh: connect to host mac port 22: Operation timed out';
const OTHER = 'Permission denied (publickey).';

const macView = () => ({
  phones: [], locks: [{ lock: 'mac-ios', device: null, kind: 'lease', started_at: iso(T0 - 5000), resource: 'ios-lane', reachability: { state: 'reachable', checked_at: iso(T0), age_ms: 0, stale: false } }],
  waiters: [], reservations: [], inventory: { adb_servers: [] }, emulators: [],
});
const pushBody = (extra = {}) => ({
  format: 1, host: 'mac', host_id: 'MAC-UUID', boot: BOOT, seq: 1, sent_at: iso(T0 - 1000), status: macView(),
  readings: [{ resource: 'ios-lane', state: 'reachable', checked_at: iso(T0), age_ms_at_receipt: 0, received_at: T0, source: 'probe' }], events: null, ...extra,
});

// Timers the test never fires: each set is recorded.
function fakeTimers() {
  const t = { intervals: [], timeouts: [] };
  t.setInterval = (fn, ms) => { const handle = { fn, ms }; t.intervals.push(handle); return handle; };
  t.clearInterval = () => {};
  t.setTimeout = (fn, ms) => { const handle = { fn, ms, refresh() { return this; } }; t.timeouts.push(handle); return handle; };
  t.clearTimeout = () => {};
  return t;
}

function sshChild() {
  const child = new EventEmitter();
  Object.assign(child, { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), killed: false });
  child.kill = () => { child.killed = true; };
  return child;
}
const wordsOf = command => [...command.matchAll(/'((?:[^']|'\\'')*)'/g)].map(match => match[1].replaceAll("'\\''", "'"));

// The Hub API (`linux`) and the Mac's Host Agent, each with its own lock dir. `ssh.mode` is what the ssh to the Mac does: 'up' runs the real relay into the
// agent's `handle()`, anything else is a failure whose last stderr line is that text.
function world({ stream = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'unreachable-'));
  const devices = structuredClone(loadDevices({}));
  const sideEnv = name => ({ PATH: process.env.PATH, HOME: join(root, name), HUB_LOCK_DIR: join(root, name, 'locks'), HUB_EVENT_DIR: join(root, name, 'events'), HUB_ADB_SERVER_PORT: '5037' });
  const clock = { t: T0 };
  const now = () => clock.t;
  const logged = [];
  const log = { out: () => {}, err: line => logged.push(line) };
  const timers = fakeTimers();
  const known = createKnown({ env: sideEnv('mac'), devices, qaDevices: () => [] });
  const mac = {
    policy, now, devices, qaDevices: () => [], log, env: sideEnv('mac'), routes: AGENT_ROUTES, hostKey: () => 'mac', known,
    devicectl: () => ({ result: { devices: [] } }), inventory: () => ({ adb_servers: [], emulators: [], xvfb: [] }),
  };
  const spawned = [];
  const ssh = { mode: 'up' };
  const bridge = (url, init = {}) => handle({
    method: init.method, url: new URL(url).pathname, headers: Object.fromEntries(Object.entries(init.headers ?? {}).map(([name, value]) => [name.toLowerCase(), value])),
    body: init.body === undefined ? undefined : JSON.parse(init.body), signal: init.signal,
  }, mac).then(answer => new Response(answer.body === undefined ? null : JSON.stringify(answer.body), { status: answer.status, headers: { 'content-type': answer.status >= 400 ? 'application/problem+json' : 'application/json' } }));
  const sshImpl = argv => {
    spawned.push(argv);
    const child = sshChild();
    if (ssh.mode !== 'up') {
      setImmediate(() => { child.stderr.write(`${ssh.mode}\n`); setImmediate(() => setImmediate(() => child.emit('close', 255))); });
      return child;
    }
    const [, , , method, path, door] = wordsOf(argv.at(-1));
    const done = relay({ method, path, door, stdin: child.stdin, stdout: child.stdout, policy, hostKey: () => 'mac', fetchImpl: bridge, timers });
    done.then(code => { child.stdout.once('end', () => child.emit('close', code)); child.stdout.end(); });
    return child;
  };
  const linuxEnv = sideEnv('linux');
  const readings = createReadings({ env: linuxEnv, policy, now, hostId: 'linux-host', hostKey: () => 'linux', probe: async () => new Map() });
  const peers = createPeers({ env: linuxEnv, now, hostId: 'linux-host', policy, log: log.err });
  const pokes = [];
  const linux = {
    policy, now, devices, qaDevices: () => [], log, env: linuxEnv, routes: ROUTES, hostId: 'linux-host', hostKey: () => 'linux', sshImpl, timers,
    inventory: serverUp, adbWire: fakeWire({ listed: [] }), sleep: () => Promise.resolve(), readings, remotes: createRemotes(), peers, onPeerChange: () => pokes.push(clock.t),
  };
  return {
    root, clock, linux, mac, ssh, spawned, logged, pokes, peers, timers,
    lease: (extra = {}) => handle({ method: 'POST', url: '/leases', body: { ...LEASE, resource: 'ipad', ...extra } }, linux),
    release: id => handle({ method: 'POST', url: `/leases/${id}/release`, body: { holder: LEASE.holder, resource: 'ios-lane' } }, linux),
    push: (extra, more) => handle({ method: 'POST', url: '/agent/push', body: pushBody(extra) }, { ...linux, ...more }),
    status: () => handle({ method: 'GET', url: '/status' }, linux),
    resources: () => handle({ method: 'GET', url: '/resources' }, linux),
    lane: async () => (await handle({ method: 'GET', url: '/resources' }, linux)).body.resources.find(resource => resource.id === 'ios-lane'),
    events: () => [...readEvents({ env: linuxEnv })].filter(event => event.event === 'host-reachability'),
    macLock: () => existsSync(join(mac.env.HUB_LOCK_DIR, 'mac-ios.lock')),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}
const shape = event => ({ host: event.host, from: event.from, to: event.to, reason: event.reason });

test('first failure: 503 HUB_DEVICE_AWAY exit 75 host-unreachable, one host-reachability event, and ios-lane reads offline from the host', async () => {
  const w = world();
  try {
    w.ssh.mode = REFUSED;
    const answer = await w.lease();
    assert.deepEqual(problemOf(answer), [503, 'HUB_DEVICE_AWAY', 75, 'host-unreachable']);
    assert.equal(w.spawned.length, 1);
    assert.deepEqual(w.events().map(shape), [{ host: 'mac', from: null, to: 'unreachable', reason: 'refused' }]);
    assert.deepEqual(w.peers.mark('mac'), { since: T0, failed_at: T0, reason: 'refused' });
    assert.ok(!Object.hasOwn(answer.body, 'alias'), 'the cause text is not a problem member');
    w.clock.t = T0 + 20 * SEC;
    const lane = await w.lane();
    assert.deepEqual([lane.reachability.state, lane.reachability.source, lane.reachability.checked_at], ['offline', 'host', iso(T0)]);
    assert.equal(lane.reachability.age_ms_at_receipt, 20 * SEC);
    assert.equal(w.pokes.length, 1, 'the mark pokes the change feed once');
  } finally { w.cleanup(); }
});

test('fast fail: the same request 10 s later is 503 at once, spawns no ssh, names the connect timeout, writes no event and no ticket', async () => {
  const w = world();
  try {
    w.ssh.mode = REFUSED;
    await w.lease();
    w.ssh.mode = 'up';
    w.clock.t = T0 + 10 * SEC;
    const again = await w.lease();
    assert.deepEqual(problemOf(again), [503, 'HUB_DEVICE_AWAY', 75, 'host-unreachable']);
    assert.equal(w.spawned.length, 1, 'no ssh was spawned');
    assert.match(again.body.detail, /the mac host is unreachable since 2026-11-26T10:00:00\.000Z \(refused\)/);
    assert.match(again.body.detail, new RegExp(`allowed at ${iso(T0 + WINDOW)}`));
    assert.match(again.body.detail, /connect timeout 5 s/);
    assert.equal(w.events().length, 1);
    assert.equal(w.macLock(), false, 'nothing written on the Mac');
    assert.equal(existsSync(join(w.mac.env.HUB_LOCK_DIR, 'mac-ios.queue')), false);
    // Every Hold route on that host fails the same way, whatever it does.
    const released = await w.release('l-aaaaaaaaaaaa');
    assert.deepEqual(problemOf(released), [503, 'HUB_DEVICE_AWAY', 75, 'host-unreachable']);
    assert.equal(w.spawned.length, 1);
  } finally { w.cleanup(); }
});

test('window edge: 5 x the limit minus 1 s fails at once; at exactly 5 x the limit ssh is tried', async () => {
  const w = world();
  try {
    w.ssh.mode = REFUSED;
    await w.lease();
    assert.equal(WINDOW, 300 * SEC);
    w.clock.t = T0 + WINDOW - SEC;
    await w.lease();
    assert.equal(w.spawned.length, 1);
    w.clock.t = T0 + WINDOW;
    await w.lease();
    assert.equal(w.spawned.length, 2, 'tried at exactly 5 x the limit');
  } finally { w.cleanup(); }
});

test('retry fails again: 503, no event, failed_at moves (since stays) so the next try is a window later', async () => {
  const w = world();
  try {
    w.ssh.mode = REFUSED;
    await w.lease();
    w.ssh.mode = TIMED_OUT;
    w.clock.t = T0 + WINDOW;
    const answer = await w.lease();
    assert.equal(answer.status, 503);
    assert.equal(w.events().length, 1, 'no second event');
    assert.deepEqual(w.peers.mark('mac'), { since: T0, failed_at: T0 + WINDOW, reason: 'timeout' });
    assert.equal(w.pokes.length, 2, 'a retry that fails again moves failed_at and reason, so it pokes the feed too');
    w.clock.t = T0 + 2 * WINDOW - SEC;
    await w.lease();
    assert.equal(w.spawned.length, 2);
    w.clock.t = T0 + 2 * WINDOW;
    await w.lease();
    assert.equal(w.spawned.length, 3);
  } finally { w.cleanup(); }
});

test('recovery by request: at the window the Mac answers, the Lease is 200, one event reason call, and ios-lane shows the stored reading again', async () => {
  const w = world();
  try {
    assert.equal((await w.push()).body.applied, true);
    w.ssh.mode = REFUSED;
    w.clock.t = T0 + 5 * SEC;
    await w.lease();
    assert.equal((await w.lane()).reachability.state, 'offline');
    w.ssh.mode = 'up';
    w.clock.t = T0 + 5 * SEC + WINDOW;
    const taken = await w.lease({ id: 'l-aaaaaaaaaaaa' });
    assert.equal(taken.status, 200, JSON.stringify(taken.body));
    assert.equal(w.macLock(), true);
    assert.deepEqual(w.events().map(shape), [
      { host: 'mac', from: 'reachable', to: 'unreachable', reason: 'refused' },
      { host: 'mac', from: 'unreachable', to: 'reachable', reason: 'call' },
    ]);
    assert.equal(w.peers.mark('mac'), null);
    const lane = await w.lane();
    assert.deepEqual([lane.reachability.state, lane.reachability.source], ['reachable', 'probe'], 'the stored reading, unchanged');
    assert.equal(w.pokes.length, 2, 'marked and restored');
    // Contact while not marked is no event.
    await w.release('l-aaaaaaaaaaaa');
    assert.equal(w.events().length, 2);
  } finally { w.cleanup(); }
});

test('recovery by push: even a duplicate seq restores with one event reason push, and the next request is tried at once', async () => {
  const w = world();
  try {
    await w.push({ seq: 3 });
    w.ssh.mode = REFUSED;
    await w.lease();
    assert.equal(w.pokes.length, 1);
    w.clock.t = T0 + 30 * SEC;
    const duplicate = await w.push({ seq: 3 });
    assert.equal(duplicate.body.applied, false);
    assert.deepEqual(w.events().map(shape).at(-1), { host: 'mac', from: 'unreachable', to: 'reachable', reason: 'push' });
    assert.equal(w.events().length, 2);
    assert.equal(w.pokes.length, 2);
    w.ssh.mode = 'up';
    const taken = await w.lease();
    assert.equal(taken.status, 200, JSON.stringify(taken.body));
    assert.equal(w.spawned.length, 2, 'the next request was tried at once');
    assert.equal(w.events().length, 2, 'no event for contact while not marked');
  } finally { w.cleanup(); }
});

test('recovery by a gap-failed push: a 409 HUB_REPLICA_GAP is still contact and restores with one event reason push (Story 10.1)', async () => {
  const w = world();
  try {
    await w.push({ seq: 3 });
    w.ssh.mode = REFUSED;
    await w.lease();
    assert.equal(w.events().length, 1, 'marked unreachable');
    w.clock.t = T0 + 30 * SEC;
    const gap = await w.push({ seq: 4, events: { month: '2026-11', from_offset: 5, lines: ['{"format":1}\n'] } });
    assert.equal(gap.status, 409, JSON.stringify(gap.body));
    assert.equal(gap.body.code, 'HUB_REPLICA_GAP');
    assert.deepEqual(w.events().map(shape).at(-1), { host: 'mac', from: 'unreachable', to: 'reachable', reason: 'push' });
    assert.equal(w.events().length, 2);
    assert.equal(w.pokes.length, 2);
    assert.equal(w.peers.mark('mac'), null, 'the mark is cleared');
  } finally { w.cleanup(); }
});

test('status while marked: hosts.mac is the last view with every row reading offline, stale.mac carries both sinces; a clear shows the view unchanged; the view is never mutated', async () => {
  const w = world();
  try {
    await w.push();
    w.ssh.mode = REFUSED;
    w.clock.t = T0 + 40 * SEC;
    await w.lease();
    w.clock.t = T0 + 50 * SEC;
    const marked = await w.status();
    const row = marked.body.hosts.mac.locks[0];
    assert.equal(row.reachability.state, 'offline');
    assert.equal(row.reachability.checked_at, iso(T0 + 40 * SEC));
    assert.equal(row.reachability.age_ms, 10 * SEC);
    assert.deepEqual(marked.body.hosts.mac.locks[0].lock, 'mac-ios');
    assert.deepEqual(marked.body.stale, { mac: { since: iso(T0), unreachable: { since: iso(T0 + 40 * SEC), reason: 'refused' } } });
    w.clock.t = T0 + 55 * SEC;
    await w.push({ seq: 2 });
    const cleared = await w.status();
    assert.deepEqual(cleared.body.hosts.mac, macView(), 'the pushed view shows again, unchanged');
    assert.deepEqual(cleared.body.stale, {});
  } finally { w.cleanup(); }
});

test('a marked host with no pushed view gets the stale key with since null and no hosts entry', async () => {
  const w = world();
  try {
    w.ssh.mode = REFUSED;
    await w.lease();
    const status = await w.status();
    assert.deepEqual(Object.keys(status.body.hosts), ['linux']);
    assert.deepEqual(status.body.stale, { mac: { since: null, unreachable: { since: iso(T0), reason: 'refused' } } });
  } finally { w.cleanup(); }
});

test('never contacted: a fresh push has no stale key, an old one has {since, unreachable: null}', async () => {
  const w = world();
  try {
    await w.push();
    assert.deepEqual((await w.status()).body.stale, {});
    w.clock.t = T0 + 61 * SEC;
    assert.deepEqual((await w.status()).body.stale, { mac: { since: iso(T0), unreachable: null } });
    assert.equal(w.events().length, 0);
  } finally { w.cleanup(); }
});

test('a far problem is contact, not a failure: the Mac answering offline for the iPad is relayed, marks nothing and writes no event; it also restores a marked host', async () => {
  const w = world();
  try {
    const { udid, model } = loadDevices({}).ios;
    const ipad = bootState => ({ result: { devices: [{ identifier: 'IPAD', hardwareProperties: { udid, reality: 'physical', productType: model }, connectionProperties: { pairingState: 'paired', tunnelState: 'connected', transportType: 'wired' }, deviceProperties: { name: 'iPad', developerModeStatus: 'enabled', bootState } }] } });
    w.mac.devicectl = () => ipad('shutdown');
    const away = await w.lease({ id: 'l-vvvvvvvvvvvv', require_reachable: true });
    assert.deepEqual(problemOf(away), [503, 'HUB_DEVICE_AWAY', 75, 'offline']);
    assert.equal(w.peers.mark('mac'), null);
    assert.equal(w.events().length, 0);
    assert.equal(w.pokes.length, 0);
    // Marked by a failed call, then a window later the Mac answers with its own problem: that is contact.
    w.ssh.mode = REFUSED;
    await w.lease();
    w.ssh.mode = 'up';
    w.clock.t = T0 + WINDOW;
    const again = await w.lease({ id: 'l-vvvvvvvvvvvv', require_reachable: true });
    assert.deepEqual(problemOf(again), [503, 'HUB_DEVICE_AWAY', 75, 'offline']);
    assert.equal(w.peers.mark('mac'), null);
    assert.deepEqual(w.events().map(shape).at(-1), { host: 'mac', from: 'unreachable', to: 'reachable', reason: 'call' });
  } finally { w.cleanup(); }
});

test('the failure reason is one word: refused, timeout or ssh-error', async () => {
  for (const [stderr, reason] of [[REFUSED, 'refused'], [TIMED_OUT, 'timeout'], [OTHER, 'ssh-error']]) {
    const w = world();
    try {
      w.ssh.mode = stderr;
      await w.lease();
      assert.equal(w.events()[0].reason, reason, stderr);
    } finally { w.cleanup(); }
  }
  assert.deepEqual(['the mac host did not answer: ECONNREFUSED', 'no answer within 40 s', 'ETIMEDOUT', 'ssh did not start (ENOENT)', undefined].map(detail => failureReason({ detail })), ['refused', 'timeout', 'timeout', 'ssh-error', 'ssh-error']);
});

test('what is a failure and what is contact: ssh-leg AWAY marks, api answers and UNKNOWN restore, anything else does neither', () => {
  const away = { code: 'HUB_DEVICE_AWAY', api: false };
  assert.deepEqual([isUnreached(away), isContact(away)], [true, false]);
  const far = { code: 'HUB_DEVICE_AWAY', api: true };
  assert.deepEqual([isUnreached(far), isContact(far)], [false, true]);
  const unknown = { code: 'HUB_API_UNKNOWN', api: false };
  assert.deepEqual([isUnreached(unknown), isContact(unknown)], [false, true]);
  assert.deepEqual([isUnreached({ code: 'HUB_USAGE' }), isContact({ code: 'HUB_USAGE' }), isUnreached(null), isContact(undefined)], [false, false, false, false]);
});

test('an aborted request neither marks nor restores', async () => {
  const w = world();
  try {
    w.ssh.mode = REFUSED;
    const controller = new AbortController();
    const pending = handle({ method: 'POST', url: '/leases', body: { ...LEASE, resource: 'ipad' }, signal: controller.signal }, w.linux);
    controller.abort(new Error('the client went away'));
    await pending;
    assert.equal(w.peers.mark('mac'), null);
    assert.equal(w.events().length, 0);
  } finally { w.cleanup(); }
});

test('a failed event write is one HUB_API_REACHABILITY_FAILED line, the state still changes and the answer does not; a throwing poke is logged, never answered', async () => {
  const w = world();
  try {
    const peers = createPeers({ env: w.linux.env, now: w.linux.now, hostId: 'x', policy, log: w.logged.push.bind(w.logged), note: () => { throw new Error('disk full'); } });
    const ctx = { ...w.linux, peers, onPeerChange: () => { throw new Error('feed closed'); } };
    w.ssh.mode = REFUSED;
    const answer = await handle({ method: 'POST', url: '/leases', body: { ...LEASE, resource: 'ipad' } }, ctx);
    assert.deepEqual(problemOf(answer), [503, 'HUB_DEVICE_AWAY', 75, 'host-unreachable']);
    assert.equal(peers.mark('mac').reason, 'refused');
    assert.deepEqual(w.logged.filter(line => line.startsWith('HUB_API_REACHABILITY_FAILED')), ['HUB_API_REACHABILITY_FAILED disk full']);
    assert.deepEqual(w.logged.filter(line => line.startsWith('HUB_API_ERROR peer')), ['HUB_API_ERROR peer feed closed']);
  } finally { w.cleanup(); }
});

test('a bare handle() with no ctx.peers keeps its marks per context', async () => {
  const w = world();
  try {
    const { peers, onPeerChange, ...bare } = w.linux;
    w.ssh.mode = REFUSED;
    const send = ctx => handle({ method: 'POST', url: '/leases', body: { ...LEASE, resource: 'ipad' } }, ctx);
    await send(bare);
    await send(bare);
    assert.equal(w.spawned.length, 1, 'the second call failed at once');
    await send({ ...bare });
    assert.equal(w.spawned.length, 2, 'another context is another store');
  } finally { w.cleanup(); }
});

test('the overlay covers every Resource the Registry places on the host', async () => {
  const w = world();
  try {
    w.ssh.mode = REFUSED;
    await w.lease();
    const answer = await w.resources();
    const onMac = answer.body.resources.filter(resource => resource.host === 'mac');
    assert.ok(onMac.length >= 1);
    for (const resource of onMac) assert.deepEqual([resource.reachability.state, resource.reachability.source], ['offline', 'host'], resource.id);
    for (const resource of answer.body.resources.filter(entry => entry.host !== 'mac')) assert.notEqual(resource.reachability.source, 'host', resource.id);
  } finally { w.cleanup(); }
});

test('offlineView copies the view, replaces only non-null reachability rows and never mutates the original', () => {
  const view = { ...macView(), phones: [{ device: 'p', resource: null, reachability: null }], waiters: [{ lock: 'x', reachability: { state: 'reachable' } }], inventory: { adb_servers: [] } };
  const before = structuredClone(view);
  const reading = createPeers({ policy, now: () => T0 });
  reading.failed('mac', { at: T0 - 5000, reason: 'refused' });
  const shown = offlineView(view, reading.offlineReading('mac'), { now: T0, maxAgeS: 60 });
  assert.deepEqual(view, before);
  assert.deepEqual(shown.waiters[0].reachability, { state: 'offline', checked_at: iso(T0 - 5000), age_ms: 5000, stale: false });
  assert.equal(shown.phones[0].reachability, null);
  assert.deepEqual(shown.inventory, view.inventory);
});

test('no timer anywhere: the only timers are the hub-client seam\'s (the call bound and the relay idle timeout); the global setTimeout and setInterval are never called', async () => {
  const w = world();
  const setTimeoutSpy = mock.method(globalThis, 'setTimeout');
  const setIntervalSpy = mock.method(globalThis, 'setInterval');
  try {
    w.ssh.mode = REFUSED;
    await w.lease();
    w.clock.t = T0 + WINDOW;
    w.ssh.mode = 'up';
    await w.lease();
    assert.ok(w.timers.timeouts.length > 0, 'the seam is live');
    assert.ok(w.timers.timeouts.every(timer => timer.ms >= 1000), 'only the call bound and the relay idle timeout');
    assert.equal(setTimeoutSpy.mock.callCount(), 0);
    assert.equal(setIntervalSpy.mock.callCount(), 0);
  } finally {
    setTimeoutSpy.mock.restore();
    setIntervalSpy.mock.restore();
    w.cleanup();
  }
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

test('stream: a mark change and a restore are each a status frame through startHubApi', async () => {
  const root = mkdtempSync(join(tmpdir(), 'unreachable-stream-'));
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
  const failing = () => {
    const child = sshChild();
    setImmediate(() => { child.stderr.write(`${REFUSED}\n`); setImmediate(() => setImmediate(() => child.emit('close', 255))); });
    return child;
  };
  let running;
  try {
    const real = processStart(process.pid);
    running = await startHubApi({
      env, policy, now: () => T0, hostId: 'test-host', devices: structuredClone(loadDevices({})), qaDevices: () => [], versions: { node: '24.15.0' }, onPath: () => true, signals, hostKey: () => 'linux',
      sshImpl: failing, timers: fakeTimers(),
      log: { out: () => {}, err: () => {} }, createServer: handler => new FakeServer(handler), watch: () => ({ close() {}, on() { return this; } }),
      observe: async () => ({ inventory: { adb_servers: [{ port: 5037, pid: 4242, managed: true, cwd: null }], emulators: [], xvfb: [] }, adb: { port: 5037, note: null, listed: [], serials: new Map() }, starts: new Map([[process.pid, real]]), live_starts: new Map() }),
    });
    await flush();
    const sink = await call('/stream');
    assert.equal(framesOf(sink)[0].event, 'ready');

    const failed = await call('/leases', 'POST', { ...LEASE, resource: 'ipad' });
    assert.equal(failed.head.status, 503, failed.text);
    mock.timers.tick(CHANGE_DEBOUNCE_MS);
    await flush();
    const marked = framesOf(sink).slice(1).filter(frame => frame.event === 'status');
    assert.equal(marked.length, 1);
    assert.deepEqual(marked[0].data.status.stale, { mac: { since: null, unreachable: { since: iso(T0), reason: 'refused' } } });

    const pushed = await call('/agent/push', 'POST', pushBody());
    assert.equal(JSON.parse(pushed.text).applied, true);
    mock.timers.tick(CHANGE_DEBOUNCE_MS);
    await flush();
    const restored = framesOf(sink).filter(frame => frame.event === 'status').slice(1);
    assert.equal(restored.length, 1);
    assert.deepEqual(restored[0].data.status.stale, {});
  } finally {
    signals.emit('SIGTERM');
    await running?.stopped;
    mock.timers.reset();
    rmSync(root, { recursive: true, force: true });
  }
});
