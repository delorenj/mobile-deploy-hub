// Story 9.3: the forwarding half of the one transport (hub-client.mjs): the `X-Hub-Forwarded` header on the loopback fetch, the door word on the ssh
// relay, the relay's door validation, the caller's signal, and `forward()`'s classification of what comes back. Hermetic: every fetch, ssh child and
// timer is injected; no port is bound and no host is reached.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { loadDevices } from './ci/lib/devices.mjs';
import { loadPolicy } from './ci/lib/policy.mjs';
import { hermetic } from './ci/test-fixtures.mjs';
import { FORWARD_DOORS, FORWARD_HEADER, RELAY_USAGE, forward, main, relay, remoteCommand, request, sshArgv } from './hub-client.mjs';

hermetic();

const policy = loadPolicy().policy;
const devices = loadDevices({});
const flush = async (rounds = 6) => { for (let round = 0; round < rounds; round += 1) await new Promise(done => setImmediate(done)); };
const json = (status, body, type = 'application/json; charset=utf-8') => new Response(JSON.stringify(body), { status, headers: { 'content-type': type } });
const problem = (status, code, extra = {}) => json(status, { type: `urn:mobile-deploy-hub:problem:${code}`, title: 'x', status, detail: `${code} happened`, code, exit: 2, reason: 'why', ...extra }, 'application/problem+json');
const thrown = async promise => { try { await promise; } catch (error) { return error; } return assert.fail('expected a throw'); };

function fakeTimers() {
  const t = { intervals: [], timeouts: [], cleared: [] };
  t.setInterval = (fn, ms) => { const handle = { fn, ms }; t.intervals.push(handle); return handle; };
  t.clearInterval = handle => { t.cleared.push(handle); };
  t.setTimeout = (fn, ms) => { const handle = { fn, ms, refresh() { return this; } }; t.timeouts.push(handle); return handle; };
  t.clearTimeout = handle => { t.cleared.push(handle); };
  return t;
}

function sshChild() {
  const child = new EventEmitter();
  Object.assign(child, { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), killed: false, stdinText: '', stdinEnded: false });
  child.kill = () => { child.killed = true; };
  child.stdin.on('data', chunk => { child.stdinText += chunk; });
  child.stdin.on('end', () => { child.stdinEnded = true; });
  child.answer = (text, code = 0) => { child.stdout.once('end', () => child.emit('close', code)); child.stdout.end(text); };
  return child;
}

const wordsOf = command => [...command.matchAll(/'((?:[^']|'\\'')*)'/g)].map(match => match[1].replaceAll("'\\''", "'"));

test('the header name and the three doors are the contract\'s', () => {
  assert.equal(FORWARD_HEADER, 'X-Hub-Forwarded');
  assert.deepEqual(FORWARD_DOORS, ['cli', 'api', 'host-agent']);
  assert.match(RELAY_USAGE, /\[cli\|api\|host-agent\]|<door>|door/);
});

test('a same-host forward is a loopback fetch with the header; a plain call carries none', async () => {
  const seen = [];
  const fetchImpl = async (url, init) => { seen.push({ url, init }); return json(200, { ok: true }); };
  await request({ host: 'linux', method: 'POST', path: '/leases', body: { a: 1 }, forwarded: 'api' }, { policy, hostKey: () => 'linux', fetchImpl });
  await request({ host: 'linux', method: 'POST', path: '/leases', body: { a: 1 } }, { policy, hostKey: () => 'linux', fetchImpl });
  assert.equal(seen[0].init.headers[FORWARD_HEADER], 'api');
  assert.equal(FORWARD_HEADER in seen[1].init.headers, false);
  assert.equal(seen[0].url, `http://127.0.0.1:${policy.api.hub_api_port}/leases`);
});

test('a door that is not one of the three is HUB_USAGE and nothing is sent', async () => {
  const error = await thrown(request({ host: 'linux', path: '/x', forwarded: 'nope' }, { policy, hostKey: () => 'linux', fetchImpl: () => assert.fail('nothing is sent') }));
  assert.equal(error.code, 'HUB_USAGE');
});

