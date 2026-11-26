// Story 8.3 (AD-35, AD-19): live Reachability from one adb socket. The unit rows build the real snapshot and readings cache around a fake
// `observe`, a recording `note` and a fake `open` (the `trackDevices` seam); the service rows start `startHubApi` with a FakeServer listener
// and a fake `trackDevices`, and one row runs the real `trackDevices` against a loopback `fakeAdbServer`. The clock is injected. No real
// adb server (5037), no port and no timer is reached.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadDevices } from '../ci/lib/devices.mjs';
import { readEvents } from '../ci/lib/events.mjs';
import { loadPolicy } from '../ci/lib/policy.mjs';
import { hermetic } from '../ci/test-fixtures.mjs';
import { createAdbWire, trackDevices as realTrackDevices } from '../device/adb-wire.mjs';
import { fakeAdbServer, fakeHub } from '../device/wire-fixtures.mjs';
import { seed } from '../registry/seed.mjs';
import { createReadings } from './readings.mjs';
import { requestListener, startHubApi } from './server.mjs';
import { createSnapshot } from './snapshot.mjs';
import { createTrack } from './track.mjs';

hermetic();

const policy = loadPolicy().policy;
const S26 = 'R5GL43A7PCH';
const S24 = 'R5CX31AEJDA';
const T0 = Date.parse('2026-11-25T10:00:00Z');
const flush = async (rounds = 8) => { for (let round = 0; round < rounds; round += 1) await new Promise(done => setImmediate(done)); };
const entry = (serial, state, model = 'SM') => ({ id: serial, state, model, product: null, device: null, transport_id: '1' });
const server = (port = 5037) => ({ adb_servers: [{ port, pid: 4242, managed: true, cwd: null }], emulators: [], xvfb: [] });
const nobody = () => ({ adb_servers: [], emulators: [], xvfb: [] });

// A fake `open` (the `trackDevices` seam): every call is recorded with its handlers, `push` and `drop` play the server.
function fakeOpen({ throws = null } = {}) {
  const opens = [];
  const open = (port, handlers) => {
    if (throws) throw throws;
    const socket = { port, handlers, closed: 0, close() { this.closed += 1; handlers.onClose({ opened: true, error: null }); } };
    opens.push(socket);
    return socket;
  };
  return { open, opens, last: () => opens.at(-1) };
}

// ---- unit rows: the real snapshot and readings around fakes ----

function unit({ inventory = server(), hostKey = () => 'linux', open: given, records: recordsOf } = {}) {
  const clock = { t: T0 };
  const now = () => clock.t;
  const env = { HUB_ADB_SERVER_PORT: '5037' };
  const lines = [];
  const noted = [];
  const state = { inventory, serials: new Map(), gathers: 0, probes: [] };
  const snapshot = createSnapshot({
    env, now, log: line => lines.push(line),
    observe: async () => { state.gathers += 1; return { inventory: state.inventory, adb: { port: 5037, note: null, listed: [], serials: new Map(state.serials) }, starts: new Map(), live_starts: new Map() }; },
  });
  const readings = createReadings({
    env, policy, now, hostId: 'test-host', hostKey, log: line => lines.push(line),
    note: fields => { noted.push(fields); return true; },
    probe: phones => new Promise(resolve => state.probes.push({ phones, resolve })),
  });
  const phones = seed(structuredClone(loadDevices({})), { qaDevices: () => [] }).resources.filter(resource => resource.kind === 'phone' && resource.host === 'linux');
  const fake = given ?? fakeOpen();
  const track = createTrack({ env, now, hostKey, records: recordsOf ?? (() => phones), snapshot, readings, open: fake.open, log: line => lines.push(line) });
  const served = id => readings.read(phones).get(id);
  const events = () => noted.map(fields => [fields.resource, fields.from, fields.to, fields.reason]);
  return { clock, state, snapshot, readings, track, phones, fake, lines, noted, served, events };
}

