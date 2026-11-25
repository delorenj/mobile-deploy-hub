// The Claims library (AD-24): every action a Claimant can take on a Resource, and every rule that bounds it, in one place.
// Resolve, take, release, extend, Lease id minting, the bounds checks, status assembly and the error-to-exit table live
// here, so `hub-device` (and later the Hub API and the Host Agent) can only parse, call and print: none of them can take,
// refuse or report one action differently. The deploy path never imports this file (tools/deploy-path.test.mjs).
//
// A take is refused (HUB_RESOURCE_RETIRED, exit 2, `reason` retired|seed-missing, `resource`) for a Resource the Registry file marks
// retired or seed_missing, before anything is queued or written; the file only is read (`readRegistryFile`), so a missing or unreadable
// one refuses nothing and the QA file is never opened.
//
// Everything that writes the lock directory goes through lock.mjs and emulator.mjs (AD-1); reads may look at it directly. Errors carry a `code`; a usage
// refusal is `code: 'HUB_USAGE'`. The context every action takes is the one `createContext` builds: `env`, `log`, `warn`,
// `timing`, `emulator`, `adbFactory`, `adbWire`, `devicectl`, `hostKey`, `inventory`, `policy`, `fleet`, `qaDevices` and `registry` (the last two are the seams `matchTarget` reads).
import { randomBytes } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { findPhone, idMatchesSerial } from '../ci/lib/adb.mjs';
import { createDevicectl } from '../ci/lib/devicectl.mjs';
import { earliest } from '../ci/lib/eta.mjs';
import { loadDevices } from '../ci/lib/devices.mjs';
import { MAX_LEASE_MS, RESERVABLE, SEED_RESOURCES, acquireLease, acquirePool, capText, deployTargetCapMs, etaHistory, extendLease, isLease, listLocks, lockDir, newLeaseId as newLockLeaseId, queueView, readOwner, releaseLease, releaseReservation, resourceOf, updateLease, waiterEtas } from '../ci/lib/lock.mjs';
import { sleep as realSleep } from '../ci/lib/pause.mjs';
import { loadPolicy } from '../ci/lib/policy.mjs';
import { createAdbWire } from './adb-wire.mjs';
import { createAsyncAdb } from './async-adb.mjs';
import { GATE, LEASE_ID, MAX_POOL, PROFILES, emulatorStatus, exportsOf as emulatorExports, hostPool, isEmulatorLease, isEmulatorLock, provision, readRecord, reap, releaseEmulator as releaseEmulatorLease, teardownNow } from './emulator.mjs';
import { REACHABILITY, discover as discoverDevices, phoneReachability, present, queryAdb, readIpad, stamp } from '../registry/reachability.mjs';
import { match, canonical, parseQuery, retirement } from '../registry/match.mjs';
import { readRegistry, readRegistryFile } from '../registry/store.mjs';
import { deployTargetIds, loadQaDevices, seed } from '../registry/seed.mjs';
import { inventory as realInventory } from './inventory.mjs';

export const PHONE = 'phone';
export const EMULATOR = 'emulator';

// ---- the exit table (data, so every front door maps an error the same way) ----

export const EXIT_OK = 0;
export const EXIT_FAILURE = 1;
export const EXIT_CODES = Object.freeze({
  HUB_USAGE: 2,
  HUB_EMULATOR_USAGE: 2,
  HUB_LEASE_TOO_LONG: 2,
  HUB_DEVICE_JOB_ID: 2,
  HUB_DEVICE_AWAY: 75,
  HUB_PHONE_AWAY: 75,
  HUB_DEVICE_BUSY: 76,
  HUB_LOCK_TIMEOUT: 76,
  HUB_LEASE_CANCELLED: 1,
  HUB_LEASE_EXTEND_REFUSED: 1,
  HUB_LEASE_LOST: 1,
  HUB_HOST_UNKNOWN: 1,
  HUB_NO_MATCH: 2,
  HUB_POOL_CROSS_HOST: 2,
  HUB_RESOURCE_RETIRED: 2,
  HUB_REGISTRY_CONFLICT: 1,
  HUB_REGISTRY_FORMAT: 1,
  // Story 6.4: the Hub API's start refusals and its generic route errors.
  HUB_API_ALREADY_RUNNING: 1,
  HUB_API_NODE: 1,
  HUB_API_NO_HEAVY: 1,
  HUB_NO_ROUTE: 2,
  HUB_API_ERROR: 1,
  // Story 6.5: a Registry read of an id no reader shows.
  HUB_RESOURCE_NOT_FOUND: 2,
  // Story 6.6: a Registry register refused for its name, or for an identity a live Resource already has.
  HUB_REGISTRY_NAME: 2,
  HUB_REGISTRY_DUPLICATE: 2,
});
export const exitCodeOf = error => (Object.hasOwn(EXIT_CODES, error?.code) ? EXIT_CODES[error.code] : EXIT_FAILURE);

const usage = message => Object.assign(new Error(message), { code: 'HUB_USAGE' });
const failure = (code, message) => Object.assign(new Error(message), { code });
const away = error => error?.code === 'HUB_PHONE_AWAY';
const readOwnerOf = (name, env) => readOwner(join(lockDir(env), `${name}.lock`));

// Whether the lock `lock` is held (an owner record is there) and whether anyone waits on it (any non-stale queue entry): the two facts
// a Registry reader needs to tell a retiring Resource (still held or waited on) from a hidden one (AD-31). Read only; never throws
// (a lock dir that cannot be read is idle).
export function lockActivity(lock, { env = process.env, now = Date.now } = {}) {
  let held = false;
  let queued = false;
  try { held = readOwnerOf(lock, env) !== null; } catch { /* idle */ }
  try { queued = queueView(lock, { env, now }).length > 0; } catch { /* idle */ }
  return { held, queued };
}

// ---- the host key (AD-47) ----

// The host key is the devices.json host block this machine is (`linux` is big-chungus, `mac` is the Mac), written by
// `mise run hosts:install` and never derived from `uname` or a hostname: the platform is only a check, so a second
// Linux machine cannot believe it is big-chungus. This is the one vocabulary; hosts.mjs imports it.
export const HOST_PLATFORMS = Object.freeze({ linux: 'linux', mac: 'darwin' });
export const HOST_KEY_FILE = '.config/mobile-deploy-hub/host-key';
export const hostKeyPath = home => join(home, HOST_KEY_FILE);

