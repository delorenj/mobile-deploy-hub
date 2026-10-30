// hub-device: lease/release/status/run against a fake adb binary and a temp lock directory. No real phone, adb server,
// emulator or Xvfb is touched: the inventory reads a fake /proc tree, and the signal tests drive a child process.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { acquireLease, releaseLease, withLock } from '../ci/lib/lock.mjs';
import { inventory } from './inventory.mjs';
import { main, parseArgs, parseDuration } from './hub-device.mjs';

const tool = fileURLToPath(new URL('./hub-device.mjs', import.meta.url));
const hubRoot = fileURLToPath(new URL('../../', import.meta.url));
const SERIAL = 'R5GL43A7PCH';
const settle = ms => new Promise(done => setTimeout(done, ms));

// The S26 as a shell script over a state folder: `away` hides it; every call is logged.
const fakeAdb = state => `#!/bin/sh
echo "$*" >> "${state}/calls.log"
[ "$1" = "-s" ] && shift 2
case "$1" in
  start-server|connect|mdns) exit 0 ;;
  devices) printf 'List of devices attached\\n'; [ -f "${state}/away" ] || printf 'adb-${SERIAL}-zz._adb-tls-connect._tcp\\tdevice\\n'; exit 0 ;;
  shell)
    case "$2 $3" in
      "getprop ro.serialno") echo ${SERIAL} ;;
      "getprop ro.product.model") echo SM-S948U ;;
      *) exit 1 ;;
    esac ;;
  *) exit 1 ;;
esac
`;

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'hub-device-'));
  const state = join(root, 'phone');
  mkdirSync(state, { recursive: true });
  const adb = join(root, 'adb');
  writeFileSync(adb, fakeAdb(state));
  chmodSync(adb, 0o755);
  const env = { PATH: process.env.PATH, HOME: root, USER: 'tester', HUB_ADB: adb, HUB_LOCK_DIR: join(root, 'locks'), HUB_DEVICE_POLL_MS: '5', HUB_ADB_SERVER_PORT: '5037' };
  const run = async (argv, extra = {}) => {
    const out = [];
    const err = [];
    const code = await main(argv, { env, stdout: line => out.push(line), stderr: line => err.push(line), inventory: () => ({ adb_servers: [], emulators: [], xvfb: [] }), ...extra });
    return { code, out, err };
  };
  return {
    root, env, state, run, lock: join(root, 'locks/adb.lock'),
    away: on => (on ? writeFileSync(join(state, 'away'), '') : rmSync(join(state, 'away'), { force: true })),
    calls: () => { try { return readFileSync(join(state, 'calls.log'), 'utf8'); } catch { return ''; } },
    owner: () => JSON.parse(readFileSync(join(root, 'locks/adb.lock/owner.json'), 'utf8')),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

test('durations and arguments parse', () => {
  assert.equal(parseDuration('90s'), 90_000);
  assert.equal(parseDuration('1h30m'), 5_400_000);
  assert.equal(parseDuration('2d'), 172_800_000);
  assert.equal(parseDuration('45'), 45_000);
  assert.throws(() => parseDuration('soon'), /not a duration/);
  assert.throws(() => parseDuration('5 minutes'), /not a duration/);
  const parsed = parseArgs(['run', 's26', '--for=10m', '--env-serial', 'A', '--env-serial', 'B', '--no-connect', '--', 'echo', '--why', 'x']);
  assert.deepEqual(parsed.words, ['run', 's26']);
  assert.deepEqual(parsed.flags, { for: '10m', 'no-connect': true });
  assert.deepEqual(parsed.envSerial, ['A', 'B']);
  assert.deepEqual(parsed.command, ['echo', '--why', 'x'], 'everything after -- is the command');
  assert.throws(() => parseArgs(['lease', '--bogus']), /unknown flag/);
  assert.throws(() => parseArgs(['lease', '--for']), /needs a value/);
  assert.throws(() => parseArgs(['lease', '--env-serial', 'not-a-name']), /not an environment variable name/);
});

test('lease connects the phone, prints the exports, persists, and release frees it', async () => {
  const f = fixture();
  try {
    const result = await f.run(['lease', 's26', '--for', '30m', '--why', 'device proof', '--env-serial', 'ADB_DEVICE', '--env-serial', 'SERIAL2']);
    assert.equal(result.code, 0, result.err.join('\n'));
    const vars = Object.fromEntries(result.out.map(line => /^export (\w+)='(.*)'$/.exec(line).slice(1)));
    assert.match(vars.HUB_LEASE_ID, /^l-[0-9a-f]{12}$/);
    assert.equal(vars.ANDROID_SERIAL, `adb-${SERIAL}-zz._adb-tls-connect._tcp`);
    assert.equal(vars.ANDROID_ADB_SERVER_PORT, '5037');
    assert.equal(vars.ADB_DEVICE, vars.ANDROID_SERIAL);
    assert.equal(vars.SERIAL2, vars.ANDROID_SERIAL);
    assert.ok(result.err.some(line => /^HUB_S26 SM-S948U serial=R5GL43A7PCH/.test(line)), 'findPhone ran');
    const owner = f.owner();
    assert.equal(owner.kind, 'lease');
    assert.equal(owner.why, 'device proof');
    assert.equal(owner.holder, 'tester@' + owner.host);
    assert.equal(owner.lease_id, vars.HUB_LEASE_ID);
    assert.equal(owner.device.adb_id, vars.ANDROID_SERIAL);
    assert.ok(Date.parse(owner.expires_at) - Date.now() > 29 * 60_000);
    // the lease outlives main(): another taker is refused, then served after release
    const busy = await f.run(['lease', 's26', '--for', '5m', '--why', 'other', '--wait', '0']);
    assert.equal(busy.code, 76);
    assert.match(busy.out.join('\n'), /^HUB_DEVICE_BUSY s26 host lock adb is held by lease l-/);
    const released = await f.run(['release', vars.HUB_LEASE_ID]);
    assert.deepEqual([released.code, released.out], [0, [`HUB_DEVICE_RELEASED s26 ${vars.HUB_LEASE_ID}`]]);
    assert.ok(!existsSync(f.lock));
    assert.deepEqual((await f.run(['release', vars.HUB_LEASE_ID])).out, [`HUB_DEVICE_NOT_HELD s26 ${vars.HUB_LEASE_ID}`], 'release is idempotent');
    const again = await f.run(['lease', 's26', '--for', '5m', '--why', 'other', '--wait', '0', '--json']);
    assert.equal(again.code, 0);
    const json = JSON.parse(again.out[0]);
    assert.equal(json.env.ANDROID_ADB_SERVER_PORT, '5037');
    // release with no id frees whatever lease holds it
    assert.equal((await f.run(['release'])).out[0], `HUB_DEVICE_RELEASED s26 ${json.lease_id}`);
  } finally { f.cleanup(); }
});

test('release never touches a deploy job or another lease', async () => {
  const f = fixture();
  try {
    let done;
    const job = withLock('adb', () => new Promise(resolve => { done = resolve; }), { env: f.env, log: () => {} });
    await settle(20);
    const bare = await f.run(['release']);
    assert.equal(bare.code, 1);
    assert.match(bare.err.join(), /held by a deploy job, not a lease/);
    assert.equal((await f.run(['release', 'l-abc'])).code, 0, 'an id that is not held is not held');
    assert.ok(existsSync(f.lock), 'the job still holds it');
    done();
    await job;
  } finally { f.cleanup(); }
});

test('lease needs --for and --why, and a known device', async () => {
  const f = fixture();
  try {
    assert.match((await f.run(['lease', 's26', '--why', 'x'])).err.join(), /--for <duration> is required/);
    assert.match((await f.run(['lease', 's26', '--for', '5m'])).err.join(), /--why <text> is required/);
    assert.match((await f.run(['lease', 'pixel', '--for', '5m', '--why', 'x'])).err.join(), /unknown device "pixel"/);
    assert.match((await f.run(['lease', 's26', '--for', '3d', '--why', 'x'])).err.join(), /at most 48h/);
    assert.equal((await f.run(['frobnicate'])).code, 2);
    assert.ok(!existsSync(f.lock));
    assert.equal(f.calls(), '', 'usage errors never reach adb');
  } finally { f.cleanup(); }
});

test('a phone that is away prints exactly HUB_DEVICE_AWAY s26, exits 75 and leaves no lease behind', async () => {
  const f = fixture();
  try {
    f.away(true);
    const result = await f.run(['lease', 's26', '--for', '5m', '--why', 'x', '--wait', '0']);
    assert.deepEqual([result.code, result.out], [75, ['HUB_DEVICE_AWAY s26']]);
    assert.ok(!existsSync(f.lock), 'the lock is given back');
    const ran = await f.run(['run', 's26', '--wait', '0', '--', process.execPath, '-e', `require('fs').writeFileSync(${JSON.stringify(join(f.root, 'ran'))}, 'x')`]);
    assert.deepEqual([ran.code, ran.out], [75, ['HUB_DEVICE_AWAY s26']]);
    assert.ok(!existsSync(join(f.root, 'ran')), 'the command never ran');
    assert.ok(!existsSync(f.lock));
    assert.match(f.calls(), /mdns|devices/, 'it did look for the phone');
  } finally { f.cleanup(); }
});

test('the mDNS nudge runs while waiting for the phone', async () => {
  const f = fixture();
  try {
    f.away(true);
    const result = await f.run(['lease', 's26', '--for', '5m', '--why', 'x', '--wait', '1s']);
    assert.equal(result.code, 75);
    assert.match(f.calls(), /^mdns services$/m, 'findPhone asked mDNS for the phone');
  } finally { f.cleanup(); }
});

test('--no-connect takes the lease without touching adb, even with the phone away', async () => {
  const f = fixture();
  try {
    f.away(true);
    const result = await f.run(['lease', 's26', '--for', '12h', '--why', 'gib: hold', '--no-connect', '--id', 'gib-hold']);
    assert.equal(result.code, 0, result.err.join());
    assert.deepEqual(result.out, ["export HUB_LEASE_ID='gib-hold'", "export ANDROID_ADB_SERVER_PORT='5037'"]);
    assert.equal(f.calls(), '', 'adb was never called');
    assert.equal(f.owner().lease_id, 'gib-hold');
    assert.equal(f.owner().device, undefined);
    assert.equal((await f.run(['release', 'gib-hold'])).code, 0);
  } finally { f.cleanup(); }
});

test('releasing a lease that is still queued cancels it (the adapter hold waits behind a running deploy)', async () => {
  const f = fixture();
  try {
    let done;
    const job = withLock('adb', () => new Promise(resolve => { done = resolve; }), { env: f.env, log: () => {} });
    await settle(20);
    const waiting = f.run(['lease', 's26', '--for', '1h', '--why', 'hold', '--no-connect', '--id', 'gib-hold', '--wait', '30s']);
    await settle(60);
    const cancel = await f.run(['release', 'gib-hold']);
    assert.match(cancel.out[0], /^HUB_DEVICE_CANCELLED s26 gib-hold/);
    const result = await waiting;
    assert.equal(result.code, 1);
    assert.match(result.err.join('\n'), /HUB_DEVICE_CANCELLED s26 lease gib-hold was released while it waited/);
    done();
    await job;
    assert.ok(!existsSync(f.lock));
  } finally { f.cleanup(); }
});

test('run exports the phone to the command, holds the lease meanwhile, returns its exit code and releases', async () => {
  const f = fixture();
  try {
    const probe = join(f.root, 'probe');
    const script = `const fs=require('fs');const e=process.env;fs.writeFileSync(${JSON.stringify(probe)},JSON.stringify({s:e.ANDROID_SERIAL,p:e.ANDROID_ADB_SERVER_PORT,x:e.MY_SERIAL,id:e.HUB_LEASE_ID,held:fs.existsSync(${JSON.stringify(f.lock)})}));process.exit(Number(process.argv[1]))`;
    const ok = await f.run(['run', 's26', '--for', '10m', '--why', 'probe', '--env-serial', 'MY_SERIAL', '--', process.execPath, '-e', script, '0']);
    assert.equal(ok.code, 0, ok.err.join());
    const seen = JSON.parse(readFileSync(probe, 'utf8'));
    assert.equal(seen.s, `adb-${SERIAL}-zz._adb-tls-connect._tcp`);
    assert.equal(seen.p, '5037');
    assert.equal(seen.x, seen.s);
    assert.match(seen.id, /^run-/);
    assert.equal(seen.held, true);
    assert.ok(!existsSync(f.lock), 'released after success');
    const failed = await f.run(['run', 's26', '--', process.execPath, '-e', script, '3']);
    assert.equal(failed.code, 3, 'the command exit code comes back');
    assert.ok(!existsSync(f.lock), 'released after failure');
    const missing = await f.run(['run', 's26', '--', join(f.root, 'no-such-command')]);
    assert.equal(missing.code, 127);
    assert.ok(!existsSync(f.lock), 'released when the command cannot start');
    assert.match((await f.run(['run', 's26'])).err.join(), /needs a command after --/);
  } finally { f.cleanup(); }
});

// Spawns the real CLI so a signal reaches a real process.
function spawnRun(f, args, extraEnv = {}) {
  const child = spawn(process.execPath, [tool, ...args], { env: { ...f.env, ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'] });
  const exit = new Promise(done => child.on('close', (code, signal) => done({ code, signal })));
  return { child, exit };
}

for (const [signal, code] of [['SIGTERM', 143], ['SIGINT', 130]]) {
  test(`run releases the lease and stops its command on ${signal}`, async () => {
    const f = fixture();
    try {
      const pidFile = join(f.root, 'cmd.pid');
      const { child, exit } = spawnRun(f, ['run', 's26', '--for', '10m', '--why', 'sig', '--', process.execPath, '-e', `require('fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setTimeout(()=>{},30000)`]);
      for (let i = 0; i < 200 && !existsSync(pidFile); i += 1) await settle(25);
      assert.ok(existsSync(pidFile), 'the command started');
      assert.ok(existsSync(f.lock), 'the lease is held while it runs');
      assert.equal(f.owner().holder_pid, child.pid, 'the lease is tied to the running run');
      child.kill(signal);
      const result = await exit;
      assert.equal(result.code, code);
      assert.ok(!existsSync(f.lock), 'lease released');
      assert.throws(() => process.kill(Number(readFileSync(pidFile, 'utf8')), 0), 'the command is gone');
    } finally { f.cleanup(); }
  });
}

test('run killed while it waits in the queue drops its place', async () => {
  const f = fixture();
  try {
    await acquireLease('adb', { holder: 'someone', why: 'long proof', forMs: 600_000, id: 'held', env: f.env, log: () => {} });
    const { child, exit } = spawnRun(f, ['run', 's26', '--wait', '60s', '--', 'true']);
    for (let i = 0; i < 200 && !existsSync(join(f.root, 'locks/adb.queue')) || (existsSync(join(f.root, 'locks/adb.queue')) && readdirSync(join(f.root, 'locks/adb.queue')).length === 0); i += 1) await settle(25);
    child.kill('SIGTERM');
    assert.equal((await exit).code, 143);
    assert.deepEqual(readdirSync(join(f.root, 'locks/adb.queue')), []);
    assert.equal(f.owner().lease_id, 'held', 'the holder was not touched');
  } finally { f.cleanup(); }
});

test('waiting runs are served in order once the lease is released', async () => {
  const f = fixture();
  try {
    await acquireLease('adb', { holder: 'someone', why: 'long proof', forMs: 600_000, id: 'held', env: f.env, log: () => {} });
    const log = join(f.root, 'order');
    const runs = [];
    for (const name of ['one', 'two', 'three']) {
      runs.push(spawnRun(f, ['run', 's26', '--wait', '60s', '--why', name, '--', process.execPath, '-e', `require('fs').appendFileSync(${JSON.stringify(log)},'${name}\\n')`]));
      for (let i = 0; i < 200 && readdirSync(join(f.root, 'locks/adb.queue')).length < runs.length; i += 1) await settle(20);
    }
    assert.equal(readdirSync(join(f.root, 'locks/adb.queue')).length, 3);
    releaseLease('adb', 'held', { env: f.env });
    const results = await Promise.all(runs.map(run => run.exit));
    assert.deepEqual(results.map(result => result.code), [0, 0, 0]);
    assert.equal(readFileSync(log, 'utf8'), 'one\ntwo\nthree\n');
    assert.ok(!existsSync(f.lock));
  } finally { f.cleanup(); }
});

test('status observes stale waiter tickets without removing or rewriting them', async () => {
  const f = fixture();
  try {
    const queue = join(f.root, 'locks/adb.queue');
    mkdirSync(queue, { recursive: true });
    const ghost = join(queue, '000000000000001-000000-00000001.json');
    writeFileSync(ghost, JSON.stringify({ lease_id: 'ghost', holder: 'former', why: 'gone', pid: 999999999, host: hostname(), enqueued_at: new Date(0).toISOString() }));
    const bytes = readFileSync(ghost);
    const before = statSync(ghost);
    const result = await f.run(['status', '--json']);
    assert.equal(result.code, 0);
    assert.deepEqual(JSON.parse(result.out.join('\n')).waiters.map(waiter => [waiter.lease_id, waiter.stale]), [['ghost', true]]);
    assert.deepEqual(readFileSync(ghost), bytes);
    assert.equal(statSync(ghost).mtimeMs, before.mtimeMs);
    assert.deepEqual(readdirSync(queue), ['000000000000001-000000-00000001.json']);
  } finally { f.cleanup(); }
});

test('SIGTERM and SIGINT abort phone discovery promptly and release the lease', async t => {
  for (const [signal, code] of [['SIGTERM', 143], ['SIGINT', 130]]) await t.test(signal, async () => {
    const f = fixture();
    try {
      f.away(true);
      const { child, exit } = spawnRun(f, ['run', 's26', '--for', '10m', '--why', 'discovery', '--wait', '6s', '--', process.execPath, '-e', 'process.exit(0)'], { HUB_DEVICE_POLL_MS: '100' });
      for (let i = 0; i < 100 && !f.calls().includes('devices'); i += 1) await settle(20);
      assert.match(f.calls(), /devices/, 'discovery has started');
      assert.ok(existsSync(f.lock), 'the lease is held while looking for the phone');
      const started = Date.now();
      child.kill(signal);
      const result = await exit;
      assert.equal(result.code, code);
      assert.ok(Date.now() - started < 1500, `discovery still waited ${Date.now() - started}ms after ${signal}`);
      assert.ok(!existsSync(f.lock), 'the lease is released promptly');
    } finally { f.cleanup(); }
  });
});

// A /proc of other people's processes.
function fakeProc(root, processes) {
  for (const [pid, { argv, env = {} }] of Object.entries(processes)) {
    const dir = join(root, pid);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'cmdline'), argv.join('\0') + '\0');
    writeFileSync(join(dir, 'environ'), Object.entries(env).map(([k, v]) => `${k}=${v}`).join('\0') + '\0');
    symlinkSync('/tmp', join(dir, 'cwd'));
  }
}

test('the inventory marks the hub\'s own adb server managed and everything else foreign, without touching any of it', () => {
  const root = mkdtempSync(join(tmpdir(), 'hub-proc-'));
  try {
    mkdirSync(join(root, 'locks'));
    writeFileSync(join(root, 'locks/managed.json'), JSON.stringify({ pids: [2400] }));
    fakeProc(join(root, 'proc'), {
      100: { argv: ['adb', '-L', 'tcp:5037', 'fork-server', 'server', '--reply-fd', '4'] },
      101: { argv: ['/sdk/platform-tools/adb', '-L', 'tcp:localhost:15170', 'server', 'nodaemon'] },
      102: { argv: ['adb', 'devices'] },
      103: { argv: ['adb', 'fork-server', 'server'], env: { ANDROID_ADB_SERVER_PORT: '15131' } },
      200: { argv: ['/sdk/emulator/qemu/linux-x86_64/qemu-system-x86_64-headless', '-avd', 'tower-pixel', '-port', '5730', '-no-window'], env: { ANDROID_ADB_SERVER_PORT: '15170' } },
      201: { argv: ['/sdk/emulator/emulator', '-avd', 'tower-pixel', '-port', '5730'] },
      202: { argv: ['qemu-system-x86_64', '-avd', 'hub-owned', '-ports', '5554,5555'], env: { HUB_MANAGED: '1' } },
      203: { argv: ['qemu-system-x86_64', '-name', 'some-vm'] },
      300: { argv: ['Xvfb', ':100', '-screen', '0', '1400x2200x24'] },
      2400: { argv: ['Xvfb', ':101', '-nolisten', 'tcp'] },
      400: { argv: ['node', 'server.mjs'] },
    });
    const found = inventory({ procRoot: join(root, 'proc'), lockRoot: join(root, 'locks') });
    assert.deepEqual(found.adb_servers.map(({ port, pid, managed }) => [port, pid, managed]), [[5037, 100, true], [15170, 101, false], [15131, 103, false]].sort((a, b) => a[1] - b[1]));
    assert.deepEqual(found.emulators.map(({ avd, console_port, adb_server, pid, managed }) => [avd, console_port, adb_server, pid, managed]), [['tower-pixel', 5730, 15170, 200, false], ['hub-owned', 5554, 5037, 202, true]]);
    assert.deepEqual(found.xvfb.map(({ display, pid, managed }) => [display, pid, managed]), [[':100', 300, false], [':101', 2400, true]]);
    assert.deepEqual(inventory({ procRoot: join(root, 'nothing-here'), lockRoot: root }), { adb_servers: [], emulators: [], xvfb: [] });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('status lists leases, waiters and the marked inventory, changes nothing and never calls adb', async () => {
  const f = fixture();
  try {
    await acquireLease('adb', { holder: 'agent-a', why: 'device proof', forMs: 3600_000, id: 'held', env: f.env, log: () => {} });
    const waiting = acquireLease('adb', { holder: 'agent-b', why: 'next in line', forMs: 600_000, id: 'next', waitMs: 10_000, env: f.env, log: () => {}, pollMs: 5 });
    await settle(40);
    await withLock('mac-ios', async () => {}, { env: f.env, log: () => {} });
    const procRoot = join(f.root, 'proc');
    fakeProc(procRoot, {
      100: { argv: ['adb', '-L', 'tcp:5037', 'fork-server', 'server'] },
      200: { argv: ['qemu-system-x86_64-headless', '-avd', 'tower-pixel', '-port', '5730'], env: { ANDROID_ADB_SERVER_PORT: '15170' } },
      300: { argv: ['Xvfb', ':100'] },
    });
    const before = readdirSync(join(f.root, 'locks')).sort();
    const real = () => inventory({ procRoot, lockRoot: join(f.root, 'locks') });
    const json = await f.run(['status', '--json'], { inventory: real });
    assert.equal(json.code, 0);
    const doc = JSON.parse(json.out.join('\n'));
    const lock = doc.locks.find(entry => entry.lock === 'adb');
    assert.deepEqual([lock.device, lock.kind, lock.lease_id, lock.holder, lock.why, lock.stale], ['s26', 'lease', 'held', 'agent-a', 'device proof', false]);
    assert.deepEqual(doc.waiters.map(waiter => [waiter.device, waiter.position, waiter.lease_id, waiter.holder]), [['s26', 1, 'next', 'agent-b']]);
    assert.deepEqual(doc.inventory.adb_servers.map(server => server.managed), [true]);
    assert.deepEqual(doc.inventory.emulators.map(emulator => [emulator.avd, emulator.managed]), [['tower-pixel', false]]);
    assert.deepEqual(doc.inventory.xvfb.map(display => [display.display, display.managed]), [[':100', false]]);
    const text = (await f.run(['status'], { inventory: real })).out.join('\n');
    assert.match(text, /s26 \(adb\)  LEASE held  holder=agent-a  why="device proof"  expires in 60m/);
    assert.match(text, /s26 #1  next  holder=agent-b/);
    assert.match(text, /adb server  port 5037  pid 100  managed/);
    assert.match(text, /emulator  avd tower-pixel  console port 5730  adb server 15170  pid 200  foreign/);
    assert.match(text, /Xvfb  display :100  pid 300  foreign/);
    assert.equal(f.calls(), '', 'status never calls adb');
    assert.deepEqual(readdirSync(join(f.root, 'locks')).sort(), before, 'status changed nothing');
    assert.equal(f.owner().lease_id, 'held');
    releaseLease('adb', 'next', { env: f.env });
    await assert.rejects(waiting, error => error.code === 'HUB_LEASE_CANCELLED');
  } finally { f.cleanup(); }
});

test('status with nothing held says so', async () => {
  const f = fixture();
  try {
    const result = await f.run(['status']);
    assert.deepEqual(result.out, ['LOCKS', '  none held', 'WAITERS', '  none', 'INVENTORY (read only)', '  nothing running']);
  } finally { f.cleanup(); }
});

test('hub-device never kills, starts or reconnects: its source has no kill of a foreign process, no emulator or Xvfb launch, no adb kill-server/disconnect', () => {
  const source = readFileSync(tool, 'utf8') + readFileSync(join(hubRoot, 'tools/device/inventory.mjs'), 'utf8');
  assert.doesNotMatch(source, /kill-server|disconnect|\bpkill\b|\bkillall\b|emulator -avd|spawn\(\s*['"](?:Xvfb|emulator|adb)/);
  assert.doesNotMatch(readFileSync(join(hubRoot, 'tools/device/inventory.mjs'), 'utf8'), /process\.kill|child_process|writeFile|rmSync|unlink/, 'the inventory only reads');
});

test('install.sh links hub-device into ~/.local/bin without touching systemd, the timers or a live host', () => {
  const home = mkdtempSync(join(tmpdir(), 'hub-install-'));
  try {
    const node = join(home, '.local/share/mise/installs/node/24/bin');
    mkdirSync(node, { recursive: true });
    symlinkSync(process.execPath, join(node, 'node'));
    const shims = join(home, 'shims');
    mkdirSync(shims);
    writeFileSync(join(shims, 'systemctl'), `#!/bin/sh\necho "$*" >> "${home}/systemctl.log"\n`);
    chmodSync(join(shims, 'systemctl'), 0o755);
    const env = { PATH: `${shims}:${process.env.PATH}`, HOME: home, HUB_LOCK_DIR: join(home, 'locks') };
    const install = spawnSync('bash', [join(hubRoot, 'tools/catchup/units/install.sh'), 'mobi2-test'], { env, encoding: 'utf8' });
    assert.equal(install.status, 0, install.stdout + install.stderr);
    const link = join(home, '.local/bin/hub-device');
    const release = join(home, '.local/share/mobile-deploy-hub/releases/mobi2-test');
    assert.equal(readFileSync(join(home, 'systemctl.log'), 'utf8'), '--user daemon-reload\n', 'systemd was only told to re-read units: no enable, no start');
    assert.ok(statSync(link).mode & 0o111, 'executable');
    const target = readFileSync(link, 'utf8');
    assert.match(target, /^#!\/usr\/bin\/env node\n/);
    assert.equal(readlinkSync(link), join(release, 'tools/device/hub-device.mjs'));
    // through the link, the copy in the release answers
    const status = spawnSync(link, ['status', '--json'], { env, encoding: 'utf8' });
    assert.equal(status.status, 0, status.stderr);
    assert.deepEqual(JSON.parse(status.stdout).locks, []);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
