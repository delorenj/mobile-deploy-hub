// Story 5.7: the matcher (match.mjs) over a synthetic registry. Pure: no lock dir, no adb, no QA file.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { canonical, match, parseQuery } from './match.mjs';
import { seed } from './seed.mjs';
import { loadDevices } from '../ci/lib/devices.mjs';
import { loadPolicy } from '../ci/lib/policy.mjs';

const policy = loadPolicy().policy;
const record = fields => ({ id: null, lock: null, name: null, words: [], display_name: null, kind: 'phone', host: 'linux', identity: { model: null }, capabilities: {}, deploy_target: false, seeded: true, ...fields });
const phone = (id, extra = {}) => record({ id, lock: id, name: id, ...extra });
const ids = result => result.members.map(member => member.id);
const query = text => ({ query: parseQuery(text) });
const refused = (action, code) => assert.throws(action, error => error.code === code);

// Two seeded phones (api 35 and 33), the iPad lane, an emulator pool.
const registry = (changes = {}) => ({
  resources: [
    phone('s24', { identity: { model: 'SM-S928U' }, capabilities: { api_level: 35, has_nfc: true, tier: 'flagship' }, ...changes.s24 }),
    phone('s26', { identity: { model: 'SM-S948U' }, capabilities: { api_level: 33 }, deploy_target: true, ...changes.s26 }),
    record({ id: 'ios-lane', lock: 'mac-ios', name: 'ios-lane', kind: 'ios-lane', host: 'mac', deploy_target: true }),
    record({ id: 'emulator', lock: 'emulator', name: 'emulator', kind: 'emulator-pool' }),
    ...(changes.extra ?? []),
  ],
  pools: { phone: { members: ['s24', 's26'], named: true }, emulator: { gate: 'emulator' } },
});

test('parseQuery reads the three operators and keeps the value as text', () => {
  assert.deepEqual(parseQuery('kind=phone,api_level>=34,api_level<=40.5'), [
    { key: 'kind', op: '=', value: 'phone' }, { key: 'api_level', op: '>=', value: '34' }, { key: 'api_level', op: '<=', value: '40.5' },
  ]);
  assert.deepEqual(parseQuery('model=SM-S928U'), [{ key: 'model', op: '=', value: 'SM-S928U' }]);
  assert.deepEqual(parseQuery('a=b=c'), [{ key: 'a', op: '=', value: 'b=c' }]);
  assert.equal(canonical(parseQuery('kind=phone,api_level>=34')), 'kind=phone,api_level>=34');
});

test('parseQuery refuses an empty query, an empty clause and a bad clause as HUB_USAGE naming it', () => {
  const bad = [
    ['', /needs a query/], ['kind=phone,', /empty clause/], [',kind=phone', /empty clause/], ['kind=phone,,x=1', /empty clause/],
    ['phone', /"phone"/], ['kind=', /"kind=": the value is empty/], ['=phone', /"=phone"/], ['Kind=phone', /"Kind=phone"/], ['1a=b', /"1a=b"/],
    ['api_level>=abc', /"api_level>=abc": >= takes a number/], ['api_level<=', /the value is empty/], ['api_level>=1e3', /takes a number/], ['api_level>=Infinity', /takes a number/],
    ['api_level>3', /"api_level>3"/], ['api level=3', /"api level=3"/],
  ];
  for (const [text, pattern] of bad) assert.throws(() => parseQuery(text), error => error.code === 'HUB_USAGE' && pattern.test(error.message), JSON.stringify(text));
  refused(() => parseQuery(undefined), 'HUB_USAGE');
});

test('operators: >= and <= read a number facet, = compares by the facet type', () => {
  const r = registry();
  assert.deepEqual(ids(match(r, query('kind=phone,api_level>=34'), policy)), ['s24']);
  assert.deepEqual(ids(match(r, query('api_level<=33'), policy)), ['s26']);
  assert.deepEqual(ids(match(r, query('api_level>=33'), policy)), ['s24', 's26'], 'inclusive');
  assert.deepEqual(ids(match(r, query('api_level=35'), policy)), ['s24'], 'numeric equality');
  assert.deepEqual(ids(match(r, query('api_level=35.0'), policy)), ['s24']);
  assert.deepEqual(ids(match(r, query('model=SM-S928U'), policy)), ['s24']);
  assert.deepEqual(ids(match(r, query('tier=flagship'), policy)), ['s24']);
  assert.deepEqual(ids(match(r, query('has_nfc=true'), policy)), ['s24']);
  assert.deepEqual(ids(match(r, query('kind=phone,deploy_target=false'), policy)), ['s24']);
  assert.deepEqual(ids(match(r, query('kind=phone,deploy_target=true'), policy)), ['s26']);
  assert.deepEqual(ids(match(r, query('host=mac'), policy)), ['ios-lane']);
  assert.deepEqual(ids(match(r, query('id=emulator'), policy)), ['emulator']);
});

