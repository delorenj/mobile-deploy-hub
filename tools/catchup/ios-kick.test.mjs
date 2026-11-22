// The iPad catch-up's clock glue (.candybars/mobile-deploy-hub-ios-catchup/kick.mjs): what it makes of `launchctl
// print` and of ssh trouble. The ssh and kickstart path itself is proven by the first scheduled fire.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectionError } from '../ci/lib/handoff.mjs';
import { parseJob, verdict } from '../../.candybars/mobile-deploy-hub-ios-catchup/kick.mjs';

const hubRoot = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const print = ({ state = 'not running', runs = 12, exit = '0', signal = '' } = {}) => `gui/502/sh.delo.mobile-deploy-hub.catchup = {
\tactive count = 0
\tstate = ${state}

\tdomain = gui/502 [100015]
\truns = ${runs}
\tlast exit code = ${exit}
${signal ? `\tlast terminating signal = ${signal}\n` : ''}
\tresource coalition = {
\t\tID = 83674
\t\tstate = active
\t}
}
`;

test('parseJob reads the job state, not a coalition\'s', () => {
  assert.deepEqual(parseJob(print()), { state: 'not running', running: false, runs: 12, lastExit: 0, signal: null });
  assert.equal(parseJob(print({ state: 'running' })).running, true);
  assert.equal(parseJob(print({ exit: '(never exited)' })).lastExit, null);
  assert.equal(parseJob(print({ signal: 'Killed: 9' })).signal, 'Killed: 9');
});

test('verdict: waits while running, passes on a new run with exit 0, fails on a nonzero exit or a signal', () => {
  const before = parseJob(print({ runs: 12 }));
  assert.equal(verdict(before, parseJob(print({ state: 'running', runs: 13 }))).kind, 'wait');
  assert.equal(verdict(before, parseJob(print({ runs: 13 }))).kind, 'pass');
  assert.equal(verdict(before, parseJob(print({ runs: 13, exit: '1' }))).kind, 'fail');
  assert.match(verdict(before, parseJob(print({ runs: 13, exit: '0', signal: 'Terminated: 15' }))).message, /Terminated: 15/);
});

test('verdict: a kickstart that starts nothing is waited on for the grace, then fails; it never reuses the old exit code', () => {
  const before = parseJob(print({ runs: 12 }));
  const same = parseJob(print({ runs: 12 }));
  assert.equal(verdict(before, same, { elapsedMs: 5_000, graceMs: 60_000 }).kind, 'wait');
  assert.equal(verdict(before, same, { elapsedMs: 61_000, graceMs: 60_000 }).kind, 'fail');
});

test('ssh trouble that is the Mac being away is a connection error; a real remote failure is not', () => {
  assert.equal(connectionError(new Error('ssh hub-mac exit 255: Connection timed out during banner exchange')), true);
  assert.equal(connectionError(new Error('ssh hub-mac: spawnSync ssh ETIMEDOUT (timed out)')), true);
  assert.equal(connectionError(new Error('launchctl kickstart exit 113: Could not find service')), false);
});

test('the candybar manifest: every 5 minutes (policy catch_up.ios_every_s), exec of the desk script, created paused', () => {
  const toml = readFileSync(join(hubRoot, '.candybars/mobile-deploy-hub-ios-catchup.candybar.toml'), 'utf8');
  const policy = JSON.parse(readFileSync(join(hubRoot, 'tools/ci/policy.json'), 'utf8'));
  assert.equal(policy.catch_up.ios_every_s, 300);
  assert.match(toml, /^schedule = "\*\/5 \* \* \* \*"$/m);
  assert.match(toml, /^kind = "exec"$/m);
  assert.match(toml, /\.candybars\/mobile-deploy-hub-ios-catchup\/kick\.mjs/);
});
