// The Claims library (AD-24, FR-22): the same action through the library and through `hub-device` gives the same Hold, the
// same refusal, the same exit code and the same events. Every case runs on temp lock and event dirs, with the adb seam injected.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { acquireLease } from '../ci/lib/lock.mjs';
import { readEvents } from '../ci/lib/events.mjs';
import * as claims from './claims.mjs';
import { main } from './hub-device.mjs';

const T0 = Date.parse('2026-11-24T12:00:00.000Z');
const S26 = { serial: 'R5GL43A7PCH', model: 'SM-S948U' };

function side() {
  const root = mkdtempSync(join(tmpdir(), 'claims-'));
  const env = { PATH: process.env.PATH, HOME: root, USER: 'tester', HUB_LOCK_DIR: join(root, 'locks'), HUB_EVENT_DIR: join(root, 'events'), HUB_DEVICE_POLL_MS: '5', HUB_ADB_SERVER_PORT: '5037' };
  const logs = [];
  const seams = { inventory: () => ({ adb_servers: [], emulators: [], xvfb: [] }), now: () => T0 };
  const ctx = claims.createContext({ env, now: () => T0, log: line => logs.push(line), adbFactory: undefined, inventory: seams.inventory, fleet: claims.loadFleet(env) });
  const cli = async (argv, extra = {}) => {
    const out = [];
    const err = [];
    const code = await main(argv, { env, stdout: line => out.push(line), stderr: line => err.push(line), ...seams, ...extra });
    return { code, out, err };
  };
  const owner = (lock = 's24') => { try { const { lock_ino, ...rest } = JSON.parse(readFileSync(join(root, `locks/${lock}.lock/owner.json`), 'utf8')); return rest; } catch { return null; } };
  const events = () => [...readEvents({ env })];
  return { root, env, ctx, logs, cli, owner, events, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const options = (extra = {}) => ({ holder: 'h', why: 'x', forMs: 1_800_000, waitMs: 0, id: 'l-aaaaaaaaaaaa', holderPid: null, noConnect: true, phoneWaitMs: 0, ...extra });
const cliLease = (device, extra = []) => ['lease', device, '--for', '30m', '--why', 'x', '--holder', 'h', '--id', 'l-aaaaaaaaaaaa', '--wait', '0', '--no-connect', ...extra];

// A waiter queued behind a held lock. Its AbortController ends the wait whatever the test does next (the clock is frozen, so it
// would otherwise poll for ever); the helper asserts that the ticket really landed in the queue.
async function startWaiter(s, id, lock = 's24') {
  const abort = new AbortController();
  const settled = acquireLease(lock, { id, holder: 'w', why: 'next', forMs: 60_000, waitMs: 5000, env: s.env, log: () => {}, pollMs: 5, now: () => T0, signal: abort.signal }).catch(error => error);
  const queue = join(s.root, `locks/${lock}.queue`);
  const queued = () => { try { return readdirSync(queue).length > 0; } catch { return false; } };
  for (let tries = 0; tries < 200 && !queued(); tries += 1) await new Promise(done => setTimeout(done, 10));
  if (!queued()) { abort.abort(); await settled; assert.fail(`the waiter ${id} never appeared in ${lock}.queue`); }
  return { settled, stop: async () => { abort.abort(); await settled; } };
}

// An adb with no phone on it: every phone is away.
const emptyAdb = () => ({ startServer: async () => {}, devices: async () => [], prop: async () => '' });

test('the library exports the whole action surface and the exit table as frozen data', () => {
  for (const name of ['resolve', 'take', 'release', 'extend', 'newLeaseId', 'checkBounds', 'checkLeaseId', 'usableFleet', 'emulatorBounds', 'statusData', 'leaseExports', 'jobTicket', 'releaseEmulatorNow', 'releaseReservations', 'exitCodeOf', 'fleetOf', 'loadFleet']) {
    assert.equal(typeof claims[name], 'function', name);
  }
  assert.equal(claims.PHONE, 'phone');
  assert.equal(claims.EMULATOR, 'emulator');
  assert.ok(Object.isFrozen(claims.EXIT_CODES));
  assert.deepEqual({ ...claims.EXIT_CODES }, {
    HUB_USAGE: 2, HUB_EMULATOR_USAGE: 2, HUB_LEASE_TOO_LONG: 2, HUB_DEVICE_JOB_ID: 2,
    HUB_DEVICE_AWAY: 75, HUB_PHONE_AWAY: 75, HUB_DEVICE_BUSY: 76, HUB_LOCK_TIMEOUT: 76,
    HUB_LEASE_CANCELLED: 1, HUB_LEASE_EXTEND_REFUSED: 1, HUB_LEASE_LOST: 1,
  });
});

test('exitCodeOf maps a code through the table and anything else to 1', () => {
  const code = value => claims.exitCodeOf(Object.assign(new Error('x'), { code: value }));
  assert.equal(code('HUB_PHONE_AWAY'), 75);
  assert.equal(code('HUB_DEVICE_AWAY'), 75);
  assert.equal(code('HUB_LOCK_TIMEOUT'), 76);
  assert.equal(code('HUB_DEVICE_BUSY'), 76);
  assert.equal(code('HUB_USAGE'), 2);
  assert.equal(code('HUB_EMULATOR_USAGE'), 2);
  assert.equal(code('HUB_LEASE_TOO_LONG'), 2);
  assert.equal(code('HUB_LEASE_CANCELLED'), 1);
  assert.equal(code('HUB_LEASE_EXTEND_REFUSED'), 1);
  assert.equal(code('ENOENT'), 1);
  assert.equal(claims.exitCodeOf(new Error('no code')), 1);
  assert.equal(claims.exitCodeOf(null), 1);
  for (const inherited of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) assert.equal(code(inherited), 1, inherited);
});

test('newLeaseId mints the exact formats: l-, e- and run-', () => {
  assert.match(claims.newLeaseId(), /^l-[0-9a-f]{12}$/);
  assert.match(claims.newLeaseId('lease'), /^l-[0-9a-f]{12}$/);
  assert.match(claims.newLeaseId('emulator'), /^e-[0-9a-f]{12}$/);
  assert.match(claims.newLeaseId('run'), new RegExp(`^run-${process.pid}-[0-9a-f]{8}$`));
  assert.notEqual(claims.newLeaseId('emulator'), claims.newLeaseId('emulator'));
  assert.throws(() => claims.newLeaseId('other'), /unknown kind/);
});

test('hub-device is parsing and output: no takeLease or takeAnyPhone, and no direct lock, emulator or adb imports', () => {
  const source = readFileSync(fileURLToPath(new URL('./hub-device.mjs', import.meta.url)), 'utf8');
  assert.doesNotMatch(source, /\b(takeLease|takeAnyPhone|noPhoneError|resolveDevice)\b/);
  // Every module specifier, however the import is laid out: `from '…'` (across lines too), a bare `import '…'` and `import('…')`.
  const imports = [...source.matchAll(/\bfrom\s+'([^']+)'/g), ...source.matchAll(/^\s*import\s+'([^']+)'/gm), ...source.matchAll(/\bimport\s*\(\s*'([^']+)'/g)].map(match => match[1]);
  assert.ok(imports.length >= 6, 'the scan found the imports');
  assert.ok(imports.includes('./claims.mjs'));
  for (const forbidden of ['lock.mjs', 'emulator.mjs', 'adb.mjs', 'async-adb.mjs', 'inventory.mjs', 'devices.mjs']) {
    assert.ok(!imports.some(path => path.endsWith(`/${forbidden}`)), `hub-device.mjs must not import ${forbidden}`);
  }
  const claimsSource = readFileSync(fileURLToPath(new URL('./claims.mjs', import.meta.url)), 'utf8');
  assert.match(claimsSource, /'\.\.\/ci\/lib\/lock\.mjs'/);
});

test('resolve: an id wins over a word, an unknown word is a usage error, ids and words can be narrowed', async () => {
  const s = side();
  try {
    const { fleet } = s.ctx;
    assert.deepEqual(fleet.map(phone => phone.device), ['s24', 's26']);
    // A lease on s24 whose id is the word "s26": the id is found first.
    await claims.take(claims.resolve('s24', { fleet, env: s.env, ids: false }), options({ id: 's26' }), s.ctx);
    const byId = claims.resolve('s26', { fleet, env: s.env });
    assert.equal(byId.by, 'owner');
    assert.equal(byId.entry.device, 's24');
    const byWord = claims.resolve('s26', { fleet, env: s.env, ids: false });
    assert.equal(byWord.by, 'word');
    assert.equal(byWord.entry.device, 's26');
    assert.equal(claims.resolve('phone', { fleet, env: s.env, ids: false }).kind, 'pool');
    assert.equal(claims.resolve('emulator', { fleet, env: s.env, ids: false }).kind, 'emulator');
    assert.equal(claims.resolve('l-nothing', { fleet, env: s.env, words: false }), null);
    assert.throws(() => claims.resolve('s99', { fleet, env: s.env }), error => error.code === 'HUB_USAGE' && error.message === 'unknown device "s99" (known: s24, s26, phone, emulator)');
    assert.throws(() => claims.resolve(null, { fleet, env: s.env, ids: false }), /unknown device ""/);
  } finally { s.cleanup(); }
});

test('parity: take through the library and through hub-device gives the same Hold and the same events', async () => {
  const a = side();
  const b = side();
  try {
    const taken = await claims.take(claims.resolve('s24', { fleet: a.ctx.fleet, env: a.env, ids: false }), options(), a.ctx);
    assert.equal(taken.kind, 'phone');
    const cli = await b.cli(cliLease('s24'));
    assert.equal(cli.code, 0, cli.err.join('\n'));
    assert.deepEqual(a.owner(), b.owner());
    assert.equal(a.owner().lease_id, 'l-aaaaaaaaaaaa');
    assert.deepEqual(a.events(), b.events());
    assert.deepEqual(a.events().map(event => event.event), ['acquire']);
    const vars = claims.leaseExports(taken);
    assert.deepEqual(cli.out, Object.entries(vars).map(([name, value]) => `export ${name}='${value}'`));
  } finally { a.cleanup(); b.cleanup(); }
});

test('parity: a held phone is the same refusal, and exit 76 both ways', async () => {
  const a = side();
  const b = side();
  try {
    for (const s of [a, b]) await claims.take(claims.resolve('s24', { fleet: s.ctx.fleet, env: s.env, ids: false }), options({ id: 'l-bbbbbbbbbbbb' }), s.ctx);
    const error = await claims.take(claims.resolve('s24', { fleet: a.ctx.fleet, env: a.env, ids: false }), options({ id: 'l-cccccccccccc' }), a.ctx).then(() => null, caught => caught);
    assert.equal(error.code, 'HUB_LOCK_TIMEOUT');
    assert.equal(claims.exitCodeOf(error), 76);
    const cli = await b.cli(cliLease('s24', []).map(arg => (arg === 'l-aaaaaaaaaaaa' ? 'l-cccccccccccc' : arg)));
    assert.equal(cli.code, 76);
    assert.deepEqual(cli.err, [`HUB_DEVICE_BUSY s24 ${error.message}`]);
    assert.deepEqual(a.owner(), b.owner());
  } finally { a.cleanup(); b.cleanup(); }
});

test('parity: --for over the deploy cap is the same usage error, exit 2, and nothing is written', async () => {
  const a = side();
  const b = side();
  try {
    const fleet = a.ctx.fleet;
    const error = (() => { try { return claims.checkBounds(claims.resolve('s26', { fleet, env: a.env, ids: false }), { forMs: 7_200_000, forText: '2h', fleet }); } catch (caught) { return caught; } })();
    assert.equal(error.code, 'HUB_USAGE');
    assert.match(error.message, /^--for 2h: /);
    assert.equal(claims.exitCodeOf(error), 2);
    const cli = await b.cli(['lease', 's26', '--for', '2h', '--why', 'x', '--no-connect']);
    assert.equal(cli.code, 2);
    assert.deepEqual(cli.err, [`hub-device: ${error.message}`]);
    for (const s of [a, b]) {
      assert.equal(existsSync(join(s.root, 'locks')) ? readdirSync(join(s.root, 'locks')).length : 0, 0);
      assert.equal(s.events().length, 0);
    }
    // `phone` skips the deploy phone over the cap, so it still has the S24.
    const pool = claims.checkBounds(claims.resolve('phone', { fleet, env: a.env, ids: false }), { forMs: 7_200_000, forText: '2h', fleet });
    assert.deepEqual(pool.members.map(phone => phone.device), ['s24']);
    assert.throws(() => claims.checkBounds({ kind: 'pool', members: [fleet[1]] }, { forMs: 7_200_000, fleet: [fleet[1]] }), /no phone can take it/);
    assert.throws(() => claims.checkBounds({ kind: 'emulator' }, { forMs: 0, fleet }), /--for must be more than 0 and at most 48h/);
  } finally { a.cleanup(); b.cleanup(); }
});

test('parity: an absent phone is HUB_PHONE_AWAY, exit 75, and the CLI prints HUB_DEVICE_AWAY', async () => {
  const a = side();
  const b = side();
  try {
    const ctx = { ...a.ctx, adbFactory: emptyAdb };
    const error = await claims.take(claims.resolve('s24', { fleet: ctx.fleet, env: a.env, ids: false }), options({ noConnect: false }), ctx).then(() => null, caught => caught);
    assert.equal(error.code, 'HUB_PHONE_AWAY');
    assert.equal(error.reason, 'absent');
    assert.equal(claims.exitCodeOf(error), 75);
    const cli = await b.cli(cliLease('s24').filter(arg => arg !== '--no-connect'), { adbFactory: emptyAdb });
    assert.equal(cli.code, 75);
    assert.deepEqual(cli.out, ['HUB_DEVICE_AWAY s24']);
    assert.equal(a.owner(), null, 'the lease is given back');
    assert.equal(b.owner(), null);
    // The Pool: every phone absent is AWAY, naming each.
    const pool = await claims.take(claims.resolve('phone', { fleet: ctx.fleet, env: a.env, ids: false }), options({ id: undefined, noConnect: false }), ctx).then(() => null, caught => caught);
    assert.equal(pool.code, 'HUB_PHONE_AWAY');
    assert.match(pool.message, /^no free phone came within the wait: s24 absent, s26 absent$/);
  } finally { a.cleanup(); b.cleanup(); }
});

test('release outcomes: held, queued, unknown, a job id and --any print the lines they always did', async () => {
  const s = side();
  let waiter = null;
  try {
    const { fleet } = s.ctx;
    const held = claims.resolve('s24', { fleet, env: s.env, ids: false });
    await claims.take(held, options({ id: 'l-aaaaaaaaaaaa' }), s.ctx);
    // A waiter behind it.
    waiter = await startWaiter(s, 'l-wwwwwwwwwwww');
    const queued = await s.cli(['release', 'l-wwwwwwwwwwww']);
    assert.deepEqual([queued.code, queued.out], [0, ['HUB_DEVICE_CANCELLED s24 l-wwwwwwwwwwww (it was still waiting)']]);
    assert.equal((await waiter.settled).code, 'HUB_LEASE_CANCELLED');
    const unknown = await s.cli(['release', 'l-nothing']);
    assert.deepEqual([unknown.code, unknown.out], [0, ['HUB_DEVICE_NOT_HELD phone l-nothing (no phone lease by that id)']]);
    assert.deepEqual(unknown.err, ['hub-device: s24 is leased as l-aaaaaaaaaaaa (h), not l-nothing; left alone']);
    const job = await s.cli(['release', 'job:delorenj/app#123.android/build']);
    assert.equal(job.code, claims.EXIT_CODES.HUB_DEVICE_JOB_ID);
    assert.match(job.err[0], /^HUB_DEVICE_JOB_ID job:delorenj\/app#123\.android\/build is a deploy job's place in line, not a lease; cancel run 123 of delorenj\/app instead \(gh run cancel 123 --repo delorenj\/app\)$/);
    assert.equal(claims.jobTicket('l-aaaaaaaaaaaa'), null);
    // The library refuses what the CLI refuses: a job ticket, and a target that names nothing.
    await assert.rejects(claims.release({ id: 'job:delorenj/app#123.android/build' }, s.ctx), error => error.code === 'HUB_DEVICE_JOB_ID' && claims.exitCodeOf(error) === 2 && !error.message.startsWith('HUB_DEVICE_JOB_ID'));
    await assert.rejects(claims.release({}, s.ctx), error => error.code === 'HUB_USAGE');
    await assert.rejects(claims.release({ emulator: '' }, s.ctx), error => error.code === 'HUB_USAGE');
    await assert.rejects(claims.releaseEmulator('', s.ctx), error => error.code === 'HUB_USAGE');
    await assert.rejects(claims.releaseEmulator('Bad Id', s.ctx), error => error.code === 'HUB_USAGE');
    assert.match(claims.jobTicket('job:local#local-42.ios/x').message, /it is the local process 42, stop that process instead$/);
    const lib = await claims.release({ id: 'l-aaaaaaaaaaaa' }, s.ctx);
    assert.deepEqual([lib.kind, lib.outcome, lib.device, lib.leaseId], ['phone', 'released', 's24', 'l-aaaaaaaaaaaa']);
    const again = await s.cli(['release', 'l-aaaaaaaaaaaa']);
    assert.deepEqual([again.code, again.out], [0, ['HUB_DEVICE_NOT_HELD phone l-aaaaaaaaaaaa (no phone lease by that id)']]);
    await claims.take(held, options({ id: 'l-dddddddddddd' }), s.ctx);
    const any = await s.cli(['release', '--any']);
    assert.deepEqual([any.code, any.out], [0, ['HUB_DEVICE_RELEASED s24 l-dddddddddddd']]);
    const none = await s.cli(['release', '--any']);
    assert.deepEqual([none.code, none.out], [0, ['HUB_DEVICE_NOT_HELD phone - (no phone is held)']]);
    const bare = await s.cli(['release']);
    assert.deepEqual([bare.code, bare.err], [2, ['hub-device: release needs a lease id, $HUB_LEASE_ID, or --any to free whichever lease holds a phone']]);
  } finally { await waiter?.stop(); s.cleanup(); }
});

test('extend: a live Lease with no waiter gets the new expiry and one extend event; a waiter, the cap or an unknown id refuse', async () => {
  const s = side();
  let waiter = null;
  try {
    const { fleet } = s.ctx;
    const extend = (id, forMs) => claims.extend(id, { forMs }, s.ctx);
    const refusal = (id, forMs) => { try { return extend(id, forMs); } catch (error) { return error; } };
    await claims.take(claims.resolve('s24', { fleet, env: s.env, ids: false }), options({ id: 'l-aaaaaaaaaaaa' }), s.ctx);
    const record = extend('l-aaaaaaaaaaaa', 600_000);
    assert.equal(record.expires_at, new Date(T0 + 1_800_000 + 600_000).toISOString());
    assert.equal(s.owner().expires_at, record.expires_at);
    assert.equal(s.events().filter(event => event.event === 'extend').length, 1);
    // A waiter refuses it, and its own id holds nothing to extend.
    waiter = await startWaiter(s, 'l-wwwwwwwwwwww');
    const refused = refusal('l-aaaaaaaaaaaa', 600_000);
    assert.equal(refused.code, 'HUB_LEASE_EXTEND_REFUSED');
    assert.equal(claims.exitCodeOf(refused), 1);
    assert.match(refused.message, /cannot be extended while 1 waiter waits/);
    assert.equal(refusal('l-wwwwwwwwwwww', 600_000).code, 'HUB_LEASE_LOST');
    await claims.release({ id: 'l-wwwwwwwwwwww' }, s.ctx);
    assert.equal((await waiter.settled).code, 'HUB_LEASE_CANCELLED');
    // The deploy phone's 60 min cap.
    await claims.take(claims.resolve('s26', { fleet, env: s.env, ids: false }), options({ id: 'l-eeeeeeeeeeee', forMs: 3_000_000 }), s.ctx);
    assert.ok(/total/.test(refusal('l-eeeeeeeeeeee', 1_200_000).message));
    assert.equal(refusal('l-eeeeeeeeeeee', 1_200_000).code, 'HUB_LEASE_EXTEND_REFUSED');
    assert.equal(extend('l-eeeeeeeeeeee', 300_000).expires_at, new Date(T0 + 3_300_000).toISOString());
    const lost = refusal('l-nothing', 1000);
    assert.equal(lost.code, 'HUB_LEASE_LOST');
    assert.equal(claims.exitCodeOf(lost), 1);
    assert.equal(refusal('l-aaaaaaaaaaaa', 0).code, 'HUB_USAGE');
  } finally { await waiter?.stop(); s.cleanup(); }
});

test('take refuses what the CLI refuses: no target, a taken id, and a Pool over the deploy cap is narrowed to the S24', async () => {
  const s = side();
  try {
    const { fleet } = s.ctx;
    await assert.rejects(claims.take(null, options(), s.ctx), error => error.code === 'HUB_USAGE');
    await assert.rejects(claims.take({ kind: 'nothing' }, options(), s.ctx), error => error.code === 'HUB_USAGE');
    const pool = claims.resolve('phone', { fleet, env: s.env, ids: false });
    const taken = await claims.take(pool, options({ id: 'l-aaaaaaaaaaaa', forMs: 7_200_000 }), s.ctx);
    assert.equal(taken.phone.device, 's24', 'the S26 is over its cap, so the Pool tried the S24 only');
    await assert.rejects(claims.take(claims.resolve('s26', { fleet, env: s.env, ids: false }), options({ id: 'l-aaaaaaaaaaaa' }), s.ctx), error => error.code === 'HUB_USAGE' && /already names a lease or a waiter on s24/.test(error.message));
    await assert.rejects(claims.take(claims.resolve('s26', { fleet, env: s.env, ids: false }), options({ id: 'l-ffffffffffff', forMs: 7_200_000 }), s.ctx), error => error.code === 'HUB_USAGE' && /^--for 7200000: /.test(error.message));
    // What the CLI's own flags guarantee is checked again for a caller that has no flags: each a usage error, nothing taken.
    const s26 = claims.resolve('s26', { fleet, env: s.env, ids: false });
    const refuses = async (extra, pattern) => assert.rejects(claims.take(s26, options({ id: 'l-gggggggggggg', ...extra }), s.ctx), error => error.code === 'HUB_USAGE' && claims.exitCodeOf(error) === 2 && pattern.test(error.message));
    await refuses({ forMs: undefined }, /^--for must be more than 0/);
    await refuses({ why: undefined }, /^--why <text> is required/);
    await refuses({ waitMs: undefined }, /^--wait must be a duration of 0 or more/);
    await refuses({ holderPid: -1 }, /^--pid takes a live process id/);
    const emulator = claims.resolve('emulator', { fleet, env: s.env, ids: false });
    await assert.rejects(claims.take(emulator, options({ id: 'e-gggggggggggg', noConnect: true }), s.ctx), error => error.code === 'HUB_USAGE' && /^--no-connect is for a phone/.test(error.message));
    await assert.rejects(claims.take(emulator, options({ id: 'e-gggggggggggg', noConnect: false, pool: 99 }), s.ctx), error => error.code === 'HUB_USAGE' && /^--pool can only lower this host's emulator pool/.test(error.message));
    await assert.rejects(claims.take(emulator, options({ id: 'e-gggggggggggg', noConnect: false, profile: 'nope' }), s.ctx), error => error.code === 'HUB_USAGE' && /^unknown emulator profile "nope"/.test(error.message));
    assert.equal(s.owner('adb'), null, 'nothing was taken');
  } finally { s.cleanup(); }
});

test('extend: an emulator Lease extends its slot, the lock the reaper judges it by', async () => {
  const s = side();
  try {
    await acquireLease('emulator-1', { id: 'e-xxxxxxxxxxxx', holder: 'h', why: 'x', forMs: 1_800_000, waitMs: 0, env: s.env, log: () => {}, pollMs: 5, now: () => T0 });
    const records = join(s.env.HUB_LOCK_DIR, 'emulators');
    mkdirSync(records, { recursive: true });
    writeFileSync(join(records, 'e-xxxxxxxxxxxx.json'), JSON.stringify({ lease_id: 'e-xxxxxxxxxxxx', slot: 'emulator-1', pids: [] }));
    const record = claims.extend('e-xxxxxxxxxxxx', { forMs: 600_000 }, s.ctx);
    assert.equal(record.expires_at, new Date(T0 + 2_400_000).toISOString());
    assert.equal(s.owner('emulator-1').expires_at, record.expires_at);
    assert.equal(s.events().filter(event => event.event === 'extend').length, 1);
  } finally { s.cleanup(); }
});

test('releaseEmulatorNow gives back the gate, and with a record the record\'s slot too', async () => {
  const s = side();
  try {
    const hold = (lock, id) => acquireLease(lock, { id, holder: 'h', why: 'x', forMs: 60_000, waitMs: 0, env: s.env, log: () => {}, pollMs: 5 });
    const held = lock => existsSync(join(s.root, 'locks', `${lock}.lock`, 'owner.json'));
    // No record: only the gate holds the id.
    await hold('emulator', 'e-nnnnnnnnnnnn');
    assert.ok(held('emulator'));
    claims.releaseEmulatorNow('e-nnnnnnnnnnnn', { env: s.env });
    assert.equal(held('emulator'), false, 'the gate is released');
    // A record whose processes are gone: its slot and the gate are released and the record is dropped.
    await hold('emulator', 'e-rrrrrrrrrrrr');
    await hold('emulator-1', 'e-rrrrrrrrrrrr');
    const records = join(s.env.HUB_LOCK_DIR, 'emulators');
    mkdirSync(records, { recursive: true });
    writeFileSync(join(records, 'e-rrrrrrrrrrrr.json'), JSON.stringify({ lease_id: 'e-rrrrrrrrrrrr', slot: 'emulator-1', pids: [], dir: join(s.root, 'rt', 'e-rrrrrrrrrrrr') }));
    claims.releaseEmulatorNow('e-rrrrrrrrrrrr', { env: s.env });
    assert.equal(held('emulator'), false);
    assert.equal(held('emulator-1'), false, 'the record\'s slot is released');
    assert.equal(existsSync(join(records, 'e-rrrrrrrrrrrr.json')), false, 'the record is dropped');
    // Another lease's gate is left alone.
    await hold('emulator', 'e-oooooooooooo');
    claims.releaseEmulatorNow('e-nnnnnnnnnnnn', { env: s.env });
    assert.ok(held('emulator'));
  } finally { s.cleanup(); }
});

test('status data writes nothing to the lock dir or the Event Log', async () => {
  const s = side();
  try {
    mkdirSync(s.env.HUB_LOCK_DIR, { recursive: true });
    const before = readdirSync(s.env.HUB_LOCK_DIR);
    const data = await claims.statusData(s.ctx);
    assert.deepEqual(Object.keys(data), ['phones', 'locks', 'waiters', 'reservations', 'inventory', 'emulators']);
    assert.deepEqual(data.phones.map(phone => [phone.device, phone.held, phone.presence]), [['s24', 'free', 'no adb server'], ['s26', 'free', 'no adb server']]);
    assert.deepEqual(readdirSync(s.env.HUB_LOCK_DIR), before);
    assert.equal(existsSync(s.env.HUB_EVENT_DIR), false);
    const json = await s.cli(['status', '--json']);
    assert.equal(json.code, 0);
    assert.deepEqual(JSON.parse(json.out.join('\n')), JSON.parse(JSON.stringify(data)));
  } finally { s.cleanup(); }
});

test('emulator bounds and reservation checks are library usage errors with today\'s text', () => {
  const env = { HUB_EMULATOR_POOL: '2' };
  assert.throws(() => claims.emulatorBounds({ noConnect: true }, env), error => error.code === 'HUB_USAGE' && /^--no-connect is for a phone/.test(error.message));
  assert.throws(() => claims.emulatorBounds({ profile: 'nope' }, env), /unknown emulator profile "nope" \(known: /);
  assert.throws(() => claims.emulatorBounds({ pool: '0' }, env), /--pool takes a whole number of emulators, not "0"/);
  assert.throws(() => claims.emulatorBounds({ pool: '9' }, env), /--pool can only lower this host's emulator pool of 2/);
  assert.deepEqual(claims.emulatorBounds({ pool: '1' }, env), { profile: 'default', pool: 1 });
  assert.throws(() => claims.checkEmulatorLeaseId(''), /release emulator needs a lease id/);
  assert.throws(() => claims.checkEmulatorLeaseId('Bad Id'), /is not a lease id/);
  assert.throws(() => claims.checkPid('0'), /--pid takes a live process id/);
  assert.equal(claims.checkPid(undefined), null);
  const s = side();
  try {
    assert.throws(() => claims.releaseReservations({ key: 'nope' }, s.ctx), error => error.code === 'HUB_USAGE' && /is not a run key/.test(error.message));
    assert.throws(() => claims.releaseReservations({ key: 'o--r--1', name: 'bogus' }, s.ctx), /--name is one of adb, mac-ios/);
    assert.deepEqual(claims.releaseReservations({ key: 'o--r--1' }, s.ctx), []);
  } finally { s.cleanup(); }
});
