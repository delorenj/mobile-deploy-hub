// The Registry store (AD-27, FR-2): `<HUB_LOCK_DIR>/registry.json`, `{format: 1, rev, resources, pools}`, mode 0600, and the one path
// every Registry writer takes (the seed at start, register, edit, retire). It reads fresh from disk on every call (no cache), writes
// only through lock.mjs's `writeFileAtomic` (so this file has no write or rename of its own), and derives the `registry-*` events of a
// write itself from what changed, so no writer can forget one or log a different set.
//
// A file that is missing reads as the in-memory seed at `rev: 0`. A file that cannot be read (not JSON, a `format` this code does not
// know, a bad shape) reads as the seed too, with one HUB_REGISTRY_FORMAT warning, and is never written: an older API cannot clobber
// newer records. Writes are serialised per path in this process; across processes the singleton is the Hub API's port bind (AD-45),
// and `if_rev` catches a writer that read an older file (HUB_REGISTRY_CONFLICT). The rename is the deciding step.
//
// A write never deletes a record and never changes a record's `id` or `lock` (AD-28, AD-31): that is a TypeError, a caller bug.
// lock.mjs never reads this file (AD-29) and the deploy path never imports this directory (tools/deploy-path.test.mjs).
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { loadDevices } from '../ci/lib/devices.mjs';
import { readEvents } from '../ci/lib/events.mjs';
import { checkActor, lockDir, noteRegistry, writeFileAtomic } from '../ci/lib/lock.mjs';
import { loadQaDevices, reseed, seed } from './seed.mjs';

export const REGISTRY_FILE = 'registry.json';
export const REGISTRY_FORMAT = 1;
export const REGISTRY_ERRORS = Object.freeze({
  HUB_REGISTRY_CONFLICT: Object.freeze({ status: 409, exit: 1 }),
  HUB_REGISTRY_FORMAT: Object.freeze({ status: 409, exit: 1 }),
});

// The subject of an event about the Registry as a whole (a Pool change, a recovery): `registry` is in lock.mjs's RESERVED, so no
// Resource can ever have this id or lock.
const WHOLE = 'registry';

export const registryPath = (env = process.env) => join(lockDir(env), REGISTRY_FILE);

const registryError = (code, message, extra) => Object.assign(new Error(message), { code, ...REGISTRY_ERRORS[code], ...extra });
const formatError = (reason, path) => registryError('HUB_REGISTRY_FORMAT', `${path}: ${reason}`, { reason });

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonEmpty = value => typeof value === 'string' && value !== '';
const wholeNumber = value => Number.isSafeInteger(value) && value >= 0;

