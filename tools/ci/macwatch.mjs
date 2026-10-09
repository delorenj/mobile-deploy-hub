#!/usr/bin/env node
// The Mac watchdog (hub v1.1.3), a systemd user timer on big-chungus every 2 minutes (tools/catchup/units). GitHub
// keeps a self-hosted job queued for 24 hours, and a Mac that went away after the gate (a closed lid, a dropped
// hotspot) would hold a deploy's iPad job, and with it announce and the one notification, that long. Each app has a
// single Linux runner, so this cannot be a job of the run: it would hold the runner the plan and deliver need.
//
// For each app in the policy, its deploy runs that are queued or in progress. In each, a Mac job (preflight-ios or
// ios) that has waited for its runner longer than policy mac.queue_limit_min, while that app's own Mac runner is not
// busy on GitHub (offline, or idle and still not taking it), is lost. The run is then cancelled, but only once its APK
// half is done (deliver-android finished, or the run builds no APK): the S26's publish is never cut short. announce
// (if: always()) runs on and reports the iPad skipped, "the Mac went offline after the gate". A lost preflight-ios has
// spent nothing yet (no bump), so its run is cancelled at once.
//
// It reads and cancels through big-chungus's gh login (the job token cannot cancel); it never touches a device or the
// build directory.
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDevices } from './lib/devices.mjs';
import { loadPolicy } from './lib/policy.mjs';

const macJobs = Object.freeze(['preflight-ios', 'ios']);
const jobNamed = (jobs, name) => jobs.find(job => new RegExp(`(^|/ )${name}$`).test(job.name ?? '')) ?? null;
const done = job => job?.status === 'completed';

// What to do with one run: null (nothing), or {job, waited_min, action: 'cancel'|'wait'} for a lost Mac job.
export function judgeRun({ jobs, runner, limitMin, now }) {
  for (const name of macJobs) {
    const job = jobNamed(jobs, name);
    if (!job || job.status !== 'queued') continue;
    const waited = (now - Date.parse(job.created_at)) / 60_000;
    if (!Number.isFinite(waited) || waited < limitMin) continue;
    // A busy runner is working through something else (an earlier deploy's iPad build): it will get there.
    if (runner?.status === 'online' && runner.busy) continue;
    if (name === 'preflight-ios') return { job: name, waited_min: Math.floor(waited), action: 'cancel', why: 'nothing was bumped yet' };
    // ios: wait until the APK half is done, so cancelling never cuts the S26's publish short.
    const android = jobNamed(jobs, 'android');
    const deliverAndroid = jobNamed(jobs, 'deliver-android');
    const apkDone = (done(android) && android.conclusion === 'skipped') || done(deliverAndroid) || (!android && !deliverAndroid && done(jobNamed(jobs, 'plan')));
    return { job: name, waited_min: Math.floor(waited), action: apkDone ? 'cancel' : 'wait', why: apkDone ? 'the APK half is done' : 'waiting for deliver-android first' };
  }
  return null;
}

function realGh(args) {
  const env = { ...process.env };
  delete env.GH_TOKEN;
  delete env.GITHUB_TOKEN;
  const result = spawnSync('gh', args, { encoding: 'utf8', env, timeout: 60_000 });
  if (result.error || result.status !== 0) throw new Error(`gh ${args.slice(0, 2).join(' ')} failed: ${(result.stderr || result.error?.message || '').trim().slice(-200)}`);
  return result.stdout;
}

export async function watch({ policy = loadPolicy().policy, devices = loadDevices(), gh = realGh, now = Date.now(), log = console.log } = {}) {
  const limitMin = policy.mac.queue_limit_min;
  const actions = [];
  for (const repo of Object.keys(policy.apps)) {
    let runs = [];
    try {
      for (const status of ['in_progress', 'queued']) {
        runs.push(...JSON.parse(gh(['api', `repos/${repo}/actions/workflows/deploy.yml/runs?status=${status}&per_page=20`, '--jq', '[.workflow_runs[] | {id, run_attempt}]']) || '[]'));
      }
    } catch (error) {
      log(`HUB_MACWATCH_ERROR ${repo}: ${error.message.split('\n')[0]}`);
      continue;
    }
    if (runs.length === 0) continue;
    const own = devices.mac.runners?.[repo] ?? null;
    let runner = null;
    try {
      runner = own ? JSON.parse(gh(['api', `repos/${repo}/actions/runners`, '--jq', `[.runners[] | select(.name == "${own.name}") | {status, busy}] | first`]) || 'null') : null;
    } catch (error) { log(`HUB_MACWATCH_ERROR ${repo} runners: ${error.message.split('\n')[0]}`); }
    for (const run of runs) {
      let jobs;
      try {
        jobs = JSON.parse(gh(['api', `repos/${repo}/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100`, '--jq', '[.jobs[] | {name, status, conclusion, created_at, runner_name}]']) || '[]');
      } catch (error) {
        log(`HUB_MACWATCH_ERROR ${repo} run ${run.id}: ${error.message.split('\n')[0]}`);
        continue;
      }
      const verdict = judgeRun({ jobs, runner, limitMin, now });
      if (!verdict) continue;
      if (verdict.action === 'wait') {
        log(`HUB_MACWATCH_WAIT ${repo} run ${run.id}: ${verdict.job} has waited ${verdict.waited_min} min for ${own?.name ?? 'its Mac runner'}; ${verdict.why}`);
        continue;
      }
      try {
        gh(['run', 'cancel', String(run.id), '--repo', repo]);
        log(`HUB_MACWATCH_CANCELLED ${repo} run ${run.id}: ${verdict.job} waited ${verdict.waited_min} min and ${own?.name ?? 'its Mac runner'} is ${runner ? `${runner.status}${runner.busy ? ', busy' : ''}` : 'unknown'} (${verdict.why}); announce reports the iPad`);
        actions.push({ repo, run: run.id, ...verdict });
      } catch (error) {
        log(`HUB_MACWATCH_ERROR ${repo} run ${run.id}: could not cancel (${error.message.split('\n')[0]})`);
      }
    }
  }
  return actions;
}

// The unit starts it through ~/.local/share/mobile-deploy-hub/current, a symlink: compare real paths.
const invoked = path => { try { return realpathSync(resolve(path)); } catch { return null; } };
if (process.argv[1] && invoked(process.argv[1]) === invoked(fileURLToPath(import.meta.url))) {
  process.env.HOME ||= homedir();
  watch().catch(error => { console.error(`HUB_MACWATCH_ERROR ${error.message.split('\n')[0]}`); process.exitCode = 1; });
}
