// Story 6.8: the same-host Hub API client, hermetic: every fetch is an injected fake and every timeout an injected signal. No port is bound.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadPolicy } from './ci/lib/policy.mjs';
import { hermetic } from './ci/test-fixtures.mjs';
import { CALL_MARGIN_MS, DOWN_MESSAGE, HEALTH_TIMEOUT_MS, HUB_API_SERVICE, RESTARTING_MESSAGE, UNKNOWN_MESSAGE, call, hubUrl, requeueable } from './hub-client.mjs';
import { SERVICE } from './hub-api/routes.mjs';

hermetic();

const policy = loadPolicy().policy;
const json = (status, body, type = 'application/json; charset=utf-8') => new Response(JSON.stringify(body), { status, headers: { 'content-type': type } });
const healthy = () => json(200, { ok: true, service: HUB_API_SERVICE });
const refusedError = () => Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });

// A fetch that answers by URL path, logs every call and honours its signal; `hang` never settles until the signal aborts.
function fake(routes) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const path = new URL(url).pathname;
    calls.push({ url, path, init });
    const answer = routes[path];
    if (answer === 'hang') {
      return new Promise((_, reject) => init.signal?.addEventListener('abort', () => reject(init.signal.reason)));
    }
    const value = typeof answer === 'function' ? answer(init) : answer;
    if (value instanceof Error) throw value;
    return value;
  };
  return { fetchImpl, calls };
}

// An injected `timeout(ms)`: records each bound and returns a signal the test can abort.
function clock() {
  const bounds = [];
  const controllers = [];
  return { bounds, controllers, timeout: ms => { bounds.push(ms); const c = new AbortController(); controllers.push(c); return c.signal; } };
}

const code = async promise => { try { await promise; } catch (error) { return error; } assert.fail('expected a throw'); };

test('the service name is the one the routes answer', () => {
  assert.equal(HUB_API_SERVICE, SERVICE);
  assert.equal(hubUrl(policy), `http://127.0.0.1:${policy.api.hub_api_port}`);
});

test('a refused connect on /health is HUB_API_DOWN with the default message, and nothing else is sent', async () => {
  const { fetchImpl, calls } = fake({ '/health': refusedError() });
  const error = await code(call({ method: 'POST', path: '/registry/resources', body: {} }, { policy, fetchImpl }));
  assert.deepEqual([error.code, error.exit, error.message], ['HUB_API_DOWN', 1, DOWN_MESSAGE]);
  assert.deepEqual(calls.map(entry => entry.path), ['/health']);
});

test('a custom down message is used', async () => {
  const { fetchImpl } = fake({ '/health': refusedError() });
  const error = await code(call({ path: '/x' }, { policy, fetchImpl, down: 'gone' }));
  assert.equal(error.message, 'gone');
});

test('a health that never settles aborts on its timeout: HUB_API_DOWN, the write never sent', async () => {
  const { fetchImpl, calls } = fake({ '/health': 'hang' });
  const c = clock();
  const pending = code(call({ method: 'POST', path: '/registry/resources', body: {} }, { policy, fetchImpl, timeout: c.timeout }));
  await new Promise(done => setImmediate(done));
  c.controllers[0].abort(new Error('timed out'));
  assert.equal((await pending).code, 'HUB_API_DOWN');
  assert.deepEqual(calls.map(entry => entry.path), ['/health']);
});

test('a fetch that ignores its signal is still bounded by it', async () => {
  const c = clock();
  const pending = code(call({ path: '/x' }, { policy, fetchImpl: () => new Promise(() => {}), timeout: c.timeout }));
  await new Promise(done => setImmediate(done));
  c.controllers[0].abort(new Error('timed out'));
  assert.equal((await pending).code, 'HUB_API_DOWN');
});

