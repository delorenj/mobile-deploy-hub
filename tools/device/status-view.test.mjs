// Story 5.4: `claims.statusView` and the status it feeds, driven hermetically: temp lock and event dirs, an injected adb wire, devicectl,
// host key and clock. Nothing here reaches a real adb server (5037), devicectl or a real host key; the child-process cases talk to a
// TCP fake on a free port.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDevices } from '../ci/lib/devices.mjs';
import { acquireLease, buildTicket, reserve } from '../ci/lib/lock.mjs';
import { loadPolicy } from '../ci/lib/policy.mjs';
import { hermetic } from '../ci/test-fixtures.mjs';
import * as claims from './claims.mjs';
import { main } from './hub-device.mjs';
import { createAdbWire, parseDevicesLong } from './adb-wire.mjs';
import { fakeAdbServer, fakeHub, fakeWire } from './wire-fixtures.mjs';

hermetic();

const tool = fileURLToPath(new URL('./hub-device.mjs', import.meta.url));
const S26 = 'R5GL43A7PCH';
const S24 = 'R5CX31AEJDA';
const T0 = Date.now();
const iso = ms => new Date(ms).toISOString();
const usbId = serial => `adb-${serial}-zz._adb-tls-connect._tcp`;
const phone = (serial, state = 'device') => ({ id: usbId(serial), state, model: serial === S26 ? 'SM_S948U' : 'SM_S928U' });
const bothUp = [phone(S24), phone(S26)];
const serverUp = () => ({ adb_servers: [{ port: 5037, pid: 4242, cwd: null }], emulators: [], xvfb: [] });
const serverDown = () => ({ adb_servers: [], emulators: [], xvfb: [] });
const policy = () => loadPolicy().policy;

// A sleep that runs a hundredth of the time: the 5s probe bound fires fast when something hangs, and every call is recorded with its signal.
function quickSleep() {
  const calls = [];
  const sleep = (ms, signal) => new Promise(done => {
    calls.push({ ms, signal });
    if (signal?.aborted) { done(); return; }
    const timer = setTimeout(done, ms / 100);   // 5s becomes 50ms and 1.5s 15ms: the bounds keep their order
    signal?.addEventListener('abort', () => { clearTimeout(timer); done(); }, { once: true });
  });
  return Object.assign(sleep, { calls });
}

