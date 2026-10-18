import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { commands, credentialVariables, hookEnvironment, isCredentialVariable, jobControlFiles, parseConfig } from './lib/config.mjs';
import { parseManifest } from './lib/manifest.mjs';
import { findApksigner, parseSigners, signerEnvironment, verifySigner } from './lib/android.mjs';
import { highestVersionCode, uploadBundle } from './lib/play.mjs';
import { buildReceipt, hubRef, setOutputs, summaryMarkdown, writeReceipt } from './lib/receipt.mjs';
import { exportGodot, scriptErrors } from './lib/godot.mjs';
import { play } from './hub.mjs';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const signer = '2d4954863dabb5da86d69ce4b60b3e400e73669b50a80658b0941440a7941a97';
const other = 'd09a000000000000000000000000000000000000000000000000000000000000';
const sha1 = 'F8A5C5309FC1B6C7DD7662A28EA822BE3309C351';

const manifestText = (extra = {}) => JSON.stringify({
  schema: 2,
  project: { slug: 'example-app', name: 'Example App' },
  version: { read: 'node tools/version.mjs', bump: 'node tools/version.mjs bump' },
  android: {
    package: 'io.example.app',
    export: 'mkdir -p artifacts && printf apk > artifacts/App.apk',
    artifact: 'artifacts/App.apk',
    receipt: 'artifacts/android-receipt.json',
    signer_sha256: signer,
  },
  ios: {
    bundle: 'io.example.app',
    export: 'node tools/ios.mjs export',
    archive: 'App-ipad.tgz',
    receipt: 'ipad-export.json',
    device: 'node tools/ios.mjs device',
    device_artifact: 'App.xcarchive',
    store: { archive: 'App-xcode.tgz', receipt: 'testflight-export.json', upload: 'node tools/ios.mjs upload', assign: 'node tools/ios.mjs assign', secrets: ['op://Vault/Item/key_id'], signer_sha1: sha1 },
  },
  ...extra,
});

async function script(path, body) {
  await writeFile(path, `#!/bin/sh\n${body}\n`);
  await chmod(path, 0o755);
}

// A throwaway app checkout, a fake Android SDK, a fake Mac toolchain and an output folder.
async function fixture(manifest = manifestText()) {
  const root = await mkdtemp(join(tmpdir(), 'hub-test-'));
  const app = join(root, 'app');
  const out = join(root, 'out');
  const bin = join(root, 'bin');
  const sdk = join(root, 'sdk');
  await Promise.all([app, out, bin, join(sdk, 'build-tools/9.0.0'), join(sdk, 'build-tools/10.0.0')].map(path => mkdir(path, { recursive: true })));
  await writeFile(join(app, 'mobile-deploy.json'), manifest);
  await script(join(sdk, 'build-tools/10.0.0/apksigner'), `echo "JAVA_HOME=$JAVA_HOME PATH=$PATH" > "${root}/apksigner-env.txt"\necho "Signer #1 certificate DN: CN=Godot"\necho "Signer #1 certificate SHA-256 digest: \${FAKE_SIGNER:-${signer}}"`);
  await script(join(sdk, 'build-tools/9.0.0/apksigner'), 'echo "Signer #1 certificate SHA-256 digest: 0000000000000000000000000000000000000000000000000000000000000000"');
  await script(join(bin, 'xcodebuild'), 'echo "Xcode 99.0"');
  await script(join(bin, 'security'), `echo '  1) ${sha1} "Apple Distribution: Test (TEAM)"'\necho '     1 valid identities found'`);
  await script(join(bin, 'op'), `echo "$@" >> "${root}/op-calls.txt"\necho SECRETVALUE-do-not-print`);
  await script(join(bin, 'gh'), `echo "$@" >> "${root}/gh-calls.txt"\nif [ "$1 $2" = "release view" ]; then exit "\${FAKE_RELEASE_EXISTS:-1}"; fi`);
  const output = join(root, 'github-output.txt');
  await writeFile(output, '');
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    ANDROID_HOME: sdk,
    JAVA_HOME: join(root, 'java'),
    GITHUB_OUTPUT: output,
    GITHUB_REPOSITORY: 'owner/app',
    GITHUB_SHA: 'abc123',
    GITHUB_RUN_ID: '42',
    HUB_OUT: undefined,
    GH_TOKEN: undefined,
    PLAY_TOKEN: undefined,
  };
  delete env.HUB_OUT; delete env.GH_TOKEN; delete env.PLAY_TOKEN;
  const configure = (command, extra = [], more = {}) => ({
    ...parseConfig([command, '--out', out, '--version', '0.3.0', '--android-code', '4', ...extra], { ...env, ...more }),
    cwd: app,
  });
  return { root, app, out, env, configure, cleanup: () => rm(root, { recursive: true, force: true }) };
}

// ---- argument handling ----

