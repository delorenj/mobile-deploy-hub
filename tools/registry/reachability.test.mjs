// Reachability (AD-35): the one enum, one mapper per transport, and readings whose age is told on the reader's clock. Pure tables:
// no adb, no devicectl, no clock but the one each case passes in.
import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectIpad, pickIpad } from '../ci/lib/devicectl.mjs';
import { MISSING, REACHABILITY, ipadReachability, isReachability, phoneReachability, present, readIpad, stamp } from './reachability.mjs';

const UDID = '00008112-000138390CFB401E';
const MODEL = 'iPad14,5';

const record = (patch = {}) => {
  const base = {
    identifier: 'IPAD-ID',
    hardwareProperties: { udid: UDID, reality: 'physical', productType: MODEL },
    connectionProperties: { pairingState: 'paired', transportType: 'wired', tunnelState: 'connected' },
    deviceProperties: { name: 'iPad', osVersionNumber: '26.1', developerModeStatus: 'enabled', bootState: 'booted' },
  };
  return { ...base, ...Object.fromEntries(Object.entries(patch).map(([key, value]) => [key, value === undefined ? undefined : { ...base[key], ...value }])) };
};
const document = (...devices) => ({ result: { devices } });
const read = (...devices) => readIpad({ list: () => document(...devices), udid: UDID, model: MODEL });

test('the enum is five frozen words, and only they are Reachability', () => {
  assert.ok(Object.isFrozen(REACHABILITY));
  assert.deepEqual(Object.values(REACHABILITY).sort(), ['absent', 'offline', 'reachable', 'unauthorized', 'unknown']);
  for (const word of Object.values(REACHABILITY)) assert.ok(isReachability(word), word);
  for (const word of ['device', 'online', 'no adb server', '', null, undefined]) assert.equal(isReachability(word), false, String(word));
});

test('the phone mapper: device is reachable, unauthorized and offline say themselves, not listed is absent, anything else is unknown', () => {
  const table = [
    ['device', 'reachable'], ['unauthorized', 'unauthorized'], ['offline', 'offline'], [null, 'absent'],
    ['no adb server', 'unknown'], ['adb did not answer', 'unknown'], ['recovery', 'unknown'], ['bootloader', 'unknown'], ['no', 'unknown'], ['', 'unknown'], [undefined, 'unknown'],
  ];
  for (const [observed, expected] of table) assert.equal(phoneReachability(observed), expected, String(observed));
});

test('the iPad mapper reads the record the way pickIpad does: not listed, unproven, unpaired, Developer Mode, boot state', async () => {
  const table = [
    ['a booted, paired, proven iPad is reachable', [record()], 'reachable'],
    ['no bootState is not offline', [record({ deviceProperties: { bootState: undefined } })], 'reachable'],
    ['bootState booted', [record({ deviceProperties: { bootState: 'booted' } })], 'reachable'],
    ['a bootState that is not booted is offline', [record({ deviceProperties: { bootState: 'shutdown' } })], 'offline'],
    ['UDID not listed', [], 'absent'],
    ['another iPad listed, not this one', [record({ hardwareProperties: { udid: 'OTHER' } })], 'absent'],
    ['listed twice is not one record', [record(), record()], 'absent'],
    ['listed without live hardware details is unknown', [record({ hardwareProperties: { reality: undefined, productType: undefined } })], 'unknown'],
    ['listed without details but the right model is unknown', [record({ hardwareProperties: { reality: undefined } })], 'unknown'],
    ['unproven and offline stays unknown (nothing was proven)', [record({ hardwareProperties: { reality: undefined, productType: undefined }, deviceProperties: { bootState: 'shutdown' } })], 'unknown'],
    ['unpaired is unauthorized', [record({ connectionProperties: { pairingState: 'unpaired' } })], 'unauthorized'],
    ['unpaired in an unproven record is unauthorized', [record({ hardwareProperties: { reality: undefined, productType: undefined }, connectionProperties: { pairingState: 'unpaired' } })], 'unauthorized'],
    ['Developer Mode off is unauthorized', [record({ deviceProperties: { developerModeStatus: 'disabled' } })], 'unauthorized'],
    ['a wrong model is unknown', [record({ hardwareProperties: { productType: 'iPad13,1' } })], 'unknown'],
    ['a simulated device is unknown', [record({ hardwareProperties: { reality: 'virtual' } })], 'unknown'],
  ];
  for (const [name, devices, expected] of table) assert.equal(await read(...devices), expected, name);
});

