// Story 7.8: force-release of an emulator slot, `hub-device force-release emulator-<n> --why` and `POST /leases/emulator-<n>/force-release`, every row of
// the story's matrix. The CLI side runs in-process through main() and, for the seams (`afterStep`, `beforeRetire`), through the Claims function both
// front doors call; the API side runs through handle() with the real worker thread (emulator-thread.mjs). The emulators are the fakes of
// tools/device/emulator-fixtures.mjs (real processes, a temp SDK, HOME and lock dir): no real emulator, AVD, adb server or `heavy`, no port bound
// by a service. The worker cannot take a fake clock, so these tests use the real one.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadDevices } from '../ci/lib/devices.mjs';
import { readEvents } from '../ci/lib/events.mjs';
import { loadPolicy } from '../ci/lib/policy.mjs';
import { withLock } from '../ci/lib/lock.mjs';
import { hermetic } from '../ci/test-fixtures.mjs';
import { createContext, exitCodeOf, forceReleaseEmulator, httpAnswerOf, isEmulatorSlot, namesEmulatorSlot } from '../device/claims.mjs';
import { liveStart, reap } from '../device/emulator.mjs';
import { THREAD_OPS } from '../device/emulator-thread.mjs';
import { fixture } from '../device/emulator-fixtures.mjs';
import { ROUTES, handle } from './routes.mjs';

hermetic();

const policy = loadPolicy().policy;
const settle = ms => new Promise(done => setTimeout(done, ms));
const gone = pid => liveStart(pid) === null;
const NODE = process.execPath;
const tool = fileURLToPath(new URL('../device/hub-device.mjs', import.meta.url));
const waitFor = async (check, ms = 5000) => { for (const end = Date.now() + ms; Date.now() < end && !check();) await settle(20); return check(); };
const ACTOR = { holder: 'ops', via: 'cli' };

// A fixture with its own port ranges (this file runs beside emulator.test.mjs and emulator-lease.test.mjs) and a pool of one slot: the pool file
// is read by the CLI and by a service alike.
function scratch() {
  const f = fixture();
  Object.assign(f.env, { HUB_EMULATOR_ADB_PORTS: '25200-25299', HUB_EMULATOR_CONSOLE_PORTS: '5800-5898' });
  mkdirSync(f.env.HUB_LOCK_DIR, { recursive: true });
  writeFileSync(join(f.env.HUB_LOCK_DIR, 'emulator-pool'), '1\n');
  const lines = [];
  const devices = structuredClone(loadDevices({}));
  const s = {
    ...f, lines,
    ctx: (more = {}) => ({ env: f.env, policy, routes: ROUTES, hostId: 'test-host', devices, qaDevices: () => [], log: { out: line => lines.push(line), err: line => lines.push(line) }, ...more }),
    api: (id, body = { why: 'stuck', holder: 'ops' }, more = {}) => handle({ method: 'POST', url: `/leases/${id}/force-release`, body }, s.ctx(more)),
    // The Claims function itself, in this process: the seams (`afterStep`, `beforeRetire`) go through the context.
    direct: (id, extra = {}, input = { why: 'stuck', actor: ACTOR }) => forceReleaseEmulator(id, input, { ...createContext({ env: f.env, policy, qaDevices: () => [] }), ...extra }),
    lease: async (id, holder = 'agent-a') => {
      const taken = await f.run(['lease', 'emulator', '--for', '30m', '--why', 'proof', '--wait', '0s', '--holder', holder, '--id', id, '--json']);
      assert.equal(taken.code, 0, taken.err.join('\n'));
      return JSON.parse(taken.out[0]);
    },
    events: () => [...readEvents({ env: f.env })],
    forced: () => [...readEvents({ env: f.env })].filter(event => event.event === 'force-release'),
    // What happened to a Lease on its slot, in order.
    slotEvents: (id, lock = 'emulator-1') => [...readEvents({ env: f.env })].filter(event => event.lease_id === id && event.lock === lock).map(event => event.event),
    ownerExists: name => existsSync(join(f.env.HUB_LOCK_DIR, `${name}.lock`, 'owner.json')),
    entries: () => readdirSync(f.env.HUB_LOCK_DIR).sort(),
    footprint: () => JSON.stringify([readdirSync(f.env.HUB_LOCK_DIR).sort(), readdirSync(join(f.env.HUB_LOCK_DIR, 'emulators')).sort(), [...readEvents({ env: f.env })].length]),
    pids: id => f.record(id).pids.map(entry => entry.pid),
    // Every process the fakes started is gone, helpers included.
    gone: () => {
      for (const file of readdirSync(f.state).filter(name => /^(emulator|adb-server)-\d+\.json$/.test(name))) assert.ok(gone(JSON.parse(readFileSync(join(f.state, file), 'utf8')).pid), `${file} is gone`);
      for (const file of readdirSync(f.state).filter(name => /^(late-)?helper-\d+\.pid$/.test(name))) assert.ok(gone(Number(readFileSync(join(f.state, file), 'utf8'))), `${file} is gone`);
    },
  };
  return s;
}

