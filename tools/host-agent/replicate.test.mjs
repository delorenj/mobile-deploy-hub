// Story 10.1 (AD-49, FR-18, NFR-8): the Host Agent replicates its Event Log to the Hub API's replica, byte-for-byte, with no
// cursor of its own. Hermetic: the agent's transport is bridged into the Hub API's `handle()` on separate temp event dirs
// (the Mac's source and the Hub's replica), so every push goes through the real route and the real replica writer. Each test
// ends with sha256(replica month) == sha256(source month). No port is bound and no adb server or host key is reached.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, appendFileSync, existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadDevices } from '../ci/lib/devices.mjs';
import { loadPolicy } from '../ci/lib/policy.mjs';
import { hermetic } from '../ci/test-fixtures.mjs';
import { fakeWire } from '../device/wire-fixtures.mjs';
import { createReadings } from '../hub-api/readings.mjs';
import { createRemotes } from '../hub-api/remotes.mjs';
import { ROUTES, handle } from '../hub-api/routes.mjs';
import { REPLICA_PUSH_MAX_BYTES } from '../hub-api/replica.mjs';
import { AGENT_ROUTES } from './routes.mjs';
import { createPusher } from './push.mjs';

hermetic();

const policy = loadPolicy().policy;
const T0 = Date.parse('2026-11-26T10:00:00Z');
const iso = ms => new Date(ms).toISOString();
const BOOT = 'a1b2c3d4e5f6';
const serverUp = () => ({ adb_servers: [{ port: 5037, pid: 4242, cwd: null }], emulators: [], xvfb: [] });
const sha256 = path => createHash('sha256').update(readFileSync(path)).digest('hex');

const lineOf = (n, extra = '') => `${JSON.stringify({ format: 1, ts: iso(T0 + n * 1000), host: 'mommymac', host_id: 'MAC-UUID', hub_version: 'v1.2.60', event: 'lease', n: `${n}${extra}` })}\n`;

// The Mac's source and the Hub API's replica, on separate temp event dirs. `months` maps month -> its lines.
function hosts({ months = {}, hub: hubExtra = {} } = {}) {
  const macRoot = mkdtempSync(join(tmpdir(), 'agent-replica-mac-'));
  const macEnv = { PATH: process.env.PATH, HOME: macRoot, HUB_LOCK_DIR: join(macRoot, 'locks'), HUB_EVENT_DIR: join(macRoot, 'events') };
  mkdirSync(macEnv.HUB_EVENT_DIR, { recursive: true });
  for (const [month, lines] of Object.entries(months)) writeFileSync(join(macEnv.HUB_EVENT_DIR, `${month}.jsonl`), lines.join(''));
  const hubRoot = mkdtempSync(join(tmpdir(), 'agent-replica-hub-'));
  const hubEnv = { PATH: process.env.PATH, HOME: hubRoot, HUB_LOCK_DIR: join(hubRoot, 'locks'), HUB_EVENT_DIR: join(hubRoot, 'events'), HUB_ADB_SERVER_PORT: '5037' };
  const readings = createReadings({ env: hubEnv, policy, now: () => T0, hostId: 'hub-host', hostKey: () => 'linux', probe: async () => new Map() });
  const hubCtx = { env: hubEnv, policy, routes: ROUTES, now: () => T0, hostId: 'hub-host', devices: structuredClone(loadDevices({})), qaDevices: () => [], hostKey: () => 'linux', inventory: serverUp, adbWire: fakeWire({ listed: [] }), sleep: () => Promise.resolve(), log: { out: () => {}, err: () => {} }, readings, remotes: createRemotes(), ...hubExtra };
  const pushes = [];
  const err = [];
  const bridge = async ({ method, path, body }) => {
    if (path === '/agent/push') pushes.push(structuredClone(body));
    const answer = await handle({ method, url: path, body }, hubCtx);
    return new Response(JSON.stringify(answer.body), { status: answer.status, headers: { 'content-type': String(answer.headers['Content-Type']) } });
  };
  const s = {
    macEnv, hubEnv, pushes, err, bridge,
    source: month => join(macEnv.HUB_EVENT_DIR, `${month}.jsonl`),
    replica: month => join(hubEnv.HUB_EVENT_DIR, 'replicas', 'mac', `${month}.jsonl`),
    appendSource: (month, lines) => appendFileSync(join(macEnv.HUB_EVENT_DIR, `${month}.jsonl`), lines.join('')),
    pusher: seams => createPusher({ env: macEnv, policy, hostKey: () => 'mac', hostId: () => 'MAC-UUID', boot: BOOT, now: () => T0, send: bridge, status: async () => ({ phones: [] }), readings: async () => [], log: { err: line => err.push(line) }, ...seams }),
    agentHandle: (body, sync) => handle({ method: 'POST', url: '/agent/sync', body }, { routes: AGENT_ROUTES, sync, log: { out: () => {}, err: () => {} } }),
    cleanup: () => { rmSync(macRoot, { recursive: true, force: true }); rmSync(hubRoot, { recursive: true, force: true }); },
  };
  // sha256(replica month) == sha256(source month): the whole point.
  s.hashEqual = month => sha256(s.replica(month)) === sha256(s.source(month));
  return s;
}

