#!/usr/bin/env node
// hub-device: a lease on a shared phone. The phones (the S26, which deploys install on, and any further phone in
// devices.json's android_extra, currently the S24) and the emulator host serve many repos with no owner; the hub
// already owns the phones' adb connections and the host locks its deploys take. This tool lets a person or an agent
// take those same locks for a while (a lease that outlives this process), have the phone connected for them, and
// see what else runs around it. Waiters are served first in, first out. `status` only looks at what is not the
// hub's own.
//
// Each phone is leased by name (`s24`, `s26`) under its own lock — the S26's lock is `adb`, the one deploys take,
// so a lease and a deploy still exclude each other — or as `phone`, whichever phone is free and reachable, tried
// s24 first (an ordered try with --wait as one overall budget; see takeAnyPhone). `HUB_DEVICE` in the exports and
// the JSON says which one a `phone` lease took.
//
// `emulator` is a throwaway emulator from a small pool instead (emulator.mjs): made for the lease, with its own AVD and adb
// server, and torn down at release or expiry. Every invocation first reaps the pool's expired and abandoned leases.
//
//   hub-device lease s24|s26|phone --for 30m --why "device proof" [--wait 2m] [--no-connect] [--id ID] [--pid N] [--holder WHO]
//                    [--env-serial NAME]... [--json] [--verbose]
//   hub-device release [<lease_id>|--any]    (no id: $HUB_LEASE_ID; --any: whichever lease holds a phone)
//   hub-device status [--json]
//   hub-device run s24|s26|phone [--for 1h] [--why TEXT] [--wait 2m] [--holder WHO] [--env-serial NAME]... [--verbose] -- <cmd...>
//   hub-device lease emulator [--profile default|playstore] --for 30m --why TEXT [--wait 2m] [--id ID] [--pid N] [--holder WHO]
//                    [--env-serial NAME]... [--json]
//   hub-device run emulator [--profile default|playstore] [--for 1h] [--why TEXT] [--wait 2m] [--env-serial NAME]... -- <cmd...>
//   (--pool N asks for a smaller pool than the host's; it can never raise it)
//   hub-device release emulator <lease_id>   (a bare id or $HUB_LEASE_ID that names an emulator lease works too)
//
// Exit codes: 0 done; 1 the lease was cancelled or the tool failed; 75 the phone is away (stdout is exactly
// `HUB_DEVICE_AWAY <device>`); 76 the lock (or a pool slot) was not free within --wait (`HUB_DEVICE_BUSY <device> ...` on stderr); 2 usage;
// run returns the command's own code (128+N when a signal ended it).
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { constants, homedir, hostname } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { findPhone, idMatchesSerial } from '../ci/lib/adb.mjs';
import { loadDevices } from '../ci/lib/devices.mjs';
import { MAX_LEASE_MS, acquireLease, isLease, listLocks, listWaiters, lockDir, readOwner, releaseLease, updateLease } from '../ci/lib/lock.mjs';
import { pause, sleep as realSleep } from '../ci/lib/pause.mjs';
import { createAsyncAdb } from './async-adb.mjs';
import { GATE, LEASE_ID, PROFILES, emulatorStatus, exportsOf as emulatorExports, hostPool, isEmulatorLease, isEmulatorLock, provision, readRecord, reap, releaseEmulator, teardownNow } from './emulator.mjs';
import { inventory } from './inventory.mjs';

const readOwnerOf = (name, env) => readOwner(join(lockDir(env), `${name}.lock`));

// The phones this tool can lease, in the order `phone` prefers them. The S26 is the deploy phone (devices.android):
// it sits under the `adb` host lock deploys take — its lock name can never change — and every further phone
// (devices.android_extra) gets a lock of its own lowercased name. Nothing but hub-device reads android_extra.
export function fleetOf(devices) {
  const deploy = { device: 's26', lock: 'adb', deploy: true, name: devices.android.name, serial: devices.android.serial, model: devices.android.model };
  const extras = (devices.android_extra ?? []).map(entry => {
    const device = entry.name.toLowerCase();
    return { device, lock: device, deploy: false, name: entry.name, serial: entry.serial, model: entry.model };
  });
  return [...extras, deploy];
}

