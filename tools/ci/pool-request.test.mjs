// Story 5.8 (AD-33): a Pool request that holds a place in line (lock.mjs acquirePool). Hermetic: temp lock and event dirs and a fake
// clock driven through the injected `sleep`; the one real-process test kills a child waiter with SIGKILL.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { earliest, eta, formatEta } from './lib/eta.mjs';
import { readEvents } from './lib/events.mjs';
import { ETA_REFRESH_MS, acquireLease, acquirePool, etaHistory, queueView, readOwner, releaseLease } from './lib/lock.mjs';
import { hermetic } from './test-fixtures.mjs';

hermetic(); // offline, outside any workflow job, scratch HUB_EVENT_DIR and HUB_LOCK_DIR (test-fixtures.mjs)

const MIN = 60_000;
const MEMBERS = ['s24', 'adb'];
const policyOf = () => ({ queue: { deploy_target_lease_max_min: 60, eta_window_days: 30, eta_low_data_min_holds: 20, hold_allowance_min: { android: 15 } } });
const lockModule = fileURLToPath(new URL('./lib/lock.mjs', import.meta.url));

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'hub-pool-request-'));
  const env = { HUB_LOCK_DIR: join(root, 'locks'), HUB_EVENT_DIR: join(root, 'events') };
  let clock = Date.now();
  const f = {
    root, env, now: () => clock, advance: ms => { clock += ms; },
    events: () => [...readEvents({ env })],
    queue: name => { try { return readdirSync(join(env.HUB_LOCK_DIR, `${name}.queue`)).sort(); } catch { return []; } },
    tickets: name => f.queue(name).filter(file => file.endsWith('.json')),
    ticket: (name, file) => JSON.parse(readFileSync(join(env.HUB_LOCK_DIR, `${name}.queue`, file), 'utf8')),
    hold: (name, id, forMs = 30 * MIN) => acquireLease(name, { holder: `holder-${id}`, why: 'device proof', forMs, id, env, log: () => {}, now: f.now, policy: policyOf() }),
    free: (name, id) => releaseLease(name, id, { env, now: f.now }),
    owner: name => readOwner(join(env.HUB_LOCK_DIR, `${name}.lock`)),
    pool: (options = {}) => acquirePool('phone', MEMBERS, {
      holder: 'pooler', why: 'any phone', forMs: 5 * MIN, id: 'req', env, log: () => {}, now: f.now, policy: policyOf(), pollMs: 1000, sleep: async ms => f.advance(ms), ...options,
    }),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
  return f;
}
const shape = events => events.map(event => [event.event, event.lock, event.reason ?? null]);
const waitLines = logs => logs.filter(line => line.startsWith('HUB_LOCK_WAIT'));
const settle = ms => new Promise(done => setTimeout(done, ms));
const until = async (check, what) => {
  for (let tries = 0; tries < 1000; tries += 1) { if (check()) return; await settle(10); }
  assert.fail(`never happened: ${what}`);
};

test('a try takes the first member in preference order, writes no ticket and no eta, and leaves nothing in any queue', async () => {
  const f = fixture();
  try {
    const won = await f.pool();
    assert.equal(won.name, 's24', 'both free: the first member in preference order');
    assert.equal(won.record.lease_id, 'req');
    assert.equal(won.value, undefined);
    assert.deepEqual([f.queue('s24'), f.queue('adb')], [[], []], 'a try is not a place in line');
    const [request, acquire] = f.events();
    assert.deepEqual([request.event, request.pool, request.request, request.lock], ['request', 'phone', 'req', null]);
    assert.equal(Object.hasOwn(request, 'eta'), false, 'a try has no eta key');
    assert.deepEqual([acquire.event, acquire.lock, acquire.pool, acquire.request], ['acquire', 's24', 'phone', 'req']);
    assert.equal(f.events().length, 2);
    assert.match(String(readOwner(join(f.env.HUB_LOCK_DIR, 's24.lock')).lock_ino), /^\d+$/, 'the owner record carries its lock inode, as acquireLease writes it');
  } finally { f.cleanup(); }
});

