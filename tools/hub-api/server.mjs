// The Hub API service (AD-42, AD-45): the start sequence, the port-bind singleton and a node `http` adapter over routes.mjs's pure
// `handle()`. `startService` is generic (a service name, a port, a route table), so the Host Agent (Epic 7) starts the same way;
// `startHubApi` adds this service's own part: the policy port, then recovery and the seed once the bind has won.
//
// Start order: Node >= 24.15 (HUB_API_NODE), `heavy` on PATH (HUB_API_NO_HEAVY: emulators boot through the spawn seam in
// tools/device/emulator.mjs, `bootCommand`, which wraps them in `heavy` so a stop with KillMode=mixed never kills one), bind 127.0.0.1 (EADDRINUSE is the singleton:
// HUB_API_ALREADY_RUNNING), recoverRegistry, applySeed, then `HUB_API_LISTEN port=<n>` on stdout. The bind comes first so a second
// instance never writes. A seed failure never stops the service (holds never depend on the Registry): one `HUB_API_SEED_FAILED` line
// on stderr, and the next start retries. SIGTERM and SIGINT close the server, print `HUB_API_STOP` and let the process end 0.
//
// Every seam is injected (env, policy, log, versions, onPath, createServer, now, hostId, devices, qaDevices, signals). There is no
// timer here: the keepalive of a later stream lives in stream.mjs, the one file the no-new-clock rule names (tools/clock.test.mjs).
import { realpathSync } from 'node:fs';
import { createServer as nodeCreateServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { onPath } from '../ci/lib/heavy.mjs';
import { loadPolicy } from '../ci/lib/policy.mjs';
import { exitCodeOf, withoutDeployIdentity } from '../device/claims.mjs';
import { recoverRegistry, applySeed } from '../registry/store.mjs';
import { createReadings } from './readings.mjs';
import { ROUTES, SERVICE, handle } from './routes.mjs';

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
// `req` and `res` are the minimal node shapes (`method`, `url`, async-iterable body; `writeHead`, `end`), so a test drives it with fakes.
export function requestListener(ctx) {
  return async (req, res) => {
    let body;
    let bodyError;
    try { body = await readJson(req); } catch (error) { bodyError = error; }
    const answer = await handle({ method: req.method, url: req.url, body, bodyError }, ctx);
    const text = JSON.stringify(answer.body);
    res.writeHead(answer.status, { ...answer.headers, 'Content-Length': Buffer.byteLength(text) });
    res.end(text);
  };
}

// ---- the generic service start ----

// Starts one loopback service: checks, bind (the singleton), `afterBind` (the service's own start work), then the LISTEN line.
// Returns `{server, port, stop, stopped}`; `stopped` resolves once a signal or `stop()` has closed the server. A check that fails or
// a lost bind throws a coded error (HUB_API_NODE, HUB_API_NO_HEAVY, HUB_API_ALREADY_RUNNING) with nothing bound or written.
export async function startService({
  service = SERVICE, port, routes = ROUTES, ctx = {}, afterBind,
  env: given = process.env, log = defaultLog(), versions = process.versions, onPath: hasOnPath = onPath, createServer = nodeCreateServer, signals = process,
} = {}) {
  // A service belongs to no deploy run: whatever GITHUB_* identity its environment carries never reaches a Lease or an event.
  const env = withoutDeployIdentity(given);
  if (!nodeAtLeast(versions?.node, MIN_NODE)) throw coded('HUB_API_NODE', `${service} needs Node >= ${MIN_NODE}, this is ${versions?.node ?? 'unknown'}; run it from the release's node/24.x path`);
  if (!hasOnPath('heavy', env)) throw coded('HUB_API_NO_HEAVY', `${service} needs \`heavy\` on PATH: emulators boot through it`);

  const context = { ...ctx, env, routes, log };
  const server = createServer(requestListener(context));
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
        server.close(() => { log.out('HUB_API_STOP'); resolve(); });
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
export async function startHubApi({ policy, env: given = process.env, log = defaultLog(), now, hostId, devices, qaDevices, routes = ROUTES, adbWire, inventory, hostKey, sleep, devicectl, ...seams } = {}) {
  const env = withoutDeployIdentity(given);
  const resolved = policy ?? loadPolicy().policy;
  const afterBind = async () => {
    try {
      recoverRegistry({ env, now, hostId, log: log.err });
      await applySeed({ env, devices, qaDevices, now, hostId, log: log.err, actor: { holder: 'hub-api', via: 'api' } });
    } catch (error) {
      log.err(`HUB_API_SEED_FAILED ${error?.code ?? 'ERROR'} ${oneLine(error)}`);
    }
  };
  const device = { adbWire, inventory, hostKey, sleep, devicectl };
  const readings = createReadings({ env, policy: resolved, now, hostId, log: log.err, ...device });
  return startService({ ...seams, service: SERVICE, port: resolved.api.hub_api_port, routes, ctx: { policy: resolved, now, hostId, devices, qaDevices, readings, ...device }, afterBind, env, log });
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