// This host's key; throws HUB_HOST_UNKNOWN for a missing or unreadable file, an empty or unknown key, or a key whose platform is not this one.
export function hostKey({ env = process.env, home = env.HOME || homedir(), platform = process.platform, readFile = readFileSync } = {}) {
  const file = hostKeyPath(home);
  const unknown = reason => failure('HUB_HOST_UNKNOWN', `this host does not know which host it is: ${reason}; run \`mise run hosts:install\` on it to write ${file}`);
  let text;
  try { text = String(readFile(file, 'utf8')); } catch (error) { throw unknown(`cannot read ${file} (${error?.code ?? error?.message ?? error})`); }
  const key = text.trim();
  if (!key) throw unknown(`${file} is empty`);
  if (!Object.hasOwn(HOST_PLATFORMS, key)) throw unknown(`${file} holds "${key}", not one of ${Object.keys(HOST_PLATFORMS).join(', ')}`);
  if (HOST_PLATFORMS[key] !== platform) throw unknown(`${file} holds "${key}", which is a ${HOST_PLATFORMS[key]} host, but this is ${platform}`);
  return key;
}

// The one locality test: a record is local when it names this host's key. An unknown host propagates; it never decides.
export const isLocal = (record, { hostKey: keyOf = hostKey } = {}) => record?.host === keyOf();

// ---- context ----

// Timing and emulator settings from the environment, as the CLI always read them; every key can be overridden by a seam.
export function createContext({ env = process.env, sleep = realSleep, now = Date.now, log = () => {}, warn = () => {}, adbFactory, adbWire, devicectl, hostKey: hostKeyOf, inventory, policy = null, fleet, qaDevices, registry } = {}) {
  return {
    env, log, warn, policy, adbFactory, adbWire, devicectl, hostKey: hostKeyOf, inventory, fleet, qaDevices, registry,
    timing: { sleep, now, leasePollMs: Number(env.HUB_DEVICE_POLL_MS) || 1000, phonePollMs: Number(env.HUB_DEVICE_POLL_MS) || 3000 },
    emulator: {
      graceMs: Number(env.HUB_EMULATOR_KILL_GRACE_MS) || 15_000,
      bootTimeoutMs: Number(env.HUB_EMULATOR_BOOT_TIMEOUT_MS) || 360_000,
      bootPollMs: Number(env.HUB_EMULATOR_POLL_MS) || 2000,
    },
  };
}

// ---- the fleet and ids ----

// The phones this tool can lease, in the order `phone` prefers them: a projection of the Registry seed (tools/registry/seed.mjs),
// which is the one derivation from devices.json. The S26 is the deploy phone (devices.android): it sits under the `adb` host
// lock deploys take, so its lock name can never change, and every further phone (devices.android_extra) gets a lock of its own
// lowercased name. Nothing but the seed reads android_extra. The QA file is never read here (`qaDevices: () => []`).
export function fleetOf(devices) {
  return seed(devices, { qaDevices: () => [] }).resources
    .filter(resource => resource.kind === 'phone')
    .map(resource => ({ device: resource.id, lock: resource.lock, deploy: resource.deploy_target, name: resource.display_name, serial: resource.identity.serial, model: resource.identity.model }));
}

// The phones this checkout's devices.json names; a broken one is a tool failure, named like any other.
export const loadFleet = env => fleetOf(loadDevices(env));

export const nameOf = (fleet, lock) => (isEmulatorLock(lock) ? EMULATOR : fleet.find(phone => phone.lock === lock)?.device ?? null);

// The exact id formats: `l-<12hex>` a phone lease, `e-<12hex>` an emulator lease, `run-<pid>-<8hex>` a `run`'s own.
export function newLeaseId(kind = 'lease') {
  switch (kind) {
    case 'lease': return newLockLeaseId();
    case 'emulator': return `e-${randomBytes(6).toString('hex')}`;
    case 'run': return `run-${process.pid}-${randomBytes(4).toString('hex')}`;
    default: throw new TypeError(`newLeaseId: unknown kind "${kind}" (lease, emulator, run)`);
  }
}

// ---- retired Resources ----

const retiredError = (record, reason, word = record.id) => Object.assign(
  new Error(reason === 'retired'
    ? `${word} is retired (reason: retired): it takes no new lease; a lease it already holds ends as usual`
    : `${word} is seed-missing (reason: seed-missing): devices.json no longer lists it, so it takes no new lease`),
  { code: 'HUB_RESOURCE_RETIRED', status: 409, reason, resource: record.id },
);

// Refuses a device word the Registry file names a retired or seed_missing Resource: found by id, then name, then `words`. A word the
// file does not know, or no file, passes. Throws HUB_RESOURCE_RETIRED.
export function refuseRetired(word, { env = process.env } = {}) {
  if (typeof word !== 'string' || word === '') return;
  const file = readRegistryFile(env);
  if (file === null) return;
  const record = file.resources.find(entry => entry.id === word) ?? file.resources.find(entry => entry.name === word)
    ?? file.resources.find(entry => Array.isArray(entry.words) && entry.words.includes(word));
  const reason = record ? retirement(record) : null;
  if (reason !== null) throw retiredError(record, reason, word);
}

// A resolved target for `take`: a phone whose Resource is retired or seed_missing is refused, and a word Pool is narrowed to the
// members that are not (none left is refused, naming the first). Pools by `--match` came out of the matcher already.
function withoutRetired(target, env) {
  const file = target.kind === 'phone' || (target.kind === 'pool' && target.by === 'word') ? readRegistryFile(env) : null;
  if (file === null) return target;
  const stateOf = phone => {
    const record = file.resources.find(entry => entry.lock === phone.lock) ?? file.resources.find(entry => entry.id === phone.device);
    return record ? { record, reason: retirement(record) } : { record: null, reason: null };
  };
  if (target.kind === 'phone') {
    const { record, reason } = stateOf(target.entry);
    if (reason !== null) throw retiredError(record, reason, target.entry.device);
    return target;
  }
  const left = target.members.filter(phone => stateOf(phone).reason === null);
  if (left.length === target.members.length) return target;
  if (left.length === 0) {
    const { record, reason } = stateOf(target.members[0]);
    const pool = target.pool ?? PHONE;
    throw Object.assign(
      new Error(`every remaining ${pool} member is retired or seed-missing (${target.members.map(phone => `${phone.device} ${stateOf(phone).reason}`).join(', ')}); it takes no new lease`),
      { code: 'HUB_RESOURCE_RETIRED', status: 409, reason, resource: record.id },
    );
  }
  return { ...target, members: left };
}

// ---- resolve ----

const phoneOwning = (fleet, env, id) => fleet.find(phone => { const owner = readOwnerOf(phone.lock, env); return isLease(owner) && owner.lease_id === id; }) ?? null;
const phoneWaiting = (fleet, env, id) => fleet.find(phone => queueView(phone.lock, { env, includeStale: true }).some(waiter => waiter.lease_id === id)) ?? null;

