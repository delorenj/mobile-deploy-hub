#!/usr/bin/env node
// hub-device: a lease on a shared phone. The phones (the S26, which deploys install on, and any further phone in
// devices.json's android_extra, currently the S24) and the emulator host serve many repos with no owner; the hub
// already owns the phones' adb connections and the host locks its deploys take. This tool lets a person or an agent
// take those same locks for a while (a lease that outlives this process), have the phone connected for them, and
// see what else runs around it. Waiters are served first in, first out. `status` only looks at what is not the
// hub's own.
//
// Each phone is leased by name (`s24`, `s26`) under its own lock — the S26's lock is `adb`, the one deploys take,
// so a lease and a deploy still exclude each other — or as `phone`, whichever phone is free and reachable, s24 first.
// `phone` holds a place in line: one request that waits in the queue of every phone with --wait as one overall budget and takes
// the first that serves it, so no later taker jumps it (lock.mjs acquirePool; see claims.mjs). `HUB_DEVICE` in the exports and
// the JSON says which one a `phone` lease took.
//
// `emulator` is a throwaway emulator from a small pool instead (emulator.mjs): made for the lease, with its own AVD and adb
// server, and torn down at release or expiry. Acquiring an emulator (lease or run) first reaps the pool's expired and abandoned
// leases; `status` reaps nothing and writes nothing (FR-13).
//
//   hub-device lease s24|s26|phone --for 30m --why "device proof" [--wait 2m] [--no-connect] [--id ID] [--pid N] [--holder WHO]
//                    [--env-serial NAME]... [--json] [--verbose]
//   hub-device lease --match <key=value[,key>=n][,key<=n]> --for 30m --why "device proof" [--wait 2m] ...   (a phone by Capability instead of by name:
//                    the matcher (registry/match.mjs) picks the phones that fit, a dedicated-QA phone only for a request that names it or asks for
//                    dedicated_qa, and the first that serves it is taken as one Pool request that holds a place in every match's queue; no match is HUB_NO_MATCH (exit 2) with a reason for each
//                    Resource left out, every match away is HUB_DEVICE_AWAY (75); report lines say `match:<query>` where a device word goes;
//                    `run --match <query> ... -- <cmd...>` is the same for run)
//   hub-device release [<lease_id>|--any]    (no id: $HUB_LEASE_ID; --any: whichever lease holds a phone; a `job:` id is a deploy job's place in
//                    line, not a lease: exit 2, HUB_DEVICE_JOB_ID names the run to cancel)
//   hub-device status [--json]   (read only: locks, every waiter with its position and live ETA, the Reservations, the inventory; --json
//                    gives every row its `resource` and its `reachability` {state, checked_at, age_ms, stale}, read over the adb wire on the
//                    Linux host and through devicectl on the Mac, and none at all on a host that does not know its key)
//   hub-device discover [--json]   (read only: the devices this host can see that no Resource names, with model, serial and adb id; the hub's
//                    adb server over its wire on the Linux host (never started or connected), devicectl on the Mac; exits 1 when the transport
//                    did not answer, 0 for an empty list or no adb server)
//   hub-device run s24|s26|phone [--for 1h] [--why TEXT] [--wait 2m] [--holder WHO] [--env-serial NAME]... [--verbose] -- <cmd...>
//   hub-device lease emulator [--profile default|playstore] --for 30m --why TEXT [--wait 2m] [--id ID] [--pid N] [--holder WHO]
//                    [--env-serial NAME]... [--json]
//   hub-device run emulator [--profile default|playstore] [--for 1h] [--why TEXT] [--wait 2m] [--env-serial NAME]... -- <cmd...>
//   (--pool N asks for a smaller pool than the host's; it can never raise it)
//   hub-device release emulator <lease_id>   (a bare id or $HUB_LEASE_ID that names an emulator lease works too)
//   hub-device reservation release --run <owner--repo--run> [--name adb|mac-ios] [--json]   (a deploy run's Reservation on this host; the
//                    hub's announce job runs it over ssh on the Mac. Exits 0 whether or not one was held: HUB_DEVICE_RESERVATION_RELEASED or
//                    HUB_DEVICE_RESERVATION_NONE)
//
// This file is argument parsing and output only: every action and every rule lives in claims.mjs (AD-24), which the Hub API
// and the Host Agent call too, so no front door can take, refuse or report one action differently.
//
// Exit codes: 0 done; 1 the lease was cancelled or the tool failed; 75 the phone is away (stdout is exactly
// `HUB_DEVICE_AWAY <device>`); 76 the lock (or a pool slot) was not free within --wait (`HUB_DEVICE_BUSY <device> ...` on stderr); 2 usage;
// run returns the command's own code (128+N when a signal ended it).
import { spawn } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { constants, homedir, hostname } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { formatEta } from '../ci/lib/eta.mjs';
import { sleep as realSleep } from '../ci/lib/pause.mjs';
import { canonical, parseQuery } from '../registry/match.mjs';
import { NO_ANSWER, NO_DEVICECTL, NO_SERVER } from '../registry/reachability.mjs';
import * as claims from './claims.mjs';

