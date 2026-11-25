// Host locks. Three apps share one S26, one iPad and one Mac, and each app has its own runners, so per-repo
// concurrency groups cannot stop two deploys from talking to the same device at once. A lock is a directory
// (mkdir is atomic on both hosts) holding the owner's pid, run and start time. A holder that died without
// releasing (a job killed at its timeout) is reclaimed when its pid is gone; waiting has a deadline.
//
// A lease is the same lock taken by a person or an agent instead of a job: acquire returns and the lock persists past the
// process that took it, until release or `expires_at`. It lives in the same directory under the same name (`adb` is the
// S26), so withLock callers and leases exclude each other both ways. Waiters for a lease queue FIFO in `<name>.queue/`.
//
// A deploy run also reserves its devices (AD-7): `<name>.reservations/<owner>--<repo>--<run>/`, a sibling path no older version
// reads, listed in the queue view at the run's start time so a build never loses its place while it compiles.
//
// Removal is exactly once (AD-9): a release or reclaim renames `<name>.lock` to a tomb, and only the process whose rename
// succeeded deletes it and records the event in the Event Log (events.mjs). This module is the only caller of appendEvent.
//
// `writeFileAtomic` (AD-27) is the one tmp-plus-rename helper for a file a service writes into the lock dir (the Registry store's
// file is the first): a reader sees the old bytes or the new, never half. The older `writeOwner` and `writeTicket` keep
// their own tmp names, which older pins share on disk.
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { closeSync, existsSync, fchmodSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, utimesSync, writeFileSync, writeSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { appendEvent, hostId as machineId, readEvents } from './events.mjs';
import { pause, sleep as realSleep } from './pause.mjs';
import { jobDeadline, jobTimeoutMs } from './deadline.mjs';
import { loadPolicy } from './policy.mjs';
import { earliest, eta, etaMoved, formatEta } from './eta.mjs';

export const lockDir = (env = process.env, home = homedir()) => env.HUB_LOCK_DIR || join(home, '.cache/mobile-deploy-hub/locks');

// Names (AD-28, AD-29): this module is the one owner of what a lock or a Resource word may be called, and of the id shapes no word
// may take (Lease ids keep their own rules). A slug is lowercase letters and digits in runs split by single dashes, 1 to 32
// characters; a Resource name is at most 28, so the part after `res-` of a Registry-minted lock (`<name>-999`, a numeric
// suffix) is still a slug of at most 32 (the whole lock is at most 36).
export const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export const SLUG_MAX = 32;
export const NAME_MAX = 28;
export const isSlug = (text, max = SLUG_MAX) => typeof text === 'string' && text.length >= 1 && text.length <= max && SLUG.test(text);

// The one reserved-word list: exact words, `<prefix>*` shapes and the `emulator-<n>` shape. These are the CLI's device words,
// the lock names the hub itself takes, the service names and the id shapes it mints, so no Resource can be named like one.
// `ios-lane` is a seeded Resource id and `run-*` an id shape `claims.newLeaseId` mints: id resolution comes before word
// resolution, so a name in either shape would be shadowed. Data only (strings), so the Registry store imports it as it is.
export const RESERVED = Object.freeze([
  'phone', 'emulator', 'adb', 's24', 's26', 'ipad', 'mac', 'mac-ios', 'ios-lane', 'emulator-reaper',
  's3-*', 'emulator-<n>', 'registry', 'hub-api', 'host-agent', 'res-*', 'l-*', 'e-*', 'run-*', 'job:*',
]);
const reservedMatches = (entry, name) => {
  if (entry === 'emulator-<n>') return /^emulator-\d+$/.test(name);
  return entry.endsWith('*') ? name.startsWith(entry.slice(0, -1)) : entry === name;
};
// The RESERVED entry `name` matches, or null.
export const reservedBy = name => (typeof name === 'string' ? RESERVED.find(entry => reservedMatches(entry, name)) ?? null : null);

// The seed (AD-40): the Resources devices.json declares, as the lock each one has always sat on, mapped to its Resource id. A
// pure name map; names.test.mjs keeps it equal to what devices.json derives. The emulator Pool is the Resource of `emulator`
// and every `emulator-<n>` slot; a `res-<slug>` lock is its own Resource.
export const SEED_RESOURCES = Object.freeze({ adb: 's26', s24: 's24', 'mac-ios': 'ios-lane' });
export const EMULATOR_POOL = 'emulator';
export const resourceOf = lock => {
  if (typeof lock !== 'string') return null;
  if (Object.hasOwn(SEED_RESOURCES, lock)) return SEED_RESOURCES[lock];
  if (lock === 'emulator' || /^emulator-\d+$/.test(lock)) return EMULATOR_POOL;
  return isRegistryLock(lock) ? lock : null;
};

// Why `name` cannot name a Resource, or null when it can: not a slug, over 28 characters, or a reserved word that is not the
// seeded Resource's own (a seeded Resource keeps its word: `s24` is allowed because SEED_RESOURCES maps the lock `s24` to `s24`).
export function nameRefusal(name) {
  if (typeof name !== 'string' || !SLUG.test(name)) return 'not a slug: lowercase letters and digits, single dashes between';
  if (name.length > NAME_MAX) return `longer than ${NAME_MAX} characters`;
  const entry = reservedBy(name);
  if (entry !== null && !(Object.hasOwn(SEED_RESOURCES, name) && SEED_RESOURCES[name] === name)) return `a reserved word (${entry})`;
  return null;
}

// The Queued set (AD-4): the device locks whose transitions are history. `emulator` is the pool gate; its slots are
// `emulator-<n>`; a Registry lock is `res-<slug>` (AD-29). Decided by name alone, never by reading a file. Every other name
// (s3-*, s3-index, emulator-reaper) writes no events.
export const QUEUED = Object.freeze(['adb', 's24', 'mac-ios', 'emulator']);
const isRegistryLock = name => typeof name === 'string' && name.startsWith('res-') && isSlug(name.slice('res-'.length));
export const isQueued = name => QUEUED.includes(name) || (typeof name === 'string' && /^emulator-\d+$/.test(name)) || isRegistryLock(name);

// A holder of a Queued lock touches <name>.lock/alive this often at most (AD-19), so a reclaim can say when it was last seen.
export const ALIVE_MS = 60_000;
const OWNER_FORMAT = 1;

const alive = pid => {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
};

// A record from before leases (pid, host, repo, run, started_at) still parses; anything that is not an object is no owner.
export function readOwner(path) {
  try {
    const owner = JSON.parse(readFileSync(join(path, 'owner.json'), 'utf8'));
    return owner && typeof owner === 'object' && !Array.isArray(owner) ? owner : null;
  } catch { return null; }
}

export const isLease = owner => owner?.kind === 'lease';
const expiresAt = owner => (isLease(owner) ? Date.parse(owner.expires_at) : NaN);

// The live Lease holding `name`, or null (AD-13): the owner record when a Lease holds it and its expiry and holder have not
// passed. A Lease is judged by expiry and holder only, never by age (staleMs Infinity). Reads only; never throws.
export function liveLease(name, { env = process.env, now = Date.now, host = hostname(), hostId = machineId() } = {}) {
  try {
    const path = join(lockDir(env), `${name}.lock`);
    const owner = readOwner(path);
    return isLease(owner) && staleness(path, owner, { now, staleMs: Infinity, host, hostId }) === null ? owner : null;
  } catch { return null; }
}

const describe = owner => {
  if (!owner) return 'an unknown holder';
  if (isLease(owner)) return `lease ${owner.lease_id} of ${owner.holder ?? 'someone'}${owner.why ? ` (${owner.why})` : ''} until ${owner.expires_at}`;
  return `${owner.repo ?? 'a local run'} run ${owner.run ?? '-'} (pid ${owner.pid}, since ${owner.started_at})`;
};

// Stale: a job whose pid is gone or that outlived staleMs; a lease past its expires_at or whose holder_pid (when it
// names one) is gone or is now another process (holder_process_start differs). A lease is not judged by pid (the
// process that took it is long gone) or by age. Returns why (`gone`, `abandoned`, `expired`, `holder-gone`, `too-old`),
// or null while the lock is live.
function staleness(path, owner, { now, staleMs, host = hostname(), hostId = machineId() }) {
  let age = 0;
  try { age = now() - statSync(path).mtimeMs; } catch { return 'gone'; }
  // owner.json is written right after mkdir; a lock without one for a minute was abandoned mid-creation.
  if (!owner) return age > 60_000 ? 'abandoned' : null;
  // Same host by machine id when both records carry one, else by hostname (AD-8): a drifted mDNS name is still this Mac.
  const here = sameHost(owner, { host, host_id: hostId });
  if (Number.isFinite(expiresAt(owner))) {
    if (expiresAt(owner) <= now()) return 'expired';
    if (!here || !Number.isSafeInteger(owner.holder_pid)) return null;
    if (!alive(owner.holder_pid)) return 'holder-gone';
    return owner.holder_process_start && processStart(owner.holder_pid) !== owner.holder_process_start ? 'holder-gone' : null;
  }
  if (here && Number.isSafeInteger(owner.pid) && !alive(owner.pid)) return 'holder-gone';
  return age > staleMs ? 'too-old' : null;
}

// Two records are on the same host when both carry a host_id and the ids are equal; otherwise hostname equality decides
// (AD-8). A record with no hostname is on no host we can name.
export function sameHost(a, b) {
  if (a?.host_id && b?.host_id && a.host_id === b.host_id) return true;
  return typeof a?.host === 'string' && a.host !== '' && a.host === b?.host;
}
// This machine as a record sees it, for a caller outside lock.mjs that asks sameHost (AD-8).
export const localHost = ({ host = hostname(), hostId = machineId() } = {}) => ({ host, host_id: hostId });
const stale = (path, owner, options) => staleness(path, owner, options) !== null;

const sameOwner = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const iso = ms => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);

// The AD-9 event body for a hold or a request. `subject` is an owner record, or the would-be owner of a request (a Lease:
// kind 'lease', lease_id, holder, and claimant_kind `agent` or `person`, `agent` when it has none; a job: its owner without
// started_at). A withLock job is taken by a deploy run unless it says `hub-job` (the catch-up). An owner from before v1a (no kind) is a
// deploy job. for_ms and expires_at describe a Lease; `fields` fills or overrides the rest. `resource` is the Resource the lock
// stands for (resourceOf, by name alone), null on a Pool-level event; old readers ignore it (AD-2).
function eventOf(event, name, subject, fields = {}) {
  const lease = isLease(subject);
  const forMs = expiresAt(subject) - Date.parse(subject?.started_at);
  return {
    event, lock: name, resource: resourceOf(name), hold_kind: subject ? (lease ? 'lease' : 'job') : null,
    claimant: {
      kind: subject ? (lease ? subject.claimant_kind ?? 'agent' : subject.kind === 'hub-job' ? 'hub-job' : 'deploy') : null,
      holder: subject?.holder ?? null, repo: subject?.repo ?? null, run: subject?.run ?? null, attempt: subject?.attempt ?? null, job: subject?.job ?? null,
    },
    lease_id: lease ? subject.lease_id ?? null : null,
    for_ms: lease && Number.isFinite(forMs) ? forMs : null,
    expires_at: lease ? subject.expires_at ?? null : null,
    deadline_at: null, waited_ms: null, held_ms: null, reason: null, last_alive_at: null,
    ...fields,
  };
}

// held_ms runs from started_at (the take, never the wait) to `at`; a Lease's ends no later than its expires_at, so a
// reclaim of a dead Lease ends at the earlier of its expiry and the death the reclaimer observed (AD-19).
function heldMs(owner, at) {
  const started = Date.parse(owner?.started_at);
  const end = Number.isFinite(expiresAt(owner)) ? Math.min(at, expiresAt(owner)) : at;
  return Number.isFinite(started) ? Math.max(0, end - started) : null;
}

// Appends one event for a Queued name, at `at`; every other name writes nothing (AD-4). Never throws (appendEvent). True when the
// line was written, false when it was not (a name that is not Queued, or a failed write); the transitions ignore it.
function note(name, body, { env, at, hostId }) {
  return isQueued(name) ? appendEvent(body, { env, now: () => at, hostId }) : false;
}

// Who did it (AD-36): {holder, via}, set once by the first front door. Optional on every event the functions below write.
export const ACTOR_VIA = Object.freeze(['cli', 'api', 'host-agent', 'control-surface']);

// The actor as it is written, or null for none. A malformed actor is a caller bug: TypeError.
export function checkActor(actor) {
  if (actor === undefined || actor === null) return null;
  const plain = typeof actor === 'object' && !Array.isArray(actor) && Object.getPrototypeOf(actor) === Object.prototype;
  if (!plain || Object.keys(actor).sort().join(',') !== 'holder,via' || typeof actor.holder !== 'string' || actor.holder === '' || !ACTOR_VIA.includes(actor.via)) {
    throw new TypeError(`bad actor ${JSON.stringify(actor)} ({holder: non-empty string, via: ${ACTOR_VIA.join('|')}})`);
  }
  return { holder: actor.holder, via: actor.via };
}

// The ones every non-hold event may carry: actor (checked) and why (a string).
function actorFields(fields) {
  const out = {};
  const actor = checkActor(fields.actor);
  if (actor) out.actor = actor;
  if (fields.why !== undefined && fields.why !== null) {
    if (typeof fields.why !== 'string') throw new TypeError('why must be a string');
    out.why = fields.why;
  }
  return out;
}

const nonEmpty = (value, key) => { if (typeof value !== 'string' || value === '') throw new TypeError(`${key} must be a non-empty string`); return value; };

export const REGISTRY_EVENTS = Object.freeze(['add', 'edit', 'retire']);

// Appends one `registry-add|edit|retire` event (AD-39). The body is an allowlist: resource, lock, changed (the key paths that
// changed, strings only), rev, reason, actor, why. Anything else passed in (an identity, a serial, a udid, an adb id, allowed_users)
// is dropped, never written. No Queued gate (a Resource's name is not a lock's hold). A caller bug (bad kind, missing resource or
// lock, a bad changed, rev or actor) is a TypeError; a failed write is false, logged HUB_EVENT_LOG_FAILED, never thrown.
export function noteRegistry(kind, fields, { env = process.env, now = Date.now, hostId = machineId(), log = console.error } = {}) {
  if (!REGISTRY_EVENTS.includes(kind)) throw new TypeError(`bad registry event kind "${kind}" (${REGISTRY_EVENTS.join(', ')})`);
  if (!fields || typeof fields !== 'object') throw new TypeError('registry event fields are an object');
  const body = { event: `registry-${kind}`, resource: nonEmpty(fields.resource, 'resource'), lock: nonEmpty(fields.lock, 'lock') };
  if (fields.changed !== undefined && fields.changed !== null) {
    if (!Array.isArray(fields.changed) || fields.changed.some(key => typeof key !== 'string')) throw new TypeError('changed is an array of key strings');
    body.changed = [...fields.changed];
  }
  if (fields.rev !== undefined && fields.rev !== null) {
    if (!Number.isSafeInteger(fields.rev) || fields.rev < 0) throw new TypeError('rev must be a whole number');
    body.rev = fields.rev;
  }
  if (fields.reason !== undefined && fields.reason !== null) {
    if (typeof fields.reason !== 'string') throw new TypeError('reason must be a string');
    body.reason = fields.reason;
  }
  return appendEvent({ ...body, ...actorFields(fields) }, { env, now, hostId, log });
}

// A Reachability state is a short lowercase word, or null for a first reading. Not checked against the Registry's enum: this module
// never imports tools/registry (it is imported by it).
const STATE_WORD = /^[a-z][a-z-]{0,23}$/;
const HOST_KEY = /^[a-z0-9][a-z0-9._-]{0,62}$/;
const stateOf = (value, key, nullable) => {
  if (value === null || value === undefined) { if (nullable) return null; throw new TypeError(`${key} must be a state word`); }
  if (typeof value !== 'string' || !STATE_WORD.test(value)) throw new TypeError(`${key} must be a short lowercase word${nullable ? ' or null' : ''}`);
  return value;
};

