import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { hookEnvironment } from './lib/config.mjs';
import { testflightStep, uploadHookEnvironment } from './commands/ios.mjs';
import { readHistory } from './lib/history-probe.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const workflow = readFileSync(join(root, '.github/workflows/mobile-deploy.yml'), 'utf8');
const action = readFileSync(join(root, 'actions/hub/action.yml'), 'utf8');
const caller = readFileSync(join(root, 'templates/deploy.yml'), 'utf8');
const job = name => workflow.split(`\n  ${name}:\n`)[1]?.split(/\n  [a-z][a-z-]*:\n/)[0];
const step = (body, name) => body.split(`      - name: ${name}\n`)[1]?.split('\n      - ')[0];

// This is a reusable workflow: the caller's permission cannot enlarge the called
// job's declared grant. The built-in token belongs to the caller repository.
test('reusable ios job grants Actions read, preserving its contents read and other jobs', () => {
  assert.match(caller, /uses: delorenj\/mobile-deploy-hub\/\.github\/workflows\/mobile-deploy\.yml@v1/);
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
const config = { testflight: true, dryRun: false, out: join(process.env.TMPDIR || '/tmp', 'hub-tolt-137-test') };

test('upload hook alone gets ephemeral token; other hooks and dry runs never do', () => {
  const ordinary = hookEnvironment(config, { ...base, GH_TOKEN: 'ephemeral', GITHUB_TOKEN: 'other-secret' });
  assert.equal(ordinary.GH_TOKEN, undefined);
  const upload = uploadHookEnvironment(config, { ...base, GH_TOKEN: 'ephemeral' }, ordinary);
  assert.equal(upload.GH_TOKEN, 'ephemeral');
  assert.equal(upload.GITHUB_TOKEN, undefined);
  assert.equal(uploadHookEnvironment({ ...config, dryRun: true }, { ...base, GH_TOKEN: 'ephemeral' }, ordinary).GH_TOKEN, undefined);
  assert.equal(uploadHookEnvironment({ ...config, testflight: false }, { ...base, GH_TOKEN: 'ephemeral' }, ordinary).GH_TOKEN, undefined);
  assert.throws(() => uploadHookEnvironment(config, base, ordinary), /requires the ephemeral job token/);
  assert.equal(uploadHookEnvironment(config, {}, ordinary).GH_TOKEN, undefined);
});

function historyCase(mode) {
  const calls = [];
  const token = mode === 'absent' ? undefined : 'ephemeral';
  const normal = hookEnvironment(config, { ...base, GH_TOKEN: token });
  const spec = { store: { state: 'read-store', upload: 'read-history-then-upload', assign: 'assign' } };
  const store = { status: 'checked', version: '0.3.26', build: '12', groups: ['Owner Testing'] };
  const runOutput = (name, _command, { env }) => {
    calls.push(name);
    assert.equal(env.GH_TOKEN, undefined, 'state has no job token');
    return JSON.stringify({ present: false, version: store.version, build: store.build });
  };
  const runHook = (name, _command, { env }) => {
    calls.push(name);
    if (name !== 'ios.store.upload') return;
    // Simulate the guarded GitHub GET of the same run's prior attempt. No native
    // action is invoked unless a complete, readable skipped-job result exists.
    if (!env.GH_TOKEN || mode === 'denied' || mode === 'incomplete') throw new Error('TESTFLIGHT_RECONCILE_GITHUB: history unreadable or incomplete');
    assert.equal(env.GH_TOKEN, token);
    assert.equal(env.GITHUB_REPOSITORY, base.GITHUB_REPOSITORY);
    assert.equal(env.GITHUB_RUN_ID, base.GITHUB_RUN_ID);
  };
  const step = () => testflightStep({ spec, config, store, hooks: normal, uploadHooks: uploadHookEnvironment(config, { ...base, GH_TOKEN: token }, normal), runOutput, runHook });
  return { step, calls, store };
}

test('dry-run history probe reads earlier attempt jobs and relevant iOS step without upload', () => {
  const env = { ...base, GH_TOKEN: 'ephemeral' };
  const path = '/repos/owner/app/actions/runs/123';
  const get = endpoint => {
    if (endpoint === path) return { id: 123, repository: { full_name: 'owner/app' }, run_attempt: 2 };
    if (endpoint === `${path}/attempts/1/jobs?per_page=100&page=1`) return {
      total_count: 1, jobs: [{ id: 44, run_id: 123, run_attempt: 1, name: 'deploy / ios', status: 'completed', conclusion: 'failure', runner_name: 'mac-runner', steps: [{ name: 'Build, check, outbox, install on the iPad (or pending)', status: 'completed', conclusion: 'failure' }] }],
    };
    throw new Error('unexpected read');
  };
  assert.deepEqual(readHistory({ env, request: get }), {
    repository: 'owner/app', run_id: '123', run_attempt: 2,
    prior: [{ attempt: 1, job_id: 44, conclusion: 'failure', runner: 'mac-runner', step_count: 1 }],
  });
  for (const change of [
    { ...env, GH_TOKEN: undefined },
    { ...env, GITHUB_RUN_ID: '999' },
  ]) assert.throws(() => readHistory({ env: change, request: get }), /requires|unexpected read/);
  assert.throws(() => readHistory({ env, request: () => { throw new Error('denied'); } }), /denied/);
  assert.throws(() => readHistory({ env, request: endpoint => endpoint === path ? get(endpoint) : { total_count: 2, jobs: get(endpoint).jobs } }), /incomplete/);
});

test('history-read hook proceeds only with complete history; absent, denied and incomplete refuse before assign', () => {
  const positive = historyCase('allowed');
  assert.match(positive.step(), /uploaded and assigned/);
  assert.deepEqual(positive.calls, ['ios.store.state', 'ios.store.upload', 'ios.store.assign']);
  for (const mode of ['absent', 'denied', 'incomplete']) {
    const negative = historyCase(mode);
    assert.throws(negative.step, /requires the ephemeral job token|history unreadable or incomplete/);
    assert.equal(negative.calls.includes('ios.store.assign'), false, mode);
    assert.notEqual(negative.store.status, 'assigned', mode);
  }
});
