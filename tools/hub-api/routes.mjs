// The Hub API's routes (AD-42, FR-21): a route table and a pure `handle()` over it, with no socket in this file. server.mjs puts a node
// `http` adapter in front, and a test calls `handle()` directly. The envelope (headers, problem+json, the 404 and 405 rules) is written
// once and takes the route table as a parameter, so the Host Agent (Epic 7) reuses it and every route story adds one row to `ROUTES`, one
// row and one `### <Shape>` section to docs/hub-api-contract.md, and nothing else (tools/hub-api/contract.test.mjs holds the two equal).
//
// Reachability and discovery (Story 6.10): `GET /resources` rows carry the service's cached reading of each Resource (`ctx.readings`,
// tools/hub-api/readings.mjs) and `GET /discovery` lists what the host's adb server shows that no live Resource names. A reader never
// waits for a probe; the context's device seams (`adbWire`, `inventory`, `hostKey`, `sleep`, `devicectl`) are injected, never reached.
//
// Every response carries `Cache-Control: no-store` and snake_case keys. Success is `application/json`; an error is
// `application/problem+json` with exactly {type, title, status, detail, code, exit, reason}, where `exit` is what a CLI front door
// exits with for the same error (claims.mjs's one table). Paths match exactly: no prefix, no trailing-slash folding, and the query
// string is ignored for routing. A `{name}` segment in a route path is a parameter: one non-empty, URI-decoded segment, handed to the
// handler as `request.params`; a literal route wins over a parameterised one.
import { STATUS_CODES } from 'node:http';
import { idMatchesSerial } from '../ci/lib/adb.mjs';
import { HOST_PLATFORMS, discover as discoverHost, exitCodeOf, hostKey as realHostKey, lockActivity } from '../device/claims.mjs';
import { hubRef } from '../ci/lib/receipt.mjs';
import { NO_READING } from '../registry/reachability.mjs';
import { loadQaDevices } from '../registry/seed.mjs';
import { retirement, visibility } from '../registry/match.mjs';
import { checkEditBody, checkRegisterBody, checkRetireBody, planEdit, planRegister, planRetire } from '../registry/changes.mjs';
import { REGISTRY_ERRORS, applySeed, readRegistry, registryState, updateRegistry } from '../registry/store.mjs';
import { viewPools, viewRecord } from '../registry/view.mjs';
import { deviceCtx } from './readings.mjs';

export const CONTRACT_VERSION = 1;
// One name for the service: the server answers with it, and the installer's readback and the smoke check for it.
import { HUB_API_SERVICE } from '../hub-client.mjs';
export const SERVICE = HUB_API_SERVICE;

const JSON_TYPE = 'application/json; charset=utf-8';
const PROBLEM_TYPE = 'application/problem+json';
const BASE_HEADERS = Object.freeze({ 'Cache-Control': 'no-store' });

// A handler returns its body (an object, status 200), or `reply(status, body)` for another success status (201 for a register).
const REPLY = Symbol('reply');
export const reply = (status, body) => ({ [REPLY]: true, status, body });

const respond = (status, body, extra = {}) => ({ status, headers: { ...BASE_HEADERS, 'Content-Type': JSON_TYPE, ...extra }, body });

// The problem+json response for an error. An error with a `status` (the library's and the API's own coded errors) keeps its code and
// exit; anything else is a bug in a handler: 500 HUB_API_ERROR.
const hasStatus = error => Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599;
const oneLine = value => String(value).replace(/\s+/g, ' ').trim();

// The members a code adds to the base Problem fields (`rev` of a conflict, `holder` of a duplicate). `problem()` merges the ones an error
// carries and never overwrites a base field; docs/hub-api-contract.md's `Problem extensions` table is held equal to this by the contract test.
export const PROBLEM_EXTENSIONS = Object.freeze({
  HUB_REGISTRY_CONFLICT: Object.freeze(['rev']),
  HUB_REGISTRY_DUPLICATE: Object.freeze(['holder']),
});

export function problem(error, extra = {}) {
  const known = hasStatus(error);
  const status = known ? error.status : 500;
  const code = known && typeof error.code === 'string' && error.code !== '' ? error.code : 'HUB_API_ERROR';
  const detail = oneLine(typeof error?.message === 'string' && error.message !== '' ? error.message : error);
  const body = {
    type: `urn:mobile-deploy-hub:problem:${code}`,
    title: STATUS_CODES[status] ?? 'Error',
    status,
    detail,
    code,
    exit: known ? (Number.isInteger(error.exit) ? error.exit : exitCodeOf(error)) : 1,
    reason: known && typeof error.reason === 'string' && error.reason !== '' ? error.reason : (known ? code.toLowerCase() : 'internal'),
  };
  if (known) {
    for (const field of PROBLEM_EXTENSIONS[code] ?? []) {
      if (error[field] !== undefined && !Object.hasOwn(body, field)) body[field] = error[field];
    }
  }
  return { status, headers: { ...BASE_HEADERS, 'Content-Type': PROBLEM_TYPE, ...extra }, body };
}

