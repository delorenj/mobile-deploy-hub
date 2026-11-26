#!/usr/bin/env node
// mise run hosts:smoke (Story 6.12, FR-1, FR-3, NFR-2): the live check of an installed Hub API, in one command, for every release that
// touches it. Run on big-chungus after `mise run hosts:install`; it drives the operator's own surfaces, the service's `/health` on
// 127.0.0.1:<policy.api.hub_api_port> and the `hub-device` on PATH (`--hub-device <cmd>` overrides it):
//   1. health   `/health` answers as the Hub API at the release ref (`hub_version` equal to it);
//   2. list     `hub-device registry list --json` reads the Registry from disk;
//   3. register a test phone `smoke-<base36 of now>` (model `hub smoke`, no serial, holder `hosts:smoke`) through the API;
//   4. leasable `hub-device lease <name> --no-connect --wait 0 --for 1m` takes it within 60 s (one try every 2 s, a bounded `for`
//               loop: no timer is rescheduled, AD-19), and the `phone` word's members (the Claims library's read-only
//               `phoneWordMembers`) and `status --json` list it;
//   5. release  the lease is released;
//   5b. holds   (Story 7.9, default on; `--no-holds` skips it, `--holds-on <word>` runs it on that device word, e.g. s24) the same Hold
//               sequence through the Hub API and through `hub-device` on one target, `status --json` read after every step, and the two
//               traces required equal (`holdParity`): take A, B waits first in line, extend A refused while B waits, force-release A and
//               B is granted, extend B by exactly 1 min, release B and the target is free. Holder `hosts:smoke`; it needs the target
//               free with nobody waiting (nothing is taken otherwise). Default target: the test phone, so it touches no real device;
//   5c. stream  (Story 8.7, default on; `--no-stream` skips it, `--restart` adds the restart half) the live status of the installed service on
//               the test phone (`streamCheck`): `GET /stream` opens (`retry: 3000`, then `ready`), a `hub-device` Lease `<phone>-s` shows in a
//               `status` frame within 2 s, then, with `--restart`, the unit is restarted: the old stream ends, `/health` answers as the
//               release again, the Lease is still held and a reconnect with the old `Last-Event-ID` opens `reset` (a new boot); then the
//               release shows in a `status` frame within 2 s and a `: keepalive` arrives while idle. `--restart` bounces the service, so a
//               waiting caller is answered `HUB_API_RESTARTING` and requeues (Story 8.6): ask for it at release time, not on every smoke;
//   5d. lanes   (Story 9.8, opt-in: `--lanes`) every lane another host owns (the Mac's `ios-lane`), taken through `hub-device` from here
//               (`laneCheck`): the forwarded Lease shows in that host's own view of `status --json` with that host's `started_at`, this host
//               wrote no lock for it, and the release frees the lane again. It holds the lane for seconds with `--no-connect --wait 0`, only
//               when it is free, and it is opt-in because a sleeping laptop fails it and the lane is a deploy target: ask for it at release time;
//   5e. history (Story 10.5, opt-in: `--history`, needs `--lanes`) the lanes phase just wrote one `acquire` and one `release` in each spoke's own
//               Event Log; `historyCheck` reads `GET /history` on this host's Hub API and requires both under that spoke's host key, with
//               `partial: false` and an ISO `synced_through`, and nothing for the id in this host's own log: the agent's push, the replica's
//               append, the on-demand `/agent/sync` and the merge, proven by a fresh event (an old replica cannot pass it). Read-only;
//   6. retire   the phone is retired through the API;
//   7. gone     a new lease is refused `HUB_RESOURCE_RETIRED`, and the `phone` members and `status` no longer list it.
// Any failure after the register releases the lease it took (and every id the holds and stream phases started) and retires the phone, and each is logged. The run prints
// `HUB_SMOKE <step>: ...` lines and ends `HUB_SMOKE_OK <ref> <id> leasable after <n> ms` (exit 0) or `HUB_SMOKE_FAILED <step>: ...`
// (exit 1). It is never part of hosts:install: names and ids are never reused (AD-28), so every run leaves one retired record in
// registry.json, which is the price of asking for the check and not of every install.
import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sleep as realSleep } from '../ci/lib/pause.mjs';
import { loadPolicy } from '../ci/lib/policy.mjs';
import { hostLanes, phoneWordMembers } from '../device/claims.mjs';
import { HUB_API_CONTRACT, HUB_API_SERVICE, hubUrl } from '../hub-client.mjs';
import { HUB_API_UNIT, releaseName } from '../hosts.mjs';
import { ID_PATTERN, RETRY_MS } from '../hub-api/stream.mjs';

export const LEASABLE_WITHIN_MS = 60_000;
export const TRY_EVERY_MS = 2000;
export const HEALTH_TIMEOUT_MS = 5000;
const HOLDER = 'hosts:smoke';
const NAME_MAX = 28;
export const HOLD_FOR_MS = 120_000;
export const HOLD_EXTEND_MS = 60_000;
export const HOLD_WAIT_MS = 30_000;
export const WAITER_SHOWS_WITHIN_MS = 10_000;
export const WAITER_POLL_MS = 500;
const API_CALL_MARGIN_MS = 30_000;
export const STATUS_WITHIN_MS = 2000;
export const RESTART_WITHIN_MS = 30_000;
export const KEEPALIVE_MARGIN_MS = 5000;
export const STREAM_FOR_MS = 120_000;
export const LANE_SHOWS_WITHIN_MS = 10_000;
export const LANE_FOR_MS = 120_000;
export const HISTORY_SHOWS_WITHIN_MS = 10_000;
export const HISTORY_LOOKBACK_MS = 600_000;
export const HISTORY_MAX_PAGES = 5;
const HEALTH_RETRY_MS = 500;
const MAX_WINDOWS = 3;
const MAX_ITEMS = 500;

const failure = (step, detail) => Object.assign(new Error(`HUB_SMOKE_FAILED ${step}: ${detail}`), { code: 'HUB_SMOKE_FAILED', step, smoke: true });
const brief = result => `exit ${result.code}: ${`${result.stderr ?? ''}${result.stdout ?? ''}`.trim().split('\n')[0] || 'no output'}`.slice(0, 300);
const parseJson = text => { try { return JSON.parse(text); } catch { return undefined; } };

// The default `cli`: runs the hub-device command (a command with arguments is split on spaces) and resolves `{code, stdout, stderr}`,
// never rejecting (a command that cannot start is code 127).
export function hubDeviceCli(command = 'hub-device', { env = process.env, timeout = 90_000 } = {}) {
  const [file, ...head] = command.trim().split(/\s+/);
  return args => new Promise(done => {
    execFile(file, [...head, ...args], { env, timeout, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      done({ code: error ? (typeof error.code === 'number' ? error.code : 127) : 0, stdout: stdout ?? '', stderr: `${stderr ?? ''}${error && typeof error.code !== 'number' ? error.message : ''}` });
    });
  });
}

