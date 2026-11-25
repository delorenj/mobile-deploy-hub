// Story 6.5: the Registry view is one pure projection: the exact served keys, their defaults, visibility, audience redaction and the
// Pool rows. It reads nothing and never mutates its input.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadDevices } from '../ci/lib/devices.mjs';
import { loadPolicy } from '../ci/lib/policy.mjs';
import { seed } from './seed.mjs';
import { AUDIENCES, RECORD_KEYS, viewPools, viewRecord } from './view.mjs';

const policy = loadPolicy().policy;
const SERIAL = 'R5CX31AEJDA';
const devices = () => structuredClone(loadDevices({}));
const qa = [{ name: 'S24', serial: SERIAL, allowed_users: [0, 10] }, { name: 'Pixel-QA', model: 'Pixel 7', serial: 'QAUNKNOWN1', allowed_users: [0] }];
const registry = () => seed(devices(), { qaDevices: () => qa });
const byId = (reg, id) => reg.resources.find(record => record.id === id);

test('a served record has exactly the documented keys with stable defaults, and drops words and display_name', () => {
  const reg = registry();
  const view = viewRecord(byId(reg, 's26'), { audience: 'local' });
  assert.deepEqual(Object.keys(view), [...RECORD_KEYS]);
  assert.deepEqual(view, {
    id: 's26', lock: 'adb', name: 's26', kind: 'phone', host: 'linux', identity: { serial: 'R5GL43A7PCH', model: 'SM-S948U' }, capabilities: {},
    deploy_target: true, seeded: true, seed_missing: false, created_at: null, retired_at: null, visibility: 'visible',
  });
  const ios = viewRecord(byId(reg, 'ios-lane'), { audience: 'local' });
  assert.equal('words' in ios, false);
  assert.equal('display_name' in ios, false);
  const bare = viewRecord({ id: 'x', lock: 'x' }, { audience: 'local' });
  assert.equal(viewRecord({ id: 'y', lock: 'y', created_at: '2026-11-25T10:00:00.000Z' }, {}).created_at, '2026-11-25T10:00:00.000Z');
  assert.deepEqual(bare, { id: 'x', lock: 'x', name: null, kind: null, host: null, identity: null, capabilities: {}, deploy_target: false, seeded: false, seed_missing: false, created_at: null, retired_at: null, visibility: 'visible' });
});

test('audience: local keeps QA values, service nulls serial, udid and adb_id and keeps the keys; allowed_users goes for both', () => {
  const reg = registry();
  const phone = byId(reg, 'res-pixel-qa');
  phone.identity.udid = 'U-1';
  phone.identity.adb_id = 'A-1';
  phone.identity.allowed_users = [0];
  phone.capabilities.allowed_users = [0];
  const local = viewRecord(phone, { audience: 'local' });
  assert.deepEqual(local.identity, { serial: 'QAUNKNOWN1', model: 'Pixel 7', udid: 'U-1', adb_id: 'A-1' });
  assert.equal('allowed_users' in local.capabilities, false);
  const service = viewRecord(phone, { audience: 'service' });
  assert.deepEqual(service.identity, { serial: null, model: 'Pixel 7', udid: null, adb_id: null });
  assert.deepEqual(service.capabilities, { dedicated_qa: true });
  const s24 = viewRecord(byId(reg, 's24'), { audience: 'service' });
  assert.deepEqual(s24.identity, { serial: null, model: 'SM-S928U' });
  // Not dedicated: the service sees the values.
  assert.equal(viewRecord(byId(reg, 's26'), { audience: 'service' }).identity.serial, 'R5GL43A7PCH');
  assert.deepEqual([...AUDIENCES], ['local', 'service']);
  assert.throws(() => viewRecord(phone, { audience: 'world' }), TypeError);
});

test('the input is never mutated', () => {
  const reg = registry();
  byId(reg, 'res-pixel-qa').identity.allowed_users = [0];
  const before = structuredClone(reg);
  viewRecord(byId(reg, 'res-pixel-qa'), { audience: 'service' });
  viewPools(reg, policy);
  assert.deepEqual(reg, before);
});

test('visibility: live is visible; retired or seed-missing is retiring when held or queued, else hidden (null)', () => {
  const reg = registry();
  const base = byId(reg, 's24');
  for (const mark of [{ retired_at: '2026-11-25T09:00:00.000Z' }, { seed_missing: true }]) {
    const record = { ...base, ...mark };
    assert.equal(viewRecord(record, {}), null);
    assert.equal(viewRecord(record, { held: true }).visibility, 'retiring');
    assert.equal(viewRecord(record, { queued: true }).visibility, 'retiring');
  }
  assert.equal(viewRecord(base, { held: true }).visibility, 'visible');
  assert.equal(viewRecord({ ...base, seed_missing: false }, {}).seed_missing, false);
  assert.equal(viewRecord({ ...base, retired_at: '2026-11-25T09:00:00.000Z' }, { held: true }).retired_at, '2026-11-25T09:00:00.000Z');
});

test('pools: stored order, a named Pool lists the matcher members, a gate Pool has none', () => {
  const reg = registry();
  assert.deepEqual(viewPools(reg, policy), [
    { name: 'phone', kind: 'named', members: ['s24', 's26'], gate: null },
    { name: 'emulator', kind: 'gate', members: [], gate: 'emulator' },
  ]);
  // The runtime QA phone is dedicated_qa, so the phone Pool does not list it; a plain runtime phone follows the seeded members.
  reg.resources.push({ id: 'res-plain', lock: 'res-plain', name: 'plain', kind: 'phone', host: 'linux', capabilities: {}, seeded: false, created_at: '2026-11-25T10:00:00.000Z' });
  assert.deepEqual(viewPools(reg, policy)[0].members, ['s24', 's26', 'res-plain']);
});

test('pools: every member retired is an empty list, not an error', () => {
  const reg = registry();
  for (const record of reg.resources) if (record.kind === 'phone') record.retired_at = '2026-11-25T09:00:00.000Z';
  assert.deepEqual(viewPools(reg, policy)[0], { name: 'phone', kind: 'named', members: [], gate: null });
  assert.deepEqual(viewPools({ resources: [], pools: {} }, policy), []);
});
