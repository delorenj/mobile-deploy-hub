// Story 6.8: the same-host Hub API client, hermetic: every fetch is an injected fake and every timeout an injected signal. No port is bound.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { loadDevices } from './ci/lib/devices.mjs';
import { readEvents } from './ci/lib/events.mjs';
import { acquireLease } from './ci/lib/lock.mjs';
import { loadPolicy } from './ci/lib/policy.mjs';
import { hermetic } from './ci/test-fixtures.mjs';
import {
  CALL_MARGIN_MS, DOWN_MESSAGE, HEALTH_TIMEOUT_MS, HUB_API_SERVICE, PEER_NODE, PEER_SCRIPT, RESTARTING_MESSAGE, UNKNOWN_MESSAGE,
  aliasFor, boundMs, call, frontDoorPort, hubUrl, main, quoteWord, relay, remoteCommand, request, requeueable, sshArgv,
} from './hub-client.mjs';
import { createLeaseWaits } from './device/claims.mjs';
import { ROUTES, SERVICE } from './hub-api/routes.mjs';
import { requestListener } from './hub-api/server.mjs';

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

// ---- Story 9.1: cross-host calls go through one client ----

const devices = loadDevices({});
const flush = async (rounds = 6) => { for (let round = 0; round < rounds; round += 1) await new Promise(done => setImmediate(done)); };
const MIN = 60_000;

// Timers the test fires by hand: each set is recorded, nothing ever runs by itself.
function fakeTimers() {
  const t = { intervals: [], timeouts: [], cleared: [] };
  t.setInterval = (fn, ms) => { const handle = { fn, ms }; t.intervals.push(handle); return handle; };
  t.clearInterval = handle => { t.cleared.push(handle); };
  t.setTimeout = (fn, ms) => { const handle = { fn, ms, refreshed: 0, refresh() { this.refreshed += 1; return this; } }; t.timeouts.push(handle); return handle; };
  t.clearTimeout = handle => { t.cleared.push(handle); };
  return t;
}

// A fake ssh child: `stdinText` is what the client wrote, `answer(text, code)` is the relay's whole stdout and the exit.
function sshChild() {
  const child = new EventEmitter();
  Object.assign(child, { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), killed: false, stdinText: '', stdinEnded: false });
  child.kill = () => { child.killed = true; };
  child.stdin.on('data', chunk => { child.stdinText += chunk; });
  child.stdin.on('end', () => { child.stdinEnded = true; });
  child.answer = (text, code = 0) => { child.stdout.once('end', () => child.emit('close', code)); child.stdout.end(text); };
  return child;
}

// The words of a command made by `remoteCommand`, read back.
const wordsOf = command => [...command.matchAll(/'((?:[^']|'\\'')*)'/g)].map(match => match[1].replaceAll("'\\''", "'"));

// An ssh seam that runs the relay in-process, as the peer would: stdin and stdout are the pipes to the client.
function relaying({ key, fetchImpl, timers, policy: used = policy }) {
  const spawned = [];
  const relays = [];
  const sshImpl = argv => {
    spawned.push(argv);
    const child = sshChild();
    const [, , , method, path] = wordsOf(argv.at(-1));
    const done = relay({ method, path, stdin: child.stdin, stdout: child.stdout, policy: used, hostKey: () => key, fetchImpl, timers });
    relays.push(done);
    done.then(code => { child.stdout.once('end', () => child.emit('close', code)); child.stdout.end(); });
    return child;
  };
  return { sshImpl, spawned, relays };
}

