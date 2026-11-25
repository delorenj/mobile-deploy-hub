// Story 7.2: a wait for a Lease through the API (`POST /leases` with `wait_ms`, `GET /leases/{id}`). Every row of the story's I/O matrix goes
// through `requestListener` / `handle()` with a fake request and a fake `res` (an EventEmitter with `writableFinished`), a clock that only the
// test moves and a `sleep` that only the test wakes. No socket, adb or emulator is touched.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadDevices } from '../ci/lib/devices.mjs';
import { readEvents } from '../ci/lib/events.mjs';
import { acquireLease, localHost, readOwner, releaseLease } from '../ci/lib/lock.mjs';
import { loadPolicy } from '../ci/lib/policy.mjs';
import { hermetic } from '../ci/test-fixtures.mjs';
import { createLeaseWaits, findLease } from '../device/claims.mjs';
import { ROUTES, handle } from './routes.mjs';
import { requestListener, startHubApi } from './server.mjs';

hermetic();

const HOST = 'test-host';
const policy = loadPolicy().policy;
const MIN = 60_000;
const BODY = { resource: 's24', for_ms: 30 * MIN, holder: 'agent-a', why: 'proof' };
const flush = async (rounds = 6) => { for (let round = 0; round < rounds; round += 1) await new Promise(done => setImmediate(done)); };

// A clock and a sleep the test drives: `tick()` wakes every sleeper once, `advance(ms)` moves the clock.
function clockOf() {
  let at = Date.parse('2026-11-25T10:00:00Z');
  let sleepers = [];
  return {
    now: () => at,
    advance: ms => { at += ms; },
    sleep: () => new Promise(done => { sleepers.push(done); }),
    tick: async () => { const wake = sleepers; sleepers = []; for (const done of wake) done(); await flush(); },
  };
}

function scratch() {
  const root = mkdtempSync(join(tmpdir(), 'hub-api-waits-'));
  const env = { PATH: process.env.PATH, HOME: root, HUB_LOCK_DIR: join(root, 'locks'), HUB_EVENT_DIR: join(root, 'events') };
  const devices = structuredClone(loadDevices({}));
  const clock = clockOf();
  const out = [];
  const err = [];
  const lines = [];
  const s = {
    root, env, devices, clock, out, err, lines, onLine: () => {},
    waits: createLeaseWaits({ now: clock.now }),
    ctx: (more = {}) => ({
      env, policy, routes: ROUTES, now: clock.now, sleep: clock.sleep, hostId: HOST, devices, qaDevices: () => [], waits: s.waits,
      log: { out: line => { out.push(line); lines.push(['out', line]); s.onLine(line); }, err: line => { err.push(line); lines.push(['err', line]); } }, ...more,
    }),
    events: () => [...readEvents({ env })].filter(event => event.claimant !== undefined),
    owner: lock => readOwner(join(env.HUB_LOCK_DIR, `${lock}.lock`)),
    tickets: lock => { try { return readdirSync(join(env.HUB_LOCK_DIR, `${lock}.queue`)).filter(file => file.endsWith('.json')); } catch { return []; } },
    ticket: lock => JSON.parse(readFileSync(join(env.HUB_LOCK_DIR, `${lock}.queue`, s.tickets(lock)[0]), 'utf8')),
    // Somebody else's Hold on a lock, the thing a wait waits for.
    hold: (lock, id = `holder-${lock}`) => acquireLease(lock, { holder: `holder-${lock}`, why: 'blocking', forMs: 50 * MIN, id, env, log: () => {}, now: clock.now }),
    free: (lock, id = `holder-${lock}`) => releaseLease(lock, id, { env, now: clock.now }),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
  return s;
}

// A fake node request and response. `end` finishes the response and closes it, as node does; `drop()` is a client that went away.
function exchange(method, url, body) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
  const req = { method, url, async *[Symbol.asyncIterator]() { for (const chunk of chunks) yield chunk; } };
  const res = Object.assign(new EventEmitter(), {
    writableFinished: false, head: null, text: null, calls: [],
    writeHead(status, headers) { this.calls.push('writeHead'); this.head = { status, headers }; },
    end(text) { this.calls.push('end'); this.text = text; this.writableFinished = true; this.emit('close'); },
    drop() { this.emit('close'); },
  });
  return { req, res, json: () => JSON.parse(res.text), status: () => res.head?.status };
}

