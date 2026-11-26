// The same-host Hub API client (AD-26, AD-27): one route-generic `call()` that every `hub-device` verb which talks to the Hub API goes
// through (the registry verbs today; Epic 7's leases through the API and 6.10's register-from-discovery later), so none of them can
// probe, classify or decode an answer differently.
//
// `call()` probes `GET /health` first, bounded at 2 s: a Hub API that is refused, silent, not answering 200 JSON or not this service is
// `HUB_API_DOWN`, and nothing was sent. Once the request is on the wire it is bounded at the wait plus 30 s. Only a refused connect still
// proves nothing applied (`HUB_API_DOWN`); any other transport failure of a write is `HUB_API_UNKNOWN` (it may have applied). An
// `application/problem+json` answer becomes an error that carries the problem's members and `api: true`.
//
// A reset during a wait (`waitMs > 0`: the connection was open and the service died or stopped under it, Story 8.6) is `HUB_API_RESTARTING` with
// `retry: 'requeue'` and `api: false`, the same answer a `SIGTERM` gives (`api: true`): `requeueable(error)` is the one predicate every
// waiting caller uses to place the wait again with the same id (a repeat of an id the same holder holds answers the existing Lease, so a
// requeue is safe even if the crash came after the grant). `call()` itself never retries. A reset on a write with no wait stays UNKNOWN.
//
// Loopback only: cross-host transport is Epic 7. No retry, no interval. The deploy path never imports this file (tools/deploy-path.test.mjs).
// It does not import claims.mjs (which imports it), so the exit codes of its own three errors are written here and held equal to the
// exit table by claims.test.mjs (a thrown error's `.exit` against EXIT_CODES).
export const HUB_API_SERVICE = 'mobile-deploy-hub-api';
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