test('the first member held: the second is taken at once and the first one\'s ticket is withdrawn with no event', async () => {
  const f = fixture();
  try {
    await f.hold('s24', 'on-s24');
    const mark = f.events().length;
    const won = await f.pool({ waitMs: 10 * MIN });
    assert.equal(won.name, 'adb');
    assert.deepEqual([f.tickets('s24'), f.tickets('adb')], [[], []], 'no ticket is left in any queue');
    assert.deepEqual(shape(f.events().slice(mark)), [['request', null, null], ['acquire', 'adb', null]], 'one request, one acquire, and no cancel for the withdrawn ticket');
    assert.ok(f.events().slice(mark).every(event => event.pool === 'phone' && event.request === 'req'));
    assert.deepEqual(f.owner('s24').lease_id, 'on-s24');
  } finally { f.cleanup(); }
});

test('both held: the same ticket stands in every queue, one wait line prints, and the member that frees first serves it', async () => {
  for (const [freed, other] of [['adb', 's24'], ['s24', 'adb']]) {
    const f = fixture();
    try {
      await f.hold('s24', 'on-s24', 10 * MIN);
      await f.hold('adb', 'on-adb', 30 * MIN);
      const logs = [];
      const seen = [];
      let polls = 0;
      const sleep = async ms => {
        f.advance(ms);
        polls += 1;
        if (polls === 1) seen.push([f.tickets('s24'), f.tickets('adb')]);
        if (polls === 3) f.free(freed, `on-${freed}`);
      };
      const won = await f.pool({ waitMs: 5 * MIN, log: line => logs.push(line), sleep });
      assert.equal(won.name, freed);
      const [[a], [b]] = seen[0];
      assert.equal(a, b, 'the identical ticket file name in every member\'s queue');
      assert.equal(seen[0][0].length + seen[0][1].length, 2);
      assert.deepEqual([f.tickets('s24'), f.tickets('adb')], [[], []], 'no Pool ticket remains in any queue');
      const lines = waitLines(logs);
      assert.equal(lines.length, 1, lines.join('\n'));
      assert.match(lines[0], /^HUB_LOCK_WAIT phone held by lease on-s24 of holder-on-s24 \(device proof\) until \S+ position=1 eta=0s-\d+m low-data$/, 'the member with the fewest blockers ahead, first on a tie');
      assert.deepEqual(shape(f.events().filter(event => event.request === 'req')).map(([event, lock]) => [event, lock]), [['request', null], ['acquire', freed]], `served by ${freed}, not ${other}`);
    } finally { f.cleanup(); }
  }
});

test('the ticket and the request carry the identical Pool ETA: the earliest of the members\' own', async () => {
  const f = fixture();
  try {
    await f.hold('s24', 'on-s24', 10 * MIN);
    await f.hold('adb', 'on-adb', 40 * MIN);
    const at = f.now();
    const deadline = at + 5 * MIN;
    const own = name => eta({ owner: f.owner(name), view: [], file: null, deadline_at: deadline }, [], policyOf(), at);
    const expected = earliest(MEMBERS.map(own));
    assert.notDeepEqual(own('s24'), own('adb'));
    let tickets = null;
    let polls = 0;
    const sleep = async ms => { f.advance(ms); polls += 1; if (polls === 1) tickets = MEMBERS.map(name => f.ticket(name, f.tickets(name)[0])); if (polls === 2) f.free('s24', 'on-s24'); };
    await f.pool({ waitMs: 5 * MIN, sleep });
    assert.deepEqual(tickets[0].eta, expected);
    assert.deepEqual(tickets[1], tickets[0], 'the two tickets are the same body');
    assert.deepEqual([tickets[0].pool, tickets[0].request, tickets[0].lease_id, tickets[0].kind], ['phone', 'req', 'req', 'lease']);
    assert.deepEqual(f.events().find(event => event.event === 'request').eta, expected);
    assert.equal(formatEta(expected), '0s-10m low-data');
  } finally { f.cleanup(); }
});