test('a health that is not a 200, not JSON or not this service is HUB_API_DOWN', async () => {
  for (const [label, answer] of [
    ['non-200', () => json(503, { ok: true, service: HUB_API_SERVICE })],
    ['non-JSON', () => new Response('<html>', { status: 200 })],
    ['wrong service', () => json(200, { ok: true, service: 'something-else' })],
    ['no body object', () => json(200, [])],
  ]) {
    const { fetchImpl, calls } = fake({ '/health': answer });
    const error = await code(call({ method: 'POST', path: '/registry/resources', body: {} }, { policy, fetchImpl }));
    assert.equal(error.code, 'HUB_API_DOWN', label);
    assert.equal(calls.length, 1, label);
  }
});

test('the bound is the wait plus 30 s, and the health bound is 2 s', async () => {
  const { fetchImpl } = fake({ '/health': healthy, '/x': () => json(200, { ok: true }) });
  const c = clock();
  const answer = await call({ method: 'POST', path: '/x', body: {}, waitMs: 5000 }, { policy, fetchImpl, timeout: c.timeout });
  assert.deepEqual(c.bounds, [2000, 35_000]);
  assert.equal(HEALTH_TIMEOUT_MS, 2000);
  assert.equal(CALL_MARGIN_MS, 30_000);
  assert.deepEqual(answer, { status: 200, body: { ok: true } });
  const d = clock();
  await call({ path: '/x' }, { policy, fetchImpl: fake({ '/health': healthy, '/x': () => json(200, {}) }).fetchImpl, timeout: d.timeout, healthTimeoutMs: 500 });
  assert.deepEqual(d.bounds, [500, 30_000]);
});

test('the request is sent as JSON to the policy port; a GET carries no body', async () => {
  const { fetchImpl, calls } = fake({ '/health': healthy, '/x': () => json(201, { made: true }), '/y': () => json(200, { y: 1 }) });
  const made = await call({ method: 'post', path: '/x', body: { a: 1 } }, { policy, fetchImpl });
  assert.equal(made.status, 201);
  const got = await call({ path: '/y' }, { policy, fetchImpl });
  assert.deepEqual(got.body, { y: 1 });
  const [, post, , get] = calls;
  assert.equal(post.url, `http://127.0.0.1:${policy.api.hub_api_port}/x`);
  assert.equal(post.init.method, 'POST');
  assert.equal(post.init.body, '{"a":1}');
  assert.equal(post.init.headers['content-type'], 'application/json');
  assert.equal(get.init.body, undefined);
});

test('a write that times out after a good health is HUB_API_UNKNOWN', async () => {
  const { fetchImpl } = fake({ '/health': healthy, '/registry/resources': 'hang' });
  const c = clock();
  const pending = code(call({ method: 'POST', path: '/registry/resources', body: {} }, { policy, fetchImpl, timeout: c.timeout }));
  await new Promise(done => setImmediate(done));
  await new Promise(done => setImmediate(done));
  c.controllers[1].abort(new Error('timed out'));
  const error = await pending;
  assert.deepEqual([error.code, error.exit, error.message], ['HUB_API_UNKNOWN', 1, UNKNOWN_MESSAGE]);
});

test('a write refused after a good health is HUB_API_DOWN (nothing applied); another failure is UNKNOWN', async () => {
  const refused = await code(call({ method: 'POST', path: '/x', body: {} }, { policy, fetchImpl: fake({ '/health': healthy, '/x': refusedError() }).fetchImpl }));
  assert.equal(refused.code, 'HUB_API_DOWN');
  const direct = await code(call({ method: 'POST', path: '/x', body: {} }, { policy, fetchImpl: fake({ '/health': healthy, '/x': Object.assign(new Error('x'), { code: 'ECONNREFUSED' }) }).fetchImpl }));
  assert.equal(direct.code, 'HUB_API_DOWN');
  const reset = await code(call({ method: 'POST', path: '/x', body: {} }, { policy, fetchImpl: fake({ '/health': healthy, '/x': Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } }) }).fetchImpl }));
  assert.equal(reset.code, 'HUB_API_UNKNOWN');
});