// Appends one `reachability` (a Resource: `resource`) or `host-reachability` (a peer host: `host`) event (AD-39). Exactly one of
// host and resource: both or neither is a TypeError. `from` is the state before (null for a first reading), `to` the state now,
// `checked_at` when the reading was taken (a date, ISO text or ms; null when unknown), `reason` why it changed. On a
// host-reachability line `host` is the peer the event is about (the one place the envelope's host is not the writer; the writer
// is `host_id`) and `resource` is null. No Queued gate. A failed write is false and logged, never thrown.
export function noteReachability(fields, { env = process.env, now = Date.now, hostId = machineId(), log = console.error } = {}) {
  if (!fields || typeof fields !== 'object') throw new TypeError('reachability fields are an object');
  const hasHost = fields.host !== undefined && fields.host !== null;
  const hasResource = fields.resource !== undefined && fields.resource !== null;
  if (hasHost === hasResource) throw new TypeError('a reachability event names exactly one of host and resource');
  const peer = hasHost ? nonEmpty(fields.host, 'host') : null;
  if (peer !== null && !HOST_KEY.test(peer)) throw new TypeError(`bad host key "${peer}"`);
  const checked = fields.checked_at === undefined || fields.checked_at === null ? null : iso(fields.checked_at instanceof Date ? fields.checked_at.getTime() : typeof fields.checked_at === 'number' ? fields.checked_at : Date.parse(fields.checked_at));
  if (checked === null && fields.checked_at !== undefined && fields.checked_at !== null) throw new TypeError('checked_at must be a date');
  if (fields.reason !== undefined && fields.reason !== null && typeof fields.reason !== 'string') throw new TypeError('reason must be a string');
  const body = {
    event: hasHost ? 'host-reachability' : 'reachability',
    resource: hasHost ? null : nonEmpty(fields.resource, 'resource'),
    from: stateOf(fields.from, 'from', true), to: stateOf(fields.to, 'to', false),
    checked_at: checked, reason: fields.reason ?? null,
    ...actorFields(fields),
  };
  return appendEvent(body, { env, now, hostId, log, ...(hasHost ? { host: peer } : {}) });
}

export const PRUNE_EVENTS_MAX = 20;

let lastTomb = 0;
const VANISHED_RETRIES = 3;

// Retires a lock: renames <name>.lock to <name>.lock.tomb-<ms>-<pid> (a name that never ends in .lock, so it never blocks
// the lock name, not even for an older pinned version's bare mkdir, and listLocks never lists it). The rename decides
// (AD-9): ENOENT means another process got there first, and the loser writes nothing. A tomb that holds anything but
// the owner that was judged means the lock changed hands after the judgement; it is put back. Only the winner deletes
// its tomb and, when `as` names an event and the name is Queued, appends it. True for the winner. beforeRetire is a test
// seam, called with 'rename' before the rename and 'restore' before a put-back.
function retire(name, path, judged, { as = null, reason = null, fields = {}, env = process.env, now = Date.now, log = console.error, hostId, beforeRetire = () => {} } = {}) {
  if (!sameOwner(readOwner(path), judged)) return false;
  beforeRetire('rename');
  const at = now();
  // Monotonic per process, so two retirements in one millisecond (or under a frozen test clock) never share a tomb.
  lastTomb = Math.max(Number.isFinite(at) ? Math.trunc(at) : 0, lastTomb + 1);
  const tomb = `${path}.tomb-${lastTomb}-${process.pid}`;
  try {
    renameSync(path, tomb);
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
  const moved = readOwner(tomb);
  if (!sameOwner(moved, judged)) {
    beforeRetire('restore');
    try {
      renameSync(tomb, path);
    } catch {
      // Taken again in the instant between the two renames: the moved holder's lock cannot be put back.
      log(`HUB_LOCK_LOST ${name} ${describe(moved)}: it changed hands while a stale holder was being reclaimed`);
      try { rmSync(tomb, { recursive: true }); } catch { /* a tomb never blocks the name */ }
    }
    return false;
  }
  // A job's last sign of life is the mtime of its alive touch, read from the tomb before it goes. It is approximate: a
  // synchronous child can block the touch (AD-19). A job from before v1a has none.
  let alive = null;
  const job = as === 'reclaim' && judged && !isLease(judged);
  if (job) { try { alive = statSync(join(tomb, 'alive')).mtimeMs; } catch { /* never touched */ } }
  try { rmSync(tomb, { recursive: true }); } catch { /* a tomb never blocks the name */ }
  if (as) {
    const lastAlive = job && alive !== null ? { last_alive_at: iso(alive), approx: true } : {};
    note(name, eventOf(as, name, judged, { held_ms: heldMs(judged, at), reason, ...lastAlive, ...fields }), { env, at, hostId });
  }
  return true;
}

// A deploy job's or the catch-up's hold of a host lock. A Queued name (AD-4) joins the FIFO as a `job` or `hub-job` ticket
// and is served in order through queueView; every other name (s3-*, s3-index, emulator-reaper) is the bare mkdir path with no
// ticket and no event. Either way a wait that runs out throws code HUB_LOCK_TIMEOUT with a message that starts
// `host lock <name> is held` (AD-5), so a catch-up from before this change still reads it.
export const JOB_POLL_MS = 2000;

// The delivery a Queued hold is for (AD-15, Story 3.3): null, or exactly {repo, run, version}. It goes onto the caller's ticket and
// onto every event that waiter or holder writes, and only when the caller gave one.
export function checkDelivery(delivery) {
  if (delivery === null || delivery === undefined) return null;
  const plain = delivery !== null && typeof delivery === 'object' && !Array.isArray(delivery) && Object.getPrototypeOf(delivery) === Object.prototype;
  const keys = plain ? Object.keys(delivery).sort().join(',') : '';
  if (!plain || keys !== 'repo,run,version'
    || typeof delivery.repo !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(delivery.repo)
    || typeof delivery.run !== 'string' || !/^\d{1,20}$/.test(delivery.run)
    || typeof delivery.version !== 'string' || !/^[0-9A-Za-z.+-]{1,40}$/.test(delivery.version)) {
    throw new Error(`bad delivery ${JSON.stringify(delivery)} (null, or {repo: "owner/name", run: digits, version})`);
  }
  return delivery;
}

export async function withLock(name, fn, {
  env = process.env,
  timeoutMs = 15 * 60_000,
  pollMs = JOB_POLL_MS,
  staleMs = 4 * 3600_000,
  log = console.log,
  sleep = ms => new Promise(done => setTimeout(done, ms)),
  now = Date.now,
  kind = 'job',
  hostId = machineId(),
  host = hostname(),
  timers = { setInterval, clearInterval },
  beforeRetire,
  afterTake = () => {},
  processStart: startOf = processStart,
  policy = null,
  deadlineSeams = {},
  endsReservation = false,
  yieldToLease = false,
  timeoutReason = 'deadline',
  delivery = null,
  afterEta = () => {},
} = {}) {
  if (!/^[a-z0-9-]+$/.test(name)) throw new Error(`bad lock name "${name}"`);
  if (typeof timeoutReason !== 'string' || !/^[a-z][a-z0-9-]{0,39}$/.test(timeoutReason)) throw new Error(`bad timeout reason "${timeoutReason}"`);
  checkDelivery(delivery);
  if (kind !== 'job' && kind !== 'hub-job') throw new Error(`bad lock holder kind "${kind}" (job or hub-job)`);
  if (isQueued(name)) return queuedLock(name, fn, { env, timeoutMs, pollMs, staleMs, log, sleep, now, kind, hostId, host, timers, beforeRetire, afterTake, startOf, policy, deadlineSeams, endsReservation, yieldToLease, timeoutReason, delivery, afterEta });
  const dir = lockDir(env);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${name}.lock`);
  const { me, more } = jobIdentity({ env, host, hostId, kind });
  const deadline = now() + timeoutMs;
  let waiting = false;
  let vanished = 0;
  let mine;
  for (;;) {
    try {
      mkdirSync(path);
      // started_at is when the lock was taken, not when the wait began.
      mine = { ...me, started_at: new Date(now()).toISOString(), ...more };
      writeFileSync(join(path, 'owner.json'), JSON.stringify(mine));
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    const owner = readOwner(path);
    const verdict = staleness(path, owner, { now, staleMs, host, hostId });
    // `gone`: the lock vanished between the mkdir and this read (its holder just released it). Nothing is left to retire, and a
    // retire would rename whatever a third taker made there since (a try writes no ticket, so takers race the mkdir). Go round
    // again; after a few such rounds it waits like any held lock, so a path that is not a lock at all never spins.
    if (verdict && (verdict !== 'gone' || (vanished += 1) <= VANISHED_RETRIES)) {
      if (verdict !== 'gone' && retire(name, path, owner, { as: 'reclaim', reason: verdict, env, now, log, hostId, beforeRetire })) log(`HUB_LOCK_RECLAIMED ${name} from ${describe(owner)}`);
      continue;
    }
    if (yieldToLease && isLease(owner)) throw yielded(name, owner);
    if (now() >= deadline) throw Object.assign(failure('HUB_LOCK_TIMEOUT', `${heldText(name, owner)}; gave up after ${Math.round(timeoutMs / 60_000)} min. Another deploy is using the device; run again when it finishes.`), { owner, holds: holdsOf(owner) });
    if (!waiting) { log(`HUB_LOCK_WAIT ${name} held by ${describe(owner)}`); waiting = true; }
    await sleep(pollMs);
  }
  return runHeld(name, path, mine, fn, { env, now, log, hostId, timers });
}

// A wait that gave way to a Lease (`yieldToLease`): the holder is on the error, so the caller can read around it (AD-13).
const yielded = (name, owner) => Object.assign(failure('HUB_LOCK_YIELDED', `${heldText(name, owner)}; yielded to the Lease`), { owner });

// owner.json keeps every key older versions read (pid, host, repo, run, started_at) and adds the AD-2 keys after them.
function jobIdentity({ env, host, hostId, kind }) {
  return {
    me: { pid: process.pid, host, repo: env.GITHUB_REPOSITORY ?? null, run: env.GITHUB_RUN_ID ?? null },
    more: { format: OWNER_FORMAT, kind, attempt: env.GITHUB_RUN_ATTEMPT ?? null, job: env.GITHUB_JOB ?? null, host_id: hostId },
  };
}

// Runs fn under a lock this process just took (`mine` is its owner record), then gives it back with a `release` event.
async function runHeld(name, path, mine, fn, { env, now, log, hostId, timers, endsReservation = false, fields = {} }) {
  log(`HUB_LOCK ${name}`);
  // The liveness touch (AD-19): the only in-process interval, unref'd so it never keeps a process alive. It touches only
  // while owner.json is still this take, so a lock that changed hands is never touched by its old holder.
  let timer = null;
  if (isQueued(name)) {
    const alive = join(path, 'alive');
    const touch = () => {
      try {
        const owner = readOwner(path);
        if (owner?.pid !== mine.pid || owner.started_at !== mine.started_at) return;
        const at = new Date(now());
        writeFileSync(alive, '');
        utimesSync(alive, at, at);
      } catch { /* liveness is advisory: a failed touch never fails the hold */ }
    };
    touch();
    timer = timers.setInterval(touch, ALIVE_MS);
    timer?.unref?.();
  }
  let failed = false;
  try {
    return await fn();
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    if (timer) timers.clearInterval(timer);
    // The run is done with the device (AD-7): its Reservation is renamed away before the lock is freed, so nobody ever sees a
    // free lock with a finished run's Reservation still first in line (and a late grace stamp into it is ENOENT). Only after a
    // hold that ended well; a failed hold keeps the Reservation for the rerun. `endsReservation` may be a function that decides
    // once the hold is over.
    if (!failed && endsReservation && isQueued(name)) {
      try {
        if (typeof endsReservation !== 'function' || endsReservation()) {
          const ended = releaseReservation(name, { env, now, hostId });
          if (ended.status === 'released') log(`HUB_RESERVATION_RELEASED ${name} ${ended.key}`);
        }
      } catch { /* the ceiling ends it */ }
    }
    const owner = readOwner(path);
    if (owner?.pid === mine.pid && !isLease(owner)) retire(name, path, owner, { as: 'release', reason: failed ? 'error' : 'done', fields, env, now, log, hostId });
  }
}

// ---- leases ----

export const MAX_LEASE_MS = 48 * 3600_000;
const leaseName = name => { if (!/^[a-z0-9-]+$/.test(name)) throw new Error(`bad lock name "${name}"`); return name; };
const leaseId = id => { if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) throw new Error(`bad lease id "${id}" (lowercase letters, digits and dashes)`); return id; };
const lockPath = (name, env) => join(lockDir(env), `${leaseName(name)}.lock`);
const queuePath = (name, env) => join(lockDir(env), `${leaseName(name)}.queue`);
const failure = (code, message) => Object.assign(new Error(message), { code });
// A refused extension: the code, and a `reason` a front door answers with (waiters, expired, cap, too-long).
const refusal = (reason, message) => Object.assign(failure('HUB_LEASE_EXTEND_REFUSED', message), { reason });

// Who a Lease is for: an agent (the default) or a person (Holocene's page, a person's own tool). Anything else is a caller bug.
export const CLAIMANT_KINDS = Object.freeze(['agent', 'person']);
function checkClaimantKind(kind) {
  if (!CLAIMANT_KINDS.includes(kind)) throw new TypeError(`bad claimantKind ${JSON.stringify(kind)} (${CLAIMANT_KINDS.join('|')})`);
  return kind;
}

// The Holds that kept a wait from the lock, as plain data for a receipt or an event (never public): the holder first, then each
// blocker ahead of the waiter in the Queue with its place. A holder is a Lease's `holder` or a job's `<repo>#<run>`. Never throws.
export function holdsOf(owner, blockers = []) {
  try {
    const holds = [];
    if (owner) {
      const lease = isLease(owner);
      holds.push({
        role: 'holder', kind: lease ? 'lease' : owner.kind ?? 'job', holder: lease ? owner.holder ?? null : `${owner.repo ?? 'local'}#${owner.run ?? '-'}`,
        lease_id: owner.lease_id ?? null, why: owner.why ?? null, since: owner.started_at ?? null, until: owner.expires_at ?? null,
      });
    }
    for (const entry of blockers ?? []) {
      holds.push({
        role: 'ahead', place: entry.place ?? null, kind: entry.kind ?? null, holder: entry.holder ?? null, lease_id: entry.lease_id ?? null, why: entry.why ?? null,
        since: entry.enqueued_at ?? entry.reserved_at ?? null, until: entry.expires_at ?? entry.deadline_at ?? null,
      });
    }
    return holds;
  } catch { return []; }
}

// Writes `data` (a string or a Buffer) to `path` atomically (AD-27): a unique `<path>.<pid>.<hex>.tmp` opened `wx` at `mode`, written,
// fsynced and closed, then renamed over `path`, so a reader never sees half a file and two writers never share a tmp. The parent is
// created when missing. On any failure the tmp is removed and the error rethrown; `path` is then untouched. A tmp left by a process
// that was killed mid-write is garbage nothing reads (no reader opens a `.tmp` name).
export function writeFileAtomic(path, data, { mode = 0o600 } = {}) {
  mkdirSync(dirname(path), { recursive: true });
  const bytes = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  let fd = null;
  try {
    fd = openSync(tmp, 'wx', mode);
    fchmodSync(fd, mode);
    for (let written = 0; written < bytes.length;) written += writeSync(fd, bytes, written, bytes.length - written);
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    renameSync(tmp, path);
  } catch (error) {
    if (fd !== null) { try { closeSync(fd); } catch { /* the first error is the one to report */ } }
    try { unlinkSync(tmp); } catch { /* it may never have been created */ }
    throw error;
  }
}

// Write-then-rename: a reader never sees half a record.
function writeOwner(path, owner) {
  const tmp = join(path, `owner.json.${process.pid}.tmp`);
  writeFileSync(tmp, JSON.stringify(owner));
  renameSync(tmp, join(path, 'owner.json'));
}

// The deploy targets (AD-16): the locks a deploy takes, whose Leases the policy caps in total length. `s24`, the emulator pool and
// every other name keep only MAX_LEASE_MS.
export const DEPLOY_TARGETS = Object.freeze(['adb', 'mac-ios']);

// The cap on a Lease of `name` in ms: the policy's queue.deploy_target_lease_max_min for a deploy target, null for any other name.
// `policy` is injected by tests; a policy object without the key (a hand-made one) reads the real policy file.
export function deployTargetCapMs(name, { policy = null } = {}) {
  if (!DEPLOY_TARGETS.includes(name)) return null;
  let minutes = policy?.queue?.deploy_target_lease_max_min;
  if (!(minutes > 0)) minutes = loadPolicy().policy.queue.deploy_target_lease_max_min;
  return minutes * 60_000;
}

// The AD-16 wording of a cap refusal, shared by acquire, extend and `hub-device` so they never drift.
export const capText = (name, capMs) => `a lease on ${name} runs at most ${Math.round(capMs / 60_000)} min in total (the deploy-target cap, policy queue.deploy_target_lease_max_min); lease s24 or an emulator for longer`;

const lost = (name, id, why) => failure('HUB_LEASE_LOST', `lease ${id} no longer holds ${name}: ${why}`);

// The lock directory's inode as a string (a number can lose digits in JSON), or null when there is no directory.
const inodeOf = path => { try { return String(statSync(path).ino); } catch { return null; } };

// AD-16: before an owner rewrite, is `path` still the lock this writer took? Returns the owner record when it is, null when no lock
// or no owner record is there (released, or being taken), and throws HUB_LEASE_LOST when another Lease or a job holds the lock now or
// the directory is not the one recorded at acquire. `ino` is what the writer recorded when it took the Lease (the record
// `acquireLease` returned); a record that carries its own `lock_ino` is held to it as well. A Lease from before v1a has neither.
function ownLease(name, path, id, ino) {
  const dir = inodeOf(path);
  if (dir === null) return null;
  const owner = readOwner(path);
  if (!owner) return null;
  if (!isLease(owner) || owner.lease_id !== id) throw lost(name, id, `the lock is held by ${describe(owner)} now`);
  if ((ino !== null && ino !== undefined && String(ino) !== dir) || (owner.lock_ino !== undefined && owner.lock_ino !== null && String(owner.lock_ino) !== dir)) throw lost(name, id, 'the lock directory was replaced since the lease was taken');
  return owner;
}

// The one owner rewrite of a held Lease: write a temp file, check again that the lock is still this writer's, then rename it into
// place. True when written; false when the lock is gone (nothing to write into); throws HUB_LEASE_LOST (and removes the temp file)
// when another holder has it. A window of one rename remains between the last check and the rename (deferred-work.md).
function rewriteOwner(name, path, id, ino, next) {
  const tmp = join(path, `owner.json.${process.pid}.tmp`);
  try { writeFileSync(tmp, JSON.stringify(next)); } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  try {
    if (!ownLease(name, path, id, ino)) { unlinkSync(tmp); return false; }
    renameSync(tmp, join(path, 'owner.json'));
    return true;
  } catch (error) {
    try { unlinkSync(tmp); } catch { /* gone with the directory */ }
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

let ticketCounter = 0;

// A pid can be reused, so a queue ticket names one process lifetime: pid plus its start time. On Linux that is
// /proc/<pid>/stat field 22 (the comm field is parenthesized and may contain spaces); elsewhere (the Mac) it is
// `ps -o lstart=`. Null when the process is gone or unreadable.
export function processStart(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)[19] ?? null;
  } catch { /* no /proc, or no such process */ }
  if (process.platform === 'linux') return null;
  const ps = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', timeout: 5000, env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' } });
  const start = ps.status === 0 ? ps.stdout.trim() : '';
  return start ? `ps:${start}` : null;
}

