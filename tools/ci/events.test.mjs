// The Event Log writer and reader (tools/ci/lib/events.mjs): one O_APPEND line per event, never fatal, with the hub version
// from hubRef() alone. Everything runs against a temp HUB_EVENT_DIR; the clock, host and machine id are injected.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EVENT_MAX_BYTES, appendEvent, eventDir, hostId, readEvents } from './lib/events.mjs';
import { hermetic } from './test-fixtures.mjs';

hermetic();

const eventsModule = fileURLToPath(new URL('./lib/events.mjs', import.meta.url));
const T0 = Date.parse('2026-11-23T10:00:00.000Z');

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'hub-events-'));
  const dir = join(root, 'events');
  const logs = [];
  const seams = { env: { HUB_EVENT_DIR: dir }, now: () => T0, log: line => logs.push(line), host: 'big-chungus', hostId: 'abc-123', hubFile: '/x/checkout/tools/ci/lib/receipt.mjs' };
  const lines = file => readFileSync(join(dir, file), 'utf8');
  return { root, dir, logs, seams, lines, cleanup: () => { try { chmodSync(root, 0o700); } catch { /* gone */ } rmSync(root, { recursive: true, force: true }); } };
}

test('appendEvent writes one envelope-first JSON line to the UTC month file', () => {
  const f = fixture();
  try {
    assert.equal(appendEvent({ event: 'acquire', lock: 'adb', waited_ms: 5 }, f.seams), true);
    assert.deepEqual(readdirSync(f.dir), ['2026-11.jsonl']);
    const text = f.lines('2026-11.jsonl');
    assert.ok(text.endsWith('\n') && text.split('\n').length === 2, 'exactly one line, ending in a newline');
    const event = JSON.parse(text);
    assert.deepEqual(Object.keys(event).slice(0, 5), ['format', 'ts', 'host', 'host_id', 'hub_version']);
    assert.deepEqual(event, { format: 1, ts: '2026-11-23T10:00:00.000Z', host: 'big-chungus', host_id: 'abc-123', hub_version: 'unknown', event: 'acquire', lock: 'adb', waited_ms: 5 });
    appendEvent({ event: 'release', lock: 'adb' }, f.seams);
    assert.equal(f.lines('2026-11.jsonl').trim().split('\n').length, 2, 'appends, never rewrites');
    appendEvent({ event: 'request', lock: 'adb' }, { ...f.seams, now: () => Date.parse('2026-12-01T00:00:00Z') });
    assert.deepEqual(readdirSync(f.dir).sort(), ['2026-11.jsonl', '2026-12.jsonl'], 'a new UTC month is a new file');
    assert.deepEqual(f.logs, []);
  } finally { f.cleanup(); }
});

test('the envelope wins over caller keys, and a null machine id is recorded as null', () => {
  const f = fixture();
  try {
    appendEvent({ event: 'acquire', format: 99, ts: 'yesterday', host: 'forged', host_id: 'forged', hub_version: 'forged' }, { ...f.seams, hostId: null });
    assert.deepEqual(JSON.parse(f.lines('2026-11.jsonl')), { format: 1, ts: '2026-11-23T10:00:00.000Z', host: 'big-chungus', host_id: null, hub_version: 'unknown', event: 'acquire' });
  } finally { f.cleanup(); }
});

test('HUB_EVENT_DIR defaults to the XDG state dir, then to ~/.local/state', () => {
  assert.equal(eventDir({ HUB_EVENT_DIR: '/e' }, '/home/x'), '/e');
  assert.equal(eventDir({ XDG_STATE_HOME: '/state' }, '/home/x'), '/state/mobile-deploy-hub/events');
  assert.equal(eventDir({}, '/home/x'), '/home/x/.local/state/mobile-deploy-hub/events');
  assert.equal(eventDir({ XDG_STATE_HOME: '' }, '/home/x'), '/home/x/.local/state/mobile-deploy-hub/events');
  assert.equal(eventDir({ XDG_STATE_HOME: 'relative/state' }, '/home/x'), '/home/x/.local/state/mobile-deploy-hub/events', 'XDG says a relative path is invalid');
});

test('an event dir that cannot be written logs HUB_EVENT_LOG_FAILED and returns without throwing', () => {
  const f = fixture();
  try {
    writeFileSync(join(f.root, 'events'), 'a file where the directory should be');
    assert.equal(appendEvent({ event: 'acquire' }, f.seams), false);
    assert.equal(f.logs.length, 1);
    assert.match(f.logs[0], /^HUB_EVENT_LOG_FAILED \S/);

    const readOnly = join(f.root, 'ro');
    mkdirSync(readOnly);
    chmodSync(readOnly, 0o500);
    f.logs.length = 0;
    // Running as root ignores the mode bits, so only assert the contract that holds either way.
    const wrote = appendEvent({ event: 'acquire' }, { ...f.seams, env: { HUB_EVENT_DIR: join(readOnly, 'sub/events') } });
    assert.equal(wrote, process.getuid?.() === 0);
    if (!wrote) assert.match(f.logs[0], /^HUB_EVENT_LOG_FAILED EACCES/);

    assert.doesNotThrow(() => appendEvent({ event: 'acquire' }, { ...f.seams, now: () => NaN, log: () => { throw new Error('logger broke'); } }), 'a bad clock and a broken logger are not fatal either');
  } finally { f.cleanup(); }
});