const routeError = (status, code, message, reason) => Object.assign(new Error(message), { status, code, exit: exitCodeOf({ code }), reason });

// ---- the routes ----

// GET /health: what is running, which contract it speaks, and whether the Registry file can be read. `registry` is read fresh on every
// call and is `unreadable` only when the file exists and cannot be read (a missing file is the in-memory seed: `ok`).
export function health(ctx) {
  const env = ctx.env ?? process.env;
  return {
    ok: true,
    service: SERVICE,
    contract: CONTRACT_VERSION,
    hub_version: hubRef(env) ?? 'unknown',
    ports: { hub_api: ctx.policy.api.hub_api_port, host_agent: ctx.policy.api.host_agent_port },
    registry: registryState(env) === 'unreadable' ? 'unreadable' : 'ok',
  };
}

// The Registry, read fresh on every call through the same seeds the start wrote (`ctx.devices`, `ctx.qaDevices`): the file when it is
// good, else the in-memory seed at rev 0. No warning per request: `/health` already says `unreadable`.
const readIt = ctx => readRegistry({ env: ctx.env ?? process.env, devices: ctx.devices, qaDevices: ctx.qaDevices });

// The served record of one stored record for a service audience, or null when it is hidden. The lock is read only for a record that
// is retired or seed-missing (a live one is visible whatever its lock does).
function serve(ctx, record) {
  const marked = retirement(record) !== null;
  const activity = marked ? (ctx.lockActivity ?? lockActivity)(record.lock, { env: ctx.env ?? process.env, now: ctx.now }) : {};
  return viewRecord(record, { audience: 'service', held: activity.held === true, queued: activity.queued === true });
}

// GET /resources: every visible Resource (visible or retiring), in the Registry's order, each with its `reachability` (AD-35): the
// service's cached reading in its served form, read without waiting (a stale or missing one starts one refresh in the background), or
// the no-reading form when the context has no cache. Only this list carries it: the `Resource` shape is the same for every route.
export function listResources(ctx) {
  const registry = readIt(ctx);
  const shown = registry.resources.map(record => ({ record, resource: serve(ctx, record) })).filter(entry => entry.resource !== null);
  const readings = ctx.readings?.read(shown.map(entry => entry.record)) ?? new Map();
  return {
    rev: registry.rev,
    source: registry.source,
    resources: shown.map(({ record, resource }) => ({ ...resource, reachability: readings.get(record.id) ?? { ...NO_READING } })),
  };
}

// GET /resources/{id}: one Resource by id (only the id). Unknown is 404 `unknown`; a hidden one is 404 `retired`.
export function getResource(ctx, { params }) {
  const registry = readIt(ctx);
  const record = registry.resources.find(candidate => candidate.id === params.id);
  if (!record) throw routeError(404, 'HUB_RESOURCE_NOT_FOUND', `no Resource "${params.id}"`, 'unknown');
  const resource = serve(ctx, record);
  if (resource === null) throw routeError(404, 'HUB_RESOURCE_NOT_FOUND', `the Resource "${params.id}" is retired`, 'retired');
  return { rev: registry.rev, source: registry.source, resource };
}

// GET /pools: every Pool in its stored order, with the members a lease of it would try.
export function listPools(ctx) {
  const registry = readIt(ctx);
  return { rev: registry.rev, source: registry.source, pools: viewPools(registry, ctx.policy) };
}

// GET /discovery: the devices this host can see that no live Resource names (FR-4, FR-5): `claims.discover` over the hub's adb server
// (read only: never started or connected), with the Registry's live records as the exclusion set. A device the private QA file names
// (by serial, or an adb id that embeds it) is dropped here, so a QA serial is in no part of the body. A host that does not know its
// key is 503 HUB_HOST_UNKNOWN.
const HOST_UNKNOWN = message => routeError(503, 'HUB_HOST_UNKNOWN', message, 'host-unknown');

export async function discovery(ctx) {
  const env = ctx.env ?? process.env;
  let document;
  try {
    const key = (ctx.hostKey ?? realHostKey)({ env });
    // `/health` already reports an unreadable registry.json, so a read of it here stays silent, as `/resources` does.
    document = await discoverHost(key, { ...deviceCtx(ctx), warn: () => {} }, { devices: ctx.devices, qaDevices: ctx.qaDevices });
  } catch (error) {
    throw error?.code === 'HUB_HOST_UNKNOWN' ? HOST_UNKNOWN(oneLine(error.message)) : error;
  }
  const qa = (ctx.qaDevices ?? (() => loadQaDevices({ env })))().map(entry => entry?.serial).filter(serial => typeof serial === 'string' && serial !== '');
  const named = device => qa.some(serial => device.serial === serial || (typeof device.id === 'string' && idMatchesSerial(device.id, serial)));
  return {
    format: document.format, host: document.host, via: document.via, port: document.port, note: document.note,
    devices: document.devices.filter(device => !named(device)).map(({ serial, model, id, state }) => ({ serial, model, id, state })),
  };
}