// ---- ticket format v1 (AD-3), frozen at the first queue-joining release ----
//
// A ticket is <name>.queue/<ms15>-<counter6>-<pid8>.json. Pinned versions read the same files, so the file name and every
// key a v1.2.43 reader uses (lease_id, holder, why, pid, host, process_start, enqueued_at) keep their meaning; the rest is
// additive. `kind` is lease, job, hub-job or remote; v1 writes no remote tickets (a v2 may, once every pin from before
// this format has aged out), but the reader never prunes a ticket for its kind alone.
export const TICKET_FORMAT = 1;
export const TICKET_KINDS = Object.freeze(['lease', 'job', 'hub-job']);
export const TICKET_ABSENT_MS = 60_000;

// A ticket from before kinds existed is a Lease (rule 1). Any other value is kept as written, known or not.
export const ticketKind = ticket => (ticket?.kind === undefined || ticket.kind === null || ticket.kind === '' ? 'lease' : ticket.kind);

// ---- attribution notes (Story 7.5) ----
//
// cancelRequest cannot write a waiter's ending event without racing the waiter, so it leaves <ticket>.cancel beside the ticket
// ({format, cancel: {actor, why, at}}; atomic, never ending in `.json`, with no `lease_id`, so every ticket reader and releaseLease
// ignore it) and then unlinks the ticket. The waiter that finds its ticket gone reads the note and fails naming the canceller.
export const CANCEL_NOTE_FORMAT = 1;
const cancelNotePath = ticketPath => `${ticketPath}.cancel`;

// {actor, why} from a ticket's note, or null when there is none (or it is junk: a note is never trusted past its own shape).
function readCancelNote(ticketPath) {
  try {
    const found = JSON.parse(readFileSync(cancelNotePath(ticketPath), 'utf8'))?.cancel;
    const actor = checkActor(found?.actor);
    return actor ? { actor, why: typeof found.why === 'string' ? found.why : null } : null;
  } catch { return null; }
}

// What a waiter whose ticket was taken out from under it fails with: HUB_LEASE_CANCELLED, and when a note names the canceller,
// `reason: cancelled` and `cancel: {actor, why}` (the Pool request's settle writes the ending from it).
function cancelledError(message, note) {
  if (!note) return failure('HUB_LEASE_CANCELLED', message);
  const text = `${message} (cancelled by ${note.actor.holder}${note.why ? `: ${note.why}` : ''})`;
  return Object.assign(failure('HUB_LEASE_CANCELLED', text), { reason: 'cancelled', cancel: note });
}

const dropNote = ticketPath => { try { rmSync(cancelNotePath(ticketPath), { force: true }); } catch { /* the next prune removes it */ } };

// A job's ticket id can never collide with a Lease id: Lease ids are [a-z0-9-] only (leaseId), this one has `:`, `#`, `/`.
export const jobLeaseId = ({ repo, run, attempt, job }) => `job:${repo}#${run}.${attempt}/${job}`;

// The ticket body, in AD-3 order. `kind` lease takes the Lease's own id, holder and why. A job or hub-job takes its identity
// from the runner's GITHUB_* variables and always gets a holder and a why (the status text and the logs name them). The
// caller supplies requested/deadline times (ms) so the ticket carries the real request time.
export function buildTicket(kind, {
  env = process.env, requested, deadline = null, lease_id = null, holder = null, why = null,
  host = hostname(), hostId = machineId(), pid = process.pid, processStart: startOf = processStart,
  expires_at = null, reservation = null, request = null, pool = null, eta = null, delivery = null, claimant_kind = null,
} = {}) {
  if (!TICKET_KINDS.includes(kind)) throw new Error(`bad ticket kind "${kind}" (${TICKET_KINDS.join(', ')}; this format writes no remote tickets)`);
  if (!Number.isFinite(requested)) throw new TypeError('a ticket carries the real request time');
  const repo = env.GITHUB_REPOSITORY ?? null;
  const run = env.GITHUB_RUN_ID ?? null;
  const attempt = env.GITHUB_RUN_ATTEMPT ?? null;
  const job = env.GITHUB_JOB ?? null;
  let id = lease_id;
  let who = holder;
  let because = why;
  if (kind === 'lease') {
    if (!id || !who || !because) throw new Error('a lease ticket names its lease id, holder and why');
  } else {
    id ??= jobLeaseId({ repo: repo ?? 'local', run: run ?? `local-${pid}`, attempt: attempt ?? 1, job: job ?? 'job' });
    who ||= kind === 'hub-job' ? 'catch-up' : repo ? `${repo}#${run ?? '-'}` : `local-${pid}`;
    because ||= kind === 'hub-job' ? 'catch-up install' : job ?? 'deploy';
  }
  return {
    format: TICKET_FORMAT, kind, lease_id: id, holder: who, why: because,
    pid, host, host_id: hostId ?? null, process_start: startOf(pid),
    enqueued_at: iso(requested), deadline_at: Number.isFinite(deadline) ? iso(deadline) : null, expires_at,
    repo, run, attempt, job, reservation, request, pool, eta, delivery, claimant_kind,
  };
}

// Why a ticket is dead, or null while it is live, applying AD-3 in order:
//   1. a missing `kind` is a lease (ticketKind), and no kind is ever pruned for being unfamiliar;
//   2. a ticket with a pid is judged by that process, on the same host (sameHost): stale on positive evidence of death (the
//      pid is gone, or now has another start time), never because its start time cannot be read or was never recorded;
//   3. a ticket with no pid is live while its expires_at is in the future;
//   4. one with neither is stale TICKET_ABSENT_MS after enqueued_at (or after its file's mtime when enqueued_at is junk).
// A pid on another host cannot be checked here. A ticket from before this format (no `format`) is pruned, as AD-8 states and
// as staleWaiter always did; a v1 ticket falls through to rules 3 and 4.
export function ticketStaleness(ticket, { now = Date.now, host = hostname(), hostId = machineId(), processStart: startOf = processStart, isAlive = alive, mtimeMs = null } = {}) {
  // kill(0, 0) and kill(-1, 0) succeed (process group, every process), so a pid of 0 or less is no pid: it falls to rules 3 and 4
  // instead of reading as a live process that nothing can ever prove dead.
  if (Number.isSafeInteger(ticket.pid) && ticket.pid > 0) {
    if (sameHost(ticket, { host, host_id: hostId })) {
      if (!isAlive(ticket.pid)) return 'gone';
      const actual = ticket.process_start ? startOf(ticket.pid) : null;
      return actual && actual !== ticket.process_start ? 'pid-reused' : null;
    }
    if (ticket.format === undefined) return 'foreign-host';
  }
  const expires = Date.parse(ticket.expires_at);
  if (Number.isFinite(expires)) return expires > now() ? null : 'expired';
  const enqueued = Date.parse(ticket.enqueued_at);
  const since = Number.isFinite(enqueued) ? enqueued : mtimeMs;
  return Number.isFinite(since) && now() - since < TICKET_ABSENT_MS ? null : 'abandoned';
}

// The waiters for a lock, oldest first. Observers only report stale tickets; acquire prunes them. A prune is unlink-decided (AD-9):
// the unlink that succeeds is the one removal, and only its winner writes a `prune` event (ENOENT: another pruner got there first,
// no event). A call writes at most PRUNE_EVENTS_MAX events however many tickets it removes: the first PRUNE_EVENTS_MAX - 1 each
// (`count` 1) and one more for the rest (`reason: folded`, the sum in `count`), so a reader adds `count`. The removals never wait on
// the log: a failed write is logged and the removal stands.
export function listWaiters(name, { env = process.env, prune = false, now = Date.now, host, hostId, processStart: startOf, isAlive } = {}) {
  const dir = queuePath(name, env);
  let files = [];
  try { files = readdirSync(dir).filter(file => file.endsWith('.json')).sort(); } catch { return []; }
  const seams = { now, ...(host === undefined ? {} : { host }), ...(hostId === undefined ? {} : { hostId }), ...(startOf ? { processStart: startOf } : {}), ...(isAlive ? { isAlive } : {}) };
  const waiters = [];
  const pruned = [];
  // Unlinks one ticket; true for the process whose unlink removed it.
  const remove = (file, ticket, why, at) => {
    try { unlinkSync(join(dir, file)); } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
    pruned.push({ ticket, why, at });
    return true;
  };
  try {
    for (const file of files) {
      let ticket = null;
      try { ticket = JSON.parse(readFileSync(join(dir, file), 'utf8')); } catch { /* being written, or junk */ }
      if (ticket && typeof ticket === 'object' && !Array.isArray(ticket)) {
        let mtimeMs = null;
        if (!Number.isFinite(Date.parse(ticket.enqueued_at))) { try { mtimeMs = statSync(join(dir, file)).mtimeMs; } catch { continue; } }
        const why = ticketStaleness(ticket, { ...seams, mtimeMs });
        if (why) {
          if (prune) remove(file, ticket, why, now());
          else waiters.push({ ...ticket, file, stale: true });
          continue;
        }
        waiters.push({ ...ticket, file, stale: false });
        continue;
      }
      let age = 0;
      try { age = now() - statSync(join(dir, file)).mtimeMs; } catch { continue; }
      if (prune && age > 60_000) remove(file, null, 'unreadable', now());
    }
    if (prune) pruneOrphanNotes(dir, now);
  } finally {
    if (pruned.length > 0) notePruned(name, pruned, { env, hostId });
  }
  return waiters;
}

// A note whose ticket is gone and that nobody read for TICKET_ABSENT_MS (its waiter died) is garbage; removed without an event.
function pruneOrphanNotes(dir, now) {
  let notes = [];
  try { notes = readdirSync(dir).filter(file => file.endsWith('.cancel')); } catch { return; }
  for (const file of notes) {
    try {
      if (existsSync(join(dir, file.slice(0, -'.cancel'.length)))) continue;
      if (now() - statSync(join(dir, file)).mtimeMs > TICKET_ABSENT_MS) rmSync(join(dir, file), { force: true });
    } catch { /* a reader got there first */ }
  }
}

// The `prune` events for the tickets one call removed (see listWaiters). A ticket's claimant is the one its `request` named (the
// subject releaseLease cancels as); an unreadable one has none.
function notePruned(name, pruned, { env, hostId }) {
  const individual = pruned.length > PRUNE_EVENTS_MAX ? PRUNE_EVENTS_MAX - 1 : pruned.length;
  for (const { ticket, why, at } of pruned.slice(0, individual)) {
    let subject = null;
    let waited = null;
    if (ticket) {
      const enqueued = Date.parse(ticket.enqueued_at);
      waited = Number.isFinite(enqueued) ? Math.max(0, at - enqueued) : null;
      const kind = ticketKind(ticket);
      subject = kind === 'job' || kind === 'hub-job'
        ? { kind, repo: ticket.repo ?? null, run: ticket.run ?? null, attempt: ticket.attempt ?? null, job: ticket.job ?? null }
        : { kind: 'lease', lease_id: ticket.lease_id ?? null, holder: ticket.holder ?? null, claimant_kind: ticket.claimant_kind ?? 'agent' };
    }
    const pool = typeof ticket?.pool === 'string' && typeof ticket?.request === 'string' ? { pool: ticket.pool, request: ticket.request } : {};
    note(name, eventOf('prune', name, subject, { count: 1, reason: why, waited_ms: waited, ...pool }), { env, at, hostId });
  }
  if (individual < pruned.length) {
    const at = pruned[pruned.length - 1].at;
    note(name, eventOf('prune', name, null, { count: pruned.length - individual, reason: 'folded' }), { env, at, hostId });
  }
}