test('the wait line stands at the held member with the fewest blockers ahead: a waiter queued ahead on the s24 makes it the adb', async () => {
  const f = fixture();
  try {
    await f.hold('s24', 'on-s24');
    await f.hold('adb', 'on-adb');
    // a single Lease waiter queued on the s24 first; its first pass writes the ticket, then it never wakes (a sleep that never ends)
    void acquireLease('s24', { holder: 'single', why: 'queued first', forMs: 5 * MIN, waitMs: 60 * MIN, id: 'single', env: f.env, log: () => {}, now: f.now, policy: policyOf(), sleep: () => new Promise(() => {}) });
    assert.equal(f.tickets('s24').length, 1);
    const logs = [];
    let polls = 0;
    const won = await f.pool({ waitMs: 5 * MIN, log: line => logs.push(line), sleep: async ms => { f.advance(ms); polls += 1; if (polls === 2) f.free('adb', 'on-adb'); } });
    assert.equal(won.name, 'adb');
    const lines = waitLines(logs);
    assert.equal(lines.length, 1, lines.join('\n'));
    assert.match(lines[0], /^HUB_LOCK_WAIT phone held by lease on-adb of holder-on-adb \(device proof\) until \S+ position=1 eta=/, 'adb has nobody ahead (position 1); the s24 has one waiter ahead');
  } finally { f.cleanup(); }
});

test('a waiting Pool request recomputes its combined ETA after ETA_REFRESH_MS and prints the moved range with the earliest member\'s ETA', async () => {
  const f = fixture();
  try {
    // the earliest member is the second one, so taking the first member's ETA would be wrong
    await f.hold('s24', 'on-s24', 55 * MIN);
    await f.hold('adb', 'on-adb', 20 * MIN);
    const logs = [];
    const recomputed = [];
    let polls = 0;
    let file = null;
    const POLL = MIN;
    const sleep = async ms => {
      f.advance(ms);
      polls += 1;
      file ??= f.tickets('s24')[0];
      if (polls === 7) f.free('adb', 'on-adb');
    };
    const afterEta = () => {
      // the members' freshly computed ETAs, from the same clock the request used for this recompute
      const at = f.now();
      const events = etaHistory({ env: f.env, now: at, policy: policyOf() });
      const own = name => eta({ owner: f.owner(name), view: queueView(name, { env: f.env, now: () => at }), file, deadline_at: at + 60 * MIN }, events, policyOf(), at);
      recomputed.push({ at, own: MEMBERS.map(own) });
    };
    const won = await f.pool({ waitMs: 60 * MIN, pollMs: POLL, log: line => logs.push(line), sleep, afterEta });
    assert.equal(won.name, 'adb');
    assert.equal(recomputed.length, 1, 'one recompute, once ETA_REFRESH_MS has passed');
    assert.ok(polls * POLL >= ETA_REFRESH_MS);
    const lines = waitLines(logs);
    assert.equal(lines.length, 2, lines.join('\n'));
    assert.match(lines[0], /eta=0s-20m low-data$/);
    assert.equal(lines[1].split(' eta=')[1], formatEta(earliest(recomputed[0].own)), 'the second line is the earliest of the members\' fresh ETAs');
    assert.notEqual(lines[1].split(' eta=')[1], lines[0].split(' eta=')[1]);
    assert.ok(recomputed[0].own[1].hi_ms < recomputed[0].own[0].hi_ms, 'the two members differ, so earliest() decides');
  } finally { f.cleanup(); }
});

test('FIFO: a single waiter queued before the Pool gets the lock that frees; the Pool keeps waiting and takes the other', async () => {
  const f = fixture();
  try {
    await f.hold('s24', 'on-s24');
    await f.hold('adb', 'on-adb');
    // real time here: two concurrent waiters polling at 5 ms
    const real = { now: Date.now, sleep: undefined };
    const single = acquireLease('adb', { holder: 'single', why: 'queued first', forMs: 5 * MIN, waitMs: 60 * MIN, id: 'single', env: f.env, log: () => {}, pollMs: 5, now: real.now, policy: policyOf() });
    await until(() => f.tickets('adb').length === 1, 'the single waiter is queued');
    const logs = [];
    const pooled = f.pool({ waitMs: 60 * MIN, pollMs: 5, now: real.now, log: line => logs.push(line), sleep: ms => settle(ms) });
    await until(() => f.tickets('s24').length === 1 && f.tickets('adb').length === 2, 'the Pool request queued behind it');
    f.free('adb', 'on-adb');
    const got = await single;
    assert.equal(got.lease_id, 'single', 'when adb frees, the earlier waiter gets adb');
    await until(() => waitLines(logs).length >= 1, 'the Pool printed its wait line');
    assert.ok(waitLines(logs).every(line => /position=1 /.test(line)), `the request stands first on the s24, where nothing is ahead of it: ${waitLines(logs).join(' | ')}`);
    await settle(60);
    assert.equal(f.owner('adb').lease_id, 'single', 'the Pool did not take adb');
    assert.equal(f.tickets('s24').length, 1, 'and it kept waiting');
    f.free('s24', 'on-s24');
    const won = await pooled;
    assert.equal(won.name, 's24');
    assert.deepEqual([f.tickets('s24'), f.tickets('adb')], [[], []]);
  } finally { f.cleanup(); }
});

