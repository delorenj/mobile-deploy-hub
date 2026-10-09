// Host locks. Three apps share one S26, one iPad and one Mac, and each app has its own runners, so per-repo
// concurrency groups cannot stop two deploys from talking to the same device at once. A lock is a directory
// (mkdir is atomic on both hosts) holding the owner's pid, run and start time. A holder that died without
// releasing (a job killed at its timeout) is reclaimed when its pid is gone; waiting has a deadline.
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { join } from 'node:path';

export const lockDir = (env = process.env, home = homedir()) => env.HUB_LOCK_DIR || join(home, '.cache/mobile-deploy-hub/locks');

const alive = pid => {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
};

function readOwner(path) {
  try { return JSON.parse(readFileSync(join(path, 'owner.json'), 'utf8')); } catch { return null; }
}

const describe = owner => owner ? `${owner.repo ?? 'a local run'} run ${owner.run ?? '-'} (pid ${owner.pid}, since ${owner.started_at})` : 'an unknown holder';

function stale(path, owner, { now, staleMs }) {
  let age = 0;
  try { age = now() - statSync(path).mtimeMs; } catch { return true; }
  // owner.json is written right after mkdir; a lock without one for a minute was abandoned mid-creation.
  if (!owner) return age > 60_000;
  if (owner.host === hostname() && Number.isSafeInteger(owner.pid) && !alive(owner.pid)) return true;
  return age > staleMs;
}

export async function withLock(name, fn, {
  env = process.env,
  timeoutMs = 15 * 60_000,
  pollMs = 2000,
  staleMs = 4 * 3600_000,
  log = console.log,
  sleep = ms => new Promise(done => setTimeout(done, ms)),
  now = Date.now,
} = {}) {
  if (!/^[a-z0-9-]+$/.test(name)) throw new Error(`bad lock name "${name}"`);
  const dir = lockDir(env);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${name}.lock`);
  const me = { pid: process.pid, host: hostname(), repo: env.GITHUB_REPOSITORY ?? null, run: env.GITHUB_RUN_ID ?? null, started_at: new Date(now()).toISOString() };
  const deadline = now() + timeoutMs;
  let waiting = false;
  for (;;) {
    try {
      mkdirSync(path);
      writeFileSync(join(path, 'owner.json'), JSON.stringify(me));
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    const owner = readOwner(path);
    if (stale(path, owner, { now, staleMs })) {
      rmSync(path, { recursive: true, force: true });
      log(`HUB_LOCK_RECLAIMED ${name} from ${describe(owner)}`);
      continue;
    }
    if (now() >= deadline) throw new Error(`host lock ${name} is held by ${describe(owner)}; gave up after ${Math.round(timeoutMs / 60_000)} min. Another deploy is using the device; run again when it finishes.`);
    if (!waiting) { log(`HUB_LOCK_WAIT ${name} held by ${describe(owner)}`); waiting = true; }
    await sleep(pollMs);
  }
  log(`HUB_LOCK ${name}`);
  try {
    return await fn();
  } finally {
    if (readOwner(path)?.pid === me.pid) rmSync(path, { recursive: true, force: true });
  }
}
