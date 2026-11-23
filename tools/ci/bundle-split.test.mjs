// MOBI-15: an app with an iPad development build and a TestFlight build must give them different bundle ids. The rule,
// its dated allowlist for the apps that have not migrated yet (MOBI-16), and the direction (the device bundle takes the
// suffix; store_bundle keeps the App Store Connect id).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { checkBundleSplit } from './commands/gate.mjs';
import { bundleSplitOf, loadPolicy, parsePolicy, policyFile } from './lib/policy.mjs';

const source = readFileSync(policyFile, 'utf8');
const { policy } = loadPolicy();
const GIB = 'delorenj/green-in-between';
const TOWER = 'delorenj/tower-of-lost-things';
const GRUVATO = 'delorenj/gruvato';
const NAVI = 'AutomaticAI-io/navi';
const storeManifest = { ios: { store: {} } };
const edit = change => { const copy = JSON.parse(source); change(copy); return JSON.stringify(copy); };
const run = (p, repo, manifest, logs = []) => ({ verdict: checkBundleSplit({ policy: p, repo, app: p.apps[repo], manifest, log: line => logs.push(line) }), logs });

test('the real policy lists Tower, Gruvato and Navi, dated 2026-11-18 with a reason, and nobody else', () => {
  assert.deepEqual(Object.keys(policy.shared_bundle_allowlist).sort(), [NAVI, GRUVATO, TOWER].sort());
  for (const entry of Object.values(policy.shared_bundle_allowlist)) {
    assert.equal(entry.since, '2026-11-18');
    assert.match(entry.reason, /\S/);
  }
});

test('no allowlist entry is stale: an app that already has a separate store bundle is not on the list', () => {
  for (const repo of Object.keys(policy.shared_bundle_allowlist)) {
    assert.equal(bundleSplitOf(policy, repo, policy.apps[repo], storeManifest).status, 'allowlisted', `${repo} still shares its bundle id; remove its entry when it migrates`);
  }
});

test('Green In Between passes, quietly: its store bundle differs from its device bundle', () => {
  const { verdict, logs } = run(policy, GIB, storeManifest);
  assert.equal(verdict.status, 'split');
  assert.deepEqual(logs, []);
  assert.ok(policy.apps[GIB].ios.bundle.startsWith(`${policy.apps[GIB].ios.store_bundle}.`), 'the device bundle is the store bundle plus a suffix');
});

test('an app with a shared id that is not allowlisted is refused, by its manifest store lane or by its testflight block', () => {
  const p = structuredClone(policy);
  delete p.shared_bundle_allowlist[GRUVATO];
  assert.throws(() => run(p, GRUVATO, storeManifest), /HUB_GATE_REFUSED bundle split: delorenj\/gruvato .*sh\.delo\.gruvato/);
  // No ios.store in the manifest and no testflight block: no store lane, nothing to refuse.
  assert.equal(run(p, GRUVATO, { ios: {} }).verdict.status, 'no-store-lane');
  // The policy's testflight block alone is a store lane.
  delete p.shared_bundle_allowlist[NAVI];
  assert.throws(() => run(p, NAVI, { ios: {} }), /HUB_GATE_REFUSED bundle split: AutomaticAI-io\/navi/);
  // An explicit store_bundle equal to the device bundle is still one id.
  const same = structuredClone(policy);
  delete same.shared_bundle_allowlist[TOWER];
  same.apps[TOWER].ios.store_bundle = same.apps[TOWER].ios.bundle;
  assert.throws(() => run(same, TOWER, storeManifest), /HUB_GATE_REFUSED bundle split/);
});

test('Tower, Gruvato and Navi are allowlisted: one HUB_POLICY warning each and the gate goes on', () => {
  for (const repo of [TOWER, GRUVATO, NAVI]) {
    const { verdict, logs } = run(policy, repo, storeManifest);
    assert.equal(verdict.status, 'allowlisted');
    assert.equal(logs.length, 1, repo);
    assert.match(logs[0], new RegExp(`^::warning::HUB_POLICY shared_bundle ${repo.replace('/', '\\/')} uses ${policy.apps[repo].ios.bundle.replaceAll('.', '\\.')} .*allowlisted 2026-11-18`));
  }
});

