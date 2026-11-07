// TestFlight follows the caller's opt-in with the deployed policy. The explicit strict completion fixture below
// exercises the deferred policy-derived TestFlight and pre-bump lane refusal without activating them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { callerHash, templateFile } from './lib/caller.mjs';
import { parseConfig } from './lib/config.mjs';
import { parseManifest } from './lib/manifest.mjs';
import { loadPolicy } from './lib/policy.mjs';
import { gate } from './commands/gate.mjs';
import { storePreflight } from './commands/plan.mjs';
import { loadDevices } from './lib/devices.mjs';
import { sampleLatest } from './test-fixtures.mjs';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const template = readFileSync(templateFile, 'utf8');
const { policy: releasedPolicy } = loadPolicy();
const policy = { ...releasedPolicy, completion: { required: { devices: 'lanes', testflight: 'store' }, lane_unavailable: 'refuse', reruns: 1 } };
const strictPolicyText = JSON.stringify(policy);
const pin = policy.apps['delorenj/tower-of-lost-things'];

function manifest({ store = true, preflight = false, state = false } = {}) {
  return {
    schema: 2,
    project: { slug: 'tower-of-lost-things', name: 'Tower of Lost Things' },
    version: { read: 'node version.mjs', bump: 'node version.mjs bump' },
    android: { package: pin.android.package, export: 'true', artifact: 'artifacts/App.apk', signer_sha256: pin.android.signer_sha256 },
    ios: {
      bundle: pin.ios.bundle, export: 'true', archive: 'App-ipad.tgz', receipt: 'ipad-export.json', device: 'true', device_artifact: 'App.xcarchive',
      ...(store ? { store: { archive: 'App-xcode.tgz', receipt: 'testflight-export.json', upload: 'node tools/testflight.mjs upload', assign: 'node tools/testflight.mjs assign', signer_sha1: 'F8A5C5309FC1B6C7DD7662A28EA822BE3309C351', ...(preflight ? { preflight: 'node tools/ios.mjs store-preflight' } : {}), ...(state ? { state: 'node tools/testflight.mjs state' } : {}) } } : {}),
    },
  };
}

const peer = (curAddr, online = true) => ({ Peer: { k: { DNSName: 'carries-macbook-air.burro-salmon.ts.net.', HostName: 'Mac', Online: online, CurAddr: curAddr, Relay: 'nyc' } } });
const home = () => peer('192.168.1.23:41641');
const offline = () => peer('', false);
const metered = () => peer('76.98.73.87:11349');
const heavyLatest = JSON.stringify(sampleLatest({ mac_bytes: 400 * 1024 * 1024 }));

async function fixture({ app = manifest(), policyText = strictPolicyText } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'hub-gate13-'));
  const checkout = join(root, 'app');
  await mkdir(join(checkout, '.github/workflows'), { recursive: true });
  await mkdir(join(checkout, 'tools/ci'), { recursive: true });
  await writeFile(join(checkout, '.github/workflows/deploy.yml'), template);
  await writeFile(join(checkout, 'tools/ci/mobile-deploy.json'), JSON.stringify(app));
  const output = join(root, 'output');
  await writeFile(output, '');
  let policyFile;
  if (policyText) { policyFile = join(root, 'policy.json'); await writeFile(policyFile, policyText); }
  const env = {
    PATH: process.env.PATH, HOME: root, GITHUB_REPOSITORY: 'delorenj/tower-of-lost-things', GITHUB_WORKFLOW_REF: 'delorenj/tower-of-lost-things/.github/workflows/deploy.yml@refs/heads/main',
    GITHUB_REF: 'refs/heads/main', GITHUB_RUN_ID: '555', GITHUB_OUTPUT: output, HUB_REF: 'v1.3.0', HUB_LOCK_DIR: join(root, 'locks'),
  };
  const writes = [];
  const s3 = { putText(text, key) { writes.push(['put', key]); }, put(file, key) { writes.push(['put', key]); }, remove(key) { writes.push(['rm', key]); }, list: () => [] };
  const logs = [];
  const run = (flags, { tailscale = home, latest = null } = {}) => gate({ ...parseConfig(['gate', '--manifest', 'tools/ci/mobile-deploy.json', '--out', join(root, 'out'), ...flags], env), cwd: checkout }, {
    env, home: root, s3Factory: async () => s3, tailscale, macProbe: () => ({ runner: 'alive', catchup: 'live' }), runnerStatus: () => ({ status: 'online', busy: false }),
    adbFactory: () => ({ startServer() {}, devices: () => [], prop() { throw new Error('offline'); } }), log: line => logs.push(line), policyFile,
    fetchImpl: async () => (latest ? { status: 200, ok: true, text: async () => latest } : { status: 404, ok: false, text: async () => '' }),
  });
  const outputs = () => Object.fromEntries(readFileSync(output, 'utf8').trim().split('\n').filter(Boolean).map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
  const receipt = () => JSON.parse(readFileSync(join(root, 'out/gate/hub-receipt-gate.json'), 'utf8'));
  return { root, run, writes, logs, outputs, receipt, cleanup: () => rm(root, { recursive: true, force: true }) };
}

