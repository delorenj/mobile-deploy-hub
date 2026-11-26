// Story 10.3: the pure half of GET /utilisation (tools/registry/history.mjs): the query check, the incremental fold and the shares. Every expected
// number is hand-computed from the fixture below (minutes before T), never read back from the code.
import test from 'node:test';
import assert from 'node:assert/strict';
import { UTILISATION_CLASSES, createTimeline, foldEvent, lockToResource, mergeTimelines, parseUtilisationQuery, sharesOf, utilisation } from './history.mjs';

const T = Date.parse('2026-11-26T12:00:00.000Z');
const MIN = 60_000;
const at = minutes => T + minutes * MIN;
const iso = ms => new Date(ms).toISOString();
const WINDOW = { from: at(-60), to: T };

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

// One Event Log event `minutes` from T. `extra` fills or overrides.
const ev = (minutes, event, extra = {}) => ({ format: 1, ts: iso(at(minutes)), host: 'h', host_id: 'H', event, ...extra });
const track = (minutes, resource, to) => ev(minutes, 'reachability', { resource, from: null, to, checked_at: iso(at(minutes)), reason: 'track' });
const probe = (minutes, resource, to) => ev(minutes, 'reachability', { resource, from: null, to, checked_at: iso(at(minutes)), reason: 'probe' });
const hold = (minutes, event, lock, extra = {}) => ev(minutes, event, { lock, resource: undefined, hold_kind: 'lease', lease_id: 'l-1', expires_at: null, held_ms: null, ...extra });
const reservation = (minutes, event, lock, extra = {}) => ev(minutes, event, { lock, hold_kind: 'reservation', run_key: 'o--a--1', reserved_at: iso(at(-50)), expires_at: iso(at(-10)), ...extra });

const run = (events, options = {}, window = WINDOW) => utilisation(events, registry, lockToResource(registry), window, options);
const row = (answer, id) => answer.resources.find(entry => entry.id === id);
const ms = (row2, expected) => assert.deepEqual({ ...row2.ms }, { held: 0, idle_while_reserved: 0, idle: 0, away: 0, unknown: 0, ...expected });
const m = minutes => minutes * MIN;

test('no events: every Resource is all unknown, the slots all idle, the Pool row their sum', () => {
  const answer = run([], { slots: ['emulator-1', 'emulator-2'] });
  assert.equal(answer.window_ms, m(60));
  assert.deepEqual(answer.resources.map(entry => entry.id), ['s26', 's24', 'ios-lane', 'emulator', 'res-pixel']);
  for (const id of ['s26', 's24', 'ios-lane', 'res-pixel']) {
    ms(row(answer, id), { unknown: m(60) });
    assert.equal(row(answer, id).span_ms, m(60));
    assert.deepEqual({ ...row(answer, id).shares }, { held: 0, idle_while_reserved: 0, idle: 0, away: 0, unknown: 1 });
  }
  assert.deepEqual(answer.slots.map(slot => [slot.resource, slot.slot, slot.span_ms]), [['emulator', 'emulator-1', m(60)], ['emulator', 'emulator-2', m(60)]]);
  for (const slot of answer.slots) ms(slot, { idle: m(60) });
  ms(row(answer, 'emulator'), { idle: m(120) });
  assert.equal(row(answer, 'emulator').span_ms, m(120));
  assert.equal(row(answer, 'emulator').shares.idle, 1);
});

test('rows carry id, name, kind, host and the numbers only (no identity)', () => {
  const answer = run([]);
  assert.deepEqual(Object.keys(row(answer, 's26')), ['id', 'name', 'kind', 'host', 'span_ms', 'ms', 'shares']);
  assert.deepEqual(Object.keys(row(answer, 's26').ms), UTILISATION_CLASSES);
  assert.deepEqual(Object.keys(row(answer, 's26').shares), UTILISATION_CLASSES);
});

test('sparse: one probe reachable 30 minutes ago with a 60 s max age is 60 s idle and the rest unknown', () => {
  const answer = run([probe(-30, 's26', 'reachable')], { maxAgeS: 60 });
  ms(row(answer, 's26'), { idle: 60_000, unknown: m(60) - 60_000 });
  assert.equal(row(answer, 's26').shares.idle, 60_000 / m(60));
  // The default max age is the policy's 60 s.
  ms(row(run([probe(-30, 's26', 'reachable')]), 's26'), { idle: 60_000, unknown: m(60) - 60_000 });
});

