// v3 tests: the bump rules, the bump transaction against a real git remote, the S26 and iPad parsers, the event
// payload, the forbidden-command guard, and end-to-end dry and real runs through fake adb, aapt2, apksigner and
// bb-emit that record every call. A dry run must never push, install or emit.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseConfig } from './lib/config.mjs';
import { checkBump, levels, nextVersion, parseVersionInfo } from './lib/version.mjs';
import { bumpTransaction, createGit, parseRemoteTag, parseStatus } from './lib/git.mjs';
import { createAdb, findPhone, parseBaseApk, parseDeviceList, parseMdnsEndpoint, parsePackage, parseSha256, peekInstalled } from './lib/adb.mjs';
import { createIpad, pickApp, pickIpad } from './lib/devicectl.mjs';
import { reachIpad } from './commands/common.mjs';
import { bbEmitPath, correlationFor, deploymentEvent, emitArgs, sanitizeReason, targetOf, uuidv5 } from './lib/announce.mjs';
import { loadDevices, parseDevices } from './lib/devices.mjs';
import { parseManifest } from './lib/manifest.mjs';
import { android, announce, plan, play, preflightIos, release } from './hub.mjs';
import { acquireLease, listReservations, releaseLease, releaseReservation, reserve, updateLease } from './lib/lock.mjs';
import { reserveFor } from './commands/common.mjs';
import { readEvents } from './lib/events.mjs';
import { checkPhone, lanesFrom, parseArguments, phone } from '../deploy.mjs';

hermetic(); // offline and outside any workflow job, on every host (test-fixtures.mjs)

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const signer = '2d4954863dabb5da86d69ce4b60b3e400e73669b50a80658b0941440a7941a97';
const devices = loadDevices({});

// ---------------------------------------------------------------------------------------------------- bump rules

test('every deploy bumps: patch, minor or major, and never "none"', () => {
  assert.deepEqual([...levels], ['patch', 'minor', 'major']);
  assert.equal(nextVersion('0.2.1', 'patch'), '0.2.2');
  assert.equal(nextVersion('0.2.9', 'minor'), '0.3.0');
  assert.equal(nextVersion('0.9.9', 'major'), '1.0.0');
  assert.throws(() => nextVersion('0.2.1', 'none'), /bump must be one of patch, minor, major/);
  assert.throws(() => nextVersion('preview-19', 'patch'), /not X\.Y\.Z/);
  assert.throws(() => parseConfig(['plan'], { HUB_BUMP: 'none' }), /bump must be one of patch, minor, major/);
  assert.equal(parseConfig(['plan'], {}).bump, 'patch');
  assert.throws(() => parseArguments(['--bump', 'none']), /bump must be one of patch, minor, major/);
});

test('the front door leaves --bump blank by default, so a red last real run is not overridden by accident', () => {
  assert.deepEqual([parseArguments([]).bump, parseArguments([]).bumpGiven], ['patch', false]);
  assert.deepEqual([parseArguments(['--bump', '']).bump, parseArguments(['--bump', '']).bumpGiven], ['patch', false], 'mise passes "" for an unset flag');
  assert.equal(parseArguments(['--bump', 'minor']).bumpGiven, true);
  assert.equal(parseArguments(['--dry-run', 'false']).dryRun, false);
  assert.equal(parseArguments([]).dryRun, true, 'a dry run unless told otherwise');
});

test('checkBump holds the hook to the exact increment and a growing Android code', () => {
  const current = { version: '0.2.1', android_code: 4 };
  assert.equal(checkBump(current, { version: '0.2.2', android_code: 5 }, 'patch'), '0.2.2');
  assert.equal(checkBump(current, { version: '0.3.0', android_code: 5 }, 'minor'), '0.3.0');
  assert.throws(() => checkBump(current, { version: '0.2.3', android_code: 5 }, 'patch'), /produced 0\.2\.3; 0\.2\.1 bumped patch is 0\.2\.2/);
  assert.throws(() => checkBump(current, { version: '0.2.2', android_code: 4 }, 'patch'), /left android_code at 4/);
  assert.throws(() => checkBump(current, { version: '0.2.2' }, 'patch'), /dropped android_code/);
  assert.equal(checkBump({ version: '0.2.1' }, { version: '0.2.2' }, 'patch'), '0.2.2', 'an iOS-only app has no Android code');
});

test('the bump hook must list the files it changed, inside the checkout', () => {
  const info = parseVersionInfo('log line\n{"version":"0.2.2","android_code":5,"ios_build":"0.2.2","files":["b.cfg","a.toml","b.cfg"]}\n', { hook: 'version.bump', needFiles: true });
  assert.deepEqual(info, { version: '0.2.2', android_code: 5, ios_build: '0.2.2', files: ['a.toml', 'b.cfg'] });
  assert.throws(() => parseVersionInfo('{"version":"0.2.2"}', { needFiles: true }), /must list the files/);
  for (const bad of ['/etc/passwd', '../x', 'a/../../b', '']) assert.throws(() => parseVersionInfo(JSON.stringify({ version: '0.2.2', files: [bad] }), { needFiles: true }), /outside the checkout/, bad);
  assert.throws(() => parseVersionInfo('{"version":"0.2.2"}', { needAndroid: true }), /android_code/);
  assert.throws(() => parseVersionInfo('{"version":"0.2.2","ios_build":"x"}'), /bad ios_build/);
});

test('git status and ls-remote output are parsed exactly', () => {
  assert.deepEqual(parseStatus(' M game/export_presets.cfg\0R  new.txt\0old.txt\0?? x y.txt\0'), ['game/export_presets.cfg', 'new.txt', 'old.txt', 'x y.txt']);
  const sha = 'a'.repeat(40);
  const commit = 'b'.repeat(40);
  assert.deepEqual(parseRemoteTag(`${sha}\trefs/tags/v1.0.0\n${commit}\trefs/tags/v1.0.0^{}\n`, 'v1.0.0'), { object: sha, commit });
  assert.deepEqual(parseRemoteTag(`${sha}\trefs/tags/v1.0.0\n`, 'v1.0.0'), { object: sha, commit: sha });
  assert.equal(parseRemoteTag(`${sha}\trefs/tags/v1.0.01\n`, 'v1.0.0'), null);
});

// ---------------------------------------------------------------------------------------------------- git fixture

async function script(path, body) {
  await writeFile(path, `#!/bin/sh\n${body}\n`);
  await chmod(path, 0o755);
}

// The app's version tool: version.json is the authority; `bump <level>` rewrites it and lists it.
const versionTool = `import { readFileSync, writeFileSync } from 'node:fs';
const state = JSON.parse(readFileSync('version.json', 'utf8'));
const [command, level] = process.argv.slice(2);
if (command === 'bump') {
  const [a, b, c] = state.version.split('.').map(Number);
  state.version = level === 'major' ? \`\${a + 1}.0.0\` : level === 'minor' ? \`\${a}.\${b + 1}.0\` : \`\${a}.\${b}.\${c + 1}\`;
  state.android_code += 1;
  writeFileSync('version.json', JSON.stringify(state) + '\\n');
  console.log(JSON.stringify({ ...state, ios_build: String(state.android_code), files: ['version.json'] }));
} else {
  console.log(JSON.stringify({ ...state, ios_build: String(state.android_code) }));
}
`;

function git(cwd, args, env) {
  return execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

// A bare origin with main, and a full clone of it as the runner's checkout. The machine's global git config and
// hooks are switched off, so the only hooks are the fixture's own pre-push recorder.
async function gitFixture({ manifest, version = { version: '0.2.1', android_code: 4 } } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'hub-v3-'));
  const origin = join(root, 'origin.git');
  const seed = join(root, 'seed');
  const app = join(root, 'app');
  const out = join(root, 'out');
  const globalConfig = join(root, 'gitconfig');
  await writeFile(globalConfig, '[user]\n\tname = Test\n\temail = test@example.com\n[init]\n\tdefaultBranch = main\n');
  const env = { ...process.env, GIT_CONFIG_GLOBAL: globalConfig, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' };
  for (const name of ['GH_TOKEN', 'GITHUB_TOKEN', 'HUB_OUT', 'GIT_CONFIG_COUNT']) delete env[name];
  git(root, ['init', '-q', '--bare', '-b', 'main', origin], env);
  git(root, ['init', '-q', '-b', 'main', seed], env);
  await writeFile(join(seed, 'version.json'), JSON.stringify(version) + '\n');
  await writeFile(join(seed, 'version.mjs'), versionTool);
  await writeFile(join(seed, '.gitignore'), 'artifacts/\n');
  await writeFile(join(seed, 'mobile-deploy.json'), JSON.stringify(manifest ?? v3Manifest()));
  git(seed, ['add', '-A'], env);
  git(seed, ['commit', '-q', '-m', 'init'], env);
  git(seed, ['push', '-q', origin, 'main'], env);
  git(root, ['clone', '-q', origin, app], env);
  const hooks = join(root, 'hooks');
  await mkdir(hooks);
  await script(join(hooks, 'pre-push'), `echo "pre-push $*" >> "${root}/pre-push.log"\n[ -f "${root}/refuse-push" ] && { echo "guard: refusing" >&2; exit 1; }\nexit 0`);
  git(app, ['config', 'core.hooksPath', hooks], env);
  await mkdir(out, { recursive: true });
  const remote = args => git(root, ['--git-dir', origin, ...args], env).trim();
  return { root, origin, seed, app, out, env, remote, cleanup: () => rm(root, { recursive: true, force: true }) };
}

function v3Manifest(extra = {}) {
  return {
    schema: 2,
    project: { slug: 'example-app', name: 'Example App' },
    version: { read: 'node version.mjs', bump: 'node version.mjs bump' },
    android: {
      package: 'io.example.app',
      export: 'mkdir -p artifacts && node -e "const v=require(\'./version.json\');require(\'fs\').writeFileSync(\'artifacts/App.apk\',\'io.example.app \'+v.version+\' \'+v.android_code+\' \'+(process.env.APK_SALT||\'\'))"',
      artifact: 'artifacts/App.apk',
      signer_sha256: signer,
    },
    ...extra,
  };
}

const readJson = file => JSON.parse(readFileSync(file, 'utf8'));

function transactionArgs(f, { level = 'patch', dryRun = true, beforeCommit } = {}) {
  const gitApi = createGit({ cwd: f.app, env: f.env });
  const read = () => parseVersionInfo(execFileSync('node', ['version.mjs'], { cwd: f.app, encoding: 'utf8' }));
  return {
    git: gitApi,
    level,
    dryRun,
    onMain: true,
    readVersion: read,
    runBump: lvl => parseVersionInfo(execFileSync('node', ['version.mjs', 'bump', lvl], { cwd: f.app, encoding: 'utf8' }), { hook: 'version.bump', needFiles: true }),
    beforeCommit,
    message: ({ bumped }) => `chore(release): v${bumped.version}`,
    log: () => {},
  };
}

test('a dry-run bump rehearses commit, tag and push, then leaves the remote and the checkout as they were', async () => {
  const f = await gitFixture();
  try {
    const mainBefore = f.remote(['rev-parse', 'main']);
    const result = await bumpTransaction(transactionArgs(f));
    assert.equal(result.committed, false);
    assert.equal(result.rehearsed, true);
    assert.deepEqual([result.current.version, result.next.version, result.next.android_code, result.tag], ['0.2.1', '0.2.2', 5, 'v0.2.2']);
    assert.deepEqual(result.files, ['version.json']);
    assert.match(result.patch, /"version":"0\.2\.2"/, 'the patch carries the bump for the lanes');
    assert.equal(f.remote(['rev-parse', 'main']), mainBefore, 'origin/main did not move');
    assert.equal(f.remote(['tag', '--list']), '', 'no tag reached origin');
    assert.equal(git(f.app, ['rev-parse', 'HEAD'], f.env).trim(), mainBefore, 'the checkout is back on the base commit');
    assert.equal(git(f.app, ['tag', '--list'], f.env).trim(), '', 'the local tag is gone too');
    assert.equal(git(f.app, ['status', '--porcelain'], f.env).trim(), '', 'the checkout is clean');
    assert.match(await readFile(join(f.root, 'pre-push.log'), 'utf8'), /^pre-push origin /m, 'the pre-push guard ran on the rehearsal');
    // The patch applies to a fresh checkout of the same commit, as the lanes do.
    createGit({ cwd: f.app, env: f.env }).apply(Buffer.from(result.patch));
    assert.equal(readJson(join(f.app, 'version.json')).version, '0.2.2');
  } finally { await f.cleanup(); }
});

test('a dry run fails where a real deploy would: the pre-push guard refusing the bump push', async () => {
  const f = await gitFixture();
  try {
    await writeFile(join(f.root, 'refuse-push'), '');
    const mainBefore = f.remote(['rev-parse', 'main']);
    await assert.rejects(bumpTransaction(transactionArgs(f)), /rehearsal `git push --dry-run --atomic`.*failed.*\n[\s\S]*guard: refusing/);
    assert.equal(git(f.app, ['rev-parse', 'HEAD'], f.env).trim(), mainBefore, 'rewound even on failure');
    assert.equal(git(f.app, ['tag', '--list'], f.env).trim(), '');
  } finally { await f.cleanup(); }
});

test('a real bump commits, tags and pushes both to main in one atomic push', async () => {
  const f = await gitFixture();
  try {
    const base = f.remote(['rev-parse', 'main']);
    const result = await bumpTransaction(transactionArgs(f, { dryRun: false, level: 'minor' }));
    assert.equal(result.committed, true);
    assert.equal(result.next.version, '0.3.0');
    const main = f.remote(['rev-parse', 'main']);
    assert.notEqual(main, base);
    assert.equal(main, result.sha);
    assert.equal(f.remote(['rev-parse', 'v0.3.0^{commit}']), main, 'the tag names the bump commit');
    assert.equal(f.remote(['rev-parse', 'main~1']), base, 'one commit on top of main');
    assert.deepEqual(f.remote(['diff', '--name-only', base, main]).split('\n'), ['version.json'], 'the commit holds only the listed files');
    assert.match(f.remote(['log', '-1', '--format=%an %s', main]), /^github-actions\[bot\] chore\(release\): v0\.3\.0$/);
  } finally { await f.cleanup(); }
});

test('a version is never reused: an existing tag on origin stops the bump before any commit', async () => {
  const f = await gitFixture();
  try {
    git(f.seed, ['tag', 'v0.2.2'], f.env);
    git(f.seed, ['push', '-q', f.origin, 'v0.2.2'], f.env);
    const before = f.remote(['rev-parse', 'main']);
    await assert.rejects(bumpTransaction(transactionArgs(f, { dryRun: false })), /tag v0\.2\.2 already exists on origin/);
    assert.equal(f.remote(['rev-parse', 'main']), before);
  } finally { await f.cleanup(); }
});

test('the bump hook must change exactly the files it lists, and the plan can stop it before the commit', async () => {
  const f = await gitFixture();
  try {
    const args = transactionArgs(f);
    args.runBump = () => { execFileSync('node', ['version.mjs', 'bump', 'patch'], { cwd: f.app }); return { version: '0.2.2', android_code: 5, files: ['other.json'] }; };
    await assert.rejects(bumpTransaction(args), /listed other\.json but changed version\.json/);
    const g = await gitFixture();
    try {
      await assert.rejects(bumpTransaction(transactionArgs(g, { dryRun: false, beforeCommit: () => { throw new Error('the S26 already has versionCode 9'); } })), /versionCode 9/);
      assert.equal(g.remote(['tag', '--list']), '');
    } finally { await g.cleanup(); }
  } finally { await f.cleanup(); }
});

