// Story 6.12 and 7.9: `mise run hosts:smoke` (tools/hosts/smoke.mjs), hermetic: a fake hub-device (`cli`), a fake fetchImpl, a fake clock whose
// sleep advances it. No port, lock dir, 1Password or real hub-device is touched.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hermetic } from '../ci/test-fixtures.mjs';
import { HOLD_EXTEND_MS, LEASABLE_WITHIN_MS, TRY_EVERY_MS, WAITER_SHOWS_WITHIN_MS, apiCaller, holdParity, hubDeviceCli, hubSmoke, parseSmokeArgs, runEntry } from './smoke.mjs';
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

// ---------------------------------------------------------------------------------------------------- Story 7.9: the holds phase

const parseMs = text => { const m = /^(\d+)([sm]?)$/.exec(String(text)); return m === null ? NaN : Number(m[1]) * (m[2] === 'm' ? 60_000 : m[2] === 's' ? 1000 : 1); };

// One shared lock state for `target` that the fake `cli` and the fake `fetchImpl` both mutate, so the two doors answer one Claims library.
// Waits are promises settled when the lock is released, force-released or the waiter is withdrawn.
function holdsWorld({ target = NAME, busy = false, hideWaiters = false, cliStaysWaiting = false, apiExtendIgnoresWaiters = false, cliExtendIgnoresWaiters = false, extendMs = null } = {}) {
  const hold = { lease: busy ? 'someone-else' : null, holder: busy ? 'somebody' : null, why: busy ? 'work' : null, expiresAt: null, queue: [] };
  const w = world({ status: wd => { w.statusAt.push(wd.clock); return out(0, JSON.stringify(statusBody(wd))); } });
  w.statusAt = [];
  const leaseBody = id => ({ lease_id: id, resource: target, lock: target, device: target, holder: hold.holder, why: hold.why, claimant_kind: 'agent', started_at: 'x', expires_at: new Date(hold.expiresAt).toISOString(), env: { HUB_LEASE_ID: id, HUB_DEVICE: target, ANDROID_ADB_SERVER_PORT: '5037' }, emulator: null });
  const grant = ({ id, holder, why, forMs }) => { hold.lease = id; hold.holder = holder; hold.why = why; hold.expiresAt = w.clock + forMs; return leaseBody(id); };
  const promote = () => {
    hold.lease = null; hold.holder = null; hold.why = null; hold.expiresAt = null;
    const next = hold.queue.shift();
    if (next) next.settle({ kind: 'ok', body: grant(next) });
  };
  const ops = {
    knows: id => hold.lease === id || hold.queue.some(entry => entry.id === id),
    take(request) {
      if (hold.lease === null && hold.queue.length === 0) return { kind: 'ok', body: grant(request) };
      if (!(request.waitMs > 0)) return { kind: 'busy' };
      return new Promise(settle => hold.queue.push({ ...request, settle }));
    },
    extend({ id, forMs, door }) {
      if (id !== hold.lease) return { kind: 'none' };
      if (hold.queue.length > 0 && !(door === 'api' ? apiExtendIgnoresWaiters : cliExtendIgnoresWaiters)) return { kind: 'refused' };
      hold.expiresAt += extendMs ?? forMs;
      return { kind: 'ok', body: leaseBody(id) };
    },
    force({ id, why }) {
      if (id !== hold.lease) return { kind: 'none' };
      const body = { lease_id: id, outcome: 'force-released', resource: target, lock: target, device: target, holder: hold.holder, why };
      promote();
      return { kind: 'ok', body };
    },
    release({ id }) {
      if (id === hold.lease) { promote(); return { kind: 'released' }; }
      const index = hold.queue.findIndex(entry => entry.id === id);
      if (index === -1) return { kind: 'none' };
      const [gone] = hold.queue.splice(index, 1);
      gone.settle({ kind: 'cancelled' });
      return { kind: 'cancelled' };
    },
  };
  function statusBody(wd) {
    const phones = [{ device: 's24', held: 'free' }, ...(wd.registered && !wd.retired ? [{ device: NAME, held: 'free' }] : [])];
    const entry = phones.find(phone => phone.device === target);
    if (entry) Object.assign(entry, { lock: target, held: hold.lease ? 'lease' : 'free', holder: hold.holder, lease_id: hold.lease, why: hold.why, expires_at: hold.expiresAt === null ? null : new Date(hold.expiresAt).toISOString() });
    let waiters = hideWaiters ? [] : hold.queue.map((entry2, index) => ({ lock: target, device: target, position: index + 1, lease_id: entry2.id, holder: entry2.holder }));
    if (cliStaysWaiting && String(hold.lease).endsWith('-b-cli')) waiters = [{ lock: target, device: target, position: 1, lease_id: hold.lease, holder: hold.holder }];
    return { phones, waiters };
  }

  const fetchLog = [];
  const reply = (status, payload) => ({ status, text: async () => JSON.stringify(payload) });
  w.fetchLog = fetchLog;
  w.fetch = async (url, init = {}) => {
    const path = new URL(url).pathname;
    if (path === '/health') return health()();
    const body = init.body ? JSON.parse(init.body) : {};
    fetchLog.push({ method: init.method, path, body });
    if (path === '/leases') {
      const answer = await ops.take({ id: body.id, holder: body.holder, why: body.why, forMs: body.for_ms, waitMs: body.wait_ms ?? 0 });
      if (answer.kind === 'ok') return reply(200, answer.body);
      return answer.kind === 'busy' ? reply(409, { code: 'HUB_LOCK_TIMEOUT', reason: 'busy', detail: 'host lock is held' }) : reply(409, { code: 'HUB_LEASE_CANCELLED', reason: 'cancelled', detail: 'cancelled by x' });
    }
    const [, id, action] = /^\/leases\/([^/]+)\/(extend|force-release|release)$/.exec(path) ?? [];
    if (action === 'extend') {
      const answer = ops.extend({ id, forMs: body.for_ms, door: 'api' });
      return answer.kind === 'ok' ? reply(200, answer.body) : answer.kind === 'refused' ? reply(409, { code: 'HUB_LEASE_EXTEND_REFUSED', reason: 'waiters', detail: 'waiters' }) : reply(404, { code: 'HUB_LEASE_NOT_FOUND', reason: 'unknown' });
    }
    if (action === 'force-release') { const answer = ops.force({ id, why: body.why }); return answer.kind === 'ok' ? reply(200, answer.body) : reply(404, { code: 'HUB_LEASE_NOT_FOUND', reason: 'unknown' }); }
    if (action === 'release') { const answer = ops.release({ id }); return reply(200, { lease_id: id, outcome: answer.kind === 'none' ? 'none' : answer.kind, resource: target, lock: target, device: target }); }
    return reply(404, { code: 'HUB_NO_ROUTE' });
  };

  const base = w.cli;
  const flag = (args, name) => args[args.indexOf(name) + 1];
  w.cli = async args => {
    const [verb] = args;
    if (verb === 'lease' && args.includes('--id')) {
      w.log.push(args);
      const answer = await ops.take({ id: flag(args, '--id'), holder: flag(args, '--holder'), why: flag(args, '--why'), forMs: parseMs(flag(args, '--for')), waitMs: parseMs(flag(args, '--wait')) });
      if (answer.kind === 'ok') return out(0, JSON.stringify({ lease_id: answer.body.lease_id, device: target, holder: answer.body.holder, why: answer.body.why, expires_at: answer.body.expires_at, env: answer.body.env }));
      return answer.kind === 'busy' ? out(76, '', 'HUB_LOCK_TIMEOUT host lock is held by somebody') : out(1, '', 'HUB_LEASE_CANCELLED cancelled by x');
    }
    if (verb === 'extend') {
      w.log.push(args);
      const answer = ops.extend({ id: args[1], forMs: parseMs(flag(args, '--for')), door: 'cli' });
      return answer.kind === 'ok' ? out(0, JSON.stringify({ lease_id: args[1], lock: target, device: target, expires_at: answer.body.expires_at })) : answer.kind === 'refused' ? out(76, '', 'HUB_LEASE_EXTEND_REFUSED a waiter is in line') : out(2, '', 'HUB_LEASE_NOT_FOUND');
    }
    if (verb === 'force-release') {
      w.log.push(args);
      const answer = ops.force({ id: args[1], why: flag(args, '--why') });
      return answer.kind === 'ok' ? out(0, JSON.stringify(answer.body)) : out(2, '', 'HUB_LEASE_NOT_FOUND');
    }
    if (verb === 'release' && ops.knows(args[1])) {
      w.log.push(args);
      const answer = ops.release({ id: args[1] });
      return out(0, answer.kind === 'released' ? `HUB_DEVICE_RELEASED ${target} ${args[1]}\n` : `HUB_DEVICE_CANCELLED ${target} ${args[1]} (it was still waiting)\n`);
    }
    return base(args);
  };
  w.hold = hold;
  w.runHolds = (extra = {}) => w.run({ fetchImpl: w.fetch, holds: true, ...extra });
  w.parity = (extra = {}) => holdParity({ target, tag: NAME, ref: 'v1.2.53', cli: w.cli, api: apiCaller(w.fetch, policy), now: w.now, sleep: w.sleep, log: line => w.lines.push(line), ...extra });
  return w;
}