const PHONE = 'phone';
const nameOf = (fleet, lock) => (isEmulatorLock(lock) ? 'emulator' : fleet.find(phone => phone.lock === lock)?.device ?? null);

// A device word names one phone (its fleet entry), `phone` (whichever is free), or `emulator`.
function resolveDevice(fleet, word) {
  if (word === 'emulator' || word === PHONE) return null;
  const phone = fleet.find(entry => entry.device === word);
  if (!phone) throw usage(`unknown device "${word ?? ''}" (known: ${[...fleet.map(entry => entry.device), PHONE, 'emulator'].join(', ')})`);
  return phone;
}

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

const USAGE = 'usage: hub-device lease s24|s26|phone --for <dur> --why <text> [--wait <dur>] [--no-connect] [--id ID] [--pid N] [--holder WHO] [--env-serial NAME]... [--json] [--verbose] | lease emulator [--profile NAME] --for <dur> --why <text> [--wait <dur>] [--id ID] [--pid N] [--holder WHO] [--env-serial NAME]... [--json] | release [emulator] [<lease_id>|--any] | status [--json] | run s24|s26|phone|emulator [--profile NAME] [--for <dur>] [--why <text>] [--wait <dur>] [--holder WHO] [--env-serial NAME]... [--verbose] -- <cmd...>';

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

function setup(parsed, { needForWhy, fleet, env }) {
  const { flags } = parsed;
  const device = parsed.words[1] ?? null;
  // The device word is checked first, as before, so a typo never reads as a missing flag.
  const entry = device === 'emulator' ? null : resolveDevice(fleet, device);
  // A lease id names one lease: with more than one phone lock, the same --id could otherwise name two live leases
  // (or a waiter and a lease), and `release <id>` would free only the first it meets.
  if (flags.id !== undefined) {
    const onPhone = fleet.find(phone => {
      const owner = readOwnerOf(phone.lock, env);
      return (isLease(owner) && owner.lease_id === flags.id) || listWaiters(phone.lock, { env }).some(waiter => waiter.lease_id === flags.id);
    });
    if (onPhone) throw usage(`--id ${flags.id} already names a lease or a waiter on ${onPhone.device}; a lease id names one lease`);
    if (isEmulatorLease(env, flags.id)) throw usage(`--id ${flags.id} already names an emulator lease; a lease id names one lease`);
  }
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
  return { device, entry, forMs, why, waitMs, holderPid: pid };
}

// Takes the lease on one phone, then (unless noConnect) connects it. A phone that does not come gives the lease back;
// a lease released or reclaimed while the phone was being found ends as HUB_LEASE_CANCELLED holding nothing.
async function takeLease(phone, options, context) {
  const { env, log, timing } = context;
  const lease = await acquireLease(phone.lock, { ...options, env, log, pollMs: timing.leasePollMs, sleep: timing.sleep, now: timing.now });
  const port = String(env.HUB_ADB_SERVER_PORT || '5037');
  const device = { phone: phone.device, serial: null, adb_id: null, adb_port: Number(port) };
  if (!options.noConnect) {
    try {
      const adbEnv = { ...env, ANDROID_ADB_SERVER_PORT: port };
      delete adbEnv.ANDROID_SERIAL;
      const adb = context.adbFactory
        ? context.adbFactory({ env: adbEnv, signal: options.signal })
        : createAsyncAdb({ env: adbEnv, signal: options.signal });
      device.adb_id = await findPhone(adb, { serial: phone.serial, model: phone.model, waitMs: options.phoneWaitMs, pollMs: timing.phonePollMs, sleep: timing.sleep, now: timing.now, label: 'HUB_PHONE', log, signal: options.signal });
      // `serial` names the phone itself, not the adb id, which changes with each wireless endpoint.
      device.serial = phone.serial;
    } catch (error) {
      // The lease may already be gone (released or reclaimed mid-discovery): only then is a give-back ours to make.
      const owner = readOwnerOf(phone.lock, env);
      if (owner?.kind !== 'lease' || owner.lease_id !== lease.lease_id) {
        throw Object.assign(new Error(`lease ${lease.lease_id} was released while the phone was being found`), { code: 'HUB_LEASE_CANCELLED' });
      }
      releaseLease(phone.lock, lease.lease_id, { env });
      throw error;
    }
    if (!updateLease(phone.lock, lease.lease_id, { device }, { env })) {
      // The lease was released or reclaimed while the phone was being found; take nothing.
      throw Object.assign(new Error(`lease ${lease.lease_id} was released while the phone was being found`), { code: 'HUB_LEASE_CANCELLED' });
    }
  }
  return { phone, lease, device };
}

