// Story 10.2 (FR-18, UJ-4, AD-40): GET /history through handle() on temp dirs, hermetic. This host's own log and the Mac's replica are files in
// two event dirs; the Mac's `/agent/sync` is an injected `ctx.request` (a fake, or a bridge to a real Host Agent handle() whose pusher posts into
// this Hub API's handle()). No port is bound, no ssh is run and no adb server or host key is reached.
import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadDevices } from '../ci/lib/devices.mjs';
import { loadPolicy } from '../ci/lib/policy.mjs';
import { hermetic } from '../ci/test-fixtures.mjs';
import { fakeWire } from '../device/wire-fixtures.mjs';
import { AGENT_ROUTES } from '../host-agent/routes.mjs';
import { createPusher } from '../host-agent/push.mjs';
import { decodeCursor, encodeCursor } from '../registry/history.mjs';
import { createReadings } from './readings.mjs';
import { createRemotes } from './remotes.mjs';
import { ROUTES, handle } from './routes.mjs';
import { createHistory, openReader, replicaLastTs } from './history.mjs';

hermetic();

const policy = loadPolicy().policy;
const NOW = Date.parse('2026-11-26T12:00:00Z');
const iso = ms => new Date(ms).toISOString();
const serverUp = () => ({ adb_servers: [{ port: 5037, pid: 4242, cwd: null }], emulators: [], xvfb: [] });
const AWAY = () => Object.assign(new Error('the mac host did not answer: timeout'), { code: 'HUB_DEVICE_AWAY', api: false, reason: 'host-unreachable', status: 503, exit: 75, detail: 'timeout' });

