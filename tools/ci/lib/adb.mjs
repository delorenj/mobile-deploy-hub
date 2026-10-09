// The S26 over big-chungus's adb server, which holds the wireless pairing. The phone is picked by its
// ro.serialno, not by the adb id (the mDNS suffix of a wireless id changes). The hub only ever runs
// `install -r`, which updates in place and keeps the app's data; a test greps the hub for the commands that
// would not (removing the app, clearing its data, or allowing a downgrade).
import { homedir } from 'node:os';
import { join } from 'node:path';
import { androidSdk } from './android.mjs';
import { runBounded } from './exec.mjs';

export const adbPath = (env = process.env, home = homedir()) => env.HUB_ADB || join(androidSdk(env, home), 'platform-tools/adb');

export function parseDeviceList(output) {
  return output.split('\n').map(line => line.trim()).filter(line => line && !line.startsWith('List of devices') && !line.startsWith('*'))
    .map(line => { const [id, state] = line.split(/\s+/); return { id, state }; })
    .filter(device => device.id && device.state);
}

// `dumpsys package <pkg>`: the first versionCode/versionName after the package's own "Package [pkg]" header.
export function parsePackage(output, pkg) {
  const start = output.indexOf(`Package [${pkg}]`);
  if (start === -1) return null;
  const block = output.slice(start);
  const code = /\bversionCode=(\d+)/.exec(block);
  const name = /\bversionName=(\S+)/.exec(block);
  if (!code) return null;
  return { versionCode: Number(code[1]), versionName: name?.[1] ?? null };
}

export function parseBaseApk(output) {
  return output.split('\n').map(line => line.trim()).find(line => /^package:\/\S+\/base\.apk$/.test(line))?.slice('package:'.length) ?? null;
}

export const parseSha256 = output => /\b([0-9a-f]{64})\b/.exec(output)?.[1] ?? null;

export function createAdb({ env = process.env, home = homedir(), runner = runBounded } = {}) {
  const adb = adbPath(env, home);
  const call = (args, timeout = 30_000) => runner(adb, args, { env, timeout, label: `adb ${args.filter(arg => !arg.startsWith('/')).slice(0, 4).join(' ')}` });
  return {
    startServer: () => call(['start-server'], 60_000),
    devices: () => parseDeviceList(call(['devices'])),
    prop: (id, name) => call(['-s', id, 'shell', 'getprop', name]).trim(),
    installed: (id, pkg) => parsePackage(call(['-s', id, 'shell', 'dumpsys', 'package', pkg], 60_000), pkg),
    baseApk: (id, pkg) => parseBaseApk(call(['-s', id, 'shell', 'pm', 'path', pkg])),
    sha256: (id, path) => parseSha256(call(['-s', id, 'shell', 'sha256sum', path], 120_000)),
    // In place, data kept. Nothing else in the hub installs on a phone.
    install: (id, apk) => call(['-s', id, 'install', '-r', apk], 600_000),
  };
}

// Starts the adb server if it is down (a dead server is what an idle big-chungus looks like) and waits for the
// phone, which reconnects over Wireless debugging within seconds once the server is up.
export async function findPhone(adb, { serial, model, waitMs = 90_000, pollMs = 3000, sleep = ms => new Promise(done => setTimeout(done, ms)), now = Date.now, log = console.log }) {
  adb.startServer();
  const deadline = now() + waitMs;
  let seen = [];
  for (;;) {
    seen = adb.devices();
    for (const device of seen.filter(entry => entry.state === 'device')) {
      let found;
      try { found = adb.prop(device.id, 'ro.serialno'); } catch { continue; }
      if (found !== serial) continue;
      const actual = adb.prop(device.id, 'ro.product.model');
      if (model && actual !== model) throw new Error(`adb device ${device.id} has serial ${serial} but model ${actual}, not ${model}`);
      log(`HUB_S26 ${model ?? ''} serial=${serial} adb=${device.id}`);
      return device.id;
    }
    if (now() >= deadline) break;
    await sleep(pollMs);
  }
  const listed = seen.map(entry => `${entry.id} (${entry.state})`).join(', ') || 'none';
  throw new Error(`the ${model ?? 'phone'} (serial ${serial}) is not on this host's adb server after ${Math.round(waitMs / 1000)}s (devices: ${listed}). Turn on Wireless debugging on the phone and check \`adb devices\` on big-chungus`);
}
