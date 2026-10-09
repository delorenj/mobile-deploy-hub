// Helpers every hub command shares: the policy banner, failure receipts, receipts on disk, big-chungus staging, the
// code the catch-up units run, the iPad's reachability and the Mac's disk and secret checks.
import { closeSync, cpSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { freeGiB } from '../lib/apple.mjs';
import { createGit } from '../lib/git.mjs';
import { loadPolicy } from '../lib/policy.mjs';
import { buildReceipt, writeReceipt } from '../lib/receipt.mjs';

export const semver = /^\d+\.\d+\.\d+$/;
export const releaseRef = /^v\d+\.\d+\.\d+$/;
export const short = sha => (sha ?? '').slice(0, 8);
export const firstLine = message => String(message ?? '').split('\n').find(line => line.trim()) ?? 'failed';
export const isoNow = (date = new Date()) => date.toISOString().replace(/\.\d{3}Z$/, 'Z');
export const exists = path => { try { const info = statSync(path); return info.isFile() && info.size > 0; } catch { return false; } };

// Every job logs the policy it obeys.
export function policyBanner(log = console.log) {
  const loaded = loadPolicy();
  log(`HUB_POLICY sha256=${loaded.short}`);
  return loaded;
}

// A lane writes its receipt on failure too: the stage it reached and a one-line reason, for announce.
export async function guarded(lane, dir, config, env, fn) {
  const track = { stage: 'preflight', receipt: {} };
  try {
    return await fn(track);
  } catch (error) {
    try {
      await writeReceipt(dir, buildReceipt({ lane, config, env, ...track.receipt, outcome: 'failure', stage: track.stage, reason: firstLine(error.message).replace(/^::error::/, '').slice(0, 500) }), env);
    } catch { /* the lane's own error is the one to report */ }
    throw error;
  }
}

export function readReceipts(dir) {
  const found = {};
  const walk = folder => {
    let entries = [];
    try { entries = readdirSync(folder, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const path = join(folder, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/^hub-receipt-[\w-]+\.json$/.test(entry.name)) {
        try { const receipt = JSON.parse(readFileSync(path, 'utf8')); if (receipt?.lane) found[receipt.lane] = receipt; } catch { /* a torn receipt adds no detail */ }
      }
    }
  };
  walk(dir);
  return found;
}

export function parseNeeds(text) {
  if (!text) return {};
  try { const needs = JSON.parse(text); return needs && typeof needs === 'object' ? needs : {}; } catch { throw new Error('HUB_NEEDS is not JSON (the workflow passes toJSON(needs))'); }
}

export function runOf(env) {
  return {
    repo: env.GITHUB_REPOSITORY ?? 'local/local',
    id: String(env.GITHUB_RUN_ID ?? '0'),
    attempt: Number(env.GITHUB_RUN_ATTEMPT ?? 1),
    url: env.GITHUB_RUN_ID ? `${env.GITHUB_SERVER_URL ?? 'https://github.com'}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}` : null,
  };
}

// big-chungus staging (B5): ~/.cache/mobile-deploy-hub/staging/<owner>-<repo>/<run>/. The three apps' Linux runners all
// run as delorenj here, so they share it; deliver reads it; runs older than 7 days are pruned.
export function stagingRoot(devices, home = homedir()) { return join(home, devices.linux.staging_dir); }
export function stagingDir(env, devices, home = homedir()) {
  const [owner, repo] = (env.GITHUB_REPOSITORY ?? '').split('/');
  const run = env.GITHUB_RUN_ID ?? '';
  if (!/^[A-Za-z0-9._-]+$/.test(owner ?? '') || !/^[A-Za-z0-9._-]+$/.test(repo ?? '') || !/^\d+$/.test(run)) throw new Error('staging needs GITHUB_REPOSITORY and GITHUB_RUN_ID');
  return join(stagingRoot(devices, home), `${owner}-${repo}`, run);
}

export function pruneStaging(devices, { home = homedir(), days = 7, now = Date.now() } = {}) {
  const root = stagingRoot(devices, home);
  const removed = [];
  let repos = [];
  try { repos = readdirSync(root, { withFileTypes: true }).filter(entry => entry.isDirectory()); } catch { return removed; }
  for (const repo of repos) {
    for (const run of readdirSync(join(root, repo.name), { withFileTypes: true }).filter(entry => entry.isDirectory())) {
      const path = join(root, repo.name, run.name);
      if (now - statSync(path).mtimeMs > days * 86_400_000) { rmSync(path, { recursive: true, force: true }); removed.push(`${repo.name}/${run.name}`); }
    }
  }
  return removed;
}

// The code the catch-up units run (E1): ~/.local/share/mobile-deploy-hub/current -> releases/<hub ref>, refreshed by
// each real run from the action's own tools/ (a local copy, no network). Only released hub code goes there.
export function installCurrent({ hubRef, home = homedir(), source = fileURLToPath(new URL('../..', import.meta.url)), log = console.log }) {
  if (!releaseRef.test(hubRef ?? '')) { log(`HUB_CURRENT skipped: hub ref ${hubRef || '(none)'} is not a release tag`); return null; }
  const root = join(home, '.local/share/mobile-deploy-hub');
  const release = join(root, 'releases', hubRef);
  mkdirSync(release, { recursive: true });
  cpSync(source, join(release, 'tools'), { recursive: true, force: true, filter: path => !/\/(node_modules|\.git)(\/|$)/.test(path) });
  const link = join(root, 'current');
  const temp = `${link}.${process.pid}`;
  rmSync(temp, { force: true });
  symlinkSync(join('releases', hubRef), temp);
  renameSync(temp, link);
  log(`HUB_CURRENT ${link} -> releases/${hubRef}`);
  return release;
}

// The app's own receipt names the version it built; it must be the version the plan announced.
export async function checkAppReceipt(path, config, label) {
  const receipt = JSON.parse(await readFile(path, 'utf8'));
  if (config.version && receipt.version && receipt.version !== config.version) throw new Error(`${label} says version ${receipt.version} but the plan says ${config.version}`);
  if (config.androidCode && receipt.version_code !== undefined && String(receipt.version_code) !== config.androidCode) throw new Error(`${label} says versionCode ${receipt.version_code} but the plan says ${config.androidCode}`);
  return receipt;
}

// A dry run builds the next version without committing it: the plan's bump, applied to this job's checkout.
export function applyBump(config, env) {
  if (!config.dryRun || !config.bumpPatch) return false;
  createGit({ cwd: config.cwd, env }).apply(Buffer.from(config.bumpPatch, 'base64'));
  console.log('HUB_BUMP_APPLIED the plan\'s version bump, to this checkout only (dry run)');
  return true;
}

export function requirePlan(config) {
  if (!semver.test(config.version)) throw new Error('this lane needs the plan\'s version (HUB_VERSION)');
}

export function checkDisk(path, devices) {
  const free = freeGiB(path);
  if (free < devices.mac.min_free_gib) throw new Error(`the Mac has ${free.toFixed(1)} GiB free; an iOS build needs ${devices.mac.min_free_gib} GiB. Free space (old Xcode archives, DerivedData) and run again`);
  return free;
}

// The iPad, waited for up to waitMs: listed by devicectl and not "unavailable". A listed iPad that is unpaired, of the
// wrong model or without Developer Mode is a real failure; an absent or unavailable one is pending (the catch-up
// installs it later).
export async function reachIpad(ipad, { waitMs = 60_000, pollMs = 5000, sleep = ms => new Promise(done => setTimeout(done, ms)), now = Date.now } = {}) {
  const deadline = now() + waitMs;
  let why = 'not listed';
  for (;;) {
    try {
      const found = ipad.find();
      if (found.tunnel !== 'unavailable') return { reachable: true, found };
      why = `listed but unavailable (tunnel ${found.tunnel}, transport ${found.transport ?? 'none'})`;
    } catch (error) {
      if (!/not listed by devicectl/.test(error.message)) throw error;
      why = 'not listed by devicectl on this Mac';
    }
    if (now() >= deadline) return { reachable: false, reason: `the iPad is ${why}` };
    await sleep(pollMs);
  }
}

// Reads one 1Password reference and discards the value. stderr goes to a file, not a pipe: `op read` leaves an `op
// daemon` behind that keeps a pipe open, and spawnSync would wait on it even after the timeout killed `op read`.
function readSecretRef(ref, { env, timeout }) {
  const dir = mkdtempSync(join(tmpdir(), 'hub-op-'));
  const file = join(dir, 'stderr');
  const fd = openSync(file, 'w');
  try {
    const read = spawnSync('op', ['read', '--no-newline', ref], { env, stdio: ['ignore', 'ignore', fd], timeout, killSignal: 'SIGKILL' });
    closeSync(fd);
    const stderr = readFileSync(file, 'utf8');
    if (read.error?.code === 'ETIMEDOUT') return { ok: false, timedOut: true, stderr };
    return { ok: !read.error && read.status === 0, timedOut: false, stderr: stderr || read.error?.message || '' };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

// Each reference must resolve; values are discarded unread and only reference names are printed. A strict run fails
// when 1Password does not answer; only strict=false (refused by the gate since v1.1) warns.
export function checkSecrets(refs, { config, env, notes }) {
  const opTimeout = Number(env.HUB_OP_TIMEOUT_MS) > 0 ? Number(env.HUB_OP_TIMEOUT_MS) : 45_000;
  let verified = 0;
  for (const ref of refs) {
    const read = readSecretRef(ref, { env, timeout: opTimeout });
    if (read.timedOut) {
      const why = `op did not answer within ${opTimeout / 1000}s reading ${ref}: 1Password is waiting for a person on the Mac (screen locked, or the app wants approval). Unlock the Mac, approve 1Password and run again.`;
      if (!config.dryRun || config.strict) throw new Error(why);
      console.log(`::warning::${why}`);
      notes.push(`UNVERIFIED: ${refs.length - verified} secret references were not checked (${why})`);
      return false;
    }
    if (!read.ok) throw new Error(`op could not read ${ref}: ${read.stderr.trim().slice(0, 300)}`);
    verified += 1;
  }
  if (refs.length > 0) notes.push(`${refs.length} secret references resolve (values not read into the log)`);
  return true;
}

export const pathFree = value => (typeof value === 'string' ? value.replace(/(?<![\w.])\/(?:home|Users|root|tmp|var|etc|opt|srv|mnt|private)\/[^\s)\]'",;]*/g, '<path>') : value);
// Receipts as the build directory publishes them: no credentials (receipts never hold any) and no workstation paths.
export function publicCopy(value) {
  if (Array.isArray(value)) return value.map(publicCopy);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, publicCopy(item)]));
  return pathFree(value);
}

export { existsSync };