test('first replication: start with events null, then the oldest month from offset 0, one month per push, byte-for-byte', async () => {
  const oct = [lineOf(1), lineOf(2)];
  const nov = [lineOf(3)];
  const s = hosts({ months: { '2026-10': oct, '2026-11': nov } });
  try {
    const pusher = s.pusher();
    assert.equal(await pusher.push(), true);
    assert.equal(s.pushes.length, 3);
    const [first, second, third] = s.pushes;
    assert.equal(first.events, null, 'the first push never sends events to a replica it does not know');
    assert.ok(first.status !== null && first.readings !== null, 'the first push of a trigger carries status and readings');
    assert.deepEqual(second.events, { month: '2026-10', from_offset: 0, lines: oct }, 'the oldest month first, from 0');
    assert.deepEqual(third.events, { month: '2026-11', from_offset: 0, lines: nov });
    assert.ok(second.status === null && second.readings === null, 'catch-up rounds carry null status and readings');
    assert.ok(third.status === null && third.readings === null);
    assert.deepEqual(s.pushes.map(body => body.seq), [1, 2, 3], 'one seq per attempt');
    assert.ok(s.hashEqual('2026-10'));
    assert.ok(s.hashEqual('2026-11'));
    assert.deepEqual(s.err, []);
  } finally { s.cleanup(); }
});

test('both months differing drains the oldest first, and never two months in one push', async () => {
  const s = hosts({ months: { '2026-10': [lineOf(1)], '2026-11': [lineOf(3)] } });
  try {
    const pusher = s.pusher();
    assert.equal(await pusher.push(), true);
    s.appendSource('2026-10', [lineOf(2, '-again')]);
    s.appendSource('2026-11', [lineOf(4, '-again')]);
    const before = s.pushes.length;
    assert.equal(await pusher.push(), true);
    const rounds = s.pushes.slice(before);
    assert.deepEqual(rounds.map(body => body.events?.month ?? null), ['2026-10', '2026-11'], 'the oldest differing month first');
    assert.deepEqual(rounds.map(body => body.events.from_offset), [Buffer.byteLength(lineOf(1)), Buffer.byteLength(lineOf(3))]);
    assert.ok(rounds[0].status !== null && rounds[0].readings !== null, 'the first push of the trigger carries status and readings');
    assert.ok(rounds[1].status === null && rounds[1].readings === null, 'the catch-up round carries null for both');
    assert.ok(s.hashEqual('2026-10'));
    assert.ok(s.hashEqual('2026-11'));
  } finally { s.cleanup(); }
});

test('a fresh pusher resumes from the answer with no cursor of its own', async () => {
  const s = hosts({ months: { '2026-11': [lineOf(1)] } });
  try {
    const first = s.pusher();
    assert.equal(await first.push(), true);
    // A second pusher knows nothing: its first answer (replica sizes) is all it resumes from.
    const fresh = s.pusher();
    assert.equal(await fresh.push(), true);
    assert.equal(s.pushes.length, 3, 'the fresh pusher sent one push, with events null');
    assert.equal(s.pushes[2].events, null);
    // A new source line is pushed from the acknowledged size, not from a cursor on disk.
    s.appendSource('2026-11', [lineOf(2, '-later')]);
    assert.equal(await fresh.push(), true);
    const last = s.pushes.at(-1);
    assert.deepEqual(last.events, { month: '2026-11', from_offset: Buffer.byteLength(lineOf(1)), lines: [lineOf(2, '-later')] });
    assert.ok(s.hashEqual('2026-11'));
  } finally { s.cleanup(); }
});

