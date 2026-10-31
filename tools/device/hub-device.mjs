#!/usr/bin/env node
// hub-device: a lease on the shared phone. One S26 (and one emulator host) serves many repos with no owner; the hub already
// owns the phone's adb connection and the `adb` host lock its deploys take. This tool lets a person or an agent take that
// same lock for a while (a lease that outlives this process), have the phone connected for them, and see what else runs
// around it. Waiters are served first in, first out. `status` only looks at what is not the hub's own.
//
// `emulator` is a throwaway emulator from a small pool instead (emulator.mjs): made for the lease, with its own AVD and adb
// server, and torn down at release or expiry. Every invocation first reaps the pool's expired and abandoned leases.
//
//   hub-device lease s26 --for 30m --why "device proof" [--wait 2m] [--no-connect] [--id ID] [--pid N] [--holder WHO]
//                    [--env-serial NAME]... [--json] [--verbose]
//   hub-device release [<lease_id>|--any]    (no id: $HUB_LEASE_ID; --any: whichever lease holds the phone)
//   hub-device status [--json]
//   hub-device run s26 [--for 1h] [--why TEXT] [--wait 2m] [--holder WHO] [--env-serial NAME]... [--verbose] -- <cmd...>
//   hub-device lease emulator [--profile default|playstore] --for 30m --why TEXT [--wait 2m] [--id ID] [--pid N] [--holder WHO]
//                    [--env-serial NAME]... [--json]
//   hub-device run emulator [--profile default|playstore] [--for 1h] [--why TEXT] [--wait 2m] [--env-serial NAME]... -- <cmd...>
//   (--pool N asks for a smaller pool than the host's; it can never raise it)
//   hub-device release emulator <lease_id>   (a bare id or $HUB_LEASE_ID that names an emulator lease works too)
//
// Exit codes: 0 done; 1 the lease was cancelled or the tool failed; 75 the phone is away (stdout is exactly
// `HUB_DEVICE_AWAY s26`); 76 the lock (or a pool slot) was not free within --wait (`HUB_DEVICE_BUSY <device> ...` on stderr); 2 usage;
// run returns the command's own code (128+N when a signal ended it).
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { constants, homedir, hostname } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { findPhone } from '../ci/lib/adb.mjs';
import { loadDevices } from '../ci/lib/devices.mjs';
import { MAX_LEASE_MS, acquireLease, isLease, listLocks, listWaiters, lockDir, readOwner, releaseLease, updateLease } from '../ci/lib/lock.mjs';
import { sleep as realSleep } from '../ci/lib/pause.mjs';
import { createAsyncAdb } from './async-adb.mjs';
import { GATE, LEASE_ID, PROFILES, emulatorStatus, exportsOf as emulatorExports, hostPool, isEmulatorLease, isEmulatorLock, provision, readRecord, reap, releaseEmulator, teardownNow } from './emulator.mjs';
import { inventory } from './inventory.mjs';

const readOwnerOf = (name, env) => readOwner(join(lockDir(env), `${name}.lock`));

// Devices this tool can lease, by name, and the host lock each one is.
const DEVICES = { s26: 'adb' };
const nameOf = lock => (isEmulatorLock(lock) ? 'emulator' : Object.entries(DEVICES).find(([, value]) => value === lock)?.[0] ?? null);

class Usage extends Error {}
const usage = message => new Usage(message);

export function parseDuration(text, flag = 'duration') {
  const value = String(text ?? '').trim();
  if (/^\d+$/.test(value)) return Number(value) * 1000;
  const parts = [...value.matchAll(/(\d+)([dhms])/g)];
  if (parts.length === 0 || parts.map(part => part[0]).join('') !== value) throw usage(`${flag}: "${text}" is not a duration (30s, 5m, 2h, 1h30m, or plain seconds)`);
  return parts.reduce((total, [, count, unit]) => total + Number(count) * { d: 86_400_000, h: 3_600_000, m: 60_000, s: 1000 }[unit], 0);
}

const VALUE_FLAGS = new Set(['for', 'why', 'wait', 'id', 'pid', 'holder', 'env-serial', 'profile', 'pool']);
const SWITCHES = new Set(['no-connect', 'json', 'verbose', 'any']);