// The verdict when no phone came within --wait: BUSY when every phone stayed held (one may still free), AWAY when a
// free phone never appeared (turn it on, or pair it again). The message names each phone and what kept it.
function noPhoneError(fleet, states, waitMs, context) {
  const held = fleet.filter(phone => states.get(phone.device) === 'held');
  if (held.length === fleet.length) {
    const locks = listLocks({ env: context.env });
    const by = held.map(phone => `${phone.device} (${phone.lock}) is held by ${locks.find(entry => entry.name === phone.lock)?.describe ?? 'someone'}`).join('; ');
    throw Object.assign(new Error(`every phone is held: ${by}; gave up after ${Math.round(waitMs / 1000)}s`), { code: 'HUB_LOCK_TIMEOUT' });
  }
  const reasons = fleet.map(phone => `${phone.device} ${states.get(phone.device) ?? 'absent'}`).join(', ');
  const awayStates = [...new Set([...states.values()].filter(state => state !== 'held'))].join(', ') || 'absent';
  throw Object.assign(new Error(`no free phone came within the wait: ${reasons}`), { code: 'HUB_PHONE_AWAY', reason: awayStates });
}

// `phone`: whichever phone is free and reachable, tried in fleet order (the extras, then the deploy phone) with
// --wait as one overall budget. Each pass takes a free lock and gives that phone a slice of what is left to appear
// (HUB_DEVICE_PHONE_SLICE_MS, default 10s), then falls through to the next phone on AWAY; when none came it waits a
// poll tick and tries again, so a phone that frees or appears mid-wait is picked up. It does not queue FIFO behind
// another `phone` taker (the ordered try wins at the next poll); single-device leases still queue FIFO on their own
// locks, and a lease that frees is taken by whichever caller's poll sees it first.
async function takeAnyPhone(fleet, options, context) {
  const { env, timing } = context;
  const sliceMs = Number(env.HUB_DEVICE_PHONE_SLICE_MS) || 10_000;
  const deadline = timing.now() + options.waitMs;
  const states = new Map();
  for (;;) {
    for (const phone of fleet) {
      const left = deadline - timing.now();
      try {
        return await takeLease(phone, { ...options, waitMs: 0, phoneWaitMs: left > 0 ? Math.min(sliceMs, left) : 0 }, context);
      } catch (error) {
        if (error.code === 'HUB_LOCK_TIMEOUT') { states.set(phone.device, 'held'); continue; }
        if (away(error)) { states.set(phone.device, error.reason ?? 'absent'); continue; }
        throw error;
      }
    }
    if (timing.now() >= deadline) break;
    await pause(timing.leasePollMs, { signal: options.signal, sleep: timing.sleep });
  }
  options.signal?.throwIfAborted();
  throw noPhoneError(fleet, states, options.waitMs, context);
}

function exportsOf(lease, device, envSerial, phone) {
  const vars = { HUB_LEASE_ID: lease.lease_id, HUB_DEVICE: phone };
  vars.ANDROID_ADB_SERVER_PORT = String(device.adb_port);
  if (device.adb_id) {
    vars.ANDROID_SERIAL = device.adb_id;
    for (const name of envSerial) vars[name] = device.adb_id;
  }
  return vars;
}