function side({ wire = fakeWire({ listed: bothUp }), inventory = serverUp, devicectl, sleep = quickSleep(), settings = policy() } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'status-view-'));
  const adbCalls = join(root, 'adb-calls.log');
  const adbBinary = join(root, 'adb');
  writeFileSync(adbBinary, `#!/bin/sh\necho "$*" >> "${adbCalls}"\nexit 1\n`);
  chmodSync(adbBinary, 0o755);
  const env = { PATH: process.env.PATH, HOME: root, USER: 'tester', HUB_LOCK_DIR: join(root, 'locks'), HUB_EVENT_DIR: join(root, 'events'), HUB_DEVICE_POLL_MS: '5', HUB_ADB_SERVER_PORT: '5037', HUB_ADB: adbBinary };
  const factoryCalls = [];
  const adbFactory = (...args) => { factoryCalls.push(args); throw new Error('status must never build an adb client'); };
  const ctx = claims.createContext({ env, now: () => T0, sleep, adbFactory, adbWire: wire, devicectl, inventory, policy: settings, fleet: claims.loadFleet(env) });
  const cli = (argv, extra = {}) => runCli(env, argv, { adbFactory, adbWire: wire, devicectl, inventory, policy: settings, sleep, now: () => T0, hostKey: () => 'linux', ...extra });
  const rows = (view, list) => Object.fromEntries(view[list].map(row => [row.device ?? row.lock, row]));
  return {
    root, env, ctx, wire, cli, rows, sleep, adbFactory, factoryCalls,
    adbRan: () => existsSync(adbCalls),
    view: (key = 'linux', options = { audience: 'local' }) => claims.statusView(key, options, ctx),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

async function runCli(env, argv, seams) {
  const out = [];
  const err = [];
  const code = await main(argv, { env, stdout: line => out.push(line), stderr: line => err.push(line), ...seams });
  return { code, out, err };
}

const allowed = ['host:version', 'host:devices-l'];
const wireOnly = requests => requests.every(request => allowed.includes(request) || /^host:transport:[^\s]+$/.test(request) || request === 'shell:getprop ro.serialno');

// ---- the shape ----

test('statusView keeps today\'s root keys and every v1a key in place, then adds resource and reachability to every row', async () => {
  const s = side();
  try {
    await acquireLease('adb', { holder: 'agent-a', why: 'device proof', forMs: 3_600_000, id: 'held', env: s.env, log: () => {}, now: () => T0 });
    mkdirSync(join(s.env.HUB_LOCK_DIR, 'adb.queue'), { recursive: true });
    const job = buildTicket('job', { env: { ...s.env, GITHUB_REPOSITORY: 'delorenj/gruvato', GITHUB_RUN_ID: '77', GITHUB_RUN_ATTEMPT: '1', GITHUB_JOB: 'android' }, requested: T0 });
    writeFileSync(join(s.env.HUB_LOCK_DIR, 'adb.queue', `${String(T0).padStart(15, '0')}-000001-00000001.json`), JSON.stringify(job));
    reserve('adb', { env: { ...s.env, GITHUB_REPOSITORY: 'delorenj/earshot', GITHUB_RUN_ID: '9' }, now: () => T0, policy: policy(), log: () => {} });
    const records = join(s.env.HUB_LOCK_DIR, 'emulators');
    mkdirSync(records, { recursive: true });
    writeFileSync(join(records, 'e-aaaaaaaaaaaa.json'), JSON.stringify({ lease_id: 'e-aaaaaaaaaaaa', slot: 'emulator-1', profile: 'default', serial: 'emulator-5554', console_port: 5554, adb_server_port: 15170, avd: { name: 'hub-a' }, created_at: iso(T0), pids: [] }));
    const view = await s.view();
    assert.deepEqual(Object.keys(view), ['phones', 'locks', 'waiters', 'reservations', 'inventory', 'emulators']);
    const v1a = {
      phones: ['device', 'lock', 'deploy', 'name', 'model', 'serial', 'held', 'holder', 'lease_id', 'why', 'expires_at', 'adb_id', 'repo', 'run', 'presence'],
      locks: ['lock', 'device', 'kind', 'stale', 'lease_id', 'holder', 'why', 'repo', 'run', 'pid', 'holder_pid', 'started_at', 'expires_at', 'phone', 'emulator'],
      waiters: ['lock', 'device', 'position', 'lease_id', 'holder', 'why', 'since', 'stale', 'kind', 'repo', 'run', 'job', 'eta'],
      reservations: ['lock', 'device', 'run_key', 'repo', 'run', 'place', 'blocking', 'grace', 'reserved_at', 'expires_at', 'stale'],
      emulators: ['lease_id', 'slot', 'profile', 'serial', 'console_port', 'adb_server_port', 'avd', 'created_at', 'pids'],
    };
    for (const [list, keys] of Object.entries(v1a)) {
      assert.ok(view[list].length > 0, `${list} has a row to check`);
      for (const row of view[list]) assert.deepEqual(Object.keys(row), [...keys, 'resource', 'reachability'], `${list} row keys`);
    }
    const strip = ({ resource, reachability, ...rest }) => rest;
    const [s24, s26] = view.phones;
    assert.deepEqual(strip(s24), { device: 's24', lock: 's24', deploy: false, name: 'S24', model: 'SM-S928U', serial: S24, held: 'free', holder: null, lease_id: null, why: null, expires_at: null, adb_id: null, repo: null, run: null, presence: 'reachable' });
    assert.deepEqual([s26.device, s26.held, s26.holder, s26.lease_id, s26.presence, s26.resource, s26.reachability.state], ['s26', 'lease', 'agent-a', 'held', 'reachable', 's26', 'reachable']);
    const adb = view.locks.find(entry => entry.lock === 'adb');
    assert.deepEqual([adb.device, adb.kind, adb.lease_id, adb.holder, adb.why, adb.stale, adb.resource], ['s26', 'lease', 'held', 'agent-a', 'device proof', false, 's26']);
    assert.deepEqual(view.waiters.map(waiter => [waiter.lock, waiter.position, waiter.kind, waiter.repo, waiter.run, waiter.job, waiter.resource]), [['adb', 1, 'job', 'delorenj/gruvato', '77', 'android', 's26']]);
    assert.deepEqual(view.reservations.map(entry => [entry.lock, entry.run_key, entry.resource]), [['adb', 'delorenj--earshot--9', 's26']]);
    assert.deepEqual(view.emulators.map(entry => [entry.lease_id, entry.slot, entry.resource]), [['e-aaaaaaaaaaaa', 'emulator-1', 'emulator']]);
    assert.deepEqual(view.emulators[0].reachability, { state: 'unknown', checked_at: null, age_ms: null, stale: true }, 'the emulator Pool has no transport yet: nobody checked');
    assert.deepEqual(Object.keys(view.inventory), ['adb_servers', 'emulators', 'xvfb']);
  } finally { s.cleanup(); }
});

// ---- the I/O matrix ----

test('a phone the wire lists as device is reachable, read at probe time with age 0 and not stale', async () => {
  const s = side();
  try {
    const view = await s.view('linux');
    const phones = s.rows(view, 'phones');
    for (const name of ['s24', 's26']) {
      assert.equal(phones[name].presence, 'reachable');
      assert.deepEqual(phones[name].reachability, { state: 'reachable', checked_at: iso(T0), age_ms: 0, stale: false }, name);
    }
    assert.deepEqual([phones.s24.resource, phones.s26.resource], ['s24', 's26']);
    assert.deepEqual(s.wire.requests, ['host:version', 'host:devices-l']);
    assert.equal(s.wire.opened[0].port, 5037);
    assert.ok(s.wire.opened[0].signal.aborted, 'the probe\'s sockets are closed when it is done');
    assert.ok(s.sleep.calls.every(call => call.signal.aborted), 'the probe\'s timer is cleared');
    assert.deepEqual(s.sleep.calls.map(call => call.ms), [5000], 'the whole probe is bounded at 5s');
  } finally { s.cleanup(); }
});

test('unauthorized and offline phones keep adb\'s word as presence and as reachability', async () => {
  const s = side({ wire: fakeWire({ listed: [phone(S24, 'unauthorized'), phone(S26, 'offline')] }) });
  try {
    const phones = s.rows(await s.view('linux'), 'phones');
    assert.deepEqual([phones.s24.presence, phones.s24.reachability.state], ['unauthorized', 'unauthorized']);
    assert.deepEqual([phones.s26.presence, phones.s26.reachability.state], ['offline', 'offline']);
    assert.equal(phones.s26.reachability.stale, false);
  } finally { s.cleanup(); }
});

test('a state adb has that the map does not know (recovery) is unknown, never reachable', async () => {
  const s = side({ wire: fakeWire({ listed: [phone(S24, 'recovery'), phone(S26)] }) });
  try {
    const phones = s.rows(await s.view('linux'), 'phones');
    assert.deepEqual([phones.s24.presence, phones.s24.reachability.state, phones.s24.reachability.stale], ['recovery', 'unknown', false]);
  } finally { s.cleanup(); }
});

test('a phone the wire does not list is absent', async () => {
  const s = side({ wire: fakeWire({ listed: [phone(S26)] }) });
  try {
    const phones = s.rows(await s.view('linux'), 'phones');
    assert.deepEqual([phones.s24.presence, phones.s24.reachability.state], ['absent', 'absent']);
    assert.deepEqual([phones.s26.presence, phones.s26.reachability.state], ['reachable', 'reachable']);
  } finally { s.cleanup(); }
});

test('with no hub adb server nothing is asked: presence says so, reachability is unknown, and no socket opens', async () => {
  const s = side({ inventory: serverDown });
  try {
    const phones = s.rows(await s.view('linux'), 'phones');
    for (const name of ['s24', 's26']) {
      assert.equal(phones[name].presence, 'no adb server');
      assert.deepEqual(phones[name].reachability, { state: 'unknown', checked_at: iso(T0), age_ms: 0, stale: false }, 'the probe ran: there is no server to ask, which is unknown, not reachable');
    }
    assert.equal(s.wire.opened.length, 0);
    assert.deepEqual(s.wire.requests, []);
    assert.equal(s.sleep.calls.length, 0);
    // a server on some other port is not the hub's
    const other = side({ inventory: () => ({ adb_servers: [{ port: 5555, pid: 1 }], emulators: [], xvfb: [] }) });
    try { assert.equal((await other.view('linux')).phones[0].presence, 'no adb server'); assert.equal(other.wire.opened.length, 0); } finally { other.cleanup(); }
  } finally { s.cleanup(); }
});

test('a wire that fails never fails status: adb did not answer, unknown, timer cleared', async () => {
  for (const fail of ['version', 'devices']) {
    const s = side({ wire: fakeWire({ listed: bothUp, fail }) });
    try {
      const view = await s.view('linux');
      for (const row of view.phones) assert.deepEqual([row.presence, row.reachability.state], ['adb did not answer', 'unknown'], fail);
      assert.ok(s.sleep.calls.every(call => call.signal.aborted), 'the timer is cleared');
      assert.ok(s.wire.opened.every(opened => opened.signal.aborted), 'the sockets are closed');
    } finally { s.cleanup(); }
  }
  const broken = side({ wire: Object.assign(() => { throw new Error('no such port'); }, { requests: [], opened: [] }) });
  try { assert.equal((await broken.view('linux')).phones[0].presence, 'adb did not answer'); } finally { broken.cleanup(); }
});

test('a wire that hangs is given up on after the bound: adb did not answer, unknown, and everything is cleaned up', async () => {
  const s = side({ wire: fakeWire({ listed: bothUp, hang: true }) });
  try {
    const view = await s.view('linux');
    for (const row of view.phones) assert.deepEqual([row.presence, row.reachability.state], ['adb did not answer', 'unknown']);
    assert.deepEqual(s.sleep.calls.map(call => call.ms), [5000]);
    assert.ok(s.wire.opened[0].signal.aborted, 'the hung request is aborted');
  } finally { s.cleanup(); }
});

test('a host:port id is tied to its phone by reading ro.serialno over the wire, and an unreadable one is not matched', async () => {
  const wire = fakeWire({ listed: [{ id: '192.168.1.50:41234', state: 'device', model: 'SM_S948U' }, { id: '192.168.1.34:38423', state: 'device', model: 'SM_S928U' }], serials: { '192.168.1.50:41234': S26 } });
  const s = side({ wire });
  try {
    const phones = s.rows(await s.view('linux'), 'phones');
    assert.deepEqual([phones.s26.presence, phones.s26.reachability.state], ['reachable', 'reachable'], 'that phone matched');
    assert.deepEqual([phones.s24.presence, phones.s24.reachability.state], ['absent', 'absent'], 'an unreadable serial is not matched');
    assert.deepEqual(wire.requests, ['host:version', 'host:devices-l', 'host:transport:192.168.1.50:41234', 'shell:getprop ro.serialno', 'host:transport:192.168.1.34:38423', 'shell:getprop ro.serialno']);
    assert.ok(wireOnly(wire.requests));
  } finally { s.cleanup(); }
  const unauthorized = fakeWire({ listed: [{ id: '192.168.1.50:41234', state: 'unauthorized' }], serials: { '192.168.1.50:41234': S26 } });
  const t = side({ wire: unauthorized });
  try {
    assert.equal(s.rows(await t.view('linux'), 'phones').s26.presence, 'absent');
    assert.deepEqual(unauthorized.requests, ['host:version', 'host:devices-l'], 'only a host:port id in device state is read');
  } finally { t.cleanup(); }
});

test('one wedged host:port serial read costs only that phone: the others keep their listed states, and every timer and socket is cleaned up', async () => {
  const wire = fakeWire({ listed: [{ id: '192.168.1.50:41234', state: 'device', model: 'SM_S948U' }, phone(S24)], hangShell: ['192.168.1.50:41234'] });
  const s = side({ wire });
  try {
    const phones = s.rows(await s.view('linux'), 'phones');
    assert.deepEqual([phones.s24.presence, phones.s24.reachability.state], ['reachable', 'reachable'], 'the finished listing is kept');
    assert.deepEqual([phones.s26.presence, phones.s26.reachability.state], ['absent', 'absent'], 'the hung id is unmatched');
    assert.deepEqual(wire.requests, ['host:version', 'host:devices-l', 'host:transport:192.168.1.50:41234', 'shell:getprop ro.serialno']);
    assert.deepEqual(s.sleep.calls.map(call => call.ms).sort((a, b) => a - b), [1500, 5000], 'a short bound per read, inside the probe\'s 5s');
    assert.ok(s.sleep.calls.every(call => call.signal.aborted), 'every timer is cleared');
    assert.ok(wire.opened.every(opened => opened.signal.aborted), 'every socket is closed');
  } finally { s.cleanup(); }
});

test('a host that does not know its key reads nothing: every reading is missing, and presence is still today\'s', async () => {
  const s = side();
  try {
    const view = await s.view(null);
    const missing = { state: 'unknown', checked_at: null, age_ms: null, stale: true };
    for (const row of view.phones) {
      assert.equal(row.presence, 'reachable', 'presence is read as before');
      assert.deepEqual(row.reachability, missing);
    }
    assert.deepEqual(s.wire.requests, ['host:version', 'host:devices-l'], 'the wire is still asked for presence');
    await acquireLease('adb', { holder: 'a', why: 'x', forMs: 60_000, id: 'held', env: s.env, log: () => {}, now: () => T0 });
    assert.deepEqual((await s.view(null)).locks.find(entry => entry.lock === 'adb').reachability, missing);
  } finally { s.cleanup(); }
});

function ipadDocument(patch = {}) {
  const { udid } = loadDevices({}).ios;
  return { result: { devices: [{ identifier: 'IPAD', hardwareProperties: { udid, reality: 'physical', productType: loadDevices({}).ios.model }, connectionProperties: { pairingState: 'paired', tunnelState: 'connected', transportType: 'wired' }, deviceProperties: { name: 'iPad', developerModeStatus: 'enabled', bootState: 'booted', ...patch } }] } };
}

test('the Mac reads the iPad through devicectl, only when a row names ios-lane', async () => {
  const calls = [];
  const s = side({ inventory: serverDown, devicectl: (args, timeout) => { calls.push([args, timeout]); return ipadDocument(); } });
  try {
    await acquireLease('mac-ios', { holder: 'agent-m', why: 'ipad proof', forMs: 60_000, id: 'ipad', env: s.env, log: () => {}, now: () => T0 });
    const view = await s.view('mac');
    const lock = view.locks.find(entry => entry.lock === 'mac-ios');
    assert.equal(lock.resource, 'ios-lane');
    assert.deepEqual(lock.reachability, { state: 'reachable', checked_at: iso(T0), age_ms: 0, stale: false });
    assert.deepEqual(calls, [[['list', 'devices'], 10]]);
    for (const row of view.phones) assert.deepEqual([row.presence, row.reachability.state, row.reachability.stale], ['no adb server', 'unknown', true], 'the Mac owns no phone');
    assert.deepEqual(s.wire.requests, []);
  } finally { s.cleanup(); }
  const quiet = side({ inventory: serverDown, devicectl: () => { throw new Error('devicectl must not be asked: no row names the iPad'); } });
  try { await quiet.view('mac'); } finally { quiet.cleanup(); }
  const linux = side({ devicectl: () => { throw new Error('the Linux host never asks devicectl'); } });
  try {
    await acquireLease('mac-ios', { holder: 'agent-m', why: 'x', forMs: 60_000, id: 'ipad', env: linux.env, log: () => {}, now: () => T0 });
    const lock = (await linux.view('linux')).locks.find(entry => entry.lock === 'mac-ios');
    assert.deepEqual(lock.reachability, { state: 'unknown', checked_at: null, age_ms: null, stale: true }, 'a Resource this host does not own is never read here');
  } finally { linux.cleanup(); }
});

// A `mac-ios` row that is no held lock: only a waiter in its queue, or only a run's Reservation, still names the iPad.
test('a mac-ios row that is only a waiter, or only a Reservation, makes the Mac read the iPad once', async () => {
  const reachable = { state: 'reachable', checked_at: iso(T0), age_ms: 0, stale: false };
  for (const kind of ['waiter', 'reservation']) {
    const calls = [];
    const s = side({ inventory: serverDown, devicectl: (args, timeout) => { calls.push([args, timeout]); return ipadDocument(); } });
    try {
      if (kind === 'waiter') {
        mkdirSync(join(s.env.HUB_LOCK_DIR, 'mac-ios.queue'), { recursive: true });
        writeFileSync(join(s.env.HUB_LOCK_DIR, 'mac-ios.queue', `${String(T0).padStart(15, '0')}-000001-00000001.json`), JSON.stringify(buildTicket('lease', { env: s.env, requested: T0, lease_id: 'w-ios', holder: 'w', why: 'queued', expires_at: iso(T0 + 3_600_000) })));
      } else {
        reserve('mac-ios', { env: { ...s.env, GITHUB_REPOSITORY: 'delorenj/gruvato', GITHUB_RUN_ID: '9' }, now: () => T0, policy: policy(), log: () => {} });
      }
      assert.equal(existsSync(join(s.env.HUB_LOCK_DIR, 'mac-ios.lock')), false, 'the lock is free');
      const view = await s.view('mac');
      const row = kind === 'waiter' ? view.waiters[0] : view.reservations[0];
      assert.equal(view.locks.length, 0);
      assert.equal(row.lock, 'mac-ios');
      assert.equal(row.resource, 'ios-lane', kind);
      assert.deepEqual(row.reachability, reachable, kind);
      assert.deepEqual(calls, [[['list', 'devices'], 10]], `${kind}: devicectl was asked exactly once`);
    } finally { s.cleanup(); }
  }
});

test('the iPad reads offline, unauthorized and unknown from devicectl\'s record, and a devicectl that throws is unknown', async () => {
  const cases = [
    [() => ipadDocument({ bootState: 'shutdown' }), 'offline'],
    [() => ipadDocument({ developerModeStatus: 'disabled' }), 'unauthorized'],
    [() => ({ result: { devices: [] } }), 'absent'],
    [() => { throw new Error('devicectl list devices did not succeed (failed)'); }, 'unknown'],
  ];
  for (const [devicectl, expected] of cases) {
    const s = side({ inventory: serverDown, devicectl });
    try {
      await acquireLease('mac-ios', { holder: 'agent-m', why: 'x', forMs: 60_000, id: 'ipad', env: s.env, log: () => {}, now: () => T0 });
      const lock = (await s.view('mac')).locks.find(entry => entry.lock === 'mac-ios');
      assert.equal(lock.reachability.state, expected);
    } finally { s.cleanup(); }
  }
});

test('a lock that is no Resource has no resource and no reachability', async () => {
  const s = side();
  try {
    const dir = join(s.env.HUB_LOCK_DIR, 's3-index.lock');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'owner.json'), JSON.stringify({ pid: process.pid, host: hostname(), repo: 'delorenj/earshot', run: '5', started_at: iso(T0) }));
    const lock = (await s.view('linux')).locks.find(entry => entry.lock === 's3-index');
    assert.equal(lock.resource, null);
    assert.equal(lock.reachability, null);
    assert.equal(lock.kind, 'lock');
  } finally { s.cleanup(); }
});