// Starts a request through the listener without waiting for its answer.
async function start(listener, body, { method = 'POST', url = '/leases' } = {}) {
  const e = exchange(method, url, body);
  e.done = listener(e.req, e.res);
  await flush();
  return e;
}

const problemOf = e => [e.status(), e.json().code, e.json().exit, e.json().reason];
const forLease = (s, id) => s.events().filter(event => event.lease_id === id);
const WAIT = { ...BODY, id: 'w-1', wait_ms: 60_000 };

test('a wait that is freed in time: nothing is written while it waits, the ticket is the service\'s, then 200 with X-Request-Id', async () => {
  const s = scratch();
  try {
    await s.hold('s24');
    const listener = requestListener(s.ctx());
    const e = await start(listener, WAIT);
    assert.deepEqual(e.res.calls, [], 'neither writeHead nor end while the wait is open');
    assert.equal(s.waits.size, 1);
    const ticket = s.ticket('s24');
    assert.deepEqual([ticket.lease_id, ticket.pid, ticket.claimant_kind, ticket.kind], ['w-1', process.pid, 'agent', 'lease']);
    s.free('s24');
    await s.clock.tick();
    await e.done;
    assert.equal(e.status(), 200, e.res.text);
    assert.equal(e.res.head.headers['X-Request-Id'], 'w-1');
    assert.equal(e.res.head.headers['Cache-Control'], 'no-store');
    assert.deepEqual([e.json().lease_id, e.json().lock, e.json().holder], ['w-1', 's24', 'agent-a']);
    assert.equal(s.owner('s24').holder_pid, null, 'the wait is lock-only, like any API Lease');
    assert.deepEqual(forLease(s, 'w-1').map(event => event.event), ['request', 'acquire']);
    assert.deepEqual(s.tickets('s24'), []);
    assert.equal(s.waits.size, 0);
    assert.deepEqual(s.events().filter(event => event.event === 'request').map(event => event.actor), [{ holder: 'agent-a', via: 'api' }]);
  } finally { s.cleanup(); }
});

test('a person who waits: the ticket and the events say person', async () => {
  const s = scratch();
  try {
    await s.hold('s24');
    const e = await start(requestListener(s.ctx()), { ...WAIT, claimant_kind: 'person' });
    assert.equal(s.ticket('s24').claimant_kind, 'person');
    s.free('s24');
    await s.clock.tick();
    await e.done;
    assert.equal(e.status(), 200);
    assert.deepEqual(forLease(s, 'w-1').map(event => [event.event, event.claimant.kind]), [['request', 'person'], ['acquire', 'person']]);
  } finally { s.cleanup(); }
});

test('a wait that times out: 409 HUB_LOCK_TIMEOUT exit 76 busy, the detail says who holds it, one timeout event', async () => {
  const s = scratch();
  try {
    await s.hold('s24');
    const e = await start(requestListener(s.ctx()), { ...WAIT, wait_ms: 5000 });
    assert.deepEqual(e.res.calls, []);
    s.clock.advance(5001);
    await s.clock.tick();
    await e.done;
    assert.deepEqual(problemOf(e), [409, 'HUB_LOCK_TIMEOUT', 76, 'busy']);
    assert.match(e.json().detail, /^host lock s24 is held by lease holder-s24 of holder-s24 /);
    assert.equal(e.res.head.headers['X-Request-Id'], 'w-1');
    assert.deepEqual(forLease(s, 'w-1').map(event => [event.event, event.reason]), [['request', null], ['timeout', 'deadline']]);
    assert.deepEqual(s.tickets('s24'), []);
    assert.equal(s.err.length, 0, 'a library refusal is no HUB_API_ERROR');
  } finally { s.cleanup(); }
});

