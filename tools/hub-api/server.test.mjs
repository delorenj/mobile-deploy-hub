// Story 6.4: the Hub API's start sequence, singleton, /health, error envelope and request adapter, hermetic: a fake server (no real
// port is bound), injected Node version and PATH check, a temp lock and event dir per test, an injected QA loader and a signals emitter.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDevices } from '../ci/lib/devices.mjs';
import { readEvents } from '../ci/lib/events.mjs';
import { loadPolicy } from '../ci/lib/policy.mjs';
import { writeFileAtomic } from '../ci/lib/lock.mjs';
import { hermetic } from '../ci/test-fixtures.mjs';
import { applySeed, registryPath } from '../registry/store.mjs';
import { CONTRACT_VERSION, ROUTES, SERVICE, handle } from './routes.mjs';
import { MAX_BODY_BYTES, main, nodeAtLeast, onPath, requestListener, startHubApi, startService } from './server.mjs';

hermetic();

const HOST = 'test-host';
const policy = loadPolicy().policy;

// A server that binds nothing: `listen` records its arguments and answers (or fails with EADDRINUSE), `close` calls back.
class FakeServer extends EventEmitter {
  constructor(listener, { busy = false } = {}) {
    super();
    this.listener = listener;
    this.busy = busy;
    this.listened = [];
    this.closed = 0;
  }
  listen(port, host, callback) {
    this.listened.push([port, host]);
    if (this.busy) process.nextTick(() => this.emit('error', Object.assign(new Error('listen EADDRINUSE'), { code: 'EADDRINUSE' })));
    else process.nextTick(callback);
    return this;
  }
  address() { return { port: this.listened.at(-1)?.[0] }; }
  close(callback) { this.closed += 1; process.nextTick(callback); return this; }
}

function scratch({ busy = false, heavy = true, node = '24.15.0', ref = null } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'hub-api-server-'));
  const env = { PATH: process.env.PATH, HOME: root, HUB_LOCK_DIR: join(root, 'locks'), HUB_EVENT_DIR: join(root, 'events'), ...(ref ? { HUB_REF: ref } : {}) };
  const out = [];
  const err = [];
  const servers = [];
  const signals = new EventEmitter();
  const s = {
    root, env, out, err, servers, signals,
    log: { out: line => out.push(line), err: line => err.push(line) },
    seams: {
      env, policy, hostId: HOST, now: () => Date.parse('2026-11-25T10:00:00Z'), devices: structuredClone(loadDevices({})), qaDevices: () => [],
      versions: { node }, onPath: name => heavy && name === 'heavy', signals,
      createServer: listener => { const server = new FakeServer(listener, { busy }); servers.push(server); return server; },
    },
    start: (more = {}) => startHubApi({ ...s.seams, log: s.log, ...more }),
    events: () => [...readEvents({ env })].filter(event => event.event.startsWith('registry-')),
    file: () => JSON.parse(readFileSync(registryPath(env), 'utf8')),
    ctx: (more = {}) => ({ env, policy, routes: ROUTES, log: s.log, ...more }),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
  return s;
}

// A fake node request and response: the listener reads the request as an async iterable and writes `writeHead` then `end`.
function exchange(method, url, body) {
  // A body is a string, a JSON value, or an array of Buffers (several chunks).
  const chunks = body === undefined ? [] : (Array.isArray(body) && body.every(Buffer.isBuffer) ? body : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]);
  const req = { method, url, async *[Symbol.asyncIterator]() { for (const chunk of chunks) yield chunk; } };
  const res = { head: null, text: null, writeHead(status, headers) { this.head = { status, headers }; }, end(text) { this.text = text; } };
  return { req, res, json: () => JSON.parse(res.text) };
}

const serve = async (s, method, url, body, more) => {
  const e = exchange(method, url, body);
  await requestListener(s.ctx(more))(e.req, e.res);
  return e;
};

