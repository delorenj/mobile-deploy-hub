// The Event Log vocabulary for the Registry, Reachability and prune (Story 6.1, AD-9, AD-39): noteRegistry and noteReachability, the
// capped unlink-decided `prune`, and readEventsFrom with its derived event id. Everything is hermetic: a temp HUB_EVENT_DIR and
// HUB_LOCK_DIR per test, injected clocks, host ids and liveness.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { eta } from './lib/eta.mjs';
import { EVENT_MAX_BYTES, appendEvent, eventId, readEvents, readEventsFrom } from './lib/events.mjs';
import * as lockModule from './lib/lock.mjs';
import { ACTOR_VIA, PRUNE_EVENTS_MAX, checkActor, deliveryPendingEvent, leaseHoldersSince, noteReachability, noteRegistry, queueView, reserve } from './lib/lock.mjs';
import { hermetic } from './test-fixtures.mjs';

hermetic();

const lockFile = fileURLToPath(new URL('./lib/lock.mjs', import.meta.url));
const repoRoot = resolve(fileURLToPath(new URL('../../', import.meta.url)));
const T0 = Date.parse('2026-11-25T10:00:00.000Z');
const HOST_ID = 'machine-1';
const actor = { holder: 'jarad', via: 'api' };

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'hub-vocab-'));
  const env = { HUB_EVENT_DIR: join(root, 'events'), HUB_LOCK_DIR: join(root, 'locks') };
  const logs = [];
  const queueDir = name => join(env.HUB_LOCK_DIR, `${name}.queue`);
  mkdirSync(queueDir('adb'), { recursive: true });
  let n = 0;
  // Writes a ticket the way a job or Lease would have; pid 4_000_000 + k is never alive under the injected isAlive.
  const ticket = (extra = {}, name = 'adb') => {
    n += 1;
    const file = `${String(T0 - 60_000 + n).padStart(15, '0')}-${String(n).padStart(6, '0')}-${String(n).padStart(8, '0')}.json`;
    const body = { format: 1, kind: 'lease', lease_id: `l-${n}`, holder: `agent-${n}`, why: 'test', pid: 4_000_000 + n, host: 'h', host_id: HOST_ID, process_start: 'x', enqueued_at: new Date(T0 - 30_000).toISOString(), deadline_at: null, expires_at: null, ...extra };
    mkdirSync(queueDir(name), { recursive: true });
    writeFileSync(join(queueDir(name), file), JSON.stringify(body));
    return file;
  };
  const tickets = (name = 'adb') => { try { return readdirSync(queueDir(name)).sort(); } catch { return []; } };
  const events = () => [...readEvents({ env, log: line => logs.push(line) })];
  const view = (extra = {}) => queueView('adb', { env, now: () => T0, host: 'h', hostId: HOST_ID, isAlive: () => false, prune: true, ...extra });
  return { root, env, logs, ticket, tickets, events, view, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const seams = f => ({ env: f.env, now: () => T0, hostId: HOST_ID, log: line => f.logs.push(line) });

test('lock.mjs exports the appenders, and only lock.mjs and events.mjs name appendEvent among non-test sources', () => {
  assert.equal(typeof lockModule.noteRegistry, 'function');
  assert.equal(typeof lockModule.noteReachability, 'function');
  assert.equal(lockModule.PRUNE_EVENTS_MAX, 20);
  assert.deepEqual([...ACTOR_VIA], ['cli', 'api', 'host-agent', 'control-surface']);
  const found = [];
  const walk = dir => {
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules' || entry.startsWith('.')) continue;
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) walk(path);
      else if (entry.endsWith('.mjs') && !entry.endsWith('.test.mjs') && /\bappendEvent\b/.test(readFileSync(path, 'utf8'))) found.push(relative(repoRoot, path).split('\\').join('/'));
    }
  };
  walk(join(repoRoot, 'tools'));
  assert.deepEqual(found.sort(), ['tools/ci/lib/events.mjs', 'tools/ci/lib/lock.mjs']);
});

test('checkActor accepts {holder, via} only', () => {
  assert.equal(checkActor(undefined), null);
  assert.equal(checkActor(null), null);
  assert.deepEqual(checkActor(actor), actor);
  for (const via of ACTOR_VIA) assert.deepEqual(checkActor({ holder: 'x', via }), { holder: 'x', via });
  for (const bad of ['jarad', [], { holder: 'jarad' }, { holder: '', via: 'cli' }, { holder: 'j', via: 'phone' }, { holder: 'j', via: 'cli', extra: 1 }, { holder: 5, via: 'cli' }]) {
    assert.throws(() => checkActor(bad), TypeError, JSON.stringify(bad));
  }
});

