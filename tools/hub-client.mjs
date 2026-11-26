// The one Hub API client (AD-26, AD-27, AD-47, AD-48): every `hub-device` verb, the Host Agent and every forward that talks to a Hub
// service goes through this file, so none of them can probe, classify, quote or decode an answer differently.
//
// `call()` is the same-host client: it probes `GET /health` first, bounded at 2 s: a Hub API that is refused, silent, not answering 200 JSON or
// not this service is `HUB_API_DOWN`, and nothing was sent. Once the request is on the wire it is bounded at the wait plus 30 s. Only a refused
// connect still proves nothing applied (`HUB_API_DOWN`); any other transport failure of a write is `HUB_API_UNKNOWN` (it may have applied). An
// `application/problem+json` answer becomes an error that carries the problem's members and `api: true`.
//
// A reset during a wait (`waitMs > 0`: the connection was open and the service died or stopped under it, Story 8.6) is `HUB_API_RESTARTING` with
// `retry: 'requeue'` and `api: false`, the same answer a `SIGTERM` gives (`api: true`): `requeueable(error)` is the one predicate every
// waiting caller uses to place the wait again with the same id (a repeat of an id the same holder holds answers the existing Lease, so a
// requeue is safe even if the crash came after the grant). `call()` itself never retries. A reset on a write with no wait stays UNKNOWN.
//
// `request({host, ...})` (Story 9.1) is the one cross-host transport: a call to the host's own front door on loopback is a `fetch`; a call to the
// peer is ssh, with one fixed option set, running `hub-client.mjs relay <method> <path>` from the peer's installed release. The relay reads the
// JSON body from the first stdin line, takes every later byte as a heartbeat, calls the peer's own loopback service and writes the status, headers
// and body back; the client turns that into a `fetch` `Response`. A client that vanishes (stdin EOF, or 3 silent intervals) makes the relay abort its
// request, so the far service records a disconnect and a forwarded wait is never left as a ghost waiter. Any failure of the ssh leg is
// `HUB_DEVICE_AWAY` (exit 75, reason `host-unreachable`). No retry, and no timer but the call's heartbeat, the relay's idle timeout and the bound kill.
//
// The deploy path never imports this file (tools/deploy-path.test.mjs). It does not import claims.mjs (which imports it) statically, so the
// exit codes of its own errors are written here and held equal to the exit table by claims.test.mjs (a thrown error's `.exit` against EXIT_CODES);
// the relay and the default `hostKey` load claims.mjs at run time only.
import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { loadPolicy } from './ci/lib/policy.mjs';

export const HUB_API_SERVICE = 'mobile-deploy-hub-api';
// The Host Agent's service name (Story 9.2): what its `/health` answers, so an installer's readback can tell the two services apart.
export const HOST_AGENT_SERVICE = 'mobile-deploy-hub-host-agent';
// The one contract number the service answers with (`/health`, `/status`) and the installer's readback and the smoke check for it.
export const HUB_API_CONTRACT = 1;
export const HEALTH_TIMEOUT_MS = 2000;
export const CALL_MARGIN_MS = 30_000;
export const DOWN_MESSAGE = 'the Hub API is not answering; registry changes are unavailable, holds still work';
export const UNKNOWN_MESSAGE = 'the Hub API did not answer after the request was sent; the change may have applied: run `hub-device registry list` to see';
export const RESTARTING_MESSAGE = 'the service went away during the wait; place the wait again with the same id';

export const hubUrl = policy => `http://127.0.0.1:${policy.api.hub_api_port}`;

const coded = (code, message, extra) => Object.assign(new Error(message), { code, exit: 1, ...extra });
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const refused = error => error?.cause?.code === 'ECONNREFUSED' || error?.code === 'ECONNREFUSED';
const RESET_CODES = new Set(['ECONNRESET', 'EPIPE', 'UND_ERR_SOCKET', 'UND_ERR_CLOSED']);
const reset = error => RESET_CODES.has(error?.code) || RESET_CODES.has(error?.cause?.code);

