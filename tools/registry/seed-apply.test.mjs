// Story 6.3: the seed at start (`applySeed`, `reseed`) and the record-state rule (`retirement`, `visibility`), hermetic: a temp lock dir
// and event dir per test, the QA loader injected and counted. Nothing reaches the real lock dir, event log or QA file. The QA serial
// is generated per run, so it is in no committed file.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDevices } from '../ci/lib/devices.mjs';
import { readEvents } from '../ci/lib/events.mjs';
import { hermetic } from '../ci/test-fixtures.mjs';
import { retirement, visibility } from './match.mjs';
import { reseed, seed } from './seed.mjs';
import { applySeed, readRegistryFile, registryPath, writeRegistry } from './store.mjs';

hermetic();

const HOST = 'test-host';
const NOW = () => Date.parse('2026-11-25T10:00:00Z');
const STAMP = '2026-11-25T10:00:00.000Z';
const QA_SERIAL = `QA${randomBytes(6).toString('hex')}`;
const S24_SERIAL = 'R5CX31AEJDA';

function scratch() {
  const root = mkdtempSync(join(tmpdir(), 'seed-apply-'));
  const env = { PATH: process.env.PATH, HOME: root, HUB_LOCK_DIR: join(root, 'locks'), HUB_EVENT_DIR: join(root, 'events') };
  let calls = 0;
  let entries = [{ name: 'S24', model: 'SM-S928U', serial: S24_SERIAL }, { name: 'Pixel-QA', model: 'Pixel 7', serial: QA_SERIAL, allowed_users: [0, 10] }];
  const s = {
    root, env,
    get calls() { return calls; },
    qa: next => { entries = next; },
    devices: () => structuredClone(loadDevices({})),
    apply: (devices = s.devices(), more = {}) => applySeed({ env, devices, qaDevices: () => { calls += 1; return entries; }, now: NOW, hostId: HOST, log: () => {}, ...more }),
    events: () => [...readEvents({ env })].filter(event => event.event.startsWith('registry-')),
    text: () => readFileSync(registryPath(env), 'utf8'),
    file: () => JSON.parse(readFileSync(registryPath(env), 'utf8')),
    write: fields => writeRegistry({ env, hostId: HOST, log: () => {}, ...fields }),
    // Rewrites the file's records through the one writer.
    edit: async change => {
      const { rev, resources, pools } = s.file();
      return s.write({ if_rev: rev, resources: change(structuredClone(resources)), pools });
    },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
  return s;
}

const byId = (doc, id) => doc.resources.find(record => record.id === id);

test('first creation: rev 1, the QA phones imported once, every record stamped, one registry-add per record', async () => {
  const s = scratch();
  try {
    const result = await s.apply();
    assert.deepEqual([result.first, result.rev, result.changed], [true, 1, true]);
    assert.equal(s.calls, 1);
    const doc = s.file();
    assert.equal(doc.rev, 1);
    assert.deepEqual(doc.resources.map(record => record.id), ['s24', 's26', 'ios-lane', 'emulator', 'res-pixel-qa']);
    assert.equal(byId(doc, 's24').capabilities.dedicated_qa, true);
    const pixel = byId(doc, 'res-pixel-qa');
    assert.deepEqual([pixel.seeded, pixel.identity.serial, pixel.capabilities.dedicated_qa, pixel.lock], [false, QA_SERIAL, true, 'res-pixel-qa']);
    for (const record of doc.resources) assert.equal(record.created_at, STAMP, record.id);
    assert.deepEqual(result.events.map(event => [event.event, event.resource, event.rev]), doc.resources.map(record => ['registry-add', record.id, 1]));
    assert.deepEqual(s.events().map(event => event.event), doc.resources.map(() => 'registry-add'));
    assert.deepEqual(s.events().map(event => event.reason), doc.resources.map(() => 'seed'));
    assert.deepEqual(result.warnings, []);
  } finally { s.cleanup(); }
});

test('re-seed with nothing changed: no loader call, no write, no event, the same bytes', async () => {
  const s = scratch();
  try {
    await s.apply();
    const bytes = s.text();
    const logged = s.events().length;
    const again = await s.apply();
    assert.deepEqual([again.first, again.changed, again.rev, again.events], [false, false, 1, []]);
    assert.equal(s.calls, 1, 'the QA loader ran only at first creation');
    assert.equal(s.text(), bytes);
    assert.equal(s.events().length, logged);
  } finally { s.cleanup(); }
});

test('Capability edits are kept across a re-seed and log nothing', async () => {
  const s = scratch();
  try {
    await s.apply();
    await s.edit(records => records.map(record => (record.id === 's24' ? { ...record, capabilities: { ...record.capabilities, api_level: 34 } } : record)));
    const logged = s.events().length;
    const again = await s.apply();
    assert.equal(again.changed, false);
    assert.deepEqual(byId(s.file(), 's24').capabilities, { dedicated_qa: true, api_level: 34 });
    assert.equal(s.events().length, logged);
  } finally { s.cleanup(); }
});

test('identity drift in devices.json is one registry-edit for that Resource; Capabilities are kept', async () => {
  const s = scratch();
  try {
    await s.apply();
    const devices = s.devices();
    devices.android.model = 'SM-NEW99';
    const result = await s.apply(devices);
    assert.deepEqual([result.changed, result.rev], [true, 2]);
    const edits = s.events().filter(event => event.rev === 2);
    assert.deepEqual(edits.map(event => [event.event, event.resource, event.changed, event.reason]), [['registry-edit', 's26', ['identity'], 'seed']]);
    assert.equal(byId(s.file(), 's26').identity.model, 'SM-NEW99');
    assert.equal(byId(s.file(), 's24').capabilities.dedicated_qa, true);
  } finally { s.cleanup(); }
});

test('a seeded phone that drops out of devices.json is kept with seed_missing, and comes back clean', async () => {
  const s = scratch();
  try {
    await s.apply();
    const devices = s.devices();
    const [s24] = devices.android_extra;
    devices.android_extra = [];
    const dropped = await s.apply(devices);
    assert.equal(dropped.changed, true);
    let doc = s.file();
    assert.equal(byId(doc, 's24').seed_missing, true);
    assert.equal(byId(doc, 's24').capabilities.dedicated_qa, true);
    assert.deepEqual(doc.pools.find(pool => pool.name === 'phone').members, ['s26']);
    assert.deepEqual(s.events().filter(event => event.rev === 2 && event.resource === 's24').map(event => [event.event, event.changed]), [['registry-edit', ['seed_missing']]]);
    assert.equal(s.events().filter(event => event.rev === 2 && event.resource === 's24').length, 1);
    // A second run with the phone still gone changes nothing.
    assert.equal((await s.apply(devices)).changed, false);

    devices.android_extra = [s24];
    const back = await s.apply(devices);
    assert.equal(back.changed, true);
    doc = s.file();
    assert.equal(Object.hasOwn(byId(doc, 's24'), 'seed_missing'), false);
    assert.deepEqual(doc.pools.find(pool => pool.name === 'phone').members, ['s24', 's26']);
    assert.deepEqual(s.events().filter(event => event.rev === 3 && event.resource === 's24').map(event => [event.event, event.changed]), [['registry-edit', ['seed_missing']]]);
    assert.equal(s.calls, 1);
  } finally { s.cleanup(); }
});

test('a phone added to devices.json is a registry-add with created_at, appended after the file\'s own records', async () => {
  const s = scratch();
  try {
    await s.apply();
    const devices = s.devices();
    devices.android_extra.push({ name: 'Pixel', model: 'Pixel 7', serial: 'PXL0001' });
    const result = await s.apply(devices);
    assert.equal(result.changed, true);
    const doc = s.file();
    assert.deepEqual(doc.resources.map(record => record.id), ['s24', 's26', 'ios-lane', 'emulator', 'res-pixel-qa', 'pixel']);
    assert.equal(byId(doc, 'pixel').created_at, STAMP);
    assert.deepEqual(s.events().filter(event => event.rev === 2).map(event => [event.event, event.resource]), [['registry-add', 'pixel']]);
  } finally { s.cleanup(); }
});

test('retired_at is kept and a runtime Resource is untouched by a re-seed', async () => {
  const s = scratch();
  try {
    await s.apply();
    await s.edit(records => records.map(record => (record.id === 's24' ? { ...record, retired_at: '2026-11-24T00:00:00.000Z' } : record)));
    const doc = s.file();
    const result = await s.apply();
    assert.equal(result.changed, false);
    assert.deepEqual(s.file(), doc);
    assert.equal(byId(s.file(), 's24').retired_at, '2026-11-24T00:00:00.000Z');
    // Even when the seed's own fields moved, retired_at stays and the runtime record is the same.
    const devices = s.devices();
    devices.android_extra[0].model = 'SM-S999U';
    await s.apply(devices);
    assert.equal(byId(s.file(), 's24').retired_at, '2026-11-24T00:00:00.000Z');
    assert.deepEqual(byId(s.file(), 'res-pixel-qa'), byId(doc, 'res-pixel-qa'));
  } finally { s.cleanup(); }
});

test('a hand-registered runtime Resource is never touched', async () => {
  const s = scratch();
  try {
    await s.apply();
    const foo = { id: 'res-foo', lock: 'res-foo', name: 'foo', words: [], display_name: 'Foo', kind: 'phone', host: 'linux', identity: { serial: 'FOO1', model: null }, capabilities: { api_level: 30 }, deploy_target: false, seeded: false, created_at: '2026-11-01T00:00:00.000Z', extra_key: 1 };
    await s.edit(records => [...records, foo]);
    const devices = s.devices();
    devices.android_extra = [];
    await s.apply(devices);
    assert.deepEqual(byId(s.file(), 'res-foo'), foo);
  } finally { s.cleanup(); }
});

test('a new seeded id whose name a runtime Resource already carries is added, with one warning naming both ids', async () => {
  const s = scratch();
  try {
    await s.apply();
    await s.edit(records => [...records, { id: 'res-x', lock: 'res-x', name: 'pixel', words: [], display_name: 'X', kind: 'phone', host: 'linux', identity: { serial: 'X1', model: null }, capabilities: {}, deploy_target: false, seeded: false, created_at: '2026-11-01T00:00:00.000Z' }]);
    const devices = s.devices();
    devices.android_extra.push({ name: 'Pixel', model: 'Pixel 7', serial: 'PXL0001' });
    const result = await s.apply(devices);
    assert.ok(byId(s.file(), 'pixel'));
    assert.equal(result.warnings.length, 1);
    assert.ok(result.warnings[0].includes('"pixel"') && result.warnings[0].includes('"res-x"'), result.warnings[0]);
  } finally { s.cleanup(); }
});

test('an unreadable registry.json is HUB_REGISTRY_FORMAT: its bytes stay and the QA loader is never called', async () => {
  const s = scratch();
  try {
    mkdirSync(dirname(registryPath(s.env)), { recursive: true });
    writeFileSync(registryPath(s.env), '{ garbage');
    await assert.rejects(() => s.apply(), error => error.code === 'HUB_REGISTRY_FORMAT');
    assert.equal(s.text(), '{ garbage');
    assert.equal(s.calls, 0);
    assert.deepEqual(s.events(), []);
  } finally { s.cleanup(); }
});

test('a broken QA file at first creation fails the seed and writes nothing, so the import is retried', async () => {
  const s = scratch();
  try {
    const broken = () => { throw Object.assign(new Error('qa broken'), { code: 'HUB_QA_DEVICES' }); };
    await assert.rejects(() => applySeed({ env: s.env, devices: s.devices(), qaDevices: broken, now: NOW, hostId: HOST, log: () => {} }), error => error.code === 'HUB_QA_DEVICES');
    assert.equal(readRegistryFile(s.env), null);
    assert.deepEqual(s.events(), []);
    const retry = await s.apply();
    assert.equal(retry.first, true);
    assert.ok(byId(s.file(), 'res-pixel-qa'), 'the import happened at the next start');
  } finally { s.cleanup(); }
});

test('the QA serial and allowed_users reach no event, warning or log line; allowed_users is in no file', async () => {
  const s = scratch();
  try {
    const first = await s.apply();
    const devices = s.devices();
    devices.android_extra = [];
    const second = await s.apply(devices);
    const warnings = [...first.warnings, ...second.warnings];
    const seen = [];
    const walk = (value, path) => {
      if (typeof value === 'string') seen.push([path, value]);
      else if (Array.isArray(value)) value.forEach((entry, index) => walk(entry, `${path}[${index}]`));
      else if (value !== null && typeof value === 'object') for (const [key, entry] of Object.entries(value)) { seen.push([`${path}.${key}#key`, key]); walk(entry, `${path}.${key}`); }
    };
    s.events().forEach((event, index) => walk(event, `event[${index}]`));
    [...first.events, ...second.events].forEach((event, index) => walk(event, `result[${index}]`));
    warnings.forEach((warning, index) => walk(warning, `warning[${index}]`));
    assert.ok(seen.length > 20, 'the walk covered the events');
    for (const [path, value] of seen) assert.ok(!value.includes(QA_SERIAL), `${path} carries the QA serial`);
    const logText = JSON.stringify(s.events());
    assert.ok(!logText.includes(QA_SERIAL));
    assert.ok(!s.text().includes('allowed_users'));
    assert.ok(s.text().includes(QA_SERIAL), 'the serial is in the 0600 file, where it belongs');
  } finally { s.cleanup(); }
});

test('no qa-devices.json is tracked by git', () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const tracked = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' }).split('\n');
  assert.deepEqual(tracked.filter(path => /qa-devices\.json$/.test(path)), []);
});