test('noteRegistry writes one allowlisted line and never an identity, serial, udid, adb id or allowed_users', () => {
  const f = fixture();
  try {
    const written = noteRegistry('add', {
      resource: 'res-pixel', lock: 'res-pixel', changed: ['name', 'capabilities.model'], actor,
      identity: { serial: 'SERIALX1', udid: 'UDIDX2', adb: 'adb-ADBX3' }, serial: 'SERIALX1', udid: 'UDIDX2', adb_id: 'ADBX3', allowed_users: ['qa-person'],
    }, seams(f));
    assert.equal(written, true);
    const raw = readFileSync(join(f.env.HUB_EVENT_DIR, '2026-11.jsonl'), 'utf8');
    assert.equal(raw.trim().split('\n').length, 1);
    for (const secret of ['SERIALX1', 'UDIDX2', 'ADBX3', 'qa-person', 'identity', 'allowed_users']) assert.ok(!raw.includes(secret), `${secret} must not be in the line`);
    const event = JSON.parse(raw);
    assert.deepEqual(Object.keys(event).slice(0, 5), ['format', 'ts', 'host', 'host_id', 'hub_version']);
    const { format, ts, host, host_id, hub_version, ...body } = event;
    assert.deepEqual(body, { event: 'registry-add', resource: 'res-pixel', lock: 'res-pixel', changed: ['name', 'capabilities.model'], actor });
    assert.equal(host_id, HOST_ID);

    assert.equal(noteRegistry('edit', { resource: 's26', lock: 'adb', changed: ['name'], rev: 7, reason: 'recovered', why: 'renamed', actor }, seams(f)), true);
    assert.equal(noteRegistry('retire', { resource: 'res-pixel', lock: 'res-pixel' }, seams(f)), true);
    const [, edit, retire] = f.events();
    assert.equal(edit.event, 'registry-edit');
    assert.deepEqual([edit.rev, edit.reason, edit.why, edit.changed], [7, 'recovered', 'renamed', ['name']]);
    assert.deepEqual(Object.keys(retire).slice(5), ['event', 'resource', 'lock'], 'a field not given is not written');
    assert.deepEqual(f.logs, []);
  } finally { f.cleanup(); }
});

test('noteRegistry refuses a caller bug with a TypeError and writes nothing', () => {
  const f = fixture();
  try {
    const ok = { resource: 'res-pixel', lock: 'res-pixel' };
    assert.throws(() => noteRegistry('delete', ok, seams(f)), TypeError);
    assert.throws(() => noteRegistry('add', { lock: 'res-pixel' }, seams(f)), TypeError);
    assert.throws(() => noteRegistry('add', { resource: 'res-pixel' }, seams(f)), TypeError);
    assert.throws(() => noteRegistry('add', { ...ok, changed: ['name', 7] }, seams(f)), TypeError);
    assert.throws(() => noteRegistry('add', { ...ok, changed: 'name' }, seams(f)), TypeError);
    assert.throws(() => noteRegistry('add', { ...ok, actor: { holder: 'x', via: 'phone' } }, seams(f)), TypeError);
    assert.throws(() => noteRegistry('add', { ...ok, why: 5 }, seams(f)), TypeError);
    assert.throws(() => noteRegistry('add', null, seams(f)), TypeError);
    assert.deepEqual(f.events(), []);
  } finally { f.cleanup(); }
});

test('noteReachability writes one reachability line with no Queued gate, and a host-reachability line about the peer', () => {
  const f = fixture();
  try {
    const checked = '2026-11-25T09:59:30.000Z';
    assert.equal(noteReachability({ resource: 's26', from: 'reachable', to: 'offline', checked_at: checked, reason: 'track-lost' }, seams(f)), true);
    assert.equal(noteReachability({ host: 'mac', from: 'reachable', to: 'unreachable', reason: 'connect-timeout', actor }, seams(f)), true);
    assert.equal(noteReachability({ resource: 'res-pixel', from: null, to: 'reachable', checked_at: T0, why: 'first reading' }, seams(f)), true);
    const [one, host, first] = f.events();
    const { format, ts, host: h1, host_id, hub_version, ...body } = one;
    assert.deepEqual(body, { event: 'reachability', resource: 's26', from: 'reachable', to: 'offline', checked_at: checked, reason: 'track-lost' });
    assert.ok(typeof h1 === 'string' && h1 !== 'mac');
    assert.equal(host.event, 'host-reachability');
    assert.equal(host.host, 'mac', 'the line is about the peer host');
    assert.equal(host.host_id, HOST_ID, 'the writer is identified by host_id');
    assert.equal(host.resource, null);
    assert.deepEqual([host.from, host.to, host.checked_at, host.reason, host.actor], ['reachable', 'unreachable', null, 'connect-timeout', actor]);
    assert.deepEqual([first.from, first.to, first.checked_at, first.why], [null, 'reachable', '2026-11-25T10:00:00.000Z', 'first reading']);
    assert.deepEqual(f.logs, []);
  } finally { f.cleanup(); }
});

