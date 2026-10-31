// The emulator pool behind `hub-device lease|run emulator`, against fake emulator, avdmanager and adb binaries (HUB_EMULATOR,
// HUB_AVDMANAGER, HUB_ADB), a temp SDK, HOME, ANDROID_AVD_HOME and HUB_LOCK_DIR. The fakes are real processes (the adb server
// fake listens on a real port in 25000-25099 and speaks adb's host protocol), so pids, start times and teardown are real; no
// real emulator, AVD or adb server is touched.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { releaseLease, withLock } from '../ci/lib/lock.mjs';
import { choosePorts, doomed, liveStart, portsInUse, releaseEmulator, resolveImage, stopProcesses } from './emulator.mjs';
import { inventory } from './inventory.mjs';
import { main } from './hub-device.mjs';

const tool = fileURLToPath(new URL('./hub-device.mjs', import.meta.url));
const settle = ms => new Promise(done => setTimeout(done, ms));
const NODE = process.execPath;
// Lease ids are random per run, so two runs of this suite on one host never share one.
const uid = name => `${name}-${randomBytes(3).toString('hex')}`;

// adb, as the broker uses it: only ever `adb -L tcp:localhost:PORT server nodaemon`, then the host protocol on PORT.
const fakeAdb = state => `#!${NODE}
const fs = require('fs');
const net = require('net');
const state = ${JSON.stringify(state)};
const argv = process.argv.slice(2);
fs.appendFileSync(state + '/adb-calls.log', argv.join(' ') + '\\n');
const at = argv.indexOf('-L');
if (at === -1 || !argv.includes('nodaemon')) process.exit(1);
const port = Number(/(\\d+)$/.exec(argv[at + 1])[1]);
fs.writeFileSync(state + '/adb-server-' + port + '.json', JSON.stringify({ pid: process.pid, mdns: process.env.ADB_MDNS, max: process.env.ADB_LOCAL_TRANSPORT_MAX_PORT, lease: process.env.HUB_EMULATOR_LEASE, managed: process.env.HUB_MANAGED, usb: process.env.ADB_USB }));
const devices = new Set();
const frame = text => Buffer.byteLength(text).toString(16).padStart(4, '0') + text;
net.createServer(socket => {
  let buffer = '';
  let transport = null;
  socket.on('error', () => {});
  socket.on('data', chunk => {
    buffer += chunk;
    while (buffer.length >= 4) {
      const length = parseInt(buffer.slice(0, 4), 16);
      if (buffer.length < 4 + length) return;
      const request = buffer.slice(4, 4 + length);
      buffer = buffer.slice(4 + length);
      fs.appendFileSync(state + '/adb-requests.log', request + '\\n');
      if (request === 'host:version') socket.end('OKAY' + frame('0029'));
      else if (request === 'host:devices') socket.end('OKAY' + frame([...devices].map(id => id + '\\tdevice\\n').join('')));
      else if (request.startsWith('host:emulator:')) {
        const console = Number(request.slice(14)) - 1;
        if (fs.existsSync(state + '/emulator-' + console + '.json')) devices.add('emulator-' + console);
        socket.end();
      } else if (request.startsWith('host:transport:')) {
        transport = request.slice(15);
        if (devices.has(transport)) socket.write('OKAY'); else socket.end('FAIL' + frame("device '" + transport + "' not found"));
      } else if (request.startsWith('shell:') && transport) {
        const prop = request.slice(6).replace('getprop ', '');
        const booted = fs.existsSync(state + '/booted-' + transport.slice(9));
        socket.end('OKAY' + (prop === 'sys.boot_completed' ? (booted ? '1' : '') : prop === 'ro.kernel.qemu' ? '1' : '') + '\\r\\n');
      } else socket.end('FAIL' + frame('unknown request'));
    }
  });
}).listen(port, '127.0.0.1');
process.on('SIGTERM', () => process.exit(0));
`;

// The emulator: records what it was given, daemonizes a helper the way crashpad_handler does (own session, environment
// inherited), and "boots" after FAKE_BOOT_MS. state/crash makes it die at start; state/stubborn makes it ignore SIGTERM.
const fakeEmulator = state => `#!${NODE}
const fs = require('fs');
const { spawn } = require('child_process');
const state = ${JSON.stringify(state)};
const argv = process.argv.slice(2);
const flag = name => argv[argv.indexOf(name) + 1];
const consolePort = Number(flag('-port'));
const e = process.env;
fs.writeFileSync(state + '/emulator-' + consolePort + '.json', JSON.stringify({ pid: process.pid, argv, avdHome: e.ANDROID_AVD_HOME, adbServer: e.ANDROID_ADB_SERVER_PORT, tmp: e.TMPDIR, xdg: e.XDG_RUNTIME_DIR, lease: e.HUB_EMULATOR_LEASE, managed: e.HUB_MANAGED, mdns: e.ADB_MDNS, max: e.ADB_LOCAL_TRANSPORT_MAX_PORT, display: e.DISPLAY ?? null, wayland: e.WAYLAND_DISPLAY ?? null }));
if (fs.existsSync(state + '/crash')) { console.error('FATAL | fake emulator crashed'); process.exit(1); }
if (fs.existsSync(state + '/renderer')) console.error('ERROR        | Could not start renderer! (Error: -2)');
if (!fs.existsSync(e.ANDROID_AVD_HOME + '/' + flag('-avd') + '.ini')) { console.error('PANIC: Unknown AVD name'); process.exit(1); }
const helper = spawn(process.execPath, ['-e', 'require("fs").writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1e6)', state + '/helper-' + consolePort + '.pid'], { detached: true, stdio: 'ignore' });
helper.unref();
process.on('SIGTERM', () => {
  if (fs.existsSync(state + '/stubborn')) return;
  // state/respawn: a helper started while shutting down, the way a crash reporter can be
  if (fs.existsSync(state + '/respawn')) spawn(process.execPath, ['-e', 'require("fs").writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1e6)', state + '/late-helper-' + consolePort + '.pid'], { detached: true, stdio: 'ignore' }).unref();
  process.exit(0);
});
setTimeout(() => fs.writeFileSync(state + '/booted-' + consolePort, ''), Number(e.FAKE_BOOT_MS || 100));
setInterval(() => {}, 1e6);
`;

