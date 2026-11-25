// Story 7.4: an emulator Lease through the Hub API, every row of the spec's matrix, through handle() with the real worker thread
// (emulator-thread.mjs) and the emulator fakes (a fake adb server, emulator and avdmanager: real processes on a temp SDK, HOME and lock
// dir; see tools/device/emulator-fixtures.mjs). No real emulator, AVD, adb server or `heavy` is touched and no service port is bound.
// The worker cannot take a fake clock, so these tests use the real one.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadDevices } from '../ci/lib/devices.mjs';
import { readEvents } from '../ci/lib/events.mjs';
import { loadPolicy } from '../ci/lib/policy.mjs';
import { hermetic } from '../ci/test-fixtures.mjs';
import { createLeaseWaits } from '../device/claims.mjs';
import { liveStart, reap } from '../device/emulator.mjs';
import { offThread } from '../device/emulator-thread.mjs';
import { fixture } from '../device/emulator-fixtures.mjs';
import { ROUTES, handle } from './routes.mjs';

hermetic();

const policy = loadPolicy().policy;
const MIN = 60_000;
const NODE = process.execPath;
const settle = ms => new Promise(done => setTimeout(done, ms));
const waitFor = async (check, ms = 10_000) => { for (const end = Date.now() + ms; Date.now() < end && !check();) await settle(20); return check(); };
const gone = pid => liveStart(pid) === null;
const BODY = { resource: 'emulator', for_ms: 30 * MIN, holder: 'agent-a', why: 'proof' };
const ACTOR = { holder: 'agent-a', via: 'api' };
const LEASE_KEYS = ['claimant_kind', 'device', 'emulator', 'env', 'expires_at', 'holder', 'lease_id', 'lock', 'resource', 'started_at', 'why'];
const EMULATOR_KEYS = ['adb_server_port', 'console_port', 'profile', 'serial', 'slot'];

// The fixture's lock dir and events dir under a service context. `lines` is the service log.
function service(options) {
  const f = fixture(options);
  // Its own port ranges: this file runs beside emulator.test.mjs, whose fakes use the fixture's 25000-25099 and 5600-5698.
  Object.assign(f.env, { HUB_EMULATOR_ADB_PORTS: '25100-25199', HUB_EMULATOR_CONSOLE_PORTS: '5700-5798' });
  const lines = [];
  const devices = structuredClone(loadDevices({}));
  const s = {
    ...f, lines, devices,
    ctx: (more = {}) => ({ env: f.env, policy, routes: ROUTES, hostId: 'test-host', devices, qaDevices: () => [], log: { out: line => lines.push(line), err: line => lines.push(line) }, ...more }),
    post: (body, more = {}, request = {}) => handle({ method: 'POST', url: '/leases', body, ...request }, s.ctx(more)),
    get: id => handle({ method: 'GET', url: `/leases/${id}` }, s.ctx()),
    extend: (id, body) => handle({ method: 'POST', url: `/leases/${id}/extend`, body }, s.ctx()),
    release: (id, body = { holder: 'agent-a' }) => handle({ method: 'POST', url: `/leases/${id}/release`, body }, s.ctx()),
    events: () => [...readEvents({ env: f.env })].filter(event => event.claimant !== undefined),
    // What a refused request must leave untouched: the lock dir's entries and the events.
    footprint: () => JSON.stringify([existsSync(f.env.HUB_LOCK_DIR) ? readdirSync(f.env.HUB_LOCK_DIR).sort() : [], s.events().length]),
    processes: () => readdirSync(f.state).filter(name => /^emulator-\d+\.json$/.test(name)).map(name => JSON.parse(readFileSync(join(f.state, name), 'utf8')).pid),
    gone: () => {
      for (const file of readdirSync(f.state).filter(name => /^(emulator|adb-server)-\d+\.json$/.test(name))) assert.ok(gone(JSON.parse(readFileSync(join(f.state, file), 'utf8')).pid), `${file} is gone`);
      for (const file of readdirSync(f.state).filter(name => /^(late-)?helper-\d+\.pid$/.test(name))) assert.ok(gone(Number(readFileSync(join(f.state, file), 'utf8'))), `${file} is gone`);
    },
  };
  return s;
}