test('noteReachability needs exactly one of host and resource, and sane states', () => {
  const f = fixture();
  try {
    const ok = { from: 'reachable', to: 'offline' };
    assert.throws(() => noteReachability({ ...ok, host: 'mac', resource: 's26' }, seams(f)), TypeError);
    assert.throws(() => noteReachability({ ...ok }, seams(f)), TypeError);
    assert.throws(() => noteReachability({ ...ok, resource: 's26', to: 'Offline!' }, seams(f)), TypeError);
    assert.throws(() => noteReachability({ ...ok, resource: 's26', to: null }, seams(f)), TypeError);
    assert.throws(() => noteReachability({ ...ok, resource: 's26', from: 'a b' }, seams(f)), TypeError);
    assert.throws(() => noteReachability({ ...ok, resource: 's26', checked_at: 'not a date' }, seams(f)), TypeError);
    assert.throws(() => noteReachability({ ...ok, host: '../mac' }, seams(f)), TypeError);
    assert.throws(() => noteReachability({ ...ok, resource: 's26', actor: { holder: 'x' } }, seams(f)), TypeError);
    assert.deepEqual(f.events(), []);
  } finally { f.cleanup(); }
});

test('a failed write is false and HUB_EVENT_LOG_FAILED, never a throw', () => {
  const f = fixture();
  try {
    // The event dir path is a regular file, so mkdir and open fail.
    writeFileSync(join(f.root, 'events'), 'in the way');
    assert.equal(noteReachability({ resource: 's26', from: null, to: 'reachable' }, seams(f)), false);
    assert.equal(noteRegistry('add', { resource: 'res-x', lock: 'res-x' }, seams(f)), false);
    assert.equal(f.logs.length, 2);
    assert.match(f.logs[0], /^HUB_EVENT_LOG_FAILED/);
    // An oversize line that nothing can shrink is the same failure.
    rmSync(join(f.root, 'events'));
    assert.equal(noteRegistry('edit', { resource: 'res-x', lock: 'res-x', changed: Array.from({ length: 800 }, (_, n) => `capabilities.key-${n}`) }, seams(f)), false);
    assert.match(f.logs[2], /E2BIG/);
  } finally { f.cleanup(); }
});

test('a prune of up to 20 dead tickets writes one prune event each, with the claimant and the wait', () => {
  const f = fixture();
  try {
    f.ticket({ kind: 'lease', lease_id: 'l-dead', holder: 'agent-x' });
    f.ticket({ kind: 'job', lease_id: 'job:o/r#9.1/android', holder: 'o/r#9', repo: 'o/r', run: '9', attempt: '1', job: 'android' });
    f.ticket({ kind: 'lease', lease_id: 'l-pool', holder: 'agent-y', pool: 'phone', request: 'l-req' });
    f.ticket({ kind: 'hub-job', lease_id: 'job:o/r#10.1/catchup', holder: 'catch-up', repo: 'o/r', run: '10', attempt: '1', job: 'catchup' });
    assert.equal(f.view().length, 0);
    assert.deepEqual(f.tickets(), []);
    const prunes = f.events();
    assert.deepEqual(prunes.map(event => event.event), ['prune', 'prune', 'prune', 'prune']);
    for (const event of prunes) {
      assert.deepEqual([event.lock, event.resource, event.count, event.reason, event.waited_ms], ['adb', 's26', 1, 'gone', 30_000]);
    }
    assert.deepEqual([prunes[0].hold_kind, prunes[0].claimant.kind, prunes[0].claimant.holder, prunes[0].lease_id], ['lease', 'agent', 'agent-x', 'l-dead']);
    assert.deepEqual([prunes[1].hold_kind, prunes[1].claimant.kind, prunes[1].claimant.repo, prunes[1].claimant.run, prunes[1].claimant.job, prunes[1].lease_id], ['job', 'deploy', 'o/r', '9', 'android', null]);
    assert.deepEqual([prunes[2].pool, prunes[2].request], ['phone', 'l-req']);
    assert.deepEqual([prunes[3].hold_kind, prunes[3].claimant.kind, prunes[3].claimant.repo, prunes[3].claimant.job, prunes[3].lease_id], ['job', 'hub-job', 'o/r', 'catchup', null], 'the catch-up prunes as itself');
    // Nothing left: a second prune writes nothing.
    f.view();
    assert.equal(f.events().length, 4);
  } finally { f.cleanup(); }
});

