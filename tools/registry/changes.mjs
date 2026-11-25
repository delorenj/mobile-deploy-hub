// The Registry's change planners (AD-28, FR-1): the pure half of every Registry write route. A route checks a request body into a
// normalised input (`checkRegisterBody`), then, inside the store's per-path queue (`updateRegistry`'s `change`), plans the new records
// against the file as it is at commit time (`planRegister`). 6.7 adds the edit and retire pairs (`checkEditBody`/`planEdit`,
// `checkRetireBody`/`planRetire`) and the helpers they share with register (`checkWho`, `nameTaken`).
//
// Pure: no I/O, no clock of its own (the caller passes `now`), and the records it is given are never mutated. It imports only the
// names rules of lock.mjs (`isSlug`, `NAME_MAX`, `reservedBy`, `checkActor`) and the matcher's one live/retired rule. Its errors are
// coded (`code`, `status`, `reason`; `holder` on a duplicate) and carry no `exit`: the API's one table (claims.mjs) maps the code.
import { NAME_MAX, checkActor, isSlug, reservedBy } from '../ci/lib/lock.mjs';
import { retirement } from './match.mjs';

// What a runtime register may create. The emulator Pool is seeded only.
export const REGISTER_KINDS = Object.freeze(['phone', 'ios-lane']);
export const IDENTITY_KEYS = Object.freeze(['serial', 'model', 'udid', 'profile']);
// What a capability key may never be: QA's user list, and the facets the matcher reads off the record itself.
export const FORBIDDEN_CAPABILITIES = Object.freeze(['allowed_users', 'id', 'name', 'kind', 'host', 'model', 'deploy_target']);
const BODY_KEYS = Object.freeze(['kind', 'name', 'host', 'identity', 'capabilities', 'if_rev', 'actor', 'holder', 'why']);
// What an edit may carry. The immutable keys pass the body check and are always refused by the plan (AD-28): by presence, never by value.
export const IMMUTABLE_KEYS = Object.freeze(['id', 'lock', 'kind', 'host', 'identity']);
export const EDIT_KEYS = Object.freeze(['name', 'capabilities', 'if_rev', 'actor', 'holder', 'why', ...IMMUTABLE_KEYS]);
export const RETIRE_KEYS = Object.freeze(['if_rev', 'actor', 'holder', 'why']);
const CAPABILITY_KEY = /^[a-z][a-z0-9_]*$/;
// A suffix `-<n>` of a minted id goes up to 999: `res-<28 chars>-999` is a lock of 36 characters, a slug part of 32.
const MINT_MAX = 999;
// The identity values two live records may never share.
const UNIQUE_IDENTITY = Object.freeze(['serial', 'udid']);

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonEmpty = value => typeof value === 'string' && value !== '';
const coded = (code, status, reason, message, extra) => Object.assign(new Error(message), { code, status, reason, ...extra });
const usage = (reason, message) => coded('HUB_USAGE', 400, reason, message);
const nameError = (status, reason, message) => coded('HUB_REGISTRY_NAME', status, reason, message);

function checkIdentity(identity, kind) {
  if (identity === undefined) {
    if (kind === 'phone') throw usage('no-model', 'a phone needs identity.model');
    return null;
  }
  if (!isObject(identity)) throw usage('bad-identity', 'identity must be an object');
  for (const [key, value] of Object.entries(identity)) {
    if (!IDENTITY_KEYS.includes(key)) throw usage('bad-identity', `identity has no key "${key}" (${IDENTITY_KEYS.join(', ')})`);
    if (!nonEmpty(value)) throw usage('bad-identity', `identity.${key} must be a non-empty string`);
  }
  if (kind === 'phone' && !nonEmpty(identity.model)) throw usage('no-model', 'a phone needs identity.model');
  return { ...identity };
}

// `patch` (an edit): a value of `null` removes the key; the key rules are the register's either way.
function checkCapabilities(capabilities, { patch = false } = {}) {
  if (capabilities === undefined) return {};
  if (!isObject(capabilities)) throw usage('bad-capabilities', 'capabilities must be a flat object');
  for (const [key, value] of Object.entries(capabilities)) {
    if (!CAPABILITY_KEY.test(key)) throw usage('bad-capabilities', `capability key "${key}" must match ${CAPABILITY_KEY}`);
    if (FORBIDDEN_CAPABILITIES.includes(key)) throw usage('bad-capabilities', `"${key}" cannot be a capability`);
    if (patch && value === null) continue;
    if (typeof value !== 'string' && typeof value !== 'boolean' && !(typeof value === 'number' && Number.isFinite(value))) {
      throw usage('bad-capabilities', `capability "${key}" must be a string, a finite number${patch ? ', a boolean or null (remove)' : ' or a boolean'}`);
    }
  }
  return { ...capabilities };
}

