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
// A phone registered through the Hub API (`registry add`, Story 6.8) is leasable the same way, by its name (`lease pixel`) or its
// Resource id (`lease res-pixel`), and is a `phone` member after the S24 and the S26: the fleet is read from registry.json in the lock
// dir on every invocation (claims.loadFleet), so there is no install and no wait, and devices.json is the fleet only while that file
// is missing or unreadable. A retired phone is refused (HUB_RESOURCE_RETIRED); one registered without a serial leases only
// with --no-connect (adb cannot find it: HUB_DEVICE_AWAY).
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
//   hub-device release [<lease_id>|--any] [--resource R] [--holder WHO]    (--resource R names the Resource, so a lease on another host is forwarded there (with no id word and no --resource, $HUB_DEVICE, which `lease` exported beside $HUB_LEASE_ID, names it; same for extend); --holder is recorded as the actor; no id: $HUB_LEASE_ID; --any: whichever lease holds a phone; a `job:` id is a deploy job's place in
//                    line, not a lease: exit 2, HUB_DEVICE_JOB_ID names the run to cancel)
//   hub-device extend [<lease_id>] --for <dur> [--override <why>] [--resource R] [--holder WHO] [--json]   (no id: $HUB_LEASE_ID; moves the expiry later by
//                    --for; refused with HUB_LEASE_EXTEND_REFUSED (exit 76) while anyone waits, past the deploy phone's 60 min or 48 h in total,
//                    or at/after expiry. --override <why> skips only the waiters check and records who and why on the `extend` event; prints
//                    HUB_DEVICE_EXTENDED <device> <id> until <iso>)
//   hub-device status [--json]   (read only: locks, every waiter with its position and live ETA, the Reservations, the inventory; on the Linux host also the
//                    other hosts' views from the Hub API's `GET /status` (`remote_hosts` in --json; `unavailable` with a reason when the API does not answer or has no view); --json
//                    gives each lock its `expected_end` (text output has none) and every row its `resource` and its `reachability` {state, checked_at, age_ms, stale}, read over the adb wire on the
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
//   hub-device registry add --kind K --name N [--model M] [--serial S] [--udid U] [--profile P] [--host H] [--cap k=v]... [--if-rev N]
//                    [--why TEXT] [--holder WHO] [--json]   (registers a Resource through the Hub API, the Registry's only writer; --host
//                    defaults to this host's key; prints HUB_DEVICE_REGISTERED <id> <name> and HUB_DEVICE_REV <rev>)
//   hub-device registry edit <id> [--name N] [--cap k=v]... [--uncap k]... [--if-rev N] [--why TEXT] [--holder WHO] [--json]
//                    (HUB_DEVICE_EDITED <id> <name>; without --if-rev it is the rev of registry.json on disk, or 0)
//   hub-device registry retire <id> [--if-rev N] [--why TEXT] [--holder WHO] [--json]   (HUB_DEVICE_RETIRED <id> <visibility>)
//   hub-device cancel <request_id> [--resource R] [--pool P] [--why TEXT] [--holder WHO] [--json]   (takes a waiting request out of the line, in every member's queue
//                    for a Pool request (`--pool phone`); never touches a Hold: one that holds its lock is `release`'s. Without --resource it looks on this host.
//                    The waiter's own wait ends HUB_DEVICE_CANCELLED naming the canceller; prints `HUB_DEVICE_CANCELLED <resource> <id>`)
//   hub-device force-release <lease_id> --why TEXT [--resource R] [--holder WHO] [--json]   (ends a Lease by force, whoever holds it, on any lock of this host (a phone, a registered
//                    phone, the iOS lane); --why is required and, with the actor, recorded on the one `force-release` event; no holder check, no confirmation. A
//                    deploy job's Hold is never ended from outside its run: HUB_FORCE_RELEASE_JOB (exit 2) names `gh run cancel`. An emulator lease id is refused (exit 2):
//                    force-release its slot (`force-release emulator-<n>`, below). A waiter is `cancel`'s. Prints `HUB_DEVICE_FORCE_RELEASED <device|lock> <id> holder=<holder>`)
//   hub-device force-release emulator-<n> --why TEXT [--holder WHO] [--json]   (ends the Lease holding an emulator slot of this host (emulator-1 to emulator-8) and tears its emulator
//                    down (Story 7.8): under the emulator-reaper lock the one `force-release` event, then the teardown and the record's removal. A crash in between leaves an
//                    ownerless record the next emulator acquire reaps as an orphan, with no second event. Processes that will not die: HUB_EMULATOR_FAILED (exit 1), the force
//                    stands. Same stdout line as above: `HUB_DEVICE_FORCE_RELEASED emulator-<n> <lease_id> holder=<holder>`)
//   hub-device force-release --reservation <run_key> --why TEXT [--name adb|mac-ios] [--holder WHO] [--json]   (ends a deploy run's Reservation by force: a dead run's
//                    Reservation is first in line on adb or mac-ios until its 3 h ceiling. --why is required and, with the actor, recorded on the one `force-release`
//                    event (`hold_kind: reservation`); no holder check, no confirmation. Without --name every reservable lock of this host is tried (`adb` from big-chungus; a `mac-ios` Reservation is on the Mac's disk and is ended there once its Host Agent serves the same call, Epic 9). Already released or
//                    never reserved: HUB_RESERVATION_NOT_FOUND (exit 2). Prints `HUB_DEVICE_RESERVATION_FORCE_RELEASED <lock> <run_key>` for each lock it ended. A deploy
//                    job never uses this: `announce` and `reservation release` write a plain release)
//   hub-device registry list [--json]   (read only, from registry.json on disk or the seed: no service is called)
//                    With the Hub API down a registry write fails plainly (HUB_API_DOWN, exit 1: nothing was sent; HUB_API_UNKNOWN, exit 1: it
//                    was sent and may have applied); leases, runs, releases and status never call the API.
//
// Other hosts (Story 9.3, AD-25, AD-48): a Hold verb on a Resource that lives on another host is forwarded to that host's front door (door `cli`, through
// hub-client.mjs; tools/device/forward.mjs has the rules) instead of being run here, so this host never writes another host's lock dir. `lease` forwards a
// device word, `emulator` or `--match` whose Resources live on one other host, and `release`, `extend`, `cancel` and
// `force-release` forward when `--resource <R>` names one (`force-release emulator-<n>` names the emulator slot). The answers print as the local verb's;
// a problem from the far side prints with its code, reason and exit; a host that does not answer is HUB_DEVICE_AWAY (75). `--pid`, `--env-serial`,
// `--profile` and `--pool` have no meaning there (exit 2), nor has `--no-connect` except on a lane, and `run` on a foreign target is HUB_WRONG_HOST (exit 2). The Linux host reads its own
// Registry; any other host asks the Hub API (`GET /resources`), else its seed at `rev: 0`. A host that does not know its key forwards nothing.
//
// The iPad lane (Story 9.4): `lease ipad` and `lease mac` take `mac-ios` (a lane: a Resource that is not a phone, with one lock on its host, in claims.mjs) with the 60 min
// deploy-target cap, from either host: on the Mac in-process, from big-chungus forwarded to the Mac (the cap is checked here first, so `--for 2h` sends nothing). The take
// is the lock only: no adb, no `ANDROID_*` export (`HUB_LEASE_ID` and `HUB_DEVICE=ios-lane`). `lease ipad` (not `mac`, not `--no-connect`) also needs the iPad reachable on
// the Mac (`HUB_DEVICE_AWAY ipad`, exit 75, the reading as the reason); `release`, `extend`, `cancel` and `force-release` find the lane by its lease id or `$HUB_DEVICE`.
//
// This file is argument parsing and output only: every action and every rule lives in claims.mjs (AD-24), which the Hub API
// and the Host Agent call too, so no front door can take, refuse or report one action differently.
//
// Exit codes: 0 done; 1 the lease was cancelled or the tool failed; 75 the phone is away (stdout is exactly
// `HUB_DEVICE_AWAY <device>`); 76 the lock (or a pool slot) was not free within --wait (`HUB_DEVICE_BUSY <device> ...` on stderr); 2 usage, or a Resource registry.json marks retired or seed-missing (`HUB_RESOURCE_RETIRED <device> ...` on stderr, nothing held);
// run returns the command's own code (128+N when a signal ended it).
import { spawn } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { constants, homedir, hostname } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { formatEta } from '../ci/lib/eta.mjs';
import { loadPolicy } from '../ci/lib/policy.mjs';
import { sleep as realSleep } from '../ci/lib/pause.mjs';
import { canonical, parseQuery } from '../registry/match.mjs';
import { NO_ANSWER, NO_DEVICECTL, NO_SERVER } from '../registry/reachability.mjs';
import { call } from '../hub-client.mjs';
import * as claims from './claims.mjs';
import { NAMED, forwardHold, hubView, namedRecords, peerView, placeOf, transportOf, withPlace, wrongHost } from './forward.mjs';

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

