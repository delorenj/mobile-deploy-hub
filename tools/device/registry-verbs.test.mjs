// Story 6.8: `hub-device registry add|edit|retire|list` through main(), with a fetchImpl that routes into the Hub API's handle() over the
// same temp lock dir. No port is bound, globalThis.fetch is never reached and the QA file is never opened (the QA phones are made-up serials).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadDevices } from '../ci/lib/devices.mjs';
import { acquireLease, releaseLease } from '../ci/lib/lock.mjs';
import { loadPolicy } from '../ci/lib/policy.mjs';
import { hermetic } from '../ci/test-fixtures.mjs';
import { registryPath } from '../registry/store.mjs';
import { ROUTES, handle } from '../hub-api/routes.mjs';
import { main, parseArgs } from './hub-device.mjs';

hermetic();

const policy = loadPolicy().policy;
const NOW = () => Date.parse('2026-11-25T10:00:00Z');
const S24_SERIAL = 'R5CX31AEJDA';
const PHONE_SERIAL = 'QAPIXEL7777';
const qa = [{ name: 'S24', serial: S24_SERIAL, allowed_users: [0, 10] }, { name: 'Pixel-QA', model: 'Pixel 7', serial: PHONE_SERIAL, allowed_users: [0] }];
const DOWN = 'HUB_API_DOWN the Hub API is not answering; registry changes are unavailable, holds still work';

