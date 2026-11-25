// Story 6.12: `mise run hosts:smoke` (tools/hosts/smoke.mjs), hermetic: a fake hub-device (`cli`), a fake fetchImpl, a fake clock whose
// sleep advances it. No port, lock dir, 1Password or real hub-device is touched.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hermetic } from '../ci/test-fixtures.mjs';
import { LEASABLE_WITHIN_MS, TRY_EVERY_MS, hubDeviceCli, hubSmoke } from './smoke.mjs';
import { phoneWordMembers } from '../device/claims.mjs';
import { loadDevices } from '../ci/lib/devices.mjs';
import { planRegister } from '../registry/changes.mjs';
import { seed } from '../registry/seed.mjs';
import { writeRegistry } from '../registry/store.mjs';

hermetic();

const policy = { api: { hub_api_port: 8794 } };
const NAME = 'smoke-x';
const ID = 'res-smoke-x';

const health = (overrides = {}) => async () => ({ status: 200, text: async () => JSON.stringify({ ok: true, service: 'mobile-deploy-hub-api', contract: '1.0', hub_version: 'v1.2.53', registry: 'ok', ...overrides }) });
const out = (code, stdout = '', stderr = '') => ({ code, stdout, stderr });

// A fake hub-device: `lease` answers from `leaseAnswers` (a function of the try number), and the Registry state follows add and retire.
function world({ leaseAnswers = () => out(0, JSON.stringify({ lease_id: 'l-1', device: NAME })), add, retire, release, list, status } = {}) {
  const w = { log: [], lines: [], clock: 1_000_000, registered: false, retired: false, leases: 0, tries: [] };
  w.now = () => w.clock;
  w.sleep = async ms => { w.clock += ms; };
  w.members = () => (w.registered && !w.retired ? ['s24', 's26', NAME] : ['s24', 's26']);
  w.cli = async args => {
    w.log.push(args);
    const [verb, sub] = args;
    if (verb === 'registry' && sub === 'list') return list?.() ?? out(0, JSON.stringify({ rev: 4, source: 'file', resources: [], pools: [] }));
    if (verb === 'registry' && sub === 'add') { if (add) return add(); w.registered = true; return out(0, `HUB_DEVICE_REGISTERED ${ID} ${NAME}\nHUB_DEVICE_REV 5\n`); }
    if (verb === 'registry' && sub === 'retire') { if (retire) return retire(); w.retired = true; return out(0, `HUB_DEVICE_RETIRED ${ID} hidden\nHUB_DEVICE_REV 6\n`); }
    if (verb === 'lease') {
      if (w.retired) return out(2, '', `HUB_RESOURCE_RETIRED ${NAME} is retired`);
      w.tries.push(w.clock);
      w.leases += 1;
      return leaseAnswers(w.leases);
    }
    if (verb === 'release') return release?.() ?? out(0, `HUB_DEVICE_RELEASED ${args[1]}\n`);
    if (verb === 'status') return status?.(w) ?? out(0, JSON.stringify({ phones: [{ device: 's24' }, ...(w.registered && !w.retired ? [{ device: NAME }] : [])] }));
    throw new Error(`unexpected hub-device call ${args.join(' ')}`);
  };
  w.run = (extra = {}) => hubSmoke({ ref: 'v1.2.53', cli: w.cli, fetchImpl: health(), now: w.now, sleep: w.sleep, log: line => w.lines.push(line), policy, members: w.members, name: NAME, ...extra });
  return w;
}

const verbs = w => w.log.map(args => args.slice(0, args[0] === 'registry' ? 2 : 1).join(' '));

test('smoke, happy path: health, list, register, lease, release, retire, gone; OK line; one of each call', async () => {
  const w = world();
  const line = await w.run();
  assert.equal(line, 'HUB_SMOKE_OK v1.2.53 res-smoke-x leasable after 0 ms');
  assert.equal(w.lines.at(-1), line);
  assert.deepEqual(verbs(w), ['registry list', 'registry add', 'lease', 'status', 'release', 'registry retire', 'lease', 'status']);
  const add = w.log.find(args => args[1] === 'add');
  assert.deepEqual(add, ['registry', 'add', '--kind', 'phone', '--name', NAME, '--model', 'hub smoke', '--holder', 'hosts:smoke', '--why', 'hosts:smoke v1.2.53']);
  assert.ok(!add.includes('--serial'), 'no serial');
  assert.deepEqual(w.log.find(args => args[0] === 'lease'), ['lease', NAME, '--no-connect', '--wait', '0', '--for', '1m', '--why', 'hosts:smoke v1.2.53', '--holder', 'hosts:smoke', '--json']);
  assert.deepEqual(w.log.find(args => args[0] === 'release'), ['release', 'l-1']);
  assert.ok(w.lines.some(line => line.startsWith('HUB_SMOKE health:')) && w.lines.some(line => line.startsWith('HUB_SMOKE gone:')));
  assert.ok(w.retired && !w.members().includes(NAME));
});