test('POST /agent/sync hands the agent the sizes and makes it push from them', async () => {
  const s = hosts({ months: { '2026-10': [lineOf(1)], '2026-11': [lineOf(3)] } });
  try {
    const first = s.pusher();
    assert.equal(await first.push(), true);
    assert.ok(s.hashEqual('2026-10') && s.hashEqual('2026-11'));
    const sizeOct = Buffer.byteLength(lineOf(1));
    const sizeNov = Buffer.byteLength(lineOf(3));
    // The Hub API (/history) hands the agent its replica sizes; a new source line arrived meanwhile.
    s.appendSource('2026-11', [lineOf(4, '-later')]);
    const fresh = s.pusher();
    const answer = await s.agentHandle({ replica: { '2026-10': sizeOct, '2026-11': sizeNov } }, replica => fresh.sync(replica));
    assert.equal(answer.status, 200, JSON.stringify(answer.body));
    assert.deepEqual(answer.body, { pushed: true, synced: true, replica: { '2026-10': sizeOct, '2026-11': Buffer.byteLength(`${lineOf(3)}${lineOf(4, '-later')}`) } });
    const last = s.pushes.at(-1);
    assert.deepEqual(last.events, { month: '2026-11', from_offset: sizeNov, lines: [lineOf(4, '-later')] });
    assert.ok(s.hashEqual('2026-11'));
    assert.deepEqual(s.err, []);
  } finally { s.cleanup(); }
});

test('a torn delivery (the ack is lost) resumes from the gap with no duplicate line', async () => {
  const lines = [lineOf(1), lineOf(2)];
  const s = hosts({ months: { '2026-11': lines } });
  try {
    // The bridge throws after the Hub API applied the push, once: the replica has the bytes, the agent does not have the ack.
    let lost = false;
    const loseAck = async args => {
      const response = await s.bridge(args);
      if (args.path === '/agent/push' && args.body?.events && !lost) { lost = true; throw new Error('ack lost'); }
      return response;
    };
    const pusher = s.pusher({ send: loseAck });
    assert.equal(await pusher.push(), false, 'the push stays owed');
    assert.equal(pusher.owed(), true);
    const failed = s.err.filter(line => line.startsWith('HUB_AGENT_PUSH_FAILED'));
    assert.deepEqual(failed, ['HUB_AGENT_PUSH_FAILED ack lost'], 'one failure line');
    assert.equal(await pusher.push(), true, 'the next trigger resumes from the gap answer');
    assert.ok(s.hashEqual('2026-11'), 'no duplicate or shifted line');
    assert.equal(failed.length, 1, 'no new failure: the 409 was adopted');
  } finally { s.cleanup(); }
});

test('a repeated delivery appends nothing and is answered applied false', async () => {
  const s = hosts({ months: { '2026-11': [lineOf(1)] } });
  try {
    const pusher = s.pusher();
    assert.equal(await pusher.push(), true);
    assert.ok(s.hashEqual('2026-11'));
    const eventsPush = s.pushes.find(body => body.events !== null);
    // The same body (same boot and seq) arrives again: the Hub API appends nothing.
    const answer = await s.bridge({ method: 'POST', path: '/agent/push', body: eventsPush });
    assert.equal(answer.status, 200);
    const ack = await answer.json();
    assert.equal(ack.applied, false);
    assert.deepEqual(ack.replica, { '2026-11': Buffer.byteLength(lineOf(1)) });
    assert.ok(s.hashEqual('2026-11'), 'the replica is unchanged');
    assert.equal(readdirSync(join(s.hubEnv.HUB_EVENT_DIR, 'replicas', 'mac')).length, 1);
  } finally { s.cleanup(); }
});

