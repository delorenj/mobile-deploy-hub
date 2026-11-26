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
import { HOLD_EXTEND_MS, LANE_SHOWS_WITHIN_MS, LEASABLE_WITHIN_MS, RESTART_WITHIN_MS, STATUS_WITHIN_MS, TRY_EVERY_MS, WAITER_SHOWS_WITHIN_MS, apiCaller, holdParity, hubDeviceCli, hubSmoke, laneCheck, parseSmokeArgs, runEntry, sseReader, streamCheck } from './smoke.mjs';
import { ID_PATTERN, createStream } from '../hub-api/stream.mjs';
import { phoneWordMembers } from '../device/claims.mjs';
import { loadDevices } from '../ci/lib/devices.mjs';
import { planRegister } from '../registry/changes.mjs';
import { seed } from '../registry/seed.mjs';
import { writeRegistry } from '../registry/store.mjs';

hermetic();

const policy = { api: { hub_api_port: 8794, stream_keepalive_s: 15 } };
const NAME = 'smoke-x';
const ID = 'res-smoke-x';

const health = (overrides = {}) => async () => ({ status: 200, text: async () => JSON.stringify({ ok: true, service: 'mobile-deploy-hub-api', contract: 1, hub_version: 'v1.2.53', registry: 'ok', ...overrides }) });
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
    ['contract 2', health({ contract: 2 }), /speaks contract 2, not 1/],
    ['contract as text', health({ contract: '1.0' }), /speaks contract 1\.0, not 1/],
    ['no contract', health({ contract: undefined }), /speaks contract unknown, not 1/],
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
  assert.deepEqual(parseSmokeArgs([]), { hubDevice: 'hub-device', ref: undefined, holds: true, stream: true, restart: false, lanes: false });
  assert.equal(parseSmokeArgs(['--holds-on', 's24']).holds, 's24');
  assert.equal(parseSmokeArgs(['--no-holds']).holds, false);
  assert.deepEqual(parseSmokeArgs(['--hub-device', 'node x.mjs', '--ref', 'v1.2.56', '--no-holds']), { hubDevice: 'node x.mjs', ref: 'v1.2.56', holds: false, stream: true, restart: false, lanes: false });
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
    { ref: 'v-default', cli: 'cli:hub-device', holds: true, stream: true, restart: false, lanes: false },
    { ref: 'v1.2.56', cli: 'cli:node x.mjs', holds: 's24', stream: true, restart: false, lanes: false },
    { ref: 'v-default', cli: 'cli:hub-device', holds: false, stream: true, restart: false, lanes: false },
  ]);
  assert.deepEqual(makes, ['hub-device', 'node x.mjs', 'hub-device']);
  const before = calls.length;
  assert.equal(await runEntry(['--holds-on'], seams()), 1);
  assert.equal(calls.length, before, 'a usage failure never reaches hubSmoke');
  assert.equal(await runEntry([], seams(Object.assign(new Error('HUB_SMOKE_FAILED holds: x'), { smoke: true }))), 1);
});

// ---------------------------------------------------------------------------------------------------- Story 8.7: the stream phase

