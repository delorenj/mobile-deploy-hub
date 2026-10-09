// v3 tests: the bump rules, the bump transaction against a real git remote, the S26 and iPad parsers, the event
// payload, the forbidden-command guard, and end-to-end dry and real runs through fake adb, aapt2, apksigner and
// bb-emit that record every call. A dry run must never push, install or emit.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseConfig } from './lib/config.mjs';
import { checkBump, levels, nextVersion, parseVersionInfo } from './lib/version.mjs';
import { bumpTransaction, createGit, parseRemoteTag, parseStatus } from './lib/git.mjs';
import { createAdb, findPhone, parseBaseApk, parseDeviceList, parseMdnsEndpoint, parsePackage, parseSha256 } from './lib/adb.mjs';
import { createIpad, pickApp, pickIpad } from './lib/devicectl.mjs';
import { bbEmitPath, correlationFor, deploymentEvent, emitArgs, sanitizeReason, targetOf, uuidv5 } from './lib/announce.mjs';
import { loadDevices, parseDevices } from './lib/devices.mjs';
import { parseManifest } from './lib/manifest.mjs';
import { android, announce, plan, release } from './hub.mjs';
import { checkPhone, lanesFrom, parseArguments, phone } from '../deploy.mjs';

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

const manifestBoth = { project: { slug: 'tower-of-dumb-things', name: 'Tower of Lost Things' }, android: {}, ios: {} };
const runEnv = { GITHUB_REPOSITORY: 'delorenj/pile-of-dumb-things', GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '2', HUB_REF: 'v1.0.0' };
const ok = { result: 'success' };
const delivery = (platform, extra = {}) => ({ platform, target: platform === 'android' ? 'SM-S948U' : 'iPad14,5', version: '0.2.2', build: platform === 'android' ? '4' : '5', sha256: 'a'.repeat(64), verified: true, ...extra });

test('a deploy to both devices is one completed event naming each delivery', () => {
  const event = deploymentEvent({
    manifest: manifestBoth, devices, scope: { android: true, ios: true },
    needs: { 'preflight-ios': ok, plan: ok, android: ok, 'ios-export': ok, ios: ok },
    receipts: { android: { delivery: delivery('android') }, ios: { delivery: delivery('ios') } },
    version: '0.2.2', androidCode: '4', commit: 'b'.repeat(40), env: runEnv, now: new Date('2026-10-09T12:00:00.123Z'),
  });
  assert.equal(event.type, 'bloodbank.project.deployment.completed');
  assert.deepEqual(event.data.artifact, { kind: 'mobile-app', name: 'Tower of Lost Things', version: '0.2.2', version_code: 4, commit: 'b'.repeat(40), dirty: false, variant: 'debug', sha256: null });
  assert.deepEqual(event.data.target, { kind: 'device-set', name: 'SM-S948U + iPad14,5', id: null });
  assert.equal(event.data.deliveries.length, 2);
  assert.equal(event.data.verified, true);
  assert.deepEqual(event.data.run, { id: '123', attempt: 2, url: 'https://github.com/delorenj/pile-of-dumb-things/actions/runs/123', hub_ref: 'v1.0.0' });
  assert.equal(event.data.deployed_at, '2026-10-09T12:00:00Z');
  assert.equal(event.data.summary, 'Tower of Lost Things v0.2.2 (4) bbbbbbb installed on SM-S948U + iPad14,5, verified');
});

test('a failed lane makes the deploy a failed event with its stage and a path-free reason', () => {
  const event = deploymentEvent({
    manifest: manifestBoth, devices, scope: { android: true, ios: true },
    needs: { 'preflight-ios': ok, plan: ok, android: ok, 'ios-export': ok, ios: { result: 'failure' } },
    receipts: { android: { delivery: delivery('android') }, ios: { stage: 'install', reason: '::error::devicectl failed (/Users/delorenj/Library/x.app)', delivery: delivery('ios', { verified: false }) } },
    version: '0.2.2', androidCode: '4', commit: 'b'.repeat(40), env: runEnv,
  });
  assert.equal(event.type, 'bloodbank.project.deployment.failed');
  assert.equal(event.data.stage, 'install');
  assert.equal(event.data.reason, 'devicectl failed (<path>)');
  assert.deepEqual(event.data.deliveries.map(item => [item.platform, item.verified, item.stage ?? null]), [['android', true, null], ['ios', false, 'install']]);
  assert.match(event.data.summary, /deploy to SM-S948U \+ iPad14,5 failed at install: devicectl failed \(<path>\)$/);
});