const nonStatus = w => verbs(w).filter(verb => verb !== 'status');

test('holds, happy: the API and the CLI traces are equal, six snapshots, then retire and the unchanged OK line', async () => {
  const w = holdsWorld();
  const line = await w.runHolds();
  assert.equal(line, 'HUB_SMOKE_OK v1.2.53 res-smoke-x leasable after 0 ms');
  const holdsLine = w.lines.find(text => text.startsWith('HUB_SMOKE holds: '));
  assert.equal(holdsLine, 'HUB_SMOKE holds: api and cli match on smoke-x (6 steps: take-a, wait-b, extend-refused, force-release, extend-b, release-b)');
  assert.ok(w.lines.indexOf(holdsLine) > w.lines.findIndex(text => text.startsWith('HUB_SMOKE release:')) && w.lines.indexOf(holdsLine) < w.lines.findIndex(text => text.startsWith('HUB_SMOKE retire:')), 'between release and retire');
  assert.deepEqual(nonStatus(w), ['registry list', 'registry add', 'lease', 'release', 'lease', 'lease', 'extend', 'force-release', 'extend', 'release', 'registry retire', 'lease']);
  assert.deepEqual(w.log.find(args => args[0] === 'lease' && args.includes(`${NAME}-a-cli`)), ['lease', NAME, '--no-connect', '--wait', '0', '--for', '2m', '--why', 'hosts:smoke v1.2.53 holds', '--holder', 'hosts:smoke', '--id', `${NAME}-a-cli`, '--json']);
  assert.deepEqual(w.log.find(args => args[0] === 'lease' && args.includes(`${NAME}-b-cli`)).slice(0, 5), ['lease', NAME, '--no-connect', '--wait', '30s']);
  assert.deepEqual(w.log.find(args => args[0] === 'extend'), ['extend', `${NAME}-a-cli`, '--for', '1m', '--holder', 'hosts:smoke', '--json']);
  assert.deepEqual(w.log.find(args => args[0] === 'force-release'), ['force-release', `${NAME}-a-cli`, '--why', 'hosts:smoke v1.2.53 holds', '--holder', 'hosts:smoke', '--json']);
  assert.deepEqual(w.fetchLog.map(call => `${call.method} ${call.path}`), ['POST /leases', 'POST /leases', `POST /leases/${NAME}-a-api/extend`, `POST /leases/${NAME}-a-api/force-release`, `POST /leases/${NAME}-b-api/extend`, `POST /leases/${NAME}-b-api/release`]);
  assert.deepEqual(w.fetchLog[0].body, { resource: NAME, for_ms: 120_000, holder: 'hosts:smoke', why: 'hosts:smoke v1.2.53 holds', id: `${NAME}-a-api` });
  assert.deepEqual(w.fetchLog[1].body, { resource: NAME, for_ms: 120_000, holder: 'hosts:smoke', why: 'hosts:smoke v1.2.53 holds', id: `${NAME}-b-api`, wait_ms: 30_000 });
  assert.deepEqual(w.fetchLog[2].body, { for_ms: HOLD_EXTEND_MS, holder: 'hosts:smoke' });
  assert.deepEqual(w.fetchLog[3].body, { why: 'hosts:smoke v1.2.53 holds', holder: 'hosts:smoke' });
  assert.ok(w.hold.lease === null && w.hold.queue.length === 0 && w.retired);
});