// This tool's own parse and usage refusals; the library's carry the same code, so both exit 2 through the table.
class Usage extends Error { code = 'HUB_USAGE'; }
const usage = message => new Usage(message);

export function parseDuration(text, flag = 'duration') {
  const value = String(text ?? '').trim();
  if (/^\d+$/.test(value)) return Number(value) * 1000;
  const parts = [...value.matchAll(/(\d+)([dhms])/g)];
  if (parts.length === 0 || parts.map(part => part[0]).join('') !== value) throw usage(`${flag}: "${text}" is not a duration (30s, 5m, 2h, 1h30m, or plain seconds)`);
  return parts.reduce((total, [, count, unit]) => total + Number(count) * { d: 86_400_000, h: 3_600_000, m: 60_000, s: 1000 }[unit], 0);
}

const VALUE_FLAGS = new Set(['for', 'why', 'wait', 'id', 'pid', 'holder', 'env-serial', 'profile', 'pool', 'run', 'name', 'match']);
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

const USAGE = 'usage: hub-device lease s24|s26|phone --for <dur> --why <text> [--wait <dur>] [--no-connect] [--id ID] [--pid N] [--holder WHO] [--env-serial NAME]... [--json] [--verbose] | lease emulator [--profile NAME] --for <dur> --why <text> [--wait <dur>] [--id ID] [--pid N] [--holder WHO] [--env-serial NAME]... [--json] | release [emulator] [<lease_id>|--any] | status [--json] | discover [--json] | reservation release --run <key> [--name adb|mac-ios] [--json] | run s24|s26|phone|emulator [--profile NAME] [--for <dur>] [--why <text>] [--wait <dur>] [--holder WHO] [--env-serial NAME]... [--verbose] -- <cmd...> | lease --match <query> --for <dur> --why <text> [--wait <dur>] [--no-connect] [--id ID] [--pid N] [--holder WHO] [--env-serial NAME]... [--json] [--verbose] | run --match <query> [--for <dur>] [--why <text>] [--wait <dur>] [--holder WHO] [--env-serial NAME]... [--verbose] -- <cmd...>';

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

// The flags every lease and run share, checked in the order the CLI always checked them: the device word, then --id's
// uniqueness, --for's bounds (and a deploy phone's cap), --why, --wait and --pid. The rules are the library's.
// With --match there is no device word: the --for, --why, --wait, --pid and --id checks run first, and the matcher last, so a usage
// mistake never reads as a missing phone.
function setup(parsed, { needForWhy, fleet, env, policy = null, context }) {
  const { flags } = parsed;
  const device = parsed.words[1] ?? null;
  const matching = flags.match !== undefined;
  if (matching && device !== null) throw usage(`${parsed.words[0]} takes a device word or --match, not both`);
  // The device word is checked first, as before, so a typo never reads as a missing flag.
  const resolved = matching ? { kind: 'pool', by: 'match', members: fleet } : claims.resolve(device, { fleet, env, ids: false });
  claims.checkLeaseId(flags.id, { fleet, env });
  let forMs;
  if (flags.for !== undefined) forMs = parseDuration(flags.for, '--for');
  else if (needForWhy) throw usage('--for <duration> is required');
  else forMs = 3_600_000;
  const bounded = claims.checkBounds(resolved, { forMs, forText: flags.for, fleet, policy });
  const why = flags.why ?? (needForWhy ? null : `run ${(parsed.command ?? []).join(' ').slice(0, 80)}`);
  if (!why) throw usage('--why <text> is required');
  const waitMs = flags.wait !== undefined ? parseDuration(flags.wait, '--wait') : 120_000;
  const holderPid = claims.checkPid(flags.pid);
  const target = matching ? claims.matchTarget(flags.match, { forMs }, context) : bounded;
  return { device, target, forMs, why, waitMs, holderPid };
}

