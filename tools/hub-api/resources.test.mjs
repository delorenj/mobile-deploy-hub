// Story 6.5: GET /resources, /resources/{id} and /pools through handle(), on a temp lock and event dir with the seed inputs
// injected. No port is bound and no real QA file is opened; the QA phones of these tests are made-up serials.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadDevices } from '../ci/lib/devices.mjs';
import { loadPolicy } from '../ci/lib/policy.mjs';
import { hermetic } from '../ci/test-fixtures.mjs';
import { applySeed, readRegistry, writeRegistry } from '../registry/store.mjs';
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

function scratch() {
  const root = mkdtempSync(join(tmpdir(), 'hub-api-resources-'));
  const env = { PATH: process.env.PATH, HOME: root, HUB_LOCK_DIR: join(root, 'locks'), HUB_EVENT_DIR: join(root, 'events') };
  const devices = structuredClone(loadDevices({}));
  const s = {
    root, env, devices,
    ctx: (more = {}) => ({ env, policy, routes: ROUTES, now: NOW, devices, qaDevices: () => qa, log: { out: () => {}, err: () => {} }, ...more }),
    get: (url, more) => handle({ method: 'GET', url }, s.ctx(more)),
    seedFile: () => applySeed({ env, devices, qaDevices: () => qa, now: NOW, hostId: HOST, log: () => {} }),
    // Rewrites the file's records through the one writer.
    edit: async change => {
      const { rev, resources, pools } = readRegistry({ env, devices, qaDevices: () => qa });
      return writeRegistry({ env, if_rev: rev, resources: change(structuredClone(resources)), pools: Object.entries(pools).map(([name, rest]) => ({ name, ...rest })), hostId: HOST, log: () => {} });
    },
    hold: lock => { mkdirSync(join(root, 'locks', `${lock}.lock`), { recursive: true }); writeFileSync(join(root, 'locks', `${lock}.lock/owner.json`), JSON.stringify({ kind: 'lease', lease_id: 'l-aaaaaaaaaaaa', holder: 'h' })); },
    queue: lock => {
      mkdirSync(join(root, 'locks', `${lock}.queue`), { recursive: true });
      writeFileSync(join(root, 'locks', `${lock}.queue/000000000000001-000000-00000000.json`), JSON.stringify({ kind: 'lease', pid: 0, lease_id: 'l-bbbbbbbbbbbb', holder: 'w', expires_at: new Date(NOW() + 60_000).toISOString() }));
    },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
  return s;
}

const ids = answer => answer.body.resources.map(resource => resource.id);
const byId = (answer, id) => answer.body.resources.find(resource => resource.id === id);

test('no file: the seed at rev 0, s24, s26 (a deploy target), ios-lane and emulator, created_at null', async () => {
  const s = scratch();
  try {
    const answer = await s.get('/resources');
    assert.equal(answer.status, 200);
    assert.equal(answer.headers['Cache-Control'], 'no-store');
    assert.equal(answer.body.rev, 0);
    assert.equal(answer.body.source, 'seed');
    assert.deepEqual(ids(answer), ['s24', 's26', 'ios-lane', 'emulator', 'res-pixel-qa']);
    for (const resource of answer.body.resources) {
      assert.deepEqual(Object.keys(resource), [...RECORD_KEYS]);
      assert.equal(resource.created_at, null);
      assert.equal(resource.visibility, 'visible');
      assert.equal(resource.seed_missing, false);
    }
    assert.deepEqual([byId(answer, 's26').deploy_target, byId(answer, 's26').lock], [true, 'adb']);
    assert.deepEqual([byId(answer, 's24').deploy_target, byId(answer, 'emulator').deploy_target], [false, false]);
  } finally { s.cleanup(); }
});

test('a seeded file: source file, the file rev and created_at set', async () => {
  const s = scratch();
  try {
    await s.seedFile();
    const answer = await s.get('/resources');
    assert.equal(answer.body.source, 'file');
    assert.equal(answer.body.rev, 1);
    for (const resource of answer.body.resources) assert.equal(resource.created_at, '2026-11-25T10:00:00.000Z');
    assert.equal((await s.get('/pools')).body.source, 'file');
  } finally { s.cleanup(); }
});

test('one record: /resources/s26, /resources/ios-lane; the query string is ignored; an unknown id is 404 unknown, exit 2', async () => {
  const s = scratch();
  try {
    const one = await s.get('/resources/s26?x=1');
    assert.equal(one.status, 200);
    assert.deepEqual([one.body.rev, one.body.source, one.body.resource.id, one.body.resource.lock, one.body.resource.deploy_target], [0, 'seed', 's26', 'adb', true]);
    assert.deepEqual(Object.keys(one.body.resource), [...RECORD_KEYS]);
    const missing = await s.get('/resources/nope');
    assert.equal(missing.status, 404);
    assert.equal(missing.headers['Content-Type'], 'application/problem+json');
    assert.deepEqual([missing.body.code, missing.body.exit, missing.body.reason], ['HUB_RESOURCE_NOT_FOUND', 2, 'unknown']);
    // Lookup is by id only: a name or a lock is not found.
    assert.equal((await s.get('/resources/adb')).body.reason, 'unknown');
    assert.equal((await s.get('/resources/pixel-qa')).body.reason, 'unknown');
    assert.equal((await s.get('/resources/res-pixel-qa')).status, 200);
  } finally { s.cleanup(); }
});

test('retired idle and seed_missing idle are hidden: absent from the list, 404 retired on the id', async () => {
  const s = scratch();
  try {
    await s.seedFile();
    await s.edit(resources => resources.map(record => (record.id === 's24' ? { ...record, retired_at: RETIRED } : record.id === 'res-pixel-qa' ? { ...record, seed_missing: true } : record)));
    const list = await s.get('/resources');
    assert.deepEqual(ids(list), ['s26', 'ios-lane', 'emulator']);
    for (const id of ['s24', 'res-pixel-qa']) {
      const gone = await s.get(`/resources/${id}`);
      assert.deepEqual([gone.status, gone.body.code, gone.body.exit, gone.body.reason], [404, 'HUB_RESOURCE_NOT_FOUND', 2, 'retired'], id);
    }
  } finally { s.cleanup(); }
});

test('retired held or queued is listed as retiring; a live Resource is never asked about its lock', async () => {
  const s = scratch();
  try {
    await s.seedFile();
    await s.edit(resources => resources.map(record => (record.id === 's24' || record.id === 'res-pixel-qa' ? { ...record, retired_at: RETIRED } : record)));
    s.hold('s24');
    s.queue('res-pixel-qa');
    const list = await s.get('/resources');
    assert.deepEqual(ids(list), ['s24', 's26', 'ios-lane', 'emulator', 'res-pixel-qa']);
    assert.equal(byId(list, 's24').visibility, 'retiring');
    assert.equal(byId(list, 'res-pixel-qa').visibility, 'retiring');
    assert.equal(byId(list, 's26').visibility, 'visible');
    assert.equal((await s.get('/resources/s24')).body.resource.visibility, 'retiring');
    // The injected seam is what the route asks, and only for the marked records.
    const asked = [];
    const answer = await s.get('/resources', { lockActivity: lock => { asked.push(lock); return { held: lock === 's24', queued: false }; } });
    assert.deepEqual(asked.sort(), ['res-pixel-qa', 's24']);
    assert.deepEqual(ids(answer), ['s24', 's26', 'ios-lane', 'emulator']);
  } finally { s.cleanup(); }
});

test('pools: phone is named with the matcher members, emulator is a gate; every phone retired leaves no members', async () => {
  const s = scratch();
  try {
    const seeded = await s.get('/pools');
    assert.deepEqual(seeded.body.pools, [
      { name: 'phone', kind: 'named', members: ['s24', 's26'], gate: null },
      { name: 'emulator', kind: 'gate', members: [], gate: 'emulator' },
    ]);
    await s.seedFile();
    await s.edit(resources => resources.map(record => (record.kind === 'phone' ? { ...record, retired_at: RETIRED } : record)));
    const empty = await s.get('/pools');
    assert.deepEqual(empty.body.pools[0], { name: 'phone', kind: 'named', members: [], gate: null });
  } finally { s.cleanup(); }
});

test('param edges: a trailing slash and a bad escape are 404 HUB_NO_ROUTE; a wrong method is 405 with Allow: GET', async () => {
  const s = scratch();
  try {
    for (const url of ['/resources/', '/resources/%E0', '/pools/', '/resources/a/b']) {
      const answer = await s.get(url);
      assert.deepEqual([answer.status, answer.body.code, answer.body.reason], [404, 'HUB_NO_ROUTE', 'no-route'], url);
    }
    for (const url of ['/resources/s26', '/resources', '/pools']) {
      const answer = await handle({ method: 'POST', url }, s.ctx());
      assert.deepEqual([answer.status, answer.body.code, answer.body.exit, answer.headers.Allow], [405, 'HUB_NO_ROUTE', 2, 'GET'], url);
    }
    // An encoded segment is one id: %2F does not split it, and it is simply unknown.
    assert.equal((await s.get('/resources/s26%2Fx')).body.reason, 'unknown');
    assert.equal((await s.get('/resources/%73%32%36')).body.resource.id, 's26');
  } finally { s.cleanup(); }
});

test('handle(): a literal route beats a parameterised one, params reach the handler, and 405 works on parameterised paths', async () => {
  const seen = [];
  const routes = [
    { method: 'GET', path: '/things/{id}', handler: (_ctx, request) => { seen.push(request.params); return { which: 'param' }; } },
    { method: 'POST', path: '/things/new', handler: () => ({ which: 'literal' }) },
    { method: 'DELETE', path: '/things/{id}/parts/{part}', handler: (_ctx, request) => { seen.push(request.params); return { ok: true }; } },
  ];
  const ctx = { routes, log: { err: () => {} } };
  assert.equal((await handle({ method: 'POST', url: '/things/new' }, ctx)).body.which, 'literal');
  // The literal tier is the whole answer for its path: GET /things/new is a 405 naming the literal route's method.
  const wrong = await handle({ method: 'GET', url: '/things/new' }, ctx);
  assert.deepEqual([wrong.status, wrong.headers.Allow], [405, 'POST']);
  assert.equal((await handle({ method: 'GET', url: '/things/a%20b' }, ctx)).body.which, 'param');
  assert.equal((await handle({ method: 'DELETE', url: '/things/x/parts/y' }, ctx)).status, 200);
  assert.deepEqual(seen, [{ id: 'a b' }, { id: 'x', part: 'y' }]);
  const notAllowed = await handle({ method: 'PUT', url: '/things/x' }, ctx);
  assert.deepEqual([notAllowed.status, notAllowed.headers.Allow], [405, 'GET']);
  assert.equal((await handle({ method: 'GET', url: '/things/' }, ctx)).status, 404);
});

// Every string value at every key path of a response: nothing a QA phone's serial could be hiding in.
function strings(value, out = []) {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const item of value) strings(item, out);
  else if (value !== null && typeof value === 'object') for (const [key, child] of Object.entries(value)) { out.push(key); strings(child, out); }
  return out;
}