const real = ['--dry-run', 'false'];

test('strict completion requires TestFlight for store apps even when the caller passes false', async () => {
  const table = [
    // [name, manifest, flags, tailscale, latest] -> [ios_lane, testflight, store_preflight]
    ['store app, dry, Mac home', manifest(), [], home, null, ['run', 'true', 'false']],
    ['store app, real, Mac home', manifest(), real, home, null, ['run', 'true', 'false']],
    ['the caller said testflight=false', manifest(), [...real, '--testflight', 'false'], home, null, ['run', 'true', 'false']],
    ['non-store app without TestFlight', manifest({ store: false }), [], home, null, ['run', 'false', 'false']],
    ['store app with ios.store.preflight', manifest({ preflight: true }), real, home, null, ['run', 'true', 'true']],
    ['no ios.store', manifest({ store: false }), real, home, null, ['run', 'false', 'false']],
    ['--platform android narrows TestFlight out (INCOMPLETE later)', manifest(), [...real, '--platform', 'android'], offline, null, ['skip-platform', 'false', 'false']],
    ['a dry run with the Mac offline still owes TestFlight', manifest(), [], offline, null, ['skip-offline', 'true', 'false']],
    ['a dry run over the metered budget still owes TestFlight', manifest(), [], metered, heavyLatest, ['skip-metered', 'true', 'false']],
    ['a real run over budget with --metered allow', manifest(), [...real, '--metered', 'allow'], metered, heavyLatest, ['run', 'true', 'false']],
  ];
  for (const [name, app, flags, tailscale, latest, expected] of table) {
    const f = await fixture({ app });
    try {
      const result = await f.run(flags, { tailscale, latest });
      const out = f.outputs();
      assert.deepEqual([out.ios_lane, out.testflight, out.store_preflight], expected, name);
      assert.equal(result.testflight, expected[1] === 'true', name);
      assert.deepEqual(f.receipt().gate.completion.required, { android: true, ios: true, testflight: Boolean(app.ios.store) }, name);
      assert.ok(f.logs.some(line => line.startsWith(`HUB_TESTFLIGHT ${expected[1] === 'true' ? 'owed' : 'not owed'}: `)), `${name}\n${f.logs.join('\n')}`);
    } finally { await f.cleanup(); }
  }
});