test('a probe holds until its max age, a track reading until the next reachability event, and the first reading starts the Resource\'s time', () => {
  // Track: reachable from -40 to -20, offline from -20: unknown before the first reading.
  ms(row(run([track(-40, 's26', 'reachable'), track(-20, 's26', 'offline')]), 's26'), { unknown: m(20), idle: m(20), away: m(20) });
  // Probes: each holds 10 minutes (600 s) and no longer; `absent` is away.
  const answer = run([probe(-50, 's26', 'reachable'), probe(-30, 's26', 'absent'), probe(-5, 's26', 'unauthorized')], { maxAgeS: 600 });
  ms(row(answer, 's26'), { idle: m(10), away: m(10) + m(5), unknown: m(60) - m(25) });
  // A newer reading cuts an older probe short.
  ms(row(run([probe(-50, 's26', 'reachable'), track(-45, 's26', 'offline')], { maxAgeS: 600 }), 's26'), { unknown: m(10), idle: m(5), away: m(45) });
  // A reading of `unknown` is unknown.
  ms(row(run([track(-50, 's26', 'reachable'), track(-30, 's26', 'unknown')]), 's26'), { unknown: m(10) + m(30), idle: m(20) });
});

test('track-lost: idle until it, unknown after', () => {
  const lost = ev(-30, 'reachability', { resource: 's26', from: 'reachable', to: 'unknown', checked_at: null, reason: 'track-lost' });
  ms(row(run([track(-60, 's26', 'reachable'), lost]), 's26'), { idle: m(30), unknown: m(30) });
  // A reading after it starts a new run of time.
  ms(row(run([track(-60, 's26', 'reachable'), lost, track(-10, 's26', 'reachable')]), 's26'), { idle: m(30) + m(10), unknown: m(20) });
});

test('rich: reservation, job hold, lease with an extend and a release, readings, back-filled and reclaimed holds, two slots', () => {
  const events = [
    // s26 (lock adb): idle from -60; reserved -50..-30; a deploy job holds -40..-30; a Lease -25..-10 (extended); offline from -8.
    track(-60, 's26', 'reachable'),
    reservation(-50, 'claim', 'adb', { claimant: { kind: 'deploy' } }),
    hold(-40, 'acquire', 'adb', { hold_kind: 'job', lease_id: null }),
    hold(-30, 'release', 'adb', { hold_kind: 'job', lease_id: null, held_ms: m(10), reason: 'done' }),
    reservation(-30, 'release', 'adb', { held_ms: m(20), reason: 'done' }),
    hold(-25, 'acquire', 'adb', { expires_at: iso(at(-15)) }),
    hold(-20, 'extend', 'adb', { expires_at: iso(at(-5)) }),
    hold(-10, 'release', 'adb', { held_ms: m(15), reason: 'by-id' }),
    track(-8, 's26', 'offline'),
    // s24: a Lease from -40 that died; the reclaim at -20 says it held 5 minutes (it expired at -35).
    track(-60, 's24', 'reachable'),
    hold(-40, 'acquire', 's24', { lease_id: 'l-2', expires_at: iso(at(-35)) }),
    hold(-20, 'reclaim', 's24', { lease_id: 'l-2', held_ms: m(5), reason: 'expired' }),
    // res-pixel: a close with no open hold back-fills the held time; a Reservation close with no claim back-fills from its reserved_at.
    hold(-30, 'release', 'res-pixel', { lease_id: 'l-3', held_ms: m(10) }),
    reservation(-10, 'expiry', 'res-pixel', { run_key: 'o--b--2', reserved_at: iso(at(-20)), expires_at: iso(at(-5)), reason: 'ceiling' }),
    // The emulator: the gate lock is no Hold, slot 1 is held -40..-30, slot 2 never.
    hold(-45, 'acquire', 'emulator', { lease_id: null }),
    hold(-40, 'acquire', 'emulator-1', { lease_id: 'e-1' }),
    hold(-30, 'release', 'emulator-1', { lease_id: 'e-1', held_ms: m(10) }),
  ];
  const answer = run(events, { slots: ['emulator-1', 'emulator-2'] });
  ms(row(answer, 's26'), { idle: m(10) + m(5) + m(2), idle_while_reserved: m(10), held: m(10) + m(15), away: m(8) });
  ms(row(answer, 's24'), { held: m(5), idle: m(55) });
  ms(row(answer, 'res-pixel'), { held: m(10), idle_while_reserved: m(10), unknown: m(40) });
  ms(row(answer, 'ios-lane'), { unknown: m(60) });
  ms(answer.slots[0], { held: m(10), idle: m(50) });
  ms(answer.slots[1], { idle: m(60) });
  ms(row(answer, 'emulator'), { held: m(10), idle: m(110) });
  assert.equal(row(answer, 'emulator').span_ms, m(120));
  // Shares are ms / span, unrounded, and every row adds up to its span.
  assert.equal(row(answer, 's26').shares.held, m(25) / m(60));
  assert.equal(row(answer, 'emulator').shares.held, m(10) / m(120));
  for (const entry of [...answer.resources, ...answer.slots]) assert.equal(Object.values(entry.ms).reduce((sum, value) => sum + value, 0), entry.span_ms, entry.id ?? entry.slot);
});