// Words, flags (`--flag value` or `--flag=value`), and everything after `--` as the command.
export function parseArgs(argv) {
  const out = { words: [], flags: {}, envSerial: [], command: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--') { out.command = argv.slice(i + 1); break; }
    if (!arg.startsWith('--')) { out.words.push(arg); continue; }
    const [flag, inline] = arg.slice(2).split(/=(.*)/s);
    if (SWITCHES.has(flag)) { out.flags[flag] = true; continue; }
    if (!VALUE_FLAGS.has(flag)) throw usage(`unknown flag --${flag}`);
    const value = inline ?? argv[++i];
    if (value === undefined) throw usage(`--${flag} needs a value`);
    if (flag === 'env-serial') {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) throw usage(`--env-serial ${value}: not an environment variable name`);
      out.envSerial.push(value);
    } else out.flags[flag] = value;
  }
  return out;
}

const shellQuote = value => `'${String(value).replaceAll("'", "'\\''")}'`;
const away = error => error?.code === 'HUB_PHONE_AWAY';

const USAGE = 'usage: hub-device lease s26 --for <dur> --why <text> [--wait <dur>] [--no-connect] [--id ID] [--pid N] [--holder WHO] [--env-serial NAME]... [--json] [--verbose] | lease emulator [--profile NAME] --for <dur> --why <text> [--wait <dur>] [--id ID] [--pid N] [--holder WHO] [--env-serial NAME]... [--json] | release [emulator] [<lease_id>|--any] | status [--json] | run s26|emulator [--profile NAME] [--for <dur>] [--why <text>] [--wait <dur>] [--holder WHO] [--env-serial NAME]... [--verbose] -- <cmd...>';

// Leases are honoured only by a hub whose lock.mjs knows them. The catch-up runs from the installed release, and an
// older one sees a lease's short-lived pid as a dead job and reclaims the lock at once, so lease and run say so.
export function leaseSupport({ env = process.env, home = env.HUB_DEVICE_HOME || env.HOME || homedir() } = {}) {
  const current = join(home, '.local/share/mobile-deploy-hub/current');
  let source;
  try { source = readFileSync(join(current, 'tools/ci/lib/lock.mjs'), 'utf8'); } catch { return { current, supported: null }; }
  return { current, supported: /export async function acquireLease\b/.test(source) };
}

function warnOldHub(context) {
  const { supported, current } = leaseSupport({ env: context.env });
  if (supported === false) context.stderr(`hub-device: warning: the installed catch-up hub (${current}) predates leases and would reclaim this lease; this check cannot see the deploys' pinned hub release, so land the pin flip first (README, Devices).`);
}

function deviceLock(word) {
  const lock = DEVICES[word];
  if (!lock) throw usage(`unknown device "${word ?? ''}" (known: ${Object.keys(DEVICES).join(', ')})`);
  return lock;
}

function setup(parsed, { needForWhy }) {
  const { flags } = parsed;
  const device = parsed.words[1] ?? null;
  const lock = device === 'emulator' ? GATE : deviceLock(device);
  let forMs;
  if (flags.for !== undefined) forMs = parseDuration(flags.for, '--for');
  else if (needForWhy) throw usage('--for <duration> is required');
  else forMs = 3_600_000;
  if (forMs <= 0 || forMs > MAX_LEASE_MS) throw usage(`--for must be more than 0 and at most ${MAX_LEASE_MS / 3_600_000}h`);
  const why = flags.why ?? (needForWhy ? null : `run ${(parsed.command ?? []).join(' ').slice(0, 80)}`);
  if (!why) throw usage('--why <text> is required');
  const waitMs = flags.wait !== undefined ? parseDuration(flags.wait, '--wait') : 120_000;
  const pid = flags.pid === undefined ? null : Number(flags.pid);
  if (pid !== null && (!Number.isSafeInteger(pid) || pid < 1)) throw usage('--pid takes a live process id (a positive integer)');
  return { device, lock, forMs, why, waitMs, holderPid: pid };
}

