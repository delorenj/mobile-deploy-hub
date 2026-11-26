// Story 8.1: `GET /status` through handle(), hermetic: a temp lock and event dir, a fake adb wire, an injected inventory, host key, clock
// and QA list. No port is bound and no real adb server (5037), QA file or host key is reached.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDevices } from '../ci/lib/devices.mjs';
import { appendEvent } from '../ci/lib/events.mjs';
import { acquireLease, buildTicket, reserve, updateLease } from '../ci/lib/lock.mjs';
import { loadPolicy } from '../ci/lib/policy.mjs';
import { hermetic } from '../ci/test-fixtures.mjs';
import * as claims from '../device/claims.mjs';
import { fakeWire } from '../device/wire-fixtures.mjs';
import { dedicatedQaIds, seed } from '../registry/seed.mjs';
import { applySeed } from '../registry/store.mjs';
import { CONTRACT_VERSION, ROUTES, handle, statusDocument } from './routes.mjs';

hermetic();

const S24 = 'R5CX31AEJDA';
const S26 = 'R5GL43A7PCH';
const PIXEL = 'QAPIXEL7777';
const usbId = serial => `adb-${serial}-zz._adb-tls-connect._tcp`;
const listed = [{ id: usbId(S24), state: 'device', model: 'SM_S928U' }, { id: usbId(S26), state: 'device', model: 'SM_S948U' }];
const serverUp = () => ({ adb_servers: [{ port: 5037, pid: 4242, cwd: null }], emulators: [], xvfb: [] });
const qa = [{ name: 'S24', serial: S24, allowed_users: [0, 10] }, { name: 'Pixel-QA', model: 'Pixel 7', serial: PIXEL, allowed_users: [0] }];
const T0 = Date.parse('2026-11-25T10:00:00Z');
const iso = ms => new Date(ms).toISOString();
const policy = loadPolicy().policy;

function scratch({ qaList = [], settings = policy, hostKey = () => 'linux' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'hub-api-status-'));
  const env = { PATH: process.env.PATH, HOME: root, HUB_LOCK_DIR: join(root, 'locks'), HUB_EVENT_DIR: join(root, 'events'), HUB_ADB_SERVER_PORT: '5037' };
  const clock = { t: T0 };
  const now = () => clock.t;
  const wire = fakeWire({ listed });
  const ctx = (more = {}) => ({ env, policy: settings, routes: ROUTES, now, hostId: 'test-host', devices: structuredClone(loadDevices({})), qaDevices: () => qaList, hostKey, inventory: serverUp, adbWire: wire, sleep: () => Promise.resolve(), log: { out: () => {}, err: () => {} }, ...more });
  return {
    root, env, clock, ctx, wire,
    get: more => handle({ method: 'GET', url: '/status' }, ctx(more)),
    hold: (lock, id, extra = {}) => acquireLease(lock, { holder: 'agent-a', why: 'device proof', forMs: 3_600_000, id, env, log: () => {}, now, ...extra }),
    ticket: (lock, name, fields) => {
      mkdirSync(join(env.HUB_LOCK_DIR, `${lock}.queue`), { recursive: true });
      writeFileSync(join(env.HUB_LOCK_DIR, `${lock}.queue`, `${String(T0).padStart(15, '0')}-${name}.json`), JSON.stringify(buildTicket('lease', { env, requested: T0, holder: 'waiter', why: 'queued', expires_at: iso(T0 + 3_600_000), ...fields })));
    },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

// Every key path and string value of a body, so a serial can be looked for in both.
function walk(value, path = [], out = { keys: [], strings: [] }) {
  if (typeof value === 'string') out.strings.push(value);
  else if (Array.isArray(value)) value.forEach(item => walk(item, path, out));
  else if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) { out.keys.push(key); walk(child, [...path, key], out); }
  }
  return out;
}

test('the route is GET /status with the Status shape, and the document has exactly the contract keys', async () => {
  const route = ROUTES.find(candidate => candidate.method === 'GET' && candidate.path === '/status');
  assert.equal(route.shape, 'Status');
  assert.equal(route.handler, statusDocument);
  const s = scratch();
  try {
    const answer = await s.get();
    assert.equal(answer.status, 200);
    assert.equal(answer.headers['Cache-Control'], 'no-store');
    assert.deepEqual(Object.keys(answer.body), ['format', 'contract', 'hosts', 'registry', 'stale', 'checked_at']);
    assert.equal(answer.body.format, 1);
    assert.equal(answer.body.contract, CONTRACT_VERSION);
    assert.deepEqual(answer.body.stale, {});
    assert.equal(answer.body.checked_at, iso(T0));
    assert.deepEqual(Object.keys(answer.body.hosts), ['linux']);
    assert.deepEqual(Object.keys(answer.body.registry), ['rev', 'source', 'resources']);
  } finally { s.cleanup(); }
});