// The actor of a write (AD-36), the one rule of every Registry write route: a given `actor` is recorded exactly as given; an absent one
// is `{holder, via: 'api'}`, set once here; neither is `no-holder`.
export function checkWho(body) {
  if (body.actor !== undefined) {
    let actor = null;
    try { actor = checkActor(body.actor); } catch (error) { throw usage('bad-actor', error.message); }
    if (actor === null) throw usage('bad-actor', 'actor must be {holder, via}');
    return actor;
  }
  if (!nonEmpty(body.holder)) throw usage('no-holder', 'say who is writing: an actor, or a holder');
  return { holder: body.holder, via: 'api' };
}

// Checks a register body into the normalised input `{kind, name, host, identity, capabilities, if_rev, actor, why}` (`if_rev` and `why`
// undefined when absent; `identity` null for an `ios-lane` with none), or throws a coded error: HUB_USAGE 400 with the reason
// (bad-body, bad-kind, bad-host, bad-identity, no-model, bad-capabilities, bad-if-rev, bad-why, bad-actor, no-holder; all checked
// before the name), or HUB_REGISTRY_NAME 400 (`not-slug`, `too-long`). `hosts` is claims.mjs's HOST_PLATFORMS (host key to platform): an `ios-lane`
// must be on a `darwin` one. Stateless: the checks that need the Registry are `planRegister`'s.
export function checkRegisterBody(body, { hosts } = {}) {
  if (!isObject(body)) throw usage('bad-body', 'the body must be a JSON object');
  for (const key of Object.keys(body)) if (!BODY_KEYS.includes(key)) throw usage('bad-body', `the body has no key "${key}" (${BODY_KEYS.join(', ')})`);
  if (!REGISTER_KINDS.includes(body.kind)) throw usage('bad-kind', `kind must be one of ${REGISTER_KINDS.join(', ')}`);
  if (typeof body.host !== 'string' || !isObject(hosts) || !Object.hasOwn(hosts, body.host)) throw usage('bad-host', `host must be one of ${Object.keys(hosts ?? {}).join(', ')}`);
  if (body.kind === 'ios-lane' && hosts[body.host] !== 'darwin') throw usage('bad-host', `an ios-lane lives on a mac host, not "${body.host}"`);
  const identity = checkIdentity(body.identity, body.kind);
  const capabilities = checkCapabilities(body.capabilities);
  if (body.if_rev !== undefined && !(Number.isSafeInteger(body.if_rev) && body.if_rev >= 0)) throw usage('bad-if-rev', 'if_rev must be a whole number');
  if (body.why !== undefined && typeof body.why !== 'string') throw usage('bad-why', 'why must be a string');
  const actor = checkWho(body);
  if (!isSlug(body.name)) throw nameError(400, 'not-slug', 'name must be a slug: lowercase letters and digits, single dashes between');
  if (body.name.length > NAME_MAX) throw nameError(400, 'too-long', `name is longer than ${NAME_MAX} characters`);
  return { kind: body.kind, name: body.name, host: body.host, identity, capabilities, if_rev: body.if_rev, actor, why: body.why };
}

// Whether any record (retired and seed-missing included) other than `exceptId` has `name` as a name, id, lock or word.
export function nameTaken(name, resources, exceptId) {
  return resources.some(record => record.id !== exceptId && (record.name === name || record.id === name || record.lock === name
    || (Array.isArray(record.words) && record.words.includes(name))));
}

// The id a new Resource mints: `res-<name>`, or `res-<name>-<n>` with the smallest free n >= 2 when any record (retired included) has
// that string as an id or a lock. Ids are never reused (AD-28). Past 999 it is HUB_REGISTRY_NAME 409 `exhausted`.
function mint(name, resources) {
  const used = new Set(resources.flatMap(record => [record.id, record.lock]));
  const base = `res-${name}`;
  if (!used.has(base)) return base;
  for (let n = 2; n <= MINT_MAX; n += 1) if (!used.has(`${base}-${n}`)) return `${base}-${n}`;
  throw nameError(409, 'exhausted', `every id from ${base}-2 to ${base}-${MINT_MAX} is taken`);
}

