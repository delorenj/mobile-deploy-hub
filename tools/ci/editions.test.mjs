// MOBI-14: multiple signed Android editions (docs/multi-edition-android.md). The manifest and policy contract, the gate's
// pins, malformed and colliding declarations refused before a version is spent, a two-edition app built and verified
// end to end through fake build tools and a fake S26, the device edition the only install, Quickdrop and catch-up
// candidate, distinct staging and receipts, and public publication only when both the manifest and the policy opt in.
// Single-edition apps are covered by every other suite, untouched.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseConfig } from './lib/config.mjs';
import { duplicateKeys, editionsOf, parseManifest } from './lib/manifest.mjs';
import { isAnonymous, publicTextProblem } from './lib/access.mjs';
import { editionPinOf, loadPolicy, parsePolicy, policyFile } from './lib/policy.mjs';
import { checksumLine, editionApkKey, editionApkName, editionLatestKey, editionPageKey, isPublicEdition, mayReplaceEdition, pruneEdition, serializeEditionPointer, validateEditionPointer } from './lib/editions.mjs';
import { editionPage } from './lib/pages.mjs';
import { cacheControlOf, contentTypeOf, historyOf, pruneVersions } from './lib/s3.mjs';
import { apkKey, parseLatest, publicUrl } from './lib/latest.mjs';
import { dropApk } from './lib/quickdrop.mjs';
import { checkPins } from './commands/gate.mjs';
import { deliver } from './commands/deliver.mjs';
import { android, plan, release } from './hub.mjs';
import { latestProblems, settingsFrom } from '../catchup/catchup.mjs';
import { hermetic, sampleLatest } from './test-fixtures.mjs';

hermetic(); // offline and outside any workflow job, on every host (test-fixtures.mjs)

const { policy } = loadPolicy();
const signer = '2d4954863dabb5da86d69ce4b60b3e400e73669b50a80658b0941440a7941a97';
const otherSigner = 'e'.repeat(64);
const base = policy.delivery.s3.public;

async function script(path, body) {
  await writeFile(path, `#!/bin/sh\n${body}\n`);
  await chmod(path, 0o755);
}

const git = (cwd, args, env) => execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const readJson = file => JSON.parse(readFileSync(file, 'utf8'));
const quiet = async fn => {
  const log = console.log;
  console.log = () => {};
  try { return await fn(); } finally { console.log = log; }
};
const notFound = async () => ({ status: 404, ok: false, text: async () => '' });

// ---------------------------------------------------------------------------------------------------- the manifest

// The device edition writes artifacts/App.apk; the beta edition's hook writes artifacts/Beta.apk with HUB_EDITION_PACKAGE
// as its package (BETA_PACKAGE overrides it, BETA_SIGNER=WRONGSIGNER makes the fake apksigner report another key).
const deviceExport = 'mkdir -p artifacts && node -e "const v=require(\'./version.json\');require(\'fs\').writeFileSync(\'artifacts/App.apk\',\'io.example.app \'+v.version+\' \'+v.android_code+\' \'+(process.env.APK_SALT||\'\'))"';
const betaExport = 'mkdir -p artifacts && node -e "const v=require(\'./version.json\');const e=process.env;require(\'fs\').writeFileSync(\'artifacts/Beta.apk\',(e.BETA_PACKAGE||e.HUB_EDITION_PACKAGE)+\' \'+v.version+\' \'+v.android_code+\' \'+e.HUB_EDITION+\' \'+(e.BETA_SIGNER||\'\'))"';

function twoEditions({ public: open = true, beta = {} } = {}) {
  return {
    schema: 2,
    project: { slug: 'example-app', name: 'Example App' },
    version: { read: 'node version.mjs', bump: 'node version.mjs bump' },
    android: {
      package: 'io.example.app', export: deviceExport, artifact: 'artifacts/App.apk', signer_sha256: signer,
      editions: { beta: { package: 'io.example.beta', export: betaExport, artifact: 'artifacts/Beta.apk', signer_sha256: signer, ...(open ? { public: { title: 'Public beta' } } : {}), ...beta } },
    },
  };
}

test('a single-edition manifest keeps its exact meaning: no editions, the top-level block is the device edition', () => {
  const single = twoEditions();
  delete single.android.editions;
  const parsed = parseManifest(JSON.stringify(single));
  assert.deepEqual(editionsOf(parsed), []);
  assert.equal(parsed.android.package, 'io.example.app');
  // A duplicate key outside android.editions keeps its pre-MOBI-14 meaning (JSON's last one wins), so no app breaks.
  assert.equal(parseManifest(JSON.stringify(single).replace('"schema":2', '"schema":2,"schema":2')).schema, 2);
  // The device edition's own errors read exactly as before.
  const noLane = structuredClone(single);
  delete noLane.android.export;
  assert.throws(() => parseManifest(JSON.stringify(noLane)), /android needs an export hook or a godot section: every deploy installs the APK on the S26/);
});

test('a two-edition manifest names each edition with its own package, hook, artifact, receipt, signer and public opt-in', () => {
  const parsed = parseManifest(JSON.stringify(twoEditions({ beta: { receipt: 'artifacts/Beta.apk.json', prepare: 'true' } })));
  const editions = editionsOf(parsed);
  assert.deepEqual(editions.map(({ name, spec }) => [name, spec.package, spec.artifact, spec.receipt, spec.public.title]), [['beta', 'io.example.beta', 'artifacts/Beta.apk', 'artifacts/Beta.apk.json', 'Public beta']]);
  const godot = twoEditions({ public: false, beta: { export: undefined, godot: { path: 'game', preset: 'Beta' } } });
  delete godot.android.editions.beta.export;
  assert.equal(editionsOf(parseManifest(JSON.stringify(godot)))[0].spec.godot.preset, 'Beta', 'a Godot app can declare an edition by preset');
});