test('a Pool wait that times out: the same 409, and the detail starts host lock <lock> is held by', async () => {
  const s = scratch();
  try {
    await s.hold('s24');
    await s.hold('adb');
    const e = await start(requestListener(s.ctx()), { ...WAIT, resource: 'phone', wait_ms: 4000 });
    assert.deepEqual(e.res.calls, []);
    for (const lock of ['s24', 'adb']) assert.deepEqual([s.ticket(lock).pool, s.ticket(lock).claimant_kind, s.ticket(lock).pid], ['phone', 'agent', process.pid]);
    s.clock.advance(4001);
    await s.clock.tick();
    await e.done;
    assert.deepEqual(problemOf(e), [409, 'HUB_LOCK_TIMEOUT', 76, 'busy']);
    assert.match(e.json().detail, /^host lock s24 is held by lease holder-s24 .*; host lock adb is held by lease holder-adb .* \(every phone is held\); gave up after 4s$/);
    assert.deepEqual([s.tickets('s24'), s.tickets('adb')], [[], []]);
    assert.deepEqual(s.events().filter(event => event.lease_id === 'w-1' || event.request === 'w-1').map(event => event.event), ['request', 'timeout']);
  } finally { s.cleanup(); }
});

test('a match wait that times out also keeps the host lock wording', async () => {
  const s = scratch();
  try {
    await s.hold('s24');
    await s.hold('adb');
    const e = await start(requestListener(s.ctx()), { match: 'kind=phone', for_ms: 30 * MIN, holder: 'agent-a', why: 'proof', id: 'm-1', wait_ms: 3000 });
    s.clock.advance(3001);
    await s.clock.tick();
    await e.done;
    assert.deepEqual(problemOf(e), [409, 'HUB_LOCK_TIMEOUT', 76, 'busy']);
    assert.match(e.json().detail, /^host lock (s24|adb) is held by /);
  } finally { s.cleanup(); }
});

test('a wait with no id, or a bad wait, is 400 HUB_USAGE and nothing is written', async () => {
  const s = scratch();
  try {
    await s.hold('s24');
    const before = s.events().length;
    const noId = await handle({ method: 'POST', url: '/leases', body: { ...BODY, wait_ms: 1000 } }, s.ctx());
    assert.deepEqual([noId.status, noId.body.code, noId.body.reason], [400, 'HUB_USAGE', 'no-id']);
    assert.equal(noId.headers['X-Request-Id'], undefined, 'no id, nothing to echo');
    const bad = await handle({ method: 'POST', url: '/leases', body: { ...BODY, id: 'w-9', wait_ms: -5 } }, s.ctx());
    assert.deepEqual([bad.status, bad.body.reason, bad.headers['X-Request-Id']], [400, 'bad-wait', 'w-9'], 'a refusal that knows the id echoes it');
    const junk = await handle({ method: 'POST', url: '/leases', body: { ...BODY, id: 'Bad\r\nId', wait_ms: 1 } }, s.ctx());
    assert.deepEqual([junk.status, junk.body.reason, junk.headers['X-Request-Id']], [400, 'bad-id', undefined], 'an id that is not a lease id is never echoed into a header');
    assert.equal(s.events().length, before);
    assert.deepEqual(s.tickets('s24'), []);
    assert.equal(s.waits.size, 0);
  } finally { s.cleanup(); }
});

test('a disconnect mid-wait aborts it: the ticket is gone, one cancel (aborted), and nothing is written to the socket', async () => {
  const s = scratch();
  try {
    await s.hold('s24');
    const e = await start(requestListener(s.ctx()), WAIT);
    assert.equal(s.tickets('s24').length, 1);
    e.res.drop();
    await flush();
    await e.done;
    assert.deepEqual(e.res.calls, [], 'nothing was written');
    assert.deepEqual(s.tickets('s24'), []);
    assert.deepEqual(forLease(s, 'w-1').map(event => [event.event, event.reason]), [['request', null], ['cancel', 'aborted']]);
    assert.equal(s.events().at(-1).event, 'cancel');
    assert.equal(s.waits.size, 0);
    // The lock is still the other holder's: nothing was granted.
    assert.equal(s.owner('s24').lease_id, 'holder-s24');
  } finally { s.cleanup(); }
});

