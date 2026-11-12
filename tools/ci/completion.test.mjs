// The completion verdict (hub v1.3, TOWE-76): lib/completion.mjs on fixtures rebuilt from Tower's real runs (the deploy
// map in tower-of-lost-things/artifacts/deploy-ship), and the announce job that writes it as completion-out and carries
// TestFlight as a delivery. Nothing here deploys: receipts, latest.json and bb-emit are fakes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { completionOf, testflightDelivery, testflightOf } from './lib/completion.mjs';
import { deploymentEvent } from './lib/announce.mjs';
import { loadDevices } from './lib/devices.mjs';
import { parseConfig } from './lib/config.mjs';
import { loadPolicy } from './lib/policy.mjs';
import { announce } from './commands/announce.mjs';
import { device, sampleLatest } from './test-fixtures.mjs';

const { policy: releasedPolicy } = loadPolicy();
// Exercise the deferred contract explicitly; the released policy intentionally has no completion block.
const policy = { ...releasedPolicy, completion: { required: { devices: 'lanes', testflight: 'store' }, lane_unavailable: 'refuse', reruns: 1 } };
const repo = 'delorenj/tower-of-lost-things';
const slug = 'tower-of-lost-things';
const devices = loadDevices({});

// A delivery as deliveriesFrom gives it (the S26 or the iPad).
const lane = (platform, status, { version, build, reason = null } = {}) => ({
  platform, target: platform === 'android' ? 'SM-S948U' : 'iPad14,5', device: platform === 'android' ? 'S26' : 'iPad', version, build: String(build), sha256: null, verified: status === 'installed', status, ...(reason ? { reason } : {}),
});

// latest.json after deliver: both blocks naming (version, code/build) with the given device states.
function latestFor(version, code, { android = 'pending', ios = 'pending', androidVersion = version, iosVersion = version, iosBuild = code } = {}) {
  const doc = sampleLatest({ version });
  doc.android = { ...doc.android, version: androidVersion, code, device: device('S26', 'SM-S948U', android) };
  doc.ios = { ...doc.ios, version: iosVersion, build: String(iosBuild), device: device('iPad', 'iPad14,5', ios) };
  return doc;
}

const judge = facts => completionOf({ policy, repo, slug, store: true, run: { id: facts.runId ?? '1', attempt: 1, url: `https://github.com/${repo}/actions/runs/${facts.runId ?? '1'}` }, ...facts });

// ---------------------------------------------------------------------------------------------------- the real runs

test('0.3.14 (40764238070): the Mac offline, iPad skipped, no TestFlight is INCOMPLETE, and owes both by command', () => {
  const c = judge({
    runId: '40764238070', version: '0.3.14', androidCode: '19', iosBuild: '19', bumped: true, iosLane: 'skip-offline', catchup: { android: 'live', ios: 'unknown' },
    deliveries: [lane('android', 'pending', { version: '0.3.14', build: 19, reason: "not on big-chungus's adb" }), lane('ios', 'skipped', { version: '0.3.14', build: 19, reason: 'the Mac was offline, so the iPad build was not made' })],
    testflight: null, latest: latestFor('0.3.14', 19, { iosVersion: '0.3.13', iosBuild: 18, ios: 'installed' }),
  });
  assert.equal(c.verdict, 'INCOMPLETE');
  assert.deepEqual(c.targets.map(t => [t.target, t.status, t.durable]), [['S26', 'pending', true], ['iPad', 'skipped', false], ['TestFlight', 'missing', false]]);
  assert.deepEqual(c.owed.map(o => [o.target, o.command]), [['iPad', 'mise run ship'], ['TestFlight', 'mise run ship']]);
  assert.match(c.summary, /^tower-of-lost-things 0\.3\.14 \(19\): S26 pending \(durable\), iPad skipped, TestFlight missing; owed iPad: mise run ship; TestFlight: mise run ship$/);
});

test('0.3.14 under the v1.3 gate: the refusal is RED and blocked, nothing spent, and owes a ship once the Mac is back', () => {
  const reason = 'HUB_GATE_REFUSED lane_unavailable: the Mac is offline (tailscale says carries-macbook-air is offline), so the iPad and TestFlight would not be delivered; bring the Mac back, or narrow with --platform android (the completion verdict is then INCOMPLETE). Nothing was spent (policy completion.lane_unavailable: refuse)'.slice(0, 300);
  const failure = { job: 'gate', stage: 'preflight', reason };
  const c = judge({ version: '0.3.13', androidCode: '18', bumped: false, iosLane: 'skip-offline', failure, deliveries: [lane('android', 'failed', { version: '0.3.13', build: 18, reason }), lane('ios', 'failed', { version: '0.3.13', build: 18, reason })] });
  assert.deepEqual([c.verdict, c.blocked, c.bumped], ['RED', true, false]);
  assert.ok(c.owed.every(item => item.command === 'mise run ship'), JSON.stringify(c.owed));
});

