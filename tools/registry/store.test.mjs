// Story 6.2: the Registry store, hermetic: a temp lock dir and event dir per test, the seed's QA loader injected. Nothing reaches the
// real lock dir, event log or QA file.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDevices } from '../ci/lib/devices.mjs';
import { readEvents } from '../ci/lib/events.mjs';
import { writeFileAtomic } from '../ci/lib/lock.mjs';
import { hermetic } from '../ci/test-fixtures.mjs';
import { exitCodeOf } from '../device/claims.mjs';
import { REGISTRY_ERRORS, REGISTRY_FILE, REGISTRY_FORMAT, readRegistry, recoverRegistry, registryPath, writeRegistry } from './store.mjs';
import { seed } from './seed.mjs';

hermetic();

const none = () => [];
const HOST = 'test-host';
const QA_SERIAL = 'QAZZ99SECRET';

function scratch() {
  const root = mkdtempSync(join(tmpdir(), 'registry-store-'));
  const env = { PATH: process.env.PATH, HOME: root, HUB_LOCK_DIR: join(root, 'locks'), HUB_EVENT_DIR: join(root, 'events') };
  const seeded = () => structuredClone(seed(loadDevices({}), { qaDevices: none }));
  const events = () => [...readEvents({ env })];
  const file = () => JSON.parse(readFileSync(registryPath(env), 'utf8'));
  const write = (fields = {}) => writeRegistry({ env, hostId: HOST, log: () => {}, ...fields });
  return { root, env, seeded, events, file, write, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const withCapability = (resources, id, key, value) => resources.map(record => (record.id === id ? { ...record, capabilities: { ...record.capabilities, [key]: value } } : record));

test('a first write creates the file at rev 1, mode 0600, with one registry-add per record at rev 1', async () => {
  const s = scratch();
  try {
    const { resources, pools } = s.seeded();
    const result = await s.write({ if_rev: 0, resources, pools, actor: { holder: 'api', via: 'api' }, why: 'seed' });
    assert.equal(result.rev, 1);
    assert.equal(result.changed, true);
    assert.deepEqual(result.events.map(event => [event.event, event.resource, event.rev, event.logged]), resources.map(record => ['registry-add', record.id, 1, true]));
    const doc = s.file();
    assert.equal(doc.format, REGISTRY_FORMAT);
    assert.equal(doc.rev, 1);
    assert.equal(doc.resources.length, resources.length);
    assert.deepEqual(doc.pools.map(pool => pool.name), ['phone', 'emulator']);
    assert.deepEqual(doc.pools[0], { name: 'phone', members: ['s24', 's26'], named: true });
    assert.equal(statSync(registryPath(s.env)).mode & 0o777, 0o600);
    const logged = s.events().filter(event => event.event.startsWith('registry-'));
    assert.deepEqual(logged.map(event => [event.event, event.resource, event.lock, event.rev]), resources.map(record => ['registry-add', record.id, record.lock, 1]));
    assert.deepEqual(logged[0].actor, { holder: 'api', via: 'api' });
    assert.equal(logged[0].why, 'seed');
    assert.ok(logged[0].changed.includes('identity') && logged[0].changed.includes('id'));
    assert.ok(!logged.some(event => event.pools));
  } finally { s.cleanup(); }
});

test('an edit is rev + 1 with one registry-edit naming capabilities.<key>; unchanged records log nothing', async () => {
  const s = scratch();
  try {
    const { resources, pools } = s.seeded();
    await s.write({ if_rev: 0, resources, pools });
    await s.write({ if_rev: 1, resources: withCapability(resources, 'emulator', 'x', 1), pools });
    await s.write({ if_rev: 2, resources: withCapability(resources, 'emulator', 'x', 1), pools });
    await s.write({ if_rev: 2, resources: withCapability(resources, 'emulator', 'x', 1), pools });
    const edited = withCapability(withCapability(resources, 'emulator', 'x', 1), 's24', 'api_level', 34);
    const result = await s.write({ if_rev: 2, resources: edited, pools, reason: 'edit' });
    assert.equal(result.rev, 3);
    const since = s.events().filter(event => event.event === 'registry-edit' && event.rev === 3);
    assert.equal(since.length, 1);
    assert.deepEqual([since[0].resource, since[0].lock, since[0].changed, since[0].reason], ['s24', 's24', ['capabilities.api_level'], 'edit']);
    assert.equal(s.file().rev, 3);
  } finally { s.cleanup(); }
});

test('a retire is one registry-retire; a Pool change is one registry-edit of the whole Registry', async () => {
  const s = scratch();
  try {
    const { resources, pools } = s.seeded();
    await s.write({ if_rev: 0, resources, pools });
    const retired = resources.map(record => (record.id === 's24' ? { ...record, retired_at: '2026-11-25T00:00:00.000Z' } : record));
    const one = await s.write({ if_rev: 1, resources: retired, pools });
    assert.deepEqual(one.events.map(event => [event.event, event.resource, event.changed]), [['registry-retire', 's24', ['retired_at']]]);
    const moved = structuredClone(pools);
    moved.phone.members = ['s26'];
    const two = await s.write({ if_rev: 2, resources: retired, pools: moved });
    assert.deepEqual(two.events.map(event => [event.event, event.resource, event.lock, event.changed, event.rev]), [['registry-edit', 'registry', 'registry', ['pools.phone'], 3]]);
    assert.deepEqual(s.file().pools.find(pool => pool.name === 'phone').members, ['s26']);
  } finally { s.cleanup(); }
});

test('a no-op write commits nothing and logs nothing', async () => {
  const s = scratch();
  try {
    const { resources, pools } = s.seeded();
    await s.write({ if_rev: 0, resources, pools });
    const before = readFileSync(registryPath(s.env), 'utf8');
    const count = s.events().length;
    const result = await s.write({ if_rev: 1, resources: structuredClone(resources), pools: structuredClone(pools) });
    assert.deepEqual(result, { rev: 1, changed: false, events: [] });
    assert.equal(readFileSync(registryPath(s.env), 'utf8'), before);
    assert.equal(s.events().length, count);
  } finally { s.cleanup(); }
});

test('a stale if_rev is HUB_REGISTRY_CONFLICT with the current rev and leaves the file alone', async () => {
  const s = scratch();
  try {
    const { resources, pools } = s.seeded();
    await s.write({ if_rev: 0, resources, pools });
    await s.write({ if_rev: 1, resources: withCapability(resources, 's24', 'a', 1), pools });
    const before = readFileSync(registryPath(s.env), 'utf8');
    await assert.rejects(s.write({ if_rev: 1, resources: withCapability(resources, 's24', 'a', 2), pools }), error => error.code === 'HUB_REGISTRY_CONFLICT' && error.rev === 2 && error.status === 409 && error.exit === 1);
    assert.equal(readFileSync(registryPath(s.env), 'utf8'), before);
  } finally { s.cleanup(); }
});

test('two concurrent writers at if_rev 0: one wins at rev 1, the other conflicts (the queue holds B behind A)', async () => {
  const s = scratch();
  try {
    const { resources, pools } = s.seeded();
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    let entered;
    const started = new Promise(resolve => { entered = resolve; });
    const a = s.write({ if_rev: 0, resources, pools, afterRead: async () => { entered(); await gate; } });
    await started;
    const b = s.write({ if_rev: 0, resources: withCapability(resources, 's24', 'b', 1), pools });
    await new Promise(resolve => setImmediate(resolve));
    release();
    const [first, second] = await Promise.allSettled([a, b]);
    assert.equal(first.status, 'fulfilled');
    assert.equal(first.value.rev, 1);
    assert.equal(second.status, 'rejected');
    assert.equal(second.reason.code, 'HUB_REGISTRY_CONFLICT');
    assert.equal(second.reason.rev, 1);
    assert.equal(s.file().rev, 1);
    assert.equal(s.file().resources.find(record => record.id === 's24').capabilities.b, undefined);
  } finally { s.cleanup(); }
});

test('an unreadable file reads as the seed with one warning, and every write refuses it with the bytes unchanged', async () => {
  for (const [label, bytes, reason] of [['garbage', 'not json{', /not valid JSON/], ['format 2', JSON.stringify({ format: 2, rev: 9, resources: [], pools: [] }), /format 2/], ['bad shape', JSON.stringify({ format: 1, rev: 1, resources: {}, pools: [] }), /resources/],
  ['duplicate resource id', JSON.stringify({ format: 1, rev: 1, resources: [{ id: 'a', lock: 'a' }, { id: 'a', lock: 'b' }], pools: [] }), /repeats the id "a"/],
  ['record without a lock', JSON.stringify({ format: 1, rev: 1, resources: [{ id: 'a' }], pools: [] }), /resources\[0\] must be an object with an id and a lock/],
  ['duplicate pool name', JSON.stringify({ format: 1, rev: 1, resources: [], pools: [{ name: 'p' }, { name: 'p' }] }), /repeats the name "p"/],
  ['pool without a name', JSON.stringify({ format: 1, rev: 1, resources: [], pools: [{ members: [] }] }), /pools\[0\] must be an object with a name/],
]) {
    const s = scratch();
    try {
      mkdirSync(s.env.HUB_LOCK_DIR, { recursive: true });
      writeFileSync(registryPath(s.env), bytes);
      const warnings = [];
      const read = readRegistry({ env: s.env, qaDevices: none, warn: message => warnings.push(message) });
      assert.equal(read.source, 'seed', label);
      assert.equal(read.rev, 0);
      assert.equal(read.unreadable, true);
      assert.equal(warnings.length, 1);
      assert.match(warnings[0], /^HUB_REGISTRY_FORMAT: /);
      assert.match(warnings[0], reason);
      assert.deepEqual(read.resources.map(record => record.id), ['s24', 's26', 'ios-lane', 'emulator']);
      const { resources, pools } = s.seeded();
      await assert.rejects(s.write({ if_rev: 0, resources, pools }), error => error.code === 'HUB_REGISTRY_FORMAT' && error.status === 409 && error.exit === 1 && reason.test(error.reason));
      assert.equal(readFileSync(registryPath(s.env), 'utf8'), bytes);
      assert.equal(recoverRegistry({ env: s.env, hostId: HOST, log: () => {} }).recovered, false);
    } finally { s.cleanup(); }
  }
});

test('a missing file reads as the seed at rev 0 with the caller\'s qaDevices, without a warning', () => {
  const s = scratch();
  try {
    const warnings = [];
    const read = readRegistry({ env: s.env, qaDevices: () => [{ name: 'Pixel', model: 'Pixel 9', serial: QA_SERIAL }], warn: message => warnings.push(message) });
    assert.deepEqual([read.format, read.rev, read.source, read.unreadable, warnings], [1, 0, 'seed', undefined, []]);
    assert.ok(read.resources.some(record => record.id === 'res-pixel'));
    assert.deepEqual(read.pools.phone, { members: ['s24', 's26'], named: true });
  } finally { s.cleanup(); }
});

test('a good file reads back in the matcher\'s shape, fresh on every call, with the QA loader never opened', async () => {
  const s = scratch();
  try {
    const { resources, pools } = s.seeded();
    await s.write({ if_rev: 0, resources, pools });
    const trap = () => { throw new Error('the QA loader ran'); };
    const first = readRegistry({ env: s.env, qaDevices: trap });
    assert.deepEqual([first.source, first.rev, first.warnings], ['file', 1, []]);
    assert.deepEqual(first.pools.phone, { members: ['s24', 's26'], named: true });
    await s.write({ if_rev: 1, resources: withCapability(resources, 's24', 'api_level', 34), pools });
    const second = readRegistry({ env: s.env, qaDevices: trap });
    assert.equal(second.rev, 2);
    assert.equal(second.resources.find(record => record.id === 's24').capabilities.api_level, 34);
  } finally { s.cleanup(); }
});

test('unknown top-level keys of a format-1 file are carried through a write', async () => {
  const s = scratch();
  try {
    const { resources, pools } = s.seeded();
    mkdirSync(s.env.HUB_LOCK_DIR, { recursive: true });
    writeFileSync(registryPath(s.env), JSON.stringify({ format: 1, rev: 4, resources, pools: [{ name: 'phone', members: ['s24'] }], future: { a: 1 } }));
    await s.write({ if_rev: 4, resources: withCapability(resources, 's24', 'api_level', 34), pools: [{ name: 'phone', members: ['s24'] }] });
    assert.deepEqual(s.file().future, { a: 1 });
    assert.equal(s.file().rev, 5);
  } finally { s.cleanup(); }
});

test('a half-written temp beside a good file is ignored by readers and writers', async () => {
  const s = scratch();
  try {
    const { resources, pools } = s.seeded();
    await s.write({ if_rev: 0, resources, pools });
    writeFileSync(`${registryPath(s.env)}.4242.deadbeef.tmp`, '{"format":1,"rev":99,');
    assert.equal(readRegistry({ env: s.env, qaDevices: none }).rev, 1);
    const result = await s.write({ if_rev: 1, resources: withCapability(resources, 's24', 'a', 1), pools });
    assert.equal(result.rev, 2);
  } finally { s.cleanup(); }
});

test('recovery: a file ahead of the log gets one registry-edit "recovered", a second call appends nothing', () => {
  const s = scratch();
  try {
    const { resources, pools } = s.seeded();
    mkdirSync(s.env.HUB_LOCK_DIR, { recursive: true });
    writeFileSync(registryPath(s.env), JSON.stringify({ format: 1, rev: 3, resources, pools: Object.entries(pools).map(([name, rest]) => ({ name, ...rest })) }));
    const opts = { env: s.env, hostId: HOST, log: () => {} };
    const first = recoverRegistry(opts);
    assert.deepEqual([first.recovered, first.rev, first.logged_rev], [true, 3, 0]);
    const logged = s.events().filter(event => event.event.startsWith('registry-'));
    assert.equal(logged.length, 1);
    assert.deepEqual([logged[0].event, logged[0].resource, logged[0].lock, logged[0].rev, logged[0].reason], ['registry-edit', 'registry', 'registry', 3, 'recovered']);
    assert.equal(recoverRegistry(opts).recovered, false);
    assert.equal(s.events().length, 1);
  } finally { s.cleanup(); }
});

test('recovery: a log at rev 2 behind a file at rev 3 recovers; a log ahead or equal, or no file, does nothing', async () => {
  const s = scratch();
  try {
    assert.equal(recoverRegistry({ env: s.env, hostId: HOST, log: () => {} }).recovered, false, 'no file');
    const { resources, pools } = s.seeded();
    await s.write({ if_rev: 0, resources, pools });
    await s.write({ if_rev: 1, resources: withCapability(resources, 's24', 'a', 1), pools });
    assert.equal(recoverRegistry({ env: s.env, hostId: HOST, log: () => {} }).recovered, false, 'log level');
    // The file advances without its events (a crash between rename and log).
    const doc = s.file();
    writeFileSync(registryPath(s.env), JSON.stringify({ ...doc, rev: 3 }));
    const result = recoverRegistry({ env: s.env, hostId: HOST, log: () => {} });
    assert.deepEqual([result.recovered, result.logged_rev], [true, 2]);
    writeFileSync(registryPath(s.env), JSON.stringify({ ...doc, rev: 1 }));
    assert.equal(recoverRegistry({ env: s.env, hostId: HOST, log: () => {} }).recovered, false, 'log ahead');
  } finally { s.cleanup(); }
});

test('bad write input is a TypeError and writes nothing', async () => {
  const s = scratch();
  try {
    const { resources, pools } = s.seeded();
    await s.write({ if_rev: 0, resources, pools });
    const before = readFileSync(registryPath(s.env), 'utf8');
    const bad = [
      ['a dropped id', { if_rev: 1, resources: resources.filter(record => record.id !== 's24'), pools }],
      ['a changed lock', { if_rev: 1, resources: resources.map(record => (record.id === 's24' ? { ...record, lock: 'other' } : record)), pools }],
      ['a duplicate id', { if_rev: 1, resources: [...resources, resources[0]], pools }],
      ['non-array resources', { if_rev: 1, resources: { s24: {} }, pools }],
      ['a missing if_rev', { resources, pools }],
      ['a record with no id', { if_rev: 1, resources: [...resources, { lock: 'x' }], pools }],
      ['a bad actor', { if_rev: 1, resources: withCapability(resources, 's24', 'a', 1), pools, actor: { holder: 'x', via: 'nowhere' } }],
    ];
    for (const [label, input] of bad) await assert.rejects(s.write(input), TypeError, label);
    assert.equal(readFileSync(registryPath(s.env), 'utf8'), before);
    assert.equal(s.events().filter(event => event.event.startsWith('registry-')).length, resources.length);
  } finally { s.cleanup(); }
});

test('a failed event write never fails a committed write', async () => {
  const s = scratch();
  try {
    const { resources, pools } = s.seeded();
    mkdirSync(s.env.HUB_EVENT_DIR, { recursive: true });
    writeFileSync(join(s.env.HUB_EVENT_DIR, 'not-a-dir'), '');
    const env = { ...s.env, HUB_EVENT_DIR: join(s.env.HUB_EVENT_DIR, 'not-a-dir') };
    const lines = [];
    const result = await writeRegistry({ env, if_rev: 0, resources, pools, hostId: HOST, log: line => lines.push(line) });
    assert.equal(result.rev, 1);
    assert.ok(result.events.every(event => event.logged === false));
    assert.ok(lines.length > 0);
    assert.equal(JSON.parse(readFileSync(registryPath(env), 'utf8')).rev, 1);
  } finally { s.cleanup(); }
});

test('writeFileAtomic leaves no tmp when the rename fails, and the target keeps its bytes', () => {
  const s = scratch();
  try {
    const dir = join(s.root, 'atomic');
    mkdirSync(join(dir, 'target', 'inner'), { recursive: true });
    assert.throws(() => writeFileAtomic(join(dir, 'target'), 'x'));
    assert.deepEqual(readdirSync(dir), ['target']);
    writeFileAtomic(join(dir, 'file.json'), 'one');
    writeFileAtomic(join(dir, 'file.json'), 'two', { mode: 0o640 });
    assert.equal(readFileSync(join(dir, 'file.json'), 'utf8'), 'two');
    assert.equal(statSync(join(dir, 'file.json')).mode & 0o777, 0o640);
    assert.deepEqual(readdirSync(dir).sort(), ['file.json', 'target']);
    // fchmod is what makes the mode exact: openSync's mode is masked by the umask, fchmod is not.
    const previous = process.umask(0o077);
    try {
      writeFileAtomic(join(dir, 'masked.json'), 'x', { mode: 0o640 });
      assert.equal(statSync(join(dir, 'masked.json')).mode & 0o777, 0o640);
    } finally { process.umask(previous); }
  } finally { s.cleanup(); }
});

test('the error table agrees with claims.exitCodeOf, and the store has no write or rename of its own', () => {
  for (const [code, { status, exit }] of Object.entries(REGISTRY_ERRORS)) {
    assert.equal(status, 409);
    assert.equal(exitCodeOf({ code }), exit);
  }
  assert.equal(REGISTRY_FILE, 'registry.json');
  const source = readFileSync(fileURLToPath(new URL('./store.mjs', import.meta.url)), 'utf8');
  assert.doesNotMatch(source, /writeFileSync|renameSync|appendFileSync|openSync/);
  const lock = readFileSync(fileURLToPath(new URL('../ci/lib/lock.mjs', import.meta.url)), 'utf8');
  assert.doesNotMatch(lock, /registry\.json|REGISTRY_FILE/, 'lock.mjs never reads the Registry (AD-29)');
});

test('a QA serial in an identity never reaches an event line or an event result', async () => {
  const s = scratch();
  try {
    const seeded = seed(loadDevices({}), { qaDevices: () => [{ name: 'Pixel', model: 'Pixel 9', serial: QA_SERIAL }] });
    const result = await s.write({ if_rev: 0, resources: seeded.resources, pools: seeded.pools, actor: { holder: 'api', via: 'api' } });
    assert.ok(result.events.some(event => event.resource === 'res-pixel'));
    const text = readFileSync(join(s.env.HUB_EVENT_DIR, readdirSync(s.env.HUB_EVENT_DIR)[0]), 'utf8');
    assert.ok(text.includes('res-pixel'));
    assert.ok(!text.includes(QA_SERIAL));
    assert.ok(!JSON.stringify(result.events).includes(QA_SERIAL));
    assert.ok(existsSync(registryPath(s.env)));
  } finally { s.cleanup(); }
});
