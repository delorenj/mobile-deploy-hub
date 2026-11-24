// Story 2.4 (MOBI-33, AD-11, AD-12, AD-21): the wait deadline that beats GitHub's job timeout. The helper is pure and every input is
// injected; the Queue tests run against a temp HUB_LOCK_DIR/HUB_EVENT_DIR with an injected clock, and the workflow is parsed, not run.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RUNNER_WORKER, jobDeadline, jobStart, jobTimeoutMs, systemProcess } from './lib/deadline.mjs';
import { acquireLease, releaseLease, withLock } from './lib/lock.mjs';
import { loadPolicy } from './lib/policy.mjs';
import { readEvents } from './lib/events.mjs';
import { hermetic } from './test-fixtures.mjs';

hermetic();

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../..');
const T0 = Date.parse('2026-11-23T10:00:00Z');
const MIN = 60_000;
const { policy } = loadPolicy();

// ---- the helper ----

test('the deadline is job_start + timeout - margin - the job\'s allowance, for each waiting job, from the repo policy', () => {
  const start = T0 - 3 * MIN;
  const at = (job, minutes) => jobDeadline({ env: { GITHUB_JOB: job, HUB_JOB_TIMEOUT_MINUTES: String(minutes) }, policy, startedMs: start }).at;
  assert.equal(at('plan', 20), start + (20 - 2 - 5) * MIN);
  assert.equal(at('android', 45), start + (45 - 2 - 15) * MIN);
  assert.equal(at('ios', 120), start + (120 - 2 - 60) * MIN, 'ios takes mac-ios up to twice, and its allowance covers both holds');
  const detail = jobDeadline({ env: { GITHUB_JOB: 'ios', HUB_JOB_TIMEOUT_MINUTES: '120' }, policy, startedMs: start });
  assert.deepEqual(detail, { at: start + 58 * MIN, job_start: start, timeout_ms: 120 * MIN, margin_ms: 2 * MIN, allowance_ms: 60 * MIN });
  // The policy or just its queue block; a tuning change moves the deadline and nothing else does.
  const tuned = { wait_margin_min: 3, hold_allowance_min: { plan: 1, android: 1, ios: 90 } };
  assert.equal(jobDeadline({ env: { GITHUB_JOB: 'ios', HUB_JOB_TIMEOUT_MINUTES: '120' }, policy: tuned, startedMs: start }).at, start + 27 * MIN);
  assert.equal(jobDeadline({ env: { GITHUB_JOB: 'ios', HUB_JOB_TIMEOUT_MINUTES: '120' }, policy: { queue: tuned }, startedMs: start }).at, start + 27 * MIN);
});

test('a job with no timeout, no allowance or a malformed timeout has no deadline, so its wait keeps its own timeout', () => {
  const env = { GITHUB_JOB: 'android', HUB_JOB_TIMEOUT_MINUTES: '45' };
  assert.notEqual(jobDeadline({ env, policy, startedMs: T0 }), null);
  assert.equal(jobDeadline({ env: { GITHUB_JOB: 'android' }, policy, startedMs: T0 }), null, 'no HUB_JOB_TIMEOUT_MINUTES: a person at a shell');
  assert.equal(jobDeadline({ env: { HUB_JOB_TIMEOUT_MINUTES: '45' }, policy, startedMs: T0 }), null, 'no GITHUB_JOB');
  for (const job of ['deliver-android', 'deliver-ios', 'ios-export', 'announce', '__proto__', 'constructor']) {
    assert.equal(jobDeadline({ env: { ...env, GITHUB_JOB: job }, policy, startedMs: T0 }), null, job);
  }
  for (const bad of ['', '0', '-5', '1.5', 'abc', '45min', '9999999', ' ']) {
    assert.equal(jobTimeoutMs({ HUB_JOB_TIMEOUT_MINUTES: bad }), null, `"${bad}"`);
    assert.equal(jobDeadline({ env: { ...env, HUB_JOB_TIMEOUT_MINUTES: bad }, policy, startedMs: T0 }), null, `"${bad}"`);
  }
  assert.equal(jobTimeoutMs({ HUB_JOB_TIMEOUT_MINUTES: ' 45 ' }), 45 * MIN);
  assert.equal(jobDeadline({ env, policy: {}, startedMs: T0 }), null, 'no queue block');
});

