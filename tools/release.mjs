#!/usr/bin/env node
// mise run release -- X.Y.Z (design v1.1, D1): ships a hub release and moves the floating tag the callers pin.
//   1. the work tree is clean and equal to origin/main, `mise run check` passes, and every app conforms;
//   2. the workflow's inner actions/hub@ refs flip to vX.Y.Z in one commit, which is tagged vX.Y.Z and pushed;
//   3. v1 is force-moved to that tag (GitHub Free has no tag protection);
//   4. one strict dry run with --dry-handoff true per app, in Jarad's order (Tower, Green In Between, Gruvato): this is
//      the iPad proof the old front-door ledger kept, now once per hub version and from any machine;
//   5. red: v1 moves back to where it was (or goes away if it was new) and the release says so. Green: the run ids go
//      into the annotation of vX.Y.Z.
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deploy, finishByHand, parseArguments, realGh, realGit, unknownStatus } from './deploy.mjs';
import { conformance } from './conformance.mjs';
import { loadPolicy } from './ci/lib/policy.mjs';

const hubRoot = fileURLToPath(new URL('..', import.meta.url));
const workflowPath = resolve(hubRoot, '.github/workflows/mobile-deploy.yml');
const coAuthor = 'Co-Authored-By: Claude Code <noreply@anthropic.com>';

function git(args, { allowFail = false } = {}) {
  const result = spawnSync('git', args, { cwd: hubRoot, encoding: 'utf8' });
  if (!allowFail && (result.error || result.status !== 0)) throw new Error(`git ${args.slice(0, 3).join(' ')} failed: ${(result.stderr || result.error?.message || '').trim().slice(-400)}`);
  return { ok: result.status === 0, out: (result.stdout ?? '').trim() };
}

export function flipInnerRefs(text, tag) {
  return text.replace(/(uses: delorenj\/mobile-deploy-hub\/actions\/hub@)\S+/g, `$1${tag}`);
}

export function remoteTag(name) {
  const line = git(['ls-remote', '--tags', 'origin', `refs/tags/${name}`, `refs/tags/${name}^{}`], { allowFail: true }).out;
  let object = null;
  let commit = null;
  for (const entry of line.split('\n').filter(Boolean)) {
    const [sha, ref] = entry.split(/\s+/);
    if (ref === `refs/tags/${name}`) object = sha;
    if (ref === `refs/tags/${name}^{}`) commit = sha;
  }
  return object ? { object, commit: commit ?? object } : null;
}

