// Leases on the host lock (tools/ci/lib/lock.mjs): a lease outlives the process that took it, shares the lock directory and
// names with withLock so the two exclude each other, expires or is reclaimed when its holder is gone, and its waiters are
// served first in, first out. Everything runs against a temp HUB_LOCK_DIR.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { ALIVE_MS, QUEUED, TICKET_ABSENT_MS, acquireLease, buildTicket, isQueued, jobLeaseId, listLocks, listWaiters, poolRequest, processStart as processStartOf, queueView, releaseLease, sameHost, ticketKind, ticketStaleness, updateLease, withLock } from '../ci/lib/lock.mjs';
import { hostId, readEvents } from '../ci/lib/events.mjs';
import { pause } from '../ci/lib/pause.mjs';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'hub-lease-'));
  const env = { HUB_LOCK_DIR: join(root, 'locks'), HUB_EVENT_DIR: join(root, 'events'), GITHUB_REPOSITORY: 'delorenj/example', GITHUB_RUN_ID: '9' };
  const logs = [];
  return { root, env, logs, log: line => logs.push(line), lock: join(root, 'locks/adb.lock'), cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
const events = f => [...readEvents({ env: f.env })];
// The exactly-once tests (Story 1.2) look at how holds end; Story 1.4 adds request/acquire/timeout around them.
const holds = f => events(f).filter(event => event.event === 'release' || event.event === 'reclaim');
const tombs = f => { try { return readdirSync(join(f.root, 'locks')).filter(entry => entry.includes('.tomb-')); } catch { return []; } };
const lease = (f, extra = {}) => acquireLease('adb', { holder: 'agent-a', why: 'device proof', forMs: 60_000, env: f.env, log: f.log, pollMs: 5, ...extra });
const owner = f => JSON.parse(readFileSync(join(f.lock, 'owner.json'), 'utf8'));
const deadPid = () => { const child = spawnSync(process.execPath, ['-e', '']); return child.pid; };
const settle = ms => new Promise(done => setTimeout(done, ms));

test('a lease persists past its caller, records who and why, and is released by its own id only', async () => {
  const f = fixture();
  try {
    const record = await lease(f, { id: 'proof-1' });
    assert.equal(record.kind, 'lease');
    assert.equal(record.lease_id, 'proof-1');
    const stored = owner(f);
    assert.deepEqual({ kind: stored.kind, lease_id: stored.lease_id, holder: stored.holder, why: stored.why, pid: stored.pid, host: stored.host }, { kind: 'lease', lease_id: 'proof-1', holder: 'agent-a', why: 'device proof', pid: process.pid, host: hostname() });
    assert.ok(Date.parse(stored.expires_at) > Date.now() && Date.parse(stored.started_at) <= Date.now());
    assert.equal(stored.repo, 'delorenj/example');
    assert.ok(f.logs.some(line => /^HUB_LEASE adb proof-1 until /.test(line)));
    assert.deepEqual(releaseLease('adb', 'someone-else', { env: f.env }).reason, 'other-lease');
    assert.ok(existsSync(f.lock), 'another id leaves the lease alone');
    assert.equal(releaseLease('adb', 'proof-1', { env: f.env }).released, true);
    assert.ok(!existsSync(f.lock));
    assert.equal(releaseLease('adb', 'proof-1', { env: f.env }).reason, 'none', 'releasing twice is not an error');
    assert.equal(updateLease('adb', 'proof-1', { x: 1 }, { env: f.env }), false);
  } finally { f.cleanup(); }
});

test('a lease can be tied to a holder pid and sized: bad durations and ids are refused', async () => {
  const f = fixture();
  try {
    await assert.rejects(lease(f, { forMs: 0 }), /more than 0/);
    await assert.rejects(lease(f, { forMs: 49 * 3600_000 }), /at most 48h/);
    await assert.rejects(lease(f, { id: 'Bad Id' }), /bad lease id/);
    await assert.rejects(lease(f, { why: '' }), /names its holder and why/);
    await assert.rejects(acquireLease('Bad Name', { holder: 'a', why: 'b', forMs: 1000, env: f.env }), /bad lock name/);
  } finally { f.cleanup(); }
});

test('an expired lease is reclaimed by the next lease and by a withLock caller', async () => {
  const f = fixture();
  try {
    let clock = Date.now();
    await lease(f, { forMs: 60_000, id: 'old', now: () => clock });
    clock += 59_000;
    await assert.rejects(lease(f, { id: 'early', now: () => clock, waitMs: 0 }), /held by lease old of agent-a \(device proof\) until/);
    clock += 2000;
    const next = await lease(f, { id: 'new', holder: 'agent-b', now: () => clock });
    assert.equal(next.lease_id, 'new');
    assert.ok(f.logs.some(line => /^HUB_LOCK_RECLAIMED adb from lease old/.test(line)));
    // and the job's side: a deploy takes an expired lease over
    clock += 3600_000;
    const ran = [];
    await withLock('adb', async () => { ran.push('deploy'); }, { env: f.env, log: f.log, now: () => clock, timeoutMs: 1000, pollMs: 1, sleep: async () => {} });
    assert.deepEqual(ran, ['deploy']);
    assert.ok(f.logs.some(line => /^HUB_LOCK_RECLAIMED adb from lease new/.test(line)));
  } finally { f.cleanup(); }
});

test('a lease tied to a holder pid is reclaimed when that process is gone, a live one is respected, and a lease without a pid is not judged by its caller', async () => {
  const f = fixture();
  try {
    await lease(f, { id: 'tied', holderPid: deadPid() });
    const next = await lease(f, { id: 'after', holderPid: process.pid });
    assert.equal(next.lease_id, 'after');
    assert.ok(f.logs.some(line => /^HUB_LOCK_RECLAIMED adb from lease tied/.test(line)));
    await assert.rejects(lease(f, { id: 'blocked', waitMs: 0 }), /held by lease after/, 'its holder is alive');
    releaseLease('adb', 'after', { env: f.env });
    await lease(f, { id: 'loose' });
    writeFileSync(join(f.lock, 'owner.json'), JSON.stringify({ ...owner(f), pid: deadPid() }));
    await assert.rejects(lease(f, { id: 'blocked-too', waitMs: 0 }), /held by lease loose/, 'the process that took the lease is expected to be gone');
  } finally { f.cleanup(); }
});

test('a lease and a withLock job exclude each other, both ways', async () => {
  const f = fixture();
  try {
    // job holds, lease waits (and times out)
    let release;
    const holding = withLock('adb', () => new Promise(done => { release = done; }), { env: f.env, log: f.log });
    await settle(20);
    await assert.rejects(lease(f, { waitMs: 30 }), error => error.code === 'HUB_LOCK_TIMEOUT' && /held by delorenj\/example run 9/.test(error.message));
    assert.ok(f.logs.some(line => /^HUB_LOCK_WAIT adb held by delorenj\/example run 9/.test(line)));
    // lease waits for the job, then gets it
    const waiting = lease(f, { id: 'queued', waitMs: 5000 });
    await settle(30);
    release();
    await holding;
    assert.equal((await waiting).lease_id, 'queued');
    assert.equal(owner(f).kind, 'lease', 'the job did not remove the lease that replaced it');
    // lease holds, job waits (and times out; it never removes a lease)
    await assert.rejects(withLock('adb', async () => {}, { env: f.env, log: () => {}, timeoutMs: 40, pollMs: 5 }), /host lock adb is held by lease queued of agent-a/);
    assert.ok(existsSync(f.lock));
    // lease released, job runs
    const ran = [];
    setTimeout(() => releaseLease('adb', 'queued', { env: f.env }), 30);
    await withLock('adb', async () => { ran.push('job'); }, { env: f.env, log: () => {}, timeoutMs: 2000, pollMs: 5 });
    assert.deepEqual(ran, ['job']);
    assert.ok(!existsSync(f.lock), 'the job released its own lock');
  } finally { f.cleanup(); }
});

test('legacy owner.json (no kind, no lease fields) still parses and is judged as before', async () => {
  const f = fixture();
  try {
    mkdirSync(f.lock, { recursive: true });
    writeFileSync(join(f.lock, 'owner.json'), JSON.stringify({ pid: process.pid, host: hostname(), repo: 'delorenj/gruvato', run: '42', started_at: new Date().toISOString() }));
    await assert.rejects(lease(f, { waitMs: 0 }), /held by delorenj\/gruvato run 42 \(pid \d+, since /);
    assert.equal(releaseLease('adb', 'x', { env: f.env }).reason, 'not-a-lease', 'a job lock is never released as a lease');
    assert.equal(releaseLease('adb', null, { env: f.env }).reason, 'not-a-lease');
    assert.ok(existsSync(f.lock));
    assert.deepEqual(listLocks({ env: f.env }).map(entry => [entry.name, entry.kind, entry.stale]), [['adb', 'lock', false]]);
    writeFileSync(join(f.lock, 'owner.json'), JSON.stringify({ pid: deadPid(), host: hostname(), repo: 'delorenj/gruvato', run: '43', started_at: new Date().toISOString() }));
    assert.equal(listLocks({ env: f.env })[0].stale, true);
    assert.equal((await lease(f, { id: 'took-over' })).lease_id, 'took-over');
    writeFileSync(join(f.lock, 'owner.json'), 'null');
    assert.equal(listLocks({ env: f.env })[0].owner, null, 'a record that is not an object is no owner');
  } finally { f.cleanup(); }
});

test('waiters are served first in, first out', async () => {
  const f = fixture();
  try {
    await lease(f, { id: 'first', holder: 'a' });
    const order = [];
    const take = async (id, holder) => { const record = await lease(f, { id, holder, waitMs: 10_000 }); order.push(id); await settle(10); releaseLease('adb', id, { env: f.env }); return record; };
    const waiters = [];
    for (const id of ['second', 'third', 'fourth']) { waiters.push(take(id, id)); await settle(8); }
    assert.deepEqual(listWaiters('adb', { env: f.env }).map(waiter => waiter.lease_id), ['second', 'third', 'fourth']);
    releaseLease('adb', 'first', { env: f.env });
    await Promise.all(waiters);
    assert.deepEqual(order, ['second', 'third', 'fourth']);
    assert.deepEqual(listWaiters('adb', { env: f.env }), [], 'served waiters leave the queue');
    assert.ok(!existsSync(f.lock));
  } finally { f.cleanup(); }
});

test('a waiter whose process died is dropped from the queue, and releasing a waiting lease cancels it', async () => {
  const f = fixture();
  try {
    await lease(f, { id: 'holder' });
    const queue = join(f.root, 'locks/adb.queue');
    mkdirSync(queue, { recursive: true });   // a try writes no ticket, so nothing has made the queue yet
    writeFileSync(join(queue, '000000000000001-000000-00000001.json'), JSON.stringify({ lease_id: 'ghost', holder: 'ghost', why: 'gone', pid: deadPid(), host: hostname(), enqueued_at: new Date(0).toISOString() }));
    const waiting = lease(f, { id: 'real', waitMs: 10_000 });
    await settle(30);
    assert.deepEqual(listWaiters('adb', { env: f.env }).map(waiter => waiter.lease_id), ['real'], 'the ghost ahead of it is gone');
    assert.deepEqual(releaseLease('adb', 'real', { env: f.env }), { released: false, cancelled: 1, reason: 'other-lease', owner: owner(f) });
    await assert.rejects(waiting, error => error.code === 'HUB_LEASE_CANCELLED');
    assert.deepEqual(listWaiters('adb', { env: f.env }), []);
    assert.equal(owner(f).lease_id, 'holder', 'the holder was not touched');
  } finally { f.cleanup(); }
});

test('a ticket with a reused live pid but a different process start is stale and cannot block a new lease', async () => {
  const f = fixture();
  try {
    const queue = join(f.root, 'locks/adb.queue');
    mkdirSync(queue, { recursive: true });
    const ghost = join(queue, '000000000000001-000000-00000001.json');
    writeFileSync(ghost, JSON.stringify({ lease_id: 'ghost', holder: 'old', why: 'gone', pid: process.pid, host: hostname(), process_start: '0', enqueued_at: new Date(0).toISOString() }));
    assert.equal(listWaiters('adb', { env: f.env })[0].stale, true, 'read-only status sees the stale identity');
    assert.ok(existsSync(ghost), 'observing does not prune');
    assert.equal((await lease(f, { id: 'next', waitMs: 100 })).lease_id, 'next');
    assert.ok(!existsSync(ghost), 'acquisition prunes the reused-pid ticket');
  } finally { f.cleanup(); }
});

// INTENDED CHANGE (Story 2.1, AD-3): until v1.2.43 a ticket with no recorded process_start was stale even with a live pid. A
// ticket is now stale only on positive evidence of death, and a start time nobody recorded is no such evidence.
test('a ticket with a live pid and no recorded process_start is live (intended change: AD-3 needs positive evidence of death)', async () => {
  const f = fixture();
  try {
    const queue = join(f.root, 'locks/adb.queue');
    mkdirSync(queue, { recursive: true });
    const waiting = join(queue, '000000000000001-000000-00000001.json');
    writeFileSync(waiting, JSON.stringify({ lease_id: 'legacy', holder: 'old', why: 'waiting', pid: process.pid, host: hostname(), enqueued_at: new Date().toISOString() }));
    assert.equal(listWaiters('adb', { env: f.env })[0].stale, false, 'its process is alive: live');
    await assert.rejects(lease(f, { id: 'next', waitMs: 40 }), error => error.code === 'HUB_LOCK_TIMEOUT' && /1 waiter ahead of lease next/.test(error.message), 'it keeps its place ahead');
    assert.ok(existsSync(waiting), 'acquisition does not prune a live ticket');
    writeFileSync(waiting, JSON.stringify({ lease_id: 'legacy', holder: 'old', why: 'gone', pid: deadPid(), host: hostname(), enqueued_at: new Date().toISOString() }));
    assert.equal((await lease(f, { id: 'after', waitMs: 100 })).lease_id, 'after', 'a dead pid is positive evidence: pruned');
    assert.ok(!existsSync(waiting));
  } finally { f.cleanup(); }
});

test('a waiter that times out leaves the queue; a queued lease says how many are ahead', async () => {
  const f = fixture();
  try {
    await lease(f, { id: 'holder' });
    const first = lease(f, { id: 'one', waitMs: 10_000 });
    await settle(10);
    // INTENDED CHANGE (Story 2.3, AD-5): a queued Lease's timeout starts `host lock <name> is held` like every other wait on a
    // Queued lock, then names the waiters ahead with their places (it was `host lock adb has 1 waiter ahead of lease two (held by ...)`).
    await assert.rejects(lease(f, { id: 'two', waitMs: 40 }), /host lock adb is held by lease holder of agent-a \(device proof\) until .*; 1 waiter ahead of lease two \(1\. agent-a \(device proof\)\); gave up after 0s/);
    assert.deepEqual(listWaiters('adb', { env: f.env }).map(waiter => waiter.lease_id), ['one']);
    releaseLease('adb', 'one', { env: f.env });
    await assert.rejects(first, error => error.code === 'HUB_LEASE_CANCELLED');
  } finally { f.cleanup(); }
});

test('a release that lands while the lease is being taken wins: the record is taken back and acquire says cancelled', async () => {
  const f = fixture();
  try {
    // INTENDED CHANGE (Story 2.2): a try (waitMs 0) has no ticket, so the claim race belongs to a waiter, which has one.
    await assert.rejects(lease(f, { id: 'racing', waitMs: 1000, beforeClaim: () => releaseLease('adb', 'racing', { env: f.env }) }), error => error.code === 'HUB_LEASE_CANCELLED');
    assert.ok(!existsSync(f.lock), 'no orphan record');
    // a release that removed the ticket but had not yet looked at the record: acquire takes its own record back
    const queue = join(f.root, 'locks/adb.queue');
    await assert.rejects(lease(f, { id: 'racing-2', waitMs: 1000, beforeClaim: () => { for (const file of readdirSync(queue)) rmSync(join(queue, file)); } }), error => error.code === 'HUB_LEASE_CANCELLED');
    assert.ok(!existsSync(f.lock), 'its own record is gone too');
    // Intended change (Story 1.4): the release cancelled a request that never acquired, so its history is one cancel. (The
    // second ticket was removed by the test, not by a release, so it has no cancel.)
    assert.deepEqual(events(f).map(event => [event.event, event.lease_id, event.reason]), [['request', 'racing', null], ['cancel', 'racing', 'released'], ['request', 'racing-2', null]], 'a give-back is neither a release nor an acquire');
    assert.deepEqual(tombs(f), []);
    assert.equal((await lease(f, { id: 'after' })).lease_id, 'after', 'the lock is free for the next taker');
    assert.equal(releaseLease('adb', null, { env: f.env }).released, true);
    assert.deepEqual(events(f).at(-1).reason, 'any', 'a release without an id says so');
  } finally { f.cleanup(); }
});

test('the holder is never listed as a waiter: its ticket is gone by the time the lease is announced', async () => {
  const f = fixture();
  try {
    let seen = null;
    await lease(f, { id: 'quick', log: line => { if (line.startsWith('HUB_LEASE ')) seen = listWaiters('adb', { env: f.env }); } });
    assert.deepEqual(seen, []);
    assert.equal(owner(f).lease_id, 'quick');
  } finally { f.cleanup(); }
});

test('a lease tied to a pid records that process\'s start time; a reused pid (another start time) is stale', async () => {
  const f = fixture();
  try {
    await lease(f, { id: 'tied', holderPid: process.pid });
    assert.ok(owner(f).holder_process_start, 'the start time is recorded');
    await assert.rejects(lease(f, { id: 'blocked', waitMs: 0 }), /held by lease tied/, 'same process: still held');
    writeFileSync(join(f.lock, 'owner.json'), JSON.stringify({ ...owner(f), holder_process_start: '1' }));
    assert.equal((await lease(f, { id: 'next' })).lease_id, 'next', 'the pid now belongs to another process: reclaimed');
    assert.ok(f.logs.some(line => /^HUB_LOCK_RECLAIMED adb from lease tied/.test(line)));
  } finally { f.cleanup(); }
});

test('pause honours an injected sleep and returns at once on abort', async () => {
  const slept = [];
  await pause(250, { sleep: async ms => { slept.push(ms); } });
  assert.deepEqual(slept, [250], 'the injected sleep is the clock');
  const controller = new AbortController();
  const never = () => new Promise(() => {});
  const waiting = pause(60_000, { signal: controller.signal, sleep: never });
  controller.abort();
  await waiting;
  const started = Date.now();
  await pause(60_000, { signal: controller.signal });
  assert.ok(Date.now() - started < 100, 'an aborted signal does not wait');
});

// ---- exactly-once release and reclaim (AD-9, MOBI-25) ----

const lockUrl = new URL('../ci/lib/lock.mjs', import.meta.url).href;
// Another process acting on the same lock dir, synchronously, from inside a seam: the deterministic interleaving.
const otherProcess = (f, body) => {
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `const lock = await import(${JSON.stringify(lockUrl)}); ${body}`], { env: { PATH: process.env.PATH, HUB_LOCK_DIR: f.env.HUB_LOCK_DIR, HUB_EVENT_DIR: f.env.HUB_EVENT_DIR }, encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
};
// Since Story 2.3 a withLock caller on a Queued name waits in line, so the other process the seams below spawn must stand AHEAD of
// the parent (a child that queued behind a parent blocked in spawnSync would wait forever). Tickets sort by request time, so the
// parent asks the time two seconds late: its ticket sorts after the child's, which is the interleaving these tests mean (the
// child reached the lock first). Nothing else reads this clock here: the stale holder is judged by its pid.
const late = () => Date.now() + 2000;
const staleJob = (f, run = '41') => {
  mkdirSync(f.lock, { recursive: true });
  writeFileSync(join(f.lock, 'owner.json'), JSON.stringify({ pid: deadPid(), host: hostname(), repo: 'delorenj/gruvato', run, started_at: new Date(Date.now() - 5000).toISOString() }));
};

test('the Queued set is adb, s24, mac-ios, the emulator gate and its slots; nothing else', () => {
  assert.deepEqual([...QUEUED], ['adb', 's24', 'mac-ios', 'emulator']);
  assert.deepEqual(['adb', 's24', 'mac-ios', 'emulator', 'emulator-0', 'emulator-12'].filter(isQueued).length, 6);
  assert.deepEqual(['s3-tolt', 's3-index', 'emulator-reaper', 'emulator-x', 's26', 'adbx'].filter(isQueued), []);
});

test('a release is recorded exactly once, by the holder, and leaves no tomb', async () => {
  const f = fixture();
  try {
    let clock = Date.parse('2026-11-23T10:00:00Z');
    await lease(f, { id: 'once', now: () => clock });
    clock += 30_000;
    assert.equal(releaseLease('adb', 'once', { env: f.env, now: () => clock }).released, true);
    assert.equal(releaseLease('adb', 'once', { env: f.env, now: () => clock }).reason, 'none');
    // A job that waits 5 s behind a lease: its held_ms is the hold alone, not the wait.
    await lease(f, { id: 'blocker', now: () => clock });
    const sleep = async () => { clock += 5000; releaseLease('adb', 'blocker', { env: f.env, now: () => clock }); };
    await withLock('adb', async () => { clock += 1000; }, { env: f.env, log: f.log, now: () => clock, sleep, pollMs: 1 });
    const got = holds(f);
    assert.deepEqual(got.map(event => [event.event, event.lock, event.hold_kind, event.lease_id, event.reason, event.held_ms]), [
      ['release', 'adb', 'lease', 'once', 'by-id', 30_000],
      ['release', 'adb', 'lease', 'blocker', 'by-id', 5000],
      ['release', 'adb', 'job', null, 'done', 1000],
    ]);
    assert.deepEqual(got[0].claimant, { kind: 'agent', holder: 'agent-a', repo: 'delorenj/example', run: '9', attempt: null, job: null });
    assert.equal(got[0].ts, '2026-11-23T10:00:30.000Z');
    assert.equal(got[0].format, 1);
    assert.ok(!existsSync(f.lock));
    assert.deepEqual(tombs(f), []);
  } finally { f.cleanup(); }
});

test('a reclaim is recorded once with why, and an expired lease is held only until its expiry', async () => {
  const f = fixture();
  try {
    let clock = Date.parse('2026-11-23T10:00:00Z');
    await lease(f, { id: 'old', forMs: 60_000, now: () => clock });
    clock += 3600_000;
    await lease(f, { id: 'new', now: () => clock });
    const got = holds(f);
    assert.deepEqual(got.map(event => [event.event, event.lease_id, event.reason, event.held_ms]), [['reclaim', 'old', 'expired', 60_000]]);
    assert.ok(f.logs.some(line => /^HUB_LOCK_RECLAIMED adb from lease old/.test(line)), 'the log line is unchanged');
    assert.deepEqual(tombs(f), []);
  } finally { f.cleanup(); }
});

test('two reclaimers race on one stale lock: one reclaim event, and the loser never removes the lock a third process took', async () => {
  const f = fixture();
  try {
    staleJob(f);
    let raced = false;
    // B judged the job stale. Before its rename, A (another process) reclaims it too and takes the lock as a lease.
    const beforeRetire = step => { if (step === 'rename' && !raced) { raced = true; otherProcess(f, "await lock.acquireLease('adb', { holder: 'agent-c', why: 'third', forMs: 60000, id: 'third', waitMs: 5000, pollMs: 5, log: () => {} });"); } };
    await assert.rejects(withLock('adb', async () => { throw new Error('B must not run'); }, { env: f.env, log: f.log, timeoutMs: 60, pollMs: 5, beforeRetire, now: late }), /held by lease third/);
    assert.ok(raced);
    assert.equal(owner(f).lease_id, 'third', "the third process's lock survives B's rename");
    const got = holds(f);
    assert.deepEqual(got.map(event => [event.event, event.hold_kind, event.claimant.run, event.reason]), [['reclaim', 'job', '41', 'holder-gone']], 'exactly one reclaim, by A');
    assert.ok(!f.logs.some(line => line.startsWith('HUB_LOCK_RECLAIMED')), 'the loser does not claim a reclaim');
    assert.deepEqual(tombs(f), []);
  } finally { f.cleanup(); }
});

test('the same race through acquireLease: the losing lease reclaimer writes nothing and leaves the winner alone', async () => {
  const f = fixture();
  try {
    staleJob(f);
    let raced = false;
    // A deploy job in another process reclaims and finishes; a third holder (an older pin's bare mkdir) takes the lock.
    const third = { pid: process.pid, host: hostname(), repo: 'delorenj/third', run: '3', started_at: new Date().toISOString() };
    const beforeRetire = step => {
      if (step !== 'rename' || raced) return;
      raced = true;
      otherProcess(f, "await lock.withLock('adb', async () => {}, { log: () => {}, pollMs: 5 });");
      mkdirSync(f.lock);
      writeFileSync(join(f.lock, 'owner.json'), JSON.stringify(third));
    };
    await assert.rejects(lease(f, { id: 'loser', waitMs: 60, beforeRetire, now: late }), error => error.code === 'HUB_LOCK_TIMEOUT' && /held by delorenj\/third run 3/.test(error.message));
    assert.deepEqual(owner(f), third);
    assert.deepEqual(holds(f).map(event => event.event), ['reclaim', 'release']);
    assert.deepEqual(tombs(f), []);
  } finally { f.cleanup(); }
});

test('a rename that finds the lock gone writes nothing and is not an error', async () => {
  const f = fixture();
  try {
    staleJob(f);
    let raced = false;
    // A reclaims, runs and releases before B renames: B's rename hits ENOENT, and B then takes the free lock.
    const beforeRetire = step => { if (step === 'rename' && !raced) { raced = true; otherProcess(f, "await lock.withLock('adb', async () => {}, { log: () => {}, pollMs: 5 });"); } };
    const ran = [];
    await withLock('adb', async () => { ran.push('B'); }, { env: f.env, log: f.log, timeoutMs: 2000, pollMs: 5, beforeRetire, now: late });
    assert.deepEqual(ran, ['B']);
    assert.deepEqual(holds(f).map(event => [event.event, event.reason]), [['reclaim', 'holder-gone'], ['release', 'done'], ['release', 'done']]);
    assert.ok(!existsSync(f.lock));
    assert.deepEqual(tombs(f), []);
  } finally { f.cleanup(); }
});

test('a lock retaken between the rename and the put-back is dropped with HUB_LOCK_LOST and no event', async () => {
  const f = fixture();
  try {
    staleJob(f);
    let raced = false;
    const fourth = { pid: process.pid, host: hostname(), started_at: new Date().toISOString(), kind: 'lease', lease_id: 'fourth', holder: 'agent-d', why: 'd', expires_at: new Date(Date.now() + 60_000).toISOString() };
    const beforeRetire = step => {
      if (step === 'rename' && !raced) { raced = true; otherProcess(f, "await lock.acquireLease('adb', { holder: 'agent-c', why: 'third', forMs: 60000, id: 'third', waitMs: 5000, pollMs: 5, log: () => {} });"); }
      if (step === 'restore') { mkdirSync(f.lock); writeFileSync(join(f.lock, 'owner.json'), JSON.stringify(fourth)); }
    };
    await assert.rejects(withLock('adb', async () => {}, { env: f.env, log: f.log, timeoutMs: 60, pollMs: 5, beforeRetire, now: late }), /held by lease fourth/);
    assert.ok(f.logs.some(line => /^HUB_LOCK_LOST adb lease third of agent-c/.test(line)));
    assert.equal(owner(f).lease_id, 'fourth');
    assert.deepEqual(holds(f).map(event => event.event), ['reclaim'], "only A's reclaim");
    assert.deepEqual(tombs(f), []);
  } finally { f.cleanup(); }
});

test('a lock outside the Queued set retires through a tomb and writes no event', async () => {
  const f = fixture();
  try {
    const path = join(f.root, 'locks/s3-tolt.lock');
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, 'owner.json'), JSON.stringify({ pid: deadPid(), host: hostname(), repo: 'r', run: '1', started_at: new Date().toISOString() }));
    const ran = [];
    await withLock('s3-tolt', async () => { ran.push('job'); }, { env: f.env, log: f.log, pollMs: 5 });
    assert.deepEqual(ran, ['job']);
    assert.ok(f.logs.some(line => line.startsWith('HUB_LOCK_RECLAIMED s3-tolt')));
    assert.ok(!existsSync(path));
    assert.deepEqual(tombs(f), []);
    assert.ok(!existsSync(f.env.HUB_EVENT_DIR), 'no event was written');
  } finally { f.cleanup(); }
});