test('malformed or colliding editions are refused when the manifest is read, which the gate and the plan do before any bump', () => {
  const mutate = change => { const manifest = twoEditions(); change(manifest); return JSON.stringify(manifest); };
  const beta = m => m.android.editions.beta;
  const cases = {
    'editions not an object': [m => { m.android.editions = ['beta']; }, /android\.editions must be an object/],
    'no editions named': [m => { m.android.editions = {}; }, /names no edition/],
    'bad edition name': [m => { m.android.editions = { 'Beta Edition': beta(m) }; }, /is not an edition name/],
    'the device name': [m => { m.android.editions = { device: beta(m) }; }, /reserved for the device edition/],
    'a device flag': [m => { beta(m).device = true; }, /android\.editions\.beta\.device: the device edition is the top-level android block/],
    'unknown key': [m => { beta(m).bundle = 'x'; }, /android\.editions\.beta has unknown key "bundle"/],
    'no signer pin': [m => { delete beta(m).signer_sha256; }, /android\.editions\.beta\.signer_sha256 must be/],
    'no hook': [m => { delete beta(m).export; }, /android\.editions\.beta needs an export hook/],
    'not an APK': [m => { beta(m).artifact = 'artifacts/Beta.aab'; }, /must end in \.apk/],
    'outside the checkout': [m => { beta(m).artifact = '../Beta.apk'; }, /must stay inside the app checkout/],
    'the device package': [m => { beta(m).package = 'io.example.app'; }, /package io\.example\.app is already the device edition/],
    'the device artifact': [m => { beta(m).artifact = 'artifacts/App.apk'; }, /android\.editions\.beta\.artifact is artifacts\/App\.apk, which android\.artifact already writes/],
    'a receipt on an artifact': [m => { beta(m).receipt = 'artifacts/App.apk'; }, /which android\.artifact already writes/],
    'the device receipt': [m => { m.android.receipt = 'artifacts/r.json'; beta(m).receipt = 'artifacts/r.json'; }, /which android\.receipt already writes/],
    'two editions, one package': [m => { m.android.editions.rc = { ...beta(m), artifact: 'artifacts/Rc.apk' }; }, /android\.editions\.rc\.package io\.example\.beta is already android\.editions\.beta/],
    'two editions, one artifact': [m => { m.android.editions.rc = { ...beta(m), package: 'io.example.rc' }; }, /android\.editions\.rc\.artifact is artifacts\/Beta\.apk, which android\.editions\.beta\.artifact already writes/],
    'a public block with a typo': [m => { beta(m).public = { titel: 'x' }; }, /android\.editions\.beta\.public has unknown key "titel"/],
    'public as a flag': [m => { beta(m).public = true; }, /android\.editions\.beta\.public must be an object/],
    'too many editions': [m => { for (let n = 0; n < 9; n += 1) m.android.editions[`e${n}`] = { ...beta(m), package: `io.example.e${n}`, artifact: `artifacts/E${n}.apk` }; delete m.android.editions.beta; }, /at most 8/],
  };
  for (const [name, [change, pattern]] of Object.entries(cases)) assert.throws(() => parseManifest(mutate(change)), pattern, name);
  // A copied edition block whose name was not changed: JSON.parse would silently keep only the second.
  const text = JSON.stringify(twoEditions());
  const block = JSON.stringify(twoEditions().android.editions.beta);
  const twice = text.replace(`"beta":${block}`, `"beta":${block},"beta":${block.replace('io.example.beta', 'io.example.rc').replace('Beta.apk', 'Rc.apk')}`);
  assert.notEqual(twice, text);
  assert.throws(() => parseManifest(twice), /android\.editions\.beta is declared twice/);
  assert.deepEqual(duplicateKeys('{"a":{"b":1,"b":2},"android":{"editions":{"x":{"p":"\\"q","p":1}}}}'), ['android.editions.x.p']);
});

// ---------------------------------------------------------------------------------------------------- the policy and the gate

const exampleApp = (editions = { beta: { package: 'io.example.beta', signer_sha256: signer, public: true } }) => ({ slug: 'example-app', lanes: ['android'], android: { package: 'io.example.app', signer_sha256: signer, ...(editions ? { editions } : {}) } });

test('the policy pins each edition\'s package and signer; public is the policy\'s half of the opt-in', () => {
  const earshot = policy.apps['delorenj/earshot'];
  assert.deepEqual([earshot.android.package, editionPinOf(earshot, 'beta')?.package, editionPinOf(earshot, 'beta')?.public ?? false], ['sh.delo.earshot', 'io.automaticai.earshot', true], 'Earshot\'s beta is pinned and public (EARS-3: the paid beta APK is an anonymous download)');
  assert.equal(editionPinOf(policy.apps['delorenj/gruvato'], 'beta'), null, 'single-edition apps pin no editions');
  const text = readFileSync(policyFile, 'utf8');
  const cases = {
    'the device name': p => { p.apps['delorenj/earshot'].android.editions = { device: { package: 'a.b', signer_sha256: signer } }; },
    'the device package': p => { p.apps['delorenj/earshot'].android.editions.beta.package = 'sh.delo.earshot'; },
    'a bad signer': p => { p.apps['delorenj/earshot'].android.editions.beta.signer_sha256 = 'ABC'; },
    'public as text': p => { p.apps['delorenj/earshot'].android.editions.beta.public = 'yes'; },
    'unknown key': p => { p.apps['delorenj/earshot'].android.editions.beta.device = true; },
    'empty editions': p => { p.apps['delorenj/earshot'].android.editions = {}; },
  };
  for (const [name, change] of Object.entries(cases)) {
    const copy = JSON.parse(text);
    change(copy);
    assert.throws(() => parsePolicy(JSON.stringify(copy)), /policy\.json/, name);
  }
});

test('the gate (and the plan, before its bump) holds every edition to the policy\'s pins and its public switch', () => {
  const manifest = parseManifest(JSON.stringify(twoEditions()));
  assert.doesNotThrow(() => checkPins({ app: exampleApp(), manifest }));
  const refused = (app, pattern) => assert.throws(() => checkPins({ app, manifest }), pattern);
  refused(exampleApp(null), /HUB_GATE_REFUSED pins: the manifest declares the Android edition beta \(io\.example\.beta\); the policy pins no such edition/);
  refused(exampleApp({ beta: { package: 'io.example.other', signer_sha256: signer, public: true } }), /android\.editions\.beta\.package is io\.example\.beta; the policy pins io\.example\.other/);
  refused(exampleApp({ beta: { package: 'io.example.beta', signer_sha256: otherSigner, public: true } }), /android\.editions\.beta\.signer_sha256 .*a new signing key is a hub release/);
  refused(exampleApp({ beta: { package: 'io.example.beta', signer_sha256: signer } }), /asks to publish the beta edition .* publicly; the policy does not allow it/);
  // A private edition needs no public switch; an edition the policy pins but the manifest dropped is inert.
  const quiet = parseManifest(JSON.stringify(twoEditions({ public: false })));
  assert.doesNotThrow(() => checkPins({ app: exampleApp({ beta: { package: 'io.example.beta', signer_sha256: signer } }), manifest: quiet }));
  const single = twoEditions();
  delete single.android.editions;
  assert.doesNotThrow(() => checkPins({ app: exampleApp(), manifest: parseManifest(JSON.stringify(single)) }));
  assert.equal(isPublicEdition({ public: {} }, { public: true }), true);
  assert.equal(isPublicEdition({ public: {} }, { public: false }), false);
  assert.equal(isPublicEdition({}, { public: true }), false, 'the policy alone never publishes an edition');
});

