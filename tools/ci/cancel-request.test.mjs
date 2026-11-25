// Story 7.5: cancelRequest (lock.mjs), the one writer that takes a waiting request out of the line. Hermetic: temp lock and event dirs, a
// frozen clock, a real (short) poll sleep so a live waiter can be cancelled while it waits.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readEvents } from './lib/events.mjs';
import { acquireLease, acquirePool, buildTicket, cancelRequest, listWaiters, readOwner, releaseLease, reserve } from './lib/lock.mjs';
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
  const root = mkdtempSync(join(tmpdir(), 'hub-cancel-request-'));
  const env = { HUB_LOCK_DIR: join(root, 'locks'), HUB_EVENT_DIR: join(root, 'events') };
  const clock = Date.now();
  const f = {
    root, env, now: () => clock,
    events: () => [...readEvents({ env })],
    queue: name => { try { return readdirSync(join(env.HUB_LOCK_DIR, `${name}.queue`)).sort(); } catch { return []; } },
    tickets: name => f.queue(name).filter(file => file.endsWith('.json')),
    owner: name => readOwner(join(env.HUB_LOCK_DIR, `${name}.lock`)),
    ownerText: name => readFileSync(join(env.HUB_LOCK_DIR, `${name}.lock`, 'owner.json'), 'utf8'),
    hold: (name, id) => acquireLease(name, { holder: `holder-${id}`, why: 'device proof', forMs: 30 * MIN, id, env, log: () => {}, now: f.now }),
    // A waiter that polls on a short real sleep, so it notices its ticket going within a few ms and the clock (and its deadline) stands still.
    wait: (name, id, options = {}) => acquireLease(name, { holder: `waiter-${id}`, why: 'wants it', forMs: 5 * MIN, waitMs: 10 * MIN, id, env, log: () => {}, now: f.now, pollMs: 5, sleep: () => settle(5), ...options }),
    pool: (id, options = {}) => acquirePool('phone', ['s24', 'adb'], { holder: `pooler-${id}`, why: 'any phone', forMs: 5 * MIN, waitMs: 10 * MIN, id, env, log: () => {}, now: f.now, pollMs: 5, sleep: () => settle(5), ...options }),
    cancel: (name, id, options = {}) => cancelRequest(name, id, { actor: OPS, env, now: f.now, ...options }),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
  return f;
}
const of = (events, id) => events.filter(event => event.lease_id === id || event.request === id);

test('a single-lock waiter is cancelled: one cancel event naming the canceller, the waiter fails naming it, the Hold is untouched', async () => {
  const f = fixture();
  try {
    await f.hold('s24', 'a-1');
    const before = f.ownerText('s24');
    const waiting = f.wait('s24', 'b-1');
    const settled = assert.rejects(waiting, error => {
      assert.equal(error.code, 'HUB_LEASE_CANCELLED');
      assert.equal(error.reason, 'cancelled');
      assert.match(error.message, /cancelled by ops: stuck/);
      assert.deepEqual(error.cancel, { actor: OPS, why: 'stuck' });
      return true;
    });
    await until(() => f.tickets('s24').length === 1, 'the waiter queued');
    assert.deepEqual(f.cancel('s24', 'b-1', { why: 'stuck' }), { cancelled: true, pool: null, request: null, locks: ['s24'] });
    await settled;
    assert.deepEqual(f.queue('s24'), [], 'the ticket and its note are gone');
    const events = of(f.events(), 'b-1');
    assert.deepEqual(events.map(event => event.event), ['request', 'cancel'], 'one ending, and only one');
    const cancel = events[1];
    assert.deepEqual([cancel.lock, cancel.reason, cancel.actor, cancel.why], ['s24', 'cancelled', OPS, 'stuck']);
    assert.equal(cancel.claimant.holder, 'waiter-b-1');
    assert.equal(f.ownerText('s24'), before, 'the Hold is byte-identical');
  } finally { f.cleanup(); }
});

