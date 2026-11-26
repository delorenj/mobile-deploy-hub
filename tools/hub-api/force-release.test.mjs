// Story 7.6: POST /leases/{id}/force-release through handle(), and hub-device force-release through main(), on temp lock and event dirs: every row of
// the story's matrix, and the parity of the two front doors (same answer, same lock, same events minus `ts` and `actor.via`). No port is bound; adb,
// emulators and the real socket are never touched.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadDevices } from '../ci/lib/devices.mjs';
import { readEvents } from '../ci/lib/events.mjs';
import { acquireLease, forceRelease, leaseHoldersSince, readOwner, resourceOf } from '../ci/lib/lock.mjs';
import { loadPolicy } from '../ci/lib/policy.mjs';
import { hermetic } from '../ci/test-fixtures.mjs';
import { EXIT_CODES, checkForceReleaseBody, forceReleaseLease, httpAnswerOf } from '../device/claims.mjs';
import { main as hubDevice } from '../device/hub-device.mjs';
import { fakeWire } from '../device/wire-fixtures.mjs';
import { ROUTES, handle } from './routes.mjs';

hermetic();

const policy = loadPolicy().policy;
const T0 = Date.parse('2026-11-25T10:00:00Z');
const MIN = 60_000;
const iso = ms => new Date(ms).toISOString();
const tick = ms => new Promise(done => setTimeout(done, ms));
const until = async (check, what) => {
  for (let tries = 0; tries < 500; tries += 1) { if (check()) return; await tick(10); }
  assert.fail(`never happened: ${what}`);
};

function scratch() {
  const root = mkdtempSync(join(tmpdir(), 'hub-api-force-release-'));
  const env = { PATH: process.env.PATH, HOME: root, HUB_LOCK_DIR: join(root, 'locks'), HUB_EVENT_DIR: join(root, 'events') };
  const devices = structuredClone(loadDevices({}));
  const now = () => T0;
  const s = {
    root, env,
    ctx: (extra = {}) => ({ env, policy, routes: ROUTES, now, hostId: 'test-host', devices, qaDevices: () => [], hostKey: () => 'linux', log: { out: () => {}, err: () => {} }, ...extra }),
    api: (id, body, extra) => handle({ method: 'POST', url: `/leases/${encodeURIComponent(id)}/force-release`, body }, s.ctx(extra)),
    take: (id = 'a-1', resource = 's24') => handle({ method: 'POST', url: '/leases', body: { resource, for_ms: 30 * MIN, holder: 'agent-a', why: 'proof', id } }, s.ctx()),
    cli: async argv => {
      const o = [];
      const e = [];
      const code = await hubDevice(argv, { env, stdout: line => o.push(line), stderr: line => e.push(line), inventory: () => ({ adb_servers: [], emulators: [], xvfb: [] }), adbWire: fakeWire({ listed: [] }), hostKey: () => 'linux', policy, qaDevices: () => [], now });
      return { code, out: o, err: e };
    },
    // A Lease on any lock, taken through the lock layer (the iOS lane, a registered phone's lock, an emulator slot or the gate).
    hold: (lock, id, holder = 'agent-a') => acquireLease(lock, { holder, why: 'proof', forMs: 30 * MIN, id, env, log: () => {}, now }),
    events: () => [...readEvents({ env })],
    owner: lock => readOwner(join(env.HUB_LOCK_DIR, `${lock}.lock`)),
    ownerText: lock => readFileSync(join(env.HUB_LOCK_DIR, `${lock}.lock`, 'owner.json'), 'utf8'),
    entries: () => { try { return readdirSync(env.HUB_LOCK_DIR).sort(); } catch { return []; } },
    // A Job Hold as it is on disk.
    plant: (lock, owner) => {
      const dir = join(env.HUB_LOCK_DIR, `${lock}.lock`);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'owner.json'), JSON.stringify({ format: 1, pid: process.pid, host: hostname(), started_at: iso(T0), ...owner }));
    },
    wait: (lock, id, { holder = 'agent-b', file = `${String(T0 - MIN).padStart(15, '0')}-000001-00000009.json` } = {}) => {
      const queue = join(env.HUB_LOCK_DIR, `${lock}.queue`);
      mkdirSync(queue, { recursive: true });
      writeFileSync(join(queue, file), JSON.stringify({ format: 1, kind: 'lease', lease_id: id, holder, why: 'wants the phone', pid: process.pid, host: hostname(), enqueued_at: iso(T0 - MIN), deadline_at: iso(T0 + 9 * MIN), pool: null, request: null }));
    },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
  return s;
}

