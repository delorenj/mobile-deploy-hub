// Per-product adoption (owner direction 2026-11-02: "not across all products, across all platforms within a product").
// The completion contract (ship, the gate-derived TestFlight, the lane_unavailable refusal, the store preflight, the
// completion verdict) applies only to the repositories policy completion.apps lists, today Tower of Lost Things. An app
// outside the list must see hub v1.2.25 behaviour from every job, now and when v1 later moves. This file holds the
// policy parse, the pinned-caller derivation and the gate table; the plan, ios, announce, conformance and ship halves
// live beside their fixtures (v3, store, completion and ship tests).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkApp, shipTemplateFile } from '../conformance.mjs';
import { hubRefFrom } from '../deploy.mjs';
import { callerHash, checkCaller, normalizeCaller, pinTemplate, templateFile } from './lib/caller.mjs';
import { parseConfig } from './lib/config.mjs';
import { adopts, loadPolicy, parsePolicy, policyFile } from './lib/policy.mjs';
import { gate } from './commands/gate.mjs';
import { sampleLatest } from './test-fixtures.mjs';

const source = readFileSync(policyFile, 'utf8');
const { policy } = loadPolicy();
const template = readFileSync(templateFile, 'utf8');
const TOWER = 'delorenj/tower-of-lost-things';
const GRUVATO = 'delorenj/gruvato';

// ---------------------------------------------------------------------------------------------------- policy

test('policy.json parses and lists exactly Tower in completion.apps; every other product is outside the contract', () => {
  assert.deepEqual(policy.completion.apps, [TOWER]);
  assert.equal(parsePolicy(source).completion.apps.length, 1);
  assert.equal(adopts(policy, TOWER), true);
  for (const repo of Object.keys(policy.apps).filter(name => name !== TOWER)) assert.equal(adopts(policy, repo), false, repo);
  assert.equal(adopts(policy, ''), false);
  assert.equal(adopts(policy, 'someone/else'), false);
  assert.equal(adopts({ completion: {} }, TOWER), false, 'a policy without the list adopts nothing');
});

test('a bad completion.apps is refused, whatever it gets wrong', () => {
  const base = JSON.parse(source);
  const cases = {
    'no apps': p => { delete p.completion.apps; },
    'apps is a string': p => { p.completion.apps = TOWER; },
    'apps is an object': p => { p.completion.apps = { [TOWER]: true }; },
    'apps null': p => { p.completion.apps = null; },
    'a non-string entry': p => { p.completion.apps = [1]; },
    'an object entry': p => { p.completion.apps = [{ repo: TOWER }]; },
    'not owner/repo': p => { p.completion.apps = ['tower-of-lost-things']; },
    'a path, not a repo': p => { p.completion.apps = ['delorenj/tower/of']; },
    'a repository the policy does not list': p => { p.completion.apps = ['delorenj/unknown-app']; },
    'listed twice': p => { p.completion.apps = [TOWER, TOWER]; },
    'one good, one bad': p => { p.completion.apps = [TOWER, 'nope']; },
    'a glob': p => { p.completion.apps = ['delorenj/*']; },
  };
  for (const [name, change] of Object.entries(cases)) {
    const copy = structuredClone(base);
    change(copy);
    assert.throws(() => parsePolicy(JSON.stringify(copy)), /policy\.json: /, name);
  }
  // Allowed: none at all (the contract off everywhere), or several listed apps.
  for (const apps of [[], [TOWER, GRUVATO], [GRUVATO]]) {
    const copy = structuredClone(base);
    copy.completion.apps = apps;
    assert.deepEqual(parsePolicy(JSON.stringify(copy)).completion.apps, apps);
  }
});

// ---------------------------------------------------------------------------------------------------- the pinned caller

