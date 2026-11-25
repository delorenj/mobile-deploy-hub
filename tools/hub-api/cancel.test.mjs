// Story 7.5: POST /requests/{id}/cancel through handle(), and hub-device cancel through main(), on temp lock and event dirs: every row of the
// story's matrix, a live waiter on a single lock and a live Pool request (their own waits end naming the canceller), and the parity of the two front
// doors (same answer, same queue, same events minus `ts` and `actor.via`). No port is bound; adb, emulators and the real socket are never touched.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadDevices } from '../ci/lib/devices.mjs';
import { readEvents } from '../ci/lib/events.mjs';
import { acquireLease, acquirePool, readOwner, reserve, resourceOf } from '../ci/lib/lock.mjs';
import { loadPolicy } from '../ci/lib/policy.mjs';
import { hermetic } from '../ci/test-fixtures.mjs';
import { EXIT_CODES, checkCancelBody, httpAnswerOf } from '../device/claims.mjs';
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
  const root = mkdtempSync(join(tmpdir(), 'hub-api-cancel-'));
  const env = { PATH: process.env.PATH, HOME: root, HUB_LOCK_DIR: join(root, 'locks'), HUB_EVENT_DIR: join(root, 'events') };
  const devices = structuredClone(loadDevices({}));
  const now = () => T0;
  const s = {
    root, env,
    ctx: (extra = {}) => ({ env, policy, routes: ROUTES, now, hostId: 'test-host', devices, qaDevices: () => [], hostKey: () => 'linux', log: { out: () => {}, err: () => {} }, ...extra }),
    api: (id, body, extra) => handle({ method: 'POST', url: `/requests/${encodeURIComponent(id)}/cancel`, body }, s.ctx(extra)),
    take: (id = 'a-1', resource = 's24') => handle({ method: 'POST', url: '/leases', body: { resource, for_ms: 30 * MIN, holder: 'agent-a', why: 'proof', id } }, s.ctx()),
    cli: async argv => {
      const o = [];
      const e = [];
      const code = await hubDevice(argv, { env, stdout: line => o.push(line), stderr: line => e.push(line), inventory: () => ({ adb_servers: [], emulators: [], xvfb: [] }), adbWire: fakeWire({ listed: [] }), hostKey: () => 'linux', policy, qaDevices: () => [], now });
      return { code, out: o, err: e };
    },
    events: () => [...readEvents({ env })],
    owner: lock => readOwner(join(env.HUB_LOCK_DIR, `${lock}.lock`)),
    ownerText: lock => readFileSync(join(env.HUB_LOCK_DIR, `${lock}.lock`, 'owner.json'), 'utf8'),
    queue: lock => { try { return readdirSync(join(env.HUB_LOCK_DIR, `${lock}.queue`)).filter(file => file.endsWith('.json')); } catch { return []; } },
    // A waiter as any hub version writes it: a ticket in <name>.queue/, served by a live pid on this host. A Pool request's is the same file in every member's queue.
    wait: (lock, id, { holder = 'agent-b', why = 'wants the phone', pool = null, file = `${String(T0 - MIN).padStart(15, '0')}-000001-00000009.json`, kind = 'lease' } = {}) => {
      const queue = join(env.HUB_LOCK_DIR, `${lock}.queue`);
      mkdirSync(queue, { recursive: true });
      writeFileSync(join(queue, file), JSON.stringify({ format: 1, kind, lease_id: id, holder, why, pid: process.pid, host: hostname(), enqueued_at: iso(T0 - MIN), deadline_at: iso(T0 + 9 * MIN), pool, request: pool ? id : null }));
    },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
  return s;
}

const problemOf = answer => [answer.status, answer.body.code, answer.body.exit, answer.body.reason];
const cancels = s => s.events().filter(event => event.event === 'cancel');
const WAITER = { lease_id: 'b-1', holder: 'agent-b', why: 'wants the phone', kind: 'lease', enqueued_at: iso(T0 - MIN), deadline_at: iso(T0 + 9 * MIN), pool: null };

