// Dedicated QA phones (MOBI-48): the phones the owner donated to the hub as QA devices, as the hub works with them. One derivation
// for both consumers, hub-device (its lease takes the phone and gives QA tools a server to use) and the catch-up (it installs the
// current build of every hub app under the phone's own lock).
//
// A dedicated phone is declared in the private QA file (lib/qa-devices.mjs) and must also be an `android_extra` phone in devices.json
// (same serial, same model): the lock is the lowercase name, so the lease on that name is the reservation. The deploy phone can never
// be dedicated, and a dedicated phone without a valid `allowed_users` list is refused: the hub installs only to those Android users.
//
// The hub-owned adb server. Only one adb server can own a phone's USB interface, so a dedicated phone gets exactly one server of the
// hub's: a fixed port per phone (`HUB_QA_ADB_PORT_BASE`, default 5060, plus the phone's place in android_extra), started on demand by
// whoever holds the phone's lock (adb's own `start-server`, with that port in its environment), reaped when the hold ends and
// whenever a free lock still has one. It never auto-connects mDNS phones (the S26 belongs to the deploys' server), and `hub-device
// lease|run` hands the port to QA tools as ANDROID_ADB_SERVER_PORT. Another adb server already holding the phone's USB interface is
// never killed: the phone reads as away, and the reason names that server.
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { inventory } from '../../device/inventory.mjs';
import { adbEnv, adbPath, idMatchesSerial, parseDeviceList } from './adb.mjs';
import { runBounded } from './exec.mjs';
import { lockDir } from './lock.mjs';
import { readQaEntries } from './qa-devices.mjs';

export const DEFAULT_QA_PORT_BASE = 5060;
// A hub QA server's ports are a small, fixed range above the base: never the deploys' 5037, never an emulator's.
export const QA_PORT_SPAN = 20;

export function qaPortBase(env = process.env) {
  const asked = Number(env.HUB_QA_ADB_PORT_BASE);
  return Number.isInteger(asked) && asked >= 1024 && asked + QA_PORT_SPAN < 65536 ? asked : DEFAULT_QA_PORT_BASE;
}

// The dedicated phones: `{phones, problems}`. Each phone is `{name, lock, model, serial, users, port}`; every entry that cannot be
// served is a line in `problems` (by name, never by serial) and is left out. `entries` is the QA file's (a test hands its own).
export function dedicatedPhones({ devices, env = process.env, home = env.HOME || homedir(), entries } = {}) {
  const found = entries ?? readQaEntries({ env, home });
  const extra = devices.android_extra ?? [];
  const phones = [];
  const problems = [];
  for (const [index, entry] of found.entries()) {
    if (!entry.dedicated) continue;
    const label = `qa-devices entry ${index} ("${entry.name}")`;
    if (entry.serial === devices.android.serial) { problems.push(`${label} names the deploy phone, which can never be dedicated; skipped`); continue; }
    const place = extra.findIndex(phone => phone.serial === entry.serial);
    if (place === -1) { problems.push(`${label} is not an android_extra phone in devices.json; skipped`); continue; }
    const declared = extra[place];
    if (entry.model && declared.model && entry.model !== declared.model) { problems.push(`${label} has model ${entry.model}, devices.json says ${declared.model}; skipped`); continue; }
    if (!entry.allowed_users) { problems.push(`${label} has no allowed_users (a list of Android user ids); the hub installs nowhere without it, skipped`); continue; }
    phones.push({ name: declared.name, lock: declared.name.toLowerCase(), model: declared.model, serial: declared.serial, users: entry.allowed_users, port: qaPortBase(env) + place });
  }
  return { phones, problems };
}

// The dedicated phone that sits on this lock name (hub-device's lock for a phone word), or null. Never throws: a broken QA file means none.
export function dedicatedPhoneOfLock(lock, { devices, env = process.env, home = env.HOME || homedir() } = {}) {
  try { return dedicatedPhones({ devices, env, home }).phones.find(phone => phone.lock === lock) ?? null; } catch { return null; }
}

// What a client of the hub's server runs with: that server's port, none of a caller's own pins, no mDNS auto-connect (checked by adb
// when it starts the server).
export function qaAdbEnv(env, port) {
  const next = { ...adbEnv(env), ANDROID_ADB_SERVER_PORT: String(port), ADB_MDNS_AUTO_CONNECT: '0' };
  for (const name of ['ANDROID_SERIAL', 'ADB_SERVER_SOCKET', 'ANDROID_ADB_SERVER_ADDRESS']) delete next[name];
  return next;
}

const inQaRange = (port, env) => Number.isInteger(port) && port >= qaPortBase(env) && port < qaPortBase(env) + QA_PORT_SPAN;

// Stops the hub's QA server on `port`, and only that one: `kill-server` through the port's own client, never a signal, never another
// port. Refuses a port outside the QA range. Returns true when the command ran; a server that was not there is fine.
export function reapQaServer({ port, env = process.env, home = homedir(), runner = runBounded } = {}) {
  if (!inQaRange(port, env)) throw new Error(`port ${port} is not in the hub's QA adb range ${qaPortBase(env)}-${qaPortBase(env) + QA_PORT_SPAN - 1}; nothing stopped`);
  try {
    runner(adbPath(env, home), ['kill-server'], { env: qaAdbEnv(env, port), timeout: 15_000, label: 'adb kill-server (QA)' });
    return true;
  } catch { return false; }
}

// Whether the lock a phone sits on has no directory: nobody holds it, so no hub QA server has a reason to be running.
export const lockIsFree = (lock, env = process.env, home = homedir()) => !existsSync(join(lockDir(env, home), `${lock}.lock`));

// Reaps the phone's QA server when nobody holds its lock. Never throws.
export function reapIfFree(phone, { env = process.env, home = homedir(), runner = runBounded } = {}) {
  try { return lockIsFree(phone.lock, env, home) ? reapQaServer({ port: phone.port, env, home, runner }) : false; } catch { return false; }
}

// The other adb servers on this host (read from /proc) that list the phone: what keeps the hub's server off its USB interface.
// Read-only, `-L` never launches a server. Never throws.
export function foreignHolders(phone, { env = process.env, home = homedir(), runner = runBounded, procRoot, inventoryOf = inventory } = {}) {
  const held = [];
  try {
    const servers = inventoryOf({ ...(procRoot ? { procRoot } : {}), hubAdbPort: phone.port }).adb_servers.filter(server => server.port !== phone.port);
    for (const server of servers) {
      try {
        const listed = parseDeviceList(runner(adbPath(env, home), ['-L', `tcp:127.0.0.1:${server.port}`, 'devices'], { env: { ...adbEnv(env), RUNNER_TRACKING_ID: '' }, timeout: 8_000, label: 'adb devices (foreign)' }));
        if (listed.some(device => device.state === 'device' && idMatchesSerial(device.id, phone.serial))) held.push({ port: server.port, pid: server.pid, cwd: server.cwd });
      } catch { /* a server that does not answer holds nothing we can name */ }
    }
  } catch { /* no /proc here */ }
  return held;
}

// The reason line for a dedicated phone that did not come up on the hub's server.
export function awayHint(phone, holders) {
  if (holders.length === 0) return '';
  const who = holders.map(holder => `port ${holder.port} pid ${holder.pid}${holder.cwd ? ` cwd ${holder.cwd}` : ''}`).join('; ');
  return ` The phone is on another adb server that holds its USB interface (${who}); the hub never stops a server it does not own, so stop that one (or run its tool under hub-device) and the hub's server on port ${phone.port} takes the phone.`;
}
