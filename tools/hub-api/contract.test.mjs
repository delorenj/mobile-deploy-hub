// Story 6.4: docs/hub-api-contract.md and tools/hub-api/routes.mjs say the same thing. The document's route table must equal ROUTES
// (method and path, both ways), each route's response keys (flattened to dotted paths, arrays not expanded) must equal its shape's
// field list exactly, an error must match `Problem`, and every key is snake_case. Later route stories add a row and a `### <Shape>`
// section and this test covers them with no change.
//
// Field notation in the document: `a.b` is a key of an object; `a[].b` a key of the objects in the array `a` (the union over its items;
// an empty array or an array of scalars is the leaf `a`); `a.*` an open object whose keys the document does not list (the leaf `a.*`
// whatever the value, even null); `{name}` in a route path is a parameter.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDevices } from '../ci/lib/devices.mjs';
import { acquireLease, buildTicket, listWaiters, noteReachability, reserve } from '../ci/lib/lock.mjs';
import { loadPolicy } from '../ci/lib/policy.mjs';
import { hermetic } from '../ci/test-fixtures.mjs';
import { EXIT_CODES, createLeaseWaits } from '../device/claims.mjs';
import { fakeWire } from '../device/wire-fixtures.mjs';
import { AGENT_ROUTES } from '../host-agent/routes.mjs';
import { createPeers } from './peers.mjs';
import { CONTRACT_VERSION, PROBLEM_EXTENSIONS, ROUTES, handle } from './routes.mjs';
import { createStream } from './stream.mjs';

hermetic();

const DOC = fileURLToPath(new URL('../../docs/hub-api-contract.md', import.meta.url));
const SNAKE = /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/;

// The rows of the first `| Method | Path | Shape | Added |` table of `text`: {routes: ['GET /health', ...], shapeOf: {'GET /health': 'Health'}}.
function routeTable(text) {
  const routes = [];
  const shapeOf = {};
  const table = /^\|\s*Method\s*\|\s*Path\s*\|\s*Shape\s*\|\s*Added\s*\|\s*$/m.exec(text);
  if (table) {
    for (const line of text.slice(table.index + table[0].length).split('\n').slice(2)) {
      if (!line.startsWith('|')) break;
      const cells = line.split('|').slice(1, -1).map(cell => cell.trim());
      const key = `${cells[0]} ${cells[1].replace(/`/g, '')}`;
      routes.push(key);
      shapeOf[key] = cells[2];
    }
  }
  return { routes, shapeOf };
}

// What the document says: {version, routes: ['GET /health', ...], shapes: {Health: ['ok', 'ports.hub_api', ...]}, shapeOf: {'GET /health': 'Health'}, agentRoutes, agentShapeOf, codes, extensions}.
// The Hub API's table is the first in the document; the Host Agent's is the first one under its own `## Host Agent` heading.
export function parseContract(text) {
  const version = Number(/^Status:\s*contract\s+(\d+)\b/m.exec(text)?.[1]);
  const { routes, shapeOf } = routeTable(text);
  const agentAt = /^## Host Agent\s*$/m.exec(text);
  const agentSection = agentAt ? text.slice(agentAt.index + agentAt[0].length).split(/^## /m)[0] : '';
  const { routes: agentRoutes, shapeOf: agentShapeOf } = routeTable(agentSection);
  const shapes = {};
  let current = null;
  for (const line of text.split('\n')) {
    const heading = /^###\s+(\S+)\s*$/.exec(line);
    if (heading) { current = heading[1]; shapes[current] = []; continue; }
    if (/^#{1,2}\s/.test(line)) { current = null; continue; }
    const field = current && /^-\s+`([^`]+)`/.exec(line);
    if (field) shapes[current].push(field[1]);
  }
  const codes = {};
  const errors = /^## Error codes\s*$/m.exec(text);
  if (errors) {
    for (const line of text.slice(errors.index).split('\n').slice(1)) {
      if (/^## /.test(line)) break;
      const row = /^\|\s*`([A-Z_]+)`\s*\|[^|]*\|\s*(\d+)\s*\|/.exec(line);
      if (row) codes[row[1]] = Number(row[2]);
    }
  }
  const extensions = {};
  const table2 = /^## Problem extensions\s*$/m.exec(text);
  if (table2) {
    for (const line of text.slice(table2.index).split('\n').slice(1)) {
      if (/^## /.test(line)) break;
      const row = /^\|\s*`([A-Z_]+)`\s*\|([^|]+)\|/.exec(line);
      if (row) extensions[row[1]] = [...row[2].matchAll(/`([^`]+)`/g)].map(match => match[1]);
    }
  }
  return { version, routes, shapes, shapeOf, agentRoutes, agentShapeOf, codes, extensions };
}

// The key paths of an object's keys, sorted: objects recursed (`a.b`); an array of objects is the union of its items' paths under
// `a[]` (`a[].b`); an empty array or an array with a scalar is a leaf; a path in `open` (a doc entry `x.*`, given as `x`) is the leaf
// `x.*` whatever its value.
export function flatten(value, prefix = '', open = new Set(), maps = new Map()) {
  const out = [];
  // An object whose path is a map prefix is keyed by values (host keys): each child is flattened at `<prefix>.{name}`, whatever its key.
  const named = maps.get(prefix);
  for (const [key, child] of Object.entries(value)) {
    const path = named === undefined ? (prefix ? `${prefix}.${key}` : key) : `${prefix ? `${prefix}.` : ''}{${named}}`;
    if (open.has(path)) out.push(`${path}.*`);
    else if (child !== null && typeof child === 'object' && !Array.isArray(child)) out.push(...flatten(child, path, open, maps));
    else if (Array.isArray(child) && child.length > 0 && child.every(item => item !== null && typeof item === 'object' && !Array.isArray(item))) {
      out.push(...new Set(child.flatMap(item => flatten(item, `${path}[]`, open, maps))));
    } else out.push(path);
  }
  return [...new Set(out)].sort();
}