const fakeAvdmanager = state => `#!/bin/sh
echo "$*" >> "${state}/avdmanager.log"
cat > "${state}/avdmanager.stdin"
[ -f "${state}/avdmanager-fails" ] && { echo "Error: Package path is not valid"; exit 1; }
name=""; pkg=""
while [ $# -gt 0 ]; do case "$1" in -n) name="$2"; shift 2 ;; -k) pkg="$2"; shift 2 ;; *) shift ;; esac; done
mkdir -p "$ANDROID_AVD_HOME/$name.avd"
printf 'avd.ini.encoding=UTF-8\\npath=%s\\ntarget=android-36\\n' "$ANDROID_AVD_HOME/$name.avd" > "$ANDROID_AVD_HOME/$name.ini"
printf 'PlayStore.enabled=no\\nabi.type=x86_64\\nhw.lcd.width=320\\nimage.sysdir.1=wrong\\n' > "$ANDROID_AVD_HOME/$name.avd/config.ini"
`;

function fixture({ image = 'google_apis' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'hub-emu-test-'));
  const state = join(root, 'state');
  const bin = join(root, 'bin');
  const sdk = join(root, 'sdk');
  const userAvd = join(root, 'user-avd');
  for (const dir of [state, bin, join(root, 'home'), join(root, 'tmp'), join(userAvd, 'Medium_Phone.avd')]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(userAvd, 'Medium_Phone.ini'), 'path=x\n');
  writeFileSync(join(userAvd, 'Medium_Phone.avd/config.ini'), 'hw.lcd.width=1080\n');
  if (image) {
    mkdirSync(join(sdk, 'system-images/android-36', image, 'x86_64'), { recursive: true });
    writeFileSync(join(sdk, 'system-images/android-36', image, 'x86_64/source.properties'), 'AndroidVersion.ApiLevel=36\n');
  }
  for (const [name, body] of [['adb', fakeAdb(state)], ['emulator', fakeEmulator(state)], ['avdmanager', fakeAvdmanager(state)]]) {
    writeFileSync(join(bin, name), body);
    chmodSync(join(bin, name), 0o755);
  }
  const env = {
    PATH: process.env.PATH, HOME: join(root, 'home'), USER: 'tester', DISPLAY: ':0', WAYLAND_DISPLAY: 'wayland-0', HUB_LOCK_DIR: join(root, 'locks'), ANDROID_HOME: sdk, ANDROID_AVD_HOME: userAvd,
    HUB_ADB: join(bin, 'adb'), HUB_EMULATOR: join(bin, 'emulator'), HUB_AVDMANAGER: join(bin, 'avdmanager'),
    HUB_DEVICE_POLL_MS: '5', HUB_EMULATOR_POLL_MS: '20', HUB_EMULATOR_KILL_GRACE_MS: '400', HUB_EMULATOR_ADB_PORTS: '25000-25099',
    HUB_EMULATOR_DIR: join(root, 'emulators'), TMPDIR: join(root, 'tmp'),
  };
  const run = async (argv, extra = {}) => {
    const out = [];
    const err = [];
    const code = await main(argv, { env, stdout: line => out.push(line), stderr: line => err.push(line), inventory: () => ({ adb_servers: [], emulators: [], xvfb: [] }), ...extra });
    return { code, out, err };
  };
  const exportsOf = out => Object.fromEntries(out.map(line => /^export (\w+)='(.*)'$/.exec(line).slice(1)));
  const record = id => JSON.parse(readFileSync(join(root, 'locks/emulators', `${id}.json`), 'utf8'));
  const owner = name => JSON.parse(readFileSync(join(root, 'locks', `${name}.lock`, 'owner.json'), 'utf8'));
  const records = () => { try { return readdirSync(join(root, 'locks/emulators')).filter(file => file.endsWith('.json')); } catch { return []; } };
  const read = name => { try { return readFileSync(join(state, name), 'utf8'); } catch { return ''; } };
  const strays = new Set();
  // Nothing of the pool left: no record, no AVD or runtime folder, no temp folder.
  const clean = () => {
    assert.deepEqual(records(), [], 'no record left');
    assert.deepEqual(existsSync(join(root, 'emulators')) ? readdirSync(join(root, 'emulators')) : [], [], 'no AVD or runtime folder left');
    assert.deepEqual(readdirSync(join(root, 'tmp')).filter(name => name.startsWith('hub-emu-')), [], 'no temp folder left');
  };
  return {
    root, env, state, sdk, userAvd, run, exportsOf, record, owner, records, read, strays, clean,
    // Every pid a record named stays dead once its lease is gone; the cleanup kills nothing that is not a fake of this test.
    cleanup: () => {
      for (const file of readdirSync(state).filter(name => /^(emulator|adb-server)-\d+\.json$/.test(name))) strays.add(JSON.parse(readFileSync(join(state, file), 'utf8')).pid);
      for (const file of readdirSync(state).filter(name => /^(late-)?helper-\d+\.pid$/.test(name))) strays.add(Number(readFileSync(join(state, file), 'utf8')));
      for (const pid of strays) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone, as it should be */ } }
      rmSync(root, { recursive: true, force: true });
    },
  };
}

const gone = pid => liveStart(pid) === null;
const refused = port => new Promise(done => {
  const socket = connect({ host: '127.0.0.1', port });
  socket.on('connect', () => { socket.destroy(); done(false); });
  socket.on('error', error => done(error.code === 'ECONNREFUSED'));
});
const waitFor = async (check, ms = 5000) => { for (const end = Date.now() + ms; Date.now() < end && !check();) await settle(20); return check(); };