test('happy path: hosts.linux deep-equals statusView from the same seams, the Pool request is listed once, and Registry fields appear only under registry', async () => {
  const s = scratch();
  try {
    await s.hold('adb', 'held');
    reserve('adb', { env: { ...s.env, GITHUB_REPOSITORY: 'acme/app', GITHUB_RUN_ID: '78' }, now: () => T0, policy, log: () => {} });
    s.ticket('adb', '000001-00000001', { lease_id: 'w-lease' });
    s.ticket('adb', '000002-00000002', { lease_id: 'w-pool', request: 'req-1', pool: 'phone' });
    s.ticket('s24', '000001-00000003', { lease_id: 'w-pool-s24', request: 'req-1', pool: 'phone' });
    mkdirSync(join(s.env.HUB_LOCK_DIR, 'emulators'), { recursive: true });
    writeFileSync(join(s.env.HUB_LOCK_DIR, 'emulators', 'e-aaaaaaaaaaaa.json'), JSON.stringify({ lease_id: 'e-aaaaaaaaaaaa', slot: 'emulator-1', profile: 'default', serial: 'emulator-5554', console_port: 5554, adb_server_port: 15170, avd: { name: 'hub-a' }, created_at: iso(T0), pids: [] }));
    const answer = await s.get();
    assert.equal(answer.status, 200);
    const ctx = claims.createContext({ env: s.env, now: () => T0, sleep: () => Promise.resolve(), adbWire: s.wire, inventory: serverUp, policy, fleet: claims.loadFleet(s.env, { warn: () => {} }) });
    const expected = await claims.statusView('linux', { audience: 'service', qa_ids: dedicatedQaIds(seed(loadDevices({}), { qaDevices: () => [] })) }, ctx);
    assert.deepEqual(answer.body.hosts.linux, JSON.parse(JSON.stringify(expected)));
    const view = answer.body.hosts.linux;
    assert.equal(view.waiters.length, 2, 'one lease waiter and one Pool request');
    assert.ok(view.waiters.some(waiter => waiter.lease_id === 'w-lease'));
    const pooled = view.waiters.filter(waiter => waiter.request === 'req-1');
    assert.equal(pooled.length, 1, 'a waiting Pool request is listed once');
    assert.deepEqual([pooled[0].pool, pooled[0].positions], ['phone', { adb: 2, s24: 1 }]);
    assert.deepEqual(view.reservations.map(entry => entry.run_key), ['acme--app--78']);
    assert.deepEqual(view.emulators.map(entry => entry.slot), ['emulator-1']);
    assert.deepEqual(view.locks.map(lock => [lock.lock, lock.resource, lock.deploy_target]), [['adb', 's26', true]], 'deploy targets are visibly marked');
    // Registry fields are only under `registry`: no row of a view has a name, Capability or visibility of the Registry.
    const { keys } = walk(view);
    for (const key of ['capabilities', 'visibility', 'seeded', 'seed_missing', 'retired_at', 'identity']) assert.ok(!keys.includes(key), `${key} is not in a host view`);
    const resources = answer.body.registry.resources;
    assert.deepEqual(resources.map(resource => resource.id), ['s24', 's26', 'ios-lane', 'emulator']);
    for (const resource of resources) assert.ok(!('reachability' in resource), 'registry.resources has no reachability');
    const listed = (await handle({ method: 'GET', url: '/resources' }, s.ctx())).body;
    assert.deepEqual(resources, listed.resources.map(({ reachability, ...rest }) => rest), 'the same served Resources as /resources');
    assert.deepEqual([answer.body.registry.rev, answer.body.registry.source], [listed.rev, listed.source]);
  } finally { s.cleanup(); }
});

test('QA redaction: no key path or string value of /status carries a dedicated_qa serial, and the keys stay', async () => {
  const s = scratch({ qaList: qa });
  try {
    await s.hold('s24', 'qa-held');
    updateLease('s24', 'qa-held', { device: { phone: 's24', serial: S24, adb_id: usbId(S24), adb_port: 5037 } }, { env: s.env });
    for (const phase of ['seed', 'file']) {
      if (phase === 'file') await applySeed({ env: s.env, devices: structuredClone(loadDevices({})), qaDevices: () => qa, now: () => T0, hostId: 'test-host', log: () => {} });
      const answer = await s.get();
      assert.equal(answer.status, 200);
      const { keys, strings } = walk(answer.body);
      for (const serial of [S24, PIXEL]) {
        assert.ok(!keys.some(key => key.includes(serial)), `${phase}: no key path has ${serial}`);
        assert.ok(!strings.some(text => text.includes(serial)), `${phase}: no string has ${serial}`);
        assert.equal(JSON.stringify(answer.body).includes(serial), false, `${phase}: ${serial}`);
      }
      const view = answer.body.hosts.linux;
      const row = view.phones.find(phone => phone.device === 's24');
      assert.deepEqual([row.serial, row.adb_id, row.held, row.holder], [null, null, 'lease', 'agent-a'], 'the keys stay, their values are null');
      const lock = view.locks.find(entry => entry.lock === 's24');
      assert.deepEqual(lock.phone, { phone: 's24', serial: null, adb_id: null, adb_port: 5037 });
      // A phone that is not dedicated keeps its serial.
      assert.equal(view.phones.find(phone => phone.device === 's26').serial, S26);
      const identities = Object.fromEntries(answer.body.registry.resources.map(resource => [resource.id, resource.identity]));
      assert.deepEqual(identities.s24, { serial: null, model: 'SM-S928U' });
      assert.deepEqual(identities['res-pixel-qa'], { serial: null, model: 'Pixel 7' });
      assert.equal(JSON.stringify(answer.body).includes('allowed_users'), false);
    }
  } finally { s.cleanup(); }
});

