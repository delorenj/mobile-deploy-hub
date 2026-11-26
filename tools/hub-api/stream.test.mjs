// Story 8.4 (AD-43, FR-14): one stream on the Candybar wire. The unit rows drive `createStream` with fake timers and fake sinks; the envelope
// rows drive `handle()` over a synthetic route table; the service rows start `startHubApi` with a FakeServer listener and a fake response.
// No port, no real adb server and no real clock: the keepalive runs on a virtual clock.
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadDevices } from '../ci/lib/devices.mjs';
import { loadPolicy } from '../ci/lib/policy.mjs';
import { hermetic } from '../ci/test-fixtures.mjs';
import { ROUTES, handle, streamReply } from './routes.mjs';
import { startHubApi } from './server.mjs';
import { ID_PATTERN, RETRY_MS, RING_SIZE, STREAM_HEADERS, createStream, mintBoot } from './stream.mjs';

hermetic();

const policy = loadPolicy().policy;
const BOOT = 'abcdef012345';
const T0 = Date.parse('2026-11-25T10:00:00Z');
const flush = async (rounds = 6) => { for (let round = 0; round < rounds; round += 1) await new Promise(done => setImmediate(done)); };

// A virtual clock with interval timers: `advance(ms)` fires every due interval in time order. `active()` is the armed count.
function fakeTimers() {
  const state = { t: 0, next: 1, armed: new Map(), created: 0 };
  return {
    setInterval(fn, ms) {
      const id = state.next++;
      state.created += 1;
      state.armed.set(id, { fn, ms, due: state.t + ms });
      return { id, unref() { this.unrefd = true; } };
    },
    clearInterval(handle) { state.armed.delete(handle?.id); },
    advance(ms) {
      const end = state.t + ms;
      for (;;) {
        const due = [...state.armed.entries()].filter(([, timer]) => timer.due <= end).sort((a, b) => a[1].due - b[1].due)[0];
        if (!due) break;
        const [, timer] = due;
        state.t = timer.due;
        timer.due += timer.ms;
        timer.fn();
      }
      state.t = end;
    },
    active: () => state.armed.size,
    created: () => state.created,
    now: () => state.t,
  };
}

// A response-shaped sink: records its writes and plays `close`, `end` and `destroy`.
class FakeSink extends EventEmitter {
  chunks = [];
  ended = false;
  destroyed = false;
  writableFinished = false;
  writableLength = 0;
  head = null;
  writeHead(status, headers) { this.head = { status, headers }; }
  write(text) { if (this.destroyed) throw new Error('write after destroy'); this.chunks.push(text); return true; }
  end() { this.ended = true; this.writableFinished = true; this.emit('close'); }
  destroy() { this.destroyed = true; this.emit('close'); }
  get text() { return this.chunks.join(''); }
}

// The frames of a body: `{id, event, data}` for a frame, `{comment}` for a comment, `{retry}` for the retry line.
function parse(text) {
  return text.split('\n\n').filter(block => block !== '').map(block => {
    const lines = block.split('\n');
    if (lines.length === 1 && lines[0].startsWith('retry: ')) return { retry: Number(lines[0].slice(7)) };
    if (lines.length === 1 && lines[0].startsWith(': ')) return { comment: lines[0].slice(2) };
    const field = name => lines.find(line => line.startsWith(`${name}: `))?.slice(name.length + 2);
    assert.equal(lines.length, 3, `a frame is three lines: ${block}`);
    return { id: field('id'), event: field('event'), data: JSON.parse(field('data')) };
  });
}
const seqs = sink => parse(sink.text).filter(frame => frame.id).map(frame => frame.data.seq);

function make(options = {}) {
  const timers = fakeTimers();
  const stream = createStream({ boot: BOOT, now: () => T0 + timers.now(), keepaliveMs: 15_000, timers, ...options });
  return { stream, timers };
}
const DOC = { format: 1, hosts: { linux: {} } };
const attachTo = (stream, lastEventId, status = DOC) => {
  const sink = new FakeSink();
  const plan = stream.plan(lastEventId);
  stream.attach(sink, { ...plan, after: plan.kind === 'resume' ? plan.after : stream.cursor(), status });
  return { sink, plan };
};