export async function release(version, { log = console.log, dryRuns = true } = {}) {
  if (!/^\d+\.\d+\.\d+$/.test(version ?? '')) throw new Error('usage: mise run release -- X.Y.Z');
  const tag = `v${version}`;
  const major = `v${version.split('.')[0]}`;
  if (git(['status', '--porcelain']).out !== '') throw new Error('the hub work tree is not clean; commit or stash first');
  if (git(['rev-parse', '--abbrev-ref', 'HEAD']).out !== 'main') throw new Error('release from main');
  git(['fetch', '-q', 'origin', 'main', '--tags']);
  if (git(['rev-parse', 'HEAD']).out !== git(['rev-parse', 'origin/main']).out) throw new Error('main is not origin/main; pull or push first');
  if (remoteTag(tag)) throw new Error(`${tag} already exists on origin; a release is never reused`);

  log('RELEASE_CHECK mise run check');
  const check = spawnSync('mise', ['run', 'check'], { cwd: hubRoot, stdio: 'inherit' });
  if (check.status !== 0) throw new Error('mise run check is red');
  log('RELEASE_CHECK mise run conformance');
  const problems = conformance({ policy: loadPolicy().policy, log });
  if (problems.length > 0) throw new Error(`${problems.length} conformance problems`);

  const text = readFileSync(workflowPath, 'utf8');
  const flipped = flipInnerRefs(text, tag);
  if (flipped !== text) {
    writeFileSync(workflowPath, flipped);
    git(['commit', '-q', '-m', `feat(hub): ${tag}: the workflow's inner actions/hub refs pin ${tag}`, '-m', coAuthor, '--', '.github/workflows/mobile-deploy.yml']);
  }
  const commit = git(['rev-parse', 'HEAD']).out;
  git(['tag', '-a', tag, '-m', `mobile-deploy-hub ${tag}\n\nRelease dry runs pending.`]);
  git(['push', '-q', '--atomic', 'origin', 'HEAD:refs/heads/main', `refs/tags/${tag}`]);
  log(`RELEASE_TAGGED ${tag} at ${commit.slice(0, 8)}`);

  const previous = remoteTag(major);
  git(['tag', '-f', major, commit]);
  git(['push', '-q', '-f', 'origin', `refs/tags/${major}`]);
  log(`RELEASE_MOVED ${major} -> ${tag}${previous ? ` (was ${previous.commit.slice(0, 8)})` : ' (new)'}`);
  if (!dryRuns) return { tag, commit, runs: [] };

  const runs = [];
  let red = null;
  let unknown = null;
  for (const repo of Object.keys(loadPolicy().policy.apps)) {
    log(`RELEASE_DRY_RUN ${repo} at ${major} (${tag})`);
    try {
      const result = await deploy({ ...parseArguments(['--dry-run', 'true', '--dry-handoff', 'true', '--repo', repo, '--hub-ref', major]) }, { gh: realGh, git: realGit, log });
      runs.push({ repo, id: result.run?.databaseId ?? null, url: result.run?.url ?? null, status: result.status });
      if (result.status === unknownStatus) { unknown = { repo, id: result.run?.databaseId, url: result.run?.url }; break; }
      if (result.status !== 0) { red = repo; break; }
    } catch (error) {
      runs.push({ repo, id: null, url: null, status: 1, error: error.message.split('\n')[0] });
      red = repo;
      break;
    }
  }
  const lines = runs.map(item => `${item.repo}: ${item.status === 0 ? 'green' : item.status === unknownStatus ? 'UNKNOWN' : 'RED'} ${item.id ?? ''} ${item.url ?? item.error ?? ''}`.trim());
  if (unknown) {
    // No verdict is not red: v1 stays where it is, the release stays unproven, and a person finishes the watch.
    git(['tag', '-f', '-a', tag, commit, '-m', `mobile-deploy-hub ${tag}\n\nRelease dry runs: UNKNOWN at ${unknown.repo} (GitHub gave no verdict); ${major} was moved and not rolled back.\n${lines.join('\n')}`]);
    git(['push', '-q', '-f', 'origin', `refs/tags/${tag}`]);
    throw new Error(`the release dry run of ${unknown.repo} has no verdict (${unknown.url ?? 'no run'}); ${major} stays on ${tag}, unproven, not rolled back. Finish by hand: ${finishByHand(unknown.id, ['--repo', unknown.repo])}`);
  }
  if (red) {
    if (previous) {
      git(['tag', '-f', major, previous.commit]);
      git(['push', '-q', '-f', 'origin', `refs/tags/${major}`]);
      log(`RELEASE_ROLLED_BACK ${major} -> ${previous.commit.slice(0, 8)}: the dry run of ${red} is red`);
    } else {
      git(['push', '-q', 'origin', `:refs/tags/${major}`], { allowFail: true });
      git(['tag', '-d', major], { allowFail: true });
      log(`RELEASE_ROLLED_BACK ${major} removed (it was new): the dry run of ${red} is red`);
    }
    git(['tag', '-f', '-a', tag, commit, '-m', `mobile-deploy-hub ${tag}\n\nRelease dry runs: RED at ${red}; ${major} not moved.\n${lines.join('\n')}`]);
    git(['push', '-q', '-f', 'origin', `refs/tags/${tag}`]);
    throw new Error(`the release dry run of ${red} is red; ${major} is back where it was. Fix it and release the next patch`);
  }
  git(['tag', '-f', '-a', tag, commit, '-m', `mobile-deploy-hub ${tag}\n\nRelease dry runs (strict, --dry-handoff true, at ${major}), all green:\n${lines.join('\n')}`]);
  git(['push', '-q', '-f', 'origin', `refs/tags/${tag}`]);
  log(`RELEASE_DONE ${tag}: ${major} points at it; ${lines.join('; ')}`);
  return { tag, commit, runs };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [version, ...rest] = process.argv.slice(2);
  release(version?.replace(/^v/, ''), { dryRuns: !rest.includes('--no-dry-runs') }).catch(error => { console.error(`::error::${error.message}`); process.exitCode = 1; });
}