test('a single-lock waiter is cancelled by a caller that is not its holder: 200 Cancel, one cancel event with the actor, the Hold untouched', async () => {
  const s = scratch();
  try {
    assert.equal((await s.take()).status, 200);
    s.wait('s24', 'b-1');
    s.wait('s24', 'c-1', { holder: 'agent-c', file: `${String(T0 - MIN + 1).padStart(15, '0')}-000002-00000009.json` });
    const before = s.ownerText('s24');
    const answer = await s.api('b-1', { resource: 's24', holder: 'ops', why: 'stuck behind a dead run' });
    assert.equal(answer.status, 200, JSON.stringify(answer.body));
    assert.equal(answer.headers['Cache-Control'], 'no-store');
    assert.deepEqual(answer.body, {
      request_id: 'b-1', outcome: 'cancelled', resource: resourceOf('s24'), pool: null,
      queues: [{ lock: 's24', resource: resourceOf('s24'), waiters: [{ ...WAITER, place: 1, lease_id: 'c-1', holder: 'agent-c' }] }],
    });
    assert.deepEqual(s.queue('s24').length, 1, 'only the other waiter is left');
    const [event, ...more] = cancels(s);
    assert.equal(more.length, 0, 'one ending');
    assert.deepEqual([event.lock, event.lease_id, event.reason, event.why, event.actor, event.claimant.holder], ['s24', 'b-1', 'cancelled', 'stuck behind a dead run', { holder: 'ops', via: 'api' }, 'agent-b']);
    assert.equal(s.ownerText('s24'), before, 'the Hold is byte-identical');
    // An actor given in the body is recorded as given.
    s.wait('s24', 'd-1', { file: `${String(T0).padStart(15, '0')}-000003-00000009.json` });
    assert.equal((await s.api('d-1', { resource: 's24', actor: { holder: 'holocene', via: 'control-surface' } })).status, 200);
    assert.deepEqual(cancels(s).at(-1).actor, { holder: 'holocene', via: 'control-surface' });
    assert.equal('why' in cancels(s).at(-1), false);
  } finally { s.cleanup(); }
});

test('a live waiter on a single lock: its own wait ends HUB_LEASE_CANCELLED naming the canceller, and its ending is the one cancel event', async () => {
  const s = scratch();
  try {
    assert.equal((await s.take()).status, 200);
    const waiting = acquireLease('s24', { holder: 'waiter', why: 'wants it', forMs: 5 * MIN, waitMs: 5 * MIN, id: 'b-1', env: s.env, log: () => {}, now: () => T0, pollMs: 5, sleep: () => tick(5) });
    const settled = assert.rejects(waiting, error => error.code === 'HUB_LEASE_CANCELLED' && error.reason === 'cancelled' && /cancelled by ops/.test(error.message));
    await until(() => s.queue('s24').length === 1, 'queued');
    assert.equal((await s.api('b-1', { resource: 's24', holder: 'ops' })).status, 200);
    await settled;
    assert.deepEqual(s.events().filter(event => event.lease_id === 'b-1').map(event => event.event), ['request', 'cancel']);
    assert.deepEqual(readdirSync(join(s.env.HUB_LOCK_DIR, 's24.queue')), [], 'no ticket and no note is left');
  } finally { s.cleanup(); }
});

test('a phone Pool request: found only by its pool, taken out of every member queue, one Pool ending and no lock-level cancel', async () => {
  const s = scratch();
  try {
    await s.take('a-1', 's24');
    await s.take('a-2', 's26');
    const waiting = acquirePool('phone', ['s24', 'adb'], { holder: 'pooler', why: 'any phone', forMs: 5 * MIN, waitMs: 5 * MIN, id: 'p-1', env: s.env, log: () => {}, now: () => T0, pollMs: 5, sleep: () => tick(5), policy });
    const settled = assert.rejects(waiting, error => error.code === 'HUB_LEASE_CANCELLED' && error.cancel.actor.holder === 'ops');
    await until(() => s.queue('s24').length === 1 && s.queue('adb').length === 1, 'queued in both');
    assert.deepEqual(problemOf(await s.api('p-1', { resource: 's24', holder: 'ops' })), [404, 'HUB_REQUEST_NOT_FOUND', 2, 'unknown'], 'without its pool');
    assert.deepEqual(problemOf(await s.api('p-1', { resource: 's24', pool: 'emulator', holder: 'ops' })), [404, 'HUB_REQUEST_NOT_FOUND', 2, 'unknown'], 'with another pool');
    assert.equal(s.queue('s24').length + s.queue('adb').length, 2, 'nothing was removed');
    const answer = await s.api('p-1', { resource: 'phone', pool: 'phone', holder: 'ops', why: 'not needed' });
    assert.equal(answer.status, 200, JSON.stringify(answer.body));
    assert.deepEqual([answer.body.pool, answer.body.queues.map(queue => queue.lock), answer.body.queues.map(queue => queue.waiters)], ['phone', ['adb', 's24'], [[], []]]);
    await settled;
    assert.deepEqual([s.queue('s24'), s.queue('adb')], [[], []]);
    const ending = s.events().filter(event => event.request === 'p-1' && event.event !== 'request');
    assert.deepEqual(ending.map(event => [event.event, event.lock, event.reason, event.actor.holder, event.why]), [['cancel', null, 'cancelled', 'ops', 'not needed']], 'exactly one Pool ending');
    assert.equal(s.owner('s24').lease_id, 'a-1');
  } finally { s.cleanup(); }
});