test('a plan that stopped is the failed event: its stage, and lanes that never ran', () => {
  const event = deploymentEvent({
    manifest: manifestBoth, devices, scope: { android: true, ios: false },
    needs: { plan: { result: 'failure' }, android: { result: 'skipped' } },
    receipts: { plan: { stage: 'version', reason: 'tag v0.2.2 already exists on origin' } },
    version: '0.2.1', androidCode: '3', commit: 'c'.repeat(40), env: runEnv,
  });
  assert.equal(event.type, 'bloodbank.project.deployment.failed');
  assert.deepEqual([event.data.stage, event.data.reason], ['version', 'tag v0.2.2 already exists on origin']);
  assert.deepEqual(event.data.target, { kind: 'android-device', name: 'SM-S948U', id: 'R5GL43A7PCH' });
  assert.equal(event.data.artifact.kind, 'android-apk');
  assert.equal(event.data.deliveries[0].stage, 'version');
  assert.equal(sanitizeReason('one\ntwo'), 'one');
  assert.deepEqual(targetOf({ android: false, ios: true }, devices), { kind: 'ios-device', name: 'iPad14,5', id: devices.ios.udid });
});

test('reruns correlate: one UUIDv5 per repo and run, a different one for another run', () => {
  assert.equal(uuidv5('www.example.com', '6ba7b810-9dad-11d1-80b4-00c04fd430c8'), '2ed6657d-e927-568b-95e1-2665a8aea6a2', 'RFC 4122 test vector');
  assert.equal(correlationFor(runEnv), correlationFor({ ...runEnv, GITHUB_RUN_ATTEMPT: '3' }));
  assert.notEqual(correlationFor(runEnv), correlationFor({ ...runEnv, GITHUB_RUN_ID: '124' }));
  assert.deepEqual(emitArgs({ type: 't', correlation: 'c', check: true }).slice(-1), ['--check']);
  assert.deepEqual(emitArgs({ type: 't', correlation: 'c', check: false }).slice(-1), ['--strict']);
});