// The map prefixes of a document field list (prefix -> name): every `a.{name}.…` entry says the object at `a` is keyed by values, each
// of which has the fields listed under `a.{name}.`. `hosts.{host}.phones[].device` gives `hosts` -> `host`.
export function mapPrefixes(fields) {
  const maps = new Map();
  for (const field of fields) {
    const segments = field.split('.');
    segments.forEach((segment, index) => {
      const name = /^\{([a-z_]+)\}$/.exec(segment)?.[1];
      if (name !== undefined) maps.set(segments.slice(0, index).join('.'), name);
    });
  }
  return maps;
}

// The open prefixes of a document field list: every `x.*` entry names `x`.
export const openPrefixes = fields => new Set(fields.filter(field => field.endsWith('.*')).map(field => field.slice(0, -2)));

// The response's fields as the document would list them, the open prefixes of that shape's own entries honoured.
const shapeFieldsOf = (fields, body) => flatten(body, '', openPrefixes(fields), mapPrefixes(fields));
const shapeFields = (shape, body) => flatten(body, '', openPrefixes(contract.shapes[shape]), mapPrefixes(contract.shapes[shape]));

// The differences between the document's route set and the code's, as readable strings (empty when equal).
export function routeDiff(docRoutes, codeRoutes) {
  const doc = new Set(docRoutes);
  const code = new Set(codeRoutes);
  return [...[...code].filter(route => !doc.has(route)).map(route => `${route} is in routes.mjs but not in the document`), ...[...doc].filter(route => !code.has(route)).map(route => `${route} is in the document but not in routes.mjs`)];
}

export function fieldDiff(docFields, codeFields) {
  const doc = new Set(docFields);
  const code = new Set(codeFields);
  return [...[...code].filter(key => !doc.has(key)).map(key => `${key} is in the response but not in the document`), ...[...doc].filter(key => !code.has(key)).map(key => `${key} is in the document but not in the response`)];
}

const contract = parseContract(readFileSync(DOC, 'utf8'));
const routeKey = route => `${route.method} ${route.path}`;

// What each route parameter is replaced with when the test calls a GET route (a parameter not listed here fails the test).
const PARAM_SAMPLES = Object.freeze({ id: 's26' });

// How each POST route is called (a POST route with no sample fails the test): `body`, `status` (the success status it must answer),
// `params` (its own route parameters, over PARAM_SAMPLES) and `setup` (the paths of other POST samples called first, in order, on the
// same fresh scratch). A route that needs live state no other route makes has `prepare(ctx)` (run first, returns what `after` is given)
// and `after(state, answer)` (always run last: it ends what `prepare` started and checks what it saw). Each call gets a fresh scratch.
const tick = ms => new Promise(done => setTimeout(done, ms));
const until = async (check, what) => {
  for (let tries = 0; tries < 500; tries += 1) { if (check()) return; await tick(10); }
  throw new Error(`never happened: ${what}`);
};

// The live state `POST /requests/{id}/cancel` needs: s24 held, and two waiters on it, `contract-wait` (the one cancelled) and `contract-keep`
// (still there afterwards, so the answer's queue has a waiter to describe). Their waits are real, so they notice a cancel on their own.
async function prepareCancel(ctx) {
  const abort = new AbortController();
  const wait = (id, extra) => acquireLease('s24', { holder: `waiter-${id}`, why: 'contract', forMs: 600_000, id, env: ctx.env, log: () => {}, pollMs: 5, sleep: () => tick(5), ...extra });
  await wait('contract-held', { waitMs: 0 });
  const waiting = wait('contract-wait', { waitMs: 60_000 });
  const kept = wait('contract-keep', { waitMs: 60_000, signal: abort.signal });
  waiting.catch(() => {});
  kept.catch(() => {});
  await until(() => listWaiters('s24', { env: ctx.env }).length === 2, 'both waiters queued');
  return { abort, waiting, kept };
}

async function afterCancel(state, answer) {
  state.abort.abort();
  const [waiting] = await Promise.allSettled([state.waiting, state.kept]);
  if (answer?.status === 200) {
    assert.equal(waiting.status, 'rejected');
    assert.equal(waiting.reason.code, 'HUB_LEASE_CANCELLED');
    assert.match(waiting.reason.message, /cancelled by contract-test/);
  }
}

// The live state `POST /reservations/{run_key}/force-release` needs: run acme/app#77 holding a Reservation of adb.
function prepareReservation(ctx) {
  reserve('adb', { env: { ...ctx.env, GITHUB_REPOSITORY: 'acme/app', GITHUB_RUN_ID: '77' }, log: () => {} });
}

// The live state `GET /status` needs, on `adb` (the S26) only, so s24 stays free for the `/leases/{id}` sample: a Lease, a Lease waiter, a
// Pool request's ticket, a Reservation and an emulator record. The tickets are files of this very process (it is alive, so they are live).
function prepareStatus(ctx) {
  const now = Date.now();
  const iso = ms => new Date(ms).toISOString();
  const locks = ctx.env.HUB_LOCK_DIR;
  return acquireLease('adb', { holder: 'contract-held', why: 'contract', forMs: 600_000, id: 'status-held', env: ctx.env, log: () => {} }).then(() => {
    reserve('adb', { env: { ...ctx.env, GITHUB_REPOSITORY: 'acme/app', GITHUB_RUN_ID: '78' }, log: () => {} });
    mkdirSync(join(locks, 'adb.queue'), { recursive: true });
    const ticket = (index, fields) => writeFileSync(join(locks, 'adb.queue', `${String(now).padStart(15, '0')}-00000${index}-0000000${index}.json`), JSON.stringify(buildTicket('lease', { env: ctx.env, requested: now, holder: 'contract-wait', why: 'contract', ...fields })));
    ticket(1, { lease_id: 'status-wait', expires_at: iso(now + 600_000) });
    ticket(2, { lease_id: 'status-pool', request: 'status-request', pool: 'phone', expires_at: iso(now + 600_000) });
    mkdirSync(join(locks, 'emulators'), { recursive: true });
    writeFileSync(join(locks, 'emulators', 'e-aaaaaaaaaaaa.json'), JSON.stringify({ lease_id: 'e-aaaaaaaaaaaa', slot: 'emulator-1', profile: 'default', serial: 'emulator-5554', console_port: 5554, adb_server_port: 15170, avd: { name: 'hub-a' }, created_at: iso(now), pids: [] }));
  });
}