// One Event Log line: `who` is the writer's host_id. `at` is a time in ms.
const line = (at, who, extra = {}) => `${JSON.stringify({ format: 1, ts: iso(at), host: who === 'HUB' ? 'big-chungus' : 'mommymac', host_id: who, hub_version: 'v1.2.60', event: 'acquire', lock: 'adb', resource: 's26', claimant: { kind: 'agent', holder: 'bot', repo: null }, ...extra })}\n`;
const response = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function scratch({ hostKey = () => 'linux', request } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'hub-api-history-'));
  const env = { PATH: process.env.PATH, HOME: root, HUB_LOCK_DIR: join(root, 'locks'), HUB_EVENT_DIR: join(root, 'events'), HUB_ADB_SERVER_PORT: '5037' };
  const clock = { t: NOW };
  const calls = [];
  const errors = [];
  const readings = createReadings({ env, policy, now: () => clock.t, hostId: 'HUB', hostKey, probe: async () => new Map() });
  const ctx = {
    env, policy, routes: ROUTES, now: () => clock.t, hostId: 'HUB', devices: structuredClone(loadDevices({})), qaDevices: () => [], hostKey, inventory: serverUp,
    adbWire: fakeWire({ listed: [] }), sleep: () => Promise.resolve(), log: { out: () => {}, err: line2 => errors.push(line2) }, readings, remotes: createRemotes(),
    history: createHistory(),
    request: request ?? (async args => { calls.push(structuredClone(args)); return response({ pushed: true, synced: true, replica: args.body.replica }); }),
  };
  const write = (month, ...lines) => { mkdirSync(env.HUB_EVENT_DIR, { recursive: true }); appendFileSync(join(env.HUB_EVENT_DIR, `${month}.jsonl`), lines.join('')); };
  const replica = (month, ...lines) => { const dir = join(env.HUB_EVENT_DIR, 'replicas', 'mac'); mkdirSync(dir, { recursive: true }); appendFileSync(join(dir, `${month}.jsonl`), lines.join('')); };
  const history = async (query = '', more = {}) => handle({ method: 'GET', url: `/history${query === '' ? '' : `?${query}`}`, ...more }, ctx);
  const ids = answer => answer.body.events.map(entry => entry.id);
  return { root, env, ctx, clock, calls, errors, write, replica, history, ids, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const hostReachability = (at, to, from = null) => line(at, 'HUB', { event: 'host-reachability', host: 'mac', resource: null, lock: undefined, claimant: undefined, from, to, checked_at: iso(at), reason: to === 'reachable' ? 'push' : 'timeout' });

test('the route is GET /history with the History shape', () => {
  const route = ROUTES.find(candidate => candidate.method === 'GET' && candidate.path === '/history');
  assert.equal(route.shape, 'History');
});

test('both hosts, no filter: every event once as {id, host, event}, merged by ts, complete after a synced answer', async () => {
  const s = scratch();
  try {
    s.write('2026-11', line(NOW - 6000, 'HUB', { n: 1 }), line(NOW - 4000, 'HUB', { n: 3 }), line(NOW - 2000, 'HUB', { n: 5 }));
    s.replica('2026-11', line(NOW - 5000, 'MAC', { n: 2 }), line(NOW - 3000, 'MAC', { n: 4 }));
    const answer = await s.history();
    assert.equal(answer.status, 200, JSON.stringify(answer.body));
    assert.deepEqual(Object.keys(answer.body), ['format', 'events', 'cursor', 'more', 'partial', 'synced_through', 'unreachable_ranges', 'cross_host_order', 'checked_at']);
    assert.equal(answer.body.format, 1);
    assert.deepEqual(answer.body.events.map(entry => entry.event.n), [1, 2, 3, 4, 5]);
    assert.deepEqual(answer.body.events.map(entry => entry.host), ['linux', 'mac', 'linux', 'mac', 'linux']);
    assert.deepEqual(answer.body.events.map(entry => Object.keys(entry)), Array(5).fill(['id', 'host', 'event']));
    assert.equal(answer.body.events[0].id, 'HUB/2026-11/0');
    assert.match(answer.body.events[1].id, /^MAC\/2026-11\/0$/);
    assert.equal(answer.body.partial, false);
    assert.deepEqual(answer.body.unreachable_ranges, []);
    assert.equal(answer.body.more, false);
    assert.equal(answer.body.cross_host_order, 'display-only');
    assert.equal(answer.body.checked_at, iso(NOW));
    assert.equal(answer.body.synced_through.linux, iso(NOW));
    assert.equal(answer.body.synced_through.mac, iso(NOW), 'the synced answer is the proof');
    // The replica's sizes went to the Mac's agent.
    assert.equal(s.calls.length, 1);
    assert.deepEqual({ host: s.calls[0].host, method: s.calls[0].method, path: s.calls[0].path }, { host: 'mac', method: 'POST', path: '/agent/sync' });
    assert.deepEqual(s.calls[0].body, { replica: { '2026-11': Buffer.byteLength(line(NOW - 5000, 'MAC', { n: 2 }) + line(NOW - 3000, 'MAC', { n: 4 })) } });
    // The cursor decodes to {<host key>: "<month>/<offset>"}.
    assert.deepEqual(JSON.parse(Buffer.from(answer.body.cursor, 'base64url').toString()), { linux: `2026-11/${readFileSync(join(s.env.HUB_EVENT_DIR, '2026-11.jsonl')).length}`, mac: `2026-11/${readFileSync(join(s.env.HUB_EVENT_DIR, 'replicas/mac/2026-11.jsonl')).length}` });
    // Reads only: no replica or log was touched, and a second call needs no sync (the proof stands).
    await s.history();
    assert.equal(s.calls.length, 1);
  } finally { s.cleanup(); }
});

test('no logs at all: an empty answer, no cursor, complete', async () => {
  const s = scratch();
  try {
    const answer = await s.history();
    assert.equal(answer.status, 200);
    assert.deepEqual([answer.body.events, answer.body.cursor, answer.body.more, answer.body.partial], [[], null, false, false]);
  } finally { s.cleanup(); }
});

test('filters: resource (a v1a lock too), pool, claimant, repo, from and to, ANDed', async () => {
  const s = scratch();
  try {
    const v1a = line(NOW - 9000, 'HUB', { n: 'v1a', resource: undefined, lock: 'adb' });
    s.write('2026-11',
      v1a,
      line(NOW - 8000, 'HUB', { n: 's24', lock: 's24', resource: 's24', claimant: { kind: 'person', holder: 'jarad', repo: null } }),
      line(NOW - 7000, 'HUB', { n: 'job', claimant: { kind: 'deploy', holder: null, repo: 'o/a', run: '1' }, delivery: { repo: 'o/a', run: '1', version: '1.0.0' } }),
      line(NOW - 6000, 'HUB', { n: 'delivery', claimant: { kind: 'hub-job', holder: null, repo: null }, delivery: { repo: 'o/b', run: '2', version: '1' } }),
      line(NOW - 5000, 'HUB', { n: 'poolreq', lock: null, resource: null, pool: 'phone', request: 'r1' }),
      line(NOW - 4000, 'HUB', { n: 'emu', lock: 'emulator-1', resource: 'emulator' }));
    s.replica('2026-11', line(NOW - 3000, 'MAC', { n: 'ipad', lock: 'mac-ios', resource: 'ios-lane', claimant: { kind: 'agent', holder: 'bot', repo: null } }));
    const names = async query => (await s.history(query)).body.events.map(entry => entry.event.n);
    assert.deepEqual(await names('resource=s26'), ['v1a', 'job', 'delivery'], 'lock: adb without resource matches s26');
    assert.deepEqual(await names('resource=s24'), ['s24']);
    assert.deepEqual(await names('resource=ios-lane'), ['ipad']);
    assert.deepEqual(await names('pool=phone'), ['v1a', 's24', 'job', 'delivery', 'poolreq']);
    assert.deepEqual(await names('pool=emulator'), ['emu']);
    assert.deepEqual(await names('claimant=person'), ['s24']);
    assert.deepEqual(await names('claimant=jarad'), ['s24']);
    assert.deepEqual(await names('claimant=deploy'), ['job']);
    assert.deepEqual(await names('repo=o/a'), ['job']);
    assert.deepEqual(await names('repo=o/b'), ['delivery']);
    assert.deepEqual(await names('resource=s26&claimant=hub-job'), ['delivery']);
    assert.deepEqual(await names(`from=${iso(NOW - 6000)}&to=${iso(NOW - 4000)}`), ['delivery', 'poolreq']);
    assert.deepEqual(await names(`resource=s26&from=${iso(NOW - 8000)}`), ['job', 'delivery']);
    assert.deepEqual(await names('resource=nothing'), []);
    // The date part of `from` only.
    assert.equal((await s.history('from=2026-11-27')).body.events.length, 0);
    assert.equal((await s.history('from=2026-11-26&to=2026-11-27')).body.events.length, 7);
  } finally { s.cleanup(); }
});

test('paging: limit 2 over 5 events, every page a cursor, all pages together the full set once and in the same order', async () => {
  const s = scratch();
  try {
    s.write('2026-11', line(NOW - 5000, 'HUB', { n: 1 }), line(NOW - 3000, 'HUB', { n: 3 }), line(NOW - 1000, 'HUB', { n: 5 }));
    s.replica('2026-11', line(NOW - 4000, 'MAC', { n: 2 }), line(NOW - 2000, 'MAC', { n: 4 }));
    const first = await s.history('limit=2');
    assert.equal(first.body.more, true);
    assert.equal(first.body.events.length, 2);
    const seen = [...first.body.events];
    let page = first;
    let guard = 0;
    while (page.body.more) {
      page = await s.history(`limit=2&cursor=${page.body.cursor}`);
      assert.equal(page.status, 200, JSON.stringify(page.body));
      seen.push(...page.body.events);
      guard += 1;
      assert.ok(guard < 10);
    }
    assert.deepEqual(page.body.events.length, 1);
    assert.deepEqual(seen.map(entry => entry.event.n), [1, 2, 3, 4, 5]);
    assert.deepEqual(seen.map(entry => entry.id), s.ids(await s.history()));
    assert.equal(new Set(seen.map(entry => entry.id)).size, 5);
    // The cursor is good after the end: a new line shows up alone, from either host.
    s.write('2026-11', line(NOW - 500, 'HUB', { n: 6 }));
    const after = await s.history(`cursor=${page.body.cursor}`);
    assert.deepEqual(after.body.events.map(entry => entry.event.n), [6]);
  } finally { s.cleanup(); }
});

test('paging a multi-month log and replica at a small limit returns every line exactly once, none compacted, per host in (month, offset) order', async () => {
  const s = scratch();
  try {
    const own = { '2026-09': 3, '2026-10': 2, '2026-11': 4 };
    const mac = { '2026-10': 3, '2026-11': 3 };
    let tick = 0;
    const stamp = month => Date.parse(`${month}-10T00:00:00Z`) + (tick += 1) * 1000;
    const all = [];
    for (const [month, count] of Object.entries(own)) for (let i = 0; i < count; i += 1) { const at = stamp(month); all.push({ month, who: 'HUB', at }); }
    for (const [month, count] of Object.entries(mac)) for (let i = 0; i < count; i += 1) { const at = stamp(month); all.push({ month, who: 'MAC', at }); }
    for (const entry of all.filter(item => item.who === 'HUB')) s.write(entry.month, line(entry.at, 'HUB', { n: entry.at }));
    for (const entry of all.filter(item => item.who === 'MAC')) s.replica(entry.month, line(entry.at, 'MAC', { n: entry.at }));
    const full = await s.history('limit=1000');
    assert.equal(full.body.events.length, 15);
    assert.equal(full.body.partial, false);
    const paged = [];
    let cursor = null;
    for (let guard = 0; guard < 30; guard += 1) {
      const page = await s.history(`limit=4${cursor === null ? '' : `&cursor=${cursor}`}`);
      assert.equal(page.status, 200, JSON.stringify(page.body));
      paged.push(...page.body.events);
      cursor = page.body.cursor;
      if (!page.body.more) break;
    }
    assert.deepEqual(paged.map(entry => entry.id), full.body.events.map(entry => entry.id), 'the pages are the one full sequence');
    assert.equal(new Set(paged.map(entry => entry.id)).size, 15, 'no duplicates, none missing');
    const total = readdirSync(s.env.HUB_EVENT_DIR).filter(name => name.endsWith('.jsonl')).reduce((sum, name) => sum + readFileSync(join(s.env.HUB_EVENT_DIR, name), 'utf8').split('\n').filter(Boolean).length, 0)
      + readdirSync(join(s.env.HUB_EVENT_DIR, 'replicas/mac')).reduce((sum, name) => sum + readFileSync(join(s.env.HUB_EVENT_DIR, 'replicas/mac', name), 'utf8').split('\n').filter(Boolean).length, 0);
    assert.equal(paged.length, total, 'ids equal the whole set: nothing is compacted');
    // Per host, the order is (month, offset); across hosts the merge by ts is display only.
    for (const host of ['linux', 'mac']) {
      const places = paged.filter(entry => entry.host === host).map(entry => entry.id.split('/').slice(1)).map(([month, offset]) => [month, Number(offset)]);
      const sorted = [...places].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] - b[1]));
      assert.deepEqual(places, sorted, host);
    }
    assert.deepEqual(paged.map(entry => entry.event.n), [...paged.map(entry => entry.event.n)].sort((a, b) => a - b), 'merged by ts');
  } finally { s.cleanup(); }
});