// The `phone` word's members, in order: the matcher's named list over the committed devices.json (no QA file), as fleet entries. For the
// committed devices.json that is the S24, then the S26.
function phoneMembers(fleet, env) {
  const named = match(seed(loadDevices(env), { qaDevices: () => [] }), { pool: PHONE }, null);
  return named.members.map(member => fleet.find(phone => phone.lock === member.lock)).filter(Boolean);
}

// `--match <query>`: a Capability query resolved by the matcher against the Registry: `<lock dir>/registry.json` read fresh on every call
// (the store, tools/registry/store.mjs), or the in-memory seed when there is no file or it is unreadable (one HUB_REGISTRY_FORMAT warning
// through `ctx.warn`). The seed's QA marks come from `ctx.qaDevices` (default the private QA file); `ctx.registry()` replaces the whole registry. What the CLI cannot hold
// is dropped with its reason: a member that is not a phone, or a phone `ctx.fleet` does not know. Returns the Pool target `take` tries
// in order: `{kind: 'pool', by: 'match', pool: 'match:<canonical query>', members}`. Throws HUB_USAGE for a bad query, HUB_NO_MATCH
// (with `reason`, `excluded`) when nothing can serve it and HUB_POOL_CROSS_HOST when the members span hosts. Reads, never writes.
export function matchTarget(text, { forMs } = {}, ctx) {
  const clauses = parseQuery(text);
  const registry = ctx.registry?.() ?? readRegistry({ env: ctx.env, qaDevices: ctx.qaDevices ?? (() => loadQaDevices({ env: ctx.env })), warn: ctx.warn });
  const policy = ctx.policy ?? loadPolicy().policy;
  const found = match(registry, { query: clauses, for_ms: forMs }, policy);
  const members = [];
  const excluded = [...found.excluded];
  for (const record of found.members) {
    const phone = record.kind === 'phone' ? ctx.fleet.find(entry => entry.lock === record.lock) : null;
    if (phone) members.push(phone);
    else excluded.push({ id: record.id, why: record.kind === 'phone' ? 'is known only from the QA file; hub-device cannot lease it yet' : `is ${/^[aeiou]/.test(record.kind) ? 'an' : 'a'} ${record.kind}; --match takes a phone` });
  }
  if (members.length === 0) {
    const reason = excluded.map(({ id, why }) => `${id} ${why}`).join('; ');
    throw Object.assign(failure('HUB_NO_MATCH', `no Resource matches: ${reason}`), { reason, excluded });
  }
  return { kind: 'pool', by: 'match', pool: `match:${canonical(clauses)}`, members };
}

// A target names one lease (an id: an emulator lease, then the phone holding it, then the phone it waits on) or a device word
// (a fleet phone, the `phone` Pool, `emulator`). An id wins over a word; `words`/`ids` narrow what is tried. An unknown
// word is HUB_USAGE. An id nothing holds resolves to null with `words: false`; otherwise it is read as a word (and refused).
export function resolve(target, { fleet, env = process.env, words = true, ids = true } = {}) {
  if (ids && typeof target === 'string' && target) {
    if (isEmulatorLease(env, target)) return { kind: EMULATOR, by: 'id', id: target };
    const owner = phoneOwning(fleet, env, target);
    if (owner) return { kind: 'phone', by: 'owner', id: target, entry: owner };
    const waiter = phoneWaiting(fleet, env, target);
    if (waiter) return { kind: 'phone', by: 'waiter', id: target, entry: waiter };
  }
  if (!words) return null;
  if (target === EMULATOR) return { kind: EMULATOR, by: 'word' };
  if (target === PHONE) return { kind: 'pool', by: 'word', pool: PHONE, members: phoneMembers(fleet, env) };
  refuseRetired(target, { env });
  const entry = fleet.find(phone => phone.device === target);
  if (!entry) throw usage(`unknown device "${target ?? ''}" (known: ${[...fleet.map(phone => phone.device), PHONE, EMULATOR].join(', ')})`);
  return { kind: 'phone', by: 'word', entry };
}

// ---- bounds ----

// A lease id names one lease: with more than one phone lock, the same --id could otherwise name two live leases
// (or a waiter and a lease), and `release <id>` would free only the first it meets.
export function checkLeaseId(id, { fleet, env = process.env }) {
  if (id === undefined || id === null) return;
  const onPhone = fleet.find(phone => {
    const owner = readOwnerOf(phone.lock, env);
    return (isLease(owner) && owner.lease_id === id) || queueView(phone.lock, { env, includeStale: true }).some(waiter => waiter.lease_id === id);
  });
  if (onPhone) throw usage(`--id ${id} already names a lease or a waiter on ${onPhone.device}; a lease id names one lease`);
  if (isEmulatorLease(env, id)) throw usage(`--id ${id} already names an emulator lease; a lease id names one lease`);
}

// The deploy phone's lock is a deploy target, whose Leases are capped by policy (AD-16).
const overCap = (phone, forMs, policy) => phone.deploy && forMs > (deployTargetCapMs(phone.lock, { policy }) ?? Infinity);
export const usableFleet = (fleet, forMs, policy = null) => fleet.filter(phone => !overCap(phone, forMs, policy));

// --for must be more than 0 and at most 48 h; a deploy phone's cap is a usage error that names the cap. `phone` (whichever is free)
// skips the deploy phone when --for is over the cap, and is refused when that leaves none. Returns the resolved target with
// the Pool narrowed to the phones that can take it.
export function checkBounds(resolved, { forMs, forText = forMs, fleet = resolved.members ?? [], policy = null }) {
  if (!Number.isFinite(forMs) || forMs <= 0 || forMs > MAX_LEASE_MS) throw usage(`--for must be more than 0 and at most ${MAX_LEASE_MS / 3_600_000}h`);
  if (resolved.kind === 'phone' && overCap(resolved.entry, forMs, policy)) throw usage(`--for ${forText}: ${capText(resolved.entry.lock, deployTargetCapMs(resolved.entry.lock, { policy }))}`);
  if (resolved.kind !== 'pool') return resolved;
  const members = usableFleet(fleet, forMs, policy);
  if (members.length === 0) throw usage(`--for ${forText}: no phone can take it; ${capText('adb', deployTargetCapMs('adb', { policy }))}`);
  return { ...resolved, members };
}

// --pid names the live process that holds the lease.
export function checkPid(value) {
  if (value === undefined || value === null) return null;
  const pid = Number(value);
  if (!Number.isSafeInteger(pid) || pid < 1) throw usage('--pid takes a live process id (a positive integer)');
  return pid;
}

