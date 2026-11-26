// Story 9.3: the Hub API and the Host Agent forward Hold actions to each other, hermetic. Each side is a `handle()` over its own temp lock and event dir,
// and each one's transport (`ctx.request`) is a bridge into the other's `handle()`, so a forward crosses exactly as it would over ssh: the public route,
// the `x-hub-forwarded` header and the carried record, and the far side's answer comes back as a Response. No port, ssh, adb or live host is touched.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadDevices } from '../ci/lib/devices.mjs';
import { readEvents } from '../ci/lib/events.mjs';
import { loadPolicy } from '../ci/lib/policy.mjs';
import { hermetic } from '../ci/test-fixtures.mjs';
import { FORWARD_HEADER } from '../hub-client.mjs';
import { createKnown } from '../host-agent/known.mjs';
import { AGENT_ROUTES } from '../host-agent/routes.mjs';
import { ROUTES, handle } from './routes.mjs';

hermetic();

const policy = loadPolicy().policy;
const T0 = Date.parse('2026-11-26T10:00:00Z');
const MIN = 60_000;
const HEADER = FORWARD_HEADER.toLowerCase();
const noServer = () => ({ adb_servers: [], emulators: [], xvfb: [] });
const problemOf = answer => [answer.status, answer.body.code, answer.body.exit, answer.body.reason];

// An answer of `handle()` as the Response a transport gives back.
const responseOf = answer => new Response(answer.body === undefined ? null : JSON.stringify(answer.body), {
  status: answer.status, headers: { 'content-type': answer.status >= 400 ? 'application/problem+json' : 'application/json' },
});