test('a tomb is never listed and never blocks the lock name, not even for an old bare mkdir', async () => {
  const f = fixture();
  try {
    const tomb = join(f.root, 'locks/adb.lock.tomb-1700000000000-4242');
    mkdirSync(tomb, { recursive: true });
    writeFileSync(join(tomb, 'owner.json'), JSON.stringify({ pid: process.pid, host: hostname(), started_at: new Date().toISOString() }));
    assert.deepEqual(listLocks({ env: f.env }), []);
    mkdirSync(f.lock); // what a pinned pre-tomb version does to take the lock
    writeFileSync(join(f.lock, 'owner.json'), JSON.stringify({ pid: process.pid, host: hostname(), repo: 'r', run: '2', started_at: new Date().toISOString() }));
    assert.deepEqual(listLocks({ env: f.env }).map(entry => entry.name), ['adb']);
    rmSync(f.lock, { recursive: true });
    assert.equal((await lease(f, { id: 'beside-a-tomb' })).lease_id, 'beside-a-tomb');
  } finally { f.cleanup(); }
});

// ---- every hold on a Queued lock is recorded, with liveness (AD-2, AD-4, AD-9, AD-19, MOBI-27) ----

const HOST_ID = 'test-machine-id';
const T0 = Date.parse('2026-11-23T10:00:00Z');
const at = ms => new Date(ms).toISOString();
// The event without its envelope (format, ts, host, host_id, hub_version), which Story 1.1 pins.
const body = ({ format, ts, host, host_id, hub_version, ...rest }) => rest;
const ciEnv = f => ({ ...f.env, GITHUB_RUN_ATTEMPT: '2', GITHUB_JOB: 'android' });
const fakeTimers = () => {
  const made = [];
  return {
    made,
    setInterval: (fn, ms) => { const timer = { fn, ms, unrefd: false, cleared: false, unref() { this.unrefd = true; return this; } }; made.push(timer); return timer; },
    clearInterval: timer => { timer.cleared = true; },
  };
};
const leaseClaimant = { kind: 'agent', holder: 'agent-a', repo: 'delorenj/example', run: '9', attempt: '2', job: 'android' };

