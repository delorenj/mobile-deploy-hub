// Story 3.5 (AD-22): an `ios` wait for `mac-ios` that runs out is a red job that names who held the Mac. The first take (the
// device build) is a real ios() run; the second (the store IPA) is the same storeTake() the lane runs, under guarded(). Temp
// lock and event dirs throughout: nothing here reaches a device, the bucket or host state.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { parseConfig } from './lib/config.mjs';
import { ios, macLane, storeRecord, storeTake } from './commands/ios.mjs';
import { guarded } from './commands/common.mjs';
import { deviceOf, publicReceipts } from './commands/deliver.mjs';
import { deliveriesFrom, deploymentEvent } from './lib/announce.mjs';
import { testflightDelivery, testflightOf } from './lib/completion.mjs';
import { loadDevices } from './lib/devices.mjs';
import { readEvents } from './lib/events.mjs';
import { acquireLease, listReservations, reserve } from './lib/lock.mjs';
import { loadPolicy } from './lib/policy.mjs';
import { publicReason, summaryMarkdown } from './lib/receipt.mjs';
import { hermetic } from './test-fixtures.mjs';

hermetic();
const root = fileURLToPath(new URL('../..', import.meta.url));
const waited = { timeoutMs: 150, pollMs: 20 };
const { policy } = loadPolicy();

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'hub-ios-contention-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const env = { GITHUB_REPOSITORY: 'owner/app', GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '1', GITHUB_JOB: 'ios', HOME: dir, HUB_LOCK_DIR: join(dir, 'locks'), HUB_EVENT_DIR: join(dir, 'events') };
  const devices = JSON.parse(readFileSync(join(root, 'tools/ci/devices.json')));
  devices.mac.min_free_gib = 0.000001;
  writeFileSync(join(dir, 'devices.json'), JSON.stringify(devices));
  env.HUB_DEVICES = join(dir, 'devices.json');
  const manifest = { schema: 2, project: { slug: 'fixture', name: 'Contention Fixture' }, version: { read: 'exit 91', bump: 'exit 92' }, ios: { bundle: 'fixture.app', device: 'exit 94', device_artifact: 'app.xcarchive', store: { build: 'exit 97', artifact: 'store.ipa', upload: 'exit 95', assign: 'exit 96' } } };
  // What ios() reads: an app with a Linux export half (the lane takes the Mac before it looks at anything else).
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ ...manifest, ios: { bundle: 'fixture.app', export: 'exit 93', archive: 'private.tgz', receipt: 'private.json', device: 'exit 94', device_artifact: 'app.xcarchive', store: { archive: 'store.tgz', receipt: 'store.json', upload: 'exit 95', assign: 'exit 96' } } }));
  const out = join(dir, 'out');
  const config = { ...parseConfig(['ios', '--manifest', 'manifest.json', '--out', out, '--version', '9.9.9', '--testflight', 'true'], env), cwd: dir };
  const logs = [];
  const events = () => [...readEvents({ env })];
  const receipt = () => JSON.parse(readFileSync(join(out, 'ios/hub-receipt-ios.json'), 'utf8'));
  return { dir, env, config, out, logs, log: line => logs.push(line), events, receipt, spec: manifest.ios };
}

// The Mac held by a Lease `agent-a`, one Claimant waiting ahead (a ticket as a hub would have written it), and this run's Reservation.
async function busyMac(f) {
  await acquireLease('mac-ios', { holder: 'agent-a', why: 'device proof', forMs: 30 * 60_000, id: 'held', env: f.env, log: () => {} });
  const queue = join(f.env.HUB_LOCK_DIR, 'mac-ios.queue');
  mkdirSync(queue, { recursive: true });
  const ms = Date.now() - 5000;
  writeFileSync(join(queue, `${String(ms).padStart(15, '0')}-000001-00000009.json`), JSON.stringify({ format: 1, kind: 'lease', lease_id: 'ahead-1', holder: 'agent-b', why: 'waiting', pid: process.pid, host: hostname(), enqueued_at: new Date(ms).toISOString() }));
  reserve('mac-ios', { env: f.env, log: () => {} });
}

const timeouts = f => f.events().filter(event => event.event === 'timeout' && event.lock === 'mac-ios');
const holders = receipt => receipt.contention.blocked_by.map(hold => [hold.role, hold.holder]);