// The Hub API's Hold routes as the smoke calls them: `({method, path, body, waitMs})` -> `{status, body}`, never rejecting (a transport
// failure is status 0 and a `HUB_API_DOWN` body). The timeout is the wait plus 30 s, else 30 s (AD-48).
export function apiCaller(fetchImpl, policy) {
  return async ({ method = 'POST', path, body, waitMs = 0 }) => {
    try {
      const response = await fetchImpl(`${hubUrl(policy)}${path}`, {
        method,
        headers: { accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout((waitMs > 0 ? waitMs : 0) + API_CALL_MARGIN_MS),
      });
      const text = typeof response.text === 'function' ? await response.text() : JSON.stringify(await response.json());
      return { status: response.status, body: parseJson(text) ?? null };
    } catch (error) { return { status: 0, body: { code: 'HUB_API_DOWN', detail: error.message } }; }
  };
}

const holdFailure = detail => Object.assign(failure('holds', detail), { detail });
const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// What each step must show, once the two doors agree (a door pair that is equally wrong is still wrong).
const HOLD_EXPECTED = [
  ['take-a', entry => entry.held === 'lease' && entry.lease === 'A' && entry.waiters.length === 0],
  ['wait-b', entry => entry.lease === 'A' && entry.waiters[0]?.lease === 'B'],
  ['extend-refused', entry => entry.answer.outcome === 'refused' && entry.lease === 'A'],
  ['force-release', entry => entry.lease === 'B' && entry.waiters.length === 0],
  ['extend-b', entry => entry.answer.outcome === 'extended' && entry.lease === 'B'],
  ['release-b', entry => entry.held === 'free' && entry.lease === null && entry.waiters.length === 0],
];

// The Hold parity check (Story 7.9, FR-10, FR-11, FR-21): one Hold sequence on `target`, first through the Hub API (`api`, see
// `apiCaller`) and then through `hub-device` (`cli`), `status --json` read after every step, the two traces required equal. Ids are
// client-minted `<tag>-<a|b>-<api|cli>`; the holder is `hosts:smoke`. Per door: the target must be free with nobody waiting (else
// nothing is taken) -> take A -> B waits (first in line) -> extend A is refused while B waits -> force-release A, B is granted ->
// extend B by 1 min (status `expires_at` moves by exactly 60 000 ms) -> release B -> the target is free. A trace entry is the
// snapshot `{step, held, holder, why, lease, waiters: [{lease, position, holder}], answer}` with ids mapped to A/B (anything else is
// `other`); `answer` is what the door said for the step (Lease answers on `{lease, device, holder, why, env keys}`). Every wait is a
// bounded `for` loop (AD-19). Any failure releases every id it started (which also withdraws a waiter), awaits the pending wait,
// logs each, then throws `HUB_SMOKE_FAILED holds: ...` (`detail` is the part after the colon). Resolves `{target, traces: {api, cli}}`.
export async function holdParity({ target, tag, ref, cli, api, now = Date.now, sleep = realSleep, log = () => {} } = {}) {
  if (typeof target !== 'string' || target === '') throw new TypeError('holdParity: a target is required');
  if (typeof tag !== 'string' || tag === '') throw new TypeError('holdParity: a tag is required');
  if (typeof cli !== 'function' || typeof api !== 'function') throw new TypeError('holdParity: a cli and an api caller are required');
  const why = `hosts:smoke ${ref} holds`;
  const live = new Set();
  const pending = [];
  const run = args => Promise.resolve().then(() => cli(args)).catch(error => ({ code: 127, stdout: '', stderr: error.message }));
  const jsonOf = result => (result.code === 0 ? parseJson(result.stdout) : undefined);
  const apiNote = result => `status ${result.status}${result.body?.code ? ` ${result.body.code}` : ''}${result.body?.detail ? `: ${String(result.body.detail).slice(0, 200)}` : ''}`;

  // The two front doors, each answering with the same small shapes: `{ok, body, note}` for a Lease or a force-release, `{outcome, note}`
  // for an extend, `{ok, note}` for a release.
  const doors = {
    api: {
      take: (id, waitMs) => api({ path: '/leases', body: { resource: target, for_ms: HOLD_FOR_MS, holder: HOLDER, why, id, ...(waitMs > 0 ? { wait_ms: waitMs } : {}) }, waitMs })
        .then(result => ({ ok: result.status === 200 && typeof result.body?.lease_id === 'string', body: result.body, note: apiNote(result) })),
      extend: id => api({ path: `/leases/${id}/extend`, body: { for_ms: HOLD_EXTEND_MS, holder: HOLDER } }).then(result => ({
        outcome: result.status === 409 && result.body?.code === 'HUB_LEASE_EXTEND_REFUSED' && result.body?.reason === 'waiters' ? 'refused' : result.status === 200 ? 'extended' : 'failed',
        note: apiNote(result),
      })),
      force: id => api({ path: `/leases/${id}/force-release`, body: { why, holder: HOLDER } }).then(result => ({ ok: result.status === 200 && result.body?.outcome === 'force-released', body: result.body, note: apiNote(result) })),
      release: id => api({ path: `/leases/${id}/release`, body: { holder: HOLDER } }).then(result => ({ ok: result.status === 200 && result.body?.outcome === 'released', note: apiNote(result) })),
    },
    cli: {
      take: (id, waitMs) => run(['lease', target, '--no-connect', '--wait', waitMs > 0 ? `${waitMs / 1000}s` : '0', '--for', `${HOLD_FOR_MS / 60_000}m`, '--why', why, '--holder', HOLDER, '--id', id, '--json'])
        .then(result => { const body = jsonOf(result); return { ok: typeof body?.lease_id === 'string', body: body ?? null, note: brief(result) }; }),
      extend: id => run(['extend', id, '--for', `${HOLD_EXTEND_MS / 60_000}m`, '--holder', HOLDER, '--json']).then(result => ({
        outcome: result.code === 76 && /HUB_LEASE_EXTEND_REFUSED/.test(result.stderr ?? '') ? 'refused' : result.code === 0 ? 'extended' : 'failed',
        note: brief(result),
      })),
      force: id => run(['force-release', id, '--why', why, '--holder', HOLDER, '--json']).then(result => { const body = jsonOf(result); return { ok: body?.outcome === 'force-released', body: body ?? null, note: brief(result) }; }),
      release: id => run(['release', id]).then(result => ({ ok: result.code === 0 && /^HUB_DEVICE_RELEASED /m.test(result.stdout ?? ''), note: brief(result) })),
    },
  };

  const readStatus = async () => {
    const status = await run(['status', '--json']);
    const body = status.code === 0 ? parseJson(status.stdout) : undefined;
    if (!Array.isArray(body?.phones)) throw holdFailure(`status --json gave no phones (${brief(status)})`);
    const phone = body.phones.find(entry => entry.device === target);
    if (phone === undefined) throw holdFailure(`status does not list ${target}`);
    return { phone, waiters: (Array.isArray(body.waiters) ? body.waiters : []).filter(entry => entry.device === target || (phone.lock && entry.lock === phone.lock)) };
  };
  const leaseAnswer = (body, ids) => ({ lease: ids(body?.lease_id), device: body?.device ?? null, holder: body?.holder ?? null, why: body?.why ?? null, env: Object.keys(body?.env ?? {}).sort() });

  const runDoor = async (name, door) => {
    const idA = `${tag}-a-${name}`;
    const idB = `${tag}-b-${name}`;
    const ids = id => (id === undefined || id === null ? null : id === idA ? 'A' : id === idB ? 'B' : 'other');
    const trace = [];
    const snapshot = async (step, answer) => {
      const { phone, waiters } = await readStatus();
      const entry = {
        step, held: phone.held ?? null, holder: phone.holder ?? null, why: phone.why ?? null, lease: ids(phone.lease_id),
        waiters: waiters.slice().sort((a, b) => a.position - b.position).map(waiter => ({ lease: ids(waiter.lease_id), position: waiter.position, holder: waiter.holder ?? null })),
        answer,
      };
      trace.push(entry);
      return { entry, expires: Date.parse(phone.expires_at) };
    };

    const before = await readStatus();
    if ((before.phone.held ?? 'free') !== 'free' || before.waiters.length > 0) {
      throw holdFailure(`${target} is not free (${before.phone.held ?? 'free'}${before.phone.holder ? ` by ${before.phone.holder}` : ''}, ${before.waiters.length} waiting): nothing was taken`);
    }

    live.add(idA);
    const taken = await door.take(idA, 0);
    if (!taken.ok) throw holdFailure(`${name} take of A failed (${taken.note})`);
    await snapshot('take-a', leaseAnswer(taken.body, ids));

    // B waits behind A: the wait stays pending, and status must list it first in line within 10 s.
    let ended = null;
    live.add(idB);
    const waiting = door.take(idB, HOLD_WAIT_MS).then(result => { ended = result; return result; });
    pending.push(waiting);
    const deadline = now() + WAITER_SHOWS_WITHIN_MS;
    const tries = Math.ceil(WAITER_SHOWS_WITHIN_MS / WAITER_POLL_MS) + 2;
    let shown = null;
    for (let attempt = 1; attempt <= tries; attempt += 1) {
      if (ended !== null) throw holdFailure(`${name} wait of B ended before A was released (${ended.note})`);
      const read = await readStatus();
      if (read.waiters.some(waiter => ids(waiter.lease_id) === 'B')) { shown = read; break; }
      const left = deadline - now();
      if (left <= 0) break;
      await sleep(Math.min(WAITER_POLL_MS, left));
      if (now() >= deadline) break;
    }
    if (shown === null) throw holdFailure(`${name} B never waited: status did not list it within ${WAITER_SHOWS_WITHIN_MS / 1000} s`);
    const first = shown.waiters.slice().sort((a, b) => a.position - b.position)[0];
    if (ids(first.lease_id) !== 'B') throw holdFailure(`${name} B waits but is not first in line (${ids(first.lease_id)} is)`);
    await snapshot('wait-b', { waiting: true });

    const refused = await door.extend(idA);
    await snapshot('extend-refused', { outcome: refused.outcome });

    const forced = await door.force(idA);
    if (!forced.ok) throw holdFailure(`${name} force-release of A failed (${forced.note})`);
    live.delete(idA);
    const granted = await waiting;
    if (!granted.ok) throw holdFailure(`${name} B was not granted after A was force-released (${granted.note})`);
    const { expires: before60 } = await snapshot('force-release', {
      forced: { lease: ids(forced.body?.lease_id), outcome: forced.body?.outcome ?? null, device: forced.body?.device ?? null, holder: forced.body?.holder ?? null, why: forced.body?.why ?? null },
      granted: leaseAnswer(granted.body, ids),
    });

    const extended = await door.extend(idB);
    if (extended.outcome !== 'extended') throw holdFailure(`${name} extend of B failed (${extended.note})`);
    const { expires: after60 } = await snapshot('extend-b', { outcome: extended.outcome });
    if (!Number.isFinite(before60) || !Number.isFinite(after60) || after60 - before60 !== HOLD_EXTEND_MS) {
      throw holdFailure(`${name} extend of B moved expires_at by ${Number.isFinite(before60) && Number.isFinite(after60) ? `${after60 - before60} ms` : 'an unreadable time'}, not ${HOLD_EXTEND_MS} ms`);
    }

    const released = await door.release(idB);
    if (!released.ok) throw holdFailure(`${name} release of B failed (${released.note})`);
    live.delete(idB);
    await snapshot('release-b', { outcome: 'released' });
    return trace;
  };

  // What to undo on a failure: every id still live (newest first), each logged, then the waits that were pending settle.
  const undo = async () => {
    for (const id of [...live].reverse()) {
      const released = await run(['release', id]);
      log(`HUB_SMOKE cleanup: ${released.code === 0 ? `released ${id}` : `release of ${id} failed (${brief(released)})`}`);
      if (released.code === 0) live.delete(id);
    }
    await Promise.allSettled(pending);
  };

  try {
    const traces = { api: await runDoor('api', doors.api), cli: await runDoor('cli', doors.cli) };
    for (let index = 0; index < traces.api.length; index += 1) {
      if (!sameJson(traces.api[index], traces.cli[index])) throw holdFailure(`api and cli differ at ${traces.api[index].step}: api ${JSON.stringify(traces.api[index])}, cli ${JSON.stringify(traces.cli[index])}`);
    }
    for (const [step, holds] of HOLD_EXPECTED) {
      const entry = traces.api.find(candidate => candidate.step === step);
      if (!entry || !holds(entry)) throw holdFailure(`api and cli agree at ${step}, but the state is wrong: ${JSON.stringify(entry ?? null)}`);
    }
    return { target, traces };
  } catch (error) {
    await undo();
    throw error.smoke ? error : holdFailure(`unexpected: ${error.message}`);
  }
}

// ---------------------------------------------------------------------------------------------------- Story 8.7: the stream phase

const TIMEOUT = Symbol('timeout');
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

// The default restart seam: `systemctl --user restart <unit>`, resolving `{code, stderr}` and never rejecting.
export function restartHubApiUnit({ unit = HUB_API_UNIT, timeout = 120_000 } = {}) {
  return new Promise(done => {
    execFile('systemctl', ['--user', 'restart', unit], { timeout, encoding: 'utf8' }, (error, _stdout, stderr) => {
      done({ code: error ? (typeof error.code === 'number' ? error.code : 127) : 0, stderr: `${stderr ?? ''}${error && typeof error.code !== 'number' ? error.message : ''}` });
    });
  });
}

// A reader over an SSE response body (`response.body`): blocks end at a blank line; `retry:`, a `:` comment, and `id:`/`event:`/`data:` fields
// become `{kind: 'retry', ms}`, `{kind: 'comment', text}` and `{kind: 'frame', id, type, data}` (`data` is the parsed JSON, undefined when it
// is not). `next(ms)` resolves the next item, `{kind: 'end'}` when the stream is over (or its read failed: `error`), or `{kind: 'timeout'}`.
// One read is kept pending across calls (`race` bounds the wait), so a chunk that arrives after a timeout is not lost.
export function sseReader(body, { race, now }) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const items = [];
  let buffer = '';
  let ended = null;
  let reading = null;
  const parse = block => {
    const fields = {};
    const comments = [];
    for (const line of block.split('\n')) {
      if (line === '') continue;
      if (line.startsWith(':')) { comments.push(line.slice(1).trim()); continue; }
      const cut = line.indexOf(':');
      const name = cut === -1 ? line : line.slice(0, cut);
      const value = cut === -1 ? '' : line.slice(cut + 1).replace(/^ /, '');
      fields[name] = name === 'data' && fields.data !== undefined ? `${fields.data}\n${value}` : value;
    }
    if (fields.event !== undefined || fields.data !== undefined || fields.id !== undefined) return { kind: 'frame', id: fields.id ?? null, type: fields.event ?? 'message', data: parseJson(fields.data ?? '') };
    if (fields.retry !== undefined) return { kind: 'retry', ms: Number(fields.retry) };
    return comments.length > 0 ? { kind: 'comment', text: comments.join(' ') } : null;
  };
  const feed = text => {
    buffer += text.replace(/\r\n/g, '\n');
    for (let cut = buffer.indexOf('\n\n'); cut !== -1; cut = buffer.indexOf('\n\n')) {
      const item = parse(buffer.slice(0, cut));
      buffer = buffer.slice(cut + 2);
      if (item !== null) items.push(item);
    }
  };
  return {
    async next(ms) {
      const deadline = now() + ms;
      for (let spin = 0; spin < 10_000; spin += 1) {
        if (items.length > 0) return items.shift();
        if (ended !== null) return ended;
        const left = deadline - now();
        if (left <= 0) return { kind: 'timeout' };
        reading ??= reader.read().then(result => result, error => ({ done: true, error }));
        const got = await race(reading, left);
        if (got === TIMEOUT) return { kind: 'timeout' };
        reading = null;
        if (got.done) { ended = { kind: 'end', ...(got.error ? { error: got.error.message ?? String(got.error) } : {}) }; continue; }
        feed(decoder.decode(got.value, { stream: true }));
      }
      return { kind: 'timeout' };
    },
    cancel() { reader.cancel().catch(() => {}); },
  };
}

