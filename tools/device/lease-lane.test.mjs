// Story 9.4: `hub-device lease ipad|mac` takes the Mac's `ios-lane`, from either host. Hermetic: a linux-keyed CLI's transport is a bridge into the Mac Host
// Agent's `handle()` (the public route, the `x-hub-forwarded` header and the carried record cross exactly as over ssh), the Mac has its own temp lock dir, event dir
// and fake clock, the iPad is a fake `devicectl`, and the Mac's own CLI acts in-process. No port, ssh, adb, devicectl or live host is touched.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadDevices } from '../ci/lib/devices.mjs';
import { readEvents } from '../ci/lib/events.mjs';
import { readOwner, queueView, withLock } from '../ci/lib/lock.mjs';
import { loadPolicy } from '../ci/lib/policy.mjs';
import { hermetic } from '../ci/test-fixtures.mjs';
import { FORWARD_HEADER } from '../hub-client.mjs';
import { createKnown } from '../host-agent/known.mjs';
import { AGENT_ROUTES } from '../host-agent/routes.mjs';
import { handle } from '../hub-api/routes.mjs';
import { seed } from '../registry/seed.mjs';
import { fleetOf, hostLanes, isLane, laneEntry, lanesOf, leaseExports, loadFleet, needsDevice, resolve } from './claims.mjs';
import { main } from './hub-device.mjs';

hermetic();

const policy = loadPolicy().policy;
const T0 = Date.parse('2026-11-26T10:00:00Z');
const SKEW = 3_600_000;   // big-chungus' clock runs an hour behind the Mac's: nothing the Mac writes may carry it
const MIN = 60_000;
const HEADER = FORWARD_HEADER.toLowerCase();
const noServer = () => ({ adb_servers: [], emulators: [], xvfb: [] });
const refused = () => Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
const settle = ms => new Promise(done => setTimeout(done, ms));
const fakeTimers = () => ({ setInterval: () => ({ unref() { return this; } }), clearInterval: () => {} });

const ipadDocument = (patch = {}) => {
  const { udid, model } = loadDevices({}).ios;
  return { result: { devices: [{ identifier: 'IPAD', hardwareProperties: { udid, reality: 'physical', productType: model }, connectionProperties: { pairingState: 'paired', tunnelState: 'connected', transportType: 'wired' }, deviceProperties: { name: 'iPad', developerModeStatus: 'enabled', bootState: 'booted', ...patch } }] } };
};
// What the iPad reads as, by the Reachability the test wants.
const IPADS = {
  reachable: () => ipadDocument(),
  offline: () => ipadDocument({ bootState: 'shutdown' }),
  absent: () => ({ result: { devices: [] } }),
  unauthorized: () => ipadDocument({ developerModeStatus: 'disabled' }),
  unknown: () => { throw new Error('devicectl did not answer'); },
};

const responseOf = answer => new Response(answer.body === undefined ? null : JSON.stringify(answer.body), {
  status: answer.status, headers: { 'content-type': answer.status >= 400 ? 'application/problem+json' : 'application/json' },
});

