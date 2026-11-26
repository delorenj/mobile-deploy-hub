// Story 9.3: `hub-device` forwards a Hold verb on a Resource of another host (door `cli`) and prints what the local verb prints. Hermetic: the transport is an
// injected `request` seam (no ssh, no port), the host key is injected, and the lock and event dirs are temp dirs, which no forwarded verb may write.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadPolicy } from '../ci/lib/policy.mjs';
import { hermetic } from '../ci/test-fixtures.mjs';
import { main } from './hub-device.mjs';

hermetic();

const policy = loadPolicy().policy;
const MIN = 60_000;
const json = (status, body, type = 'application/json') => new Response(JSON.stringify(body), { status, headers: { 'content-type': type } });
const problem = (status, code, extra = {}) => json(status, { type: `urn:mobile-deploy-hub:problem:${code}`, title: 'x', status, detail: `${code} happened`, code, exit: 2, reason: 'why', ...extra }, 'application/problem+json');
const refused = () => Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });

// One CLI run as a host with `key`: `answers` maps `<METHOD> <path>` (a function, a Response or an Error) and every call of the transport is recorded.
function run(argv, { key = 'mac', answers = {}, resourcesRev = null, signals = new EventEmitter(), env: more = {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'forward-cli-'));
  const env = { PATH: process.env.PATH, HOME: root, HUB_LOCK_DIR: join(root, 'locks'), HUB_EVENT_DIR: join(root, 'events'), USER: 'jarad', ...more };
  const calls = [];
  const out = [];
  const err = [];
  const request = async args => {
    calls.push(args);
    const route = `${args.method} ${args.path.replace(/\/(l|r|e)-[0-9a-z]+/g, '/$1-ID')}`;
    if (args.path === '/resources') {
      if (resourcesRev === null) throw refused();
      return json(200, { rev: resourcesRev, source: 'file', resources: (await import('../registry/seed.mjs')).seed(structuredClone((await import('../ci/lib/devices.mjs')).loadDevices({})), { qaDevices: () => [] }).resources });
    }
    const answer = answers[route] ?? answers[`${args.method} ${args.path}`];
    if (answer === undefined) return assert.fail(`unexpected call ${route}`);
    const value = typeof answer === 'function' ? await answer(args) : answer;
    if (value instanceof Error) throw value;
    return value;
  };
  const done = main(argv, { env, stdout: line => out.push(line), stderr: line => err.push(line), signals, hostKey: () => key, policy, qaDevices: () => [], request, now: () => Date.parse('2026-11-26T10:00:00Z') });
  return done.then(code => ({ code, out, err, calls, posts: calls.filter(call => call.method !== 'GET'), root, env, wrote: existsSync(env.HUB_LOCK_DIR), cleanup: () => rmSync(root, { recursive: true, force: true }) }));
}

const LEASE_VIEW = { lease_id: 'l-aaaaaaaaaaaa', resource: 's24', lock: 's24', device: 's24', holder: 'jarad', why: 'proof', claimant_kind: 'agent', started_at: 'a', expires_at: '2026-11-26T10:30:00Z', env: { HUB_LEASE_ID: 'l-aaaaaaaaaaaa', HUB_DEVICE: 's24' }, emulator: null };
const TAKE = ['lease', 's24', '--for', '30m', '--why', 'proof', '--id', 'l-aaaaaaaaaaaa', '--holder', 'jarad'];

test('a Mac-keyed lease of a phone is forwarded to linux as the door cli, with the record at the Hub API\'s rev, and prints the same export lines', async () => {
  const r = await run(TAKE, { resourcesRev: 12, answers: { 'POST /leases': json(200, LEASE_VIEW) } });
  try {
    assert.equal(r.code, 0, r.err.join('\n'));
    assert.deepEqual(r.out, ["export HUB_LEASE_ID='l-aaaaaaaaaaaa'", "export HUB_DEVICE='s24'"]);
    const sent = r.posts[0];
    assert.deepEqual([sent.host, sent.path, sent.forwarded, sent.waitMs], ['linux', '/leases', 'cli', 120_000]);
    assert.deepEqual(sent.body.resource, { id: 's24', lock: 's24', host: 'linux', rev: 12, retired_at: null });
    assert.deepEqual([sent.body.for_ms, sent.body.wait_ms, sent.body.why, sent.body.id, sent.body.holder], [30 * MIN, 120_000, 'proof', 'l-aaaaaaaaaaaa', 'jarad']);
    assert.deepEqual(sent.body.actor, { holder: 'jarad', via: 'cli' });
    assert.equal(r.wrote, false, 'this host\'s lock dir is untouched');
  } finally { r.cleanup(); }
});