for (const [version, code, run] of [['0.3.15', 20, '40860503693'], ['0.3.16', 21, '40929439965'], ['0.3.17', 22, '40958553917'], ['0.3.18', 23, '40975302765']]) {
  test(`${version} (${run}): green, S26 installed, iPad durably pending, no TestFlight is INCOMPLETE once TestFlight is required`, () => {
    const facts = {
      runId: run, version, androidCode: String(code), iosBuild: String(code), bumped: true, catchup: { android: 'live', ios: 'live' },
      deliveries: [lane('android', 'installed', { version, build: code }), lane('ios', 'pending', { version, build: code, reason: 'asleep or away' })],
      latest: latestFor(version, code, { android: 'installed' }),
    };
    const c = judge({ ...facts, testflight: null });
    assert.equal(c.verdict, 'INCOMPLETE');
    assert.deepEqual(c.targets.map(t => [t.target, t.status, t.durable]), [['S26', 'installed', true], ['iPad', 'pending', true], ['TestFlight', 'missing', false]]);
    assert.deepEqual(c.owed, [{ target: 'TestFlight', status: 'missing', why: c.targets[2].why, command: 'mise run ship' }]);
    // The same run with TestFlight uploaded and assigned is COMPLETE: a durably pending iPad is not owed.
    const shipped = judge({ ...facts, testflight: { status: 'assigned', reason: 'uploaded and assigned to Owner Testing' } });
    assert.equal(shipped.verdict, 'COMPLETE');
    assert.deepEqual(shipped.owed, []);
    // Under the old policy shape (no store app), the device lanes alone make it COMPLETE.
    assert.equal(completionOf({ ...facts, policy, repo, slug, store: false, run: { id: run } }).verdict, 'COMPLETE');
  });
}

test('0.3.19 (41445863722): red after the bump with the TestFlight upload failed is RED and owes the rerun', () => {
  const receipts = { ios: { lane: 'ios', outcome: 'failure', stage: 'deliver', reason: 'hook ios.store.upload failed (exit 1)', delivery: { platform: 'ios', status: 'pending', build: '24' } } };
  const tf = testflightOf({ testflight: true, iosLane: 'run', needs: { ios: { result: 'failure' } }, receipts, dryRun: false });
  assert.deepEqual(tf, { status: 'failed', reason: 'hook ios.store.upload failed (exit 1)' });
  const c = judge({
    runId: '41445863722', version: '0.3.19', androidCode: '24', iosBuild: '24', bumped: true, catchup: { android: 'live', ios: 'live' },
    failure: { job: 'ios', stage: 'deliver', reason: 'hook ios.store.upload failed (exit 1)' },
    deliveries: [lane('android', 'pending', { version: '0.3.19', build: 24 }), lane('ios', 'pending', { version: '0.3.19', build: 24, reason: 'asleep or away' })],
    testflight: tf, latest: latestFor('0.3.19', 24), commit: '3832680b'.padEnd(40, '0'),
  });
  assert.deepEqual([c.verdict, c.bumped, c.blocked], ['RED', true, false]);
  assert.deepEqual(c.targets.map(t => [t.target, t.status, t.durable]), [['S26', 'pending', true], ['iPad', 'pending', true], ['TestFlight', 'failed', false]]);
  assert.deepEqual(c.owed.map(o => o.command), ['gh run rerun 41445863722 --repo delorenj/tower-of-lost-things --failed']);
  assert.equal(c.failure.reason, 'hook ios.store.upload failed (exit 1)');
  assert.equal(c.commit, '3832680b'.padEnd(40, '0'), 'ship reads the build commit from here to judge a frozen-tools rerun');
});

// ---------------------------------------------------------------------------------------------------- what makes pending durable

