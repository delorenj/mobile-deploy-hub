// Story 10.2: the pure half of GET /history (tools/registry/history.mjs): the query check, the filter and its lock -> resource map, the
// cursor codec, the merge pick and the unreachable-range derivation. No fs, no clock, no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeCursor, encodeCursor, historyFilter, lockToResource, parseHistoryQuery, pickNext, unreachableRanges } from './history.mjs';

const registry = {
  resources: [
    { id: 's26', lock: 'adb', name: 's26', kind: 'phone', host: 'linux', seeded: true },
    { id: 's24', lock: 's24', name: 's24', kind: 'phone', host: 'linux', seeded: true },
    { id: 'ios-lane', lock: 'mac-ios', name: 'ipad', kind: 'ios-lane', host: 'mac', seeded: true },
    { id: 'emulator', lock: 'emulator', name: 'emulator', kind: 'emulator-pool', host: 'linux', seeded: true },
    { id: 'res-pixel', lock: 'res-pixel', name: 'pixel', kind: 'phone', host: 'linux', seeded: false },
  ],
  pools: { phone: { members: ['s24', 's26'], named: true }, emulator: { gate: 'emulator' } },
};
const q = (text = '') => parseHistoryQuery(new URLSearchParams(text));
const refused = (text, reason) => assert.throws(() => q(text), error => error.code === 'HUB_USAGE' && error.status === 400 && error.reason === reason, `${text} -> ${reason}`);
const T = '2026-11-20T10:00:00.000Z';
const ev = (extra = {}) => ({ format: 1, ts: T, host: 'h', host_id: 'H', event: 'acquire', lock: 'adb', claimant: { kind: 'agent', holder: 'bot', repo: null }, ...extra });
const keep = (text, event) => historyFilter(q(text), registry)(event);

test('parseHistoryQuery: defaults, every key, from inclusive to exclusive', () => {
  const none = q();
  assert.deepEqual({ ...none }, { resource: null, pool: null, claimant: null, repo: null, from: null, to: null, cursor: null, limit: 100 });
  const all = q('resource=s26&pool=phone&claimant=agent&repo=o%2Fa&from=2026-11-01T00:00:00Z&to=2026-11-30&limit=7');
  assert.equal(all.resource, 's26');
  assert.equal(all.repo, 'o/a');
  assert.equal(all.from, Date.parse('2026-11-01T00:00:00Z'));
  assert.equal(all.to, Date.parse('2026-11-30'));
  assert.equal(all.limit, 7);
  assert.equal(q('limit=1000').limit, 1000);
  assert.equal(q('from=2026-11-01T00:00:00Z&to=2026-11-01T00:00:00Z').from, q('from=2026-11-01T00:00:00Z&to=2026-11-01T00:00:00Z').to);
  assert.ok(parseHistoryQuery('limit=3').limit === 3, 'text works as well');
});

test('parseHistoryQuery: an unknown, repeated or empty key is bad-query', () => {
  refused('x=1', 'bad-query');
  refused('resource=a&resource=b', 'bad-query');
  refused('resource=', 'bad-query');
  refused('limit=', 'bad-query');
  refused(`repo=${'a'.repeat(300)}`, 'bad-query');
});

test('parseHistoryQuery: limit outside 1..1000 is bad-limit, a bad time or from after to is bad-range, a bad cursor is bad-cursor', () => {
  for (const limit of ['0', '1001', '-1', '1.5', 'x', '01', '10000']) refused(`limit=${limit}`, 'bad-limit');
  for (const text of ['from=yesterday', 'to=2026', 'from=2026-13-01', 'from=1700000000', 'from=2026-11-02T00:00:00Z&to=2026-11-01T00:00:00Z']) refused(text, 'bad-range');
  refused('cursor=!!', 'bad-cursor');
});