test('defaults are the safe ones: dry run, sideload, both platforms, no build override', () => {
  const config = parseConfig(['plan'], {});
  assert.equal(config.dryRun, true);
  assert.equal(config.dryHandoff, false);
  assert.equal(config.strict, true, 'a dry run is strict unless asked otherwise');
  assert.equal(config.platform, 'both');
  assert.equal(config.channel, 'sideload');
  assert.equal(config.track, 'internal');
  assert.equal(config.playStatus, 'completed', 'the internal track rolls out to testers by default');
  assert.equal(config.playStatusExplicit, false);
  assert.equal(parseConfig(['plan', '--track', 'alpha'], {}).playStatus, 'draft', 'every other track defaults to draft');
  assert.equal(parseConfig(['plan'], { HUB_PLAY_STATUS: '' }).playStatusExplicit, false, 'the workflow passes an empty status when the caller gave none');
  assert.deepEqual([parseConfig(['plan', '--play-status', 'draft'], {}).playStatus, parseConfig(['plan', '--play-status', 'draft'], {}).playStatusExplicit], ['draft', true]);
  assert.equal(config.build, '');
  assert.equal(config.manifest, 'mobile-deploy.json');
  assert.equal(config.metered, 'auto', 'the iPad lane is skipped on a metered link that would go over budget unless asked');
  assert.deepEqual([config.linuxRunner, config.macRunner], [['self-hosted', 'Linux'], ['self-hosted', 'macOS']]);
  assert.equal(config.iosLane, '');
});

test('environment sets the config and flags override it', () => {
  const env = { HUB_PLATFORM: 'ios', HUB_DRY_RUN: 'false', HUB_BUILD: '12', HUB_CHANNEL: 'play', HUB_TRACK: 'beta', HUB_OUT: '/tmp/x' };
  const config = parseConfig(['android'], env);
  assert.deepEqual([config.platform, config.dryRun, config.build, config.channel, config.track, config.out], ['ios', false, '12', 'play', 'beta', '/tmp/x']);
  const flagged = parseConfig(['android', '--platform', 'android', '--dry-run', 'true', '--build', '13', '--out', '/tmp/y'], env);
  assert.deepEqual([flagged.platform, flagged.dryRun, flagged.build, flagged.out], ['android', true, '13', '/tmp/y']);
  assert.equal(parseConfig(['ios'], { HUB_STRICT: 'false' }).strict, false, 'parsed here; the gate refuses it');
  assert.equal(parseConfig(['ios', '--strict', 'false'], {}).strict, false);
  assert.throws(() => parseConfig(['ios'], { HUB_STRICT: 'no' }), /strict must be true or false/);
  assert.deepEqual(parseConfig(['preflight-ios'], { HUB_IOS_STORE: JSON.stringify({ signer_sha1: sha1, secrets: ['op://Vault/Item/x'] }) }).iosStore, { signer_sha1: sha1, secrets: ['op://Vault/Item/x'] });
  // Tower's real references have spaces in the item name (the v1.1.0 release dry run found this).
  const tower = ['op://DeLoSecrets/App Store Connect API Key/key_id', 'op://DeLoSecrets/App Store Connect API Key/issuer_id'];
  assert.deepEqual(parseConfig(['preflight-ios'], { HUB_IOS_STORE: JSON.stringify({ signer_sha1: sha1, secrets: tower }) }).iosStore.secrets, tower);
  assert.throws(() => parseConfig(['preflight-ios'], { HUB_IOS_STORE: JSON.stringify({ secrets: ['op://a/b\nc'] }) }), /op:\/\/ references/);
  assert.equal(parseConfig(['gate'], { HUB_METERED: 'allow' }).metered, 'allow');
});

test('the output folder defaults under RUNNER_TEMP', () => {
  assert.equal(parseConfig(['plan'], { RUNNER_TEMP: '/runner/_temp' }).out, '/runner/_temp/hub-out');
});

test('bad arguments are rejected before anything runs', () => {
  const bad = [
    [['nope'], {}], [[], {}],
    [['plan'], { HUB_PLATFORM: 'watch' }], [['plan'], { HUB_CHANNEL: 'beta' }], [['plan'], { HUB_DRY_RUN: 'yes' }],
    [['plan'], { HUB_BUILD: '0' }], [['plan'], { HUB_BUILD: '12; rm -rf /' }], [['plan'], { HUB_BUILD: 'abc' }], [['plan'], { HUB_BUILD: '-3' }],
    [['plan'], { HUB_TRACK: 'in ternal' }], [['plan'], { HUB_TRACK: 'x;y' }],
    [['plan'], { HUB_MANIFEST: '/etc/passwd' }], [['plan'], { HUB_MANIFEST: '../other.json' }],
    [['plan'], { HUB_PLAY_STATUS: 'live' }], [['plan'], { HUB_ANDROID_CODE: '0' }],
    [['plan', '--bogus', '1'], {}], [['plan', '--platform'], {}],
    [['ios-upload'], {}], [['plan'], { HUB_METERED: 'always' }], [['plan'], { HUB_IOS_LANE: 'maybe' }], [['plan'], { HUB_LINUX_RUNNER: '["ubuntu latest"]' }],
    [['plan'], { HUB_LINUX_RUNNER: 'self-hosted' }], [['preflight-ios'], { HUB_IOS_STORE: '{"secrets":["hunter2"]}' }], [['preflight-ios'], { HUB_BUNDLE: 'not a bundle' }],
  ];
  for (const [argv, env] of bad) assert.throws(() => parseConfig(argv, env), undefined, JSON.stringify([argv, env]));
});

test('every documented command parses', () => {
  for (const command of commands) assert.equal(parseConfig([command], {}).command, command);
});

