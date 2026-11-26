// Story 5.7: `hub-device lease|run --match <query>` through `main`, hermetic: temp lock and event dirs, the adb wire and the adb client
// injected, the QA marks through an injected `qaDevices`, Capabilities through an injected `registry`. Nothing reaches a real adb
// server, device or QA file.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readEvents } from '../ci/lib/events.mjs';
import { loadDevices } from '../ci/lib/devices.mjs';
import { loadPolicy } from '../ci/lib/policy.mjs';
import { hermetic } from '../ci/test-fixtures.mjs';
import { seed } from '../registry/seed.mjs';
import { applySeed, registryPath, writeRegistry } from '../registry/store.mjs';
import * as claims from './claims.mjs';
import { main } from './hub-device.mjs';
import { fakeWire } from './wire-fixtures.mjs';

hermetic();

const S24 = { serial: 'R5CX31AEJDA', model: 'SM-S928U' };
const S26 = { serial: 'R5GL43A7PCH', model: 'SM-S948U' };
const idOf = ({ serial }) => `adb-${serial}-zz._adb-tls-connect._tcp`;
const listing = (...entries) => entries.map(([phone, state = 'device']) => ({ id: idOf(phone), state, model: phone.model.replace('-', '_') }));
const serverUp = () => ({ adb_servers: [{ port: 5037, pid: 4242, cwd: null }], emulators: [], xvfb: [] });
const serverDown = () => ({ adb_servers: [], emulators: [], xvfb: [] });
const qaS24 = () => [{ name: 'S24', model: S24.model, serial: S24.serial }];
const linux = () => 'linux';

// The adb client `findPhone` drives: both phones present, or only the ones named.
const adbWith = (...phones) => () => ({
  startServer: async () => {},
  devices: async () => phones.map(phone => ({ id: idOf(phone), state: 'device' })),
  prop: async (id, name) => { const phone = phones.find(entry => idOf(entry) === id); return name === 'ro.serialno' ? phone.serial : phone.model; },
});