// Takes the lease, then (unless noConnect) connects the phone. A phone that does not come gives the lease back;
// a lease released or reclaimed while the phone was being found ends as HUB_LEASE_CANCELLED holding nothing.
async function takeLease(name, options, context) {
  const { env, log, timing } = context;
  const lease = await acquireLease(name, { ...options, env, log, pollMs: timing.leasePollMs, sleep: timing.sleep, now: timing.now });
  const port = String(env.HUB_ADB_SERVER_PORT || '5037');
  const device = { serial: null, adb_id: null, adb_port: Number(port) };
  if (!options.noConnect) {
    let hardware = null;
    try {
      const devices = loadDevices(env);
      hardware = devices.android.serial;
      const adbEnv = { ...env, ANDROID_ADB_SERVER_PORT: port };
      delete adbEnv.ANDROID_SERIAL;
      const adb = context.adbFactory
        ? context.adbFactory({ env: adbEnv, signal: options.signal })
        : createAsyncAdb({ env: adbEnv, signal: options.signal });
      device.adb_id = await findPhone(adb, { serial: hardware, model: devices.android.model, waitMs: options.phoneWaitMs, pollMs: timing.phonePollMs, sleep: timing.sleep, now: timing.now, log, signal: options.signal });
      // `serial` names the phone itself (R5GL43A7PCH), not the adb id, which changes with each wireless endpoint.
      device.serial = hardware;
    } catch (error) {
      // The lease may already be gone (released or reclaimed mid-discovery): only then is a give-back ours to make.
      const owner = readOwnerOf(name, env);
      if (owner?.kind !== 'lease' || owner.lease_id !== lease.lease_id) {
        throw Object.assign(new Error(`lease ${lease.lease_id} was released while the phone was being found`), { code: 'HUB_LEASE_CANCELLED' });
      }
      releaseLease(name, lease.lease_id, { env });
      throw error;
    }
    if (!updateLease(name, lease.lease_id, { device }, { env })) {
      // The lease was released or reclaimed while the phone was being found; take nothing.
      throw Object.assign(new Error(`lease ${lease.lease_id} was released while the phone was being found`), { code: 'HUB_LEASE_CANCELLED' });
    }
  }
  return { lease, device };
}

function exportsOf(lease, device, envSerial) {
  const vars = { HUB_LEASE_ID: lease.lease_id };
  vars.ANDROID_ADB_SERVER_PORT = String(device.adb_port);
  if (device.adb_id) {
    vars.ANDROID_SERIAL = device.adb_id;
    for (const name of envSerial) vars[name] = device.adb_id;
  }
  return vars;
}

function report(error, parsed, context) {
  const { stdout, stderr } = context;
  const device = parsed.words[1] === 'emulator' ? 'emulator' : 's26';
  if (error instanceof Usage || error.code === 'HUB_EMULATOR_USAGE') { stderr(`hub-device: ${error.message}`); return 2; }
  // A cancelled lease says so even when its last error was the phone not arriving: it never held anything to report.
  if (error.code === 'HUB_LEASE_CANCELLED') { stderr(`HUB_DEVICE_CANCELLED ${device} ${error.message}`); return 1; }
  if (away(error)) {
    stdout('HUB_DEVICE_AWAY s26');
    if (parsed.flags.verbose) stderr(`hub-device: ${error.message.split('\n')[0]}`);
    return 75;
  }
  if (error.code === 'HUB_LOCK_TIMEOUT') { stderr(`HUB_DEVICE_BUSY ${device} ${error.message}`); return 76; }
  stderr(`hub-device: ${device === 'emulator' ? error.message.split('\n')[0] : error.message}`);
  return 1;
}

// --profile and --pool belong to the emulator. The pool's size is the host's (hostPool); --pool may only ask for fewer.
function emulatorOptions(parsed, env) {
  if (parsed.flags['no-connect']) throw usage('--no-connect is for s26; an emulator is always made and connected');
  const profile = parsed.flags.profile ?? 'default';
  if (!PROFILES[profile]) throw usage(`unknown emulator profile "${profile}" (known: ${Object.keys(PROFILES).join(', ')})`);
  const host = hostPool(env);
  if (parsed.flags.pool === undefined) return { profile, pool: host };
  const pool = Number(parsed.flags.pool);
  if (!Number.isSafeInteger(pool) || pool < 1) throw usage(`--pool takes a whole number of emulators, not "${parsed.flags.pool}"`);
  if (pool > host) throw usage(`--pool can only lower this host's emulator pool of ${host} (the host sets it: $HUB_EMULATOR_POOL or <lock dir>/emulator-pool)`);
  return { profile, pool };
}

function emulatorLine(record) {
  return `stopped pids ${record.result.signalled.join(',') || 'none (already gone)'}, deleted AVD ${record.record?.avd?.name ?? '-'}, freed ports ${record.record ? `${record.record.console_port},${record.record.adb_port},${record.record.adb_server_port}` : '-'}`;
}