const problemOf = answer => [answer.status, answer.body.code, answer.body.exit, answer.body.reason];
// An event as the parity of the two front doors compares it: no clock, no front door, no duration (a wait's `waited_ms` is the clock too).
const normal = ({ ts: _ts, held_ms: _held, waited_ms: _waited, expires_at: _expires, deadline_at: _deadline, for_ms: _for, actor, ...rest }) => ({ ...rest, actor: actor ? { holder: actor.holder } : actor });

test('the dispatch and the slot rule: emulator-1 to emulator-8 are slots, a slot-shaped id outside them is refused by Claims, the gate and lease ids are not slots', () => {
  for (const slot of ['emulator-1', 'emulator-2', 'emulator-8']) assert.deepEqual([isEmulatorSlot(slot), namesEmulatorSlot(slot)], [true, true], slot);
  for (const bad of ['emulator-0', 'emulator-9', 'emulator-01', 'emulator-10']) assert.deepEqual([isEmulatorSlot(bad), namesEmulatorSlot(bad)], [false, true], bad);
  for (const other of ['emulator', 'emulator-reaper', 'e-0123456789ab', 's24', '', null, undefined]) assert.deepEqual([isEmulatorSlot(other), namesEmulatorSlot(other)], [false, false], String(other));
  assert.ok(THREAD_OPS.includes('force-release'));
});

test('CLI happy path: the line names the slot, the Lease and its holder; the slot, the record, the processes and the folders are gone; exactly one force-release event and no release', async () => {
  const s = scratch();
  try {
    const leased = await s.lease('force-a');
    assert.equal(leased.slot, 'emulator-1');
    const pids = s.pids('force-a');
    assert.ok(pids.length >= 2 && pids.every(pid => !gone(pid)), 'the emulator is running');
    const done = await s.run(['force-release', 'emulator-1', '--why', 'stuck', '--holder', 'ops']);
    assert.deepEqual([done.code, done.out], [0, ['HUB_DEVICE_FORCE_RELEASED emulator-1 force-a holder=agent-a']], done.err.join('\n'));
    assert.equal(s.ownerExists('emulator-1'), false, 'the slot lock is gone');
    assert.equal(existsSync(join(s.env.HUB_LOCK_DIR, 'emulator-reaper.lock')), false, 'the reaper lock is released');
    for (const pid of pids) assert.ok(gone(pid), `${pid} is dead`);
    s.clean();
    s.gone();
    const [force] = s.forced();
    assert.equal(s.forced().length, 1);
    assert.deepEqual([force.lease_id, force.hold_kind, force.lock, force.actor, force.why], ['force-a', 'lease', 'emulator-1', { holder: 'ops', via: 'cli' }, 'stuck']);
    assert.deepEqual(s.slotEvents('force-a'), ['acquire', 'force-release'], 'no release, no reclaim');
    // The reap that follows finds nothing to do and writes nothing.
    const before = s.events().length;
    assert.deepEqual(await reap({ env: s.env, graceMs: 400 }), []);
    assert.equal(s.events().length, before);
  } finally { s.cleanup(); }
});

