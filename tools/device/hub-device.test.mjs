// hub-device: lease/release/status/run against a fake adb binary and a temp lock directory. No real phone, adb server,
// emulator or Xvfb is touched: the inventory reads a fake /proc tree, and the signal tests drive a child process.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAdb, findPhone } from '../ci/lib/adb.mjs';
import { loadDevices } from '../ci/lib/devices.mjs';
import { acquireLease, releaseLease, withLock } from '../ci/lib/lock.mjs';
import { runAdb } from './async-adb.mjs';
import { inventory } from './inventory.mjs';
import { leaseSupport, main, parseArgs, parseDuration } from './hub-device.mjs';

const tool = fileURLToPath(new URL('./hub-device.mjs', import.meta.url));
const hubRoot = fileURLToPath(new URL('../../', import.meta.url));
const SERIAL = 'R5GL43A7PCH';          // the S26, the deploy phone
const S24_SERIAL = 'R5CX31AEJDA';      // the extra phone in devices.json's android_extra
const settle = ms => new Promise(done => setTimeout(done, ms));

// The two phones as a shell script over a state folder: `away-<serial>` hides one, `unauth-<serial>` lists it
// unauthorized, every call is logged. getprop answers by the serial embedded in the adb id, as the real one does.
const fakeAdb = state => `#!/bin/sh
echo "$*" >> "${state}/calls.log"
id=""
[ "$1" = "-s" ] && { id="$2"; shift 2; }
case "$1" in
  start-server|connect) exit 0 ;;
  mdns) printf 'adb-${S24_SERIAL}-YYVl71._adb-tls-connect._tcp\\t_adb-tls-connect._tcp\\t192.168.1.34:38423\\nadb-${SERIAL}-qq._adb-tls-connect._tcp\\t_adb-tls-connect._tcp\\t192.168.1.50:41234\\n'; exit 0 ;;
  devices)
    printf 'List of devices attached\\n'
    for s in ${S24_SERIAL} ${SERIAL}; do
      [ -f "${state}/away-$s" ] && continue
      [ -f "${state}/unauth-$s" ] && { printf 'adb-%s-zz._adb-tls-connect._tcp\\tunauthorized\\n' "$s"; continue; }
      printf 'adb-%s-zz._adb-tls-connect._tcp\\tdevice\\n' "$s"
    done
    exit 0 ;;
  shell)
    s=$(printf '%s' "$id" | sed -e 's/^adb-//' -e 's/-.*//')
    case "$2 $3" in
      "getprop ro.serialno") printf '%s\\n' "$s" ;;
      "getprop ro.product.model") case "$s" in ${S24_SERIAL}) echo SM-S928U ;; *) echo SM-S948U ;; esac ;;
      *) exit 1 ;;
    esac ;;
  *) exit 1 ;;
esac
`;

const serialOf = { s24: S24_SERIAL, s26: SERIAL };

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'hub-device-'));
  const state = join(root, 'phone');
  mkdirSync(state, { recursive: true });
  const adb = join(root, 'adb');
  writeFileSync(adb, fakeAdb(state));
  chmodSync(adb, 0o755);
  const env = { PATH: process.env.PATH, HOME: root, USER: 'tester', HUB_ADB: adb, HUB_LOCK_DIR: join(root, 'locks'), HUB_DEVICE_POLL_MS: '5', HUB_DEVICE_PHONE_SLICE_MS: '300', HUB_ADB_SERVER_PORT: '5037' };
  const run = async (argv, extra = {}) => {
    const out = [];
    const err = [];
    const code = await main(argv, { env, stdout: line => out.push(line), stderr: line => err.push(line), inventory: () => ({ adb_servers: [], emulators: [], xvfb: [] }), ...extra });
    return { code, out, err };
  };
  const flag = (name, on) => { const file = join(state, name); if (on) writeFileSync(file, ''); else rmSync(file, { force: true }); };
  return {
    root, env, state, run, lock: join(root, 'locks/adb.lock'), s24lock: join(root, 'locks/s24.lock'),
    away: (device, on = true) => flag(`away-${serialOf[device]}`, on),
    unauth: (device, on = true) => flag(`unauth-${serialOf[device]}`, on),
    calls: () => { try { return readFileSync(join(state, 'calls.log'), 'utf8'); } catch { return ''; } },
    owner: (lock = 'adb') => JSON.parse(readFileSync(join(root, `locks/${lock}.lock/owner.json`), 'utf8')),
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
    assert.ok(result.err.some(line => /^HUB_PHONE SM-S948U serial=R5GL43A7PCH/.test(line)), 'findPhone ran and named the phone');
    const owner = f.owner();
    assert.equal(owner.kind, 'lease');
    assert.equal(owner.why, 'device proof');
    assert.equal(owner.holder, 'tester@' + owner.host);
    assert.equal(owner.lease_id, vars.HUB_LEASE_ID);
    assert.equal(owner.device.adb_id, vars.ANDROID_SERIAL);
    assert.equal(owner.device.serial, SERIAL, 'the record names the hardware serial, not the changing adb id');
    assert.ok(Date.parse(owner.expires_at) - Date.now() > 29 * 60_000);
    // the lease outlives main(): another taker is refused, then served after release
    const busy = await f.run(['lease', 's26', '--for', '5m', '--why', 'other', '--wait', '0']);
    assert.equal(busy.code, 76);
    assert.deepEqual(busy.out, [], 'BUSY never reaches stdout, so `vars=$(...) && eval "$vars"` cannot run it');
    assert.match(busy.err.join('\n'), /^HUB_DEVICE_BUSY s26 host lock adb is held by lease l-.* of tester@/m);
    const released = await f.run(['release', vars.HUB_LEASE_ID]);
    assert.deepEqual([released.code, released.out], [0, [`HUB_DEVICE_RELEASED s26 ${vars.HUB_LEASE_ID}`]]);
    assert.ok(!existsSync(f.lock));
    assert.deepEqual((await f.run(['release', vars.HUB_LEASE_ID])).out, [`HUB_DEVICE_NOT_HELD phone ${vars.HUB_LEASE_ID} (no phone lease by that id)`], 'release is idempotent');
    const again = await f.run(['lease', 's26', '--for', '5m', '--why', 'other', '--wait', '0', '--json']);
    assert.equal(again.code, 0);
    const json = JSON.parse(again.out[0]);
    assert.equal(json.env.ANDROID_ADB_SERVER_PORT, '5037');
    // --any frees whatever lease holds it; a bare release refuses instead
    assert.equal((await f.run(['release', '--any'])).out[0], `HUB_DEVICE_RELEASED s26 ${json.lease_id}`);
    assert.equal((await f.run(['release'])).code, 2);
  } finally { f.cleanup(); }
});