async function leaseEmulator(parsed, context) {
  const { stdout, env, signals, timing } = context;
  const { forMs, why, waitMs, holderPid } = setup(parsed, { needForWhy: true });
  const { profile, pool } = emulatorOptions(parsed, env);
  const holder = parsed.flags.holder ?? env.HUB_DEVICE_HOLDER ?? `${env.USER ?? 'unknown'}@${hostname()}`;
  const id = parsed.flags.id ?? `e-${randomBytes(6).toString('hex')}`;
  const abort = new AbortController();
  let received = null;
  const onSignal = signal => { received ??= signal; abort.abort(); };
  const names = ['SIGINT', 'SIGTERM', 'SIGHUP'];
  for (const name of names) signals.on(name, onSignal);
  try {
    const { lease: record, record: emulator } = await provision({ id, holder, why, forMs, waitMs, holderPid, profileName: profile, pool, env, log: context.log, signal: abort.signal, sleep: timing.sleep, now: timing.now, pollMs: timing.leasePollMs, ...context.emulator });
    if (received) {
      await releaseEmulator(id, { env, log: context.log, graceMs: context.emulator.graceMs });
      return 128 + constants.signals[received];
    }
    const vars = emulatorExports(emulator, parsed.envSerial);
    if (parsed.flags.json) {
      const { serial, console_port, adb_port, adb_server_port, avd, pids, image, slot } = emulator;
      stdout(JSON.stringify({ lease_id: id, device: 'emulator', profile, image, slot, holder, why, expires_at: record?.expires_at ?? null, env: vars, emulator: { serial, console_port, adb_port, adb_server_port, avd: avd.name, pids } }));
    } else for (const [name, value] of Object.entries(vars)) stdout(`export ${name}=${shellQuote(value)}`);
    return 0;
  } catch (error) {
    if (received) return 128 + constants.signals[received];
    throw error;
  } finally {
    for (const name of names) signals.off(name, onSignal);
  }
}

async function lease(parsed, context) {
  if (parsed.words[1] === 'emulator') return leaseEmulator(parsed, context);
  const { stdout, env, signals } = context;
  const { lock, forMs, why, waitMs, holderPid } = setup(parsed, { needForWhy: true });
  const holder = parsed.flags.holder ?? env.HUB_DEVICE_HOLDER ?? `${env.USER ?? 'unknown'}@${hostname()}`;
  warnOldHub(context);
  const abort = new AbortController();
  let received = null;
  const onSignal = signal => { received ??= signal; abort.abort(); };
  const names = ['SIGINT', 'SIGTERM', 'SIGHUP'];
  for (const name of names) signals.on(name, onSignal);
  try {
    const options = { holder, why, forMs, waitMs, id: parsed.flags.id ?? null, holderPid, noConnect: Boolean(parsed.flags['no-connect']), phoneWaitMs: waitMs, signal: abort.signal };
    const { lease: record, device } = await takeLease(lock, options, context);
    if (received) {
      releaseLease(lock, record.lease_id, { env });
      return 128 + constants.signals[received];
    }
    const vars = exportsOf(record, device, parsed.envSerial);
    if (parsed.flags.json) stdout(JSON.stringify({ lease_id: record.lease_id, device: 's26', holder, why, expires_at: record.expires_at, env: vars }));
    else for (const [name, value] of Object.entries(vars)) stdout(`export ${name}=${shellQuote(value)}`);
    return 0;
  } catch (error) {
    if (received) return 128 + constants.signals[received];
    throw error;
  } finally {
    for (const name of names) signals.off(name, onSignal);
  }
}

// Idempotent for a named lease: one that is already gone (expired, reclaimed, released) is not an error, so an adapter can
// always call it. Without an id it releases $HUB_LEASE_ID (what `lease` exported), else whichever lease holds the phone;
// a job's lock is never touched. Each outcome says what it found.
async function releaseEmulatorCommand(id, context) {
  const { env, stdout, stderr } = context;
  const result = await releaseEmulator(id, { env, log: context.log, graceMs: context.emulator.graceMs });
  switch (result.outcome) {
    case 'released':
      stdout(`HUB_DEVICE_RELEASED emulator ${id}`);
      if (result.record) stderr(`hub-device: ${result.record.serial} on ${result.slot}: ${emulatorLine(result)}`);
      return 0;
    case 'cancelled':
      stdout(`HUB_DEVICE_CANCELLED emulator ${id} (it was still waiting)`);
      return 0;
    case 'none':
      stdout(`HUB_DEVICE_NOT_HELD emulator ${id} (no emulator lease by that id)`);
      return 0;
    default:
      stderr(`hub-device: emulator ${id}: pids ${result.result.survivors.join(',')} would not stop; ${result.slot} stays out of the pool until they do`);
      return 1;
  }
}