// The live state `GET /history` needs so every field appears: a past `host-reachability` event that opened a range for the Mac, and a transport
// whose Mac never answers (HUB_DEVICE_AWAY), so the answer is `partial` with an open range. `after` puts back everything it touched.
const eventFiles = ctx => (existsSync(ctx.env.HUB_EVENT_DIR) ? readdirSync(ctx.env.HUB_EVENT_DIR).filter(name => /^\d{4}-\d{2}\.jsonl$/.test(name)) : []);

function prepareHistory(ctx) {
  const before = new Map(eventFiles(ctx).map(name => [name, readFileSync(join(ctx.env.HUB_EVENT_DIR, name))]));
  noteReachability({ host: 'mac', from: null, to: 'unreachable', reason: 'timeout', checked_at: Date.now() - 3_600_000 }, { env: ctx.env, now: () => Date.now() - 3_600_000, hostId: 'contract-host', log: () => {} });
  ctx.peers = createPeers({ env: ctx.env, policy: ctx.policy, hostId: 'contract-host', log: () => {} });
  ctx.request = async () => { throw Object.assign(new Error('the mac host did not answer: contract'), { code: 'HUB_DEVICE_AWAY', api: false, reason: 'host-unreachable', status: 503, exit: 75, detail: 'timeout' }); };
  return { ctx, before };
}

function afterHistory({ ctx, before }) {
  delete ctx.request;
  delete ctx.peers;
  for (const name of eventFiles(ctx)) {
    if (before.has(name)) writeFileSync(join(ctx.env.HUB_EVENT_DIR, name), before.get(name));
    else rmSync(join(ctx.env.HUB_EVENT_DIR, name), { force: true });
  }
}

const POST_SAMPLES = Object.freeze({
  // A push from the Mac to a Hub API on linux (Story 9.5).
  '/agent/push': { status: 200, body: { format: 1, host: 'mac', host_id: null, boot: '0123456789ab', seq: 1, sent_at: '2026-11-26T10:00:00.000Z', status: null, readings: null, events: null } },
  '/registry/resources': { status: 201, body: { kind: 'phone', name: 'pixel', host: 'linux', identity: { serial: 'PX9', model: 'Pixel 9' }, capabilities: { api_level: 35 }, holder: 'contract-test' } },
  // After the seed (rev 1) and the setup register (rev 2), the edit is based on rev 2.
  '/registry/resources/{id}': { status: 200, params: { id: 'res-pixel' }, setup: ['/registry/resources'], body: { if_rev: 2, name: 'pixel-9', capabilities: { api_level: 36 }, holder: 'contract-test' } },
  '/registry/resources/{id}/retire': { status: 200, params: { id: 'res-pixel' }, setup: ['/registry/resources'], body: { holder: 'contract-test' } },
  '/leases': { status: 200, body: { resource: 's24', for_ms: 1_800_000, holder: 'contract-test', why: 'contract', id: 'contract-1' } },
  '/leases/{id}/extend': { status: 200, params: { id: 'contract-1' }, setup: ['/leases'], body: { for_ms: 600_000, holder: 'contract-test' } },
  '/leases/{id}/release': { status: 200, params: { id: 'contract-1' }, setup: ['/leases'], body: { holder: 'contract-test' } },
  '/leases/{id}/force-release': { status: 200, params: { id: 'contract-1' }, setup: ['/leases'], body: { why: 'contract', holder: 'contract-test' } },
  '/reservations/{run_key}/force-release': { status: 200, params: { run_key: 'acme--app--77' }, prepare: prepareReservation, body: { why: 'contract', holder: 'contract-test' } },
  '/requests/{id}/cancel': { status: 200, params: { id: 'contract-wait' }, prepare: prepareCancel, after: afterCancel, body: { resource: 's24', host: 'linux', why: 'contract', holder: 'contract-test' } },
});

// How each GET route with a parameter the default sample cannot stand for is called: `params` (over PARAM_SAMPLES) and `setup` (the
// paths of POST samples called first, in order, on the same scratch). `/leases/{id}` needs a Lease the setup took.
const GET_SAMPLES = Object.freeze({
  '/leases/{id}': { params: { id: 'contract-1' }, setup: ['/leases'] },
  '/status': { prepare: prepareStatus },
  '/history': { prepare: prepareHistory, after: afterHistory },
});
const sampleOf = (route, samples = POST_SAMPLES) => {
  if (!Object.hasOwn(samples, route.path)) throw new Error(`no request body sample for ${route.method} ${route.path}: add it to POST_SAMPLES`);
  return samples[route.path];
};
export function sampleBody(route, samples = POST_SAMPLES) {
  return structuredClone(sampleOf(route, samples).body);
}
const postRoutes = () => ROUTES.filter(candidate => candidate.method === 'POST');
export function samplePath(path, samples = PARAM_SAMPLES) {
  return path.replace(/\{([a-z_]+)\}/g, (_, name) => {
    if (!Object.hasOwn(samples, name)) throw new Error(`no sample for the route parameter {${name}} in ${path}: add it to PARAM_SAMPLES`);
    return samples[name];
  });
}