test('the first take: a mac-ios wait that runs out fails the job with HUB_LOCK_TIMEOUT, names the holder and the waiter ahead, and keeps the Reservation', async t => {
  const f = fixture(t);
  await busyMac(f);
  await assert.rejects(ios({ ...f.config, dryRun: true, testflight: false }, { env: f.env, home: f.dir, log: f.log, lockOptions: waited }), error => error.code === 'HUB_LOCK_TIMEOUT' && /^host lock mac-ios is held by lease held of agent-a .*; 1 waiter ahead/.test(error.message));
  const receipt = f.receipt();
  assert.deepEqual([receipt.outcome, receipt.stage], ['failure', 'preflight']);
  assert.deepEqual([receipt.contention.lock, receipt.contention.reason], ['mac-ios', 'ios-lane-contention']);
  assert.deepEqual(holders(receipt), [['holder', 'agent-a'], ['ahead', 'agent-b']]);
  assert.match(receipt.reason, /agent-a/);
  assert.match(receipt.reason, /agent-b/);
  assert.match(summaryMarkdown(receipt), /- contention on mac-ios \(ios-lane-contention\): holder lease agent-a [^;]*; ahead lease agent-b/);
  const [timeout, ...more] = timeouts(f);
  assert.deepEqual(more, [], 'the lock wrote the one timeout event; the lane wrote none');
  assert.equal(timeout.reason, 'ios-lane-contention');
  assert.match(timeout.blocked_by, /agent-a/);
  assert.ok(f.logs.some(line => /^HUB_IOS_LANE_BUSY device code=HUB_LOCK_TIMEOUT/.test(line)), f.logs.join('\n'));
  assert.equal(listReservations('mac-ios', { env: f.env }).length, 1, 'a failed lane keeps the run\'s Reservation');
  // The public copies say only which lock was busy.
  assert.equal(publicReason(receipt), 'mac-ios busy: the wait for it ran out (HUB_LOCK_TIMEOUT); the run summary names who held it');
  const shown = publicReceipts({ ios: receipt }).ios;
  assert.equal('contention' in shown, false);
  assert.match(shown.reason, /^mac-ios busy: /);
  assert.doesNotMatch(JSON.stringify(shown), /agent-a|agent-b/);
  const devices = loadDevices(f.env);
  const state = deviceOf(devices.ios, receipt, { stamp: '2026-11-24T10:00:00Z' });
  assert.deepEqual([state.status, state.reason], ['failed', publicReason(receipt)]);
  const needs = { gate: { result: 'success' }, plan: { result: 'success' }, ios: { result: 'failure' } };
  const { deliveries, failure } = deliveriesFrom({ declared: { android: false, ios: true }, devices, needs, receipts: { ios: receipt }, version: '9.9.9' });
  assert.deepEqual([failure.job, failure.stage, failure.reason], ['ios', 'preflight', publicReason(receipt)]);
  assert.deepEqual(deliveries.map(item => [item.platform, item.status]), [['ios', 'failed']]);
  const tf = testflightOf({ testflight: true, iosLane: 'run', needs: { ios: { result: 'failure' } }, receipts: { ios: receipt }, dryRun: false });
  assert.equal(tf.status, 'failed');
  assert.match(tf.reason, /mac-ios busy/);
  assert.doesNotMatch(JSON.stringify([tf, testflightDelivery(tf, { version: '9.9.9', build: null })]), /agent-a|agent-b/);
});

