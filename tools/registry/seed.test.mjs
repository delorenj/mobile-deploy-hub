// Story 5.5: the Registry seed. Pure, so the cases build devices by hand; the QA file is only ever a temp file or an injected loader.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDevices } from '../ci/lib/devices.mjs';
import { DEPLOY_TARGETS, SEED_RESOURCES, resourceOf } from '../ci/lib/lock.mjs';
import { hermetic } from '../ci/test-fixtures.mjs';
import { fleetOf } from '../device/claims.mjs';
import { PHONE_POOL_SEED, QA_DEVICES_FILE, dedicatedQaIds, deployTargetIds, deployTargetLocks, loadQaDevices, qaDevicesPath, seed } from './seed.mjs';

hermetic();

const S24 = 'R5CX31AEJDA';
const S26 = 'R5GL43A7PCH';
const none = () => [];
const devices = () => structuredClone(loadDevices());
const ids = seeded => seeded.resources.map(resource => resource.id);
const byId = (seeded, id) => seeded.resources.find(resource => resource.id === id);
const KEYS = ['id', 'lock', 'name', 'words', 'display_name', 'kind', 'host', 'identity', 'capabilities', 'deploy_target', 'seeded'];

function scratch() {
  const root = mkdtempSync(join(tmpdir(), 'seed-test-'));
  return { root, file: join(root, 'qa.json'), cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('the committed devices.json seeds s24, s26, ios-lane and the emulator Pool, with s26 and ios-lane the deploy targets', () => {
  const seeded = seed(devices(), { qaDevices: none });
  assert.deepEqual(ids(seeded), ['s24', 's26', 'ios-lane', 'emulator']);
  assert.deepEqual([...deployTargetIds(seeded)], ['s26', 'ios-lane']);
  assert.deepEqual(deployTargetLocks(seeded), ['adb', 'mac-ios']);
  assert.deepEqual(seeded.pools, { phone: { members: ['s24', 's26'], named: true }, emulator: { gate: 'emulator' } });
  assert.deepEqual(seeded.warnings, []);
  for (const resource of seeded.resources) { assert.deepEqual(Object.keys(resource), KEYS); assert.equal(resource.seeded, true); }
  assert.deepEqual(seeded.resources.map(resource => [resource.id, resource.lock, resource.kind, resource.host, resource.deploy_target]), [
    ['s24', 's24', 'phone', 'linux', false], ['s26', 'adb', 'phone', 'linux', true], ['ios-lane', 'mac-ios', 'ios-lane', 'mac', true], ['emulator', 'emulator', 'emulator-pool', 'linux', false],
  ]);
  assert.deepEqual(byId(seeded, 's24').identity, { serial: S24, model: 'SM-S928U' });
  assert.deepEqual(byId(seeded, 'ios-lane').words, ['ipad', 'mac']);
  assert.deepEqual(Object.keys(byId(seeded, 'ios-lane').identity), ['udid', 'model']);
});

test('without android_extra the seed is s26, ios-lane, emulator and the phone Pool is [s26]', () => {
  const d = devices();
  delete d.android_extra;
  const seeded = seed(d, { qaDevices: none });
  assert.deepEqual(ids(seeded), ['s26', 'ios-lane', 'emulator']);
  assert.deepEqual(seeded.pools.phone.members, ['s26']);
});

test('seed never mutates devices', () => {
  const d = devices();
  const before = JSON.stringify(d);
  const seeded = seed(d, { qaDevices: () => [{ name: 'S24', serial: S24 }] });
  seeded.resources[0].identity.serial = 'changed';
  assert.equal(JSON.stringify(d), before);
});

test('a reserved extra name is the plain Error fleetOf always threw, with no code', () => {
  const d = devices();
  d.android_extra[0].name = 'Adb';
  for (const build of [() => seed(d, { qaDevices: none }), () => fleetOf(d)]) {
    assert.throws(build, error => error.code === undefined && /^devices\.json: android_extra\[\]\.name may not be "adb" \(a reserved word/.test(error.message));
  }
});

test('a QA entry for the S24 marks it dedicated_qa, keeps it first in the phone Pool, and imports no allowed_users', () => {
  const seeded = seed(devices(), { qaDevices: () => [{ name: 'S24', model: 'SM-S928U', serial: S24, allowed_users: [0] }] });
  assert.equal(byId(seeded, 's24').capabilities.dedicated_qa, true);
  assert.deepEqual(seeded.pools.phone.members, ['s24', 's26'], 'a mark never removes a member');
  assert.deepEqual(dedicatedQaIds(seeded), ['s24']);
  assert.ok(!JSON.stringify(seeded).includes('allowed_users'));
  assert.deepEqual(byId(seed(devices(), { qaDevices: none }), 's24').capabilities, {});
});

test('a QA entry for the deploy phone is skipped with a warning that names no serial', () => {
  const seeded = seed(devices(), { qaDevices: () => [{ name: 'Daily', serial: S26 }] });
  assert.deepEqual(byId(seeded, 's26').capabilities, {});
  assert.deepEqual(dedicatedQaIds(seeded), []);
  assert.equal(seeded.warnings.length, 1);
  assert.ok(!seeded.warnings[0].includes(S26));
});

test('a QA entry matching no phone becomes a runtime res-<slug> outside the phone Pool', () => {
  const seeded = seed(devices(), { qaDevices: () => [{ name: 'Pixel', model: 'Pixel 7', serial: 'ABC123' }] });
  const pixel = byId(seeded, 'res-pixel');
  assert.deepEqual(Object.keys(pixel), KEYS);
  assert.deepEqual([pixel.lock, pixel.kind, pixel.host, pixel.seeded, pixel.deploy_target, pixel.capabilities], ['res-pixel', 'phone', 'linux', false, false, { dedicated_qa: true }]);
  assert.deepEqual(seeded.pools.phone.members, ['s24', 's26']);
  assert.deepEqual(dedicatedQaIds(seeded), ['res-pixel']);
  assert.deepEqual(seeded.warnings, []);
});

test('a QA name that is refused or already taken is skipped with a warning that names no serial', () => {
  const seeded = seed(devices(), {
    qaDevices: () => [{ name: 'Pixel 7', serial: 'AAA111' }, { name: 'S24', serial: 'BBB222' }, { name: 'Adb', serial: 'CCC333' }, { name: 'Pixel', serial: 'DDD444' }, { name: 'pixel', serial: 'EEE555' }],
  });
  assert.deepEqual(ids(seeded), ['s24', 's26', 'ios-lane', 'emulator', 'res-pixel']);
  assert.equal(seeded.warnings.length, 4);
  for (const warning of seeded.warnings) assert.ok(!/AAA111|BBB222|CCC333|DDD444|EEE555/.test(warning), warning);
});

test('the loader is called exactly once per seed', () => {
  let calls = 0;
  seed(devices(), { qaDevices: () => { calls += 1; return []; } });
  assert.equal(calls, 1);
});

test('loadQaDevices: a missing file is [], a good one returns only name, model and serial', () => {
  const s = scratch();
  try {
    assert.deepEqual(loadQaDevices({ env: { HUB_QA_DEVICES: s.file } }), []);
    writeFileSync(s.file, JSON.stringify({ schema: 1, devices: [{ name: 'S24', model: 'SM-S928U', serial: S24, allowed_users: [0], extra: 1 }] }));
    const loaded = loadQaDevices({ env: { HUB_QA_DEVICES: s.file } });
    assert.deepEqual(loaded, [{ name: 'S24', model: 'SM-S928U', serial: S24 }]);
    assert.deepEqual(Object.keys(loaded[0]), ['name', 'model', 'serial']);
  } finally { s.cleanup(); }
});

test('loadQaDevices: the path is $HUB_QA_DEVICES, else the one under the home', () => {
  assert.equal(qaDevicesPath({ HUB_QA_DEVICES: '/x/qa.json' }, '/home/u'), '/x/qa.json');
  assert.equal(qaDevicesPath({}, '/home/u'), join('/home/u', QA_DEVICES_FILE));
});

test('loadQaDevices: a broken file throws HUB_QA_DEVICES naming the file and the entry, never a serial', () => {
  const s = scratch();
  try {
    const load = () => loadQaDevices({ env: { HUB_QA_DEVICES: s.file } });
    const cases = [
      ['{ not json ' + S24, /not valid JSON/],
      [JSON.stringify({ schema: 2, devices: [] }), /schema must be 1/],
      [JSON.stringify({ schema: 1, devices: {} }), /must be an array/],
      [JSON.stringify({ schema: 1, devices: [{ name: 'A', serial: S24 }, { name: 'B', serial: 'bad serial' + S24 }] }), /devices\[1\]\.serial/],
      [JSON.stringify({ schema: 1, devices: [{ serial: S24 }] }), /devices\[0\]\.name/],
    ];
    for (const [text, pattern] of cases) {
      writeFileSync(s.file, text);
      assert.throws(load, error => error.code === 'HUB_QA_DEVICES' && error.message.includes(s.file) && pattern.test(error.message) && !error.message.includes(S24), text);
    }
  } finally { s.cleanup(); }
});

test('lock.mjs name maps equal what the seed derives from devices.json', () => {
  const seeded = seed(loadDevices(), { qaDevices: none });
  assert.deepEqual([...DEPLOY_TARGETS], deployTargetLocks(seeded));
  assert.deepEqual({ ...SEED_RESOURCES }, Object.fromEntries(seeded.resources.filter(resource => resource.kind !== 'emulator-pool').map(resource => [resource.lock, resource.id])));
  for (const resource of seeded.resources) assert.equal(resourceOf(resource.lock), resource.id);
});

test('fleetOf is the seed\'s phones, and PHONE_POOL_SEED is frozen and is the fleet\'s device order', () => {
  const d = loadDevices();
  const fleet = fleetOf(d);
  assert.deepEqual(fleet, seed(d, { qaDevices: none }).resources.filter(resource => resource.kind === 'phone')
    .map(resource => ({ device: resource.id, lock: resource.lock, deploy: resource.deploy_target, name: resource.display_name, serial: resource.identity.serial, model: resource.identity.model })));
  assert.deepEqual(fleet.map(phone => Object.keys(phone)), fleet.map(() => ['device', 'lock', 'deploy', 'name', 'serial', 'model']));
  assert.ok(Object.isFrozen(PHONE_POOL_SEED));
  assert.deepEqual([...PHONE_POOL_SEED], fleet.map(phone => phone.device));
});

test('hermetic() points HUB_QA_DEVICES at an existing temp file, and the loader opens only that path', () => {
  const file = process.env.HUB_QA_DEVICES;
  assert.ok(file && existsSync(file) && file.startsWith(tmpdir()));
  const opened = [];
  const readFile = (path, encoding) => { opened.push(path); return '{"schema":1,"devices":[]}'; };
  assert.deepEqual(loadQaDevices({ env: process.env, readFile }), []);
  assert.deepEqual(opened, [file]);
  assert.ok(!opened.includes(join(homedir(), QA_DEVICES_FILE)));
});

test('a child process with HUB_QA_DEVICES set never reads the sentinel QA file under HOME; without it, it does', () => {
  const home = mkdtempSync(join(tmpdir(), 'seed-home-'));
  try {
    mkdirSync(join(home, '.config', 'mobile-deploy-hub'), { recursive: true });
    writeFileSync(join(home, QA_DEVICES_FILE), JSON.stringify({ schema: 1, devices: [{ name: 'Sentinel', serial: 'SENTINEL9', allowed_users: [7] }] }));
    const seedUrl = new URL('./seed.mjs', import.meta.url).href;
    const script = `import { seed } from ${JSON.stringify(seedUrl)}; import { loadDevices } from ${JSON.stringify(new URL('../ci/lib/devices.mjs', import.meta.url).href)}; console.log(JSON.stringify(seed(loadDevices())));`;
    const run = extra => {
      const env = { ...process.env, HOME: home, ...extra };
      if (!('HUB_QA_DEVICES' in extra)) delete env.HUB_QA_DEVICES;
      const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { env, encoding: 'utf8', cwd: tmpdir() });
      assert.equal(result.status, 0, result.stderr);
      return result.stdout;
    };
    const guarded = run({ HUB_QA_DEVICES: process.env.HUB_QA_DEVICES });
    assert.ok(!guarded.includes('SENTINEL9') && !guarded.includes('dedicated_qa'));
    const control = run({});
    assert.ok(control.includes('res-sentinel') && control.includes('dedicated_qa'), 'the control run sees the sentinel, so the guard is meaningful');
    assert.ok(!control.includes('allowed_users'));
  } finally { rmSync(home, { recursive: true, force: true }); }
});