// ---------------------------------------------------------------------------------------------------- end to end

const versionTool = `import { readFileSync, writeFileSync } from 'node:fs';
const state = JSON.parse(readFileSync('version.json', 'utf8'));
const [command, level] = process.argv.slice(2);
if (command === 'bump') {
  const [a, b, c] = state.version.split('.').map(Number);
  state.version = level === 'minor' ? \`\${a}.\${b + 1}.0\` : \`\${a}.\${b}.\${c + 1}\`;
  state.android_code += 1;
  writeFileSync('version.json', JSON.stringify(state) + '\\n');
  console.log(JSON.stringify({ ...state, files: ['version.json'] }));
} else console.log(JSON.stringify(state));
`;

const fakeAdb = state => `echo "$*" >> "${state}/calls.log"
[ "$1" = "-s" ] && { id="$2"; shift 2; }
case "$1" in
  start-server) exit 0 ;;
  devices) printf 'List of devices attached\\nadb-R5GL43A7PCH-zz._adb-tls-connect._tcp\\tdevice\\n'; exit 0 ;;
  install) shift; [ "$1" = "-r" ] || exit 1; cp "$2" "${state}/installed.apk"; echo Success; exit 0 ;;
  shell)
    shift
    case "$1 $2" in
      "getprop ro.serialno") echo R5GL43A7PCH ;;
      "getprop ro.product.model") echo SM-S948U ;;
      "dumpsys package") [ -f "${state}/installed.apk" ] || exit 0; set -- $(cat "${state}/installed.apk"); [ "$1" = "$3" ] || true; printf 'Packages:\\n  Package [%s] (1):\\n    versionCode=%s minSdk=24\\n    versionName=%s\\n' "$1" "$3" "$2" ;;
      "pm path") echo "package:/data/app/~~x==/io.example.app-y==/base.apk" ;;
      "sha256sum /data/app/~~x==/io.example.app-y==/base.apk") sha256sum "${state}/installed.apk" | cut -d' ' -f1 | sed 's#$#  /data/app/~~x==/io.example.app-y==/base.apk#' ;;
      *) exit 1 ;;
    esac ;;
  *) exit 1 ;;
esac`;

// The build tools read the fake APK (package version code ...); apksigner reports another key for WRONGSIGNER bytes.
async function buildTools(root) {
  const sdk = join(root, 'sdk/build-tools/35.0.0');
  await mkdir(sdk, { recursive: true });
  await script(join(sdk, 'apksigner'), `if grep -q WRONGSIGNER "$3"; then echo "Signer #1 certificate SHA-256 digest: ${otherSigner}"; else echo "Signer #1 certificate SHA-256 digest: ${signer}"; fi`);
  await script(join(sdk, 'aapt2'), 'set -- $(cat "$3"); echo "package: name=\'$1\' versionCode=\'$3\' versionName=\'$2\'"');
  return join(root, 'sdk');
}