// Whether a failed call is one to place again: a wait the service went away under (this client) or the service's own 503 on a stop.
export const requeueable = error => error?.retry === 'requeue';

// Settles with `work`, or rejects as soon as `signal` aborts (a fetch that ignores its signal is still bounded).
function bounded(work, signal) {
  if (!signal || typeof signal.addEventListener !== 'function') return work;
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new Error('aborted'));
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
    if (signal.aborted) onAbort();
  });
}

const parseJson = text => { try { return JSON.parse(text); } catch { return undefined; } };

// One request, bounded: `{status, type, text}`.
async function exchange(fetchImpl, url, init, signal) {
  return bounded((async () => {
    const response = await fetchImpl(url, { ...init, signal });
    return { status: response.status, type: String(response.headers?.get?.('content-type') ?? ''), text: await response.text() };
  })(), signal);
}

async function probe({ fetchImpl, base, timeout, healthTimeoutMs, down }) {
  const gone = () => coded('HUB_API_DOWN', down);
  let answer;
  try { answer = await exchange(fetchImpl, `${base}/health`, { method: 'GET', headers: { accept: 'application/json' } }, timeout(healthTimeoutMs)); } catch { throw gone(); }
  const body = answer.status === 200 ? parseJson(answer.text) : undefined;
  if (!isObject(body) || body.service !== HUB_API_SERVICE) throw gone();
}

// The members of a problem+json body other than the ones the error carries as its own fields (and never an Error's own: message, name, stack, cause).
const BASE = new Set(['type', 'title', 'status', 'detail', 'code', 'exit', 'reason', 'message', 'name', 'stack', 'cause']);

function problemError(body, status) {
  const extras = Object.fromEntries(Object.entries(body).filter(([key]) => !BASE.has(key)));
  return Object.assign(new Error(typeof body.detail === 'string' ? body.detail : String(body.code)), extras, {
    code: body.code, status: Number.isInteger(body.status) ? body.status : status, exit: body.exit, reason: body.reason, problem: body, api: true,
  });
}

// `call({method, path, body, waitMs}, {policy, fetchImpl, timeout, healthTimeoutMs, down})`: `{status, body}` for a 2xx answer, else it
// throws HUB_API_DOWN, HUB_API_UNKNOWN, HUB_API_RESTARTING (a reset during a wait), HUB_API_ERROR (a GET answered with something that is not a problem) or the problem's own error.
// `down` and `unknown` word the two client errors for a caller that is not the registry. `fetchImpl` defaults to the global `fetch` (read at call time) and `timeout(ms)` to `AbortSignal.timeout`; both are test seams.
export async function call({ method = 'GET', path, body, waitMs = 0 }, { policy, fetchImpl, timeout, healthTimeoutMs = HEALTH_TIMEOUT_MS, down = DOWN_MESSAGE, unknown = UNKNOWN_MESSAGE } = {}) {
  const send = fetchImpl ?? globalThis.fetch;
  const clock = timeout ?? (ms => AbortSignal.timeout(ms));
  const base = hubUrl(policy);
  const verb = String(method).toUpperCase();
  const write = verb !== 'GET';
  await probe({ fetchImpl: send, base, timeout: clock, healthTimeoutMs, down });
  const init = { method: verb, headers: { accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }) } };
  if (body !== undefined) init.body = JSON.stringify(body);
  // A write that may have applied says so; a GET cannot change anything, so its failure is only "down".
  const unclear = () => (write ? coded('HUB_API_UNKNOWN', unknown) : coded('HUB_API_DOWN', down));
  let answer;
  try { answer = await exchange(send, `${base}${path}`, init, clock(waitMs + CALL_MARGIN_MS)); } catch (error) {
    if (refused(error)) throw coded('HUB_API_DOWN', down);
    if (waitMs > 0 && reset(error)) throw coded('HUB_API_RESTARTING', RESTARTING_MESSAGE, { reason: 'restarting', retry: 'requeue', api: false });
    throw unclear();
  }
  const parsed = parseJson(answer.text);
  if (answer.status >= 200 && answer.status < 300) {
    if (parsed === undefined) throw write ? coded('HUB_API_UNKNOWN', unknown) : coded('HUB_API_ERROR', `the Hub API answered ${answer.status} with a body that is not JSON`);
    return { status: answer.status, body: parsed };
  }
  if (answer.type.includes('application/problem+json') && isObject(parsed) && typeof parsed.code === 'string') throw problemError(parsed, answer.status);
  throw write ? coded('HUB_API_UNKNOWN', unknown) : coded('HUB_API_ERROR', `the Hub API answered ${answer.status}, which is not a problem document`);
}

