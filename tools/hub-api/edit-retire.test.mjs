// Story 6.7: POST /registry/resources/{id} (edit) and /retire through handle(), on a temp lock and event dir with the seed inputs injected.
// No port is bound and no real QA file is opened; the QA phones of these tests are made-up serials.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadDevices } from '../ci/lib/devices.mjs';
import { readEvents } from '../ci/lib/events.mjs';
import { acquireLease, queueView, releaseLease } from '../ci/lib/lock.mjs';
import { loadPolicy } from '../ci/lib/policy.mjs';
import { hermetic } from '../ci/test-fixtures.mjs';
import { fleetOf, resolve } from '../device/claims.mjs';
import { applySeed, registryPath } from '../registry/store.mjs';
import { RECORD_KEYS } from '../registry/view.mjs';
import { ROUTES, handle } from './routes.mjs';

hermetic();

const HOST = 'test-host';
const policy = loadPolicy().policy;
const NOW = () => Date.parse('2026-11-25T10:00:00Z');
const NOW_ISO = '2026-11-25T10:00:00.000Z';
const S24_SERIAL = 'R5CX31AEJDA';
const PHONE_SERIAL = 'QAPIXEL7777';
const qa = [{ name: 'S24', serial: S24_SERIAL, allowed_users: [0, 10] }, { name: 'Pixel-QA', model: 'Pixel 7', serial: PHONE_SERIAL, allowed_users: [0] }];
const PIXEL = { kind: 'phone', name: 'pixel', host: 'linux', identity: { serial: 'PX9', model: 'Pixel 9' }, capabilities: { api_level: 35, old: 'x' }, holder: 'jarad' };