const problemOf = answer => [answer.status, answer.body.code, answer.body.exit, answer.body.reason];
const forced = s => s.events().filter(event => event.event === 'force-release');

test('happy path: the Lease is gone, the answer is a ForceRelease, one force-release event carries the actor, why and lease id', async () => {
  const s = scratch();
  try {
    assert.equal((await s.take()).status, 200);
    const answer = await s.api('a-1', { why: 'stuck', holder: 'ops' });
    assert.equal(answer.status, 200, JSON.stringify(answer.body));
    assert.equal(answer.headers['Cache-Control'], 'no-store');
    assert.deepEqual(answer.body, { lease_id: 'a-1', outcome: 'force-released', resource: resourceOf('s24'), lock: 's24', device: 's24', holder: 'agent-a', why: 'stuck' });
    assert.equal(s.owner('s24'), null);
    assert.deepEqual(s.entries().filter(entry => entry.startsWith('s24.lock')), []);
    const [event, ...more] = forced(s);
    assert.equal(more.length, 0, 'one event');
    assert.deepEqual([event.lock, event.hold_kind, event.lease_id, event.actor, event.why, event.reason, event.claimant.holder], ['s24', 'lease', 'a-1', { holder: 'ops', via: 'api' }, 'stuck', null, 'agent-a']);
    // An actor given in the body is recorded as given; the id is not reusable as a Lease of nothing (404 now).
    await s.take('a-2');
    assert.equal((await s.api('a-2', { why: 'x', actor: { holder: 'holocene', via: 'control-surface' } })).status, 200);
    assert.deepEqual(forced(s).at(-1).actor, { holder: 'holocene', via: 'control-surface' });
    assert.deepEqual(problemOf(await s.api('a-1', { why: 'again', holder: 'ops' })), [404, 'HUB_LEASE_NOT_FOUND', 2, 'unknown']);
  } finally { s.cleanup(); }
});

test('the force-released Lease is gone from status --json, and the Event Log (what history reads) shows its hold ended by force-release', async () => {
  const s = scratch();
  try {
    await s.take();
    const before = JSON.stringify(JSON.parse((await s.cli(['status', '--json'])).out.join('\n')));
    assert.match(before, /"a-1"/, 'listed while held');
    assert.equal((await s.api('a-1', { why: 'stuck', holder: 'ops' })).status, 200);
    const after = await s.cli(['status', '--json']);
    assert.equal(after.code, 0);
    assert.doesNotMatch(after.out.join('\n'), /"a-1"/, 'no longer listed');
    assert.deepEqual(s.events().filter(event => event.lease_id === 'a-1').map(event => event.event), ['acquire', 'force-release']);
    assert.deepEqual(leaseHoldersSince('s24', T0 - MIN, { env: s.env }).map(hold => hold.lease_id), ['a-1']);
    assert.deepEqual(leaseHoldersSince('s24', T0 + MIN, { env: s.env }), [], 'ended by the force-release, not by its expiry');
  } finally { s.cleanup(); }
});