test('a Lease is recorded as exactly request, acquire, release, each with the AD-9 body; owner.json gains the AD-2 keys', async () => {
  const f = fixture();
  try {
    const env = ciEnv(f);
    let clock = T0;
    const now = () => clock;
    const sleep = async () => { clock += 1000; };
    // Someone else's 3 s job holds adb first, so the Lease waits.
    const blocker = withLock('adb', () => new Promise(done => setTimeout(done, 30)), { env: f.env, log: () => {}, now, hostId: HOST_ID, timers: fakeTimers() });
    await settle(5);
    clock += 3000;
    const taking = acquireLease('adb', { holder: 'agent-a', why: 'device proof', forMs: 600_000, waitMs: 60_000, env, log: f.log, pollMs: 1, now, sleep: async () => { await settle(10); clock += 1000; }, hostId: HOST_ID });
    await blocker;
    const record = await taking;
    const took = Date.parse(record.started_at);
    const keys = owner(f);
    assert.deepEqual(Object.keys(keys).slice(0, 5), ['pid', 'host', 'repo', 'run', 'started_at'], 'the keys older versions read come first');
    assert.deepEqual([keys.format, keys.kind, keys.repo, keys.run, keys.attempt, keys.job, keys.host_id], [1, 'lease', 'delorenj/example', '9', '2', 'android', HOST_ID]);
    clock = took + 120_000;
    assert.equal(releaseLease('adb', record.lease_id, { env, now, hostId: HOST_ID }).released, true);
    const got = events(f).filter(event => event.lease_id === record.lease_id);
    const id = record.lease_id;
    assert.deepEqual(got.map(body), [
      { event: 'request', lock: 'adb', hold_kind: 'lease', claimant: leaseClaimant, lease_id: id, for_ms: 600_000, expires_at: null, deadline_at: at(T0 + 3000 + 60_000), waited_ms: null, held_ms: null, reason: null, last_alive_at: null },
      { event: 'acquire', lock: 'adb', hold_kind: 'lease', claimant: leaseClaimant, lease_id: id, for_ms: 600_000, expires_at: at(took + 600_000), deadline_at: at(T0 + 3000 + 60_000), waited_ms: took - (T0 + 3000), held_ms: null, reason: null, last_alive_at: null },
      { event: 'release', lock: 'adb', hold_kind: 'lease', claimant: leaseClaimant, lease_id: id, for_ms: 600_000, expires_at: at(took + 600_000), deadline_at: null, waited_ms: null, held_ms: 120_000, reason: 'by-id', last_alive_at: null },
    ]);
    assert.ok(got[1].waited_ms > 0, 'the wait behind the job is in waited_ms');
    assert.ok(got.every(event => event.host_id === HOST_ID && event.format === 1));
  } finally { f.cleanup(); }
});