test('a disconnect during a Pool wait leaves every member\'s queue with one Pool cancel (aborted)', async () => {
  const s = scratch();
  try {
    await s.hold('s24');
    await s.hold('adb');
    const e = await start(requestListener(s.ctx()), { ...WAIT, resource: 'phone' });
    assert.deepEqual([s.tickets('s24').length, s.tickets('adb').length], [1, 1]);
    e.res.drop();
    await flush();
    await e.done;
    assert.deepEqual(e.res.calls, []);
    assert.deepEqual([s.tickets('s24'), s.tickets('adb')], [[], []]);
    const mine = s.events().filter(event => event.request === 'w-1');
    assert.deepEqual(mine.map(event => [event.event, event.reason]), [['request', null], ['cancel', 'aborted']]);
  } finally { s.cleanup(); }
});

test('a Hold granted after the connection closed is released at once (undelivered) and nothing is written', async () => {
  const s = scratch();
  try {
    await s.hold('s24');
    const e = await start(requestListener(s.ctx()), WAIT);
    // acquireLease prints HUB_LEASE synchronously at the grant: the client goes away at exactly that moment.
    s.onLine = line => { if (/^HUB_LEASE s24 w-1 /.test(line)) e.res.drop(); };
    s.free('s24');
    await s.clock.tick();
    await e.done;
    assert.deepEqual(e.res.calls, []);
    assert.equal(s.owner('s24'), null, 'the Hold nobody received is gone');
    assert.deepEqual(forLease(s, 'w-1').map(event => [event.event, event.reason]), [['request', null], ['acquire', null], ['release', 'undelivered']]);
    assert.deepEqual(s.tickets('s24'), []);
    const after = await handle({ method: 'GET', url: '/leases/w-1' }, s.ctx());
    assert.deepEqual([after.status, after.body.reason], [404, 'unknown']);
  } finally { s.cleanup(); }
});

test('a try whose connection closed before it was handled takes nothing and writes no event', async () => {
  const s = scratch();
  try {
    const e = exchange('POST', '/leases', { ...BODY, id: 'try-1' });
    // The client goes away while its request is still being read.
    const chunks = e.req[Symbol.asyncIterator];
    e.req[Symbol.asyncIterator] = async function* gone() { yield* chunks.call(e.req); e.res.drop(); };
    await requestListener(s.ctx())(e.req, e.res);
    assert.deepEqual(e.res.calls, []);
    assert.equal(s.owner('s24'), null, 'an aborted try takes nothing');
    assert.deepEqual(s.events(), []);
  } finally { s.cleanup(); }
});

test('a Hold granted and answered stays after the connection closes, and GET /leases/{id} returns it', async () => {
  const s = scratch();
  try {
    await s.hold('s24');
    const e = await start(requestListener(s.ctx()), WAIT);
    s.free('s24');
    await s.clock.tick();
    await e.done;
    assert.equal(e.status(), 200);
    e.res.drop();
    await flush();
    assert.equal(s.owner('s24').lease_id, 'w-1', 'the Hold stands');
    const got = await handle({ method: 'GET', url: '/leases/w-1' }, s.ctx());
    assert.equal(got.status, 200);
    assert.deepEqual(got.body, e.json());
    assert.equal(got.headers['Cache-Control'], 'no-store');
    assert.deepEqual(forLease(s, 'w-1').map(event => event.event), ['request', 'acquire'], 'no release of the Hold');
  } finally { s.cleanup(); }
});

test('GET /leases/{id}: held is 200 Lease, a waiter is 404 waiting, an unknown id is 404 unknown (both HUB_LEASE_NOT_FOUND, exit 2)', async () => {
  const s = scratch();
  try {
    await s.hold('s24');
    const waiter = await start(requestListener(s.ctx()), WAIT);
    const waiting = await handle({ method: 'GET', url: '/leases/w-1' }, s.ctx());
    assert.deepEqual([waiting.status, waiting.body.code, waiting.body.exit, waiting.body.reason], [404, 'HUB_LEASE_NOT_FOUND', 2, 'waiting']);
    const unknown = await handle({ method: 'GET', url: '/leases/never-1' }, s.ctx());
    assert.deepEqual([unknown.status, unknown.body.code, unknown.body.exit, unknown.body.reason], [404, 'HUB_LEASE_NOT_FOUND', 2, 'unknown']);
    const held = await handle({ method: 'GET', url: '/leases/holder-s24' }, s.ctx());
    assert.equal(held.status, 200);
    assert.deepEqual([held.body.lease_id, held.body.lock, held.body.holder, held.body.claimant_kind], ['holder-s24', 's24', 'holder-s24', 'agent']);
    assert.deepEqual(Object.keys(held.body).sort(), ['claimant_kind', 'device', 'env', 'expires_at', 'holder', 'lease_id', 'lock', 'resource', 'started_at', 'why']);
    assert.deepEqual(Object.keys(held.body.env).sort(), ['ANDROID_ADB_SERVER_PORT', 'HUB_DEVICE', 'HUB_LEASE_ID']);
    const post = await handle({ method: 'POST', url: '/leases/w-1', body: {} }, s.ctx());
    assert.deepEqual([post.status, post.headers.Allow], [405, 'GET']);
    assert.throws(() => findLease('never-1', { env: s.env }), error => error.code === 'HUB_LEASE_NOT_FOUND');
    waiter.res.drop();
    await flush();
  } finally { s.cleanup(); }
});

