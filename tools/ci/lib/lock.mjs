// Host locks. Three apps share one S26, one iPad and one Mac, and each app has its own runners, so per-repo
// concurrency groups cannot stop two deploys from talking to the same device at once. A lock is a directory
// (mkdir is atomic on both hosts) holding the owner's pid, run and start time. A holder that died without
// releasing (a job killed at its timeout) is reclaimed when its pid is gone; waiting has a deadline.
//
// A lease is the same lock taken by a person or an agent instead of a job: acquire returns and the lock persists past the
// process that took it, until release or `expires_at`. It lives in the same directory under the same name (`adb` is the
// S26), so withLock callers and leases exclude each other both ways. Waiters for a lease queue FIFO in `<name>.queue/`.
//
// Removal is exactly once (AD-9): a release or reclaim renames `<name>.lock` to a tomb, and only the process whose rename
// succeeded deletes it and records the event in the Event Log (events.mjs). This module is the only caller of appendEvent.
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { join } from 'node:path';
import { appendEvent, hostId as machineId } from './events.mjs';
import { pause, sleep as realSleep } from './pause.mjs';

export const lockDir = (env = process.env, home = homedir()) => env.HUB_LOCK_DIR || join(home, '.cache/mobile-deploy-hub/locks');

// The Queued set (AD-4): the device locks whose transitions are history. `emulator` is the pool gate; its slots are
// `emulator-<n>`. Every other name (s3-*, s3-index, emulator-reaper) writes no events.
export const QUEUED = Object.freeze(['adb', 's24', 'mac-ios', 'emulator']);
export const isQueued = name => QUEUED.includes(name) || /^emulator-\d+$/.test(name);

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

const describe = owner => {
  if (!owner) return 'an unknown holder';
  if (isLease(owner)) return `lease ${owner.lease_id} of ${owner.holder ?? 'someone'}${owner.why ? ` (${owner.why})` : ''} until ${owner.expires_at}`;
  return `${owner.repo ?? 'a local run'} run ${owner.run ?? '-'} (pid ${owner.pid}, since ${owner.started_at})`;
};

// Stale: a job whose pid is gone or that outlived staleMs; a lease past its expires_at or whose holder_pid (when it
// names one) is gone or is now another process (holder_process_start differs). A lease is not judged by pid (the
// process that took it is long gone) or by age. Returns why (`gone`, `abandoned`, `expired`, `holder-gone`, `too-old`),
// or null while the lock is live.
function staleness(path, owner, { now, staleMs }) {
  let age = 0;
  try { age = now() - statSync(path).mtimeMs; } catch { return 'gone'; }
  // owner.json is written right after mkdir; a lock without one for a minute was abandoned mid-creation.
  if (!owner) return age > 60_000 ? 'abandoned' : null;
  if (Number.isFinite(expiresAt(owner))) {
    if (expiresAt(owner) <= now()) return 'expired';
    if (owner.host !== hostname() || !Number.isSafeInteger(owner.holder_pid)) return null;
    if (!alive(owner.holder_pid)) return 'holder-gone';
    return owner.holder_process_start && processStart(owner.holder_pid) !== owner.holder_process_start ? 'holder-gone' : null;
  }
  if (owner.host === hostname() && Number.isSafeInteger(owner.pid) && !alive(owner.pid)) return 'holder-gone';
  return age > staleMs ? 'too-old' : null;
}
const stale = (path, owner, options) => staleness(path, owner, options) !== null;

const sameOwner = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const iso = ms => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);