test('a filtered page never scans a skipped line twice: the cursor sits after what was scanned', async () => {
  const s = scratch();
  try {
    s.write('2026-11', line(NOW - 6000, 'HUB', { n: 'x1', lock: 's24', resource: 's24' }), line(NOW - 5000, 'HUB', { n: 'a' }), line(NOW - 4000, 'HUB', { n: 'x2', lock: 's24', resource: 's24' }), line(NOW - 3000, 'HUB', { n: 'b' }));
    const first = await s.history('resource=s26&limit=1');
    assert.deepEqual(first.body.events.map(entry => entry.event.n), ['a']);
    assert.equal(first.body.more, true);
    // The head `b` is pending, so the cursor points at it; the skipped `x2` is behind the cursor.
    const position = decodeCursor(first.body.cursor).linux;
    assert.equal(position.offset, Buffer.byteLength(line(NOW - 6000, 'HUB', { n: 'x1', lock: 's24', resource: 's24' }) + line(NOW - 5000, 'HUB', { n: 'a' }) + line(NOW - 4000, 'HUB', { n: 'x2', lock: 's24', resource: 's24' })));
    const second = await s.history(`resource=s26&limit=1&cursor=${first.body.cursor}`);
    assert.deepEqual(second.body.events.map(entry => entry.event.n), ['b']);
    assert.equal(second.body.more, false);
  } finally { s.cleanup(); }
});