test('hub_version comes from hubRef alone: HUB_REF, the _actions path, the release dir, else unknown, never HUB_VERSION', () => {
  const f = fixture();
  try {
    const read = () => JSON.parse(f.lines('2026-11.jsonl').trim().split('\n').at(-1)).hub_version;
    const run = (env, hubFile) => appendEvent({ event: 'acquire' }, { ...f.seams, env: { HUB_EVENT_DIR: f.dir, ...env }, hubFile });
    const release = '/home/x/.local/share/mobile-deploy-hub/releases/v1.2.45/tools/ci/lib/receipt.mjs';
    const runner = '/home/x/_work/_actions/delorenj/mobile-deploy-hub/v1.2.44/tools/ci/lib/receipt.mjs';
    run({ HUB_REF: 'v9.0.0' }, release); assert.equal(read(), 'v9.0.0');
    run({}, runner); assert.equal(read(), 'v1.2.44');
    run({}, release); assert.equal(read(), 'v1.2.45');
    run({ HUB_VERSION: '9.9.9' }, '/home/x/code/mobile-deploy-hub/tools/ci/lib/receipt.mjs'); assert.equal(read(), 'unknown', 'the app version is not the hub version');
    run({ HUB_VERSION: '9.9.9' }, release); assert.equal(read(), 'v1.2.45');
  } finally { f.cleanup(); }
});

test('a line over 4 KiB loses free text until it fits and stays valid JSON', () => {
  const f = fixture();
  try {
    const sizeOf = () => f.lines('2026-11.jsonl').trim().split('\n').map(line => Buffer.byteLength(`${line}\n`));
    const read = () => f.lines('2026-11.jsonl').trim().split('\n').map(line => JSON.parse(line));
    appendEvent({ event: 'timeout', lock: 'adb', why: 'w'.repeat(6000), reason: 'short reason' }, f.seams);
    appendEvent({ event: 'timeout', lock: 'adb', why: '日本語"\\\n'.repeat(900), reason: 'r'.repeat(5000) }, f.seams);
    appendEvent({ event: 'timeout', lock: 'adb', why: 'ok', reason: 'fine' }, f.seams);
    const events = read();
    assert.ok(sizeOf().every(size => size <= EVENT_MAX_BYTES), `lines are ${sizeOf()}`);
    assert.equal(events[0].reason, 'short reason', 'the field that was not too long is kept');
    assert.ok(events[0].why.endsWith('…') && events[0].why.length > 3000, 'the long field is cut, not dropped');
    assert.ok(events[1].reason.endsWith('…') || events[1].why.endsWith('…'));
    assert.ok(events[1].why.length + events[1].reason.length > 1000, 'cut to fit, not to nothing');
    assert.deepEqual([events[2].why, events[2].reason], ['ok', 'fine'], 'a line that fits is untouched');
    assert.equal(events[0].lock, 'adb');

    f.logs.length = 0;
    assert.equal(appendEvent({ event: 'timeout', blocked_by: Array.from({ length: 400 }, (_, n) => ({ holder: `agent-${n}`, why: 'x'.repeat(20) })) }, f.seams), false, 'nothing truncatable can shrink it');
    assert.match(f.logs[0], /^HUB_EVENT_LOG_FAILED E2BIG event exceeds 4096 bytes/);
    assert.equal(read().length, 3, 'the oversize event wrote nothing');
  } finally { f.cleanup(); }
});

test('20 processes appending at once leave no torn line', async () => {
  const f = fixture();
  try {
    const perProcess = 15;
    const script = `
      import { appendEvent } from ${JSON.stringify(eventsModule)};
      const id = Number(process.argv[1]);
      for (let n = 0; n < ${perProcess}; n += 1) {
        appendEvent({ event: 'acquire', lock: 'adb', writer: id, n, why: 'p'.repeat(3000) }, { host: 'h', hostId: 'i', log: line => { console.error(line); process.exitCode = 1; } });
      }`;
    const run = id => new Promise((done, fail) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', script, String(id)], { env: { PATH: process.env.PATH, HUB_EVENT_DIR: f.dir }, stdio: ['ignore', 'ignore', 'pipe'] });
      let err = '';
      child.stderr.on('data', chunk => { err += chunk; });
      child.on('error', fail);
      child.on('close', code => (code === 0 ? done() : fail(new Error(`appender ${id} exited ${code}: ${err}`))));
    });
    await Promise.all(Array.from({ length: 20 }, (_, id) => run(id)));
    const files = readdirSync(f.dir);
    assert.equal(files.length, 1);
    const raw = readFileSync(join(f.dir, files[0]), 'utf8');
    assert.ok(raw.endsWith('\n'));
    const lines = raw.split('\n').slice(0, -1);
    assert.equal(lines.length, 20 * perProcess);
    const seen = new Set();
    for (const line of lines) {
      assert.ok(Buffer.byteLength(`${line}\n`) <= EVENT_MAX_BYTES);
      const event = JSON.parse(line);
      assert.equal(event.format, 1);
      seen.add(`${event.writer}/${event.n}`);
    }
    assert.equal(seen.size, 20 * perProcess, 'every append is there exactly once');
  } finally { f.cleanup(); }
});

