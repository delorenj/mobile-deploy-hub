// MOBI-48: a dedicated QA phone's lease runs the hub's own adb server for that phone. `hub-device lease|run` starts it under the lease (the
// port goes into the client's environment and into the exports), stops it when the lease ends, and an away phone says which other adb
// server holds its USB interface. Every other phone keeps the deploys' server. Hermetic: temp lock, event and home dirs, a fake adb binary,
// the adb client injected; nothing reaches a real server or the real QA file.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { awayHint, foreignHolders } from '../ci/lib/qa-phones.mjs';
import { hermetic } from '../ci/test-fixtures.mjs';
import { main } from './hub-device.mjs';
import { fakeWire } from './wire-fixtures.mjs';

hermetic();

const S24 = { serial: 'R5CX31AEJDA', model: 'SM-S928U' };
const S26 = { serial: 'R5GL43A7PCH', model: 'SM-S948U' };
const idOf = ({ serial }) => `adb-${serial}-zz._adb-tls-connect._tcp`;
const serverUp = () => ({ adb_servers: [{ port: 5037, pid: 4242, cwd: null }], emulators: [], xvfb: [] });

function side({ qaUsers = [0] } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'dedicated-qa-'));
  mkdirSync(join(root, '.config/mobile-deploy-hub'), { recursive: true });
  writeFileSync(join(root, '.config/mobile-deploy-hub/qa-devices.json'), JSON.stringify({ schema: 1, devices: [{ name: 'S24', model: S24.model, serial: S24.serial, dedicated: true, allowed_users: qaUsers }] }));
  const calls = join(root, 'adb-calls.log');
  writeFileSync(join(root, 'adb'), `#!/bin/sh\necho "[$ANDROID_ADB_SERVER_PORT] $*" >> "${calls}"\nexit 0\n`);
  chmodSync(join(root, 'adb'), 0o755);
  const env = { PATH: process.env.PATH, HOME: root, USER: 'tester', HUB_ADB: join(root, 'adb'), HUB_LOCK_DIR: join(root, 'locks'), HUB_EVENT_DIR: join(root, 'events'), HUB_DEVICE_POLL_MS: '5', HUB_ADB_SERVER_PORT: '5037' };
  const clients = [];
  const present = new Set([S24.serial, S26.serial]);
  const adbFactory = ({ env: clientEnv }) => {
    clients.push({ port: clientEnv.ANDROID_ADB_SERVER_PORT, autoConnect: clientEnv.ADB_MDNS_AUTO_CONNECT });
    const here = [S24, S26].filter(phone => present.has(phone.serial));
    return {
      startServer: async () => {},
      devices: async () => here.map(phone => ({ id: idOf(phone), state: 'device' })),
      prop: async (id, name) => { const phone = here.find(entry => idOf(entry) === id); return name === 'ro.serialno' ? phone.serial : phone.model; },
    };
  };
  return {
    root, env, clients, present,
    adbCalls: () => { try { return readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean); } catch { return []; } },
    cli: async argv => {
      const out = [];
      const err = [];
      const code = await main(argv, { env, stdout: line => out.push(line), stderr: line => err.push(line), inventory: serverUp, adbWire: fakeWire({ listed: () => [] }), adbFactory, hostKey: () => 'linux' });
      return { code, out: out.join('\n'), err: err.join('\n') };
    },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