test('the Mac is asleep: the sync throws HUB_DEVICE_AWAY, the answer is partial with synced_through and the range, and the peer is marked once', async () => {
  const s = scratch({ request: async () => { throw AWAY(); } });
  try {
    s.write('2026-11', line(NOW - 7_200_000, 'HUB', { n: 1 }), hostReachability(NOW - 3_600_000, 'unreachable'));
    s.replica('2026-11', line(NOW - 5_400_000, 'MAC', { n: 2 }));
    const answer = await s.history();
    assert.equal(answer.status, 200, JSON.stringify(answer.body));
    assert.equal(answer.body.partial, true);
    assert.equal(answer.body.synced_through.mac, iso(NOW - 5_400_000), 'the replica\'s last complete line');
    assert.deepEqual(answer.body.unreachable_ranges, [{ host: 'mac', from: iso(NOW - 3_600_000), to: iso(NOW) }], 'clipped to [max(from, synced_through), window end)');
    assert.deepEqual(answer.body.events.filter(entry => entry.host === 'mac').map(entry => entry.event.n), [2], 'what the replica has is still shown');
    const reachability = () => readFileSync(join(s.env.HUB_EVENT_DIR, '2026-11.jsonl'), 'utf8').split('\n').filter(Boolean).map(text => JSON.parse(text)).filter(event => event.event === 'host-reachability');
    assert.equal(reachability().length, 2, 'the one new host-reachability event for the failure');
    assert.equal(reachability().at(-1).host, 'mac');
    assert.equal(reachability().at(-1).to, 'unreachable');
    // A second request in the retry window fails at the gate: no transport call, no second event.
    let called = 0;
    s.ctx.request = async () => { called += 1; throw AWAY(); };
    s.clock.t = NOW + 10_000;
    const again = await s.history();
    assert.equal(again.body.partial, true);
    assert.equal(called, 0);
    assert.equal(reachability().length, 2);
  } finally { s.cleanup(); }
});

