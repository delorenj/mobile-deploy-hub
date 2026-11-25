// Story 6.6: the pure register planner. No store, no clock, no I/O.
import test from 'node:test';
import assert from 'node:assert/strict';
import { HOST_PLATFORMS } from '../device/claims.mjs';
import { checkRegisterBody, planRegister } from './changes.mjs';

const hosts = HOST_PLATFORMS;
const BODY = { kind: 'phone', name: 'pixel', host: 'linux', identity: { serial: 'PX9', model: 'Pixel 9' }, capabilities: { api_level: 35 }, holder: 'jarad' };
const NOW = () => Date.parse('2026-11-25T10:00:00Z');
const rec = (id, more = {}) => ({ id, lock: id, name: id, words: [], kind: 'phone', host: 'linux', identity: null, capabilities: {}, ...more });
const failsWith = (fn, fields) => assert.throws(fn, error => Object.entries(fields).every(([key, value]) => error[key] === value));
const check = body => checkRegisterBody(body, { hosts });
const plan = (resources, more = {}) => planRegister({ resources }, check({ ...BODY, ...more }), { now: NOW });

test('a good body is normalised: actor from holder, capabilities and identity copied, if_rev and why kept', () => {
  const input = check({ ...BODY, if_rev: 0, why: 'desk' });
  assert.deepEqual(input, { kind: 'phone', name: 'pixel', host: 'linux', identity: { serial: 'PX9', model: 'Pixel 9' }, capabilities: { api_level: 35 }, if_rev: 0, actor: { holder: 'jarad', via: 'api' }, why: 'desk' });
  assert.notEqual(input.identity, BODY.identity);
  assert.notEqual(input.capabilities, BODY.capabilities);
  const minimal = check({ kind: 'ios-lane', name: 'ipad-two', host: 'mac', actor: { holder: 'a', via: 'cli' } });
  assert.deepEqual(minimal, { kind: 'ios-lane', name: 'ipad-two', host: 'mac', identity: null, capabilities: {}, if_rev: undefined, actor: { holder: 'a', via: 'cli' }, why: undefined });
});

test('every refusal of the body carries its code, status and reason', () => {
  const usage = (body, reason) => failsWith(() => check(body), { code: 'HUB_USAGE', status: 400, reason });
  usage(null, 'bad-body');
  usage({ ...BODY, extra: 1 }, 'bad-body');
  usage({ ...BODY, kind: 'tablet' }, 'bad-kind');
  usage({ ...BODY, host: 'toString' }, 'bad-host');
  usage({ ...BODY, host: 'linux', kind: 'ios-lane' }, 'bad-host');
  usage({ ...BODY, identity: { serial: 'x' } }, 'no-model');
  usage({ ...BODY, identity: { model: 'x', serial: 1 } }, 'bad-identity');
  usage({ ...BODY, capabilities: { deploy_target: true } }, 'bad-capabilities');
  usage({ ...BODY, if_rev: 0.5 }, 'bad-if-rev');
  usage({ ...BODY, why: {} }, 'bad-why');
  usage({ ...BODY, actor: { holder: 'x' } }, 'bad-actor');
  usage({ ...BODY, holder: undefined }, 'no-holder');
  failsWith(() => check({ ...BODY, name: 'Pixel' }), { code: 'HUB_REGISTRY_NAME', status: 400, reason: 'not-slug' });
  failsWith(() => check({ ...BODY, name: 'a'.repeat(29) }), { code: 'HUB_REGISTRY_NAME', status: 400, reason: 'too-long' });
  assert.equal(check({ ...BODY, name: 'a'.repeat(28) }).name.length, 28);
});

