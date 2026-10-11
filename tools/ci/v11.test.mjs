// v1.1 tests (design K): the policy and the gate, the caller template, pending devices, downgrade guards, the
// build directory (keys, content types, cache headers, order, forward-only pointers, retention, the writer's keys),
// Quickdrop and the front door. Everything runs against fakes: no MinIO, no adb, no Mac.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { callerHash, checkCaller, normalizeCaller, templateFile } from './lib/caller.mjs';
import { parseConfig } from './lib/config.mjs';
import { loadPolicy, parsePolicy, policyFile, tagOf, tagOnlyOf } from './lib/policy.mjs';
import * as hub from './hub.mjs';
import { sampleLatest } from './test-fixtures.mjs';
import { gate } from './hub.mjs';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const template = readFileSync(templateFile, 'utf8');
const { policy } = loadPolicy();

async function script(path, body) {
  await writeFile(path, `#!/bin/sh\n${body}\n`);
  await chmod(path, 0o755);
}

// ---------------------------------------------------------------------------------------------------- the policy

test('the policy parses strictly: unknown keys, a "none" bump, hosted runners and a non-loopback writer are refused', () => {
  const text = readFileSync(policyFile, 'utf8');
  assert.equal(parsePolicy(text).schema, 1);
  const base = JSON.parse(text);
  const cases = {
    'unknown key': p => { p.extra = 1; },
    'none bump': p => { p.bump.levels.push('none'); },
    'default outside levels': p => { p.bump.default = 'none'; },
    'not strict': p => { p.event.strict = false; },
    'schema 1 manifests': p => { p.manifest_schema = [1, 2]; },
    'hosted runner': p => { p.runners.linux = ['ubuntu-latest']; },
    'public writer': p => { p.delivery.s3.write = 'https://s3.delo.sh'; },
    'bad accept hash': p => { p.callers.accept = ['abc']; },
    'unknown app key': p => { p.apps['delorenj/gruvato'].extra = true; },
    'lane typo': p => { p.apps['delorenj/gruvato'].lanes = ['android', 'ipad']; },
    'absent stops': p => { p.devices.absent = 'stop'; },
    'duplicate slug': p => { p.apps['delorenj/gruvato'].slug = 'green-in-between'; },
    'tag prefix not ending in v': p => { p.apps['AutomaticAI-io/james-brennan'].tag_prefix = 'navi-'; },
    'version mode typo': p => { p.apps['AutomaticAI-io/james-brennan'].version = 'tags'; },
  };
  for (const [name, change] of Object.entries(cases)) {
    const copy = structuredClone(base);
    change(copy);
    assert.throws(() => parsePolicy(JSON.stringify(copy)), /policy\.json/, name);
  }
});

test('the policy names the four apps in Jarad\'s order with their lanes, and the front door\'s train agrees', async () => {
  assert.deepEqual(Object.entries(policy.apps).map(([repo, app]) => [repo, app.slug, app.lanes.join('+')]), [
    ['delorenj/tower-of-lost-things', 'tower-of-lost-things', 'android+ios'],
    ['delorenj/green-in-between', 'green-in-between', 'android+ios'],
    ['delorenj/gruvato', 'gruvato', 'android+ios'],
    ['AutomaticAI-io/james-brennan', 'navi', 'android'],
  ]);
  // v1.2: Navi lives in a monorepo whose main takes only reviewed pull requests: its own tag prefix, tag-only bumps.
  const navi = policy.apps['AutomaticAI-io/james-brennan'];
  assert.deepEqual([tagOf(navi, '0.1.1'), tagOnlyOf(navi)], ['navi-v0.1.1', true]);
  assert.deepEqual([tagOf(policy.apps['delorenj/gruvato'], '0.2.4'), tagOnlyOf(policy.apps['delorenj/gruvato'])], ['v0.2.4', false]);
  const { train } = await import('../deploy.mjs');
  assert.deepEqual([...train], Object.keys(policy.apps));
  assert.equal(loadPolicy().short.length, 8);
});

// ---------------------------------------------------------------------------------------------------- the caller

test('the current template is an accepted caller, and comments, blank lines and spacing do not change its hash', () => {
  assert.ok(policy.callers.accept.includes(callerHash(template)), 'policy.json callers.accept must list the sha256 of templates/deploy.yml (normalized)');
  const restyled = `# Tower's own words\n${template.replace(/\n/g, '\r\n').replace(/^(\s+)(type): /gm, '$1$2:    ')}\n\n   \n`;
  assert.equal(callerHash(restyled), callerHash(template));
  assert.match(normalizeCaller('a:   https://x.example/y\n'), /^a: https:\/\/x\.example\/y\n$/, '`://` keeps its form');
});

test('every caller deviation is refused: strict false, runners, manifest, no REAL, @main, an old tag, on: push, narrowed permissions', () => {
  const env = { GITHUB_REPOSITORY: 'delorenj/gruvato', GITHUB_WORKFLOW_REF: 'delorenj/gruvato/.github/workflows/deploy.yml@refs/heads/main' };
  const check = text => checkCaller({ policy, env, read: () => text, template: () => template });
  assert.equal(check(template).ref, 'refs/heads/main');
  const deviations = {
    'strict false': template.replace('      metered: ${{ inputs.metered }}\n', '      metered: ${{ inputs.metered }}\n      strict: false\n'),
    'hosted runners': template.replace('      metered: ${{ inputs.metered }}\n', '      metered: ${{ inputs.metered }}\n      linux_runner: \'["ubuntu-latest"]\'\n'),
    'another manifest': template.replace('manifest: tools/ci/mobile-deploy.json', 'manifest: other.json'),
    'no REAL': template.replace("'Deploy REAL'", "'Deploy'"),
    '@main': template.replace('mobile-deploy.yml@v1', 'mobile-deploy.yml@main'),
    'old tag': template.replace('mobile-deploy.yml@v1', 'mobile-deploy.yml@v1.0.0'),
    'on push': template.replace('on:\n  workflow_dispatch:', 'on:\n  push:\n  workflow_dispatch:'),
    'narrowed permissions': template.replace('  actions: read\n', ''),
  };
  for (const [name, text] of Object.entries(deviations)) {
    assert.notEqual(text, template, `${name}: the mutation applies`);
    assert.throws(() => check(text), /^Error: HUB_GATE_REFUSED caller: .*First difference/, name);
  }
  assert.throws(() => checkCaller({ policy, env: { ...env, GITHUB_WORKFLOW_REF: 'delorenj/gruvato/.github/workflows/sneaky.yml@refs/heads/main' }, read: () => template }), /HUB_GATE_REFUSED caller: .*only delorenj\/gruvato\/\.github\/workflows\/deploy\.yml/);
});