async function release(parsed, context) {
  const { env, stdout, stderr } = context;
  // `release emulator [<id>]` (no id: $HUB_LEASE_ID), or an id (given or $HUB_LEASE_ID) that names an emulator lease;
  // everything else is the S26's. An empty or malformed emulator id is refused: lock.mjs reads an empty id as any lease.
  if (parsed.words[1] === 'emulator') {
    if (parsed.flags.any) throw usage('release emulator takes a lease id, not --any');
    if (parsed.words.length > 3) throw usage('release emulator takes at most one lease id');
    const id = parsed.words.length === 3 ? parsed.words[2] : env.HUB_LEASE_ID;
    if (!id) throw usage('release emulator needs a lease id or $HUB_LEASE_ID (what lease exported)');
    if (!LEASE_ID.test(id)) throw usage(`release emulator: "${id}" is not a lease id (lowercase letters, digits and dashes)`);
    return releaseEmulatorCommand(id, context);
  }
  if (parsed.words.length > 2) throw usage('release takes at most one lease id');
  if (!parsed.flags.any) {
    const candidate = parsed.words[1] ?? env.HUB_LEASE_ID ?? null;
    if (isEmulatorLease(env, candidate)) return releaseEmulatorCommand(candidate, context);
  }
  if (parsed.flags.any && parsed.words[1]) throw usage('release takes --any or an id, not both');
  const id = parsed.flags.any ? null : parsed.words[1] ?? env.HUB_LEASE_ID ?? null;
  if (!id && !parsed.flags.any) { stderr('hub-device: release needs a lease id, $HUB_LEASE_ID, or --any to free whichever lease holds s26'); return 2; }
  const result = releaseLease('adb', id, { env });
  const named = id ?? '-';
  if (result.cancelled && !result.released) {
    const behind = result.reason === 'other-lease' ? ` behind lease ${result.owner.lease_id}` : result.reason === 'not-a-lease' ? ' behind a deploy job' : '';
    stdout(`HUB_DEVICE_CANCELLED s26 ${id} (it was still waiting${behind})`);
    return 0;
  }
  switch (result.reason) {
    case 'released':
      stdout(`HUB_DEVICE_RELEASED s26 ${result.owner.lease_id}`);
      return 0;
    case 'none':
      stdout(`HUB_DEVICE_NOT_HELD s26 ${named} (nothing holds s26)`);
      return 0;
    case 'other-lease':
      stdout(`HUB_DEVICE_NOT_HELD s26 ${named}`);
      stderr(`hub-device: s26 is leased as ${result.owner.lease_id} (${result.owner.holder ?? 'someone'}), not ${id}; left alone`);
      return 0;
    case 'not-a-lease':
      if (id) {
        stdout(`HUB_DEVICE_NOT_HELD s26 ${id}`);
        stderr('hub-device: s26 is held by a deploy job now; left alone');
        return 0;
      }
      stderr('hub-device: s26 is held by a deploy job, not a lease; left alone');
      return 1;
    case 'unknown-holder':
      stderr('hub-device: s26 is being taken (its lock has no owner record yet); left alone, try again');
      return 1;
    default:
      stderr('hub-device: s26 changed hands while it was being released; left alone, check `hub-device status`');
      return 1;
  }
}

function age(ms) {
  const s = Math.round(ms / 1000);
  if (s < 90) return `${s}s`;
  if (s < 5400) return `${Math.round(s / 60)}m`;
  return `${(s / 3600).toFixed(1)}h`;
}

