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
const VANISHED_RETRIES = 3;

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

// A deploy job's or the catch-up's hold of a host lock. A Queued name (AD-4) joins the FIFO as a `job` or `hub-job` ticket
// and is served in order through queueView; every other name (s3-*, s3-index, emulator-reaper) is the bare mkdir path with no
// ticket and no event. Either way a wait that runs out throws code HUB_LOCK_TIMEOUT with a message that starts
// `host lock <name> is held` (AD-5), so a catch-up from before this change still reads it.
export const JOB_POLL_MS = 2000;

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
} = {}) {
  if (!/^[a-z0-9-]+$/.test(name)) throw new Error(`bad lock name "${name}"`);
  if (kind !== 'job' && kind !== 'hub-job') throw new Error(`bad lock holder kind "${kind}" (job or hub-job)`);
  if (isQueued(name)) return queuedLock(name, fn, { env, timeoutMs, pollMs, staleMs, log, sleep, now, kind, hostId, host, timers, beforeRetire, afterTake, startOf });
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
    if (now() >= deadline) throw failure('HUB_LOCK_TIMEOUT', `${heldText(name, owner)}; gave up after ${Math.round(timeoutMs / 60_000)} min. Another deploy is using the device; run again when it finishes.`);
    if (!waiting) { log(`HUB_LOCK_WAIT ${name} held by ${describe(owner)}`); waiting = true; }
    await sleep(pollMs);
  }
  return runHeld(name, path, mine, fn, { env, now, log, hostId, timers });
}

// owner.json keeps every key older versions read (pid, host, repo, run, started_at) and adds the AD-2 keys after them.
function jobIdentity({ env, host, hostId, kind }) {
  return {
    me: { pid: process.pid, host, repo: env.GITHUB_REPOSITORY ?? null, run: env.GITHUB_RUN_ID ?? null },
    more: { format: OWNER_FORMAT, kind, attempt: env.GITHUB_RUN_ATTEMPT ?? null, job: env.GITHUB_JOB ?? null, host_id: hostId },
  };
}

