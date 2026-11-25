// The matcher (AD-33, FR-6): the one pure function that turns a request for a phone into the Resources that can serve it. A request is
// a named list (`{pool: 'phone'}`, the seeded Pool) or a Capability query (`{query: parseQuery('api_level>=34,kind=phone')}`), and
// both come out as the same shape, so the CLI, the Hub API and the Host Agent cannot pick different phones for the same ask.
//
// Pure: no I/O, no clock, and it imports nothing that has any (not lock.mjs, not claims.mjs, not tools/device/*). The caller passes the
// `seed()` result, the request and the policy. The deploy path never imports this directory (tools/deploy-path.test.mjs).

const usage = message => Object.assign(new Error(message), { code: 'HUB_USAGE' });

const KEY = /^[a-z][a-z0-9_]*$/;
const DECIMAL = /^-?\d+(\.\d+)?$/;
const OPS = ['>=', '<=', '='];

// `key=value`, `key>=n`, `key<=n`, comma separated: [{key, op, value}] with `value` the raw text. A clause that is empty or does not
// parse is HUB_USAGE naming it; `>=` and `<=` take a finite decimal number.
export function parseQuery(text) {
  if (typeof text !== 'string' || text === '') throw usage('--match needs a query like kind=phone,api_level>=34');
  return text.split(',').map(clause => {
    const parsed = /^([^=<>]*)(>=|<=|=)(.*)$/s.exec(clause);
    if (clause === '') throw usage(`--match "${text}": empty clause (clauses are key=value, key>=n or key<=n, separated by commas)`);
    if (parsed === null || !KEY.test(parsed[1])) throw usage(`--match clause "${clause}": expected key=value, key>=n or key<=n (a key is lowercase letters, digits and _)`);
    const [, key, op, value] = parsed;
    if (value === '') throw usage(`--match clause "${clause}": the value is empty`);
    if (op !== '=' && (!DECIMAL.test(value) || !Number.isFinite(Number(value)))) throw usage(`--match clause "${clause}": ${op} takes a number, not "${value}"`);
    return { key, op, value };
  });
}

// A query as one line, `key op value` clauses joined by `,`: the label a Pool request and every report line carry.
export const canonical = clauses => clauses.map(({ key, op, value }) => `${key}${op}${value}`).join(',');

// ---- facets ----

const INTRINSIC = ['id', 'name', 'kind', 'host', 'model', 'deploy_target'];
const usable = value => typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value));

// What a clause can read of one record: the intrinsic facets, then every Capability (an intrinsic facet wins a name clash). A facet
// with no usable value (null, an object, a non-finite number) is not there.
function facetsOf(record) {
  const facets = new Map();
  const own = { id: record.id, name: record.name, kind: record.kind, host: record.host, model: record.identity?.model, deploy_target: record.deploy_target };
  for (const key of INTRINSIC) if (usable(own[key])) facets.set(key, own[key]);
  for (const [key, value] of Object.entries(record.capabilities ?? {})) if (!facets.has(key) && !INTRINSIC.includes(key) && usable(value)) facets.set(key, value);
  return facets;
}

const typeOf = value => (typeof value === 'boolean' ? 'a true/false facet' : typeof value === 'number' ? 'a number facet' : 'a text facet');

// Why one clause does not hold for a record, or null when it holds. `=` compares by the facet's own type; `>=` and `<=` read only a number.
function refusal(facets, { key, op, value }) {
  if (!facets.has(key)) return `has no ${key}`;
  const actual = facets.get(key);
  if (op === '=') {
    if (typeof actual === 'boolean') {
      if (value !== 'true' && value !== 'false') return `${key} is ${actual}, and "${value}" is not true or false`;
      return actual === (value === 'true') ? null : `${key} is ${actual}, not ${value}`;
    }
    if (typeof actual === 'number') {
      if (!DECIMAL.test(value) || !Number.isFinite(Number(value))) return `${key} is ${actual}, and "${value}" is not a number`;
      return actual === Number(value) ? null : `${key} is ${actual}, not ${value}`;
    }
    return actual === value ? null : `${key} is ${actual}, not ${value}`;
  }
  if (typeof actual !== 'number') return `${key} is ${actual} (${typeOf(actual)}), and ${op} reads only a number`;
  return (op === '>=' ? actual >= Number(value) : actual <= Number(value)) ? null : `${key} is ${actual}, not ${op}${value}`;
}

const retired = record => Boolean(record.retired_at) || record.seed_missing === true;
const dedicated = record => record.capabilities?.dedicated_qa === true;
const QA_WHY = 'is dedicated_qa (name it or ask for dedicated_qa)';

// ---- match ----