function scratch() {
  const root = mkdtempSync(join(tmpdir(), 'hub-registry-verbs-'));
  const env = { PATH: process.env.PATH, HOME: root, USER: 'tester', HUB_LOCK_DIR: join(root, 'locks'), HUB_EVENT_DIR: join(root, 'events') };
  const devices = structuredClone(loadDevices({}));
  const calls = [];
  const apiCtx = { env, policy, routes: ROUTES, now: NOW, hostId: 'test-host', devices, qaDevices: () => qa, log: { out: () => {}, err: () => {} } };
  // The in-process Hub API: GET /health and every route, answered as a Response.
  const fetchImpl = async (url, init = {}) => {
    const target = new URL(url);
    calls.push(`${init.method} ${target.pathname}`);
    const answer = await handle({ method: init.method, url: target.pathname + target.search, body: init.body === undefined ? undefined : JSON.parse(init.body) }, apiCtx);
    return new Response(JSON.stringify(answer.body), { status: answer.status, headers: answer.headers });
  };
  const run = async (argv, extra = {}) => {
    const out = [];
    const err = [];
    const code = await main(argv, { env, stdout: line => out.push(line), stderr: line => err.push(line), policy, qaDevices: () => qa, fetchImpl, hostKey: () => 'linux', ...extra });
    return { code, out, err };
  };
  return {
    root, env, calls, run,
    file: () => JSON.parse(readFileSync(registryPath(env), 'utf8')),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

const ADD = ['registry', 'add', '--kind', 'phone', '--name', 'pixel', '--model', 'Pixel 9', '--cap', 'api_level=35', '--holder', 'tester'];

test('add: prints the id, name and rev; the file holds the number capability and the cli actor; --json prints the 201 body', async () => {
  const s = scratch();
  try {
    const added = await s.run(ADD);
    assert.equal(added.code, 0, added.err.join('\n'));
    assert.match(added.out[0], /^HUB_DEVICE_REGISTERED res-pixel pixel$/);
    assert.match(added.out[1], /^HUB_DEVICE_REV \d+$/);
    const record = s.file().resources.find(entry => entry.id === 'res-pixel');
    assert.equal(record.capabilities.api_level, 35);
    assert.equal(record.host, 'linux', '--host defaults to this host key');
    assert.deepEqual(record.identity, { model: 'Pixel 9' });
    const json = await s.run(['registry', 'add', '--kind', 'phone', '--name', 'pixel-b', '--model', 'Pixel 8', '--host', 'linux', '--json', '--holder', 'tester', '--why', 'second']);
    assert.equal(json.out.length, 1);
    const body = JSON.parse(json.out[0]);
    assert.deepEqual([body.source, body.resource.id], ['file', 'res-pixel-b']);
    assert.equal(s.file().rev, body.rev);
  } finally { s.cleanup(); }
});

test('add: the actor of the event is the holder with via cli', async () => {
  const s = scratch();
  try {
    await s.run(ADD);
    const { readEvents } = await import('../ci/lib/events.mjs');
    const events = [...readEvents({ env: s.env })].filter(event => event.event === 'registry-add');
    assert.deepEqual(events.at(-1).actor, { holder: 'tester', via: 'cli' });
    // Without --holder it is $HUB_DEVICE_HOLDER, then user@hostname.
    const named = await s.run(['registry', 'add', '--kind', 'phone', '--name', 'p2', '--model', 'm'], { env: { ...s.env, HUB_DEVICE_HOLDER: 'agent-7' } });
    assert.equal(named.code, 0, named.err.join('\n'));
    assert.equal([...readEvents({ env: s.env })].filter(event => event.event === 'registry-add').at(-1).actor.holder, 'agent-7');
  } finally { s.cleanup(); }
});

test('list: after an add it reads the file with no fetchImpl at all; with no file it is the seed', async () => {
  const s = scratch();
  try {
    const seed = await s.run(['registry', 'list'], { fetchImpl: () => assert.fail('list called the API') });
    assert.equal(seed.code, 0, seed.err.join('\n'));
    assert.equal(seed.out[0], 'REGISTRY rev 0 (seed)');
    assert.ok(seed.out.some(line => /^\s+s24\s/.test(line)) && seed.out.some(line => /^\s+s26\s/.test(line) && /deploy target/.test(line) && /seeded/.test(line)));
    assert.ok(seed.out.includes('POOLS'));
    assert.ok(seed.out.some(line => /^\s+phone\s+named\s+s24,s26/.test(line)), seed.out.join('\n'));
    await s.run(ADD);
    const listed = await s.run(['registry', 'list'], { fetchImpl: () => assert.fail('list called the API') });
    assert.match(listed.out[0], /^REGISTRY rev \d+ \(file\)$/);
    const line = listed.out.find(entry => /^\s+res-pixel\s/.test(entry));
    assert.match(line, /pixel\s+phone\s+linux\s+lock res-pixel\s+Pixel 9\s+caps api_level=35/);
    const json = await s.run(['registry', 'list', '--json'], { fetchImpl: undefined });
    const body = JSON.parse(json.out[0]);
    assert.deepEqual(Object.keys(body), ['rev', 'source', 'resources', 'pools']);
    assert.equal(body.source, 'file');
    assert.ok(body.resources.some(resource => resource.id === 'res-pixel'));
  } finally { s.cleanup(); }
});

test('edit: renames, sets and removes capabilities, rev +1; without --if-rev it uses the rev on disk', async () => {
  const s = scratch();
  try {
    await s.run([...ADD, '--cap', 'old=x']);
    const before = s.file().rev;
    const edited = await s.run(['registry', 'edit', 'res-pixel', '--name', 'pixel-9', '--cap', 'api_level=36', '--uncap', 'old', '--holder', 'tester']);
    assert.equal(edited.code, 0, edited.err.join('\n'));
    assert.equal(edited.out[0], 'HUB_DEVICE_EDITED res-pixel pixel-9');
    assert.equal(edited.out[1], `HUB_DEVICE_REV ${before + 1}`);
    const record = s.file().resources.find(entry => entry.id === 'res-pixel');
    assert.deepEqual([record.name, record.capabilities.api_level, 'old' in record.capabilities], ['pixel-9', 36, false]);
    // A stale --if-rev is the API's conflict: its own exit (1), one line.
    const stale = await s.run(['registry', 'edit', 'res-pixel', '--name', 'zzz', '--if-rev', '1', '--holder', 'tester']);
    assert.equal(stale.code, 1);
    assert.match(stale.err[0], /^HUB_REGISTRY_CONFLICT registry .+ \(reason: hub_registry_conflict\)$/);
    assert.equal(stale.err.length, 1);
  } finally { s.cleanup(); }
});

test('edit with no registry file sends if_rev 0 (the seed materialises)', async () => {
  const s = scratch();
  try {
    const edited = await s.run(['registry', 'edit', 's24', '--cap', 'lab=a', '--holder', 'tester']);
    assert.equal(edited.code, 0, edited.err.join('\n'));
    assert.equal(edited.out[0], 'HUB_DEVICE_EDITED s24 s24');
  } finally { s.cleanup(); }
});

test('retire: a registered Resource is hidden; --json prints the body; the same answer twice', async () => {
  const s = scratch();
  try {
    await s.run(ADD);
    const retired = await s.run(['registry', 'retire', 'res-pixel', '--holder', 'tester', '--why', 'gone']);
    assert.equal(retired.code, 0, retired.err.join('\n'));
    assert.equal(retired.out[0], 'HUB_DEVICE_RETIRED res-pixel hidden');
    assert.match(retired.out[1], /^HUB_DEVICE_REV \d+$/);
    const again = await s.run(['registry', 'retire', 'res-pixel', '--holder', 'tester', '--json']);
    assert.equal(JSON.parse(again.out[0]).visibility, 'hidden');
    // A seeded one is refused with the API's exit (2).
    const seeded = await s.run(['registry', 'retire', 's24', '--holder', 'tester']);
    assert.equal(seeded.code, 2);
    assert.match(seeded.err[0], /^HUB_REGISTRY_SEEDED registry .+ \(reason: retire\)$/);
    // It no longer lists.
    const listed = await s.run(['registry', 'list']);
    assert.ok(!listed.out.some(line => /res-pixel\s/.test(line)), listed.out.join('\n'));
  } finally { s.cleanup(); }
});

test('an API refusal is one stderr line with its own exit; --json also prints the problem body', async () => {
  const s = scratch();
  try {
    const refused = await s.run(['registry', 'add', '--kind', 'phone', '--name', 's26', '--model', 'x', '--holder', 'tester']);
    assert.equal(refused.code, 2);
    assert.equal(refused.err.length, 1);
    assert.match(refused.err[0], /^HUB_REGISTRY_NAME registry .+ \(reason: reserved\)$/);
    assert.deepEqual(refused.out, []);
    const json = await s.run(['registry', 'add', '--kind', 'phone', '--name', 's26', '--model', 'x', '--holder', 'tester', '--json']);
    assert.equal(json.code, 2);
    const problem = JSON.parse(json.out[0]);
    assert.deepEqual([problem.code, problem.exit, problem.reason], ['HUB_REGISTRY_NAME', 2, 'reserved']);
    // A duplicate names its holder in the problem.
    await s.run([...ADD, '--serial', 'PX9']);
    const dup = await s.run(['registry', 'add', '--kind', 'phone', '--name', 'other', '--model', 'm', '--serial', 'PX9', '--holder', 'tester', '--json']);
    assert.equal(dup.code, 2);
    assert.equal(JSON.parse(dup.out[0]).holder, 'res-pixel');
  } finally { s.cleanup(); }
});

test('a refused connect is HUB_API_DOWN, exit 1, and only /health was tried; list still works', async () => {
  const s = scratch();
  try {
    let calls = 0;
    const fetchImpl = async () => { calls += 1; throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }); };
    for (const argv of [ADD, ['registry', 'edit', 's24', '--cap', 'a=1', '--holder', 'x'], ['registry', 'retire', 'res-x', '--holder', 'x']]) {
      calls = 0;
      const result = await s.run(argv, { fetchImpl });
      assert.equal(result.code, 1);
      assert.deepEqual(result.err, [DOWN]);
      assert.equal(calls, 1, 'only /health');
    }
    assert.equal((await s.run(['registry', 'list'], { fetchImpl })).code, 0);
    assert.equal(calls, 1, 'list sent nothing');
  } finally { s.cleanup(); }
});