test('hooks see the HUB_ variables and never a store, GitHub or OIDC token', () => {
  const out = join(tmpdir(), `hub-hook-env-${process.pid}`);
  const config = parseConfig(['android', '--build', '9', '--dry-run', 'false', '--channel', 'play', '--out', out], {});
  const env = hookEnvironment(config, {
    PATH: '/bin', KEEP: '1', PLAY_TOKEN: 'secret-a', GH_TOKEN: 'secret-b', GITHUB_TOKEN: 'secret-c',
    // The runner sets these in every step of a job that holds id-token: write, and they mint a federated Google token.
    ACTIONS_ID_TOKEN_REQUEST_URL: 'https://oidc.example/token', ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'secret-d', ACTIONS_RUNTIME_TOKEN: 'secret-e',
  });
  assert.deepEqual([env.HUB_OUT, env.HUB_BUILD, env.HUB_DRY_RUN, env.HUB_CHANNEL, env.KEEP, env.PATH], [out, '9', 'false', 'play', '1', '/bin']);
  for (const name of credentialVariables) assert.equal(env[name], undefined, name);
  assert.deepEqual([...credentialVariables].sort(), ['ACTIONS_ID_TOKEN_REQUEST_TOKEN', 'ACTIONS_ID_TOKEN_REQUEST_URL', 'ACTIONS_RUNTIME_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN', 'PLAY_TOKEN']);
  assert.ok(!JSON.stringify(env).includes('secret-'), 'no credential value survives anywhere in the hook environment');
});

test('hooks get throwaway job-control files and never an mc alias with keys', async () => {
  const out = await mkdtemp(join(tmpdir(), 'hub-sink-'));
  try {
    const config = parseConfig(['android', '--out', out], {});
    const env = hookEnvironment(config, { PATH: '/bin', GITHUB_ENV: '/runner/env', GITHUB_OUTPUT: '/runner/out', GITHUB_PATH: '/runner/path', GITHUB_STATE: '/runner/state', MC_HOST_builds: 'http://a:secret-mc@127.0.0.1:9012', MC_HOST_other: 'x' });
    for (const name of jobControlFiles) {
      assert.ok(env[name].startsWith(out), `${name} is a throwaway file under the hub output`);
      assert.ok(existsSync(env[name]), name);
    }
    assert.equal(env.MC_HOST_builds, undefined);
    assert.equal(env.MC_HOST_other, undefined);
    assert.ok(isCredentialVariable('MC_HOST_anything') && isCredentialVariable('GH_TOKEN') && !isCredentialVariable('OP_SERVICE_ACCOUNT_TOKEN'), 'hooks keep the 1Password token (gib fetches its keystore), never a MinIO alias');
  } finally { await rm(out, { recursive: true, force: true }); }
});

// ---- manifest ----

test('a complete manifest parses, project.icon included', () => {
  const manifest = parseManifest(manifestText({ project: { slug: 'example-app', name: 'Example App', icon: 'art/icon-1024.png' } }));
  assert.equal(manifest.android.package, 'io.example.app');
  assert.equal(manifest.ios.store.signer_sha1, sha1);
  assert.equal(manifest.project.icon, 'art/icon-1024.png');
});

test('schema 1 is gone: the v2 manifest is refused with the way out', () => {
  assert.throws(() => parseManifest(JSON.stringify({ schema: 1, version: 'echo', android: {} })), /schema 1 \(the v2 contract\) is gone/);
});

test('the manifest is strict', () => {
  const base = JSON.parse(manifestText());
  const mutate = change => JSON.stringify(change(structuredClone(base)));
  const cases = {
    'schema 3': mutate(m => { m.schema = 3; }),
    'unknown top key': mutate(m => { m.deploy = 'x'; }),
    'unknown android key': mutate(m => { m.android.extra = 'x'; }),
    'hook not a string': mutate(m => { m.android.export = ['node', 'x']; }),
    'empty hook': mutate(m => { m.ios.store.upload = '  '; }),
    'missing version hooks': mutate(m => { delete m.version; }),
    'bad signer digest': mutate(m => { m.android.signer_sha256 = 'ABC'; }),
    'artifact outside the checkout': mutate(m => { m.android.artifact = '../App.apk'; }),
    'artifact absolute': mutate(m => { m.android.artifact = '/tmp/App.apk'; }),
    'artifact not an apk': mutate(m => { m.android.artifact = 'artifacts/App.zip'; }),
    'export and godot': mutate(m => { m.android.godot = { path: 'game', preset: 'Android' }; }),
    'ios archive with a path': mutate(m => { m.ios.archive = 'out/App-ipad.tgz'; }),
    'store secret that is not op://': mutate(m => { m.ios.store.secrets = ['hunter2']; }),
    'bad bundle': mutate(m => { m.ios.bundle = 'not a bundle'; }),
    'bad sha1': mutate(m => { m.ios.store.signer_sha1 = 'abc'; }),
    'bundle_artifact without bundle': mutate(m => { m.android.bundle_artifact = 'a.aab'; }),
    'icon outside the checkout': mutate(m => { m.project.icon = '../icon.png'; }),
    'icon not a png': mutate(m => { m.project.icon = 'icon.svg'; }),
    'unknown project key': mutate(m => { m.project.color = 'green'; }),
    'no platform': JSON.stringify({ schema: 2, project: { slug: 'a', name: 'A' }, version: { read: 'x', bump: 'y' } }),
    'not json': '{',
  };
  for (const [name, text] of Object.entries(cases)) assert.throws(() => parseManifest(text), /mobile-deploy\.json/, name);
});

test('a godot section can stand in for the export hook', () => {
  const manifest = JSON.parse(manifestText());
  delete manifest.android.export;
  manifest.android.godot = { path: 'game', preset: 'Android' };
  assert.equal(parseManifest(JSON.stringify(manifest)).android.godot.preset, 'Android');
});