test('a Lease wait that runs out leaves its queue as one timeout; the message and code are unchanged', async () => {
  const f = fixture();
  try {
    let clock = T0;
    const now = () => clock;
    await lease(f, { id: 'held', forMs: 3600_000, now, hostId: HOST_ID });
    await assert.rejects(lease(f, { id: 'late', waitMs: 5000, now, sleep: async () => { clock += 1000; }, pollMs: 1000, hostId: HOST_ID }),
      error => error.code === 'HUB_LOCK_TIMEOUT' && /^host lock adb is held by lease held of agent-a \(device proof\) until .*; gave up after 5s$/.test(error.message));
    const late = events(f).filter(event => event.lease_id === 'late');
    assert.deepEqual(late.map(event => [event.event, event.waited_ms, event.reason]), [['request', null, null], ['timeout', 5000, 'deadline']]);
    assert.match(late[1].blocked_by, /^lease held of agent-a/);
    assert.deepEqual(listWaiters('adb', { env: f.env }), [], 'the ticket is gone');
  } finally { f.cleanup(); }
});

test('a release that removes the ticket as the wait runs out wins: one cancel, no timeout, and acquire says cancelled', async () => {
  const f = fixture();
  try {
    let clock = T0;
    let armed = false;
    // The release lands inside the waiter's last pass, after its ticket check and before its own unlink.
    const now = () => { if (armed) { armed = false; releaseLease('adb', 'late', { env: f.env, now: () => clock }); } return clock; };
    await lease(f, { id: 'held', forMs: 3600_000, now });
    await assert.rejects(lease(f, { id: 'late', waitMs: 5000, now, pollMs: 1000, sleep: async () => { clock += 10_000; armed = true; } }), error => error.code === 'HUB_LEASE_CANCELLED');
    assert.deepEqual(events(f).filter(event => event.lease_id === 'late').map(event => [event.event, event.reason]), [['request', null], ['cancel', 'released']]);
  } finally { f.cleanup(); }
});

test('a waiter cancelled by a release, and one aborted, are each recorded once as a cancel', async () => {
  const f = fixture();
  try {
    await lease(f, { id: 'held', forMs: 3600_000 });
    // The ticket and the request are written before acquireLease first yields.
    const queued = lease(f, { id: 'queued', waitMs: 60_000 });
    assert.deepEqual(releaseLease('adb', 'queued', { env: f.env }), { released: false, cancelled: 1, reason: 'other-lease', owner: owner(f) });
    await assert.rejects(queued, error => error.code === 'HUB_LEASE_CANCELLED');
    const controller = new AbortController();
    const aborted = lease(f, { id: 'aborted', waitMs: 60_000, signal: controller.signal });
    await settle(20);
    controller.abort();
    await assert.rejects(aborted);
    const tail = events(f).filter(event => event.lease_id !== 'held');
    assert.deepEqual(tail.map(event => [event.event, event.lease_id, event.reason]), [
      ['request', 'queued', null], ['cancel', 'queued', 'released'],
      ['request', 'aborted', null], ['cancel', 'aborted', 'aborted'],
    ]);
    assert.ok(tail[1].waited_ms >= 0 && tail[1].claimant.holder === 'agent-a');
    assert.deepEqual(listWaiters('adb', { env: f.env }), []);
  } finally { f.cleanup(); }
});

test('a try (waitMs 0) records its acquire and nothing when it fails', async () => {
  const f = fixture();
  try {
    await lease(f, { id: 'tried', now: () => T0 });
    await assert.rejects(lease(f, { id: 'refused', now: () => T0 }), error => error.code === 'HUB_LOCK_TIMEOUT');
    assert.deepEqual(events(f).map(event => [event.event, event.lease_id, event.waited_ms]), [['acquire', 'tried', 0]]);
  } finally { f.cleanup(); }
});

test('withLock on a Queued name records request, acquire and release as a deploy job, and touches alive at most once a minute from an unref\'d timer', async () => {
  const f = fixture();
  try {
    const env = ciEnv(f);
    let clock = T0;
    const now = () => clock;
    const timers = fakeTimers();
    let inside;
    await withLock('adb', async () => {
      inside = owner(f);
      const alive = join(f.lock, 'alive');
      assert.equal(statSync(alive).mtimeMs, T0, 'touched at the take');
      assert.deepEqual(timers.made.map(timer => [timer.ms, timer.unrefd, timer.cleared]), [[ALIVE_MS, true, false]]);
      assert.equal(ALIVE_MS, 60_000);
      clock += ALIVE_MS;
      timers.made[0].fn();
      assert.equal(statSync(alive).mtimeMs, T0 + ALIVE_MS, 'the timer touches it');
      // A lock that changed hands is never touched by its old holder.
      writeFileSync(join(f.lock, 'owner.json'), JSON.stringify({ ...inside, pid: deadPid() }));
      clock += ALIVE_MS;
      timers.made[0].fn();
      assert.equal(statSync(alive).mtimeMs, T0 + ALIVE_MS);
      writeFileSync(join(f.lock, 'owner.json'), JSON.stringify(inside));
      clock += 1000;
    }, { env, log: f.log, now, hostId: HOST_ID, timers });
    assert.equal(timers.made[0].cleared, true, 'the timer stops with the hold');
    assert.deepEqual(Object.keys(inside), ['pid', 'host', 'repo', 'run', 'started_at', 'format', 'kind', 'attempt', 'job', 'host_id']);
    assert.deepEqual([inside.format, inside.kind, inside.attempt, inside.job, inside.host_id], [1, 'job', '2', 'android', HOST_ID]);
    const job = { kind: 'deploy', holder: null, repo: 'delorenj/example', run: '9', attempt: '2', job: 'android' };
    const base = { lock: 'adb', hold_kind: 'job', claimant: job, lease_id: null, for_ms: null, expires_at: null, held_ms: null, waited_ms: null, reason: null, last_alive_at: null };
    assert.deepEqual(events(f).map(body), [
      { ...base, event: 'request', deadline_at: at(T0 + 15 * 60_000) },
      { ...base, event: 'acquire', deadline_at: at(T0 + 15 * 60_000), waited_ms: 0 },
      { ...base, event: 'release', deadline_at: null, held_ms: 2 * ALIVE_MS + 1000, reason: 'done' },
    ]);
  } finally { f.cleanup(); }
});

test('withLock: the catch-up is a hub-job, a failed fn releases with reason error, and a wait that runs out is one timeout with today\'s message', async () => {
  const f = fixture();
  try {
    await assert.rejects(withLock('adb', async () => { throw new Error('boom'); }, { env: f.env, log: f.log, kind: 'hub-job', timers: fakeTimers() }), /boom/);
    assert.deepEqual(events(f).map(event => [event.event, event.hold_kind, event.claimant.kind, event.reason]), [
      ['request', 'job', 'hub-job', null], ['acquire', 'job', 'hub-job', null], ['release', 'job', 'hub-job', 'error'],
    ]);
    await assert.rejects(withLock('adb', async () => {}, { env: f.env, kind: 'deploy' }), /bad lock holder kind "deploy"/);
    let clock = T0;
    await lease(f, { id: 'held', forMs: 3600_000 });
    await assert.rejects(withLock('adb', async () => {}, { env: f.env, log: f.log, now: () => clock, sleep: async () => { clock += 60_000; }, timeoutMs: 120_000, timers: fakeTimers() }),
      // INTENDED CHANGE (Story 2.3): the timeout is coded now (it was uncoded on purpose in Story 1.4); the wording is the same.
      error => error.code === 'HUB_LOCK_TIMEOUT' && /^host lock adb is held by lease held of agent-a \(device proof\) until .*; gave up after 2 min\. Another deploy is using the device; run again when it finishes\.$/.test(error.message));
    const timedOut = events(f).filter(event => event.hold_kind === 'job').slice(3);
    assert.deepEqual(timedOut.map(event => [event.event, event.claimant.kind, event.waited_ms, event.reason]), [['request', 'deploy', null, null], ['timeout', 'deploy', 120_000, 'deadline']]);
    assert.match(timedOut[1].blocked_by, /^lease held of agent-a/);
  } finally { f.cleanup(); }
});

test('withLock on a name outside the Queued set writes no event and no alive file', async () => {
  const f = fixture();
  try {
    const timers = fakeTimers();
    await withLock('s3-index', async () => {
      assert.ok(!existsSync(join(f.root, 'locks/s3-index.lock/alive')));
    }, { env: f.env, log: f.log, timers });
    assert.deepEqual(timers.made, [], 'no timer');
    assert.ok(!existsSync(f.env.HUB_EVENT_DIR), 'no event was written');
  } finally { f.cleanup(); }
});

test('a job reclaim carries last_alive_at from the alive mtime (approx); a Lease reclaim ends held_ms at the death it observed', async () => {
  const f = fixture();
  try {
    staleJob(f);
    const lastAlive = Date.parse('2026-11-23T09:58:00Z');
    writeFileSync(join(f.lock, 'alive'), '');
    utimesSync(join(f.lock, 'alive'), new Date(lastAlive), new Date(lastAlive));
    await lease(f, { id: 'after-job' });
    releaseLease('adb', 'after-job', { env: f.env });
    staleJob(f, '42'); // from an older pin: never touched alive
    await lease(f, { id: 'after-old' });
    releaseLease('adb', 'after-old', { env: f.env });
    let clock = T0;
    await lease(f, { id: 'tied', forMs: 3600_000, holderPid: deadPid(), now: () => clock });
    clock += 10 * 60_000;
    await lease(f, { id: 'next', now: () => clock });
    const reclaims = events(f).filter(event => event.event === 'reclaim');
    assert.deepEqual(reclaims.map(event => [event.claimant.run, event.reason, event.last_alive_at, event.approx]), [
      ['41', 'holder-gone', at(lastAlive), true],
      ['42', 'holder-gone', null, undefined],
      ['9', 'holder-gone', null, undefined],
    ]);
    assert.equal(reclaims[2].lease_id, 'tied');
    assert.equal(reclaims[2].held_ms, 10 * 60_000, 'the reclaim observed the death before the expiry, so held_ms ends there');
  } finally { f.cleanup(); }
});

test('owners written by v1.2.43 (no format, kind for jobs, attempt, job or host_id) are still judged as before', async () => {
  const f = fixture();
  try {
    const started = new Date(Date.now() - 1000).toISOString();
    const v1243Lease = { pid: 4242, host: hostname(), repo: null, run: null, started_at: started, kind: 'lease', lease_id: 'old-lease', holder: 'agent-z', why: 'old', expires_at: new Date(Date.now() + 60_000).toISOString(), holder_pid: null, holder_process_start: null };
    mkdirSync(f.lock, { recursive: true });
    writeFileSync(join(f.lock, 'owner.json'), JSON.stringify(v1243Lease));
    assert.deepEqual(listLocks({ env: f.env }).map(entry => [entry.kind, entry.stale]), [['lease', false]]);
    await assert.rejects(lease(f, { id: 'blocked' }), /held by lease old-lease of agent-z/);
    writeFileSync(join(f.lock, 'owner.json'), JSON.stringify({ ...v1243Lease, expires_at: new Date(Date.now() - 1000).toISOString() }));
    assert.equal(listLocks({ env: f.env })[0].stale, true);
    await lease(f, { id: 'took' });
    const reclaim = events(f).find(event => event.event === 'reclaim');
    assert.deepEqual([reclaim.hold_kind, reclaim.claimant.kind, reclaim.lease_id, reclaim.reason, reclaim.claimant.attempt], ['lease', 'agent', 'old-lease', 'expired', null]);
    releaseLease('adb', 'took', { env: f.env });
    const v1243Job = { pid: process.pid, host: hostname(), repo: 'delorenj/gruvato', run: '7', started_at: started };
    mkdirSync(f.lock);
    writeFileSync(join(f.lock, 'owner.json'), JSON.stringify(v1243Job));
    assert.deepEqual(listLocks({ env: f.env }).map(entry => [entry.kind, entry.stale]), [['lock', false]], 'a live job from v1.2.43 is respected');
    writeFileSync(join(f.lock, 'owner.json'), JSON.stringify({ ...v1243Job, pid: deadPid() }));
    await lease(f, { id: 'after' });
    const job = events(f).filter(event => event.event === 'reclaim').at(-1);
    assert.deepEqual([job.hold_kind, job.claimant.kind, job.claimant.run, job.reason], ['job', 'deploy', '7', 'holder-gone']);
  } finally { f.cleanup(); }
});

