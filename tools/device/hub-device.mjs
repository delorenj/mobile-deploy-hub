#!/usr/bin/env node
// hub-device: a lease on the shared phone. One S26 (and one emulator host) serves many repos with no owner; the hub already
// owns the phone's adb connection and the `adb` host lock its deploys take. This tool lets a person or an agent take that
// same lock for a while (a lease that outlives this process), have the phone connected for them, and see what else runs
// around it. Waiters are served first in, first out. `status` only looks.
//
//   hub-device lease s26 --for 30m --why "device proof" [--wait 2m] [--no-connect] [--id ID] [--pid N] [--env-serial NAME]...
//   hub-device release [<lease_id>]
//   hub-device status [--json]
//   hub-device run s26 [--for 1h] [--why TEXT] [--wait 2m] [--env-serial NAME]... -- <cmd...>
//
// Exit codes: 0 done; 75 the phone is away (stdout is exactly `HUB_DEVICE_AWAY s26`); 76 the lock was not free within --wait
// (`HUB_DEVICE_BUSY s26 ...`); 2 usage; run returns the command's own code (128+N when a signal ended it).
import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { constants, hostname } from 'node:os';
import { pathToFileURL } from 'node:url';
import { createAdb, findPhone } from '../ci/lib/adb.mjs';
import { loadDevices } from '../ci/lib/devices.mjs';
import { MAX_LEASE_MS, acquireLease, isLease, listLocks, listWaiters, lockDir, releaseLease, updateLease } from '../ci/lib/lock.mjs';
import { inventory } from './inventory.mjs';

// Devices this tool can lease, by name, and the host lock each one is.
const DEVICES = { s26: 'adb' };
const nameOf = lock => Object.entries(DEVICES).find(([, value]) => value === lock)?.[0] ?? null;

class Usage extends Error {}
const usage = message => new Usage(message);

export function parseDuration(text, flag = 'duration') {
  const value = String(text ?? '').trim();
  if (/^\d+$/.test(value)) return Number(value) * 1000;
  const parts = [...value.matchAll(/(\d+)([dhms])/g)];
  if (parts.length === 0 || parts.map(part => part[0]).join('') !== value) throw usage(`${flag}: "${text}" is not a duration (30s, 5m, 2h, 1h30m, or plain seconds)`);
  return parts.reduce((total, [, count, unit]) => total + Number(count) * { d: 86_400_000, h: 3_600_000, m: 60_000, s: 1000 }[unit], 0);
}

const VALUE_FLAGS = new Set(['for', 'why', 'wait', 'id', 'pid', 'holder', 'env-serial']);
const SWITCHES = new Set(['no-connect', 'json', 'verbose']);

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
const away = error => /is not on this host's adb server/.test(error?.message ?? '');

function deviceLock(word) {
  const lock = DEVICES[word];
  if (!lock) throw usage(`unknown device "${word ?? ''}" (known: ${Object.keys(DEVICES).join(', ')})`);
  return lock;
}

function setup(parsed, { needForWhy }) {
  const { flags } = parsed;
  const device = parsed.words[1] ?? null;
  const lock = deviceLock(device);
  let forMs;
  if (flags.for !== undefined) forMs = parseDuration(flags.for, '--for');
  else if (needForWhy) throw usage('--for <duration> is required');
  else forMs = 3_600_000;
  if (forMs <= 0 || forMs > MAX_LEASE_MS) throw usage(`--for must be more than 0 and at most ${MAX_LEASE_MS / 3_600_000}h`);
  const why = flags.why ?? (needForWhy ? null : `run ${(parsed.command ?? []).join(' ').slice(0, 80)}`);
  if (!why) throw usage('--why <text> is required');
  const waitMs = flags.wait !== undefined ? parseDuration(flags.wait, '--wait') : 120_000;
  const pid = flags.pid === undefined ? null : Number(flags.pid);
  if (pid !== null && !Number.isSafeInteger(pid)) throw usage('--pid takes a process id');
  return { device, lock, forMs, why, waitMs, holderPid: pid };
}

