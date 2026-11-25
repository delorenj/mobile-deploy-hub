// Story 6.9: a phone registered through the Hub API is leasable by name or id on the very next `hub-device` call. Each row registers
// through main() (`registry add`, with a fetchImpl routed into the Hub API's handle() over the same temp lock dir) and leases through
// main() with nothing in between. Hermetic: the fake adb client and wire, no port, no real QA file.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadDevices } from '../ci/lib/devices.mjs';
import { readEvents } from '../ci/lib/events.mjs';
import { acquireLease, buildTicket } from '../ci/lib/lock.mjs';
import { loadPolicy } from '../ci/lib/policy.mjs';
import { hermetic } from '../ci/test-fixtures.mjs';
import { ROUTES, handle } from '../hub-api/routes.mjs';
import { registryPath } from '../registry/store.mjs';
import * as claims from './claims.mjs';
import { main } from './hub-device.mjs';
import { fakeWire } from './wire-fixtures.mjs';

hermetic();

const policy = loadPolicy().policy;
const S24 = { serial: 'R5CX31AEJDA', model: 'SM-S928U' };
const S26 = { serial: 'R5GL43A7PCH', model: 'SM-S948U' };
const PIXEL = { serial: 'PIXEL9SN', model: 'Pixel 9' };
const PIXEL_B = { serial: 'PIXEL8SN', model: 'Pixel 8' };
const QA = { serial: 'QAPIXEL7777', model: 'Pixel 7' };
const idOf = ({ serial }) => `adb-${serial}-zz._adb-tls-connect._tcp`;
const serverUp = () => ({ adb_servers: [{ port: 5037, pid: 4242, cwd: null }], emulators: [], xvfb: [] });
const qaFile = () => [{ name: 'Pixel-QA', model: QA.model, serial: QA.serial, allowed_users: [0] }];
const ALL = [S24, S26, PIXEL, PIXEL_B, QA];

const adbWith = (...phones) => () => ({
  startServer: async () => {},
  devices: async () => phones.map(phone => ({ id: idOf(phone), state: 'device' })),
  prop: async (id, name) => { const phone = phones.find(entry => idOf(entry) === id); return name === 'ro.serialno' ? phone.serial : phone.model; },
});