// --profile and --pool belong to the emulator. The pool's size is the host's (hostPool); --pool may only ask for fewer.
export function emulatorBounds({ noConnect = false, profile: asked, pool: askedPool } = {}, env = process.env) {
  if (noConnect) throw usage('--no-connect is for a phone; an emulator is always made and connected');
  const profile = asked ?? 'default';
  if (!PROFILES[profile]) throw usage(`unknown emulator profile "${profile}" (known: ${Object.keys(PROFILES).join(', ')})`);
  const host = hostPool(env);
  if (askedPool === undefined) return { profile, pool: host };
  const pool = Number(askedPool);
  if (!Number.isSafeInteger(pool) || pool < 1) throw usage(`--pool takes a whole number of emulators, not "${askedPool}"`);
  if (pool > host) throw usage(`--pool can only lower this host's emulator pool of ${host} (the host sets it: $HUB_EMULATOR_POOL or <lock dir>/emulator-pool)`);
  return { profile, pool };
}

// An empty or malformed emulator id is refused: lock.mjs reads an empty id as any lease.
export function checkEmulatorLeaseId(id) {
  if (!id) throw usage('release emulator needs a lease id or $HUB_LEASE_ID (what lease exported)');
  if (!LEASE_ID.test(id)) throw usage(`release emulator: "${id}" is not a lease id (lowercase letters, digits and dashes)`);
  return id;
}

// ---- take ----

// Connects the phone a Lease on its lock was just taken for (unless noConnect) and records the device on the Lease. Returns the device
// `{phone, serial, adb_id, adb_port}`. Gives nothing back: a phone that does not come throws its own error (HUB_PHONE_AWAY) with the
// Lease still held, for the caller to give back. A Lease released or reclaimed while the phone was being found is HUB_LEASE_CANCELLED.
async function connectPhone(phone, lease, options, ctx) {
  const { env, log, timing } = ctx;
  const port = String(env.HUB_ADB_SERVER_PORT || '5037');
  const device = { phone: phone.device, serial: null, adb_id: null, adb_port: Number(port) };
  if (options.noConnect) return device;
  try {
    const adbEnv = { ...env, ANDROID_ADB_SERVER_PORT: port };
    delete adbEnv.ANDROID_SERIAL;
    const adb = ctx.adbFactory
      ? ctx.adbFactory({ env: adbEnv, signal: options.signal })
      : createAsyncAdb({ env: adbEnv, signal: options.signal });
    device.adb_id = await findPhone(adb, { serial: phone.serial, model: phone.model, waitMs: options.phoneWaitMs, pollMs: timing.phonePollMs, sleep: timing.sleep, now: timing.now, label: 'HUB_PHONE', log, signal: options.signal });
    // `serial` names the phone itself, not the adb id, which changes with each wireless endpoint.
    device.serial = phone.serial;
  } catch (error) {
    // The lease may already be gone (released or reclaimed mid-discovery): then there is nothing to give back.
    const owner = readOwnerOf(phone.lock, env);
    if (owner?.kind !== 'lease' || owner.lease_id !== lease.lease_id) {
      throw failure('HUB_LEASE_CANCELLED', `lease ${lease.lease_id} was released while the phone was being found`);
    }
    throw error;
  }
  let updated = false;
  try { updated = updateLease(phone.lock, lease.lease_id, { device }, { env, ino: lease.lock_ino }); } catch (error) { if (error.code !== 'HUB_LEASE_LOST') throw error; }
  if (!updated) {
    // The lease was released or reclaimed while the phone was being found; take nothing.
    throw failure('HUB_LEASE_CANCELLED', `lease ${lease.lease_id} was released while the phone was being found`);
  }
  return device;
}

// Takes the lease on one phone, then (unless noConnect) connects it. A phone that does not come gives the lease back;
// a lease released or reclaimed while the phone was being found ends as HUB_LEASE_CANCELLED holding nothing.
async function takePhone(phone, options, ctx) {
  const { env, log, timing } = ctx;
  const lease = await acquireLease(phone.lock, { ...options, env, log, pollMs: timing.leasePollMs, sleep: timing.sleep, now: timing.now });
  try {
    const device = await connectPhone(phone, lease, options, ctx);
    return { kind: 'phone', phone, lease, device };
  } catch (error) {
    if (error.code !== 'HUB_LEASE_CANCELLED') releaseLease(phone.lock, lease.lease_id, { env });
    throw error;
  }
}

// The verdict when no phone came within --wait: BUSY when every phone stayed held (one may still free), AWAY when a
// free phone never appeared (turn it on, or pair it again). The message names each phone and what kept it. `states` maps a
// device to `held` or the reason it was away.
function noPhoneError(fleet, states, waitMs, ctx) {
  const held = fleet.filter(phone => states.get(phone.device) === 'held');
  if (held.length === fleet.length) {
    const locks = listLocks({ env: ctx.env });
    const by = held.map(phone => `${phone.device} (${phone.lock}) is held by ${locks.find(entry => entry.name === phone.lock)?.describe ?? 'someone'}`).join('; ');
    return failure('HUB_LOCK_TIMEOUT', `every phone is held: ${by}; gave up after ${Math.round(waitMs / 1000)}s`);
  }
  const reasons = fleet.map(phone => `${phone.device} ${states.get(phone.device) ?? 'absent'}`).join(', ');
  const awayStates = [...new Set([...states.values()].filter(state => state !== 'held'))].join(', ') || 'absent';
  return Object.assign(failure('HUB_PHONE_AWAY', `no free phone came within the wait: ${reasons}`), { reason: awayStates });
}

// `phone` and `--match`: one Pool request (lock.mjs acquirePool, AD-33) that holds a place in the queue of every member, in the
// members' preference order (the extras, then the deploy phone), with --wait as one overall budget. A member that serves it is
// taken and its phone is given a slice of what is left to appear (HUB_DEVICE_PHONE_SLICE_MS, default 10s); a phone that does not
// come is given back and the request falls through to the next member, keeping its place, so a phone that frees or appears
// mid-wait is picked up. The winner takes its member and withdraws the rest; later takers queue behind it like any Lease.
async function takeAnyPhone(fleet, options, ctx, poolName = PHONE) {
  const { env, timing } = ctx;
  const sliceMs = Number(env.HUB_DEVICE_PHONE_SLICE_MS) || 10_000;
  const deadline = timing.now() + options.waitMs;
  const taken = await acquirePool(poolName, fleet.map(phone => phone.lock), {
    holder: options.holder, why: options.why, forMs: options.forMs, waitMs: options.waitMs, id: options.id ?? null, holderPid: options.holderPid ?? null,
    env, log: ctx.log, pollMs: timing.leasePollMs, sleep: timing.sleep, now: timing.now, signal: options.signal, policy: ctx.policy,
    accept: async (lock, record) => {
      const phone = fleet.find(entry => entry.lock === lock);
      const left = deadline - timing.now();
      try {
        return { ok: true, value: await connectPhone(phone, record, { ...options, phoneWaitMs: left > 0 ? Math.min(sliceMs, left) : 0 }, ctx) };
      } catch (error) {
        if (away(error)) return { ok: false, state: error.reason ?? 'absent' };
        throw error;
      }
    },
    giveUp: states => noPhoneError(fleet, new Map(fleet.map(phone => [phone.device, states.get(phone.lock)])), options.waitMs, ctx),
  });
  return { kind: 'phone', phone: fleet.find(phone => phone.lock === taken.name), lease: taken.record, device: taken.value };
}

