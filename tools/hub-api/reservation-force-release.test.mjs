// Story 7.7: POST /reservations/{run_key}/force-release through handle(), and hub-device force-release --reservation through main(), on temp lock and
// event dirs: every row of the story's matrix, the lock-level `releaseReservation` with an actor, and the parity of the two front doors (same answer,
// same directory, same events minus `ts` and `actor.via`). No port is bound; adb, emulators and the real socket are never touched.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadDevices } from '../ci/lib/devices.mjs';
import { readEvents } from '../ci/lib/events.mjs';
import { releaseReservation, reserve, resourceOf } from '../ci/lib/lock.mjs';
import { loadPolicy } from '../ci/lib/policy.mjs';
import { hermetic } from '../ci/test-fixtures.mjs';
import { releaseFor } from '../ci/commands/common.mjs';
import { forceReleaseReservation, releaseReservations } from '../device/claims.mjs';
import { main as hubDevice } from '../device/hub-device.mjs';
import { fakeWire } from '../device/wire-fixtures.mjs';
import { ROUTES, handle } from './routes.mjs';

hermetic();

const policy = loadPolicy().policy;
const T0 = Date.parse('2026-11-25T10:00:00Z');
const MIN = 60_000;
const KEY = 'acme--app--77';
const iso = ms => new Date(ms).toISOString();

