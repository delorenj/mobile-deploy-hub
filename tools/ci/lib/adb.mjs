// The phones over big-chungus's adb server, which holds their wireless pairings. A phone is picked by its
// ro.serialno, not by the adb id (the mDNS suffix of a wireless id changes). The hub only ever runs
// `install -r`, which updates in place and keeps the app's data; a test greps the hub for the commands that
// would not (removing the app, clearing its data, or allowing a downgrade).
import { homedir } from 'node:os';
import { join } from 'node:path';
import { androidSdk } from './android.mjs';
import { isCredentialVariable } from './config.mjs';
import { runBounded } from './exec.mjs';
import { pause, sleep as realSleep } from './pause.mjs';

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

// `adb mdns services`: every advertised phone's endpoint, by the serial in its service name (`adb-<serial>-<suffix>`).
// A serial advertising twice (two mDNS names for one phone) keeps the last listed — either endpoint reaches it.
export function parseMdnsServices(output) {
  const found = new Map();
  for (const line of output.split('\n')) {
    const [name, type, endpoint] = line.trim().split(/\s+/);
    const serial = /^adb-([A-Za-z0-9]+)-/.exec(name ?? '')?.[1];
    if (serial && type?.startsWith('_adb-tls-connect') && /^[\d.]+:\d+$/.test(endpoint ?? '')) found.set(serial, endpoint);
  }
  return found;
}

// The phone's wireless debugging endpoint, by the serial in its service name.
export const parseMdnsEndpoint = (output, serial) => parseMdnsServices(output).get(serial) ?? null;

// Whether an adb device id can be the phone with this serial, without talking to the phone: over USB the id is
// the serial itself, over Wireless debugging the mDNS auto-connect id embeds it (`adb-<serial>-<suffix>`), and a
// manual `adb connect` names the endpoint, which the mDNS service list ties back to the serial.
export function idMatchesSerial(id, serial, mdnsServices = new Map()) {
  return id === serial || id.startsWith(`adb-${serial}-`) || mdnsServices.get(serial) === id;
}

// No token reaches adb: its server outlives the job (below), and it must not carry the job's credentials with it.
export function adbEnv(given = process.env) {
  const env = {};
  for (const [name, value] of Object.entries(given)) if (!isCredentialVariable(name)) env[name] = value;
  return env;
}

// The Peek (AD-13): what a deploy run may read of the S26 while a Lease holds `adb`. Only `adb -L tcp:127.0.0.1:<port> ...`
// reads, and `-L` refuses to launch a server (adb treats only `localhost` or an empty host as a local server spec it may start,
// so `tcp:127.0.0.1:<port>` must never be "normalized" to `localhost`), so this never starts, restarts or reconnects anything the leaseholder uses: the
// only argv forms are `devices` and `-s <id> shell dumpsys package`. RUNNER_TRACKING_ID is blank, as for the server itself. The
// port and id come from the Lease's recorded `device` (hub-device takeLease), else the default server. With no id recorded
// (a Lease taken --no-connect) one `devices` listing finds it by string match on the serial. Never throws: any failure is
// `unknown`, with the reason. `installed` is null when the package is not on the phone.
export function peekInstalled({ pkg, serial, lease = null, env = process.env, home = homedir(), runner = runBounded } = {}) {
  const recorded = lease?.device ?? null;
  const port = Number.isInteger(recorded?.adb_port) && recorded.adb_port > 0 && recorded.adb_port < 65536 ? recorded.adb_port : Number(env.ANDROID_ADB_SERVER_PORT) || 5037;
  const result = { state: 'unknown', installed: null, adb_id: null, adb_port: port, reason: null };
  try {
    const adb = adbPath(env, home);
    const call = (args, timeout, label) => runner(adb, ['-L', `tcp:127.0.0.1:${port}`, ...args], { env: { ...adbEnv(env), RUNNER_TRACKING_ID: '' }, timeout, label });
    if (!pkg) { result.reason = 'no package to read'; return result; }
    let id = typeof recorded?.adb_id === 'string' && /^[\w.:-]+$/.test(recorded.adb_id) ? recorded.adb_id : null;
    if (!id) {
      if (!serial) { result.reason = 'no serial to look the phone up by'; return result; }
      const listed = parseDeviceList(call(['devices'], 15_000, 'adb peek devices'));
      id = listed.find(device => device.state === 'device' && idMatchesSerial(device.id, serial))?.id ?? null;
      if (!id) { result.reason = 'the phone is not on the adb server'; return result; }
    }
    result.adb_id = id;
    result.installed = parsePackage(call(['-s', id, 'shell', 'dumpsys', 'package', pkg], 60_000, 'adb peek dumpsys'), pkg);
    result.state = 'read';
  } catch (error) {
    result.reason = String(error?.message ?? error).split('\n')[0].slice(0, 200);
  }
  return result;
}