test('the Mac is asleep with an empty replica: synced_through.mac is null', async () => {
  const s = scratch({ request: async () => { throw AWAY(); } });
  try {
    s.write('2026-11', line(NOW - 1000, 'HUB', { n: 1 }));
    const answer = await s.history();
    assert.equal(answer.body.partial, true);
    assert.equal(answer.body.synced_through.mac, null);
    // The failure's own host-reachability event is in this host's log by the time it is read.
    assert.deepEqual(answer.body.events.map(entry => entry.event.n ?? entry.event.event), [1, 'host-reachability']);
  } finally { s.cleanup(); }
});

test('asleep but synced later: the range is behind the replica, so it is none (the answer is partial only for the time past the replica)', async () => {
  const s = scratch({ request: async () => { throw AWAY(); } });
  try {
    s.write('2026-11', hostReachability(NOW - 7_200_000, 'unreachable'), hostReachability(NOW - 6_000_000, 'reachable', 'unreachable'));
    s.replica('2026-11', line(NOW - 3_600_000, 'MAC', { n: 1 }));
    const answer = await s.history();
    assert.equal(answer.body.partial, true, 'the replica ends an hour ago and the Mac cannot be asked');
    assert.deepEqual(answer.body.unreachable_ranges, []);
    // A past window the replica covers is complete, with no sync at all.
    let called = 0;
    s.ctx.request = async () => { called += 1; throw AWAY(); };
    const covered = await s.history(`to=${iso(NOW - 3_600_000)}`);
    assert.equal(covered.body.partial, false);
    assert.deepEqual(covered.body.unreachable_ranges, []);
    assert.equal(called, 0);
  } finally { s.cleanup(); }
});

