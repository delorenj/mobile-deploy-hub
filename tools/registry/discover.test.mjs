// Story 5.6: `reachability.queryAdb` / `reachability.discover`, `claims.discover` and `hub-device discover`, driven hermetically: the wire is
// `fakeWire`, devicectl and the host key are injected, and the one child-process case talks to a TCP fake on a free port. Nothing here
// reaches a real adb server (5037), a real devicectl or a real host key.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDevices } from '../ci/lib/devices.mjs';
import { hermetic } from '../ci/test-fixtures.mjs';
import * as claims from '../device/claims.mjs';
import { main } from '../device/hub-device.mjs';
import { fakeHub, fakeWire } from '../device/wire-fixtures.mjs';
import { discover, queryAdb } from './reachability.mjs';
import { seed } from './seed.mjs';

hermetic();

const tool = fileURLToPath(new URL('../device/hub-device.mjs', import.meta.url));
const S26 = 'R5GL43A7PCH';
const S24 = 'R5CX31AEJDA';
const devices = loadDevices({});
const registry = seed(devices, { qaDevices: () => [] });
const usbId = serial => `adb-${serial}-zz._adb-tls-connect._tcp`;
const seeded = [{ id: usbId(S24), state: 'device', model: 'SM_S928U' }, { id: usbId(S26), state: 'device', model: 'SM_S948U' }];
const serverUp = () => ({ adb_servers: [{ port: 5037, pid: 4242, cwd: null }], emulators: [], xvfb: [] });
const serverDown = () => ({ adb_servers: [], emulators: [], xvfb: [] });

// A sleep that runs a hundredth of the time: the 5s query bound fires fast when something hangs.
function quickSleep() {
  return (ms, signal) => new Promise(done => {
    if (signal?.aborted) { done(); return; }
    const timer = setTimeout(done, ms / 100);
    signal?.addEventListener('abort', () => { clearTimeout(timer); done(); }, { once: true });
  });
}

const ask = (wire, { port = 5037, running = true } = {}) => queryAdb({ port, running, wire, sleep: quickSleep() });
const find = async (listed, options = {}) => {
  const wire = fakeWire({ listed, ...options });
  return { wire, document: discover({ seed: registry, host: 'linux', adb: await ask(wire) }) };
};

// ---- queryAdb ----

test('queryAdb with no server opens no wire and says so', async () => {
  const wire = fakeWire({ listed: seeded });
  const result = await ask(wire, { running: false });
  assert.deepEqual(result, { port: 5037, note: 'no adb server', listed: [], serials: new Map() });
  assert.equal(wire.opened.length, 0);
});

test('queryAdb asks version, devices-l and one serial read per host:port id in device state, and closes the socket', async () => {
  const wire = fakeWire({ listed: [{ id: '192.168.1.40:41234', state: 'device', model: 'Pixel_8' }, { id: '192.168.1.41:5555', state: 'unauthorized' }, { id: 'ZY22ABC', state: 'device' }], serials: { '192.168.1.40:41234': '9A1B' } });
  const result = await ask(wire, { port: 15037 });
  assert.equal(result.note, null);
  assert.equal(result.port, 15037);
  assert.deepEqual(result.listed.map(entry => entry.id), ['192.168.1.40:41234', '192.168.1.41:5555', 'ZY22ABC']);
  assert.deepEqual([...result.serials], [['192.168.1.40:41234', '9A1B']]);
  assert.deepEqual(wire.requests, ['host:version', 'host:devices-l', 'host:transport:192.168.1.40:41234', 'shell:getprop ro.serialno']);
  assert.deepEqual(wire.opened.map(entry => entry.port), [15037]);
  assert.equal(wire.opened[0].signal.aborted, true, 'every socket is closed by abort once the query is done');
});