test('Tower\'s caller pinned at v1.2.27 is accepted, derived from the template, and so is the plain @v1 template', () => {
  const pinned = pinTemplate(template, 'v1.2.27');
  assert.notEqual(pinned, template);
  assert.equal(pinned.match(/mobile-deploy\.yml@v1\.2\.27$/m)?.length, 1, 'the one uses: line carries the tag');
  assert.equal(template.split('\n').filter(line => /mobile-deploy\.yml@/.test(line)).length, 1, 'the template has exactly one ref to pin');
  // Nothing but that ref differs.
  assert.deepEqual(normalizeCaller(pinned).split('\n').filter((line, i) => line !== normalizeCaller(template).split('\n')[i]), ['    uses: delorenj/mobile-deploy-hub/.github/workflows/mobile-deploy.yml@v1.2.27']);
  assert.ok(policy.callers.accept.includes(callerHash(pinned)), 'the derived hash is in callers.accept');
  assert.ok(policy.callers.accept.includes(callerHash(template)), 'the plain @v1 template is still accepted');
  assert.equal(policy.callers.accept.length, 2, 'exactly those two');
  const env = { GITHUB_REPOSITORY: TOWER, GITHUB_WORKFLOW_REF: `${TOWER}/.github/workflows/deploy.yml@refs/heads/main` };
  assert.equal(checkCaller({ policy, env, read: () => pinned }).hash, callerHash(pinned));
  assert.equal(checkCaller({ policy, env, read: () => template }).hash, callerHash(template));
  // Comments and the way the app writes the file still do not matter; a different pin, a branch or a re-pin does.
  assert.ok(policy.callers.accept.includes(callerHash(`# Tower's own words\n${pinned}`)));
  for (const ref of ['v1.2.28', 'v1.2.26', 'main', 'v1.2']) {
    const other = template.replace('mobile-deploy.yml@v1\n', `mobile-deploy.yml@${ref}\n`);
    assert.throws(() => checkCaller({ policy, env, read: () => other }), /HUB_GATE_REFUSED caller: .*not an accepted copy/, `@${ref} is not accepted`);
  }
  assert.throws(() => checkCaller({ policy, env, read: () => pinned.replace('strict: true', 'strict: false').replace('dry_run: ${{ inputs.dry_run }}', 'dry_run: false') }), /not an accepted copy/, 'a pinned caller still cannot change anything else');
  assert.throws(() => pinTemplate(template, 'v1'), /release tag/);
  assert.throws(() => pinTemplate(template, 'main'), /release tag/);
});

test('nothing else requires the literal @v1 for an app pinned at a vX.Y.Z tag: the front door, ship, the gate and conformance', async () => {
  const pinned = pinTemplate(template, 'v1.2.27');
  // The front door (`mise run deploy`, ship): the ref comes from the caller's uses: line, any ref.
  assert.equal(hubRefFrom(pinned), 'v1.2.27');
  assert.equal(hubRefFrom(template), 'v1');
  // The ship task's sed (templates/mise-ship.toml) reads the same ref, then fetches deploy.mjs at it.
  const shipTemplate = readFileSync(shipTemplateFile, 'utf8');
  const refLine = /^ref=.*$/m.exec(/\nrun = '''\n([\s\S]*?)\n'''/.exec(shipTemplate)[1])[0];
  const root = await mkdtemp(join(tmpdir(), 'hub-pin-'));
  try {
    await mkdir(join(root, '.github/workflows'), { recursive: true });
    await writeFile(join(root, '.github/workflows/deploy.yml'), pinned);
    const result = spawnSync('sh', ['-c', `${refLine}\necho "$ref"`], { cwd: root, encoding: 'utf8' });
    assert.equal(result.stdout.trim(), 'v1.2.27', result.stderr);
  } finally { await rm(root, { recursive: true, force: true }); }
  // The gate: the caller ref it reports is the dispatch ref (GITHUB_WORKFLOW_REF), unrelated to the pin; the hub code ref
  // a real run needs (HUB_REF) is any release tag, which is what the workflow's inner pins name.
  const env = { GITHUB_REPOSITORY: TOWER, GITHUB_WORKFLOW_REF: `${TOWER}/.github/workflows/deploy.yml@refs/heads/main` };
  assert.equal(checkCaller({ policy, env, read: () => pinned }).ref, 'refs/heads/main');
  // Conformance: the caller check is the same accept list, so a pinned caller raises no problem.
  const app = policy.apps[TOWER];
  const manifest = { schema: 2, project: { slug: 'tower-of-lost-things', name: 'Tower' }, version: { read: 'true', bump: 'true' }, android: { package: app.android.package, export: 'true', artifact: 'a/App.apk', signer_sha256: app.android.signer_sha256 }, ios: { bundle: app.ios.bundle, device: 'true', device_artifact: 'A.xcarchive' } };
  const files = { '.github/workflows/deploy.yml': pinned, 'tools/ci/mobile-deploy.json': JSON.stringify(manifest) };
  const open = { read: path => { if (!(path in files)) throw Object.assign(new Error('404'), { code: 'ENOENT' }); return files[path]; }, list: () => ['.github/workflows/deploy.yml'] };
  assert.deepEqual(checkApp({ repo: TOWER, app, policy, ...open }), []);
  const stale = { ...files, '.github/workflows/deploy.yml': pinned.replace('@v1.2.27', '@v1.2.99') };
  assert.ok(checkApp({ repo: TOWER, app, policy, read: path => stale[path], list: open.list }).some(problem => /not an accepted copy of templates\/deploy\.yml/.test(problem)), 'an unlisted pin is a conformance finding');
});