test('a past window the replica covers calls no sync; one it may lack calls it first', async () => {
  const s = scratch();
  try {
    s.replica('2026-11', line(NOW - 3000, 'MAC', { n: 1 }), line(NOW - 1000, 'MAC', { n: 2 }));
    assert.equal((await s.history(`to=${iso(NOW - 1000)}`)).body.partial, false);
    assert.equal(s.calls.length, 0, 'to <= the replica\'s last ts');
    assert.equal((await s.history(`to=${iso(NOW - 999)}`)).body.partial, false, 'the agent answered synced: true');
    assert.equal(s.calls.length, 1, 'to past the replica\'s last ts asks the agent');
  } finally { s.cleanup(); }
});

test('a sync that answers synced: false leaves the answer partial; the replica it filled is read', async () => {
  const s = scratch();
  try {
    s.ctx.request = async args => { s.calls.push(args); s.replica('2026-11', line(NOW - 2000, 'MAC', { n: 'late' })); return response({ pushed: true, synced: false, replica: {} }); };
    const answer = await s.history();
    assert.equal(answer.body.partial, true);
    assert.equal(answer.body.synced_through.mac, iso(NOW - 2000));
    assert.deepEqual(answer.body.events.map(entry => entry.event.n), ['late'], 'the replica is read after the call');
  } finally { s.cleanup(); }
});

test('a peer\'s own problem is contact and a failed call is logged, neither changes a 200', async () => {
  const s = scratch();
  try {
    s.ctx.request = async () => new Response(JSON.stringify({ type: 'x', title: 'Bad Request', status: 400, detail: 'bad', code: 'HUB_USAGE', exit: 2, reason: 'bad-replica' }), { status: 400, headers: { 'content-type': 'application/problem+json' } });
    const answer = await s.history();
    assert.equal(answer.status, 200);
    assert.equal(answer.body.partial, true);
    assert.ok(s.errors.some(text => text.startsWith('HUB_API_HISTORY_SYNC_FAILED mac ')), s.errors.join('\n'));
  } finally { s.cleanup(); }
});

test('a bad query is 400 HUB_USAGE with its reason and reads nothing', async () => {
  const s = scratch();
  try {
    const cases = [
      ['x=1', 'bad-query'], ['resource=a&resource=b', 'bad-query'], ['pool=', 'bad-query'],
      ['from=nope', 'bad-range'], ['to=2026-99-01', 'bad-range'], [`from=${iso(NOW)}&to=${iso(NOW - 1)}`, 'bad-range'],
      ['cursor=zzz', 'bad-cursor'], [`cursor=${Buffer.from('{"pi":"2026-11/0"}').toString('base64url')}`, 'bad-cursor'],
      ['limit=0', 'bad-limit'], ['limit=1001', 'bad-limit'], ['limit=abc', 'bad-limit'],
    ];
    for (const [query, reason] of cases) {
      const answer = await s.history(query);
      assert.equal(answer.status, 400, query);
      assert.equal(answer.body.code, 'HUB_USAGE', query);
      assert.equal(answer.body.exit, 2, query);
      assert.equal(answer.body.reason, reason, query);
    }
    assert.equal(s.calls.length, 0, 'nothing was asked of the Mac');
    assert.equal(readdirSync(s.root).includes('events'), false, 'nothing was created or read');
  } finally { s.cleanup(); }
});

test('a cursor position the log never had is 400 bad-cursor', async () => {
  const s = scratch();
  try {
    s.write('2026-11', line(NOW - 1000, 'HUB', { n: 1 }));
    const cursor = encodeCursor({ linux: { month: '2026-11', offset: 3 } });
    const answer = await s.history(`cursor=${cursor}`);
    assert.equal(answer.status, 400);
    assert.equal(answer.body.reason, 'bad-cursor');
    const past = await s.history(`cursor=${encodeCursor({ linux: { month: '2026-11', offset: 99999 } })}`);
    assert.equal(past.body.reason, 'bad-cursor');
    const month = await s.history(`cursor=${encodeCursor({ linux: { month: '2026-10', offset: 5 } })}`);
    assert.equal(month.status, 400, 'a month the log has no file for');
    assert.equal(month.body.reason, 'bad-cursor');
  } finally { s.cleanup(); }
});