test('queryAdb: a failing or hanging server is an answer, not a failure; a hanging serial read costs only that serial', async () => {
  for (const options of [{ fail: 'version' }, { fail: 'devices' }, { hang: true }]) {
    const result = await ask(fakeWire({ listed: seeded, ...options }));
    assert.deepEqual([result.note, result.listed.length], ['adb did not answer', 0], JSON.stringify(options));
  }
  const throwing = await queryAdb({ port: 5037, running: true, wire: () => { throw new Error('no socket'); }, sleep: quickSleep() });
  assert.equal(throwing.note, 'adb did not answer');
  const wire = fakeWire({ listed: [{ id: '10.0.0.5:1', state: 'device' }, { id: '10.0.0.6:2', state: 'device' }], serials: { '10.0.0.6:2': 'OK6' }, hangShell: ['10.0.0.5:1'] });
  const result = await ask(wire);
  assert.equal(result.note, null);
  assert.deepEqual([...result.serials], [['10.0.0.6:2', 'OK6']]);
});

// ---- discover (the I/O matrix) ----

test('only the seeded phones: nothing unregistered', async () => {
  const { document } = await find(seeded);
  assert.deepEqual(document, { format: 1, port: 5037, devices: [], host: 'linux', via: 'adb', note: null });
  assert.deepEqual(Object.keys(document).slice(0, 3), ['format', 'port', 'devices']);
});

test('a new USB phone is listed with its serial, model, id and state', async () => {
  const { document } = await find([...seeded, { id: 'ZY22ABC', state: 'device', model: 'Pixel_8' }]);
  assert.deepEqual(document.devices, [{ serial: 'ZY22ABC', model: 'Pixel_8', id: 'ZY22ABC', state: 'device' }]);
});

test('a wireless host:port phone is listed by the serial read from it, and not when that serial is a seeded phone\'s', async () => {
  const { document } = await find([{ id: '192.168.1.40:41234', state: 'device', model: 'Pixel_8' }, { id: '192.168.1.41:5555', state: 'device', model: 'SM_S928U' }], { serials: { '192.168.1.40:41234': '9A1B', '192.168.1.41:5555': S24 } });
  assert.deepEqual(document.devices, [{ serial: '9A1B', model: 'Pixel_8', id: '192.168.1.40:41234', state: 'device' }]);
});

test('an unreadable host:port id has a null serial: unauthorized, a failed read, a hung read (bounded)', async () => {
  const { document } = await find([{ id: '10.0.0.1:1', state: 'unauthorized' }, { id: '10.0.0.2:2', state: 'device' }, { id: '10.0.0.3:3', state: 'device' }], { serials: { '10.0.0.3:3': 'OK3' }, hangShell: ['10.0.0.2:2'] });
  assert.deepEqual(document.devices.map(device => [device.id, device.serial, device.state]), [['10.0.0.1:1', null, 'unauthorized'], ['10.0.0.2:2', null, 'device'], ['10.0.0.3:3', 'OK3', 'device']]);
  const failed = await find([{ id: '10.0.0.4:4', state: 'device' }]);
  assert.deepEqual(failed.document.devices.map(device => [device.id, device.serial]), [['10.0.0.4:4', null]]);
});

test('an unknown mDNS id carries the serial inside it', async () => {
  const { document } = await find([{ id: 'adb-ZZ9-x._adb-tls-connect._tcp', state: 'device', model: 'Pixel_9' }]);
  assert.deepEqual(document.devices, [{ serial: 'ZZ9', model: 'Pixel_9', id: 'adb-ZZ9-x._adb-tls-connect._tcp', state: 'device' }]);
});

test('emulators are never listed, and a listing keeps adb\'s order and its own state word', async () => {
  const { document } = await find([{ id: 'emulator-5554', state: 'device' }, { id: 'B2', state: 'offline', model: 'Two' }, ...seeded, { id: 'A1', state: 'recovery' }]);
  assert.deepEqual(document.devices.map(device => [device.id, device.state, device.model]), [['B2', 'offline', 'Two'], ['A1', 'recovery', null]]);
});

test('no server: no wire is opened, an empty list with the note', async () => {
  const wire = fakeWire({ listed: seeded });
  const document = discover({ seed: registry, host: 'linux', adb: await ask(wire, { running: false }) });
  assert.deepEqual(document, { format: 1, port: 5037, devices: [], host: 'linux', via: 'adb', note: 'no adb server' });
  assert.equal(wire.opened.length, 0);
});

test('a wedged server: adb did not answer with an empty list', async () => {
  for (const options of [{ fail: 'version' }, { hang: true }]) {
    const { document } = await find(seeded, options);
    assert.deepEqual([document.note, document.devices], ['adb did not answer', []]);
  }
});

