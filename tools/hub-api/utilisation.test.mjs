// Story 10.3 (FR-18, AD-40, addendum B.7): GET /utilisation through handle() on temp dirs, hermetic. This host's own log and the Mac's replica are
// files in one event dir; the Mac's `/agent/sync` is an injected `ctx.request` (a fake). No port is bound, no ssh is run and no adb server or host
// key is reached. Every expected number is hand-computed from the fixtures (minutes before NOW).
import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadDevices } from '../ci/lib/devices.mjs';
import { loadPolicy } from '../ci/lib/policy.mjs';
import { hermetic } from '../ci/test-fixtures.mjs';
import { fakeWire } from '../device/wire-fixtures.mjs';
import { createHistory } from './history.mjs';
import { createReadings } from './readings.mjs';
import { createRemotes } from './remotes.mjs';
import { ROUTES, handle } from './routes.mjs';
import { createUtilisation, queryUtilisation } from './utilisation.mjs';
import { lockToResource, utilisation } from '../registry/history.mjs';
import { readRegistry } from '../registry/store.mjs';

hermetic();

const policy = loadPolicy().policy;
const NOW = Date.parse('2026-11-26T12:00:00Z');
const MIN = 60_000;
const m = minutes => minutes * MIN;
const at = minutes => NOW + minutes * MIN;
const iso = ms => new Date(ms).toISOString();
const serverUp = () => ({ adb_servers: [{ port: 5037, pid: 4242, cwd: null }], emulators: [], xvfb: [] });
const AWAY = () => Object.assign(new Error('the mac host did not answer: timeout'), { code: 'HUB_DEVICE_AWAY', api: false, reason: 'host-unreachable', status: 503, exit: 75, detail: 'timeout' });
const response = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

// One Event Log line, `minutes` from NOW, written by `who` (a host_id).
const line = (minutes, who, event, extra = {}) => `${JSON.stringify({ format: 1, ts: iso(at(minutes)), host: who === 'HUB' ? 'big-chungus' : 'mommymac', host_id: who, hub_version: 'v1.2.60', event, ...extra })}\n`;
const track = (minutes, who, resource, to) => line(minutes, who, 'reachability', { resource, from: null, to, checked_at: iso(at(minutes)), reason: 'track' });
const hold = (minutes, who, event, lock, extra = {}) => line(minutes, who, event, { lock, resource: undefined, hold_kind: 'lease', lease_id: 'l-1', expires_at: null, held_ms: null, ...extra });