test('holdParity, the traces: six snapshots per door, ids mapped to A and B, the two traces deep equal', async () => {
  const w = holdsWorld();
  w.registered = true;
  const { target, traces } = await w.parity();
  assert.equal(target, NAME);
  assert.equal(traces.api.length, 6);
  assert.deepEqual(traces.api, traces.cli);
  assert.deepEqual(traces.api.map(entry => entry.step), ['take-a', 'wait-b', 'extend-refused', 'force-release', 'extend-b', 'release-b']);
  const [take, wait, refused, forced, extended, released] = traces.api;
  assert.deepEqual([take.held, take.holder, take.why, take.lease, take.waiters], ['lease', 'hosts:smoke', 'hosts:smoke v1.2.53 holds', 'A', []]);
  assert.deepEqual(take.answer, { lease: 'A', device: NAME, holder: 'hosts:smoke', why: 'hosts:smoke v1.2.53 holds', env: ['ANDROID_ADB_SERVER_PORT', 'HUB_DEVICE', 'HUB_LEASE_ID'] });
  assert.deepEqual([wait.lease, wait.waiters], ['A', [{ lease: 'B', position: 1, holder: 'hosts:smoke' }]]);
  assert.deepEqual(refused.answer, { outcome: 'refused' });
  assert.deepEqual([forced.lease, forced.waiters, forced.answer.forced.lease, forced.answer.granted.lease], ['B', [], 'A', 'B']);
  assert.deepEqual([extended.answer.outcome, extended.lease], ['extended', 'B']);
  assert.deepEqual([released.held, released.lease, released.holder, released.why, released.waiters], ['free', null, null, null, []]);
});