// The live record that holds `identity`'s serial or UDID, as `{key, holder}`, or null. Retired and seed-missing records do not hold one.
function identityHolder(identity, resources) {
  for (const key of UNIQUE_IDENTITY) {
    if (!nonEmpty(identity?.[key])) continue;
    const holder = resources.find(record => retirement(record) === null && record.identity?.[key] === identity[key]);
    if (holder) return { key, holder: holder.id };
  }
  return null;
}

// Plans a register of `input` (a `checkRegisterBody` result) against `current` (`{resources}`, the file as it is at commit time):
// `{record, resources}` with the new record appended last, or a coded error: HUB_REGISTRY_NAME 409 (`reserved`, `taken`,
// `exhausted`), or HUB_REGISTRY_DUPLICATE 409 (`serial` or `udid`, with `holder`: the id of the live record that has it; the
// message never carries the value). `current` is not mutated. `now` is a clock function (default Date.now).
export function planRegister(current, input, { now = Date.now } = {}) {
  const resources = Array.isArray(current?.resources) ? current.resources : [];
  const { name } = input;
  const reserved = reservedBy(name);
  if (reserved !== null) throw nameError(409, 'reserved', `"${name}" is a reserved word (${reserved})`);
  if (nameTaken(name, resources)) throw nameError(409, 'taken', `"${name}" already names a Resource`);
  const duplicate = identityHolder(input.identity, resources);
  if (duplicate) throw coded('HUB_REGISTRY_DUPLICATE', 409, duplicate.key, `a live Resource (${duplicate.holder}) already has this ${duplicate.key}`, { holder: duplicate.holder });
  const id = mint(name, resources);
  const record = {
    id, lock: id, name, words: [], display_name: name, kind: input.kind, host: input.host, identity: input.identity ?? null,
    capabilities: { ...input.capabilities }, deploy_target: false, seeded: false, created_at: new Date(now()).toISOString(),
  };
  return { record, resources: [...resources, record] };
}

// ---- edit and retire (6.7) ----

// The `if_rev` and `why` checks every write body shares; `required` makes an absent `if_rev` `no-if-rev`.
function checkRevAndWhy(body, { required }) {
  if (body.if_rev === undefined && required) throw usage('no-if-rev', 'an edit needs if_rev: the revision the change is based on');
  if (body.if_rev !== undefined && !(Number.isSafeInteger(body.if_rev) && body.if_rev >= 0)) throw usage('bad-if-rev', 'if_rev must be a whole number');
  if (body.why !== undefined && typeof body.why !== 'string') throw usage('bad-why', 'why must be a string');
}

function checkKeys(body, allowed) {
  if (!isObject(body)) throw usage('bad-body', 'the body must be a JSON object');
  for (const key of Object.keys(body)) if (!allowed.includes(key)) throw usage('bad-body', `the body has no key "${key}" (${allowed.join(', ')})`);
}

// Checks an edit body into `{name, capabilities, immutable, if_rev, actor, why}`: `name` and `capabilities` (a merge patch: a scalar
// sets a key, `null` removes it) undefined when absent; `immutable` the immutable keys the body carries, in IMMUTABLE_KEYS order (the
// plan refuses them). HUB_USAGE 400: bad-body, no-if-rev, bad-if-rev, bad-capabilities, bad-why, bad-actor, no-holder, no-change; then
// HUB_REGISTRY_NAME 400 (`not-slug`, `too-long`). Stateless.
export function checkEditBody(body) {
  checkKeys(body, EDIT_KEYS);
  checkRevAndWhy(body, { required: true });
  const capabilities = body.capabilities === undefined ? undefined : checkCapabilities(body.capabilities, { patch: true });
  const actor = checkWho(body);
  const immutable = IMMUTABLE_KEYS.filter(key => body[key] !== undefined);
  if (body.name === undefined && capabilities === undefined && immutable.length === 0) throw usage('no-change', 'an edit needs a name or capabilities to change');
  if (body.name !== undefined) {
    if (!isSlug(body.name)) throw nameError(400, 'not-slug', 'name must be a slug: lowercase letters and digits, single dashes between');
    if (body.name.length > NAME_MAX) throw nameError(400, 'too-long', `name is longer than ${NAME_MAX} characters`);
  }
  return { name: body.name, capabilities, immutable, if_rev: body.if_rev, actor, why: body.why };
}