test('a missing facet, a wrong type and a non-number never match, and the reason says which', () => {
  const r = registry();
  const reason = text => { try { match(r, query(text), policy); } catch (error) { return error; } return null; };
  const none = reason('api_level>=40');
  assert.equal(none.code, 'HUB_NO_MATCH');
  assert.match(none.reason, /^s24 api_level is 35, not >=40; s26 api_level is 33, not >=40; ios-lane has no api_level; emulator has no api_level$/);
  assert.match(reason('deploy_target=yes').reason, /s24 deploy_target is false, and "yes" is not true or false/);
  assert.match(reason('api_level=high').reason, /s24 api_level is 35, and "high" is not a number/);
  assert.match(reason('kind>=3').reason, /s24 kind is phone \(a text facet\), and >= reads only a number/);
  assert.match(reason('has_nfc>=1').reason, /s26 has no has_nfc/);
  assert.match(reason('tier>=1').reason, /s24 tier is flagship/);
  // a capability is only read when it is a usable value
  const odd = registry({ s24: { capabilities: { api_level: Number.NaN, list: [1], none: null } } });
  for (const key of ['api_level>=1', 'list=1', 'none=1']) {
    assert.throws(() => match(odd, query(`${key},id=s24`), policy), error => error.code === 'HUB_NO_MATCH' && new RegExp(`^s24 has no ${key.split(/[=>]/)[0]};`).test(error.reason), key);
  }
});

test('an intrinsic facet wins a name clash with a Capability', () => {
  const r = registry({ s24: { capabilities: { kind: 'tablet', model: 'x', api_level: 35 } } });
  assert.deepEqual(ids(match(r, query('kind=phone,api_level>=34'), policy)), ['s24']);
  assert.throws(() => match(r, query('kind=tablet'), policy), error => error.code === 'HUB_NO_MATCH');
  assert.throws(() => match(r, query('model=x'), policy), error => error.code === 'HUB_NO_MATCH');
});

test('a dedicated_qa phone is left out of a query unless it is named or dedicated_qa is asked for', () => {
  const r = registry({ s24: { capabilities: { dedicated_qa: true } } });
  assert.deepEqual(ids(match(r, query('kind=phone'), policy)), ['s26']);
  const excluded = match(r, query('kind=phone'), policy).excluded;
  assert.deepEqual(excluded.find(entry => entry.id === 's24'), { id: 's24', why: 'is dedicated_qa (name it or ask for dedicated_qa)' });
  assert.deepEqual(ids(match(r, query('kind=phone,dedicated_qa=true'), policy)), ['s24']);
  assert.deepEqual(ids(match(r, query('name=s24'), policy)), ['s24']);
  assert.deepEqual(ids(match(r, query('id=s24'), policy)), ['s24']);
  // any dedicated_qa clause lifts the exclusion; a clause then reads the facet, and a Resource with no such facet never matches
  assert.throws(() => match(r, query('kind=phone,dedicated_qa=false'), policy), error => /^s24 dedicated_qa is true, not false; s26 has no dedicated_qa;/.test(error.reason));
  assert.throws(() => match(r, query('model=SM-S928U'), policy), error => error.code === 'HUB_NO_MATCH' && /s24 is dedicated_qa/.test(error.reason), 'a model is not a name');
  assert.throws(() => match(r, query('name>=1'), policy), error => error.code === 'HUB_NO_MATCH');
});

test('the named phone list is the Pool order, then runtime phones; the dedicated_qa exclusion spares only the seeded members (Q1)', () => {
  const r = registry({
    s24: { capabilities: { dedicated_qa: true } },
    extra: [
      phone('res-late', { seeded: false, created_at: '2026-11-02T00:00:00Z', capabilities: {} }),
      phone('res-early', { seeded: false, created_at: '2026-11-01T00:00:00Z', capabilities: {} }),
      phone('res-qa', { seeded: false, created_at: '2026-11-01T12:00:00Z', capabilities: { dedicated_qa: true } }),
      phone('res-gone', { seeded: false, created_at: '2026-11-01T13:00:00Z', retired_at: '2026-11-03T00:00:00Z' }),
      phone('res-missing', { seeded: false, created_at: '2026-11-01T14:00:00Z', seed_missing: true }),
      phone('res-mac', { seeded: false, host: 'mac', created_at: '2026-11-01T15:00:00Z' }),
      record({ id: 'res-ipad', lock: 'res-ipad', kind: 'ios-lane', seeded: false, created_at: '2026-11-01T16:00:00Z' }),
    ],
  });
  const result = match(r, { pool: 'phone' }, policy);
  assert.deepEqual(ids(result), ['s24', 's26', 'res-early', 'res-late']);
  assert.deepEqual(result.pool, { kind: 'named', name: 'phone' });
  assert.equal(result.host, 'linux');
  assert.deepEqual(result.excluded.map(entry => entry.id), ['res-qa', 'res-gone', 'res-missing']);
  assert.deepEqual(ids(match(registry(), { pool: 'phone' }, policy)), ['s24', 's26']);
});

