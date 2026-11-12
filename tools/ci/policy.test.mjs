// The deployed policy has no completion block. Validate the parser's compatible defaults and separately test the
// deferred stricter contract without enabling it in policy.json.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { defaultGroups, iosVersionOf, loadPolicy, maxReruns, parsePolicy, policyFile, requiredTargets, testflightPolicyOf } from './lib/policy.mjs';

const source = readFileSync(policyFile, 'utf8');

test('loadPolicy parses the repo policy with compatible completion defaults', () => {
  const { policy, sha256, short } = loadPolicy();
  assert.match(sha256, /^[0-9a-f]{64}$/);
  assert.equal(short, sha256.slice(0, 8));
  assert.deepEqual(policy.completion, { required: { devices: 'never', testflight: 'never' }, lane_unavailable: 'skip', reruns: 0 });
  // Every app keeps the shape the gate, deliver and the catch-up read: no per-app TestFlight switch anywhere. The optional
  // testflight block (JIMB-466) only says where a store build goes and how its iOS version moves; it has no `enabled`.
  for (const [repo, app] of Object.entries(policy.apps)) {
    assert.deepEqual(Object.keys(app.testflight ?? {}).filter(key => !['groups', 'train'].includes(key)), [], `${repo}.testflight has groups and train only: TestFlight is the manifest's ios.store under the one rule`);
    if (app.ios) assert.deepEqual(Object.keys(app.ios).filter(key => !['bundle', 'store_bundle'].includes(key)), [], `${repo}.ios keeps bundle and store_bundle only`);
  }
  assert.equal(parsePolicy(source).completion.reruns, 0);
});