// ---- cross-host calls (Story 9.1, AD-26) ----

// The peer's installed release, anchored at the login home where sshd starts the command (the catch-up's and hosts.mjs's precedent): both homes
// differ (/home/... and /Users/...), and a single-quoted word cannot expand $HOME. Neither word goes through a PATH lookup.
export const PEER_NODE = '.local/share/mise/installs/node/24/bin/node';
export const PEER_SCRIPT = '.local/share/mobile-deploy-hub/current/tools/hub-client.mjs';
export const HOST_KEYS = Object.freeze(['linux', 'mac']);
export const RELAY_METHODS = Object.freeze(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
// ssh outlives the call's own bound by this much before it is killed.
export const SSH_KILL_GRACE_MS = 10_000;
export const SSH_PATH = '/usr/bin/ssh';
export const RELAY_USAGE = 'usage: hub-client.mjs relay <GET|POST|PUT|PATCH|DELETE> </path>   (body: first stdin line, then heartbeat newlines)\n';
const NO_BODY = new Set([204, 205, 304]);
// Headers that describe the relay's own hop or the encoding of bytes `fetch` already decoded; the body is sent exactly, so they are not carried.
const HOP_HEADERS = new Set(['connection', 'keep-alive', 'transfer-encoding', 'content-encoding', 'content-length']);

const globalTimers = () => ({ setInterval, clearInterval, setTimeout, clearTimeout });
const usageError = message => coded('HUB_USAGE', message, { exit: 2 });
const checkKey = key => { if (!HOST_KEYS.includes(key)) throw usageError(`"${key}" is not a host key (one of ${HOST_KEYS.join(', ')})`); return key; };
const defaultHostKey = async () => (await import('./device/claims.mjs')).hostKey();
// The code of the relay's own refusal (no host key, no policy) always starts `HUB_`, so the client reads it as AWAY; a plain cause (ENOENT) is HUB_RELAY_ERROR.
const refusalCode = error => (String(error?.code ?? '').startsWith('HUB_') ? String(error.code) : 'HUB_RELAY_ERROR');
// A failed peer-side fetch with no cause code; deliberately not `HUB_`, so the client keeps it on the TypeError path.
const RELAY_FETCH_FAILED = 'RELAY_FETCH_FAILED';

// One word for a POSIX shell (and zsh): single quotes, with `'` written as `'\''` (the catchup.mjs escaping).
export const quoteWord = word => `'${String(word).replaceAll("'", "'\\''")}'`;

// The one remote command: single-quoted words joined by spaces.
export const remoteCommand = ({ method, path }, { node = PEER_NODE, script = PEER_SCRIPT } = {}) => [node, script, 'relay', String(method).toUpperCase(), path].map(quoteWord).join(' ');

// The one ssh option set (AD-26), then the alias and the command.
export const sshArgv = (alias, command, policy) => [
  '-T', '-o', 'BatchMode=yes', '-o', `ConnectTimeout=${policy.api.peer_connect_timeout_s}`, '-o', 'ControlMaster=no', '-o', 'ControlPath=none',
  '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=2', alias, command,
];

// The ssh alias of a host: `devices[<key>].host`, for the two host keys only.
export function aliasFor(key, devices) {
  checkKey(key);
  const alias = devices?.[key]?.host;
  if (typeof alias !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9.-]*$/.test(alias)) throw usageError(`devices.${key}.host "${alias}" is not a host name`);
  return alias;
}