// ---- Story 2.1: ticket format v1 and machine identity (AD-2, AD-3, AD-8) ----

const AD3_KEYS = ['format', 'kind', 'lease_id', 'holder', 'why', 'pid', 'host', 'host_id', 'process_start', 'enqueued_at', 'deadline_at', 'expires_at', 'repo', 'run', 'attempt', 'job', 'reservation', 'request', 'pool', 'eta', 'delivery'];
const NOW = Date.parse('2026-11-23T12:00:00.000Z');
const ago = ms => new Date(NOW - ms).toISOString();
const ahead = ms => new Date(NOW + ms).toISOString();
// Every seam injected: this host is `big-chungus` (machine id M1); pid 100 is alive with start 's100'; pid 200 is gone.
const seams = (extra = {}) => ({ now: () => NOW, host: 'big-chungus', hostId: 'M1', isAlive: pid => pid !== 200, processStart: pid => (pid === 100 ? 's100' : pid === 101 ? null : 'other'), ...extra });
const ticketOf = (extra = {}) => ({ format: 1, kind: 'lease', lease_id: 'x', holder: 'h', why: 'w', host: 'big-chungus', host_id: 'M1', enqueued_at: ago(1000), ...extra });

test('a Lease ticket carries exactly the AD-3 keys in order, keeps its file name, and says who and where', async () => {
  const f = fixture();
  try {
    await lease(f, { id: 'holder', hostId: 'M1', host: 'big-chungus' });
    const waiting = lease(f, { id: 'waiter', holder: 'agent-b', why: 'second', waitMs: 10_000, hostId: 'M1', host: 'big-chungus', env: { ...f.env, GITHUB_RUN_ATTEMPT: '2', GITHUB_JOB: 'android' } });
    await settle(30);
    const queue = join(f.root, 'locks/adb.queue');
    const [name] = readdirSync(queue);
    assert.match(name, /^\d{15}-\d{6}-\d{8}\.json$/, 'the file name is still <ms15>-<counter6>-<pid8>.json');
    assert.equal(name.slice(-13, -5), String(process.pid).padStart(8, '0'));
    const ticket = JSON.parse(readFileSync(join(queue, name), 'utf8'));
    assert.deepEqual(Object.keys(ticket), AD3_KEYS);
    assert.deepEqual({ format: ticket.format, kind: ticket.kind, lease_id: ticket.lease_id, holder: ticket.holder, why: ticket.why, pid: ticket.pid, host: ticket.host, host_id: ticket.host_id }, { format: 1, kind: 'lease', lease_id: 'waiter', holder: 'agent-b', why: 'second', pid: process.pid, host: 'big-chungus', host_id: 'M1' });
    assert.ok(ticket.process_start, 'the process lifetime is named');
    assert.equal(Date.parse(ticket.deadline_at) - Date.parse(ticket.enqueued_at), 10_000);
    assert.deepEqual([ticket.repo, ticket.run, ticket.attempt, ticket.job], ['delorenj/example', '9', '2', 'android']);
    assert.deepEqual([ticket.expires_at, ticket.reservation, ticket.request, ticket.pool, ticket.eta, ticket.delivery], [null, null, null, null, null, null], 'the keys later stories fill are present and empty');
    releaseLease('adb', 'waiter', { env: f.env });
    await assert.rejects(waiting, error => error.code === 'HUB_LEASE_CANCELLED');
  } finally { f.cleanup(); }
});

test('job and hub-job tickets use job:<repo>#<run>.<attempt>/<job> ids and always name a holder and why; this format writes no remote tickets', () => {
  const env = { GITHUB_REPOSITORY: 'delorenj/gruvato', GITHUB_RUN_ID: '77', GITHUB_RUN_ATTEMPT: '3', GITHUB_JOB: 'ios' };
  const job = buildTicket('job', { env, requested: NOW, deadline: NOW + 5000, host: 'mommymac.local', hostId: 'U1', pid: 4242, processStart: () => 'ps:start' });
  assert.deepEqual(Object.keys(job), AD3_KEYS);
  assert.deepEqual([job.format, job.kind, job.lease_id, job.holder, job.why], [1, 'job', 'job:delorenj/gruvato#77.3/ios', 'delorenj/gruvato#77', 'ios']);
  assert.deepEqual([job.pid, job.host, job.host_id, job.process_start, job.enqueued_at, job.deadline_at], [4242, 'mommymac.local', 'U1', 'ps:start', new Date(NOW).toISOString(), new Date(NOW + 5000).toISOString()]);
  assert.equal(jobLeaseId({ repo: 'a/b', run: 1, attempt: 2, job: 'plan' }), 'job:a/b#1.2/plan');
  assert.ok(!/^[a-z0-9][a-z0-9-]{0,63}$/.test(job.lease_id), 'a job id can never be a valid Lease id, so the two never collide');
  const hub = buildTicket('hub-job', { env: {}, requested: NOW, pid: 55, host: 'h', hostId: null, processStart: () => null });
  assert.deepEqual([hub.kind, hub.lease_id, hub.holder, hub.why, hub.host_id, hub.process_start, hub.repo, hub.run], ['hub-job', 'job:local#local-55.1/job', 'catch-up', 'catch-up install', null, null, null, null]);
  const named = buildTicket('job', { env, requested: NOW, holder: 'me', why: 'because', pid: 1, host: 'h', hostId: 'x', processStart: () => null });
  assert.deepEqual([named.holder, named.why], ['me', 'because']);
  assert.throws(() => buildTicket('remote', { requested: NOW }), /bad ticket kind "remote"/);
  assert.throws(() => buildTicket('mystery', { requested: NOW }), /bad ticket kind "mystery"/);
  assert.throws(() => buildTicket('lease', { requested: NOW, lease_id: 'x', holder: 'h' }), /names its lease id, holder and why/);
  assert.throws(() => buildTicket('job', {}), /real request time/);
});

test('ticket liveness follows AD-3 in order, one row per rule', () => {
  assert.equal(ticketKind({}), 'lease');
  assert.equal(ticketKind({ kind: null }), 'lease');
  assert.equal(ticketKind({ kind: 'job' }), 'job');
  assert.equal(ticketKind({ kind: 'remote' }), 'remote');
  assert.equal(ticketKind({ kind: 'from-the-future' }), 'from-the-future');
  const rows = [
    // rule 1: a missing kind is a lease, judged by pid
    ['no kind, pid alive with its recorded start', ticketOf({ kind: undefined, pid: 100, process_start: 's100' }), null],
    ['no kind, pid gone', ticketOf({ kind: undefined, pid: 200, process_start: 's200' }), 'gone'],
    // rule 2: the pid rule, positive evidence of death only
    ['pid alive, same start', ticketOf({ pid: 100, process_start: 's100' }), null],
    ['pid alive but now another process (start differs)', ticketOf({ pid: 100, process_start: 'old' }), 'pid-reused'],
    ['pid gone', ticketOf({ pid: 200, process_start: 's200' }), 'gone'],
    ['pid alive, start unreadable now', ticketOf({ pid: 101, process_start: 'recorded' }), null],
    ['pid alive, start never recorded', ticketOf({ pid: 100, process_start: null }), null],
    ['pid alive, expires_at long past (a pid ticket ignores it)', ticketOf({ pid: 100, process_start: 's100', expires_at: ago(3600_000) }), null],
    ['pid gone, expires_at in the future (the pid rule wins)', ticketOf({ pid: 200, expires_at: ahead(3600_000) }), 'gone'],
    // rule 3: no pid, expires_at
    ['no pid, expires_at in the future', ticketOf({ expires_at: ahead(1) }), null],
    ['no pid, expires_at past', ticketOf({ expires_at: ago(1) }), 'expired'],
    ['no pid, expires_at exactly now', ticketOf({ expires_at: ahead(0) }), 'expired'],
    ['no pid, expires_at future, enqueued_at long ago (expiry wins over age)', ticketOf({ expires_at: ahead(1000), enqueued_at: ago(3600_000) }), null],
    // rule 4: no pid, no expires_at: 60 s after enqueued_at
    ['no pid, no expiry, enqueued 59.999 s ago', ticketOf({ enqueued_at: ago(TICKET_ABSENT_MS - 1) }), null],
    ['no pid, no expiry, enqueued 60 s ago', ticketOf({ enqueued_at: ago(TICKET_ABSENT_MS) }), 'abandoned'],
    ['no pid, unparseable expiry, enqueued 61 s ago', ticketOf({ expires_at: 'soon', enqueued_at: ago(61_000) }), 'abandoned'],
    ['no pid, no expiry, no enqueued_at, no mtime', ticketOf({ enqueued_at: undefined }), 'abandoned'],
    // an unknown kind is never pruned for its kind alone
    ['unknown kind, pid alive', ticketOf({ kind: 'from-the-future', pid: 100, process_start: 's100' }), null],
    ['unknown kind, no pid, fresh', ticketOf({ kind: 'from-the-future', enqueued_at: ago(1000) }), null],
    ['unknown kind, no pid, future expiry', ticketOf({ kind: 'from-the-future', expires_at: ahead(5000), enqueued_at: ago(3600_000) }), null],
    ['unknown kind, pid gone (stale for the pid, not the kind)', ticketOf({ kind: 'from-the-future', pid: 200 }), 'gone'],
    ['remote, no pid, future expiry', ticketOf({ kind: 'remote', host: 'elsewhere', host_id: 'ELSE', expires_at: ahead(5000) }), null],
    // same host, by machine id then hostname (AD-8)
    ['same machine id, drifted hostname, pid alive', ticketOf({ host: 'big-chungus-2.local', pid: 100, process_start: 's100' }), null],
    ['same machine id, drifted hostname, pid gone', ticketOf({ host: 'big-chungus-2.local', pid: 200 }), 'gone'],
    ['no machine id on the ticket, same hostname, pid gone', ticketOf({ host_id: undefined, pid: 200 }), 'gone'],
    ['no machine id on the ticket, same hostname, pid alive', ticketOf({ host_id: undefined, pid: 100, process_start: 's100' }), null],
    // another host: a pid cannot be checked here
    ['v1, other host, pid, fresh', ticketOf({ host: 'elsewhere', host_id: 'ELSE', pid: 200, enqueued_at: ago(10_000) }), null],
    ['v1, other host, pid, 60 s old', ticketOf({ host: 'elsewhere', host_id: 'ELSE', pid: 200, enqueued_at: ago(60_000) }), 'abandoned'],
    ['v1, other host, pid, future expiry', ticketOf({ host: 'elsewhere', host_id: 'ELSE', pid: 200, expires_at: ahead(5000), enqueued_at: ago(3600_000) }), null],
    ['before v1a, other host, pid (pruned, AD-8)', ticketOf({ format: undefined, kind: undefined, host_id: undefined, host: 'elsewhere', pid: 100, process_start: 's100', enqueued_at: ago(10) }), 'foreign-host'],
  ];
  for (const [label, ticket, verdict] of rows) assert.equal(ticketStaleness(ticket, seams()), verdict, label);
  assert.equal(ticketStaleness(ticketOf({ enqueued_at: 'junk' }), seams({ mtimeMs: NOW - 5000 })), null, 'a junk enqueued_at falls back to the file mtime');
  assert.equal(ticketStaleness(ticketOf({ enqueued_at: 'junk' }), seams({ mtimeMs: NOW - 60_000 })), 'abandoned');
});