// What report lines call the device: the word, or `match:<canonical query>` for --match (the raw text when it does not parse).
function labelOf(parsed) {
  if (parsed.flags.match === undefined) return parsed.words[1] ?? 's26';
  try { return `match:${canonical(parseQuery(parsed.flags.match))}`; } catch { return `match:${parsed.flags.match}`; }
}

function report(error, parsed, context) {
  const { stdout, stderr } = context;
  const device = labelOf(parsed);
  const code = claims.exitCodeOf(error);
  // These exit 2 like a usage error, but say what they are.
  if (error.code === 'HUB_NO_MATCH' || error.code === 'HUB_POOL_CROSS_HOST') { stderr(`${error.code} ${device} ${error.message}`); return code; }
  if (code === claims.EXIT_CODES.HUB_USAGE) { stderr(`hub-device: ${error.message}`); return code; }
  // A cancelled lease says so even when its last error was the phone not arriving: it never held anything to report.
  if (error.code === 'HUB_LEASE_CANCELLED') { stderr(`HUB_DEVICE_CANCELLED ${device} ${error.message}`); return code; }
  if (code === claims.EXIT_CODES.HUB_PHONE_AWAY) {
    stdout(`HUB_DEVICE_AWAY ${device}`);
    // The reason is always said: absent is "turn it on", unauthorized is "pair it again", offline is "wake it".
    stderr(`hub-device: ${device} is away: ${error.reason ?? error.message.split('\n')[0]}`);
    if (parsed.flags.verbose) stderr(`hub-device: ${error.message.split('\n')[0]}`);
    return code;
  }
  if (code === claims.EXIT_CODES.HUB_LOCK_TIMEOUT) { stderr(`HUB_DEVICE_BUSY ${device} ${error.message}`); return code; }
  stderr(`hub-device: ${device === 'emulator' ? error.message.split('\n')[0] : error.message}`);
  return code;
}

function emulatorLine(record) {
  return `stopped pids ${record.result.signalled.join(',') || 'none (already gone)'}, deleted AVD ${record.record?.avd?.name ?? '-'}, freed ports ${record.record ? `${record.record.console_port},${record.record.adb_port},${record.record.adb_server_port}` : '-'}`;
}