const describeItem = item => {
  if (item.kind === 'retry') return `retry: ${item.ms}`;
  if (item.kind === 'comment') return `the comment "${item.text}"`;
  if (item.kind === 'frame') return `a ${item.type} frame ${item.id ?? '(no id)'}`;
  if (item.kind === 'end') return `the end of the stream${item.error ? ` (${item.error})` : ''}`;
  return 'nothing';
};

// The live status of the installed service (Story 8.7, FR-14, FR-21, FR-23): the Acceptance check of the stream as one sequence, on the
// smoke's test phone (`tag` is its name), against `GET /stream` and `hub-device`. Lease id `<tag>-s`, holder `hosts:smoke`.
//   1. `GET /stream` opens (200, `text/event-stream`), sends `retry: 3000` and then a `ready` frame (id `<boot>-<n>`, document with
//      `status.hosts`), within 5 s;
//   2. `hub-device lease` (another process: the change reaches the service through the disk): a `status` frame that lists the phone with
//      that lease arrives within 2 s of the CLI's answer;
//   3. with `restart`: `restartUnit()` restarts the service, the old stream ends, `/health` answers as `ref` and the contract again, the
//      Lease is still held (`hub-device status`), and a new `GET /stream` with `Last-Event-ID` = the last frame id seen opens `reset` of a
//      different boot (all within 30 s each);
//   4. `hub-device release`: a `status` frame that shows the phone without that lease arrives within 2 s;
//   5. idle: a `: keepalive` arrives within keepalive + 5 s of the last item (a frame restarts the window, at most 3 windows).
// Every wait is a bounded `for` loop and a race against `sleep` (AD-19: no timer outlives it). Any failure aborts the stream, releases the
// Lease if it was taken (logged), then throws `HUB_SMOKE_FAILED stream: ...` (`restart: ...` from step 3; `detail` is the part after the
// colon). Resolves `{statusMs, keepaliveMs, restart: null | {boots: [first, second]}}`.
export async function streamCheck({
  tag, ref, cli, fetchImpl = globalThis.fetch, policy = loadPolicy().policy, restart = false, restartUnit = restartHubApiUnit,
  now = Date.now, sleep = realSleep, log = () => {},
} = {}) {
  if (typeof tag !== 'string' || tag === '') throw new TypeError('streamCheck: a tag (the test phone) is required');
  if (typeof ref !== 'string' || ref === '') throw new TypeError('streamCheck: a release ref is required');
  if (typeof cli !== 'function') throw new TypeError('streamCheck: a cli is required');
  const leaseId = `${tag}-s`;
  const why = `hosts:smoke ${ref} stream`;
  const state = { phase: 'stream', leaseTaken: false, conn: null, lastId: null, lastAt: now() };
  const fail = detail => Object.assign(failure(state.phase, detail), { detail });
  const keepaliveS = policy?.api?.stream_keepalive_s;
  if (!(Number.isFinite(keepaliveS) && keepaliveS > 0)) throw fail('policy.api.stream_keepalive_s is not a positive number');
  const windowMs = keepaliveS * 1000 + KEEPALIVE_MARGIN_MS;

  const race = async (work, ms) => {
    const stop = new AbortController();
    try { return await Promise.race([work, Promise.resolve(sleep(ms, stop.signal)).then(() => TIMEOUT)]); } finally { stop.abort(); }
  };
  const note = item => {
    if (item.kind === 'timeout' || item.kind === 'end') return;
    state.lastAt = now();
    if (item.kind === 'frame' && ID_PATTERN.test(item.id ?? '')) state.lastId = item.id;
  };
  const read = async ms => { const item = await state.conn.reader.next(ms); note(item); return item; };
  const close = conn => { if (conn) { try { conn.controller.abort(); } catch { /* already aborted */ } conn.reader?.cancel(); } };

  // Opens `GET /stream` (with a `Last-Event-ID` for a reconnect) and reads its first two items, `retry: 3000` and the opening frame.
  const open = async lastEventId => {
    const controller = new AbortController();
    const conn = { controller, reader: null };
    state.conn = conn;
    const label = lastEventId === undefined ? '/stream' : 'the reconnect';
    const expected = lastEventId === undefined ? 'ready' : 'reset';
    let response;
    try {
      response = await race(Promise.resolve(fetchImpl(`${hubUrl(policy)}/stream`, { method: 'GET', headers: { accept: 'text/event-stream', ...(lastEventId === undefined ? {} : { 'Last-Event-ID': lastEventId }) }, signal: controller.signal })), HEALTH_TIMEOUT_MS);
    } catch (error) { throw fail(`${label} did not answer (${error.message})`); }
    if (response === TIMEOUT) throw fail(`${label} did not answer within ${HEALTH_TIMEOUT_MS / 1000} s`);
    if (response.status !== 200) throw fail(`${label} answered ${response.status}, not 200`);
    const type = response.headers?.get?.('content-type') ?? '';
    if (!type.toLowerCase().startsWith('text/event-stream')) throw fail(`${label} answered content-type ${type === '' ? '(none)' : type}, not text/event-stream`);
    if (response.body === null || response.body === undefined) throw fail(`${label} answered without a body`);
    conn.reader = sseReader(response.body, { race, now });

    const deadline = now() + HEALTH_TIMEOUT_MS;
    const first = await read(HEALTH_TIMEOUT_MS);
    if (first.kind !== 'retry' || first.ms !== RETRY_MS) throw fail(`${label} did not open with retry: ${RETRY_MS} (it sent ${describeItem(first)})`);
    const second = await read(Math.max(1, deadline - now()));
    if (second.kind !== 'frame' || second.type !== expected) throw fail(`${label} opened with ${describeItem(second)}, not a ${expected} frame`);
    if (!ID_PATTERN.test(second.id ?? '')) throw fail(`the ${expected} frame has the id ${second.id ?? '(none)'}, not <boot>-<n>`);
    if (!isObject(second.data?.status?.hosts)) throw fail(`the ${expected} frame carries no status.hosts document`);
    if (expected === 'reset' && second.data.reason !== 'unresumable') throw fail(`the reset frame says reason ${second.data.reason ?? '(none)'}, not unresumable`);
    return { id: second.id, boot: second.id.slice(0, second.id.indexOf('-')) };
  };

  const rowsOf = document => Object.values(isObject(document?.hosts) ? document.hosts : {}).flatMap(view => (Array.isArray(view?.phones) ? view.phones : [])).filter(row => row.device === tag);
  // Reads `status` frames (an `event` frame is skipped) until `shows(rows)`, within STATUS_WITHIN_MS of `from`.
  const awaitStatus = async (what, shows, from) => {
    const deadline = from + STATUS_WITHIN_MS;
    for (let spin = 0; spin < MAX_ITEMS; spin += 1) {
      const left = deadline - now();
      if (left <= 0) break;
      const item = await read(left);
      if (item.kind === 'timeout') break;
      if (item.kind === 'end') throw fail(`the stream ended while waiting for a status frame that shows ${what}`);
      if (item.kind === 'frame' && item.type === 'status' && shows(rowsOf(item.data?.status))) return now() - from;
    }
    throw fail(`no status frame showed ${what} within ${STATUS_WITHIN_MS / 1000} s`);
  };

  const undo = async () => {
    close(state.conn);
    if (state.leaseTaken) {
      const released = await Promise.resolve().then(() => cli(['release', leaseId])).catch(error => ({ code: 127, stderr: error.message }));
      log(`HUB_SMOKE cleanup: ${released.code === 0 ? `released ${leaseId}` : `release of ${leaseId} failed (${brief(released)})`}`);
      if (released.code === 0) state.leaseTaken = false;
    }
  };

  try {
    // 1. open
    const opened = await open(undefined);

    // 2. a Lease through the CLI shows in a status frame within 2 s
    state.leaseTaken = true;
    const leased = await cli(['lease', tag, '--no-connect', '--wait', '0', '--for', `${STREAM_FOR_MS / 60_000}m`, '--why', why, '--holder', HOLDER, '--id', leaseId, '--json']);
    if (typeof (leased.code === 0 ? parseJson(leased.stdout) : undefined)?.lease_id !== 'string') throw fail(`the Lease ${leaseId} on ${tag} was refused (${brief(leased)})`);
    const statusMs = await awaitStatus(leaseId, rows => rows.some(row => row.lease_id === leaseId), now());

    // 3. restart: the Lease survives, the reconnect gets reset
    let restarted = null;
    if (restart) {
      state.phase = 'restart';
      const stopped = await Promise.resolve().then(() => restartUnit()).catch(error => ({ code: 127, stderr: error.message }));
      if (stopped.code !== 0) throw fail(`restarting ${HUB_API_UNIT} failed (${brief(stopped)})`);
      const old = state.conn;
      let over = false;
      const endBy = now() + RESTART_WITHIN_MS;
      for (let spin = 0; spin < MAX_ITEMS && !over; spin += 1) {
        const left = endBy - now();
        if (left <= 0) break;
        over = (await read(left)).kind === 'end';
      }
      if (!over) throw fail(`the old stream did not end within ${RESTART_WITHIN_MS / 1000} s of the restart`);
      close(old);

      const healthBy = now() + RESTART_WITHIN_MS;
      let seen = 'no answer';
      let healthy = false;
      for (let attempt = 1; attempt <= Math.ceil(RESTART_WITHIN_MS / HEALTH_RETRY_MS) + 2 && !healthy; attempt += 1) {
        try {
          const response = await fetchImpl(`${hubUrl(policy)}/health`, { method: 'GET', headers: { accept: 'application/json' }, signal: AbortSignal.timeout(Math.max(1, Math.min(2000, healthBy - now()))) });
          const text = typeof response.text === 'function' ? await response.text() : JSON.stringify(await response.json());
          const body = response.status === 200 ? parseJson(text) : undefined;
          healthy = body?.ok === true && body.service === HUB_API_SERVICE && body.hub_version === ref && body.contract === HUB_API_CONTRACT;
          seen = isObject(body) ? `hub_version ${body.hub_version ?? 'missing'}, service ${body.service ?? 'missing'}, contract ${body.contract ?? 'missing'}` : `HTTP ${response.status}`;
        } catch (error) { seen = String(error?.cause?.code ?? error?.message ?? error).split('\n')[0]; }
        if (healthy) break;
        const left = healthBy - now();
        if (left <= 0) break;
        await sleep(Math.min(HEALTH_RETRY_MS, left));
        if (now() >= healthBy) break;
      }
      if (!healthy) throw fail(`/health did not answer as ${HUB_API_SERVICE} ${ref}, contract ${HUB_API_CONTRACT} within ${RESTART_WITHIN_MS / 1000} s of the restart (last: ${seen})`);

      const status = await cli(['status', '--json']);
      const body = status.code === 0 ? parseJson(status.stdout) : undefined;
      if (!Array.isArray(body?.phones)) throw fail(`status --json gave no phones after the restart (${brief(status)})`);
      const row = body.phones.find(entry => entry.device === tag);
      if (row?.held !== 'lease' || row.lease_id !== leaseId) throw fail(`${leaseId} did not survive the restart: status shows ${tag} ${row === undefined ? 'missing' : `held ${row.held ?? 'free'}${row.lease_id ? ` by ${row.lease_id}` : ''}`}`);

      const again = await open(state.lastId);
      if (again.boot === opened.boot) throw fail(`the reconnect got reset, but its boot is still ${opened.boot}: the service did not restart`);
      restarted = { boots: [opened.boot, again.boot] };
      state.phase = 'stream';
    }

    // 4. release: a status frame shows the phone without the Lease
    const released = await cli(['release', leaseId]);
    if (released.code !== 0) throw fail(`release of ${leaseId} failed (${brief(released)})`);
    state.leaseTaken = false;
    await awaitStatus(`${tag} without ${leaseId}`, rows => rows.length > 0 && rows.every(row => row.lease_id === null || row.lease_id === undefined), now());

    // 5. idle: a keepalive within keepalive + 5 s of the last item; a frame restarts the window, at most 3 windows
    let keepaliveMs = null;
    for (let windowNo = 1; windowNo <= MAX_WINDOWS && keepaliveMs === null; windowNo += 1) {
      const from = state.lastAt;
      for (let spin = 0; spin < MAX_ITEMS; spin += 1) {
        const left = from + windowMs - now();
        if (left <= 0) throw fail(`no keepalive arrived within ${windowMs / 1000} s of the last item`);
        const item = await read(left);
        if (item.kind === 'timeout') throw fail(`no keepalive arrived within ${windowMs / 1000} s of the last item`);
        if (item.kind === 'end') throw fail('the stream ended while waiting for a keepalive');
        if (item.kind === 'comment' && /^keepalive$/.test(item.text)) { keepaliveMs = now() - from; break; }
        if (item.kind === 'frame') break;
      }
    }
    if (keepaliveMs === null) throw fail(`the stream was never idle: a frame arrived in each of ${MAX_WINDOWS} windows of ${windowMs / 1000} s`);

    close(state.conn);
    return { statusMs, keepaliveMs, restart: restarted };
  } catch (error) {
    await undo();
    throw error.smoke ? error : fail(`unexpected: ${error.message}`);
  }
}

