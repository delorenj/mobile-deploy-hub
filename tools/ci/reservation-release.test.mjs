// Reservations end when the run is done with the device (Story 2.6, AD-7, AD-17): releaseReservation, withLock's endsReservation,
// announce's backstop (adb locally, mac-ios over ssh to the Mac's installed hub-device), and the `hub-device reservation release`
// verb. Everything runs against a temp HUB_LOCK_DIR/HUB_EVENT_DIR with an injected clock, releaser and ssh runner; no device, no host state.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { acquireLease, listReservations, queueView, releaseReservation, reserve, withLock } from './lib/lock.mjs';
import { readEvents } from './lib/events.mjs';
import { MAC_HUB_DEVICE, releaseFinished } from './commands/announce.mjs';
import { releaseFor } from './commands/common.mjs';
import { main } from '../device/hub-device.mjs';
import { hermetic } from './test-fixtures.mjs';

hermetic();

const T0 = Date.parse('2026-11-24T10:00:00.000Z');
const MIN = 60_000;
const policy = { queue: { wait_margin_min: 2, hold_allowance_min: { plan: 5, android: 15, ios: 60 }, grace_min: 10, reservation_ceiling_min: 180 } };
const lockModule = fileURLToPath(new URL('./lib/lock.mjs', import.meta.url));
const KEY = 'delorenj--example--5';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'hub-release-'));
  const plain = { HUB_LOCK_DIR: join(root, 'locks'), HUB_EVENT_DIR: join(root, 'events') };
  const env = { ...plain, GITHUB_REPOSITORY: 'delorenj/example', GITHUB_RUN_ID: '5', GITHUB_RUN_ATTEMPT: '1', GITHUB_JOB: 'gate' };
  const clock = { at: T0 };
  const logs = [];
  return {
    root, env, plain, clock, logs, log: line => logs.push(line), now: () => clock.at,
    reservations: name => join(root, `locks/${name}.reservations`),
    runEnv: (run, job = 'android', attempt = '1') => ({ ...env, GITHUB_RUN_ID: String(run), GITHUB_JOB: job, GITHUB_RUN_ATTEMPT: attempt }),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}
const events = f => [...readEvents({ env: f.env })];
const take = (f, env = f.env, name = 'adb') => reserve(name, { env, now: f.now, policy, log: f.log });
// A ticket as a pinned or current hub would have written it (file name = ms15-counter-pid), for tests that place one by hand.
const putTicket = (f, ms, body = {}, name = 'adb') => {
  const queue = join(f.root, `locks/${name}.queue`);
  mkdirSync(queue, { recursive: true });
  const file = `${String(ms).padStart(15, '0')}-000001-00000009.json`;
  writeFileSync(join(queue, file), JSON.stringify({ format: 1, kind: 'lease', lease_id: body.lease_id ?? 'someone', holder: 'someone', why: 'waiting', pid: process.pid, host: hostname(), enqueued_at: new Date(ms).toISOString(), ...body }));
  return join(queue, file);
};
const fakeTimers = () => ({ setInterval: () => ({ unref() {} }), clearInterval() {} });
const settle = ms => new Promise(done => setTimeout(done, ms));
const until = async (check, what) => {
  for (let tries = 0; tries < 1000; tries += 1) { if (check()) return; await settle(10); }
  assert.fail(`never happened: ${what}`);
};

// ---------------------------------------------------------------------------------------------------- releaseReservation

test('releaseReservation renames the directory away, appends exactly one release event, and a second release is a quiet no-op', () => {
  const f = fixture();
  try {
    take(f);
    f.clock.at += 25 * MIN;
    const released = releaseReservation('adb', { env: f.env, now: f.now });
    assert.deepEqual(released, { status: 'released', key: KEY });
    assert.deepEqual(readdirSync(f.reservations('adb')), [], 'nothing is left, not even a .released-* directory');
    assert.deepEqual(listReservations('adb', { env: f.env }), []);
    const [claim, release, ...rest] = events(f);
    assert.deepEqual(rest, [], 'one claim and one release');
    assert.deepEqual([claim.event, release.event, release.lock, release.hold_kind, release.run_key, release.reason], ['claim', 'release', 'adb', 'reservation', KEY, 'done']);
    assert.equal(release.held_ms, 25 * MIN);
    assert.deepEqual(release.claimant, { kind: 'deploy', holder: null, repo: 'delorenj/example', run: '5', attempt: '1', job: 'gate' }, 'the run releasing its own Reservation names its attempt and job');
    assert.deepEqual(releaseReservation('adb', { env: f.env, now: f.now }), { status: 'none', key: KEY });
    assert.equal(events(f).length, 2, 'no second event');
  } finally { f.cleanup(); }
});