test('with the Hub API unreachable the CLI resolves from its seed and forwards with rev 0', async () => {
  const r = await run(TAKE, { resourcesRev: null, answers: { 'POST /leases': json(200, LEASE_VIEW) } });
  try {
    assert.equal(r.code, 0, r.err.join('\n'));
    assert.equal(r.posts[0].body.resource.rev, 0);
    assert.equal(r.wrote, false);
  } finally { r.cleanup(); }
});

test('--json prints the lease as the local --json does; a minted id when none is given; --match goes as the query, with no carried record', async () => {
  const r = await run(['lease', '--match', 'kind=phone', '--for', '30m', '--why', 'proof', '--holder', 'jarad', '--json'], { resourcesRev: 3, answers: { 'POST /leases': json(200, LEASE_VIEW) } });
  try {
    assert.equal(r.code, 0, r.err.join('\n'));
    assert.deepEqual(JSON.parse(r.out[0]), { lease_id: 'l-aaaaaaaaaaaa', device: 's24', holder: 'jarad', why: 'proof', expires_at: LEASE_VIEW.expires_at, env: LEASE_VIEW.env });
    const body = r.posts[0].body;
    assert.equal(body.match, 'kind=phone');
    assert.equal(body.resource, undefined);
    assert.match(body.id, /^l-[0-9a-f]{12}$/);
  } finally { r.cleanup(); }
});

test('release, extend, cancel and force-release with --resource forward and print the local lines', async () => {
  const r = await run(['release', 'l-aaaaaaaaaaaa', '--resource', 's24', '--holder', 'jarad'], { resourcesRev: 5, answers: { 'POST /leases/l-ID/release': json(200, { lease_id: 'l-aaaaaaaaaaaa', outcome: 'released', resource: 's24', lock: 's24', device: 's24' }) } });
  try {
    assert.equal(r.code, 0, r.err.join('\n'));
    assert.deepEqual(r.out, ['HUB_DEVICE_RELEASED s24 l-aaaaaaaaaaaa']);
    assert.deepEqual([r.posts[0].path, r.posts[0].forwarded], ['/leases/l-aaaaaaaaaaaa/release', 'cli']);
    assert.deepEqual(r.posts[0].body.resource, { id: 's24', lock: 's24', host: 'linux', rev: 5, retired_at: null });
  } finally { r.cleanup(); }

  const none = await run(['release', 'l-aaaaaaaaaaaa', '--resource', 's24'], { answers: { 'POST /leases/l-ID/release': json(200, { lease_id: 'l-aaaaaaaaaaaa', outcome: 'none', resource: null, lock: null, device: null }) } });
  try { assert.deepEqual(none.out, ['HUB_DEVICE_NOT_HELD s24 l-aaaaaaaaaaaa (no lease by that id)']); assert.equal(none.code, 0); } finally { none.cleanup(); }

  const waiter = await run(['release', 'l-aaaaaaaaaaaa', '--resource', 's24'], { answers: { 'POST /leases/l-ID/release': json(200, { lease_id: 'l-aaaaaaaaaaaa', outcome: 'cancelled', resource: 's24', lock: 's24', device: 's24' }) } });
  try { assert.deepEqual(waiter.out, ['HUB_DEVICE_CANCELLED s24 l-aaaaaaaaaaaa (it was still waiting)']); } finally { waiter.cleanup(); }

  const extended = await run(['extend', 'l-aaaaaaaaaaaa', '--for', '10m', '--resource', 's24', '--override', 'proof needs it', '--holder', 'jarad'], { answers: { 'POST /leases/l-ID/extend': json(200, LEASE_VIEW) } });
  try {
    assert.equal(extended.code, 0, extended.err.join('\n'));
    assert.deepEqual(extended.out, ['HUB_DEVICE_EXTENDED s24 l-aaaaaaaaaaaa until 2026-11-26T10:30:00Z']);
    assert.deepEqual([extended.posts[0].body.for_ms, extended.posts[0].body.override.why, extended.posts[0].body.override.actor], [10 * MIN, 'proof needs it', { holder: 'jarad', via: 'cli' }]);
  } finally { extended.cleanup(); }

  const cancelled = await run(['cancel', 'r-aaaaaaaaaaaa', '--resource', 's24', '--pool', 'phone', '--why', 'stuck'], { answers: { 'POST /requests/r-ID/cancel': json(200, { request_id: 'r-aaaaaaaaaaaa', outcome: 'cancelled', resource: 'phone', pool: 'phone', queues: [] }) } });
  try {
    assert.deepEqual(cancelled.out, ['HUB_DEVICE_CANCELLED phone r-aaaaaaaaaaaa']);
    assert.deepEqual([cancelled.posts[0].body.pool, cancelled.posts[0].body.host, cancelled.posts[0].body.resource, cancelled.posts[0].body.why], ['phone', 'linux', 's24', 'stuck']);
  } finally { cancelled.cleanup(); }

  const forced = await run(['force-release', 'l-aaaaaaaaaaaa', '--resource', 's24', '--why', 'dead run', '--holder', 'ops'], { answers: { 'POST /leases/l-ID/force-release': json(200, { lease_id: 'l-aaaaaaaaaaaa', outcome: 'force-released', resource: 's24', lock: 's24', device: 's24', holder: 'jarad', why: 'dead run' }) } });
  try {
    assert.deepEqual(forced.out, ['HUB_DEVICE_FORCE_RELEASED s24 l-aaaaaaaaaaaa holder=jarad']);
    assert.equal(forced.posts[0].body.why, 'dead run');
    assert.equal(forced.wrote, false);
  } finally { forced.cleanup(); }
});