test('GET /leases/{id} of a Lease taken with a connect shows the recorded device in its env, not the lock-only defaults', async () => {
  const s = scratch();
  try {
    await s.hold('s24', 'conn-1');
    const file = join(s.env.HUB_LOCK_DIR, 's24.lock', 'owner.json');
    const record = JSON.parse(readFileSync(file, 'utf8'));
    writeFileSync(file, JSON.stringify({ ...record, device: { phone: 's24', serial: 'R5CT1234', adb_id: '192.168.1.40:41234', adb_port: 5099 } }));
    const got = await handle({ method: 'GET', url: '/leases/conn-1' }, s.ctx());
    assert.equal(got.status, 200);
    assert.deepEqual([got.body.device, got.body.lock], ['s24', 's24']);
    assert.deepEqual(got.body.env, { HUB_LEASE_ID: 'conn-1', HUB_DEVICE: 's24', ANDROID_ADB_SERVER_PORT: '5099', ANDROID_SERIAL: '192.168.1.40:41234' });
  } finally { s.cleanup(); }
});

test('a repeat of an id the same holder already holds answers the existing Lease: no second take, no event, with or without a wait', async () => {
  const s = scratch();
  try {
    const listener = requestListener(s.ctx());
    const first = await start(listener, { ...BODY, id: 'rep-1' });
    assert.equal(first.status(), 200);
    const before = s.events().length;
    const again = await start(listener, { ...BODY, id: 'rep-1' });
    const waited = await start(listener, { ...BODY, id: 'rep-1', wait_ms: 5000 });
    for (const e of [again, waited]) {
      assert.equal(e.status(), 200);
      assert.deepEqual(e.json(), first.json());
      assert.equal(e.res.head.headers['X-Request-Id'], 'rep-1');
    }
    assert.equal(s.events().length, before);
    assert.equal(s.waits.size, 0);
    // A different holder is a taken id, as in 7.1.
    const other = await start(listener, { ...BODY, id: 'rep-1', holder: 'agent-b' });
    assert.deepEqual([other.status(), other.json().code], [400, 'HUB_USAGE']);
    assert.match(other.json().detail, /already names a lease/);
    const otherWait = await start(listener, { ...BODY, id: 'rep-1', holder: 'agent-b', wait_ms: 5000 });
    assert.deepEqual([otherWait.status(), otherWait.json().code], [400, 'HUB_USAGE']);
    assert.equal(s.events().length, before);
  } finally { s.cleanup(); }
});

test('a repeat of a wait that is still open takes it over: the old connection gets 409 HUB_LEASE_SUPERSEDED, the new one the Lease, one request and one acquire', async () => {
  const s = scratch();
  try {
    await s.hold('s24');
    const listener = requestListener(s.ctx());
    const first = await start(listener, WAIT);
    const ticketBefore = s.tickets('s24');
    // The repeat names other terms: they are ignored, the wait is the original request.
    const second = await start(listener, { ...WAIT, resource: 's26', for_ms: 5 * MIN, wait_ms: 1 });
    assert.deepEqual(problemOf(first), [409, 'HUB_LEASE_SUPERSEDED', 1, 'superseded']);
    assert.equal(first.res.head.headers['X-Request-Id'], 'w-1');
    assert.deepEqual(second.res.calls, [], 'the new connection waits');
    assert.deepEqual(s.tickets('s24'), ticketBefore, 'the place in line is kept');
    assert.equal(s.waits.size, 1);
    // The old connection closing later changes nothing.
    first.res.drop();
    await flush();
    assert.equal(s.tickets('s24').length, 1);
    s.free('s24');
    await s.clock.tick();
    await second.done;
    assert.equal(second.status(), 200, second.res.text);
    assert.deepEqual([second.json().lock, second.json().resource, new Date(second.json().expires_at).getTime() - new Date(second.json().started_at).getTime()], ['s24', 's24', 30 * MIN]);
    assert.deepEqual(forLease(s, 'w-1').map(event => event.event), ['request', 'acquire'], 'a takeover is not a cancel');
    assert.equal(s.waits.size, 0);
  } finally { s.cleanup(); }
});