// ---------------------------------------------------------------------------------------------------- the gate

// Tower's pins, as policy.json carries them: the gate, plan and deliver hold a manifest and an APK to these.
const towerPin = policy.apps['delorenj/tower-of-lost-things'];
const towerPackage = towerPin.android.package;
const towerSigner = towerPin.android.signer_sha256;

function towerManifest(extra = {}) {
  return {
    schema: 2,
    project: { slug: 'tower-of-lost-things', name: 'Tower of Lost Things' },
    version: { read: 'node version.mjs', bump: 'node version.mjs bump' },
    android: { package: towerPackage, export: 'true', artifact: 'artifacts/App.apk', signer_sha256: towerSigner },
    ios: { bundle: towerPin.ios.bundle, device: 'true', device_artifact: 'App.xcarchive' },
    ...extra,
  };
}

const peer = (curAddr, online = true) => ({ Peer: { k: { DNSName: 'carries-macbook-air.burro-salmon.ts.net.', HostName: 'Carrie’s MacBook Air', Online: online, CurAddr: curAddr, Relay: 'nyc' } } });
const fakeS3 = () => ({ writes: [], putText(text, key, options) { this.writes.push({ op: 'put', key, text, options }); }, put(file, key, options) { this.writes.push({ op: 'put', key, file, options }); }, remove(key) { this.writes.push({ op: 'rm', key }); }, list() { return []; } });
const notFound = async () => ({ status: 404, ok: false, text: async () => '' });
const serve = (text, only = null) => async url => (only && !String(url).includes(only) ? { status: 404, ok: false, text: async () => '' } : { status: 200, ok: true, text: async () => text });
const noPhone = () => ({ startServer() {}, devices: () => [], prop() { throw new Error('offline'); } });

async function gateFixture({ manifest = towerManifest(), caller = template, repo = 'delorenj/tower-of-lost-things' } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'hub-gate-'));
  const app = join(root, 'app');
  await mkdir(join(app, '.github/workflows'), { recursive: true });
  await mkdir(join(app, 'tools/ci'), { recursive: true });
  await writeFile(join(app, '.github/workflows/deploy.yml'), caller);
  await writeFile(join(app, 'tools/ci/mobile-deploy.json'), typeof manifest === 'string' ? manifest : JSON.stringify(manifest));
  const output = join(root, 'output');
  await writeFile(output, '');
  const env = {
    PATH: process.env.PATH, HOME: root, GITHUB_REPOSITORY: repo, GITHUB_WORKFLOW_REF: `${repo}/.github/workflows/deploy.yml@refs/heads/main`,
    GITHUB_REF: 'refs/heads/main', GITHUB_RUN_ID: '555', GITHUB_OUTPUT: output, HUB_REF: 'v1.1.0', HUB_LOCK_DIR: join(root, 'locks'),
  };
  const configure = (extra = [], more = {}) => ({ ...parseConfig(['gate', '--manifest', 'tools/ci/mobile-deploy.json', '--out', join(root, 'out'), ...extra], { ...env, ...more }), cwd: app });
  const s3 = fakeS3();
  const logs = [];
  const deps = (more = {}) => ({ env, home: root, fetchImpl: notFound, s3Factory: async () => s3, tailscale: () => peer('76.98.73.87:11349'), macProbe: () => ({ runner: 'alive', catchup: 'live' }), runnerStatus: () => ({ status: 'online', busy: false }), adbFactory: noPhone, log: line => logs.push(line), ...more });
  const outputs = () => Object.fromEntries(readFileSync(output, 'utf8').trim().split('\n').filter(Boolean).map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
  return { root, app, env, configure, s3, logs, deps, outputs, cleanup: () => rm(root, { recursive: true, force: true }) };
}

test('the gate passes a well-formed run and reads the state of things: metered Mac, away S26, S3 probe put and removed', async () => {
  const f = await gateFixture();
  try {
    const result = await gate(f.configure(), f.deps());
    assert.deepEqual([result.ios_lane, result.mac_link, result.metered, result.slug, result.bundle], ['run', 'metered', true, 'tower-of-lost-things', towerPin.ios.bundle]);
    assert.ok(f.logs.some(line => /^HUB_CATCHUP_MODE big-chungus=watch mac=live$/.test(line)), 'the gate reads the catch-up mode on both hosts');
    assert.ok(f.logs.some(line => /^HUB_POLICY sha256=[0-9a-f]{8}$/.test(line)), f.logs.join('\n'));
    assert.ok(f.logs.some(line => /^HUB_MAC_LINK metered peer=carries-macbook-air runner=carries-macbook-air addr=76\.98\.73\.87/.test(line)), 'the gate checks this app\'s own Mac runner');
    assert.ok(f.logs.some(line => /^HUB_GATE ok policy=[0-9a-f]{8} mac=metered s26=away s3=ok/.test(line)), f.logs.join('\n'));
    assert.deepEqual(f.s3.writes.map(write => [write.op, write.key]), [['put', '.probe/555'], ['rm', '.probe/555']], 'the probe leaves nothing behind');
    assert.equal(f.outputs().ios_lane, 'run');
    const receipt = JSON.parse(readFileSync(join(f.root, 'out/gate/hub-receipt-gate.json'), 'utf8'));
    assert.equal(receipt.policy, loadPolicy().sha256, 'every receipt records the full policy digest');
  } finally { await f.cleanup(); }
});

test('the gate decides the iPad lane: home runs it, offline skips it, a metered link over budget defers it unless allowed', async () => {
  const f = await gateFixture();
  try {
    assert.equal((await gate(f.configure(), f.deps({ tailscale: () => peer('192.168.1.23:41641') }))).mac_link, 'home');
    assert.equal((await gate(f.configure(), f.deps({ tailscale: () => peer('', false) }))).ios_lane, 'skip-offline');
    assert.equal((await gate(f.configure(), f.deps({ macProbe: () => ({ runner: 'missing', catchup: 'live' }) }))).ios_lane, 'skip-offline', 'no Runner.Listener of this app\'s own runner on the Mac');
    assert.equal((await gate(f.configure(), f.deps({ runnerStatus: () => ({ status: 'offline', busy: false }) }))).ios_lane, 'skip-offline', 'GitHub shows this app\'s Mac runner offline');
    assert.equal((await gate(f.configure(), f.deps({ macProbe: () => null }))).ios_lane, 'skip-offline', 'off the LAN, an ssh with no answer is a Mac that is gone');
    assert.equal((await gate(f.configure(), f.deps({ macProbe: () => null, tailscale: () => peer('192.168.1.23:41641') }))).ios_lane, 'run', 'on the LAN, a failed ssh alone does not skip the iPad');
    const heavy = JSON.stringify(sampleLatest({ mac_bytes: 400 * 1024 * 1024 }));
    assert.equal((await gate(f.configure(), f.deps({ fetchImpl: serve(heavy) }))).ios_lane, 'skip-metered');
    assert.ok(f.logs.some(line => /^HUB_IOS_DEFERRED /.test(line)));
    assert.equal((await gate(f.configure(['--metered', 'allow']), f.deps({ fetchImpl: serve(heavy) }))).ios_lane, 'run');
    assert.equal((await gate(f.configure(['--platform', 'android']), f.deps())).ios_lane, 'skip-platform');
  } finally { await f.cleanup(); }
});