test('lease emulator makes a throwaway emulator, records every pid with its start time, and release tears exactly that down', async () => {
  const f = fixture();
  try {
    const leased = await f.run(['lease', 'emulator', '--for', '30m', '--why', 'emulator proof', '--env-serial', 'MY_SERIAL']);
    assert.equal(leased.code, 0, leased.err.join('\n'));
    const vars = f.exportsOf(leased.out);
    assert.match(vars.HUB_LEASE_ID, /^e-[0-9a-f]{12}$/);
    const id = vars.HUB_LEASE_ID;
    const consolePort = Number(/^emulator-(\d+)$/.exec(vars.ANDROID_SERIAL)[1]);
    assert.ok(consolePort % 2 === 0 && consolePort >= 5600 && consolePort <= 5698, `console port ${consolePort}`);
    const serverPort = Number(vars.ANDROID_ADB_SERVER_PORT);
    assert.ok(serverPort >= 25000 && serverPort <= 25099 && serverPort !== 5037, `adb server port ${serverPort}`);
    assert.equal(vars.MY_SERIAL, vars.ANDROID_SERIAL);

    // the record: every process it started, each a live process with the start time it was recorded with
    const record = f.record(id);
    assert.deepEqual([record.slot, record.serial, record.console_port, record.adb_port, record.adb_server_port], ['emulator-1', vars.ANDROID_SERIAL, consolePort, consolePort + 1, serverPort]);
    assert.deepEqual(record.pids.map(entry => entry.role).sort(), ['adb-server', 'emulator', 'helper']);
    for (const entry of record.pids) assert.equal(liveStart(entry.pid), entry.start, `${entry.role} ${entry.pid} is the recorded process`);
    const emulatorRun = JSON.parse(f.read(`emulator-${consolePort}.json`));
    const server = JSON.parse(f.read(`adb-server-${serverPort}.json`));
    const helper = Number(f.read(`helper-${consolePort}.pid`));
    assert.deepEqual(Object.fromEntries(record.pids.map(entry => [entry.role, entry.pid])), { 'adb-server': server.pid, emulator: emulatorRun.pid, helper });
    // the lease record carries the same pids, and is held until release or expiry (no holder pid)
    const owner = f.owner('emulator-1');
    assert.deepEqual([owner.kind, owner.lease_id, owner.why, owner.holder_pid], ['lease', id, 'emulator proof', null]);
    assert.deepEqual(owner.emulator.pids, record.pids);
    assert.ok(!existsSync(join(f.root, 'locks/emulator.lock')), 'the gate was let go once the slot was taken');

    // headless, wiped, no snapshots, its own AVD home, temp and runtime folders, its own adb server
    for (const flag of ['-no-window', '-no-audio', '-no-snapshot', '-wipe-data']) assert.ok(emulatorRun.argv.includes(flag), flag);
    assert.deepEqual(emulatorRun.argv.slice(emulatorRun.argv.indexOf('-gpu'), emulatorRun.argv.indexOf('-gpu') + 2), ['-gpu', 'swangle_indirect']);
    assert.equal(emulatorRun.argv[emulatorRun.argv.indexOf('-port') + 1], String(consolePort));
    assert.equal(emulatorRun.argv[emulatorRun.argv.indexOf('-avd') + 1], `hub-${id}`);
    assert.match(record.marker, new RegExp(`^${id}\\.[0-9a-f]{16}$`), 'the helper marker is the lease id plus a nonce kept in the record');
    assert.deepEqual([emulatorRun.avdHome, emulatorRun.adbServer, emulatorRun.tmp, emulatorRun.lease, emulatorRun.managed, emulatorRun.mdns, emulatorRun.max], [record.avd.home, String(serverPort), record.tmp, record.marker, '1', '0', '5553']);
    assert.ok(record.tmp.startsWith(join(f.root, 'tmp', 'hub-emu-')), 'the temp folder is under $TMPDIR');
    assert.ok(emulatorRun.avdHome.startsWith(join(f.root, 'emulators', id)), 'never the caller\'s ANDROID_AVD_HOME');
    assert.deepEqual([emulatorRun.display, emulatorRun.wayland], [null, null], 'headless: the caller\'s display never reaches it');
    assert.deepEqual([server.mdns, server.max, server.usb, server.lease, server.managed], ['0', '5553', '0', record.marker, '1'], 'the private server never scans the shared emulator ports, connects over mDNS or takes a USB device');
    assert.equal(f.read('adb-calls.log'), `-L tcp:localhost:${serverPort} server nodaemon\n`, 'the adb binary only ever started the server');
    assert.match(f.read('adb-requests.log'), new RegExp(`^host:emulator:${consolePort + 1}$`, 'm'));
    assert.match(f.read('adb-requests.log'), /^shell:getprop sys\.boot_completed$/m);

    // the AVD came from the profile
    assert.equal(f.read('avdmanager.log'), `create avd -n hub-${id} -k system-images;android-36;google_apis;x86_64 --force\n`);
    assert.equal(f.read('avdmanager.stdin'), 'no\n');
    const config = readFileSync(join(record.avd.dir, 'config.ini'), 'utf8');
    for (const line of ['hw.lcd.width=1080', 'hw.lcd.height=2400', 'image.sysdir.1=system-images/android-36/google_apis/x86_64/', 'hw.gpu.mode=swangle_indirect']) assert.match(config, new RegExp(`^${line.replaceAll('.', '\\.')}$`, 'm'));
    assert.deepEqual(readdirSync(f.userAvd).sort(), ['Medium_Phone.avd', 'Medium_Phone.ini'], 'the AVDs that were there are untouched');

    // release: exactly the recorded processes go, then the AVD, the folders, the record, the slot and the ports
    const released = await f.run(['release', id]);
    assert.deepEqual([released.code, released.out], [0, [`HUB_DEVICE_RELEASED emulator ${id}`]]);
    assert.match(released.err.join('\n'), new RegExp(`stopped pids [\\d,]+, deleted AVD hub-${id}, freed ports ${consolePort},${consolePort + 1},${serverPort}`));
    for (const entry of record.pids) assert.ok(gone(entry.pid), `${entry.role} ${entry.pid} is gone`);
    for (const path of [record.avd.ini, record.avd.dir, record.dir, record.tmp, join(f.root, 'locks/emulator-1.lock')]) assert.ok(!existsSync(path), `${path} is gone`);
    assert.deepEqual(f.records(), []);
    assert.ok(await refused(serverPort), 'nothing listens on the adb server port');
    assert.deepEqual(readdirSync(f.userAvd).sort(), ['Medium_Phone.avd', 'Medium_Phone.ini']);
    assert.deepEqual((await f.run(['release', 'emulator', id])).out, [`HUB_DEVICE_NOT_HELD emulator ${id} (no emulator lease by that id)`], 'release is idempotent');
    f.clean();
  } finally { f.cleanup(); }
});

test('the default profile never falls back to the Play image; --profile playstore asks for it, and --json says the same', async () => {
  const f = fixture({ image: 'google_apis_playstore' });
  try {
    const refused = await f.run(['lease', 'emulator', '--for', '10m', '--why', 'default']);
    assert.equal(refused.code, 1);
    assert.match(refused.err.join('\n'), /needs system-images;android-36;google_apis;x86_64, which is not installed/);
    assert.equal(f.read('avdmanager.log'), '', 'no fallback: nothing was made');
    const id = uid('my-emu');
    const leased = await f.run(['lease', 'emulator', '--profile', 'playstore', '--for', '10m', '--why', 'json', '--id', id, '--json']);
    assert.equal(leased.code, 0, leased.err.join('\n'));
    const doc = JSON.parse(leased.out[0]);
    assert.deepEqual([doc.lease_id, doc.device, doc.profile, doc.image, doc.slot], [id, 'emulator', 'playstore', 'system-images;android-36;google_apis_playstore;x86_64', 'emulator-1']);
    assert.match(readFileSync(join(f.record(id).avd.dir, 'config.ini'), 'utf8'), /^image\.sysdir\.1=system-images\/android-36\/google_apis_playstore\/x86_64\/$/m);
    assert.equal(doc.env.ANDROID_SERIAL, doc.emulator.serial);
    assert.equal(doc.env.HUB_LEASE_ID, id);
    assert.equal(doc.emulator.pids.length, 3);
    assert.equal((await f.run(['release', id])).code, 0);
    f.clean();
  } finally { f.cleanup(); }
});