test('a Lease try is blocked by the Pool request that waits in the lock\'s queue, and the request then takes the lock', async () => {
  const f = fixture();
  try {
    await f.hold('s24', 'on-s24');
    await f.hold('adb', 'on-adb');
    let polls = 0;
    let tried = null;
    const sleep = async ms => {
      f.advance(ms);
      polls += 1;
      if (polls === 1) {
        f.free('adb', 'on-adb');
        // adb is free, but a Pool request stands in its queue: a later try cannot jump it
        tried = await acquireLease('adb', { holder: 'late', why: 'try', forMs: MIN, waitMs: 0, id: 'late', env: f.env, log: () => {}, now: f.now, policy: policyOf() }).catch(error => error);
      }
    };
    const won = await f.pool({ waitMs: 5 * MIN, sleep });
    assert.equal(tried.code, 'HUB_LOCK_TIMEOUT');
    assert.equal(won.name, 'adb', 'the request took the lock the late try could not');
  } finally { f.cleanup(); }
});

test('withdrawal: the winner renames each other ticket to a tomb (no event), and a ticket cancelled first is ENOENT, not an error', async () => {
  const f = fixture();
  try {
    await f.hold('s24', 'on-s24');
    await f.hold('adb', 'on-adb');
    const seams = [];
    let polls = 0;
    const sleep = async ms => { f.advance(ms); polls += 1; if (polls === 2) f.free('s24', 'on-s24'); };
    const won = await f.pool({
      waitMs: 5 * MIN, sleep,
      beforeWithdraw: name => {
        seams.push([name, f.queue(name).filter(file => file.endsWith('.json')).length]);
        // the race: a release cancels this ticket just before the winner's rename
        if (name === 'adb') rmSync(join(f.env.HUB_LOCK_DIR, 'adb.queue', f.tickets('adb')[0]));
      },
    });
    assert.equal(won.name, 's24');
    assert.deepEqual(seams, [['adb', 1]], 'only the other member\'s ticket is withdrawn: the winner\'s own was claimed');
    assert.deepEqual(f.queue('adb'), [], 'no ticket and no tomb is left behind');
    assert.deepEqual(shape(f.events().filter(event => event.request === 'req')).map(([event]) => event), ['request', 'acquire'], 'a withdrawal writes no event');
  } finally { f.cleanup(); }
});

test('cancel: releasing the request while it waits removes every ticket, and the request writes its one Pool cancel (released)', async () => {
  const f = fixture();
  try {
    await f.hold('s24', 'on-s24');
    await f.hold('adb', 'on-adb');
    let polls = 0;
    const sleep = async ms => {
      f.advance(ms);
      polls += 1;
      if (polls === 2) {
        const result = releaseLease('adb', 'req', { env: f.env, now: f.now });
        assert.equal(result.cancelled, 1);
      }
    };
    await assert.rejects(f.pool({ waitMs: 5 * MIN, sleep }), error => error.code === 'HUB_LEASE_CANCELLED');
    assert.deepEqual([f.tickets('s24'), f.tickets('adb')], [[], []], 'every member\'s ticket is gone, not only the released one');
    assert.deepEqual(shape(f.events().filter(event => event.request === 'req')), [['request', null, null], ['cancel', null, 'released']], 'one Pool cancel; the per-lock release wrote none');
  } finally { f.cleanup(); }
});

test('no member serves it by the deadline: every ticket is withdrawn and the default error names each holder; giveUp supplies another', async () => {
  const f = fixture();
  try {
    await f.hold('s24', 'on-s24');
    await f.hold('adb', 'on-adb');
    await assert.rejects(f.pool({ waitMs: 3000 }), error => error.code === 'HUB_LOCK_TIMEOUT' && /s24 is held by lease on-s24 of holder-on-s24/.test(error.message) && /adb is held by lease on-adb/.test(error.message));
    assert.deepEqual([f.tickets('s24'), f.tickets('adb')], [[], []]);
    assert.deepEqual(shape(f.events().filter(event => event.request === 'req')), [['request', null, null], ['timeout', null, 'deadline']]);
    let given = null;
    await assert.rejects(f.pool({ waitMs: 0, id: 'req2', giveUp: states => { given = states; return Object.assign(new Error('custom'), { code: 'CUSTOM' }); } }), { code: 'CUSTOM' });
    assert.ok(given instanceof Map);
    assert.deepEqual([...given], [['s24', 'held'], ['adb', 'held']]);
    assert.deepEqual(shape(f.events().filter(event => event.request === 'req2')), [['request', null, null], ['cancel', null, 'error']], 'an error that is not a timeout ends as a cancel');
  } finally { f.cleanup(); }
});