test('an emulator request waiting on the gate: the gate ticket goes, the answer is the gate queue, the Pool word is accepted', async () => {
  const s = scratch();
  try {
    s.wait('emulator', 'e-1', { why: 'next for an emulator: tests' });
    s.wait('emulator', 'e-2', { holder: 'agent-c', file: `${String(T0 - MIN + 1).padStart(15, '0')}-000002-00000009.json` });
    assert.deepEqual(problemOf(await s.api('e-1', { resource: 'emulator', pool: 'phone', holder: 'ops' })), [404, 'HUB_REQUEST_NOT_FOUND', 2, 'unknown']);
    const answer = await s.api('e-1', { resource: 'emulator', pool: 'emulator', holder: 'ops' });
    assert.equal(answer.status, 200, JSON.stringify(answer.body));
    assert.deepEqual([answer.body.resource, answer.body.pool, answer.body.queues.map(queue => [queue.lock, queue.waiters.map(waiter => waiter.lease_id)])], [resourceOf('emulator'), 'emulator', [['emulator', ['e-2']]]]);
    assert.deepEqual(cancels(s).map(event => [event.lock, event.lease_id, event.actor.holder]), [['emulator', 'e-1', 'ops']]);
    assert.equal((await s.api('e-2', { resource: 'emulator', holder: 'ops' })).status, 200, 'no pool needed for the gate');
  } finally { s.cleanup(); }
});

test('an unknown id, and a request that already holds its lock: 404 HUB_REQUEST_NOT_FOUND (unknown, held), exit 2, nothing written', async () => {
  const s = scratch();
  try {
    await s.take();
    const before = s.ownerText('s24');
    const events = s.events().length;
    const unknown = await s.api('nobody', { resource: 's24', holder: 'ops' });
    assert.deepEqual(problemOf(unknown), [404, 'HUB_REQUEST_NOT_FOUND', 2, 'unknown']);
    assert.match(unknown.body.detail, /no request waits under the id "nobody" on s24/);
    const held = await s.api('a-1', { resource: 's24', holder: 'ops' });
    assert.deepEqual(problemOf(held), [404, 'HUB_REQUEST_NOT_FOUND', 2, 'held']);
    assert.match(held.body.detail, /release it/);
    assert.deepEqual(problemOf(await s.api('a-1', { resource: 'no-such-phone', holder: 'ops' })), [404, 'HUB_REQUEST_NOT_FOUND', 2, 'unknown']);
    assert.equal(s.ownerText('s24'), before);
    assert.equal(s.events().length, events);
    const cli = await s.cli(['cancel', 'a-1', '--resource', 's24']);
    assert.deepEqual([cli.code, cli.out, cli.err[0].startsWith('HUB_REQUEST_NOT_FOUND request a-1 already holds')], [2, [], true]);
    assert.equal((await s.cli(['cancel', 'nobody'])).code, 2);
    assert.equal(EXIT_CODES.HUB_REQUEST_NOT_FOUND, 2);
    assert.deepEqual(httpAnswerOf({ code: 'HUB_REQUEST_NOT_FOUND' }), { status: 404 });
  } finally { s.cleanup(); }
});

