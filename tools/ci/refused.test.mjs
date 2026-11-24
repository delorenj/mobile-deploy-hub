// Who held a lock, and the `refused` event (Story 3.4, AD-9, AD-15, FR-30): leaseHoldersSince reads Lease holds from the Event Log,
// deliveryPendingEvent finds a deploy's delivery-pending timeout, noteRefused appends the refusal. Temp HUB_LOCK_DIR/HUB_EVENT_DIR
// and an injected clock; nothing touches the host.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REFUSED_NAMES_MAX, acquireLease, deliveryPendingEvent, extendLease, leaseHoldersSince, noteRefused, releaseLease, withLock } from './lib/lock.mjs';
import { eventDir, readEvents } from './lib/events.mjs';
import { hermetic } from './test-fixtures.mjs';

hermetic();

const T0 = Date.parse('2026-11-24T10:00:00.000Z');
const MIN = 60_000;
const HOUR = 60 * MIN;
const policy = { queue: { wait_margin_min: 2, hold_allowance_min: { plan: 5, android: 15, ios: 60 }, grace_min: 10, reservation_ceiling_min: 180, deploy_target_lease_max_min: 60 } };
const at = ms => new Date(ms).toISOString();

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'hub-refused-'));
  const env = { HUB_LOCK_DIR: join(root, 'locks'), HUB_EVENT_DIR: join(root, 'events') };
  const clock = { at: T0 };
  return { root, env, clock, now: () => clock.at, events: () => [...readEvents({ env })], cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
const take = (f, id, { holder = 'agent-a', forMs = 20 * MIN, name = 'adb' } = {}) => acquireLease(name, { holder, why: 'device proof', forMs, id, env: f.env, log: () => {}, now: f.now, policy });
const give = (f, id, name = 'adb') => releaseLease(name, id, { env: f.env, now: f.now });
const holders = (f, since, name = 'adb') => leaseHoldersSince(name, since, { env: f.env, log: () => {} });

test('leaseHoldersSince: a Lease that ended before since is out; one held across since and one acquired after are in, in log order', async () => {
  const f = fixture();
  try {
    await take(f, 'early', { holder: 'agent-a' });
    f.clock.at = T0 + 5 * MIN;
    give(f, 'early');
    f.clock.at = T0 + 10 * MIN;
    await take(f, 'across', { holder: 'agent-b' });
    f.clock.at = T0 + 40 * MIN;
    give(f, 'across');
    await take(f, 'after', { holder: 'agent-c' });
    assert.deepEqual(holders(f, T0 + 30 * MIN).map(hold => [hold.holder, hold.lease_id]), [['agent-b', 'across'], ['agent-c', 'after']]);
    assert.deepEqual(holders(f, at(T0 + 30 * MIN))[0], { holder: 'agent-b', lease_id: 'across', acquired_at: at(T0 + 10 * MIN) });
    assert.deepEqual(holders(f, T0 + 6 * MIN).map(hold => hold.lease_id), ['across', 'after']);
    assert.deepEqual(holders(f, T0 - HOUR).map(hold => hold.lease_id), ['early', 'across', 'after']);
  } finally { f.cleanup(); }
});

test('leaseHoldersSince: an expired Lease nobody reclaimed is out past its expiry; an extension moves it later', async () => {
  const f = fixture();
  try {
    await take(f, 'lapsed', { forMs: 10 * MIN });
    await take(f, 'longer', { holder: 'agent-b', forMs: 10 * MIN, name: 's24' });
    assert.deepEqual(holders(f, T0 + 20 * MIN).map(hold => hold.lease_id), [], 'ran out at +10 min, never released');
    assert.deepEqual(holders(f, T0 + 9 * MIN).map(hold => hold.lease_id), ['lapsed']);
    f.clock.at = T0 + 5 * MIN;
    extendLease('adb', 'lapsed', { forMs: 30 * MIN, env: f.env, now: f.now, policy });
    assert.deepEqual(holders(f, T0 + 20 * MIN).map(hold => hold.lease_id), ['lapsed'], 'the extension ran it to +40 min');
    assert.deepEqual(holders(f, T0 + 20 * MIN, 's24').map(hold => hold.lease_id), [], 'another lock is its own history');
  } finally { f.cleanup(); }
});

test('leaseHoldersSince: a Lease reclaimed before its expiry (its holder process died) ends at the reclaim', async () => {
  const f = fixture();
  try {
    const dead = spawnSync(process.execPath, ['-e', '']).pid;
    await acquireLease('adb', { holder: 'agent-a', why: 'device proof', forMs: 40 * MIN, id: 'dead', holderPid: dead, env: f.env, log: () => {}, now: f.now, policy });
    f.clock.at = T0 + 10 * MIN;
    await withLock('adb', async () => {}, { env: f.env, log: () => {}, now: f.now, timeoutMs: 1000 });
    const reclaim = f.events().find(event => event.event === 'reclaim');
    assert.equal(reclaim?.lease_id, 'dead');
    assert.equal(reclaim.reason, 'holder-gone');
    assert.deepEqual(holders(f, T0 + 5 * MIN).map(hold => hold.lease_id), ['dead'], 'held when since fell before the reclaim');
    assert.deepEqual(holders(f, T0 + 20 * MIN).map(hold => hold.lease_id), [], 'reclaimed at +10 min, well before its +40 min expiry');
  } finally { f.cleanup(); }
});

test('leaseHoldersSince: other locks, job holds and waiters are ignored; a bad since throws', async () => {
  const f = fixture();
  try {
    await take(f, 'other', { name: 's24' });
    await withLock('adb', async () => {}, { env: f.env, log: () => {}, now: f.now, kind: 'job' });
    await take(f, 'mine');
    assert.deepEqual(holders(f, T0 - HOUR).map(hold => hold.lease_id), ['mine']);
    assert.throws(() => holders(f, 'not a date'), /since must be a date/);
  } finally { f.cleanup(); }
});

test('deliveryPendingEvent: matches by repo and run, returns the last, null when none', async () => {
  const f = fixture();
  try {
    await take(f, 'blocker', { forMs: 50 * MIN });
    const timeout = async (repo, run, reason = 'delivery-pending') => {
      f.clock.at += MIN;
      const start = f.clock.at;
      const clock = { at: start };
      // The wait runs on its own clock, one second per poll, and the timeout lands at start + 5 s.
      await assert.rejects(withLock('adb', async () => {}, { env: { ...f.env, GITHUB_REPOSITORY: repo, GITHUB_RUN_ID: run, GITHUB_JOB: 'android' }, log: () => {}, timeoutMs: 5000, timeoutReason: reason, pollMs: 1000, sleep: async ms => { clock.at += ms; }, now: () => clock.at }), { code: 'HUB_LOCK_TIMEOUT' });
    };
    await timeout('o/one', '11');
    await timeout('o/two', '22');
    await timeout('o/one', '11');
    await timeout('o/one', '33', 'deadline');
    const found = deliveryPendingEvent('adb', { repo: 'o/one', run: '11' }, { env: f.env, log: () => {} });
    assert.equal(found.event, 'timeout');
    assert.equal(found.ts, at(T0 + 3 * MIN + 5000), 'the last of the two');
    assert.equal(deliveryPendingEvent('adb', { repo: 'o/one', run: '22' }, { env: f.env, log: () => {} }), null);
    assert.equal(deliveryPendingEvent('adb', { repo: 'o/one', run: '33' }, { env: f.env, log: () => {} }), null, 'another reason');
    assert.equal(deliveryPendingEvent('s24', { repo: 'o/one', run: '11' }, { env: f.env, log: () => {} }), null);
    assert.equal(deliveryPendingEvent('adb', { repo: 'o/one', run: '11' }, { env: f.env, since: T0 + 10 * MIN, log: () => {} }), null, 'before since');
  } finally { f.cleanup(); }
});

test('noteRefused: the AD-9 body, unknown when nobody held it, the cut at ten, nothing for a name that is not Queued, bad delivery throws', () => {
  const f = fixture();
  try {
    const delivery = { repo: 'o/app', run: '9', version: '0.2.2' };
    const who = [{ holder: 'agent-a', lease_id: 'mine', acquired_at: at(T0) }];
    assert.equal(noteRefused('adb', { delivery, installed: '0.2.9 (9)', installedBy: who, since: T0 + MIN, from: 'pending-event' }, { env: f.env, now: () => T0 + 2 * MIN }), true);
    const [event] = f.events();
    assert.deepEqual([event.event, event.lock, event.hold_kind, event.claimant.kind, event.lease_id, event.reason], ['refused', 'adb', 'job', 'hub-job', null, 'newer-installed']);
    assert.deepEqual(event.delivery, delivery);
    assert.deepEqual([event.installed, event.pending_since, event.pending_from, event.ts], ['0.2.9 (9)', at(T0 + MIN), 'pending-event', at(T0 + 2 * MIN)]);
    assert.deepEqual(event.installed_by, who);
    assert.equal('installed_by_more' in event, false);

    noteRefused('adb', { installed: '0.3.0 (1)', installedBy: [], since: at(T0), from: 'latest.json' }, { env: f.env });
    const unknown = f.events()[1];
    assert.equal(unknown.installed_by, 'unknown');
    assert.equal('delivery' in unknown, false, 'only when given');
    assert.equal(unknown.pending_from, 'latest.json');

    const twelve = Array.from({ length: 12 }, (_, index) => ({ holder: `agent-${index}`, lease_id: `l-${index}`, acquired_at: at(T0 + index * MIN) }));
    noteRefused('mac-ios', { delivery, installed: '0.3.0 (1)', installedBy: twelve, since: T0, from: 'latest.json' }, { env: f.env });
    const cut = f.events()[2];
    assert.equal(REFUSED_NAMES_MAX, 10);
    assert.deepEqual(cut.installed_by.map(hold => hold.holder), twelve.slice(0, 10).map(hold => hold.holder));
    assert.equal(cut.installed_by_more, 2);
    assert.ok(readFileSync(join(eventDir(f.env), '2026-11.jsonl'), 'utf8').split('\n').filter(Boolean).every(line => Buffer.byteLength(line) < 4096));

    assert.equal(noteRefused('s3-tower', { installed: 'x', since: T0, from: 'latest.json' }, { env: f.env }), false);
    assert.equal(f.events().length, 3, 'a name that is not Queued writes nothing');
    assert.throws(() => noteRefused('adb', { delivery: { repo: 'nope' }, installed: 'x', since: T0, from: 'latest.json' }, { env: f.env }), /bad delivery/);
    assert.equal(f.events().length, 3);
  } finally { f.cleanup(); }
});
