// Reservations (Story 2.5, AD-6, AD-7, AD-11): a run reserves its devices when it starts so its build never loses its place while
// it compiles. Everything runs against a temp HUB_LOCK_DIR/HUB_EVENT_DIR with an injected clock and policy; no device, no host state.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RESERVABLE, acquireLease, listLocks, listReservations, queueView, readOwner, releaseLease, reserve, runKey, withLock } from './lib/lock.mjs';
import { readEvents } from './lib/events.mjs';
import { loadPolicy } from './lib/policy.mjs';
import { hermetic } from './test-fixtures.mjs';

hermetic(); // offline, outside any workflow job, scratch HUB_EVENT_DIR and HUB_LOCK_DIR (test-fixtures.mjs)

const T0 = Date.parse('2026-11-23T10:00:00.000Z');
const MIN = 60_000;
const policy = { queue: { wait_margin_min: 2, hold_allowance_min: { plan: 5, android: 15, ios: 60 }, grace_min: 10, reservation_ceiling_min: 180 } };
const lockModule = fileURLToPath(new URL('./lib/lock.mjs', import.meta.url));

function fixture(extra = {}) {
  const root = mkdtempSync(join(tmpdir(), 'hub-reservation-'));
  const plain = { HUB_LOCK_DIR: join(root, 'locks'), HUB_EVENT_DIR: join(root, 'events') };
  const env = { ...plain, GITHUB_REPOSITORY: 'delorenj/example', GITHUB_RUN_ID: '5', GITHUB_RUN_ATTEMPT: '1', GITHUB_JOB: 'gate', ...extra };
  const logs = [];
  const clock = { at: T0 };
  return {
    root, env, plain, logs, clock, log: line => logs.push(line), now: () => clock.at,
    lock: join(root, 'locks/adb.lock'), reservations: join(root, 'locks/adb.reservations'),
    runEnv: (run, job = 'android', repo = 'delorenj/example') => ({ ...env, GITHUB_REPOSITORY: repo, GITHUB_RUN_ID: String(run), GITHUB_JOB: job }),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}
const events = f => [...readEvents({ env: f.env })];
const take = (f, env = f.env, name = 'adb', extra = {}) => reserve(name, { env, now: f.now, policy, log: f.log, ...extra });
const keyOf = (repo, run) => `${repo.replace('/', '--')}--${run}`;
const settle = ms => new Promise(done => setTimeout(done, ms));
const fakeTimers = () => ({ setInterval: () => ({ unref() {} }), clearInterval() {} });
const shape = view => view.map(entry => [entry.place, entry.kind, entry.key ?? entry.lease_id, entry.blocking]);
// A ticket as a pinned or current hub would have written it (file name = ms15-counter-pid), for tests that place one by hand.
const putTicket = (f, ms, body = {}, name = 'adb') => {
  const queue = join(f.root, `locks/${name}.queue`);
  mkdirSync(queue, { recursive: true });
  const file = `${String(ms).padStart(15, '0')}-000001-00000009.json`;
  writeFileSync(join(queue, file), JSON.stringify({ format: 1, kind: 'lease', lease_id: body.lease_id ?? 'someone', holder: 'someone', why: 'waiting', pid: process.pid, host: hostname(), enqueued_at: new Date(ms).toISOString(), ...body }));
  return join(queue, file);
};

// ---------------------------------------------------------------------------------------------------- create, reuse, expire

test('reserve creates <owner>--<repo>--<run>/reservation.json once with wx, holds the AD-7 record and appends one claim event', () => {
  const f = fixture();
  try {
    const got = take(f);
    assert.deepEqual([got.status, got.key], ['claimed', 'delorenj--example--5']);
    assert.deepEqual(readdirSync(f.reservations), ['delorenj--example--5']);
    assert.deepEqual(readdirSync(join(f.reservations, 'delorenj--example--5')), ['reservation.json'], 'no grace.json until someone observes a free lock');
    const record = JSON.parse(readFileSync(join(f.reservations, 'delorenj--example--5/reservation.json'), 'utf8'));
    assert.deepEqual(record, { format: 1, run_key: 'delorenj--example--5', repo: 'delorenj/example', run: '5', reserved_at: new Date(T0).toISOString(), expires_at: new Date(T0 + 180 * MIN).toISOString(), grace_ms: 10 * MIN });
    assert.ok(f.logs.includes(`HUB_RESERVATION adb delorenj--example--5 until ${record.expires_at}`), f.logs.join('\n'));
    const [claim, ...rest] = events(f);
    assert.deepEqual(rest, [], 'exactly one event');
    assert.deepEqual([claim.event, claim.lock, claim.hold_kind, claim.run_key, claim.reserved_at, claim.expires_at, claim.grace_ms, claim.lease_id], ['claim', 'adb', 'reservation', 'delorenj--example--5', record.reserved_at, record.expires_at, 10 * MIN, null]);
    assert.deepEqual(claim.claimant, { kind: 'deploy', holder: null, repo: 'delorenj/example', run: '5', attempt: '1', job: 'gate' });
    assert.ok(!existsSync(f.lock), 'a Reservation is not a lock');
  } finally { f.cleanup(); }
});

test('a rerun reuses a live Reservation of its run: same record, no second claim; the other lock and other runs are separate', () => {
  const f = fixture();
  try {
    take(f);
    f.clock.at += 90 * MIN;
    const again = take(f, { ...f.env, GITHUB_RUN_ATTEMPT: '2' });
    assert.equal(again.status, 'reused');
    assert.equal(again.reservation.reserved_at, new Date(T0).toISOString(), 'it keeps the original place');
    assert.ok(f.logs.some(line => /^HUB_RESERVATION_REUSED adb delorenj--example--5 until /.test(line)));
    assert.deepEqual(events(f).map(event => event.event), ['claim']);
    assert.equal(take(f, f.runEnv(6)).status, 'claimed', 'another run');
    assert.equal(take(f, f.env, 'mac-ios').status, 'claimed', 'another lock');
    assert.deepEqual(readdirSync(f.reservations).sort(), ['delorenj--example--5', 'delorenj--example--6']);
  } finally { f.cleanup(); }
});

test('a Reservation past its ceiling is retired by the next reserve of that run, which claims a fresh one (one expiry, one new claim)', () => {
  const f = fixture();
  try {
    take(f);
    f.clock.at += 181 * MIN;
    const again = take(f);
    assert.equal(again.status, 'claimed');
    assert.equal(again.reservation.reserved_at, new Date(T0 + 181 * MIN).toISOString());
    assert.deepEqual(events(f).map(event => [event.event, event.reason]), [['claim', null], ['expiry', 'ceiling'], ['claim', null]]);
    assert.deepEqual(readdirSync(f.reservations), ['delorenj--example--5'], 'no .released directory is left behind');
  } finally { f.cleanup(); }
});

test('a person at a shell reserves nothing, a name that is not a deploy target is refused, and run keys are one safe path segment', () => {
  const f = fixture();
  try {
    assert.deepEqual(reserve('adb', { env: { HUB_LOCK_DIR: f.env.HUB_LOCK_DIR, HUB_EVENT_DIR: f.env.HUB_EVENT_DIR }, now: f.now, policy }), { status: 'skipped', key: null, reservation: null });
    assert.throws(() => take(f, f.env, 's24'), /bad reservation name "s24" \(adb or mac-ios\)/);
    assert.deepEqual([...RESERVABLE], ['adb', 'mac-ios']);
    assert.ok(!existsSync(f.reservations) && events(f).length === 0);
    assert.equal(runKey(f.env), 'delorenj--example--5');
    for (const bad of [{ GITHUB_REPOSITORY: 'no-slash' }, { GITHUB_REPOSITORY: 'a/b/c' }, { GITHUB_REPOSITORY: '../x/y' }, { GITHUB_REPOSITORY: 'a/..' + '/y' }, { GITHUB_RUN_ID: 'x1' }, { GITHUB_RUN_ID: '' }, { GITHUB_REPOSITORY: '.hidden/repo' }]) {
      assert.equal(runKey({ ...f.env, ...bad }), null, JSON.stringify(bad));
    }
    assert.equal(runKey({ ...f.env, GITHUB_REPOSITORY: 'delorenj/.github' }), 'delorenj--.github--5', 'a repository named .github is fine inside the key');
  } finally { f.cleanup(); }
});

test('a record that never became readable is waited for, then set aside once it is old, and reserve goes on', () => {
  const f = fixture();
  try {
    mkdirSync(join(f.reservations, 'delorenj--example--5'), { recursive: true });
    writeFileSync(join(f.reservations, 'delorenj--example--5/reservation.json'), '{"format":');
    const waits = [];
    // Young and unreadable: reserve waits (injected), never overwrites, and gives up after its rounds.
    assert.throws(() => take(f, f.env, 'adb', { wait: ms => waits.push(ms), now: () => Date.now() }), /never became readable/);
    assert.ok(waits.length > 0 && waits.every(ms => ms === 25));
    // Old and unreadable: set aside, claimed afresh.
    const later = Date.now() + 120_000;
    const got = take(f, f.env, 'adb', { now: () => later, wait: () => {} });
    assert.equal(got.status, 'claimed');
    assert.deepEqual(events(f).map(event => event.event), ['claim']);
  } finally { f.cleanup(); }
});

test('listReservations reads a name\'s Reservations in line order, expired ones with live false', () => {
  const f = fixture();
  try {
    take(f, f.runEnv(8));
    f.clock.at += MIN;
    take(f, f.runEnv(7));
    f.clock.at += 200 * MIN;
    assert.deepEqual(listReservations('adb', { env: f.env, now: f.now }).map(entry => [entry.key, entry.live, entry.grace_started_at]), [['delorenj--example--8', false, null], ['delorenj--example--7', false, null]]);
    f.clock.at -= 100 * MIN;
    assert.deepEqual(listReservations('adb', { env: f.env, now: f.now }).map(entry => [entry.key, entry.live]), [['delorenj--example--8', true], ['delorenj--example--7', true]]);
    assert.deepEqual(listReservations('mac-ios', { env: f.env }), []);
  } finally { f.cleanup(); }
});

// ---------------------------------------------------------------------------------------------------- the view

test('queueView lists Reservations by reserved_at among the tickets; only the first one in line blocks; the rest hold a place and block nothing', () => {
  const f = fixture();
  try {
    take(f, f.runEnv(6));                       // reserved at T0
    f.clock.at += 10 * MIN;
    take(f, f.runEnv(5));                       // reserved at T0 + 10 min
    f.clock.at += 5 * MIN;
    putTicket(f, T0 + 5 * MIN, { lease_id: 'between' });
    putTicket(f, T0 + 20 * MIN, { lease_id: 'late' });
    const view = queueView('adb', { env: f.env, now: f.now });
    assert.deepEqual(shape(view), [
      [1, 'reservation', 'delorenj--example--6', true],
      [2, 'lease', 'between', true],
      [3, 'reservation', 'delorenj--example--5', false],
      [4, 'lease', 'late', true],
    ], 'by reserved_at, the first Reservation blocks, the second only holds its place');
    assert.deepEqual([view[0].run_key, view[0].repo, view[0].run, view[0].grace_ms, view[0].grace.state, view[0].holder, view[0].stale], ['delorenj--example--6', 'delorenj/example', '6', 10 * MIN, 'pending', 'delorenj/example#6', false]);
    assert.equal(view[0].file, `${String(T0).padStart(15, '0')}-reservation-delorenj--example--6`);
  } finally { f.cleanup(); }
});

test('a Reservation whose run has a live ticket is hidden, and the next one in line becomes the head; a dead ticket hides nothing', () => {
  const f = fixture();
  try {
    take(f, f.runEnv(6));
    f.clock.at += MIN;
    take(f, f.runEnv(5));
    assert.deepEqual(shape(queueView('adb', { env: f.env, now: f.now })), [[1, 'reservation', 'delorenj--example--6', true], [2, 'reservation', 'delorenj--example--5', false]]);
    putTicket(f, T0 + MIN, { lease_id: 'job:delorenj/example#6.1/android', kind: 'job', repo: 'delorenj/example', run: '6', attempt: '1', job: 'android' });
    assert.deepEqual(shape(queueView('adb', { env: f.env, now: f.now })), [[1, 'job', 'job:delorenj/example#6.1/android', true], [2, 'reservation', 'delorenj--example--5', true]], 'run 6 asks: its Reservation is hidden and run 5 is the head');
    // a ticket of another repo's run 6 does not hide it
    rmSync(join(f.root, 'locks/adb.queue'), { recursive: true });
    putTicket(f, T0 + MIN, { lease_id: 'elsewhere', kind: 'job', repo: 'delorenj/other', run: '6', attempt: '1', job: 'android' });
    assert.deepEqual(shape(queueView('adb', { env: f.env, now: f.now })).map(row => row[2]), ['delorenj--example--6', 'elsewhere', 'delorenj--example--5']);
    // a dead ticket of run 6 does not hide it
    rmSync(join(f.root, 'locks/adb.queue'), { recursive: true });
    putTicket(f, T0 + MIN, { lease_id: 'ghost', kind: 'job', repo: 'delorenj/example', run: '6', pid: 2 ** 22 + 12345, host: hostname() });
    assert.equal(queueView('adb', { env: f.env, now: f.now }).filter(entry => entry.kind === 'reservation').length, 2);
  } finally { f.cleanup(); }
});

test('the head Reservation blocks until its grace is over, and a Reservation never blocks after that; the view only reads the grace', () => {
  const f = fixture();
  try {
    take(f, f.runEnv(6));
    f.clock.at += 5 * MIN;
    putTicket(f, T0 + 4 * MIN, { lease_id: 'behind' });
    const graceFile = join(f.reservations, 'delorenj--example--6/grace.json');
    const head = () => queueView('adb', { env: f.env, now: f.now })[0];
    assert.deepEqual([head().blocking, head().grace.state, head().grace.started_at], [true, 'pending', null]);
    assert.ok(!existsSync(graceFile), 'reading creates nothing');
    writeFileSync(graceFile, JSON.stringify({ format: 1, grace_started_at: new Date(f.clock.at).toISOString() }));
    assert.deepEqual([head().blocking, head().grace.state], [true, 'running']);
    f.clock.at += 10 * MIN - 1;
    assert.equal(head().blocking, true, 'a millisecond before the grace ends');
    f.clock.at += 1;
    assert.deepEqual([head().blocking, head().grace.state, head().grace.ends_at], [false, 'over', new Date(f.clock.at).toISOString()]);
    assert.equal(head().kind, 'reservation', 'it keeps its place');
    // a grace.json being written (empty) counts from its file time instead of failing the read
    writeFileSync(graceFile, '');
    assert.equal(head().grace.state === 'pending', false);
  } finally { f.cleanup(); }
});

test('an expired Reservation is listed only for status (stale, blocking nothing); a pruning acquirer retires it by renaming to .released-<key>-<ms>, and only the winner appends expiry', () => {
  const f = fixture();
  try {
    take(f);
    f.clock.at += 181 * MIN;
    assert.deepEqual(queueView('adb', { env: f.env, now: f.now }), [], 'an observer does not see it');
    const stale = queueView('adb', { env: f.env, now: f.now, includeStale: true });
    assert.deepEqual(shape(stale), [[1, 'reservation', 'delorenj--example--5', false]]);
    assert.equal(stale[0].stale, true);
    assert.deepEqual(readdirSync(f.reservations), ['delorenj--example--5'], 'observing prunes nothing');
    const renamed = [];
    assert.deepEqual(queueView('adb', { env: f.env, now: f.now, prune: true, afterRename: moved => renamed.push([basename(moved), readdirSync(f.reservations).sort()]) }), []);
    assert.equal(renamed.length, 1);
    assert.match(renamed[0][0], /^\.released-delorenj--example--5-\d+$/);
    assert.deepEqual(renamed[0][1], [renamed[0][0]], 'at the rename the key is already free');
    assert.deepEqual(readdirSync(f.reservations), [], 'the winner deleted it');
    assert.deepEqual(queueView('adb', { env: f.env, now: f.now, prune: true }), []);
    const expiries = events(f).filter(event => event.event === 'expiry');
    assert.equal(expiries.length, 1);
    assert.deepEqual([expiries[0].hold_kind, expiries[0].run_key, expiries[0].reason, expiries[0].held_ms], ['reservation', 'delorenj--example--5', 'ceiling', 181 * MIN]);
    take(f);
    assert.equal(listReservations('adb', { env: f.env, now: f.now }).length, 1, 'the key can be reserved again at once');
  } finally { f.cleanup(); }
});

test('several processes pruning one expired Reservation at once append exactly one expiry', async () => {
  const f = fixture();
  try {
    take(f);
    const at = T0 + 181 * MIN;
    const code = `import { queueView } from ${JSON.stringify(lockModule)}; queueView('adb', { prune: true, now: () => ${at} });`;
    const children = Array.from({ length: 6 }, () => new Promise(done => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', code], { env: { PATH: process.env.PATH, ...f.env }, stdio: 'ignore' });
      child.on('close', done);
    }));
    assert.deepEqual(await Promise.all(children), [0, 0, 0, 0, 0, 0]);
    assert.equal(events(f).filter(event => event.event === 'expiry').length, 1);
    assert.deepEqual(readdirSync(f.reservations), []);
  } finally { f.cleanup(); }
});