test('a clean start binds 127.0.0.1 on the policy port only, creates the registry at rev 1, then prints HUB_API_LISTEN', async () => {
  const s = scratch();
  try {
    let fileAtListen = null;
    const log = { out: line => { if (line.startsWith('HUB_API_LISTEN')) fileAtListen = existsSync(registryPath(s.env)); s.out.push(line); }, err: line => s.err.push(line) };
    const running = await s.start({ log });
    assert.deepEqual(s.servers[0].listened, [[8794, '127.0.0.1']]);
    assert.equal(s.servers.length, 1);
    assert.deepEqual(s.out, ['HUB_API_LISTEN port=8794']);
    assert.equal(fileAtListen, true, 'the seed is written before the LISTEN line');
    assert.equal(s.file().rev, 1);
    assert.deepEqual(s.err, []);
    assert.equal(running.port, 8794);
    await running.stop();
  } finally { s.cleanup(); }
});

test('a second instance (EADDRINUSE) is HUB_API_ALREADY_RUNNING, exit 1, and writes nothing', async () => {
  const s = scratch({ busy: true });
  try {
    await assert.rejects(s.start(), error => error.code === 'HUB_API_ALREADY_RUNNING' && error.exit === 1 && /8794/.test(error.message));
    assert.equal(existsSync(registryPath(s.env)), false, 'no seed write');
    assert.deepEqual(s.events(), []);
    assert.deepEqual(s.out, []);
  } finally { s.cleanup(); }
});

test('an old Node is HUB_API_NODE and nothing is bound', async () => {
  const s = scratch({ node: '24.6.0' });
  try {
    await assert.rejects(s.start(), error => error.code === 'HUB_API_NODE' && error.exit === 1 && /24\.15/.test(error.message) && /24\.6\.0/.test(error.message));
    assert.equal(s.servers.length, 0);
    assert.equal(existsSync(registryPath(s.env)), false);
  } finally { s.cleanup(); }
});

test('no heavy on PATH is HUB_API_NO_HEAVY and nothing is bound', async () => {
  const s = scratch({ heavy: false });
  try {
    await assert.rejects(s.start(), error => error.code === 'HUB_API_NO_HEAVY' && error.exit === 1);
    assert.equal(s.servers.length, 0);
    assert.equal(existsSync(registryPath(s.env)), false);
  } finally { s.cleanup(); }
});

test('a log behind the file gets one registry-edit "recovered" before the seed writes', async () => {
  const s = scratch();
  try {
    await applySeed({ env: s.env, devices: s.seams.devices, qaDevices: () => [], hostId: HOST, log: () => {} });
    const doc = s.file();
    doc.rev = 3;
    doc.resources[0].name = 'drifted';
    writeFileAtomic(registryPath(s.env), `${JSON.stringify(doc)}\n`);
    const before = s.events().length;
    const running = await s.start();
    const fresh = s.events().slice(before);
    assert.equal(fresh[0].event, 'registry-edit');
    assert.equal(fresh[0].reason, 'recovered');
    assert.equal(fresh[0].rev, 3);
    assert.equal(fresh.filter(event => event.reason === 'recovered').length, 1);
    assert.ok(fresh.slice(1).length > 0 && fresh.slice(1).every(event => event.reason === 'seed' && event.rev === 4), 'the seed follows, at rev 4');
    assert.equal(s.file().rev, 4);
    await running.stop();
  } finally { s.cleanup(); }
});

test('an unreadable registry.json never stops the service: one stderr line, bytes unchanged, /health says unreadable', async () => {
  const s = scratch();
  try {
    mkdirSync(s.env.HUB_LOCK_DIR, { recursive: true });
    writeFileSync(registryPath(s.env), 'not json at all');
    const running = await s.start();
    assert.deepEqual(s.out, ['HUB_API_LISTEN port=8794']);
    const failed = s.err.filter(line => line.startsWith('HUB_API_SEED_FAILED'));
    assert.equal(failed.length, 1);
    assert.match(failed[0], /^HUB_API_SEED_FAILED HUB_REGISTRY_FORMAT /);
    assert.equal(readFileSync(registryPath(s.env), 'utf8'), 'not json at all');
    const answer = await serve(s, 'GET', '/health');
    assert.equal(answer.json().registry, 'unreadable');
    assert.equal(answer.json().ok, true);
    await running.stop();
  } finally { s.cleanup(); }
});