test('release never touches a deploy job or another lease', async () => {
  const f = fixture();
  try {
    let done;
    const job = withLock('adb', () => new Promise(resolve => { done = resolve; }), { env: f.env, log: () => {} });
    await settle(20);
    const bare = await f.run(['release', '--any']);
    assert.equal(bare.code, 1);
    assert.match(bare.err.join(), /held by a deploy job, not a lease/);
    assert.equal((await f.run(['release', 'l-abc'])).code, 0, 'an id that is not held is not held');
    assert.equal((await f.run(['release'])).code, 2, 'and a bare release refuses rather than acting');
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
    f.away('s26');
    const result = await f.run(['lease', 's26', '--for', '5m', '--why', 'x', '--wait', '0']);
    assert.deepEqual([result.code, result.out], [75, ['HUB_DEVICE_AWAY s26']]);
    assert.match(result.err.join('\n'), /s26 is away: absent/, 'the reason is always said');
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
    f.away('s26');
    const result = await f.run(['lease', 's26', '--for', '5m', '--why', 'x', '--wait', '1s']);
    assert.equal(result.code, 75);
    assert.match(f.calls(), /^mdns services$/m, 'findPhone asked mDNS for the phone');
    assert.match(f.calls(), /^connect 192\.168\.1\.50:41234$/m, 'and connected to the endpoint mDNS listed');
    assert.ok(result.err.some(line => /HUB_PHONE_CONNECT 192\.168\.1\.50:41234/.test(line)));
  } finally { f.cleanup(); }
});

test('--no-connect takes the lease without touching adb, even with the phone away', async () => {
  const f = fixture();
  try {
    f.away('s26');
    const result = await f.run(['lease', 's26', '--for', '12h', '--why', 'gib: hold', '--no-connect', '--id', 'gib-hold']);
    assert.equal(result.code, 0, result.err.join());
    assert.deepEqual(result.out, ["export HUB_LEASE_ID='gib-hold'", "export HUB_DEVICE='s26'", "export ANDROID_ADB_SERVER_PORT='5037'"]);
    assert.equal(f.calls(), '', 'adb was never called');
    assert.equal(f.owner().lease_id, 'gib-hold');
    assert.equal(f.owner().device, undefined);
    assert.equal((await f.run(['release', 'gib-hold'])).code, 0);
  } finally { f.cleanup(); }
});

test('the s24 leases under its own lock, connects by its serial, and never blocks the s26 or a deploy', async () => {
  const f = fixture();
  try {
    const result = await f.run(['lease', 's24', '--for', '30m', '--why', 'S24 proof', '--env-serial', 'MY_PHONE', '--json']);
    assert.equal(result.code, 0, result.err.join('\n'));
    const json = JSON.parse(result.out[0]);
    assert.equal(json.device, 's24');
    assert.equal(json.env.HUB_DEVICE, 's24');
    assert.equal(json.env.ANDROID_SERIAL, `adb-${S24_SERIAL}-zz._adb-tls-connect._tcp`);
    assert.equal(json.env.MY_PHONE, json.env.ANDROID_SERIAL);
    assert.equal(json.env.ANDROID_ADB_SERVER_PORT, '5037');
    assert.ok(result.err.some(line => /^HUB_PHONE SM-S928U serial=R5CX31AEJDA/.test(line)), 'the S24 was found by its serial');
    const owner = f.owner('s24');
    assert.equal(owner.lease_id, json.lease_id);
    assert.deepEqual([owner.device.phone, owner.device.serial], ['s24', S24_SERIAL]);
    assert.ok(!existsSync(f.lock), 'the deploy lock (adb) is untouched');
    // its own lock, its own queue: a second s24 lease waits or is busy, an s26 lease sails through, and so does a deploy
    const busy = await f.run(['lease', 's24', '--for', '5m', '--why', 'other', '--wait', '0']);
    assert.equal(busy.code, 76);
    assert.match(busy.err.join('\n'), /^HUB_DEVICE_BUSY s24 host lock s24 is held by lease /m);
    const deploy = withLock('adb', async () => 'deploy ran', { env: f.env, log: () => {} });
    assert.equal(await deploy, 'deploy ran', 'an s24 lease does not block the deploy lock');
    const s26 = await f.run(['lease', 's26', '--for', '5m', '--why', 'meanwhile', '--id', 's26-mine']);
    assert.equal(s26.code, 0, s26.err.join('\n'));
    // release by the lease id frees the s24 whatever phone it names; each release says which phone it freed
    assert.deepEqual((await f.run(['release', json.lease_id])).out, [`HUB_DEVICE_RELEASED s24 ${json.lease_id}`]);
    assert.deepEqual((await f.run(['release', 's26-mine'])).out, ['HUB_DEVICE_RELEASED s26 s26-mine']);
    assert.ok(!existsSync(f.s24lock) && !existsSync(f.lock), 'both locks are free again');
  } finally { f.cleanup(); }
});

