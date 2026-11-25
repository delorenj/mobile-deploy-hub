// The Hub API's routes (AD-42, FR-21): a route table and a pure `handle()` over it, with no socket in this file. server.mjs puts a node
// `http` adapter in front, and a test calls `handle()` directly. The envelope (headers, problem+json, the 404 and 405 rules) is written
// once and takes the route table as a parameter, so the Host Agent (Epic 7) reuses it and every route story adds one row to `ROUTES`, one
// row and one `### <Shape>` section to docs/hub-api-contract.md, and nothing else (tools/hub-api/contract.test.mjs holds the two equal).
//
// Every response carries `Cache-Control: no-store` and snake_case keys. Success is `application/json`; an error is
// `application/problem+json` with exactly {type, title, status, detail, code, exit, reason}, where `exit` is what a CLI front door
// exits with for the same error (claims.mjs's one table). Paths match exactly: no prefix, no trailing-slash folding, and the query
// string is ignored for routing.
import { STATUS_CODES } from 'node:http';
import { exitCodeOf } from '../device/claims.mjs';
import { hubRef } from '../ci/lib/receipt.mjs';
import { registryState } from '../registry/store.mjs';

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

// `shape` names the `### <Shape>` section of the contract document that lists the response's fields.
export const ROUTES = Object.freeze([
  Object.freeze({ method: 'GET', path: '/health', shape: 'Health', handler: health }),
]);

// ---- dispatch ----

const pathOf = url => {
  const text = String(url ?? '');
  const cut = text.search(/[?#]/);
  return cut === -1 ? text : text.slice(0, cut);
};

// One request: `{method, url, body, bodyError}` (url as sent: path and query; body already parsed, or undefined; bodyError the error
// of a body that could not be read, answered only once the route is known, so a wrong path or method is still a 404 or 405) to
// `{status, headers, body}`. Never throws. `ctx.routes` (default ROUTES) is the route table; a handler error is logged once on `ctx.log.err` and answered as a 500.
export async function handle({ method, url, body, bodyError } = {}, ctx = {}) {
  const routes = ctx.routes ?? ROUTES;
  const path = pathOf(url);
  const verb = String(method ?? '').toUpperCase();
  const onPath = routes.filter(route => route.path === path);
  if (onPath.length === 0) return problem(routeError(404, 'HUB_NO_ROUTE', `no route ${path}`, 'no-route'));
  const route = onPath.find(candidate => candidate.method === verb);
  if (!route) {
    const allow = [...new Set(onPath.map(candidate => candidate.method))].sort().join(', ');
    return problem(routeError(405, 'HUB_NO_ROUTE', `${verb} is not allowed on ${path} (allowed: ${allow})`, 'method'), { Allow: allow });
  }
  if (bodyError) return problem(bodyError);
  try {
    const query = String(url ?? '').slice(path.length).replace(/^\?/, '').split('#')[0];
    const result = await route.handler(ctx, { method: verb, path, query: new URLSearchParams(query), body });
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