test('a takeover keeps the original deadline: the wait times out when the first request said, answering the new connection', async () => {
  const s = scratch();
  try {
    await s.hold('s24');
    const listener = requestListener(s.ctx());
    await start(listener, { ...WAIT, wait_ms: 5000 });
    const second = await start(listener, { ...WAIT, wait_ms: 900_000 });
    s.clock.advance(5001);
    await s.clock.tick();
    await second.done;
    assert.deepEqual(problemOf(second), [409, 'HUB_LOCK_TIMEOUT', 76, 'busy']);
  } finally { s.cleanup(); }
});

test('the registry: only the current connection\'s disconnect aborts the wait; a superseded one closing does not', async () => {
  const s = scratch();
  try {
    await s.hold('s24');
    const service = { env: s.env, policy, now: s.clock.now, sleep: s.clock.sleep, qaDevices: () => [], log: () => {}, warn: () => {} };
    const input = { resource: 's24', match: null, forMs: 30 * MIN, waitMs: 60_000, holder: 'agent-a', why: 'proof', claimantKind: 'agent', id: 'reg-1', actor: { holder: 'agent-a', via: 'api' } };
    const a = new AbortController();
    const b = new AbortController();
    const first = s.waits.lease(input, service, { signal: a.signal });
    first.catch(() => {});
    await flush();
    const second = s.waits.lease(input, service, { signal: b.signal });
    second.catch(() => {});
    await assert.rejects(first, { code: 'HUB_LEASE_SUPERSEDED' });
    a.abort();
    await flush();
    assert.equal(s.waits.size, 1, 'the superseded connection no longer owns the wait');
    assert.equal(s.tickets('s24').length, 1);
    b.abort();
    await flush();
    await assert.rejects(second, error => error.code === 'HUB_LEASE_CANCELLED' && error.reason === 'disconnected');
    assert.deepEqual(forLease(s, 'reg-1').map(event => [event.event, event.reason]), [['request', null], ['cancel', 'aborted']]);
    assert.equal(s.waits.size, 0);
    // A request whose connection was already gone on arrival never keeps a place.
    const gone = new AbortController();
    gone.abort();
    await assert.rejects(s.waits.lease({ ...input, id: 'reg-2' }, service, { signal: gone.signal }), { code: 'HUB_LEASE_CANCELLED' });
    assert.deepEqual(s.tickets('s24'), []);
  } finally { s.cleanup(); }
});

test('the registry: a repeat sent while the first connection\'s abort is still unwinding gets a fresh wait, not HUB_LEASE_CANCELLED', async () => {
  const s = scratch();
  try {
    await s.hold('s24');
    const service = { env: s.env, policy, now: s.clock.now, sleep: s.clock.sleep, qaDevices: () => [], log: () => {}, warn: () => {} };
    const input = { resource: 's24', match: null, forMs: 30 * MIN, waitMs: 60_000, holder: 'agent-a', why: 'proof', claimantKind: 'agent', id: 'reg-4', actor: { holder: 'agent-a', via: 'api' } };
    const a = new AbortController();
    const first = s.waits.lease(input, service, { signal: a.signal });
    first.catch(() => {});
    await flush();
    a.abort();
    // No flush: the first wait has not unwound yet when the same request arrives again.
    const second = s.waits.lease(input, service, { signal: new AbortController().signal });
    second.catch(() => {});
    await assert.rejects(first, { code: 'HUB_LEASE_CANCELLED' });
    await flush();
    assert.equal(s.waits.size, 1, 'the repeat is a new wait');
    assert.equal(s.tickets('s24').length, 1, 'with a new ticket');
    s.free('s24');
    await s.clock.tick();
    const view = await second;
    assert.deepEqual([view.lease_id, view.lock], ['reg-4', 's24']);
    assert.deepEqual(forLease(s, 'reg-4').map(event => [event.event, event.reason]), [['request', null], ['cancel', 'aborted'], ['request', null], ['acquire', null]]);
    assert.equal(s.waits.size, 0);
  } finally { s.cleanup(); }
});