test('an Android-only app never puts the Mac in scope, whatever platform the run asks for', async () => {
  const navi = policy.apps['AutomaticAI-io/james-brennan'];
  const manifest = {
    schema: 2,
    project: { slug: 'navi', name: 'Navi' },
    version: { read: 'node v.mjs', bump: 'node v.mjs bump' },
    android: { package: navi.android.package, export: 'true', artifact: 'a/App.apk', signer_sha256: navi.android.signer_sha256 },
  };
  const f = await gateFixture({ manifest, repo: 'AutomaticAI-io/james-brennan' });
  try {
    let asked = false;
    const result = await gate(f.configure(['--platform', 'both']), f.deps({ tailscale: () => { asked = true; return peer('192.168.1.23:41641'); } }));
    assert.deepEqual([result.ios_lane, result.slug], ['skip-platform', 'navi']);
    assert.equal(asked, false, 'the Mac is not even probed');
  } finally { await f.cleanup(); }
});

test('the gate refuses before anything is spent: schema 1, a dropped lane, another repo, strict false, runners, v2 inputs, a real run off a release', async () => {
  const cases = [
    [{ manifest: JSON.stringify({ schema: 1, version: 'x', android: {} }) }, [], /HUB_GATE_REFUSED manifest schema 1/],
    [{ manifest: (() => { const m = towerManifest(); delete m.ios; return m; })() }, [], /HUB_GATE_REFUSED lanes/],
    [{ manifest: towerManifest({ project: { slug: 'gruvato', name: 'G' } }) }, [], /HUB_GATE_REFUSED slug/],
    [{ repo: 'delorenj/someone-else' }, [], /HUB_GATE_REFUSED repo/],
    [{}, ['--strict', 'false'], /HUB_GATE_REFUSED inputs: strict/],
    [{}, ['--linux-runner', '["self-hosted","Linux","gpu"]'], /HUB_GATE_REFUSED inputs: linux_runner/],
    [{}, ['--channel', 'play'], /HUB_GATE_REFUSED inputs: android_channel/],
    [{}, ['--build', '12'], /HUB_GATE_REFUSED inputs: android_channel and build/],
    [{ caller: template.replace('@v1', '@main') }, [], /HUB_GATE_REFUSED caller/],
  ];
  for (const [fixture, flags, refusal] of cases) {
    const f = await gateFixture(fixture);
    try {
      await assert.rejects(gate(f.configure(flags), f.deps()), refusal, String(refusal));
      assert.equal(f.s3.writes.length, 0, 'refused before the probe');
    } finally { await f.cleanup(); }
  }
  const f = await gateFixture();
  try {
    await assert.rejects(gate(f.configure(['--dry-run', 'false']), f.deps({ env: { ...f.env, HUB_REF: 'main' } })), /HUB_GATE_REFUSED hub_ref main/);
    await assert.rejects(gate(f.configure(['--dry-run', 'false']), f.deps({ env: { ...f.env, GITHUB_REF: 'refs/heads/topic' } })), /HUB_GATE_REFUSED ref/);
    await assert.rejects(gate(f.configure(), f.deps({ s3Factory: async () => { throw new Error('op read failed'); } })), /HUB_GATE_REFUSED s3: the build directory write probe failed/);
    await assert.rejects(gate(f.configure(), f.deps({ fetchImpl: serve('{"schema":9}') })), /HUB_GATE_REFUSED s3: .*latest\.json/);
  } finally { await f.cleanup(); }
});

test('the v2 path is gone: no ios-upload command, no v2 exports, no schema 1 lane code', () => {
  for (const name of ['iosUpload', 'planV2', 'androidV2', 'iosExportV2', 'parseVersion', 'tagVersion']) assert.equal(hub[name], undefined, name);
  assert.throws(() => parseConfig(['ios-upload'], {}), /Usage/);
  const sources = readdirSync(join(repoRoot, 'tools/ci/commands')).map(name => readFileSync(join(repoRoot, 'tools/ci/commands', name), 'utf8')).join('\n');
  assert.doesNotMatch(sources, /schema === 1|manifest\.schema === 1/);
});


// ---------------------------------------------------------------------------------------------------- the build directory

import { createS3, jobWriter, mcEnvironment, pruneVersions } from './lib/s3.mjs';
import { dropApk } from './lib/quickdrop.mjs';
import { apkKey, ipaKey, parseLatest } from './lib/latest.mjs';
import { deliver, mergeLatest } from './hub.mjs';
import { deployTrain, dispatchArguments, parseArguments } from '../deploy.mjs';

const secret = 'S3cr3t-writer-key-0123456789';
const credentials = { access: 'mobile-deploy-hub', secret };

test('the writer\'s keys reach only the mc child\'s environment: never argv, never a log, never another credential', () => {
  const calls = [];
  const runner = (command, args, options) => { calls.push({ command, args, env: options.env }); return { ok: true, status: 0, stdout: '', stderr: '' }; };
  const s3 = createS3({ policy, credentials, env: { PATH: '/bin', GH_TOKEN: 'gh-secret', MC_HOST_other: 'http://x:y@z' }, runner });
  s3.putText('{}', 'tower-of-lost-things/latest.json');
  s3.remove('tower-of-lost-things/inflight.json');
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(call.command, 'mc');
    assert.ok(!call.args.join(' ').includes(secret), 'the secret is never in argv');
    assert.equal(call.env.MC_HOST_builds, `http://mobile-deploy-hub:${secret}@127.0.0.1:9012`);
    assert.equal(call.env.GH_TOKEN, undefined);
    assert.equal(call.env.MC_HOST_other, undefined);
  }
  assert.deepEqual(calls[0].args.slice(0, 5), ['--quiet', '--no-color', '--disable-pager', 'cp', '--attr']);
  assert.equal(calls[0].args[5], 'Content-Type="application/json";Cache-Control="no-cache"');
  assert.match(calls[0].args.at(-1), /^builds\/builds\/tower-of-lost-things\/latest\.json$/);
  const failing = createS3({ policy, credentials, env: {}, runner: () => ({ ok: false, status: 1, stdout: '', stderr: `mc: <ERROR> http://mobile-deploy-hub:${secret}@127.0.0.1:9012 refused` }) });
  assert.throws(() => failing.remove('x/y.json'), error => !error.message.includes(secret) && /<redacted>/.test(error.message));
  assert.throws(() => mcEnvironment({}, credentials, 'https://s3.delo.sh'), /loopback only/);
});