test('nothing reserved, a name that cannot be reserved, a shell with no run and an unsafe key are all quiet no-ops that write nothing', () => {
  const f = fixture();
  try {
    assert.deepEqual(releaseReservation('adb', { env: f.env, now: f.now }), { status: 'none', key: KEY });
    take(f);
    for (const [name, options] of [['s24', { env: f.env }], ['adb', { env: f.plain }], ['adb', { env: f.env, key: '../x' }], ['adb', { env: f.env, key: '.released-x-1' }], ['mac-ios', { env: f.env }]]) {
      assert.equal(releaseReservation(name, { ...options, now: f.now }).status, 'none', `${name} ${JSON.stringify(options.key ?? null)}`);
    }
    assert.equal(listReservations('adb', { env: f.env }).length, 1, 'none of them touched the real one');
    assert.equal(events(f).length, 1);
  } finally { f.cleanup(); }
});

test('an expired Reservation is released like a live one (the verb never leaves the directory to the ceiling), and a rerun can reserve again at once', () => {
  const f = fixture();
  try {
    take(f);
    f.clock.at += 181 * MIN;
    assert.equal(releaseReservation('adb', { env: f.env, now: f.now }).status, 'released');
    assert.equal(take(f).status, 'claimed', 'the key is free again: a second claim');
    assert.deepEqual(events(f).map(event => event.event), ['claim', 'release', 'claim']);
  } finally { f.cleanup(); }
});

test('a record that is not readable yet is never taken away by a release (its owner may be writing it)', () => {
  const f = fixture();
  try {
    mkdirSync(join(f.reservations('adb'), KEY), { recursive: true });
    assert.equal(releaseReservation('adb', { env: f.env, now: f.now }).status, 'none');
    assert.ok(existsSync(join(f.reservations('adb'), KEY)));
  } finally { f.cleanup(); }
});

test('several processes releasing one Reservation at once append exactly one release', async () => {
  const f = fixture();
  try {
    take(f);
    const code = `import { releaseReservation } from ${JSON.stringify(lockModule)}; releaseReservation('adb', {});`;
    const children = Array.from({ length: 6 }, () => new Promise(done => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', code], { env: { PATH: process.env.PATH, ...f.env }, stdio: 'ignore' });
      child.on('close', done);
    }));
    assert.deepEqual(await Promise.all(children), [0, 0, 0, 0, 0, 0]);
    assert.equal(events(f).filter(event => event.event === 'release').length, 1);
    assert.deepEqual(readdirSync(f.reservations('adb')), []);
  } finally { f.cleanup(); }
});

test('a grace stamp that lands after a release fails with ENOENT and is ignored: the released Reservation does not come back', async () => {
  const f = fixture();
  try {
    take(f, f.runEnv(5));
    f.clock.at += 1000;
    // The Reservation is released (renamed away) in the instant between the view and the grace stamp.
    let released = false;
    await assert.rejects(acquireLease('adb', {
      holder: 'agent-b', why: 'proof', forMs: MIN, id: 'try', env: f.plain, log: f.log,
      now: () => { if (!released && new Error().stack.includes('startGrace')) { released = true; releaseReservation('adb', { env: f.runEnv(5), now: f.now }); } return f.clock.at; },
    }), error => error.code === 'HUB_LOCK_TIMEOUT');
    assert.ok(released);
    assert.deepEqual(readdirSync(f.reservations('adb')), [], 'no directory, no grace.json, nothing resurrected');
    assert.deepEqual(events(f).map(event => event.event).filter(name => name === 'grace'), []);
  } finally { f.cleanup(); }
});

// ---------------------------------------------------------------------------------------------------- withLock endsReservation