const noMatch = (excluded, resources) => {
  const reason = excluded.length > 0 ? excluded.map(({ id, why }) => `${id} ${why}`).join('; ') : resources.length === 0 ? 'the Registry has no Resources' : 'nothing is in the list';
  return Object.assign(new Error(`no Resource matches: ${reason}`), { code: 'HUB_NO_MATCH', reason, excluded });
};

// Resolves one request against `registry` (`{resources, pools}`, a `seed()` result) and `policy` (for `queue.deploy_target_lease_max_min`).
// `request` is `{pool: <name>}` or `{query: clauses}`, with an optional `for_ms` (how long the Claimant wants it). Returns
// `{pool: {kind: 'named'|'query', name}, members, host, excluded}`, members in the Registry's own order (a named list's order, else the
// seed order) and `excluded` as [{id, why}] for every Resource that was left out of a query (or a named list's runtime phones).
//   - `{pool: 'phone'}`: the Pool's seeded members in order, then every runtime phone on `linux` that is not dedicated_qa, by created_at.
//     A seeded member is served even when it is dedicated_qa (FR-3): the QA mark keeps a Resource out of a query, not out of the list.
//   - `{query}`: every Resource whose facets satisfy every clause, except a retired one and a dedicated_qa one, which a request must
//     name (an `id=` or `name=` clause equal to it) or ask for (any `dedicated_qa` clause).
//   - both: a deploy target is dropped when `for_ms` is over the policy's deploy-target cap.
// No member throws HUB_NO_MATCH (`reason`, `excluded`); members on more than one host throw HUB_POOL_CROSS_HOST.
export function match(registry, request, policy) {
  const resources = registry?.resources ?? [];
  const excluded = [];
  const capMin = policy?.queue?.deploy_target_lease_max_min;
  const forMs = request?.for_ms;
  const overCap = record => (record.deploy_target === true && capMin > 0 && Number.isFinite(forMs) && forMs > capMin * 60_000
    ? `is a deploy target capped at ${capMin} min, under the ${Math.ceil(forMs / 60_000)} min asked` : null);
  let members;
  let pool;
  if (request?.pool !== undefined) {
    const named = typeof request.pool === 'string' ? registry?.pools?.[request.pool] : undefined;
    if (!Array.isArray(named?.members)) {
      const known = Object.entries(registry?.pools ?? {}).filter(([, value]) => Array.isArray(value?.members)).map(([name]) => name);
      throw usage(`unknown pool "${request.pool}" (known: ${known.join(', ') || 'none'})`);
    }
    pool = { kind: 'named', name: request.pool };
    const seeded = named.members.map(id => resources.find(record => record.id === id)).filter(Boolean);
    const runtime = resources
      .filter(record => record.seeded === false && record.kind === 'phone' && record.host === 'linux' && !seeded.includes(record))
      .map((record, index) => ({ record, index }))
      .sort((a, b) => String(a.record.created_at ?? '').localeCompare(String(b.record.created_at ?? '')) || a.index - b.index)
      .map(({ record }) => record);
    members = [];
    for (const record of [...seeded, ...runtime]) {
      const why = retired(record) ? 'is retired' : record.seeded === false && dedicated(record) ? QA_WHY : overCap(record);
      if (why === null) members.push(record); else excluded.push({ id: record.id, why });
    }
  } else if (Array.isArray(request?.query) && request.query.length > 0) {
    const clauses = request.query;
    pool = { kind: 'query', name: canonical(clauses) };
    const asked = clauses.some(clause => clause.key === 'dedicated_qa');
    members = [];
    for (const record of resources) {
      const facets = facetsOf(record);
      let why = null;
      for (const clause of clauses) { why = refusal(facets, clause); if (why !== null) break; }
      if (why === null && retired(record)) why = 'is retired';
      if (why === null && dedicated(record)) {
        const named = clauses.some(clause => clause.op === '=' && (clause.key === 'id' || clause.key === 'name') && (clause.value === record.id || clause.value === record.name));
        if (!asked && !named) why = QA_WHY;
      }
      if (why === null) why = overCap(record);
      if (why === null) members.push(record); else excluded.push({ id: record.id, why });
    }
  } else {
    throw usage('a match request is {pool: <name>} or {query: [clauses]}');
  }
  if (members.length === 0) throw noMatch(excluded, resources);

  const hosts = new Map();
  for (const record of members) hosts.set(record.host, [...(hosts.get(record.host) ?? []), record.id]);
  if (hosts.size > 1) {
    const each = [...hosts].map(([host, ids]) => `${host} (${ids.join(', ')})`).join(', ');
    throw Object.assign(new Error(`the match spans hosts: ${each}; a Pool lives on one host, so ask for one (host=<key>)`), { code: 'HUB_POOL_CROSS_HOST', hosts: Object.fromEntries(hosts) });
  }
  return { pool, members, host: members[0].host, excluded };
}