test('a month whose acknowledged size is past its source end is skipped; the rest still replicate', async () => {
  const oct = [lineOf(1)];
  const nov = [lineOf(3)];
  const s = hosts({ months: { '2026-10': oct, '2026-11': nov } });
  try {
    const sizeOct = Buffer.byteLength(oct.join(''));
    const sizeNov = Buffer.byteLength(nov.join(''));
    const pusher = s.pusher();
    const sync = replica => s.agentHandle({ replica }, sizes => pusher.sync(sizes));
    // The acknowledged size of 2026-10 is beyond its source end: skipped with one line, and 2026-11 still replicates.
    const answer = await sync({ '2026-10': sizeOct + 50, '2026-11': 0 });
    assert.equal(answer.status, 200, JSON.stringify(answer.body));
    assert.equal(answer.body.pushed, true);
    const skipped = s.err.filter(line => line.startsWith('HUB_AGENT_REPLICA_SKIPPED'));
    assert.deepEqual(skipped, ['HUB_AGENT_REPLICA_SKIPPED 2026-10 HUB_EVENT_OFFSET']);
    assert.ok(s.hashEqual('2026-11'), 'the month that can be pushed is pushed');
    // The Hub API's answer says what it really holds (no 2026-10): that replaces the hinted sizes, so the month's
    // acknowledged size changed (to 0) and it resumes from 0 within the same trigger, hash-exact.
    assert.ok(s.hashEqual('2026-10'), 'the skipped month resumes from 0 once its acknowledged size changes');
    // Not retried until the acknowledged size changes: the same hint is skipped silently.
    const again = await sync({ '2026-10': sizeOct + 50, '2026-11': sizeNov });
    assert.equal(again.status, 200);
    assert.equal(s.err.filter(line => line.startsWith('HUB_AGENT_REPLICA_SKIPPED')).length, 1, 'the same size is not skipped twice');
    await sync({ '2026-10': sizeOct + 10, '2026-11': sizeNov });
    assert.deepEqual(s.err.filter(line => line.startsWith('HUB_AGENT_REPLICA_SKIPPED')), [
      'HUB_AGENT_REPLICA_SKIPPED 2026-10 HUB_EVENT_OFFSET',
      'HUB_AGENT_REPLICA_SKIPPED 2026-10 HUB_EVENT_OFFSET',
    ], 'a changed acknowledged size is retried (and skipped again: it is still past the end)');
  } finally { s.cleanup(); }
});

test('a month whose acknowledged size is not at a line start is skipped with one line, and recovers once the answer corrects it', async () => {
  const s = hosts({ months: { '2026-11': [lineOf(1), lineOf(2)] } });
  try {
    const pusher = s.pusher();
    // 5 bytes in is inside the first line: readEventsFrom refuses it (HUB_EVENT_OFFSET), so nothing is pushed from there.
    const answer = await s.agentHandle({ replica: { '2026-11': 5 } }, sizes => pusher.sync(sizes));
    assert.equal(answer.status, 200, JSON.stringify(answer.body));
    assert.deepEqual(s.err.filter(line => line.startsWith('HUB_AGENT_REPLICA_SKIPPED')), ['HUB_AGENT_REPLICA_SKIPPED 2026-11 HUB_EVENT_OFFSET']);
    assert.ok(s.pushes.every(body => body.events === null || body.events.from_offset !== 5), 'nothing was pushed from a mid-line offset');
    // The Hub API's answer said it holds nothing of the month (0): a changed acknowledged size, so it replicated from 0.
    assert.ok(s.hashEqual('2026-11'));
  } finally { s.cleanup(); }
});

test('an old Hub API (a 2xx without a valid replica) never gets events', async () => {
  const s = hosts({ months: { '2026-11': [lineOf(1)] } });
  try {
    const old = async args => {
      if (args.path === '/agent/push') { s.pushes.push(structuredClone(args.body)); return new Response(JSON.stringify({ applied: true }), { status: 200 }); }
      return s.bridge(args);
    };
    const pusher = s.pusher({ send: old });
    assert.equal(await pusher.push(), true);
    assert.equal(s.pushes.length, 1, 'one push, and the trigger ends');
    assert.equal(s.pushes[0].events, null, 'events stay null when the replica sizes are unknown');
    assert.deepEqual(s.err, []);
  } finally { s.cleanup(); }
});

test('a blank line in the source replicates byte-for-byte', async () => {
  const lines = [lineOf(1), '\n', lineOf(2)];
  const s = hosts({ months: { '2026-11': lines } });
  try {
    const pusher = s.pusher();
    assert.equal(await pusher.push(), true);
    const events = s.pushes.find(body => body.events !== null).events;
    assert.deepEqual(events.lines, lines, 'the blank line is a complete line and is pushed as-is');
    assert.ok(events.lines.includes('\n'));
    assert.ok(s.hashEqual('2026-11'));
    assert.deepEqual(s.err, []);
  } finally { s.cleanup(); }
});