// ---- android signer ----

test('apksigner output is parsed into digests', () => {
  assert.deepEqual(parseSigners(`Signer #1 certificate DN: CN=Godot\nSigner #1 certificate SHA-256 digest: ${signer}\nSigner #1 certificate SHA-1 digest: abc\n`), [signer]);
  assert.deepEqual(parseSigners('nothing here'), []);
});

test('apksigner is found under the newest build-tools and java comes from JAVA_HOME', async () => {
  const f = await fixture();
  try {
    assert.match(findApksigner(f.env, '/nonexistent'), /build-tools\/10\.0\.0\/apksigner$/);
    assert.throws(() => findApksigner({ ANDROID_HOME: join(f.root, 'empty') }, '/nonexistent'), /apksigner not found/);
    const env = signerEnvironment(f.env, '/nonexistent');
    assert.equal(env.JAVA_HOME, join(f.root, 'java'));
    assert.ok(env.PATH.startsWith(join(f.root, 'java', 'bin')));
    assert.deepEqual(verifySigner({ apk: 'x.apk', expected: signer, env: f.env, home: '/nonexistent' }), { signer_sha256: signer });
    assert.match(await readFile(join(f.root, 'apksigner-env.txt'), 'utf8'), new RegExp(`JAVA_HOME=${join(f.root, 'java')} PATH=${join(f.root, 'java', 'bin')}`));
  } finally { await f.cleanup(); }
});

test('a different signer fails the check and says why', async () => {
  const f = await fixture();
  try {
    assert.throws(() => verifySigner({ apk: 'x.apk', expected: signer, env: { ...f.env, FAKE_SIGNER: other }, home: '/nonexistent' }), /differs from the pinned.*update in place/);
  } finally { await f.cleanup(); }
});

// ---- play uploader ----

function playApi({ bundles = [], apks = [], uploadedCode = 5, failOn, refuse } = {}) {
  const calls = [];
  let lastStatus = '';
  const fetchImpl = async (url, init) => {
    const { pathname } = new URL(url);
    calls.push({ method: init.method, path: pathname, body: init.body, auth: init.headers.Authorization });
    const reply = (value, ok = true) => ({ ok, status: ok ? 200 : 500, json: async () => value, text: async () => JSON.stringify(value) });
    if (init.method === 'PUT') lastStatus = JSON.parse(init.body).releases[0].status;
    if (refuse && refuse.when === `${init.method} ${pathname.split('/').pop().split(':')[0]}` && (refuse.always || lastStatus === 'completed')) return { ok: false, status: 400, json: async () => ({}), text: async () => JSON.stringify({ error: { code: 400, message: 'Invalid request - Only releases with status draft may be created on draft app.', status: 'INVALID_ARGUMENT' } }) };
    if (failOn === `${init.method} ${pathname.split('/').pop().split(':')[0]}`) return reply({ error: 'boom' }, false);
    if (pathname.endsWith('/edits') && init.method === 'POST') return reply({ id: 'E1' });
    if (pathname.endsWith('/bundles') && init.method === 'GET') return reply({ bundles });
    if (pathname.endsWith('/apks')) return reply({ apks });
    if (pathname.includes('/upload/') && pathname.endsWith('/bundles')) return reply({ versionCode: uploadedCode });
    if (init.method === 'PUT') return reply({});
    if (pathname.endsWith(':commit')) return reply({});
    if (init.method === 'DELETE') return { ok: true, status: 204, json: async () => null, text: async () => '' };
    return reply({}, false);
  };
  return { fetchImpl, calls };
}

test('play upload creates an edit, uploads, assigns the default release and commits', async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.root, 'app.aab'), 'aab');
    const api = playApi({ bundles: [{ versionCode: 3 }], uploadedCode: 5 });
    const logs = [];
    const result = await uploadBundle({ pkg: 'io.example.app', track: 'internal', aab: join(f.root, 'app.aab'), token: 'tok', expectedCode: 5, fetchImpl: api.fetchImpl, log: line => logs.push(line) });
    assert.equal(result.status, 'completed', 'the internal track defaults to a completed release');
    const put = api.calls.find(call => call.method === 'PUT');
    assert.deepEqual(JSON.parse(put.body), { track: 'internal', releases: [{ versionCodes: ['5'], status: 'completed' }] });
    assert.ok(api.calls.at(-1).path.endsWith(':commit'));
    assert.ok(api.calls.every(call => call.auth === 'Bearer tok'));
    assert.ok(logs.every(line => !line.includes('tok')));
  } finally { await f.cleanup(); }
});

const playRun = async (options, args) => {
  const f = await fixture();
  try {
    await writeFile(join(f.root, 'app.aab'), 'aab');
    const api = playApi({ uploadedCode: 5, ...options });
    const logs = [];
    let outcome;
    try { outcome = { result: await uploadBundle({ pkg: 'io.example.app', aab: join(f.root, 'app.aab'), token: 'tok', fetchImpl: api.fetchImpl, log: line => logs.push(line), ...args }) }; } catch (error) { outcome = { error }; }
    return { ...outcome, api, logs, puts: api.calls.filter(call => call.method === 'PUT').map(call => JSON.parse(call.body).releases[0].status) };
  } finally { await f.cleanup(); }
};