test('a phone Pool request is cancelled in every member queue: one Pool ending, no lock-level cancel, the canceller as actor', async () => {
  const f = fixture();
  try {
    await f.hold('s24', 'a-1');
    await f.hold('adb', 'a-2');
    const waiting = f.pool('p-1');
    const settled = assert.rejects(waiting, error => error.code === 'HUB_LEASE_CANCELLED' && error.cancel.actor.holder === 'ops' && /cancelled by ops/.test(error.message));
    await until(() => f.tickets('s24').length === 1 && f.tickets('adb').length === 1, 'the request queued in both members');
    // A request of another Pool, or one on a single lock, is not this one.
    assert.deepEqual(f.cancel('s24', 'p-1', { pool: 'emulator' }), { cancelled: false, reason: 'none' });
    assert.deepEqual(f.cancel('s24', 'p-1', { pool: null }), { cancelled: false, reason: 'none' });
    assert.equal(f.tickets('s24').length + f.tickets('adb').length, 2, 'nothing was removed');
    const done = f.cancel('s24', 'p-1', { pool: 'phone', why: 'not needed' });
    assert.deepEqual([done.cancelled, done.pool, done.request, [...done.locks].sort()], [true, 'phone', 'p-1', ['adb', 's24']]);
    await settled;
    assert.deepEqual([f.queue('s24'), f.queue('adb')], [[], []], 'no ticket and no note remains anywhere');
    const events = of(f.events(), 'p-1');
    assert.deepEqual(events.map(event => [event.event, event.lock]), [['request', null], ['cancel', null]], 'one Pool-level ending, no lock-level cancel');
    assert.deepEqual([events[1].pool, events[1].reason, events[1].actor, events[1].why], ['phone', 'cancelled', OPS, 'not needed']);
    assert.equal(f.owner('s24').lease_id, 'a-1');
    assert.equal(f.owner('adb').lease_id, 'a-2');
  } finally { f.cleanup(); }
});

test('a job id, a job ticket and a Reservation key are refused before anything is written', () => {
  const f = fixture();
  try {
    assert.throws(() => f.cancel('s24', 'job:acme/app#1.1/deploy'), { code: 'HUB_DEVICE_JOB_ID' });
    const queue = join(f.env.HUB_LOCK_DIR, 'adb.queue');
    mkdirSync(queue, { recursive: true });
    const body = buildTicket('hub-job', { env: {}, requested: f.now(), lease_id: 'catch-up-1', holder: 'catch-up', why: 'install' });
    writeFileSync(join(queue, '000000000000001-000001-00000001.json'), JSON.stringify(body));
    assert.throws(() => f.cancel('adb', 'catch-up-1'), { code: 'HUB_DEVICE_JOB_ID' });
    assert.equal(f.tickets('adb').length, 1, 'the job ticket stands');
    assert.deepEqual(f.queue('adb').filter(file => file.endsWith('.cancel')), []);
    const env = { ...f.env, GITHUB_REPOSITORY: 'acme/app', GITHUB_RUN_ID: '77' };
    assert.equal(reserve('adb', { env, now: f.now, log: () => {} }).status, 'claimed');
    assert.throws(() => f.cancel('adb', 'acme--app--77'), { code: 'HUB_CANCEL_RESERVATION', message: /force-release/ });
    assert.equal(readdirSync(join(f.env.HUB_LOCK_DIR, 'adb.reservations')).length, 1, 'the Reservation stands');
    assert.throws(() => cancelRequest('s24', 'x', { env: f.env }), TypeError, 'an actor is required');
    assert.throws(() => f.cancel('s24', 'x', { why: 7 }), TypeError);
  } finally { f.cleanup(); }
});

test('a request that holds the lock is held, an unknown or malformed id is none, and neither touches the Hold', async () => {
  const f = fixture();
  try {
    await f.hold('s24', 'a-1');
    const before = f.ownerText('s24');
    assert.deepEqual(f.cancel('s24', 'a-1'), { cancelled: false, reason: 'held' });
    assert.deepEqual(f.cancel('s24', 'nobody'), { cancelled: false, reason: 'none' });
    assert.deepEqual(f.cancel('s24', 'Not A Lease Id'), { cancelled: false, reason: 'none' });
    assert.deepEqual(f.cancel('adb', 'a-1'), { cancelled: false, reason: 'none' });
    assert.equal(f.ownerText('s24'), before);
    assert.deepEqual(f.events().map(event => event.event), ['acquire'], 'nothing was recorded');
  } finally { f.cleanup(); }
});

test('a ticket that leaves first is gone: the canceller writes no event and leaves no note', async () => {
  const f = fixture();
  try {
    await f.hold('s24', 'a-1');
    const waiting = f.wait('s24', 'b-1');
    const settled = assert.rejects(waiting, { code: 'HUB_LEASE_CANCELLED' });
    await until(() => f.tickets('s24').length === 1, 'queued');
    // A release by id wins the unlink; a later cancel of the same id finds nothing.
    assert.equal(releaseLease('s24', 'b-1', { env: f.env, now: f.now }).cancelled, 1);
    await settled;
    assert.deepEqual(f.cancel('s24', 'b-1'), { cancelled: false, reason: 'none' });
    assert.deepEqual(f.queue('s24'), []);
    assert.deepEqual(of(f.events(), 'b-1').map(event => [event.event, event.reason]), [['request', null], ['cancel', 'released']], 'released ended it, not a cancel');
  } finally { f.cleanup(); }
});

