// The S26 over big-chungus's adb server, which holds the wireless pairing. The phone is picked by its
// ro.serialno, not by the adb id (the mDNS suffix of a wireless id changes). The hub only ever runs
// `install -r`, which updates in place and keeps the app's data; a test greps the hub for the commands that
// would not (removing the app, clearing its data, or allowing a downgrade).
import { homedir } from 'node:os';
import { join } from 'node:path';
import { androidSdk } from './android.mjs';
import { isCredentialVariable } from './config.mjs';
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

// `dumpsys activity activities`: the package of the activity on top (topResumedActivity on Android 10+,
// mResumedActivity before), or null.
export function parseResumedPackage(output) {
  return /\b(?:topResumedActivity|mResumedActivity)[=:]\s*ActivityRecord\{\S+\s+u\d+\s+([A-Za-z][\w.]*)\//.exec(output ?? '')?.[1] ?? null;
}

// `dumpsys power`: whether the screen is on.
export const parseAwake = output => /\bmWakefulness=Awake\b/.test(output ?? '') || /Display Power: state=ON\b/.test(output ?? '');

// `adb mdns services`: the phone's wireless debugging endpoint, by the serial in its service name.
export function parseMdnsEndpoint(output, serial) {
  for (const line of output.split('\n')) {
    const [name, type, endpoint] = line.trim().split(/\s+/);
    if (name?.startsWith(`adb-${serial}-`) && type?.startsWith('_adb-tls-connect') && /^[\d.]+:\d+$/.test(endpoint ?? '')) return endpoint;
  }
  return null;
}

export function createAdb({ env: given = process.env, home = homedir(), runner = runBounded } = {}) {
  // No token reaches adb: its server outlives the job (below), and it must not carry the job's credentials with it.
  const env = {};
  for (const [name, value] of Object.entries(given)) if (!isCredentialVariable(name)) env[name] = value;
  const adb = adbPath(env, home);
  const call = (args, timeout = 30_000) => runner(adb, args, { env, timeout, label: `adb ${args.filter(arg => !arg.startsWith('/')).slice(0, 4).join(' ')}` });
  return {
    // The server must outlive the job: the runner kills a job's leftover processes by their RUNNER_TRACKING_ID, and a
    // server that dies with every job makes the next one wait for the phone's wireless reconnect. Without the id the
    // server stays up on big-chungus between jobs and runs, holding the connection like a person's adb would.
    startServer: () => runner(adb, ['start-server'], { env: { ...env, RUNNER_TRACKING_ID: '' }, timeout: 60_000, label: 'adb start-server' }),
    mdnsEndpoint: serial => parseMdnsEndpoint(call(['mdns', 'services'], 15_000), serial),
    connect: endpoint => call(['connect', endpoint], 30_000),
    devices: () => parseDeviceList(call(['devices'])),
    prop: (id, name) => call(['-s', id, 'shell', 'getprop', name]).trim(),
    installed: (id, pkg) => parsePackage(call(['-s', id, 'shell', 'dumpsys', 'package', pkg], 60_000), pkg),
    baseApk: (id, pkg) => parseBaseApk(call(['-s', id, 'shell', 'pm', 'path', pkg])),
    sha256: (id, path) => parseSha256(call(['-s', id, 'shell', 'sha256sum', path], 120_000)),
    // In place, data kept. Nothing else in the hub installs on a phone.
    install: (id, apk) => call(['-s', id, 'install', '-r', apk], 600_000),
    // Someone is playing: the app is the resumed activity and the screen is on (an install would close it mid-game).
    inUse: (id, pkg) => parseResumedPackage(call(['-s', id, 'shell', 'dumpsys', 'activity', 'activities'], 60_000)) === pkg && parseAwake(call(['-s', id, 'shell', 'dumpsys', 'power'], 60_000)),
  };
}

// Starts the adb server if it is down (a dead server is what an idle big-chungus looks like) and waits for the
// phone, which usually reconnects over Wireless debugging within seconds once the server is up. When mDNS auto-connect
// is slow, every few polls it looks the phone up in `adb mdns services` and connects to that endpoint itself.
// The optional AbortSignal is for interactive runs; deploy jobs can continue calling this unchanged.
export async function findPhone(adb, { serial, model, waitMs = 180_000, pollMs = 3000, nudgeEvery = 5, sleep = ms => new Promise(done => setTimeout(done, ms)), now = Date.now, log = console.log, signal } = {}) {
  signal?.throwIfAborted();
  await adb.startServer();
  const deadline = now() + waitMs;
  let seen = [];
  for (let poll = 1; ; poll += 1) {
    signal?.throwIfAborted();
    seen = await adb.devices();
    for (const device of seen.filter(entry => entry.state === 'device')) {
      signal?.throwIfAborted();
      let found;
      try { found = await adb.prop(device.id, 'ro.serialno'); } catch { continue; }
      if (found !== serial) continue;
      const actual = await adb.prop(device.id, 'ro.product.model');
      if (model && actual !== model) throw new Error(`adb device ${device.id} has serial ${serial} but model ${actual}, not ${model}`);
      signal?.throwIfAborted();
      log(`HUB_S26 ${model ?? ''} serial=${serial} adb=${device.id}`);
      return device.id;
    }
    if (now() >= deadline) break;
    if (poll % nudgeEvery === 0 && adb.mdnsEndpoint && adb.connect) {
      try {
        const endpoint = await adb.mdnsEndpoint(serial);
        signal?.throwIfAborted();
        if (endpoint) { log(`HUB_S26_CONNECT ${endpoint} (mDNS lists it; auto-connect had not)`); await adb.connect(endpoint); }
      } catch { /* the next poll tries again */ }
    }
    if (!signal) { await sleep(pollMs); continue; }
    await new Promise(done => {
      const timer = setTimeout(() => { signal.removeEventListener('abort', abort); done(); }, pollMs);
      const abort = () => { clearTimeout(timer); done(); };
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    });
  }
  signal?.throwIfAborted();
  const listed = seen.map(entry => `${entry.id} (${entry.state})`).join(', ') || 'none';
  throw new Error(`the ${model ?? 'phone'} (serial ${serial}) is not on this host's adb server after ${Math.round(waitMs / 1000)}s (devices: ${listed}). Turn on Wireless debugging on the phone and check \`adb devices\` on big-chungus`);
}