// The AD-9 event body for a hold or a request. `subject` is an owner record, or the would-be owner of a request (a Lease:
// kind 'lease', lease_id, holder; a job: its owner without started_at). A Lease is taken by an agent (v1a has no person
// surface), a withLock job by a deploy run unless it says `hub-job` (the catch-up). An owner from before v1a (no kind) is a
// deploy job. for_ms and expires_at describe a Lease; `fields` fills or overrides the rest.
function eventOf(event, name, subject, fields = {}) {
  const lease = isLease(subject);
  const forMs = expiresAt(subject) - Date.parse(subject?.started_at);
  return {
    event, lock: name, hold_kind: subject ? (lease ? 'lease' : 'job') : null,
    claimant: {
      kind: subject ? (lease ? 'agent' : subject.kind === 'hub-job' ? 'hub-job' : 'deploy') : null,
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

// Appends one event for a Queued name, at `at`; every other name writes nothing (AD-4). Never throws (appendEvent).
function note(name, body, { env, at, hostId }) {
  if (isQueued(name)) appendEvent(body, { env, now: () => at, hostId });
}

let lastTomb = 0;

// Retires a lock: renames <name>.lock to <name>.lock.tomb-<ms>-<pid> (a name that never ends in .lock, so it never blocks
// the lock name, not even for an older pinned version's bare mkdir, and listLocks never lists it). The rename decides
// (AD-9): ENOENT means another process got there first, and the loser writes nothing. A tomb that holds anything but
// the owner that was judged means the lock changed hands after the judgement; it is put back. Only the winner deletes
// its tomb and, when `as` names an event and the name is Queued, appends it. True for the winner. beforeRetire is a test
// seam, called with 'rename' before the rename and 'restore' before a put-back.
function retire(name, path, judged, { as = null, reason = null, env = process.env, now = Date.now, log = console.error, hostId, beforeRetire = () => {} } = {}) {
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
    note(name, eventOf(as, name, judged, { held_ms: heldMs(judged, at), reason, ...lastAlive }), { env, at, hostId });
  }
  return true;
}

export async function withLock(name, fn, {
  env = process.env,
  timeoutMs = 15 * 60_000,
  pollMs = 2000,
  staleMs = 4 * 3600_000,
  log = console.log,
  sleep = ms => new Promise(done => setTimeout(done, ms)),
  now = Date.now,
  kind = 'job',
  hostId = machineId(),
  timers = { setInterval, clearInterval },
  beforeRetire,
} = {}) {
  if (!/^[a-z0-9-]+$/.test(name)) throw new Error(`bad lock name "${name}"`);
  if (kind !== 'job' && kind !== 'hub-job') throw new Error(`bad lock holder kind "${kind}" (job or hub-job)`);
  const dir = lockDir(env);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${name}.lock`);
  // owner.json keeps every key older versions read (pid, host, repo, run, started_at) and adds the AD-2 keys after them.
  const me = { pid: process.pid, host: hostname(), repo: env.GITHUB_REPOSITORY ?? null, run: env.GITHUB_RUN_ID ?? null };
  const more = { format: OWNER_FORMAT, kind, attempt: env.GITHUB_RUN_ATTEMPT ?? null, job: env.GITHUB_JOB ?? null, host_id: hostId };
  const seams = { env, hostId };
  const requested = now();
  const deadline = requested + timeoutMs;
  note(name, eventOf('request', name, { ...me, ...more }, { deadline_at: iso(deadline) }), { ...seams, at: requested });
  let waiting = false;
  let mine;
  for (;;) {
    try {
      mkdirSync(path);
      // started_at is when the lock was taken, not when the wait began, so a release's held_ms is the hold alone.
      const taken = now();
      mine = { ...me, started_at: new Date(taken).toISOString(), ...more };
      writeFileSync(join(path, 'owner.json'), JSON.stringify(mine));
      note(name, eventOf('acquire', name, mine, { deadline_at: iso(deadline), waited_ms: Math.max(0, taken - requested) }), { ...seams, at: taken });
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    const owner = readOwner(path);
    const verdict = staleness(path, owner, { now, staleMs });
    if (verdict) {
      if (retire(name, path, owner, { as: 'reclaim', reason: verdict, env, now, log, hostId, beforeRetire })) log(`HUB_LOCK_RECLAIMED ${name} from ${describe(owner)}`);
      continue;
    }
    const at = now();
    if (at >= deadline) {
      note(name, eventOf('timeout', name, { ...me, ...more }, { deadline_at: iso(deadline), waited_ms: Math.max(0, at - requested), reason: 'deadline', blocked_by: describe(owner) }), { ...seams, at });
      throw new Error(`host lock ${name} is held by ${describe(owner)}; gave up after ${Math.round(timeoutMs / 60_000)} min. Another deploy is using the device; run again when it finishes.`);
    }
    if (!waiting) { log(`HUB_LOCK_WAIT ${name} held by ${describe(owner)}`); waiting = true; }
    await sleep(pollMs);
  }
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
    const owner = readOwner(path);
    if (owner?.pid === me.pid && !isLease(owner)) retire(name, path, owner, { as: 'release', reason: failed ? 'error' : 'done', env, now, log, hostId });
  }
}

// ---- leases ----

export const MAX_LEASE_MS = 48 * 3600_000;
const leaseName = name => { if (!/^[a-z0-9-]+$/.test(name)) throw new Error(`bad lock name "${name}"`); return name; };
const leaseId = id => { if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) throw new Error(`bad lease id "${id}" (lowercase letters, digits and dashes)`); return id; };
const lockPath = (name, env) => join(lockDir(env), `${leaseName(name)}.lock`);
const queuePath = (name, env) => join(lockDir(env), `${leaseName(name)}.queue`);
const failure = (code, message) => Object.assign(new Error(message), { code });

// Write-then-rename: a reader never sees half a record.
function writeOwner(path, owner) {
  const tmp = join(path, `owner.json.${process.pid}.tmp`);
  writeFileSync(tmp, JSON.stringify(owner));
  renameSync(tmp, join(path, 'owner.json'));
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

function staleWaiter(ticket) {
  // Queue tickets are new in this change, so a valid one always names the exact process that took it. A ticket
  // missing its process identity, or whose pid now belongs to a different process, is stale.
  if (ticket.host !== hostname() || !Number.isSafeInteger(ticket.pid) || !ticket.process_start) return true;
  if (!alive(ticket.pid)) return true;
  const actual = processStart(ticket.pid);
  return actual !== ticket.process_start;
}

// The waiters for a lock, oldest first. Observers only report stale tickets; acquire prunes them.
export function listWaiters(name, { env = process.env, prune = false } = {}) {
  const dir = queuePath(name, env);
  let files = [];
  try { files = readdirSync(dir).filter(file => file.endsWith('.json')).sort(); } catch { return []; }
  const waiters = [];
  for (const file of files) {
    let ticket = null;
    try { ticket = JSON.parse(readFileSync(join(dir, file), 'utf8')); } catch { /* being written, or junk */ }
    if (ticket && staleWaiter(ticket)) {
      if (prune) rmSync(join(dir, file), { force: true });
      else waiters.push({ ...ticket, file, stale: true });
      continue;
    }
    if (!ticket) {
      let age = 0;
      try { age = Date.now() - statSync(join(dir, file)).mtimeMs; } catch { continue; }
      if (prune && age > 60_000) rmSync(join(dir, file), { force: true });
      continue;
    }
    waiters.push({ ...ticket, file, stale: false });
  }
  return waiters;
}

// Takes the lock as a lease and returns the record. Waiters are served first in, first out. Throws code
// HUB_LOCK_TIMEOUT when waitMs passes, HUB_LEASE_CANCELLED when releaseLease removed its place in the queue.
// holderPid, when given, ties the lease to a process: the lease is reclaimed when that process is gone. The queue
// ticket is claimed (unlinked) only after the record is written: a release that removed the ticket first wins, and the
// record is taken back. beforeClaim is a test seam that runs between the two.
//
// Events (AD-9), each written only by the step that decided it: `request` once the ticket is in place, `acquire` once
// the ticket is claimed, `timeout` and `cancel` (an abort or an error while queued) once this waiter's own unlink of its
// ticket succeeds. A releaseLease that removes the ticket first records the cancel itself. A call with waitMs 0 is a
// try: it records its acquire and nothing when it fails, so pool probes never flood the log.
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
  beforeRetire,
  hostId = machineId(),
} = {}) {
  const path = lockPath(name, env);
  if (!(forMs > 0) || forMs > MAX_LEASE_MS) throw new Error(`a lease runs for more than 0 and at most ${MAX_LEASE_MS / 3600_000}h`);
  if (!holder || !why) throw new Error('a lease names its holder and why');
  const lease_id = id ? leaseId(id) : `l-${randomBytes(6).toString('hex')}`;
  mkdirSync(lockDir(env), { recursive: true });
  const queue = queuePath(name, env);
  mkdirSync(queue, { recursive: true });
  const requested = now();
  const ticket = `${String(requested).padStart(15, '0')}-${String(ticketCounter++).padStart(6, '0')}-${String(process.pid).padStart(8, '0')}.json`;
  const ticketFile = join(queue, ticket);
  // Write-then-rename, like owner.json: a reader never sees a half-written ticket.
  const pending = `${ticketFile}.tmp`;
  writeFileSync(pending, JSON.stringify({ lease_id, holder, why, pid: process.pid, host: hostname(), process_start: processStart(process.pid), enqueued_at: new Date(requested).toISOString() }), { flag: 'wx' });
  renameSync(pending, ticketFile);
  const deadline = requested + waitMs;
  const attempt = env.GITHUB_RUN_ATTEMPT ?? null;
  const job = env.GITHUB_JOB ?? null;
  const asked = { kind: 'lease', lease_id, holder, repo: env.GITHUB_REPOSITORY ?? null, run: env.GITHUB_RUN_ID ?? null, attempt, job };
  const tryOnly = !(waitMs > 0);
  const seams = { env, hostId };
  const waitedTo = at => ({ for_ms: forMs, deadline_at: iso(deadline), waited_ms: Math.max(0, at - requested) });
  if (!tryOnly) note(name, eventOf('request', name, asked, { for_ms: forMs, deadline_at: iso(deadline) }), { ...seams, at: requested });
  // Leaves the queue by unlinking its own ticket. True when this waiter's unlink decided it (and recorded `as`); false
  // when the ticket was already gone, which means a release cancelled it and wrote that event.
  let left = false;
  const leave = (as, fields) => {
    try { unlinkSync(ticketFile); } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
    left = true;
    const at = now();
    if (!tryOnly) note(name, eventOf(as, name, asked, { ...waitedTo(at), ...fields }), { ...seams, at });
    return true;
  };
  const timedOut = (message, owner) => {
    if (!leave('timeout', { reason: 'deadline', blocked_by: describe(owner) })) return failure('HUB_LEASE_CANCELLED', `lease ${lease_id} was released while it waited for ${name}`);
    return failure('HUB_LOCK_TIMEOUT', message);
  };
  let waiting = false;
  let failed = true;
  try {
    for (;;) {
      signal?.throwIfAborted();
      try { statSync(ticketFile); } catch { throw failure('HUB_LEASE_CANCELLED', `lease ${lease_id} was released while it waited for ${name}`); }
      const waiters = listWaiters(name, { env, prune: true });
      const position = waiters.findIndex(waiter => waiter.file === ticket);
      if (position === 0) {
        const started = now();
        const record = {
          pid: process.pid, host: hostname(), repo: env.GITHUB_REPOSITORY ?? null, run: env.GITHUB_RUN_ID ?? null, started_at: new Date(started).toISOString(),
          kind: 'lease', lease_id, holder, why, expires_at: new Date(started + forMs).toISOString(),
          holder_pid: holderPid, holder_process_start: Number.isSafeInteger(holderPid) ? processStart(holderPid) : null,
          format: OWNER_FORMAT, attempt, job, host_id: hostId,
        };
        let taken = false;
        try {
          mkdirSync(path);
          writeOwner(path, record);
          taken = true;
        } catch (error) {
          if (error.code !== 'EEXIST') throw error;
        }
        if (taken) {
          beforeClaim();
          try {
            unlinkSync(ticketFile);
          } catch (error) {
            if (error.code !== 'ENOENT') throw error;
            retire(name, path, record, { env, now, log });
            throw failure('HUB_LEASE_CANCELLED', `lease ${lease_id} was released while it was being taken for ${name}`);
          }
          left = true;
          note(name, eventOf('acquire', name, record, { deadline_at: iso(deadline), waited_ms: Math.max(0, started - requested) }), { ...seams, at: started });
          log(`HUB_LEASE ${name} ${lease_id} until ${record.expires_at}`);
          failed = false;
          return record;
        }
        const owner = readOwner(path);
        const verdict = staleness(path, owner, { now, staleMs });
        if (verdict) {
          if (retire(name, path, owner, { as: 'reclaim', reason: verdict, env, now, log, hostId, beforeRetire })) log(`HUB_LOCK_RECLAIMED ${name} from ${describe(owner)}`);
          continue;
        }
        if (now() >= deadline) throw timedOut(`host lock ${name} is held by ${describe(owner)}; gave up after ${Math.round(waitMs / 1000)}s`, owner);
        if (!waiting) { log(`HUB_LOCK_WAIT ${name} held by ${describe(owner)}`); waiting = true; }
      } else {
        if (position === -1) throw failure('HUB_LEASE_CANCELLED', `lease ${lease_id} lost its place in the queue for ${name}`);
        if (now() >= deadline) { const owner = readOwner(path); throw timedOut(`host lock ${name} has ${position} waiter${position === 1 ? '' : 's'} ahead of lease ${lease_id} (held by ${describe(owner)}); gave up after ${Math.round(waitMs / 1000)}s`, owner); }
        if (!waiting) { log(`HUB_LOCK_WAIT ${name} queued behind ${position} (${describe(readOwner(path))})`); waiting = true; }
      }
      await pause(pollMs, { signal, sleep });
    }
  } finally {
    // Anything else that ends the wait (an abort, an error) leaves the queue as a cancel.
    if (failed && !left) {
      try { leave('cancel', { reason: signal?.aborted ? 'aborted' : 'error' }); } catch { /* the rmSync below still clears it */ }
    }
    rmSync(ticketFile, { force: true });
  }
}

// Releases a lease by id (the lease of a waiter that has not been served yet is cancelled). Never touches a job's lock,
// another holder's lease or a lock that has moved on. Returns {released, cancelled, reason}. A release writes one
// `release` event (`reason`, else `by-id`, or `any` when no id was given); each waiter it cancels, one `cancel` event
// (reason `released`), written because this unlink of the ticket decided it.
export function releaseLease(name, id, { env = process.env, now = Date.now, reason = null, hostId } = {}) {
  const path = lockPath(name, env);
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
        const at = now();
        const enqueued = Date.parse(ticket.enqueued_at);
        note(name, eventOf('cancel', name, { kind: 'lease', lease_id: id, holder: ticket.holder ?? null }, { waited_ms: Number.isFinite(enqueued) ? Math.max(0, at - enqueued) : null, reason: 'released' }), { env, at, hostId });
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
  if (!retire(name, path, owner, { as, reason: reason ?? (id ? 'by-id' : 'any'), env, now, hostId })) return { released: false, cancelled, reason: 'changed' };
  return { released: true, cancelled, reason: 'released', owner };
}

// Adds fields (the phone's adb id once connected) to the lease record this id holds. False when the lock is
// gone (ENOENT), not this lease any more, or another holder rewrote it between the read and the write.
export function updateLease(name, id, fields, { env = process.env } = {}) {
  const path = lockPath(name, env);
  let owner;
  try { owner = readOwner(path); } catch { return false; }
  if (!isLease(owner) || owner.lease_id !== id) return false;
  const current = readOwner(path);
  if (!isLease(current) || current.lease_id !== id) return false;
  try { writeOwner(path, { ...current, ...fields }); } catch { return false; }
  return readOwner(path)?.lease_id === id;
}

// Every lock in the directory, read only: leases and jobs' locks, each with whether it is stale now.
export function listLocks({ env = process.env, now = Date.now, staleMs = 4 * 3600_000 } = {}) {
  const dir = lockDir(env);
  let entries = [];
  try { entries = readdirSync(dir).filter(entry => entry.endsWith('.lock')).sort(); } catch { return []; }
  return entries.map(entry => {
    const path = join(dir, entry);
    const owner = readOwner(path);
    return { name: entry.slice(0, -'.lock'.length), kind: isLease(owner) ? 'lease' : 'lock', owner, stale: stale(path, owner, { now, staleMs }), describe: describe(owner) };
  });
}
