// AD-47: a host knows its own key. hostKey()/isLocal() in claims.mjs and the hosts:install writer, driven hermetically:
// temp homes, injected readFile/platform/run/fetchImpl seams, a uname shim, no real ssh, fetch, git or service.
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as claims from './device/claims.mjs';
import { hostKeyScript, hostsInstall } from './hosts.mjs';
import { HUB_API_SERVICE } from './hub-client.mjs';
import { hermetic } from './ci/test-fixtures.mjs';

hermetic();

const hubRoot = fileURLToPath(new URL('..', import.meta.url));
const tmp = () => mkdtempSync(join(tmpdir(), 'hub-hostkey-'));
const homeWith = text => {
  const home = tmp();
  if (text !== undefined) {
    mkdirSync(join(home, '.config/mobile-deploy-hub'), { recursive: true });
    writeFileSync(claims.hostKeyPath(home), text);
  }
  return home;
};
const keyIn = (text, platform) => { const home = homeWith(text); try { return claims.hostKey({ env: {}, home, platform }); } finally { rmSync(home, { recursive: true, force: true }); } };
const codeOf = fn => { try { fn(); } catch (error) { return error; } assert.fail('expected a throw'); };

// ---- the vocabulary ----

test('HOST_PLATFORMS is frozen, and every key is a host block of the committed devices.json', () => {
  assert.ok(Object.isFrozen(claims.HOST_PLATFORMS));
  assert.deepEqual({ ...claims.HOST_PLATFORMS }, { linux: 'linux', mac: 'darwin' });
  const devices = JSON.parse(readFileSync(join(hubRoot, 'tools/ci/devices.json'), 'utf8'));
  for (const key of Object.keys(claims.HOST_PLATFORMS)) assert.equal(typeof devices[key]?.host, 'string', `devices.json has a "${key}" host block`);
  assert.equal(claims.HOST_KEY_FILE, '.config/mobile-deploy-hub/host-key');
  assert.equal(claims.EXIT_CODES.HUB_HOST_UNKNOWN, 1);
});

// ---- hostKey ----

test('hostKey returns the key for the current platform, trimmed', () => {
  assert.equal(keyIn('linux\n', 'linux'), 'linux');
  assert.equal(keyIn('mac\n', 'darwin'), 'mac');
  assert.equal(keyIn('  mac  \n\n', 'darwin'), 'mac');
});

