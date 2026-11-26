// Story 9.3: the forwarding module's pure parts (tools/device/forward.mjs): the header, the carried record, what each Hold route names, where a
// request lives, the fleet entry a carried record becomes, and the body a forward is sent with. Hermetic: no port, no host, no clock.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadDevices } from '../ci/lib/devices.mjs';
import { loadPolicy } from '../ci/lib/policy.mjs';
import { hermetic } from '../ci/test-fixtures.mjs';
import { createKnown } from '../host-agent/known.mjs';
import { seed } from '../registry/seed.mjs';
import {
  NAMED, carried, checkCarried, forwardHold, forwardedDoor, namedRecords, placeOf, retiredCarried, transportOf, unseeded, unwrapCarried, withPlace, wrongHost,
} from './forward.mjs';

hermetic();

const policy = loadPolicy().policy;
const devices = structuredClone(loadDevices({}));
const known = createKnown({ env: {}, devices, qaDevices: () => [] });
const view = known.current();
const LEASE = 'POST /leases';
const usageReason = fn => { try { fn(); } catch (error) { return [error.code, error.reason]; } return assert.fail('expected a throw'); };

test('forwardedDoor reads the header in any case: null when absent, the door when it is one, bad-forward otherwise', () => {
  assert.equal(forwardedDoor(undefined), null);
  assert.equal(forwardedDoor({}), null);
  for (const door of ['cli', 'api', 'host-agent']) assert.equal(forwardedDoor({ 'x-hub-forwarded': door }), door);
  assert.equal(forwardedDoor({ 'X-Hub-Forwarded': 'api' }), 'api');
  for (const bad of ['', 'API', 'web', 7, null]) assert.deepEqual(usageReason(() => forwardedDoor({ 'x-hub-forwarded': bad })), ['HUB_USAGE', 'bad-forward']);
});

test('checkCarried takes exactly {id, lock, host, rev, retired_at} and refuses everything else as bad-resource', () => {
  const good = { id: 'ios-lane', lock: 'mac-ios', host: 'mac', rev: 7, retired_at: null };
  assert.deepEqual(checkCarried(good), good);
  assert.deepEqual(checkCarried({ ...good, retired_at: undefined }), good, 'an absent retired_at is null');
  assert.equal(checkCarried({ ...good, retired_at: '2031-01-01T00:00:00Z' }).retired_at, '2031-01-01T00:00:00Z');
  assert.equal(checkCarried({ ...good, rev: 0 }).rev, 0);
  const bad = [
    null, [], 'ios-lane', { ...good, extra: 1 }, { ...good, id: 'Ios Lane' }, { ...good, id: '../x' }, { ...good, lock: '' }, { ...good, lock: 'a/b' },
    { ...good, host: 'windows' }, { ...good, rev: -1 }, { ...good, rev: 1.5 }, { ...good, rev: '1' }, { ...good, retired_at: 7 }, { id: 'x' },
  ];
  for (const value of bad) assert.deepEqual(usageReason(() => checkCarried(value)), ['HUB_USAGE', 'bad-resource'], JSON.stringify(value));
});

test('unwrapCarried takes the record down to its id; an object resource without the header is bad-resource; a string resource is a public one', () => {
  const record = { id: 's24', lock: 's24', host: 'linux', rev: 3, retired_at: null };
  const forwarded = unwrapCarried({ headers: { 'x-hub-forwarded': 'api' }, body: { resource: record, holder: 'a' } });
  assert.equal(forwarded.door, 'api');
  assert.deepEqual(forwarded.carried, record);
  assert.deepEqual(forwarded.request.body, { resource: 's24', holder: 'a' });
  const word = unwrapCarried({ headers: { 'x-hub-forwarded': 'cli' }, body: { resource: 's24' } });
  assert.deepEqual([word.door, word.carried], ['cli', null]);
  const plain = unwrapCarried({ headers: {}, body: { resource: 's24' } });
  assert.deepEqual([plain.door, plain.carried], [null, null]);
  assert.deepEqual(usageReason(() => unwrapCarried({ headers: {}, body: { resource: record } })), ['HUB_USAGE', 'bad-resource']);
  assert.deepEqual(unwrapCarried({ headers: {}, body: undefined }).carried, null);
});