test('a waiter in line acquires the lock next, normally: its acquire follows the force-release', async () => {
  const s = scratch();
  try {
    await s.take();
    const waiting = acquireLease('s24', { holder: 'waiter', why: 'wants it', forMs: 5 * MIN, waitMs: 5 * MIN, id: 'b-1', env: s.env, log: () => {}, now: () => T0, pollMs: 5, sleep: () => tick(5) });
    await until(() => readdirSync(join(s.env.HUB_LOCK_DIR, 's24.queue')).some(file => file.endsWith('.json')), 'queued');
    assert.equal((await s.api('a-1', { why: 'stuck', holder: 'ops' })).status, 200);
    assert.equal((await waiting).lease_id, 'b-1');
    assert.deepEqual(s.events().filter(event => event.lock === 's24').map(event => `${event.event}:${event.lease_id}`), ['acquire:a-1', 'request:b-1', 'force-release:a-1', 'acquire:b-1']);
  } finally { s.cleanup(); }
});

test('a Lease on the iOS lane, on a registered phone\'s lock and on a deploy phone is found by id on this host, not just the S24', async () => {
  const s = scratch();
  try {
    await s.take('a-26', 's26');
    await s.hold('mac-ios', 'm-1');
    await s.hold('res-pixel', 'p-1');
    const lane = await s.api('m-1', { why: 'iPad stuck', holder: 'ops' });
    assert.deepEqual(lane.body, { lease_id: 'm-1', outcome: 'force-released', resource: resourceOf('mac-ios'), lock: 'mac-ios', device: null, holder: 'agent-a', why: 'iPad stuck' });
    const phone = await s.api('p-1', { why: 'stuck', holder: 'ops' });
    assert.deepEqual([phone.status, phone.body.lock, phone.body.resource], [200, 'res-pixel', resourceOf('res-pixel')]);
    const deploy = await s.api('a-26', { why: 'stuck', holder: 'ops' });
    assert.deepEqual([deploy.status, deploy.body.lock, deploy.body.device], [200, 'adb', 's26']);
    assert.deepEqual(forced(s).map(event => [event.lock, event.lease_id]), [['mac-ios', 'm-1'], ['res-pixel', 'p-1'], ['adb', 'a-26']]);
  } finally { s.cleanup(); }
});

test('an empty, blank or missing why is 400 HUB_USAGE (bad-why, no-why) and the CLI without --why exits 2: nothing is written', async () => {
  const s = scratch();
  try {
    await s.take();
    const before = s.ownerText('s24');
    const events = s.events().length;
    assert.deepEqual(problemOf(await s.api('a-1', { why: '', holder: 'ops' })), [400, 'HUB_USAGE', 2, 'bad-why']);
    assert.deepEqual(problemOf(await s.api('a-1', { why: '  ', holder: 'ops' })), [400, 'HUB_USAGE', 2, 'bad-why']);
    assert.deepEqual(problemOf(await s.api('a-1', { why: 4, holder: 'ops' })), [400, 'HUB_USAGE', 2, 'bad-why']);
    assert.deepEqual(problemOf(await s.api('a-1', { holder: 'ops' })), [400, 'HUB_USAGE', 2, 'no-why']);
    const cli = await s.cli(['force-release', 'a-1']);
    assert.deepEqual([cli.code, cli.out, cli.err.length], [2, [], 1]);
    assert.match(cli.err[0], /says why/);
    assert.equal((await s.cli(['force-release', 'a-1', '--why', ' '])).code, 2);
    assert.equal(s.ownerText('s24'), before);
    assert.equal(s.events().length, events);
  } finally { s.cleanup(); }
});

