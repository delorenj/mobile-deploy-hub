// Story 6.4: docs/hub-api-contract.md and tools/hub-api/routes.mjs say the same thing. The document's route table must equal ROUTES
// (method and path, both ways), each route's response keys (flattened to dotted paths, arrays not expanded) must equal its shape's
// field list exactly, an error must match `Problem`, and every key is snake_case. Later route stories add a row and a `### <Shape>`
// section and this test covers them with no change.
//
// Field notation in the document: `a.b` is a key of an object; `a[].b` a key of the objects in the array `a` (the union over its items;
// an empty array or an array of scalars is the leaf `a`); `a.*` an open object whose keys the document does not list (the leaf `a.*`
// whatever the value, even null); `{name}` in a route path is a parameter.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDevices } from '../ci/lib/devices.mjs';
import { loadPolicy } from '../ci/lib/policy.mjs';
import { hermetic } from '../ci/test-fixtures.mjs';
import { EXIT_CODES } from '../device/claims.mjs';
import { CONTRACT_VERSION, ROUTES, handle } from './routes.mjs';

hermetic();

const DOC = fileURLToPath(new URL('../../docs/hub-api-contract.md', import.meta.url));
const SNAKE = /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/;

// What the document says: {version, routes: ['GET /health', ...], shapes: {Health: ['ok', 'ports.hub_api', ...]}, shapeOf: {'GET /health': 'Health'}, codes}.
export function parseContract(text) {
  const version = Number(/^Status:\s*contract\s+(\d+)\b/m.exec(text)?.[1]);
  const routes = [];
  const shapeOf = {};
  const table = /^\|\s*Method\s*\|\s*Path\s*\|\s*Shape\s*\|\s*Added\s*\|\s*$/m.exec(text);
  if (table) {
    for (const line of text.slice(table.index + table[0].length).split('\n').slice(2)) {
      if (!line.startsWith('|')) break;
      const cells = line.split('|').slice(1, -1).map(cell => cell.trim());
      const key = `${cells[0]} ${cells[1].replace(/`/g, '')}`;
      routes.push(key);
      shapeOf[key] = cells[2];
    }
  }
  const shapes = {};
  let current = null;
  for (const line of text.split('\n')) {
    const heading = /^###\s+(\S+)\s*$/.exec(line);
    if (heading) { current = heading[1]; shapes[current] = []; continue; }
    if (/^#{1,2}\s/.test(line)) { current = null; continue; }
    const field = current && /^-\s+`([^`]+)`/.exec(line);
    if (field) shapes[current].push(field[1]);
  }
  const codes = {};
  const errors = /^## Error codes\s*$/m.exec(text);
  if (errors) {
    for (const line of text.slice(errors.index).split('\n').slice(1)) {
      if (/^## /.test(line)) break;
      const row = /^\|\s*`([A-Z_]+)`\s*\|[^|]*\|\s*(\d+)\s*\|/.exec(line);
      if (row) codes[row[1]] = Number(row[2]);
    }
  }
  return { version, routes, shapes, shapeOf, codes };
}

// The key paths of an object's keys, sorted: objects recursed (`a.b`); an array of objects is the union of its items' paths under
// `a[]` (`a[].b`); an empty array or an array with a scalar is a leaf; a path in `open` (a doc entry `x.*`, given as `x`) is the leaf
// `x.*` whatever its value.
export function flatten(value, prefix = '', open = new Set()) {
  const out = [];
  for (const [key, child] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (open.has(path)) out.push(`${path}.*`);
    else if (child !== null && typeof child === 'object' && !Array.isArray(child)) out.push(...flatten(child, path, open));
    else if (Array.isArray(child) && child.length > 0 && child.every(item => item !== null && typeof item === 'object' && !Array.isArray(item))) {
      out.push(...new Set(child.flatMap(item => flatten(item, `${path}[]`, open))));
    } else out.push(path);
  }
  return out.sort();
}

// The open prefixes of a document field list: every `x.*` entry names `x`.
export const openPrefixes = fields => new Set(fields.filter(field => field.endsWith('.*')).map(field => field.slice(0, -2)));

// The response's fields as the document would list them, the open prefixes of that shape's own entries honoured.
const shapeFields = (shape, body) => flatten(body, '', openPrefixes(contract.shapes[shape]));

// The differences between the document's route set and the code's, as readable strings (empty when equal).
export function routeDiff(docRoutes, codeRoutes) {
  const doc = new Set(docRoutes);
  const code = new Set(codeRoutes);
  return [...[...code].filter(route => !doc.has(route)).map(route => `${route} is in routes.mjs but not in the document`), ...[...doc].filter(route => !code.has(route)).map(route => `${route} is in the document but not in routes.mjs`)];
}

export function fieldDiff(docFields, codeFields) {
  const doc = new Set(docFields);
  const code = new Set(codeFields);
  return [...[...code].filter(key => !doc.has(key)).map(key => `${key} is in the response but not in the document`), ...[...doc].filter(key => !code.has(key)).map(key => `${key} is in the document but not in the response`)];
}

const contract = parseContract(readFileSync(DOC, 'utf8'));
const routeKey = route => `${route.method} ${route.path}`;

// What each route parameter is replaced with when the test calls a route (a parameter not listed here fails the test).
const PARAM_SAMPLES = Object.freeze({ id: 's26' });
export function samplePath(path, samples = PARAM_SAMPLES) {
  return path.replace(/\{([a-z_]+)\}/g, (_, name) => {
    if (!Object.hasOwn(samples, name)) throw new Error(`no sample for the route parameter {${name}} in ${path}: add it to PARAM_SAMPLES`);
    return samples[name];
  });
}

function scratch() {
  const root = mkdtempSync(join(tmpdir(), 'hub-api-contract-'));
  const env = { PATH: process.env.PATH, HOME: root, HUB_LOCK_DIR: join(root, 'locks'), HUB_EVENT_DIR: join(root, 'events') };
  const devices = structuredClone(loadDevices({}));
  return { root, ctx: { env, policy: loadPolicy().policy, devices, qaDevices: () => [], log: { out: () => {}, err: () => {} } }, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('the Status line carries the contract version of the code', () => {
  assert.equal(contract.version, CONTRACT_VERSION);
});

test('the route table of the document equals ROUTES, both ways', () => {
  assert.deepEqual(routeDiff(contract.routes, ROUTES.map(routeKey)), []);
  assert.ok(contract.routes.length > 0, 'the table parsed');
});

test('the route comparison fails on a synthetic extra route on either side', () => {
  const real = ROUTES.map(routeKey);
  assert.deepEqual(routeDiff(real, real), []);
  assert.deepEqual(routeDiff(contract.routes, [...real, 'GET /ghost']), ['GET /ghost is in routes.mjs but not in the document']);
  assert.deepEqual(routeDiff([...contract.routes, 'POST /ghost'], real), ['POST /ghost is in the document but not in routes.mjs']);
  assert.deepEqual(fieldDiff(['a', 'b'], ['a', 'b']), []);
  assert.equal(fieldDiff(['a', 'b'], ['a']).length, 1);
  assert.equal(fieldDiff(['a'], ['a', 'b']).length, 1);
});

test('every route names a shape the document describes, and no shape is orphaned', () => {
  for (const route of ROUTES) {
    assert.equal(contract.shapeOf[routeKey(route)], route.shape, routeKey(route));
    assert.ok(contract.shapes[route.shape]?.length > 0, `${route.shape} has a field list`);
  }
  const used = new Set([...ROUTES.map(route => route.shape), 'Problem']);
  for (const name of Object.keys(contract.shapes)) assert.ok(used.has(name), `${name} is described but no route returns it`);
});

test('each GET route answers with exactly the field list of its shape', async () => {
  const s = scratch();
  try {
    for (const route of ROUTES.filter(candidate => candidate.method === 'GET')) {
      const answer = await handle({ method: 'GET', url: samplePath(route.path) }, s.ctx);
      assert.equal(answer.status, 200, routeKey(route));
      assert.deepEqual(fieldDiff(contract.shapes[route.shape], shapeFields(route.shape, answer.body)), [], routeKey(route));
    }
  } finally { s.cleanup(); }
});

test('flatten: arrays of objects are unions of item paths, scalar and empty arrays are leaves, open prefixes are one leaf', () => {
  assert.deepEqual(flatten({ a: 1, b: { c: 2 } }), ['a', 'b.c']);
  assert.deepEqual(flatten({ rows: [{ id: 1, tags: ['x'] }, { id: 2, extra: { deep: 1 } }] }), ['rows[].extra.deep', 'rows[].id', 'rows[].tags']);
  assert.deepEqual(flatten({ list: [], names: ['a', 'b'], mixed: [{ a: 1 }, 2] }), ['list', 'mixed', 'names']);
  const open = new Set(['rows[].caps', 'rows[].ident']);
  const doc = { rows: [{ id: 1, caps: { api_level: 34 }, ident: null }, { id: 2, caps: {}, ident: { serial: 'x' } }] };
  assert.deepEqual(flatten(doc, '', open), ['rows[].caps.*', 'rows[].id', 'rows[].ident.*']);
  assert.deepEqual(flatten({ caps: { a: 1 } }, '', new Set(['caps'])), ['caps.*']);
  assert.deepEqual([...openPrefixes(['rows[].id', 'rows[].caps.*', 'x.*'])].sort(), ['rows[].caps', 'x']);
  assert.deepEqual(fieldDiff(['rows[].id', 'rows[].caps.*'], flatten({ rows: [{ id: 1, caps: {} }] }, '', new Set(['rows[].caps']))), []);
  assert.equal(fieldDiff(['rows[].id'], flatten({ rows: [{ id: 1, extra: 2 }] })).length, 1);
});

test('samplePath substitutes route parameters and fails on one it has no sample for', () => {
  assert.equal(samplePath('/resources/{id}'), '/resources/s26');
  assert.equal(samplePath('/health'), '/health');
  assert.throws(() => samplePath('/x/{ghost}'), /no sample for the route parameter \{ghost\}/);
});

test('an error answers with exactly the Problem field list', async () => {
  const s = scratch();
  try {
    const answer = await handle({ method: 'GET', url: '/nope' }, s.ctx);
    assert.equal(answer.status, 404);
    assert.deepEqual(fieldDiff(contract.shapes.Problem, flatten(answer.body)), []);
    const wrongMethod = await handle({ method: 'DELETE', url: '/health' }, s.ctx);
    assert.deepEqual(fieldDiff(contract.shapes.Problem, flatten(wrongMethod.body)), []);
  } finally { s.cleanup(); }
});

test('every key, in the document and in a response, is snake_case', async () => {
  const s = scratch();
  try {
    // `[]` and `*` are notation, not keys.
    const keysOf = path => path.split('.').map(key => key.replace(/\[\]$/, '')).filter(key => key !== '*');
    const keys = new Set(Object.values(contract.shapes).flat().flatMap(keysOf));
    for (const route of ROUTES.filter(candidate => candidate.method === 'GET')) {
      const body = (await handle({ method: 'GET', url: samplePath(route.path) }, s.ctx)).body;
      for (const path of shapeFields(route.shape, body)) for (const key of keysOf(path)) keys.add(key);
    }
    for (const key of keys) assert.match(key, SNAKE, key);
    assert.ok(keys.size > 5);
  } finally { s.cleanup(); }
});

test('the error codes of the document are in the exit table, with the same exit', () => {
  assert.ok(Object.keys(contract.codes).length > 0, 'the table parsed');
  for (const [code, exit] of Object.entries(contract.codes)) assert.equal(EXIT_CODES[code], exit, code);
  for (const code of Object.keys(EXIT_CODES).filter(name => name.startsWith('HUB_API_') || name === 'HUB_NO_ROUTE')) assert.ok(code in contract.codes, `${code} is in the exit table but not in the document`);
});

test('the document gives the base URL and the Holocene proposal', () => {
  const text = readFileSync(DOC, 'utf8');
  assert.match(text, /http:\/\/127\.0\.0\.1:8794/);
  assert.match(text, /`mobile-deploy-hub`/);
  assert.match(text, /MOBILE_DEPLOY_HUB_API_URL/);
});