test('an allowlisted app that already has its own store bundle warns that it can leave the list, and is not refused', () => {
  const p = structuredClone(policy);
  p.apps[TOWER].ios.store_bundle = 'io.lasertoast.tolt.store-id';
  const { verdict, logs } = run(p, TOWER, storeManifest);
  assert.equal(verdict.status, 'stale-allowlist');
  assert.equal(logs.length, 1);
  assert.match(logs[0], /^::warning::HUB_POLICY shared_bundle delorenj\/tower-of-lost-things already has a separate store bundle .* can be removed$/);
});

test('the parser refuses a testflight app on a shared id unless it is allowlisted, so a policy edit cannot add one', () => {
  assert.doesNotThrow(() => parsePolicy(source));
  assert.throws(() => parsePolicy(edit(p => { delete p.shared_bundle_allowlist[NAVI]; })), /apps\.AutomaticAI-io\/navi ships to TestFlight .* shared_bundle_allowlist/);
  assert.doesNotThrow(() => parsePolicy(edit(p => { delete p.shared_bundle_allowlist[NAVI]; p.apps[NAVI].ios.store_bundle = 'io.automaticai.ipm'; })));
  // Green In Between carries a testflight block with its split bundle, no allowlist needed.
  assert.doesNotThrow(() => parsePolicy(edit(p => { p.apps[GIB].testflight = { groups: ['Owner Testing'] }; })));
  // A policy with no allowlist key at all means an empty one.
  assert.deepEqual(parsePolicy(edit(p => { delete p.shared_bundle_allowlist; p.apps[NAVI].ios.store_bundle = 'io.automaticai.ipm'; })).shared_bundle_allowlist, {});
});

test('direction: the device bundle takes the suffix, so a store bundle that is the device bundle plus a suffix is refused', () => {
  assert.throws(() => parsePolicy(edit(p => { p.apps[TOWER].ios.store_bundle = `${p.apps[TOWER].ios.bundle}.store`; })), /device bundle takes the suffix/);
  // Anything else that differs is accepted: only the one reversed shape is checkable without knowing Apple's record.
  assert.doesNotThrow(() => parsePolicy(edit(p => { p.apps[TOWER].ios.store_bundle = 'io.automaticai.tower'; })));
  assert.doesNotThrow(() => parsePolicy(edit(p => { p.apps[TOWER].ios.bundle = `${p.apps[TOWER].ios.bundle}.dev`; p.apps[TOWER].ios.store_bundle = 'io.lasertoast.tolt'; })));
});

test('the allowlist is parsed strictly: iOS apps from the policy only, a real date, a one-line reason, nothing else', () => {
  const bad = {
    'a repository not in apps': p => { p.shared_bundle_allowlist['delorenj/nope'] = { since: '2026-11-18', reason: 'x' }; },
    'an Android-only app': p => { p.shared_bundle_allowlist['delorenj/earshot'] = { since: '2026-11-18', reason: 'x' }; },
    'not an object': p => { p.shared_bundle_allowlist = []; },
    'an entry that is text': p => { p.shared_bundle_allowlist[TOWER] = 'later'; },
    'no date': p => { delete p.shared_bundle_allowlist[TOWER].since; },
    'no reason': p => { delete p.shared_bundle_allowlist[TOWER].reason; },
    'a date in words': p => { p.shared_bundle_allowlist[TOWER].since = 'yesterday'; },
    'a date that is not on the calendar': p => { p.shared_bundle_allowlist[TOWER].since = '2026-02-30'; },
    'an empty reason': p => { p.shared_bundle_allowlist[TOWER].reason = '  '; },
    'a reason over two lines': p => { p.shared_bundle_allowlist[TOWER].reason = 'a\nb'; },
    'an unknown key': p => { p.shared_bundle_allowlist[TOWER].until = '2027-01-01'; },
  };
  for (const [name, change] of Object.entries(bad)) assert.throws(() => parsePolicy(edit(change)), /policy\.json: /, name);
});