const realBbEmit = bbEmitPath(process.env);
test('the events the hub sends pass the live Bloodbank contract (bb-emit --check)', { skip: !existsSync(realBbEmit) && 'bb-emit is not installed on this host' }, () => {
  const cases = [
    deploymentEvent({ manifest: manifestBoth, devices, scope: { android: true, ios: true }, needs: { 'preflight-ios': ok, plan: ok, android: ok, 'ios-export': ok, ios: ok }, receipts: { android: { delivery: delivery('android') }, ios: { delivery: delivery('ios') } }, version: '0.2.2', androidCode: '4', commit: 'b'.repeat(40), env: runEnv }),
    deploymentEvent({ manifest: manifestBoth, devices, scope: { android: false, ios: true }, needs: { 'preflight-ios': ok, plan: ok, ios: { result: 'failure' } }, receipts: { ios: { stage: 'install', reason: 'devicectl device install app did not succeed', delivery: delivery('ios', { verified: false }) } }, version: '0.2.2', androidCode: '', commit: 'b'.repeat(40), env: runEnv }),
    deploymentEvent({ manifest: manifestBoth, devices, scope: { android: true, ios: true }, needs: { plan: { result: 'failure' } }, receipts: { plan: { stage: 'version', reason: 'main kept moving' } }, version: '0.2.1', androidCode: '3', commit: 'b'.repeat(40), env: runEnv }),
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
  const hits = [];
  for (const file of files) {
    readFileSync(file, 'utf8').split('\n').forEach((line, index) => {
      for (const [pattern, name] of forbidden) if (pattern.test(line)) hits.push(`${relative(repoRoot, file)}:${index + 1} ${name}: ${line.trim().slice(0, 120)}`);
    });
  }
  assert.deepEqual(hits, []);
  // The one install each device gets: in place.
  assert.match(readFileSync(join(repoRoot, 'tools/ci/lib/adb.mjs'), 'utf8'), /install: \(id, apk\) => call\(\['-s', id, 'install', '-r', apk\]/);
  assert.match(readFileSync(join(repoRoot, 'tools/ci/lib/devicectl.mjs'), 'utf8'), /\['device', 'install', 'app', '--device', udid, app\]/);
});

test('devices.json names the S26, the iPad, the team and the Mac once, and is validated', () => {
  assert.deepEqual([devices.android.serial, devices.android.model, devices.ios.udid, devices.ios.model, devices.apple.team], ['R5GL43A7PCH', 'SM-S948U', '00008112-000138390CFB401E', 'iPad14,5', 'YJ7W7Z36FP']);
  const text = readFileSync(join(repoRoot, 'tools/ci/devices.json'), 'utf8');
  assert.throws(() => parseDevices(text.replace('"R5GL43A7PCH"', '"R5GL 43"')), /android\.serial/);
  assert.throws(() => parseDevices(text.replace('"Library/Caches/mobile-deploy-hub/handoff"', '"../etc"')), /handoff_dir/);
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
  await script(join(bin, 'gh'), `echo "gh $*" >> "${f.root}/gh.log"\n[ "$1 $2" = "release view" ] && exit "\${FAKE_RELEASE_EXISTS:-1}"\nexit 0`);
  const output = join(f.root, 'github-output.txt');
  await writeFile(output, '');
  const env = {
    ...f.env,
    PATH: `${bin}:${f.env.PATH}`,
    ANDROID_HOME: join(f.root, 'sdk'),
    JAVA_HOME: join(f.root, 'java'),
    HUB_ADB: join(bin, 'adb'),
    HUB_BB_EMIT: join(bin, 'bb-emit'),
    HUB_LOCK_DIR: join(f.root, 'locks'),
    HUB_ADB_WAIT_MS: '2000',
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
  return { env, state, calls, adbCalls, outputs, configure, installApk };
}

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
    const planned = await quiet(() => plan(host.configure('plan'), { env: host.env, home: f.root }));
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
    const event = await quiet(() => announce(host.configure('announce', [], { HUB_RECEIPTS: f.out, HUB_NEEDS: JSON.stringify({ plan: { result: 'success', outputs: out }, android: { result: 'success' } }) }), { env: { ...host.env, HUB_RECEIPTS: f.out, HUB_NEEDS: JSON.stringify({ plan: { result: 'success', outputs: out }, android: { result: 'success' } }) }, home: f.root }));
    assert.equal(event.sent, false);
    assert.equal(event.type, 'bloodbank.project.deployment.completed');
    const emitted = host.calls('bb-emit.log').trim().split('\n');
    assert.equal(emitted.length, 1);
    assert.match(emitted[0], /--check$/);
    assert.doesNotMatch(host.calls('bb-emit.log'), /--strict/, 'a dry run never emits');
  } finally { await f.cleanup(); }
});

test('a real run end to end: bump pushed, APK installed in place and read back, event sent', async () => {
  const f = await gitFixture();
  try {
    const host = await laneHost(f);
    await host.installApk('io.example.app 0.2.1 4');
    const planned = await quiet(() => plan(host.configure('plan', ['--dry-run', 'false']), { env: host.env, home: f.root }));
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
    await quiet(() => release(host.configure('release', ['--dry-run', 'false', '--version', '0.2.2', '--android-code', '5', '--build-sha', planned.build_sha]), { env: { ...host.env, GH_TOKEN: 'token' } }));
    assert.match(host.calls("gh.log"), /gh release create v0\.2\.2 [^\n]* --target [0-9a-f]{40} [\s\S]*--verify-tag\n/);
    const needs = JSON.stringify({ plan: { result: 'success', outputs: out }, android: { result: 'success' } });
    await rm(join(f.root, 'bb-emit.log'), { force: true });
    const event = await quiet(() => announce(host.configure('announce', ['--dry-run', 'false']), { env: { ...host.env, HUB_RECEIPTS: f.out, HUB_NEEDS: needs }, home: f.root }));
    assert.equal(event.sent, true);
    assert.deepEqual(host.calls('bb-emit.log').trim().split('\n').map(line => line.split(' ').pop()), ['--check', '--strict']);
    assert.equal(event.data.verified, true);
    assert.equal(event.data.artifact.commit, planned.build_sha);
  } finally { await f.cleanup(); }
});

test('Re-run failed jobs finishes a deploy: same build verified without reinstalling, another build replaces it in place', async () => {
  const f = await gitFixture();
  try {
    const host = await laneHost(f);
    const planned = await quiet(() => plan(host.configure('plan', ['--dry-run', 'false']), { env: host.env, home: f.root }));
    git(f.app, ['checkout', '-q', planned.build_sha], f.env);
    const real = host.configure('android', ['--dry-run', 'false', '--version', '0.2.2', '--android-code', '5', '--build-sha', planned.build_sha]);
    // Attempt 1 installed 0.2.2 (5) and then failed later in the job (a Release clash, a runner restart).
    await host.installApk('io.example.app 0.2.2 5 ');
    await rm(join(host.state, 'calls.log'), { force: true });
    const same = await quiet(() => android(real, { env: host.env, home: f.root }));
    assert.equal(same.delivery.verified, true);
    assert.doesNotMatch(host.adbCalls(), /\binstall\b/, 'the same bytes are not installed again');
    // The rebuilt APK differs (Godot exports are not byte-reproducible): same versionCode, in place, data kept.
    await rm(join(host.state, 'calls.log'), { force: true });
    const rebuilt = await quiet(() => android(real, { env: { ...host.env, APK_SALT: 'attempt-2' }, home: f.root }));
    assert.equal(rebuilt.delivery.verified, true);
    assert.match(host.adbCalls(), /install -r /);
    assert.equal(readFileSync(join(host.state, 'installed.apk'), 'utf8'), 'io.example.app 0.2.2 5 attempt-2');
    // The Release an earlier attempt published gets this attempt's assets.
    await quiet(() => release(host.configure('release', ['--dry-run', 'false', '--version', '0.2.2', '--android-code', '5', '--build-sha', planned.build_sha]), { env: { ...host.env, GH_TOKEN: 'token', FAKE_RELEASE_EXISTS: '0' } }));
    assert.match(host.calls('gh.log'), /gh release upload v0\.2\.2 .* --clobber/);
    // A phone ahead of the plan is never downgraded.
    await host.installApk('io.example.app 0.2.9 9');
    await assert.rejects(quiet(() => android(real, { env: host.env, home: f.root })), /versionCode 9, above the planned 5/);
  } finally { await f.cleanup(); }
});

test('the plan refuses before any bump when the S26 is missing, and writes a failure receipt for the event', async () => {
  const f = await gitFixture();
  try {
    const host = await laneHost(f);
    await script(join(f.root, 'bin/adb'), `echo "$*" >> "${host.state}/calls.log"\n[ "$1" = devices ] && printf 'List of devices attached\\n'\nexit 0`);
    await assert.rejects(quiet(() => plan(host.configure('plan', ['--dry-run', 'false']), { env: host.env, home: f.root })), /not on this host's adb server.*Turn on Wireless debugging/);
    assert.equal(f.remote(['tag', '--list']), '');
    const receipt = readJson(join(f.out, 'plan/hub-receipt-plan.json'));
    assert.deepEqual([receipt.outcome, receipt.stage], ['failure', 'preflight']);
  } finally { await f.cleanup(); }
});

test('the plan holds the event to its contract before it spends a version', async () => {
  const f = await gitFixture();
  try {
    const host = await laneHost(f);
    await host.installApk('io.example.app 0.2.1 4');
    await script(join(f.root, 'bin/bb-emit'), 'echo "Additional properties are not allowed" >&2\nexit 1');
    await assert.rejects(quiet(() => plan(host.configure('plan', ['--dry-run', 'false']), { env: host.env, home: f.root })), /fails its contract.*Nothing was bumped/);
    assert.equal(f.remote(['tag', '--list']), '');
    assert.equal(f.remote(['log', '-1', '--format=%s', 'main']), 'init');
  } finally { await f.cleanup(); }
});