// Checks a retire body into `{if_rev, actor, why}` (`if_rev` and `why` undefined when absent). HUB_USAGE 400: bad-body, bad-if-rev,
// bad-why, bad-actor, no-holder.
export function checkRetireBody(body) {
  checkKeys(body, RETIRE_KEYS);
  checkRevAndWhy(body, { required: false });
  return { if_rev: body.if_rev, actor: checkWho(body), why: body.why };
}

const notFound = id => coded('HUB_RESOURCE_NOT_FOUND', 404, 'unknown', `no Resource "${id}"`);
const seededError = (reason, message) => coded('HUB_REGISTRY_SEEDED', 409, reason, message);

// Plans an edit of the record `id` against `current` (`{resources}`, the file at commit time): `{record, resources}`, the record
// replaced in place. Refusals, in order: HUB_RESOURCE_NOT_FOUND 404 `unknown`; HUB_RESOURCE_RETIRED 409 (`retired`, `seed-missing`);
// for a seeded record HUB_REGISTRY_SEEDED 409 (an immutable key: that key; a different name: `name`: a hub release changes those, and
// the seed overwrites them at each start; capabilities stay editable); for a runtime one HUB_USAGE 400 `immutable`; then the name rules
// (HUB_REGISTRY_NAME 409 `reserved`, `taken`; a name equal to the record's is no change). `display_name` follows `name`. `current` is not mutated.
export function planEdit(current, id, input) {
  const resources = Array.isArray(current?.resources) ? current.resources : [];
  const record = resources.find(entry => entry.id === id);
  if (!record) throw notFound(id);
  const marked = retirement(record);
  if (marked !== null) {
    throw coded('HUB_RESOURCE_RETIRED', 409, marked, `${id} is ${marked === 'retired' ? 'retired' : 'seed-missing'} (reason: ${marked}): it cannot be edited`, { resource: id });
  }
  const renamed = input.name !== undefined && input.name !== record.name;
  if (record.seeded === true) {
    if (input.immutable.length > 0) throw seededError(input.immutable[0], `${id} is seeded from devices.json: its ${input.immutable[0]} changes with a hub release`);
    if (renamed) throw seededError('name', `${id} is seeded from devices.json: its name changes with a hub release`);
  } else if (input.immutable.length > 0) {
    throw usage('immutable', `${input.immutable.join(', ')} cannot be edited: ${id} keeps it for good`);
  }
  if (renamed) {
    const reserved = reservedBy(input.name);
    if (reserved !== null) throw nameError(409, 'reserved', `"${input.name}" is a reserved word (${reserved})`);
    if (nameTaken(input.name, resources, id)) throw nameError(409, 'taken', `"${input.name}" already names a Resource`);
  }
  const next = structuredClone(record);
  if (renamed) { next.name = input.name; next.display_name = input.name; }
  if (input.capabilities !== undefined) {
    const capabilities = isObject(next.capabilities) ? next.capabilities : {};
    for (const [key, value] of Object.entries(input.capabilities)) {
      if (value === null) delete capabilities[key]; else capabilities[key] = value;
    }
    next.capabilities = capabilities;
  }
  return { record: next, resources: resources.map(entry => (entry === record ? next : entry)) };
}

// Plans a retire of the record `id`: `retired_at` is set to now (ISO) and nothing else changes: the lock, its Hold and its queue are not
// this function's. Refusals: HUB_RESOURCE_NOT_FOUND 404 `unknown`. An already-retired record is a no-op, seeded or not: the same record, the same list.
// Then HUB_REGISTRY_SEEDED 409 `retire` (a hub release retires a seeded Resource). `current` is not mutated.
export function planRetire(current, id, _input, { now = Date.now } = {}) {
  const resources = Array.isArray(current?.resources) ? current.resources : [];
  const record = resources.find(entry => entry.id === id);
  if (!record) throw notFound(id);
  if (record.retired_at) return { record, resources: [...resources] };
  if (record.seeded === true) throw seededError('retire', `${id} is seeded from devices.json: a hub release retires it`);
  const next = { ...structuredClone(record), retired_at: new Date(now()).toISOString() };
  return { record: next, resources: resources.map(entry => (entry === record ? next : entry)) };
}