test('the registry: another holder\'s repeat of an open wait is a taken id, never a takeover', async () => {
  const s = scratch();
  try {
    await s.hold('s24');
    const service = { env: s.env, policy, now: s.clock.now, sleep: s.clock.sleep, qaDevices: () => [], log: () => {}, warn: () => {} };
    const input = { resource: 's24', match: null, forMs: 30 * MIN, waitMs: 60_000, holder: 'agent-a', why: 'proof', claimantKind: 'agent', id: 'reg-3', actor: { holder: 'agent-a', via: 'api' } };
    const a = new AbortController();
    const first = s.waits.lease(input, service, { signal: a.signal });
    first.catch(() => {});
    await flush();
    await assert.rejects(s.waits.lease({ ...input, holder: 'agent-b' }, service, { signal: new AbortController().signal }), error => error.code === 'HUB_USAGE' && /already names a lease/.test(error.message));
    assert.equal(s.waits.size, 1);
    a.abort();
    await flush();
    await assert.rejects(first, { code: 'HUB_LEASE_CANCELLED' });
  } finally { s.cleanup(); }
});

test('SIGTERM with open waits: each answers 503 HUB_API_RESTARTING (retry requeue), tickets are aborted, then the server closes and HUB_API_STOP is logged', async () => {
  const s = scratch();
  try {
    await s.hold('s24');
    await s.hold('adb');
    const order = [];
    class FakeServer extends EventEmitter {
      constructor(listener) { super(); this.listener = listener; }
      listen(port, host, callback) { process.nextTick(callback); return this; }
      address() { return { port: 1 }; }
      close(callback) { order.push('close'); process.nextTick(callback); return this; }
    }
    const servers = [];
    const signals = new EventEmitter();
    const running = await startHubApi({
      env: s.env, policy, hostId: HOST, now: s.clock.now, sleep: s.clock.sleep, devices: s.devices, qaDevices: () => [], versions: { node: '24.15.0' }, onPath: () => true, signals,
      log: { out: line => { order.push(line); }, err: line => s.err.push(line) }, createServer: listener => { const server = new FakeServer(listener); servers.push(server); return server; },
    });
    const listener = servers[0].listener;
    const open = [await start(listener, WAIT), await start(listener, { ...WAIT, resource: 's26', id: 'w-2' })];
    for (const e of open) { const original = e.res.writeHead.bind(e.res); e.res.writeHead = (status, headers) => { order.push('answer'); original(status, headers); }; }
    assert.deepEqual(open.map(e => e.res.calls), [[], []]);
    signals.emit('SIGTERM');
    await running.stopped;
    for (const e of open) {
      assert.deepEqual(problemOf(e), [503, 'HUB_API_RESTARTING', 1, 'restarting']);
      assert.equal(e.json().retry, 'requeue');
      assert.equal(e.res.head.headers['Cache-Control'], 'no-store');
    }
    assert.equal(open[0].res.head.headers['X-Request-Id'], 'w-1');
    assert.deepEqual(order.filter(item => item === 'answer' || item === 'close' || item === 'HUB_API_STOP'), ['answer', 'answer', 'close', 'HUB_API_STOP'], 'both answers are written before the server closes and HUB_API_STOP is logged');
    assert.deepEqual([s.tickets('s24'), s.tickets('adb')], [[], []]);
    assert.deepEqual(s.events().filter(event => event.event === 'cancel').map(event => [event.lease_id, event.reason]), [['w-1', 'aborted'], ['w-2', 'aborted']]);
    assert.equal(s.owner('s24').lease_id, 'holder-s24', 'nothing was granted');
    // A request that arrives while the service stops gets the same answer.
    const late = await start(listener, { ...BODY, id: 'late-1' });
    assert.deepEqual(problemOf(late), [503, 'HUB_API_RESTARTING', 1, 'restarting']);
    assert.equal(late.json().retry, 'requeue');
  } finally { s.cleanup(); }
});

