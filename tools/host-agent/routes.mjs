// The Host Agent's routes (Story 9.2, 9.3, AD-25, AD-41): the Hub API's route table and pure `handle()` (tools/hub-api/routes.mjs) over a smaller
// table. `GET /health`, `GET /status` (this host's own view, `statusView(<own key>, {audience: 'service', qa_ids})`, rendered here from
// this host's lock dir and clock) and the seven Hold routes, each behind forwarding (below) or the host gate. The agent is keyed by `hostKey()`, never by a
// literal `mac`, so it is the front door of any spoke host.
//
// Forwarding (AD-47, AD-48): a Hold route runs here only for a Resource that lives on this host. A request that names one on another host is sent
// there (Story 9.3), and a forward that names one is HUB_WRONG_HOST; the rules are written once in tools/device/forward.mjs and explained at `forwarding`
// below. What the agent knows of the Registry (`known.mjs`) is the Hub API's last answer, else the seed. The handler then runs with `ctx.fleet` set to
// this host's phones and the Resource the request names. There are no `/registry/*`, `/resources`, `/discovery` or `/stream` routes here: those are the Hub API's.
import { HOST_AGENT_SERVICE, HUB_API_CONTRACT } from '../hub-client.mjs';
import { hubRef } from '../ci/lib/receipt.mjs';
import { createContext, exitCodeOf, hostKey as realHostKey, isLocal, lanesOf, phonesOf, statusView } from '../device/claims.mjs';
import { NAMED, forwardHold, namedRecords, placeOf, retiredCarried, unseeded, unwrapCarried, withPlace, wrongHost } from '../device/forward.mjs';
import { ROUTES, reply } from '../hub-api/routes.mjs';
import { createKnown } from './known.mjs';

export const SERVICE = HOST_AGENT_SERVICE;

// What the agent knows, from the context: its `known`, or (a bare `handle()` with none) one built from the context's own seams, once.
const fallbacks = new WeakMap();
function knownOf(ctx) {
  if (ctx.known) return ctx.known;
  if (!fallbacks.has(ctx)) fallbacks.set(ctx, createKnown({ env: ctx.env, devices: ctx.devices, qaDevices: ctx.qaDevices, log: ctx.log }));
  return fallbacks.get(ctx);
}

// This host's key. An unknown host throws HUB_HOST_UNKNOWN, which the HTTP table answers 503 `host-unknown`.
const ownKey = ctx => (ctx.hostKey ?? realHostKey)({ env: ctx.env ?? process.env });

// This host's phones, from what the agent knows (`[]` on the Mac).
const fleetOf = (view, key) => phonesOf(view.resources.filter(record => isLocal(record, { hostKey: () => key })));
// The fleet of a Hold route that names nothing (a bare id): the phones plus this host's lanes, so a lane's Lease is found by its id. Status keeps `fleetOf`.
const holdFleet = (view, key, policy) => [...fleetOf(view, key), ...lanesOf(view.resources, key, policy)];

// GET /health: what is running and which contract it speaks. No `registry`: the agent has no Registry file.
export function agentHealth(ctx) {
  const env = ctx.env ?? process.env;
  return {
    ok: true,
    service: SERVICE,
    contract: HUB_API_CONTRACT,
    hub_version: hubRef(env) ?? 'unknown',
    ports: { hub_api: ctx.policy.api.hub_api_port, host_agent: ctx.policy.api.host_agent_port },
  };
}

// GET /status: this host's view, embedded unchanged from the Claims library. Every timestamp is this agent's clock and lock dir. The iPad is
// asked inside `statusView` (its `mac` branch) and only when a row names `ios-lane`: nothing here reads it at start or on a timer.
export function agentStatus(ctx) {
  const env = ctx.env ?? process.env;
  const key = ownKey(ctx);
  const known = knownOf(ctx);
  const statusCtx = createContext({
    env, now: ctx.now, policy: ctx.policy, devicectl: ctx.devicectl, hostKey: ctx.hostKey, inventory: ctx.inventory,
    processStart: ctx.processStart, liveStart: ctx.liveStart, fleet: fleetOf(known.current(), key),
  });
  return statusView(key, { audience: 'service', qa_ids: known.qaIds() }, statusCtx);
}

// ---- forwarding (Story 9.3) ----

// A Hold route runs here for a Resource of this host and goes to the host it lives on for any other (tools/device/forward.mjs has the rules; the Hub
// API's `hubHold` is the same wrapper for big-chungus). After the route's own body check (so a bad body is still the 400):
//   - a forward (header `X-Hub-Forwarded`, `resource: {id, lock, host, rev, retired_at}`) is acted on as carried: its host must be this one
//     (HUB_WRONG_HOST), `rev: 0` (the sender had only its seed) only for a Resource this agent's own seed has (400 `unseeded`), a take of a
//     retired one is 409 HUB_RESOURCE_RETIRED, and then the route's handler runs with the carried lock in its fleet. A forward that names a Resource
//     of another host is HUB_WRONG_HOST and is never forwarded again;
//   - a public request that names something first asks the Hub API for its Resources (`known.refresh` through `ctx.request`; with it down the seed
//     answers at `rev: 0`); Resources on one other host are forwarded there as the door `host-agent` and its answer is relayed as it came;
//     a Resource of this host runs here (a take of a retired one is refused), and one that names nothing known passes to the handler, which refuses it.
// The handler runs with `ctx.fleet` set to this host's phones plus the Resource the request names. A Reservation's force-release is never forwarded:
// it is gated by its `name`, and a Reservation on another host is HUB_WRONG_HOST. There are no `/registry/*`, `/resources`, `/discovery` or
// `/stream` routes here: those are the Hub API's.
const keyOfRoute = route => `${route.method} ${route.path}`;
const relayed = answer => (answer.status === 200 ? answer.body : reply(answer.status, answer.body));

