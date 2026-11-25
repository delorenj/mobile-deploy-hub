// The Hub API's routes (AD-42, FR-21): a route table and a pure `handle()` over it, with no socket in this file. server.mjs puts a node
// `http` adapter in front, and a test calls `handle()` directly. The envelope (headers, problem+json, the 404 and 405 rules) is written
// once and takes the route table as a parameter, so the Host Agent (Epic 7) reuses it and every route story adds one row to `ROUTES`, one
// row and one `### <Shape>` section to docs/hub-api-contract.md, and nothing else (tools/hub-api/contract.test.mjs holds the two equal).
//
// Every response carries `Cache-Control: no-store` and snake_case keys. Success is `application/json`; an error is
// `application/problem+json` with exactly {type, title, status, detail, code, exit, reason}, where `exit` is what a CLI front door
// exits with for the same error (claims.mjs's one table). Paths match exactly: no prefix, no trailing-slash folding, and the query
// string is ignored for routing. A `{name}` segment in a route path is a parameter: one non-empty, URI-decoded segment, handed to the
// handler as `request.params`; a literal route wins over a parameterised one.
import { STATUS_CODES } from 'node:http';
import { exitCodeOf, lockActivity } from '../device/claims.mjs';
import { hubRef } from '../ci/lib/receipt.mjs';
import { retirement } from '../registry/match.mjs';
import { readRegistry, registryState } from '../registry/store.mjs';
import { viewPools, viewRecord } from '../registry/view.mjs';

export const CONTRACT_VERSION = 1;
export const SERVICE = 'mobile-deploy-hub-api';

const JSON_TYPE = 'application/json; charset=utf-8';
const PROBLEM_TYPE = 'application/problem+json';
const BASE_HEADERS = Object.freeze({ 'Cache-Control': 'no-store' });

// A handler returns its body (an object, status 200), or `reply(status, body)` for another success status (a 201 later).
const REPLY = Symbol('reply');
export const reply = (status, body) => ({ [REPLY]: true, status, body });

const respond = (status, body, extra = {}) => ({ status, headers: { ...BASE_HEADERS, 'Content-Type': JSON_TYPE, ...extra }, body });

// The problem+json response for an error. An error with a `status` (the library's and the API's own coded errors) keeps its code and
// exit; anything else is a bug in a handler: 500 HUB_API_ERROR.
const hasStatus = error => Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599;
const oneLine = value => String(value).replace(/\s+/g, ' ').trim();

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

// GET /resources: every visible Resource (visible or retiring), in the Registry's order.
export function listResources(ctx) {
  const registry = readIt(ctx);
  return { rev: registry.rev, source: registry.source, resources: registry.resources.map(record => serve(ctx, record)).filter(Boolean) };
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

// `shape` names the `### <Shape>` section of the contract document that lists the response's fields.
export const ROUTES = Object.freeze([
  Object.freeze({ method: 'GET', path: '/health', shape: 'Health', handler: health }),
  Object.freeze({ method: 'GET', path: '/resources', shape: 'ResourceList', handler: listResources }),
  Object.freeze({ method: 'GET', path: '/resources/{id}', shape: 'Resource', handler: getResource }),
  Object.freeze({ method: 'GET', path: '/pools', shape: 'PoolList', handler: listPools }),
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