const encoder = new TextEncoder();
const tick = () => new Promise(done => setImmediate(done));
const frameText = (id, type, data) => `id: ${id}\nevent: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
const BOOT_A = 'aaaaaaaaaaaa';
const BOOT_B = 'bbbbbbbbbbbb';
const LEASE = `${NAME}-s`;

// A fake service for `/stream`, `/health` and the CLI's Lease on one phone. `/stream` answers a Response over a ReadableStream that the
// fake pushes into. The fake clock lives in `w.clock`: `w.sleep` yields (setImmediate), honours an abort, and then either runs the next
// scheduled push that falls inside the wait (moving the clock to it, so a read and a timeout race deterministically) or moves the clock by
// the whole wait.
function streamWorld(knobs = {}) {
  const {
    opening = null, statusAfterMs = 0, noStatus = false, neverIdle = false, silent = false, restartEndsStream = true, reconnect = 'reset',
    leaseLostOnRestart = false, healthAfterTries = 1, restartCode = 0, leaseRefused = false, streamEnds = false, staleStatus = null,
  } = knobs;
  const w = world({ status: wd => out(0, JSON.stringify({ phones: [{ device: 's24' }, ...(wd.registered && !wd.retired ? [{ device: NAME, held: srv.held ? 'lease' : 'free', lease_id: srv.held }] : [])] })) });
  const srv = { boot: BOOT_A, seq: 0, held: null, ctrl: null, closed: true, timers: [], connections: 0, requests: [], restarts: 0, healthTries: 0, restarted: false };
  w.srv = srv;
  const doc = (held = srv.held) => ({ format: 1, contract: 1, hosts: { linux: { phones: [{ device: 's24', held: 'free', lease_id: null }, { device: NAME, held: held ? 'lease' : 'free', lease_id: held }] } }, registry: {}, stale: false, checked_at: 'x' });
  const push = text => { if (!srv.closed) srv.ctrl.enqueue(encoder.encode(text)); };
  const emit = (type, extra = {}) => { srv.seq += 1; push(frameText(`${srv.boot}-${srv.seq}`, type, { type, seq: srv.seq, key: type, at: 'x', ...extra })); };
  const idle = () => {
    srv.timers = srv.timers.filter(timer => timer.tag !== 'idle');
    if (silent || srv.closed) return;
    srv.timers.push(neverIdle ? { tag: 'idle', at: w.clock + 10_000, run: () => { emit('status', { status: doc() }); idle(); } } : { tag: 'idle', at: w.clock + 15_000, run: () => { push(': keepalive\n\n'); idle(); } });
  };
  const changed = kind => {
    if (srv.closed) return;
    const send = () => { if (noStatus) emit('event', { event_id: 'e1', event: { type: 'lease' } }); else emit('status', { status: staleStatus === kind ? doc(kind === 'lease' ? null : LEASE) : doc() }); idle(); };
    if (statusAfterMs > 0) srv.timers.push({ tag: 'change', at: w.clock + statusAfterMs, run: send }); else send();
  };
  w.sleep = async (ms, signal) => {
    await tick();
    if (signal?.aborted) return;
    const target = w.clock + ms;
    const due = srv.timers.filter(timer => timer.at <= target).sort((a, b) => a.at - b.at)[0];
    if (due) { srv.timers.splice(srv.timers.indexOf(due), 1); w.clock = Math.max(w.clock, due.at); due.run(); await tick(); return; }
    w.clock = target;
  };

  const sse = (head, signal) => {
    const body = new ReadableStream({ start(ctrl) { srv.ctrl = ctrl; srv.closed = false; }, cancel() { srv.closed = true; } });
    signal?.addEventListener('abort', () => { srv.closed = true; try { srv.ctrl.error(new Error('aborted')); } catch { /* done */ } });
    srv.connections += 1;
    push(head);
    return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  const open = (init, lastEventId) => {
    const kind = lastEventId === undefined ? opening : null;
    if (kind === 'status503') return new Response('{}', { status: 503, headers: { 'content-type': 'application/problem+json' } });
    if (kind === 'type') return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    const response = sse(kind === 'noRetry' ? '' : 'retry: 3000\n\n', init.signal);
    const type = lastEventId === undefined ? 'ready' : reconnect;
    if (kind === 'notReady') emit('status', { status: doc() });
    else if (kind === 'badId') push(frameText('nope', 'ready', { type: 'ready', status: doc() }));
    else if (kind === 'noHosts') push(frameText(`${srv.boot}-${srv.seq}`, 'ready', { type: 'ready', status: {} }));
    else if (kind === 'noRetry') push(frameText(`${srv.boot}-${srv.seq}`, 'ready', { type: 'ready', status: doc() }));
    else push(frameText(`${srv.boot}-${srv.seq}`, type, { type, seq: srv.seq, key: type, at: 'x', ...(type === 'reset' ? { reason: 'unresumable' } : {}), status: doc() }));
    if (streamEnds) { srv.ctrl.close(); srv.closed = true; }
    idle();
    return response;
  };

  w.fetchLog = [];
  w.fetch = async (url, init = {}) => {
    const path = new URL(url).pathname;
    w.fetchLog.push({ path, headers: init.headers ?? {} });
    if (path === '/stream') {
      srv.requests.push(init.headers?.['Last-Event-ID']);
      return open(init, init.headers?.['Last-Event-ID']);
    }
    if (path === '/health' && srv.restarted) {
      srv.healthTries += 1;
      if (srv.healthTries <= healthAfterTries) throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    }
    return health()();
  };
  w.restartUnit = async () => {
    srv.restarts += 1;
    if (restartCode !== 0) return out(restartCode, '', 'Failed to restart');
    srv.restarted = true;
    if (restartEndsStream) { srv.timers = []; try { srv.ctrl.close(); } catch { /* done */ } srv.closed = true; }
    srv.boot = BOOT_B;
    srv.seq = 0;
    if (leaseLostOnRestart) srv.held = null;
    return out(0);
  };

  const base = w.cli;
  w.cli = async args => {
    if (args[0] === 'lease' && args.includes('--id')) {
      w.log.push(args);
      if (leaseRefused) return out(76, '', 'HUB_LOCK_TIMEOUT busy');
      srv.held = args[args.indexOf('--id') + 1];
      changed('lease');
      return out(0, JSON.stringify({ lease_id: srv.held, device: NAME }));
    }
    if (args[0] === 'release' && args[1] === LEASE) {
      w.log.push(args);
      srv.held = null;
      changed('release');
      return out(0, `HUB_DEVICE_RELEASED ${NAME} ${LEASE}\n`);
    }
    return base(args);
  };
  w.runStream = (extra = {}) => w.run({ fetchImpl: w.fetch, stream: true, restartUnit: w.restartUnit, ...extra });
  w.check = (extra = {}) => streamCheck({ tag: NAME, ref: 'v1.2.53', cli: w.cli, fetchImpl: w.fetch, policy, restartUnit: w.restartUnit, now: w.now, sleep: w.sleep, log: line => w.lines.push(line), ...extra });
  return w;
}

const streamLines = w => w.lines.filter(line => /^HUB_SMOKE (stream|restart):/.test(line));

test('stream, happy: /stream opens, a CLI Lease shows in a status frame, a keepalive arrives idle; the line, then retire and the unchanged OK line', async () => {
  const w = streamWorld({ statusAfterMs: 300 });
  const line = await w.runStream();
  assert.equal(line, 'HUB_SMOKE_OK v1.2.53 res-smoke-x leasable after 0 ms');
  assert.deepEqual(streamLines(w), ['HUB_SMOKE stream: status frame 300 ms after the lease, keepalive after 15000 ms idle']);
  assert.ok(w.lines.indexOf(streamLines(w)[0]) > w.lines.findIndex(text => text.startsWith('HUB_SMOKE release:')) && w.lines.indexOf(streamLines(w)[0]) < w.lines.findIndex(text => text.startsWith('HUB_SMOKE retire:')), 'between release and retire');
  assert.deepEqual(verbs(w), ['registry list', 'registry add', 'lease', 'status', 'release', 'lease', 'release', 'registry retire', 'lease', 'status']);
  assert.deepEqual(w.log.find(args => args.includes('--id')), ['lease', NAME, '--no-connect', '--wait', '0', '--for', '2m', '--why', 'hosts:smoke v1.2.53 stream', '--holder', 'hosts:smoke', '--id', LEASE, '--json']);
  assert.deepEqual(w.log.filter(args => args[0] === 'release').at(-1), ['release', LEASE]);
  const stream = w.fetchLog.find(call => call.path === '/stream');
  assert.equal(stream.headers.accept, 'text/event-stream');
  assert.equal(w.fetchLog.filter(call => call.path === '/stream').length, 1, 'one connection without --restart');
  assert.equal(w.srv.restarts, 0, 'the service is not restarted unasked');
  assert.ok(w.srv.closed, 'the stream is closed at the end');
  assert.ok(w.retired && w.srv.held === null);
});

test('stream: false is the 7.9 world: no /stream fetch, no extra lease or release', async () => {
  const w = streamWorld();
  await w.run({ fetchImpl: w.fetch });
  assert.deepEqual(verbs(w), ['registry list', 'registry add', 'lease', 'status', 'release', 'registry retire', 'lease', 'status']);
  assert.ok(w.fetchLog.every(call => call.path === '/health'));
  assert.ok(!w.lines.some(text => /^HUB_SMOKE (stream|restart)/.test(text)));
});

test('stream, an event frame ahead of the status frame is skipped', async () => {
  const w = streamWorld();
  const inner = w.cli;
  w.cli = async args => {
    if (args.includes('--id') && args[0] === 'lease') { w.srv.ctrl.enqueue(encoder.encode(frameText(`${BOOT_A}-9`, 'event', { type: 'event', event_id: 'x' }))); }
    return inner(args);
  };
  assert.match(await w.runStream(), /^HUB_SMOKE_OK /);
  assert.deepEqual(streamLines(w), ['HUB_SMOKE stream: status frame 0 ms after the lease, keepalive after 15000 ms idle']);
});

test('stream, no status frame within 2 s (only event frames): HUB_SMOKE_FAILED stream, the Lease released, the phone retired', async () => {
  const w = streamWorld({ noStatus: true });
  await assert.rejects(w.runStream(), error => error.step === 'stream' && error.message === `HUB_SMOKE_FAILED stream: no status frame showed ${LEASE} within 2 s`);
  assert.ok(w.lines.includes(`HUB_SMOKE cleanup: released ${LEASE}`), 'the Lease is released and logged');
  assert.equal(w.srv.held, null);
  assert.ok(w.retired && w.srv.closed);
});

test('stream, a status frame later than 2 s after the CLI answered is too late, by the fake clock', async () => {
  const w = streamWorld({ statusAfterMs: STATUS_WITHIN_MS + 500 });
  const before = w.clock;
  await assert.rejects(w.runStream(), error => error.message === `HUB_SMOKE_FAILED stream: no status frame showed ${LEASE} within 2 s`);
  assert.ok(w.clock - before <= STATUS_WITHIN_MS + 1000, 'the wait stops at the deadline');
  assert.ok(w.retired && w.srv.held === null);
});

test('stream, a status frame that does not show the Lease (still free) is not the frame: fails, the Lease released, the phone retired', async () => {
  const w = streamWorld({ staleStatus: 'lease' });
  await assert.rejects(w.runStream(), error => error.step === 'stream' && error.message === `HUB_SMOKE_FAILED stream: no status frame showed ${LEASE} within 2 s`);
  assert.ok(w.lines.includes(`HUB_SMOKE cleanup: released ${LEASE}`));
  assert.ok(w.retired && w.srv.held === null);
});

test('stream, a status frame after the release that still shows the Lease is not the frame: fails naming it, the phone retired', async () => {
  const w = streamWorld({ staleStatus: 'release' });
  await assert.rejects(w.runStream(), error => error.step === 'stream' && error.message === `HUB_SMOKE_FAILED stream: no status frame showed ${NAME} without ${LEASE} within 2 s`);
  assert.ok(w.retired && w.srv.held === null);
});

test('stream, a bad opening is named, no Lease is taken, and the phone is retired', async () => {
  for (const [opening, pattern] of [
    ['status503', /^HUB_SMOKE_FAILED stream: \/stream answered 503, not 200/],
    ['type', /content-type application\/json, not text\/event-stream/],
    ['noRetry', /did not open with retry: 3000 \(it sent a ready frame /],
    ['notReady', /opened with a status frame .*, not a ready frame/],
    ['badId', /the ready frame has the id nope, not <boot>-<n>/],
    ['noHosts', /the ready frame carries no status\.hosts document/],
  ]) {
    const w = streamWorld({ opening });
    await assert.rejects(w.runStream(), error => error.step === 'stream' && pattern.test(error.message), opening);
    assert.ok(!w.log.some(args => args.includes('--id')), `${opening}: no Lease was taken`);
    assert.ok(!w.lines.some(text => text.startsWith('HUB_SMOKE cleanup: released')), `${opening}: nothing to release`);
    assert.ok(w.retired, `${opening}: retired`);
  }
});

test('stream, /stream that never answers, or answers nothing, fails within 5 s and a refused connect is named', async () => {
  const w = streamWorld();
  await assert.rejects(w.runStream({ fetchImpl: async url => { if (new URL(url).pathname === '/health') return health()(); throw new Error('connect ECONNREFUSED'); } }), /stream: \/stream did not answer \(connect ECONNREFUSED\)/);
  const v = streamWorld();
  await assert.rejects(v.runStream({ fetchImpl: async url => (new URL(url).pathname === '/health' ? health()() : new Promise(() => {})) }), /stream: \/stream did not answer within 5 s/);
  const x = streamWorld({ silent: true });
  const inner = x.fetch;
  x.fetch = async (url, init) => { const response = await inner(url, init); return new URL(url).pathname === '/stream' ? new Response(new ReadableStream({ start() {} }), { status: 200, headers: response.headers }) : response; };
  await assert.rejects(x.runStream({ fetchImpl: x.fetch }), /stream: \/stream did not open with retry: 3000 \(it sent nothing\)/);
});

test('stream, the Lease is refused by the CLI: fails with what it said, the (unknown) id is released anyway', async () => {
  const w = streamWorld({ leaseRefused: true });
  await assert.rejects(w.runStream(), error => error.step === 'stream' && /^HUB_SMOKE_FAILED stream: the Lease smoke-x-s on smoke-x was refused \(exit 76: HUB_LOCK_TIMEOUT busy\)/.test(error.message));
  assert.ok(w.retired);
});

test('stream, never idle: a frame every 10 s with keepalive 15 s fails after 3 windows, the Lease already released', async () => {
  const w = streamWorld({ neverIdle: true });
  const start = w.clock;
  await assert.rejects(w.runStream(), error => error.step === 'stream' && /^HUB_SMOKE_FAILED stream: the stream was never idle: a frame arrived in each of 3 windows of 20 s/.test(error.message));
  assert.ok(w.clock - start >= 30_000 && w.clock - start < 40_000, `three windows, not more (${w.clock - start} ms)`);
  assert.ok(!w.lines.some(text => text.startsWith('HUB_SMOKE cleanup: released smoke-x-s')), 'already released: nothing to undo');
  assert.ok(w.retired);
});

test('stream, no keepalive and no frame within keepalive + 5 s fails, naming the window', async () => {
  const w = streamWorld({ silent: true });
  const start = w.clock;
  await assert.rejects(w.runStream(), error => error.step === 'stream' && error.message === 'HUB_SMOKE_FAILED stream: no keepalive arrived within 20 s of the last item');
  assert.equal(w.clock - start, 20_000, 'the window is exactly 20 s of the fake clock');
  assert.ok(w.retired);
});

test('stream, a stream that ends under the check fails and releases the Lease', async () => {
  const w = streamWorld({ streamEnds: true });
  await assert.rejects(w.runStream(), error => error.step === 'stream' && /^HUB_SMOKE_FAILED stream: the stream ended while waiting for a status frame that shows smoke-x-s/.test(error.message));
  assert.ok(w.retired && w.srv.held === null);
});

test('restart, happy: the unit restarts, the old stream ends, /health answers again, the Lease is held, the reconnect (Last-Event-ID = last id) gets reset of a new boot', async () => {
  const w = streamWorld();
  const line = await w.runStream({ restart: true });
  assert.match(line, /^HUB_SMOKE_OK /);
  assert.deepEqual(streamLines(w), [
    'HUB_SMOKE stream: status frame 0 ms after the lease, keepalive after 15000 ms idle',
    `HUB_SMOKE restart: ${LEASE} held across the restart; the reconnect got reset (boot ${BOOT_A} -> ${BOOT_B})`,
  ]);
  assert.equal(w.srv.restarts, 1);
  assert.deepEqual(w.srv.requests, [undefined, `${BOOT_A}-1`], 'the second connection resumes from the last frame id seen');
  assert.equal(w.fetchLog.filter(call => call.path === '/health').length, 1 + 2, 'one health at the start, then one refused try and one answer');
  const order = verbs(w);
  assert.deepEqual(order, ['registry list', 'registry add', 'lease', 'status', 'release', 'lease', 'status', 'release', 'registry retire', 'lease', 'status']);
  assert.equal(w.srv.held, null);
  assert.ok(w.retired && w.srv.closed);
});

test('restart, the health retry is one try every 500 ms within 30 s, then it fails and releases the Lease', async () => {
  const w = streamWorld({ healthAfterTries: 1000 });
  const statusReads = () => w.log.filter(args => args[0] === 'status').length;
  const before = w.clock;
  await assert.rejects(w.runStream({ restart: true }), error => error.step === 'restart' && /^HUB_SMOKE_FAILED restart: \/health did not answer as mobile-deploy-hub-api v1\.2\.53, contract 1 within 30 s of the restart \(last: ECONNREFUSED\)/.test(error.message));
  assert.ok(w.clock - before >= RESTART_WITHIN_MS && w.clock - before < RESTART_WITHIN_MS + 2 * TRY_EVERY_MS + 20_000);
  const healthTries = w.fetchLog.filter(call => call.path === '/health').length - 1;
  assert.ok(healthTries > 10 && healthTries <= Math.ceil(RESTART_WITHIN_MS / 500) + 2, `${healthTries} tries`);
  assert.equal(statusReads(), 1, 'only the smoke\'s own listed() read, none after the deadline');
  assert.ok(w.lines.includes(`HUB_SMOKE cleanup: released ${LEASE}`) && w.retired);
});

test('restart, /health that answers another hub_version or contract is not an answer', async () => {
  for (const wrong of [{ hub_version: 'v1.2.52' }, { contract: 2 }, { service: 'x' }, { ok: false }]) {
    const w = streamWorld({ healthAfterTries: 0 });
    const inner = w.fetch;
    let calls = 0;
    w.fetch = async (url, init) => { if (new URL(url).pathname === '/health' && w.srv.restarted) { calls += 1; if (calls <= 2) return health(wrong)(); } return inner(url, init); };
    const line = await w.runStream({ restart: true, fetchImpl: w.fetch });
    assert.match(line, /^HUB_SMOKE_OK /, JSON.stringify(wrong));
    assert.equal(calls, 3);
  }
});

test('restart, the Lease did not survive: HUB_SMOKE_FAILED restart naming what status shows; release attempted, phone retired', async () => {
  const w = streamWorld({ leaseLostOnRestart: true });
  await assert.rejects(w.runStream({ restart: true }), error => error.step === 'restart' && /^HUB_SMOKE_FAILED restart: smoke-x-s did not survive the restart: status shows smoke-x held free/.test(error.message));
  assert.ok(w.lines.includes(`HUB_SMOKE cleanup: released ${LEASE}`) && w.retired);
});

test('restart, the reconnect opens ready, or reset with the same boot: both fail naming it', async () => {
  const ready = streamWorld({ reconnect: 'ready' });
  await assert.rejects(ready.runStream({ restart: true }), error => error.step === 'restart' && new RegExp(`^HUB_SMOKE_FAILED restart: the reconnect opened with a ready frame ${BOOT_B}-0, not a reset frame`).test(error.message));
  assert.ok(ready.retired && ready.srv.held === null);
  const same = streamWorld();
  const inner = same.restartUnit;
  same.restartUnit = async () => { const answer = await inner(); same.srv.boot = BOOT_A; return answer; };
  await assert.rejects(same.runStream({ restart: true, restartUnit: same.restartUnit }), error => error.step === 'restart' && new RegExp(`the reconnect got reset, but its boot is still ${BOOT_A}`).test(error.message));
  assert.ok(same.retired && same.srv.held === null);
});

test('restart, the old stream never ends: fails after 30 s; a systemctl failure fails at once; neither skips the cleanup', async () => {
  const stuck = streamWorld({ restartEndsStream: false, silent: true });
  const before = stuck.clock;
  await assert.rejects(stuck.runStream({ restart: true }), error => error.step === 'restart' && /^HUB_SMOKE_FAILED restart: the old stream did not end within 30 s of the restart/.test(error.message));
  assert.ok(stuck.clock - before >= RESTART_WITHIN_MS);
  assert.ok(stuck.retired && stuck.srv.held === null);
  const broken = streamWorld({ restartCode: 5 });
  await assert.rejects(broken.runStream({ restart: true }), error => error.step === 'restart' && /restarting mobile-deploy-hub-api\.service failed \(exit 5: Failed to restart\)/.test(error.message));
  assert.ok(broken.retired && broken.srv.held === null);
});

test('stream, arguments: restart needs stream, both are booleans; the default seam is never reached by the tests', async () => {
  await assert.rejects(hubSmoke({ ref: 'v1', cli: async () => out(0), restart: true }), TypeError);
  await assert.rejects(hubSmoke({ ref: 'v1', cli: async () => out(0), stream: 'yes' }), TypeError);
  await assert.rejects(hubSmoke({ ref: 'v1', cli: async () => out(0), stream: true, restart: 1 }), TypeError);
  await assert.rejects(streamCheck({ ref: 'v1', cli: async () => out(0) }), TypeError);
  await assert.rejects(streamCheck({ tag: 'x', cli: async () => out(0) }), TypeError);
  await assert.rejects(streamCheck({ tag: 'x', ref: 'v1' }), TypeError);
  await assert.rejects(streamCheck({ tag: 'x', ref: 'v1', cli: async () => out(0), policy: { api: { hub_api_port: 1 } } }), /stream: policy\.api\.stream_keepalive_s/);
});

test('the CLI arguments: the stream phase is on by default, --no-stream skips it, --restart turns the restart on, both together are a usage failure', () => {
  assert.deepEqual(parseSmokeArgs(['--no-stream']), { hubDevice: 'hub-device', ref: undefined, holds: true, stream: false, restart: false, lanes: false });
  assert.deepEqual(parseSmokeArgs(['--restart']), { hubDevice: 'hub-device', ref: undefined, holds: true, stream: true, restart: true, lanes: false });
  assert.deepEqual(parseSmokeArgs(['--no-holds', '--restart', '--ref', 'v1.2.57']), { hubDevice: 'hub-device', ref: 'v1.2.57', holds: false, stream: true, restart: true, lanes: false });
  assert.throws(() => parseSmokeArgs(['--restart', '--no-stream']), /--restart and --no-stream exclude each other/);
  assert.throws(() => parseSmokeArgs(['--no-stream', '--restart']), /exclude each other/);
  assert.throws(() => parseSmokeArgs(['--stream']), /unknown: --stream/);
});

test('runEntry forwards stream and restart to hubSmoke; --restart with --no-stream never reaches it', async () => {
  const calls = [];
  const seams = { smoke: async options => { calls.push(options); }, makeCli: command => `cli:${command}`, defaultRef: () => 'v-default' };
  assert.equal(await runEntry(['--no-stream'], seams), 0);
  assert.equal(await runEntry(['--restart'], seams), 0);
  assert.deepEqual(calls.map(({ stream, restart }) => ({ stream, restart })), [{ stream: false, restart: false }, { stream: true, restart: true }]);
  assert.equal(await runEntry(['--restart', '--no-stream'], seams), 1);
  assert.equal(calls.length, 2, 'a usage failure never reaches hubSmoke');
});

test('the CLI entry: --restart with --no-stream fails with exit 1 and never calls hub-device', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hub-smoke-stream-entry-'));
  try {
    const stub = join(dir, 'stub.mjs');
    const called = join(dir, 'called');
    writeFileSync(stub, `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(called)}, 'yes');\n`);
    const entry = fileURLToPath(new URL('./smoke.mjs', import.meta.url));
    const result = spawnSync(process.execPath, [entry, '--restart', '--no-stream', '--hub-device', `${process.execPath} ${stub}`], { encoding: 'utf8', timeout: 30_000 });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /^HUB_SMOKE_FAILED --restart and --no-stream exclude each other/);
    assert.equal(result.stdout, '');
    assert.throws(() => readFileSync(called), { code: 'ENOENT' }, 'hub-device was never called');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('sseReader reads what the real createStream writes: retry 3000, ready, a status frame, then the keepalive comment, in that order', async () => {
  const intervals = [];
  const timers = { setInterval: callback => { intervals.push(callback); return { unref() {} }; }, clearInterval: () => {} };
  const stream = createStream({ boot: 'abcdef012345', timers, keepaliveMs: 15_000 });
  const written = [];
  const sink = { write: text => { written.push(text); return true; }, on() {}, destroy() {}, writableLength: 0 };
  const opening = { hosts: { linux: { phones: [] } } };
  stream.attach(sink, { kind: 'ready', after: stream.cursor(), status: opening });
  stream.status({ hosts: { linux: { phones: [{ device: NAME, lease_id: null }] } } });
  intervals.at(-1)();
  const body = new ReadableStream({ start(controller) { controller.enqueue(encoder.encode(written.join(''))); controller.close(); } });
  const reader = sseReader(body, { race: work => work, now: () => 0 });
  const items = [];
  for (let index = 0; index < 4; index += 1) items.push(await reader.next(1000));
  assert.deepEqual(items.map(item => item.kind), ['retry', 'frame', 'frame', 'comment']);
  assert.equal(items[0].ms, 3000);
  assert.deepEqual([items[1].type, ID_PATTERN.test(items[1].id), items[1].data.status], ['ready', true, opening]);
  assert.deepEqual([items[2].type, ID_PATTERN.test(items[2].id), items[2].data.status.hosts.linux.phones[0].device], ['status', true, NAME]);
  assert.equal(items[3].text, 'keepalive');
  assert.equal((await reader.next(1000)).kind, 'end');
});

// ---------------------------------------------------------------------------------------------------- Story 9.8: the lanes phase

const LANE_ID = `${NAME}-l-ios-lane`;
const MAC_LANES = host => (host === 'mac' ? [{ device: 'ios-lane', lock: 'mac-ios', words: ['ipad', 'mac'] }] : []);
const jobRow = { lock: 'mac-ios', device: 'ios-lane', kind: 'job', stale: false, lease_id: null, holder: null, repo: 'o/r', run: '1', started_at: '2026-11-26T15:00:00.000Z' };

// A fake pair: `hub-device status --json` on big-chungus (its own phones and `locks`, plus `remote_hosts.mac.view`, the Mac's own), a forwarded
// `lease ios-lane` and `release <id> --resource ios-lane`. The Mac's clock runs `skewMs` ahead of the fake clock; the lane shows after
// `showAfterMs` and frees `freeAfterMs` after the release, each seen at the next 500 ms read.
function laneWorld(knobs = {}) {
  const {
    remote = null, busy = null, waiter = null, leaseAnswer = null, showAfterMs = 0, freeAfterMs = 0, neverShown = false, localWrite = false,
    neverFreed = false, releaseAnswer = null, skewMs = 120, startedAt = undefined, otherId = null, lanes = [{ device: 'ios-lane', lock: 'mac-ios' }],
    shownAs = null, takenAfter = null,
  } = knobs;
  // One state per lane; `srv` is the first lane's (and carries the status reads).
  const by = Object.fromEntries(lanes.map(lane => [lane.device, { held: null, answeredAt: null, releasedAt: null, seen: null }]));
  const srv = Object.assign(by[lanes[0].device], { reads: [], by });
  const view = () => {
    const locks = busy ? [busy] : [];
    for (const lane of lanes) {
      const st = by[lane.device];
      const shownNow = st.held !== null && !neverShown && w.clock >= st.answeredAt + showAfterMs;
      const lingering = st.held === null && st.releasedAt !== null && (neverFreed || w.clock < st.releasedAt + freeAfterMs);
      if (shownNow || lingering) {
        locks.push({ lock: lane.lock, device: lane.device, kind: 'lease', stale: false, lease_id: st.seen, holder: HOLDER_NAME, why: 'x', started_at: startedAt === undefined ? new Date(st.answeredAt + skewMs).toISOString() : startedAt, ...(shownNow ? shownAs ?? {} : {}) });
      } else if (st.held === null && st.releasedAt !== null && takenAfter) locks.push({ ...takenAfter, lock: lane.lock });
    }
    return { phones: [], locks, waiters: waiter ? [waiter] : [], reservations: [] };
  };
  const w = world({
    status: wd => {
      if (srv.answeredAt !== null) srv.reads.push(wd.clock);
      return out(0, JSON.stringify({
        phones: [{ device: 's24' }, ...(wd.registered && !wd.retired ? [{ device: NAME }] : [])],
        locks: localWrite ? Object.values(by).filter(st => st.held !== null).map(st => ({ lock: 'mac-ios', kind: 'lease', lease_id: st.held })) : [],
        waiters: [],
        remote_hosts: remote ?? { mac: { state: 'available', reason: null, view: view(), stale: null } },
      }));
    },
  });
  w.srv = srv;
  const base = w.cli;
  w.cli = async args => {
    if (args[0] === 'lease' && args.includes('--id')) {
      w.log.push(args);
      const refused = leaseAnswer?.(args[1]);
      if (refused) return refused;
      const st = by[args[1]];
      st.held = args[args.indexOf('--id') + 1];
      st.seen = st.held;
      st.answeredAt = w.clock;
      return out(0, JSON.stringify({ lease_id: otherId ?? st.held, device: args[1], holder: 'hosts:smoke', why: 'x', expires_at: 'x', env: {} }));
    }
    if (args[0] === 'release' && args.includes('--resource')) {
      w.log.push(args);
      if (releaseAnswer) return releaseAnswer();
      const st = by[args[args.indexOf('--resource') + 1]];
      st.held = null;
      st.releasedAt = w.clock;
      return out(0, `HUB_DEVICE_RELEASED ${args[args.indexOf('--resource') + 1]} ${args[1]}\n`);
    }
    return base(args);
  };
  w.runLanes = (extra = {}) => w.run({ lanes: true, lanesOf: MAC_LANES, ...extra });
  w.check = (extra = {}) => laneCheck({ tag: NAME, ref: 'v1.2.53', cli: w.cli, lanesOf: MAC_LANES, now: w.now, sleep: w.sleep, log: line => w.lines.push(line), ...extra });
  return w;
}
const HOLDER_NAME = 'hosts:smoke';
const laneCalls = w => w.log.filter(args => args.includes('--id') || args.includes('--resource'));
const laneLines = w => w.lines.filter(line => /^HUB_SMOKE lanes:/.test(line));

test('lanes, happy: the forwarded Lease shows in the Mac view with the Mac clock, nothing local, the release frees it; the line, then retire and the unchanged OK line', async () => {
  const w = laneWorld({ showAfterMs: 800, freeAfterMs: 400 });
  const line = await w.runLanes();
  assert.equal(line, 'HUB_SMOKE_OK v1.2.53 res-smoke-x leasable after 0 ms');
  assert.deepEqual(laneLines(w), [`HUB_SMOKE lanes: ios-lane on mac held as ${LANE_ID} (mac clock started_at ${new Date(w.srv.answeredAt + 120).toISOString()}, 120 ms from this host), shown in 1000 ms, free again in 500 ms`]);
  assert.deepEqual(laneCalls(w), [
    ['lease', 'ios-lane', '--no-connect', '--wait', '0', '--for', '2m', '--id', LANE_ID, '--why', 'hosts:smoke v1.2.53 lanes', '--holder', 'hosts:smoke', '--json'],
    ['release', LANE_ID, '--resource', 'ios-lane'],
  ]);
  assert.deepEqual(verbs(w).filter(verb => verb !== 'status'), ['registry list', 'registry add', 'lease', 'release', 'lease', 'release', 'registry retire', 'lease']);
  const at = text => w.lines.findIndex(entry => entry.startsWith(text));
  assert.ok(at('HUB_SMOKE lanes:') > at('HUB_SMOKE release:') && at('HUB_SMOKE lanes:') < at('HUB_SMOKE retire:'), 'between release and retire');
  assert.equal(w.lines.at(-1), line);
  assert.ok(w.retired && w.srv.held === null);
});

test('lanes: false is the 8.7 world: the exact existing call list, no lane lease and no extra status', async () => {
  const w = laneWorld();
  await w.run({ lanesOf: MAC_LANES });
  assert.deepEqual(verbs(w), ['registry list', 'registry add', 'lease', 'status', 'release', 'registry retire', 'lease', 'status']);
  assert.deepEqual(laneCalls(w), []);
  assert.deepEqual(laneLines(w), []);
});

test('lanes, no other host in status: fails, nothing is taken, the phone is retired', async () => {
  const w = laneWorld({ remote: {} });
  await assert.rejects(w.runLanes(), error => error.step === 'lanes' && /^HUB_SMOKE_FAILED lanes: no other host in status \(run it on big-chungus\)$/.test(error.message));
  assert.deepEqual(laneCalls(w), []);
  assert.ok(w.retired);
  const bare = laneWorld();
  bare.cli = async args => (args[0] === 'status' ? out(0, JSON.stringify({ phones: [] })) : out(0));
  await assert.rejects(bare.check(), /HUB_SMOKE_FAILED lanes: no other host in status/);
});

test('lanes, a spoke with no lane: fails naming the hosts, nothing is taken', async () => {
  const w = laneWorld();
  await assert.rejects(w.runLanes({ lanesOf: () => [] }), error => /^HUB_SMOKE_FAILED lanes: no lane on mac$/.test(error.message));
  assert.deepEqual(laneCalls(w), []);
  assert.ok(w.retired);
});

test('lanes, the Mac is unavailable: fails naming the state and reason, nothing is taken, the phone is retired', async () => {
  const w = laneWorld({ remote: { mac: { state: 'unavailable', reason: 'not-served', view: null, stale: null } } });
  await assert.rejects(w.runLanes(), error => /^HUB_SMOKE_FAILED lanes: mac is unavailable \(not-served\): nothing was taken on ios-lane$/.test(error.message));
  assert.deepEqual(laneCalls(w), []);
  assert.ok(w.retired);
});

test('lanes, the lane is busy (a deploy lock) or has a waiter: fails naming it, nothing is taken, the phone is retired', async () => {
  const busy = laneWorld({ busy: jobRow });
  await assert.rejects(busy.runLanes(), error => /^HUB_SMOKE_FAILED lanes: ios-lane \(mac-ios\) on mac is held \(job by o\/r\): nothing was taken$/.test(error.message));
  assert.deepEqual(laneCalls(busy), []);
  assert.ok(busy.retired);
  const queued = laneWorld({ waiter: { lock: 'mac-ios', device: 'ios-lane', holder: 'deploy-x', lease_id: 'l-9', position: 1 } });
  await assert.rejects(queued.runLanes(), error => /^HUB_SMOKE_FAILED lanes: ios-lane \(mac-ios\) on mac has a waiter \(deploy-x\): nothing was taken$/.test(error.message));
  assert.deepEqual(laneCalls(queued), []);
  assert.ok(queued.retired);
});

test('lanes, the take is refused (the Mac is away): fails with what the CLI said, the id is released anyway and logged, the phone is retired', async () => {
  const w = laneWorld({ leaseAnswer: () => out(75, '', 'HUB_DEVICE_AWAY mac host-unreachable: ssh timed out') });
  await assert.rejects(w.runLanes(), error => /^HUB_SMOKE_FAILED lanes: the Lease smoke-x-l-ios-lane on ios-lane \(mac\) was refused \(exit 75: HUB_DEVICE_AWAY mac host-unreachable/.test(error.message));
  assert.deepEqual(laneCalls(w).map(args => args[0]), ['lease', 'release']);
  assert.deepEqual(laneCalls(w)[1], ['release', LANE_ID, '--resource', 'ios-lane']);
  assert.ok(w.lines.includes(`HUB_SMOKE cleanup: released ${LANE_ID}`));
  assert.ok(w.retired);
});

test('lanes, the CLI answers another lease id: refused, and released', async () => {
  const w = laneWorld({ otherId: 'l-other' });
  await assert.rejects(w.runLanes(), /HUB_SMOKE_FAILED lanes: the Lease smoke-x-l-ios-lane on ios-lane \(mac\) was refused/);
  assert.ok(w.lines.includes(`HUB_SMOKE cleanup: released ${LANE_ID}`));
});

test('lanes, never shown in the Mac view: fails at 10 s by the fake clock, no read after the deadline, released and logged, the phone is retired', async () => {
  const w = laneWorld({ neverShown: true });
  await assert.rejects(w.runLanes(), error => /^HUB_SMOKE_FAILED lanes: ios-lane held as smoke-x-l-ios-lane was not shown in mac's view within 10 s/.test(error.message));
  const from = w.srv.answeredAt;
  assert.ok(w.srv.reads.length > 1 && w.srv.reads.length <= LANE_SHOWS_WITHIN_MS / 500 + 3, 'bounded');
  assert.ok(w.srv.reads.every(at => at < from + LANE_SHOWS_WITHIN_MS), 'no read at or after the deadline');
  assert.ok(w.clock >= from + LANE_SHOWS_WITHIN_MS);
  assert.deepEqual(laneCalls(w).at(-1), ['release', LANE_ID, '--resource', 'ios-lane']);
  assert.ok(w.lines.includes(`HUB_SMOKE cleanup: released ${LANE_ID}`));
  assert.ok(w.retired);
});

test('lanes, shown later than 10 s after the answer is too late; a row without an ISO started_at is not the row', async () => {
  const late = laneWorld({ showAfterMs: 10_000 });
  await assert.rejects(late.runLanes(), /was not shown in mac's view within 10 s/);
  const bad = laneWorld({ startedAt: 'yesterday' });
  await assert.rejects(bad.runLanes(), /was not shown in mac's view within 10 s/);
  const none = laneWorld({ startedAt: null });
  await assert.rejects(none.runLanes(), /was not shown in mac's view within 10 s/);
});

test('lanes, big-chungus wrote the lane lock: fails, released', async () => {
  const w = laneWorld({ localWrite: true });
  await assert.rejects(w.runLanes(), error => /^HUB_SMOKE_FAILED lanes: big-chungus wrote the lane's lock/.test(error.message));
  assert.ok(w.lines.includes(`HUB_SMOKE cleanup: released ${LANE_ID}`));
  assert.ok(w.retired);
});

test('lanes, a release that does not answer HUB_DEVICE_RELEASED fails, and the cleanup releases again (logged, a failure too)', async () => {
  const w = laneWorld({ releaseAnswer: () => out(0, 'HUB_DEVICE_NOT_HELD ios-lane x\n') });
  await assert.rejects(w.runLanes(), /HUB_SMOKE_FAILED lanes: the release of smoke-x-l-ios-lane on ios-lane did not answer HUB_DEVICE_RELEASED/);
  assert.equal(laneCalls(w).filter(args => args[0] === 'release').length, 2);
  assert.ok(w.lines.includes(`HUB_SMOKE cleanup: released ${LANE_ID}`));
  const stuck = laneWorld({ releaseAnswer: () => out(1, '', 'HUB_DEVICE_AWAY mac host-unreachable') });
  await assert.rejects(stuck.runLanes(), /did not answer HUB_DEVICE_RELEASED \(exit 1: HUB_DEVICE_AWAY mac host-unreachable\)/);
  assert.ok(stuck.lines.some(line => line.startsWith(`HUB_SMOKE cleanup: release of ${LANE_ID} failed (exit 1: HUB_DEVICE_AWAY`)));
});

test('lanes, never freed: the row stays for 10 s after the release: fails, no read after the deadline, the id is not released twice', async () => {
  const w = laneWorld({ neverFreed: true });
  await assert.rejects(w.runLanes(), error => /^HUB_SMOKE_FAILED lanes: ios-lane \(mac-ios\) on mac is still held in mac's view 10 s after the release of smoke-x-l-ios-lane$/.test(error.message));
  assert.equal(laneCalls(w).filter(args => args[0] === 'release').length, 1);
  assert.ok(w.srv.reads.at(-1) < w.srv.releasedAt + LANE_SHOWS_WITHIN_MS, 'no read at or after the deadline');
  assert.ok(w.clock >= w.srv.releasedAt + LANE_SHOWS_WITHIN_MS);
  assert.ok(w.retired);
});

test('lanes, a clock that never advances still ends (bounded reads), and a view that goes away never counts as shown or free', async () => {
  const w = laneWorld({ neverShown: true });
  await assert.rejects(w.runLanes({ sleep: async () => {} }), /was not shown in mac's view/);
  assert.ok(w.srv.reads.length <= LANE_SHOWS_WITHIN_MS / 500 + 3);
  const gone = laneWorld();
  gone.cli = (inner => async args => {
    const result = await inner(args);
    if (args[0] !== 'status' || gone.srv.answeredAt === null) return result;
    const body = JSON.parse(result.stdout);
    body.remote_hosts.mac = { state: 'unavailable', reason: 'api-down', view: null, stale: null };
    return out(0, JSON.stringify(body));
  })(gone.cli);
  await assert.rejects(gone.runLanes(), /was not shown in mac's view within 10 s/);
});

test('lanes, a status that gives no document is a failure of lanes', async () => {
  const broken = laneWorld();
  broken.cli = async () => out(1, '', 'HUB_API_DOWN nope');
  await assert.rejects(broken.check(), /HUB_SMOKE_FAILED lanes: status --json gave no document \(exit 1: HUB_API_DOWN nope\)/);
});

test('lanes, the default lanesOf is the seed: the Mac owns the ios-lane (mac-ios)', async () => {
  const w = laneWorld({ remote: { mac: { state: 'unavailable', reason: 'not-served', view: null, stale: null } } });
  await assert.rejects(w.check({ lanesOf: undefined }), /HUB_SMOKE_FAILED lanes: mac is unavailable \(not-served\): nothing was taken on ios-lane$/);
});

test('lanes, arguments are checked: laneCheck wants a tag, a ref, a cli and a lanesOf function; hubSmoke wants a boolean', async () => {
  await assert.rejects(laneCheck({ ref: 'v1', cli: async () => out(0) }), TypeError);
  await assert.rejects(laneCheck({ tag: 'x', cli: async () => out(0) }), TypeError);
  await assert.rejects(laneCheck({ tag: 'x', ref: 'v1' }), TypeError);
  await assert.rejects(laneCheck({ tag: 'x', ref: 'v1', cli: async () => out(0), lanesOf: 'mac' }), TypeError);
  await assert.rejects(hubSmoke({ ref: 'v1', cli: async () => out(0), lanes: 'yes' }), TypeError);
  await assert.rejects(hubSmoke({ ref: 'v1', cli: async () => out(0), lanes: 1 }), TypeError);
});

test('the CLI arguments: --lanes turns the lanes phase on, the default is off, and it combines with the other flags', () => {
  assert.equal(parseSmokeArgs([]).lanes, false);
  assert.equal(parseSmokeArgs(['--lanes']).lanes, true);
  assert.deepEqual(parseSmokeArgs(['--lanes', '--restart', '--no-holds', '--ref', 'v1.2.58']), { hubDevice: 'hub-device', ref: 'v1.2.58', holds: false, stream: true, restart: true, lanes: true });
  assert.throws(() => parseSmokeArgs(['--lane']), /\[--lanes\] \(unknown: --lane\)/);
});

test('runEntry forwards lanes to hubSmoke (false by default)', async () => {
  const calls = [];
  const seams = { smoke: async options => { calls.push(options); }, makeCli: command => `cli:${command}`, defaultRef: () => 'v-default' };
  assert.equal(await runEntry([], seams), 0);
  assert.equal(await runEntry(['--lanes'], seams), 0);
  assert.deepEqual(calls.map(({ lanes }) => lanes), [false, true]);
});

const TWO_LANES = [{ device: 'ios-lane', lock: 'mac-ios' }, { device: 'x-lane', lock: 'mac-x' }];
const TWO_ON_MAC = host => (host === 'mac' ? TWO_LANES.map(lane => ({ ...lane, words: [] })) : []);
const X_ID = `${NAME}-l-x-lane`;

test('lanes, a freed lane that a deploy takes right after the release still passes: only a row with this run\'s id counts as held', async () => {
  const w = laneWorld({ takenAfter: { ...jobRow, device: 'ios-lane' } });
  assert.equal(await w.runLanes(), 'HUB_SMOKE_OK v1.2.53 res-smoke-x leasable after 0 ms');
  assert.equal(laneLines(w).length, 1);
  const other = laneWorld({ takenAfter: { lock: 'mac-ios', device: 'ios-lane', kind: 'lease', lease_id: 'l-someone-else', holder: 'deploy-x', started_at: '2026-11-26T15:00:00.000Z' } });
  await other.runLanes();
  assert.equal(laneLines(other).length, 1);
});

test('lanes, two lanes: both are taken and released in order, two lines, ids per lane', async () => {
  const w = laneWorld({ lanes: TWO_LANES });
  const { lanes } = await w.check({ lanesOf: TWO_ON_MAC });
  assert.deepEqual(lanes.map(({ host, device, id }) => [host, device, id]), [['mac', 'ios-lane', LANE_ID], ['mac', 'x-lane', X_ID]]);
  assert.deepEqual(laneCalls(w).map(args => [args[0], args[0] === 'lease' ? args[args.indexOf('--id') + 1] : args[1], args[1] === 'x-lane' || args.at(-1) === 'x-lane' ? 'x-lane' : 'ios-lane']), [
    ['lease', LANE_ID, 'ios-lane'], ['release', LANE_ID, 'ios-lane'], ['lease', X_ID, 'x-lane'], ['release', X_ID, 'x-lane'],
  ]);
  assert.equal(laneLines(w).length, 2);
  assert.match(laneLines(w)[0], new RegExp(`^HUB_SMOKE lanes: ios-lane on mac held as ${LANE_ID} `));
  assert.match(laneLines(w)[1], new RegExp(`^HUB_SMOKE lanes: x-lane on mac held as ${X_ID} `));
  assert.ok(Object.values(w.srv.by).every(st => st.held === null));
});

test('lanes, lane 2 fails after lane 1 passed: only lane 2\'s id is released by the cleanup, lane 1 is not touched again', async () => {
  const w = laneWorld({ lanes: TWO_LANES, leaseAnswer: device => (device === 'x-lane' ? out(75, '', 'HUB_DEVICE_AWAY mac host-unreachable') : null) });
  await assert.rejects(w.runLanes({ lanesOf: TWO_ON_MAC }), error => new RegExp(`^HUB_SMOKE_FAILED lanes: the Lease ${X_ID} on x-lane \\(mac\\) was refused`).test(error.message));
  assert.equal(laneLines(w).length, 1, 'lane 1 passed');
  const releases = laneCalls(w).filter(args => args[0] === 'release').map(args => args[1]);
  assert.deepEqual(releases, [LANE_ID, X_ID], 'lane 1 once (its own release), then lane 2 by the cleanup');
  assert.deepEqual(w.lines.filter(line => line.startsWith('HUB_SMOKE cleanup: ') && /ios-lane|x-lane/.test(line)), [`HUB_SMOKE cleanup: released ${X_ID}`]);
  assert.ok(w.retired);
});

test('lanes, a foreign row on the lane is not the Lease: another lease id, or a row that is not a lease, with a valid started_at, is never shown', async () => {
  const foreign = laneWorld({ shownAs: { lease_id: 'l-someone-else' } });
  await assert.rejects(foreign.runLanes(), /was not shown in mac's view within 10 s/);
  const job = laneWorld({ shownAs: { kind: 'job' } });
  await assert.rejects(job.runLanes(), /was not shown in mac's view within 10 s/);
  for (const w of [foreign, job]) {
    assert.ok(w.lines.includes(`HUB_SMOKE cleanup: released ${LANE_ID}`));
    assert.ok(w.retired);
  }
});