test('an unreadable ticket older than a minute is pruned as unreadable, a young one is left alone', () => {
  const f = fixture();
  try {
    const dir = join(f.env.HUB_LOCK_DIR, 'adb.queue');
    writeFileSync(join(dir, '000000000000001-000001-00000001.json'), '{"format":');
    writeFileSync(join(dir, '000000000000002-000002-00000002.json'), '{"format":');
    const old = new Date(T0 - 120_000);
    utimesSync(join(dir, '000000000000001-000001-00000001.json'), old, old);
    const young = new Date(T0 - 5_000);
    utimesSync(join(dir, '000000000000002-000002-00000002.json'), young, young);
    f.view();
    assert.deepEqual(f.tickets(), ['000000000000002-000002-00000002.json']);
    const [event, ...rest] = f.events();
    assert.deepEqual(rest, []);
    assert.deepEqual([event.event, event.reason, event.count, event.hold_kind, event.claimant.holder, event.waited_ms], ['prune', 'unreadable', 1, null, null, null]);
  } finally { f.cleanup(); }
});

test('an observer prunes nothing and writes nothing', () => {
  const f = fixture();
  try {
    f.ticket();
    const stale = f.view({ prune: false, includeStale: true });
    assert.equal(stale.length, 1);
    assert.equal(stale[0].stale, true);
    assert.equal(f.tickets().length, 1);
    assert.deepEqual(f.events(), []);
  } finally { f.cleanup(); }
});

test('a prune of more than 20 removes every ticket and writes 19 events plus one folded', () => {
  const f = fixture();
  try {
    for (let n = 0; n < 25; n += 1) f.ticket();
    assert.equal(PRUNE_EVENTS_MAX, 20);
    f.view();
    assert.deepEqual(f.tickets(), [], 'all 25 removed');
    const events = f.events();
    assert.equal(events.length, 20);
    assert.ok(events.every(event => event.event === 'prune'));
    assert.deepEqual(events.slice(0, 19).map(event => [event.count, event.reason]), Array.from({ length: 19 }, () => [1, 'gone']));
    const folded = events[19];
    assert.deepEqual([folded.count, folded.reason, folded.lock, folded.resource, folded.hold_kind, folded.claimant.holder], [6, 'folded', 'adb', 's26', null, null]);
    assert.equal(events.reduce((sum, event) => sum + event.count, 0), 25, 'a reader sums count');
    // Exactly 20 is not folded.
    for (let n = 0; n < 20; n += 1) f.ticket();
    f.view();
    const more = f.events().slice(20);
    assert.equal(more.length, 20);
    assert.ok(more.every(event => event.count === 1 && event.reason === 'gone'));
  } finally { f.cleanup(); }
});

test('a log failure never stops the removals', () => {
  const f = fixture();
  try {
    for (let n = 0; n < 3; n += 1) f.ticket();
    writeFileSync(join(f.root, 'events'), 'in the way');
    const errors = [];
    const original = console.error;
    console.error = line => errors.push(line);
    try { assert.equal(f.view().length, 0); } finally { console.error = original; }
    assert.deepEqual(f.tickets(), []);
    assert.equal(errors.filter(line => /^HUB_EVENT_LOG_FAILED/.test(line)).length, 3);
  } finally { f.cleanup(); }
});

test('two pruners racing for one dead ticket write exactly one prune event (the unlink decides)', () => {
  const f = fixture();
  try {
    f.ticket();
    let rival = null;
    // The first pruner judges the ticket dead; before it unlinks, a second pruner removes it and writes its event.
    const view = f.view({
      isAlive: () => {
        if (rival === null) rival = f.view({ isAlive: () => false });
        return false;
      },
    });
    assert.equal(view.length, 0);
    assert.equal(rival.length, 0);
    assert.deepEqual(f.tickets(), []);
    const events = f.events();
    assert.equal(events.length, 1, 'ENOENT is a lost race, not an event');
    assert.equal(events[0].event, 'prune');
  } finally { f.cleanup(); }
});

test('setting aside an unreadable Reservation record writes one prune event', () => {
  const f = fixture();
  try {
    const env = { ...f.env, GITHUB_REPOSITORY: 'delorenj/example', GITHUB_RUN_ID: '5' };
    const dir = join(f.env.HUB_LOCK_DIR, 'adb.reservations/delorenj--example--5');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'reservation.json'), '{"format":');
    const policy = { queue: { reservation_ceiling_min: 180, grace_min: 10 } };
    const got = reserve('adb', { env, now: () => Date.now() + 120_000, policy, hostId: HOST_ID, log: () => {}, wait: () => {} });
    assert.equal(got.status, 'claimed');
    const prunes = f.events().filter(event => event.event === 'prune');
    assert.equal(prunes.length, 1);
    assert.deepEqual([prunes[0].hold_kind, prunes[0].run_key, prunes[0].reason, prunes[0].count, prunes[0].lock], ['reservation', 'delorenj--example--5', 'unreadable', 1, 'adb']);
  } finally { f.cleanup(); }
});

