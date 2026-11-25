// Story 6.6: POST /registry/resources through handle(), on a temp lock and event dir with the seed inputs injected. No port is bound and
// no real QA file is opened; the QA phones of these tests are made-up serials.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadDevices } from '../ci/lib/devices.mjs';
import { readEvents } from '../ci/lib/events.mjs';
import { loadPolicy } from '../ci/lib/policy.mjs';
import { hermetic } from '../ci/test-fixtures.mjs';
import { applySeed, readRegistry, registryPath, writeRegistry } from '../registry/store.mjs';
import { RECORD_KEYS } from '../registry/view.mjs';
import { ROUTES, handle } from './routes.mjs';

hermetic();

const HOST = 'test-host';
const policy = loadPolicy().policy;
const NOW = () => Date.parse('2026-11-25T10:00:00Z');
const S24_SERIAL = 'R5CX31AEJDA';
const PHONE_SERIAL = 'QAPIXEL7777';
const RETIRED = '2026-11-25T09:00:00.000Z';
const qa = [{ name: 'S24', serial: S24_SERIAL, allowed_users: [0, 10] }, { name: 'Pixel-QA', model: 'Pixel 7', serial: PHONE_SERIAL, allowed_users: [0] }];

const PIXEL = { kind: 'phone', name: 'pixel', host: 'linux', identity: { serial: 'PX9', model: 'Pixel 9' }, capabilities: { api_level: 35 }, holder: 'jarad' };