test('pending counts only when latest.json names this version for the device and the catch-up there is live', () => {
  const base = { version: '0.3.20', androidCode: '25', iosBuild: '25', bumped: true, testflight: { status: 'assigned' }, deliveries: [lane('android', 'pending', { version: '0.3.20', build: 25 }), lane('ios', 'installed', { version: '0.3.20', build: 25 })] };
  assert.equal(judge({ ...base, catchup: { android: 'live', ios: 'live' }, latest: latestFor('0.3.20', 25) }).verdict, 'COMPLETE');
  const watch = judge({ ...base, catchup: { android: 'watch', ios: 'live' }, latest: latestFor('0.3.20', 25) });
  assert.equal(watch.verdict, 'INCOMPLETE');
  assert.match(watch.targets[0].why, /catch-up on big-chungus is watch, not live/);
  assert.deepEqual(watch.owed.map(o => o.command), ['node ~/.local/share/mobile-deploy-hub/current/tools/catchup/catchup.mjs mode live']);
  const older = judge({ ...base, catchup: { android: 'live', ios: 'live' }, latest: latestFor('0.3.20', 25, { androidVersion: '0.3.19' }) });
  assert.equal(older.verdict, 'INCOMPLETE');
  assert.match(older.targets[0].why, /latest\.json names 0\.3\.19 \(25\) for the S26, not 0\.3\.20 \(25\)/);
  assert.equal(judge({ ...base, catchup: { android: 'live', ios: 'live' }, latest: null }).verdict, 'INCOMPLETE', 'no latest.json: nothing durable');
  const unread = judge({ ...base, catchup: { android: 'live', ios: 'live' }, latest: null, latestUnread: true });
  assert.match(unread.targets[0].why, /latest\.json could not be read after deliver/);
  assert.deepEqual(unread.owed.map(o => o.command), ['curl -fsS https://s3.delo.sh/builds/tower-of-lost-things/latest.json'], 'a read failure is checked, not paid with a new version');
  const iosOff = judge({ ...base, deliveries: [lane('android', 'installed', { version: '0.3.20', build: 25 }), lane('ios', 'pending', { version: '0.3.20', build: 25 })], catchup: { android: 'live', ios: 'unknown' }, latest: latestFor('0.3.20', 25) });
  assert.deepEqual(iosOff.owed.map(o => o.command), ["ssh hub-mac '~/.local/share/mise/installs/node/24/bin/node ~/.local/share/mobile-deploy-hub/current/tools/catchup/catchup.mjs mode live'"]);
  // The catch-up got there first: installed. It gave up: RED, with the retry that starts it over.
  assert.equal(judge({ ...base, catchup: { android: 'live', ios: 'live' }, latest: latestFor('0.3.20', 25, { android: 'installed' }) }).targets[0].status, 'installed');
  const gaveUp = judge({ ...base, catchup: { android: 'live', ios: 'live' }, latest: latestFor('0.3.20', 25, { android: 'failed' }) });
  assert.equal(gaveUp.verdict, 'RED');
  assert.deepEqual(gaveUp.owed.map(o => o.command), ['node ~/.local/share/mobile-deploy-hub/current/tools/catchup/catchup.mjs retry tower-of-lost-things android']);
});

test('a dry run is judged on what it proved: every required lane checked is COMPLETE; a lane that would not run is owed', () => {
  const checked = [lane('android', 'pending', { version: '0.3.20', build: 25, reason: 'dry run: would install' }), lane('ios', 'pending', { version: '0.3.20', build: 25, reason: 'dry run: would install' })];
  const ok = judge({ dryRun: true, version: '0.3.20', androidCode: '25', deliveries: checked, testflight: { status: 'checked', reason: 'dry run: upload and assign were not called' } });
  assert.equal(ok.verdict, 'COMPLETE');
  assert.deepEqual(ok.targets.map(t => t.status), ['checked', 'checked', 'checked']);
  const metered = judge({ dryRun: true, version: '0.3.20', androidCode: '25', iosLane: 'skip-metered', deliveries: [checked[0], lane('ios', 'skipped', { version: '0.3.20', build: 25, reason: 'the Mac was on a metered link and the iPad build would have gone over its data budget' })], testflight: testflightOf({ testflight: true, iosLane: 'skip-metered', dryRun: true }) });
  assert.equal(metered.verdict, 'INCOMPLETE');
  assert.deepEqual(metered.owed.map(o => [o.target, o.command]), [['iPad', 'mise run ship --metered allow'], ['TestFlight', 'mise run ship --metered allow']]);
  const narrowed = judge({ version: '0.3.20', androidCode: '25', platform: 'android', bumped: true, catchup: { android: 'live' }, latest: latestFor('0.3.20', 25, { android: 'installed' }), deliveries: [lane('android', 'installed', { version: '0.3.20', build: 25 }), lane('ios', 'skipped', { version: '0.3.20', build: 25, reason: '--platform android' })], testflight: null });
  assert.equal(narrowed.verdict, 'INCOMPLETE', 'an explicit --platform narrowing is never shipped');
  assert.match(narrowed.targets[2].why, /--platform android left the iOS lane, and TestFlight with it, out/);
});

