// Story 5.2: one list of reserved words, one slug rule, and `res-*` locks that queue (AD-28, AD-29, AD-40). lock.mjs owns the
// names; devices.mjs and the CLI's fleet builder only ask it. Hermetic: every lock and event dir is a temp dir.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEPLOY_TARGETS, EMULATOR_POOL, NAME_MAX, QUEUED, RESERVED, SEED_RESOURCES, SLUG, SLUG_MAX, acquireLease, isQueued, isSlug, leaseHoldersSince,
  listLocks, liveLease, nameRefusal, poolRequest, queueView, releaseLease, reservedBy, resourceOf,
} from './lib/lock.mjs';
import { parseDevices } from './lib/devices.mjs';
import { readEvents } from './lib/events.mjs';
import { fleetOf } from '../device/claims.mjs';
import { hermetic } from './test-fixtures.mjs';

hermetic();

const devicesText = readFileSync(fileURLToPath(new URL('./devices.json', import.meta.url)), 'utf8');
const devices = parseDevices(devicesText);
const HOST_ID = 'names-test-machine';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'hub-names-'));
  const env = { HUB_LOCK_DIR: join(root, 'locks'), HUB_EVENT_DIR: join(root, 'events'), GITHUB_REPOSITORY: 'delorenj/example', GITHUB_RUN_ID: '9' };
  return { root, env, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
const events = f => [...readEvents({ env: f.env })];
const take = (f, name, extra = {}) => acquireLease(name, { holder: 'agent-a', why: 'names proof', forMs: 60_000, env: f.env, log: () => {}, pollMs: 5, hostId: HOST_ID, ...extra });
const g = (length, char = 'a') => char.repeat(length);

test('SLUG is exactly the AD-28 rule, and isSlug adds the 1 to 32 length bound', () => {
  assert.equal(SLUG.source, '^[a-z0-9]+(-[a-z0-9]+)*$');
  assert.equal(SLUG.flags, '');
  assert.equal(SLUG_MAX, 32);
  assert.equal(NAME_MAX, 28);
  assert.ok(isSlug('pixel') && isSlug('a') && isSlug('a-b-9') && isSlug(g(32)));
  assert.ok(!isSlug('') && !isSlug(g(33)) && !isSlug('a--b') && !isSlug('-a') && !isSlug('a-') && !isSlug('Pixel') && !isSlug('a_b') && !isSlug(null) && !isSlug(7));
});

test('isQueued is decided by name alone: the v1a set, emulator-<n> and res-<slug>', () => {
  const cwdBefore = process.cwd();
  // no file is read: HUB_LOCK_DIR points nowhere and the answers hold
  process.env.HUB_LOCK_DIR = '/nonexistent/hub-locks';
  try {
    for (const name of ['adb', 's24', 'mac-ios', 'emulator', 'emulator-3', 'res-pixel', `res-${g(28)}-999`, `res-${g(32)}`]) assert.equal(isQueued(name), true, name);
    for (const name of ['s3-tolt', 's3-index', 'emulator-reaper', 'emulator-x', 'res-', 'res-Pixel', 'res-a--b', `res-${g(33)}`, 'pixel', 's26', 'adbx', '', null, undefined, 4]) assert.equal(isQueued(name), false, String(name));
  } finally { delete process.env.HUB_LOCK_DIR; hermetic(); }
  assert.equal(process.cwd(), cwdBefore);
  assert.deepEqual([...QUEUED], ['adb', 's24', 'mac-ios', 'emulator'], 'the v1a set keeps its four entries');
});

test('RESERVED is one frozen list holding every AC entry, and reservedBy returns the matching entry', () => {
  assert.ok(Object.isFrozen(RESERVED) && Array.isArray(RESERVED) && RESERVED.every(entry => typeof entry === 'string'));
  for (const entry of ['phone', 'emulator', 'adb', 's24', 's26', 'ipad', 'mac', 'mac-ios', 'ios-lane', 'emulator-reaper', 's3-*', 'emulator-<n>', 'registry', 'hub-api', 'host-agent', 'res-*', 'l-*', 'e-*', 'run-*', 'job:*']) {
    assert.ok(RESERVED.includes(entry), entry);
  }
  const matrix = { phone: 'phone', ipad: 'ipad', mac: 'mac', 's3-x': 's3-*', 'emulator-7': 'emulator-<n>', registry: 'registry', 'res-x': 'res-*', 'l-1': 'l-*', 'e-1': 'e-*', 'job:x': 'job:*', 'run-1-ab': 'run-*', 'emulator-reaper': 'emulator-reaper' };
  for (const [name, entry] of Object.entries(matrix)) assert.equal(reservedBy(name), entry, name);
  for (const name of ['pixel', 'pixel-7', 'emulator-x', 'macbook', 'phones', 'S24', '', null]) assert.equal(reservedBy(name), null, String(name));
});

test('nameRefusal: not a slug, over 28, or reserved and not seeded; a seeded Resource keeps its own word', () => {
  assert.equal(nameRefusal('pixel'), null);
  assert.equal(nameRefusal(g(28)), null);
  assert.match(nameRefusal(g(29)), /28/);
  assert.match(nameRefusal('Pixel'), /not a slug/);
  assert.match(nameRefusal('a--b'), /not a slug/);
  for (const word of ['phone', 'ipad', 'registry', 'adb', 's26', 'mac-ios', 'ios-lane', 'emulator', 'emulator-3', 's3-x', 'res-x']) assert.match(nameRefusal(word), /reserved/, word);
  assert.equal(nameRefusal('s24'), null, 's24 is reserved and seeded to itself');
});

test('parseDevices refuses an extra phone named after a reserved word, case-insensitively, and still loads the committed file', () => {
  const extra = name => JSON.stringify({ ...devices, android_extra: [{ name, model: 'SM-S928U', serial: 'R5CX31AEJDA' }] });
  assert.throws(() => parseDevices(extra('Ipad')), /android_extra\[\]\.name may not be "ipad"/);
  assert.throws(() => parseDevices(extra('Registry')), /android_extra\[\]\.name may not be "registry"/);
  assert.throws(() => parseDevices(extra('phone')), /may not be "phone"/);
  assert.throws(() => parseDevices(extra('Adb')), /may not be "adb"/);
  assert.throws(() => parseDevices(extra('Emulator')), /may not be "emulator"/);
  assert.doesNotThrow(() => parseDevices(extra('Emulator7')), 'emulator7 is no reserved shape (emulator-<n> has a dash)');
  assert.doesNotThrow(() => parseDevices(extra('Pixel')));
  assert.doesNotThrow(() => parseDevices(extra('S24')));
  assert.equal(parseDevices(devicesText).android_extra[0].name, 'S24');
});

test('fleetOf refuses a reserved extra phone with a plain Error (no code), and builds the committed fleet', () => {
  const extra = name => ({ ...devices, android_extra: [{ name, model: 'SM-S928U', serial: 'R5CX31AEJDA' }] });
  for (const name of ['Ipad', 'Registry', 'phone', 'Adb', 'S26', 'Emulator']) {
    assert.throws(() => fleetOf(extra(name)), error => error instanceof Error && error.code === undefined && /may not be/.test(error.message), name);
  }
  assert.deepEqual(fleetOf(devices).map(phone => [phone.device, phone.lock]), [['s24', 's24'], ['s26', 'adb']]);
  assert.deepEqual(fleetOf(extra('Pixel')).map(phone => phone.lock), ['pixel', 'adb']);
});

test('resourceOf is pure: a name-to-Resource map with no file read', () => {
  process.env.HUB_LOCK_DIR = '/nonexistent/hub-locks';
  try {
    assert.deepEqual(['adb', 's24', 'mac-ios', 'emulator', 'emulator-2', 'res-pixel'].map(resourceOf), ['s26', 's24', 'ios-lane', 'emulator', 'emulator', 'res-pixel']);
    assert.deepEqual([null, undefined, 's3-index', 'emulator-reaper', 'pixel', 'res-', 'res-A'].map(resourceOf), [null, null, null, null, null, null, null]);
  } finally { hermetic(); }
  assert.equal(EMULATOR_POOL, 'emulator');
  assert.ok(Object.isFrozen(SEED_RESOURCES));
});

test('the seed map, DEPLOY_TARGETS and RESERVED stay in line with devices.json', () => {
  const expected = {};
  const deploy = fleetOf(devices).find(phone => phone.deploy);
  expected[deploy.lock] = deploy.device;
  for (const entry of devices.android_extra ?? []) expected[entry.name.toLowerCase()] = entry.name.toLowerCase();
  expected['mac-ios'] = 'ios-lane';
  assert.deepEqual({ ...SEED_RESOURCES }, expected);
  assert.deepEqual([...DEPLOY_TARGETS], [deploy.lock, 'mac-ios']);
  for (const lock of Object.keys(SEED_RESOURCES)) assert.equal(isQueued(lock), true, `${lock} is Queued`);
  for (const word of [...Object.keys(SEED_RESOURCES), ...Object.values(SEED_RESOURCES)]) assert.notEqual(reservedBy(word), null, `${word} is reserved`);
  for (const lock of DEPLOY_TARGETS) assert.ok(Object.hasOwn(SEED_RESOURCES, lock), `${lock} is seeded`);
});

test('a hold event on a Queued lock carries resource; a Pool-level event carries null', async () => {
  const f = fixture();
  try {
    const expected = { adb: 's26', s24: 's24', 'mac-ios': 'ios-lane', 'emulator-2': 'emulator', 'res-pixel': 'res-pixel' };
    for (const [lock, resource] of Object.entries(expected)) {
      const record = await take(f, lock, { waitMs: 5000 });
      assert.equal(releaseLease(lock, record.lease_id, { env: f.env, hostId: HOST_ID }).released, true);
      const mine = events(f).filter(event => event.lock === lock);
      assert.deepEqual(mine.map(event => event.event), ['request', 'acquire', 'release'], lock);
      assert.ok(mine.every(event => event.resource === resource), `${lock} -> ${resource}`);
    }
    const pool = poolRequest('phone', { holder: 'agent-a', why: 'names proof', env: f.env, hostId: HOST_ID });
    pool.settle(null);
    const poolEvents = events(f).filter(event => event.pool === 'phone' && event.lock === null);
    assert.ok(poolEvents.length >= 1);
    assert.ok(poolEvents.every(event => event.resource === null));
  } finally { f.cleanup(); }
});

test('a res-<slug> Lease queues: a waiter takes a ticket in res-pixel.queue and request, acquire, release are written', async () => {
  const f = fixture();
  try {
    const first = await take(f, 'res-pixel', { id: 'first-1', waitMs: 5000 });
    let waiterRecord;
    const waiting = take(f, 'res-pixel', { id: 'second-1', waitMs: 10_000 }).then(record => { waiterRecord = record; return record; });
    for (let i = 0; i < 200 && !(existsSync(join(f.env.HUB_LOCK_DIR, 'res-pixel.queue')) && readdirSync(join(f.env.HUB_LOCK_DIR, 'res-pixel.queue')).length > 0); i += 1) await new Promise(done => setTimeout(done, 10));
    const tickets = readdirSync(join(f.env.HUB_LOCK_DIR, 'res-pixel.queue'));
    assert.equal(tickets.length, 1, 'the waiter holds a place in res-pixel.queue');
    assert.deepEqual(queueView('res-pixel', { env: f.env }).map(entry => entry.lease_id), ['second-1']);
    assert.equal(releaseLease('res-pixel', first.lease_id, { env: f.env, hostId: HOST_ID }).released, true);
    await waiting;
    assert.equal(waiterRecord.lease_id, 'second-1');
    assert.equal(releaseLease('res-pixel', 'second-1', { env: f.env, hostId: HOST_ID }).released, true);
    const log = events(f).filter(event => event.lock === 'res-pixel');
    assert.deepEqual(log.map(event => `${event.event}:${event.lease_id}`), ['request:first-1', 'acquire:first-1', 'request:second-1', 'release:first-1', 'acquire:second-1', 'release:second-1']);
    assert.ok(log.every(event => event.resource === 'res-pixel'));
  } finally { f.cleanup(); }
});

// ---- a v1.2.46 reader ignores `resource` ----

const V1246_KEYS = ['event', 'lock', 'hold_kind', 'claimant', 'lease_id', 'for_ms', 'expires_at', 'deadline_at', 'waited_ms', 'held_ms', 'reason', 'last_alive_at'];
const ENVELOPE = ['format', 'ts', 'host', 'host_id', 'hub_version'];

test('a current hold event is the v1.2.46 body plus resource and nothing else', async () => {
  const f = fixture();
  try {
    const record = await take(f, 'adb');
    releaseLease('adb', record.lease_id, { env: f.env, hostId: HOST_ID });
    const release = events(f).find(event => event.event === 'release');
    assert.deepEqual(Object.keys(release).filter(key => !ENVELOPE.includes(key)).sort(), [...V1246_KEYS, 'resource'].sort());
    assert.equal(Object.keys(release).filter(key => ENVELOPE.includes(key)).length, ENVELOPE.length);
  } finally { f.cleanup(); }
});

function v1246World(withResource) {
  const root = mkdtempSync(join(tmpdir(), 'hub-names-v1246-'));
  const env = { HUB_LOCK_DIR: join(root, 'locks'), HUB_EVENT_DIR: join(root, 'events') };
  const NOW = Date.parse('2026-11-23T12:00:00Z');
  const extra = withResource ? { resource: 's26' } : {};
  mkdirSync(env.HUB_EVENT_DIR, { recursive: true });
  const claimant = { kind: 'agent', holder: 'agent-a', repo: null, run: null, attempt: null, job: null };
  const line = (ts, event, fields) => JSON.stringify({ format: 1, ts, host: 'big-chungus', host_id: 'abc', hub_version: 'v1.2.46', event, lock: 'adb', ...extra, hold_kind: 'lease', claimant, lease_id: 'l-old', for_ms: 3_600_000, expires_at: '2026-11-23T13:00:00.000Z', deadline_at: null, waited_ms: null, held_ms: null, reason: null, last_alive_at: null, ...fields });
  writeFileSync(join(env.HUB_EVENT_DIR, '2026-11.jsonl'), [
    line('2026-11-23T11:00:00.000Z', 'acquire', { waited_ms: 0 }),
    line('2026-11-23T11:30:00.000Z', 'release', { held_ms: 1_800_000, reason: 'by-id' }),
    line('2026-11-23T11:40:00.000Z', 'acquire', { lease_id: 'l-live', waited_ms: 0 }),
  ].join('\n') + '\n');
  const lock = join(env.HUB_LOCK_DIR, 'adb.lock');
  mkdirSync(lock, { recursive: true });
  writeFileSync(join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, host: hostname(), repo: null, run: null, started_at: '2026-11-23T11:40:00.000Z', format: 1, kind: 'lease', lease_id: 'l-live', holder: 'agent-a', why: 'old', expires_at: '2026-11-23T13:00:00.000Z', ...extra }));
  utimesSync(lock, NOW / 1000, NOW / 1000);
  return { env, NOW, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('readEvents, leaseHoldersSince, listLocks and liveLease give the same results with or without resource on a v1.2.46-shape record', () => {
  const plain = v1246World(false);
  const tagged = v1246World(true);
  try {
    const strip = ({ resource, ...rest }) => rest;
    const read = world => ({
      events: [...readEvents({ env: world.env })].map(strip),
      holders: leaseHoldersSince('adb', '2026-11-23T11:35:00Z', { env: world.env, log: () => {} }),
      locks: listLocks({ env: world.env, now: () => world.NOW }).map(entry => ({ ...entry, owner: strip(entry.owner) })),
      live: strip(liveLease('adb', { env: world.env, now: () => world.NOW })),
    });
    const a = read(plain);
    const b = read(tagged);
    assert.deepEqual(b, a);
    assert.equal(a.events.length, 3);
    assert.ok(a.locks.length === 1 && a.locks[0].kind === 'lease' && a.locks[0].stale === false);
    assert.equal(a.live.lease_id, 'l-live');
    assert.deepEqual(a.holders.map(hold => hold.lease_id), ['l-live']);
    assert.ok([...readEvents({ env: tagged.env })].every(event => event.resource === 's26'), 'the tagged world really carries resource');
  } finally { plain.cleanup(); tagged.cleanup(); }
});