test('a linux-keyed CLI forwards a release of the iPad lane to the Mac, and does not forward `lease ipad` (Story 9.4)', async () => {
  const r = await run(['release', 'l-aaaaaaaaaaaa', '--resource', 'ios-lane', '--holder', 'jarad'], { key: 'linux', answers: { 'POST /leases/l-ID/release': json(200, { lease_id: 'l-aaaaaaaaaaaa', outcome: 'released', resource: 'ios-lane', lock: 'mac-ios', device: 'ios-lane' }) } });
  try {
    assert.equal(r.code, 0, r.err.join('\n'));
    assert.deepEqual([r.posts[0].host, r.posts[0].forwarded], ['mac', 'cli']);
    assert.deepEqual(r.posts[0].body.resource, { id: 'ios-lane', lock: 'mac-ios', host: 'mac', rev: 0, retired_at: null });
    assert.equal(r.calls.some(call => call.path === '/resources'), false, 'big-chungus reads its own Registry: no refresh');
    assert.equal(r.wrote, false);
  } finally { r.cleanup(); }
  const lease = await run(['lease', 'ipad', '--for', '30m', '--why', 'x'], { key: 'linux' });
  try {
    assert.equal(lease.calls.length, 0, 'the iOS lane take is Story 9.4\'s: nothing is forwarded');
    assert.notEqual(lease.code, 0);
  } finally { lease.cleanup(); }
});

test('a verb that names a Resource of this host, or none, runs here and sends nothing', async () => {
  const own = await run(['release', 'l-aaaaaaaaaaaa', '--resource', 's24'], { key: 'linux' });
  try { assert.equal(own.calls.length, 0); assert.equal(own.code, 0); assert.match(own.out[0], /^HUB_DEVICE_NOT_HELD/); } finally { own.cleanup(); }
  const bare = await run(['release', 'l-aaaaaaaaaaaa'], { key: 'mac' });
  try { assert.equal(bare.calls.length, 0, 'a verb with no --resource names nothing'); } finally { bare.cleanup(); }
  const unknown = await run(['release', 'l-aaaaaaaaaaaa', '--resource', 's24'], { key: 'linux', env: {} });
  try { assert.equal(unknown.calls.length, 0); } finally { unknown.cleanup(); }
});

