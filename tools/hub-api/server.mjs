// The Hub API service (AD-42, AD-45): the start sequence, the port-bind singleton and a node `http` adapter over routes.mjs's pure
// `handle()`. `startService` is generic (a service name, a port, a route table), so the Host Agent (Epic 7) starts the same way;
// `startHubApi` adds this service's own part: the policy port, then recovery and the seed once the bind has won.
//
// Start order: Node >= 24.15 (HUB_API_NODE), `heavy` on PATH (HUB_API_NO_HEAVY: emulators boot through the spawn seam in
// tools/device/emulator.mjs, `bootCommand`, which wraps them in `heavy` so a stop with KillMode=mixed never kills one), bind 127.0.0.1 (EADDRINUSE is the singleton:
// HUB_API_ALREADY_RUNNING), recoverRegistry, applySeed, then `HUB_API_LISTEN port=<n>` on stdout. The bind comes first so a second
// instance never writes. A seed failure never stops the service (holds never depend on the Registry): one `HUB_API_SEED_FAILED` line
// on stderr, and the next start retries. SIGTERM and SIGINT end every open lease wait (503 HUB_API_RESTARTING), close the server, print `HUB_API_STOP` and let the process end 0.
//
// Every seam is injected (env, policy, log, versions, onPath, createServer, now, hostId, devices, qaDevices, signals). There is no
// timer here: the keepalive of every open stream and the change debounce live in stream.mjs, the one file the no-new-clock rule names (tools/clock.test.mjs).
import { mkdirSync, realpathSync, watch as fsWatch } from 'node:fs';
import { createServer as nodeCreateServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { onPath } from '../ci/lib/heavy.mjs';
import { eventDir, followEvents } from '../ci/lib/events.mjs';
import { lockDir } from '../ci/lib/lock.mjs';
import { loadPolicy } from '../ci/lib/policy.mjs';
import { trackDevices as realTrackDevices } from '../device/adb-wire.mjs';
import { createLeaseWaits, exitCodeOf, hostKey as realHostKey, phoneReadings, withoutDeployIdentity } from '../device/claims.mjs';
import { observeHost, observeOffThread } from '../device/observe-thread.mjs';
import { retirement } from '../registry/match.mjs';
import { recoverRegistry, applySeed, readRegistry } from '../registry/store.mjs';
import { createChangeFeed, hubPaths } from './changes.mjs';
import { createReadings, deviceCtx } from './readings.mjs';
import { createSnapshot } from './snapshot.mjs';
import { createStream } from './stream.mjs';
import { createTrack } from './track.mjs';
import { ROUTES, SERVICE, handle, statusDocument } from './routes.mjs';

export const HOST = '127.0.0.1';
export const MIN_NODE = '24.15';
export const MAX_BODY_BYTES = 1024 * 1024;

const coded = (code, message, extra) => Object.assign(new Error(message), { code, exit: exitCodeOf({ code }), ...extra });
const oneLine = value => String(value?.message ?? value).replace(/\s+/g, ' ').trim();

// Stdout and stderr as two functions, so a test reads each. The default writes to the process.
const defaultLog = () => ({ out: line => console.log(line), err: line => console.error(line) });

// True when the dotted version (`24.15.0`, with or without a leading v) is at least `minimum` (`24.15`).
export function nodeAtLeast(version, minimum) {
  const parse = text => String(text ?? '').replace(/^v/, '').split('.').map(part => Number.parseInt(part, 10));
  const have = parse(version);
  const want = parse(minimum);
  for (let index = 0; index < want.length; index += 1) {
    const a = Number.isNaN(have[index]) || have[index] === undefined ? 0 : have[index];
    if (a !== want[index]) return a > want[index];
  }
  return true;
}

// `onPath` is the one PATH resolver (tools/ci/lib/heavy.mjs): the emulator spawn seam decides from the same function, so the
// service's `heavy` check and the seam cannot disagree. Re-exported here because the service's callers and tests import it from here.
export { onPath };

// ---- the node http adapter ----

async function readJson(req) {
  if (req.method !== 'POST') return undefined;
  const chunks = [];
  let size = 0;
  // Keep reading (and discarding) past the limit: destroying the request mid-body can show the client ECONNRESET instead of the 413.
  for await (const chunk of req) {
    size += chunk.length;
    if (size <= MAX_BODY_BYTES) chunks.push(chunk);
  }
  if (size > MAX_BODY_BYTES) throw coded('HUB_USAGE', `the request body is over ${MAX_BODY_BYTES} bytes`, { status: 413, reason: 'too-large' });
  const text = Buffer.concat(chunks).toString('utf8');
  if (text.trim() === '') return undefined;
  try { return JSON.parse(text); } catch { throw coded('HUB_USAGE', 'the request body is not valid JSON', { status: 400, reason: 'bad-json' }); }
}

// The `(req, res)` listener for `createServer`: reads a JSON body (POST only, up to 1 MiB), calls `handle`, writes its answer.
// `req` and `res` are the minimal node shapes (`method`, `url`, async-iterable body; `writeHead`, `end`, and `on` for `close`), so a test
// drives it with fakes.
//
// Nothing is written until the outcome (Story 7.2, AD-37): a wait keeps its connection open with no status line and no header. Every
// request has an abort signal that aborts when `res` closes before the answer was fully written (the client went away): `handle` passes
// it to the route, and an answer for an aborted request is dropped, not written. `ctx.onRequest` (Story 8.3) is called first for every
// request, in a try block that never changes an answer: the service's track socket is reopened by a request and by nothing else.
// `listener.drain()` resolves when every request that is past its body (being handled, or being answered) has ended: a stop awaits it so the answers of the waits it just ended are written.
export function requestListener(ctx) {
  const inflight = new Set();
  const listener = async (req, res) => {
    try { ctx.onRequest?.(); } catch { /* a request hook never changes an answer */ }
    const controller = new AbortController();
    res.on?.('close', () => { if (!res.writableFinished) controller.abort(new Error('the connection closed before the answer was written')); });
    let body;
    let bodyError;
    try { body = await readJson(req); } catch (error) { bodyError = error; }
    const work = (async () => {
      const answer = await handle({ method: req.method, url: req.url, headers: req.headers, body, bodyError, signal: controller.signal }, ctx);
      if (controller.signal.aborted) return;
      if (answer.stream) {
        // A stream's work ends here (so `drain()` never waits on one): the head, then the stream writes to `res` until it or the client ends.
        res.writeHead(answer.status, answer.headers);
        try { answer.stream.open(res); } catch (error) { ctx.log?.err?.(`HUB_API_ERROR stream ${oneLine(error)}`); res.destroy?.(); }
        return;
      }
      const text = JSON.stringify(answer.body);
      res.writeHead(answer.status, { ...answer.headers, 'Content-Length': Buffer.byteLength(text) });
      res.end(text);
    })();
    inflight.add(work);
    try { await work; } finally { inflight.delete(work); }
  };
  listener.drain = async () => { await Promise.allSettled([...inflight]); };
  return listener;
}

// ---- the generic service start ----

// Starts one loopback service: checks, bind (the singleton), `afterBind` (the service's own start work), then the LISTEN line.
// `onStop` (Story 8.3) is awaited first by a stop, before the open waits end and the server closes (the Hub API closes its track socket there).
// Returns `{server, port, stop, stopped}`; `stopped` resolves once a signal or `stop()` has closed the server. A check that fails or
// a lost bind throws a coded error (HUB_API_NODE, HUB_API_NO_HEAVY, HUB_API_ALREADY_RUNNING) with nothing bound or written.
export async function startService({
  service = SERVICE, port, routes = ROUTES, ctx = {}, afterBind, onStop,
  env: given = process.env, log = defaultLog(), versions = process.versions, onPath: hasOnPath = onPath, createServer = nodeCreateServer, signals = process,
} = {}) {
  // A service belongs to no deploy run: whatever GITHUB_* identity its environment carries never reaches a Lease or an event.
  const env = withoutDeployIdentity(given);
  if (!nodeAtLeast(versions?.node, MIN_NODE)) throw coded('HUB_API_NODE', `${service} needs Node >= ${MIN_NODE}, this is ${versions?.node ?? 'unknown'}; run it from the release's node/24.x path`);
  if (!hasOnPath('heavy', env)) throw coded('HUB_API_NO_HEAVY', `${service} needs \`heavy\` on PATH: emulators boot through it`);

  // The registry of this service's lease waits (claims.mjs): a stop ends every open wait with HUB_API_RESTARTING before it closes.
  const context = { ...ctx, env, routes, log, waits: ctx.waits ?? createLeaseWaits({ now: ctx.now, ...(ctx.processStart ? { startOf: ctx.processStart } : {}) }) };
  const listener = requestListener(context);
  const server = createServer(listener);
  await new Promise((resolve, reject) => {
    server.once('error', error => reject(error?.code === 'EADDRINUSE'
      ? coded('HUB_API_ALREADY_RUNNING', `${service} is already running: ${HOST}:${port} is taken`)
      : error));
    server.listen(port, HOST, resolve);
  });
  server.on('error', error => log.err(`HUB_API_ERROR server ${oneLine(error)}`));

  let stop;
  const stopped = new Promise(resolve => {
    let called = false;
    const handlers = ['SIGTERM', 'SIGINT'].map(name => [name, () => { stop(); }]);
    stop = () => {
      if (!called) {
        called = true;
        for (const [name, handler] of handlers) signals.removeListener?.(name, handler);
        // Open waits answer 503 HUB_API_RESTARTING (their tickets aborted) and those answers are written before the server closes.
        (async () => {
          try { await onStop?.(); await context.waits.shutdown(); await listener.drain?.(); } catch (error) { log.err(`HUB_API_ERROR stop ${oneLine(error)}`); }
          server.close(() => { log.out('HUB_API_STOP'); resolve(); });
        })();
      }
      return stopped;
    };
    for (const [name, handler] of handlers) signals.once(name, handler);
  });

  try {
    if (afterBind) await afterBind({ server });
  } catch (error) {
    await stop();
    throw error;
  }
  const bound = typeof server.address === 'function' ? server.address() : null;
  const actual = bound && typeof bound === 'object' && Number.isInteger(bound.port) ? bound.port : port;
  log.out(`HUB_API_LISTEN port=${actual}`);
  return { server, port: actual, stop, stopped };
}

// ---- the Hub API ----

// The Hub API: the policy's port, then (after the bind has won) recovery and the seed. A recovery or seed error is one line on stderr
// and the service keeps serving; `/health` says `registry: unreadable` when the file is the problem. The device seams (`adbWire`,
// `inventory`, `hostKey`, `sleep`, `devicectl`) go into the request context and into the one readings cache (Story 6.10); a refresh of
// it is started by a read, never by a timer.
//
// One host snapshot per service (Story 8.2, AD-44: tools/hub-api/snapshot.mjs): the inventory, the adb listing and the process starts are
// gathered in a worker thread, the first gather started right after the bind, and every read and wait answers from it (`snapshot`,
// `inventory`, `adbQuery`, `processStart` and `liveStart` in the request context). The readings cache's probe refreshes it, then maps the
// adb listing through it. Test seams: `observe` (the gather), `snapshot`, `inventory` and `adbQuery` (replace the snapshot's in the
// context), and `processStart` / `liveStart`, which are the snapshot's fallback readers (a pid it has not seen), never the request
// path's own. A test that injects `inventory` or `adbWire` gets a gather that uses them in the calling thread (a function does not
// cross into a worker).
// The change feed's watcher: the injected `watch` when a test passed one, else null when the host is faked (no real watcher on a faked
// service's temp dirs), else node's `fs.watch`.
export const watchFor = ({ watch, faked }) => (watch !== undefined ? watch : faked ? null : fsWatch);

export async function startHubApi({ policy, env: given = process.env, log = defaultLog(), now, hostId, devices, qaDevices, routes = ROUTES, adbWire, inventory, hostKey, sleep, devicectl, observe, snapshot: injected, adbQuery, processStart, liveStart, trackDevices, stream: injectedStream, watch: injectedWatch, ...seams } = {}) {
  const env = withoutDeployIdentity(given);
  const resolved = policy ?? loadPolicy().policy;
  const afterBind = async () => {
    try {
      recoverRegistry({ env, now, hostId, log: log.err });
      await applySeed({ env, devices, qaDevices, now, hostId, log: log.err, actor: { holder: 'hub-api', via: 'api' } });
    } catch (error) {
      log.err(`HUB_API_SEED_FAILED ${error?.code ?? 'ERROR'} ${oneLine(error)}`);
    }
    // The first gather starts after the bind has won, and is never waited for here: a read that needs it awaits `snapshot.ready()`.
    Promise.resolve().then(() => snapshot.refresh()).then(() => track.ensure()).catch(error => log.err(`HUB_API_TRACK_FAILED ${oneLine(error)}`));
    // The change feed (Story 8.5): the directories exist (a watch needs them, and a writer creates them lazily), then the watchers arm and
    // the baseline is primed. `start()` is never waited for: it renders, and a read that needs the snapshot awaits it.
    for (const [dir, options] of [[lockDir(env), { recursive: true }], [eventDir(env), { recursive: true, mode: 0o700 }]]) {
      try { mkdirSync(dir, options); } catch (error) { log.err(`HUB_API_WATCH_FAILED ${dir} ${oneLine(error)}`); }
    }
    feed.start();
  };
  const inThread = inventory !== undefined || adbWire !== undefined;
  const snapshot = injected ?? createSnapshot({
    env, now, log: log.err,
    ...(processStart ? { startOf: processStart } : {}), ...(liveStart ? { liveStartOf: liveStart } : {}),
    observe: observe ?? (inThread ? ({ env: seen }) => observeHost({ env: seen, inventory, adbWire, ...(sleep ? { sleep } : {}) }) : ({ env: seen }) => observeOffThread({ env: seen })),
  });
  const device = {
    adbWire, hostKey, sleep, devicectl,
    inventory: inventory ?? snapshot.inventory, adbQuery: adbQuery ?? snapshot.adbQuery,
    processStart: snapshot.processStart, liveStart: snapshot.liveStart,
  };
  // The readings probe: a refresh of the snapshot (the host asked again), then the phones' states mapped from it. Nothing is scanned or
  // queried on the main thread.
  const probe = async phones => { await snapshot.refresh(); return phoneReadings(phones, deviceCtx({ env, now, log: { err: log.err }, ...device })); };
  const readings = createReadings({ env, policy: resolved, now, hostId, log: log.err, hostKey, probe });
  // The one track socket (Story 8.3, tools/hub-api/track.mjs): the real `trackDevices` unless a test fakes the host (it injected `observe`,
  // `inventory`, `adbWire`, `snapshot` or `adbQuery` without a `trackDevices`), because a faked inventory can list a server that is not
  // there. It is opened after the first gather and by a request, never by a timer, and closed by a stop.
  const faked = observe !== undefined || inventory !== undefined || adbWire !== undefined || injected !== undefined || adbQuery !== undefined;
  const keyOf = hostKey ?? realHostKey;
  const records = () => {
    const key = keyOf({ env });
    return readRegistry({ env, devices, qaDevices, warn: () => {} }).resources.filter(record => retirement(record) === null && record.kind === 'phone' && record.host === key);
  };
  const track = createTrack({ env, now, hostKey: keyOf, records, snapshot, readings, open: trackDevices !== undefined ? trackDevices : faked ? null : realTrackDevices, log: log.err });
  // The one stream (Story 8.4, tools/hub-api/stream.mjs): `GET /stream`'s hub. Its keepalive is the policy's, owned by each open connection.
  // A stop closes it after the track, so a stop never hangs on an open subscriber and a later `GET /stream` is 503 HUB_API_RESTARTING.
  const stream = injectedStream ?? createStream({ now, keepaliveMs: resolved.api.stream_keepalive_s * 1000 });
  const ctx = { policy: resolved, now, hostId, devices, qaDevices, readings, snapshot, stream, onRequest: () => track.ensure(), ...device };
  // The change feed (Story 8.5, tools/hub-api/changes.mjs): `fs.watch` on the lock dir, `emulators/`, every `<name>.lock|.queue|.reservations`
  // and the event dir, so a change by any process (hub-device, a deploy job, this service) is one trailing re-read: the new Event Log lines
  // as `event` frames and, when the document changed for a reason other than time, one `status` frame. Real `fs.watch` unless a test faked
  // the host (the track socket's rule): a real watcher on a faked service's temp dirs would add frames nondeterministically, so there
  // none runs unless the test passes `watch`. The re-read renders the one status builder at a fixed instant (`at`).
  // Every read of the status view goes through `now: () => at`, except the stamp of the adb listing (the snapshot's own clock: a gather time,
  // or the live clock while the track socket is open). A frame says the listing was taken no later than `at`; the steady render the feed
  // compares pins it to `at`, so a listing that is merely re-read later is not a difference.
  const stamped = (at, steady) => async (...args) => {
    const answer = await ctx.adbQuery(...args);
    return typeof answer?.checked_at === 'number' ? { ...answer, checked_at: steady ? at : Math.min(answer.checked_at, at) } : answer;
  };
  const feed = createChangeFeed({
    stream, now: now ?? Date.now, log: log.err,
    render: (at, { steady = false } = {}) => statusDocument({ ...ctx, env, now: () => at, adbQuery: stamped(at, steady) }),
    paths: () => hubPaths(env),
    watch: watchFor({ watch: injectedWatch, faked }),
    follow: () => followEvents({ env, now, hostId, log: log.err }),
  });
  return startService({
    ...seams, service: SERVICE, port: resolved.api.hub_api_port, routes, ctx,
    // A stop closes the feed first (no re-read starts), then the track and the stream.
    afterBind, onStop: () => { try { feed.close(); } finally { try { track.stop(); } finally { stream.close(); } } }, env, log,
  });
}

// The process entry: starts the service and ends 0 after a stop. An error prints `<CODE> <message>` on stderr and exits with its `exit`.
export async function main({ log = defaultLog(), ...opts } = {}) {
  try {
    const running = await startHubApi({ log, ...opts });
    await running.stopped;
    return 0;
  } catch (error) {
    log.err(`${error?.code ?? 'HUB_API_ERROR'} ${oneLine(error)}`);
    return Number.isInteger(error?.exit) ? error.exit : exitCodeOf(error);
  }
}

const entry = process.argv[1] ? pathToFileURL(realpathSync(process.argv[1])).href : null;
if (entry === import.meta.url) process.exitCode = await main();