test('a real run whose required iOS lane would not run is refused at the gate, before plan and before anything is written', async () => {
  const cases = [
    ['Mac offline', manifest(), real, offline, null, /HUB_GATE_REFUSED lane_unavailable: the Mac is offline \(.*\), so the iPad and TestFlight would not be delivered; bring the Mac back, or narrow with --platform android .*Nothing was spent/],
    ['metered over budget', manifest(), real, metered, heavyLatest, /HUB_GATE_REFUSED lane_unavailable: the Mac is on a metered link .*150 MiB budget, so the iPad and TestFlight would not be delivered; pass --metered allow/],
    ['no store app: the iPad alone', manifest({ store: false }), real, offline, null, /HUB_GATE_REFUSED lane_unavailable: the Mac is offline .*so the iPad would not be delivered/],
    ['--platform ios with the Mac offline', manifest(), [...real, '--platform', 'ios'], offline, null, /HUB_GATE_REFUSED lane_unavailable/],
  ];
  for (const [name, app, flags, tailscale, latest, refusal] of cases) {
    const f = await fixture({ app });
    try {
      await assert.rejects(f.run(flags, { tailscale, latest }), refusal, name);
      assert.deepEqual(f.writes, [], `${name}: refused before the S3 probe`);
      assert.equal(f.outputs().ios_lane, undefined, `${name}: no outputs, so plan (needs: gate success) never runs`);
      const receipt = f.receipt();
      assert.equal(receipt.outcome, 'failure');
      assert.match(receipt.reason, /^HUB_GATE_REFUSED lane_unavailable: /, 'announce and the completion verdict read the refusal from here');
      assert.notEqual(receipt.gate.ios_lane, 'run', 'and what the gate read');
    } finally { await f.cleanup(); }
  }
});

test('lane_unavailable: skip is the v1.2 rollback: the real run goes on with the iPad lane skipped', async () => {
  const skip = structuredClone(policy);
  skip.completion.lane_unavailable = 'skip';
  const f = await fixture({ policyText: JSON.stringify(skip) });
  try {
    const result = await f.run(real, { tailscale: offline });
    assert.deepEqual([result.ios_lane, result.testflight], ['skip-offline', true]);
  } finally { await f.cleanup(); }
});

test('released policy skips an unavailable lane, does not require devices, and leaves TestFlight opt-in', async () => {
  const f = await fixture({ policyText: JSON.stringify(releasedPolicy) });
  try {
    const defaultRun = await f.run(real);
    assert.deepEqual([defaultRun.ios_lane, defaultRun.testflight], ['run', false]);
    assert.deepEqual(f.receipt().gate.completion.required, { android: false, ios: false, testflight: false });
    const optedIn = await f.run([...real, '--testflight', 'true']);
    assert.deepEqual([optedIn.ios_lane, optedIn.testflight], ['run', true]);
    const unavailable = await f.run([...real, '--testflight', 'true'], { tailscale: offline });
    assert.deepEqual([unavailable.ios_lane, unavailable.testflight], ['skip-offline', false]);
    assert.equal(f.receipt().gate.completion.lane_unavailable, 'skip');
  } finally { await f.cleanup(); }
});

