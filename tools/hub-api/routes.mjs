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
import { HOST_PLATFORMS, cancel, checkCancelBody, checkExtendBody, checkForceReleaseBody, checkLeaseBody, checkReleaseBody, checkReservationForceReleaseBody, createContext, discover as discoverHost, exitCodeOf, findLease, forceReleaseEmulator, forceReleaseLease, forceReleaseReservation, hostKey as realHostKey, httpAnswerOf, leaseRequestId, loadFleet, lockActivity, namesEmulatorSlot, restartingError, serviceExtend, serviceLease, serviceRelease, statusView } from '../device/claims.mjs';
import { hubRef } from '../ci/lib/receipt.mjs';
import { NAMED, forwardHold, hubView, namedRecords, placeOf, transportOf, unwrapCarried, wrongHost } from '../device/forward.mjs';
import { NO_READING, serve as serveReading } from '../registry/reachability.mjs';
import { dedicatedQaIds, loadQaDevices } from '../registry/seed.mjs';
import { retirement, visibility } from '../registry/match.mjs';
import { checkEditBody, checkRegisterBody, checkRetireBody, planEdit, planRegister, planRetire } from '../registry/changes.mjs';
import { REGISTRY_ERRORS, applySeed, readRegistry, registryState, updateRegistry } from '../registry/store.mjs';
import { viewPools, viewRecord } from '../registry/view.mjs';
import { createHistory, queryHistory } from './history.mjs';
import { createPeers, failureReason, isContact, isUnreached, offlineView } from './peers.mjs';
import { deviceCtx } from './readings.mjs';
import { checkPushBody, createRemotes } from './remotes.mjs';
import { createReplicas } from './replica.mjs';
import { STREAM_HEADERS } from './stream.mjs';

// One name and one contract number for the service: the server answers with them, and the installer's readback and the smoke check for them.
import { HUB_API_CONTRACT, HUB_API_SERVICE } from '../hub-client.mjs';
export const CONTRACT_VERSION = HUB_API_CONTRACT;
export const SERVICE = HUB_API_SERVICE;

const JSON_TYPE = 'application/json; charset=utf-8';
const PROBLEM_TYPE = 'application/problem+json';
const BASE_HEADERS = Object.freeze({ 'Cache-Control': 'no-store' });

// A handler returns its body (an object, status 200), or `reply(status, body)` for another success status (201 for a register).
const REPLY = Symbol('reply');
export const reply = (status, body) => ({ [REPLY]: true, status, body });

// A streaming route (its row carries `stream: true`) returns `streamReply(open)`: `handle()` answers it with the event-stream headers and
// no body, and the adapter calls `open(sink)` with the response once the head is written (tools/hub-api/stream.mjs owns the wire).
const STREAM = Symbol('stream');
export const streamReply = open => ({ [STREAM]: true, open });

const respond = (status, body, extra = {}) => ({ status, headers: { ...BASE_HEADERS, 'Content-Type': JSON_TYPE, ...extra }, body });

// The problem+json response for an error. An error with a `status` (the API's own coded errors) keeps its code and exit; an error
// without one whose code the Claims library's HTTP table knows (`httpAnswerOf`) takes that status, and its reason from the table, else
// from the error, else its lower-cased code; anything else is a bug in a handler: 500 HUB_API_ERROR.
const hasStatus = error => Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599;
// The table's answer for an error that carries no `status` of its own (one that carries a bad one is a bug: 500).
const tableAnswer = error => (error?.status === undefined ? httpAnswerOf(error) : null);
const oneLine = value => String(value).replace(/\s+/g, ' ').trim();

// The members a code adds to the base Problem fields (`rev` of a conflict, `holder` of a duplicate). `problem()` merges the ones an error
// carries and never overwrites a base field; docs/hub-api-contract.md's `Problem extensions` table is held equal to this by the contract test.
export const PROBLEM_EXTENSIONS = Object.freeze({
  HUB_REGISTRY_CONFLICT: Object.freeze(['rev']),
  HUB_REGISTRY_DUPLICATE: Object.freeze(['holder']),
  HUB_API_RESTARTING: Object.freeze(['retry']),
  HUB_FORCE_RELEASE_JOB: Object.freeze(['repo', 'run', 'job']),
  HUB_REPLICA_GAP: Object.freeze(['size']),
});