// ---------------------------------------------------------------------------------------------------- Story 9.8: the lanes phase

const isoTime = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value));

// The repeatable live pair check of every spoke host's lane (Story 9.8, FR-12, FR-14), run on big-chungus after both hosts are installed. The
// spokes are the keys of `remote_hosts` in `hub-device status --json` and their lanes are `lanesOf(spoke)` (default: the seed's lanes of that
// host, read-only). For each lane, in order, with the lane's own name (never the iPad: `--no-connect`, so an unplugged iPad cannot fail it):
//   1. the host's view must be `available` and the lane free (no `locks[]` or `waiters[]` row on its lock), else nothing is taken;
//   2. `hub-device lease <device> --no-connect --wait 0 --for 2m --id <tag>-l-<device>` is forwarded and answers that id;
//   3. within 10 s of the answer the host's own view shows a `lease` row on the lane's lock for that id with an ISO `started_at` (the host's
//      clock), and this host's own `locks[]` has no row for the id: big-chungus wrote nothing;
//   4. `hub-device release <id> --resource <device>` (a bare release would run here) answers `HUB_DEVICE_RELEASED`, and within 10 s the host's
//      view has no row on the lane's lock for this id (a deploy that takes the lane right after the release is not a failed release).
// Every wait is a bounded `for` loop (AD-19). Any failure releases the id it took (logged), then throws `HUB_SMOKE_FAILED lanes: ...` (`detail`
// is the part after the colon). Resolves `{lanes: [{host, device, id, shownMs, freedMs, startedAt, skewMs}]}`.
export async function laneCheck({ tag, ref, cli, lanesOf = hostLanes, now = Date.now, sleep = realSleep, log = () => {} } = {}) {
  if (typeof tag !== 'string' || tag === '') throw new TypeError('laneCheck: a tag (the test phone) is required');
  if (typeof ref !== 'string' || ref === '') throw new TypeError('laneCheck: a release ref is required');
  if (typeof cli !== 'function') throw new TypeError('laneCheck: a cli is required');
  if (typeof lanesOf !== 'function') throw new TypeError('laneCheck: lanesOf is a function');
  const why = `hosts:smoke ${ref} lanes`;
  const fail = detail => Object.assign(failure('lanes', detail), { detail });
  const run = args => Promise.resolve().then(() => cli(args)).catch(error => ({ code: 127, stdout: '', stderr: error.message }));
  const state = { taken: null };
  const seconds = LANE_SHOWS_WITHIN_MS / 1000;

  const readStatus = async () => {
    const result = await run(['status', '--json']);
    const body = result.code === 0 ? parseJson(result.stdout) : undefined;
    if (!isObject(body)) throw fail(`status --json gave no document (${brief(result)})`);
    return body;
  };
  const viewOf = (body, host) => (isObject(body.remote_hosts?.[host]) ? body.remote_hosts[host] : null);
  const rowsOf = (list, lock) => (Array.isArray(list) ? list : []).filter(row => row?.lock === lock);

  // Polls `status --json`, one read every WAITER_POLL_MS, until `done(body)` answers non-null or `from + LANE_SHOWS_WITHIN_MS` has come (no read
  // after it). Resolves `{found, last}`: `last` is the last body read.
  const poll = async (from, done) => {
    const deadline = from + LANE_SHOWS_WITHIN_MS;
    const tries = Math.ceil(LANE_SHOWS_WITHIN_MS / WAITER_POLL_MS) + 2;
    let last = null;
    for (let attempt = 1; attempt <= tries; attempt += 1) {
      last = await readStatus();
      const found = done(last);
      if (found !== null) return { found, last };
      const left = deadline - now();
      if (left <= 0) break;
      await sleep(Math.min(WAITER_POLL_MS, left));
      if (now() >= deadline) break;
    }
    return { found: null, last };
  };

  const undo = async () => {
    if (state.taken === null) return;
    const { id, device } = state.taken;
    const released = await run(['release', id, '--resource', device]);
    log(`HUB_SMOKE cleanup: ${released.code === 0 ? `released ${id}` : `release of ${id} failed (${brief(released)})`}`);
    if (released.code === 0) state.taken = null;
  };

  const results = [];
  try {
    let body = await readStatus();
    const spokes = isObject(body.remote_hosts) ? Object.keys(body.remote_hosts) : [];
    if (spokes.length === 0) throw fail('no other host in status (run it on big-chungus)');
    const lanes = spokes.flatMap(host => lanesOf(host).map(lane => ({ ...lane, host })));
    if (lanes.length === 0) throw fail(`no lane on ${spokes.join(', ')}`);

    for (const [index, lane] of lanes.entries()) {
      const { host, device } = lane;
      const id = `${tag}-l-${device}`;
      if (index > 0) body = await readStatus();

      // 1. the host's view is available and the lane is free
      const remote = viewOf(body, host);
      if (remote === null || remote.state !== 'available' || !isObject(remote.view)) {
        throw fail(`${host} is ${remote?.state ?? 'not in status'}${remote?.reason ? ` (${remote.reason})` : ''}: nothing was taken on ${device}`);
      }
      const holder = rowsOf(remote.view.locks, lane.lock)[0];
      if (holder !== undefined) throw fail(`${device} (${lane.lock}) on ${host} is held (${holder.kind ?? 'a lock'}${holder.holder ? ` by ${holder.holder}` : holder.repo ? ` by ${holder.repo}` : ''}${holder.lease_id ? ` ${holder.lease_id}` : ''}): nothing was taken`);
      const waiter = rowsOf(remote.view.waiters, lane.lock)[0];
      if (waiter !== undefined) throw fail(`${device} (${lane.lock}) on ${host} has a waiter (${waiter.holder ?? waiter.lease_id ?? 'a request'}): nothing was taken`);

      // 2. take it, forwarded, by the lane's own name
      state.taken = { id, device };
      const leased = await run(['lease', device, '--no-connect', '--wait', '0', '--for', `${LANE_FOR_MS / 60_000}m`, '--id', id, '--why', why, '--holder', HOLDER, '--json']);
      const answer = leased.code === 0 ? parseJson(leased.stdout) : undefined;
      if (answer?.lease_id !== id) throw fail(`the Lease ${id} on ${device} (${host}) was refused (${brief(leased)})`);
      const answeredAt = now();

      // 3. it shows in the host's own view with the host's clock, and this host wrote nothing
      let wroteLocally = false;
      const shown = await poll(answeredAt, polled => {
        if (Array.isArray(polled.locks) && polled.locks.some(row => row?.lease_id === id)) { wroteLocally = true; return {}; }
        const view = viewOf(polled, host);
        if (view?.state !== 'available') return null;
        return rowsOf(view.view?.locks, lane.lock).find(row => row.lease_id === id && row.kind === 'lease' && isoTime(row.started_at)) ?? null;
      });
      if (wroteLocally) throw fail(`big-chungus wrote the lane's lock: ${id} is in this host's own locks, not only in ${host}'s`);
      if (shown.found === null) throw fail(`${device} held as ${id} was not shown in ${host}'s view within ${seconds} s (with that Lease, kind lease and an ISO started_at)`);
      const shownMs = now() - answeredAt;
      const startedAt = shown.found.started_at;
      const skewMs = Date.parse(startedAt) - answeredAt;

      // 4. release it by the lane's name, and the lane is free again
      const released = await run(['release', id, '--resource', device]);
      if (released.code !== 0 || !/^HUB_DEVICE_RELEASED\b/m.test(released.stdout ?? '')) throw fail(`the release of ${id} on ${device} did not answer HUB_DEVICE_RELEASED (${brief(released)})`);
      state.taken = null;
      const releasedAt = now();
      const freed = await poll(releasedAt, polled => {
        const view = viewOf(polled, host);
        return view?.state === 'available' && isObject(view.view) && !rowsOf(view.view.locks, lane.lock).some(row => row.lease_id === id) ? true : null;
      });
      if (freed.found === null) throw fail(`${device} (${lane.lock}) on ${host} is still held in ${host}'s view ${seconds} s after the release of ${id}`);
      const freedMs = now() - releasedAt;

      log(`HUB_SMOKE lanes: ${device} on ${host} held as ${id} (${host} clock started_at ${startedAt}, ${skewMs} ms from this host), shown in ${shownMs} ms, free again in ${freedMs} ms`);
      results.push({ host, device, id, shownMs, freedMs, startedAt, skewMs });
    }
    return { lanes: results };
  } catch (error) {
    await undo();
    throw error.smoke ? error : fail(`unexpected: ${error.message}`);
  }
}