test('a GET that fails is HUB_API_DOWN, never UNKNOWN', async () => {
  const error = await code(call({ path: '/resources' }, { policy, fetchImpl: fake({ '/health': healthy, '/resources': Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } }) }).fetchImpl }));
  assert.equal(error.code, 'HUB_API_DOWN');
});

test('a non-2xx answer that is not a problem is HUB_API_ERROR for a GET and HUB_API_UNKNOWN for a write', async () => {
  const routes = { '/health': healthy, '/x': () => new Response('oops', { status: 502 }) };
  assert.equal((await code(call({ path: '/x' }, { policy, fetchImpl: fake(routes).fetchImpl }))).code, 'HUB_API_ERROR');
  assert.equal((await code(call({ method: 'POST', path: '/x', body: {} }, { policy, fetchImpl: fake(routes).fetchImpl }))).code, 'HUB_API_UNKNOWN');
  const plain = { '/health': healthy, '/x': () => json(409, { code: 'X', detail: 'no' }) };
  assert.equal((await code(call({ path: '/x' }, { policy, fetchImpl: fake(plain).fetchImpl }))).code, 'HUB_API_ERROR', 'application/json is not a problem');
});

test('a problem+json answer becomes an error with the problem, its extensions and api: true', async () => {
  const body = { type: 'urn:x', title: 'Conflict', status: 409, detail: 'the Registry is at rev 7', code: 'HUB_REGISTRY_CONFLICT', exit: 1, reason: 'hub_registry_conflict', rev: 7, holder: 'res-a' };
  const { fetchImpl } = fake({ '/health': healthy, '/x': () => json(409, body, 'application/problem+json') });
  const error = await code(call({ method: 'POST', path: '/x', body: {} }, { policy, fetchImpl }));
  assert.deepEqual([error.code, error.status, error.exit, error.reason, error.message, error.rev, error.holder, error.api], ['HUB_REGISTRY_CONFLICT', 409, 1, 'hub_registry_conflict', 'the Registry is at rev 7', 7, 'res-a', true]);
  assert.deepEqual(error.problem, body);
});

test('a 2xx write answer that is not JSON is HUB_API_UNKNOWN', async () => {
  const { fetchImpl } = fake({ '/health': healthy, '/x': () => new Response('ok', { status: 200 }) });
  assert.equal((await code(call({ method: 'POST', path: '/x', body: {} }, { policy, fetchImpl }))).code, 'HUB_API_UNKNOWN');
});

test('the default fetch is the global one, read at call time (hermetic() makes it throw: DOWN, not a leak)', async () => {
  const error = await code(call({ path: '/x' }, { policy }));
  assert.equal(error.code, 'HUB_API_DOWN');
});

test('a custom unknown message is used wherever UNKNOWN is thrown; the default names the registry', async () => {
  const routes = { '/health': healthy, '/reset': Object.assign(new TypeError('x'), { cause: { code: 'ECONNRESET' } }), '/bad': () => new Response('oops', { status: 502 }), '/text': () => new Response('ok', { status: 200 }) };
  for (const path of ['/reset', '/bad', '/text']) {
    const custom = await code(call({ method: 'POST', path, body: {} }, { policy, fetchImpl: fake(routes).fetchImpl, unknown: 'my words' }));
    assert.deepEqual([custom.code, custom.message], ['HUB_API_UNKNOWN', 'my words'], path);
    assert.equal((await code(call({ method: 'POST', path, body: {} }, { policy, fetchImpl: fake(routes).fetchImpl }))).message, UNKNOWN_MESSAGE, path);
  }
});