// Takes the lease, then (unless noConnect) connects the phone. A phone that does not come gives the lease back.
async function takeLease(name, options, context) {
  const { env, log, timing } = context;
  const lease = await acquireLease(name, { ...options, env, log, pollMs: timing.leasePollMs, sleep: timing.sleep, now: timing.now });
  const port = String(env.HUB_ADB_SERVER_PORT || '5037');
  const device = { serial: null, adb_id: null, adb_port: Number(port) };
  if (!options.noConnect) {
    try {
      const devices = loadDevices(env);
      const adbEnv = { ...env, ANDROID_ADB_SERVER_PORT: port };
      delete adbEnv.ANDROID_SERIAL;
      const adb = (context.adbFactory ?? createAdb)({ env: adbEnv });
      device.adb_id = await findPhone(adb, { serial: devices.android.serial, model: devices.android.model, waitMs: options.phoneWaitMs, pollMs: timing.phonePollMs, sleep: timing.sleep, now: timing.now, log });
      device.serial = device.adb_id;
    } catch (error) {
      releaseLease(name, lease.lease_id, { env });
      throw error;
    }
    updateLease(name, lease.lease_id, { device }, { env });
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
  if (error instanceof Usage) { stderr(`hub-device: ${error.message}`); return 2; }
  if (away(error)) {
    stdout('HUB_DEVICE_AWAY s26');
    if (parsed.flags.verbose) stderr(`hub-device: ${error.message.split('\n')[0]}`);
    return 75;
  }
  if (error.code === 'HUB_LOCK_TIMEOUT') { stdout(`HUB_DEVICE_BUSY s26 ${error.message}`); return 76; }
  if (error.code === 'HUB_LEASE_CANCELLED') { stderr(`HUB_DEVICE_CANCELLED s26 ${error.message}`); return 1; }
  stderr(`hub-device: ${error.message}`);
  return 1;
}

async function lease(parsed, context) {
  const { stdout } = context;
  const { lock, forMs, why, waitMs, holderPid } = setup(parsed, { needForWhy: true });
  const holder = parsed.flags.holder ?? context.env.HUB_DEVICE_HOLDER ?? `${context.env.USER ?? 'unknown'}@${hostname()}`;
  const options = { holder, why, forMs, waitMs, id: parsed.flags.id ?? null, holderPid, noConnect: Boolean(parsed.flags['no-connect']), phoneWaitMs: waitMs };
  const { lease: record, device } = await takeLease(lock, options, context);
  const vars = exportsOf(record, device, parsed.envSerial);
  if (parsed.flags.json) stdout(JSON.stringify({ lease_id: record.lease_id, device: 's26', holder, why, expires_at: record.expires_at, env: vars }));
  else for (const [name, value] of Object.entries(vars)) stdout(`export ${name}=${shellQuote(value)}`);
  return 0;
}

// Idempotent for a named lease: one that is already gone (expired, reclaimed, released) is not an error, so an adapter can
// always call it. Without an id it frees whatever lease holds the phone; a job's lock is never touched.
function release(parsed, context) {
  const { env, stdout, stderr } = context;
  if (parsed.words.length > 2) throw usage('release takes at most one lease id');
  const id = parsed.words[1] ?? env.HUB_LEASE_ID ?? null;
  const result = releaseLease('adb', id, { env });
  if (result.released) { stdout(`HUB_DEVICE_RELEASED s26 ${result.owner.lease_id}`); return 0; }
  if (result.cancelled) { stdout(`HUB_DEVICE_CANCELLED s26 ${id} (it was still waiting)`); return 0; }
  if (result.reason === 'none' || (id && ['other-lease', 'not-a-lease'].includes(result.reason))) {
    stdout(`HUB_DEVICE_NOT_HELD s26 ${id ?? '-'}`);
    if (result.reason !== 'none') stderr(`hub-device: s26 is held by something else now (${result.reason === 'other-lease' ? `lease ${result.owner.lease_id}` : 'a deploy job'}); left alone`);
    return 0;
  }
  stderr(`hub-device: s26 is held by a deploy job, not a lease; left alone (${result.reason})`);
  return 1;
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
    };
  });
  const waiters = [];
  for (const name of new Set([...Object.values(DEVICES), ...locks.map(entry => entry.lock)])) {
    listWaiters(name, { env }).forEach((waiter, index) => waiters.push({ lock: name, device: nameOf(name), position: index + 1, lease_id: waiter.lease_id, holder: waiter.holder, why: waiter.why, since: waiter.enqueued_at }));
  }
  const found = (context.inventory ?? inventory)({ lockRoot: lockDir(env), hubAdbPort: Number(env.HUB_ADB_SERVER_PORT) || 5037 });
  const result = { locks, waiters, inventory: found };
  if (parsed.flags.json) { stdout(JSON.stringify(result, null, 2)); return 0; }
  stdout('LOCKS');
  if (locks.length === 0) stdout('  none held');
  for (const entry of locks) {
    const label = `${entry.device ? `${entry.device} (${entry.lock})` : entry.lock}`;
    if (entry.kind === 'lease') {
      const left = Date.parse(entry.expires_at) - nowMs;
      stdout(`  ${label}  LEASE ${entry.lease_id}  holder=${entry.holder}  why="${entry.why}"  ${left > 0 ? `expires in ${age(left)}` : `EXPIRED ${age(-left)} ago`} (${entry.expires_at})${entry.phone?.adb_id ? `  phone=${entry.phone.adb_id}` : ''}${entry.stale ? '  [stale: reclaimed by the next taker]' : ''}`);
    } else {
      stdout(`  ${label}  JOB LOCK  ${entry.repo ?? 'a local run'} run ${entry.run ?? '-'}  pid=${entry.pid}  since ${entry.started_at}${entry.stale ? '  [stale]' : ''}`);
    }
  }
  stdout('WAITERS');
  if (waiters.length === 0) stdout('  none');
  for (const waiter of waiters) stdout(`  ${waiter.device ?? waiter.lock} #${waiter.position}  ${waiter.lease_id}  holder=${waiter.holder}  why="${waiter.why}"  waiting since ${waiter.since}`);
  stdout('INVENTORY (read only)');
  const tag = managed => (managed ? 'managed' : 'foreign');
  for (const server of found.adb_servers) stdout(`  adb server  port ${server.port}  pid ${server.pid}  ${tag(server.managed)}${server.cwd ? `  cwd ${server.cwd}` : ''}`);
  for (const emulator of found.emulators) stdout(`  emulator  avd ${emulator.avd}  console port ${emulator.console_port ?? '?'}  adb server ${emulator.adb_server}  pid ${emulator.pid}  ${tag(emulator.managed)}${emulator.cwd ? `  cwd ${emulator.cwd}` : ''}`);
  for (const display of found.xvfb) stdout(`  Xvfb  display ${display.display}  pid ${display.pid}  ${tag(display.managed)}${display.cwd ? `  cwd ${display.cwd}` : ''}`);
  if (found.adb_servers.length + found.emulators.length + found.xvfb.length === 0) stdout('  nothing running');
  return 0;
}