// The lazy reaper, on the emulator acquire paths only: expired and abandoned emulator leases are torn down (their recorded
// pids only). `status` never calls it. A reaper that fails is a warning, never a failed acquire.
export async function reapBeforeAcquire(ctx) {
  try { await reap({ env: ctx.env, log: ctx.log, graceMs: ctx.emulator.graceMs, wait: false }); } catch (error) { ctx.warn?.(`the emulator reaper failed: ${error.message}`); }
}

async function takeEmulator(options, ctx) {
  const { env, timing } = ctx;
  const id = options.id ?? newLeaseId('emulator');
  await reapBeforeAcquire(ctx);
  const { lease, record } = await provision({ id, holder: options.holder, why: options.why, forMs: options.forMs, waitMs: options.waitMs, holderPid: options.holderPid, profileName: options.profile, pool: options.pool, env, log: ctx.log, signal: options.signal, sleep: timing.sleep, now: timing.now, pollMs: timing.leasePollMs, ...ctx.emulator });
  return { kind: EMULATOR, id, lease, record };
}

// The members of a `--match` Pool that are not definitively away, read over the same read-only wire query status uses (nothing is
// started or connected). A member reading absent, offline or unauthorized is dropped; every one dropped is HUB_DEVICE_AWAY (75) naming
// each, before any event is written. `unknown` (no adb server, a wedged one, no host key, a host that is not `linux`) drops nothing, so
// the ordered try decides as it always has. `--no-connect` skips it: that lease is the lock only, phone away or not.
async function reachableMembers(members, ctx) {
  let key = null;
  try { key = (ctx.hostKey ?? hostKey)({ env: ctx.env }); } catch (error) { if (error?.code !== 'HUB_HOST_UNKNOWN') throw error; }
  if (key !== 'linux') return members;
  const found = (ctx.inventory ?? realInventory)({ lockRoot: lockDir(ctx.env), hubAdbPort: Number(ctx.env.HUB_ADB_SERVER_PORT) || 5037 });
  const observed = await phoneObservations(members, ctx, found);
  const states = new Map(members.map(phone => [phone.device, phoneReachability(observed.get(phone.device) ?? null)]));
  const gone = new Set([REACHABILITY.absent, REACHABILITY.offline, REACHABILITY.unauthorized]);
  const left = members.filter(phone => !gone.has(states.get(phone.device)));
  if (left.length > 0) return left;
  const reason = members.map(phone => `${phone.device} ${states.get(phone.device)}`).join(', ');
  throw Object.assign(failure('HUB_DEVICE_AWAY', `no phone that matches is reachable: ${reason}`), { reason });
}

// One take for every kind of target: a phone, the `phone` Pool (an ordered try under one Pool request) or an emulator.
// A library caller gets the refusals the CLI makes, in the CLI's order: an unknown target, an id that is already taken,
// --for's bounds (the Pool is narrowed to the phones whose cap allows it), --why, --wait, --pid, and an emulator's profile and
// pool. The CLI checks the same rules earlier, for its message order.
// options: holder, why, forMs, waitMs, id, holderPid, noConnect, phoneWaitMs, signal (and profile, pool for an emulator).
export async function take(resolved, options, ctx) {
  if (!resolved || typeof resolved !== 'object') throw usage('take needs a resolved target (resolve a device word first)');
  checkLeaseId(options.id, { fleet: ctx.fleet, env: ctx.env });
  const bounded = checkBounds(resolved, { forMs: options.forMs, fleet: resolved.members, policy: ctx.policy });
  if (!options.why) throw usage('--why <text> is required');
  if (!Number.isFinite(options.waitMs) || options.waitMs < 0) throw usage('--wait must be a duration of 0 or more');
  checkPid(options.holderPid);
  const target = withoutRetired(bounded, ctx.env);
  switch (target.kind) {
    case 'phone': return takePhone(target.entry, options, ctx);
    case 'pool': return takeAnyPhone(target.by === 'match' && !options.noConnect ? await reachableMembers(target.members, ctx) : target.members, options, ctx, target.pool ?? PHONE);
    case EMULATOR: return takeEmulator({ ...options, ...emulatorBounds(options, ctx.env) }, ctx);
    default: throw usage(`cannot take a ${target.kind}`);
  }
}

// What the Claimant exports to use what it took: `lease` prints these, `run` puts them in the child's environment.
export function leaseExports(taken, envSerial = []) {
  if (taken.kind === EMULATOR) return emulatorExports(taken.record, envSerial);
  const { lease, device, phone } = taken;
  const vars = { HUB_LEASE_ID: lease.lease_id, HUB_DEVICE: phone.device };
  vars.ANDROID_ADB_SERVER_PORT = String(device.adb_port);
  if (device.adb_id) {
    vars.ANDROID_SERIAL = device.adb_id;
    for (const name of envSerial) vars[name] = device.adb_id;
  }
  return vars;
}

// ---- release ----