test('QA walk: no serial of a dedicated_qa phone (s24, and an unknown phone) is in any response, seed or file', async () => {
  const s = scratch();
  try {
    for (const phase of ['seed', 'file']) {
      if (phase === 'file') await s.seedFile();
      const answers = [await s.get('/health'), await s.get('/resources'), await s.get('/pools')];
      for (const resource of answers[1].body.resources) answers.push(await s.get(`/resources/${resource.id}`));
      answers.push(await s.get('/resources/nope'));
      for (const answer of answers) {
        const text = JSON.stringify(answer.body);
        for (const serial of [S24_SERIAL, PHONE_SERIAL]) assert.equal(text.includes(serial), false, `${phase}: ${serial}`);
        assert.ok(strings(answer.body).every(value => !value.includes(S24_SERIAL) && !value.includes(PHONE_SERIAL)));
      }
      const list = answers[1];
      assert.deepEqual(byId(list, 's24').identity, { serial: null, model: 'SM-S928U' });
      assert.deepEqual(byId(list, 'res-pixel-qa').identity, { serial: null, model: 'Pixel 7' });
      assert.equal(byId(list, 'res-pixel-qa').capabilities.dedicated_qa, true);
      assert.equal(JSON.stringify(list.body).includes('allowed_users'), false);
      // A phone that is not dedicated keeps its serial.
      assert.equal(byId(list, 's26').identity.serial, 'R5GL43A7PCH');
    }
  } finally { s.cleanup(); }
});