test('smoke, the name is smoke-<base36 of now> and at most 28 characters', async () => {
  const w = world();
  const named = [];
  w.cli = (inner => async args => { if (args[1] === 'add') named.push(args[args.indexOf('--name') + 1]); return inner(args); })(w.cli);
  w.members = () => [];
  await w.run({ name: null, now: () => 1_700_000_000_000 }).catch(() => {});
  assert.deepEqual(named, [`smoke-${(1_700_000_000_000).toString(36)}`]);
  assert.ok(named[0].length <= 28 && /^smoke-[a-z0-9]+$/.test(named[0]));
  const long = [];
  const v = world();
  v.cli = (inner => async args => { if (args[1] === 'add') long.push(args[args.indexOf('--name') + 1]); return inner(args); })(v.cli);
  await v.run({ name: 'smoke-' + 'z'.repeat(40) }).catch(() => {});
  assert.equal(long[0].length, 28);
});

test('smoke, slow registry: two unknown-device tries, the third leases, within 60 s by the fake clock', async () => {
  const w = world({ leaseAnswers: n => (n < 3 ? out(2, '', 'HUB_USAGE unknown device "smoke-x"') : out(0, JSON.stringify({ lease_id: 'l-3', device: NAME }))) });
  const line = await w.run();
  assert.equal(w.leases, 3);
  assert.equal(line, `HUB_SMOKE_OK v1.2.53 ${ID} leasable after ${2 * TRY_EVERY_MS} ms`);
  assert.ok(w.tries.every(at => at - w.tries[0] < LEASABLE_WITHIN_MS));
  assert.deepEqual(w.log.find(args => args[0] === 'release'), ['release', 'l-3']);
});

test('smoke, never leasable: HUB_SMOKE_FAILED leasable after 60 s, no try after the deadline, the Resource is retired', async () => {
  const w = world({ leaseAnswers: () => out(2, '', 'HUB_USAGE unknown device "smoke-x"') });
  const start = w.clock;
  await assert.rejects(w.run(), error => error.code === 'HUB_SMOKE_FAILED' && error.step === 'leasable' && /^HUB_SMOKE_FAILED leasable: .*within 60 s/.test(error.message));
  assert.ok(w.tries.length > 1 && w.tries.length <= 32, 'bounded');
  assert.ok(w.tries.every(at => at < start + LEASABLE_WITHIN_MS), 'no try starts at or after the deadline');
  assert.ok(w.clock >= start + LEASABLE_WITHIN_MS && w.clock < start + LEASABLE_WITHIN_MS + TRY_EVERY_MS);
  assert.ok(w.retired, 'the test phone was retired');
  assert.equal(verbs(w).filter(verb => verb === 'release').length, 0, 'no lease was taken, none released');
  assert.ok(w.lines.some(line => /^HUB_SMOKE cleanup: retired res-smoke-x/.test(line)));
  const failed = w.lines.findIndex(line => line.startsWith('HUB_SMOKE_FAILED leasable: '));
  assert.ok(failed !== -1 && w.lines.findIndex(line => line.startsWith('HUB_SMOKE cleanup:')) > failed, 'the failure is logged, then the cleanup');
});

test('smoke, a clock that never advances still ends (bounded tries)', async () => {
  const w = world({ leaseAnswers: () => out(2, '', 'nope') });
  await assert.rejects(w.run({ sleep: async () => {} }), /HUB_SMOKE_FAILED leasable/);
  assert.ok(w.tries.length <= 32);
});

