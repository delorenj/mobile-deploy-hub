// Read-only Actions history diagnostic for a rerun of an iOS TestFlight dry run.
// It proves the token and runner context can see the same run's earlier jobs
// without invoking the app's upload hook (which dry runs deliberately skip).
import { spawnSync } from 'node:child_process';

export function readHistory({ env = process.env, request = path => {
  const result = spawnSync('gh', ['api', path], { env: { PATH: env.PATH, GH_TOKEN: env.GH_TOKEN, GH_HOST: 'github.com' }, encoding: 'utf8', timeout: 30_000 });
  // Do not copy provider error text: it can contain request details or credentials.
  if (result.error || result.status !== 0) throw new Error('Actions history read denied or unavailable');
  try { return JSON.parse(result.stdout); } catch { throw new Error('Actions history response is not JSON'); }
} } = {}) {
  const repository = env.GITHUB_REPOSITORY;
  const runId = env.GITHUB_RUN_ID;
  const attempt = Number(env.GITHUB_RUN_ATTEMPT);
  if (!env.GH_TOKEN) throw new Error('Actions history requires the ephemeral job token');
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository ?? '') || !/^[1-9]\d*$/.test(runId ?? '') || !Number.isSafeInteger(attempt) || attempt < 2 || attempt > 1000 || String(attempt) !== env.GITHUB_RUN_ATTEMPT) throw new Error('Actions history run identity is invalid');
  const base = `/repos/${repository}/actions/runs/${runId}`;
  const run = request(base);
  if (String(run?.id) !== runId || run?.repository?.full_name !== repository || run.run_attempt !== attempt) throw new Error('Actions history run identity is ambiguous');
  const prior = [];
  for (let number = 1; number < attempt; number++) {
    const seen = new Set();
    let total;
    let ios = null;
    for (let page = 1; page <= 1000; page++) {
      const listing = request(`${base}/attempts/${number}/jobs?per_page=100&page=${page}`);
      if (!Number.isSafeInteger(listing?.total_count) || listing.total_count < 1 || !Array.isArray(listing.jobs) || !listing.jobs.length || listing.jobs.length > 100 || (total !== undefined && total !== listing.total_count)) throw new Error('Actions history job listing is incomplete');
      total = listing.total_count;
      for (const job of listing.jobs) {
        if (!Number.isSafeInteger(job?.id) || seen.has(job.id) || job.run_attempt !== number || String(job.run_id) !== runId || typeof job.name !== 'string' || job.status !== 'completed' || typeof job.conclusion !== 'string' || !Array.isArray(job.steps)) throw new Error('Actions history job identity or steps are ambiguous');
        seen.add(job.id);
        if (job.name === 'deploy / ios') {
          if (ios) throw new Error('Actions history has duplicate iOS jobs');
          if (job.conclusion !== 'skipped' && (!job.runner_name || !job.steps.some(step => step.name === 'Build, check, outbox, install on the iPad (or pending)' && step.status === 'completed'))) throw new Error('Actions history iOS execution steps are incomplete');
          if (job.conclusion === 'skipped' && (job.steps.length || job.runner_name !== null)) throw new Error('Actions history skipped iOS job is contradictory');
          ios = { attempt: number, job_id: job.id, conclusion: job.conclusion, runner: job.runner_name, step_count: job.steps.length };
        }
      }
      if (seen.size === total) break;
      if (seen.size > total || listing.jobs.length < 100 || page === 1000) throw new Error('Actions history job listing is incomplete');
    }
    if (!ios || seen.size !== total) throw new Error('Actions history has no complete iOS job');
    prior.push(ios);
  }
  return { repository, run_id: runId, run_attempt: attempt, prior };
}

if (process.argv[1] && process.argv[1].endsWith('/history-probe.mjs')) {
  try {
    const result = readHistory();
    console.log(`HUB_IOS_HISTORY_READ ${JSON.stringify(result)}`);
  } catch (error) {
    console.error(`HUB_IOS_HISTORY_REFUSED ${error.message}`);
    process.exitCode = 1;
  }
}