test('same host: equal machine ids win over drifted hostnames, otherwise the hostname decides', () => {
  assert.equal(sameHost({ host: 'mommymac.local', host_id: 'U1' }, { host: 'mommymac-2.local', host_id: 'U1' }), true, 'hostname drift');
  assert.equal(sameHost({ host: 'mommymac.local', host_id: 'U1' }, { host: 'mommymac.local', host_id: 'U1' }), true);
  assert.equal(sameHost({ host: 'a', host_id: 'U1' }, { host: 'b', host_id: 'U2' }), false, 'two ids and two names');
  assert.equal(sameHost({ host: 'a' }, { host: 'a', host_id: 'U1' }), true, 'one side has no id: the hostname decides');
  assert.equal(sameHost({ host: 'a', host_id: 'U1' }, { host: 'b' }), false);
  assert.equal(sameHost({ host: 'a', host_id: null }, { host: 'a', host_id: null }), true);
  assert.equal(sameHost({}, {}), false, 'a record with no host is on no host we can name');
  assert.equal(sameHost({ host: '' }, { host: '' }), false);
  assert.equal(sameHost(null, undefined), false);
});

test('hostId is the one machine id: cached per process by default, injectable, and what the writers record', () => {
  assert.equal(hostId(), hostId(), 'the default lookup is cached');
  assert.equal(hostId({ platform: 'linux', readFile: () => 'abc123\n' }), 'abc123', 'a test seam gets a fresh lookup');
  assert.equal(hostId(), hostId(), 'and does not disturb the cache');
});

test('a v1.2.43 lease ticket (no kind, no host_id) is a live lease by its pid and release <id> still cancels it', async () => {
  const f = fixture();
  try {
    const queue = join(f.root, 'locks/adb.queue');
    mkdirSync(queue, { recursive: true });
    const old = join(queue, '000000000000001-000000-00000001.json');
    const body = { lease_id: 'old-waiter', holder: 'agent-old', why: 'from v1.2.43', pid: process.pid, host: hostname(), process_start: processStartOf(process.pid), enqueued_at: new Date().toISOString() };
    writeFileSync(old, JSON.stringify(body));
    const [waiter] = listWaiters('adb', { env: f.env });
    assert.deepEqual([waiter.lease_id, waiter.stale, ticketKind(waiter)], ['old-waiter', false, 'lease']);
    assert.deepEqual(releaseLease('adb', 'old-waiter', { env: f.env }), { released: false, cancelled: 1, reason: 'none' });
    assert.ok(!existsSync(old), 'cancelled by lease id');
    assert.deepEqual(events(f).map(event => [event.event, event.lease_id, event.reason]), [['cancel', 'old-waiter', 'released']]);
    // and it blocks a newer lease ahead of it, as it always did
    writeFileSync(old, JSON.stringify(body));
    await assert.rejects(lease(f, { id: 'newer', waitMs: 40 }), /1 waiter ahead of lease newer/);
    assert.ok(existsSync(old));
  } finally { f.cleanup(); }
});

test('a ticket with no pid never strands the queue: live while its expiry is ahead, pruned once it is past or 60 s old', async () => {
  const f = fixture();
  try {
    const queue = join(f.root, 'locks/adb.queue');
    mkdirSync(queue, { recursive: true });
    const remote = join(queue, '000000000000001-000000-00000001.json');
    const write = body => writeFileSync(remote, JSON.stringify({ format: 1, kind: 'remote', lease_id: 'far', holder: 'elsewhere', why: 'waiting', pid: null, host: 'elsewhere', host_id: 'ELSE', ...body }));
    write({ expires_at: new Date(Date.now() + 60_000).toISOString(), enqueued_at: new Date(Date.now() - 3600_000).toISOString() });
    assert.deepEqual(listWaiters('adb', { env: f.env }).map(waiter => [waiter.lease_id, waiter.stale]), [['far', false]]);
    await assert.rejects(lease(f, { id: 'behind', waitMs: 40 }), /1 waiter ahead of lease behind/, 'a live pid-less ticket keeps its place');
    write({ expires_at: new Date(Date.now() - 1).toISOString(), enqueued_at: new Date().toISOString() });
    assert.equal(listWaiters('adb', { env: f.env })[0].stale, true, 'observing reports it');
    assert.ok(existsSync(remote), 'and never prunes');
    assert.equal((await lease(f, { id: 'free', waitMs: 100 })).lease_id, 'free', 'an expired ticket cannot starve a free lock');
    assert.ok(!existsSync(remote));
    releaseLease('adb', 'free', { env: f.env });
    write({ enqueued_at: new Date(Date.now() - 61_000).toISOString() });
    assert.equal((await lease(f, { id: 'free2', waitMs: 100 })).lease_id, 'free2', 'no pid and no expiry: pruned 60 s after enqueue');
  } finally { f.cleanup(); }
});

test('owner liveness uses the machine id: a drifted hostname is still this host, another machine id is not', async () => {
  const f = fixture();
  try {
    const dead = deadPid();
    const hold = extra => {
      mkdirSync(f.lock, { recursive: true });
      writeFileSync(join(f.lock, 'owner.json'), JSON.stringify({ pid: dead, host: 'mommymac-2.local', repo: null, run: null, started_at: new Date().toISOString(), kind: 'job', format: 1, host_id: 'U1', ...extra }));
    };
    // the Mac came back as mommymac.local: same machine id, so its dead job is reclaimed rather than honoured for 4 h
    hold({});
    assert.equal(listLocks({ env: f.env, host: 'mommymac.local', hostId: 'U1' })[0].stale, true);
    // a different machine id and a different name: another host, honoured
    assert.equal(listLocks({ env: f.env, host: 'mommymac.local', hostId: 'U2' })[0].stale, false);
    // an owner from before v1a has no machine id: the hostname decides, as before
    hold({ host_id: undefined });
    assert.equal(listLocks({ env: f.env, host: 'mommymac.local', hostId: 'U1' })[0].stale, false, 'other hostname, no id: honoured');
    assert.equal(listLocks({ env: f.env, host: 'mommymac-2.local', hostId: 'U1' })[0].stale, true, 'same hostname: judged by its dead pid');
    // a Lease holder pid on a drifted hostname
    writeFileSync(join(f.lock, 'owner.json'), JSON.stringify({ pid: process.pid, host: 'mommymac-2.local', host_id: 'U1', started_at: new Date().toISOString(), kind: 'lease', lease_id: 'l', holder: 'a', why: 'w', expires_at: new Date(Date.now() + 60_000).toISOString(), holder_pid: dead, holder_process_start: null }));
    assert.equal(listLocks({ env: f.env, host: 'mommymac.local', hostId: 'U1' })[0].stale, true, 'its holder pid is gone on this machine');
    assert.equal(listLocks({ env: f.env, host: 'mommymac.local', hostId: 'U2' })[0].stale, false, 'on another machine it cannot be checked');
    // withLock and acquireLease take the seams too
    const reclaimed = await lease(f, { id: 'took', host: 'mommymac.local', hostId: 'U1' });
    assert.equal(reclaimed.host, 'mommymac.local');
    assert.equal(reclaimed.host_id, 'U1');
  } finally { f.cleanup(); }
});

// Review (independent) of Story 2.1: kill(0, 0) and kill(-1, 0) succeed, and a pid rule that needs positive evidence of death
// would call such a ticket live for ever (v1.2.43 pruned it for its missing or unreadable process start).
test('a ticket whose pid is 0 or negative is no pid: it cannot strand the queue as an immortal process', async () => {
  for (const pid of [0, -1, -5]) {
    const live = ticketOf({ pid, process_start: null, enqueued_at: ago(1000) });
    assert.equal(ticketStaleness(live, { ...seams(), isAlive: () => true }), null, `pid ${pid}, fresh: judged as a pid-less ticket, still inside its 60 s`);
    assert.equal(ticketStaleness({ ...live, enqueued_at: ago(TICKET_ABSENT_MS) }, { ...seams(), isAlive: () => true }), 'abandoned', `pid ${pid}, 60 s old: pruned`);
    assert.equal(ticketStaleness({ ...live, enqueued_at: ago(TICKET_ABSENT_MS), expires_at: ahead(5000) }, { ...seams(), isAlive: () => true }), null, `pid ${pid} with a future expiry: live`);
  }
  const f = fixture();
  try {
    const queue = join(f.root, 'locks/adb.queue');
    mkdirSync(queue, { recursive: true });
    const junk = join(queue, '000000000000001-000000-00000001.json');
    writeFileSync(junk, JSON.stringify({ lease_id: 'ghost', holder: 'x', why: 'y', pid: 0, host: hostname(), process_start: null, enqueued_at: new Date(Date.now() - 61_000).toISOString() }));
    assert.equal((await lease(f, { id: 'free' , waitMs: 100 })).lease_id, 'free', 'a pid-0 ticket cannot starve a free lock');
    assert.ok(!existsSync(junk));
  } finally { f.cleanup(); }
});

// ---- Story 2.2: one queue view, and tries (AD-6) ----

const putTicket = (f, name, body = {}) => {
  const queue = join(f.root, 'locks/adb.queue');
  mkdirSync(queue, { recursive: true });
  const file = join(queue, name);
  writeFileSync(file, JSON.stringify({ lease_id: name.slice(16, 22), holder: 'someone', why: 'waiting', pid: process.pid, host: hostname(), enqueued_at: new Date().toISOString(), ...body }));
  return file;
};

test('queueView lists live tickets in file-name order with place, blocking, kind and identity; stale ones only on request, and only acquirers prune', async () => {
  const f = fixture();
  try {
    assert.deepEqual(queueView('adb', { env: f.env }), [], 'no queue directory is an empty view');
    putTicket(f, '000000000000030-000001-00000009.json', { lease_id: 'third', kind: 'job', repo: 'o/r', run: '7', attempt: '1', job: 'android' });
    putTicket(f, '000000000000010-000000-00000009.json', { lease_id: 'first' });
    const ghost = putTicket(f, '000000000000020-000000-00000009.json', { lease_id: 'ghost', pid: deadPid() });
    putTicket(f, '000000000000040-000000-00000009.json', { lease_id: 'hub', kind: 'hub-job' });
    putTicket(f, '000000000000050-000000-00000009.json', { lease_id: 'odd', kind: 'something-new' });
    writeFileSync(join(f.root, 'locks/adb.queue/not-a-ticket.txt'), 'x');
    const view = queueView('adb', { env: f.env });
    assert.deepEqual(view.map(entry => [entry.place, entry.lease_id, entry.kind, entry.blocking]), [
      [1, 'first', 'lease', true], [2, 'third', 'job', true], [3, 'hub', 'hub-job', true], [4, 'odd', 'something-new', true],
    ], 'file-name order, a missing kind is a lease, an unfamiliar kind still blocks');
    assert.deepEqual([view[1].repo, view[1].run, view[1].attempt, view[1].job, view[1].file], ['o/r', '7', '1', 'android', '000000000000030-000001-00000009.json']);
    assert.deepEqual(queueView('adb', { env: f.env, includeStale: true }).map(entry => [entry.place, entry.lease_id, entry.stale, entry.blocking]), [
      [1, 'first', false, true], [2, 'ghost', true, false], [3, 'third', false, true], [4, 'hub', false, true], [5, 'odd', false, true],
    ], 'status keeps showing a dead ticket, in its place, and it blocks nothing');
    assert.ok(existsSync(ghost), 'observing prunes nothing');
    assert.equal(queueView('adb', { env: f.env, prune: true, policy: { queue: {} } }).length, 4);
    assert.ok(!existsSync(ghost), 'an acquirer prunes it');
  } finally { f.cleanup(); }
});