const VALUE_FLAGS = new Set(['for', 'why', 'wait', 'id', 'pid', 'holder', 'env-serial', 'profile', 'pool', 'run', 'name', 'match', 'kind', 'model', 'serial', 'udid', 'host', 'cap', 'uncap', 'if-rev', 'override', 'resource', 'reservation']);
const SWITCHES = new Set(['no-connect', 'json', 'verbose', 'any']);

// Words, flags (`--flag value` or `--flag=value`), and everything after `--` as the command. `--env-serial`, `--cap` and `--uncap` repeat
// (`envSerial`, `cap`, `uncap`); every other flag keeps its last value.
export function parseArgs(argv) {
  const out = { words: [], flags: {}, envSerial: [], cap: [], uncap: [], command: null };
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
    } else if (flag === 'cap' || flag === 'uncap') out[flag].push(value);
    else out.flags[flag] = value;
  }
  return out;
}

const shellQuote = value => `'${String(value).replaceAll("'", "'\\''")}'`;

const USAGE = 'usage: hub-device lease s24|s26|phone --for <dur> --why <text> [--wait <dur>] [--no-connect] [--id ID] [--pid N] [--holder WHO] [--env-serial NAME]... [--json] [--verbose] | lease ipad|mac --for <dur> --why <text> [--wait <dur>] [--no-connect] [--id ID] [--holder WHO] [--json] | lease emulator [--profile NAME] --for <dur> --why <text> [--wait <dur>] [--id ID] [--pid N] [--holder WHO] [--env-serial NAME]... [--json] | release [emulator] [<lease_id>|--any] [--resource R] [--holder WHO] | extend [<lease_id>] --for <dur> [--override <why>] [--resource R] [--holder WHO] [--json] | cancel <request_id> [--resource R] [--pool P] [--why <text>] [--holder WHO] [--json] | force-release <lease_id> --why <text> [--resource R] [--holder WHO] [--json] | force-release emulator-<n> --why <text> [--holder WHO] [--json] | force-release --reservation <run_key> --why <text> [--name adb|mac-ios] [--holder WHO] [--json] | status [--json] | discover [--json] | reservation release --run <key> [--name adb|mac-ios] [--json] | run s24|s26|phone|emulator [--profile NAME] [--for <dur>] [--why <text>] [--wait <dur>] [--holder WHO] [--env-serial NAME]... [--verbose] -- <cmd...> | lease --match <query> --for <dur> --why <text> [--wait <dur>] [--no-connect] [--id ID] [--pid N] [--holder WHO] [--env-serial NAME]... [--json] [--verbose] | run --match <query> [--for <dur>] [--why <text>] [--wait <dur>] [--holder WHO] [--env-serial NAME]... [--verbose] -- <cmd...> | registry add --kind K --name N [--model M] [--serial S] [--udid U] [--profile P] [--host H] [--cap k=v]... [--if-rev N] [--why <text>] [--holder WHO] [--json] | registry edit <id> [--name N] [--cap k=v]... [--uncap k]... [--if-rev N] [--why <text>] [--holder WHO] [--json] | registry retire <id> [--if-rev N] [--why <text>] [--holder WHO] [--json] | registry list [--json]';

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
  // The Hub API's answers to a verb that called it (the registry verbs today): the problem's own code, detail and reason, and its own exit. With --json the body is on stdout too.
  if (error.api === true || error.code === 'HUB_API_DOWN' || error.code === 'HUB_API_UNKNOWN') {
    if (error.api === true) {
      stderr(`${error.code} ${parsed.words[0]} ${error.message} (reason: ${error.reason})`);
      if (parsed.flags.json) stdout(JSON.stringify(error.problem));
      return Number.isInteger(error.exit) ? error.exit : code;
    }
    stderr(`${error.code} ${error.message}`);
    return code;
  }
  // An extension that was refused, an id that holds nothing, and a cancel that found no waiting request (or a Reservation, or another host): they say what they are, and the library's `reason` says which.
  if (['HUB_LEASE_EXTEND_REFUSED', 'HUB_LEASE_NOT_FOUND', 'HUB_DEVICE_JOB_ID', 'HUB_REQUEST_NOT_FOUND', 'HUB_CANCEL_RESERVATION', 'HUB_WRONG_HOST', 'HUB_FORCE_RELEASE_JOB', 'HUB_RESERVATION_NOT_FOUND'].includes(error.code)) { stderr(`${error.code} ${error.message}`); return code; }
  // These exit 2 like a usage error, but say what they are.
  if (error.code === 'HUB_NO_MATCH' || error.code === 'HUB_POOL_CROSS_HOST' || error.code === 'HUB_RESOURCE_RETIRED') { stderr(`${error.code} ${device} ${error.message}`); return code; }
  if (code === claims.EXIT_CODES.HUB_USAGE) { stderr(`hub-device: ${error.message}`); return code; }
  // A cancelled lease says so even when its last error was the phone not arriving: it never held anything to report.
  if (error.code === 'HUB_LEASE_CANCELLED') { stderr(`HUB_DEVICE_CANCELLED ${device} ${error.message}`); return code; }
  if (code === claims.EXIT_CODES.HUB_PHONE_AWAY) {
    stdout(`HUB_DEVICE_AWAY ${device}`);
    // The reason is always said: absent is "turn it on", unauthorized is "pair it again", offline is "wake it".
    // A host that did not answer also says why (the ssh leg's own cause), so a flaky hop is diagnosable from the one line.
    const cause = error.reason === 'host-unreachable' && error.detail ? ` (${String(error.detail).split('\n')[0]})` : '';
    stderr(`hub-device: ${device} is away: ${error.reason ?? error.message.split('\n')[0]}${cause}`);
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
  const { device, target, forMs, why, waitMs, holderPid } = setup(parsed, { needForWhy: true, fleet: context.fleet, env: context.env, policy: context.policy, context });
  const holder = parsed.flags.holder ?? env.HUB_DEVICE_HOLDER ?? `${env.USER ?? 'unknown'}@${hostname()}`;
  warnOldHub(context);
  const abort = new AbortController();
  let received = null;
  const onSignal = signal => { received ??= signal; abort.abort(); };
  const names = ['SIGINT', 'SIGTERM', 'SIGHUP'];
  for (const name of names) signals.on(name, onSignal);
  try {
    const noConnect = Boolean(parsed.flags['no-connect']);
    const options = { holder, why, forMs, waitMs, id: parsed.flags.id ?? null, holderPid, noConnect, requireReachable: target.kind === 'phone' && claims.needsDevice(device, target.entry, { noConnect }), phoneWaitMs: waitMs, signal: abort.signal };
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

// The actor of a manual action from this front door: who did it (`--holder`, else $HUB_DEVICE_HOLDER, else user@host), and `via: cli`.
const cliActor = (parsed, env) => ({ holder: parsed.flags.holder || env.HUB_DEVICE_HOLDER || `${env.USER ?? 'unknown'}@${hostname()}`, via: 'cli' });

// `extend [<id>] --for <dur> [--override <why>]`: the library's `extendHeld` (the Hub API's `POST /leases/{id}/extend` is the same call).
// The refusals (waiters, expired, cap, too-long) are its own and exit 76; `--override` skips the waiters check and says why.
function extend(parsed, context) {
  const { env, stdout } = context;
  if (parsed.words.length > 2) throw usage('extend takes at most one lease id');
  const id = parsed.words[1] ?? env.HUB_LEASE_ID ?? null;
  if (!id) throw usage('extend needs a lease id or $HUB_LEASE_ID');
  if (parsed.flags.for === undefined) throw usage('--for <duration> is required');
  const forMs = parseDuration(parsed.flags.for, '--for');
  const actor = cliActor(parsed, env);
  let override = null;
  if (parsed.flags.override !== undefined) {
    if (parsed.flags.override.trim() === '') throw usage('--override says why: a non-empty reason');
    override = { actor, why: parsed.flags.override };
  }
  const { lock, device, record } = claims.extendHeld(id, { forMs, actor, override }, context);
  if (parsed.flags.json) stdout(JSON.stringify({ lease_id: id, lock, device, expires_at: record.expires_at }));
  else stdout(`HUB_DEVICE_EXTENDED ${device ?? lock} ${id} until ${record.expires_at}`);
  return claims.EXIT_OK;
}

// `cancel <request_id> [--resource R] [--pool P] [--why <text>]`: the library's `cancel` (the Hub API's `POST /requests/{id}/cancel` is the same call).
// Takes a waiting request out of the line (every member's queue for a Pool request: `--pool phone`) and touches no Hold; a request that already holds
// its lock is `release`'s. Without `--resource` it looks for the request in this host's queues. Not found, a Reservation or a job's id exit 2.
function cancel(parsed, context) {
  const { env, stdout } = context;
  if (parsed.words.length !== 2) throw usage('cancel takes one request id');
  if (parsed.flags.why !== undefined && parsed.flags.why.trim() === '') throw usage('--why says why: a non-empty reason');
  const id = parsed.words[1];
  const answer = claims.cancel(id, { resource: parsed.flags.resource ?? null, pool: parsed.flags.pool ?? null, host: null, why: parsed.flags.why ?? null, actor: cliActor(parsed, env) }, context);
  if (parsed.flags.json) stdout(JSON.stringify(answer));
  else stdout(`HUB_DEVICE_CANCELLED ${answer.resource} ${id}`);
  return claims.EXIT_OK;
}

// `force-release <id> --why <text>`: the library's `forceReleaseLease` (the Hub API's `POST /leases/{id}/force-release` is the same call). Ends the Lease `id` holds on
// this host by force and records who and why on the `force-release` event. A deploy job's Hold, an emulator lease and an id that holds nothing exit 2.
// `emulator-<n>` is a slot (Story 7.8): the library's `forceReleaseEmulator` ends its Lease and tears the emulator down (the Hub API's
// `POST /leases/emulator-<n>/force-release` is the same call); the same stdout line and `--json` answer.
async function forceRelease(parsed, context) {
  const { env, stdout } = context;
  if (parsed.flags.reservation !== undefined) return forceReleaseReservation(parsed, context);
  if (parsed.flags.name !== undefined) throw usage('force-release --name goes with --reservation');
  if (parsed.words.length !== 2) throw usage('force-release takes one lease id');
  const id = parsed.words[1];
  const input = { why: parsed.flags.why ?? null, actor: cliActor(parsed, env) };
  const slot = claims.namesEmulatorSlot(id);
  const answer = slot ? await claims.forceReleaseEmulator(id, input, context) : claims.forceReleaseLease(id, input, context);
  if (parsed.flags.json) stdout(JSON.stringify(answer));
  else stdout(`HUB_DEVICE_FORCE_RELEASED ${slot ? answer.lock : answer.device ?? answer.lock} ${answer.lease_id} holder=${answer.holder ?? '-'}`);
  return claims.EXIT_OK;
}

// `force-release --reservation <run_key> --why <text> [--name adb|mac-ios]`: the library's `forceReleaseReservation` (the Hub API's
// `POST /reservations/{run_key}/force-release` is the same call). One stdout line per lock it ended; not found exits 2.
function forceReleaseReservation(parsed, context) {
  const { env, stdout } = context;
  if (parsed.words.length !== 1) throw usage('force-release takes a lease id or --reservation <run_key>, not both');
  const key = parsed.flags.reservation;
  const answer = claims.forceReleaseReservation(key, { why: parsed.flags.why ?? null, actor: cliActor(parsed, env), name: parsed.flags.name ?? null }, context);
  if (parsed.flags.json) stdout(JSON.stringify(answer));
  else for (const hold of answer.released) stdout(`HUB_DEVICE_RESERVATION_FORCE_RELEASED ${hold.lock} ${key}`);
  return claims.EXIT_OK;
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
  const actor = cliActor(parsed, env);
  const result = await claims.release(parsed.flags.any ? { any: true, actor } : { id, actor }, context);
  return result.kind === 'emulator' ? printEmulatorRelease(result, context) : printPhoneRelease(result, { any: Boolean(parsed.flags.any), id }, context);
}

function age(ms) {
  const s = Math.round(ms / 1000);
  if (s < 90) return `${s}s`;
  if (s < 5400) return `${Math.round(s / 60)}m`;
  return `${(s / 3600).toFixed(1)}h`;
}

// The hosts other than this one, as the Hub API's status document shows them (Story 8.1, FR-14). Only the Linux host asks: it is where the
// API runs, and the Mac's own status is its own. One read-only `GET /status` through the same-host client (`/health` probe first); every
// failure is a reason, never an error: `api-down` (the client could not get an answer), `bad-answer` (the body is no status document) or
// `not-served` (the document does not carry that host: until Epic 9 the Mac). The keys are `HOST_PLATFORMS`'s, so a new host appears with no
// change here. Other keys (null, `mac`) make no call and list nothing.
const REMOTE_WHY = Object.freeze({
  'api-down': 'the Hub API is not answering',
  'not-served': 'the Hub API has no view of it',
  'bad-answer': 'the Hub API answered something that is not a status document',
});
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

async function remoteHosts(key, context) {
  if (key !== 'linux') return {};
  const others = Object.keys(claims.HOST_PLATFORMS).filter(host => host !== key);
  const gone = reason => Object.fromEntries(others.map(host => [host, { state: 'unavailable', reason, view: null, stale: null }]));
  let answer;
  try {
    answer = await call({ method: 'GET', path: '/status' }, { policy: context.policy ?? loadPolicy().policy, fetchImpl: context.fetchImpl, timeout: context.timeout ?? (ms => AbortSignal.timeout(Math.min(ms, 5000))) });
  } catch { return gone('api-down'); }
  const body = answer.body;
  if (!isObject(body) || body.format !== 1 || !isObject(body.hosts) || (body.stale !== undefined && !isObject(body.stale))) return gone('bad-answer');
  return Object.fromEntries(others.map(host => [host, isObject(body.hosts[host])
    ? { state: 'available', reason: null, view: body.hosts[host], stale: body.stale?.[host] ?? null }
    : { state: 'unavailable', reason: 'not-served', view: null, stale: null }]));
}

const remoteLine = (host, entry) => {
  if (entry.state !== 'available') return `  ${host}  unavailable (${REMOTE_WHY[entry.reason] ?? entry.reason})`;
  const count = list => (Array.isArray(list) ? list.filter(row => row?.stale !== true).length : 0);
  const since = isObject(entry.stale) && entry.stale.since !== undefined ? `  [stale since ${entry.stale.since}]` : entry.stale ? '  [stale]' : '';
  return `  ${host}  ${count(entry.view.locks)} held, ${count(entry.view.waiters)} waiting (from the Hub API)${since}`;
};

async function status(parsed, context) {
  const { stdout, timing } = context;
  const nowMs = timing.now();
  // The host key says which Resources this host may read. A host that does not know which host it is still shows status:
  // every reading is then missing (unknown, stale), never reachable.
  let key = null;
  try { key = (context.hostKey ?? claims.hostKey)({ env: context.env }); } catch (error) { if (error?.code !== 'HUB_HOST_UNKNOWN') throw error; }
  const result = await claims.statusView(key, { audience: 'local' }, context);
  const { phones, locks, waiters, reservations, inventory: found, emulators } = result;
  const remote = await remoteHosts(key, context);
  if (parsed.flags.json) { stdout(JSON.stringify({ ...result, remote_hosts: remote }, null, 2)); return 0; }
  stdout('PHONES (read only; adb is queried, never connected)');
  for (const phone of phones) {
    const held = phone.held === 'free' ? 'free'
      : phone.held === 'lease' ? (() => {
          const left = Date.parse(phone.expires_at) - nowMs;
          return `LEASE ${phone.lease_id}  holder=${phone.holder}  ${left > 0 ? `expires in ${age(left)}` : `EXPIRED ${age(-left)} ago`}${phone.adb_id ? `  adb=${phone.adb_id}` : ''}`;
        })()
        : `JOB LOCK  ${phone.repo ?? 'a local run'} run ${phone.run ?? '-'}`;
    stdout(`  ${phone.device}  ${held}  ${phone.presence}  ${phone.model ?? '-'}  serial ${phone.serial ?? '-'}  lock ${phone.lock}${phone.deploy ? '  (the deploy phone)' : ''}`);
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
  if (key === 'linux') {
    stdout('REMOTE HOSTS (from the Hub API)');
    for (const [host, entry] of Object.entries(remote)) stdout(remoteLine(host, entry));
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
  const { device, target, forMs, why, waitMs, holderPid } = setup(parsed, { needForWhy: false, fleet: context.fleet, env: context.env, policy: context.policy, context });
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
    const options = { holder, why, forMs, waitMs, id, holderPid: holderPid ?? process.pid, noConnect: false, requireReachable: target.kind === 'phone' && claims.needsDevice(device, target.entry), phoneWaitMs: waitMs, signal: abort.signal };
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

// ---- registry (Story 6.8) ----

// What each registry verb takes beyond its words: a flag outside its list is `unknown flag --X` (exit 2), like any command's.
const REGISTRY_FLAGS = Object.freeze({
  add: ['kind', 'name', 'model', 'serial', 'udid', 'profile', 'host', 'cap', 'if-rev', 'why', 'holder', 'json'],
  edit: ['name', 'cap', 'uncap', 'if-rev', 'why', 'holder', 'json'],
  retire: ['if-rev', 'why', 'holder', 'json'],
  list: ['json'],
});

// `k=v` as a Capability: `true` and `false` are booleans, a number is a number, anything else a string.
function parseCap(text, flag) {
  const at = text.indexOf('=');
  if (at < 1 || at === text.length - 1) throw usage(`--${flag} ${text}: say it as key=value`);
  const [key, value] = [text.slice(0, at), text.slice(at + 1)];
  if (value === 'true') return [key, true];
  if (value === 'false') return [key, false];
  // A number only when it reads back as the same text: `0123`, `1.10` and a 20-digit id stay strings.
  const number = Number(value);
  return [key, Number.isFinite(number) && String(number) === value ? number : value];
}

function capabilitiesOf(parsed) {
  // No prototype: a key like `__proto__` reaches the API (which refuses it) instead of being swallowed by the setter.
  const set = Object.create(null);
  for (const text of parsed.cap) {
    const [key, value] = parseCap(text, 'cap');
    if (Object.hasOwn(set, key)) throw usage(`--cap ${key} is given twice`);
    set[key] = value;
  }
  for (const key of parsed.uncap) {
    if (!/^[^=\s]+$/.test(key)) throw usage(`--uncap ${key}: say it as a capability key`);
    if (Object.hasOwn(set, key) && set[key] !== null) throw usage(`${key} is given to both --cap and --uncap`);
    set[key] = null;
  }
  return Object.keys(set).length === 0 ? undefined : set;
}

function ifRevOf(flags) {
  if (flags['if-rev'] === undefined) return undefined;
  if (!/^\d+$/.test(flags['if-rev']) || !Number.isSafeInteger(Number(flags['if-rev']))) throw usage(`--if-rev takes a whole number, not "${flags['if-rev']}"`);
  return Number(flags['if-rev']);
}

function printRegistryList(result, context) {
  const { stdout } = context;
  stdout(`REGISTRY rev ${result.rev} (${result.source})`);
  for (const resource of result.resources) {
    const caps = Object.entries(resource.capabilities).map(([key, value]) => `${key}=${value}`).join(',') || '-';
    stdout(`  ${resource.id}  ${resource.name}  ${resource.kind}  ${resource.host}  lock ${resource.lock}  ${resource.identity?.model ?? '-'}  caps ${caps}${resource.deploy_target ? '  deploy target' : ''}${resource.seeded ? '  seeded' : ''}${resource.visibility === 'retiring' ? '  [retiring]' : ''}`);
  }
  stdout('POOLS');
  for (const pool of result.pools) stdout(`  ${pool.name}  ${pool.kind}  ${pool.members.join(',') || '-'}${pool.gate ? `  gate ${pool.gate}` : ''}`);
}

async function registryCommand(parsed, context) {
  const { stdout, env } = context;
  const verb = parsed.words[1];
  if (!Object.hasOwn(REGISTRY_FLAGS, verb ?? '')) throw usage(`registry takes: ${Object.keys(REGISTRY_FLAGS).join(' | ')}`);
  const given = [...Object.keys(parsed.flags), ...(parsed.cap.length > 0 ? ['cap'] : []), ...(parsed.uncap.length > 0 ? ['uncap'] : []), ...(parsed.envSerial.length > 0 ? ['env-serial'] : [])];
  for (const flag of given) if (!REGISTRY_FLAGS[verb].includes(flag)) throw usage(`unknown flag --${flag}`);
  const wanted = verb === 'edit' || verb === 'retire' ? 3 : 2;
  if (parsed.words.length > wanted) throw usage(`registry ${verb} takes no further argument ("${parsed.words[wanted]}")`);
  const { flags } = parsed;
  if (verb === 'list') {
    const result = claims.registryList({ audience: 'local' }, context);
    if (flags.json) stdout(JSON.stringify(result)); else printRegistryList(result, context);
    return claims.EXIT_OK;
  }
  const id = parsed.words[2];
  if (verb !== 'add' && !id) throw usage(`registry ${verb} needs a Resource id`);
  const ifRev = ifRevOf(flags);
  const capabilities = capabilitiesOf(parsed);
  const holder = flags.holder ?? env.HUB_DEVICE_HOLDER ?? `${env.USER ?? 'unknown'}@${hostname()}`;
  const body = { actor: { holder, via: 'cli' } };
  if (flags.why !== undefined) body.why = flags.why;
  if (verb === 'add') {
    if (flags.kind === undefined) throw usage('--kind <kind> is required');
    if (flags.name === undefined) throw usage('--name <name> is required');
    const identity = Object.fromEntries(['model', 'serial', 'udid', 'profile'].filter(key => flags[key] !== undefined).map(key => [key, flags[key]]));
    Object.assign(body, { kind: flags.kind, name: flags.name, host: flags.host ?? (context.hostKey ?? claims.hostKey)({ env }) });
    if (Object.keys(identity).length > 0) body.identity = identity;
    if (capabilities !== undefined) body.capabilities = capabilities;
    if (ifRev !== undefined) body.if_rev = ifRev;
  } else if (verb === 'edit') {
    if (flags.name !== undefined) body.name = flags.name;
    if (capabilities !== undefined) body.capabilities = capabilities;
    body.if_rev = ifRev ?? claims.registryRev(context);
  } else if (ifRev !== undefined) body.if_rev = ifRev;
  const answer = await claims.registryWrite(verb, { id, body }, context);
  if (flags.json) { stdout(JSON.stringify(answer.body)); return claims.EXIT_OK; }
  const done = answer.body;
  if (verb === 'retire') stdout(`HUB_DEVICE_RETIRED ${done.id} ${done.visibility}`);
  else stdout(`${verb === 'add' ? 'HUB_DEVICE_REGISTERED' : 'HUB_DEVICE_EDITED'} ${done.resource.id} ${done.resource.name}`);
  stdout(`HUB_DEVICE_REV ${done.rev}`);
  return claims.EXIT_OK;
}

// ---- forwarding (Story 9.3, AD-25, AD-47, AD-48) ----

// A Hold verb on a Resource that lives on another host is sent to that host's front door (tools/device/forward.mjs has the rules, hub-client.mjs the
// one transport) instead of being run in this process, so no host writes another host's lock dir. The door is `cli`; the answers print as the local verb's.
// What a verb names: `lease` and `run` a device word, `emulator` or `--match`; `release`, `extend`, `cancel` and `force-release` the Resource of `--resource`
// (a force-release of `emulator-<n>` names the emulator slot); a verb that names nothing, or one on this host, runs here. This host's view of the Registry is
// `registry.json` on the Linux host (`hubView`) and the Hub API's last answer, else the seed at `rev: 0`, on any other (`peerView`). A host that does not
// know its key does not forward (v1a). `lease ipad|mac` is forwarded like any word (Story 9.4: the iPad lane); `run` on a foreign target is HUB_WRONG_HOST (it needs a local child).
const FORWARD_KEYS = Object.freeze({ lease: 'POST /leases', run: 'POST /leases', release: 'POST /leases/{id}/release', extend: 'POST /leases/{id}/extend', cancel: 'POST /requests/{id}/cancel', 'force-release': 'POST /leases/{id}/force-release' });

// What the command names and the Hold route key it is checked as, or null when it names nothing (or something this front door does not forward).
function namingOf(parsed, context) {
  const { flags, words } = parsed;
  const verb = words[0];
  const key = FORWARD_KEYS[verb];
  if (key === undefined) return null;
  if (verb === 'lease' || verb === 'run') {
    if ((flags.match === undefined) === (words[1] === undefined)) return null;
    return { key, input: { match: flags.match ?? null, resource: words[1] ?? null }, params: {} };
  }
  // With no lease id word the id is $HUB_LEASE_ID, and `lease` exported $HUB_DEVICE with it: that is the Resource when `--resource` is not given.
  const heldResource = () => flags.resource ?? (words[1] === undefined && !flags.any && context.env.HUB_LEASE_ID && context.env.HUB_DEVICE ? context.env.HUB_DEVICE : undefined);
  if (verb === 'release') return heldResource() === undefined || words[1] === 'emulator' ? null : { key, input: { resource: heldResource() }, params: {} };
  if (verb === 'extend') return heldResource() === undefined ? null : { key, input: { resource: heldResource() }, params: {} };
  if (verb === 'cancel') return flags.resource === undefined ? null : { key, input: { resource: flags.resource, pool: flags.pool ?? null }, params: {} };
  if (flags.reservation !== undefined) return null;
  const id = words[1];
  if (claims.namesEmulatorSlot(id)) return { key, input: {}, params: { id } };
  return flags.resource === undefined ? null : { key, input: { resource: flags.resource }, params: { id } };
}

// Where the command lives: `{host, records, single, view, own, key}` for a Resource on one other host, else null.
async function placeOfCommand(parsed, context) {
  const naming = namingOf(parsed, context);
  if (naming === null || NAMED[naming.key].names(naming.input, { params: naming.params }).length === 0) return null;
  const { env } = context;
  let own;
  try { own = (context.hostKey ?? claims.hostKey)({ env }); } catch (error) {
    if (error?.code === 'HUB_HOST_UNKNOWN') return null;
    throw error;
  }
  const qaDevices = context.qaDevices ?? (() => []);
  const view = own === 'linux'
    ? hubView({ env, registry: context.registry, qaDevices, warn: context.warn })
    : await peerView({ env, qaDevices, request: transportOf(context) });
  const { records, single } = namedRecords(naming.key, naming.input, { params: naming.params }, view, context.policy);
  const host = placeOf(records, own);
  return host === null ? null : { ...naming, host, records, single, view, own };
}

// The answers, printed as the local verbs print them.
function printForwarded(verb, answer, { id, holder, json, label }, context) {
  const { stdout } = context;
  if (verb === 'lease') {
    if (json) stdout(JSON.stringify({ lease_id: answer.lease_id, device: answer.device, holder: answer.holder ?? holder, why: answer.why, expires_at: answer.expires_at, env: answer.env }));
    else for (const [name, value] of Object.entries(answer.env ?? {})) stdout(`export ${name}=${shellQuote(value)}`);
  } else if (verb === 'extend') {
    if (json) stdout(JSON.stringify({ lease_id: id, lock: answer.lock, device: answer.device, expires_at: answer.expires_at }));
    else stdout(`HUB_DEVICE_EXTENDED ${answer.device ?? answer.lock} ${id} until ${answer.expires_at}`);
  } else if (verb === 'cancel') {
    if (json) stdout(JSON.stringify(answer)); else stdout(`HUB_DEVICE_CANCELLED ${answer.resource} ${id}`);
  } else if (verb === 'force-release') {
    if (json) stdout(JSON.stringify(answer));
    else stdout(`HUB_DEVICE_FORCE_RELEASED ${claims.namesEmulatorSlot(id) ? answer.lock : answer.device ?? answer.lock} ${answer.lease_id} holder=${answer.holder ?? '-'}`);
  } else if (answer.outcome === 'released') stdout(`HUB_DEVICE_RELEASED ${answer.device} ${answer.lease_id}`);
  else if (answer.outcome === 'cancelled') stdout(`HUB_DEVICE_CANCELLED ${answer.device} ${id} (it was still waiting)`);
  else stdout(`HUB_DEVICE_NOT_HELD ${label} ${id} (no lease by that id)`);
}

// The Hold verbs are the verbs a front door forwards: one list, so a new verb finds lanes too.
const HOLD_VERBS = Object.freeze(Object.keys(FORWARD_KEYS));
const LOCAL_LINES = Object.freeze(['HUB_PHONE_AWAY', 'HUB_DEVICE_AWAY', 'HUB_LOCK_TIMEOUT', 'HUB_LEASE_CANCELLED']);

// Forwards the command when it names a Resource on another host and answers its exit code, else null (the verb runs here).
async function forwardCommand(parsed, context) {
  const place = await placeOfCommand(parsed, context);
  if (place === null) return null;
  const { flags, words } = parsed;
  const verb = words[0];
  const { env, signals } = context;
  if (verb === 'run') throw wrongHost(place.records.find(record => record.host !== place.own), place.own);
  if (flags.pid !== undefined || parsed.envSerial.length > 0) throw usage(`${flags.pid !== undefined ? '--pid' : '--env-serial'} names this machine's own process or environment, so it cannot go with a ${verb} on another host (${place.host})`);
  const actor = cliActor(parsed, env);
  const json = Boolean(flags.json);
  let id = null;
  let path;
  const body = { holder: actor.holder, actor };
  if (verb === 'lease') {
    // `--no-connect` means something on a lane (the iPad lane's take without the device); on a phone it stays refused.
    const lane = claims.isLane(place.single);
    for (const flag of ['no-connect', 'profile', 'pool']) if (flags[flag] !== undefined && !(flag === 'no-connect' && lane)) throw usage(`--${flag} is not forwarded: a ${verb} on another host (${place.host}) takes a device word or --match, --for, --why, --wait and --id`);
    if (flags.for === undefined) throw usage('--for <duration> is required');
    if (!flags.why) throw usage('--why <text> is required');
    if (flags.match !== undefined) body.match = flags.match; else body.resource = words[1];
    Object.assign(body, { for_ms: parseDuration(flags.for, '--for'), wait_ms: flags.wait !== undefined ? parseDuration(flags.wait, '--wait') : 120_000, why: flags.why });
    // The one Resource a word names is bounded here, before anything is sent: a deploy target's cap is named by `--for <text>`, as on its own host.
    if (place.single) {
      const entry = withPlace(context.fleet, place.single, place.view, context.policy).find(candidate => candidate.lock === place.single.lock);
      claims.checkBounds({ kind: 'phone', by: 'word', entry }, { forMs: body.for_ms, forText: flags.for, policy: context.policy });
      if (claims.needsDevice(words[1], entry, { noConnect: Boolean(flags['no-connect']) })) body.require_reachable = true;
    }
    body.id = flags.id ?? claims.newLeaseId(place.records.some(record => record.kind === 'emulator-pool') ? 'emulator' : 'lease');
    path = '/leases';
  } else if (verb === 'cancel') {
    if (words.length !== 2) throw usage('cancel takes one request id');
    if (flags.why !== undefined && flags.why.trim() === '') throw usage('--why says why: a non-empty reason');
    id = words[1];
    Object.assign(body, { resource: flags.resource, ...(flags.pool === undefined ? {} : { pool: flags.pool }), ...(flags.why === undefined ? {} : { why: flags.why }) });
    path = `/requests/${encodeURIComponent(id)}/cancel`;
  } else if (verb === 'force-release') {
    if (flags.name !== undefined) throw usage('force-release --name goes with --reservation');
    if (words.length !== 2) throw usage('force-release takes one lease id');
    id = words[1];
    Object.assign(body, { why: flags.why ?? null, ...(flags.resource === undefined ? {} : { resource: flags.resource }) });
    if (body.why === null) delete body.why;
    path = `/leases/${encodeURIComponent(id)}/force-release`;
  } else {
    if (words.length > 2) throw usage(`${verb} takes at most one lease id`);
    if (flags.any) throw usage(`${verb} --any cannot go with --resource on another host (${place.host}): name the lease id`);
    id = words[1] ?? env.HUB_LEASE_ID ?? null;
    if (!id) throw usage(`${verb} needs a lease id or $HUB_LEASE_ID`);
    const job = verb === 'release' ? claims.jobTicket(id) : null;
    if (job) { context.stderr(`HUB_DEVICE_JOB_ID ${job.message}`); return claims.exitCodeOf(job); }
    body.resource = place.input.resource;
    if (verb === 'extend') {
      if (flags.for === undefined) throw usage('--for <duration> is required');
      body.for_ms = parseDuration(flags.for, '--for');
      if (flags.override !== undefined) {
        if (flags.override.trim() === '') throw usage('--override says why: a non-empty reason');
        body.override = { why: flags.override, actor };
      }
    }
    path = `/leases/${encodeURIComponent(id)}/${verb}`;
  }
  const abort = new AbortController();
  let received = null;
  const onSignal = signal => { received ??= signal; abort.abort(); };
  const names = ['SIGINT', 'SIGTERM', 'SIGHUP'];
  for (const name of names) signals.on(name, onSignal);
  try {
    const request = { method: 'POST', path, body, signal: abort.signal };
    const input = NAMED[place.key].check(body);
    const answer = await forwardHold({ key: place.key, request, input, place: { host: place.host, records: place.records, single: place.single }, rev: place.view.rev, door: 'cli', ctx: context });
    printForwarded(verb, answer.body, { id, holder: actor.holder, json, label: place.input.resource ?? 'phone' }, context);
    return claims.EXIT_OK;
  } catch (error) {
    if (received) return 128 + constants.signals[received];
    // A far problem whose local verb prints a HUB_DEVICE_* line (busy, away, cancelled) is reported as the local verb reports it, with the same exit.
    if (error?.api === true && LOCAL_LINES.includes(error.code)) error.api = false;
    throw error;
  } finally {
    for (const name of names) signals.off(name, onSignal);
  }
}

// Who owns each flag that not every command takes: any other command refuses it as an unknown flag (AD-17: exit 2 stays exit 2).
const FLAG_OWNERS = Object.freeze({
  run: ['reservation'],
  name: ['reservation', 'registry', 'force-release'],
  match: ['lease', 'run'],
  kind: ['registry'],
  model: ['registry'],
  serial: ['registry'],
  udid: ['registry'],
  host: ['registry'],
  cap: ['registry'],
  uncap: ['registry'],
  'if-rev': ['registry'],
  override: ['extend'],
  resource: ['cancel', 'release', 'extend', 'force-release'],
  reservation: ['force-release'],
});

function checkFlagOwners(parsed) {
  const given = flag => (flag === 'cap' || flag === 'uncap' ? parsed[flag].length > 0 : parsed.flags[flag] !== undefined);
  for (const [flag, owners] of Object.entries(FLAG_OWNERS)) if (given(flag) && !owners.includes(parsed.words[0])) throw usage(`unknown flag --${flag}`);
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
  fetchImpl,
  timeout,
  request,
} = {}) {
  let parsed = { flags: {}, words: [], envSerial: [], cap: [], uncap: [], command: null };
  // Each distinct warning prints once per invocation: the fleet, `--match` and `registry list` each read the Registry, and an unreadable
  // file warns every time.
  const warned = new Set();
  const warn = message => {
    if (warned.has(message)) return;
    warned.add(message);
    stderr(`hub-device: warning: ${message}`);
  };
  const context = {
    ...claims.createContext({ env, sleep, now, log: line => stderr(line), warn, adbFactory, adbWire, devicectl, hostKey, inventory: inventoryImpl, policy, qaDevices, registry, fetchImpl, timeout }),
    stdout, stderr, signals, killGraceMs: Number(env.HUB_DEVICE_KILL_GRACE_MS) || 10_000,
    ...(request ? { request } : {}),
  };
  try {
    parsed = parseArgs(argv);
    checkFlagOwners(parsed);
    // The phones the Registry names (registry.json in the lock dir, read fresh), else the ones this checkout's devices.json names; a
    // broken devices.json is a tool failure, named like any other.
    context.fleet = claims.loadFleet(env, { warn: context.warn });
    // A Hold verb finds a lane of this host (the iPad lane on the Mac) by its lock like a phone's, so `release`, `extend`, `cancel` and
    // `force-release` by id reach `mac-ios`; `status` keeps its own view. A host that does not know its key has none.
    if (HOLD_VERBS.includes(parsed.words[0])) {
      let own = null;
      try { own = (context.hostKey ?? claims.hostKey)({ env }); } catch (error) { if (error?.code !== 'HUB_HOST_UNKNOWN') throw error; }
      context.fleet = [...context.fleet, ...claims.hostLanes(own, { env, policy: context.policy })];
    }
    // A Hold verb on a Resource of another host is forwarded there (Story 9.3); null means it runs here.
    const forwarded = await forwardCommand(parsed, context);
    if (forwarded !== null) return forwarded;
    switch (parsed.words[0]) {
      case 'lease': return await lease(parsed, context);
      case 'release': return await release(parsed, context);
      case 'extend': return extend(parsed, context);
      case 'cancel': return cancel(parsed, context);
      case 'force-release': return await forceRelease(parsed, context);
      case 'status': return await status(parsed, context);
      case 'discover': return await discover(parsed, context);
      case 'reservation': return reservationCommand(parsed, context);
      case 'run': return await runCommand(parsed, context);
      case 'registry': return await registryCommand(parsed, context);
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
