// Story 6.11 (FR-23, AD-45, AD-23): the service runs from a release, and a stop never kills an emulator. Hermetic: a fake `run`
// (systemctl, bash, ssh, git), a fake fetchImpl, a fake clock, a fake `heavy`, and for the units installer real bash over shims (the
// Linux branch only, `uname` shimmed), so no real unit, port, systemd scope or 1Password read is touched.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hermetic, heavyShim } from '../ci/test-fixtures.mjs';
import { inHeavy, onPath, which } from '../ci/lib/heavy.mjs';
import { bootCommand } from '../device/emulator.mjs';
import { onPath as serverOnPath } from '../hub-api/server.mjs';
import { HUB_API_UNIT, hostsInstall, installHubApi } from '../hosts.mjs';
import { HUB_API_SERVICE } from '../hub-client.mjs';

hermetic();

const hubRoot = fileURLToPath(new URL('../..', import.meta.url));
const unitsDir = join(hubRoot, 'tools/hosts/units');
const scratch = prefix => mkdtempSync(join(tmpdir(), prefix));
const executable = (path, body) => { writeFileSync(path, body); chmodSync(path, 0o755); };

// ---- the spawn seam ----

test('seam, Linux with heavy: spawn heavy with [command, ...args]', () => {
  const root = scratch('hub-hosts-seam-');
  try {
    const env = { PATH: `${heavyShim(join(root, 'bin'))}:/nonexistent` };
    const heavy = join(root, 'bin/heavy');
    assert.deepEqual(bootCommand('/sdk/emulator', ['-avd', 'x'], { env, platform: 'linux' }), { command: heavy, args: ['/sdk/emulator', '-avd', 'x'], env });
    assert.deepEqual(inHeavy('adb', ['-L', 'tcp:localhost:15000'], { env, platform: 'linux' }), { command: heavy, args: ['adb', '-L', 'tcp:localhost:15000'], env, heavy: true });
    assert.equal(which('heavy', env), heavy);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('seam, no heavy or darwin: the command is spawned unchanged', () => {
  const root = scratch('hub-hosts-seam-');
  try {
    const withHeavy = { PATH: heavyShim(join(root, 'bin')) };
    const without = { PATH: join(root, 'empty') };
    assert.deepEqual(bootCommand('/sdk/emulator', ['-avd', 'x'], { env: withHeavy, platform: 'darwin' }), { command: '/sdk/emulator', args: ['-avd', 'x'], env: withHeavy });
    assert.deepEqual(bootCommand('/sdk/emulator', ['-avd', 'x'], { env: without, platform: 'linux' }), { command: '/sdk/emulator', args: ['-avd', 'x'], env: without });
    assert.equal(inHeavy('adb', undefined, { env: without, platform: 'linux' }).heavy, false);
    assert.equal(which('heavy', without), null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('seam, private XDG_RUNTIME_DIR: heavy is spawned with the manager\'s XDG and bus, and an env prefix puts the process\'s own back', () => {
  const root = scratch('hub-hosts-seam-');
  try {
    const PATH = heavyShim(join(root, 'bin'));
    const manager = { PATH, XDG_RUNTIME_DIR: '/run/user/1000', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus', HOME: '/h' };
    const env = { ...manager, XDG_RUNTIME_DIR: '/tmp/lease/run', TMPDIR: '/tmp/lease' };
    const boot = inHeavy('/sdk/emulator', ['-avd', 'x'], { env, platform: 'linux', manager });
    assert.equal(boot.command, join(root, 'bin/heavy'));
    assert.deepEqual(boot.args, ['env', 'XDG_RUNTIME_DIR=/tmp/lease/run', '/sdk/emulator', '-avd', 'x']);
    assert.equal(boot.env.XDG_RUNTIME_DIR, '/run/user/1000');
    assert.equal(boot.env.DBUS_SESSION_BUS_ADDRESS, 'unix:path=/run/user/1000/bus');
    assert.equal(boot.env.TMPDIR, '/tmp/lease', 'the rest of the process env is kept');
    // A variable the process does not have is unset again after heavy.
    const bare = { PATH, HOME: '/h' };
    assert.deepEqual(inHeavy('adb', [], { env: bare, platform: 'linux', manager }).args, ['env', '-u', 'XDG_RUNTIME_DIR', '-u', 'DBUS_SESSION_BUS_ADDRESS', 'adb']);
    // The same env on both sides needs no prefix.
    assert.deepEqual(inHeavy('adb', ['x'], { env: manager, platform: 'linux', manager }).args, ['adb', 'x']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('the seam reads the launch env\'s PATH, and the service\'s start check is the same resolver', () => {
  assert.equal(serverOnPath, onPath, 'server.mjs re-exports the one resolver');
  const root = scratch('hub-hosts-seam-');
  try {
    const env = { PATH: heavyShim(join(root, 'bin')) };
    assert.equal(onPath('heavy', env), inHeavy('x', [], { env, platform: 'linux' }).heavy);
    assert.equal(onPath('heavy', { PATH: '' }), inHeavy('x', [], { env: { PATH: '' }, platform: 'linux' }).heavy);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ---- the unit and its installer ----

test('the unit is a simple service that restarts on failure, KillMode=mixed, from a named release, with ~/.local/bin first on PATH', () => {
  const unit = readFileSync(join(unitsDir, 'mobile-deploy-hub-api.service'), 'utf8');
  const directives = unit.split('\n').filter(line => /^[A-Za-z]+=/.test(line));
  for (const line of ['Type=simple', 'Restart=on-failure', 'KillMode=mixed', 'WantedBy=default.target']) assert.ok(directives.includes(line), line);
  assert.ok(directives.includes('ExecStart=@NODE@/bin/node %h/.local/share/mobile-deploy-hub/releases/@REF@/tools/hub-api/server.mjs'));
  assert.ok(directives.some(line => line.startsWith('Environment=PATH=%h/.local/bin:')), 'heavy is found first');
  assert.ok(!directives.some(line => /HUB_LOCK_DIR/.test(line)), 'the default lock dir, shared with deploys and hub-device');
  assert.doesNotMatch(unit, /\/current\//, 'never `current`');
});

// A home with the release copy of the units, a fake mise node 24 -> 24.x, and shimmed systemctl and uname.
function unitsHome({ node = '24.15.0', uname = 'Linux', ref = 't1' } = {}) {
  const home = scratch('hub-hosts-install-');
  const installs = join(home, '.local/share/mise/installs/node');
  mkdirSync(join(installs, node, 'bin'), { recursive: true });
  executable(join(installs, node, 'bin/node'), `#!/bin/sh\necho v${node}\n`);
  symlinkSync(node, join(installs, '24'));
  const shims = join(home, 'shims');
  mkdirSync(shims);
  executable(join(shims, 'systemctl'), `#!/bin/sh\necho "$*" >> "${home}/systemctl.log"\n`);
  executable(join(shims, 'uname'), `#!/bin/sh\necho ${uname}\n`);
  const release = join(home, '.local/share/mobile-deploy-hub/releases', ref, 'tools/hosts/units');
  mkdirSync(release, { recursive: true });
  cpSync(unitsDir, release, { recursive: true });
  const env = { PATH: `${shims}:${process.env.PATH}`, HOME: home };
  return {
    home, release, installs, env, unit: join(home, '.config/systemd/user/mobile-deploy-hub-api.service'),
    install: (args, script = join(release, 'install.sh')) => spawnSync('bash', [script, ...args], { env, encoding: 'utf8' }),
    systemctl: () => (existsSync(join(home, 'systemctl.log')) ? readFileSync(join(home, 'systemctl.log'), 'utf8') : ''),
    cleanup: () => rmSync(home, { recursive: true, force: true }),
  };
}
const linux = { skip: process.platform !== 'linux' };

test('units install: renders the unit for the release with the real node/24.x path, no token left, and only daemon-reload', linux, () => {
  const h = unitsHome();
  try {
    const done = h.install(['t1']);
    assert.equal(done.status, 0, done.stdout + done.stderr);
    const unit = readFileSync(h.unit, 'utf8');
    assert.doesNotMatch(unit, /@/, 'no @ token left');
    assert.match(unit, new RegExp(`^ExecStart=${join(h.installs, '24.15.0')}/bin/node %h/\\.local/share/mobile-deploy-hub/releases/t1/tools/hub-api/server\\.mjs$`, 'm'));
    assert.match(unit, new RegExp(`^Environment=PATH=%h/\\.local/bin:${join(h.installs, '24.15.0')}/bin:`, 'm'));
    assert.equal(h.systemctl(), '--user daemon-reload\n', 'no enable, no start');
    assert.deepEqual(readdirSync(join(h.home, '.config/systemd/user')), ['mobile-deploy-hub-api.service'], 'no .part left, nothing else written');
    assert.ok(existsSync(join(h.release, 'install.sh')), 'it copied and deleted nothing');
  } finally { h.cleanup(); }
});

test('units install: from a checkout it refuses (exit 2), names the release path and writes nothing', linux, () => {
  const h = unitsHome();
  try {
    const done = h.install(['t1'], join(unitsDir, 'install.sh'));
    assert.equal(done.status, 2, done.stdout + done.stderr);
    assert.match(done.stderr, new RegExp(`${join(h.home, '.local/share/mobile-deploy-hub/releases/t1/tools/hosts/units').replaceAll('.', '\\.')}`));
    assert.ok(!existsSync(join(h.home, '.config')), 'nothing written');
    assert.equal(h.systemctl(), '');
  } finally { h.cleanup(); }
});

test('units install: a node older than 24.15 refuses (exit 2), says >= 24.15 and writes nothing', linux, () => {
  const h = unitsHome({ node: '24.6.0' });
  try {
    const done = h.install(['t1']);
    assert.equal(done.status, 2, done.stdout + done.stderr);
    assert.match(done.stderr, />= 24\.15/);
    assert.ok(!existsSync(join(h.home, '.config')));
    assert.equal(h.systemctl(), '');
  } finally { h.cleanup(); }
});

test('units install: a bad ref refuses (exit 2) and writes nothing', linux, () => {
  const h = unitsHome();
  try {
    for (const ref of ['../x', 'a/b', '..', 'x y']) {
      const done = h.install([ref]);
      assert.equal(done.status, 2, `${JSON.stringify(ref)}: ${done.stdout}${done.stderr}`);
    }
    assert.ok(!existsSync(join(h.home, '.config')));
    assert.equal(h.systemctl(), '');
  } finally { h.cleanup(); }
});

test('units install: on the Mac it prints one line and exits 0, touching nothing', () => {
  const h = unitsHome({ uname: 'Darwin' });
  try {
    const done = h.install(['t1']);
    assert.equal(done.status, 0, done.stdout + done.stderr);
    assert.equal(done.stdout.trim().split('\n').length, 1);
    assert.ok(!existsSync(join(h.home, '.config')));
    assert.equal(h.systemctl(), '');
  } finally { h.cleanup(); }
});

test('units install renders every *.service in its directory (the Host Agent\'s unit drops in beside the Hub API\'s)', linux, () => {
  const h = unitsHome();
  try {
    writeFileSync(join(h.release, 'mobile-deploy-hub-host-agent.service'), '[Service]\nExecStart=@NODE@/bin/node %h/.local/share/mobile-deploy-hub/releases/@REF@/tools/host-agent/server.mjs\n');
    const done = h.install(['t1']);
    assert.equal(done.status, 0, done.stdout + done.stderr);
    assert.deepEqual(readdirSync(join(h.home, '.config/systemd/user')).sort(), ['mobile-deploy-hub-api.service', 'mobile-deploy-hub-host-agent.service']);
    assert.doesNotMatch(readFileSync(join(h.home, '.config/systemd/user/mobile-deploy-hub-host-agent.service'), 'utf8'), /@/);
  } finally { h.cleanup(); }
});

// ---- hosts:install ----

const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const health = (ref, extra = {}) => ({ ok: true, service: HUB_API_SERVICE, contract: '1', hub_version: ref, ...extra });

function clock() {
  const c = { t: 1_000_000, sleeps: [] };
  c.now = () => c.t;
  c.sleep = async ms => { c.sleeps.push(ms); c.t += ms; };
  return c;
}

// A temp home with (or without) the release copy of the units installer that the catch-up step puts in place.
function releaseHome(ref = 't1', { present = true } = {}) {
  const home = scratch('hub-hosts-home-');
  if (present) {
    const dir = join(home, '.local/share/mobile-deploy-hub/releases', ref, 'tools/hosts/units');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'install.sh'), '#!/bin/sh\n');
  }
  return home;
}

const HOME = releaseHome('t1');
process.on('exit', () => { try { rmSync(HOME, { recursive: true, force: true }); } catch { /* temp */ } });

test('installHubApi: a missing release copy fails with its path before anything runs', async () => {
  const home = releaseHome('t1', { present: false });
  try {
    const run = () => assert.fail('nothing runs without a release copy');
    await assert.rejects(installHubApi({ ref: 't1', run, fetchImpl: run, home, port: 1 }), error => error.message === `release copy missing: ${join(home, '.local/share/mobile-deploy-hub/releases/t1/tools/hosts/units/install.sh')} (the catch-up step puts releases/t1 there)`);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('installHubApi: units installer from the release copy, then enable, then restart, then /health until it answers as this release', async () => {
  const calls = [];
  const run = (command, args) => { calls.push([command, ...args]); return { ok: true, out: 'hosts units installed' }; };
  const c = clock();
  const answers = [() => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }); }, () => jsonResponse(health('v1.0.0')), () => jsonResponse(health('t1'))];
  const urls = [];
  const fetchImpl = async url => { urls.push(url); return answers.shift()(); };
  const summary = await installHubApi({ ref: 't1', run, fetchImpl, sleep: c.sleep, now: c.now, home: HOME, port: 8794 });
  assert.deepEqual(calls, [
    ['bash', join(HOME, '.local/share/mobile-deploy-hub/releases/t1/tools/hosts/units/install.sh'), 't1'],
    ['systemctl', '--user', 'enable', HUB_API_UNIT],
    ['systemctl', '--user', 'restart', HUB_API_UNIT],
  ]);
  assert.deepEqual(urls, Array(3).fill('http://127.0.0.1:8794/health'));
  assert.equal(c.sleeps.length, 2);
  assert.match(summary, /^t1 serves 127\.0\.0\.1:8794/);
});

test('installHubApi: a /health that is ok but another service, or not ok, is not an answer', async () => {
  const c = clock();
  const bodies = [jsonResponse(health('t1', { service: 'host-agent' })), jsonResponse(health('t1', { ok: false })), jsonResponse({}, 500), jsonResponse(health('t1'))];
  await installHubApi({ ref: 't1', run: () => ({ ok: true, out: '' }), fetchImpl: async () => bodies.shift(), sleep: c.sleep, now: c.now, home: HOME, port: 1 });
  assert.equal(bodies.length, 0);
});

test('installHubApi: no answer for 10 s fails, and no attempt starts after the deadline', async () => {
  const c = clock();
  const start = c.t;
  const attempts = [];
  const fetchImpl = async () => { attempts.push(c.t - start); throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }); };
  await assert.rejects(installHubApi({ ref: 't1', run: () => ({ ok: true, out: '' }), fetchImpl, sleep: c.sleep, now: c.now, home: HOME, port: 8794 }), /did not report mobile-deploy-hub-api t1 within 10s.*ECONNREFUSED/);
  assert.ok(attempts.length > 1 && attempts.every(at => at <= 10_000), `attempts at ${attempts.join(',')}`);
  assert.ok(c.t - start <= 10_000 + 500, 'the loop stops at the deadline');
});

test('installHubApi: an installer or systemctl failure stops before anything else runs', async () => {
  const calls = [];
  const fail = at => (command, args) => { calls.push([command, ...args].join(' ')); return { ok: !calls.at(-1).includes(at), out: `${at} broke` }; };
  const fetchImpl = async () => assert.fail('no readback after a failed step');
  await assert.rejects(installHubApi({ ref: 't1', run: fail('install.sh'), fetchImpl, home: HOME, port: 1 }), /install\.sh broke/);
  assert.equal(calls.length, 1);
  calls.length = 0;
  await assert.rejects(installHubApi({ ref: 't1', run: fail('enable'), fetchImpl, home: HOME, port: 1 }), /systemctl --user enable/);
  assert.equal(calls.length, 2);
});

// A host where every step but the ones under test succeeds: fake run, fake fetch, injected credentials, a temp home.
function hostsRun({ release = false, healthRef = 'v1.2.3' } = {}) {
  const home = scratch('hub-hosts-run-');
  if (release) {
    const dir = join(home, '.local/share/mobile-deploy-hub/releases/v1.2.3/tools/catchup/units');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'install.sh'), '#!/bin/sh\n');
  }
  const calls = [];
  const log = [];
  const run = (command, args, options = {}) => {
    calls.push([command, ...args]);
    if (command === 'git' && args[0] === 'describe') return { ok: true, out: 'v1.2.3' };
    if (command === 'ssh' && args.at(-1) === 'echo ok') return { ok: true, out: 'ok' };
    if (options.input?.includes('HOST_KEY=')) return { ok: true, out: `HOST_KEY=${/printf '%s\\n' '(\w+)'/.exec(options.input)[1]}` };
    if (command === 'bash' && /catchup\/units\/install\.sh$/.test(args[0])) {
      const dir = join(home, '.local/share/mobile-deploy-hub/releases/v1.2.3/tools/hosts/units');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'install.sh'), '#!/bin/sh\n');
    }
    if (command === 'rsync') return { ok: true, out: 'Total bytes sent: 10' };
    return { ok: true, out: 'ok' };
  };
  const c = clock();
  const fetchImpl = async url => {
    if (String(url).endsWith('/health')) return jsonResponse(health(healthRef));
    if (String(url).endsWith('/minio/health/live')) return new Response('', { status: 200 });
    return new Response('<html></html>', { status: 200 });
  };
  const opts = { log: line => log.push(line), run, fetchImpl, sleep: c.sleep, now: c.now, home, credentials: async () => ({ access: 'AKIAEXAMPLE', secret: 'example-secret-value' }) };
  return { home, calls, log, opts, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}
const only = (calls, ...commands) => calls.filter(call => commands.includes(call[0]) && !(call[0] === 'bash' && call[1] === '-s'));

test('hostsInstall: the catch-up installer, then the units installer, then enable, then restart, then the readback', async () => {
  const h = hostsRun();
  try {
    await hostsInstall(h.opts);
    const release = join(h.home, '.local/share/mobile-deploy-hub/releases/v1.2.3');
    assert.deepEqual(only(h.calls, 'bash', 'systemctl'), [
      ['bash', join(hubRoot, 'tools/catchup/units/install.sh'), 'v1.2.3'],
      ['bash', join(release, 'tools/hosts/units/install.sh'), 'v1.2.3'],
      ['systemctl', '--user', 'enable', HUB_API_UNIT],
      ['systemctl', '--user', 'restart', HUB_API_UNIT],
    ]);
    assert.ok(h.log.some(line => /^HOSTS hub api on big-chungus: v1\.2\.3 serves 127\.0\.0\.1:8794/.test(line)), h.log.join('\n'));
    assert.equal(h.log.at(-1), 'HOSTS_OK v1.2.3');
    const catchUpAt = h.log.findIndex(line => line.startsWith('HOSTS catch-up on big-chungus'));
    assert.ok(catchUpAt >= 0 && h.log.findIndex(line => line.startsWith('HOSTS hub api on big-chungus')) > catchUpAt, 'the Hub API step comes after the catch-up step');
    assert.equal(h.calls.filter(call => call.join(' ').includes('hosts/units')).filter(call => call[0] === 'ssh' || call[0] === 'rsync').length, 0, 'nothing of the Hub API goes to the Mac');
    assert.equal(h.calls.some(call => call.some(part => /host-agent|mobile-deploy-hub-api/.test(part)) && (call[0] === 'ssh')), false);
  } finally { h.cleanup(); }
});

test('hostsInstall, same-ref reinstall: the catch-up installer runs from the release copy, never replacing the directory a service reads', async () => {
  const h = hostsRun({ release: true });
  try {
    await hostsInstall(h.opts);
    const release = join(h.home, '.local/share/mobile-deploy-hub/releases/v1.2.3');
    assert.deepEqual(only(h.calls, 'bash')[0], ['bash', join(release, 'tools/catchup/units/install.sh'), 'v1.2.3']);
  } finally { h.cleanup(); }
});

test('hostsInstall: a Hub API that never answers fails the step and the run, and still ran the rest', async () => {
  const h = hostsRun({ healthRef: 'v0.0.1' });
  try {
    await assert.rejects(hostsInstall(h.opts), /hosts:install: hub api on big-chungus failed/);
    assert.ok(h.log.some(line => line.startsWith('HOSTS_FAILED hub api on big-chungus: ')), h.log.join('\n'));
    assert.ok(h.log.some(line => line.startsWith('HOSTS catch-up on the Mac')), 'the other steps still ran');
    assert.ok(!h.log.some(line => line.startsWith('HOSTS_OK')));
  } finally { h.cleanup(); }
});

test('hostsInstall: a release copy that is missing fails the Hub API step loudly, without running the units installer', async () => {
  const h = hostsRun();
  try {
    const run = (command, args, options) => (command === 'bash' ? { ok: true, out: 'ok' } : h.opts.run(command, args, options));
    await assert.rejects(hostsInstall({ ...h.opts, run }), /hosts:install: hub api on big-chungus failed/);
    assert.ok(h.log.some(line => line.startsWith('HOSTS_FAILED hub api on big-chungus: release copy missing: ')), h.log.join('\n'));
  } finally { h.cleanup(); }
});

// ---- nothing removes a release, nothing is a timer ----

test('hosts.mjs and the units installer never remove a release directory, and tools/hosts/units holds no .timer', () => {
  const code = name => readFileSync(join(hubRoot, name), 'utf8').split('\n').filter(line => !/^\s*(#|\/\/)/.test(line)).join('\n');
  for (const name of ['tools/hosts.mjs', 'tools/hosts/units/install.sh']) assert.doesNotMatch(code(name), /\brm\b|rmSync|rmdir|unlink/, `${name} removes nothing`);
  assert.deepEqual(readdirSync(unitsDir).filter(name => name.endsWith('.timer')), []);
  const installer = code('tools/hosts/units/install.sh');
  assert.deepEqual(installer.split('\n').filter(line => /systemctl/.test(line)), ['systemctl --user daemon-reload'], 'its only systemctl call');
  assert.doesNotMatch(installer, /\bcp\b|\bln\b/, 'it copies no code and links nothing');
});