test('releaseLease and every ticket reader ignore a cancel note; an orphan note is pruned after TICKET_ABSENT_MS and not before', async () => {
  const f = fixture();
  try {
    await f.hold('s24', 'a-1');
    const waiting = f.wait('s24', 'b-1');
    const settled = assert.rejects(waiting, { code: 'HUB_LEASE_CANCELLED' });
    await until(() => f.tickets('s24').length === 1, 'queued');
    const [file] = f.tickets('s24');
    const note = join(f.env.HUB_LOCK_DIR, 's24.queue', `${file}.cancel`);
    writeFileSync(note, JSON.stringify({ format: 1, cancel: { actor: OPS, why: null, at: new Date().toISOString() } }));
    assert.equal(listWaiters('s24', { env: f.env, now: f.now }).length, 1, 'a note is not a ticket');
    assert.equal(releaseLease('s24', 'zzz', { env: f.env, now: f.now }).cancelled, 0, 'a release by another id skips the note');
    rmSync(note);
    f.cancel('s24', 'b-1');
    await settled;

    const orphan = join(f.env.HUB_LOCK_DIR, 's24.queue', '000000000000001-000009-00000009.json.cancel');
    writeFileSync(orphan, JSON.stringify({ format: 1, cancel: { actor: OPS, why: null, at: new Date().toISOString() } }));
    const at = Date.now();
    listWaiters('s24', { env: f.env, prune: true, now: () => at });
    assert.equal(existsSync(orphan), true, 'a fresh orphan stays: its waiter may be about to read it');
    utimesSync(orphan, (at - 2 * MIN) / 1000, (at - 2 * MIN) / 1000);
    listWaiters('s24', { env: f.env, prune: false, now: () => at });
    assert.equal(existsSync(orphan), true, 'an observer prunes nothing');
    listWaiters('s24', { env: f.env, prune: true, now: () => at });
    assert.equal(existsSync(orphan), false, 'an old orphan is removed');
    assert.deepEqual(f.events().filter(event => event.event === 'prune'), [], 'with no event');
  } finally { f.cleanup(); }
});

// The race rows: a waiter granted or withdrawn between the find and the unlink (the `unlink` seam stands in for it).
const plant = (f, lock, id, { pool = null, file = '000000000000001-000001-00000001.json' } = {}) => {
  const queue = join(f.env.HUB_LOCK_DIR, `${lock}.queue`);
  mkdirSync(queue, { recursive: true });
  writeFileSync(join(queue, file), JSON.stringify({ format: 1, kind: 'lease', lease_id: id, holder: `waiter-${id}`, why: 'wants it', pid: process.pid, enqueued_at: new Date(f.now() - MIN).toISOString(), pool, request: pool ? id : null }));
};
const enoent = () => Object.assign(new Error('gone'), { code: 'ENOENT' });

test('a ticket that goes between the find and the unlink is gone: no event, and the canceller leaves no note behind', async () => {
  const f = fixture();
  try {
    await f.hold('s24', 'a-1');
    plant(f, 's24', 'b-1');
    const before = f.events().length;
    const raced = path => { rmSync(path); throw enoent(); };
    assert.deepEqual(f.cancel('s24', 'b-1', { unlink: raced }), { cancelled: false, reason: 'gone' });
    assert.deepEqual(f.queue('s24'), [], 'neither the ticket nor a note');
    assert.equal(f.events().length, before, 'the waiter owns that ending');
  } finally { f.cleanup(); }
});

test('a Pool request granted a member while it is being cancelled is held: no Pool ticket is left to serve and no event is written', async () => {
  const f = fixture();
  try {
    await f.hold('s24', 'a-1');
    await f.hold('adb', 'a-2');
    plant(f, 's24', 'p-1', { pool: 'phone' });
    plant(f, 'adb', 'p-1', { pool: 'phone' });
    const before = f.events().length;
    let calls = 0;
    // The first unlink lands; meanwhile the request takes the other member and withdraws its ticket there, so the second finds nothing.
    const granted = path => {
      calls += 1;
      if (calls === 1) {
        rmSync(path);
        const other = path.includes(`${join('locks', 's24.queue')}`) ? 'adb' : 's24';
        writeFileSync(join(f.env.HUB_LOCK_DIR, `${other}.lock`, 'owner.json'), JSON.stringify({ kind: 'lease', lease_id: 'p-1', holder: 'waiter-p-1' }));
        rmSync(join(f.env.HUB_LOCK_DIR, `${other}.queue`, '000000000000001-000001-00000001.json'));
        return;
      }
      throw enoent();
    };
    assert.deepEqual(f.cancel('s24', 'p-1', { pool: 'phone', unlink: granted }), { cancelled: false, reason: 'held' });
    assert.equal(calls, 2);
    assert.equal(f.tickets('s24').length + f.tickets('adb').length, 0);
    assert.equal(f.events().length, before, 'a Pool cancel never writes the ending itself');
  } finally { f.cleanup(); }
});