const problemOf = answer => [answer.status, answer.body.code, answer.body.exit, answer.body.reason];

test('a word lease: 200 Lease with the emulator keys, booted in a worker, a slot with no holder pid, the api actor on its events', async () => {
  const s = service();
  try {
    const answer = await s.post({ ...BODY, id: 'emu-1' });
    assert.equal(answer.status, 200, JSON.stringify(answer.body));
    assert.deepEqual(Object.keys(answer.body).sort(), LEASE_KEYS);
    assert.deepEqual([answer.body.lease_id, answer.body.resource, answer.body.lock, answer.body.device, answer.body.holder, answer.body.why, answer.body.claimant_kind], ['emu-1', 'emulator', 'emulator-1', 'emulator', 'agent-a', 'proof', 'agent']);
    assert.deepEqual(Object.keys(answer.body.emulator).sort(), EMULATOR_KEYS);
    const { emulator } = answer.body;
    assert.equal(emulator.slot, 'emulator-1');
    assert.equal(emulator.profile, 'default');
    assert.match(emulator.serial, /^emulator-\d+$/);
    assert.ok(Number.isInteger(emulator.console_port) && Number.isInteger(emulator.adb_server_port));
    assert.deepEqual(Object.keys(answer.body.env).sort(), ['ANDROID_ADB_SERVER_PORT', 'ANDROID_SERIAL', 'HUB_LEASE_ID']);
    assert.deepEqual([answer.body.env.HUB_LEASE_ID, answer.body.env.ANDROID_SERIAL, answer.body.env.ANDROID_ADB_SERVER_PORT], ['emu-1', emulator.serial, String(emulator.adb_server_port)]);
    assert.ok(Math.abs(Date.parse(answer.body.expires_at) - Date.parse(answer.body.started_at) - 30 * MIN) < 30_000, 'for_ms from the grant');

    const owner = s.owner('emulator-1');
    assert.equal(owner.holder_pid, null, 'the slot is tied to nobody once it is ready');
    assert.equal(owner.lease_id, 'emu-1');
    assert.equal(owner.claimant_kind, 'agent');
    assert.equal(s.record('emu-1').slot, 'emulator-1');

    const thread = s.lines.find(line => /^HUB_EMULATOR_THREAD provision emu-1 thread=\d+$/.test(line));
    assert.ok(thread, `the boot ran in a worker: ${s.lines.join(' | ')}`);
    assert.ok(Number(/thread=(\d+)/.exec(thread)[1]) >= 1);

    const events = s.events();
    const request = events.find(event => event.event === 'request');
    const acquire = events.find(event => event.event === 'acquire' && event.lock === 'emulator-1');
    assert.deepEqual([request?.actor, acquire?.actor], [ACTOR, ACTOR], 'the Pool request and the slot acquire name who asked');
    assert.deepEqual([acquire.claimant.kind, acquire.claimant.holder, acquire.lease_id], ['agent', 'agent-a', 'emu-1']);

    assert.equal((await s.release('emu-1')).status, 200);
    s.clean();
    s.gone();
  } finally { s.cleanup(); }
});

test('a match with a profile clause takes that profile; a match that only names the emulator Pool takes the default', async () => {
  const s = service({ image: 'google_apis_playstore' });
  try {
    const answer = await s.post({ ...BODY, resource: undefined, match: 'profile=playstore', id: 'emu-ps' });
    assert.equal(answer.status, 200, JSON.stringify(answer.body));
    assert.equal(answer.body.emulator.profile, 'playstore');
    assert.equal(answer.body.resource, 'emulator');
    assert.equal(s.record('emu-ps').profile ?? 'playstore', 'playstore');
    assert.equal((await s.release('emu-ps')).status, 200);
    s.clean();
  } finally { s.cleanup(); }
  const d = service();
  try {
    const answer = await d.post({ ...BODY, resource: undefined, match: 'kind=emulator-pool', id: 'emu-pool' });
    assert.equal(answer.status, 200, JSON.stringify(answer.body));
    assert.equal(answer.body.emulator.profile, 'default');
    assert.equal((await d.release('emu-pool')).status, 200);
    d.clean();
  } finally { d.cleanup(); }
});

