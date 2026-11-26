// The Claims library (AD-24): every action a Claimant can take on a Resource, and every rule that bounds it, in one place.
// Resolve, take, release, extend, Lease id minting, the bounds checks, status assembly and the error-to-exit table live
// here, so `hub-device` (and later the Hub API and the Host Agent) can only parse, call and print: none of them can take,
// refuse or report one action differently. The deploy path never imports this file (tools/deploy-path.test.mjs).
//
// The fleet is a projection of the Registry (Story 6.9): `loadFleet` reads `<lock dir>/registry.json` fresh on every call, so a phone
// registered through the Hub API is leasable by name or id on the next call, from every caller of this library (the CLI now, the
// Hub API and the Host Agent later); with no readable file it is the in-memory seed of devices.json, as it always was.
//
// A take is refused (HUB_RESOURCE_RETIRED, exit 2, `reason` retired|seed-missing, `resource`) for a Resource the Registry file marks
// retired or seed_missing, before anything is queued or written; the file only is read (`readRegistryFile`), so a missing or unreadable
// one refuses nothing and the QA file is never opened.
//
// A service (the Hub API now, the Host Agent in Epic 9) reaches an emulator through the same calls as a phone (Story 7.4): `serviceLease`,
// `findLease`, `serviceExtend` and `serviceRelease` take, find, extend and give back one, and its reap, boot and teardown run in a worker
// thread (`emulator-thread.mjs`; the seams `provisionOffThread` and `releaseOffThread` replace it in a test), never on a request path.
//
// Everything that writes the lock directory goes through lock.mjs and emulator.mjs (AD-1); reads may look at it directly. Errors carry a `code`; a usage
// refusal is `code: 'HUB_USAGE'`. The context every action takes is the one `createContext` builds: `env`, `log`, `warn`,
// `timing`, `emulator`, `adbFactory`, `adbWire`, `devicectl`, `hostKey`, `inventory`, `policy`, `fleet`, `qaDevices` and `registry` (the last two are the seams `matchTarget` reads), plus `fetchImpl` and `timeout` (the seams of the Hub API client, `registryWrite`).
import { randomBytes } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { findPhone, idMatchesSerial } from '../ci/lib/adb.mjs';
import { createDevicectl } from '../ci/lib/devicectl.mjs';
import { earliest, expectedEnd } from '../ci/lib/eta.mjs';
import { loadDevices } from '../ci/lib/devices.mjs';
import { CLAIMANT_KINDS, MAX_LEASE_MS, RESERVABLE, SEED_RESOURCES, acquireLease, acquirePool, cachedProcessStart, cancelRequest, capText, checkActor, deployTargetCapMs, etaHistory, extendLease, forceRelease, forceReleaseJobError, heldText, isLease, listLocks, lockDir, newLeaseId as newLockLeaseId, queueView, readOwner, releaseLease, releaseReservation, resourceOf, updateLease, waiterEtas } from '../ci/lib/lock.mjs';
import { sleep as realSleep } from '../ci/lib/pause.mjs';
import { loadPolicy } from '../ci/lib/policy.mjs';
import { createAdbWire } from './adb-wire.mjs';
import { createAsyncAdb } from './async-adb.mjs';
import { GATE, LEASE_ID, MAX_POOL, PROFILES, doomed, emulatorStatus, exportsOf as emulatorExports, forceReleaseSlot, hostPool, isEmulatorLease, isEmulatorLock, isEmulatorSlot, provision, readRecord, reap, releaseEmulator as releaseEmulatorLease, resolveImage, slotHolding, teardownNow } from './emulator.mjs';
import { offThread } from './emulator-thread.mjs';
import { REACHABILITY, discover as discoverDevices, phoneReachability, present, queryAdb, readIpad, stamp } from '../registry/reachability.mjs';
import { match, canonical, parseQuery, retirement, visibility } from '../registry/match.mjs';
import { readRegistry, readRegistryFile } from '../registry/store.mjs';
import { deployTargetIds, loadQaDevices, seed } from '../registry/seed.mjs';
import { viewPools, viewRecord } from '../registry/view.mjs';
import { call } from '../hub-client.mjs';
import { inventory as realInventory } from './inventory.mjs';

export const PHONE = 'phone';
export const EMULATOR = 'emulator';
// The one rule for which ids are emulator slots (`emulator-<n>`, 1 to MAX_POOL), and the one dispatch both front doors of a force-release use:
// an id shaped like a slot (`emulator-` and digits, not the gate) goes to `forceReleaseEmulator`, which refuses one that is no slot (`bad-slot`).
export { isEmulatorSlot };
export const namesEmulatorSlot = id => typeof id === 'string' && id !== GATE && isEmulatorLock(id);

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
  // Story 7.3: an extension refused (reason waiters, expired, cap or too-long) is the busy exit, as a waiter's refusal always was in spirit.
  HUB_LEASE_EXTEND_REFUSED: 76,
  HUB_LEASE_LOST: 1,
  // Story 7.2: a service's wait: a Lease or a waiter no id names (2), a wait another connection took over, a service that is stopping (1).
  HUB_LEASE_NOT_FOUND: 2,
  HUB_LEASE_SUPERSEDED: 1,
  HUB_API_RESTARTING: 1,
  // Story 7.5: a cancel of a request that is not waiting (unknown, or already holding its lock: release it), of a Reservation (force-release it), or addressed to another host.
  HUB_REQUEST_NOT_FOUND: 2,
  HUB_CANCEL_RESERVATION: 2,
  HUB_WRONG_HOST: 2,
  // Story 7.6: a force-release of a deploy job's Hold (a Job Hold is only ended by cancelling its run).
  HUB_FORCE_RELEASE_JOB: 2,
  // Story 7.7: a force-release of a run's Reservation that no longer exists (already released, never reserved).
  HUB_RESERVATION_NOT_FOUND: 2,
  // Story 7.4: an emulator that would not boot (or whose teardown would not finish) through a service: the host's trouble, the busy exit's opposite.
  HUB_EMULATOR_FAILED: 1,
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
  // Story 6.7: a retire or an identity or name edit of a seeded Resource (a hub release changes those).
  HUB_REGISTRY_SEEDED: 2,
  // Story 6.8: the same-host client's two answers (tools/hub-client.mjs): never an HTTP answer. DOWN means nothing was sent; UNKNOWN that the write may have applied.
  HUB_API_DOWN: 1,
  HUB_API_UNKNOWN: 1,
});
export const exitCodeOf = error => (Object.hasOwn(EXIT_CODES, error?.code) ? EXIT_CODES[error.code] : EXIT_FAILURE);

// The HTTP answer of a library error (Story 7.1): the status a service gives an error that carries none, and the `reason` it is
// answered with (data, so the Hub API and the Host Agent cannot answer one error two ways). A code not in the table has no answer
// here (`httpAnswerOf` is null): it is a bug of the service. An error that carries its own `status` keeps it.
export const HTTP_ANSWERS = Object.freeze({
  HUB_USAGE: Object.freeze({ status: 400 }),
  HUB_EMULATOR_USAGE: Object.freeze({ status: 400 }),
  HUB_LEASE_TOO_LONG: Object.freeze({ status: 400 }),
  HUB_DEVICE_JOB_ID: Object.freeze({ status: 400 }),
  HUB_NO_MATCH: Object.freeze({ status: 404, reason: 'no-match' }),
  HUB_LOCK_TIMEOUT: Object.freeze({ status: 409, reason: 'busy' }),
  HUB_DEVICE_BUSY: Object.freeze({ status: 409, reason: 'busy' }),
  HUB_POOL_CROSS_HOST: Object.freeze({ status: 409 }),
  HUB_RESOURCE_RETIRED: Object.freeze({ status: 409 }),
  HUB_LEASE_CANCELLED: Object.freeze({ status: 409 }),
  HUB_LEASE_NOT_FOUND: Object.freeze({ status: 404 }),
  HUB_LEASE_EXTEND_REFUSED: Object.freeze({ status: 409 }),
  HUB_LEASE_LOST: Object.freeze({ status: 409 }),
  HUB_LEASE_SUPERSEDED: Object.freeze({ status: 409, reason: 'superseded' }),
  // Story 7.5: HUB_REQUEST_NOT_FOUND carries its own `reason` (`unknown`, or `held` for a request that already holds its lock).
  HUB_REQUEST_NOT_FOUND: Object.freeze({ status: 404 }),
  HUB_CANCEL_RESERVATION: Object.freeze({ status: 409, reason: 'reservation' }),
  HUB_WRONG_HOST: Object.freeze({ status: 409, reason: 'wrong-host' }),
  // Story 7.6: carries its own `repo`, `run` and `job` members (null when unknown).
  HUB_FORCE_RELEASE_JOB: Object.freeze({ status: 409, reason: 'job' }),
  // Story 7.7: carries its own `reason` (`unknown`).
  HUB_RESERVATION_NOT_FOUND: Object.freeze({ status: 404 }),
  HUB_API_RESTARTING: Object.freeze({ status: 503, reason: 'restarting' }),
  HUB_PHONE_AWAY: Object.freeze({ status: 503, reason: 'away' }),
  HUB_DEVICE_AWAY: Object.freeze({ status: 503, reason: 'away' }),
  HUB_HOST_UNKNOWN: Object.freeze({ status: 503, reason: 'host-unknown' }),
  HUB_EMULATOR_FAILED: Object.freeze({ status: 503, reason: 'emulator-failed' }),
});
export const httpAnswerOf = error => (Object.hasOwn(HTTP_ANSWERS, error?.code) ? HTTP_ANSWERS[error.code] : null);

const usage = message => Object.assign(new Error(message), { code: 'HUB_USAGE' });
const failure = (code, message) => Object.assign(new Error(message), { code });
const away = error => error?.code === 'HUB_PHONE_AWAY';
const readOwnerOf = (name, env) => readOwner(join(lockDir(env), `${name}.lock`));