async function appHost({ manifest = twoEditions() } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'hub-editions-'));
  const origin = join(root, 'origin.git');
  const seed = join(root, 'seed');
  const app = join(root, 'app');
  const out = join(root, 'out');
  const state = join(root, 'phone');
  const bin = join(root, 'bin');
  await Promise.all([state, bin, out].map(dir => mkdir(dir, { recursive: true })));
  const globalConfig = join(root, 'gitconfig');
  await writeFile(globalConfig, '[user]\n\tname = Test\n\temail = test@example.com\n[init]\n\tdefaultBranch = main\n');
  const baseEnv = { ...process.env, GIT_CONFIG_GLOBAL: globalConfig, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' };
  for (const name of ['GH_TOKEN', 'GITHUB_TOKEN', 'HUB_OUT', 'GIT_CONFIG_COUNT', 'GITHUB_ACTIONS', 'GITHUB_STEP_SUMMARY']) delete baseEnv[name];
  git(root, ['init', '-q', '--bare', '-b', 'main', origin], baseEnv);
  git(root, ['init', '-q', '-b', 'main', seed], baseEnv);
  await writeFile(join(seed, 'version.json'), `${JSON.stringify({ version: '0.2.1', android_code: 4 })}\n`);
  await writeFile(join(seed, 'version.mjs'), versionTool);
  await writeFile(join(seed, '.gitignore'), 'artifacts/\n');
  await writeFile(join(seed, 'mobile-deploy.json'), typeof manifest === 'string' ? manifest : JSON.stringify(manifest));
  git(seed, ['add', '-A'], baseEnv);
  git(seed, ['commit', '-q', '-m', 'init'], baseEnv);
  git(seed, ['push', '-q', origin, 'main'], baseEnv);
  git(root, ['clone', '-q', origin, app], baseEnv);
  const hooks = join(root, 'hooks');
  await mkdir(hooks);
  await script(join(hooks, 'pre-push'), 'exit 0');
  git(app, ['config', 'core.hooksPath', hooks], baseEnv);
  const sdk = await buildTools(root);
  await script(join(bin, 'adb'), fakeAdb(state));
  await script(join(bin, 'bb-emit'), `cat > /dev/null\necho "bb-emit $*" >> "${root}/bb-emit.log"`);
  await script(join(bin, 'gh'), `echo "gh $*" >> "${root}/gh.log"\n[ "$1 $2" = "release view" ] && exit 1\n[ "$1" = "api" ] && echo "\${GH_PRIVATE:-true}"\nexit 0`);
  const output = join(root, 'github-output.txt');
  await writeFile(output, '');
  const remote = args => git(root, ['--git-dir', origin, ...args], baseEnv).trim();
  const env = {
    ...baseEnv, PATH: `${bin}:${baseEnv.PATH}`, ANDROID_HOME: sdk, JAVA_HOME: join(root, 'java'), HUB_ADB: join(bin, 'adb'), HUB_BB_EMIT: join(bin, 'bb-emit'),
    HUB_LOCK_DIR: join(root, 'locks'), HUB_ADB_WAIT_MS: '2000', HUB_ADB_LANE_WAIT_MS: '2000', GITHUB_OUTPUT: output,
    GITHUB_REPOSITORY: 'delorenj/example-app', GITHUB_RUN_ID: '777', GITHUB_RUN_ATTEMPT: '1', GITHUB_REF: 'refs/heads/main', GITHUB_SHA: remote(['rev-parse', 'main']),
  };
  const configure = (command, extra = []) => ({ ...parseConfig([command, '--manifest', 'mobile-deploy.json', '--out', out, ...extra], env), cwd: app });
  const outputs = () => Object.fromEntries(readFileSync(output, 'utf8').trim().split('\n').filter(Boolean).map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
  const adbCalls = () => { try { return readFileSync(join(state, 'calls.log'), 'utf8'); } catch { return ''; } };
  const s3 = { writes: [], putText(text, key) { this.writes.push({ key, text }); }, put(file, key) { this.writes.push({ key, file }); }, remove(key) { this.writes.push({ key, removed: true }); }, list: () => [] };
  const staging = join(root, '.cache/mobile-deploy-hub/staging/delorenj-example-app/777/android');
  return { root, app, out, env, state, remote, configure, outputs, adbCalls, s3, staging, cleanup: () => rm(root, { recursive: true, force: true }) };
}

test('colliding editions fail the plan before it spends a version: nothing committed, tagged or pushed', async () => {
  const bad = twoEditions();
  bad.android.editions.beta.artifact = 'artifacts/App.apk';
  const h = await appHost({ manifest: bad });
  try {
    const before = h.remote(['rev-parse', 'main']);
    await assert.rejects(quiet(() => plan(h.configure('plan', ['--dry-run', 'false']), { env: h.env, home: h.root, fetchImpl: notFound, s3Factory: async () => h.s3 })), /android\.editions\.beta\.artifact is artifacts\/App\.apk, which android\.artifact already writes/);
    assert.equal(h.remote(['rev-parse', 'main']), before, 'main did not move');
    assert.equal(h.remote(['tag', '--list']), '', 'no version tag');
    assert.deepEqual(h.s3.writes, [], 'no inflight.json');
  } finally { await h.cleanup(); }
});

test('a dry run builds and verifies both editions; APKs, staging and receipts stay distinct, and nothing is installed', async () => {
  const h = await appHost();
  try {
    await writeFile(join(h.state, 'installed.apk'), 'io.example.app 0.2.1 4');
    await quiet(() => plan(h.configure('plan'), { env: h.env, home: h.root, fetchImpl: notFound }));
    const out = h.outputs();
    const logs = [];
    const lane = await android(h.configure('android', ['--version', out.version, '--android-code', out.android_code, '--build-sha', out.build_sha, '--bump-patch', out.bump_patch]), { env: h.env, home: h.root, log: line => logs.push(line) });
    assert.equal(lane.delivery.status, 'pending');
    assert.match(lane.delivery.reason, /dry run: would install over 0\.2\.1 \(4\)/);
    assert.doesNotMatch(h.adbCalls(), /\binstall\b/);
    assert.deepEqual(lane.editions.map(item => [item.edition, item.package, item.staged.name]), [['beta', 'io.example.beta', 'example-app-beta-0.2.2-5.apk']]);
    assert.notEqual(lane.editions[0].sha256, lane.sha256, 'two different APKs');
    assert.ok(logs.some(line => /^HUB_EDITION_BUILT beta io\.example\.beta 0\.2\.2 \(5\) .*never installed$/.test(line)), logs.join('\n'));
    // Staging: the device APK where it always was, the edition in its own folder.
    assert.deepEqual(readdirSync(h.staging).sort(), ['editions', 'example-app-0.2.2-5.apk']);
    assert.deepEqual(readdirSync(join(h.staging, 'editions/beta')), ['example-app-beta-0.2.2-5.apk']);
    assert.match(readFileSync(join(h.staging, 'editions/beta/example-app-beta-0.2.2-5.apk'), 'utf8'), /^io\.example\.beta 0\.2\.2 5 beta /, 'the hook saw HUB_EDITION and HUB_EDITION_PACKAGE');
    // Receipts: one per edition, named by lane, each naming only its own APK.
    const device = readJson(join(h.out, 'android/hub-receipt-android.json'));
    const beta = readJson(join(h.out, 'android/hub-receipt-android-edition-beta.json'));
    assert.deepEqual([device.lane, device.staged.name, device.delivery.platform], ['android', 'example-app-0.2.2-5.apk', 'android']);
    assert.deepEqual([beta.lane, beta.staged.name, beta.edition, beta.delivery], ['android-edition-beta', 'example-app-beta-0.2.2-5.apk', { name: 'beta', package: 'io.example.beta', device: false, public: true }, undefined]);
    assert.equal(beta.artifacts[0].sha256, lane.editions[0].sha256);
    assert.deepEqual(device.editions.map(item => item.edition), ['beta']);
  } finally { await h.cleanup(); }
});

test('a real run installs only the device edition on the S26 and in Quickdrop; the private Release carries both', async () => {
  const h = await appHost();
  try {
    await writeFile(join(h.state, 'installed.apk'), 'io.example.app 0.2.1 4');
    const planned = await quiet(() => plan(h.configure('plan', ['--dry-run', 'false']), { env: h.env, home: h.root, fetchImpl: notFound, s3Factory: async () => h.s3 }));
    git(h.app, ['checkout', '-q', planned.build_sha], h.env);
    const real = h.configure('android', ['--dry-run', 'false', '--version', '0.2.2', '--android-code', '5', '--build-sha', planned.build_sha]);
    const lane = await quiet(() => android(real, { env: h.env, home: h.root, quickdropLink: async () => ({ onLan: true, reason: 'test' }) }));
    assert.deepEqual([lane.delivery.status, lane.delivery.verified], ['installed', true]);
    const installs = h.adbCalls().split('\n').filter(line => /\binstall\b/.test(line));
    assert.equal(installs.length, 1, 'exactly one install');
    assert.match(installs[0], /install -r .*\/android\/App\.apk$/, 'the device edition, never the beta');
    assert.equal(readFileSync(join(h.state, 'installed.apk'), 'utf8'), 'io.example.app 0.2.2 5 ');
    assert.doesNotMatch(h.adbCalls(), /io\.example\.beta/, 'the S26 is never even asked about the beta package');
    assert.deepEqual(readdirSync(join(h.root, 'quickdrop/builds')), ['example-app-0.2.2-5.apk'], 'Quickdrop holds the device edition only');
    await quiet(() => release(h.configure('release', ['--dry-run', 'false', '--version', '0.2.2', '--android-code', '5', '--build-sha', planned.build_sha]), { env: { ...h.env, GH_TOKEN: 'token' }, fetchImpl: notFound }));
    const created = readFileSync(join(h.root, 'gh.log'), 'utf8').split('\n').find(line => line.startsWith('gh release create'));
    assert.match(created, /android\/App\.apk .*hub-receipt-android\.json .*editions\/beta\/example-app-beta-0\.2\.2-5\.apk .*hub-receipt-android-edition-beta\.json/);
  } finally { await h.cleanup(); }
});

test('an edition with the wrong signer or package fails the build stage before the S26 is touched', async () => {
  for (const [extra, pattern] of [[{ BETA_SIGNER: 'WRONGSIGNER' }, /edition beta: APK signer e{64} differs from the pinned/], [{ BETA_PACKAGE: 'io.example.wrong' }, /edition beta: the APK is io\.example\.wrong, the manifest pins io\.example\.beta/]]) {
    const h = await appHost();
    try {
      const planned = await quiet(() => plan(h.configure('plan', ['--dry-run', 'false']), { env: h.env, home: h.root, fetchImpl: notFound, s3Factory: async () => h.s3 }));
      git(h.app, ['checkout', '-q', planned.build_sha], h.env);
      const real = h.configure('android', ['--dry-run', 'false', '--version', '0.2.2', '--android-code', '5', '--build-sha', planned.build_sha]);
      await assert.rejects(quiet(() => android(real, { env: { ...h.env, ...extra }, home: h.root, quickdropLink: async () => ({ onLan: true, reason: 'test' }) })), pattern);
      assert.doesNotMatch(h.adbCalls(), /\binstall\b|io\.example\.beta/, 'nothing was installed and the S26 was never asked about the beta');
      const failed = readJson(join(h.out, 'android/hub-receipt-android.json'));
      assert.deepEqual([failed.outcome, failed.stage], ['failure', 'build']);
      assert.equal(existsSync(join(h.out, 'android/hub-receipt-android-edition-beta.json')), false, 'no edition receipt for a build that failed its checks');
      assert.equal(existsSync(join(h.root, 'quickdrop/builds')), false);
    } finally { await h.cleanup(); }
  }
});

// ---------------------------------------------------------------------------------------------------- deliver

// A synthetic policy: the live one plus delorenj/example-app with a beta edition, public or not.
async function deliverHost({ policyPublic = true, manifestPublic = true, betaBytes = 'io.example.beta 0.2.2 5 beta ', betaReceipt = true, deviceOutcome = 'success' } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'hub-editions-deliver-'));
  const app = join(root, 'app');
  const out = join(root, 'out');
  await Promise.all([app, out].map(dir => mkdir(dir, { recursive: true })));
  const sdk = await buildTools(root);
  const live = JSON.parse(readFileSync(policyFile, 'utf8'));
  live.apps['delorenj/example-app'] = exampleApp({ beta: { package: 'io.example.beta', signer_sha256: signer, ...(policyPublic ? { public: true } : {}) } });
  const policyPath = join(root, 'policy.json');
  await writeFile(policyPath, JSON.stringify(live));
  await writeFile(join(app, 'mobile-deploy.json'), JSON.stringify(twoEditions({ public: manifestPublic })));
  const staging = join(root, '.cache/mobile-deploy-hub/staging/delorenj-example-app/777/android');
  await mkdir(join(staging, 'editions/beta'), { recursive: true });
  const deviceBytes = 'io.example.app 0.2.2 5 ';
  await writeFile(join(staging, 'example-app-0.2.2-5.apk'), deviceBytes);
  await writeFile(join(staging, 'editions/beta/example-app-beta-0.2.2-5.apk'), betaBytes);
  const sha = text => execFileSync('sha256sum', [], { input: text }).toString().slice(0, 64);
  const receipts = join(out, 'receipts');
  await mkdir(receipts, { recursive: true });
  await writeFile(join(receipts, 'hub-receipt-android.json'), JSON.stringify({ lane: 'android', outcome: deviceOutcome, version: '0.2.2', staged: { name: 'example-app-0.2.2-5.apk', bytes: deviceBytes.length, sha256: sha(deviceBytes) }, quickdrop: { status: 'skipped' }, delivery: { platform: 'android', status: 'pending', reason: "not on big-chungus's adb", sha256: sha(deviceBytes) },
    // The android lane's own receipt names every edition it built (android.mjs), private ones included.
    editions: [{ edition: 'beta', package: 'io.example.beta', staged: { name: 'example-app-beta-0.2.2-5.apk', bytes: betaBytes.length, sha256: sha(betaBytes) }, public: manifestPublic }] }));
  if (betaReceipt) await writeFile(join(receipts, 'hub-receipt-android-edition-beta.json'), JSON.stringify({ lane: 'android-edition-beta', outcome: 'success', version: '0.2.2', edition: { name: 'beta', package: 'io.example.beta', device: false, public: manifestPublic }, staged: { name: 'example-app-beta-0.2.2-5.apk', bytes: betaBytes.length, sha256: sha(betaBytes) } }));
  const env = { PATH: process.env.PATH, ANDROID_HOME: sdk, JAVA_HOME: join(root, 'java'), GITHUB_REPOSITORY: 'delorenj/example-app', GITHUB_RUN_ID: '777', GITHUB_RUN_ATTEMPT: '1', HUB_REF: 'local', HUB_LOCK_DIR: join(root, 'locks'), HUB_NEEDS: JSON.stringify({ plan: { result: 'success' }, android: { result: deviceOutcome } }) };
  const configure = (extra = []) => ({ ...parseConfig(['deliver', '--scope', 'android', '--manifest', 'mobile-deploy.json', '--out', out, '--version', '0.2.2', '--android-code', '5', '--build-sha', 'b'.repeat(40), ...extra], env), cwd: app });
  const writes = [];
  const s3 = { putText(text, key) { writes.push({ op: 'put', key, text }); }, put(file, key) { writes.push({ op: 'put', key, file }); }, remove(key) { writes.push({ op: 'rm', key }); }, list() { return []; } };
  const logs = [];
  const run = (extra = [], { fetchImpl = notFound } = {}) => deliver(configure(extra), { env, home: root, fetchImpl, s3Factory: async () => s3, log: line => logs.push(line), policyFile: policyPath });
  const receipt = () => readJson(join(out, 'deliver/hub-receipt-deliver-android.json'));
  return { root, staging, writes, logs, run, sha, receipt, policyPath, cleanup: () => rm(root, { recursive: true, force: true }) };
}