test('a hold that ends well with endsReservation renames the Reservation away before the lock is freed: the Reservation\'s release event comes before the job\'s', async () => {
  const f = fixture();
  try {
    take(f, f.runEnv(5, 'gate'));
    let during = null;
    await withLock('adb', async () => { during = existsSync(join(f.reservations('adb'), KEY)); }, { env: f.runEnv(5, 'android'), log: f.log, pollMs: 5, timeoutMs: 10_000, timers: fakeTimers(), endsReservation: true });
    assert.equal(during, true, 'the Reservation lives while the run holds the device');
    assert.deepEqual(listReservations('adb', { env: f.env }), []);
    assert.deepEqual(events(f).map(event => [event.event, event.hold_kind]), [['claim', 'reservation'], ['request', 'job'], ['acquire', 'job'], ['release', 'reservation'], ['release', 'job']]);
    assert.equal(events(f).find(event => event.event === 'release' && event.hold_kind === 'reservation').claimant.job, 'android');
    assert.ok(f.logs.includes(`HUB_RESERVATION_RELEASED adb ${KEY}`), f.logs.join('\n'));
  } finally { f.cleanup(); }
});

test('a failed hold, a hold without endsReservation and a function that says no never release; a failure keeps the place for the rerun', async () => {
  const f = fixture();
  try {
    f.clock.at = Date.now();
    take(f, f.runEnv(5, 'gate'));
    const opts = extra => ({ env: f.runEnv(5, 'android'), log: f.log, pollMs: 5, timeoutMs: 10_000, timers: fakeTimers(), ...extra });
    await assert.rejects(withLock('adb', async () => { throw new Error('readback failed'); }, opts({ endsReservation: true })), /readback failed/);
    await withLock('adb', async () => {}, opts({}));
    await withLock('adb', async () => {}, opts({ endsReservation: () => false }));
    assert.deepEqual(listReservations('adb', { env: f.env }).map(entry => entry.key), [KEY]);
    assert.equal(events(f).filter(event => event.event === 'release' && event.hold_kind === 'reservation').length, 0);
    // the rerun (attempt 2) of the failed job asks at the original Reservation's place, ahead of a later arrival: another job holds
    // the lock (as a pinned version would have taken it) and a later Claimant is already waiting
    const lock = join(f.root, 'locks/adb.lock');
    mkdirSync(lock);
    writeFileSync(join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, host: hostname(), repo: 'delorenj/other', run: '1', started_at: new Date().toISOString() }));
    const later = putTicket(f, Date.now() + MIN, { lease_id: 'later' });
    const rerun = withLock('adb', async () => {}, opts({ env: f.runEnv(5, 'android', '2'), endsReservation: true }));
    await until(() => queueView('adb', { env: f.env }).some(entry => entry.kind === 'job'), 'the rerun\'s ticket');
    const view = queueView('adb', { env: f.env });
    assert.deepEqual(view.map(entry => [entry.place, entry.kind, entry.lease_id === 'later' ? 'later' : entry.attempt ?? null]), [[1, 'job', '2'], [2, 'lease', 'later']]);
    assert.equal(view[0].reservation, KEY);
    rmSync(lock, { recursive: true });
    await until(() => !existsSync(join(f.reservations('adb'), KEY)), 'the rerun served, then released');
    await rerun;
    rmSync(later);
    assert.deepEqual(listReservations('adb', { env: f.env }), [], 'and then its good end releases it');
  } finally { f.cleanup(); }
});

test('endsReservation on a name that is not a deploy target, or from a run that holds no Reservation, does nothing', async () => {
  const f = fixture();
  try {
    await withLock('s24', async () => {}, { env: f.runEnv(5), log: f.log, pollMs: 5, timers: fakeTimers(), endsReservation: true });
    await withLock('adb', async () => {}, { env: f.runEnv(6), log: f.log, pollMs: 5, timers: fakeTimers(), endsReservation: true });
    assert.equal(events(f).filter(event => event.hold_kind === 'reservation').length, 0);
  } finally { f.cleanup(); }
});

// ---------------------------------------------------------------------------------------------------- releaseFor

test('releaseFor logs a release, says nothing when there was none, and never throws', () => {
  const logs = [];
  const log = line => logs.push(line);
  assert.deepEqual(releaseFor('adb', { releaser: (name, options) => { assert.deepEqual([name, options.reason], ['adb', 'skipped']); return { status: 'released', key: KEY }; }, env: {}, log, reason: 'skipped' }), { status: 'released', key: KEY });
  assert.deepEqual(releaseFor('adb', { releaser: () => ({ status: 'none', key: KEY }), env: {}, log }), { status: 'none', key: KEY });
  assert.equal(releaseFor('adb', { releaser: () => { throw new Error('the lock directory is read only\nsecond line'); }, env: {}, log }), null);
  assert.deepEqual(logs, [`HUB_RESERVATION_RELEASED adb ${KEY}`, 'HUB_RESERVATION_RELEASE_FAILED adb the lock directory is read only; the ceiling ends it']);
});