// Key order does not matter to equality.
const canonical = value => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (isObject(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
};
const same = (a, b) => canonical(a) === canonical(b);

// ---- the file ----

// Reads and checks `registry.json`: {state: 'missing'} | {state: 'unreadable', reason} | {state: 'ok', rev, resources, pools (array),
// extra (unknown top-level keys, carried through a write)}. Never throws.
function loadFile(path) {
  let text;
  try { text = readFileSync(path, 'utf8'); } catch (error) {
    if (error?.code === 'ENOENT') return { state: 'missing' };
    return { state: 'unreadable', reason: `cannot read it (${error?.code ?? 'read error'})` };
  }
  let doc;
  try { doc = JSON.parse(text); } catch { return { state: 'unreadable', reason: 'not valid JSON' }; }
  if (!isObject(doc)) return { state: 'unreadable', reason: 'not a JSON object' };
  if (doc.format !== REGISTRY_FORMAT) return { state: 'unreadable', reason: `format ${JSON.stringify(doc.format) ?? 'missing'} is not supported (this code reads format ${REGISTRY_FORMAT})` };
  if (!wholeNumber(doc.rev)) return { state: 'unreadable', reason: 'rev must be a whole number' };
  if (!Array.isArray(doc.resources)) return { state: 'unreadable', reason: 'resources must be an array' };
  if (!Array.isArray(doc.pools)) return { state: 'unreadable', reason: 'pools must be an array' };
  const ids = new Set();
  for (const [index, record] of doc.resources.entries()) {
    if (!isObject(record) || !nonEmpty(record.id) || !nonEmpty(record.lock)) return { state: 'unreadable', reason: `resources[${index}] must be an object with an id and a lock` };
    if (ids.has(record.id)) return { state: 'unreadable', reason: `resources[${index}] repeats the id "${record.id}"` };
    ids.add(record.id);
  }
  const names = new Set();
  for (const [index, pool] of doc.pools.entries()) {
    if (!isObject(pool) || !nonEmpty(pool.name)) return { state: 'unreadable', reason: `pools[${index}] must be an object with a name` };
    if (names.has(pool.name)) return { state: 'unreadable', reason: `pools[${index}] repeats the name "${pool.name}"` };
    names.add(pool.name);
  }
  const { format, rev, resources, pools, ...extra } = doc;
  return { state: 'ok', rev, resources, pools, extra };
}

const poolsByName = pools => Object.fromEntries(pools.map(({ name, ...rest }) => [name, rest]));

// ---- read ----

// The Registry as the matcher reads it: `{format, rev, resources, pools: {<name>: {...}}, source: 'file'|'seed', warnings}`, from the
// file when it is good, else the in-memory seed of devices.json (`devices`, default this checkout's) with the caller's `qaDevices`
// at `rev: 0`. An unreadable file adds `unreadable: true` and one warning, also passed to `warn` once. Fresh from disk on every call;
// the QA loader runs only when the seed is used. Synchronous.
export function readRegistry({ env = process.env, devices, qaDevices, warn = () => {} } = {}) {
  const path = registryPath(env);
  const file = loadFile(path);
  if (file.state === 'ok') return { format: REGISTRY_FORMAT, rev: file.rev, resources: file.resources, pools: poolsByName(file.pools), source: 'file', warnings: [] };
  const seeded = seed(devices ?? loadDevices(env), { qaDevices: qaDevices ?? (() => loadQaDevices({ env })) });
  const out = { format: REGISTRY_FORMAT, rev: 0, resources: seeded.resources, pools: seeded.pools, source: 'seed', warnings: [...seeded.warnings] };
  if (file.state === 'unreadable') {
    const message = `HUB_REGISTRY_FORMAT: ${path} ${file.reason}; using the seed, and refusing to write it`;
    out.warnings.push(message);
    out.unreadable = true;
    try { warn(message); } catch { /* a broken warn seam is not a reason to fail a read */ }
  }
  return out;
}

// The file as the matcher reads it (`{format, rev, resources, pools: {<name>: {...}}}`), or null when it is missing or unreadable. Only
// the file: no seed fallback, no QA read, no warning, and it never throws. A reader that must not invent a Resource (the Claims
// library's take refusal) uses this instead of `readRegistry`.
export function readRegistryFile(env = process.env) {
  try {
    const file = loadFile(registryPath(env));
    if (file.state !== 'ok') return null;
    return { format: REGISTRY_FORMAT, rev: file.rev, resources: file.resources, pools: poolsByName(file.pools) };
  } catch { return null; }
}

// What `registry.json` is right now, for a health check: 'missing', 'unreadable' (it exists and cannot be read or is not a Registry this
// code knows) or 'ok'. Fresh from disk on every call; never throws, never writes.
export function registryState(env = process.env) {
  try { return loadFile(registryPath(env)).state; } catch { return 'unreadable'; }
}

// ---- diff ----

// The key paths of `after` that differ from `before` (strings only, never values): top-level keys, with `capabilities.<key>` expanded
// and everything else (identity included) kept whole, sorted.
function changedKeys(before, after) {
  const changed = [];
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (same(before[key], after[key])) continue;
    if (key === 'capabilities' && (before[key] === undefined || isObject(before[key])) && (after[key] === undefined || isObject(after[key]))) {
      const was = before[key] ?? {};
      const now = after[key] ?? {};
      for (const capability of new Set([...Object.keys(was), ...Object.keys(now)])) if (!same(was[capability], now[capability])) changed.push(`capabilities.${capability}`);
    } else changed.push(key);
  }
  return changed.sort();
}