test('open is never called while the inventory shows no server on the hub port, or before the first gather', async () => {
  const u = unit({ inventory: nobody() });
  u.track.ensure();
  assert.equal(u.fake.opens.length, 0, 'no gather yet: nothing is known');
  await u.snapshot.ready();
  u.track.ensure();
  u.track.ensure();
  assert.equal(u.fake.opens.length, 0, 'no adb server on the hub port');
  u.state.inventory = server(5038);
  await u.snapshot.refresh();
  u.track.ensure();
  assert.equal(u.fake.opens.length, 0, 'a server on another port is not the hub server');
  u.state.inventory = server(5037);
  await u.snapshot.refresh();
  u.track.ensure();
  u.track.ensure();
  assert.deepEqual(u.fake.opens.map(socket => socket.port), [5037], 'one handle: a second ensure opens nothing');
});

test('a host that is not linux has nothing to track', async () => {
  const u = unit({ hostKey: () => 'mac' });
  await u.snapshot.ready();
  u.track.ensure();
  assert.equal(u.fake.opens.length, 0);
});

test('connect: a pushed device is reachable, source track, age 0 and not stale 10 minutes later, and the probe is never called', async () => {
  const u = unit();
  await u.snapshot.ready();
  u.track.ensure();
  u.fake.last().handlers.onDevices([entry(S26, 'device', 'SM_S948U')]);
  const first = u.served('s26');
  assert.deepEqual([first.state, first.source, first.age_ms_at_receipt], ['reachable', 'track', 0]);
  assert.equal(u.served('s24').state, 'absent', 'a phone the listing does not name is absent');
  u.clock.t += 600_000;
  const later = u.served('s26');
  assert.deepEqual([later.state, later.source, later.age_ms_at_receipt, later.received_at], ['reachable', 'track', 0, u.clock.t], 'stamped at the read: a silent socket means the state holds');
  assert.equal(later.checked_at, new Date(u.clock.t).toISOString());
  assert.equal(u.state.probes.length, 0, 'a live reading never starts a probe');
  assert.deepEqual(u.events().sort(), [['s24', null, 'absent', 'track'], ['s26', null, 'reachable', 'track']], 'one event per Resource, reason track');
  u.fake.last().handlers.onDevices([entry(S26, 'device')]);
  assert.equal(u.noted.length, 2, 'an unchanged push writes nothing');
  const adb = await u.snapshot.adbQuery();
  assert.deepEqual([adb.note, adb.listed.map(item => item.id), adb.checked_at], [null, [S26], u.clock.t]);
});

test('unauthorized, then not listed: each is shown and each is one event', async () => {
  const u = unit();
  await u.snapshot.ready();
  u.track.ensure();
  const { onDevices } = u.fake.last().handlers;
  onDevices([entry(S26, 'device')]);
  onDevices([entry(S26, 'unauthorized')]);
  assert.equal(u.served('s26').state, 'unauthorized');
  onDevices([]);
  assert.equal(u.served('s26').state, 'absent');
  assert.deepEqual(u.events().filter(event => event[0] === 's26'), [['s26', null, 'reachable', 'track'], ['s26', 'reachable', 'unauthorized', 'track'], ['s26', 'unauthorized', 'absent', 'track']]);
  assert.equal((await u.snapshot.adbQuery()).listed.length, 0);
});

test('close: one track-lost event per tracked Resource, the next read probes, and only the next ensure reopens', async () => {
  const u = unit();
  await u.snapshot.ready();
  u.track.ensure();
  u.fake.last().handlers.onDevices([entry(S26, 'device')]);
  u.fake.last().handlers.onClose({ opened: true, error: new Error('reset') });
  assert.deepEqual(u.events().filter(event => event[3] === 'track-lost').sort(), [['s24', 'absent', 'unknown', 'track-lost'], ['s26', 'reachable', 'unknown', 'track-lost']]);
  assert.equal(u.noted.filter(fields => fields.reason === 'track-lost').every(fields => fields.checked_at === T0), true);
  assert.equal(u.fake.opens.length, 1, 'nothing reopens it by itself');
  await flush();
  assert.equal(u.fake.opens.length, 1);
  assert.equal(u.snapshot.read().adb.listed.length, 0);
  assert.equal((await u.snapshot.adbQuery()).checked_at, u.snapshot.read().taken_at, 'the snapshot answers from its gathers again');
  const after = u.served('s26');
  assert.deepEqual([after.state, after.source], ['unknown', null], 'the dropped reading is gone');
  assert.equal(u.state.probes.length, 1, 'the next read probes');
  u.state.probes[0].resolve(new Map([['s26', 'reachable']]));
  await u.readings.settled();
  const probed = u.served('s26');
  assert.deepEqual([probed.state, probed.source], ['reachable', 'probe']);
  assert.deepEqual(u.events().at(-1), ['s26', 'unknown', 'reachable', 'probe']);
  u.track.ensure();
  u.track.ensure();
  assert.equal(u.fake.opens.length, 2, 'the next ensure opens exactly one socket');
});