test('job_start is the start of the nearest Runner.Worker ancestor, else the process start, else now minus the uptime', () => {
  const table = new Map([
    [900, { ppid: 800, comm: 'node', started_ms: T0 + 9 * MIN }],
    [800, { ppid: 700, comm: 'bash', started_ms: T0 + 8 * MIN }],
    [700, { ppid: 600, comm: RUNNER_WORKER, started_ms: T0 + 5 * MIN }],
    [600, { ppid: 500, comm: RUNNER_WORKER, started_ms: T0 }],
    [500, { ppid: 1, comm: 'Runner.Listener', started_ms: T0 - MIN }],
  ]);
  const lookup = pid => table.get(pid) ?? null;
  assert.equal(jobStart({ pid: 900, lookup }), T0 + 5 * MIN, 'the nearest one');
  assert.equal(jobStart({ pid: 800, lookup }), T0 + 5 * MIN);
  assert.equal(jobStart({ pid: 500, lookup, now: () => T0 + 99 * MIN, uptime: () => 60 }), T0 - MIN, 'no worker above: this process\'s own start');
  assert.equal(jobStart({ pid: 4242, lookup, now: () => T0 + 10 * MIN, uptime: () => 90 }), T0 + 10 * MIN - 90_000, 'the system cannot say: now minus the uptime');
  // A worker whose start cannot be read is no start; the walk goes on and then falls back.
  const unreadable = new Map([[10, { ppid: 9, comm: 'node', started_ms: T0 + MIN }], [9, { ppid: 2, comm: RUNNER_WORKER, started_ms: null }]]);
  assert.equal(jobStart({ pid: 10, lookup: pid => unreadable.get(pid) ?? null }), T0 + MIN);
  // A parent cycle never spins.
  const cycle = new Map([[10, { ppid: 11, comm: 'a', started_ms: T0 }], [11, { ppid: 10, comm: 'b', started_ms: T0 }]]);
  assert.equal(jobStart({ pid: 10, lookup: pid => cycle.get(pid) ?? null }), T0);
});

test('systemProcess reads Linux /proc and the Mac\'s ps without touching the host', () => {
  const stat = `4242 (Runner.Worker) S 777 4242 4242 0 -1 4194304 438 0 0 0 0 0 0 0 20 0 1 0 ${5000 * 100} 16072704 1673`;
  const reads = { '/proc/4242/stat': stat, '/proc/stat': 'cpu 1 2 3\nbtime 1795000000\nprocesses 5\n' };
  const readText = path => { if (path in reads) return reads[path]; throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); };
  assert.deepEqual(systemProcess(4242, { platform: 'linux', readText }), { ppid: 777, comm: 'Runner.Worker', started_ms: 1795005000_000 });
  assert.equal(systemProcess(1, { platform: 'linux', readText }), null, 'a process that is gone');
  // A comm with spaces and parentheses still parses (the last ')' ends it).
  const odd = { ...reads, '/proc/7/stat': stat.replace('4242 (Runner.Worker)', '7 (a (b) c)') };
  assert.equal(systemProcess(7, { platform: 'linux', readText: path => (path in odd ? odd[path] : readText(path)) }).comm, 'a (b) c');
  const ps = stdout => () => ({ status: 0, stdout });
  const mac = systemProcess(321, { platform: 'darwin', readText, ps: ps(' 123 Mon Nov 23 10:00:00 2026 /Users/x/actions-runner/bin/Runner.Worker\n') });
  assert.deepEqual(mac, { ppid: 123, comm: 'Runner.Worker', started_ms: T0 });
  assert.equal(systemProcess(321, { platform: 'darwin', readText, ps: () => ({ status: 1, stdout: '' }) }), null);
  assert.equal(systemProcess(321, { platform: 'darwin', readText, ps: ps('garbage') }), null);
});

// ---- the Queue: the deadline cuts the wait ----