test('lease s24 runs the hub\'s own adb server for it: its port is the client\'s and the export, no mDNS auto-connect; release stops it', async () => {
  const f = side();
  try {
    const lease = await f.cli(['lease', 's24', '--for', '5m', '--why', 'qa run', '--id', 'qa-1']);
    assert.equal(lease.code, 0, lease.err);
    assert.match(lease.out, /export ANDROID_ADB_SERVER_PORT='5060'/);
    assert.match(lease.out, /export ANDROID_SERIAL='adb-R5CX31AEJDA-zz/);
    assert.deepEqual(f.clients, [{ port: '5060', autoConnect: '0' }], 'the take looks for the phone on the QA port only');
    assert.deepEqual(f.adbCalls(), ['[5060] kill-server'], 'a leftover server on the QA port is stopped before the lease starts its own');
    const released = await f.cli(['release', 'qa-1']);
    assert.equal(released.code, 0, released.err);
    assert.match(released.out, /HUB_DEVICE_RELEASED/);
    assert.deepEqual(f.adbCalls(), ['[5060] kill-server', '[5060] kill-server'], 'the lease\'s end stops the hub\'s QA server, and only that port\'s');
  } finally { f.cleanup(); }
});

test('lease s26 keeps the deploys\' server and never stops anything', async () => {
  const f = side();
  try {
    const lease = await f.cli(['lease', 's26', '--for', '5m', '--why', 'deploy phone proof', '--id', 's26-1']);
    assert.equal(lease.code, 0, lease.err);
    assert.match(lease.out, /export ANDROID_ADB_SERVER_PORT='5037'/);
    assert.deepEqual(f.clients, [{ port: '5037', autoConnect: undefined }]);
    await f.cli(['release', 's26-1']);
    assert.deepEqual(f.adbCalls(), []);
  } finally { f.cleanup(); }
});

test('an away dedicated phone is HUB_DEVICE_AWAY (75), holds nothing and its server is stopped', async () => {
  const f = side();
  try {
    f.present.delete(S24.serial);
    const lease = await f.cli(['lease', 's24', '--for', '5m', '--why', 'qa run', '--id', 'qa-2', '--wait', '0']);
    assert.equal(lease.code, 75, lease.err);
    assert.deepEqual(f.adbCalls(), ['[5060] kill-server', '[] -L tcp:127.0.0.1:5037 devices', '[5060] kill-server'], 'stopped before the look and after the failed one; the other server is only read');
    f.present.add(S24.serial);
    const again = await f.cli(['lease', 's24', '--for', '5m', '--why', 'qa run', '--id', 'qa-3']);
    assert.equal(again.code, 0, again.err);
    await f.cli(['release', 'qa-3']);
  } finally { f.cleanup(); }
});

test('run s24 -- cmd hands the command the hub\'s server port and stops that server on exit', async () => {
  const f = side();
  try {
    const seen = join(f.root, 'seen-port');
    const run = await f.cli(['run', 's24', '--for', '5m', '--why', 'qa run', '--', 'sh', '-c', `echo $ANDROID_ADB_SERVER_PORT > ${seen}`]);
    assert.equal(run.code, 0, run.err);
    assert.equal(readFileSync(seen, 'utf8').trim(), '5060');
    assert.equal(f.adbCalls().at(-1), '[5060] kill-server');
  } finally { f.cleanup(); }
});

test('without a QA file nothing is dedicated: the s24 keeps the deploys\' server like any phone', async () => {
  const f = side();
  try {
    rmSync(join(f.root, '.config/mobile-deploy-hub/qa-devices.json'));
    const lease = await f.cli(['lease', 's24', '--for', '5m', '--why', 'qa run', '--id', 'qa-4']);
    assert.equal(lease.code, 0, lease.err);
    assert.match(lease.out, /export ANDROID_ADB_SERVER_PORT='5037'/);
    assert.deepEqual(f.adbCalls(), []);
    await f.cli(['release', 'qa-4']);
  } finally { f.cleanup(); }
});

test('another adb server that lists the phone is named, read only, and never stopped', () => {
  const root = mkdtempSync(join(tmpdir(), 'dedicated-qa-proc-'));
  try {
    const proc = join(root, 'proc');
    mkdirSync(join(proc, '777'), { recursive: true });
    writeFileSync(join(proc, '777/cmdline'), 'adb\0-L\0tcp:5055\0fork-server\0server\0--reply-fd\x004\0');
    writeFileSync(join(proc, '777/environ'), '');
    mkdirSync(join(proc, '778'), { recursive: true });
    writeFileSync(join(proc, '778/cmdline'), 'adb\0-L\0tcp:5037\0fork-server\0server\0');
    writeFileSync(join(proc, '778/environ'), '');
    const asked = [];
    const runner = (program, args) => {
      asked.push(args.join(' '));
      assert.ok(args.includes('-L') && !args.includes('kill-server') && !args.includes('start-server'), 'read only, never launches or stops');
      return args.includes('tcp:127.0.0.1:5055') ? `List of devices attached\n${S24.serial}\tdevice\n` : 'List of devices attached\n';
    };
    const phone = { name: 'S24', lock: 's24', serial: S24.serial, model: S24.model, users: [0], port: 5060 };
    const holders = foreignHolders(phone, { env: { HUB_ADB: '/x/adb' }, runner, procRoot: proc });
    assert.deepEqual(holders.map(holder => [holder.port, holder.pid]), [[5055, 777]]);
    assert.equal(asked.length, 2);
    const hint = awayHint(phone, holders);
    assert.match(hint, /another adb server that holds its USB interface \(port 5055 pid 777/);
    assert.match(hint, /never stops a server it does not own/);
    assert.equal(awayHint(phone, []), '');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