test('an id the socket stops covering is no longer a track reading, and the next read probes it', async () => {
  let current = null;
  const u = unit({ records: () => current });
  current = u.phones;
  await u.snapshot.ready();
  u.track.ensure();
  u.fake.last().handlers.onDevices([entry(S26, 'device'), entry(S24, 'device')]);
  assert.deepEqual([u.served('s24').source, u.served('s26').source], ['track', 'track']);
  current = u.phones.filter(phone => phone.id === 's26');
  u.fake.last().handlers.onDevices([entry(S26, 'device'), entry(S24, 'device')]);
  const dropped = u.served('s24');
  assert.deepEqual([dropped.state, dropped.source], ['unknown', null]);
  assert.equal(u.served('s26').source, 'track');
  assert.equal(u.state.probes.length, 1, 'the next read starts one probe');
});

test('a socket that never opened writes nothing, and its close clears the handle', async () => {
  const u = unit();
  await u.snapshot.ready();
  u.track.ensure();
  u.fake.last().handlers.onClose({ opened: false, error: Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }) });
  assert.deepEqual(u.noted, []);
  assert.deepEqual(u.lines, [], 'a refusal is not a failure line');
  u.track.ensure();
  assert.equal(u.fake.opens.length, 2);
});

test('stop closes the socket and writes nothing; nothing opens after it', async () => {
  const u = unit();
  await u.snapshot.ready();
  u.track.ensure();
  const socket = u.fake.last();
  socket.handlers.onDevices([entry(S26, 'device')]);
  const before = u.noted.length;
  u.track.stop();
  u.track.stop();
  assert.equal(socket.closed, 1);
  assert.equal(u.noted.length, before, 'no track-lost on a deliberate stop');
  socket.handlers.onDevices([entry(S26, 'unauthorized')]);
  assert.equal(u.noted.length, before, 'a late push is ignored');
  u.track.ensure();
  assert.equal(u.fake.opens.length, 1);
});

test('an endpoint id with no known serial starts one snapshot refresh and is mapped again after it', async () => {
  const u = unit();
  await u.snapshot.ready();
  u.track.ensure();
  const gathers = u.state.gathers;
  u.state.serials.set('10.0.0.5:5555', S26);   // what the refresh will read
  u.fake.last().handlers.onDevices([entry('10.0.0.5:5555', 'device')]);
  assert.equal(u.served('s26').state, 'absent', 'before the serial is read the endpoint matches no phone');
  await flush();
  assert.equal(u.state.gathers, gathers + 1, 'one refresh');
  assert.equal(u.served('s26').state, 'reachable');
  assert.deepEqual(u.events().filter(event => event[0] === 's26'), [['s26', null, 'absent', 'track'], ['s26', 'absent', 'reachable', 'track']]);
});

test('an endpoint whose serial stays unreadable reads absent and asks only once', async () => {
  const u = unit();
  await u.snapshot.ready();
  u.track.ensure();
  const gathers = u.state.gathers;
  u.fake.last().handlers.onDevices([entry('10.0.0.5:5555', 'device')]);
  await flush();
  await flush();
  assert.equal(u.state.gathers, gathers + 1, 'no second refresh');
  assert.equal(u.served('s26').state, 'absent');
});

test('a refresh that settles after a newer listing does not map the old one again', async () => {
  const u = unit();
  await u.snapshot.ready();
  u.track.ensure();
  u.state.serials.set('10.0.0.5:5555', S26);
  const { onDevices } = u.fake.last().handlers;
  onDevices([entry('10.0.0.5:5555', 'device')]);
  onDevices([]);
  await flush();
  assert.equal(u.served('s26').state, 'absent', 'the newer listing stands');
});