test('play status: internal defaults to completed, every other track to draft, an explicit status passes through', async () => {
  assert.deepEqual((await playRun({}, { track: 'internal' })).puts, ['completed']);
  assert.deepEqual((await playRun({}, {})).puts, ['completed'], 'the track itself defaults to internal');
  assert.deepEqual((await playRun({}, { track: 'internal', status: '' })).puts, ['completed']);
  for (const track of ['alpha', 'beta', 'production', 'qa-testers']) {
    const run = await playRun({}, { track });
    assert.deepEqual([run.puts, run.result.status], [['draft'], 'draft'], track);
  }
  assert.deepEqual((await playRun({}, { track: 'internal', status: 'draft' })).puts, ['draft']);
  assert.deepEqual((await playRun({}, { track: 'alpha', status: 'inProgress' })).puts, ['inProgress']);
});

test('play upload falls back to one draft retry in the same edit when the default completed hits a draft app', async () => {
  for (const when of ['PUT internal', 'POST E1']) {
    const refuse = { when };
    const run = await playRun({ refuse }, { track: 'internal' });
    assert.equal(run.error, undefined, when);
    assert.equal(run.result.status, 'draft');
    assert.deepEqual(run.puts, ['completed', 'draft'], 'exactly one retry');
    assert.ok(run.logs.some(line => /^PLAY_DRAFT_APP io\.example\.app track=internal .*roll out in Play Console/.test(line)));
    assert.ok(run.logs.some(line => line.includes('PLAY_COMMITTED') && line.includes('status=draft')));
    assert.equal(run.api.calls.filter(call => call.method === 'POST' && call.path.endsWith('/edits')).length, 1, 'same edit');
    assert.ok(!run.api.calls.some(call => call.method === 'DELETE'), 'the edit is kept and committed');
    assert.ok(run.api.calls.at(-1).path.endsWith(':commit'));
  }
});

test('play upload never softens an explicit completed and never swallows another error', async () => {
  const refuse = { when: 'PUT internal' };
  const explicit = await playRun({ refuse }, { track: 'internal', status: 'completed' });
  assert.match(explicit.error.message, /Only releases with status draft may be created on draft app/);
  assert.deepEqual(explicit.puts, ['completed'], 'no retry');
  assert.ok(explicit.api.calls.some(call => call.method === 'DELETE'));
  assert.ok(!explicit.logs.some(line => line.includes('PLAY_DRAFT_APP')));

  const other = await playRun({ failOn: 'PUT internal' }, { track: 'internal' });
  assert.match(other.error.message, /Play PUT .*500/);
  assert.deepEqual(other.puts, ['completed'], 'no retry');
  assert.ok(other.api.calls.some(call => call.method === 'DELETE' && call.path.endsWith('/edits/E1')), 'edit deleted');
  assert.ok(!other.api.calls.some(call => call.path.endsWith(':commit')));

  const failedRetry = await playRun({ refuse: { when: 'PUT internal', always: true } }, { track: 'internal' });
  assert.match(failedRetry.error.message, /draft app/, 'a refused draft retry still fails loudly');
  assert.deepEqual(failedRetry.puts, ['completed', 'draft']);
  assert.ok(failedRetry.api.calls.some(call => call.method === 'DELETE'));
});

test('play upload refuses a versionCode at or below the Console maximum and deletes its edit', async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.root, 'app.aab'), 'aab');
    for (const expectedCode of [3, 2]) {
      const api = playApi({ bundles: [{ versionCode: 3 }] });
      await assert.rejects(uploadBundle({ pkg: 'io.example.app', aab: join(f.root, 'app.aab'), token: 'tok', expectedCode, fetchImpl: api.fetchImpl, log() {} }), /not above the Console maximum 3/);
      assert.ok(api.calls.some(call => call.method === 'DELETE' && call.path.endsWith('/edits/E1')), 'edit deleted');
      assert.ok(!api.calls.some(call => call.path.includes('/upload/')), 'nothing uploaded');
    }
    const apkMax = playApi({ apks: [{ versionCode: 9 }] });
    await assert.rejects(uploadBundle({ pkg: 'io.example.app', aab: join(f.root, 'app.aab'), token: 'tok', expectedCode: 9, fetchImpl: apkMax.fetchImpl, log() {} }), /maximum 9/);
    assert.equal(highestVersionCode({ bundles: [{ versionCode: '4' }], apks: [{ versionCode: 2 }] }, undefined), 4);
  } finally { await f.cleanup(); }
});

test('play upload deletes its edit on any later failure', async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.root, 'app.aab'), 'aab');
    const api = playApi({ failOn: 'PUT internal' });
    await assert.rejects(uploadBundle({ pkg: 'io.example.app', track: 'internal', aab: join(f.root, 'app.aab'), token: 'tok', fetchImpl: api.fetchImpl, log() {} }), /Play PUT/);
    assert.ok(api.calls.some(call => call.method === 'DELETE'));
    assert.ok(!api.calls.some(call => call.path.endsWith(':commit')));
    const mismatch = playApi({ uploadedCode: 8 });
    await assert.rejects(uploadBundle({ pkg: 'io.example.app', aab: join(f.root, 'app.aab'), token: 'tok', expectedCode: 5, fetchImpl: mismatch.fetchImpl, log() {} }), /carries versionCode 8 but the presets say 5/);
    await assert.rejects(uploadBundle({ pkg: 'io.example.app', aab: join(f.root, 'app.aab'), token: '', fetchImpl: api.fetchImpl, log() {} }), /PLAY_TOKEN is empty/);
    await assert.rejects(uploadBundle({ pkg: 'bad name', aab: join(f.root, 'app.aab'), token: 't', fetchImpl: api.fetchImpl, log() {} }), /not a package name/);
  } finally { await f.cleanup(); }
});