test('a peer forward appends the door as the relay\'s last word, and a plain call has none', async () => {
  const spawned = [];
  const child = sshChild();
  const pending = request({ host: 'mac', method: 'POST', path: '/leases', body: {}, forwarded: 'cli' }, { policy, hostKey: () => 'linux', devices, timers: fakeTimers(), sshImpl: argv => { spawned.push(argv); return child; } });
  await flush();
  assert.deepEqual(spawned[0], sshArgv('hub-mac', remoteCommand({ method: 'POST', path: '/leases', door: 'cli' }), policy));
  assert.deepEqual(wordsOf(spawned[0].at(-1)).slice(2), ['relay', 'POST', '/leases', 'cli']);
  child.answer(`${JSON.stringify({ format: 1, status: 200, headers: {} })}\n{}`);
  await pending;
  assert.deepEqual(wordsOf(remoteCommand({ method: 'POST', path: '/x' })).slice(2), ['relay', 'POST', '/x']);
});

test('an abort kills ssh (its stdin closes, so the far relay aborts) and the call rejects with the signal\'s reason', async () => {
  const child = sshChild();
  const abort = new AbortController();
  const t = fakeTimers();
  const pending = thrown(request({ host: 'mac', method: 'POST', path: '/leases', body: {}, signal: abort.signal }, { policy, hostKey: () => 'linux', devices, timers: t, sshImpl: () => child }));
  await flush();
  const reason = new Error('the user pressed ctrl-c');
  abort.abort(reason);
  assert.equal(await pending, reason);
  assert.equal(child.killed, true);
  await flush(2);
  assert.equal(child.stdinEnded, true);
  assert.ok(t.cleared.includes(t.intervals[0]), 'the heartbeat is cleared');
});

test('a signal that is already aborted never spawns ssh', async () => {
  const abort = new AbortController();
  abort.abort(new Error('early'));
  const error = await thrown(request({ host: 'mac', path: '/x', signal: abort.signal }, { policy, hostKey: () => 'linux', devices, timers: fakeTimers(), sshImpl: () => assert.fail('no ssh') }));
  assert.equal(error.message, 'early');
});

test('a loopback abort rejects the fetch with the reason', async () => {
  const abort = new AbortController();
  const fetchImpl = (url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason)));
  const pending = thrown(request({ host: 'linux', path: '/x', signal: abort.signal }, { policy, hostKey: () => 'linux', fetchImpl }));
  await flush(2);
  const reason = new Error('stop');
  abort.abort(reason);
  assert.equal(await pending, reason);
});

test('the relay takes an optional door: it sets the header on its loopback call, and a bad door is HUB_RELAY_USAGE (exit 2) with no request', async () => {
  const seen = [];
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const chunks = [];
  stdout.on('data', chunk => chunks.push(chunk));
  const done = relay({ method: 'POST', path: '/leases', door: 'host-agent', stdin, stdout, policy, hostKey: () => 'mac', fetchImpl: async (url, init) => { seen.push({ url, init }); return json(200, { ok: true }); }, timers: fakeTimers() });
  stdin.write('{"a":1}\n');
  assert.equal(await done, 0);
  assert.equal(seen[0].init.headers[FORWARD_HEADER], 'host-agent');
  assert.equal(seen[0].url, `http://127.0.0.1:${policy.api.host_agent_port}/leases`);

  const badOut = new PassThrough();
  const bad = [];
  badOut.on('data', chunk => bad.push(chunk));
  const badStdin = new PassThrough();
  const exit = relay({ method: 'POST', path: '/leases', door: 'evil', stdin: badStdin, stdout: badOut, policy, hostKey: () => 'mac', fetchImpl: () => assert.fail('no request'), timers: fakeTimers() });
  badStdin.write('{}\n');
  assert.equal(await exit, 2);
  await flush(2);
  assert.equal(JSON.parse(Buffer.concat(bad).toString().split('\n')[0]).error.code, 'HUB_RELAY_USAGE');
});