test('a host that does not know its key is 503 HUB_HOST_UNKNOWN', async () => {
  const s = scratch({ hostKey: () => { throw Object.assign(new Error('no host key'), { code: 'HUB_HOST_UNKNOWN' }); } });
  try {
    const answer = await s.history();
    assert.equal(answer.status, 503);
    assert.equal(answer.body.code, 'HUB_HOST_UNKNOWN');
    assert.equal(answer.body.reason, 'host-unknown');
  } finally { s.cleanup(); }
});

test('a line over the read bound is skipped with one log line; the lines before it show', async () => {
  const s = scratch();
  try {
    s.write('2026-11', line(NOW - 3000, 'HUB', { n: 'first' }), line(NOW - 2000, 'HUB', { n: 'x'.repeat(300 * 1024) }), line(NOW - 1000, 'HUB', { n: 'last' }));
    const answer = await s.history();
    assert.equal(answer.status, 200, JSON.stringify(answer.body).slice(0, 200));
    assert.deepEqual(answer.body.events.map(entry => entry.event.n), ['first']);
    assert.deepEqual(s.errors.filter(text => text.startsWith('HUB_API_HISTORY_SKIPPED')), ['HUB_API_HISTORY_SKIPPED linux 2026-11 HUB_EVENT_LINE_TOO_LONG']);
  } finally { s.cleanup(); }
});

test('a line that is not an event is skipped; a missing ts sorts first', async () => {
  const s = scratch();
  try {
    s.write('2026-11', 'not json\n', line(NOW - 1000, 'HUB', { n: 'dated' }), `${JSON.stringify({ format: 1, host_id: 'HUB', event: 'acquire', lock: 'adb', n: 'undated' })}\n`);
    s.replica('2026-11', line(NOW - 2000, 'MAC', { n: 'mac' }));
    const answer = await s.history();
    assert.deepEqual(answer.body.events.map(entry => entry.event.n), ['mac', 'dated', 'undated'], 'a head with no ts is taken before a later host\'s, but not out of its own host\'s order');
  } finally { s.cleanup(); }
});

test('reads only: a request leaves every log and replica byte for byte as it was', async () => {
  const s = scratch();
  try {
    s.write('2026-11', line(NOW - 3000, 'HUB', { n: 1 }));
    s.replica('2026-11', line(NOW - 2000, 'MAC', { n: 2 }));
    const hash = () => [join(s.env.HUB_EVENT_DIR, '2026-11.jsonl'), join(s.env.HUB_EVENT_DIR, 'replicas/mac/2026-11.jsonl')].map(file => readFileSync(file, 'utf8'));
    const before = hash();
    await s.history('limit=1');
    await s.history();
    assert.deepEqual(hash(), before);
  } finally { s.cleanup(); }
});

test('replicaLastTs: the newest non-empty month\'s last complete line; a torn tail is not a line', async () => {
  const s = scratch();
  try {
    assert.equal(await replicaLastTs(s.env, 'mac'), null);
    s.replica('2026-10', line(NOW - 9000, 'MAC'));
    s.replica('2026-11', '');
    assert.equal(await replicaLastTs(s.env, 'mac'), NOW - 9000, 'an empty newest month is passed over');
    s.replica('2026-11', line(NOW - 5000, 'MAC'), '{"ts":"2026-11-26T11:59:59.000Z"');
    assert.equal(await replicaLastTs(s.env, 'mac'), NOW - 5000, 'the torn tail is not read');
  } finally { s.cleanup(); }
});