test('the play command reads its token from PLAY_TOKEN and uses the track default status', async () => {
  const manifest = JSON.parse(manifestText());
  manifest.android.bundle = 'true';
  manifest.android.bundle_artifact = 'artifacts/App.aab';
  const f = await fixture(JSON.stringify(manifest));
  try {
    await mkdir(join(f.out, 'android'), { recursive: true });
    await writeFile(join(f.out, 'android/App.aab'), 'aab');
    const api = playApi({ uploadedCode: 4 });
    const real = f.configure('play', ['--dry-run', 'false', '--play', 'true', '--track', 'alpha']);
    await assert.rejects(play(real, { env: f.env, fetchImpl: api.fetchImpl }), /PLAY_TOKEN is empty/);
    const result = await play(real, { env: { ...f.env, PLAY_TOKEN: 'tok' }, fetchImpl: api.fetchImpl });
    assert.deepEqual([result.track, result.status, result.versionCode], ['alpha', 'draft', 4]);
  } finally { await f.cleanup(); }
});

// ---- receipts, outputs, godot fallback ----

test('receipts hold identity and checksums and no credentials', async () => {
  const f = await fixture();
  try {
    const receipt = buildReceipt({ lane: 'android', config: f.configure('android'), env: f.env, version: '0.3.0', artifacts: [{ name: 'a.apk', sha256: 'f'.repeat(64) }], signer });
    assert.deepEqual(Object.keys(receipt).filter(key => /token|key|secret|password/i.test(key)), []);
    assert.equal(receipt.hub_ref, null, 'unknown outside a runner');
    assert.equal(buildReceipt({ lane: 'android', config: f.configure('android'), env: { ...f.env, HUB_REF: 'v1.0.0' } }).hub_ref, 'v1.0.0');
    assert.match(summaryMarkdown({ ...receipt, hub_ref: 'v1.0.0' }), /\| hub ref \| `v1\.0\.0` \|/);
    const summary = join(f.root, 'summary.md');
    const file = await writeReceipt(join(f.root, 'r'), receipt, { GITHUB_STEP_SUMMARY: summary });
    assert.ok(existsSync(file));
    assert.match(await readFile(summary, 'utf8'), /Hub receipt: android/);
    assert.match(summaryMarkdown(receipt), /a\.apk/);
    await assert.rejects(setOutputs({ evil: 'a\nb=c' }, f.env), /line break/);
  } finally { await f.cleanup(); }
});

test('the hub ref comes from the action, or from where the runner put the tool', () => {
  const runner = '/home/x/_work/_actions/delorenj/mobile-deploy-hub';
  assert.equal(hubRef({ HUB_REF: 'v1.2.3' }, `${runner}/main/tools/ci/lib/receipt.mjs`), 'v1.2.3');
  assert.equal(hubRef({ HUB_REF: '' }, `${runner}/main/tools/ci/lib/receipt.mjs`), 'main');
  assert.equal(hubRef({}, `${runner}/v1.0.0/tools/ci/lib/receipt.mjs`), 'v1.0.0');
  assert.equal(hubRef({}, `/home/delorenj/code/mobile-deploy-hub/tools/ci/lib/receipt.mjs`), null, 'a local checkout has no ref');
});

test('the godot fallback exports with GODOT_BIN and fails on script errors', async () => {
  const f = await fixture();
  try {
    const engine = join(f.root, 'godot');
    await script(engine, 'for a in "$@"; do last="$a"; done\nif [ "$4" = "--export-release" ]; then printf apk > "$last"; fi\necho "args: $*"');
    const output = await exportGodot({ project: f.app, preset: 'Android', output: join(f.root, 'build/out.apk'), env: { ...f.env, GODOT_BIN: engine } });
    assert.ok(existsSync(output));
    await script(engine, 'echo "SCRIPT ERROR: Parse Error: nope" >&2');
    await assert.rejects(exportGodot({ project: f.app, preset: 'Android', output: join(f.root, 'build/two.apk'), env: { ...f.env, GODOT_BIN: engine } }), /script errors/);
    await assert.rejects(exportGodot({ project: f.app, preset: 'Android', output: join(f.root, 'x.apk'), env: { ...f.env, GODOT_BIN: '' } }), /GODOT_BIN/);
    assert.equal(scriptErrors('all good'), false);
  } finally { await f.cleanup(); }
});

// ---- the workflow and the action ----

const read = path => readFile(join(repoRoot, path), 'utf8');