test('the store take: a wait that runs out after the iPad install fails only the store step, at stage deliver, and the iPad stays installed', async t => {
  const f = fixture(t);
  await busyMac(f);
  const built = [];
  const devices = loadDevices(f.env);
  const lane = guarded('ios', join(f.out, 'ios'), f.config, f.env, async track => {
    track.receipt = { version: '9.9.9', delivery: { platform: 'ios', target: devices.ios.model, device: devices.ios.name, version: '9.9.9', build: '77', sha256: 'a'.repeat(64), verified: true, status: 'installed', reason: null } };
    track.stage = 'build';
    await storeTake({ track, spec: f.spec, config: f.config, policy, out: join(f.out, 'ios'), team: 'TEAM', hooks: {}, env: f.env, runner: null, log: f.log, lockOptions: waited, build: async () => { built.push('ran'); return {}; } });
  });
  await assert.rejects(lane, error => error.code === 'HUB_LOCK_TIMEOUT');
  assert.deepEqual(built, [], 'the store build never ran');
  const receipt = f.receipt();
  assert.deepEqual([receipt.outcome, receipt.stage], ['failure', 'deliver']);
  assert.equal(receipt.store.status, 'failed');
  assert.equal(receipt.store.reason, "mac-ios busy: the App Store IPA was not built; the iPad's delivery stands");
  assert.deepEqual(receipt.store.groups, ['Owner Testing']);
  assert.deepEqual([receipt.contention.lock, receipt.contention.reason], ['mac-ios', 'ios-lane-contention']);
  assert.deepEqual(holders(receipt), [['holder', 'agent-a'], ['ahead', 'agent-b']]);
  const stored = timeouts(f);
  assert.equal(stored.length, 1);
  assert.equal(stored[0].reason, 'ios-lane-contention');
  assert.ok(f.logs.some(line => /^HUB_IOS_LANE_BUSY store code=HUB_LOCK_TIMEOUT/.test(line)), f.logs.join('\n'));
  assert.equal(listReservations('mac-ios', { env: f.env }).length, 1, 'the Reservation is kept');
  // The iPad's own delivery stands: deviceOf and announce read stage deliver as a publishing step.
  const state = deviceOf(devices.ios, receipt, { stamp: '2026-11-24T10:00:00Z' });
  assert.deepEqual([state.status, state.reason], ['installed', null]);
  const shown = publicReceipts({ ios: receipt }).ios;
  assert.equal('contention' in shown, false);
  assert.match(shown.reason, /^mac-ios busy: /);
  assert.doesNotMatch(JSON.stringify(shown), /agent-a|agent-b/);
  const needs = { gate: { result: 'success' }, plan: { result: 'success' }, ios: { result: 'failure' } };
  const { deliveries, failure } = deliveriesFrom({ declared: { android: false, ios: true }, devices, needs, receipts: { ios: receipt }, version: '9.9.9' });
  assert.deepEqual(deliveries.map(item => [item.platform, item.status]), [['ios', 'installed']]);
  assert.deepEqual([failure.job, failure.stage, failure.reason], ['ios', 'deliver', publicReason(receipt)]);
  const event = deploymentEvent({ project: { slug: 'fixture', name: 'Contention Fixture' }, declared: { android: false, ios: true }, devices, needs, receipts: { ios: receipt }, version: '9.9.9', commit: 'b'.repeat(40), env: f.env });
  assert.equal(event.type, 'bloodbank.project.deployment.failed');
  assert.doesNotMatch(JSON.stringify(event), /agent-a|agent-b/);
  assert.match(JSON.stringify(event.data.reason), /mac-ios busy/);
});

test('an error raised inside a hold is not contention, and a lane that recorded contention but failed for another reason keeps its reason', async t => {
  const f = fixture(t);
  const track = { stage: 'build', receipt: {} };
  await assert.rejects(macLane(async () => { throw new Error('the build hook failed'); }, { track, what: 'device', env: f.env, log: f.log, lockOptions: waited }), /the build hook failed/);
  assert.equal(track.receipt.contention, undefined);
  assert.equal(timeouts(f).length, 0);
  const failed = guarded('ios', join(f.out, 'ios'), f.config, f.env, track2 => storeTake({ track: track2, spec: f.spec, config: f.config, policy, out: f.out, team: 'TEAM', hooks: {}, env: f.env, log: f.log, lockOptions: waited, build: async () => { throw new Error('ios.store.build failed'); } }));
  await assert.rejects(failed, /ios.store.build failed/);
  const receipt = f.receipt();
  assert.deepEqual([receipt.stage, receipt.reason, 'contention' in receipt, 'store' in receipt], ['preflight', 'ios.store.build failed', false, false]);
  const other = { lane: 'ios', reason: 'readback: the iPad reports no app', contention: { lock: 'mac-ios', reason: 'ios-lane-contention', blocked_by: [] } };
  assert.equal(publicReason(other), 'readback: the iPad reports no app');
  assert.equal(publicReason({ lane: 'android', reason: 'x' }), 'x');
  assert.equal(publicReason(undefined), undefined);
});

test('storeRecord keeps the receipt shape of the TestFlight record', () => {
  const record = storeRecord({ config: { version: '1.2.3', iosVersion: '1.2.0', iosBuild: '9' }, env: {}, policy, storeIpa: { build: '12' } });
  assert.deepEqual(record, { status: 'checked', version: '1.2.0', build: '12', groups: ['Owner Testing'], uploaded: null, state: null, review: null, reason: null });
  assert.equal(storeRecord({ config: { version: '1.2.3' }, env: {}, policy }).build, null);
});