test('deliver publishes a public edition to its own stable folder: APK, checksum, receipt, pointer, page; the device pointer stays the device\'s', async () => {
  const d = await deliverHost();
  try {
    const result = await d.run(['--dry-run', 'false']);
    const keys = d.writes.map(write => `${write.op} ${write.key}`);
    const at = key => keys.indexOf(`put ${key}`);
    const apk = 'example-app/editions/beta/0.2.2/example-app-beta-0.2.2-5.apk';
    for (const key of [apk, `${apk}.sha256`, 'example-app/editions/beta/0.2.2/receipt.json', 'example-app/editions/beta/latest.json', 'example-app/editions/beta/index.html']) assert.ok(at(key) >= 0, `${key}\n${keys.join('\n')}`);
    assert.ok(at(apk) < at('example-app/editions/beta/latest.json') && at('example-app/editions/beta/latest.json') < at('example-app/editions/beta/index.html'), 'bytes, then the pointer, then the page');
    const text = key => d.writes.find(write => write.key === key).text;
    assert.equal(text(`${apk}.sha256`), checksumLine(d.sha('io.example.beta 0.2.2 5 beta '), 'example-app-beta-0.2.2-5.apk'));
    const pointer = validateEditionPointer(JSON.parse(text('example-app/editions/beta/latest.json')), { base, slug: 'example-app', edition: 'beta' });
    assert.deepEqual([pointer.package, pointer.version, pointer.code, pointer.title, pointer.url], ['io.example.beta', '0.2.2', 5, 'Public beta', `${base}/${apk}`]);
    const page = text('example-app/editions/beta/index.html');
    assert.deepEqual([...page.matchAll(/href="([^"]+\.apk)"/g)].map(match => match[1]), [`${base}/${apk}`], 'exactly one APK link, the current beta, for Obtainium');
    // The device edition: latest.json and its receipt know nothing of the beta.
    const latest = parseLatest(text('example-app/latest.json'), { base });
    assert.deepEqual([latest.android.package, latest.android.key], ['io.example.app', apkKey('example-app', '0.2.2', 5)]);
    assert.doesNotMatch(text('example-app/0.2.2/receipt-android.json'), /io\.example\.beta|android-edition/);
    assert.ok(!keys.some(key => /editions/.test(key) && /^put example-app\/0\.2\.2\//.test(key)));
    assert.deepEqual(result.editions.map(item => [item.name, item.public, item.pointer, item.page]), [['beta', true, 'replaced', `${base}/example-app/editions/beta/index.html`]]);
    assert.ok(d.logs.some(line => /^HUB_EDITION_PUBLISHED beta io\.example\.beta 0\.2\.2 \(5\)/.test(line)), d.logs.join('\n'));
  } finally { await d.cleanup(); }
});

test('MOBI-17: a deliver that sells a public edition keeps the device edition private: no anonymous object names its APK, the pages carry no device link', async () => {
  const d = await deliverHost();
  try {
    await d.run(['--dry-run', 'false']);
    const synthetic = parsePolicy(readFileSync(d.policyPath, 'utf8'));
    const deviceApk = 'example-app/0.2.2/example-app-0.2.2-5.apk';
    assert.ok(d.writes.some(write => write.key === deviceApk), 'the device APK is published (privately)');
    assert.equal(isAnonymous(synthetic, deviceApk), false);
    for (const key of ['example-app/index.html', 'example-app/0.2.2/receipt-android.json', 'example-app/0.2.2/release-notes.json', 'example-app/0.2.2/example-app-0.2.2-5.apk.sha256']) assert.equal(isAnonymous(synthetic, key), false, key);
    // the pointers name the device APK and never grant it: anonymous, so the catch-up reads them without 1Password
    for (const key of ['example-app/latest.json', 'example-app/inflight.json', 'example-app/editions/beta/index.html', 'example-app/editions/beta/latest.json']) assert.equal(isAnonymous(synthetic, key), true, key);
    for (const write of d.writes.filter(item => item.text !== undefined)) {
      assert.equal(publicTextProblem(synthetic, write.key, write.text), null, write.key);
      // a pointer names the device APK (the catch-up follows it) and never grants it; nothing else anonymous may
      if (isAnonymous(synthetic, write.key)) assert.doesNotMatch(write.text, /X-Amz-/, `${write.key} is anonymous`);
      if (isAnonymous(synthetic, write.key) && !/(^|\/)(latest|inflight)\.json$/.test(write.key)) assert.doesNotMatch(write.text, /example-app-0\.2\.2-5\.apk/, `${write.key} is anonymous`);
    }
    const page = d.writes.find(write => write.key === 'example-app/index.html').text;
    assert.doesNotMatch(page, /Install APK|\.apk/);
    assert.match(page, /The Android build is private/);
    const root = d.writes.filter(write => write.key === 'index.html' || write.key === 'index.json').map(write => write.text).join('\n');
    assert.doesNotMatch(root, /example-app[^"<]*\.apk|example-app\/index\.html/);
  } finally { await d.cleanup(); }
});

test('a private edition is never written to the build directory, whichever side did not opt in', async () => {
  for (const options of [{ policyPublic: false, manifestPublic: false }, { policyPublic: true, manifestPublic: false }]) {
    const d = await deliverHost(options);
    try {
      const result = await d.run(['--dry-run', 'false']);
      assert.ok(!d.writes.some(write => /editions|io\.example\.beta|-beta-/.test(`${write.key} ${write.text ?? ''}`)), d.writes.map(write => write.key).join('\n'));
      assert.ok(d.writes.some(write => write.key === 'example-app/latest.json'), 'the device edition still publishes');
      assert.deepEqual(result.editions.map(item => [item.name, item.public, item.pointer, item.url]), [['beta', false, 'private', null]]);
    } finally { await d.cleanup(); }
  }
  // The manifest alone can never publish: the policy must allow it (the gate refuses first; deliver refuses again, for
  // the edition alone: the device edition is delivered, then the job fails).
  const d = await deliverHost({ policyPublic: false, manifestPublic: true });
  try {
    await assert.rejects(d.run(['--dry-run', 'false']), /beta edition was not published \(beta: HUB_GATE_REFUSED pins: the manifest asks to publish the beta edition publicly; the policy does not allow it/);
    assert.ok(!d.writes.some(write => /editions|io\.example\.beta|-beta-/.test(`${write.key} ${write.text ?? ''}`)), d.writes.map(write => write.key).join('\n'));
    assert.ok(d.writes.some(write => write.key === 'example-app/latest.json'), 'the device edition still publishes');
  } finally { await d.cleanup(); }
});

test('deliver refuses a staged edition APK that is not the policy\'s package and signer, or has no receipt, publishes none of it, and still delivers the device edition', async () => {
  const cases = [
    [{ betaBytes: 'io.example.beta 0.2.2 5 beta WRONGSIGNER' }, /APK signer e{64} differs from the pinned/],
    [{ betaBytes: 'io.example.app 0.2.2 5 beta ' }, /the staged beta edition APK is io\.example\.app 0\.2\.2 \(5\), not io\.example\.beta/],
    [{ betaBytes: 'io.example.beta 0.2.1 5 beta ' }, /not io\.example\.beta 0\.2\.2 \(5\)/],
    [{ betaReceipt: false }, /the beta edition's receipt for 0\.2\.2 is missing/],
  ];
  for (const [options, pattern] of cases) {
    const d = await deliverHost(options);
    try {
      await assert.rejects(d.run(['--dry-run', 'false']), pattern);
      const keys = d.writes.map(write => write.key);
      assert.ok(!keys.some(key => /editions/.test(key)), `nothing of the edition is published\n${keys.join('\n')}`);
      for (const key of ['example-app/0.2.2/example-app-0.2.2-5.apk', 'example-app/latest.json', 'example-app/index.html']) assert.ok(keys.includes(key), `the device edition is delivered: ${key}\n${keys.join('\n')}`);
      const failed = d.receipt();
      assert.deepEqual([failed.outcome, failed.stage, failed.editions[0].pointer, failed.pointer.android], ['failure', 'deliver', 'failed', 'replaced']);
      assert.match(failed.editions[0].reason, pattern);
      assert.ok(failed.published.apk, 'the failure receipt keeps what the device published');
    } finally { await d.cleanup(); }
  }
  // A failed android lane publishes no edition (the device block reports the failure as before).
  const d = await deliverHost({ deviceOutcome: 'failure' });
  try {
    const result = await d.run(['--dry-run', 'false']);
    assert.ok(!d.writes.some(write => /editions/.test(write.key)));
    assert.equal(result.editions[0].pointer, 'not built');
  } finally { await d.cleanup(); }
});

test('a dry run deliver checks and renders the edition and writes nothing; the edition pointer only moves forward', async () => {
  const d = await deliverHost();
  try {
    const result = await d.run([]);
    assert.equal(result.dryRun, true);
    assert.deepEqual(d.writes, []);
    assert.ok(d.logs.some(line => /^HUB_EDITION_DRY_RUN beta would publish example-app\/editions\/beta\/0\.2\.2\/example-app-beta-0\.2\.2-5\.apk.*nothing was written$/.test(line)), d.logs.join('\n'));
  } finally { await d.cleanup(); }
  const newer = await deliverHost();
  try {
    const key = editionApkKey('example-app', 'beta', '0.2.9', 9);
    const current = { schema: 1, slug: 'example-app', app: 'Example App', edition: 'beta', title: 'Public beta', package: 'io.example.beta', version: '0.2.9', code: 9, key, url: publicUrl(base, key), bytes: 10, sha256: 'f'.repeat(64), sha256_url: publicUrl(base, `${key}.sha256`), signer_sha256: signer, commit: 'c'.repeat(40), run: { repo: 'delorenj/example-app', id: '1', attempt: 1, url: null }, correlation: '6f1c2b44-0d1e-5a7b-9c3d-2e4f5a6b7c8d', updated_at: '2026-11-18T00:00:00Z' };
    const fetchImpl = async url => (String(url).endsWith(editionLatestKey('example-app', 'beta')) ? { status: 200, ok: true, text: async () => serializeEditionPointer(current) } : { status: 404, ok: false, text: async () => '' });
    const result = await newer.run(['--dry-run', 'false'], { fetchImpl });
    assert.ok(!newer.writes.some(write => /editions/.test(write.key)), 'an older build never replaces a newer public edition');
    assert.equal(result.editions[0].pointer, 'kept');
  } finally { await newer.cleanup(); }
});

test('the android lane\'s real receipt never names an edition in the build directory: private or public', async () => {
  for (const options of [{ policyPublic: false, manifestPublic: false }, { policyPublic: true, manifestPublic: true }]) {
    const d = await deliverHost(options);
    try {
      await d.run(['--dry-run', 'false']);
      const published = d.writes.find(write => write.key === 'example-app/0.2.2/receipt-android.json');
      assert.ok(published, d.writes.map(write => write.key).join('\n'));
      assert.doesNotMatch(published.text, /io\.example\.beta|-beta-|"editions"/, 'the device receipt in the bucket names no edition');
    } finally { await d.cleanup(); }
  }
});

test('a public edition that fails to publish never holds back the device: latest.json, inflight.json and the catch-up refresh all happen', async () => {
  const d = await deliverHost();
  try {
    const inflight = JSON.stringify({ schema: 1, run: { id: '777' }, platforms: ['android'] });
    const fetchImpl = async url => {
      if (String(url).endsWith(editionLatestKey('example-app', 'beta'))) return { status: 200, ok: true, text: async () => '{"extra":1}' };
      if (String(url).endsWith('example-app/inflight.json')) return { status: 200, ok: true, text: async () => inflight };
      return { status: 404, ok: false, text: async () => '' };
    };
    await assert.rejects(d.run(['--dry-run', 'false'], { fetchImpl }), /the beta edition was not published \(beta: edition latest\.json: unknown key "extra"\); the device's delivery stands/);
    const ops = d.writes.map(write => `${write.op} ${write.key}`);
    assert.ok(ops.includes('put example-app/latest.json'), ops.join('\n'));
    assert.ok(ops.includes('rm example-app/inflight.json'), `this run's inflight.json is cleared, so the catch-up is free to install\n${ops.join('\n')}`);
    assert.ok(!ops.some(op => /editions/.test(op)), ops.join('\n'));
    assert.ok(d.logs.some(line => /^::error::edition beta \(io\.example\.beta\) was not published/.test(line)), d.logs.join('\n'));
    assert.equal(d.receipt().editions[0].pointer, 'failed');
  } finally { await d.cleanup(); }
  // A dry run reports the same edition failure and still writes nothing.
  const dry = await deliverHost({ betaReceipt: false });
  try {
    await assert.rejects(dry.run([]), /the beta edition's receipt for 0\.2\.2 is missing/);
    assert.deepEqual(dry.writes, []);
  } finally { await dry.cleanup(); }
});

test('a private edition rides the Release only when GitHub says the repository is private', async () => {
  const h = await appHost({ manifest: twoEditions({ public: false }) });
  try {
    const planned = await quiet(() => plan(h.configure('plan', ['--dry-run', 'false']), { env: h.env, home: h.root, fetchImpl: notFound, s3Factory: async () => h.s3 }));
    git(h.app, ['checkout', '-q', planned.build_sha], h.env);
    await quiet(() => android(h.configure('android', ['--dry-run', 'false', '--version', '0.2.2', '--android-code', '5', '--build-sha', planned.build_sha]), { env: h.env, home: h.root, quickdropLink: async () => ({ onLan: true, reason: 'test' }) }));
    await quiet(() => release(h.configure('release', ['--dry-run', 'false', '--version', '0.2.2', '--android-code', '5', '--build-sha', planned.build_sha]), { env: { ...h.env, GH_TOKEN: 'token', GH_PRIVATE: 'false' }, fetchImpl: notFound }));
    const created = readFileSync(join(h.root, 'gh.log'), 'utf8').split('\n').find(line => line.startsWith('gh release create'));
    assert.doesNotMatch(created, /beta/, 'a public repository\'s Release carries no private edition');
    // MOBI-17: nor the private device edition (the policy does not publish it), nor its receipts
    assert.doesNotMatch(created, /App\.apk|hub-receipt-android\.json|receipt/, 'a public repository\'s Release carries no private device APK');
    assert.match(created, /^gh release create v0\.2\.2 --repo /);
  } finally { await h.cleanup(); }
});

// ---------------------------------------------------------------------------------------------------- device selection

test('the catch-up and the build directory see only the device edition: a beta block is refused, beta keys never enter history or retention', () => {
  const app = settingsFrom({ ...policy, apps: { 'delorenj/example-app': exampleApp() } }).apps[0];
  const latest = sampleLatest({ slug: 'example-app', name: 'Example App' });
  latest.android = { ...latest.android, package: 'io.example.app', signer_sha256: signer, key: apkKey('example-app', '0.2.2', 4), url: publicUrl(base, apkKey('example-app', '0.2.2', 4)), quickdrop: null };
  latest.ios = null;
  delete latest.mac_bytes;
  assert.deepEqual(latestProblems(latest, 'example-app', base, app), []);
  // A latest.json that points the S26 at the beta (pinned by the policy, but as an edition) is refused.
  const beta = { ...latest, android: { ...latest.android, package: 'io.example.beta' } };
  assert.match(latestProblems(beta, 'example-app', base, app).join('; '), /android\.package io\.example\.beta is not the policy's io\.example\.app/);
  // History and retention of the device edition skip the editions folder; the edition's retention touches only its own.
  const listing = [
    { key: 'example-app/0.2.2/example-app-0.2.2-4.apk', size: 10 },
    { key: editionApkKey('example-app', 'beta', '0.2.2', 4), size: 11 },
    ...['0.1.0', '0.1.1', '0.1.2', '0.1.3', '0.1.4', '0.1.5'].map((version, index) => ({ key: editionApkKey('example-app', 'beta', version, index + 1), size: 5 })),
  ];
  assert.deepEqual(historyOf(listing, policy, 'example-app').map(item => item.url), [publicUrl(base, 'example-app/0.2.2/example-app-0.2.2-4.apk')]);
  const removed = [];
  const s3 = { remove: key => removed.push(key) };
  pruneVersions({ s3, policy, slug: 'example-app', latest, listing });
  assert.deepEqual(removed, [], 'the device retention never removes an edition key');
  const pointer = { version: '0.2.2', key: editionApkKey('example-app', 'beta', '0.2.2', 4) };
  pruneEdition({ s3, policy, slug: 'example-app', edition: 'beta', pointer, listing });
  assert.deepEqual(removed, [editionApkKey('example-app', 'beta', '0.1.0', 1), editionApkKey('example-app', 'beta', '0.1.1', 2)], 'the newest five edition versions and the pointer stay');
  // Quickdrop takes only the device edition's name, and dropping it leaves an edition file alone.
  assert.throws(() => dropApk({ apk: policyFile, dir: tmpdir(), name: editionApkName('example-app', 'beta', '0.2.2', 4), slug: 'example-app', maxBytes: 1e9 }), /not a hub APK name for example-app/);
});

test('edition keys, pointer, checksum and page are well formed', () => {
  assert.equal(editionApkKey('earshot', 'beta', '0.1.2', 7), 'earshot/editions/beta/0.1.2/earshot-beta-0.1.2-7.apk');
  assert.equal(editionPageKey('earshot', 'beta'), 'earshot/editions/beta/index.html');
  assert.throws(() => editionApkKey('earshot', '../x', '0.1.2', 7), /bad edition/);
  assert.throws(() => editionApkKey('earshot', 'beta', '0.1', 7), /bad version/);
  assert.equal(contentTypeOf('earshot/editions/beta/0.1.2/earshot-beta-0.1.2-7.apk.sha256'), 'text/plain; charset=utf-8');
  assert.equal(cacheControlOf('earshot/editions/beta/latest.json'), 'no-cache');
  assert.equal(cacheControlOf('earshot/editions/beta/index.html'), 'no-cache');
  assert.equal(cacheControlOf('earshot/editions/beta/0.1.2/earshot-beta-0.1.2-7.apk'), 'public, max-age=31536000, immutable');
  const key = editionApkKey('earshot', 'beta', '0.1.2', 7);
  const pointer = { schema: 1, slug: 'earshot', app: 'Earshot <beta>', edition: 'beta', title: 'Beta', package: 'io.automaticai.earshot', version: '0.1.2', code: 7, key, url: publicUrl(base, key), bytes: 1234, sha256: 'a'.repeat(64), sha256_url: publicUrl(base, `${key}.sha256`), signer_sha256: signer, commit: 'c'.repeat(40), run: { repo: 'delorenj/earshot', id: '5', attempt: 1, url: null }, correlation: '6f1c2b44-0d1e-5a7b-9c3d-2e4f5a6b7c8d', updated_at: '2026-11-18T00:00:00Z' };
  assert.doesNotThrow(() => validateEditionPointer(pointer, { base, slug: 'earshot', edition: 'beta' }));
  assert.throws(() => validateEditionPointer({ ...pointer, key: apkKey('earshot', '0.1.2', 7) }), /key must name this release's edition APK/);
  assert.throws(() => validateEditionPointer({ ...pointer, extra: 1 }), /unknown key/);
  assert.match(editionPage(pointer), /Earshot &lt;beta&gt;/, 'escaped');
  const next = { ...pointer, version: '0.1.3', code: 8, run: { id: '6' } };
  assert.equal(mayReplaceEdition(pointer, next).replace, true);
  assert.equal(mayReplaceEdition(next, pointer).replace, false);
  assert.equal(mayReplaceEdition(pointer, { ...pointer, run: { id: '5' }, sha256: 'b'.repeat(64) }).replace, true, 'a rerun of the same run');
  assert.equal(mayReplaceEdition(pointer, { ...pointer, run: { id: '9' }, sha256: 'b'.repeat(64) }).replace, false, 'other bytes from another run');
});