test('an open Hold counts until its expiry (as extended) or the window\'s end; a job\'s has no expiry', () => {
  ms(row(run([track(-60, 's26', 'reachable'), hold(-30, 'acquire', 'adb', { expires_at: iso(at(-20)) })]), 's26'), { idle: m(50), held: m(10) });
  ms(row(run([track(-60, 's26', 'reachable'), hold(-30, 'acquire', 'adb', { expires_at: iso(at(-20)) }), hold(-25, 'extend', 'adb', { expires_at: iso(at(-10)) })]), 's26'), { idle: m(40), held: m(20) });
  ms(row(run([track(-60, 's26', 'reachable'), hold(-30, 'acquire', 'adb', { hold_kind: 'job', lease_id: null })]), 's26'), { idle: m(30), held: m(30) });
  // An open Reservation counts until its ceiling.
  ms(row(run([track(-60, 's26', 'reachable'), reservation(-30, 'claim', 'adb', { reserved_at: iso(at(-30)), expires_at: iso(at(-15)) })]), 's26'), { idle: m(45), idle_while_reserved: m(15) });
});

test('a close takes min(ts, start + held_ms); a force-release is a close; a v1a event with no `resource` counts for its lock\'s Resource', () => {
  // The release lands 40 minutes after the acquire but held_ms says 10.
  ms(row(run([track(-60, 's26', 'reachable'), hold(-50, 'acquire', 'adb'), hold(-10, 'force-release', 'adb', { held_ms: m(10) })]), 's26'), { held: m(10), idle: m(50) });
  // v1a: lock only, no `resource` key at all.
  const v1a = [{ format: 1, ts: iso(at(-30)), event: 'acquire', lock: 'adb', hold_kind: 'lease', lease_id: 'l-9' }, { format: 1, ts: iso(at(-20)), event: 'release', lock: 'adb', hold_kind: 'lease', lease_id: 'l-9', held_ms: m(10) }];
  ms(row(run(v1a), 's26'), { held: m(10), unknown: m(50) });
});

test('a close logged after the next holder\'s acquire never ends the new Hold; a reclaim with hold_kind null still ends the open one', () => {
  // lock.mjs removes the lock before it logs the release, so B's acquire (-30) can land in the log before A's release (-31): fold in log order.
  const raced = [track(-60, 's26', 'reachable'), hold(-50, 'acquire', 'adb'), hold(-30, 'acquire', 'adb', { lease_id: 'l-2', expires_at: iso(at(-10)) }), hold(-31, 'release', 'adb', { held_ms: m(19) })];
  const timeline = createTimeline();
  for (const event of raced) foldEvent(timeline, event);
  // A runs -50 to -30 (ended by B's acquire), B -30 to its expiry at -10.
  ms(row(sharesOf(timeline, registry, lockToResource(registry), WINDOW), 's26'), { idle: m(20), held: m(40) });
  // An unreadable owner's reclaim (hold_kind null, held_ms null) closes the open job Hold at its ts.
  const reclaimed = [track(-60, 's26', 'reachable'), hold(-40, 'acquire', 'adb', { hold_kind: 'job', lease_id: null }), hold(-25, 'reclaim', 'adb', { hold_kind: null, lease_id: null })];
  ms(row(run(reclaimed), 's26'), { idle: m(45), held: m(15) });
});

test('Mac gap: the ios-lane Lease is held until synced_through and unknown after; a host with no synced_through is unknown throughout', () => {
  const events = [track(-60, 'ios-lane', 'reachable'), hold(-50, 'acquire', 'mac-ios', { expires_at: iso(at(60)) })];
  const answer = run(events, { syncedThrough: { linux: T, mac: at(-30) } });
  ms(row(answer, 'ios-lane'), { idle: m(10), held: m(20), unknown: m(30) });
  // Hosts are told apart: s26 is on linux and unaffected.
  ms(row(run([track(-60, 's26', 'reachable')], { syncedThrough: { linux: T, mac: at(-30) } }), 's26'), { idle: m(60) });
  ms(row(run(events, { syncedThrough: { linux: T, mac: null } }), 'ios-lane'), { unknown: m(60) });
  // Slots are on the Pool's host.
  ms(run([], { slots: ['emulator-1'], syncedThrough: { linux: at(-30) } }).slots[0], { idle: m(30), unknown: m(30) });
});

