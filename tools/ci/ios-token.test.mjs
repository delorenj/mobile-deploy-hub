import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { hookEnvironment, parseConfig } from './lib/config.mjs';
import { ios, testflightStep, uploadHookEnvironment } from './commands/ios.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const workflow = readFileSync(join(root, '.github/workflows/mobile-deploy.yml'), 'utf8');
const action = readFileSync(join(root, 'actions/hub/action.yml'), 'utf8');
const caller = readFileSync(join(root, 'templates/deploy.yml'), 'utf8');
const job = name => workflow.split(`\n  ${name}:\n`)[1]?.split(/\n  [a-z][a-z-]*:\n/)[0];
const step = (body, name) => body.split(`      - name: ${name}\n`)[1]?.split('\n      - ')[0];

// The called job can narrow, never enlarge, the caller's permission ceiling.
test('reusable ios job grants Actions read, preserving its contents read and other jobs', () => {
  assert.match(caller, /uses: delorenj\/mobile-deploy-hub\/\.github\/workflows\/mobile-deploy\.yml@v1/);
  assert.match(caller, /permissions:\n  contents: write\n  id-token: write\n  actions: read/);
  assert.match(job('ios'), /permissions:\n      contents: read\n      actions: read\n/);
  assert.doesNotMatch(job('ios'), /(?:contents|actions): write/);
  for (const name of ['gate', 'preflight-ios', 'ios-export', 'deliver-ios']) {
    assert.match(job(name), /permissions:\n      contents: read\n/);
    assert.doesNotMatch(job(name), /actions: read/);
  }
  assert.match(job('plan'), /permissions:\n      contents: write\n/);
});

test('ios execution forwards only its built-in job token through the composite action', () => {
  const execution = step(job('ios'), 'Build, check, outbox, install on the iPad (or pending)');
  assert.match(execution, /command: ios\n/);
  assert.match(execution, /github_token: \$\{\{ github\.token \}\}/);
  assert.match(action, /GH_TOKEN: \$\{\{ inputs\.github_token \}\}/);
  assert.match(job('plan'), /command: plan[\s\S]*?github_token: \$\{\{ github\.token \}\}/);
  assert.match(job('android'), /command: release[\s\S]*?github_token: \$\{\{ github\.token \}\}/);
});

const base = { GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '2', GITHUB_REPOSITORY: 'owner/app' };
const marker = 'synthetic-test-marker-not-a-credential';
const runPath = '/repos/owner/app/actions/runs/123';
const executionStep = { number: 1, name: 'Build, check, outbox, install on the iPad (or pending)', status: 'completed', conclusion: 'failure' };
const priorJob = { id: 44, run_id: 123, run_attempt: 1, name: 'deploy / ios', status: 'completed', conclusion: 'skipped', runner_name: null, runner_id: null, steps: [] };