// ---- the wire ----

test('the wire constants and the boot id', () => {
  assert.deepEqual({ ...STREAM_HEADERS }, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
  assert.equal(RETRY_MS, 3000);
  assert.equal(RING_SIZE, 1024);
  assert.match(mintBoot(), /^[0-9a-f]{12}$/);
  assert.notEqual(mintBoot(), mintBoot());
  assert.match(`${mintBoot()}-1`, ID_PATTERN);
  assert.doesNotMatch('ABCDEF012345-1', ID_PATTERN);
  assert.equal(createStream().boot.length, 12);
});

test('ready: retry first, then one ready frame named by the cursor that carries the whole document, then nothing until a new frame', () => {
  const { stream, timers } = make();
  stream.status({ n: 1 });
  stream.status({ n: 2 });
  assert.equal(stream.cursor(), 2);
  const { sink, plan } = attachTo(stream, undefined);
  assert.deepEqual(plan, { kind: 'ready' });
  assert.ok(sink.text.startsWith('retry: 3000\n\n'));
  const [retry, ready, ...rest] = parse(sink.text);
  assert.deepEqual(retry, { retry: 3000 });
  assert.equal(ready.id, `${BOOT}-2`);
  assert.equal(ready.event, 'ready');
  assert.deepEqual(Object.keys(ready.data).slice(0, 4), ['type', 'seq', 'key', 'at']);
  assert.deepEqual({ type: ready.data.type, seq: ready.data.seq, key: ready.data.key, at: ready.data.at }, { type: 'ready', seq: 2, key: 'ready', at: new Date(T0).toISOString() });
  assert.deepEqual(ready.data.status, DOC);
  assert.equal('reason' in ready.data, false);
  assert.deepEqual(rest, [], 'the ring frames at or before the cursor are not replayed');
  stream.status({ n: 3 });
  assert.deepEqual(seqs(sink), [2, 3]);
  assert.equal(timers.active(), 1);
});

test('before the first frame the cursor is 0, and `<boot>-0` is a valid resume point', () => {
  const { stream } = make();
  const { sink } = attachTo(stream, undefined);
  assert.equal(parse(sink.text)[1].id, `${BOOT}-0`);
  stream.status(DOC);
  assert.deepEqual(stream.plan(`${BOOT}-0`), { kind: 'resume', after: 0 });
  assert.deepEqual(seqs(attachTo(stream, `${BOOT}-0`).sink), [1]);
});

test('an opening frame is never put in the ring: a second client never replays the first one\'s ready', () => {
  const { stream } = make();
  stream.status({ n: 1 });
  attachTo(stream, undefined);
  attachTo(stream, 'bogus');
  stream.status({ n: 2 });
  const { sink } = attachTo(stream, `${BOOT}-0`);
  const frames = parse(sink.text).filter(frame => frame.id);
  assert.deepEqual(frames.map(frame => [frame.event, frame.data.seq]), [['status', 1], ['status', 2]]);
});

test('exact resume replays strictly after the id, with no opening frame', () => {
  const { stream } = make();
  for (let n = 1; n <= 5; n += 1) stream.status({ n });
  const { sink, plan } = attachTo(stream, `${BOOT}-3`);
  assert.deepEqual(plan, { kind: 'resume', after: 3 });
  assert.deepEqual(parse(sink.text).map(frame => frame.retry ?? frame.data.seq), [3000, 4, 5]);
  assert.ok(parse(sink.text).every(frame => frame.retry !== undefined || frame.event === 'status'), 'no ready, no reset');
  const atCursor = attachTo(stream, `${BOOT}-5`);
  assert.deepEqual(atCursor.plan, { kind: 'resume', after: 5 });
  assert.equal(atCursor.sink.text, 'retry: 3000\n\n');
});

test('reset: another boot, a malformed id, or an id above the cursor gets a reset frame with the whole document', () => {
  const { stream } = make();
  stream.status({ n: 1 });
  stream.status({ n: 2 });
  for (const id of ['abcdef000000-1', 'abc', `${BOOT}-x`, `${BOOT}-9`, `${BOOT}-`, `${BOOT.toUpperCase()}-1`, `${BOOT}-1.5`]) {
    const { sink, plan } = attachTo(stream, id);
    assert.deepEqual(plan, { kind: 'reset' }, id);
    const frames = parse(sink.text);
    assert.deepEqual(frames[0], { retry: 3000 });
    assert.equal(frames[1].id, `${BOOT}-2`, id);
    assert.equal(frames[1].event, 'reset');
    assert.equal(frames[1].data.reason, 'unresumable');
    assert.deepEqual(Object.keys(frames[1].data).slice(0, 4), ['type', 'seq', 'key', 'at']);
    assert.equal(frames[1].data.key, 'reset');
    assert.deepEqual(frames[1].data.status, DOC);
    assert.equal(frames.length, 2);
  }
  assert.deepEqual(stream.plan('   '), { kind: 'ready' });
  assert.deepEqual(stream.plan(''), { kind: 'ready' });
  assert.deepEqual(stream.plan(undefined), { kind: 'ready' });
});

test('eviction: a ring of 4 after 10 frames holds 7..10, so 6 resumes and 5 resets', () => {
  const { stream } = make({ ringSize: 4 });
  for (let n = 1; n <= 10; n += 1) stream.status({ n });
  assert.deepEqual(stream.plan(`${BOOT}-6`), { kind: 'resume', after: 6 });
  assert.deepEqual(stream.plan(`${BOOT}-5`), { kind: 'reset' });
  assert.deepEqual(seqs(attachTo(stream, `${BOOT}-6`).sink), [7, 8, 9, 10]);
  assert.deepEqual(seqs(attachTo(stream, `${BOOT}-10`).sink), []);
});

test('eviction at the default size: 1030 frames keep exactly 7..1030', () => {
  const { stream } = make();
  for (let n = 1; n <= 1030; n += 1) stream.status({ n });
  const kept = seqs(attachTo(stream, `${BOOT}-6`).sink);
  assert.equal(kept.length, 1024);
  assert.equal(kept[0], 7);
  assert.equal(kept.at(-1), 1030);
  assert.deepEqual(stream.plan(`${BOOT}-5`), { kind: 'reset' });
});

test('an empty ring resumes only at the cursor', () => {
  const { stream } = make({ ringSize: 2 });
  assert.deepEqual(stream.plan(`${BOOT}-0`), { kind: 'resume', after: 0 });
  assert.deepEqual(stream.plan(`${BOOT}-1`), { kind: 'reset' });
});

test('live fan-out: two sinks get status then event, each frame one line, event key and event_id the id', () => {
  const { stream, timers } = make();
  const a = attachTo(stream, undefined).sink;
  const b = attachTo(stream, undefined).sink;
  assert.equal(stream.subscribers(), 2);
  assert.equal(stream.status(DOC), 1);
  assert.equal(stream.event({ id: 'h/2026-11/0', offset: 0, event: { ts: '2026-11-25T09:00:00.000Z', kind: 'lease', why: 'multi\nline' } }), 2);
  for (const sink of [a, b]) {
    const frames = parse(sink.text).filter(frame => frame.id && frame.event !== 'ready');
    assert.deepEqual(frames.map(frame => frame.id), [`${BOOT}-1`, `${BOOT}-2`]);
    assert.equal(frames[0].event, 'status');
    assert.deepEqual(frames[0].data, { type: 'status', seq: 1, key: 'status', at: new Date(T0).toISOString(), status: DOC });
    assert.equal(frames[1].event, 'event');
    assert.deepEqual(frames[1].data, { type: 'event', seq: 2, key: 'h/2026-11/0', at: '2026-11-25T09:00:00.000Z', event_id: 'h/2026-11/0', event: { ts: '2026-11-25T09:00:00.000Z', kind: 'lease', why: 'multi\nline' } });
    assert.ok(frames.every(frame => frame.id.match(ID_PATTERN)));
  }
  assert.equal(a.text, b.text);
  timers.advance(1);
  stream.event({ id: 'h/2026-11/1', event: { kind: 'x' } });
  const last = parse(a.text).at(-1);
  assert.equal(last.data.at, new Date(T0 + 1).toISOString(), 'an event with no ts is stamped now');
});

test('an event entry whose id is not a non-empty string is a TypeError and nothing is emitted', () => {
  const { stream } = make();
  const { sink } = attachTo(stream, undefined);
  const before = sink.chunks.length;
  for (const entry of [undefined, null, {}, { id: '' }, { id: 7 }, { event: { ts: 'x' } }]) assert.throws(() => stream.event(entry), TypeError);
  assert.equal(stream.cursor(), 0);
  assert.equal(sink.chunks.length, before);
});

test('keepalive: one per connection after keepaliveMs without bytes, re-armed by every write, gone with the connection', () => {
  const { stream, timers } = make();
  const { sink } = attachTo(stream, undefined);
  const keepalives = () => parse(sink.text).filter(frame => frame.comment === 'keepalive').length;
  timers.advance(10_000);
  assert.equal(keepalives(), 0);
  stream.status(DOC);                   // a frame at t=10 s re-arms the interval
  timers.advance(14_999);               // t = 24.999 s
  assert.equal(keepalives(), 0, 'none before 25 s');
  timers.advance(1);                    // t = 25 s
  assert.equal(keepalives(), 1);
  timers.advance(14_999);
  assert.equal(keepalives(), 1);
  timers.advance(1);                    // t = 40 s
  assert.equal(keepalives(), 2);
  assert.ok(sink.text.endsWith(': keepalive\n\n'));
  assert.equal(sink.chunks.at(-1), ': keepalive\n\n', 'a keepalive is a bare comment with no id');
  assert.equal(timers.active(), 1);
  const written = sink.chunks.length;
  sink.emit('close');
  assert.equal(timers.active(), 0, 'the close clears the interval');
  assert.equal(stream.subscribers(), 0);
  timers.advance(120_000);
  assert.equal(sink.chunks.length, written);
});

test('every connection has its own interval, and the intervals are unref\'d', () => {
  const { stream, timers } = make();
  const a = attachTo(stream, undefined).sink;
  const b = attachTo(stream, undefined).sink;
  assert.equal(timers.active(), 2);
  a.emit('close');
  assert.equal(timers.active(), 1);
  timers.advance(15_000);
  assert.equal(parse(b.text).filter(frame => frame.comment === 'keepalive').length, 1);
  assert.equal(parse(a.text).filter(frame => frame.comment === 'keepalive').length, 0);
});

test('a replay of many frames arms one interval, not one per frame', () => {
  const { stream, timers } = make();
  for (let n = 1; n <= 50; n += 1) stream.status({ n });
  attachTo(stream, `${BOOT}-0`);
  assert.equal(timers.created(), 1);
});

test('a slow client (writableLength past the bound) is destroyed and detached, and the others still get frames', () => {
  const { stream, timers } = make({ maxBufferedBytes: 1000 });
  const slow = attachTo(stream, undefined).sink;
  const fast = attachTo(stream, undefined).sink;
  slow.writableLength = 1001;
  stream.status({ n: 1 });
  assert.equal(slow.destroyed, true);
  assert.equal(stream.subscribers(), 1);
  assert.equal(timers.active(), 1);
  stream.status({ n: 2 });
  assert.deepEqual(seqs(fast), [0, 1, 2]);
  assert.deepEqual(seqs(slow), [0, 1], 'the slow sink got the frame that crossed the bound and nothing after it');
});

test('a replay larger than the bound is delivered, and a later live frame past the bound still drops the sink', () => {
  const { stream } = make({ maxBufferedBytes: 1000 });
  for (let n = 1; n <= 5; n += 1) stream.status({ n, pad: 'x'.repeat(500) });
  const sink = new FakeSink();
  // The sink reports a buffer over the bound from the start: the opening replay is still written whole.
  sink.writableLength = 5000;
  stream.attach(sink, { ...stream.plan(`${BOOT}-0`), after: 0, status: DOC });
  assert.equal(sink.destroyed, false);
  assert.deepEqual(seqs(sink), [1, 2, 3, 4, 5]);
  assert.equal(stream.subscribers(), 1);
  stream.status({ n: 6 });
  assert.equal(sink.destroyed, true, 'a live frame past the bound drops it');
  assert.equal(stream.subscribers(), 0);
});

test('a sequence gap never happens: a payload JSON cannot serialise leaves the cursor where it was', () => {
  const { stream } = make();
  stream.status(DOC);
  const circular = {};
  circular.self = circular;
  assert.throws(() => stream.status(circular), TypeError);
  assert.equal(stream.cursor(), 1);
  assert.equal(stream.status(DOC), 2);
  assert.deepEqual(seqs(attachTo(stream, `${BOOT}-0`).sink), [1, 2]);
});

test('a sink whose write throws is dropped, and the others still get frames', () => {
  const { stream } = make();
  const broken = attachTo(stream, undefined).sink;
  const fine = attachTo(stream, undefined).sink;
  broken.write = () => { throw new Error('EPIPE'); };
  stream.status(DOC);
  assert.equal(stream.subscribers(), 1);
  assert.equal(seqs(fine).at(-1), 1);
});

test('close() ends every sink, clears every interval and sets closed; after it status and event emit nothing and attach ends the sink', () => {
  const { stream, timers } = make();
  const a = attachTo(stream, undefined).sink;
  const b = attachTo(stream, undefined).sink;
  const stuck = attachTo(stream, undefined).sink;
  stuck.writableLength = 10;   // a client that stopped reading: its buffer would never flush
  assert.equal(stream.closed, false);
  stream.close();
  assert.equal(stream.closed, true);
  assert.equal(a.ended && b.ended && stuck.ended, true);
  assert.equal(stuck.destroyed, true, 'a sink with unflushed bytes is destroyed after end');
  assert.equal(b.destroyed, false);
  assert.equal(timers.active(), 0);
  assert.equal(stream.subscribers(), 0);
  const written = a.text;
  assert.equal(a.destroyed, false, 'a drained sink is ended, not destroyed');
  stream.status(DOC);
  stream.event({ id: 'x/1', event: {} });
  assert.equal(a.text, written);
  assert.equal(stream.cursor(), 0);
  const late = new FakeSink();
  stream.attach(late, { kind: 'ready', after: 0, status: DOC });
  assert.equal(late.ended, true);
  assert.equal(late.text, '');
  assert.equal(timers.active(), 0);
});

// ---- the envelope ----

test('handle: a stream route answers 200 with the event-stream headers, no body, and the handler gets the request headers', async () => {
  const seen = [];
  const routes = [
    { method: 'GET', path: '/feed', shape: 'X', stream: true, handler: (ctx, request) => { seen.push(request.headers); return streamReply(sink => sink.write('hi')); } },
    { method: 'GET', path: '/plain', shape: 'X', handler: () => ({ ok: true }) },
    { method: 'GET', path: '/bad-stream', shape: 'X', stream: true, handler: () => ({ ok: true }) },
    { method: 'GET', path: '/bad-plain', shape: 'X', handler: () => streamReply(() => {}) },
  ];
  const ctx = { routes, log: { err: () => {} } };
  const answer = await handle({ method: 'GET', url: '/feed?x=1', headers: { 'last-event-id': 'abc' } }, ctx);
  assert.equal(answer.status, 200);
  assert.deepEqual(answer.headers, { 'Cache-Control': 'no-store', 'Content-Type': 'text/event-stream', 'X-Accel-Buffering': 'no' });
  assert.equal('body' in answer, false);
  assert.equal(typeof answer.stream.open, 'function');
  assert.deepEqual(seen, [{ 'last-event-id': 'abc' }]);
  const sink = new FakeSink();
  answer.stream.open(sink);
  assert.equal(sink.text, 'hi');
  // Dispatch is unchanged.
  assert.equal((await handle({ method: 'GET', url: '/nope' }, ctx)).status, 404);
  const wrong = await handle({ method: 'POST', url: '/feed' }, ctx);
  assert.equal(wrong.status, 405);
  assert.equal(wrong.headers.Allow, 'GET');
  assert.equal((await handle({ method: 'GET', url: '/plain' }, ctx)).body.ok, true);
  // A stream route that returns no stream, and a plain route that returns one, are bugs of the handler: 500.
  for (const url of ['/bad-stream', '/bad-plain']) {
    const bug = await handle({ method: 'GET', url }, ctx);
    assert.equal(bug.status, 500, url);
    assert.equal(bug.body.code, 'HUB_API_ERROR');
  }
});

test('GET /stream is in ROUTES as a stream route with the StreamFrame shape', () => {
  const route = ROUTES.find(candidate => candidate.method === 'GET' && candidate.path === '/stream');
  assert.equal(route.shape, 'StreamFrame');
  assert.equal(route.stream, true);
});

test('GET /stream with no stream in the context is 500 HUB_API_ERROR, and with a closed one 503 HUB_API_RESTARTING with retry requeue', async () => {
  const none = await handle({ method: 'GET', url: '/stream' }, { log: { err: () => {} } });
  assert.equal(none.status, 500);
  assert.equal(none.body.code, 'HUB_API_ERROR');
  const stream = createStream({ boot: BOOT });
  stream.close();
  const closed = await handle({ method: 'GET', url: '/stream' }, { stream });
  assert.equal(closed.status, 503);
  assert.equal(closed.body.code, 'HUB_API_RESTARTING');
  assert.equal(closed.body.retry, 'requeue');
  assert.equal(closed.headers['Content-Type'], 'application/problem+json');
});

test('an exact resume never builds the status document: a host that cannot be known still resumes, and a ready or reset is a 503', async () => {
  const stream = createStream({ boot: BOOT });
  stream.status(DOC);
  stream.status(DOC);
  const hostKey = () => { throw Object.assign(new Error('no host key'), { code: 'HUB_HOST_UNKNOWN' }); };
  const ctx = { stream, hostKey, env: {}, policy, log: { err: () => {} } };
  const resumed = await handle({ method: 'GET', url: '/stream', headers: { 'last-event-id': `${BOOT}-1` } }, ctx);
  assert.equal(resumed.status, 200);
  const sink = new FakeSink();
  resumed.stream.open(sink);
  assert.deepEqual(seqs(sink), [2]);
  for (const headers of [{}, { 'last-event-id': 'bogus' }]) {
    const unknown = await handle({ method: 'GET', url: '/stream', headers }, ctx);
    assert.equal(unknown.status, 503);
    assert.equal(unknown.body.code, 'HUB_HOST_UNKNOWN');
    assert.equal(unknown.stream, undefined, 'no stream is opened');
  }
  assert.equal(stream.subscribers(), 1, 'only the resume attached');
});

// ---- the service ----

function scratch() {
  const root = mkdtempSync(join(tmpdir(), 'hub-api-stream-'));
  const env = { PATH: process.env.PATH, HOME: root, HUB_LOCK_DIR: join(root, 'locks'), HUB_EVENT_DIR: join(root, 'events') };
  return { root, env, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

async function boot(s, { hostKey = () => 'linux', stream, gate = null, policy: given = policy } = {}) {
  const signals = new EventEmitter();
  const logs = { out: [], err: [] };
  let listener;
  class FakeServer extends EventEmitter {
    constructor(handler) { super(); listener = handler; }
    listen(port, host, callback) { process.nextTick(callback); return this; }
    address() { return { port: 1 }; }
    close(callback) { process.nextTick(callback); return this; }
  }
  const running = await startHubApi({
    env: s.env, policy: given, hostId: 'test-host', devices: structuredClone(loadDevices({})), qaDevices: () => [], versions: { node: '24.15.0' }, onPath: () => true, signals, hostKey,
    log: { out: line => logs.out.push(line), err: line => logs.err.push(line) },
    createServer: handler => new FakeServer(handler),
    observe: async () => {
      if (gate) await gate;
      return { inventory: { adb_servers: [], emulators: [], xvfb: [] }, adb: { port: 5037, note: null, listed: [], serials: new Map() }, starts: new Map(), live_starts: new Map() };
    },
    ...(stream ? { stream } : {}),
  });
  return { listener, logs, running, stop: async () => { signals.emit('SIGTERM'); await running.stopped; } };
}

function open(listener, url, headers = {}) {
  const req = { method: 'GET', url, headers, async *[Symbol.asyncIterator]() { /* no body */ } };
  const res = new FakeSink();
  const done = listener(req, res);
  return { res, done };
}
async function call(listener, url, headers) { const e = open(listener, url, headers); await e.done; return e.res; }

test('GET /stream through the listener: the head, retry first, a ready frame whose document has /status\'s key set, ids of the service\'s boot', async () => {
  const s = scratch();
  let svc;
  try {
    svc = await boot(s);
    const res = await call(svc.listener, '/stream');
    assert.equal(res.head.status, 200);
    assert.deepEqual({ ...res.head.headers }, { 'Cache-Control': 'no-store', 'Content-Type': 'text/event-stream', 'X-Accel-Buffering': 'no' });
    assert.equal('Content-Length' in res.head.headers, false);
    assert.ok(res.text.startsWith('retry: 3000\n\n'));
    const [, ready, ...rest] = parse(res.text);
    assert.deepEqual(rest, []);
    assert.equal(ready.event, 'ready');
    assert.match(ready.id, ID_PATTERN);
    const boot12 = ready.id.split('-')[0];
    assert.equal(ready.id, `${boot12}-0`);
    assert.equal(res.ended, false, 'the stream stays open');
  } finally { await svc?.stop(); s.cleanup(); }
});

test('the ready document\'s key set equals GET /status\'s', async () => {
  const s = scratch();
  let svc;
  try {
    svc = await boot(s);
    const streamed = await call(svc.listener, '/stream');
    const ready = parse(streamed.text)[1].data.status;
    // A plain GET /status, with a response that keeps its JSON.
    const req = { method: 'GET', url: '/status', headers: {}, async *[Symbol.asyncIterator]() { /* no body */ } };
    const plain = Object.assign(new EventEmitter(), { writableFinished: false, head: null, text: null, writeHead(status, headers) { this.head = { status, headers }; }, end(text) { this.text = text; this.writableFinished = true; this.emit('close'); } });
    await svc.listener(req, plain);
    const status = JSON.parse(plain.text);
    assert.equal(plain.head.status, 200);
    assert.deepEqual(Object.keys(ready), Object.keys(status));
    assert.deepEqual(Object.keys(ready.hosts), Object.keys(status.hosts));
    assert.deepEqual(Object.keys(ready.hosts.linux), Object.keys(status.hosts.linux));
    assert.equal(ready.contract, status.contract);
  } finally { await svc?.stop(); s.cleanup(); }
});

test('a frame emitted while the ready document is being built is replayed, never lost', async () => {
  const s = scratch();
  let svc;
  try {
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const stream = createStream({ boot: BOOT });
    svc = await boot(s, { stream, gate });
    const waiting = open(svc.listener, '/stream');
    await flush();
    assert.equal(waiting.res.head, null, 'the document is still being built');
    stream.status({ emitted: 'meanwhile' });
    release();
    await waiting.done;
    const frames = parse(waiting.res.text);
    assert.equal(frames[1].id, `${BOOT}-0`, 'the cursor was taken before the document');
    assert.equal(frames[2].id, `${BOOT}-1`);
    assert.deepEqual(frames[2].data.status, { emitted: 'meanwhile' });
  } finally { await svc?.stop(); s.cleanup(); }
});

test('resume through the listener replays frames 4 and 5 only, and reset names the cursor', async () => {
  const s = scratch();
  let svc;
  try {
    const stream = createStream({ boot: BOOT });
    for (let n = 1; n <= 5; n += 1) stream.status({ n });
    svc = await boot(s, { stream });
    const resumed = await call(svc.listener, '/stream', { 'last-event-id': `${BOOT}-3` });
    assert.deepEqual(parse(resumed.text).map(frame => frame.retry ?? frame.data.seq), [3000, 4, 5]);
    const reset = await call(svc.listener, '/stream', { 'last-event-id': 'ffffffffffff-2' });
    const frames = parse(reset.text);
    assert.equal(frames[1].event, 'reset');
    assert.equal(frames[1].id, `${BOOT}-5`);
    assert.equal(frames[1].data.reason, 'unresumable');
    assert.ok('hosts' in frames[1].data.status);
    // A live frame reaches both.
    stream.status({ n: 6 });
    assert.equal(seqs(resumed).at(-1), 6);
    assert.equal(seqs(reset).at(-1), 6);
  } finally { await svc?.stop(); s.cleanup(); }
});

test('host unknown: 503 HUB_HOST_UNKNOWN problem+json, no stream, nothing attached', async () => {
  const s = scratch();
  let svc;
  try {
    const stream = createStream({ boot: BOOT });
    svc = await boot(s, { stream, hostKey: () => { throw Object.assign(new Error('no host key'), { code: 'HUB_HOST_UNKNOWN' }); } });
    const req = { method: 'GET', url: '/stream', headers: {}, async *[Symbol.asyncIterator]() { /* no body */ } };
    const res = Object.assign(new EventEmitter(), { writableFinished: false, head: null, text: null, writeHead(status, headers) { this.head = { status, headers }; }, end(text) { this.text = text; this.writableFinished = true; this.emit('close'); } });
    await svc.listener(req, res);
    assert.equal(res.head.status, 503);
    assert.equal(res.head.headers['Content-Type'], 'application/problem+json');
    assert.equal(JSON.parse(res.text).code, 'HUB_HOST_UNKNOWN');
    assert.equal(stream.subscribers(), 0);
  } finally { await svc?.stop(); s.cleanup(); }
});

test('a stop ends the subscriber\'s response, prints HUB_API_STOP, leaves no interval armed, and a later GET /stream is 503 HUB_API_RESTARTING', async () => {
  const s = scratch();
  let svc;
  try {
    const timers = fakeTimers();
    const stream = createStream({ boot: BOOT, timers, keepaliveMs: 15_000 });
    svc = await boot(s, { stream });
    const res = await call(svc.listener, '/stream');
    assert.equal(stream.subscribers(), 1);
    assert.equal(timers.active(), 1);
    await svc.stop();
    assert.equal(res.ended, true);
    assert.ok(svc.logs.out.includes('HUB_API_STOP'));
    assert.equal(timers.active(), 0);
    assert.equal(stream.subscribers(), 0);
    const req = { method: 'GET', url: '/stream', headers: {}, async *[Symbol.asyncIterator]() { /* no body */ } };
    const late = Object.assign(new EventEmitter(), { writableFinished: false, head: null, text: null, writeHead(status, headers) { this.head = { status, headers }; }, end(text) { this.text = text; this.writableFinished = true; this.emit('close'); } });
    await svc.listener(req, late);
    assert.equal(late.head.status, 503);
    assert.equal(JSON.parse(late.text).code, 'HUB_API_RESTARTING');
    svc = null;
  } finally { await svc?.stop(); s.cleanup(); }
});

test('the default stream is built from the policy: its keepalive is api.stream_keepalive_s, and a stop with a subscriber open resolves', async () => {
  const s = scratch();
  const custom = structuredClone(policy);
  custom.api.stream_keepalive_s = 7;
  mock.timers.enable({ apis: ['setInterval'] });
  let svc;
  try {
    svc = await boot(s, { policy: custom });
    const res = await call(svc.listener, '/stream');
    const keepalives = () => parse(res.text).filter(frame => frame.comment === 'keepalive').length;
    mock.timers.tick(6999);
    assert.equal(keepalives(), 0, 'none before 7000 ms');
    mock.timers.tick(1);
    assert.equal(keepalives(), 1, 'one at 7000 ms');
    await svc.stop();
    svc = null;
    assert.equal(res.ended, true);
  } finally { await svc?.stop(); mock.timers.reset(); s.cleanup(); }
});