function scratch() {
  const root = mkdtempSync(join(tmpdir(), 'hub-api-edit-'));
  const env = { PATH: process.env.PATH, HOME: root, HUB_LOCK_DIR: join(root, 'locks'), HUB_EVENT_DIR: join(root, 'events') };
  const devices = structuredClone(loadDevices({}));
  const s = {
    root, env, devices,
    ctx: (more = {}) => ({ env, policy, routes: ROUTES, now: NOW, hostId: HOST, devices, qaDevices: () => qa, log: { out: () => {}, err: () => {} }, ...more }),
    post: (url, body, more) => handle({ method: 'POST', url, body }, s.ctx(more)),
    register: body => s.post('/registry/resources', body ?? PIXEL),
    edit: (id, body, more) => s.post(`/registry/resources/${id}`, body, more),
    retire: (id, body, more) => s.post(`/registry/resources/${id}/retire`, body ?? { holder: 'jarad' }, more),
    get: url => handle({ method: 'GET', url }, s.ctx()),
    seedFile: () => applySeed({ env, devices, qaDevices: () => qa, now: NOW, hostId: HOST, log: () => {} }),
    file: () => JSON.parse(readFileSync(registryPath(env), 'utf8')),
    bytes: () => readFileSync(registryPath(env), 'utf8'),
    events: () => [...readEvents({ env })].filter(event => event.event.startsWith('registry-')),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
  return s;
}

const problemOf = answer => [answer.status, answer.body.code, answer.body.exit, answer.body.reason];
const record = (s, id) => s.file().resources.find(entry => entry.id === id);

// A scratch with the seed and the registered `res-pixel`: rev 2.
async function withPixel() {
  const s = scratch();
  await s.seedFile();
  assert.equal((await s.register()).body.rev, 2);
  return s;
}

test('rename: rev 3, name pixel-9, id and lock unchanged, one registry-edit with changed, rev and actor', async () => {
  const s = await withPixel();
  try {
    const answer = await s.edit('res-pixel', { if_rev: 2, name: 'pixel-9', holder: 'jarad' });
    assert.equal(answer.status, 200);
    assert.equal(answer.headers['Cache-Control'], 'no-store');
    assert.deepEqual([answer.body.rev, answer.body.source], [3, 'file']);
    assert.deepEqual(Object.keys(answer.body.resource), [...RECORD_KEYS]);
    assert.deepEqual([answer.body.resource.id, answer.body.resource.lock, answer.body.resource.name, answer.body.resource.visibility], ['res-pixel', 'res-pixel', 'pixel-9', 'visible']);
    assert.equal(record(s, 'res-pixel').display_name, 'pixel-9');
    assert.equal(s.file().rev, 3);
    const edits = s.events().filter(event => event.rev === 3);
    assert.equal(edits.length, 1);
    assert.deepEqual([edits[0].event, edits[0].resource, edits[0].reason, edits[0].actor], ['registry-edit', 'res-pixel', 'edit', { holder: 'jarad', via: 'api' }]);
    assert.ok(edits[0].changed.includes('name'));
    // The word follows: the new name reads, the old one is free again.
    assert.equal((await s.get('/resources/res-pixel')).body.resource.name, 'pixel-9');
    assert.equal((await s.register({ ...PIXEL, identity: { model: 'x' } })).body.resource.id, 'res-pixel-2');
  } finally { s.cleanup(); }
});

test('capability patch: set, remove with null, keep the rest; the event lists capability keys', async () => {
  const s = await withPixel();
  try {
    await s.edit('res-pixel', { if_rev: 2, capabilities: { dedicated_qa: true }, holder: 'jarad' });
    const answer = await s.edit('res-pixel', { if_rev: 3, capabilities: { api_level: 36, old: null }, holder: 'jarad', why: 'upgraded' });
    assert.equal(answer.status, 200);
    assert.deepEqual(answer.body.resource.capabilities, { api_level: 36, dedicated_qa: true });
    assert.deepEqual(record(s, 'res-pixel').capabilities, { api_level: 36, dedicated_qa: true });
    const event = s.events().find(entry => entry.rev === 4);
    assert.deepEqual(event.changed, ['capabilities.api_level', 'capabilities.old']);
    assert.equal(event.why, 'upgraded');
    // The QA mark redacts the identity in the answer, and the file keeps it.
    assert.deepEqual(answer.body.resource.identity, { serial: null, model: 'Pixel 9' });
    assert.equal(record(s, 'res-pixel').identity.serial, 'PX9');
  } finally { s.cleanup(); }
});

test('a seeded record: capabilities are editable and survive a re-seed', async () => {
  const s = scratch();
  try {
    await s.seedFile();
    const answer = await s.edit('s24', { if_rev: 1, capabilities: { lab: 'a' }, holder: 'jarad' });
    assert.equal(answer.status, 200);
    assert.equal(answer.body.resource.capabilities.lab, 'a');
    // A re-seed that differs (a new devices.json name) rewrites the seeded fields and keeps the capability.
    const changed = structuredClone(s.devices);
    changed.android_extra[0].model = 'SM-S928U-NEW';
    const reseeded = await applySeed({ env: s.env, devices: changed, qaDevices: () => qa, now: NOW, hostId: HOST, log: () => {} });
    assert.equal(reseeded.changed, true, 'the re-seed really rewrote the record');
    assert.equal(record(s, 's24').identity.model, 'SM-S928U-NEW');
    assert.equal(record(s, 's24').capabilities.lab, 'a');
    assert.equal((await s.get('/resources/s24')).body.resource.capabilities.lab, 'a');
  } finally { s.cleanup(); }
});

test('if_rev is required: absent is no-if-rev, not a whole number is bad-if-rev; a stale one is a conflict and the file is unchanged', async () => {
  const s = await withPixel();
  try {
    const before = s.bytes();
    assert.deepEqual(problemOf(await s.edit('res-pixel', { name: 'x', holder: 'jarad' })), [400, 'HUB_USAGE', 2, 'no-if-rev']);
    assert.deepEqual(problemOf(await s.edit('res-pixel', { name: 'x', if_rev: '2', holder: 'jarad' })), [400, 'HUB_USAGE', 2, 'bad-if-rev']);
    const stale = await s.edit('res-pixel', { name: 'x', if_rev: 1, holder: 'jarad' });
    assert.deepEqual(problemOf(stale), [409, 'HUB_REGISTRY_CONFLICT', 1, 'hub_registry_conflict']);
    assert.equal(stale.body.rev, 2);
    assert.equal(s.bytes(), before);
  } finally { s.cleanup(); }
});

test('the body refusals: bad-body, bad-capabilities, no-change, no-holder, bad-actor, bad-why; each writes nothing', async () => {
  const s = await withPixel();
  try {
    const before = s.bytes();
    const bad = [
      ['no body', undefined, 'bad-body'],
      ['array', [], 'bad-body'],
      ['unknown key', { if_rev: 2, name: 'x', holder: 'j', color: 'blue' }, 'bad-body'],
      ['a register key', { if_rev: 2, name: 'x', holder: 'j', kind: 'phone', deploy_target: true }, 'bad-body'],
      ['bad cap key', { if_rev: 2, capabilities: { 'A-b': 1 }, holder: 'j' }, 'bad-capabilities'],
      ['allowed_users', { if_rev: 2, capabilities: { allowed_users: null }, holder: 'j' }, 'bad-capabilities'],
      ['nested cap', { if_rev: 2, capabilities: { a: [1] }, holder: 'j' }, 'bad-capabilities'],
      ['no change', { if_rev: 2, holder: 'j' }, 'no-change'],
      ['no holder', { if_rev: 2, name: 'x' }, 'no-holder'],
      ['bad actor', { if_rev: 2, name: 'x', actor: { holder: 'x', via: 'nowhere' } }, 'bad-actor'],
      ['bad why', { if_rev: 2, name: 'x', holder: 'j', why: 3 }, 'bad-why'],
    ];
    for (const [label, body, reason] of bad) assert.deepEqual(problemOf(await s.edit('res-pixel', body)), [400, 'HUB_USAGE', 2, reason], label);
    assert.deepEqual(problemOf(await s.edit('res-pixel', { if_rev: 2, name: 'Bad Name', holder: 'j' })), [400, 'HUB_REGISTRY_NAME', 2, 'not-slug']);
    assert.deepEqual(problemOf(await s.edit('res-pixel', { if_rev: 2, name: 'a'.repeat(29), holder: 'j' })), [400, 'HUB_REGISTRY_NAME', 2, 'too-long']);
    assert.equal(s.bytes(), before);
  } finally { s.cleanup(); }
});

test('immutable keys: a runtime Resource is 400 immutable (even echoing the stored value); a seeded one is 409 HUB_REGISTRY_SEEDED', async () => {
  const s = await withPixel();
  try {
    const before = s.bytes();
    for (const body of [{ identity: { model: 'x' } }, { host: 'linux' }, { kind: 'phone' }, { id: 'res-pixel' }, { lock: 'res-pixel' }]) {
      assert.deepEqual(problemOf(await s.edit('res-pixel', { if_rev: 2, holder: 'j', ...body })), [400, 'HUB_USAGE', 2, 'immutable'], JSON.stringify(body));
    }
    assert.equal(s.bytes(), before);
    assert.deepEqual(problemOf(await s.edit('s24', { if_rev: 2, holder: 'j', identity: { model: 'x' } })), [409, 'HUB_REGISTRY_SEEDED', 2, 'identity']);
    assert.deepEqual(problemOf(await s.edit('s24', { if_rev: 2, holder: 'j', name: 'x' })), [409, 'HUB_REGISTRY_SEEDED', 2, 'name']);
    assert.deepEqual(problemOf(await s.retire('s24')), [409, 'HUB_REGISTRY_SEEDED', 2, 'retire']);
    assert.equal(s.bytes(), before);
  } finally { s.cleanup(); }
});

test('taken and reserved names: another record\'s name, a retired record\'s name, s26 and the reserved words', async () => {
  const s = await withPixel();
  try {
    await s.register({ ...PIXEL, name: 'tablet', identity: { model: 'x' } });
    await s.register({ ...PIXEL, name: 'old-one', identity: { model: 'x' } });
    assert.equal((await s.retire('res-old-one')).status, 200);
    const before = s.bytes();
    const rev = s.file().rev;
    const rename = name => s.edit('res-pixel', { if_rev: rev, name, holder: 'j' });
    for (const name of ['tablet', 'old-one', 's26', 'res-tablet']) {
      const answer = await rename(name);
      assert.equal(answer.status, 409, name);
      assert.equal(answer.body.code, 'HUB_REGISTRY_NAME');
      assert.ok(['taken', 'reserved'].includes(answer.body.reason), name);
    }
    assert.deepEqual(problemOf(await rename('s26')).slice(3), ['reserved']);
    assert.deepEqual(problemOf(await rename('old-one')), [409, 'HUB_REGISTRY_NAME', 2, 'taken']);
    assert.deepEqual(problemOf(await rename('phone')), [409, 'HUB_REGISTRY_NAME', 2, 'reserved']);
    assert.equal(s.bytes(), before);
  } finally { s.cleanup(); }
});

test('unknown id: 404 unknown, for an edit and for a retire', async () => {
  const s = await withPixel();
  try {
    const before = s.bytes();
    assert.deepEqual(problemOf(await s.edit('res-nope', { if_rev: 2, name: 'x', holder: 'j' })), [404, 'HUB_RESOURCE_NOT_FOUND', 2, 'unknown']);
    assert.deepEqual(problemOf(await s.retire('res-nope')), [404, 'HUB_RESOURCE_NOT_FOUND', 2, 'unknown']);
    // A record is found by id only, never by its name.
    assert.deepEqual(problemOf(await s.edit('pixel', { if_rev: 2, name: 'x', holder: 'j' })), [404, 'HUB_RESOURCE_NOT_FOUND', 2, 'unknown']);
    assert.equal(s.bytes(), before);
  } finally { s.cleanup(); }
});

test('edit of a retired record: 409 HUB_RESOURCE_RETIRED retired, file unchanged', async () => {
  const s = await withPixel();
  try {
    assert.equal((await s.retire('res-pixel', { if_rev: 2, holder: 'jarad' })).status, 200);
    const before = s.bytes();
    assert.deepEqual(problemOf(await s.edit('res-pixel', { if_rev: 3, name: 'x', holder: 'j' })), [409, 'HUB_RESOURCE_RETIRED', 2, 'retired']);
    assert.equal(s.bytes(), before);
  } finally { s.cleanup(); }
});

test('a no-op edit commits and logs nothing and answers the current rev', async () => {
  const s = await withPixel();
  try {
    const before = s.bytes();
    const events = s.events().length;
    for (const body of [{ name: 'pixel' }, { capabilities: { api_level: 35 } }, { capabilities: { absent: null } }, { capabilities: {} }]) {
      const answer = await s.edit('res-pixel', { if_rev: 2, holder: 'j', ...body });
      assert.deepEqual([answer.status, answer.body.rev], [200, 2], JSON.stringify(body));
    }
    assert.equal(s.bytes(), before);
    assert.equal(s.events().length, events);
  } finally { s.cleanup(); }
});

test('retire an idle Resource: 200 hidden, retired_at is now, one registry-retire, GET /resources omits it', async () => {
  const s = await withPixel();
  try {
    const answer = await s.retire('res-pixel', { holder: 'jarad', why: 'left the desk' });
    assert.equal(answer.status, 200);
    assert.deepEqual(answer.body, { rev: 3, source: 'file', id: 'res-pixel', retired_at: NOW_ISO, visibility: 'hidden' });
    assert.deepEqual(Object.keys(answer.body), ['rev', 'source', 'id', 'retired_at', 'visibility']);
    const after = record(s, 'res-pixel');
    const { retired_at: _at, ...rest } = after;
    assert.deepEqual(rest, { id: 'res-pixel', lock: 'res-pixel', name: 'pixel', words: [], display_name: 'pixel', kind: 'phone', host: 'linux', identity: { serial: 'PX9', model: 'Pixel 9' }, capabilities: { api_level: 35, old: 'x' }, deploy_target: false, seeded: false, created_at: NOW_ISO });
    const retires = s.events().filter(event => event.event === 'registry-retire');
    assert.equal(retires.length, 1);
    assert.deepEqual([retires[0].resource, retires[0].reason, retires[0].rev, retires[0].actor, retires[0].why], ['res-pixel', 'retire', 3, { holder: 'jarad', via: 'api' }, 'left the desk']);
    assert.equal((await s.get('/resources')).body.resources.some(resource => resource.id === 'res-pixel'), false);
    assert.equal((await s.get('/resources/res-pixel')).status, 404);
    assert.equal((await s.get('/pools')).body.pools[0].members.includes('res-pixel'), false);
  } finally { s.cleanup(); }
});

test('retire a held Resource with a waiter: retiring, the Hold and the ticket untouched, takes refused, the waiter acquires, then hidden', async () => {
  const s = await withPixel();
  const lease = (id, extra = {}) => acquireLease('res-pixel', { holder: 'agent-a', why: 'proof', forMs: 60_000, env: s.env, log: () => {}, pollMs: 5, hostId: HOST, id, ...extra });
  try {
    const first = await lease('first-1', { waitMs: 5000 });
    let second = null;
    const waiting = lease('second-1', { waitMs: 30_000 }).then(record => { second = record; return record; });
    for (let i = 0; i < 1000 && !(existsSync(join(s.env.HUB_LOCK_DIR, 'res-pixel.queue')) && readdirSync(join(s.env.HUB_LOCK_DIR, 'res-pixel.queue')).length > 0); i += 1) await new Promise(done => setTimeout(done, 10));
    const ownerBefore = readFileSync(join(s.env.HUB_LOCK_DIR, 'res-pixel.lock', 'owner.json'), 'utf8');
    const ticketsBefore = readdirSync(join(s.env.HUB_LOCK_DIR, 'res-pixel.queue'));
    const answer = await s.retire('res-pixel');
    assert.deepEqual([answer.status, answer.body.visibility, answer.body.retired_at], [200, 'retiring', NOW_ISO]);
    assert.equal(readFileSync(join(s.env.HUB_LOCK_DIR, 'res-pixel.lock', 'owner.json'), 'utf8'), ownerBefore, 'the owner is untouched');
    assert.deepEqual(readdirSync(join(s.env.HUB_LOCK_DIR, 'res-pixel.queue')), ticketsBefore, 'the ticket is untouched');
    // Still listed while it is held, as retiring.
    assert.equal((await s.get('/resources/res-pixel')).body.resource.visibility, 'retiring');
    // The Claims library refuses a new take, by id and by name.
    const fleet = fleetOf(s.devices);
    for (const word of ['pixel', 'res-pixel']) {
      assert.throws(() => resolve(word, { fleet, env: s.env }), error => error.code === 'HUB_RESOURCE_RETIRED' && error.reason === 'retired', word);
    }
    // The holder releases, the waiter proceeds; after its release the Resource is hidden.
    assert.equal(releaseLease('res-pixel', first.lease_id, { env: s.env, hostId: HOST }).released, true);
    await waiting;
    assert.equal(second.lease_id, 'second-1');
    assert.equal((await s.get('/resources/res-pixel')).body.resource.visibility, 'retiring');
    assert.equal(releaseLease('res-pixel', 'second-1', { env: s.env, hostId: HOST }).released, true);
    assert.deepEqual(queueView('res-pixel', { env: s.env }), []);
    assert.equal((await s.get('/resources/res-pixel')).status, 404);
    assert.equal((await s.get('/resources')).body.resources.some(resource => resource.id === 'res-pixel'), false);
  } finally { s.cleanup(); }
});

test('retire answers retiring when the lock has a waiter but no owner', async () => {
  const s = await withPixel();
  try {
    const answer = await s.retire('res-pixel', undefined, { lockActivity: () => ({ held: false, queued: true }) });
    assert.deepEqual([answer.status, answer.body.visibility], [200, 'retiring']);
  } finally { s.cleanup(); }
});

test('retire twice: 200 with the same retired_at and rev, and no second event', async () => {
  const s = await withPixel();
  try {
    const first = await s.retire('res-pixel');
    const later = Date.parse('2026-11-26T10:00:00Z');
    const again = await s.retire('res-pixel', { holder: 'someone-else' }, { now: () => later });
    assert.equal(again.status, 200);
    assert.deepEqual(again.body, first.body);
    assert.equal(s.file().rev, 3);
    assert.equal(s.events().filter(event => event.event === 'registry-retire').length, 1);
    assert.equal(record(s, 'res-pixel').retired_at, NOW_ISO);
  } finally { s.cleanup(); }
});

test('retire takes an optional if_rev: stale is a conflict, the right one retires', async () => {
  const s = await withPixel();
  try {
    const stale = await s.retire('res-pixel', { if_rev: 1, holder: 'jarad' });
    assert.deepEqual([stale.status, stale.body.code, stale.body.rev], [409, 'HUB_REGISTRY_CONFLICT', 2]);
    assert.equal(record(s, 'res-pixel').retired_at, undefined);
    assert.equal((await s.retire('res-pixel', { if_rev: 2, holder: 'jarad' })).body.rev, 3);
    for (const [label, body, reason] of [['no body', undefined, 'bad-body'], ['extra', { holder: 'j', name: 'x' }, 'bad-body'], ['no holder', {}, 'no-holder'], ['bad rev', { holder: 'j', if_rev: 'x' }, 'bad-if-rev'], ['why', { holder: 'j', why: 1 }, 'bad-why']]) {
      assert.deepEqual(problemOf(await s.post('/registry/resources/res-pixel/retire', body)), [400, 'HUB_USAGE', 2, reason], label);
    }
  } finally { s.cleanup(); }
});

test('re-seed after a retire: the record keeps retired_at, and the registry-retire stays in the log', async () => {
  const s = await withPixel();
  try {
    await s.retire('res-pixel');
    await s.seedFile();
    assert.equal(record(s, 'res-pixel').retired_at, NOW_ISO);
    assert.equal(s.events().filter(event => event.event === 'registry-retire').length, 1);
  } finally { s.cleanup(); }
});

test('a missing file: an edit of s24 capabilities with if_rev 0 writes the seed (rev 1), then the edit is rev 2; if_rev 3 is a conflict at rev 0', async () => {
  const s = scratch();
  try {
    const stale = await s.edit('s24', { if_rev: 3, capabilities: { lab: 'a' }, holder: 'jarad' });
    assert.deepEqual([stale.status, stale.body.code, stale.body.rev], [409, 'HUB_REGISTRY_CONFLICT', 0]);
    assert.equal(existsSync(registryPath(s.env)), false);
    const answer = await s.edit('s24', { if_rev: 0, capabilities: { lab: 'a' }, holder: 'jarad' });
    assert.deepEqual([answer.status, answer.body.rev], [200, 2]);
    const seeded = s.events().filter(event => event.rev === 1);
    assert.ok(seeded.length > 0 && seeded.every(event => event.reason === 'seed'));
    assert.deepEqual(s.events().filter(event => event.rev === 2).map(event => [event.event, event.resource, event.reason]), [['registry-edit', 's24', 'edit']]);
  } finally { s.cleanup(); }
});

test('actor: a given actor is recorded as given, an absent one is {holder, via: api}', async () => {
  const s = await withPixel();
  try {
    await s.edit('res-pixel', { if_rev: 2, name: 'one', actor: { holder: 'jarad', via: 'control-surface' } });
    await s.retire('res-pixel', { holder: 'cait', actor: undefined });
    const [edit, retire] = s.events().filter(event => event.rev >= 3);
    assert.deepEqual([edit.actor, retire.actor], [{ holder: 'jarad', via: 'control-surface' }, { holder: 'cait', via: 'api' }]);
  } finally { s.cleanup(); }
});

test('rev race: two edits with the same if_rev, concurrent: one 200, one 409 with the winner\'s rev', async () => {
  const s = await withPixel();
  try {
    const [a, b] = await Promise.all([s.edit('res-pixel', { if_rev: 2, name: 'one', holder: 'j' }), s.edit('res-pixel', { if_rev: 2, name: 'two', holder: 'j' })]);
    assert.deepEqual([a.status, b.status].sort(), [200, 409]);
    assert.equal((a.status === 409 ? a : b).body.rev, 3);
  } finally { s.cleanup(); }
});

test('an unreadable file is 409 HUB_REGISTRY_FORMAT for both routes', async () => {
  const s = await withPixel();
  try {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(registryPath(s.env), 'not json{');
    assert.equal((await s.edit('res-pixel', { if_rev: 2, name: 'x', holder: 'j' })).body.code, 'HUB_REGISTRY_FORMAT');
    assert.equal((await s.retire('res-pixel')).body.code, 'HUB_REGISTRY_FORMAT');
    assert.equal(s.bytes(), 'not json{');
  } finally { s.cleanup(); }
});

test('the routes are POST only; a GET on either is 405 with Allow: POST', async () => {
  const s = scratch();
  try {
    for (const url of ['/registry/resources/res-pixel', '/registry/resources/res-pixel/retire']) {
      const answer = await handle({ method: 'GET', url }, s.ctx());
      assert.deepEqual([answer.status, answer.body.reason, answer.headers.Allow], [405, 'method', 'POST'], url);
    }
  } finally { s.cleanup(); }
});

test('no registry-edit or registry-retire line carries identity or an identity value, and no response carries a QA serial', async () => {
  const s = scratch();
  try {
    await s.seedFile();
    const answers = [
      await s.register({ ...PIXEL, capabilities: { dedicated_qa: true } }),
      await s.edit('res-pixel', { if_rev: 2, capabilities: { api_level: 36 }, holder: 'jarad' }),
      await s.edit('res-pixel', { if_rev: 3, name: 'pixel-9', holder: 'jarad' }),
      await s.edit('res-pixel', { if_rev: 4, identity: { serial: S24_SERIAL, model: 'x' }, holder: 'jarad' }),
      await s.edit('res-pixel-qa', { if_rev: 4, capabilities: { lab: 'b' }, holder: 'jarad' }),
      await s.edit('s24', { if_rev: 5, identity: { serial: PHONE_SERIAL }, holder: 'jarad' }),
      await s.edit('s24', { if_rev: 5, capabilities: { lab: 'a' }, holder: 'jarad' }),
      await s.retire('res-pixel'),
      await s.retire('res-pixel-qa'),
      await s.retire('s24'),
      await s.get('/resources'),
    ];
    for (const answer of answers) {
      const text = JSON.stringify(answer.body);
      for (const secret of [S24_SERIAL, PHONE_SERIAL, 'PX9']) assert.equal(text.includes(secret), false, `${answer.status} ${secret}`);
      assert.equal(text.includes('allowed_users'), false);
    }
    const lines = s.events().filter(event => ['registry-edit', 'registry-retire'].includes(event.event));
    assert.ok(lines.some(line => line.event === 'registry-edit') && lines.some(line => line.event === 'registry-retire'));
    for (const line of lines) {
      assert.equal('identity' in line, false);
      const text = JSON.stringify(line);
      for (const secret of [S24_SERIAL, PHONE_SERIAL, 'PX9', 'Pixel 9', 'Pixel 7']) assert.equal(text.includes(secret), false, `${line.event} ${secret}`);
    }
  } finally { s.cleanup(); }
});
