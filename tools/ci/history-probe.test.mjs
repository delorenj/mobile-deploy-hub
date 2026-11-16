import test from 'node:test';
import assert from 'node:assert/strict';
import { readHistory } from './lib/history-probe.mjs';

const env = { GH_TOKEN: 'synthetic-not-a-credential', GITHUB_REPOSITORY: 'owner/app', GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '2' };
const base = '/repos/owner/app/actions/runs/123';
const run = { id: 123, repository: { full_name: 'owner/app' }, run_attempt: 2 };
const job = (id = 44, attempt = 1) => ({ id, run_id: 123, run_attempt: attempt, name: 'any job', status: 'completed', conclusion: 'success', steps: [{ number: 1, name: 'any step', status: 'completed', conclusion: 'success' }] });
const page = (attempt = 1, number = 1) => `${base}/attempts/${attempt}/jobs?per_page=100&page=${number}`;
function read(responses, changes = {}) {
  const calls = [];
  const result = readHistory({ env: { ...env, ...changes }, request: path => {
    calls.push(path);
    assert.ok(Object.hasOwn(responses, path), `unexpected request ${path}`);
    const response = responses[path];
    if (response instanceof Error) throw response;
    return response;
  } });
  return { result, calls };
}
const responses = () => ({ [base]: run, [page()]: { total_count: 1, jobs: [job()] } });

test('transport proof enumerates every prior attempt and all pages, names and step outcomes', () => {
  const first = Array.from({ length: 100 }, (_, i) => job(i + 1));
  const second = job(101);
  const third = { ...job(102, 2), status: 'queued', conclusion: null, steps: [] };
  const { result, calls } = read({ [base]: { ...run, run_attempt: 3 }, [page()]: { total_count: 101, jobs: first }, [page(1, 2)]: { total_count: 101, jobs: [second] }, [page(2)]: { total_count: 1, jobs: [third] } }, { GITHUB_RUN_ATTEMPT: '3' });
  assert.equal(result.proof, 'transport-only');
  assert.deepEqual(calls, [base, page(), page(1, 2), page(2)]);
  assert.equal(result.prior[0].jobs.length, 101);
  assert.deepEqual(result.prior[0].jobs[100], { job_id: 101, name: second.name, status: second.status, conclusion: second.conclusion, steps: second.steps });
  assert.equal(result.prior[1].jobs[0].conclusion, null);
  assert.equal(Object.hasOwn(result, 'eligible'), false);
});

test('empty but complete prior listing is transport evidence only, not no-upload evidence', () => {
  const { result } = read({ ...responses(), [page()]: { total_count: 0, jobs: [] } });
  assert.deepEqual(result.prior, [{ attempt: 1, jobs: [] }]);
  assert.equal(result.proof, 'transport-only');
});

test('optional steps omitted by jobs list are read from job detail, not assumed empty', () => {
  const listed = job(); delete listed.steps;
  const data = { ...responses(), [page()]: { total_count: 1, jobs: [listed] }, '/repos/owner/app/actions/jobs/44': job() };
  const { result, calls } = read(data);
  assert.deepEqual(calls, [base, page(), '/repos/owner/app/actions/jobs/44']);
  assert.deepEqual(result.prior[0].jobs[0].steps, job().steps);
  for (const detail of [undefined, { ...job(), id: 45 }, { ...job(), run_id: 456 }, { ...job(), run_attempt: 2 }, { ...job(), name: 'other' }, { ...job(), steps: undefined }, { ...job(), steps: null }]) {
    assert.throws(() => read({ ...data, '/repos/owner/app/actions/jobs/44': detail }), /steps are incomplete/);
  }
  assert.throws(() => read({ ...data, '/repos/owner/app/actions/jobs/44': new Error('denied detail') }), /denied detail/);
});

test('missing token and malformed identity stop before any provider read', () => {
  for (const changes of [{ GH_TOKEN: '' }, { GITHUB_REPOSITORY: '/app' }, { GITHUB_RUN_ID: '0' }, { GITHUB_RUN_ID: '123/other' }, ...['1', '02', '2.0', '1001', 'NaN'].map(GITHUB_RUN_ATTEMPT => ({ GITHUB_RUN_ATTEMPT }))]) {
    assert.throws(() => readHistory({ env: { ...env, ...changes }, request: () => assert.fail('must not read') }), /ephemeral job token|identity is invalid/);
  }
});

test('wrong repository, run and current attempt cannot establish read proof', () => {
  for (const changed of [null, {}, { ...run, id: 456 }, { ...run, repository: { full_name: 'other/app' } }, { ...run, run_attempt: 1 }]) {
    assert.throws(() => read({ ...responses(), [base]: changed }), /identity is ambiguous/);
  }
});

test('missing, malformed, duplicate, oversized and truncated job lists fail closed', () => {
  const duplicate = job();
  const invalid = [null, {}, { total_count: -1, jobs: [job()] }, { total_count: 1.5, jobs: [job()] }, { total_count: '1', jobs: [job()] }, { total_count: 1, jobs: null }, { total_count: 1, jobs: [] }, { total_count: 2, jobs: [job()] }, { total_count: 1, jobs: [job(), job(45)] }, { total_count: 2, jobs: [duplicate, duplicate] }, { total_count: 101, jobs: Array.from({ length: 101 }, (_, i) => job(i + 1)) }];
  for (const listing of invalid) assert.throws(() => read({ ...responses(), [page()]: listing }), /incomplete|ambiguous/);
  for (const change of [{ id: -1 }, { id: '44' }, { run_id: 456 }, { run_attempt: 2 }, { name: null }, { status: null }, { conclusion: undefined }]) {
    assert.throws(() => read({ ...responses(), [page()]: { total_count: 1, jobs: [{ ...job(), ...change }] } }), /identity is ambiguous/);
  }
});

test('unreadable, missing, repeated, changing-total and incomplete later pages fail closed', () => {
  const first = Array.from({ length: 100 }, (_, i) => job(i + 1));
  for (const last of [new Error('denied page'), undefined, { total_count: 101, jobs: [] }, { total_count: 102, jobs: [job(101)] }, { total_count: 101, jobs: [first[0]] }]) {
    assert.throws(() => read({ [base]: run, [page()]: { total_count: 101, jobs: first }, [page(1, 2)]: last }), /denied page|incomplete|ambiguous/);
  }
  assert.throws(() => read({ [base]: { ...run, run_attempt: 3 }, [page()]: { total_count: 1, jobs: [job()] }, [page(2)]: { total_count: 1, jobs: [job()] } }, { GITHUB_RUN_ATTEMPT: '3' }), /identity is ambiguous/);
});

test('malformed or duplicate step records fail read completeness, not eligibility', () => {
  for (const steps of [null, {}, [null], [{ ...job().steps[0], number: 0 }], [{ ...job().steps[0], name: null }], [{ ...job().steps[0], status: undefined }], [{ ...job().steps[0], conclusion: undefined }], [job().steps[0], job().steps[0]]]) {
    assert.throws(() => read({ ...responses(), [page()]: { total_count: 1, jobs: [{ ...job(), steps }] } }), /steps are incomplete|step listing is incomplete/);
  }
});