test('the walk reaches a free res-<slug> and emulator-<n> queue, skips an emulator past the pool, and never walks a service or registry.json', async () => {
  const s = side();
  try {
    const locks = s.env.HUB_LOCK_DIR;
    const ticket = (queue, id) => {
      mkdirSync(join(locks, queue), { recursive: true });
      writeFileSync(join(locks, queue, `${String(T0).padStart(15, '0')}-000001-00000001.json`), JSON.stringify(buildTicket('lease', { env: s.env, requested: T0, lease_id: id, holder: 'w', why: 'queued', expires_at: iso(T0 + 3_600_000) })));
    };
    ticket('emulator-3.queue', 'w-e3');
    ticket('res-foo.queue', 'w-foo');
    ticket('emulator-9.queue', 'w-e9');       // past MAX_POOL
    ticket('emulator-03.queue', 'w-e03');     // not a slot's name
    ticket('emulator-0.queue', 'w-e0');
    ticket('res-Bad_Name.queue', 'w-bad');    // not a slug
    ticket('hub-api.queue', 'w-api');         // a service name
    ticket('s3-index.queue', 'w-s3');         // not a Resource
    writeFileSync(join(locks, 'registry.json'), '{"resources":[]}');
    mkdirSync(join(locks, 'registry.reservations'), { recursive: true });   // the word `registry` is reserved, never a Resource
    const view = await s.view('linux');
    assert.deepEqual(view.waiters.map(waiter => [waiter.lock, waiter.lease_id, waiter.resource]), [['emulator-3', 'w-e3', 'emulator'], ['res-foo', 'w-foo', 'res-foo']]);
    assert.ok(view.waiters.every(waiter => waiter.reachability !== null && waiter.reachability.stale === true), 'nobody checked a Resource this host has no transport for');
    assert.equal(statSync(join(locks, 'registry.json')).size, 16, 'registry.json is untouched');
  } finally { s.cleanup(); }
});

