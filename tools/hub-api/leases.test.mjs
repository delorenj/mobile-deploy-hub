// Story 7.1: POST /leases through handle(), on a temp lock and event dir. No port is bound, no adb, emulator or real socket is touched:
// the service's cached readings are a fake, and the CLI parity run uses fake inventory and wire seams.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadDevices } from '../ci/lib/devices.mjs';
import { readEvents } from '../ci/lib/events.mjs';
import { loadPolicy } from '../ci/lib/policy.mjs';
import { readOwner } from '../ci/lib/lock.mjs';
import { hermetic } from '../ci/test-fixtures.mjs';
import { EXIT_CODES, HTTP_ANSWERS, checkLeaseBody, httpAnswerOf, withoutDeployIdentity } from '../device/claims.mjs';
import { main as hubDevice } from '../device/hub-device.mjs';
import { fakeWire } from '../device/wire-fixtures.mjs';
import { applySeed, readRegistry, writeRegistry } from '../registry/store.mjs';
import { ROUTES, handle, problem } from './routes.mjs';
import { requestListener, startHubApi } from './server.mjs';

hermetic();

const HOST = 'test-host';
const policy = loadPolicy().policy;
const NOW = () => Date.parse('2026-11-25T10:00:00Z');
const MIN = 60_000;
const RETIRED = '2026-11-25T09:00:00.000Z';
const BODY = { resource: 's24', for_ms: 30 * MIN, holder: 'agent-a', why: 'proof' };