// Runs the command with the phone leased, and gives the lease back on every way out: success, failure, SIGINT, SIGTERM, SIGHUP.
async function runCommand(parsed, context) {
  const { env, stderr, signals } = context;
  if (!parsed.command || parsed.command.length === 0) throw usage('run needs a command after --');
  const { lock, forMs, why, waitMs, holderPid } = setup(parsed, { needForWhy: false });
  const id = `run-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  const holder = parsed.flags.holder ?? env.HUB_DEVICE_HOLDER ?? `${env.USER ?? 'unknown'}@${hostname()}`;
  let child = null;
  let received = null;
  let wake = () => {};
  const woken = new Promise(done => { wake = done; });
  const onSignal = signal => {
    received ??= signal;
    if (child) { child.kill(signal); setTimeout(() => child.kill('SIGKILL'), context.killGraceMs).unref(); } else wake();
  };
  const names = ['SIGINT', 'SIGTERM', 'SIGHUP'];
  for (const name of names) signals.on(name, onSignal);
  const giveBack = () => { try { releaseLease(lock, id, { env }); } catch { /* the holder_pid rule and expiry still reclaim it */ } };
  signals.once('exit', giveBack);
  try {
    const taking = takeLease(lock, { holder, why, forMs, waitMs, id, holderPid: holderPid ?? process.pid, noConnect: false, phoneWaitMs: waitMs }, context);
    // A signal while queued for the phone drops the place in the queue and ends the run.
    const taken = await Promise.race([taking.then(value => ({ value }), error => ({ error })), woken.then(() => ({ signalled: true }))]);
    if (taken.signalled) { giveBack(); return 128 + constants.signals[received]; }
    if (taken.error) throw taken.error;
    const { lease: record, device } = taken.value;
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
  sleep = ms => new Promise(done => setTimeout(done, ms)),
  now = Date.now,
} = {}) {
  let parsed = { flags: {}, words: [], envSerial: [], command: null };
  const timing = { sleep, now, leasePollMs: Number(env.HUB_DEVICE_POLL_MS) || 1000, phonePollMs: Number(env.HUB_DEVICE_POLL_MS) || 3000 };
  const context = { env, stdout, stderr, signals, adbFactory, inventory: inventoryImpl, timing, log: line => stderr(line), killGraceMs: Number(env.HUB_DEVICE_KILL_GRACE_MS) || 10_000 };
  try {
    parsed = parseArgs(argv);
    switch (parsed.words[0]) {
      case 'lease': return await lease(parsed, context);
      case 'release': return release(parsed, context);
      case 'status': return status(parsed, context);
      case 'run': return await runCommand(parsed, context);
      default: throw usage('usage: hub-device lease s26 --for <dur> --why <text> [--wait <dur>] [--no-connect] | release [<lease_id>] | status [--json] | run s26 [--for --why --wait] [--env-serial NAME]... -- <cmd...>');
    }
  } catch (error) {
    return report(error, parsed, context);
  }
}

const entry = process.argv[1] ? pathToFileURL(realpathSync(process.argv[1])).href : null;
if (entry === import.meta.url) process.exitCode = await main(process.argv.slice(2));