// Two hosts side by side: `linux` (the Hub API on big-chungus) and `mac` (the Host Agent), each with its own lock dir, event dir and clock.
function world({ macUp = true, apiUp = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'forward-'));
  const devices = structuredClone(loadDevices({}));
  const sideEnv = name => ({ PATH: process.env.PATH, HOME: join(root, name), HUB_LOCK_DIR: join(root, name, 'locks'), HUB_EVENT_DIR: join(root, name, 'events') });
  const linuxEnv = sideEnv('linux');
  const macEnv = sideEnv('mac');
  const log = { out: () => {}, err: () => {} };
  const reachedMac = [];
  const reachedLinux = [];
  const state = { macUp, apiUp };
  const known = createKnown({ env: macEnv, devices, qaDevices: () => [] });
  const base = { policy, now: () => T0, devices, qaDevices: () => [], log };
  const linux = { ...base, env: linuxEnv, routes: ROUTES, hostId: 'linux-host', hostKey: () => 'linux' };
  const mac = { ...base, env: macEnv, routes: AGENT_ROUTES, hostKey: () => 'mac', known, devicectl: () => ({ result: { devices: [] } }), inventory: noServer };
  // linux -> mac: the Host Agent's handle; mac -> linux: the Hub API's.
  linux.request = async args => {
    if (!state.macUp) throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    reachedMac.push(args);
    return responseOf(await handle({ method: args.method, url: args.path, headers: args.forwarded ? { [HEADER]: args.forwarded } : {}, body: args.body === undefined ? undefined : structuredClone(args.body), signal: args.signal }, mac));
  };
  mac.request = async args => {
    if (!state.apiUp) throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    reachedLinux.push(args);
    return responseOf(await handle({ method: args.method, url: args.path, headers: args.forwarded ? { [HEADER]: args.forwarded } : {}, body: args.body === undefined ? undefined : structuredClone(args.body), signal: args.signal }, linux));
  };
  const post = (side, url, body, headers = {}) => handle({ method: 'POST', url, body, headers }, side);
  return {
    root, linux, mac, known, state, reachedMac, reachedLinux,
    // Public requests to either front door, and forwards sent straight to one.
    api: (url, body) => post(linux, url, body),
    apiGet: url => handle({ method: 'GET', url }, linux),
    agent: (url, body) => post(mac, url, body),
    forwardToApi: (url, body, door = 'cli') => post(linux, url, body, { [HEADER]: door }),
    forwardToAgent: (url, body, door = 'api') => post(mac, url, body, { [HEADER]: door }),
    lock: (side, name) => existsSync(join(side.env.HUB_LOCK_DIR, `${name}.lock`)),
    events: (side, name) => [...readEvents({ env: side.env })].filter(event => event.event === name),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

const LEASE = { for_ms: 30 * MIN, holder: 'jarad@big-chungus', why: 'ipad proof' };

test('AC1: a linux Hub API forwards an iPad take and release to the Mac agent; the lock is written on the Mac only', async () => {
  const w = world();
  try {
    const taken = await w.api('/leases', { ...LEASE, resource: 'ipad', id: 'l-aaaaaaaaaaaa' });
    assert.equal(taken.status, 200, JSON.stringify(taken.body));
    assert.equal(taken.body.lease_id, 'l-aaaaaaaaaaaa');
    assert.equal(taken.body.lock, 'mac-ios');
    const seen = w.reachedMac[0];
    assert.deepEqual([seen.host, seen.method, seen.path, seen.forwarded], ['mac', 'POST', '/leases', 'api']);
    assert.deepEqual(seen.body.resource, { id: 'ios-lane', lock: 'mac-ios', host: 'mac', rev: 0, retired_at: null });
    assert.deepEqual(seen.body.actor, { holder: 'jarad@big-chungus', via: 'api' });
    assert.equal(w.lock(w.mac, 'mac-ios'), true, 'the Mac\'s lock dir holds mac-ios');
    assert.equal(w.lock(w.linux, 'mac-ios'), false, 'the Hub API\'s lock dir never does');
    assert.equal(existsSync(w.linux.env.HUB_LOCK_DIR), false, 'big-chungus wrote nothing');

    const released = await w.api('/leases/l-aaaaaaaaaaaa/release', { holder: 'jarad@big-chungus', resource: 'ios-lane' });
    assert.equal(released.status, 200, JSON.stringify(released.body));
    assert.equal(released.body.outcome, 'released');
    assert.equal(w.reachedMac[1].forwarded, 'api');
    assert.equal(w.lock(w.mac, 'mac-ios'), false);
    assert.equal(existsSync(w.linux.env.HUB_LOCK_DIR), false);
    const release = w.events(w.mac, 'release')[0];
    assert.equal(release.actor.via, 'api', 'the actor the Hub API set rides to the Mac\'s event');
  } finally { w.cleanup(); }
});

test('the Hub API forwards require_reachable to the Mac agent, which reads the iPad: offline is 503 HUB_DEVICE_AWAY with reason offline and nothing written; reachable takes mac-ios', async () => {
  const w = world();
  try {
    const { udid, model } = loadDevices({}).ios;
    const ipad = bootState => ({ result: { devices: [{ identifier: 'IPAD', hardwareProperties: { udid, reality: 'physical', productType: model }, connectionProperties: { pairingState: 'paired', tunnelState: 'connected', transportType: 'wired' }, deviceProperties: { name: 'iPad', developerModeStatus: 'enabled', bootState } }] } });
    w.mac.devicectl = () => ipad('shutdown');
    const away = await w.api('/leases', { ...LEASE, resource: 'ipad', id: 'l-vvvvvvvvvvvv', require_reachable: true });
    assert.deepEqual(problemOf(away), [503, 'HUB_DEVICE_AWAY', 75, 'offline']);
    assert.equal(w.reachedMac[0].body.require_reachable, true);
    assert.equal(w.reachedMac[0].forwarded, 'api');
    assert.equal(existsSync(w.mac.env.HUB_LOCK_DIR), false, 'nothing written on the Mac');
    assert.equal(existsSync(w.linux.env.HUB_LOCK_DIR), false);
    assert.equal(w.events(w.mac, 'acquire').length, 0);

    w.mac.devicectl = () => ipad('booted');
    const taken = await w.api('/leases', { ...LEASE, resource: 'ipad', id: 'l-vvvvvvvvvvvv', require_reachable: true });
    assert.equal(taken.status, 200, JSON.stringify(taken.body));
    assert.equal(w.lock(w.mac, 'mac-ios'), true);
    assert.equal(existsSync(w.linux.env.HUB_LOCK_DIR), false);
  } finally { w.cleanup(); }
});

test('the same forwarded id and holder twice: one acquire event, both answers name the same lease_id', async () => {
  const w = world();
  try {
    const body = { ...LEASE, resource: 'ipad', id: 'l-bbbbbbbbbbbb' };
    const first = await w.api('/leases', body);
    const second = await w.api('/leases', body);
    assert.equal(first.status, 200);
    assert.equal(second.status, 200, JSON.stringify(second.body));
    assert.equal(first.body.lease_id, second.body.lease_id);
    assert.equal(w.events(w.mac, 'acquire').length, 1, 'a retried forward takes no second Lease');
  } finally { w.cleanup(); }
});

test('a forward with no client id gets one minted by the forwarder, so the far side can always be asked again', async () => {
  const w = world();
  try {
    const taken = await w.api('/leases', { ...LEASE, resource: 'ipad' });
    assert.equal(taken.status, 200, JSON.stringify(taken.body));
    assert.match(w.reachedMac[0].body.id, /^l-[0-9a-f]{12}$/);
    assert.equal(taken.body.lease_id, w.reachedMac[0].body.id);
  } finally { w.cleanup(); }
});

test('every forwardable Hold route on the Hub API reaches the Mac: read, extend, release, force-release and cancel carry the door and the record', async () => {
  const w = world();
  try {
    await w.api('/leases', { ...LEASE, resource: 'ipad', id: 'l-cccccccccccc' });
    const extended = await w.api('/leases/l-cccccccccccc/extend', { for_ms: 10 * MIN, holder: 'jarad', resource: 'ios-lane' });
    assert.equal(extended.status, 200, JSON.stringify(extended.body));
    assert.equal(extended.body.lock, 'mac-ios');
    assert.deepEqual(w.reachedMac.at(-1).body.resource, { id: 'ios-lane', lock: 'mac-ios', host: 'mac', rev: 0, retired_at: null });

    const cancelled = await w.api('/requests/r-1/cancel', { resource: 'ios-lane', holder: 'ops' });
    assert.deepEqual(problemOf(cancelled).slice(0, 2), [404, 'HUB_REQUEST_NOT_FOUND'], 'the Mac\'s problem is relayed as it came');
    assert.deepEqual([w.reachedMac.at(-1).body.host, w.reachedMac.at(-1).forwarded], ['mac', 'api']);

    const forced = await w.api('/leases/l-cccccccccccc/force-release', { why: 'stuck', holder: 'ops', resource: 'ios-lane' });
    assert.equal(forced.status, 200, JSON.stringify(forced.body));
    assert.equal(forced.body.outcome, 'force-released');
    assert.equal(w.lock(w.mac, 'mac-ios'), false);
    assert.equal(existsSync(w.linux.env.HUB_LOCK_DIR), false, 'nothing was ever written on big-chungus');
    assert.equal(w.events(w.mac, 'force-release')[0].actor.via, 'api');

    // A Lease id with no Resource named runs here, as it always did: no forward.
    const before = w.reachedMac.length;
    const local = await w.apiGet('/leases/l-cccccccccccc');
    assert.equal(w.reachedMac.length, before, 'a GET names nothing: it is answered here');
    assert.equal(local.status, 404);
  } finally { w.cleanup(); }
});

test('a Mac that does not answer is 503 HUB_DEVICE_AWAY (exit 75, host-unreachable) and nothing is written', async () => {
  const w = world({ macUp: false });
  try {
    const answer = await w.api('/leases', { ...LEASE, resource: 'ipad', id: 'l-dddddddddddd' });
    assert.deepEqual(problemOf(answer), [503, 'HUB_DEVICE_AWAY', 75, 'host-unreachable']);
    assert.equal(existsSync(w.linux.env.HUB_LOCK_DIR), false);
    assert.equal(existsSync(w.mac.env.HUB_LOCK_DIR), false);
  } finally { w.cleanup(); }
});

test('a Resource on this host is never forwarded: the Hub API takes a phone itself, the Mac agent takes the iPad itself', async () => {
  const w = world();
  try {
    const phone = await w.api('/leases', { ...LEASE, resource: 's24', id: 'l-eeeeeeeeeeee' });
    assert.equal(phone.status, 200, JSON.stringify(phone.body));
    assert.equal(w.lock(w.linux, 's24'), true);
    const ipad = await w.agent('/leases', { ...LEASE, resource: 'ipad', id: 'l-ffffffffffff' });
    assert.equal(ipad.status, 200, JSON.stringify(ipad.body));
    assert.equal(w.lock(w.mac, 'mac-ios'), true);
    assert.deepEqual([w.reachedMac.length, w.reachedLinux.filter(args => args.method === 'POST').length], [0, 0], 'no forward (the agent only refreshed its view)');
  } finally { w.cleanup(); }
});

test('big-chungus re-resolves a carried record by its id: a lying lock is replaced by the real one', async () => {
  const w = world();
  try {
    const lying = { id: 's24', lock: 'mac-ios', host: 'linux', rev: 99, retired_at: null };
    const taken = await w.forwardToApi('/leases', { ...LEASE, resource: lying, id: 'l-gggggggggggg' }, 'host-agent');
    assert.equal(taken.status, 200, JSON.stringify(taken.body));
    assert.equal(taken.body.lock, 's24', 'it acted on what the Registry says, not on what it was told');
    assert.equal(w.lock(w.linux, 's24'), true);
    assert.equal(w.lock(w.linux, 'mac-ios'), false);
  } finally { w.cleanup(); }
});

test('a misplaced forward is HUB_WRONG_HOST on either side, nothing is written, and it is never re-forwarded', async () => {
  const w = world();
  try {
    const ios = { id: 'ios-lane', lock: 'mac-ios', host: 'mac', rev: 1, retired_at: null };
    const s24 = { id: 's24', lock: 's24', host: 'linux', rev: 1, retired_at: null };
    const onApi = await w.forwardToApi('/leases', { ...LEASE, resource: ios, id: 'l-hhhhhhhhhhhh' });
    assert.deepEqual(problemOf(onApi), [409, 'HUB_WRONG_HOST', 2, 'wrong-host']);
    const wordOnApi = await w.forwardToApi('/leases', { ...LEASE, resource: 'ipad', id: 'l-hhhhhhhhhhhi' });
    assert.deepEqual(problemOf(wordOnApi), [409, 'HUB_WRONG_HOST', 2, 'wrong-host'], 'a word that lives elsewhere is as misplaced as a record');
    const onAgent = await w.forwardToAgent('/leases', { ...LEASE, resource: s24, id: 'l-iiiiiiiiiiii' });
    assert.deepEqual(problemOf(onAgent), [409, 'HUB_WRONG_HOST', 2, 'wrong-host']);
    assert.deepEqual([w.reachedMac.length, w.reachedLinux.length], [0, 0], 'no re-forward');
    assert.equal(existsSync(w.linux.env.HUB_LOCK_DIR) || existsSync(w.mac.env.HUB_LOCK_DIR), false);
  } finally { w.cleanup(); }
});

test('agent rows: a carried lock is acted on; rev 0 for a Resource its seed lacks is 400 unseeded; a retired take is 409', async () => {
  const w = world();
  try {
    const ios = { id: 'ios-lane', lock: 'mac-ios', host: 'mac', rev: 4, retired_at: null };
    const taken = await w.forwardToAgent('/leases', { ...LEASE, resource: ios, id: 'l-jjjjjjjjjjjj' });
    assert.equal(taken.status, 200, JSON.stringify(taken.body));
    assert.equal(w.lock(w.mac, 'mac-ios'), true);
    const unseeded = await w.forwardToAgent('/leases', { ...LEASE, resource: { id: 'pixel', lock: 'pixel', host: 'mac', rev: 0, retired_at: null }, id: 'l-kkkkkkkkkkkk' });
    assert.deepEqual([unseeded.status, unseeded.body.code, unseeded.body.reason], [400, 'HUB_USAGE', 'unseeded']);
    const retired = await w.forwardToAgent('/leases', { ...LEASE, resource: { ...ios, retired_at: '2026-11-01T00:00:00Z' }, id: 'l-llllllllllll' });
    assert.deepEqual([retired.status, retired.body.code], [409, 'HUB_RESOURCE_RETIRED']);
    const extended = await w.forwardToAgent('/leases/l-jjjjjjjjjjjj/extend', { for_ms: 5 * MIN, holder: 'jarad', resource: ios });
    assert.equal(extended.status, 200, JSON.stringify(extended.body));
    const released = await w.forwardToAgent('/leases/l-jjjjjjjjjjjj/release', { holder: 'jarad', resource: ios });
    assert.equal(released.body.outcome, 'released');
    assert.equal(w.lock(w.mac, 'mac-ios'), false);
  } finally { w.cleanup(); }
});

test('the Mac agent forwards a phone take to the Hub API after refreshing its view through the same transport; the Hub API\'s rev is what it carries', async () => {
  const w = world();
  try {
    const taken = await w.agent('/leases', { ...LEASE, resource: 's24', id: 'l-mmmmmmmmmmmm' });
    assert.equal(taken.status, 200, JSON.stringify(taken.body));
    assert.deepEqual(w.reachedLinux.map(args => [args.method, args.path, args.forwarded]), [['GET', '/resources', undefined], ['POST', '/leases', 'host-agent']]);
    const carriedRecord = w.reachedLinux[1].body.resource;
    assert.deepEqual([carriedRecord.id, carriedRecord.lock, carriedRecord.host], ['s24', 's24', 'linux']);
    assert.ok(Number.isInteger(carriedRecord.rev));
    assert.equal(w.reachedLinux[1].body.actor.via, 'host-agent');
    assert.equal(w.lock(w.linux, 's24'), true, 'the lock is on big-chungus');
    assert.equal(w.lock(w.mac, 's24'), false, 'and not on the Mac');
  } finally { w.cleanup(); }
});

test('with the Hub API down the Mac agent resolves from its seed and forwards with rev 0; the far side still acts, and an unreachable one is AWAY', async () => {
  const w = world({ apiUp: false });
  try {
    const away = await w.agent('/leases', { ...LEASE, resource: 's24', id: 'l-nnnnnnnnnnnn' });
    assert.deepEqual(problemOf(away), [503, 'HUB_DEVICE_AWAY', 75, 'host-unreachable']);
    // The same view with a Hub API that answers only the forward (not the refresh).
    w.state.apiUp = true;
    const original = w.mac.request;
    w.mac.request = async args => (args.path === '/resources' ? Promise.reject(new TypeError('fetch failed')) : original(args));
    const taken = await w.agent('/leases', { ...LEASE, resource: 's24', id: 'l-oooooooooooo' });
    assert.equal(taken.status, 200, JSON.stringify(taken.body));
    assert.equal(w.reachedLinux.at(-1).body.resource.rev, 0);
    assert.equal(w.lock(w.linux, 's24'), true);
  } finally { w.cleanup(); }
});

test('a Pool cancel from the Mac carries pool and host; the Hub API\'s problem comes back as it came', async () => {
  const w = world();
  try {
    const answer = await w.agent('/requests/r-1/cancel', { resource: 'phone', pool: 'phone', holder: 'ops' });
    assert.deepEqual(problemOf(answer).slice(0, 2), [404, 'HUB_REQUEST_NOT_FOUND']);
    const sent = w.reachedLinux.find(args => args.method === 'POST');
    assert.deepEqual([sent.body.pool, sent.body.host, sent.body.resource, sent.forwarded], ['phone', 'linux', 'phone', 'host-agent']);
  } finally { w.cleanup(); }
});

test('the actor is set by the first door that sees none and passed unchanged by the next', async () => {
  const w = world();
  try {
    const actor = { holder: 'jarad', via: 'cli' };
    await w.agent('/leases', { ...LEASE, resource: 's24', id: 'l-pppppppppppp', actor });
    assert.deepEqual(w.reachedLinux.find(args => args.method === 'POST').body.actor, actor);
    const mine = await w.api('/leases', { ...LEASE, resource: 'ipad', id: 'l-qqqqqqqqqqqq' });
    assert.equal(mine.status, 200);
    assert.deepEqual(w.reachedMac[0].body.actor, { holder: 'jarad@big-chungus', via: 'api' });
  } finally { w.cleanup(); }
});

test('a bad forward is 400 HUB_USAGE on the Hub API too: a header that is no door, a malformed record, an object resource with no header', async () => {
  const w = world();
  try {
    const body = { ...LEASE, resource: 's24', id: 'l-rrrrrrrrrrrr' };
    const reason = answer => [answer.status, answer.body.code, answer.body.reason];
    assert.deepEqual(reason(await handle({ method: 'POST', url: '/leases', headers: { [HEADER]: 'nope' }, body }, w.linux)), [400, 'HUB_USAGE', 'bad-forward']);
    assert.deepEqual(reason(await w.forwardToApi('/leases', { ...body, resource: { id: 's24' } })), [400, 'HUB_USAGE', 'bad-resource']);
    assert.deepEqual(reason(await w.api('/leases', { ...body, resource: { id: 's24', lock: 's24', host: 'linux', rev: 0, retired_at: null } })), [400, 'HUB_USAGE', 'bad-resource']);
  } finally { w.cleanup(); }
});

test('a Hub API that does not know its host key forwards nothing and acts in-process, as in v1a', async () => {
  const w = world();
  try {
    const unknown = { ...w.linux, hostKey: () => { throw Object.assign(new Error('which host?'), { code: 'HUB_HOST_UNKNOWN' }); } };
    const answer = await handle({ method: 'POST', url: '/leases', body: { ...LEASE, resource: 's24', id: 'l-ssssssssssss' } }, unknown);
    assert.equal(answer.status, 200, JSON.stringify(answer.body));
    assert.equal(w.reachedMac.length, 0);
    // A Resource of another host is not forwarded either: the release runs here and finds nothing.
    const released = await handle({ method: 'POST', url: '/leases/l-uuuuuuuuuuuu/release', body: { holder: 'jarad', resource: 'ios-lane' } }, unknown);
    assert.deepEqual([released.status, released.body.outcome], [200, 'none'], JSON.stringify(released.body));
    assert.equal(w.reachedMac.length, 0, 'an unknown host key forwards nothing');
  } finally { w.cleanup(); }
});

test('a Reservation\'s force-release is never forwarded: the Hub API\'s is unchanged and the agent\'s is HUB_WRONG_HOST for another host\'s lock', async () => {
  const w = world();
  try {
    const onAgent = await w.agent('/reservations/acme--app--1/force-release', { why: 'dead', holder: 'ops', name: 'adb' });
    assert.deepEqual(problemOf(onAgent).slice(0, 2), [409, 'HUB_WRONG_HOST']);
    assert.deepEqual([w.reachedLinux.length, w.reachedMac.length], [0, 0]);
    const onApi = await w.api('/reservations/acme--app--1/force-release', { why: 'dead', holder: 'ops', name: 'mac-ios' });
    assert.equal(w.reachedMac.length, 0, 'it ran (or refused) here, and sent nothing');
    assert.notEqual(onApi.status, 500);
  } finally { w.cleanup(); }
});