test('a missing system image is one clear line, before anything is taken or started', async () => {
  const f = fixture({ image: null });
  try {
    const result = await f.run(['lease', 'emulator', '--for', '10m', '--why', 'no image']);
    assert.equal(result.code, 1);
    assert.deepEqual(result.out, []);
    assert.equal(result.err.length, 1, result.err.join('\n'));
    assert.match(result.err[0], /^hub-device: emulator profile "default" needs system-images;android-36;google_apis;x86_64, which is not installed under .*; install it with sdkmanager "system-images;android-36;google_apis;x86_64"$/);
    assert.match((await f.run(['lease', 'emulator', '--profile', 'playstore', '--for', '1m', '--why', 'x'])).err[0], /needs system-images;android-36;google_apis_playstore;x86_64, which is not installed.*sdkmanager "system-images;android-36;google_apis_playstore;x86_64"$/);
    assert.equal(f.read('avdmanager.log') + f.read('adb-calls.log'), '', 'nothing ran');
    assert.ok(!existsSync(join(f.root, 'locks/emulator.lock')) && !existsSync(join(f.root, 'locks/emulator-1.lock')));
    assert.throws(() => resolveImage('pixel-9'), /unknown emulator profile "pixel-9"/);
    assert.equal((await f.run(['lease', 'emulator', '--profile', 'pixel-9', '--for', '1m', '--why', 'x'])).code, 2);
    assert.equal((await f.run(['lease', 'emulator', '--for', '1m', '--why', 'x', '--no-connect'])).code, 2);
    assert.equal((await f.run(['lease', 'emulator', '--for', '1m', '--why', 'x', '--pool', '0'])).code, 2);
    assert.equal((await f.run(['lease', 'emulator', '--for', '1m', '--why', 'x'], { env: { ...f.env, HUB_EMULATOR_POOL: '9' } })).code, 2);
  } finally { f.cleanup(); }
});

test('ports: even console pairs clear of every in-use port, claimed pair and running emulator, never 5554 or 5037', () => {
  const chosen = choosePorts({ inUse: new Set([5600, 5603, 15000]), claimed: [15001], emulators: [{ console_port: 5604, adb_server: 15002 }], adbServers: [{ port: 15003 }] });
  assert.deepEqual(chosen, { console: 5606, adb: 5607, adbServer: 15004 }, '5600 in use, 5602 pairs with 5603, 5604 is an emulator; 150xx by default');
  assert.equal(choosePorts({ consoleRange: [5554, 5560] }).console, 5556, '5554 is never chosen, even when free');
  assert.equal(choosePorts({ inUse: new Set([5557]), consoleRange: [5554, 5560] }).console, 5558, 'a pair overlapping an in-use port is skipped');
  assert.equal(choosePorts({ inUse: new Set([5036]), adbRange: [5036, 5038] }).adbServer, 5038, '5037 is never chosen');
  assert.throws(() => choosePorts({ inUse: new Set([5556, 5559]), consoleRange: [5554, 5560] }), error => error.code === 'HUB_EMULATOR_NO_PORT');
  const proc = mkdtempSync(join(tmpdir(), 'hub-net-'));
  try {
    mkdirSync(join(proc, 'net'));
    writeFileSync(join(proc, 'net/tcp'), '  sl  local_address rem_address   st\n   0: 0100007F:3AFB 00000000:0000 0A\n   1: 0100007F:15F2 0100007F:D431 01\n');
    writeFileSync(join(proc, 'net/tcp6'), '  sl  local_address rem_address   st\n   0: 00000000000000000000000001000000:15B2 00000000000000000000000000000000:0000 0A\n');
    assert.deepEqual([...portsInUse(proc)].sort((a, b) => a - b), [5554, 5618, 15099]);
  } finally { rmSync(proc, { recursive: true, force: true }); }
});

// A process this test owns, that ignores SIGTERM when asked to.
function sleeper({ stubborn = false } = {}) {
  const child = spawn(NODE, ['-e', `${stubborn ? "process.on('SIGTERM', () => {});" : ''}setInterval(() => {}, 1e6)`], { stdio: 'ignore' });
  return child;
}

test('teardown signals only a recorded process that is still itself (pid and start time), and SIGKILLs one that outlives SIGTERM', async () => {
  const a = sleeper();
  const b = sleeper();
  const c = sleeper();
  const stubborn = sleeper({ stubborn: true });
  try {
    await settle(200);
    const log = [];
    const entries = [
      { pid: a.pid, start: liveStart(a.pid), role: 'emulator' },
      { pid: b.pid, start: '1', role: 'helper' },   // the pid now belongs to another process lifetime
      { pid: c.pid, start: null, role: 'helper' },  // never identified: never signalled
    ];
    const result = await stopProcesses(entries, { graceMs: 300, log: line => log.push(line) });
    assert.deepEqual(result, { signalled: [a.pid], survivors: [] });
    assert.ok(gone(a.pid));
    assert.ok(!gone(b.pid) && !gone(c.pid), 'a reused or unidentified pid is left alone');
    const hard = await stopProcesses([{ pid: stubborn.pid, start: liveStart(stubborn.pid), role: 'emulator' }], { graceMs: 300, log: line => log.push(line) });
    assert.deepEqual(hard, { signalled: [stubborn.pid], survivors: [] });
    assert.ok(gone(stubborn.pid));
    assert.match(log.join('\n'), new RegExp(`^HUB_EMULATOR_SIGKILL emulator pid ${stubborn.pid} outlived SIGTERM`, 'm'));
  } finally { for (const child of [a, b, c, stubborn]) child.kill('SIGKILL'); }
});