function report(error, parsed, context) {
  const { stdout, stderr } = context;
  const device = parsed.words[1] ?? 's26';
  if (error instanceof Usage || error.code === 'HUB_EMULATOR_USAGE') { stderr(`hub-device: ${error.message}`); return 2; }
  // A cancelled lease says so even when its last error was the phone not arriving: it never held anything to report.
  if (error.code === 'HUB_LEASE_CANCELLED') { stderr(`HUB_DEVICE_CANCELLED ${device} ${error.message}`); return 1; }
  if (away(error)) {
    stdout(`HUB_DEVICE_AWAY ${device}`);
    // The reason is always said: absent is "turn it on", unauthorized is "pair it again", offline is "wake it".
    stderr(`hub-device: ${device} is away: ${error.reason ?? error.message.split('\n')[0]}`);
    if (parsed.flags.verbose) stderr(`hub-device: ${error.message.split('\n')[0]}`);
    return 75;
  }
  if (error.code === 'HUB_LOCK_TIMEOUT') { stderr(`HUB_DEVICE_BUSY ${device} ${error.message}`); return 76; }
  stderr(`hub-device: ${device === 'emulator' ? error.message.split('\n')[0] : error.message}`);
  return 1;
}

// --profile and --pool belong to the emulator. The pool's size is the host's (hostPool); --pool may only ask for fewer.
function emulatorOptions(parsed, env) {
  if (parsed.flags['no-connect']) throw usage('--no-connect is for a phone; an emulator is always made and connected');
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
  const { forMs, why, waitMs, holderPid } = setup(parsed, { needForWhy: true, fleet: context.fleet, env: context.env });
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
  const { entry, forMs, why, waitMs, holderPid } = setup(parsed, { needForWhy: true, fleet: context.fleet, env: context.env });
  const holder = parsed.flags.holder ?? env.HUB_DEVICE_HOLDER ?? `${env.USER ?? 'unknown'}@${hostname()}`;
  warnOldHub(context);
  const abort = new AbortController();
  let received = null;
  const onSignal = signal => { received ??= signal; abort.abort(); };
  const names = ['SIGINT', 'SIGTERM', 'SIGHUP'];
  for (const name of names) signals.on(name, onSignal);
  try {
    const options = { holder, why, forMs, waitMs, id: parsed.flags.id ?? null, holderPid, noConnect: Boolean(parsed.flags['no-connect']), phoneWaitMs: waitMs, signal: abort.signal };
    const { phone, lease: record, device } = entry ? await takeLease(entry, options, context) : await takeAnyPhone(context.fleet, options, context);
    if (received) {
      releaseLease(phone.lock, record.lease_id, { env });
      return 128 + constants.signals[received];
    }
    const vars = exportsOf(record, device, parsed.envSerial, phone.device);
    if (parsed.flags.json) stdout(JSON.stringify({ lease_id: record.lease_id, device: phone.device, holder, why, expires_at: record.expires_at, env: vars }));
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
  const fleet = context.fleet;
  // `release emulator [<id>]` (no id: $HUB_LEASE_ID), or an id (given or $HUB_LEASE_ID) that names an emulator lease;
  // everything else is a phone's. An empty or malformed emulator id is refused: lock.mjs reads an empty id as any lease.
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
    if (candidate && isEmulatorLease(env, candidate)) return releaseEmulatorCommand(candidate, context);
  }
  if (parsed.flags.any && parsed.words[1]) throw usage('release takes --any or an id, not both');
  const id = parsed.flags.any ? null : parsed.words[1] ?? env.HUB_LEASE_ID ?? null;
  if (!id && !parsed.flags.any) { stderr('hub-device: release needs a lease id, $HUB_LEASE_ID, or --any to free whichever lease holds a phone'); return 2; }
  const lockExists = lock => { try { statSync(join(lockDir(env), `${lock}.lock`)); return true; } catch { return false; } };
  if (id) {
    // The phone whose lock holds the lease, or whose queue is still waiting for it.
    let found = fleet.find(phone => {
      const owner = readOwnerOf(phone.lock, env);
      return isLease(owner) && owner.lease_id === id;
    }) ?? null;
    if (!found) found = fleet.find(phone => listWaiters(phone.lock, { env }).some(waiter => waiter.lease_id === id)) ?? null;
    if (!found) {
      stdout(`HUB_DEVICE_NOT_HELD phone ${id} (no phone lease by that id)`);
      for (const phone of fleet) {
        const owner = readOwnerOf(phone.lock, env);
        if (!owner && !lockExists(phone.lock)) continue;
        if (!owner) stderr(`hub-device: ${phone.device} is being taken (its lock has no owner record yet); left alone`);
        else if (isLease(owner)) stderr(`hub-device: ${phone.device} is leased as ${owner.lease_id} (${owner.holder ?? 'someone'}), not ${id}; left alone`);
        else stderr(`hub-device: ${phone.device} is held by a deploy job now; left alone`);
      }
      return 0;
    }
    const result = releaseLease(found.lock, id, { env });
    if (result.cancelled && !result.released) {
      stdout(`HUB_DEVICE_CANCELLED ${found.device} ${id} (it was still waiting)`);
      return 0;
    }
    switch (result.reason) {
      case 'released':
        stdout(`HUB_DEVICE_RELEASED ${found.device} ${result.owner.lease_id}`);
        return 0;
      case 'not-a-lease':
        stdout(`HUB_DEVICE_NOT_HELD phone ${id}`);
        stderr(`hub-device: ${found.device} is held by a deploy job now; left alone`);
        return 0;
      case 'unknown-holder':
        stderr(`hub-device: ${found.device} is being taken (its lock has no owner record yet); left alone, try again`);
        return 1;
      default:
        stderr(`hub-device: ${found.device} changed hands while it was being released; left alone, check \`hub-device status\``);
        return 1;
    }
  }
  // --any: whichever phone lease is held, in fleet order. A phone held by a deploy job (or mid-take) does not stop
  // the others being freed; --any refuses only when no phone yielded a release, and then names the first refusal.
  let refusal = null;
  for (const phone of fleet) {
    const result = releaseLease(phone.lock, null, { env });
    switch (result.reason) {
      case 'released':
        stdout(`HUB_DEVICE_RELEASED ${phone.device} ${result.owner.lease_id}`);
        return 0;
      case 'none':
        continue;
      case 'not-a-lease':
        refusal ??= `hub-device: ${phone.device} is held by a deploy job, not a lease; left alone`;
        continue;
      case 'unknown-holder':
        refusal ??= `hub-device: ${phone.device} is being taken (its lock has no owner record yet); left alone, try again`;
        continue;
      default:
        refusal ??= `hub-device: ${phone.device} changed hands while it was being released; left alone, check \`hub-device status\``;
        continue;
    }
  }
  if (refusal) { stderr(refusal); return 1; }
  stdout('HUB_DEVICE_NOT_HELD phone - (no phone is held)');
  return 0;
}