test('a reserver that loses the set-aside rename of an unreadable Reservation writes no prune', () => {
  const f = fixture();
  try {
    const env = { ...f.env, GITHUB_REPOSITORY: 'delorenj/example', GITHUB_RUN_ID: '5' };
    const base = join(f.env.HUB_LOCK_DIR, 'adb.reservations');
    const dir = join(base, 'delorenj--example--5');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'reservation.json'), '{"format":');
    const policy = { queue: { reservation_ceiling_min: 180, grace_min: 10 } };
    // now() is called for the round's time, then the record's age, then by retireReservation just before its rename: on that
    // third call a rival wins the rename first (it writes its own one prune), so this reserver's rename finds nothing.
    let calls = 0;
    const now = () => {
      calls += 1;
      if (calls === 3) renameSync(dir, join(base, '.released-rival'));
      return Date.now() + 120_000;
    };
    const got = reserve('adb', { env, now, policy, hostId: HOST_ID, log: () => {}, wait: () => {} });
    assert.equal(got.status, 'claimed');
    assert.ok(calls > 3, 'the rival moved the record before this reserver\'s rename');
    assert.deepEqual(f.events().map(event => event.event), ['claim'], 'the loser writes no prune; the rival\'s rename decided it');
  } finally { f.cleanup(); }
});

test('readEventsFrom returns only complete lines, the new end, and ids derived from the byte offset', () => {
  const f = fixture();
  try {
    const at = n => ({ env: f.env, now: () => T0 + n, hostId: HOST_ID, log: () => {} });
    appendEvent({ event: 'acquire', lock: 'adb', why: 'ü日本' }, at(0));
    appendEvent({ event: 'release', lock: 'adb' }, at(1));
    const file = join(f.env.HUB_EVENT_DIR, '2026-11.jsonl');
    const whole = readFileSync(file);
    const first = readEventsFrom({ env: f.env, month: '2026-11', hostId: HOST_ID });
    assert.deepEqual([first.month, first.from, first.offset, first.lines.length], ['2026-11', 0, whole.length, 2]);
    assert.equal(Buffer.from(first.lines.join('')).equals(whole), true, 'raw lines are byte-exact, newline included');
    assert.equal(first.events[0].id, `${HOST_ID}/2026-11/0`);
    assert.equal(first.events[1].id, `${HOST_ID}/2026-11/${Buffer.byteLength(first.lines[0])}`);
    assert.equal(first.events[1].offset, Buffer.byteLength(first.lines[0]));
    assert.equal(first.events[0].event.why, 'ü日本');
    const replica = readEventsFrom({ env: f.env, month: '2026-11', hostId: 'some-other-reader' });
    assert.deepEqual(replica.events.map(entry => entry.id), first.events.map(entry => entry.id), 'the id names the line\'s writer, not the reader');
    assert.equal(eventId(HOST_ID, '2026-11', 12), `${HOST_ID}/2026-11/12`);
    assert.equal(eventId(null, '2026-11', 12), 'unknown/2026-11/12');

    // Nothing new: an empty read at the same offset.
    const none = readEventsFrom({ env: f.env, month: '2026-11', offset: first.offset, hostId: HOST_ID });
    assert.deepEqual([none.from, none.offset, none.lines, none.events], [first.offset, first.offset, [], []]);

    // A writer is mid-append: the half line is not returned and the offset stays before it.
    writeFileSync(file, '{"format":1,"ts":"2026-11-25T10:00:00.000Z","event":"torn"', { flag: 'a' });
    const torn = readEventsFrom({ env: f.env, month: '2026-11', offset: first.offset, hostId: HOST_ID });
    assert.deepEqual([torn.offset, torn.lines], [first.offset, []]);
    writeFileSync(file, ',"n":1}\n', { flag: 'a' });
    const done = readEventsFrom({ env: f.env, month: '2026-11', offset: first.offset, hostId: HOST_ID });
    assert.deepEqual(done.events.map(entry => entry.event?.event), ['torn']);
    assert.equal(done.events[0].id, `${HOST_ID}/2026-11/${first.offset}`, 'the id of a line does not depend on when it was read');
    assert.equal(done.offset, readFileSync(file).length);

    // A line that is not an event keeps its bytes and has no id.
    writeFileSync(file, 'not json\n[1]\n\n', { flag: 'a' });
    const junk = readEventsFrom({ env: f.env, month: '2026-11', offset: done.offset, hostId: HOST_ID });
    assert.equal(junk.lines.join(''), 'not json\n[1]\n\n');
    assert.deepEqual(junk.events.map(entry => [entry.id, entry.event]), [[null, null], [null, null], [null, null]]);

    // maxBytes pages through the file on line boundaries.
    const all = [];
    let offset = 0;
    for (let rounds = 0; rounds < 20; rounds += 1) {
      const page = readEventsFrom({ env: f.env, month: '2026-11', offset, maxBytes: EVENT_MAX_BYTES, hostId: HOST_ID });
      if (page.lines.length === 0) break;
      all.push(...page.lines);
      offset = page.offset;
    }
    assert.equal(Buffer.from(all.join('')).equals(readFileSync(file)), true);
  } finally { f.cleanup(); }
});

