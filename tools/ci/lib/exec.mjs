// Process helpers. Hooks come from the committed manifest and run under bash in the app root.
import { spawnSync } from 'node:child_process';

// Runs a program, captures output, throws with the tail of the output on failure.
export function run(command, args, { cwd, env, input } = {}) {
  const result = spawnSync(command, args, { cwd, env, input, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  if (result.error || result.status !== 0) {
    throw new Error(`${command} ${args[0] ?? ''} failed (${result.error?.message ?? `exit ${result.status}`})\n${output.slice(-4000)}`);
  }
  return result.stdout ?? '';
}

// Runs a manifest hook with output streaming to the job log.
export function hook(name, command, { cwd, env }) {
  console.log(`::group::hook ${name}`);
  console.log(`$ ${command}`);
  const result = spawnSync('bash', ['-eo', 'pipefail', '-c', command], { cwd, env, stdio: 'inherit' });
  console.log('::endgroup::');
  if (result.error || result.status !== 0) throw new Error(`hook ${name} failed (${result.error?.message ?? `exit ${result.status}`})`);
}
