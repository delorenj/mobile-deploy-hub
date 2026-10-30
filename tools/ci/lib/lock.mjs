// Host locks. Three apps share one S26, one iPad and one Mac, and each app has its own runners, so per-repo
// concurrency groups cannot stop two deploys from talking to the same device at once. A lock is a directory
// (mkdir is atomic on both hosts) holding the owner's pid, run and start time. A holder that died without
// releasing (a job killed at its timeout) is reclaimed when its pid is gone; waiting has a deadline.
//
// A lease is the same lock taken by a person or an agent instead of a job: acquire returns and the lock persists past the
// process that took it, until release or `expires_at`. It lives in the same directory under the same name (`adb` is the
// S26), so withLock callers and leases exclude each other both ways. Waiters for a lease queue FIFO in `<name>.queue/`.
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { join } from 'node:path';

export const lockDir = (env = process.env, home = homedir()) => env.HUB_LOCK_DIR || join(home, '.cache/mobile-deploy-hub/locks');

const alive = pid => {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
};

// A record from before leases (pid, host, repo, run, started_at) still parses; anything that is not an object is no owner.
function readOwner(path) {
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
// names one) is gone. A lease is not judged by pid (the process that took it is long gone) or by age.
function stale(path, owner, { now, staleMs }) {
  let age = 0;
  try { age = now() - statSync(path).mtimeMs; } catch { return true; }
  // owner.json is written right after mkdir; a lock without one for a minute was abandoned mid-creation.
  if (!owner) return age > 60_000;
  if (Number.isFinite(expiresAt(owner))) {
    if (expiresAt(owner) <= now()) return true;
    return owner.host === hostname() && Number.isSafeInteger(owner.holder_pid) && !alive(owner.holder_pid);
  }
  if (owner.host === hostname() && Number.isSafeInteger(owner.pid) && !alive(owner.pid)) return true;
  return age > staleMs;
}

// Removes a stale lock unless it changed hands since it was judged.
function reclaim(path, judged) {
  const current = readOwner(path);
  if (JSON.stringify(current) !== JSON.stringify(judged)) return false;
  rmSync(path, { recursive: true, force: true });
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
} = {}) {
  if (!/^[a-z0-9-]+$/.test(name)) throw new Error(`bad lock name "${name}"`);
  const dir = lockDir(env);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${name}.lock`);
  const me = { pid: process.pid, host: hostname(), repo: env.GITHUB_REPOSITORY ?? null, run: env.GITHUB_RUN_ID ?? null, started_at: new Date(now()).toISOString() };
  const deadline = now() + timeoutMs;
  let waiting = false;
  for (;;) {
    try {
      mkdirSync(path);
      writeFileSync(join(path, 'owner.json'), JSON.stringify(me));
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    const owner = readOwner(path);
    if (stale(path, owner, { now, staleMs })) {
      if (reclaim(path, owner)) log(`HUB_LOCK_RECLAIMED ${name} from ${describe(owner)}`);
      continue;
    }
    if (now() >= deadline) throw new Error(`host lock ${name} is held by ${describe(owner)}; gave up after ${Math.round(timeoutMs / 60_000)} min. Another deploy is using the device; run again when it finishes.`);
    if (!waiting) { log(`HUB_LOCK_WAIT ${name} held by ${describe(owner)}`); waiting = true; }
    await sleep(pollMs);
  }
  log(`HUB_LOCK ${name}`);
  try {
    return await fn();
  } finally {
    const owner = readOwner(path);
    if (owner?.pid === me.pid && !isLease(owner)) rmSync(path, { recursive: true, force: true });
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

// The waiters for a lock, oldest first. Observers only report stale tickets; acquire prunes them.
export function listWaiters(name, { env = process.env, prune = false } = {}) {
  const dir = queuePath(name, env);
  let files = [];
  try { files = readdirSync(dir).filter(file => file.endsWith('.json')).sort(); } catch { return []; }
  const waiters = [];
  for (const file of files) {
    let ticket = null;
    try { ticket = JSON.parse(readFileSync(join(dir, file), 'utf8')); } catch { /* being written, or junk */ }
    if (ticket && ticket.host === hostname() && Number.isSafeInteger(ticket.pid) && !alive(ticket.pid)) {
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
// holderPid, when given, ties the lease to a process: the lease is reclaimed when that process is gone.
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
  sleep = ms => new Promise(done => setTimeout(done, ms)),
  now = Date.now,
  signal,
} = {}) {
  const path = lockPath(name, env);
  if (!(forMs > 0) || forMs > MAX_LEASE_MS) throw new Error(`a lease runs for more than 0 and at most ${MAX_LEASE_MS / 3600_000}h`);
  if (!holder || !why) throw new Error('a lease names its holder and why');
  const lease_id = id ? leaseId(id) : `l-${randomBytes(6).toString('hex')}`;
  mkdirSync(lockDir(env), { recursive: true });
  const queue = queuePath(name, env);
  mkdirSync(queue, { recursive: true });
  const ticket = `${String(now()).padStart(15, '0')}-${String(ticketCounter++).padStart(6, '0')}-${String(process.pid).padStart(8, '0')}.json`;
  const ticketFile = join(queue, ticket);
  writeFileSync(ticketFile, JSON.stringify({ lease_id, holder, why, pid: process.pid, host: hostname(), enqueued_at: new Date(now()).toISOString() }), { flag: 'wx' });
  const deadline = now() + waitMs;
  let waiting = false;
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
          kind: 'lease', lease_id, holder, why, expires_at: new Date(started + forMs).toISOString(), holder_pid: holderPid,
        };
        try {
          mkdirSync(path);
          writeOwner(path, record);
          log(`HUB_LEASE ${name} ${lease_id} until ${record.expires_at}`);
          return record;
        } catch (error) {
          if (error.code !== 'EEXIST') throw error;
        }
        const owner = readOwner(path);
        if (stale(path, owner, { now, staleMs })) {
          if (reclaim(path, owner)) log(`HUB_LOCK_RECLAIMED ${name} from ${describe(owner)}`);
          continue;
        }
        if (now() >= deadline) throw failure('HUB_LOCK_TIMEOUT', `host lock ${name} is held by ${describe(owner)}; gave up after ${Math.round(waitMs / 1000)}s`);
        if (!waiting) { log(`HUB_LOCK_WAIT ${name} held by ${describe(owner)}`); waiting = true; }
      } else {
        if (position === -1) throw failure('HUB_LEASE_CANCELLED', `lease ${lease_id} lost its place in the queue for ${name}`);
        if (now() >= deadline) throw failure('HUB_LOCK_TIMEOUT', `host lock ${name} has ${position} waiter${position === 1 ? '' : 's'} ahead of lease ${lease_id}; gave up after ${Math.round(waitMs / 1000)}s`);
        if (!waiting) { log(`HUB_LOCK_WAIT ${name} queued behind ${position} (${describe(readOwner(path))})`); waiting = true; }
      }
      if (!signal) { await sleep(pollMs); continue; }
      await new Promise(done => {
        const timer = setTimeout(() => { signal.removeEventListener('abort', abort); done(); }, pollMs);
        const abort = () => { clearTimeout(timer); done(); };
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
      });
    }
  } finally {
    rmSync(ticketFile, { force: true });
  }
}

// Releases a lease by id (the lease of a waiter that has not been served yet is cancelled). Never touches a job's lock,
// another holder's lease or a lock that has moved on. Returns {released, cancelled, reason}.
export function releaseLease(name, id, { env = process.env } = {}) {
  const path = lockPath(name, env);
  let cancelled = 0;
  if (id) {
    const dir = queuePath(name, env);
    let files = [];
    try { files = readdirSync(dir); } catch { /* no queue */ }
    for (const file of files) {
      try {
        if (JSON.parse(readFileSync(join(dir, file), 'utf8')).lease_id === id) { unlinkSync(join(dir, file)); cancelled += 1; }
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
  if (!reclaim(path, owner)) return { released: false, cancelled, reason: 'changed' };
  return { released: true, cancelled, reason: 'released', owner };
}

// Adds fields (the phone's adb id once connected) to the lease record this id holds.
export function updateLease(name, id, fields, { env = process.env } = {}) {
  const path = lockPath(name, env);
  const owner = readOwner(path);
  if (!isLease(owner) || owner.lease_id !== id) return false;
  writeOwner(path, { ...owner, ...fields });
  return true;
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
