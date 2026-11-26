// The host observations off the request path (Story 8.2; AD-44): the slow reads a service's status and discovery need, gathered in one
// worker thread so the main thread never scans /proc or waits on the adb wire while a request waits. The worker runs `observeHost` with
// the real readers; the main side is `observeOffThread({env, signal})`. The Hub API's host snapshot (tools/hub-api/snapshot.mjs) calls
// it, and the Host Agent (Epic 9) reuses both.
//
// A gather is `{inventory, adb, starts, live_starts}`, plain data (it crosses the worker boundary):
//   - `inventory`: the real `inventory()` (a full /proc scan: every process's cmdline and environ),
//   - `adb`: `queryAdb`'s answer ({port, note, listed, serials}), asked only when that inventory shows the hub's adb server running (the
//     rule `phoneObservations` follows), so a gather can never start one,
//   - `starts` / `live_starts`: Map(pid -> start) for every pid `listLocks`, `queueView` (stale tickets included, for every name the
//     lock dir holds a `.lock`, `.queue` or `.reservations` for) and `emulatorStatus` would read, through recording seams over the real
//     readers (`processStart`, the emulator's `liveStart`).
// No timer here: a worker lives until its one gather ends.
//
// A worker that crashes or ends without an answer rejects with `HUB_API_OBSERVE_FAILED`.
import { readdirSync } from 'node:fs';
import { Worker, isMainThread, parentPort, threadId, workerData } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { listLocks, lockDir, processStart, queueView } from '../ci/lib/lock.mjs';
import { sleep as realSleep } from '../ci/lib/pause.mjs';
import { queryAdb } from '../registry/reachability.mjs';
import { createAdbWire } from './adb-wire.mjs';
import { emulatorStatus, liveStart } from './emulator.mjs';
import { inventory as realInventory } from './inventory.mjs';

const OP = 'observe';

const failed = (message, extra = {}) => Object.assign(new Error(message), { code: 'HUB_API_OBSERVE_FAILED', ...extra });
const oneLine = value => String(value?.message ?? value).replace(/\s+/g, ' ').trim();
const plain = env => Object.fromEntries(Object.entries(env ?? {}).filter(([, value]) => typeof value === 'string'));

// ---- the gather ----

// Every name the lock dir holds a `.lock`, `.queue` or `.reservations` for.
function lockNames(env) {
  let entries = [];
  try { entries = readdirSync(lockDir(env)); } catch { return []; }
  const names = new Set();
  for (const entry of entries) {
    const match = /^(.+)\.(?:lock|queue|reservations)$/.exec(entry);
    if (match !== null) names.add(match[1]);
  }
  return [...names].sort();
}

// One gather, in the calling thread. The seams (`inventory`, `adbWire`, `sleep`, `startOf`, `liveStartOf`) default to the real readers; a
// test passes fakes (the worker always uses the real ones: functions do not cross into it).
export async function observeHost({ env = process.env, inventory = realInventory, adbWire = createAdbWire, sleep = realSleep, startOf = processStart, liveStartOf = liveStart } = {}) {
  const hubPort = Number(env.HUB_ADB_SERVER_PORT) || 5037;
  const found = inventory({ lockRoot: lockDir(env), hubAdbPort: hubPort });
  const adb = await queryAdb({ port: hubPort, running: found.adb_servers.some(server => server.port === hubPort), wire: adbWire, sleep });
  const starts = new Map();
  const liveStarts = new Map();
  const record = pid => { const value = startOf(pid); starts.set(pid, value); return value; };
  const recordLive = pid => { const value = liveStartOf(pid); liveStarts.set(pid, value); return value; };
  try { listLocks({ env, processStart: record }); } catch { /* an unreadable lock dir records nothing */ }
  for (const name of lockNames(env)) {
    try { queueView(name, { env, includeStale: true, processStart: record }); } catch { /* the next name */ }
  }
  try { emulatorStatus(env, { liveStart: recordLive }); } catch { /* no emulator records */ }
  return { inventory: found, adb, starts, live_starts: liveStarts };
}

// ---- the main side ----

// Runs one gather in a worker thread. Resolves with `observeHost`'s result; rejects with `HUB_API_OBSERVE_FAILED` (a crash, an end with
// no answer, or the worker's own error) or with `signal.reason` when the signal aborts. `log` gets one line naming the thread
// (`HUB_API_OBSERVE_THREAD thread=<n>`, n the worker's threadId, 1 or more). `script` is the worker's file (a test seam: a script that
// crashes or exits without answering proves the failure path); it defaults to this file.
export function observeOffThread({ env = process.env, log = () => {}, signal, script = fileURLToPath(import.meta.url) } = {}) {
  const say = line => { try { log(line); } catch { /* a broken log seam never changes the outcome */ } };
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason); return; }
    const clean = plain(env);
    const worker = new Worker(script, { workerData: { op: OP, env: clean }, env: clean, execArgv: [] });
    say(`HUB_API_OBSERVE_THREAD thread=${worker.threadId}`);
    let settled = false;
    const onAbort = () => finish(reject, signal.reason);
    const finish = (method, value) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener?.('abort', onAbort);
      worker.terminate().catch(() => {});
      method(value);
    };
    worker.on('message', message => {
      if (message?.type === 'done') finish(resolve, message.result);
      else if (message?.type === 'error') finish(reject, failed(`the host could not be observed: ${message.message}`));
    });
    worker.on('error', error => finish(reject, failed(`the observe worker crashed: ${oneLine(error)}`)));
    worker.on('exit', code => finish(reject, failed(`the observe worker ended without an answer (exit ${code})`)));
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

// ---- the worker side ----

async function work() {
  try {
    parentPort.postMessage({ type: 'done', result: await observeHost({ env: workerData.env }) });
  } catch (error) {
    parentPort.postMessage({ type: 'error', message: oneLine(error) });
  } finally {
    parentPort.close();
  }
}

// Only a worker `observeOffThread` started runs the gather: importing this file on the main thread does nothing.
if (!isMainThread && workerData?.op === OP && threadId > 0) await work();
