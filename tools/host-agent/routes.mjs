// The Host Agent's routes (Story 9.2, AD-25, AD-41): the Hub API's route table and pure `handle()` (tools/hub-api/routes.mjs) over a smaller
// table. `GET /health`, `GET /status` (this host's own view, `statusView(<own key>, {audience: 'service', qa_ids})`, rendered here from
// this host's lock dir and clock) and the seven Hold routes, each behind the host gate. The agent is keyed by `hostKey()`, never by a
// literal `mac`, so it is the front door of any spoke host.
//
// The host gate (AD-47): a Hold route runs only for a Resource that lives on this host. After the route's own body check (so a bad body
// is still the 400), the Resource the request names is found in what the agent knows (`known.mjs`: the Hub API's last answer, else the
// seed) and one on another host is `HUB_WRONG_HOST` (409, exit 2) with nothing written. A name nothing knows passes to the handler, which
// refuses it as it always does. The handler then runs with `ctx.fleet` set to this host's phones. There are no `/registry/*`,
// `/resources`, `/discovery` or `/stream` routes here: those are the Hub API's.
import { HOST_AGENT_SERVICE, HUB_API_CONTRACT } from '../hub-client.mjs';
import { hubRef } from '../ci/lib/receipt.mjs';
import { checkCancelBody, checkForceReleaseBody, checkLeaseBody, checkReservationForceReleaseBody, createContext, exitCodeOf, hostKey as realHostKey, isLocal, namesEmulatorSlot, phonesOf, statusView } from '../device/claims.mjs';
import { match, parseQuery } from '../registry/match.mjs';
import { ROUTES } from '../hub-api/routes.mjs';
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

// ---- the host gate ----

const wrongHost = (record, own) => Object.assign(
  new Error(`${record.id} is on host ${record.host}; this is host ${own}, and a host acts only on its own Resources`),
  { code: 'HUB_WRONG_HOST', exit: exitCodeOf({ code: 'HUB_WRONG_HOST' }) },
);

// The Resources a device word stands for: by id, name or lock, then by a seed word (`ipad`), then a Pool word (its members, or its gate's Resource).
function resourcesOfWord(word, view) {
  const { resources, pools, words } = view;
  const direct = resources.find(record => record.id === word) ?? resources.find(record => record.name === word) ?? resources.find(record => record.lock === word);
  if (direct) return [direct];
  const wordId = words.find(entry => entry.words.includes(word))?.id;
  const worded = wordId === undefined ? undefined : resources.find(record => record.id === wordId);
  if (worded) return [worded];
  const pool = Object.hasOwn(pools, word) ? pools[word] : undefined;
  if (Array.isArray(pool?.members)) return pool.members.map(id => resources.find(record => record.id === id)).filter(Boolean);
  if (typeof pool?.gate === 'string') return resources.filter(record => record.lock === pool.gate);
  return [];
}

// The Resources a `match` query stands for: the emulator Pool for a `profile=` clause, else the matcher's members over what the agent knows.
// A query that does not parse or matches nothing names none: the handler refuses it as it always does.
function resourcesOfMatch(text, view, policy) {
  let clauses;
  try { clauses = parseQuery(text); } catch { return []; }
  if (clauses.some(clause => clause.key === 'profile')) return view.resources.filter(record => record.kind === 'emulator-pool');
  try { return match({ resources: view.resources, pools: view.pools }, { query: clauses }, policy).members; } catch { return []; }
}

// One gate per Hold route: `check` is the route's own pure body check, `names(input, request)` the Resources the request names.
const wordNamed = word => (typeof word === 'string' && word !== '' ? [{ word }] : []);
const GATES = Object.freeze({
  'POST /leases': { check: checkLeaseBody, names: input => (input.match !== null ? [{ match: input.match }] : wordNamed(input.resource)) },
  'POST /leases/{id}/force-release': { check: checkForceReleaseBody, names: (_, { params }) => (namesEmulatorSlot(params.id) ? [{ word: 'emulator' }] : []) },
  'POST /requests/{id}/cancel': { check: checkCancelBody, names: input => [...wordNamed(input.resource), ...wordNamed(input.pool)] },
  'POST /reservations/{run_key}/force-release': { check: checkReservationForceReleaseBody, names: input => wordNamed(input.name) },
});

const keyOfRoute = route => `${route.method} ${route.path}`;

// The route's handler behind the gate: body check, key, the named Resources (any on another host is HUB_WRONG_HOST), then the handler
// with this host's phones as its fleet. A route with nothing to name (extend, release, `GET /leases/{id}`) only gets the fleet.
function gated(route) {
  const gate = GATES[keyOfRoute(route)];
  return (ctx, request) => {
    const input = gate?.check(request.body);
    const key = ownKey(ctx);
    const view = knownOf(ctx).current();
    for (const named of gate?.names(input, request) ?? []) {
      const records = named.match !== undefined ? resourcesOfMatch(named.match, view, ctx.policy) : resourcesOfWord(named.word, view);
      const foreign = records.find(record => record.host !== key);
      if (foreign) throw wrongHost(foreign, key);
    }
    return route.handler({ ...ctx, fleet: fleetOf(view, key) }, request);
  };
}

// The Hub API's Hold routes (the same method, path and shape), behind the gate.
const HOLD_ROUTES = Object.freeze(['POST /leases', 'GET /leases/{id}', 'POST /leases/{id}/extend', 'POST /leases/{id}/release', 'POST /leases/{id}/force-release', 'POST /requests/{id}/cancel', 'POST /reservations/{run_key}/force-release']);

export const AGENT_ROUTES = Object.freeze([
  Object.freeze({ method: 'GET', path: '/health', shape: 'AgentHealth', handler: agentHealth }),
  Object.freeze({ method: 'GET', path: '/status', shape: 'HostView', handler: agentStatus }),
  ...ROUTES.filter(route => HOLD_ROUTES.includes(keyOfRoute(route))).map(route => Object.freeze({ ...route, handler: gated(route) })),
]);