test('a job id is 409 HUB_FORCE_RELEASE_JOB (exit 2) with repo, run and job, and names gh run cancel; a local run has no run to cancel', async () => {
  const s = scratch();
  try {
    const refused = await s.api('job:o/r#41.1/android', { why: 'stuck', holder: 'ops' });
    assert.deepEqual(problemOf(refused), [409, 'HUB_FORCE_RELEASE_JOB', 2, 'job']);
    assert.deepEqual([refused.body.repo, refused.body.run, refused.body.job], ['o/r', '41', 'android']);
    assert.match(refused.body.detail, /gh run cancel 41 --repo o\/r/);
    const local = await s.api('job:local#local-4242.1/deploy', { why: 'stuck', holder: 'ops' });
    assert.deepEqual(problemOf(local), [409, 'HUB_FORCE_RELEASE_JOB', 2, 'job']);
    assert.deepEqual([local.body.repo, local.body.run, local.body.job], [null, null, 'deploy']);
    assert.match(local.body.detail, /stop the local process 4242 instead/);
    const cli = await s.cli(['force-release', 'job:o/r#41.1/android', '--why', 'stuck']);
    assert.deepEqual([cli.code, cli.out, cli.err.length], [2, [], 1]);
    assert.match(cli.err[0], /^HUB_FORCE_RELEASE_JOB .*gh run cancel 41 --repo o\/r/);
    // The same refusal for a job id with no why: the id is checked after the why, as for every refusal of the body.
    assert.deepEqual(problemOf(await s.api('job:o/r#41.1/android', { holder: 'ops' })), [400, 'HUB_USAGE', 2, 'no-why']);
    assert.deepEqual(s.events(), []);
  } finally { s.cleanup(); }
});

test('a lock held by a deploy job is never force-released: the lock layer refuses it, and no Lease id reaches it through the API; owner byte-identical, no event', async () => {
  const s = scratch();
  try {
    s.plant('adb', { kind: 'job', repo: 'o/r', run: '41', attempt: '1', job: 'android' });
    await s.hold('s24', 'a-1');
    const before = s.ownerText('adb');
    // A Lease id is only ever found on a Lease's lock, so the Job Hold is reached through the lock layer's own refusal.
    assert.throws(() => forceRelease('adb', { actor: { holder: 'ops', via: 'api' }, why: 'x', env: s.env }), error => error.code === 'HUB_FORCE_RELEASE_JOB' && error.repo === 'o/r' && error.run === '41' && error.job === 'android');
    assert.equal(s.ownerText('adb'), before);
    assert.deepEqual(problemOf(await s.api('adb', { why: 'stuck', holder: 'ops' })), [404, 'HUB_LEASE_NOT_FOUND', 2, 'unknown'], 'a lock name is no Lease id');
    assert.deepEqual(forced(s), []);
  } finally { s.cleanup(); }
});

test('an unknown id and an id that only waits are 404 HUB_LEASE_NOT_FOUND (unknown, waiting), exit 2, nothing written', async () => {
  const s = scratch();
  try {
    await s.take();
    s.wait('s24', 'b-1');
    const before = s.ownerText('s24');
    const events = s.events().length;
    assert.deepEqual(problemOf(await s.api('nobody', { why: 'x', holder: 'ops' })), [404, 'HUB_LEASE_NOT_FOUND', 2, 'unknown']);
    const waiting = await s.api('b-1', { why: 'x', holder: 'ops' });
    assert.deepEqual(problemOf(waiting), [404, 'HUB_LEASE_NOT_FOUND', 2, 'waiting']);
    assert.equal(readdirSync(join(s.env.HUB_LOCK_DIR, 's24.queue')).length, 1, 'the waiter keeps its place');
    for (const id of ['nobody', 'b-1']) {
      const cli = await s.cli(['force-release', id, '--why', 'x']);
      assert.deepEqual([cli.code, cli.out, cli.err[0].startsWith('HUB_LEASE_NOT_FOUND ')], [2, [], true]);
    }
    assert.equal(s.ownerText('s24'), before);
    assert.equal(s.events().length, events);
  } finally { s.cleanup(); }
});