test('hostKey reads HOME from env, and honours the home and readFile seams', () => {
  const home = homeWith('linux\n');
  try {
    assert.equal(claims.hostKey({ env: { HOME: home }, platform: 'linux' }), 'linux');
    const seen = [];
    assert.equal(claims.hostKey({ env: {}, home: '/h', platform: 'linux', readFile: path => { seen.push(path); return 'linux\n'; } }), 'linux');
    assert.deepEqual(seen, ['/h/.config/mobile-deploy-hub/host-key']);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('a missing file throws HUB_HOST_UNKNOWN naming the file and hosts:install, exit 1', () => {
  const home = homeWith();
  try {
    const error = codeOf(() => claims.hostKey({ env: {}, home, platform: 'linux' }));
    assert.equal(error.code, 'HUB_HOST_UNKNOWN');
    assert.ok(error.message.includes(claims.hostKeyPath(home)), error.message);
    assert.match(error.message, /mise run hosts:install/);
    assert.equal(claims.exitCodeOf(error), 1);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('a key for another platform throws, naming file, key and platform', () => {
  const home = homeWith('mac\n');
  try {
    const error = codeOf(() => claims.hostKey({ env: {}, home, platform: 'linux' }));
    assert.equal(error.code, 'HUB_HOST_UNKNOWN');
    assert.ok(error.message.includes(claims.hostKeyPath(home)));
    assert.match(error.message, /"mac"/);
    assert.match(error.message, /linux/);
    assert.equal(claims.exitCodeOf(error), 1);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('an unknown, wrongly cased, empty or unreadable key throws HUB_HOST_UNKNOWN', () => {
  for (const text of ['windows\n', 'Linux\n', 'LINUX', '', '\n', 'linux mac']) {
    assert.equal(codeOf(() => keyIn(text, 'linux')).code, 'HUB_HOST_UNKNOWN', JSON.stringify(text));
  }
  const home = tmp();
  try {
    mkdirSync(claims.hostKeyPath(home), { recursive: true }); // a directory where the file should be
    assert.equal(codeOf(() => claims.hostKey({ env: {}, home, platform: 'linux' })).code, 'HUB_HOST_UNKNOWN');
  } finally { rmSync(home, { recursive: true, force: true }); }
  assert.equal(codeOf(() => claims.hostKey({ env: {}, home: '/h', platform: 'linux', readFile: () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); } })).code, 'HUB_HOST_UNKNOWN');
});

// ---- isLocal ----

test('isLocal is record.host === hostKey() and nothing else', () => {
  const as = key => ({ hostKey: () => key });
  assert.equal(claims.isLocal({ host: 'linux' }, as('linux')), true);
  assert.equal(claims.isLocal({ host: 'mac' }, as('linux')), false);
  assert.equal(claims.isLocal({ host: 'mac' }, as('mac')), true);
  assert.equal(claims.isLocal({}, as('linux')), false);
  assert.equal(claims.isLocal(null, as('linux')), false);
  assert.equal(claims.isLocal(undefined, as('linux')), false);
});

test('an unknown host never decides it is local: isLocal rethrows HUB_HOST_UNKNOWN', () => {
  const unknown = { hostKey: () => { throw Object.assign(new Error('unknown'), { code: 'HUB_HOST_UNKNOWN' }); } };
  assert.equal(codeOf(() => claims.isLocal({ host: 'linux' }, unknown)).code, 'HUB_HOST_UNKNOWN');
  assert.equal(codeOf(() => claims.isLocal({}, unknown)).code, 'HUB_HOST_UNKNOWN');
});

test('claims.mjs decides locality in exactly one place', () => {
  const source = readFileSync(join(hubRoot, 'tools/device/claims.mjs'), 'utf8');
  assert.equal((source.match(/\.host\s*[!=]==?/g) ?? []).length, 1, 'one comparison of a record host');
  assert.match(source, /export const isLocal = \(record, \{ hostKey: keyOf = hostKey \} = \{\}\) => record\?\.host === keyOf\(\);/);
  assert.doesNotMatch(source, /process\.platform\s*===|hostname\(|\bplatform\(\)/, 'the key is never derived from the platform or a hostname');
});

test('isLocal defaults to the real hostKey(): HOME decides, and no key file is HUB_HOST_UNKNOWN', { skip: process.platform !== 'linux' }, () => {
  const saved = process.env.HOME;
  const keyed = homeWith('linux\n');
  const bare = homeWith();
  try {
    process.env.HOME = keyed;
    assert.equal(claims.isLocal({ host: 'linux' }), true);
    assert.equal(claims.isLocal({ host: 'mac' }), false);
    process.env.HOME = bare;
    assert.equal(codeOf(() => claims.isLocal({ host: 'linux' })).code, 'HUB_HOST_UNKNOWN');
  } finally {
    if (saved === undefined) delete process.env.HOME; else process.env.HOME = saved;
    rmSync(keyed, { recursive: true, force: true });
    rmSync(bare, { recursive: true, force: true });
  }
});

// ---- the writer ----

// A uname that answers `os`, so the script runs the same on any machine the suite runs on.
function shimmed(os) {
  const home = tmp();
  const shims = join(home, 'shims');
  mkdirSync(shims);
  writeFileSync(join(shims, 'uname'), `#!/bin/sh\necho ${os}\n`);
  chmodSync(join(shims, 'uname'), 0o755);
  const exec = script => spawnSync('sh', ['-s'], { input: script, encoding: 'utf8', env: { PATH: `${shims}:${process.env.PATH}`, HOME: home } });
  return { home, exec };
}
const keyFileDir = home => join(home, '.config/mobile-deploy-hub');

test('hostKeyScript writes <key>\\n atomically, prints it back and leaves no .part, for each host block', () => {
  for (const [key, os] of [['linux', 'Linux'], ['mac', 'Darwin']]) {
    const { home, exec } = shimmed(os);
    try {
      const result = exec(hostKeyScript(key));
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, `HOST_KEY=${key}\n`);
      assert.equal(readFileSync(claims.hostKeyPath(home), 'utf8'), `${key}\n`);
      assert.deepEqual(readdirSync(keyFileDir(home)), ['host-key']);
      assert.equal(exec(hostKeyScript(key)).status, 0, 'idempotent');
      assert.equal(claims.hostKey({ env: {}, home, platform: claims.HOST_PLATFORMS[key] }), key, 'what the writer wrote, the reader accepts');
    } finally { rmSync(home, { recursive: true, force: true }); }
  }
});

test('hostKeyScript refuses a key for the wrong platform, writing nothing, and an unknown key', () => {
  const { home, exec } = shimmed('Linux');
  try {
    const result = exec(hostKeyScript('mac'));
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /mac/);
    assert.ok(!existsSync(keyFileDir(home)), 'nothing written');
  } finally { rmSync(home, { recursive: true, force: true }); }
  assert.throws(() => hostKeyScript('windows'), /unknown host key/);
  assert.throws(() => hostKeyScript('Linux'), /unknown host key/);
  assert.throws(() => hostKeyScript('__proto__'), /unknown host key/);
});

// ---- hosts:install ----

// No network, except the Hub API's own /health (Story 6.11): the fake run answers every other step `ok`, so that step needs an answer
// for the ref the fake git gives (`main-ok`) to pass, and these tests are about the build directory and the host keys.
const offline = async url => {
  if (String(url).endsWith('/health')) return new Response(JSON.stringify({ ok: true, service: HUB_API_SERVICE, hub_version: 'main-ok' }), { status: 200 });
  throw new Error('offline');
};

function fakeHosts({ macOs = 'Darwin' } = {}) {
  const linux = shimmed('Linux');
  const mac = shimmed(macOs);
  const calls = [];
  const run = (command, args, { input } = {}) => {
    calls.push([command, ...args]);
    if (command === 'sh' && args.join(' ') === '-s') { const r = linux.exec(input); return { ok: r.status === 0, out: `${r.stdout}${r.stderr}`.trim() }; }
    if (command === 'ssh' && args.at(-1) === 'sh -s') { const r = mac.exec(input); return { ok: r.status === 0, out: `${r.stdout}${r.stderr}`.trim() }; }
    // The catch-up installer puts the release copy in place (the Hub API step reads its units installer from there).
    if (command === 'bash' && /catchup\/units\/install\.sh$/.test(args[0])) {
      const dir = join(linux.home, '.local/share/mobile-deploy-hub/releases', args[1], 'tools/hosts/units');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'install.sh'), '');
    }
    return { ok: true, out: 'ok' };
  };
  const cleanup = () => { rmSync(linux.home, { recursive: true, force: true }); rmSync(mac.home, { recursive: true, force: true }); };
  return { linux, mac, run, calls, cleanup };
}

test('hostsInstall writes and reads back each host key, and other steps fail on their own', async () => {
  const fake = fakeHosts();
  const lines = [];
  try {
    await assert.rejects(
      hostsInstall({ home: fake.linux.home, log: line => lines.push(line), run: fake.run, fetchImpl: offline }),
      error => { assert.equal(error.message, 'hosts:install: build directory failed'); return true; },
    );
    assert.equal(readFileSync(claims.hostKeyPath(fake.linux.home), 'utf8'), 'linux\n');
    assert.equal(readFileSync(claims.hostKeyPath(fake.mac.home), 'utf8'), 'mac\n');
    assert.ok(lines.some(line => /^HOSTS host key on big-chungus: .*"linux"/.test(line)), lines.join('\n'));
    assert.ok(lines.some(line => /^HOSTS host key on the Mac: .*"mac"/.test(line)), lines.join('\n'));
    assert.deepEqual(lines.filter(line => line.startsWith('HOSTS_FAILED')).map(line => line.split(':')[0]), ['HOSTS_FAILED build directory']);
    const order = lines.map(line => line.split(':')[0]);
    assert.ok(order.indexOf('HOSTS hub-mac') < order.indexOf('HOSTS host key on big-chungus'), 'after hub-mac');
  } finally { fake.cleanup(); }
});

test('hostsInstall fails a host key step whose readback disagrees, and only that step', async () => {
  const fake = fakeHosts();
  const lines = [];
  const run = (command, args, options) => (command === 'ssh' && args.at(-1) === 'sh -s' ? { ok: true, out: 'HOST_KEY=linux' } : fake.run(command, args, options));
  try {
    await assert.rejects(
      hostsInstall({ home: fake.linux.home, log: line => lines.push(line), run, fetchImpl: offline }),
      /hosts:install: build directory, host key on the Mac failed/,
    );
    assert.ok(lines.some(line => line.startsWith('HOSTS_FAILED host key on the Mac: read back')), lines.join('\n'));
  } finally { fake.cleanup(); }
});

test('hostsInstall fails the Mac key step when the alias reaches a Linux box, writing nothing there', async () => {
  const fake = fakeHosts({ macOs: 'Linux' });
  const lines = [];
  try {
    await assert.rejects(
      hostsInstall({ home: fake.linux.home, log: line => lines.push(line), run: fake.run, fetchImpl: offline }),
      /hosts:install: build directory, host key on the Mac failed/,
    );
    assert.ok(lines.some(line => /^HOSTS_FAILED host key on the Mac: .*darwin host but this is linux/.test(line)), lines.join('\n'));
    assert.ok(!existsSync(claims.hostKeyPath(fake.mac.home)), 'no key written on the wrong platform');
    assert.equal(readFileSync(claims.hostKeyPath(fake.linux.home), 'utf8'), 'linux\n', 'big-chungus still gets its key');
  } finally { fake.cleanup(); }
});

test('hostsInstall accepts a correct Mac write when ssh adds notices around the sentinel line', async () => {
  const fake = fakeHosts();
  const lines = [];
  const run = (command, args, options) => {
    const result = fake.run(command, args, options);
    return command === 'ssh' && args.at(-1) === 'sh -s' ? { ok: result.ok, out: `Warning: Permanently added 'hub-mac' to the list of known hosts.\n${result.out}\n** post-quantum KEX warning` } : result;
  };
  try {
    await assert.rejects(
      hostsInstall({ home: fake.linux.home, log: line => lines.push(line), run, fetchImpl: offline }),
      error => { assert.equal(error.message, 'hosts:install: build directory failed'); return true; },
    );
    assert.ok(lines.some(line => /^HOSTS host key on the Mac: .*"mac"/.test(line)), lines.join('\n'));
  } finally { fake.cleanup(); }
});