test('the reaper: any invocation tears down an expired lease, a lease whose holder died and an orphaned record, and leaves a live one alone', async () => {
  const f = fixture();
  try {
    f.env.HUB_EMULATOR_POOL = '3';
    const holder = sleeper();
    const [LIVE, SHORT, TIED] = [uid('live'), uid('short'), uid('tied')];
    const live = f.exportsOf((await f.run(['lease', 'emulator', '--for', '30m', '--why', 'keep', '--id', LIVE])).out);
    const expiring = await f.run(['lease', 'emulator', '--for', '1s', '--why', 'short', '--id', SHORT]);
    assert.equal(expiring.code, 0, expiring.err.join('\n'));
    const held = await f.run(['lease', 'emulator', '--for', '30m', '--why', 'tied', '--id', TIED, '--pid', String(holder.pid)]);
    assert.equal(held.code, 0, held.err.join('\n'));
    assert.equal(f.owner(f.record(TIED).slot).holder_pid, holder.pid);
    const doomedPids = [...f.record(SHORT).pids, ...f.record(TIED).pids];
    holder.kill('SIGKILL');
    await waitFor(() => gone(holder.pid));
    await settle(1100);
    const status = await f.run(['status']);
    assert.equal(status.code, 0);
    const text = status.err.join('\n');
    assert.match(text, new RegExp(`^HUB_EMULATOR_REAPED ${SHORT} emulator-2 \\(expired\\): stopped pids [\\d,]+, deleted AVD hub-${SHORT}`, 'm'));
    assert.match(text, new RegExp(`^HUB_EMULATOR_REAPED ${TIED} emulator-3 \\(holder gone\\)`, 'm'));
    for (const entry of doomedPids) assert.ok(gone(entry.pid), `${entry.role} ${entry.pid} reaped`);
    assert.deepEqual(f.records(), [`${LIVE}.json`]);
    for (const entry of f.record(LIVE).pids) assert.equal(liveStart(entry.pid), entry.start, 'the live lease was not touched');
    assert.match(status.out.join('\n'), new RegExp(`emulator \\(emulator-1\\)  LEASE ${LIVE} .* emulator-\\d+ adb-server=\\d+`));
    // a record whose slot no longer holds it (reclaimed under it) is orphaned and goes too
    releaseLease('emulator-1', LIVE, { env: f.env });
    const reaped = await f.run(['status', '--json']);
    assert.match(reaped.err.join('\n'), new RegExp(`^HUB_EMULATOR_REAPED ${LIVE} emulator-1 \\(orphaned\\)`, 'm'));
    assert.deepEqual(JSON.parse(reaped.out.join('\n')).emulators, []);
    assert.ok(await refused(Number(live.ANDROID_ADB_SERVER_PORT)));
    assert.equal(doomed({ host: 'elsewhere', lease_id: 'x' }, null), null, 'another host\'s record is never judged here');
    f.clean();
  } finally { f.cleanup(); }
});