// Calls a POST route as its sample says: the setup routes first (their answers must be successes), then the route itself. Returns the answer.
async function callPost(route, ctx) {
  const sample = sampleOf(route);
  for (const path of sample.setup ?? []) {
    const earlier = ROUTES.find(candidate => candidate.method === 'POST' && candidate.path === path);
    const answer = await handle({ method: 'POST', url: samplePath(path, { ...PARAM_SAMPLES, ...sampleOf(earlier).params }), body: sampleBody(earlier) }, ctx);
    assert.equal(answer.status, sampleOf(earlier).status, `setup ${path}`);
  }
  const state = await sample.prepare?.(ctx);
  let answer = null;
  try {
    answer = await handle({ method: 'POST', url: samplePath(route.path, { ...PARAM_SAMPLES, ...sample.params }), body: sampleBody(route) }, ctx);
    return answer;
  } finally { await sample.after?.(state, answer); }
}

// Calls a GET route as its sample says (setup POSTs first, their answers successes, then `prepare` and `after` as for a POST). Returns the answer.
async function callGet(route, ctx) {
  const sample = GET_SAMPLES[route.path] ?? {};
  for (const path of sample.setup ?? []) {
    const earlier = ROUTES.find(candidate => candidate.method === 'POST' && candidate.path === path);
    const answer = await handle({ method: 'POST', url: samplePath(path, { ...PARAM_SAMPLES, ...sampleOf(earlier).params }), body: sampleBody(earlier) }, ctx);
    assert.equal(answer.status, sampleOf(earlier).status, `setup ${path}`);
  }
  const state = await sample.prepare?.(ctx);
  let answer = null;
  try {
    answer = await handle({ method: 'GET', url: samplePath(route.path, { ...PARAM_SAMPLES, ...sample.params }) }, ctx);
    return answer;
  } finally { await sample.after?.(state, answer); }
}

