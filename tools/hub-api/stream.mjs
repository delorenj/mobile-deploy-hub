// The Candybar SSE wire (Story 8.4, AD-43, FR-14): one service-agnostic stream hub. It mints the boot id, keeps a ring of the last frames,
// plans a resume from a `Last-Event-ID`, writes frames to every attached sink and gives each connection its own keepalive. It knows no
// route and no document: a service builds one (`createStream`), mounts a route on it (routes.mjs's `streamReply`) and feeds it with
// `status(doc)` and `event(entry)`. The wire is the one ~/code/33GOD/candybar/src/candybar/api/stream.py writes and Holocene's proxy
// already pipes through, with `Cache-Control: no-store` and no window filter.
//
// A frame is `id: <boot>-<seq>\nevent: <type>\ndata: <one-line JSON>\n\n`; the JSON starts with `type`, `seq`, `key`, `at`. A `status`
// frame holds the whole document (absolute), an `event` frame one Event Log line with its id (a client dedupes on it). The first bytes of
// every connection are `retry: 3000`, then the opening frame (`ready` for a new connection, `reset` for one that cannot resume), which
// carries the whole document and names the cursor (`<boot>-<cursor>`) without taking a seq or entering the ring: it belongs to one
// client. Then every ring frame after the cursor (or after the client's `Last-Event-ID`) is replayed, then frames are live.
//
// The keepalive (a `: keepalive` comment, no id) is the one clock of the hub's stream and lives here (tools/clock.test.mjs names this file):
// one `setInterval` per connection, armed after every write to it, so one goes out whenever `keepaliveMs` passes with no bytes sent. The
// interval is unref'd and cleared with the connection. Nothing here emits a frame by itself: the change sources are the caller's
// (tools/hub-api/changes.mjs).
//
// The second clock (Story 8.5) is `trailing`: a one-shot, poke-driven debounce for a change feed. It arms one unref'd `setTimeout` on the
// first poke of a burst and never on its own, so nothing fires without a change, and a steady stream of pokes cannot push a run back.
import { randomBytes } from 'node:crypto';

export const STREAM_HEADERS = Object.freeze({
  'Content-Type': 'text/event-stream',
  'Cache-Control': 'no-store',
  'X-Accel-Buffering': 'no',
});
export const RETRY_MS = 3000;
export const RING_SIZE = 1024;
export const ID_PATTERN = /^[0-9a-f]{12}-[0-9]+$/;
const KEEPALIVE_MS = 15_000;
const MAX_BUFFERED_BYTES = 8 * 1024 * 1024;

// A boot id: 12 lowercase hex characters, minted once per service start, so an old `Last-Event-ID` from another boot gets a `reset`.
export const mintBoot = () => randomBytes(6).toString('hex');