function status(parsed, context) {
  const { env, stdout, timing } = context;
  const nowMs = timing.now();
  const locks = listLocks({ env, now: timing.now }).map(entry => {
    const owner = entry.owner ?? {};
    const lease = isLease(owner);
    return {
      lock: entry.name, device: nameOf(entry.name), kind: entry.kind, stale: entry.stale,
      lease_id: lease ? owner.lease_id : null, holder: lease ? owner.holder : null, why: lease ? owner.why : null,
      repo: owner.repo ?? null, run: owner.run ?? null, pid: owner.pid ?? null, holder_pid: owner.holder_pid ?? null,
      started_at: owner.started_at ?? null, expires_at: lease ? owner.expires_at : null, phone: owner.device ?? null,
      emulator: owner.emulator ?? null,
    };
  });
  const waiters = [];
  for (const name of new Set([...Object.values(DEVICES), GATE, ...locks.map(entry => entry.lock)])) {
    listWaiters(name, { env }).forEach((waiter, index) => waiters.push({ lock: name, device: nameOf(name), position: index + 1, lease_id: waiter.lease_id, holder: waiter.holder, why: waiter.why, since: waiter.enqueued_at, stale: waiter.stale }));
  }
  const found = (context.inventory ?? inventory)({ lockRoot: lockDir(env), hubAdbPort: Number(env.HUB_ADB_SERVER_PORT) || 5037 });
  // The pool's own processes are managed and carry their lease id: a pid counts only while it is still the recorded process.
  const emulators = emulatorStatus(env);
  const owners = new Map(emulators.flatMap(entry => entry.pids.filter(pid => pid.alive).map(pid => [pid.pid, entry.lease_id])));
  for (const list of [found.adb_servers, found.emulators, found.xvfb]) {
    for (const item of list) if (owners.has(item.pid)) Object.assign(item, { managed: true, lease_id: owners.get(item.pid) });
  }
  const result = { locks, waiters, inventory: found, emulators };
  if (parsed.flags.json) { stdout(JSON.stringify(result, null, 2)); return 0; }
  stdout('LOCKS');
  if (locks.length === 0) stdout('  none held');
  for (const entry of locks) {
    const label = `${entry.device ? `${entry.device} (${entry.lock})` : entry.lock}`;
    if (entry.kind === 'lease') {
      const left = Date.parse(entry.expires_at) - nowMs;
      const made = entry.emulator ? `  ${entry.emulator.serial} adb-server=${entry.emulator.adb_server_port}` : '';
      stdout(`  ${label}  LEASE ${entry.lease_id}  holder=${entry.holder}  why="${entry.why}"  ${left > 0 ? `expires in ${age(left)}` : `EXPIRED ${age(-left)} ago`} (${entry.expires_at})${entry.phone?.adb_id ? `  phone=${entry.phone.adb_id}` : ''}${made}${entry.stale ? '  [stale: reclaimed by the next taker]' : ''}`);
    } else {
      stdout(`  ${label}  JOB LOCK  ${entry.repo ?? 'a local run'} run ${entry.run ?? '-'}  pid=${entry.pid}  since ${entry.started_at}${entry.stale ? '  [stale]' : ''}`);
    }
  }
  stdout('WAITERS');
  if (waiters.length === 0) stdout('  none');
  for (const waiter of waiters) stdout(`  ${waiter.device ?? waiter.lock} #${waiter.position}  ${waiter.lease_id}  holder=${waiter.holder}  why="${waiter.why}"  waiting since ${waiter.since}${waiter.stale ? '  [stale]' : ''}`);
  stdout('INVENTORY (read only)');
  const tag = item => (item.managed ? `managed${item.lease_id ? ` (lease ${item.lease_id})` : ''}` : 'foreign');
  for (const server of found.adb_servers) stdout(`  adb server  port ${server.port}  pid ${server.pid}  ${tag(server)}${server.cwd ? `  cwd ${server.cwd}` : ''}`);
  for (const emulator of found.emulators) stdout(`  emulator  avd ${emulator.avd}  console port ${emulator.console_port ?? '?'}  adb server ${emulator.adb_server}  pid ${emulator.pid}  ${tag(emulator)}${emulator.cwd ? `  cwd ${emulator.cwd}` : ''}`);
  for (const display of found.xvfb) stdout(`  Xvfb  display ${display.display}  pid ${display.pid}  ${tag(display)}${display.cwd ? `  cwd ${display.cwd}` : ''}`);
  if (found.adb_servers.length + found.emulators.length + found.xvfb.length === 0) stdout('  nothing running');
  if (emulators.length > 0) {
    stdout('EMULATORS (the pool\'s own)');
    for (const entry of emulators) stdout(`  ${entry.lease_id}  ${entry.slot}  ${entry.serial}  adb server ${entry.adb_server_port}  avd ${entry.avd}  pids ${entry.pids.map(pid => `${pid.role}:${pid.pid}${pid.alive ? '' : '(gone)'}`).join(' ')}`);
  }
  return 0;
}