test('the pool holds two by default: a third request is BUSY with --wait 0; the host sets the cap and --pool can only lower it', async () => {
  const f = fixture();
  try {
    const [ONE, TWO, THREE] = [uid('one'), uid('two'), uid('three')];
    const one = await f.run(['lease', 'emulator', '--for', '10m', '--why', 'one', '--id', ONE]);
    const two = await f.run(['lease', 'emulator', '--for', '10m', '--why', 'two', '--id', TWO]);
    assert.deepEqual([one.code, two.code], [0, 0]);
    assert.deepEqual([f.record(ONE).slot, f.record(TWO).slot], ['emulator-1', 'emulator-2']);
    assert.notEqual(f.record(ONE).adb_server_port, f.record(TWO).adb_server_port);
    assert.notEqual(f.record(ONE).console_port, f.record(TWO).console_port);
    const busy = await f.run(['lease', 'emulator', '--for', '10m', '--why', 'three', '--id', THREE, '--wait', '0']);
    assert.equal(busy.code, 76);
    assert.deepEqual(busy.out, [], 'BUSY never reaches stdout');
    assert.match(busy.err.join('\n'), new RegExp(`^HUB_DEVICE_BUSY emulator the emulator pool is full \\(2 of 2: ${ONE} of tester@.*; ${TWO} of tester@.*\\)`, 'm'));
    assert.deepEqual(f.records().sort(), [`${ONE}.json`, `${TWO}.json`].sort(), 'the refused request left nothing');
    assert.ok(!existsSync(join(f.root, 'locks/emulator.lock')), 'and let the gate go');
    const raise = await f.run(['lease', 'emulator', '--for', '10m', '--why', 'x', '--wait', '0', '--pool', '3']);
    assert.equal(raise.code, 2, 'a request can never raise the host\'s cap');
    assert.match(raise.err.join('\n'), /--pool can only lower this host's emulator pool of 2/);
    assert.equal(f.records().length, 2);
    // the cap is the host's: <lock dir>/emulator-pool, overridden by $HUB_EMULATOR_POOL
    writeFileSync(join(f.root, 'locks/emulator-pool'), '1\n');
    assert.match((await f.run(['lease', 'emulator', '--for', '10m', '--why', 'x', '--wait', '0'])).err.join('\n'), new RegExp(`the emulator pool is full \\(1 of 1: ${ONE} of `));
    writeFileSync(join(f.root, 'locks/emulator-pool'), 'lots\n');
    assert.match((await f.run(['lease', 'emulator', '--for', '10m', '--why', 'x'])).err.join('\n'), /emulator-pool: the emulator pool is 1 to 8 emulators, not "lots"/);
    writeFileSync(join(f.root, 'locks/emulator-pool'), '3\n');
    assert.equal((await f.run(['lease', 'emulator', '--for', '10m', '--why', 'x', '--wait', '0', '--pool', '2'])).code, 76, '--pool lowers it for this request');
    f.env.HUB_EMULATOR_POOL = '2';
    assert.equal((await f.run(['lease', 'emulator', '--for', '10m', '--why', 'x', '--wait', '0'])).code, 76, 'the env wins over the file');
    delete f.env.HUB_EMULATOR_POOL;
    const third = await f.run(['lease', 'emulator', '--for', '10m', '--why', 'three', '--id', THREE, '--wait', '0']);
    assert.equal(third.code, 0, third.err.join('\n'));
    assert.equal(f.record(THREE).slot, 'emulator-3');
    for (const id of [ONE, TWO, THREE]) assert.equal((await f.run(['release', id])).code, 0);
    f.clean();
  } finally { f.cleanup(); }
});

// Spawns the real CLI so a signal reaches a real process.
function spawnCli(f, args, extraEnv = {}) {
  const child = spawn(NODE, [tool, ...args], { env: { ...f.env, ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'] });
  let err = '';
  child.stdout.resume();
  child.stderr.on('data', chunk => { err += chunk; });
  const exit = new Promise(done => child.on('close', (code, signal) => done({ code, signal, err })));
  return { child, exit };
}

test('waiting requests are served first in, first out as the pool frees up', async () => {
  const f = fixture();
  try {
    f.env.HUB_EMULATOR_POOL = '1';
    const HOLDER = uid('holder');
    await f.run(['lease', 'emulator', '--for', '10m', '--why', 'holder', '--id', HOLDER]);
    const order = join(f.root, 'order');
    const queue = join(f.root, 'locks/emulator.queue');
    const waiting = () => (existsSync(join(f.root, 'locks/emulator.lock')) ? 1 : 0) + (existsSync(queue) ? readdirSync(queue).filter(file => file.endsWith('.json')).length : 0);
    const runs = [];
    for (const name of ['one', 'two', 'three']) {
      runs.push(spawnCli(f, ['run', 'emulator', '--wait', '60s', '--why', name, '--', NODE, '-e', `require('fs').appendFileSync(${JSON.stringify(order)}, '${name} ' + process.env.ANDROID_SERIAL + '\\n')`]));
      assert.ok(await waitFor(() => waiting() === runs.length), `${name} is queued`);
    }
    assert.equal(f.owner('emulator').why, 'next for an emulator: one', 'the first in line holds the gate');
    const behind = await f.run(['lease', 'emulator', '--for', '1m', '--why', 'impatient', '--wait', '0']);
    assert.equal(behind.code, 76);
    assert.match(behind.err.join('\n'), /^HUB_DEVICE_BUSY emulator the emulator pool is full, with other requests ahead of e-[0-9a-f]+ \(host lock emulator /m, 'a request behind the queue says the pool is full too');
    assert.equal((await f.run(['release', HOLDER])).code, 0);
    const results = await Promise.all(runs.map(run => run.exit));
    assert.deepEqual(results.map(result => result.code), [0, 0, 0], results.map(result => result.err).join('\n'));
    assert.deepEqual(readFileSync(order, 'utf8').split('\n').filter(Boolean).map(line => line.split(' ')[0]), ['one', 'two', 'three']);
    assert.ok(!existsSync(join(f.root, 'locks/emulator-1.lock')));
    f.clean();
  } finally { f.cleanup(); }
});

test('run emulator exports the emulator to the command, returns its code and tears down after success, failure and a missing command', async () => {
  const f = fixture();
  try {
    const probe = join(f.root, 'probe');
    const script = `const fs=require('fs');const e=process.env;fs.writeFileSync(${JSON.stringify(probe)},JSON.stringify({s:e.ANDROID_SERIAL,p:e.ANDROID_ADB_SERVER_PORT,x:e.MINE,id:e.HUB_LEASE_ID,records:fs.readdirSync(${JSON.stringify(join(f.root, 'locks/emulators'))}).filter(n=>n.endsWith('.json'))}));process.exit(Number(process.argv[1]))`;
    const ok = await f.run(['run', 'emulator', '--for', '10m', '--why', 'probe', '--env-serial', 'MINE', '--', NODE, '-e', script, '0']);
    assert.equal(ok.code, 0, ok.err.join('\n'));
    const seen = JSON.parse(readFileSync(probe, 'utf8'));
    assert.match(seen.s, /^emulator-\d+$/);
    assert.equal(seen.x, seen.s);
    assert.match(seen.id, /^run-/);
    assert.deepEqual(seen.records, [`${seen.id}.json`], 'held while the command ran');
    assert.match(ok.err.join('\n'), new RegExp(`hub-device: ${seen.s} torn down: stopped pids`));
    assert.deepEqual(f.records(), [], 'torn down after success');
    assert.ok(await refused(Number(seen.p)));
    const failed = await f.run(['run', 'emulator', '--', NODE, '-e', script, '3']);
    assert.equal(failed.code, 3);
    assert.deepEqual(f.records(), [], 'torn down after failure');
    assert.equal((await f.run(['run', 'emulator', '--', join(f.root, 'no-such-command')])).code, 127);
    assert.deepEqual(f.records(), [], 'torn down when the command cannot start');
    assert.ok(!existsSync(join(f.root, 'locks/emulator-1.lock')));
    f.clean();
  } finally { f.cleanup(); }
});

test('an emulator that dies while booting is reported and everything it started is torn down', async () => {
  const f = fixture();
  try {
    writeFileSync(join(f.state, 'crash'), '');
    const result = await f.run(['run', 'emulator', '--', NODE, '-e', '']);
    assert.equal(result.code, 1);
    assert.match(result.err.join('\n'), /^hub-device: the emulator exited while booting: FATAL \| fake emulator crashed$/m);
    const server = readdirSync(f.state).filter(name => /^adb-server-\d+\.json$/.test(name)).map(name => JSON.parse(f.read(name)).pid);
    assert.equal(server.length, 1);
    assert.ok(gone(server[0]), 'its adb server was stopped');
    assert.deepEqual(f.records(), []);
    assert.deepEqual(readdirSync(join(f.root, 'emulators')), [], 'its AVD and folders are gone');
    rmSync(join(f.state, 'crash'));
    writeFileSync(join(f.state, 'renderer'), '');
    const started = Date.now();
    const renderer = await f.run(['lease', 'emulator', '--for', '1m', '--why', 'x'], { env: { ...f.env, FAKE_BOOT_MS: '60000' } });
    assert.equal(renderer.code, 1);
    assert.match(renderer.err.join('\n'), /^hub-device: the emulator failed while booting: ERROR \| Could not start renderer! \(Error: -2\)$/m);
    assert.ok(Date.now() - started < 5000, 'a renderer failure ends the lease at once, not at the boot timeout');
    assert.deepEqual(f.records(), []);
    rmSync(join(f.state, 'renderer'));
    writeFileSync(join(f.state, 'avdmanager-fails'), '');
    const avd = await f.run(['lease', 'emulator', '--for', '1m', '--why', 'x']);
    assert.equal(avd.code, 1);
    assert.match(avd.err.join('\n'), /avdmanager could not create hub-e-[0-9a-f]+ from system-images;android-36;google_apis;x86_64: Error: Package path is not valid/);
    f.clean();
  } finally { f.cleanup(); }
});

for (const command of ['run', 'lease']) {
  test(`${command} emulator: SIGTERM while it boots exits 143 promptly and leaves nothing running`, async () => {
    const f = fixture();
    try {
      const args = command === 'run' ? ['run', 'emulator', '--', NODE, '-e', ''] : ['lease', 'emulator', '--for', '10m', '--why', 'sig'];
      const { child, exit } = spawnCli(f, args, { FAKE_BOOT_MS: '60000' });
      assert.ok(await waitFor(() => readdirSync(f.state).some(name => /^helper-\d+\.pid$/.test(name))), 'the emulator is booting');
      await settle(100);
      const record = JSON.parse(readFileSync(join(f.root, 'locks/emulators', f.records()[0]), 'utf8'));
      const started = Date.now();
      child.kill('SIGTERM');
      const result = await exit;
      assert.equal(result.code, 143, result.err);
      assert.ok(Date.now() - started < 3000, `took ${Date.now() - started}ms`);
      assert.ok(record.pids.length >= 2);
      for (const entry of record.pids) assert.ok(gone(entry.pid), `${entry.role} ${entry.pid} is gone`);
      const helper = Number(f.read(readdirSync(f.state).find(name => /^helper-\d+\.pid$/.test(name))));
      assert.ok(gone(helper), 'the daemonized helper, found by its marker, is gone');
      assert.ok(!existsSync(join(f.root, 'locks/emulator-1.lock')));
      f.clean();
    } finally { f.cleanup(); }
  });
}

test('run emulator: SIGTERM while the command runs stops it and tears the emulator down', async () => {
  const f = fixture();
  try {
    const pidFile = join(f.root, 'cmd.pid');
    const { child, exit } = spawnCli(f, ['run', 'emulator', '--for', '10m', '--why', 'sig', '--', NODE, '-e', `require('fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{},1e6)`]);
    assert.ok(await waitFor(() => existsSync(pidFile), 10_000), 'the command started');
    const record = JSON.parse(readFileSync(join(f.root, 'locks/emulators', f.records()[0]), 'utf8'));
    assert.equal(f.owner(record.slot).holder_pid, child.pid, 'the lease is tied to the run');
    child.kill('SIGTERM');
    const result = await exit;
    assert.equal(result.code, 143, result.err);
    assert.ok(gone(Number(readFileSync(pidFile, 'utf8'))), 'the command is gone');
    for (const entry of record.pids) assert.ok(gone(entry.pid), `${entry.role} ${entry.pid} is gone`);
    f.clean();
  } finally { f.cleanup(); }
});

test('status marks the pool\'s own processes managed with their lease id, and everything else foreign', async () => {
  const f = fixture();
  try {
    const SHOWN = uid('shown');
    const vars = f.exportsOf((await f.run(['lease', 'emulator', '--for', '10m', '--why', 'status', '--id', SHOWN])).out);
    const record = f.record(SHOWN);
    const pid = role => record.pids.find(entry => entry.role === role).pid;
    const procRoot = join(f.root, 'proc');
    const fake = (id, argv, env = {}) => {
      mkdirSync(join(procRoot, String(id)), { recursive: true });
      writeFileSync(join(procRoot, String(id), 'cmdline'), `${argv.join('\0')}\0`);
      writeFileSync(join(procRoot, String(id), 'environ'), `${Object.entries(env).map(([k, v]) => `${k}=${v}`).join('\0')}\0`);
    };
    fake(pid('adb-server'), ['adb', '-L', `tcp:localhost:${vars.ANDROID_ADB_SERVER_PORT}`, 'server', 'nodaemon']);
    fake(pid('emulator'), ['qemu-system-x86_64-headless', '-avd', `hub-${SHOWN}`, '-port', String(record.console_port)], { ANDROID_ADB_SERVER_PORT: vars.ANDROID_ADB_SERVER_PORT });
    fake(999_000_001, ['adb', '-L', 'tcp:localhost:15131', 'fork-server', 'server']);
    fake(999_000_002, ['qemu-system-x86_64-headless', '-avd', 'towe68-framing', '-port', '5730'], { ANDROID_ADB_SERVER_PORT: '15131' });
    const real = () => inventory({ procRoot, lockRoot: join(f.root, 'locks') });
    const doc = JSON.parse((await f.run(['status', '--json'], { inventory: real })).out.join('\n'));
    assert.deepEqual(doc.inventory.emulators.map(entry => [entry.avd, entry.managed, entry.lease_id ?? null]).sort(), [[`hub-${SHOWN}`, true, SHOWN], ['towe68-framing', false, null]]);
    assert.deepEqual(doc.inventory.adb_servers.filter(entry => entry.pid === pid('adb-server')).map(entry => [entry.managed, entry.lease_id]), [[true, SHOWN]]);
    assert.deepEqual(doc.inventory.adb_servers.filter(entry => entry.pid === 999_000_001).map(entry => [entry.managed, entry.lease_id ?? null]), [[false, null]]);
    assert.deepEqual(doc.emulators.map(entry => [entry.lease_id, entry.slot, entry.serial, entry.pids.every(p => p.alive)]), [[SHOWN, 'emulator-1', vars.ANDROID_SERIAL, true]]);
    const lock = doc.locks.find(entry => entry.lock === 'emulator-1');
    assert.deepEqual([lock.device, lock.kind, lock.lease_id, lock.emulator.serial], ['emulator', 'lease', SHOWN, vars.ANDROID_SERIAL]);
    const text = (await f.run(['status'], { inventory: real })).out.join('\n');
    assert.match(text, new RegExp(`emulator  avd hub-${SHOWN}  console port ${record.console_port}  adb server ${vars.ANDROID_ADB_SERVER_PORT}  pid ${pid('emulator')}  managed \\(lease ${SHOWN}\\)`));
    assert.match(text, /emulator  avd towe68-framing  console port 5730  adb server 15131  pid 999000002  foreign/);
    assert.match(text, /adb server  port 15131  pid 999000001  foreign/);
    assert.match(text, new RegExp(`^EMULATORS \\(the pool's own\\)\\n  ${SHOWN}  emulator-1  emulator-\\d+  adb server \\d+  avd hub-${SHOWN}  pids `, 'm'));
    for (const entry of record.pids) assert.equal(liveStart(entry.pid), entry.start, 'status touched nothing of the pool');
    assert.equal((await f.run(['release', SHOWN])).code, 0);
    f.clean();
  } finally { f.cleanup(); }
});

test('the pool never kills by name, pattern or group', () => {
  const source = readFileSync(fileURLToPath(new URL('./emulator.mjs', import.meta.url)), 'utf8');
  assert.doesNotMatch(source, /\bpkill\b|\bkillall\b|kill-server|process\.kill\(\s*-/);
});

test('teardown rescans for the lease marker after stopping, and stops a helper born during shutdown too', async () => {
  const f = fixture();
  try {
    writeFileSync(join(f.state, 'respawn'), '');
    const id = uid('respawn');
    const vars = f.exportsOf((await f.run(['lease', 'emulator', '--for', '10m', '--why', 'respawn', '--id', id])).out);
    const consolePort = Number(vars.ANDROID_SERIAL.slice('emulator-'.length));
    const released = await f.run(['release', id]);
    assert.equal(released.code, 0, released.err.join('\n'));
    const late = Number(f.read(`late-helper-${consolePort}.pid`));
    assert.ok(late > 0, 'the emulator started a helper while it shut down');
    assert.ok(gone(late), 'and the rescan stopped it');
    assert.match(released.err.join('\n'), new RegExp(`stopped pids [\\d,]*\\b${late}\\b`));
    f.clean();
  } finally { f.cleanup(); }
});

test('a lease released while its emulator boots ends the maker as CANCELLED, not as a crashed emulator', async () => {
  const f = fixture();
  try {
    const id = uid('raced');
    const { exit } = spawnCli(f, ['lease', 'emulator', '--for', '10m', '--why', 'raced', '--id', id], { FAKE_BOOT_MS: '60000' });
    assert.ok(await waitFor(() => readdirSync(f.state).some(name => /^helper-\d+\.pid$/.test(name))), 'the emulator is booting');
    const record = f.record(id);
    const released = await f.run(['release', id]);
    assert.deepEqual([released.code, released.out], [0, [`HUB_DEVICE_RELEASED emulator ${id}`]]);
    const result = await exit;
    assert.equal(result.code, 1, result.err);
    assert.match(result.err, new RegExp(`^HUB_DEVICE_CANCELLED emulator lease ${id} was released while its emulator was being made$`, 'm'));
    assert.doesNotMatch(result.err, /exited while booting/);
    for (const entry of record.pids) assert.ok(gone(entry.pid), `${entry.role} ${entry.pid} is gone`);
    assert.ok(!existsSync(join(f.root, 'locks/emulator-1.lock')));
    f.clean();
  } finally { f.cleanup(); }
});

test('--wait 0 stays prompt while another process holds the reaper lock over a doomed lease', async () => {
  const f = fixture();
  let done = () => {};
  try {
    f.env.HUB_EMULATOR_POOL = '1';
    const id = uid('expiring');
    assert.equal((await f.run(['lease', 'emulator', '--for', '1s', '--why', 'expiring', '--id', id])).code, 0);
    await settle(1100);
    const reaper = withLock('emulator-reaper', () => new Promise(resolve => { done = resolve; }), { env: f.env, log: () => {} });
    await settle(20);
    const started = Date.now();
    const busy = await f.run(['lease', 'emulator', '--for', '1m', '--why', 'now', '--wait', '0']);
    assert.ok(Date.now() - started < 2000, `took ${Date.now() - started}ms`);
    assert.equal(busy.code, 76, busy.err.join('\n'));
    assert.match(busy.err.join('\n'), new RegExp(`the emulator pool is full \\(1 of 1: ${id} of tester@`), 'the doomed lease keeps its slot until it is torn down');
    done();
    await reaper;
    const status = await f.run(['status']);
    assert.match(status.err.join('\n'), new RegExp(`^HUB_EMULATOR_REAPED ${id} emulator-1 \\(expired\\)`, 'm'));
    f.clean();
  } finally { done(); f.cleanup(); }
});

test('the s26 path still reports a failure whole: only emulator errors are cut to their first line', async () => {
  const f = fixture();
  try {
    const twoLines = () => ({ startServer: async () => { throw new Error('adb start-server failed (exit 1)\ncannot bind tcp:5037'); } });
    const s26 = await f.run(['lease', 's26', '--for', '5m', '--why', 'x', '--wait', '0'], { adbFactory: twoLines, env: { ...f.env, HUB_DEVICES: '' } });
    assert.equal(s26.code, 1);
    assert.ok(s26.err.includes('hub-device: adb start-server failed (exit 1)\ncannot bind tcp:5037'), s26.err.join('|'));
  } finally { f.cleanup(); }
});

test('release emulator never takes an empty or malformed id, and a bare `release emulator` means $HUB_LEASE_ID, never the s26', async () => {
  const f = fixture();
  try {
    const [MINE, THEIRS] = [uid('mine'), uid('theirs')];
    assert.equal((await f.run(['lease', 'emulator', '--for', '10m', '--why', 'mine', '--id', MINE])).code, 0);
    assert.equal((await f.run(['lease', 'emulator', '--for', '10m', '--why', 'theirs', '--id', THEIRS])).code, 0);
    // `hub-device release emulator "$HUB_LEASE_ID"` in a fresh shell: the id is the empty string
    const empty = await f.run(['release', 'emulator', '']);
    assert.deepEqual([empty.code, empty.out], [2, []]);
    assert.match(empty.err.join('\n'), /release emulator needs a lease id or \$HUB_LEASE_ID/);
    const bad = await f.run(['release', 'emulator', 'Not_An_Id']);
    assert.deepEqual([bad.code, bad.out], [2, []]);
    assert.match(bad.err.join('\n'), /"Not_An_Id" is not a lease id/);
    const bare = await f.run(['release', 'emulator']);
    assert.deepEqual([bare.code, bare.out], [2, []], 'no id and no $HUB_LEASE_ID: usage, not the s26 path');
    assert.doesNotMatch(bare.err.join('\n'), /s26/);
    assert.deepEqual(f.records().sort(), [`${MINE}.json`, `${THEIRS}.json`].sort(), 'both leases survive');
    for (const id of [MINE, THEIRS]) for (const entry of f.record(id).pids) assert.equal(liveStart(entry.pid), entry.start);
    await assert.rejects(releaseEmulator('', { env: f.env }), /needs a lease id/, 'the library refuses an empty id too');
    // with $HUB_LEASE_ID, a bare `release emulator` releases exactly that lease
    const own = await f.run(['release', 'emulator'], { env: { ...f.env, HUB_LEASE_ID: MINE } });
    assert.deepEqual([own.code, own.out], [0, [`HUB_DEVICE_RELEASED emulator ${MINE}`]]);
    assert.deepEqual(f.records(), [`${THEIRS}.json`], 'only that one');
    // and `release emulator` with $HUB_LEASE_ID naming nothing says so for the emulator, never the s26
    const none = await f.run(['release', 'emulator'], { env: { ...f.env, HUB_LEASE_ID: 'nobody' } });
    assert.deepEqual(none.out, ['HUB_DEVICE_NOT_HELD emulator nobody (no emulator lease by that id)']);
    assert.equal((await f.run(['release', THEIRS])).code, 0);
    f.clean();
  } finally { f.cleanup(); }
});

test('a console port range reaching into 5554-5585 is refused', async () => {
  const f = fixture();
  try {
    for (const bad of ['5554-5598', '5580-5600', '5600', '5700-5600']) {
      const result = await f.run(['lease', 'emulator', '--for', '1m', '--why', 'x'], { env: { ...f.env, HUB_EMULATOR_CONSOLE_PORTS: bad } });
      assert.equal(result.code, 2, bad);
      assert.match(result.err.join('\n'), /HUB_EMULATOR_CONSOLE_PORTS=.*LOW at least 5586/);
    }
    f.clean();
  } finally { f.cleanup(); }
});

test('--for runs from READY: a boot longer than the lease never expires it mid-boot', async () => {
  const f = fixture();
  try {
    const id = uid('slow');
    const started = Date.now();
    const leased = await f.run(['lease', 'emulator', '--for', '1s', '--why', 'slow boot', '--id', id], { env: { ...f.env, FAKE_BOOT_MS: '1500' } });
    assert.equal(leased.code, 0, leased.err.join('\n'));
    assert.ok(Date.now() - started >= 1500, 'the boot took longer than --for');
    const left = Date.parse(f.owner('emulator-1').expires_at) - Date.now();
    assert.ok(left > 0 && left <= 1000, `expires ${left}ms from now`);
    await settle(1100);
    assert.match((await f.run(['status'])).err.join('\n'), new RegExp(`^HUB_EMULATOR_REAPED ${id} emulator-1 \\(expired\\)`, 'm'));
    f.clean();
  } finally { f.cleanup(); }
});