test('a bad profile clause is 400 HUB_USAGE; an unknown or not-installed profile is 404 HUB_NO_MATCH; none leaves a ticket, a lock or an event', async () => {
  const s = service();
  try {
    const before = s.footprint();
    for (const match of ['profile>=1', 'profile=default,profile=playstore', 'profile=']) {
      const answer = await s.post({ ...BODY, resource: undefined, match });
      assert.deepEqual([answer.status, answer.body.code, answer.body.exit], [400, 'HUB_USAGE', 2], `${match}: ${JSON.stringify(answer.body)}`);
    }
    const missing = await s.post({ ...BODY, resource: undefined, match: 'profile=playstore' });
    assert.deepEqual([missing.status, missing.body.code, missing.body.exit], [404, 'HUB_NO_MATCH', 2], JSON.stringify(missing.body));
    assert.match(missing.body.detail, /google_apis_playstore/);
    const unknown = await s.post({ ...BODY, resource: undefined, match: 'profile=pixel' });
    assert.deepEqual([unknown.status, unknown.body.code, unknown.body.exit], [404, 'HUB_NO_MATCH', 2], JSON.stringify(unknown.body));
    assert.match(unknown.body.detail, /default, playstore/);
    assert.equal(s.footprint(), before, 'no ticket, no lock, no event');
    assert.equal(s.read('avdmanager.log') + s.read('adb-calls.log'), '', 'nothing ran');
  } finally { s.cleanup(); }
  const bare = service({ image: null });
  try {
    const before = bare.footprint();
    const answer = await bare.post({ ...BODY, id: 'emu-none' });
    assert.deepEqual([answer.status, answer.body.code], [404, 'HUB_NO_MATCH']);
    assert.match(answer.body.detail, /google_apis/);
    assert.equal(bare.footprint(), before);
  } finally { bare.cleanup(); }
});

test('the pool size order for a service: the emulator-pool file, then the Registry, then 2; a pool that is full is 409 HUB_LOCK_TIMEOUT exit 76', async () => {
  const s = service();
  try {
    mkdirSync(s.env.HUB_LOCK_DIR, { recursive: true });
    writeFileSync(join(s.env.HUB_LOCK_DIR, 'emulator-pool'), '1\n');
    const first = await s.post({ ...BODY, id: 'emu-a' });
    assert.equal(first.status, 200, JSON.stringify(first.body));
    const full = await s.post({ ...BODY, id: 'emu-b', holder: 'agent-b' });
    assert.deepEqual(problemOf(full).slice(0, 3), [409, 'HUB_LOCK_TIMEOUT', 76], JSON.stringify(full.body));
    assert.equal((await s.release('emu-a')).status, 200);

    // The Registry's pools.emulator.size comes next, with no file.
    rmSync(join(s.env.HUB_LOCK_DIR, 'emulator-pool'));
    writeFileSync(join(s.env.HUB_LOCK_DIR, 'registry.json'), JSON.stringify({ format: 1, rev: 1, resources: [], pools: [{ name: 'emulator', gate: 'emulator', size: 1 }] }));
    assert.equal((await s.post({ ...BODY, id: 'emu-c' })).status, 200);
    assert.equal((await s.post({ ...BODY, id: 'emu-d', holder: 'agent-b' })).status, 409, 'the Registry size is 1');
    assert.equal((await s.release('emu-c')).status, 200);

    // A service never reads $HUB_EMULATOR_POOL: with nothing else saying, the size is 2.
    rmSync(join(s.env.HUB_LOCK_DIR, 'registry.json'));
    const env = { ...s.env, HUB_EMULATOR_POOL: '1' };
    assert.equal((await s.post({ ...BODY, id: 'emu-e' }, { env })).status, 200);
    assert.equal((await s.post({ ...BODY, id: 'emu-f', holder: 'agent-b' }, { env })).status, 200, 'the second one fits: the variable is the CLI\'s');
    assert.equal((await s.post({ ...BODY, id: 'emu-g', holder: 'agent-c' }, { env })).status, 409);
    for (const id of ['emu-e', 'emu-f']) assert.equal((await s.release(id)).status, 200);

    // A size out of 1..8 names where it came from.
    writeFileSync(join(s.env.HUB_LOCK_DIR, 'emulator-pool'), '9');
    const bad = await s.post({ ...BODY, id: 'emu-h' });
    assert.equal(bad.body.code, 'HUB_EMULATOR_USAGE', JSON.stringify(bad.body));
    assert.match(bad.body.detail, /emulator-pool: the emulator pool is 1 to 8 emulators, not "9"/);
    s.clean();
  } finally { s.cleanup(); }
});