test('carried builds the record of a Registry record at a revision', () => {
  const ios = view.resources.find(record => record.id === 'ios-lane');
  assert.deepEqual(carried(ios, 4), { id: 'ios-lane', lock: 'mac-ios', host: 'mac', rev: 4, retired_at: null });
  assert.equal(carried({ ...ios, retired_at: 'then' }, 1).retired_at, 'then');
});

test('NAMED lists the seven Hold routes, and only the Reservation force-release is not forwarded', () => {
  assert.equal(Object.keys(NAMED).length, 7);
  assert.deepEqual(Object.entries(NAMED).filter(([, entry]) => !entry.forward).map(([key]) => key), ['POST /reservations/{run_key}/force-release']);
});

test('namedRecords: a word names one Resource (and `single`), a Pool word its members, a match its matcher members, an unknown word nothing', () => {
  const lease = { for_ms: 1, holder: 'a', why: 'x' };
  const named = (body, key = LEASE) => namedRecords(key, NAMED[key].check({ ...lease, ...body }), { params: {} }, view, policy);
  assert.deepEqual(named({ resource: 'ipad' }).records.map(record => record.id), ['ios-lane']);
  assert.equal(named({ resource: 'ipad' }).single.id, 'ios-lane');
  assert.equal(named({ resource: 'mac-ios' }).single.id, 'ios-lane', 'a lock names it too');
  assert.equal(named({ resource: 'ios-lane' }).single.id, 'ios-lane');
  assert.equal(named({ resource: 's24' }).single.id, 's24');
  const phones = named({ resource: 'phone' });
  assert.ok(phones.records.length >= 2 && phones.records.every(record => record.host === 'linux'));
  assert.equal(phones.single, null);
  assert.ok(named({ match: 'kind=phone' }).records.every(record => record.kind === 'phone'));
  assert.equal(named({ match: 'kind=phone' }).single, null);
  assert.deepEqual(named({ match: 'profile=default' }).records.map(record => record.kind), ['emulator-pool']);
  assert.deepEqual(named({ resource: 'toaster' }).records, []);
  assert.deepEqual(named({ match: 'not a query' }).records, [], 'a query that does not parse names none: the handler refuses it');
  assert.deepEqual(named({ match: 'kind=nothing' }).records, []);
});

test('namedRecords for the other Hold routes: extend and release name `resource`, a force-release of a slot names the emulator, a cancel names resource and pool', () => {
  const run = (key, input, params = {}) => namedRecords(key, NAMED[key].check(input), { params }, view, policy);
  assert.deepEqual(run('POST /leases/{id}/release', { holder: 'a' }).records, []);
  assert.deepEqual(run('POST /leases/{id}/release', { holder: 'a', resource: 'ios-lane' }).records.map(record => record.id), ['ios-lane']);
  assert.deepEqual(run('POST /leases/{id}/extend', { holder: 'a', for_ms: 5, resource: 's24' }).records.map(record => record.id), ['s24']);
  assert.deepEqual(run('POST /leases/{id}/force-release', { why: 'x', holder: 'a' }, { id: 'emulator-2' }).records.map(record => record.kind), ['emulator-pool']);
  assert.deepEqual(run('POST /leases/{id}/force-release', { why: 'x', holder: 'a', resource: 's24' }, { id: 'l-aaaaaaaaaaaa' }).records.map(record => record.id), ['s24']);
  assert.deepEqual(run('GET /leases/{id}', undefined, { id: 'l-1' }).records, []);
  const pooled = run('POST /requests/{id}/cancel', { holder: 'a', resource: 's24', pool: 'phone' });
  assert.equal(pooled.single, null, 'two names: no single record');
  assert.ok(pooled.records.every(record => record.host === 'linux'));
  assert.equal(run('POST /requests/{id}/cancel', { holder: 'a', resource: 's24' }).single.id, 's24');
});

test('placeOf: the one foreign host every named Resource is on; this host, nothing named and mixed hosts are null', () => {
  const rec = host => ({ host });
  assert.equal(placeOf([rec('mac')], 'linux'), 'mac');
  assert.equal(placeOf([rec('mac'), rec('mac')], 'linux'), 'mac');
  assert.equal(placeOf([rec('linux')], 'linux'), null);
  assert.equal(placeOf([], 'linux'), null);
  assert.equal(placeOf([rec('linux'), rec('mac')], 'linux'), null, 'mixed hosts stay local: the Claims library refuses the Pool');
  assert.equal(placeOf([rec('linux'), rec('mac')], 'mac'), null);
  assert.equal(placeOf([rec('linux')], 'mac'), 'linux');
});

