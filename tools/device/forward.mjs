// Forwarding a Hold action to the host that owns the Resource (Story 9.3, AD-25, AD-47, AD-48). The Hub API, the Host Agent and `hub-device`
// act in-process on what lives on their own host and send the rest to the host it lives on, so no host ever writes another host's lock dir.
// This file is where that is decided, once, for all three front doors; the only transport is `hub-client.mjs` (`request`, `forward`).
//
// A forward is the public route plus the header `X-Hub-Forwarded: <door>` (the front door that sent it: `cli`, `api`, `host-agent`) plus the
// body key `resource: {id, lock, host, rev, retired_at}` when the request names one Resource. The receiving rules are the same everywhere:
//   - big-chungus (the Hub API) takes the carried record down to its `id` and re-resolves that against `registry.json`: it acts on what it
//     finds, never on what it was told;
//   - the Host Agent acts on the carried record: its `lock` and `host`, the retired check on its `retired_at`, and `rev: 0` (the sender had only
//     the seed) only for a Resource the agent's own seed has;
//   - a forward that names a Resource on another host is `HUB_WRONG_HOST` and is never forwarded again.
//
// The Hold routes and what each one names (`NAMED`) are written here once: the body check, the Resources the request names (`namedRecords`,
// the word and match resolution that used to live in the agent's host gate) and `placeOf` (the one foreign host they all live on, else null).
// `hubView` is big-chungus' view of the Registry (the file, else the seed); `peerView` is any other host's (the Hub API's last answer through
// `hub-client`, else the in-memory seed at `rev: 0`).
//
// The deploy path never imports this file (tools/deploy-path.test.mjs). No timer here.
import { deployTargetCapMs } from '../ci/lib/lock.mjs';
import { loadPolicy } from '../ci/lib/policy.mjs';
import { FORWARD_DOORS, FORWARD_HEADER, forward, request as hubRequest } from '../hub-client.mjs';
import { createKnown } from '../host-agent/known.mjs';
import { match, parseQuery } from '../registry/match.mjs';
import { readRegistry } from '../registry/store.mjs';
import { HOST_PLATFORMS, checkCancelBody, checkExtendBody, checkForceReleaseBody, checkLeaseBody, checkReleaseBody, checkReservationForceReleaseBody, exitCodeOf, hostKey as realHostKey, namesEmulatorSlot, newLeaseId } from './claims.mjs';

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isText = value => typeof value === 'string' && value.trim() !== '';
const usageError = (reason, message) => Object.assign(new Error(message), { code: 'HUB_USAGE', reason });

// ---- errors ----

// A Resource on another host: HUB_WRONG_HOST (409, exit 2), nothing written.
export const wrongHost = (record, own) => Object.assign(
  new Error(`${record.id} is on host ${record.host}; this is host ${own}, and a host acts only on its own Resources`),
  { code: 'HUB_WRONG_HOST', exit: exitCodeOf({ code: 'HUB_WRONG_HOST' }) },
);

// A carried record that says `rev: 0` (the sender resolved from its seed) for a Resource this host's own seed does not have.
export const unseeded = record => usageError('unseeded', `${record.id} came with rev 0 (the sender had only its seed), and this host's seed has no such Resource`);

// A new take of a Resource the carried record says is retired (a Lease it already holds ends as usual: only a take is refused).
export const retiredCarried = record => Object.assign(
  new Error(`${record.id} is retired (reason: retired): it takes no new lease; a lease it already holds ends as usual`),
  { code: 'HUB_RESOURCE_RETIRED', status: 409, reason: 'retired', resource: record.id },
);

// ---- the header and the carried record ----

// The door a request was forwarded by, or null for a public request. `headers` are the request's, keys lower-cased by the adapter (any case is found).
// A value that is not one of the doors is HUB_USAGE `bad-forward`.
export function forwardedDoor(headers) {
  const entry = Object.entries(headers ?? {}).find(([name]) => name.toLowerCase() === FORWARD_HEADER.toLowerCase());
  if (entry === undefined) return null;
  if (typeof entry[1] !== 'string' || !FORWARD_DOORS.includes(entry[1])) throw usageError('bad-forward', `${FORWARD_HEADER} must be one of ${FORWARD_DOORS.join(', ')}`);
  return entry[1];
}