function scratch() {
  const root = mkdtempSync(join(tmpdir(), 'hub-api-reservation-force-release-'));
  const env = { PATH: process.env.PATH, HOME: root, HUB_LOCK_DIR: join(root, 'locks'), HUB_EVENT_DIR: join(root, 'events') };
  const devices = structuredClone(loadDevices({}));
  const now = () => T0;
  const s = {
    root, env, now,
    ctx: (extra = {}) => ({ env, policy, routes: ROUTES, now, hostId: 'test-host', devices, qaDevices: () => [], hostKey: () => 'linux', log: { out: () => {}, err: () => {} }, ...extra }),
    api: (key, body) => handle({ method: 'POST', url: `/reservations/${encodeURIComponent(key)}/force-release`, body }, s.ctx()),
    cli: async argv => {
      const o = [];
      const e = [];
      const code = await hubDevice(argv, { env, stdout: line => o.push(line), stderr: line => e.push(line), inventory: () => ({ adb_servers: [], emulators: [], xvfb: [] }), adbWire: fakeWire({ listed: [] }), hostKey: () => 'linux', policy, qaDevices: () => [], now });
      return { code, out: o, err: e };
    },
    // Run acme/app#<run> reserves `lock` five minutes before T0.
    reserve: (run = '77', lock = 'adb', repo = 'acme/app', at = T0 - 5 * MIN) => reserve(lock, { env: { ...env, GITHUB_REPOSITORY: repo, GITHUB_RUN_ID: run }, now: () => at, policy, log: () => {}, hostId: 'test-host' }),
    take: (body = {}) => handle({ method: 'POST', url: '/leases', body: { resource: 's26', for_ms: 10 * MIN, holder: 'agent-a', why: 'proof', ...body } }, s.ctx()),
    events: () => [...readEvents({ env })],
    forced: () => s.events().filter(event => event.event === 'force-release'),
    dir: (lock = 'adb') => join(env.HUB_LOCK_DIR, `${lock}.reservations`),
    entries: (lock = 'adb') => { try { return readdirSync(s.dir(lock)).sort(); } catch { return []; } },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
  return s;
}

const problemOf = answer => [answer.status, answer.body.code, answer.body.exit, answer.body.reason];
const strip = events => events.map(event => { const { ts, actor, ...rest } = event; return { ...rest, actor: actor ? { holder: actor.holder } : null }; });

test('happy path (API): the Reservation is gone, the answer is a ReservationForceRelease, one force-release event carries the actor and why', async () => {
  const s = scratch();
  try {
    s.reserve();
    assert.deepEqual(s.entries(), [KEY]);
    const answer = await s.api(KEY, { why: 'dead run', holder: 'ops' });
    assert.equal(answer.status, 200, JSON.stringify(answer.body));
    assert.equal(answer.headers['Cache-Control'], 'no-store');
    assert.deepEqual(answer.body, {
      run_key: KEY, outcome: 'force-released', repo: 'acme/app', run: '77',
      released: [{ lock: 'adb', resource: resourceOf('adb'), reserved_at: iso(T0 - 5 * MIN), expires_at: iso(T0 - 5 * MIN + 180 * MIN) }], why: 'dead run',
    });
    assert.deepEqual(s.entries(), [], 'the directory is gone and no .released-* is left');
    const [event, ...more] = s.forced();
    assert.equal(more.length, 0, 'one event');
    assert.deepEqual([event.lock, event.hold_kind, event.run_key, event.held_ms, event.actor, event.why, event.reason], ['adb', 'reservation', KEY, 5 * MIN, { holder: 'ops', via: 'api' }, 'dead run', null]);
    assert.deepEqual([event.claimant.kind, event.claimant.repo, event.claimant.run, event.claimant.attempt, event.claimant.job], ['deploy', 'acme/app', '77', null, null]);
    assert.equal(s.events().filter(e => e.event === 'release').length, 0, 'no plain release');
    // An actor given in the body is recorded as given.
    s.reserve('78');
    assert.equal((await s.api('acme--app--78', { why: 'x', actor: { holder: 'holocene', via: 'control-surface' } })).status, 200);
    assert.deepEqual(s.forced().at(-1).actor, { holder: 'holocene', via: 'control-surface' });
  } finally { s.cleanup(); }
});

test('happy path (CLI): one line per lock ended, exit 0; --json prints the same answer as the API', async () => {
  const s = scratch();
  try {
    s.reserve();
    const done = await s.cli(['force-release', '--reservation', KEY, '--why', 'dead run', '--holder', 'ops']);
    assert.deepEqual([done.code, done.out, done.err], [0, [`HUB_DEVICE_RESERVATION_FORCE_RELEASED adb ${KEY}`], []]);
    assert.deepEqual(s.entries(), []);
    assert.deepEqual([s.forced().length, s.forced()[0].actor, s.forced()[0].why], [1, { holder: 'ops', via: 'cli' }, 'dead run']);
    s.reserve();
    const json = await s.cli(['force-release', '--reservation', KEY, '--why', 'dead run', '--json']);
    assert.equal(json.code, 0);
    s.reserve();
    const api = await s.api(KEY, { why: 'dead run', holder: 'ops' });
    assert.deepEqual(JSON.parse(json.out.join('\n')), api.body);
  } finally { s.cleanup(); }
});

test('parity: the same setup through each front door gives equal answers and equal event logs, ignoring ts and actor.via', async () => {
  const viaApi = scratch();
  const viaCli = scratch();
  try {
    viaApi.reserve();
    viaCli.reserve();
    const api = await viaApi.api(KEY, { why: 'dead run', actor: { holder: 'ops', via: 'api' } });
    const cli = await viaCli.cli(['force-release', '--reservation', KEY, '--why', 'dead run', '--holder', 'ops', '--json']);
    assert.deepEqual(JSON.parse(cli.out.join('\n')), api.body);
    assert.deepEqual(strip(viaCli.events()), strip(viaApi.events()));
    assert.deepEqual(viaCli.entries(), viaApi.entries());
    assert.equal(viaApi.forced().length, 1);
    assert.deepEqual([viaApi.forced()[0].actor.via, viaCli.forced()[0].actor.via], ['api', 'cli']);
  } finally { viaApi.cleanup(); viaCli.cleanup(); }
});

test('name narrows to one lock; absent tries every reservable lock of this host and lists each one ended', async () => {
  const s = scratch();
  try {
    s.reserve('77', 'adb');
    s.reserve('77', 'mac-ios');
    assert.deepEqual(problemOf(await s.api(KEY, { why: 'x', holder: 'ops', name: 'bad' })), [400, 'HUB_USAGE', 2, 'bad-name']);
    assert.deepEqual(problemOf(await s.api(KEY, { why: 'x', holder: 'ops', name: '' })), [400, 'HUB_USAGE', 2, 'bad-name']);
    assert.deepEqual(problemOf(await s.api(KEY, { why: 'x', holder: 'ops', name: 5 })), [400, 'HUB_USAGE', 2, 'bad-name']);
    assert.equal((await s.cli(['force-release', '--reservation', KEY, '--why', 'x', '--name', 'ios'])).code, 2);
    assert.deepEqual([s.entries('adb'), s.entries('mac-ios'), s.forced().length], [[KEY], [KEY], 0], 'nothing written by a bad name');
    const one = await s.api(KEY, { why: 'x', holder: 'ops', name: 'mac-ios' });
    assert.deepEqual(one.body.released.map(hold => hold.lock), ['mac-ios']);
    assert.deepEqual([s.entries('adb'), s.entries('mac-ios')], [[KEY], []], 'only that lock was touched');
    s.reserve('77', 'mac-ios');
    const both = await s.cli(['force-release', '--reservation', KEY, '--why', 'x']);
    assert.deepEqual(both.out.sort(), [`HUB_DEVICE_RESERVATION_FORCE_RELEASED adb ${KEY}`, `HUB_DEVICE_RESERVATION_FORCE_RELEASED mac-ios ${KEY}`]);
    assert.deepEqual([s.entries('adb'), s.entries('mac-ios')], [[], []]);
    assert.equal(s.forced().length, 3);
    // `name` narrows a CLI call too, and the other lock is left alone.
    s.reserve('77', 'adb');
    s.reserve('77', 'mac-ios');
    const named = await s.cli(['force-release', '--reservation', KEY, '--why', 'x', '--name', 'adb']);
    assert.deepEqual([named.code, named.out, s.entries('adb'), s.entries('mac-ios')], [0, [`HUB_DEVICE_RESERVATION_FORCE_RELEASED adb ${KEY}`], [], [KEY]]);
  } finally { s.cleanup(); }
});

test('an empty or missing why is refused, through the API and the CLI, and nothing is written', async () => {
  const s = scratch();
  try {
    s.reserve();
    const before = s.events().length;
    assert.deepEqual(problemOf(await s.api(KEY, { why: '', holder: 'ops' })), [400, 'HUB_USAGE', 2, 'bad-why']);
    assert.deepEqual(problemOf(await s.api(KEY, { why: '   ', holder: 'ops' })), [400, 'HUB_USAGE', 2, 'bad-why']);
    assert.deepEqual(problemOf(await s.api(KEY, { why: 7, holder: 'ops' })), [400, 'HUB_USAGE', 2, 'bad-why']);
    assert.deepEqual(problemOf(await s.api(KEY, { holder: 'ops' })), [400, 'HUB_USAGE', 2, 'no-why']);
    const none = await s.cli(['force-release', '--reservation', KEY]);
    const empty = await s.cli(['force-release', '--reservation', KEY, '--why', '']);
    assert.deepEqual([none.code, empty.code], [2, 2]);
    assert.match(none.err.join('\n'), /why/);
    assert.deepEqual([s.entries(), s.events().length], [[KEY], before], 'the Reservation stands and no event was written');
  } finally { s.cleanup(); }
});

test('already released, never reserved or unreadable: 404 HUB_RESERVATION_NOT_FOUND (unknown), exit 2, no event', async () => {
  const s = scratch();
  try {
    assert.deepEqual(problemOf(await s.api(KEY, { why: 'x', holder: 'ops' })), [404, 'HUB_RESERVATION_NOT_FOUND', 2, 'unknown']);
    s.reserve();
    assert.equal((await s.api(KEY, { why: 'x', holder: 'ops' })).status, 200);
    const again = await s.api(KEY, { why: 'x', holder: 'ops' });
    assert.deepEqual(problemOf(again), [404, 'HUB_RESERVATION_NOT_FOUND', 2, 'unknown']);
    const cli = await s.cli(['force-release', '--reservation', KEY, '--why', 'x']);
    assert.deepEqual([cli.code, cli.out, cli.err[0].startsWith('HUB_RESERVATION_NOT_FOUND ')], [2, [], true]);
    // A record that cannot be read is no Reservation: left alone, 404.
    mkdirSync(join(s.dir(), 'acme--app--9'), { recursive: true });
    writeFileSync(join(s.dir(), 'acme--app--9', 'reservation.json'), '{not json');
    assert.deepEqual(problemOf(await s.api('acme--app--9', { why: 'x', holder: 'ops' })), [404, 'HUB_RESERVATION_NOT_FOUND', 2, 'unknown']);
    assert.deepEqual(s.entries(), ['acme--app--9']);
    assert.equal(s.forced().length, 1, 'one event in all');
  } finally { s.cleanup(); }
});

test('a bad run key is refused before anything is read', async () => {
  const s = scratch();
  try {
    s.reserve();
    for (const key of ['not-a-key', '../x', 'acme--app--', 'acme--app--7x']) {
      assert.deepEqual(problemOf(await s.api(key, { why: 'x', holder: 'ops' })), [400, 'HUB_USAGE', 2, 'bad-run-key'], key);
    }
    assert.equal((await s.cli(['force-release', '--reservation', '../x', '--why', 'x'])).code, 2);
    assert.deepEqual([s.entries(), s.forced().length], [[KEY], 0]);
  } finally { s.cleanup(); }
});

test('a bad body: unknown key, bad actor, neither actor nor holder, non-string name', async () => {
  const s = scratch();
  try {
    s.reserve();
    assert.deepEqual(problemOf(await s.api(KEY, { why: 'x', holder: 'ops', extra: 1 })), [400, 'HUB_USAGE', 2, 'bad-body']);
    assert.deepEqual(problemOf(await s.api(KEY, [])), [400, 'HUB_USAGE', 2, 'bad-body']);
    assert.deepEqual(problemOf(await s.api(KEY, { why: 'x', actor: { holder: 'ops', via: 'ssh' } })), [400, 'HUB_USAGE', 2, 'bad-actor']);
    assert.deepEqual(problemOf(await s.api(KEY, { why: 'x', actor: null })), [400, 'HUB_USAGE', 2, 'bad-actor']);
    assert.deepEqual(problemOf(await s.api(KEY, { why: 'x' })), [400, 'HUB_USAGE', 2, 'no-holder']);
    assert.deepEqual(problemOf(await s.api(KEY, { why: 'x', holder: 'ops', name: ['adb'] })), [400, 'HUB_USAGE', 2, 'bad-name']);
    assert.deepEqual([s.entries(), s.forced().length], [[KEY], 0]);
    assert.throws(() => forceReleaseReservation(KEY, { why: 'x' }, { env: s.env }), /names its actor/);
  } finally { s.cleanup(); }
});

test('CLI misuse: a lease id with --reservation, or --name without --reservation, is a usage error (exit 2)', async () => {
  const s = scratch();
  try {
    s.reserve();
    assert.equal((await s.cli(['force-release', '--reservation', KEY, 'a-1', '--why', 'x'])).code, 2);
    assert.equal((await s.cli(['force-release', 'a-1', '--why', 'x', '--name', 'adb'])).code, 2);
    assert.equal((await s.cli(['lease', 's24', '--for', '5m', '--why', 'x', '--reservation', KEY])).code, 2, 'the flag belongs to force-release');
    assert.equal((await s.cli(['force-release', '--reservation', KEY, '--why', 'x', '--name'])).code, 2);
    assert.deepEqual([s.entries(), s.forced().length], [[KEY], 0]);
  } finally { s.cleanup(); }
});

test('race: a second force-release, or the run\'s own release first, leaves exactly one event and the loser answers 404', async () => {
  const s = scratch();
  try {
    s.reserve();
    const [a, b] = await Promise.all([s.api(KEY, { why: 'one', holder: 'ops' }), s.api(KEY, { why: 'two', holder: 'ops' })]);
    assert.deepEqual([a.status, b.status].sort(), [200, 404]);
    assert.equal(s.forced().length, 1, 'one event in total');
    // The run's own release first: the force-release loses and writes nothing.
    s.reserve('78');
    assert.equal(releaseReservation('adb', { env: { ...s.env, GITHUB_REPOSITORY: 'acme/app', GITHUB_RUN_ID: '78' }, now: s.now, hostId: 'test-host' }).status, 'released');
    assert.deepEqual(problemOf(await s.api('acme--app--78', { why: 'late', holder: 'ops' })), [404, 'HUB_RESERVATION_NOT_FOUND', 2, 'unknown']);
    assert.deepEqual([s.forced().length, s.events().filter(event => event.event === 'release').length], [1, 1]);
    // Two force-releases in a row at the lock level: the rename decided the first, the second finds nothing.
    s.reserve('79');
    assert.equal(releaseReservation('adb', { key: 'acme--app--79', env: s.env, now: s.now, hostId: 'test-host', actor: { holder: 'ops', via: 'api' }, why: 'first' }).status, 'released');
    assert.equal(releaseReservation('adb', { key: 'acme--app--79', env: s.env, now: s.now, hostId: 'test-host', actor: { holder: 'ops', via: 'api' }, why: 'second' }).status, 'none');
    assert.equal(s.forced().length, 2);
  } finally { s.cleanup(); }
});

test('releaseReservation with an actor: the exact force-release event, the record in the answer, and the rules before any read', () => {
  const s = scratch();
  try {
    s.reserve();
    const actor = { holder: 'ops', via: 'cli' };
    // Empty or non-string why throws HUB_USAGE (bad-why) before any read: it throws for a Reservation that does not exist too, and leaves one that does.
    for (const why of ['', '  ', null, undefined, 3]) {
      assert.throws(() => releaseReservation('adb', { key: 'acme--app--1', env: s.env, now: s.now, actor, why }), error => error.code === 'HUB_USAGE' && error.reason === 'bad-why');
    }
    assert.throws(() => releaseReservation('adb', { key: KEY, env: s.env, now: s.now, actor: { holder: '', via: 'cli' }, why: 'x' }), TypeError);
    assert.throws(() => releaseReservation('adb', { key: KEY, env: s.env, now: s.now, actor: 'ops', why: 'x' }), TypeError);
    assert.deepEqual([s.entries(), s.forced().length], [[KEY], 0]);
    const result = releaseReservation('adb', { key: KEY, env: s.env, now: s.now, hostId: 'test-host', actor, why: 'dead run' });
    assert.deepEqual([result.status, result.key, result.reservation.repo, result.reservation.run, result.reservation.run_key], ['released', KEY, 'acme/app', '77', KEY]);
    const [event] = s.forced();
    assert.deepEqual(
      { event: event.event, lock: event.lock, hold_kind: event.hold_kind, run_key: event.run_key, held_ms: event.held_ms, actor: event.actor, why: event.why, reason: event.reason, reserved_at: event.reserved_at, expires_at: event.expires_at, lease_id: event.lease_id },
      { event: 'force-release', lock: 'adb', hold_kind: 'reservation', run_key: KEY, held_ms: 5 * MIN, actor, why: 'dead run', reason: null, reserved_at: iso(T0 - 5 * MIN), expires_at: iso(T0 + 175 * MIN), lease_id: null },
    );
    assert.deepEqual(releaseReservation('adb', { key: KEY, env: s.env, now: s.now, actor, why: 'again' }), { status: 'none', key: KEY });
  } finally { s.cleanup(); }
});

test('without an actor releaseReservation is unchanged: the {status, key} shape and a plain release event', () => {
  const s = scratch();
  try {
    s.reserve();
    const runEnv = { ...s.env, GITHUB_REPOSITORY: 'acme/app', GITHUB_RUN_ID: '77', GITHUB_RUN_ATTEMPT: '1', GITHUB_JOB: 'android' };
    assert.deepEqual(releaseReservation('adb', { env: runEnv, now: s.now, hostId: 'test-host' }), { status: 'released', key: KEY });
    const release = s.events().find(event => event.event === 'release');
    assert.deepEqual([release.hold_kind, release.reason, release.actor, release.why, release.claimant.attempt, release.claimant.job], ['reservation', 'done', undefined, undefined, '1', 'android']);
    assert.equal(s.forced().length, 0);
    assert.deepEqual(releaseReservation('adb', { env: runEnv, now: s.now, hostId: 'test-host', actor: null, why: null }), { status: 'none', key: KEY }, 'a null actor is no actor');
  } finally { s.cleanup(); }
});

test('status --json no longer lists the Reservation, and the next waiter is no longer blocked by it', async () => {
  const s = scratch();
  try {
    s.reserve();
    const before = await s.cli(['status', '--json']);
    assert.match(before.out.join('\n'), new RegExp(KEY), 'listed while reserved');
    const blocked = await s.take();
    assert.equal(blocked.status, 409, JSON.stringify(blocked.body));
    assert.equal((await s.api(KEY, { why: 'dead run', holder: 'ops' })).status, 200);
    const after = await s.cli(['status', '--json']);
    assert.equal(after.code, 0);
    assert.doesNotMatch(after.out.join('\n'), new RegExp(KEY), 'no longer listed');
    const taken = await s.take({ id: 'next-1' });
    assert.equal(taken.status, 200, JSON.stringify(taken.body));
  } finally { s.cleanup(); }
});

test('a Reservation past its ceiling that nothing pruned yet is force-released like a live one', async () => {
  const s = scratch();
  try {
    s.reserve('77', 'adb', 'acme/app', T0 - 240 * MIN);
    assert.deepEqual(s.entries(), [KEY], 'still a directory');
    const answer = await s.api(KEY, { why: 'dead run', holder: 'ops' });
    assert.equal(answer.status, 200, JSON.stringify(answer.body));
    assert.equal(s.forced().length, 1);
    assert.deepEqual([s.forced()[0].held_ms, s.forced()[0].hold_kind], [240 * MIN, 'reservation']);
    assert.deepEqual(s.entries(), []);
  } finally { s.cleanup(); }
});

test('the deploy path\'s releases stay plain: releaseFor, reservation release (library and CLI) write a release with no actor or why, never a force-release', async () => {
  const s = scratch();
  try {
    const runEnv = { ...s.env, GITHUB_REPOSITORY: 'acme/app', GITHUB_RUN_ID: '77', GITHUB_RUN_ATTEMPT: '1', GITHUB_JOB: 'android' };
    const plain = () => {
      const releases = s.events().filter(event => event.event === 'release');
      assert.equal(releases.length, 1);
      assert.deepEqual([releases[0].hold_kind, releases[0].run_key, releases[0].actor, releases[0].why], ['reservation', KEY, undefined, undefined]);
      assert.equal(s.forced().length, 0);
      assert.deepEqual(s.entries(), []);
    };
    s.reserve();
    const lines = [];
    assert.equal(releaseFor('adb', { env: runEnv, log: line => lines.push(line) }).status, 'released');
    assert.deepEqual(lines, [`HUB_RESERVATION_RELEASED adb ${KEY}`]);
    plain();
    rmSync(s.env.HUB_EVENT_DIR, { recursive: true, force: true });
    s.reserve();
    assert.deepEqual(releaseReservations({ key: KEY }, { env: s.env, timing: { now: s.now } }), [{ name: 'adb', key: KEY }]);
    plain();
    rmSync(s.env.HUB_EVENT_DIR, { recursive: true, force: true });
    s.reserve();
    const cli = await s.cli(['reservation', 'release', '--run', KEY]);
    assert.deepEqual([cli.code, cli.out], [0, [`HUB_DEVICE_RESERVATION_RELEASED adb ${KEY}`]]);
    plain();
  } finally { s.cleanup(); }
});