test('openReader yields to the event loop between chunks', async () => {
  const s = scratch();
  try {
    for (let i = 0; i < 40; i += 1) s.write('2026-11', line(NOW - 1000 - i, 'HUB', { n: i, pad: 'p'.repeat(2000) }));
    // Each event-loop turn is one tick: reading 40 lines in 8 KiB chunks takes many turns, and the ticks prove the loop was free between them.
    let ticks = 0;
    let running = true;
    const tick = () => { ticks += 1; if (running) setImmediate(tick); };
    setImmediate(tick);
    const reader = openReader({ host: 'linux', root: s.env.HUB_EVENT_DIR, env: s.env, accept: () => true, chunkBytes: 8192 });
    let count = 0;
    while (await reader.peek() !== null) { reader.take(); count += 1; }
    running = false;
    assert.equal(count, 40);
    assert.ok(ticks >= 10, `the event loop turned ${ticks} times while the log was read`);
  } finally { s.cleanup(); }
});

// The real thing: the Hub API's /history calls a real Host Agent handle() whose pusher posts into this Hub API's handle(), so the replica is filled
// by the same push route a sleeping-then-waking Mac uses, and an event written after the last push shows with partial false.
test('a sync bridged to a real Host Agent fills the replica: a Mac event written after the last push shows, complete', async () => {
  const mac = mkdtempSync(join(tmpdir(), 'history-mac-'));
  const macEnv = { PATH: process.env.PATH, HOME: mac, HUB_LOCK_DIR: join(mac, 'locks'), HUB_EVENT_DIR: join(mac, 'events') };
  mkdirSync(macEnv.HUB_EVENT_DIR, { recursive: true });
  const s = scratch();
  try {
    const bridge = async ({ method, path, body }) => {
      const answer = await handle({ method, url: path, body }, s.ctx);
      return new Response(JSON.stringify(answer.body), { status: answer.status, headers: { 'content-type': String(answer.headers['Content-Type']) } });
    };
    const pusher = createPusher({ env: macEnv, policy, hostKey: () => 'mac', hostId: () => 'MAC', boot: 'a1b2c3d4e5f6', now: () => NOW, send: bridge, status: async () => ({ phones: [] }), readings: async () => [], log: { err: () => {} } });
    writeFileSync(join(macEnv.HUB_EVENT_DIR, '2026-10.jsonl'), line(Date.parse('2026-10-20T00:00:00Z'), 'MAC', { n: 'oct' }));
    writeFileSync(join(macEnv.HUB_EVENT_DIR, '2026-11.jsonl'), line(NOW - 9000, 'MAC', { n: 'before' }));
    assert.equal(await pusher.push(), true);
    // The Mac wrote another event after its last push, then "slept": only /agent/sync can bring it.
    appendFileSync(join(macEnv.HUB_EVENT_DIR, '2026-11.jsonl'), line(NOW - 2000, 'MAC', { n: 'after' }));
    s.write('2026-11', line(NOW - 5000, 'HUB', { n: 'hub' }));
    let agentCalls = 0;
    s.ctx.request = async ({ method, path, body }) => {
      agentCalls += 1;
      const answer = await handle({ method, url: path, body }, { routes: AGENT_ROUTES, sync: replica => pusher.sync(replica), log: { out: () => {}, err: () => {} } });
      return new Response(JSON.stringify(answer.body), { status: answer.status, headers: { 'content-type': String(answer.headers['Content-Type']) } });
    };
    const answer = await s.history();
    assert.equal(answer.status, 200, JSON.stringify(answer.body));
    assert.equal(agentCalls, 1);
    assert.equal(answer.body.partial, false);
    assert.deepEqual(answer.body.unreachable_ranges, []);
    assert.deepEqual(answer.body.events.map(entry => entry.event.n), ['oct', 'before', 'hub', 'after']);
    assert.equal(answer.body.synced_through.mac, iso(NOW), 'the synced answer\'s send time');
    for (const month of ['2026-10', '2026-11']) {
      assert.equal(readFileSync(join(s.env.HUB_EVENT_DIR, 'replicas/mac', `${month}.jsonl`), 'utf8'), readFileSync(join(macEnv.HUB_EVENT_DIR, `${month}.jsonl`), 'utf8'), `the replica of ${month} is the source`);
    }
  } finally { s.cleanup(); rmSync(mac, { recursive: true, force: true }); }
});