// The carried record of a Registry record at the revision the sender resolved it at.
export const carried = (record, rev) => ({ id: record.id, lock: record.lock, host: record.host, rev, retired_at: record.retired_at ?? null });

const CARRIED_KEYS = Object.freeze(['id', 'lock', 'host', 'rev', 'retired_at']);
// A Resource id and a lock name are slugs: the lock names a file in the lock dir, so nothing else may reach it.
const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

// Checks a carried record: exactly `{id, lock, host, rev, retired_at}`, the id and the lock slugs, `host` a host key, `rev` a whole number (0 or
// more) and `retired_at` null (or absent) or a string. HUB_USAGE `bad-resource`. Returns the record with `retired_at` null when absent.
export function checkCarried(value) {
  const bad = why => usageError('bad-resource', `the carried resource ${why}: it is {id, lock, host, rev, retired_at}`);
  if (!isObject(value)) throw bad('is not an object');
  for (const key of Object.keys(value)) if (!CARRIED_KEYS.includes(key)) throw bad(`has the key "${key}"`);
  if (typeof value.id !== 'string' || !NAME.test(value.id)) throw bad('has no id that is a Resource id');
  if (typeof value.lock !== 'string' || !NAME.test(value.lock)) throw bad('has no lock that is a lock name');
  if (typeof value.host !== 'string' || !Object.hasOwn(HOST_PLATFORMS, value.host)) throw bad(`has a host that is not one of ${Object.keys(HOST_PLATFORMS).join(', ')}`);
  if (!Number.isSafeInteger(value.rev) || value.rev < 0) throw bad('has a rev that is not a whole number');
  if (value.retired_at !== undefined && value.retired_at !== null && typeof value.retired_at !== 'string') throw bad('has a retired_at that is neither null nor a string');
  return { id: value.id, lock: value.lock, host: value.host, rev: value.rev, retired_at: value.retired_at ?? null };
}

// The route request of a forward with its carried record taken down to the id (the form every body check reads): `{door, carried, request}`.
// `door` is null for a public request; `carried` is null when the body carries no record (a word, a Pool word or a `match`). An object `resource`
// is a forward's: without the header it is `bad-resource`.
export function unwrapCarried(request) {
  const door = forwardedDoor(request.headers);
  if (!isObject(request.body) || !isObject(request.body.resource)) return { door, carried: null, request };
  if (door === null) throw usageError('bad-resource', `an object resource is a forward's: it needs the ${FORWARD_HEADER} header (a public request names a Resource by a string)`);
  const record = checkCarried(request.body.resource);
  return { door, carried: record, request: { ...request, body: { ...request.body, resource: record.id } } };
}

// ---- what a Hold route names ----

const wordNamed = word => (typeof word === 'string' && word !== '' ? [{ word }] : []);

// One entry per Hold route (its key is `<METHOD> <path>`): `check` is the route's own pure body check, `names(input, request)` the device words or `match`
// queries the request names, and `forward` whether the route is forwarded (a Reservation's force-release is gated by its `name`, never forwarded).
export const NAMED = Object.freeze({
  'POST /leases': Object.freeze({ check: checkLeaseBody, names: input => (input.match !== null ? [{ match: input.match }] : wordNamed(input.resource)), forward: true }),
  'GET /leases/{id}': Object.freeze({ check: () => null, names: () => [], forward: true }),
  'POST /leases/{id}/extend': Object.freeze({ check: checkExtendBody, names: input => wordNamed(input.resource), forward: true }),
  'POST /leases/{id}/release': Object.freeze({ check: checkReleaseBody, names: input => wordNamed(input.resource), forward: true }),
  'POST /leases/{id}/force-release': Object.freeze({ check: checkForceReleaseBody, names: (input, { params }) => (namesEmulatorSlot(params?.id) ? [{ word: 'emulator' }] : wordNamed(input.resource)), forward: true }),
  'POST /requests/{id}/cancel': Object.freeze({ check: checkCancelBody, names: input => [...wordNamed(input.resource), ...wordNamed(input.pool)], forward: true }),
  'POST /reservations/{run_key}/force-release': Object.freeze({ check: checkReservationForceReleaseBody, names: input => wordNamed(input.name), forward: false }),
});