test('smoke, API down, a wrong ref or a foreign service: HUB_SMOKE_FAILED health, nothing registered', async () => {
  for (const [label, fetchImpl, pattern] of [
    ['refused', async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }); }, /did not answer/],
    ['500', async () => ({ status: 500, text: async () => 'no' }), /did not answer/],
    ['wrong ref', health({ hub_version: 'v1.2.52' }), /runs v1\.2\.52, not v1\.2\.53/],
    ['other service', health({ service: 'something-else' }), /not mobile-deploy-hub-api/],
    ['registry unreadable', health({ registry: 'unreadable' }), /Registry is unreadable/],
    ['ok false', health({ ok: false }), /does not say ok/],
    ['no registry field', health({ registry: undefined }), /Registry is not reported/],
  ]) {
    const w = world();
    await assert.rejects(w.run({ fetchImpl }), error => error.step === 'health' && pattern.test(error.message) && error.message.startsWith('HUB_SMOKE_FAILED health: '), label);
    assert.deepEqual(w.log, [], `${label}: the cli log is empty`);
  }
});

test('smoke, add refused: HUB_SMOKE_FAILED register, no lease or retire attempted', async () => {
  const w = world({ add: () => out(1, '', 'HUB_API_DOWN the Hub API is not answering') });
  await assert.rejects(w.run(), error => error.step === 'register' && /HUB_API_DOWN/.test(error.message));
  assert.deepEqual(verbs(w), ['registry list', 'registry add']);
});

test('smoke, a registry that cannot be listed fails at list before anything is registered', async () => {
  const w = world({ list: () => out(1, '', 'boom') });
  await assert.rejects(w.run(), error => error.step === 'list');
  assert.deepEqual(verbs(w), ['registry list']);
});

test('smoke, a failure between the lease and the release releases the lease and retires the Resource', async () => {
  const w = world();
  w.members = () => ['s24'];
  await assert.rejects(w.run(), error => error.step === 'leasable' && /phone word does not list/.test(error.message));
  assert.deepEqual(verbs(w).slice(-2), ['release', 'registry retire']);
  assert.ok(w.lines.some(line => line.includes('cleanup: released l-1')) && w.lines.some(line => line.includes('cleanup: retired res-smoke-x')));
});

test('smoke, a release that fails is cleaned up again, and a status that omits the phone is a failure', async () => {
  let first = true;
  const w = world({ release: () => { if (first) { first = false; return out(1, '', 'nope'); } return out(0); } });
  await assert.rejects(w.run(), error => error.step === 'release');
  assert.deepEqual(verbs(w).filter(verb => verb === 'release').length, 2);
  assert.ok(w.retired);
  const v = world({ status: () => out(0, JSON.stringify({ phones: [] })) });
  await assert.rejects(v.run(), error => error.step === 'leasable' && /status does not list/.test(error.message));
});

test('smoke, a retire that does not remove the phone from the word, from status, or from lease is a failure', async () => {
  const still = world();
  still.members = () => ['s24', NAME];
  await assert.rejects(still.run(), error => error.step === 'gone' && /phone word still lists/.test(error.message));
  const status = world({ status: w => out(0, JSON.stringify({ phones: [{ device: NAME }] })) });
  await assert.rejects(status.run(), error => error.step === 'leasable' || error.step === 'gone');
  let relet = 0;
  const lease = world();
  const inner = lease.cli;
  lease.cli = async args => { if (args[0] === 'lease' && lease.retired) { relet += 1; return out(0, JSON.stringify({ lease_id: 'l-again', device: NAME })); } return inner(args); };
  await assert.rejects(lease.run(), error => error.step === 'gone' && /not refused HUB_RESOURCE_RETIRED/.test(error.message));
  assert.ok(relet === 1 && lease.log.some(args => args[0] === 'release' && args[1] === 'l-again'), 'a lease that should not exist is released');
});

test('smoke, a warning line before HUB_RESOURCE_RETIRED on stderr is still a correct refusal', async () => {
  const w = world();
  const inner = w.cli;
  w.cli = async args => {
    const answer = await inner(args);
    return args[0] === 'lease' && w.retired ? { ...answer, stderr: `hub-device: warning: HUB_REGISTRY_FORMAT something\n${answer.stderr}` } : answer;
  };
  assert.match(await w.run(), /^HUB_SMOKE_OK /);
});

test('smoke, a retire that is refused is a failure at retire', async () => {
  const w = world({ retire: () => out(1, '', 'HUB_API_DOWN') });
  await assert.rejects(w.run(), error => error.step === 'retire');
});

test('smoke, a seam that throws still cleans up', async () => {
  const w = world();
  w.members = () => { throw new Error('registry unreadable'); };
  await assert.rejects(w.run(), error => error.step === 'unexpected' && /registry unreadable/.test(error.message));
  assert.ok(w.retired && w.leases === 1 && verbs(w).includes('release'));
});

