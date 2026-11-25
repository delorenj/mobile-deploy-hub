// Story 7.6: forceRelease (lock.mjs), the one writer that ends a Lease by force. Hermetic: temp lock and event dirs, a frozen clock, a real
// (short) poll sleep so a live waiter can be served next.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { readEvents } from './lib/events.mjs';
import { acquireLease, forceRelease, forceReleaseJobError, leaseHoldersSince, readOwner } from './lib/lock.mjs';
import { hermetic } from './test-fixtures.mjs';

hermetic();

const MIN = 60_000;
const OPS = { holder: 'ops', via: 'api' };
const settle = ms => new Promise(done => setTimeout(done, ms));
const until = async (check, what) => {
  for (let tries = 0; tries < 1000; tries += 1) { if (check()) return; await settle(10); }
  assert.fail(`never happened: ${what}`);
};

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'hub-force-release-'));
  const env = { HUB_LOCK_DIR: join(root, 'locks'), HUB_EVENT_DIR: join(root, 'events') };
  const clock = Date.now();
  const f = {
    root, env, now: () => clock,
    events: () => [...readEvents({ env })],
    entries: () => { try { return readdirSync(env.HUB_LOCK_DIR).sort(); } catch { return []; } },
    path: name => join(env.HUB_LOCK_DIR, `${name}.lock`),
    owner: name => readOwner(f.path(name)),
    ownerText: name => readFileSync(join(f.path(name), 'owner.json'), 'utf8'),
    hold: (name, id) => acquireLease(name, { holder: `holder-${id}`, why: 'device proof', forMs: 30 * MIN, id, env, log: () => {}, now: f.now }),
    wait: (name, id) => acquireLease(name, { holder: `waiter-${id}`, why: 'wants it', forMs: 5 * MIN, waitMs: 10 * MIN, id, env, log: () => {}, now: f.now, pollMs: 5, sleep: () => settle(5) }),
    force: (name, options = {}) => forceRelease(name, { actor: OPS, why: 'stuck', env, now: f.now, log: () => {}, ...options }),
    // A lock held by a Job Hold, as each kind of owner record is on disk.
    plant: (name, owner) => {
      mkdirSync(f.path(name), { recursive: true });
      writeFileSync(join(f.path(name), 'owner.json'), JSON.stringify({ format: 1, pid: process.pid, host: hostname(), started_at: new Date(clock).toISOString(), ...owner }));
    },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
  return f;
}

test('a Lease is force-released: the lock is gone, exactly one force-release event carries the actor, why, lease id, claimant and held_ms', async () => {
  const f = fixture();
  try {
    await f.hold('s24', 'a-1');
    const owner = f.owner('s24');
    const result = f.force('s24', { lease_id: 'a-1' });
    assert.deepEqual(result, { released: true, owner });
    assert.equal(f.owner('s24'), null);
    assert.deepEqual(f.entries().filter(entry => entry.startsWith('s24.lock')), [], 'no lock and no tomb is left');
    const ended = f.events().filter(event => event.event === 'force-release');
    assert.equal(ended.length, 1, 'one event');
    const [event] = ended;
    assert.deepEqual([event.lock, event.hold_kind, event.lease_id, event.actor, event.why, event.reason], ['s24', 'lease', 'a-1', OPS, 'stuck', null]);
    assert.deepEqual([event.claimant.kind, event.claimant.holder], ['agent', 'holder-a-1']);
    assert.equal(event.held_ms, 0, 'held from the take to the (frozen) clock');
    assert.equal(event.expires_at, owner.expires_at);
    // The Event Log shows the hold ended by it: it held in the window up to the force-release, and not after it.
    assert.deepEqual(leaseHoldersSince('s24', f.now() - MIN, { env: f.env }).map(hold => hold.lease_id), ['a-1']);
    assert.deepEqual(leaseHoldersSince('s24', f.now() + MIN, { env: f.env }), []);
    // The lock is free: a new Lease takes it at once.
    assert.equal((await f.hold('s24', 'a-2')).lease_id, 'a-2');
  } finally { f.cleanup(); }
});

test('a waiter already in line acquires the lock next, and its acquire event follows the force-release', async () => {
  const f = fixture();
  try {
    await f.hold('s24', 'a-1');
    const waiting = f.wait('s24', 'b-1');
    await until(() => readdirSync(join(f.env.HUB_LOCK_DIR, 's24.queue')).some(file => file.endsWith('.json')), 'the waiter queued');
    assert.equal(f.force('s24').released, true);
    const taken = await waiting;
    assert.equal(taken.lease_id, 'b-1');
    assert.equal(f.owner('s24').lease_id, 'b-1');
    assert.deepEqual(f.events().filter(event => event.lock === 's24').map(event => `${event.event}:${event.lease_id}`), ['acquire:a-1', 'request:b-1', 'force-release:a-1', 'acquire:b-1']);
  } finally { f.cleanup(); }
});