// Runs the command with a throwaway emulator, and tears it down on every way out: success, failure, SIGINT, SIGTERM, SIGHUP.
async function runEmulator(parsed, context) {
  const { env, stderr, signals, timing } = context;
  if (!parsed.command || parsed.command.length === 0) throw usage('run needs a command after --');
  const { forMs, why, waitMs, holderPid } = setup(parsed, { needForWhy: false });
  const { profile, pool } = emulatorOptions(parsed, env);
  const id = `run-${process.pid}-${randomBytes(4).toString('hex')}`;
  const holder = parsed.flags.holder ?? env.HUB_DEVICE_HOLDER ?? `${env.USER ?? 'unknown'}@${hostname()}`;
  let child = null;
  let received = null;
  const abort = new AbortController();
  const onSignal = signal => {
    received ??= signal;
    abort.abort();
    if (child) { child.kill(signal); setTimeout(() => child.kill('SIGKILL'), context.killGraceMs).unref(); }
  };
  const names = ['SIGINT', 'SIGTERM', 'SIGHUP'];
  for (const name of names) signals.on(name, onSignal);
  // The last resort when the process exits without the finally below: SIGKILL to the recorded processes, then the slot.
  const lastResort = () => {
    const record = readRecord(env, id);
    try { if (!record || teardownNow(record, { env })) releaseEmulatorSlotNow(record, id, env); } catch { /* the reaper finishes it */ }
  };
  signals.once('exit', lastResort);
  try {
    const { record } = await provision({ id, holder, why, forMs, waitMs, holderPid: holderPid ?? process.pid, profileName: profile, pool, env, log: context.log, signal: abort.signal, sleep: timing.sleep, now: timing.now, pollMs: timing.leasePollMs, ...context.emulator });
    if (received) return 128 + constants.signals[received];
    const childEnv = { ...env, ...emulatorExports(record, parsed.envSerial) };
    return await new Promise(done => {
      child = spawn(parsed.command[0], parsed.command.slice(1), { stdio: 'inherit', env: childEnv });
      child.on('error', error => { stderr(`hub-device: cannot run ${parsed.command[0]}: ${error.message}`); done(127); });
      child.on('close', (status, signal) => done(signal ? 128 + (constants.signals[signal] ?? 15) : status ?? 1));
      if (received) onSignal(received);
    });
  } catch (error) {
    if (received) return 128 + constants.signals[received];
    return report(error, parsed, context);
  } finally {
    try {
      const result = await releaseEmulator(id, { env, log: context.log, graceMs: context.emulator.graceMs });
      if (result.outcome === 'released' && result.record) stderr(`hub-device: ${result.record.serial} torn down: ${emulatorLine(result)}`);
      if (result.outcome === 'stuck') stderr(`hub-device: emulator ${id}: pids ${result.result.survivors.join(',')} would not stop; the next hub-device run retries`);
    } catch (error) {
      stderr(`hub-device: emulator ${id} teardown: ${error.message}; the next hub-device run retries`);
    }
    for (const name of names) signals.off(name, onSignal);
    signals.off('exit', lastResort);
  }
}

function releaseEmulatorSlotNow(record, id, env) {
  releaseLease(GATE, id, { env });
  for (const name of record ? [record.slot] : []) releaseLease(name, id, { env });
}