test('any other seed error is also one HUB_API_SEED_FAILED line and the service keeps serving', async () => {
  const s = scratch();
  try {
    const running = await s.start({ qaDevices: () => { throw Object.assign(new Error('qa file is broken'), { code: 'HUB_QA_DEVICES' }); } });
    assert.deepEqual(s.out, ['HUB_API_LISTEN port=8794']);
    assert.deepEqual(s.err, ['HUB_API_SEED_FAILED HUB_QA_DEVICES qa file is broken']);
    assert.equal(existsSync(registryPath(s.env)), false, 'nothing written; the next start retries');
    await running.stop();
  } finally { s.cleanup(); }
});

test('GET /health answers the exact keys, no-store, and reads the registry fresh', async () => {
  const s = scratch();
  try {
    const answer = await serve(s, 'GET', '/health');
    assert.equal(answer.res.head.status, 200);
    assert.equal(answer.res.head.headers['Cache-Control'], 'no-store');
    assert.equal(answer.res.head.headers['Content-Type'], 'application/json; charset=utf-8');
    assert.deepEqual(answer.json(), { ok: true, service: 'mobile-deploy-hub-api', contract: 1, hub_version: 'unknown', ports: { hub_api: 8794, host_agent: 8795 }, registry: 'ok' });
    assert.deepEqual(Object.keys(answer.json()), ['ok', 'service', 'contract', 'hub_version', 'ports', 'registry']);
    assert.equal(SERVICE, 'mobile-deploy-hub-api');
    assert.equal(CONTRACT_VERSION, 1);
    // A missing file is ok; a garbage file flips it for the next call, and a good one flips it back, with no restart.
    mkdirSync(s.env.HUB_LOCK_DIR, { recursive: true });
    writeFileSync(registryPath(s.env), '{');
    assert.equal((await serve(s, 'GET', '/health')).json().registry, 'unreadable');
    rmSync(registryPath(s.env));
    assert.equal((await serve(s, 'GET', '/health?verbose=1')).json().registry, 'ok', 'the query string is ignored');
  } finally { s.cleanup(); }
});

test('hub_version is the HUB_REF, else unknown', async () => {
  const withRef = scratch({ ref: 'v1.2.60' });
  const without = scratch();
  try {
    assert.equal((await serve(withRef, 'GET', '/health')).json().hub_version, 'v1.2.60');
    assert.equal((await serve(without, 'GET', '/health')).json().hub_version, 'unknown');
  } finally { withRef.cleanup(); without.cleanup(); }
});

test('an unknown path is a 404 problem+json HUB_NO_ROUTE exit 2, and paths match exactly', async () => {
  const s = scratch();
  try {
    for (const url of ['/nope', '/health/', '/health/x', '/', '//health', '/Health']) {
      const answer = await serve(s, 'GET', url);
      assert.equal(answer.res.head.status, 404, url);
      assert.equal(answer.res.head.headers['Content-Type'], 'application/problem+json');
      assert.equal(answer.res.head.headers['Cache-Control'], 'no-store');
      const body = answer.json();
      assert.deepEqual(Object.keys(body).sort(), ['code', 'detail', 'exit', 'reason', 'status', 'title', 'type']);
      assert.equal(body.code, 'HUB_NO_ROUTE');
      assert.equal(body.exit, 2);
      assert.equal(body.reason, 'no-route');
      assert.equal(body.status, 404);
      assert.equal(body.title, 'Not Found');
    }
  } finally { s.cleanup(); }
});

test('a known path with the wrong method is a 405 with Allow, HUB_NO_ROUTE exit 2 reason method', async () => {
  const s = scratch();
  try {
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
      const answer = await serve(s, method, '/health', method === 'POST' ? {} : undefined);
      assert.equal(answer.res.head.status, 405, method);
      assert.equal(answer.res.head.headers.Allow, 'GET');
      assert.equal(answer.res.head.headers['Content-Type'], 'application/problem+json');
      assert.deepEqual([answer.json().code, answer.json().exit, answer.json().reason, answer.json().status], ['HUB_NO_ROUTE', 2, 'method', 405]);
    }
  } finally { s.cleanup(); }
});