test('a try writes no ticket: it takes a free lock with one acquire, and fails with no ticket and no event when the lock is held or anyone waits', async () => {
  const f = fixture();
  try {
    const got = await lease(f, { id: 'tried' });
    assert.equal(got.lease_id, 'tried');
    assert.ok(!existsSync(join(f.root, 'locks/adb.queue')), 'a try never even makes the queue directory');
    assert.deepEqual(events(f).map(event => [event.event, event.lease_id]), [['acquire', 'tried']]);
    // held
    await assert.rejects(lease(f, { id: 'held-out' }), error => error.code === 'HUB_LOCK_TIMEOUT' && /^host lock adb is held by lease tried of agent-a .*; gave up after 0s$/.test(error.message));
    // a waiter in line: even a free lock is not the try's to take
    releaseLease('adb', 'tried', { env: f.env });
    putTicket(f, '000000000000001-000000-00000009.json', { lease_id: 'waiting' });
    const before = events(f).length;
    await assert.rejects(lease(f, { id: 'jumper' }), error => error.code === 'HUB_LOCK_TIMEOUT' && /^host lock adb is held by an unknown holder; 1 waiter ahead of lease jumper \(1\. someone \(waiting\)\); gave up after 0s$/.test(error.message));
    assert.ok(!existsSync(f.lock), 'it did not take the lock');
    assert.deepEqual(readdirSync(join(f.root, 'locks/adb.queue')), ['000000000000001-000000-00000009.json'], 'and left no ticket');
    assert.equal(events(f).length, before, 'the failed tries wrote no event');
    assert.deepEqual(tombs(f), []);
  } finally { f.cleanup(); }
});

// AD-6: the mkdir can win a lock that a blocking entry was about to be first for. afterTake lands that entry between the mkdir
// and the re-check, the way a slower writer's earlier ticket would.
test('an acquirer whose mkdir won gives the lock back by tombstone when a blocking entry stands ahead, writes nothing, and keeps waiting', async () => {
  const f = fixture();
  try {
    let injected = null;
    const taking = lease(f, { id: 'late', waitMs: 10_000, afterTake: () => { injected ??= putTicket(f, '000000000000001-000000-00000009.json', { lease_id: 'earlier' }); } });
    await settle(40);
    assert.ok(injected && !existsSync(f.lock), 'the lock was given back, and the waiter has not taken it');
    assert.deepEqual(events(f).map(event => event.event), ['request'], 'a give-back is neither an acquire, a release nor a reclaim');
    assert.deepEqual(tombs(f), [], 'the tombstone was deleted by the winner');
    assert.deepEqual(queueView('adb', { env: f.env }).map(entry => entry.lease_id), ['earlier', 'late'], 'it kept its own place');
    rmSync(injected);
    const record = await taking;
    assert.equal(record.lease_id, 'late');
    assert.deepEqual(events(f).map(event => event.event), ['request', 'acquire']);
    // a try gives it back too, and fails instead of waiting
    releaseLease('adb', 'late', { env: f.env });
    const before = events(f).length;
    await assert.rejects(lease(f, { id: 'quick', afterTake: () => { injected = putTicket(f, '000000000000002-000000-00000009.json', { lease_id: 'earlier-2' }); } }), error => error.code === 'HUB_LOCK_TIMEOUT' && /1 waiter ahead of lease quick/.test(error.message));
    assert.ok(!existsSync(f.lock) && events(f).length === before, 'nothing held, nothing written');
  } finally { f.cleanup(); }
});

test('a Pool request writes one request and one ending; a try tagged with it names the Pool and measures waited_ms from the request', async () => {
  const f = fixture();
  try {
    let clock = T0;
    const now = () => clock;
    const request = poolRequest('phone', { id: 'req-1', holder: 'agent-a', why: 'any phone', forMs: 600_000, waitMs: 30_000, env: f.env, now, hostId: HOST_ID });
    assert.equal(request.id, 'req-1');
    clock += 12_000;
    await lease(f, { id: 'req-1', now, hostId: HOST_ID, pool: request.tag, forMs: 600_000 });
    const got = events(f);
    assert.deepEqual(got.map(event => [event.event, event.lock, event.pool, event.request, event.waited_ms]), [
      ['request', null, 'phone', 'req-1', null],
      ['acquire', 'adb', 'phone', 'req-1', 12_000],
    ], 'the acquire is the request\'s ending: nothing more is written for it');
    assert.equal(got[0].deadline_at, new Date(T0 + 30_000).toISOString());
    assert.equal(got[0].for_ms, 600_000);
    assert.equal(got[1].deadline_at, got[0].deadline_at, 'the take carries the request\'s deadline');
    assert.deepEqual([got[0].hold_kind, got[0].claimant.kind, got[0].claimant.holder, got[0].lease_id], ['lease', 'agent', 'agent-a', 'req-1']);
    releaseLease('adb', 'req-1', { env: f.env, now, hostId: HOST_ID });
    // endings: busy and away are one timeout each, an abort and any other error a cancel; settling twice is one ending
    const endings = [];
    for (const [error, signal] of [[Object.assign(new Error('busy'), { code: 'HUB_LOCK_TIMEOUT' }), undefined], [Object.assign(new Error('gone'), { code: 'HUB_PHONE_AWAY' }), undefined], [new Error('boom'), undefined], [Object.assign(new Error('x'), { name: 'AbortError' }), undefined], [Object.assign(new Error('r'), { code: 'HUB_LEASE_CANCELLED' }), undefined]]) {
      const ending = poolRequest('emulator', { id: 'e-1', holder: 'a', why: 'w', env: f.env, now, hostId: HOST_ID });
      ending.settle(error, { signal });
      ending.settle(new Error('again'));
      endings.push(events(f).filter(event => event.request === 'e-1').slice(-2).map(event => [event.event, event.reason]));
    }
    assert.deepEqual(endings.map(pair => pair[1]), [['timeout', 'deadline'], ['timeout', 'away'], ['cancel', 'error'], ['cancel', 'aborted'], ['cancel', 'released']]);
    assert.equal(events(f).filter(event => event.request === 'e-1').length, 10, 'five requests, five endings, never six');
  } finally { f.cleanup(); }
});

// Review (independent) of Story 2.2: tries write no ticket, so every try races the others' mkdir. A loser that reads the lock
// at the instant its holder released it (owner null, the directory gone: verdict `gone`) used to "reclaim" it, and the retire
// would rename whatever fresh, ownerless directory a third taker had just made there, stealing a lock it never judged: a bogus
// `reclaim` event, a taker whose owner write died with ENOENT, and under load two holders at once. `gone` means nothing is
// there to retire. A dangling symlink is the deterministic stand-in: mkdir says EEXIST, the owner is unreadable and stat says
// gone; the beforeRetire seam is where a third taker would land its fresh directory.
const dangling = f => {
  mkdirSync(join(f.root, 'locks'), { recursive: true });
  symlinkSync(join(f.root, 'nothing-here'), f.lock);
  const calls = [];
  return { calls, beforeRetire: step => { calls.push(step); rmSync(f.lock, { force: true }); mkdirSync(f.lock); } };
};

test('a try that finds the lock gone under it does not retire it: a fresh ownerless directory is never renamed away', async () => {
  const f = fixture();
  try {
    const seam = dangling(f);
    await assert.rejects(lease(f, { id: 'tries', beforeRetire: seam.beforeRetire }), error => error.code === 'HUB_LOCK_TIMEOUT');
    assert.deepEqual(seam.calls, [], 'nothing was judged, so nothing was retired');
    assert.deepEqual(events(f), [], 'no reclaim of a lock that was never stale');
    assert.deepEqual(tombs(f), []);
  } finally { f.cleanup(); }
});

test('a withLock caller that finds the lock gone under it does not retire it either', async () => {
  const f = fixture();
  try {
    const seam = dangling(f);
    let clock = Date.now();
    await assert.rejects(withLock('adb', async () => { throw new Error('must not run'); }, { env: f.env, log: f.log, timeoutMs: 1000, pollMs: 1, sleep: async () => {}, now: () => (clock += 400), beforeRetire: seam.beforeRetire }), /host lock adb is held/);
    assert.deepEqual(seam.calls, []);
    assert.deepEqual(events(f).map(event => event.event), ['request', 'timeout'], 'no reclaim of a lock that was never stale');
    assert.deepEqual(tombs(f), []);
  } finally { f.cleanup(); }
});

// ---- Story 2.3: deploy jobs and the catch-up join the Queue (AD-4, AD-5, AD-15) ----

const jobEnv = (f, job, attempt = '1') => ({ ...f.env, GITHUB_JOB: job, GITHUB_RUN_ATTEMPT: attempt });
const asJob = (f, job, extra = {}) => withLock('adb', async () => { extra.served?.push(job); }, { env: jobEnv(f, job), log: f.log, pollMs: 5, timeoutMs: 10_000, timers: fakeTimers(), ...extra });
const queueOf = (f, name = 'adb') => queueView(name, { env: f.env }).map(entry => [entry.place, entry.kind, entry.lease_id]);

test('a Queued withLock waits as a job ticket with the run identity, and the ticket is gone once it has the lock', async () => {
  const f = fixture();
  try {
    await lease(f, { id: 'holder' });
    const waiting = asJob(f, 'android', { env: jobEnv(f, 'android', '2') });
    await settle(30);
    const [ticket] = queueView('adb', { env: f.env });
    assert.deepEqual({ format: ticket.format, kind: ticket.kind, lease_id: ticket.lease_id, holder: ticket.holder, why: ticket.why, pid: ticket.pid, host: ticket.host, repo: ticket.repo, run: ticket.run, attempt: ticket.attempt, job: ticket.job },
      { format: 1, kind: 'job', lease_id: 'job:delorenj/example#9.2/android', holder: 'delorenj/example#9', why: 'android', pid: process.pid, host: hostname(), repo: 'delorenj/example', run: '9', attempt: '2', job: 'android' });
    assert.match(ticket.enqueued_at, /^\d{4}-\d\d-\d\dT/);
    releaseLease('adb', 'holder', { env: f.env });
    await waiting;
    assert.deepEqual(queueOf(f), [], 'the ticket left the queue with the take');
    assert.ok(!existsSync(f.lock));
    assert.deepEqual(events(f).filter(event => event.hold_kind === 'job').map(event => [event.event, event.claimant.kind, event.claimant.job]), [['request', 'deploy', 'android'], ['acquire', 'deploy', 'android'], ['release', 'deploy', 'android']]);
  } finally { f.cleanup(); }
});