test('reseed is pure: its input is not mutated and a null current is the whole seed stamped by the clock', () => {
  const devices = loadDevices({});
  const current = { resources: structuredClone(seed(devices, { qaDevices: () => [] }).resources), pools: [{ name: 'phone', members: ['s24', 's26'], named: true }, { name: 'emulator', gate: 'emulator', size: 3 }, { name: 'extra', members: [] }] };
  const copy = structuredClone(current);
  const next = reseed(current, devices, { qaDevices: () => assert.fail('never called with a file'), now: NOW });
  assert.deepEqual(current, copy);
  assert.deepEqual(next.pools.find(pool => pool.name === 'emulator'), { name: 'emulator', gate: 'emulator', size: 3 });
  assert.deepEqual(next.pools.map(pool => pool.name), ['phone', 'emulator', 'extra']);
  const fresh = reseed(null, devices, { qaDevices: () => [], now: NOW });
  assert.ok(fresh.resources.every(record => record.created_at === STAMP));
  assert.deepEqual(fresh.pools.map(pool => pool.name), ['phone', 'emulator']);
});

test('retirement and visibility cover every combination of the two marks, held and queued', () => {
  const marks = [
    [{}, null],
    [{ retired_at: '2026-11-01T00:00:00Z' }, 'retired'],
    [{ seed_missing: true }, 'seed-missing'],
    [{ retired_at: '2026-11-01T00:00:00Z', seed_missing: true }, 'retired'],
    [{ seed_missing: false }, null],
    [{ retired_at: null }, null],
  ];
  for (const [fields, reason] of marks) {
    assert.equal(retirement({ id: 'x', ...fields }), reason, JSON.stringify(fields));
    for (const held of [false, true]) {
      for (const queued of [false, true]) {
        const expected = reason === null ? 'visible' : held || queued ? 'retiring' : 'hidden';
        assert.equal(visibility({ id: 'x', ...fields }, { held, queued }), expected, `${JSON.stringify(fields)} held=${held} queued=${queued}`);
      }
    }
  }
  assert.equal(visibility({ retired_at: 'x' }), 'hidden');
  assert.equal(retirement(undefined), null);
});