test('Allow lists every method a path has, sorted', async () => {
  const routes = [{ method: 'POST', path: '/x', shape: 'X', handler: () => ({}) }, { method: 'GET', path: '/x', shape: 'X', handler: () => ({}) }];
  const answer = await handle({ method: 'DELETE', url: '/x' }, { routes });
  assert.equal(answer.headers.Allow, 'GET, POST');
});

test('a handler that throws a plain Error is a 500 HUB_API_ERROR exit 1 with one stderr line', async () => {
  const s = scratch();
  try {
    const routes = [{ method: 'GET', path: '/boom', shape: 'Boom', handler: () => { throw new Error('it broke\nbadly'); } }];
    const answer = await serve(s, 'GET', '/boom', undefined, { routes });
    assert.equal(answer.res.head.status, 500);
    assert.equal(answer.res.head.headers['Content-Type'], 'application/problem+json');
    assert.equal(answer.res.head.headers['Cache-Control'], 'no-store');
    const body = answer.json();
    assert.deepEqual([body.code, body.exit, body.status, body.reason], ['HUB_API_ERROR', 1, 500, 'internal']);
    assert.equal(s.err.length, 1);
    assert.match(s.err[0], /^HUB_API_ERROR GET \/boom it broke badly$/);
    assert.equal(body.detail, 'it broke badly', 'detail is one line');
  } finally { s.cleanup(); }
});

test('a handler error with a status keeps its code, status and exit (the library table), and logs nothing', async () => {
  const s = scratch();
  try {
    const routes = [
      { method: 'GET', path: '/a', shape: 'A', handler: () => { throw Object.assign(new Error('no such thing'), { status: 409, code: 'HUB_REGISTRY_CONFLICT', reason: 'if-rev' }); } },
      { method: 'GET', path: '/b', shape: 'B', handler: () => { throw Object.assign(new Error('bad name'), { status: 422, code: 'HUB_USAGE', exit: 2 }); } },
    ];
    const a = (await serve(s, 'GET', '/a', undefined, { routes })).json();
    assert.deepEqual([a.code, a.status, a.exit, a.reason], ['HUB_REGISTRY_CONFLICT', 409, 1, 'if-rev']);
    const b = (await serve(s, 'GET', '/b', undefined, { routes })).json();
    assert.deepEqual([b.code, b.status, b.exit], ['HUB_USAGE', 422, 2]);
    assert.deepEqual(s.err, []);
  } finally { s.cleanup(); }
});

test('a handler that returns nothing, null or a non-object is a bug: one HUB_API_ERROR line and a 500, never a crash', async () => {
  const s = scratch();
  try {
    for (const [name, value] of [['undefined', undefined], ['null', null], ['a string', 'ok'], ['a number', 7]]) {
      s.err.length = 0;
      const routes = [{ method: 'GET', path: '/bad', shape: 'Bad', handler: () => value }];
      const answer = await serve(s, 'GET', '/bad', undefined, { routes });
      assert.equal(answer.res.head.status, 500, name);
      assert.deepEqual([answer.json().code, answer.json().exit], ['HUB_API_ERROR', 1], name);
      assert.equal(s.err.length, 1, name);
      assert.match(s.err[0], /^HUB_API_ERROR GET \/bad /, name);
    }
  } finally { s.cleanup(); }
});

test('an error whose status is outside 400..599 is the same logged 500 as problem() makes it', async () => {
  const s = scratch();
  try {
    const routes = [{ method: 'GET', path: '/odd', shape: 'Odd', handler: () => { throw Object.assign(new Error('moved'), { status: 302, code: 'HUB_USAGE' }); } }];
    const answer = await serve(s, 'GET', '/odd', undefined, { routes });
    assert.deepEqual([answer.res.head.status, answer.json().code, answer.json().exit], [500, 'HUB_API_ERROR', 1]);
    assert.equal(s.err.length, 1);
    assert.match(s.err[0], /^HUB_API_ERROR GET \/odd moved$/);
  } finally { s.cleanup(); }
});