function side({ wire = fakeWire({ listed: listing([S24], [S26]) }), inventory = serverUp, adbFactory = adbWith(S24, S26), qaDevices = qaS24, hostKey = linux, ...more } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'lease-match-'));
  const env = { PATH: process.env.PATH, HOME: root, USER: 'tester', HUB_LOCK_DIR: join(root, 'locks'), HUB_EVENT_DIR: join(root, 'events'), HUB_DEVICE_POLL_MS: '5', HUB_DEVICE_PHONE_SLICE_MS: '50', HUB_ADB_SERVER_PORT: '5037' };
  const cli = async (argv, extra = {}) => {
    const out = [];
    const err = [];
    const code = await main(argv, { env, stdout: line => out.push(line), stderr: line => err.push(line), inventory, adbWire: wire, adbFactory, qaDevices, hostKey, ...more, ...extra });
    return { code, out, err };
  };
  const events = () => [...readEvents({ env })];
  const locks = () => { try { return readdirSync(env.HUB_LOCK_DIR).filter(entry => !entry.endsWith('.queue') || readdirSync(join(env.HUB_LOCK_DIR, entry)).length > 0); } catch { return []; } };
  const owner = lock => { try { return JSON.parse(readFileSync(join(env.HUB_LOCK_DIR, `${lock}.lock/owner.json`), 'utf8')); } catch { return null; } };
  return { root, env, wire, cli, events, locks, owner, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const lease = (...rest) => ['lease', '--for', '30m', '--why', 'x', '--holder', 'h', '--id', 'l-aaaaaaaaaaaa', '--wait', '0', ...rest];
const leaseWord = (word, ...rest) => ['lease', word, '--for', '30m', '--why', 'x', '--holder', 'h', '--id', 'l-aaaaaaaaaaaa', '--wait', '0', ...rest];
const names = events => events.map(event => event.event);

// ---- the CLI form ----

test('--match kind=phone with the S24 dedicated and the S26 free prints what `lease s26` prints, with one Pool request named by the query', async () => {
  const a = side();
  const b = side();
  try {
    const matched = await a.cli(lease('--match', 'kind=phone'));
    const named = await b.cli(leaseWord('s26'));
    assert.equal(matched.code, 0, matched.err.join('\n'));
    assert.deepEqual(matched.out, named.out);
    assert.deepEqual(matched.out, ["export HUB_LEASE_ID='l-aaaaaaaaaaaa'", "export HUB_DEVICE='s26'", "export ANDROID_ADB_SERVER_PORT='5037'", `export ANDROID_SERIAL='${idOf(S26)}'`]);
    assert.equal(a.owner('adb').lease_id, 'l-aaaaaaaaaaaa');
    assert.equal(a.owner('s24'), null, 'the dedicated phone was never offered');
    assert.deepEqual(names(a.events()), ['request', 'acquire']);
    assert.deepEqual(a.events().map(event => event.pool ?? null), ['match:kind=phone', 'match:kind=phone']);
    assert.equal(a.events()[1].lock, 'adb');
    assert.equal(a.events().filter(event => event.event === 'cancel' || event.event === 'timeout').length, 0);
  } finally { a.cleanup(); b.cleanup(); }
});

test('--match with --json reports the phone it took, like any lease', async () => {
  const s = side();
  try {
    const result = await s.cli(lease('--match', 'kind=phone,deploy_target=true', '--json'));
    assert.equal(result.code, 0, result.err.join('\n'));
    const body = JSON.parse(result.out.join('\n'));
    assert.equal(body.device, 's26');
    assert.equal(body.env.HUB_DEVICE, 's26');
  } finally { s.cleanup(); }
});

test('a request the S24\'s dedicated mark would otherwise serve: asked for or named, it is the S24; without the file it is served to any query', async () => {
  const asked = side();
  const named = side();
  const open = side({ qaDevices: () => [] });
  try {
    assert.equal((await asked.cli(lease('--match', 'kind=phone,dedicated_qa=true'))).out[1], "export HUB_DEVICE='s24'");
    assert.equal((await named.cli(lease('--match', 'name=s24'))).out[1], "export HUB_DEVICE='s24'");
    assert.equal((await open.cli(lease('--match', 'kind=phone'))).out[1], "export HUB_DEVICE='s24'", 'no QA mark, the S24 is first in the list');
  } finally { asked.cleanup(); named.cleanup(); open.cleanup(); }
});

// Capabilities the committed seed does not carry yet (Epic 6): an injected registry.
const withApi = () => {
  const registry = seed(loadDevices({}), { qaDevices: () => [] });
  registry.resources.find(record => record.id === 's24').capabilities.api_level = 33;
  registry.resources.find(record => record.id === 's26').capabilities.api_level = 35;
  return registry;
};

test('>= and <= pick the phone by api_level (through the registry seam)', async () => {
  const high = side({ registry: withApi });
  const low = side({ registry: withApi });
  try {
    const up = await high.cli(lease('--match', 'api_level>=34'));
    assert.equal(up.code, 0, up.err.join('\n'));
    assert.equal(up.out[1], "export HUB_DEVICE='s26'");
    const down = await low.cli(lease('--match', 'api_level<=33,kind=phone'));
    assert.equal(down.out[1], "export HUB_DEVICE='s24'");
    assert.equal(low.events()[0].pool, 'match:api_level<=33,kind=phone');
  } finally { high.cleanup(); low.cleanup(); }
});

test('no match fails at once: exit 2, HUB_NO_MATCH with a reason for each Resource, no event, nothing held', async () => {
  const s = side();
  try {
    const result = await s.cli(lease('--match', 'api_level>=34'));
    assert.equal(result.code, 2);
    assert.deepEqual(result.out, []);
    assert.equal(result.err.length, 1);
    assert.match(result.err[0], /^HUB_NO_MATCH match:api_level>=34 no Resource matches: s24 has no api_level; s26 has no api_level; ios-lane has no api_level; emulator has no api_level$/);
    assert.deepEqual(s.events(), []);
    assert.deepEqual(s.locks(), []);
  } finally { s.cleanup(); }
});

test('a --for over the deploy cap leaves only the S24, and with the S24 dedicated nothing: HUB_NO_MATCH names the cap', async () => {
  const s = side();
  const open = side({ qaDevices: () => [] });
  try {
    const result = await s.cli(['lease', '--match', 'kind=phone', '--for', '2h', '--why', 'x', '--wait', '0']);
    assert.equal(result.code, 2);
    assert.match(result.err[0], /^HUB_NO_MATCH match:kind=phone no Resource matches: s24 is dedicated_qa \(name it or ask for dedicated_qa\); s26 is a deploy target capped at 60 min, under the 120 min asked; ios-lane kind is ios-lane, not phone; emulator kind is emulator-pool, not phone$/);
    assert.deepEqual(s.events(), []);
    const served = await open.cli(['lease', '--match', 'kind=phone', '--for', '2h', '--why', 'x', '--wait', '0']);
    assert.equal(served.code, 0, served.err.join('\n'));
    assert.equal(served.out.find(line => line.startsWith('export HUB_DEVICE')), "export HUB_DEVICE='s24'");
  } finally { s.cleanup(); open.cleanup(); }
});

test('members on two hosts are HUB_POOL_CROSS_HOST, exit 2, nothing written', async () => {
  const s = side();
  try {
    const result = await s.cli(lease('--match', 'deploy_target=true'));
    assert.equal(result.code, 2);
    assert.match(result.err[0], /^HUB_POOL_CROSS_HOST match:deploy_target=true the match spans hosts: linux \(s26\), mac \(ios-lane\)/);
    assert.deepEqual(s.events(), []);
    assert.deepEqual(s.locks(), []);
  } finally { s.cleanup(); }
});

test('a non-phone and a phone only the QA file knows are left out with their reason; with nothing else it is HUB_NO_MATCH', async () => {
  const s = side({ qaDevices: () => [...qaS24(), { name: 'Pixel', model: 'Pixel 9', serial: 'ZZ9PIXEL' }] });
  try {
    const emulator = await s.cli(lease('--match', 'kind=emulator-pool'));
    assert.equal(emulator.code, 2);
    assert.match(emulator.err[0], /^HUB_NO_MATCH match:kind=emulator-pool no Resource matches: .*emulator is an emulator-pool; --match takes a phone$/);
    const qaOnly = await s.cli(lease('--match', 'name=pixel'));
    assert.equal(qaOnly.code, 2);
    assert.match(qaOnly.err[0], /res-pixel is known only from the QA file; hub-device cannot lease it yet$/);
    assert.deepEqual(s.events(), []);
    // a QA-only phone beside a servable one: the servable one is taken
    const both = await s.cli(lease('--match', 'kind=phone,dedicated_qa=true'));
    assert.equal(both.code, 0, both.err.join('\n'));
    assert.equal(both.out[1], "export HUB_DEVICE='s24'");
  } finally { s.cleanup(); }
});

test('a broken QA file fails the request (exit 1), it is never guessed around', async () => {
  const s = side({ qaDevices: undefined });
  try {
    const file = join(s.root, 'qa.json');
    writeFileSync(file, 'not json');
    s.env.HUB_QA_DEVICES = file;
    const result = await s.cli(lease('--match', 'kind=phone'), { qaDevices: undefined });
    assert.equal(result.code, 1);
    assert.match(result.err.join('\n'), /not valid JSON/);
    assert.doesNotMatch(result.err.join('\n'), /R5/);
    assert.deepEqual(s.events(), []);
  } finally { s.cleanup(); }
});

// ---- away ----

test('every match absent, offline or unauthorized is HUB_DEVICE_AWAY (75) before any event, naming each', async () => {
  for (const [state, listed] of [['absent', []], ['offline', listing([S26, 'offline'])], ['unauthorized', listing([S26, 'unauthorized'])]]) {
    const s = side({ wire: fakeWire({ listed }) });
    try {
      const result = await s.cli(lease('--match', 'kind=phone'));
      assert.equal(result.code, 75, state);
      assert.deepEqual(result.out, ['HUB_DEVICE_AWAY match:kind=phone']);
      assert.match(result.err.join('\n'), new RegExp(`match:kind=phone is away: s26 ${state}$`));
      assert.deepEqual(s.events(), [], state);
      assert.deepEqual(s.locks(), [], state);
    } finally { s.cleanup(); }
  }
  const both = side({ qaDevices: () => [], wire: fakeWire({ listed: listing([S24, 'unauthorized']) }) });
  try {
    const result = await both.cli(lease('--match', 'kind=phone'));
    assert.equal(result.code, 75);
    assert.match(result.err.join('\n'), /is away: s24 unauthorized, s26 absent$/);
  } finally { both.cleanup(); }
});

test('a member that is away is dropped and the next is tried, which is the ordered Pool try with the first one gone', async () => {
  const s = side({ qaDevices: () => [], wire: fakeWire({ listed: listing([S26]) }), adbFactory: adbWith(S26) });
  try {
    const result = await s.cli(lease('--match', 'kind=phone'));
    assert.equal(result.code, 0, result.err.join('\n'));
    assert.equal(result.out[1], "export HUB_DEVICE='s26'");
    assert.deepEqual(names(s.events()), ['request', 'acquire']);
  } finally { s.cleanup(); }
});

test('an unknown reading drops nothing: no adb server, a wire that fails, a host with no key, or a Mac key', async () => {
  const cases = [
    ['no adb server', { inventory: serverDown }],
    ['a wire that fails', { wire: fakeWire({ fail: 'devices' }) }],
    ['no host key', { hostKey: () => { throw Object.assign(new Error('no key'), { code: 'HUB_HOST_UNKNOWN' }); } }],
  ];
  for (const [label, seams] of cases) {
    const wire = seams.wire ?? fakeWire({ listed: [] });
    const s = side({ ...seams, wire, adbFactory: () => ({ startServer: async () => {}, devices: async () => [], prop: async () => '' }) });
    try {
      const result = await s.cli(lease('--match', 'kind=phone'));
      // the ordered try ran and found no phone (today's AWAY verdict, as `lease phone` writes it: the lock taken and given back, then the timeout)
      assert.equal(result.code, 75, label);
      assert.deepEqual(result.out, ['HUB_DEVICE_AWAY match:kind=phone'], label);
      assert.deepEqual(names(s.events()), ['request', 'acquire', 'release', 'timeout'], label);
      assert.equal(s.events()[0].pool, 'match:kind=phone');
      if (label === 'no adb server') assert.deepEqual(s.wire.requests, [], 'no server running: no wire was opened');
      if (label === 'no host key') assert.deepEqual(s.wire.requests, [], label);
    } finally { s.cleanup(); }
  }
});

test('the away check asks the read-only wire only', async () => {
  const s = side();
  try {
    await s.cli(lease('--match', 'kind=phone'));
    assert.ok(s.wire.requests.length > 0);
    assert.ok(s.wire.requests.every(request => ['host:version', 'host:devices-l'].includes(request) || /^host:transport:|^shell:getprop ro\.serialno$/.test(request)), s.wire.requests.join());
  } finally { s.cleanup(); }
});

test('--no-connect is the lock only: with every match away it still takes the S26, like `lease s26 --no-connect`', async () => {
  const s = side({ wire: fakeWire({ listed: [] }) });
  try {
    const result = await s.cli(lease('--match', 'kind=phone', '--no-connect'));
    assert.equal(result.code, 0, result.err.join('\n'));
    assert.equal(result.out[1], "export HUB_DEVICE='s26'");
    assert.equal(s.owner('adb').lease_id, 'l-aaaaaaaaaaaa');
    assert.deepEqual(names(s.events()), ['request', 'acquire']);
    assert.deepEqual(s.events().map(event => event.pool), ['match:kind=phone', 'match:kind=phone']);
    assert.deepEqual(s.wire.requests, [], 'no reading was taken');
  } finally { s.cleanup(); }
});

// ---- a held matching phone ----

const holdS26 = async s => {
  const held = await s.cli(['lease', 's26', '--for', '30m', '--why', 'first', '--holder', 'first', '--id', 'l-hhhhhhhhhhhh', '--wait', '0']);
  assert.equal(held.code, 0, held.err.join('\n'));
  return s.events().length;
};
const matchLease = (...rest) => ['lease', '--match', 'kind=phone', '--for', '30m', '--why', 'x', '--holder', 'h', '--id', 'l-mmmmmmmmmmmm', ...rest];

test('a held matching phone is BUSY (76): one request and one timeout under the match Pool, nothing new held', async () => {
  const s = side();
  try {
    const before = await holdS26(s);
    const result = await s.cli(matchLease('--wait', '0'));
    assert.equal(result.code, 76);
    assert.deepEqual(result.out, []);
    assert.ok(result.err.some(line => line.startsWith('HUB_DEVICE_BUSY match:kind=phone ')), result.err.join('\n'));
    assert.equal(s.owner('adb').lease_id, 'l-hhhhhhhhhhhh', 'the first lease still holds it');
    assert.equal(s.owner('s24'), null);
    const mine = s.events().slice(before);
    assert.deepEqual(names(mine), ['request', 'timeout']);
    assert.deepEqual(mine.map(event => event.pool), ['match:kind=phone', 'match:kind=phone']);
  } finally { s.cleanup(); }
});

test('a held matching phone that is freed while the request waits is taken', async () => {
  const s = side();
  try {
    await holdS26(s);
    const waiting = s.cli(matchLease('--wait', '5s'));
    for (let tries = 0; tries < 200 && !s.events().some(event => event.event === 'request' && event.pool === 'match:kind=phone'); tries += 1) await new Promise(done => setTimeout(done, 10));
    assert.ok(s.events().some(event => event.pool === 'match:kind=phone'), 'the match request was written while it waited');
    assert.equal((await s.cli(['release', 'l-hhhhhhhhhhhh'])).code, 0);
    const result = await waiting;
    assert.equal(result.code, 0, result.err.join('\n'));
    assert.equal(result.out[1], "export HUB_DEVICE='s26'");
    assert.equal(s.owner('adb').lease_id, 'l-mmmmmmmmmmmm');
    assert.deepEqual(names(s.events().filter(event => event.pool === 'match:kind=phone')), ['request', 'acquire']);
  } finally { s.cleanup(); }
});

test('SIGINT while the request waits on a held phone cancels it: one cancel, nothing new held', async () => {
  const s = side();
  try {
    await holdS26(s);
    const signals = new EventEmitter();
    const waiting = s.cli(matchLease('--wait', '30s'), { signals });
    for (let tries = 0; tries < 200 && !s.events().some(event => event.pool === 'match:kind=phone'); tries += 1) await new Promise(done => setTimeout(done, 10));
    assert.ok(s.events().some(event => event.pool === 'match:kind=phone'), 'the request was written');
    signals.emit('SIGINT', 'SIGINT');
    const result = await waiting;
    assert.equal(result.code, 130);
    const mine = s.events().filter(event => event.pool === 'match:kind=phone');
    assert.deepEqual(names(mine), ['request', 'cancel']);
    assert.equal(mine[1].reason, 'aborted');
    assert.equal(s.owner('adb').lease_id, 'l-hhhhhhhhhhhh', 'the first lease still holds it');
    assert.equal(s.owner('s24'), null);
  } finally { s.cleanup(); }
});

// ---- run ----

test('run --match takes the phone, runs the command with it exported and gives it back', async () => {
  const s = side();
  try {
    const mark = join(s.root, 'seen');
    const result = await s.cli(['run', '--match', 'kind=phone', '--wait', '0', '--', process.execPath, '-e', `require('fs').writeFileSync(${JSON.stringify(mark)}, process.env.HUB_DEVICE + ' ' + process.env.ANDROID_SERIAL)`]);
    assert.equal(result.code, 0, result.err.join('\n'));
    assert.equal(readFileSync(mark, 'utf8'), `s26 ${idOf(S26)}`);
    assert.equal(s.owner('adb'), null, 'given back');
    assert.deepEqual(names(s.events()).slice(0, 2), ['request', 'acquire']);
    assert.equal(s.events()[0].pool, 'match:kind=phone');
    const none = await s.cli(['run', '--match', 'api_level>=34', '--wait', '0', '--', 'true']);
    assert.equal(none.code, 2);
    assert.match(none.err[0], /^HUB_NO_MATCH match:api_level>=34 /);
  } finally { s.cleanup(); }
});

// ---- usage ----

test('usage: a bad query, a word with --match, emulator, other commands and the check order', async () => {
  const s = side();
  try {
    const usage = async (argv, pattern) => {
      const result = await s.cli(argv);
      assert.equal(result.code, 2, argv.join(' '));
      assert.match(result.err.join('\n'), pattern, argv.join(' '));
      assert.deepEqual(result.out, [], argv.join(' '));
    };
    await usage(lease('--match', 'api_level>=abc'), /^hub-device: --match clause "api_level>=abc": >= takes a number/);
    await usage(lease('--match', ''), /^hub-device: --match needs a query/);
    await usage(lease('--match', 'kind=phone,'), /empty clause/);
    await usage(lease('s24', '--match', 'kind=phone'), /^hub-device: lease takes a device word or --match, not both$/);
    await usage(['run', 's24', '--match', 'kind=phone', '--', 'true'], /^hub-device: run takes a device word or --match, not both$/);
    await usage(lease('emulator', '--match', 'kind=phone'), /takes a device word or --match, not both$/);
    await usage(['run', 'emulator', '--match', 'kind=phone', '--', 'true'], /takes a device word or --match, not both$/);
    for (const command of [['status'], ['discover'], ['release', 'l-x'], ['reservation', 'release', '--run', 'o--r--1']]) await usage([...command, '--match', 'kind=phone'], /^hub-device: unknown flag --match$/);
    // --for, --why, --wait, --pid and --id are checked before the query is read
    await usage(['lease', '--match', 'nonsense', '--why', 'x'], /^hub-device: --for <duration> is required$/);
    await usage(['lease', '--match', 'nonsense', '--for', '30m'], /^hub-device: --why <text> is required$/);
    await usage(['lease', '--match', 'nonsense', '--for', '3d', '--why', 'x'], /at most 48h/);
    await usage(['lease', '--match', 'nonsense', '--for', '30m', '--why', 'x', '--wait', 'soon'], /--wait: "soon" is not a duration/);
    await usage(['lease', '--match', 'nonsense', '--for', '30m', '--why', 'x', '--pid', '0'], /--pid takes a live process id/);
    await usage(['lease', '--match', 'nonsense', '--for', '30m', '--why', 'x'], /^hub-device: --match clause "nonsense"/);
    assert.deepEqual(s.events(), []);
    assert.deepEqual(s.locks(), []);
    const none = await s.cli(['lease']);
    assert.match(none.err.join('\n'), /^hub-device: unknown device ""/, 'no word and no --match is the old refusal');
  } finally { s.cleanup(); }
});

test('--id names one lease: a match with an id that is already taken is refused before matching', async () => {
  const s = side();
  try {
    assert.equal((await s.cli(lease('--match', 'kind=phone'))).code, 0);
    const again = await s.cli(lease('--match', 'kind=phone'));
    assert.equal(again.code, 2);
    assert.match(again.err.join('\n'), /--id l-aaaaaaaaaaaa already names a lease or a waiter on s26/);
  } finally { s.cleanup(); }
});

test('the USAGE text names --match', async () => {
  const s = side();
  try {
    const result = await s.cli([]);
    assert.equal(result.code, 2);
    assert.match(result.err[0], /^hub-device: usage: hub-device lease s24\|s26\|phone --for <dur>/);
    assert.match(result.err[0], / \| lease --match <query> --for <dur> --why <text> /);
    assert.match(result.err[0], / \| run --match <query> \[--for <dur>\]/);
  } finally { s.cleanup(); }
});

// ---- the library ----

test('resolve("phone") takes its members from the matcher and equals [s24, s26] for the committed devices.json', () => {
  const env = { HUB_LOCK_DIR: process.env.HUB_LOCK_DIR };
  const fleet = claims.loadFleet(env);
  const target = claims.resolve('phone', { fleet, env, ids: false });
  assert.deepEqual(target.members.map(phone => phone.device), ['s24', 's26']);
  assert.deepEqual(target.members, fleet);
  assert.equal(target.pool, 'phone');
  assert.equal(target.by, 'word');
});

test('matchTarget returns the Pool target with the canonical label, and the same policy the cap uses', () => {
  const env = { HUB_LOCK_DIR: process.env.HUB_LOCK_DIR };
  const fleet = claims.loadFleet(env);
  const ctx = { env, fleet, qaDevices: qaS24, policy: loadPolicy().policy };
  const target = claims.matchTarget('kind=phone,deploy_target=true', { forMs: 1_800_000 }, ctx);
  assert.deepEqual({ kind: target.kind, by: target.by, pool: target.pool, members: target.members.map(phone => phone.device) }, { kind: 'pool', by: 'match', pool: 'match:kind=phone,deploy_target=true', members: ['s26'] });
  assert.throws(() => claims.matchTarget('kind=phone', { forMs: 7_200_000 }, ctx), error => error.code === 'HUB_NO_MATCH' && /capped at 60 min/.test(error.reason));
  assert.throws(() => claims.matchTarget('kind=', {}, ctx), error => error.code === 'HUB_USAGE');
  assert.equal(claims.exitCodeOf({ code: 'HUB_NO_MATCH' }), 2);
  assert.equal(claims.exitCodeOf({ code: 'HUB_POOL_CROSS_HOST' }), 2);
});

test('take() of a match target is the same Pool request the CLI makes, and a library caller gets the away verdict too', async () => {
  const s = side({ wire: fakeWire({ listed: [] }) });
  try {
    const fleet = claims.loadFleet(s.env);
    const ctx = claims.createContext({ env: s.env, fleet, hostKey: linux, inventory: serverUp, adbWire: s.wire, qaDevices: qaS24, adbFactory: adbWith(S26) });
    const target = claims.matchTarget('kind=phone', { forMs: 1_800_000 }, ctx);
    const error = await claims.take(target, { holder: 'h', why: 'x', forMs: 1_800_000, waitMs: 0, id: 'l-bbbbbbbbbbbb', holderPid: null, noConnect: false, phoneWaitMs: 0 }, ctx).then(() => null, caught => caught);
    assert.equal(error.code, 'HUB_DEVICE_AWAY');
    assert.equal(claims.exitCodeOf(error), 75);
    assert.equal(error.reason, 's26 absent');
    assert.ok(!existsSync(join(s.env.HUB_EVENT_DIR)) || s.events().length === 0);
  } finally { s.cleanup(); }
});

// ---- the Registry file (Story 6.2): read fresh on every call, the seed when it is missing or unreadable ----

const seededFile = () => structuredClone(seed(loadDevices({}), { qaDevices: () => [] }));
const withLevel = (resources, id, level) => resources.map(record => (record.id === id ? { ...record, capabilities: { ...record.capabilities, api_level: level } } : record));

test('--match reads registry.json on every call: a file giving s24 api_level 34 leases s24, and a second edit is seen by the next call', async () => {
  const s = side({ qaDevices: () => [] });
  try {
    const { resources, pools } = seededFile();
    await writeRegistry({ env: s.env, if_rev: 0, resources: withLevel(resources, 's24', 34), pools, log: () => {} });
    const first = await s.cli(lease('--match', 'api_level>=34'));
    assert.equal(first.code, 0, first.err.join('\n'));
    assert.equal(first.out[1], "export HUB_DEVICE='s24'");
    assert.equal(s.owner('s24').lease_id, 'l-aaaaaaaaaaaa');
    assert.deepEqual(first.err.filter(line => /warning/.test(line)), []);
    const release = await s.cli(['release', 'l-aaaaaaaaaaaa']);
    assert.equal(release.code, 0, release.err.join('\n'));
    await writeRegistry({ env: s.env, if_rev: 1, resources: withLevel(withLevel(resources, 's24', 30), 's26', 35), pools, log: () => {} });
    const second = await s.cli(lease('--match', 'api_level>=34'));
    assert.equal(second.code, 0, second.err.join('\n'));
    assert.equal(second.out[1], "export HUB_DEVICE='s26'", 'the second edit of the file was seen');
  } finally { s.cleanup(); }
});

test('a garbage registry.json warns HUB_REGISTRY_FORMAT once on stderr, the lease still resolves from the seed, and the file is untouched', async () => {
  const s = side();
  try {
    mkdirSync(s.env.HUB_LOCK_DIR, { recursive: true });
    writeFileSync(registryPath(s.env), 'not json{');
    const result = await s.cli(lease('--match', 'kind=phone'));
    assert.equal(result.code, 0, result.err.join('\n'));
    assert.equal(result.out[1], "export HUB_DEVICE='s26'", 'the seed: the S24 is dedicated, so the S26');
    const warned = result.err.filter(line => line.includes('HUB_REGISTRY_FORMAT'));
    assert.equal(warned.length, 1);
    assert.match(warned[0], /^hub-device: warning: HUB_REGISTRY_FORMAT: /);
    assert.equal(readFileSync(registryPath(s.env), 'utf8'), 'not json{');
    const { resources, pools } = seededFile();
    await assert.rejects(writeRegistry({ env: s.env, if_rev: 0, resources, pools, log: () => {} }), error => error.code === 'HUB_REGISTRY_FORMAT');
    assert.equal(readFileSync(registryPath(s.env), 'utf8'), 'not json{');
  } finally { s.cleanup(); }
});

// ---- Story 6.3: a take of a retired or seed-missing Resource ----

// Writes registry.json with the committed seed (no QA marks), then lets `change` mark records.
async function registryFile(s, change = records => records) {
  const seeded = seed(loadDevices({}), { qaDevices: () => [] });
  await writeRegistry({ env: s.env, if_rev: 0, resources: change(structuredClone(seeded.resources)), pools: seeded.pools, hostId: 'test-host', log: () => {} });
}
// The lock events (registry-* events are the file's own writes, not a take's).
const lockEvents = s => s.events().filter(event => !event.event.startsWith('registry-'));
const mark = (id, fields) => records => records.map(record => (record.id === id ? { ...record, ...fields } : record));

test('lease s24 with s24 seed_missing in registry.json: exit 2 with HUB_RESOURCE_RETIRED and seed-missing, nothing held, no event', async () => {
  const s = side();
  try {
    await registryFile(s, mark('s24', { seed_missing: true }));
    const result = await s.cli(leaseWord('s24'));
    assert.equal(result.code, 2);
    assert.deepEqual(result.out, []);
    assert.equal(result.err.length, 1);
    assert.match(result.err[0], /^HUB_RESOURCE_RETIRED s24 /);
    assert.match(result.err[0], /seed-missing/);
    assert.equal(s.owner('s24'), null);
    assert.deepEqual(s.locks().filter(name => name !== 'registry.json'), []);
    assert.deepEqual(lockEvents(s), []);
    // The same refusal for `run`, and a retired (not seed-missing) Resource says retired.
    const ran = await s.cli(['run', 's24', '--for', '5m', '--why', 'x', '--', 'true']);
    assert.equal(ran.code, 2);
    assert.match(ran.err[0], /^HUB_RESOURCE_RETIRED s24 /);
  } finally { s.cleanup(); }
});

test('a retired Resource says retired; the other phone is still taken', async () => {
  const s = side();
  try {
    await registryFile(s, mark('s24', { retired_at: '2026-11-24T00:00:00.000Z' }));
    const refused = await s.cli(leaseWord('s24'));
    assert.equal(refused.code, 2);
    assert.match(refused.err[0], /^HUB_RESOURCE_RETIRED s24 .*retired/);
    const taken = await s.cli(leaseWord('s26'));
    assert.equal(taken.code, 0, taken.err.join('\n'));
  } finally { s.cleanup(); }
});

test('a word gone from devices.json whose file record is seed_missing is refused, not "unknown device"', async () => {
  const s = side();
  try {
    await registryFile(s, mark('s24', { seed_missing: true }));
    const devices = loadDevices({});
    delete devices.android_extra;
    const file = join(s.root, 'devices.json');
    writeFileSync(file, JSON.stringify(devices));
    s.env.HUB_DEVICES = file;
    const result = await s.cli(leaseWord('s24'));
    assert.equal(result.code, 2);
    assert.match(result.err[0], /^HUB_RESOURCE_RETIRED s24 /);
    assert.doesNotMatch(result.err.join('\n'), /unknown device/);
    // A word nothing knows is still the usage error.
    const unknown = await s.cli(leaseWord('s99'));
    assert.match(unknown.err[0], /unknown device "s99"/);
  } finally { s.cleanup(); }
});

test('`lease phone` skips a seed-missing member and takes the next; every member out is HUB_RESOURCE_RETIRED', async () => {
  const some = side();
  const none = side();
  try {
    await registryFile(some, mark('s24', { seed_missing: true }));
    const taken = await some.cli(leaseWord('phone'));
    assert.equal(taken.code, 0, taken.err.join('\n'));
    assert.equal(taken.out[1], "export HUB_DEVICE='s26'");
    assert.equal(some.owner('s24'), null);

    await registryFile(none, records => mark('s26', { retired_at: '2026-11-24T00:00:00.000Z' })(mark('s24', { seed_missing: true })(records)));
    const refused = await none.cli(leaseWord('phone'));
    assert.equal(refused.code, 2);
    assert.match(refused.err[0], /^HUB_RESOURCE_RETIRED phone /);
    assert.deepEqual(lockEvents(none), []);
    assert.equal(none.owner('s26'), null);
  } finally { some.cleanup(); none.cleanup(); }
});

test('with no registry.json every take is as before, and an unreadable one refuses nothing', async () => {
  const plain = side();
  const garbled = side();
  try {
    const taken = await plain.cli(leaseWord('s24'));
    assert.equal(taken.code, 0, taken.err.join('\n'));
    assert.equal(plain.owner('s24').lease_id, 'l-aaaaaaaaaaaa');
    mkdirSync(garbled.env.HUB_LOCK_DIR, { recursive: true });
    writeFileSync(registryPath(garbled.env), '{ garbage');
    assert.equal((await garbled.cli(leaseWord('s24'))).code, 0);
  } finally { plain.cleanup(); garbled.cleanup(); }
});

test('refuseRetired finds a record by id, then name, then words; the QA file is never read', async () => {
  const s = side();
  try {
    // A directory where the QA file would be: reading it throws, so any QA read would fail this test.
    s.env.HUB_QA_DEVICES = s.root;
    await registryFile(s, mark('ios-lane', { seed_missing: true }));
    for (const word of ['ios-lane', 'ipad', 'mac']) assert.throws(() => claims.refuseRetired(word, { env: s.env }), error => error.code === 'HUB_RESOURCE_RETIRED' && error.reason === 'seed-missing' && error.resource === 'ios-lane' && error.status === 409, word);
    assert.doesNotThrow(() => claims.refuseRetired('s24', { env: s.env }));
    assert.doesNotThrow(() => claims.refuseRetired('phone', { env: s.env }));
  } finally { s.cleanup(); }
});

test('claims.take refuses a phone target whose Resource went seed_missing, holding and logging nothing; a lease taken before still releases', async () => {
  const s = side();
  try {
    const before = await s.cli(leaseWord('s24'));
    assert.equal(before.code, 0, before.err.join('\n'));
    assert.equal(s.owner('s24').lease_id, 'l-aaaaaaaaaaaa');
    await registryFile(s, mark('s24', { seed_missing: true }));
    const logged = lockEvents(s).length;
    const fleet = claims.loadFleet(s.env);
    const ctx = claims.createContext({ env: s.env, fleet, policy: loadPolicy().policy, adbFactory: adbWith(S24, S26) });
    const target = { kind: 'phone', by: 'word', entry: fleet.find(phone => phone.device === 's24') };
    await assert.rejects(
      () => claims.take(target, { holder: 'h2', why: 'again', forMs: 60_000, waitMs: 0, id: 'l-bbbbbbbbbbbb' }, ctx),
      error => error.code === 'HUB_RESOURCE_RETIRED' && error.reason === 'seed-missing' && error.resource === 's24' && error.status === 409,
    );
    assert.equal(s.owner('s24').lease_id, 'l-aaaaaaaaaaaa', 'the earlier lease is untouched');
    assert.equal(lockEvents(s).length, logged, 'no event for the refused take');
    const released = await s.cli(['release', 'l-aaaaaaaaaaaa']);
    assert.equal(released.code, 0, released.err.join('\n'));
    assert.equal(s.owner('s24'), null);
  } finally { s.cleanup(); }
});

test('end to end: seed, drop the phone from devices.json, re-seed, then `lease s24` exits 2 with HUB_RESOURCE_RETIRED seed-missing', async () => {
  const s = side();
  try {
    const seeded = devices => applySeed({ env: s.env, devices, qaDevices: () => [], hostId: 'test-host', log: () => {} });
    assert.equal((await seeded(loadDevices({}))).first, true);
    const gone = loadDevices({});
    gone.android_extra = [];
    assert.equal((await seeded(gone)).changed, true);
    const result = await s.cli(leaseWord('s24'));
    assert.equal(result.code, 2);
    assert.match(result.err[0], /^HUB_RESOURCE_RETIRED s24 .*seed-missing/);
    assert.equal(s.owner('s24'), null);
    assert.deepEqual(lockEvents(s), []);
  } finally { s.cleanup(); }
});