test('withPlace adds a carried record to the fleet as a {device, lock, deploy} entry the Claims library finds, and leaves a known lock alone', () => {
  const fleet = [{ device: 's24', lock: 's24', deploy: false, name: 'S24', serial: null, model: null }];
  const added = withPlace(fleet, { id: 'ios-lane', lock: 'mac-ios', host: 'mac', rev: 2, retired_at: null }, view, policy);
  assert.equal(added.length, 2);
  assert.equal(added[1].lock, 'mac-ios');
  assert.equal(added[1].deploy, true, 'the iPad lane is a deploy target: it gets the 60 min cap');
  assert.equal(added[1].device, 'ios-lane');
  assert.equal(fleet.length, 1, 'the input is not mutated');
  assert.equal(withPlace(fleet, { id: 's24', lock: 's24', host: 'linux', rev: 0, retired_at: null }, view, policy), fleet);
  const plain = withPlace([], { id: 'zz', lock: 'zz', host: 'mac', rev: 1, retired_at: null }, { resources: [] }, policy);
  assert.deepEqual([plain[0].device, plain[0].lock, plain[0].deploy], ['zz', 'zz', false]);
  const deploy = withPlace([], { id: 'x', lock: 'adb', host: 'linux', rev: 1, retired_at: null }, { resources: [] }, policy);
  assert.equal(deploy[0].deploy, true, 'the policy\'s own deploy locks cap too');
});

test('the errors: wrongHost is HUB_WRONG_HOST exit 2, unseeded a HUB_USAGE with its reason, retiredCarried 409 HUB_RESOURCE_RETIRED', () => {
  const record = { id: 's24', lock: 's24', host: 'linux', rev: 0, retired_at: null };
  const wrong = wrongHost(record, 'mac');
  assert.deepEqual([wrong.code, wrong.exit], ['HUB_WRONG_HOST', 2]);
  assert.match(wrong.message, /s24 is on host linux; this is host mac/);
  assert.deepEqual([unseeded(record).code, unseeded(record).reason], ['HUB_USAGE', 'unseeded']);
  const retired = retiredCarried(record);
  assert.deepEqual([retired.code, retired.status, retired.reason, retired.resource], ['HUB_RESOURCE_RETIRED', 409, 'retired', 's24']);
});

// A bridge that records what forwardHold sent and answers 200.
const bridge = () => {
  const sent = [];
  return { sent, request: async args => { sent.push(args); return new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } }); } };
};
const placeFor = (word, own = 'linux', key = LEASE, input = { resource: word, for_ms: 1000, why: 'x', holder: 'a' }) => {
  const { records, single } = namedRecords(key, NAMED[key].check(input), { params: {} }, view, policy);
  return { host: placeOf(records, own), records, single };
};

test('forwardHold sets the actor to the sender\'s, carries the record at the view\'s rev, mints an id on a take and bounds the call by the wait', async () => {
  const b = bridge();
  const input = NAMED[LEASE].check({ resource: 'ipad', for_ms: 1000, holder: 'jarad', why: 'x', wait_ms: 90_000, id: 'l-aaaaaaaaaaaa' });
  const place = placeFor('ipad');
  const answer = await forwardHold({ key: LEASE, request: { method: 'POST', path: '/leases', body: { resource: 'ipad', for_ms: 1000, holder: 'jarad', why: 'x', wait_ms: 90_000, id: 'l-aaaaaaaaaaaa' } }, input, place, rev: 7, door: 'api', ctx: { request: b.request } });
  assert.deepEqual(answer, { status: 200, body: { ok: true } });
  const sent = b.sent[0];
  assert.deepEqual([sent.host, sent.method, sent.path, sent.forwarded, sent.waitMs, sent.budgetMs], ['mac', 'POST', '/leases', 'api', 90_000, 0]);
  assert.deepEqual(sent.body.resource, { id: 'ios-lane', lock: 'mac-ios', host: 'mac', rev: 7, retired_at: null });
  assert.deepEqual(sent.body.actor, { holder: 'jarad', via: 'api' });
  assert.equal(sent.body.id, 'l-aaaaaaaaaaaa');
});