test('readEventsFrom pages by maxBytes on line boundaries: each page fits, ends on a newline, and the pages are the complete prefix', () => {
  const f = fixture();
  try {
    const at = n => ({ env: f.env, now: () => T0 + n, hostId: HOST_ID, log: () => {} });
    for (let n = 0; n < 12; n += 1) assert.equal(appendEvent({ event: 'acquire', lock: 'adb', n, why: 'p'.repeat(1500) }, at(n)), true);
    const file = join(f.env.HUB_EVENT_DIR, '2026-11.jsonl');
    const complete = readFileSync(file);
    assert.ok(complete.length > 3 * EVENT_MAX_BYTES, 'the file is several windows long');
    writeFileSync(file, '{"format":1,"half":', { flag: 'a' });
    const pages = [];
    let offset = 0;
    for (let rounds = 0; rounds < 50; rounds += 1) {
      const page = readEventsFrom({ env: f.env, month: '2026-11', offset, maxBytes: EVENT_MAX_BYTES, hostId: HOST_ID });
      if (page.lines.length === 0) break;
      pages.push(page);
      offset = page.offset;
    }
    assert.ok(pages.length >= 3, `${pages.length} pages`);
    for (const page of pages) {
      const text = page.lines.join('');
      assert.ok(Buffer.byteLength(text) <= EVENT_MAX_BYTES, 'a page never exceeds maxBytes');
      assert.ok(text.endsWith('\n'));
      assert.equal(page.offset - page.from, Buffer.byteLength(text));
    }
    assert.equal(Buffer.from(pages.flatMap(page => page.lines).join('')).equals(complete), true, 'the pages are the complete prefix, byte for byte');
    assert.equal(offset, complete.length, 'the half line is not returned');
    const single = readEventsFrom({ env: f.env, month: '2026-11', maxBytes: 1024 * 1024, hostId: HOST_ID });
    assert.deepEqual(pages.flatMap(page => page.events.map(entry => entry.id)), single.events.map(entry => entry.id));
    assert.equal(single.events.length, 12);
  } finally { f.cleanup(); }
});

test('readEventsFrom: a complete line longer than maxBytes is HUB_EVENT_LINE_TOO_LONG, not an empty read that stalls; a short window at the end of the file stays empty', () => {
  const f = fixture();
  try {
    mkdirSync(f.env.HUB_EVENT_DIR, { recursive: true });
    const file = join(f.env.HUB_EVENT_DIR, '2026-11.jsonl');
    writeFileSync(file, `{"format":1,"ts":"2026-11-25T10:00:00.000Z","event":"hand","why":"${'x'.repeat(2 * EVENT_MAX_BYTES)}"}\n`);
    assert.throws(() => readEventsFrom({ env: f.env, month: '2026-11', maxBytes: EVENT_MAX_BYTES }), error => error instanceof RangeError && error.code === 'HUB_EVENT_LINE_TOO_LONG');
    assert.equal(readEventsFrom({ env: f.env, month: '2026-11', maxBytes: 4 * EVENT_MAX_BYTES }).lines.length, 1, 'a window that holds the line reads it');
    // A half line that ends the file (the window is short because the file ends) is a writer mid-append, not an error.
    writeFileSync(file, '{"format":1,"half":');
    const half = readEventsFrom({ env: f.env, month: '2026-11', maxBytes: EVENT_MAX_BYTES });
    assert.deepEqual([half.offset, half.lines], [0, []]);
  } finally { f.cleanup(); }
});

test('readEventsFrom ids use the line\'s own machine id; a forged or missing host_id reads as the hostId option, else unknown', () => {
  const f = fixture();
  try {
    mkdirSync(f.env.HUB_EVENT_DIR, { recursive: true });
    const row = (host_id, n) => `${JSON.stringify({ format: 1, ts: '2026-11-25T10:00:00.000Z', host_id, event: 'acquire', n })}\n`;
    const lines = [row('abc-123', 0), row('a/b', 1), row(null, 2), row(undefined, 3), row('x'.repeat(65), 4)];
    writeFileSync(join(f.env.HUB_EVENT_DIR, '2026-11.jsonl'), lines.join(''));
    const starts = lines.map((_, i) => Buffer.byteLength(lines.slice(0, i).join('')));
    const ids = options => readEventsFrom({ env: f.env, month: '2026-11', ...options }).events.map(entry => entry.id);
    assert.deepEqual(ids({}), starts.map((start, i) => `${i === 0 ? 'abc-123' : 'unknown'}/2026-11/${start}`), 'no reader machine id is looked up');
    assert.deepEqual(ids({ hostId: 'src-host' }), starts.map((start, i) => `${i === 0 ? 'abc-123' : 'src-host'}/2026-11/${start}`));
    assert.ok(ids({}).every(id => id.split('/').length === 3), 'every id has exactly three parts');
    for (const hostId of ['a/b', '', 'x'.repeat(65), 42]) {
      assert.deepEqual(ids({ hostId }), ids({}), `a hostId option that is not a machine id (${hostId}) reads as unknown`);
    }
  } finally { f.cleanup(); }
});

