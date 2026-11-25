// Stories 6.6 and 6.7: the pure register, edit and retire planners. No store, no clock, no I/O.
import test from 'node:test';
import assert from 'node:assert/strict';
import { HOST_PLATFORMS } from '../device/claims.mjs';
import { IMMUTABLE_KEYS, checkEditBody, checkRegisterBody, checkRetireBody, nameTaken, planEdit, planRegister, planRetire } from './changes.mjs';

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

// ---- 6.7: edit and retire ----

const editBody = (more = {}) => ({ if_rev: 2, holder: 'jarad', ...more });
const checkEdit = more => checkEditBody(editBody(more));
const usageOf = (fn, reason) => failsWith(fn, { code: 'HUB_USAGE', status: 400, reason });
const runtime = (id, more = {}) => rec(id, { name: id.replace(/^res-/, ''), seeded: false, display_name: id.replace(/^res-/, ''), capabilities: { api_level: 35, dedicated_qa: true }, ...more });
const seeded = (id, more = {}) => rec(id, { seeded: true, ...more });
const edit = (resources, id, more) => planEdit({ resources }, id, checkEdit(more));
const RETIRED_AT = '2026-11-25T09:00:00.000Z';

test('checkEditBody: a good body is normalised, the immutable keys pass in IMMUTABLE_KEYS order', () => {
  assert.deepEqual(IMMUTABLE_KEYS, ['id', 'lock', 'kind', 'host', 'identity']);
  assert.deepEqual(checkEdit({ name: 'pixel-9', capabilities: { a: 1, b: null }, why: 'x' }), { name: 'pixel-9', capabilities: { a: 1, b: null }, immutable: [], if_rev: 2, actor: { holder: 'jarad', via: 'api' }, why: 'x' });
  const given = checkEditBody({ if_rev: 0, actor: { holder: 'a', via: 'cli' }, name: 'x', identity: { model: 'y' }, host: 'mac' });
  assert.deepEqual([given.immutable, given.actor, given.capabilities, given.why], [['host', 'identity'], { holder: 'a', via: 'cli' }, undefined, undefined]);
  const patch = { a: 1 };
  assert.notEqual(checkEdit({ capabilities: patch }).capabilities, patch);
});

test('checkEditBody: every refusal reason, in order (keys, if_rev, capabilities, why, actor, no-change, name shape)', () => {
  const bad = (body, reason) => usageOf(() => checkEditBody(body), reason);
  bad(null, 'bad-body');
  bad([], 'bad-body');
  bad(editBody({ name: 'x', color: 'blue' }), 'bad-body');
  bad({ holder: 'jarad', name: 'x' }, 'no-if-rev');
  bad(editBody({ name: 'x', if_rev: '2' }), 'bad-if-rev');
  bad(editBody({ name: 'x', if_rev: -1 }), 'bad-if-rev');
  bad(editBody({ capabilities: { 'Bad-Key': 1 } }), 'bad-capabilities');
  bad(editBody({ capabilities: { allowed_users: null } }), 'bad-capabilities');
  bad(editBody({ capabilities: { model: 'x' } }), 'bad-capabilities');
  bad(editBody({ capabilities: { a: { b: 1 } } }), 'bad-capabilities');
  bad(editBody({ capabilities: [] }), 'bad-capabilities');
  bad(editBody({ capabilities: { a: Infinity } }), 'bad-capabilities');
  bad(editBody({ name: 'x', why: 3 }), 'bad-why');
  bad(editBody({ name: 'x', actor: { holder: 'x' } }), 'bad-actor');
  bad(editBody({ name: 'x', holder: undefined }), 'no-holder');
  bad(editBody({}), 'no-change');
  // The body checks run before the name shape.
  bad(editBody({ name: 'Bad Name', holder: undefined }), 'no-holder');
  bad({ name: 'Bad Name', holder: 'jarad' }, 'no-if-rev');
  failsWith(() => checkEdit({ name: 'Bad Name' }), { code: 'HUB_REGISTRY_NAME', status: 400, reason: 'not-slug' });
  failsWith(() => checkEdit({ name: 'a'.repeat(29) }), { code: 'HUB_REGISTRY_NAME', status: 400, reason: 'too-long' });
  failsWith(() => checkEdit({ name: null }), { code: 'HUB_REGISTRY_NAME', status: 400, reason: 'not-slug' });
  assert.equal(checkEdit({ name: 'a'.repeat(28) }).name.length, 28);
  // An empty patch is a change request that changes nothing; an immutable key alone is a body the plan refuses.
  assert.deepEqual(checkEdit({ capabilities: {} }).capabilities, {});
  assert.deepEqual(checkEdit({ lock: 'x' }).immutable, ['lock']);
});

