// The emulator fakes (a fake adb server, emulator and avdmanager, all real processes) and the `fixture()` that builds a temp SDK, HOME,
// lock dir and event dir around them. Shared by the emulator suite and the Hub API's emulator lease tests (Story 7.4); no real
// emulator, AVD or adb server is touched. Moved verbatim from emulator.test.mjs.
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { heavyShim } from '../ci/test-fixtures.mjs';
import { main } from './hub-device.mjs';

const NODE = process.execPath;

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

export function fixture({ image = 'google_apis' } = {}) {
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
    PATH: `${heavyShim(join(root, 'heavy'))}:${process.env.PATH}`, HOME: join(root, 'home'), USER: 'tester', DISPLAY: ':0', WAYLAND_DISPLAY: 'wayland-0', HUB_LOCK_DIR: join(root, 'locks'), HUB_EVENT_DIR: join(root, 'events'), ANDROID_HOME: sdk, ANDROID_AVD_HOME: userAvd,
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
    root, env, state, sdk, userAvd, heavyLog: () => { try { return readFileSync(join(root, 'heavy/heavy.log'), 'utf8'); } catch { return ''; } }, run, exportsOf, record, owner, records, read, strays, clean,
    // Every pid a record named stays dead once its lease is gone; the cleanup kills nothing that is not a fake of this test.
    cleanup: () => {
      for (const file of readdirSync(state).filter(name => /^(emulator|adb-server)-\d+\.json$/.test(name))) strays.add(JSON.parse(readFileSync(join(state, file), 'utf8')).pid);
      for (const file of readdirSync(state).filter(name => /^(late-)?helper-\d+\.pid$/.test(name))) strays.add(Number(readFileSync(join(state, file), 'utf8')));
      for (const pid of strays) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone, as it should be */ } }
      rmSync(root, { recursive: true, force: true });
    },
  };
}