test('testflightOf reads the v1.3 store record, the older note, and a lane that never got there', () => {
  const of = (receipts, more = {}) => testflightOf({ testflight: true, receipts, needs: { ios: { result: 'success' } }, ...more });
  assert.equal(of({}, { testflight: false }), null, 'not owed by this run');
  assert.equal(of({ ios: { outcome: 'success', store: { status: 'assigned', uploaded: 'run', build: '25' } } }).status, 'assigned');
  assert.match(of({ ios: { outcome: 'success', store: { status: 'assigned', uploaded: 'earlier' } } }).reason, /already in App Store Connect/);
  assert.deepEqual(of({ ios: { outcome: 'failure', stage: 'deliver', store: { status: 'failed', reason: 'hook ios.store.assign failed (exit 1)' } } }), { status: 'failed', reason: 'hook ios.store.assign failed (exit 1)', build: null });
  assert.equal(of({ ios: { outcome: 'success', testflight: 'uploaded and assigned to Owner Testing by the app hooks' } }).status, 'assigned', 'an older receipt\'s note');
  assert.equal(of({ ios: { outcome: 'success', store: { status: 'checked' }, testflight: 'dry run: upload and assign were not called' } }, { dryRun: true }).status, 'checked');
  assert.equal(of({ ios: { outcome: 'failure', stage: 'install', reason: 'readback: no app' } }).status, 'failed');
  assert.equal(of({}, { needs: { ios: { result: 'skipped' } } }).status, 'skipped');
  assert.equal(of({}, { iosLane: 'skip-lost' }).status, 'skipped');
  assert.equal(of({ ios: { outcome: 'success' } }).status, 'missing', 'a real ios lane that recorded no TestFlight owes it');
});

test('the event carries TestFlight as a delivery: assigned reads as assigned, a failure as failed at deliver', () => {
  const needs = { gate: { result: 'success' }, plan: { result: 'success' }, android: { result: 'success' }, ios: { result: 'success' } };
  const receipts = { android: { outcome: 'success', delivery: { status: 'installed', verified: true, build: '25' } }, ios: { outcome: 'success', delivery: { status: 'pending', build: '25', reason: 'asleep or away' } } };
  const event = deploymentEvent({ project: { slug, name: 'Tower of Lost Things' }, declared: { android: true, ios: true }, devices, needs, receipts, version: '0.3.20', androidCode: '25', commit: 'a'.repeat(40), env: { GITHUB_RUN_ID: '9', GITHUB_REPOSITORY: repo }, extraDeliveries: [testflightDelivery({ status: 'assigned' }, { version: '0.3.20', build: '25' })] });
  assert.equal(event.type, 'bloodbank.project.deployment.completed');
  assert.deepEqual(event.data.deliveries.map(d => [d.device, d.status]), [['S26', 'installed'], ['iPad', 'pending'], ['TestFlight', 'installed']]);
  assert.match(event.data.summary, /S26 installed, iPad pending, TestFlight assigned, verified=false$/);
  assert.deepEqual(testflightDelivery({ status: 'failed', reason: 'hook ios.store.upload failed (exit 1)' }, { version: '0.3.19', build: 24 }), { platform: 'ios', target: 'TestFlight Owner Testing', device: 'TestFlight', version: '0.3.19', build: '24', sha256: null, verified: false, status: 'failed', reason: 'hook ios.store.upload failed (exit 1)', stage: 'deliver' });
  assert.equal(testflightDelivery({ status: 'checked', reason: 'dry run' }, { version: '0.3.20', build: null }).status, 'pending');
});