// ---- Reservations (AD-7) ----
//
// A run reserves a device when it starts: the gate takes `adb` (when the S26 is in scope), `preflight-ios` takes `mac-ios` on the
// Mac. A Reservation is a directory, never `<name>.lock/owner.json` (AD-2), so an older pinned version's bare `mkdir` of the lock
// sees nothing and listLocks never lists it:
//   <name>.reservations/<owner>--<repo>--<run>/reservation.json   {format, run_key, repo, run, reserved_at, expires_at, grace_ms}
//   <name>.reservations/<owner>--<repo>--<run>/grace.json         {format, grace_started_at}, created once
// Both are created once with `wx`, and their times are absolute: readers use the record and never their own policy (AD-11).
// Liveness is `now < expires_at` and nothing else (no pid or hostname). A released or expired Reservation is renamed to
// `.released-<key>-<ms>` and then deleted by the process whose rename won (AD-9); a late grace stamp then fails with ENOENT.
export const RESERVATION_FORMAT = 1;
export const RESERVABLE = Object.freeze(['adb', 'mac-ios']);
const reservationsPath = (name, env) => join(lockDir(env), `${leaseName(name)}.reservations`);
const RESERVATION_ABSENT_MS = 60_000;

// `<owner>--<repo>--<run>` from the runner's GITHUB_REPOSITORY and GITHUB_RUN_ID, or null when this is not a run (a person at a
// shell reserves nothing). Only characters GitHub allows in a name, so the key is one safe path segment and never starts with `.`.
export function runKey(env = process.env) {
  const parts = String(env.GITHUB_REPOSITORY ?? '').split('/');
  const run = String(env.GITHUB_RUN_ID ?? '');
  if (parts.length !== 2 || !/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(parts[0]) || !/^[A-Za-z0-9._-]+$/.test(parts[1]) || !/^\d{1,20}$/.test(run)) return null;
  return `${parts[0]}--${parts[1]}--${run}`;
}

const readJsonObject = path => {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch { return null; }
};

// One Reservation directory as { key, record, reserved_ms, expires_ms, grace_started_ms }, or null when it holds no readable
// reservation.json (a record being written, or junk). grace_started_ms is null until grace.json exists; a grace.json that does
// not parse yet (being written) counts from its file time.
function readReservation(dir, key) {
  const record = readJsonObject(join(dir, 'reservation.json'));
  const reserved = Date.parse(record?.reserved_at);
  const expires = Date.parse(record?.expires_at);
  if (!record || typeof record.repo !== 'string' || record.run === undefined || record.run === null || !Number.isFinite(reserved) || !Number.isFinite(expires) || !Number.isFinite(record.grace_ms) || record.grace_ms < 0) return null;
  let graceAt = null;
  try {
    const mtime = statSync(join(dir, 'grace.json')).mtimeMs;
    const stamped = Date.parse(readJsonObject(join(dir, 'grace.json'))?.grace_started_at);
    graceAt = Number.isFinite(stamped) ? stamped : mtime;
  } catch { /* no grace yet */ }
  return { key, record, reserved_ms: reserved, expires_ms: expires, grace_started_ms: graceAt };
}