// A staged APK and IPA as the lanes leave them, with fake build tools that read the fake APK.
async function deliverFixture({ iosSent = true, iosStatus = 'pending', androidStatus = 'pending' } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'hub-deliver-'));
  const app = join(root, 'app');
  const out = join(root, 'out');
  const sdk = join(root, 'sdk/build-tools/35.0.0');
  await Promise.all([app, out, sdk].map(dir => mkdir(dir, { recursive: true })));
  await writeFile(join(app, 'mobile-deploy.json'), JSON.stringify(towerManifest()));
  await script(join(sdk, 'apksigner'), `echo "Signer #1 certificate SHA-256 digest: ${towerSigner}"`);
  await script(join(sdk, 'aapt2'), 'set -- $(cat "$3"); echo "package: name=\'$1\' versionCode=\'$3\' versionName=\'$2\'"');
  const staging = join(root, '.cache/mobile-deploy-hub/staging/delorenj-tower-of-lost-things/777');
  await mkdir(join(staging, 'android'), { recursive: true });
  await mkdir(join(staging, 'ios'), { recursive: true });
  const apkName = 'tower-of-lost-things-0.2.2-5.apk';
  await writeFile(join(staging, 'android', apkName), `${towerPackage} 0.2.2 5`);
  const sha = text => execFileSync('sha256sum', [], { input: text }).toString().slice(0, 64);
  const apkSha = sha(`${towerPackage} 0.2.2 5`);
  const ipaName = 'tower-of-lost-things-0.2.2-5.ipa';
  if (iosSent) await writeFile(join(staging, 'ios', ipaName), 'ipa bytes');
  const receipts = join(out, 'receipts');
  await mkdir(receipts, { recursive: true });
  await writeFile(join(receipts, 'hub-receipt-android.json'), JSON.stringify({ lane: 'android', outcome: 'success', version: '0.2.2', staged: { name: apkName, bytes: 22, sha256: apkSha }, quickdrop: { status: 'written', name: apkName }, delivery: { platform: 'android', status: androidStatus, reason: androidStatus === 'pending' ? "not on big-chungus's adb" : null, sha256: apkSha } }));
  await writeFile(join(receipts, 'hub-receipt-ios.json'), JSON.stringify({ lane: 'ios', outcome: 'success', version: '0.2.2', ipa: { verified: true, sha256: sha('ipa bytes'), bytes: 9, build: '5', sent: iosSent, staged_name: iosSent ? ipaName : null }, delivery: { platform: 'ios', status: iosStatus, reason: iosStatus === 'pending' ? 'asleep or away' : null }, mac_bytes: { in: 1000, out: 9 } }));
  const env = { PATH: process.env.PATH, ANDROID_HOME: join(root, 'sdk'), JAVA_HOME: join(root, 'java'), GITHUB_REPOSITORY: 'delorenj/tower-of-lost-things', GITHUB_RUN_ID: '777', GITHUB_RUN_ATTEMPT: '1', HUB_REF: 'v1.1.0', HUB_LOCK_DIR: join(root, 'locks'), HUB_NEEDS: JSON.stringify({ plan: { result: 'success' }, android: { result: 'success' }, ios: { result: 'success' } }) };
  const configure = (extra = []) => ({ ...parseConfig(['deliver', '--manifest', 'mobile-deploy.json', '--out', out, '--version', '0.2.2', '--android-code', '5', '--build-sha', 'b'.repeat(40), ...extra], env), cwd: app });
  const s3 = fakeS3();
  const pages = { writes: [] };
  const logs = [];
  return { root, staging, env, configure, s3, logs, apkSha, pages, cleanup: () => rm(root, { recursive: true, force: true }) };
}

test('deliver publishes in order: versioned objects, manifest.plist, latest.json, then the pages; then retention and inflight', async () => {
  const f = await deliverFixture();
  try {
    const inflight = JSON.stringify({ version: '0.2.2', run: { repo: 'delorenj/tower-of-lost-things', id: '777', attempt: 1, url: null }, started_at: '2026-10-09T20:00:00Z', platforms: ['android', 'ios'] });
    const result = await deliver(f.configure(['--dry-run', 'false']), { env: f.env, home: f.root, fetchImpl: serve(inflight, 'tower-of-lost-things/inflight.json'), s3Factory: async () => f.s3, log: line => f.logs.push(line) });
    const keys = f.s3.writes.map(write => `${write.op} ${write.key}`);
    const at = key => keys.indexOf(key);
    assert.ok(at('put tower-of-lost-things/0.2.2/tower-of-lost-things-0.2.2-5.apk') >= 0, keys.join('\n'));
    assert.ok(at('put tower-of-lost-things/0.2.2/tower-of-lost-things-0.2.2-5.ipa') >= 0);
    assert.ok(at('put tower-of-lost-things/0.2.2/tower-of-lost-things-0.2.2-5.ipa') < at('put tower-of-lost-things/ios/manifest.plist'));
    assert.ok(at('put tower-of-lost-things/ios/manifest.plist') < at('put tower-of-lost-things/latest.json'));
    assert.ok(at('put tower-of-lost-things/latest.json') < at('put tower-of-lost-things/index.html'));
    assert.ok(at('put tower-of-lost-things/index.html') < at('put index.html'));
    assert.equal(keys.at(-1), 'rm tower-of-lost-things/inflight.json');
    const latest = parseLatest(f.s3.writes.find(write => write.key === 'tower-of-lost-things/latest.json').text, { base: policy.delivery.s3.public });
    assert.deepEqual([latest.android.device.status, latest.ios.device.status, latest.mac_bytes], ['pending', 'pending', 1009]);
    assert.equal(latest.android.quickdrop, 'builds/tower-of-lost-things-0.2.2-5.apk');
    assert.equal(latest.ios.install_url, 'itms-services://?action=download-manifest&url=https://s3.delo.sh/builds/tower-of-lost-things/ios/manifest.plist');
    assert.match(f.s3.writes.find(write => write.key === 'tower-of-lost-things/ios/manifest.plist').text, /<string>software-package<\/string>[\s\S]*tower-of-lost-things-0\.2\.2-5\.ipa/);
    assert.deepEqual(result.published.apk, latest.android.url);
    assert.ok(f.logs.some(line => /^HUB_PUBLISHED tower-of-lost-things 0\.2\.2/.test(line)), f.logs.join('\n'));
  } finally { await f.cleanup(); }
});