test('planEdit: a rename changes name and display_name, never id or lock, and appends nothing', () => {
  const current = [rec('a'), runtime('res-pixel'), rec('b')];
  const snapshot = structuredClone(current);
  const { record, resources } = planEdit({ resources: current }, 'res-pixel', checkEdit({ name: 'pixel-9' }));
  assert.deepEqual([record.id, record.lock, record.name, record.display_name], ['res-pixel', 'res-pixel', 'pixel-9', 'pixel-9']);
  assert.deepEqual(resources.map(entry => entry.id), ['a', 'res-pixel', 'b']);
  assert.equal(resources[1], record);
  assert.equal(resources[0], current[0], 'other records are the same objects');
  assert.deepEqual(current, snapshot, 'current is not mutated');
});

test('planEdit: capabilities are a merge patch: set, remove with null, keep the rest (dedicated_qa included)', () => {
  const current = [runtime('res-pixel', { capabilities: { api_level: 35, old: 'x', dedicated_qa: true } })];
  const snapshot = structuredClone(current);
  const { record } = planEdit({ resources: current }, 'res-pixel', checkEdit({ capabilities: { api_level: 36, old: null, fresh: true, absent: null } }));
  assert.deepEqual(record.capabilities, { api_level: 36, dedicated_qa: true, fresh: true });
  assert.deepEqual(current, snapshot);
  // dedicated_qa can be cleared only by naming it.
  assert.deepEqual(planEdit({ resources: current }, 'res-pixel', checkEdit({ capabilities: { dedicated_qa: null } })).record.capabilities, { api_level: 35, old: 'x' });
});

test('planEdit: an edit that changes nothing says so, and returns equal records', () => {
  const current = [runtime('res-pixel')];
  for (const more of [{ name: 'pixel' }, { capabilities: {} }, { capabilities: { api_level: 35 } }, { capabilities: { gone: null } }, { name: 'pixel', capabilities: { dedicated_qa: true } }]) {
    const plan = planEdit({ resources: current }, 'res-pixel', checkEdit(more));
    assert.deepEqual(plan.record, current[0], JSON.stringify(more));
    assert.deepEqual(plan.resources, current, JSON.stringify(more));
  }
});

test('planEdit: the refusals, in order: unknown, retired, seeded, immutable, name rules', () => {
  const live = runtime('res-pixel');
  failsWith(() => edit([live], 'res-nope', { name: 'x' }), { code: 'HUB_RESOURCE_NOT_FOUND', status: 404, reason: 'unknown' });
  // Retired and seed-missing win over everything after them (an immutable key, a seeded name).
  failsWith(() => edit([runtime('res-pixel', { retired_at: RETIRED_AT })], 'res-pixel', { name: 'x', host: 'mac' }), { code: 'HUB_RESOURCE_RETIRED', status: 409, reason: 'retired', resource: 'res-pixel' });
  failsWith(() => edit([seeded('s24', { seed_missing: true })], 's24', { identity: { model: 'x' } }), { code: 'HUB_RESOURCE_RETIRED', status: 409, reason: 'seed-missing' });
  failsWith(() => edit([seeded('s24', { seed_missing: true, retired_at: RETIRED_AT })], 's24', { name: 'x' }), { code: 'HUB_RESOURCE_RETIRED', reason: 'retired' });
  // Seeded: an immutable key (the first, in IMMUTABLE_KEYS order), then a different name; capabilities stay editable.
  failsWith(() => edit([seeded('s24')], 's24', { identity: { model: 'x' }, name: 'y' }), { code: 'HUB_REGISTRY_SEEDED', status: 409, reason: 'identity' });
  failsWith(() => edit([seeded('s24')], 's24', { identity: {}, id: 's25' }), { code: 'HUB_REGISTRY_SEEDED', reason: 'id' });
  failsWith(() => edit([seeded('s24')], 's24', { name: 'x' }), { code: 'HUB_REGISTRY_SEEDED', status: 409, reason: 'name' });
  const kept = edit([seeded('s24')], 's24', { name: 's24', capabilities: { lab: 'a' } });
  assert.deepEqual([kept.record.capabilities.lab, kept.record.name], ['a', 's24']);
  // Runtime: an immutable key, by presence, even when it echoes the stored value.
  failsWith(() => edit([live], 'res-pixel', { host: 'linux', name: 'phone' }), { code: 'HUB_USAGE', status: 400, reason: 'immutable' });
  failsWith(() => edit([live], 'res-pixel', { identity: null, name: 'x' }), { code: 'HUB_USAGE', reason: 'immutable' });
  // Name rules.
  for (const name of ['phone', 's24', 'res-x']) failsWith(() => edit([live], 'res-pixel', { name }), { code: 'HUB_REGISTRY_NAME', status: 409, reason: 'reserved' });
  failsWith(() => edit([live, rec('other', { name: 'taken-one' })], 'res-pixel', { name: 'taken-one' }), { reason: 'taken', status: 409 });
  failsWith(() => edit([live, rec('other', { name: 'x', retired_at: RETIRED_AT })], 'res-pixel', { name: 'other' }), { reason: 'taken' });
  failsWith(() => edit([live, rec('o', { name: 'x', lock: 'lk' })], 'res-pixel', { name: 'lk' }), { reason: 'taken' });
  failsWith(() => edit([live, rec('o', { name: 'x', words: ['w'] })], 'res-pixel', { name: 'w' }), { reason: 'taken' });
  failsWith(() => edit([live, rec('o', { name: 'p', seed_missing: true })], 'res-pixel', { name: 'p' }), { reason: 'taken' });
});