test('a job id, and a Reservation key: 400 HUB_DEVICE_JOB_ID and 409 HUB_CANCEL_RESERVATION, both exit 2, with the queue and the Reservation as they were', async () => {
  const s = scratch();
  try {
    const job = 'job:acme/app#1.1/deploy';
    const refused = await s.api(job, { resource: 's26', holder: 'ops' });
    assert.deepEqual(problemOf(refused), [400, 'HUB_DEVICE_JOB_ID', 2, 'hub_device_job_id']);
    assert.match(refused.body.detail, /gh run cancel 1 --repo acme\/app/);
    const cli = await s.cli(['cancel', job]);
    assert.deepEqual([cli.code, cli.err[0].startsWith('HUB_DEVICE_JOB_ID ')], [2, true]);
    // The ticket of a deploy job under a plain id is a job's too.
    s.wait('adb', 'run-ticket', { kind: 'job' });
    assert.deepEqual(problemOf(await s.api('run-ticket', { resource: 's26', holder: 'ops' })), [400, 'HUB_DEVICE_JOB_ID', 2, 'hub_device_job_id']);
    assert.equal(s.queue('adb').length, 1, 'the job ticket stands');
    assert.equal(reserve('adb', { env: { ...s.env, GITHUB_REPOSITORY: 'acme/app', GITHUB_RUN_ID: '77' }, now: () => T0, log: () => {} }).status, 'claimed');
    const reserved = await s.api('acme--app--77', { resource: 's26', holder: 'ops' });
    assert.deepEqual(problemOf(reserved), [409, 'HUB_CANCEL_RESERVATION', 2, 'reservation']);
    assert.match(reserved.body.detail, /force-release/);
    assert.deepEqual([(await s.cli(['cancel', 'acme--app--77', '--resource', 's26'])).code, readdirSync(join(s.env.HUB_LOCK_DIR, 'adb.reservations')).length], [2, 1]);
  } finally { s.cleanup(); }
});

test('a wrong host is 409 HUB_WRONG_HOST, an unreadable own host key 503 HUB_HOST_UNKNOWN, and either leaves the waiter where it is', async () => {
  const s = scratch();
  try {
    await s.take();
    s.wait('s24', 'b-1');
    assert.deepEqual(problemOf(await s.api('b-1', { resource: 's24', host: 'mac', holder: 'ops' })), [409, 'HUB_WRONG_HOST', 2, 'wrong-host']);
    const unknown = () => { throw Object.assign(new Error('this host does not know which host it is'), { code: 'HUB_HOST_UNKNOWN' }); };
    assert.deepEqual(problemOf(await s.api('b-1', { resource: 's24', host: 'linux', holder: 'ops' }, { hostKey: unknown })), [503, 'HUB_HOST_UNKNOWN', 1, 'host-unknown']);
    assert.equal(s.queue('s24').length, 1);
    assert.equal((await s.api('b-1', { resource: 's24', host: 'linux', holder: 'ops' })).status, 200, 'this host\'s own key is fine');
    // No `host` key in the body asks nothing of the host key file.
    s.wait('s24', 'b-2');
    assert.equal((await s.api('b-2', { resource: 's24', holder: 'ops' }, { hostKey: unknown })).status, 200);
  } finally { s.cleanup(); }
});

test('a bad body is 400 HUB_USAGE with its reason, before anything is read', async () => {
  const s = scratch();
  try {
    await s.take();
    s.wait('s24', 'b-1');
    const bad = [
      [null, 'bad-body'], [[], 'bad-body'], [{ resource: 's24', holder: 'ops', extra: 1 }, 'bad-body'],
      [{ holder: 'ops' }, 'no-resource'], [{ resource: '', holder: 'ops' }, 'bad-resource'], [{ resource: 7, holder: 'ops' }, 'bad-resource'],
      [{ resource: 's24', pool: 5, holder: 'ops' }, 'bad-pool'], [{ resource: 's24', pool: '', holder: 'ops' }, 'bad-pool'],
      [{ resource: 's24', host: 5, holder: 'ops' }, 'bad-host'], [{ resource: 's24', why: '  ', holder: 'ops' }, 'bad-why'], [{ resource: 's24', why: 3, holder: 'ops' }, 'bad-why'],
      [{ resource: 's24', actor: { holder: 'x', via: 'telepathy' } }, 'bad-actor'], [{ resource: 's24', actor: 'ops' }, 'bad-actor'],
      [{ resource: 's24' }, 'no-holder'], [{ resource: 's24', holder: ' ' }, 'no-holder'],
    ];
    for (const [body, reason] of bad) {
      const answer = await s.api('b-1', body);
      assert.deepEqual(problemOf(answer), [400, 'HUB_USAGE', 2, reason], JSON.stringify(body));
    }
    assert.equal(s.queue('s24').length, 1, 'nothing was cancelled');
    assert.deepEqual(checkCancelBody({ resource: 's24', pool: 'phone', host: 'linux', why: 'x', holder: 'ops' }), { resource: 's24', pool: 'phone', host: 'linux', why: 'x', holder: 'ops', actor: null });
  } finally { s.cleanup(); }
});