// ---------------------------------------------------------------------------------------------------- announce

const devices = { mac: { host: 'hub-mac' } };
const needsOf = (android, ios) => ({ ...(android ? { android: { result: android } } : {}), ...(ios ? { ios: { result: ios } } : {}) });

test('announce releases a successful android lane locally and a successful ios lane over ssh at the installed hub-device\'s path, never with rm', () => {
  const f = fixture();
  try {
    take(f);
    const ssh = [];
    const runner = (command, args, options) => { ssh.push([command, args, options.label]); return `HUB_DEVICE_RESERVATION_RELEASED mac-ios ${KEY}\n`; };
    const done = releaseFinished({ env: f.env, needs: needsOf('success', 'success'), devices, runner, log: f.log });
    assert.deepEqual(done, [['adb', 'released'], ['mac-ios', 'released']]);
    assert.deepEqual(listReservations('adb', { env: f.env }), []);
    assert.deepEqual(ssh.map(([command, args]) => [command, args.slice(0, 4), args[4], args[5]]), [['ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15'], 'hub-mac', `${MAC_HUB_DEVICE} reservation release --run ${KEY} --name mac-ios`]]);
    assert.doesNotMatch(JSON.stringify(ssh), /\brm\b/);
    assert.equal(MAC_HUB_DEVICE, '~/.local/bin/hub-device');
    assert.ok(f.logs.includes(`HUB_RESERVATION_RELEASED mac-ios ${KEY} (on the Mac)`), f.logs.join('\n'));
  } finally { f.cleanup(); }
});

test('announce releases nothing for a lane that failed, was cancelled or skipped, and nothing outside a run', () => {
  const f = fixture();
  try {
    take(f);
    const runner = () => assert.fail('no ssh for a lane that did not end well');
    for (const result of ['failure', 'cancelled', 'skipped']) assert.deepEqual(releaseFinished({ env: f.env, needs: needsOf(result, result), devices, runner, log: f.log }), []);
    assert.deepEqual(releaseFinished({ env: f.plain, needs: needsOf('success', 'success'), devices, runner, log: f.log }), [], 'a shell has no run key');
    assert.deepEqual(releaseFinished({ env: f.env, needs: undefined, devices, runner, log: f.log }), []);
    assert.equal(listReservations('adb', { env: f.env }).length, 1);
  } finally { f.cleanup(); }
});

test('a Mac whose hub-device has no reservation verb yet is logged and left to the ceiling; a Mac that does not answer is logged and left too; neither throws', () => {
  const f = fixture();
  try {
    const old = () => { throw new Error('ssh hub-mac failed (exit 2)\nhub-device: usage: hub-device lease s24|s26|phone --for <dur> ...'); };
    assert.deepEqual(releaseFinished({ env: f.env, needs: needsOf(null, 'success'), devices, runner: old, log: f.log }), [['mac-ios', 'skipped']]);
    assert.ok(f.logs.includes(`HUB_RESERVATION_RELEASE_SKIPPED mac-ios ${KEY}: the Mac's hub-device has no reservation release verb yet; the 3 h ceiling ends it`), f.logs.join('\n'));
    const down = () => { throw new Error('ssh hub-mac failed (exit 255)\nssh: connect to host hub-mac port 22: Connection timed out'); };
    assert.deepEqual(releaseFinished({ env: f.env, needs: needsOf(null, 'success'), devices, runner: down, log: f.log }), [['mac-ios', 'failed']]);
    assert.ok(f.logs.some(line => line.startsWith(`HUB_RESERVATION_RELEASE_FAILED mac-ios ${KEY}: ssh hub-mac failed (exit 255)`)), f.logs.join('\n'));
    const none = () => `HUB_DEVICE_RESERVATION_NONE ${KEY}\n`;
    assert.deepEqual(releaseFinished({ env: f.env, needs: needsOf(null, 'success'), devices, runner: none, log: f.log }), [['mac-ios', 'none']]);
  } finally { f.cleanup(); }
});

// ---------------------------------------------------------------------------------------------------- hub-device reservation release

async function verb(f, args) {
  const out = [];
  const err = [];
  const code = await main(args, { env: f.plain, stdout: line => out.push(line), stderr: line => err.push(line), now: f.now });
  return { code, out, err };
}