test('the seed is a seed() result or a resources array, and a runtime Resource names its phone too', async () => {
  const listed = [{ id: 'ZY22ABC', state: 'device' }];
  const adb = await ask(fakeWire({ listed }));
  assert.equal(discover({ seed: registry.resources, host: 'linux', adb }).devices.length, 1);
  const withQa = seed(devices, { qaDevices: () => [{ name: 'Pixel', serial: 'ZY22ABC', model: 'Pixel_8' }] });
  assert.deepEqual(discover({ seed: withQa, host: 'linux', adb }).devices, []);
});

const IPAD = { identifier: 'IPAD-ID', hardwareProperties: { udid: devices.ios.udid, productType: devices.ios.model }, connectionProperties: { pairingState: 'paired' } };
const IPHONE = { identifier: 'IPHONE-ID', hardwareProperties: { udid: '00008110-0001', productType: 'iPhone15,2' }, connectionProperties: { pairingState: 'unpaired' } };

test('the Mac lists the devicectl records whose UDID is not seeded', () => {
  const document = discover({ seed: registry, host: 'mac', ipads: { document: { result: { devices: [IPAD, IPHONE, { identifier: 'X' }] } } } });
  assert.deepEqual(document, { format: 1, port: null, devices: [{ serial: '00008110-0001', model: 'iPhone15,2', id: 'IPHONE-ID', state: 'unpaired' }, { serial: null, model: null, id: 'X', state: null }], host: 'mac', via: 'devicectl', note: null });
  assert.deepEqual(discover({ seed: registry, host: 'mac', ipads: { document: { result: { devices: [IPAD] } } } }).devices, []);
  assert.deepEqual(discover({ seed: registry, host: 'mac', ipads: { error: new Error('x') } }), { format: 1, port: null, devices: [], host: 'mac', via: 'devicectl', note: 'devicectl did not answer' });
});

// ---- claims.discover and the CLI ----