async function leaseEmulator(parsed, context) {
  const { stdout, env, signals } = context;
  const { target, forMs, why, waitMs, holderPid } = setup(parsed, { needForWhy: true, fleet: context.fleet, env: context.env, policy: context.policy, context });
  const { profile, pool } = claims.emulatorBounds({ noConnect: parsed.flags['no-connect'], profile: parsed.flags.profile, pool: parsed.flags.pool }, env);
  const holder = parsed.flags.holder ?? env.HUB_DEVICE_HOLDER ?? `${env.USER ?? 'unknown'}@${hostname()}`;
  const id = parsed.flags.id ?? claims.newLeaseId('emulator');
  const abort = new AbortController();
  let received = null;
  const onSignal = signal => { received ??= signal; abort.abort(); };
  const names = ['SIGINT', 'SIGTERM', 'SIGHUP'];
  for (const name of names) signals.on(name, onSignal);
  try {
    const taken = await claims.take(target, { id, holder, why, forMs, waitMs, holderPid, profile, pool, signal: abort.signal }, context);
    const { lease: record, record: emulator } = taken;
    if (received) {
      await claims.releaseEmulator(id, context);
      return 128 + constants.signals[received];
    }
    const vars = claims.leaseExports(taken, parsed.envSerial);
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
  const { target, forMs, why, waitMs, holderPid } = setup(parsed, { needForWhy: true, fleet: context.fleet, env: context.env, policy: context.policy, context });
  const holder = parsed.flags.holder ?? env.HUB_DEVICE_HOLDER ?? `${env.USER ?? 'unknown'}@${hostname()}`;
  warnOldHub(context);
  const abort = new AbortController();
  let received = null;
  const onSignal = signal => { received ??= signal; abort.abort(); };
  const names = ['SIGINT', 'SIGTERM', 'SIGHUP'];
  for (const name of names) signals.on(name, onSignal);
  try {
    const options = { holder, why, forMs, waitMs, id: parsed.flags.id ?? null, holderPid, noConnect: Boolean(parsed.flags['no-connect']), phoneWaitMs: waitMs, signal: abort.signal };
    const taken = await claims.take(target, options, context);
    const { phone, lease: record } = taken;
    if (received) {
      claims.releaseHeld(phone.lock, record.lease_id, { env });
      return 128 + constants.signals[received];
    }
    const vars = claims.leaseExports(taken, parsed.envSerial);
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

function printEmulatorRelease(result, context) {
  const { stdout, stderr } = context;
  const { id } = result;
  switch (result.outcome) {
    case 'released':
      stdout(`HUB_DEVICE_RELEASED emulator ${id}`);
      if (result.record) stderr(`hub-device: ${result.record.serial} on ${result.slot}: ${emulatorLine(result)}`);
      return claims.EXIT_OK;
    case 'cancelled':
      stdout(`HUB_DEVICE_CANCELLED emulator ${id} (it was still waiting)`);
      return claims.EXIT_OK;
    case 'none':
      stdout(`HUB_DEVICE_NOT_HELD emulator ${id} (no emulator lease by that id)`);
      return claims.EXIT_OK;
    default:
      stderr(`hub-device: emulator ${id}: pids ${result.result.survivors.join(',')} would not stop; ${result.slot} stays out of the pool until they do`);
      return claims.EXIT_FAILURE;
  }
}

// `reservation release --run <key> [--name adb|mac-ios]`: a deploy run's Reservation (AD-7, Story 2.6), released through the
// library on this host. Without --name every reservable name here is tried. Exits 0 when nothing is reserved, so the hub's
// announce job (which runs it over ssh on the Mac) never has to tell the two apart.
function reservationCommand(parsed, context) {
  const { stdout } = context;
  if (parsed.words[1] !== 'release' || parsed.words.length > 2) throw usage('reservation takes: release --run <key> [--name adb|mac-ios] [--json]');
  const key = parsed.flags.run;
  if (!key) throw usage('reservation release needs --run <key> (owner--repo--run, what the deploy run reserved)');
  const released = claims.releaseReservations({ key, name: parsed.flags.name }, context);
  if (parsed.flags.json) stdout(JSON.stringify({ run: key, released }));
  else if (released.length === 0) stdout(`HUB_DEVICE_RESERVATION_NONE ${key}`);
  else for (const entry of released) stdout(`HUB_DEVICE_RESERVATION_RELEASED ${entry.name} ${entry.key}`);
  return claims.EXIT_OK;
}

function printPhoneRelease(result, { any, id }, context) {
  const { stdout, stderr } = context;
  let verdict = null;
  let code = claims.EXIT_OK;
  if (any) {
    if (result.outcome === 'released') verdict = `HUB_DEVICE_RELEASED ${result.device} ${result.leaseId}`;
    else if (result.outcome === 'refused') code = claims.EXIT_FAILURE;
    else verdict = 'HUB_DEVICE_NOT_HELD phone - (no phone is held)';
  } else {
    switch (result.outcome) {
      case 'none': verdict = `HUB_DEVICE_NOT_HELD phone ${id} (no phone lease by that id)`; break;
      case 'cancelled': verdict = `HUB_DEVICE_CANCELLED ${result.device} ${id} (it was still waiting)`; break;
      case 'released': verdict = `HUB_DEVICE_RELEASED ${result.device} ${result.leaseId}`; break;
      case 'job-held': verdict = `HUB_DEVICE_NOT_HELD phone ${id}`; break;
      default: code = claims.EXIT_FAILURE;
    }
  }
  if (verdict) stdout(verdict);
  if (result.refusal) stderr(`hub-device: ${result.refusal}`);
  for (const note of result.notes) stderr(`hub-device: ${note}`);
  return code;
}

// Idempotent for a named lease: one that is already gone (expired, reclaimed, released) is not an error, so an adapter can
// always call it. Without an id it releases $HUB_LEASE_ID (what `lease` exported), else whichever lease holds the phone;
// a job's lock is never touched. Each outcome says what it found.
async function release(parsed, context) {
  const { env, stderr } = context;
  // A deploy job's ticket id is its place in line, not a lease: nothing here can release it, so say which run to cancel.
  const given = parsed.flags.any ? null : parsed.words[1] === 'emulator' ? parsed.words[2] ?? env.HUB_LEASE_ID : parsed.words[1] ?? env.HUB_LEASE_ID;
  const job = claims.jobTicket(given);
  if (job) { stderr(`HUB_DEVICE_JOB_ID ${job.message}`); return claims.exitCodeOf(job); }
  // `release emulator [<id>]` (no id: $HUB_LEASE_ID); everything else is an id (given or $HUB_LEASE_ID) that the library
  // finds on an emulator or a phone, or --any.
  if (parsed.words[1] === 'emulator') {
    if (parsed.flags.any) throw usage('release emulator takes a lease id, not --any');
    if (parsed.words.length > 3) throw usage('release emulator takes at most one lease id');
    const id = claims.checkEmulatorLeaseId(parsed.words.length === 3 ? parsed.words[2] : env.HUB_LEASE_ID);
    return printEmulatorRelease(await claims.release({ emulator: id }, context), context);
  }
  if (parsed.words.length > 2) throw usage('release takes at most one lease id');
  if (parsed.flags.any && parsed.words[1]) throw usage('release takes --any or an id, not both');
  const id = parsed.flags.any ? null : parsed.words[1] ?? env.HUB_LEASE_ID ?? null;
  if (!id && !parsed.flags.any) throw usage('release needs a lease id, $HUB_LEASE_ID, or --any to free whichever lease holds a phone');
  const result = await claims.release(parsed.flags.any ? { any: true } : { id }, context);
  return result.kind === 'emulator' ? printEmulatorRelease(result, context) : printPhoneRelease(result, { any: Boolean(parsed.flags.any), id }, context);
}

function age(ms) {
  const s = Math.round(ms / 1000);
  if (s < 90) return `${s}s`;
  if (s < 5400) return `${Math.round(s / 60)}m`;
  return `${(s / 3600).toFixed(1)}h`;
}

async function status(parsed, context) {
  const { stdout, timing } = context;
  const nowMs = timing.now();
  // The host key says which Resources this host may read. A host that does not know which host it is still shows status:
  // every reading is then missing (unknown, stale), never reachable.
  let key = null;
  try { key = (context.hostKey ?? claims.hostKey)({ env: context.env }); } catch (error) { if (error?.code !== 'HUB_HOST_UNKNOWN') throw error; }
  const result = await claims.statusView(key, { audience: 'local' }, context);
  const { phones, locks, waiters, reservations, inventory: found, emulators } = result;
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
  for (const waiter of waiters) {
    const dash = value => value ?? '-';
    const place = `${waiter.device ?? waiter.lock} #${waiter.position}`;
    const what = waiter.kind === 'job' || waiter.kind === 'hub-job'
      ? `${waiter.kind === 'hub-job' ? 'CATCH-UP' : 'JOB'} ${dash(waiter.repo)} run ${dash(waiter.run)} job ${dash(waiter.job)}`
      : `${dash(waiter.lease_id)}  holder=${dash(waiter.holder)}  why="${dash(waiter.why)}"`;
    const estimate = waiter.stale ? '' : `  eta=${formatEta(waiter.eta)}`;
    // A Pool request is listed once, with its place in every member's queue.
    const pooled = waiter.positions ? `  pool ${waiter.pool} (${Object.entries(waiter.positions).map(([lock, position]) => `${lock} #${position}`).join(', ')})` : '';
    stdout(`  ${place}  ${what}  waiting since ${dash(waiter.since)}${estimate}${waiter.stale ? '  [stale]' : ''}${pooled}`);
  }
  // A deploy target that is held, waited on or reserved gets one line: deploys install to it, and a lease on it holds them back.
  const targets = new Map();
  const targetOf = row => {
    if (!targets.has(row.resource)) targets.set(row.resource, { lock: row.lock, entry: null, waiting: 0, reserved: 0 });
    return targets.get(row.resource);
  };
  for (const entry of locks) if (entry.deploy_target === true) targetOf(entry).entry = entry;
  for (const waiter of waiters) {
    if (waiter.stale) continue;
    // A Pool request waits on every lock it has a place in, so it counts for each of those that is a deploy target.
    if (waiter.positions) {
      for (const lock of Object.keys(waiter.positions)) {
        const phone = phones.find(entry => entry.lock === lock);
        if (phone?.deploy === true) targetOf({ resource: phone.device, lock }).waiting += 1;
      }
    } else if (waiter.deploy_target === true) targetOf(waiter).waiting += 1;
  }
  for (const entry of reservations) if (entry.deploy_target === true && !entry.stale) targetOf(entry).reserved += 1;
  for (const [resource, target] of targets) {
    const lock = target.entry;
    const held = lock === null ? 'free'
      : `${lock.kind === 'lease' ? `held by LEASE ${lock.lease_id} holder=${lock.holder}` : `held by JOB LOCK ${lock.repo ?? 'a local run'} run ${lock.run ?? '-'}`}${lock.stale ? '  [stale]' : ''}`;
    stdout(`DEPLOY TARGET ${resource} (lock ${target.lock})  ${held}  ${target.waiting} waiting${target.reserved > 0 ? `  ${target.reserved} reserved` : ''}  deploys install here; a lease on it holds deploys back`);
  }
  if (reservations.length > 0) {
    stdout('RESERVATIONS');
    for (const entry of reservations) {
      const label = entry.device ? `${entry.device} (${entry.lock})` : entry.lock;
      const grace = entry.grace?.state === 'running' ? `running until ${entry.grace.ends_at}` : entry.grace?.state ?? '-';
      const left = Date.parse(entry.expires_at) - nowMs;
      const expiry = left > 0 ? `expires in ${age(left)}` : `expired ${age(-left)} ago`;
      stdout(`  ${label}  ${entry.run_key ?? '-'}  place ${entry.place}  grace ${grace}  ${expiry} (${entry.expires_at ?? '-'})${entry.blocking ? '  [blocking]' : ''}${entry.stale ? '  [expired]' : ''}`);
    }
  }
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

// The devices this host can see that no Resource names (FR-4). The host key picks the transport and an unknown one fails (exit 1, the
// hostKey message): which host this is is its identity, never a guess (AD-47). Exit 1 only when the transport did not answer.
async function discover(parsed, context) {
  const { stdout } = context;
  if (parsed.words.length > 1) throw usage('discover takes no argument');
  const key = (context.hostKey ?? claims.hostKey)({ env: context.env });
  const result = await claims.discover(key, context);
  const code = result.note === NO_ANSWER || result.note === NO_DEVICECTL ? 1 : 0;
  if (parsed.flags.json) { stdout(JSON.stringify(result, null, 2)); return code; }
  const lines = result.devices.map(device => `  ${device.serial ?? '-'}  ${device.model ?? '-'}  id ${device.id ?? '-'}  ${device.state ?? '-'}`);
  if (result.host === 'mac') {
    stdout('DISCOVER (read only; devicectl on this Mac)');
    stdout('  discovery of the iPad is by devicectl; the Mac\'s adb is not the hub\'s, so no Android device is listed');
    for (const line of lines) stdout(line);
    if (result.note === null && lines.length === 0) stdout('  none unregistered');
  } else {
    stdout(`DISCOVER (read only; adb server port ${result.port}, never started or connected)`);
    for (const line of lines) stdout(line);
    if (result.note === null && lines.length === 0) stdout('  none unregistered');
  }
  if (result.note !== null) stdout(`  ${result.note === NO_SERVER ? `${NO_SERVER} (nothing was started)` : result.note}`);
  return code;
}

// Runs the command with a throwaway emulator, and tears it down on every way out: success, failure, SIGINT, SIGTERM, SIGHUP.
async function runEmulator(parsed, context) {
  const { env, stderr, signals } = context;
  if (!parsed.command || parsed.command.length === 0) throw usage('run needs a command after --');
  const { target, forMs, why, waitMs, holderPid } = setup(parsed, { needForWhy: false, fleet: context.fleet, env: context.env, context });
  const { profile, pool } = claims.emulatorBounds({ noConnect: parsed.flags['no-connect'], profile: parsed.flags.profile, pool: parsed.flags.pool }, env);
  const id = claims.newLeaseId('run');
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
  const lastResort = () => claims.releaseEmulatorNow(id, { env });
  signals.once('exit', lastResort);
  try {
    const taken = await claims.take(target, { id, holder, why, forMs, waitMs, holderPid: holderPid ?? process.pid, profile, pool, signal: abort.signal }, context);
    if (received) return 128 + constants.signals[received];
    const childEnv = { ...env, ...claims.leaseExports(taken, parsed.envSerial) };
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
      const result = await claims.releaseEmulator(id, context);
      if (result.outcome === 'released' && result.record) stderr(`hub-device: ${result.record.serial} torn down: ${emulatorLine(result)}`);
      if (result.outcome === 'stuck') stderr(`hub-device: emulator ${id}: pids ${result.result.survivors.join(',')} would not stop; the next hub-device run retries`);
    } catch (error) {
      stderr(`hub-device: emulator ${id} teardown: ${error.message}; the next hub-device run retries`);
    }
    for (const name of names) signals.off(name, onSignal);
    signals.off('exit', lastResort);
  }
}

// Runs the command with a phone leased, and gives the lease back on every way out: success, failure, SIGINT, SIGTERM, SIGHUP.
async function runCommand(parsed, context) {
  if (parsed.words[1] === 'emulator') return runEmulator(parsed, context);
  const { env, stderr, signals } = context;
  if (!parsed.command || parsed.command.length === 0) throw usage('run needs a command after --');
  const { target, forMs, why, waitMs, holderPid } = setup(parsed, { needForWhy: false, fleet: context.fleet, env: context.env, policy: context.policy, context });
  const id = claims.newLeaseId('run');
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
  const giveBack = () => { if (held) { try { claims.releaseHeld(held, id, { env }); } catch { /* the holder_pid rule and expiry still reclaim it */ } } };
  signals.once('exit', giveBack);
  try {
    const options = { holder, why, forMs, waitMs, id, holderPid: holderPid ?? process.pid, noConnect: false, phoneWaitMs: waitMs, signal: abort.signal };
    const taking = claims.take(target, options, context).then(value => { held = value.phone.lock; return value; });
    // A signal while queued for the phone drops its place; await discovery settlement before exiting.
    const taken = await Promise.race([taking.then(value => ({ value }), error => ({ error })), woken.then(() => ({ signalled: true }))]);
    if (taken.signalled) {
      giveBack();
      const settled = await taking.then(value => ({ value }), error => ({ error }));
      if (settled.value) giveBack();
      return 128 + constants.signals[received];
    }
    if (taken.error) throw taken.error;
    if (received) return 128 + constants.signals[received];
    const childEnv = { ...env, ...claims.leaseExports(taken.value, parsed.envSerial) };
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
  adbWire,
  devicectl,
  hostKey,
  inventory: inventoryImpl,
  sleep = realSleep,
  now = Date.now,
  policy = null,
  qaDevices,
  registry,
} = {}) {
  let parsed = { flags: {}, words: [], envSerial: [], command: null };
  const context = {
    ...claims.createContext({ env, sleep, now, log: line => stderr(line), warn: message => stderr(`hub-device: warning: ${message}`), adbFactory, adbWire, devicectl, hostKey, inventory: inventoryImpl, policy, qaDevices, registry }),
    stdout, stderr, signals, killGraceMs: Number(env.HUB_DEVICE_KILL_GRACE_MS) || 10_000,
  };
  try {
    parsed = parseArgs(argv);
    // `--run` and `--name` belong to `reservation release` alone: every other command still refuses them as unknown flags (AD-17: exit 2 stays exit 2).
    if (parsed.words[0] !== 'reservation') for (const flag of ['run', 'name']) if (parsed.flags[flag] !== undefined) throw usage(`unknown flag --${flag}`);
    // `--match` belongs to `lease` and `run` alone.
    if (parsed.flags.match !== undefined && parsed.words[0] !== 'lease' && parsed.words[0] !== 'run') throw usage('unknown flag --match');
    // The phones this checkout's devices.json names; a broken one is a tool failure, named like any other.
    context.fleet = claims.loadFleet(env);
    switch (parsed.words[0]) {
      case 'lease': return await lease(parsed, context);
      case 'release': return await release(parsed, context);
      case 'status': return await status(parsed, context);
      case 'discover': return await discover(parsed, context);
      case 'reservation': return reservationCommand(parsed, context);
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
