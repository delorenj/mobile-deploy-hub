// Extending a Lease, and the deploy-target cap (Story 2.7, MOBI-36, AD-11, AD-16, FR-31): extendLease is the only path that moves a
// Lease's expiry later and it refuses while anyone blocks in the Queue, at or after expiry, and past the policy cap; acquireLease
// applies the same cap; updateLease never moves expiry later; every owner rewrite checks the lock is still its writer's.
// Everything runs against temp HUB_LOCK_DIR/HUB_EVENT_DIR with an injected clock and policy.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEPLOY_TARGETS, acquireLease, acquirePool, deployTargetCapMs, extendLease, queueView, releaseLease, reserve, updateLease } from './lib/lock.mjs';
import { readEvents } from './lib/events.mjs';
import { loadPolicy } from './lib/policy.mjs';
import { hermetic } from './test-fixtures.mjs';

hermetic();

const T0 = Date.parse('2026-11-24T10:00:00.000Z');
const MIN = 60_000;
const policy = { queue: { wait_margin_min: 2, hold_allowance_min: { plan: 5, android: 15, ios: 60 }, grace_min: 10, reservation_ceiling_min: 180, deploy_target_lease_max_min: 60 } };
const at = ms => new Date(ms).toISOString();

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'hub-extend-'));
  const env = { HUB_LOCK_DIR: join(root, 'locks'), HUB_EVENT_DIR: join(root, 'events') };
  const clock = { at: T0 };
  return {
    root, env, clock, now: () => clock.at,
    lock: name => join(root, 'locks', `${name}.lock`),
    owner: name => JSON.parse(readFileSync(join(root, 'locks', `${name}.lock`, 'owner.json'), 'utf8')),
    events: () => [...readEvents({ env })],
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}
const take = (f, name = 'adb', extra = {}) => acquireLease(name, { holder: 'agent-a', why: 'device proof', forMs: 20 * MIN, id: 'mine', env: f.env, log: () => {}, now: f.now, policy, ...extra });
const extend = (f, forMs, name = 'adb', extra = {}) => extendLease(name, 'mine', { forMs, env: f.env, now: f.now, policy, ...extra });
// A waiter as any hub version writes it: file name `<ms15>-<counter>-<pid8>.json` in <name>.queue/.
const putTicket = (f, ms, body = {}, name = 'adb') => {
  const queue = join(f.root, 'locks', `${name}.queue`);
  mkdirSync(queue, { recursive: true });
  const file = `${String(ms).padStart(15, '0')}-000001-00000009.json`;
  writeFileSync(join(queue, file), JSON.stringify({ format: 1, kind: 'lease', lease_id: 'waiting-1', holder: 'agent-b', why: 'wants the phone', pid: process.pid, host: hostname(), enqueued_at: at(ms), ...body }));
  return join(queue, file);
};
const refused = (code, pattern) => error => { assert.equal(error.code, code); assert.match(error.message, pattern); return true; };

test('an extension with nobody waiting moves expires_at later by forMs, keeps the rest of the record, and appends one extend event', async () => {
  const f = fixture();
  try {
    const first = await take(f);
    assert.equal(first.expires_at, at(T0 + 20 * MIN));
    assert.match(first.lock_ino, /^\d+$/, 'the take records its directory inode');
    f.clock.at = T0 + 5 * MIN;
    const next = extend(f, 15 * MIN);
    assert.equal(next.expires_at, at(T0 + 35 * MIN));
    const stored = f.owner('adb');
    assert.deepEqual({ ...stored, expires_at: first.expires_at }, first, 'only expires_at changed');
    assert.equal(stored.expires_at, at(T0 + 35 * MIN));
    const sequence = f.events().map(event => [event.event, event.lock, event.lease_id, event.hold_kind]);
    assert.deepEqual(sequence, [['acquire', 'adb', 'mine', 'lease'], ['extend', 'adb', 'mine', 'lease']]);
    const event = f.events()[1];
    assert.equal(event.expires_at, at(T0 + 35 * MIN));
    assert.equal(event.for_ms, 35 * MIN, 'for_ms is the whole length of the Lease');
    assert.equal(event.claimant.holder, 'agent-a');
    // and again: an extension may follow an extension
    f.clock.at = T0 + 30 * MIN;
    assert.equal(extend(f, 10 * MIN).expires_at, at(T0 + 45 * MIN));
    assert.equal(f.events().filter(entry => entry.event === 'extend').length, 2);
  } finally { f.cleanup(); }
});