test('run s24 exports the S24 to the command, returns its code and releases its lock', async () => {
  const f = fixture();
  try {
    const probe = join(f.root, 'probe');
    const script = `const fs=require('fs');const e=process.env;fs.writeFileSync(${JSON.stringify(probe)},JSON.stringify({d:e.HUB_DEVICE,s:e.ANDROID_SERIAL,held:fs.existsSync(${JSON.stringify(f.s24lock)}),adbLock:fs.existsSync(${JSON.stringify(f.lock)})}));process.exit(Number(process.argv[1]))`;
    const ok = await f.run(['run', 's24', '--for', '10m', '--why', 'probe', '--', process.execPath, '-e', script, '0']);
    assert.equal(ok.code, 0, ok.err.join());
    const seen = JSON.parse(readFileSync(probe, 'utf8'));
    assert.deepEqual([seen.d, seen.s, seen.held, seen.adbLock], ['s24', `adb-${S24_SERIAL}-zz._adb-tls-connect._tcp`, true, false]);
    assert.ok(!existsSync(f.s24lock), 'released after success');
    const failed = await f.run(['run', 's24', '--', process.execPath, '-e', script, '3']);
    assert.equal(failed.code, 3, 'the command exit code comes back');
    assert.ok(!existsSync(f.s24lock), 'released after failure');
  } finally { f.cleanup(); }
});

test('phone takes whichever phone is free, s24 first, and says which one it took', async () => {
  const f = fixture();
  try {
    // both free and reachable: the s24, the first in the fleet
    const first = await f.run(['lease', 'phone', '--for', '5m', '--why', 'any phone', '--id', 'p1', '--json']);
    assert.equal(first.code, 0, first.err.join('\n'));
    assert.equal(JSON.parse(first.out[0]).device, 's24');
    assert.equal(f.owner('s24').lease_id, 'p1');
    // the s24 held: the s26, without waiting out the slice (the s24 is merely held, not away)
    const second = await f.run(['lease', 'phone', '--for', '5m', '--why', 'fallback', '--id', 'p2']);
    assert.equal(second.code, 0, second.err.join('\n'));
    assert.match(second.out.join('\n'), /export HUB_DEVICE='s26'/);
    assert.equal(f.owner().lease_id, 'p2');
    await f.run(['release', 'p1']);
    await f.run(['release', 'p2']);
    // the s24 away: the s26, after one slice of looking for the s24
    f.away('s24');
    const third = await f.run(['lease', 'phone', '--for', '5m', '--why', 'fallback', '--id', 'p3', '--json']);
    assert.equal(third.code, 0, third.err.join('\n'));
    assert.equal(JSON.parse(third.out[0]).device, 's26');
    assert.ok(!existsSync(f.s24lock), 'the away s24 was looked for and its lock given back');
    await f.run(['release', 'p3']);
    // and run phone behaves the same way
    f.away('s24', false);
    const probe = join(f.root, 'probe');
    const ran = await f.run(['run', 'phone', '--', process.execPath, '-e', `require('fs').writeFileSync(${JSON.stringify(probe)}, process.env.HUB_DEVICE + ' ' + process.env.ANDROID_SERIAL)`]);
    assert.equal(ran.code, 0, ran.err.join());
    assert.equal(readFileSync(probe, 'utf8'), `s24 adb-${S24_SERIAL}-zz._adb-tls-connect._tcp`);
  } finally { f.cleanup(); }
});

test('phone with every phone held is BUSY naming the holders; with every free phone away it is AWAY', async () => {
  const f = fixture();
  try {
    await acquireLease('s24', { holder: 'agent-a', why: 'long proof', forMs: 600_000, id: 'on-s24', env: f.env, log: () => {} });
    await acquireLease('adb', { holder: 'agent-b', why: 'another', forMs: 600_000, id: 'on-s26', env: f.env, log: () => {} });
    const busy = await f.run(['lease', 'phone', '--for', '5m', '--why', 'x', '--wait', '0']);
    assert.equal(busy.code, 76);
    assert.deepEqual(busy.out, [], 'BUSY never reaches stdout');
    assert.match(busy.err.join('\n'), /^HUB_DEVICE_BUSY phone every phone is held: s24 \(s24\) is held by lease on-s24 of agent-a \(long proof\).*s26 \(adb\) is held by lease on-s26 of agent-b/m);
    const busyRun = await f.run(['run', 'phone', '--wait', '0', '--', 'true']);
    assert.equal(busyRun.code, 76);
    await f.run(['release', 'on-s24']);
    await f.run(['release', 'on-s26']);
    // free but neither reachable: AWAY, with each phone's reason on stderr
    f.away('s24');
    f.unauth('s26');
    const away = await f.run(['lease', 'phone', '--for', '5m', '--why', 'x', '--wait', '0', '--verbose']);
    assert.deepEqual([away.code, away.out], [75, ['HUB_DEVICE_AWAY phone']]);
    assert.match(away.err.join('\n'), /phone is away: absent, unauthorized/, 'the reasons come in fleet order, deduped');
    assert.match(away.err.join('\n'), /no free phone came within the wait: s24 absent, s26 unauthorized/);
    assert.ok(!existsSync(f.s24lock) && !existsSync(f.lock), 'no lock was kept');
    // one phone away, the other held: still AWAY, because turning the away one on is the actionable fix
    const s26held = await f.run(['lease', 's26', '--for', '5m', '--why', 'held', '--id', 'h1', '--no-connect']);
    assert.equal(s26held.code, 0);
    const mixed = await f.run(['lease', 'phone', '--for', '5m', '--why', 'x', '--wait', '0']);
    assert.equal(mixed.code, 75, mixed.err.join('\n'));
    await f.run(['release', 'h1']);
  } finally { f.cleanup(); }
});