function scratch() {
  const root = mkdtempSync(join(tmpdir(), 'hub-api-leases-'));
  const env = { PATH: process.env.PATH, HOME: root, HUB_LOCK_DIR: join(root, 'locks'), HUB_EVENT_DIR: join(root, 'events') };
  const devices = structuredClone(loadDevices({}));
  const out = [];
  const err = [];
  const s = {
    root, env, devices, out, err,
    ctx: (more = {}) => ({ env, policy, routes: ROUTES, now: NOW, hostId: HOST, devices, qaDevices: () => [], log: { out: line => out.push(line), err: line => err.push(line) }, ...more }),
    post: (body, more) => handle({ method: 'POST', url: '/leases', body }, s.ctx(more)),
    events: () => [...readEvents({ env })].filter(event => event.claimant !== undefined),
    owner: lock => readOwner(join(env.HUB_LOCK_DIR, `${lock}.lock`)),
    // The cache of a service: the states it knows, by Resource id.
    readings: states => ({ read: records => new Map(records.map(record => [record.id, { state: states[record.id] ?? 'unknown' }])) }),
    edit: async change => {
      await applySeed({ env, devices, qaDevices: () => [], now: NOW, hostId: HOST, log: () => {} });
      const { rev, resources, pools } = readRegistry({ env, devices, qaDevices: () => [] });
      return writeRegistry({ env, if_rev: rev, resources: change(structuredClone(resources)), pools: Object.entries(pools).map(([name, rest]) => ({ name, ...rest })), hostId: HOST, log: () => {} });
    },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
  return s;
}

const problemOf = answer => [answer.status, answer.body.code, answer.body.exit, answer.body.reason];
const acquires = s => s.events().filter(event => event.event === 'acquire');

test('a word lease on a free s24: 200 Lease, a lock-only owner record, one acquire event with the api actor', async () => {
  const s = scratch();
  try {
    const answer = await s.post({ ...BODY, id: 'api-1' });
    assert.equal(answer.status, 200);
    assert.equal(answer.headers['Cache-Control'], 'no-store');
    assert.deepEqual(Object.keys(answer.body).sort(), ['claimant_kind', 'device', 'emulator', 'env', 'expires_at', 'holder', 'lease_id', 'lock', 'resource', 'started_at', 'why']);
    assert.deepEqual([answer.body.lease_id, answer.body.resource, answer.body.lock, answer.body.device, answer.body.holder, answer.body.why, answer.body.claimant_kind], ['api-1', 's24', 's24', 's24', 'agent-a', 'proof', 'agent']);
    assert.equal(answer.body.expires_at, new Date(NOW() + 30 * MIN).toISOString());
    assert.deepEqual(Object.keys(answer.body.env).sort(), ['ANDROID_ADB_SERVER_PORT', 'HUB_DEVICE', 'HUB_LEASE_ID']);
    assert.equal(answer.body.emulator, null, 'a phone Lease has no emulator');
    const record = s.owner('s24');
    assert.equal(record.holder_pid, null);
    assert.equal(record.holder_process_start, null);
    assert.equal(record.claimant_kind, 'agent');
    assert.equal(record.device, undefined, 'no device, so no adb_id');
    assert.equal(record.repo, null);
    const [acquire, ...rest] = s.events();
    assert.deepEqual(rest, []);
    assert.deepEqual([acquire.event, acquire.lock, acquire.lease_id, acquire.claimant.kind, acquire.claimant.holder, acquire.actor], ['acquire', 's24', 'api-1', 'agent', 'agent-a', { holder: 'agent-a', via: 'api' }]);
    assert.ok(s.out.some(line => /^HUB_LEASE s24 api-1 until /.test(line)), 'the library line goes to the service log');
  } finally { s.cleanup(); }
});

test('a given actor is recorded exactly as given, and the lease id is minted when none is named', async () => {
  const s = scratch();
  try {
    const actor = { holder: 'holocene', via: 'control-surface' };
    const answer = await s.post({ ...BODY, actor });
    assert.equal(answer.status, 200);
    assert.match(answer.body.lease_id, /^l-[0-9a-f]{12}$/);
    assert.deepEqual(acquires(s)[0].actor, actor);
  } finally { s.cleanup(); }
});

test('a word lease, then the phone Pool word takes the other phone; over 60 min the Pool narrows to the S24', async () => {
  const s = scratch();
  try {
    const word = await s.post({ ...BODY, resource: 's24' });
    assert.equal(word.status, 200);
    // The S24 is held now: the phone Pool takes the S26 (lock adb) for 30 min, but a 2 h request has only the S24 to try.
    const pool = await s.post({ ...BODY, resource: 'phone', holder: 'agent-b' });
    assert.equal(pool.status, 200);
    assert.deepEqual([pool.body.device, pool.body.lock, pool.body.resource], ['s26', 'adb', 's26']);
    assert.equal(s.owner('adb').claimant_kind, 'agent');
    const long = await s.post({ ...BODY, resource: 'phone', for_ms: 120 * MIN, holder: 'agent-c' });
    assert.deepEqual(problemOf(long), [409, 'HUB_LOCK_TIMEOUT', 76, 'busy']);
    assert.match(long.body.detail, /s24/);
    assert.equal(s.owner('adb').holder, 'agent-b', 'the deploy phone was never tried for 2 h');
  } finally { s.cleanup(); }
});

test('the Pool path records claimant_kind and actor: a match with a given actor, the phone word with the default one', async () => {
  const s = scratch();
  try {
    const actor = { holder: 'holocene', via: 'control-surface' };
    const matched = await s.post({ match: 'kind=phone', for_ms: 30 * MIN, holder: 'agent-a', why: 'proof', claimant_kind: 'person', actor }, { readings: s.readings({}) });
    assert.equal(matched.status, 200, JSON.stringify(matched.body));
    assert.equal(s.owner(matched.body.lock).claimant_kind, 'person');
    const acquire = acquires(s).find(event => event.lock === matched.body.lock);
    assert.deepEqual([acquire.claimant.kind, acquire.actor], ['person', actor]);
  } finally { s.cleanup(); }
  const t = scratch();
  try {
    const word = await t.post({ resource: 'phone', for_ms: 30 * MIN, holder: 'agent-b', why: 'proof', claimant_kind: 'person' });
    assert.equal(word.status, 200, JSON.stringify(word.body));
    assert.equal(t.owner(word.body.lock).claimant_kind, 'person');
    const acquire = acquires(t).find(event => event.lock === word.body.lock);
    assert.deepEqual([acquire.claimant.kind, acquire.actor], ['person', { holder: 'agent-b', via: 'api' }]);
  } finally { t.cleanup(); }
});

test('a Resource id (res-<name>) leases a registered phone', async () => {
  const s = scratch();
  try {
    await s.edit(resources => [...resources, { ...resources.find(record => record.id === 's24'), id: 'res-pixel', lock: 'res-pixel', name: 'pixel', display_name: 'pixel', words: [], seeded: false, created_at: RETIRED, identity: { serial: 'PX9', model: 'Pixel 9' } }]);
    const answer = await s.post({ ...BODY, resource: 'res-pixel' });
    assert.equal(answer.status, 200, JSON.stringify(answer.body));
    assert.deepEqual([answer.body.lock, answer.body.resource, answer.body.device], ['res-pixel', 'res-pixel', 'pixel']);
  } finally { s.cleanup(); }
});

test('match: the first member that is not known away takes it; every member away is 503 HUB_DEVICE_AWAY', async () => {
  const s = scratch();
  try {
    const first = await s.post({ match: 'kind=phone', for_ms: 30 * MIN, holder: 'agent-a', why: 'proof' }, { readings: s.readings({}) });
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.equal(first.body.device, 's24', 'no reading drops nothing: the first member');
    assert.equal(s.owner('s24').holder_pid, null);
    assert.equal(acquires(s).length, 1);
  } finally { s.cleanup(); }
  for (const gone of ['absent', 'offline', 'unauthorized']) {
    const t = scratch();
    try {
      const dropped = await t.post({ match: 'kind=phone', for_ms: 30 * MIN, holder: 'agent-a', why: 'proof' }, { readings: t.readings({ s24: gone }) });
      assert.equal(dropped.status, 200, gone);
      assert.equal(dropped.body.device, 's26', `${gone}: the S24 is dropped`);
    } finally { t.cleanup(); }
  }
  const u = scratch();
  try {
    const none = await u.post({ match: 'kind=phone', for_ms: 30 * MIN, holder: 'agent-a', why: 'proof' }, { readings: u.readings({ s24: 'absent', s26: 'offline' }) });
    assert.deepEqual(problemOf(none), [503, 'HUB_DEVICE_AWAY', 75, 'away']);
    assert.match(none.body.detail, /s24 absent, s26 offline/);
    assert.deepEqual(u.events(), [], 'nothing is written');
    assert.equal(u.owner('s24'), null);
    // The word is never away: it is `hub-device lease <word> --no-connect`.
    const word = await u.post(BODY, { readings: u.readings({ s24: 'absent' }) });
    assert.equal(word.status, 200);
  } finally { u.cleanup(); }
});

test('person: the owner record and the acquire event say person, and a later release keeps the kind', async () => {
  const s = scratch();
  try {
    const answer = await s.post({ ...BODY, id: 'who-1', claimant_kind: 'person' });
    assert.equal(answer.status, 200);
    assert.equal(answer.body.claimant_kind, 'person');
    assert.equal(s.owner('s24').claimant_kind, 'person');
    assert.equal(acquires(s)[0].claimant.kind, 'person');
    const { releaseLease } = await import('../ci/lib/lock.mjs');
    assert.equal(releaseLease('s24', 'who-1', { env: s.env }).released, true);
    const release = s.events().find(event => event.event === 'release');
    assert.equal(release.claimant.kind, 'person');
    const bad = await s.post({ ...BODY, claimant_kind: 'robot' });
    assert.deepEqual(problemOf(bad), [400, 'HUB_USAGE', 2, 'bad-claimant-kind']);
  } finally { s.cleanup(); }
});

test('busy: 409 HUB_LOCK_TIMEOUT, exit 76, reason busy, the library detail, and no event', async () => {
  const s = scratch();
  try {
    assert.equal((await s.post(BODY)).status, 200);
    const before = s.events().length;
    const busy = await s.post({ ...BODY, holder: 'agent-b' });
    assert.deepEqual(problemOf(busy), [409, 'HUB_LOCK_TIMEOUT', 76, 'busy']);
    assert.match(busy.body.detail, /^host lock s24 is held by lease /);
    assert.equal(busy.headers['Content-Type'], 'application/problem+json');
    assert.equal(s.events().length, before, 'a refused try records nothing');
    assert.equal(s.err.length, 0, 'a library refusal is no HUB_API_ERROR');
  } finally { s.cleanup(); }
});

test('retired and seed-missing: 409 HUB_RESOURCE_RETIRED, exit 2, the reason, nothing written', async () => {
  const s = scratch();
  try {
    await s.edit(resources => resources.map(record => (record.id === 's24' ? { ...record, retired_at: RETIRED } : record.id === 's26' ? { ...record, seed_missing: true } : record)));
    const before = s.events().length;
    assert.deepEqual(problemOf(await s.post(BODY)), [409, 'HUB_RESOURCE_RETIRED', 2, 'retired']);
    assert.deepEqual(problemOf(await s.post({ ...BODY, resource: 's26' })), [409, 'HUB_RESOURCE_RETIRED', 2, 'seed-missing']);
    assert.equal(s.events().length, before);
    assert.equal(s.owner('s24'), null);
  } finally { s.cleanup(); }
});

test('a match nothing can serve: 404 HUB_NO_MATCH, exit 2, reason no-match, the exclusions in detail', async () => {
  const s = scratch();
  try {
    const none = await s.post({ match: 'api_level>=34', for_ms: 30 * MIN, holder: 'agent-a', why: 'proof' });
    assert.deepEqual(problemOf(none), [404, 'HUB_NO_MATCH', 2, 'no-match']);
    assert.match(none.body.detail, /^no Resource matches: s24 has no api_level/);
    assert.deepEqual(s.events(), []);
  } finally { s.cleanup(); }
});

test('over a cap: 400 HUB_USAGE naming the cap, and nothing is written', async () => {
  const s = scratch();
  try {
    const deploy = await s.post({ ...BODY, resource: 's26', for_ms: 61 * MIN });
    assert.deepEqual([deploy.status, deploy.body.code, deploy.body.exit], [400, 'HUB_USAGE', 2]);
    assert.match(deploy.body.detail, /^for_ms 3660000: a lease on adb runs at most 60 min in total .*lease s24 or an emulator for longer$/);
    const long = await s.post({ ...BODY, for_ms: 49 * 60 * MIN });
    assert.deepEqual([long.status, long.body.code], [400, 'HUB_USAGE']);
    assert.match(long.body.detail, /^for_ms must be more than 0 and at most 48h$/);
    assert.ok(!long.body.detail.includes('lease s24 or an emulator'), 'the 48 h refusal does not point to the S24');
    const pool = await s.post({ ...BODY, resource: 'phone', for_ms: 49 * 60 * MIN });
    assert.equal(pool.status, 400);
    assert.deepEqual(s.events(), []);
    assert.equal(s.owner('s24'), null);
    assert.equal(s.owner('adb'), null);
  } finally { s.cleanup(); }
});

test('a bad body is 400 HUB_USAGE with its reason, before anything is read', async () => {
  const s = scratch();
  try {
    const cases = [
      ['bad-body', undefined], ['bad-body', null], ['bad-body', []], ['bad-body', 'x'],
      ['bad-body', { ...BODY, extra: 1 }], ['bad-body', { ...BODY, waitMs: 5000 }],
      ['bad-target', { for_ms: BODY.for_ms, holder: 'h', why: 'w' }], ['bad-target', { ...BODY, match: 'kind=phone' }], ['bad-target', { ...BODY, resource: '' }], ['bad-target', { ...BODY, resource: 7 }],
      ['bad-for', { ...BODY, for_ms: 0 }], ['bad-for', { ...BODY, for_ms: '60000' }], ['bad-for', { ...BODY, for_ms: 1.5 }], ['bad-for', { ...BODY, for_ms: undefined }],
      ['bad-wait', { ...BODY, wait_ms: -1 }], ['bad-wait', { ...BODY, wait_ms: '5000' }], ['bad-wait', { ...BODY, wait_ms: 1.5 }], ['bad-wait', { ...BODY, wait_ms: null }],
      ['bad-id', { ...BODY, id: 'Bad Id' }], ['bad-id', { ...BODY, id: 7 }], ['bad-id', { ...BODY, id: 'Bad Id', wait_ms: 5000 }],
      ['no-id', { ...BODY, wait_ms: 5000 }],
      ['bad-actor', { ...BODY, actor: 'jarad' }], ['bad-actor', { ...BODY, actor: { holder: 'h', via: 'smoke-signal' } }], ['bad-actor', { ...BODY, actor: null }],
      ['no-holder', { ...BODY, holder: undefined }], ['no-holder', { ...BODY, holder: '' }],
      ['bad-why', { ...BODY, why: '' }], ['bad-why', { ...BODY, why: undefined }], ['bad-why', { ...BODY, why: 3 }],
    ];
    for (const [reason, body] of cases) {
      const answer = await s.post(body, { env: { ...s.env, HUB_LOCK_DIR: '/nonexistent/never-read' } });
      assert.deepEqual([answer.status, answer.body.code, answer.body.reason], [400, 'HUB_USAGE', reason], JSON.stringify(body));
    }
    assert.deepEqual(s.events(), []);
  } finally { s.cleanup(); }
});

test('an unknown word is a usage error, and a taken id is refused (the emulator word is leased: tools/hub-api/emulator-lease.test.mjs)', async () => {
  const s = scratch();
  try {
    const unknown = await s.post({ ...BODY, resource: 'nokia' });
    assert.deepEqual([unknown.status, unknown.body.code], [400, 'HUB_USAGE']);
    assert.match(unknown.body.detail, /unknown device "nokia"/);
    assert.equal((await s.post({ ...BODY, id: 'dup-1' })).status, 200);
    const dup = await s.post({ ...BODY, resource: 's26', id: 'dup-1', holder: 'agent-b' });
    assert.deepEqual([dup.status, dup.body.code], [400, 'HUB_USAGE']);
    assert.match(dup.body.detail, /already names a lease/);
    // A lease id is never a target.
    const asTarget = await s.post({ ...BODY, resource: 'dup-1' });
    assert.deepEqual([asTarget.status, asTarget.body.code], [400, 'HUB_USAGE']);
  } finally { s.cleanup(); }
});

test('an API Lease whose record pid is a dead process is not reclaimed, and status shows its holder and a null pid', async () => {
  const s = scratch();
  try {
    assert.equal((await s.post({ ...BODY, id: 'live-1' })).status, 200);
    const child = spawnSync(process.execPath, ['-e', '']);
    const file = join(s.env.HUB_LOCK_DIR, 's24.lock', 'owner.json');
    const record = JSON.parse(readFileSync(file, 'utf8'));
    writeFileSync(file, JSON.stringify({ ...record, pid: child.pid }));
    const second = await s.post({ ...BODY, holder: 'agent-b' });
    assert.deepEqual(problemOf(second), [409, 'HUB_LOCK_TIMEOUT', 76, 'busy']);
    assert.equal(s.owner('s24').lease_id, 'live-1');
    assert.equal(s.events().filter(event => event.event === 'reclaim').length, 0);
    const out = [];
    const code = await hubDevice(['status', '--json'], { env: s.env, stdout: line => out.push(line), stderr: () => {}, inventory: () => ({ adb_servers: [], emulators: [], xvfb: [] }), adbWire: fakeWire({ listed: [] }), hostKey: () => 'linux', policy, qaDevices: () => [], now: NOW });
    assert.equal(code, 0);
    const lock = JSON.parse(out.join('\n')).locks.find(entry => entry.lock === 's24');
    assert.deepEqual([lock.holder, lock.lease_id, lock.pid, lock.holder_pid], ['agent-a', 'live-1', null, null]);
  } finally { s.cleanup(); }
});

test('parity: hub-device lease s24 --no-connect --json and POST /leases take the same Lease', async () => {
  const cli = scratch();
  const api = scratch();
  try {
    const out = [];
    const argv = ['lease', 's24', '--no-connect', '--json', '--id', 'par-1', '--holder', 'agent-a', '--why', 'proof', '--for', '30m'];
    const code = await hubDevice(argv, { env: cli.env, stdout: line => out.push(line), stderr: () => {}, inventory: () => ({ adb_servers: [], emulators: [], xvfb: [] }), adbWire: fakeWire({ listed: [] }), hostKey: () => 'linux', policy, qaDevices: () => [], now: NOW });
    assert.equal(code, 0);
    const printed = JSON.parse(out.join('\n'));
    const answer = await api.post({ ...BODY, id: 'par-1' });
    assert.equal(answer.status, 200);
    assert.deepEqual(answer.body.env, printed.env);
    assert.equal(answer.body.expires_at, printed.expires_at);
    assert.equal(answer.body.lease_id, printed.lease_id);
    const strip = ({ lock_ino: _ino, ...rest }) => rest;
    assert.deepEqual(strip(api.owner('s24')), strip(cli.owner('s24')));
    assert.ok(Object.hasOwn(cli.owner('s24'), 'claimant_kind'));
  } finally { cli.cleanup(); api.cleanup(); }
});

// A fake node request and response, as server.test.mjs drives the listener.
function exchange(method, url, body) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
  const req = { method, url, async *[Symbol.asyncIterator]() { for (const chunk of chunks) yield chunk; } };
  const res = { head: null, text: null, writeHead(status, headers) { this.head = { status, headers }; }, end(text) { this.text = text; } };
  return { req, res, json: () => JSON.parse(res.text) };
}