// The Resource a device word names by id, name or lock, then by a seed word (`ipad`): null when it is none of those (a Pool word names several).
function directOf(word, view) {
  const { resources, words = [] } = view;
  const direct = resources.find(record => record.id === word) ?? resources.find(record => record.name === word) ?? resources.find(record => record.lock === word);
  if (direct) return direct;
  const wordId = words.find(entry => entry.words.includes(word))?.id;
  return wordId === undefined ? null : resources.find(record => record.id === wordId) ?? null;
}

// The Resources a device word stands for: the one it names, else a Pool word's members (or its gate's Resource).
function resourcesOfWord(word, view) {
  const direct = directOf(word, view);
  if (direct) return [direct];
  const { resources, pools = {} } = view;
  const pool = Object.hasOwn(pools, word) ? pools[word] : undefined;
  if (Array.isArray(pool?.members)) return pool.members.map(id => resources.find(record => record.id === id)).filter(Boolean);
  if (typeof pool?.gate === 'string') return resources.filter(record => record.lock === pool.gate);
  return [];
}

// The Resources a `match` query stands for: the emulator Pool for a `profile=` clause, else the matcher's members over the view. A query that
// does not parse or matches nothing names none: the handler refuses it as it always does.
function resourcesOfMatch(text, view, policy) {
  let clauses;
  try { clauses = parseQuery(text); } catch { return []; }
  if (clauses.some(clause => clause.key === 'profile')) return view.resources.filter(record => record.kind === 'emulator-pool');
  try { return match({ resources: view.resources, pools: view.pools }, { query: clauses }, policy ?? loadPolicy().policy).members; } catch { return []; }
}

// The Resources a request names, in the view `view` (`{rev, seeded, resources, pools, words}`): `{records, single}`. `single` is the one Resource a lone
// device word names directly (what a forward carries), else null: a Pool word, a `match` and a cancel that names a Pool carry no record. Never throws.
export function namedRecords(key, input, request, view, policy = null) {
  const names = NAMED[key]?.names(input, request) ?? [];
  const records = [];
  for (const named of names) records.push(...(named.match !== undefined ? resourcesOfMatch(named.match, view, policy) : resourcesOfWord(named.word, view)));
  // The emulator Pool is a Pool, not one Resource: it goes as its word, with no carried record.
  const direct = names.length === 1 && names[0].word !== undefined ? directOf(names[0].word, view) : null;
  const single = direct?.kind === 'emulator-pool' ? null : direct;
  return { records, single };
}

// Where a request lives: the one foreign host every Resource it names is on, else null (it names nothing, or a Resource of this host, or Resources on
// more than one host: those stay in-process, and the Claims library refuses a Pool across hosts, HUB_POOL_CROSS_HOST).
export function placeOf(records, own) {
  const hosts = new Set(records.map(record => record.host));
  if (hosts.size !== 1) return null;
  const [host] = hosts;
  return host === own ? null : host;
}

// ---- views ----

const wordsOf = resources => resources.filter(record => Array.isArray(record.words) && record.words.length > 0).map(record => ({ id: record.id, words: [...record.words] }));

// Big-chungus' view: `registry.json`, else the seed (`readRegistry`; `ctx.registry()` replaces it, as for `--match`). `{rev, seeded, resources, pools, words}`.
export function hubView(ctx) {
  const env = ctx.env ?? process.env;
  const registry = ctx.registry?.() ?? readRegistry({ env, devices: ctx.devices, qaDevices: ctx.qaDevices, warn: ctx.warn });
  return { rev: registry.rev, seeded: registry.resources.filter(record => record.seeded === true).map(record => record.id), resources: registry.resources, pools: registry.pools, words: wordsOf(registry.resources) };
}