test('API happy path: 200 ForceRelease for the Lease that held the slot, the teardown ran in a worker, one force-release event with the api actor', async () => {
  const s = scratch();
  try {
    await s.lease('force-a');
    const pids = s.pids('force-a');
    const answer = await s.api('emulator-1');
    assert.equal(answer.status, 200, JSON.stringify(answer.body));
    assert.equal(answer.headers['Cache-Control'], 'no-store');
    assert.deepEqual(answer.body, { lease_id: 'force-a', outcome: 'force-released', resource: 'emulator', lock: 'emulator-1', device: 'emulator', holder: 'agent-a', why: 'stuck' });
    assert.ok(s.lines.some(line => /^HUB_EMULATOR_THREAD force-release emulator-1 thread=[1-9]\d*$/.test(line)), `the force ran in a worker: ${s.lines.join(' | ')}`);
    assert.equal(s.ownerExists('emulator-1'), false);
    for (const pid of pids) assert.ok(gone(pid), `${pid} is dead`);
    s.clean();
    s.gone();
    const [force] = s.forced();
    assert.equal(s.forced().length, 1);
    assert.deepEqual([force.lease_id, force.hold_kind, force.actor, force.why], ['force-a', 'lease', { holder: 'ops', via: 'api' }, 'stuck']);
    assert.deepEqual(s.slotEvents('force-a'), ['acquire', 'force-release']);
  } finally { s.cleanup(); }
});

test('an API Lease (holder_pid null) is ended the same way', async () => {
  const s = scratch();
  try {
    const taken = await handle({ method: 'POST', url: '/leases', body: { resource: 'emulator', for_ms: 30 * 60_000, holder: 'agent-a', why: 'proof', id: 'api-a' } }, s.ctx());
    assert.equal(taken.status, 200, JSON.stringify(taken.body));
    assert.equal(s.owner('emulator-1').holder_pid, null);
    const answer = await s.api('emulator-1');
    assert.equal(answer.status, 200, JSON.stringify(answer.body));
    assert.equal(answer.body.lease_id, 'api-a');
    s.clean();
    s.gone();
    assert.deepEqual(s.slotEvents('api-a'), ['acquire', 'force-release']);
  } finally { s.cleanup(); }
});

test('parity: the same setup forced through the CLI and through the API leaves equal answers and equal events (minus the clocks and actor.via)', async () => {
  const cli = scratch();
  const api = scratch();
  try {
    await cli.lease('par-1');
    await api.lease('par-1');
    const printed = await cli.run(['force-release', 'emulator-1', '--why', 'stuck', '--holder', 'ops', '--json']);
    assert.equal(printed.code, 0, printed.err.join('\n'));
    const answer = await api.api('emulator-1');
    assert.equal(answer.status, 200, JSON.stringify(answer.body));
    assert.deepEqual(JSON.parse(printed.out[0]), answer.body);
    assert.deepEqual(cli.events().filter(event => event.lock === 'emulator-1').map(normal), api.events().filter(event => event.lock === 'emulator-1').map(normal));
    assert.deepEqual([cli.forced().length, api.forced().length], [1, 1]);
    assert.deepEqual([cli.forced()[0].actor.via, api.forced()[0].actor.via], ['cli', 'api']);
    for (const s of [cli, api]) { s.clean(); s.gone(); }
  } finally { cli.cleanup(); api.cleanup(); }
});

test('the next lease: the slot is clean and free, and status lists no waiter or Hold of the forced Lease', async () => {
  const s = scratch();
  try {
    await s.lease('force-a');
    assert.equal((await s.run(['force-release', 'emulator-1', '--why', 'stuck'])).code, 0);
    const next = await s.lease('force-b', 'agent-b');
    assert.equal(next.slot, 'emulator-1');
    assert.deepEqual(s.records(), ['force-b.json'], 'a new record for the new Lease only');
    assert.equal(s.owner('emulator-1').lease_id, 'force-b');
    const status = await s.run(['status', '--json']);
    assert.equal(status.code, 0, status.err.join('\n'));
    assert.ok(!status.out.join('\n').includes('force-a'), 'status shows nothing of the forced Lease');
    assert.equal((await s.run(['release', 'emulator', 'force-b'])).code, 0);
    s.clean();
  } finally { s.cleanup(); }
});