test('a push that loses the race to a new main commit bumps again on the new tip', async () => {
  const f = await gitFixture();
  try {
    // The first real push finds main moved: the pre-push hook lands someone else's commit first.
    await script(join(f.root, 'hooks/pre-push'), `if [ ! -f "${f.root}/raced" ]; then touch "${f.root}/raced"; cd "${f.seed}" && git pull -q "${f.origin}" main && echo x > other.txt && git add other.txt && git commit -q -m other && git push -q "${f.origin}" main; fi\nexit 0`);
    const logs = [];
    const args = { ...transactionArgs(f, { dryRun: false }), log: line => logs.push(line) };
    const result = await bumpTransaction(args);
    assert.equal(result.attempts, 2);
    assert.ok(logs.some(line => /HUB_BUMP_RACE main moved/.test(line)), logs.join('\n'));
    assert.equal(f.remote(['rev-parse', 'main~1']), f.remote(['rev-parse', 'main~1']));
    assert.equal(f.remote(['log', '-1', '--format=%s', 'main']), 'chore(release): v0.2.2');
    assert.equal(f.remote(['log', '-1', '--format=%s', 'main~1']), 'other', 'the bump sits on the raced commit');
  } finally { await f.cleanup(); }
});

// v1.2: a tag-versioned app (a monorepo whose main takes only reviewed pull requests) is bumped by its tag alone.
function tagOnlyArgs(f, { dryRun = true } = {}) {
  const tags = () => git(f.app, ['tag', '--list', 'navi-v*'], f.env).trim().split('\n').filter(Boolean).map(tag => tag.slice('navi-v'.length));
  const read = () => ({ version: tags().sort().pop() ?? '0.2.1', android_code: 2001 });
  return {
    ...transactionArgs(f, { dryRun }),
    tagPrefix: 'navi-v',
    tagOnly: true,
    readVersion: read,
    runBump: level => parseVersionInfo(JSON.stringify({ version: nextVersion(read().version, level), android_code: 2002, files: [] }), { hook: 'version.bump', needFiles: true, tagOnly: true }),
  };
}

test('a tag-versioned app: the dry run rehearses the tag push alone and leaves no commit and no tag', async () => {
  const f = await gitFixture();
  try {
    const mainBefore = f.remote(['rev-parse', 'main']);
    const result = await bumpTransaction(tagOnlyArgs(f));
    assert.deepEqual([result.tag, result.sha, result.base, result.patch, result.committed, result.rehearsed], ['navi-v0.2.2', mainBefore, mainBefore, '', false, true]);
    assert.deepEqual(result.files, []);
    assert.equal(f.remote(['rev-parse', 'main']), mainBefore);
    assert.equal(f.remote(['tag', '--list']), '', 'no tag reached origin');
    assert.equal(git(f.app, ['tag', '--list'], f.env).trim(), '', 'the local tag is gone');
    assert.match(await readFile(join(f.root, 'pre-push.log'), 'utf8'), /^pre-push origin /m, 'the pre-push guard ran on the rehearsal');
  } finally { await f.cleanup(); }
});

test('a tag-versioned app: a real bump pushes only the prefixed tag, on main as it was, and never writes main', async () => {
  const f = await gitFixture();
  try {
    git(f.seed, ['tag', 'v2.0.0'], f.env);
    git(f.seed, ['push', '-q', f.origin, 'v2.0.0'], f.env);
    const base = f.remote(['rev-parse', 'main']);
    const result = await bumpTransaction(tagOnlyArgs(f, { dryRun: false }));
    assert.equal(result.committed, true);
    assert.equal(result.sha, base);
    assert.equal(f.remote(['rev-parse', 'main']), base, 'main did not move');
    assert.equal(f.remote(['rev-parse', 'navi-v0.2.2^{commit}']), base, 'the tag names the dispatched tip');
    assert.equal(f.remote(['tag', '--list', 'v*']), 'v2.0.0', 'the repository\'s own tags are untouched');
    await assert.rejects(bumpTransaction(tagOnlyArgs(f, { dryRun: false })), /tag navi-v0\.2\.2 already exists on origin/, 'a version is never reused');
  } finally { await f.cleanup(); }
});

test('a tag-versioned bump hook may not change a file, and a committing one must list its files', () => {
  assert.throws(() => parseVersionInfo('{"version":"0.2.2","android_code":2,"files":["version.json"]}', { hook: 'version.bump', needFiles: true, tagOnly: true }), /tag-versioned/);
  assert.throws(() => parseVersionInfo('{"version":"0.2.2","android_code":2,"files":[]}', { hook: 'version.bump', needFiles: true }), /must list the files/);
  assert.deepEqual(parseVersionInfo('{"version":"0.2.2","android_code":2,"files":[]}', { hook: 'version.bump', needFiles: true, tagOnly: true }).files, []);
});

test('a shallow checkout is refused before anything else', async () => {
  const f = await gitFixture();
  try {
    const shallow = join(f.root, 'shallow');
    git(f.root, ['clone', '-q', '--depth', '1', `file://${f.origin}`, shallow], f.env);
    await assert.rejects(bumpTransaction({ ...transactionArgs(f), git: createGit({ cwd: shallow, env: f.env }) }), /shallow/);
  } finally { await f.cleanup(); }
});

// ---------------------------------------------------------------------------------------------------- S26

test('adb output is parsed: devices, the package block, base.apk and sha256', () => {
  assert.deepEqual(parseDeviceList('* daemon started\nList of devices attached\nadb-R5GL43A7PCH-abc._adb-tls-connect._tcp\tdevice\nemulator-5554\toffline\n\n'), [
    { id: 'adb-R5GL43A7PCH-abc._adb-tls-connect._tcp', state: 'device' }, { id: 'emulator-5554', state: 'offline' },
  ]);
  const dumpsys = 'Packages:\n  Package [io.other] (1):\n    versionCode=99 minSdk=24\n    versionName=9.9.9\n  Package [io.example.app] (2):\n    versionCode=4 minSdk=24 targetSdk=35\n    versionName=0.2.1\n';
  assert.deepEqual(parsePackage(dumpsys, 'io.example.app'), { versionCode: 4, versionName: '0.2.1' });
  assert.equal(parsePackage(dumpsys, 'io.missing'), null);
  assert.equal(parseBaseApk('package:/data/app/~~a==/io.example.app-b==/base.apk\npackage:/data/app/~~a==/io.example.app-b==/split_config.arm64_v8a.apk\n'), '/data/app/~~a==/io.example.app-b==/base.apk');
  assert.equal(parseSha256(`${'c'.repeat(64)}  /data/app/x/base.apk\n`), 'c'.repeat(64));
});

test('peekInstalled keeps to the device state, the recorded id and port, the env port and the package it is given (Story 3.1)', () => {
  const run = (options, answer = () => '') => {
    const calls = [];
    const runner = (command, args, opts) => { calls.push({ args, tracking: opts.env.RUNNER_TRACKING_ID }); return answer(args); };
    const result = peekInstalled({ pkg: 'io.example.app', serial: 'R5GL43A7PCH', env: { RUNNER_TRACKING_ID: 'job-1', ...options.env }, home: '/nonexistent', runner, ...options.rest });
    return { result, calls };
  };
  const dumpsys = 'Packages:\n  Package [io.example.app] (1):\n    versionCode=4\n    versionName=0.2.1\n';
  // (a) a listed S26 that is not in state `device` is unknown, and nothing else is asked
  const offline = run({ env: {} }, () => 'List of devices attached\nadb-R5GL43A7PCH-zz._adb-tls-connect._tcp\toffline\n');
  assert.equal(offline.result.state, 'unknown');
  assert.deepEqual(offline.calls.map(call => call.args), [['-L', 'tcp:127.0.0.1:5037', 'devices']]);
  // (b) a recorded id or port that is not usable is ignored: the default server, and a lookup
  const junk = run({ env: {}, rest: { lease: { device: { adb_id: '-x y', adb_port: 70000 } } } }, () => 'List of devices attached\n');
  assert.equal(junk.result.state, 'unknown');
  assert.deepEqual(junk.calls.map(call => call.args), [['-L', 'tcp:127.0.0.1:5037', 'devices']]);
  // (c) no recorded port: the environment's server port
  const env5040 = run({ env: { ANDROID_ADB_SERVER_PORT: '5040' } }, () => 'List of devices attached\n');
  assert.deepEqual(env5040.calls.map(call => call.args), [['-L', 'tcp:127.0.0.1:5040', 'devices']]);
  assert.equal(env5040.result.adb_port, 5040);
  // a usable id skips the lookup and reads the package
  const read = run({ env: {}, rest: { lease: { device: { adb_id: 'adb-R5GL43A7PCH-zz._adb-tls-connect._tcp', adb_port: 5038 } } } }, () => dumpsys);
  assert.deepEqual([read.result.state, read.result.installed], ['read', { versionCode: 4, versionName: '0.2.1' }]);
  assert.deepEqual(read.calls.map(call => call.args), [['-L', 'tcp:127.0.0.1:5038', '-s', 'adb-R5GL43A7PCH-zz._adb-tls-connect._tcp', 'shell', 'dumpsys', 'package', 'io.example.app']]);
  // (d) no package: unknown, no call at all
  const calls = [];
  const none = peekInstalled({ serial: 'R5GL43A7PCH', env: {}, home: '/nonexistent', runner: (...args) => { calls.push(args); return ''; } });
  assert.deepEqual([none.state, calls.length], ['unknown', 0]);
  for (const call of [...offline.calls, ...junk.calls, ...env5040.calls, ...read.calls]) assert.equal(call.tracking, '', 'the job\'s RUNNER_TRACKING_ID never reaches the adb server');
});

function fakeAdbApi({ listed, props, after = 0 }) {
  let calls = 0;
  return {
    started: 0,
    startServer() { this.started += 1; },
    devices() { calls += 1; return calls > after ? listed : []; },
    prop(id, name) { const value = props[id]?.[name]; if (value === undefined) throw new Error('offline'); return value; },
  };
}

test('findPhone picks the S26 by ro.serialno among several devices, whatever its adb id', async () => {
  const adb = fakeAdbApi({
    listed: [{ id: 'adb-R5CX31AEJDA-x', state: 'device' }, { id: 'adb-R5GL43A7PCH-new', state: 'device' }, { id: 'dead', state: 'offline' }],
    props: { 'adb-R5CX31AEJDA-x': { 'ro.serialno': 'R5CX31AEJDA', 'ro.product.model': 'SM-S921U' }, 'adb-R5GL43A7PCH-new': { 'ro.serialno': 'R5GL43A7PCH', 'ro.product.model': 'SM-S948U' } },
  });
  const id = await findPhone(adb, { serial: 'R5GL43A7PCH', model: 'SM-S948U', log: () => {} });
  assert.equal(id, 'adb-R5GL43A7PCH-new');
  assert.equal(adb.started, 1, 'an idle host gets its adb server started');
});