test('a deploy job enqueued before a Lease is served first, and the reverse', async () => {
  const f = fixture();
  try {
    for (const order of [['job', 'lease'], ['lease', 'job']]) {
      await lease(f, { id: 'holder' });
      const served = [];
      const start = kind => (kind === 'job'
        ? asJob(f, 'job', { served })
        : lease(f, { id: 'later', waitMs: 10_000 }).then(() => { served.push('lease'); releaseLease('adb', 'later', { env: f.env }); }));
      const first = start(order[0]);
      await settle(25);
      const second = start(order[1]);
      await settle(25);
      assert.deepEqual(queueOf(f).map(([place, kind]) => [place, kind === 'job' ? 'job' : 'lease']), [[1, order[0]], [2, order[1]]], `${order.join(' then ')} wait in that order`);
      releaseLease('adb', 'holder', { env: f.env });
      await Promise.all([first, second]);
      assert.deepEqual(served, order, `${order[0]} came first and is served first`);
      assert.deepEqual(queueOf(f), []);
    }
  } finally { f.cleanup(); }
});

test('a free Resource with an empty Queue is taken at once: no sleep, one request, acquire and release, no ticket left', async () => {
  const f = fixture();
  try {
    const ran = [];
    await withLock('adb', async () => { ran.push('job'); }, { env: jobEnv(f, 'android'), log: f.log, now: () => T0, timers: fakeTimers(), sleep: async () => { throw new Error('a free lock is not waited for'); } });
    assert.deepEqual(ran, ['job']);
    assert.deepEqual(events(f).map(event => [event.event, event.waited_ms]), [['request', null], ['acquire', 0], ['release', null]]);
    assert.deepEqual(queueOf(f), []);
    assert.ok(!existsSync(f.lock));
  } finally { f.cleanup(); }
});

test('the iOS jobs and the iPad catch-up share one mac-ios FIFO, served in arrival order from tickets on this host', async () => {
  const f = fixture();
  try {
    await acquireLease('mac-ios', { holder: 'agent-a', why: 'iPad proof', forMs: 60_000, id: 'ipad', env: f.env, log: f.log, pollMs: 5 });
    const served = [];
    const wants = (kind, job) => withLock('mac-ios', async () => { served.push(`${kind}:${job}`); }, { env: jobEnv(f, job), log: f.log, kind, pollMs: 5, timeoutMs: 10_000, timers: fakeTimers() });
    const waiting = [];
    for (const [kind, job] of [['job', 'ios'], ['hub-job', 'catchup'], ['job', 'ios-second']]) { waiting.push(wants(kind, job)); await settle(25); }
    assert.deepEqual(queueView('mac-ios', { env: f.env }).map(entry => [entry.place, entry.kind, entry.job]), [[1, 'job', 'ios'], [2, 'hub-job', 'catchup'], [3, 'job', 'ios-second']]);
    const [catchup] = queueView('mac-ios', { env: f.env }).filter(entry => entry.kind === 'hub-job');
    assert.deepEqual([catchup.holder, catchup.why, catchup.host, catchup.lease_id], ['catch-up', 'catch-up install', hostname(), 'job:delorenj/example#9.1/catchup']);
    releaseLease('mac-ios', 'ipad', { env: f.env });
    await Promise.all(waiting);
    assert.deepEqual(served, ['job:ios', 'hub-job:catchup', 'job:ios-second']);
    assert.deepEqual(queueOf(f, 'mac-ios'), []);
  } finally { f.cleanup(); }
});

test('a Queued withLock that runs out is HUB_LOCK_TIMEOUT: `host lock <name> is held`, the holder, the waiters ahead with their places; the catch-up\'s is a hub-job timeout', async () => {
  const f = fixture();
  try {
    let clock = T0;
    const now = () => clock;
    await lease(f, { id: 'held', forMs: 3600_000, now });
    putTicket(f, '000000000000001-000000-00000009.json', { lease_id: 'ahead-1', holder: 'agent-b', why: 'first in line' });
    putTicket(f, '000000000000002-000000-00000009.json', { lease_id: 'ahead-2', holder: 'agent-c', why: 'second in line' });
    await assert.rejects(withLock('adb', async () => { throw new Error('must not run'); }, { env: jobEnv(f, 'catchup'), log: f.log, now, kind: 'hub-job', sleep: async () => { clock += 1000; }, timeoutMs: 3000, pollMs: 1000, timers: fakeTimers() }), error => {
      assert.equal(error.code, 'HUB_LOCK_TIMEOUT');
      assert.match(error.message, /^host lock adb is held by lease held of agent-a \(device proof\) until .*; 2 waiters ahead of catch-up job:delorenj\/example#9\.1\/catchup \(1\. agent-b \(first in line\), 2\. agent-c \(second in line\)\); gave up after 0 min\. Another deploy is using the device; run again when it finishes\.$/);
      assert.match(error.message, /host lock adb is held/, 'the catch-up regexes (catchup.mjs, mac-ios the same) still match');
      return true;
    });
    const mine = events(f).filter(event => event.claimant.kind === 'hub-job');
    assert.deepEqual(mine.map(event => [event.event, event.hold_kind, event.waited_ms, event.reason]), [['request', 'job', null, null], ['timeout', 'job', 3000, 'deadline']]);
    assert.match(mine[1].blocked_by, /^lease held of agent-a/);
    assert.deepEqual(queueOf(f).map(([place, kind]) => [place, kind]), [[1, 'lease'], [2, 'lease']], 'its own ticket left; the others kept their places');
    // a job from a deploy run says the same thing under its own kind
    await assert.rejects(withLock('adb', async () => {}, { env: jobEnv(f, 'android'), log: f.log, now, sleep: async () => { clock += 1000; }, timeoutMs: 1000, pollMs: 1000, timers: fakeTimers() }),
      error => error.code === 'HUB_LOCK_TIMEOUT' && /^host lock adb is held by lease held of agent-a/.test(error.message));
    assert.deepEqual(events(f).filter(event => event.claimant.kind === 'deploy').map(event => event.event), ['request', 'timeout']);
  } finally { f.cleanup(); }
});

test('withLock on an internal name keeps the bare path: no ticket, no queue, no event; its timeout is coded with today\'s wording', async () => {
  const f = fixture();
  try {
    const path = join(f.root, 'locks/s3-index.lock');
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, 'owner.json'), JSON.stringify({ pid: process.pid, host: hostname(), repo: 'delorenj/other', run: '5', started_at: new Date().toISOString() }));
    await assert.rejects(withLock('s3-index', async () => {}, { env: f.env, log: f.log, timeoutMs: 30, pollMs: 5 }),
      error => error.code === 'HUB_LOCK_TIMEOUT' && /^host lock s3-index is held by delorenj\/other run 5 \(pid \d+, since .*\); gave up after 0 min\. Another deploy is using the device; run again when it finishes\.$/.test(error.message));
    assert.ok(!existsSync(join(f.root, 'locks/s3-index.queue')), 'no queue');
    assert.ok(!existsSync(f.env.HUB_EVENT_DIR), 'no event');
  } finally { f.cleanup(); }
});

test('a Queued withLock try (timeoutMs 0) writes no ticket and no event unless it takes the lock, and a waiter ahead keeps it out', async () => {
  const f = fixture();
  try {
    const ran = [];
    await withLock('adb', async () => { ran.push('free'); }, { env: f.env, log: f.log, timeoutMs: 0, timers: fakeTimers() });
    assert.deepEqual(ran, ['free']);
    assert.ok(!existsSync(join(f.root, 'locks/adb.queue')), 'a try never makes the queue directory');
    assert.deepEqual(events(f).map(event => event.event), ['acquire', 'release']);
    putTicket(f, '000000000000001-000000-00000009.json', { lease_id: 'waiting' });
    const before = events(f).length;
    await assert.rejects(withLock('adb', async () => { throw new Error('must not run'); }, { env: f.env, log: f.log, timeoutMs: 0, timers: fakeTimers() }),
      error => error.code === 'HUB_LOCK_TIMEOUT' && /^host lock adb is held by an unknown holder; 1 waiter ahead of this job \(1\. someone \(waiting\)\); gave up after 0 min\./.test(error.message));
    assert.ok(!existsSync(f.lock), 'a free lock is not the try\'s to take while anyone waits');
    assert.deepEqual(readdirSync(join(f.root, 'locks/adb.queue')), ['000000000000001-000000-00000009.json']);
    assert.equal(events(f).length, before);
    assert.deepEqual(tombs(f), []);
  } finally { f.cleanup(); }
});

test('a Queued withLock that wins the mkdir while a blocking ticket lands ahead gives the lock back by tombstone and keeps waiting (AD-6 re-check)', async () => {
  const f = fixture();
  try {
    let ahead = null;
    const seen = [];
    const ran = [];
    await withLock('adb', async () => { ran.push('job'); assert.ok(existsSync(f.lock)); }, {
      env: jobEnv(f, 'android'), log: f.log, pollMs: 1, timeoutMs: 10_000, timers: fakeTimers(),
      afterTake: () => { ahead ??= putTicket(f, '000000000000001-000000-00000009.json', { lease_id: 'jumper' }); },
      sleep: async () => { seen.push(existsSync(f.lock)); rmSync(ahead, { force: true }); },
    });
    assert.deepEqual(seen, [false], 'the lock was given back while the blocker stood ahead');
    assert.deepEqual(ran, ['job'], 'and taken again once it left');
    assert.deepEqual(events(f).map(event => event.event), ['request', 'acquire', 'release'], 'the give-back is no event; one acquire');
    assert.deepEqual(tombs(f), []);
    assert.deepEqual(queueOf(f), []);
  } finally { f.cleanup(); }
});

test('a Queued withLock whose ticket is released while it waits is cancelled, not served; an error ends its wait as one cancel', async () => {
  const f = fixture();
  try {
    await lease(f, { id: 'holder' });
    const waiting = asJob(f, 'android');
    await settle(30);
    const [ticket] = queueView('adb', { env: f.env });
    assert.equal(releaseLease('adb', ticket.lease_id, { env: f.env }).cancelled, 1);
    await assert.rejects(waiting, error => error.code === 'HUB_LEASE_CANCELLED' && /^job job:delorenj\/example#9\.1\/android was released while it waited for adb$/.test(error.message));
    assert.deepEqual(queueOf(f), []);
    assert.equal(owner(f).lease_id, 'holder', 'the holder was not touched');
    assert.deepEqual(events(f).filter(event => event.claimant.job === 'android' || event.lease_id === ticket.lease_id).map(event => [event.event, event.reason, event.lease_id]), [['request', null, null], ['cancel', 'released', ticket.lease_id]], 'the release wrote the one cancel; the waiter, finding its ticket gone, wrote none');
    // an error while waiting (the lock path is not a directory we can take) leaves one cancel
    releaseLease('adb', 'holder', { env: f.env });
    const failing = asJob(f, 'ios', { afterTake: () => { throw new Error('boom'); } });
    await assert.rejects(failing, /boom/);
    assert.deepEqual(queueOf(f), []);
    assert.deepEqual(events(f).filter(event => event.claimant.job === 'ios').map(event => [event.event, event.reason]), [['request', null], ['cancel', 'error']]);
  } finally { f.cleanup(); }
});