test('a devicectl failure or timeout, or a bad answer, is unknown; an error without a reason is unknown', async () => {
  for (const failure of [new Error('devicectl list devices did not succeed (failed)'), Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }), new Error('devicectl list devices wrote no JSON result')]) {
    assert.equal(await readIpad({ list: () => { throw failure; }, udid: UDID, model: MODEL }), 'unknown', failure.message);
    assert.equal(await readIpad({ list: () => Promise.reject(failure), udid: UDID, model: MODEL }), 'unknown');
    assert.equal(ipadReachability({ error: failure }), 'unknown');
  }
  assert.equal(await readIpad({ list: () => null, udid: UDID, model: MODEL }), 'absent', 'an empty document lists nothing');
  assert.equal(ipadReachability({}), 'unknown');
  assert.equal(ipadReachability(), 'unknown');
  assert.equal(ipadReachability({ result: null }), 'unknown');
  assert.equal(ipadReachability({ error: Object.assign(new Error('x'), { reason: 'something-new' }) }), 'unknown');
});

test('the iPad verdict never reads tunnelState: records that differ only in it map the same', async () => {
  for (const tunnel of ['connected', 'disconnected', 'unavailable', undefined, 'bogus']) {
    assert.equal(await read(record({ connectionProperties: { tunnelState: tunnel } })), 'reachable', String(tunnel));
    assert.equal(await read(record({ connectionProperties: { tunnelState: tunnel }, deviceProperties: { bootState: 'shutdown' } })), 'offline', String(tunnel));
  }
});

test('inspectIpad is pickIpad plus proven and boot_state, and its errors keep their text and gain a reason', () => {
  const good = document(record());
  const inspected = inspectIpad(good, { udid: UDID, model: MODEL });
  const { proven, boot_state: bootState, ...rest } = inspected;
  assert.deepEqual([proven, bootState], [true, 'booted']);
  assert.deepEqual(pickIpad(good, { udid: UDID, model: MODEL }), rest, 'pickIpad is inspectIpad minus the two extra keys');
  assert.deepEqual(Object.keys(pickIpad(good, { udid: UDID, model: MODEL })), ['identifier', 'name', 'os', 'transport', 'tunnel']);
  assert.equal(inspectIpad(document(record({ hardwareProperties: { reality: undefined, productType: undefined } })), { udid: UDID, model: MODEL }).proven, false);
  assert.equal(inspectIpad(document(record({ deviceProperties: { bootState: undefined } })), { udid: UDID, model: MODEL }).boot_state, null);
  const cases = [
    [document(), 'not-listed'],
    [document(record({ hardwareProperties: { productType: 'iPad13,1' } })), 'identity'],
    [document(record({ connectionProperties: { pairingState: 'unpaired' } })), 'unpaired'],
    [document(record({ deviceProperties: { developerModeStatus: 'disabled' } })), 'developer-mode'],
  ];
  for (const [doc, reason] of cases) {
    let inspectError;
    let pickError;
    try { inspectIpad(doc, { udid: UDID, model: MODEL }); } catch (error) { inspectError = error; }
    try { pickIpad(doc, { udid: UDID, model: MODEL }); } catch (error) { pickError = error; }
    assert.equal(inspectError.reason, reason);
    assert.equal(pickError.message, inspectError.message, 'the message is byte-identical');
    assert.deepEqual(Object.keys(pickError).sort(), ['reason'], 'an error gains only an additive reason');
  }
});