test('holds: false is the 6.12 world: the exact call list, no Hold route, no extra status', async () => {
  const w = holdsWorld();
  await w.run({ fetchImpl: w.fetch });
  assert.deepEqual(verbs(w), ['registry list', 'registry add', 'lease', 'status', 'release', 'registry retire', 'lease', 'status']);
  assert.deepEqual(w.fetchLog, []);
  assert.ok(!w.lines.some(text => text.startsWith('HUB_SMOKE holds')));
  const v = holdsWorld();
  await v.run({ fetchImpl: v.fetch, holds: false });
  assert.deepEqual(verbs(v), verbs(w));
});

test('holds, the target is busy: HUB_SMOKE_FAILED holds, nothing was taken, the phone is retired', async () => {
  const w = holdsWorld({ busy: true });
  await assert.rejects(w.runHolds(), error => error.step === 'holds' && /^HUB_SMOKE_FAILED holds: smoke-x is not free \(lease by somebody, 0 waiting\)/.test(error.message));
  assert.deepEqual(w.fetchLog, [], 'no API take');
  assert.ok(!w.log.some(args => args[0] === 'lease' && args.includes('--id')), 'no CLI take');
  assert.ok(w.retired && w.lines.some(text => /^HUB_SMOKE cleanup: retired res-smoke-x/.test(text)));
});

test('holds, a target someone waits on is not free either', async () => {
  const w = holdsWorld();
  w.hold.queue.push({ id: 'other-wait', holder: 'x', why: 'y', forMs: 1, waitMs: 1, settle: () => {} });
  await assert.rejects(w.runHolds(), error => /not free \(free, 1 waiting\): nothing was taken/.test(error.message));
  assert.deepEqual(w.fetchLog, []);
});