test('the s24 away says why on stderr: absent, unauthorized', async () => {
  const f = fixture();
  try {
    f.unauth('s24');
    f.away('s26');
    const unauthorized = await f.run(['lease', 's24', '--for', '5m', '--why', 'x', '--wait', '0', '--verbose']);
    assert.deepEqual([unauthorized.code, unauthorized.out], [75, ['HUB_DEVICE_AWAY s24']]);
    assert.match(unauthorized.err.join('\n'), /s24 is away: unauthorized/);
    assert.match(unauthorized.err.join('\n'), /shows unauthorized.*Redo the Wireless debugging pairing/s, '--verbose adds the detail that names the fix');
    f.unauth('s24', false);
    f.away('s24');
    const gone = await f.run(['lease', 's24', '--for', '5m', '--why', 'x', '--wait', '0']);
    assert.deepEqual([gone.code, gone.out], [75, ['HUB_DEVICE_AWAY s24']]);
    assert.match(gone.err.join('\n'), /s24 is away: absent/);
    assert.ok(!existsSync(f.s24lock), 'nothing held');
  } finally { f.cleanup(); }
});

test('the extra phones are hub-device\'s alone: no deploy-side reader of devices.json touches android_extra, and the deploy phone is still the S26', () => {
  const devices = loadDevices();
  assert.deepEqual([devices.android.serial, devices.android.model], ['R5GL43A7PCH', 'SM-S948U'], 'devices.android is unchanged: what every deploy reads');
  const sides = ['tools/deploy.mjs', 'tools/hosts.mjs', 'tools/ci/macwatch.mjs'];
  for (const dir of ['tools/ci/commands', 'tools/ci/lib', 'tools/catchup']) {
    for (const file of readdirSync(join(hubRoot, dir)).filter(name => name.endsWith('.mjs'))) sides.push(join(dir, file));
  }
  for (const side of sides) {
    if (side.endsWith('tools/ci/lib/devices.mjs')) continue;   // the one definition and its validation
    assert.doesNotMatch(readFileSync(join(hubRoot, side), 'utf8'), /android_extra/, `${side} reads devices.android only`);
  }
});

test('a devices.json without android_extra still leases: phone means the s26, and s24 is not a device', async () => {
  const f = fixture();
  try {
    const bare = { ...loadDevices(), android_extra: undefined };
    delete bare.android_extra;
    const file = join(f.root, 'devices.json');
    writeFileSync(file, JSON.stringify(bare));
    f.env.HUB_DEVICES = file;
    assert.match((await f.run(['lease', 's24', '--for', '5m', '--why', 'x'])).err.join(), /unknown device "s24" \(known: s26, phone, emulator\)/);
    const result = await f.run(['lease', 'phone', '--for', '5m', '--why', 'any phone', '--id', 'only']);
    assert.equal(result.code, 0, result.err.join('\n'));
    assert.match(result.out.join('\n'), /export HUB_DEVICE='s26'/);
    await f.run(['release', 'only']);
    const status = (await f.run(['status'])).out;
    const phonesBlock = status.slice(status.findIndex(line => line.startsWith('PHONES')) + 1, status.indexOf('LOCKS'));
    assert.deepEqual(phonesBlock, ['  s26  free  no adb server  SM-S948U  serial R5GL43A7PCH  lock adb  (the deploy phone)']);
  } finally { f.cleanup(); }
});

test('release --any frees whichever phone lease is held; a deploy job on one phone does not stop the other being freed', async () => {
  const f = fixture();
  try {
    let done;
    const job = withLock('s24', () => new Promise(resolve => { done = resolve; }), { env: f.env, log: () => {} });
    await settle(20);
    await acquireLease('adb', { holder: 'agent-a', why: 'proof', forMs: 600_000, id: 'on-s26', env: f.env, log: () => {} });
    const result = await f.run(['release', '--any']);
    assert.deepEqual([result.code, result.out], [0, ['HUB_DEVICE_RELEASED s26 on-s26']], 'the s26 lease was freed');
    assert.ok(existsSync(f.s24lock), 'the deploy job on the s24 was left alone');
    assert.equal(f.owner('s24').kind, undefined, 'the job lock is not a lease record');
    done();
    await job;
    assert.ok(!existsSync(f.s24lock));
  } finally { f.cleanup(); }
});

