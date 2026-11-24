// The wait line (FR-16, Story 4.2): `HUB_LOCK_WAIT <name> held by <holder> position=<n> eta=<lo>-<hi>[ low-data]`, one reporter for every
// Queued waiter (a Lease and a deploy job here), printed on a position change or an ETA move over a minute and recomputed on a
// position change or every ETA_REFRESH_MS. A fake clock drives the polls through the injected `sleep`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ETA_REFRESH_MS, acquireLease, releaseLease, withLock } from './lib/lock.mjs';
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