export function problem(error, extra = {}) {
  const answer = tableAnswer(error);
  const known = hasStatus(error) || answer !== null;
  const status = answer?.status ?? (known ? error.status : 500);
  const code = known && typeof error.code === 'string' && error.code !== '' ? error.code : 'HUB_API_ERROR';
  const detail = oneLine(typeof error?.message === 'string' && error.message !== '' ? error.message : error);
  const body = {
    type: `urn:mobile-deploy-hub:problem:${code}`,
    title: STATUS_CODES[status] ?? 'Error',
    status,
    detail,
    code,
    exit: known ? (Number.isInteger(error.exit) ? error.exit : exitCodeOf(error)) : 1,
    reason: answer?.reason ?? (known && typeof error.reason === 'string' && error.reason !== '' ? error.reason : (known ? code.toLowerCase() : 'internal')),
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
  const activity = marked ? (ctx.lockActivity ?? lockActivity)(record.lock, { env: ctx.env ?? process.env, now: ctx.now, processStart: ctx.processStart }) : {};
  return viewRecord(record, { audience: 'service', held: activity.held === true, queued: activity.queued === true });
}

// The marks of the peer hosts (Story 9.6, tools/hub-api/peers.mjs): the context's `peers` (the service's), or, for a bare `handle()` with none,
// one store per context.
const fallbackPeers = new WeakMap();
function peersOf(ctx) {
  if (ctx.peers) return ctx.peers;
  if (!fallbackPeers.has(ctx)) fallbackPeers.set(ctx, createPeers({ env: ctx.env ?? process.env, now: ctx.now, hostId: ctx.hostId, policy: ctx.policy, log: ctx.log }));
  return fallbackPeers.get(ctx);
}

// The cache's reading of each record (served form, by Resource id), except that a record on a host marked unreachable reads `offline`, stamped at the
// failure, `source: 'host'`, and served on this clock. The cache itself is never changed, so a cleared mark shows what the host last pushed again.
function readingsFor(ctx, records) {
  const served = new Map(ctx.readings?.read(records) ?? []);
  const peers = peersOf(ctx);
  const at = (ctx.now ?? Date.now)();
  for (const record of records) {
    const offline = peers.offlineReading(record.host);
    if (offline !== null) served.set(record.id, serveReading({ ...offline, source: 'host' }, { now: at }));
  }
  return served;
}

// GET /resources: every visible Resource (visible or retiring), in the Registry's order, each with its `reachability` (AD-35): the
// service's cached reading in its served form, read without waiting (a stale or missing one starts one refresh in the background), or
// the no-reading form when the context has no cache. Only this list carries it: the `Resource` shape is the same for every route.
export function listResources(ctx) {
  const registry = readIt(ctx);
  const shown = registry.resources.map(record => ({ record, resource: serve(ctx, record) })).filter(entry => entry.resource !== null);
  const readings = readingsFor(ctx, shown.map(entry => entry.record));
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
  // The host snapshot's first gather (Story 8.2): after it, nothing here scans /proc or asks adb on the request path.
  await ctx.snapshot?.ready();
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

// The pushed views of the spoke hosts: the context's `remotes` (the service's), or, for a bare `handle()` with none, one store per context.
const fallbackRemotes = new WeakMap();
function remotesOf(ctx) {
  if (ctx.remotes) return ctx.remotes;
  if (!fallbackRemotes.has(ctx)) fallbackRemotes.set(ctx, createRemotes());
  return fallbackRemotes.get(ctx);
}

// The Event Log replicas of the spoke hosts (Story 10.1): the context's `replicas` (the service's), or, for a bare `handle()`
// with none, one per context over the context's event dir.
const fallbackReplicas = new WeakMap();
function replicasOf(ctx) {
  if (ctx.replicas) return ctx.replicas;
  if (!fallbackReplicas.has(ctx)) fallbackReplicas.set(ctx, createReplicas({ env: ctx.env ?? process.env }));
  return fallbackReplicas.get(ctx);
}

// GET /status: the one status document (Story 8.1, AD-41): `{format, contract, hosts: {<host key>: <view>}, registry, stale, checked_at}`. A host's
// view is `claims.statusView(key, {audience: 'service', qa_ids})` embedded unchanged: the queue positions, ETAs, Pool fold and QA redaction
// are the library's, never recomputed here. Only this host's key is in `hosts` today (Epic 9 adds the Mac's); `registry` is the one place the
// Registry's own fields (names, Capabilities, retired and seed-missing visibility) appear, each Resource as `GET /resources` serves it but
// with no `reachability`. Only this host's own view is read fresh; a spoke host's (Story 9.5) is what it last pushed (`ctx.remotes`), embedded
// unchanged after this host's own, and `stale` is keyed by host key, `{since: <ISO receipt time>, unreachable}` for a pushed view older than
// `registry.reachability_max_age_s` on this clock, or one the Hub API has marked unreachable (Story 9.6: `{since, unreachable}`; its rows read `offline`). Nothing is cached: every field that passes with time is derived from `now` here.
// Story 8.4's stream frames and 8.5's re-read call this same function. A host that does not know its key is 503 HUB_HOST_UNKNOWN.
export async function statusDocument(ctx) {
  const env = ctx.env ?? process.env;
  await ctx.snapshot?.ready();
  let key;
  try { key = (ctx.hostKey ?? realHostKey)({ env }); } catch (error) {
    throw error?.code === 'HUB_HOST_UNKNOWN' ? HOST_UNKNOWN(oneLine(error.message)) : error;
  }
  const registry = readIt(ctx);
  const statusCtx = createContext({
    env, now: ctx.now, sleep: ctx.sleep, adbWire: ctx.adbWire, devicectl: ctx.devicectl, inventory: ctx.inventory, policy: ctx.policy, hostKey: ctx.hostKey,
    adbQuery: ctx.adbQuery, processStart: ctx.processStart, liveStart: ctx.liveStart,
    fleet: loadFleet(env, { warn: () => {} }),
  });
  const checkedAt = statusCtx.timing.now();
  const view = await statusView(key, { audience: 'service', qa_ids: dedicatedQaIds(registry) }, statusCtx);
  const maxAgeS = ctx.policy?.registry?.reachability_max_age_s;
  const peers = peersOf(ctx);
  const remote = remotesOf(ctx).views({ now: checkedAt, maxAgeS, marks: peers.marks() });
  // A host marked unreachable shows its last view with every row's reachability `offline` (a copy: the pushed view is the host's own words).
  for (const host of Object.keys(remote.hosts)) {
    const offline = peers.offlineReading(host);
    if (offline !== null) remote.hosts[host] = offlineView(remote.hosts[host], offline, { now: checkedAt, maxAgeS });
  }
  return {
    format: 1,
    contract: CONTRACT_VERSION,
    hosts: { [key]: view, ...remote.hosts },
    registry: { rev: registry.rev, source: registry.source, resources: registry.resources.map(record => serve(ctx, record)).filter(resource => resource !== null) },
    stale: remote.stale,
    checked_at: new Date(checkedAt).toISOString(),
  };
}

// A mark change pokes the change feed so a stream frame follows; a throw there is logged, never answered.
function pokePeers(ctx) {
  try { ctx.onPeerChange?.(); } catch (error) { ctx.log?.err?.(`HUB_API_ERROR peer ${oneLine(error?.message ?? error)}`); }
}
function noteContact(ctx, host, { at, reason }) {
  if (peersOf(ctx).reached(host, { at, reason })) pokePeers(ctx);
}
// Every recorded failure pokes, not only the first: a retry that fails again moves `failed_at` and `reason`, which rows and `stale` show.
function noteFailure(ctx, host, { at, reason }) {
  peersOf(ctx).failed(host, { at, reason });
  pokePeers(ctx);
}

// The state `/history` keeps (Story 10.2: the send time of each peer's last synced `/agent/sync`): the context's `history` (the service's), or,
// for a bare `handle()` with none, one per context.
const fallbackHistory = new WeakMap();
function historyOf(ctx) {
  if (ctx.history) return ctx.history;
  if (!fallbackHistory.has(ctx)) fallbackHistory.set(ctx, createHistory());
  return fallbackHistory.get(ctx);
}

// GET /history?resource&pool&claimant&repo&from&to&cursor&limit (Story 10.2, FR-18, UJ-4, AD-40): this host's Event Log and each peer's replica,
// filtered, merged by `ts` for display (`cross_host_order: 'display-only'`) and paged by an opaque per-host cursor. A peer whose replica may lack
// the window is asked to push first (`POST /agent/sync`, behind the peers' gate: a marked host fails at once); a window the replica still cannot be
// shown to cover answers `partial: true` with `synced_through` and `unreachable_ranges`. Reads only: the one side effect is a peer's mark
// (Story 9.6, `noteContact`/`noteFailure`) and the agent's own pushes. The query is checked first (400 HUB_USAGE) and reads nothing; a host that
// does not know its key is 503 HUB_HOST_UNKNOWN. The logic is tools/registry/history.mjs and tools/hub-api/history.mjs.
export async function historyRoute(ctx, { query, signal } = {}) {
  const env = ctx.env ?? process.env;
  let own;
  try { own = (ctx.hostKey ?? realHostKey)({ env }); } catch (error) {
    throw error?.code === 'HUB_HOST_UNKNOWN' ? HOST_UNKNOWN(oneLine(error.message)) : error;
  }
  return queryHistory({
    query, own, env, registry: () => readIt(ctx), hostId: ctx.hostId, now: ctx.now ?? Date.now, signal,
    peers: peersOf(ctx), replicas: replicasOf(ctx), history: historyOf(ctx), transport: transportOf(ctx),
    contact: (host, at) => noteContact(ctx, host, at), failure: (host, at) => noteFailure(ctx, host, at),
    log: line => { try { ctx.log?.err?.(line); } catch { /* a broken log seam never changes the answer */ } },
  });
}

// POST /agent/push (Story 9.5, AD-49; the `events` replication is Story 10.1): a spoke host's Host Agent pushes its view when
// something there changed. The body is checked strictly (`checkPushBody`; this service's own host key is refused: it is `own`,
// and an unknown one is 503 HUB_HOST_UNKNOWN), then everything happens in one serialized operation per host (the replica
// queue): any push that passed the body check is contact (Story 9.6), then a repeated delivery (`seen`) skips the append, the
// `events` append runs against the replica (a `from_offset` that is not the settled size is 409 HUB_REPLICA_GAP with `size`:
// nothing appended and nothing applied, but the push is still contact), then the push is applied once per `(boot, seq)` on
// this service's clock: a push already applied answers `{applied: false}` and changes nothing. An applied push replaces the
// host's view (a null `status` keeps the last), stores each reading of a Resource the Registry places on that host
// (`ctx.readings.remote`; no `reachability` event: only a host's own service logs one), then `ctx.onPush()` pokes the change
// feed so a stream frame follows. Every 2xx answer, a duplicate's included, reports the replica's sizes under `replica`, so
// the agent resumes from them and keeps no cursor of its own. This service never calls the agent to refresh any of it.
export async function agentPush(ctx, { body }) {
  const env = ctx.env ?? process.env;
  let own;
  try { own = (ctx.hostKey ?? realHostKey)({ env }); } catch (error) {
    throw error?.code === 'HUB_HOST_UNKNOWN' ? HOST_UNKNOWN(oneLine(error.message)) : error;
  }
  const push = checkPushBody(body, { own });
  const at = (ctx.now ?? Date.now)();
  // The Registry's places are read before anything is applied: a read that throws applies nothing.
  const places = push.readings !== null ? new Set(readIt(ctx).resources.filter(record => record.host === push.host).map(record => record.id)) : new Set();
  const remotes = remotesOf(ctx);
  const replicas = replicasOf(ctx);
  return replicas.exclusive(push.host, async () => {
    // Any push that passed the body check, applied or a duplicate, is contact (Story 9.6): a host marked unreachable is restored, with one event.
    noteContact(ctx, push.host, { at, reason: 'push' });
    let applied = false;
    // A repeated delivery appends nothing and applies nothing; a gap refuses the whole push (both stay as they were).
    if (!(push.events !== null && remotes.seen(push))) {
      if (push.events !== null) await replicas.append(push.host, push.events);
      ({ applied } = remotes.apply(push, { at }));
      if (applied) {
        if (push.readings !== null) {
          ctx.readings?.remote(push.readings.filter(reading => places.has(reading.resource)).map(reading => ({ id: reading.resource, served: reading })), { at });
        }
        try { ctx.onPush?.(); } catch (error) { ctx.log?.err?.(`HUB_API_ERROR push ${oneLine(error?.message ?? error)}`); }
      }
    }
    const replica = await replicas.sizes(push.host);
    return { applied, host: push.host, boot: push.boot, seq: push.seq, replica };
  });
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
  const activity = (ctx.lockActivity ?? lockActivity)(record.lock, { env: ctx.env ?? process.env, now: ctx.now, processStart: ctx.processStart });
  return { rev: written.rev, source: 'file', id: record.id, retired_at: record.retired_at, visibility: visibility(record, { held: activity.held === true, queued: activity.queued === true }) };
}

// POST /leases: takes a Lease on a phone or an emulator, by word, Resource id or `match` (Story 7.1, 7.4). The body is checked first
// (`checkLeaseBody`), then the Claims library takes it exactly as `hub-device lease <word> --no-connect` would: `serviceLease` is the one
// function every service front door calls, and the status of a refusal comes from its HTTP table. The actor is the body's `actor`, else
// `{holder, via: 'api'}`. A `match` drops the members this service's own cache knows are away (no adb is asked on a request: AD-44). The word `emulator`, or a `match` with a `profile=` clause (or only the emulator Pool),
// takes an emulator: its boot runs in a worker thread (AD-44), never here. 200 `Lease`, with `emulator` set for one.
//
// A wait (`wait_ms`, Story 7.2) is bound to the connection that asked: the service's wait registry (`ctx.waits`, claims.mjs
// `createLeaseWaits`, built by `startService`) owns the rules, this handler hands it the request's abort `signal`. A context with no
// registry (a bare `handle()`) takes the Lease directly, with the same signal.
function readingsOf(ctx) {
  return members => {
    const registry = readIt(ctx);
    const records = new Map(members.map(member => [member.device, registry.resources.find(record => record.lock === member.lock)]));
    const served = readingsFor(ctx, [...records.values()].filter(Boolean));
    return new Map(members.map(member => [member.device, served.get(records.get(member.device)?.id)?.state ?? 'unknown']));
  };
}

// The context the Claims library's service functions take, from the service's own: the lock dir environment, the policy and clock seams, a
// log that never changes an answer, the reading of a Pool's members (a `match`) and the `devicectl` seam (the Host Agent's lane gate reads the iPad through it: Story 9.4).
function serviceContext(ctx) {
  const out = line => { try { ctx.log?.out?.(line); } catch { /* a broken log seam never changes the answer */ } };
  return {
    env: ctx.env ?? process.env, policy: ctx.policy, now: ctx.now, sleep: ctx.sleep, qaDevices: ctx.qaDevices,
    ...(ctx.processStart ? { processStart: ctx.processStart } : {}), ...(ctx.fleet ? { fleet: ctx.fleet } : {}),
    log: out, warn: () => {}, readingsOf: readingsOf(ctx), ...(ctx.hostKey ? { hostKey: ctx.hostKey } : {}), ...(ctx.devicectl ? { devicectl: ctx.devicectl } : {}),
    ...(ctx.provisionOffThread ? { provisionOffThread: ctx.provisionOffThread } : {}), ...(ctx.releaseOffThread ? { releaseOffThread: ctx.releaseOffThread } : {}), ...(ctx.forceReleaseOffThread ? { forceReleaseOffThread: ctx.forceReleaseOffThread } : {}),
  };
}

export async function takeLease(ctx, { body, signal }) {
  const input = checkLeaseBody(body);
  const actor = input.actor ?? { holder: input.holder, via: 'api' };
  const service = serviceContext(ctx);
  return ctx.waits ? ctx.waits.lease({ ...input, actor }, service, { signal }) : serviceLease({ ...input, actor }, { ...service, signal });
}

// GET /leases/{id}: the Lease an id names, a phone's or an emulator's (Story 7.2, 7.4), the same `Lease` the take answered with: how a client whose connection dropped
// after the grant finds its Hold. A waiter that holds nothing yet and an unknown id are 404 HUB_LEASE_NOT_FOUND (`waiting`, `unknown`).
export function getLease(ctx, { params }) {
  return findLease(params.id, { env: ctx.env ?? process.env, warn: () => {}, ...(ctx.processStart ? { processStart: ctx.processStart } : {}), ...(ctx.fleet ? { fleet: ctx.fleet } : {}) });
}

// POST /leases/{id}/extend: extends a phone or emulator Lease (Story 7.3), exactly `hub-device extend <id> --for ...`: `serviceExtend` is the one function
// every service front door calls, and the status of a refusal comes from its HTTP table. The body is checked first (`checkExtendBody`);
// the actor is the body's `actor`, else `{holder, via: 'api'}`, and an `override`'s actor defaults to it. 200 `Lease`.
export function extendLeaseRoute(ctx, { body, params }) {
  const input = checkExtendBody(body);
  const actor = input.actor ?? { holder: input.holder, via: 'api' };
  const override = input.override ? { ...input.override, actor: input.override.actor ?? actor } : null;
  return serviceExtend(params.id, { ...input, actor, override }, serviceContext(ctx));
}

// POST /leases/{id}/release: gives a phone or emulator Lease back (an emulator is torn down in a worker), or withdraws a waiter (Story 7.3), exactly `hub-device release <id>`, with the actor
// on its events. 200 `Release`; an id that holds and waits for nothing is `outcome: none`.
export function releaseLeaseRoute(ctx, { body, params }) {
  const input = checkReleaseBody(body);
  const actor = input.actor ?? { holder: input.holder, via: 'api' };
  return serviceRelease(params.id, { ...input, actor }, serviceContext(ctx));
}

// POST /requests/{id}/cancel: takes a waiting request out of the line (Story 7.5), exactly `hub-device cancel <id> --resource ...`: `cancel` is the one function every front door calls,
// and the status of a refusal comes from its HTTP table. The body is checked first (`checkCancelBody`); the actor is the body's `actor`, else `{holder, via: 'api'}`. 200 `Cancel`.
export function cancelRequestRoute(ctx, { body, params }) {
  const input = checkCancelBody(body);
  const actor = input.actor ?? { holder: input.holder, via: 'api' };
  return cancel(params.id, { ...input, actor }, serviceContext(ctx));
}

// POST /leases/{id}/force-release: ends a Lease by force (Story 7.6), exactly `hub-device force-release <id> --why ...`: `forceReleaseLease` is the one function every
// front door calls, and the status of a refusal comes from its HTTP table. The body is checked first (`checkForceReleaseBody`); the actor is the body's `actor`, else
// `{holder, via: 'api'}`. No holder check and no confirmation (that is the page's). 200 `ForceRelease`. An `{id}` of `emulator-<n>` (Story 7.8) is a slot:
// `forceReleaseEmulator` ends its Lease and tears the emulator down, in a worker thread (AD-44); every other id is a Lease id.
export function forceReleaseLeaseRoute(ctx, { body, params }) {
  const input = checkForceReleaseBody(body);
  const actor = input.actor ?? { holder: input.holder, via: 'api' };
  if (namesEmulatorSlot(params.id)) return forceReleaseEmulator(params.id, { why: input.why, actor }, { ...serviceContext(ctx), offThread: true });
  return forceReleaseLease(params.id, { why: input.why, actor }, serviceContext(ctx));
}

// POST /reservations/{run_key}/force-release: ends a deploy run's Reservation by force (Story 7.7), exactly `hub-device force-release --reservation <run_key> --why ...`:
// `forceReleaseReservation` is the one function every front door calls, and the status of a refusal comes from its HTTP table. The body is checked first
// (`checkReservationForceReleaseBody`); the actor is the body's `actor`, else `{holder, via: 'api'}`. No holder check and no confirmation. 200 `ReservationForceRelease`.
export function forceReleaseReservationRoute(ctx, { body, params }) {
  const input = checkReservationForceReleaseBody(body);
  const actor = input.actor ?? { holder: input.holder, via: 'api' };
  return forceReleaseReservation(params.run_key, { why: input.why, actor, name: input.name }, serviceContext(ctx));
}

// The Hold routes behind the forwarding rule (Story 9.3, AD-48; tools/device/forward.mjs has the rules and every Hold route's naming). A Hold action runs
// on the host its Resource lives on, so this service, which is big-chungus (`hostKey()`), either runs it here or sends it on:
//   - a forward (the header `X-Hub-Forwarded`, `resource: {id, lock, host, rev, retired_at}`): the carried record is taken down to its `id` and re-resolved
//     against the Registry (`registry.json`, else the seed); one that lives on another host is HUB_WRONG_HOST, nothing written, and it is never forwarded again;
//   - a public request that names Resources on one other host is forwarded there as the door `api`, and that host's answer is relayed as it came (a
//     far problem is this answer's problem; a host that does not answer is 503 HUB_DEVICE_AWAY, exit 75, `host-unreachable`);
//   - anything else, and a host that does not know its key (no forwarding: v1a), runs here.
// `route.local` is the raw handler, which the Host Agent runs behind its own forwarding wrapper.
function hubHold(route) {
  const key = `${route.method} ${route.path}`;
  const named = NAMED[key];
  return async (ctx, given) => {
    const { door, request } = unwrapCarried(given);
    let own;
    try { own = (ctx.hostKey ?? realHostKey)({ env: ctx.env ?? process.env }); } catch (error) {
      if (error?.code !== 'HUB_HOST_UNKNOWN') throw error;
      return route.handler(ctx, request);
    }
    const input = named.check(request.body);
    // A request that names nothing (a GET, a bare release) is answered here: the Registry is not read for it.
    if (named.names(input, request).length === 0) return route.handler(ctx, request);
    const view = hubView(ctx);
    const { records, single } = namedRecords(key, input, request, view, ctx.policy);
    if (door !== null) {
      const foreign = records.find(record => record.host !== own);
      if (foreign) throw wrongHost(foreign, own);
      return route.handler(ctx, request);
    }
    const host = placeOf(records, own);
    if (host === null) return route.handler(ctx, request);
    // Story 9.6: a host marked unreachable fails at once (before any transport call) until a push or the 5x window; a call that fails at the ssh
    // leg marks it, and one that gets any answer (even the far side's own problem) restores it. A request the client aborted says nothing.
    const clock = ctx.now ?? Date.now;
    peersOf(ctx).gate(host, { at: clock() });
    let answer;
    try {
      answer = await forwardHold({ key, request, input, place: { host, records, single }, rev: view.rev, door: 'api', ctx });
    } catch (error) {
      if (request.signal?.aborted !== true) {
        if (isUnreached(error)) noteFailure(ctx, host, { at: clock(), reason: failureReason(error) });
        else if (isContact(error)) noteContact(ctx, host, { at: clock(), reason: 'call' });
      }
      throw error;
    }
    noteContact(ctx, host, { at: clock(), reason: 'call' });
    return answer.status === 200 ? answer.body : reply(answer.status, answer.body);
  };
}
const hold = route => Object.freeze({ ...route, handler: hubHold(route), local: route.handler });

// GET /stream: the Candybar SSE wire (Story 8.4, AD-43): the connection's opening (`ready`, or `reset` for an id it cannot resume) carries
// the one `statusDocument`, then the ring's frames after its `Last-Event-ID`, then live frames. The cursor is taken before the document
// is awaited, so a frame emitted meanwhile is replayed, never lost. An exact resume needs no document. A host that does not know its key
// answers as a problem and opens no stream; a stream that is closed (the service is stopping) is 503 HUB_API_RESTARTING.
export async function streamRoute(ctx, { headers = {} } = {}) {
  const { stream } = ctx;
  if (!stream) throw new Error('this service has no stream');
  if (stream.closed) throw restartingError();
  const plan = stream.plan(headers['last-event-id']);
  let { after } = plan;
  let status;
  if (plan.kind !== 'resume') {
    after = stream.cursor();
    status = await statusDocument(ctx);
    if (stream.closed) throw restartingError();
  }
  return streamReply(sink => stream.attach(sink, { ...plan, after, status }));
}

// `shape` names the `### <Shape>` section of the contract document that lists the response's fields.
export const ROUTES = Object.freeze([
  Object.freeze({ method: 'GET', path: '/health', shape: 'Health', handler: health }),
  Object.freeze({ method: 'GET', path: '/resources', shape: 'ResourceList', handler: listResources }),
  Object.freeze({ method: 'GET', path: '/resources/{id}', shape: 'Resource', handler: getResource }),
  Object.freeze({ method: 'GET', path: '/pools', shape: 'PoolList', handler: listPools }),
  Object.freeze({ method: 'GET', path: '/discovery', shape: 'Discovery', handler: discovery }),
  Object.freeze({ method: 'GET', path: '/status', shape: 'Status', handler: statusDocument }),
  Object.freeze({ method: 'GET', path: '/stream', shape: 'StreamFrame', handler: streamRoute, stream: true }),
  Object.freeze({ method: 'GET', path: '/history', shape: 'History', handler: historyRoute }),
  Object.freeze({ method: 'POST', path: '/agent/push', shape: 'AgentPushAck', handler: agentPush }),
  Object.freeze({ method: 'POST', path: '/registry/resources', shape: 'Resource', handler: registerResource }),
  Object.freeze({ method: 'POST', path: '/registry/resources/{id}', shape: 'Resource', handler: editResource }),
  Object.freeze({ method: 'POST', path: '/registry/resources/{id}/retire', shape: 'Retirement', handler: retireResource }),
  // `requestId` names the id a route echoes in `X-Request-Id` (from the request and its answer; the answer is null for an error).
  hold({ method: 'POST', path: '/leases', shape: 'Lease', handler: takeLease, requestId: ({ body }, view) => leaseRequestId(body, view) }),
  hold({ method: 'GET', path: '/leases/{id}', shape: 'Lease', handler: getLease }),
  hold({ method: 'POST', path: '/leases/{id}/extend', shape: 'Lease', handler: extendLeaseRoute }),
  hold({ method: 'POST', path: '/leases/{id}/release', shape: 'Release', handler: releaseLeaseRoute }),
  hold({ method: 'POST', path: '/leases/{id}/force-release', shape: 'ForceRelease', handler: forceReleaseLeaseRoute }),
  hold({ method: 'POST', path: '/requests/{id}/cancel', shape: 'Cancel', handler: cancelRequestRoute }),
  Object.freeze({ method: 'POST', path: '/reservations/{run_key}/force-release', shape: 'ReservationForceRelease', handler: forceReleaseReservationRoute }),
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

// One request: `{method, url, headers, body, bodyError}` (url as sent: path and query; headers the request's, lower-cased, handed to the
// handler; body already parsed, or undefined; bodyError the error
// of a body that could not be read, answered only once the route is known, so a wrong path or method is still a 404 or 405) to
// `{status, headers, body}` (a streaming route's answer has `stream: {open}` and no body). Never throws. `signal` (optional) is the connection's abort signal, handed to the handler. `ctx.routes` (default ROUTES) is the route table; a handler error is logged once on `ctx.log.err` and answered as a 500.
export async function handle({ method, url, headers = {}, body, bodyError, signal } = {}, ctx = {}) {
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
  // The id the route echoes in `X-Request-Id`, when it names one and the request or the answer knows it.
  const echo = answered => {
    try {
      const id = route.requestId?.({ method: verb, path, body }, answered);
      return typeof id === 'string' && id !== '' ? { 'X-Request-Id': id } : {};
    } catch { return {}; }
  };
  try {
    const query = String(url ?? '').slice(path.length).replace(/^\?/, '').split('#')[0];
    const params = found.find(entry => entry.route === route).params;
    const result = await route.handler(ctx, { method: verb, path, query: new URLSearchParams(query), headers, body, params, signal });
    if (route.stream === true) {
      if (result?.[STREAM] !== true) throw new TypeError(`the stream handler for ${verb} ${path} did not return streamReply(open)`);
      return { status: 200, headers: { ...BASE_HEADERS, ...STREAM_HEADERS }, stream: { open: result.open } };
    }
    if (result?.[STREAM] === true) throw new TypeError(`the handler for ${verb} ${path} returned a stream, but its route is not a stream route`);
    if (result?.[REPLY] === true) return respond(result.status, result.body, echo(result.body));
    if (result === null || typeof result !== 'object') throw new TypeError(`the handler for ${verb} ${path} returned ${result === null ? 'null' : typeof result}, not an object`);
    return respond(200, result, echo(result));
  } catch (error) {
    if (!hasStatus(error) && tableAnswer(error) === null) {
      try { ctx.log?.err?.(`HUB_API_ERROR ${verb} ${path} ${oneLine(error?.message ?? error)}`); } catch { /* a broken log seam never changes the answer */ }
    }
    return problem(error, echo(null));
  }
}