test('nameTaken: any record\'s name, id, lock or word, except the excepted id', () => {
  const list = [rec('a', { name: 'n', lock: 'l', words: ['w'] })];
  for (const word of ['n', 'a', 'l', 'w']) assert.equal(nameTaken(word, list), true, word);
  for (const word of ['n', 'a', 'l', 'w']) assert.equal(nameTaken(word, list, 'a'), false, word);
  assert.equal(nameTaken('z', list), false);
});

test('rename uniqueness: a record\'s own old words and id do not clash with it, another record\'s do', () => {
  const own = runtime('res-pixel', { words: ['my-word'] });
  assert.equal(edit([own], 'res-pixel', { name: 'my-word' }).record.name, 'my-word');
  failsWith(() => edit([own, rec('o', { name: 'o' })], 'res-pixel', { name: 'o' }), { reason: 'taken' });
});

test('checkRetireBody: only if_rev, actor, holder and why; the same actor rule', () => {
  assert.deepEqual(checkRetireBody({ holder: 'jarad' }), { if_rev: undefined, actor: { holder: 'jarad', via: 'api' }, why: undefined });
  assert.deepEqual(checkRetireBody({ if_rev: 0, actor: { holder: 'a', via: 'cli' }, why: 'gone' }), { if_rev: 0, actor: { holder: 'a', via: 'cli' }, why: 'gone' });
  const bad = (body, reason) => usageOf(() => checkRetireBody(body), reason);
  bad(undefined, 'bad-body');
  bad([], 'bad-body');
  bad({ holder: 'j', name: 'x' }, 'bad-body');
  bad({ holder: 'j', capabilities: {} }, 'bad-body');
  bad({ holder: 'j', if_rev: 1.5 }, 'bad-if-rev');
  bad({ holder: 'j', why: 1 }, 'bad-why');
  bad({ actor: { holder: 'j' } }, 'bad-actor');
  bad({}, 'no-holder');
});

test('planRetire: sets retired_at and nothing else; current is not mutated', () => {
  const current = [rec('a'), runtime('res-pixel'), rec('b')];
  const snapshot = structuredClone(current);
  const { record, resources } = planRetire({ resources: current }, 'res-pixel', {}, { now: NOW });
  assert.deepEqual(record, { ...snapshot[1], retired_at: '2026-11-25T10:00:00.000Z' });
  assert.equal(resources[1], record);
  assert.deepEqual(resources.map(entry => entry.id), ['a', 'res-pixel', 'b']);
  assert.deepEqual(current, snapshot);
});

test('planRetire: unknown is 404, seeded is HUB_REGISTRY_SEEDED retire, an already-retired record is a no-op with its stored time', () => {
  failsWith(() => planRetire({ resources: [] }, 'res-nope', {}, { now: NOW }), { code: 'HUB_RESOURCE_NOT_FOUND', status: 404, reason: 'unknown' });
  failsWith(() => planRetire({ resources: [seeded('s24')] }, 's24', {}, { now: NOW }), { code: 'HUB_REGISTRY_SEEDED', status: 409, reason: 'retire' });
  const retired = runtime('res-pixel', { retired_at: RETIRED_AT });
  const again = planRetire({ resources: [retired] }, 'res-pixel', {}, { now: NOW });
  assert.equal(again.record.retired_at, RETIRED_AT);
  assert.deepEqual(again.resources, [retired]);
  // Already retired wins over seeded: a seeded record with retired_at retires as a no-op with its stored time.
  const seededRetired = seeded('s24', { retired_at: RETIRED_AT });
  const noop = planRetire({ resources: [seededRetired] }, 's24', {}, { now: NOW });
  assert.equal(noop.record.retired_at, RETIRED_AT);
  assert.deepEqual(noop.resources, [seededRetired]);
  assert.equal(planRetire({ resources: [retired] }, 'res-pixel', {}).record.retired_at, RETIRED_AT, 'now is not read for a retired record');
});
