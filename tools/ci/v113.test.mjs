// v1.1.3 tests: the review round after v1.1.2. Each test names the finding it holds: the hub runs only from the
// template caller, conformance and the guard see a second caller, the APK half never waits for the Mac, a device's
// state comes from its own lane, reruns reset a failure, missing receipts fail loudly, the plan re-checks the manifest
// and the Mac, the catch-up code only moves forward, Quickdrop stays off cellular and never replaces a newer APK,
// resumed transfers count their bytes, the watchdog gives up a lost Mac, and the pages read plainly.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, symlinkSync, writeFileSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkCallerRef, templateFile } from './lib/caller.mjs';
import { parseConfig } from './lib/config.mjs';
import { loadPolicy, parsePolicy, policyFile } from './lib/policy.mjs';
import { deliveriesFrom, deploymentEvent, linksFor } from './lib/announce.mjs';
import { loadDevices, parseDevices } from './lib/devices.mjs';
import { progressBytes, treeDigest } from './lib/handoff.mjs';
import { macLink, macProbeScript, parseMacProbe, runnerStatusOver } from './lib/metered.mjs';
import { deviceLine, releaseLabel } from './lib/pages.mjs';
import { dropApk, s26OnLan, syncthingGui } from './lib/quickdrop.mjs';
import { catchupNote, installCurrent, readCatchupMode } from './commands/common.mjs';
import { deliver, deviceOf, inflightAfter, mergeLatest } from './commands/deliver.mjs';
import { findLostMac } from './commands/announce.mjs';
import { checkConformance, checkPins, gate } from './commands/gate.mjs';
import { sendIpa } from './commands/ios.mjs';
import { main } from './hub.mjs';
import { judgeRun, watch } from './macwatch.mjs';
import { checkWorkflow, triggersOf } from '../conformance.mjs';
import { sampleLatest } from './test-fixtures.mjs';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const { policy } = loadPolicy();
const devices = loadDevices({});
const template = readFileSync(templateFile, 'utf8');
const tower = policy.apps['delorenj/tower-of-lost-things'];

// ---------------------------------------------------------------------------------------------------- only the template caller

test('inside a job, every hub command refuses a run another workflow started; outside a job the check is a no-op', async () => {
  const env = { GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: 'delorenj/tower-of-lost-things', GITHUB_WORKFLOW_REF: 'delorenj/tower-of-lost-things/.github/workflows/hotfix.yml@refs/heads/main' };
  assert.throws(() => checkCallerRef({ policy, env }), /HUB_GATE_REFUSED caller: this job was started by .*hotfix\.yml.*only from delorenj\/tower-of-lost-things\/\.github\/workflows\/deploy\.yml@/);
  assert.equal(checkCallerRef({ policy, env: { ...env, GITHUB_WORKFLOW_REF: 'delorenj/tower-of-lost-things/.github/workflows/deploy.yml@refs/heads/main' } }), 'refs/heads/main');
  assert.equal(checkCallerRef({ policy, env: { ...env, GITHUB_ACTIONS: '' } }), null, 'a test or a person at a shell');
  // Every command goes through main(): android, release, deliver and announce included, not only the gate.
  for (const command of ['android', 'release', 'play', 'deliver', 'announce', 'ios', 'preflight-ios']) {
    await assert.rejects(main([command], env), /HUB_GATE_REFUSED caller/, command);
  }
});