test('a broken policy never fails status: readings are stale and ETAs are null', async () => {
  const s = side({ settings: { queue: {} } });
  try {
    await acquireLease('adb', { holder: 'agent-a', why: 'x', forMs: 3_600_000, id: 'held', env: s.env, log: () => {}, now: () => T0 });
    mkdirSync(join(s.env.HUB_LOCK_DIR, 'adb.queue'), { recursive: true });
    writeFileSync(join(s.env.HUB_LOCK_DIR, 'adb.queue', `${String(T0).padStart(15, '0')}-000001-00000001.json`), JSON.stringify(buildTicket('lease', { env: s.env, requested: T0, lease_id: 'next', holder: 'b', why: 'y', expires_at: iso(T0 + 3_600_000) })));
    const result = await s.cli(['status', '--json']);
    assert.equal(result.code, 0, result.err.join('\n'));
    const view = JSON.parse(result.out.join('\n'));
    for (const row of view.phones) assert.deepEqual([row.reachability.state, row.reachability.stale, row.reachability.age_ms], ['reachable', true, 0], 'shown with its age, never as current');
    assert.deepEqual(view.waiters.map(waiter => [waiter.lease_id, waiter.eta]), [['next', null]]);
  } finally { s.cleanup(); }
});

test('the freshness limit comes from the policy: a reading older than it is shown with its age and flagged stale', async () => {
  for (const [limit, stale] of [[1, true], [60, false]]) {
    const s = side();
    try {
      // The reader's clock moves 2 s between taking the reading and showing it.
      let clock = T0;
      const ctx = claims.createContext({ env: s.env, now: () => { clock += 2000; return clock; }, sleep: quickSleep(), adbWire: s.wire, inventory: serverUp, policy: { ...policy(), registry: { reachability_max_age_s: limit } }, fleet: claims.loadFleet(s.env) });
      const row = (await claims.statusView('linux', { audience: 'local' }, ctx)).phones[0];
      assert.deepEqual([row.reachability.state, row.reachability.age_ms, row.reachability.stale], ['reachable', 2000, stale], `limit ${limit}s`);
    } finally { s.cleanup(); }
  }
});

