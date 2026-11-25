// The one ETA (AD-18, Story 4.1): a table of fixture histories for the pure eta(), and the enqueue integration (a waiting
// Lease and a waiting Queued withLock record the same ETA in their ticket and their `request` event).
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { earliest, eta, etaMoved, formatEta, percentile } from './lib/eta.mjs';
import { acquireLease, releaseLease, reserve, waiterEtas, withLock } from './lib/lock.mjs';
import { appendEvent, readEvents } from './lib/events.mjs';
import { loadPolicy } from './lib/policy.mjs';
import { hermetic } from './test-fixtures.mjs';

hermetic(); // offline, outside any workflow job, scratch HUB_EVENT_DIR and HUB_LOCK_DIR (test-fixtures.mjs)

const NOW = Date.parse('2026-11-24T12:00:00Z');
const MIN = 60_000;
const DAY = 86_400_000;
const iso = ms => new Date(ms).toISOString();
const policy = { queue: { eta_window_days: 30, eta_low_data_min_holds: 20, hold_allowance_min: { plan: 5, android: 15, ios: 60 } } };
const withMin = n => ({ queue: { ...policy.queue, eta_low_data_min_holds: n } });

const jobHold = (held, { repo = 'o/a', job = 'android', ago = DAY, event = 'release', ...more } = {}) => ({
  ts: iso(NOW - ago), event, hold_kind: 'job', held_ms: held, for_ms: null, last_alive_at: null,
  claimant: { kind: 'deploy', holder: null, repo, run: '1', attempt: '1', job }, ...more,
});
const leaseHold = (held, forMs, { ago = DAY, event = 'release', kind = 'agent', ...more } = {}) => ({
  ts: iso(NOW - ago), event, hold_kind: 'lease', held_ms: held, for_ms: forMs, last_alive_at: null,
  claimant: { kind, holder: 'a', repo: null, run: null, attempt: null, job: null }, ...more,
});
const many = (n, make) => Array.from({ length: n }, (_, i) => make(i + 1));
const jobOwner = (elapsed, extra = {}) => ({ pid: 1, host: 'h', repo: 'o/a', run: '1', job: 'android', kind: 'job', started_at: iso(NOW - elapsed), ...extra });
const leaseOwner = (elapsed, forMs, extra = {}) => ({ kind: 'lease', lease_id: 'held', holder: 'a', started_at: iso(NOW - elapsed), expires_at: iso(NOW - elapsed + forMs), ...extra });
const job = (file, extra = {}) => ({ file, kind: 'job', blocking: true, repo: 'o/a', job: 'android', deadline_at: null, ...extra });
const lease = (file, id, extra = {}) => ({ file, kind: 'lease', blocking: true, lease_id: id, ...extra });
const run = (queue, events = [], pol = policy) => eta({ view: [], ...queue }, events, pol, NOW);

test('percentile interpolates linearly', () => {
  assert.equal(percentile([1, 2, 3, 4, 5], 0.25), 2);
  assert.equal(percentile([1, 2, 3, 4, 5], 0.75), 4);
  assert.equal(percentile([10, 20], 0.5), 15);
  assert.equal(percentile([7], 0.25), 7);
  assert.equal(percentile([], 0.25), null);
});

test('empty history: a free lock is 0-0 and honest; a job holder widens to its allowance', () => {
  assert.deepEqual(run({ owner: null }), { lo_ms: 0, hi_ms: 0, low_data: false });
  assert.deepEqual(run({ owner: jobOwner(3000), deadline_at: iso(NOW + 60_000) }), { lo_ms: 0, hi_ms: 15 * MIN - 3000, low_data: true });
});

test('rich history: the holder and a waiting job are the p25-p75 of their matching holds', () => {
  const held = many(20, i => jobHold(i * MIN));
  assert.deepEqual(run({ owner: jobOwner(0) }, held), { lo_ms: Math.round(percentile(many(20, i => i * MIN), 0.25)), hi_ms: Math.round(percentile(many(20, i => i * MIN), 0.75)), low_data: false });
  const ahead = run({ owner: null, view: [job('a')], file: null }, held);
  assert.equal(ahead.low_data, false);
  assert.equal(ahead.lo_ms, Math.round(percentile(many(20, i => i * MIN), 0.25)));
  // Both add along the Queue.
  const both = run({ owner: jobOwner(0), view: [job('a')] }, held);
  assert.equal(both.lo_ms, 2 * ahead.lo_ms);
  assert.equal(both.hi_ms, 2 * ahead.hi_ms);
});