function fixture(extra = {}) {
  const root = mkdtempSync(join(tmpdir(), 'hub-deadline-'));
  const env = { HUB_LOCK_DIR: join(root, 'locks'), HUB_EVENT_DIR: join(root, 'events'), GITHUB_REPOSITORY: 'delorenj/example', GITHUB_RUN_ID: '9', GITHUB_RUN_ATTEMPT: '1', GITHUB_JOB: 'plan', ...extra };
  return { root, env, logs: [], cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
const fakeTimers = () => ({ setInterval: () => ({ unref() {} }), clearInterval: () => {} });
const events = f => [...readEvents({ env: f.env })];
const holder = (f, at = T0) => acquireLease('adb', { holder: 'agent-a', why: 'device proof', forMs: 60 * 60_000, env: f.env, log: () => {}, id: 'held', now: () => at });
const tickets = f => readdirSync(join(f.root, 'locks/adb.queue')).filter(file => file.endsWith('.json')).map(file => JSON.parse(readFileSync(join(f.root, 'locks/adb.queue', file), 'utf8')));

test('a plan waiting behind a Lease gives up at its deadline, 13 minutes into a 20-minute job, and says why', async () => {
  const f = fixture({ HUB_JOB_TIMEOUT_MINUTES: '20' });
  try {
    await holder(f);
    let clock = T0;
    const seen = [];
    const sleep = async () => { seen.push(tickets(f)[0]?.deadline_at); clock += MIN; };
    await assert.rejects(
      withLock('adb', async () => { throw new Error('must not run'); }, { env: f.env, log: line => f.logs.push(line), now: () => clock, sleep, timeoutMs: 20 * MIN, timers: fakeTimers(), policy, deadlineSeams: { startedMs: T0 } }),
      error => error.code === 'HUB_LOCK_TIMEOUT'
        && /^host lock adb is held by lease held of agent-a \(device proof\) until .*; gave up after 13 min, ahead of this job's 20-minute timeout\. Another deploy is using the device; run again when it finishes\.$/.test(error.message));
    assert.equal(clock, T0 + 13 * MIN, 'it waited exactly to job_start + 20 - 2 - 5');
    assert.ok(clock < T0 + 20 * MIN - 2 * MIN, 'at least the margin before GitHub would kill the job');
    assert.equal(seen[0], new Date(T0 + 13 * MIN).toISOString(), 'the ticket carries deadline_at while it waits');
    assert.ok(f.logs.some(line => /^HUB_LOCK_DEADLINE adb wait ends 2026-11-23T10:13:00\.000Z \(job timeout 20 min, margin 2 min, later holds 5 min\)$/.test(line)));
    const mine = events(f).filter(event => event.hold_kind === 'job');
    assert.deepEqual(mine.map(event => [event.event, event.deadline_at, event.waited_ms]), [['request', new Date(T0 + 13 * MIN).toISOString(), null], ['timeout', new Date(T0 + 13 * MIN).toISOString(), 13 * MIN]]);
    assert.deepEqual(readdirSync(join(f.root, 'locks/adb.queue')), [], 'its ticket is gone');
  } finally { f.cleanup(); }
});

// Story 2.8 (AD-3, AD-5, FR-17): the Event Log of one timed-out wait on a pinned hub, whole: what the job asked, what ended it, who held
// the device and who stood ahead, and that its ticket is gone and the others kept their places.
test('a timed-out wait is request then timeout (deadline), HUB_LOCK_TIMEOUT, the holder and the waiters ahead named with their places, every event stamped with the hub version', async () => {
  const f = fixture({ HUB_JOB_TIMEOUT_MINUTES: '45', GITHUB_JOB: 'android', HUB_REF: 'v1.2.46' });
  try {
    await holder(f);
    const ahead = (name, body) => {
      mkdirSync(join(f.root, 'locks/adb.queue'), { recursive: true });
      writeFileSync(join(f.root, 'locks/adb.queue', name), JSON.stringify({ holder: 'agent-b', why: 'first in line', pid: process.pid, host: hostname(), enqueued_at: new Date(T0).toISOString(), ...body }));
    };
    ahead('000000000000001-000000-00000009.json', { lease_id: 'ahead-1' });
    ahead('000000000000002-000000-00000009.json', { lease_id: 'ahead-2', holder: 'agent-c', why: 'second in line' });
    let clock = T0;
    await assert.rejects(
      withLock('adb', async () => { throw new Error('must not run'); }, { env: f.env, log: line => f.logs.push(line), now: () => clock, sleep: async () => { clock += MIN; }, timeoutMs: 40 * MIN, timers: fakeTimers(), policy, deadlineSeams: { startedMs: T0 } }),
      error => {
        assert.equal(error.code, 'HUB_LOCK_TIMEOUT');
        assert.match(error.message, /^host lock adb is held by lease held of agent-a \(device proof\) until .*; 2 waiters ahead of job job:delorenj\/example#9\.1\/android \(1\. agent-b \(first in line\), 2\. agent-c \(second in line\)\); gave up after 28 min, ahead of this job's 45-minute timeout\. Another deploy is using the device; run again when it finishes\.$/);
        return true;
      });
    assert.equal(clock, T0 + 28 * MIN, 'it waited to job_start + 45 - 2 - 15');
    const mine = events(f).filter(event => event.hold_kind === 'job');
    assert.deepEqual(mine.map(event => event.event), ['request', 'timeout'], 'a wait that ran out never acquired and never released');
    const [request, timeout] = mine;
    assert.deepEqual(mine.map(event => event.hub_version), ['v1.2.46', 'v1.2.46']);
    assert.deepEqual(mine.map(event => [event.lock, event.claimant.kind, event.claimant.repo, event.claimant.run, event.claimant.attempt, event.claimant.job]), Array(2).fill(['adb', 'deploy', 'delorenj/example', '9', '1', 'android']));
    assert.deepEqual([request.waited_ms, request.reason, request.deadline_at], [null, null, new Date(T0 + 28 * MIN).toISOString()]);
    assert.deepEqual([timeout.waited_ms, timeout.reason, timeout.deadline_at], [28 * MIN, 'deadline', new Date(T0 + 28 * MIN).toISOString()]);
    assert.match(timeout.blocked_by, /^lease held of agent-a \(device proof\)/, 'the timeout names who held the device');
    assert.deepEqual(tickets(f).map(ticket => ticket.lease_id), ['ahead-1', 'ahead-2'], 'its ticket is gone; the waiters ahead kept their places');
  } finally { f.cleanup(); }
});

test('the deadline counts from job_start, not from when the tool asked: a job that spent 10 minutes before it waited has 3 left', async () => {
  const f = fixture({ HUB_JOB_TIMEOUT_MINUTES: '20' });
  try {
    await holder(f);
    let clock = T0 + 10 * MIN;
    await assert.rejects(
      withLock('adb', async () => {}, { env: f.env, log: () => {}, now: () => clock, sleep: async () => { clock += MIN; }, timeoutMs: 20 * MIN, timers: fakeTimers(), policy, deadlineSeams: { startedMs: T0 } }),
      /gave up after 3 min, ahead of this job's 20-minute timeout/);
    assert.equal(clock, T0 + 13 * MIN);
  } finally { f.cleanup(); }
});

test('a caller timeout that is already sooner than the deadline stays; a job past its deadline still takes a free lock at once', async () => {
  const f = fixture({ HUB_JOB_TIMEOUT_MINUTES: '120', GITHUB_JOB: 'ios' });
  try {
    await holder(f);
    let clock = T0;
    await assert.rejects(
      withLock('adb', async () => {}, { env: f.env, log: () => {}, now: () => clock, sleep: async () => { clock += MIN; }, timeoutMs: 5 * MIN, timers: fakeTimers(), policy, deadlineSeams: { startedMs: T0 } }),
      error => /gave up after 5 min\. Another deploy is using the device; run again when it finishes\.$/.test(error.message) && !/ahead of this job/.test(error.message));
    releaseLease('adb', 'held', { env: f.env });
    clock = T0 + 119 * MIN;
    const ran = [];
    await withLock('adb', async () => { ran.push('took it'); }, { env: f.env, log: () => {}, now: () => clock, sleep: async () => { clock += MIN; }, timeoutMs: 40 * MIN, timers: fakeTimers(), policy, deadlineSeams: { startedMs: T0 } });
    assert.deepEqual(ran, ['took it'], 'a free Resource with an empty Queue is taken at once, whatever the clock says');
    assert.equal(events(f).filter(event => event.event === 'acquire' && event.hold_kind === 'job').at(-1).waited_ms, 0);
  } finally { f.cleanup(); }
});

test('only a deploy job with an allowance is cut: no env, deliver-*, the catch-up and a try keep today\'s wait', async () => {
  const cases = [
    ['no HUB_JOB_TIMEOUT_MINUTES', {}, {}],
    ['a job the policy gives no allowance', { HUB_JOB_TIMEOUT_MINUTES: '45', GITHUB_JOB: 'deliver-android' }, {}],
    ['the catch-up (hub-job)', { HUB_JOB_TIMEOUT_MINUTES: '20' }, { kind: 'hub-job' }],
  ];
  for (const [name, extra, options] of cases) {
    const f = fixture(extra);
    try {
      await holder(f);
      let clock = T0;
      await assert.rejects(
        withLock('adb', async () => {}, { env: f.env, log: () => {}, now: () => clock, sleep: async () => { clock += MIN; }, timeoutMs: 20 * MIN, timers: fakeTimers(), policy, deadlineSeams: { startedMs: T0 }, ...options }),
        error => /gave up after 20 min\. Another deploy is using the device; run again when it finishes\.$/.test(error.message), name);
      assert.equal(clock, T0 + 20 * MIN, name);
    } finally { f.cleanup(); }
  }
  const f = fixture({ HUB_JOB_TIMEOUT_MINUTES: '20' });
  try {
    await holder(f);
    await assert.rejects(withLock('adb', async () => {}, { env: f.env, log: () => {}, now: () => T0, timeoutMs: 0, timers: fakeTimers(), policy }), error => error.code === 'HUB_LOCK_TIMEOUT');
    assert.equal(events(f).filter(event => event.hold_kind === 'job').length, 0, 'a try writes nothing');
  } finally { f.cleanup(); }
});

test('with no policy and no start injected, a job reads the repo policy and the process tree\'s own job start (AD-11, AD-12)', async () => {
  const f = fixture({ HUB_JOB_TIMEOUT_MINUTES: '45', GITHUB_JOB: 'android' });
  try {
    const began = Date.now();
    await holder(f, began);
    let clock = began;
    // job_start is whatever the default lookup finds for this test process: its nearest Runner.Worker ancestor when CI runs the
    // suite inside a job (the hosted check), else its own start. The test asks the same helper rather than assuming which, so it
    // holds on a laptop and in CI alike; the repo's own allowance and margin (45 - 2 - 15 = 28 min) are what it pins.
    const start = jobStart();
    await assert.rejects(
      withLock('adb', async () => {}, { env: f.env, log: () => {}, now: () => clock, sleep: async () => { clock += MIN; }, timeoutMs: 45 * MIN, timers: fakeTimers() }),
      error => error.code === 'HUB_LOCK_TIMEOUT' && /ahead of this job's 45-minute timeout/.test(error.message));
    const expected = start + 28 * MIN;
    assert.ok(clock >= expected && clock < expected + MIN, `waited to ${new Date(clock).toISOString()}, the deadline is ${new Date(expected).toISOString()}`);
    assert.ok(clock < began + 28 * MIN + MIN, 'never later than 28 minutes from now (the job cannot have started after it asked)');
  } finally { f.cleanup(); }
});

test('a job that arrives after its deadline and finds the device held gives up at once, naming the holder, and leaves no ticket', async () => {
  const f = fixture({ HUB_JOB_TIMEOUT_MINUTES: '20' });
  try {
    await holder(f);
    let clock = T0 + 16 * MIN;
    let slept = 0;
    await assert.rejects(
      withLock('adb', async () => { throw new Error('must not run'); }, { env: f.env, log: () => {}, now: () => clock, sleep: async () => { slept += 1; clock += MIN; }, timeoutMs: 20 * MIN, timers: fakeTimers(), policy, deadlineSeams: { startedMs: T0 } }),
      error => error.code === 'HUB_LOCK_TIMEOUT' && /held by lease held of agent-a .*; gave up after 0 min, ahead of this job's 20-minute timeout\./.test(error.message));
    assert.equal(slept, 0, 'it never slept: the deadline had passed');
    assert.deepEqual(readdirSync(join(f.root, 'locks/adb.queue')), []);
    const mine = events(f).filter(event => event.hold_kind === 'job');
    assert.deepEqual(mine.map(event => event.event), ['request', 'timeout'], 'each event exactly once');
  } finally { f.cleanup(); }
});

// ---- the workflow ----

const workflow = readFileSync(join(repoRoot, '.github/workflows/mobile-deploy.yml'), 'utf8');
const jobBlocks = () => {
  const jobs = workflow.slice(workflow.indexOf('\njobs:\n') + 7);
  const parts = jobs.split(/^ {2}([\w-]+):\n/m);
  const blocks = new Map();
  for (let i = 1; i < parts.length; i += 2) blocks.set(parts[i], parts[i + 1]);
  return blocks;
};

test('mobile-deploy.yml: each job that waits for a device sets HUB_JOB_TIMEOUT_MINUTES equal to its timeout-minutes, and only those', () => {
  const blocks = jobBlocks();
  assert.deepEqual([...blocks.keys()].slice(-9), ['gate', 'preflight-ios', 'plan', 'android', 'ios-export', 'ios', 'deliver-android', 'deliver-ios', 'announce']);
  const waiting = Object.keys(policy.queue.hold_allowance_min);
  assert.deepEqual(waiting, ['plan', 'android', 'ios']);
  for (const [name, block] of blocks) {
    const timeout = /^ {4}timeout-minutes: (\d+)$/m.exec(block)?.[1];
    const env = /^ {4}env:\n((?: {6}.+\n)+)/m.exec(block)?.[1] ?? '';
    const set = /^ {6}HUB_JOB_TIMEOUT_MINUTES: '?(\d+)'?$/m.exec(env)?.[1];
    if (waiting.includes(name)) {
      assert.ok(timeout, `${name} has timeout-minutes`);
      assert.equal(set, timeout, `${name}: HUB_JOB_TIMEOUT_MINUTES must equal timeout-minutes (${timeout})`);
    } else {
      assert.equal(set, undefined, `${name} never waits for a device lock here, so it sets no job timeout`);
    }
    assert.ok(!/^ {6}HUB_[A-Z_]*(?<!MINUTES): /m.test(env), `${name}: the job env carries no other HUB_ value (policy is never an env)`);
  }
});

test('mobile-deploy.yml: the margin and each allowance leave every waiting job a positive wait inside its own timeout-minutes', () => {
  const blocks = jobBlocks();
  for (const [job, allowance] of Object.entries(policy.queue.hold_allowance_min)) {
    const timeout = Number(/^ {4}timeout-minutes: (\d+)$/m.exec(blocks.get(job))?.[1]);
    assert.ok(timeout - policy.queue.wait_margin_min - allowance > 0, `${job}: ${timeout} - margin ${policy.queue.wait_margin_min} - allowance ${allowance} leaves no time to wait`);
  }
});

test('mobile-deploy.yml: android and ios have no concurrency group (AD-21); plan, ios-export and deliver-* keep theirs', () => {
  const blocks = jobBlocks();
  for (const name of ['android', 'ios']) assert.doesNotMatch(blocks.get(name), /^ {4}concurrency:|cancel-in-progress/m, `${name}: the device Queue orders it`);
  for (const name of ['plan', 'ios-export', 'deliver-android', 'deliver-ios']) {
    assert.match(blocks.get(name), new RegExp(`^ {4}concurrency:\\n {6}group: mobile-deploy-${name}-\\$\\{\\{ github\\.repository \\}\\}\\n {6}cancel-in-progress: false$`, 'm'), name);
  }
});