test('problem members named like an Error field never overwrite it', async () => {
  const body = { status: 409, detail: 'real', code: 'X', exit: 2, reason: 'r', message: 'evil', name: 'Evil', stack: 's', cause: 'c', rev: 3 };
  const { fetchImpl } = fake({ '/health': healthy, '/x': () => json(409, body, 'application/problem+json') });
  const error = await code(call({ method: 'POST', path: '/x', body: {} }, { policy, fetchImpl }));
  assert.deepEqual([error.message, error.name, error.cause, error.rev], ['real', 'Error', undefined, 3]);
  assert.notEqual(error.stack, 's');
});

// Story 8.6: a reset during a wait is a requeue for every waiting caller.
const resetOf = code => Object.assign(new TypeError('fetch failed'), { cause: { code } });

test('a reset during a wait is HUB_API_RESTARTING with retry requeue and api false; `requeueable` is true for it', async () => {
  for (const make of [() => resetOf('ECONNRESET'), () => resetOf('UND_ERR_SOCKET'), () => resetOf('EPIPE'), () => resetOf('UND_ERR_CLOSED'), () => Object.assign(new Error('x'), { code: 'ECONNRESET' })]) {
    const error = await code(call({ method: 'POST', path: '/leases', body: {}, waitMs: 30_000 }, { policy, fetchImpl: fake({ '/health': healthy, '/leases': make() }).fetchImpl }));
    assert.deepEqual([error.code, error.exit, error.reason, error.retry, error.api, error.message], ['HUB_API_RESTARTING', 1, 'restarting', 'requeue', false, RESTARTING_MESSAGE]);
    assert.equal(requeueable(error), true);
  }
});

test('the other failures of a wait keep their codes: its own timeout is UNKNOWN, a refused connect is DOWN, and a reset with no wait is UNKNOWN', async () => {
  const c = clock();
  const { fetchImpl } = fake({ '/health': healthy, '/leases': 'hang' });
  const pending = code(call({ method: 'POST', path: '/leases', body: {}, waitMs: 30_000 }, { policy, fetchImpl, timeout: c.timeout }));
  await new Promise(done => setImmediate(done));
  await new Promise(done => setImmediate(done));
  c.controllers[1].abort(new Error('timed out'));
  const timed = await pending;
  assert.equal(timed.code, 'HUB_API_UNKNOWN');
  assert.equal(requeueable(timed), false);
  const aborted = await code(call({ method: 'POST', path: '/leases', body: {}, waitMs: 30_000 }, { policy, fetchImpl: fake({ '/health': healthy, '/leases': new DOMException('timed out', 'TimeoutError') }).fetchImpl }));
  assert.equal(aborted.code, 'HUB_API_UNKNOWN');
  const refused = await code(call({ method: 'POST', path: '/leases', body: {}, waitMs: 30_000 }, { policy, fetchImpl: fake({ '/health': healthy, '/leases': refusedError() }).fetchImpl }));
  assert.equal(refused.code, 'HUB_API_DOWN');
  const write = await code(call({ method: 'POST', path: '/leases', body: {} }, { policy, fetchImpl: fake({ '/health': healthy, '/leases': resetOf('ECONNRESET') }).fetchImpl }));
  assert.equal(write.code, 'HUB_API_UNKNOWN');
  assert.equal(requeueable(write), false);
});

test('requeueable is true for a problem error that says requeue (a SIGTERM answer) and false for everything else', async () => {
  const body = { type: 'urn:x', title: 'Restarting', status: 503, detail: 'the service is stopping', code: 'HUB_API_RESTARTING', exit: 1, reason: 'restarting', retry: 'requeue' };
  const { fetchImpl } = fake({ '/health': healthy, '/leases': () => json(503, body, 'application/problem+json') });
  const error = await code(call({ method: 'POST', path: '/leases', body: {}, waitMs: 1000 }, { policy, fetchImpl }));
  assert.deepEqual([error.code, error.api, error.retry, requeueable(error)], ['HUB_API_RESTARTING', true, 'requeue', true]);
  for (const other of [undefined, null, new Error('x'), { retry: 'later' }]) assert.equal(requeueable(other), false);
});