test('status settles as soon as the phones are answered: the query timeout is cleared, not left holding the process open', async () => {
  const f = fixture();
  let decoy = null;
  try {
    // a decoy posing as the adb server on 5039 (the inventory reads /proc and matches adb ... server); the fake
    // HUB_ADB answers at once, so any lingering five-second query timer would show up as the process not exiting.
    decoy = spawn('/bin/sh', ['-c', 'while :; do sleep 5; done', 'server'], { argv0: 'adb', env: { ...process.env, ANDROID_ADB_SERVER_PORT: '5039' }, stdio: 'ignore' });
    for (let i = 0; i < 200; i += 1) {
      let cmdline = '';
      try { cmdline = readFileSync(`/proc/${decoy.pid}/cmdline`, 'utf8'); } catch { /* not yet */ }
      if (/^adb\0.*server\0/.test(cmdline)) break;
      await settle(10);
    }
    const started = Date.now();
    const child = spawn(process.execPath, [tool, 'status'], { env: { ...f.env, HUB_ADB_SERVER_PORT: '5039' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', chunk => { out += chunk; });
    child.stderr.resume();
    const closed = new Promise(done => child.on('close', (code, signal) => done({ code, signal })));
    const result = await closed;
    const elapsed = Date.now() - started;
    assert.equal(result.code, 0, out);
    assert.ok(elapsed < 1500, `status took ${elapsed}ms to exit after the phones were answered; the query timer should be cleared`);
    assert.match(out, /s24  free  reachable/, 'the fake adb answered the presence query');
    assert.match(out, /s26  free  reachable/);
  } finally {
    decoy?.kill('SIGKILL');
    f.cleanup();
  }
});

test('status asks the hub port whatever a stray ANDROID_ADB_SERVER_PORT says, and starts no server', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hub-presence-'));
  let decoy = null;
  try {
    const state = join(root, 'state');
    mkdirSync(state, { recursive: true });
    const adb = join(root, 'adb');
    // The fake serves devices only on the hub port (5039); any other ANDROID_ADB_SERVER_PORT is recorded and fails,
    // the way a real adb would reach a different server — or start one on a dead port.
    writeFileSync(adb, `#!/bin/sh
echo "$*" >> "${state}/calls.log"
echo "$ANDROID_ADB_SERVER_PORT" >> "${state}/ports.log"
[ "$ANDROID_ADB_SERVER_PORT" = "5039" ] || { echo "stray port $ANDROID_ADB_SERVER_PORT" >> "${state}/stray.log"; exit 1; }
[ "$1" = devices ] && printf 'List of devices attached\\nadb-${S24_SERIAL}-zz._adb-tls-connect._tcp\\tdevice\\nadb-${SERIAL}-zz._adb-tls-connect._tcp\\tdevice\\n'
exit 0
`);
    chmodSync(adb, 0o755);
    decoy = spawn('/bin/sh', ['-c', 'while :; do sleep 5; done', 'server'], { argv0: 'adb', env: { ...process.env, ANDROID_ADB_SERVER_PORT: '5039' }, stdio: 'ignore' });
    for (let i = 0; i < 200; i += 1) {
      let cmdline = '';
      try { cmdline = readFileSync(`/proc/${decoy.pid}/cmdline`, 'utf8'); } catch { /* not yet */ }
      if (/^adb\0.*server\0/.test(cmdline)) break;
      await settle(10);
    }
    // a stray ANDROID_ADB_SERVER_PORT names a dead port; the presence query must go to the hub port regardless
    const child = spawn(process.execPath, [tool, 'status'], { env: { PATH: process.env.PATH, HOME: root, USER: 'tester', HUB_ADB: adb, HUB_LOCK_DIR: join(root, 'locks'), HUB_ADB_SERVER_PORT: '5039', ANDROID_ADB_SERVER_PORT: '15170' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', chunk => { out += chunk; });
    child.stderr.resume();
    const result = await new Promise(done => child.on('close', (code, signal) => done({ code, signal })));
    assert.equal(result.code, 0, out);
    assert.match(out, /s24  free  reachable/, 'the hub port answered for both phones');
    assert.match(out, /s26  free  reachable/);
    assert.ok(!existsSync(join(state, 'stray.log')), 'the stray port never reached the adb client');
    assert.ok(readFileSync(join(state, 'ports.log'), 'utf8').trim().split('\n').every(port => port === '5039'), 'every query went to the hub port');
    assert.doesNotMatch(readFileSync(join(state, 'calls.log'), 'utf8'), /start-server/, 'status starts nothing');
  } finally {
    decoy?.kill('SIGKILL');
    rmSync(root, { recursive: true, force: true });
  }
});

test('a --id that already names a lease or a waiter anywhere is refused: one id, one lease', async () => {
  const f = fixture();
  try {
    await f.run(['lease', 's24', '--for', '1h', '--why', 'hold', '--no-connect', '--id', 'dup']);
    for (const device of ['s24', 's26', 'phone']) {
      const refused = await f.run(['lease', device, '--for', '5m', '--why', 'x', '--no-connect', '--id', 'dup', '--wait', '0']);
      assert.equal(refused.code, 2, device);
      assert.match(refused.err.join('\n'), /--id dup already names a lease or a waiter on s24/, device);
    }
    assert.equal(f.calls(), '', 'a refused --id never reaches adb');
    // a waiting ticket counts too, on either lock
    await f.run(['lease', 's26', '--for', '30m', '--why', 'held', '--no-connect', '--id', 'holder', '--wait', '0']);
    const waiting = f.run(['lease', 's26', '--for', '30m', '--why', 'queued', '--no-connect', '--id', 'queued-one', '--wait', '10s']);
    await settle(60);
    const refused = await f.run(['lease', 's24', '--for', '5m', '--why', 'x', '--no-connect', '--id', 'queued-one', '--wait', '0']);
    assert.equal(refused.code, 2);
    assert.match(refused.err.join('\n'), /--id queued-one already names a lease or a waiter on s26/);
    await f.run(['release', 'holder']);
    assert.equal((await waiting).code, 0, 'the queued lease itself was never refused');
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
    const queue = join(f.root, 'locks/adb.queue');
    const queued = () => existsSync(queue) && readdirSync(queue).length > 0;
    for (let i = 0; i < 200 && !queued(); i += 1) await settle(25);
    assert.ok(queued(), 'the run is queued behind the lease');
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
      f.away('s26');
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

// adb itself is slow here (a `devices` that takes 4 s, the way a wedged server answers): a signal must kill that call,
// not wait it out, on both commands that look for the phone.
for (const command of ['run', 'lease']) {
  for (const [signal, code] of [['SIGTERM', 143], ['SIGINT', 130]]) {
    test(`${command}: ${signal} during a slow adb call exits within a second, holding nothing`, async () => {
      const root = mkdtempSync(join(tmpdir(), 'hub-slow-adb-'));
      try {
        const adb = join(root, 'adb');
        writeFileSync(adb, `#!/bin/sh
case "$1" in
  start-server) exit 0 ;;
  devices) touch "${root}/entered"; sleep 4; printf 'List of devices attached\\n'; exit 0 ;;
  *) exit 1 ;;
esac
`);
        chmodSync(adb, 0o755);
        const args = command === 'run'
          ? ['run', 's26', '--wait', '30s', '--', process.execPath, '-e', 'process.exit(0)']
          : ['lease', 's26', '--for', '5m', '--why', 'slow adb', '--wait', '30s'];
        const child = spawn(process.execPath, [tool, ...args], { env: { ...process.env, HUB_ADB: adb, HUB_LOCK_DIR: join(root, 'locks') }, stdio: ['ignore', 'pipe', 'pipe'] });
        child.stdout.resume();
        child.stderr.resume();
        const exit = new Promise(done => child.on('close', (status, how) => done({ status, how })));
        for (let i = 0; i < 300 && !existsSync(join(root, 'entered')); i += 1) await settle(10);
        assert.ok(existsSync(join(root, 'entered')), 'the slow adb devices call is in flight');
        assert.ok(existsSync(join(root, 'locks/adb.lock')), 'the lease is held while looking for the phone');
        const start = Date.now();
        child.kill(signal);
        const result = await exit;
        const elapsed = Date.now() - start;
        assert.equal(result.status, code);
        assert.ok(elapsed < 1000, `exited ${elapsed}ms after ${signal}`);
        assert.ok(!existsSync(join(root, 'locks/adb.lock')), 'nothing held');
        assert.deepEqual(readdirSync(join(root, 'locks/adb.queue')), [], 'no queue ticket left');
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
}

test('the async adb runner kills its child on abort; the deploy path\'s createAdb still answers synchronously', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hub-async-adb-'));
  try {
    const adb = join(root, 'adb');
    writeFileSync(adb, `#!/bin/sh\necho $$ > "${root}/pid"\nexec sleep 30\n`);
    chmodSync(adb, 0o755);
    const controller = new AbortController();
    const running = runAdb(adb, ['devices'], { env: process.env, signal: controller.signal });
    for (let i = 0; i < 300 && !existsSync(join(root, 'pid')); i += 1) await settle(10);
    const pid = Number(readFileSync(join(root, 'pid'), 'utf8'));
    controller.abort();
    await assert.rejects(running, error => error.name === 'AbortError');
    await settle(50);
    assert.throws(() => process.kill(pid, 0), 'the adb child is gone');
    const calls = [];
    const runner = (command, args, options) => { calls.push({ args, env: options.env }); return args[0] === 'devices' ? 'List of devices attached\nabc\tdevice\n' : 'R5GL43A7PCH\n'; };
    const sync = createAdb({ env: { PATH: '/bin', GH_TOKEN: 'secret' }, runner });
    const devices = sync.devices();
    assert.ok(Array.isArray(devices), 'devices() returns the list itself, not a promise');
    assert.deepEqual(devices, [{ id: 'abc', state: 'device' }]);
    assert.equal(sync.prop('abc', 'ro.serialno'), 'R5GL43A7PCH');
    assert.equal(calls[0].env.GH_TOKEN, undefined, 'no credential reaches adb (shared adbEnv)');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('release says what it found, per reason, and falls back to $HUB_LEASE_ID', async () => {
  const f = fixture();
  try {
    const bare = await f.run(['release']);
    assert.deepEqual([bare.code, bare.out, bare.err], [2, [], ['hub-device: release needs a lease id, $HUB_LEASE_ID, or --any to free whichever lease holds a phone']], 'a bare release refuses rather than freeing whatever is there');
    assert.deepEqual((await f.run(['release', '--any'])).out, ['HUB_DEVICE_NOT_HELD phone - (no phone is held)']);
    await acquireLease('adb', { holder: 'agent-a', why: 'proof', forMs: 600_000, id: 'held', env: f.env, log: () => {} });
    const other = await f.run(['release', 'mine']);
    assert.deepEqual([other.code, other.out, other.err], [0, ['HUB_DEVICE_NOT_HELD phone mine (no phone lease by that id)'], ['hub-device: s26 is leased as held (agent-a), not mine; left alone']]);
    f.env.HUB_LEASE_ID = 'mine';
    assert.deepEqual((await f.run(['release'])).out, ['HUB_DEVICE_NOT_HELD phone mine (no phone lease by that id)'], 'no id: $HUB_LEASE_ID, which is not the holder');
    assert.equal(f.owner().lease_id, 'held');
    f.env.HUB_LEASE_ID = 'held';
    assert.deepEqual((await f.run(['release'])).out, ['HUB_DEVICE_RELEASED s26 held'], 'no id: $HUB_LEASE_ID');
    delete f.env.HUB_LEASE_ID;
    await acquireLease('adb', { holder: 'agent-b', why: 'again', forMs: 600_000, id: 'other', env: f.env, log: () => {} });
    assert.deepEqual((await f.run(['release', '--any'])).out, ['HUB_DEVICE_RELEASED s26 other'], '--any frees whichever lease holds a phone');
    assert.match((await f.run(['release', 'x', '--any'])).err.join(), /--any or an id, not both/);
    let done;
    const job = withLock('adb', () => new Promise(resolve => { done = resolve; }), { env: f.env, log: () => {} });
    await settle(20);
    const withId = await f.run(['release', 'mine']);
    assert.deepEqual([withId.code, withId.out, withId.err], [0, ['HUB_DEVICE_NOT_HELD phone mine (no phone lease by that id)'], ['hub-device: s26 is held by a deploy job now; left alone']]);
    const bareHere = await f.run(['release']);
    assert.deepEqual([bareHere.code, bareHere.err], [2, ['hub-device: release needs a lease id, $HUB_LEASE_ID, or --any to free whichever lease holds a phone']], 'a bare release never acts on whatever holds the lock');
    const jobHeld = await f.run(['release', '--any']);
    assert.deepEqual([jobHeld.code, jobHeld.err], [1, ['hub-device: s26 is held by a deploy job, not a lease; left alone']]);
    done();
    await job;
    mkdirSync(f.lock, { recursive: true });
    const half = await f.run(['release', '--any']);
    assert.deepEqual([half.code, half.err], [1, ['hub-device: s26 is being taken (its lock has no owner record yet); left alone, try again']]);
    assert.ok(existsSync(f.lock), 'a lock mid-creation is left alone');
  } finally { f.cleanup(); }
});

test('a lease released while the phone was being found exits 1 holding nothing', async () => {
  const f = fixture();
  try {
    const clock = { ms: 0 };
    const adbFactory = () => {
      releaseLease('adb', 'late-id', { env: f.env });   // the race: released mid-discovery
      return { startServer() {}, devices: () => [], prop: () => { throw new Error('never reached'); } };
    };
    const timing = { sleep: async ms => { clock.ms += ms; } };
    const err = [];
    const code = await main(['lease', 's26', '--for', '5m', '--why', 'raced', '--id', 'late-id', '--wait', '0'], {
      env: f.env, stdout: () => {}, stderr: line => err.push(line), sleep: timing.sleep, adbFactory,
    });
    assert.equal(code, 1, 'the tool exits 1, not AWAY or BUSY');
    assert.ok(err.some(line => /^HUB_DEVICE_CANCELLED s26 lease late-id was released while the phone was being found/.test(line)), err.join('\n'));
    assert.ok(!existsSync(f.lock), 'nothing is held');
    assert.deepEqual(readdirSync(join(f.root, 'locks/adb.queue')), [], 'no ticket left');
  } finally { f.cleanup(); }
});

test('--pid refuses anything but a positive integer', async () => {
  const f = fixture();
  try {
    for (const bad of ['0', '-1', 'two', '3.5']) {
      const result = await f.run(['lease', 's26', '--for', '1m', '--why', 'x', '--no-connect', '--pid', bad]);
      assert.equal(result.code, 2, `--pid ${bad} is usage`);
      assert.match(result.err.join(), /--pid takes a live process id/);
    }
    const good = await f.run(['lease', 's26', '--for', '1m', '--why', 'x', '--no-connect', '--pid', String(process.pid)]);
    assert.equal(good.code, 0);
    assert.equal(f.owner().holder_pid, process.pid);
  } finally { f.cleanup(); }
});

test('AWAY is the error code findPhone throws, not its wording', async () => {
  const f = fixture();
  try {
    const awayCoded = () => ({ startServer: async () => { throw Object.assign(new Error('gone fishing'), { code: 'HUB_PHONE_AWAY' }); } });
    const result = await f.run(['lease', 's26', '--for', '5m', '--why', 'x', '--wait', '0'], { adbFactory: awayCoded });
    assert.deepEqual([result.code, result.out], [75, ['HUB_DEVICE_AWAY s26']]);
    const worded = () => ({ startServer: async () => { throw new Error("the phone is not on this host's adb server"); } });
    const other = await f.run(['lease', 's26', '--for', '5m', '--why', 'x', '--wait', '0'], { adbFactory: worded });
    assert.equal(other.code, 1, 'an error that only reads like away is a failure, not AWAY');
    assert.ok(!existsSync(f.lock), 'both give the lease back');
    let clock = 0;
    const timing = { sleep: async ms => { clock += ms; }, now: () => clock, log: () => {} };
    const empty = { startServer() {}, devices: () => [] };
    await assert.rejects(findPhone(empty, { serial: 'R5GL43A7PCH', model: 'SM-S948U', waitMs: 3000, pollMs: 1000, ...timing }), error => error.code === 'HUB_PHONE_AWAY' && /is not on this host's adb server/.test(error.message));
  } finally { f.cleanup(); }
});

test('lease and run warn once when the installed hub predates leases', async () => {
  const f = fixture();
  try {
    const current = join(f.root, '.local/share/mobile-deploy-hub/current/tools/ci/lib');
    assert.equal(leaseSupport({ env: f.env }).supported, null, 'no installed hub: nothing to warn about');
    assert.deepEqual((await f.run(['lease', 's26', '--for', '1m', '--why', 'x', '--no-connect', '--id', 'a'])).err.filter(line => /warning/.test(line)), []);
    await f.run(['release', 'a']);
    mkdirSync(current, { recursive: true });
    writeFileSync(join(current, 'lock.mjs'), 'export async function withLock() {}\n');
    const old = await f.run(['lease', 's26', '--for', '1m', '--why', 'x', '--no-connect', '--id', 'b']);
    assert.equal(old.code, 0, 'the lease is still taken');
    assert.equal(old.err.filter(line => /^hub-device: warning: the installed catch-up hub .* predates leases and would reclaim this lease/.test(line)).length, 1);
    await f.run(['release', 'b']);
    const ran = await f.run(['run', 's26', '--', process.execPath, '-e', '']);
    assert.equal(ran.err.filter(line => /predates leases/.test(line)).length, 1, 'run warns too');
    writeFileSync(join(current, 'lock.mjs'), 'export async function acquireLease() {}\n');
    assert.deepEqual((await f.run(['lease', 's26', '--for', '1m', '--why', 'x', '--no-connect', '--id', 'c'])).err.filter(line => /warning/.test(line)), []);
  } finally { f.cleanup(); }
});

test('a reader that goes away (EPIPE) ends hub-device quietly', async () => {
  const f = fixture();
  try {
    const child = spawn(process.execPath, [tool, 'status'], { env: f.env, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.destroy();
    let err = '';
    child.stderr.on('data', chunk => { err += chunk; });
    const code = await new Promise(done => child.on('close', status => done(status)));
    assert.equal(code, 0, err);
    assert.doesNotMatch(err, /EPIPE|Error/);
  } finally { f.cleanup(); }
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
    assert.deepEqual(doc.phones.map(phone => [phone.device, phone.held, phone.lease_id, phone.presence, phone.deploy]), [['s24', 'free', null, 'reachable', false], ['s26', 'lease', 'held', 'reachable', true]]);
    const text = (await f.run(['status'], { inventory: real })).out.join('\n');
    assert.match(text, /s24  free  reachable  SM-S928U  serial R5CX31AEJDA  lock s24/);
    assert.match(text, /s26  LEASE held  holder=agent-a.*reachable  SM-S948U  serial R5GL43A7PCH  lock adb  \(the deploy phone\)/);
    assert.match(text, /s26 \(adb\)  LEASE held  holder=agent-a  why="device proof"  expires in 60m/);
    assert.match(text, /s26 #1  next  holder=agent-b/);
    assert.match(text, /adb server  port 5037  pid 100  managed/);
    assert.match(text, /emulator  avd tower-pixel  console port 5730  adb server 15170  pid 200  foreign/);
    assert.match(text, /Xvfb  display :100  pid 300  foreign/);
    assert.doesNotMatch(f.calls(), /connect|start-server/, 'status queries adb; it never connects or starts anything');
    assert.match(f.calls(), /^devices$/m, 'the phones were looked up in adb devices');
    assert.deepEqual(readdirSync(join(f.root, 'locks')).sort(), before, 'status changed nothing');
    assert.equal(f.owner().lease_id, 'held');
    releaseLease('adb', 'next', { env: f.env });
    await assert.rejects(waiting, error => error.code === 'HUB_LEASE_CANCELLED');
  } finally { f.cleanup(); }
});

test('status with nothing held says so (and, with no adb server running, does not ask adb at all)', async () => {
  const f = fixture();
  try {
    const result = await f.run(['status']);
    assert.deepEqual(result.out, [
      'PHONES (read only; adb is queried, never connected)',
      `  s24  free  no adb server  SM-S928U  serial R5CX31AEJDA  lock s24`,
      `  s26  free  no adb server  SM-S948U  serial R5GL43A7PCH  lock adb  (the deploy phone)`,
      'LOCKS',
      '  none held',
      'WAITERS',
      '  none',
      'INVENTORY (read only)',
      '  nothing running',
    ]);
    assert.equal(f.calls(), '', 'no adb server in the inventory means no adb call');
  } finally { f.cleanup(); }
});

test('hub-device never kills, starts or reconnects: its source has no kill of a foreign process, no emulator or Xvfb launch, no adb kill-server/disconnect', () => {
  const source = readFileSync(tool, 'utf8') + readFileSync(join(hubRoot, 'tools/device/inventory.mjs'), 'utf8');
  assert.doesNotMatch(source, /kill-server|disconnect|\bpkill\b|\bkillall\b|emulator -avd|spawn\(\s*['"](?:Xvfb|emulator|adb)/);
  assert.doesNotMatch(readFileSync(join(hubRoot, 'tools/device/inventory.mjs'), 'utf8'), /process\.kill|child_process|writeFile|rmSync|unlink/, 'the inventory only reads');
});

test('install.sh installs a hub-device wrapper into ~/.local/bin without touching systemd, launchd or a live host', { skip: process.platform !== 'linux' }, () => {
  const home = mkdtempSync(join(tmpdir(), 'hub-install-'));
  try {
    const node = join(home, '.local/share/mise/installs/node/24/bin');
    mkdirSync(node, { recursive: true });
    symlinkSync(process.execPath, join(node, 'node'));
    // Every host-control command install.sh knows is shimmed, and uname says Linux, so the test drives only
    // the Linux branch and can never reach a real systemd or launchd on any host it runs on.
    const shims = join(home, 'shims');
    mkdirSync(shims);
    const shim = (name, body) => { writeFileSync(join(shims, name), `#!/bin/sh\n${body}\n`); chmodSync(join(shims, name), 0o755); };
    shim('systemctl', `echo "$*" >> "${home}/systemctl.log"`);
    shim('launchctl', `echo "$*" >> "${home}/launchctl.log"; exit 0`);
    shim('plutil', 'exit 0');
    shim('uname', 'echo Linux');
    const env = { PATH: `${shims}:${process.env.PATH}`, HOME: home, HUB_LOCK_DIR: join(home, 'locks') };
    const install = spawnSync('bash', [join(hubRoot, 'tools/catchup/units/install.sh'), 'mobi2-test'], { env, encoding: 'utf8' });
    assert.equal(install.status, 0, install.stdout + install.stderr);
    const link = join(home, '.local/bin/hub-device');
    const release = join(home, '.local/share/mobile-deploy-hub/releases/mobi2-test');
    assert.equal(readFileSync(join(home, 'systemctl.log'), 'utf8'), '--user daemon-reload\n', 'systemd was only told to re-read units: no enable, no start');
    assert.ok(!existsSync(join(home, 'launchctl.log')), 'launchd was never touched');
    assert.ok(statSync(link).mode & 0o111, 'executable');
    assert.ok(!lstatSync(link).isSymbolicLink(), 'a wrapper, not a symlink to the .mjs');
    assert.equal(readFileSync(link, 'utf8'), `#!/bin/sh\nexec "${join(node, 'node')}" "${join(release, 'tools/device/hub-device.mjs')}" "$@"\n`);
    // through the wrapper, the copy in the release answers, and a lease-aware `current` draws no warning
    const status = spawnSync(link, ['status', '--json'], { env, encoding: 'utf8' });
    assert.equal(status.status, 0, status.stderr);
    assert.deepEqual(JSON.parse(status.stdout).locks, []);
    const leased = spawnSync(link, ['lease', 's26', '--for', '1m', '--why', 'install check', '--no-connect'], { env, encoding: 'utf8' });
    assert.equal(leased.status, 0, leased.stderr);
    assert.doesNotMatch(leased.stderr, /warning/);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
