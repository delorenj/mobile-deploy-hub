// Story 10.4: the Lease view a service serves is redacted for a `dedicated_qa` Resource (AD-30: keys stay, values become null), the CLI's exports are not,
// and `serviceForceRelease` is the one force-release dispatch. Hermetic: temp lock and event dirs, hand-made `taken` values; no adb, no QA file.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireLease } from '../ci/lib/lock.mjs';
import { loadPolicy } from '../ci/lib/policy.mjs';
import { hermetic } from '../ci/test-fixtures.mjs';
import { createContext, leaseExports, leaseView, namesEmulatorSlot, serviceForceRelease, loadFleet } from './claims.mjs';

hermetic();

const SERIAL = 'QAPIXEL7777';
const ADB_ID = `adb-${SERIAL}-zz._adb-tls-connect._tcp`;
const taken = (device, lock = 'res-pixel-qa') => ({
  kind: 'phone',
  lease: { lease_id: 'qa-1', holder: 'agent-a', why: 'proof', claimant_kind: 'agent', started_at: '2026-11-26T10:00:00.000Z', expires_at: '2026-11-26T11:00:00.000Z' },
  phone: { device: lock, lock },
  device,
});
const connected = { phone: 'res-pixel-qa', serial: SERIAL, adb_id: ADB_ID, adb_port: 5037 };

test('leaseView for a dedicated_qa Resource: ANDROID_SERIAL and every env value equal to the adb id are null, the keys stay, nothing else changes', () => {
  const plain = leaseView(taken(connected));
  assert.equal(plain.env.ANDROID_SERIAL, ADB_ID, 'with no qaIds the view keeps today\'s values (the CLI)');
  for (const qaIds of [new Set(['res-pixel-qa']), ['res-pixel-qa']]) {
    const view = leaseView(taken(connected), { qaIds });
    assert.deepEqual(Object.keys(view.env), Object.keys(plain.env), 'the keys stay');
    assert.equal(view.env.ANDROID_SERIAL, null);
    assert.deepEqual({ ...view, env: null }, { ...plain, env: null }, 'only env differs');
    assert.equal(view.env.HUB_LEASE_ID, 'qa-1');
    assert.equal(view.env.ANDROID_ADB_SERVER_PORT, '5037');
    assert.equal(JSON.stringify(view).includes(SERIAL), false);
  }
  // Any other env key a Claimant's --env-serial names carries the adb id too: it is nulled with it.
  const exported = leaseExports(taken(connected), ['MY_SERIAL'], { qaIds: ['res-pixel-qa'], resource: 'res-pixel-qa' });
  assert.deepEqual([exported.ANDROID_SERIAL, exported.MY_SERIAL], [null, null]);
  assert.equal(leaseExports(taken(connected), ['MY_SERIAL']).MY_SERIAL, ADB_ID);
});

test('leaseView for a Resource that is not dedicated_qa keeps the adb id, whatever other Resources are in qaIds', () => {
  const view = leaseView(taken({ ...connected, phone: 's26' }, 'adb'), { qaIds: new Set(['res-pixel-qa', 's24']) });
  assert.equal(view.env.ANDROID_SERIAL, ADB_ID);
  assert.equal(view.resource, 's26');
  assert.equal(leaseView(taken(connected), { qaIds: new Set() }).env.ANDROID_SERIAL, ADB_ID, 'an empty set marks nothing');
});

test('a lock-only Lease (no adb id) has no ANDROID_SERIAL key at all, QA or not', () => {
  const lockOnly = taken({ phone: 'res-pixel-qa', serial: null, adb_id: null, adb_port: 5037 });
  assert.equal('ANDROID_SERIAL' in leaseView(lockOnly, { qaIds: ['res-pixel-qa'] }).env, false);
  assert.equal('ANDROID_SERIAL' in leaseView(lockOnly).env, false);
});

function scratch() {
  const root = mkdtempSync(join(tmpdir(), 'lease-view-'));
  const env = { PATH: process.env.PATH, HOME: root, HUB_LOCK_DIR: join(root, 'locks'), HUB_EVENT_DIR: join(root, 'events') };
  const ctx = createContext({ env, policy: loadPolicy().policy, qaDevices: () => [], fleet: loadFleet(env, { warn: () => {} }) });
  return { env, ctx, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
const actor = { holder: 'ops', via: 'api' };

test('serviceForceRelease: a Lease id goes to forceReleaseLease (answered at once), a slot id to forceReleaseEmulator (a promise)', async () => {
  assert.equal(namesEmulatorSlot('emulator-1'), true);
  assert.equal(namesEmulatorSlot('a-1'), false);
  const s = scratch();
  try {
    await acquireLease('s24', { holder: 'agent-a', why: 'proof', forMs: 600_000, id: 'a-1', env: s.env, log: () => {} });
    const answer = serviceForceRelease('a-1', { why: 'stuck', actor }, s.ctx);
    assert.ok(!(answer instanceof Promise), 'a Lease force-release is synchronous, as it was');
    assert.deepEqual([answer.lease_id, answer.outcome, answer.resource, answer.holder, answer.why], ['a-1', 'force-released', 's24', 'agent-a', 'stuck']);
    assert.throws(() => serviceForceRelease('ghost', { why: 'stuck', actor }, s.ctx), error => error.code === 'HUB_LEASE_NOT_FOUND' && error.reason === 'unknown');
    // A slot id is the emulator's own path: a slot out of range is its `bad-slot`, a free slot holds nothing.
    const bad = serviceForceRelease('emulator-99', { why: 'stuck', actor }, s.ctx);
    assert.ok(bad instanceof Promise);
    await assert.rejects(bad, error => error.code === 'HUB_USAGE' && error.reason === 'bad-slot');
    await assert.rejects(serviceForceRelease('emulator-1', { why: 'stuck', actor }, s.ctx), error => error.code === 'HUB_LEASE_NOT_FOUND' && error.reason === 'unknown');
  } finally { s.cleanup(); }
});