function age(ms) {
  const s = Math.round(ms / 1000);
  if (s < 90) return `${s}s`;
  if (s < 5400) return `${Math.round(s / 60)}m`;
  return `${(s / 3600).toFixed(1)}h`;
}

// Which phones are on the adb server, without connecting to any of them: `adb devices` (a query) plus `adb mdns
// services` (to tie a bare host:port id, what a manual `adb connect` leaves, back to its serial). Only asked when
// the inventory shows the server already running, so status can never start one; anything it cannot answer says
// so instead of failing. The query goes to the hub's server whatever the caller's environment says (a stray
// ANDROID_ADB_SERVER_PORT would ask the wrong server — and start one if it were down), and both queries are
// bounded: the race is settled within 5s and its abort kills a wedged query child at once, so status never
// lingers on a slow one.
async function phonePresence(fleet, context, found) {
  const { env, adbFactory, timing } = context;
  const notes = new Map(fleet.map(phone => [phone.device, 'no adb server']));
  const hubPort = Number(env.HUB_ADB_SERVER_PORT) || 5037;
  if (!found.adb_servers.some(server => server.port === hubPort)) return notes;
  const queryEnv = { ...env, ANDROID_ADB_SERVER_PORT: String(hubPort) };
  delete queryEnv.ANDROID_SERIAL;
  const stopQuery = new AbortController();   // kills the query children the moment presence is done with them
  const giveUp = new AbortController();      // clears the race's timer once it settles
  try {
    const adb = adbFactory ? adbFactory({ env: queryEnv, signal: stopQuery.signal }) : createAsyncAdb({ env: queryEnv, signal: stopQuery.signal });
    const asked = adb.devices();
    asked.catch(() => {});   // the race below may stop waiting first
    const services = (adb.mdnsServices ? adb.mdnsServices() : Promise.resolve(new Map()));
    services.catch(() => {});
    // A query that fails (no adb on this host's paths, a wedged server) is an answer, not a failure: status never fails on it.
    const answered = await Promise.race([Promise.all([asked.then(found => found, () => null), services.then(found => found, () => null)]), timing.sleep(5000, giveUp.signal).then(() => null)]);
    if (!answered) { for (const phone of fleet) notes.set(phone.device, 'adb did not answer'); return notes; }
    const [listed, mdns] = answered;
    if (!listed) { for (const phone of fleet) notes.set(phone.device, 'adb did not answer'); return notes; }
    for (const phone of fleet) {
      const entry = listed.find(device => idMatchesSerial(device.id, phone.serial, mdns ?? new Map()));
      notes.set(phone.device, entry?.state === 'device' ? 'reachable' : entry?.state ?? 'absent');
    }
    return notes;
  } finally {
    giveUp.abort();
    stopQuery.abort();
  }
}