test('an open that throws, or a callback that throws, is one HUB_API_TRACK_FAILED line and never escapes', async () => {
  const thrown = unit({ open: fakeOpen({ throws: new Error('no socket') }) });
  await thrown.snapshot.ready();
  assert.doesNotThrow(() => thrown.track.ensure());
  assert.deepEqual(thrown.lines, ['HUB_API_TRACK_FAILED no socket']);
  const broken = unit({ records: () => { throw new Error('registry unreadable'); } });
  await broken.snapshot.ready();
  broken.track.ensure();
  assert.doesNotThrow(() => broken.fake.last().handlers.onDevices([entry(S26, 'device')]));
  assert.deepEqual(broken.lines, ['HUB_API_TRACK_FAILED registry unreadable']);
  assert.deepEqual((await broken.snapshot.adbQuery()).listed, [], 'a failed mapping changes neither cache: the snapshot did not take the listing');
  assert.equal(broken.served('s26').source, null);
  assert.doesNotThrow(() => broken.fake.last().handlers.onClose({ opened: true }));
});

test('a probe that started before the socket never overwrites a live reading', async () => {
  const u = unit();
  await u.snapshot.ready();
  u.served('s26');   // a read starts the probe
  assert.equal(u.state.probes.length, 1);
  u.track.ensure();
  u.fake.last().handlers.onDevices([entry(S26, 'device')]);
  u.state.probes[0].resolve(new Map([['s26', 'absent'], ['s24', 'reachable']]));
  await u.readings.settled();
  assert.deepEqual([u.served('s26').state, u.served('s26').source], ['reachable', 'track']);
  assert.deepEqual(u.events().filter(event => event[3] === 'probe'), [], 'the probe wrote no event');
});

// ---- service rows: startHubApi, a FakeServer listener and a fake trackDevices ----