test('readEventsFrom: a missing month is empty, a bad offset is HUB_EVENT_OFFSET, bad arguments are a TypeError', () => {
  const f = fixture();
  try {
    const missing = readEventsFrom({ env: f.env, month: '2026-10', offset: 40 });
    assert.deepEqual([missing.from, missing.offset, missing.lines, missing.events], [40, 40, [], []]);
    appendEvent({ event: 'acquire', lock: 'adb' }, { env: f.env, now: () => T0, hostId: HOST_ID, log: () => {} });
    const size = readFileSync(join(f.env.HUB_EVENT_DIR, '2026-11.jsonl')).length;
    for (const offset of [size + 1, 3, size - 1]) {
      assert.throws(() => readEventsFrom({ env: f.env, month: '2026-11', offset }), error => error instanceof RangeError && error.code === 'HUB_EVENT_OFFSET', `offset ${offset}`);
    }
    assert.deepEqual(readEventsFrom({ env: f.env, month: '2026-11', offset: size }).lines, [], 'the end of the file is a good offset');
    for (const month of [undefined, '2026-1', '2026-13', '../x', 202611]) assert.throws(() => readEventsFrom({ env: f.env, month }), TypeError, String(month));
    assert.throws(() => readEventsFrom({ env: f.env, month: '2026-11', offset: -1 }), TypeError);
    assert.throws(() => readEventsFrom({ env: f.env, month: '2026-11', offset: 1.5 }), TypeError);
    assert.throws(() => readEventsFrom({ env: f.env, month: '2026-11', maxBytes: 100 }), TypeError);
  } finally { f.cleanup(); }
});

