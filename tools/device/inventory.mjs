// A read-only inventory of what runs on this host around the shared phone: adb servers, Android emulators and Xvfb
// displays, read from /proc. Each is `managed` (the hub's own: the adb server on the hub's port, or anything that
// carries HUB_MANAGED=1 in its environment or is listed in <lock dir>/managed.json as {"pids": [...]}) or `foreign`
// (somebody else's). Nothing here signals, starts, stops or connects to anything.
import { readFileSync, readdirSync, readlinkSync } from 'node:fs';
import { join } from 'node:path';

const read = path => { try { return readFileSync(path); } catch { return null; } };
const baseName = path => path.slice(path.lastIndexOf('/') + 1);

function environOf(dir) {
  const env = {};
  for (const entry of (read(join(dir, 'environ')) ?? Buffer.alloc(0)).toString('utf8').split('\0')) {
    const at = entry.indexOf('=');
    if (at > 0) env[entry.slice(0, at)] = entry.slice(at + 1);
  }
  return env;
}

const flagValue = (argv, flag) => { const at = argv.indexOf(flag); return at === -1 ? null : argv[at + 1] ?? null; };

// `-L tcp:5037`, `-L tcp:localhost:15170`, `-L tcp:*:5037`: the port is the last field.
function adbServerPort(argv, env) {
  const listen = flagValue(argv, '-L');
  const fromListen = listen && /^tcp:(?:[^:]*:)?(\d+)$/.exec(listen);
  if (fromListen) return Number(fromListen[1]);
  return Number(env.ANDROID_ADB_SERVER_PORT) || 5037;
}

function emulatorPorts(argv) {
  const port = flagValue(argv, '-port');
  if (port && /^\d+$/.test(port)) return Number(port);
  const ports = flagValue(argv, '-ports');
  if (ports && /^\d+/.test(ports)) return Number(/^\d+/.exec(ports)[0]);
  return null;
}

function managedPids(lockRoot) {
  try {
    const pids = JSON.parse(readFileSync(join(lockRoot, 'managed.json'), 'utf8')).pids;
    return new Set(Array.isArray(pids) ? pids.filter(Number.isSafeInteger) : []);
  } catch { return new Set(); }
}

export function inventory({ procRoot = '/proc', lockRoot, hubAdbPort = 5037 } = {}) {
  const registered = lockRoot ? managedPids(lockRoot) : new Set();
  const adbServers = [];
  const emulators = [];
  const displays = [];
  let pids = [];
  try { pids = readdirSync(procRoot).filter(entry => /^\d+$/.test(entry)); } catch { /* no /proc here */ }
  for (const entry of pids) {
    const dir = join(procRoot, entry);
    const argv = (read(join(dir, 'cmdline')) ?? Buffer.alloc(0)).toString('utf8').split('\0').filter(Boolean);
    if (argv.length === 0) continue;
    const pid = Number(entry);
    const program = baseName(argv[0]);
    const env = environOf(dir);
    const tagged = env.HUB_MANAGED === '1' || registered.has(pid);
    let cwd = null;
    try { cwd = readlinkSync(join(dir, 'cwd')); } catch { /* not ours to read */ }
    if (program === 'adb' && (argv.includes('fork-server') || argv.includes('server'))) {
      const port = adbServerPort(argv, env);
      adbServers.push({ port, pid, managed: tagged || port === hubAdbPort, cwd });
    } else if (/^qemu-system-.+/.test(program) || program === 'emulator' || program.startsWith('emulator-')) {
      const avd = flagValue(argv, '-avd') ?? (argv.find(arg => arg.startsWith('@'))?.slice(1) ?? null);
      if (!avd) continue;
      emulators.push({ avd, console_port: emulatorPorts(argv), adb_server: Number(env.ANDROID_ADB_SERVER_PORT) || 5037, pid, managed: tagged, cwd, qemu: program.startsWith('qemu-system-') });
    } else if (program === 'Xvfb') {
      const display = argv.find(arg => /^:\d+$/.test(arg));
      if (display) displays.push({ display, pid, managed: tagged, cwd });
    }
  }
  // The launcher execs qemu; if a wrapper is still listed beside the qemu of the same AVD, the qemu process is the emulator.
  const seen = new Map();
  for (const { qemu, ...emulator } of emulators) {
    const prior = seen.get(emulator.avd);
    if (!prior || (qemu && !prior.qemu)) seen.set(emulator.avd, { ...emulator, qemu });
  }
  const byPid = (a, b) => a.pid - b.pid;
  return { adb_servers: adbServers.sort(byPid), emulators: [...seen.values()].map(({ qemu, ...emulator }) => emulator).sort(byPid), xvfb: displays.sort(byPid) };
}