// The fleet with the Resource a request names in it, and the request naming it by the word the Claims library finds it by (its `device`): a word like
// `ipad` or a carried id is the same Resource, whatever it was called.
function placed(fleet, record, request, view, policy) {
  const entries = withPlace(fleet, record, view, policy);
  const device = entries.find(phone => phone.lock === record.lock)?.device ?? record.id;
  const named = typeof request.body?.resource === 'string' && request.body.resource !== device ? { ...request, body: { ...request.body, resource: device } } : request;
  return { fleet: entries, request: named };
}

function forwarding(route) {
  const key = keyOfRoute(route);
  const named = NAMED[key];
  const local = route.local ?? route.handler;
  return async (ctx, given) => {
    const own = ownKey(ctx);
    const { door, carried, request } = unwrapCarried(given);
    const input = named.check(request.body);
    const known = knownOf(ctx);
    const policy = ctx.policy ?? null;
    if (door !== null) {
      const view = known.current();
      if (carried !== null) {
        if (carried.host !== own) throw wrongHost(carried, own);
        if (carried.rev === 0 && !view.seeded.includes(carried.id)) throw unseeded(carried);
        if (carried.retired_at !== null && key === 'POST /leases') throw retiredCarried(carried);
        const at = placed(fleetOf(view, own), carried, request, view, policy);
        return local({ ...ctx, fleet: at.fleet }, at.request);
      }
      const foreign = namedRecords(key, input, request, view, policy).records.find(record => record.host !== own);
      if (foreign) throw wrongHost(foreign, own);
      return local({ ...ctx, fleet: holdFleet(view, own, policy) }, request);
    }
    if (ctx.request && named.names(input, request).length > 0) await known.refresh({ request: ctx.request });
    const view = known.current();
    const { records, single } = namedRecords(key, input, request, view, policy);
    const host = placeOf(records, own);
    if (host !== null) return relayed(await forwardHold({ key, request, input, place: { host, records, single }, rev: view.rev, door: 'host-agent', ctx }));
    if (single && key === 'POST /leases' && single.retired_at) throw retiredCarried(single);
    if (single) {
      const at = placed(fleetOf(view, own), single, request, view, policy);
      return local({ ...ctx, fleet: at.fleet }, at.request);
    }
    return local({ ...ctx, fleet: holdFleet(view, own, policy) }, request);
  };
}

// The gate of a route that is never forwarded: a Resource on another host is HUB_WRONG_HOST, nothing written.
function gated(route) {
  const key = keyOfRoute(route);
  const named = NAMED[key];
  return (ctx, request) => {
    const input = named.check(request.body);
    const own = ownKey(ctx);
    const view = knownOf(ctx).current();
    const foreign = namedRecords(key, input, request, view, ctx.policy ?? null).records.find(record => record.host !== own);
    if (foreign) throw wrongHost(foreign, own);
    return route.handler({ ...ctx, fleet: holdFleet(view, own, ctx.policy ?? null) }, request);
  };
}

// POST /agent/sync (Story 10.1): hands the agent the Hub API's replica sizes and makes it push from them (`/history` calls it
// when a range the replica lacks is requested). The body is `{replica: {<YYYY-MM>: <a whole number of bytes, 0 or more>}}` and
// nothing else (`HUB_USAGE` 400 `bad-body`; a `replica` that is not such a map is `bad-replica`). `ctx.sync` is the pusher's:
// it adopts the sizes, pushes (draining the oldest differing month first) and answers `{pushed, synced, replica}`.
const SYNC_MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const badSync = (reason, message) => Object.assign(new Error(message), { status: 400, code: 'HUB_USAGE', exit: exitCodeOf({ code: 'HUB_USAGE' }), reason });
const isPlain = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export async function agentSync(ctx, { body }) {
  if (!isPlain(body)) throw badSync('bad-body', 'the body must be a JSON object');
  for (const key of Object.keys(body)) if (key !== 'replica') throw badSync('bad-body', `the body has no key "${key}" (replica)`);
  if (!Object.hasOwn(body, 'replica')) throw badSync('bad-body', 'the body needs "replica"');
  if (!isPlain(body.replica)) throw badSync('bad-replica', 'replica must be an object keyed by month (YYYY-MM)');
  for (const [month, size] of Object.entries(body.replica)) {
    if (!SYNC_MONTH.test(month)) throw badSync('bad-replica', `replica's key "${month}" is not a month (YYYY-MM)`);
    if (!Number.isSafeInteger(size) || size < 0) throw badSync('bad-replica', `replica's "${month}" must be a whole number of bytes, 0 or more`);
  }
  return ctx.sync(body.replica);
}

// The Hub API's Hold routes (the same method, path and shape), behind forwarding or the gate.
const HOLD_ROUTES = Object.freeze(Object.keys(NAMED));

export const AGENT_ROUTES = Object.freeze([
  Object.freeze({ method: 'GET', path: '/health', shape: 'AgentHealth', handler: agentHealth }),
  Object.freeze({ method: 'GET', path: '/status', shape: 'HostView', handler: agentStatus }),
  Object.freeze({ method: 'POST', path: '/agent/sync', shape: 'AgentSync', handler: agentSync }),
  ...ROUTES.filter(route => HOLD_ROUTES.includes(keyOfRoute(route))).map(route => Object.freeze({ ...route, handler: NAMED[keyOfRoute(route)].forward ? forwarding(route) : gated(route) })),
]);