test('a silent /health is HUB_API_DOWN and the write is never sent; a write that times out is HUB_API_UNKNOWN', async () => {
  const s = scratch();
  try {
    const sent = [];
    const bounds = [];
    const hang = (url, init) => new Promise((_, reject) => { if (init.signal.aborted) reject(init.signal.reason); init.signal.addEventListener('abort', () => reject(init.signal.reason)); });
    const silent = await s.run(ADD, { fetchImpl: (url, init) => { sent.push(new URL(url).pathname); return hang(url, init); }, timeout: ms => { bounds.push(ms); return AbortSignal.abort(new Error('timed out')); } });
    assert.equal(silent.code, 1);
    assert.deepEqual(silent.err, [DOWN]);
    assert.deepEqual(sent, ['/health']);
    assert.deepEqual(bounds, [2000]);
    // Health answers; the POST aborts on its timeout.
    sent.length = 0;
    bounds.length = 0;
    const timed = await s.run(ADD, {
      fetchImpl: (url, init) => {
        const path = new URL(url).pathname;
        sent.push(path);
        return path === '/health' ? Promise.resolve(new Response(JSON.stringify({ ok: true, service: 'mobile-deploy-hub-api' }), { status: 200 })) : hang(url, init);
      },
      timeout: ms => { bounds.push(ms); return ms === 2000 ? new AbortController().signal : AbortSignal.abort(new Error('timed out')); },
    });
    assert.equal(timed.code, 1);
    assert.match(timed.err[0], /^HUB_API_UNKNOWN the Hub API did not answer after the request was sent; the change may have applied: run `hub-device registry list` to see$/);
    assert.deepEqual(sent, ['/health', '/registry/resources']);
    assert.deepEqual(bounds, [2000, 30_000]);
  } finally { s.cleanup(); }
});