export function createAdb({ env: given = process.env, home = homedir(), runner = runBounded } = {}) {
  const env = adbEnv(given);
  const adb = adbPath(env, home);
  const call = (args, timeout = 30_000) => runner(adb, args, { env, timeout, label: `adb ${args.filter(arg => !arg.startsWith('/')).slice(0, 4).join(' ')}` });
  return {
    // The server must outlive the job: the runner kills a job's leftover processes by their RUNNER_TRACKING_ID, and a
    // server that dies with every job makes the next one wait for the phone's wireless reconnect. Without the id the
    // server stays up on big-chungus between jobs and runs, holding the connection like a person's adb would.
    startServer: () => runner(adb, ['start-server'], { env: { ...env, RUNNER_TRACKING_ID: '' }, timeout: 60_000, label: 'adb start-server' }),
    mdnsServices: () => parseMdnsServices(call(['mdns', 'services'], 15_000)),
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
// is slow, every few polls it looks the phone up in `adb mdns services` and connects to that endpoint itself. A phone
// that never comes throws code HUB_PHONE_AWAY with a `reason` ('unauthorized' or 'offline' when adb lists it unusable,
// 'absent' when it is not listed at all). `signal` (hub-device's interactive runs) stops the wait between calls;
// deploys pass none and see no change. `label` names the log lines (deploys keep the default HUB_S26).
// A server that will not start or list (`daemon started successfully` then `daemon still not running`, when another
// client kills or replaces the server mid-start) is retried every poll until the deadline, with a fresh start-server;
// only an adb that never lists once in the whole wait throws its last error (a broken adb stays red, never AWAY).
export async function findPhone(adb, { serial, model, waitMs = 180_000, pollMs = 3000, nudgeEvery = 5, label = 'HUB_S26', sleep = realSleep, now = Date.now, log = console.log, signal } = {}) {
  signal?.throwIfAborted();
  const deadline = now() + waitMs;
  let seen = [];
  let listedOnce = false;
  let serverError = null;
  for (let poll = 1; ; poll += 1) {
    signal?.throwIfAborted();
    try {
      if (poll === 1 || serverError) await adb.startServer();
      seen = await adb.devices();
      listedOnce = true;
      serverError = null;
    } catch (error) {
      serverError = error;
      log(`${label}_ADB_RETRY poll ${poll}: ${String(error?.message ?? error).split('\n')[0].slice(0, 200)}`);
      if (now() >= deadline) { if (!listedOnce) throw error; break; }
      await pause(pollMs, { signal, sleep });
      continue;
    }
    for (const device of seen.filter(entry => entry.state === 'device')) {
      signal?.throwIfAborted();
      let found;
      try { found = await adb.prop(device.id, 'ro.serialno'); } catch { continue; }
      if (found !== serial) continue;
      const actual = await adb.prop(device.id, 'ro.product.model');
      if (model && actual !== model) throw new Error(`adb device ${device.id} has serial ${serial} but model ${actual}, not ${model}`);
      signal?.throwIfAborted();
      log(`${label} ${model ?? ''} serial=${serial} adb=${device.id}`);
      return device.id;
    }
    if (now() >= deadline) break;
    if (poll % nudgeEvery === 0 && adb.mdnsEndpoint && adb.connect) {
      try {
        const endpoint = await adb.mdnsEndpoint(serial);
        signal?.throwIfAborted();
        if (endpoint) { log(`${label}_CONNECT ${endpoint} (mDNS lists it; auto-connect had not)`); await adb.connect(endpoint); }
      } catch { /* the next poll tries again */ }
    }
    await pause(pollMs, { signal, sleep });
  }
  signal?.throwIfAborted();
  // A phone that is listed but unusable says which way, so AWAY can name the reason. A bare host:port id (what a
  // manual `adb connect` leaves) is tied back to its serial by the mDNS service list.
  let mdns = new Map();
  if (adb.mdnsServices) { try { mdns = await adb.mdnsServices(); } catch { /* the mdns query is advisory */ } }
  const listed = seen.find(entry => entry.state !== 'device' && idMatchesSerial(entry.id, serial, mdns))?.state ?? null;
  const reason = listed ?? 'absent';
  const devicesListed = seen.map(entry => `${entry.id} (${entry.state})`).join(', ') || 'none';
  const where = listed ? `is on this host's adb server but shows ${listed}` : `is not on this host's adb server`;
  const advice = listed === 'unauthorized' ? 'Redo the Wireless debugging pairing on the phone (or accept its debugging prompt) and check `adb devices` on big-chungus' : 'Turn on Wireless debugging on the phone and check `adb devices` on big-chungus';
  throw Object.assign(new Error(`the ${model ?? 'phone'} (serial ${serial}) ${where} after ${Math.round(waitMs / 1000)}s (devices: ${devicesListed}). ${advice}`), { code: 'HUB_PHONE_AWAY', reason });
}
