// Story 7.3: POST /leases/{id}/extend and /release through handle(), and hub-device extend / release through main(), on temp lock and
// event dirs: every row of the story's matrix, and the parity of the two front doors (same owner record, same refusal code and reason,
// same events minus `ts` and `actor.via`). No port is bound; adb, emulators and the real socket are never touched.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadDevices } from '../ci/lib/devices.mjs';
import { readEvents } from '../ci/lib/events.mjs';
import { loadPolicy } from '../ci/lib/policy.mjs';
import { acquireLease, readOwner } from '../ci/lib/lock.mjs';
import { hermetic } from '../ci/test-fixtures.mjs';
import { checkExtendBody, checkReleaseBody, exitCodeOf, releaseAnswer } from '../device/claims.mjs';
import { main as hubDevice } from '../device/hub-device.mjs';
import { fakeWire } from '../device/wire-fixtures.mjs';
import { ROUTES, handle, problem } from './routes.mjs';

hermetic();

const HOST = 'test-host';
const policy = loadPolicy().policy;
const T0 = Date.parse('2026-11-25T10:00:00Z');
const MIN = 60_000;
const iso = ms => new Date(ms).toISOString();

function scratch() {
  const root = mkdtempSync(join(tmpdir(), 'hub-api-extend-'));
  const env = { PATH: process.env.PATH, HOME: root, HUB_LOCK_DIR: join(root, 'locks'), HUB_EVENT_DIR: join(root, 'events') };
  const devices = structuredClone(loadDevices({}));
  const clock = { at: T0 };
  const now = () => clock.at;
  const out = [];
  const err = [];
  const s = {
    root, env, clock, out, err,
    ctx: () => ({ env, policy, routes: ROUTES, now, hostId: HOST, devices, qaDevices: () => [], log: { out: line => out.push(line), err: line => err.push(line) } }),
    api: (path, body, method = 'POST') => handle({ method, url: path, body }, s.ctx()),
    take: (id = 'x-1', extra = {}) => s.api('/leases', { resource: 's24', for_ms: 30 * MIN, holder: 'agent-a', why: 'proof', id, ...extra }),
    // The CLI, with fake seams. Returns {code, out, err}.
    cli: async argv => {
      const o = [];
      const e = [];
      const code = await hubDevice(argv, { env, stdout: line => o.push(line), stderr: line => e.push(line), inventory: () => ({ adb_servers: [], emulators: [], xvfb: [] }), adbWire: fakeWire({ listed: [] }), hostKey: () => 'linux', policy, qaDevices: () => [], now });
      return { code, out: o, err: e };
    },
    events: () => [...readEvents({ env })].filter(event => event.claimant !== undefined),
    owner: lock => readOwner(join(env.HUB_LOCK_DIR, `${lock}.lock`)),
    // A waiter as any hub version writes it: a ticket in <name>.queue/, served by a live pid on this host.
    wait: (lock = 's24', id = 'queued-1', holder = 'agent-b', why = 'wants the phone') => {
      const queue = join(env.HUB_LOCK_DIR, `${lock}.queue`);
      mkdirSync(queue, { recursive: true });
      writeFileSync(join(queue, `${String(T0 - MIN).padStart(15, '0')}-000001-00000009.json`), JSON.stringify({ format: 1, kind: 'lease', lease_id: id, holder, why, pid: process.pid, host: hostname(), enqueued_at: iso(T0 - MIN) }));
    },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
  return s;
}

const problemOf = answer => [answer.status, answer.body.code, answer.body.exit, answer.body.reason];
const WHO = { holder: 'jarad', via: 'cli' };
const extendEvents = s => s.events().filter(event => event.event === 'extend');

test('extend, nobody waits: the expiry moves later, one extend event carries the actor; the CLI prints it and exits 0', async () => {
  const s = scratch();
  try {
    assert.equal((await s.take()).status, 200);
    const answer = await s.api('/leases/x-1/extend', { for_ms: 10 * MIN, holder: 'agent-a' });
    assert.equal(answer.status, 200, JSON.stringify(answer.body));
    assert.equal(answer.headers['Cache-Control'], 'no-store');
    assert.deepEqual(Object.keys(answer.body).sort(), ['claimant_kind', 'device', 'emulator', 'env', 'expires_at', 'holder', 'lease_id', 'lock', 'resource', 'started_at', 'why']);
    assert.equal(answer.body.expires_at, iso(T0 + 40 * MIN));
    assert.equal(s.owner('s24').expires_at, iso(T0 + 40 * MIN));
    const [event] = extendEvents(s);
    assert.deepEqual([extendEvents(s).length, event.actor, 'why' in event, event.reason], [1, { holder: 'agent-a', via: 'api' }, false, null]);
    const cli = await s.cli(['extend', 'x-1', '--for', '10m', '--holder', 'jarad']);
    assert.deepEqual([cli.code, cli.out, cli.err], [0, [`HUB_DEVICE_EXTENDED s24 x-1 until ${iso(T0 + 50 * MIN)}`], []]);
    assert.deepEqual(extendEvents(s).at(-1).actor, WHO);
    const json = await s.cli(['extend', 'x-1', '--for', '1m', '--holder', 'jarad', '--json']);
    assert.deepEqual(JSON.parse(json.out[0]), { lease_id: 'x-1', lock: 's24', device: 's24', expires_at: iso(T0 + 51 * MIN) });
  } finally { s.cleanup(); }
});

test('extend with no id uses $HUB_LEASE_ID; with neither, a usage error', async () => {
  const s = scratch();
  try {
    await s.take();
    s.env.HUB_LEASE_ID = 'x-1';
    assert.equal((await s.cli(['extend', '--for', '5m', '--holder', 'jarad'])).code, 0);
    delete s.env.HUB_LEASE_ID;
    const none = await s.cli(['extend', '--for', '5m']);
    assert.deepEqual([none.code, none.err], [2, ['hub-device: extend needs a lease id or $HUB_LEASE_ID']]);
    assert.deepEqual((await s.cli(['extend', 'x-1'])).err, ['hub-device: --for <duration> is required']);
    assert.equal((await s.cli(['extend', 'x-1', 'y-1', '--for', '5m'])).code, 2);
    assert.equal((await s.cli(['release', 'x-1', '--override', 'why'])).code, 2, '--override belongs to extend');
  } finally { s.cleanup(); }
});

test('waiters refuse an extension: 409 / exit 76, reason waiters, the waiter named with its place, nothing written', async () => {
  const s = scratch();
  try {
    await s.take();
    s.wait();
    const owner = s.owner('s24');
    const events = s.events();
    const answer = await s.api('/leases/x-1/extend', { for_ms: 10 * MIN, holder: 'agent-a' });
    assert.deepEqual(problemOf(answer), [409, 'HUB_LEASE_EXTEND_REFUSED', 76, 'waiters']);
    assert.match(answer.body.detail, /^lease x-1 on s24 cannot be extended while 1 waiter waits: 1\. agent-b \(wants the phone\)$/);
    const cli = await s.cli(['extend', 'x-1', '--for', '10m', '--holder', 'jarad']);
    assert.equal(cli.code, 76);
    assert.deepEqual(cli.out, []);
    assert.match(cli.err[0], /^HUB_LEASE_EXTEND_REFUSED lease x-1 on s24 cannot be extended while 1 waiter waits: 1\. agent-b \(wants the phone\)$/);
    assert.deepEqual(s.owner('s24'), owner);
    assert.deepEqual(s.events(), events);
  } finally { s.cleanup(); }
});

test('an override extends past waiters: the one new event has actor, why and reason override', async () => {
  const s = scratch();
  try {
    await s.take();
    s.wait();
    const before = s.events().length;
    const answer = await s.api('/leases/x-1/extend', { for_ms: 10 * MIN, holder: 'jarad', override: { why: 'finish' } });
    assert.equal(answer.status, 200);
    assert.equal(answer.body.expires_at, iso(T0 + 40 * MIN));
    assert.equal(s.events().length, before + 1);
    const event = s.events().at(-1);
    assert.deepEqual([event.event, event.actor, event.why, event.reason], ['extend', { holder: 'jarad', via: 'api' }, 'finish', 'override']);
    const cli = await s.cli(['extend', 'x-1', '--for', '10m', '--holder', 'jarad', '--override', 'finish proof']);
    assert.equal(cli.code, 0);
    const second = s.events().at(-1);
    assert.deepEqual([second.actor, second.why, second.reason], [WHO, 'finish proof', 'override']);
    // The override's own actor is recorded as given.
    const named = await s.api('/leases/x-1/extend', { for_ms: MIN, holder: 'agent-a', override: { why: 'by hand', actor: { holder: 'holocene', via: 'control-surface' } } });
    assert.equal(named.status, 200);
    assert.deepEqual(s.events().at(-1).actor, { holder: 'holocene', via: 'control-surface' });
  } finally { s.cleanup(); }
});

test('an override without a why is a usage error, 400 bad-override / exit 2, and writes nothing', async () => {
  const s = scratch();
  try {
    await s.take();
    s.wait();
    const events = s.events();
    for (const override of [{ why: '' }, { why: '   ' }, {}, 'finish', null, [], { why: 'x', extra: 1 }, { why: 'x', actor: { holder: 'a', via: 'smoke' } }]) {
      const answer = await s.api('/leases/x-1/extend', { for_ms: MIN, holder: 'jarad', override });
      assert.deepEqual(problemOf(answer), [400, 'HUB_USAGE', 2, 'bad-override'], JSON.stringify(override));
    }
    const cli = await s.cli(['extend', 'x-1', '--for', '1m', '--override', '']);
    assert.deepEqual([cli.code, cli.err], [2, ['hub-device: --override says why: a non-empty reason']]);
    assert.deepEqual(s.events(), events);
  } finally { s.cleanup(); }
});

test('an override never lifts the deploy-target cap (cap) or the 48 h limit (too-long)', async () => {
  const s = scratch();
  try {
    assert.equal((await s.api('/leases', { resource: 's26', for_ms: 50 * MIN, holder: 'agent-a', why: 'proof', id: 'x-26' })).status, 200);
    s.wait('adb', 'q-adb');
    const owner = s.owner('adb');
    const events = s.events();
    const cap = await s.api('/leases/x-26/extend', { for_ms: 20 * MIN, holder: 'jarad', override: { why: 'finish' } });
    assert.deepEqual(problemOf(cap), [409, 'HUB_LEASE_EXTEND_REFUSED', 76, 'cap']);
    assert.match(cap.body.detail, /would run 70 min in total; a lease on adb runs at most 60 min/);
    const cli = await s.cli(['extend', 'x-26', '--for', '20m', '--override', 'finish']);
    assert.equal(cli.code, 76);
    assert.match(cli.err[0], /^HUB_LEASE_EXTEND_REFUSED .*at most 60 min/);
    assert.equal((await s.api('/leases/x-26/extend', { for_ms: 10 * MIN, holder: 'jarad', override: { why: 'finish' } })).status, 200, 'exactly the cap is allowed');
    await s.take('x-24');
    const long = await s.api('/leases/x-24/extend', { for_ms: 48 * 3600_000, holder: 'jarad', override: { why: 'finish' } });
    assert.deepEqual(problemOf(long), [409, 'HUB_LEASE_EXTEND_REFUSED', 76, 'too-long']);
    assert.deepEqual(s.owner('adb').expires_at, iso(T0 + 60 * MIN));
    assert.equal(events.length + 2, s.events().length, 'only the granted extension and the s24 take wrote');
    assert.notDeepEqual(owner, s.owner('adb'));
  } finally { s.cleanup(); }
});

test('at or after expiry an extension is refused (expired), override or not', async () => {
  const s = scratch();
  try {
    await s.take();
    s.clock.at = T0 + 30 * MIN;
    for (const body of [{ for_ms: MIN, holder: 'a' }, { for_ms: MIN, holder: 'a', override: { why: 'x' } }]) {
      assert.deepEqual(problemOf(await s.api('/leases/x-1/extend', body)), [409, 'HUB_LEASE_EXTEND_REFUSED', 76, 'expired']);
    }
    const cli = await s.cli(['extend', 'x-1', '--for', '1m']);
    assert.deepEqual([cli.code, /^HUB_LEASE_EXTEND_REFUSED lease x-1 on s24 ran out at /.test(cli.err[0])], [76, true]);
    assert.equal(extendEvents(s).length, 0);
  } finally { s.cleanup(); }
});

test('an id that holds nothing: 404 HUB_LEASE_NOT_FOUND (unknown, waiting), exit 2', async () => {
  const s = scratch();
  try {
    await s.take();
    s.wait('s24', 'queued-1');
    assert.deepEqual(problemOf(await s.api('/leases/nothing/extend', { for_ms: MIN, holder: 'a' })), [404, 'HUB_LEASE_NOT_FOUND', 2, 'unknown']);
    assert.deepEqual(problemOf(await s.api('/leases/queued-1/extend', { for_ms: MIN, holder: 'a' })), [404, 'HUB_LEASE_NOT_FOUND', 2, 'waiting']);
    const unknown = await s.cli(['extend', 'nothing', '--for', '1m']);
    assert.deepEqual([unknown.code, unknown.err], [2, ['HUB_LEASE_NOT_FOUND no lease or waiter has the id "nothing"']]);
    const waiting = await s.cli(['extend', 'queued-1', '--for', '1m']);
    assert.deepEqual([waiting.code, waiting.err[0]], [2, 'HUB_LEASE_NOT_FOUND lease queued-1 is waiting for s24; it holds nothing yet']);
  } finally { s.cleanup(); }
});

test('a job: id is refused by both doors, extend and release, naming the run to cancel', async () => {
  const s = scratch();
  try {
    const id = 'job:delorenj/app#123.android/build';
    const hint = 'cancel run 123 of delorenj/app instead (gh run cancel 123 --repo delorenj/app)';
    for (const verb of ['extend', 'release']) {
      const body = verb === 'extend' ? { for_ms: MIN, holder: 'a' } : { holder: 'a' };
      const answer = await s.api(`/leases/${encodeURIComponent(id)}/${verb}`, body);
      assert.deepEqual(problemOf(answer), [400, 'HUB_DEVICE_JOB_ID', 2, 'hub_device_job_id'], verb);
      assert.match(answer.body.detail, new RegExp(hint.replace(/[()#.]/g, '\\$&')));
      const cli = await s.cli(verb === 'extend' ? ['extend', id, '--for', '1m'] : ['release', id]);
      assert.deepEqual([cli.code, cli.err], [2, [`HUB_DEVICE_JOB_ID ${id} is a deploy job's place in line, not a lease; ${hint}`]], verb);
    }
    assert.deepEqual(s.events(), []);
  } finally { s.cleanup(); }
});

test('release: the lock is released through releaseLease, one release event (by-id) with the actor, and the Release shape', async () => {
  const s = scratch();
  try {
    await s.take();
    const answer = await s.api('/leases/x-1/release', { holder: 'agent-a' });
    assert.equal(answer.status, 200);
    assert.deepEqual(answer.body, { lease_id: 'x-1', outcome: 'released', resource: 's24', lock: 's24', device: 's24' });
    assert.equal(s.owner('s24'), null);
    const event = s.events().at(-1);
    assert.deepEqual([event.event, event.reason, event.lease_id, event.actor], ['release', 'by-id', 'x-1', { holder: 'agent-a', via: 'api' }]);
    // Again: nothing holds it, which is not an error.
    const none = await s.api('/leases/x-1/release', { holder: 'agent-a' });
    assert.deepEqual([none.status, none.body], [200, { lease_id: 'x-1', outcome: 'none', resource: null, lock: null, device: null }]);
    await s.take('x-2');
    const cli = await s.cli(['release', 'x-2', '--holder', 'jarad']);
    assert.deepEqual([cli.code, cli.out], [0, ['HUB_DEVICE_RELEASED s24 x-2']]);
    assert.deepEqual(s.events().at(-1).actor, WHO);
    await s.take('x-3');
    assert.equal((await s.cli(['release', '--any', '--holder', 'jarad'])).code, 0);
    assert.deepEqual(s.events().at(-1).actor, WHO);
  } finally { s.cleanup(); }
});

test('release of a waiter cancels it (a cancel event with the actor) and touches no Hold', async () => {
  const s = scratch();
  try {
    await s.take();
    s.wait('s24', 'queued-1');
    const owner = s.owner('s24');
    const answer = await s.api('/leases/queued-1/release', { actor: { holder: 'jarad', via: 'control-surface' } });
    assert.deepEqual([answer.status, answer.body], [200, { lease_id: 'queued-1', outcome: 'cancelled', resource: 's24', lock: 's24', device: 's24' }]);
    const event = s.events().at(-1);
    assert.deepEqual([event.event, event.reason, event.actor], ['cancel', 'released', { holder: 'jarad', via: 'control-surface' }]);
    assert.deepEqual(s.owner('s24'), owner);
  } finally { s.cleanup(); }
});

test('a lock that is being taken (no owner record yet) is left alone: an id that is not its Lease releases as none', async () => {
  const s = scratch();
  try {
    mkdirSync(join(s.env.HUB_LOCK_DIR, 's24.lock'), { recursive: true });
    const answer = await s.api('/leases/nobody/release', { holder: 'a' });
    assert.deepEqual([answer.status, answer.body.outcome], [200, 'none']);
    assert.deepEqual((await s.cli(['release', 'nobody'])).code, 0);
    assert.deepEqual(s.events(), []);
  } finally { s.cleanup(); }
});

test('releaseAnswer maps what release found: unknown-holder and changed-hands are HUB_LEASE_LOST 409 (being-taken, changed-hands), exit 1', () => {
  const lost = result => { try { releaseAnswer('x-1', result); } catch (error) { return error; } return null; };
  const taking = lost({ outcome: 'unknown-holder', notes: ['s24 is being taken (its lock has no owner record yet); left alone, try again'] });
  assert.deepEqual([taking.code, taking.reason, exitCodeOf(taking), problem(taking).status], ['HUB_LEASE_LOST', 'being-taken', 1, 409]);
  assert.match(taking.message, /being taken/);
  const moved = lost({ outcome: 'changed-hands', notes: [] });
  assert.deepEqual([moved.code, moved.reason, problem(moved).body.reason], ['HUB_LEASE_LOST', 'changed-hands', 'changed-hands']);
  assert.deepEqual(releaseAnswer('x-1', { outcome: 'job-held' }), { lease_id: 'x-1', outcome: 'none', resource: null, lock: null, device: null });
  assert.deepEqual(releaseAnswer('x-1', { outcome: 'released', lock: 's24', device: 's24' }), { lease_id: 'x-1', outcome: 'released', resource: 's24', lock: 's24', device: 's24' });
});

test('an emulator id that is only waiting for its turn: extend is 404 waiting, release is cancelled (in a worker); a booted one is tools/hub-api/emulator-lease.test.mjs', async () => {
  const s = scratch();
  try {
    s.wait('emulator', 'e-aaaaaaaaaaaa');
    assert.deepEqual(problemOf(await s.api('/leases/e-aaaaaaaaaaaa/extend', { for_ms: MIN, holder: 'a' })), [404, 'HUB_LEASE_NOT_FOUND', 2, 'waiting']);
    assert.deepEqual(s.events(), []);
    const released = await s.api('/leases/e-aaaaaaaaaaaa/release', { holder: 'a' });
    assert.deepEqual([released.status, released.body], [200, { lease_id: 'e-aaaaaaaaaaaa', outcome: 'cancelled', resource: 'emulator', lock: 'emulator', device: 'emulator' }]);
    const again = await s.api('/leases/e-aaaaaaaaaaaa/release', { holder: 'a' });
    assert.deepEqual(again.body, { lease_id: 'e-aaaaaaaaaaaa', outcome: 'none', resource: null, lock: null, device: null });
    const cli = await s.cli(['release', 'e-aaaaaaaaaaaa']);
    assert.deepEqual([cli.code, cli.out.length, /^HUB_DEVICE_NOT_HELD /.test(cli.out[0])], [0, 1, true], 'the CLI agrees: nothing is held');
  } finally { s.cleanup(); }
});

test('the bodies are checked before anything is read: reasons, and the actor default', async () => {
  const s = scratch();
  try {
    const reasonOf = (path, body) => s.api(path, body).then(answer => [answer.status, answer.body.reason]);
    assert.deepEqual(await reasonOf('/leases/x-1/extend', []), [400, 'bad-body']);
    assert.deepEqual(await reasonOf('/leases/x-1/extend', { for_ms: MIN, holder: 'a', extra: 1 }), [400, 'bad-body']);
    for (const bad of [0, -1, 1.5, '10', undefined]) assert.deepEqual(await reasonOf('/leases/x-1/extend', { for_ms: bad, holder: 'a' }), [400, 'bad-for'], String(bad));
    assert.deepEqual(await reasonOf('/leases/x-1/extend', { for_ms: MIN, actor: { holder: 'a', via: 'smoke' } }), [400, 'bad-actor']);
    assert.deepEqual(await reasonOf('/leases/x-1/extend', { for_ms: MIN }), [400, 'no-holder']);
    assert.deepEqual(await reasonOf('/leases/x-1/extend', { for_ms: MIN, holder: '' }), [400, 'no-holder']);
    assert.deepEqual(await reasonOf('/leases/x-1/release', 'x'), [400, 'bad-body']);
    assert.deepEqual(await reasonOf('/leases/x-1/release', { holder: 'a', for_ms: 1 }), [400, 'bad-body']);
    assert.deepEqual(await reasonOf('/leases/x-1/release', { actor: [] }), [400, 'bad-actor']);
    assert.deepEqual(await reasonOf('/leases/x-1/release', {}), [400, 'no-holder']);
    // Neither id is looked up before the body is right, and a bad body writes nothing.
    assert.deepEqual(s.events(), []);
    assert.deepEqual(checkExtendBody({ for_ms: 5, actor: { holder: 'a', via: 'api' } }), { forMs: 5, holder: null, actor: { holder: 'a', via: 'api' }, override: null });
    assert.deepEqual(checkReleaseBody({ holder: 'h' }), { holder: 'h', actor: null });
    assert.equal(ROUTES.filter(route => /\/leases\/\{id\}\/(extend|release)$/.test(route.path)).length, 2);
    // A GET on either is 405 with Allow: POST.
    const get = await s.api('/leases/x-1/extend', undefined, 'GET');
    assert.deepEqual([get.status, get.headers.Allow], [405, 'POST']);
  } finally { s.cleanup(); }
});

// What two scratch dirs must agree on, whichever door was used: the owner record (minus lock_ino) and the events (minus ts and actor.via).
const strip = ({ lock_ino: _ino, ...rest }) => rest;
const sameEvents = s => s.events().map(({ ts: _ts, actor, ...rest }) => ({ ...rest, ...(actor ? { actor: { holder: actor.holder } } : {}) }));

test('parity: the CLI and the API extend (granted and refused) and release the same id the same way', async () => {
  const cli = scratch();
  const api = scratch();
  try {
    for (const s of [cli, api]) { await s.take(); }
    const stateOf = s => [s.owner('s24') && strip(s.owner('s24')), sameEvents(s)];
    // A granted extension.
    const cliOk = await cli.cli(['extend', 'x-1', '--for', '10m', '--holder', 'jarad']);
    const apiOk = await api.api('/leases/x-1/extend', { for_ms: 10 * MIN, actor: { holder: 'jarad', via: 'api' } });
    assert.deepEqual([cliOk.code, apiOk.status], [0, 200]);
    assert.deepEqual(stateOf(cli), stateOf(api));
    // A refused one (a waiter): same code and reason, nothing more written.
    for (const s of [cli, api]) s.wait();
    const cliNo = await cli.cli(['extend', 'x-1', '--for', '10m', '--holder', 'jarad']);
    const apiNo = await api.api('/leases/x-1/extend', { for_ms: 10 * MIN, actor: { holder: 'jarad', via: 'api' } });
    assert.deepEqual([cliNo.code, apiNo.body.exit, apiNo.body.reason], [76, 76, 'waiters']);
    assert.equal(cliNo.err[0], `${apiNo.body.code} ${apiNo.body.detail}`);
    assert.deepEqual(stateOf(cli), stateOf(api));
    // An override past the waiter.
    const cliOver = await cli.cli(['extend', 'x-1', '--for', '5m', '--holder', 'jarad', '--override', 'finish']);
    const apiOver = await api.api('/leases/x-1/extend', { for_ms: 5 * MIN, actor: { holder: 'jarad', via: 'api' }, override: { why: 'finish' } });
    assert.deepEqual([cliOver.code, apiOver.status], [0, 200]);
    assert.deepEqual(stateOf(cli), stateOf(api));
    assert.equal(cli.events().at(-1).actor.via, 'cli');
    assert.equal(api.events().at(-1).actor.via, 'api');
    // And the release.
    const cliRel = await cli.cli(['release', 'x-1', '--holder', 'jarad']);
    const apiRel = await api.api('/leases/x-1/release', { actor: { holder: 'jarad', via: 'api' } });
    assert.deepEqual([cliRel.code, apiRel.status, apiRel.body.outcome], [0, 200, 'released']);
    assert.deepEqual(stateOf(cli), stateOf(api));
    assert.equal(cli.owner('s24'), null);
  } finally { cli.cleanup(); api.cleanup(); }
});

test('the CLI extends an emulator lease on its slot, recording the cli actor', async () => {
  const s = scratch();
  try {
    await acquireLease('emulator-1', { id: 'e-xxxxxxxxxxxx', holder: 'h', why: 'x', forMs: 30 * MIN, waitMs: 0, env: s.env, log: () => {}, pollMs: 5, now: s.ctx().now });
    const records = join(s.env.HUB_LOCK_DIR, 'emulators');
    mkdirSync(records, { recursive: true });
    writeFileSync(join(records, 'e-xxxxxxxxxxxx.json'), JSON.stringify({ lease_id: 'e-xxxxxxxxxxxx', slot: 'emulator-1', pids: [] }));
    const cli = await s.cli(['extend', 'e-xxxxxxxxxxxx', '--for', '10m', '--holder', 'jarad']);
    assert.deepEqual([cli.code, cli.out, cli.err], [0, [`HUB_DEVICE_EXTENDED emulator e-xxxxxxxxxxxx until ${iso(T0 + 40 * MIN)}`], []]);
    const [event] = extendEvents(s);
    assert.deepEqual([extendEvents(s).length, event.lock, event.actor], [1, 'emulator-1', WHO]);
  } finally { s.cleanup(); }
});