test('a service started with GITHUB_* in its environment takes a Lease that names no repo and no run', async () => {
  const s = scratch();
  try {
    const env = { ...s.env, GITHUB_REPOSITORY: 'delorenj/leak', GITHUB_RUN_ID: '777', GITHUB_RUN_ATTEMPT: '2', GITHUB_JOB: 'deploy' };
    const servers = [];
    class FakeServer extends EventEmitter {
      constructor(listener) { super(); this.listener = listener; }
      listen(port, host, callback) { process.nextTick(callback); return this; }
      address() { return { port: 1 }; }
      close(callback) { process.nextTick(callback); return this; }
    }
    const running = await startHubApi({
      env, policy, hostId: HOST, now: NOW, devices: s.devices, qaDevices: () => [], versions: { node: '24.15.0' }, onPath: () => true, signals: new EventEmitter(),
      log: { out: () => {}, err: () => {} }, createServer: listener => { const server = new FakeServer(listener); servers.push(server); return server; },
    });
    const e = exchange('POST', '/leases', { ...BODY, id: 'gh-1' });
    await servers[0].listener(e.req, e.res);
    assert.equal(e.res.head.status, 200, e.res.text);
    const record = s.owner('s24');
    assert.deepEqual([record.repo, record.run, record.attempt, record.job], [null, null, null, null]);
    for (const event of s.events()) assert.deepEqual([event.claimant.repo, event.claimant.run, event.claimant.attempt, event.claimant.job], [null, null, null, null]);
    assert.ok(s.events().length > 0);
    await running.stop();
  } finally { s.cleanup(); }
});

