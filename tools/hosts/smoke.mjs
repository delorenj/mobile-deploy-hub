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
//   6. retire   the phone is retired through the API;
//   7. gone     a new lease is refused `HUB_RESOURCE_RETIRED`, and the `phone` members and `status` no longer list it.
// Any failure after the register releases the lease it took (and every id the holds phase started) and retires the phone, and each is logged. The run prints
// `HUB_SMOKE <step>: ...` lines and ends `HUB_SMOKE_OK <ref> <id> leasable after <n> ms` (exit 0) or `HUB_SMOKE_FAILED <step>: ...`
// (exit 1). It is never part of hosts:install: names and ids are never reused (AD-28), so every run leaves one retired record in
// registry.json, which is the price of asking for the check and not of every install.
import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sleep as realSleep } from '../ci/lib/pause.mjs';
import { loadPolicy } from '../ci/lib/policy.mjs';
import { phoneWordMembers } from '../device/claims.mjs';
import { HUB_API_SERVICE, hubUrl } from '../hub-client.mjs';
import { releaseName } from '../hosts.mjs';

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

// The whole check. Seams: `cli(args)` -> `{code, stdout, stderr}` (hub-device), `fetchImpl`, `now`, `sleep`, `log`, `policy`, `members()`
// (the `phone` word's device names), `name` (the test phone's name), `holds` (`false`, the default, skips the holds phase; `true` runs it on
// the test phone; a device word runs it on that word). Resolves the line `HUB_SMOKE_OK ...`; rejects with
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
} = {}) {
  if (typeof ref !== 'string' || ref === '') throw new TypeError('hubSmoke: a release ref is required');
  if (typeof cli !== 'function') throw new TypeError('hubSmoke: a cli (hub-device runner) is required');
  if (typeof holds !== 'boolean' && (typeof holds !== 'string' || holds === '')) throw new TypeError('hubSmoke: holds is a boolean or a device word');
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

// The entry's arguments: `{hubDevice, ref, holds}` (`ref` undefined when not given; `holds` true by default, a word for `--holds-on`, false
// for `--no-holds`). Throws a usage Error for an unknown word, a flag without its value, or both holds flags.
export function parseSmokeArgs(argv) {
  const valued = new Set(['--hub-device', '--ref', '--holds-on']);
  const stray = argv.filter((word, index) => !valued.has(word) && word !== '--no-holds' && !valued.has(argv[index - 1]));
  if (stray.length > 0) throw new Error(`usage: mise run hosts:smoke [-- --hub-device <cmd>] [--ref <ref>] [--holds-on <word> | --no-holds] (unknown: ${stray[0]})`);
  const on = option(argv, '--holds-on');
  const off = argv.includes('--no-holds');
  if (on !== undefined && off) throw new Error('--holds-on and --no-holds exclude each other');
  return { hubDevice: option(argv, '--hub-device') ?? 'hub-device', ref: option(argv, '--ref'), holds: off ? false : on ?? true };
}

// The entry's body: parse the arguments, run the smoke with `holds` forwarded, and resolve the exit code (0, or 1 after a
// `HUB_SMOKE_FAILED` line on stderr for a usage failure or a failure that is not the smoke's own, which logged itself).
export async function runEntry(argv, { smoke = hubSmoke, makeCli = hubDeviceCli, defaultRef = releaseName } = {}) {
  try {
    const { hubDevice, ref, holds } = parseSmokeArgs(argv);
    await smoke({ ref: ref ?? defaultRef(), cli: makeCli(hubDevice), holds });
    return 0;
  } catch (error) {
    if (!error.smoke) console.error(`HUB_SMOKE_FAILED ${error.message}`);
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runEntry(process.argv.slice(2)).then(code => { process.exitCode = code; });
}