// POST /registry/resources: registers a Resource (FR-1). The body is checked first (a bad one writes nothing, not even the seed). The
// name, mint and duplicate checks run inside the store's queue, against the file as it is at commit time (`writeThrough`).
// 201 `{rev, source: 'file', resource}`, the Resource with QA redaction.
const SEED_ACTOR = Object.freeze({ holder: 'hub-api', via: 'api' });
const SEED_TRIES = 3;

async function seedFirst(ctx, env) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await applySeed({ env, devices: ctx.devices, qaDevices: ctx.qaDevices, now: ctx.now, hostId: ctx.hostId, log: ctx.log?.err, actor: { ...SEED_ACTOR } });
    } catch (error) {
      // A writer committed between the seed's read and its queued write: the seed reads again, and a no-op seed is not a conflict.
      if (error?.code !== 'HUB_REGISTRY_CONFLICT' || attempt >= SEED_TRIES) throw error;
    }
  }
}

// The one write path of every Registry write route (register, edit, retire, and 6.10's register-from-discovery): the missing-file seed,
// the `if_rev` rule and `updateRegistry`. `plan({resources})` runs inside the store's queue against the file as it is at commit time and
// returns `{resources, ...}` (anything else it returns reaches the caller); a throw commits nothing. A missing file is the seed (AD-27):
// it is written first as its own revision; an `if_rev` other than 0 on a missing file is a conflict at rev 0, and 0 is accepted (the seed
// materialises what that client read). Only a missing file is seeded here; an existing one was seeded at start.
// Returns `{written, planned}`: the store's result and what `plan` returned.
async function writeThrough(ctx, { if_rev, reason, actor, why, plan }) {
  const env = ctx.env ?? process.env;
  const missing = registryState(env) === 'missing';
  if (if_rev !== undefined && if_rev !== 0 && missing) {
    throw Object.assign(new Error(`the Registry has no file yet (rev 0), not rev ${if_rev}`), { code: 'HUB_REGISTRY_CONFLICT', ...REGISTRY_ERRORS.HUB_REGISTRY_CONFLICT, rev: 0 });
  }
  const seeded = missing ? await seedFirst(ctx, env) : { first: false };
  let planned = null;
  const written = await updateRegistry({
    env,
    // The seed that was just written is what an `if_rev: 0` client read: no rev check for it.
    if_rev: seeded.first && if_rev === 0 ? undefined : if_rev,
    reason,
    actor,
    why,
    now: ctx.now,
    hostId: ctx.hostId,
    log: ctx.log?.err,
    change: ({ resources, pools }) => {
      planned = plan({ resources });
      return { resources: planned.resources, pools };
    },
  });
  return { written, planned };
}

export async function registerResource(ctx, { body }) {
  const input = checkRegisterBody(body, { hosts: HOST_PLATFORMS });
  const { written, planned } = await writeThrough(ctx, {
    if_rev: input.if_rev, reason: 'register', actor: input.actor, why: input.why, plan: current => planRegister(current, input, { now: ctx.now }),
  });
  return reply(201, { rev: written.rev, source: 'file', resource: viewRecord(planned.record, { audience: 'service' }) });
}

// POST /registry/resources/{id}: edits a Resource's name and Capabilities (FR-2). `if_rev` is required. 200 `{rev, source: 'file',
// resource}`; an edit that changes nothing commits and logs nothing and answers the current rev. The plan's refusals are planEdit's.
export async function editResource(ctx, { body, params }) {
  const input = checkEditBody(body);
  const { written, planned } = await writeThrough(ctx, {
    if_rev: input.if_rev, reason: 'edit', actor: input.actor, why: input.why, plan: current => planEdit(current, params.id, input),
  });
  return { rev: written.rev, source: 'file', resource: viewRecord(planned.record, { audience: 'service' }) };
}