// The events a write derives, as [{kind, resource, lock, changed}] (rev and the caller's fields are added when they are logged):
// a new id is `add`, a `retired_at` newly set is `retire`, any other difference is `edit`, a changed Pool list is one `edit` of the
// whole Registry. Unchanged records produce nothing. Returns {events, poolsChanged}.
function derive(was, resources, wasPools, pools, { first }) {
  const known = new Map(was.map(record => [record.id, record]));
  const events = [];
  for (const record of resources) {
    const before = known.get(record.id);
    if (!before) { events.push({ kind: 'add', resource: record.id, lock: record.lock, changed: changedKeys({}, record) }); continue; }
    const changed = changedKeys(before, record);
    if (changed.length === 0) continue;
    events.push({ kind: !before.retired_at && record.retired_at ? 'retire' : 'edit', resource: record.id, lock: record.lock, changed });
  }
  const before = new Map(wasPools.map(pool => [pool.name, pool]));
  const after = new Map(pools.map(pool => [pool.name, pool]));
  const poolsChanged = [...new Set([...before.keys(), ...after.keys()])].filter(name => !same(before.get(name), after.get(name))).sort().map(name => `pools.${name}`);
  // The first write of a file is a set of `add`s; Pools get their own event only when nothing else would leave one (every rev bump leaves one).
  if (poolsChanged.length > 0 && (!first || events.length === 0)) events.push({ kind: 'edit', resource: WHOLE, lock: WHOLE, changed: poolsChanged });
  return { events, poolsChanged };
}

// ---- write ----

// Pools arrive as the reader's `{<name>: {...}}` or as the file's `[{name, ...}]`; they are stored as the array.
function poolList(pools) {
  if (Array.isArray(pools)) return pools;
  if (isObject(pools)) return Object.entries(pools).map(([name, rest]) => (isObject(rest) ? { name, ...rest } : rest));
  throw new TypeError('pools is an object keyed by name, or an array of {name, ...}');
}

// Per-path promise chain: two store users in one process never interleave their read and commit.
const queues = new Map();
function serialised(path, task) {
  const key = resolve(path);
  const run = (queues.get(key) ?? Promise.resolve()).then(task);
  const tail = run.catch(() => {});
  queues.set(key, tail);
  tail.then(() => { if (queues.get(key) === tail) queues.delete(key); });
  return run;
}

// The checked shape of a write's content: a JSON copy (compared and written as JSON, so what is diffed is what is stored) of the
// records and Pools, each with an id and a lock, or a name. A caller bug is a TypeError.
function normalise(resources, pools) {
  if (!Array.isArray(resources)) throw new TypeError('resources must be an array of records');
  const next = JSON.parse(JSON.stringify(resources));
  const nextPools = JSON.parse(JSON.stringify(poolList(pools)));
  const ids = new Set();
  for (const [index, record] of next.entries()) {
    if (!isObject(record) || !nonEmpty(record.id) || !nonEmpty(record.lock)) throw new TypeError(`resources[${index}] must be an object with an id and a lock`);
    if (ids.has(record.id)) throw new TypeError(`resources[${index}] repeats the id "${record.id}"`);
    ids.add(record.id);
  }
  const names = new Set();
  for (const [index, pool] of nextPools.entries()) {
    if (!isObject(pool) || !nonEmpty(pool.name)) throw new TypeError(`pools[${index}] must be an object with a name`);
    if (names.has(pool.name)) throw new TypeError(`pools[${index}] repeats the name "${pool.name}"`);
    names.add(pool.name);
  }
  return { next, nextPools };
}

