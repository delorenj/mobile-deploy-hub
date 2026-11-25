// `heavy` and the one PATH resolver (Story 6.11, AD-45). The Hub API service refuses to start without `heavy` on PATH, and the
// emulator pool wraps every long-lived process it launches in it on Linux. Both ask the same `which`, so they cannot disagree.
//
// Why wrap: the service runs under systemd with KillMode=mixed. A stop sends SIGTERM to the main process, then SIGKILL to what is left
// in the service's cgroup. An emulator that the service started with a bare spawn lives in that cgroup and dies with it. `heavy` ends in
// `exec systemd-run --user --scope ... -- "$@"`, and a --scope run execs the command after moving itself into its own scope (under
// batch.slice), outside the service's cgroup. It is an exec all the way down, so the pid `spawn` returns is the emulator's and its
// start time (/proc/<pid>/stat) is unchanged: the lease's recorded pid and start time stay true.
import { accessSync, constants, statSync } from 'node:fs';
import { delimiter, join } from 'node:path';

// The path of the first executable file called `name` in a PATH directory of `env`, or null.
export function which(name, env = process.env) {
  for (const dir of String(env.PATH ?? '').split(delimiter)) {
    if (dir === '') continue;
    const file = join(dir, name);
    try {
      if (!statSync(file).isFile()) continue;
      accessSync(file, constants.X_OK);
      return file;
    } catch { /* not here */ }
  }
  return null;
}

// True when an executable file called `name` is in a PATH directory of `env`.
export const onPath = (name, env = process.env) => which(name, env) !== null;

// What `heavy` needs to reach the user's systemd manager (`systemd-run --user`). Without them it falls back to nice/ionice and the
// process stays in the caller's cgroup, where a KillMode=mixed stop kills it.
const MANAGER_VARS = ['XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS'];

// The command a long-lived process is spawned with: `heavy <command> <args...>` on Linux when `heavy` is on the launch env's PATH, else
// the command unchanged (macOS, or a host without heavy: the CLI still boots emulators there, only the service refuses). Returns
// `{command, args, env, heavy}`; spawn with all three.
//
// `env` is the env the process must run with; `manager` (default `env`) is the env that can reach the user manager. They differ when the
// process has a private XDG_RUNTIME_DIR (the emulator's): heavy itself is then spawned with the manager's values, and the process's own
// are put back with an `env` prefix (`env NAME=value ...`, or `env -u NAME` when it has none), which execs the command, so the pid is
// still the process's.
export function inHeavy(command, args = [], { env = process.env, platform = process.platform, manager = env } = {}) {
  const heavy = platform === 'linux' ? which('heavy', env) : null;
  if (!heavy) return { command, args, env, heavy: false };
  const spawnEnv = { ...env };
  const prefix = [];
  for (const name of MANAGER_VARS) {
    if (manager[name] === undefined) delete spawnEnv[name]; else spawnEnv[name] = manager[name];
    if (env[name] !== manager[name]) prefix.push(...(env[name] === undefined ? ['-u', name] : [`${name}=${env[name]}`]));
  }
  return { command: heavy, args: [...(prefix.length > 0 ? ['env', ...prefix] : []), command, ...args], env: spawnEnv, heavy: true };
}
