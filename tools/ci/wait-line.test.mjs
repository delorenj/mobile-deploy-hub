// The wait line (FR-16, Story 4.2): `HUB_LOCK_WAIT <name> held by <holder> position=<n> eta=<lo>-<hi>[ low-data]`, one reporter for every
// Queued waiter (a Lease and a deploy job here), printed on a position change or an ETA move over a minute and recomputed on a
// position change or every ETA_REFRESH_MS. A fake clock drives the polls through the injected `sleep`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ETA_REFRESH_MS, acquireLease, buildTicket, releaseLease, withLock } from './lib/lock.mjs';
import { hermetic } from './test-fixtures.mjs';

hermetic(); // offline, outside any workflow job, scratch HUB_EVENT_DIR and HUB_LOCK_DIR (test-fixtures.mjs)

const MIN = 60_000;
const HOST_ID = 'wait-line-machine';
const policyOf = () => ({ queue: { deploy_target_lease_max_min: 60, eta_window_days: 30, eta_low_data_min_holds: 20, hold_allowance_min: { android: 15 } } });
const timers = { setInterval: () => ({ unref() {} }), clearInterval() {} };
const waitLines = logs => logs.filter(line => line.startsWith('HUB_LOCK_WAIT'));

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'hub-wait-line-'));
  const env = { HUB_LOCK_DIR: join(root, 'locks'), HUB_EVENT_DIR: join(root, 'events'), GITHUB_REPOSITORY: 'delorenj/example', GITHUB_RUN_ID: '9', GITHUB_RUN_ATTEMPT: '1', GITHUB_JOB: 'android' };
  return { root, env, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
const existsQueue = (f, count) => { try { return readdirSync(join(f.env.HUB_LOCK_DIR, 'adb.queue')).filter(name => name.endsWith('.json')).length === count; } catch { return false; } };
const settle = ms => new Promise(done => setTimeout(done, ms));
const until = async (check, what) => {
  for (let tries = 0; tries < 1000; tries += 1) { if (check()) return; await settle(10); }
  assert.fail(`never happened: ${what}`);
};
const holdFor = (f, id, forMs, now) => acquireLease('adb', { holder: 'holder', why: 'device proof', forMs, id, env: f.env, log: () => {}, hostId: HOST_ID, now });

test('a Lease waiter prints one full line, stays quiet for 5 minutes, then recomputes once and prints the new range', async () => {
  const f = fixture();
  try {
    let clock = Date.now();
    const start = clock;
    const now = () => clock;
    await holdFor(f, 'held', 60 * MIN, now);
    const logs = [];
    const afterEta = [];
    const POLL = 10_000;
    const checks = [];
    const sleep = async ms => {
      clock += ms;
      const spent = clock - start;
      if (spent < ETA_REFRESH_MS) checks.push([waitLines(logs).length, afterEta.length]);
      if (spent >= 6 * MIN) releaseLease('adb', 'held', { env: f.env });
    };
    const taken = await acquireLease('adb', {
      holder: 'waiter', why: 'queued', forMs: 5 * MIN, waitMs: 2 * 60 * MIN, id: 'waiter', env: f.env, log: line => logs.push(line),
      pollMs: POLL, sleep, now, hostId: HOST_ID, policy: policyOf(), afterEta: () => afterEta.push(clock),
    });
    assert.equal(taken.lease_id, 'waiter');
    assert.ok(checks.length >= 25, 'many polls inside the first 5 minutes');
    assert.ok(checks.every(([lines, calls]) => lines === 1 && calls === 0), 'one line, and no recompute, while the wait is stable');
    const lines = waitLines(logs);
    assert.equal(lines.length, 2, lines.join('\n'));
    assert.match(lines[0], /^HUB_LOCK_WAIT adb held by lease held of holder \(device proof\) until \S+ position=1 eta=0s-1h00m low-data$/);
    assert.match(lines[1], /^HUB_LOCK_WAIT adb held by lease held of holder \(device proof\) until \S+ position=1 eta=0s-55m low-data$/);
    assert.equal(afterEta.length, 1, 'one recompute, at the 5-minute mark');
    assert.ok(afterEta[0] - start >= ETA_REFRESH_MS);
  } finally { f.cleanup(); }
});

test('two Lease waiters: the second is at position 2, and cancelling the first moves it to 1 with a recompute', async () => {
  const f = fixture();
  try {
    await holdFor(f, 'held', 30 * MIN, Date.now);
    const first = [];
    const second = [];
    const recomputes = { first: 0, second: 0 };
    const common = { holder: 'waiter', why: 'queued', forMs: 5 * MIN, waitMs: 60_000, env: f.env, pollMs: 5, hostId: HOST_ID, policy: policyOf() };
    const one = acquireLease('adb', { ...common, id: 'one', log: line => first.push(line), afterEta: () => { recomputes.first += 1; } });
    await until(() => waitLines(first).length === 1, 'the first waiter prints');
    const two = acquireLease('adb', { ...common, id: 'two', log: line => second.push(line), afterEta: () => { recomputes.second += 1; } });
    await until(() => waitLines(second).length === 1, 'the second waiter prints');
    assert.match(waitLines(first)[0], / position=1 eta=\S+/);
    assert.match(waitLines(second)[0], /^HUB_LOCK_WAIT adb held by lease held of holder .* position=2 eta=\S+/);
    await settle(60);
    assert.equal(waitLines(second).length, 1, 'a stable wait prints nothing more');
    assert.equal(recomputes.second, 0);
    releaseLease('adb', 'one', { env: f.env });
    await assert.rejects(one, error => error.code === 'HUB_LEASE_CANCELLED');
    await until(() => waitLines(second).length === 2, 'the second waiter moves up');
    assert.match(waitLines(second)[1], / position=1 eta=\S+/);
    assert.equal(recomputes.second, 1, 'the position change recomputes once');
    releaseLease('adb', 'held', { env: f.env });
    assert.equal((await two).lease_id, 'two');
  } finally { f.cleanup(); }
});

test('a deploy job (Queued withLock) behind a Lease prints the same line shape to its own log', async () => {
  const f = fixture();
  try {
    await holdFor(f, 'held', 30 * MIN, Date.now);
    const logs = [];
    const ran = [];
    const job = withLock('adb', async () => { ran.push('job'); }, { env: f.env, log: line => logs.push(line), timeoutMs: 60_000, pollMs: 5, hostId: HOST_ID, timers, policy: policyOf() });
    await until(() => waitLines(logs).length === 1, 'the job prints its wait line');
    await settle(60);
    assert.equal(waitLines(logs).length, 1);
    assert.match(waitLines(logs)[0], /^HUB_LOCK_WAIT adb held by lease held of holder \(device proof\) until \S+ position=1 eta=0s-\d+m low-data$/);
    releaseLease('adb', 'held', { env: f.env });
    await job;
    assert.deepEqual(ran, ['job']);
  } finally { f.cleanup(); }
});

test('an ETA that fails on a recompute logs HUB_ETA_FAILED once, prints eta=?, and the wait goes on', async () => {
  const f = fixture();
  try {
    let clock = Date.now();
    const start = clock;
    const now = () => clock;
    await holdFor(f, 'held', 60 * MIN, now);
    const policy = policyOf();
    const logs = [];
    const sleep = async ms => {
      clock += ms;
      const spent = clock - start;
      if (spent >= 4 * MIN) policy.queue.eta_window_days = 0; // the policy breaks after the enqueue ETA was computed
      if (spent >= 12 * MIN) releaseLease('adb', 'held', { env: f.env });
    };
    const taken = await acquireLease('adb', { holder: 'waiter', why: 'queued', forMs: 5 * MIN, waitMs: 2 * 60 * MIN, id: 'waiter', env: f.env, log: line => logs.push(line), pollMs: 10_000, sleep, now, hostId: HOST_ID, policy });
    assert.equal(taken.lease_id, 'waiter', 'the wait still ends in the lock');
    const lines = waitLines(logs);
    assert.equal(lines.length, 2, lines.join('\n'));
    assert.match(lines[0], / position=1 eta=0s-1h00m low-data$/);
    assert.match(lines[1], / position=1 eta=\?$/);
    assert.equal(logs.filter(line => line.startsWith('HUB_ETA_FAILED')).length, 1, 'once per waiter, however many recomputes fail');
  } finally { f.cleanup(); }
});

test('the print gate: a time-triggered recompute that moves the range by under a minute at the same position prints nothing', async () => {
  const f = fixture();
  try {
    let clock = Date.now();
    const start = clock;
    const now = () => clock;
    // The lock is free; the only blocker ahead is a job ticket of this live process, named earlier than the waiter's. Its ETA is the
    // constant job allowance (android, 15 min), so every recompute gives the same range.
    const queue = join(f.env.HUB_LOCK_DIR, 'adb.queue');
    const ahead = join(queue, `${String(clock - 1000).padStart(15, '0')}-000000-${String(process.pid).padStart(8, '0')}.json`);
    mkdirSync(queue, { recursive: true });
    writeFileSync(ahead, JSON.stringify(buildTicket('job', { env: f.env, requested: clock - 1000, deadline: clock + 4 * 60 * MIN, hostId: HOST_ID })));
    const logs = [];
    const afterEta = [];
    const sleep = async ms => {
      clock += ms;
      if (clock - start >= 6 * MIN) rmSync(ahead, { force: true });
    };
    const taken = await acquireLease('adb', {
      holder: 'waiter', why: 'queued', forMs: 5 * MIN, waitMs: 2 * 60 * MIN, id: 'waiter', env: f.env, log: line => logs.push(line),
      pollMs: 10_000, sleep, now, hostId: HOST_ID, policy: policyOf(), afterEta: () => afterEta.push(clock),
    });
    assert.equal(taken.lease_id, 'waiter');
    assert.equal(afterEta.length, 1, 'the 5-minute mark recomputed');
    const lines = waitLines(logs);
    assert.equal(lines.length, 1, lines.join('\n'));
    assert.match(lines[0], / position=2 eta=0s-15m low-data$/);
  } finally { f.cleanup(); }
});

test('the print gate: a position change prints even when the range moved by under a minute', async () => {
  const f = fixture();
  try {
    await holdFor(f, 'held', 30 * MIN, Date.now);
    const logs = [];
    const recomputes = [];
    const common = { holder: 'waiter', why: 'queued', env: f.env, pollMs: 5, hostId: HOST_ID, policy: policyOf(), waitMs: 60_000 };
    // The waiter ahead states 30 s, so its leaving moves the waiter's range by 30 s: under the minute that alone would print.
    const one = acquireLease('adb', { ...common, forMs: 30_000, id: 'one', log: () => {} });
    await until(() => existsQueue(f, 1), 'the first waiter is queued');
    const two = acquireLease('adb', { ...common, forMs: 5 * MIN, id: 'two', log: line => logs.push(line), afterEta: () => recomputes.push(1) });
    await until(() => waitLines(logs).length === 1, 'the second waiter prints');
    assert.match(waitLines(logs)[0], / position=2 eta=/);
    releaseLease('adb', 'one', { env: f.env });
    await assert.rejects(one, error => error.code === 'HUB_LEASE_CANCELLED');
    await until(() => waitLines(logs).length === 2, 'the position change prints');
    assert.match(waitLines(logs)[1], / position=1 eta=/);
    assert.equal(recomputes.length, 1);
    releaseLease('adb', 'held', { env: f.env });
    assert.equal((await two).lease_id, 'two');
  } finally { f.cleanup(); }
});

test('a try has no wait line: neither an acquireLease try nor a withLock try logs HUB_LOCK_WAIT or HUB_ETA_FAILED', async () => {
  const f = fixture();
  try {
    await holdFor(f, 'held', 30 * MIN, Date.now);
    const logs = [];
    const log = line => logs.push(line);
    await assert.rejects(acquireLease('adb', { holder: 'try', why: 'try', forMs: MIN, waitMs: 0, id: 'try', env: f.env, log, hostId: HOST_ID, policy: policyOf() }), error => error.code === 'HUB_LOCK_TIMEOUT');
    await assert.rejects(withLock('adb', async () => {}, { env: f.env, log, timeoutMs: 0, hostId: HOST_ID, timers, policy: policyOf() }), error => error.code === 'HUB_LOCK_TIMEOUT');
    assert.deepEqual(logs.filter(line => /^HUB_(LOCK_WAIT|ETA_FAILED)/.test(line)), []);
  } finally { f.cleanup(); }
});