function scratch() {
  const root = mkdtempSync(join(tmpdir(), 'hub-api-register-'));
  const env = { PATH: process.env.PATH, HOME: root, HUB_LOCK_DIR: join(root, 'locks'), HUB_EVENT_DIR: join(root, 'events') };
  const devices = structuredClone(loadDevices({}));
  const s = {
    root, env, devices,
    ctx: (more = {}) => ({ env, policy, routes: ROUTES, now: NOW, hostId: HOST, devices, qaDevices: () => qa, log: { out: () => {}, err: () => {} }, ...more }),
    post: (body, more) => handle({ method: 'POST', url: '/registry/resources', body }, s.ctx(more)),
    get: url => handle({ method: 'GET', url }, s.ctx()),
    seedFile: () => applySeed({ env, devices, qaDevices: () => qa, now: NOW, hostId: HOST, log: () => {} }),
    file: () => JSON.parse(readFileSync(registryPath(env), 'utf8')),
    bytes: () => readFileSync(registryPath(env), 'utf8'),
    events: () => [...readEvents({ env })].filter(event => event.event.startsWith('registry-')),
    // Rewrites the file's records through the one writer.
    edit: async change => {
      const { rev, resources, pools } = readRegistry({ env, devices, qaDevices: () => qa });
      return writeRegistry({ env, if_rev: rev, resources: change(structuredClone(resources)), pools: Object.entries(pools).map(([name, rest]) => ({ name, ...rest })), hostId: HOST, log: () => {} });
    },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
  return s;
}

const problemOf = answer => [answer.status, answer.body.code, answer.body.exit, answer.body.reason];

test('register: 201, rev 2, id and lock res-pixel, one registry-add with the rev, reason and actor', async () => {
  const s = scratch();
  try {
    await s.seedFile();
    const answer = await s.post(PIXEL);
    assert.equal(answer.status, 201);
    assert.equal(answer.headers['Cache-Control'], 'no-store');
    assert.equal(answer.headers['Content-Type'], 'application/json; charset=utf-8');
    assert.equal(answer.body.rev, 2);
    assert.equal(answer.body.source, 'file');
    const { resource } = answer.body;
    assert.deepEqual(Object.keys(resource), [...RECORD_KEYS]);
    assert.deepEqual([resource.id, resource.lock, resource.name, resource.kind, resource.host], ['res-pixel', 'res-pixel', 'pixel', 'phone', 'linux']);
    assert.deepEqual([resource.seeded, resource.seed_missing, resource.deploy_target, resource.visibility, resource.retired_at], [false, false, false, 'visible', null]);
    assert.equal(resource.created_at, '2026-11-25T10:00:00.000Z');
    assert.deepEqual(resource.identity, { serial: 'PX9', model: 'Pixel 9' });
    assert.deepEqual(resource.capabilities, { api_level: 35 });
    const doc = s.file();
    assert.equal(doc.rev, 2);
    assert.deepEqual(doc.resources.at(-1), { id: 'res-pixel', lock: 'res-pixel', name: 'pixel', words: [], display_name: 'pixel', kind: 'phone', host: 'linux', identity: { serial: 'PX9', model: 'Pixel 9' }, capabilities: { api_level: 35 }, deploy_target: false, seeded: false, created_at: '2026-11-25T10:00:00.000Z' });
    const adds = s.events().filter(event => event.rev === 2);
    assert.equal(adds.length, 1);
    assert.deepEqual([adds[0].event, adds[0].resource, adds[0].lock, adds[0].reason, adds[0].actor], ['registry-add', 'res-pixel', 'res-pixel', 'register', { holder: 'jarad', via: 'api' }]);
    // The read routes see it.
    assert.equal((await s.get('/resources/res-pixel')).body.resource.name, 'pixel');
    assert.ok((await s.get('/pools')).body.pools[0].members.includes('res-pixel'));
  } finally { s.cleanup(); }
});

test('the ios-lane kind: identity optional, a mac host only', async () => {
  const s = scratch();
  try {
    const ok = await s.post({ kind: 'ios-lane', name: 'ipad-two', host: 'mac', holder: 'jarad' });
    assert.equal(ok.status, 201);
    assert.equal(ok.body.resource.identity, null);
    assert.deepEqual(problemOf(await s.post({ kind: 'ios-lane', name: 'ipad-three', host: 'linux', holder: 'jarad' })), [400, 'HUB_USAGE', 2, 'bad-host']);
    assert.deepEqual(problemOf(await s.post({ kind: 'emulator-pool', name: 'pool', host: 'linux', holder: 'jarad' })), [400, 'HUB_USAGE', 2, 'bad-kind']);
    assert.deepEqual(problemOf(await s.post({ ...PIXEL, host: 'nowhere' })), [400, 'HUB_USAGE', 2, 'bad-host']);
  } finally { s.cleanup(); }
});

test('mint: res-pixel-2, then -3, when a record already has the id (renamed, or retired)', async () => {
  const s = scratch();
  try {
    assert.equal((await s.post(PIXEL)).body.resource.id, 'res-pixel');
    // Renamed: the word is free, the id is not.
    await s.edit(resources => resources.map(record => (record.id === 'res-pixel' ? { ...record, name: 'renamed' } : record)));
    const second = await s.post({ ...PIXEL, identity: { model: 'Pixel 9' } });
    assert.deepEqual([second.status, second.body.resource.id, second.body.resource.lock], [201, 'res-pixel-2', 'res-pixel-2']);
    // Retired: the name is taken, so the retired one is renamed away from the word first.
    await s.edit(resources => resources.map(record => (record.id === 'res-pixel-2' ? { ...record, name: 'gone', retired_at: RETIRED } : record)));
    const third = await s.post({ ...PIXEL, identity: { model: 'Pixel 9' } });
    assert.equal(third.body.resource.id, 'res-pixel-3');
  } finally { s.cleanup(); }
});

test('mint: past -999 is HUB_REGISTRY_NAME 409 exhausted', async () => {
  const s = scratch();
  try {
    await s.seedFile();
    await s.edit(resources => [...resources, ...['res-x', ...Array.from({ length: 998 }, (_, index) => `res-x-${index + 2}`)].map(id => ({ id, lock: id, name: `old-${id}`, words: [], kind: 'phone', host: 'linux', identity: null, capabilities: {}, retired_at: RETIRED }))]);
    assert.deepEqual(problemOf(await s.post({ ...PIXEL, name: 'x' })), [409, 'HUB_REGISTRY_NAME', 2, 'exhausted']);
  } finally { s.cleanup(); }
});

test('a phone without a model is 400 no-model; the other body reasons', async () => {
  const s = scratch();
  try {
    await s.seedFile();
    const before = s.bytes();
    const bad = [
      ['no identity', { ...PIXEL, identity: undefined }, 'no-model'],
      ['no model', { ...PIXEL, identity: { serial: 'PX9' } }, 'no-model'],
      ['unknown key', { ...PIXEL, color: 'blue' }, 'bad-body'],
      ['array body', [PIXEL], 'bad-body'],
      ['no body', undefined, 'bad-body'],
      ['identity key', { ...PIXEL, identity: { model: 'x', adb_id: 'y' } }, 'bad-identity'],
      ['identity value', { ...PIXEL, identity: { model: '' } }, 'bad-identity'],
      ['identity not object', { ...PIXEL, identity: 'x' }, 'bad-identity'],
      ['allowed_users', { ...PIXEL, capabilities: { allowed_users: true } }, 'bad-capabilities'],
      ['intrinsic key', { ...PIXEL, capabilities: { model: 'x' } }, 'bad-capabilities'],
      ['bad key shape', { ...PIXEL, capabilities: { 'Api-Level': 1 } }, 'bad-capabilities'],
      ['nested value', { ...PIXEL, capabilities: { a: { b: 1 } } }, 'bad-capabilities'],
      ['array value', { ...PIXEL, capabilities: { a: [1] } }, 'bad-capabilities'],
      ['infinite value', { ...PIXEL, capabilities: { a: Infinity } }, 'bad-capabilities'],
      ['null value', { ...PIXEL, capabilities: { a: null } }, 'bad-capabilities'],
      ['capabilities array', { ...PIXEL, capabilities: [] }, 'bad-capabilities'],
      ['negative if_rev', { ...PIXEL, if_rev: -1 }, 'bad-if-rev'],
      ['fractional if_rev', { ...PIXEL, if_rev: 1.5 }, 'bad-if-rev'],
      ['string if_rev', { ...PIXEL, if_rev: '1' }, 'bad-if-rev'],
      ['why number', { ...PIXEL, why: 3 }, 'bad-why'],
      ['bad actor', { ...PIXEL, actor: { holder: 'x', via: 'nowhere' } }, 'bad-actor'],
      ['null actor', { ...PIXEL, actor: null }, 'bad-actor'],
      ['no holder', { ...PIXEL, holder: undefined }, 'no-holder'],
      ['empty holder', { ...PIXEL, holder: '' }, 'no-holder'],
    ];
    for (const [label, body, reason] of bad) assert.deepEqual(problemOf(await s.post(body)), [400, 'HUB_USAGE', 2, reason], label);
    assert.equal(s.bytes(), before, 'a bad body writes nothing');
  } finally { s.cleanup(); }
});

test('a bad body on a missing file does not even write the seed', async () => {
  const s = scratch();
  try {
    assert.equal((await s.post({ ...PIXEL, holder: undefined })).status, 400);
    assert.throws(() => readFileSync(registryPath(s.env)), { code: 'ENOENT' });
  } finally { s.cleanup(); }
});

test('duplicate: the serial of a live Resource is 409 with the holder, and the detail never carries it', async () => {
  const s = scratch();
  try {
    await s.seedFile();
    const answer = await s.post({ ...PIXEL, identity: { serial: S24_SERIAL, model: 'x' } });
    assert.deepEqual(problemOf(answer), [409, 'HUB_REGISTRY_DUPLICATE', 2, 'serial']);
    assert.equal(answer.body.holder, 's24');
    assert.equal(JSON.stringify(answer.body).includes(S24_SERIAL), false);
    // A udid of a live record, too.
    await s.post(PIXEL);
    await s.edit(resources => resources.map(record => (record.id === 'res-pixel' ? { ...record, identity: { ...record.identity, udid: 'UDID-1' } } : record)));
    const udid = await s.post({ kind: 'ios-lane', name: 'ipad-two', host: 'mac', identity: { udid: 'UDID-1' }, holder: 'jarad' });
    assert.deepEqual(problemOf(udid), [409, 'HUB_REGISTRY_DUPLICATE', 2, 'udid']);
    assert.equal(udid.body.holder, 'res-pixel');
    assert.equal(JSON.stringify(udid.body).includes('UDID-1'), false);
  } finally { s.cleanup(); }
});

test('a retired record does not hold its identity (seed-missing is the planner\'s test: the seed rewrites that mark)', async () => {
  const s = scratch();
  try {
    await s.seedFile();
    await s.edit(resources => resources.map(record => (record.id === 'res-pixel-qa' ? { ...record, retired_at: RETIRED } : record.id === 's24' ? { ...record, retired_at: RETIRED } : record)));
    for (const [name, serial] of [['one', PHONE_SERIAL], ['two', S24_SERIAL]]) {
      const answer = await s.post({ ...PIXEL, name, identity: { serial, model: 'x' } });
      assert.equal(answer.status, 201, name);
    }
  } finally { s.cleanup(); }
});

test('names: reserved words are 409 reserved, retired names are 409 taken, bad shapes are 400', async () => {
  const s = scratch();
  try {
    await s.seedFile();
    for (const name of ['phone', 's24', 'res-x', 'emulator-3', 'run-1']) assert.deepEqual(problemOf(await s.post({ ...PIXEL, name })), [409, 'HUB_REGISTRY_NAME', 2, 'reserved'], name);
    assert.deepEqual(problemOf(await s.post({ ...PIXEL, name: 'Pixel 9' })), [400, 'HUB_REGISTRY_NAME', 2, 'not-slug']);
    assert.deepEqual(problemOf(await s.post({ ...PIXEL, name: undefined })), [400, 'HUB_REGISTRY_NAME', 2, 'not-slug']);
    assert.deepEqual(problemOf(await s.post({ ...PIXEL, name: 'a'.repeat(29) })), [400, 'HUB_REGISTRY_NAME', 2, 'too-long']);
    assert.equal((await s.post({ ...PIXEL, name: 'a'.repeat(28) })).status, 201);
    // Retired, a name stays taken; so does a word of a record (ios-lane's `ipad` is reserved, a runtime word is taken).
    await s.post({ ...PIXEL, name: 'tablet', identity: { model: 'x' } });
    await s.edit(resources => resources.map(record => (record.id === 'res-tablet' ? { ...record, retired_at: RETIRED, words: ['slate'] } : record)));
    assert.deepEqual(problemOf(await s.post({ ...PIXEL, name: 'tablet', identity: { model: 'x' } })), [409, 'HUB_REGISTRY_NAME', 2, 'taken']);
    assert.deepEqual(problemOf(await s.post({ ...PIXEL, name: 'slate', identity: { model: 'x' } })), [409, 'HUB_REGISTRY_NAME', 2, 'taken']);
  } finally { s.cleanup(); }
});

test('stale if_rev is 409 HUB_REGISTRY_CONFLICT with the current rev, and the file is unchanged', async () => {
  const s = scratch();
  try {
    await s.seedFile();
    const before = s.bytes();
    const answer = await s.post({ ...PIXEL, if_rev: 0 });
    assert.deepEqual(problemOf(answer), [409, 'HUB_REGISTRY_CONFLICT', 1, 'hub_registry_conflict']);
    assert.equal(answer.body.rev, 1);
    assert.equal(s.bytes(), before);
    assert.equal((await s.post({ ...PIXEL, if_rev: 1 })).body.rev, 2);
  } finally { s.cleanup(); }
});

test('rev race: two registers with the same if_rev, concurrent: one 201, one 409 with the winner\'s rev', async () => {
  const s = scratch();
  try {
    await s.seedFile();
    const [a, b] = await Promise.all([s.post({ ...PIXEL, name: 'one', identity: { model: 'x' }, if_rev: 1 }), s.post({ ...PIXEL, name: 'two', identity: { model: 'x' }, if_rev: 1 })]);
    assert.deepEqual([a.status, b.status].sort(), [201, 409]);
    const lost = a.status === 409 ? a : b;
    assert.equal(lost.body.code, 'HUB_REGISTRY_CONFLICT');
    assert.equal(lost.body.rev, 2);
    assert.equal(s.file().rev, 2);
  } finally { s.cleanup(); }
});

test('name race: two registers of "pixel", no if_rev, concurrent: one 201, one 409 taken', async () => {
  const s = scratch();
  try {
    const [a, b] = await Promise.all([s.post({ ...PIXEL, identity: { model: 'x' } }), s.post({ ...PIXEL, identity: { model: 'y' } })]);
    assert.deepEqual([a.status, b.status].sort(), [201, 409]);
    const lost = a.status === 409 ? a : b;
    assert.deepEqual(problemOf(lost), [409, 'HUB_REGISTRY_NAME', 2, 'taken']);
    assert.equal(s.file().resources.filter(record => record.name === 'pixel').length, 1);
  } finally { s.cleanup(); }
});

test('actor: a given actor is recorded as given; an absent one is {holder, via: api}; why rides along', async () => {
  const s = scratch();
  try {
    await s.post({ ...PIXEL, holder: undefined, actor: { holder: 'jarad', via: 'control-surface' }, why: 'new phone on the desk' });
    await s.post({ ...PIXEL, name: 'other', identity: { model: 'x' }, holder: 'cait', actor: undefined });
    const adds = s.events().filter(event => event.reason === 'register');
    assert.deepEqual(adds.map(event => event.actor), [{ holder: 'jarad', via: 'control-surface' }, { holder: 'cait', via: 'api' }]);
    assert.equal(adds[0].why, 'new phone on the desk');
    assert.equal(adds[1].why, undefined);
  } finally { s.cleanup(); }
});

test('a missing file: the seed is written first (rev 1, reason seed), then the register (rev 2); if_rev 0 is accepted, 3 is a conflict at rev 0', async () => {
  const s = scratch();
  try {
    const stale = await s.post({ ...PIXEL, if_rev: 3 });
    assert.equal(stale.status, 409);
    assert.deepEqual([stale.body.code, stale.body.rev], ['HUB_REGISTRY_CONFLICT', 0]);
    assert.throws(() => readFileSync(registryPath(s.env)), { code: 'ENOENT' });
    const answer = await s.post({ ...PIXEL, if_rev: 0 });
    assert.equal(answer.status, 201);
    assert.equal(answer.body.rev, 2);
    const events = s.events();
    const seeded = events.filter(event => event.rev === 1);
    assert.ok(seeded.length > 0 && seeded.every(event => event.reason === 'seed' && event.event === 'registry-add' && event.actor.holder === 'hub-api'));
    assert.deepEqual(events.filter(event => event.rev === 2).map(event => [event.resource, event.reason]), [['res-pixel', 'register']]);
    // Without if_rev, the same.
    const t = scratch();
    try { assert.equal((await t.post(PIXEL)).body.rev, 2); } finally { t.cleanup(); }
  } finally { s.cleanup(); }
});

test('an unreadable file is 409 HUB_REGISTRY_FORMAT and its bytes are unchanged', async () => {
  const s = scratch();
  try {
    mkdirSync(join(s.root, 'locks'), { recursive: true });
    writeFileSync(registryPath(s.env), 'not json{');
    const answer = await s.post(PIXEL);
    assert.deepEqual(problemOf(answer).slice(0, 3), [409, 'HUB_REGISTRY_FORMAT', 1]);
    assert.equal(s.bytes(), 'not json{');
  } finally { s.cleanup(); }
});

test('a QA mark: the response nulls the serial, the file keeps it, no event line or response carries an identity', async () => {
  const s = scratch();
  try {
    await s.seedFile();
    const answer = await s.post({ ...PIXEL, capabilities: { dedicated_qa: true } });
    assert.equal(answer.status, 201);
    assert.deepEqual(answer.body.resource.identity, { serial: null, model: 'Pixel 9' });
    assert.equal(s.file().resources.at(-1).identity.serial, 'PX9');
    const answers = [answer, await s.post({ ...PIXEL, name: 'again', identity: { serial: S24_SERIAL, model: 'x' } }), await s.post({ ...PIXEL, name: 'phone' }), await s.get('/resources')];
    for (const one of answers) {
      const text = JSON.stringify(one.body);
      for (const secret of [S24_SERIAL, PHONE_SERIAL, 'PX9']) assert.equal(text.includes(secret), false, secret);
      assert.equal(text.includes('allowed_users'), false);
    }
    // Every registry event of the log (seed and register): no `identity` key, no identity value.
    const lines = s.events();
    assert.ok(lines.length > 5);
    for (const line of lines) {
      assert.equal('identity' in line, false);
      const text = JSON.stringify(line);
      for (const secret of [S24_SERIAL, PHONE_SERIAL, 'PX9', 'Pixel 9', 'Pixel 7']) assert.equal(text.includes(secret), false, `${line.event} ${secret}`);
    }
  } finally { s.cleanup(); }
});

test('the route is POST only: GET and DELETE on the path are 405 with Allow: POST', async () => {
  const s = scratch();
  try {
    for (const method of ['GET', 'DELETE']) {
      const answer = await handle({ method, url: '/registry/resources' }, s.ctx());
      assert.deepEqual([answer.status, answer.body.reason, answer.headers.Allow], [405, 'method', 'POST']);
    }
  } finally { s.cleanup(); }
});

test('the refusal order with several faults: body, then name shape, then stale rev, then taken, then duplicate identity', async () => {
  const s = scratch();
  try {
    await s.seedFile();
    await s.post(PIXEL);
    const before = s.bytes();
    const dup = { serial: S24_SERIAL, model: 'x' };
    assert.deepEqual(problemOf(await s.post({ ...PIXEL, name: 'Bad Name', host: 'nowhere' })), [400, 'HUB_USAGE', 2, 'bad-host']);
    const stale = await s.post({ ...PIXEL, identity: dup, if_rev: 0 });
    assert.deepEqual([stale.status, stale.body.code], [409, 'HUB_REGISTRY_CONFLICT']);
    assert.deepEqual(problemOf(await s.post({ ...PIXEL, identity: dup })), [409, 'HUB_REGISTRY_NAME', 2, 'taken']);
    assert.equal(s.bytes(), before);
  } finally { s.cleanup(); }
});
