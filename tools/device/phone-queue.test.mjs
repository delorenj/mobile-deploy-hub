// Story 5.8: `hub-device lease|run phone` holds a place in line, through `main`, hermetic: temp lock and event dirs, the adb wire and the adb
// client injected, a fake clock (the injected `now` and `sleep`) where one process is enough and real 5 ms polls where two must wait
// together. Nothing reaches a real adb server, device or QA file.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readEvents } from '../ci/lib/events.mjs';
import { acquireLease, releaseLease } from '../ci/lib/lock.mjs';
import { hermetic } from '../ci/test-fixtures.mjs';
import { main } from './hub-device.mjs';
import { fakeWire } from './wire-fixtures.mjs';

hermetic();

const S24 = { serial: 'R5CX31AEJDA', model: 'SM-S928U' };
const S26 = { serial: 'R5GL43A7PCH', model: 'SM-S948U' };
const idOf = ({ serial }) => `adb-${serial}-zz._adb-tls-connect._tcp`;
const listing = (...phones) => phones.map(phone => ({ id: idOf(phone), state: 'device', model: phone.model.replace('-', '_') }));
const serverUp = () => ({ adb_servers: [{ port: 5037, pid: 4242, cwd: null }], emulators: [], xvfb: [] });
const adbWith = (...phones) => () => ({
  startServer: async () => {},
  devices: async () => phones.map(phone => ({ id: idOf(phone), state: 'device' })),
  prop: async (id, name) => { const phone = phones.find(entry => idOf(entry) === id); return name === 'ro.serialno' ? phone.serial : phone.model; },
});
const MIN = 60_000;
const settle = ms => new Promise(done => setTimeout(done, ms));
const until = async (check, what) => {
  for (let tries = 0; tries < 1000; tries += 1) { if (check()) return; await settle(10); }
  assert.fail(`never happened: ${what}`);
};