// The port of a host's front door: the Hub API on linux, the Host Agent on the Mac.
export function frontDoorPort(policy, key) {
  checkKey(key);
  return key === 'linux' ? policy.api.hub_api_port : policy.api.host_agent_port;
}

// The call's bound (AD-48): the wait, any provision budget, and the margin.
export const boundMs = ({ waitMs = 0, budgetMs = 0 } = {}) => waitMs + budgetMs + CALL_MARGIN_MS;

const away = (host, alias, policy, detail) => coded('HUB_DEVICE_AWAY', `the ${host} host (ssh alias ${alias}) is not reachable: ${detail} (connect timeout ${policy.api.peer_connect_timeout_s} s)`, {
  exit: 75, reason: 'host-unreachable', api: false, host, alias,
});

// The relay's head: line 1 of its stdout. Success carries status and headers, failure the cause code of the peer-side fetch.
function parseHead(line) {
  const head = parseJson(line);
  if (!isObject(head) || head.format !== 1) return undefined;
  if (isObject(head.error) && typeof head.error.code === 'string') return head;
  if (Number.isInteger(head.status) && head.status >= 200 && head.status <= 599 && isObject(head.headers)) return head;
  return undefined;
}

// A call to the peer over ssh: resolves with the `Response` the relay wrote, rejects with the peer-side fetch failure as a TypeError (cause.code)
// or with HUB_DEVICE_AWAY for anything the ssh leg does wrong.
function viaSsh({ host, verb, path, body, bound }, { policy, devices, sshImpl, timers }) {
  const alias = aliasFor(host, devices);
  const argv = sshArgv(alias, remoteCommand({ method: verb, path }), policy);
  // Serialized before ssh is spawned: a body that cannot be JSON is the caller's error, never an AWAY.
  const bodyLine = `${body === undefined ? '' : JSON.stringify(body)}\n`;
  return new Promise((resolve, reject) => {
    let settled = false;
    let child;
    let heartbeat;
    let killer;
    const chunks = [];
    let stderr = '';
    const end = (settle, value) => {
      if (settled) return;
      settled = true;
      timers.clearInterval(heartbeat);
      timers.clearTimeout(killer);
      try { child?.stdin?.end(); } catch { /* the pipe is already gone */ }
      settle(value);
    };
    const lost = detail => end(reject, away(host, alias, policy, detail));
    try {
      child = (sshImpl ?? (args => spawn(SSH_PATH, args, { stdio: ['pipe', 'pipe', 'pipe'] })))(argv);
      child.stdin.on('error', () => {});
      child.stdout.on('data', chunk => { chunks.push(Buffer.from(chunk)); });
      child.stderr?.on?.('data', chunk => { stderr = (stderr + String(chunk)).slice(-500); });
      child.on('error', error => lost(`ssh did not start (${error?.code ?? error?.message ?? error})`));
      child.on('close', code => {
        if (settled) return;
        const out = Buffer.concat(chunks);
        const newline = out.indexOf(10);
        const head = newline === -1 ? undefined : parseHead(out.subarray(0, newline).toString('utf8'));
        // The last stderr line is the cause (a "Warning: Permanently added" banner comes first); it is named for every exit with no answer.
        const why = stderr.trim().split('\n').filter(Boolean).at(-1) ?? '';
        if (code === 255 || code === null || head === undefined) return lost(code === 255 && why ? why : `ssh ended with ${code === null ? 'a signal' : `exit ${code}`} and no answer${why ? ` (${why})` : ''}`);
        if (head.error) {
          const cause = head.error.code;
          // The relay's own refusal (no host key, no policy) is this host being unusable, not an API transport failure.
          if (cause.startsWith('HUB_') && cause !== 'HUB_RELAY_USAGE') return lost(`the relay refused: ${head.error.message ?? cause} (${cause})`);
          return end(reject, Object.assign(new TypeError('fetch failed'), { cause: { code: cause } }));
        }
        if (code !== 0) return lost(`ssh ended with exit ${code} before the answer was complete`);
        try {
          end(resolve, new Response(NO_BODY.has(head.status) ? null : out.subarray(newline + 1), { status: head.status, headers: head.headers }));
        } catch { lost('the relay answered with a head that is not a response'); }
      });
      child.stdin.write(bodyLine);
      heartbeat = timers.setInterval(() => { try { child.stdin.write('\n'); } catch { /* the call is ending */ } }, policy.api.stream_keepalive_s * 1000);
      killer = timers.setTimeout(() => {
        try { child.kill(); } catch { /* already gone */ }
        lost(`no answer within ${Math.round((bound + SSH_KILL_GRACE_MS) / 1000)} s`);
      }, bound + SSH_KILL_GRACE_MS);
    } catch (error) {
      try { child?.kill(); } catch { /* already gone */ }
      lost(`ssh did not start (${error?.code ?? error?.message ?? error})`);
    }
  });
}

