// Story 10.1 (AD-49, FR-18, NFR-8): the Hub API's side of the Event Log replica. Hermetic: a temp event dir per test, the
// routes driven through handle() with a fake adb wire and an injected inventory, host key and clock. No port is bound, no
// adb server and no host key is reached.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDevices } from '../ci/lib/devices.mjs';
import { loadPolicy } from '../ci/lib/policy.mjs';
import { strip } from '../ci/lib/source-scan.mjs';
import { hermetic } from '../ci/test-fixtures.mjs';
import { fakeWire } from '../device/wire-fixtures.mjs';
import { createReadings } from './readings.mjs';
import { createRemotes } from './remotes.mjs';
import { ROUTES, handle } from './routes.mjs';
import { REPLICA_PUSH_MAX_BYTES, checkEvents, createReplicas, gapError, replicaDir } from './replica.mjs';

hermetic();

const policy = loadPolicy().policy;
const T0 = Date.parse('2026-11-26T10:00:00Z');
const iso = ms => new Date(ms).toISOString();
const BOOT_B = 'b0b0b0b0b0b0';
const serverUp = () => ({ adb_servers: [{ port: 5037, pid: 4242, cwd: null }], emulators: [], xvfb: [] });
const sha256 = path => createHash('sha256').update(readFileSync(path)).digest('hex');

const macView = (extra = {}) => ({
  phones: [], locks: [], waiters: [], reservations: [], inventory: { adb_servers: [] }, emulators: [], ...extra,
});
const lineOf = (n, extra = '') => `${JSON.stringify({ format: 1, ts: iso(T0 + n * 1000), host: 'mommymac', host_id: 'MAC-UUID', hub_version: 'v1.2.60', event: 'lease', n: `${n}${extra}` })}\n`;
const pushBody = (extra = {}) => ({
  format: 1, host: 'mac', host_id: 'MAC-UUID', boot: BOOT_B, seq: 1, sent_at: iso(T0 - 1000), status: macView(), readings: null, events: null, ...extra,
});

