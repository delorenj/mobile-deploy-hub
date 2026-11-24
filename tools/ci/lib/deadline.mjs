// The wait deadline of a deploy job (AD-12, FR-8): a job that waits in the Queue must stop waiting while it can still say why.
// GitHub kills a job at its `timeout-minutes` and the job ends `cancelled`: no `finally`, no deliver-*, no reason. So the wait ends
//
//   deadline = job_start + job_timeout - margin - hold_allowance[job]
//
// where the allowance covers every hold the job still has to take (ios takes `mac-ios` up to twice). `job_timeout` reaches the
// tools as HUB_JOB_TIMEOUT_MINUTES, set beside each job's `timeout-minutes` in mobile-deploy.yml (a test keeps the two equal);
// the margin and the allowances are the policy's `queue` block (AD-11). `job_start` is the start of the nearest `Runner.Worker`
// ancestor (the process GitHub starts its own clock for), else this process's own start.
//
// Pure apart from the default process lookup: every input is injectable, and nothing here writes a protocol path.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

export const RUNNER_WORKER = 'Runner.Worker';
const MAX_HOPS = 64;

// One process as { ppid, comm, started_ms }, or null when it is gone or unreadable. Linux reads /proc (start = boot time plus
// the stat start ticks); the Mac reads `ps` (start = lstart, second resolution, parsed as UTC).
export function systemProcess(pid, { platform = process.platform, readText = path => readFileSync(path, 'utf8'), ps = args => spawnSync('ps', args, { encoding: 'utf8', timeout: 5000, env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' } }) } = {}) {
  try {
    const stat = readText(`/proc/${pid}/stat`);
    const open = stat.indexOf('(');
    const close = stat.lastIndexOf(')');
    const fields = stat.slice(close + 2).trim().split(/\s+/);
    const btime = /^btime (\d+)$/m.exec(readText('/proc/stat'))?.[1];
    const ticks = Number(fields[19]);
    const started = btime && Number.isFinite(ticks) ? Number(btime) * 1000 + Math.round((ticks / 100) * 1000) : null;
    return { ppid: Number(fields[1]), comm: stat.slice(open + 1, close), started_ms: started };
  } catch { /* no /proc, or no such process */ }
  if (platform === 'linux') return null;
  const out = ps(['-o', 'ppid=', '-o', 'lstart=', '-o', 'comm=', '-p', String(pid)]);
  if (out.status !== 0) return null;
  const match = /^\s*(\d+)\s+(\w{3} \w{3}\s+\d+ \d{2}:\d{2}:\d{2} \d{4})\s+(.+?)\s*$/.exec(out.stdout.trim());
  if (!match) return null;
  const started = Date.parse(`${match[2]} UTC`);
  return { ppid: Number(match[1]), comm: basename(match[3]), started_ms: Number.isFinite(started) ? started : null };
}

// job_start in ms: the start of the nearest Runner.Worker ancestor, else this process's own start, else `fallback` (now minus
// the process's uptime when the system cannot say). `lookup(pid)` is the seam; the walk is bounded so a cycle never spins.
export function jobStart({ pid = process.pid, lookup = systemProcess, now = Date.now, uptime = () => process.uptime() } = {}) {
  let at = pid;
  for (let hop = 0; hop < MAX_HOPS && Number.isSafeInteger(at) && at > 1; hop += 1) {
    const found = lookup(at);
    if (!found) break;
    if (found.comm === RUNNER_WORKER && Number.isFinite(found.started_ms)) return found.started_ms;
    at = found.ppid;
  }
  const own = lookup(pid);
  if (Number.isFinite(own?.started_ms)) return own.started_ms;
  return now() - Math.round(uptime() * 1000);
}

// HUB_JOB_TIMEOUT_MINUTES as ms, or null when it is absent or not a positive whole number of minutes (a malformed value never
// shortens a wait: the wait keeps its own timeout).
export function jobTimeoutMs(env = process.env) {
  const text = env.HUB_JOB_TIMEOUT_MINUTES;
  if (typeof text !== 'string' || !/^[1-9]\d{0,5}$/.test(text.trim())) return null;
  return Number(text.trim()) * 60_000;
}

// The job's wait deadline as { at, job_start, timeout_ms, margin_ms, allowance_ms } (all ms), or null when this job has no
// deadline: no HUB_JOB_TIMEOUT_MINUTES, or a job the policy gives no allowance (deliver-*, a person at a shell). `policy` is the
// parsed policy (or just its `queue` block); callers never pass the values themselves (AD-11).
export function jobDeadline({ env = process.env, policy, start = jobStart, startedMs = null, ...seams } = {}) {
  const queue = policy?.queue ?? policy;
  const timeout = jobTimeoutMs(env);
  const job = env.GITHUB_JOB;
  const allowance = job && queue?.hold_allowance_min && Object.hasOwn(queue.hold_allowance_min, job) ? queue.hold_allowance_min[job] : null;
  if (timeout === null || allowance === null || !Number.isFinite(queue?.wait_margin_min)) return null;
  const job_start = Number.isFinite(startedMs) ? startedMs : start(seams);
  const margin_ms = queue.wait_margin_min * 60_000;
  const allowance_ms = allowance * 60_000;
  return { at: job_start + timeout - margin_ms - allowance_ms, job_start, timeout_ms: timeout, margin_ms, allowance_ms };
}