test('cursor: encode and decode round trip, keys in host order, and each bad cursor is refused', () => {
  const positions = { mac: { month: '2026-10', offset: 0 }, linux: { month: '2026-11', offset: 4096 } };
  const text = encodeCursor(positions);
  assert.deepEqual(JSON.parse(Buffer.from(text, 'base64url').toString()), { linux: '2026-11/4096', mac: '2026-10/0' });
  assert.deepEqual(decodeCursor(text), { linux: { month: '2026-11', offset: 4096 }, mac: { month: '2026-10', offset: 0 } });
  assert.equal(encodeCursor(decodeCursor(text)), text);
  assert.equal(q(`cursor=${text}`).cursor.mac.offset, 0);
  assert.deepEqual(decodeCursor(encodeCursor({})), {});
  const b64 = value => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64url');
  const bad = [
    '', 'not base64!', b64('nope'), b64('[]'), b64('null'), b64('"x"'),
    b64({ pi: '2026-11/0' }), b64({ linux: 5 }), b64({ linux: '2026-13/0' }), b64({ linux: '2026-11/01' }), b64({ linux: '2026-11/-1' }), b64({ linux: '2026-11/1.5' }),
    b64({ linux: '2026-11/99999999999999999999' }), b64({ linux: '2026-11' }), b64({ linux: '2026-11/0', extra: 1 }),
    b64({ mac: '2026-11/0', linux: '2026-11/0' }), b64('{"linux": "2026-11/0"}'), `${text}=`, 'A'.repeat(5000),
  ];
  for (const cursor of bad) assert.throws(() => decodeCursor(cursor), error => error.code === 'HUB_USAGE' && error.reason === 'bad-cursor', cursor.slice(0, 30));
});

test('lockToResource: the Registry by lock, then the lock-name rule', () => {
  const of = lockToResource(registry);
  assert.equal(of('adb'), 's26');
  assert.equal(of('mac-ios'), 'ios-lane');
  assert.equal(of('emulator-3'), 'emulator');
  assert.equal(of('res-pixel'), 'res-pixel');
  assert.equal(of('res-gone'), 'res-gone');
  assert.equal(of('s3-index'), null);
  assert.equal(of(null), null);
  assert.equal(lockToResource(null)('adb'), 's26');
});

test('filter by resource: the resource field, else a v1a lock; an id or a name', () => {
  assert.equal(keep('resource=s26', ev({ lock: 'adb' })), true, 'a v1a lock with no resource field');
  assert.equal(keep('resource=s26', ev({ lock: 'adb', resource: 's26' })), true);
  assert.equal(keep('resource=s26', ev({ lock: 's24', resource: 's24' })), false);
  assert.equal(keep('resource=s26', ev({ lock: null, resource: null })), false);
  assert.equal(keep('resource=pixel', ev({ lock: 'res-pixel', resource: 'res-pixel' })), true, 'a name');
  assert.equal(keep('resource=emulator', ev({ lock: 'emulator-2' })), true);
  assert.equal(keep('resource=ios-lane', ev({ lock: 'mac-ios' })), true);
});

test('filter by pool: members, the event\'s own pool, a gate Pool and the runtime phones', () => {
  assert.equal(keep('pool=phone', ev({ lock: 's24' })), true, 'a member');
  assert.equal(keep('pool=phone', ev({ lock: 'res-pixel', resource: 'res-pixel' })), true, 'a runtime phone is in the phone Pool');
  assert.equal(keep('pool=phone', ev({ lock: 'mac-ios' })), false);
  assert.equal(keep('pool=phone', ev({ lock: null, resource: null, pool: 'phone', request: 'r' })), true, 'event.pool');
  assert.equal(keep('pool=phone', ev({ lock: null, resource: null, pool: 'emulator' })), false);
  assert.equal(keep('pool=emulator', ev({ lock: 'emulator' })), true, 'a gate Pool: its lock');
  assert.equal(keep('pool=emulator', ev({ lock: 'emulator-1' })), true, 'a gate Pool: its slots');
  assert.equal(keep('pool=emulator', ev({ lock: 'adb' })), false);
  assert.equal(keep('pool=match:kind=phone', ev({ lock: null, resource: null, pool: 'match:kind=phone' })), true, 'an unknown Pool matches by event.pool only');
  assert.equal(keep('pool=match:kind=phone', ev({ lock: 'adb' })), false);
});