// ---- audiences ----

test('a service sees no serial, UDID or adb id of a QA Resource, and no key is removed; local sees everything', async () => {
  const s = side();
  try {
    await acquireLease('s24', { holder: 'qa-agent', why: 'qa run', forMs: 3_600_000, id: 'qa-lease', env: s.env, log: () => {}, now: () => T0 });
    const owner = JSON.parse(readFileSync(join(s.env.HUB_LOCK_DIR, 's24.lock', 'owner.json'), 'utf8'));
    owner.device = { phone: 's24', serial: S24, adb_id: usbId(S24), adb_port: 5037 };
    writeFileSync(join(s.env.HUB_LOCK_DIR, 's24.lock', 'owner.json'), JSON.stringify(owner));
    const local = await s.view('linux', { audience: 'local', qa_ids: ['s24'] });
    const service = await s.view('linux', { audience: 'service', qa_ids: ['s24'] });
    const open = await s.view('linux', { audience: 'service', qa_ids: [] });
    const [lockLocal, lockService] = [local, service].map(view => view.locks.find(entry => entry.lock === 's24'));
    assert.deepEqual([lockLocal.phone.serial, lockLocal.phone.adb_id], [S24, usbId(S24)]);
    assert.deepEqual(lockService.phone, { phone: 's24', serial: null, adb_id: null, adb_port: 5037 }, 'the nested keys stay, their values go');
    const [phoneLocal, phoneService] = [local, service].map(view => view.phones.find(row => row.device === 's24'));
    assert.equal(phoneLocal.serial, S24);
    assert.deepEqual([phoneService.serial, phoneService.adb_id], [null, null]);
    assert.deepEqual(Object.keys(phoneService), Object.keys(phoneLocal), 'no key is ever removed');
    assert.deepEqual(Object.keys(lockService), Object.keys(lockLocal));
    assert.equal(service.phones.find(row => row.device === 's26').serial, S26, 'a Resource outside the QA set is untouched');
    assert.equal(service.phones.find(row => row.device === 's24').model, 'SM-S928U', 'only the identifying values go');
    assert.equal(open.phones.find(row => row.device === 's24').serial, S24, 'an empty QA set redacts nothing');
    assert.equal(service.phones.find(row => row.device === 's24').reachability.state, 'reachable', 'a QA phone\'s Reachability is still shown');
  } finally { s.cleanup(); }
});

