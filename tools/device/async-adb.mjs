// hub-device's own adb runner. Unlike tools/ci/lib/adb.mjs's createAdb (spawnSync, used by the deploy jobs), this
// spawns adb asynchronously so an interactive `hub-device run` can abort a slow discovery command mid-flight: when the
// AbortSignal fires, the child adb is killed and the call rejects instead of blocking the run for the rest of `--wait`.
// The deploy path keeps its synchronous createAdb unchanged.
import { spawn } from 'node:child_process';
import { adbPath, parseDeviceList, parseMdnsEndpoint } from '../ci/lib/adb.mjs';
import { isCredentialVariable } from '../ci/lib/config.mjs';

// No token reaches adb: its server outlives the caller and must not carry job credentials with it.
function cleanEnv(env) {
  const clean = {};
  for (const [name, value] of Object.entries(env)) if (!isCredentialVariable(name)) clean[name] = value;
  return clean;
}

export function createAsyncAdb({ env = process.env, signal, timeout = 30_000 } = {}) {
  const adb = adbPath(env);
  const base = cleanEnv(env);
  const call = (args, timeoutMs = timeout, envOverrides = {}) => new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? Object.assign(new Error('adb aborted'), { name: 'AbortError' }));
    const child = spawn(adb, args, {
      env: { ...base, ...envOverrides },
      stdio: ['ignore', 'pipe', 'pipe'],
      signal,
      killSignal: 'SIGKILL',
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    const timer = setTimeout(() => { child.kill('SIGKILL'); }, timeoutMs);
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', (code, killSignal) => {
      clearTimeout(timer);
      if (signal?.aborted) return reject(signal.reason ?? Object.assign(new Error('adb aborted'), { name: 'AbortError' }));
      if (code === 0) return resolve(stdout);
      const tail = `${stdout}${stderr}`.trim();
      reject(new Error(`adb ${args[0] ?? ''} failed (exit ${code}${killSignal ? `, ${killSignal}` : ''})${tail ? `\n${tail}` : ''}`));
    });
  });
  return {
    // The server must outlive the run, as createAdb does: no RUNNER_TRACKING_ID on the server process.
    startServer: () => call(['start-server'], 60_000, { RUNNER_TRACKING_ID: '' }),
    mdnsEndpoint: async serial => parseMdnsEndpoint(await call(['mdns', 'services'], 15_000), serial),
    connect: endpoint => call(['connect', endpoint]),
    devices: async () => parseDeviceList(await call(['devices'])),
    prop: async (id, name) => (await call(['-s', id, 'shell', 'getprop', name])).trim(),
  };
}