test('forwardHold passes a given actor unchanged (the first front door sets it), and mints an id when there is none', async () => {
  const b = bridge();
  const body = { resource: 's24', for_ms: 1000, holder: 'jarad', why: 'x', actor: { holder: 'jarad', via: 'cli' } };
  await forwardHold({ key: LEASE, request: { method: 'POST', path: '/leases', body }, input: NAMED[LEASE].check(body), place: placeFor('s24', 'mac'), rev: 0, door: 'host-agent', ctx: { request: b.request } });
  assert.deepEqual(b.sent[0].body.actor, { holder: 'jarad', via: 'cli' });
  assert.match(b.sent[0].body.id, /^l-[0-9a-f]{12}$/);
  assert.equal(b.sent[0].forwarded, 'host-agent');
});

test('forwardHold of an emulator take adds the boot budget and an e- id; a Pool or match goes with no carried record', async () => {
  const b = bridge();
  const body = { resource: 'emulator', for_ms: 1000, holder: 'a', why: 'x' };
  await forwardHold({ key: LEASE, request: { method: 'POST', path: '/leases', body }, input: NAMED[LEASE].check(body), place: placeFor('emulator', 'mac'), rev: 0, door: 'api', ctx: { request: b.request, emulator: { bootTimeoutMs: 123_000 } } });
  assert.equal(b.sent[0].budgetMs, 123_000);
  assert.match(b.sent[0].body.id, /^e-[0-9a-f]{12}$/);
  const phone = { resource: 'phone', for_ms: 1000, holder: 'a', why: 'x' };
  await forwardHold({ key: LEASE, request: { method: 'POST', path: '/leases', body: phone }, input: NAMED[LEASE].check(phone), place: placeFor('phone', 'mac'), rev: 0, door: 'api', ctx: { request: b.request } });
  assert.equal(b.sent[1].body.resource, 'phone', 'a Pool word goes as it is');
  assert.equal(b.sent[1].budgetMs, 0);
});

test('forwardHold of a cancel carries host (the target\'s key) and its own pool; a non-take has no wait and no minted id', async () => {
  const b = bridge();
  const body = { resource: 's24', pool: 'phone', holder: 'ops' };
  await forwardHold({ key: 'POST /requests/{id}/cancel', request: { method: 'POST', path: '/requests/r-1/cancel', body }, input: NAMED['POST /requests/{id}/cancel'].check(body), place: placeFor('s24', 'mac', 'POST /requests/{id}/cancel', { resource: 's24', pool: 'phone', holder: 'ops' }), rev: 5, door: 'host-agent', ctx: { request: b.request } });
  assert.deepEqual([b.sent[0].body.host, b.sent[0].body.pool, b.sent[0].waitMs, b.sent[0].body.id], ['linux', 'phone', 0, undefined]);
});

test('forwardHold with no seam uses the hub-client request: a far host that does not answer is HUB_DEVICE_AWAY, and the signal ends it', async () => {
  const body = { resource: 's24', for_ms: 1000, holder: 'a', why: 'x' };
  const ctx = { hostKey: () => 'mac', policy, devices, sshImpl: () => { throw Object.assign(new Error('spawn ssh ENOENT'), { code: 'ENOENT' }); } };
  const send = () => forwardHold({ key: LEASE, request: { method: 'POST', path: '/leases', body }, input: NAMED[LEASE].check(body), place: placeFor('s24', 'mac'), rev: 0, door: 'cli', ctx });
  const error = await send().then(() => null, caught => caught);
  assert.deepEqual([error.code, error.exit, error.reason], ['HUB_DEVICE_AWAY', 75, 'host-unreachable']);
  assert.equal(typeof transportOf(ctx), 'function');
  assert.equal(transportOf({ request: send }), send);
});

test('the seed view is rev 0 and seeds its own ids, so a peer that has only its seed can carry rev 0 for them', () => {
  assert.equal(view.rev, 0);
  assert.ok(view.seeded.includes('ios-lane') && view.seeded.includes('s24'));
  assert.deepEqual(view.seeded, seed(devices, { qaDevices: () => [] }).resources.map(record => record.id));
});
