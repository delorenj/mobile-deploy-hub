// Story 8.2: the process-start reader seam. `listLocks`, `liveLease`, `emulatorStatus` and the acquire paths read a pid's start through the
// reader they are given (a service's host snapshot) and never through the global one, so a staleness check on the request path costs no
// /proc read, and a Lease whose recorded start differs reads `holder-gone` only through the seam. Hermetic: a scratch lock dir.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createContext, forceReleaseLease, loadFleet, statusView } from '../device/claims.mjs';
import { emulatorStatus } from '../device/emulator.mjs';
import { fakeWire } from '../device/wire-fixtures.mjs';
import { acquireLease, acquirePool, buildTicket, listLocks, liveLease, processStart, releaseLease } from './lib/lock.mjs';
import { loadPolicy } from './lib/policy.mjs';
import { hermetic } from './test-fixtures.mjs';

hermetic();

function scratch() {
  const root = mkdtempSync(join(tmpdir(), 'hub-start-seam-'));
  const env = { PATH: process.env.PATH, HOME: root, HUB_LOCK_DIR: join(root, 'locks'), HUB_EVENT_DIR: join(root, 'events') };
  return { root, env, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
const spy = answer => { const calls = []; const read = pid => { calls.push(pid); return typeof answer === 'function' ? answer(pid) : answer; }; read.calls = calls; return read; };

test('listLocks judges a Lease holder by the injected reader: a start that differs reads stale, one that matches is live, and the global reader is the default', async () => {
  const s = scratch();
  try {
    await acquireLease('s24', { holder: 'agent-a', why: 'proof', forMs: 3_600_000, id: 'held', holderPid: process.pid, env: s.env, log: () => {} });
    const recorded = processStart(process.pid);
    assert.ok(recorded, 'the holder pid has a start');
    const same = spy(recorded);
    const other = spy('another process now owns this pid');
    assert.equal(listLocks({ env: s.env, processStart: same })[0].stale, false);
    assert.equal(listLocks({ env: s.env, processStart: other })[0].stale, true, 'the recorded start differs: holder-gone, through the seam only');
    assert.deepEqual([same.calls, other.calls], [[process.pid], [process.pid]]);
    assert.equal(listLocks({ env: s.env })[0].stale, false, 'no seam: the real reader, unchanged');
    releaseLease('s24', 'held', { env: s.env });
  } finally { s.cleanup(); }
});

test('liveLease takes the same reader: a Lease whose holder start differs is not live through it', async () => {
  const s = scratch();
  try {
    await acquireLease('s24', { holder: 'agent-a', why: 'proof', forMs: 3_600_000, id: 'held', holderPid: process.pid, env: s.env, log: () => {} });
    assert.equal(liveLease('s24', { env: s.env, processStart: spy(processStart(process.pid)) })?.lease_id, 'held');
    assert.equal(liveLease('s24', { env: s.env, processStart: spy('different') }), null);
    assert.equal(liveLease('s24', { env: s.env })?.lease_id, 'held');
    releaseLease('s24', 'held', { env: s.env });
  } finally { s.cleanup(); }
});

test('emulatorStatus reads each recorded process through the injected liveStart', () => {
  const s = scratch();
  try {
    const dir = join(s.env.HUB_LOCK_DIR, 'emulators');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'e-aaaaaaaaaaaa.json'), JSON.stringify({
      lease_id: 'e-aaaaaaaaaaaa', slot: 'emulator-1', profile: 'default', serial: 'emulator-5554', console_port: 5554, adb_server_port: 15170, avd: { name: 'hub-a' }, created_at: '2026-11-25T10:00:00Z',
      pids: [{ pid: 111, start: 'S1', role: 'emulator' }, { pid: 222, start: 'S2', role: 'adb-server' }, { pid: 333, start: null, role: 'xvfb' }],
    }));
    const live = spy(pid => ({ 111: 'S1', 222: 'moved on' })[pid] ?? null);
    const [entry] = emulatorStatus(s.env, { liveStart: live });
    assert.deepEqual(entry.pids.map(pid => [pid.pid, pid.alive]), [[111, true], [222, false], [333, false]]);
    assert.deepEqual(live.calls, [111, 222], 'a pid with no recorded start is never read');
    assert.deepEqual(emulatorStatus(s.env).map(item => item.pids.map(pid => pid.alive)), [[false, false, false]], 'no seam: the real reader, and no such pids');
  } finally { s.cleanup(); }
});

test('an acquire that finds a holder-pid Lease consults the reader it was given', async () => {
  const s = scratch();
  try {
    await acquireLease('s24', { holder: 'agent-a', why: 'proof', forMs: 3_600_000, id: 'held', holderPid: process.pid, env: s.env, log: () => {} });
    const reader = spy(processStart(process.pid));
    await assert.rejects(
      acquireLease('s24', { holder: 'agent-b', why: 'next', forMs: 600_000, id: 'next', waitMs: 0, env: s.env, log: () => {}, processStart: reader }),
      error => error.code === 'HUB_LOCK_TIMEOUT',
    );
    assert.ok(reader.calls.includes(process.pid), `the holder pid was read through the seam (${reader.calls.join(',')})`);
    // The holder's pid now reads as another process through the seam: the Lease is stale to this acquire and is taken over.
    const gone = spy('reused pid');
    const taken = await acquireLease('s24', { holder: 'agent-b', why: 'next', forMs: 600_000, id: 'next', waitMs: 0, env: s.env, log: () => {}, processStart: gone });
    assert.equal(taken.lease_id, 'next');
    releaseLease('s24', 'next', { env: s.env });
  } finally { s.cleanup(); }
});