test('accept {ok: false} gives the member back (a release) and the request keeps its place under the same ticket name; the next member wins', async () => {
  const f = fixture();
  try {
    const calls = [];
    let adbSaw = null;
    const accept = async name => {
      calls.push(name);
      if (name === 's24') return { ok: false, state: 'absent' };
      adbSaw = f.tickets('s24');
      return { ok: true, value: `device-${name}` };
    };
    const first = await f.pool({ waitMs: 5 * MIN, accept });
    assert.deepEqual(calls, ['s24', 'adb']);
    assert.equal(first.name, 'adb');
    assert.equal(first.value, 'device-adb');
    assert.equal(adbSaw.length, 1, 'the s24 ticket was written back while the request went on to adb');
    assert.deepEqual([f.tickets('s24'), f.tickets('adb')], [[], []]);
    assert.deepEqual(shape(f.events()), [['request', null, null], ['acquire', 's24', null], ['release', 's24', 'by-id'], ['acquire', 'adb', null]], 'the v1a sequence: true acquire/release of the member given back');
    assert.equal(f.owner('s24'), null);
    // the same file name before and after the give-back
    f.free('adb', 'req');
    const names = [];
    await f.pool({ waitMs: 5 * MIN, id: 'req3', accept: async name => { names.push(f.tickets(name === 's24' ? 'adb' : 's24')); return name === 's24' ? { ok: false, state: 'absent' } : { ok: true }; } });
    assert.equal(names[0][0], names[1][0], 'the ticket keeps its file name, so its place');
  } finally { f.cleanup(); }
});

test('every member away on a try: a v1a event sequence of acquire/release pairs, then one timeout from giveUp (away)', async () => {
  const f = fixture();
  try {
    const accept = async () => ({ ok: false, state: 'absent' });
    const giveUp = states => Object.assign(new Error(`away: ${[...states.values()].join(',')}`), { code: 'HUB_PHONE_AWAY', reason: 'absent' });
    await assert.rejects(f.pool({ waitMs: 0, accept, giveUp }), { code: 'HUB_PHONE_AWAY', message: 'away: absent,absent' });
    assert.deepEqual(shape(f.events()), [['request', null, null], ['acquire', 's24', null], ['release', 's24', 'by-id'], ['acquire', 'adb', null], ['release', 'adb', 'by-id'], ['timeout', null, 'away']]);
    assert.equal(f.owner('s24'), null);
    assert.equal(f.owner('adb'), null);
  } finally { f.cleanup(); }
});

test('accept that throws gives the lock back and ends the request with that error; every ticket is withdrawn', async () => {
  const f = fixture();
  try {
    await assert.rejects(f.pool({ waitMs: 5 * MIN, accept: async () => { throw Object.assign(new Error('boom'), { code: 'BOOM' }); } }), { code: 'BOOM' });
    assert.equal(f.owner('s24'), null, 'the lock is given back');
    assert.deepEqual([f.tickets('s24'), f.tickets('adb')], [[], []]);
    assert.deepEqual(shape(f.events()), [['request', null, null], ['acquire', 's24', null], ['release', 's24', 'by-id'], ['cancel', null, 'error']]);
  } finally { f.cleanup(); }
});

test('a request that already holds a member keeps it: the one just taken is released with reason pool-duplicate', async () => {
  const f = fixture();
  try {
    await f.hold('adb', 'req');
    const mark = f.events().length;
    const won = await f.pool({ waitMs: 0, accept: async (name, record) => ({ ok: true, value: [name, record.lease_id] }) });
    assert.equal(won.name, 'adb', 'adb is returned');
    assert.deepEqual(won.value, ['adb', 'req']);
    assert.equal(f.owner('s24'), null, 'the s24 just taken went back');
    assert.equal(f.owner('adb').lease_id, 'req');
    const mine = f.events().slice(mark);
    assert.deepEqual(shape(mine), [['request', null, null], ['acquire', 's24', null], ['release', 's24', 'pool-duplicate']]);
  } finally { f.cleanup(); }
});