test('the record has the fixed shape, appended last, and current is not mutated', () => {
  const current = [rec('a'), rec('b')];
  const snapshot = structuredClone(current);
  const { record, resources } = plan(current);
  assert.deepEqual(record, { id: 'res-pixel', lock: 'res-pixel', name: 'pixel', words: [], display_name: 'pixel', kind: 'phone', host: 'linux', identity: { serial: 'PX9', model: 'Pixel 9' }, capabilities: { api_level: 35 }, deploy_target: false, seeded: false, created_at: '2026-11-25T10:00:00.000Z' });
  assert.deepEqual(resources.map(entry => entry.id), ['a', 'b', 'res-pixel']);
  assert.equal(resources.at(-1), record);
  assert.deepEqual(current, snapshot);
  assert.equal(plan([], { kind: 'ios-lane', host: 'mac', identity: undefined }).record.identity, null);
});

test('minting: res-<name>, then the smallest free -n from 2, counting retired holders of an id or a lock', () => {
  assert.equal(plan([]).record.id, 'res-pixel');
  assert.equal(plan([rec('res-pixel', { name: 'x' })]).record.id, 'res-pixel-2');
  assert.equal(plan([rec('res-pixel', { name: 'x' }), rec('res-pixel-2', { name: 'y' })]).record.id, 'res-pixel-3');
  assert.equal(plan([rec('res-pixel', { name: 'x', retired_at: 't' }), rec('res-pixel-3', { name: 'z' })]).record.id, 'res-pixel-2');
  // A lock alone holds the string.
  assert.equal(plan([rec('other', { lock: 'res-pixel', name: 'o' })]).record.id, 'res-pixel-2');
  const all = [rec('res-pixel', { name: 'x' }), ...Array.from({ length: 998 }, (_, index) => rec(`res-pixel-${index + 2}`, { name: `n${index}` }))];
  failsWith(() => plan(all), { code: 'HUB_REGISTRY_NAME', status: 409, reason: 'exhausted' });
  // The longest name still mints a lock that is a registry lock (res- plus a slug of at most 32).
  const long = plan([rec(`res-${'a'.repeat(28)}`, { name: 'x' })], { name: 'a'.repeat(28) });
  assert.equal(long.record.id, `res-${'a'.repeat(28)}-2`);
});

test('names: reserved words are refused, then any record\'s name, id, lock or word, retired and seed-missing included', () => {
  for (const name of ['phone', 's24', 'ios-lane', 'res-x', 'emulator-4', 'adb']) failsWith(() => plan([], { name }), { code: 'HUB_REGISTRY_NAME', status: 409, reason: 'reserved' });
  failsWith(() => plan([rec('a', { name: 'pixel' })]), { reason: 'taken', status: 409 });
  failsWith(() => plan([rec('a', { name: 'x', retired_at: 't' }), rec('pixel', { name: 'p' })]), { reason: 'taken' });
  failsWith(() => plan([rec('a', { name: 'x', lock: 'pixel' })]), { reason: 'taken' });
  failsWith(() => plan([rec('a', { name: 'x', words: ['pixel'] })]), { reason: 'taken' });
  failsWith(() => plan([rec('a', { name: 'pixel', retired_at: 't' })]), { reason: 'taken' });
  failsWith(() => plan([rec('a', { name: 'pixel', seed_missing: true })]), { reason: 'taken' });
});

test('duplicate identity: a live record\'s serial or udid is refused with its id; retired and seed-missing do not hold one', () => {
  const held = rec('s24', { identity: { serial: 'PX9', model: 'm' } });
  const error = (() => { try { plan([held]); } catch (e) { return e; } return null; })();
  assert.deepEqual([error.code, error.status, error.reason, error.holder], ['HUB_REGISTRY_DUPLICATE', 409, 'serial', 's24']);
  assert.equal(error.message.includes('PX9'), false);
  failsWith(() => plan([rec('lane', { identity: { udid: 'U1' } })], { kind: 'ios-lane', host: 'mac', identity: { udid: 'U1' } }), { reason: 'udid', holder: 'lane' });
  assert.equal(plan([{ ...held, retired_at: 't' }]).record.id, 'res-pixel');
  assert.equal(plan([{ ...held, seed_missing: true }]).record.id, 'res-pixel');
  // The model is not an identity of one device; a null identity is nobody's.
  assert.equal(plan([rec('a', { identity: { model: 'Pixel 9' } }), rec('b')]).record.id, 'res-pixel');
});