test('an emulator lease id (a slot, or the gate) is 400 HUB_USAGE reason emulator pointing to the slot\'s force-release; nothing is written', async () => {
  const s = scratch();
  try {
    await s.hold('emulator-1', 'e-1');
    await s.hold('emulator', 'e-2');
    const before = [s.ownerText('emulator-1'), s.ownerText('emulator')];
    const slot = await s.api('e-1', { why: 'x', holder: 'ops' });
    assert.deepEqual(problemOf(slot), [400, 'HUB_USAGE', 2, 'emulator']);
    assert.match(slot.body.detail, /force-release emulator-1/);
    const gate = await s.api('e-2', { why: 'x', holder: 'ops' });
    assert.deepEqual(problemOf(gate), [400, 'HUB_USAGE', 2, 'emulator']);
    assert.match(gate.body.detail, /force-release emulator-<n>/);
    const cli = await s.cli(['force-release', 'e-1', '--why', 'x']);
    assert.deepEqual([cli.code, cli.out, /force-release emulator-1/.test(cli.err[0])], [2, [], true]);
    // An emulator record with no lock held for it (a teardown that has not finished) is an emulator lease too.
    mkdirSync(join(s.env.HUB_LOCK_DIR, 'emulators'), { recursive: true });
    writeFileSync(join(s.env.HUB_LOCK_DIR, 'emulators', 'e-3.json'), JSON.stringify({ lease_id: 'e-3', slot: 'emulator-2', pids: [] }));
    const events = s.events().length;
    const record = await s.api('e-3', { why: 'x', holder: 'ops' });
    assert.deepEqual(problemOf(record), [400, 'HUB_USAGE', 2, 'emulator']);
    assert.match(record.body.detail, /force-release emulator-2/);
    assert.equal(s.events().length, events, 'nothing is written');
    assert.deepEqual([s.ownerText('emulator-1'), s.ownerText('emulator')], before);
    assert.deepEqual(s.events().filter(event => event.event === 'force-release'), []);
  } finally { s.cleanup(); }
});

test('the race: an owner replaced, or removed, between the read and the rename is 409 HUB_LEASE_LOST changed-hands; no force-release event, the new owner stays', async () => {
  const s = scratch();
  try {
    await s.take();
    const env = s.env;
    const owner = s.owner('s24');
    const input = { why: 'stuck', actor: { holder: 'ops', via: 'api' } };
    const ctx = beforeRetire => ({ env, timing: { now: () => T0 }, fleet: undefined, beforeRetire, hostKey: () => 'linux' });
    const replace = stage => { if (stage === 'rename') writeFileSync(join(env.HUB_LOCK_DIR, 's24.lock', 'owner.json'), JSON.stringify({ ...owner, lease_id: 'z-9', holder: 'someone-else' })); };
    assert.throws(() => forceReleaseLease('a-1', input, ctx(replace)), error => error.code === 'HUB_LEASE_LOST' && error.reason === 'changed-hands' && httpAnswerOf(error).status === 409);
    assert.equal(s.owner('s24').lease_id, 'z-9', 'the new owner is untouched');
    assert.deepEqual(s.entries().filter(entry => entry.includes('tomb')), []);
    assert.deepEqual(forced(s), []);
    // Removed: the same answer.
    assert.throws(() => forceReleaseLease('z-9', input, ctx(stage => { if (stage === 'rename') rmSync(join(env.HUB_LOCK_DIR, 's24.lock'), { recursive: true }); })), error => error.code === 'HUB_LEASE_LOST' && error.reason === 'changed-hands');
    assert.deepEqual(forced(s), []);
  } finally { s.cleanup(); }
});

test('a bad body is 400 HUB_USAGE with its reason, before anything is read', async () => {
  const s = scratch();
  try {
    await s.take();
    const bad = [
      [null, 'bad-body'], [[], 'bad-body'], [{ why: 'x', holder: 'ops', extra: 1 }, 'bad-body'], [{ why: 'x', holder: 'ops', resource: 7 }, 'bad-resource'], [{ why: 'x', holder: 'ops', resource: ' ' }, 'bad-resource'],
      [{ actor: { holder: 'x', via: 'telepathy' }, why: 'x' }, 'bad-actor'], [{ why: 'x', actor: 'ops' }, 'bad-actor'],
      [{ why: 'x' }, 'no-holder'], [{ why: 'x', holder: ' ' }, 'no-holder'], [{ why: 'x', holder: 7 }, 'no-holder'],
    ];
    for (const [body, reason] of bad) assert.deepEqual(problemOf(await s.api('a-1', body)), [400, 'HUB_USAGE', 2, reason], JSON.stringify(body));
    assert.equal(s.owner('s24').lease_id, 'a-1');
    assert.deepEqual(checkForceReleaseBody({ why: 'x', holder: 'ops' }), { why: 'x', holder: 'ops', actor: null });
    assert.deepEqual(checkForceReleaseBody({ why: 'x', holder: 'ops', resource: 's24' }), { why: 'x', holder: 'ops', actor: null, resource: 's24' });
    assert.deepEqual(checkForceReleaseBody({ why: 'x', actor: { holder: 'h', via: 'cli' } }), { why: 'x', holder: null, actor: { holder: 'h', via: 'cli' } });
  } finally { s.cleanup(); }
});