// ---------------------------------------------------------------------------------------------------- Story 10.5: the history phase

const EVENT_ID = /^[^/]+\/\d{4}-\d{2}\/\d+$/;

// The repeatable live check that each spoke host's Event Log reaches this host's `/history` (Story 10.5, FR-18, UJ-4), run right after `laneCheck`
// with its `lanes`. Each lane's take and release wrote an `acquire` and a `release` (event `lease_id` = the lane's id, claimant holder `hosts:smoke`)
// in the spoke's own log. One read is `GET /history?claimant=hosts:smoke&from=<now - 10 min>&limit=1000` through `api` (`apiCaller`), following
// `cursor` while `more` is true for at most 5 pages. A read that is not 200 with `format: 1` and an `events` array fails at once, naming the status,
// code and detail. A read passes when every lane is satisfied: both events are there, every entry for the id is under the lane's host with an id of
// the form `<host_id>/<YYYY-MM>/<offset>`, the answer says `partial: false` and `synced_through[<host>]` is an ISO time. An entry for the id under
// another host (this host wrote it) fails at once. One read every WAITER_POLL_MS until a read passes or 10 s from the start (no read after it), a
// bounded `for` loop (AD-19). Read-only: nothing to undo. Resolves `{history: [{host, device, id, eventIds, syncedThrough, shownMs}]}`.
export async function historyCheck({ ref, api, lanes, now = Date.now, sleep = realSleep, log = () => {} } = {}) {
  if (typeof ref !== 'string' || ref === '') throw new TypeError('historyCheck: a release ref is required');
  if (typeof api !== 'function') throw new TypeError('historyCheck: an api caller is required');
  if (!Array.isArray(lanes) || lanes.length === 0) throw new TypeError('historyCheck: lanes is the non-empty result of laneCheck');
  const fail = detail => Object.assign(failure('history', detail), { detail });
  const seconds = HISTORY_SHOWS_WITHIN_MS / 1000;
  const rangesOf = answer => JSON.stringify({ unreachable_ranges: answer.unreachable_ranges ?? [], synced_through: answer.synced_through ?? null });

  const start = now();
  const base = `/history?claimant=${HOLDER}&from=${new Date(start - HISTORY_LOOKBACK_MS).toISOString()}&limit=1000`;

  // One read: every page of the answer. `{events, partial, last}`: `partial` is false only when every page says so, `last` is the last page.
  const read = async () => {
    const events = [];
    let partial = false;
    let last = null;
    let cursor = null;
    for (let page = 1; page <= HISTORY_MAX_PAGES; page += 1) {
      const result = await api({ method: 'GET', path: cursor === null ? base : `${base}&cursor=${encodeURIComponent(cursor)}` });
      const body = result?.body;
      if (result?.status !== 200 || !isObject(body) || body.format !== 1 || !Array.isArray(body.events)) {
        const code = isObject(body) && body.code ? ` ${body.code}` : '';
        const detail = isObject(body) && body.detail ? `: ${String(body.detail).slice(0, 200)}` : result?.status === 200 ? ': no format 1 answer with an events array' : '';
        throw fail(`/history answered status ${result?.status}${code}${detail}`);
      }
      events.push(...body.events);
      partial ||= body.partial !== false;
      last = body;
      if (body.more !== true || typeof body.cursor !== 'string') break;
      cursor = body.cursor;
    }
    return { events, partial, last };
  };

  // The verdict on one read: throws at once for an entry another host wrote, else `{shown}` (the lane results) or `{missing}` (why not yet).
  const judge = ({ events, partial, last }) => {
    const entries = events.filter(entry => isObject(entry) && isObject(entry.event));
    const mine = lane => entries.filter(entry => entry.event.lease_id === lane.id);
    for (const lane of lanes) {
      for (const entry of mine(lane)) {
        const host = entry.host ?? 'no host';
        if (entry.host !== lane.host) throw fail(`${host} wrote an event for ${lane.id}: it is in ${host}'s log`);
        if (!EVENT_ID.test(String(entry.id))) throw fail(`the ${entry.event.event} of ${lane.id} has the id ${entry.id ?? '(none)'}, not <host_id>/<YYYY-MM>/<offset>`);
      }
    }
    const shown = [];
    for (const lane of lanes) {
      const acquire = mine(lane).find(entry => entry.event.event === 'acquire');
      const release = mine(lane).find(entry => entry.event.event === 'release');
      const syncedThrough = last.synced_through?.[lane.host];
      const aside = partial ? ` (the answer is partial: true, ${rangesOf(last)})` : '';
      if (acquire === undefined) return { missing: `the acquire of ${lane.id} is not in ${lane.host}'s history${aside}` };
      if (release === undefined) return { missing: `the release of ${lane.id} is not in ${lane.host}'s history${aside}` };
      if (partial) return { missing: `the answer is partial: true, ${rangesOf(last)}` };
      if (!isoTime(syncedThrough)) return { missing: `synced_through of ${lane.host} is ${JSON.stringify(syncedThrough ?? null)}, not an ISO time` };
      shown.push({ host: lane.host, device: lane.device, id: lane.id, eventIds: [acquire.id, release.id], syncedThrough });
    }
    return { shown };
  };

  try {
    const deadline = start + HISTORY_SHOWS_WITHIN_MS;
    const tries = Math.ceil(HISTORY_SHOWS_WITHIN_MS / WAITER_POLL_MS) + 2;
    let verdict = { missing: 'no read was made' };
    for (let attempt = 1; attempt <= tries; attempt += 1) {
      verdict = judge(await read());
      if (verdict.shown !== undefined) break;
      const left = deadline - now();
      if (left <= 0) break;
      await sleep(Math.min(WAITER_POLL_MS, left));
      if (now() >= deadline) break;
    }
    if (verdict.shown === undefined) throw fail(`${verdict.missing} within ${seconds} s`);
    const shownMs = now() - start;
    const history = verdict.shown.map(entry => ({ ...entry, shownMs }));
    for (const entry of history) {
      log(`HUB_SMOKE history: ${entry.device} on ${entry.host}: acquire and release of ${entry.id} read back from ${entry.host}'s log (${entry.eventIds[0]}, ${entry.eventIds[1]}), partial false, ${entry.host} synced_through ${entry.syncedThrough}, in ${shownMs} ms`);
    }
    return { history };
  } catch (error) {
    throw error.smoke ? error : fail(`unexpected: ${error.message}`);
  }
}