test('findPhone waits for the phone to reconnect, refuses a wrong model, and names the fix when it never comes', async () => {
  let clock = 0;
  const timing = { sleep: async ms => { clock += ms; }, now: () => clock, log: () => {} };
  const late = fakeAdbApi({ listed: [{ id: 'p', state: 'device' }], props: { p: { 'ro.serialno': 'R5GL43A7PCH', 'ro.product.model': 'SM-S948U' } }, after: 3 });
  assert.equal(await findPhone(late, { serial: 'R5GL43A7PCH', model: 'SM-S948U', waitMs: 60_000, pollMs: 1000, ...timing }), 'p');
  const wrong = fakeAdbApi({ listed: [{ id: 'p', state: 'device' }], props: { p: { 'ro.serialno': 'R5GL43A7PCH', 'ro.product.model': 'SM-X000' } } });
  await assert.rejects(findPhone(wrong, { serial: 'R5GL43A7PCH', model: 'SM-S948U', ...timing }), /model SM-X000, not SM-S948U/);
  clock = 0;
  const other = fakeAdbApi({ listed: [{ id: 'adb-R5CX31AEJDA-x', state: 'device' }], props: { 'adb-R5CX31AEJDA-x': { 'ro.serialno': 'R5CX31AEJDA' } } });
  await assert.rejects(findPhone(other, { serial: 'R5GL43A7PCH', model: 'SM-S948U', waitMs: 10_000, pollMs: 1000, ...timing }), /SM-S948U \(serial R5GL43A7PCH\) is not on this host's adb server after 10s \(devices: adb-R5CX31AEJDA-x \(device\)\)\. Turn on Wireless debugging/);
});

test('a slow mDNS auto-connect is nudged: the phone is looked up in adb mdns services and connected', async () => {
  assert.equal(parseMdnsEndpoint('List of discovered mdns services\nadb-R5CX31AEJDA-YYVl71\t_adb-tls-connect._tcp\t192.168.1.34:34995\nadb-R5GL43A7PCH-NGdiLU\t_adb-tls-connect._tcp\t192.168.1.50:41234\n', 'R5GL43A7PCH'), '192.168.1.50:41234');
  assert.equal(parseMdnsEndpoint('adb-R5GL43A7PCH-x\t_adb-tls-pairing._tcp\t192.168.1.50:5555\n', 'R5GL43A7PCH'), null, 'a pairing endpoint is not a connect endpoint');
  let clock = 0;
  let connected = false;
  const adb = {
    startServer() {},
    devices: () => (connected ? [{ id: '192.168.1.50:41234', state: 'device' }] : []),
    prop: (_id, name) => ({ 'ro.serialno': 'R5GL43A7PCH', 'ro.product.model': 'SM-S948U' })[name],
    mdnsEndpoint: serial => (serial === 'R5GL43A7PCH' ? '192.168.1.50:41234' : null),
    connect: endpoint => { connected = endpoint === '192.168.1.50:41234'; },
  };
  const logs = [];
  assert.equal(await findPhone(adb, { serial: 'R5GL43A7PCH', model: 'SM-S948U', nudgeEvery: 2, sleep: async ms => { clock += ms; }, now: () => clock, log: line => logs.push(line) }), '192.168.1.50:41234');
  assert.ok(logs.some(line => /HUB_S26_CONNECT 192\.168\.1\.50:41234/.test(line)));
});

test('the adb server is started outside the job, so it keeps the phone between jobs', () => {
  const calls = [];
  const adb = createAdb({ env: { RUNNER_TRACKING_ID: 'github_123', HUB_ADB: '/x/adb', GH_TOKEN: 'secret-a', ACTIONS_RUNTIME_TOKEN: 'secret-b' }, runner: (command, args, options) => { calls.push({ command, args, tracking: options.env.RUNNER_TRACKING_ID, env: options.env }); return ''; } });
  adb.startServer();
  adb.devices();
  assert.deepEqual(calls.map(call => [call.args[0], call.tracking]), [['start-server', ''], ['devices', 'github_123']]);
  assert.ok(calls.every(call => !JSON.stringify(call.env).includes('secret-')), 'no token reaches the long-lived adb server');
});

test('the front door looks for the S26 on big-chungus before it dispatches', async () => {
  assert.deepEqual([phone.serial, phone.model], [devices.android.serial, devices.android.model], 'deploy.mjs and devices.json name the same phone');
  const calls = [];
  const adb = args => {
    calls.push(args.join(' '));
    if (args[0] === 'devices') return 'List of devices attached\nadb-R5GL43A7PCH-q\tdevice\n';
    if (args.includes('ro.serialno')) return 'R5GL43A7PCH\n';
    return '';
  };
  assert.deepEqual(await checkPhone({ adb, log: () => {} }), { found: true, id: 'adb-R5GL43A7PCH-q' });
  let clock = 0;
  const none = await checkPhone({ adb: args => (args[0] === 'devices' ? 'List of devices attached\n' : ''), log: () => {}, sleep: async ms => { clock += ms; }, now: () => clock, waitMs: 4000 });
  assert.equal(none.found, false);
  assert.match(none.why, /SM-S948U \(serial R5GL43A7PCH\) is not on this host's adb server/);
});

test('the front door reads the lanes the app declares: no ios section, no iPad lane', () => {
  const workflow = 'jobs:\n  deploy:\n    with:\n      manifest: tools/ci/mobile-deploy.json\n';
  const files = { 'tools/ci/mobile-deploy.json': JSON.stringify({ schema: 2, android: {} }) };
  assert.deepEqual(lanesFrom(workflow, path => files[path]), { android: true, ios: false, manifest: 'tools/ci/mobile-deploy.json' });
  assert.deepEqual(lanesFrom(workflow, () => { throw new Error('missing'); }), { android: true, ios: true, manifest: null }, 'unreadable: assume both');
  assert.equal(lanesFrom('', path => JSON.stringify({ ios: {}, path }))?.ios, true);
});

// ---------------------------------------------------------------------------------------------------- iPad

const devicectlList = (overrides = {}) => ({
  info: { outcome: 'success' },
  result: {
    devices: [
      { identifier: 'SIM', hardwareProperties: { udid: 'C5A1F913-A772-46B2-9752-BDDEA8EE1E12', reality: 'simulated', productType: 'iPad17,4' }, connectionProperties: {}, deviceProperties: { name: 'sim' } },
      {
        identifier: 'CORE-ID',
        hardwareProperties: { udid: devices.ios.udid, reality: 'physical', productType: 'iPad14,5', ...overrides.hardware },
        connectionProperties: { pairingState: 'paired', transportType: 'localNetwork', tunnelState: 'connected', ...overrides.connection },
        deviceProperties: { name: 'Jarad M’s iPad', osVersionNumber: '26.1', developerModeStatus: 'enabled', ...overrides.device },
      },
    ],
  },
});

test('devicectl output is read by UDID: the physical, paired iPad with Developer Mode on', () => {
  const found = pickIpad(devicectlList(), { udid: devices.ios.udid, model: 'iPad14,5' });
  assert.deepEqual(found, { identifier: 'CORE-ID', name: 'Jarad M’s iPad', os: '26.1', transport: 'localNetwork', tunnel: 'connected' });
  assert.throws(() => pickIpad(devicectlList(), { udid: '00008112-0000000000000000', model: 'iPad14,5' }), /not listed by devicectl.*wake it/);
  assert.throws(() => pickIpad(devicectlList({ connection: { pairingState: 'unpaired' } }), { udid: devices.ios.udid, model: 'iPad14,5' }), /not paired/);
  assert.throws(() => pickIpad(devicectlList({ device: { developerModeStatus: 'disabled' } }), { udid: devices.ios.udid, model: 'iPad14,5' }), /Developer Mode is off/);
  assert.throws(() => pickIpad(devicectlList({ hardware: { productType: 'iPad13,1' } }), { udid: devices.ios.udid, model: 'iPad14,5' }), /not the physical iPad14,5/);
  assert.throws(() => pickIpad(devicectlList({ hardware: { reality: 'simulated' } }), { udid: devices.ios.udid, model: 'iPad14,5' }), /not the physical iPad14,5/);
  assert.throws(() => pickIpad(devicectlList({ hardware: { reality: undefined, productType: 'iPad13,1' } }), { udid: devices.ios.udid, model: 'iPad14,5' }), /not the physical iPad14,5/, 'a cached record of another model is still wrong');
  assert.throws(() => pickIpad(devicectlList({ hardware: { reality: undefined }, connection: { pairingState: 'unpaired' } }), { udid: devices.ios.udid, model: 'iPad14,5' }), /not paired/, 'a sparse record that says unpaired is still a failure');
  assert.throws(() => pickIpad(devicectlList({ hardware: { reality: undefined }, device: { developerModeStatus: 'disabled' } }), { udid: devices.ios.udid, model: 'iPad14,5' }), /Developer Mode is off/, 'a sparse record that says Developer Mode is off is still a failure');
});

test('an iPad that devicectl lists without its live hardware details is unavailable (pending), not a failure', async () => {
  // Run 40116263423 (2026-10-24): "devicectl lists 00008112-000138390CFB401E as undefined iPad14,5" failed the whole deploy.
  for (const hardware of [{ reality: undefined }, { reality: undefined, productType: undefined }]) {
    const sparse = devicectlList({ hardware, connection: { pairingState: undefined, tunnelState: 'connected', transportType: undefined }, device: { developerModeStatus: undefined } });
    const found = pickIpad(sparse, { udid: devices.ios.udid, model: 'iPad14,5' });
    assert.equal(found.tunnel, 'unavailable', 'unproven identity is never reachable, whatever tunnel state the cache reports');
    assert.equal(found.identifier, 'CORE-ID');
    let clock = 0;
    const reach = await reachIpad({ find: () => pickIpad(sparse, { udid: devices.ios.udid, model: 'iPad14,5' }) }, { waitMs: 10, pollMs: 5, sleep: async ms => { clock += ms; }, now: () => clock });
    assert.equal(reach.reachable, false);
    assert.equal(reach.reason, 'asleep or away');
    assert.match(reach.detail, /listed by devicectl but unavailable/);
  }
});

test('devicectl app info is read back as version and build', () => {
  const apps = { info: { outcome: 'success' }, result: { apps: [{ bundleIdentifier: 'io.other', version: '9', bundleVersion: '9' }, { bundleIdentifier: 'io.example.app', version: '0.2.1', bundleVersion: 4, builtByDeveloper: true }] } };
  assert.deepEqual(pickApp(apps, 'io.example.app'), { version: '0.2.1', build: '4', developer: true });
  assert.equal(pickApp(apps, 'io.missing'), null);
  const calls = [];
  const ipad = createIpad({ devicectl: (args, timeout) => { calls.push([args, timeout]); return args[0] === 'list' ? devicectlList() : args[1] === 'info' ? apps : { info: { outcome: 'success' } }; }, udid: devices.ios.udid, model: 'iPad14,5' });
  ipad.find();
  assert.equal(ipad.installed('io.example.app').version, '0.2.1');
  ipad.install('/tmp/App.app');
  assert.deepEqual(calls.map(([args]) => args.slice(0, 3).join(' ')), ['list devices', 'device info apps', 'device install app'], 'install in place; nothing else');
});

// ---------------------------------------------------------------------------------------------------- the event

const project = { slug: 'tower-of-lost-things', name: 'Tower of Lost Things' };
const both = { android: true, ios: true };
const runEnv = { GITHUB_REPOSITORY: 'delorenj/tower-of-lost-things', GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '2', HUB_REF: 'v1.1.0' };
const ok = { result: 'success' };
const delivery = (platform, extra = {}) => ({ platform, target: platform === 'android' ? 'SM-S948U' : 'iPad14,5', version: '0.2.2', build: platform === 'android' ? '4' : '5', sha256: 'a'.repeat(64), verified: true, status: 'installed', ...extra });
const allOk = { gate: ok, 'preflight-ios': ok, plan: ok, android: ok, 'ios-export': ok, ios: ok, deliver: ok };
const published = { apk: 'https://s3.delo.sh/builds/tower-of-lost-things/0.2.2/tower-of-lost-things-0.2.2-4.apk', ota: 'itms-services://?action=download-manifest&url=https://s3.delo.sh/builds/tower-of-lost-things/ios/manifest.plist', page: 'https://s3.delo.sh/builds/tower-of-lost-things/index.html', any: true };

test('a deploy to both devices is one completed event naming each delivery, its status and the links', () => {
  const event = deploymentEvent({
    project, declared: both, devices, needs: allOk,
    receipts: { android: { delivery: delivery('android') }, ios: { delivery: delivery('ios') } },
    version: '0.2.2', androidCode: '4', commit: 'b'.repeat(40), published, env: runEnv, now: new Date('2026-10-09T12:00:00.123Z'),
  });
  assert.equal(event.type, 'bloodbank.project.deployment.completed');
  assert.deepEqual(event.data.artifact, { kind: 'mobile-app', name: 'Tower of Lost Things', version: '0.2.2', version_code: 4, commit: 'b'.repeat(40), dirty: false, variant: 'debug', sha256: null });
  assert.deepEqual(event.data.target, { kind: 'device-set', name: 'SM-S948U + iPad14,5', id: null });
  assert.deepEqual(event.data.deliveries.map(item => [item.device, item.status, item.by]), [['S26', 'installed', 'deploy'], ['iPad', 'installed', 'deploy']]);
  assert.equal(event.data.verified, true);
  assert.equal(event.data.trigger, 'deploy');
  assert.deepEqual(event.data.run, { id: '123', attempt: 2, url: 'https://github.com/delorenj/tower-of-lost-things/actions/runs/123', hub_ref: 'v1.1.0' });
  assert.equal(event.data.deployed_at, '2026-10-09T12:00:00Z');
  assert.equal(event.data.summary, 'Tower of Lost Things 0.2.2 (4) bbbbbbb: S26 installed, iPad installed, verified=true');
  assert.deepEqual(event.data.links.map(link => [link.rel, link.label]), [['apk', 'Install APK'], ['page', 'Builds'], ['run', 'Run']], 'no Install on iPad when the iPad has it');
});

test('an away device is pending, not a failure: the event is .completed, verified false, with Install links', () => {
  const event = deploymentEvent({
    project, declared: both, devices, needs: allOk,
    receipts: { android: { delivery: delivery('android', { verified: false, status: 'pending', reason: "not on big-chungus's adb" }) }, ios: { delivery: delivery('ios', { verified: false, status: 'pending', reason: 'the iPad is listed but unavailable' }) } },
    version: '0.2.2', androidCode: '4', commit: 'b'.repeat(40), published, env: runEnv,
  });
  assert.equal(event.type, 'bloodbank.project.deployment.completed');
  assert.equal(event.data.verified, false);
  assert.deepEqual(event.data.deliveries.map(item => [item.status, item.reason]), [['pending', "not on big-chungus's adb"], ['pending', 'the iPad is listed but unavailable']]);
  assert.match(event.data.summary, /: S26 pending, iPad pending, verified=false$/);
  assert.deepEqual(event.data.links.map(link => link.rel), ['apk', 'ota', 'page', 'run']);
});

test('a Mac offline or over its budget leaves the iPad skipped, and --platform narrows to skipped too', () => {
  for (const [iosLane, reason] of [['skip-offline', /offline/], ['skip-metered', /data budget/]]) {
    const event = deploymentEvent({ project, declared: both, devices, needs: { ...allOk, 'preflight-ios': { result: 'skipped' }, 'ios-export': { result: 'skipped' }, ios: { result: 'skipped' } }, receipts: { android: { delivery: delivery('android') } }, version: '0.2.2', androidCode: '4', commit: 'b'.repeat(40), iosLane, published: { ...published, ota: null }, env: runEnv });
    assert.equal(event.type, 'bloodbank.project.deployment.completed', iosLane);
    const ipad = event.data.deliveries.find(item => item.platform === 'ios');
    assert.equal(ipad.status, 'skipped');
    assert.match(ipad.reason, reason);
    assert.equal(event.data.verified, false, 'an in-scope device that was skipped is not verified');
  }
  const narrowed = deploymentEvent({ project, declared: both, platform: 'android', devices, needs: { ...allOk, ios: { result: 'skipped' } }, receipts: { android: { delivery: delivery('android') } }, version: '0.2.2', androidCode: '4', commit: 'b'.repeat(40), iosLane: 'skip-platform', env: runEnv });
  assert.deepEqual(narrowed.data.deliveries.map(item => [item.platform, item.status, item.reason ?? null]), [['android', 'installed', null], ['ios', 'skipped', '--platform android']]);
  assert.equal(narrowed.data.verified, true, '--platform takes the iPad out of scope');
  assert.equal(narrowed.data.artifact.kind, 'android-apk');
});

test('a failed lane makes the deploy a failed event with its stage and a path-free reason', () => {
  const event = deploymentEvent({
    project, declared: both, devices, needs: { ...allOk, ios: { result: 'failure' } },
    receipts: { android: { delivery: delivery('android') }, ios: { stage: 'install', reason: '::error::devicectl failed (/Users/delorenj/Library/x.app)', delivery: delivery('ios', { verified: false }) } },
    version: '0.2.2', androidCode: '4', commit: 'b'.repeat(40), published, env: runEnv,
  });
  assert.equal(event.type, 'bloodbank.project.deployment.failed');
  assert.equal(event.data.stage, 'install');
  assert.equal(event.data.reason, 'devicectl failed (<path>)');
  assert.deepEqual(event.data.deliveries.map(item => [item.platform, item.status, item.stage ?? null]), [['android', 'installed', null], ['ios', 'failed', 'install']]);
  assert.match(event.data.summary, /^Tower of Lost Things 0\.2\.2 \(4\) deploy failed at install: devicectl failed \(<path>\); S26 installed, iPad failed$/);
  assert.deepEqual(event.data.links.map(link => [link.rel, link.label]), [['run', 'Open run'], ['page', 'Builds']]);
});

test('a plan that stopped is the failed event: its stage, and lanes that never ran', () => {
  const event = deploymentEvent({
    project, declared: { android: true, ios: false }, devices,
    needs: { gate: ok, plan: { result: 'failure' }, android: { result: 'skipped' }, deliver: { result: 'skipped' } },
    receipts: { plan: { stage: 'version', reason: 'tag v0.2.2 already exists on origin' } },
    version: '0.2.1', androidCode: '3', commit: 'c'.repeat(40), env: runEnv,
  });
  assert.equal(event.type, 'bloodbank.project.deployment.failed');
  assert.deepEqual([event.data.stage, event.data.reason], ['version', 'tag v0.2.2 already exists on origin']);
  assert.deepEqual(event.data.target, { kind: 'android-device', name: 'SM-S948U', id: 'R5GL43A7PCH' });
  assert.equal(event.data.artifact.kind, 'android-apk');
  assert.deepEqual([event.data.deliveries[0].status, event.data.deliveries[0].stage], ['failed', 'version']);
  assert.deepEqual(event.data.links.map(link => link.rel), ['run'], 'nothing was published');
  assert.equal(sanitizeReason('one\ntwo'), 'one');
  assert.deepEqual(targetOf({ android: false, ios: true }, devices), { kind: 'ios-device', name: 'iPad14,5', id: devices.ios.udid });
});

test('a refused gate and a failed deliver are failed events at their stage', () => {
  const refused = deploymentEvent({ project, declared: both, devices, needs: { gate: { result: 'failure' }, 'preflight-ios': { result: 'skipped' }, plan: { result: 'skipped' } }, receipts: { gate: { stage: 'preflight', reason: 'HUB_GATE_REFUSED caller: not an accepted copy of templates/deploy.yml' } }, version: '0.2.1', androidCode: '3', commit: 'c'.repeat(40), env: runEnv });
  assert.equal(refused.type, 'bloodbank.project.deployment.failed');
  assert.match(refused.data.reason, /^HUB_GATE_REFUSED caller/);
  assert.ok(refused.data.deliveries.every(item => item.status === 'failed'));
  const deliver = deploymentEvent({ project, declared: both, devices, needs: { ...allOk, deliver: { result: 'failure' } }, receipts: { android: { delivery: delivery('android', { status: 'pending', verified: false }) }, ios: { delivery: delivery('ios') }, deliver: { stage: 'deliver', reason: 'mc cp failed' } }, version: '0.2.2', androidCode: '4', commit: 'b'.repeat(40), env: runEnv });
  assert.equal(deliver.type, 'bloodbank.project.deployment.failed');
  assert.deepEqual([deliver.data.stage, deliver.data.reason], ['deliver', 'mc cp failed']);
});

test('reruns correlate: one UUIDv5 per repo and run, a different one for another run', () => {
  assert.equal(uuidv5('www.example.com', '6ba7b810-9dad-11d1-80b4-00c04fd430c8'), '2ed6657d-e927-568b-95e1-2665a8aea6a2', 'RFC 4122 test vector');
  assert.equal(correlationFor(runEnv), correlationFor({ ...runEnv, GITHUB_RUN_ATTEMPT: '3' }));
  assert.notEqual(correlationFor(runEnv), correlationFor({ ...runEnv, GITHUB_RUN_ID: '124' }));
  assert.deepEqual(emitArgs({ type: 't', correlation: 'c', check: true }).slice(-1), ['--check']);
  assert.deepEqual(emitArgs({ type: 't', correlation: 'c', check: false }).slice(-1), ['--strict']);
  assert.equal(emitArgs({ type: 't', correlation: 'c', check: true, producer: 'mobile-deploy-hub-catchup' })[5], 'mobile-deploy-hub-catchup', 'the catch-up names itself (G3)');
});

const realBbEmit = bbEmitPath(process.env);
test('the events the hub sends pass the live Bloodbank contract (bb-emit --check)', { skip: !existsSync(realBbEmit) && 'bb-emit is not installed on this host' }, () => {
  const cases = [
    deploymentEvent({ project, declared: both, devices, needs: allOk, receipts: { android: { delivery: delivery('android', { status: 'pending', verified: false, reason: "not on big-chungus's adb" }) }, ios: { delivery: delivery('ios') } }, version: '0.2.2', androidCode: '4', commit: 'b'.repeat(40), published, env: runEnv }),
    deploymentEvent({ project, declared: both, devices, needs: { ...allOk, ios: { result: 'skipped' }, 'preflight-ios': { result: 'skipped' } }, receipts: { android: { delivery: delivery('android') } }, version: '0.2.2', androidCode: '4', commit: 'b'.repeat(40), iosLane: 'skip-metered', published, env: runEnv }),
    deploymentEvent({ project, declared: { android: false, ios: true }, devices, needs: { ...allOk, ios: { result: 'failure' } }, receipts: { ios: { stage: 'install', reason: 'devicectl device install app did not succeed', delivery: delivery('ios', { verified: false }) } }, version: '0.2.2', androidCode: '', commit: 'b'.repeat(40), env: runEnv }),
    deploymentEvent({ project, declared: both, devices, needs: { ...allOk, deliver: { result: 'failure' } }, receipts: { android: { delivery: delivery('android') }, ios: { delivery: delivery('ios') }, deliver: { stage: 'deliver', reason: 'mc cp failed' } }, version: '0.2.2', androidCode: '4', commit: 'b'.repeat(40), published, env: runEnv }),
    deploymentEvent({ project, declared: both, devices, needs: { gate: ok, plan: { result: 'failure' } }, receipts: { plan: { stage: 'version', reason: 'main kept moving' } }, version: '0.2.1', androidCode: '3', commit: 'b'.repeat(40), env: runEnv }),
  ];
  for (const event of cases) {
    const result = spawnSync(realBbEmit, emitArgs({ type: event.type, correlation: correlationFor(runEnv), check: true }), { input: JSON.stringify(event.data), encoding: 'utf8', timeout: 30_000 });
    assert.equal(result.status, 0, `${event.type}: ${result.stdout}${result.stderr}`);
  }
});

// ---------------------------------------------------------------------------------------------------- guards

test('the hub never removes an app, clears its data or downgrades it', () => {
  const forbidden = [
    [/\buninstall\b/i, 'uninstall'],
    [/\bpm\b["'\s,]+clear\b/, 'pm clear'],
    [/["']install["'](?:\s*,\s*["']-[a-z]+["'])*\s*,\s*["']-[a-z]*d[a-z]*["']/, 'install -d (array form)'],
    [/\binstall(?:\s+-[a-z]+)*\s+-[a-z]*d\b/, 'install -d (shell form)'],
    [/--downgrade|install-multiple/, 'downgrade or split install'],
  ];
  const files = [];
  const walk = dir => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (!entry.name.endsWith('.test.mjs')) files.push(path);
    }
  };
  for (const dir of ['tools', 'actions', '.github']) walk(join(repoRoot, dir));
  assert.ok(files.length > 15, 'the scan saw the hub');
  // tools/verify holds operator-run checks for an EMULATOR (obtainium-check uninstalls the package under test and clears
  // Obtainium's data, so the install it reads back is Obtainium's own). They are no deploy path: each one that would hit
  // the scan must refuse every serial but emulator-NNNN and every device without ro.kernel.qemu=1, and nothing the
  // hub runs (tools/ci, tools/catchup, tools/device, actions, workflows) may name tools/verify.
  const verifyDir = join(repoRoot, 'tools/verify') + '/';
  const emulatorOnly = text => /\/\^emulator-\\d\+\$\/\.test\(serial\)/.test(text) && /getprop ro\.kernel\.qemu'\)\.trim\(\) !== '1'/.test(text);
  const hits = [];
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    if (!file.startsWith(verifyDir) && /tools\/verify\b|obtainium-check/.test(text)) hits.push(`${relative(repoRoot, file)} names tools/verify, which is emulator-only`);
    const own = [];
    text.split('\n').forEach((line, index) => {
      for (const [pattern, name] of forbidden) if (pattern.test(line)) own.push(`${relative(repoRoot, file)}:${index + 1} ${name}: ${line.trim().slice(0, 120)}`);
    });
    if (own.length > 0 && file.startsWith(verifyDir)) assert.ok(emulatorOnly(text), `${relative(repoRoot, file)} removes or clears an app but does not refuse a non-emulator serial and device`);
    else hits.push(...own);
  }
  assert.deepEqual(hits, []);
  // The one install each device gets: in place.
  assert.match(readFileSync(join(repoRoot, 'tools/ci/lib/adb.mjs'), 'utf8'), /install: \(id, apk\) => call\(\['-s', id, 'install', '-r', apk\]/);
  assert.match(readFileSync(join(repoRoot, 'tools/ci/lib/devicectl.mjs'), 'utf8'), /\['device', 'install', 'app', '--device', udid, app\]/);
});

test('devices.json names the phones, the iPad, the team and the Mac once, and is validated', () => {
  assert.deepEqual([devices.android.serial, devices.android.model, devices.android_extra[0].name, devices.android_extra[0].model, devices.android_extra[0].serial, devices.ios.udid, devices.ios.model, devices.apple.team], ['R5GL43A7PCH', 'SM-S948U', 'S24', 'SM-S928U', 'R5CX31AEJDA', '00008112-000138390CFB401E', 'iPad14,5', 'YJ7W7Z36FP']);
  const text = readFileSync(join(repoRoot, 'tools/ci/devices.json'), 'utf8');
  assert.throws(() => parseDevices(text.replace('"R5GL43A7PCH"', '"R5GL 43"')), /android\.serial/);
  assert.throws(() => parseDevices(text.replace('"Library/Caches/mobile-deploy-hub/handoff"', '"../etc"')), /handoff_dir/);
  // the extra phones are hub-device's; a bad one is refused, and none may repeat the deploy phone or its words
  assert.throws(() => parseDevices(text.replace('"R5CX31AEJDA"', '"nope!"')), /android_extra\[\]\.serial/);
  assert.throws(() => parseDevices(JSON.stringify({ ...devices, android_extra: [{ name: 'S26', model: 'SM-S948U', serial: 'R5GL43A7PCH' }] })), /twice/);
  assert.throws(() => parseDevices(JSON.stringify({ ...devices, android_extra: [{ name: 'phone', model: 'SM-S928U', serial: 'R5CX31AEJDA' }] })), /may not be "phone"/);
  assert.throws(() => parseDevices(JSON.stringify({ ...devices, android_extra: [{ name: 'Adb', model: 'SM-S928U', serial: 'R5CX31AEJDA' }] })), /may not be "adb"/, 'an extra named Adb would lease on the deploy lock');
  assert.equal(parseDevices(JSON.stringify({ ...devices, android_extra: undefined })).android_extra, undefined, 'android_extra itself is optional');
});

test('the Mac preflight has no checkout: it needs the bundle id from the gate', async () => {
  const f = await gitFixture();
  try {
    await assert.rejects(preflightIos({ ...parseConfig(['preflight-ios', '--out', f.out], f.env), cwd: f.app }, { env: f.env, log: () => {} }), /needs the bundle id from the gate/);
  } finally { await f.cleanup(); }
});

// Story 2.5 (FR-9, AD-7): preflight-ios runs only when the iPad lane is in scope, and reserves mac-ios on the Mac's own disk
// first. xcodebuild is a stub that fails, so the run stops right after the Reservation on every host.
test('preflight-ios reserves mac-ios before its checks, and a Reservation that cannot be made does not fail it', async () => {
  const f = await gitFixture();
  try {
    const bin = join(f.root, 'bin');
    await mkdir(bin);
    await writeFile(join(bin, 'xcodebuild'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    const env = { ...f.env, PATH: bin, HOME: f.root, GITHUB_REPOSITORY: 'delorenj/example', GITHUB_RUN_ID: '77', HUB_LOCK_DIR: join(f.root, 'locks'), HUB_EVENT_DIR: join(f.root, 'events') };
    const config = () => ({ ...parseConfig(['preflight-ios', '--out', f.out, '--bundle', 'io.example.app'], env), cwd: f.app });
    await assert.rejects(preflightIos(config(), { env, home: f.root, log: () => {} }), /xcodebuild|disk|GiB|free/i);
    assert.deepEqual(listReservations('mac-ios', { env }).map(entry => [entry.key, entry.live]), [['delorenj--example--77', true]]);
    assert.deepEqual(listReservations('adb', { env }), [], 'only the Mac\'s lock');
    assert.deepEqual([...readEvents({ env })].map(event => [event.event, event.lock]), [['claim', 'mac-ios']]);
    const logs = [];
    await assert.rejects(preflightIos(config(), { env, home: f.root, log: line => logs.push(line), reserver: () => { throw new Error('read only'); } }), /xcodebuild|disk|GiB|free/i);
    assert.ok(logs.includes('HUB_RESERVATION_FAILED mac-ios read only; the run goes on without a reserved place'), logs.join('\n'));
  } finally { await f.cleanup(); }
});

test('a schema 2 manifest is strict: project, version read and bump, an APK lane, an iPad hook', () => {
  const base = { ...v3Manifest(), ios: { bundle: 'io.example.app', device: 'node tools/ios.mjs device', device_artifact: 'App.xcarchive' } };
  assert.equal(parseManifest(JSON.stringify(base)).schema, 2);
  const mutate = change => JSON.stringify(change(structuredClone(base)));
  const bad = {
    'no project': mutate(m => { delete m.project; }),
    'bad slug': mutate(m => { m.project.slug = 'Tower Of'; }),
    'version as a string': mutate(m => { m.version = 'node v.mjs'; }),
    'no bump hook': mutate(m => { delete m.version.bump; }),
    'android without the APK lane': mutate(m => { delete m.android.export; delete m.android.artifact; delete m.android.signer_sha256; m.android.bundle = 'x'; m.android.bundle_artifact = 'a.aab'; }),
    'ios without device': mutate(m => { delete m.ios.device; }),
    'device artifact with a path': mutate(m => { m.ios.device_artifact = 'out/App.ipa'; }),
    'device artifact not an archive or ipa': mutate(m => { m.ios.device_artifact = 'App.zip'; }),
    'store without the Linux export': mutate(m => { m.ios.store = { archive: 'a.tgz', receipt: 'a.json', upload: 'x', assign: 'y' }; }),
    'v2 keys in v3': mutate(m => { m.ios.upload = 'x'; }),
  };
  for (const [name, text] of Object.entries(bad)) assert.throws(() => parseManifest(text), /mobile-deploy\.json/, name);
});

// ---------------------------------------------------------------------------------------------------- end to end

// The S26 as a shell script: its state is a folder (the installed APK), every call is logged.
const fakeAdb = state => `echo "$*" >> "${state}/calls.log"
[ "$1" = "-L" ] && shift 2
[ "$1" = "-s" ] && { id="$2"; shift 2; }
case "$1" in
  start-server) exit 0 ;;
  devices) printf 'List of devices attached\\nadb-R5CX31AEJDA-other._adb-tls-connect._tcp\\tdevice\\nadb-R5GL43A7PCH-zz._adb-tls-connect._tcp\\tdevice\\n'; exit 0 ;;
  install) shift; [ "$1" = "-r" ] || { echo "fake adb: refuses $*"; exit 1; }; cp "$2" "${state}/installed.apk"; echo Success; exit 0 ;;
  shell)
    shift
    case "$1 $2" in
      "getprop ro.serialno") case "$id" in *R5GL43A7PCH*) echo R5GL43A7PCH ;; *) echo R5CX31AEJDA ;; esac ;;
      "getprop ro.product.model") case "$id" in *R5GL43A7PCH*) echo SM-S948U ;; *) echo SM-S921U ;; esac ;;
      "dumpsys package") [ -f "${state}/installed.apk" ] || exit 0; set -- $(cat "${state}/installed.apk"); printf 'Packages:\\n  Package [%s] (1):\\n    versionCode=%s minSdk=24\\n    versionName=%s\\n' "$1" "$3" "$2" ;;
      "pm path") echo "package:/data/app/~~x==/io.example.app-y==/base.apk" ;;
      "sha256sum /data/app/~~x==/io.example.app-y==/base.apk") sha256sum "${state}/installed.apk" | cut -d' ' -f1 | sed 's#$#  /data/app/~~x==/io.example.app-y==/base.apk#' ;;
      *) echo "fake adb: unknown shell $*" >&2; exit 1 ;;
    esac ;;
  *) echo "fake adb: unknown $*" >&2; exit 1 ;;
esac`;

// The rest of the host: build-tools that read the fake APK, a bb-emit that records, a gh that records.
async function laneHost(f) {
  const sdk = join(f.root, 'sdk/build-tools/35.0.0');
  const state = join(f.root, 'phone');
  const bin = join(f.root, 'bin');
  await Promise.all([sdk, state, bin].map(dir => mkdir(dir, { recursive: true })));
  await script(join(sdk, 'apksigner'), `echo "Signer #1 certificate SHA-256 digest: ${signer}"`);
  await script(join(sdk, 'aapt2'), 'set -- $(cat "$3"); echo "package: name=\'$1\' versionCode=\'$3\' versionName=\'$2\' platformBuildVersionName=\'15\'"');
  await script(join(bin, 'adb'), fakeAdb(state));
  await script(join(bin, 'bb-emit'), `cat > "${f.root}/event-$$.json"\necho "bb-emit $*" >> "${f.root}/bb-emit.log"`);
  // The app repo is private, like every real one (the release lane asks before it attaches the device APK, MOBI-17).
  await script(join(bin, 'gh'), `echo "gh $*" >> "${f.root}/gh.log"\n[ "$1 $2" = "release view" ] && exit "\${FAKE_RELEASE_EXISTS:-1}"\ncase "$*" in "api "*" --jq .private") echo "\${GH_PRIVATE:-true}";; esac\nexit 0`);
  const output = join(f.root, 'github-output.txt');
  await writeFile(output, '');
  const env = {
    ...f.env,
    PATH: `${bin}:${f.env.PATH}`,
    ANDROID_HOME: join(f.root, 'sdk'),
    JAVA_HOME: join(f.root, 'java'),
    HUB_ADB: join(bin, 'adb'),
    HUB_BB_EMIT: join(bin, 'bb-emit'),
    HUB_LOCK_DIR: join(f.root, 'locks'), HUB_EVENT_DIR: join(f.root, 'events'),
    HUB_ADB_WAIT_MS: '2000',
    HUB_ADB_LANE_WAIT_MS: '2000',
    GITHUB_OUTPUT: output,
    GITHUB_REPOSITORY: 'delorenj/example-app',
    GITHUB_RUN_ID: '777',
    GITHUB_RUN_ATTEMPT: '1',
    GITHUB_REF: 'refs/heads/main',
    GITHUB_SHA: f.remote(['rev-parse', 'main']),
  };
  const calls = name => { try { return readFileSync(join(f.root, name), 'utf8'); } catch { return ''; } };
  const adbCalls = () => calls('phone/calls.log');
  const outputs = () => Object.fromEntries(readFileSync(output, 'utf8').trim().split('\n').filter(Boolean).map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
  const configure = (command, extra = [], more = {}) => ({ ...parseConfig([command, '--manifest', 'mobile-deploy.json', '--out', f.out, ...extra], { ...env, ...more }), cwd: f.app });
  const installApk = async text => writeFile(join(state, 'installed.apk'), text);
  const s3 = { writes: [], putText(text, key) { this.writes.push({ key, text }); }, put(file, key) { this.writes.push({ key, file }); }, remove(key) { this.writes.push({ key, removed: true }); }, list: () => [] };
  return { env, state, calls, adbCalls, outputs, configure, installApk, s3 };
}

// The build directory as the plan reads it: empty (no latest.json yet) unless a test says otherwise.
const noLatest = async () => ({ status: 404, ok: false, text: async () => '' });

const quiet = async fn => {
  const log = console.log;
  console.log = () => {};
  try { return await fn(); } finally { console.log = log; }
};

test('a dry run end to end: the plan bumps nothing on origin, the S26 gets nothing, the event is only checked', async () => {
  const f = await gitFixture();
  try {
    const host = await laneHost(f);
    await host.installApk('io.example.app 0.2.1 4');
    const before = f.remote(['rev-parse', 'main']);
    const planned = await quiet(() => plan(host.configure('plan'), { env: host.env, home: f.root, fetchImpl: noLatest }));
    assert.deepEqual([planned.version, planned.android_code, planned.build_sha, planned.bumped], ['0.2.2', 5, before, false]);
    const out = host.outputs();
    assert.equal(out.version, '0.2.2');
    assert.ok(out.bump_patch.length > 20, 'the lanes get the bump as a patch');
    assert.equal(f.remote(['rev-parse', 'main']), before);
    assert.equal(f.remote(['tag', '--list']), '');
    const planReceipt = readJson(join(f.out, 'plan/hub-receipt-plan.json'));
    assert.equal(planReceipt.bump.rehearsed, true);
    assert.deepEqual(planReceipt.devices.s26, { versionCode: 4, versionName: '0.2.1' });

    const lane = await quiet(() => android(host.configure('android', ['--version', out.version, '--android-code', out.android_code, '--build-sha', out.build_sha, '--bump-patch', out.bump_patch]), { env: host.env, home: f.root }));
    assert.equal(lane.delivery.verified, false);
    assert.doesNotMatch(host.adbCalls(), /\binstall\b/, 'a dry run never installs');
    assert.equal(readFileSync(join(host.state, 'installed.apk'), 'utf8'), 'io.example.app 0.2.1 4', 'the phone still runs the old build');
    assert.match(readJson(join(f.out, 'android/hub-receipt-android.json')).notes.join('\n'), /dry run: would install 0\.2\.2 \(5\) over 0\.2\.1 \(4\)/);

    await rm(join(f.root, 'bb-emit.log'), { force: true });
    const event = await quiet(() => announce(host.configure('announce', [], { HUB_RECEIPTS: f.out }), { env: { ...host.env, HUB_RECEIPTS: f.out, HUB_NEEDS: JSON.stringify({ gate: { result: 'success' }, plan: { result: 'success', outputs: out }, android: { result: 'success' } }) }, home: f.root, fetchImpl: noLatest }));
    assert.equal(event.sent, false);
    assert.equal(event.type, 'bloodbank.project.deployment.completed');
    const emitted = host.calls('bb-emit.log').trim().split('\n');
    assert.equal(emitted.length, 1);
    assert.match(emitted[0], /--check$/);
    assert.doesNotMatch(host.calls('bb-emit.log'), /--strict/, 'a dry run never emits');
  } finally { await f.cleanup(); }
});

test('the plan names the iOS marketing version and the beta groups: the deploy\'s version and Owner Testing unless the policy or a local run says otherwise', async () => {
  const f = await gitFixture();
  try {
    const host = await laneHost(f);
    await host.installApk('io.example.app 0.2.1 4');
    const logs = [];
    const planned = await plan(host.configure('plan'), { env: host.env, home: f.root, fetchImpl: noLatest, log: line => logs.push(line) });
    assert.equal(planned.version, '0.2.2');
    assert.equal(planned.ios_version, '0.2.2', 'an app with no testflight block: the iOS version is the deploy\'s, as before');
    assert.equal(host.outputs().ios_version, '0.2.2');
    assert.ok(logs.some(line => /^HUB_TESTFLIGHT_PLAN ios_version=0\.2\.2 \(train patch, deploy 0\.2\.2\) build=.* groups=Owner Testing$/.test(line)), logs.filter(line => /HUB_TESTFLIGHT/.test(line)).join('\n'));
    const receipt = readJson(join(f.out, 'plan/hub-receipt-plan.json'));
    assert.equal(receipt.ios_version, '0.2.2');
    assert.deepEqual(receipt.testflight, { train: 'patch', groups: ['Owner Testing'] });
    // A local run may name the marketing version itself (HUB_IOS_VERSION / --ios-version); the build number is untouched.
    const explicit = await quiet(() => plan(host.configure('plan', ['--ios-version', '0.3.0']), { env: host.env, home: f.root, fetchImpl: noLatest }));
    assert.deepEqual([explicit.version, explicit.ios_version], ['0.2.2', '0.3.0']);
    assert.deepEqual(readJson(join(f.out, 'plan/hub-receipt-plan.json')).testflight, { train: 'explicit', groups: ['Owner Testing'] });
  } finally { await f.cleanup(); }
});

test('a real run end to end: bump pushed, APK installed in place and read back, event sent', async () => {
  const f = await gitFixture();
  try {
    const host = await laneHost(f);
    await host.installApk('io.example.app 0.2.1 4');
    const planned = await quiet(() => plan(host.configure('plan', ['--dry-run', 'false']), { env: host.env, home: f.root, fetchImpl: noLatest, s3Factory: async () => host.s3 }));
    assert.equal(planned.bumped, true);
    assert.equal(f.remote(['rev-parse', 'main']), planned.build_sha);
    assert.equal(f.remote(['rev-parse', 'v0.2.2^{commit}']), planned.build_sha);
    git(f.app, ['checkout', '-q', planned.build_sha], f.env);
    const out = host.outputs();
    assert.equal(out.bump_patch, '', 'a real run carries no patch: the lanes check out the bump commit');
    const lane = await quiet(() => android(host.configure('android', ['--dry-run', 'false', '--version', '0.2.2', '--android-code', '5', '--build-sha', planned.build_sha]), { env: host.env, home: f.root }));
    assert.equal(lane.delivery.verified, true);
    assert.match(host.adbCalls(), /install -r .*App\.apk/);
    assert.equal(readFileSync(join(host.state, 'installed.apk'), 'utf8'), 'io.example.app 0.2.2 5 ');
    // The saved release notes are read through the injected fetch, never the live bucket (MOBI-17 made them private,
    // so an un-injected read answered 403 here and ECONNREFUSED on a host without MinIO).
    const reads = [];
    await quiet(() => release(host.configure('release', ['--dry-run', 'false', '--version', '0.2.2', '--android-code', '5', '--build-sha', planned.build_sha]), { env: { ...host.env, GH_TOKEN: 'token' }, fetchImpl: async url => { reads.push(String(url)); return noLatest(); } }));
    assert.deepEqual(reads, ['http://127.0.0.1:9012/builds/example-app/0.2.2/release-notes.json']);
    assert.match(host.calls("gh.log"), /gh release create v0\.2\.2 [^\n]* --target [0-9a-f]{40} [\s\S]*--verify-tag\n/);
    const needs = JSON.stringify({ gate: { result: 'success' }, plan: { result: 'success', outputs: out }, android: { result: 'success' }, deliver: { result: 'success' } });
    await rm(join(f.root, 'bb-emit.log'), { force: true });
    const event = await quiet(() => announce(host.configure('announce', ['--dry-run', 'false']), { env: { ...host.env, HUB_RECEIPTS: f.out, HUB_NEEDS: needs }, home: f.root, fetchImpl: noLatest }));
    assert.equal(event.sent, true);
    assert.deepEqual(host.calls('bb-emit.log').trim().split('\n').map(line => line.split(' ').pop()), ['--check', '--strict']);
    assert.equal(event.data.verified, true);
    assert.equal(event.data.artifact.commit, planned.build_sha);
  } finally { await f.cleanup(); }
});

// Story 2.8 (AD-3, AD-7, NFR-2): the Event Log of one whole deploy run on a pinned hub, from the real gate reservation, plan and
// android lane code and a fake phone: the run's claim, plan's hold, the android hold that ends the Reservation, and nothing from announce.
test('a whole deploy run writes its events in order, each stamped with the pinned hub version: claim, plan hold, android hold with the Reservation release', async () => {
  const f = await gitFixture();
  try {
    const host = await laneHost(f);
    await host.installApk('io.example.app 0.2.1 4');
    const jobEnv = job => ({ ...host.env, HUB_REF: 'v1.2.46', GITHUB_JOB: job });
    const as = (job, command, extra = []) => host.configure(command, extra, jobEnv(job));
    // gate: the call `gate` makes for a run with an Android lane (v11.test.mjs pins that the gate makes it)
    reserveFor('adb', { env: jobEnv('gate'), log: () => {} });
    const planned = await quiet(() => plan(as('plan', 'plan', ['--dry-run', 'false']), { env: jobEnv('plan'), home: f.root, fetchImpl: noLatest, s3Factory: async () => host.s3 }));
    git(f.app, ['checkout', '-q', planned.build_sha], f.env);
    const lane = await quiet(() => android(as('android', 'android', ['--dry-run', 'false', '--version', '0.2.2', '--android-code', '5', '--build-sha', planned.build_sha]), { env: jobEnv('android'), home: f.root }));
    assert.equal(lane.delivery.verified, true);
    const needs = JSON.stringify({ gate: { result: 'success' }, plan: { result: 'success', outputs: host.outputs() }, android: { result: 'success' }, deliver: { result: 'success' } });
    await quiet(() => announce(as('announce', 'announce', ['--dry-run', 'false']), { env: { ...jobEnv('announce'), HUB_RECEIPTS: f.out, HUB_NEEDS: needs }, home: f.root, fetchImpl: noLatest }));
    const events = [...readEvents({ env: host.env })];
    assert.deepEqual(events.map(event => [event.event, event.hold_kind, event.claimant.job]), [
      ['claim', 'reservation', 'gate'],
      ['request', 'job', 'plan'], ['acquire', 'job', 'plan'], ['release', 'job', 'plan'],
      ['request', 'job', 'android'], ['acquire', 'job', 'android'], ['release', 'reservation', 'android'], ['release', 'job', 'android'],
    ], 'announce finds the Reservation already released by the lane and writes nothing; the Reservation is released before the lock is freed (AD-7)');
    assert.deepEqual([...new Set(events.map(event => event.hub_version))], ['v1.2.46']);
    assert.deepEqual([...new Set(events.map(event => event.lock))], ['adb']);
    assert.deepEqual([...new Set(events.map(event => `${event.claimant.repo}#${event.claimant.run}.${event.claimant.attempt}`))], ['delorenj/example-app#777.1']);
    for (const event of events.filter(event => event.hold_kind === 'job' && event.event === 'release')) assert.ok(event.held_ms >= 0, 'a release records how long the hold lasted');
    for (const event of events.filter(event => event.event === 'acquire')) assert.ok(event.waited_ms >= 0, 'an acquire records how long the wait lasted');
    assert.deepEqual(listReservations('adb', { env: host.env }), [], 'the run left no Reservation behind');
  } finally { await f.cleanup(); }
});

test('Re-run failed jobs finishes a deploy: same build verified without reinstalling, another build replaces it in place', async () => {
  const f = await gitFixture();
  try {
    const host = await laneHost(f);
    const planned = await quiet(() => plan(host.configure('plan', ['--dry-run', 'false']), { env: host.env, home: f.root, fetchImpl: noLatest, s3Factory: async () => host.s3 }));
    git(f.app, ['checkout', '-q', planned.build_sha], f.env);
    const real = host.configure('android', ['--dry-run', 'false', '--version', '0.2.2', '--android-code', '5', '--build-sha', planned.build_sha]);
    // Attempt 1 installed 0.2.2 (5) and then failed later in the job (a Release clash, a runner restart).
    await host.installApk('io.example.app 0.2.2 5 ');
    await rm(join(host.state, 'calls.log'), { force: true });
    // The run's Reservation of the S26 (the gate took it): a lane that ends well releases it inside its hold, before `adb` is freed
    // (Story 2.6, AD-7), so the next Claimant is not held up by a run that no longer needs the phone.
    reserve('adb', { env: host.env, log: () => {} });
    assert.equal(listReservations('adb', { env: host.env }).length, 1);
    const same = await quiet(() => android(real, { env: host.env, home: f.root }));
    assert.equal(same.delivery.verified, true);
    assert.deepEqual(listReservations('adb', { env: host.env }), [], 'a lane that ended in success released its Reservation');
    assert.deepEqual([...readEvents({ env: host.env })].filter(event => event.hold_kind === 'reservation').map(event => event.event), ['claim', 'release']);
    assert.doesNotMatch(host.adbCalls(), /\binstall\b/, 'the same bytes are not installed again');
    // The rebuilt APK differs (Godot exports are not byte-reproducible): same versionCode, in place, data kept.
    await rm(join(host.state, 'calls.log'), { force: true });
    const rebuilt = await quiet(() => android(real, { env: { ...host.env, APK_SALT: 'attempt-2' }, home: f.root }));
    assert.equal(rebuilt.delivery.verified, true);
    assert.match(host.adbCalls(), /install -r /);
    assert.equal(readFileSync(join(host.state, 'installed.apk'), 'utf8'), 'io.example.app 0.2.2 5 attempt-2');
    // The Release an earlier attempt published gets this attempt's assets.
    await quiet(() => release(host.configure('release', ['--dry-run', 'false', '--version', '0.2.2', '--android-code', '5', '--build-sha', planned.build_sha]), { env: { ...host.env, GH_TOKEN: 'token', FAKE_RELEASE_EXISTS: '0' }, fetchImpl: noLatest }));
    assert.match(host.calls('gh.log'), /gh release upload v0\.2\.2 .* --clobber/);
    // A phone ahead of the plan is never downgraded.
    await host.installApk('io.example.app 0.2.9 9');
    reserve('adb', { env: host.env, log: () => {} });
    await assert.rejects(quiet(() => android(real, { env: host.env, home: f.root })), /versionCode 9, above the planned 5/);
    assert.equal(listReservations('adb', { env: host.env }).length, 1, 'a failed lane never releases: grace and the ceiling end it, and a rerun keeps its place');
  } finally { await f.cleanup(); }
});

test('a plan whose run skips the Android lane releases the run\'s Reservation of the S26; a plan that keeps it releases nothing (Story 2.6)', async () => {
  const f = await gitFixture({ manifest: v3Manifest({ ios: { bundle: 'io.example.app', device: 'true', device_artifact: 'App.xcarchive' } }) });
  try {
    const host = await laneHost(f);
    await host.installApk('io.example.app 0.2.1 4');
    reserve('adb', { env: host.env, log: () => {} });
    const asked = [];
    const releaser = (name, options) => { asked.push(name); return releaseReservation(name, options); };
    const logs = [];
    await quiet(() => plan(host.configure('plan', ['--ios-lane', 'skip-metered']), { env: host.env, home: f.root, fetchImpl: noLatest, releaser, log: line => logs.push(line) }));
    assert.deepEqual([asked, listReservations('adb', { env: host.env }).length], [[], 1], 'the Android lane runs: the Reservation stays for its job');
    await quiet(() => plan(host.configure('plan', ['--platform', 'ios', '--ios-lane', 'skip-metered']), { env: host.env, home: f.root, fetchImpl: noLatest, releaser, log: line => logs.push(line) }));
    assert.deepEqual(asked, ['adb']);
    assert.deepEqual(listReservations('adb', { env: host.env }), []);
    assert.ok(logs.includes('HUB_RESERVATION_RELEASED adb delorenj--example-app--777'), logs.join('\n'));
  } finally { await f.cleanup(); }
});

test('an away S26 is pending, not a stop: the plan still bumps, and the lane publishes for a later install', async () => {
  const f = await gitFixture();
  try {
    const host = await laneHost(f);
    await script(join(f.root, 'bin/adb'), `echo "$*" >> "${host.state}/calls.log"\n[ "$1" = devices ] && printf 'List of devices attached\\n'\nexit 0`);
    const logs = [];
    const planned = await plan(host.configure('plan'), { env: host.env, home: f.root, fetchImpl: noLatest, log: line => logs.push(line) });
    assert.equal(planned.version, '0.2.2');
    assert.equal(planned.s26, 'away');
    assert.ok(logs.some(line => /^HUB_S26_PENDING /.test(line)), logs.join('\n'));
    const out = host.outputs();
    const lane = await quiet(() => android(host.configure('android', ['--version', out.version, '--android-code', out.android_code, '--build-sha', out.build_sha, '--bump-patch', out.bump_patch]), { env: host.env, home: f.root }));
    assert.deepEqual([lane.delivery.status, lane.delivery.verified, lane.delivery.reason], ['pending', false, "not on big-chungus's adb"]);
    assert.equal(lane.staged.name, 'example-app-0.2.2-5.apk');
    assert.ok(existsSync(join(f.root, '.cache/mobile-deploy-hub/staging/delorenj-example-app/777/android/example-app-0.2.2-5.apk')), 'staged for deliver');
    assert.equal(lane.quickdrop.status, 'skipped', 'a dry run drops nothing in Quickdrop');
    assert.doesNotMatch(host.adbCalls(), /\binstall\b/);
    // A phone adb lists but cannot use — unauthorized (pairing lost) or offline (dozed wireless TLS) — is the
    // same pending, not a red plan or lane: the lanes read findPhone's error code, never its wording.
    await script(join(f.root, 'bin/adb'), `echo "$*" >> "${host.state}/calls.log"\n[ "$1" = devices ] && printf 'List of devices attached\\nadb-R5GL43A7PCH-q\\tunauthorized\\n'\nexit 0`);
    const logsAgain = [];
    const plannedAgain = await plan(host.configure('plan'), { env: { ...host.env, HUB_ADB_WAIT_MS: '1' }, home: f.root, fetchImpl: noLatest, log: line => logsAgain.push(line) });
    assert.equal(plannedAgain.s26, 'away', 'an unauthorized S26 is away, not a failure');
    assert.ok(logsAgain.some(line => /^HUB_S26_PENDING /.test(line)), logsAgain.join('\n'));
    const outAgain = host.outputs();
    const laneAgain = await quiet(() => android(host.configure('android', ['--version', outAgain.version, '--android-code', outAgain.android_code, '--build-sha', outAgain.build_sha, '--bump-patch', outAgain.bump_patch]), { env: { ...host.env, HUB_ADB_LANE_WAIT_MS: '1' }, home: f.root }));
    assert.equal(laneAgain.delivery.status, 'pending', 'the unauthorized S26 lane publishes as pending');
    assert.equal(laneAgain.delivery.reason, "not on big-chungus's adb");
  } finally { await f.cleanup(); }
});

// Story 3.1 (FR-9, AD-13): under a live Lease on `adb` the plan never takes the lock and never touches the adb server; it Peeks.
const leaseOnS26 = async (host, device) => {
  const lease = await acquireLease('adb', { holder: 'agent-a', why: 'device proof', forMs: 30 * 60_000, id: 'peek', env: host.env, log: () => {} });
  if (device) assert.equal(updateLease('adb', lease.lease_id, { device }, { env: host.env, ino: lease.lock_ino }), true);
  return lease;
};
const noServerCalls = host => assert.doesNotMatch(host.adbCalls(), /(^| )(start-server|connect|reconnect|mdns|getprop|kill-server)( |$)/m);

test('a plan under a Lease with a recorded id peeks: one -L dumpsys call, no lock events, the receipt version, and the downgrade refusal still fires', async () => {
  const f = await gitFixture();
  try {
    const host = await laneHost(f);
    await host.installApk('io.example.app 0.2.1 4');
    await leaseOnS26(host, { phone: 's26', serial: 'R5GL43A7PCH', adb_id: 'adb-R5GL43A7PCH-zz._adb-tls-connect._tcp', adb_port: 5038 });
    const before = [...readEvents({ env: host.env })].length;
    const logs = [];
    const planned = await plan(host.configure('plan'), { env: host.env, home: f.root, fetchImpl: noLatest, log: line => logs.push(line) });
    assert.equal(planned.s26, 'present');
    assert.equal(planned.version, '0.2.2');
    assert.deepEqual(host.adbCalls().trim().split('\n'), ['-L tcp:127.0.0.1:5038 -s adb-R5GL43A7PCH-zz._adb-tls-connect._tcp shell dumpsys package io.example.app']);
    noServerCalls(host);
    assert.equal([...readEvents({ env: host.env })].length, before, 'the plan wrote no request, acquire or release');
    assert.ok(logs.some(line => /^HUB_S26_PEEK lease=peek adb=adb-R5GL43A7PCH-zz\S* port=5038 read 0\.2\.1 \(4\)/.test(line)), logs.join('\n'));
    const receipt = JSON.parse(readFileSync(join(f.out, 'plan/hub-receipt-plan.json'), 'utf8'));
    assert.deepEqual([receipt.devices.s26, receipt.devices.s26_state], [{ versionCode: 4, versionName: '0.2.1' }, 'present']);
    // A peeked newer build still stops the plan before it spends a version.
    await host.installApk('io.example.app 0.9.0 9');
    await assert.rejects(plan(host.configure('plan'), { env: host.env, home: f.root, fetchImpl: noLatest, log: () => {} }), /already has io\.example\.app versionCode 9/);
    noServerCalls(host);
  } finally { await f.cleanup(); }
});

test('a plan under a Lease reads a phone without the package as present with no version, and says so', async () => {
  const f = await gitFixture();
  try {
    const host = await laneHost(f);
    await leaseOnS26(host, { phone: 's26', serial: 'R5GL43A7PCH', adb_id: 'adb-R5GL43A7PCH-zz._adb-tls-connect._tcp', adb_port: 5038 });
    const logs = [];
    const planned = await plan(host.configure('plan'), { env: host.env, home: f.root, fetchImpl: noLatest, log: line => logs.push(line) });
    assert.equal(planned.s26, 'present');
    assert.equal(planned.version, '0.2.2');
    assert.ok(logs.some(line => /^HUB_S26_PEEK lease=peek adb=\S+ port=5038 read \(not installed\)$/.test(line)), logs.join('\n'));
    assert.equal(JSON.parse(readFileSync(join(f.out, 'plan/hub-receipt-plan.json'), 'utf8')).devices.s26, null);
    noServerCalls(host);
  } finally { await f.cleanup(); }
});

test('a plan under a Lease with no recorded id looks the phone up with one -L devices call, then reads it', async () => {
  const f = await gitFixture();
  try {
    const host = await laneHost(f);
    await host.installApk('io.example.app 0.2.1 4');
    await leaseOnS26(host, null);
    const planned = await plan(host.configure('plan'), { env: host.env, home: f.root, fetchImpl: noLatest, log: () => {} });
    assert.equal(planned.s26, 'present');
    assert.deepEqual(host.adbCalls().trim().split('\n'), ['-L tcp:127.0.0.1:5037 devices', '-L tcp:127.0.0.1:5037 -s adb-R5GL43A7PCH-zz._adb-tls-connect._tcp shell dumpsys package io.example.app']);
    noServerCalls(host);
  } finally { await f.cleanup(); }
});

test('a plan under a Lease whose adb server or phone is gone reports the S26 unknown and still bumps', async () => {
  const f = await gitFixture();
  try {
    const host = await laneHost(f);
    await host.installApk('io.example.app 0.9.0 9');
    await leaseOnS26(host, { phone: 's26', serial: 'R5GL43A7PCH', adb_id: 'adb-R5GL43A7PCH-zz._adb-tls-connect._tcp', adb_port: 5038 });
    await script(join(f.root, 'bin/adb'), `echo "$*" >> "${host.state}/calls.log"\nexit 1`);
    const logs = [];
    const planned = await plan(host.configure('plan'), { env: host.env, home: f.root, fetchImpl: noLatest, log: line => logs.push(line) });
    assert.equal(planned.s26, 'unknown');
    assert.equal(planned.version, '0.2.2', 'no version to compare, so the plan goes ahead; the install-time guard decides');
    assert.ok(logs.some(line => /^HUB_S26_PEEK lease=peek adb=\S+ port=5038 unknown \(/.test(line)), logs.join('\n'));
    assert.match(host.adbCalls(), /^-L tcp:127\.0\.0\.1:5038 /m);
    noServerCalls(host);
    // No listing of the phone is unknown too.
    await script(join(f.root, 'bin/adb'), `echo "$*" >> "${host.state}/calls.log"\n[ "$3" = devices ] && printf 'List of devices attached\\n'\nexit 0`);
    await rm(join(host.state, 'calls.log'), { force: true });
    releaseLease('adb', 'peek', { env: host.env });
    await leaseOnS26(host, null);
    const again = await plan(host.configure('plan'), { env: host.env, home: f.root, fetchImpl: noLatest, log: () => {} });
    assert.equal(again.s26, 'unknown');
    noServerCalls(host);
  } finally { await f.cleanup(); }
});

// Another deploy's Job Hold on `adb`, written as that job would (a live pid on this host), and the Lease that may follow it.
const holdS26 = async (host, owner) => {
  const lock = join(host.env.HUB_LOCK_DIR, 'adb.lock');
  await mkdir(lock, { recursive: true });
  await writeFile(join(lock, 'owner.json'), JSON.stringify(owner));
  return lock;
};
const otherJob = () => ({ pid: process.pid, host: hostname(), repo: 'delorenj/other', run: '1', started_at: new Date().toISOString(), format: 1, kind: 'job', attempt: '1', job: 'android' });
// Resolves once the plan's ticket is in the `adb` Queue (it is waiting in withLock), so a change to the hold lands mid-wait.
const queuedPlan = async host => {
  const queue = join(host.env.HUB_LOCK_DIR, 'adb.queue');
  for (let tries = 0; tries < 600; tries += 1) {
    if (existsSync(queue) && readdirSync(queue).some(file => file.endsWith('.json'))) return;
    await new Promise(done => setTimeout(done, 50));
  }
  assert.fail('the plan never queued on adb');
};
// The plan's own events on adb; the run's Reservation claim is not the plan's hold.
const planEvents = host => [...readEvents({ env: host.env })].filter(event => event.claimant.repo === 'delorenj/example-app' && event.hold_kind !== 'reservation').map(event => [event.event, event.reason]);

test('a plan behind another deploy\'s Job Hold waits in the Queue and then reads the S26 as before', async () => {
  const f = await gitFixture();
  try {
    const host = await laneHost(f);
    await host.installApk('io.example.app 0.2.1 4');
    const lock = await holdS26(host, otherJob());
    reserve('adb', { env: host.env, log: () => {} });
    const planning = plan(host.configure('plan'), { env: host.env, home: f.root, fetchImpl: noLatest, log: () => {} });
    await queuedPlan(host);
    assert.equal(host.adbCalls(), '', 'nothing touches adb while the other job holds it');
    await rm(lock, { recursive: true, force: true });
    const planned = await planning;
    assert.equal(planned.s26, 'present');
    assert.match(host.adbCalls(), /^start-server$/m, 'a plan that holds adb finds the phone as it always has');
    assert.deepEqual(planEvents(host).map(([event]) => event), ['request', 'acquire', 'release']);
    assert.equal([...readEvents({ env: host.env })].find(event => event.event === 'request' && event.hold_kind === 'job').reservation, 'delorenj--example-app--777', 'the wait keeps its place through the run\'s Reservation');
  } finally { await f.cleanup(); }
});

test('a plan queued behind a Job Hold that a Lease then takes leaves the Queue (cancel, yield-to-lease) and Peeks instead of waiting', async () => {
  const f = await gitFixture();
  try {
    const host = await laneHost(f);
    await host.installApk('io.example.app 0.2.1 4');
    const lock = await holdS26(host, otherJob());
    const logs = [];
    const planning = plan(host.configure('plan'), { env: host.env, home: f.root, fetchImpl: noLatest, log: line => logs.push(line) });
    await queuedPlan(host);
    // The Job Hold ends and a Lease (recorded with no device: taken --no-connect) holds the phone before the plan's next poll.
    const now = Date.now();
    await writeFile(join(lock, 'owner.json'), JSON.stringify({ kind: 'lease', lease_id: 'late', holder: 'agent-b', why: 'proof', started_at: new Date(now).toISOString(), expires_at: new Date(now + 30 * 60_000).toISOString(), host: hostname() }));
    const planned = await planning;
    assert.equal(planned.s26, 'present');
    assert.deepEqual(host.adbCalls().trim().split('\n'), ['-L tcp:127.0.0.1:5037 devices', '-L tcp:127.0.0.1:5037 -s adb-R5GL43A7PCH-zz._adb-tls-connect._tcp shell dumpsys package io.example.app']);
    noServerCalls(host);
    assert.deepEqual(planEvents(host), [['request', null], ['cancel', 'yield-to-lease']]);
    assert.ok(logs.some(line => /^HUB_S26_PEEK lease=late /.test(line)), logs.join('\n'));
    assert.equal(JSON.parse(readFileSync(join(lock, 'owner.json'), 'utf8')).lease_id, 'late', 'the Lease is untouched');
  } finally { await f.cleanup(); }
});

test('an away S26 is pending, and a pending android lane releases the run\'s Reservation of the S26 (Story 2.6)', async () => {
  const f = await gitFixture();
  try {
    const host = await laneHost(f);
    await script(join(f.root, 'bin/adb'), `echo "$*" >> "${host.state}/calls.log"\n[ "$1" = devices ] && printf 'List of devices attached\\n'\nexit 0`);
    reserve('adb', { env: host.env, log: () => {} });
    const planned = await plan(host.configure('plan'), { env: host.env, home: f.root, fetchImpl: noLatest, log: () => {} });
    assert.equal(planned.s26, 'away');
    assert.equal(listReservations('adb', { env: host.env }).length, 1, 'plan keeps it: the Android lane still runs');
    const out = host.outputs();
    const lane = await quiet(() => android(host.configure('android', ['--version', out.version, '--android-code', out.android_code, '--build-sha', out.build_sha, '--bump-patch', out.bump_patch]), { env: host.env, home: f.root }));
    assert.equal(lane.delivery.status, 'pending');
    assert.deepEqual(listReservations('adb', { env: host.env }), [], 'pending is a lane that ended well: released inside the hold');
    assert.deepEqual([...readEvents({ env: host.env })].filter(event => event.hold_kind === 'reservation').map(event => event.event), ['claim', 'release']);
  } finally { await f.cleanup(); }
});

test('the plan holds the event to its contract before it spends a version', async () => {
  const f = await gitFixture();
  try {
    const host = await laneHost(f);
    await host.installApk('io.example.app 0.2.1 4');
    await script(join(f.root, 'bin/bb-emit'), 'echo "Additional properties are not allowed" >&2\nexit 1');
    await assert.rejects(quiet(() => plan(host.configure('plan', ['--dry-run', 'false']), { env: host.env, home: f.root, fetchImpl: noLatest, s3Factory: async () => host.s3 })), /fails its contract.*Nothing was bumped/);
    assert.equal(f.remote(['tag', '--list']), '');
    assert.equal(f.remote(['log', '-1', '--format=%s', 'main']), 'init');
  } finally { await f.cleanup(); }
});

test('a --play run needs the keyless inputs, a dry run too, and the dry run never contacts Play', async () => {
  const base = v3Manifest();
  const f = await gitFixture({ manifest: { ...base, android: { ...base.android, bundle: 'true', bundle_artifact: 'artifacts/App.aab' } } });
  try {
    const host = await laneHost(f);
    await host.installApk('io.example.app 0.2.1 4');
    await assert.rejects(quiet(() => plan(host.configure('plan', ['--play', 'true']), { env: host.env, home: f.root, fetchImpl: noLatest })), /a Play run, dry or real, needs wif_provider and play_sa/);
    const keyless = { ...host.env, HUB_WIF_PROVIDER: 'projects/1/locations/global/workloadIdentityPools/github/providers/example-app', HUB_PLAY_SA: 'publish@example.iam.gserviceaccount.com' };
    await assert.rejects(quiet(() => plan(host.configure('plan', ['--play', 'true'], { HUB_PLAY_SA: '' }), { env: { ...keyless, HUB_PLAY_SA: '' }, home: f.root, fetchImpl: noLatest })), /needs wif_provider and play_sa/);
    const planned = await quiet(() => plan(host.configure('plan', ['--play', 'true']), { env: keyless, home: f.root, fetchImpl: noLatest }));
    assert.equal(planned.bumped, false);
    assert.equal(host.outputs().play_lane, 'true');
    await assert.rejects(play(host.configure('play', ['--play', 'true']), { env: { ...keyless, PLAY_TOKEN: 'tok' }, fetchImpl: async () => { throw new Error('Play was contacted'); } }), /refusing to contact Play on a dry run/);
  } finally { await f.cleanup(); }
});

// ---------------------------------------------------------------------------------------------------- v1.1 downgrade guards

import { apkKey as keyOfApk, publicUrl as urlOf } from './lib/latest.mjs';
import { hermetic, makeBundle, sampleLatest } from './test-fixtures.mjs';

function publishedFor(slug, version, code) {
  const doc = sampleLatest({ slug, version });
  const key = keyOfApk(slug, version, code);
  doc.android = { ...doc.android, version, code, key, url: urlOf('https://s3.delo.sh/builds', key), quickdrop: null };
  doc.ios = null;
  return JSON.stringify(doc);
}

test('the plan refuses a planned Android code at or below the newest published one, before any bump', async () => {
  const f = await gitFixture();
  try {
    const host = await laneHost(f);
    await host.installApk('io.example.app 0.2.1 4');
    const latest = publishedFor('example-app', '0.2.9', 9);
    const fetchImpl = async url => (String(url).endsWith('/builds/example-app/latest.json') ? { status: 200, ok: true, text: async () => latest } : { status: 404, ok: false, text: async () => '' });
    await assert.rejects(quiet(() => plan(host.configure('plan', ['--dry-run', 'false']), { env: host.env, home: f.root, fetchImpl, s3Factory: async () => host.s3 })), /HUB_PLAN_REFUSED .*0\.2\.9 \(9\), at or above the planned 5/);
    assert.equal(f.remote(['tag', '--list']), '', 'no version was spent');
    assert.equal(host.s3.writes.length, 0, 'no inflight.json for a refused plan');
  } finally { await f.cleanup(); }
});

test('the plan refuses an iPad that already runs a newer build, before any bump (HUB_IPAD_NEWER)', async () => {
  const f = await gitFixture({ manifest: v3Manifest({ ios: { bundle: 'io.example.app', device: 'true', device_artifact: 'App.xcarchive' } }) });
  try {
    const host = await laneHost(f);
    await host.installApk('io.example.app 0.2.1 4');
    const run = flags => quiet(() => plan(host.configure('plan', ['--ios-lane', 'run', ...flags]), { env: host.env, home: f.root, fetchImpl: noLatest }));
    await assert.rejects(run(['--ipad-version', '0.9.0', '--ipad-build', '9']), /HUB_IPAD_NEWER .*0\.9\.0 \(9\)/);
    assert.equal(f.remote(['tag', '--list']), '');
    const planned = await run(['--ipad-version', 'unreachable', '--ipad-build', 'unreachable']);
    assert.equal(planned.version, '0.2.2', 'an unreachable iPad is pending, not a stop');
    const skipped = await quiet(() => plan(host.configure('plan', ['--ios-lane', 'skip-metered']), { env: host.env, home: f.root, fetchImpl: noLatest }));
    assert.deepEqual([skipped.run_ios, skipped.run_android], [false, true], 'the gate\'s skip keeps the iPad lane out of the run');
  } finally { await f.cleanup(); }
});

test('a real plan names its version in inflight.json once the bump is pushed', async () => {
  const f = await gitFixture();
  try {
    const host = await laneHost(f);
    await host.installApk('io.example.app 0.2.1 4');
    await quiet(() => plan(host.configure('plan', ['--dry-run', 'false']), { env: host.env, home: f.root, fetchImpl: noLatest, s3Factory: async () => host.s3 }));
    const inflight = host.s3.writes.find(write => write.key === 'example-app/inflight.json');
    assert.ok(inflight, 'inflight.json written');
    assert.deepEqual(JSON.parse(inflight.text).version, '0.2.2');
    assert.equal(JSON.parse(inflight.text).run.id, '777');
  } finally { await f.cleanup(); }
});

// ---------------------------------------------------------------------------------------------------- v1.1.3 plan re-checks

test('the plan refuses a manifest that changed on main after the dispatch: the bump never lands on rules the gate did not check', async () => {
  const f = await gitFixture();
  try {
    const host = await laneHost(f);
    await host.installApk('io.example.app 0.2.1 4');
    // main moves on while the deploy waits for the S26: the manifest gains a new name (a rename, a new lane...).
    git(f.seed, ['pull', '-q', f.origin, 'main'], f.env);
    await writeFile(join(f.seed, 'mobile-deploy.json'), JSON.stringify(v3Manifest({ project: { slug: 'example-app', name: 'Example App 2' } })));
    git(f.seed, ['commit', '-q', '-am', 'rename'], f.env);
    git(f.seed, ['push', '-q', f.origin, 'main'], f.env);
    const before = f.remote(['rev-parse', 'main']);
    await assert.rejects(quiet(() => plan(host.configure('plan', ['--dry-run', 'false']), { env: host.env, home: f.root, fetchImpl: noLatest, s3Factory: async () => host.s3 })), /HUB_GATE_REFUSED manifest: mobile-deploy\.json changed on main since the dispatched commit .*Nothing was bumped/);
    assert.equal(f.remote(['rev-parse', 'main']), before, 'nothing pushed');
    assert.equal(f.remote(['tag', '--list']), '', 'no version spent');
    assert.equal(host.s3.writes.length, 0, 'no inflight.json');
  } finally { await f.cleanup(); }
});

test('a Mac that went away after the gate turns the iPad lane into skip-lost before any Mac job is queued', async () => {
  const f = await gitFixture({ manifest: v3Manifest({ ios: { bundle: 'io.example.app', device: 'true', device_artifact: 'App.xcarchive' } }) });
  try {
    const host = await laneHost(f);
    await host.installApk('io.example.app 0.2.1 4');
    const logs = [];
    const planned = await plan(host.configure('plan', ['--dry-run', 'false', '--ios-lane', 'run', '--ipad-version', 'unreachable', '--ipad-build', 'unreachable']), { env: host.env, home: f.root, fetchImpl: noLatest, s3Factory: async () => host.s3, log: line => logs.push(line), macLinkNow: () => ({ link: 'offline', reason: 'carries-macbook-air did not answer over ssh on a remote link' }) });
    assert.deepEqual([planned.run_ios, planned.ios_lane, planned.run_android], [false, 'skip-lost', true]);
    const out = host.outputs();
    assert.deepEqual([out.run_ios, out.ios_lane, out.run_ios_export], ['false', 'skip-lost', 'false'], 'the later value of each output wins in GITHUB_OUTPUT');
    assert.ok(logs.some(line => /^HUB_IOS_SKIPPED lost: the Mac went offline after the gate/.test(line)), logs.join('\n'));
    const inflight = JSON.parse(host.s3.writes.find(write => write.key === 'example-app/inflight.json').text);
    assert.deepEqual(inflight.platforms, ['android'], 'the catch-up keeps holding only what this run builds');
  } finally { await f.cleanup(); }
});

// ---------------------------------------------------------------------------------------------------- MOBI-18: Play store package

const storeUpload = '6a1cda1cfa3eb35b950dc0fd6bc73030bd105823af3aafd9222797c4e307bae1';
const keyless = host => ({ ...host.env, HUB_WIF_PROVIDER: 'projects/1/locations/global/workloadIdentityPools/github/providers/example-app', HUB_PLAY_SA: 'publish@example.iam.gserviceaccount.com' });

// An app whose Play listing is io.example.store while its device APK is io.example.app: the policy pins the split (a
// synthetic policy file, since the live one lists real apps), the manifest names where the signing refs are, and the
// bundle hook copies a bundle the test prepared and records the HUB_PLAY_* variables it was given. The JDK tools are
// fakes that answer from FAKE_UPLOAD, so the lane's verdicts are the hub's own.
async function storeHost(f, { split = true, bundle = { package: 'io.example.store', versionCode: 5 } } = {}) {
  const host = await laneHost(f);
  await host.installApk('io.example.app 0.2.1 4');
  const policy = JSON.parse(readFileSync(join(repoRoot, 'tools/ci/policy.json'), 'utf8'));
  policy.apps['delorenj/example-app'] = { slug: 'example-app', lanes: ['android'], android: { package: 'io.example.app', signer_sha256: signer, ...(split ? { store_package: 'io.example.store', store_upload_sha256: storeUpload } : {}) } };
  const policyFile = join(f.root, 'policy.json');
  await writeFile(policyFile, JSON.stringify(policy));
  await writeFile(join(f.root, 'store.aab'), makeBundle(bundle));
  const bin = join(f.root, 'bin');
  await script(join(bin, 'jarsigner'), 'echo "jar verified."');
  await script(join(bin, 'keytool'), `d="\${FAKE_UPLOAD:-${storeUpload}}"\necho "Signer #1:"\necho\necho "Certificate #1:"\necho "Certificate fingerprints:"\necho "	 SHA256: $(echo "$d" | tr a-f A-F | sed 's/../&:/g; s/:$//')"`);
  const env = { ...host.env, STORE_AAB: join(f.root, 'store.aab'), HOOK_ENV_OUT: join(f.root, 'hook-env.txt') };
  return { ...host, env, policyFile, hookEnv: () => readFileSync(env.HOOK_ENV_OUT, 'utf8').trim().split('\n') };
}

const storeManifest = () => {
  const base = v3Manifest();
  return {
    ...base,
    android: {
      ...base.android,
      bundle: 'mkdir -p artifacts && cp "$STORE_AAB" artifacts/App.aab && env | grep "^HUB_PLAY_" | grep -v "^HUB_PLAY_SA=" | sort > "$HOOK_ENV_OUT"',
      bundle_artifact: 'artifacts/App.aab',
      bundle_signing: { key_ref: 'op://DeLoSecrets/Play upload/keystore', alias_ref: 'op://DeLoSecrets/Play upload/key_alias', password_ref: 'op://DeLoSecrets/Play upload/store_password' },
    },
  };
};

async function storeLane(host, f, { env = host.env, policyFile = host.policyFile, logs = [] } = {}) {
  await quiet(() => plan(host.configure('plan', ['--play', 'true']), { env: keyless({ env }), home: f.root, fetchImpl: noLatest }));
  const out = host.outputs();
  const args = ['--play', 'true', '--version', out.version, '--android-code', out.android_code, '--build-sha', out.build_sha, '--bump-patch', out.bump_patch];
  return android(host.configure('android', args), { env: { ...env, HUB_ADB_LANE_WAIT_MS: '1' }, home: f.root, policyFile, log: line => logs.push(line) });
}

test('a split app: the bundle hook is told the store package, the upload certificate and the signing references; the hub then verifies the bundle (dry run, Play untouched)', async () => {
  const f = await gitFixture({ manifest: storeManifest() });
  try {
    const host = await storeHost(f);
    const logs = [];
    const lane = await quiet(() => storeLane(host, f, { logs }));
    assert.deepEqual(host.hookEnv(), [
      `HUB_PLAY_PACKAGE=io.example.store`,
      `HUB_PLAY_SIGNING_ALIAS_REF=op://DeLoSecrets/Play upload/key_alias`,
      `HUB_PLAY_SIGNING_KEY_REF=op://DeLoSecrets/Play upload/keystore`,
      `HUB_PLAY_SIGNING_PASSWORD_REF=op://DeLoSecrets/Play upload/store_password`,
      `HUB_PLAY_UPLOAD_SHA256=${storeUpload}`,
    ].sort());
    assert.ok(logs.some(line => line === 'HUB_PLAY_TARGET io.example.store (store package; the device app is io.example.app)'), logs.join('\n'));
    assert.ok(logs.some(line => line === `HUB_PLAY_BUNDLE_OK io.example.store versionCode=5 upload_sha256=${storeUpload}`), logs.join('\n'));
    assert.equal(lane.delivery.verified, false, 'a dry run installs nothing');
    const receipt = readJson(join(f.out, 'android/hub-receipt-android.json'));
    assert.deepEqual(receipt.play, { package: 'io.example.store', versionCode: 5, upload_sha256: storeUpload });
    assert.ok(receipt.artifacts.some(item => item.name === 'App.aab'));
  } finally { await f.cleanup(); }
});

test('a split app\'s bundle that is not the store package, the planned code or the upload key fails the android lane, with a marker', async () => {
  const cases = [
    ['the device package', { bundle: { package: 'io.example.app', versionCode: 5 } }, {}, /HUB_PLAY_BUNDLE_REFUSED package: the bundle is io\.example\.app, the policy says Play serves io\.example\.store/],
    ['a stale versionCode', { bundle: { package: 'io.example.store', versionCode: 4 } }, {}, /HUB_PLAY_BUNDLE_REFUSED versionCode: .*versionCode 4 but the plan says 5/],
    ['the wrong key', {}, { FAKE_UPLOAD: 'd9d0253a4ce5bfb8a18d01efddc042e8828c3f73b04da41b4c3358e125c5222a' }, /HUB_PLAY_BUNDLE_REFUSED signer: .*d9d0253a/],
  ];
  for (const [name, options, extraEnv, expected] of cases) {
    const f = await gitFixture({ manifest: storeManifest() });
    try {
      const host = await storeHost(f, options);
      await assert.rejects(quiet(() => storeLane(host, f, { env: { ...host.env, ...extraEnv } })), expected, name);
      const receipt = readJson(join(f.out, 'android/hub-receipt-android.json'));
      assert.deepEqual([receipt.outcome, receipt.stage], ['failure', 'build'], `${name}: the failure is a build-stage receipt`);
      assert.match(receipt.reason, /^HUB_PLAY_BUNDLE_REFUSED/);
    } finally { await f.cleanup(); }
  }
});

test('an app with no store split keeps the old contract: hook gets its device package, nothing about a certificate, and the bundle is not read', async () => {
  const f = await gitFixture({ manifest: storeManifest() });
  try {
    const host = await storeHost(f, { split: false, bundle: { package: 'anything.goes', versionCode: 99 } });
    const logs = [];
    await quiet(() => storeLane(host, f, { logs }));
    assert.deepEqual(host.hookEnv().filter(line => !/SIGNING/.test(line)), ['HUB_PLAY_PACKAGE=io.example.app']);
    assert.ok(logs.some(line => /^HUB_PLAY_BUNDLE_UNCHECKED io\.example\.app: /.test(line)), logs.join('\n'));
    assert.equal(readJson(join(f.out, 'android/hub-receipt-android.json')).play, undefined);
  } finally { await f.cleanup(); }
});

function playRecorder() {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const { pathname } = new URL(url);
    calls.push(`${init.method} ${pathname}`);
    const reply = value => ({ ok: true, status: 200, json: async () => value, text: async () => JSON.stringify(value) });
    if (pathname.endsWith('/edits') && init.method === 'POST') return reply({ id: 'E1' });
    if (pathname.endsWith('/bundles') && init.method === 'GET') return reply({ bundles: [{ versionCode: 4 }] });
    if (pathname.endsWith('/apks')) return reply({ apks: [] });
    if (pathname.endsWith('/bundles') && init.method === 'POST') return reply({ versionCode: 5 });
    return reply({});
  };
  return { fetchImpl, calls };
}

test('the Play upload goes to the store package: edit, bundle and track name it, and the receipt says so', async () => {
  const f = await gitFixture({ manifest: storeManifest() });
  try {
    const host = await storeHost(f);
    await quiet(() => storeLane(host, f));
    const api = playRecorder();
    const logs = [];
    const real = host.configure('play', ['--dry-run', 'false', '--play', 'true', '--version', '0.2.2', '--android-code', '5']);
    const uploaded = await play(real, { env: { ...host.env, PLAY_TOKEN: 'tok' }, fetchImpl: api.fetchImpl, policyFile: host.policyFile, log: line => logs.push(line) });
    assert.deepEqual([uploaded.track, uploaded.versionCode], ['internal', 5]);
    assert.ok(api.calls.length >= 5);
    for (const call of api.calls) assert.match(call, /\/applications\/io\.example\.store\/(edits|bundles)|\/applications\/io\.example\.store\//, call);
    assert.ok(!api.calls.some(call => call.includes('io.example.app')), 'the device package is never the upload target');
    assert.ok(api.calls.includes('PUT /androidpublisher/v3/applications/io.example.store/edits/E1/tracks/internal'));
    assert.ok(logs.some(line => /^HUB_PLAY_BUNDLE_OK io\.example\.store /.test(line)));
    const receipt = readJson(join(f.out, 'android/hub-receipt-android-play.json'));
    assert.equal(receipt.play.package, 'io.example.store');
    assert.match(receipt.notes[0], /^Play io\.example\.store internal: uploaded versionCode 5/);
  } finally { await f.cleanup(); }
});

test('the upload step re-reads the bundle and refuses a swapped one before it contacts Play', async () => {
  const f = await gitFixture({ manifest: storeManifest() });
  try {
    const host = await storeHost(f);
    await quiet(() => storeLane(host, f));
    await writeFile(join(f.out, 'android/App.aab'), makeBundle({ package: 'io.example.app', versionCode: 5 }));
    const api = playRecorder();
    const real = host.configure('play', ['--dry-run', 'false', '--play', 'true', '--version', '0.2.2', '--android-code', '5']);
    await assert.rejects(play(real, { env: { ...host.env, PLAY_TOKEN: 'tok' }, fetchImpl: api.fetchImpl, policyFile: host.policyFile, log() {} }), /HUB_PLAY_BUNDLE_REFUSED package/);
    assert.deepEqual(api.calls, [], 'Play was never contacted');
    assert.equal(readJson(join(f.out, 'android/hub-receipt-android-play.json')).outcome, 'failure');
  } finally { await f.cleanup(); }
});

// ---------------------------------------------------------------------------------------------------- Story 3.2: a blocked Android delivery goes pending

import { deviceOf, mergeLatest as mergePending, publicReceipts } from './commands/deliver.mjs';
import { parseLatest as parsePending, serializeLatest as serializePending } from './lib/latest.mjs';
import { summaryMarkdown } from './lib/receipt.mjs';
import { readOwner } from './lib/lock.mjs';

const waited = { lockOptions: { timeoutMs: 150, pollMs: 20 } };
const androidEvents = host => [...readEvents({ env: host.env })].filter(event => event.claimant.repo === 'delorenj/example-app' && event.claimant.job === 'android');

test('a real run whose S26 stays busy goes green: pending "S26 busy", the blockers in the receipt and the Event Log, the Reservation released, the Release still published', async () => {
  const f = await gitFixture();
  try {
    const host = await laneHost(f);
    await host.installApk('io.example.app 0.2.1 4');
    const jobEnv = job => ({ ...host.env, HUB_REF: 'v1.2.46', GITHUB_JOB: job });
    const as = (job, command, extra = []) => host.configure(command, extra, jobEnv(job));
    reserveFor('adb', { env: jobEnv('gate'), log: () => {} });
    const planned = await quiet(() => plan(as('plan', 'plan', ['--dry-run', 'false']), { env: jobEnv('plan'), home: f.root, fetchImpl: noLatest, s3Factory: async () => host.s3 }));
    git(f.app, ['checkout', '-q', planned.build_sha], f.env);
    await holdS26(host, otherJob());
    const before = host.adbCalls();
    const logs = [];
    const lane = await android(as('android', 'android', ['--dry-run', 'false', '--version', '0.2.2', '--android-code', '5', '--build-sha', planned.build_sha]), { env: jobEnv('android'), home: f.root, log: line => logs.push(line), ...waited });
    assert.deepEqual({ status: lane.delivery.status, verified: lane.delivery.verified, reason: lane.delivery.reason }, { status: 'pending', verified: false, reason: 'S26 busy' });
    assert.equal(host.adbCalls(), before, 'no adb call: the S26 was never touched');
    assert.equal(readFileSync(join(host.state, 'installed.apk'), 'utf8').trim(), 'io.example.app 0.2.1 4', 'the S26 still runs what it ran');
    const receipt = readJson(join(f.out, 'android/hub-receipt-android.json'));
    assert.equal(receipt.outcome, 'success');
    assert.equal(receipt.delivery.reason, 'S26 busy');
    assert.equal(receipt.contention.lock, 'adb');
    assert.equal(receipt.contention.reason, 'delivery-pending');
    assert.equal(receipt.contention.blocked_by.length, 1);
    assert.deepEqual([receipt.contention.blocked_by[0].role, receipt.contention.blocked_by[0].kind, receipt.contention.blocked_by[0].holder], ['holder', 'job', 'delorenj/other#1']);
    assert.doesNotMatch(JSON.stringify([receipt.notes, receipt.delivery]), /delorenj\/other|agent-a/, 'no holder in the notes or the delivery');
    const mine = androidEvents(host);
    assert.deepEqual(mine.map(event => [event.event, event.hold_kind, event.reason]), [['request', 'job', null], ['timeout', 'job', 'delivery-pending'], ['release', 'reservation', 'delivery-pending']]);
    assert.match(mine[1].blocked_by, /delorenj\/other run 1/);
    assert.deepEqual([...readEvents({ env: host.env })].filter(event => event.hold_kind === 'reservation').map(event => event.event), ['claim', 'release']);
    assert.deepEqual(listReservations('adb', { env: host.env }), [], 'no Reservation left');
    assert.ok(logs.some(line => /^HUB_S26_BUSY 0\.2\.2 \(5\)/.test(line)), logs.join('\n'));
    assert.ok(logs.some(line => /^HUB_RESERVATION_RELEASED adb /.test(line)));
    assert.match(summaryMarkdown(receipt), /- contention on adb \(delivery-pending\): holder job delorenj\/other#1/);
    // The run goes on: the Release step publishes a pending build, and deliver's latest.json block says only "S26 busy".
    await quiet(() => release(as('release', 'release', ['--dry-run', 'false', '--version', '0.2.2', '--android-code', '5', '--build-sha', planned.build_sha]), { env: { ...jobEnv('release'), GH_TOKEN: 'token' }, fetchImpl: noLatest }));
    assert.match(host.calls('gh.log'), /gh release create v0\.2\.2 /, 'the Release of a contention-pending build is published');
    const stamp = '2026-11-24T10:00:00Z';
    const device = deviceOf(loadDevices(host.env).android, receipt, { stamp });
    assert.deepEqual([device.status, device.reason, device.by], ['pending', 'S26 busy', null]);
    const current = sampleLatest();
    const next = { ...current.android, version: '0.2.3', code: 5, key: current.android.key.replace('0.2.2/tower-of-lost-things-0.2.2-4', '0.2.3/tower-of-lost-things-0.2.3-5'), device };
    next.url = next.url.replace('0.2.2/tower-of-lost-things-0.2.2-4', '0.2.3/tower-of-lost-things-0.2.3-5');
    const top = { slug: current.slug, name: current.name, version: '0.2.3', commit: current.commit, hub_ref: 'v1.2.46', run: current.run, correlation: current.correlation, mac_bytes: current.mac_bytes };
    const merged = mergePending({ current, candidates: { android: next, ios: null }, top, stamp, log: () => {} });
    const parsed = parsePending(serializePending(merged.latest));
    assert.deepEqual([parsed.android.device.status, parsed.android.device.reason], ['pending', 'S26 busy']);
    assert.deepEqual(Object.keys(parsed.android.device).sort(), Object.keys(current.android.device).sort(), 'no key was added to latest.json');
    assert.deepEqual(Object.keys(publicReceipts({ android: receipt }).android).includes('contention'), false, 'the bucket copy of the receipt has no contention');
    const needs = JSON.stringify({ gate: { result: 'success' }, plan: { result: 'success', outputs: host.outputs() }, android: { result: 'success' }, deliver: { result: 'success' } });
    const event = await quiet(() => announce(as('announce', 'announce', ['--dry-run', 'false']), { env: { ...jobEnv('announce'), HUB_RECEIPTS: f.out, HUB_NEEDS: needs }, home: f.root, fetchImpl: noLatest }));
    assert.doesNotMatch(JSON.stringify(event.data), /contention|delorenj\/other|agent-a/);
    const delivery = JSON.stringify(event.data.deliveries ?? event.data.delivery ?? event.data);
    assert.match(delivery, /pending/);
    assert.match(delivery, /S26 busy/);
  } finally { await f.cleanup(); }
});

test('a Lease on the S26 with another ticket ahead: blocked_by lists the Lease holder, then the one ahead (dry run: the same pending delivery, nothing installed)', async () => {
  const f = await gitFixture();
  try {
    const host = await laneHost(f);
    await host.installApk('io.example.app 0.2.1 4');
    const planned = await plan(host.configure('plan'), { env: host.env, home: f.root, fetchImpl: noLatest, log: () => {} });
    const out = host.outputs();
    assert.equal(planned.s26, 'present');
    const { GITHUB_REPOSITORY: _repo, GITHUB_RUN_ID: _run, ...leaseEnv } = host.env; // an agent at a shell, not the run
    await acquireLease('adb', { holder: 'agent-a', why: 'device proof', forMs: 30 * 60_000, id: 'held', env: leaseEnv, log: () => {} });
    reserve('adb', { env: host.env, log: () => {} });
    const queue = join(host.env.HUB_LOCK_DIR, 'adb.queue');
    await mkdir(queue, { recursive: true });
    await writeFile(join(queue, '000000000000001-000001-00000009.json'), JSON.stringify({ format: 1, kind: 'lease', lease_id: 'ahead-1', holder: 'agent-b', why: 'waiting', pid: process.pid, host: hostname(), enqueued_at: new Date(1).toISOString() }));
    const before = host.adbCalls();
    const lane = await quiet(() => android(host.configure('android', ['--version', out.version, '--android-code', out.android_code, '--build-sha', out.build_sha, '--bump-patch', out.bump_patch]), { env: host.env, home: f.root, ...waited }));
    assert.deepEqual([lane.delivery.status, lane.delivery.reason], ['pending', 'S26 busy']);
    assert.equal(host.adbCalls(), before);
    const receipt = readJson(join(f.out, 'android/hub-receipt-android.json'));
    assert.equal(receipt.outcome, 'success');
    const [holder, ahead] = receipt.contention.blocked_by;
    assert.deepEqual([holder.role, holder.kind, holder.holder, holder.lease_id], ['holder', 'lease', 'agent-a', 'held']);
    assert.equal(receipt.contention.blocked_by.length, 2);
    assert.deepEqual([ahead.role, ahead.kind, ahead.holder], ['ahead', 'lease', 'agent-b']);
    assert.ok(ahead.place >= 1);
    assert.deepEqual([...readEvents({ env: host.env })].filter(event => event.event === 'timeout').map(event => [event.event, event.reason, event.claimant.holder]), [['timeout', 'delivery-pending', null]]);
    assert.equal(readOwner(join(host.env.HUB_LOCK_DIR, 'adb.lock'))?.lease_id, 'held', 'the Lease is untouched');
  } finally { await f.cleanup(); }
});

test('an error inside the hold still fails the lane (a newer versionCode on the S26) and keeps the Reservation; a ticket released mid-wait is still HUB_LEASE_CANCELLED', async () => {
  const f = await gitFixture();
  try {
    const host = await laneHost(f);
    await host.installApk('io.example.app 0.2.1 4');
    reserve('adb', { env: host.env, log: () => {} });
    const planned = await plan(host.configure('plan'), { env: host.env, home: f.root, fetchImpl: noLatest, log: () => {} });
    assert.equal(planned.s26, 'present');
    const out = host.outputs();
    await host.installApk('io.example.app 0.9.0 99');
    const args = ['--version', out.version, '--android-code', out.android_code, '--build-sha', out.build_sha, '--bump-patch', out.bump_patch];
    await assert.rejects(quiet(() => android(host.configure('android', args), { env: host.env, home: f.root, ...waited })), /above the planned/);
    assert.equal(listReservations('adb', { env: host.env }).length, 1, 'a failed hold keeps the Reservation for the rerun');
    const failed = readJson(join(f.out, 'android/hub-receipt-android.json'));
    assert.equal(failed.outcome, 'failure');
    assert.equal('contention' in failed, false);
    git(f.app, ['reset', '--hard', '-q'], f.env); // the failed lane's bump patch
    // Released mid-wait: the ticket is gone, the wait is cancelled, and that is not a busy S26.
    releaseReservation('adb', { env: host.env });
    const { GITHUB_REPOSITORY: _repo, GITHUB_RUN_ID: _run, ...leaseEnv } = host.env;
    await acquireLease('adb', { holder: 'agent-a', why: 'proof', forMs: 30 * 60_000, id: 'held', env: leaseEnv, log: () => {} });
    const waiting = android(host.configure('android', args), { env: host.env, home: f.root, lockOptions: { timeoutMs: 60_000, pollMs: 20 } }).then(() => null, error => error);
    await Promise.race([queuedPlan(host), waiting.then(error => { throw error ?? new Error('the lane finished instead of waiting'); })]);
    for (const file of readdirSync(join(host.env.HUB_LOCK_DIR, 'adb.queue'))) await rm(join(host.env.HUB_LOCK_DIR, 'adb.queue', file), { force: true });
    const error = await quiet(() => waiting);
    assert.equal(error?.code, 'HUB_LEASE_CANCELLED', String(error));
  } finally { await f.cleanup(); }
});
