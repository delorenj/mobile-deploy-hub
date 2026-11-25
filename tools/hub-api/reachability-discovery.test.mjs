// Story 6.10: reachability and discovery through the API, hermetic. `GET /discovery` and the `reachability` of `GET /resources` run
// through handle() on a temp lock and event dir, with a fake adb wire (`fakeWire`), an injected inventory and host key, and a probe
// the test controls. No port is bound, no real adb server (5037), QA file or host key is reached, and the cache has no timer.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadDevices } from '../ci/lib/devices.mjs';
import { readEvents } from '../ci/lib/events.mjs';
import { loadPolicy } from '../ci/lib/policy.mjs';
import { hermetic } from '../ci/test-fixtures.mjs';
import { main } from '../device/hub-device.mjs';
import { fakeWire } from '../device/wire-fixtures.mjs';
import { applySeed } from '../registry/store.mjs';
import { NO_READING, present, receive, serve, stamp } from '../registry/reachability.mjs';
import { createReadings, deviceCtx } from './readings.mjs';
import { ROUTES, handle } from './routes.mjs';

hermetic();

const HOST = 'test-host';
const policy = loadPolicy().policy;
const S26 = 'R5GL43A7PCH';
const S24 = 'R5CX31AEJDA';
const usbId = serial => `adb-${serial}-zz._adb-tls-connect._tcp`;
const seeded = [{ id: usbId(S24), state: 'device', model: 'SM_S928U' }, { id: usbId(S26), state: 'device', model: 'SM_S948U' }];
const serverUp = () => ({ adb_servers: [{ port: 5037, pid: 4242, cwd: null }], emulators: [], xvfb: [] });
const serverDown = () => ({ adb_servers: [], emulators: [], xvfb: [] });
const quietLog = () => { const lines = []; return { lines, out: () => {}, err: line => { lines.push(line); } }; };

// A sleep that runs a hundredth of the time, so a bounded query fires fast if something hangs.
const quickSleep = () => (ms, signal) => new Promise(done => {
  if (signal?.aborted) { done(); return; }
  const timer = setTimeout(done, ms / 100);
  signal?.addEventListener('abort', () => { clearTimeout(timer); done(); }, { once: true });
});

function scratch({ listed = seeded, wireOptions = {}, qa = [], inventory = serverUp, hostKey = () => 'linux', readings } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'hub-api-reach-'));
  const env = { PATH: process.env.PATH, HOME: root, HUB_LOCK_DIR: join(root, 'locks'), HUB_EVENT_DIR: join(root, 'events'), HUB_ADB_SERVER_PORT: '5037' };
  const devices = structuredClone(loadDevices({}));
  const wire = fakeWire({ listed, ...wireOptions });
  const log = quietLog();
  const clock = { t: Date.parse('2026-11-25T10:00:00Z') };
  const now = () => clock.t;
  const ctx = (more = {}) => ({ env, policy, routes: ROUTES, now, hostId: HOST, devices, qaDevices: () => qa, hostKey, inventory, adbWire: wire, sleep: quickSleep(), log, readings, ...more });
  const s = {
    root, env, wire, log, clock, now, devices, ctx,
    get: (url, more) => handle({ method: 'GET', url }, ctx(more)),
    post: (url, body, more) => handle({ method: 'POST', url, body }, ctx(more)),
    seedFile: () => applySeed({ env, devices, qaDevices: () => [], now, hostId: HOST, log: () => {} }),
    events: () => [...readEvents({ env })].filter(event => event.event === 'reachability'),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
  return s;
}

// A probe the test resolves by hand: `answer(map)` resolves the pending call, `fail(error)` rejects it.
function manualProbe() {
  const calls = [];
  const probe = phones => new Promise((resolve, reject) => { calls.push({ phones, resolve, reject }); });
  return { probe, calls, answer: map => calls.at(-1).resolve(new Map(Object.entries(map))), fail: error => calls.at(-1).reject(error) };
}