test('a host that does not know its key does not forward: it acts in-process, as in v1a', async () => {
  const root = mkdtempSync(join(tmpdir(), 'forward-cli-'));
  try {
    const out = [];
    const code = await main(['release', 'l-aaaaaaaaaaaa', '--resource', 's24'], {
      env: { PATH: process.env.PATH, HOME: root, HUB_LOCK_DIR: join(root, 'locks'), HUB_EVENT_DIR: join(root, 'events') }, stdout: line => out.push(line), stderr: () => {}, signals: new EventEmitter(), policy, qaDevices: () => [],
      hostKey: () => { throw Object.assign(new Error('which host?'), { code: 'HUB_HOST_UNKNOWN' }); }, request: () => assert.fail('nothing is forwarded'),
    });
    assert.equal(code, 0);
    assert.match(out[0], /^HUB_DEVICE_NOT_HELD/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('--pid and --env-serial on a forward are exit 2 and nothing is sent; --no-connect, --profile and --pool are refused the same way', async () => {
  for (const extra of [['--pid', '123'], ['--env-serial', 'ANDROID_SERIAL'], ['--no-connect'], ['--profile', 'default'], ['--pool', '2']]) {
    const r = await run([...TAKE, ...extra], { resourcesRev: 1 });
    try {
      assert.equal(r.code, 2, extra.join(' '));
      assert.equal(r.posts.length, 0, extra.join(' '));
      assert.match(r.err.join('\n'), /hub-device: /);
    } finally { r.cleanup(); }
  }
  const release = await run(['release', 'l-aaaaaaaaaaaa', '--resource', 's24', '--pid', '9'], { resourcesRev: 1 });
  try { assert.equal(release.code, 2); assert.equal(release.posts.length, 0); } finally { release.cleanup(); }
});

test('run on a foreign target is HUB_WRONG_HOST, exit 2, and nothing is sent or written', async () => {
  for (const argv of [['run', 's24', '--for', '1m', '--why', 'x', '--', 'true'], ['run', '--match', 'kind=phone', '--for', '1m', '--why', 'x', '--', 'true'], ['run', 'emulator', '--for', '1m', '--why', 'x', '--', 'true']]) {
    const r = await run(argv, { resourcesRev: 1 });
    try {
      assert.equal(r.code, 2, argv.join(' '));
      assert.match(r.err.join('\n'), /^HUB_WRONG_HOST .*is on host linux; this is host mac/, argv.join(' '));
      assert.equal(r.posts.length, 0);
      assert.equal(r.wrote, false);
    } finally { r.cleanup(); }
  }
});

test('the far side\'s problems print with their code, reason and exit; a host that does not answer is HUB_DEVICE_AWAY (75)', async () => {
  const refusedExtend = await run(['extend', 'l-aaaaaaaaaaaa', '--for', '10m', '--resource', 's24'], { answers: { 'POST /leases/l-ID/extend': problem(409, 'HUB_LEASE_EXTEND_REFUSED', { exit: 76, reason: 'waiters' }) } });
  try {
    assert.equal(refusedExtend.code, 76);
    assert.match(refusedExtend.err.join('\n'), /^HUB_LEASE_EXTEND_REFUSED extend HUB_LEASE_EXTEND_REFUSED happened \(reason: waiters\)/);
  } finally { refusedExtend.cleanup(); }

  const missing = await run(['cancel', 'r-aaaaaaaaaaaa', '--resource', 's24'], { answers: { 'POST /requests/r-ID/cancel': problem(404, 'HUB_REQUEST_NOT_FOUND', { exit: 2, reason: 'unknown' }) } });
  try { assert.equal(missing.code, 2); assert.match(missing.err.join('\n'), /HUB_REQUEST_NOT_FOUND/); } finally { missing.cleanup(); }

  const away = await run(TAKE, { answers: { 'POST /leases': refused() } });
  try {
    assert.equal(away.code, 75);
    assert.deepEqual(away.out, ['HUB_DEVICE_AWAY s24']);
    assert.match(away.err.join('\n'), /is away: host-unreachable/);
  } finally { away.cleanup(); }
});

test('SIGINT while a forward waits aborts the transport and exits 130; nothing else is printed', async () => {
  const signals = new EventEmitter();
  let seen;
  const pending = run(TAKE, { signals, answers: { 'POST /leases': args => new Promise((_, reject) => { seen = args; args.signal.addEventListener('abort', () => reject(args.signal.reason)); }) } });
  for (let tries = 0; tries < 50 && seen === undefined; tries += 1) await new Promise(done => setTimeout(done, 10));
  assert.ok(seen, 'the forward is in flight');
  signals.emit('SIGINT', 'SIGINT');
  const r = await pending;
  try {
    assert.equal(seen.signal.aborted, true);
    assert.equal(r.code, 130);
    assert.deepEqual(r.out, []);
    assert.equal(signals.listenerCount('SIGINT'), 0, 'the handlers are removed');
  } finally { r.cleanup(); }
});

test('a lease of the iPad lane\'s own words from a linux CLI keeps its v1 behaviour, and a deploy-job id is still refused before any forward', async () => {
  const job = await run(['release', 'job:acme/app/1/build', '--resource', 'ios-lane'], { key: 'linux' });
  try {
    assert.equal(job.calls.length, 0);
    assert.equal(job.code, 2);
    assert.match(job.err.join('\n'), /HUB_DEVICE_JOB_ID/);
  } finally { job.cleanup(); }
});