test('filter by claimant (kind or holder) and repo (claimant or delivery), ANDed with the rest', () => {
  assert.equal(keep('claimant=agent', ev()), true);
  assert.equal(keep('claimant=bot', ev()), true);
  assert.equal(keep('claimant=person', ev()), false);
  assert.equal(keep('claimant=deploy', ev({ claimant: { kind: 'deploy', holder: null, repo: 'o/a' } })), true);
  assert.equal(keep('claimant=agent', ev({ claimant: undefined })), false);
  assert.equal(keep('repo=o/a', ev({ claimant: { kind: 'deploy', repo: 'o/a' } })), true);
  assert.equal(keep('repo=o/a', ev({ delivery: { repo: 'o/a', run: '1', version: '1' } })), true);
  assert.equal(keep('repo=o/a', ev({ claimant: { kind: 'deploy', repo: 'o/b' } })), false);
  assert.equal(keep('resource=s26&claimant=agent&repo=o/a', ev({ claimant: { kind: 'agent', repo: 'o/a' } })), true);
  assert.equal(keep('resource=s26&claimant=agent&repo=o/a', ev({ claimant: { kind: 'agent', repo: 'o/b' } })), false);
  assert.equal(keep('', ev({ claimant: undefined, lock: undefined })), true, 'no filter keeps everything');
});

test('filter by time: from inclusive, to exclusive, an event with no ts is out when a bound is set', () => {
  const ms = Date.parse(T);
  assert.equal(keep(`from=${T}`, ev()), true);
  assert.equal(keep(`to=${T}`, ev()), false);
  assert.equal(keep('to=2026-11-20T10:00:00.001Z', ev()), true);
  assert.equal(keep('from=2026-11-20T10:00:00.001Z', ev()), false);
  assert.equal(keep('from=2026-01-01', ev({ ts: undefined })), false);
  assert.equal(keep('', ev({ ts: undefined })), true);
  assert.ok(ms > 0);
  assert.equal(historyFilter(q(), registry)(null), false);
});

test('pickNext: the smallest ts, a missing ts first, a tie to the earlier host, null when nothing is left', () => {
  assert.equal(pickNext([{ ts: 5 }, { ts: 3 }]), 1);
  assert.equal(pickNext([{ ts: 3 }, { ts: 5 }]), 0);
  assert.equal(pickNext([{ ts: 4 }, { ts: 4 }]), 0, 'a tie goes to the host key that comes first');
  assert.equal(pickNext([null, { ts: 9 }]), 1);
  assert.equal(pickNext([{ ts: 1 }, null]), 0);
  assert.equal(pickNext([{ ts: 1 }, { ts: null }]), 1, 'a missing ts sorts first');
  assert.equal(pickNext([{ ts: null }, { ts: 1 }]), 0);
  assert.equal(pickNext([{ ts: null }, { ts: null }]), 0);
  assert.equal(pickNext([{ ts: NaN }, { ts: 1 }]), 0);
  assert.equal(pickNext([null, null]), -1);
  assert.equal(pickNext([]), -1);
});

const at = iso => Date.parse(iso);
const reach = (to, ts, host = 'mac') => ({ event: 'host-reachability', host, from: null, to, ts });
const window = { from: null, to: at('2026-11-20T12:00:00Z') };

