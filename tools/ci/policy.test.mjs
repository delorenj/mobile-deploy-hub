// The policy's completion block (hub v1.3, TOWE-76): the repo's own policy.json parses (a test that would have caught
// the broken TOWE-76 attempt, whose parser refused the live file), and every bad completion block is refused.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadPolicy, maxReruns, parsePolicy, policyFile, requiredTargets } from './lib/policy.mjs';

const source = readFileSync(policyFile, 'utf8');

test('loadPolicy parses the repo\'s own policy.json, completion block included', () => {
  const { policy, sha256, short } = loadPolicy();
  assert.match(sha256, /^[0-9a-f]{64}$/);
  assert.equal(short, sha256.slice(0, 8));
  assert.deepEqual(policy.completion, { required: { devices: 'lanes', testflight: 'store' }, lane_unavailable: 'refuse', reruns: 1 });
  // Every app keeps the shape the gate, deliver and the catch-up read: no per-app TestFlight switch anywhere.
  for (const [repo, app] of Object.entries(policy.apps)) {
    assert.ok(!('testflight' in app), `${repo} has no testflight key: TestFlight is the manifest's ios.store under the one rule`);
    if (app.ios) assert.deepEqual(Object.keys(app.ios).filter(key => !['bundle', 'store_bundle'].includes(key)), [], `${repo}.ios keeps bundle and store_bundle only`);
  }
  assert.equal(parsePolicy(source).completion.reruns, 1);
});

test('a bad completion block is refused, whatever it gets wrong', () => {
  const base = JSON.parse(source);
  const cases = {
    'no completion block': p => { delete p.completion; },
    'completion is not an object': p => { p.completion = 'refuse'; },
    'unknown completion key': p => { p.completion.pending_stale_h = 24; },
    'no required': p => { delete p.completion.required; },
    'required unknown key': p => { p.completion.required.play = 'store'; },
    'required without testflight': p => { delete p.completion.required.testflight; },
    'devices narrowed': p => { p.completion.required.devices = 'android'; },
    'testflight optional': p => { p.completion.required.testflight = 'optional'; },
    'testflight boolean': p => { p.completion.required.testflight = true; },
    'lane_unavailable ignore': p => { p.completion.lane_unavailable = 'ignore'; },
    'no lane_unavailable': p => { delete p.completion.lane_unavailable; },
    'reruns negative': p => { p.completion.reruns = -1; },
    'reruns fractional': p => { p.completion.reruns = 1.5; },
    'reruns as text': p => { p.completion.reruns = '1'; },
    'reruns over the cap': p => { p.completion.reruns = maxReruns + 1; },
    'a per-app testflight switch': p => { p.apps['delorenj/tower-of-lost-things'].ios.testflight = { enabled: true }; },
  };
  for (const [name, change] of Object.entries(cases)) {
    const copy = structuredClone(base);
    change(copy);
    assert.throws(() => parsePolicy(JSON.stringify(copy)), /policy\.json: /, name);
  }
  // The edges that are allowed: no automatic reruns, the v1.2 skip as a rollback, TestFlight never required.
  for (const change of [p => { p.completion.reruns = 0; }, p => { p.completion.reruns = maxReruns; }, p => { p.completion.lane_unavailable = 'skip'; }, p => { p.completion.required.testflight = 'never'; }]) {
    const copy = structuredClone(base);
    change(copy);
    assert.doesNotThrow(() => parsePolicy(JSON.stringify(copy)));
  }
});

test('required targets: every lane\'s device, and TestFlight for a store app with an iOS lane, by one rule', () => {
  const { policy } = loadPolicy();
  const tower = policy.apps['delorenj/tower-of-lost-things'];
  assert.deepEqual(requiredTargets(policy, tower, { store: true }), { android: true, ios: true, testflight: true });
  assert.deepEqual(requiredTargets(policy, tower, { store: false }), { android: true, ios: true, testflight: false }, 'no ios.store, no TestFlight');
  assert.deepEqual(requiredTargets(policy, policy.apps['delorenj/earshot'], { store: true }), { android: true, ios: false, testflight: false }, 'an Android-only app never owes TestFlight');
  const never = structuredClone(policy);
  never.completion.required.testflight = 'never';
  assert.equal(requiredTargets(never, tower, { store: true }).testflight, false);
});
