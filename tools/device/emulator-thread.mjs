// The emulator off the request path (Story 7.4; AD-44): a service answers an emulator take or release without ever calling `provision`,
// `reap`, `teardown` or `markedProcesses` on its main thread, whose `/proc` scans and boot polls would block every other request. The
// main side is `offThread(op, args, {env, log, signal})`; the worker side (this same file, started by it) runs the one operation with
// the real clock and the real sleep, and posts what it did back. No timer here: a worker lives until its operation ends.
//
// `op` is `provision` (the lazy reap, then `provision`: args are provision's own plain options: id, holder, why, forMs, waitMs,
// holderPid, profileName, pool, claimantKind, actor, pollMs, graceMs, bootTimeoutMs, bootPollMs) or `release` (`releaseEmulator`: id,
// graceMs, reason) or `force-release` (Story 7.8, AD-44: `forceReleaseSlot`, the reaper lock, the one `force-release` event and the
// teardown, all in the worker: args `slot`, `lease_id`, `actor`, `why`, `graceMs`, `reaperWaitMs`; the answer is its own, `{released,
// reason, owner, outcome, survivors}`). `process.pid` is the same in a worker, so a slot taken during the boot is tied to the service's pid: a service that
// dies mid-boot leaves an orphan the next `reap` tears down (`holder gone`).
//
// Worker messages: `log` (a line for the service log), `done` (the operation's result), `error` ({message, code, reason, retry,
// aborted}). The main side sends `abort` (the signal's reason) when its signal aborts; the worker's controller aborts, the operation
// tears down what it made, and the answer is the signal's own reason. An error with no `HUB_` code, or a worker that crashes or ends
// without answering, is HUB_EMULATOR_FAILED.
import { Worker, isMainThread, parentPort, threadId, workerData } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { forceReleaseSlot, provision, reap, releaseEmulator } from './emulator.mjs';

export const THREAD_OPS = Object.freeze(['provision', 'release', 'force-release']);

const failed = (message, extra = {}) => Object.assign(new Error(message), { code: 'HUB_EMULATOR_FAILED', ...extra });
const oneLine = value => String(value?.message ?? value).replace(/\s+/g, ' ').trim();
const plain = env => Object.fromEntries(Object.entries(env ?? {}).filter(([, value]) => typeof value === 'string'));

// What of an error crosses the thread boundary.
const carried = error => ({
  message: String(error?.message ?? error),
  code: typeof error?.code === 'string' && /^HUB_/.test(error.code) ? error.code : null,
  reason: typeof error?.reason === 'string' ? error.reason : null,
  retry: typeof error?.retry === 'string' ? error.retry : null,
});

// ---- the main side ----

// Runs `op` in a worker thread. Resolves with the operation's result; rejects with its error (a coded one keeps its code and `reason`),
// or with `signal.reason` itself when the operation ended because the signal aborted. `log` gets the worker's lines, and first one line
// naming the thread (`HUB_EMULATOR_THREAD <op> <id> thread=<n>`, n the worker's threadId, 1 or more).
export function offThread(op, args, { env = process.env, log = () => {}, signal } = {}) {
  if (!THREAD_OPS.includes(op)) throw new TypeError(`offThread: unknown op "${op}" (${THREAD_OPS.join(', ')})`);
  const say = line => { try { log(line); } catch { /* a broken log seam never changes the outcome */ } };
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason); return; }
    const clean = plain(env);
    const worker = new Worker(fileURLToPath(import.meta.url), { workerData: { op, args, env: clean }, env: clean, execArgv: [] });
    say(`HUB_EMULATOR_THREAD ${op} ${args?.id ?? args?.slot ?? '-'} thread=${worker.threadId}`);
    let settled = false;
    const onAbort = () => {
      const reason = signal.reason;
      worker.postMessage({ type: 'abort', ...carried(reason) });
    };
    const finish = (method, value) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener?.('abort', onAbort);
      worker.terminate().catch(() => {});
      method(value);
    };
    worker.on('message', message => {
      if (message?.type === 'log') say(message.line);
      else if (message?.type === 'done') finish(resolve, message.result);
      else if (message?.type === 'error') {
        if (message.aborted && signal?.aborted) { finish(reject, signal.reason); return; }
        finish(reject, Object.assign(new Error(message.message), { code: message.code ?? 'HUB_EMULATOR_FAILED', ...(message.reason ? { reason: message.reason } : {}) }));
      }
    });
    worker.on('error', error => finish(reject, failed(`the emulator worker crashed: ${oneLine(error)}`)));
    worker.on('exit', code => finish(reject, failed(`the emulator worker ended without an answer (exit ${code})`)));
    // An already-aborted signal was refused above, before the worker started.
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

// ---- the worker side ----

async function work() {
  const { op, args, env } = workerData;
  const controller = new AbortController();
  parentPort.on('message', message => {
    if (message?.type === 'abort') controller.abort(Object.assign(new Error(message.message ?? 'aborted'), { ...(message.code ? { code: message.code } : {}), ...(message.reason ? { reason: message.reason } : {}), ...(message.retry ? { retry: message.retry } : {}) }));
  });
  const log = line => parentPort.postMessage({ type: 'log', line: String(line) });
  try {
    let result;
    if (op === 'provision') {
      // The lazy reaper first, as every emulator acquire does: a failure of it is a warning, never a failed acquire.
      try { await reap({ env, log, graceMs: args.graceMs, wait: false }); } catch (error) { log(`hub-device: the emulator reaper failed: ${oneLine(error)}`); }
      result = await provision({ ...args, env, log, signal: controller.signal });
    } else if (op === 'force-release') {
      result = await forceReleaseSlot(args.slot, { lease_id: args.lease_id, actor: args.actor, why: args.why, env, log, graceMs: args.graceMs, ...(args.reaperWaitMs ? { reaperWaitMs: args.reaperWaitMs } : {}) });
    } else {
      result = await releaseEmulator(args.id, { env, log, graceMs: args.graceMs, reason: args.reason ?? null });
    }
    parentPort.postMessage({ type: 'done', result });
  } catch (error) {
    parentPort.postMessage({ type: 'error', ...carried(error), aborted: controller.signal.aborted });
  } finally {
    parentPort.close();
  }
}

// Only a worker `offThread` started runs the operation: importing this file on the main thread (or in a worker of something else) does nothing.
if (!isMainThread && THREAD_OPS.includes(workerData?.op) && threadId > 0) await work();
