// hub-device's own adb runner. tools/ci/lib/adb.mjs's createAdb (spawnSync, used by the deploy jobs) cannot be
// interrupted mid-call, so a signal during discovery would wait out the adb command. This runner spawns adb
// asynchronously and kills the child when the AbortSignal fires, so `hub-device lease|run` stops at once. The deploy
// path keeps createAdb unchanged. Output goes to files, not pipes, for the same reason exec.mjs's attempt() does it:
// `adb start-server` forks a server that would inherit a pipe and hold it open long after the client exited.
import { spawn } from 'node:child_process';
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { adbEnv, adbPath, parseDeviceList, parseMdnsEndpoint } from '../ci/lib/adb.mjs';

export const aborted = signal => signal.reason ?? Object.assign(new Error('adb aborted'), { name: 'AbortError' });

export function runAdb(adb, args, { env, signal, timeout = 30_000 } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(aborted(signal)); return; }
    const dir = mkdtempSync(join(tmpdir(), 'hub-device-adb-'));
    const out = openSync(join(dir, 'out'), 'w');
    const err = openSync(join(dir, 'err'), 'w');
    let child;
    try {
      child = spawn(adb, args, { env, stdio: ['ignore', out, err] });
    } finally {
      closeSync(out);
      closeSync(err);
    }
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      rmSync(dir, { recursive: true, force: true });
      if (error) reject(error); else resolve(value);
    };
    const onAbort = () => { child.kill('SIGKILL'); finish(aborted(signal)); };
    const timer = setTimeout(() => { child.kill('SIGKILL'); finish(new Error(`adb ${args[0] ?? ''} did not finish within ${Math.round(timeout / 1000)}s`)); }, timeout);
    signal?.addEventListener('abort', onAbort, { once: true });
    child.on('error', error => finish(error));
    child.on('exit', code => {
      let stdout = '';
      let stderr = '';
      try { stdout = readFileSync(join(dir, 'out'), 'utf8'); stderr = readFileSync(join(dir, 'err'), 'utf8'); } catch { /* already cleaned up */ }
      if (code === 0) { finish(null, stdout); return; }
      const tail = `${stdout}${stderr}`.trim().slice(-3000);
      finish(new Error(`adb ${args[0] ?? ''} failed (exit ${code})${tail ? `\n${tail}` : ''}`));
    });
  });
}

// The subset of createAdb's interface findPhone uses, each call abortable through `signal`.
export function createAsyncAdb({ env: given = process.env, signal } = {}) {
  const env = adbEnv(given);
  const adb = adbPath(env);
  const call = (args, timeout = 30_000, extra = {}) => runAdb(adb, args, { env: { ...env, ...extra }, signal, timeout });
  return {
    // The server must outlive this process, as createAdb's does: no RUNNER_TRACKING_ID on it.
    startServer: () => call(['start-server'], 60_000, { RUNNER_TRACKING_ID: '' }),
    mdnsEndpoint: async serial => parseMdnsEndpoint(await call(['mdns', 'services'], 15_000), serial),
    connect: endpoint => call(['connect', endpoint], 30_000),
    devices: async () => parseDeviceList(await call(['devices'])),
    prop: async (id, name) => (await call(['-s', id, 'shell', 'getprop', name])).trim(),
  };
}