function side() {
  const root = mkdtempSync(join(tmpdir(), 'phone-queue-'));
  const env = { PATH: process.env.PATH, HOME: root, USER: 'tester', HUB_LOCK_DIR: join(root, 'locks'), HUB_EVENT_DIR: join(root, 'events'), HUB_DEVICE_POLL_MS: '5', HUB_DEVICE_PHONE_SLICE_MS: '50', HUB_ADB_SERVER_PORT: '5037' };
  let clock = Date.now();
  const f = {
    root, env, advance: ms => { clock += ms; }, now: () => clock,
    cli: async (argv, extra = {}) => {
      const out = [];
      const err = [];
      const code = await main(argv, {
        env, stdout: line => out.push(line), stderr: line => err.push(line), inventory: serverUp, adbWire: fakeWire({ listed: () => listing(S24, S26) }),
        adbFactory: adbWith(S24, S26), hostKey: () => 'linux', ...extra,
      });
      return { code, out, err };
    },
    events: () => [...readEvents({ env })],
    queue: lock => { try { return readdirSync(join(env.HUB_LOCK_DIR, `${lock}.queue`)).filter(file => file.endsWith('.json')); } catch { return []; } },
    everyQueue: () => { try { return readdirSync(env.HUB_LOCK_DIR).filter(entry => entry.endsWith('.queue')).flatMap(entry => readdirSync(join(env.HUB_LOCK_DIR, entry)).map(file => `${entry}/${file}`)); } catch { return []; } },
    hold: (lock, id, extra = {}) => acquireLease(lock, { holder: `holder-${id}`, why: 'device proof', forMs: 30 * MIN, id, env, log: () => {}, ...extra }),
    free: (lock, id) => releaseLease(lock, id, { env }),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
  return f;
}

// A fake clock for one waiting `main`: every poll advances it, and `onPoll(n)` may act between polls.
const clocked = (f, onPoll = async () => {}) => {
  let polls = 0;
  return { now: f.now, sleep: async ms => { f.advance(ms); polls += 1; await onPoll(polls); } };
};

test('both phones held: `lease phone --wait 1m` prints the wait line on stderr, then takes the s26 when it frees; no ticket remains', async () => {
  const f = side();
  try {
    await f.hold('s24', 'on-s24', { now: f.now });
    await f.hold('adb', 'on-s26', { now: f.now });
    const seen = [];
    const clock = clocked(f, async polls => {
      if (polls === 1) seen.push(f.everyQueue());
      if (polls === 2) f.free('adb', 'on-s26');
    });
    const result = await f.cli(['lease', 'phone', '--for', '5m', '--why', 'queued', '--wait', '1m', '--id', 'queued-1'], clock);
    assert.equal(result.code, 0, result.err.join('\n'));
    assert.match(result.out.join('\n'), /export HUB_DEVICE='s26'/);
    assert.match(result.out.join('\n'), /export HUB_LEASE_ID='queued-1'/);
    const lines = result.err.filter(line => line.startsWith('HUB_LOCK_WAIT'));
    assert.equal(lines.length, 1, result.err.join('\n'));
    assert.match(lines[0], /^HUB_LOCK_WAIT phone held by lease on-s2[46] of holder-on-s2[46] \(device proof\) until \S+ position=1 eta=\S+/);
    assert.equal(seen[0].length, 2, 'while it waited it stood in both phones\' queues');
    assert.equal(seen[0][0].split('/')[1], seen[0][1].split('/')[1], 'under the same ticket name');
    assert.deepEqual(f.everyQueue(), [], 'no Pool ticket remains in any queue');
    assert.deepEqual(f.events().filter(event => event.request === 'queued-1').map(event => [event.event, event.lock]), [['request', null], ['acquire', 'adb']]);
  } finally { f.cleanup(); }
});

test('the s24 frees first: the same request is served by the s24', async () => {
  const f = side();
  try {
    await f.hold('s24', 'on-s24', { now: f.now });
    await f.hold('adb', 'on-s26', { now: f.now });
    const clock = clocked(f, async polls => { if (polls === 2) f.free('s24', 'on-s24'); });
    const result = await f.cli(['lease', 'phone', '--for', '5m', '--why', 'queued', '--wait', '1m', '--id', 'queued-2', '--json'], clock);
    assert.equal(result.code, 0, result.err.join('\n'));
    assert.equal(JSON.parse(result.out[0]).device, 's24');
    assert.deepEqual(f.everyQueue(), []);
    // `run phone` is the same request
    await f.cli(['release', 'queued-2']);
    const ran = await f.cli(['run', 'phone', '--wait', '1m', '--', process.execPath, '-e', 'process.exit(0)'], clocked(f, async polls => { if (polls === 1) f.free('s24', 'on-s24'); }));
    assert.equal(ran.code, 0, ran.err.join('\n'));
  } finally { f.cleanup(); }
});

test('the s24 away while the s26 is held: the request waits (a phone that comes back is picked up) and still holds its place', async () => {
  const f = side();
  try {
    await f.hold('adb', 'on-s26', { now: f.now });
    let here = false;
    const result = await f.cli(['lease', 'phone', '--for', '5m', '--why', 'waits', '--wait', '1m', '--id', 'waits-1', '--json'], {
      ...clocked(f, async polls => { if (polls === 2) here = true; }),
      adbFactory: () => ({
        startServer: async () => {},
        devices: async () => (here ? [{ id: idOf(S24), state: 'device' }] : []),
        prop: async (id, name) => (name === 'ro.serialno' ? S24.serial : S24.model),
      }),
    });
    assert.equal(result.code, 0, result.err.join('\n'));
    assert.equal(JSON.parse(result.out[0]).device, 's24');
    assert.deepEqual(f.everyQueue(), []);
  } finally { f.cleanup(); }
});

test('`release <id>` while it waits cancels it on every phone: the waiter exits 1 HUB_DEVICE_CANCELLED and the log holds one request and one cancel', async () => {
  const f = side();
  try {
    await f.hold('s24', 'on-s24', { now: f.now });
    await f.hold('adb', 'on-s26', { now: f.now });
    let released = null;
    const clock = clocked(f, async polls => {
      if (polls === 2) {
        assert.equal(f.everyQueue().length, 2);
        released = await f.cli(['release', 'cancel-me']);
      }
    });
    const waiter = await f.cli(['lease', 'phone', '--for', '5m', '--why', 'cancelled', '--wait', '1m', '--id', 'cancel-me'], clock);
    assert.match(released.out.join('\n'), /^HUB_DEVICE_CANCELLED s2[46] cancel-me \(it was still waiting\)$/);
    assert.equal(released.code, 0);
    assert.equal(waiter.code, 1);
    assert.match(waiter.err.join('\n'), /^HUB_DEVICE_CANCELLED phone lease cancel-me was released while it waited for phone$/m);
    assert.deepEqual(f.everyQueue(), [], 'every member\'s ticket is gone');
    assert.deepEqual(f.events().filter(event => event.request === 'cancel-me').map(event => [event.event, event.lock, event.reason ?? null]), [['request', null, null], ['cancel', null, 'released']]);
    assert.equal(f.events().filter(event => event.lease_id === 'cancel-me' && event.event === 'cancel').length, 1, 'the per-lock release wrote no cancel of its own');
  } finally { f.cleanup(); }
});

test('status lists a waiting Pool request once, with request, pool and positions, and DEPLOY TARGET counts it', async () => {
  const f = side();
  try {
    await f.hold('s24', 'on-s24');
    await f.hold('adb', 'on-s26');
    // a single-phone waiter queued first on the s26, so the Pool request stands at #2 there and #1 on the s24
    const single = acquireLease('adb', { holder: 'single', why: 'queued first', forMs: 5 * MIN, waitMs: 60 * MIN, id: 'single-1', env: f.env, log: () => {}, pollMs: 5 });
    await until(() => f.queue('adb').length === 1, 'the single waiter is queued');
    const waiting = f.cli(['lease', 'phone', '--for', '5m', '--why', 'pooled', '--wait', '1m', '--id', 'pooled-1'], { sleep: ms => settle(ms), now: Date.now });
    await until(() => f.queue('adb').length === 2 && f.queue('s24').length === 1, 'the Pool request queued in both');
    const json = JSON.parse((await f.cli(['status', '--json'])).out.join('\n'));
    const mine = json.waiters.filter(waiter => waiter.lease_id === 'pooled-1');
    assert.equal(mine.length, 1, 'listed once, not once per phone');
    assert.equal(mine[0].request, 'pooled-1');
    assert.equal(mine[0].pool, 'phone');
    assert.deepEqual(mine[0].positions, { s24: 1, adb: 2 });
    assert.deepEqual([mine[0].lock, mine[0].position, mine[0].device], ['s24', 1, 's24'], 'the keys of the member where it stands nearest the front');
    assert.equal(typeof mine[0].eta, 'object', 'with the earliest member\'s ETA');
    const other = json.waiters.find(waiter => waiter.lease_id === 'single-1');
    assert.deepEqual(Object.keys(other).filter(key => ['request', 'pool', 'positions'].includes(key)), [], 'every other row keeps exactly its keys');
    assert.equal(json.waiters.length, 2);
    const text = (await f.cli(['status'])).out.join('\n');
    assert.equal(text.split('\n').filter(line => line.includes('pooled-1')).length, 1, 'once in the text too');
    assert.match(text, /s24 #1  pooled-1  holder=tester@\S+  why="pooled"  waiting since \S+  eta=\S+(?: low-data)?  pool phone \((?:s24 #1, adb #2|adb #2, s24 #1)\)$/m);
    assert.match(text, /^DEPLOY TARGET s26 \(lock adb\)  held by LEASE on-s26 holder=holder-on-s26  2 waiting/m, 'the Pool request counts for the deploy target it waits on');
    assert.ok(!/DEPLOY TARGET s24/.test(text), 'the s24 is no deploy target');
    // end it: the request is released by id, the single waiter then takes the s26
    assert.equal((await f.cli(['release', 'pooled-1'])).code, 0);
    assert.equal((await waiting).code, 1);
    f.free('adb', 'on-s26');
    assert.equal((await single).lease_id, 'single-1', 'the earlier waiter takes the s26 the cancelled request had been queued behind');
    f.free('adb', 'single-1');
    f.free('s24', 'on-s24');
    assert.deepEqual(f.everyQueue(), []);
  } finally { f.cleanup(); }
});

test('status folds a Pool request to the member where it stands nearest the front: queued behind a waiter on the s24, the row is the s26\'s', async () => {
  const f = side();
  try {
    await f.hold('s24', 'on-s24');
    await f.hold('adb', 'on-s26');
    const single = acquireLease('s24', { holder: 'single', why: 'queued first', forMs: 5 * MIN, waitMs: 60 * MIN, id: 'single-2', env: f.env, log: () => {}, pollMs: 5 });
    await until(() => f.queue('s24').length === 1, 'the single waiter is queued on the s24');
    const waiting = f.cli(['lease', 'phone', '--for', '5m', '--why', 'pooled', '--wait', '1m', '--id', 'pooled-2'], { sleep: ms => settle(ms), now: Date.now });
    await until(() => f.queue('s24').length === 2 && f.queue('adb').length === 1, 'the Pool request queued in both');
    const json = JSON.parse((await f.cli(['status', '--json'])).out.join('\n'));
    const mine = json.waiters.filter(waiter => waiter.lease_id === 'pooled-2');
    assert.equal(mine.length, 1);
    assert.deepEqual([mine[0].lock, mine[0].device, mine[0].position], ['adb', 's26', 1], 'the keys of the s26, where it is first');
    assert.deepEqual(mine[0].positions, { s24: 2, adb: 1 });
    assert.equal(json.waiters.length, 2);
    assert.equal((await f.cli(['release', 'pooled-2'])).code, 0);
    assert.equal((await waiting).code, 1);
    f.free('s24', 'single-2');
    await assert.rejects(single, error => error.code === 'HUB_LEASE_CANCELLED');
    f.free('s24', 'on-s24');
    f.free('adb', 'on-s26');
  } finally { f.cleanup(); }
});

test('the emulator gate keeps its own queue: a waiter there has no Pool ticket, and no slot queue holds one', async () => {
  const f = side();
  try {
    await f.hold('emulator', 'gate-holder');
    const id = 'e-aaaaaaaaaaaa';
    // what provision() does for a request: it waits for the pool as an ordinary Lease waiter on the `emulator` gate (no image or emulator is needed for that)
    const waiting = acquireLease('emulator', { holder: 'emu', why: 'next for an emulator: emulator wait', forMs: 5 * MIN, waitMs: 60 * MIN, id, env: f.env, log: () => {}, pollMs: 5 });
    await until(() => f.queue('emulator').length === 1, 'the gate waiter is queued');
    const ticket = JSON.parse(readFileSync(join(f.env.HUB_LOCK_DIR, 'emulator.queue', f.queue('emulator')[0]), 'utf8'));
    assert.deepEqual([ticket.lease_id, ticket.pool, ticket.request], [id, null, null], 'an ordinary Lease ticket on the gate, not a Pool ticket');
    assert.deepEqual(f.everyQueue().filter(entry => !entry.startsWith('emulator.queue/')), [], 'no ticket in any slot queue or phone queue');
    const json = JSON.parse((await f.cli(['status', '--json'])).out.join('\n'));
    const row = json.waiters.find(waiter => waiter.lease_id === id);
    assert.equal(row.lock, 'emulator');
    assert.deepEqual(Object.keys(row).filter(key => ['request', 'pool', 'positions'].includes(key)), []);
    f.free('emulator', id);
    await assert.rejects(waiting, error => error.code === 'HUB_LEASE_CANCELLED');
    f.free('emulator', 'gate-holder');
  } finally { f.cleanup(); }
});