test('any other audience is HUB_USAGE, before anything is read', async () => {
  const s = side();
  try {
    for (const audience of ['admin', 'LOCAL', '', undefined, null, 5]) {
      await assert.rejects(claims.statusView('linux', { audience }, s.ctx), error => error.code === 'HUB_USAGE' && /audience/.test(error.message), String(audience));
    }
    await assert.rejects(claims.statusView('linux', undefined, s.ctx), error => error.code === 'HUB_USAGE');
    await assert.rejects(claims.statusView('linux', null, s.ctx), error => error.code === 'HUB_USAGE');
    assert.deepEqual(s.wire.requests, [], 'nothing was asked');
    assert.equal(claims.exitCodeOf(Object.assign(new Error('x'), { code: 'HUB_USAGE' })), 2);
  } finally { s.cleanup(); }
});

// ---- read only, and only the wire ----

test('status asks only the wire\'s read-only requests: no adb client, no start-server, connect or mdns argv', async () => {
  const wire = fakeWire({ listed: [{ id: '192.168.1.50:41234', state: 'device' }, phone(S24)], serials: { '192.168.1.50:41234': S26 } });
  const s = side({ wire });
  try {
    await s.view('linux');
    await s.view(null);
    assert.ok(wireOnly(wire.requests), wire.requests.join(', '));
    assert.ok(!wire.requests.some(request => /start-server|connect|mdns|kill-server|disconnect/.test(request)));
    assert.equal(s.factoryCalls.length, 0, 'the adb client factory was never called');
    assert.equal(s.adbRan(), false, 'the adb binary never ran');
    const source = readFileSync(fileURLToPath(new URL('./claims.mjs', import.meta.url)), 'utf8');
    const status = source.slice(source.indexOf('// ---- status ----'));
    assert.doesNotMatch(status, /findPhone|startServer|mdnsServices|createAsyncAdb|adbFactory|\.connect\(/, 'the status builder has no path to the adb client');
  } finally { s.cleanup(); }
});

// A sha256 of every file under the dirs, by relative path: any write, new file or removal changes it.
function digest(...dirs) {
  const hash = createHash('sha256');
  const walk = (dir, base) => {
    let names = [];
    try { names = readdirSync(dir).sort(); } catch { return; }
    for (const name of names) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) { hash.update(`d:${base}/${name}\n`); walk(path, `${base}/${name}`); } else hash.update(`f:${base}/${name}:${readFileSync(path).toString('hex')}\n`);
    }
  };
  for (const dir of dirs) walk(dir, dir === dirs[0] ? 'locks' : 'events');
  return hash.digest('hex');
}