test('a dry run deliver checks and renders everything and writes nothing', async () => {
  const f = await deliverFixture({ iosSent: false });
  try {
    const result = await deliver(f.configure(), { env: f.env, home: f.root, fetchImpl: notFound, s3Factory: async () => { throw new Error('a dry run must not ask for the writer'); }, log: line => f.logs.push(line) });
    assert.equal(result.dryRun, true);
    assert.equal(f.s3.writes.length, 0);
    assert.ok(f.logs.some(line => /^HUB_PUBLISH_DRY_RUN would publish .*tower-of-lost-things-0\.2\.2-5\.apk.*nothing was written$/.test(line)), f.logs.join('\n'));
    assert.equal(existsSync(join(f.staging, 'android')) || existsSync(join(f.staging, 'ios')), false, 'a dry run\'s staging is removed (each deliver job removes its own half)');
    assert.ok(result.published.ota, 'the would-be links reach the checked event');
  } finally { await f.cleanup(); }
});

test('the pointer only moves forward: an older run keeps the newer block and uploads none of its bytes', async () => {
  const f = await deliverFixture();
  try {
    const newer = sampleLatest({ version: '0.2.3' });
    newer.android = { ...newer.android, version: '0.2.3', code: 9, key: apkKey('tower-of-lost-things', '0.2.3', 9), url: `https://s3.delo.sh/builds/${apkKey('tower-of-lost-things', '0.2.3', 9)}`, run: { ...newer.run, id: '900' } };
    newer.ios = { ...newer.ios, version: '0.2.3', build: '9', key: ipaKey('tower-of-lost-things', '0.2.3', '9'), url: `https://s3.delo.sh/builds/${ipaKey('tower-of-lost-things', '0.2.3', '9')}`, run: { ...newer.run, id: '900' } };
    await deliver(f.configure(['--dry-run', 'false']), { env: f.env, home: f.root, fetchImpl: serve(JSON.stringify(newer), 'tower-of-lost-things/latest.json'), s3Factory: async () => f.s3, log: line => f.logs.push(line) });
    assert.ok(f.logs.filter(line => /^HUB_POINTER kept 0\.2\.3/.test(line)).length === 2, f.logs.join('\n'));
    assert.ok(!f.s3.writes.some(write => /0\.2\.2-5\.(apk|ipa)$/.test(write.key)), 'no older bytes uploaded');
    assert.ok(!f.s3.writes.some(write => /latest\.json$|index\.html$/.test(write.key)), 'no block moved: latest.json, its top level and the pages stay as they are');
    assert.ok(f.logs.some(line => /^HUB_PUBLISHED nothing for android and ios: the pointer stays/.test(line)), f.logs.join('\n'));
  } finally { await f.cleanup(); }
});

test('an iPad installed over a metered link has no over-the-air copy, and its manifest.plist goes away', async () => {
  const f = await deliverFixture({ iosSent: false, iosStatus: 'installed' });
  try {
    await deliver(f.configure(['--dry-run', 'false']), { env: f.env, home: f.root, fetchImpl: notFound, s3Factory: async () => f.s3, log: () => {} });
    const written = parseLatest(f.s3.writes.find(write => write.key === 'tower-of-lost-things/latest.json').text);
    assert.deepEqual([written.ios.key, written.ios.install_url, written.ios.device.status, written.ios.device.by], [null, null, 'installed', 'deploy']);
    assert.ok(f.s3.writes.some(write => write.op === 'rm' && write.key === 'tower-of-lost-things/ios/manifest.plist'));
  } finally { await f.cleanup(); }
});

test('a rerun of the same release keeps a device state the run did not see (the catch-up may have installed it)', () => {
  const current = sampleLatest();
  current.android.device = { ...current.android.device, status: 'installed', by: 'catch-up', reason: null };
  const next = structuredClone(sampleLatest().android);
  const merged = mergeLatest({ current, candidates: { android: next, ios: null }, top: { slug: current.slug, name: current.name, version: '0.2.2', commit: current.commit, hub_ref: 'v1.1.0', run: current.run, correlation: current.correlation }, stamp: '2026-10-09T21:00:00Z', log: () => {} });
  assert.deepEqual([merged.pointer.android, merged.latest.android.device.status, merged.latest.android.device.by], ['replaced', 'installed', 'catch-up']);
});

