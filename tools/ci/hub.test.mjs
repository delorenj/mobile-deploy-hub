import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { commands, hookEnvironment, parseConfig } from './lib/config.mjs';
import { parseManifest } from './lib/manifest.mjs';
import { findApksigner, parseSigners, signerEnvironment, verifySigner } from './lib/android.mjs';
import { highestVersionCode, uploadBundle } from './lib/play.mjs';
import { buildReceipt, setOutputs, summaryMarkdown, writeReceipt } from './lib/receipt.mjs';
import { exportGodot, scriptErrors } from './lib/godot.mjs';
import { android, iosExport, iosUpload, parseVersion, plan, play, release, releaseArguments, tagVersion } from './hub.mjs';

const hub = fileURLToPath(new URL('./hub.mjs', import.meta.url));
const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const signer = '2d4954863dabb5da86d69ce4b60b3e400e73669b50a80658b0941440a7941a97';
const other = 'd09a000000000000000000000000000000000000000000000000000000000000';
const sha1 = 'F8A5C5309FC1B6C7DD7662A28EA822BE3309C351';

const manifestText = (extra = {}) => JSON.stringify({
  schema: 1,
  version: `echo '{"version":"0.3.0","android_code":4}'`,
  android: {
    package: 'io.example.app',
    export: 'mkdir -p artifacts && printf apk > artifacts/App.apk && printf \'{"version":"0.3.0","version_code":4}\' > artifacts/android-receipt.json && env | grep ^HUB_ > "$HUB_OUT/hook-env.txt" || true',
    artifact: 'artifacts/App.apk',
    receipt: 'artifacts/android-receipt.json',
    signer_sha256: signer,
  },
  ios: {
    bundle: 'io.example.app',
    export: 'mkdir -p "$HUB_OUT/ios" && cd "$HUB_OUT/ios" && mkdir -p App.xcodeproj && printf x > App.xcodeproj/project.pbxproj && tar -czf App-xcode.tgz App.xcodeproj && rm -r App.xcodeproj && printf \'{"version":"0.3.0","build":"7","bundle":"io.example.app"}\' > testflight-export.json',
    archive: 'App-xcode.tgz',
    receipt: 'testflight-export.json',
    upload: 'echo uploaded >> "$HUB_OUT/marker.txt"',
    assign: 'echo assigned >> "$HUB_OUT/marker.txt"',
    secrets: ['op://Vault/Item/key_id', 'op://Vault/Item/credential'],
    signer_sha1: sha1,
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
  assert.equal(config.platform, 'both');
  assert.equal(config.channel, 'sideload');
  assert.equal(config.track, 'internal');
  assert.equal(config.playStatus, 'draft');
  assert.equal(config.build, '');
  assert.equal(config.manifest, 'mobile-deploy.json');
});

test('environment sets the config and flags override it', () => {
  const env = { HUB_PLATFORM: 'ios', HUB_DRY_RUN: 'false', HUB_BUILD: '12', HUB_CHANNEL: 'play', HUB_TRACK: 'beta', HUB_OUT: '/tmp/x' };
  const config = parseConfig(['android'], env);
  assert.deepEqual([config.platform, config.dryRun, config.build, config.channel, config.track, config.out], ['ios', false, '12', 'play', 'beta', '/tmp/x']);
  const flagged = parseConfig(['android', '--platform', 'android', '--dry-run', 'true', '--build', '13', '--out', '/tmp/y'], env);
  assert.deepEqual([flagged.platform, flagged.dryRun, flagged.build, flagged.out], ['android', true, '13', '/tmp/y']);
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
  ];
  for (const [argv, env] of bad) assert.throws(() => parseConfig(argv, env), undefined, JSON.stringify([argv, env]));
});

test('every documented command parses', () => {
  for (const command of commands) assert.equal(parseConfig([command], {}).command, command);
});

test('hooks see the HUB_ variables and never a store or GitHub token', () => {
  const config = parseConfig(['android', '--build', '9', '--dry-run', 'false', '--channel', 'play', '--out', '/o'], {});
  const env = hookEnvironment(config, { PATH: '/bin', PLAY_TOKEN: 'secret-a', GH_TOKEN: 'secret-b', KEEP: '1' });
  assert.deepEqual([env.HUB_OUT, env.HUB_BUILD, env.HUB_DRY_RUN, env.HUB_CHANNEL, env.KEEP, env.PATH], ['/o', '9', 'false', 'play', '1', '/bin']);
  assert.equal(env.PLAY_TOKEN, undefined);
  assert.equal(env.GH_TOKEN, undefined);
});