test('a holder past its median is conditioned on how long it has held, and falls back to low data when too few survive', () => {
  const held = many(20, i => jobHold(i * MIN));
  const past = run({ owner: jobOwner(10 * MIN + 30_000) }, held, withMin(10));
  const rest = many(10, i => (10 + i) * MIN).map(x => x - (10 * MIN + 30_000));
  assert.deepEqual(past, { lo_ms: Math.round(percentile(rest, 0.25)), hi_ms: Math.round(percentile(rest, 0.75)), low_data: false });
  assert.equal(run({ owner: jobOwner(10 * MIN + 30_000) }, held).low_data, true, 'only 10 hold past 10.5 min, below the threshold of 20');
  // Past every sample and past its whole 15 min allowance: its stated remaining time is unknown (never 0-0 while it still
  // holds), so the total hi is the asker's deadline, or null without one.
  assert.deepEqual(run({ owner: jobOwner(25 * MIN) }, held), { lo_ms: 0, hi_ms: null, low_data: true });
  assert.deepEqual(run({ owner: jobOwner(25 * MIN), deadline_at: iso(NOW + 7 * MIN) }, held), { lo_ms: 0, hi_ms: 7 * MIN, low_data: true });
  // Only a few survive (and the allowance is spent): low data, lo from the survivors, hi unknown.
  const sparse = run({ owner: jobOwner(19 * MIN) }, held);
  assert.deepEqual(sparse, { lo_ms: MIN, hi_ms: null, low_data: true });
  // Inside its allowance a sparse holder widens to the stated remaining time.
  assert.deepEqual(run({ owner: jobOwner(3 * MIN) }, [jobHold(2 * MIN)]), { lo_ms: 0, hi_ms: 12 * MIN, low_data: true });
});

test('window: holds older than the window and holds from the future are ignored', () => {
  const inside = many(20, i => jobHold(i * MIN, { ago: 29 * DAY }));
  assert.equal(run({ owner: jobOwner(0) }, inside).low_data, false);
  const outside = many(20, i => jobHold(i * MIN, { ago: 31 * DAY }));
  assert.equal(run({ owner: jobOwner(0) }, outside).low_data, true);
  const future = many(20, i => jobHold(i * MIN, { ago: -DAY }));
  assert.equal(run({ owner: jobOwner(0) }, future).low_data, true);
  assert.equal(run({ owner: jobOwner(0) }, inside, { queue: { ...policy.queue, eta_window_days: 7 } }).low_data, true, 'the window is the policy\'s');
});

test('job matching is by repo and job, null-safe, and only finite holds of a job or a lease end count', () => {
  const held = many(20, i => jobHold(i * MIN));
  assert.equal(run({ owner: jobOwner(0, { repo: 'o/other' }) }, held).low_data, true);
  assert.equal(run({ owner: jobOwner(0, { job: 'ios' }) }, held).low_data, true);
  const nulls = many(20, i => jobHold(i * MIN, { repo: null, job: null }));
  assert.equal(run({ owner: jobOwner(0, { repo: undefined, job: undefined }) }, nulls).low_data, false, 'a missing value equals null');
  const junk = [...held.slice(0, 19), jobHold(null), { ...jobHold(5 * MIN), event: 'acquire' }, { ...jobHold(5 * MIN), hold_kind: 'reservation' }, { ...jobHold(5 * MIN), ts: 'x' }];
  assert.equal(run({ owner: jobOwner(0) }, junk).low_data, true, 'only 19 are real holds');
  assert.equal(run({ owner: jobOwner(0) }, [...junk, jobHold(5 * MIN, { event: 'force-release' })]).low_data, false);
});

test('a reclaim with last_alive_at counts to the last sign of life, floored at 0', () => {
  const reclaims = many(20, () => jobHold(60 * MIN, { event: 'reclaim', ts: iso(NOW - DAY), last_alive_at: iso(NOW - DAY - 10 * MIN) }));
  // The hold was recorded 60 min but the job was last seen 10 min before the reclaim: it counts 50 min.
  assert.deepEqual(run({ owner: jobOwner(0) }, reclaims), { lo_ms: 50 * MIN, hi_ms: 50 * MIN, low_data: false });
  const dead = many(20, () => jobHold(5 * MIN, { event: 'reclaim', last_alive_at: iso(NOW - DAY - 10 * MIN) }));
  assert.deepEqual(run({ owner: jobOwner(0) }, dead), { lo_ms: 0, hi_ms: 0, low_data: false }, 'floored at 0, and 0 is not conditioned away at elapsed 0');
});