test('a boot that fails is 503 HUB_EMULATOR_FAILED exit 1 and everything it made is torn down', async () => {
  const s = service();
  try {
    writeFileSync(join(s.state, 'crash'), '');
    const answer = await s.post({ ...BODY, id: 'emu-crash' });
    assert.deepEqual(problemOf(answer).slice(0, 3), [503, 'HUB_EMULATOR_FAILED', 1], JSON.stringify(answer.body));
    assert.equal(answer.body.reason, 'emulator-failed');
    s.clean();
    s.gone();
    assert.ok(!existsSync(join(s.env.HUB_LOCK_DIR, 'emulator-1.lock')), 'the slot is free');
    assert.ok(!existsSync(join(s.env.HUB_LOCK_DIR, 'emulator.lock')), 'so is the gate');
    // And the next take works.
    rmSync(join(s.state, 'crash'));
    assert.equal((await s.post({ ...BODY, id: 'emu-after' })).status, 200);
    assert.equal((await s.release('emu-after')).status, 200);
  } finally { s.cleanup(); }
});

test('a disconnect mid-boot aborts the worker: the record, the slot and every process are gone, and no answer is owed', async () => {
  const s = service();
  try {
    s.env.FAKE_BOOT_MS = '60000';
    const controller = new AbortController();
    const pending = s.post({ ...BODY, id: 'emu-drop' }, {}, { signal: controller.signal });
    assert.ok(await waitFor(() => readdirSync(s.state).some(name => /^helper-\d+\.pid$/.test(name))), 'the emulator is booting');
    const booting = s.processes();
    assert.ok(booting.length >= 1);
    // Booting is not held yet: a GET finds a waiting id, and the same id from another holder is a taken id.
    const peek = await s.get('emu-drop');
    assert.deepEqual([peek.status, peek.body.code, peek.body.reason], [404, 'HUB_LEASE_NOT_FOUND', 'waiting']);
    controller.abort(new Error('the connection closed before the answer was written'));
    const answer = await pending;
    assert.ok(answer.status >= 400, `no Lease is answered: ${JSON.stringify(answer.body)}`);
    assert.ok(await waitFor(() => s.records().length === 0), 'the record is gone');
    s.clean();
    s.gone();
    for (const pid of booting) assert.ok(gone(pid));
    assert.ok(!existsSync(join(s.env.HUB_LOCK_DIR, 'emulator-1.lock')), 'the slot is free');
    assert.equal(s.events().filter(event => event.event === 'acquire' && event.lock === 'emulator-1').length, s.events().filter(event => event.event === 'release' && event.lock === 'emulator-1').length, 'every acquire is released');
  } finally { s.cleanup(); }
});

test('a Hold granted after the signal aborted is released at once (undelivered) and torn down; the signal\'s reason is what the caller sees', async () => {
  const s = service();
  try {
    const controller = new AbortController();
    // The worker finishes the boot (no signal given to it), and only then does the connection close: the grant arrives too late.
    const provisionOffThread = async (args, seams) => {
      const result = await offThread('provision', args, { env: seams.env, log: seams.log });
      controller.abort(new Error('the connection closed after the boot'));
      return result;
    };
    const answer = await s.post({ ...BODY, id: 'emu-late' }, { provisionOffThread }, { signal: controller.signal });
    assert.ok(answer.status >= 400, JSON.stringify(answer.body));
    assert.match(String(answer.body.detail), /the connection closed after the boot/);
    assert.deepEqual(s.records(), [], 'torn down');
    s.clean();
    s.gone();
    const release = s.events().find(event => event.event === 'release' && event.lock === 'emulator-1');
    assert.equal(release?.reason, 'undelivered');
    assert.ok(!existsSync(join(s.env.HUB_LOCK_DIR, 'emulator-1.lock')));
  } finally { s.cleanup(); }
});