function side({ wire = fakeWire({ listed: seeded }), inventory = serverUp, devicectl, env: extra = {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'discover-'));
  const adbCalls = join(root, 'adb-calls.log');
  const adbBinary = join(root, 'adb');
  writeFileSync(adbBinary, `#!/bin/sh\necho "$*" >> "${adbCalls}"\nexit 1\n`);
  chmodSync(adbBinary, 0o755);
  const env = { PATH: process.env.PATH, HOME: root, USER: 'tester', HUB_LOCK_DIR: join(root, 'locks'), HUB_EVENT_DIR: join(root, 'events'), HUB_ADB_SERVER_PORT: '5037', HUB_ADB: adbBinary, ...extra };
  const factoryCalls = [];
  const adbFactory = (...args) => { factoryCalls.push(args); throw new Error('discover must never build an adb client'); };
  const cli = async (argv, { hostKey = () => 'linux', ...more } = {}) => {
    const out = [];
    const err = [];
    const code = await main(argv, { env, stdout: line => out.push(line), stderr: line => err.push(line), adbFactory, adbWire: wire, devicectl, inventory, sleep: quickSleep(), hostKey, ...more });
    return { code, out, err };
  };
  return { root, env, wire, cli, factoryCalls, adbRan: () => existsSync(adbCalls), cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('claims.discover: an unknown host key throws HUB_HOST_UNKNOWN and nothing is asked', async () => {
  const s = side();
  try {
    const ctx = claims.createContext({ env: s.env, adbWire: s.wire, inventory: serverUp });
    for (const key of [null, undefined, 'windows']) {
      await assert.rejects(claims.discover(key, ctx), { code: 'HUB_HOST_UNKNOWN' });
    }
    assert.equal(claims.exitCodeOf({ code: 'HUB_HOST_UNKNOWN' }), 1);
    assert.equal(s.wire.opened.length, 0);
  } finally { s.cleanup(); }
});

test('hub-device discover prints the unregistered devices as text and the port it used', async () => {
  const s = side({ wire: fakeWire({ listed: [...seeded, { id: 'ZY22ABC', state: 'device', model: 'Pixel_8' }, { id: '10.0.0.2:2', state: 'unauthorized' }] }) });
  try {
    const { code, out, err } = await s.cli(['discover']);
    assert.deepEqual([code, err], [0, []]);
    assert.deepEqual(out, ['DISCOVER (read only; adb server port 5037, never started or connected)', '  ZY22ABC  Pixel_8  id ZY22ABC  device', '  -  -  id 10.0.0.2:2  unauthorized']);
    assert.ok(!s.adbRan());
    assert.equal(s.factoryCalls.length, 0);
  } finally { s.cleanup(); }
});

test('hub-device discover --json is the document, two-space indented, with the port from HUB_ADB_SERVER_PORT', async () => {
  const s = side({ env: { HUB_ADB_SERVER_PORT: '15037' }, inventory: () => ({ adb_servers: [{ port: 15037, pid: 1, cwd: null }], emulators: [], xvfb: [] }), wire: fakeWire({ listed: [{ id: 'ZY22ABC', state: 'device', model: 'Pixel_8' }] }) });
  try {
    const { code, out } = await s.cli(['discover', '--json']);
    assert.equal(code, 0);
    assert.equal(out.length, 1);
    assert.equal(out[0], JSON.stringify({ format: 1, port: 15037, devices: [{ serial: 'ZY22ABC', model: 'Pixel_8', id: 'ZY22ABC', state: 'device' }], host: 'linux', via: 'adb', note: null }, null, 2));
    assert.deepEqual(s.wire.opened.map(entry => entry.port), [15037]);
    const text = await s.cli(['discover']);
    assert.match(text.out[0], /adb server port 15037/);
  } finally { s.cleanup(); }
});

test('hub-device discover with only seeded phones says none unregistered', async () => {
  const s = side();
  try {
    const { code, out } = await s.cli(['discover']);
    assert.deepEqual([code, out[1]], [0, '  none unregistered']);
  } finally { s.cleanup(); }
});

test('hub-device discover with no adb server exits 0, opens no wire, builds no adb client and runs no adb binary', async () => {
  const s = side({ inventory: serverDown });
  try {
    const { code, out } = await s.cli(['discover']);
    assert.deepEqual([code, out], [0, ['DISCOVER (read only; adb server port 5037, never started or connected)', '  no adb server (nothing was started)']]);
    const json = await s.cli(['discover', '--json']);
    assert.deepEqual([json.code, JSON.parse(json.out[0]).note, JSON.parse(json.out[0]).devices], [0, 'no adb server', []]);
    assert.equal(s.wire.opened.length, 0);
    assert.equal(s.factoryCalls.length, 0);
    assert.ok(!s.adbRan());
  } finally { s.cleanup(); }
});

test('hub-device discover against a wedged server prints the document and exits 1', async () => {
  for (const options of [{ fail: 'version' }, { hang: true }]) {
    const s = side({ wire: fakeWire({ listed: seeded, ...options }) });
    try {
      const { code, out } = await s.cli(['discover']);
      assert.deepEqual([code, out], [1, ['DISCOVER (read only; adb server port 5037, never started or connected)', '  adb did not answer']]);
      const json = await s.cli(['discover', '--json']);
      assert.deepEqual([json.code, JSON.parse(json.out[0]).note], [1, 'adb did not answer']);
    } finally { s.cleanup(); }
  }
});

test('hub-device discover on the Mac asks devicectl only, lists no Android device and never opens the adb wire', async () => {
  const calls = [];
  const devicectl = (...args) => { calls.push(args); return { result: { devices: [IPAD, IPHONE] } }; };
  const s = side({ devicectl });
  try {
    const { code, out } = await s.cli(['discover'], { hostKey: () => 'mac' });
    assert.equal(code, 0);
    assert.deepEqual(out, ['DISCOVER (read only; devicectl on this Mac)', '  discovery of the iPad is by devicectl; the Mac\'s adb is not the hub\'s, so no Android device is listed', '  00008110-0001  iPhone15,2  id IPHONE-ID  unpaired']);
    assert.deepEqual(calls, [[['list', 'devices'], 10]]);
    assert.equal(s.wire.opened.length, 0);
    const json = JSON.parse((await s.cli(['discover', '--json'], { hostKey: () => 'mac' })).out[0]);
    assert.deepEqual([json.host, json.via, json.port, json.devices.length], ['mac', 'devicectl', null, 1]);
  } finally { s.cleanup(); }
});

test('hub-device discover on the Mac: only the seeded iPad is none unregistered, and a failing devicectl exits 1', async () => {
  const only = side({ devicectl: () => ({ result: { devices: [IPAD] } }) });
  const broken = side({ devicectl: () => { throw new Error('devicectl list devices did not succeed'); } });
  try {
    const first = await only.cli(['discover'], { hostKey: () => 'mac' });
    assert.deepEqual([first.code, first.out[2]], [0, '  none unregistered']);
    const second = await broken.cli(['discover'], { hostKey: () => 'mac' });
    assert.deepEqual([second.code, second.out[2]], [1, '  devicectl did not answer']);
    assert.equal(JSON.parse((await broken.cli(['discover', '--json'], { hostKey: () => 'mac' })).out[0]).note, 'devicectl did not answer');
  } finally { only.cleanup(); broken.cleanup(); }
});

test('hub-device discover on an unknown host fails with the hostKey message and asks nothing', async () => {
  const s = side();
  try {
    const hostKey = () => { throw Object.assign(new Error('this host does not know which host it is: no key'), { code: 'HUB_HOST_UNKNOWN' }); };
    const { code, out, err } = await s.cli(['discover'], { hostKey });
    assert.deepEqual([code, out, err], [1, [], ['hub-device: this host does not know which host it is: no key']]);
    assert.equal(s.wire.opened.length, 0);
  } finally { s.cleanup(); }
});

test('hub-device discover takes no argument or unknown flag, and USAGE keeps its prefix and names discover', async () => {
  const s = side();
  try {
    assert.equal((await s.cli(['discover', 'now'])).code, 2);
    assert.equal((await s.cli(['discover', '--bogus'])).code, 2);
    const bare = await s.cli([]);
    assert.equal(bare.code, 2);
    assert.match(bare.err[0], /^hub-device: usage: hub-device lease /);
    assert.match(bare.err[0], /\| discover \[--json\] \|/);
  } finally { s.cleanup(); }
});

test('child process: discover over a real socket sends only version, devices-l, transport and the serial read, and runs no adb binary', { skip: process.platform !== 'linux' }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'discover-child-'));
  let hub;
  try {
    const adb = join(root, 'adb');
    writeFileSync(adb, `#!/bin/sh\necho "$*" >> "${root}/calls.log"\nexit 1\n`);
    chmodSync(adb, 0o755);
    mkdirSync(join(root, '.config/mobile-deploy-hub'), { recursive: true });
    writeFileSync(join(root, '.config/mobile-deploy-hub/host-key'), 'linux\n');
    hub = await fakeHub({ listed: [...seeded, { id: 'ZY22ABC', state: 'device', model: 'Pixel_8' }, { id: '127.0.0.1:41234', state: 'device', model: 'Pixel_9' }], serials: { '127.0.0.1:41234': '9A1B' } });
    const env = { PATH: process.env.PATH, HOME: root, USER: 'tester', HUB_ADB: adb, HUB_LOCK_DIR: join(root, 'locks'), HUB_EVENT_DIR: join(root, 'events'), HUB_ADB_SERVER_PORT: String(hub.server.port), ANDROID_ADB_SERVER_PORT: '15170' };
    const child = spawn(process.execPath, [tool, 'discover', '--json'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', chunk => { out += chunk; });
    child.stderr.on('data', chunk => { err += chunk; });
    const code = await new Promise(done => child.on('close', status => done(status)));
    assert.equal(code, 0, err);
    const document = JSON.parse(out);
    assert.deepEqual(document.devices.map(device => [device.serial, device.id]), [['ZY22ABC', 'ZY22ABC'], ['9A1B', '127.0.0.1:41234']]);
    assert.equal(document.port, hub.server.port);
    const allowed = request => request === 'host:version' || request === 'host:devices-l' || /^host:transport:[^\s]+$/.test(request) || request === 'shell:getprop ro.serialno';
    assert.ok(hub.server.requests.length >= 2 && hub.server.requests.every(allowed), hub.server.requests.join(', '));
    assert.ok(!existsSync(join(root, 'calls.log')), 'no adb client: no start-server, connect or mdns');
  } finally {
    await hub?.stop();
    rmSync(root, { recursive: true, force: true });
  }
});