test('smoke, arguments are checked', async () => {
  await assert.rejects(hubSmoke({ cli: async () => out(0) }), TypeError);
  await assert.rejects(hubSmoke({ ref: 'v1' }), TypeError);
});

test('phoneWordMembers: the phone word after the retired narrowing, over a lock dir', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hub-smoke-members-'));
  try {
    const env = { HUB_LOCK_DIR: dir, HOME: dir, HUB_EVENT_DIR: join(dir, 'events') };
    assert.deepEqual(phoneWordMembers({ env }).slice(0, 2), ['s24', 's26'], 'no file: the seed, in the phone word\'s order');
    const seeded = seed(loadDevices({}), { qaDevices: () => [] });
    const { record, resources } = planRegister({ resources: seeded.resources }, { kind: 'phone', name: NAME, host: 'linux', identity: { model: 'hub smoke' }, capabilities: {} });
    await writeRegistry({ env, if_rev: 0, resources, pools: seeded.pools, hostId: 'test-host', log: () => {} });
    assert.ok(phoneWordMembers({ env }).includes(NAME), 'a registered phone joins the phone word');
    await writeRegistry({ env, if_rev: 1, resources: resources.map(entry => (entry.id === record.id ? { ...entry, retired_at: '2026-11-25T00:01:00.000Z' } : entry)), pools: seeded.pools, hostId: 'test-host', log: () => {} });
    assert.ok(!phoneWordMembers({ env }).includes(NAME), 'a retired one is gone from it');
    assert.ok(phoneWordMembers({ env }).includes('s24'));
    await writeRegistry({ env, if_rev: 2, resources: resources.map(entry => (entry.kind === 'phone' ? { ...entry, retired_at: '2026-11-25T00:02:00.000Z' } : entry)), pools: seeded.pools, hostId: 'test-host', log: () => {} });
    assert.deepEqual(phoneWordMembers({ env }), [], 'every phone retired: none is left, and that is an empty list, not an error');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('hosts:install never runs the smoke: it writes a permanent retired record, so it is its own command', () => {
  const source = readFileSync(fileURLToPath(new URL('../hosts.mjs', import.meta.url)), 'utf8');
  assert.doesNotMatch(source, /hosts\/smoke|hubSmoke|hosts:smoke/);
  const install = readFileSync(fileURLToPath(new URL('./units/install.sh', import.meta.url)), 'utf8');
  assert.doesNotMatch(install, /smoke/);
});

test('hubDeviceCli runs the command with its own words first, reports the exit code, and returns stdout and stderr', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hub-smoke-cli-'));
  try {
    const script = join(dir, 'stub.mjs');
    writeFileSync(script, "process.stdout.write(JSON.stringify(process.argv.slice(2)));\nprocess.stderr.write('warned');\nprocess.exit(Number(process.env.STUB_EXIT ?? 0));\n");
    const ok = await hubDeviceCli(`${process.execPath} ${script} first`, { env: { ...process.env, STUB_EXIT: '0' } })(['lease', 'x y', '--json']);
    assert.deepEqual([ok.code, JSON.parse(ok.stdout), ok.stderr], [0, ['first', 'lease', 'x y', '--json'], 'warned']);
    const bad = await hubDeviceCli(`${process.execPath} ${script}`, { env: { ...process.env, STUB_EXIT: '2' } })(['status']);
    assert.deepEqual([bad.code, JSON.parse(bad.stdout), bad.stderr], [2, ['status'], 'warned']);
    const gone = await hubDeviceCli(join(dir, 'no-such-command'))(['status']);
    assert.equal(gone.code, 127);
    assert.ok(typeof gone.stderr === 'string' && gone.stderr !== '');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the CLI entry refuses an unknown argument with HUB_SMOKE_FAILED on stderr, exit 1, and no hub-device call', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hub-smoke-entry-'));
  try {
    const stub = join(dir, 'stub.mjs');
    const called = join(dir, 'called');
    writeFileSync(stub, `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(called)}, 'yes');\n`);
    const entry = fileURLToPath(new URL('./smoke.mjs', import.meta.url));
    const result = spawnSync(process.execPath, [entry, '--bogus', '--hub-device', `${process.execPath} ${stub}`], { encoding: 'utf8', timeout: 30_000 });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /HUB_SMOKE_FAILED .*--bogus/);
    assert.equal(result.stdout, '');
    assert.throws(() => readFileSync(called), { code: 'ENOENT' }, 'hub-device was never called');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