test('a repeat id the same holder already holds answers the existing Lease: no second emulator, no event', async () => {
  const s = service();
  try {
    const first = await s.post({ ...BODY, id: 'emu-twice' });
    assert.equal(first.status, 200, JSON.stringify(first.body));
    const before = JSON.stringify(s.events());
    const processes = s.processes();
    const again = await s.post({ ...BODY, id: 'emu-twice' });
    assert.equal(again.status, 200);
    assert.deepEqual(again.body, first.body);
    assert.equal(JSON.stringify(s.events()), before, 'no event');
    assert.deepEqual(s.processes(), processes, 'no second emulator');
    // Another holder asking for the same id is refused.
    const other = await s.post({ ...BODY, id: 'emu-twice', holder: 'agent-b' });
    assert.deepEqual([other.status, other.body.code], [400, 'HUB_USAGE'], 'a lease id names one lease');
    assert.equal((await s.release('emu-twice')).status, 200);
  } finally { s.cleanup(); }
});

test('GET, extend and release an emulator id', async () => {
  const s = service();
  try {
    const taken = await s.post({ ...BODY, id: 'emu-life', for_ms: 10 * MIN });
    assert.equal(taken.status, 200, JSON.stringify(taken.body));
    const got = await s.get('emu-life');
    assert.equal(got.status, 200);
    assert.deepEqual(got.body, taken.body);
    assert.deepEqual(Object.keys(got.body.emulator).sort(), EMULATOR_KEYS);

    const extended = await s.extend('emu-life', { holder: 'agent-a', for_ms: 20 * MIN });
    assert.equal(extended.status, 200, JSON.stringify(extended.body));
    assert.deepEqual(Object.keys(extended.body).sort(), LEASE_KEYS);
    assert.deepEqual(extended.body.emulator, taken.body.emulator);
    assert.ok(Date.parse(extended.body.expires_at) > Date.parse(taken.body.expires_at));
    assert.equal(s.owner('emulator-1').expires_at, extended.body.expires_at);

    const released = await s.release('emu-life');
    assert.deepEqual([released.status, released.body], [200, { lease_id: 'emu-life', outcome: 'released', resource: 'emulator', lock: 'emulator-1', device: 'emulator' }]);
    assert.ok(s.lines.some(line => /^HUB_EMULATOR_THREAD release emu-life thread=\d+$/.test(line)), 'the teardown ran in a worker');
    s.clean();
    s.gone();
    assert.equal((await s.get('emu-life')).status, 404);
    const again = await s.release('emu-life');
    assert.equal(again.body.outcome, 'none');
  } finally { s.cleanup(); }
});

test('a request being served with no wait is aborted by shutdown(): HUB_API_RESTARTING, and what it had made is torn down', async () => {
  const s = service();
  try {
    s.env.FAKE_BOOT_MS = '60000';
    const waits = createLeaseWaits();
    const pending = s.post({ ...BODY, id: 'emu-stop' }, { waits });
    assert.ok(await waitFor(() => readdirSync(s.state).some(name => /^helper-\d+\.pid$/.test(name))), 'the emulator is booting');
    await waits.shutdown();
    const answer = await pending;
    assert.deepEqual(problemOf(answer).slice(0, 2), [503, 'HUB_API_RESTARTING'], JSON.stringify(answer.body));
    assert.deepEqual(s.records(), []);
    s.clean();
    s.gone();
    assert.ok(!existsSync(join(s.env.HUB_LOCK_DIR, 'emulator-1.lock')));
    const after = await s.post({ ...BODY, id: 'emu-more' }, { waits });
    assert.equal(after.body.code, 'HUB_API_RESTARTING', 'every later request is refused the same way');
  } finally { s.cleanup(); }
});