// POST /registry/resources/{id}/retire: sets `retired_at` and touches nothing else (AD-31): the Hold stays and queued waiters are
// served; new takes are refused by the Claims library. 200 `{rev, source: 'file', id, retired_at, visibility}`, `visibility` `retiring`
// while the lock is held or waited on, else `hidden`. Retiring a retired Resource answers the same, at the same rev.
export async function retireResource(ctx, { body, params }) {
  const input = checkRetireBody(body);
  const { written, planned } = await writeThrough(ctx, {
    if_rev: input.if_rev, reason: 'retire', actor: input.actor, why: input.why, plan: current => planRetire(current, params.id, input, { now: ctx.now }),
  });
  const { record } = planned;
  const activity = (ctx.lockActivity ?? lockActivity)(record.lock, { env: ctx.env ?? process.env, now: ctx.now });
  return { rev: written.rev, source: 'file', id: record.id, retired_at: record.retired_at, visibility: visibility(record, { held: activity.held === true, queued: activity.queued === true }) };
}

// `shape` names the `### <Shape>` section of the contract document that lists the response's fields.
export const ROUTES = Object.freeze([
  Object.freeze({ method: 'GET', path: '/health', shape: 'Health', handler: health }),
  Object.freeze({ method: 'GET', path: '/resources', shape: 'ResourceList', handler: listResources }),
  Object.freeze({ method: 'GET', path: '/resources/{id}', shape: 'Resource', handler: getResource }),
  Object.freeze({ method: 'GET', path: '/pools', shape: 'PoolList', handler: listPools }),
  Object.freeze({ method: 'GET', path: '/discovery', shape: 'Discovery', handler: discovery }),
  Object.freeze({ method: 'POST', path: '/registry/resources', shape: 'Resource', handler: registerResource }),
  Object.freeze({ method: 'POST', path: '/registry/resources/{id}', shape: 'Resource', handler: editResource }),
  Object.freeze({ method: 'POST', path: '/registry/resources/{id}/retire', shape: 'Retirement', handler: retireResource }),
]);

// ---- dispatch ----

const pathOf = url => {
  const text = String(url ?? '');
  const cut = text.search(/[?#]/);
  return cut === -1 ? text : text.slice(0, cut);
};

// The parameters of `path` under a route pattern (`/resources/{id}`), or null when it does not match: segments compare one to one, a
// `{name}` segment takes one non-empty segment, URI-decoded (a bad escape is no match).
function matchPath(pattern, path) {
  const want = pattern.split('/');
  const have = path.split('/');
  if (want.length !== have.length) return null;
  const params = {};
  for (const [index, segment] of want.entries()) {
    const parameter = /^\{([a-z_]+)\}$/.exec(segment);
    if (parameter === null) {
      if (segment !== have[index]) return null;
    } else {
      if (have[index] === '') return null;
      try { params[parameter[1]] = decodeURIComponent(have[index]); } catch { return null; }
    }
  }
  return params;
}

// One request: `{method, url, body, bodyError}` (url as sent: path and query; body already parsed, or undefined; bodyError the error
// of a body that could not be read, answered only once the route is known, so a wrong path or method is still a 404 or 405) to
// `{status, headers, body}`. Never throws. `ctx.routes` (default ROUTES) is the route table; a handler error is logged once on `ctx.log.err` and answered as a 500.
export async function handle({ method, url, body, bodyError } = {}, ctx = {}) {
  const routes = ctx.routes ?? ROUTES;
  const path = pathOf(url);
  const verb = String(method ?? '').toUpperCase();
  // Every route whose path matches, then only the most literal tier (fewest parameters): a literal route wins over a parameterised one.
  const found = routes.map(route => ({ route, params: matchPath(route.path, path) })).filter(entry => entry.params !== null);
  const fewest = Math.min(...found.map(entry => Object.keys(entry.params).length));
  const onPath = found.filter(entry => Object.keys(entry.params).length === fewest).map(entry => entry.route);
  if (onPath.length === 0) return problem(routeError(404, 'HUB_NO_ROUTE', `no route ${path}`, 'no-route'));
  const route = onPath.find(candidate => candidate.method === verb);
  if (!route) {
    const allow = [...new Set(onPath.map(candidate => candidate.method))].sort().join(', ');
    return problem(routeError(405, 'HUB_NO_ROUTE', `${verb} is not allowed on ${path} (allowed: ${allow})`, 'method'), { Allow: allow });
  }
  if (bodyError) return problem(bodyError);
  try {
    const query = String(url ?? '').slice(path.length).replace(/^\?/, '').split('#')[0];
    const params = found.find(entry => entry.route === route).params;
    const result = await route.handler(ctx, { method: verb, path, query: new URLSearchParams(query), body, params });
    if (result?.[REPLY] === true) return respond(result.status, result.body);
    if (result === null || typeof result !== 'object') throw new TypeError(`the handler for ${verb} ${path} returned ${result === null ? 'null' : typeof result}, not an object`);
    return respond(200, result);
  } catch (error) {
    if (!hasStatus(error)) {
      try { ctx.log?.err?.(`HUB_API_ERROR ${verb} ${path} ${oneLine(error?.message ?? error)}`); } catch { /* a broken log seam never changes the answer */ }
    }
    return problem(error);
  }
}