test('status and status --json leave the lock dir and the Event Log byte-identical', async () => {
  const s = side();
  try {
    const runEnv = { ...s.env, GITHUB_REPOSITORY: 'delorenj/earshot', GITHUB_RUN_ID: '9' };
    await acquireLease('adb', { holder: 'agent-a', why: 'device proof', forMs: 3_600_000, id: 'held', env: s.env, log: () => {} });
    await acquireLease('s24', { holder: 'agent-b', why: 'qa', forMs: 3_600_000, id: 'held-2', env: s.env, log: () => {} });
    reserve('mac-ios', { env: runEnv, policy: policy(), log: () => {} });
    const locks = s.env.HUB_LOCK_DIR;
    const ticket = (queue, kind, id) => {
      mkdirSync(join(locks, queue), { recursive: true });
      const body = kind === 'job' ? buildTicket('job', { env: { ...s.env, GITHUB_REPOSITORY: 'delorenj/gruvato', GITHUB_RUN_ID: '77', GITHUB_RUN_ATTEMPT: '1', GITHUB_JOB: 'android' }, requested: Date.now() }) : buildTicket('lease', { env: s.env, requested: Date.now(), lease_id: id, holder: 'w', why: 'queued', expires_at: iso(Date.now() + 3_600_000) });
      writeFileSync(join(locks, queue, `${String(Date.now()).padStart(15, '0')}-000001-0000000${id.length}.json`), JSON.stringify(body));
    };
    ticket('adb.queue', 'job', 'j');
    ticket('res-foo.queue', 'lease', 'w-foo');
    ticket('emulator-2.queue', 'lease', 'w-e2');
    const before = digest(locks, s.env.HUB_EVENT_DIR);
    assert.ok(readdirSync(s.env.HUB_EVENT_DIR).length > 0, 'the Event Log has history to protect');
    await s.view('linux');
    await s.view(null, { audience: 'service', qa_ids: ['s24'] });
    assert.equal((await s.cli(['status'])).code, 0);
    assert.equal((await s.cli(['status', '--json'])).code, 0);
    assert.equal((await s.cli(['status', '--json'], { hostKey: () => { throw Object.assign(new Error('unknown'), { code: 'HUB_HOST_UNKNOWN' }); } })).code, 0);
    assert.equal(digest(locks, s.env.HUB_EVENT_DIR), before, 'nothing was written, created or removed');
  } finally { s.cleanup(); }
});

// ---- the CLI ----

test('the CLI resolves the host key through its seam, passes null when it is unknown, and a missing key never fails status', async () => {
  const s = side();
  try {
    const keyed = JSON.parse((await s.cli(['status', '--json'], { hostKey: () => 'linux' })).out.join('\n'));
    assert.equal(keyed.phones[0].reachability.state, 'reachable');
    const unknown = await s.cli(['status', '--json'], { hostKey: () => { throw Object.assign(new Error('this host does not know which host it is'), { code: 'HUB_HOST_UNKNOWN' }); } });
    assert.equal(unknown.code, 0);
    assert.deepEqual(unknown.err, []);
    const view = JSON.parse(unknown.out.join('\n'));
    assert.deepEqual(view.phones.map(row => [row.presence, row.reachability]), [['reachable', { state: 'unknown', checked_at: null, age_ms: null, stale: true }], ['reachable', { state: 'unknown', checked_at: null, age_ms: null, stale: true }]]);
    // no seam and no key file: the real resolver reports the host unknown and status goes on
    const none = await runCli(s.env, ['status', '--json'], { adbWire: s.wire, inventory: serverUp, policy: policy(), now: () => T0 });
    assert.equal(none.code, 0);
    assert.equal(JSON.parse(none.out.join('\n')).phones[0].reachability.stale, true);
    // any other failure of the resolver is still a failure
    const broken = await s.cli(['status', '--json'], { hostKey: () => { throw new Error('boom'); } });
    assert.equal(broken.code, 1);
  } finally { s.cleanup(); }
});