// A deploy job's ticket id is its place in line, not a lease: nothing here can release it, so say which run to cancel.
// Returns null for any other id; otherwise {code, id, message} (the code exits through the table; a front door prints the
// `HUB_DEVICE_JOB_ID` marker before the message).
export function jobTicket(id) {
  if (typeof id !== 'string' || !id.startsWith('job:')) return null;
  const [, repo, run] = /^job:([^#]+)#([^.]+)\.[^/]+\/.+$/.exec(id) ?? [];
  const hint = repo && repo !== 'local' ? ` (gh run cancel ${run} --repo ${repo})` : '';
  // A local run's id carries the process: the catch-up and a hand-run deploy have no GitHub run to cancel.
  const pid = repo === 'local' ? /^local-(\d+)$/.exec(run)?.[1] : undefined;
  const what = pid ? `it is the local process ${pid}, stop that process instead` : `cancel ${repo ? `run ${run} of ${repo}` : 'its run'} instead${hint}`;
  return { code: 'HUB_DEVICE_JOB_ID', id, message: `${id} is a deploy job's place in line, not a lease; ${what}` };
}

// Gives one lock's lease back by id, with no report (the holder's own exit paths).
export const releaseHeld = (lock, id, { env = process.env } = {}) => releaseLease(lock, id, { env });

// An emulator lease: its slot, record and processes, torn down. Returns emulator.mjs's result ({outcome, slot, record, result}).
export const releaseEmulator = async (id, ctx) => releaseEmulatorLease(checkEmulatorLeaseId(id), { env: ctx.env, log: ctx.log, graceMs: ctx.emulator.graceMs });

// The last resort when a process exits without its normal release: SIGKILL to the recorded processes, then the slot.
export function releaseEmulatorNow(id, { env = process.env } = {}) {
  const record = readRecord(env, id);
  try {
    if (!record || teardownNow(record, { env })) {
      releaseLease(GATE, id, { env });
      for (const name of record ? [record.slot] : []) releaseLease(name, id, { env });
    }
  } catch { /* the reaper finishes it */ }
}

const lockExists = (lock, env) => { try { statSync(join(lockDir(env), `${lock}.lock`)); return true; } catch { return false; } };

// A phone lease by id: the phone whose lock holds it, or whose queue is still waiting for it (a Pool request waits in every member's). Says what it found as
// {outcome, device, id, leaseId, notes}: released, cancelled, none (notes say what each phone is doing), job-held,
// unknown-holder, changed-hands. Idempotent for a lease that is already gone.
export function releasePhone(id, ctx) {
  const { env, fleet } = ctx;
  const owning = phoneOwning(fleet, env, id);
  const waiting = fleet.filter(phone => queueView(phone.lock, { env, includeStale: true }).some(waiter => waiter.lease_id === id));
  const found = owning ?? waiting[0] ?? null;
  if (!found) {
    const notes = [];
    for (const phone of fleet) {
      const owner = readOwnerOf(phone.lock, env);
      if (!owner && !lockExists(phone.lock, env)) continue;
      if (!owner) notes.push(`${phone.device} is being taken (its lock has no owner record yet); left alone`);
      else if (isLease(owner)) notes.push(`${phone.device} is leased as ${owner.lease_id} (${owner.holder ?? 'someone'}), not ${id}; left alone`);
      else notes.push(`${phone.device} is held by a deploy job now; left alone`);
    }
    return { kind: 'phone', outcome: 'none', id, notes };
  }
  // A Pool request waits in the queue of every member it can be served from: cancelling it takes it out of all of them (the request
  // writes its own one `cancel`).
  for (const phone of waiting) if (phone !== found) releaseLease(phone.lock, id, { env });
  const result = releaseLease(found.lock, id, { env });
  const base = { kind: 'phone', device: found.device, id, notes: [] };
  if (result.cancelled && !result.released) return { ...base, outcome: 'cancelled' };
  switch (result.reason) {
    case 'released': return { ...base, outcome: 'released', leaseId: result.owner.lease_id };
    case 'not-a-lease': return { ...base, outcome: 'job-held', notes: [`${found.device} is held by a deploy job now; left alone`] };
    case 'unknown-holder': return { ...base, outcome: 'unknown-holder', notes: [`${found.device} is being taken (its lock has no owner record yet); left alone, try again`] };
    default: return { ...base, outcome: 'changed-hands', notes: [`${found.device} changed hands while it was being released; left alone, check \`hub-device status\``] };
  }
}

// --any: whichever phone lease is held, in fleet order. A phone held by a deploy job (or mid-take) does not stop
// the others being freed; --any refuses only when no phone yielded a release, and then names the first refusal.
export function releaseAny(ctx) {
  const { env, fleet } = ctx;
  let refusal = null;
  for (const phone of fleet) {
    const result = releaseLease(phone.lock, null, { env });
    switch (result.reason) {
      case 'released': return { kind: 'phone', outcome: 'released', device: phone.device, leaseId: result.owner.lease_id, notes: [] };
      case 'none': continue;
      case 'not-a-lease': refusal ??= `${phone.device} is held by a deploy job, not a lease; left alone`; continue;
      case 'unknown-holder': refusal ??= `${phone.device} is being taken (its lock has no owner record yet); left alone, try again`; continue;
      default: refusal ??= `${phone.device} changed hands while it was being released; left alone, check \`hub-device status\``; continue;
    }
  }
  return refusal ? { kind: 'phone', outcome: 'refused', refusal, notes: [] } : { kind: 'phone', outcome: 'none', notes: [] };
}

// One release for every kind: `{any: true}` frees whichever phone lease is held, `{emulator: id}` an emulator lease, and `{id}`
// whatever holds that id (an emulator lease first, else a phone's). A deploy job's ticket id is refused (HUB_DEVICE_JOB_ID),
// and so is a target that names nothing (HUB_USAGE).
export async function release(target, ctx) {
  if (target?.any) return releaseAny(ctx);
  if (target?.emulator !== undefined) return { kind: EMULATOR, id: target.emulator, ...await releaseEmulator(target.emulator, ctx) };
  const job = jobTicket(target?.id);
  if (job) throw failure(job.code, job.message);
  if (!target?.id) throw usage('release needs a lease id, an emulator lease id, or any');
  if (isEmulatorLease(ctx.env, target.id)) return { kind: EMULATOR, id: target.id, ...await releaseEmulator(target.id, ctx) };
  return releasePhone(target.id, ctx);
}

const RUN_KEY = /^[A-Za-z0-9][A-Za-z0-9-]*--[A-Za-z0-9._-]+--\d{1,20}$/;

// A deploy run's Reservation (AD-7), released through lock.mjs on this host. Without a name every reservable name here is
// tried (a host holds only its own: adb on Linux, mac-ios on the Mac). Returns the list of {name, key} it released.
export function releaseReservations({ key, name }, ctx) {
  if (!RUN_KEY.test(key)) throw usage(`reservation release: "${key}" is not a run key (owner--repo--run)`);
  if (name !== undefined && !RESERVABLE.includes(name)) throw usage(`reservation release: --name is one of ${RESERVABLE.join(', ')}`);
  const released = [];
  for (const lock of name ? [name] : RESERVABLE) {
    const result = releaseReservation(lock, { env: ctx.env, key, now: ctx.timing.now, reason: 'released' });
    if (result.status === 'released') released.push({ name: lock, key });
  }
  return released;
}

// ---- extend ----

// Extends a live Lease on a phone or an emulator slot by `forMs` (lock.mjs refuses while anyone waits, past the deploy cap and
// past 48 h in total). Only a Lease that holds its lock extends: a waiter's id holds nothing. Returns the new owner record.
export function extend(id, { forMs }, ctx) {
  const { env, fleet, policy = null, timing } = ctx;
  if (!(forMs > 0) || !Number.isFinite(forMs)) throw usage('an extension is for more than 0 ms');
  const lock = readRecord(env, id)?.slot ?? phoneOwning(fleet, env, id)?.lock;
  if (!lock) throw failure('HUB_LEASE_LOST', `lease ${id} holds nothing to extend`);
  return extendLease(lock, id, { forMs, env, now: timing?.now, policy });
}


// ---- status ----

// Which fleet phones the hub's adb server lists, from the one read-only query (`reachability.queryAdb`: the wire only, never the adb
// client). Returns each fleet phone's observation: the state adb lists it in, null when the server does not list it, or a note saying
// why nobody could look. Only asked when the inventory shows the hub's server already running, so status can never start one (and a
// Mac, with no /proc, asks nothing). An id that cannot be read (unauthorized, offline) is not matched, so that phone reads absent.
async function phoneObservations(fleet, ctx, found) {
  const { env, adbWire, timing } = ctx;
  const hubPort = Number(env.HUB_ADB_SERVER_PORT) || 5037;
  const { note, listed, serials } = await queryAdb({ port: hubPort, running: found.adb_servers.some(server => server.port === hubPort), wire: adbWire ?? createAdbWire, sleep: timing.sleep });
  if (note !== null) return new Map(fleet.map(phone => [phone.device, note]));
  return new Map(fleet.map(phone => {
    const entry = listed.find(device => idMatchesSerial(device.id, phone.serial) || (Boolean(serials.get(device.id)) && serials.get(device.id) === phone.serial));
    return [phone.device, entry ? entry.state : null];
  }));
}

// What `presence` has always said for an observation: adb's own word for a state, `reachable` for `device`, `absent` for none.
const presenceOf = observed => (observed === 'device' ? 'reachable' : observed === null ? 'absent' : observed);

// Every lock name status walks. Today's names come first and in their order (the fleet's locks, the emulator gate, the reservable
// names, every held lock); then every name the lock dir holds a `.lock`, `.queue` or `.reservations` for that is a seeded lock, a
// `res-<slug>` or an `emulator-<n>` slot of the pool, sorted. That is how a free `res-*` or `emulator-<n>` queue with waiters shows.
// Directory entries are only names: a service, `registry.json` or an `s3-*` lock is never walked unless it is held.
function walkSet(fleet, env, held) {
  const names = new Set([...fleet.map(phone => phone.lock), GATE, ...RESERVABLE, ...held]);
  const slot = name => { const match = /^emulator-(\d+)$/.exec(name); return match !== null && String(Number(match[1])) === match[1] && Number(match[1]) >= 1 && Number(match[1]) <= MAX_POOL; };
  const walkable = name => Object.hasOwn(SEED_RESOURCES, name) || (name.startsWith('res-') && resourceOf(name) === name) || slot(name);
  let entries = [];
  try { entries = readdirSync(lockDir(env)); } catch { /* no lock dir: nothing is held */ }
  const found = new Set();
  for (const entry of entries) {
    const match = /^(.+)\.(?:lock|queue|reservations)$/.exec(entry);
    if (match !== null && walkable(match[1])) found.add(match[1]);
  }
  for (const name of [...found].sort()) names.add(name);
  return names;
}

// A service sees no phone serial, UDID or adb id of a Resource in its QA set; the keys stay, their values are null.
function redact(row) {
  for (const key of ['serial', 'udid', 'adb_id']) if (key in row) row[key] = null;
  for (const key of ['phone', 'device']) {
    const nested = row[key];
    if (nested !== null && typeof nested === 'object') row[key] = { ...nested, ...('serial' in nested ? { serial: null } : {}), ...('adb_id' in nested ? { adb_id: null } : {}) };
  }
}

const AUDIENCES = Object.freeze(['local', 'service']);

// Everything `status` shows, as the `--json` object: {phones, locks, waiters, reservations, inventory, emulators}. Read only: it
// walks the lock dir and the hub's adb server (over the wire), and writes nothing to the lock dir or the Event Log (FR-13).
// Every row of those lists that names a Resource carries `resource` (resourceOf(lock)), `deploy_target` and then `reachability`
// ({state, checked_at, age_ms, stale}), beside the v1a keys, which keep their values; `resource` and `reachability` are null for a
// lock that is no Resource. `deploy_target` is true for a Resource deploys install to (the seed of devices.json, built once with
// no QA file: local status never reads it), false for any other Resource (a `res-*` lock too) and null when `resource` is null.
// A reading is taken only on the host that owns the Resource (`hostKey`: the Linux host reads the phones, the Mac the iPad) and
// only for what a row names; every other row shows the missing reading, unknown and stale, never reachable. A null key (this host
// does not know which host it is) reads nothing. `audience` is `local` or `service`; a service sees the `qa_ids` Resources' serials,
// UDIDs and adb ids as null.
export async function statusView(key, options, ctx) {
  const { audience, qa_ids: qaIds = [] } = options ?? {};
  if (!AUDIENCES.includes(audience)) throw usage(`status audience is one of ${AUDIENCES.join(', ')}, not "${audience}"`);
  const { env, timing, fleet } = ctx;
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
  const pooled = new Map();   // request id -> {row, etas}: the Pool requests folded so far
  const reservations = [];
  // The policy is read once and never fails status: a broken one leaves every reading stale and every ETA null.
  let policyRead = false;
  let settings = null;
  const policyOf = () => {
    if (!policyRead) { policyRead = true; try { settings = ctx.policy ?? loadPolicy().policy; } catch { settings = null; } }
    return settings;
  };
  // The ETAs come from one windowed read of the Event Log and one policy, shared by every waiter and read only when a live waiter
  // exists; a failure of either leaves those waiters with `eta: null` (`eta=?`) and never fails status.
  let history = null;
  const loadEtaInputs = () => {
    if (history !== null) return;
    history = false;
    try { history = policyOf() ? etaHistory({ env, now: nowMs, policy: policyOf() }) : false; } catch { history = false; }
  };
  for (const name of walkSet(fleet, env, locks.map(entry => entry.lock))) {
    const view = queueView(name, { env, includeStale: true, now: timing.now });
    const device = nameOf(fleet, name);
    // A run's Reservation holds a place but is no waiter: it has its own section, and the tickets are numbered without it.
    const tickets = view.filter(entry => entry.kind !== 'reservation');
    let etas = new Map();
    if (tickets.some(ticket => !ticket.stale)) {
      loadEtaInputs();
      if (history) etas = waiterEtas({ owner: readOwnerOf(name, env), view, events: history, policy: settings, now: nowMs });
    }
    tickets.forEach((waiter, index) => {
      const row = {
        lock: name, device, position: index + 1, lease_id: waiter.lease_id, holder: waiter.holder, why: waiter.why, since: waiter.enqueued_at, stale: waiter.stale,
        kind: waiter.kind, repo: waiter.repo ?? null, run: waiter.run ?? null, job: waiter.job ?? null, eta: waiter.stale ? null : etas.get(waiter.file) ?? null,
      };
      // A Pool request has a ticket in every member's queue (AD-33): one row for the request, with the keys of the member where it
      // stands nearest the front (the first walked on a tie), its place in each member and the earliest of their ETAs.
      if (typeof waiter.pool === 'string' && typeof waiter.request === 'string') {
        const one = pooled.get(waiter.request);
        if (!one) {
          pooled.set(waiter.request, { row: Object.assign(row, { request: waiter.request, pool: waiter.pool, positions: { [name]: row.position } }), etas: [row.eta] });
          waiters.push(row);
          return;
        }
        one.row.positions[name] = row.position;
        one.etas.push(row.eta);
        if (row.position < one.row.position) Object.assign(one.row, row);
        return;
      }
      waiters.push(row);
    });
    for (const entry of view) {
      if (entry.kind !== 'reservation') continue;
      reservations.push({
        lock: name, device, run_key: entry.run_key, repo: entry.repo ?? null, run: entry.run ?? null, place: entry.place, blocking: entry.blocking,
        grace: entry.grace, reserved_at: entry.reserved_at, expires_at: entry.expires_at, stale: entry.stale,
      });
    }
  }
  for (const { row, etas } of pooled.values()) row.eta = row.stale ? null : earliest(etas);
  const found = (ctx.inventory ?? realInventory)({ lockRoot: lockDir(env), hubAdbPort: Number(env.HUB_ADB_SERVER_PORT) || 5037 });
  const observed = await phoneObservations(fleet, ctx, found);
  const phones = fleet.map(phone => {
    const lock = locks.find(entry => entry.lock === phone.lock) ?? null;
    const owner = lock?.kind === 'lease' ? { lease_id: lock.lease_id, holder: lock.holder, why: lock.why, expires_at: lock.expires_at, adb_id: lock.phone?.adb_id ?? null } : null;
    return {
      device: phone.device, lock: phone.lock, deploy: phone.deploy, name: phone.name, model: phone.model, serial: phone.serial,
      held: lock ? lock.kind : 'free', holder: owner?.holder ?? null, lease_id: owner?.lease_id ?? null, why: owner?.why ?? null,
      expires_at: owner?.expires_at ?? null, adb_id: owner?.adb_id ?? null, repo: lock?.repo ?? null, run: lock?.run ?? null,
      presence: presenceOf(observed.get(phone.device) ?? null),
    };
  });
  // The pool's own processes are managed and carry their lease id: a pid counts only while it is still the recorded process.
  const emulators = emulatorStatus(env);
  const owners = new Map(emulators.flatMap(entry => entry.pids.filter(pid => pid.alive).map(pid => [pid.pid, entry.lease_id])));
  for (const list of [found.adb_servers, found.emulators, found.xvfb]) {
    for (const item of list) if (owners.has(item.pid)) Object.assign(item, { managed: true, lease_id: owners.get(item.pid) });
  }

  // Every row gets its Resource; the readings come after, so the iPad is asked only when a row names it.
  const rowsOf = [[phones, phone => phone.lock], [locks, entry => entry.lock], [waiters, waiter => waiter.lock], [reservations, entry => entry.lock], [emulators, entry => entry.slot]];
  const deployTargets = deployTargetIds(seed(loadDevices(env), { qaDevices: () => [] }));
  for (const [rows, lockOf] of rowsOf) {
    for (const row of rows) {
      row.resource = resourceOf(lockOf(row));
      row.deploy_target = row.resource === null ? null : deployTargets.has(row.resource);
    }
  }
  const readings = new Map();   // Resource id -> stored reading
  if (key === 'linux') {
    const readAt = timing.now();
    for (const phone of fleet) {
      const resource = resourceOf(phone.lock);
      if (resource !== null) readings.set(resource, stamp(phoneReachability(observed.get(phone.device) ?? null), { checkedAt: readAt, receivedAt: readAt }));
    }
  }
  if (key === 'mac' && rowsOf.some(([rows]) => rows.some(row => row.resource === 'ios-lane'))) {
    let state = REACHABILITY.unknown;
    try {
      const { udid, model } = loadDevices(env).ios;
      const devicectl = ctx.devicectl ?? createDevicectl({ env });
      state = await readIpad({ list: () => devicectl(['list', 'devices'], 10), udid, model });
    } catch { /* an iPad nobody could ask is unknown */ }
    const readAt = timing.now();
    readings.set('ios-lane', stamp(state, { checkedAt: readAt, receivedAt: readAt }));
  }
  const maxAgeS = policyOf()?.registry?.reachability_max_age_s;
  const at = timing.now();
  for (const [rows] of rowsOf) {
    for (const row of rows) row.reachability = row.resource === null ? null : present(readings.get(row.resource) ?? null, { now: at, maxAgeS });
  }
  if (audience === 'service') {
    const qa = new Set(Array.isArray(qaIds) ? qaIds : []);
    for (const [rows] of rowsOf) for (const row of rows) if (row.resource !== null && qa.has(row.resource)) redact(row);
  }
  return { phones, locks, waiters, reservations, inventory: found, emulators };
}

// ---- discover (FR-4) ----

// The devices this host can see that no seeded Resource names, from the read-only queries only: the hub's adb server over the wire on
// the Linux host (never started, connected or asked through the adb client; no server answers `no adb server`), `devicectl list
// devices` on the Mac. The host key picks the transport (AD-47): a host that does not know its key throws HUB_HOST_UNKNOWN, because
// guessing from the platform would list the Mac's adb devices, which are not the hub's. The seed is devices.json's alone: the QA file
// is never read. Returns `reachability.discover`'s document. Writes nothing.
export async function discover(key, ctx) {
  if (key !== 'linux' && key !== 'mac') throw failure('HUB_HOST_UNKNOWN', `this host does not know which host it is${key ? ` ("${key}" is neither linux nor mac)` : ''}, so it cannot choose how to discover devices; run \`mise run hosts:install\` on it`);
  const { env, timing } = ctx;
  const registry = seed(loadDevices(env), { qaDevices: () => [] });
  if (key === 'mac') {
    let ipads;
    try { ipads = { document: await (ctx.devicectl ?? createDevicectl({ env }))(['list', 'devices'], 10) }; } catch (error) { ipads = { error }; }
    return discoverDevices({ seed: registry, host: 'mac', ipads });
  }
  const hubPort = Number(env.HUB_ADB_SERVER_PORT) || 5037;
  const found = (ctx.inventory ?? realInventory)({ lockRoot: lockDir(env), hubAdbPort: hubPort });
  const adb = await queryAdb({ port: hubPort, running: found.adb_servers.some(server => server.port === hubPort), wire: ctx.adbWire ?? createAdbWire, sleep: timing.sleep });
  return discoverDevices({ seed: registry, host: 'linux', adb });
}