test('the CLI: --why and --holder are recorded with via cli, the line names the device, the id and the released holder; --json is the ForceRelease; usage mistakes exit 2', async () => {
  const s = scratch();
  try {
    await s.take('a-1', 's24');
    await s.take('a-2', 's26');
    const line = await s.cli(['force-release', 'a-1', '--why', 'dead agent', '--holder', 'jarad']);
    assert.deepEqual([line.code, line.out, line.err], [0, ['HUB_DEVICE_FORCE_RELEASED s24 a-1 holder=agent-a'], []]);
    assert.deepEqual([forced(s)[0].actor, forced(s)[0].why], [{ holder: 'jarad', via: 'cli' }, 'dead agent']);
    const json = await s.cli(['force-release', 'a-2', '--why', 'dead agent', '--json']);
    assert.equal(json.code, 0);
    assert.deepEqual(JSON.parse(json.out[0]), { lease_id: 'a-2', outcome: 'force-released', resource: resourceOf('adb'), lock: 'adb', device: 's26', holder: 'agent-a', why: 'dead agent' });
    assert.equal((await s.cli(['force-release', '--why', 'x'])).code, 2);
    assert.equal((await s.cli(['force-release', 'a', 'b', '--why', 'x'])).code, 2);
    assert.equal((await s.cli(['force-release', 'a-1', '--why', 'x', '--resource', 's24'])).code, 2, '--resource belongs to cancel');
  } finally { s.cleanup(); }
});

test('parity: the same Lease force-released through the CLI and through the API leaves the same answer, lock and events (minus ts and actor.via)', async () => {
  const run = async how => {
    const s = scratch();
    try {
      await s.take();
      const answer = how === 'api'
        ? (await s.api('a-1', { why: 'stuck', holder: 'ops' })).body
        : JSON.parse((await s.cli(['force-release', 'a-1', '--holder', 'ops', '--why', 'stuck', '--json'])).out[0]);
      const events = s.events().map(({ ts: _ts, actor, ...rest }) => ({ ...rest, actor: actor && { holder: actor.holder } }));
      return { answer, events, owner: s.owner('s24'), entries: s.entries().filter(entry => entry.startsWith('s24')), vias: forced(s).map(event => event.actor.via) };
    } finally { s.cleanup(); }
  };
  const [api, cli] = [await run('api'), await run('cli')];
  assert.deepEqual(api.vias, ['api']);
  assert.deepEqual(cli.vias, ['cli']);
  assert.deepEqual(api.answer, cli.answer);
  assert.deepEqual(api.events, cli.events);
  assert.deepEqual([api.owner, api.entries], [cli.owner, cli.entries]);
  assert.equal(api.events.filter(event => event.event === 'force-release').length, 1);
});

test('the route and the code are in the tables: POST /leases/{id}/force-release answers a ForceRelease, HUB_FORCE_RELEASE_JOB is 409 and exit 2', () => {
  assert.ok(ROUTES.some(route => route.method === 'POST' && route.path === '/leases/{id}/force-release' && route.shape === 'ForceRelease'));
  assert.equal(EXIT_CODES.HUB_FORCE_RELEASE_JOB, 2);
  assert.deepEqual(httpAnswerOf({ code: 'HUB_FORCE_RELEASE_JOB' }), { status: 409, reason: 'job' });
});