// ---------------------------------------------------------------------------------------------------- the gate table

function manifest(repo, { store = true, preflight = false, state = false } = {}) {
  const pin = policy.apps[repo];
  return {
    schema: 2,
    project: { slug: pin.slug, name: pin.slug },
    version: { read: 'node version.mjs', bump: 'node version.mjs bump' },
    android: { package: pin.android.package, export: 'true', artifact: 'artifacts/App.apk', signer_sha256: pin.android.signer_sha256 },
    ios: {
      bundle: pin.ios.bundle, export: 'true', archive: 'App-ipad.tgz', receipt: 'ipad-export.json', device: 'true', device_artifact: 'App.xcarchive',
      ...(store ? { store: { archive: 'App-xcode.tgz', receipt: 'testflight-export.json', upload: 'node tools/testflight.mjs upload', assign: 'node tools/testflight.mjs assign', signer_sha1: 'F8A5C5309FC1B6C7DD7662A28EA822BE3309C351', ...(pin.ios.store_bundle ? { bundle: pin.ios.store_bundle } : {}), ...(preflight ? { preflight: 'node tools/ios.mjs store-preflight' } : {}), ...(state ? { state: 'node tools/testflight.mjs state' } : {}) } } : {}),
    },
  };
}

const peer = (curAddr, online = true) => ({ Peer: { k: { DNSName: 'carries-macbook-air.burro-salmon.ts.net.', HostName: 'Mac', Online: online, CurAddr: curAddr, Relay: 'nyc' } } });
const home = () => peer('192.168.1.23:41641');
const offline = () => peer('', false);
const metered = () => peer('76.98.73.87:11349');
// latest.json says whose it is; the same heavy Mac estimate for either app.
const heavyFor = repo => JSON.stringify({ ...sampleLatest({ mac_bytes: 400 * 1024 * 1024 }), slug: policy.apps[repo].slug });
const heavyLatest = 'heavy';
const real = ['--dry-run', 'false'];