test('a Pool take that finds its member held by a holder-pid Lease judges it through the reader it was given', async () => {
  const s = scratch();
  try {
    await acquireLease('s24', { holder: 'agent-a', why: 'proof', forMs: 3_600_000, id: 'held', holderPid: process.pid, env: s.env, log: () => {} });
    const reader = spy(processStart(process.pid));
    await assert.rejects(
      acquirePool('phone', ['s24'], { holder: 'agent-b', why: 'next', forMs: 600_000, id: 'next', waitMs: 0, env: s.env, log: () => {}, processStart: reader }),
      error => error.code === 'HUB_LOCK_TIMEOUT',
    );
    assert.ok(reader.calls.includes(process.pid), `the holder pid was read through the seam (${reader.calls.join(',')})`);
    const taken = await acquirePool('phone', ['s24'], { holder: 'agent-b', why: 'next', forMs: 600_000, id: 'next', waitMs: 0, env: s.env, log: () => {}, processStart: spy('reused pid') });
    assert.deepEqual([taken.name, taken.record.lease_id], ['s24', 'next'], 'the holder reads as gone through the seam only: the member is taken over');
    releaseLease('s24', 'next', { env: s.env });
  } finally { s.cleanup(); }
});

test('a service force-release finds the Lease through the context\'s processStart', async () => {
  const s = scratch();
  try {
    await acquireLease('s24', { holder: 'agent-a', why: 'proof', forMs: 3_600_000, id: 'held', holderPid: process.pid, env: s.env, log: () => {} });
    const starts = spy(() => processStart(process.pid));
    const ctx = createContext({ env: s.env, now: Date.now, sleep: () => Promise.resolve(), policy: loadPolicy().policy, fleet: loadFleet(s.env, { warn: () => {} }), processStart: starts });
    forceReleaseLease('held', { actor: { holder: 'operator', via: 'api' }, why: 'proof' }, ctx);
    assert.ok(starts.calls.includes(process.pid), `the Lease holder pid went through the context's reader (${starts.calls.join(',')})`);
    assert.equal(liveLease('s24', { env: s.env }), null, 'the Lease is gone');
  } finally { s.cleanup(); }
});

test('statusView reads every process start through the context\'s readers: lock and ticket pids through processStart, emulator pids through liveStart', async () => {
  const s = scratch();
  try {
    await acquireLease('s24', { holder: 'agent-a', why: 'proof', forMs: 3_600_000, id: 'held', holderPid: process.pid, env: s.env, log: () => {} });
    // A waiter ticket on adb (the s26 lock) from another live process (the parent): a ticket is judged by its pid's start.
    const queue = join(s.env.HUB_LOCK_DIR, 'adb.queue');
    mkdirSync(queue, { recursive: true });
    const T = Date.now();
    writeFileSync(join(queue, `${String(T).padStart(15, '0')}-000001-00000001.json`), JSON.stringify(buildTicket('lease', {
      env: s.env, requested: T, holder: 'waiter', why: 'queued', lease_id: 'w-1', pid: process.ppid, expires_at: new Date(T + 3_600_000).toISOString(), processStart: () => 'ticket-start',
    })));
    const ticketPid = JSON.parse(readFileSync(join(queue, readdirSync(queue)[0]), 'utf8')).pid;
    assert.equal(ticketPid, process.ppid, 'a live pid other than the holder');
    const dir = join(s.env.HUB_LOCK_DIR, 'emulators');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'e-aaaaaaaaaaaa.json'), JSON.stringify({
      lease_id: 'e-aaaaaaaaaaaa', slot: 'emulator-1', profile: 'default', serial: 'emulator-5554', console_port: 5554, adb_server_port: 15170, avd: { name: 'hub-a' }, created_at: '2026-11-25T10:00:00Z',
      pids: [{ pid: 424242, start: 'E1', role: 'emulator' }],
    }));
    const starts = spy(() => processStart(process.pid));
    const lives = spy('E1');
    const ctx = createContext({
      env: s.env, now: Date.now, sleep: () => Promise.resolve(), policy: loadPolicy().policy, fleet: loadFleet(s.env, { warn: () => {} }),
      inventory: () => ({ adb_servers: [], emulators: [], xvfb: [] }), adbWire: fakeWire({ listed: [] }), processStart: starts, liveStart: lives,
    });
    const view = await statusView('linux', { audience: 'local' }, ctx);
    assert.ok(starts.calls.includes(process.pid), `the Lease holder pid went through processStart (${starts.calls.join(',')})`);
    assert.ok(starts.calls.includes(ticketPid), 'the ticket pid went through processStart');
    assert.deepEqual(lives.calls, [424242], 'the emulator pid went through liveStart');
    assert.equal(view.emulators[0].pids[0].alive, true);
    releaseLease('s24', 'held', { env: s.env });
  } finally { s.cleanup(); }
});
