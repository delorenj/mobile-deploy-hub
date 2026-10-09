// Process helpers. Hooks come from the committed manifest and run under bash in the app root.
import { spawnSync } from 'node:child_process';
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

// Runs a program, captures output, throws with the tail of the output on failure.
export function run(command, args, { cwd, env, input } = {}) {
  const result = spawnSync(command, args, { cwd, env, input, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  if (result.error || result.status !== 0) {
    throw new Error(`${command} ${args[0] ?? ''} failed (${result.error?.message ?? `exit ${result.status}`})\n${output.slice(-4000)}`);
  }
  return result.stdout ?? '';
}

// Runs a program with a deadline and returns {ok, status, stdout, stderr, timedOut} without throwing.
// stdout and stderr go to files, not pipes: a daemon the program starts (adb's server, op's daemon, xcodebuild's
// helpers) can inherit a pipe and keep it open, and spawnSync would then wait on it long after the deadline.
export function attempt(command, args, { cwd, env, input, timeout = 120_000 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'hub-run-'));
  const outFile = join(dir, 'out');
  const errFile = join(dir, 'err');
  const out = openSync(outFile, 'w');
  const err = openSync(errFile, 'w');
  let result;
  try {
    result = spawnSync(command, args, { cwd, env, input, stdio: [input === undefined ? 'ignore' : 'pipe', out, err], timeout, killSignal: 'SIGKILL' });
  } finally {
    closeSync(out);
    closeSync(err);
  }
  try {
    const stdout = readFileSync(outFile, 'utf8');
    const stderr = readFileSync(errFile, 'utf8');
    const timedOut = result.error?.code === 'ETIMEDOUT';
    return { ok: !result.error && result.status === 0, status: result.status, stdout, stderr, timedOut, error: result.error };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// attempt() that throws: a timeout says how long it waited, a failure carries the tail of the output.
export function runBounded(command, args, { label, timeout = 120_000, ...options } = {}) {
  const name = label ?? `${basename(command)} ${args[0] ?? ''}`.trim();
  const result = attempt(command, args, { timeout, ...options });
  const tail = `${result.stdout}${result.stderr}`.slice(-3000);
  if (result.timedOut) throw Object.assign(new Error(`${name} did not finish within ${Math.round(timeout / 1000)}s${tail ? `\n${tail}` : ''}`), { timedOut: true });
  if (!result.ok) throw new Error(`${name} failed (${result.error?.message ?? `exit ${result.status}`})${tail ? `\n${tail}` : ''}`);
  return result.stdout;
}

// Runs a manifest hook with output streaming to the job log. `args` are appended as quoted positional words
// (the bump level), never spliced into the command text.
export function hook(name, command, { cwd, env, args = [] }) {
  console.log(`::group::hook ${name}`);
  console.log(`$ ${command}${args.length > 0 ? ` ${args.join(' ')}` : ''}`);
  const script = args.length > 0 ? `${command} "$@"` : command;
  const result = spawnSync('bash', ['-eo', 'pipefail', '-c', script, name, ...args], { cwd, env, stdio: 'inherit' });
  console.log('::endgroup::');
  if (result.error || result.status !== 0) throw new Error(`hook ${name} failed (${result.error?.message ?? `exit ${result.status}`})`);
}

// Runs a hook that answers with JSON on its last stdout line (version.read, version.bump). stderr streams to the log.
export function hookOutput(name, command, { cwd, env, args = [] }) {
  const script = args.length > 0 ? `${command} "$@"` : command;
  const result = spawnSync('bash', ['-eo', 'pipefail', '-c', script, name, ...args], { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], maxBuffer: 64 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error(`hook ${name} failed (${result.error?.message ?? `exit ${result.status}`})`);
  return result.stdout ?? '';
}