// ---- manifest ----

test('a complete manifest parses', () => {
  const manifest = parseManifest(manifestText());
  assert.equal(manifest.android.package, 'io.example.app');
  assert.equal(manifest.ios.signer_sha1, sha1);
});

test('the manifest is strict', () => {
  const base = JSON.parse(manifestText());
  const mutate = change => JSON.stringify(change(structuredClone(base)));
  const cases = {
    'schema 2': mutate(m => { m.schema = 2; }),
    'unknown top key': mutate(m => { m.deploy = 'x'; }),
    'unknown android key': mutate(m => { m.android.extra = 'x'; }),
    'hook not a string': mutate(m => { m.android.export = ['node', 'x']; }),
    'empty hook': mutate(m => { m.ios.upload = '  '; }),
    'missing version hook': mutate(m => { delete m.version; }),
    'bad signer digest': mutate(m => { m.android.signer_sha256 = 'ABC'; }),
    'artifact outside the checkout': mutate(m => { m.android.artifact = '../App.apk'; }),
    'artifact absolute': mutate(m => { m.android.artifact = '/tmp/App.apk'; }),
    'artifact not an apk': mutate(m => { m.android.artifact = 'artifacts/App.zip'; }),
    'export and godot': mutate(m => { m.android.godot = { path: 'game', preset: 'Android' }; }),
    'ios archive with a path': mutate(m => { m.ios.archive = 'out/App-xcode.tgz'; }),
    'ios secret that is not op://': mutate(m => { m.ios.secrets = ['hunter2']; }),
    'bad bundle': mutate(m => { m.ios.bundle = 'not a bundle'; }),
    'bad sha1': mutate(m => { m.ios.signer_sha1 = 'abc'; }),
    'bundle_artifact without bundle': mutate(m => { m.android.bundle_artifact = 'a.aab'; }),
    'no platform': JSON.stringify({ schema: 1, version: 'echo' }),
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

// ---- plan ----

test('plan announces the version and which lanes run', async () => {
  const f = await fixture();
  try {
    const outputs = await plan(f.configure('plan'), { env: f.env });
    assert.deepEqual(outputs, { version: '0.3.0', android_code: 4, run_android: true, run_ios: true, dry_run: true, channel: 'sideload' });
    assert.match(await readFile(f.env.GITHUB_OUTPUT, 'utf8'), /^version=0\.3\.0\nandroid_code=4\nrun_android=true\nrun_ios=true\ndry_run=true\nchannel=sideload\n$/);
    const iosOnly = await plan(f.configure('plan', ['--platform', 'ios']), { env: f.env });
    assert.deepEqual([iosOnly.run_android, iosOnly.run_ios], [false, true]);
  } finally { await f.cleanup(); }
});

test('a tag must equal the version in the presets', async () => {
  const f = await fixture();
  try {
    assert.equal(tagVersion({ GITHUB_REF_TYPE: 'branch', GITHUB_REF_NAME: 'main' }), undefined);
    assert.equal(tagVersion({ GITHUB_REF_TYPE: 'tag', GITHUB_REF_NAME: 'v0.3.0' }), '0.3.0');
    assert.throws(() => tagVersion({ GITHUB_REF_TYPE: 'tag', GITHUB_REF_NAME: 'ios-v0.3.0' }), /must look like vX\.Y\.Z/);
    await assert.rejects(plan(f.configure('plan'), { env: { ...f.env, GITHUB_REF_TYPE: 'tag', GITHUB_REF_NAME: 'v0.4.0' } }), /tag v0\.4\.0 differs from the version 0\.3\.0/);
    await plan(f.configure('plan'), { env: { ...f.env, GITHUB_REF_TYPE: 'tag', GITHUB_REF_NAME: 'v0.3.0' } });
  } finally { await f.cleanup(); }
});

test('the version hook must print X.Y.Z JSON, and android_code when Android runs', () => {
  assert.deepEqual(parseVersion('noise\n{"version":"1.2.3","android_code":9}\n'), { version: '1.2.3', android_code: 9 });
  assert.throws(() => parseVersion('{"version":"1.2"}'), /expected X\.Y\.Z/);
  assert.throws(() => parseVersion('not json'), /one line of JSON/);
  assert.throws(() => parseVersion('{"version":"1.2.3","android_code":0}'), /bad android_code/);
  assert.throws(() => parseVersion('{"version":"1.2.3"}', { needAndroid: true }), /android_code/);
});

test('play is refused with a clear message while the app declares no bundle hook', async () => {
  const f = await fixture();
  try {
    await assert.rejects(plan(f.configure('plan', ['--channel', 'play']), { env: f.env }), /needs an android\.bundle hook.*Use android_channel=sideload/);
  } finally { await f.cleanup(); }
});

test('a real Play run also needs the keyless-auth inputs', async () => {
  const manifest = JSON.parse(manifestText());
  manifest.android.bundle = 'true';
  manifest.android.bundle_artifact = 'artifacts/App.aab';
  const f = await fixture(JSON.stringify(manifest));
  try {
    await plan(f.configure('plan', ['--channel', 'play']), { env: f.env });
    await assert.rejects(plan(f.configure('plan', ['--channel', 'play', '--dry-run', 'false']), { env: f.env }), /wif_provider and play_sa/);
    await plan(f.configure('plan', ['--channel', 'play', '--dry-run', 'false']), { env: { ...f.env, HUB_WIF_PROVIDER: 'projects/1/x', HUB_PLAY_SA: 'sa@x.iam.gserviceaccount.com' } });
  } finally { await f.cleanup(); }
});

test('asking for a platform the manifest lacks fails in the plan', async () => {
  const manifest = JSON.parse(manifestText());
  delete manifest.ios;
  const f = await fixture(JSON.stringify(manifest));
  try {
    await assert.rejects(plan(f.configure('plan', ['--platform', 'ios']), { env: f.env }), /no ios section/);
    await plan(f.configure('plan', ['--platform', 'android']), { env: f.env });
  } finally { await f.cleanup(); }
});

// ---- android lane ----

test('android dry run exports, checks the signer, copies artifacts and writes a dry-run receipt', async () => {
  const f = await fixture();
  try {
    const result = await android(f.configure('android'), { env: f.env, home: '/nonexistent' });
    assert.equal(result.signer, signer);
    const dir = join(f.out, 'android');
    for (const name of ['App.apk', 'android-receipt.json', 'hub-receipt-android.json']) assert.ok(existsSync(join(dir, name)), name);
    const receipt = JSON.parse(await readFile(join(dir, 'hub-receipt-android.json'), 'utf8'));
    assert.equal(receipt.dry_run, true);
    assert.equal(receipt.signer, signer);
    assert.equal(receipt.version, '0.3.0');
    assert.equal(receipt.android_code, '4');
    assert.equal(receipt.sha, 'abc123');
    assert.equal(receipt.artifacts[0].name, 'App.apk');
    const seen = await readFile(join(dir, 'hook-env.txt'), 'utf8').catch(() => '');
    assert.doesNotMatch(seen, /TOKEN/);
  } finally { await f.cleanup(); }
});

test('android fails when the signer is not the pinned one', async () => {
  const f = await fixture();
  try {
    await assert.rejects(android(f.configure('android'), { env: { ...f.env, FAKE_SIGNER: other }, home: '/nonexistent' }), /differs from the pinned/);
  } finally { await f.cleanup(); }
});

test('android fails when the app receipt names another version than the plan', async () => {
  const f = await fixture();
  try {
    await assert.rejects(android({ ...f.configure('android'), version: '0.9.9' }, { env: f.env, home: '/nonexistent' }), /says version 0\.3\.0 but the plan says 0\.9\.9/);
  } finally { await f.cleanup(); }
});

test('android fails when the hook produces no artifact', async () => {
  const manifest = JSON.parse(manifestText());
  manifest.android.export = 'true';
  const f = await fixture(JSON.stringify(manifest));
  try {
    await assert.rejects(android(f.configure('android'), { env: f.env, home: '/nonexistent' }), /did not produce artifacts\/App\.apk/);
  } finally { await f.cleanup(); }
});

test('a failing hook fails the lane', async () => {
  const manifest = JSON.parse(manifestText());
  manifest.android.prepare = 'exit 3';
  const f = await fixture(JSON.stringify(manifest));
  try {
    await assert.rejects(android(f.configure('android'), { env: f.env, home: '/nonexistent' }), /hook android\.prepare failed \(exit 3\)/);
  } finally { await f.cleanup(); }
});

// ---- dry run never publishes ----

test('play and release refuse on a dry run, and the CLI exits non-zero', async () => {
  const f = await fixture();
  try {
    await assert.rejects(play(f.configure('play', ['--channel', 'play']), { env: f.env }), /refusing to contact Play on a dry run/);
    await assert.rejects(release(f.configure('release'), { env: f.env }), /refusing to publish a release on a dry run/);
    for (const command of ['play', 'release']) {
      const run = spawnSync('node', [hub, command, '--manifest', 'mobile-deploy.json', '--out', f.out], { cwd: f.app, env: f.env, encoding: 'utf8' });
      assert.notEqual(run.status, 0, command);
      assert.match(run.stderr, /dry run/, command);
    }
    assert.equal(existsSync(join(f.root, 'gh-calls.txt')), false, 'gh was never called');
  } finally { await f.cleanup(); }
});

test('release publishes the APK and receipts to a private release, and refuses to overwrite one', async () => {
  const f = await fixture();
  try {
    await android(f.configure('android'), { env: f.env, home: '/nonexistent' });
    const real = f.configure('release', ['--dry-run', 'false']);
    await assert.rejects(release(real, { env: f.env }), /GH_TOKEN is empty/);
    const result = await release(real, { env: { ...f.env, GH_TOKEN: 'token' } });
    assert.equal(result.tag, 'v0.3.0');
    const calls = (await readFile(join(f.root, 'gh-calls.txt'), 'utf8')).trim().split('\n');
    assert.match(calls[0], /^release view v0\.3\.0 --repo owner\/app$/);
    assert.match(calls[1], /^release create v0\.3\.0 .*App\.apk .*android-receipt\.json .*hub-receipt-android\.json --repo owner\/app --target abc123 --title Android 0\.3\.0 --notes /);
    await rm(join(f.root, 'gh-calls.txt'));
    await assert.rejects(release(real, { env: { ...f.env, GH_TOKEN: 'token', FAKE_RELEASE_EXISTS: '0' } }), /release v0\.3\.0 already exists/);
    assert.deepEqual(releaseArguments({ tag: 't', repo: 'r', sha: 's', title: 'T', notes: 'N', assets: ['a'] }), ['release', 'create', 't', 'a', '--repo', 'r', '--target', 's', '--title', 'T', '--notes', 'N']);
  } finally { await f.cleanup(); }
});

test('release only runs for the sideload channel', async () => {
  const f = await fixture();
  try {
    await assert.rejects(release(f.configure('release', ['--dry-run', 'false', '--channel', 'play']), { env: { ...f.env, GH_TOKEN: 'token' } }), /only the sideload channel/);
  } finally { await f.cleanup(); }
});

// ---- ios lanes ----

test('ios export checks the archive against the app receipt and writes a receipt', async () => {
  const f = await fixture();
  try {
    const result = await iosExport(f.configure('ios-export'), { env: f.env });
    assert.equal(result.receipt.version, '0.3.0');
    const receipt = JSON.parse(await readFile(join(f.out, 'ios/hub-receipt-ios-export.json'), 'utf8'));
    assert.equal(receipt.dry_run, true);
    assert.equal(receipt.build, '7');
    assert.equal(receipt.artifacts[0].name, 'App-xcode.tgz');
  } finally { await f.cleanup(); }
});

test('ios export rejects a receipt for another bundle', async () => {
  const manifest = JSON.parse(manifestText());
  manifest.ios.bundle = 'io.example.other';
  const f = await fixture(JSON.stringify(manifest));
  try {
    await assert.rejects(iosExport(f.configure('ios-export'), { env: f.env }), /names bundle io\.example\.app, the manifest pins io\.example\.other/);
  } finally { await f.cleanup(); }
});

// The Linux half's output, as the Mac job receives it. The receipt carries the archive checksum, as the app's tool writes it.
async function handoff(f) {
  await iosExport(f.configure('ios-export'), { env: f.env });
  const { createHash } = await import('node:crypto');
  const archive = join(f.out, 'ios/App-xcode.tgz');
  const receiptFile = join(f.out, 'ios/testflight-export.json');
  const receipt = JSON.parse(await readFile(receiptFile, 'utf8'));
  receipt.tarball_sha256 = createHash('sha256').update(await readFile(archive)).digest('hex');
  await writeFile(receiptFile, JSON.stringify(receipt));
  return { archive, receiptFile };
}

test('ios dry run verifies the toolchain and handoff, and never calls upload or assign', async () => {
  const f = await fixture();
  try {
    await handoff(f);
    const result = await iosUpload(f.configure('ios-upload', ['--dry-handoff', 'true']), { env: f.env });
    assert.ok(result.notes.some(note => /handoff verified/.test(note)));
    assert.ok(result.notes.some(note => /dry run: upload and assign were not called/.test(note)));
    assert.equal(existsSync(join(f.out, 'marker.txt')), false, 'neither hook ran');
    const receipt = JSON.parse(await readFile(join(f.out, 'ios/hub-receipt-ios-upload.json'), 'utf8'));
    assert.equal(receipt.dry_run, true);
    const calls = await readFile(join(f.root, 'op-calls.txt'), 'utf8');
    assert.match(calls, /read --no-newline op:\/\/Vault\/Item\/key_id/);
    assert.match(calls, /read --no-newline op:\/\/Vault\/Item\/credential/);
  } finally { await f.cleanup(); }
});

test('ios dry run without the archive still passes, and says the handoff was not exercised', async () => {
  const f = await fixture();
  try {
    const { archive } = await handoff(f);
    await rm(archive);
    const result = await iosUpload(f.configure('ios-upload'), { env: f.env });
    assert.ok(result.notes.some(note => /handoff not exercised/.test(note)));
    await assert.rejects(iosUpload(f.configure('ios-upload', ['--dry-handoff', 'true']), { env: f.env }), /App-xcode\.tgz is missing/);
  } finally { await f.cleanup(); }
});

test('secret values never reach the log', async () => {
  const f = await fixture();
  try {
    const { archive } = await handoff(f);
    await rm(archive);
    const run = spawnSync('node', [hub, 'ios-upload', '--manifest', 'mobile-deploy.json', '--out', f.out, '--version', '0.3.0'], { cwd: f.app, env: f.env, encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    assert.doesNotMatch(run.stdout + run.stderr, /SECRETVALUE/);
    assert.match(run.stdout, /HUB_IOS_DRY_RUN/);
  } finally { await f.cleanup(); }
});

test('ios refuses a missing signing identity, a tampered handoff and an archive without an xcodeproj', async () => {
  const f = await fixture();
  try {
    const { archive, receiptFile } = await handoff(f);
    const real = f.configure('ios-upload', ['--dry-handoff', 'true', '--dry-run', 'false']);
    await script(join(f.root, 'bin/security'), 'echo "     0 valid identities found"');
    await assert.rejects(iosUpload(real, { env: f.env }), /not a valid codesigning identity/);
    await script(join(f.root, 'bin/security'), `echo '  1) ${sha1} "x"'`);
    await writeFile(archive, 'tampered');
    await assert.rejects(iosUpload(real, { env: f.env }), /differs from the receipt/);
    const { createHash } = await import('node:crypto');
    await writeFile(join(f.root, 'empty.txt'), 'x');
    spawnSync('tar', ['-czf', archive, '-C', f.root, 'empty.txt']);
    const receipt = JSON.parse(await readFile(receiptFile, 'utf8'));
    receipt.tarball_sha256 = createHash('sha256').update(await readFile(archive)).digest('hex');
    await writeFile(receiptFile, JSON.stringify(receipt));
    await assert.rejects(iosUpload(real, { env: f.env }), /holds no \.xcodeproj/);
    assert.equal(existsSync(join(f.out, 'marker.txt')), false, 'a failed preflight never reaches upload');
  } finally { await f.cleanup(); }
});

test('a failed secret reference stops the preflight without printing the value', async () => {
  const f = await fixture();
  try {
    await handoff(f);
    await script(join(f.root, 'bin/op'), 'echo "[ERROR] not signed in" >&2\nexit 1');
    await assert.rejects(iosUpload(f.configure('ios-upload', ['--dry-handoff', 'true']), { env: f.env }), /op could not read op:\/\/Vault\/Item\/key_id/);
  } finally { await f.cleanup(); }
});

test('a real ios run uploads then assigns, in that order', async () => {
  const f = await fixture();
  try {
    await handoff(f);
    await iosUpload(f.configure('ios-upload', ['--dry-run', 'false']), { env: f.env });
    assert.equal(await readFile(join(f.out, 'marker.txt'), 'utf8'), 'uploaded\nassigned\n');
    const receipt = JSON.parse(await readFile(join(f.out, 'ios/hub-receipt-ios-upload.json'), 'utf8'));
    assert.equal(receipt.dry_run, false);
  } finally { await f.cleanup(); }
});

test('a real ios run needs the archive', async () => {
  const f = await fixture();
  try {
    const { archive } = await handoff(f);
    await rm(archive);
    await assert.rejects(iosUpload(f.configure('ios-upload', ['--dry-run', 'false']), { env: f.env }), /App-xcode\.tgz is missing/);
    assert.equal(existsSync(join(f.out, 'marker.txt')), false);
  } finally { await f.cleanup(); }
});

// ---- play uploader ----

function playApi({ bundles = [], apks = [], uploadedCode = 5, failOn } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const { pathname } = new URL(url);
    calls.push({ method: init.method, path: pathname, body: init.body, auth: init.headers.Authorization });
    const reply = (value, ok = true) => ({ ok, status: ok ? 200 : 500, json: async () => value, text: async () => JSON.stringify(value) });
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

test('play upload creates an edit, uploads, assigns a draft release and commits', async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.root, 'app.aab'), 'aab');
    const api = playApi({ bundles: [{ versionCode: 3 }], uploadedCode: 5 });
    const logs = [];
    const result = await uploadBundle({ pkg: 'io.example.app', track: 'internal', aab: join(f.root, 'app.aab'), token: 'tok', expectedCode: 5, fetchImpl: api.fetchImpl, log: line => logs.push(line) });
    assert.equal(result.status, 'draft');
    const put = api.calls.find(call => call.method === 'PUT');
    assert.deepEqual(JSON.parse(put.body), { track: 'internal', releases: [{ versionCodes: ['5'], status: 'draft' }] });
    assert.ok(api.calls.at(-1).path.endsWith(':commit'));
    assert.ok(api.calls.every(call => call.auth === 'Bearer tok'));
    assert.ok(logs.every(line => !line.includes('tok')));
  } finally { await f.cleanup(); }
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

test('the play command reads its token from PLAY_TOKEN and uses the draft status by default', async () => {
  const manifest = JSON.parse(manifestText());
  manifest.android.bundle = 'true';
  manifest.android.bundle_artifact = 'artifacts/App.aab';
  const f = await fixture(JSON.stringify(manifest));
  try {
    await mkdir(join(f.out, 'android'), { recursive: true });
    await writeFile(join(f.out, 'android/App.aab'), 'aab');
    const api = playApi({ uploadedCode: 4 });
    const real = f.configure('play', ['--dry-run', 'false', '--channel', 'play', '--track', 'alpha']);
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
    const summary = join(f.root, 'summary.md');
    const file = await writeReceipt(join(f.root, 'r'), receipt, { GITHUB_STEP_SUMMARY: summary });
    assert.ok(existsSync(file));
    assert.match(await readFile(summary, 'utf8'), /Hub receipt: android/);
    assert.match(summaryMarkdown(receipt), /a\.apk/);
    await assert.rejects(setOutputs({ evil: 'a\nb=c' }, f.env), /line break/);
  } finally { await f.cleanup(); }
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
  const groups = [...workflow.matchAll(/^\s+group: (mobile-deploy-[\w-]+)-\$\{\{ github\.repository \}\}$/gm)].map(match => match[1]);
  assert.deepEqual(groups, ['mobile-deploy-android', 'mobile-deploy-ios-export', 'mobile-deploy-ios-upload']);
  assert.equal([...workflow.matchAll(/cancel-in-progress: false/g)].length, 3);
  const checkouts = [...workflow.matchAll(/uses: actions\/checkout@v4\n\s+with:\n\s+ref: \$\{\{ github\.sha \}\}/g)];
  assert.equal(checkouts.length, 4, 'every job, the Mac included, checks out the built sha');
  const refs = new Set([...workflow.matchAll(/uses: delorenj\/mobile-deploy-hub\/actions\/hub@(\S+)/g)].map(match => match[1]));
  assert.equal(refs.size, 1, 'one hub ref everywhere; flip them together');
  assert.match(workflow, /retention-days: \$\{\{ inputs\.dry_run && 1 \|\| 7 \}\}/);
  assert.match(workflow, /if: \$\{\{ !inputs\.dry_run \|\| inputs\.dry_handoff \}\}/);
  assert.match(workflow, /needs: \[plan, ios-export\]/);
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
});

test('the old relay is gone', () => {
  assert.equal(existsSync(join(repoRoot, 'tools/ci/deploy-hub.mjs')), false);
  assert.equal(existsSync(join(repoRoot, '.github/workflows/deploy.yml')), false);
});