test('the CLI: finds the request on this host without --resource, takes --pool and --why, prints the marker or --json, and exit 2 for a usage mistake', async () => {
  const s = scratch();
  try {
    await s.take('a-1', 's24');
    await s.take('a-2', 's26');
    s.wait('s24', 'b-1');
    const named = await s.cli(['cancel', 'b-1', '--why', 'dead run', '--holder', 'jarad']);
    assert.deepEqual([named.code, named.out, named.err], [0, [`HUB_DEVICE_CANCELLED ${resourceOf('s24')} b-1`], []]);
    assert.deepEqual([cancels(s).at(-1).actor, cancels(s).at(-1).why], [{ holder: 'jarad', via: 'cli' }, 'dead run']);
    // A Pool request: located by the id alone, or named with its pool.
    const file = `${String(T0).padStart(15, '0')}-000005-00000009.json`;
    s.wait('s24', 'p-1', { pool: 'phone', file });
    s.wait('adb', 'p-1', { pool: 'phone', file });
    const pooled = await s.cli(['cancel', 'p-1', '--resource', 'phone', '--pool', 'phone', '--json']);
    assert.equal(pooled.code, 0);
    assert.deepEqual([JSON.parse(pooled.out[0]).pool, JSON.parse(pooled.out[0]).queues.map(queue => queue.lock)], ['phone', ['adb', 's24']]);
    assert.deepEqual([s.queue('s24'), s.queue('adb')], [[], []]);
    assert.equal((await s.cli(['cancel'])).code, 2);
    assert.equal((await s.cli(['cancel', 'a', 'b'])).code, 2);
    assert.equal((await s.cli(['cancel', 'b-1', '--why', ' '])).code, 2);
    assert.equal((await s.cli(['release', 'a-1', '--resource', 's24'])).code, 2, '--resource belongs to cancel');
    assert.equal((await s.cli(['cancel', 'b-1', '--host', 'linux'])).code, 2, '--host belongs to registry');
  } finally { s.cleanup(); }
});

test('parity: the same setup cancelled through the CLI and through the API leaves the same answer, queue and events (minus ts and actor.via)', async () => {
  const run = async how => {
    const s = scratch();
    try {
      await s.take();
      s.wait('s24', 'b-1');
      s.wait('s24', 'c-1', { holder: 'agent-c', file: `${String(T0 - MIN + 1).padStart(15, '0')}-000002-00000009.json` });
      const answer = how === 'api'
        ? (await s.api('b-1', { resource: 's24', holder: 'ops', why: 'stuck' })).body
        : JSON.parse((await s.cli(['cancel', 'b-1', '--resource', 's24', '--holder', 'ops', '--why', 'stuck', '--json'])).out[0]);
      const events = s.events().map(({ ts: _ts, actor, ...rest }) => ({ ...rest, actor: actor && { holder: actor.holder } }));
      return { answer, events, queue: s.queue('s24').length, owner: s.owner('s24').lease_id, vias: cancels(s).map(event => event.actor.via) };
    } finally { s.cleanup(); }
  };
  const [api, cli] = [await run('api'), await run('cli')];
  assert.deepEqual(api.vias, ['api']);
  assert.deepEqual(cli.vias, ['cli']);
  assert.deepEqual(api.answer, cli.answer);
  assert.deepEqual(api.events, cli.events);
  assert.deepEqual([api.queue, api.owner], [cli.queue, cli.owner]);
  assert.equal(api.events.filter(event => event.event === 'cancel').length, 1);
});

test('the route is in the table: POST /requests/{id}/cancel answers a Cancel', () => {
  assert.ok(ROUTES.some(route => route.method === 'POST' && route.path === '/requests/{id}/cancel' && route.shape === 'Cancel'));
});