test('the reusable workflow is hardened: no hosted runners, no shell interpolation, per-job concurrency', async () => {
  const workflow = await read('.github/workflows/mobile-deploy.yml');
  assert.match(workflow, /^on:\n {2}workflow_call:/m);
  assert.doesNotMatch(workflow, /ubuntu-|macos-|windows-/, 'private repos must not use billed hosted runners');
  assert.doesNotMatch(workflow, /^\s*run:/m, 'the YAML carries no shell; hub.mjs does the work');
  assert.doesNotMatch(workflow, /github\.job|pull_request_target|secrets\./);
  assert.doesNotMatch(workflow, /client_payload|repository_dispatch/);
  const jobs = [...workflow.matchAll(/^ {2}([\w-]+):\n/gm)].map(match => match[1]).filter(name => !['workflow_call'].includes(name));
  assert.deepEqual(jobs.slice(-9), ['gate', 'preflight-ios', 'plan', 'android', 'ios-export', 'ios', 'deliver-android', 'deliver-ios', 'announce']);
  const groups = [...workflow.matchAll(/^\s+group: (mobile-deploy-[\w-]+)-\$\{\{ github\.repository \}\}$/gm)].map(match => match[1]);
  assert.deepEqual(groups, ['mobile-deploy-plan', 'mobile-deploy-android', 'mobile-deploy-ios-export', 'mobile-deploy-ios', 'mobile-deploy-deliver-android', 'mobile-deploy-deliver-ios']);
  assert.equal([...workflow.matchAll(/cancel-in-progress: false/g)].length, 6);
  // runs-on is the policy's self-hosted labels, never a caller input: a caller cannot put a job on a hosted runner.
  assert.doesNotMatch(workflow, /runs-on: \$\{\{/, 'runs-on takes no expression');
  const labels = [...workflow.matchAll(/runs-on: \[([^\]]+)\]/g)].map(match => match[1]);
  assert.equal(labels.length, 9);
  for (const label of labels) assert.match(label, /^self-hosted, (Linux|macOS)$/);
  // gate, plan and announce check out the dispatched commit; the lanes and the deliver jobs the plan's commit (the bump).
  assert.equal([...workflow.matchAll(/uses: actions\/checkout@v4\n\s+with:\n\s+ref: \$\{\{ github\.sha \}\}/g)].length, 3);
  assert.equal([...workflow.matchAll(/uses: actions\/checkout@v4\n\s+with:\n\s+ref: \$\{\{ needs\.plan\.outputs\.build_sha \}\}/g)].length, 5);
  assert.match(workflow, /ref: \$\{\{ github\.sha \}\}\n\s+fetch-depth: 0\n\s+fetch-tags: true\n/, 'the plan bumps on full history');
  const refs = new Set([...workflow.matchAll(/uses: delorenj\/mobile-deploy-hub\/actions\/hub@(\S+)/g)].map(match => match[1]));
  assert.equal(refs.size, 1, 'one exact hub ref everywhere; mise run release flips them together');
  assert.match([...refs][0], /^v\d+\.\d+\.\d+$/, 'the inner refs are an exact tag, never v1 or main');
  assert.match(workflow, /retention-days: \$\{\{ inputs\.dry_run && 1 \|\| 7 \}\}/);
  // The Mac preflight: after the gate, only when the gate runs the iPad lane, no checkout and no artifact.
  const preflight = workflow.slice(workflow.indexOf('\n  preflight-ios:\n'), workflow.indexOf('\n  plan:\n'));
  assert.match(preflight, /needs: gate\n\s+if: \$\{\{ needs\.gate\.outputs\.ios_lane == 'run' \}\}/);
  assert.doesNotMatch(preflight, /actions\/checkout|upload-artifact/, 'a metered Mac downloads only the hub action');
  assert.match(preflight, /receipt: \$\{\{ steps\.hub\.outputs\.receipt \}\}/, 'its receipt goes back as a job output');
  assert.match(workflow, /plan:\n\s+needs: \[gate, preflight-ios\]\n\s+if: \$\{\{ !cancelled\(\) && needs\.gate\.result == 'success' && \(needs\.preflight-ios\.result == 'success' \|\| needs\.preflight-ios\.result == 'skipped'\) \}\}/);
  assert.match(workflow, /ios:\n\s+needs: \[gate, plan, ios-export\]/);
  // The APK half never waits for the Mac: deliver-android needs no Mac job; deliver-ios runs when the ios job ran.
  assert.match(workflow, /deliver-android:\n\s+needs: \[gate, plan, android\]\n\s+if: \$\{\{ !cancelled\(\) && needs\.plan\.result == 'success' && \(needs\.android\.result == 'success' \|\| needs\.android\.result == 'failure'\) \}\}/);
  assert.match(workflow, /deliver-ios:\n\s+needs: \[gate, plan, ios-export, ios\]\n\s+if: \$\{\{ !cancelled\(\) && needs\.plan\.result == 'success' && \(needs\.ios\.result == 'success' \|\| needs\.ios\.result == 'failure'\) \}\}/);
  const deliverAndroid = workflow.slice(workflow.indexOf('\n  deliver-android:\n'), workflow.indexOf('\n  deliver-ios:\n'));
  assert.doesNotMatch(deliverAndroid, /needs\.(ios|preflight-ios|ios-export)\b|ios-out|ios-receipt|mac_link/, 'nothing in deliver-android waits on or reads the Mac');
  assert.match(deliverAndroid, /scope: android/);
  assert.match(workflow.slice(workflow.indexOf('\n  deliver-ios:\n'), workflow.indexOf('\n  announce:\n')), /scope: ios/);
  assert.match(workflow, /announce:\n\s+needs: \[gate, preflight-ios, plan, android, ios-export, ios, deliver-android, deliver-ios\]\n\s+if: \$\{\{ always\(\) \}\}/, 'one event per run attempt, whatever happened');
  assert.match(workflow, /ios_lane: \$\{\{ steps\.hub\.outputs\.ios_lane \}\}\n\s+steps:\n\s+# Full history/, 'the plan has the last word on the iPad lane');
  // Every upload can be redone by "Re-run failed jobs", and receipts upload even when the lane failed.
  const uploads = workflow.split('uses: actions/upload-artifact@v4').slice(1).map(block => block.split(/\n {6}- |\n\n/)[0]);
  assert.deepEqual(uploads.map(block => /name: (\S+)/.exec(block)[1]), ['gate-out', 'plan-out', 'android-out', 'ios-receipt', 'ios-out', 'deliver-android-out', 'deliver-ios-out']);
  for (const block of uploads) assert.match(block, /^\s+overwrite: true$/m, block);
  // The build itself never takes artifact quota: staging, the build directory and the Release hold it.
  assert.match(workflow, /name: android-out\n\s+path: \$\{\{ runner\.temp \}\}\/hub-out\/android\/\*\.json\n/);
  assert.doesNotMatch(workflow, /xcode-project|\.tgz/, 'the Xcode handoff never goes through artifacts');
  // The deploy contract: a bump on every run (no "none"), extra stores off, dry run and strict on, metered auto.
  assert.match(workflow, /bump:\n\s+description: [^\n]+\n\s+type: string\n\s+default: patch\n/);
  assert.doesNotMatch(workflow, /\bnone\b/, 'there is no bump level none');
  for (const name of ['testflight', 'play']) assert.match(workflow, new RegExp(`${name}:\\n\\s+description: [^\\n]+\\n\\s+type: boolean\\n\\s+default: false\\n`), name);
  assert.match(workflow, /dry_run:\n\s+description: [^\n]+\n\s+type: boolean\n\s+default: true\n/);
  assert.match(workflow, /strict:\n\s+description: [^\n]+\n\s+type: boolean\n\s+default: true\n/);
  assert.match(workflow, /metered:\n\s+description: [^\n]+\n\s+type: string\n\s+default: auto\n/);
  // The gate sees every input the policy rules on.
  const gateJob = workflow.slice(workflow.indexOf('\n  gate:\n'), workflow.indexOf('\n  preflight-ios:\n'));
  for (const input of ['manifest', 'strict', 'metered', 'linux_runner', 'mac_runner', 'bump', 'dry_run']) assert.match(gateJob, new RegExp(`\\n {10}${input}: \\$\\{\\{ inputs\\.${input} \\}\\}`), input);
  assert.match(gateJob, /channel: \$\{\{ inputs\.android_channel \}\}/);
  // Only the plan (bump push) and android (Release) jobs hold contents: write; only android holds id-token.
  const bodies = workflow.slice(workflow.indexOf('\njobs:\n')).split(/\n {2}(?=[\w-]+:\n)/).slice(1);
  const writes = bodies.filter(body => /\n {6}contents: write\n/.test(body)).map(body => body.split(':')[0]);
  assert.deepEqual(writes, ['plan', 'android']);
  assert.deepEqual(bodies.filter(body => /\n {6}id-token: write\n/.test(body)).map(body => body.split(':')[0]), ['android']);
  // A Play dry run mints the token (the keyless exchange is proven before a version is spent); only a real run uploads.
  assert.match(workflow, /- name: Authenticate to Google Cloud \(keyless\)\n\s+if: \$\{\{ needs\.plan\.outputs\.play_lane == 'true' \}\}\n/);
  assert.match(workflow, /- name: Upload to Play\n\s+if: \$\{\{ !inputs\.dry_run && needs\.plan\.outputs\.play_lane == 'true' \}\}\n/);
  assert.match(workflow, /create_credentials_file: false\n/, 'the token never lands in a credentials file');
});

test('the composite action gives every run step a shell and reads inputs only', async () => {
  const action = await read('actions/hub/action.yml');
  assert.match(action, /using: composite/);
  const runs = [...action.matchAll(/^\s+run: /gm)].length;
  const shells = [...action.matchAll(/^\s+shell: bash$/gm)].length;
  assert.equal(shells, runs);
  assert.doesNotMatch(action, /\$\{\{\s*(secrets|vars)\./);
  assert.match(action, /\$\{\{ github\.action_path \}\}\/\.\.\/\.\.\/tools\/ci\/hub\.mjs/);
  assert.doesNotMatch(action.replace(/^\s+[A-Z_]+: \$\{\{[^}]+\}\}$/gm, ''), /\$\{\{ inputs\./, 'inputs only reach the shell through env');
  assert.match(action, /run: node "\$HUB_TOOL" "\$HUB_COMMAND"/);
  assert.match(action, /^\s+HUB_REF: \$\{\{ github\.action_ref \}\}$/m, 'receipts record the ref the hub was fetched at');
  assert.match(action, /^\s+HUB_STRICT: \$\{\{ inputs\.strict \}\}$/m);
  for (const name of ['METERED', 'IOS_LANE', 'MAC_LINK', 'BUNDLE', 'SLUG', 'IOS_STORE', 'LINUX_RUNNER', 'MAC_RUNNER']) assert.match(action, new RegExp(`^\\s+HUB_${name}: \\$\\{\\{ inputs\\.${name.toLowerCase()} \\}\\}$`, 'm'), name);
  assert.match(action, /strict:\n\s+description: [^\n]+\n\s+default: 'true'\n/);
});

test('the old relay is gone', () => {
  assert.equal(existsSync(join(repoRoot, 'tools/ci/deploy-hub.mjs')), false);
  assert.equal(existsSync(join(repoRoot, '.github/workflows/deploy.yml')), false);
});