// The whole check. Seams: `cli(args)` -> `{code, stdout, stderr}` (hub-device), `fetchImpl`, `now`, `sleep`, `log`, `policy`, `members()`
// (the `phone` word's device names), `name` (the test phone's name), `holds` (`false`, the default, skips the holds phase; `true` runs it on
// the test phone; a device word runs it on that word), `stream` (`false`, the default, skips the stream phase: see `streamCheck`) and `restart`
// (`false`, the default; `true` needs `stream` and restarts the service through the `restartUnit` seam, which `systemctl --user restart`s the
// unit by default), `lanes` (`false`, the default, skips the lanes phase: see `laneCheck`; `lanesOf` is its seam) and `history` (`false`, the
// default; `true` needs `lanes` and runs `historyCheck` on the lanes it took). Resolves the line `HUB_SMOKE_OK ...`; rejects with
// `HUB_SMOKE_FAILED <step>: <detail>` (`code` HUB_SMOKE_FAILED, `step`, `smoke: true`) after cleaning up what it registered.
export async function hubSmoke({
  ref,
  cli,
  fetchImpl = globalThis.fetch,
  now = Date.now,
  sleep = realSleep,
  log = line => process.stdout.write(`${line}\n`),
  policy = loadPolicy().policy,
  members: readMembers = () => phoneWordMembers(),
  name = null,
  holds = false,
  stream = false,
  restart = false,
  restartUnit = restartHubApiUnit,
  lanes = false,
  lanesOf = hostLanes,
  history = false,
} = {}) {
  if (typeof ref !== 'string' || ref === '') throw new TypeError('hubSmoke: a release ref is required');
  if (typeof cli !== 'function') throw new TypeError('hubSmoke: a cli (hub-device runner) is required');
  if (typeof holds !== 'boolean' && (typeof holds !== 'string' || holds === '')) throw new TypeError('hubSmoke: holds is a boolean or a device word');
  if (typeof stream !== 'boolean') throw new TypeError('hubSmoke: stream is a boolean');
  if (typeof restart !== 'boolean') throw new TypeError('hubSmoke: restart is a boolean');
  if (restart && !stream) throw new TypeError('hubSmoke: restart needs stream');
  if (typeof lanes !== 'boolean') throw new TypeError('hubSmoke: lanes is a boolean');
  if (typeof history !== 'boolean') throw new TypeError('hubSmoke: history is a boolean');
  if (history && !lanes) throw new TypeError('hubSmoke: history needs lanes');
  const why = `hosts:smoke ${ref}`;
  const step = (label, text) => log(`HUB_SMOKE ${label}: ${text}`);
  const fail = (label, detail) => { const error = failure(label, detail); log(error.message); return error; };
  const state = { id: null, leaseId: null, retired: false };
  const phone = (name ?? `smoke-${now().toString(36)}`).slice(0, NAME_MAX);

  // 1. health: nothing is registered before this answers as the release.
  let health;
  try {
    const response = await fetchImpl(`${hubUrl(policy)}/health`, { method: 'GET', headers: { accept: 'application/json' }, signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) });
    const text = typeof response.text === 'function' ? await response.text() : JSON.stringify(await response.json());
    health = response.status === 200 ? parseJson(text) : undefined;
    if (health === undefined || health === null || typeof health !== 'object') throw new Error(`/health answered ${response.status} without JSON`);
  } catch (error) { throw fail('health', `the Hub API did not answer on ${hubUrl(policy)}/health (${error.message})`); }
  if (health.service !== HUB_API_SERVICE) throw fail('health', `/health is ${health.service ?? 'not the Hub API'}, not ${HUB_API_SERVICE}`);
  if (health.hub_version !== ref) throw fail('health', `the Hub API runs ${health.hub_version ?? 'an unknown version'}, not ${ref}`);
  if (health.ok !== true) throw fail('health', '/health does not say ok');
  if (health.contract !== HUB_API_CONTRACT) throw fail('health', `the Hub API speaks contract ${health.contract ?? 'unknown'}, not ${HUB_API_CONTRACT}`);
  if (health.registry !== 'ok') throw fail('health', `the Registry is ${health.registry ?? 'not reported'}`);
  step('health', `${HUB_API_SERVICE} ${health.hub_version}, contract ${health.contract ?? '?'}, registry ${health.registry}`);

  // What to undo once the phone exists: the lease, then the Resource. Each is logged, and neither can hide the failure that started it.
  const cleanup = async () => {
    if (state.leaseId !== null) {
      const released = await cli(['release', state.leaseId]).catch(error => ({ code: 127, stderr: error.message }));
      step('cleanup', released.code === 0 ? `released ${state.leaseId}` : `release of ${state.leaseId} failed (${brief(released)})`);
      if (released.code === 0) state.leaseId = null;
    }
    if (state.id !== null && !state.retired) {
      const retired = await cli(['registry', 'retire', state.id, '--holder', HOLDER, '--why', why]).catch(error => ({ code: 127, stderr: error.message }));
      step('cleanup', retired.code === 0 ? `retired ${state.id}` : `retire of ${state.id} failed (${brief(retired)})`);
      if (retired.code === 0) state.retired = true;
    }
  };
  const stop = async (label, detail) => { const error = fail(label, detail); await cleanup(); return error; };
  const listed = async () => {
    const status = await cli(['status', '--json']);
    const body = status.code === 0 ? parseJson(status.stdout) : undefined;
    if (!Array.isArray(body?.phones)) throw new Error(`status --json gave no phones (${brief(status)})`);
    return body.phones.some(entry => entry.device === phone);
  };

  // 2. list
  const list = await cli(['registry', 'list', '--json']);
  const registry = list.code === 0 ? parseJson(list.stdout) : undefined;
  if (!Array.isArray(registry?.resources)) throw fail('list', `registry list --json did not read the Registry (${brief(list)})`);
  step('list', `registry rev ${registry.rev}, ${registry.resources.length} Resources`);

  // 3. register
  const added = await cli(['registry', 'add', '--kind', 'phone', '--name', phone, '--model', 'hub smoke', '--holder', HOLDER, '--why', why]);
  const registered = /^HUB_DEVICE_REGISTERED (\S+) (\S+)/m.exec(added.stdout ?? '');
  if (added.code !== 0 || registered === null) throw fail('register', `registry add was refused (${brief(added)})`);
  state.id = registered[1];
  step('register', `${registered[1]} ${registered[2]}`);

  try {
    // 4. leasable: by name, within 60 s. A bounded loop; a try never starts after the deadline.
    const start = now();
    const deadline = start + LEASABLE_WITHIN_MS;
    const tries = Math.ceil(LEASABLE_WITHIN_MS / TRY_EVERY_MS) + 2;
    let taken = null;
    let last = null;
    for (let attempt = 1; attempt <= tries; attempt += 1) {
      last = await cli(['lease', phone, '--no-connect', '--wait', '0', '--for', '1m', '--why', why, '--holder', HOLDER, '--json']);
      const body = last.code === 0 ? parseJson(last.stdout) : undefined;
      if (typeof body?.lease_id === 'string') { taken = body; break; }
      const left = deadline - now();
      if (left <= 0) break;
      await sleep(Math.min(TRY_EVERY_MS, left));
      if (now() >= deadline) break;
    }
    if (taken === null) throw await stop('leasable', `${phone} was not leasable within ${LEASABLE_WITHIN_MS / 1000} s (last try: ${brief(last)})`);
    state.leaseId = taken.lease_id;
    const waited = now() - start;
    step('leasable', `${taken.lease_id} on ${taken.device ?? phone} after ${waited} ms`);
    if (!(await readMembers()).includes(phone)) throw await stop('leasable', `the phone word does not list ${phone}`);
    if (!(await listed())) throw await stop('leasable', `status does not list ${phone}`);
    step('phone', `the phone word and status list ${phone}`);

    // 5. release
    const released = await cli(['release', state.leaseId]);
    if (released.code !== 0) throw await stop('release', `release of ${state.leaseId} failed (${brief(released)})`);
    step('release', state.leaseId);
    state.leaseId = null;

    // 5b. holds: the Hold routes through both doors, on the test phone or on the word asked for. It cleans up its own ids; a failure
    // then retires the phone like any other.
    let held = null;
    if (holds !== false) {
      const target = holds === true ? phone : holds;
      try {
        held = await holdParity({ target, tag: phone, ref, cli, api: apiCaller(fetchImpl, policy), now, sleep, log });
      } catch (error) { throw await stop('holds', error.detail ?? error.message); }
      step('holds', `api and cli match on ${held.target} (${held.traces.api.length} steps: ${held.traces.api.map(entry => entry.step).join(', ')})`);
    }

    // 5c. stream: the live status on the test phone (and the restart half, when asked). It cleans up its own Lease; a failure then retires
    // the phone like any other.
    if (stream) {
      let streamed;
      try {
        streamed = await streamCheck({ tag: phone, ref, cli, fetchImpl, policy, restart, restartUnit, now, sleep, log });
      } catch (error) { throw await stop(error.step ?? 'stream', error.detail ?? error.message); }
      step('stream', `status frame ${streamed.statusMs} ms after the lease, keepalive after ${streamed.keepaliveMs} ms idle`);
      if (streamed.restart !== null) step('restart', `${phone}-s held across the restart; the reconnect got reset (boot ${streamed.restart.boots[0]} -> ${streamed.restart.boots[1]})`);
    }

    // 5d. lanes: every other host's lane, taken and released through hub-device from here (opt-in). It cleans up its own ids; a failure then
    // retires the phone like any other.
    let laned = null;
    if (lanes) {
      try {
        laned = await laneCheck({ tag: phone, ref, cli, lanesOf, now, sleep, log });
      } catch (error) { throw await stop('lanes', error.detail ?? error.message); }
    }

    // 5e. history: the events those lane leases wrote in each spoke's own log, read back from this host's /history (opt-in, read-only).
    if (history) {
      try {
        await historyCheck({ ref, api: apiCaller(fetchImpl, policy), lanes: laned.lanes, now, sleep, log });
      } catch (error) { throw await stop('history', error.detail ?? error.message); }
    }

    // 6. retire
    const retired = await cli(['registry', 'retire', state.id, '--holder', HOLDER, '--why', why]);
    if (retired.code !== 0 || !/^HUB_DEVICE_RETIRED /m.test(retired.stdout ?? '')) throw await stop('retire', `registry retire was refused (${brief(retired)})`);
    state.retired = true;
    step('retire', (/^HUB_DEVICE_RETIRED (.*)$/m.exec(retired.stdout)?.[1] ?? '').trim());

    // 7. gone
    const again = await cli(['lease', phone, '--no-connect', '--wait', '0', '--for', '1m', '--why', why, '--holder', HOLDER, '--json']);
    if (again.code !== 2 || !/^HUB_RESOURCE_RETIRED\b/m.test(again.stderr ?? '')) {
      if (again.code === 0) { const extra = parseJson(again.stdout)?.lease_id; if (typeof extra === 'string') { state.leaseId = extra; } }
      throw await stop('gone', `a lease of the retired ${phone} was not refused HUB_RESOURCE_RETIRED (${brief(again)})`);
    }
    if ((await readMembers()).includes(phone)) throw await stop('gone', `the phone word still lists the retired ${phone}`);
    if (await listed()) throw await stop('gone', `status still lists the retired ${phone}`);
    step('gone', `${phone} is refused, and gone from the phone word and status`);

    const line = `HUB_SMOKE_OK ${ref} ${state.id} leasable after ${waited} ms`;
    log(line);
    return line;
  } catch (error) {
    if (error.smoke) throw error;
    // Anything unexpected (a seam that threw) still undoes what the smoke did.
    throw await stop('unexpected', error.message);
  }

}

