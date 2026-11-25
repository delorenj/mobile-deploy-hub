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
//   6. retire   the phone is retired through the API;
//   7. gone     a new lease is refused `HUB_RESOURCE_RETIRED`, and the `phone` members and `status` no longer list it.
// Any failure after the register releases the lease it took and retires the phone, and both are logged. The run prints
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

// The whole check. Seams: `cli(args)` -> `{code, stdout, stderr}` (hub-device), `fetchImpl`, `now`, `sleep`, `log`, `policy`, `members()`
// (the `phone` word's device names), `name` (the test phone's name). Resolves the line `HUB_SMOKE_OK ...`; rejects with
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
} = {}) {
  if (typeof ref !== 'string' || ref === '') throw new TypeError('hubSmoke: a release ref is required');
  if (typeof cli !== 'function') throw new TypeError('hubSmoke: a cli (hub-device runner) is required');
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

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const argv = process.argv.slice(2);
    const known = new Set(['--hub-device', '--ref']);
    const stray = argv.filter((word, index) => !known.has(word) && !known.has(argv[index - 1]));
    if (stray.length > 0) throw new Error(`usage: mise run hosts:smoke [-- --hub-device <cmd>] [--ref <ref>] (unknown: ${stray[0]})`);
    const cli = hubDeviceCli(option(argv, '--hub-device') ?? 'hub-device');
    hubSmoke({ ref: option(argv, '--ref') ?? releaseName(), cli }).catch(error => {
      if (!error.smoke) console.error(`HUB_SMOKE_FAILED ${error.message}`);
      process.exitCode = 1;
    });
  } catch (error) { console.error(`HUB_SMOKE_FAILED ${error.message}`); process.exitCode = 1; }
}