test('the text status is byte-identical whatever the host key says', async () => {
  const s = side();
  try {
    const known = await s.cli(['status'], { hostKey: () => 'linux' });
    const unknown = await s.cli(['status'], { hostKey: () => { throw Object.assign(new Error('x'), { code: 'HUB_HOST_UNKNOWN' }); } });
    assert.equal(known.code, 0);
    assert.deepEqual(known.out, unknown.out);
    assert.equal(known.out[0], 'PHONES (read only; adb is queried, never connected)');
    assert.match(known.out[1], /^ {2}s24 {2}free {2}reachable {2}SM-S928U {2}serial R5CX31AEJDA {2}lock s24$/);
    assert.ok(!known.out.join('\n').includes('reachability'), 'the text output has no new fields');
  } finally { s.cleanup(); }
});

test('an unauthorized s24 lease still exits 75 with HUB_DEVICE_AWAY s24', async () => {
  const s = side({ wire: fakeWire({ listed: [phone(S24, 'unauthorized'), phone(S26)] }) });
  try {
    const adb = { startServer: async () => {}, devices: async () => [{ id: usbId(S24), state: 'unauthorized' }, { id: usbId(S26), state: 'device' }], prop: async () => '', mdnsServices: async () => new Map() };
    const result = await s.cli(['lease', 's24', '--for', '5m', '--why', 'x', '--wait', '0'], { adbFactory: () => adb });
    assert.deepEqual([result.code, result.out], [75, ['HUB_DEVICE_AWAY s24']]);
    assert.match(result.err.join('\n'), /s24 is away: unauthorized/);
    assert.equal(existsSync(join(s.env.HUB_LOCK_DIR, 's24.lock')), false, 'nothing is held');
  } finally { s.cleanup(); }
});

test('hub-device status as a child process reads the hub port over the wire and runs no adb binary', async () => {
  const root = mkdtempSync(join(tmpdir(), 'status-view-child-'));
  let hub = null;
  try {
    const adb = join(root, 'adb');
    writeFileSync(adb, `#!/bin/sh\necho "$*" >> "${root}/calls.log"\nexit 1\n`);
    chmodSync(adb, 0o755);
    hub = await fakeHub({ listed: [phone(S24), phone(S26, 'unauthorized')] });
    const env = { PATH: process.env.PATH, HOME: root, USER: 'tester', HUB_ADB: adb, HUB_LOCK_DIR: join(root, 'locks'), HUB_EVENT_DIR: join(root, 'events'), HUB_ADB_SERVER_PORT: String(hub.server.port), ANDROID_ADB_SERVER_PORT: '15170' };
    const child = spawn(process.execPath, [tool, 'status', '--json'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', chunk => { out += chunk; });
    child.stderr.resume();
    const code = await new Promise(done => child.on('close', status => done(status)));
    assert.equal(code, 0, out);
    const view = JSON.parse(out);
    const phones = Object.fromEntries(view.phones.map(row => [row.device, row]));
    assert.deepEqual([phones.s24.presence, phones.s26.presence], ['reachable', 'unauthorized']);
    assert.ok(view.phones.every(row => row.reachability.stale === true && row.reachability.state === 'unknown'), 'no host key file: nothing is read, nothing is called reachable');
    assert.deepEqual(hub.server.requests, ['host:version', 'host:devices-l']);
    assert.ok(!existsSync(join(root, 'calls.log')), 'no adb client: no start-server, connect or mdns');
  } finally {
    await hub?.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test('parseDevicesLong reads host:devices-l, and createAdbWire.devicesLong speaks it to a real socket', async () => {
  const text = [
    `${S26}            device usb:1-1 product:e3qxeea model:SM_S948U device:e3q transport_id:1`,
    '192.168.1.50:41234     device product:p model:SM_S928U device:d transport_id:7',
    'XYZ                    unauthorized usb:1-2 transport_id:3',
    'W                      no permissions (user in plugdev group; are your udev rules wrong?) usb:1-3 transport_id:4',
    '',
  ].join('\n');
  assert.deepEqual(parseDevicesLong(text), [
    { id: S26, state: 'device', model: 'SM_S948U', product: 'e3qxeea', device: 'e3q', transport_id: '1' },
    { id: '192.168.1.50:41234', state: 'device', model: 'SM_S928U', product: 'p', device: 'd', transport_id: '7' },
    { id: 'XYZ', state: 'unauthorized', model: null, product: null, device: null, transport_id: '3' },
    { id: 'W', state: 'no', model: null, product: null, device: null, transport_id: '4' },
  ]);
  assert.deepEqual(parseDevicesLong(''), []);
  const server = await fakeAdbServer({ listed: [phone(S24), phone(S26, 'offline')], serials: { 'x:1': S26 } });
  try {
    const wire = createAdbWire(server.port);
    assert.equal(await wire.version(), '0041');
    assert.deepEqual((await wire.devicesLong()).map(entry => [entry.id, entry.state, entry.model]), [[usbId(S24), 'device', 'SM_S928U'], [usbId(S26), 'offline', null]]);
    assert.equal((await wire.shell('x:1', 'getprop ro.serialno')).trim(), S26);
    assert.deepEqual(server.requests, ['host:version', 'host:devices-l', 'host:transport:x:1', 'shell:getprop ro.serialno']);
  } finally { await server.close(); }
});