test('only the gate reads inputs.testflight; every downstream job reads the gate output, announce included', () => {
  const workflow = readFileSync(join(repoRoot, '.github/workflows/mobile-deploy.yml'), 'utf8');
  const code = workflow.split('\n').filter(line => !/^\s*#/.test(line)).join('\n');
  const jobs = code.slice(code.indexOf('\njobs:\n')).split(/\n {2}(?=[\w-]+:\n)/).slice(1);
  const byName = Object.fromEntries(jobs.map(body => [body.split(':')[0], body]));
  assert.equal((code.match(/\$\{\{ inputs\.testflight \}\}/g) ?? []).length, 1, 'the caller opt-in reaches only the gate');
  for (const name of ['preflight-ios', 'plan', 'ios-export', 'ios', 'announce']) assert.match(byName[name], /\n {10}testflight: \$\{\{ needs\.gate\.outputs\.testflight \}\}\n/, name);
  assert.match(byName.gate, /\n {10}testflight: \$\{\{ inputs\.testflight \}\}\n/, 'the gate receives the caller opt-in');
  assert.match(byName.gate, /\n {6}testflight: \$\{\{ steps\.hub\.outputs\.testflight \}\}\n {6}store_preflight: \$\{\{ steps\.hub\.outputs\.store_preflight \}\}\n/);
  for (const [name, body] of Object.entries(byName)) if (/testflight:/.test(body) && name !== 'gate') assert.match(body, /needs: (gate|\[gate,)/, `${name} needs the gate to read its output`);
  assert.match(template, /^ {6}testflight: \$\{\{ inputs\.testflight \}\}$/m);
  assert.ok(policy.callers.accept.includes(callerHash(template)));
  assert.match(code, /testflight:\n\s+description: [^\n]*[Oo]pt-in[^\n]*\n\s+type: boolean\n\s+default: false\n/);
  assert.match(byName.announce, /name: completion-out\n\s+path: \$\{\{ runner\.temp \}\}\/hub-out\/completion\/completion\.json\n/);
});

test('the manifest accepts ios.store.preflight and ios.store.state as optional hooks, strictly', () => {
  assert.equal(parseManifest(JSON.stringify(manifest({ preflight: true, state: true }))).ios.store.preflight, 'node tools/ios.mjs store-preflight');
  assert.equal(parseManifest(JSON.stringify(manifest())).ios.store.state, undefined, 'apps without the hooks behave as before');
  for (const key of ['preflight', 'state']) {
    const bad = manifest();
    bad.ios.store[key] = ['node', 'x'];
    assert.throws(() => parseManifest(JSON.stringify(bad)), new RegExp(`ios\\.store\\.${key} must be a non-empty string`));
    bad.ios.store[key] = '';
    assert.throws(() => parseManifest(JSON.stringify(bad)), new RegExp(`ios\\.store\\.${key} must be a non-empty string`));
  }
  const typo = manifest();
  typo.ios.store.pre_flight = 'x';
  assert.throws(() => parseManifest(JSON.stringify(typo)), /unknown key "pre_flight"/);
});

test('the store preflight runs the app\'s hook from the dispatched commit, and refuses a workspace at another commit', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hub-storepre-'));
  try {
    const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).trim();
    await mkdir(join(root, 'tools/ci'), { recursive: true });
    const app = manifest();
    app.ios.store.preflight = 'echo "pin $HUB_TEAM" > preflight.ran';
    await writeFile(join(root, 'tools/ci/mobile-deploy.json'), JSON.stringify(app));
    git('init', '-q');
    git('add', '.');
    git('commit', '-q', '--no-verify', '-m', 'app');
    const sha = git('rev-parse', 'HEAD');
    const config = { ...parseConfig(['preflight-ios', '--manifest', 'tools/ci/mobile-deploy.json', '--out', join(root, 'out'), '--testflight', 'true', '--store-preflight', 'true'], {}), cwd: root };
    assert.equal(config.storePreflight, true);
    const devices = loadDevices({});
    const notes = [];
    const logs = [];
    const quiet = async fn => { const log = console.log; console.log = () => {}; try { return await fn(); } finally { console.log = log; } };
    await quiet(() => storePreflight(config, { env: { ...process.env, GITHUB_ACTIONS: 'true', GITHUB_SHA: sha }, devices, notes, log: line => logs.push(line) }));
    assert.equal(readFileSync(join(root, 'preflight.ran'), 'utf8').trim(), `pin ${devices.apple.team}`);
    assert.ok(logs.some(line => /^HUB_STORE_PREFLIGHT ok/.test(line)) && notes.some(note => /ios\.store\.preflight passed/.test(note)));
    await assert.rejects(storePreflight(config, { env: { ...process.env, GITHUB_ACTIONS: 'true', GITHUB_SHA: 'f'.repeat(40) }, devices, notes, log: () => {} }), /needs the dispatched commit ffffffff checked out; this Mac's workspace is at/);
    app.ios.store.preflight = 'echo "XCODE_VERSION: Xcode 27.1, the pin is 27.0" >&2; exit 3';
    await writeFile(join(root, 'tools/ci/mobile-deploy.json'), JSON.stringify(app));
    await assert.rejects(quiet(() => storePreflight(config, { env: { ...process.env }, devices, notes, log: () => {} })), /hook ios\.store\.preflight failed \(exit 3\)/, 'a stale Xcode pin fails here, before plan bumps');
    delete app.ios.store.preflight;
    await writeFile(join(root, 'tools/ci/mobile-deploy.json'), JSON.stringify(app));
    await assert.rejects(storePreflight(config, { env: { ...process.env }, devices, notes, log: () => {} }), /has ios\.store\.preflight, and the checkout's copy has none/);
    assert.equal(existsSync(join(root, 'out/preflight')), false, 'the hook writes no receipt of its own');
  } finally { await rm(root, { recursive: true, force: true }); }
});
