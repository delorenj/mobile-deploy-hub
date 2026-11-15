import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { releaseCompletion, validateReleaseCompletion } from '../release.mjs';

const repo = 'delorenj/tower-of-lost-things';
const complete = () => ({ schema: 1, verdict: 'COMPLETE', repo, run: { id: '123' }, dry_run: true, bumped: false, required: ['S26', 'iPad', 'TestFlight'], targets: ['S26', 'iPad', 'TestFlight'].map(target => ({ target, status: 'checked' })), owed: [] });

test('release requires a COMPLETE artifact for the exact app and every required target', () => {
  assert.equal(validateReleaseCompletion(complete(), repo, 123).verdict, 'COMPLETE');
  assert.throws(() => validateReleaseCompletion(complete(), repo, 124), /completion-out/);
  for (const altered of [null, { ...complete(), verdict: 'INCOMPLETE' }, { ...complete(), repo: 'other/app' }, { ...complete(), dry_run: false }, { ...complete(), bumped: true }, { ...complete(), blocked: true }, { ...complete(), failure: { job: 'ios' } }, { ...complete(), targets: complete().targets.slice(0, 2) }, { ...complete(), owed: [{ target: 'iPad' }] }]) {
    assert.throws(() => validateReleaseCompletion(altered, repo), /completion-out|failure or blocked/);
  }
  assert.throws(() => validateReleaseCompletion({ ...complete(), required: ['TestFlight'], targets: [{ target: 'TestFlight', status: 'checked' }] }, repo), /policy-required/);
  const withoutStore = { ...complete(), required: ['S26', 'iPad'], targets: complete().targets.slice(0, 2) };
  assert.throws(() => validateReleaseCompletion(withoutStore, repo, 123), /policy-required/, 'a Tower COMPLETE artifact cannot omit TestFlight from both required and targets');
  assert.throws(() => validateReleaseCompletion({ ...withoutStore, repo: 'delorenj/green-in-between' }, 'delorenj/green-in-between'), /policy-required/, 'the rule applies to other iOS apps');
  const androidOnly = { ...withoutStore, repo: 'delorenj/earshot', required: ['S26'], targets: withoutStore.targets.slice(0, 1) };
  assert.equal(validateReleaseCompletion(androidOnly, 'delorenj/earshot').verdict, 'COMPLETE');
});

test('release reads completion-out from the watched run; missing or unreadable output is not green', () => {
  const gh = (args) => {
    assert.deepEqual(args.slice(0, 6), ['run', 'download', '123', '--repo', repo, '-n']);
    mkdirSync(args.at(-1), { recursive: true });
    writeFileSync(join(args.at(-1), 'completion.json'), JSON.stringify(complete()));
  };
  assert.equal(releaseCompletion(gh, repo, 123).verdict, 'COMPLETE');
  assert.throws(() => releaseCompletion(() => {}, repo, 123), /ENOENT/);
  assert.throws(() => releaseCompletion(args => writeFileSync(join(args.at(-1), 'completion.json'), '{'), repo, 123), /JSON/);
});