// Every readable Reservation of a name, in line order (reserved_at, then the key), expired ones included.
function readReservations(name, env) {
  const base = reservationsPath(name, env);
  let keys = [];
  try { keys = readdirSync(base).filter(entry => !entry.startsWith('.')).sort(); } catch { return []; }
  return keys.map(key => readReservation(join(base, key), key)).filter(Boolean).sort((a, b) => a.reserved_ms - b.reserved_ms || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

const askingKey = (repo, run) => `${repo}\u0000${run}`;

// Where a run stands: its live Reservation on this name, or null. The place a Job Hold's ticket takes (AD-6).
function ownReservation(name, env, now) {
  const key = runKey(env);
  if (key === null || !isQueued(name) || !RESERVABLE.includes(name)) return null;
  const found = readReservation(join(reservationsPath(name, env), key), key);
  return found && now() < found.expires_ms ? found : null;
}

// The AD-9 event fields every Reservation event carries: what was reserved and until when, so one event is a whole account.
const reservationFields = (found, extra = {}) => ({
  hold_kind: 'reservation', run_key: found.record.run_key ?? found.key, reserved_at: iso(found.reserved_ms), expires_at: iso(found.expires_ms), grace_ms: found.record.grace_ms,
  grace_started_at: iso(found.grace_started_ms), ...extra,
});
const reservationSubject = (record, env = null) => ({ kind: 'job', repo: record.repo, run: String(record.run), attempt: env?.GITHUB_RUN_ATTEMPT ?? null, job: env?.GITHUB_JOB ?? null });

let lastReleased = 0;

// Retires a Reservation: renames its directory to `.released-<key>-<ms>` (inside the reservations directory, so the key can be
// reserved again at once and nothing ever lists it), and only the process whose rename won reads on: it puts the directory back
// when it moved a different Reservation than the one it judged (a rerun reserved again in between), deletes it, and appends
// `as` (`expiry` here, a release in Story 2.6) when the name is Queued and an event is wanted. True for the winner; every
// failure is a false, never a throw, because this runs inside readers. `afterRename` is a test seam, called with the new path.
function retireReservation(name, found, { as = null, reason = null, env = process.env, now = Date.now, hostId, afterRename = () => {} } = {}) {
  const base = reservationsPath(name, env);
  const at = now();
  lastReleased = Math.max(Number.isFinite(at) ? Math.trunc(at) : 0, lastReleased + 1);
  const moved = join(base, `.released-${found.key}-${lastReleased}`);
  try {
    renameSync(join(base, found.key), moved);
  } catch { return false; }
  const taken = readReservation(moved, found.key);
  // A judged record that was unreadable (`record: null`) was junk: anything readable in the moved directory is a Reservation
  // another process made after that judgement, and goes back like any other that was not the one judged.
  const moreThanJudged = found.record ? taken?.record?.reserved_at !== found.record.reserved_at : taken !== null;
  if (moreThanJudged) {
    try { renameSync(moved, join(base, found.key)); } catch { try { rmSync(moved, { recursive: true }); } catch { /* never blocks the key */ } }
    return false;
  }
  afterRename(moved);
  try { rmSync(moved, { recursive: true }); } catch { /* a released directory never blocks the key */ }
  // A release by the run itself names its attempt and job; an expiry (some other run's acquirer) never does.
  const own = as === 'release' && runKey(env) === found.key ? env : null;
  if (as && found.record) note(name, eventOf(as, name, reservationSubject(found.record, own), reservationFields(found, { held_ms: Math.max(0, at - found.reserved_ms), reason })), { env, at, hostId });
  return true;
}

// Releases a run's Reservation of `name` (AD-7): the directory is renamed to `.released-<key>-<ms>` (retireReservation) and the
// process whose rename won appends one `release` event, so a late grace stamp is ENOENT and a rerun can reserve again at once.
// `key` is the run to release (default: this process's own run). Returns { status: 'released' | 'none', key }: none when nothing
// is reserved, the record is unreadable (an owner mid-write is never taken away), or another process released it first. Never
// throws: a release is an optimization and the ceiling ends a Reservation this misses.
export function releaseReservation(name, { env = process.env, now = Date.now, hostId = machineId(), key = null, reason = 'done' } = {}) {
  const run = key ?? runKey(env);
  if (!RESERVABLE.includes(name) || typeof run !== 'string' || run === '' || run.startsWith('.') || run.includes('/')) return { status: 'none', key: run };
  try {
    const found = readReservation(join(reservationsPath(name, env), run), run);
    if (!found) return { status: 'none', key: run };
    return { status: retireReservation(name, found, { as: 'release', reason, env, now, hostId }) ? 'released' : 'none', key: run };
  } catch { return { status: 'none', key: run }; }
}

// Takes a Reservation of `name` for this run, once: `wx` creates reservation.json and only that create appends `claim`. A live
// Reservation of the same run (a rerun) is reused and writes nothing. Returns { status: 'claimed' | 'reused' | 'skipped', key,
// reservation } (skipped when this is not a run). The policy's queue block gives the grace and the ceiling; tests inject it.
export function reserve(name, { env = process.env, now = Date.now, policy = null, hostId = machineId(), log = console.log, wait = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms) } = {}) {
  if (!RESERVABLE.includes(name)) throw new Error(`bad reservation name "${name}" (${RESERVABLE.join(' or ')})`);
  const key = runKey(env);
  if (key === null) return { status: 'skipped', key: null, reservation: null };
  const queue = (policy ?? loadPolicy().policy).queue;
  const base = reservationsPath(name, env);
  const dir = join(base, key);
  for (let round = 0; round < 8; round += 1) {
    mkdirSync(dir, { recursive: true });
    const at = now();
    const record = { format: RESERVATION_FORMAT, run_key: key, repo: env.GITHUB_REPOSITORY, run: String(env.GITHUB_RUN_ID), reserved_at: iso(at), expires_at: iso(at + queue.reservation_ceiling_min * 60_000), grace_ms: queue.grace_min * 60_000 };
    try {
      writeFileSync(join(dir, 'reservation.json'), JSON.stringify(record), { flag: 'wx' });
    } catch (error) {
      // ENOENT: the directory was renamed away between the mkdir and the write; go round and make it again.
      if (error.code === 'ENOENT') continue;
      if (error.code !== 'EEXIST') throw error;
      const found = readReservation(dir, key);
      if (found && now() < found.expires_ms) {
        log(`HUB_RESERVATION_REUSED ${name} ${key} until ${iso(found.expires_ms)}`);
        return { status: 'reused', key, reservation: found.record };
      }
      if (found) { retireReservation(name, found, { as: 'expiry', reason: 'ceiling', env, now, hostId }); continue; }
      // No readable record: another process is writing it right now, or an earlier one died mid-write. Give it a moment, then
      // set a record that never became readable aside.
      let age = 0;
      try { age = now() - statSync(join(dir, 'reservation.json')).mtimeMs; } catch { /* gone: round again */ }
      if (age > RESERVATION_ABSENT_MS) {
        // Only the process whose rename won writes the one `prune`: an unreadable record has no claimant to name.
        if (retireReservation(name, { key, record: null }, { env, now, hostId })) {
          const pruned = now();
          note(name, eventOf('prune', name, null, { hold_kind: 'reservation', run_key: key, count: 1, reason: 'unreadable' }), { env, at: pruned, hostId });
        }
      } else wait(25);
      continue;
    }
    const found = readReservation(dir, key);
    log(`HUB_RESERVATION ${name} ${key} until ${record.expires_at}`);
    if (found) note(name, eventOf('claim', name, reservationSubject(record, env), reservationFields(found)), { env, at, hostId });
    return { status: 'claimed', key, reservation: record };
  }
  throw new Error(`could not reserve ${name} for ${key}: its reservation record never became readable`);
}

// Every Reservation of a name as a plain record, in line order: the record's own keys plus key, live, grace_started_at and
// grace_ends_at (null until its grace starts). Read only; expired ones are listed with live false.
export function listReservations(name, { env = process.env, now = Date.now } = {}) {
  const at = now();
  return readReservations(name, env).map(found => ({
    ...found.record, key: found.key, live: at < found.expires_ms,
    grace_started_at: iso(found.grace_started_ms), grace_ends_at: found.grace_started_ms === null ? null : iso(found.grace_started_ms + found.record.grace_ms),
  }));
}

// One Reservation as a queueView entry (AD-6). Its place in line is its `reserved_at`, written as a ticket's 15-digit millisecond
// prefix so entries sort by one key: at equal milliseconds a ticket comes first, then the key breaks ties. `grace` says where its
// one-time grace stands (pending: not started; running; over), computed from the record and never written here.
function reservationEntry(found, at) {
  const ends = found.grace_started_ms === null ? null : found.grace_started_ms + found.record.grace_ms;
  return {
    ...found.record, kind: 'reservation', file: `${String(found.reserved_ms).padStart(15, '0')}-reservation-${found.key}`, key: found.key,
    run_key: found.record.run_key ?? found.key, holder: `${found.record.repo}#${found.record.run}`, why: 'reservation', lease_id: null,
    enqueued_at: found.record.reserved_at, stale: at >= found.expires_ms, blocking: false,
    grace: { state: ends === null ? 'pending' : at < ends ? 'running' : 'over', started_at: iso(found.grace_started_ms), ends_at: iso(ends) },
  };
}

// The Reservation entries of a view. Past expires_at a Reservation is stale: an acquirer's prune retires it (the winner appends
// `expiry`), and an observer sees it only with includeStale. A Reservation whose run has a live ticket is hidden (`asking`): that
// ticket stands at its place. Only the first Reservation in line blocks, and only until its grace is over.
function reservationEntries(name, { env, now, prune, hostId, asking, includeStale, afterRename }) {
  const at = now();
  const entries = [];
  for (const found of readReservations(name, env)) {
    if (at >= found.expires_ms) {
      if (prune) retireReservation(name, found, { as: 'expiry', reason: 'ceiling', env, now, hostId, afterRename });
      else if (includeStale) entries.push(reservationEntry(found, at));
      continue;
    }
    if (asking.has(askingKey(found.record.repo, String(found.record.run)))) continue;
    entries.push(reservationEntry(found, at));
  }
  const head = entries.find(entry => !entry.stale);
  if (head && head.grace.state !== 'over') head.blocking = true;
  return entries;
}

// A free lock with an unasking Reservation first in line starts that Reservation's one-time grace (AD-7): the first acquirer or
// try that sees it creates grace.json with `wx` and appends `grace`; the others wait until grace_started_at + grace_ms. Only a view
// with a blocking head Reservation whose grace has not started, and only while the lock does not exist, does anything (a try of
// the head's own run, `own`, is that run asking, so it starts nothing). ENOENT (the
// Reservation was released in between) and EEXIST (another observer won) write nothing. Never throws.
function startGrace(name, view, { env, now, hostId, own = null }) {
  const head = view[0];
  if (head?.kind !== 'reservation' || head.stale || !head.blocking || head.grace.state !== 'pending' || head.key === own) return false;
  try {
    if (existsSync(lockPath(name, env))) return false;
    const at = now();
    writeFileSync(join(reservationsPath(name, env), head.key, 'grace.json'), JSON.stringify({ format: RESERVATION_FORMAT, grace_started_at: iso(at) }), { flag: 'wx' });
    const found = { key: head.key, record: { run_key: head.run_key, repo: head.repo, run: head.run, grace_ms: head.grace_ms }, reserved_ms: Date.parse(head.reserved_at), expires_ms: Date.parse(head.expires_at), grace_started_ms: at };
    note(name, eventOf('grace', name, reservationSubject(head), reservationFields(found)), { env, at, hostId });
    return true;
  } catch { return false; }
}

// ---- the one queue view (AD-6) ----
//
// Every caller that needs to know who is ahead, who blocks or what a position is reads it here and never parses tickets
// (AD-1). Entries are the live tickets and the Reservations in order, each the ticket as written plus:
//   file      the ticket's file name (its identity in the Queue); a Reservation's is its reserved_at in the same 15 digits
//   kind      lease, job, hub-job or remote (ticketKind: a missing kind is a lease), or `reservation`
//   place     1-based, in the order returned
//   blocking  whether a Claimant behind it must wait for it: every live ticket blocks; of the Reservations only the first in line
//             does, and only until its grace is over (Reservation entries also carry `key`, `run_key` and `grace`)
//   stale     true for a dead ticket or an expired Reservation, which `includeStale` keeps in the list so read-only status can
//             still show it
// A Reservation whose run has a live ticket is not listed: that ticket stands at its place (its file name carries the
// Reservation's reserved_at). Order is the sort key (a ticket's file name; a Reservation's reserved_at) and then the full name.
// `prune` removes dead tickets and retires expired Reservations, as acquirers do; observers never pass it, and a read computes
// grace but creates nothing (`afterRename` is the test seam of the Reservation prune). `policy` is accepted and unused: a Reservation's record carries its own times (AD-7, AD-11).
const sortKey = entry => entry.file;
const inOrder = (a, b) => (sortKey(a) < sortKey(b) ? -1 : sortKey(a) > sortKey(b) ? 1 : a.file < b.file ? -1 : a.file > b.file ? 1 : 0);

export function queueView(name, { env = process.env, now = Date.now, policy = null, includeStale = false, prune = false, host, hostId, processStart: startOf, isAlive, afterRename } = {}) {
  void policy;
  const tickets = listWaiters(name, { env, prune, now, host, hostId, processStart: startOf, isAlive });
  const asking = new Set(tickets.filter(ticket => !ticket.stale && ticket.repo && ticket.run !== undefined && ticket.run !== null).map(ticket => askingKey(ticket.repo, String(ticket.run))));
  const entries = tickets
    .filter(ticket => includeStale || !ticket.stale)
    .map(ticket => ({ ...ticket, kind: ticketKind(ticket), blocking: !ticket.stale }));
  return [...entries, ...reservationEntries(name, { env, now, prune, hostId, asking, includeStale, afterRename })]
    .sort(inOrder)
    .map((entry, index) => ({ ...entry, place: index + 1 }));
}

// What blocks a Claimant: the blocking entries ahead of its own ticket, or every blocking entry for a try (which has no
// ticket and so no place; it takes a free lock only when nothing waits).
// A try of a run that holds a Reservation is not blocked by it: `own` is that Reservation's key (a ticket never needs it, its run's
// Reservation is hidden while the ticket is live).
const blockersAhead = (view, file = null, own = null) => view.filter(entry => entry.blocking && !(own !== null && entry.kind === 'reservation' && entry.key === own) && (file === null || inOrder(entry, { file }) < 0));

// The AD-5 wording of every timeout on a Queued lock: `host lock <name> is held by <holder>`, then (when a Claimant waits ahead
// of this one) how many and who, each with its place. Callers add what the wait gave up on.
const waiterText = entry => `${entry.place}. ${entry.holder ?? entry.lease_id}${entry.why ? ` (${entry.why})` : ''}`;
export function heldText(name, owner, blockers = [], self = null) {
  const ahead = blockers.length;
  const list = ahead > 0 ? `; ${ahead} waiter${ahead === 1 ? '' : 's'} ahead${self ? ` of ${self}` : ''} (${blockers.map(waiterText).join(', ')})` : '';
  return `host lock ${name} is held by ${describe(owner)}${list}`;
}

// A fresh ticket file name, `<ms15>-<counter6>-<pid8>.json`: minted before the body so the ETA can know the asker's place.
const ticketName = requested => `${String(requested).padStart(15, '0')}-${String(ticketCounter++).padStart(6, '0')}-${String(process.pid).padStart(8, '0')}.json`;

// Writes a ticket into <name>.queue/, write-then-rename so a reader never sees half of it, and returns its file name and path.
// `file` is a name from ticketName, when the caller minted it first.
function writeTicket(name, body, { env, requested, file = ticketName(requested) }) {
  const queue = queuePath(name, env);
  mkdirSync(queue, { recursive: true });
  const path = join(queue, file);
  const pending = `${path}.tmp`;
  writeFileSync(pending, JSON.stringify(body), { flag: 'wx' });
  renameSync(pending, path);
  return { file, path };
}

// The events the ETA reads: the policy window only (`queue.eta_window_days`), read once and never the whole log (AD-18). Throws on a
// bad policy; callers that must not fail catch it.
export function etaHistory({ env = process.env, now, policy }) {
  const days = policy.queue.eta_window_days;
  return [...readEvents({ env, since: now - days * 86_400_000, until: now + 1, log: () => {} })];
}

// The live ETA of every waiter of a Queued lock, for the read-only surfaces (`hub-device status` now, the Hub API later). `view` is a
// queueView (stale entries may be in it), `events` one etaHistory read shared by every waiter. A Map from each live ticket's `file` to
// its eta() (the ticket's own place and deadline), or null when that computation throws. Stale tickets and Reservations get no entry:
// a stale waiter has no ETA and a Reservation is not a waiter. No I/O.
export function waiterEtas({ owner = null, view = [], events = [], policy, now }) {
  const live = view.filter(entry => !entry.stale);
  const etas = new Map();
  for (const entry of live) {
    if (entry.kind === 'reservation') continue;
    let value = null;
    try { value = eta({ owner, view: live, file: entry.file, deadline_at: entry.deadline_at }, events, policy, now); } catch { /* an ETA never fails a read */ }
    etas.set(entry.file, value);
  }
  return etas;
}

// The ETA a waiter is told at enqueue (AD-18, FR-15), for the ticket and the `request` event, so its accuracy can be measured
// later (SM-4). It reads the owner, an observer's view (no prune) and the policy window's events once, then asks eta(). `file`
// is the ticket's minted name, so the asker's place is known before its ticket lands. Never throws and never delays the
// enqueue beyond those reads: any error is a null ETA.
function enqueueEta(name, { file, deadline, env, now, policy = null, host, hostId, processStart: startOf, log = console.log }) {
  try {
    const at = now();
    const settings = policy ?? loadPolicy().policy;
    const owner = readOwner(lockPath(name, env));
    const view = queueView(name, { env, now, host, hostId, processStart: startOf });
    const events = etaHistory({ env, now: at, policy: settings });
    return eta({ owner, view, file, deadline_at: deadline }, events, settings, at);
  } catch (error) {
    // One line, so a broken ETA path is not a silent null on every ticket; a throwing logger never escapes.
    try { log(`HUB_ETA_FAILED ${name} ${String(error?.message ?? error).split('\n')[0]}`); } catch { /* the enqueue goes on */ }
    return null;
  }
}

// How long a waiter trusts the ETA it last computed: past this, the poll recomputes it (the holder's remaining time shrinks as time
// passes), and a position change recomputes it at once (AD-18: the window read is bounded, never run on every 1-2 s poll).
export const ETA_REFRESH_MS = 300_000;

// The wait line of every Queued waiter (FR-16, Story 4.2): `HUB_LOCK_WAIT <name> held by <holder> position=<n> eta=<lo>-<hi>[ low-data]`.
// One reporter serves a Lease (acquireLease) and a deploy job or the catch-up (queuedLock); each calls `report(owner, blockers)` on
// every poll. `position` is the blocking entries ahead + 1. The first poll prints the ETA given at enqueue (`estimate`, no second
// computation). After that the ETA is recomputed only when the position changed since the last computation or ETA_REFRESH_MS has
// passed, and a line prints only when the position changed or the range moved over a minute from the last PRINTED one (etaMoved).
// A failed recompute logs one HUB_ETA_FAILED per waiter and goes on with a null ETA (`eta=?`); the wait never fails because of it.
// `afterEta` is a test seam called once per recompute. `name` is the label the line prints (a Pool request prints its Pool's name);
// `recompute(at, onFail)` replaces the one-lock ETA computation (a Pool request combines its members').
function waitReporter(name, { ticket, deadline, estimate, requested, env, now, policy, host, hostId, processStart: startOf, log, afterEta = () => {}, recompute = null }) {
  const again = recompute ?? ((at, onFail) => enqueueEta(name, { file: ticket, deadline, env, now: () => at, policy, host, hostId, processStart: startOf, log: onFail }));
  let computed = estimate;
  let computedAt = requested;
  let computedPosition = null;
  let printed = null;
  // A null estimate means the enqueue already logged this waiter's HUB_ETA_FAILED: one line per waiter in all.
  let failureLogged = estimate === null;
  const once = line => {
    if (failureLogged) return;
    failureLogged = true;
    log(line);
  };
  return function report(owner, blockers) {
    const position = blockers.length + 1;
    const at = now();
    if (printed === null) {
      computedPosition = position;
    } else if (position !== computedPosition || at - computedAt >= ETA_REFRESH_MS) {
      computed = again(at, once);
      computedAt = at;
      computedPosition = position;
      afterEta();
    }
    if (printed !== null && printed.position === position && !etaMoved(printed.eta, computed)) return;
    printed = { position, eta: computed };
    log(`HUB_LOCK_WAIT ${name} held by ${describe(owner)} position=${position} eta=${formatEta(computed)}`);
  };
}

// A process start read at most once per pid in JOB_POLL_MS: a Mac pass spawns `ps` per ticket otherwise (AD "liveness cost").
function cachedStart(startOf, now, ttlMs = JOB_POLL_MS) {
  const seen = new Map();
  return pid => {
    const at = now();
    const hit = seen.get(pid);
    if (hit && at >= hit.at && at - hit.at < ttlMs) return hit.start;
    const start = startOf(pid);
    seen.set(pid, { at, start });
    return start;
  };
}

// The same cache for a long-lived caller (a service that holds many waits at once): one reader per service, shared by every wait it
// passes it to as `processStart`, so a poll never reads a pid's start more than once per `ttlMs` (AD-44). Real clock and reader by default.
export const cachedProcessStart = ({ startOf = processStart, now = Date.now, ttlMs = JOB_POLL_MS } = {}) => cachedStart(startOf, now, ttlMs);

// A fresh lease id, for a caller that must name its request before the first take (a Pool request).
export const newLeaseId = () => `l-${randomBytes(6).toString('hex')}`;

// ---- Pool requests (AD-4) ----
//
// A Pool request (`phone`, `emulator`) is one request that is served by one of several locks, probed with tries. It writes one
// Pool-level `request` event here, and ends in exactly one of: the `acquire` of the lock a try took (that try is passed
// `tag`, so its own acquire event carries `pool` and `request` and its `waited_ms` runs from this request, never from the
// probe), or a `timeout` or `cancel` written by `settle`. `lock` is null on Pool-level events. A try that took a lock the
// caller then gave back (a phone that was not there) is an acquire and a release, true history, and the request goes on.
// Returns {id, tag, settle(error, {signal})}; settle writes the one ending, once, and is never fatal. No event for a name
// outside the Queued pools (AD-4 names only phone and emulator).
// `eta` (a waiting request's combined ETA, or null) goes on the `request` event; a try passes none and its event has no `eta` key.
export function poolRequest(pool, { id = newLeaseId(), holder, why, forMs = null, waitMs = 0, env = process.env, now = Date.now, hostId = machineId(), eta: told, claimantKind = 'agent', actor = null } = {}) {
  checkClaimantKind(claimantKind);
  const who = checkActor(actor);
  const since = now();
  const deadline = since + waitMs;
  const tag = { name: pool, request: id, since, deadline };
  const subject = { kind: 'lease', lease_id: id, holder: holder ?? null, claimant_kind: claimantKind, repo: env.GITHUB_REPOSITORY ?? null, run: env.GITHUB_RUN_ID ?? null, attempt: env.GITHUB_RUN_ATTEMPT ?? null, job: env.GITHUB_JOB ?? null };
  const write = (event, fields = {}) => {
    const at = now();
    appendEvent(eventOf(event, null, subject, { pool, request: id, for_ms: forMs, deadline_at: iso(deadline), ...(who ? { actor: who } : {}), ...fields }), { env, now: () => at, hostId });
    return at;
  };
  write('request', told === undefined ? {} : { eta: told });
  let ended = false;
  return {
    id,
    tag,
    // A busy or away Pool ends as a timeout (reason `deadline`, or `away` when no phone was there to take), an abort or any
    // other error as a cancel (a request released while it waited says `released`, one cancelRequest took out says `cancelled` and
    // names the canceller).
    settle(error, { signal } = {}) {
      if (ended) return;
      ended = true;
      const waited = at => ({ waited_ms: Math.max(0, at - since) });
      if (error?.code === 'HUB_LOCK_TIMEOUT' || error?.code === 'HUB_PHONE_AWAY') {
        const at = now();
        write('timeout', { ...waited(at), reason: error.code === 'HUB_PHONE_AWAY' ? 'away' : 'deadline', blocked_by: String(error.message ?? '').slice(0, 500) });
      } else {
        const at = now();
        // A request cancelled through cancelRequest names its canceller (error.cancel, read off the note): that actor, and the why it gave.
        const by = error?.code === 'HUB_LEASE_CANCELLED' && error.cancel ? { actor: error.cancel.actor, ...(error.cancel.why ? { why: error.cancel.why } : {}) } : null;
        write('cancel', { ...waited(at), reason: by ? 'cancelled' : signal?.aborted || error?.name === 'AbortError' ? 'aborted' : error?.code === 'HUB_LEASE_CANCELLED' ? 'released' : 'error', ...by });
      }
    },
  };
}

// A Pool request that holds a place in line (AD-33, Story 5.8): one request served by whichever of `members` (lock names, in
// preference order) serves it first. A waiting request (waitMs > 0) mints one ticket file name and writes the identical Lease
// ticket (carrying `pool` and `request`) into every member's queue, so it stands at the same place everywhere and a taker that
// arrives later never jumps it; each pass walks the members in order and takes the first it is served on exactly as acquireLease
// takes a lock (mkdir, owner record, re-check, claim = unlink that member's ticket). A try (waitMs 0) writes no ticket.
//
// `accept(name, record)` decides whether the taken member serves the caller (a phone that must also be found): `{ok: true, value}`
// wins (every other ticket is withdrawn, with no event, and `{name, record, value}` returns); `{ok: false, state}` gives the lock
// back (a `release`, reason `by-id`), records the state and, for a waiting request, writes the ticket back under the same file name
// so the place is kept; a throw gives the lock back if this Lease still holds it and ends the request with that error. When no
// member served and the deadline has passed, `giveUp(states)` (a Map lock -> `held` or the away state) supplies the error; the
// default is HUB_LOCK_TIMEOUT naming each holder. Every way out but a win withdraws every ticket and settles the one Pool-level
// request once (poolRequest), so the log holds one `request` and one `acquire`, `timeout` or `cancel`, plus the true acquire and
// release of a member that was taken and given back. `afterTake` and `beforeWithdraw` are test seams.
export async function acquirePool(pool, members, {
  holder,
  why,
  forMs,
  waitMs = 0,
  id = null,
  holderPid = null,
  env = process.env,
  pollMs = 1000,
  staleMs = 4 * 3600_000,
  log = console.log,
  sleep = realSleep,
  now = Date.now,
  signal,
  hostId = machineId(),
  host = hostname(),
  processStart: startOf = processStart,
  policy = null,
  afterEta = () => {},
  accept = async () => ({ ok: true, value: undefined }),
  giveUp = null,
  afterTake = () => {},
  beforeWithdraw = () => {},
  claimantKind = 'agent',
  actor = null,
} = {}) {
  if (typeof pool !== 'string' || pool === '') throw new Error('a Pool request names its pool');
  checkClaimantKind(claimantKind);
  const who = checkActor(actor);
  if (!Array.isArray(members) || members.length === 0) throw new Error(`Pool ${pool} has no members`);
  const names = members.map(leaseName);
  if (new Set(names).size !== names.length) throw new Error(`Pool ${pool} lists a member twice`);
  if (!(forMs > 0) || forMs > MAX_LEASE_MS) throw new Error(`a lease runs for more than 0 and at most ${MAX_LEASE_MS / 3600_000}h`);
  for (const name of names) {
    const cap = deployTargetCapMs(name, { policy });
    if (cap !== null && forMs > cap) throw failure('HUB_LEASE_TOO_LONG', capText(name, cap));
  }
  if (!holder || !why) throw new Error('a lease names its holder and why');
  const lease_id = id ? leaseId(id) : newLeaseId();
  mkdirSync(lockDir(env), { recursive: true });
  const requested = now();
  const deadline = requested + waitMs;
  const tryOnly = !(waitMs > 0);
  const attempt = env.GITHUB_RUN_ATTEMPT ?? null;
  const job = env.GITHUB_JOB ?? null;
  const file = tryOnly ? null : ticketName(requested);
  const ticketPath = name => join(queuePath(name, env), file);
  // The members whose ticket this request itself unlinked (the claim of a take): withdrawal skips them.
  const claimed = new Set();
  const placed = new Set();
  let body = null;
  let estimate = null;
  if (!tryOnly) {
    estimate = earliest(names.map(name => enqueueEta(name, { file, deadline, env, now: () => requested, policy, host, hostId, processStart: startOf, log })));
    body = buildTicket('lease', { env, requested, deadline, lease_id, holder, why, host, hostId, processStart: startOf, pool, request: lease_id, eta: estimate, claimant_kind: claimantKind });
  }
  // Withdrawing a ticket: renamed to <file>.tomb-<ms>-<pid> (never ending in .json, so no reader lists it) and removed; ENOENT means a
  // release cancelled it first. No event: the request writes its own ending.
  const withdraw = () => {
    for (const name of placed) {
      if (claimed.has(name)) continue;
      try {
        beforeWithdraw(name);
        lastTomb = Math.max(Math.trunc(now()) || 0, lastTomb + 1);
        const path = ticketPath(name);
        const tomb = `${path}.tomb-${lastTomb}-${process.pid}`;
        try { renameSync(path, tomb); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
        rmSync(tomb, { force: true });
      } catch { try { rmSync(ticketPath(name), { force: true }); } catch { /* a stale ticket is pruned by the next acquirer */ } }
    }
    placed.clear();
    // The notes of a cancelRequest: read by now, or never to be (this request is leaving).
    if (file) for (const name of names) dropNote(ticketPath(name));
  };
  let request = null;
  try {
    if (!tryOnly) {
      for (const name of names) {
        writeTicket(name, body, { env, requested, file });
        placed.add(name);
      }
    }
    request = poolRequest(pool, { id: lease_id, holder, why, forMs, waitMs, env, now, hostId, claimantKind, actor: who, ...(tryOnly ? {} : { eta: estimate }) });
    const cancelled = text => cancelledError(`lease ${lease_id} ${text} ${pool}`, file ? names.map(name => readCancelNote(ticketPath(name))).find(Boolean) ?? null : null);
    const view = name => queueView(name, { env, prune: true, now, host, hostId, processStart: startOf });
    const report = tryOnly ? () => {} : waitReporter(pool, {
      ticket: file, deadline, estimate, requested, env, now, policy, host, hostId, processStart: startOf, log, afterEta,
      recompute: (at, onFail) => earliest(names.map(name => enqueueEta(name, { file, deadline, env, now: () => at, policy, host, hostId, processStart: startOf, log: onFail }))),
    });
    const states = new Map();
    const holds = new Map();
    let vanished = 0;

    // One member: take it if it serves this request. Returns the record taken, or null (the member is blocked; states and holds say how).
    const serve = name => {
      const path = lockPath(name, env);
      for (;;) {
        if (file) { try { statSync(ticketPath(name)); } catch { throw cancelled('was released while it waited for'); } }
        const current = view(name);
        if (file && !current.some(entry => entry.file === file)) throw cancelled('lost its place in the queue for');
        let blockers = blockersAhead(current, file);
        if (blockers.length === 0) {
          const started = now();
          const record = {
            pid: process.pid, host, repo: env.GITHUB_REPOSITORY ?? null, run: env.GITHUB_RUN_ID ?? null, started_at: new Date(started).toISOString(),
            kind: 'lease', lease_id, holder, why, expires_at: new Date(started + forMs).toISOString(),
            holder_pid: holderPid, holder_process_start: Number.isSafeInteger(holderPid) ? startOf(holderPid) : null,
            format: OWNER_FORMAT, attempt, job, host_id: hostId, claimant_kind: claimantKind,
          };
          let taken = false;
          try {
            mkdirSync(path);
            record.lock_ino = inodeOf(path);
            writeOwner(path, record);
            taken = true;
          } catch (error) {
            if (error.code !== 'EEXIST') throw error;
          }
          if (taken) {
            afterTake(name);
            blockers = blockersAhead(view(name), file);
            if (blockers.length > 0) {
              retire(name, path, record, { env, now, log, hostId });
              taken = false;
            }
          }
          if (taken) {
            if (file) {
              try {
                unlinkSync(ticketPath(name));
              } catch (error) {
                if (error.code !== 'ENOENT') throw error;
                retire(name, path, record, { env, now, log, hostId });
                throw cancelled('was released while it was being taken for');
              }
              claimed.add(name);
            }
            note(name, eventOf('acquire', name, record, { deadline_at: iso(request.tag.deadline), waited_ms: Math.max(0, started - request.tag.since), pool, request: lease_id, ...(who ? { actor: who } : {}) }), { env, hostId, at: started });
            log(`HUB_LEASE ${name} ${lease_id} until ${record.expires_at}`);
            return record;
          }
          if (blockers.length === 0) {
            const owner = readOwner(path);
            const verdict = staleness(path, owner, { now, staleMs, host, hostId });
            if (verdict && (verdict !== 'gone' || (vanished += 1) <= VANISHED_RETRIES)) {
              if (verdict !== 'gone' && retire(name, path, owner, { as: 'reclaim', reason: verdict, env, now, log, hostId })) log(`HUB_LOCK_RECLAIMED ${name} from ${describe(owner)}`);
              continue;
            }
            states.set(name, 'held');
            holds.set(name, { owner, blockers });
            return null;
          }
        }
        startGrace(name, current, { env, now, hostId });
        states.set(name, 'held');
        holds.set(name, { owner: readOwner(path), blockers });
        return null;
      }
    };

    for (;;) {
      signal?.throwIfAborted();
      if (file) for (const name of names) { try { statSync(ticketPath(name)); } catch { throw cancelled('was released while it waited for'); } }
      states.clear();
      holds.clear();
      for (const name of names) {
        let record = serve(name);
        if (record === null) continue;
        let kept = name;
        // A request that already holds another member keeps that one: the member just taken is the later, and goes back.
        const other = names.find(candidate => {
          if (candidate === name) return false;
          const owner = readOwner(lockPath(candidate, env));
          return isLease(owner) && owner.lease_id === lease_id;
        });
        if (other) {
          releaseLease(name, lease_id, { env, now, reason: 'pool-duplicate', hostId });
          kept = other;
          record = readOwner(lockPath(other, env)) ?? record;
        }
        let verdict;
        try {
          verdict = await accept(kept, record);
        } catch (error) {
          const owner = readOwner(lockPath(kept, env));
          if (isLease(owner) && owner.lease_id === lease_id) releaseLease(kept, lease_id, { env, now, hostId });
          throw error;
        }
        if (verdict?.ok) {
          withdraw();
          return { name: kept, record, value: verdict.value };
        }
        if (!releaseLease(kept, lease_id, { env, now, hostId }).released) throw cancelled('was released while it was being taken for');
        states.set(kept, verdict?.state ?? 'absent');
        // The place is kept: every ticket this pass claimed goes back under its own file name.
        for (const member of new Set([name, kept])) {
          if (file && claimed.has(member)) {
            writeTicket(member, body, { env, requested, file });
            claimed.delete(member);
          }
        }
      }
      if (now() >= deadline) {
        if (giveUp) throw giveUp(new Map(states));
        // AD-5's wording per held member (`host lock <name> is held by ...`), so a Pool timeout reads like every other one.
        const by = names.map(name => (states.get(name) === 'held' ? heldText(name, holds.get(name)?.owner ?? null, holds.get(name)?.blockers ?? [], `lease ${lease_id}`) : `${name} ${states.get(name) ?? 'absent'}`)).join('; ');
        throw failure('HUB_LOCK_TIMEOUT', `${by}; no member of ${pool} was free; gave up after ${Math.round(waitMs / 1000)}s`);
      }
      // The held member with the fewest blockers ahead is where this request stands (the first on a tie).
      let best = null;
      for (const name of names) {
        const hold = holds.get(name);
        if (hold && (best === null || hold.blockers.length < best.blockers.length)) best = hold;
      }
      if (best) report(best.owner, best.blockers);
      await pause(pollMs, { signal, sleep });
    }
  } catch (error) {
    withdraw();
    request?.settle(error, { signal });
    throw error;
  }
}

// A Queued withLock (AD-4, AD-6): the same wait as a Lease's, for a deploy job or the catch-up. A wait writes a `job` or `hub-job`
// ticket (identity from GITHUB_REPOSITORY, GITHUB_RUN_ID, GITHUB_RUN_ATTEMPT, GITHUB_JOB) and takes the lock only when nothing
// that blocks is ahead of it; after the mkdir it reads the view again and gives the lock back by tombstone if something now is.
// `timeoutMs` of 0 or less is a try: no ticket, no event unless it acquires. Events (AD-9) follow acquireLease's: `request` once
// the ticket is in place, `acquire` once the ticket is claimed, and `timeout` or `cancel` once this waiter's own unlink of its
// ticket succeeds. A wait that runs out throws HUB_LOCK_TIMEOUT, wording `host lock <name> is held ...` as before.
async function queuedLock(name, fn, { env, timeoutMs, pollMs, staleMs, log, sleep, now, kind, hostId, host, timers, beforeRetire, afterTake, startOf, policy, deadlineSeams, endsReservation, yieldToLease, timeoutReason, delivery, afterEta }) {
  const tag = delivery ? { delivery } : {};
  const dir = lockDir(env);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${name}.lock`);
  const { me, more } = jobIdentity({ env, host, hostId, kind });
  const asked = { ...me, ...more };
  const seams = { env, hostId };
  const requested = now();
  const tryOnly = !(timeoutMs > 0);
  // A deploy job's wait ends before GitHub's `timeout-minutes` would kill it (AD-12, Story 2.4): the job's deadline, from the
  // policy's queue block and HUB_JOB_TIMEOUT_MINUTES, when it comes sooner than the caller's own timeout. The ticket carries it.
  const limit = kind === 'job' && !tryOnly && jobTimeoutMs(env) !== null ? jobDeadline({ env, policy: policy ?? loadPolicy().policy, now, ...deadlineSeams }) : null;
  const capped = limit !== null && limit.at < requested + timeoutMs ? limit : null;
  const deadline = capped ? Math.max(requested, capped.at) : requested + timeoutMs;
  const start = cachedStart(startOf, now);
  // A request of a run that holds a live Reservation on this name is served at the Reservation's place (AD-6, AD-7): its ticket
  // is named for the Reservation's reserved_at, so it sorts there in every version, and enqueued_at keeps the real time.
  const reserved = ownReservation(name, env, now);
  let ticket = null;
  let ticketFile = null;
  let selfText = 'this job';
  let estimate = null;
  if (!tryOnly) {
    const placed = reserved ? Math.min(requested, reserved.reserved_ms) : requested;
    const named = ticketName(placed);
    estimate = enqueueEta(name, { file: named, deadline, env, now: () => requested, policy, host, hostId, processStart: startOf, log });
    const body = buildTicket(kind, { env, requested, deadline, host, hostId, processStart: startOf, reservation: reserved?.key ?? null, delivery: delivery ?? null, eta: estimate });
    selfText = `${kind === 'hub-job' ? 'catch-up' : 'job'} ${body.lease_id}`;
    ({ file: ticket, path: ticketFile } = writeTicket(name, body, { env, requested: placed, file: named }));
    note(name, eventOf('request', name, asked, { deadline_at: iso(deadline), ...(reserved ? { reservation: reserved.key } : {}), ...tag, eta: estimate }), { ...seams, at: requested });
  }
  let left = false;
  const leave = (as, fields) => {
    try { unlinkSync(ticketFile); } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
    left = true;
    const at = now();
    note(name, eventOf(as, name, asked, { deadline_at: iso(deadline), waited_ms: Math.max(0, at - requested), ...tag, ...fields }), { ...seams, at });
    return true;
  };
  const cancelled = text => failure('HUB_LEASE_CANCELLED', `${selfText} ${text} ${name}`);
  // The error carries the blocking Holds (`owner`, `holds`) so a caller can name them in its own receipt; the event says what the
  // caller's timeout means (`timeoutReason`, `deadline` unless the caller named one) and who held the lock.
  const timedOut = (message, owner, blockers = []) => {
    const error = () => Object.assign(failure('HUB_LOCK_TIMEOUT', message), { owner, holds: holdsOf(owner, blockers) });
    if (tryOnly) return error();
    if (!leave('timeout', { reason: timeoutReason, blocked_by: describe(owner) })) return cancelled('was released while it waited for');
    return error();
  };
  // With `yieldToLease`, a live Lease on the lock ends the wait: the ticket leaves with a cancel event and the caller reads around it.
  const yieldTo = owner => {
    if (!yieldToLease || !isLease(owner) || staleness(path, owner, { now, staleMs: Infinity, host, hostId }) !== null) return;
    if (ticketFile && !leave('cancel', { reason: 'yield-to-lease', blocked_by: describe(owner) })) throw cancelled('was released while it waited for');
    throw yielded(name, owner);
  };
  const view = () => queueView(name, { env, prune: true, now, host, hostId, processStart: start });
  const gaveUp = capped
    ? `gave up after ${Math.round((deadline - requested) / 60_000)} min, ahead of this job's ${Math.round(capped.timeout_ms / 60_000)}-minute timeout. Another deploy is using the device; run again when it finishes.`
    : `gave up after ${Math.round(timeoutMs / 60_000)} min. Another deploy is using the device; run again when it finishes.`;
  if (capped) log(`HUB_LOCK_DEADLINE ${name} wait ends ${iso(deadline)} (job timeout ${Math.round(capped.timeout_ms / 60_000)} min, margin ${Math.round(capped.margin_ms / 60_000)} min, later holds ${Math.round(capped.allowance_ms / 60_000)} min)`);
  // A try has no ticket and no ETA, so it has no wait line.
  const report = tryOnly ? () => {} : waitReporter(name, { ticket, deadline, estimate, requested, env, now, policy, host, hostId, processStart: startOf, log, afterEta });
  let vanished = 0;
  let failed = true;
  let mine = null;
  try {
    for (;;) {
      if (ticketFile) { try { statSync(ticketFile); } catch { throw cancelled('was released while it waited for'); } }
      const current = view();
      if (ticket && !current.some(entry => entry.file === ticket)) throw cancelled('lost its place in the queue for');
      let blockers = blockersAhead(current, ticket, tryOnly ? reserved?.key ?? null : null);
      if (blockers.length === 0) {
        const started = now();
        const record = { ...me, started_at: new Date(started).toISOString(), ...more };
        let taken = false;
        try {
          mkdirSync(path);
          writeOwner(path, record);
          taken = true;
        } catch (error) {
          if (error.code !== 'EEXIST') throw error;
        }
        if (taken) {
          afterTake();
          blockers = blockersAhead(view(), ticket, tryOnly ? reserved?.key ?? null : null);
          if (blockers.length > 0) {
            retire(name, path, record, { env, now, log, hostId, beforeRetire });
            taken = false;
          }
        }
        if (taken) {
          if (ticketFile) {
            try {
              unlinkSync(ticketFile);
            } catch (error) {
              if (error.code !== 'ENOENT') throw error;
              retire(name, path, record, { env, now, log, hostId });
              throw cancelled('was released while it was being taken for');
            }
          }
          left = true;
          note(name, eventOf('acquire', name, record, { deadline_at: iso(deadline), waited_ms: Math.max(0, started - requested), ...tag }), { ...seams, at: started });
          mine = record;
          failed = false;
          break;
        }
        if (blockers.length === 0) {
          const owner = readOwner(path);
          const verdict = staleness(path, owner, { now, staleMs, host, hostId });
          if (verdict && (verdict !== 'gone' || (vanished += 1) <= VANISHED_RETRIES)) {
            // `gone`: see withLock's bare path. Nothing is left to retire; round again.
            if (verdict !== 'gone' && retire(name, path, owner, { as: 'reclaim', reason: verdict, env, now, log, hostId, beforeRetire })) log(`HUB_LOCK_RECLAIMED ${name} from ${describe(owner)}`);
            continue;
          }
          yieldTo(owner);
          if (now() >= deadline) throw timedOut(`${heldText(name, owner)}; ${gaveUp}`, owner);
          report(owner, blockers);
        }
      }
      if (blockers.length > 0) {
        startGrace(name, current, { env, now, hostId, own: tryOnly ? reserved?.key ?? null : null });
        const owner = readOwner(path);
        yieldTo(owner);
        if (now() >= deadline) throw timedOut(`${heldText(name, owner, blockers, selfText)}; ${gaveUp}`, owner, blockers);
        report(owner, blockers);
      }
      await sleep(pollMs);
    }
  } finally {
    // Anything else that ends the wait (an error) leaves the queue as a cancel.
    if (ticketFile) {
      if (failed && !left) {
        try { leave('cancel', { reason: 'error' }); } catch { /* the rmSync below still clears it */ }
      }
      rmSync(ticketFile, { force: true });
    }
  }
  return runHeld(name, path, mine, fn, { env, now, log, hostId, timers, endsReservation, fields: tag });
}

// Takes the lock as a lease and returns the record. Waiters are served first in, first out, through queueView: a waiter
// takes the lock only when nothing that blocks is ahead of its ticket, and after the mkdir it reads the view again; if a
// blocking entry now stands ahead it gives the lock back by tombstone (no event) and keeps waiting (AD-6). Throws code
// HUB_LOCK_TIMEOUT when waitMs passes, HUB_LEASE_CANCELLED when releaseLease removed its place in the queue.
//
// A call with waitMs 0 is a try (AD-6): it writes no ticket, takes the lock only when it is free and nothing blocks (every
// live ticket does), records its acquire, and records nothing at all when it fails. A try carrying `pool` (poolRequest's tag)
// is one probe of a Pool request: its acquire event names the Pool and measures waited_ms from that request.
//
// holderPid, when given, ties the lease to a process: the lease is reclaimed when that process is gone. The queue
// ticket is claimed (unlinked) only after the record is written: a release that removed the ticket first wins, and the
// record is taken back. beforeClaim is a test seam that runs between the two.
//
// Events (AD-9), each written only by the step that decided it: `request` once the ticket is in place, `acquire` once
// the ticket is claimed (or, for a try, once the lock survived the re-check), `timeout` and `cancel` (an abort or an error
// while queued) once this waiter's own unlink of its ticket succeeds. A releaseLease that removes the ticket first records
// the cancel itself.
export async function acquireLease(name, {
  holder,
  why,
  forMs,
  waitMs = 0,
  id = null,
  holderPid = null,
  env = process.env,
  pollMs = 1000,
  staleMs = 4 * 3600_000,
  log = console.log,
  sleep = realSleep,
  now = Date.now,
  signal,
  beforeClaim = () => {},
  afterTake = () => {},
  beforeRetire,
  hostId = machineId(),
  host = hostname(),
  processStart: startOf = processStart,
  pool = null,
  policy = null,
  afterEta = () => {},
  claimantKind = 'agent',
  actor = null,
} = {}) {
  const path = lockPath(name, env);
  checkClaimantKind(claimantKind);
  const who = checkActor(actor);
  const by = who ? { actor: who } : {};
  if (!(forMs > 0) || forMs > MAX_LEASE_MS) throw new Error(`a lease runs for more than 0 and at most ${MAX_LEASE_MS / 3600_000}h`);
  // A Lease on a deploy target may not outlast the Queue's patience (AD-16): refused before it takes a place in line.
  const cap = deployTargetCapMs(name, { policy });
  if (cap !== null && forMs > cap) throw failure('HUB_LEASE_TOO_LONG', capText(name, cap));
  if (!holder || !why) throw new Error('a lease names its holder and why');
  const lease_id = id ? leaseId(id) : newLeaseId();
  mkdirSync(lockDir(env), { recursive: true });
  const requested = now();
  const deadline = requested + waitMs;
  const tryOnly = !(waitMs > 0);
  // A try has no place in line, so it writes no ticket. A waiter writes one, write-then-rename like owner.json, so a reader
  // never sees a half-written ticket.
  let ticket = null;
  let ticketFile = null;
  let estimate = null;
  if (!tryOnly) {
    const named = ticketName(requested);
    estimate = enqueueEta(name, { file: named, deadline, env, now: () => requested, policy, host, hostId, processStart: startOf, log });
    ({ file: ticket, path: ticketFile } = writeTicket(name, buildTicket('lease', { env, requested, deadline, lease_id, holder, why, host, hostId, processStart: startOf, eta: estimate, claimant_kind: claimantKind }), { env, requested, file: named }));
  }
  const attempt = env.GITHUB_RUN_ATTEMPT ?? null;
  const job = env.GITHUB_JOB ?? null;
  const asked = { kind: 'lease', lease_id, holder, claimant_kind: claimantKind, repo: env.GITHUB_REPOSITORY ?? null, run: env.GITHUB_RUN_ID ?? null, attempt, job };
  const seams = { env, hostId };
  const waitedTo = at => ({ for_ms: forMs, deadline_at: iso(deadline), waited_ms: Math.max(0, at - requested) });
  if (!tryOnly) note(name, eventOf('request', name, asked, { for_ms: forMs, deadline_at: iso(deadline), eta: estimate, ...by }), { ...seams, at: requested });
  // Leaves the queue by unlinking its own ticket. True when this waiter's unlink decided it (and recorded `as`); false
  // when the ticket was already gone, which means a release cancelled it and wrote that event.
  let left = false;
  const leave = (as, fields) => {
    try { unlinkSync(ticketFile); } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
    left = true;
    const at = now();
    note(name, eventOf(as, name, asked, { ...waitedTo(at), ...by, ...fields }), { ...seams, at });
    return true;
  };
  const timedOut = (message, owner) => {
    if (tryOnly) return failure('HUB_LOCK_TIMEOUT', message);
    if (!leave('timeout', { reason: 'deadline', blocked_by: describe(owner) })) return cancelled('was released while it waited for');
    return failure('HUB_LOCK_TIMEOUT', message);
  };
  const view = () => queueView(name, { env, prune: true, now, host, hostId, processStart: startOf });
  const cancelled = text => cancelledError(`lease ${lease_id} ${text} ${name}`, ticketFile ? readCancelNote(ticketFile) : null);
  const report = tryOnly ? () => {} : waitReporter(name, { ticket, deadline, estimate, requested, env, now, policy, host, hostId, processStart: startOf, log, afterEta });
  let vanished = 0;
  let failed = true;
  try {
    for (;;) {
      signal?.throwIfAborted();
      if (ticketFile) { try { statSync(ticketFile); } catch { throw cancelled('was released while it waited for'); } }
      let current = view();
      if (ticket && !current.some(entry => entry.file === ticket)) throw cancelled('lost its place in the queue for');
      let blockers = blockersAhead(current, ticket);
      if (blockers.length === 0) {
        const started = now();
        const record = {
          pid: process.pid, host, repo: env.GITHUB_REPOSITORY ?? null, run: env.GITHUB_RUN_ID ?? null, started_at: new Date(started).toISOString(),
          kind: 'lease', lease_id, holder, why, expires_at: new Date(started + forMs).toISOString(),
          holder_pid: holderPid, holder_process_start: Number.isSafeInteger(holderPid) ? startOf(holderPid) : null,
          format: OWNER_FORMAT, attempt, job, host_id: hostId, claimant_kind: claimantKind,
        };
        let taken = false;
        try {
          mkdirSync(path);
          // The directory's inode names this take for every later rewrite (AD-16); an additive key no pinned hub reads.
          record.lock_ino = inodeOf(path);
          writeOwner(path, record);
          taken = true;
        } catch (error) {
          if (error.code !== 'EEXIST') throw error;
        }
        if (taken) {
          // The re-check (AD-6): a blocking entry that appeared ahead between the view and the mkdir takes the place.
          // afterTake is a test seam that runs between the mkdir and the re-check.
          afterTake();
          blockers = blockersAhead(view(), ticket);
          if (blockers.length > 0) {
            retire(name, path, record, { env, now, log, hostId, beforeRetire });
            taken = false;
          }
        }
        if (taken) {
          beforeClaim();
          if (ticketFile) {
            try {
              unlinkSync(ticketFile);
            } catch (error) {
              if (error.code !== 'ENOENT') throw error;
              retire(name, path, record, { env, now, log });
              throw cancelled('was released while it was being taken for');
            }
          }
          left = true;
          const tag = pool ? { pool: pool.name, request: pool.request } : {};
          const waitedMs = Math.max(0, started - (pool?.since ?? requested));
          note(name, eventOf('acquire', name, record, { deadline_at: iso(pool?.deadline ?? deadline), waited_ms: waitedMs, ...tag, ...by }), { ...seams, at: started });
          log(`HUB_LEASE ${name} ${lease_id} until ${record.expires_at}`);
          failed = false;
          return record;
        }
        if (blockers.length === 0) {
          const owner = readOwner(path);
          const verdict = staleness(path, owner, { now, staleMs, host, hostId });
          if (verdict && (verdict !== 'gone' || (vanished += 1) <= VANISHED_RETRIES)) {
            // `gone`: see withLock. Nothing is left to retire; round again.
            if (verdict !== 'gone' && retire(name, path, owner, { as: 'reclaim', reason: verdict, env, now, log, hostId, beforeRetire })) log(`HUB_LOCK_RECLAIMED ${name} from ${describe(owner)}`);
            continue;
          }
          if (now() >= deadline) throw timedOut(`${heldText(name, owner)}; gave up after ${Math.round(waitMs / 1000)}s`, owner);
          report(owner, blockers);
        }
      }
      if (blockers.length > 0) {
        startGrace(name, current, { env, now, hostId });
        if (now() >= deadline) { const owner = readOwner(path); throw timedOut(`${heldText(name, owner, blockers, `lease ${lease_id}`)}; gave up after ${Math.round(waitMs / 1000)}s`, owner); }
        report(readOwner(path), blockers);
      }
      await pause(pollMs, { signal, sleep });
    }
  } finally {
    // Anything else that ends the wait (an abort, an error) leaves the queue as a cancel.
    if (ticketFile) {
      if (failed && !left) {
        try { leave('cancel', { reason: signal?.aborted ? 'aborted' : 'error' }); } catch { /* the rmSync below still clears it */ }
      }
      rmSync(ticketFile, { force: true });
      dropNote(ticketFile);
    }
  }
}

// Releases a lease by id (the lease of a waiter that has not been served yet is cancelled). Never touches a job's lock,
// another holder's lease or a lock that has moved on. Returns {released, cancelled, reason}. A release writes one
// `release` event (`reason`, else `by-id`, or `any` when no id was given); each waiter it cancels, one `cancel` event
// (reason `released`), written because this unlink of the ticket decided it.
export function releaseLease(name, id, { env = process.env, now = Date.now, reason = null, hostId, actor = null } = {}) {
  const path = lockPath(name, env);
  const who = checkActor(actor);
  const by = who ? { actor: who } : {};
  let cancelled = 0;
  if (id) {
    const dir = queuePath(name, env);
    let files = [];
    try { files = readdirSync(dir); } catch { /* no queue */ }
    for (const file of files) {
      try {
        const ticket = JSON.parse(readFileSync(join(dir, file), 'utf8'));
        if (ticket.lease_id !== id) continue;
        unlinkSync(join(dir, file));
        cancelled += 1;
        // A Pool request's ticket (`pool` and `request` strings) is one of several; the request writes its own one `cancel`.
        if (typeof ticket.pool === 'string' && typeof ticket.request === 'string') continue;
        const at = now();
        const enqueued = Date.parse(ticket.enqueued_at);
        // A job's or the catch-up's ticket cancels as that job (the claimant its own `request` named, lease_id null as for every
        // job event), never as a Lease: a reader that pairs request and cancel by claimant sees one waiter.
        const kind = ticketKind(ticket);
        const subject = kind === 'job' || kind === 'hub-job'
          ? { kind, repo: ticket.repo ?? null, run: ticket.run ?? null, attempt: ticket.attempt ?? null, job: ticket.job ?? null }
          : { kind: 'lease', lease_id: id, holder: ticket.holder ?? null, claimant_kind: ticket.claimant_kind ?? 'agent' };
        note(name, eventOf('cancel', name, subject, { waited_ms: Number.isFinite(enqueued) ? Math.max(0, at - enqueued) : null, reason: 'released', ...by }), { env, at, hostId });
      } catch { /* gone, or being written */ }
    }
  }
  const owner = readOwner(path);
  if (!owner) {
    let exists = true;
    try { statSync(path); } catch { exists = false; }
    return { released: false, cancelled, reason: exists ? 'unknown-holder' : 'none' };
  }
  if (!isLease(owner)) return { released: false, cancelled, reason: 'not-a-lease' };
  if (id && owner.lease_id !== id) return { released: false, cancelled, reason: 'other-lease', owner };
  // A record whose ticket this call just cancelled was being taken: its taker never acquired it and gives it back, so
  // the cancel above is its whole history and the retire records nothing.
  const as = cancelled > 0 && id ? null : 'release';
  if (!retire(name, path, owner, { as, reason: reason ?? (id ? 'by-id' : 'any'), fields: by, env, now, hostId })) return { released: false, cancelled, reason: 'changed' };
  return { released: true, cancelled, reason: 'released', owner };
}

// Takes a waiting request out of the line (Story 7.5): `lease_id`'s ticket on `name`, or, for a Pool request (its ticket carries
// `pool` and `request`), its ticket in every member's queue. The one writer of the other half of a waiter's ending: it leaves the
// attribution note (see readCancelNote) before it unlinks, so the waiter's own failure names `actor`; a request on a single lock
// then ends with one lock-level `cancel` event written here (the unlink decided it, as in releaseLease), and a Pool request with
// none, because its own settle writes the one Pool ending. It never touches an owner record: a request that already holds a lock is
// `held`, not cancelled.
// `pool` narrows what may be cancelled: undefined takes the ticket as it is, a string only a request of that Pool, null only a
// request on one lock; a ticket that does not fit is `none`, as is an id with no ticket.
// Returns {cancelled: true, pool, request, locks} (the locks it removed a ticket from) or {cancelled: false, reason}: `none` (no
// such waiter), `gone` (it was granted or withdrew between the find and the unlink) or `held` (it holds a lock). Throws
// HUB_DEVICE_JOB_ID for a job's id or ticket and HUB_CANCEL_RESERVATION for a Reservation key (deploy jobs are cancelled through
// GitHub, a Reservation is force-released), both before anything is written; TypeError without an actor.
export function cancelRequest(name, lease_id, { actor, why = null, pool, env = process.env, now = Date.now, hostId = machineId() } = {}) {
  const who = checkActor(actor);
  if (!who) throw new TypeError('a cancel names its actor ({holder, via})');
  if (why !== null && typeof why !== 'string') throw new TypeError('why must be a string');
  if (typeof lease_id !== 'string' || lease_id === '') throw new TypeError('a cancel names the request id');
  leaseName(name);
  const jobTicket = () => Object.assign(failure('HUB_DEVICE_JOB_ID', `${lease_id} is a deploy job, not a Lease request: cancel it through GitHub`), { id: lease_id });
  if (lease_id.startsWith('job:')) throw jobTicket();
  if (readReservations(name, env).some(found => found.key === lease_id)) {
    throw Object.assign(failure('HUB_CANCEL_RESERVATION', `${lease_id} is a Reservation on ${name}, not a queued request: force-release it`), { id: lease_id });
  }
  const none = { cancelled: false, reason: 'none' };
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(lease_id)) return none;
  // The ticket of this id in a queue directory, read raw (a stale ticket is a request too), with the lock's name.
  const ticketIn = lock => {
    const dir = queuePath(lock, env);
    let files = [];
    try { files = readdirSync(dir).filter(file => file.endsWith('.json')).sort(); } catch { return null; }
    for (const file of files) {
      try {
        const ticket = JSON.parse(readFileSync(join(dir, file), 'utf8'));
        if (ticket?.lease_id === lease_id) return { name: lock, file, path: join(dir, file), ticket };
      } catch { /* gone, or being written */ }
    }
    return null;
  };
  const holds = lock => { const owner = readOwner(lockPath(lock, env)); return isLease(owner) && owner.lease_id === lease_id; };
  // Every lock name with a queue or a lock directory here, and whether the request holds any of them.
  const lockNames = () => { try { return [...new Set(readdirSync(lockDir(env)).filter(entry => /^[a-z0-9-]+\.(queue|lock)$/.test(entry)).map(entry => entry.replace(/\.(queue|lock)$/, '')))]; } catch { return []; } };
  const anyHolds = () => lockNames().some(holds);
  const first = ticketIn(name);
  if (!first) return holds(name) ? { cancelled: false, reason: 'held' } : none;
  const kind = ticketKind(first.ticket);
  if (kind === 'job' || kind === 'hub-job') throw jobTicket();
  const tagged = typeof first.ticket.pool === 'string' && typeof first.ticket.request === 'string';
  if (pool !== undefined && (pool === null ? tagged : first.ticket.pool !== pool)) return none;
  let targets = [first];
  if (tagged) {
    // Every member's queue holds the identical ticket (same file name); a member the request took has none, and holds it instead.
    if (anyHolds()) return { cancelled: false, reason: 'held' };
    targets = lockNames().map(ticketIn).filter(found => found && found.ticket.pool === first.ticket.pool && found.ticket.request === first.ticket.request);
    if (!targets.some(found => found.name === name)) targets.unshift(first);
  }
  const removed = [];
  for (const target of targets) {
    writeFileAtomic(cancelNotePath(target.path), JSON.stringify({ format: CANCEL_NOTE_FORMAT, cancel: { actor: who, why, at: iso(now()) } }));
    try {
      unlinkSync(target.path);
    } catch (error) {
      // Granted or withdrawn first: the waiter owns that ending, and no note of ours may outlive it.
      dropNote(target.path);
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    removed.push(target);
  }
  if (removed.length === 0) return { cancelled: false, reason: 'gone' };
  if (tagged) {
    if (anyHolds()) return { cancelled: false, reason: 'held' };
  } else {
    const at = now();
    const enqueued = Date.parse(first.ticket.enqueued_at);
    const subject = { kind: 'lease', lease_id, holder: first.ticket.holder ?? null, claimant_kind: first.ticket.claimant_kind ?? 'agent' };
    note(name, eventOf('cancel', name, subject, { waited_ms: Number.isFinite(enqueued) ? Math.max(0, at - enqueued) : null, reason: 'cancelled', actor: who, ...(why ? { why } : {}) }), { env, at, hostId });
  }
  return { cancelled: true, pool: tagged ? first.ticket.pool : null, request: tagged ? first.ticket.request : null, locks: removed.map(target => target.name) };
}

// Changes the lease record this id holds: metadata (the phone's adb id once connected) or an earlier expiry. Never a later one
// (AD-16: only extendLease moves expires_at later, and only while nobody waits): that throws HUB_LEASE_EXTEND_REFUSED and writes
// nothing. False when the lock is gone, being taken, or another holder rewrote it between the read and the write. Throws
// HUB_LEASE_LOST when another Lease or a job holds the lock now, or the directory is not the one this writer took (`ino`, the
// `lock_ino` of the record acquireLease returned).
export function updateLease(name, id, fields, { env = process.env, ino = null } = {}) {
  const path = lockPath(name, env);
  const current = ownLease(name, path, id, ino);
  if (!current) return false;
  if (fields && Object.hasOwn(fields, 'expires_at')) {
    const next = Date.parse(fields.expires_at);
    if (!(next <= expiresAt(current))) throw failure('HUB_LEASE_EXTEND_REFUSED', `lease ${id} on ${name}: updateLease never moves the expiry later; only extendLease does, and only while nobody waits`);
  }
  try {
    if (!rewriteOwner(name, path, id, ino, { ...current, ...fields })) return false;
  } catch (error) {
    if (error.code === 'HUB_LEASE_LOST') throw error;
    return false;
  }
  return readOwner(path)?.lease_id === id;
}

// The Claimants waiting behind the Lease `id` holds on `name`, read only (AD-34): `own` is the lock's own queue (Pool tickets
// included), `gate` the `emulator` gate for an `emulator-<n>` slot (its live holder is next, then its queue). The extender's own
// ticket and a Pool ticket whose request already holds a member are served, so they do not count. Writes nothing: no prune, no
// grace, no event.
export function waitersBehind(name, id, { env = process.env, now = Date.now, hostId, host, processStart: startOf } = {}) {
  let holding = null;   // lease ids that hold a lock other than the gate, read once and only when a Pool request is seen
  const holdsMember = request => {
    holding ??= new Set(listLocks({ env, now, host, hostId })
      .filter(lock => lock.name !== EMULATOR_POOL && lock.kind === 'lease' && !lock.stale)
      .map(lock => lock.owner.lease_id));
    return holding.has(request);
  };
  const served = entry => entry.lease_id === id || (typeof entry.pool === 'string' && typeof entry.request === 'string' && holdsMember(entry.request));
  const view = lock => queueView(lock, { env, now, hostId, host, processStart: startOf }).filter(entry => entry.blocking && !served(entry));
  const own = view(name);
  if (!/^emulator-\d+$/.test(name)) return { own, gate: [] };
  const holder = liveLease(EMULATOR_POOL, { env, now, host, hostId });
  const shift = holder ? 1 : 0;
  const gate = [];
  if (holder && holder.lease_id !== id && !holdsMember(holder.lease_id)) gate.push({ place: 1, holder: holder.holder, lease_id: holder.lease_id, why: holder.why });
  for (const entry of view(EMULATOR_POOL)) gate.push({ ...entry, place: entry.place + shift });
  return { own, gate };
}

// Extends the Lease `id` holds on `name` by `forMs` past its current expiry (AD-16), the only path that moves expires_at later.
// Refused with HUB_LEASE_EXTEND_REFUSED, writing nothing:
//   - at or after its expiry (a Lease that ran out is over, take a new one);
//   - while any entry in the Queue that blocks is waiting (the message names each with its place; a Reservation past its grace does
//     not block, queueView says so);
//   - when the Lease would then run past the cap: the policy's deploy-target cap on adb and mac-ios, MAX_LEASE_MS elsewhere, both
//     counted from started_at.
// Every refusal carries a `reason`: expired, waiters, cap or too-long. `override: {actor, why}` skips the waiters check and nothing
// else (never the expiry check, the deploy-target cap or the 48 h limit); `actor` is who asked, recorded on the event.
// Throws HUB_LEASE_LOST when the lock is not this Lease's any more. On success it appends one `extend` event (the rewrite decided it,
// with `actor`, and for an override `why`, plus `reason: override` when it skipped waiters) and returns the new record.
export function extendLease(name, id, { forMs, env = process.env, now = Date.now, policy = null, hostId = machineId(), host, processStart: startOf, ino = null, actor = null, override = null } = {}) {
  if (!(forMs > 0) || !Number.isFinite(forMs)) throw new Error('an extension is for more than 0 ms');
  // An override skips the waiters check and nothing else; it names who did it and why (a caller bug, TypeError, when it does not).
  let overridden = null;
  if (override !== null && override !== undefined) {
    const by = override && typeof override === 'object' && !Array.isArray(override) ? checkActor(override.actor) : null;
    if (!by || typeof override.why !== 'string' || override.why.trim() === '') throw new TypeError('an override is {actor: {holder, via}, why: non-empty string}');
    overridden = { actor: by, why: override.why };
  }
  const who = overridden?.actor ?? checkActor(actor);
  const path = lockPath(name, env);
  const current = ownLease(name, path, id, ino);
  if (!current) throw lost(name, id, 'nothing holds the lock');
  const at = now();
  const expiry = expiresAt(current);
  if (!(expiry > at)) throw refusal('expired', `lease ${id} on ${name} ${Number.isFinite(expiry) ? `ran out at ${current.expires_at}` : 'has no expiry'}; an expired lease cannot be extended, take a new one`);
  const { own, gate } = waitersBehind(name, id, { env, now, hostId, host, processStart: startOf });
  const count = own.length + gate.length;
  const skipped = count > 0 && overridden !== null;
  if (count > 0 && !skipped) {
    const groups = [...(own.length > 0 ? [own.map(waiterText).join(', ')] : []), ...(gate.length > 0 ? [`in the emulator line ${gate.map(waiterText).join(', ')}`] : [])];
    throw refusal('waiters', `lease ${id} on ${name} cannot be extended while ${count} waiter${count === 1 ? '' : 's'} wait${count === 1 ? 's' : ''}: ${groups.join('; ')}`);
  }
  const started = Date.parse(current.started_at);
  const next = expiry + forMs;
  const total = next - (Number.isFinite(started) ? started : at);
  const cap = deployTargetCapMs(name, { policy });
  if (cap !== null && total > cap) throw refusal('cap', `lease ${id} on ${name} would run ${Math.ceil(total / 60_000)} min in total; ${capText(name, cap)}`);
  if (total > MAX_LEASE_MS) throw refusal('too-long', `lease ${id} on ${name} would run more than ${MAX_LEASE_MS / 3600_000}h in total, the longest a lease runs`);
  const record = { ...current, expires_at: iso(next) };
  if (!rewriteOwner(name, path, id, ino, record)) throw lost(name, id, 'the lock is gone');
  // The event says who did it; an override also says why, and `reason: override` only when it skipped waiters that were there.
  const fields = { ...(who ? { actor: who } : {}), ...(overridden ? { why: overridden.why } : {}), ...(skipped ? { reason: 'override' } : {}) };
  note(name, eventOf('extend', name, record, fields), { env, at: now(), hostId });
  return record;
}

// ---- who held a lock (AD-9 `refused`, Story 3.4, FR-30) ----

// The most Lease holders a `refused` event names; the rest are counted in `installed_by_more`, so the line stays under 4 KiB.
export const REFUSED_NAMES_MAX = 10;
const CLIP_MAX = 64;
const clip = value => (typeof value === 'string' ? value.slice(0, CLIP_MAX) : null);
const msOf = value => (typeof value === 'number' ? value : Date.parse(value));
const LEASE_EVENTS = Object.freeze(['acquire', 'extend', 'release', 'reclaim', 'force-release']);
const LEASE_ENDS = Object.freeze(['release', 'reclaim', 'force-release']);

// Every Lease that held `name` at any moment from `since` (ms or ISO) until now, read from the Event Log, in log order, as plain
// data for an event or a log line (never public): [{holder, lease_id, acquired_at}]. A hold opens at its `acquire` (or at the first
// event seen for a Lease whose acquire is not in the window) and closes at its release, reclaim or force-release; it ends no later
// than its latest `expires_at`, as heldMs does, so an expired Lease nobody reclaimed is not a holder past its expiry. The log is read
// MAX_LEASE_MS before `since`, so a Lease that began earlier and still held at `since` is found. Throws on an unreadable `since`;
// a read error inside the log is the log's own (readEvents skips what it cannot parse).
export function leaseHoldersSince(name, since, { env = process.env, log = console.error } = {}) {
  const from = msOf(since);
  if (!Number.isFinite(from)) throw new TypeError('since must be a date');
  const holds = [];
  const open = new Map();
  for (const event of readEvents({ env, since: from - MAX_LEASE_MS, log })) {
    if (event.lock !== name || event.hold_kind !== 'lease' || !event.lease_id || !LEASE_EVENTS.includes(event.event)) continue;
    const id = event.lease_id;
    const at = Date.parse(event.ts);
    let hold = open.get(id);
    if (event.event === 'acquire' || !hold) {
      // A hold whose acquire is older than the read has no known start: acquired_at is null, never the later event's time.
      hold = { holder: event.claimant?.holder ?? null, lease_id: id, acquired_at: event.event === 'acquire' ? event.ts : null, expires: Infinity, ended: Infinity };
      open.set(id, hold);
      holds.push(hold);
    }
    const expiry = Date.parse(event.expires_at);
    if (Number.isFinite(expiry)) hold.expires = event.event === 'acquire' ? expiry : Math.max(Number.isFinite(hold.expires) ? hold.expires : -Infinity, expiry);
    if (LEASE_ENDS.includes(event.event)) {
      hold.ended = at;
      open.delete(id);
    }
  }
  return holds.filter(hold => Math.min(hold.ended, hold.expires) >= from).map(({ holder, lease_id, acquired_at }) => ({ holder, lease_id, acquired_at }));
}

// The `timeout` event with `reason: delivery-pending` that the deploy of `repo#run` wrote on `name` (Story 3.2): the last one, or
// null. `since` bounds the read (ms or ISO).
export function deliveryPendingEvent(name, { repo, run }, { env = process.env, since, log = console.error } = {}) {
  let found = null;
  for (const event of readEvents({ env, ...(since === undefined ? {} : { since }), log })) {
    if (event.event === 'timeout' && event.lock === name && event.reason === 'delivery-pending'
      && event.claimant?.repo === repo && String(event.claimant?.run) === String(run)) found = event;
  }
  return found;
}

// Appends the one `refused` event (AD-9): the catch-up found a newer build installed than the pending one and left it alone.
// `installedBy` is leaseHoldersSince's list (the first REFUSED_NAMES_MAX are named, the rest counted; none is the string
// 'unknown'); `since` and `from` say where the window began (`pending-event` or `latest.json`). The claimant is the caller as a
// `hub-job`. True when the line was written; false for a name that is not Queued or a failed write (the Event Log is never fatal).
export function noteRefused(name, { delivery = null, installed, installedBy = [], since, from }, { env = process.env, now = Date.now, hostId = machineId(), host = hostname() } = {}) {
  checkDelivery(delivery);
  const holders = Array.isArray(installedBy) ? installedBy : [];
  const named = holders.slice(0, REFUSED_NAMES_MAX).map(hold => ({ holder: clip(hold.holder), lease_id: clip(hold.lease_id), acquired_at: hold.acquired_at ?? null }));
  const { me, more } = jobIdentity({ env, host, hostId, kind: 'hub-job' });
  const at = now();
  return note(name, eventOf('refused', name, { ...me, ...more, started_at: iso(at) }, {
    reason: 'newer-installed',
    ...(delivery ? { delivery } : {}),
    installed: clip(installed),
    installed_by: named.length > 0 ? named : 'unknown',
    ...(holders.length > REFUSED_NAMES_MAX ? { installed_by_more: holders.length - REFUSED_NAMES_MAX } : {}),
    pending_since: iso(msOf(since)),
    pending_from: from ?? null,
  }), { env, at, hostId });
}

// Every lock in the directory, read only: leases and jobs' locks, each with whether it is stale now.
export function listLocks({ env = process.env, now = Date.now, staleMs = 4 * 3600_000, host, hostId } = {}) {
  const dir = lockDir(env);
  let entries = [];
  try { entries = readdirSync(dir).filter(entry => entry.endsWith('.lock')).sort(); } catch { return []; }
  return entries.map(entry => {
    const path = join(dir, entry);
    const owner = readOwner(path);
    return { name: entry.slice(0, -'.lock'.length), kind: isLease(owner) ? 'lease' : 'lock', owner, stale: stale(path, owner, { now, staleMs, ...(host === undefined ? {} : { host }), ...(hostId === undefined ? {} : { hostId }) }), describe: describe(owner) };
  });
}