test('flags belong to their commands: every other command refuses the registry flags, and a registry verb refuses what is not its own', async () => {
  const s = scratch();
  try {
    const refuse = async (argv, flag) => {
      const result = await s.run(argv, { fetchImpl: () => assert.fail('nothing is sent') });
      assert.equal(result.code, 2, argv.join(' '));
      assert.deepEqual(result.err, [`hub-device: unknown flag --${flag}`], argv.join(' '));
    };
    await refuse(['lease', 's24', '--kind', 'phone', '--for', '1m', '--why', 'x'], 'kind');
    await refuse(['status', '--cap', 'a=1'], 'cap');
    await refuse(['status', '--uncap', 'a'], 'uncap');
    await refuse(['release', '--if-rev', '3'], 'if-rev');
    await refuse(['discover', '--model', 'm'], 'model');
    await refuse(['run', 's24', '--serial', 'x', '--', 'true'], 'serial');
    await refuse(['lease', 's24', '--udid', 'x'], 'udid');
    await refuse(['status', '--host', 'linux'], 'host');
    await refuse(['lease', 's24', '--name', 'x'], 'name');
    await refuse(['status', '--run', 'x'], 'run');
    await refuse(['status', '--match', 'a=1'], 'match');
    await refuse(['registry', 'list', '--for', '1m'], 'for');
    await refuse(['registry', 'list', '--cap', 'a=1'], 'cap');
    await refuse(['registry', 'retire', 'res-x', '--name', 'n'], 'name');
    await refuse(['registry', 'retire', 'res-x', '--cap', 'a=1'], 'cap');
    await refuse(['registry', 'edit', 'res-x', '--kind', 'phone'], 'kind');
    await refuse(['registry', 'edit', 'res-x', '--model', 'm'], 'model');
    await refuse(['registry', 'add', '--uncap', 'a'], 'uncap');
    await refuse(['registry', 'add', '--wait', '1m'], 'wait');
    await refuse(['registry', 'add', '--env-serial', 'A'], 'env-serial');
    // `--name` still belongs to `reservation release`.
    const reservation = await s.run(['reservation', 'release', '--run', 'o--r--1', '--name', 'adb']);
    assert.equal(reservation.code, 0);
  } finally { s.cleanup(); }
});