// Two hosts: big-chungus (`linux`, a CLI only) and the Mac (the Host Agent's handle, and the Mac's own CLI), each with its own lock dir, event dir and clock.
function world({ ipad = 'reachable', macUp = true, t0 = T0 } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'lease-lane-'));
  const sideEnv = name => ({ PATH: process.env.PATH, HOME: join(root, name), USER: 'jarad', HUB_LOCK_DIR: join(root, name, 'locks'), HUB_EVENT_DIR: join(root, name, 'events') });
  const linuxEnv = sideEnv('linux');
  const macEnv = sideEnv('mac');
  const devices = structuredClone(loadDevices({}));
  const state = { ipad, macUp };
  const devicectlCalls = [];
  const devicectl = args => { devicectlCalls.push(args); return IPADS[state.ipad](); };
  const macNow = () => t0;
  const known = createKnown({ env: macEnv, devices, qaDevices: () => [] });
  const log = { out: () => {}, err: () => {} };
  const mac = { env: macEnv, policy, routes: AGENT_ROUTES, now: macNow, devices, qaDevices: () => [], hostKey: () => 'mac', known, devicectl, inventory: noServer, log, request: async () => { throw refused(); } };
  const reached = [];
  const linuxCalls = [];
  // The linux CLI's one transport: a call to the Mac is the agent's handle(); a call to the Hub API is recorded (the CLI must never make one) and refused.
  const bridge = async args => {
    if (args.host === 'linux') { linuxCalls.push(args); throw refused(); }
    if (!state.macUp) throw refused();
    reached.push(args);
    return responseOf(await handle({ method: args.method, url: args.path, headers: args.forwarded ? { [HEADER]: args.forwarded } : {}, body: args.body === undefined ? undefined : structuredClone(args.body), signal: args.signal }, mac));
  };
  const run = async (side, argv, { env: more = {}, signals = new EventEmitter() } = {}) => {
    const out = [];
    const err = [];
    const base = side === 'linux' ? linuxEnv : macEnv;
    const code = await main(argv, {
      env: { ...base, ...more }, stdout: line => out.push(line), stderr: line => err.push(line), signals, hostKey: () => side, policy, qaDevices: () => [], devicectl,
      request: side === 'linux' ? bridge : async () => { throw refused(); },
      now: side === 'linux' ? () => t0 - SKEW : macNow, sleep: async () => {},
    });
    return { code, out, err };
  };
  return {
    root, linuxEnv, macEnv, state, reached, linuxCalls, devicectlCalls, mac,
    linux: (argv, more) => run('linux', argv, more),
    macCli: (argv, more) => run('mac', argv, more),
    macLocks: () => existsSync(macEnv.HUB_LOCK_DIR),
    owner: () => readOwner(join(macEnv.HUB_LOCK_DIR, 'mac-ios.lock')),
    events: () => [...readEvents({ env: macEnv })].filter(event => event.lock === 'mac-ios'),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

const TAKE = ['--for', '30m', '--why', 'ipad proof', '--holder', 'jarad'];
const ID = 'l-aaaaaaaaaaaa';

test('AC1: a linux CLI takes the lane through the Mac agent: exports with no ANDROID_*, the lock and the clock are the Mac\'s, and big-chungus writes nothing', async () => {
  const w = world();
  try {
    const r = await w.linux(['lease', 'ipad', ...TAKE, '--id', ID]);
    assert.equal(r.code, 0, r.err.join('\n'));
    assert.deepEqual(r.out, [`export HUB_LEASE_ID='${ID}'`, "export HUB_DEVICE='ios-lane'"]);
    const [sent] = w.reached;
    assert.deepEqual([sent.host, sent.method, sent.path, sent.forwarded], ['mac', 'POST', '/leases', 'cli']);
    assert.deepEqual(sent.body.resource, { id: 'ios-lane', lock: 'mac-ios', host: 'mac', rev: 0, retired_at: null });
    assert.equal(sent.body.require_reachable, true);
    assert.deepEqual([sent.body.for_ms, sent.body.wait_ms, sent.body.why, sent.body.id, sent.body.holder], [30 * MIN, 120_000, 'ipad proof', ID, 'jarad']);
    assert.deepEqual(sent.body.actor, { holder: 'jarad', via: 'cli' });
    const owner = w.owner();
    assert.deepEqual([owner.kind, owner.lease_id, owner.holder, owner.holder_pid], ['lease', ID, 'jarad', null]);
    assert.equal(owner.started_at, new Date(T0).toISOString(), 'the Mac clock');
    assert.equal(owner.expires_at, new Date(T0 + 30 * MIN).toISOString());
    assert.equal(w.events().find(event => event.event === 'acquire').ts, new Date(T0).toISOString());
    assert.equal(existsSync(w.linuxEnv.HUB_LOCK_DIR), false, 'big-chungus has no lock dir');
    assert.equal(existsSync(w.linuxEnv.HUB_EVENT_DIR), false);
    assert.equal(w.linuxCalls.length, 0, 'the CLI never asks the Hub API');
    assert.deepEqual(w.devicectlCalls, [['list', 'devices']], 'the Mac read the iPad once');
  } finally { w.cleanup(); }
});

test('the lane\'s Lease is released from big-chungus by $HUB_LEASE_ID and $HUB_DEVICE, with the same line the Mac prints', async () => {
  const w = world();
  try {
    assert.equal((await w.linux(['lease', 'ipad', ...TAKE, '--id', ID])).code, 0);
    const env = { HUB_LEASE_ID: ID, HUB_DEVICE: 'ios-lane' };
    const extended = await w.linux(['extend', '--for', '10m', '--holder', 'jarad'], { env });
    assert.equal(extended.code, 0, extended.err.join('\n'));
    assert.deepEqual(extended.out, [`HUB_DEVICE_EXTENDED ios-lane ${ID} until ${new Date(T0 + 40 * MIN).toISOString()}`]);
    const released = await w.linux(['release', '--holder', 'jarad'], { env });
    assert.equal(released.code, 0, released.err.join('\n'));
    assert.deepEqual(released.out, [`HUB_DEVICE_RELEASED ios-lane ${ID}`]);
    assert.equal(w.owner(), null);
    assert.equal(existsSync(w.linuxEnv.HUB_LOCK_DIR), false);
    assert.equal(w.events().find(event => event.event === 'release').actor.via, 'cli');
  } finally { w.cleanup(); }
});

test('lease ipad with the iPad not reachable is HUB_DEVICE_AWAY (75): stdout exactly `HUB_DEVICE_AWAY ipad`, the reading as the reason, and nothing is written on either host', async () => {
  for (const state of ['offline', 'absent', 'unauthorized', 'unknown']) {
    const w = world({ ipad: state });
    try {
      const r = await w.linux(['lease', 'ipad', ...TAKE, '--id', ID]);
      assert.equal(r.code, 75, state);
      assert.deepEqual(r.out, ['HUB_DEVICE_AWAY ipad'], state);
      assert.deepEqual(r.err, [`hub-device: ipad is away: ${state}`], state);
      assert.equal(w.reached.length, 1, 'the Mac was asked');
      assert.equal(w.macLocks(), false, state);
      assert.equal(existsSync(w.macEnv.HUB_EVENT_DIR), false, `${state}: not even a request event`);
      assert.equal(existsSync(w.linuxEnv.HUB_LOCK_DIR), false, state);
    } finally { w.cleanup(); }
  }
});

test('lease mac, and lease ipad --no-connect, need only the host: no require_reachable key, devicectl is never called, the iPad may be away', async () => {
  const w = world({ ipad: 'offline' });
  try {
    for (const word of [['lease', 'mac', ...TAKE], ['lease', 'ipad', '--no-connect', ...TAKE]]) {
      const id = `l-${word[1] === 'mac' ? 'b' : 'c'}`.padEnd(14, word[1] === 'mac' ? 'b' : 'c');
      const r = await w.linux([...word, '--id', id]);
      assert.equal(r.code, 0, r.err.join('\n'));
      assert.deepEqual(r.out, [`export HUB_LEASE_ID='${id}'`, "export HUB_DEVICE='ios-lane'"]);
      assert.equal(w.reached.at(-1).body.require_reachable, undefined, word.join(' '));
      assert.equal(Object.hasOwn(w.reached.at(-1).body, 'no-connect'), false);
      assert.equal(w.owner().lease_id, id);
      assert.equal((await w.linux(['release', id, '--resource', 'ios-lane', '--holder', 'jarad'])).code, 0);
    }
    assert.deepEqual(w.devicectlCalls, []);
  } finally { w.cleanup(); }
});

test('--no-connect is still refused on a forwarded phone, and --pid and --env-serial on a lane', async () => {
  const w = world();
  try {
    const phone = await w.macCli(['lease', 's24', '--no-connect', ...TAKE]);
    assert.equal(phone.code, 2);
    assert.match(phone.err.join('\n'), /--no-connect is not forwarded/);
    const lane = await w.linux(['lease', 'ipad', '--pid', '12', ...TAKE]);
    assert.equal(lane.code, 2);
    assert.equal(w.reached.length, 0);
  } finally { w.cleanup(); }
});

test('an asleep Mac is HUB_DEVICE_AWAY (75) with reason host-unreachable and no ticket on either host', async () => {
  const w = world({ macUp: false });
  try {
    const r = await w.linux(['lease', 'ipad', ...TAKE]);
    assert.equal(r.code, 75);
    assert.deepEqual(r.out, ['HUB_DEVICE_AWAY ipad']);
    assert.deepEqual(r.err, ['hub-device: ipad is away: host-unreachable']);
    assert.equal(w.macLocks(), false);
    assert.equal(existsSync(w.linuxEnv.HUB_LOCK_DIR), false);
    assert.equal(w.linuxCalls.length, 0, 'the Hub API is not asked');
  } finally { w.cleanup(); }
});

test('--for over the 60 min cap exits 2 naming the cap before anything is sent, on either host', async () => {
  const w = world();
  try {
    for (const word of ['ipad', 'mac']) {
      const r = await w.linux(['lease', word, '--for', '2h', '--why', 'x']);
      assert.equal(r.code, 2, word);
      assert.match(r.err.join('\n'), /^hub-device: --for 2h: a lease on mac-ios runs at most 60 min /, word);
    }
    assert.equal(w.reached.length, 0, 'nothing was sent');
    const mac = await w.macCli(['lease', 'ipad', '--for', '2h', '--why', 'x']);
    assert.equal(mac.code, 2);
    assert.match(mac.err.join('\n'), /^hub-device: --for 2h: a lease on mac-ios runs at most 60 min /);
    assert.equal(w.macLocks(), false);
    assert.deepEqual(w.devicectlCalls, []);
  } finally { w.cleanup(); }
});

test('the Mac\'s own CLI takes, finds and releases the lane in-process: the local lines and exits, with the iPad gate on `ipad` only', async () => {
  const w = world();
  try {
    const taken = await w.macCli(['lease', 'ipad', ...TAKE, '--id', ID]);
    assert.equal(taken.code, 0, taken.err.join('\n'));
    assert.deepEqual(taken.out, [`export HUB_LEASE_ID='${ID}'`, "export HUB_DEVICE='ios-lane'"], 'no ANDROID_* key');
    assert.equal(w.owner().started_at, new Date(T0).toISOString());
    assert.equal(w.reached.length, 0);
    assert.equal(existsSync(w.linuxEnv.HUB_LOCK_DIR), false);

    const busy = await w.macCli(['lease', 'ipad', ...TAKE, '--wait', '0']);
    assert.equal(busy.code, 76);
    assert.match(busy.err.join('\n'), /^HUB_DEVICE_BUSY ipad host lock mac-ios is held by lease /);
    assert.deepEqual(busy.out, []);

    const env = { HUB_LEASE_ID: ID, HUB_DEVICE: 'ios-lane' };
    const any = await w.macCli(['release', '--any', '--holder', 'jarad']);
    assert.deepEqual(any.out, ['HUB_DEVICE_NOT_HELD phone - (no phone is held)'], '--any never frees a lane');
    assert.equal(w.owner().lease_id, ID);
    const extended = await w.macCli(['extend', '--for', '10m'], { env });
    assert.deepEqual(extended.out, [`HUB_DEVICE_EXTENDED ios-lane ${ID} until ${new Date(T0 + 40 * MIN).toISOString()}`]);
    const released = await w.macCli(['release'], { env });
    assert.equal(released.code, 0, released.err.join('\n'));
    assert.deepEqual(released.out, [`HUB_DEVICE_RELEASED ios-lane ${ID}`]);
    assert.equal(w.owner(), null);

    // `ipad` needs the iPad: offline is 75 with exactly one stdout line; `mac` never reads it.
    w.state.ipad = 'offline';
    w.devicectlCalls.length = 0;
    const away = await w.macCli(['lease', 'ipad', ...TAKE]);
    assert.equal(away.code, 75);
    assert.deepEqual(away.out, ['HUB_DEVICE_AWAY ipad']);
    assert.deepEqual(away.err, ['hub-device: ipad is away: offline']);
    assert.equal(w.owner(), null);
    assert.equal(w.devicectlCalls.length, 1);
    w.devicectlCalls.length = 0;
    const mac = await w.macCli(['lease', 'mac', ...TAKE, '--id', 'l-dddddddddddd']);
    assert.equal(mac.code, 0, mac.err.join('\n'));
    assert.equal(w.owner().lease_id, 'l-dddddddddddd');
    assert.deepEqual(w.devicectlCalls, [], 'lease mac needs only the host');
  } finally { w.cleanup(); }
});

const PROBE = "require('node:fs').writeFileSync(process.argv[1], JSON.stringify({ env: process.env, held: require('node:fs').existsSync(process.argv[2]) }))";

test('the Mac\'s own `run ipad|mac -- <cmd>`: ipad needs the iPad, the child gets HUB_DEVICE and no ANDROID_*, and the lock is released after', async () => {
  const w = world({ ipad: 'offline' });
  try {
    const out = join(w.root, 'child.json');
    const lockFile = join(w.macEnv.HUB_LOCK_DIR, 'mac-ios.lock');
    const argv = word => ['run', word, '--for', '10m', '--why', 'run proof', '--holder', 'jarad', '--', process.execPath, '-e', PROBE, out, lockFile];
    const away = await w.macCli(argv('ipad'));
    assert.equal(away.code, 75);
    assert.deepEqual(away.out, ['HUB_DEVICE_AWAY ipad']);
    assert.equal(w.macLocks(), false, 'no lock was written');
    assert.equal(existsSync(out), false, 'the child never ran');

    w.state.ipad = 'reachable';
    const ran = await w.macCli(argv('ipad'));
    assert.equal(ran.code, 0, ran.err.join('\n'));
    const seen = JSON.parse(readFileSync(out, 'utf8'));
    assert.equal(seen.env.HUB_DEVICE, 'ios-lane');
    assert.ok(seen.env.HUB_LEASE_ID);
    assert.deepEqual(Object.keys(seen.env).filter(key => key.startsWith('ANDROID_')), []);
    assert.equal(seen.held, true, 'the lane was held while the child ran');
    assert.equal(w.owner(), null, 'and released afterwards');

    w.state.ipad = 'offline';
    w.devicectlCalls.length = 0;
    rmSync(out);
    const mac = await w.macCli(argv('mac'));
    assert.equal(mac.code, 0, mac.err.join('\n'));
    assert.equal(JSON.parse(readFileSync(out, 'utf8')).env.HUB_DEVICE, 'ios-lane');
    assert.deepEqual(w.devicectlCalls, [], 'run mac needs only the host');
  } finally { w.cleanup(); }
});

test('the Mac agent finds a lane Lease by its id with no Resource named: GET /leases/{id}, extend and release', async () => {
  const w = world();
  try {
    const taken = await handle({ method: 'POST', url: '/leases', body: { resource: 'ipad', for_ms: 30 * MIN, why: 'x', holder: 'jarad', id: ID } }, w.mac);
    assert.equal(taken.status, 200, JSON.stringify(taken.body));
    const read = await handle({ method: 'GET', url: `/leases/${ID}` }, w.mac);
    assert.equal(read.status, 200, JSON.stringify(read.body));
    assert.equal(read.body.lock, 'mac-ios');
    const extended = await handle({ method: 'POST', url: `/leases/${ID}/extend`, body: { for_ms: 5 * MIN, holder: 'jarad' } }, w.mac);
    assert.equal(extended.status, 200, JSON.stringify(extended.body));
    const released = await handle({ method: 'POST', url: `/leases/${ID}/release`, body: { holder: 'jarad' } }, w.mac);
    assert.equal(released.status, 200, JSON.stringify(released.body));
    assert.equal(released.body.outcome, 'released');
    assert.equal(w.owner(), null);
  } finally { w.cleanup(); }
});

test('AC2: a Lease taken from big-chungus, an iOS job and the iPad catch-up share one mac-ios FIFO on the Mac, served in arrival order after the release', async () => {
  const w = world({ t0: Date.now() });
  try {
    assert.equal((await w.linux(['lease', 'ipad', ...TAKE, '--id', ID])).code, 0);
    const served = [];
    const wants = (kind, job) => withLock('mac-ios', async () => { served.push(`${kind}:${job}`); }, {
      env: { ...w.macEnv, GITHUB_REPOSITORY: 'delorenj/example', GITHUB_RUN_ID: '9', GITHUB_RUN_ATTEMPT: '1', GITHUB_JOB: job }, log: () => {}, kind, pollMs: 5, timeoutMs: 10_000, timers: fakeTimers(),
    });
    const waiting = [];
    for (const [kind, job] of [['job', 'ios'], ['hub-job', 'catchup']]) { waiting.push(wants(kind, job)); await settle(30); }
    assert.deepEqual(queueView('mac-ios', { env: w.macEnv }).map(entry => [entry.place, entry.kind, entry.job]), [[1, 'job', 'ios'], [2, 'hub-job', 'catchup']]);
    const released = await w.linux(['release', ID, '--resource', 'ios-lane', '--holder', 'jarad']);
    assert.equal(released.code, 0, released.err.join('\n'));
    await Promise.all(waiting);
    assert.deepEqual(served, ['job:ios', 'hub-job:catchup']);
    assert.deepEqual(queueView('mac-ios', { env: w.macEnv }), []);
    assert.equal(existsSync(w.linuxEnv.HUB_LOCK_DIR), false);
  } finally { w.cleanup(); }
});

// ---- the Claims library's lane rules ----

const devices = structuredClone(loadDevices({}));
const records = seed(devices, { qaDevices: () => [] }).resources;
const lane = records.find(record => record.id === 'ios-lane');

test('a lane is a fleet entry of its own host: laneEntry, lanesOf, hostLanes, isLane', () => {
  const entry = laneEntry(lane);
  assert.deepEqual(entry, { device: 'ios-lane', lock: 'mac-ios', deploy: true, name: lane.display_name, serial: null, model: lane.identity.model, kind: 'ios-lane', words: ['ipad', 'mac'] });
  assert.equal(isLane(entry), true);
  assert.equal(isLane(lane), true);
  assert.equal(isLane(fleetOf(devices)[0]), false, 'a phone is not a lane');
  assert.deepEqual(lanesOf(records, 'mac'), [entry]);
  assert.deepEqual(lanesOf(records, 'linux'), []);
  assert.deepEqual(hostLanes('mac', { env: {} }), [entry]);
  assert.deepEqual([hostLanes('linux', { env: {} }), hostLanes(null, { env: {} })], [[], []]);
  // A record the Registry served has no words and no deploy flag: the cap still comes from the policy.
  assert.equal(laneEntry({ id: 'ios-lane', lock: 'mac-ios', kind: 'ios-lane' }, policy).deploy, true);
});

test('resolve finds a lane by its words after ids and names; needsDevice is true only for a lane\'s device word without --no-connect', () => {
  const fleet = [...fleetOf(devices), laneEntry(lane)];
  for (const word of ['ipad', 'mac', 'ios-lane']) assert.equal(resolve(word, { fleet, ids: false }).entry.lock, 'mac-ios', word);
  assert.throws(() => resolve('ipad', { fleet: fleetOf(devices), ids: false }), /unknown device "ipad"/);
  const entry = resolve('ipad', { fleet, ids: false }).entry;
  assert.equal(needsDevice('ipad', entry), true);
  assert.equal(needsDevice('ipad', entry, { noConnect: true }), false);
  assert.equal(needsDevice('mac', entry), false);
  assert.equal(needsDevice('ios-lane', entry), false);
  assert.equal(needsDevice('s24', fleetOf(devices)[0]), false);
});

test('a lane\'s exports are the lease id and the device and nothing of adb', () => {
  const taken = { kind: 'phone', phone: laneEntry(lane), lease: { lease_id: ID }, device: { phone: 'ios-lane', serial: null, adb_id: null, adb_port: 5037 } };
  assert.deepEqual(leaseExports(taken), { HUB_LEASE_ID: ID, HUB_DEVICE: 'ios-lane' });
  assert.deepEqual(Object.keys(leaseExports({ ...taken, phone: fleetOf(devices)[0] })), ['HUB_LEASE_ID', 'HUB_DEVICE', 'ANDROID_ADB_SERVER_PORT']);
  assert.equal(loadFleet({ HUB_LOCK_DIR: join(tmpdir(), 'no-such-lock-dir') }).some(isLane), false, 'the loaded fleet holds only phones; Hold verbs add the host\'s lanes');
});