test('a bad completion block is refused, whatever it gets wrong', () => {
  const base = JSON.parse(source);
  base.completion = { required: { devices: 'lanes', testflight: 'store' }, lane_unavailable: 'refuse', reruns: 1 };
  const cases = {
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

test('released v1.2.25 has no completion block; the parser defaults to skip, opt-in and no reruns', () => {
  assert.equal(Object.hasOwn(JSON.parse(source), 'completion'), false);
  const { policy } = loadPolicy();
  for (const app of Object.values(policy.apps)) {
    assert.deepEqual(requiredTargets(policy, app, { store: true }), { android: false, ios: false, testflight: false });
  }
  assert.equal(policy.completion.lane_unavailable, 'skip');
  assert.equal(policy.completion.reruns, 0);
});

test('required targets: every lane\'s device, and TestFlight for a store app with an iOS lane, by one rule', () => {
  const { policy: released } = loadPolicy();
  const policy = { ...released, completion: { required: { devices: 'lanes', testflight: 'store' }, lane_unavailable: 'refuse', reruns: 1 } };
  const tower = policy.apps['delorenj/tower-of-lost-things'];
  assert.deepEqual(requiredTargets(policy, tower, { store: true }), { android: true, ios: true, testflight: true });
  assert.deepEqual(requiredTargets(policy, tower, { store: false }), { android: true, ios: true, testflight: false }, 'no ios.store, no TestFlight');
  assert.deepEqual(requiredTargets(policy, policy.apps['delorenj/earshot'], { store: true }), { android: true, ios: false, testflight: false }, 'an Android-only app never owes TestFlight');
  const never = structuredClone(policy);
  never.completion.required.testflight = 'never';
  assert.equal(requiredTargets(never, tower, { store: true }).testflight, false);
});

// ---------------------------------------------------------------------------------------------------- JIMB-466

test('only Navi carries a testflight block; every other app keeps Owner Testing and the deploy\'s own version', () => {
  const { policy } = loadPolicy();
  for (const [repo, app] of Object.entries(policy.apps)) {
    const settings = testflightPolicyOf(app);
    if (repo === 'AutomaticAI-io/navi') assert.deepEqual(settings, { groups: ['Owner Testing'], train: 'minor' });
    else {
      assert.ok(!('testflight' in app), `${repo} has no block, so nothing about its TestFlight changed`);
      assert.deepEqual(settings, { groups: ['Owner Testing'], train: 'patch' }, repo);
      assert.equal(iosVersionOf(app, '1.2.3'), '1.2.3', `${repo} ships the deploy's version to iOS, as before`);
    }
  }
  assert.deepEqual(testflightPolicyOf(null), { groups: [...defaultGroups], train: 'patch' }, 'an unlisted repo or a local run gets the defaults');
  assert.throws(() => { defaultGroups.push('x'); }, TypeError, 'the default list is frozen');
  assert.deepEqual(testflightPolicyOf(undefined).groups, ['Owner Testing']);
  const copy = testflightPolicyOf(null).groups;
  copy.push('mutated');
  assert.deepEqual(testflightPolicyOf(null).groups, ['Owner Testing'], 'a caller cannot change the defaults through the list it got');
});

test('the iOS train: minor moves the marketing version only when a minor or major bump moves X or Y; build numbers are not the version', () => {
  const minor = { testflight: { train: 'minor' } };
  const patch = { testflight: { train: 'patch' } };
  assert.equal(iosVersionOf(minor, '0.3.0'), '0.3.0');
  for (const version of ['0.3.1', '0.3.7', '0.3.27']) assert.equal(iosVersionOf(minor, version), '0.3.0', `${version} stays on the 0.3.0 train`);
  assert.equal(iosVersionOf(minor, '0.4.0'), '0.4.0', 'a minor bump starts the next train');
  assert.equal(iosVersionOf(minor, '1.0.0'), '1.0.0', 'a major bump does too');
  assert.equal(iosVersionOf(minor, '1.2.9'), '1.2.0');
  assert.equal(iosVersionOf(patch, '0.3.7'), '0.3.7', 'the patch train is the deploy\'s version');
  assert.equal(iosVersionOf({}, '0.3.7'), '0.3.7');
  assert.equal(iosVersionOf(minor, '0.3.7', '0.9.1'), '0.9.1', 'an explicit HUB_IOS_VERSION wins over any train');
  assert.equal(iosVersionOf(patch, '0.3.7', '0.9.1'), '0.9.1');
  assert.throws(() => iosVersionOf(minor, 'x.y'), /cannot derive an iOS version/);
});

test('a testflight block is parsed strictly: groups are plain unique names, the train is patch or minor, nothing else', () => {
  const base = JSON.parse(source);
  const navi = p => p.apps['AutomaticAI-io/navi'];
  const good = [
    p => { navi(p).testflight = { groups: ['Owner Testing', 'Client Review'], train: 'minor' }; },
    p => { navi(p).testflight = { groups: ["IPM Test Group (internal)", 'Beta & Friends-2.0'] }; },
    p => { navi(p).testflight = { train: 'patch' }; },
    p => { navi(p).testflight = {}; },
    p => { p.apps['delorenj/gruvato'].testflight = { groups: ['Owner Testing', 'Public'] }; },
  ];
  for (const change of good) {
    const copy = structuredClone(base);
    change(copy);
    assert.doesNotThrow(() => parsePolicy(JSON.stringify(copy)));
  }
  const bad = {
    'not an object': p => { navi(p).testflight = 'Owner Testing'; },
    'an enable switch': p => { navi(p).testflight = { enabled: true }; },
    'review mode is not in the block yet': p => { navi(p).testflight = { review: 'submit' }; },
    'no groups listed': p => { navi(p).testflight = { groups: [] }; },
    'groups as text': p => { navi(p).testflight = { groups: 'Owner Testing' }; },
    'a comma in a name (the list is comma-separated)': p => { navi(p).testflight = { groups: ['Owner Testing, Client Review'] }; },
    'a newline in a name': p => { navi(p).testflight = { groups: ['Owner\nTesting'] }; },
    'a leading space': p => { navi(p).testflight = { groups: [' Owner Testing'] }; },
    'a trailing space': p => { navi(p).testflight = { groups: ['Owner Testing '] }; },
    'an empty name': p => { navi(p).testflight = { groups: [''] }; },
    'a number': p => { navi(p).testflight = { groups: [7] }; },
    'a name over 64 characters': p => { navi(p).testflight = { groups: ['a'.repeat(65)] }; },
    'the same group twice (case-insensitive)': p => { navi(p).testflight = { groups: ['Client Review', 'client review'] }; },
    'nine groups': p => { navi(p).testflight = { groups: Array.from({ length: 9 }, (_, i) => `Group ${i}`) }; },
    'train none': p => { navi(p).testflight = { train: 'none' }; },
    'train major': p => { navi(p).testflight = { train: 'major' }; },
    'on an Android-only app': p => { p.apps['delorenj/earshot'].testflight = { groups: ['Owner Testing'] }; },
  };
  for (const [name, change] of Object.entries(bad)) {
    const copy = structuredClone(base);
    change(copy);
    assert.throws(() => parsePolicy(JSON.stringify(copy)), /policy\.json: /, name);
  }
});