test('an old pinned version\'s bare mkdir sees no owner for a Reservation, and listLocks() does not list one', () => {
  const f = fixture();
  try {
    take(f);
    take(f, f.env, 'mac-ios');
    assert.deepEqual(listLocks({ env: f.env, now: f.now }), [], 'no lock, so nothing is listed');
    assert.ok(!existsSync(f.lock) && readOwner(f.lock) === null);
    // what a pinned version does: mkdir <name>.lock and succeed, because only the .lock path is its lock
    mkdirSync(f.lock);
    assert.equal(readOwner(f.lock), null, 'no owner.json beside a Reservation');
    rmSync(f.lock, { recursive: true });
    assert.ok(readdirSync(join(f.root, 'locks')).includes('adb.reservations'));
    assert.deepEqual(readdirSync(join(f.root, 'locks')).filter(entry => entry.endsWith('.lock')), []);
  } finally { f.cleanup(); }
});

// ---------------------------------------------------------------------------------------------------- the run asks

test('a Job Hold of the run takes its Reservation\'s place: ms15 is reserved_at, enqueued_at is the real time, the Reservation is hidden and it is served before a later arrival', async () => {
  const f = fixture();
  try {
    const reservedAt = Date.now() - 30 * MIN;
    await acquireLease('adb', { holder: 'agent-a', why: 'proof', forMs: 60 * MIN, id: 'holder', env: f.plain, log: f.log });
    take(f, f.runEnv(5), 'adb', { now: () => reservedAt });
    const between = putTicket(f, reservedAt + 5 * MIN, { lease_id: 'between', pid: process.pid });
    const served = [];
    const asking = withLock('adb', async () => { served.push('run 5'); }, { env: f.runEnv(5, 'android'), log: f.log, pollMs: 5, timeoutMs: 10_000, timers: fakeTimers() });
    await settle(40);
    const view = queueView('adb', { env: f.env });
    assert.deepEqual(shape(view).map(row => row.slice(0, 2)), [[1, 'job'], [2, 'lease']], 'the run is ahead of the earlier-arriving ticket... and its Reservation is hidden');
    const [job] = view;
    assert.equal(job.file.slice(0, 15), String(reservedAt).padStart(15, '0'), 'the ticket sits at the Reservation\'s place');
    assert.ok(Date.parse(job.enqueued_at) > reservedAt + 25 * MIN, 'enqueued_at is the real request time');
    assert.equal(job.reservation, 'delorenj--example--5');
    assert.equal(view[1].file, basename(between));
    releaseLease('adb', 'holder', { env: f.plain });
    await settle(60);
    assert.deepEqual(served, ['run 5']);
    rmSync(between);
    await asking;
    const request = events(f).find(event => event.event === 'request' && event.hold_kind === 'job');
    assert.equal(request.reservation, 'delorenj--example--5');
    assert.equal(request.claimant.job, 'android');
    // the run's Reservation is visible again once its ticket is gone (releasing it is Story 2.6)
    assert.deepEqual(shape(queueView('adb', { env: f.env })).map(row => row.slice(0, 2)), [[1, 'reservation']]);
  } finally { f.cleanup(); }
});