test('Reservations are folded per (lock, run key): two runs\' claims overlap and each closes on its own', () => {
  const events = [
    track(-60, 's26', 'reachable'),
    reservation(-50, 'claim', 'adb', { run_key: 'o--a--1', reserved_at: iso(at(-50)), expires_at: iso(at(-10)) }),
    reservation(-45, 'claim', 'adb', { run_key: 'o--b--2', reserved_at: iso(at(-45)), expires_at: iso(at(-10)) }),
    reservation(-40, 'release', 'adb', { run_key: 'o--a--1', reserved_at: iso(at(-50)), expires_at: iso(at(-10)) }),
    reservation(-30, 'force-release', 'adb', { run_key: 'o--b--2', reserved_at: iso(at(-45)), expires_at: iso(at(-10)) }),
  ];
  ms(row(run(events), 's26'), { idle: m(40), idle_while_reserved: m(20) });
});

test('only the part of the window counts; a Resource retired before it is left out, one retired inside it stays', () => {
  const late = { from: at(-30), to: at(-10) };
  ms(row(run([track(-60, 's26', 'reachable'), hold(-40, 'acquire', 'adb', { expires_at: iso(at(-20)) })], {}, late), 's26'), { held: m(10), idle: m(10) });
  assert.equal(run([], {}, late).window_ms, m(20));
  const retired = { ...registry, resources: [...registry.resources, { id: 'res-old', lock: 'res-old', name: 'old', kind: 'phone', host: 'linux', retired_at: iso(at(-90)) }, { id: 'res-new', lock: 'res-new', name: 'new', kind: 'phone', host: 'linux', retired_at: iso(at(-20)) }, { id: 'res-gone', lock: 'res-gone', name: 'gone', kind: 'phone', host: 'linux', seed_missing: true }] };
  // A seed-missing record with no retired_at is not live, so it has no row.
  assert.deepEqual(utilisation([], retired, lockToResource(retired), WINDOW).resources.map(entry => entry.id), ['s26', 's24', 'ios-lane', 'emulator', 'res-pixel', 'res-new']);
});

test('the fold is incremental: folding in two steps, or from two hosts merged, gives the answer of folding all at once', () => {
  const events = [track(-60, 's26', 'reachable'), hold(-50, 'acquire', 'adb', { expires_at: iso(at(-5)) }), hold(-40, 'extend', 'adb', { expires_at: iso(at(-30)) }), hold(-35, 'release', 'adb', { held_ms: m(15) }), track(-20, 's26', 'absent')];
  const whole = run(events);
  const timeline = createTimeline();
  for (const event of events.slice(0, 2)) foldEvent(timeline, event);
  const half = structuredClone([...timeline.open]);
  for (const event of events.slice(2)) foldEvent(timeline, event);
  assert.equal(half.length, 1);
  assert.deepEqual(sharesOf(timeline, registry, lockToResource(registry), WINDOW), whole);
  // Two hosts' timelines (disjoint locks and Resources, each folded on its own) merge into the answer of folding both logs at once.
  const other = [track(-60, 's24', 'reachable'), hold(-30, 'acquire', 's24', { lease_id: 'l-5', expires_at: iso(at(-10)) })];
  const a = createTimeline();
  const b = createTimeline();
  for (const event of events) foldEvent(a, event);
  for (const event of other) foldEvent(b, event);
  assert.deepEqual(sharesOf(mergeTimelines([a, b]), registry, lockToResource(registry), WINDOW), run([...events, ...other]));
});

test('the fold ignores what it does not know: other events, bad ts, non-objects, a hold with no lock', () => {
  const timeline = createTimeline();
  for (const event of [null, 'x', 7, [], {}, { ts: 'nope', event: 'acquire', lock: 'adb', hold_kind: 'lease' }, ev(-10, 'request', { lock: 'adb', hold_kind: 'lease' }), ev(-10, 'acquire', { lock: null, hold_kind: 'lease' }), ev(-10, 'reachability', { resource: null, to: 'reachable' })]) foldEvent(timeline, event);
  assert.deepEqual([timeline.held.size, timeline.open.size, timeline.reserved.size, timeline.claims.size, timeline.readings.size], [0, 0, 0, 0, 0]);
});