test('hub-device reservation release releases through lock.mjs, prints a HUB_DEVICE line and exits 0; with nothing reserved it still exits 0', async () => {
  const f = fixture();
  try {
    take(f);
    take(f, f.env, 'mac-ios');
    const none = await verb(f, ['reservation', 'release', '--run', 'delorenj--other--9']);
    assert.deepEqual([none.code, none.out, none.err], [0, ['HUB_DEVICE_RESERVATION_NONE delorenj--other--9'], []]);
    const named = await verb(f, ['reservation', 'release', '--run', KEY, '--name', 'mac-ios']);
    assert.deepEqual([named.code, named.out], [0, [`HUB_DEVICE_RESERVATION_RELEASED mac-ios ${KEY}`]]);
    assert.equal(listReservations('adb', { env: f.env }).length, 1, '--name left adb alone');
    const all = await verb(f, ['reservation', 'release', '--run', KEY]);
    assert.deepEqual([all.code, all.out], [0, [`HUB_DEVICE_RESERVATION_RELEASED adb ${KEY}`]]);
    const again = await verb(f, ['reservation', 'release', '--run', KEY]);
    assert.deepEqual([again.code, again.out], [0, [`HUB_DEVICE_RESERVATION_NONE ${KEY}`]]);
    assert.deepEqual(events(f).filter(event => event.event === 'release').map(event => [event.lock, event.reason]), [['mac-ios', 'released'], ['adb', 'released']]);
  } finally { f.cleanup(); }
});

test('hub-device reservation release --json adds a shape and renames nothing; a bad run key, a bad name and a missing --run are usage errors (exit 2)', async () => {
  const f = fixture();
  try {
    take(f);
    const json = await verb(f, ['reservation', 'release', '--run', KEY, '--json']);
    assert.deepEqual([json.code, JSON.parse(json.out[0])], [0, { run: KEY, released: [{ name: 'adb', key: KEY }] }]);
    assert.deepEqual(JSON.parse((await verb(f, ['reservation', 'release', '--run', KEY, '--json'])).out[0]), { run: KEY, released: [] });
    for (const [args, pattern] of [
      [['reservation', 'release'], /needs --run/],
      [['reservation', 'release', '--run', '../x'], /not a run key/],
      [['reservation', 'release', '--run', '.hidden--x--1'], /not a run key/],
      [['reservation', 'release', '--run', KEY, '--name', 's24'], /--name is one of adb, mac-ios/],
      [['reservation'], /reservation takes: release/],
      [['reservation', 'drop', '--run', KEY], /reservation takes: release/],
    ]) {
      const result = await verb(f, args);
      assert.equal(result.code, 2, args.join(' '));
      assert.match(result.err.join('\n'), pattern);
      assert.deepEqual(result.out, []);
    }
  } finally { f.cleanup(); }
});

test('the usage line grows by the new verb and keeps every older clause (AD-17: the CLI only grows)', async () => {
  const f = fixture();
  try {
    const result = await verb(f, ['bogus']);
    assert.equal(result.code, 2);
    const text = result.err.join('\n');
    for (const clause of ['lease s24|s26|phone --for <dur>', 'release [emulator] [<lease_id>|--any]', 'status [--json]', 'run s24|s26|phone|emulator', 'reservation release --run <key> [--name adb|mac-ios] [--json]']) assert.ok(text.includes(clause), clause);
  } finally { f.cleanup(); }
});

test('the verb is a process the Mac can run over ssh: a real child run releases and prints one line', async () => {
  const f = fixture();
  try {
    take(f);
    const script = fileURLToPath(new URL('../device/hub-device.mjs', import.meta.url));
    const out = await new Promise(done => {
      let text = '';
      const child = spawn(process.execPath, [script, 'reservation', 'release', '--run', KEY, '--name', 'adb'], { env: { PATH: process.env.PATH, ...f.plain }, stdio: ['ignore', 'pipe', 'ignore'] });
      child.stdout.on('data', chunk => { text += chunk; });
      child.on('close', code => done({ code, text }));
    });
    assert.deepEqual(out, { code: 0, text: `HUB_DEVICE_RESERVATION_RELEASED adb ${KEY}\n` });
    assert.deepEqual(listReservations('adb', { env: f.env }), []);
  } finally { f.cleanup(); }
});