test('a deploy-target member over its cap for --for refuses before any ticket; a bad member or id is refused too', async () => {
  const f = fixture();
  try {
    await assert.rejects(f.pool({ forMs: 2 * 60 * MIN }), { code: 'HUB_LEASE_TOO_LONG' });
    assert.deepEqual([f.queue('s24'), f.queue('adb')], [[], []]);
    assert.deepEqual(f.events(), []);
    await assert.rejects(acquirePool('phone', ['Not A Lock'], { holder: 'x', why: 'y', forMs: MIN, env: f.env }), /bad lock name/);
    await assert.rejects(acquirePool('phone', [], { holder: 'x', why: 'y', forMs: MIN, env: f.env }), /no members/);
    await assert.rejects(f.pool({ id: 'Bad Id' }), /bad lease id/);
  } finally { f.cleanup(); }
});

test('an aborted wait withdraws every ticket and settles as one cancel (aborted)', async () => {
  const f = fixture();
  try {
    await f.hold('s24', 'on-s24');
    await f.hold('adb', 'on-adb');
    const abort = new AbortController();
    let polls = 0;
    const sleep = async ms => { f.advance(ms); polls += 1; if (polls === 2) abort.abort(); };
    await assert.rejects(f.pool({ waitMs: 5 * MIN, sleep, signal: abort.signal }), error => error.name === 'AbortError');
    assert.deepEqual([f.tickets('s24'), f.tickets('adb')], [[], []]);
    assert.deepEqual(shape(f.events().filter(event => event.request === 'req')), [['request', null, null], ['cancel', null, 'aborted']]);
  } finally { f.cleanup(); }
});

test('a killed waiter\'s tickets read stale by pid, and an acquirer\'s prune removes both', async () => {
  const f = fixture();
  try {
    await f.hold('s24', 'on-s24', 30 * MIN);
    await f.hold('adb', 'on-adb', 30 * MIN);
    const script = `
      import { acquirePool } from ${JSON.stringify(lockModule)};
      await acquirePool('phone', ['s24', 'adb'], { holder: 'child', why: 'will be killed', forMs: 60000, waitMs: 600000, id: 'doomed', pollMs: 50, log: () => {}, policy: ${JSON.stringify(policyOf())} });
    `;
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, ...f.env }, stdio: 'ignore' });
    try {
      await until(() => f.tickets('s24').length === 1 && f.tickets('adb').length === 1, 'the child queued in both');
      assert.equal(f.ticket('s24', f.tickets('s24')[0]).pid, child.pid);
      assert.equal(queueView('adb', { env: f.env, now: Date.now }).length, 1, 'alive: one live waiter');
      child.kill('SIGKILL');
      await new Promise(done => child.on('exit', done));
      assert.deepEqual([queueView('s24', { env: f.env, includeStale: true })[0].stale, queueView('adb', { env: f.env, includeStale: true })[0].stale], [true, true], 'both read stale by pid');
      assert.equal(queueView('s24', { env: f.env, prune: true }).length, 0);
      assert.equal(queueView('adb', { env: f.env, prune: true }).length, 0);
      assert.deepEqual([f.tickets('s24'), f.tickets('adb')], [[], []], 'pruned from both queues');
    } finally { child.kill('SIGKILL'); }
  } finally { f.cleanup(); }
});

test('a stale holder is reclaimed like acquireLease reclaims it: the Pool request takes an expired Lease\'s lock', async () => {
  const f = fixture();
  try {
    await f.hold('s24', 'old', MIN);
    await f.hold('adb', 'old-adb', 30 * MIN);
    f.advance(2 * MIN);
    const won = await f.pool({ waitMs: 5 * MIN });
    assert.equal(won.name, 's24');
    assert.ok(existsSync(join(f.env.HUB_LOCK_DIR, 's24.lock')));
    assert.deepEqual(shape(f.events().filter(event => event.request === 'req' || event.event === 'reclaim')).map(([event, lock, reason]) => [event, lock, reason]).slice(-3), [['request', null, null], ['reclaim', 's24', 'expired'], ['acquire', 's24', null]]);
  } finally { f.cleanup(); }
});
