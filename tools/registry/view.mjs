// The Registry view (AD-31, FR-29): the one pure projection from stored records to the record a Registry reader serves. The Hub API's
// `/resources` and `/pools` use it now; `hub-device registry list` (6.8) and the `/status` registry block (Epic 8) read through it
// too, so no reader re-derives the served shape, the visibility rule or the redaction.
//
// Pure: no I/O, no clock. It imports only the matcher (which is pure). The caller reads the Registry (`readRegistry`) and, for a
// record `retirement()` marks, the lock's `{held, queued}` (claims.mjs `lockActivity`), and passes them in. The input is never mutated.
import { match, visibility } from './match.mjs';

// `local` keeps every value; `service` (every API response) nulls a dedicated_qa Resource's serial, UDID and adb id, keys kept.
export const AUDIENCES = Object.freeze(['local', 'service']);

// The keys of a served record, in order. `words`, `display_name` and any other stored key are not served.
export const RECORD_KEYS = Object.freeze([
  'id', 'lock', 'name', 'kind', 'host', 'identity', 'capabilities', 'deploy_target', 'seeded', 'seed_missing', 'created_at', 'retired_at', 'visibility',
]);

const QA_IDENTITY_KEYS = Object.freeze(['serial', 'udid', 'adb_id']);
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = value => (typeof value === 'string' ? value : null);

// A copy of an object without `allowed_users` (QA's user list never leaves the store, for any audience).
const without = object => {
  const { allowed_users: _users, ...rest } = structuredClone(object);
  return rest;
};

// The served record for `record`, or null when it is hidden (retired or seed-missing and neither held nor waited on). `held` and
// `queued` are the caller's reading of the Resource's lock (false when the record is not retiring: it is not read for a live one).
export function viewRecord(record, { audience = 'local', held = false, queued = false } = {}) {
  if (!AUDIENCES.includes(audience)) throw new TypeError(`audience is one of ${AUDIENCES.join(', ')}, not "${audience}"`);
  const shown = visibility(record, { held, queued });
  if (shown === 'hidden') return null;
  const capabilities = isObject(record.capabilities) ? without(record.capabilities) : {};
  const identity = isObject(record.identity) ? without(record.identity) : null;
  if (audience === 'service' && capabilities.dedicated_qa === true && identity !== null) {
    for (const key of QA_IDENTITY_KEYS) if (key in identity) identity[key] = null;
  }
  return {
    id: text(record.id),
    lock: text(record.lock),
    name: text(record.name),
    kind: text(record.kind),
    host: text(record.host),
    identity,
    capabilities,
    deploy_target: record.deploy_target === true,
    seeded: record.seeded === true,
    seed_missing: record.seed_missing === true,
    created_at: text(record.created_at),
    retired_at: text(record.retired_at),
    visibility: shown,
  };
}

// Every Pool of `registry` (`{resources, pools: {<name>: {...}}}`) in its stored order as `{name, kind, members, gate}`: `named` when
// it has a `members` array (the ids `match` would try for a lease of that Pool, in order, so a reader and a lease cannot disagree;
// `[]` when nothing can serve it), else `gate` with no members. `gate` is the stored string or null.
export function viewPools(registry, policy) {
  return Object.entries(registry?.pools ?? {}).map(([name, pool]) => {
    const named = Array.isArray(pool?.members);
    let members = [];
    if (named) {
      try { members = match(registry, { pool: name }, policy).members.map(record => record.id); } catch (error) {
        if (error?.code !== 'HUB_NO_MATCH' && error?.code !== 'HUB_POOL_CROSS_HOST') throw error;
      }
    }
    return { name, kind: named ? 'named' : 'gate', members, gate: text(pool?.gate) };
  });
}