test('the same seeded devices.json gives [s24, s26] as the named list, with and without the QA mark', () => {
  const devices = loadDevices({});
  const marked = seed(devices, { qaDevices: () => [{ name: 'S24', model: 'SM-S928U', serial: 'R5CX31AEJDA' }] });
  assert.equal(marked.resources.find(entry => entry.id === 's24').capabilities.dedicated_qa, true);
  assert.deepEqual(ids(match(marked, { pool: 'phone' }, policy)), ['s24', 's26']);
  assert.deepEqual(ids(match(seed(devices, { qaDevices: () => [] }), { pool: 'phone' }, policy)), ['s24', 's26']);
  // the same S24 is not served to a query that does not name it
  assert.deepEqual(ids(match(marked, query('kind=phone'), policy)), ['s26']);
});

test('a retired Resource is left out of a query, and the reason says so', () => {
  const r = registry({ s24: { retired_at: '2026-11-03T00:00:00Z' }, s26: { seed_missing: true } });
  assert.throws(() => match(r, query('kind=phone'), policy), error => error.code === 'HUB_NO_MATCH' && /^s24 is retired; s26 is retired; /.test(error.reason));
});

test('a deploy target is dropped when --for is over its cap, with the cap in the reason; the cap is exact', () => {
  const r = registry();
  assert.deepEqual(ids(match(r, { query: parseQuery('kind=phone'), for_ms: 3_600_000 }, policy)), ['s24', 's26'], 'exactly the cap');
  const over = match(r, { query: parseQuery('kind=phone'), for_ms: 3_600_001 }, policy);
  assert.deepEqual(ids(over), ['s24']);
  assert.deepEqual(over.excluded.find(entry => entry.id === 's26'), { id: 's26', why: 'is a deploy target capped at 60 min, under the 61 min asked' });
  assert.deepEqual(ids(match(r, { pool: 'phone', for_ms: 7_200_000 }, policy)), ['s24'], 'the named list drops it too');
  assert.deepEqual(ids(match(r, { query: parseQuery('kind=phone') }, policy)), ['s24', 's26'], 'no for_ms, no cap');
  const only = registry({ s24: { capabilities: { dedicated_qa: true } } });
  assert.throws(() => match(only, { query: parseQuery('kind=phone'), for_ms: 7_200_000 }, policy), error => error.code === 'HUB_NO_MATCH'
    && error.reason === 's24 is dedicated_qa (name it or ask for dedicated_qa); s26 is a deploy target capped at 60 min, under the 120 min asked; ios-lane kind is ios-lane, not phone; emulator kind is emulator-pool, not phone');
});

test('HUB_NO_MATCH carries reason and excluded, and an empty Registry says so', () => {
  const error = (() => { try { match(registry(), query('api_level>=99'), policy); } catch (caught) { return caught; } return null; })();
  assert.equal(error.code, 'HUB_NO_MATCH');
  assert.equal(error.excluded.length, 4);
  assert.deepEqual(error.excluded[0], { id: 's24', why: 'api_level is 35, not >=99' });
  assert.equal(error.reason, error.excluded.map(entry => `${entry.id} ${entry.why}`).join('; '));
  assert.match(error.message, /^no Resource matches: s24 /);
  assert.throws(() => match({ resources: [], pools: {} }, query('kind=phone'), policy), error => error.code === 'HUB_NO_MATCH' && error.reason === 'the Registry has no Resources' && error.excluded.length === 0);
});

test('members on more than one host are HUB_POOL_CROSS_HOST, naming each host and its ids', () => {
  const error = (() => { try { match(registry(), query('deploy_target=true'), policy); } catch (caught) { return caught; } return null; })();
  assert.equal(error.code, 'HUB_POOL_CROSS_HOST');
  assert.match(error.message, /linux \(s26\), mac \(ios-lane\)/);
  assert.deepEqual(ids(match(registry(), query('deploy_target=true,host=linux'), policy)), ['s26']);
});

test('an unknown pool, a pool with no members list and a malformed request are HUB_USAGE', () => {
  refused(() => match(registry(), { pool: 'tablet' }, policy), 'HUB_USAGE');
  refused(() => match(registry(), { pool: 'emulator' }, policy), 'HUB_USAGE');
  refused(() => match(registry(), {}, policy), 'HUB_USAGE');
  refused(() => match(registry(), { query: [] }, policy), 'HUB_USAGE');
});

test('match is pure: the registry and the request are not changed, and the same ask gives the same answer', () => {
  const r = registry();
  const before = JSON.stringify(r);
  const request = { query: parseQuery('kind=phone,api_level>=33'), for_ms: 600_000 };
  const first = match(r, request, policy);
  assert.equal(JSON.stringify(r), before);
  assert.deepEqual(match(r, request, policy), first);
  assert.equal(first.members[0], r.resources[0], 'members are the registry\'s own records, in its order');
});

test('match.mjs imports nothing', () => {
  const source = readFileSync(fileURLToPath(new URL('./match.mjs', import.meta.url)), 'utf8');
  assert.deepEqual(source.match(/^import .*$/gm) ?? [], []);
});