// `JSON.stringify` escapes every newline in a string, so `data` is always one line.
const frameText = (id, type, payload) => `id: ${id}\nevent: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
const RETRY_TEXT = `retry: ${RETRY_MS}\n\n`;
const KEEPALIVE_TEXT = ': keepalive\n\n';

export function createStream({
  boot = mintBoot(), now = Date.now, ringSize = RING_SIZE, keepaliveMs = KEEPALIVE_MS,
  timers = { setInterval, clearInterval }, maxBufferedBytes = MAX_BUFFERED_BYTES,
} = {}) {
  const ring = [];            // [{seq, text}], oldest first
  const sinks = new Set();    // attached connections: {sink, timer}
  let last = 0;
  let closed = false;
  const iso = ms => new Date(ms).toISOString();
  const cursor = () => last;
  const floor = () => (ring.length > 0 ? ring[0].seq - 1 : last);

  const disarm = entry => {
    if (entry.timer !== null) { timers.clearInterval(entry.timer); entry.timer = null; }
  };
  const detach = entry => { disarm(entry); sinks.delete(entry); };
  const drop = entry => {
    detach(entry);
    try { entry.sink.destroy?.(); } catch { /* a sink that cannot be destroyed is already gone */ }
  };
  // (Re)arms the connection's one interval, so a keepalive goes out `keepaliveMs` after the last byte sent.
  const arm = entry => {
    disarm(entry);
    entry.timer = timers.setInterval(() => { if (sinks.has(entry)) put(entry, KEEPALIVE_TEXT); }, keepaliveMs);
    entry.timer?.unref?.();
  };
  // Writes one chunk to one connection. Returns false (and the connection is gone) when the write threw or, for a live frame or a
  // keepalive (`bounded`), the client is too slow. An opening replay is not bounded: it is already in the ring, so a client that
  // resumes with the same id must get it, however large.
  function put(entry, text, bounded = true) {
    try { entry.sink.write(text); } catch { drop(entry); return false; }
    if (!sinks.has(entry)) return false;
    if (bounded && Number(entry.sink.writableLength) > maxBufferedBytes) { drop(entry); return false; }
    return true;
  }
  const send = (entry, texts, bounded = true) => {
    for (const text of texts) if (!put(entry, text, bounded)) return;
    arm(entry);
  };

  function emit(type, key, at, extra) {
    // The cursor moves only once the frame is serialised: a payload JSON.stringify rejects leaves no seq gap.
    const seq = last + 1;
    const text = frameText(`${boot}-${seq}`, type, { type, seq, key, at, ...extra });
    last = seq;
    ring.push({ seq, text });
    while (ring.length > ringSize) ring.shift();
    for (const entry of [...sinks]) send(entry, [text]);
    return seq;
  }

  return {
    boot,
    cursor,
    get closed() { return closed; },
    subscribers: () => sinks.size,

    // The whole document, absolute: a client that has this frame needs no earlier one.
    status(doc) {
      if (closed) return null;
      return emit('status', 'status', iso(now()), { status: doc });
    },

    // One Event Log line (`readEventsFrom`'s `{id, offset, event}`): its id is the frame's key, and a client dedupes on it.
    event(entry) {
      const id = entry?.id;
      if (typeof id !== 'string' || id === '') throw new TypeError('a stream event needs a non-empty string id');
      if (closed) return null;
      const ts = entry.event?.ts;
      return emit('event', id, typeof ts === 'string' && ts !== '' ? ts : iso(now()), { event_id: id, event: entry.event });
    },

    // What a connection with this `Last-Event-ID` gets: `ready` (none), `resume` after seq n (an id of this boot that the ring still
    // covers: floor <= n <= cursor), or `reset` (anything else: another boot, a malformed id, an evicted or future seq).
    plan(lastEventId) {
      const id = typeof lastEventId === 'string' ? lastEventId.trim() : '';
      if (id === '') return { kind: 'ready' };
      if (!ID_PATTERN.test(id)) return { kind: 'reset' };
      const cut = id.indexOf('-');
      const n = Number(id.slice(cut + 1));
      if (id.slice(0, cut) !== boot || !Number.isSafeInteger(n) || n < floor() || n > last) return { kind: 'reset' };
      return { kind: 'resume', after: n };
    },

    // Registers `sink` and takes its replay in one synchronous step, so no frame is lost or written twice. `opening` is
    // `{kind, after, status}` (`plan`'s answer, with `after` and `status` filled in by the route). Returns the entry's detach, or null
    // when the stream is closed (the sink is ended).
    attach(sink, { kind = 'ready', after = last, status } = {}) {
      if (closed) { try { sink.end?.(); } catch { /* already closed */ } return null; }
      const entry = { sink, timer: null };
      const texts = [RETRY_TEXT];
      if (kind !== 'resume') {
        const type = kind === 'reset' ? 'reset' : 'ready';
        texts.push(frameText(`${boot}-${after}`, type, { type, seq: after, key: type, at: iso(now()), ...(type === 'reset' ? { reason: 'unresumable' } : {}), status }));
      }
      for (const frame of ring) if (frame.seq > after) texts.push(frame.text);
      sinks.add(entry);
      sink.on?.('close', () => detach(entry));
      send(entry, texts, false);
      return () => detach(entry);
    },

    // Ends every connection and clears every interval. After it, `status` and `event` emit nothing and `attach` ends the sink.
    close() {
      closed = true;
      for (const entry of [...sinks]) {
        detach(entry);
        try {
          entry.sink.end?.();
          // A client that stopped reading never flushes its buffer, so the socket would stay open and hold the server's close.
          if (Number(entry.sink.writableLength) > 0) entry.sink.destroy?.();
        } catch { /* already closed */ }
      }
    },
  };
}

// The longest a change waits before the one re-read that publishes it (Story 8.5, FR-14, NFR-3: a change reaches a subscriber in 2 s).
export const CHANGE_DEBOUNCE_MS = 250;

// A trailing, fixed-window debounce for `work` (sync or async). `poke()` arms one unref'd one-shot timer of `delayMs` when none is armed and
// no run is in flight; later pokes never push it back, so a run starts at most `delayMs` after the first poke of a burst. A poke during a
// run marks it dirty, and the run's end pokes once, so two runs never overlap and no poke is lost. Nothing arms without a poke. `settled()`
// resolves when no run is in flight (an armed timer is not waited for). `close()` clears the timer; later pokes do nothing. A failing
// `work` goes to `onError` and never stops the debounce.
export function trailing(work, { delayMs, timers = { setTimeout, clearTimeout }, onError } = {}) {
  if (typeof work !== 'function') throw new TypeError('trailing needs a function');
  if (!Number.isFinite(delayMs) || delayMs < 0) throw new RangeError('delayMs must be 0 or more');
  let timer = null;
  let running = null;
  let dirty = false;
  let closed = false;

  const poke = () => {
    if (closed) return;
    if (running !== null) { dirty = true; return; }
    if (timer !== null) return;
    timer = timers.setTimeout(fire, delayMs);
    timer?.unref?.();
  };
  function fire() {
    timer = null;
    if (closed) return;
    // The bookkeeping is in `.then`, which always runs after `running` is assigned (a `work` that throws at once cannot strand it).
    running = (async () => {
      try { await work(); } catch (error) { try { onError?.(error); } catch { /* a broken handler never stops the debounce */ } }
    })().then(() => {
      running = null;
      if (dirty) { dirty = false; poke(); }
    });
  }
  return {
    poke,
    settled: async () => { while (running !== null) await running; },
    close() {
      closed = true;
      dirty = false;
      if (timer !== null) { timers.clearTimeout(timer); timer = null; }
    },
  };
}