function fixture(t, mode = 'allowed', jobs = [priorJob]) {
  const dir = mkdtempSync(join(tmpdir(), 'hub-ios-token-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'bin'));
  const file = (name, content) => writeFileSync(join(dir, name), content);
  file('run.json', JSON.stringify({ id: 123, repository: { full_name: 'owner/app' }, run_attempt: 2 }));
  file('jobs.json', JSON.stringify({ total_count: mode === 'incomplete' ? jobs.length + 1 : jobs.length, jobs }));
  // Records only whether the synthetic marker arrived, never its value. No
  // workstation auth/network is reachable through this private fake CLI.
  writeFileSync(join(dir, 'bin/gh'), `#!${process.execPath}
const { appendFileSync, readFileSync } = require('node:fs');
const dir = ${JSON.stringify(dir)};
const path = process.argv[3];
const authenticated = process.env.GH_TOKEN === ${JSON.stringify(marker)};
appendFileSync(dir + '/requests.jsonl', JSON.stringify({ path, authenticated, saved_login: Boolean(process.env.HOME || process.env.GH_CONFIG_DIR) }) + '\\n');
if (!authenticated || process.argv[2] !== 'api' || ${JSON.stringify(mode)} === 'denied') process.exit(41);
if (${JSON.stringify(mode)} === 'invalid-json') { process.stdout.write('not JSON'); process.exit(0); }
if (path === ${JSON.stringify(runPath)}) process.stdout.write(readFileSync(dir + '/run.json'));
else if (path === ${JSON.stringify(runPath + '/attempts/1/jobs?per_page=100&page=1')}) process.stdout.write(readFileSync(dir + '/jobs.json'));
else process.exit(42);
`, { mode: 0o700 });
  const env = { ...base, PATH: `${join(dir, 'bin')}:${process.env.PATH}`, HOME: dir, GH_CONFIG_DIR: join(dir, 'no-saved-login'), GH_TOKEN: mode === 'absent' ? '' : marker, TMPDIR: tmpdir(), HUB_LOCK_DIR: join(dir, 'locks'), HUB_EVENT_DIR: join(dir, 'events') };
  const config = { testflight: true, dryRun: false, out: join(dir, 'out'), cwd: dir };
  const requests = () => existsSync(join(dir, 'requests.jsonl')) ? readFileSync(join(dir, 'requests.jsonl'), 'utf8').trim().split('\n').map(JSON.parse) : [];
  return { dir, file, env, config, requests };
}

test('upload hook alone gets ephemeral token; other hooks and dry runs never do', t => {
  const f = fixture(t);
  const ordinary = hookEnvironment(f.config, { ...f.env, GITHUB_TOKEN: 'other-synthetic-marker' });
  assert.equal(ordinary.GH_TOKEN, undefined);
  const upload = uploadHookEnvironment(f.config, f.env, ordinary);
  assert.equal(upload.GH_TOKEN, marker);
  assert.equal(upload.GITHUB_TOKEN, undefined);
  assert.equal(uploadHookEnvironment({ ...f.config, dryRun: true }, f.env, ordinary).GH_TOKEN, undefined);
  assert.equal(uploadHookEnvironment({ ...f.config, testflight: false }, f.env, ordinary).GH_TOKEN, undefined);
  assert.throws(() => uploadHookEnvironment(f.config, base, ordinary), /requires the ephemeral job token/);
  assert.equal(uploadHookEnvironment(f.config, {}, ordinary).GH_TOKEN, undefined);
});

for (const mode of ['allowed', 'absent', 'denied', 'incomplete']) {
  test(`actual upload-hook bash/Node/gh subprocess receives token; ${mode}`, t => {
    const f = fixture(t, mode);
    const probe = new URL('./lib/history-probe.mjs', import.meta.url).href;
    f.file('upload.cjs', `import(${JSON.stringify(probe)}).then(({ readHistory }) => {
  const { writeFileSync } = require('node:fs');
  readHistory();
  writeFileSync('transport-reached', 'transport only; no native upload');
}).catch(() => { process.exitCode = 17; });\n`);
    f.file('ordinary.cjs', `const {writeFileSync} = require('node:fs');
if (process.env.GH_TOKEN || process.env.GITHUB_TOKEN) process.exit(90);
writeFileSync('assigned', 'fixture only');\n`);
    const hooks = hookEnvironment(f.config, f.env);
    const store = { version: '9.9.9', build: '999', groups: ['Owner Testing'] };
    const spec = { store: { upload: `${process.execPath} upload.cjs`, assign: `${process.execPath} ordinary.cjs` } };
    const call = () => testflightStep({ spec, config: f.config, store, hooks, uploadHooks: uploadHookEnvironment(f.config, f.env, hooks), log: () => {} });
    if (mode === 'allowed') {
      assert.match(call(), /uploaded and assigned/); // synthetic hook receipt, not a real upload
      assert.equal(existsSync(join(f.dir, 'transport-reached')), true);
      assert.equal(existsSync(join(f.dir, 'assigned')), true);
      assert.equal(f.requests().length, 2);
    } else {
      assert.throws(call, /requires the ephemeral job token|hook ios.store.upload failed/);
      assert.equal(existsSync(join(f.dir, 'transport-reached')), false);
      assert.equal(existsSync(join(f.dir, 'assigned')), false);
      assert.notEqual(store.status, 'assigned');
    }
    assert.ok(f.requests().every(read => read.authenticated && !read.saved_login));
  });
}

const histories = [
  ['cancelled before runner', { ...priorJob, conclusion: 'cancelled', runner_name: '', started_at: null }],
  ['skipped', priorJob],
  ['executed failure', { ...priorJob, conclusion: 'failure', runner_id: 42, runner_name: 'mac', steps: [executionStep] }],
  ['contradictory skipped runner (game guard owns refusal)', { ...priorJob, runner_id: 42 }],
  ['in-progress job (not an upload verdict)', { ...priorJob, status: 'in_progress', conclusion: null }],
  ['unrelated job name (no app-specific matcher)', { ...priorJob, name: 'another app / native' }],
];
function dryFixture(t, mode = 'allowed', jobs = [priorJob]) {
  const f = fixture(t, mode, jobs);
  const devices = JSON.parse(readFileSync(join(root, 'tools/ci/devices.json')));
  devices.mac.min_free_gib = 0.000001;
  f.file('devices.json', JSON.stringify(devices));
  f.env.HUB_DEVICES = join(f.dir, 'devices.json');
  f.file('manifest.json', JSON.stringify({ schema: 2, project: { slug: 'fixture', name: 'Transport Fixture' }, version: { read: 'exit 91', bump: 'exit 92' }, ios: { bundle: 'fixture.app', export: 'exit 93', archive: 'private.tgz', receipt: 'private.json', device: 'exit 94', device_artifact: 'app.xcarchive', store: { archive: 'store.tgz', receipt: 'store.json', upload: 'exit 95', assign: 'exit 96' } } }));
  const logs = [];
  const run = () => ios({ ...parseConfig(['ios', '--manifest', 'manifest.json', '--out', f.config.out, '--version', '9.9.9', '--testflight', 'true'], f.env), cwd: f.dir }, { env: f.env, home: f.dir, log: line => logs.push(line) });
  return { ...f, logs, run };
}

for (const [name, prior] of histories) test(`real ios dry-run retry accepts readable transport: ${name}`, async t => {
  const f = dryFixture(t, 'allowed', [prior]);
  const answer = await f.run();
  const logs = f.logs;
  assert.equal(answer.ipa, null, 'no handoff/native execution in this fixture');
  const proof = JSON.parse(logs.find(line => line.startsWith('HUB_IOS_HISTORY_TRANSPORT_READ ')).split(' ').slice(1).join(' '));
  assert.equal(proof.proof, 'transport-only');
  assert.deepEqual(proof.prior[0].jobs[0].steps, prior.steps);
  assert.equal(proof.prior[0].jobs[0].conclusion, prior.conclusion);
  assert.equal(f.requests().length, 2);
  assert.ok(f.requests().every(read => read.authenticated && !read.saved_login));
  assert.equal(logs.join('\n').includes(marker), false);
});

for (const mode of ['absent', 'denied', 'incomplete', 'invalid-json']) test(`real ios dry-run fails read proof before native work: ${mode}`, async t => {
  const f = dryFixture(t, mode);
  await assert.rejects(f.run, /ephemeral job token|denied or unavailable|incomplete|not JSON/);
  assert.ok(f.logs.some(line => line.startsWith('HUB_IOS_HISTORY_TRANSPORT_REFUSED ')));
  assert.equal(f.logs.some(line => line.startsWith('HUB_IPAD_SKIPPED')), false, 'stopped before build path');
});

for (const changes of [{ GITHUB_RUN_ATTEMPT: '1' }, { testflight: false }]) test(`ordinary dry-run has no retry transport claim: ${JSON.stringify(changes)}`, async t => {
  const f = dryFixture(t);
  if (changes.GITHUB_RUN_ATTEMPT) f.env.GITHUB_RUN_ATTEMPT = changes.GITHUB_RUN_ATTEMPT;
  const config = { ...parseConfig(['ios', '--manifest', 'manifest.json', '--out', f.config.out, '--version', '9.9.9', '--testflight', String(changes.testflight ?? true)], f.env), cwd: f.dir };
  await ios(config, { env: f.env, home: f.dir, log: line => f.logs.push(line) });
  assert.equal(f.requests().length, 0);
  assert.equal(f.logs.some(line => line.includes('HISTORY_TRANSPORT')), false);
});

for (const mode of ['absent', 'denied', 'incomplete', 'invalid-json']) test(`actual probe CLI fails read proof closed: ${mode}`, t => {
  const f = fixture(t, mode);
  const child = spawnSync(process.execPath, [join(root, 'tools/ci/lib/history-probe.mjs')], { env: f.env, encoding: 'utf8' });
  assert.equal(child.status, 1);
  assert.match(child.stderr, /HUB_IOS_HISTORY_TRANSPORT_REFUSED/);
  assert.doesNotMatch(child.stdout, /TRANSPORT_READ/);
  assert.equal(`${child.stdout}${child.stderr}`.includes(marker), false);
});