test('a request of another run, or of a run without a Reservation, keeps its own place and its ticket names no reservation', async () => {
  const f = fixture();
  try {
    await acquireLease('adb', { holder: 'agent-a', why: 'proof', forMs: 60 * MIN, id: 'holder', env: f.plain, log: f.log });
    take(f, f.runEnv(5), 'adb', { now: () => Date.now() });
    await settle(5);
    const waiting = withLock('adb', async () => {}, { env: f.runEnv(6, 'android'), log: f.log, pollMs: 5, timeoutMs: 10_000, timers: fakeTimers() });
    await settle(40);
    const view = queueView('adb', { env: f.env });
    assert.deepEqual(shape(view).map(row => [row[0], row[1]]), [[1, 'reservation'], [2, 'job']]);
    assert.equal(view[1].reservation, null);
    assert.ok(Math.abs(Number(view[1].file.slice(0, 15)) - Date.parse(view[1].enqueued_at)) < 1000, 'its ticket is named for its own request time');
    releaseLease('adb', 'holder', { env: f.plain });
    // the head Reservation (run 5, not asking) holds the free lock for its grace
    await settle(60);
    assert.ok(existsSync(join(f.reservations, 'delorenj--example--5/grace.json')), 'the waiter that saw a free lock started the grace');
    rmSync(f.reservations, { recursive: true });
    await waiting;
  } finally { f.cleanup(); }
});