// `request({host, method, path, body, waitMs, budgetMs}, {policy, devices, hostKey, fetchImpl, sshImpl, timers, timeout})` -> `Response`.
// `host` is `linux` or `mac`. This host's own front door is a `fetch` on loopback; the other host is one ssh call to its relay. A same-host
// failure is the `fetch` error unchanged; no retry here, no classification either: a caller classifies it as it does for `call()`.
export async function request({ host, method = 'GET', path, body, waitMs = 0, budgetMs = 0 }, seams = {}) {
  checkKey(host);
  const policy = seams.policy ?? loadPolicy().policy;
  const verb = String(method).toUpperCase();
  const own = await (seams.hostKey ?? defaultHostKey)();
  const bound = boundMs({ waitMs, budgetMs });
  if (host === own) {
    const send = seams.fetchImpl ?? globalThis.fetch;
    const signal = (seams.timeout ?? (ms => AbortSignal.timeout(ms)))(bound);
    const init = { method: verb, headers: { accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, signal };
    if (body !== undefined) init.body = JSON.stringify(body);
    return bounded(send(`http://127.0.0.1:${frontDoorPort(policy, host)}${path}`, init), signal);
  }
  const devices = seams.devices ?? (await import('./ci/lib/devices.mjs')).loadDevices();
  return viaSsh({ host, verb, path, body, bound }, { policy, devices, sshImpl: seams.sshImpl, timers: seams.timers ?? globalTimers() });
}

// The peer side: `relay({method, path, stdin, stdout, policy, hostKey, fetchImpl, timers})` -> the exit code. stdin line 1 is the JSON body (empty for
// none); every later byte is a heartbeat. stdin EOF, or 3 heartbeat intervals with no byte, aborts the loopback request and the relay writes
// nothing (exit 1). Otherwise stdout gets one JSON head line and then the raw body.
export async function relay({ method, path, stdin, stdout, policy: given, hostKey: keyOf, fetchImpl, timers } = {}) {
  const emit = (head, bytes) => stdout.write(bytes === undefined ? `${JSON.stringify({ format: 1, ...head })}\n` : Buffer.concat([Buffer.from(`${JSON.stringify({ format: 1, ...head })}\n`), bytes]));
  const refuse = (code, message, exit) => { emit({ error: { code, message } }); return exit; };
  if (!RELAY_METHODS.includes(method)) return refuse('HUB_RELAY_USAGE', `the method must be one of ${RELAY_METHODS.join(', ')}`, 2);
  if (typeof path !== 'string' || !path.startsWith('/') || /[\s\u0000-\u001f\u007f]/.test(path)) return refuse('HUB_RELAY_USAGE', 'the path must start with / and hold no whitespace or control characters', 2);
  let policy;
  try { policy = given ?? loadPolicy().policy; } catch (error) { return refuse(refusalCode(error), String(error?.message ?? error).split('\n')[0], 1); }
  const clock = timers ?? globalTimers();
  const abort = new AbortController();
  let gone = false;
  let line;
  let settleLine;
  let pending = Buffer.alloc(0);
  const first = new Promise(resolve => { settleLine = resolve; });
  const vanish = () => { gone = true; abort.abort(new Error('the client went away')); settleLine(null); };
  // One timer, re-armed by `.refresh()` on every byte (never a function that schedules itself).
  const idle = clock.setTimeout(vanish, 3 * policy.api.stream_keepalive_s * 1000);
  const onData = chunk => {
    idle.refresh?.();
    if (line !== undefined) return;
    pending = Buffer.concat([pending, Buffer.from(chunk)]);
    const newline = pending.indexOf(10);
    if (newline === -1) return;
    line = pending.subarray(0, newline).toString('utf8');
    settleLine(line);
  };
  stdin.on('data', onData);
  stdin.on('end', vanish);
  stdin.on('close', vanish);
  stdin.on('error', vanish);
  const done = code => {
    clock.clearTimeout(idle);
    for (const [name, listener] of [['data', onData], ['end', vanish], ['close', vanish], ['error', vanish]]) stdin.removeListener?.(name, listener);
    stdin.pause?.();
    return code;
  };
  // The listeners are on before anything is awaited, so a stdin that is already flowing loses no byte.
  let port;
  try { port = frontDoorPort(policy, await (keyOf ?? defaultHostKey)()); } catch (error) {
    if (!gone) emit({ error: { code: refusalCode(error), message: String(error?.message ?? error).split('\n')[0] } });
    return done(1);
  }
  const text = await first;
  if (text === null || gone) return done(1);
  let body;
  if (text.trim() !== '') {
    body = parseJson(text);
    if (body === undefined) { emit({ error: { code: 'HUB_RELAY_USAGE', message: 'the body line is not JSON' } }); return done(2); }
    if (method === 'GET') { emit({ error: { code: 'HUB_RELAY_USAGE', message: 'a GET carries no body' } }); return done(2); }
  }
  let answer;
  let failure;
  try {
    const init = { method, headers: { accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, signal: abort.signal };
    if (body !== undefined) init.body = JSON.stringify(body);
    const response = await bounded((fetchImpl ?? globalThis.fetch)(`http://127.0.0.1:${port}${path}`, init), abort.signal);
    answer = { response, bytes: Buffer.from(await bounded(response.arrayBuffer(), abort.signal)) };
  } catch (error) { failure = error; }
  if (gone) return done(1);
  if (failure) {
    emit({ error: { code: String(failure?.cause?.code ?? failure?.code ?? RELAY_FETCH_FAILED), message: String(failure?.message ?? failure).split('\n')[0] } });
    return done(0);
  }
  const headers = Object.fromEntries([...answer.response.headers.entries()].filter(([name]) => !HOP_HEADERS.has(name.toLowerCase())));
  emit({ status: answer.response.status, headers }, NO_BODY.has(answer.response.status) ? Buffer.alloc(0) : answer.bytes);
  return done(0);
}

// `main(argv, seams)`: the process entry, `hub-client.mjs relay <method> <path>`. Anything else prints the usage on stderr and is 2.
export async function main(argv = [], { stdin = process.stdin, stdout = process.stdout, stderr = process.stderr, ...seams } = {}) {
  const [verb, method, path, ...rest] = argv;
  if (verb !== 'relay' || method === undefined || path === undefined || rest.length > 0) {
    stderr.write(RELAY_USAGE);
    return 2;
  }
  return relay({ method, path, stdin, stdout, ...seams });
}

let entry = null;
try { entry = process.argv[1] ? pathToFileURL(realpathSync(process.argv[1])).href : null; } catch { /* not run as a file */ }
if (entry === import.meta.url) {
  // No top-level await: the module must finish evaluating before the default `hostKey` imports claims.mjs (which imports this file).
  main(process.argv.slice(2)).then(code => { process.exitCode = code; process.stdin.destroy(); });
}