test('a handler may reply with another success status', async () => {
  const { reply } = await import('./routes.mjs');
  const routes = [{ method: 'POST', path: '/made', shape: 'Made', handler: (ctx, request) => reply(201, { got: request.body.name }) }];
  const answer = await handle({ method: 'POST', url: '/made', body: { name: 'x' } }, { routes });
  assert.equal(answer.status, 201);
  assert.deepEqual(answer.body, { got: 'x' });
  assert.equal(answer.headers['Cache-Control'], 'no-store');
});

test('the adapter parses a POST JSON body, rejects bad JSON as 400 HUB_USAGE and an oversized body as 413', async () => {
  const s = scratch();
  try {
    const routes = [{ method: 'POST', path: '/echo', shape: 'Echo', handler: (ctx, request) => ({ body: request.body ?? null }) }];
    assert.deepEqual((await serve(s, 'POST', '/echo', { a: 1 }, { routes })).json(), { body: { a: 1 } });
    assert.deepEqual((await serve(s, 'POST', '/echo', undefined, { routes })).json(), { body: null });
    const bad = await serve(s, 'POST', '/echo', '{nope', { routes });
    assert.equal(bad.res.head.status, 400);
    assert.deepEqual([bad.json().code, bad.json().exit, bad.json().reason], ['HUB_USAGE', 2, 'bad-json']);
    const big = await serve(s, 'POST', '/echo', 'x'.repeat(MAX_BODY_BYTES + 1), { routes });
    assert.equal(big.res.head.status, 413);
    assert.equal(big.json().code, 'HUB_USAGE');
    // Several chunks, over the limit in total: still the 413, whole stream read.
    const chunk = Buffer.alloc(MAX_BODY_BYTES / 4, 'x');
    const many = await serve(s, 'POST', '/echo', [chunk, chunk, chunk, chunk, chunk], { routes });
    assert.equal(many.res.head.status, 413);
    assert.deepEqual([many.json().code, many.json().exit, many.json().reason], ['HUB_USAGE', 2, 'too-large']);
    // Exactly at the limit is accepted (as the JSON it is).
    const exact = Buffer.from(JSON.stringify({ pad: 'y'.repeat(MAX_BODY_BYTES - 10) }));
    assert.equal(exact.length, MAX_BODY_BYTES);
    assert.equal((await serve(s, 'POST', '/echo', [exact], { routes })).res.head.status, 200);
    // A bad body on a wrong path or method is still a 404 or 405.
    assert.equal((await serve(s, 'POST', '/nowhere', '{nope', { routes })).res.head.status, 404);
    assert.equal((await serve(s, 'POST', '/health', '{nope')).res.head.status, 405);
    // A body on a GET is never read.
    assert.equal((await serve(s, 'GET', '/health', '{nope')).res.head.status, 200);
  } finally { s.cleanup(); }
});

test('the adapter sets Content-Length from the bytes it writes', async () => {
  const s = scratch();
  try {
    const answer = await serve(s, 'GET', '/health');
    assert.equal(answer.res.head.headers['Content-Length'], Buffer.byteLength(answer.res.text));
  } finally { s.cleanup(); }
});

test('SIGTERM and SIGINT close the server, print HUB_API_STOP, and drop the signal listeners', async () => {
  for (const signal of ['SIGTERM', 'SIGINT']) {
    const s = scratch();
    try {
      const running = await s.start();
      assert.equal(s.signals.listenerCount('SIGTERM'), 1);
      assert.equal(s.signals.listenerCount('SIGINT'), 1);
      s.signals.emit(signal);
      await running.stopped;
      assert.equal(s.servers[0].closed, 1);
      assert.deepEqual(s.out, ['HUB_API_LISTEN port=8794', 'HUB_API_STOP']);
      assert.equal(s.signals.listenerCount('SIGTERM') + s.signals.listenerCount('SIGINT'), 0);
      await running.stop();
      assert.equal(s.servers[0].closed, 1, 'stop is idempotent');
    } finally { s.cleanup(); }
  }
});