function side() {
  const root = mkdtempSync(join(tmpdir(), 'hub-api-track-'));
  const env = { PATH: process.env.PATH, HOME: root, HUB_LOCK_DIR: join(root, 'locks'), HUB_EVENT_DIR: join(root, 'events'), HUB_DEVICE_POLL_MS: '50', HUB_ADB_SERVER_PORT: '5037' };
  return { root, env, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function exchange(listener, method, url) {
  const req = { method, url, async *[Symbol.asyncIterator]() { /* no body */ } };
  const res = Object.assign(new EventEmitter(), {
    writableFinished: false, head: null, text: null,
    writeHead(status, headers) { this.head = { status, headers }; },
    end(text) { this.text = text; this.writableFinished = true; this.emit('close'); },
  });
  return listener(req, res).then(() => ({ status: res.head.status, json: () => JSON.parse(res.text) }));
}

async function boot(s, { trackDevices, observed = {}, extra = {}, bare = false } = {}) {
  const clock = { t: T0 };
  const state = { gathers: 0, probed: 0, lines: [] };
  const signals = new EventEmitter();
  let listener;
  let closed = null;
  class FakeServer extends EventEmitter {
    constructor(handler) { super(); listener = handler; }
    listen(port, host, callback) { process.nextTick(callback); return this; }
    address() { return { port: 1 }; }
    close(callback) { process.nextTick(callback); return this; }
  }
  const running = await startHubApi({
    env: s.env, policy, hostId: 'test-host', devices: structuredClone(loadDevices({})), qaDevices: () => [], versions: { node: '24.15.0' }, onPath: () => true, signals, hostKey: () => 'linux',
    now: () => clock.t, log: { out: () => {}, err: line => state.lines.push(line) },
    createServer: handler => new FakeServer(handler),
    ...(bare ? {} : { observe: async () => { state.gathers += 1; return { inventory: server(Number(s.env.HUB_ADB_SERVER_PORT)), adb: { port: 5037, note: null, listed: [], serials: new Map() }, starts: new Map(), live_starts: new Map(), ...observed }; } }),
    trackDevices,
    ...extra,
  });
  closed = running.stopped.then(() => true);
  const get = url => exchange(listener, 'GET', url);
  const phone = async (id) => (await get('/status')).json().hosts.linux.phones.find(row => row.device === id);
  const resource = async id => (await get('/resources')).json().resources.find(row => row.id === id);
  const events = () => [...readEvents({ env: s.env })].filter(event => event.event === 'reachability').map(event => [event.resource, event.from, event.to, event.reason]);
  return { clock, state, get, phone, resource, events, stop: async () => { signals.emit('SIGTERM'); await closed; }, closed: () => closed };
}

test('service: on start exactly one socket opens; /status and /resources show its readings as current, source track, even 10 minutes on', async () => {
  const s = side();
  const fake = fakeOpen();
  let svc;
  try {
    svc = await boot(s, { trackDevices: fake.open });
    await flush();
    assert.deepEqual(fake.opens.map(socket => socket.port), [5037], 'the first gather opened exactly one socket');
    fake.last().handlers.onDevices([entry(S26, 'device', 'SM_S948U'), entry(S24, 'device')]);
    const status = await svc.phone('s26');
    assert.deepEqual([status.presence, status.reachability.state, status.reachability.age_ms, status.reachability.stale], ['reachable', 'reachable', 0, false]);
    const row = await svc.resource('s26');
    assert.deepEqual([row.reachability.state, row.reachability.source, row.reachability.age_ms_at_receipt], ['reachable', 'track', 0]);
    svc.clock.t += 600_000;
    const later = await svc.phone('s26');
    assert.deepEqual([later.reachability.state, later.reachability.age_ms, later.reachability.stale], ['reachable', 0, false]);
    assert.equal((await svc.resource('s26')).reachability.source, 'track');
    assert.equal(fake.opens.length, 1, 'requests open nothing while the socket is open');
    const discovery = (await svc.get('/discovery')).json();
    assert.deepEqual(discovery.devices, [], 'both pushed phones are named Resources');
    assert.deepEqual(svc.events().sort(), [['s24', null, 'reachable', 'track'], ['s26', null, 'reachable', 'track']]);
  } finally { await svc?.stop(); s.cleanup(); }
});

test('service: a pushed state change shows on the next /status, with exactly one reachability event', async () => {
  const s = side();
  const fake = fakeOpen();
  let svc;
  try {
    svc = await boot(s, { trackDevices: fake.open });
    await flush();
    fake.last().handlers.onDevices([entry(S26, 'device'), entry(S24, 'device')]);
    await svc.phone('s26');
    const before = svc.events().length;
    fake.last().handlers.onDevices([entry(S26, 'unauthorized'), entry(S24, 'device')]);
    assert.deepEqual([(await svc.phone('s26')).presence, (await svc.resource('s26')).reachability.state], ['unauthorized', 'unauthorized']);
    assert.deepEqual(svc.events().slice(before), [['s26', 'reachable', 'unauthorized', 'track']]);
    fake.last().handlers.onDevices([entry(S24, 'device')]);
    assert.deepEqual([(await svc.phone('s26')).presence, (await svc.resource('s26')).reachability.state], ['absent', 'absent']);
    assert.equal(svc.events().length, before + 2);
  } finally { await svc?.stop(); s.cleanup(); }
});

test('service: a closed socket writes track-lost, readings come from the probe, and exactly one request-opened socket replaces it', async () => {
  const s = side();
  const fake = fakeOpen();
  let svc;
  try {
    svc = await boot(s, { trackDevices: fake.open });
    await flush();
    fake.last().handlers.onDevices([entry(S26, 'device'), entry(S24, 'device')]);
    await svc.phone('s26');
    const before = svc.events().length;
    fake.opens[0].handlers.onClose({ opened: true, error: new Error('reset') });
    assert.deepEqual(svc.events().slice(before).sort(), [['s24', 'reachable', 'unknown', 'track-lost'], ['s26', 'reachable', 'unknown', 'track-lost']]);
    await flush();
    assert.equal(fake.opens.length, 1, 'only a request reopens');
    const first = await svc.resource('s26');
    assert.equal(fake.opens.length, 2, 'the first request opened one socket');
    assert.equal(first.reachability.state, 'unknown', 'the dropped reading is gone');
    await flush();
    const second = await svc.resource('s26');
    await svc.get('/status');
    assert.equal(fake.opens.length, 2, 'and nothing else did');
    assert.equal(second.reachability.source, 'probe', 'readings come from the probe: the fake gather lists no phone');
    assert.equal(second.reachability.state, 'absent');
  } finally { await svc?.stop(); s.cleanup(); }
});

test('service: SIGTERM closes the socket, writes no track-lost and leaves nothing open', async () => {
  const s = side();
  const fake = fakeOpen();
  let svc;
  try {
    svc = await boot(s, { trackDevices: fake.open });
    await flush();
    fake.last().handlers.onDevices([entry(S26, 'device')]);
    await svc.phone('s26');
    const before = svc.events();
    await svc.stop();
    assert.equal(fake.opens[0].closed, 1);
    assert.deepEqual(svc.events(), before, 'a deliberate stop writes nothing');
    assert.equal(fake.opens.length, 1);
    svc = null;
  } finally { await svc?.stop(); s.cleanup(); }
});

test('service: a faked host opens no socket, even when its faked inventory lists a server', async () => {
  const s = side();
  const adbServer = await fakeAdbServer();
  s.env.HUB_ADB_SERVER_PORT = String(adbServer.port);
  let svc;
  try {
    // `observe` is injected without `trackDevices`: a faked inventory can list a server that is not there, so no socket is opened.
    svc = await boot(s);
    await flush();
    assert.equal((await svc.get('/status')).status, 200);
    await flush();
    assert.deepEqual(adbServer.requests, []);
    assert.deepEqual(svc.state.lines.filter(line => /TRACK/.test(line)), []);
  } finally { await svc?.stop(); await adbServer.close(); s.cleanup(); }
});

test('a request hook that throws never changes an answer', async () => {
  const listener = requestListener({ onRequest: () => { throw new Error('hook'); }, env: {}, routes: [], log: { out: () => {}, err: () => {} } });
  const answer = await exchange(listener, 'GET', '/nowhere');
  assert.ok([200, 404].includes(answer.status), `answered ${answer.status}`);
});

test('service, real socket: the one request the track sends is host:track-devices-l, a push reaches /status and a drop falls back', async () => {
  const s = side();
  const adbServer = await fakeAdbServer({ listed: [{ id: S26, state: 'device', model: 'SM_S948U' }] });
  s.env.HUB_ADB_SERVER_PORT = String(adbServer.port);
  let svc;
  const until = async condition => { for (let i = 0; i < 300 && !(await condition()); i += 1) await new Promise(done => setTimeout(done, 10)); assert.ok(await condition(), 'timed out'); };
  try {
    svc = await boot(s, { trackDevices: realTrackDevices, extra: { observe: undefined, inventory: () => server(adbServer.port), adbWire: createAdbWire } });
    await until(() => adbServer.requests.includes('host:track-devices-l'));
    await until(async () => (await svc.phone('s26')).reachability.state === 'reachable');
    assert.equal(adbServer.requests.filter(request => request === 'host:track-devices-l').length, 1);
    adbServer.push([{ id: S26, state: 'unauthorized' }]);
    await until(async () => (await svc.phone('s26')).presence === 'unauthorized');
    assert.equal((await svc.resource('s26')).reachability.source, 'track');
    adbServer.dropTracks();
    await until(() => svc.events().some(event => event[3] === 'track-lost'));
    assert.deepEqual(svc.events().filter(event => event[3] === 'track-lost').map(event => event[0]).sort(), ['s24', 's26']);
  } finally { await svc?.stop(); await adbServer.close(); s.cleanup(); }
});

test('service, default wiring: with nothing faked but the host key, the real track opens on the hub port and a push reaches /status', async () => {
  const s = side();
  // A real loopback adb-protocol server and a decoy `adb ... server` process the real /proc inventory finds; never the adb on 5037.
  const hub = await fakeHub({ listed: [{ id: S26, state: 'device', model: 'SM_S948U' }] });
  s.env.HUB_ADB_SERVER_PORT = String(hub.server.port);
  let svc;
  const until = async condition => { for (let i = 0; i < 500 && !(await condition()); i += 1) await new Promise(done => setTimeout(done, 20)); assert.ok(await condition(), 'timed out'); };
  try {
    svc = await boot(s, { bare: true });
    await until(async () => { await svc.get('/status'); return hub.server.requests.includes('host:track-devices-l'); });
    assert.equal(hub.server.requests.filter(request => request === 'host:track-devices-l').length, 1);
    hub.server.push([{ id: S26, state: 'unauthorized' }]);
    await until(async () => (await svc.phone('s26')).presence === 'unauthorized');
    assert.equal((await svc.resource('s26')).reachability.source, 'track');
  } finally { await svc?.stop(); await hub.stop(); s.cleanup(); }
});