test('a month with invalid UTF-8 is skipped with HUB_EVENT_NOT_UTF8; the rest still replicate', async () => {
  const s = hosts({ months: { '2026-11': [lineOf(3)] } });
  try {
    // A byte sequence that is not valid UTF-8: decoding lossily would change the bytes, so the month is never pushed.
    writeFileSync(s.source('2026-10'), Buffer.concat([Buffer.from('{"a":1}'), Buffer.from([0xfe]), Buffer.from('\n')]));
    const pusher = s.pusher();
    assert.equal(await pusher.push(), true);
    assert.deepEqual(s.err.filter(line => line.startsWith('HUB_AGENT_REPLICA_SKIPPED')), ['HUB_AGENT_REPLICA_SKIPPED 2026-10 HUB_EVENT_NOT_UTF8']);
    assert.ok(s.pushes.every(body => body.events === null || body.events.month !== '2026-10'), 'nothing of the month was pushed');
    assert.ok(!existsSync(s.replica('2026-10')), 'the Hub API has no replica of it');
    assert.ok(s.hashEqual('2026-11'), 'the month that can be pushed is pushed');
  } finally { s.cleanup(); }
});

test('a month over 700 KiB replicates in slices of at most REPLICA_PUSH_MAX_BYTES, with rising offsets', async () => {
  const lines = [];
  for (let n = 1; n <= 200; n += 1) lines.push(lineOf(n, '-'.repeat(4000)));
  const size = Buffer.byteLength(lines.join(''));
  assert.ok(size > 700 * 1024, `${size} bytes is the big source month`);
  const s = hosts({ months: { '2026-11': lines } });
  try {
    const pusher = s.pusher();
    assert.equal(await pusher.push(), true);
    const slices = s.pushes.map(body => body.events).filter(events => events !== null);
    assert.ok(slices.length >= 3, `the month came over in ${slices.length} pushes`);
    let want = 0;
    for (const events of slices) {
      const bytes = Buffer.byteLength(events.lines.join(''));
      assert.ok(bytes <= REPLICA_PUSH_MAX_BYTES, `one push carries ${bytes} bytes, at most ${REPLICA_PUSH_MAX_BYTES}`);
      assert.equal(events.from_offset, want, 'each push continues where the answer acknowledged');
      want += bytes;
    }
    assert.equal(want, size, 'the whole month came over');
    assert.ok(s.hashEqual('2026-11'));
    assert.deepEqual(s.err, []);
  } finally { s.cleanup(); }
});

test('a line longer than REPLICA_PUSH_MAX_BYTES is skipped; a later month still replicates', async () => {
  const big = `${JSON.stringify({ format: 1, ts: iso(T0), host: 'mommymac', host_id: 'MAC-UUID', event: 'lease', n: 'x'.repeat(REPLICA_PUSH_MAX_BYTES) })}\n`;
  const s = hosts({ months: { '2026-10': [big], '2026-11': [lineOf(3)] } });
  try {
    const pusher = s.pusher();
    assert.equal(await pusher.push(), true);
    assert.deepEqual(s.err.filter(line => line.startsWith('HUB_AGENT_REPLICA_SKIPPED')), ['HUB_AGENT_REPLICA_SKIPPED 2026-10 HUB_EVENT_LINE_TOO_LONG']);
    assert.ok(s.pushes.every(body => body.events === null || body.events.month !== '2026-10'), 'nothing of the month was pushed');
    assert.ok(s.hashEqual('2026-11'), 'the later month replicates');
  } finally { s.cleanup(); }
});

test('a Hub API that keeps answering HUB_REPLICA_GAP fails the push once and the trigger ends', async () => {
  const s = hosts({ months: { '2026-11': [lineOf(1)] } });
  try {
    let first = true;
    const stubborn = async ({ method, path, body }) => {
      s.pushes.push(structuredClone(body));
      if (first) { first = false; return new Response(JSON.stringify({ applied: true, replica: { '2026-11': 0 } }), { status: 200 }); }
      return new Response(JSON.stringify({ code: 'HUB_REPLICA_GAP', size: 0 }), { status: 409 });
    };
    const pusher = s.pusher({ send: stubborn });
    assert.equal(await pusher.push(), false, 'the gap never settles, so the push stays owed');
    assert.equal(pusher.owed(), true);
    const failed = s.err.filter(line => line.startsWith('HUB_AGENT_PUSH_FAILED'));
    assert.deepEqual(failed, ['HUB_AGENT_PUSH_FAILED the Hub API keeps answering HUB_REPLICA_GAP for 2026-11'], 'one failure line, and the drain stopped');
    const rounds = s.pushes.map(body => body.events).filter(events => events !== null);
    assert.equal(rounds.length, 3, 'three adopted gaps (GAP_MAX), then the drain gives up');
  } finally { s.cleanup(); }
});