test('conformance and the gate refuse a second workflow that calls the hub, at any ref, as a reusable workflow or an action', async () => {
  const repo = 'delorenj/tower-of-lost-things';
  const reusable = 'jobs:\n  x:\n    uses: delorenj/mobile-deploy-hub/.github/workflows/mobile-deploy.yml@v1.0.0\n';
  const action = 'jobs:\n  x:\n    runs-on: [self-hosted, Linux]\n    steps:\n      - uses: delorenj/mobile-deploy-hub/actions/hub@v1.1.2\n        with:\n          command: android\n';
  for (const text of [reusable, action]) assert.match(checkWorkflow(repo, '.github/workflows/hotfix.yml', text).join('\n'), /calls mobile-deploy-hub; only \.github\/workflows\/deploy\.yml/);
  assert.deepEqual(checkWorkflow(repo, '.github/workflows/deploy.yml', template), []);
  // The TestFlight exception holds only while the workflow is dispatched by hand: a tag trigger loses it.
  const testflight = 'on:\n  workflow_dispatch:\n    inputs:\n      build:\n        required: false\n\njobs:\n  upload:\n    steps:\n      - run: node tools/testflight.mjs upload x.tgz\n';
  assert.deepEqual(triggersOf(testflight), ['workflow_dispatch']);
  assert.deepEqual(checkWorkflow(repo, '.github/workflows/testflight.yml', testflight), []);
  const tagged = testflight.replace('\n\njobs:', "\n  push:\n    tags: ['ios-v*']\n\njobs:");
  assert.deepEqual(triggersOf(tagged), ['workflow_dispatch', 'push']);
  assert.match(checkWorkflow(repo, '.github/workflows/testflight.yml', tagged).join('\n'), /documented form[\s\S]*TestFlight upload outside the hub/);
  assert.match(checkWorkflow(repo, '.github/workflows/testflight.yml', `${testflight}      - uses: delorenj/mobile-deploy-hub/actions/hub@v1\n`).join('\n'), /calls mobile-deploy-hub/, 'an exception never covers a hub reference');

  // The gate runs the same check on its own checkout, so the next deploy (dry or real) stops on it.
  const root = await mkdtemp(join(tmpdir(), 'hub-conformance-'));
  try {
    await mkdir(join(root, '.github/workflows'), { recursive: true });
    await mkdir(join(root, 'tools/ci'), { recursive: true });
    await writeFile(join(root, '.github/workflows/deploy.yml'), template);
    await writeFile(join(root, '.github/workflows/hotfix.yml'), action);
    await writeFile(join(root, 'tools/ci/mobile-deploy.json'), JSON.stringify(towerManifest()));
    assert.throws(() => checkConformance({ policy, app: tower, config: { cwd: root }, env: { GITHUB_REPOSITORY: repo } }), /HUB_GATE_REFUSED conformance: .*hotfix\.yml: calls mobile-deploy-hub/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

function towerManifest(extra = {}) {
  return {
    schema: 2,
    project: { slug: 'tower-of-lost-things', name: 'Tower of Lost Things' },
    version: { read: 'node version.mjs', bump: 'node version.mjs bump' },
    android: { package: tower.android.package, export: 'true', artifact: 'artifacts/App.apk', signer_sha256: tower.android.signer_sha256 },
    ios: { bundle: tower.ios.bundle, device: 'true', device_artifact: 'App.xcarchive' },
    ...extra,
  };
}

test('the policy pins each app\'s package, signer and bundle; the gate refuses a manifest that differs', () => {
  for (const [repo, app] of Object.entries(policy.apps)) {
    assert.match(app.android.package, /^[a-z]/, repo);
    assert.match(app.android.signer_sha256, /^[0-9a-f]{64}$/, repo);
    if (app.lanes.includes('ios')) assert.match(app.ios.bundle, /^[a-z]/, repo);
  }
  const base = JSON.parse(readFileSync(policyFile, 'utf8'));
  for (const [name, change] of Object.entries({
    'no android pin': p => { delete p.apps['delorenj/gruvato'].android; },
    'uppercase signer': p => { p.apps['delorenj/gruvato'].android.signer_sha256 = 'A'.repeat(64); },
    'an ios pin without the lane': p => { p.apps['delorenj/gruvato'].lanes = ['android']; },
    'no queue limit': p => { delete p.mac.queue_limit_min; },
  })) {
    const copy = structuredClone(base);
    change(copy);
    assert.throws(() => parsePolicy(JSON.stringify(copy)), /policy\.json/, name);
  }
  assert.doesNotThrow(() => checkPins({ app: tower, manifest: towerManifest() }));
  assert.throws(() => checkPins({ app: tower, manifest: towerManifest({ android: { ...towerManifest().android, signer_sha256: 'e'.repeat(64) } }) }), /HUB_GATE_REFUSED pins: .*signer_sha256/);
  assert.throws(() => checkPins({ app: tower, manifest: towerManifest({ ios: { bundle: 'io.example.other', device: 'true', device_artifact: 'App.xcarchive' } }) }), /HUB_GATE_REFUSED pins: .*ios\.bundle/);
});

// ---------------------------------------------------------------------------------------------------- the Mac's link

test('the gate checks this app\'s own Mac runner, GitHub\'s view of it, and treats an unanswered ssh off the LAN as offline', () => {
  const status = curAddr => ({ Peer: { k: { DNSName: 'carries-macbook-air.burro-salmon.ts.net.', Online: true, CurAddr: curAddr, Relay: 'nyc' } } });
  const base = { peer: 'carries-macbook-air', lanCidr: '192.168.1.0/24', runnerName: 'delonet-gib-mac-r1' };
  assert.equal(macLink({ ...base, status: status('76.98.73.87:1'), probe: () => ({ runner: 'missing', catchup: 'live' }) }).link, 'offline');
  assert.match(macLink({ ...base, status: status('76.98.73.87:1'), probe: () => ({ runner: 'missing', catchup: 'live' }) }).reason, /delonet-gib-mac-r1/);
  assert.equal(macLink({ ...base, status: status('76.98.73.87:1'), probe: () => null }).link, 'offline', 'metered and no answer');
  assert.equal(macLink({ ...base, status: status(''), probe: () => null }).link, 'offline', 'relayed and no answer');
  assert.equal(macLink({ ...base, status: status('192.168.1.30:1'), probe: () => null }).link, 'home', 'home: tailscale and GitHub decide');
  assert.equal(macLink({ ...base, status: status('192.168.1.30:1'), probe: () => ({ runner: 'alive', catchup: 'watch' }), github: () => ({ status: 'offline', busy: false }) }).link, 'offline');
  assert.deepEqual(macLink({ ...base, status: status('76.98.73.87:1'), probe: () => ({ runner: 'alive', catchup: 'watch' }), github: () => ({ status: 'online', busy: true }) }), { link: 'metered', addr: '76.98.73.87', reason: '76.98.73.87 is outside 192.168.1.0/24', catchup: 'watch' });
  // One ssh round trip: this runner's own folder (gib's Listener does not stand in for Tower's), and the catch-up mode.
  const script = macProbeScript('actions-runner/gib');
  assert.match(script, /pgrep -f "\^\$HOME\/actions-runner\/gib\/bin\/Runner\.Listener"/);
  assert.match(script, /mobile-deploy-hub\/catchup\.json/);
  assert.throws(() => macProbeScript('../evil'), /bad runner folder/);
  assert.deepEqual(parseMacProbe('runner=alive\ncatchup=live\n'), { runner: 'alive', catchup: 'live' });
  assert.equal(parseMacProbe('Connection closed'), null);
  const calls = [];
  const runner = (command, args, options) => { calls.push({ args, env: options.env }); return 'offline false\n'; };
  assert.deepEqual(runnerStatusOver('delorenj/gruvato', 'mommymac-gruvato', { env: { GH_TOKEN: 'job-token', PATH: '/bin' }, runner })(), { status: 'offline', busy: false });
  assert.equal(calls[0].env.GH_TOKEN, undefined, 'the host\'s gh login, never the job token');
  assert.match(calls[0].args.join(' '), /repos\/delorenj\/gruvato\/actions\/runners .*select\(\.name == "mommymac-gruvato"\)/);
  assert.equal(runnerStatusOver('delorenj/gruvato', 'bad name;rm', { runner })(), null);
  // devices.json names each app's own runner and folder.
  assert.deepEqual(devices.mac.runners['delorenj/green-in-between'], { name: 'delonet-gib-mac-r1', dir: 'actions-runner/gib' });
  assert.throws(() => parseDevices(JSON.stringify({ ...devices, mac: { ...devices.mac, runners: { 'delorenj/x': { name: 'r', dir: '/abs' } } } })), /mac\.runners/);
});

// ---------------------------------------------------------------------------------------------------- deliver

test('a device\'s state comes from its own lane: a failed Release step leaves the S26 pending, not failed', () => {
  const stamp = '2026-10-09T21:00:00Z';
  const success = { outcome: 'success', delivery: { status: 'pending', reason: "not on big-chungus's adb" } };
  assert.equal(deviceOf(devices.android, success, { stamp }).status, 'pending', 'the android job failed later, at the Release');
  assert.equal(deviceOf(devices.android, { outcome: 'failure', stage: 'install', reason: 'Failure [INSTALL_FAILED_INSUFFICIENT_STORAGE]', delivery: { status: 'pending' } }, { stamp }).status, 'failed');
  assert.equal(deviceOf(devices.ios, { outcome: 'failure', stage: 'deliver', reason: 'TestFlight upload failed', delivery: { status: 'installed' } }, { stamp }).status, 'installed', 'a TestFlight failure is not the iPad\'s');
  // A pending device whose host's catch-up is in watch mode says so instead of promising an automatic install.
  const off = deviceOf(devices.android, success, { stamp, catchup: 'watch', host: 'big-chungus' });
  assert.match(off.reason, /not on big-chungus's adb; catch-up off on big-chungus \(catchup\.mjs mode live\)/);
  assert.match(deviceLine('android', { version: '0.2.2', code: 4, device: off }), /^S26 0\.2\.2 \(4\): pending \(/, 'no "installs when it is back" while the catch-up is off');
  assert.equal(catchupNote('x', 'live', 'h'), 'x');
});

test('a rerun after a failure resets it: a fresh pending replaces failed (the catch-up retries), an install the rerun did not see is kept', () => {
  const top = { slug: 'tower-of-lost-things', name: 'Tower of Lost Things', version: '0.2.2', commit: 'b'.repeat(40), hub_ref: 'v1.1.3', run: sampleLatest().run, correlation: sampleLatest().correlation };
  const failedFirst = sampleLatest();
  failedFirst.android.device = { ...failedFirst.android.device, status: 'failed', reason: 'Failure [INSTALL_FAILED_INSUFFICIENT_STORAGE]', failures: 0 };
  const rerun = structuredClone(sampleLatest().android);
  rerun.sha256 = 'f'.repeat(64);
  const merged = mergeLatest({ current: failedFirst, candidates: { android: rerun, ios: null }, top, stamp: '2026-10-09T21:00:00Z', log: () => {} });
  assert.deepEqual([merged.latest.android.device.status, merged.latest.android.sha256], ['pending', 'f'.repeat(64)], 'the catch-up acts on pending: the rerun\'s bytes and state win');
  const installedFirst = sampleLatest();
  installedFirst.android.device = { ...installedFirst.android.device, status: 'installed', by: 'deploy', reason: null };
  assert.equal(mergeLatest({ current: installedFirst, candidates: { android: structuredClone(sampleLatest().android), ios: null }, top, stamp: '2026-10-09T21:00:00Z', log: () => {} }).latest.android.device.status, 'installed');
  // Nothing moved: no top-level change and no write (deliver checks `moved`).
  const newer = sampleLatest({ version: '0.2.9' });
  newer.android = { ...newer.android, version: '0.2.9', code: 9, key: 'tower-of-lost-things/0.2.9/tower-of-lost-things-0.2.9-9.apk', url: 'https://s3.delo.sh/builds/tower-of-lost-things/0.2.9/tower-of-lost-things-0.2.9-9.apk' };
  const kept = mergeLatest({ current: newer, candidates: { android: structuredClone(sampleLatest().android), ios: null }, top, stamp: '2026-10-09T21:00:00Z', log: () => {} });
  assert.deepEqual([kept.moved, kept.latest.version, kept.latest.updated_at], [false, '0.2.9', newer.updated_at]);
});

test('inflight.json: each deliver job clears only its own platform of its own run', () => {
  const run = { id: '777' };
  const inflight = { version: '0.2.3', run: { id: '777' }, started_at: '2026-10-09T20:00:00Z', platforms: ['android', 'ios'] };
  assert.deepEqual(inflightAfter(inflight, run, ['android']), { action: 'write', inflight: { ...inflight, platforms: ['ios'] } });
  assert.deepEqual(inflightAfter({ ...inflight, platforms: ['ios'] }, run, ['ios']), { action: 'remove' });
  assert.deepEqual(inflightAfter({ ...inflight, run: { id: '900' } }, run, ['android']), { action: 'keep' }, 'a newer deploy\'s file is left alone');
  assert.deepEqual(inflightAfter(null, run, ['ios']), { action: 'keep' });
});

async function deliverHost({ needs, receipts, scope = 'both', dryRun = false }) {
  const root = await mkdtemp(join(tmpdir(), 'hub-deliver113-'));
  const app = join(root, 'app');
  const out = join(root, 'out');
  await mkdir(join(out, 'receipts'), { recursive: true });
  await mkdir(app, { recursive: true });
  await writeFile(join(app, 'mobile-deploy.json'), JSON.stringify(towerManifest()));
  for (const [lane, receipt] of Object.entries(receipts)) await writeFile(join(out, 'receipts', `hub-receipt-${lane}.json`), JSON.stringify({ lane, ...receipt }));
  const env = { PATH: process.env.PATH, GITHUB_REPOSITORY: 'delorenj/tower-of-lost-things', GITHUB_RUN_ID: '777', GITHUB_RUN_ATTEMPT: '2', HUB_REF: 'v1.1.3', HUB_LOCK_DIR: join(root, 'locks'), HUB_NEEDS: JSON.stringify(needs) };
  const config = { ...parseConfig(['deliver', '--manifest', 'mobile-deploy.json', '--out', out, '--version', '0.2.2', '--android-code', '5', '--build-sha', 'b'.repeat(40), '--scope', scope, '--dry-run', String(dryRun)], env), cwd: app };
  const writes = [];
  const s3 = { putText: (text, key) => writes.push(key), put: (file, key) => writes.push(key), remove: key => writes.push(`rm ${key}`), list: () => [] };
  return { root, env, config, writes, s3, cleanup: () => rm(root, { recursive: true, force: true }) };
}

test('a lane that succeeded without a receipt deliver can read is a failure at deliver, not a silent pending', async () => {
  const f = await deliverHost({ needs: { plan: { result: 'success' }, android: { result: 'success' } }, receipts: {}, scope: 'android' });
  try {
    await assert.rejects(deliver(f.config, { env: f.env, home: f.root, fetchImpl: async () => ({ status: 404, ok: false, text: async () => '' }), s3Factory: async () => f.s3, log: () => {} }), /the android job succeeded but its receipt for 0\.2\.2 is missing/);
    assert.deepEqual(f.writes, [], 'nothing published, no pointer moved, inflight.json untouched');
    const receipt = JSON.parse(readFileSync(join(f.config.out, 'deliver/hub-receipt-deliver-android.json'), 'utf8'));
    assert.deepEqual([receipt.outcome, receipt.stage], ['failure', 'deliver']);
  } finally { await f.cleanup(); }
  // The ios lane that never built an IPA (a dry run without dry_handoff) is not a missing receipt.
  const g = await deliverHost({ needs: { plan: { result: 'success' }, ios: { result: 'success' } }, receipts: { ios: { outcome: 'success', version: '0.2.2', ipa: null, delivery: { status: 'pending' } } }, scope: 'ios', dryRun: true });
  try {
    const result = await deliver(g.config, { env: g.env, home: g.root, fetchImpl: async () => ({ status: 404, ok: false, text: async () => '' }), log: () => {} });
    assert.equal(result.published.ota, null);
  } finally { await g.cleanup(); }
});

test('deliver refuses a manifest whose slug is not the policy\'s (a rename on main after the gate opens no new folder)', async () => {
  const f = await deliverHost({ needs: { plan: { result: 'success' } }, receipts: {}, scope: 'android' });
  try {
    await writeFile(join(f.config.cwd, 'mobile-deploy.json'), JSON.stringify(towerManifest({ project: { slug: 'tower-of-lost-thingz', name: 'Tower of Lost Things' } })));
    await assert.rejects(deliver(f.config, { env: f.env, home: f.root, fetchImpl: async () => ({ status: 404, ok: false, text: async () => '' }), s3Factory: async () => f.s3, log: () => {} }), /HUB_GATE_REFUSED slug: .*tower-of-lost-thingz.*tower-of-lost-things/);
  } finally { await f.cleanup(); }
});

// ---------------------------------------------------------------------------------------------------- the event

const ok = { result: 'success' };
const delivery = (platform, extra = {}) => ({ platform, target: platform === 'android' ? 'SM-S948U' : 'iPad14,5', version: '0.2.2', build: platform === 'android' ? '4' : '5', sha256: 'a'.repeat(64), verified: false, status: 'pending', ...extra });
const both = { android: true, ios: true };
const project = { slug: 'tower-of-lost-things', name: 'Tower of Lost Things' };
const runEnv = { GITHUB_REPOSITORY: 'delorenj/tower-of-lost-things', GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '1', HUB_REF: 'v1.1.3' };

test('a failed Release after the S26 lane is .failed at deliver, and the S26 stays pending', () => {
  const event = deploymentEvent({
    project, declared: both, devices,
    needs: { gate: ok, 'preflight-ios': ok, plan: ok, android: { result: 'failure' }, 'ios-export': { result: 'skipped' }, ios: ok, 'deliver-android': ok, 'deliver-ios': ok },
    receipts: { android: { outcome: 'success', delivery: delivery('android', { reason: "not on big-chungus's adb" }) }, 'android-release': { outcome: 'failure', stage: 'deliver', reason: 'gh release create: HTTP 502 uploading the APK' }, ios: { outcome: 'success', delivery: delivery('ios', { status: 'installed', verified: true }) } },
    version: '0.2.2', androidCode: '4', commit: 'b'.repeat(40), env: runEnv,
  });
  assert.equal(event.type, 'bloodbank.project.deployment.failed');
  assert.deepEqual([event.data.stage, event.data.reason], ['deliver', 'gh release create: HTTP 502 uploading the APK']);
  assert.deepEqual(event.data.deliveries.map(item => [item.device, item.status]), [['S26', 'pending'], ['iPad', 'installed']]);
});

test('a lane that succeeded with no receipt is failed ("receipt missing"), never a quiet pending', () => {
  const { deliveries, failure } = deliveriesFrom({ declared: { android: true, ios: false }, devices, needs: { gate: ok, plan: ok, android: ok }, receipts: {}, version: '0.2.2' });
  assert.deepEqual([deliveries[0].status, failure.stage], ['failed', 'deliver']);
  assert.match(failure.reason, /receipt is missing/);
});

test('a Mac job no runner ever took makes the iPad skipped (ios) or stops the run before the bump (preflight-ios)', () => {
  const lost = { job: 'ios', reason: 'the Mac went offline after the gate: the ios job waited 15+ minutes and no runner took it; Re-run failed jobs when it is back' };
  const event = deploymentEvent({
    project, declared: both, devices, needs: { gate: ok, 'preflight-ios': ok, plan: ok, android: ok, 'ios-export': { result: 'skipped' }, ios: { result: 'cancelled' }, 'deliver-android': ok, 'deliver-ios': { result: 'skipped' } },
    receipts: { android: { outcome: 'success', delivery: delivery('android') } }, version: '0.2.2', androidCode: '4', commit: 'b'.repeat(40), env: runEnv, lostMac: lost,
    published: { apk: 'https://s3.delo.sh/builds/tower-of-lost-things/0.2.2/tower-of-lost-things-0.2.2-4.apk', apk_bytes: 74_660_647, page: 'https://s3.delo.sh/builds/tower-of-lost-things/index.html', any: true },
  });
  assert.equal(event.type, 'bloodbank.project.deployment.completed');
  assert.deepEqual(event.data.deliveries.map(item => [item.device, item.status]), [['S26', 'pending'], ['iPad', 'skipped']]);
  assert.match(event.data.deliveries[1].reason, /went offline after the gate/);
  assert.deepEqual(event.data.links.map(link => link.label), ['Install APK (74.7 MB)', 'Builds', 'Run'], 'the size rides in the button');
  const early = deploymentEvent({ project, declared: both, devices, needs: { gate: ok, 'preflight-ios': { result: 'cancelled' }, plan: { result: 'skipped' } }, receipts: {}, version: '0.2.1', androidCode: '3', commit: 'b'.repeat(40), env: runEnv, lostMac: { job: 'preflight-ios', reason: 'the Mac went offline after the gate: preflight-ios waited 15+ minutes and no runner took it; nothing was bumped' } });
  assert.deepEqual([early.type, early.data.stage], ['bloodbank.project.deployment.failed', 'preflight']);
  assert.match(early.data.reason, /nothing was bumped/);
  // The plan's own skip-lost verdict reads the same on the iPad.
  const planLost = deliveriesFrom({ declared: both, devices, needs: { gate: ok, plan: ok, android: ok, ios: { result: 'skipped' } }, receipts: { android: { outcome: 'success', delivery: delivery('android') } }, version: '0.2.2', iosLane: 'skip-lost' });
  assert.equal(planLost.deliveries[1].status, 'skipped');
  assert.match(planLost.deliveries[1].reason, /went offline after the gate/);
  assert.equal(linksFor({ type: 'bloodbank.project.deployment.completed', published: { apk: 'https://x/a.apk', apk_bytes: 312_000_000, ota: 'itms-services://?action=download-manifest&url=https://x/m.plist', ipa_bytes: 41_493_992, page: 'https://x/i.html' }, runUrl: null, deliveries: [] }).map(link => link.label).join(' | '), 'Install APK (312 MB) | Install on iPad (41.5 MB) | Builds');
});

test('announce finds a lost Mac job in GitHub\'s record of the run: cancelled and never taken by a runner', () => {
  const env = { ...runEnv, GH_TOKEN: 'job-token' };
  const jobs = [{ name: 'deploy / gate', conclusion: 'success', runner_name: 'big-chungus' }, { name: 'deploy / ios', conclusion: 'cancelled', runner_name: '' }];
  let seen = null;
  const runner = (command, args, options) => { seen = { args, env: options.env }; return JSON.stringify(jobs); };
  assert.equal(findLostMac({ env, needs: { ios: { result: 'success' } }, policy, runner }), null, 'nothing cancelled: GitHub is not asked');
  assert.equal(seen, null);
  const lost = findLostMac({ env, needs: { ios: { result: 'cancelled' } }, policy, runner });
  assert.equal(lost.job, 'ios');
  assert.equal(seen.env.GH_TOKEN, undefined);
  assert.match(seen.args[1], /^repos\/delorenj\/tower-of-lost-things\/actions\/runs\/123\/attempts\/1\/jobs/);
  assert.equal(findLostMac({ env, needs: { ios: { result: 'cancelled' } }, policy, runner: () => JSON.stringify([{ name: 'deploy / ios', conclusion: 'cancelled', runner_name: 'carries-macbook-air' }]) }), null, 'a job a runner took was cancelled mid-build: not lost');
});

// ---------------------------------------------------------------------------------------------------- the catch-up code only moves forward

test('installCurrent only moves forward: a rerun of an older run never rolls the catch-up and its policy back', async () => {
  const home = await mkdtemp(join(tmpdir(), 'hub-current-'));
  try {
    const source = join(home, 'src');
    await mkdir(join(source, 'ci'), { recursive: true });
    await writeFile(join(source, 'ci/policy.json'), '{}');
    const logs = [];
    installCurrent({ hubRef: 'v1.1.3', home, source, log: line => logs.push(line) });
    const link = join(home, '.local/share/mobile-deploy-hub/current');
    assert.equal(readlinkSync(link), 'releases/v1.1.3');
    assert.equal(installCurrent({ hubRef: 'v1.1.2', home, source, log: line => logs.push(line) }), null);
    assert.equal(readlinkSync(link), 'releases/v1.1.3');
    assert.match(logs.at(-1), /^HUB_CURRENT kept .* -> releases\/v1\.1\.3: newer than this run's v1\.1\.2$/);
    installCurrent({ hubRef: 'v1.2.0', home, source, log: () => {} });
    assert.equal(readlinkSync(link), 'releases/v1.2.0');
    // A host still on bring-up code (main-<sha>) takes the first release.
    symlinkSync('releases/main-42f3f4c', `${link}.tmp`);
    execFileSync('mv', ['-T', `${link}.tmp`, link]);
    installCurrent({ hubRef: 'v1.1.3', home, source, log: () => {} });
    assert.equal(readlinkSync(link), 'releases/v1.1.3');
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('the gate reads big-chungus\'s catch-up mode (no file is watch)', async () => {
  const home = await mkdtemp(join(tmpdir(), 'hub-mode-'));
  try {
    assert.equal(readCatchupMode({ env: {}, home }), 'watch');
    await mkdir(join(home, '.config/mobile-deploy-hub'), { recursive: true });
    await writeFile(join(home, '.config/mobile-deploy-hub/catchup.json'), '{"mode":"live"}');
    assert.equal(readCatchupMode({ env: {}, home }), 'live');
  } finally { await rm(home, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------------------------------- Quickdrop

test('Quickdrop never replaces a newer APK, and removes only older ones', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hub-quickdrop113-'));
  try {
    const dir = join(root, 'builds');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'tower-of-lost-things-0.2.3-5.apk'), 'newer');
    await writeFile(join(dir, 'tower-of-lost-things-0.2.1-3.apk'), 'older');
    const apk = join(root, 'App.apk');
    await writeFile(apk, 'rebuilt 0.2.2');
    const logs = [];
    const result = dropApk({ apk, dir, name: 'tower-of-lost-things-0.2.2-4.apk', slug: 'tower-of-lost-things', maxBytes: 120e6, log: line => logs.push(line) });
    assert.equal(result.status, 'skipped');
    assert.match(logs[0], /^HUB_QUICKDROP_SKIPPED tower-of-lost-things-0\.2\.2-4\.apk: Quickdrop already holds the newer tower-of-lost-things-0\.2\.3-5\.apk/);
    assert.deepEqual(readdirSync(dir).sort(), ['tower-of-lost-things-0.2.1-3.apk', 'tower-of-lost-things-0.2.3-5.apk'], 'a rerun of an older run changes nothing there');
    const newest = dropApk({ apk, dir, name: 'tower-of-lost-things-0.2.4-6.apk', slug: 'tower-of-lost-things', maxBytes: 120e6, log: () => {} });
    assert.deepEqual(newest.removed.sort(), ['tower-of-lost-things-0.2.1-3.apk', 'tower-of-lost-things-0.2.3-5.apk']);
    assert.deepEqual(readdirSync(dir), ['tower-of-lost-things-0.2.4-6.apk']);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Quickdrop is written only while big-chungus\'s Syncthing sees the S26 on the LAN', async () => {
  const id = devices.android.syncthing;
  const gui = { base: 'http://127.0.0.1:8384', key: 'k' };
  const answer = connections => async (url, options) => {
    assert.equal(url, 'http://127.0.0.1:8384/rest/system/connections');
    assert.equal(options.headers['X-API-Key'], 'k');
    return { ok: true, status: 200, json: async () => ({ connections }) };
  };
  const at = address => ({ [id]: { connected: true, address } });
  assert.equal((await s26OnLan({ deviceId: id, lanCidr: '192.168.1.0/24', gui, fetchImpl: answer(at('192.168.1.30:22000')) })).onLan, true);
  for (const [connections, why] of [[at('174.230.182.34:22000'), /outside the LAN/], [at('100.114.104.50:22000'), /outside the LAN/], [at('relay://1.2.3.4:22067'), /outside the LAN/], [{ [id]: { connected: false } }, /not connected/], [{}, /not connected/]]) {
    const where = await s26OnLan({ deviceId: id, lanCidr: '192.168.1.0/24', gui, fetchImpl: answer(connections) });
    assert.equal(where.onLan, false);
    assert.match(where.reason, why);
  }
  assert.equal((await s26OnLan({ deviceId: id, lanCidr: '192.168.1.0/24', gui: null })).onLan, false, 'no readable config defers');
  assert.equal((await s26OnLan({ deviceId: id, lanCidr: '192.168.1.0/24', gui, fetchImpl: async () => { throw new Error('ECONNREFUSED'); } })).onLan, false);
  const home = await mkdtemp(join(tmpdir(), 'hub-syncthing-'));
  try {
    await mkdir(join(home, '.local/state/syncthing'), { recursive: true });
    await writeFile(join(home, '.local/state/syncthing/config.xml'), '<configuration>\n<device id="X" name="phone"><address>dynamic</address></device>\n<gui enabled="true" tls="false"><address>0.0.0.0:8384</address><apikey>abc123</apikey></gui>\n</configuration>\n');
    assert.deepEqual(syncthingGui({ home }), { base: 'http://127.0.0.1:8384', key: 'abc123' }, 'the GUI block, not a device address');
  } finally { await rm(home, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------------------------------- resumed transfers

test('a broken IPA send resumes from its partial file and counts the bytes the failed attempt moved', () => {
  const calls = [];
  let rsyncTries = 0;
  const runner = (command, args) => {
    calls.push(`${command} ${args.join(' ')}`);
    if (command === 'ssh' && /stat -c %s/.test(args.at(-1))) return '30000000\n';
    if (command === 'rsync') {
      rsyncTries += 1;
      if (rsyncTries === 1) throw new Error('rsync IPA to big-chungus failed (exit 255)\nConnection closed');
      return 'Total bytes sent: 11,500,000\nTotal bytes received: 60\n';
    }
    return '';
  };
  const logs = [];
  const sent = sendIpa({ ipa: '/tmp/x.ipa', name: 'tower-of-lost-things-0.2.2-4.ipa', devices, env: { GITHUB_REPOSITORY: 'delorenj/tower-of-lost-things', GITHUB_RUN_ID: '42' }, runner, log: line => logs.push(line), sleep: () => {} });
  assert.deepEqual(sent, { out: 41_500_000, in: 60, failed: 30_000_000 });
  assert.ok(calls.filter(call => call.startsWith('rsync ')).every(call => / --partial-dir=\.rsync-partial /.test(call)), 'big-chungus keeps the partial file');
  assert.ok(logs.some(line => /^HUB_MAC_BYTES_RETRIED 30000000 bytes/.test(line)));
  assert.equal(progressBytes('  1,000   1%\r  25,000,000  60%  3.1MB/s\nrsync error: (code 255)'), 25_000_000);
});

test('the tree digest ignores rsync\'s partial folders, so a resumed handoff still matches tree_sha256', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hub-digest-'));
  try {
    await mkdir(join(root, 'a'), { recursive: true });
    await writeFile(join(root, 'a/file'), 'x');
    const before = await treeDigest(root);
    await mkdir(join(root, 'a/.rsync-partial'), { recursive: true });
    await writeFile(join(root, 'a/.rsync-partial/file'), 'half');
    assert.equal((await treeDigest(root)).sha256, before.sha256);
  } finally { await rm(root, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------------------------------- the Mac watchdog

test('the watchdog gives up a Mac job that no runner takes, never while the APK half is still publishing', () => {
  const now = Date.parse('2026-10-09T20:00:00Z');
  const ago = minutes => new Date(now - minutes * 60_000).toISOString();
  const offline = { status: 'offline', busy: false };
  const job = (name, status, conclusion = null, created = ago(30)) => ({ name: `deploy / ${name}`, status, conclusion, created_at: created });
  const limitMin = 15;
  assert.deepEqual(judgeRun({ jobs: [job('gate', 'completed', 'success'), job('preflight-ios', 'queued')], runner: offline, limitMin, now }), { job: 'preflight-ios', waited_min: 30, action: 'cancel', why: 'nothing was bumped yet' });
  assert.equal(judgeRun({ jobs: [job('preflight-ios', 'queued', null, ago(5))], runner: offline, limitMin, now }), null, 'under the limit');
  assert.equal(judgeRun({ jobs: [job('preflight-ios', 'queued')], runner: { status: 'online', busy: true }, limitMin, now }), null, 'a busy runner gets there');
  const iosJobs = [job('plan', 'completed', 'success'), job('android', 'completed', 'success'), job('ios', 'queued')];
  assert.equal(judgeRun({ jobs: iosJobs, runner: offline, limitMin, now }).action, 'wait', 'deliver-android has not run yet');
  assert.equal(judgeRun({ jobs: [...iosJobs, job('deliver-android', 'in_progress')], runner: offline, limitMin, now }).action, 'wait');
  assert.equal(judgeRun({ jobs: [...iosJobs, job('deliver-android', 'completed', 'success')], runner: offline, limitMin, now }).action, 'cancel');
  assert.equal(judgeRun({ jobs: [job('plan', 'completed', 'success'), job('android', 'completed', 'skipped'), job('ios', 'queued')], runner: offline, limitMin, now }).action, 'cancel', '--platform ios has no APK half');
  assert.equal(judgeRun({ jobs: [job('ios', 'in_progress')], runner: offline, limitMin, now }), null);
});

test('the watchdog cancels through the host\'s gh and logs why; an idle app costs one call', async () => {
  const now = Date.parse('2026-10-09T20:00:00Z');
  const calls = [];
  const gh = args => {
    calls.push(args.join(' '));
    if (/tower-of-lost-things\/actions\/workflows\/deploy\.yml\/runs\?status=in_progress/.test(args[1] ?? '')) return JSON.stringify([{ id: 501, run_attempt: 1 }]);
    if (/workflows\/deploy\.yml\/runs/.test(args[1] ?? '')) return '[]';
    if (/actions\/runners/.test(args[1] ?? '')) return JSON.stringify({ status: 'offline', busy: false });
    if (/runs\/501\/attempts\/1\/jobs/.test(args[1] ?? '')) return JSON.stringify([{ name: 'deploy / preflight-ios', status: 'queued', conclusion: null, created_at: '2026-10-09T19:30:00Z' }]);
    if (args[0] === 'run' && args[1] === 'cancel') return '';
    throw new Error(`unexpected gh ${args.join(' ')}`);
  };
  const logs = [];
  const actions = await watch({ policy, devices, gh, now, log: line => logs.push(line) });
  assert.deepEqual(actions.map(item => [item.repo, item.run, item.job]), [['delorenj/tower-of-lost-things', 501, 'preflight-ios']]);
  assert.ok(calls.includes('run cancel 501 --repo delorenj/tower-of-lost-things'));
  assert.match(logs[0], /^HUB_MACWATCH_CANCELLED delorenj\/tower-of-lost-things run 501: preflight-ios waited 30 min and carries-macbook-air is offline/);
  assert.equal(calls.filter(call => /green-in-between/.test(call)).length, 2, 'an app with no run in flight: two list calls, nothing else');
});

test('the watchdog units run every 2 minutes from the current release, and install.sh installs them', () => {
  const service = readFileSync(join(repoRoot, 'tools/catchup/units/mobile-deploy-hub-macwatch.service'), 'utf8');
  assert.match(service, /^ExecStart=%h\/\.local\/share\/mise\/installs\/node\/24\/bin\/node %h\/\.local\/share\/mobile-deploy-hub\/current\/tools\/ci\/macwatch\.mjs$/m);
  assert.match(readFileSync(join(repoRoot, 'tools/catchup/units/mobile-deploy-hub-macwatch.timer'), 'utf8'), /^OnCalendar=\*:1\/2$/m);
  assert.match(readFileSync(join(repoRoot, 'tools/catchup/units/install.sh'), 'utf8'), /enable --now mobile-deploy-hub-catchup\.timer mobile-deploy-hub-macwatch\.timer/);
});

// ---------------------------------------------------------------------------------------------------- the pages

test('device lines read plainly on a phone: the release first, plain reasons, no "0.2.5 (0.2.5)"', () => {
  const device = (status, extra = {}) => ({ name: 'S26', model: 'SM-S948U', status, since: '2026-10-09T20:00:00Z', by: status === 'installed' ? 'deploy' : null, reason: null, failures: 0, ...extra });
  assert.equal(deviceLine('android', { version: '0.2.2', code: 4, device: device('pending', { reason: "not on big-chungus's adb" }) }), "S26 0.2.2 (4): pending, installs when it is back (not on big-chungus's adb)");
  assert.equal(deviceLine('ios', { version: '0.2.5', build: '0.2.5', device: { ...device('pending', { reason: 'asleep or away' }), name: 'iPad' } }), 'iPad 0.2.5: pending, installs when it is back (asleep or away)');
  assert.equal(deviceLine('ios', { version: '0.2.2', build: '4', device: { ...device('installed'), name: 'iPad' } }), 'iPad 0.2.2 (4): installed by deploy');
  assert.equal(releaseLabel('0.2.5', '0.2.5'), '0.2.5');
  assert.equal(releaseLabel('0.2.2', 4), '0.2.2 (4)');
});

// ---------------------------------------------------------------------------------------------------- the Mac's checkout

import { randomBytes } from 'node:crypto';
import { checkoutRef, rememberCheckout } from './lib/git.mjs';

// actions/checkout leaves the Mac's persistent workspace on a detached HEAD with no ref, so a depth-1 fetch of the next
// commit has nothing to negotiate with and re-downloads the whole tree (Tower 21.7 MB per run on the hotspot,
// 2026-10-09). The ios job keeps refs/hub/last on its checkout; the next fetch then sends only what changed.
test('the ios job keeps a ref on its checkout, so the next depth-1 fetch on the Mac is a delta, not the whole tree', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hub-checkout-ref-'));
  try {
    const git = (cwd, ...args) => execFileSync('git', ['-c', 'protocol.file.allow=always', '-c', 'core.hooksPath=/dev/null', ...args], { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).trim();
    const origin = join(root, 'origin');
    await mkdir(origin);
    git(origin, 'init', '-q', '-b', 'main');
    // An asset that never changes (incompressible, like the app's art) and a file each commit changes.
    writeFileSync(join(origin, 'asset.bin'), randomBytes(300_000));
    writeFileSync(join(origin, 'version.txt'), '0.2.1\n');
    git(origin, 'add', '.');
    git(origin, 'commit', '-q', '-m', 'a');
    const first = git(origin, 'rev-parse', 'HEAD');
    writeFileSync(join(origin, 'version.txt'), '0.2.2\n');
    git(origin, 'commit', '-q', '-am', 'b');
    const second = git(origin, 'rev-parse', 'HEAD');
    const url = `file://${origin}`;
    // What actions/checkout does in a persistent workspace: a depth-1 fetch of the sha, then a detached checkout.
    const workspace = async (name, keep) => {
      const dir = join(root, name);
      await mkdir(dir);
      git(dir, 'init', '-q');
      git(dir, 'remote', 'add', 'origin', url);
      git(dir, 'fetch', '-q', '--no-tags', '--depth=1', 'origin', first);
      git(dir, 'checkout', '-q', '--force', first);
      const logs = [];
      if (keep) assert.equal(rememberCheckout({ cwd: dir, log: line => logs.push(line) }), first);
      const packs = () => readdirSync(join(dir, '.git/objects/pack')).filter(file => file.endsWith('.pack'));
      const before = new Set(packs());
      git(dir, '-c', 'fetch.unpackLimit=1', 'fetch', '-q', '--no-tags', '--prune', '--no-recurse-submodules', '--depth=1', 'origin', second);
      const fresh = packs().filter(file => !before.has(file));
      assert.equal(fresh.length, 1);
      return { bytes: lstatSync(join(dir, '.git/objects/pack', fresh[0])).size, logs, dir };
    };
    const detached = await workspace('detached', false);
    const kept = await workspace('kept', true);
    assert.ok(detached.bytes > 250_000, `without the ref the fetch re-sends the unchanged asset (${detached.bytes} bytes)`);
    assert.ok(kept.bytes < 20_000, `with the ref the fetch sends only the change (${kept.bytes} bytes)`);
    assert.match(kept.logs[0], new RegExp(`^HUB_CHECKOUT_KEPT ${checkoutRef} ${first.slice(0, 8)}: `));
    assert.equal(git(kept.dir, 'rev-parse', checkoutRef), first);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('keeping the checkout ref never fails the ios job, never hands git a credential, and runs before the build', () => {
  const logs = [];
  const seen = [];
  const runner = (command, args, options) => { seen.push(options.env); if (args[0] === 'update-ref') throw new Error('cannot lock ref'); return `${'a'.repeat(40)}\n`; };
  assert.equal(rememberCheckout({ cwd: '/nowhere', env: { PATH: '/bin', GH_TOKEN: 'x', MC_HOST_builds: 'y' }, runner, log: line => logs.push(line) }), null);
  assert.match(logs[0], /^::warning::could not keep refs\/hub\/last on this checkout \(cannot lock ref\)/);
  for (const env of seen) assert.deepEqual(Object.keys(env), ['PATH']);
  const source = readFileSync(join(repoRoot, 'tools/ci/commands/ios.mjs'), 'utf8');
  const body = source.slice(source.indexOf('export async function ios('));
  assert.ok(body.indexOf('rememberCheckout({ cwd: config.cwd') > 0 && body.indexOf('rememberCheckout({ cwd: config.cwd') < body.indexOf('applyBump(config, env)'), 'the ref is kept before the bump and the build');
});