// The one transactional write (AD-27): reads the file, checks `if_rev`, runs `change` and commits, all inside the per-path queue, so
// `change` sees the file as it will be replaced (what an earlier queued write committed included). `change({rev, resources, pools,
// state})` gets copies of the current records and Pools (an array) and `state` `'file'` or `'missing'` (no file yet: no records, rev 0);
// it returns `{resources, pools}` (the same shapes `writeRegistry` takes) or throws, and a throw commits nothing and reaches the caller
// as it is. It may be async. `if_rev`, when given, must equal the file's rev (0 for no file yet); when it is absent there is no rev
// check (a writer whose own checks run in `change`, such as register, cannot lose an update).
// The content becomes the new file when it differs, at `rev + 1`. Returns `{rev, changed, events}`: a no-op write commits nothing,
// logs nothing and returns the current rev with `changed: false`; otherwise `events` lists each `registry-*` event derived, with its
// `logged` flag (a failed log write never fails a committed write). The caller's `reason`, `actor` ({holder, via}) and `why` ride on
// every event.
//   HUB_REGISTRY_CONFLICT  (409, `rev` = the current one)  `if_rev` is given and the file is not at it
//   HUB_REGISTRY_FORMAT    (409, `reason`)                 the file is unreadable or of another format; it is left as it is
//   TypeError                                              a caller bug: a bad shape, a duplicate id, a record dropped, a changed id or lock
// `afterRead` is a test seam, awaited between the read and the commit.
export async function updateRegistry({ env = process.env, if_rev, change, reason, actor, why, afterRead, now, hostId, log } = {}) {
  if (if_rev !== undefined && !wholeNumber(if_rev)) throw new TypeError('if_rev must be a whole number (0 when there is no file yet), or absent');
  if (typeof change !== 'function') throw new TypeError('change must be a function');
  if (reason !== undefined && reason !== null && typeof reason !== 'string') throw new TypeError('reason must be a string');
  if (why !== undefined && why !== null && typeof why !== 'string') throw new TypeError('why must be a string');
  checkActor(actor);
  const path = registryPath(env);
  return serialised(path, async () => {
    const file = loadFile(path);
    if (file.state === 'unreadable') throw formatError(file.reason, path);
    const current = file.state === 'ok' ? file.rev : 0;
    if (afterRead) await afterRead({ rev: current });
    if (if_rev !== undefined && if_rev !== current) throw registryError('HUB_REGISTRY_CONFLICT', `${path} is at rev ${current}, not ${if_rev}`, { rev: current });
    const was = file.state === 'ok' ? file.resources : [];
    const wasPools = file.state === 'ok' ? file.pools : [];
    const changed = await change({ rev: current, resources: structuredClone(was), pools: structuredClone(wasPools), state: file.state === 'ok' ? 'file' : 'missing' });
    if (!isObject(changed)) throw new TypeError('change returns {resources, pools}');
    const { next, nextPools } = normalise(changed.resources, changed.pools);
    for (const record of was) {
      const kept = next.find(entry => entry.id === record.id);
      if (!kept) throw new TypeError(`a write may not drop the record "${record.id}" (retire it)`);
      if (kept.lock !== record.lock) throw new TypeError(`a write may not change the lock of "${record.id}"`);
    }
    const { events: derived, poolsChanged } = derive(was, next, wasPools, nextPools, { first: file.state !== 'ok' });
    if (derived.length === 0 && poolsChanged.length === 0) return { rev: current, changed: false, events: [] };
    const rev = current + 1;
    writeFileAtomic(path, `${JSON.stringify({ format: REGISTRY_FORMAT, rev, resources: next, pools: nextPools, ...(file.state === 'ok' ? file.extra : {}) }, null, 2)}\n`, { mode: 0o600 });
    const events = derived.map(({ kind, ...fields }) => {
      const event = { event: `registry-${kind}`, ...fields, rev };
      let logged = false;
      try { logged = noteRegistry(kind, { ...fields, rev, reason, actor, why }, { env, now, hostId, log }); } catch { /* committed already; the caller's inputs were checked above */ }
      return { ...event, logged };
    });
    return { rev, changed: true, events };
  });
}