test('appending in another process while readEventsFrom resumes leaves no torn line, a byte-exact prefix and unique stable ids', async () => {
  const f = fixture();
  try {
    const total = 200;
    const script = `
      import { noteRegistry, noteReachability } from ${JSON.stringify(pathToFileURL(lockFile).href)};
      for (let n = 0; n < ${total}; n += 1) {
        const ok = n % 2 === 0
          ? noteRegistry('edit', { resource: 'res-x', lock: 'res-x', changed: ['name'], rev: n, why: 'w'.repeat(2500) }, { now: () => ${T0}, hostId: 'child-host', log: line => { console.error(line); process.exitCode = 1; } })
          : noteReachability({ resource: 'res-x', from: 'reachable', to: 'offline', reason: 'r'.repeat(2500) }, { now: () => ${T0}, hostId: 'child-host', log: line => { console.error(line); process.exitCode = 1; } });
        if (!ok) process.exitCode = 1;
      }`;
    let exited = false;
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { env: { PATH: process.env.PATH, HUB_EVENT_DIR: f.env.HUB_EVENT_DIR }, stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    child.stderr.on('data', chunk => { err += chunk; });
    const closed = new Promise((done, fail) => { child.on('error', fail); child.on('close', code => { exited = true; if (code === 0) done(); else fail(new Error(`appender exited ${code}: ${err}`)); }); });
    const month = '2026-11';
    const lines = [];
    const ids = [];
    let offset = 0;
    const drain = () => {
      const page = readEventsFrom({ env: f.env, month, offset, hostId: HOST_ID });
      assert.equal(page.from, offset);
      for (const [index, line] of page.lines.entries()) {
        assert.ok(Buffer.byteLength(line) <= EVENT_MAX_BYTES);
        JSON.parse(line);
        lines.push(line);
        ids.push(page.events[index].id);
      }
      offset = page.offset;
    };
    while (!exited) { drain(); await new Promise(done => setImmediate(done)); }
    await closed;
    drain();
    assert.equal(lines.length, total);
    assert.equal(lines.every(line => line.endsWith('\n')), true);
    const finalBytes = readFileSync(join(f.env.HUB_EVENT_DIR, `${month}.jsonl`));
    assert.equal(Buffer.from(lines.join('')).equals(finalBytes), true, 'the concatenation is the file prefix, byte for byte');
    assert.equal(offset, finalBytes.length);
    assert.equal(new Set(ids).size, total, 'no id repeats');
    // Stable: a read from 0 now gives the same ids in the same order.
    const again = readEventsFrom({ env: f.env, month, offset: 0, maxBytes: 4 * 1024 * 1024, hostId: HOST_ID });
    assert.deepEqual(again.events.map(entry => entry.id), ids);
  } finally { f.cleanup(); }
});

test('old readers give identical answers with and without the new event names in the log', () => {
  const policy = { queue: { eta_window_days: 30, eta_low_data_min_holds: 2, hold_allowance_min: { android: 15 } } };
  const now = T0 + 3600_000;
  const iso = ms => new Date(ms).toISOString();
  const claimant = { kind: 'agent', holder: 'agent-a', repo: null, run: null, attempt: null, job: null };
  const v1a = [
    { format: 1, ts: iso(T0 - 7200_000), event: 'acquire', lock: 'adb', hold_kind: 'lease', lease_id: 'l-a', claimant, for_ms: 1_800_000, expires_at: iso(T0 + 1_800_000) },
    { format: 1, ts: iso(T0 - 5400_000), event: 'release', lock: 'adb', hold_kind: 'lease', lease_id: 'l-a', claimant, held_ms: 1_800_000, for_ms: 1_800_000, expires_at: iso(T0 + 1_800_000), last_alive_at: null },
    { format: 1, ts: iso(T0 - 3600_000), event: 'release', lock: 'adb', hold_kind: 'job', held_ms: 600_000, for_ms: null, last_alive_at: null, claimant: { kind: 'deploy', holder: null, repo: 'o/a', run: '1', attempt: '1', job: 'android' } },
    { format: 1, ts: iso(T0 - 1800_000), event: 'release', lock: 'adb', hold_kind: 'job', held_ms: 900_000, for_ms: null, last_alive_at: null, claimant: { kind: 'deploy', holder: null, repo: 'o/a', run: '2', attempt: '1', job: 'android' } },
    { format: 1, ts: iso(T0 - 60_000), event: 'timeout', lock: 'adb', reason: 'delivery-pending', claimant: { kind: 'deploy', repo: 'o/a', run: '7', attempt: '1', job: 'android' } },
  ];
  const writeLog = (dir, extra) => {
    mkdirSync(dir, { recursive: true });
    const lines = [...v1a, ...extra].sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts)).map(event => `${JSON.stringify(event)}\n`).join('');
    writeFileSync(join(dir, '2026-11.jsonl'), lines);
  };
  const root = mkdtempSync(join(tmpdir(), 'hub-vocab-old-'));
  try {
    const without = { HUB_EVENT_DIR: join(root, 'without') };
    const withNew = { HUB_EVENT_DIR: join(root, 'with') };
    writeLog(without.HUB_EVENT_DIR, []);
    writeLog(withNew.HUB_EVENT_DIR, []);
    // Every new name, written by the real functions into the second log, interleaved by ts.
    const at = ms => ({ env: withNew, now: () => ms, hostId: HOST_ID, log: () => {} });
    noteRegistry('add', { resource: 'res-pixel', lock: 'res-pixel', changed: ['name'], actor }, at(T0 - 7000_000));
    noteRegistry('edit', { resource: 's26', lock: 'adb', changed: ['name'] }, at(T0 - 3000_000));
    noteRegistry('retire', { resource: 'res-pixel', lock: 'res-pixel' }, at(T0 - 2000_000));
    noteReachability({ resource: 's26', from: 'reachable', to: 'offline', reason: 'track-lost' }, at(T0 - 1500_000));
    noteReachability({ host: 'mac', from: 'reachable', to: 'unreachable' }, at(T0 - 1400_000));
    appendEvent({ event: 'prune', lock: 'adb', resource: 's26', hold_kind: 'lease', claimant, lease_id: 'l-a', count: 1, reason: 'gone', waited_ms: 5, held_ms: 1_800_000, for_ms: 60_000 }, at(T0 - 1300_000));
    appendEvent({ event: 'force-release', lock: 'adb', resource: 's26', actor, why: 'stuck' }, at(T0 - 1200_000));
    assert.ok([...readEvents({ env: withNew, log: () => {} })].length > [...readEvents({ env: without, log: () => {} })].length + 6);

    const asked = env => {
      const events = [...readEvents({ env, log: () => {} })];
      return {
        eta: eta({ owner: { kind: 'lease', lease_id: 'held', holder: 'a', started_at: iso(now - 600_000), expires_at: iso(now + 600_000) }, view: [{ file: 'a', kind: 'job', blocking: true, repo: 'o/a', job: 'android', deadline_at: null }] }, events, policy, now),
        holders: leaseHoldersSince('adb', T0 - 4 * 3600_000, { env, log: () => {} }),
        pending: deliveryPendingEvent('adb', { repo: 'o/a', run: '7' }, { env, log: () => {} }),
      };
    };
    const before = asked(without);
    assert.deepEqual(asked(withNew), before);
    assert.ok(before.holders.length === 1 && before.pending !== null && before.eta.hi_ms > 0, 'the fixture is not trivially empty');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