function scratch() {
  const root = mkdtempSync(join(tmpdir(), 'hub-api-replica-'));
  const env = { PATH: process.env.PATH, HOME: root, HUB_LOCK_DIR: join(root, 'locks'), HUB_EVENT_DIR: join(root, 'events'), HUB_ADB_SERVER_PORT: '5037' };
  const readings = createReadings({ env, policy, now: () => T0, hostId: 'test-host', hostKey: () => 'linux', probe: async () => new Map() });
  const ctx = { env, policy, routes: ROUTES, now: () => T0, hostId: 'test-host', devices: structuredClone(loadDevices({})), qaDevices: () => [], hostKey: () => 'linux', inventory: serverUp, adbWire: fakeWire({ listed: [] }), sleep: () => Promise.resolve(), log: { out: () => {}, err: () => {} }, readings, remotes: createRemotes() };
  return {
    root, env, ctx,
    replicas: createReplicas({ env }),
    push: body => handle({ method: 'POST', url: '/agent/push', body }, ctx),
    status: () => handle({ method: 'GET', url: '/status' }, ctx),
    replicaFile: (host, month) => join(env.HUB_EVENT_DIR, 'replicas', host, `${month}.jsonl`),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

// ---- checkEvents ----

test('checkEvents: null stays null, a valid events is returned as checked', () => {
  assert.equal(checkEvents(null), null);
  const events = { month: '2026-11', from_offset: 0, lines: ['{"a":1}\n', '{"b":2}\n'] };
  assert.deepEqual(checkEvents(events), events);
});

test('checkEvents: every bad shape is HUB_USAGE 400 bad-events with exit 2', () => {
  const good = { month: '2026-11', from_offset: 0, lines: ['{"a":1}\n'] };
  const cases = [
    ['not an object', {}], ['an array', []], ['a string', 'x'],
    ['an extra key', { ...good, extra: 1 }], ['a missing key', (({ lines, ...rest }) => rest)(good)],
    ['a bad month', { ...good, month: '2026-13' }], ['a bare year', { ...good, month: '2026' }],
    ['a negative offset', { ...good, from_offset: -1 }], ['a fractional offset', { ...good, from_offset: 1.5 }],
    ['empty lines', { ...good, lines: [] }], ['a non-string line', { ...good, lines: [7] }],
    ['an empty line', { ...good, lines: ['\n'] }], ['no trailing newline', { ...good, lines: ['x'] }],
    ['two trailing newlines', { ...good, lines: ['x\n\n'] }], ['an embedded newline', { ...good, lines: ['x\ny\n'] }],
    ['over the body limit', { ...good, lines: [`${'x'.repeat(1024 * 1024)}\n`] }],
  ];
  for (const [what, events] of cases) {
    try {
      checkEvents(events);
      assert.fail(`${what}: accepted`);
    } catch (error) {
      assert.equal(error.status, 400, what);
      assert.equal(error.code, 'HUB_USAGE', what);
      assert.equal(error.exit, 2, what);
      assert.equal(error.reason, 'bad-events', what);
    }
  }
});

// ---- createReplicas ----

test('append writes byte-for-byte, sizes are settled and sorted by month, and the dirs are mode 0o700', async () => {
  const s = scratch();
  try {
    const { replicas } = s;
    const nov = [lineOf(1), lineOf(2)];
    const oct = [lineOf(3)];
    // Out of month order, so the sort proves itself; one exclusive op per host at a time.
    await replicas.exclusive('mac', async () => {
      await replicas.append('mac', { month: '2026-11', from_offset: 0, lines: nov });
      await replicas.append('mac', { month: '2026-10', from_offset: 0, lines: oct });
    });
    assert.equal(readFileSync(s.replicaFile('mac', '2026-11'), 'utf8'), nov.join(''));
    assert.equal(readFileSync(s.replicaFile('mac', '2026-10'), 'utf8'), oct.join(''));
    const sizes = await replicas.exclusive('mac', () => replicas.sizes('mac'));
    assert.deepEqual(Object.keys(sizes), ['2026-10', '2026-11']);
    assert.equal(sizes['2026-11'], Buffer.byteLength(nov.join('')));
    assert.equal(statSync(replicaDir(s.env, 'mac')).mode & 0o777, 0o700);
    assert.equal(statSync(join(replicaDir(s.env, 'mac'), '..')).mode & 0o777, 0o700);
  } finally { s.cleanup(); }
});

test('a gap is refused with the settled size and nothing is written; pushing from it succeeds', async () => {
  const s = scratch();
  try {
    const { replicas } = s;
    const first = [lineOf(1)];
    await replicas.exclusive('mac', () => replicas.append('mac', { month: '2026-11', from_offset: 0, lines: first }));
    const size = Buffer.byteLength(first.join(''));
    const error = await replicas.exclusive('mac', () => replicas.append('mac', { month: '2026-11', from_offset: size + 1, lines: [lineOf(2)] })).catch(caught => caught);
    assert.equal(error.code, 'HUB_REPLICA_GAP');
    assert.equal(error.status, 409);
    assert.equal(error.exit, 1);
    assert.equal(error.reason, 'gap');
    assert.equal(error.size, size);
    assert.equal(readFileSync(s.replicaFile('mac', '2026-11'), 'utf8'), first.join(''), 'nothing was appended');
    await replicas.exclusive('mac', () => replicas.append('mac', { month: '2026-11', from_offset: error.size, lines: [lineOf(2)] }));
    assert.equal(readFileSync(s.replicaFile('mac', '2026-11'), 'utf8'), `${first.join('')}${lineOf(2)}`);
    assert.equal(gapError(9).size, 9);
  } finally { s.cleanup(); }
});

test('a torn tail is truncated to its last complete line before the compare', async () => {
  const s = scratch();
  try {
    const { replicas } = s;
    const good = [lineOf(1), lineOf(2)];
    mkdirSync(replicaDir(s.env, 'mac'), { recursive: true });
    // A writer that died mid-line: the file's last byte is not a newline.
    writeFileSync(s.replicaFile('mac', '2026-11'), `${good.join('')}partial`);
    const sizes = await replicas.exclusive('mac', () => replicas.sizes('mac'));
    assert.equal(sizes['2026-11'], Buffer.byteLength(good.join('')));
    assert.equal(readFileSync(s.replicaFile('mac', '2026-11'), 'utf8'), good.join(''), 'the torn tail was truncated');
    // No newline at all: the whole file is torn and settles at 0.
    writeFileSync(s.replicaFile('mac', '2026-10'), 'torn');
    assert.equal((await replicas.exclusive('mac', () => replicas.sizes('mac')))['2026-10'], 0);
    assert.equal(readFileSync(s.replicaFile('mac', '2026-10'), 'utf8'), '');
    await replicas.exclusive('mac', () => replicas.append('mac', { month: '2026-11', from_offset: sizes['2026-11'], lines: [lineOf(3)] }));
    assert.equal(readFileSync(s.replicaFile('mac', '2026-11'), 'utf8'), `${good.join('')}${lineOf(3)}`);
  } finally { s.cleanup(); }
});

test('a failed append changes nothing: the file keeps its prior bytes', async () => {
  const s = scratch();
  try {
    const { replicas } = s;
    const first = [lineOf(1)];
    await replicas.exclusive('mac', () => replicas.append('mac', { month: '2026-11', from_offset: 0, lines: first }));
    chmodSync(s.replicaFile('mac', '2026-11'), 0o400);
    await assert.rejects(replicas.exclusive('mac', () => replicas.append('mac', { month: '2026-11', from_offset: Buffer.byteLength(first.join('')), lines: [lineOf(2)] })));
    assert.equal(readFileSync(s.replicaFile('mac', '2026-11'), 'utf8'), first.join(''));
  } finally { s.cleanup(); }
});

test('exclusive serializes one host\'s operations and no other host\'s', async () => {
  const s = scratch();
  try {
    const { replicas } = s;
    let release;
    const gate = new Promise(done => { release = done; });
    const order = [];
    const first = replicas.exclusive('mac', async () => { await gate; order.push('first'); });
    const second = replicas.exclusive('mac', async () => { order.push('second'); });
    const other = replicas.exclusive('linux', async () => { order.push('other'); });
    await new Promise(done => setImmediate(done));
    assert.deepEqual(order, ['other'], 'another host is not queued behind the gate');
    release();
    await Promise.all([first, second, other]);
    assert.deepEqual(order, ['other', 'first', 'second']);
  } finally { s.cleanup(); }
});

// ---- the route ----

test('a push with events appends byte-for-byte, and every 2xx answer reports the replica sizes', async () => {
  const s = scratch();
  try {
    const lines = [lineOf(1), lineOf(2)];
    const answer = await s.push(pushBody({ events: { month: '2026-11', from_offset: 0, lines } }));
    assert.equal(answer.status, 200, JSON.stringify(answer.body));
    assert.deepEqual(answer.body, { applied: true, host: 'mac', boot: BOOT_B, seq: 1, replica: { '2026-11': Buffer.byteLength(lines.join('')) } });
    assert.equal(readFileSync(s.replicaFile('mac', '2026-11'), 'utf8'), lines.join(''));
    // A push with no events reports the same sizes (they are read, never reset).
    const next = await s.push(pushBody({ seq: 2 }));
    assert.deepEqual(next.body.replica, { '2026-11': Buffer.byteLength(lines.join('')) });
  } finally { s.cleanup(); }
});

test('a repeated delivery appends nothing: the same body answers applied false and the hash is unchanged', async () => {
  const s = scratch();
  try {
    const body = pushBody({ events: { month: '2026-11', from_offset: 0, lines: [lineOf(1)] } });
    assert.equal((await s.push(body)).body.applied, true);
    const hash = sha256(s.replicaFile('mac', '2026-11'));
    const again = await s.push(body);
    assert.equal(again.status, 200);
    assert.equal(again.body.applied, false);
    assert.deepEqual(again.body.replica, { '2026-11': Buffer.byteLength(lineOf(1)) });
    assert.equal(sha256(s.replicaFile('mac', '2026-11')), hash, 'no duplicate line');
    assert.equal(readdirSync(join(s.env.HUB_EVENT_DIR, 'replicas', 'mac')).length, 1);
  } finally { s.cleanup(); }
});

test('a gap fails the whole push: nothing appended, nothing applied, no seq recorded; it is still contact', async () => {
  const s = scratch();
  try {
    // A first push establishes the view and seq 1.
    assert.equal((await s.push(pushBody())).body.applied, true);
    const lines = [lineOf(1)];
    await s.push(pushBody({ seq: 2, events: { month: '2026-11', from_offset: 0, lines } }));
    // seq 3 continues from a wrong offset: 409 with the settled size, and the file is untouched.
    const view2 = macView({ phones: [{ device: 'other' }] });
    const gap = await s.push(pushBody({ seq: 3, status: view2, events: { month: '2026-11', from_offset: 5, lines: [lineOf(2)] } }));
    assert.equal(gap.status, 409, JSON.stringify(gap.body));
    assert.equal(gap.body.code, 'HUB_REPLICA_GAP');
    assert.equal(gap.body.exit, 1);
    assert.equal(gap.body.reason, 'gap');
    assert.equal(gap.body.size, Buffer.byteLength(lines.join('')));
    assert.equal(readFileSync(s.replicaFile('mac', '2026-11'), 'utf8'), lines.join(''), 'nothing appended');
    // Nothing of the push was applied: the view is still the first push's, and its seq was not recorded.
    assert.deepEqual((await s.status()).body.hosts.mac, macView());
    const retry = await s.push(pushBody({ seq: 3, status: view2 }));
    assert.equal(retry.body.applied, true, 'a gap-failed push records no seq');
    assert.deepEqual((await s.status()).body.hosts.mac, view2);
  } finally { s.cleanup(); }
});

test('the route settles a torn replica tail before the compare, and resumes from it', async () => {
  const s = scratch();
  try {
    const good = [lineOf(1)];
    mkdirSync(replicaDir(s.env, 'mac'), { recursive: true });
    writeFileSync(s.replicaFile('mac', '2026-11'), `${good.join('')}torn`);
    // The answer's sizes are settled: the torn tail is truncated away and the compare is against the complete lines.
    const answer = await s.push(pushBody({ events: { month: '2026-11', from_offset: Buffer.byteLength(good.join('')), lines: [lineOf(2)] } }));
    assert.equal(answer.status, 200, JSON.stringify(answer.body));
    assert.equal(answer.body.applied, true);
    assert.equal(readFileSync(s.replicaFile('mac', '2026-11'), 'utf8'), `${good.join('')}${lineOf(2)}`);
    assert.deepEqual(answer.body.replica, { '2026-11': Buffer.byteLength(`${good.join('')}${lineOf(2)}`) });
  } finally { s.cleanup(); }
});

test('REPLICA_PUSH_MAX_BYTES is 256 KiB, under the API\'s 1 MiB body limit', () => {
  assert.equal(REPLICA_PUSH_MAX_BYTES, 256 * 1024);
});

// ---- conformance ----

const TOOLS = fileURLToPath(new URL('..', import.meta.url));
const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const sources = dir => readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
  const path = join(dir, entry.name);
  if (entry.isDirectory()) return sources(path);
  return entry.name.endsWith('.mjs') && !entry.name.endsWith('.test.mjs') ? [path] : [];
});
// `code` keeps string contents, with the comment lines gone: a word named in a comment is not a hit.
const codeOf = path => readFileSync(path, 'utf8').split('\n').filter(line => !/^\s*\/\//.test(line)).join('\n');
const relOf = path => path.slice(ROOT.length).split('\\').join('/');

test('only tools/hub-api/replica.mjs names the replicas directory, and lock.mjs never names it', () => {
  const files = sources(TOOLS);
  assert.deepEqual(files.filter(path => codeOf(path).includes("'replicas'")).map(relOf), ['tools/hub-api/replica.mjs']);
  const lock = files.find(path => relOf(path) === 'tools/ci/lib/lock.mjs');
  assert.ok(!/replicas/.test(strip(readFileSync(lock, 'utf8'))), 'lock.mjs names the replica');
});