const rowOf = (answer, id) => answer.body.resources.find(resource => resource.id === id);
const PIXEL = { kind: 'phone', name: 'pixel', host: 'linux', identity: { serial: 'ZY22PIX', model: 'Pixel_9' }, holder: 'test' };

// ---- discovery ----

test('discovery: a new USB Pixel is listed and only host:version and host:devices-l are asked', async () => {
  const s = scratch({ listed: [...seeded, { id: 'ZY22PIX', state: 'device', model: 'Pixel_9' }] });
  try {
    const answer = await s.get('/discovery');
    assert.equal(answer.status, 200);
    assert.equal(answer.headers['Cache-Control'], 'no-store');
    assert.deepEqual(answer.body, { format: 1, host: 'linux', via: 'adb', port: 5037, note: null, devices: [{ serial: 'ZY22PIX', model: 'Pixel_9', id: 'ZY22PIX', state: 'device' }] });
    assert.deepEqual(s.wire.requests, ['host:version', 'host:devices-l']);
    assert.deepEqual(s.wire.opened.map(entry => entry.port), [5037]);
  } finally { s.cleanup(); }
});

test('discovery: a host:port id is read for its serial, with only the read-only requests', async () => {
  const s = scratch({ listed: [...seeded, { id: '192.168.1.40:41234', state: 'device', model: 'Pixel_8' }], wireOptions: { serials: { '192.168.1.40:41234': '9A1B' } } });
  try {
    const answer = await s.get('/discovery');
    assert.deepEqual(answer.body.devices, [{ serial: '9A1B', model: 'Pixel_8', id: '192.168.1.40:41234', state: 'device' }]);
    assert.deepEqual(s.wire.requests, ['host:version', 'host:devices-l', 'host:transport:192.168.1.40:41234', 'shell:getprop ro.serialno']);
  } finally { s.cleanup(); }
});

test('discovery: a phone registered through the API is not listed, and is again once it is retired', async () => {
  const s = scratch({ listed: [...seeded, { id: 'ZY22PIX', state: 'device', model: 'Pixel_9' }] });
  try {
    assert.equal((await s.post('/registry/resources', PIXEL)).status, 201);
    assert.deepEqual((await s.get('/discovery')).body.devices, []);
    assert.equal((await s.post('/registry/resources/res-pixel/retire', { holder: 'test' })).status, 200);
    assert.deepEqual((await s.get('/discovery')).body.devices.map(device => device.serial), ['ZY22PIX']);
  } finally { s.cleanup(); }
});

test('discovery: a QA phone the file names but the Registry does not is not listed, and its serial is in no part of the body', async () => {
  const s = scratch({ listed: [...seeded, { id: 'QAPIX1', state: 'device', model: 'Pixel_7' }, { id: usbId('QAPIX2'), state: 'device' }, { id: 'ZY22PIX', state: 'device', model: 'Pixel_9' }], qa: [{ name: 'Pixel-QA', serial: 'QAPIX1', allowed_users: [0] }, { name: 'Other', serial: 'QAPIX2' }] });
  try {
    await s.seedFile();
    const answer = await s.get('/discovery');
    assert.deepEqual(answer.body.devices.map(device => device.serial), ['ZY22PIX']);
    assert.ok(!/QAPIX/.test(JSON.stringify(answer.body)));
    assert.ok(!/QAPIX/.test(readFileSync(join(s.env.HUB_LOCK_DIR, 'registry.json'), 'utf8')), 'it is not in registry.json either');
  } finally { s.cleanup(); }
});

test('discovery: no adb server is 200 with no devices and the note, and the wire is never opened', async () => {
  const s = scratch({ inventory: serverDown });
  try {
    const answer = await s.get('/discovery');
    assert.equal(answer.status, 200);
    assert.deepEqual([answer.body.devices, answer.body.note], [[], 'no adb server']);
    assert.equal(s.wire.opened.length, 0);
  } finally { s.cleanup(); }
});