async function status(parsed, context) {
  const { env, stdout, timing } = context;
  const fleet = context.fleet;
  const nowMs = timing.now();
  const locks = listLocks({ env, now: timing.now }).map(entry => {
    const owner = entry.owner ?? {};
    const lease = isLease(owner);
    return {
      lock: entry.name, device: nameOf(fleet, entry.name), kind: entry.kind, stale: entry.stale,
      lease_id: lease ? owner.lease_id : null, holder: lease ? owner.holder : null, why: lease ? owner.why : null,
      repo: owner.repo ?? null, run: owner.run ?? null, pid: owner.pid ?? null, holder_pid: owner.holder_pid ?? null,
      started_at: owner.started_at ?? null, expires_at: lease ? owner.expires_at : null, phone: owner.device ?? null,
      emulator: owner.emulator ?? null,
    };
  });
  const waiters = [];
  for (const name of new Set([...fleet.map(phone => phone.lock), GATE, ...locks.map(entry => entry.lock)])) {
    listWaiters(name, { env }).forEach((waiter, index) => waiters.push({ lock: name, device: nameOf(fleet, name), position: index + 1, lease_id: waiter.lease_id, holder: waiter.holder, why: waiter.why, since: waiter.enqueued_at, stale: waiter.stale }));
  }
  const found = (context.inventory ?? inventory)({ lockRoot: lockDir(env), hubAdbPort: Number(env.HUB_ADB_SERVER_PORT) || 5037 });
  const reach = await phonePresence(fleet, context, found);
  const phones = fleet.map(phone => {
    const lock = locks.find(entry => entry.lock === phone.lock) ?? null;
    const owner = lock?.kind === 'lease' ? { lease_id: lock.lease_id, holder: lock.holder, why: lock.why, expires_at: lock.expires_at, adb_id: lock.phone?.adb_id ?? null } : null;
    return {
      device: phone.device, lock: phone.lock, deploy: phone.deploy, name: phone.name, model: phone.model, serial: phone.serial,
      held: lock ? lock.kind : 'free', holder: owner?.holder ?? null, lease_id: owner?.lease_id ?? null, why: owner?.why ?? null,
      expires_at: owner?.expires_at ?? null, adb_id: owner?.adb_id ?? null, repo: lock?.repo ?? null, run: lock?.run ?? null,
      presence: reach.get(phone.device) ?? 'absent',
    };
  });
  // The pool's own processes are managed and carry their lease id: a pid counts only while it is still the recorded process.
  const emulators = emulatorStatus(env);
  const owners = new Map(emulators.flatMap(entry => entry.pids.filter(pid => pid.alive).map(pid => [pid.pid, entry.lease_id])));
  for (const list of [found.adb_servers, found.emulators, found.xvfb]) {
    for (const item of list) if (owners.has(item.pid)) Object.assign(item, { managed: true, lease_id: owners.get(item.pid) });
  }
  const result = { phones, locks, waiters, inventory: found, emulators };
  if (parsed.flags.json) { stdout(JSON.stringify(result, null, 2)); return 0; }
  stdout('PHONES (read only; adb is queried, never connected)');
  for (const phone of phones) {
    const held = phone.held === 'free' ? 'free'
      : phone.held === 'lease' ? (() => {
          const left = Date.parse(phone.expires_at) - nowMs;
          return `LEASE ${phone.lease_id}  holder=${phone.holder}  ${left > 0 ? `expires in ${age(left)}` : `EXPIRED ${age(-left)} ago`}${phone.adb_id ? `  adb=${phone.adb_id}` : ''}`;
        })()
        : `JOB LOCK  ${phone.repo ?? 'a local run'} run ${phone.run ?? '-'}`;
    stdout(`  ${phone.device}  ${held}  ${phone.presence}  ${phone.model}  serial ${phone.serial}  lock ${phone.lock}${phone.deploy ? '  (the deploy phone)' : ''}`);
  }
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
  const { forMs, why, waitMs, holderPid } = setup(parsed, { needForWhy: false, fleet: context.fleet, env: context.env });
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

// Runs the command with a phone leased, and gives the lease back on every way out: success, failure, SIGINT, SIGTERM, SIGHUP.
async function runCommand(parsed, context) {
  if (parsed.words[1] === 'emulator') return runEmulator(parsed, context);
  const { env, stderr, signals } = context;
  if (!parsed.command || parsed.command.length === 0) throw usage('run needs a command after --');
  const { entry, forMs, why, waitMs, holderPid } = setup(parsed, { needForWhy: false, fleet: context.fleet, env: context.env });
  const id = `run-${process.pid}-${randomBytes(4).toString('hex')}`;
  const holder = parsed.flags.holder ?? env.HUB_DEVICE_HOLDER ?? `${env.USER ?? 'unknown'}@${hostname()}`;
  warnOldHub(context);
  let child = null;
  let received = null;
  let held = null;   // the lock of the lease once it is taken (`phone` names its phone only then)
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
  const giveBack = () => { if (held) { try { releaseLease(held, id, { env }); } catch { /* the holder_pid rule and expiry still reclaim it */ } } };
  signals.once('exit', giveBack);
  try {
    const options = { holder, why, forMs, waitMs, id, holderPid: holderPid ?? process.pid, noConnect: false, phoneWaitMs: waitMs, signal: abort.signal };
    const taking = (entry ? takeLease(entry, options, context) : takeAnyPhone(context.fleet, options, context)).then(value => { held = value.phone.lock; return value; });
    // A signal while queued for the phone drops its place; await discovery settlement before exiting.
    const taken = await Promise.race([taking.then(value => ({ value }), error => ({ error })), woken.then(() => ({ signalled: true }))]);
    if (taken.signalled) {
      giveBack();
      const settled = await taking.then(value => ({ value }), error => ({ error }));
      if (settled.value) giveBack();
      return 128 + constants.signals[received];
    }
    if (taken.error) throw taken.error;
    const { lease: record, device, phone } = taken.value;
    if (received) return 128 + constants.signals[received];
    const childEnv = { ...env, ...exportsOf(record, device, parsed.envSerial, phone.device) };
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
    // The phones this checkout's devices.json names; a broken one is a tool failure, named like any other.
    context.fleet = fleetOf(loadDevices(env));
    // The lazy reaper: before anything else, expired and abandoned emulator leases are torn down (their recorded pids only).
    if (['lease', 'release', 'status', 'run'].includes(parsed.words[0])) {
      try { await reap({ env, log: context.log, graceMs: emulator.graceMs, wait: false }); } catch (error) { stderr(`hub-device: warning: the emulator reaper failed: ${error.message}`); }
    }
    switch (parsed.words[0]) {
      case 'lease': return await lease(parsed, context);
      case 'release': return await release(parsed, context);
      case 'status': return await status(parsed, context);
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