test('an empty, blank or non-string why is HUB_USAGE, a missing actor a TypeError, and the Lease is untouched with no event', async () => {
  const f = fixture();
  try {
    await f.hold('s24', 'a-1');
    const before = f.ownerText('s24');
    const events = f.events().length;
    for (const why of ['', '   ', undefined, null, 42]) {
      assert.throws(() => f.force('s24', { why }), error => error.code === 'HUB_USAGE' && error.reason === 'bad-why', String(why));
    }
    assert.throws(() => f.force('s24', { actor: undefined }), TypeError);
    assert.throws(() => f.force('s24', { actor: { holder: 'ops', via: 'telepathy' } }), TypeError);
    assert.equal(f.ownerText('s24'), before);
    assert.equal(f.events().length, events);
  } finally { f.cleanup(); }
});

test('a job, a hub-job and a pre-v1a owner are refused with HUB_FORCE_RELEASE_JOB and {repo, run, job}: the owner is byte-identical and no event is written', () => {
  const f = fixture();
  try {
    f.plant('adb', { kind: 'job', repo: 'o/r', run: '41', attempt: '1', job: 'android' });
    f.plant('s24', { kind: 'hub-job', repo: null, run: null, attempt: null, job: null });
    f.plant('mac-ios', { repo: 'o/old', run: '9' });
    const cases = [['adb', ['o/r', '41', 'android'], /gh run cancel 41 --repo o\/r/], ['s24', [null, null, null], /stop the catch-up process \d+ instead/], ['mac-ios', ['o/old', '9', null], /gh run cancel 9 --repo o\/old/]];
    for (const [name, members, text] of cases) {
      const before = f.ownerText(name);
      assert.throws(() => f.force(name), error => {
        assert.equal(error.code, 'HUB_FORCE_RELEASE_JOB');
        assert.deepEqual([error.repo, error.run, error.job], members);
        assert.match(error.message, text);
        return true;
      }, name);
      assert.equal(f.ownerText(name), before, `${name} is byte-identical`);
    }
    // A lease_id does not turn a Job Hold into something that can be ended.
    assert.throws(() => f.force('adb', { lease_id: 'a-1' }), error => error.code === 'HUB_FORCE_RELEASE_JOB');
    assert.deepEqual(f.events(), []);
  } finally { f.cleanup(); }
});

test('forceReleaseJobError names the run to cancel when it knows one, else the process to stop', () => {
  const github = forceReleaseJobError({ repo: 'o/r', run: '41', job: 'android' });
  assert.deepEqual([github.code, github.repo, github.run, github.job], ['HUB_FORCE_RELEASE_JOB', 'o/r', '41', 'android']);
  assert.match(github.message, /gh run cancel 41 --repo o\/r/);
  const local = forceReleaseJobError({ pid: 123 });
  assert.deepEqual([local.repo, local.run, local.job], [null, null, null]);
  assert.match(local.message, /stop the local process 123 instead/);
  assert.match(forceReleaseJobError({ kind: 'hub-job' }).message, /stop the catch-up process instead/);
});

test('the rename decides: an owner replaced between the read and the rename is put back and nothing is written; a lock removed records nothing', async () => {
  const f = fixture();
  try {
    await f.hold('s24', 'a-1');
    const replaced = f.owner('s24');
    const other = { ...replaced, lease_id: 'z-9', holder: 'someone-else' };
    const result = f.force('s24', { beforeRetire: stage => { if (stage === 'rename') writeFileSync(join(f.path('s24'), 'owner.json'), JSON.stringify(other)); } });
    assert.deepEqual(result, { released: false, reason: 'changed' });
    assert.equal(f.owner('s24').lease_id, 'z-9', 'the new owner is untouched');
    assert.deepEqual(f.entries().filter(entry => entry.includes('tomb')), [], 'no tomb is left');
    assert.deepEqual(f.events().filter(event => event.event === 'force-release'), []);

    const gone = f.force('s24', { beforeRetire: stage => { if (stage === 'rename') rmSync(f.path('s24'), { recursive: true }); } });
    assert.deepEqual(gone, { released: false, reason: 'changed' });
    assert.deepEqual(f.events().filter(event => event.event === 'force-release'), []);
  } finally { f.cleanup(); }
});

test('no lock is none, a lock with no owner record is unknown-holder, and another Lease than the one named is other-lease: nothing is written', async () => {
  const f = fixture();
  try {
    assert.deepEqual(f.force('s24'), { released: false, reason: 'none' });
    mkdirSync(f.path('s24'), { recursive: true });
    assert.deepEqual(f.force('s24'), { released: false, reason: 'unknown-holder' });
    rmSync(f.path('s24'), { recursive: true });
    await f.hold('s24', 'a-1');
    const before = f.ownerText('s24');
    const other = f.force('s24', { lease_id: 'zzz' });
    assert.deepEqual([other.released, other.reason, other.owner.lease_id], [false, 'other-lease', 'a-1']);
    assert.equal(f.ownerText('s24'), before);
    assert.deepEqual(f.events().filter(event => event.event === 'force-release'), []);
    assert.throws(() => f.force('Bad Name'), /bad lock name/);
  } finally { f.cleanup(); }
});
