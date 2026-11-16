// Transport proof only: authenticated, complete same-run job/step reads. This
// never decides whether an earlier job ran an upload or a new upload is safe.
import { spawnSync } from 'node:child_process';

export function readHistory({ env = process.env, request = path => {
  const result = spawnSync('gh', ['api', path], { env: { PATH: env.PATH, GH_TOKEN: env.GH_TOKEN, GH_HOST: 'github.com' }, encoding: 'utf8', timeout: 30_000, maxBuffer: 16 * 1024 * 1024 });
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
  const seen = new Set();
  for (let number = 1; number < attempt; number++) {
    const jobs = [];
    let total;
    for (let page = 1; page <= 1000; page++) {
      const listing = request(`${base}/attempts/${number}/jobs?per_page=100&page=${page}`);
      if (!Number.isSafeInteger(listing?.total_count) || listing.total_count < 0 || !Array.isArray(listing.jobs) || (!listing.jobs.length && listing.total_count !== 0) || listing.jobs.length > 100 || (total !== undefined && total !== listing.total_count)) throw new Error('Actions history job listing is incomplete');
      total = listing.total_count;
      for (const listed of listing.jobs) {
        const validJob = job => Number.isSafeInteger(job?.id) && job.id > 0 && job.run_attempt === number && String(job.run_id) === runId && typeof job.name === 'string' && typeof job.status === 'string' && (job.conclusion === null || typeof job.conclusion === 'string');
        if (!validJob(listed) || seen.has(listed.id)) throw new Error('Actions history job identity is ambiguous');
        seen.add(listed.id);
        // GitHub permits jobs-list responses to omit steps. Read that job's
        // detail rather than treating an omitted property as an empty history.
        const job = Object.hasOwn(listed, 'steps') ? listed : request(`/repos/${repository}/actions/jobs/${listed.id}`);
        if (!validJob(job) || job.id !== listed.id || job.name !== listed.name || !Array.isArray(job.steps)) throw new Error('Actions history job steps are incomplete');
        const numbers = new Set();
        for (const step of job.steps) {
          if (!Number.isSafeInteger(step?.number) || step.number < 1 || numbers.has(step.number) || typeof step.name !== 'string' || typeof step.status !== 'string' || !(step.conclusion === null || typeof step.conclusion === 'string')) throw new Error('Actions history step listing is incomplete');
          numbers.add(step.number);
        }
        jobs.push({ job_id: job.id, name: job.name, status: job.status, conclusion: job.conclusion, steps: job.steps.map(({ number, name, status, conclusion }) => ({ number, name, status, conclusion })) });
      }
      if (jobs.length === total) break;
      if (jobs.length > total || listing.jobs.length < 100 || page === 1000) throw new Error('Actions history job listing is incomplete');
    }
    if (jobs.length !== total) throw new Error('Actions history job listing is incomplete');
    prior.push({ attempt: number, jobs });
  }
  return { proof: 'transport-only', repository, run_id: runId, run_attempt: attempt, prior };
}

if (process.argv[1] && process.argv[1].endsWith('/history-probe.mjs')) {
  try {
    const result = readHistory();
    console.log(`HUB_IOS_HISTORY_TRANSPORT_READ ${JSON.stringify(result)}`);
  } catch (error) {
    console.error(`HUB_IOS_HISTORY_TRANSPORT_REFUSED ${error.message}`);
    process.exitCode = 1;
  }
}