test('a try of the Reservation\'s own run is not blocked by it, and it starts no grace', async () => {
  const f = fixture();
  try {
    take(f, f.runEnv(5));
    const ran = [];
    await withLock('adb', async () => { ran.push('own try'); }, { env: f.runEnv(5, 'plan'), log: f.log, timeoutMs: 0, timers: fakeTimers(), now: f.now });
    assert.deepEqual(ran, ['own try']);
    assert.ok(!existsSync(join(f.reservations, 'delorenj--example--5/grace.json')));
    // another run's try is blocked by the head Reservation, and its observation starts the grace
    await assert.rejects(withLock('adb', async () => ran.push('other'), { env: f.runEnv(6, 'plan'), log: f.log, timeoutMs: 0, timers: fakeTimers(), now: f.now }), error => error.code === 'HUB_LOCK_TIMEOUT' && /1 waiter ahead/.test(error.message) && /delorenj\/example#5 \(reservation\)/.test(error.message));
    assert.deepEqual(ran, ['own try']);
    assert.ok(existsSync(join(f.reservations, 'delorenj--example--5/grace.json')));
  } finally { f.cleanup(); }
});

// ---------------------------------------------------------------------------------------------------- grace

test('the first try or acquirer on a free lock with an unasking head Reservation creates grace.json once and appends one grace event; others wait until it ends, then take the lock', async () => {
  const f = fixture();
  try {
    take(f, f.runEnv(5));
    const graceFile = join(f.reservations, 'delorenj--example--5/grace.json');
    const tryLease = id => acquireLease('adb', { holder: 'agent-a', why: 'proof', forMs: MIN, id, env: f.plain, log: f.log, now: f.now });
    f.clock.at += 2 * MIN;
    await assert.rejects(tryLease('t1'), error => error.code === 'HUB_LOCK_TIMEOUT');
    const stamp = JSON.parse(readFileSync(graceFile, 'utf8'));
    assert.deepEqual(stamp, { format: 1, grace_started_at: new Date(T0 + 2 * MIN).toISOString() });
    f.clock.at += 5 * MIN;
    await assert.rejects(tryLease('t2'), error => error.code === 'HUB_LOCK_TIMEOUT', 'still inside the grace');
    assert.deepEqual(JSON.parse(readFileSync(graceFile, 'utf8')), stamp, 'created once: a second observer changes nothing');
    const graces = events(f).filter(event => event.event === 'grace');
    assert.equal(graces.length, 1);
    assert.deepEqual([graces[0].hold_kind, graces[0].run_key, graces[0].grace_ms, graces[0].grace_started_at, graces[0].lock], ['reservation', 'delorenj--example--5', 10 * MIN, stamp.grace_started_at, 'adb']);
    f.clock.at += 5 * MIN - 1;
    await assert.rejects(tryLease('t3'), error => error.code === 'HUB_LOCK_TIMEOUT', 'a millisecond before it ends');
    f.clock.at += 1;
    const got = await tryLease('t4');
    assert.equal(got.lease_id, 't4', 'after the grace the Reservation keeps its place but blocks nothing');
    assert.equal(queueView('adb', { env: f.env, now: f.now })[0].kind, 'reservation');
    assert.equal(events(f).filter(event => event.event === 'grace').length, 1);
  } finally { f.cleanup(); }
});

test('a waiting job behind a free lock\'s head Reservation waits out the grace on the injected clock and is then served, with one grace event between its request and its acquire', async () => {
  const f = fixture();
  try {
    take(f, f.runEnv(5));
    f.clock.at += 1000;
    const sleeps = [];
    const sleep = async ms => { sleeps.push(ms); f.clock.at += ms; };
    const got = [];
    await withLock('adb', async () => { got.push('run 6'); }, { env: f.runEnv(6, 'android'), log: f.log, pollMs: 30_000, timeoutMs: 60 * MIN, now: f.now, sleep, timers: fakeTimers() });
    assert.deepEqual(got, ['run 6']);
    const ticks = sleeps.length;
    assert.ok(ticks >= 20 && ticks <= 22, `waited the 10 minutes of grace in 30 s polls, not ${ticks}`);
    const names = events(f).map(event => event.event);
    assert.deepEqual(names, ['claim', 'request', 'grace', 'acquire', 'release']);
    const acquire = events(f).find(event => event.event === 'acquire');
    assert.ok(acquire.waited_ms >= 10 * MIN && acquire.waited_ms <= 11 * MIN, `waited ${acquire.waited_ms}`);
  } finally { f.cleanup(); }
});

test('the grace is created only while the lock is free: a held lock stamps nothing, and a released Reservation\'s late stamp fails quietly', async () => {
  const f = fixture();
  try {
    take(f, f.runEnv(5));
    f.clock.at += 1000;
    // the holder took the lock before the Reservation (a pinned version, say): a lock that is held is not free
    mkdirSync(f.lock);
    writeFileSync(join(f.lock, 'owner.json'), JSON.stringify({ pid: process.pid, host: hostname(), repo: 'delorenj/other', run: '1', started_at: new Date(T0).toISOString() }));
    await assert.rejects(acquireLease('adb', { holder: 'agent-b', why: 'proof', forMs: MIN, id: 'try', env: f.plain, log: f.log, now: f.now }), error => error.code === 'HUB_LOCK_TIMEOUT');
    assert.ok(!existsSync(join(f.reservations, 'delorenj--example--5/grace.json')), 'the lock is held: no grace');
    // the Reservation goes away between the view and the stamp (a release renames the directory): ENOENT, nothing written, no event
    const hold = join(f.reservations, 'delorenj--example--5');
    rmSync(f.lock, { recursive: true });
    let renamed = false;
    await assert.rejects(acquireLease('adb', {
      holder: 'agent-b', why: 'proof', forMs: MIN, id: 'try2', env: f.plain, log: f.log,
      // the Reservation is released (its directory renamed away) in the instant between the view and the grace stamp
      now: () => { if (!renamed && new Error().stack.includes('startGrace')) { renamed = true; rmSync(hold, { recursive: true }); } return f.clock.at; },
    }), error => error.code === 'HUB_LOCK_TIMEOUT');
    assert.ok(renamed);
    assert.equal(events(f).filter(event => event.event === 'grace').length, 0, 'ENOENT on the stamp: ignored, no event');
  } finally { f.cleanup(); }
});

test('acquireLease behind a head Reservation waits for the grace like a job: first in line after it, served when it ends', async () => {
  const f = fixture();
  try {
    take(f, f.runEnv(5));
    f.clock.at += 1000;
    const sleep = async ms => { f.clock.at += ms; };
    const got = await acquireLease('adb', { holder: 'agent-a', why: 'proof', forMs: MIN, waitMs: 30 * MIN, id: 'patient', env: f.plain, log: f.log, now: f.now, sleep, pollMs: 60_000 });
    assert.equal(got.lease_id, 'patient');
    assert.ok(Date.parse(got.started_at) >= T0 + 10 * MIN);
    assert.deepEqual(events(f).map(event => event.event), ['claim', 'request', 'grace', 'acquire']);
  } finally { f.cleanup(); }
});

test('the same-run passthrough survives a rerun: attempt 2 asks at the original Reservation\'s place', async () => {
  const f = fixture();
  try {
    const reservedAt = Date.now() - 20 * MIN;
    await acquireLease('adb', { holder: 'agent-a', why: 'proof', forMs: 60 * MIN, id: 'holder', env: f.plain, log: f.log });
    take(f, f.runEnv(5), 'adb', { now: () => reservedAt });
    const rerun = { ...f.runEnv(5, 'android'), GITHUB_RUN_ATTEMPT: '2' };
    take(f, rerun, 'adb', { now: () => Date.now() });
    const waiting = withLock('adb', async () => {}, { env: rerun, log: f.log, pollMs: 5, timeoutMs: 10_000, timers: fakeTimers() });
    await settle(40);
    const [job] = queueView('adb', { env: f.env });
    assert.deepEqual([job.kind, job.attempt, job.file.slice(0, 15)], ['job', '2', String(reservedAt).padStart(15, '0')]);
    releaseLease('adb', 'holder', { env: f.plain });
    await waiting;
  } finally { f.cleanup(); }
});

test('the policy file gives the grace and the ceiling that reserve stamps into the record when no policy is injected', () => {
  const f = fixture();
  try {
    const { queue } = loadPolicy().policy;
    reserve('adb', { env: f.env, now: f.now, log: f.log });
    const [entry] = listReservations('adb', { env: f.env, now: f.now });
    assert.equal(entry.grace_ms, queue.grace_min * MIN);
    assert.equal(Date.parse(entry.expires_at) - Date.parse(entry.reserved_at), queue.reservation_ceiling_min * MIN);
    assert.deepEqual([queue.grace_min, queue.reservation_ceiling_min], [10, 180]);
  } finally { f.cleanup(); }
});