test('a Lease holder ends at start + the share of for_ms past agent Leases used, never past expiry', () => {
  const forMs = 60 * MIN;
  const shares = many(20, i => leaseHold((i / 20) * forMs * 1, forMs)); // shares 0.05 .. 1
  const holder = leaseOwner(0, forMs);
  const got = run({ owner: holder }, shares);
  const sorted = many(20, i => i / 20);
  assert.deepEqual(got, { lo_ms: Math.round(percentile(sorted, 0.25) * forMs), hi_ms: Math.round(percentile(sorted, 0.75) * forMs), low_data: false });
  // Holds longer than their stated time (a clamp) share at most 1; other kinds and a for_ms of 0 are not matches.
  const over = many(20, () => leaseHold(5 * forMs, forMs));
  assert.deepEqual(run({ owner: holder }, over), { lo_ms: forMs, hi_ms: forMs, low_data: false });
  const wrongKind = many(20, () => leaseHold(forMs, forMs, { kind: 'deploy' }));
  assert.equal(run({ owner: holder }, wrongKind).low_data, true);
  const noFor = many(20, () => leaseHold(forMs, 0));
  assert.equal(run({ owner: holder }, noFor).low_data, true);
  // Sparse: widened to the Lease's own expiry.
  assert.deepEqual(run({ owner: holder }, []), { lo_ms: 0, hi_ms: forMs, low_data: true });
  // Conditioned: 30 min in, only the shares that run past 30 min remain.
  const later = run({ owner: leaseOwner(30 * MIN, forMs) }, shares);
  assert.equal(later.low_data, true, 'only 10 survive, below the threshold of 20');
  assert.equal(run({ owner: leaseOwner(30 * MIN, forMs) }, shares, withMin(5)).low_data, false);
});

test('a waiting Lease takes its for_ms from its own request event; without one it is low data and unknown', () => {
  const forMs = 30 * MIN;
  const shares = many(20, () => leaseHold(forMs / 2, 60 * MIN));
  const request = { event: 'request', ts: iso(NOW - MIN), lease_id: 'w1', for_ms: forMs };
  const got = run({ owner: null, view: [lease('a', 'w1')] }, [...shares, request]);
  assert.deepEqual(got, { lo_ms: forMs / 4, hi_ms: forMs / 4, low_data: false });
  assert.deepEqual(run({ owner: null, view: [lease('a', 'w1')] }, [request]), { lo_ms: 0, hi_ms: forMs, low_data: true }, 'sparse: widens to for_ms');
  const unknown = run({ owner: null, view: [lease('a', 'w1')], deadline_at: iso(NOW + 5 * MIN) }, shares);
  assert.deepEqual(unknown, { lo_ms: 0, hi_ms: 5 * MIN, low_data: true });
  assert.deepEqual(run({ owner: null, view: [lease('a', 'w1')] }, shares), { lo_ms: 0, hi_ms: null, low_data: true }, 'no deadline: null');
  assert.deepEqual(run({ owner: null, view: [lease('a', 'w1')], deadline_at: NOW - MIN }, []), { lo_ms: 0, hi_ms: 0, low_data: true }, 'a past deadline floors at 0');
  // The asker's deadline defaults to its own view entry's.
  const own = run({ owner: null, view: [lease('a', 'w1'), job('b', { deadline_at: iso(NOW + 2 * MIN) })], file: 'b' }, []);
  assert.deepEqual(own, { lo_ms: 0, hi_ms: 2 * MIN, low_data: true });
});

test('a blocking Reservation adds 0 to its grace left and is never low data; non-blocking entries and entries behind the asker add nothing', () => {
  const res = (state, extra = {}) => ({ file: 'a-reservation-k', kind: 'reservation', blocking: true, grace_ms: 10 * MIN, grace: { state, started_at: null, ends_at: null }, ...extra });
  assert.deepEqual(run({ owner: null, view: [res('pending')] }), { lo_ms: 0, hi_ms: 10 * MIN, low_data: false });
  assert.deepEqual(run({ owner: null, view: [res('running', { grace: { state: 'running', started_at: iso(NOW - 4 * MIN), ends_at: iso(NOW + 6 * MIN) } })] }), { lo_ms: 0, hi_ms: 6 * MIN, low_data: false });
  assert.deepEqual(run({ owner: null, view: [res('pending', { blocking: false }), job('b', { blocking: false })] }), { lo_ms: 0, hi_ms: 0, low_data: false });
  assert.deepEqual(run({ owner: null, view: [job('b')], file: 'a' }), { lo_ms: 0, hi_ms: 0, low_data: false }, 'behind the asker');
  assert.deepEqual(run({ owner: null, view: [job('a'), job('b')], file: 'b' }), { lo_ms: 0, hi_ms: 15 * MIN, low_data: true }, 'only the one before the asker');
});