test('the wording reads the policy\'s beta groups, not the literal Owner Testing (JIMB-466)', () => {
  const of = receipts => testflightOf({ testflight: true, receipts, needs: { ios: { result: 'success' } } });
  const groups = ['Owner Testing', 'Client Review'];
  assert.equal(of({ ios: { outcome: 'success', store: { status: 'assigned', uploaded: 'run', build: '3007', groups } } }).reason, 'uploaded and assigned to Owner Testing, Client Review');
  assert.equal(of({ ios: { outcome: 'success', store: { status: 'assigned', uploaded: 'earlier', build: '3007', groups } } }).reason, 'already in App Store Connect; assigned to Owner Testing, Client Review');
  assert.equal(of({ ios: { outcome: 'success', store: { status: 'assigned', uploaded: 'run', build: '25' } } }).reason, 'uploaded and assigned to Owner Testing', 'a v1.3 receipt without groups reads as before');
  assert.match(of({ ios: { outcome: 'success', store: { status: 'assigned', uploaded: 'run', groups, review: { state: 'WAITING_FOR_REVIEW' } } } }).reason, /assigned to Owner Testing, Client Review \(beta review: WAITING_FOR_REVIEW\)$/, 'uploaded is told apart from testers can install');
  assert.equal(of({ ios: { outcome: 'success', testflight: 'uploaded and assigned to Owner Testing, Client Review by the app hooks' } }).status, 'assigned', 'a note naming several groups');
  assert.equal(of({ ios: { outcome: 'success', testflight: 'already in App Store Connect (ios.store.state); assigned to Client Review by the app hooks' } }).status, 'assigned');
  assert.equal(testflightDelivery({ status: 'assigned' }, { version: '0.3.0', build: '3007', groups }).target, 'TestFlight Owner Testing, Client Review');
  assert.equal(testflightDelivery({ status: 'assigned' }, { version: '0.3.0', build: '3007' }).target, 'TestFlight Owner Testing', 'the default is unchanged for every other app');
  const many = Array.from({ length: 8 }, (_, i) => `A beta group with a long name ${i} ${'x'.repeat(30)}`);
  assert.ok(testflightDelivery({ status: 'assigned' }, { version: '0.3.0', build: '1', groups: many }).target.length <= 120, 'the Bloodbank schema caps the target at 120');
});

// ---------------------------------------------------------------------------------------------------- announce writes it

async function announceFixture({ receipts, needs, latest, dryRun = false, testflight = true }) {
  const root = await mkdtemp(join(tmpdir(), 'hub-completion-'));
  const app = join(root, 'app');
  const out = join(root, 'out');
  await mkdir(join(app, 'tools/ci'), { recursive: true });
  await mkdir(join(out, 'receipts'), { recursive: true });
  const manifest = {
    schema: 2, project: { slug, name: 'Tower of Lost Things' }, version: { read: 'true', bump: 'true' },
    android: { package: policy.apps[repo].android.package, export: 'true', artifact: 'a/App.apk', signer_sha256: policy.apps[repo].android.signer_sha256 },
    ios: { bundle: policy.apps[repo].ios.bundle, export: 'true', archive: 'a.tgz', receipt: 'a.json', device: 'true', device_artifact: 'A.xcarchive', store: { archive: 'b.tgz', receipt: 'b.json', upload: 'true', assign: 'true', signer_sha1: 'F8A5C5309FC1B6C7DD7662A28EA822BE3309C351' } },
  };
  await writeFile(join(app, 'tools/ci/mobile-deploy.json'), JSON.stringify(manifest));
  for (const receipt of receipts) await writeFile(join(out, 'receipts', `hub-receipt-${receipt.lane}.json`), JSON.stringify(receipt));
  const bin = join(root, 'bin');
  await mkdir(bin);
  await writeFile(join(bin, 'bb-emit'), `#!/bin/sh\ncat > /dev/null\necho "bb-emit $*" >> "${root}/bb-emit.log"\n[ -z "$FAKE_BB_FAIL" ] || { echo "nats: no servers" >&2; exit 1; }\n`);
  await chmod(join(bin, 'bb-emit'), 0o755);
  const env = { PATH: process.env.PATH, GITHUB_REPOSITORY: repo, GITHUB_RUN_ID: '41500000000', GITHUB_RUN_ATTEMPT: '1', GITHUB_SHA: 'c'.repeat(40), HUB_BB_EMIT: join(bin, 'bb-emit'), HUB_NEEDS: JSON.stringify(needs), HUB_RECEIPTS: join(out, 'receipts') };
  const config = { ...parseConfig(['announce', '--manifest', 'tools/ci/mobile-deploy.json', '--out', out, '--dry-run', String(dryRun), '--testflight', String(testflight)], env), cwd: app };
  const fetchImpl = async () => (latest ? { status: 200, ok: true, text: async () => JSON.stringify(latest) } : { status: 404, ok: false, text: async () => '' });
  const run = async (more = {}) => announce(config, { env: { ...env, ...more }, home: root, fetchImpl, log: () => {}, lostMac: null });
  const completion = async () => JSON.parse(await readFile(join(out, 'completion/completion.json'), 'utf8'));
  return { run, completion, cleanup: () => rm(root, { recursive: true, force: true }) };
}