// A `fetch` backed by the Hub API's own request listener, on a fake request and response (waits.test.mjs): an abort is a client that went away.
function listenerFetch(listener, seen = []) {
  return (url, init = {}) => new Promise((resolve, reject) => {
    const target = new URL(url);
    seen.push({ url, init });
    const req = { method: init.method, url: `${target.pathname}${target.search}`, headers: {}, async *[Symbol.asyncIterator]() { if (init.body !== undefined) yield Buffer.from(init.body); } };
    const res = Object.assign(new EventEmitter(), {
      writableFinished: false,
      writeHead(status, headers) { this.head = { status, headers }; },
      end(text) {
        this.writableFinished = true;
        resolve(new Response(text, { status: this.head.status, headers: Object.fromEntries(Object.entries(this.head.headers).map(([name, value]) => [name, String(value)])) }));
        this.emit('close');
      },
    });
    init.signal?.addEventListener('abort', () => { res.emit('close'); reject(init.signal.reason); }, { once: true });
    listener(req, res).catch(reject);
  });
}

// A temp lock and event dir and the context the listener needs; `hold` is somebody else's Hold on a lock.
function scratch() {
  const root = mkdtempSync(join(tmpdir(), 'hub-client-relay-'));
  const env = { PATH: process.env.PATH, HOME: root, HUB_LOCK_DIR: join(root, 'locks'), HUB_EVENT_DIR: join(root, 'events') };
  let at = Date.parse('2026-11-26T10:00:00Z');
  const waits = createLeaseWaits({ now: () => at });
  const ctx = {
    env, policy, routes: ROUTES, now: () => at, sleep: () => new Promise(() => {}), hostId: 'test-host', devices: structuredClone(devices), qaDevices: () => [], waits,
    log: { out: () => {}, err: () => {} },
  };
  return {
    ctx, env, waits,
    events: () => [...readEvents({ env })].filter(event => event.claimant !== undefined),
    hold: lock => acquireLease(lock, { holder: `holder-${lock}`, why: 'blocking', forMs: 50 * MIN, id: `holder-${lock}`, env, log: () => {}, now: () => at }),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

const WAIT_BODY = { resource: 's24', for_ms: 30 * MIN, holder: 'agent-a', why: 'proof', id: 'w-1', wait_ms: 60_000 };

test('the ssh argv is exactly the AD-26 option set, the alias, then the command', () => {
  assert.deepEqual(sshArgv('hub-mac', 'CMD', policy), [
    '-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', '-o', 'ControlMaster=no', '-o', 'ControlPath=none', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=2', 'hub-mac', 'CMD',
  ]);
  assert.equal(policy.api.peer_connect_timeout_s, 5);
  assert.equal(aliasFor('mac', devices), 'hub-mac');
  assert.equal(aliasFor('linux', devices), 'big-chungus');
  assert.equal(aliasFor('linux', devices), devices.linux.host);
  assert.throws(() => aliasFor('ipad', devices), /not a host key/);
  assert.throws(() => aliasFor('mac', { mac: { host: 'a b; rm' } }), /not a host name/);
  assert.throws(() => aliasFor('mac', {}), /not a host name/);
  assert.equal(frontDoorPort(policy, 'linux'), policy.api.hub_api_port);
  assert.equal(frontDoorPort(policy, 'mac'), policy.api.host_agent_port);
  assert.throws(() => frontDoorPort(policy, 'other'), /not a host key/);
  assert.equal(boundMs({}), CALL_MARGIN_MS);
  assert.equal(boundMs({ waitMs: 5000, budgetMs: 7000 }), 42_000);
});

test('the remote command is single-quoted words: the fixed node, the fixed script, relay, the method and the path', () => {
  assert.equal(PEER_NODE, '.local/share/mise/installs/node/24/bin/node');
  assert.equal(PEER_SCRIPT, '.local/share/mobile-deploy-hub/current/tools/hub-client.mjs');
  assert.equal(remoteCommand({ method: 'post', path: '/leases' }), `'${PEER_NODE}' '${PEER_SCRIPT}' 'relay' 'POST' '/leases'`);
  assert.equal(quoteWord("a'b"), "'a'\\''b'");
});

test('a path with quotes and shell characters reaches the peer as one intact word, through sh -c and zsh -c', () => {
  const path = "/x?a=1&b='c'";
  const command = remoteCommand({ method: 'POST', path }, { node: 'printf', script: '%s\\n' });
  const shells = ['sh', ...(spawnSync('zsh', ['-c', 'true']).status === 0 ? ['zsh'] : [])];
  for (const shell of shells) {
    const out = spawnSync(shell, ['-c', command], { encoding: 'utf8' });
    assert.equal(out.status, 0, shell);
    assert.deepEqual(out.stdout.split('\n').slice(0, -1), ['relay', 'POST', path], shell);
  }
  const evil = "/$(touch pwned);`id`;'\"\\";
  assert.deepEqual(wordsOf(remoteCommand({ method: 'GET', path: evil })).slice(-1), [evil]);
  const echoed = spawnSync('sh', ['-c', remoteCommand({ method: 'GET', path: evil }, { node: 'printf', script: '%s\\n' })], { encoding: 'utf8' });
  assert.deepEqual(echoed.stdout.split('\n').slice(0, -1), ['relay', 'GET', evil]);
});

test('a same-host call is a fetch to the host\'s own front door on loopback, bounded, with no ssh', async () => {
  const bounds = [];
  const timeout = ms => { bounds.push(ms); return new AbortController().signal; };
  for (const [key, port] of [['linux', policy.api.hub_api_port], ['mac', policy.api.host_agent_port]]) {
    const { fetchImpl, calls } = fake({ '/leases': () => json(200, { ok: key }) });
    const sshImpl = () => assert.fail('no ssh for the same host');
    const response = await request({ host: key, method: 'post', path: '/leases?a=1', body: { x: 1 }, waitMs: 5000, budgetMs: 1000 }, { policy, hostKey: () => key, fetchImpl, sshImpl, devices, timeout });
    assert.deepEqual(await response.json(), { ok: key });
    assert.equal(calls[0].url, `http://127.0.0.1:${port}/leases?a=1`);
    assert.deepEqual([calls[0].init.method, calls[0].init.body, calls[0].init.headers['content-type']], ['POST', '{"x":1}', 'application/json']);
    assert.ok(calls[0].init.signal instanceof AbortSignal);
  }
  assert.deepEqual(bounds, [36_000, 36_000]);
  const get = fake({ '/health': () => json(200, {}) });
  await request({ host: 'linux', path: '/health' }, { policy, hostKey: () => 'linux', fetchImpl: get.fetchImpl });
  assert.equal(get.calls[0].init.body, undefined);
  assert.equal(get.calls[0].init.method, 'GET');
});

test('a same-host failure is the fetch error, unchanged; a fetch that ignores its signal is still bounded', async () => {
  const boom = refusedError();
  assert.equal(await code(request({ host: 'linux', path: '/x' }, { policy, hostKey: () => 'linux', fetchImpl: async () => { throw boom; } })), boom);
  const controller = new AbortController();
  const pending = code(request({ host: 'linux', path: '/x' }, { policy, hostKey: () => 'linux', fetchImpl: () => new Promise(() => {}), timeout: () => controller.signal }));
  await flush(2);
  controller.abort(new Error('timed out'));
  assert.equal((await pending).message, 'timed out');
});

test('request refuses a host that is neither linux nor mac, and an unreadable alias', async () => {
  assert.equal((await code(request({ host: 'ipad', path: '/x' }, { policy, hostKey: () => 'linux' }))).code, 'HUB_USAGE');
  const error = await code(request({ host: 'mac', path: '/x' }, { policy, hostKey: () => 'linux', devices: { mac: { host: 'bad alias' } }, sshImpl: () => assert.fail('never spawned') }));
  assert.equal(error.code, 'HUB_USAGE');
});

test('a peer call: one ssh spawn with the exact argv, the body line, then a heartbeat per interval, and a Response from the relay\'s head and body', async () => {
  const spawned = [];
  const child = sshChild();
  const t = fakeTimers();
  const pending = request({ host: 'mac', method: 'POST', path: '/leases', body: { a: 1 }, waitMs: 5000, budgetMs: 1000 }, {
    policy, hostKey: () => 'linux', devices, timers: t, sshImpl: argv => { spawned.push(argv); return child; },
    fetchImpl: () => assert.fail('a peer call never fetches'),
  });
  await flush();
  assert.equal(spawned.length, 1);
  assert.deepEqual(spawned[0], sshArgv('hub-mac', remoteCommand({ method: 'POST', path: '/leases' }), policy));
  assert.deepEqual([t.intervals.length, t.intervals[0].ms, t.timeouts.length, t.timeouts[0].ms], [1, 15_000, 1, 36_000 + 10_000]);
  assert.equal(child.stdinText, '{"a":1}\n');
  for (let beat = 0; beat < 3; beat += 1) t.intervals[0].fn();
  await flush();
  assert.equal(child.stdinText, '{"a":1}\n\n\n\n', 'one newline per interval after the body line');
  const head = { format: 1, status: 201, headers: { 'content-type': 'application/json; charset=utf-8', 'x-request-id': 'w-1' } };
  child.answer(`${JSON.stringify(head)}\n{"made":true}`);
  const response = await pending;
  assert.deepEqual([response.status, response.headers.get('x-request-id'), response.headers.get('content-type')], [201, 'w-1', 'application/json; charset=utf-8']);
  assert.equal(await response.text(), '{"made":true}');
  assert.ok(t.cleared.includes(t.intervals[0]) && t.cleared.includes(t.timeouts[0]), 'the heartbeat and the bound kill are cleared with the call');
  assert.equal(child.stdinEnded, true);
  assert.equal(child.killed, false);
});

test('a call with no body writes an empty first line; a 204 has a null body', async () => {
  const child = sshChild();
  const pending = request({ host: 'mac', path: '/x' }, { policy, hostKey: () => 'linux', devices, timers: fakeTimers(), sshImpl: () => child });
  await flush();
  assert.equal(child.stdinText, '\n');
  child.answer('{"format":1,"status":204,"headers":{}}\n');
  const response = await pending;
  assert.deepEqual([response.status, response.body], [204, null]);
});

test('both transports give one route the same status, body, X-Request-Id and content type', async () => {
  const s = scratch();
  try {
    const listener = requestListener(s.ctx);
    const direct = listenerFetch(listener);
    const t = fakeTimers();
    const { sshImpl, spawned, relays } = relaying({ key: 'linux', fetchImpl: listenerFetch(listener), timers: t });
    for (const input of [
      { method: 'GET', path: '/health' },
      { method: 'POST', path: '/leases', body: { ...WAIT_BODY, id: 'w-9', wait_ms: -5 } },
      { method: 'GET', path: '/no-such-route' },
    ]) {
      const same = await request({ host: 'linux', ...input }, { policy, hostKey: () => 'linux', fetchImpl: direct, sshImpl: () => assert.fail('no ssh') });
      const over = await request({ host: 'linux', ...input }, { policy, hostKey: () => 'mac', devices, sshImpl, timers: t });
      assert.equal(over.status, same.status, input.path);
      assert.equal(await over.text(), await same.text(), input.path);
      for (const name of ['x-request-id', 'content-type', 'cache-control']) assert.equal(over.headers.get(name), same.headers.get(name), `${input.path} ${name}`);
    }
    assert.equal(spawned.length, 3);
    await Promise.all(relays);
    const bad = await request({ host: 'linux', method: 'POST', path: '/leases', body: { ...WAIT_BODY, id: 'w-9', wait_ms: -5 } }, { policy, hostKey: () => 'mac', devices, sshImpl, timers: t });
    assert.deepEqual([bad.status, bad.headers.get('x-request-id'), bad.headers.get('content-type')], [400, 'w-9', 'application/problem+json']);
  } finally { s.cleanup(); }
});

test('the relay calls its own key\'s front door: the Mac\'s relay calls the Host Agent port', async () => {
  const urls = [];
  const fetchImpl = async url => { urls.push(url); return json(200, { ok: true }); };
  const { sshImpl, relays } = relaying({ key: 'mac', fetchImpl, timers: fakeTimers() });
  const response = await request({ host: 'mac', path: '/health' }, { policy, hostKey: () => 'linux', devices, sshImpl, timers: fakeTimers() });
  assert.equal(response.status, 200);
  await Promise.all(relays);
  assert.deepEqual(urls, [`http://127.0.0.1:${policy.api.host_agent_port}/health`]);
});

test('a peer service that refuses: the client rejects like a refused fetch, with cause.code ECONNREFUSED', async () => {
  const { sshImpl } = relaying({ key: 'mac', fetchImpl: async () => { throw refusedError(); }, timers: fakeTimers() });
  const error = await code(request({ host: 'mac', method: 'POST', path: '/leases', body: {} }, { policy, hostKey: () => 'linux', devices, sshImpl, timers: fakeTimers() }));
  assert.ok(error instanceof TypeError);
  assert.deepEqual([error.message, error.cause.code], ['fetch failed', 'ECONNREFUSED']);
  // A caller classifies it as it does a same-host failure.
  const reset = await code(request({ host: 'mac', path: '/x' }, { policy, hostKey: () => 'linux', devices, timers: fakeTimers(), ...relaying({ key: 'mac', fetchImpl: async () => { throw resetOf('ECONNRESET'); }, timers: fakeTimers() }) }));
  assert.equal(reset.cause.code, 'ECONNRESET');
});

const awayOf = async (seams, input = { host: 'mac', path: '/x' }) => code(request(input, { policy, hostKey: () => 'linux', devices, timers: fakeTimers(), ...seams }));

test('ssh that cannot connect is HUB_DEVICE_AWAY (exit 75, host-unreachable, api false) naming the host, the alias and the connect timeout', async () => {
  const child = sshChild();
  const pending = awayOf({ sshImpl: () => child });
  await flush();
  child.stderr.write('ssh: connect to host hub-mac port 22: Operation timed out\n');
  await flush();
  child.answer('', 255);
  const error = await pending;
  assert.deepEqual([error.code, error.exit, error.reason, error.api], ['HUB_DEVICE_AWAY', 75, 'host-unreachable', false]);
  assert.match(error.message, /mac host/);
  assert.match(error.message, /hub-mac/);
  assert.match(error.message, /connect timeout 5 s/);
  assert.match(error.message, /Operation timed out/);
  assert.equal(requeueable(error), false);
});

test('ssh that does not start, a head that does not parse, an exit with no head and a spawn that throws are all the same AWAY', async () => {
  const failed = sshChild();
  const spawnError = awayOf({ sshImpl: () => failed });
  await flush();
  failed.emit('error', Object.assign(new Error('spawn ssh ENOENT'), { code: 'ENOENT' }));
  const cases = {
    'spawn error': await spawnError,
    'unparsable head': await (async () => { const c = sshChild(); const p = awayOf({ sshImpl: () => c }); await flush(); c.answer('not json\nbody'); return p; })(),
    'no newline': await (async () => { const c = sshChild(); const p = awayOf({ sshImpl: () => c }); await flush(); c.answer('{"format":1,"status":200,"headers":{}}'); return p; })(),
    'wrong format': await (async () => { const c = sshChild(); const p = awayOf({ sshImpl: () => c }); await flush(); c.answer('{"format":2,"status":200,"headers":{}}\n'); return p; })(),
    'bad status': await (async () => { const c = sshChild(); const p = awayOf({ sshImpl: () => c }); await flush(); c.answer('{"format":1,"status":99,"headers":{}}\n'); return p; })(),
    'remote exit with no head': await (async () => { const c = sshChild(); const p = awayOf({ sshImpl: () => c }); await flush(); c.answer('', 127); return p; })(),
    'a head but a failing exit': await (async () => { const c = sshChild(); const p = awayOf({ sshImpl: () => c }); await flush(); c.answer('{"format":1,"status":200,"headers":{}}\nx', 1); return p; })(),
    'ssh killed by a signal': await (async () => { const c = sshChild(); const p = awayOf({ sshImpl: () => c }); await flush(); c.answer('', null); return p; })(),
    'sshImpl throws': await awayOf({ sshImpl: () => { throw new Error('boom'); } }),
  };
  for (const [label, error] of Object.entries(cases)) assert.deepEqual([error.code, error.exit, error.reason, error.api], ['HUB_DEVICE_AWAY', 75, 'host-unreachable', false], label);
});

test('the bound plus 10 s kills ssh: AWAY, and the heartbeat is cleared', async () => {
  const child = sshChild();
  const t = fakeTimers();
  const pending = code(request({ host: 'mac', method: 'POST', path: '/leases', body: {}, waitMs: 60_000 }, { policy, hostKey: () => 'linux', devices, timers: t, sshImpl: () => child }));
  await flush();
  assert.equal(t.timeouts[0].ms, 60_000 + CALL_MARGIN_MS + 10_000);
  assert.equal(child.killed, false);
  t.timeouts[0].fn();
  const error = await pending;
  assert.equal(child.killed, true);
  assert.deepEqual([error.code, error.exit, error.reason], ['HUB_DEVICE_AWAY', 75, 'host-unreachable']);
  assert.ok(t.cleared.includes(t.intervals[0]), 'heartbeat cleared');
  await flush();
  assert.equal(child.stdinEnded, true);
  child.answer('{"format":1,"status":200,"headers":{}}\n');
  await flush();
});

test('a relay error head with a usage code is a TypeError with that cause code, and no timer is left running', async () => {
  const child = sshChild();
  const t = fakeTimers();
  const pending = code(request({ host: 'mac', path: '/x' }, { policy, hostKey: () => 'linux', devices, timers: t, sshImpl: () => child }));
  await flush();
  child.answer('{"format":1,"error":{"code":"HUB_RELAY_USAGE","message":"x"}}\n', 2);
  const error = await pending;
  assert.equal(error.cause.code, 'HUB_RELAY_USAGE');
  assert.ok(t.cleared.includes(t.intervals[0]) && t.cleared.includes(t.timeouts[0]));
});

test('a client that vanishes mid-wait (stdin EOF) aborts the relay\'s request: the service records cancel (aborted) and nothing is written', async () => {
  const s = scratch();
  try {
    await s.hold('s24');
    const seen = [];
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const out = [];
    stdout.on('data', chunk => out.push(chunk));
    const exit = relay({ method: 'POST', path: '/leases', stdin, stdout, policy, hostKey: () => 'linux', fetchImpl: listenerFetch(requestListener(s.ctx), seen), timers: fakeTimers() });
    stdin.write(`${JSON.stringify(WAIT_BODY)}\n`);
    await flush();
    assert.equal(s.events().filter(event => event.lease_id === 'w-1').length, 1, 'the wait is open: one request event');
    stdin.end();
    assert.equal(await exit, 1);
    await flush();
    assert.deepEqual(s.events().filter(event => event.lease_id === 'w-1').map(event => [event.event, event.reason]), [['request', null], ['cancel', 'aborted']]);
    assert.deepEqual(out, [], 'nothing was written');
    assert.equal(seen[0].init.signal.aborted, true);
  } finally { s.cleanup(); }
});

test('3 intervals with no byte abort it too, and any byte re-arms the one idle timer', async () => {
  const s = scratch();
  try {
    await s.hold('s24');
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const out = [];
    stdout.on('data', chunk => out.push(chunk));
    const t = fakeTimers();
    const exit = relay({ method: 'POST', path: '/leases', stdin, stdout, policy, hostKey: () => 'linux', fetchImpl: listenerFetch(requestListener(s.ctx)), timers: t });
    await flush();
    assert.equal(t.timeouts.length, 1);
    assert.equal(t.timeouts[0].ms, 3 * policy.api.stream_keepalive_s * 1000);
    stdin.write(`${JSON.stringify(WAIT_BODY)}\n`);
    await flush();
    stdin.write('\n');
    stdin.write('\n');
    await flush();
    assert.equal(t.timeouts.length, 1, 'a byte re-arms the same timer, never a second one');
    assert.equal(t.timeouts[0].refreshed, 3, 'the body line and both heartbeats');
    t.timeouts[0].fn();
    assert.equal(await exit, 1);
    await flush();
    assert.deepEqual(s.events().filter(event => event.lease_id === 'w-1').map(event => [event.event, event.reason]), [['request', null], ['cancel', 'aborted']]);
    assert.deepEqual(out, []);
    assert.ok(t.cleared.includes(t.timeouts[0]));
  } finally { s.cleanup(); }
});

test('an end-to-end vanish: the client\'s ssh dying ends the relay\'s stdin and the far service records cancel', async () => {
  const s = scratch();
  try {
    await s.hold('s24');
    const t = fakeTimers();
    const { sshImpl, relays, spawned } = relaying({ key: 'linux', fetchImpl: listenerFetch(requestListener(s.ctx)), timers: fakeTimers() });
    const pending = code(request({ host: 'linux', method: 'POST', path: '/leases', body: WAIT_BODY, waitMs: 60_000 }, { policy, hostKey: () => 'mac', devices, sshImpl, timers: t }));
    await flush();
    assert.equal(spawned.length, 1);
    t.timeouts[0].fn();
    const error = await pending;
    assert.equal(error.code, 'HUB_DEVICE_AWAY');
    assert.equal(await relays[0], 1);
    assert.deepEqual(s.events().filter(event => event.lease_id === 'w-1').map(event => [event.event, event.reason]), [['request', null], ['cancel', 'aborted']]);
  } finally { s.cleanup(); }
});

test('relay usage errors: a bad method, a bad path or a body that is not JSON is an error head with HUB_RELAY_USAGE, exit 2, and no request', async () => {
  const cases = [
    ['TRACE', '/x', '\n'], ['get', '/x', '\n'], [undefined, '/x', '\n'], ['GET', 'x', '\n'], ['GET', undefined, '\n'], ['GET', '', '\n'],
    ['GET', '/a b', '\n'], ['GET', '/a\tb', '\n'], ['GET', '/a\nb', '\n'], ['GET', '/a\u0000b', '\n'], ['GET', '/a\u007fb', '\n'],
    ['POST', '/x', 'not json\n'], ['GET', '/x', '{}\n'],
  ];
  for (const [method, path, first] of cases) {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const out = [];
    stdout.on('data', chunk => out.push(chunk));
    const fetchImpl = () => assert.fail('no request is made');
    const exit = relay({ method, path, stdin, stdout, policy, hostKey: () => 'linux', fetchImpl, timers: fakeTimers() });
    stdin.write(first);
    assert.equal(await exit, 2, `${method} ${JSON.stringify(path)}`);
    await flush(2);
    const head = JSON.parse(Buffer.concat(out).toString().split('\n')[0]);
    assert.deepEqual([head.format, head.error.code], [1, 'HUB_RELAY_USAGE'], `${method} ${JSON.stringify(path)}`);
  }
});

test('the relay with no key for this host answers an error head and makes no request', async () => {
  const stdout = new PassThrough();
  const out = [];
  stdout.on('data', chunk => out.push(chunk));
  const exit = await relay({ method: 'GET', path: '/x', stdin: new PassThrough(), stdout, policy, hostKey: () => { throw Object.assign(new Error('this host does not know which host it is'), { code: 'HUB_HOST_UNKNOWN' }); }, fetchImpl: () => assert.fail('no request'), timers: fakeTimers() });
  assert.equal(exit, 1);
  await flush(2);
  assert.equal(JSON.parse(Buffer.concat(out).toString()).error.code, 'HUB_HOST_UNKNOWN');
});

test('main relay GET /health: stdout is the JSON head with status 200, then exactly the health body, and the fetch went to this key\'s front door', async () => {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const out = [];
  stdout.on('data', chunk => out.push(chunk));
  const body = `{"ok":true,"service":"${HUB_API_SERVICE}","note":"caf\u00e9 \u2713"}`;
  const { fetchImpl, calls } = fake({ '/health': () => new Response(body, { status: 200, headers: { 'content-type': 'application/json; charset=utf-8' } }) });
  stdin.write('\n');
  const exit = await main(['relay', 'GET', '/health'], { stdin, stdout, hostKey: () => 'mac', fetchImpl, policy, timers: fakeTimers() });
  assert.equal(exit, 0);
  const all = Buffer.concat(out);
  const newline = all.indexOf(10);
  const head = JSON.parse(all.subarray(0, newline).toString());
  assert.deepEqual([head.format, head.status, head.headers['content-type']], [1, 200, 'application/json; charset=utf-8']);
  assert.equal(all.subarray(newline + 1).toString('utf8'), body);
  assert.equal(calls[0].url, `http://127.0.0.1:${policy.api.host_agent_port}/health`);
  assert.equal(calls[0].init.body, undefined);
});

test('main with no relay, or bad arguments, prints the usage on stderr and is 2; the CLI does the same', async () => {
  for (const argv of [[], ['relay'], ['relay', 'GET'], ['status', 'GET', '/x'], ['relay', 'GET', '/x', 'extra']]) {
    const stderr = new PassThrough();
    let text = '';
    stderr.on('data', chunk => { text += chunk; });
    assert.equal(await main(argv, { stdin: new PassThrough(), stdout: new PassThrough(), stderr, fetchImpl: () => assert.fail('no request') }), 2, argv.join(' '));
    await flush(2);
    assert.match(text, /^usage: hub-client\.mjs relay/);
  }
  const script = fileURLToPath(new URL('./hub-client.mjs', import.meta.url));
  const run = spawnSync(process.execPath, [script], { encoding: 'utf8', input: '' });
  assert.equal(run.status, 2);
  assert.match(run.stderr, /usage: hub-client\.mjs relay/);
  const bad = spawnSync(process.execPath, [script, 'relay', 'TRACE', '/x'], { encoding: 'utf8', input: '\n' });
  assert.equal(bad.status, 2);
  assert.equal(JSON.parse(bad.stdout).error.code, 'HUB_RELAY_USAGE');
});

test('the relay\'s answer is byte-exact for a binary body and drops only hop headers; a 204 has no body bytes', async () => {
  const bytes = Buffer.from([0, 255, 10, 13, 128, 10]);
  const out = [];
  const stdout = new PassThrough();
  stdout.on('data', chunk => out.push(chunk));
  const stdin = new PassThrough();
  stdin.write('\n');
  await relay({ method: 'GET', path: '/x', stdin, stdout, policy, hostKey: () => 'linux', timers: fakeTimers(), fetchImpl: async () => new Response(bytes, { status: 200, headers: { 'content-type': 'application/octet-stream', 'x-keep': '1' } }) });
  const all = Buffer.concat(out);
  const newline = all.indexOf(10);
  const head = JSON.parse(all.subarray(0, newline).toString());
  assert.deepEqual(head.headers, { 'content-type': 'application/octet-stream', 'x-keep': '1' });
  assert.deepEqual(all.subarray(newline + 1), bytes);
});