test('stamp refuses a state outside the enum and stores the age at receipt on the reader\'s clock', () => {
  assert.throws(() => stamp('device', { checkedAt: 1, receivedAt: 1 }), /not a Reachability/);
  assert.throws(() => stamp('stale', { checkedAt: 1, receivedAt: 1 }), /not a Reachability/);
  assert.throws(() => stamp('reachable', { checkedAt: 1 }), /receivedAt/);
  assert.throws(() => stamp('reachable', { checkedAt: 1, receivedAt: 1, ageMsAtReceipt: -1 }), /ageMsAtReceipt/);
  assert.throws(() => stamp('reachable', { checkedAt: 'soon', receivedAt: 1 }), /not a time/);
  const T = Date.parse('2026-11-25T10:00:00.000Z');
  assert.deepEqual(stamp('reachable', { checkedAt: T, receivedAt: T }), { state: 'reachable', checked_at: '2026-11-25T10:00:00.000Z', age_ms_at_receipt: 0, received_at: T });
  assert.deepEqual(stamp('offline', { checkedAt: '2026-11-25T09:59:00.000Z', receivedAt: T, ageMsAtReceipt: 60_000 }).checked_at, '2026-11-25T09:59:00.000Z');
});

test('present tells the age on the reader\'s clock and derives stale; it is never stored', () => {
  const T = Date.parse('2026-11-25T10:00:00.000Z');
  const stored = stamp('reachable', { checkedAt: T, receivedAt: T });
  assert.deepEqual(present(stored, { now: T, maxAgeS: 60 }), { state: 'reachable', checked_at: '2026-11-25T10:00:00.000Z', age_ms: 0, stale: false });
  assert.equal(present(stored, { now: T + 60_000, maxAgeS: 60 }).stale, false, 'exactly the limit is still current');
  assert.deepEqual([present(stored, { now: T + 60_001, maxAgeS: 60 }).age_ms, present(stored, { now: T + 60_001, maxAgeS: 60 }).stale], [60_001, true], 'one millisecond over is stale, and shown with its age');
  assert.equal(present(stored, { now: T + 60_001, maxAgeS: 60 }).state, 'reachable', 'a stale reading keeps its state; it is shown with its age, not hidden');
  assert.deepEqual(Object.keys(stored), ['state', 'checked_at', 'age_ms_at_receipt', 'received_at'], 'no stale flag is stored');
  // A reading that came from another host already aged 30 s when it arrived; the sender's clock (checked_at) plays no part.
  const relayed = stamp('reachable', { checkedAt: T - 3_600_000, receivedAt: T, ageMsAtReceipt: 30_000 });
  assert.equal(present(relayed, { now: T, maxAgeS: 60 }).age_ms, 30_000);
  assert.equal(present(relayed, { now: T + 10_000, maxAgeS: 60 }).age_ms, 40_000);
  assert.equal(present(relayed, { now: T + 30_001, maxAgeS: 60 }).stale, true);
  // A skewed received_at (the reader's own earlier clock reading) cannot make an age negative.
  assert.equal(present(stamp('reachable', { checkedAt: T, receivedAt: T + 5000 }), { now: T, maxAgeS: 60 }).age_ms, 0);
});

test('a missing reading, an unavailable limit and a bad limit are all stale and never current', () => {
  const T = 1_000_000;
  const stored = stamp('reachable', { checkedAt: T, receivedAt: T });
  assert.deepEqual(MISSING, { state: 'unknown', checked_at: null, age_ms: null, stale: true });
  assert.ok(Object.isFrozen(MISSING));
  for (const nothing of [null, undefined, {}, { state: 'reachable' }, { state: 'device', received_at: 1, age_ms_at_receipt: 0 }]) {
    assert.deepEqual(present(nothing, { now: T, maxAgeS: 60 }), MISSING);
  }
  assert.notEqual(present(null, { now: T, maxAgeS: 60 }), MISSING, 'every row gets its own object');
  for (const limit of [undefined, null, 0, -1, 1.5, '60', NaN, Infinity]) assert.equal(present(stored, { now: T, maxAgeS: limit }).stale, true, `limit ${String(limit)}`);
  assert.equal(present(stored, { now: T }).stale, true);
});