function option(argv, flag) {
  const index = argv.indexOf(flag);
  if (index === -1) return undefined;
  const value = argv[index + 1];
  if (value === undefined || value.startsWith('--')) throw new Error(`${flag} takes a value`);
  return value;
}

// The entry's arguments: `{hubDevice, ref, holds, stream, restart, lanes, history}` (`ref` undefined when not given; `holds` true by default, a word for
// `--holds-on`, false for `--no-holds`; `stream` true by default, false for `--no-stream`; `restart` false unless `--restart`; `lanes` false
// unless `--lanes`; `history` false unless `--history`). Throws a usage Error for an unknown word, a flag without its value, both holds flags,
// `--restart` with `--no-stream`, or `--history` without `--lanes`.
export function parseSmokeArgs(argv) {
  const valued = new Set(['--hub-device', '--ref', '--holds-on']);
  const bare = new Set(['--no-holds', '--no-stream', '--restart', '--lanes', '--history']);
  const stray = argv.filter((word, index) => !valued.has(word) && !bare.has(word) && !valued.has(argv[index - 1]));
  if (stray.length > 0) throw new Error(`usage: mise run hosts:smoke [-- --hub-device <cmd>] [--ref <ref>] [--holds-on <word> | --no-holds] [--no-stream | --restart] [--lanes [--history]] (unknown: ${stray[0]})`);
  const on = option(argv, '--holds-on');
  const off = argv.includes('--no-holds');
  if (on !== undefined && off) throw new Error('--holds-on and --no-holds exclude each other');
  const stream = !argv.includes('--no-stream');
  const restart = argv.includes('--restart');
  if (restart && !stream) throw new Error('--restart and --no-stream exclude each other: the restart is part of the stream phase');
  const lanes = argv.includes('--lanes');
  const history = argv.includes('--history');
  if (history && !lanes) throw new Error('--history needs --lanes: the history phase reads back the events the lanes phase wrote');
  return { hubDevice: option(argv, '--hub-device') ?? 'hub-device', ref: option(argv, '--ref'), holds: off ? false : on ?? true, stream, restart, lanes, history };
}

// The entry's body: parse the arguments, run the smoke with `holds`, `stream`, `restart`, `lanes` and `history` forwarded, and resolve the exit code (0, or 1 after a
// `HUB_SMOKE_FAILED` line on stderr for a usage failure or a failure that is not the smoke's own, which logged itself).
export async function runEntry(argv, { smoke = hubSmoke, makeCli = hubDeviceCli, defaultRef = releaseName } = {}) {
  try {
    const { hubDevice, ref, holds, stream, restart, lanes, history } = parseSmokeArgs(argv);
    await smoke({ ref: ref ?? defaultRef(), cli: makeCli(hubDevice), holds, stream, restart, lanes, history });
    return 0;
  } catch (error) {
    if (!error.smoke) console.error(`HUB_SMOKE_FAILED ${error.message}`);
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runEntry(process.argv.slice(2)).then(code => { process.exitCode = code; });
}