test('holds, the doors differ: status still shows B waiting on the CLI side', async () => {
  const w = holdsWorld({ cliStaysWaiting: true });
  await assert.rejects(w.runHolds(), error => error.step === 'holds' && /^HUB_SMOKE_FAILED holds: api and cli differ at force-release: api \{.*\}, cli \{.*"waiters":\[\{"lease":"B"/.test(error.message));
  assert.ok(w.retired && w.hold.lease === null && w.hold.queue.length === 0, 'ids released, phone retired');
});

test('holds, the doors differ: the API extend is allowed while B waits', async () => {
  const w = holdsWorld({ apiExtendIgnoresWaiters: true });
  await assert.rejects(w.runHolds(), error => /^HUB_SMOKE_FAILED holds: api and cli differ at extend-refused: /.test(error.message) && /"outcome":"extended"/.test(error.message) && /"outcome":"refused"/.test(error.message));
  assert.ok(w.retired && w.hold.lease === null);
});

test('holds, both doors equally wrong is still a failure: an extend allowed while B waits on both', async () => {
  const w = holdsWorld({ apiExtendIgnoresWaiters: true, cliExtendIgnoresWaiters: true });
  await assert.rejects(w.runHolds(), error => error.step === 'holds' && /^HUB_SMOKE_FAILED holds: api and cli agree at extend-refused, but the state is wrong: /.test(error.message));
  assert.ok(w.retired && w.hold.lease === null);
});

test('holds, B never waits: HUB_SMOKE_FAILED after a bounded 10 s on the fake clock, B then A released, no status read after the deadline', async () => {
  const w = holdsWorld({ hideWaiters: true });
  await assert.rejects(w.runHolds(), error => error.step === 'holds' && /^HUB_SMOKE_FAILED holds: api B never waited: status did not list it within 10 s/.test(error.message));
  assert.ok(Math.max(...w.statusAt) - Math.min(...w.statusAt) < WAITER_SHOWS_WITHIN_MS, 'no status read at or after the deadline');
  const cleanup = w.lines.filter(text => text.startsWith('HUB_SMOKE cleanup:'));
  assert.deepEqual(cleanup.slice(0, 2), [`HUB_SMOKE cleanup: released ${NAME}-b-api`, `HUB_SMOKE cleanup: released ${NAME}-a-api`]);
  assert.ok(w.lines.some(text => /cleanup: retired res-smoke-x/.test(text)) && w.retired);
  assert.ok(w.hold.lease === null && w.hold.queue.length === 0, 'the waiter is withdrawn and A is released');
});

test('holds, a clock that never advances still ends the wait (bounded tries)', async () => {
  const w = holdsWorld({ hideWaiters: true });
  await assert.rejects(w.runHolds({ sleep: async () => {} }), /B never waited/);
  assert.ok(w.statusAt.length < 40);
});

test('holds, an extend that does not move expires_at by exactly 60 000 ms fails at extend, ids released', async () => {
  const w = holdsWorld({ extendMs: 1000 });
  await assert.rejects(w.runHolds(), error => error.step === 'holds' && /^HUB_SMOKE_FAILED holds: api extend of B moved expires_at by 1000 ms, not 60000 ms/.test(error.message));
  assert.ok(w.hold.lease === null && w.retired);
  assert.ok(w.lines.some(text => text === `HUB_SMOKE cleanup: released ${NAME}-b-api`));
});

test('holds, a take that is refused fails at holds and releases what it started', async () => {
  const w = holdsWorld();
  const inner = w.fetch;
  w.fetch = async (url, init) => (new URL(url).pathname === '/leases' && JSON.parse(init.body).id.endsWith('-a-api') ? { status: 409, text: async () => JSON.stringify({ code: 'HUB_LOCK_TIMEOUT', detail: 'busy' }) } : inner(url, init));
  await assert.rejects(w.runHolds(), error => /^HUB_SMOKE_FAILED holds: api take of A failed \(status 409 HUB_LOCK_TIMEOUT: busy\)/.test(error.message));
  assert.ok(w.retired);
});

test('holds, a transport failure of the API is a failed take, not an unhandled rejection', async () => {
  const w = holdsWorld();
  await assert.rejects(w.runHolds({ fetchImpl: async url => { if (new URL(url).pathname === '/health') return health()(); throw new Error('socket hang up'); } }), error => /api take of A failed \(status 0 HUB_API_DOWN: socket hang up\)/.test(error.message));
  assert.ok(w.retired);
});

test('holds on a named word: holds: s24 runs the phase on s24 and the retire is still the test phone\'s', async () => {
  const w = holdsWorld({ target: 's24' });
  const line = await w.run({ fetchImpl: w.fetch, holds: 's24' });
  assert.match(line, /^HUB_SMOKE_OK /);
  assert.ok(w.lines.includes('HUB_SMOKE holds: api and cli match on s24 (6 steps: take-a, wait-b, extend-refused, force-release, extend-b, release-b)'));
  assert.ok(w.fetchLog.every(call => call.path !== '/leases' || call.body.resource === 's24'));
  assert.ok(w.log.filter(args => args[0] === 'lease' && args.includes('--id')).every(args => args[1] === 's24' && args.includes('--no-connect')));
  assert.ok(w.fetchLog[0].body.id.startsWith(`${NAME}-a-`), 'the id tag is the smoke phone\'s name');
  assert.ok(w.retired);
});

test('holds, a status that does not list the target, or none at all, is a failure', async () => {
  const w = holdsWorld({ target: 's26' });
  await assert.rejects(w.run({ fetchImpl: w.fetch, holds: 's26' }), error => /status does not list s26/.test(error.message));
  const v = holdsWorld();
  const inner = v.cli;
  v.cli = async args => (args[0] === 'status' && v.registered && v.leases === 1 && v.statusAt.length >= 2 ? out(1, '', 'boom') : inner(args));
  await assert.rejects(v.runHolds(), error => error.step === 'holds' && /status --json gave no phones/.test(error.message));
  assert.ok(v.retired);
});

test('holds, a seam that throws still cleans up and fails at holds', async () => {
  const w = holdsWorld();
  const inner = w.cli;
  w.registered = true;
  w.cli = async args => { if (args[0] === 'extend') throw new Error('cli exploded'); return inner(args); };
  await assert.rejects(w.parity(), error => error.step === 'holds' && /cli extend of B failed \(exit 127: cli exploded\)/.test(error.message));
  assert.ok(w.hold.lease === null && w.hold.queue.length === 0, 'ids released');
});

test('holdParity, arguments are checked, and hubSmoke refuses a holds that is neither a boolean nor a word', async () => {
  await assert.rejects(holdParity({ tag: 'x', cli: async () => out(0), api: async () => ({}) }), TypeError);
  await assert.rejects(holdParity({ target: 'x', cli: async () => out(0), api: async () => ({}) }), TypeError);
  await assert.rejects(holdParity({ target: 'x', tag: 'x' }), TypeError);
  await assert.rejects(hubSmoke({ ref: 'v1', cli: async () => out(0), holds: 3 }), TypeError);
  await assert.rejects(hubSmoke({ ref: 'v1', cli: async () => out(0), holds: '' }), TypeError);
});

test('apiCaller: posts JSON to the policy port, answers {status, body}, never rejects, and times out at the wait plus 30 s (else 30 s)', async () => {
  const seen = [];
  const original = AbortSignal.timeout;
  AbortSignal.timeout = ms => { seen.push(ms); return original.call(AbortSignal, 60_000); };
  try {
    const fetchImpl = async (url, init) => {
      seen.push([url, init.method, init.headers['content-type'] ?? null, init.body ?? null]);
      if (url.endsWith('/boom')) throw new Error('reset');
      return { status: 409, text: async () => JSON.stringify({ code: 'X' }) };
    };
    const call = apiCaller(fetchImpl, policy);
    assert.deepEqual(await call({ path: '/leases', body: { a: 1 }, waitMs: 30_000 }), { status: 409, body: { code: 'X' } });
    assert.deepEqual(await call({ path: '/leases/x/release', body: {} }), { status: 409, body: { code: 'X' } });
    assert.deepEqual(await call({ method: 'GET', path: '/leases/x' }), { status: 409, body: { code: 'X' } });
    assert.deepEqual(await call({ path: '/boom', body: {} }), { status: 0, body: { code: 'HUB_API_DOWN', detail: 'reset' } });
    assert.deepEqual(seen.filter(entry => typeof entry === 'number'), [60_000, 30_000, 30_000, 30_000]);
    assert.deepEqual(seen.find(entry => Array.isArray(entry)), ['http://127.0.0.1:8794/leases', 'POST', 'application/json', '{"a":1}']);
    assert.deepEqual(seen.filter(entry => Array.isArray(entry))[2], ['http://127.0.0.1:8794/leases/x', 'GET', null, null]);
  } finally { AbortSignal.timeout = original; }
});

test('the CLI arguments: --holds-on takes a word, --no-holds turns the phase off, the default is on, a bad combination is a usage failure', () => {
  assert.deepEqual(parseSmokeArgs([]), { hubDevice: 'hub-device', ref: undefined, holds: true });
  assert.equal(parseSmokeArgs(['--holds-on', 's24']).holds, 's24');
  assert.equal(parseSmokeArgs(['--no-holds']).holds, false);
  assert.deepEqual(parseSmokeArgs(['--hub-device', 'node x.mjs', '--ref', 'v1.2.56', '--no-holds']), { hubDevice: 'node x.mjs', ref: 'v1.2.56', holds: false });
  assert.throws(() => parseSmokeArgs(['--holds-on']), /--holds-on takes a value/);
  assert.throws(() => parseSmokeArgs(['--holds-on', '--no-holds']), /--holds-on takes a value/);
  assert.throws(() => parseSmokeArgs(['--holds-on', 's24', '--no-holds']), /exclude each other/);
  assert.throws(() => parseSmokeArgs(['--no-holds', 'stray']), /unknown: stray/);
});

test('the CLI entry: --holds-on without a value, or with --no-holds, fails with exit 1 and never calls hub-device', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hub-smoke-holds-entry-'));
  try {
    const stub = join(dir, 'stub.mjs');
    const called = join(dir, 'called');
    writeFileSync(stub, `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(called)}, 'yes');\n`);
    const entry = fileURLToPath(new URL('./smoke.mjs', import.meta.url));
    for (const extra of [['--holds-on'], ['--holds-on', 's24', '--no-holds']]) {
      const result = spawnSync(process.execPath, [entry, ...extra, '--hub-device', `${process.execPath} ${stub}`], { encoding: 'utf8', timeout: 30_000 });
      assert.equal(result.status, 1, extra.join(' '));
      assert.match(result.stderr, /^HUB_SMOKE_FAILED /);
      assert.equal(result.stdout, '');
      assert.throws(() => readFileSync(called), { code: 'ENOENT' }, 'hub-device was never called');
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('runEntry forwards holds (true by default, a word, false), the ref and the hub-device command to hubSmoke, and resolves the exit code', async () => {
  const calls = [];
  const makes = [];
  const seams = fail => ({ smoke: async options => { calls.push(options); if (fail) throw fail; }, makeCli: command => { makes.push(command); return `cli:${command}`; }, defaultRef: () => 'v-default' });
  assert.equal(await runEntry([], seams()), 0);
  assert.equal(await runEntry(['--holds-on', 's24', '--ref', 'v1.2.56', '--hub-device', 'node x.mjs'], seams()), 0);
  assert.equal(await runEntry(['--no-holds'], seams()), 0);
  assert.deepEqual(calls, [
    { ref: 'v-default', cli: 'cli:hub-device', holds: true },
    { ref: 'v1.2.56', cli: 'cli:node x.mjs', holds: 's24' },
    { ref: 'v-default', cli: 'cli:hub-device', holds: false },
  ]);
  assert.deepEqual(makes, ['hub-device', 'node x.mjs', 'hub-device']);
  const before = calls.length;
  assert.equal(await runEntry(['--holds-on'], seams()), 1);
  assert.equal(calls.length, before, 'a usage failure never reaches hubSmoke');
  assert.equal(await runEntry([], seams(Object.assign(new Error('HUB_SMOKE_FAILED holds: x'), { smoke: true }))), 1);
});