// Whether the lock `lock` is held (an owner record is there) and whether anyone waits on it (any non-stale queue entry): the two facts
// a Registry reader needs to tell a retiring Resource (still held or waited on) from a hidden one (AD-31). Read only; never throws
// (a lock dir that cannot be read is idle).
export function lockActivity(lock, { env = process.env, now = Date.now, processStart } = {}) {
  let held = false;
  let queued = false;
  try { held = readOwnerOf(lock, env) !== null; } catch { /* idle */ }
  try { queued = queueView(lock, { env, now, ...(processStart ? { processStart } : {}) }).length > 0; } catch { /* idle */ }
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
export function createContext({ env = process.env, sleep = realSleep, now = Date.now, log = () => {}, warn = () => {}, adbFactory, adbWire, devicectl, hostKey: hostKeyOf, inventory, policy = null, fleet, qaDevices, registry, fetchImpl, timeout, processStart, liveStart, adbQuery } = {}) {
  return {
    env, log, warn, policy, adbFactory, adbWire, devicectl, hostKey: hostKeyOf, inventory, fleet, qaDevices, registry, fetchImpl, timeout, processStart, liveStart, adbQuery,
    timing: { sleep, now, leasePollMs: Number(env.HUB_DEVICE_POLL_MS) || 1000, phonePollMs: Number(env.HUB_DEVICE_POLL_MS) || 3000 },
    emulator: {
      graceMs: Number(env.HUB_EMULATOR_KILL_GRACE_MS) || 15_000,
      bootTimeoutMs: Number(env.HUB_EMULATOR_BOOT_TIMEOUT_MS) || 360_000,
      bootPollMs: Number(env.HUB_EMULATOR_POLL_MS) || 2000,
      // How long a slot's force-release waits for another teardown's reaper lock (Story 7.8); undefined is the library's 2 min.
      reaperWaitMs: Number(env.HUB_EMULATOR_REAPER_WAIT_MS) || undefined,
    },
  };
}

// ---- the fleet and ids ----

// A phone this CLI cannot lease: it lives on a host that is not `linux`. (Destructured, so claims.mjs keeps its one record-host comparison, `isLocal`.)
const isOtherHost = ({ host }) => host !== 'linux';

// The fleet entries of a list of Registry records: every phone on the `linux` host, in the list's order (retired and seed-missing ones
// included: release, `withoutRetired` and status still need them). `device` is the record's `name` (the word a caller types), `deploy`
// whether deploys install to it, `name` its display name and `serial` and `model` its identity (null when it has none).
export const phonesOf = resources => resources
  .filter(({ kind, host }) => kind === 'phone' && host === 'linux')
  .map(resource => ({ device: resource.name, lock: resource.lock, deploy: resource.deploy_target === true, name: resource.display_name ?? resource.name, serial: resource.identity?.serial ?? null, model: resource.identity?.model ?? null }));

// The phones this tool can lease, in the order `phone` prefers them: a projection of the Registry seed (tools/registry/seed.mjs),
// which is the one derivation from devices.json. The S26 is the deploy phone (devices.android): it sits under the `adb` host
// lock deploys take, so its lock name can never change, and every further phone (devices.android_extra) gets a lock of its own
// lowercased name. Nothing but the seed reads android_extra. The QA file is never read here (`qaDevices: () => []`).
export const fleetOf = devices => phonesOf(seed(devices, { qaDevices: () => [] }).resources);

// The phones this checkout can lease: the Registry file's phones (`registry.json` in the lock dir, read fresh, no cache), or, when it is
// missing or unreadable (one HUB_REGISTRY_FORMAT warning through `warn`), `fleetOf` of devices.json, which is a broken one's tool
// failure, named like any other. The QA file is never read.
export const loadFleet = (env, { warn } = {}) => phonesOf(readRegistry({ env, qaDevices: () => [], warn }).resources);

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
// The optional process-start reader of a context (the service's host snapshot, AD-44), as the option the lock library takes; none is the CLI's own.
const readerOf = ctx => (ctx?.processStart ? { processStart: ctx.processStart } : {});
const phoneWaiting = (fleet, env, id, processStart) => fleet.find(phone => queueView(phone.lock, { env, includeStale: true, ...(processStart ? { processStart } : {}) }).some(waiter => waiter.lease_id === id)) ?? null;

// The `phone` word's members, in order: the matcher's named list over the Registry (the file, else the seed of devices.json; never the QA
// file, no warning), as fleet entries: the S24, then the S26, then every runtime `linux` phone that is not dedicated_qa, by created_at.
// The retirement marks are stripped so a retired member stays in the list: `withoutRetired` narrows it and says why when none is left.
function phoneMembers(fleet, env) {
  const registry = readRegistry({ env, qaDevices: () => [] });
  const live = registry.resources.map(({ retired_at: _retired, seed_missing: _missing, ...rest }) => rest);
  const named = match({ ...registry, resources: live }, { pool: PHONE }, null);
  return named.members.map(member => fleet.find(phone => phone.lock === member.lock)).filter(Boolean);
}

// `--match <query>`: a Capability query resolved by the matcher against the Registry: `<lock dir>/registry.json` read fresh on every call
// (the store, tools/registry/store.mjs), or the in-memory seed when there is no file or it is unreadable (one HUB_REGISTRY_FORMAT warning
// through `ctx.warn`). The seed's QA marks come from `ctx.qaDevices` (default the private QA file); `ctx.registry()` replaces the whole registry. What the CLI cannot hold
// is dropped with its reason: a member that is not a phone, or a phone `ctx.fleet` does not know. Returns the Pool target `take` tries
// in order: `{kind: 'pool', by: 'match', pool: 'match:<canonical query>', members}`. Throws HUB_USAGE for a bad query, HUB_NO_MATCH
// (with `reason`, `excluded`) when nothing can serve it and HUB_POOL_CROSS_HOST when the members span hosts. Reads, never writes.
//
// A service (Story 7.4: `emulators: true`; the CLI's `--match` never passes it and keeps refusing the emulator Pool) also serves the
// emulator: a `profile=<name>` clause (one, with `=`; HUB_USAGE otherwise) names the emulator Pool and its profile, and a query whose
// every member is the emulator Pool (`kind=emulator-pool`) names it with the default profile. Both return `{kind: 'emulator', by:
// 'match', profile}` (`profile` null for the default). With a `profile` clause any other clause must still hold for the emulator Pool's
// own Resource (else HUB_NO_MATCH, naming what excluded it). Whether the profile's image is installed is the caller's check.
export function matchTarget(text, { forMs, emulators = false } = {}, ctx) {
  const clauses = parseQuery(text);
  const registry = ctx.registry?.() ?? readRegistry({ env: ctx.env, qaDevices: ctx.qaDevices ?? (() => loadQaDevices({ env: ctx.env })), warn: ctx.warn });
  const policy = ctx.policy ?? loadPolicy().policy;
  if (emulators) {
    const profiles = clauses.filter(clause => clause.key === 'profile');
    if (profiles.length > 1) throw usage(`match "${text}": name one profile clause at most`);
    if (profiles.length === 1) {
      const [{ op, value }] = profiles;
      if (op !== '=') throw usage(`match clause "profile${op}${value}": a profile is named with = (profile=${Object.keys(PROFILES).join(', profile=')})`);
      const rest = clauses.filter(clause => clause.key !== 'profile');
      if (rest.length > 0) {
        const pool = registry.resources.filter(record => record.kind === 'emulator-pool');
        match({ ...registry, resources: pool }, { query: rest, for_ms: forMs }, policy);
      }
      return { kind: EMULATOR, by: 'match', profile: value };
    }
  }
  const found = match(registry, { query: clauses, for_ms: forMs }, policy);
  if (emulators && found.members.every(record => record.kind === 'emulator-pool')) return { kind: EMULATOR, by: 'match', profile: null };
  const members = [];
  const excluded = [...found.excluded];
  for (const record of found.members) {
    const phone = record.kind === 'phone' ? ctx.fleet.find(entry => entry.lock === record.lock) : null;
    if (phone) members.push(phone);
    else excluded.push({ id: record.id, why: record.kind === 'phone' ? (isOtherHost(record) ? `is a phone on ${record.host}; hub-device leases a phone on linux` : 'is known only from the QA file; hub-device cannot lease it yet') : `is ${/^[aeiou]/.test(record.kind) ? 'an' : 'a'} ${record.kind}; --match takes a phone` });
  }
  if (members.length === 0) {
    const reason = excluded.map(({ id, why }) => `${id} ${why}`).join('; ');
    throw Object.assign(failure('HUB_NO_MATCH', `no Resource matches: ${reason}`), { reason, excluded });
  }
  return { kind: 'pool', by: 'match', pool: `match:${canonical(clauses)}`, members };
}

// ---- the Registry verbs (Story 6.8) ----

// The Hub API route of each Registry write: `add` registers, `edit` and `retire` name a Resource by id (URI-encoded).
const REGISTRY_ROUTES = Object.freeze({
  add: () => '/registry/resources',
  edit: id => `/registry/resources/${encodeURIComponent(id)}`,
  retire: id => `/registry/resources/${encodeURIComponent(id)}/retire`,
});

// A Registry write through the Hub API, the Registry's only writer (AD-27): `op` is add, edit or retire, `body` the route's body (the
// caller sets `actor`). Resolves `{status, body}`; throws what tools/hub-client.mjs throws (HUB_API_DOWN, HUB_API_UNKNOWN, or the
// problem's own error).
export async function registryWrite(op, { id, body }, ctx) {
  if (!Object.hasOwn(REGISTRY_ROUTES, op)) throw new TypeError(`registryWrite: unknown op "${op}" (${Object.keys(REGISTRY_ROUTES).join(', ')})`);
  if (op !== 'add' && (typeof id !== 'string' || id === '')) throw new TypeError(`registryWrite ${op}: a Resource id is required`);
  return call({ method: 'POST', path: REGISTRY_ROUTES[op](id), body }, { policy: ctx.policy ?? loadPolicy().policy, fetchImpl: ctx.fetchImpl, timeout: ctx.timeout });
}

// The revision of `registry.json` on disk, or 0 when there is no readable file: what an edit is based on when the caller names none.
export const registryRev = ctx => readRegistryFile(ctx.env ?? process.env)?.rev ?? 0;

// The Registry as a reader on this host sees it, read from the disk alone (no service): `{rev, source, resources, pools}` with each
// record through the one view (hidden ones dropped; a marked record's lock read for held and queued) and the Pools through `viewPools`.
// `audience` `local` keeps QA identities (this host's own user); the API serves `service`.
export function registryList({ audience = 'local' } = {}, ctx) {
  const env = ctx.env ?? process.env;
  const registry = readRegistry({ env, qaDevices: ctx.qaDevices ?? (() => loadQaDevices({ env })), warn: ctx.warn });
  const policy = ctx.policy ?? loadPolicy().policy;
  const resources = registry.resources.map(record => {
    const activity = retirement(record) !== null ? lockActivity(record.lock, { env, now: ctx.timing?.now ?? ctx.now, ...readerOf(ctx) }) : {};
    return viewRecord(record, { audience, held: activity.held === true, queued: activity.queued === true });
  }).filter(Boolean);
  return { rev: registry.rev, source: registry.source, resources, pools: viewPools(registry, policy) };
}

// A target names one lease (an id: an emulator lease, then the phone holding it, then the phone it waits on) or a device word
// (a fleet phone, the `phone` Pool, `emulator`). An id wins over a word; `words`/`ids` narrow what is tried. An unknown
// word is HUB_USAGE. An id nothing holds resolves to null with `words: false`; otherwise it is read as a word (and refused).
export function resolve(target, { fleet, env = process.env, words = true, ids = true, processStart } = {}) {
  if (ids && typeof target === 'string' && target) {
    if (isEmulatorLease(env, target)) return { kind: EMULATOR, by: 'id', id: target };
    const owner = phoneOwning(fleet, env, target);
    if (owner) return { kind: 'phone', by: 'owner', id: target, entry: owner };
    const waiter = phoneWaiting(fleet, env, target, processStart);
    if (waiter) return { kind: 'phone', by: 'waiter', id: target, entry: waiter };
  }
  if (!words) return null;
  if (target === EMULATOR) return { kind: EMULATOR, by: 'word' };
  if (target === PHONE) return { kind: 'pool', by: 'word', pool: PHONE, members: phoneMembers(fleet, env) };
  refuseRetired(target, { env });
  // A Resource id first, then the device word (a name is never reused, so the two cannot name different phones).
  const entry = fleet.find(phone => resourceOf(phone.lock) === target) ?? fleet.find(phone => phone.device === target);
  if (!entry) throw usage(`unknown device "${target ?? ''}" (known: ${[...fleet.map(phone => phone.device), PHONE, EMULATOR].join(', ')})`);
  return { kind: 'phone', by: 'word', entry };
}

// The device words `take` would try for `phone` right now, in order: the `phone` Pool after the retired and seed-missing narrowing, as
// the names a caller types; `[]` when none is left. Read only (the Registry file, else the seed), never the QA file, no warning. It is
// what `mise run hosts:smoke` checks a registered phone against (the Pool `phone` holds it, and a retired one is gone from it).
export function phoneWordMembers({ env = process.env } = {}) {
  try {
    const target = withoutRetired(resolve(PHONE, { fleet: loadFleet(env), env, ids: false }), env);
    return target.members.map(phone => phone.device);
  } catch (error) {
    if (error?.code === 'HUB_RESOURCE_RETIRED') return [];
    throw error;
  }
}

// ---- bounds ----

// A lease id names one lease: with more than one phone lock, the same --id could otherwise name two live leases
// (or a waiter and a lease), and `release <id>` would free only the first it meets. A ticket whose process is dead (`stale`) names nothing: the
// take that follows prunes it, and a waiter whose service crashed (Story 8.6) must be able to place the same id again.
export function checkLeaseId(id, { fleet, env = process.env, processStart }) {
  if (id === undefined || id === null) return;
  const onPhone = fleet.find(phone => {
    const owner = readOwnerOf(phone.lock, env);
    return (isLease(owner) && owner.lease_id === id) || queueView(phone.lock, { env, includeStale: true, ...(processStart ? { processStart } : {}) }).some(waiter => waiter.lease_id === id && waiter.stale !== true);
  });
  if (onPhone) throw usage(`--id ${id} already names a lease or a waiter on ${onPhone.device}; a lease id names one lease`);
  if (isEmulatorLease(env, id)) throw usage(`--id ${id} already names an emulator lease; a lease id names one lease`);
}

// The deploy phone's lock is a deploy target, whose Leases are capped by policy (AD-16).
const overCap = (phone, forMs, policy) => phone.deploy && forMs > (deployTargetCapMs(phone.lock, { policy }) ?? Infinity);
export const usableFleet = (fleet, forMs, policy = null) => fleet.filter(phone => !overCap(phone, forMs, policy));

// --for must be more than 0 and at most 48 h; a deploy phone's cap is a usage error that names the cap. `phone` (whichever is free)
// skips the deploy phone when --for is over the cap, and is refused when that leaves none. Returns the resolved target with
// the Pool narrowed to the phones that can take it. `flag` is what the caller calls the duration in its messages (`--for`, or
// `for_ms` in a request body).
export function checkBounds(resolved, { forMs, forText = forMs, fleet = resolved.members ?? [], policy = null, flag = '--for' }) {
  if (!Number.isFinite(forMs) || forMs <= 0 || forMs > MAX_LEASE_MS) throw usage(`${flag} must be more than 0 and at most ${MAX_LEASE_MS / 3_600_000}h`);
  if (resolved.kind === 'phone' && overCap(resolved.entry, forMs, policy)) throw usage(`${flag} ${forText}: ${capText(resolved.entry.lock, deployTargetCapMs(resolved.entry.lock, { policy }))}`);
  if (resolved.kind !== 'pool') return resolved;
  const members = usableFleet(fleet, forMs, policy);
  if (members.length === 0) throw usage(`${flag} ${forText}: no phone can take it; ${capText('adb', deployTargetCapMs('adb', { policy }))}`);
  return { ...resolved, members };
}

// --pid names the live process that holds the lease.
export function checkPid(value) {
  if (value === undefined || value === null) return null;
  const pid = Number(value);
  if (!Number.isSafeInteger(pid) || pid < 1) throw usage('--pid takes a live process id (a positive integer)');
  return pid;
}

// The emulator Pool's size on this host, one function for every front door: `HUB_EMULATOR_POOL` (the CLI only: a `service` never reads
// it), else `<lock dir>/emulator-pool`, else the Registry file's `pools.emulator.size`, else 2, each 1 to 8 (emulator.mjs `hostPool`).
// The Registry is read as the file only (a missing or unreadable one has no size); slots stay derived locks, never Registry records.
export function emulatorPool(env = process.env, { service = false } = {}) {
  const size = readRegistryFile(env)?.pools?.emulator?.size;
  return hostPool(env, { useEnv: !service, registrySize: size });
}

// --profile and --pool belong to the emulator. The pool's size is the host's (emulatorPool); --pool may only ask for fewer. A `service`
// (Story 7.4) never reads the CLI's environment variable for the size.
export function emulatorBounds({ noConnect = false, profile: asked, pool: askedPool, service = false } = {}, env = process.env) {
  if (noConnect) throw usage('--no-connect is for a phone; an emulator is always made and connected');
  const profile = asked ?? 'default';
  if (!PROFILES[profile]) throw usage(`unknown emulator profile "${profile}" (known: ${Object.keys(PROFILES).join(', ')})`);
  const host = emulatorPool(env, { service });
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

// A phone registered with a model alone cannot be found on adb: refused before any lock is taken or queued for, unless the lease is
// --no-connect (the lock only).
const noSerialAway = phone => Object.assign(failure('HUB_PHONE_AWAY', `${phone?.device ?? 'a phone'} has no serial registered, so adb cannot find it (lease it --no-connect)`), { reason: 'no serial registered (lease it --no-connect)' });

// Takes the lease on one phone, then (unless noConnect) connects it. A phone that does not come gives the lease back;
// a lease released or reclaimed while the phone was being found ends as HUB_LEASE_CANCELLED holding nothing.
async function takePhone(phone, options, ctx) {
  const { env, log, timing } = ctx;
  if (!phone.serial && !options.noConnect) throw noSerialAway(phone);
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
    // AD-5's wording for each held member (`host lock <lock> is held by ...`), the one every timeout of a Queued lock uses.
    const locks = listLocks({ env: ctx.env, ...readerOf(ctx) });
    const by = held.map(phone => heldText(phone.lock, locks.find(entry => entry.name === phone.lock)?.owner ?? null)).join('; ');
    return failure('HUB_LOCK_TIMEOUT', `${by} (every phone is held); gave up after ${Math.round(waitMs / 1000)}s`);
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
async function takeAnyPhone(members, options, ctx, poolName = PHONE) {
  const { env, timing } = ctx;
  // A member with no serial can never be connected: it is dropped before any lock is taken, and none left is AWAY.
  const fleet = options.noConnect ? members : members.filter(phone => phone.serial);
  if (fleet.length === 0) throw noSerialAway(members[0]);
  const sliceMs = Number(env.HUB_DEVICE_PHONE_SLICE_MS) || 10_000;
  const deadline = timing.now() + options.waitMs;
  const taken = await acquirePool(poolName, fleet.map(phone => phone.lock), {
    holder: options.holder, why: options.why, forMs: options.forMs, waitMs: options.waitMs, id: options.id ?? null, holderPid: options.holderPid ?? null,
    claimantKind: options.claimantKind, actor: options.actor, processStart: options.processStart,
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

// An error out of the worker, as a service answers it: an abort keeps the signal's reason, an error the HTTP table knows (a full pool,
// a released request) keeps its code, and anything else is HUB_EMULATOR_FAILED with the worker's message.
const emulatorFailure = (error, signal) => {
  if (signal?.aborted && error === signal.reason) return error;
  if (httpAnswerOf(error) !== null || Number.isInteger(error?.status)) return error;
  return Object.assign(failure('HUB_EMULATOR_FAILED', String(error?.message ?? error)), { cause: error });
};

// An emulator take. `options.offThread` (a service: AD-44) runs the reap and the boot in a worker thread (`emulator-thread.mjs`; the main
// thread never calls `provision` or `reap`), the slot tied to the service's pid while it boots and to nobody once it is ready; the CLI
// runs them in its own process, as it always did. `ctx.provisionOffThread(args, {env, log, signal})` replaces the worker (a test seam).
async function takeEmulator(options, ctx) {
  const { env, timing } = ctx;
  const id = options.id ?? newLeaseId('emulator');
  if (options.offThread) {
    const args = {
      id, holder: options.holder, why: options.why, forMs: options.forMs, waitMs: options.waitMs, holderPid: options.holderPid ?? null, profileName: options.profile, pool: options.pool,
      claimantKind: options.claimantKind ?? 'agent', actor: options.actor ?? null, pollMs: timing.leasePollMs, ...ctx.emulator,
    };
    const run = ctx.provisionOffThread ?? ((given, seams) => offThread('provision', given, seams));
    try {
      const { lease, record } = await run(args, { env, log: ctx.log, signal: options.signal });
      return { kind: EMULATOR, id, lease, record };
    } catch (error) {
      throw emulatorFailure(error, options.signal);
    }
  }
  await reapBeforeAcquire(ctx);
  const { lease, record } = await provision({ id, holder: options.holder, why: options.why, forMs: options.forMs, waitMs: options.waitMs, holderPid: options.holderPid, profileName: options.profile, pool: options.pool, env, log: ctx.log, signal: options.signal, sleep: timing.sleep, now: timing.now, pollMs: timing.leasePollMs, ...ctx.emulator });
  return { kind: EMULATOR, id, lease, record };
}

// The members of a `--match` Pool that are not definitively away, read over the same read-only wire query status uses (nothing is
// started or connected). A member reading absent, offline or unauthorized is dropped; every one dropped is HUB_DEVICE_AWAY (75) naming
// each, before any event is written. `unknown` (no adb server, a wedged one, no host key, a host that is not `linux`) drops nothing, so
// the ordered try decides as it always has. `--no-connect` skips it: that lease is the lock only, phone away or not. A service
// (Story 7.1) has no adb on its request path (AD-44): it passes `statesOf(members)`, its own cache's states (a Map of device to state,
// a missing one `unknown`), and the same filter runs over them with nothing read.
async function reachableMembers(members, ctx, statesOf = null) {
  let states;
  if (statesOf) {
    const known = await statesOf(members);
    states = new Map(members.map(phone => [phone.device, known?.get?.(phone.device) ?? REACHABILITY.unknown]));
  } else {
    let key = null;
    try { key = (ctx.hostKey ?? hostKey)({ env: ctx.env }); } catch (error) { if (error?.code !== 'HUB_HOST_UNKNOWN') throw error; }
    if (key !== 'linux') return members;
    const found = (ctx.inventory ?? realInventory)({ lockRoot: lockDir(ctx.env), hubAdbPort: Number(ctx.env.HUB_ADB_SERVER_PORT) || 5037 });
    const { observed } = await phoneObservations(members, ctx, found);
    states = new Map(members.map(phone => [phone.device, phoneReachability(observed.get(phone.device) ?? null)]));
  }
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
// options: holder, why, forMs, waitMs, id, holderPid, noConnect, phoneWaitMs, signal (and profile, pool for an emulator), claimantKind
// (`agent`, or `person`), actor ({holder, via}, recorded on the take's events; an emulator's go on its Pool request and acquires too),
// `service` and `offThread` (a service's emulator take: the Pool size ignores $HUB_EMULATOR_POOL, and the boot runs in a worker) and readingsOf (a `--match` Pool's away filter over a
// service's cached states, run even for a noConnect take; see reachableMembers) and flag (what the duration is called in a bounds
// message: `--for` by default).
export async function take(resolved, options, ctx) {
  if (!resolved || typeof resolved !== 'object') throw usage('take needs a resolved target (resolve a device word first)');
  checkLeaseId(options.id, { fleet: ctx.fleet, env: ctx.env, ...readerOf(ctx) });
  const bounded = checkBounds(resolved, { forMs: options.forMs, fleet: resolved.members, policy: ctx.policy, ...(options.flag ? { flag: options.flag } : {}) });
  if (!options.why) throw usage('--why <text> is required');
  if (!Number.isFinite(options.waitMs) || options.waitMs < 0) throw usage('--wait must be a duration of 0 or more');
  checkPid(options.holderPid);
  const target = withoutRetired(bounded, ctx.env);
  switch (target.kind) {
    case 'phone': return takePhone(target.entry, options, ctx);
    case 'pool': return takeAnyPhone(target.by === 'match' && (!options.noConnect || options.readingsOf) ? await reachableMembers(target.members, ctx, options.readingsOf ?? null) : target.members, options, ctx, target.pool ?? PHONE);
    case EMULATOR: return takeEmulator({ ...options, ...emulatorBounds({ ...options, service: options.service === true }, ctx.env) }, ctx);
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

// ---- take a Lease through a service (Story 7.1) ----

// The environment a service takes a Lease with: no `GITHUB_*` key. A Lease records the identity of the run that takes it (repo, run,
// attempt, job) from its environment, and a service belongs to no run; whatever deploy identity leaked into its environment is dropped.
export const withoutDeployIdentity = env => Object.fromEntries(Object.entries(env ?? {}).filter(([key]) => !key.startsWith('GITHUB_')));

const LEASE_BODY_KEYS = Object.freeze(['resource', 'match', 'for_ms', 'wait_ms', 'holder', 'why', 'claimant_kind', 'id', 'actor']);
const bodyUsage = (reason, message) => Object.assign(usage(message), { reason });
const isText = value => typeof value === 'string' && value.trim() !== '';

// Checks the body of a service's take into `{resource, match, forMs, waitMs, holder, why, claimantKind, id, actor}` (`resource`, `match`,
// `id` and `actor` null when absent, `waitMs` 0; `actor` as `checkActor` writes it, the caller defaults it). HUB_USAGE with a `reason`,
// checked in this order and before anything is read: bad-body (not an object, or a key outside the list), bad-target (exactly one of
// `resource` and `match`, a non-empty string), bad-for (`for_ms` a whole number of ms, more than 0), bad-wait (`wait_ms` a whole number
// of ms, 0 or more), bad-claimant-kind, bad-id (a lease id: lowercase letters, digits and dashes), no-id (a wait names its id: the client
// mints it, so a lost answer can be asked for again, AD-37), bad-actor, no-holder, bad-why. The caps (48 h, and 60 min on a deploy
// target) are `take`'s own.
export function checkLeaseBody(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) throw bodyUsage('bad-body', 'the body must be a JSON object');
  for (const key of Object.keys(body)) if (!LEASE_BODY_KEYS.includes(key)) throw bodyUsage('bad-body', `the body has no key "${key}" (${LEASE_BODY_KEYS.join(', ')})`);
  const hasResource = body.resource !== undefined;
  const hasMatch = body.match !== undefined;
  if (hasResource === hasMatch) throw bodyUsage('bad-target', 'name exactly one of resource (a device word or Resource id) and match (a Capability query)');
  if (!isText(hasResource ? body.resource : body.match)) throw bodyUsage('bad-target', `${hasResource ? 'resource' : 'match'} must be a non-empty string`);
  if (!Number.isSafeInteger(body.for_ms) || body.for_ms <= 0) throw bodyUsage('bad-for', 'for_ms must be a whole number of milliseconds, more than 0');
  if (body.wait_ms !== undefined && (!Number.isSafeInteger(body.wait_ms) || body.wait_ms < 0)) throw bodyUsage('bad-wait', 'wait_ms must be a whole number of milliseconds, 0 or more');
  const claimantKind = body.claimant_kind ?? 'agent';
  if (!CLAIMANT_KINDS.includes(claimantKind)) throw bodyUsage('bad-claimant-kind', `claimant_kind is one of ${CLAIMANT_KINDS.join(', ')}`);
  if (body.id !== undefined && (typeof body.id !== 'string' || !LEASE_ID.test(body.id))) throw bodyUsage('bad-id', 'id must be a lease id (lowercase letters, digits and dashes, at most 64)');
  if (body.wait_ms > 0 && body.id === undefined) throw bodyUsage('no-id', 'a wait names its id: mint one (lowercase letters, digits and dashes) so the request can be asked for again');
  let actor = null;
  if (body.actor !== undefined) {
    try { actor = checkActor(body.actor); } catch (error) { throw bodyUsage('bad-actor', error.message); }
    if (actor === null) throw bodyUsage('bad-actor', 'actor must be {holder, via}');
  }
  if (!isText(body.holder)) throw bodyUsage('no-holder', 'say who holds the lease: a holder');
  if (!isText(body.why)) throw bodyUsage('bad-why', 'why is required: say what the lease is for');
  return { resource: hasResource ? body.resource : null, match: hasMatch ? body.match : null, forMs: body.for_ms, waitMs: body.wait_ms ?? 0, holder: body.holder, why: body.why, claimantKind, id: body.id ?? null, actor };
}

// A taken Lease as a service answers it: the Lease, the Resource and device it is on, and what the Claimant exports to use it (the CLI's
// `lease --json` env). One view for every service route that answers with a Lease. A phone's carries `emulator: null`; an emulator's
// (Story 7.4: `taken` is `{kind: 'emulator', lease, record, slot?}`) is the slot it holds, `device: 'emulator'`, the emulator's own
// exports (`HUB_LEASE_ID`, `ANDROID_ADB_SERVER_PORT`, `ANDROID_SERIAL`) and `emulator: {slot, serial, profile, console_port, adb_server_port}`.
export function leaseView(taken) {
  if (taken.kind === EMULATOR) return emulatorLeaseView(taken);
  const { lease, phone } = taken;
  return {
    lease_id: lease.lease_id, resource: resourceOf(phone.lock), lock: phone.lock, device: phone.device, holder: lease.holder, why: lease.why,
    claimant_kind: lease.claimant_kind ?? 'agent', started_at: lease.started_at, expires_at: lease.expires_at, env: leaseExports(taken), emulator: null,
  };
}

// The `Lease` of a held emulator: the owner record of its slot and the emulator's record (the slot's owner carries the same facts as a
// summary when the record is gone).
function emulatorLeaseView({ lease, record = null, slot = null }) {
  const info = record ?? lease.emulator ?? {};
  const lock = record?.slot ?? slot;
  return {
    lease_id: lease.lease_id, resource: resourceOf(lock), lock, device: EMULATOR, holder: lease.holder, why: lease.why,
    claimant_kind: lease.claimant_kind ?? 'agent', started_at: lease.started_at, expires_at: lease.expires_at,
    env: emulatorExports({ lease_id: lease.lease_id, adb_server_port: info.adb_server_port, serial: info.serial }),
    emulator: { slot: lock, serial: info.serial ?? null, profile: info.profile ?? null, console_port: info.console_port ?? null, adb_server_port: info.adb_server_port ?? null },
  };
}

// The emulator Lease a held id names, for a service, as a `taken`, or null: the slot that holds a Lease by this id, with its record. A
// slot a service is still booting (its owner is tied to this very process until the emulator is ready) holds no usable emulator yet: null,
// and so does an orphan the reaper would tear down (`doomed`: a service that died mid-boot left it tied to its dead pid). An expired one
// is still the Lease it was, as a phone's is: GET answers it and an extend refuses it as `expired`.
function heldEmulator(id, env) {
  if (typeof id !== 'string' || !LEASE_ID.test(id)) return null;
  const record = readRecord(env, id);
  const slot = record?.slot ?? slotHolding(env, id);
  if (!slot) return null;
  const lease = readOwnerOf(slot, env);
  if (!isLease(lease) || lease.lease_id !== id || lease.holder_pid === process.pid) return null;
  const why = record ? doomed(record, lease) : null;
  if (why !== null && why !== 'expired') return null;
  return { kind: EMULATOR, id, slot, lease, record };
}

// The Lease a held id names, for a service: the phone whose lock holds a Lease by this id, else the emulator slot that does, as a `taken`
// (`leaseView`'s input), or null. The device is the one the record carries (a Lease taken with a connect has an adb id), else the
// lock-only shape a `--no-connect` Lease has. Read only. `ctx`: env, fleet (loaded when absent), warn.
export function heldLease(id, ctx) {
  const env = ctx.env ?? process.env;
  const fleet = ctx.fleet ?? loadFleet(env, { warn: ctx.warn });
  const phone = typeof id === 'string' && id !== '' ? phoneOwning(fleet, env, id) : null;
  if (!phone) return heldEmulator(id, env);
  const lease = readOwnerOf(phone.lock, env);
  if (!isLease(lease) || lease.lease_id !== id) return null;
  return { kind: 'phone', phone, lease, device: leaseDevice(lease, phone, env) };
}

// The device a held Lease is on: the one its record carries (a Lease taken with a connect has an adb id), else the lock-only shape.
const leaseDevice = (lease, phone, env) => lease.device ?? { phone: phone.device, serial: null, adb_id: null, adb_port: Number(String(env.HUB_ADB_SERVER_PORT || '5037')) };

// `GET /leases/{id}`: the Lease an id names, as `leaseView`. A Lease that is still waiting for its lock (or its emulator still booting)
// is 404 `waiting` and an id nothing knows is 404 `unknown`: both HUB_LEASE_NOT_FOUND (exit 2), so a client that lost an answer can tell
// "not yet" from "never".
export function findLease(id, ctx) {
  const env = ctx.env ?? process.env;
  const fleet = ctx.fleet ?? loadFleet(env, { warn: ctx.warn });
  const held = heldLease(id, { ...ctx, env, fleet });
  if (held) return leaseView(held);
  throw leaseNotFound(id, fleet, env, ctx.processStart);
}

// The refusal for an id that holds nothing: HUB_LEASE_NOT_FOUND, `reason: waiting` when a waiter has it (it holds nothing yet; an emulator
// request counts from its first place in line until it is ready), else `unknown`.
function leaseNotFound(id, fleet, env, processStart) {
  const waiting = typeof id === 'string' && id !== '' ? phoneWaiting(fleet, env, id, processStart) : null;
  if (waiting) return Object.assign(failure('HUB_LEASE_NOT_FOUND', `lease ${id} is waiting for ${waiting.device}; it holds nothing yet`), { reason: 'waiting' });
  if (isEmulatorLease(env, id)) return Object.assign(failure('HUB_LEASE_NOT_FOUND', `lease ${id} is waiting for ${EMULATOR}; it holds nothing yet`), { reason: 'waiting' });
  return Object.assign(failure('HUB_LEASE_NOT_FOUND', `no lease or waiter has the id "${id}"`), { reason: 'unknown' });
}

// The id a service echoes in `X-Request-Id` for a lease request: the Lease it answered with, else the body's `id` when that is a valid
// lease id (so a header is never written with arbitrary text), else null.
export const leaseRequestId = (body, view) => {
  if (typeof view?.lease_id === 'string') return view.lease_id;
  return typeof body?.id === 'string' && LEASE_ID.test(body.id) ? body.id : null;
};

// The Lease a service takes (`POST /leases`, and the Host Agent's): exactly `hub-device lease <word> --no-connect`: the lock only, no
// `findPhone`, no adb on the request path, `holderPid` null (the Lease lives until `expires_at` or its release; it is never reclaimed
// for a dead process), and an environment with no `GITHUB_*` key. `input` is `checkLeaseBody`'s result (its actor already defaulted by
// the caller). A `resource` is a word or a Resource id (a lease id is never a target); a `match` Pool drops the members `ctx.readingsOf`
// (a function of the members, returning Map(device -> state)) already knows are away.
//
// An emulator (Story 7.4: the word `emulator`, or a `match` with a `profile=` clause or that only the emulator Pool satisfies) is the
// same Claims path as `hub-device lease emulator`: `take` to `provision({holderPid: null})`, run off the main thread (AD-44) in a worker
// (`emulator-thread.mjs`), the Lease answered once the emulator is booted, with `emulator: {slot, serial, profile, console_port,
// adb_server_port}`. A profile that is unknown or whose image is not installed is HUB_NO_MATCH at once, before any ticket, lock or event.
//
// A wait (`input.waitMs` > 0, Story 7.2) is the same take with a place in line: `ctx.signal` ends it (the ticket leaves with a `cancel`,
// reason `aborted`; an emulator mid-boot is torn down) and `ctx.processStart` is the service's one cached process-start reader (AD-44). A
// Hold granted to a request whose signal had already aborted is given back at once (a `release`, reason `undelivered`: nobody received
// it; an emulator is torn down in a worker) and the signal's reason is thrown. An id this holder already holds answers its existing
// Lease: no second take, no event (a client asking again after a lost answer). Returns `leaseView`. Throws what `resolve`,
// `matchTarget` and `take` throw (the HTTP table gives them their status).
export async function serviceLease(input, ctx) {
  const env = withoutDeployIdentity(ctx.env ?? process.env);
  const fleet = ctx.fleet ?? loadFleet(env, { warn: ctx.warn });
  const base = createContext({ env, log: ctx.log, warn: ctx.warn, policy: ctx.policy, now: ctx.timing?.now ?? ctx.now, sleep: ctx.timing?.sleep ?? ctx.sleep, fleet, qaDevices: ctx.qaDevices, registry: ctx.registry });
  const local = { ...ctx, env, fleet, log: base.log, warn: base.warn, timing: ctx.timing ?? base.timing, emulator: ctx.emulator ?? base.emulator };
  if (input.id) {
    const held = heldLease(input.id, local);
    if (held && held.lease.holder === input.holder) return leaseView(held);
  }
  const resolved = input.match !== null ? matchTarget(input.match, { forMs: input.forMs, emulators: true }, local) : resolve(input.resource, { fleet, env, ids: false });
  const signal = ctx.signal ?? null;
  if (resolved.kind === EMULATOR) return serviceEmulator(input, resolved, local, signal);
  const taken = await take(resolved, {
    holder: input.holder, why: input.why, forMs: input.forMs, waitMs: input.waitMs ?? 0, id: input.id, holderPid: null, noConnect: true,
    claimantKind: input.claimantKind, actor: input.actor, readingsOf: ctx.readingsOf, flag: 'for_ms',
    ...(signal ? { signal } : {}), ...(ctx.processStart ? { processStart: ctx.processStart } : {}),
  }, local);
  if (signal?.aborted) {
    releaseLease(taken.phone.lock, taken.lease.lease_id, { env, now: local.timing.now, reason: 'undelivered' });
    throw signal.reason;
  }
  return leaseView(taken);
}

// The profile's image must be there before anything is queued: an unknown profile or a missing image is HUB_NO_MATCH (404, exit 2) naming it.
function checkProfile(profile, env) {
  try { resolveImage(profile, { env }); } catch (error) {
    if (error?.code !== 'HUB_EMULATOR_USAGE' && error?.code !== 'HUB_EMULATOR_NO_IMAGE') throw error;
    const reason = `emulator ${error.message}`;
    throw Object.assign(failure('HUB_NO_MATCH', `no Resource matches: ${reason}`), { reason, excluded: [{ id: EMULATOR, why: error.message }] });
  }
}

// An emulator Lease through a service (the emulator half of `serviceLease`).
async function serviceEmulator(input, resolved, local, signal) {
  const { env } = local;
  const profile = resolved.profile ?? 'default';
  checkProfile(profile, env);
  const taken = await take(resolved, {
    holder: input.holder, why: input.why, forMs: input.forMs, waitMs: input.waitMs ?? 0, id: input.id, holderPid: null,
    claimantKind: input.claimantKind, actor: input.actor, flag: 'for_ms', profile, service: true, offThread: true,
    ...(signal ? { signal } : {}),
  }, local);
  if (signal?.aborted) {
    // Nobody received it: given back at once, its processes and files torn down in a worker too.
    const give = local.releaseOffThread ?? ((given, seams) => offThread('release', given, seams));
    // Its outcome goes to the service log: a teardown that fails or would not finish leaves the record for the next reap.
    const say = line => { try { local.log?.(line); } catch { /* a broken log seam never changes the outcome */ } };
    try {
      const given = await give({ id: taken.id, reason: 'undelivered', graceMs: local.emulator.graceMs }, { env, log: local.log });
      if (given?.outcome === 'stuck') say(`HUB_EMULATOR_UNDELIVERED_STUCK ${taken.id}: pids ${(given.result?.survivors ?? []).join(',')} would not stop; the next reap tries again`);
    } catch (error) { say(`HUB_EMULATOR_UNDELIVERED_FAILED ${taken.id}: ${error.message}`); }
    throw signal.reason;
  }
  return leaseView({ ...taken, slot: taken.record?.slot ?? null });
}

// ---- waits bound to the connection (Story 7.2; AD-37, AD-48) ----

export const restartingError = () => Object.assign(failure('HUB_API_RESTARTING', 'the service is stopping; ask again when it is back'), { retry: 'requeue' });
const supersededError = id => failure('HUB_LEASE_SUPERSEDED', `the wait for lease ${id} was taken over by a newer request with the same id`);
const disconnectedError = id => Object.assign(failure('HUB_LEASE_CANCELLED', `the connection that asked for lease ${id} closed`), { reason: 'disconnected' });

// The registry of a service's lease requests (`POST /leases`; the Host Agent's too): the one place that binds a wait to the HTTP
// connection that asked for it. The service builds one (`createLeaseWaits`) and every request calls `waits.lease(input, ctx, {signal})`
// with the connection's own abort signal; the rules are these and nothing in a route repeats them:
//   - The client mints the `id`. A disconnect (the current request's signal aborts) aborts the wait: the ticket leaves with a `cancel`
//     (`aborted`) and the answer is dropped. A Hold granted after that is released at once (`serviceLease`).
//   - A request with the id and holder of a wait that is still open takes it over: the wait goes on with its original resource, `for_ms`
//     and deadline (its place in line, no event), the new connection gets its outcome, and the old one gets HUB_LEASE_SUPERSEDED. Another
//     holder's repeat is refused as a taken id.
//   - A repeat of an id already held by the same holder answers the Lease (`serviceLease`).
//   - `shutdown()` ends every open wait with HUB_API_RESTARTING (`retry: 'requeue'`) and refuses every later request the same way. So
//     does it every request that is still being served with no wait (Story 7.4: an emulator boots for minutes, and a stop must not
//     leave one booting): each is aborted, and what it had made is torn down before `shutdown()` resolves.
// One cached process-start reader (AD-44) is shared by every wait of the registry. `now` and `startOf` are test seams.
export function createLeaseWaits({ now = Date.now, startOf } = {}) {
  const processStart = cachedProcessStart({ now: () => now(), ...(startOf ? { startOf } : {}) });
  const open = new Map();
  const serving = new Set();   // the requests being served with no wait: {controller, work}
  let closed = false;

  // The new request becomes the one that receives the wait's outcome; the one before it is superseded.
  const attach = (entry, signal) => new Promise((resolve, reject) => {
    const subscriber = { resolve, reject };
    const onAbort = () => { if (entry.subscriber === subscriber) entry.controller.abort(disconnectedError(entry.id)); };
    subscriber.detach = () => signal?.removeEventListener?.('abort', onAbort);
    const previous = entry.subscriber;
    entry.subscriber = subscriber;
    if (previous) { previous.detach(); previous.reject(supersededError(entry.id)); }
    if (signal?.aborted) onAbort();
    else signal?.addEventListener?.('abort', onAbort, { once: true });
  });

  const finish = (entry, method, value) => {
    if (open.get(entry.id) === entry) open.delete(entry.id);
    const { subscriber } = entry;
    subscriber?.detach();
    subscriber?.[method](value);
  };

  const registry = {
    get size() { return open.size; },
    async lease(input, ctx, { signal } = {}) {
      if (closed) throw restartingError();
      const entry = input.id ? open.get(input.id) : undefined;
      if (entry && entry.holder === input.holder) {
        // A wait whose connection just closed is still unwinding: its ticket is gone in a moment, and this request is a fresh one.
        if (entry.controller.signal.aborted) { await entry.work; return registry.lease(input, ctx, { signal }); }
        return attach(entry, signal);
      }
      // Another holder's open wait names this id: refused as any taken id (never registered over it).
      if (entry) throw usage(`id ${input.id} already names a lease or a waiter; a lease id names one lease`);
      const served = { ...ctx, processStart: ctx.processStart ?? processStart };
      if (!(input.waitMs > 0)) {
        // Its own controller, so a stop can end it: it follows the connection's signal, and `shutdown()` aborts it with its own reason.
        const controller = new AbortController();
        const follow = () => controller.abort(signal.reason);
        if (signal?.aborted) follow(); else signal?.addEventListener?.('abort', follow, { once: true });
        const one = { controller, work: null };
        serving.add(one);
        one.work = serviceLease(input, { ...served, signal: controller.signal }).finally(() => { signal?.removeEventListener?.('abort', follow); serving.delete(one); });
        return one.work;
      }
      const created = { id: input.id, holder: input.holder, controller: new AbortController(), subscriber: null, work: null };
      open.set(input.id, created);
      const outcome = attach(created, signal);
      created.work = serviceLease(input, { ...served, signal: created.controller.signal })
        .then(view => finish(created, 'resolve', view), error => finish(created, 'reject', error));
      return outcome;
    },
    // Ends every open wait with HUB_API_RESTARTING and refuses what comes after. Resolves when every wait has unwound (its ticket
    // withdrawn, its answer handed to its connection).
    async shutdown() {
      closed = true;
      const entries = [...open.values()];
      const requests = [...serving];
      for (const entry of entries) entry.controller.abort(restartingError());
      for (const request of requests) request.controller.abort(restartingError());
      await Promise.all([...entries.map(entry => entry.work), ...requests.map(request => request.work.catch(() => {}))]);
    },
  };
  return registry;
}

// ---- release ----

// A deploy job's ticket id: `job:<repo>#<run>.<attempt>/<job>`.
const JOB_ID = /^job:([^#]+)#([^.]+)\.[^/]+\/(.+)$/;

// A deploy job's ticket id is its place in line, not a lease: nothing here can release it, so say which run to cancel.
// Returns null for any other id; otherwise {code, id, message} (the code exits through the table; a front door prints the
// `HUB_DEVICE_JOB_ID` marker before the message).
export function jobTicket(id) {
  if (typeof id !== 'string' || !id.startsWith('job:')) return null;
  const [, repo, run] = JOB_ID.exec(id) ?? [];
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
export function releasePhone(id, ctx, actor = null) {
  const { env, fleet } = ctx;
  const owning = phoneOwning(fleet, env, id);
  const waiting = fleet.filter(phone => queueView(phone.lock, { env, includeStale: true, ...readerOf(ctx) }).some(waiter => waiter.lease_id === id));
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
  for (const phone of waiting) if (phone !== found) releaseLease(phone.lock, id, { env, actor });
  const result = releaseLease(found.lock, id, { env, actor });
  const base = { kind: 'phone', device: found.device, lock: found.lock, id, notes: [] };
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
export function releaseAny(ctx, actor = null) {
  const { env, fleet } = ctx;
  let refusal = null;
  for (const phone of fleet) {
    const result = releaseLease(phone.lock, null, { env, actor });
    switch (result.reason) {
      case 'released': return { kind: 'phone', outcome: 'released', device: phone.device, lock: phone.lock, leaseId: result.owner.lease_id, notes: [] };
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
// and so is a target that names nothing (HUB_USAGE). `target.actor` ({holder, via}, optional) is recorded on a phone's `release` and
// `cancel` events (Story 7.3).
export async function release(target, ctx) {
  const actor = checkActor(target?.actor);
  if (target?.any) return releaseAny(ctx, actor);
  if (target?.emulator !== undefined) return { kind: EMULATOR, id: target.emulator, ...await releaseEmulator(target.emulator, ctx) };
  const job = jobTicket(target?.id);
  if (job) throw failure(job.code, job.message);
  if (!target?.id) throw usage('release needs a lease id, an emulator lease id, or any');
  if (isEmulatorLease(ctx.env, target.id)) return { kind: EMULATOR, id: target.id, ...await releaseEmulator(target.id, ctx) };
  return releasePhone(target.id, ctx, actor);
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
// past 48 h in total). Only a Lease that holds its lock extends: a waiter's id (HUB_LEASE_NOT_FOUND, `waiting`), an id nothing knows
// (`unknown`) and a deploy job's ticket id (HUB_DEVICE_JOB_ID, which names the run to cancel) hold nothing to extend. `actor` is who
// asked and `override: {actor, why}` skips the waiters check and nothing else (lock.mjs `extendLease`); both go on the `extend` event
// (Story 7.3). Returns `{lock, device, record}`: the lock the Lease holds, the word for it, and the new owner record.
export function extendHeld(id, { forMs, actor = null, override = null }, ctx) {
  const { env, fleet, policy = null, timing } = ctx;
  if (!(forMs > 0) || !Number.isFinite(forMs)) throw usage('an extension is for more than 0 ms');
  const job = jobTicket(id);
  if (job) throw failure(job.code, job.message);
  const lock = readRecord(env, id)?.slot ?? phoneOwning(fleet, env, id)?.lock;
  if (!lock) throw leaseNotFound(id, fleet, env, ctx.processStart);
  const record = extendLease(lock, id, { forMs, env, now: timing?.now, policy, actor, override, ...readerOf(ctx) });
  return { lock, device: nameOf(fleet, lock), record };
}

// The new owner record alone (the CLI's v1a shape).
export const extend = (id, options, ctx) => extendHeld(id, options, ctx).record;

const EXTEND_BODY_KEYS = Object.freeze(['for_ms', 'holder', 'actor', 'override']);
const OVERRIDE_KEYS = Object.freeze(['why', 'actor']);
const RELEASE_BODY_KEYS = Object.freeze(['holder', 'actor']);

// The `actor` of a body, as `checkActor` writes it (null when absent), with the same refusal as a lease body.
function bodyActor(body) {
  if (body.actor === undefined) return null;
  let actor = null;
  try { actor = checkActor(body.actor); } catch (error) { throw bodyUsage('bad-actor', error.message); }
  if (actor === null) throw bodyUsage('bad-actor', 'actor must be {holder, via}');
  return actor;
}

// Checks the body of a service's extend into `{forMs, holder, actor, override}` (`holder`, `actor` and `override` null when absent;
// `override` is `{why, actor}`, its `actor` null when absent: the caller defaults it to the request's). HUB_USAGE with a `reason`,
// before anything is read: bad-body (not an object, or a key outside `for_ms`, `holder`, `actor`, `override`), bad-for, bad-actor,
// bad-override (not `{why, actor?}`, an empty `why`, or a bad override actor), no-holder (neither an `actor` nor a `holder`).
export function checkExtendBody(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) throw bodyUsage('bad-body', 'the body must be a JSON object');
  for (const key of Object.keys(body)) if (!EXTEND_BODY_KEYS.includes(key)) throw bodyUsage('bad-body', `the body has no key "${key}" (${EXTEND_BODY_KEYS.join(', ')})`);
  if (!Number.isSafeInteger(body.for_ms) || body.for_ms <= 0) throw bodyUsage('bad-for', 'for_ms must be a whole number of milliseconds, more than 0');
  const actor = bodyActor(body);
  let override = null;
  if (body.override !== undefined) {
    const given = body.override;
    if (given === null || typeof given !== 'object' || Array.isArray(given)) throw bodyUsage('bad-override', 'override must be {why, actor?}');
    for (const key of Object.keys(given)) if (!OVERRIDE_KEYS.includes(key)) throw bodyUsage('bad-override', `override has no key "${key}" (${OVERRIDE_KEYS.join(', ')})`);
    if (!isText(given.why)) throw bodyUsage('bad-override', 'an override says why: a non-empty why');
    let by = null;
    if (given.actor !== undefined) {
      try { by = checkActor(given.actor); } catch (error) { throw bodyUsage('bad-override', `override ${error.message}`); }
      if (by === null) throw bodyUsage('bad-override', 'override actor must be {holder, via}');
    }
    override = { why: given.why, actor: by };
  }
  if (actor === null && !isText(body.holder)) throw bodyUsage('no-holder', 'say who is extending: an actor or a holder');
  return { forMs: body.for_ms, holder: body.holder ?? null, actor, override };
}

// Checks the body of a service's release into `{holder, actor}` (both null when absent). bad-body (not an object, or a key outside
// `holder`, `actor`), bad-actor, no-holder (neither an `actor` nor a `holder`).
export function checkReleaseBody(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) throw bodyUsage('bad-body', 'the body must be a JSON object');
  for (const key of Object.keys(body)) if (!RELEASE_BODY_KEYS.includes(key)) throw bodyUsage('bad-body', `the body has no key "${key}" (${RELEASE_BODY_KEYS.join(', ')})`);
  const actor = bodyActor(body);
  if (actor === null && !isText(body.holder)) throw bodyUsage('no-holder', 'say who is releasing: an actor or a holder');
  return { holder: body.holder ?? null, actor };
}

// The context a service action runs in: the environment without `GITHUB_*` (as a take), the fleet, the policy and the clocks.
function serviceLocal(ctx) {
  const env = withoutDeployIdentity(ctx.env ?? process.env);
  const fleet = ctx.fleet ?? loadFleet(env, { warn: ctx.warn });
  const base = createContext({ env, log: ctx.log, warn: ctx.warn, policy: ctx.policy, now: ctx.timing?.now ?? ctx.now, sleep: ctx.timing?.sleep ?? ctx.sleep, fleet, qaDevices: ctx.qaDevices, registry: ctx.registry });
  return { ...ctx, env, fleet, log: base.log, warn: base.warn, policy: base.policy, timing: ctx.timing ?? base.timing, emulator: ctx.emulator ?? base.emulator };
}

// What a service extend and release both do first: that context, and a deploy job's ticket id refused (HUB_DEVICE_JOB_ID, which names the
// run to cancel). An emulator lease id is served like a phone's (Story 7.4).
function serviceHold(id, ctx) {
  const local = serviceLocal(ctx);
  const job = jobTicket(id);
  if (job) throw failure(job.code, job.message);
  return local;
}

// `POST /leases/{id}/extend` (and the Host Agent's): exactly `hub-device extend <id> --for ...`. `input` is `checkExtendBody`'s result
// with the actor defaulted by the caller (`actor`; `override.actor` too, defaulting to it). Returns `leaseView` of the extended Lease (a
// phone's or an emulator's, Story 7.4).
// Throws what `extendHeld` throws (HUB_LEASE_EXTEND_REFUSED with its `reason`, HUB_LEASE_NOT_FOUND, HUB_DEVICE_JOB_ID, HUB_LEASE_LOST).
export function serviceExtend(id, input, ctx) {
  const local = serviceHold(id, ctx);
  // An emulator still booting holds nothing yet (GET says `waiting` too): its expiry is set when it is ready, so an extension now would be lost.
  if (isEmulatorLease(local.env, id) && phoneOwning(local.fleet, local.env, id) === null && heldEmulator(id, local.env) === null) throw leaseNotFound(id, local.fleet, local.env, local.processStart);
  const override = input.override ? { why: input.override.why, actor: input.override.actor ?? input.actor } : null;
  const { lock, record } = extendHeld(id, { forMs: input.forMs, actor: input.actor, override }, local);
  // Built from what the extension wrote: no second read, so a committed extension is never answered as lost.
  if (isEmulatorLock(lock)) return leaseView({ kind: EMULATOR, id, lease: record, record: readRecord(local.env, id), slot: lock });
  const phone = local.fleet.find(entry => entry.lock === lock);
  return leaseView({ kind: 'phone', phone, lease: record, device: leaseDevice(record, phone, local.env) });
}

// `POST /leases/{id}/release` (and the Host Agent's): exactly `hub-device release <id>`, with the actor on its events. Idempotent: an id
// that holds and waits for nothing is `none`. Returns `{lease_id, outcome, resource, lock, device}`, `outcome` `released` (the Lease was
// given back), `cancelled` (it was only a waiter) or `none`; the last three keys are null for `none`. A lock that is being taken or
// changed hands is HUB_LEASE_LOST (`being-taken`, `changed-hands`): left alone.
//
// An emulator lease id (Story 7.4) is released the way `hub-device release <id>` does, with the teardown (a `/proc` scan and the signals to
// its processes) run in a worker thread, not on this one: `released` (its slot freed, its processes and files gone), `cancelled` (it was
// still waiting its turn) or `none`. Processes that would not stop are HUB_EMULATOR_FAILED. `ctx.releaseOffThread(args, {env, log})` replaces
// the worker (a test seam).
export async function serviceRelease(id, input, ctx) {
  const local = serviceHold(id, ctx);
  if (!isEmulatorLease(local.env, id)) return releaseAnswer(id, await release({ id, actor: input.actor }, local));
  const give = local.releaseOffThread ?? ((given, seams) => offThread('release', given, seams));
  let result;
  try { result = await give({ id, graceMs: local.emulator.graceMs }, { env: local.env, log: local.log }); } catch (error) { throw emulatorFailure(error, null); }
  return releaseAnswer(id, { kind: EMULATOR, id, ...result });
}

// The `Release` a service answers with for what `release` found (a pure mapping, so each outcome is testable on its own).
export function releaseAnswer(id, result) {
  if (result.kind === EMULATOR) return emulatorReleaseAnswer(id, result);
  switch (result.outcome) {
    case 'released':
    case 'cancelled': return { lease_id: id, outcome: result.outcome, resource: resourceOf(result.lock), lock: result.lock, device: result.device };
    case 'unknown-holder': throw Object.assign(failure('HUB_LEASE_LOST', result.notes[0] ?? `lease ${id} is being taken`), { reason: 'being-taken' });
    case 'changed-hands': throw Object.assign(failure('HUB_LEASE_LOST', result.notes[0] ?? `lease ${id} changed hands`), { reason: 'changed-hands' });
    default: return { lease_id: id, outcome: 'none', resource: null, lock: null, device: null };
  }
}


// The `Release` for what releasing an emulator lease id did (`releaseEmulator`'s result): the slot it held (`released`), the gate it waited
// on (`cancelled`) or nothing (`none`). `stuck` (processes that would not stop: the slot stays out of the pool) is HUB_EMULATOR_FAILED.
function emulatorReleaseAnswer(id, result) {
  switch (result.outcome) {
    case 'released': { const lock = result.record?.slot ?? result.slot ?? GATE; return { lease_id: id, outcome: 'released', resource: resourceOf(lock), lock, device: EMULATOR }; }
    case 'cancelled': return { lease_id: id, outcome: 'cancelled', resource: resourceOf(GATE), lock: GATE, device: EMULATOR };
    case 'stuck': throw failure('HUB_EMULATOR_FAILED', `emulator ${id}: pids ${(result.result?.survivors ?? []).join(',')} would not stop; ${result.slot} stays out of the pool until they do`);
    default: return { lease_id: id, outcome: 'none', resource: null, lock: null, device: null };
  }
}

// ---- cancel a queued request (Story 7.5) ----

const CANCEL_BODY_KEYS = Object.freeze(['resource', 'pool', 'host', 'why', 'holder', 'actor']);

// Checks the body of a service's cancel into `{resource, pool, host, why, holder, actor}` (`pool`, `host`, `why`, `holder` and `actor` null
// when absent). HUB_USAGE with a `reason`, before anything is read: bad-body (not an object, or a key outside the list), no-resource and
// bad-resource (`resource` names the Resource the request waits on: a non-empty string), bad-pool, bad-host, bad-why (a non-empty string),
// bad-actor, no-holder (neither an `actor` nor a `holder`).
export function checkCancelBody(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) throw bodyUsage('bad-body', 'the body must be a JSON object');
  for (const key of Object.keys(body)) if (!CANCEL_BODY_KEYS.includes(key)) throw bodyUsage('bad-body', `the body has no key "${key}" (${CANCEL_BODY_KEYS.join(', ')})`);
  if (body.resource === undefined) throw bodyUsage('no-resource', 'name the Resource the request waits on: a resource (a device word or Resource id)');
  if (!isText(body.resource)) throw bodyUsage('bad-resource', 'resource must be a non-empty string');
  if (body.pool !== undefined && !isText(body.pool)) throw bodyUsage('bad-pool', 'pool must be a non-empty string (the Pool a Pool request was made on, `phone`)');
  const { host } = body;
  if (host !== undefined && !isText(host)) throw bodyUsage('bad-host', 'host must be a non-empty string (a host key)');
  if (body.why !== undefined && !isText(body.why)) throw bodyUsage('bad-why', 'why must be a non-empty string');
  const actor = bodyActor(body);
  if (actor === null && !isText(body.holder)) throw bodyUsage('no-holder', 'say who is cancelling: an actor or a holder');
  return { resource: body.resource, pool: body.pool ?? null, host: host ?? null, why: body.why ?? null, holder: body.holder ?? null, actor };
}

const requestNotFound = (reason, message) => Object.assign(failure('HUB_REQUEST_NOT_FOUND', message), { reason });

// The locks a request on `resource` can wait in, on this host: the emulator gate for `emulator`, every phone's for the `phone` Pool, the phone's
// lock for a device word or Resource id, else the lock of the Registry record the word names (a Resource id, name, lock or word). Never a search
// of the fleet by request id. An unknown word is HUB_REQUEST_NOT_FOUND (`unknown`).
export function requestLocks(resource, ctx) {
  const env = ctx.env ?? process.env;
  if (resource === EMULATOR) return [GATE];
  const fleet = ctx.fleet ?? loadFleet(env, { warn: ctx.warn });
  if (resource === PHONE) return fleet.map(phone => phone.lock);
  const phone = fleet.find(entry => entry.lock === resource || resourceOf(entry.lock) === resource || entry.device === resource);
  if (phone) return [phone.lock];
  const record = readRegistry({ env, qaDevices: () => [], warn: ctx.warn }).resources
    .find(entry => entry.id === resource || entry.name === resource || entry.lock === resource || (Array.isArray(entry.words) && entry.words.includes(resource)));
  if (record) return [record.lock];
  throw requestNotFound('unknown', `no Resource "${resource}" is known here, so no request of it can be cancelled`);
}

// Every lock on this host that has a queue, a lock or Reservations: where `hub-device cancel <id>` looks when it is not told the Resource (a CLI looks on its own host; a
// service never does).
const queuedLocks = env => {
  try { return [...new Set(readdirSync(lockDir(env)).filter(entry => /^[a-z0-9-]+\.(queue|lock|reservations)$/.test(entry)).map(entry => entry.replace(/\.(queue|lock|reservations)$/, '')))].sort(); } catch { return []; }
};

// One lock's waiters after the cancel, as a `Cancel` carries them (the tickets only: a Reservation is not a request). Read only.
function queueAnswer(lock, ctx) {
  const waiters = queueView(lock, { env: ctx.env, now: ctx.timing?.now, ...readerOf(ctx) })
    .filter(entry => entry.kind !== 'reservation')
    .map(entry => ({
      place: entry.place, lease_id: entry.lease_id ?? null, holder: entry.holder ?? null, why: entry.why ?? null, kind: entry.kind,
      enqueued_at: entry.enqueued_at ?? null, deadline_at: entry.deadline_at ?? null, pool: typeof entry.pool === 'string' ? entry.pool : null,
    }));
  return { lock, resource: resourceOf(lock), waiters };
}

// `POST /requests/{id}/cancel` (and `hub-device cancel <id>`): takes the waiting request `id` out of the line, in every member's
// queue for a Pool request, and touches no Hold. `input` is `checkCancelBody`'s result with the actor defaulted by the caller (a cancel always has
// an actor, recorded on the one ending event; the waiter's own wait ends HUB_LEASE_CANCELLED naming it). `input.resource` null (the CLI only) looks
// on this host for the request; a given one names the Resource it waits on, and `input.pool` the Pool of a Pool request (a Pool request cancelled
// without its `pool`, or with another, is not found). `input.host`, when given, must be this host's key.
//
// Answers `{request_id, outcome: 'cancelled', resource, pool, queues: [{lock, resource, waiters}]}` (`resource` the Pool word for a Pool request, else the lock's Resource): the resulting queue of every lock the request was
// taken out of. Throws HUB_DEVICE_JOB_ID (a job's id or ticket), HUB_CANCEL_RESERVATION, HUB_WRONG_HOST, HUB_HOST_UNKNOWN (this host's key is
// unreadable) and HUB_REQUEST_NOT_FOUND with `reason` `unknown` (nothing waits under the id, or it was granted or withdrew as the cancel ran) or
// `held` (it already holds its lock: release it), all before or instead of any write.
export function cancel(id, input, ctx) {
  const actor = checkActor(input?.actor);
  if (actor === null) throw usage('a cancel names its actor ({holder, via})');
  const local = serviceHold(id, ctx);
  const { host } = input;
  if (host !== null && host !== undefined) {
    const own = (local.hostKey ?? hostKey)({ env: local.env });
    if (host !== own) throw failure('HUB_WRONG_HOST', `this request is for host ${host}; this is host ${own}, and a cancel never reaches another host`);
  }
  const named = input.resource !== null && input.resource !== undefined;
  const locks = named ? requestLocks(input.resource, local) : queuedLocks(local.env);
  // A Pool request is found only by its Pool; with a Resource named, a request on one lock only by none (the CLI's lookup takes whatever it finds).
  // The emulator request is a Pool request whose one queue is the gate's (a plain ticket): `emulator` is its Pool, and naming it is not a mismatch.
  const poolOf = lock => (lock === GATE && (input.pool ?? EMULATOR) === EMULATOR ? undefined : input.pool ?? (named ? null : undefined));
  let held = false;
  for (const lock of locks) {
    const result = cancelRequest(lock, id, { actor, why: input.why ?? null, pool: poolOf(lock), env: local.env, now: local.timing.now });
    if (result.cancelled) {
      const queues = result.locks.slice().sort().map(name => queueAnswer(name, local));
      const pool = result.pool ?? (lock === GATE ? EMULATOR : null);
      // A Pool request is answered under its Pool word; a request on one lock under that lock's Resource.
      return { request_id: id, outcome: 'cancelled', resource: pool ?? queues[0].resource, pool, queues };
    }
    held ||= result.reason === 'held';
  }
  if (!held && locks.includes(GATE)) held = slotHolding(local.env, id) !== null || readRecord(local.env, id) !== null;
  if (held) throw requestNotFound('held', `request ${id} already holds its lock, so there is no waiting request to cancel; release it (hub-device release ${id}, POST /leases/${id}/release)`);
  throw requestNotFound('unknown', `no request waits under the id "${id}"${named ? ` on ${input.resource}` : ' on this host'}${input.pool ? ` in the Pool ${input.pool}` : ''}`);
}

// ---- force-release a Lease (Story 7.6) ----

const FORCE_RELEASE_BODY_KEYS = Object.freeze(['why', 'holder', 'actor']);

// A force-release's `why`: missing is `no-why`, anything but a non-empty string `bad-why` (HUB_USAGE, before anything is read).
function checkWhy(why) {
  if (why === undefined || why === null) throw bodyUsage('no-why', 'a force-release says why: a non-empty why');
  if (!isText(why)) throw bodyUsage('bad-why', 'why must be a non-empty string');
  return why;
}

// Checks the body of a service's force-release into `{why, holder, actor}` (`holder` and `actor` null when absent). HUB_USAGE with a `reason`,
// before anything is read: bad-body (not an object, or a key outside `why`, `holder`, `actor`), no-why, bad-why, bad-actor, no-holder (neither
// an `actor` nor a `holder`). There is no holder check on the Lease and no confirmation step (NFR-6).
export function checkForceReleaseBody(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) throw bodyUsage('bad-body', 'the body must be a JSON object');
  for (const key of Object.keys(body)) if (!FORCE_RELEASE_BODY_KEYS.includes(key)) throw bodyUsage('bad-body', `the body has no key "${key}" (${FORCE_RELEASE_BODY_KEYS.join(', ')})`);
  const why = checkWhy(body.why);
  const actor = bodyActor(body);
  if (actor === null && !isText(body.holder)) throw bodyUsage('no-holder', 'say who is force-releasing: an actor or a holder');
  return { why, holder: body.holder ?? null, actor };
}

// The members of a `job:` id as forceReleaseJobError takes them: the repo and run it names (a local run's `local` repo and `local-<pid>` run
// are no GitHub run: null, with the pid), and its job.
function jobMembers(id) {
  const [, repo, run, job] = JOB_ID.exec(id) ?? [];
  if (!repo) return {};
  if (repo === 'local') return { pid: Number(/^local-(\d+)$/.exec(run)?.[1]) || null, job };
  return { repo, run, job };
}

// `POST /leases/{id}/force-release` (and `hub-device force-release <id> --why`; the Host Agent's too): ends the Lease `id` holds on this host,
// whatever its holder, on any lock (a phone, a registered phone, the iOS lane or any `res-*` lock), by the one protocol writer `forceRelease`.
// `input` is `{why, actor}` (`checkForceReleaseBody`'s result with the actor defaulted by the caller); both are required and recorded on the one
// `force-release` event. Answers `{lease_id, outcome: 'force-released', resource, lock, device, holder, why}`.
//
// Refusals, in order, before anything is written: HUB_USAGE (an actor, `no-why` / `bad-why`); HUB_FORCE_RELEASE_JOB for a `job:` id (a deploy job's
// place in line; built from the id alone) or a lock whose owner is a Job Hold (`repo`, `run`, `job`; cancel the run); HUB_USAGE `reason: emulator`
// for an id that holds an emulator slot or the gate or has an emulator record (Story 7.8's `forceReleaseEmulator` tears it down); HUB_LEASE_NOT_FOUND
// (`waiting`, `unknown`: an id that only waits is cancelled instead). A lock that changed hands between the read and the rename is HUB_LEASE_LOST
// (`changed-hands`; `being-taken` for a lock with no owner record yet), and the new owner is untouched. `ctx.beforeRetire` is the test seam of the rename.
export function forceReleaseLease(id, input, ctx) {
  const actor = checkActor(input?.actor);
  if (actor === null) throw usage('a force-release names its actor ({holder, via})');
  const why = checkWhy(input?.why);
  const local = serviceLocal(ctx);
  if (typeof id === 'string' && id.startsWith('job:')) throw forceReleaseJobError({ kind: 'job', ...jobMembers(id) });
  const { env } = local;
  const emulatorSlot = typeof id === 'string' && id !== '' ? readRecord(env, id)?.slot ?? slotHolding(env, id) ?? (readOwnerOf(GATE, env)?.lease_id === id ? GATE : null) : null;
  const refuseEmulator = slot => Object.assign(usage(`lease ${id} holds ${slot === GATE ? 'the emulator gate' : slot}, part of an emulator: force-releasing it tears the emulator down, so that is the slot's force-release (hub-device force-release ${slot === GATE ? 'emulator-<n>' : slot}, POST /leases/${slot === GATE ? 'emulator-<n>' : slot}/force-release), never this one`), { reason: EMULATOR });
  if (emulatorSlot !== null) throw refuseEmulator(emulatorSlot);
  const found = typeof id === 'string' ? listLocks({ env, now: local.timing.now, ...readerOf(local) }).find(lock => lock.kind === 'lease' && lock.owner.lease_id === id) : undefined;
  if (!found) throw leaseNotFound(id, local.fleet, env, local.processStart);
  if (isEmulatorLock(found.name)) throw refuseEmulator(found.name);
  const result = forceRelease(found.name, { actor, why, lease_id: id, env, now: local.timing.now, log: local.log, ...(local.beforeRetire ? { beforeRetire: local.beforeRetire } : {}) });
  if (!result.released) {
    const message = result.reason === 'unknown-holder' ? `${found.name} is being taken (its lock has no owner record yet); left alone` : `lease ${id} changed hands while it was being force-released; left alone, check \`hub-device status\``;
    throw Object.assign(failure('HUB_LEASE_LOST', message), { reason: result.reason === 'unknown-holder' ? 'being-taken' : 'changed-hands' });
  }
  return { lease_id: id, outcome: 'force-released', resource: resourceOf(found.name), lock: found.name, device: nameOf(local.fleet, found.name), holder: result.owner.holder ?? null, why };
}

// ---- force-release an emulator slot (Story 7.8) ----

// `POST /leases/emulator-<n>/force-release` (and `hub-device force-release emulator-<n> --why`; the Host Agent's too): ends the Lease that holds the slot
// `slot` of this host, whatever its holder, and tears its emulator down, in the order of AD-38: read the slot's owner and emulator record; under the
// `emulator-reaper` lock the one `force-release` event (`forceRelease`, carrying the owner's `lease_id`); the emulator torn down and its record removed;
// the reaper lock released (`forceReleaseSlot`, in emulator.mjs, owns everything from the second step). `input` is `{why, actor}` as `forceReleaseLease`'s;
// answers the same `ForceRelease` `{lease_id, outcome: 'force-released', resource, lock: slot, device: 'emulator', holder, why}` with the forced Lease's id.
// With `ctx.offThread` (a service: AD-44) the reaper lock, the force and the teardown run in a worker thread (`ctx.forceReleaseOffThread(args, {env, log})`
// replaces it in a test); the CLI runs them in its own process. `ctx.afterStep(name)` (`read`, `force-release`, `teardown`) and `ctx.beforeRetire` are the tests' seams.
//
// Refusals, before anything is written: HUB_USAGE (an actor, `no-why` / `bad-why`, `bad-slot`: not `emulator-1` to `emulator-<MAX_POOL>`); HUB_LEASE_NOT_FOUND
// (`unknown`: the slot holds nothing; a crash leftover record is the next acquire's reap); HUB_LEASE_LOST (`being-taken`: the lock has no owner record yet;
// `changed-hands`: the owner changed between the read and the rename, nothing torn down); HUB_FORCE_RELEASE_JOB for a Job Hold; HUB_LOCK_TIMEOUT when another
// teardown holds the reaper lock past the wait. A recorded process that outlived SIGKILL is HUB_EMULATOR_FAILED: the force stands (event written, slot gone),
// the record stays and the slot stays out of the pool until the next reap stops it. A crash after the force leaves an ownerless record that the next reap tears
// down as `orphaned` and writes no second event.
export async function forceReleaseEmulator(slot, input, ctx) {
  const actor = checkActor(input?.actor);
  if (actor === null) throw usage('a force-release names its actor ({holder, via})');
  const why = checkWhy(input?.why);
  if (!isEmulatorSlot(slot)) throw bodyUsage('bad-slot', `force-release: "${slot}" is not an emulator slot (emulator-1 to emulator-${MAX_POOL})`);
  const local = serviceLocal(ctx);
  const { env } = local;
  const owner = readOwnerOf(slot, env);
  if (!owner) {
    let exists = true;
    try { statSync(join(lockDir(env), `${slot}.lock`)); } catch { exists = false; }
    if (exists) throw Object.assign(failure('HUB_LEASE_LOST', `${slot} is being taken (its lock has no owner record yet); left alone`), { reason: 'being-taken' });
    throw Object.assign(failure('HUB_LEASE_NOT_FOUND', `no lease holds ${slot}`), { reason: 'unknown' });
  }
  if (!isLease(owner)) throw forceReleaseJobError({ kind: owner.kind ?? 'job', repo: owner.repo, run: owner.run, job: owner.job, pid: owner.pid });
  const id = owner.lease_id;
  const record = readRecord(env, id);
  local.log(`HUB_EMULATOR_FORCE_RELEASE ${slot} ${id} by ${actor.holder}: ${record ? `${record.pids.length} recorded process(es)` : 'no emulator record'}`);
  await local.afterStep?.('read');
  const args = { slot, lease_id: id, actor, why, graceMs: local.emulator.graceMs, reaperWaitMs: local.emulator.reaperWaitMs };
  let result;
  if (local.offThread) {
    const run = local.forceReleaseOffThread ?? ((given, seams) => offThread('force-release', given, seams));
    try { result = await run(args, { env, log: local.log }); } catch (error) { throw emulatorFailure(error, null); }
  } else {
    result = await forceReleaseSlot(slot, { ...args, env, log: local.log, sleep: local.timing.sleep, now: local.timing.now, afterStep: local.afterStep, beforeRetire: local.beforeRetire });
  }
  if (!result.released) {
    if (result.reason === 'none') throw Object.assign(failure('HUB_LEASE_NOT_FOUND', `no lease holds ${slot}`), { reason: 'unknown' });
    if (result.reason === 'unknown-holder') throw Object.assign(failure('HUB_LEASE_LOST', `${slot} is being taken (its lock has no owner record yet); left alone`), { reason: 'being-taken' });
    throw Object.assign(failure('HUB_LEASE_LOST', `lease ${id} changed hands while ${slot} was being force-released; left alone, check \`hub-device status\``), { reason: 'changed-hands' });
  }
  if (result.outcome === 'stuck') throw failure('HUB_EMULATOR_FAILED', `emulator ${id}: the force-release stands (${slot} is released and its force-release event is written), but pids ${result.survivors.join(',')} would not stop; the record stays and ${slot} stays out of the pool until the next emulator acquire's reap stops them`);
  return { lease_id: id, outcome: 'force-released', resource: resourceOf(slot), lock: slot, device: EMULATOR, holder: result.owner?.holder ?? owner.holder ?? null, why };
}

// ---- force-release a Reservation (Story 7.7) ----

const RESERVATION_FORCE_RELEASE_BODY_KEYS = Object.freeze(['why', 'holder', 'actor', 'name']);

// Checks the body of a service's Reservation force-release into `{why, holder, actor, name}` (`holder`, `actor` and `name` null when absent). HUB_USAGE
// with a `reason`, before anything is read: bad-body (not an object, or a key outside `why`, `holder`, `actor`, `name`), no-why, bad-why, bad-actor,
// no-holder (neither an `actor` nor a `holder`), bad-name (`name` is not a non-empty string; which names are reservable is `forceReleaseReservation`'s).
export function checkReservationForceReleaseBody(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) throw bodyUsage('bad-body', 'the body must be a JSON object');
  for (const key of Object.keys(body)) if (!RESERVATION_FORCE_RELEASE_BODY_KEYS.includes(key)) throw bodyUsage('bad-body', `the body has no key "${key}" (${RESERVATION_FORCE_RELEASE_BODY_KEYS.join(', ')})`);
  const why = checkWhy(body.why);
  const actor = bodyActor(body);
  if (actor === null && !isText(body.holder)) throw bodyUsage('no-holder', 'say who is force-releasing: an actor or a holder');
  if (body.name !== undefined && !isText(body.name)) throw bodyUsage('bad-name', `name must be one of ${RESERVABLE.join(', ')}`);
  return { why, holder: body.holder ?? null, actor, name: body.name ?? null };
}

// `POST /reservations/{run_key}/force-release` (and `hub-device force-release --reservation <run_key> --why`; the Host Agent's too): ends the Reservation a
// deploy run holds on a reservable lock of this host, from outside the run (a dead run's Reservation is first in line until its 3 h ceiling), through the
// one protocol writer `releaseReservation` with an actor. `input` is `{why, actor, name}`: both `why` and `actor` are required and recorded on the one
// `force-release` event; `name` (`adb` or `mac-ios`) narrows it to one lock, absent tries every reservable name in this host's lock dir (a run key can hold
// one on each host). Answers `{run_key, outcome: 'force-released', repo, run, released: [{lock, resource, reserved_at, expires_at}], why}`.
//
// Refusals, in order, before anything is written: HUB_USAGE (an actor, `no-why` / `bad-why`, `bad-run-key`, `bad-name`); HUB_RESERVATION_NOT_FOUND
// (`unknown`: no Reservation of that run key on this host, one already released, or one whose record is unreadable). The rename decides, so a force-release
// racing the run's own release or a ceiling prune ends it once with one event, and the loser is the 404.
export function forceReleaseReservation(runKey, input, ctx) {
  const actor = checkActor(input?.actor);
  if (actor === null) throw usage('a force-release names its actor ({holder, via})');
  const why = checkWhy(input?.why);
  if (typeof runKey !== 'string' || !RUN_KEY.test(runKey)) throw bodyUsage('bad-run-key', `force-release: "${runKey}" is not a run key (owner--repo--run)`);
  const name = input?.name ?? null;
  if (name !== null && !RESERVABLE.includes(name)) throw bodyUsage('bad-name', `force-release: --name is one of ${RESERVABLE.join(', ')}`);
  const local = serviceLocal(ctx);
  const released = [];
  let ended = null;
  for (const lock of name ? [name] : RESERVABLE) {
    const result = releaseReservation(lock, { env: local.env, key: runKey, now: local.timing.now, actor, why });
    if (result.status !== 'released') continue;
    ended ??= result.reservation;
    released.push({ lock, resource: resourceOf(lock), reserved_at: result.reservation.reserved_at, expires_at: result.reservation.expires_at });
  }
  if (released.length === 0) throw Object.assign(failure('HUB_RESERVATION_NOT_FOUND', `no Reservation of ${runKey} on ${name ?? RESERVABLE.join(' or ')} of this host (already released, never reserved, or its record is unreadable)`), { reason: 'unknown' });
  return { run_key: runKey, outcome: 'force-released', repo: ended.repo, run: String(ended.run), released, why };
}

// ---- status ----

// One phone's observation from an adb answer (`queryAdb`'s result, or a pushed listing in that shape): the answer's note when nobody
// could look, else the state adb lists the phone in, or null when the server does not list it. The one mapper the probe (this file) and
// the track socket (tools/hub-api/track.mjs, Story 8.3) share, so a push and a probe can never read the same listing differently.
export function adbStateOf(adb, serial) {
  if (adb.note !== null) return adb.note;
  const { listed, serials } = adb;
  const entry = listed.find(device => idMatchesSerial(device.id, serial) || (Boolean(serials.get(device.id)) && serials.get(device.id) === serial));
  return entry ? entry.state : null;
}

// Which fleet phones the hub's adb server lists, from the one read-only query (`reachability.queryAdb`: the wire only, never the adb
// client). Returns each fleet phone's observation: the state adb lists it in, null when the server does not list it, or a note saying
// why nobody could look. Only asked when the inventory shows the hub's server already running, so status can never start one (and a
// Mac, with no /proc, asks nothing). An id that cannot be read (unauthorized, offline) is not matched, so that phone reads absent.
//
// `ctx.adbQuery` is the query seam (Story 8.2, AD-44): a service passes its host snapshot's, which answers from the last gather and adds
// `checked_at` (ms: when the snapshot was taken, null when no gather ever succeeded). Returns `{observed, at}`: `at` is when the
// observation was made (the answer's own `checked_at`, so a reading made from an old snapshot shows its age; null when nobody observed
// anything), and undefined for a query this asked itself, which a reader stamps with its own clock as it always did.
async function phoneObservations(fleet, ctx, found) {
  const { env, adbWire, timing } = ctx;
  const hubPort = Number(env.HUB_ADB_SERVER_PORT) || 5037;
  const adb = await (ctx.adbQuery ?? queryAdb)({ port: hubPort, running: found.adb_servers.some(server => server.port === hubPort), wire: adbWire ?? createAdbWire, sleep: timing.sleep });
  return { observed: new Map(fleet.map(phone => [phone.device, adbStateOf(adb, phone.serial)])), at: adb.checked_at };
}

// The one adb-to-Reachability path (AD-35): the hub's adb server over the wire (inventory first, so a server nobody started is never
// asked), then each phone's observation mapped to a Reachability. `phones` are fleet entries (`phonesOf`); returns Map(device -> state).
// Read only: the same two wire requests `status` and `discover` make (and the one serial read per `host:port` id), nothing started.
export async function phoneReadings(phones, ctx) {
  const { env } = ctx;
  const found = (ctx.inventory ?? realInventory)({ lockRoot: lockDir(env), hubAdbPort: Number(env.HUB_ADB_SERVER_PORT) || 5037 });
  const { observed } = await phoneObservations(phones, ctx, found);
  return new Map(phones.map(phone => [phone.device, phoneReachability(observed.get(phone.device) ?? null)]));
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
  const startOf = ctx.processStart ? { processStart: ctx.processStart } : {};
  const listed = listLocks({ env, now: timing.now, ...startOf });
  const locks = listed.map(entry => {
    const owner = entry.owner ?? {};
    const lease = isLease(owner);
    return {
      lock: entry.name, device: nameOf(fleet, entry.name), kind: entry.kind, stale: entry.stale,
      lease_id: lease ? owner.lease_id : null, holder: lease ? owner.holder : null, why: lease ? owner.why : null,
      repo: owner.repo ?? null, run: owner.run ?? null, pid: lease ? null : owner.pid ?? null, holder_pid: owner.holder_pid ?? null,
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
  // The ETAs come from one windowed read of the Event Log and one policy, shared by every waiter and every Hold and read only when a
  // live waiter or a live Hold exists; a failure of either leaves those waiters with `eta: null` (`eta=?`) and never fails status.
  let history = null;
  const loadEtaInputs = () => {
    if (history !== null) return;
    history = false;
    try { history = policyOf() ? etaHistory({ env, now: nowMs, policy: policyOf() }) : false; } catch { history = false; }
  };
  for (const name of walkSet(fleet, env, locks.map(entry => entry.lock))) {
    const view = queueView(name, { env, includeStale: true, now: timing.now, ...startOf });
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
  const { observed, at: observedAt } = await phoneObservations(fleet, ctx, found);
  // A retired or seed-missing phone that nobody holds or waits on is gone from the list; a retiring one stays (AD-31).
  const records = readRegistryFile(env)?.resources ?? [];
  const shown = fleet.filter(phone => {
    const record = records.find(entry => entry.lock === phone.lock);
    return !record || visibility(record, lockActivity(phone.lock, { env, now: timing.now, ...startOf })) !== 'hidden';
  });
  const phones = shown.map(phone => {
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
  const emulators = emulatorStatus(env, ctx.liveStart ? { liveStart: ctx.liveStart } : {});
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
      if (resource === null) continue;
      // Stamped with when adb was observed, never with this request's time: a reading made from an old snapshot shows its age (Story 8.2).
      // No observation (a snapshot no gather ever filled) is no reading: the row shows unknown and stale.
      if (observedAt === null) continue;
      const taken = observedAt ?? readAt;
      readings.set(resource, stamp(phoneReachability(observed.get(phone.device) ?? null), { checkedAt: taken, receivedAt: readAt, ageMsAtReceipt: Math.max(0, readAt - taken) }));
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
  // A Hold's expected end (Story 8.1): derived from `now` and the one ETA, never stored. Null for a stale Hold, an unknown upper bound or a
  // policy or history that fails; a Lease never ends later than its `expires_at`.
  locks.forEach((row, index) => {
    let end = null;
    if (!row.stale) {
      loadEtaInputs();
      try { end = history ? expectedEnd(listed[index].owner ?? null, history, settings, nowMs) : null; } catch { /* an ETA never fails a read */ }
    }
    row.expected_end = end === null || !Number.isFinite(end) ? null : new Date(end).toISOString();
  });
  if (audience === 'service') {
    const qa = new Set(Array.isArray(qaIds) ? qaIds : []);
    for (const [rows] of rowsOf) for (const row of rows) if (row.resource !== null && qa.has(row.resource)) redact(row);
  }
  return { phones, locks, waiters, reservations, inventory: found, emulators };
}

// ---- discover (FR-4) ----

// The devices this host can see that no live Resource of the Registry names, from the read-only queries only: the hub's adb server over
// the wire on the Linux host (never started, connected or asked through the adb client; no server answers `no adb server`), `devicectl
// list devices` on the Mac. The host key picks the transport (AD-47): a host that does not know its key throws HUB_HOST_UNKNOWN, because
// guessing from the platform would list the Mac's adb devices, which are not the hub's. "Names" is the Registry's live records
// (`readRegistry`, retired and seed-missing ones excluded): the file when it is good, else the seed of `devices` (default devices.json)
// with the caller's `qaDevices` (default none: the CLI never reads the QA file). Returns `reachability.discover`'s document. Writes nothing.
export async function discover(key, ctx, { devices, qaDevices } = {}) {
  if (key !== 'linux' && key !== 'mac') throw failure('HUB_HOST_UNKNOWN', `this host does not know which host it is${key ? ` ("${key}" is neither linux nor mac)` : ''}, so it cannot choose how to discover devices; run \`mise run hosts:install\` on it`);
  const { env, timing } = ctx;
  const live = readRegistry({ env, devices, qaDevices: qaDevices ?? (() => []), warn: ctx.warn }).resources.filter(record => retirement(record) === null);
  if (key === 'mac') {
    let ipads;
    try { ipads = { document: await (ctx.devicectl ?? createDevicectl({ env }))(['list', 'devices'], 10) }; } catch (error) { ipads = { error }; }
    return discoverDevices({ seed: live, host: 'mac', ipads });
  }
  const hubPort = Number(env.HUB_ADB_SERVER_PORT) || 5037;
  const found = (ctx.inventory ?? realInventory)({ lockRoot: lockDir(env), hubAdbPort: hubPort });
  const adb = await (ctx.adbQuery ?? queryAdb)({ port: hubPort, running: found.adb_servers.some(server => server.port === hubPort), wire: ctx.adbWire ?? createAdbWire, sleep: timing.sleep });
  return discoverDevices({ seed: live, host: 'linux', adb });
}