test('a service that dies mid-boot leaves an orphan the next reap tears down (holder gone)', async () => {
  const s = service();
  try {
    const script = `
      import { loadPolicy } from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, '../ci/lib/policy.mjs')).href)};
      import { serviceLease } from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, '../device/claims.mjs')).href)};
      await serviceLease({ resource: 'emulator', match: null, forMs: ${30 * MIN}, holder: 'agent-a', why: 'doomed', waitMs: 0, id: 'emu-dead', claimantKind: 'agent', actor: ${JSON.stringify(ACTOR)} }, { env: process.env, policy: loadPolicy().policy, log: () => {}, warn: () => {} });
    `;
    const child = spawn(NODE, ['--input-type=module', '-e', script], { env: { ...s.env, FAKE_BOOT_MS: '60000' }, stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    child.stderr.on('data', chunk => { err += chunk; });
    const closed = new Promise(done => child.on('close', done));
    assert.ok(await waitFor(() => readdirSync(s.state).some(name => /^helper-\d+\.pid$/.test(name)) && s.records().length === 1), `the child is booting: ${err}`);
    const record = s.record('emu-dead');
    assert.equal(s.owner(record.slot).holder_pid, child.pid, 'tied to the service pid while it boots');
    child.kill('SIGKILL');
    await closed;
    assert.ok(record.pids.some(entry => !gone(entry.pid)), 'the emulator outlived the service');

    const log = [];
    const results = await reap({ env: s.env, log: line => log.push(line), graceMs: 400 });
    assert.equal(results.length, 1);
    assert.match(log.join('\n'), /^HUB_EMULATOR_REAPED emu-dead emulator-1 \(holder gone\)/m);
    for (const entry of record.pids) assert.ok(gone(entry.pid), `${entry.role} ${entry.pid} is gone`);
    s.clean();
    s.gone();
    assert.ok(!existsSync(join(s.env.HUB_LOCK_DIR, 'emulator-1.lock')), 'the slot is free');
  } finally { s.cleanup(); }
});

test('parity: hub-device lease emulator --json and POST /leases make the same Lease, the same owner and the same events', async () => {
  const cli = service();
  const api = service();
  try {
    const leased = await cli.run(['lease', 'emulator', '--for', '30m', '--wait', '0s', '--why', 'proof', '--holder', 'agent-a', '--id', 'par-1', '--json']);
    assert.equal(leased.code, 0, leased.err.join('\n'));
    const printed = JSON.parse(leased.out[0]);
    const answer = await api.post({ ...BODY, id: 'par-1' });
    assert.equal(answer.status, 200, JSON.stringify(answer.body));
    assert.deepEqual([answer.body.lease_id, answer.body.device, answer.body.emulator.slot, answer.body.emulator.profile], [printed.lease_id, printed.device, printed.slot, printed.profile]);
    assert.deepEqual(Object.keys(answer.body.env).sort(), Object.keys(printed.env).filter(name => ['HUB_LEASE_ID', 'ANDROID_ADB_SERVER_PORT', 'ANDROID_SERIAL'].includes(name)).sort());

    const strip = ({ lock_ino: _ino, holder_pid: _pid, holder_process_start: _start, started_at: _s, expires_at: _e, acquired_at: _a, adb_id: _adb, ...rest }) => rest;
    // Ports, serial and the processes differ by construction; what stays is the shape: the same keys and the same roles.
    const normal = ({ emulator, ...rest }) => ({ ...rest, emulator: { ...emulator, serial: undefined, console_port: undefined, adb_port: undefined, adb_server_port: undefined, pids: emulator.pids.map(entry => entry.role) } });
    assert.deepEqual(Object.keys(api.owner('emulator-1')).sort(), Object.keys(cli.owner('emulator-1')).sort(), 'the same owner keys');
    assert.deepEqual(normal(strip(api.owner('emulator-1'))), normal(strip(cli.owner('emulator-1'))), 'the same owner values, minus pids and times');
    const shape = events => events.map(({ ts: _ts, actor: _actor, ...rest }) => ({ event: rest.event, lock: rest.lock, lease_id: rest.lease_id, claimant: rest.claimant }));
    assert.deepEqual(shape(api.events()), shape(cli.events()), 'the same event kinds and locks');
    assert.ok(api.events().every(event => event.actor === undefined || event.actor?.via === 'api'));
    for (const side of [cli, api]) assert.equal((await side.run(['release', 'par-1'])).code, 0);
  } finally { cli.cleanup(); api.cleanup(); }
});