function scratch() {
  const root = mkdtempSync(join(tmpdir(), 'hub-api-contract-'));
  const env = { PATH: process.env.PATH, HOME: root, HUB_LOCK_DIR: join(root, 'locks'), HUB_EVENT_DIR: join(root, 'events') };
  const devices = structuredClone(loadDevices({}));
  // One unregistered phone on a fake adb server, so `GET /discovery` has a device to describe; nothing here touches a real adb.
  const serverUp = () => ({ adb_servers: [{ port: 5037, pid: 4242, cwd: null }], emulators: [], xvfb: [] });
  const adbWire = fakeWire({ listed: [{ id: 'ZY22PIX', state: 'device', model: 'Pixel_9' }] });
  return { root, ctx: { env, policy: loadPolicy().policy, devices, qaDevices: () => [], hostKey: () => 'linux', inventory: serverUp, adbWire, log: { out: () => {}, err: () => {} }, stream: createStream() }, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('the Status line carries the contract version of the code', () => {
  assert.equal(contract.version, CONTRACT_VERSION);
});

test('the route table of the document equals ROUTES, both ways', () => {
  assert.deepEqual(routeDiff(contract.routes, ROUTES.map(routeKey)), []);
  assert.ok(contract.routes.length > 0, 'the table parsed');
});

// Story 7.9: AD-42's Hold routes, frozen. Each route is in the document's table and in ROUTES with this shape, every field below is in the
// shape's list and in what the route answers (the contract is additive, so a later field is not a failure; a removed or renamed one is),
// and the live answer equals the document's whole list.
const HOLD_ROUTES = Object.freeze([
  ['POST', '/leases', 'Lease', ['lease_id', 'resource', 'lock', 'device', 'holder', 'why', 'claimant_kind', 'started_at', 'expires_at', 'env.*', 'emulator.*']],
  ['GET', '/leases/{id}', 'Lease', ['lease_id', 'resource', 'lock', 'device', 'holder', 'why', 'claimant_kind', 'started_at', 'expires_at', 'env.*', 'emulator.*']],
  ['POST', '/leases/{id}/extend', 'Lease', ['lease_id', 'resource', 'lock', 'device', 'holder', 'why', 'claimant_kind', 'started_at', 'expires_at', 'env.*', 'emulator.*']],
  ['POST', '/leases/{id}/release', 'Release', ['lease_id', 'outcome', 'resource', 'lock', 'device']],
  ['POST', '/leases/{id}/force-release', 'ForceRelease', ['lease_id', 'outcome', 'resource', 'lock', 'device', 'holder', 'why']],
  ['POST', '/requests/{id}/cancel', 'Cancel', ['request_id', 'outcome', 'resource', 'pool', 'queues[].lock', 'queues[].resource', 'queues[].waiters[].place', 'queues[].waiters[].lease_id', 'queues[].waiters[].holder', 'queues[].waiters[].why', 'queues[].waiters[].kind', 'queues[].waiters[].enqueued_at', 'queues[].waiters[].deadline_at', 'queues[].waiters[].pool']],
  ['POST', '/reservations/{run_key}/force-release', 'ReservationForceRelease', ['run_key', 'outcome', 'repo', 'run', 'released[].lock', 'released[].resource', 'released[].reserved_at', 'released[].expires_at', 'why']],
]);

test('the AD-42 Hold routes are in the document table and in ROUTES, each with its shape and its exact field list', async () => {
  assert.equal(HOLD_ROUTES.length, 7);
  for (const [method, path, shape, fields] of HOLD_ROUTES) {
    const key = `${method} ${path}`;
    assert.ok(contract.routes.includes(key), `${key} is in the document's route table`);
    const route = ROUTES.find(candidate => routeKey(candidate) === key);
    assert.ok(route, `${key} is in ROUTES`);
    assert.equal(contract.shapeOf[key], shape, `${key} shape in the document`);
    assert.equal(route.shape, shape, `${key} shape in ROUTES`);
    for (const field of fields) assert.ok(contract.shapes[shape].includes(field), `${key}: the document lists ${field}`);
    const s = scratch();
    try {
      const answer = method === 'GET' ? await callGet(route, s.ctx) : await callPost(route, s.ctx);
      assert.equal(answer.status, 200, key);
      const live = shapeFields(shape, answer.body);
      for (const field of fields) assert.ok(live.includes(field), `${key}: the answer has ${field}`);
      assert.deepEqual(fieldDiff(contract.shapes[shape], live), [], key);
    } finally { s.cleanup(); }
  }
});

test('the route comparison fails on a synthetic extra route on either side', () => {
  const real = ROUTES.map(routeKey);
  assert.deepEqual(routeDiff(real, real), []);
  assert.deepEqual(routeDiff(contract.routes, [...real, 'GET /ghost']), ['GET /ghost is in routes.mjs but not in the document']);
  assert.deepEqual(routeDiff([...contract.routes, 'POST /ghost'], real), ['POST /ghost is in the document but not in routes.mjs']);
  assert.deepEqual(fieldDiff(['a', 'b'], ['a', 'b']), []);
  assert.equal(fieldDiff(['a', 'b'], ['a']).length, 1);
  assert.equal(fieldDiff(['a'], ['a', 'b']).length, 1);
});

test('every route names a shape the document describes, and no shape is orphaned', () => {
  for (const route of ROUTES) {
    assert.equal(contract.shapeOf[routeKey(route)], route.shape, routeKey(route));
    assert.ok(contract.shapes[route.shape]?.length > 0, `${route.shape} has a field list`);
  }
  const used = new Set([...ROUTES.map(route => route.shape), ...AGENT_ROUTES.map(route => route.shape), 'Problem']);
  for (const name of Object.keys(contract.shapes)) assert.ok(used.has(name), `${name} is described but no route returns it`);
});

test('each GET route answers with exactly the field list of its shape', async () => {
  const s = scratch();
  try {
    // A stream route answers an event stream, not JSON: the StreamFrame test below holds it to its list.
    for (const route of ROUTES.filter(candidate => candidate.method === 'GET' && !candidate.stream)) {
      const answer = await callGet(route, s.ctx);
      assert.equal(answer.status, 200, routeKey(route));
      assert.deepEqual(fieldDiff(contract.shapes[route.shape], shapeFields(route.shape, answer.body)), [], routeKey(route));
    }
  } finally { s.cleanup(); }
});

test('each POST route answers its success status with exactly the field list of its shape', async () => {
  assert.ok(postRoutes().length > 0);
  for (const route of postRoutes()) {
    const s = scratch();
    try {
      const answer = await callPost(route, s.ctx);
      assert.equal(answer.status, sampleOf(route).status, routeKey(route));
      assert.deepEqual(fieldDiff(contract.shapes[route.shape], shapeFields(route.shape, answer.body)), [], routeKey(route));
    } finally { s.cleanup(); }
  }
  assert.throws(() => sampleBody({ method: 'POST', path: '/ghost' }), /no request body sample for POST \/ghost/);
});

test('the Problem extensions of the document equal PROBLEM_EXTENSIONS both ways, and the live answers carry them', async () => {
  assert.ok(Object.keys(contract.extensions).length > 0, 'the table parsed');
  assert.deepEqual(contract.extensions, Object.fromEntries(Object.entries(PROBLEM_EXTENSIONS).map(([code, fields]) => [code, [...fields]])));
  for (const code of Object.keys(PROBLEM_EXTENSIONS)) assert.ok(code in contract.codes, `${code} is described as an error code`);
  const s = scratch();
  try {
    const route = ROUTES.find(candidate => candidate.method === 'POST' && candidate.path === '/registry/resources');
    const post = body => handle({ method: 'POST', url: route.path, body }, s.ctx);
    const base = sampleBody(route);
    assert.equal((await post(base)).status, 201);
    // A service that is stopping answers every lease request 503 HUB_API_RESTARTING.
    const waits = createLeaseWaits();
    await waits.shutdown();
    const lease = ROUTES.find(candidate => candidate.method === 'POST' && candidate.path === '/leases');
    const answers = {
      HUB_REGISTRY_CONFLICT: await post({ ...base, name: 'other', identity: { model: 'x' }, if_rev: 0 }),
      HUB_REGISTRY_DUPLICATE: await post({ ...base, name: 'other' }),
      HUB_API_RESTARTING: await handle({ method: 'POST', url: lease.path, body: sampleBody(lease) }, { ...s.ctx, waits }),
      // A deploy job's place in line is refused from the id alone, naming the run to cancel.
      HUB_FORCE_RELEASE_JOB: await handle({ method: 'POST', url: '/leases/job:o%2Fr%2341.1%2Fandroid/force-release', body: { why: 'contract', holder: 'contract-test' } }, s.ctx),
      // A push whose events do not continue the replica at its settled size is a gap, with the size to push from.
      HUB_REPLICA_GAP: await handle({ method: 'POST', url: '/agent/push', body: { format: 1, host: 'mac', host_id: null, boot: '0123456789ab', seq: 1, sent_at: '2026-11-26T10:00:00.000Z', status: null, readings: null, events: { month: '2026-11', from_offset: 5, lines: ['{"format":1}\n'] } } }, s.ctx),
    };
    assert.deepEqual(Object.keys(answers).sort(), Object.keys(PROBLEM_EXTENSIONS).sort(), 'every extension code has a live answer here');
    for (const [code, answer] of Object.entries(answers)) {
      assert.equal(answer.body.code, code);
      assert.deepEqual(fieldDiff([...contract.shapes.Problem, ...contract.extensions[code]], flatten(answer.body)), [], code);
    }
    // The base answer of any other error is exactly Problem.
    assert.deepEqual(fieldDiff(contract.shapes.Problem, flatten((await post({ ...base, name: 'Bad Name' })).body)), []);
  } finally { s.cleanup(); }
});

test('flatten: arrays of objects are unions of item paths, scalar and empty arrays are leaves, open prefixes are one leaf', () => {
  assert.deepEqual(flatten({ a: 1, b: { c: 2 } }), ['a', 'b.c']);
  assert.deepEqual(flatten({ rows: [{ id: 1, tags: ['x'] }, { id: 2, extra: { deep: 1 } }] }), ['rows[].extra.deep', 'rows[].id', 'rows[].tags']);
  assert.deepEqual(flatten({ list: [], names: ['a', 'b'], mixed: [{ a: 1 }, 2] }), ['list', 'mixed', 'names']);
  const open = new Set(['rows[].caps', 'rows[].ident']);
  const doc = { rows: [{ id: 1, caps: { api_level: 34 }, ident: null }, { id: 2, caps: {}, ident: { serial: 'x' } }] };
  assert.deepEqual(flatten(doc, '', open), ['rows[].caps.*', 'rows[].id', 'rows[].ident.*']);
  assert.deepEqual(flatten({ caps: { a: 1 } }, '', new Set(['caps'])), ['caps.*']);
  assert.deepEqual([...openPrefixes(['rows[].id', 'rows[].caps.*', 'x.*'])].sort(), ['rows[].caps', 'x']);
  assert.deepEqual(fieldDiff(['rows[].id', 'rows[].caps.*'], flatten({ rows: [{ id: 1, caps: {} }] }, '', new Set(['rows[].caps']))), []);
  assert.equal(fieldDiff(['rows[].id'], flatten({ rows: [{ id: 1, extra: 2 }] })).length, 1);
});

test('flatten: a map prefix names its keys, so any keyed object is pinned exactly', () => {
  const doc = ['hosts.{host}.phones[].device', 'hosts.{host}.inventory.*', 'hosts.{host}.locks[].phone.*', 'stale.*', 'format'];
  const maps = mapPrefixes(doc);
  assert.deepEqual([...maps], [['hosts', 'host']]);
  const open = openPrefixes(doc);
  assert.deepEqual(flatten({ hosts: { linux: { phones: [{ device: 's24' }], inventory: { xvfb: [] }, locks: [{ phone: null }] } } }, '', open, maps), ['hosts.{host}.inventory.*', 'hosts.{host}.locks[].phone.*', 'hosts.{host}.phones[].device']);
  // Every host is held to the same fields: a second host adds nothing, and a field one host lacks or adds is a difference.
  const two = flatten({ hosts: { linux: { phones: [{ device: 's24' }] }, mac: { phones: [{ device: 'ipad' }] } } }, '', open, maps);
  assert.deepEqual(two, ['hosts.{host}.phones[].device']);
  assert.deepEqual(fieldDiff(['hosts.{host}.phones[].device'], flatten({ hosts: { linux: { phones: [{ device: 's24' }] }, mac: { phones: [{ device: 'i', extra: 1 }] } } }, '', new Set(), maps)), ['hosts.{host}.phones[].extra is in the response but not in the document']);
  assert.deepEqual(flatten({ hosts: {}, stale: {} }, '', open, maps), ['stale.*']);
  assert.deepEqual(flatten({ a: { b: 1 } }, '', new Set(), new Map([['', 'k']])), ['{k}.b']);
  assert.deepEqual([...mapPrefixes(['a.b', 'x[].{id}.y'])], [['x[]', 'id']]);
});

test('GET /status is in the route table and its live answer\'s key set is the document\'s list exactly, hosts.linux the one host', async () => {
  const route = ROUTES.find(candidate => routeKey(candidate) === 'GET /status');
  assert.equal(contract.shapeOf['GET /status'], 'Status');
  assert.equal(route.shape, 'Status');
  const s = scratch();
  try {
    const answer = await callGet(route, s.ctx);
    assert.equal(answer.status, 200);
    assert.deepEqual(Object.keys(answer.body), ['format', 'contract', 'hosts', 'registry', 'stale', 'checked_at']);
    assert.deepEqual(Object.keys(answer.body.hosts), ['linux']);
    assert.deepEqual(fieldDiff(contract.shapes.Status, shapeFields('Status', answer.body)), []);
    // The sample is rich enough to pin the fields that only some rows have.
    const live = shapeFields('Status', answer.body);
    for (const field of ['hosts.{host}.locks[].expected_end', 'hosts.{host}.waiters[].request', 'hosts.{host}.waiters[].positions.*', 'hosts.{host}.reservations[].grace.*', 'hosts.{host}.emulators[].avd']) assert.ok(live.includes(field), field);
  } finally { s.cleanup(); }
});

// Story 9.2: the Host Agent's own section. Its route table is held equal to AGENT_ROUTES (method, path and shape), `/health` answers exactly
// AgentHealth, and `/status` answers a view whose every key is in HostView and whose root keys are exactly the six v1a lists. An empty list
// is one leaf (`phones`), so a list counts as documented when any HostView field starts with it.
const agentKey = route => `${route.method} ${route.path}`;
const documented = (fields, path) => fields.includes(path) || fields.some(field => field.startsWith(`${path}[].`) || field.startsWith(`${path}.`));

function agentScratch() {
  const root = mkdtempSync(join(tmpdir(), 'host-agent-contract-'));
  const env = { PATH: process.env.PATH, HOME: root, HUB_LOCK_DIR: join(root, 'locks'), HUB_EVENT_DIR: join(root, 'events') };
  const { udid, model } = loadDevices({}).ios;
  const ipad = { result: { devices: [{ identifier: 'IPAD', hardwareProperties: { udid, reality: 'physical', productType: model }, connectionProperties: { pairingState: 'paired', tunnelState: 'connected' }, deviceProperties: { developerModeStatus: 'enabled', bootState: 'booted' } }] } };
  const ctx = { env, policy: loadPolicy().policy, routes: AGENT_ROUTES, devices: structuredClone(loadDevices({})), qaDevices: () => [], hostKey: () => 'mac', inventory: () => ({ adb_servers: [], emulators: [], xvfb: [] }), devicectl: () => ipad, log: { out: () => {}, err: () => {} } };
  return { root, env, ctx, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('the Host Agent table of the document equals AGENT_ROUTES both ways, each with its shape, and the Hold routes keep the Hub API\'s shapes', () => {
  assert.ok(contract.agentRoutes.length > 0, 'the agent table parsed');
  assert.deepEqual(routeDiff(contract.agentRoutes, AGENT_ROUTES.map(agentKey)), []);
  for (const route of AGENT_ROUTES) {
    assert.equal(contract.agentShapeOf[agentKey(route)], route.shape, agentKey(route));
    assert.ok(contract.shapes[route.shape]?.length > 0, `${route.shape} has a field list`);
  }
  for (const route of AGENT_ROUTES.filter(candidate => !['AgentHealth', 'HostView', 'AgentSync'].includes(candidate.shape))) {
    assert.equal(ROUTES.find(candidate => routeKey(candidate) === agentKey(route))?.shape, route.shape, `${agentKey(route)} is the Hub API's route`);
  }
  for (const route of ROUTES.filter(candidate => !candidate.path.startsWith('/registry') && !['/resources', '/resources/{id}', '/pools', '/discovery', '/stream', '/history', '/health', '/status', '/agent/push'].includes(candidate.path))) {
    assert.ok(AGENT_ROUTES.some(candidate => agentKey(candidate) === routeKey(route)), `${routeKey(route)} is a Hold route the agent serves`);
  }
});

test('the agent\'s GET /health keys are exactly AgentHealth', async () => {
  const s = agentScratch();
  try {
    const answer = await handle({ method: 'GET', url: '/health' }, s.ctx);
    assert.equal(answer.status, 200);
    assert.deepEqual(fieldDiff(contract.shapes.AgentHealth, flatten(answer.body)), []);
    assert.ok(!('registry' in answer.body));
  } finally { s.cleanup(); }
});

test('the agent\'s GET /status is a HostView: the six v1a lists at the root, every key in the document', async () => {
  const s = agentScratch();
  try {
    const now = Date.now();
    const iso = ms => new Date(ms).toISOString();
    await acquireLease('mac-ios', { holder: 'contract-held', why: 'contract', forMs: 600_000, id: 'agent-held', env: s.env, log: () => {} });
    reserve('mac-ios', { env: { ...s.env, GITHUB_REPOSITORY: 'acme/app', GITHUB_RUN_ID: '79' }, log: () => {} });
    mkdirSync(join(s.env.HUB_LOCK_DIR, 'mac-ios.queue'), { recursive: true });
    writeFileSync(join(s.env.HUB_LOCK_DIR, 'mac-ios.queue', `${String(now).padStart(15, '0')}-000001-00000001.json`), JSON.stringify(buildTicket('lease', { env: s.env, requested: now, lease_id: 'agent-wait', holder: 'contract-wait', why: 'contract', expires_at: iso(now + 600_000) })));
    const answer = await handle({ method: 'GET', url: '/status' }, s.ctx);
    assert.equal(answer.status, 200, JSON.stringify(answer.body));
    assert.deepEqual(Object.keys(answer.body), ['phones', 'locks', 'waiters', 'reservations', 'inventory', 'emulators']);
    const fields = contract.shapes.HostView;
    const live = shapeFieldsOf(fields, answer.body);
    for (const path of live) assert.ok(documented(fields, path), `${path} is in the response but not in HostView`);
    for (const field of ['locks[].lock', 'locks[].reachability.*', 'waiters[].since', 'reservations[].run_key']) assert.ok(live.includes(field), `the sample is rich enough for ${field}`);
    for (const root of ['phones', 'locks', 'waiters', 'reservations', 'inventory', 'emulators']) assert.ok(fields.some(field => field.startsWith(`${root}[].`) || field.startsWith(`${root}.`)), `HostView documents ${root}`);
    // HostView is Status's `hosts.{host}.` list, unprefixed: nothing in one is missing from the other.
    const status = contract.shapes.Status.filter(field => field.startsWith('hosts.{host}.')).map(field => field.slice('hosts.{host}.'.length));
    assert.deepEqual(fieldDiff(status, fields), []);
  } finally { s.cleanup(); }
});

// Story 10.1: `POST /agent/sync` hands the agent the replica sizes and makes it push. Its answer's key set is exactly
// AgentSync, and a bad body is HUB_USAGE 400 with `bad-body` or `bad-replica`.
test('the agent\'s POST /agent/sync keys are exactly AgentSync, and a bad body is refused', async () => {
  const s = agentScratch();
  try {
    const ctx = { ...s.ctx, sync: async replica => ({ pushed: true, synced: true, replica }) };
    const answer = await handle({ method: 'POST', url: '/agent/sync', body: { replica: { '2026-11': 120 } } }, ctx);
    assert.equal(answer.status, 200, JSON.stringify(answer.body));
    assert.deepEqual(fieldDiff(contract.shapes.AgentSync, flatten(answer.body, '', openPrefixes(contract.shapes.AgentSync))), []);
    const cases = [
      ['bad-body', null], ['bad-body', { replica: {}, extra: 1 }], ['bad-body', {}], ['bad-body', []],
      ['bad-replica', { replica: [] }], ['bad-replica', { replica: 'x' }], ['bad-replica', { replica: { '2026-13': 1 } }], ['bad-replica', { replica: { '2026-11': -1 } }], ['bad-replica', { replica: { '2026-11': 1.5 } }],
    ];
    for (const [reason, body] of cases) {
      const refusal = await handle({ method: 'POST', url: '/agent/sync', body }, ctx);
      assert.equal(refusal.status, 400, `${reason} ${JSON.stringify(refusal.body)}`);
      assert.equal(refusal.body.code, 'HUB_USAGE');
      assert.equal(refusal.body.exit, 2);
      assert.equal(refusal.body.reason, reason);
    }
  } finally { s.cleanup(); }
});

test('GET /stream\'s frames carry exactly the StreamFrame list, and each frame\'s status is the Status list', async () => {
  const route = ROUTES.find(candidate => routeKey(candidate) === 'GET /stream');
  assert.equal(contract.shapeOf['GET /stream'], 'StreamFrame');
  assert.equal(route.shape, 'StreamFrame');
  const s = scratch();
  try {
    await prepareStatus(s.ctx);   // the rich state the Status list needs, so its documents are held to the whole list
    const sinks = [];
    const open = async headers => {
      const answer = await handle({ method: 'GET', url: '/stream', headers }, s.ctx);
      assert.equal(answer.status, 200, JSON.stringify(answer.body));
      const sink = { text: '', on() {}, write(chunk) { this.text += chunk; return true; }, end() {} };
      answer.stream.open(sink);
      sinks.push(sink);
      return sink;
    };
    const ready = await open({});
    const document = JSON.parse(ready.text.split('\n').find(line => line.startsWith('data: ')).slice(6)).status;
    s.ctx.stream.status(document);
    s.ctx.stream.event({ id: 'host/2026-11/0', offset: 0, event: { ts: '2026-11-25T09:00:00.000Z', kind: 'lease', resource: 's24' } });
    await open({ 'last-event-id': 'bogus' });
    const frames = sinks.flatMap(sink => sink.text.split('\n\n').filter(block => block.includes('\ndata: ')).map(block => JSON.parse(/^data: (.*)$/m.exec(block)[1])));
    assert.deepEqual(new Set(frames.map(frame => frame.type)), new Set(['ready', 'status', 'event', 'reset']));
    const open2 = openPrefixes(contract.shapes.StreamFrame);
    const union = new Set(frames.flatMap(frame => flatten(frame, '', open2)));
    assert.deepEqual(fieldDiff(contract.shapes.StreamFrame, [...union]), []);
    for (const frame of frames) {
      assert.deepEqual(Object.keys(frame).slice(0, 4), ['type', 'seq', 'key', 'at'], frame.type);
      if ('status' in frame) assert.deepEqual(fieldDiff(contract.shapes.Status, shapeFields('Status', frame.status)), [], frame.type);
    }
  } finally { s.ctx.stream.close(); s.cleanup(); }
});

test('samplePath substitutes route parameters and fails on one it has no sample for', () => {
  assert.equal(samplePath('/resources/{id}'), '/resources/s26');
  assert.equal(samplePath('/health'), '/health');
  assert.throws(() => samplePath('/x/{ghost}'), /no sample for the route parameter \{ghost\}/);
});

test('an error answers with exactly the Problem field list', async () => {
  const s = scratch();
  try {
    const answer = await handle({ method: 'GET', url: '/nope' }, s.ctx);
    assert.equal(answer.status, 404);
    assert.deepEqual(fieldDiff(contract.shapes.Problem, flatten(answer.body)), []);
    const wrongMethod = await handle({ method: 'DELETE', url: '/health' }, s.ctx);
    assert.deepEqual(fieldDiff(contract.shapes.Problem, flatten(wrongMethod.body)), []);
  } finally { s.cleanup(); }
});

test('every key, in the document and in a response, is snake_case', async () => {
  const s = scratch();
  try {
    // `[]`, `*` and `{name}` are notation, not keys.
    const keysOf = path => path.split('.').filter(key => !/^\{[a-z_]+\}$/.test(key)).map(key => key.replace(/\[\]$/, '')).filter(key => key !== '*');
    const keys = new Set(Object.values(contract.shapes).flat().flatMap(keysOf));
    for (const route of ROUTES.filter(candidate => candidate.method === 'GET' && !candidate.stream)) {
      const body = (await callGet(route, s.ctx)).body;
      for (const path of shapeFields(route.shape, body)) for (const key of keysOf(path)) keys.add(key);
    }
    for (const route of postRoutes()) {
      const t = scratch();
      try {
        const body = (await callPost(route, t.ctx)).body;
        for (const path of shapeFields(route.shape, body)) for (const key of keysOf(path)) keys.add(key);
      } finally { t.cleanup(); }
    }
    for (const fields of Object.values(contract.extensions)) for (const field of fields) keys.add(field);
    for (const key of keys) assert.match(key, SNAKE, key);
    assert.ok(keys.size > 5);
  } finally { s.cleanup(); }
});

test('the error codes of the document are in the exit table, with the same exit', () => {
  assert.ok(Object.keys(contract.codes).length > 0, 'the table parsed');
  for (const [code, exit] of Object.entries(contract.codes)) assert.equal(EXIT_CODES[code], exit, code);
  for (const code of Object.keys(EXIT_CODES).filter(name => name.startsWith('HUB_API_') || name === 'HUB_NO_ROUTE')) assert.ok(code in contract.codes, `${code} is in the exit table but not in the document`);
});

test('the document gives the base URL and the Holocene proposal', () => {
  const text = readFileSync(DOC, 'utf8');
  assert.match(text, /http:\/\/127\.0\.0\.1:8794/);
  assert.match(text, /`mobile-deploy-hub`/);
  assert.match(text, /MOBILE_DEPLOY_HUB_API_URL/);
});