test('withoutDeployIdentity drops every GITHUB_ key and nothing else; the input is not changed', () => {
  const env = { PATH: '/bin', GITHUB_RUN_ID: '1', GITHUB_REPOSITORY: 'a/b', HUB_LOCK_DIR: '/x', MY_GITHUB_THING: 'keep' };
  assert.deepEqual(withoutDeployIdentity(env), { PATH: '/bin', HUB_LOCK_DIR: '/x', MY_GITHUB_THING: 'keep' });
  assert.equal(env.GITHUB_RUN_ID, '1');
  assert.deepEqual(withoutDeployIdentity(undefined), {});
});

test('the HTTP table gives every library error a status; an unknown code has none, and an error with its own status keeps it', () => {
  assert.deepEqual(Object.entries(HTTP_ANSWERS).map(([code, answer]) => [code, answer.status, answer.reason ?? null]), [
    ['HUB_USAGE', 400, null], ['HUB_EMULATOR_USAGE', 400, null], ['HUB_LEASE_TOO_LONG', 400, null], ['HUB_DEVICE_JOB_ID', 400, null],
    ['HUB_NO_MATCH', 404, 'no-match'], ['HUB_LOCK_TIMEOUT', 409, 'busy'], ['HUB_DEVICE_BUSY', 409, 'busy'], ['HUB_POOL_CROSS_HOST', 409, null],
    ['HUB_RESOURCE_RETIRED', 409, null], ['HUB_LEASE_CANCELLED', 409, null], ['HUB_LEASE_NOT_FOUND', 404, null], ['HUB_LEASE_EXTEND_REFUSED', 409, null], ['HUB_LEASE_LOST', 409, null], ['HUB_LEASE_SUPERSEDED', 409, 'superseded'], ['HUB_API_RESTARTING', 503, 'restarting'],
    ['HUB_PHONE_AWAY', 503, 'away'], ['HUB_DEVICE_AWAY', 503, 'away'], ['HUB_HOST_UNKNOWN', 503, 'host-unknown'], ['HUB_EMULATOR_FAILED', 503, 'emulator-failed'],
  ]);
  for (const code of Object.keys(HTTP_ANSWERS)) assert.ok(code in EXIT_CODES, `${code} has an exit`);
  assert.equal(httpAnswerOf({ code: 'HUB_API_ERROR' }), null);
  assert.equal(httpAnswerOf(new Error('x')), null);
  const lib = problem(Object.assign(new Error('no phone came'), { code: 'HUB_PHONE_AWAY', reason: 'absent' }));
  assert.deepEqual([lib.status, lib.body.code, lib.body.exit, lib.body.reason], [503, 'HUB_PHONE_AWAY', 75, 'away']);
  const own = problem(Object.assign(new Error('retired'), { code: 'HUB_RESOURCE_RETIRED', status: 409, reason: 'seed-missing' }));
  assert.deepEqual([own.status, own.body.reason], [409, 'seed-missing']);
  const plain = problem(Object.assign(new Error('gone'), { code: 'HUB_POOL_CROSS_HOST' }));
  assert.deepEqual([plain.status, plain.body.reason, plain.body.exit], [409, 'hub_pool_cross_host', 2]);
  const bug = problem(Object.assign(new Error('boom'), { code: 'HUB_NOT_IN_THE_TABLE' }));
  assert.deepEqual([bug.status, bug.body.code], [500, 'HUB_API_ERROR']);
});