// Runs fn under a lock this process just took (`mine` is its owner record), then gives it back with a `release` event.
async function runHeld(name, path, mine, fn, { env, now, log, hostId, timers }) {
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
    if (owner?.pid === mine.pid && !isLease(owner)) retire(name, path, owner, { as: 'release', reason: failed ? 'error' : 'done', env, now, log, hostId });
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

// A job's ticket id can never collide with a Lease id: Lease ids are [a-z0-9-] only (leaseId), this one has `:`, `#`, `/`.
export const jobLeaseId = ({ repo, run, attempt, job }) => `job:${repo}#${run}.${attempt}/${job}`;

// The ticket body, in AD-3 order. `kind` lease takes the Lease's own id, holder and why. A job or hub-job takes its identity
// from the runner's GITHUB_* variables and always gets a holder and a why (the status text and the logs name them). The
// caller supplies requested/deadline times (ms) so the ticket carries the real request time.
export function buildTicket(kind, {
  env = process.env, requested, deadline = null, lease_id = null, holder = null, why = null,
  host = hostname(), hostId = machineId(), pid = process.pid, processStart: startOf = processStart,
  expires_at = null, reservation = null, request = null, pool = null, eta = null, delivery = null,
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
    repo, run, attempt, job, reservation, request, pool, eta, delivery,
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

// The waiters for a lock, oldest first. Observers only report stale tickets; acquire prunes them.
export function listWaiters(name, { env = process.env, prune = false, now = Date.now, host, hostId, processStart: startOf, isAlive } = {}) {
  const dir = queuePath(name, env);
  let files = [];
  try { files = readdirSync(dir).filter(file => file.endsWith('.json')).sort(); } catch { return []; }
  const seams = { now, ...(host === undefined ? {} : { host }), ...(hostId === undefined ? {} : { hostId }), ...(startOf ? { processStart: startOf } : {}), ...(isAlive ? { isAlive } : {}) };
  const waiters = [];
  for (const file of files) {
    let ticket = null;
    try { ticket = JSON.parse(readFileSync(join(dir, file), 'utf8')); } catch { /* being written, or junk */ }
    if (ticket && typeof ticket === 'object' && !Array.isArray(ticket)) {
      let mtimeMs = null;
      if (!Number.isFinite(Date.parse(ticket.enqueued_at))) { try { mtimeMs = statSync(join(dir, file)).mtimeMs; } catch { continue; } }
      const why = ticketStaleness(ticket, { ...seams, mtimeMs });
      if (why) {
        if (prune) rmSync(join(dir, file), { force: true });
        else waiters.push({ ...ticket, file, stale: true });
        continue;
      }
      waiters.push({ ...ticket, file, stale: false });
      continue;
    }
    let age = 0;
    try { age = now() - statSync(join(dir, file)).mtimeMs; } catch { continue; }
    if (prune && age > 60_000) rmSync(join(dir, file), { force: true });
  }
  return waiters;
}

// ---- the one queue view (AD-6) ----
//
// Every caller that needs to know who is ahead, who blocks or what a position is reads it here and never parses tickets
// (AD-1). Entries are the live tickets in order, each the ticket as written plus:
//   file      the ticket's file name (its identity in the Queue)
//   kind      lease, job, hub-job or remote (ticketKind: a missing kind is a lease)
//   place     1-based, in the order returned
//   blocking  whether a Claimant behind it must wait for it: every live ticket blocks (Story 2.5 adds Reservation entries,
//             `kind: 'reservation'` with `grace`, of which only the first in line blocks, and only until its grace ends)
//   stale     true for a dead ticket, which `includeStale` keeps in the list so read-only status can still show it
// Order is the sort key (a ticket's file name; a Reservation will bring its own) and then the full name. `prune` removes dead
// tickets, as acquirers do; observers never pass it. `policy` is accepted for the Reservation grace of Story 2.5 and unused.
const sortKey = entry => entry.file;
const inOrder = (a, b) => (sortKey(a) < sortKey(b) ? -1 : sortKey(a) > sortKey(b) ? 1 : a.file < b.file ? -1 : a.file > b.file ? 1 : 0);

export function queueView(name, { env = process.env, now = Date.now, policy = null, includeStale = false, prune = false, host, hostId, processStart: startOf, isAlive } = {}) {
  void policy;
  const tickets = listWaiters(name, { env, prune, now, host, hostId, processStart: startOf, isAlive });
  return tickets
    .filter(ticket => includeStale || !ticket.stale)
    .map(ticket => ({ ...ticket, kind: ticketKind(ticket), blocking: !ticket.stale }))
    .sort(inOrder)
    .map((entry, index) => ({ ...entry, place: index + 1 }));
}

// What blocks a Claimant: the blocking entries ahead of its own ticket, or every blocking entry for a try (which has no
// ticket and so no place; it takes a free lock only when nothing waits).
const blockersAhead = (view, file = null) => view.filter(entry => entry.blocking && (file === null || inOrder(entry, { file }) < 0));

// The AD-5 wording of every timeout on a Queued lock: `host lock <name> is held by <holder>`, then (when a Claimant waits ahead
// of this one) how many and who, each with its place. Callers add what the wait gave up on.
const waiterText = entry => `${entry.place}. ${entry.holder ?? entry.lease_id}${entry.why ? ` (${entry.why})` : ''}`;
function heldText(name, owner, blockers = [], self = null) {
  const ahead = blockers.length;
  const list = ahead > 0 ? `; ${ahead} waiter${ahead === 1 ? '' : 's'} ahead${self ? ` of ${self}` : ''} (${blockers.map(waiterText).join(', ')})` : '';
  return `host lock ${name} is held by ${describe(owner)}${list}`;
}

// Writes a ticket into <name>.queue/, write-then-rename so a reader never sees half of it, and returns its file name and path.
function writeTicket(name, body, { env, requested }) {
  const queue = queuePath(name, env);
  mkdirSync(queue, { recursive: true });
  const file = `${String(requested).padStart(15, '0')}-${String(ticketCounter++).padStart(6, '0')}-${String(process.pid).padStart(8, '0')}.json`;
  const path = join(queue, file);
  const pending = `${path}.tmp`;
  writeFileSync(pending, JSON.stringify(body), { flag: 'wx' });
  renameSync(pending, path);
  return { file, path };
}

// A process start read at most once per pid in JOB_POLL_MS: a Mac pass spawns `ps` per ticket otherwise (AD "liveness cost").
function cachedStart(startOf, now) {
  const seen = new Map();
  return pid => {
    const at = now();
    const hit = seen.get(pid);
    if (hit && at >= hit.at && at - hit.at < JOB_POLL_MS) return hit.start;
    const start = startOf(pid);
    seen.set(pid, { at, start });
    return start;
  };
}

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
export function poolRequest(pool, { id = newLeaseId(), holder, why, forMs = null, waitMs = 0, env = process.env, now = Date.now, hostId = machineId() } = {}) {
  const since = now();
  const deadline = since + waitMs;
  const tag = { name: pool, request: id, since, deadline };
  const subject = { kind: 'lease', lease_id: id, holder: holder ?? null, repo: env.GITHUB_REPOSITORY ?? null, run: env.GITHUB_RUN_ID ?? null, attempt: env.GITHUB_RUN_ATTEMPT ?? null, job: env.GITHUB_JOB ?? null };
  const write = (event, fields = {}) => {
    const at = now();
    appendEvent(eventOf(event, null, subject, { pool, request: id, for_ms: forMs, deadline_at: iso(deadline), ...fields }), { env, now: () => at, hostId });
    return at;
  };
  write('request');
  let ended = false;
  return {
    id,
    tag,
    // A busy or away Pool ends as a timeout (reason `deadline`, or `away` when no phone was there to take), an abort or any
    // other error as a cancel (a request released while it waited says `released`).
    settle(error, { signal } = {}) {
      if (ended) return;
      ended = true;
      const waited = at => ({ waited_ms: Math.max(0, at - since) });
      if (error?.code === 'HUB_LOCK_TIMEOUT' || error?.code === 'HUB_PHONE_AWAY') {
        const at = now();
        write('timeout', { ...waited(at), reason: error.code === 'HUB_PHONE_AWAY' ? 'away' : 'deadline', blocked_by: String(error.message ?? '').slice(0, 500) });
      } else {
        const at = now();
        write('cancel', { ...waited(at), reason: signal?.aborted || error?.name === 'AbortError' ? 'aborted' : error?.code === 'HUB_LEASE_CANCELLED' ? 'released' : 'error' });
      }
    },
  };
}

// A Queued withLock (AD-4, AD-6): the same wait as a Lease's, for a deploy job or the catch-up. A wait writes a `job` or `hub-job`
// ticket (identity from GITHUB_REPOSITORY, GITHUB_RUN_ID, GITHUB_RUN_ATTEMPT, GITHUB_JOB) and takes the lock only when nothing
// that blocks is ahead of it; after the mkdir it reads the view again and gives the lock back by tombstone if something now is.
// `timeoutMs` of 0 or less is a try: no ticket, no event unless it acquires. Events (AD-9) follow acquireLease's: `request` once
// the ticket is in place, `acquire` once the ticket is claimed, and `timeout` or `cancel` once this waiter's own unlink of its
// ticket succeeds. A wait that runs out throws HUB_LOCK_TIMEOUT, wording `host lock <name> is held ...` as before.
async function queuedLock(name, fn, { env, timeoutMs, pollMs, staleMs, log, sleep, now, kind, hostId, host, timers, beforeRetire, afterTake, startOf }) {
  const dir = lockDir(env);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${name}.lock`);
  const { me, more } = jobIdentity({ env, host, hostId, kind });
  const asked = { ...me, ...more };
  const seams = { env, hostId };
  const requested = now();
  const deadline = requested + timeoutMs;
  const tryOnly = !(timeoutMs > 0);
  const start = cachedStart(startOf, now);
  let ticket = null;
  let ticketFile = null;
  let selfText = 'this job';
  if (!tryOnly) {
    const body = buildTicket(kind, { env, requested, deadline, host, hostId, processStart: startOf });
    selfText = `${kind === 'hub-job' ? 'catch-up' : 'job'} ${body.lease_id}`;
    ({ file: ticket, path: ticketFile } = writeTicket(name, body, { env, requested }));
    note(name, eventOf('request', name, asked, { deadline_at: iso(deadline) }), { ...seams, at: requested });
  }
  let left = false;
  const leave = (as, fields) => {
    try { unlinkSync(ticketFile); } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
    left = true;
    const at = now();
    note(name, eventOf(as, name, asked, { deadline_at: iso(deadline), waited_ms: Math.max(0, at - requested), ...fields }), { ...seams, at });
    return true;
  };
  const cancelled = text => failure('HUB_LEASE_CANCELLED', `${selfText} ${text} ${name}`);
  const timedOut = (message, owner) => {
    if (tryOnly) return failure('HUB_LOCK_TIMEOUT', message);
    if (!leave('timeout', { reason: 'deadline', blocked_by: describe(owner) })) return cancelled('was released while it waited for');
    return failure('HUB_LOCK_TIMEOUT', message);
  };
  const view = () => queueView(name, { env, prune: true, now, host, hostId, processStart: start });
  const gaveUp = `gave up after ${Math.round(timeoutMs / 60_000)} min. Another deploy is using the device; run again when it finishes.`;
  let waiting = false;
  let vanished = 0;
  let failed = true;
  let mine = null;
  try {
    for (;;) {
      if (ticketFile) { try { statSync(ticketFile); } catch { throw cancelled('was released while it waited for'); } }
      const current = view();
      if (ticket && !current.some(entry => entry.file === ticket)) throw cancelled('lost its place in the queue for');
      let blockers = blockersAhead(current, ticket);
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
          blockers = blockersAhead(view(), ticket);
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
          note(name, eventOf('acquire', name, record, { deadline_at: iso(deadline), waited_ms: Math.max(0, started - requested) }), { ...seams, at: started });
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
          if (now() >= deadline) throw timedOut(`${heldText(name, owner)}; ${gaveUp}`, owner);
          if (!waiting) { log(`HUB_LOCK_WAIT ${name} held by ${describe(owner)}`); waiting = true; }
        }
      }
      if (blockers.length > 0) {
        const owner = readOwner(path);
        if (now() >= deadline) throw timedOut(`${heldText(name, owner, blockers, selfText)}; ${gaveUp}`, owner);
        if (!waiting) { log(`HUB_LOCK_WAIT ${name} queued behind ${blockers.length} (${describe(owner)})`); waiting = true; }
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
  return runHeld(name, path, mine, fn, { env, now, log, hostId, timers });
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
} = {}) {
  const path = lockPath(name, env);
  if (!(forMs > 0) || forMs > MAX_LEASE_MS) throw new Error(`a lease runs for more than 0 and at most ${MAX_LEASE_MS / 3600_000}h`);
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
  if (!tryOnly) {
    ({ file: ticket, path: ticketFile } = writeTicket(name, buildTicket('lease', { env, requested, deadline, lease_id, holder, why, host, hostId, processStart: startOf }), { env, requested }));
  }
  const attempt = env.GITHUB_RUN_ATTEMPT ?? null;
  const job = env.GITHUB_JOB ?? null;
  const asked = { kind: 'lease', lease_id, holder, repo: env.GITHUB_REPOSITORY ?? null, run: env.GITHUB_RUN_ID ?? null, attempt, job };
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
    note(name, eventOf(as, name, asked, { ...waitedTo(at), ...fields }), { ...seams, at });
    return true;
  };
  const timedOut = (message, owner) => {
    if (tryOnly) return failure('HUB_LOCK_TIMEOUT', message);
    if (!leave('timeout', { reason: 'deadline', blocked_by: describe(owner) })) return failure('HUB_LEASE_CANCELLED', `lease ${lease_id} was released while it waited for ${name}`);
    return failure('HUB_LOCK_TIMEOUT', message);
  };
  const view = () => queueView(name, { env, prune: true, now, host, hostId, processStart: startOf });
  const cancelled = text => failure('HUB_LEASE_CANCELLED', `lease ${lease_id} ${text} ${name}`);
  let waiting = false;
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
          note(name, eventOf('acquire', name, record, { deadline_at: iso(pool?.deadline ?? deadline), waited_ms: waitedMs, ...tag }), { ...seams, at: started });
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
          if (!waiting) { log(`HUB_LOCK_WAIT ${name} held by ${describe(owner)}`); waiting = true; }
        }
      }
      if (blockers.length > 0) {
        const ahead = blockers.length;
        if (now() >= deadline) { const owner = readOwner(path); throw timedOut(`${heldText(name, owner, blockers, `lease ${lease_id}`)}; gave up after ${Math.round(waitMs / 1000)}s`, owner); }
        if (!waiting) { log(`HUB_LOCK_WAIT ${name} queued behind ${ahead} (${describe(readOwner(path))})`); waiting = true; }
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
    }
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
        // A job's or the catch-up's ticket cancels as that job (the claimant its own `request` named, lease_id null as for every
        // job event), never as a Lease: a reader that pairs request and cancel by claimant sees one waiter.
        const kind = ticketKind(ticket);
        const subject = kind === 'job' || kind === 'hub-job'
          ? { kind, repo: ticket.repo ?? null, run: ticket.run ?? null, attempt: ticket.attempt ?? null, job: ticket.job ?? null }
          : { kind: 'lease', lease_id: id, holder: ticket.holder ?? null };
        note(name, eventOf('cancel', name, subject, { waited_ms: Number.isFinite(enqueued) ? Math.max(0, at - enqueued) : null, reason: 'released' }), { env, at, hostId });
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