test('readEvents yields events in file order over month boundaries and counts malformed lines', () => {
  const f = fixture();
  try {
    mkdirSync(f.dir, { recursive: true });
    const row = (ts, n) => JSON.stringify({ format: 1, ts, event: 'acquire', n });
    writeFileSync(join(f.dir, '2026-12.jsonl'), `${row('2026-12-02T00:00:00Z', 4)}\n${row('2026-12-31T23:59:59Z', 5)}\n`);
    writeFileSync(join(f.dir, '2026-11.jsonl'), `${row('2026-11-05T00:00:00Z', 1)}\nthis is not json\n${row('2026-11-30T23:59:59Z', 2)}\n[1,2]\n{"torn":\n`);
    writeFileSync(join(f.dir, 'notes.txt'), 'ignored');
    const ns = options => [...readEvents({ env: { HUB_EVENT_DIR: f.dir }, log: line => f.logs.push(line), ...options })].map(event => event.n);

    const stats = {};
    assert.deepEqual(ns({ stats }), [1, 2, 4, 5], 'November before December, a bad line skipped');
    assert.equal(stats.skipped, 3);
    assert.deepEqual(f.logs, ['HUB_EVENT_LOG_SKIPPED 2026-11.jsonl malformed=3']);

    f.logs.length = 0;
    assert.deepEqual(ns({ since: '2026-11-30T00:00:00Z', until: '2026-12-02T00:00:00Z' }), [2], 'since is inclusive, until is exclusive, across the boundary');
    f.logs.length = 0;
    assert.deepEqual(ns({ since: Date.parse('2026-12-01T00:00:00Z') }), [4, 5]);
    assert.deepEqual(f.logs, [], 'a month outside the bounds is not opened, so its bad lines are not counted');
    assert.deepEqual(ns({ until: new Date('2026-11-06T00:00:00Z') }), [1]);
    assert.throws(() => [...readEvents({ env: { HUB_EVENT_DIR: f.dir }, since: 'nonsense' })], TypeError);
    assert.deepEqual([...readEvents({ env: { HUB_EVENT_DIR: join(f.root, 'missing') } })], [], 'no event dir yet is an empty log');
  } finally { f.cleanup(); }
});

test('events written by appendEvent read back through readEvents', () => {
  const f = fixture();
  try {
    appendEvent({ event: 'request', lock: 'adb' }, f.seams);
    appendEvent({ event: 'acquire', lock: 'adb' }, { ...f.seams, now: () => T0 + 1000 });
    assert.deepEqual([...readEvents({ env: f.seams.env })].map(event => event.event), ['request', 'acquire']);
  } finally { f.cleanup(); }
});

test('hostId reads /etc/machine-id on Linux and IOPlatformUUID on the Mac, null when the host will not say', () => {
  assert.equal(hostId({ platform: 'linux', readFile: () => '6f1c2b440d1e5a7b9c3d2e4f5a6b7c8d\n' }), '6f1c2b440d1e5a7b9c3d2e4f5a6b7c8d');
  const ioreg = stdout => ({ platform: 'darwin', run: (cmd, args) => { assert.equal(cmd, 'ioreg'); assert.deepEqual(args, ['-rd1', '-c', 'IOPlatformExpertDevice']); return { stdout }; } });
  assert.equal(hostId(ioreg('  | "IOPlatformUUID" = "564D8C2A-1B2C-4D5E-8F90-A1B2C3D4E5F6"\n')), '564D8C2A-1B2C-4D5E-8F90-A1B2C3D4E5F6');
  assert.equal(hostId(ioreg('no uuid here')), null);
  assert.equal(hostId({ platform: 'linux', readFile: () => { throw Object.assign(new Error('nope'), { code: 'ENOENT' }); } }), null);
  assert.equal(hostId({ platform: 'linux', readFile: () => 'has spaces and "quotes"' }), null, 'only an id-shaped value is believed');
  assert.equal(hostId({ platform: 'win32' }), null);
});