test('checkLeaseBody returns the normalised input, with defaults', () => {
  assert.deepEqual(checkLeaseBody({ ...BODY }), { resource: 's24', match: null, forMs: 30 * MIN, waitMs: 0, holder: 'agent-a', why: 'proof', claimantKind: 'agent', id: null, actor: null });
  const full = checkLeaseBody({ match: 'kind=phone', for_ms: 1000, holder: 'h', why: 'w', claimant_kind: 'person', id: 'x-1', actor: { holder: 'jarad', via: 'cli' } });
  assert.deepEqual([full.resource, full.match, full.claimantKind, full.id, full.actor], [null, 'kind=phone', 'person', 'x-1', { holder: 'jarad', via: 'cli' }]);
});

test('requestListener answers POST /leases over the adapter, and a bad wait_ms is refused', async () => {
  const s = scratch();
  try {
    const ok = exchange('POST', '/leases', BODY);
    await requestListener(s.ctx())(ok.req, ok.res);
    assert.equal(ok.res.head.status, 200);
    const waits = exchange('POST', '/leases', { ...BODY, wait_ms: 1000 });
    await requestListener(s.ctx())(waits.req, waits.res);
    assert.deepEqual([waits.res.head.status, waits.json().reason], [400, 'no-id']);
  } finally { s.cleanup(); }
});