test('the order is observable: read, then the force under the reaper lock, then the teardown, then the lock goes', async () => {
  const s = scratch();
  try {
    await s.lease('force-a');
    const pids = s.pids('force-a');
    const seen = [];
    const reaper = () => existsSync(join(s.env.HUB_LOCK_DIR, 'emulator-reaper.lock', 'owner.json'));
    const answer = await s.direct('emulator-1', {
      afterStep: step => {
        seen.push([step, reaper(), s.ownerExists('emulator-1'), s.forced().length, s.records().length, pids.every(pid => gone(pid))]);
      },
    });
    assert.equal(answer.lease_id, 'force-a');
    assert.deepEqual(seen, [
      ['read', false, true, 0, 1, false],
      ['force-release', true, false, 1, 1, false],
      ['teardown', true, false, 1, 0, true],
    ]);
    assert.equal(reaper(), false, 'the reaper lock is released at the end');
    assert.deepEqual(s.slotEvents('force-a'), ['acquire', 'force-release']);
    s.clean();
  } finally { s.cleanup(); }
});

test('a crash after the force leaves an ownerless record: the slot is unclaimable while it exists, and the next reap tears it down as an orphan with no second event', async () => {
  const s = scratch();
  try {
    await s.lease('force-a');
    const record = s.record('force-a');
    const script = `
      import { loadPolicy } from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, '../ci/lib/policy.mjs')).href)};
      import { forceReleaseEmulator } from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, '../device/claims.mjs')).href)};
      await forceReleaseEmulator('emulator-1', { why: 'stuck', actor: { holder: 'ops', via: 'cli' } }, { env: process.env, policy: loadPolicy().policy, log: () => {}, warn: () => {}, afterStep: step => { if (step === 'force-release') process.exit(7); } });
    `;
    const child = spawn(NODE, ['--input-type=module', '-e', script], { env: s.env, stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    child.stderr.on('data', chunk => { err += chunk; });
    const code = await new Promise(done => child.on('close', done));
    assert.equal(code, 7, err);
    assert.equal(s.ownerExists('emulator-1'), false, 'the slot lock is gone');
    assert.deepEqual(s.records(), ['force-a.json'], 'the record is left');
    assert.ok(record.pids.some(entry => !gone(entry.pid)), 'the emulator is still running');
    assert.equal(s.forced().length, 1);
    assert.ok(existsSync(join(s.env.HUB_LOCK_DIR, 'emulator-reaper.lock')), 'the reaper lock is left held by the dead process');

    // Another process holds the reaper (reclaiming the dead one's): the slot is not claimable while its record exists.
    let release = () => {};
    const held = withLock('emulator-reaper', () => new Promise(resolve => { release = resolve; }), { env: s.env, log: () => {} });
    await settle(50);
    try {
      const busy = await s.run(['lease', 'emulator', '--for', '1m', '--why', 'now', '--wait', '0']);
      assert.equal(busy.code, 76, busy.err.join('\n'));
      assert.match(busy.err.join('\n'), /the emulator pool is full \(1 of 1: /);
    } finally { release(); await held; }
    assert.deepEqual(s.records(), ['force-a.json'], 'still there');

    const log = [];
    const results = await reap({ env: s.env, log: line => log.push(line), graceMs: 400 });
    assert.equal(results.length, 1);
    assert.equal(results[0].why, 'orphaned');
    assert.match(log.join('\n'), /^HUB_EMULATOR_REAPED force-a emulator-1 \(orphaned\)/m);
    for (const entry of record.pids) assert.ok(gone(entry.pid), `${entry.role} ${entry.pid} is gone`);
    s.clean();
    s.gone();
    assert.deepEqual(s.slotEvents('force-a'), ['acquire', 'force-release'], 'one hold-ending event, from the force');
    assert.equal(existsSync(join(s.env.HUB_LOCK_DIR, 'emulator-reaper.lock')), false);
  } finally { s.cleanup(); }
});

test('a failure after the read changes nothing; one after the teardown has done everything, once, and the reaper lock is reclaimable', async () => {
  const s = scratch();
  try {
    await s.lease('force-a');
    const before = s.footprint();
    await assert.rejects(s.direct('emulator-1', { afterStep: step => { if (step === 'read') throw new Error('seam: after read'); } }), /seam: after read/);
    assert.equal(s.footprint(), before, 'nothing changed');
    assert.ok(s.ownerExists('emulator-1'));
    assert.deepEqual(s.forced(), []);

    await assert.rejects(s.direct('emulator-1', { afterStep: step => { if (step === 'teardown') throw new Error('seam: after teardown'); } }), /seam: after teardown/);
    assert.equal(s.ownerExists('emulator-1'), false);
    s.clean();
    s.gone();
    assert.equal(s.forced().length, 1);
    assert.equal(existsSync(join(s.env.HUB_LOCK_DIR, 'emulator-reaper.lock')), false, 'the reaper lock is released');
    assert.deepEqual(await reap({ env: s.env, graceMs: 400 }), []);
    assert.deepEqual(s.slotEvents('force-a'), ['acquire', 'force-release']);
  } finally { s.cleanup(); }
});

test('an empty slot is 404 HUB_LEASE_NOT_FOUND (unknown), exit 2; nothing is written', async () => {
  const s = scratch();
  try {
    await s.lease('force-a');
    assert.equal((await s.run(['force-release', 'emulator-1', '--why', 'first'])).code, 0);
    s.clean();
    const before = s.events().length;
    const cli = await s.run(['force-release', 'emulator-1', '--why', 'again']);
    assert.deepEqual([cli.code, cli.out, cli.err[0].startsWith('HUB_LEASE_NOT_FOUND ')], [2, [], true], cli.err.join('\n'));
    assert.deepEqual(problemOf(await s.api('emulator-1')), [404, 'HUB_LEASE_NOT_FOUND', 2, 'unknown']);
    assert.deepEqual(problemOf(await s.api('emulator-2')), [404, 'HUB_LEASE_NOT_FOUND', 2, 'unknown']);
    assert.equal(s.events().length, before);
    assert.equal(s.forced().length, 1);
  } finally { s.cleanup(); }
});

test('a slot being taken (a lock with no owner record) is 409 HUB_LEASE_LOST being-taken, exit 1; nothing is written', async () => {
  const s = scratch();
  try {
    mkdirSync(join(s.env.HUB_LOCK_DIR, 'emulator-1.lock'));
    const entries = s.entries();
    const cli = await s.run(['force-release', 'emulator-1', '--why', 'x']);
    assert.deepEqual([cli.code, cli.out], [1, []], cli.err.join('\n'));
    assert.match(cli.err.join('\n'), /emulator-1 is being taken/);
    assert.deepEqual(problemOf(await s.api('emulator-1')), [409, 'HUB_LEASE_LOST', 1, 'being-taken']);
    assert.deepEqual(s.entries(), entries);
    assert.deepEqual(s.events(), []);
  } finally { s.cleanup(); }
});

test('an owner replaced between the read and the rename is 409 HUB_LEASE_LOST changed-hands: no event, nothing torn down, the new owner stays', async () => {
  const s = scratch();
  try {
    await s.lease('force-a');
    const pids = s.pids('force-a');
    const owner = s.owner('emulator-1');
    const replace = stage => { if (stage === 'rename') writeFileSync(join(s.env.HUB_LOCK_DIR, 'emulator-1.lock', 'owner.json'), JSON.stringify({ ...owner, lease_id: 'z-9', holder: 'someone-else' })); };
    await assert.rejects(s.direct('emulator-1', { beforeRetire: replace }), error => error.code === 'HUB_LEASE_LOST' && error.reason === 'changed-hands' && httpAnswerOf(error).status === 409 && exitCodeOf(error) === 1);
    assert.equal(s.owner('emulator-1').lease_id, 'z-9', 'the new owner is untouched');
    assert.deepEqual(s.forced(), []);
    assert.deepEqual(s.records(), ['force-a.json'], 'nothing torn down');
    for (const pid of pids) assert.ok(!gone(pid), `${pid} still runs`);
    assert.equal(existsSync(join(s.env.HUB_LOCK_DIR, 'emulator-reaper.lock')), false);
    // The record no longer matches its slot: the next reap tears it down as an orphan.
    const results = await reap({ env: s.env, graceMs: 400 });
    assert.deepEqual(results.map(result => result.why), ['orphaned']);
    s.clean();
  } finally { s.cleanup(); }
});

test('a Job Hold on a slot is never force-released: HUB_FORCE_RELEASE_JOB', async () => {
  const s = scratch();
  try {
    const dir = join(s.env.HUB_LOCK_DIR, 'emulator-1.lock');
    mkdirSync(dir);
    writeFileSync(join(dir, 'owner.json'), JSON.stringify({ format: 1, kind: 'job', pid: process.pid, host: 'h', repo: 'o/r', run: '41', job: 'android', started_at: new Date().toISOString() }));
    const answer = await s.api('emulator-1');
    assert.deepEqual(problemOf(answer), [409, 'HUB_FORCE_RELEASE_JOB', 2, 'job']);
    assert.match(answer.body.detail, /gh run cancel 41 --repo o\/r/);
    assert.deepEqual(s.forced(), []);
  } finally { s.cleanup(); }
});

test('a recorded process that survives: the force stands (event written, slot gone), HUB_EMULATOR_FAILED naming the survivors, the record is kept', { skip: process.getuid?.() === 0 ? 'root can signal pid 1' : false }, async () => {
  const s = scratch();
  try {
    await s.lease('force-a');
    // Pid 1 is a process nobody of this test may signal: a recorded process that outlives SIGKILL.
    const record = s.record('force-a');
    writeFileSync(join(s.env.HUB_LOCK_DIR, 'emulators', 'force-a.json'), JSON.stringify({ ...record, pids: [...record.pids, { pid: 1, start: liveStart(1), role: 'helper', program: 'init' }] }));
    await assert.rejects(s.direct('emulator-1'), error => error.code === 'HUB_EMULATOR_FAILED' && /force-release stands/.test(error.message) && /pids 1 would not stop/.test(error.message) && httpAnswerOf(error).status === 503 && exitCodeOf(error) === 1);
    assert.equal(s.ownerExists('emulator-1'), false, 'the slot is gone');
    assert.equal(s.forced().length, 1, 'the event is written');
    assert.deepEqual(s.records(), ['force-a.json'], 'the record stays, so the slot stays out of the pool');
    assert.deepEqual(s.slotEvents('force-a'), ['acquire', 'force-release']);
    assert.equal(existsSync(join(s.env.HUB_LOCK_DIR, 'emulator-reaper.lock')), false);
    for (const entry of record.pids) assert.ok(gone(entry.pid), 'the processes it could stop are stopped');
  } finally { s.cleanup(); }
});

test('through a service a worker that reports survivors, or breaks, is 503 HUB_EMULATOR_FAILED; the force stands', async () => {
  const s = scratch();
  try {
    await s.lease('force-a');
    const owner = s.owner('emulator-1');
    const stuck = async () => ({ released: true, reason: null, owner, outcome: 'stuck', survivors: [4242] });
    const answer = await s.api('emulator-1', undefined, { forceReleaseOffThread: stuck });
    assert.deepEqual(problemOf(answer), [503, 'HUB_EMULATOR_FAILED', 1, 'emulator-failed']);
    assert.match(answer.body.detail, /force-release stands.*pids 4242 would not stop/);
    const broken = async () => { throw new Error('the worker broke'); };
    const failed = await s.api('emulator-1', undefined, { forceReleaseOffThread: broken });
    assert.deepEqual(problemOf(failed), [503, 'HUB_EMULATOR_FAILED', 1, 'emulator-failed']);
    assert.match(failed.body.detail, /the worker broke/);
    // The lost results map as they do in process.
    const lost = reason => s.api('emulator-1', undefined, { forceReleaseOffThread: async () => ({ released: false, reason, owner: null, outcome: null, survivors: [] }) });
    assert.deepEqual(problemOf(await lost('none')), [404, 'HUB_LEASE_NOT_FOUND', 2, 'unknown']);
    assert.deepEqual(problemOf(await lost('unknown-holder')), [409, 'HUB_LEASE_LOST', 1, 'being-taken']);
    assert.deepEqual(problemOf(await lost('changed')), [409, 'HUB_LEASE_LOST', 1, 'changed-hands']);
    assert.deepEqual(problemOf(await lost('other-lease')), [409, 'HUB_LEASE_LOST', 1, 'changed-hands']);
    assert.deepEqual(s.forced(), [], 'the stand-ins wrote nothing');
    assert.equal((await s.api('emulator-1')).status, 200, 'the real worker still forces it');
    s.clean();
  } finally { s.cleanup(); }
});

test('another teardown holding the reaper lock past the wait is HUB_LOCK_TIMEOUT (exit 76) through both front doors; nothing is written', async () => {
  const s = scratch();
  let release = () => {};
  let held = Promise.resolve();
  try {
    await s.lease('force-a');
    held = withLock('emulator-reaper', () => new Promise(resolve => { release = resolve; }), { env: s.env, log: () => {} });
    await settle(50);
    const before = s.footprint();
    const env = { ...s.env, HUB_EMULATOR_REAPER_WAIT_MS: '300' };
    const cli = await s.run(['force-release', 'emulator-1', '--why', 'stuck'], { env });
    assert.deepEqual([cli.code, cli.out], [76, []], cli.err.join('\n'));
    assert.match(cli.err.join('\n'), /host lock emulator-reaper is held/);
    const answer = await s.api('emulator-1', undefined, { env });
    assert.deepEqual(problemOf(answer), [409, 'HUB_LOCK_TIMEOUT', 76, 'busy']);
    assert.equal(s.footprint(), before, 'nothing was written');
    assert.ok(s.ownerExists('emulator-1'));
  } finally { release(); await held; }
  try {
    assert.equal((await s.api('emulator-1')).status, 200, 'once the reaper is free the force goes through');
    s.clean();
  } finally { s.cleanup(); }
});

test('bad input: a slot outside emulator-1 to emulator-8, a missing or empty why, and no actor are 400 HUB_USAGE (exit 2) before anything is read', async () => {
  const s = scratch();
  try {
    await s.lease('force-a');
    const before = s.footprint();
    for (const bad of ['emulator-0', 'emulator-9', 'emulator-01']) {
      assert.deepEqual(problemOf(await s.api(bad)), [400, 'HUB_USAGE', 2, 'bad-slot'], bad);
      const cli = await s.run(['force-release', bad, '--why', 'x']);
      assert.deepEqual([cli.code, cli.out], [2, []], bad);
      assert.match(cli.err.join('\n'), /not an emulator slot/);
    }
    assert.deepEqual(problemOf(await s.api('emulator-1', { holder: 'ops' })), [400, 'HUB_USAGE', 2, 'no-why']);
    assert.deepEqual(problemOf(await s.api('emulator-1', { why: '  ', holder: 'ops' })), [400, 'HUB_USAGE', 2, 'bad-why']);
    assert.deepEqual(problemOf(await s.api('emulator-1', { why: 'x' })), [400, 'HUB_USAGE', 2, 'no-holder']);
    assert.equal((await s.run(['force-release', 'emulator-1'])).code, 2);
    assert.equal((await s.run(['force-release', 'emulator-1', '--why', ' '])).code, 2);
    await assert.rejects(s.direct('emulator-1', {}, { why: 'x' }), /names its actor/);
    await assert.rejects(s.direct('emulator-1', {}, { why: '', actor: ACTOR }), error => error.code === 'HUB_USAGE' && error.reason === 'bad-why');
    assert.equal(s.footprint(), before, 'nothing changed');
    assert.ok(s.ownerExists('emulator-1'));
  } finally { s.cleanup(); }
});

test('an emulator lease id is still refused by the Lease force-release (Story 7.6), now pointing at the slot route too', async () => {
  const s = scratch();
  try {
    await s.lease('force-a');
    const answer = await s.api('force-a');
    assert.deepEqual(problemOf(answer), [400, 'HUB_USAGE', 2, 'emulator']);
    assert.match(answer.body.detail, /force-release emulator-1/);
    assert.match(answer.body.detail, /POST \/leases\/emulator-1\/force-release/);
    assert.deepEqual(s.forced(), []);
    assert.equal((await s.run(['release', 'emulator', 'force-a'])).code, 0);
    s.clean();
  } finally { s.cleanup(); }
});

test('forcing a slot whose emulator is still booting ends the maker as CANCELLED (not a crashed emulator); everything it made is gone, with one force-release event', async () => {
  const s = scratch();
  try {
    const id = 'booting-a';
    const child = spawn(NODE, [tool, 'lease', 'emulator', '--for', '10m', '--why', 'booting', '--id', id], { env: { ...s.env, FAKE_BOOT_MS: '60000' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    child.stdout.resume();
    child.stderr.on('data', chunk => { err += chunk; });
    const exit = new Promise(done => child.on('close', (code, signal) => done({ code, signal })));
    assert.ok(await waitFor(() => readdirSync(s.state).some(name => /^helper-\d+\.pid$/.test(name))), 'the emulator is booting');
    const record = s.record(id);
    const forced = await s.run(['force-release', 'emulator-1', '--why', 'stuck']);
    assert.equal(forced.code, 0, forced.err.join('\n'));
    assert.match(forced.out.join('\n'), new RegExp(`^HUB_DEVICE_FORCE_RELEASED emulator-1 ${id} holder=\\S+$`));
    const result = await exit;
    assert.equal(result.code, 1, err);
    assert.match(err, new RegExp(`^HUB_DEVICE_CANCELLED emulator lease ${id} was released while its emulator was being made$`, 'm'));
    assert.doesNotMatch(err, /exited while booting/);
    for (const entry of record.pids) assert.ok(gone(entry.pid), `${entry.role} ${entry.pid} is gone`);
    s.clean();
    s.gone();
    assert.equal(s.ownerExists('emulator-1'), false, 'no slot lock');
    assert.equal(existsSync(join(s.env.HUB_LOCK_DIR, 'emulator-reaper.lock')), false, 'the reaper lock is free');
    assert.deepEqual(s.slotEvents(id), ['acquire', 'force-release']);
  } finally { s.cleanup(); }
});

test('a Lease whose emulator record is gone is still force-released: the slot ends with one event and nothing is torn down', async () => {
  const s = scratch();
  try {
    await s.lease('force-a');
    for (const entry of s.record('force-a').pids) { try { process.kill(entry.pid, 'SIGKILL'); } catch { /* gone */ } }
    rmSync(join(s.env.HUB_LOCK_DIR, 'emulators', 'force-a.json'));
    assert.deepEqual(s.records(), []);
    const done = await s.run(['force-release', 'emulator-1', '--why', 'stuck']);
    assert.equal(done.code, 0, done.err.join('\n'));
    assert.match(done.out[0], /^HUB_DEVICE_FORCE_RELEASED emulator-1 force-a holder=/);
    assert.equal(s.ownerExists('emulator-1'), false);
    assert.equal(s.forced().length, 1);
    assert.deepEqual(s.slotEvents('force-a'), ['acquire', 'force-release']);
    assert.equal(existsSync(join(s.env.HUB_LOCK_DIR, 'emulator-reaper.lock')), false);
  } finally { s.cleanup(); }
});
