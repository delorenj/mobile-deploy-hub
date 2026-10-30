// Leases on the host lock (tools/ci/lib/lock.mjs): a lease outlives the process that took it, shares the lock directory and
// names with withLock so the two exclude each other, expires or is reclaimed when its holder is gone, and its waiters are
// served first in, first out. Everything runs against a temp HUB_LOCK_DIR.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireLease, listLocks, listWaiters, releaseLease, updateLease, withLock } from '../ci/lib/lock.mjs';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'hub-lease-'));
  const env = { HUB_LOCK_DIR: join(root, 'locks'), GITHUB_REPOSITORY: 'delorenj/example', GITHUB_RUN_ID: '9' };
  const logs = [];
  return { root, env, logs, log: line => logs.push(line), lock: join(root, 'locks/adb.lock'), cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
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