test('bad input is a usage error (exit 2) and nothing is sent', async () => {
  const s = scratch();
  try {
    const usage = async argv => {
      const result = await s.run(argv, { fetchImpl: () => assert.fail('nothing is sent') });
      assert.equal(result.code, 2, argv.join(' '));
      assert.match(result.err[0], /^hub-device: /, argv.join(' '));
      assert.deepEqual(result.out, []);
    };
    const base = ['registry', 'add', '--kind', 'phone', '--name', 'p', '--model', 'm'];
    await usage([...base, '--cap', 'api_level']);
    await usage([...base, '--cap', 'k=']);
    await usage([...base, '--cap', '=v']);
    await usage([...base, '--cap', 'a=1', '--cap', 'a=2']);
    await usage(['registry', 'edit', 'res-p', '--cap', 'a=1', '--uncap', 'a']);
    await usage(['registry', 'edit', 'res-p', '--if-rev', 'x']);
    await usage(['registry', 'edit', 'res-p', '--if-rev', '-1']);
    await usage(['registry', 'edit', 'res-p', '--if-rev', '1.5']);
    await usage(['registry', 'edit']);
    await usage(['registry', 'retire']);
    await usage(['registry', 'retire', 'a', 'b']);
    await usage(['registry', 'add', '--name', 'p']);
    await usage(['registry', 'add', '--kind', 'phone']);
    await usage(['registry', 'list', 'extra']);
    await usage(['registry']);
    await usage(['registry', 'delete']);
    // Both flags given twice for the same key to --uncap is not a conflict.
    const twice = await s.run(['registry', 'edit', 's24', '--uncap', 'lab', '--uncap', 'lab', '--holder', 'x']);
    assert.equal(twice.code, 0, twice.err.join('\n'));
  } finally { s.cleanup(); }
});

test('--cap takes true and false as booleans, numbers as numbers, anything else as a string', async () => {
  const s = scratch();
  try {
    const added = await s.run([...ADD.slice(0, -2), '--holder', 'tester', '--cap', 'rooted=true', '--cap', 'locked=false', '--cap', 'ratio=1.5', '--cap', 'delta=-3', '--cap', 'label=a=b', '--cap', 'zero=007x', '--cap', 'build=0123', '--cap', 'ver=1.10', '--cap', 'big=12345678901234567890', '--cap', 'huge=1e999', '--cap', 'plus=+5']);
    assert.equal(added.code, 0, added.err.join('\n'));
    const caps = s.file().resources.find(entry => entry.id === 'res-pixel').capabilities;
    assert.deepEqual(caps, { api_level: 35, rooted: true, locked: false, ratio: 1.5, delta: -3, label: 'a=b', zero: '007x', build: '0123', ver: '1.10', big: '12345678901234567890', huge: '1e999', plus: '+5' });
  } finally { s.cleanup(); }
});

test('add without --host needs this host to know its key (HUB_HOST_UNKNOWN, exit 1)', async () => {
  const s = scratch();
  try {
    const unknown = await s.run(ADD, { hostKey: () => { throw Object.assign(new Error('this host does not know which host it is'), { code: 'HUB_HOST_UNKNOWN' }); }, fetchImpl: () => assert.fail('nothing is sent') });
    assert.equal(unknown.code, 1);
    assert.match(unknown.err[0], /does not know which host it is/);
    // --host names it, so the key is never asked.
    const given = await s.run([...ADD, '--host', 'linux'], { hostKey: () => assert.fail('asked') });
    assert.equal(given.code, 0, given.err.join('\n'));
  } finally { s.cleanup(); }
});