test('waits.shutdown() is idempotent and a later lease is refused HUB_API_RESTARTING', async () => {
  const s = scratch();
  try {
    const waits = createLeaseWaits();
    await waits.shutdown();
    await waits.shutdown();
    await assert.rejects(waits.lease({ ...BODY, waitMs: 0, id: null, resource: 's24', match: null, forMs: MIN, claimantKind: 'agent', actor: null }, { env: s.env }), { code: 'HUB_API_RESTARTING', retry: 'requeue' });
    assert.equal(waits.size, 0);
  } finally { s.cleanup(); }
});

test('crash leftovers: the ticket of a dead pid on this host (a person) is pruned by the next take, as a person', async () => {
  const s = scratch();
  try {
    const child = spawnSync(process.execPath, ['-e', '']);
    const queue = join(s.env.HUB_LOCK_DIR, 's24.queue');
    mkdirSync(queue, { recursive: true });
    const { host, host_id: hostId } = localHost();
    writeFileSync(join(queue, `${String(s.clock.now()).padStart(15, '0')}-000001-00000001.json`), JSON.stringify({
      format: 1, kind: 'lease', lease_id: 'ghost-1', holder: 'ghost', why: 'crashed', pid: child.pid, host, host_id: hostId, process_start: 'x',
      enqueued_at: new Date(s.clock.now()).toISOString(), deadline_at: null, expires_at: null, claimant_kind: 'person',
    }));
    const take = await handle({ method: 'POST', url: '/leases', body: { ...BODY, id: 'after-crash' } }, s.ctx());
    assert.equal(take.status, 200, JSON.stringify(take.body));
    const prune = s.events().find(event => event.event === 'prune');
    assert.deepEqual([prune.lease_id, prune.claimant.kind, prune.reason], ['ghost-1', 'person', 'gone']);
    assert.ok(!existsSync(join(queue, `${String(s.clock.now()).padStart(15, '0')}-000001-00000001.json`)));
  } finally { s.cleanup(); }
});

test('the service reads a pid\'s start once per 2 s however many polls and waits there are (AD-44), and never from a spawn on the request path', async () => {
  const s = scratch();
  try {
    await s.hold('s24');
    await s.hold('adb');
    const reads = [];
    const waits = createLeaseWaits({ now: s.clock.now, startOf: pid => { reads.push(pid); return 'fixed-start'; } });
    const listener = requestListener(s.ctx({ waits }));
    const a = await start(listener, WAIT);
    const b = await start(listener, { ...WAIT, resource: 's26', id: 'w-2' });
    for (let poll = 0; poll < 4; poll += 1) await s.clock.tick();
    assert.equal(reads.filter(pid => pid === process.pid).length, 1, `one read: ${JSON.stringify(reads)}`);
    assert.equal(s.ticket('s24').process_start, 'fixed-start');
    s.clock.advance(2500);
    await s.clock.tick();
    assert.equal(reads.filter(pid => pid === process.pid).length, 2, 'a fresh read after the ttl');
    a.res.drop();
    b.res.drop();
    await flush();
    await Promise.all([a.done, b.done]);
  } finally { s.cleanup(); }
});

test('a wait on a free lock is granted at once: 200 with X-Request-Id and no ticket left', async () => {
  const s = scratch();
  try {
    const e = await start(requestListener(s.ctx()), { ...WAIT, id: 'free-1' });
    await e.done;
    assert.equal(e.status(), 200);
    assert.equal(e.res.head.headers['X-Request-Id'], 'free-1');
    assert.deepEqual(s.tickets('s24'), []);
    assert.equal(s.waits.size, 0);
    // A try with no id echoes the id the lock layer minted.
    const minted = await start(requestListener(s.ctx()), { ...BODY, resource: 's26' });
    assert.match(minted.res.head.headers['X-Request-Id'], /^l-[0-9a-f]{12}$/);
    assert.equal(minted.res.head.headers['X-Request-Id'], minted.json().lease_id);
  } finally { s.cleanup(); }
});