test('parseUtilisationQuery: from is required, to defaults to and is clipped to now, and each refusal is bad-query or bad-range', () => {
  const q = (text, now = T) => parseUtilisationQuery(new URLSearchParams(text), { at: now });
  assert.deepEqual(q('from=2026-11-26T11:00:00Z'), { from: at(-60), to: T });
  assert.deepEqual(q('from=2026-11-26T11:00:00Z&to=2026-11-26T11:30:00Z'), { from: at(-60), to: at(-30) });
  assert.deepEqual(q('from=2026-11-26T11:00:00Z&to=2027-01-01'), { from: at(-60), to: T }, 'a later to is clipped to now');
  assert.deepEqual(parseUtilisationQuery('from=2026-11-26', { at: T }), { from: Date.parse('2026-11-26'), to: T }, 'text works as well');
  const refused = (text, reason) => assert.throws(() => q(text), error => error.code === 'HUB_USAGE' && error.status === 400 && error.reason === reason, `${text} -> ${reason}`);
  refused('', 'bad-query');
  refused('to=2026-11-26T11:30:00Z', 'bad-query');
  refused('from=2026-11-26&from=2026-11-25', 'bad-query');
  refused('from=', 'bad-query');
  refused('from=2026-11-26&limit=3', 'bad-query');
  refused('from=2026-11-26&resource=s26', 'bad-query');
  refused('from=yesterday', 'bad-range');
  refused('from=2026-11-26&to=tomorrow', 'bad-range');
  refused('from=2026-11-26T11:00:00Z&to=2026-11-26T11:00:00Z', 'bad-range');
  refused('from=2026-11-26T11:30:00Z&to=2026-11-26T11:00:00Z', 'bad-range');
  refused('from=2026-11-26T12:00:00Z', 'bad-range');
  refused('from=2026-11-27', 'bad-range');
});

test('mergeTimelines: an open Hold or claim two hosts both have joins as its interval instead of being dropped', () => {
  const a = createTimeline();
  const b = createTimeline();
  const claim = (minutes, extra) => reservation(minutes, 'claim', 'adb', { reserved_at: iso(at(minutes)), ...extra });
  for (const event of [track(-60, 's26', 'reachable'), hold(-50, 'acquire', 'adb', { expires_at: iso(at(-40)) }), claim(-55, { expires_at: iso(at(-50)) })]) foldEvent(a, event);
  for (const event of [hold(-20, 'acquire', 'adb', { lease_id: 'l-2', expires_at: iso(at(-10)) }), claim(-30, { expires_at: iso(at(-25)) })]) foldEvent(b, event);
  const merged = mergeTimelines([a, b]);
  assert.equal(merged.held.get('adb').length, 1, 'the second open Hold is a closed interval');
  ms(row(sharesOf(merged, registry, lockToResource(registry), WINDOW), 's26'), { idle: m(30), held: m(20), idle_while_reserved: m(10) });
});

test('a reading starts at min(checked_at, ts), and readings logged out of order are sorted by when they were taken', () => {
  const timeline = createTimeline();
  // A probe logged at -30 but taken at -31 holds from -31 (10 minutes with a 600 s max age).
  foldEvent(timeline, ev(-30, 'reachability', { resource: 's26', from: null, to: 'reachable', checked_at: iso(at(-31)), reason: 'probe' }));
  // A checked_at after the log time is never believed: it starts at ts.
  foldEvent(timeline, ev(-20, 'reachability', { resource: 'res-pixel', from: null, to: 'reachable', checked_at: iso(at(-10)), reason: 'track' }));
  // Logged in the reverse order of their checked_at: the later-taken reading (offline, taken -20) wins from -20.
  foldEvent(timeline, ev(-10, 'reachability', { resource: 's24', from: null, to: 'offline', checked_at: iso(at(-20)), reason: 'track' }));
  foldEvent(timeline, ev(-5, 'reachability', { resource: 's24', from: null, to: 'reachable', checked_at: iso(at(-30)), reason: 'track' }));
  const answer = sharesOf(timeline, registry, lockToResource(registry), WINDOW, { maxAgeS: 600 });
  ms(row(answer, 's26'), { idle: m(10), unknown: m(50) });
  ms(row(answer, 'res-pixel'), { idle: m(20), unknown: m(40) });
  ms(row(answer, 's24'), { idle: m(10), away: m(20), unknown: m(30) });
});