test('QA serials: a QA phone seeded into the file shows its serial in the local list, and in no API answer', async () => {
  const s = scratch();
  try {
    const answers = [];
    const track = async argv => { const result = await s.run(argv); answers.push(...result.out, ...result.err); return result; };
    // The first write creates the file with the QA phones imported.
    const added = await track([...ADD.slice(0, -2), '--holder', 'tester', '--serial', 'PX9', '--cap', 'dedicated_qa=true', '--json']);
    assert.equal(added.code, 0, added.err.join('\n'));
    assert.equal(JSON.parse(added.out[0]).resource.identity.serial, null, 'a dedicated_qa add is redacted in the answer');
    await track(['registry', 'edit', 'res-pixel', '--cap', 'lab=a', '--holder', 'tester', '--json']);
    await track(['registry', 'retire', 'res-pixel', '--holder', 'tester', '--json']);
    await track(['registry', 'add', '--kind', 'phone', '--name', 's26', '--model', 'x', '--holder', 'tester', '--json']);
    for (const serial of [S24_SERIAL, PHONE_SERIAL, 'PX9']) assert.ok(!answers.join('\n').includes(serial), `${serial} reached an API answer`);
    const list = await s.run(['registry', 'list', '--json']);
    const listed = JSON.parse(list.out[0]);
    const imported = listed.resources.find(resource => resource.identity?.serial === PHONE_SERIAL);
    assert.ok(imported, 'the seed-imported QA phone shows its serial to the local reader');
    assert.ok(!JSON.stringify(listed).includes('allowed_users'));
    // And the API's own read of the same file hides it.
    const served = await handle({ method: 'GET', url: '/resources' }, { env: s.env, policy, routes: ROUTES, now: NOW, hostId: 'h', devices: loadDevices({}), qaDevices: () => qa, log: { out: () => {}, err: () => {} } });
    assert.ok(!JSON.stringify(served.body).includes(PHONE_SERIAL));
  } finally { s.cleanup(); }
});

test('parseArgs: --cap and --uncap repeat into arrays and leave flags and envSerial alone', () => {
  const parsed = parseArgs(['registry', 'edit', 'res-x', '--cap', 'a=1', '--cap=b=2', '--uncap', 'c', '--env-serial', 'S', '--name', 'n']);
  assert.deepEqual(parsed.cap, ['a=1', 'b=2']);
  assert.deepEqual(parsed.uncap, ['c']);
  assert.deepEqual(parsed.envSerial, ['S']);
  assert.deepEqual(parsed.flags, { name: 'n' });
  assert.deepEqual(parseArgs(['status']).cap, []);
});

test('a key that is a prototype name reaches the API and is refused (exit 2), never swallowed', async () => {
  const s = scratch();
  try {
    const cap = await s.run([...ADD.slice(0, -2), '--holder', 'tester', '--cap', '__proto__=1']);
    assert.equal(cap.code, 2);
    assert.match(cap.err[0], /^HUB_USAGE registry .+ \(reason: bad-capabilities\)$/);
    const uncap = await s.run(['registry', 'edit', 's24', '--uncap', '__proto__', '--holder', 'tester']);
    assert.equal(uncap.code, 2);
    assert.match(uncap.err[0], /\(reason: bad-capabilities\)$/);
  } finally { s.cleanup(); }
});

test('list: a retired Resource whose lock is held is [retiring], and gone from the list once the lock is idle', async () => {
  const s = scratch();
  try {
    await s.run(ADD);
    const held = await acquireLease('res-pixel', { holder: 'agent-a', why: 'proof', forMs: 60_000, env: s.env, log: () => {}, pollMs: 5, hostId: 'test-host' });
    const retired = await s.run(['registry', 'retire', 'res-pixel', '--holder', 'tester']);
    assert.equal(retired.out[0], 'HUB_DEVICE_RETIRED res-pixel retiring');
    const listed = await s.run(['registry', 'list']);
    assert.match(listed.out.find(line => /^\s+res-pixel\s/.test(line)), /\[retiring\]$/);
    const json = JSON.parse((await s.run(['registry', 'list', '--json'])).out[0]);
    assert.equal(json.resources.find(resource => resource.id === 'res-pixel').visibility, 'retiring');
    assert.equal(releaseLease('res-pixel', held.lease_id, { env: s.env, hostId: 'test-host' }).released, true);
    assert.ok(!(await s.run(['registry', 'list'])).out.some(line => /^\s+res-pixel\s/.test(line)));
  } finally { s.cleanup(); }
});