test('discovery: a host that does not know its key is 503 HUB_HOST_UNKNOWN, exit 1, reason host-unknown, and nothing is asked', async () => {
  const unknown = () => { throw Object.assign(new Error('this host does not know which host it is: no host-key'), { code: 'HUB_HOST_UNKNOWN' }); };
  for (const hostKey of [unknown, () => null]) {
    const s = scratch({ hostKey });
    try {
      const answer = await s.get('/discovery');
      assert.equal(answer.status, 503);
      assert.equal(answer.headers['Content-Type'], 'application/problem+json');
      assert.deepEqual([answer.body.code, answer.body.exit, answer.body.reason], ['HUB_HOST_UNKNOWN', 1, 'host-unknown']);
      assert.equal(s.wire.opened.length, 0);
    } finally { s.cleanup(); }
  }
});

test('discovery: a wedged adb server is an answer, not a failure', async () => {
  const s = scratch({ wireOptions: { fail: 'version' } });
  try {
    const answer = await s.get('/discovery');
    assert.deepEqual([answer.status, answer.body.note, answer.body.devices], [200, 'adb did not answer', []]);
  } finally { s.cleanup(); }
});

test('hub-device discover --json leaves out a live registered phone and never calls the API', async () => {
  const s = scratch({ listed: [...seeded, { id: 'ZY22PIX', state: 'device', model: 'Pixel_9' }] });
  const apiCalls = [];
  const cli = async () => {
    const out = [];
    const err = [];
    const code = await main(['discover', '--json'], { env: s.env, stdout: line => out.push(line), stderr: line => err.push(line), adbWire: s.wire, inventory: serverUp, sleep: quickSleep(), hostKey: () => 'linux', adbFactory: () => { throw new Error('no adb client'); }, fetchImpl: async url => { apiCalls.push(String(url)); throw new Error('the API must not be called'); } });
    return { code, devices: JSON.parse(out[0]).devices.map(device => device.serial), err };
  };
  try {
    assert.deepEqual(await cli(), { code: 0, devices: ['ZY22PIX'], err: [] });
    assert.equal((await s.post('/registry/resources', PIXEL)).status, 201);
    assert.deepEqual(await cli(), { code: 0, devices: [], err: [] });
    assert.equal((await s.post('/registry/resources/res-pixel/retire', { holder: 'test' })).status, 200);
    assert.deepEqual((await cli()).devices, ['ZY22PIX']);
    assert.deepEqual(s.events(), [], 'the CLI never writes a reachability event');
    assert.deepEqual(apiCalls, [], 'discover never calls the Hub API');
  } finally { s.cleanup(); }
});

// ---- reachability on /resources ----

test('first read: answers at once with unknown for every row, and two back-to-back reads call the probe once', async () => {
  const p = manualProbe();
  const s = scratch();
  try {
    const readings = createReadings({ env: s.env, policy, now: s.now, hostId: HOST, log: s.log, hostKey: () => 'linux', probe: p.probe });
    const first = await s.get('/resources', { readings });
    const second = await s.get('/resources', { readings });
    assert.equal(p.calls.length, 1);
    for (const answer of [first, second]) {
      assert.equal(answer.status, 200);
      for (const resource of answer.body.resources) assert.deepEqual(resource.reachability, { state: 'unknown', checked_at: null, age_ms_at_receipt: null, received_at: null, source: null });
    }
    p.answer({});
    await readings.settled();
  } finally { s.cleanup(); }
});

test('a context with no readings serves the no-reading form and probes nothing', async () => {
  const s = scratch();
  try {
    const answer = await s.get('/resources');
    for (const resource of answer.body.resources) assert.deepEqual(resource.reachability, { ...NO_READING });
    assert.equal(s.wire.opened.length, 0);
    const one = await s.get('/resources/s26');
    assert.ok(!('reachability' in one.body.resource), 'the Resource shape is unchanged');
  } finally { s.cleanup(); }
});