test('unknown stated duration: the total hi is the asker\'s deadline, or null without one', () => {
  const view = [job('a', { job: 'deliver-android' })];
  assert.deepEqual(run({ owner: null, view, deadline_at: iso(NOW + 9 * MIN) }), { lo_ms: 0, hi_ms: 9 * MIN, low_data: true });
  assert.deepEqual(run({ owner: null, view }), { lo_ms: 0, hi_ms: null, low_data: true });
  // lo never passes hi: sparse samples above the deadline keep hi >= lo.
  const some = [jobHold(40 * MIN, { job: 'deliver-android' })];
  assert.deepEqual(run({ owner: null, view, deadline_at: iso(NOW + MIN) }, some), { lo_ms: 40 * MIN, hi_ms: 40 * MIN, low_data: true });
});

test('a blocking entry of an unknown kind (remote) is low data with an unknown duration: the asker\'s deadline, or null', () => {
  const view = [{ file: 'a', kind: 'remote', blocking: true }];
  assert.deepEqual(run({ owner: null, view, deadline_at: iso(NOW + 4 * MIN) }), { lo_ms: 0, hi_ms: 4 * MIN, low_data: true });
  assert.deepEqual(run({ owner: null, view }), { lo_ms: 0, hi_ms: null, low_data: true });
});

test('a waiting catch-up (hub-job) matches its repo and job like a Job Hold, never the unknown branch', () => {
  const view = [job('a', { kind: 'hub-job' })];
  assert.deepEqual(run({ owner: null, view, deadline_at: iso(NOW + 2 * MIN) }), { lo_ms: 0, hi_ms: 15 * MIN, low_data: true }, 'sparse: its job\'s allowance, not the deadline');
  const held = many(20, i => jobHold(i * MIN));
  const rich = run({ owner: null, view }, held);
  assert.deepEqual(rich, { lo_ms: Math.round(percentile(many(20, i => i * MIN), 0.25)), hi_ms: Math.round(percentile(many(20, i => i * MIN), 0.75)), low_data: false });
});

test('a reused lease id takes its latest request for_ms', () => {
  const old = { event: 'request', ts: iso(NOW - 2 * DAY), lease_id: 'w1', for_ms: 5 * MIN };
  const latest = { event: 'request', ts: iso(NOW - MIN), lease_id: 'w1', for_ms: 40 * MIN };
  assert.deepEqual(run({ owner: null, view: [lease('a', 'w1')] }, [old, latest]), { lo_ms: 0, hi_ms: 40 * MIN, low_data: true });
  assert.deepEqual(run({ owner: null, view: [lease('a', 'w1')] }, [old]), { lo_ms: 0, hi_ms: 5 * MIN, low_data: true });
});

test('sparse history lowers lo to the sparse p25 and raises hi to the sparse p75 when it is larger than the stated duration', () => {
  const some = [jobHold(30 * MIN), jobHold(40 * MIN)];
  const got = run({ owner: null, view: [job('a')] }, some);
  assert.deepEqual(got, { lo_ms: Math.round(percentile([30 * MIN, 40 * MIN], 0.25)), hi_ms: Math.round(percentile([30 * MIN, 40 * MIN], 0.75)), low_data: true });
});

test('eta is pure: the same inputs give the same output and nothing is mutated', () => {
  const queue = { owner: jobOwner(MIN), view: [job('a'), lease('b', 'w1')], file: 'c', deadline_at: iso(NOW + 5 * MIN) };
  const events = [...many(25, i => jobHold(i * MIN)), { event: 'request', ts: iso(NOW), lease_id: 'w1', for_ms: 10 * MIN }];
  const before = JSON.stringify([queue, events, policy]);
  const first = eta(queue, events, policy, NOW);
  assert.deepEqual(eta(queue, events, policy, NOW), first);
  assert.equal(JSON.stringify([queue, events, policy]), before);
  assert.ok(Number.isInteger(first.lo_ms) && Number.isInteger(first.hi_ms) && first.lo_ms <= first.hi_ms);
  assert.throws(() => eta(queue, events, { queue: { ...policy.queue, eta_window_days: 0 } }, NOW), /eta_window_days/);
  assert.throws(() => eta(queue, events, { queue: {} }, NOW), /eta_window_days/);
});

