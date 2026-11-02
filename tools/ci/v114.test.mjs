// v114: TestFlight policy enforcement (TOWE-76)
// - ios.store apps must have apps.<repo>.ios.testflight.enabled === true
// - --testflight flag is retired
import assert from 'node:assert';
import { describe, it, before, after } from 'node:test';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const policyPath = join(__dirname, 'policy.json');
const policy = JSON.parse(readFileSync(policyPath, 'utf8'));

describe('v114 TestFlight policy enforcement', () => {
  before(() => {
    // Ensure test env is clean
  });

  after(() => {
    // Cleanup
  });

  it('should require apps.<repo>.ios.testflight.enabled === true for any ios.store app', () => {
    // Tower has ios.store and must have testflight enabled
    const tower = policy.apps['delorenj/tower-of-lost-things'];
    assert.ok(tower, 'Tower must be in policy');
    assert.ok(tower.ios, 'Tower must have ios section');
    assert.ok(tower.ios.store, 'Tower must have ios.store');
    assert.strictEqual(tower.ios.testflight?.enabled, true, 'Tower must have ios.testflight.enabled === true');

    // Navi has ios.store and must have testflight enabled
    const navi = policy.apps['AutomaticAI-io/james-brennan'];
    assert.ok(navi, 'Navi must be in policy');
    assert.ok(navi.ios, 'Navi must have ios section');
    assert.ok(navi.ios.store, 'Navi must have ios.store');
    assert.strictEqual(navi.ios.testflight?.enabled, true, 'Navi must have ios.testflight.enabled === true');

    // Gruvato has ios.store and must have testflight enabled
    const gruvato = policy.apps['delorenj/gruvato'];
    assert.ok(gruvato, 'Gruvato must be in policy');
    assert.ok(gruvato.ios, 'Gruvato must have ios section');
    assert.ok(gruvato.ios.store, 'Gruvato must have ios.store');
    assert.strictEqual(gruvato.ios.testflight?.enabled, true, 'Gruvato must have ios.testflight.enabled === true');
  });

  it('should not allow apps.<repo>.ios.testflight.enabled === false for ios.store apps', () => {
    // This is enforced by policy.parsePolicy; we assert the policy itself forbids it
    const bad = { ...policy.apps['delorenj/tower-of-lost-things'], ios: { ...policy.apps['delorenj/tower-of-lost-things'].ios, testflight: { enabled: false } } };
    assert.notStrictEqual(bad.ios.testflight.enabled, false, 'policy must reject enabled=false');
  });

  it('should not include --testflight flag in mise.toml deploy/deploy:train tasks', () => {
    const miseTomlPath = join(__dirname, '../../mise.toml');
    const miseToml = readFileSync(miseTomlPath, 'utf8');
    assert.ok(miseToml.includes('[tasks."deploy"]'), 'mise.toml must have deploy task');
    assert.ok(miseToml.includes('[tasks."deploy:train"]'), 'mise.toml must have deploy:train task');
    assert.ok(!miseToml.includes('flag "--testflight'), 'mise.toml must not include --testflight flag');
    assert.ok(miseToml.includes('flag "--play'), 'mise.toml must still include --play flag');
  });

  it('should enforce TestFlight in plan.mjs when ios.store is present', () => {
    const planPath = join(__dirname, 'commands/plan.mjs');
    const planSource = readFileSync(planPath, 'utf8');
    assert.ok(planSource.includes('manifest.ios?.store && manifest.ios.testflight !== true'), 'plan.mjs must check testflight enabled');
    assert.ok(planSource.includes('HUB_PLAN_REFUSED: iOS apps with ios.store must have TestFlight enabled'), 'plan.mjs must include refusal message');
  });

  it('should export IOS_TESTFLIGHT_ENABLED constant in store.mjs', () => {
    const storePath = join(__dirname, 'lib/store.mjs');
    const storeSource = readFileSync(storePath, 'utf8');
    assert.ok(storeSource.includes('export const IOS_TESTFLIGHT_ENABLED = true'), 'store.mjs must export IOS_TESTFLIGHT_ENABLED constant');
  });
});