test('after a refresh: the own-host phones carry the probe, the rest stay unknown, and the first events say from null', async () => {
  const p = manualProbe();
  const s = scratch();
  try {
    const readings = createReadings({ env: s.env, policy, now: s.now, hostId: HOST, log: s.log, hostKey: () => 'linux', probe: p.probe });
    await s.get('/resources', { readings });
    assert.deepEqual(p.calls[0].phones.map(phone => phone.device), ['s24', 's26'], 'the probe is given the own-host phones only');
    p.answer({ s26: 'reachable', s24: 'absent' });
    await readings.settled();
    s.clock.t += 2000;
    const answer = await s.get('/resources', { readings });
    assert.deepEqual(rowOf(answer, 's26').reachability, { state: 'reachable', checked_at: '2026-11-25T10:00:00.000Z', age_ms_at_receipt: 2000, received_at: s.clock.t, source: 'probe' });
    assert.equal(rowOf(answer, 's24').reachability.state, 'absent');
    for (const id of ['ios-lane', 'emulator']) assert.deepEqual(rowOf(answer, id).reachability, { ...NO_READING });
    assert.equal(p.calls.length, 1, 'a fresh reading starts no refresh');
    const events = s.events();
    assert.deepEqual(events.map(event => [event.resource, event.from, event.to, event.reason]).sort(), [['s24', null, 'absent', 'probe'], ['s26', null, 'reachable', 'probe']]);
    assert.ok(!/serial|R5GL|R5CX|allowed_users/i.test(JSON.stringify(events)), 'no identity in an event');
  } finally { s.cleanup(); }
});

test('an unchanged refresh: one new probe, the cached reading meanwhile, no new events; a change is one event', async () => {
  const p = manualProbe();
  const s = scratch();
  try {
    const readings = createReadings({ env: s.env, policy, now: s.now, hostId: HOST, log: s.log, hostKey: () => 'linux', probe: p.probe });
    await s.get('/resources', { readings });
    p.answer({ s26: 'reachable', s24: 'reachable' });
    await readings.settled();
    assert.equal(s.events().length, 2);
    s.clock.t += 70_000;
    const aged = await s.get('/resources', { readings });
    assert.equal(p.calls.length, 2, 'the stale reading starts one refresh');
    assert.equal(rowOf(aged, 's26').reachability.state, 'reachable', 'the cached reading is served meanwhile');
    assert.ok(rowOf(aged, 's26').reachability.age_ms_at_receipt >= 70_000);
    await s.get('/resources', { readings });
    assert.equal(p.calls.length, 2, 'at most one refresh is in flight');
    p.answer({ s26: 'reachable', s24: 'reachable' });
    await readings.settled();
    assert.equal(s.events().length, 2, 'the same states log nothing');
    s.clock.t += 70_000;
    await s.get('/resources', { readings });
    p.answer({ s26: 'offline', s24: 'reachable' });
    await readings.settled();
    const events = s.events();
    assert.equal(events.length, 3);
    assert.deepEqual([events[2].resource, events[2].from, events[2].to, events[2].reason], ['s26', 'reachable', 'offline', 'probe']);
  } finally { s.cleanup(); }
});

test('a state is remembered only when its event was written: a failed note is tried again on the next refresh', async () => {
  const p = manualProbe();
  const s = scratch();
  try {
    const noted = [];
    let ok = false;
    const note = fields => { noted.push(fields); return ok; };
    const readings = createReadings({ env: s.env, policy, now: s.now, hostId: HOST, log: s.log, hostKey: () => 'linux', probe: p.probe, note });
    await s.get('/resources', { readings });
    p.answer({ s26: 'reachable' });
    await readings.settled();
    ok = true;
    s.clock.t += 70_000;
    await s.get('/resources', { readings });
    p.answer({ s26: 'reachable' });
    await readings.settled();
    assert.deepEqual(noted.map(fields => [fields.resource, fields.from, fields.to]), [['s26', null, 'reachable'], ['s26', null, 'reachable']]);
    assert.deepEqual(Object.keys(noted[0]).sort(), ['checked_at', 'from', 'reason', 'resource', 'to']);
  } finally { s.cleanup(); }
});