test('time alone changes the answer: a Lease past its expiry reads stale with no expected_end, no file touched', async () => {
  const s = scratch();
  try {
    await s.hold('adb', 'short', { forMs: 60_000 });
    const first = (await s.get()).body;
    const before = first.hosts.linux.locks.find(entry => entry.lock === 'adb');
    assert.deepEqual([before.stale, before.expected_end], [false, before.expires_at]);
    assert.equal(first.checked_at, iso(T0));
    s.clock.t = T0 + 61_000;
    const second = (await s.get()).body;
    const after = second.hosts.linux.locks.find(entry => entry.lock === 'adb');
    assert.deepEqual([after.stale, after.expected_end, after.lease_id], [true, null, 'short']);
    assert.equal(second.checked_at, iso(T0 + 61_000));
  } finally { s.cleanup(); }
});

test('expected_end: before expires_at with a history of agent Leases that used half their time, equal to it with none, null when the ETA throws', async () => {
  const low = { ...policy, queue: { ...policy.queue, eta_low_data_min_holds: 1 } };
  const s = scratch({ settings: low });
  try {
    await s.hold('adb', 'held');
    const none = (await s.get()).body.hosts.linux.locks[0];
    assert.equal(none.expected_end, none.expires_at, 'no history: never later than the stated end');
    appendEvent({ event: 'release', hold_kind: 'lease', held_ms: 1_800_000, for_ms: 3_600_000, claimant: { kind: 'agent' } }, { env: s.env, now: () => T0 - 60_000, log: () => {} });
    const some = (await s.get()).body.hosts.linux.locks[0];
    assert.ok(Date.parse(some.expected_end) < Date.parse(some.expires_at), `${some.expected_end} < ${some.expires_at}`);
    assert.ok(Date.parse(some.expected_end) >= T0);
    const broken = (await s.get({ policy: { ...low, queue: {} } })).body.hosts.linux.locks[0];
    assert.equal(broken.expected_end, null, 'a broken policy leaves the end unknown and the answer whole');
  } finally { s.cleanup(); }
});

test('an unknown host is 503 HUB_HOST_UNKNOWN host-unknown, and any other host key failure is a 500', async () => {
  const s = scratch();
  try {
    const unknown = await s.get({ hostKey: () => { throw Object.assign(new Error('this host does not know which host it is: cannot read /x'), { code: 'HUB_HOST_UNKNOWN' }); } });
    assert.equal(unknown.status, 503);
    assert.deepEqual([unknown.body.code, unknown.body.reason, unknown.body.exit], ['HUB_HOST_UNKNOWN', 'host-unknown', 1]);
    assert.equal(unknown.headers['Content-Type'], 'application/problem+json');
    const broken = await s.get({ hostKey: () => { throw new Error('boom'); } });
    assert.equal(broken.status, 500);
  } finally { s.cleanup(); }
});

test('the status builder is the library\'s: routes.mjs imports neither eta.mjs nor queueView, and nothing is cached', () => {
  const source = readFileSync(fileURLToPath(new URL('./routes.mjs', import.meta.url)), 'utf8');
  assert.doesNotMatch(source, /from '[^']*eta\.mjs'/);
  assert.doesNotMatch(source, /\bqueueView\b/);
  const body = source.slice(source.indexOf('export async function statusDocument'), source.indexOf('// POST /registry/resources: registers'));
  assert.ok(body.length > 200);
  assert.doesNotMatch(body, /setInterval|setTimeout|new Map\(\)|let cached/);
});

test('a read leaves the lock dir alone: it writes nothing', async () => {
  const s = scratch();
  try {
    await s.hold('adb', 'held');
    const names = () => readdirSync(s.env.HUB_LOCK_DIR).sort();
    const before = names();
    await s.get();
    await s.get();
    assert.deepEqual(names(), before);
  } finally { s.cleanup(); }
});