// Any other host's view: the Hub API's last answer (`GET /resources` through `request`, the hub-client's), else this host's own seed at `rev: 0`. A failed
// answer is silent here (the caller forwards with `rev: 0`). `known` reuses a Host Agent's own.
export async function peerView({ env, devices, qaDevices, request, known } = {}) {
  const view = known ?? createKnown({ env, devices, qaDevices });
  await view.refresh({ request });
  return view.current();
}

// ---- acting on a carried record ----

// The fleet with the Resource a forward carries in it, as `{device, lock, deploy}`: the Claims library finds every Hold through its fleet, so
// release, extend, cancel and take then act on exactly the carried lock. `deploy` is the Registry's `deploy_target` (else the policy's own deploy locks),
// so taking the iPad lane gets the 60 min deploy cap.
export function withPlace(fleet, record, view, policy = null) {
  if (fleet.some(phone => phone.lock === record.lock)) return fleet;
  const known = view?.resources?.find(entry => entry.id === record.id);
  const deploy = known?.deploy_target === true || deployTargetCapMs(record.lock, { policy }) !== null;
  const name = known?.name ?? record.id;
  return [...fleet, { device: name, lock: record.lock, deploy, name: known?.display_name ?? name, serial: known?.identity?.serial ?? null, model: known?.identity?.model ?? null }];
}

// ---- forwarding ----

const ownKey = ctx => (ctx.hostKey ?? realHostKey)({ env: ctx.env ?? process.env });

// The one transport of a front door: `ctx.request` (a test's bridge, or the Host Agent's `send`), else the hub-client's `request` with the context's
// policy, devices, host key and seams.
export const transportOf = ctx => ctx.request ?? (args => hubRequest(args, {
  policy: ctx.policy ?? undefined,
  ...(ctx.devices ? { devices: ctx.devices } : {}),
  hostKey: () => ownKey(ctx),
  ...(ctx.fetchImpl ? { fetchImpl: ctx.fetchImpl } : {}),
  ...(ctx.sshImpl ? { sshImpl: ctx.sshImpl } : {}),
}));

// Sends one Hold request to `place.host` as `door` and answers `{status, body}` (hub-client `forward`: the far side's problem is thrown as itself, a
// host that does not answer is HUB_DEVICE_AWAY). `request` is the route's request (`{method, path, body, signal}`; a CLI builds the same), `input` its
// checked body, `place` `{host, records, single}`, `rev` the view's revision. The body is the request's own with:
//   - the actor set to the sender's when the request has none (`{holder, via: door}`): the first front door that sees none sets it, a forwarder passes it unchanged;
//   - `resource` the carried record when one Resource is named (a Pool word or a match goes as it is);
//   - on a take, a client-minted `id` when it has none, so a retried forward takes no second Lease (a repeat of the id and holder answers the existing one);
//   - on a cancel, `host` (the target's key); its `pool` is the request's own.
// The call is bound by the wait plus, for an emulator take, the boot budget. The transport is `transportOf(ctx)`.
export async function forwardHold({ key, request, input, place, rev, door, ctx }) {
  const body = isObject(request.body) ? { ...request.body } : {};
  body.actor = input.actor ?? { holder: input.holder, via: door };
  if (place.single) body.resource = carried(place.single, rev);
  const emulator = place.records.some(record => record.kind === 'emulator-pool');
  if (key === 'POST /leases' && body.id === undefined) body.id = newLeaseId(emulator ? 'emulator' : 'lease');
  if (key === 'POST /requests/{id}/cancel' && body.host === undefined) body.host = place.host;
  const taking = key === 'POST /leases';
  const waitMs = taking && Number.isSafeInteger(body.wait_ms) ? body.wait_ms : 0;
  const boot = ctx.emulator?.bootTimeoutMs ?? (Number(ctx.env?.HUB_EMULATOR_BOOT_TIMEOUT_MS) || 360_000);
  const budgetMs = taking && emulator ? boot : 0;
  return forward({ host: place.host, method: request.method, path: request.path, body, door, waitMs, budgetMs, signal: request.signal }, { request: transportOf(ctx) });
}