// Writes the Registry: `resources` (an array of records) and `pools` become the new content when they differ from the file, at
// `rev + 1`, only if the file is at `if_rev` (0 for no file yet; required). `updateRegistry` with a constant change: the same
// results and errors, and a bad shape is a TypeError before anything is read.
export async function writeRegistry({ env = process.env, if_rev, resources, pools, ...rest } = {}) {
  if (!wholeNumber(if_rev)) throw new TypeError('if_rev must be a whole number (0 when there is no file yet)');
  normalise(resources, pools);
  return updateRegistry({ ...rest, env, if_rev, change: () => ({ resources, pools }) });
}

// ---- seed ----

// The seed at start (AD-30, FR-3): derives the Registry from `devices` (default this checkout's) and writes it with one `writeRegistry`
// at the file's rev (0 for no file yet), reason `seed`, and only when something differs, so an unchanged seed writes and logs nothing.
// Seeded identity, lock, name and deploy_target follow devices.json; Capabilities, retirements and runtime Resources stay (see
// `reseed`). `qaDevices` (default the private QA file) is read only when the file is first created, and a broken one fails the seed
// before anything is written, so the one import is retried at the next start. An unreadable file is HUB_REGISTRY_FORMAT before any
// QA read and is left as it is. Returns `{first, rev, changed, events, warnings}`.
export async function applySeed({ env = process.env, devices, qaDevices, now, hostId, log, actor, why } = {}) {
  const path = registryPath(env);
  const file = loadFile(path);
  if (file.state === 'unreadable') throw formatError(file.reason, path);
  const first = file.state === 'missing';
  const source = devices ?? loadDevices(env);
  const next = reseed(first ? null : { resources: file.resources, pools: file.pools }, source, { qaDevices: qaDevices ?? (() => loadQaDevices({ env })), now });
  const written = await writeRegistry({ env, if_rev: first ? 0 : file.rev, resources: next.resources, pools: next.pools, reason: 'seed', actor, why, now, hostId, log });
  return { first, rev: written.rev, changed: written.changed, events: written.events, warnings: next.warnings };
}

// ---- recovery ----

// The highest rev any `registry-*` event of the log carries, or 0.
function loggedRev(env, log) {
  let top = 0;
  for (const event of readEvents({ env, log })) {
    if (typeof event.event === 'string' && event.event.startsWith('registry-') && wholeNumber(event.rev) && event.rev > top) top = event.rev;
  }
  return top;
}

// At start (AD-27): the rename is the deciding step, so a crash between it and its events leaves the file ahead of the log. When
// the file's rev is above every logged one, appends one `registry-edit` for the whole Registry with `reason: 'recovered'` at the
// file's rev; a second call finds the log level and appends nothing. A missing or unreadable file, or a log that is ahead or equal,
// does nothing. Returns `{recovered, rev, logged_rev}`.
export function recoverRegistry({ env = process.env, now, hostId, log } = {}) {
  const file = loadFile(registryPath(env));
  if (file.state !== 'ok') return { recovered: false, rev: 0, logged_rev: null };
  const logged = loggedRev(env, log);
  if (file.rev <= logged) return { recovered: false, rev: file.rev, logged_rev: logged };
  const written = noteRegistry('edit', { resource: WHOLE, lock: WHOLE, rev: file.rev, reason: 'recovered' }, { env, now, hostId, log });
  return { recovered: written === true, rev: file.rev, logged_rev: logged };
}