test('a throwing probe or note is one HUB_API_REACHABILITY_FAILED line and never reaches the request; the next stale read retries', async () => {
  const p = manualProbe();
  const s = scratch();
  try {
    const readings = createReadings({ env: s.env, policy, now: s.now, hostId: HOST, log: s.log, hostKey: () => 'linux', probe: p.probe });
    const answer = await s.get('/resources', { readings });
    assert.equal(answer.status, 200);
    p.fail(new Error('adb\nexploded'));
    await readings.settled();
    assert.deepEqual(s.log.lines, ['HUB_API_REACHABILITY_FAILED adb exploded']);
    await s.get('/resources', { readings });
    assert.equal(p.calls.length, 2, 'the next stale read retries');
    p.answer({ s26: 'reachable' });
    await readings.settled();
    assert.equal(rowOf(await s.get('/resources', { readings }), 's26').reachability.state, 'reachable');

    const sync = createReadings({ env: s.env, policy, now: s.now, hostId: HOST, log: s.log, hostKey: () => 'linux', probe: () => { throw new Error('sync boom'); }, note: () => { throw new Error('note boom'); } });
    s.log.lines.length = 0;
    sync.read([{ id: 's26', name: 's26', kind: 'phone', host: 'linux', identity: { serial: 'X' } }]);
    await sync.settled();
    assert.deepEqual(s.log.lines, ['HUB_API_REACHABILITY_FAILED sync boom']);
    const noteFails = createReadings({ env: s.env, policy, now: s.now, hostId: HOST, log: s.log, hostKey: () => 'linux', probe: async () => new Map([['s26', 'reachable']]), note: () => { throw new Error('note boom'); } });
    s.log.lines.length = 0;
    noteFails.read([{ id: 's26', name: 's26', kind: 'phone', host: 'linux', identity: { serial: 'X' } }]);
    await noteFails.settled();
    assert.deepEqual(s.log.lines, ['HUB_API_REACHABILITY_FAILED note boom']);
  } finally { s.cleanup(); }
});

test('an unknown host key probes nothing, and a Mac key probes no linux phone', async () => {
  const p = manualProbe();
  const s = scratch();
  try {
    for (const hostKey of [() => { throw new Error('no key'); }, () => null, () => 'mac']) {
      const readings = createReadings({ env: s.env, policy, now: s.now, hostId: HOST, log: s.log, hostKey, probe: p.probe });
      const answer = await s.get('/resources', { readings });
      assert.equal(answer.status, 200);
      await readings.settled();
    }
    assert.equal(p.calls.length, 0);
  } finally { s.cleanup(); }
});

test('the default probe is the adb one: only host:version and host:devices-l go over the wire, and the readings reach /resources', async () => {
  const s = scratch({ listed: [{ id: usbId(S26), state: 'device' }, { id: usbId(S24), state: 'unauthorized' }] });
  try {
    const readings = createReadings({ env: s.env, policy, now: s.now, hostId: HOST, log: s.log, hostKey: () => 'linux', inventory: serverUp, adbWire: s.wire, sleep: quickSleep() });
    await s.get('/resources', { readings });
    await readings.settled();
    const answer = await s.get('/resources', { readings });
    assert.deepEqual([rowOf(answer, 's26').reachability.state, rowOf(answer, 's24').reachability.state], ['reachable', 'unauthorized']);
    assert.deepEqual(s.wire.requests, ['host:version', 'host:devices-l']);
    assert.deepEqual(s.log.lines, []);
  } finally { s.cleanup(); }
});