async function fixture(repo, app) {
  const root = await mkdtemp(join(tmpdir(), 'hub-adopt-'));
  const checkout = join(root, 'app');
  await mkdir(join(checkout, '.github/workflows'), { recursive: true });
  await mkdir(join(checkout, 'tools/ci'), { recursive: true });
  await writeFile(join(checkout, '.github/workflows/deploy.yml'), template);
  await writeFile(join(checkout, 'tools/ci/mobile-deploy.json'), JSON.stringify(app));
  const output = join(root, 'output');
  await writeFile(output, '');
  const env = {
    PATH: process.env.PATH, HOME: root, GITHUB_REPOSITORY: repo, GITHUB_WORKFLOW_REF: `${repo}/.github/workflows/deploy.yml@refs/heads/main`,
    GITHUB_REF: 'refs/heads/main', GITHUB_RUN_ID: '555', GITHUB_OUTPUT: output, HUB_REF: 'v1.2.27', HUB_GATE_ADB_WAIT_MS: '1', HUB_LOCK_DIR: join(root, 'locks'),
  };
  const writes = [];
  const s3 = { putText(text, key) { writes.push(['put', key]); }, put(file, key) { writes.push(['put', key]); }, remove(key) { writes.push(['rm', key]); }, list: () => [] };
  const logs = [];
  const run = (flags, { tailscale = home, latest: wanted = null } = {}) => gate({ ...parseConfig(['gate', '--manifest', 'tools/ci/mobile-deploy.json', '--out', join(root, 'out'), ...flags], env), cwd: checkout }, {
    env, home: root, s3Factory: async () => s3, tailscale, macProbe: () => ({ runner: 'alive', catchup: 'live' }), runnerStatus: () => ({ status: 'online', busy: false }),
    adbFactory: () => ({ startServer() {}, devices: () => [], prop() { throw new Error('offline'); } }), log: line => logs.push(line),
    fetchImpl: async () => (wanted ? { status: 200, ok: true, text: async () => (wanted === 'heavy' ? heavyFor(repo) : wanted) } : { status: 404, ok: false, text: async () => '' }),
  });
  const outputs = () => Object.fromEntries(readFileSync(output, 'utf8').trim().split('\n').filter(Boolean).map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
  const receipt = () => JSON.parse(readFileSync(join(root, 'out/gate/hub-receipt-gate.json'), 'utf8'));
  return { run, writes, logs, outputs, receipt, cleanup: () => rm(root, { recursive: true, force: true }) };
}

// [name, manifest options, flags, tailscale, latest] -> [ios_lane, testflight, store_preflight] for an app OUTSIDE the list
// (hub v1.2.25: TestFlight is the caller's input and nothing else, the Mac being away skips the lane, no store preflight)
// and for a product the list names (the new rules).
const rows = [
  ['default input, store app, Mac home', {}, [], home, null, ['run', 'false', 'false'], ['run', 'true', 'false']],
  ['real run, store app, Mac home', {}, real, home, null, ['run', 'false', 'false'], ['run', 'true', 'false']],
  ['caller testflight=true on a store app', {}, [...real, '--testflight', 'true'], home, null, ['run', 'true', 'false'], ['run', 'true', 'false']],
  ['caller testflight=true on a non-store app (the plan, not the gate, refuses it)', { store: false }, ['--testflight', 'true'], home, null, ['run', 'true', 'false'], ['run', 'false', 'false']],
  ['caller testflight=false, store app', {}, [...real, '--testflight', 'false'], home, null, ['run', 'false', 'false'], ['run', 'true', 'false']],
  ['store app with ios.store.preflight', { preflight: true }, real, home, null, ['run', 'false', 'false'], ['run', 'true', 'true']],
  ['store app with ios.store.state', { state: true }, real, home, null, ['run', 'false', 'false'], ['run', 'true', 'false']],
  ['--platform android, caller testflight=true', {}, [...real, '--platform', 'android', '--testflight', 'true'], offline, null, ['skip-platform', 'true', 'false'], ['skip-platform', 'false', 'false']],
  ['dry run, Mac offline', {}, [], offline, null, ['skip-offline', 'false', 'false'], ['skip-offline', 'true', 'false']],
  ['dry run over the metered budget', {}, [], metered, heavyLatest, ['skip-metered', 'false', 'false'], ['skip-metered', 'true', 'false']],
];

test('gate outputs for an app outside completion.apps equal v1.2.25 (testflight is the caller\'s input), and a listed app gets the new rules', async () => {
  for (const [name, options, flags, tailscale, latest, outside, listed] of rows) {
    for (const [repo, expected] of [[GRUVATO, outside], [TOWER, listed]]) {
      const f = await fixture(repo, manifest(repo, options));
      try {
        const result = await f.run(flags, { tailscale, latest });
        const out = f.outputs();
        assert.deepEqual([out.ios_lane, out.testflight, out.store_preflight], expected, `${repo}: ${name}`);
        assert.equal(result.testflight, expected[1] === 'true', `${repo}: ${name}`);
        if (repo === GRUVATO) {
          assert.equal(f.receipt().gate.completion, undefined, `${name}: no completion block in an outside app's receipt`);
          assert.ok(!f.logs.some(line => line.startsWith('HUB_TESTFLIGHT ')), `${name}: the gate says nothing about TestFlight`);
          assert.match(f.logs.find(line => line.startsWith('HUB_GATE ok')), /ios_lane=\S+$/, `${name}: the v1.2.25 summary line, no testflight= suffix`);
        } else {
          assert.deepEqual(f.receipt().gate.completion.required, { android: true, ios: true, testflight: Boolean(options.store ?? true) }, name);
          assert.ok(f.logs.some(line => line.startsWith('HUB_TESTFLIGHT ')), name);
        }
      } finally { await f.cleanup(); }
    }
  }
});

test('a real run whose iPad lane would not run is SKIPPED, not refused, for an app outside completion.apps; a listed app is refused before anything is written', async () => {
  const cases = [['Mac offline', offline, null, 'skip-offline'], ['metered over budget', metered, heavyLatest, 'skip-metered']];
  for (const [name, tailscale, latest, lane] of cases) {
    const outside = await fixture(GRUVATO, manifest(GRUVATO));
    try {
      const result = await outside.run(real, { tailscale, latest });
      assert.equal(result.ios_lane, lane, `outside: ${name}`);
      assert.ok(outside.writes.length > 0, `outside: ${name}: the run went on to the build directory probe`);
      assert.equal(outside.receipt().outcome, 'success');
    } finally { await outside.cleanup(); }
    const listed = await fixture(TOWER, manifest(TOWER));
    try {
      await assert.rejects(listed.run(real, { tailscale, latest }), /HUB_GATE_REFUSED lane_unavailable/, `listed: ${name}`);
      assert.deepEqual(listed.writes, [], `listed: ${name}: refused before the S3 probe`);
    } finally { await listed.cleanup(); }
  }
});