test('startService is generic: any name, port and route table; a start refusal does not touch the registry', async () => {
  const s = scratch();
  try {
    const routes = [{ method: 'GET', path: '/ping', shape: 'Ping', handler: () => ({ pong: true }) }];
    const running = await startService({ service: 'host-agent', port: 8795, routes, ctx: { policy }, env: s.env, log: s.log, versions: { node: '24.15.0' }, onPath: () => true, signals: s.signals, createServer: listener => { const server = new FakeServer(listener); s.servers.push(server); return server; } });
    assert.deepEqual(s.servers[0].listened, [[8795, '127.0.0.1']]);
    assert.deepEqual(s.out, ['HUB_API_LISTEN port=8795']);
    assert.equal(existsSync(registryPath(s.env)), false);
    const e = exchange('GET', '/ping');
    await s.servers[0].listener(e.req, e.res);
    assert.deepEqual(e.json(), { pong: true });
    await running.stop();
  } finally { s.cleanup(); }
});

test('main maps a start refusal to <CODE> <message> on stderr and its exit', async () => {
  const s = scratch({ node: '24.6.0' });
  try {
    const code = await main({ ...s.seams, log: s.log });
    assert.equal(code, 1);
    assert.equal(s.err.length, 1);
    assert.match(s.err[0], /^HUB_API_NODE .* needs Node >= 24\.15/);
  } finally { s.cleanup(); }
  const busy = scratch({ busy: true });
  try {
    assert.equal(await main({ ...busy.seams, log: busy.log }), 1);
    assert.match(busy.err[0], /^HUB_API_ALREADY_RUNNING /);
  } finally { busy.cleanup(); }
});

test('main ends 0 after a signal stops the service', async () => {
  const s = scratch();
  try {
    const done = main({ ...s.seams, log: s.log });
    while (s.out.length === 0) await new Promise(resolve => setImmediate(resolve));
    s.signals.emit('SIGTERM');
    assert.equal(await done, 0);
    assert.deepEqual(s.out, ['HUB_API_LISTEN port=8794', 'HUB_API_STOP']);
  } finally { s.cleanup(); }
});

test('nodeAtLeast compares dotted versions numerically', () => {
  for (const [version, expected] of [['24.15.0', true], ['24.15', true], ['v24.15.1', true], ['24.16.0', true], ['25.0.0', true], ['24.6.0', false], ['24.14.9', false], ['23.99.0', false], ['', false], [undefined, false], ['abc', false]]) {
    assert.equal(nodeAtLeast(version, '24.15'), expected, String(version));
  }
});