test('no adb server is unknown, not absent: the wire is never opened', async () => {
  const s = scratch({ inventory: serverDown });
  try {
    const readings = createReadings({ env: s.env, policy, now: s.now, hostId: HOST, log: s.log, hostKey: () => 'linux', inventory: serverDown, adbWire: s.wire, sleep: quickSleep() });
    await s.get('/resources', { readings });
    await readings.settled();
    assert.equal(rowOf(await s.get('/resources', { readings }), 's26').reachability.state, 'unknown');
    assert.equal(s.wire.opened.length, 0);
  } finally { s.cleanup(); }
});

test('deviceCtx builds the seams the Claims library reads', () => {
  const adbWire = () => {};
  const ctx = deviceCtx({ env: { A: '1' }, adbWire, now: () => 5 });
  assert.deepEqual([ctx.env, ctx.adbWire, ctx.timing.now(), typeof ctx.timing.sleep, typeof ctx.warn], [{ A: '1' }, adbWire, 5, 'function', 'function']);
});

test('a phone registered through POST /registry/resources gets its reading: the probe is given device pixel and res-pixel reads reachable', async () => {
  const p = manualProbe();
  const s = scratch();
  try {
    assert.equal((await s.post('/registry/resources', PIXEL)).status, 201);
    const readings = createReadings({ env: s.env, policy, now: s.now, hostId: HOST, log: s.log, hostKey: () => 'linux', probe: p.probe });
    await s.get('/resources', { readings });
    assert.ok(p.calls[0].phones.some(phone => phone.device === 'pixel' && phone.serial === 'ZY22PIX'), 'the probe is given the registered phone');
    p.answer({ pixel: 'reachable', s24: 'absent', s26: 'absent' });
    await readings.settled();
    const answer = await s.get('/resources', { readings });
    assert.equal(rowOf(answer, 'res-pixel').reachability.state, 'reachable');
    assert.equal(rowOf(answer, 'res-pixel').reachability.source, 'probe');
    assert.ok(s.events().some(event => event.resource === 'res-pixel' && event.to === 'reachable'));
  } finally { s.cleanup(); }
});

// ---- serve and receive ----

test('serve re-stamps on the service clock and receive re-stamps on the reader clock: skew cannot make a reading fresh', () => {
  const R = 1_000_000;
  const stored = stamp('reachable', { checkedAt: R, receivedAt: R });
  const served = serve(stored, { now: R + 70_000 });
  assert.deepEqual(Object.keys(served), ['state', 'checked_at', 'age_ms_at_receipt', 'received_at', 'source']);
  assert.ok(served.age_ms_at_receipt >= 70_000);
  assert.deepEqual([served.received_at, served.source], [R + 70_000, 'probe']);
  const behind = R - 3_600_000;
  const stored2 = receive(served, { now: behind });
  assert.equal(stored2.received_at, behind);
  const shown = present(stored2, { now: behind + 5000, maxAgeS: 60 });
  assert.equal(shown.age_ms, served.age_ms_at_receipt + 5000);
  assert.equal(shown.stale, true);
  // The same-host formula is exact too.
  assert.equal(present(served, { now: served.received_at + 5000, maxAgeS: 60 }).age_ms, served.age_ms_at_receipt + 5000);
});

test('serve of no reading, and receive of an unknown or empty one', () => {
  assert.deepEqual(serve(null, { now: 5 }), { state: 'unknown', checked_at: null, age_ms_at_receipt: null, received_at: null, source: null });
  assert.deepEqual(serve({ state: 'bogus', received_at: 1, age_ms_at_receipt: 0 }, { now: 5 }), { ...NO_READING });
  assert.equal(receive({ ...NO_READING }, { now: 5 }), null);
  assert.equal(receive(null, { now: 5 }), null);
  assert.equal(receive(stamp('unknown', { checkedAt: 1, receivedAt: 1 }), { now: 5 }), null);
  assert.equal(serve(stamp('reachable', { checkedAt: 0, receivedAt: 10 }), { now: 5 }).age_ms_at_receipt, 0, 'a service clock that went back never gives a negative age');
  assert.ok(!('stale' in serve(stamp('reachable', { checkedAt: 0, receivedAt: 1 }), { now: 2 })));
});