// Runs the command with the phone leased, and gives the lease back on every way out: success, failure, SIGINT, SIGTERM, SIGHUP.
async function runCommand(parsed, context) {
  if (parsed.words[1] === 'emulator') return runEmulator(parsed, context);
  const { env, stderr, signals } = context;
  if (!parsed.command || parsed.command.length === 0) throw usage('run needs a command after --');
  const { lock, forMs, why, waitMs, holderPid } = setup(parsed, { needForWhy: false });
  const id = `run-${process.pid}-${randomBytes(4).toString('hex')}`;
  const holder = parsed.flags.holder ?? env.HUB_DEVICE_HOLDER ?? `${env.USER ?? 'unknown'}@${hostname()}`;
  warnOldHub(context);
  let child = null;
  let received = null;
  const abort = new AbortController();
  let wake = () => {};
  const woken = new Promise(done => { wake = done; });
  const onSignal = signal => {
    received ??= signal;
    abort.abort();
    if (child) { child.kill(signal); setTimeout(() => child.kill('SIGKILL'), context.killGraceMs).unref(); } else wake();
  };
  const names = ['SIGINT', 'SIGTERM', 'SIGHUP'];
  for (const name of names) signals.on(name, onSignal);
  const giveBack = () => { try { releaseLease(lock, id, { env }); } catch { /* the holder_pid rule and expiry still reclaim it */ } };
  signals.once('exit', giveBack);
  try {
    const taking = takeLease(lock, { holder, why, forMs, waitMs, id, holderPid: holderPid ?? process.pid, noConnect: false, phoneWaitMs: waitMs, signal: abort.signal }, context);
    // A signal while queued for the phone drops its place; await discovery settlement before exiting.
    const taken = await Promise.race([taking.then(value => ({ value }), error => ({ error })), woken.then(() => ({ signalled: true }))]);
    if (taken.signalled) {
      giveBack();
      const settled = await taking.then(value => ({ value }), error => ({ error }));
      if (settled.value) giveBack();
      return 128 + constants.signals[received];
    }
    if (taken.error) throw taken.error;
    const { lease: record, device } = taken.value;
    if (received) return 128 + constants.signals[received];
    const childEnv = { ...env, ...exportsOf(record, device, parsed.envSerial) };
    const code = await new Promise(done => {
      child = spawn(parsed.command[0], parsed.command.slice(1), { stdio: 'inherit', env: childEnv });
      child.on('error', error => { stderr(`hub-device: cannot run ${parsed.command[0]}: ${error.message}`); done(127); });
      child.on('close', (status, signal) => done(signal ? 128 + (constants.signals[signal] ?? 15) : status ?? 1));
      if (received) onSignal(received);
    });
    return code;
  } catch (error) {
    return report(error, parsed, context);
  } finally {
    giveBack();
    for (const name of names) signals.off(name, onSignal);
    signals.off('exit', giveBack);
  }
}

export async function main(argv, {
  env = process.env,
  stdout = line => process.stdout.write(`${line}\n`),
  stderr = line => process.stderr.write(`${line}\n`),
  signals = process,
  adbFactory,
  inventory: inventoryImpl,
  sleep = realSleep,
  now = Date.now,
} = {}) {
  let parsed = { flags: {}, words: [], envSerial: [], command: null };
  const timing = { sleep, now, leasePollMs: Number(env.HUB_DEVICE_POLL_MS) || 1000, phonePollMs: Number(env.HUB_DEVICE_POLL_MS) || 3000 };
  const emulator = {
    graceMs: Number(env.HUB_EMULATOR_KILL_GRACE_MS) || 15_000,
    bootTimeoutMs: Number(env.HUB_EMULATOR_BOOT_TIMEOUT_MS) || 360_000,
    bootPollMs: Number(env.HUB_EMULATOR_POLL_MS) || 2000,
  };
  const context = { env, stdout, stderr, signals, adbFactory, inventory: inventoryImpl, timing, emulator, log: line => stderr(line), killGraceMs: Number(env.HUB_DEVICE_KILL_GRACE_MS) || 10_000 };
  try {
    parsed = parseArgs(argv);
    // The lazy reaper: before anything else, expired and abandoned emulator leases are torn down (their recorded pids only).
    if (['lease', 'release', 'status', 'run'].includes(parsed.words[0])) {
      try { await reap({ env, log: context.log, graceMs: emulator.graceMs, wait: false }); } catch (error) { stderr(`hub-device: warning: the emulator reaper failed: ${error.message}`); }
    }
    switch (parsed.words[0]) {
      case 'lease': return await lease(parsed, context);
      case 'release': return await release(parsed, context);
      case 'status': return status(parsed, context);
      case 'run': return await runCommand(parsed, context);
      default: throw usage(USAGE);
    }
  } catch (error) {
    return report(error, parsed, context);
  }
}

const entry = process.argv[1] ? pathToFileURL(realpathSync(process.argv[1])).href : null;
if (entry === import.meta.url) {
  // A reader that went away (`hub-device status | head -1`) is not an error.
  process.stdout.on('error', error => { if (error.code === 'EPIPE') process.exit(process.exitCode ?? 0); throw error; });
  process.exitCode = await main(process.argv.slice(2));
}