test('an extension is refused while a waiter blocks, naming the waiters and their places, and writes nothing', async () => {
  const f = fixture();
  try {
    const held = await take(f);
    putTicket(f, T0 + MIN, { lease_id: 'first-in-line', holder: 'agent-b', why: 'wants the phone' });
    putTicket(f, T0 + 2 * MIN, { lease_id: 'second-in-line', holder: 'agent-c', why: 'also' }, 'adb');
    f.clock.at = T0 + 3 * MIN;
    assert.throws(() => extend(f, 10 * MIN), refused('HUB_LEASE_EXTEND_REFUSED', /^lease mine on adb cannot be extended while 2 waiters wait: 1\. agent-b \(wants the phone\), 2\. agent-c \(also\)$/));
    assert.deepEqual(f.owner('adb'), held, 'nothing was written');
    assert.deepEqual(f.events().map(event => event.event), ['acquire'], 'and no event');
    assert.deepEqual(readdirSync(f.lock('adb')).filter(entry => entry.endsWith('.tmp')), [], 'no temp file is left');
  } finally { f.cleanup(); }
});

test('a dead waiter does not block; a deploy job that waits does, whatever its kind', async () => {
  const f = fixture();
  try {
    await take(f);
    putTicket(f, T0 + MIN, { pid: 2 ** 22 + 12345, process_start: 'long-gone' });   // its pid is gone: stale, never blocks
    f.clock.at = T0 + 2 * MIN;
    assert.equal(extend(f, MIN).expires_at, at(T0 + 21 * MIN));
    putTicket(f, T0 + 3 * MIN, { kind: 'job', lease_id: 'job:delorenj/app#7.1/android', holder: null, why: 'android', repo: 'delorenj/app', run: '7', attempt: '1', job: 'android' });
    assert.throws(() => extend(f, MIN), refused('HUB_LEASE_EXTEND_REFUSED', /cannot be extended while 1 waiter waits: 1\. job:delorenj\/app#7\.1\/android \(android\)$/));
    // The catch-up's ticket (Story 3.3) blocks the same way: a hub-job that waits is a waiter.
    putTicket(f, T0 + 4 * MIN, { kind: 'hub-job', lease_id: 'job:local/catch-up', holder: 'catch-up', why: 'catch-up install' });
    assert.throws(() => extend(f, MIN), refused('HUB_LEASE_EXTEND_REFUSED', /cannot be extended while 2 waiters wait: 1\. job:delorenj\/app#7\.1\/android \(android\), 2\. catch-up \(catch-up install\)$/));
  } finally { f.cleanup(); }
});

test('a Reservation in line blocks an extension until its grace is over; one past its grace does not', async () => {
  const f = fixture();
  try {
    await take(f);
    const run = { ...f.env, GITHUB_REPOSITORY: 'delorenj/app', GITHUB_RUN_ID: '31', GITHUB_RUN_ATTEMPT: '1', GITHUB_JOB: 'gate' };
    const claimed = reserve('adb', { env: run, now: f.now, policy, log: () => {} });
    assert.equal(claimed.status, 'claimed');
    f.clock.at = T0 + 2 * MIN;
    assert.throws(() => extend(f, MIN), refused('HUB_LEASE_EXTEND_REFUSED', /cannot be extended while 1 waiter waits: 1\. delorenj\/app#31 \(reservation\)$/));
    // Its one-time grace is over (the stamp the first acquirer that saw it free would have written, 11 minutes ago).
    writeFileSync(join(f.root, 'locks/adb.reservations', claimed.key, 'grace.json'), JSON.stringify({ format: 1, grace_started_at: at(T0 - 11 * MIN) }));
    assert.equal(extend(f, MIN).expires_at, at(T0 + 21 * MIN), 'a Reservation past its grace does not block extensions');
  } finally { f.cleanup(); }
});

test('an extension at or after the Lease\'s expires_at is refused', async () => {
  const f = fixture();
  try {
    await take(f);
    f.clock.at = T0 + 20 * MIN - 1;
    assert.equal(extend(f, MIN).expires_at, at(T0 + 21 * MIN), 'one millisecond before expiry still extends');
    f.clock.at = T0 + 21 * MIN;
    assert.throws(() => extend(f, MIN), refused('HUB_LEASE_EXTEND_REFUSED', /ran out at .*an expired lease cannot be extended/));
    f.clock.at = T0 + 30 * MIN;
    assert.throws(() => extend(f, MIN), refused('HUB_LEASE_EXTEND_REFUSED', /an expired lease cannot be extended/));
    assert.equal(f.owner('adb').expires_at, at(T0 + 21 * MIN), 'nothing was written');
    assert.equal(f.events().filter(event => event.event === 'extend').length, 1);
  } finally { f.cleanup(); }
});

test('a Lease on a deploy target is capped at the policy minutes in total, at acquire and at every extension', async () => {
  const f = fixture();
  try {
    assert.deepEqual([...DEPLOY_TARGETS], ['adb', 'mac-ios']);
    assert.equal(deployTargetCapMs('adb', { policy }), 60 * MIN);
    assert.equal(deployTargetCapMs('mac-ios', { policy }), 60 * MIN);
    assert.equal(deployTargetCapMs('s24', { policy }), null);
    assert.equal(deployTargetCapMs('emulator-1', { policy }), null);
    assert.equal(deployTargetCapMs('adb'), loadPolicy().policy.queue.deploy_target_lease_max_min * MIN, 'with no injected policy the policy file speaks');
    await take(f, 'adb', { forMs: 50 * MIN });
    assert.throws(() => extend(f, 11 * MIN), refused('HUB_LEASE_EXTEND_REFUSED', /would run 61 min in total; a lease on adb runs at most 60 min in total \(the deploy-target cap, policy queue\.deploy_target_lease_max_min\); lease s24 or an emulator for longer$/));
    assert.equal(f.owner('adb').expires_at, at(T0 + 50 * MIN));
    assert.equal(extend(f, 10 * MIN).expires_at, at(T0 + 60 * MIN), 'exactly the cap is allowed');
    assert.throws(() => extend(f, 1), refused('HUB_LEASE_EXTEND_REFUSED', /would run 61 min in total/), 'a Lease at the cap cannot grow');
    // The cap counts from started_at, not from the clock: a Lease that started late and is extended late is measured the same.
    assert.ok(releaseLease('adb', 'mine', { env: f.env }).released);
    f.clock.at = T0 + 120 * MIN;
    await take(f, 'adb', { forMs: 30 * MIN });
    f.clock.at = T0 + 125 * MIN;
    assert.throws(() => extend(f, 31 * MIN), refused('HUB_LEASE_EXTEND_REFUSED', /would run 61 min in total/));
    assert.equal(extend(f, 30 * MIN).expires_at, at(T0 + 180 * MIN));
    // mac-ios is a deploy target too; s24 (and an emulator slot) keep only the 48 h limit.
    await take(f, 'mac-ios', { forMs: 59 * MIN });
    assert.throws(() => extend(f, 2 * MIN, 'mac-ios'), refused('HUB_LEASE_EXTEND_REFUSED', /a lease on mac-ios runs at most 60 min/));
    await take(f, 's24', { forMs: 59 * MIN });
    assert.equal(extend(f, 5 * 3600_000, 's24').expires_at, at(f.now() + 59 * MIN + 5 * 3600_000));
    assert.throws(() => extend(f, 48 * 3600_000, 's24'), refused('HUB_LEASE_EXTEND_REFUSED', /more than 48h in total/));
  } finally { f.cleanup(); }
});

test('acquireLease refuses a deploy-target Lease over the cap before it takes a place, and names s24 or an emulator', async () => {
  const f = fixture();
  try {
    for (const name of ['adb', 'mac-ios']) {
      await assert.rejects(take(f, name, { forMs: 61 * MIN, waitMs: 5000 }), refused('HUB_LEASE_TOO_LONG', new RegExp(`^a lease on ${name} runs at most 60 min in total \\(the deploy-target cap, policy queue\\.deploy_target_lease_max_min\\); lease s24 or an emulator for longer$`)));
      assert.ok(!existsSync(f.lock(name)), 'no lock was taken');
      assert.ok(!existsSync(join(f.root, 'locks', `${name}.queue`)) || readdirSync(join(f.root, 'locks', `${name}.queue`)).length === 0, 'no ticket was left');
      assert.equal((await take(f, name, { forMs: 60 * MIN, id: `at-cap-${name}` })).lease_id, `at-cap-${name}`, 'the cap itself is fine');
    }
    assert.deepEqual(f.events().filter(event => event.event === 'request' || event.event === 'timeout' || event.event === 'cancel'), [], 'a refused acquire is not history');
    await take(f, 's24', { forMs: 5 * 3600_000 });
    // A tuned policy moves the cap for every caller.
    const tuned = { queue: { ...policy.queue, deploy_target_lease_max_min: 30 } };
    await assert.rejects(take(f, 'adb', { forMs: 31 * MIN, policy: tuned, id: 'tuned' }), refused('HUB_LEASE_TOO_LONG', /at most 30 min/));
    // The existing limits still speak first.
    await assert.rejects(take(f, 'adb', { forMs: 49 * 3600_000 }), /at most 48h/);
  } finally { f.cleanup(); }
});

test('updateLease changes metadata and earlier expiry, and never a later one', async () => {
  const f = fixture();
  try {
    const held = await take(f);
    assert.equal(updateLease('adb', 'mine', { device: { adb_id: 'abc' } }, { env: f.env }), true);
    assert.deepEqual(f.owner('adb').device, { adb_id: 'abc' });
    assert.equal(updateLease('adb', 'mine', { expires_at: at(T0 + 10 * MIN) }, { env: f.env }), true, 'earlier expiry');
    assert.equal(f.owner('adb').expires_at, at(T0 + 10 * MIN));
    assert.equal(updateLease('adb', 'mine', { expires_at: at(T0 + 10 * MIN) }, { env: f.env }), true, 'the same expiry');
    for (const later of [at(T0 + 10 * MIN + 1), at(T0 + 3600_000), 'tomorrow', null]) {
      assert.throws(() => updateLease('adb', 'mine', { expires_at: later, device: { adb_id: 'changed' } }, { env: f.env }), refused('HUB_LEASE_EXTEND_REFUSED', /never moves the expiry later; only extendLease does/), String(later));
    }
    assert.deepEqual(f.owner('adb').device, { adb_id: 'abc' }, 'a refused update writes none of its fields');
    assert.equal(f.owner('adb').expires_at, at(T0 + 10 * MIN));
    assert.equal(held.lease_id, 'mine');
    assert.deepEqual(f.events().filter(event => event.event === 'extend'), [], 'updateLease writes no extend event');
  } finally { f.cleanup(); }
});

test('a rewrite after the lock was re-taken throws HUB_LEASE_LOST and writes nothing; a lock that is simply gone is false for update, lost for extend', async () => {
  const f = fixture();
  try {
    const mine = await take(f);
    assert.ok(releaseLease('adb', 'mine', { env: f.env }).released);
    // gone
    assert.equal(updateLease('adb', 'mine', { x: 1 }, { env: f.env }), false);
    assert.throws(() => extend(f, MIN), refused('HUB_LEASE_LOST', /lease mine no longer holds adb: nothing holds the lock/));
    // re-taken by another lease
    const theirs = await take(f, 'adb', { id: 'theirs', holder: 'agent-b' });
    const before = readFileSync(join(f.lock('adb'), 'owner.json'), 'utf8');
    assert.throws(() => updateLease('adb', 'mine', { x: 1 }, { env: f.env }), refused('HUB_LEASE_LOST', /lease mine no longer holds adb: the lock is held by lease theirs of agent-b/));
    assert.throws(() => extend(f, MIN), refused('HUB_LEASE_LOST', /the lock is held by lease theirs/));
    assert.equal(readFileSync(join(f.lock('adb'), 'owner.json'), 'utf8'), before, 'the new holder\'s record is untouched');
    assert.deepEqual(readdirSync(f.lock('adb')).filter(entry => entry.endsWith('.tmp')), [], 'no temp file is left in their lock');
    assert.equal(theirs.lease_id, 'theirs');
    // re-taken by a deploy job's lock (no lease at all)
    assert.ok(releaseLease('adb', 'theirs', { env: f.env }).released);
    mkdirSync(f.lock('adb'));
    writeFileSync(join(f.lock('adb'), 'owner.json'), JSON.stringify({ pid: process.pid, host: hostname(), repo: 'delorenj/app', run: '5', started_at: at(T0), kind: 'job' }));
    assert.throws(() => updateLease('adb', 'mine', { x: 1 }, { env: f.env }), refused('HUB_LEASE_LOST', /the lock is held by delorenj\/app run 5/));
    assert.equal(mine.lease_id, 'mine');
  } finally { f.cleanup(); }
});

test('the inode check: the writer\'s own inode must be the directory\'s, and so must the one the record carries', async () => {
  const f = fixture();
  try {
    const mine = await take(f);
    // The same lease id in a different directory (a reclaimed and re-taken lock): the writer's inode no longer matches.
    assert.throws(() => updateLease('adb', 'mine', { x: 1 }, { env: f.env, ino: `${mine.lock_ino}0` }), refused('HUB_LEASE_LOST', /the lock directory was replaced/));
    assert.throws(() => extend(f, MIN, 'adb', { ino: `${mine.lock_ino}0` }), refused('HUB_LEASE_LOST', /the lock directory was replaced/));
    assert.equal(f.owner('adb').x, undefined);
    // Its own inode passes, as a number as well as a string.
    assert.equal(updateLease('adb', 'mine', { x: 1 }, { env: f.env, ino: mine.lock_ino }), true);
    assert.equal(extend(f, MIN, 'adb', { ino: Number(mine.lock_ino) }).expires_at, at(T0 + 21 * MIN));
    // An owner record that names another directory's inode was copied here: lost, even for a writer that passes no inode.
    writeFileSync(join(f.lock('adb'), 'owner.json'), JSON.stringify({ ...f.owner('adb'), lock_ino: `${mine.lock_ino}0` }));
    assert.throws(() => updateLease('adb', 'mine', { x: 2 }, { env: f.env }), refused('HUB_LEASE_LOST', /the lock directory was replaced/));
    // A Lease from before v1a carries no inode and is held to the id alone.
    const { lock_ino, ...old } = f.owner('adb');
    assert.ok(lock_ino);
    writeFileSync(join(f.lock('adb'), 'owner.json'), JSON.stringify(old));
    assert.equal(updateLease('adb', 'mine', { x: 3 }, { env: f.env }), true);
    assert.equal(extend(f, MIN).expires_at, at(T0 + 22 * MIN));
  } finally { f.cleanup(); }
});

test('an extension that cannot start (a bad forMs, a bad name) throws before touching anything', async () => {
  const f = fixture();
  try {
    await take(f);
    for (const forMs of [0, -1, NaN, Infinity, undefined]) assert.throws(() => extend(f, forMs), /an extension is for more than 0 ms/, String(forMs));
    assert.throws(() => extend(f, MIN, 'Bad Name'), /bad lock name/);
    assert.equal(f.owner('adb').expires_at, at(T0 + 20 * MIN));
  } finally { f.cleanup(); }
});

// ---- Story 5.9 (AD-34): Pool tickets, the extender's own ticket and the emulator gate ----

// The ticket of a Pool request `req` for the phone Pool, as acquirePool writes it into each member's queue.
const poolTicket = (f, ms, name, request = 'req', extra = {}) => putTicket(f, ms, { lease_id: request, holder: 'pooler', why: 'any phone', pool: 'phone', request, ...extra }, name);
const hold = (f, name, id, extra = {}) => acquireLease(name, { holder: `holder-${id}`, why: 'holding', forMs: 30 * MIN, id, env: f.env, log: () => {}, now: f.now, policy, ...extra });
const extendEvents = f => f.events().filter(event => event.event === 'extend').length;

test('queueView lists a Pool request\'s identical ticket once in each member queue, with its pool and request keys', async () => {
  const f = fixture();
  try {
    await take(f, 's24');
    poolTicket(f, T0 + MIN, 's24');
    poolTicket(f, T0 + MIN, 'adb');
    for (const name of ['s24', 'adb']) {
      const view = queueView(name, { env: f.env, now: f.now });
      assert.equal(view.length, 1, `listed once in ${name}`);
      assert.deepEqual([view[0].pool, view[0].request, view[0].lease_id, view[0].blocking], ['phone', 'req', 'req', true]);
    }
  } finally { f.cleanup(); }
});

test('a Pool request that waits blocks an extension; once it holds another member it no longer does', async () => {
  const f = fixture();
  try {
    await take(f, 's24');
    await hold(f, 'adb', 'other');
    poolTicket(f, T0 + MIN, 's24');
    poolTicket(f, T0 + MIN, 'adb');
    f.clock.at = T0 + 2 * MIN;
    const before = JSON.stringify(f.owner('s24'));
    assert.throws(() => extend(f, 5 * MIN, 's24'), refused('HUB_LEASE_EXTEND_REFUSED', /^lease mine on s24 cannot be extended while 1 waiter waits: 1\. pooler \(any phone\)$/));
    assert.equal(JSON.stringify(f.owner('s24')), before, 'nothing was written');
    assert.equal(extendEvents(f), 0);
    // The request takes adb (its own lease id now owns that lock): it is served, its s24 ticket is a leftover.
    releaseLease('adb', 'other', { env: f.env, now: f.now });
    rmSync(join(f.root, 'locks', 'adb.queue'), { recursive: true, force: true });   // the winner withdrew its adb ticket
    await hold(f, 'adb', 'req');
    assert.equal(extend(f, 5 * MIN, 's24').expires_at, at(T0 + 25 * MIN));
    assert.equal(extendEvents(f), 1);
  } finally { f.cleanup(); }
});

test('a Pool request\'s member Lease that expired but was not reaped is not held: the request still waits', async () => {
  const f = fixture();
  try {
    await take(f, 's24', { forMs: 60 * MIN });
    await hold(f, 'adb', 'req', { forMs: 5 * MIN });
    poolTicket(f, T0 + MIN, 's24');
    poolTicket(f, T0 + MIN, 'adb');
    f.clock.at = T0 + 6 * MIN;   // past req's expiry on adb, inside mine's on s24
    assert.throws(() => extend(f, MIN, 's24'), refused('HUB_LEASE_EXTEND_REFUSED', /cannot be extended while 1 waiter waits: 1\. pooler \(any phone\)$/));
    assert.equal(extendEvents(f), 0);
  } finally { f.cleanup(); }
});

test('through a real acquirePool: the extension in the window before the winner withdraws its s24 ticket succeeds, the request already holds adb', async () => {
  const f = fixture();
  try {
    await take(f, 's24', { forMs: 60 * MIN });
    let outcome = null;
    let called = 0;
    const won = await acquirePool('phone', ['s24', 'adb'], {
      holder: 'pooler', why: 'any phone', forMs: 5 * MIN, id: 'req', waitMs: 5 * MIN, env: f.env, log: () => {}, now: f.now, policy,
      pollMs: 1000, sleep: async ms => { f.clock.at += ms; },
      beforeWithdraw: name => {
        called += 1;
        try { outcome = { name, record: extend(f, 5 * MIN, 's24') }; } catch (error) { outcome = { name, error }; }
      },
    });
    assert.equal(won.name, 'adb', 'the pool won adb');
    assert.equal(called, 1, 'the s24 ticket was withdrawn after the take');
    assert.equal(outcome?.error, undefined, outcome?.error?.message);
    assert.equal(outcome.name, 's24');
    assert.equal(outcome.record.expires_at, at(T0 + 65 * MIN));
    assert.equal(extendEvents(f), 1);
  } finally { f.cleanup(); }
});

test('the extender\'s own ticket in its queue is not a waiter', async () => {
  const f = fixture();
  try {
    await take(f, 's24');
    putTicket(f, T0 + MIN, { lease_id: 'mine', holder: 'agent-a' }, 's24');
    assert.equal(extend(f, MIN, 's24').expires_at, at(T0 + 21 * MIN));
    assert.equal(extendEvents(f), 1);
  } finally { f.cleanup(); }
});

test('an emulator slot cannot be extended while the emulator gate is held by a waiting request, or has a queue', async () => {
  const f = fixture();
  try {
    await take(f, 'emulator-1');
    await hold(f, 'emulator', 'e-next', { holder: 'agent-e', why: 'next for an emulator: tests' });
    f.clock.at = T0 + MIN;
    const before = JSON.stringify(f.owner('emulator-1'));
    assert.throws(() => extend(f, MIN, 'emulator-1'), refused('HUB_LEASE_EXTEND_REFUSED', /^lease mine on emulator-1 cannot be extended while 1 waiter waits: in the emulator line 1\. agent-e \(next for an emulator: tests\)$/));
    assert.equal(JSON.stringify(f.owner('emulator-1')), before);
    assert.equal(extendEvents(f), 0);
    putTicket(f, T0 + MIN, { lease_id: 'e-second', holder: 'agent-f', why: 'next for an emulator: more' }, 'emulator');
    assert.throws(() => extend(f, MIN, 'emulator-1'), refused('HUB_LEASE_EXTEND_REFUSED', /^lease mine on emulator-1 cannot be extended while 2 waiters wait: in the emulator line 1\. agent-e \(next for an emulator: tests\), 2\. agent-f \(next for an emulator: more\)$/));
    // An own-queue waiter comes first, joined with `; `.
    putTicket(f, T0 + MIN, { lease_id: 'slot-waiter', holder: 'agent-g', why: 'slot' }, 'emulator-1');
    assert.throws(() => extend(f, MIN, 'emulator-1'), refused('HUB_LEASE_EXTEND_REFUSED', /while 3 waiters wait: 1\. agent-g \(slot\); in the emulator line 1\. agent-e .*, 2\. agent-f /));
    assert.equal(extendEvents(f), 0);
  } finally { f.cleanup(); }
});

test('a gate holder that already holds a slot, or a gate queue with no holder, is read as the gate says', async () => {
  const f = fixture();
  try {
    await take(f, 'emulator-1');
    await hold(f, 'emulator', 'e-next');
    await hold(f, 'emulator-2', 'e-next');
    f.clock.at = T0 + MIN;
    assert.equal(extend(f, MIN, 'emulator-1').expires_at, at(T0 + 21 * MIN), 'the gate holder is served: it holds emulator-2');
    // No live gate holder: a queued ticket stands at its own place.
    releaseLease('emulator', 'e-next', { env: f.env, now: f.now });
    putTicket(f, T0 + MIN, { lease_id: 'e-queued', holder: 'agent-q', why: 'queued' }, 'emulator');
    assert.throws(() => extend(f, MIN, 'emulator-1'), refused('HUB_LEASE_EXTEND_REFUSED', /in the emulator line 1\. agent-q \(queued\)$/));
  } finally { f.cleanup(); }
});

test('a lock that is not an emulator slot never reads the gate', async () => {
  const f = fixture();
  try {
    await take(f, 's24');
    await hold(f, 'emulator', 'e-next');
    assert.equal(extend(f, MIN, 's24').expires_at, at(T0 + 21 * MIN));
  } finally { f.cleanup(); }
});

test('an expired gate holder is not a waiter', async () => {
  const f = fixture();
  try {
    await take(f, 'emulator-1', { forMs: 60 * MIN });
    await hold(f, 'emulator', 'e-next', { forMs: 5 * MIN });
    f.clock.at = T0 + 6 * MIN;
    assert.equal(extend(f, MIN, 'emulator-1').expires_at, at(T0 + 61 * MIN));
  } finally { f.cleanup(); }
});
