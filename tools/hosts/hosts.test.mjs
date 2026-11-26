// Story 6.11 (FR-23, AD-45, AD-23) and Story 9.7: the service runs from a release, and a stop never kills an emulator; the Host Agent runs on the Mac
// as its own LaunchAgent. Hermetic: a fake `run` (systemctl, bash, ssh, rsync, git), a fake fetchImpl, a fake `sshImpl` that runs the real relay, a fake
// clock, a fake `heavy`, and for the units installer real bash over shims (`uname`, `id`, `systemctl`, `launchctl`, `plutil`), so no real unit,
// LaunchAgent, port, ssh, systemd scope or 1Password read is touched.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hermetic, heavyShim, peerSsh, unreachable } from '../ci/test-fixtures.mjs';
import { loadPolicy } from '../ci/lib/policy.mjs';
import { main as hostAgentMain } from '../host-agent/server.mjs';
import { inHeavy, onPath, which } from '../ci/lib/heavy.mjs';
import { bootCommand } from '../device/emulator.mjs';
import { onPath as serverOnPath } from '../hub-api/server.mjs';
import { HOST_AGENT_LABEL, HUB_API_UNIT, hostsInstall, installHubApi, servicesAgree } from '../hosts.mjs';
import { HOST_AGENT_SERVICE, HUB_API_CONTRACT, HUB_API_SERVICE } from '../hub-client.mjs';

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
  executable(join(shims, 'id'), '#!/bin/sh\necho 501\n');
  // launchctl logs its arguments; `print` finds no label (so the installer's wait ends at once). plutil logs too, and fails while `plutil-fail` exists.
  executable(join(shims, 'launchctl'), `#!/bin/sh\necho "$*" >> "${home}/launchctl.log"\n[ "$1" = print ] && exit 1\nexit 0\n`);
  executable(join(shims, 'plutil'), `#!/bin/sh\necho "$*" >> "${home}/plutil.log"\n[ -e "${home}/plutil-fail" ] && { echo "bad plist" >&2; exit 1; }\nexit 0\n`);
  const release = join(home, '.local/share/mobile-deploy-hub/releases', ref, 'tools/hosts/units');
  mkdirSync(release, { recursive: true });
  cpSync(unitsDir, release, { recursive: true });
  const env = { PATH: `${shims}:${process.env.PATH}`, HOME: home };
  return {
    home, release, installs, env, unit: join(home, '.config/systemd/user/mobile-deploy-hub-api.service'),
    install: (args, script = join(release, 'install.sh')) => spawnSync('bash', [script, ...args], { env, encoding: 'utf8' }),
    systemctl: () => (existsSync(join(home, 'systemctl.log')) ? readFileSync(join(home, 'systemctl.log'), 'utf8') : ''),
    launchctl: () => (existsSync(join(home, 'launchctl.log')) ? readFileSync(join(home, 'launchctl.log'), 'utf8') : ''),
    agents: join(home, 'Library/LaunchAgents'),
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

const AGENT_PLIST = `${HOST_AGENT_LABEL}.plist`;

// The plist's XML as a value: dict -> object, array -> array, string -> string, true/false -> boolean (no comments, no entities).
function parsePlist(xml) {
  const tokens = [...xml.replace(/<!--[\s\S]*?-->/g, '').matchAll(/<(\/?)(dict|array|key|string|true|false)(\/?)>([^<]*)/g)];
  let at = 0;
  const value = () => {
    const [, , tag, , text] = tokens[at++];
    if (tag === 'true' || tag === 'false') return tag === 'true';
    if (tag === 'string') { at += 1; return text; }
    const closes = () => tokens[at][1] === '/' && tokens[at][2] === tag;
    if (tag === 'array') { const out = []; while (!closes()) out.push(value()); at += 1; return out; }
    const out = {};
    while (!closes()) { const key = tokens[at][4]; at += 2; out[key] = value(); }
    at += 1;
    return out;
  };
  const { length } = tokens;
  const parsed = value();
  assert.equal(at, length, 'the whole plist was read');
  return parsed;
}

test('the Host Agent plist: a RunAtLoad GUI service that restarts only after a failure, from a named release, with --launchd, both logs and no clock', () => {
  const text = readFileSync(join(unitsDir, AGENT_PLIST), 'utf8');
  const plist = parsePlist(text);
  assert.deepEqual(plist, {
    Label: 'sh.delo.mobile-deploy-hub.host-agent',
    ProgramArguments: ['@NODE@/bin/node', '@HOME@/.local/share/mobile-deploy-hub/releases/@REF@/tools/host-agent/server.mjs', '--launchd'],
    RunAtLoad: true,
    KeepAlive: { SuccessfulExit: false },
    LimitLoadToSessionType: 'Aqua',
    WorkingDirectory: '@HOME@',
    EnvironmentVariables: { HOME: '@HOME@', PATH: '@NODE@/bin:/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin' },
    StandardOutPath: '@HOME@/Library/Logs/mobile-deploy-hub/host-agent.out.log',
    StandardErrorPath: '@HOME@/Library/Logs/mobile-deploy-hub/host-agent.err.log',
  });
  assert.equal(AGENT_PLIST, 'sh.delo.mobile-deploy-hub.host-agent.plist');
  for (const key of ['StartInterval', 'StartCalendarInterval', 'WatchPaths', 'HUB_LOCK_DIR']) assert.ok(!text.includes(key), `no ${key}`);
  assert.doesNotMatch(text, /\/current\b/, 'never `current`');
  assert.deepEqual(readdirSync(unitsDir).filter(name => name.endsWith('.timer')), []);
});

test('units install, Mac: renders the Host Agent plist for the release with the real node path, lints it, then bootout, print, bootstrap into gui/<uid>', () => {
  const h = unitsHome({ uname: 'Darwin' });
  try {
    const done = h.install(['t1']);
    assert.equal(done.status, 0, done.stdout + done.stderr);
    const plistPath = join(h.agents, AGENT_PLIST);
    const text = readFileSync(plistPath, 'utf8');
    assert.doesNotMatch(text, /@/, 'no @ token left');
    const node = join(h.installs, '24.15.0');
    const plist = parsePlist(text);
    assert.deepEqual(plist.ProgramArguments, [`${node}/bin/node`, `${h.home}/.local/share/mobile-deploy-hub/releases/t1/tools/host-agent/server.mjs`, '--launchd']);
    assert.equal(plist.EnvironmentVariables.PATH.split(':')[0], `${node}/bin`);
    assert.equal(plist.EnvironmentVariables.HOME, h.home);
    assert.equal(plist.StandardErrorPath, `${h.home}/Library/Logs/mobile-deploy-hub/host-agent.err.log`);
    assert.equal(plist.WorkingDirectory, h.home);
    assert.deepEqual(readdirSync(h.agents), [AGENT_PLIST], 'no .part left');
    assert.ok(existsSync(join(h.home, 'Library/Logs/mobile-deploy-hub')), 'the log directory exists');
    assert.equal(h.launchctl(), `bootout gui/501/${HOST_AGENT_LABEL}\nprint gui/501/${HOST_AGENT_LABEL}\nbootstrap gui/501 ${plistPath}\n`);
    assert.equal(readFileSync(join(h.home, 'plutil.log'), 'utf8'), `-lint ${plistPath}.part\n`, 'linted before it was moved into place');
    assert.equal(done.stdout.trim().split('\n').length, 1, 'one line per agent');
    assert.match(done.stdout, /^hosts agent: sh\.delo\.mobile-deploy-hub\.host-agent bootstrapped/);
    assert.ok(!existsSync(join(h.home, '.config')), 'no systemd unit on the Mac');
    assert.equal(h.systemctl(), '');
    assert.ok(existsSync(join(h.release, 'install.sh')), 'it copied and deleted nothing');
  } finally { h.cleanup(); }
});

test('units install, Mac: the catch-up LaunchAgent, rendered first by its own installer, is byte-identical afterwards and never named', () => {
  const h = unitsHome({ uname: 'Darwin' });
  try {
    const tools = join(h.release, '../..');
    mkdirSync(join(tools, 'catchup'), { recursive: true });
    mkdirSync(join(tools, 'ci/lib'), { recursive: true });
    writeFileSync(join(tools, 'catchup/catchup.mjs'), '');
    writeFileSync(join(tools, 'ci/lib/adb.mjs'), '');
    cpSync(join(hubRoot, 'tools/catchup/units'), join(tools, 'catchup/units'), { recursive: true });
    const first = h.install(['t1'], join(tools, 'catchup/units/install.sh'));
    assert.equal(first.status, 0, first.stdout + first.stderr);
    const catchup = join(h.agents, 'sh.delo.mobile-deploy-hub.catchup.plist');
    const before = readFileSync(catchup);
    const logBefore = h.launchctl();
    assert.match(logBefore, /catchup/, 'its own installer bootstrapped it');
    const done = h.install(['t1']);
    assert.equal(done.status, 0, done.stdout + done.stderr);
    assert.deepEqual(readFileSync(catchup), before, 'the catch-up plist is untouched');
    assert.deepEqual(readdirSync(h.agents).sort(), ['sh.delo.mobile-deploy-hub.catchup.plist', AGENT_PLIST]);
    const added = h.launchctl().slice(logBefore.length);
    assert.doesNotMatch(added, /catchup/, 'the units installer never names the catch-up label');
    assert.equal(added.trim().split('\n').length, 3);
    assert.doesNotMatch(readFileSync(join(unitsDir, 'install.sh'), 'utf8').split('\n').filter(line => !/^\s*#/.test(line)).join('\n'), /catchup/, 'the installer\'s code never names the catch-up');
  } finally { h.cleanup(); }
});

test('units install, Mac: a node older than 24.15 refuses (exit 2), says >= 24.15, writes no plist and calls no launchctl', () => {
  const h = unitsHome({ uname: 'Darwin', node: '24.6.0' });
  try {
    const done = h.install(['t1']);
    assert.equal(done.status, 2, done.stdout + done.stderr);
    assert.match(done.stderr, />= 24\.15/);
    assert.ok(!existsSync(h.agents));
    assert.equal(h.launchctl(), '');
  } finally { h.cleanup(); }
});

test('units install, Mac: a plist that fails plutil -lint exits non-zero, leaves none in place and never bootstraps', () => {
  const h = unitsHome({ uname: 'Darwin' });
  try {
    writeFileSync(join(h.home, 'plutil-fail'), '');
    const done = h.install(['t1']);
    assert.notEqual(done.status, 0, done.stdout + done.stderr);
    assert.match(done.stderr, /does not lint/);
    assert.ok(!existsSync(join(h.agents, AGENT_PLIST)), 'no plist in place');
    assert.equal(h.launchctl(), '', 'no bootout, no bootstrap');
  } finally { h.cleanup(); }
});

test('units install, Mac: a placeholder it does not know refuses (exit 2) before anything is written or bootstrapped', () => {
  const h = unitsHome({ uname: 'Darwin' });
  try {
    writeFileSync(join(h.release, 'sh.delo.mobile-deploy-hub.other.plist'), '<plist><string>@UNKNOWN@</string></plist>\n');
    const done = h.install(['t1']);
    assert.equal(done.status, 2, done.stdout + done.stderr);
    assert.match(done.stderr, /placeholder/);
    assert.ok(!existsSync(join(h.agents, 'sh.delo.mobile-deploy-hub.other.plist')));
  } finally { h.cleanup(); }
});

test('units install, Mac: every *.plist in the directory is installed (the next Mac service needs no installer change)', () => {
  const h = unitsHome({ uname: 'Darwin' });
  try {
    writeFileSync(join(h.release, 'sh.delo.mobile-deploy-hub.next.plist'), readFileSync(join(unitsDir, AGENT_PLIST), 'utf8').replace(HOST_AGENT_LABEL, 'sh.delo.mobile-deploy-hub.next'));
    const done = h.install(['t1']);
    assert.equal(done.status, 0, done.stdout + done.stderr);
    assert.deepEqual(readdirSync(h.agents).sort(), ['sh.delo.mobile-deploy-hub.next.plist', AGENT_PLIST].sort());
    assert.match(h.launchctl(), /bootstrap gui\/501 .*next\.plist/);
  } finally { h.cleanup(); }
});

test('the Host Agent started with the plist\'s argv on a taken port exits 0, so KeepAlive SuccessfulExit false never respawns it', async () => {
  const argv = parsePlist(readFileSync(join(unitsDir, AGENT_PLIST), 'utf8')).ProgramArguments.slice(2);
  assert.deepEqual(argv, ['--launchd']);
  const root = scratch('hub-hosts-agent-');
  try {
    const err = [];
    const createServer = () => Object.assign(new EventEmitter(), {
      listen() { process.nextTick(() => this.emit('error', Object.assign(new Error('listen EADDRINUSE'), { code: 'EADDRINUSE' }))); return this; },
      close() {},
    });
    const env = { PATH: process.env.PATH, HOME: root, HUB_LOCK_DIR: join(root, 'locks'), HUB_EVENT_DIR: join(root, 'events') };
    const code = await hostAgentMain({ argv, log: { out: () => {}, err: line => err.push(line) }, env, hostKey: () => 'mac', versions: { node: '24.15.0' }, onPath: () => false, createServer, request: async () => new Response('{}', { status: 200 }) });
    assert.equal(code, 0);
    assert.match(err.at(-1), /^HUB_API_ALREADY_RUNNING /);
  } finally { rmSync(root, { recursive: true, force: true }); }
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
const health = (ref, extra = {}) => ({ ok: true, service: HUB_API_SERVICE, contract: 1, hub_version: ref, ...extra });

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

test('installHubApi: /health must report the contract too: another number, none or text is not an answer, and the line prints both', async () => {
  const c = clock();
  const bodies = [jsonResponse(health('t1', { contract: 2 })), jsonResponse(health('t1', { contract: undefined })), jsonResponse(health('t1', { contract: '1' })), jsonResponse(health('t1'))];
  const logs = [];
  const summary = await installHubApi({ ref: 't1', run: () => ({ ok: true, out: 'units ok' }), fetchImpl: async () => bodies.shift(), sleep: c.sleep, now: c.now, home: HOME, port: 8794, log: line => logs.push(line) });
  assert.equal(bodies.length, 0);
  assert.equal(summary, `t1 serves 127.0.0.1:8794, contract ${HUB_API_CONTRACT} (units ok)`);
  assert.match(logs[0], /contract 2/);
  assert.match(logs[1], /contract missing/);
  assert.match(logs[2], /contract 1/);
  const never = clock();
  await assert.rejects(installHubApi({ ref: 't1', run: () => ({ ok: true, out: '' }), fetchImpl: async () => jsonResponse(health('t1', { contract: 2 })), sleep: never.sleep, now: never.now, home: HOME, port: 8794 }), /did not report mobile-deploy-hub-api t1 within 10s \(last: hub_version t1, service mobile-deploy-hub-api, contract 2\)/);
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

// A host where every step but the ones under test succeeds: fake run, fake fetch, injected credentials, a temp home. The Mac's Host Agent answers
// `/health` through a fake sshImpl that runs the real relay against `macFetch` (the agent's own loopback); `macRelease` says whether the Mac already
// has releases/<ref>/tools; `agentRef` is the release the agent reports (a function of the call number when it must change).
const policy = loadPolicy().policy;
const agentHealth = (ref, extra = {}) => ({ ok: true, service: HOST_AGENT_SERVICE, contract: HUB_API_CONTRACT, hub_version: ref, ...extra });
function hostsRun({ release = false, healthRef = 'v1.2.3', macRelease = false, macFetch, sshImpl } = {}) {
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
    if (command === 'ssh' && /RELEASE_PRESENT/.test(args.at(-1))) return { ok: true, out: macRelease ? 'RELEASE_PRESENT' : 'RELEASE_MISSING' };
    if (options.input?.includes('HOST_KEY=')) return { ok: true, out: `HOST_KEY=${/printf '%s\\n' '(\w+)'/.exec(options.input)[1]}` };
    if (command === 'bash' && /catchup\/units\/install\.sh$/.test(args[0])) {
      const dir = join(home, '.local/share/mobile-deploy-hub/releases/v1.2.3/tools/hosts/units');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'install.sh'), '#!/bin/sh\n');
    }
    if (command === 'rsync') return { ok: true, out: 'Total bytes sent: 10' };
    if (command === 'ssh' && /hosts\/units\/install\.sh/.test(args.at(-1))) return { ok: true, out: 'hosts agent: sh.delo.mobile-deploy-hub.host-agent bootstrapped into gui/501' };
    return { ok: true, out: 'ok' };
  };
  const c = clock();
  const fetchImpl = async url => {
    if (String(url).endsWith('/health')) return jsonResponse(health(healthRef));
    if (String(url).endsWith('/minio/health/live')) return new Response('', { status: 200 });
    return new Response('<html></html>', { status: 200 });
  };
  const agentFetch = macFetch ?? (async url => (String(url) === `http://127.0.0.1:${policy.api.host_agent_port}/health` ? jsonResponse(agentHealth('v1.2.3')) : new Response('', { status: 404 })));
  const peer = sshImpl ?? peerSsh({ key: 'mac', fetchImpl: agentFetch, policy });
  const opts = { log: line => log.push(line), run, fetchImpl, sleep: c.sleep, now: c.now, home, credentials: async () => ({ access: 'AKIAEXAMPLE', secret: 'example-secret-value' }), sshImpl: peer, hostKey: () => 'linux' };
  return { home, calls, log, opts, clock: c, peer, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}
const only = (calls, ...commands) => calls.filter(call => commands.includes(call[0]) && !(call[0] === 'bash' && call[1] === '-s'));
const macCommands = calls => calls.filter(call => call[0] === 'ssh' || call[0] === 'rsync').map(call => call.at(-1));

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
    assert.equal(h.calls.some(call => call.some(part => /mobile-deploy-hub-api|systemctl/.test(part)) && (call[0] === 'ssh' || call[0] === 'rsync')), false, 'nothing of the systemd unit goes to the Mac');
    assert.equal(h.calls.filter(call => call[0] === 'systemctl').length, 2, 'systemctl runs only here');
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
    await assert.rejects(hostsInstall(h.opts), /hosts:install: hub api on big-chungus, services agree failed/);
    assert.ok(h.log.some(line => line.startsWith('HOSTS_FAILED hub api on big-chungus: ')), h.log.join('\n'));
    assert.ok(h.log.some(line => /^HOSTS_FAILED services agree: .*hub_version v0\.0\.1 on linux but v1\.2\.3 on mac/.test(line)), h.log.join('\n'));
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

// ---- the Host Agent on the Mac, and the two services agreeing (Story 9.7) ----

test('hostsInstall, fresh Mac: the release is copied into <ref>.part and moved, the catch-up installer runs, then the units installer, then /health is read through the relay', async () => {
  const h = hostsRun();
  try {
    await hostsInstall(h.opts);
    const release = '.local/share/mobile-deploy-hub/releases/v1.2.3';
    const mac = macCommands(h.calls).filter(command => /releases/.test(command));
    assert.deepEqual(mac, [
      `if [ -e '${release}/tools' ]; then echo RELEASE_PRESENT; else echo RELEASE_MISSING; fi`,
      `mkdir -p '${release}.part/tools'`,
      `hub-mac:${release}.part/tools/`,
      `[ -e '${release}' ] || mv '${release}.part' '${release}'`,
      `bash '${release}/tools/catchup/units/install.sh' 'v1.2.3'`,
      `bash '${release}/tools/hosts/units/install.sh' 'v1.2.3'`,
    ]);
    assert.ok(h.calls.find(call => call[0] === 'rsync').includes('--delete'));
    const names = h.log.map(line => line.split(':')[0]);
    const order = ['HOSTS catch-up on big-chungus', 'HOSTS hub api on big-chungus', 'HOSTS catch-up on the Mac', 'HOSTS host agent on the Mac', 'HOSTS services agree'].map(name => names.indexOf(name));
    assert.ok(order.every((at, index) => at >= 0 && (index === 0 || at > order[index - 1])), `${order} in ${h.log.join('\n')}`);
    assert.ok(h.log.includes('HOSTS host agent on the Mac: v1.2.3 serves 127.0.0.1:8795 on mac, contract 1 (hosts agent: sh.delo.mobile-deploy-hub.host-agent bootstrapped into gui/501)'), h.log.join('\n'));
    assert.ok(h.log.includes('HOSTS services agree: contract 1, hub_version v1.2.3 on linux and mac'), h.log.join('\n'));
    assert.equal(h.log.at(-1), 'HOSTS_OK v1.2.3');
    // The Mac's agent is read through the relay: `hub-client.mjs relay GET /health` over the one ssh option set (readback, then the agreement).
    assert.equal(h.peer.spawned.length, 2);
    for (const argv of h.peer.spawned) assert.match(argv.at(-1), /hub-client\.mjs' 'relay' 'GET' '\/health'$/);
  } finally { h.cleanup(); }
});

test('hostsInstall, same-ref reinstall on the Mac: nothing is copied or moved, and the catch-up and units installers still run from the existing release', async () => {
  const h = hostsRun({ release: true, macRelease: true });
  try {
    await hostsInstall(h.opts);
    assert.equal(h.calls.filter(call => call[0] === 'rsync').length, 0, 'no rsync into a tree a running agent reads');
    assert.equal(macCommands(h.calls).filter(command => /\bmv\b|mkdir -p '\.local/.test(command)).length, 0, 'no mv, no mkdir of the release');
    const release = '.local/share/mobile-deploy-hub/releases/v1.2.3';
    const mac = macCommands(h.calls).filter(command => /^bash '/.test(command));
    assert.deepEqual(mac, [`bash '${release}/tools/catchup/units/install.sh' 'v1.2.3'`, `bash '${release}/tools/hosts/units/install.sh' 'v1.2.3'`]);
    assert.ok(h.log.some(line => /^HOSTS catch-up on the Mac: v1\.2\.3 \(release copy already on the Mac, not copied\)/.test(line)), h.log.join('\n'));
    assert.equal(h.log.at(-1), 'HOSTS_OK v1.2.3');
  } finally { h.cleanup(); }
});

test('hostsInstall: an agent that never answers fails its step after 20 s with the last reason and its log path, and the later steps still run', async () => {
  const refused = async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }); };
  const h = hostsRun({ macFetch: refused });
  try {
    const start = h.clock.t;
    await assert.rejects(hostsInstall(h.opts), /hosts:install: host agent on the Mac, services agree failed/);
    const line = h.log.find(entry => entry.startsWith('HOSTS_FAILED host agent on the Mac: '));
    assert.ok(line, h.log.join('\n'));
    assert.match(line, /did not report mobile-deploy-hub-host-agent v1\.2\.3 within 20s \(last: ECONNREFUSED\)/);
    assert.match(line, /Library\/Logs\/mobile-deploy-hub\/host-agent\.err\.log/);
    assert.ok(h.clock.t - start <= 20_000 + 500, 'no attempt starts after the deadline');
    assert.ok(h.log.some(entry => entry.startsWith('HOSTS_FAILED services agree: mac did not give a mobile-deploy-hub-host-agent /health (ECONNREFUSED)')), h.log.join('\n'));
    assert.ok(!h.log.some(entry => entry.startsWith('HOSTS_OK')));
    assert.ok(h.log.some(entry => entry.startsWith('HOSTS hub api on big-chungus: ')), 'the earlier steps ran');
  } finally { h.cleanup(); }
});

test('hostsInstall: services that run different releases fail the agreement step, naming both versions, and only that step', async () => {
  let reads = 0;
  const macFetch = async () => jsonResponse(agentHealth(reads++ === 0 ? 'v1.2.3' : 'v1.2.2'));
  const h = hostsRun({ macFetch });
  try {
    await assert.rejects(hostsInstall(h.opts), /hosts:install: services agree failed/);
    const line = h.log.find(entry => entry.startsWith('HOSTS_FAILED services agree: '));
    assert.equal(line, 'HOSTS_FAILED services agree: hub_version v1.2.3 on linux but v1.2.2 on mac; the two services must run one release');
    assert.ok(h.log.some(entry => entry.startsWith('HOSTS host agent on the Mac: ')), 'the agent step passed');
  } finally { h.cleanup(); }
});

test('hostsInstall: a Mac that is asleep fails the agent step and the agreement step with host-unreachable, and the Mac-only steps are all that fail', async () => {
  const h = hostsRun({ sshImpl: unreachable() });
  try {
    await assert.rejects(hostsInstall(h.opts), /hosts:install: host agent on the Mac, services agree failed/);
    for (const name of ['host agent on the Mac', 'services agree']) {
      assert.ok(h.log.some(entry => entry.startsWith(`HOSTS_FAILED ${name}: `) && /host-unreachable/.test(entry) && /Operation timed out/.test(entry)), `${name}: ${h.log.join('\n')}`);
    }
    assert.ok(h.log.some(entry => /^HOSTS_FAILED services agree: mac did not give/.test(entry)));
    assert.ok(!h.log.some(entry => /^HOSTS_FAILED services agree: linux/.test(entry)), 'the Hub API is read from this host');
  } finally { h.cleanup(); }
});

test('hostsInstall: a units installer that fails on the Mac fails the agent step with its output, and /health is not read for that step', async () => {
  const h = hostsRun();
  const run = (command, args, options) => (command === 'ssh' && /hosts\/units\/install\.sh/.test(args.at(-1)) ? { ok: false, out: 'install.sh: plutil: bad plist' } : h.opts.run(command, args, options));
  try {
    await assert.rejects(hostsInstall({ ...h.opts, run }), /hosts:install: host agent on the Mac failed/);
    assert.ok(h.log.includes('HOSTS_FAILED host agent on the Mac: install.sh: plutil: bad plist'), h.log.join('\n'));
    assert.equal(h.peer.spawned.length, 1, 'only the agreement step read the Mac');
    assert.ok(h.log.some(line => line.startsWith('HOSTS services agree: ')));
  } finally { h.cleanup(); }
});

test('hostsInstall reads this host\'s key through claims.hostKey({home}) when no hostKey seam is given', linux, async () => {
  const h = hostsRun();
  try {
    mkdirSync(join(h.home, '.config/mobile-deploy-hub'), { recursive: true });
    writeFileSync(join(h.home, '.config/mobile-deploy-hub/host-key'), 'linux\n');
    const { hostKey, ...rest } = h.opts;
    await hostsInstall(rest);
    assert.equal(h.log.at(-1), 'HOSTS_OK v1.2.3');
    const again = hostsRun();
    try {
      mkdirSync(join(again.home, '.config/mobile-deploy-hub'), { recursive: true });
      writeFileSync(join(again.home, '.config/mobile-deploy-hub/host-key'), 'mac\n');
      const { hostKey: ignored, ...bare } = again.opts;
      await assert.rejects(hostsInstall(bare), /hosts:install: host agent on the Mac, services agree failed/);
      assert.ok(again.log.some(entry => /^HOSTS_FAILED services agree: .*HUB_HOST_UNKNOWN|^HOSTS_FAILED services agree: .*does not know which host/.test(entry)), again.log.join('\n'));
    } finally { again.cleanup(); }
  } finally { h.cleanup(); }
});

test('servicesAgree: each service must name itself, answer ok, and report one contract and one hub_version', async () => {
  const answer = (linux, mac) => ({ policy, devices: { mac: { host: 'hub-mac' } }, hostKey: () => 'linux', fetchImpl: async () => linux, sshImpl: peerSsh({ key: 'mac', fetchImpl: async () => mac, policy }) });
  assert.equal(await servicesAgree({ seams: answer(jsonResponse(health('v2')), jsonResponse(agentHealth('v2'))) }), 'contract 1, hub_version v2 on linux and mac');
  await assert.rejects(servicesAgree({ seams: answer(jsonResponse(health('v2')), jsonResponse(agentHealth('v2', { contract: 2 }))) }), /^Error: contract 1 on linux but 2 on mac; the two/);
  await assert.rejects(servicesAgree({ seams: answer(jsonResponse(health('v2')), jsonResponse(health('v2'))) }), /mac did not give a mobile-deploy-hub-host-agent \/health \(answered ok true, service mobile-deploy-hub-api/);
  await assert.rejects(servicesAgree({ seams: answer(jsonResponse({}, 503), jsonResponse(agentHealth('v2'))) }), /linux did not give a mobile-deploy-hub-api \/health \(HTTP 503\)/);
  await assert.rejects(servicesAgree({ seams: answer(jsonResponse(health('v2')), jsonResponse(agentHealth('v2', { ok: false }))) }), /mac did not give/);
  await assert.rejects(servicesAgree({ seams: answer(jsonResponse(health('v1')), jsonResponse(agentHealth('v2'))) }), /hub_version v1 on linux but v2 on mac/);
});

// ---- nothing removes a release, nothing is a timer ----

test('hosts.mjs and the units installer never remove a release directory, and tools/hosts/units holds no .timer', () => {
  const code = name => readFileSync(join(hubRoot, name), 'utf8').split('\n').filter(line => !/^\s*(#|\/\/)/.test(line)).join('\n');
  for (const name of ['tools/hosts.mjs', 'tools/hosts/units/install.sh']) assert.doesNotMatch(code(name), /\brm\b|rmSync|rmdir|unlink/, `${name} removes nothing`);
  assert.deepEqual(readdirSync(unitsDir).filter(name => name.endsWith('.timer')), []);
  const installer = code('tools/hosts/units/install.sh');
  assert.deepEqual(installer.split('\n').filter(line => /systemctl/.test(line)).map(line => line.trim()), ['systemctl --user daemon-reload'], 'its only systemctl call');
  assert.doesNotMatch(installer, /\bcp\b|\bln\b/, 'it copies no code and links nothing');
});