test('unreachableRanges: an open range runs to the window end, a closed one to its reachable event', () => {
  assert.deepEqual(unreachableRanges([reach('unreachable', '2026-11-20T10:00:00Z')], { own: 'linux', window }), [{ host: 'mac', from: '2026-11-20T10:00:00.000Z', to: '2026-11-20T12:00:00.000Z' }]);
  assert.deepEqual(
    unreachableRanges([reach('unreachable', '2026-11-20T10:00:00Z'), reach('reachable', '2026-11-20T11:00:00Z')], { own: 'linux', window }),
    [{ host: 'mac', from: '2026-11-20T10:00:00.000Z', to: '2026-11-20T11:00:00.000Z' }],
  );
  assert.deepEqual(unreachableRanges([], { own: 'linux', window }), []);
  assert.deepEqual(unreachableRanges([reach('reachable', '2026-11-20T10:00:00Z')], { own: 'linux', window }), [], 'a reachable with nothing open says nothing');
  assert.deepEqual(unreachableRanges([reach('unreachable', '2026-11-20T10:00:00Z', 'linux')], { own: 'linux', window }), [], 'this host is skipped');
  // A second unreachable while open does not move the start; an event that is not a host-reachability or has no ts is ignored.
  assert.deepEqual(
    unreachableRanges([reach('unreachable', '2026-11-20T10:00:00Z'), reach('unreachable', '2026-11-20T10:30:00Z'), { event: 'reachability', host: 'mac', to: 'unreachable', ts: T }, reach('unreachable', 'bad')], { own: 'linux', window }),
    [{ host: 'mac', from: '2026-11-20T10:00:00.000Z', to: '2026-11-20T12:00:00.000Z' }],
  );
});

test('unreachableRanges: two ranges in time order, ordered input or not', () => {
  const events = [reach('reachable', '2026-11-20T09:30:00Z'), reach('unreachable', '2026-11-20T11:00:00Z'), reach('unreachable', '2026-11-20T09:00:00Z')];
  assert.deepEqual(unreachableRanges(events, { own: 'linux', window }).map(range => range.from), ['2026-11-20T09:00:00.000Z', '2026-11-20T11:00:00.000Z']);
});

test('unreachableRanges: clipped by synced_through, by from and by the window end; a range the replica covers is none', () => {
  const closed = [reach('unreachable', '2026-11-20T10:00:00Z'), reach('reachable', '2026-11-20T11:00:00Z')];
  // Asleep, but synced after it came back: complete, no range.
  assert.deepEqual(unreachableRanges(closed, { own: 'linux', window, syncedThrough: { mac: at('2026-11-20T11:30:00Z') } }), []);
  // synced_through inside the range clips its start.
  assert.deepEqual(unreachableRanges(closed, { own: 'linux', window, syncedThrough: { mac: at('2026-11-20T10:20:00Z') } }), [{ host: 'mac', from: '2026-11-20T10:20:00.000Z', to: '2026-11-20T11:00:00.000Z' }]);
  assert.deepEqual(unreachableRanges(closed, { own: 'linux', window, syncedThrough: { mac: null } }).length, 1, 'null synced_through clips nothing');
  // from clips the start, the window end clips the end, and a range wholly outside is dropped.
  assert.deepEqual(unreachableRanges(closed, { own: 'linux', window: { from: at('2026-11-20T10:40:00Z'), to: at('2026-11-20T10:50:00Z') } }), [{ host: 'mac', from: '2026-11-20T10:40:00.000Z', to: '2026-11-20T10:50:00.000Z' }]);
  assert.deepEqual(unreachableRanges(closed, { own: 'linux', window: { from: at('2026-11-20T11:00:00Z'), to: at('2026-11-20T12:00:00Z') } }), []);
  assert.deepEqual(unreachableRanges(closed, { own: 'linux', window: { from: null, to: at('2026-11-20T09:00:00Z') } }), []);
  // An open range clipped at the request's end is empty when the failure came after it.
  assert.deepEqual(unreachableRanges([reach('unreachable', '2026-11-20T12:00:00Z')], { own: 'linux', window }), []);
});