function scratch({ qa = [] } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'hub-registered-phone-'));
  const env = { PATH: process.env.PATH, HOME: root, USER: 'tester', HUB_LOCK_DIR: join(root, 'locks'), HUB_EVENT_DIR: join(root, 'events'), HUB_DEVICE_POLL_MS: '5', HUB_DEVICE_PHONE_SLICE_MS: '50', HUB_ADB_SERVER_PORT: '5037' };
  // A clock that moves, so created_at orders the phones that were registered one after the other.
  let tick = Date.parse('2026-11-25T10:00:00Z');
  const apiCtx = { env, policy, routes: ROUTES, now: () => { tick += 1000; return tick; }, hostId: 'test-host', devices: structuredClone(loadDevices({})), qaDevices: () => qa, log: { out: () => {}, err: () => {} } };
  const fetchImpl = async (url, init = {}) => {
    const target = new URL(url);
    const answer = await handle({ method: init.method, url: target.pathname + target.search, body: init.body === undefined ? undefined : JSON.parse(init.body) }, apiCtx);
    return new Response(JSON.stringify(answer.body), { status: answer.status, headers: answer.headers });
  };
  const wire = fakeWire({ listed: ALL.map(phone => ({ id: idOf(phone), state: 'device', model: phone.model.replace(/[- ]/g, '_') })), serials: Object.fromEntries(ALL.map(phone => [idOf(phone), phone.serial])) });
  const cli = async (argv, extra = {}) => {
    const out = [];
    const err = [];
    const code = await main(argv, { env, stdout: line => out.push(line), stderr: line => err.push(line), policy, qaDevices: () => qa, fetchImpl, hostKey: () => 'linux', inventory: serverUp, adbWire: wire, adbFactory: adbWith(...ALL), ...extra });
    return { code, out, err };
  };
  const register = async (name, identity = {}, ...more) => {
    const argv = ['registry', 'add', '--kind', 'phone', '--name', name, '--holder', 'tester', ...Object.entries(identity).flatMap(([key, value]) => [`--${key}`, value]), ...more];
    const result = await cli(argv);
    assert.equal(result.code, 0, result.err.join('\n'));
    return result;
  };
  const owner = lock => { try { return JSON.parse(readFileSync(join(env.HUB_LOCK_DIR, `${lock}.lock/owner.json`), 'utf8')); } catch { return null; } };
  return { root, env, cli, register, owner, events: () => [...readEvents({ env })], cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

let counter = 0;
const leaseArgs = (word, ...rest) => ['lease', ...(word === null ? [] : [word]), '--for', '30m', '--why', 'x', '--holder', 'h', '--id', `l-${String(counter += 1).padStart(12, '0')}`, '--wait', '0', ...rest];
const exported = (out, name) => out.find(line => line.startsWith(`export ${name}=`));
const warnings = err => err.filter(line => line.startsWith('hub-device: warning: HUB_REGISTRY_FORMAT:'));

test('lease by name: a phone registered a moment ago is taken on its own lock, with its adb id', async () => {
  const s = scratch();
  try {
    await s.register('pixel', { model: PIXEL.model, serial: PIXEL.serial });
    const taken = await s.cli(leaseArgs('pixel'));
    assert.equal(taken.code, 0, taken.err.join('\n'));
    assert.equal(exported(taken.out, 'HUB_DEVICE'), "export HUB_DEVICE='pixel'");
    assert.equal(exported(taken.out, 'ANDROID_SERIAL'), `export ANDROID_SERIAL='${idOf(PIXEL)}'`);
    assert.equal(s.owner('res-pixel')?.kind, 'lease');
    const acquires = s.events().filter(event => event.event === 'acquire');
    assert.deepEqual(acquires.map(event => event.lock), ['res-pixel']);
  } finally { s.cleanup(); }
});

test('lease by id: res-pixel takes the same lock and exports the device word', async () => {
  const s = scratch();
  try {
    await s.register('pixel', { model: PIXEL.model, serial: PIXEL.serial });
    const taken = await s.cli(leaseArgs('res-pixel'));
    assert.equal(taken.code, 0, taken.err.join('\n'));
    assert.equal(exported(taken.out, 'HUB_DEVICE'), "export HUB_DEVICE='pixel'");
    assert.equal(s.owner('res-pixel')?.kind, 'lease');
    // Release by the lease id says the device word.
    const id = exported(taken.out, 'HUB_LEASE_ID').match(/'(.+)'/)[1];
    const released = await s.cli(['release', id]);
    assert.deepEqual([released.code, released.out], [0, [`HUB_DEVICE_RELEASED pixel ${id}`]]);
  } finally { s.cleanup(); }
});

test('the phone Pool: s24, s26, then registered phones in created_at order; with both seeded held it takes the registered one', async () => {
  const s = scratch();
  try {
    await s.register('pixel-a', { model: PIXEL.model, serial: PIXEL.serial });
    await s.register('pixel-b', { model: PIXEL_B.model, serial: PIXEL_B.serial });
    const fleet = claims.loadFleet(s.env);
    const members = claims.resolve('phone', { fleet, env: s.env, ids: false }).members;
    assert.deepEqual(members.map(phone => phone.device), ['s24', 's26', 'pixel-a', 'pixel-b']);
    for (const lock of ['s24', 'adb']) await acquireLease(lock, { holder: 'other', why: 'held', forMs: 600_000, env: s.env, log: () => {}, pollMs: 5 });
    const taken = await s.cli(leaseArgs('phone'));
    assert.equal(taken.code, 0, taken.err.join('\n'));
    assert.equal(exported(taken.out, 'HUB_DEVICE'), "export HUB_DEVICE='pixel-a'");
    assert.equal(s.owner('res-pixel-a')?.kind, 'lease');
    assert.equal(s.owner('res-pixel-b'), null);
  } finally { s.cleanup(); }
});

test('a QA runtime phone is not a phone member, but its name and --match name= take it', async () => {
  const s = scratch({ qa: qaFile() });
  try {
    await s.register('pixel', { model: PIXEL.model, serial: PIXEL.serial });
    const fleet = claims.loadFleet(s.env);
    assert.ok(fleet.some(phone => phone.lock === 'res-pixel-qa'), 'the file created with the QA phone imported it');
    assert.deepEqual(claims.resolve('phone', { fleet, env: s.env, ids: false }).members.map(phone => phone.device), ['s24', 's26', 'pixel']);
    const named = await s.cli(leaseArgs('pixel-qa'));
    assert.equal(named.code, 0, named.err.join('\n'));
    assert.equal(exported(named.out, 'HUB_DEVICE'), "export HUB_DEVICE='pixel-qa'");
    assert.equal(s.owner('res-pixel-qa')?.kind, 'lease');
    const busy = await s.cli(leaseArgs(null, '--match', 'name=pixel-qa'));
    assert.equal(busy.code, 76, 'held now, the match finds it and it is busy');
    assert.equal((await s.cli(['release', exported(named.out, 'HUB_LEASE_ID').match(/'(.+)'/)[1]])).code, 0);
    const matched = await s.cli(leaseArgs(null, '--match', 'name=pixel-qa'));
    assert.equal(matched.code, 0, matched.err.join('\n'));
    assert.equal(exported(matched.out, 'HUB_DEVICE'), "export HUB_DEVICE='pixel-qa'");
  } finally { s.cleanup(); }
});

test('--match api_level and --match name= take a phone only the Registry knows', async () => {
  const s = scratch();
  try {
    await s.register('pixel', { model: PIXEL.model, serial: PIXEL.serial }, '--cap', 'api_level=35');
    const taken = await s.cli(leaseArgs(null, '--match', 'api_level>=35'));
    assert.equal(taken.code, 0, taken.err.join('\n'));
    assert.equal(exported(taken.out, 'HUB_DEVICE'), "export HUB_DEVICE='pixel'");
    assert.equal((await s.cli(['release', exported(taken.out, 'HUB_LEASE_ID').match(/'(.+)'/)[1]])).code, 0);
    const named = await s.cli(leaseArgs(null, '--match', 'name=pixel'));
    assert.equal(named.code, 0, named.err.join('\n'));
    assert.equal(exported(named.out, 'HUB_DEVICE'), "export HUB_DEVICE='pixel'");
  } finally { s.cleanup(); }
});

test('status --json lists the registered phone with its Resource, Reachability and deploy_target, and its held lock row', async () => {
  const s = scratch();
  try {
    await s.register('pixel', { model: PIXEL.model, serial: PIXEL.serial });
    const row = result => result.phones.find(phone => phone.device === 'pixel');
    const free = JSON.parse((await s.cli(['status', '--json'])).out.join('\n'));
    assert.equal(row(free).resource, 'res-pixel');
    assert.deepEqual(Object.keys(row(free).reachability), ['state', 'checked_at', 'age_ms', 'stale']);
    assert.equal(row(free).deploy_target, false);
    assert.equal(row(free).held, 'free');
    await s.cli(leaseArgs('pixel'));
    const held = JSON.parse((await s.cli(['status', '--json'])).out.join('\n'));
    assert.equal(row(held).held, 'lease');
    const lock = held.locks.find(entry => entry.lock === 'res-pixel');
    assert.deepEqual([lock.device, lock.resource, lock.deploy_target], ['pixel', 'res-pixel', false]);
    assert.deepEqual(lock.reachability, row(held).reachability);
    const text = await s.cli(['status']);
    assert.ok(text.out.some(line => /^ {2}pixel {2}LEASE /.test(line) && /serial PIXEL9SN/.test(line)), text.out.join('\n'));
  } finally { s.cleanup(); }
});

test('retired: a take by name or id is HUB_RESOURCE_RETIRED (exit 2), nothing is held, and status no longer lists it', async () => {
  const s = scratch();
  try {
    await s.register('pixel', { model: PIXEL.model, serial: PIXEL.serial });
    const retired = await s.cli(['registry', 'retire', 'res-pixel', '--holder', 'tester']);
    assert.equal(retired.code, 0, retired.err.join('\n'));
    for (const word of ['pixel', 'res-pixel']) {
      const refused = await s.cli(leaseArgs(word));
      assert.equal(refused.code, 2, word);
      assert.match(refused.err.join('\n'), new RegExp(`^HUB_RESOURCE_RETIRED ${word} .*retired`), word);
      assert.deepEqual(refused.out, []);
    }
    assert.equal(s.owner('res-pixel'), null);
    assert.ok(!s.events().some(event => event.event === 'acquire'));
    const status = JSON.parse((await s.cli(['status', '--json'])).out.join('\n'));
    assert.ok(!status.phones.some(phone => phone.device === 'pixel'));
    // Only the seeded phones are left, and `phone` still serves.
    assert.equal((await s.cli(leaseArgs('phone'))).code, 0);
  } finally { s.cleanup(); }
});

test('retiring: a held phone that is retired stays listed, and releases by id', async () => {
  const s = scratch();
  try {
    await s.register('pixel', { model: PIXEL.model, serial: PIXEL.serial });
    const taken = await s.cli(leaseArgs('pixel'));
    const id = exported(taken.out, 'HUB_LEASE_ID').match(/'(.+)'/)[1];
    const retired = await s.cli(['registry', 'retire', 'res-pixel', '--holder', 'tester']);
    assert.equal(retired.out[0], 'HUB_DEVICE_RETIRED res-pixel retiring');
    const status = JSON.parse((await s.cli(['status', '--json'])).out.join('\n'));
    assert.ok(status.phones.some(phone => phone.device === 'pixel' && phone.held === 'lease'));
    const released = await s.cli(['release', id]);
    assert.deepEqual([released.code, released.out], [0, [`HUB_DEVICE_RELEASED pixel ${id}`]]);
    assert.ok(!JSON.parse((await s.cli(['status', '--json'])).out.join('\n')).phones.some(phone => phone.device === 'pixel'));
  } finally { s.cleanup(); }
});

test('retiring: a retired phone with a queued waiter and no owner stays listed (AD-31)', async () => {
  const s = scratch();
  try {
    await s.register('pixel', { model: PIXEL.model, serial: PIXEL.serial });
    const taken = await s.cli(leaseArgs('pixel'));
    const id = exported(taken.out, 'HUB_LEASE_ID').match(/'(.+)'/)[1];
    // A live waiter's ticket (this process is alive), left in the queue when the holder lets go.
    const queue = join(s.env.HUB_LOCK_DIR, 'res-pixel.queue');
    mkdirSync(queue, { recursive: true });
    const requested = Date.now();
    const ticket = buildTicket('lease', { env: s.env, requested, lease_id: 'l-waiter000001', holder: 'waiter', why: 'queued' });
    writeFileSync(join(queue, `${String(requested).padStart(15, '0')}-000001-${String(process.pid).padStart(8, '0')}.json`), JSON.stringify(ticket));
    assert.equal((await s.cli(['release', id])).code, 0);
    assert.equal(s.owner('res-pixel'), null);
    const retired = await s.cli(['registry', 'retire', 'res-pixel', '--holder', 'tester']);
    assert.equal(retired.out[0], 'HUB_DEVICE_RETIRED res-pixel retiring');
    const status = JSON.parse((await s.cli(['status', '--json'])).out.join('\n'));
    assert.ok(status.phones.some(phone => phone.device === 'pixel' && phone.held === 'free'), 'queued, so retiring and still listed');
  } finally { s.cleanup(); }
});

test('no serial: a phone registered with a model alone is AWAY at once and holds nothing; --no-connect leases it', async () => {
  const s = scratch();
  try {
    await s.register('nosn', { model: 'Pixel 6' });
    const away = await s.cli(leaseArgs('nosn'));
    assert.equal(away.code, 75);
    assert.deepEqual(away.out, ['HUB_DEVICE_AWAY nosn']);
    assert.match(away.err.join('\n'), /no serial registered \(lease it --no-connect\)/);
    assert.equal(s.owner('res-nosn'), null);
    assert.ok(!s.events().some(event => event.lock === 'res-nosn' && !event.event.startsWith('registry-')), 'refused before any acquire or queue');
    const taken = await s.cli(leaseArgs('nosn', '--no-connect'));
    assert.equal(taken.code, 0, taken.err.join('\n'));
    assert.equal(exported(taken.out, 'HUB_DEVICE'), "export HUB_DEVICE='nosn'");
    assert.equal(exported(taken.out, 'ANDROID_SERIAL'), undefined);
    assert.equal(s.owner('res-nosn')?.kind, 'lease');
    // In the status text the missing serial is a dash.
    assert.ok((await s.cli(['status'])).out.some(line => /^ {2}nosn .*serial - {2}lock res-nosn/.test(line)));
  } finally { s.cleanup(); }
});

test('the phone Pool skips a phone with no serial before any lock is taken: held s24 and s26 are BUSY, and a registered phone is then taken', async () => {
  const s = scratch();
  try {
    await s.register('nosn', { model: 'Pixel 6' });
    for (const lock of ['s24', 'adb']) await acquireLease(lock, { holder: 'other', why: 'held', forMs: 600_000, env: s.env, log: () => {}, pollMs: 5 });
    const busy = await s.cli(leaseArgs('phone'));
    assert.equal(busy.code, 76);
    assert.match(busy.err.join('\n'), /^HUB_DEVICE_BUSY phone /);
    assert.equal(s.owner('res-nosn'), null);
    assert.ok(!s.events().some(event => event.lock === 'res-nosn' && !event.event.startsWith('registry-')), 'no acquire, release or request names the no-serial phone');
    await s.register('pixel', { model: PIXEL.model, serial: PIXEL.serial });
    const taken = await s.cli(leaseArgs('phone'));
    assert.equal(taken.code, 0, taken.err.join('\n'));
    assert.equal(exported(taken.out, 'HUB_DEVICE'), "export HUB_DEVICE='pixel'");
    assert.equal(s.owner('res-nosn'), null);
    assert.ok(!s.events().some(event => event.lock === 'res-nosn' && !event.event.startsWith('registry-')));
  } finally { s.cleanup(); }
});

test('no registry file: the fleet is devices.json\'s, and lease s24|s26|phone behave as before', async () => {
  const s = scratch();
  try {
    assert.deepEqual(claims.loadFleet(s.env), claims.fleetOf(loadDevices(s.env)));
    assert.deepEqual(claims.loadFleet(s.env).map(phone => phone.device), ['s24', 's26']);
    const unknown = await s.cli(leaseArgs('pixel'));
    assert.equal(unknown.code, 2);
    assert.match(unknown.err[0], /unknown device "pixel" \(known: s24, s26, phone, emulator\)/);
    for (const word of ['s24', 's26', 'phone']) {
      const taken = await s.cli(leaseArgs(word));
      assert.equal(taken.code, 0, `${word}: ${taken.err.join('\n')}`);
      await s.cli(['release', '--any']);
    }
    assert.equal(readdirSync(s.env.HUB_LOCK_DIR).includes('registry.json'), false, 'a lease writes no Registry');
  } finally { s.cleanup(); }
});

test('an unreadable registry file: the seed fleet, behaviour as before, and exactly one warning per command', async () => {
  const s = scratch();
  try {
    mkdirSync(s.env.HUB_LOCK_DIR, { recursive: true });
    writeFileSync(registryPath(s.env), 'not json{');
    assert.deepEqual(claims.loadFleet(s.env, { warn: () => {} }).map(phone => phone.device), ['s24', 's26']);
    // In order: the S24 is free, `phone` then takes the S26, status only looks, and with both held the match is busy.
    const commands = [
      [leaseArgs('s24'), 0],
      [leaseArgs('phone'), 0],
      [['status'], 0],
      [leaseArgs(null, '--match', 'kind=phone'), 76],
      [['registry', 'list'], 0],
    ];
    for (const [argv, code] of commands) {
      const result = await s.cli(argv);
      assert.equal(result.code, code, `${argv.join(' ')}: ${result.err.join('\n')}`);
      assert.equal(warnings(result.err).length, 1, `${argv.join(' ')}: ${result.err.join('\n')}`);
    }
    assert.equal(readFileSync(registryPath(s.env), 'utf8'), 'not json{', 'an unreadable file is never written');
  } finally { s.cleanup(); }
});

test('matchTarget says why a phone on another host is not leasable here', () => {
  const resources = [
    { id: 'res-far', lock: 'res-far', name: 'far', words: [], display_name: 'Far', kind: 'phone', host: 'mac', identity: { serial: 'FAR1', model: 'Far' }, capabilities: {}, deploy_target: false, seeded: false },
  ];
  const ctx = { env: {}, fleet: [], registry: () => ({ format: 1, rev: 1, resources, pools: {} }), policy };
  assert.throws(() => claims.matchTarget('kind=phone', {}, ctx), error => error.code === 'HUB_NO_MATCH' && /res-far is a phone on mac; hub-device leases a phone on linux/.test(error.reason));
});