function scratch({ hostKey = () => 'linux', request, policy: used = policy } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'hub-api-utilisation-'));
  const env = { PATH: process.env.PATH, HOME: root, HUB_LOCK_DIR: join(root, 'locks'), HUB_EVENT_DIR: join(root, 'events'), HUB_ADB_SERVER_PORT: '5037' };
  const clock = { t: NOW };
  const calls = [];
  const errors = [];
  const readings = createReadings({ env, policy: used, now: () => clock.t, hostId: 'HUB', hostKey, probe: async () => new Map() });
  const ctx = {
    env, policy: used, routes: ROUTES, now: () => clock.t, hostId: 'HUB', devices: structuredClone(loadDevices({})), qaDevices: () => [], hostKey, inventory: serverUp,
    adbWire: fakeWire({ listed: [] }), sleep: () => Promise.resolve(), log: { out: () => {}, err: text => errors.push(text) }, readings, remotes: createRemotes(),
    history: createHistory(), utilisation: createUtilisation(),
    request: request ?? (async args => { calls.push(structuredClone(args)); return response({ pushed: true, synced: true, replica: args.body.replica }); }),
  };
  const file = month => join(env.HUB_EVENT_DIR, `${month}.jsonl`);
  const write = (month, ...lines) => { mkdirSync(env.HUB_EVENT_DIR, { recursive: true }); appendFileSync(file(month), lines.join('')); };
  const replica = (month, ...lines) => { const dir = join(env.HUB_EVENT_DIR, 'replicas', 'mac'); mkdirSync(dir, { recursive: true }); appendFileSync(join(dir, `${month}.jsonl`), lines.join('')); };
  const utilisation = async (query = `from=${iso(at(-60))}`, more = {}) => handle({ method: 'GET', url: `/utilisation${query === '' ? '' : `?${query}`}`, ...more }, ctx);
  const resource = (answer, id) => answer.body.resources.find(entry => entry.id === id);
  return { root, env, ctx, clock, calls, errors, file, write, replica, utilisation, resource, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const classes = (row, expected) => assert.deepEqual({ ...row.ms }, { held: 0, idle_while_reserved: 0, idle: 0, away: 0, unknown: 0, ...expected });

test('the route is GET /utilisation with the Utilisation shape', () => {
  assert.equal(ROUTES.find(candidate => candidate.method === 'GET' && candidate.path === '/utilisation')?.shape, 'Utilisation');
});

test('both hosts: the answer has the documented keys, rows for every Resource, the Mac\'s from its replica, and complete after a synced answer', async () => {
  const s = scratch();
  try {
    s.write('2026-11', track(-60, 'HUB', 's26', 'reachable'), hold(-40, 'HUB', 'acquire', 'adb', { expires_at: iso(at(-20)) }), hold(-30, 'HUB', 'release', 'adb', { held_ms: m(10) }),
      hold(-30, 'HUB', 'acquire', 'emulator-1', { lease_id: 'e-1' }), hold(-10, 'HUB', 'release', 'emulator-1', { lease_id: 'e-1', held_ms: m(20) }));
    s.replica('2026-11', track(-60, 'MAC', 'ios-lane', 'reachable'), hold(-45, 'MAC', 'acquire', 'mac-ios', { lease_id: 'l-m', expires_at: iso(at(-15)) }), hold(-15, 'MAC', 'release', 'mac-ios', { lease_id: 'l-m', held_ms: m(30) }));
    const answer = await s.utilisation();
    assert.equal(answer.status, 200, JSON.stringify(answer.body));
    assert.deepEqual(Object.keys(answer.body), ['format', 'from', 'to', 'window_ms', 'resources', 'slots', 'partial', 'synced_through', 'checked_at']);
    assert.equal(answer.body.format, 1);
    assert.equal(answer.body.from, iso(at(-60)));
    assert.equal(answer.body.to, iso(NOW), 'to defaults to now');
    assert.equal(answer.body.window_ms, m(60));
    assert.equal(answer.body.partial, false);
    assert.deepEqual(answer.body.synced_through, { linux: iso(NOW), mac: iso(NOW) });
    assert.equal(answer.body.checked_at, iso(NOW));
    assert.deepEqual(answer.body.resources.map(entry => entry.id), ['s24', 's26', 'ios-lane', 'emulator']);
    assert.deepEqual(answer.body.resources.map(entry => Object.keys(entry)), Array(4).fill(['id', 'name', 'kind', 'host', 'span_ms', 'ms', 'shares']));
    assert.deepEqual(answer.body.resources.map(entry => [entry.kind, entry.host]), [['phone', 'linux'], ['phone', 'linux'], ['ios-lane', 'mac'], ['emulator-pool', 'linux']]);
    classes(s.resource(answer, 's26'), { idle: m(50), held: m(10) });
    classes(s.resource(answer, 's24'), { unknown: m(60) });
    classes(s.resource(answer, 'ios-lane'), { idle: m(30), held: m(30) });
    assert.equal(s.resource(answer, 'ios-lane').shares.held, 0.5);
    // The slots: the Pool's size is 2 (the default); slot 1 was held for 20 minutes. The Pool's row is their sum over 2 x the window.
    assert.deepEqual(answer.body.slots.map(slot => [slot.resource, slot.slot]), [['emulator', 'emulator-1'], ['emulator', 'emulator-2']]);
    assert.deepEqual(answer.body.slots.map(slot => Object.keys(slot)), Array(2).fill(['resource', 'slot', 'span_ms', 'ms', 'shares']));
    classes(answer.body.slots[0], { held: m(20), idle: m(40) });
    classes(answer.body.slots[1], { idle: m(60) });
    classes(s.resource(answer, 'emulator'), { held: m(20), idle: m(100) });
    assert.equal(s.resource(answer, 'emulator').span_ms, m(120));
    // The sync call went to the Mac once with the replica's sizes.
    assert.equal(s.calls.length, 1);
    assert.deepEqual({ host: s.calls[0].host, method: s.calls[0].method, path: s.calls[0].path }, { host: 'mac', method: 'POST', path: '/agent/sync' });
    // Nothing was written: no replica or log changed.
    assert.equal(readFileSync(s.file('2026-11'), 'utf8').split('\n').length, 6);
    assert.deepEqual(s.errors, []);
  } finally { s.cleanup(); }
});

test('a v1a event with no resource field is s26\'s held time', async () => {
  const s = scratch();
  try {
    s.write('2026-11', `${JSON.stringify({ format: 1, ts: iso(at(-30)), host_id: 'HUB', event: 'acquire', lock: 'adb', hold_kind: 'lease', lease_id: 'x' })}\n`, `${JSON.stringify({ format: 1, ts: iso(at(-10)), host_id: 'HUB', event: 'release', lock: 'adb', hold_kind: 'lease', lease_id: 'x', held_ms: m(20) })}\n`);
    classes(s.resource(await s.utilisation(), 's26'), { held: m(20), unknown: m(40) });
  } finally { s.cleanup(); }
});

test('Mac gap: the sync throws AWAY, the replica ends 2 h ago; the ios-lane Lease is held until then and unknown after, partial with synced_through', async () => {
  const s = scratch({ request: async () => { throw AWAY(); } });
  try {
    s.write('2026-11', track(-180, 'HUB', 's26', 'reachable'));
    s.replica('2026-11', track(-180, 'MAC', 'ios-lane', 'reachable'), hold(-150, 'MAC', 'acquire', 'mac-ios', { lease_id: 'l-m', expires_at: iso(at(600)) }), track(-120, 'MAC', 'ios-lane', 'reachable'));
    const answer = await s.utilisation(`from=${iso(at(-180))}`);
    assert.equal(answer.status, 200);
    assert.equal(answer.body.partial, true);
    assert.equal(answer.body.synced_through.mac, iso(at(-120)));
    assert.equal(answer.body.synced_through.linux, iso(NOW));
    classes(s.resource(answer, 'ios-lane'), { idle: m(30), held: m(30), unknown: m(120) });
    classes(s.resource(answer, 's26'), { idle: m(180) });
    // The same window ending where the replica ends is complete, and calls nothing.
    s.ctx.request = async () => { throw new Error('no call expected'); };
    const covered = await s.utilisation(`from=${iso(at(-180))}&to=${iso(at(-120))}`);
    assert.equal(covered.body.partial, false);
    classes(s.resource(covered, 'ios-lane'), { idle: m(30), held: m(30) });
    assert.equal(covered.body.to, iso(at(-120)));
  } finally { s.cleanup(); }
});

test('a Mac with no replica at all is unknown throughout and partial', async () => {
  const s = scratch({ request: async () => { throw AWAY(); } });
  try {
    const answer = await s.utilisation();
    assert.equal(answer.body.partial, true);
    assert.equal(answer.body.synced_through.mac, null);
    classes(s.resource(answer, 'ios-lane'), { unknown: m(60) });
    classes(s.resource(answer, 's26'), { unknown: m(60) });
  } finally { s.cleanup(); }
});

test('cache: the second request folds only the bytes appended since the first; earlier bytes are not read again', async () => {
  const s = scratch();
  try {
    s.write('2026-11', track(-60, 'HUB', 's26', 'reachable'), hold(-40, 'HUB', 'acquire', 'adb', { expires_at: iso(at(-30)) }), hold(-30, 'HUB', 'release', 'adb', { held_ms: m(10) }));
    const first = await s.utilisation();
    classes(s.resource(first, 's26'), { idle: m(50), held: m(10) });
    const size = statSync(s.file('2026-11')).size;
    assert.deepEqual(s.ctx.utilisation.sources.get('linux').position, { month: '2026-11', offset: size }, 'the fold stopped at the end of the log');
    // Rewrite the first line's resource in place (same length): a read from offset 0 would now see s24's reading, not s26's.
    const text = readFileSync(s.file('2026-11'), 'utf8');
    writeFileSync(s.file('2026-11'), text.replace('"resource":"s26"', '"resource":"s24"'));
    assert.equal(statSync(s.file('2026-11')).size, size);
    s.write('2026-11', hold(-20, 'HUB', 'acquire', 'adb', { lease_id: 'l-2', expires_at: iso(at(-10)) }));
    const second = await s.utilisation();
    classes(s.resource(second, 's26'), { idle: m(40), held: m(20) });
    classes(s.resource(second, 's24'), { unknown: m(60) });
    assert.deepEqual(s.ctx.utilisation.sources.get('linux').position, { month: '2026-11', offset: statSync(s.file('2026-11')).size });
    // A torn tail (no newline yet) is not folded and not skipped: the position stays before it.
    const before = statSync(s.file('2026-11')).size;
    appendFileSync(s.file('2026-11'), '{"format":1,"ts":"');
    await s.utilisation();
    assert.equal(s.ctx.utilisation.sources.get('linux').position.offset, before);
    appendFileSync(s.file('2026-11'), `${iso(at(-5))}","event":"acquire","lock":"adb","hold_kind":"lease","lease_id":"l-3","expires_at":null}\n`);
    classes(s.resource(await s.utilisation(), 's26'), { idle: m(35), held: m(25) });
  } finally { s.cleanup(); }
});

test('cache: a month that rolls over is followed, and the Mac\'s replica is cached the same way', async () => {
  const s = scratch();
  try {
    s.replica('2026-11', track(-60, 'MAC', 'ios-lane', 'reachable'));
    classes(s.resource(await s.utilisation(), 'ios-lane'), { idle: m(60) });
    assert.equal(s.ctx.utilisation.sources.get('mac').position.month, '2026-11');
    s.replica('2026-11', hold(-30, 'MAC', 'acquire', 'mac-ios', { expires_at: iso(at(-20)) }));
    classes(s.resource(await s.utilisation(), 'ios-lane'), { idle: m(50), held: m(10) });
    // A later month: the position moves into it.
    const dec = Date.parse('2026-12-01T00:30:00Z');
    s.clock.t = dec;
    s.write('2026-11', track(-60, 'HUB', 's24', 'reachable'));
    s.write('2026-12', `${JSON.stringify({ format: 1, ts: iso(Date.parse('2026-12-01T00:10:00Z')), host_id: 'HUB', event: 'reachability', resource: 's24', from: 'reachable', to: 'offline', checked_at: null, reason: 'track' })}\n`);
    const answer = await s.utilisation(`from=${iso(Date.parse('2026-11-30T23:30:00Z'))}`);
    assert.equal(s.ctx.utilisation.sources.get('linux').position.month, '2026-12');
    classes(s.resource(answer, 's24'), { idle: m(40), away: m(20) });
  } finally { s.cleanup(); }
});

test('cache: a position that vanished (the log shrank) rebuilds that host from offset 0, and only that host', async () => {
  const s = scratch();
  try {
    s.write('2026-11', track(-60, 'HUB', 's26', 'reachable'), track(-50, 'HUB', 's26', 'reachable'), track(-40, 'HUB', 's26', 'reachable'));
    s.replica('2026-11', track(-60, 'MAC', 'ios-lane', 'reachable'));
    await s.utilisation();
    const mac = s.ctx.utilisation.sources.get('mac');
    // The log is replaced by a shorter one: the stored offset is past its end.
    writeFileSync(s.file('2026-11'), track(-30, 'HUB', 's26', 'offline'));
    const answer = await s.utilisation();
    assert.equal(answer.status, 200);
    classes(s.resource(answer, 's26'), { unknown: m(30), away: m(30) });
    assert.equal(s.ctx.utilisation.sources.get('mac').timeline, mac.timeline, 'the Mac\'s cached fold was kept');
    assert.deepEqual(s.ctx.utilisation.sources.get('linux').position, { month: '2026-11', offset: statSync(s.file('2026-11')).size });
    // The month file going away is the same.
    rmSync(s.file('2026-11'));
    classes(s.resource(await s.utilisation(), 's26'), { unknown: m(60) });
  } finally { s.cleanup(); }
});

test('two requests at once are serialized per host and agree', async () => {
  const s = scratch();
  try {
    s.write('2026-11', track(-60, 'HUB', 's26', 'reachable'), hold(-30, 'HUB', 'acquire', 'adb', { expires_at: iso(at(-10)) }));
    const [a, b] = await Promise.all([s.utilisation(), s.utilisation()]);
    assert.deepEqual(a.body, b.body);
    classes(s.resource(a, 's26'), { idle: m(40), held: m(20) });
  } finally { s.cleanup(); }
});

test('a bad query is 400 HUB_USAGE bad-query or bad-range and reads nothing', async () => {
  const s = scratch();
  try {
    s.write('2026-11', track(-60, 'HUB', 's26', 'reachable'));
    const refused = async (query, reason) => {
      const answer = await s.utilisation(query);
      assert.equal(answer.status, 400, query);
      assert.equal(answer.body.code, 'HUB_USAGE');
      assert.equal(answer.body.reason, reason, query);
    };
    await refused('', 'bad-query');
    await refused(`to=${iso(at(-10))}`, 'bad-query');
    await refused(`from=${iso(at(-60))}&from=${iso(at(-50))}`, 'bad-query');
    await refused('from=', 'bad-query');
    await refused(`from=${iso(at(-60))}&limit=5`, 'bad-query');
    await refused(`from=${iso(at(-60))}&resource=s26`, 'bad-query');
    await refused('from=yesterday', 'bad-range');
    await refused(`from=${iso(at(-60))}&to=soon`, 'bad-range');
    await refused(`from=${iso(at(-30))}&to=${iso(at(-30))}`, 'bad-range');
    await refused(`from=${iso(at(-30))}&to=${iso(at(-40))}`, 'bad-range');
    await refused(`from=${iso(at(5))}`, 'bad-range');
    assert.equal(s.ctx.utilisation.sources.size, 0, 'nothing was read');
    assert.equal(s.calls.length, 0, 'no peer was asked');
    // A `to` in the future is clipped, not refused.
    const clipped = await s.utilisation(`from=${iso(at(-60))}&to=${iso(at(60))}`);
    assert.equal(clipped.status, 200);
    assert.equal(clipped.body.to, iso(NOW));
  } finally { s.cleanup(); }
});

test('a host that does not know its key is 503 HUB_HOST_UNKNOWN', async () => {
  const s = scratch({ hostKey: () => { throw Object.assign(new Error('no host key'), { code: 'HUB_HOST_UNKNOWN' }); } });
  try {
    const answer = await s.utilisation();
    assert.equal(answer.status, 503);
    assert.equal(answer.body.code, 'HUB_HOST_UNKNOWN');
    assert.equal(answer.body.reason, 'host-unknown');
  } finally { s.cleanup(); }
});

test('an unreadable Pool size falls back to the slots the log shows, with one HUB_API_UTILISATION_POOL line', async () => {
  const s = scratch();
  try {
    mkdirSync(s.env.HUB_LOCK_DIR, { recursive: true });
    writeFileSync(join(s.env.HUB_LOCK_DIR, 'emulator-pool'), 'lots\n');
    s.write('2026-11', hold(-30, 'HUB', 'acquire', 'emulator-3', { lease_id: 'e-3' }), hold(-20, 'HUB', 'release', 'emulator-3', { lease_id: 'e-3', held_ms: m(10) }));
    const answer = await s.utilisation();
    assert.equal(answer.status, 200);
    assert.deepEqual(answer.body.slots.map(slot => slot.slot), ['emulator-3']);
    classes(answer.body.slots[0], { held: m(10), idle: m(50) });
    classes(s.resource(answer, 'emulator'), { held: m(10), idle: m(50) });
    assert.equal(s.resource(answer, 'emulator').span_ms, m(60));
    assert.equal(s.errors.filter(text => text.startsWith('HUB_API_UTILISATION_POOL ')).length, 1);
  } finally { s.cleanup(); }
});

test('queryUtilisation is the whole of it: the injected Pool size and cache are used, and a request needs no registry before its query passes', async () => {
  const s = scratch();
  try {
    let read = 0;
    const base = { own: 'linux', env: s.env, registry: () => { read += 1; return { resources: [] }; }, now: () => NOW, peers: { gate() {}, marks: () => ({}) }, replicas: { exclusive: async (_host, fn) => fn(), sizes: async () => ({}) }, history: createHistory(), transport: async () => response({ synced: true }), policy, cache: createUtilisation() };
    await assert.rejects(queryUtilisation({ ...base, query: 'x=1' }), error => error.reason === 'bad-query');
    assert.equal(read, 0);
    const answer = await queryUtilisation({ ...base, query: `from=${iso(at(-60))}`, poolSize: () => 3 });
    assert.deepEqual(answer.slots.map(slot => slot.slot), ['emulator-1', 'emulator-2', 'emulator-3']);
    assert.deepEqual(answer.resources, [], 'only the Registry\'s Resources have a row');
    assert.equal(read, 1);
  } finally { s.cleanup(); }
});

test('the route reads the probe max age from the policy: a probe reading holds for registry.reachability_max_age_s', async () => {
  const wide = structuredClone(policy);
  wide.registry.reachability_max_age_s = 600;
  const s = scratch({ policy: wide });
  try {
    s.write('2026-11', line(-30, 'HUB', 'reachability', { resource: 's26', from: null, to: 'reachable', checked_at: iso(at(-30)), reason: 'probe' }));
    classes(s.resource(await s.utilisation(), 's26'), { idle: 600_000, unknown: m(60) - 600_000 });
  } finally { s.cleanup(); }
});

test('warm cache, two requests at once: each appended Hold is folded exactly once', async () => {
  const s = scratch();
  try {
    const pair = (from, to, id) => [hold(from, 'HUB', 'acquire', 'adb', { lease_id: id, expires_at: iso(at(to)) }), hold(to, 'HUB', 'release', 'adb', { lease_id: id, held_ms: m(to - from) })];
    s.write('2026-11', track(-60, 'HUB', 's26', 'reachable'), ...pair(-40, -30, 'l-1'));
    await s.utilisation();
    assert.equal(s.ctx.utilisation.sources.get('linux').timeline.held.get('adb').length, 1);
    s.write('2026-11', ...pair(-20, -10, 'l-2'), ...pair(-8, -5, 'l-3'));
    const [a, b] = await Promise.all([s.utilisation(), s.utilisation()]);
    assert.equal(s.ctx.utilisation.sources.get('linux').timeline.held.get('adb').length, 3);
    classes(s.resource(a, 's26'), { idle: m(60) - m(23), held: m(23) });
    assert.deepEqual(a.body, b.body);
  } finally { s.cleanup(); }
});

test('a read error that is not a vanished position forgets that host, fails the request, and the next one rebuilds the full history', async () => {
  const s = scratch();
  try {
    const first = track(-60, 'HUB', 's26', 'reachable');
    const rest = [hold(-40, 'HUB', 'acquire', 'adb', { expires_at: iso(at(-30)) }), hold(-30, 'HUB', 'release', 'adb', { held_ms: m(10) })];
    s.write('2026-11', first, ...rest);
    await s.utilisation();
    assert.equal(s.ctx.utilisation.sources.has('linux'), true);
    // The month file becomes a directory: reading it fails with EISDIR, which is no vanished position.
    const text = readFileSync(s.file('2026-11'), 'utf8');
    rmSync(s.file('2026-11'));
    mkdirSync(s.file('2026-11'));
    const failed = await s.utilisation();
    assert.equal(failed.status, 500);
    assert.equal(s.ctx.utilisation.sources.has('linux'), false);
    rmSync(s.file('2026-11'), { recursive: true });
    writeFileSync(s.file('2026-11'), text);
    const answer = await s.utilisation();
    assert.equal(answer.status, 200);
    classes(s.resource(answer, 's26'), { idle: m(50), held: m(10) });
  } finally { s.cleanup(); }
});

test('the route answers exactly what the pure utilisation() gives over the same events', async () => {
  const s = scratch();
  try {
    const key = 'o--a--1';
    const claim = (minutes, event, extra = {}) => line(minutes, 'HUB', event, { lock: 'adb', hold_kind: 'reservation', run_key: key, reserved_at: iso(at(-50)), expires_at: iso(at(-10)), ...extra });
    s.write('2026-11',
      track(-60, 'HUB', 's26', 'reachable'), track(-60, 'HUB', 's24', 'reachable'), claim(-50, 'claim'),
      hold(-40, 'HUB', 'acquire', 'adb', { expires_at: iso(at(-20)) }), hold(-35, 'HUB', 'extend', 'adb', { expires_at: iso(at(-15)) }),
      claim(-30, 'release', { held_ms: m(20) }), hold(-25, 'HUB', 'release', 'adb', { held_ms: m(15) }),
      line(-20, 'HUB', 'reachability', { resource: 's24', from: 'reachable', to: 'unknown', checked_at: null, reason: 'track-lost' }),
      hold(-30, 'HUB', 'acquire', 'emulator-1', { lease_id: 'e-1' }), hold(-10, 'HUB', 'release', 'emulator-1', { lease_id: 'e-1', held_ms: m(20) }));
    const answer = await s.utilisation();
    assert.equal(answer.status, 200);
    const events = readFileSync(s.file('2026-11'), 'utf8').split('\n').filter(Boolean).map(text => JSON.parse(text));
    const registry = readRegistry({ env: s.env, devices: s.ctx.devices, qaDevices: s.ctx.qaDevices });
    const expected = utilisation(events, registry, lockToResource(registry), { from: at(-60), to: NOW }, { maxAgeS: policy.registry.reachability_max_age_s, syncedThrough: { linux: NOW, mac: NOW }, slots: ['emulator-1', 'emulator-2'] });
    assert.deepEqual(answer.body.resources, expected.resources);
    assert.deepEqual(answer.body.slots, expected.slots);
    assert.equal(answer.body.window_ms, expected.window_ms);
    assert.ok(s.resource(answer, 's26').ms.held > 0 && s.resource(answer, 's26').ms.idle_while_reserved > 0);
  } finally { s.cleanup(); }
});