test('onPath finds an executable file in a PATH directory and nothing else', () => {
  const root = mkdtempSync(join(tmpdir(), 'hub-api-path-'));
  try {
    const bin = join(root, 'bin');
    const other = join(root, 'other');
    mkdirSync(bin);
    mkdirSync(other);
    writeFileSync(join(bin, 'heavy'), '#!/bin/sh\n');
    chmodSync(join(bin, 'heavy'), 0o755);
    writeFileSync(join(other, 'heavy-not-exec'), '');
    chmodSync(join(other, 'heavy-not-exec'), 0o644);
    mkdirSync(join(other, 'heavy'));
    assert.equal(onPath('heavy', { PATH: `${other}:${bin}` }), true);
    assert.equal(onPath('heavy', { PATH: other }), false, 'a directory is not a program');
    assert.equal(onPath('heavy-not-exec', { PATH: other }), false);
    assert.equal(onPath('heavy', { PATH: '' }), false);
    assert.equal(onPath('heavy', {}), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a failed afterBind closes the server, drops the signal listeners and rejects with that error', async () => {
  const s = scratch();
  try {
    const failure = new Error('start work failed');
    await assert.rejects(startService({ port: 8794, ctx: { policy }, env: s.env, log: s.log, versions: { node: '24.15.0' }, onPath: () => true, signals: s.signals, afterBind: async () => { throw failure; }, createServer: listener => { const server = new FakeServer(listener); s.servers.push(server); return server; } }), error => error === failure);
    assert.equal(s.servers[0].closed, 1);
    assert.equal(s.signals.listenerCount('SIGTERM') + s.signals.listenerCount('SIGINT'), 0);
    assert.equal(s.out.some(line => line.startsWith('HUB_API_LISTEN')), false);
  } finally { s.cleanup(); }
});

test('the process entry, run directly and through a symlink, refuses before any bind: exit 1, a start-refusal line, no registry', () => {
  const root = mkdtempSync(join(tmpdir(), 'hub-api-entry-'));
  try {
    const empty = join(root, 'empty');
    mkdirSync(empty);
    const script = fileURLToPath(new URL('./server.mjs', import.meta.url));
    const link = join(root, 'link-to-server.mjs');
    symlinkSync(script, link);
    const env = { PATH: empty, HOME: root, HUB_LOCK_DIR: join(root, 'locks'), HUB_EVENT_DIR: join(root, 'events') };
    for (const entry of [script, link]) {
      const run = spawnSync(process.execPath, [entry], { env, encoding: 'utf8', timeout: 30_000 });
      assert.equal(run.status, 1, `${entry}: ${run.stderr}`);
      assert.match(run.stderr.trim(), /^HUB_API_(NODE|NO_HEAVY) /, entry);
      assert.equal(run.stderr.trim().split('\n').length, 1, entry);
      assert.doesNotMatch(run.stdout, /HUB_API_LISTEN/);
      assert.equal(existsSync(registryPath(env)), false);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('startHubApi hands its devices and qaDevices to the routes: an injected QA phone is served with a null serial', async () => {
  const s = scratch();
  const SERIAL = 'QAMADEUP4242';
  try {
    const running = await s.start({ qaDevices: () => [{ name: 'Pixel-QA', model: 'Pixel 7', serial: SERIAL }] });
    const listener = s.servers[0].listener;
    // The start wrote the file; with it gone the routes answer from the in-memory seed, which only the injected seams can supply.
    rmSync(registryPath(s.env));
    const ask = async url => { const e = exchange('GET', url); await listener(e.req, e.res); return e; };
    const list = await ask('/resources');
    assert.equal(list.res.head.status, 200);
    const listed = list.json().resources.find(resource => resource.id === 'res-pixel-qa');
    assert.equal(list.json().source, 'seed');
    assert.equal(listed?.identity.serial, null);
    const one = await ask('/resources/s26');
    assert.equal(one.res.head.status, 200);
    assert.equal(one.json().resource.id, 's26');
    assert.equal(list.res.text.includes(SERIAL) || one.res.text.includes(SERIAL), false);
    await running.stop();
  } finally { s.cleanup(); }
});

test('Registry routes with no file and a QA seed that cannot be built answer 500 HUB_API_ERROR, one line, and log each request', async () => {
  const s = scratch();
  try {
    const errors = [];
    const ctx = s.ctx({ qaDevices: () => { throw Object.assign(new Error('qa file\nis broken'), { code: 'HUB_QA_DEVICES' }); }, devices: structuredClone(loadDevices({})), log: { out: () => {}, err: line => errors.push(line) } });
    for (const url of ['/resources', '/resources/s26', '/pools']) {
      const answer = await handle({ method: 'GET', url }, ctx);
      assert.equal(answer.status, 500, url);
      assert.equal(answer.headers['Content-Type'], 'application/problem+json');
      assert.deepEqual([answer.body.code, answer.body.exit], ['HUB_API_ERROR', 1], url);
      assert.doesNotMatch(answer.body.detail, /\n/);
    }
    assert.equal(errors.length, 3);
    assert.ok(errors.every(line => line.startsWith('HUB_API_ERROR GET /')));
  } finally { s.cleanup(); }
});
