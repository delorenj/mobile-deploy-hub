// Leases on the host lock (tools/ci/lib/lock.mjs): a lease outlives the process that took it, shares the lock directory and
// names with withLock so the two exclude each other, expires or is reclaimed when its holder is gone, and its waiters are
// served first in, first out. Everything runs against a temp HUB_LOCK_DIR.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { ALIVE_MS, QUEUED, acquireLease, isQueued, listLocks, listWaiters, releaseLease, updateLease, withLock } from '../ci/lib/lock.mjs';
import { readEvents } from '../ci/lib/events.mjs';
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

test('a legacy ticket without process_start is stale even when its pid is still alive', async () => {
  const f = fixture();
  try {
    const queue = join(f.root, 'locks/adb.queue');
    mkdirSync(queue, { recursive: true });
    const ghost = join(queue, '000000000000001-000000-00000001.json');
    writeFileSync(ghost, JSON.stringify({ lease_id: 'legacy', holder: 'old', why: 'gone', pid: process.pid, host: hostname(), enqueued_at: new Date().toISOString() }));
    assert.equal(listWaiters('adb', { env: f.env })[0].stale, true, 'reported stale, not trusted');
    assert.ok(existsSync(ghost), 'observing never prunes');
    assert.equal((await lease(f, { id: 'next', waitMs: 100 })).lease_id, 'next', 'the legacy ticket cannot starve a free lock');
    assert.ok(!existsSync(ghost), 'acquisition prunes it');
  } finally { f.cleanup(); }
});

test('a waiter that times out leaves the queue; a queued lease says how many are ahead', async () => {
  const f = fixture();
  try {
    await lease(f, { id: 'holder' });
    const first = lease(f, { id: 'one', waitMs: 10_000 });
    await settle(10);
    await assert.rejects(lease(f, { id: 'two', waitMs: 40 }), /has 1 waiter ahead of lease two/);
    assert.deepEqual(listWaiters('adb', { env: f.env }).map(waiter => waiter.lease_id), ['one']);
    releaseLease('adb', 'one', { env: f.env });
    await assert.rejects(first, error => error.code === 'HUB_LEASE_CANCELLED');
  } finally { f.cleanup(); }
});

test('a release that lands while the lease is being taken wins: the record is taken back and acquire says cancelled', async () => {
  const f = fixture();
  try {
    await assert.rejects(lease(f, { id: 'racing', beforeClaim: () => releaseLease('adb', 'racing', { env: f.env }) }), error => error.code === 'HUB_LEASE_CANCELLED');
    assert.ok(!existsSync(f.lock), 'no orphan record');
    // a release that removed the ticket but had not yet looked at the record: acquire takes its own record back
    const queue = join(f.root, 'locks/adb.queue');
    await assert.rejects(lease(f, { id: 'racing-2', beforeClaim: () => { for (const file of readdirSync(queue)) rmSync(join(queue, file)); } }), error => error.code === 'HUB_LEASE_CANCELLED');
    assert.ok(!existsSync(f.lock), 'its own record is gone too');
    // Intended change (Story 1.4): the release cancelled a request that never acquired, so its history is one cancel.
    assert.deepEqual(events(f).map(event => [event.event, event.lease_id, event.reason]), [['cancel', 'racing', 'released']], 'one cancel; a give-back is neither a release nor an acquire');
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
    const beforeRetire = step => { if (step === 'rename' && !raced) { raced = true; otherProcess(f, "await lock.acquireLease('adb', { holder: 'agent-c', why: 'third', forMs: 60000, id: 'third', pollMs: 5, log: () => {} });"); } };
    await assert.rejects(withLock('adb', async () => { throw new Error('B must not run'); }, { env: f.env, log: f.log, timeoutMs: 60, pollMs: 5, beforeRetire }), /held by lease third/);
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
    await assert.rejects(lease(f, { id: 'loser', waitMs: 60, beforeRetire }), error => error.code === 'HUB_LOCK_TIMEOUT' && /held by delorenj\/third run 3/.test(error.message));
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
    await withLock('adb', async () => { ran.push('B'); }, { env: f.env, log: f.log, timeoutMs: 2000, pollMs: 5, beforeRetire });
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
      if (step === 'rename' && !raced) { raced = true; otherProcess(f, "await lock.acquireLease('adb', { holder: 'agent-c', why: 'third', forMs: 60000, id: 'third', pollMs: 5, log: () => {} });"); }
      if (step === 'restore') { mkdirSync(f.lock); writeFileSync(join(f.lock, 'owner.json'), JSON.stringify(fourth)); }
    };
    await assert.rejects(withLock('adb', async () => {}, { env: f.env, log: f.log, timeoutMs: 60, pollMs: 5, beforeRetire }), /held by lease fourth/);
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
      error => error.code === undefined && /^host lock adb is held by lease held of agent-a \(device proof\) until .*; gave up after 2 min\. Another deploy is using the device; run again when it finishes\.$/.test(error.message));
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