test('applySeed with no devices or qaDevices reads $HUB_DEVICES and the QA file at $HUB_QA_DEVICES, on first creation only', async () => {
  const s = scratch();
  try {
    const devicesFile = join(s.root, 'devices.json');
    writeFileSync(devicesFile, JSON.stringify(loadDevices({})));
    const qaFile = join(s.root, 'qa-devices.json');
    const env = { ...s.env, HUB_DEVICES: devicesFile, HUB_QA_DEVICES: qaFile };
    const apply = () => applySeed({ env, now: NOW, hostId: HOST, log: () => {} });

    writeFileSync(qaFile, '{ not json');
    await assert.rejects(apply, error => error.code === 'HUB_QA_DEVICES');
    assert.equal(readRegistryFile(env), null, 'a broken QA file writes nothing');

    writeFileSync(qaFile, JSON.stringify({ schema: 1, devices: [{ name: 'S24', model: 'SM-S928U', serial: S24_SERIAL }, { name: 'Pixel-QA', model: 'Pixel 7', serial: QA_SERIAL, allowed_users: [0] }] }));
    const result = await apply();
    assert.equal(result.first, true);
    const doc = s.file();
    assert.equal(byId(doc, 's24').capabilities.dedicated_qa, true);
    assert.equal(byId(doc, 'res-pixel-qa').identity.serial, QA_SERIAL);
    assert.ok(!s.text().includes('allowed_users'));

    // With the file present the QA file is not read again, even when it is broken.
    writeFileSync(qaFile, '{ not json');
    assert.equal((await apply()).changed, false);
  } finally { s.cleanup(); }
});