const gateReceipt = { lane: 'gate', outcome: 'success', gate: { ios_lane: 'run', catchup: { android: 'live', ios: 'live' }, completion: { required: { android: true, ios: true, testflight: true }, testflight: true } } };
const planReceipt = (version, code) => ({ lane: 'plan', outcome: 'success', version, android_code: code, build: String(code), sha: 'b'.repeat(40), bump: { committed: true, to: version } });
const allGreen = { gate: { result: 'success' }, 'preflight-ios': { result: 'success' }, plan: { result: 'success' }, android: { result: 'success' }, 'ios-export': { result: 'success' }, ios: { result: 'success' }, 'deliver-android': { result: 'success' }, 'deliver-ios': { result: 'success' } };

test('announce writes completion-out: a real store run with TestFlight assigned and the iPad durably pending is COMPLETE', async () => {
  const f = await announceFixture({
    receipts: [gateReceipt, planReceipt('0.3.20', 25), { lane: 'android', outcome: 'success', delivery: { status: 'installed', verified: true, build: '25' } }, { lane: 'ios', outcome: 'success', delivery: { status: 'pending', build: '25', reason: 'asleep or away' }, store: { status: 'assigned', uploaded: 'run', build: '25', version: '0.3.20' } }],
    needs: allGreen, latest: latestFor('0.3.20', 25, { android: 'installed' }),
  });
  try {
    const event = await f.run();
    assert.equal(event.sent, true);
    assert.deepEqual(event.data.deliveries.map(d => [d.device, d.status]), [['S26', 'installed'], ['iPad', 'pending'], ['TestFlight', 'installed']]);
    const c = await f.completion();
    assert.deepEqual([c.verdict, c.version, c.bumped, c.commit, c.run.id], ['COMPLETE', '0.3.20', true, 'b'.repeat(40), '41500000000']);
    assert.deepEqual(c.targets.map(t => [t.target, t.status]), [['S26', 'installed'], ['iPad', 'pending'], ['TestFlight', 'assigned']]);
  } finally { await f.cleanup(); }
});

test('announce writes completion-out red for 0.3.19\'s shape, and rewrites it red when the bus is dead', async () => {
  const receipts = [gateReceipt, planReceipt('0.3.19', 24), { lane: 'android', outcome: 'success', delivery: { status: 'pending', build: '24' } }, { lane: 'ios', outcome: 'failure', stage: 'deliver', reason: 'hook ios.store.upload failed (exit 1)', delivery: { status: 'pending', build: '24', reason: 'asleep or away' } }];
  const f = await announceFixture({ receipts, needs: { ...allGreen, ios: { result: 'failure' } }, latest: latestFor('0.3.19', 24) });
  try {
    const event = await f.run();
    assert.equal(event.type, 'bloodbank.project.deployment.failed');
    assert.deepEqual(event.data.deliveries.map(d => [d.device, d.status]), [['S26', 'pending'], ['iPad', 'pending'], ['TestFlight', 'failed']]);
    const c = await f.completion();
    assert.equal(c.verdict, 'RED');
    assert.deepEqual(c.owed.map(o => o.command), ['gh run rerun 41500000000 --repo delorenj/tower-of-lost-things --failed']);
  } finally { await f.cleanup(); }
  const g = await announceFixture({ receipts: [gateReceipt, planReceipt('0.3.20', 25), { lane: 'android', outcome: 'success', delivery: { status: 'installed', verified: true, build: '25' } }, { lane: 'ios', outcome: 'success', delivery: { status: 'installed', verified: true, build: '25' }, store: { status: 'assigned', build: '25' } }], needs: allGreen, latest: latestFor('0.3.20', 25, { android: 'installed', ios: 'installed' }) });
  try {
    await assert.rejects(g.run({ FAKE_BB_FAIL: '1' }), /bb-emit --check refused/);
    const c = await g.completion();
    assert.equal(c.verdict, 'RED', 'a run whose event never went out is not shipped');
    assert.equal(c.failure.job, 'announce');
  } finally { await g.cleanup(); }
});