test('main relay accepts a door word and refuses a bad one or a fourth word', async () => {
  const run = async argv => {
    const stdout = new PassThrough();
    const chunks = [];
    stdout.on('data', chunk => chunks.push(chunk));
    const stderr = [];
    const stdin = new PassThrough();
    const seen = [];
    const done = main(['relay', ...argv], { stdin, stdout, stderr: { write: line => stderr.push(line) }, policy, hostKey: () => 'linux', fetchImpl: async (url, init) => { seen.push(init); return json(200, { ok: true }); }, timers: fakeTimers() });
    stdin.write('\n');
    const code = await done;
    await flush(2);
    return { code, seen, out: Buffer.concat(chunks).toString(), stderr };
  };
  const good = await run(['GET', '/health', 'api']);
  assert.equal(good.code, 0);
  assert.equal(good.seen[0].headers[FORWARD_HEADER], 'api');
  const bad = await run(['GET', '/health', 'nope']);
  assert.equal(bad.code, 2);
  const extra = await run(['GET', '/health', 'api', 'more']);
  assert.equal(extra.code, 2);
});

test('forward: a 2xx JSON answer is {status, body}, and the request carries the door, the bounds and the signal', async () => {
  const seen = [];
  const abort = new AbortController();
  const answer = await forward({ host: 'mac', method: 'POST', path: '/leases', body: { a: 1 }, door: 'api', waitMs: 5000, budgetMs: 1000, signal: abort.signal }, { request: async args => { seen.push(args); return json(200, { lease_id: 'l-1' }); } });
  assert.deepEqual(answer, { status: 200, body: { lease_id: 'l-1' } });
  assert.deepEqual(seen[0], { host: 'mac', method: 'POST', path: '/leases', body: { a: 1 }, waitMs: 5000, budgetMs: 1000, forwarded: 'api', signal: abort.signal });
});

test('forward: a problem+json answer is the far side\'s own error, with its code, status, exit and reason', async () => {
  const error = await thrown(forward({ host: 'mac', path: '/x', door: 'cli' }, { request: async () => problem(409, 'HUB_WRONG_HOST', { exit: 2, reason: 'wrong-host' }) }));
  assert.deepEqual([error.code, error.api, error.status, error.exit, error.reason], ['HUB_WRONG_HOST', true, 409, 2, 'wrong-host']);
});

test('forward: a transport failure is HUB_DEVICE_AWAY (exit 75, host-unreachable, status 503) and is never retried', async () => {
  let calls = 0;
  for (const failure of [Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }), new Error('reset'), Object.assign(new Error('away'), { code: 'HUB_DEVICE_AWAY', exit: 75, reason: 'host-unreachable' })]) {
    const error = await thrown(forward({ host: 'mac', path: '/x', door: 'cli' }, { request: async () => { calls += 1; throw failure; } }));
    assert.deepEqual([error.code, error.exit, error.reason, error.status], ['HUB_DEVICE_AWAY', 75, 'host-unreachable', 503]);
  }
  assert.equal(calls, 3, 'one call each: no retry');
});

test('forward: a caller\'s own HUB_ mistake propagates as it is', async () => {
  const mistake = Object.assign(new Error('bad door'), { code: 'HUB_USAGE' });
  assert.equal(await thrown(forward({ host: 'mac', path: '/x' }, { request: async () => { throw mistake; } })), mistake);
});

test('forward: an answer that is neither JSON nor a problem is HUB_API_UNKNOWN 502, for a 2xx text body and for a 5xx page alike', async () => {
  for (const response of [new Response('hello', { status: 200 }), new Response('<html>', { status: 502 }), json(500, { nope: true })]) {
    const error = await thrown(forward({ host: 'mac', path: '/x' }, { request: async () => response }));
    assert.deepEqual([error.code, error.status], ['HUB_API_UNKNOWN', 502]);
  }
});

test('forward: an abort rejects with the signal\'s reason, whatever the transport said', async () => {
  const abort = new AbortController();
  const reason = new Error('ctrl-c');
  const pending = thrown(forward({ host: 'mac', path: '/x', signal: abort.signal }, { request: () => new Promise((_, reject) => abort.signal.addEventListener('abort', () => reject(new TypeError('fetch failed')))) }));
  await flush(2);
  abort.abort(reason);
  assert.equal(await pending, reason);
});