test('retention: five APK versions, the newest IPA only, and nothing latest.json names', () => {
  const objects = [];
  for (let patch = 1; patch <= 7; patch += 1) {
    objects.push({ key: `gruvato/0.2.${patch}/gruvato-0.2.${patch}-${2000 + patch}.apk`, size: 1 }, { key: `gruvato/0.2.${patch}/receipt.json`, size: 1 });
    objects.push({ key: `gruvato/0.2.${patch}/gruvato-0.2.${patch}-0.2.${patch}.ipa`, size: 1 });
  }
  objects.push({ key: 'gruvato/latest.json', size: 1 }, { key: 'gruvato/ios/manifest.plist', size: 1 });
  const removed = [];
  const s3 = { list: () => objects, remove: key => removed.push(key) };
  const latest = { android: { version: '0.2.7', key: 'gruvato/0.2.7/gruvato-0.2.7-2007.apk' }, ios: { version: '0.2.7', key: 'gruvato/0.2.7/gruvato-0.2.7-0.2.7.ipa' } };
  pruneVersions({ s3, policy, slug: 'gruvato', latest });
  const left = objects.map(item => item.key).filter(key => !removed.includes(key));
  assert.deepEqual(left.filter(key => key.endsWith('.apk')).map(key => key.split('/')[1]), ['0.2.3', '0.2.4', '0.2.5', '0.2.6', '0.2.7']);
  assert.deepEqual(left.filter(key => key.endsWith('.ipa')), ['gruvato/0.2.7/gruvato-0.2.7-0.2.7.ipa'], 'an old IPA URL is a 404: OTA can never offer a downgrade');
  assert.ok(left.includes('gruvato/latest.json') && left.includes('gruvato/ios/manifest.plist'));
  assert.ok(!left.some(key => /0\.2\.[12]\//.test(key)), 'old version folders go entirely');
});

// ---------------------------------------------------------------------------------------------------- Quickdrop

test('Quickdrop: a regular file through Syncthing\'s temporary name, one per app, and a size cap', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hub-quickdrop-'));
  try {
    const dir = join(root, 'quickdrop/builds');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'tower-of-lost-things-0.2.1-4.apk'), 'old');
    await writeFile(join(dir, 'green-in-between-0.0.20-20.apk'), 'other app');
    await writeFile(join(root, 'Jarads.apk'), 'his');
    const apk = join(root, 'App.apk');
    await writeFile(apk, 'new apk bytes');
    const logs = [];
    const dropped = dropApk({ apk, dir, name: 'tower-of-lost-things-0.2.2-5.apk', slug: 'tower-of-lost-things', maxBytes: 120e6, log: line => logs.push(line) });
    assert.equal(dropped.status, 'written');
    const info = lstatSync(join(dir, 'tower-of-lost-things-0.2.2-5.apk'));
    assert.ok(info.isFile() && !info.isSymbolicLink());
    assert.deepEqual(readdirSync(dir).sort(), ['green-in-between-0.0.20-20.apk', 'tower-of-lost-things-0.2.2-5.apk'], 'the older Tower APK is gone, other apps stay, no temporary file is left');
    assert.match(logs[0], /^HUB_QUICKDROP tower-of-lost-things-0\.2\.2-5\.apk 13 bytes; removed tower-of-lost-things-0\.2\.1-4\.apk$/);
    const big = dropApk({ apk, dir, name: 'gruvato-0.2.5-2005.apk', slug: 'gruvato', maxBytes: 5, log: line => logs.push(line) });
    assert.equal(big.status, 'skipped');
    assert.match(logs.at(-1), /^HUB_QUICKDROP_SKIPPED 13 bytes/);
    assert.equal(existsSync(join(dir, 'gruvato-0.2.5-2005.apk')), false);
    assert.throws(() => dropApk({ apk, dir, name: '../evil.apk', slug: 'gruvato', maxBytes: 1e9 }), /not a hub APK name/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------------------------------- the front door

import * as frontDoor from '../deploy.mjs';

function fakeGh({ red = false, conclusion = () => 0, repo = 'delorenj/gruvato' } = {}) {
  const calls = [];
  let dispatched = 0;
  const runs = () => [
    ...(red ? [{ databaseId: 10, headSha: 'a'.repeat(40), event: 'workflow_dispatch', status: 'completed', conclusion: 'failure', url: 'https://x/10', displayTitle: 'Deploy REAL both bump=patch', createdAt: red === true ? '2026-10-08T12:00:00Z' : red }] : []),
    ...(dispatched > 0 ? [{ databaseId: 20 + dispatched, headSha: 'a'.repeat(40), event: 'workflow_dispatch', status: 'in_progress', url: `https://x/${20 + dispatched}`, displayTitle: 'Deploy (dry run)' }] : []),
  ];
  const gh = (args, options = {}) => {
    calls.push(args.join(' '));
    if (args[0] === 'run' && args[1] === 'list') return JSON.stringify(runs());
    if (args[0] === 'repo') return `${repo}\n`;
    if (args[0] === 'api' && args.some(arg => /commits\/main$/.test(arg))) return `${'a'.repeat(40)}\n`;
    if (args[0] === 'api' && args.some(arg => /actions\/runners$/.test(arg))) return JSON.stringify([{ name: 'mac', status: 'offline', labels: ['self-hosted', 'macOS'] }]);
    if (args[0] === 'api' && args.includes('Accept: application/vnd.github.raw')) {
      if (args.some(arg => /deploy\.yml/.test(arg))) return '    with:\n      manifest: tools/ci/mobile-deploy.json\n';
      return JSON.stringify({ schema: 2, android: {}, ios: {} });
    }
    if (args[0] === 'workflow' && args[1] === 'run') { dispatched += 1; return ''; }
    if (args[0] === 'run' && args[1] === 'watch') return options.inherit ? conclusion(args) : '';
    return '';
  };
  return { gh, calls };
}

test('the front door: no iPad proof ledger, --metered passes through, and the train is Jarad\'s order', () => {
  for (const gone of ['ledgerPath', 'readLedger', 'recordProof', 'proofFor']) assert.equal(frontDoor[gone], undefined, gone);
  const options = parseArguments(['--metered', 'allow', '--dry-run', 'false']);
  assert.deepEqual([options.metered, options.dryRun, options.mode], ['allow', false, 'deploy']);
  assert.ok(dispatchArguments(options).includes('metered=allow'));
  assert.throws(() => parseArguments(['--metered', 'sure']), /metered must be one of auto, allow/);
  assert.equal(parseArguments(['train']).mode, 'train');
  assert.throws(() => parseArguments(['train', '--repo', 'delorenj/gruvato']), /drop --repo/);
});

test('a red last real run earns an offer of the rerun, never a refusal; an offline Mac and an away S26 earn notes', async () => {
  const { gh, calls } = fakeGh({ red: true });
  const logs = [];
  const now = () => Date.parse('2026-10-09T12:00:00Z');
  const result = await frontDoor.deploy(parseArguments(['--dry-run', 'false', '--repo', 'delorenj/gruvato']), { gh, git: () => 'main\n', adb: args => (args[0] === 'devices' ? 'List of devices attached\n' : ''), host: 'big-chungus', prompt: null, log: line => logs.push(line), sleep: async () => {}, timeoutMs: 5000, pollMs: 1, now });
  assert.equal(result.status, 0);
  assert.ok(logs.some(line => /^DEPLOY_LAST_REAL_RED 10 failure .*gh run rerun 10 --failed/.test(line)), logs.join('\n'));
  // Past the 7-day window its receipts and staging are gone, so a rerun would publish nothing: no offer.
  const old = fakeGh({ red: '2026-09-30T12:00:00Z' });
  const oldLogs = [];
  let asked = false;
  await frontDoor.deploy(parseArguments(['--dry-run', 'false', '--repo', 'delorenj/gruvato']), { gh: old.gh, git: () => 'main\n', prompt: async () => { asked = true; return 'y'; }, log: line => oldLogs.push(line), sleep: async () => {}, timeoutMs: 5000, pollMs: 1, now });
  assert.equal(asked, false, 'no rerun offered for a run older than 7 days');
  assert.ok(oldLogs.some(line => /^DEPLOY_LAST_REAL_RED 10 failure .*9 days old, past the 7-day window/.test(line)), oldLogs.join('\n'));
  assert.ok(old.calls.some(call => /^workflow run deploy\.yml/.test(call)), 'a new version is dispatched instead');
  assert.ok(logs.some(line => /^DEPLOY_NOTE the iPad lane will be skipped: mac offline/.test(line)));
  assert.ok(logs.some(line => /^DEPLOY_NOTE the S26 is away; it will be pending/.test(line)));
  assert.ok(calls.some(call => /^workflow run deploy\.yml --ref main --repo delorenj\/gruvato .*-f metered=auto$/.test(call)), calls.join('\n'));
}, { timeout: 60_000 });

test('the train dispatches Tower, then Green In Between, then Gruvato, and stops at the first red run', async () => {
  const seen = [];
  const { gh } = fakeGh({ conclusion: () => (seen.length === 2 ? 1 : 0) });
  const logged = [];
  const recordingGh = (args, options) => { if (args[0] === 'workflow') seen.push(args[args.indexOf('--repo') + 1]); return gh(args, options); };
  const result = await deployTrain(parseArguments(['train']), { gh: recordingGh, git: () => 'main\n', log: line => logged.push(line), sleep: async () => {}, timeoutMs: 5000, pollMs: 1 });
  assert.deepEqual(seen, ['delorenj/tower-of-lost-things', 'delorenj/green-in-between']);
  assert.equal(result.stopped, 'delorenj/green-in-between');
  assert.equal(result.status, 1);
  assert.ok(logged.some(line => /^DEPLOY_TRAIN stopped at delorenj\/green-in-between/.test(line)));
});

// ---------------------------------------------------------------------------------------------------- conformance and release

import { checkApp, miseTasks, scriptsOf } from '../conformance.mjs';
import { flipInnerRefs } from '../release.mjs';

test('conformance: the template caller and a clean app pass; uploads, bumps, tags and announcements outside the hub fail', () => {
  const app = { slug: 'gruvato', lanes: ['android', 'ios'] };
  const manifest = JSON.stringify(towerManifest({ project: { slug: 'gruvato', name: 'Gruvato' } }));
  const files = {
    '.github/workflows/deploy.yml': template,
    'tools/ci/mobile-deploy.json': manifest,
    '.github/workflows/website.yml': 'jobs:\n  site:\n    runs-on: [self-hosted, Linux]\n',
    'mise.toml': '[tasks."android:build"]\nrun = "scripts/android/build.sh"\n[tasks."version"]\nrun = "\'{{config_root}}/.mise/scripts/versioning.sh\' current"\n[tasks."deploy:check"]\nrun = "node --test tools/ci/mobile-deploy.test.mjs"\n',
    'scripts/android/build.sh': 'pnpm tauri android build\n',
    'tools/ci/mobile-deploy.test.mjs': "assert.doesNotMatch(mise, /version:bump|bb-emit/)\n",
  };
  const open = extra => ({ read: path => { const all = { ...files, ...extra }; if (!(path in all)) throw Object.assign(new Error('404'), { code: 'ENOENT' }); return all[path]; }, list: () => Object.keys({ ...files, ...extra }).filter(path => path.startsWith('.github/workflows/')) });
  assert.deepEqual(checkApp({ repo: 'delorenj/gruvato', app, policy, ...open({}) }), []);
  const bad = checkApp({ repo: 'delorenj/gruvato', app, policy, ...open({
    '.github/workflows/deploy.yml': template.replace('@v1', '@main'),
    '.github/workflows/sideload.yml': 'steps:\n  - run: gh release create v1 app.apk\n',
    'mise.toml': `${files['mise.toml']}[tasks.build]\nrun = "scripts/release/bump-build-version.sh && pnpm build"\n[tasks.ship]\nrun = "bb-emit --type x"\n[tasks.tag]\nrun = "git tag -a v1.2.3 -m x"\n`,
    'scripts/release/bump-build-version.sh': 'git tag -a "$v"\n',
  }) });
  for (const expected of [/deploy\.yml: not an accepted copy/, /sideload\.yml: gh release create\/upload outside the hub/, /task build: the task would bump/, /task ship: the task would announce/, /task tag: the task would tag/]) {
    assert.ok(bad.some(problem => expected.test(problem)), `${expected}\n${bad.join('\n')}`);
  }
  assert.deepEqual(miseTasks('[tasks."a:b"]\nrun = "x"\n[env]\nX = 1\n[tasks.c]\nrun = "y"\n').map(task => task.name), ['a:b', 'c']);
  assert.deepEqual(scriptsOf('run = "scripts/a.sh && node tools/b.mjs && \'{{config_root}}/.mise/scripts/v.sh\' x"'), ['scripts/a.sh', 'tools/b.mjs', '.mise/scripts/v.sh']);
});

test('release flips every inner actions/hub ref to the exact tag in one edit', () => {
  const text = readFileSync(join(repoRoot, '.github/workflows/mobile-deploy.yml'), 'utf8');
  const flipped = flipInnerRefs(text, 'v1.2.3');
  assert.deepEqual([...new Set([...flipped.matchAll(/uses: delorenj\/mobile-deploy-hub\/actions\/hub@(\S+)/g)].map(match => match[1]))], ['v1.2.3']);
  assert.equal(flipped.split('\n').length, text.split('\n').length);
});

// v1.x never removes or retypes a caller input: callers pinned @v1 must keep working when v1 moves (D1).
test('the v1 caller surface is frozen: every workflow_call input keeps its name, type and default', () => {
  const workflow = readFileSync(join(repoRoot, '.github/workflows/mobile-deploy.yml'), 'utf8');
  const block = workflow.slice(workflow.indexOf('    inputs:\n'), workflow.indexOf('\npermissions:'));
  const inputs = [...block.matchAll(/^ {6}([\w]+):\n(?: {8}description: [^\n]*\n)? {8}type: (\w+)\n {8}default: ([^\n]*)$/gm)].map(match => `${match[1]}:${match[2]}=${match[3]}`);
  assert.deepEqual(inputs, [
    'manifest:string=mobile-deploy.json', 'platform:string=both', 'bump:string=patch', 'testflight:boolean=false', 'play:boolean=false',
    'dry_run:boolean=true', 'dry_handoff:boolean=false', 'strict:boolean=true', 'metered:string=auto', "linux_runner:string='[\"self-hosted\",\"Linux\"]'",
    "mac_runner:string='[\"self-hosted\",\"macOS\"]'", "wif_provider:string=''", "play_sa:string=''", 'android_channel:string=sideload', 'track:string=internal',
    'play_status:string=draft', "build:string=''",
  ]);
  for (const name of ['dry_run', 'bump', 'platform', 'testflight', 'play', 'dry_handoff', 'metered']) assert.match(template, new RegExp(`^ {6}${name}: \\$\\{\\{ inputs\\.${name} \\}\\}$`, 'm'), `the template passes ${name}`);
});

// ---------------------------------------------------------------------------------------------------- the delta handoff

import { receiveHandoff, retried, sendHandoffDelta, treeDigest } from './lib/handoff.mjs';

test('the Xcode handoff is a tree delta into the Mac cache, cloned per run, checked by tree_sha256 and packed back for the hook', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hub-handoff-'));
  try {
    const src = join(root, 'src');
    await mkdir(join(src, 'A.xcodeproj'), { recursive: true });
    await writeFile(join(src, 'A.xcodeproj/project.pbxproj'), 'pbx');
    await writeFile(join(src, 'A.pck'), 'pck bytes');
    const tgz = join(root, 'A-ipad.tgz');
    execFileSync('tar', ['-C', src, '-czf', tgz, '.']);
    const calls = [];
    const runner = (command, args) => {
      calls.push(`${command} ${args.join(' ')}`);
      if (command === 'tar') execFileSync('tar', args);
      return command === 'rsync' ? 'Total bytes sent: 1,234\nTotal bytes received: 56\n' : '';
    };
    const env = { GITHUB_REPOSITORY: 'delorenj/tower-of-lost-things', GITHUB_RUN_ID: '42' };
    const logs = [];
    const sent = await sendHandoffDelta({ host: 'hub-mac', base: 'Library/Caches/mobile-deploy-hub/handoff', cache: 'Library/Caches/mobile-deploy-hub/handoff-cache', archives: [{ name: 'A-ipad.tgz', tgz }], receipts: [], unpackInto: join(root, 'trees'), env, runner, log: line => logs.push(line) });
    assert.deepEqual(sent.mac_bytes, { in: 1234, out: 56 });
    assert.equal(sent.archives[0].mode, 'tree');
    assert.equal(sent.archives[0].tree_sha256, (await treeDigest(src)).sha256);
    assert.ok(calls.some(call => /^rsync --stats --info=progress2 --partial-dir=\.rsync-partial -e ssh .* -rlpt -z --checksum --delete .*\/A-ipad\.tree\/ hub-mac:Library\/Caches\/mobile-deploy-hub\/handoff-cache\/delorenj-tower-of-lost-things\/A-ipad\/$/.test(call)), calls.join('\n'));
    assert.ok(calls.some(call => /cp -cR 'Library\/Caches\/mobile-deploy-hub\/handoff-cache\/delorenj-tower-of-lost-things\/A-ipad' 'Library\/Caches\/mobile-deploy-hub\/handoff\/delorenj-tower-of-lost-things\/42\/A-ipad\.tree'/.test(call)), 'the run gets its own clone');
    assert.ok(logs.some(line => /^HUB_MAC_BYTES in=1234 out=56/.test(line)) && logs.some(line => /^HUB_HANDOFF_DELTA bytes=1290 A-ipad\.tgz=tree/.test(line)));

    // The Mac side: the run's clone checked against tree_sha256 and packed into the tarball the hook reads.
    const home = join(root, 'mac');
    const clone = join(home, 'Library/Caches/mobile-deploy-hub/handoff/delorenj-tower-of-lost-things/42/A-ipad.tree');
    await mkdir(clone, { recursive: true });
    execFileSync('cp', ['-R', `${src}/.`, clone]);
    const into = join(root, 'into');
    await receiveHandoff({ names: ['A-ipad.tgz'], expected: {}, archives: sent.archives, base: 'Library/Caches/mobile-deploy-hub/handoff', into, env, home, log: () => {} });
    assert.match(execFileSync('tar', ['-tzf', join(into, 'A-ipad.tgz')]).toString(), /A\.xcodeproj\/project\.pbxproj/);
    await writeFile(join(clone, 'A.pck'), 'other bytes');
    await assert.rejects(receiveHandoff({ names: ['A-ipad.tgz'], expected: {}, archives: sent.archives, base: 'Library/Caches/mobile-deploy-hub/handoff', into, env, home, log: () => {} }), /tree_sha256 .* the ios-export receipt says/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a connection step to the Mac is retried with growing waits; other errors fail at once', () => {
  let tries = 0;
  const waits = [];
  const sleep = ms => waits.push(ms);
  assert.equal(retried(() => { tries += 1; if (tries < 3) throw new Error('Connection timed out during banner exchange'); return 'ok'; }, { sleep }), 'ok');
  assert.deepEqual(waits, [15_000, 45_000]);
  let other = 0;
  assert.throws(() => retried(() => { other += 1; throw new Error('rsync: protocol mismatch'); }, { sleep }), /protocol mismatch/);
  assert.equal(other, 1, 'not a connection error: no retry');
  assert.throws(() => retried(() => { throw new Error('rsync to hub-mac failed (exit 255)'); }, { attempts: 2, sleep }), /exit 255/);
});

test('a Mac that stays unreachable fails the handoff without falling back to sending the tarball', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hub-handoff-down-'));
  try {
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'src/a'), 'a');
    const tgz = join(root, 'A-ipad.tgz');
    execFileSync('tar', ['-C', join(root, 'src'), '-czf', tgz, '.']);
    const calls = [];
    const runner = (command, args) => {
      calls.push(command);
      if (command === 'tar') { execFileSync('tar', args); return ''; }
      if (command === 'rsync') throw new Error('rsync A-ipad to hub-mac failed (exit 255)\nConnection closed by UNKNOWN port 65535');
      return '';
    };
    await assert.rejects(sendHandoffDelta({ host: 'hub-mac', base: 'b', cache: 'c', archives: [{ name: 'A-ipad.tgz', tgz }], unpackInto: join(root, 'trees'), env: { GITHUB_REPOSITORY: 'o/r', GITHUB_RUN_ID: '1' }, runner, log: () => {}, retryOptions: { sleep: () => {} } }), /stayed unreachable during the Xcode handoff.*Re-run failed jobs/);
    assert.equal(calls.filter(command => command === 'rsync').length, 4, 'four tries of the tree delta, no tarball fallback');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('the deploy jobs write the real bucket only inside a workflow job, or on purpose with HUB_S3_LOCAL=1', async () => {
  await assert.rejects(jobWriter(policy, {}), /only inside a workflow job/);
  await assert.rejects(gate(...await (async () => { const f = await gateFixture(); return [f.configure(), { ...f.deps(), s3Factory: null, env: { ...f.env, GITHUB_ACTIONS: '' } }]; })()), /HUB_GATE_REFUSED s3: .*only inside a workflow job/);
});