// ---- the enqueue records the ETA (SM-4) ----

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'hub-eta-'));
  const env = { HUB_LOCK_DIR: join(root, 'locks'), HUB_EVENT_DIR: join(root, 'events'), GITHUB_REPOSITORY: 'delorenj/example', GITHUB_RUN_ID: '9', GITHUB_RUN_ATTEMPT: '1', GITHUB_JOB: 'android' };
  return { root, env, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
const tickets = f => readdirSync(join(f.root, 'locks/adb.queue')).filter(name => name.endsWith('.json')).map(name => JSON.parse(readFileSync(join(f.root, 'locks/adb.queue', name), 'utf8')));
const requests = f => [...readEvents({ env: f.env })].filter(event => event.event === 'request');
const settle = ms => new Promise(done => setTimeout(done, ms));
// Polls a condition on real timers for up to 10 s, so a loaded machine never turns a fixed pause into a flake.
const until = async (check, what) => {
  for (let tries = 0; tries < 1000; tries += 1) { if (check()) return; await settle(10); }
  assert.fail(`never happened: ${what}`);
};
const HOST_ID = 'eta-machine';

test('the shipped policy carries the two ETA keys', () => {
  const { queue } = loadPolicy().policy;
  assert.deepEqual([queue.eta_window_days, queue.eta_low_data_min_holds], [30, 20]);
});

test('a waiting Lease writes the same ETA into its ticket and its request event', async () => {
  const f = fixture();
  try {
    await acquireLease('adb', { holder: 'first', why: 'holds', forMs: 600_000, env: f.env, log: () => {}, hostId: HOST_ID });
    const waiting = acquireLease('adb', { holder: 'second', why: 'waits', forMs: 600_000, waitMs: 30_000, id: 'w-lease', env: f.env, log: () => {}, pollMs: 5, hostId: HOST_ID });
    await settle(60);
    const [ticket] = tickets(f);
    assert.equal(ticket.lease_id, 'w-lease');
    assert.deepEqual(Object.keys(ticket.eta), ['lo_ms', 'hi_ms', 'low_data']);
    assert.equal(ticket.eta.low_data, true);
    assert.ok(ticket.eta.hi_ms > 590_000 && ticket.eta.hi_ms <= 600_000, 'the holder\'s stated 10 min, less what it has held');
    const sent = requests(f).find(event => event.lease_id === 'w-lease');
    assert.deepEqual(sent.eta, ticket.eta);
    assert.equal(requests(f).length, 1, 'a try writes no request');
    releaseLease('adb', 'w-lease', { env: f.env });
    await assert.rejects(waiting, error => error.code === 'HUB_LEASE_CANCELLED');
  } finally { f.cleanup(); }
});

test('a waiting Queued withLock writes the same ETA into its ticket and its request event', async () => {
  const f = fixture();
  try {
    await acquireLease('adb', { holder: 'first', why: 'holds', forMs: 600_000, id: 'first', env: f.env, log: () => {}, hostId: HOST_ID });
    const waiting = withLock('adb', async () => {}, { env: f.env, log: () => {}, timeoutMs: 30_000, pollMs: 5, hostId: HOST_ID, timers: { setInterval: () => ({ unref() {} }), clearInterval() {} } });
    await settle(60);
    const [ticket] = tickets(f);
    assert.equal(ticket.kind, 'job');
    assert.deepEqual(Object.keys(ticket.eta), ['lo_ms', 'hi_ms', 'low_data']);
    const sent = requests(f).find(event => event.hold_kind === 'job');
    assert.deepEqual(sent.eta, ticket.eta);
    releaseLease('adb', 'first', { env: f.env });
    await waiting;
  } finally { f.cleanup(); }
});

test('an ETA that cannot be computed never stops an enqueue: the ticket and the request record eta null', async () => {
  const f = fixture();
  try {
    const logged = [];
    const broken = { queue: { deploy_target_lease_max_min: 60, eta_window_days: 0 } };
    await acquireLease('adb', { holder: 'first', why: 'holds', forMs: 600_000, env: f.env, log: () => {}, hostId: HOST_ID, policy: broken });
    const waiting = acquireLease('adb', { holder: 'second', why: 'waits', forMs: 600_000, waitMs: 30_000, id: 'w-broken', env: f.env, log: line => logged.push(line), pollMs: 5, hostId: HOST_ID, policy: broken });
    await settle(60);
    assert.equal(tickets(f)[0].eta, null);
    assert.equal(requests(f).find(event => event.lease_id === 'w-broken').eta, null);
    assert.deepEqual(logged.filter(line => line.startsWith('HUB_ETA_FAILED')), ['HUB_ETA_FAILED adb eta: queue.eta_window_days must be a positive whole number'], 'one line, naming the lock and the reason');
    releaseLease('adb', 'w-broken', { env: f.env });
    await assert.rejects(waiting, error => error.code === 'HUB_LEASE_CANCELLED');
  } finally { f.cleanup(); }
});

const keepHolding = f => withLock('adb', () => new Promise(done => { f.done = done; }), { env: f.env, log: () => {}, hostId: HOST_ID, timers: { setInterval: () => ({ unref() {} }), clearInterval() {} } });

test('the enqueue reads real history once: in-window holds set the range and older ones do not count', async () => {
  const f = fixture();
  try {
    const at = Date.now();
    const seed = (held, ago) => appendEvent({ event: 'release', lock: 'adb', hold_kind: 'job', claimant: { kind: 'deploy', holder: null, repo: 'delorenj/example', run: '1', attempt: '1', job: 'android' }, held_ms: held, for_ms: null, last_alive_at: null }, { env: f.env, now: () => at - ago, hostId: HOST_ID, log: () => {} });
    for (let i = 1; i <= 20; i += 1) assert.ok(seed(i * MIN, DAY));
    for (let i = 0; i < 6; i += 1) assert.ok(seed(300 * MIN, 31 * DAY), 'outside the 30-day window');
    const holder = keepHolding(f);
    await settle(30);
    const waiting = acquireLease('adb', { holder: 'second', why: 'waits', forMs: 600_000, waitMs: 30_000, id: 'w-real', env: f.env, log: () => {}, pollMs: 5, hostId: HOST_ID });
    await settle(60);
    const [ticket] = tickets(f);
    const sent = requests(f).find(event => event.lease_id === 'w-real');
    assert.deepEqual(sent.eta, ticket.eta);
    assert.equal(ticket.eta.low_data, false);
    // p25 and p75 of 1..20 min (5.75 and 15.25 min) less the few ms the holder has held; the 300 min holds did not count.
    assert.ok(ticket.eta.lo_ms <= 5.75 * MIN && ticket.eta.lo_ms > 5.75 * MIN - 5000, String(ticket.eta.lo_ms));
    assert.ok(ticket.eta.hi_ms <= 15.25 * MIN && ticket.eta.hi_ms > 15.25 * MIN - 5000, String(ticket.eta.hi_ms));
    releaseLease('adb', 'w-real', { env: f.env });
    await assert.rejects(waiting, error => error.code === 'HUB_LEASE_CANCELLED');
    f.done();
    await holder;
  } finally { f.cleanup(); }
});

test('the asker\'s place counts end to end: a later waiter includes the one ahead of it, and the earlier one never includes the later', async () => {
  const f = fixture();
  try {
    await acquireLease('adb', { holder: 'first', why: 'holds', forMs: 600_000, id: 'first', env: f.env, log: () => {}, hostId: HOST_ID });
    const b = acquireLease('adb', { holder: 'b', why: 'waits', forMs: 600_000, waitMs: 30_000, id: 'b', env: f.env, log: () => {}, pollMs: 5, hostId: HOST_ID });
    await settle(60);
    const c = acquireLease('adb', { holder: 'c', why: 'waits', forMs: 300_000, waitMs: 30_000, id: 'c', env: f.env, log: () => {}, pollMs: 5, hostId: HOST_ID });
    await settle(60);
    const byId = Object.fromEntries(tickets(f).map(ticket => [ticket.lease_id, ticket]));
    const asked = Object.fromEntries(requests(f).map(event => [event.lease_id, event]));
    assert.deepEqual(byId.b.eta, asked.b.eta);
    assert.deepEqual(byId.c.eta, asked.c.eta);
    const forB = asked.b.for_ms;
    assert.equal(forB, 600_000, 'B\'s contribution is its own request event\'s for_ms');
    // B is behind the holder only (about 10 min); C adds B's whole 10 min on top, and C's own time never enters B's range.
    assert.ok(byId.b.eta.hi_ms <= 600_000 && byId.b.eta.hi_ms > 595_000, String(byId.b.eta.hi_ms));
    const added = byId.c.eta.hi_ms - byId.b.eta.hi_ms;
    assert.ok(added > forB - 5000 && added <= forB, String(added));
    // Both rejections are awaited together, so neither is unhandled while the other settles.
    const cancelled = Promise.all([c, b].map(waiter => assert.rejects(waiter, error => error.code === 'HUB_LEASE_CANCELLED')));
    releaseLease('adb', 'c', { env: f.env });
    releaseLease('adb', 'b', { env: f.env });
    await cancelled;
  } finally { f.cleanup(); }
});

test('a Queued withLock behind a holder with no stated duration records hi_ms as the time to its own deadline', async () => {
  const f = fixture();
  try {
    const holder = withLock('adb', () => new Promise(done => { f.done = done; }), { env: { ...f.env, GITHUB_JOB: 'deliver', GITHUB_RUN_ID: '8' }, log: () => {}, hostId: HOST_ID, timers: { setInterval: () => ({ unref() {} }), clearInterval() {} } });
    await until(() => typeof f.done === 'function', 'the holder holds');
    const waiting = withLock('adb', async () => {}, { env: f.env, log: () => {}, timeoutMs: 30_000, pollMs: 5, hostId: HOST_ID, timers: { setInterval: () => ({ unref() {} }), clearInterval() {} } });
    await until(() => existsSync(join(f.root, 'locks/adb.queue')) && tickets(f).length === 1, 'the waiter\'s ticket');
    const [ticket] = tickets(f);
    assert.equal(ticket.kind, 'job');
    assert.deepEqual(ticket.eta, { lo_ms: 0, hi_ms: 30_000, low_data: true }, 'the holder\'s job has no allowance, so hi is the waiter\'s own deadline');
    assert.deepEqual(requests(f).find(event => event.hold_kind === 'job' && event.claimant.run === '9').eta, ticket.eta);
    f.done();
    await holder;
    await waiting;
  } finally { f.cleanup(); }
});

test('a run that holds a Reservation is told the wait from its Reservation\'s place: its own grace never counts, and a later waiter counts it', async () => {
  const f = fixture();
  const reservationPolicy = { queue: { wait_margin_min: 2, hold_allowance_min: { plan: 5, android: 15, ios: 60 }, grace_min: 10, reservation_ceiling_min: 180 } };
  try {
    await acquireLease('adb', { holder: 'first', why: 'holds', forMs: 600_000, id: 'first', env: f.env, log: () => {}, hostId: HOST_ID });
    assert.equal(reserve('adb', { env: f.env, now: () => Date.now() - MIN, policy: reservationPolicy, log: () => {}, hostId: HOST_ID }).status, 'claimed');
    const served = withLock('adb', async () => {}, { env: f.env, log: () => {}, timeoutMs: 30_000, pollMs: 5, hostId: HOST_ID, timers: { setInterval: () => ({ unref() {} }), clearInterval() {} } });
    await settle(60);
    const [ticket] = tickets(f);
    assert.equal(ticket.reservation, 'delorenj--example--9');
    assert.deepEqual(requests(f).find(event => event.hold_kind === 'job').eta, ticket.eta);
    // Only the holder's stated 10 min is ahead; its own pending Reservation (10 min of grace) would double it.
    assert.equal(ticket.eta.low_data, true);
    assert.ok(ticket.eta.hi_ms <= 600_000 && ticket.eta.hi_ms > 595_000, String(ticket.eta.hi_ms));
    const later = acquireLease('adb', { holder: 'c', why: 'waits', forMs: 300_000, waitMs: 30_000, id: 'c', env: { HUB_LOCK_DIR: f.env.HUB_LOCK_DIR, HUB_EVENT_DIR: f.env.HUB_EVENT_DIR }, log: () => {}, pollMs: 5, hostId: HOST_ID });
    await settle(60);
    const c = tickets(f).find(entry => entry.lease_id === 'c');
    // C is behind the holder (about 10 min) and the run's android job (its 15 min allowance, no history).
    assert.ok(c.eta.hi_ms <= 25 * MIN && c.eta.hi_ms > 25 * MIN - 5000, String(c.eta.hi_ms));
    releaseLease('adb', 'c', { env: f.env });
    await assert.rejects(later, error => error.code === 'HUB_LEASE_CANCELLED');
    releaseLease('adb', 'first', { env: f.env });
    await served;
  } finally { f.cleanup(); }
});

test('formatEta prints each bound as s, m or h:mm and flags low data', () => {
  const text = (lo_ms, hi_ms, low_data = false) => formatEta({ lo_ms, hi_ms, low_data });
  assert.equal(text(0, 900_000, true), '0s-15m low-data');
  assert.equal(text(125_000, 4_500_000), '2m-1h15m');
  assert.equal(text(0, 0), '0s-0s');
  assert.equal(text(1_499, 59_499), '1s-59s', 'under a minute: whole seconds');
  assert.equal(text(59_500, 60_000), '1m-1m', '59.5 s rounds to the minute');
  assert.equal(text(0, 59 * MIN), '0s-59m');
  assert.equal(text(0, 59 * MIN + 29_000), '0s-59m');
  assert.equal(text(0, 59 * MIN + 31_000), '0s-1h00m', 'rounds up into the hour');
  assert.equal(text(0, 60 * MIN), '0s-1h00m');
  assert.equal(text(0, 61 * MIN + 29_000), '0s-1h01m');
  assert.equal(text(0, 25 * 60 * MIN + 5 * MIN), '0s-25h05m');
  assert.equal(text(MIN, null), '1m-?', 'an unknown upper bound is ?');
  assert.equal(text(MIN, null, true), '1m-? low-data');
  assert.equal(formatEta(null), '?', 'no ETA at all');
  assert.equal(formatEta(undefined), '?');
});

test('etaMoved: more than a minute on either bound, or a null changing sides', () => {
  const a = { lo_ms: 0, hi_ms: 10 * MIN, low_data: true };
  assert.equal(etaMoved(a, { ...a }), false);
  assert.equal(etaMoved(a, { ...a, hi_ms: 10 * MIN - 60_000 }), false, 'exactly 60 s is not moved');
  assert.equal(etaMoved(a, { ...a, hi_ms: 10 * MIN - 60_001 }), true);
  assert.equal(etaMoved(a, { ...a, hi_ms: 10 * MIN + 60_001 }), true);
  assert.equal(etaMoved(a, { ...a, lo_ms: 60_000 }), false);
  assert.equal(etaMoved(a, { ...a, lo_ms: 60_001 }), true);
  assert.equal(etaMoved(a, { ...a, low_data: false }), false, 'the flag alone does not print');
  assert.equal(etaMoved(a, { ...a, hi_ms: null }), true, 'hi turned unknown');
  assert.equal(etaMoved({ ...a, hi_ms: null }, a), true, 'hi turned known');
  assert.equal(etaMoved({ ...a, hi_ms: null }, { ...a, hi_ms: null }), false);
  assert.equal(etaMoved(a, null), true);
  assert.equal(etaMoved(null, a), true);
  assert.equal(etaMoved(null, null), false);
});

test('waiterEtas: stale tickets and Reservations get no ETA, each live ticket is asked at its own place and deadline, a throwing policy is null', () => {
  const held = many(20, i => jobHold(i * MIN));
  const view = [
    job('001-a', { deadline_at: null }),
    job('002-stale', { stale: true, blocking: false }),
    { file: '003-reservation', kind: 'reservation', blocking: true, stale: false, grace: { state: 'pending' }, grace_ms: 10 * MIN },
    job('004-b', { deadline_at: iso(NOW + 5 * MIN) }),
    lease('005-c', 'later', { deadline_at: null }),
  ];
  const owner = jobOwner(0);
  const etas = waiterEtas({ owner, view, events: held, policy, now: NOW });
  assert.deepEqual([...etas.keys()], ['001-a', '004-b', '005-c'], 'no entry for the stale ticket or the Reservation');
  for (const [file, deadline] of [['001-a', null], ['004-b', iso(NOW + 5 * MIN)], ['005-c', null]]) {
    const live = view.filter(entry => !entry.stale);
    assert.deepEqual(etas.get(file), eta({ owner, view: live, file, deadline_at: deadline }, held, policy, NOW), `${file} is eta() at its own place`);
  }
  assert.ok(etas.get('004-b').lo_ms > etas.get('001-a').lo_ms, 'a later waiter counts the ones ahead of it');
  const broken = waiterEtas({ owner, view, events: held, policy: { queue: {} }, now: NOW });
  assert.deepEqual([...broken.entries()], [['001-a', null], ['004-b', null], ['005-c', null]]);
  assert.equal(waiterEtas({ policy, now: NOW }).size, 0);
});

// Story 5.8 (AD-33): a Pool request's ETA is the earliest member's range.
test('earliest(): least lo, least known hi, low_data if any, nulls ignored, null when nothing is an ETA', () => {
  const a = { lo_ms: 5 * MIN, hi_ms: 20 * MIN, low_data: false };
  const b = { lo_ms: 2 * MIN, hi_ms: 30 * MIN, low_data: true };
  assert.deepEqual(earliest([a, b]), { lo_ms: 2 * MIN, hi_ms: 20 * MIN, low_data: true });
  assert.deepEqual(earliest([a]), a, 'one member is its own range');
  // a member whose upper bound is unknown bounds nothing: the known one decides, and the unknown alone stays unknown
  assert.deepEqual(earliest([{ lo_ms: 0, hi_ms: null, low_data: true }, a]), { lo_ms: 0, hi_ms: 20 * MIN, low_data: true });
  assert.deepEqual(earliest([{ lo_ms: 3 * MIN, hi_ms: null, low_data: false }, { lo_ms: 1 * MIN, hi_ms: null, low_data: false }]), { lo_ms: MIN, hi_ms: null, low_data: false });
  // a member whose computation failed (null) is ignored
  assert.deepEqual(earliest([null, b]), b);
  assert.equal(earliest([null, null]), null);
  assert.equal(earliest([]), null);
  assert.equal(earliest(undefined), null);
  const input = [a, b];
  earliest(input);
  assert.deepEqual(input, [a, b], 'pure: nothing is mutated');
  assert.equal(formatEta(earliest([a, b])), '2m-20m low-data');
});
