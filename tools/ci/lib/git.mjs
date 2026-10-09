// Git for the v3 bump: the plan job commits the version files, tags vX.Y.Z and pushes both to main in one atomic
// push. The token reaches git through GIT_CONFIG_* environment variables, never argv or .git/config, and no hook
// sees it. The machine's own git hooks (the global pre-commit and pre-push guards) run as they would for a person:
// nothing here sets GIT_GUARD_OFF or skips verification, which is why the plan job checks out full history.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { credentialVariables } from './config.mjs';
import { attempt, runBounded } from './exec.mjs';
import { checkBump, sameFiles } from './version.mjs';

export const botIdentity = Object.freeze({
  GIT_AUTHOR_NAME: 'github-actions[bot]',
  GIT_AUTHOR_EMAIL: '41898282+github-actions[bot]@users.noreply.github.com',
  GIT_COMMITTER_NAME: 'github-actions[bot]',
  GIT_COMMITTER_EMAIL: '41898282+github-actions[bot]@users.noreply.github.com',
});

// The same header actions/checkout persists, but only in the environment of the git processes that need it.
export function authEnvironment(env, token, server = env.GITHUB_SERVER_URL || 'https://github.com') {
  const base = { ...env, GIT_TERMINAL_PROMPT: '0' };
  if (!token) return base;
  const index = Number.parseInt(env.GIT_CONFIG_COUNT ?? '0', 10) || 0;
  return {
    ...base,
    GIT_CONFIG_COUNT: String(index + 1),
    [`GIT_CONFIG_KEY_${index}`]: `http.${server.replace(/\/+$/, '')}/.extraheader`,
    [`GIT_CONFIG_VALUE_${index}`]: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`,
  };
}

// `git status --porcelain=v1 -z`: "XY path", and a rename or copy carries its old path as the next field.
export function parseStatus(output) {
  const fields = output.split('\0').filter(Boolean);
  const paths = [];
  for (let index = 0; index < fields.length; index += 1) {
    const entry = fields[index];
    paths.push(entry.slice(3));
    if (/[RC]/.test(entry.slice(0, 2))) { index += 1; paths.push(fields[index]); }
  }
  return [...new Set(paths)].sort();
}

// `git ls-remote` lines for one tag: the tag object and, for an annotated tag, the commit it peels to.
export function parseRemoteTag(output, tag) {
  let object = null;
  let commit = null;
  for (const line of output.split('\n')) {
    const [sha, ref] = line.trim().split(/\s+/);
    if (ref === `refs/tags/${tag}`) object = sha;
    if (ref === `refs/tags/${tag}^{}`) commit = sha;
  }
  return object ? { object, commit: commit ?? object } : null;
}

export function createGit({ cwd, env = process.env, token } = {}) {
  // The token lives only in the extraheader variables; the git hooks never see GH_TOKEN or the runner's tokens.
  const quiet = { ...env };
  for (const name of credentialVariables) delete quiet[name];
  const gitEnv = { ...authEnvironment(quiet, token), ...botIdentity };
  const git = (args, timeout = 120_000) => runBounded('git', args, { cwd, env: gitEnv, timeout, label: `git ${args[0]}` });
  return {
    head: () => git(['rev-parse', 'HEAD']).trim(),
    shallow: () => git(['rev-parse', '--is-shallow-repository']).trim() !== 'false',
    changed: () => parseStatus(git(['status', '--porcelain=v1', '-z', '--untracked-files=all'])),
    fetchMain: () => { git(['fetch', '--no-tags', 'origin', '+refs/heads/main:refs/remotes/origin/main'], 300_000); return git(['rev-parse', 'refs/remotes/origin/main']).trim(); },
    checkout: sha => git(['checkout', '--quiet', '--force', '--detach', sha]),
    // Drops what an earlier bump round left in the working tree (only the hub's own hook ran here).
    discard: () => { git(['reset', '--quiet', '--hard']); git(['clean', '-fdq']); },
    remoteMain: () => git(['ls-remote', '--heads', 'origin', 'refs/heads/main']).trim().split(/\s+/)[0] || null,
    remoteTag: tag => parseRemoteTag(git(['ls-remote', '--tags', 'origin', `refs/tags/${tag}`, `refs/tags/${tag}^{}`]), tag),
    add: files => git(['add', '--', ...files]),
    diffCached: () => git(['diff', '--cached', '--binary', '--full-index']),
    commit: message => git(['commit', '--quiet', '-m', message], 300_000),
    tag: (name, message) => git(['tag', '-a', name, '-m', message]),
    deleteTag: name => attempt('git', ['tag', '-d', name], { cwd, env: gitEnv }),
    push: (tag, { dryRun = false } = {}) => attempt('git', ['push', ...(dryRun ? ['--dry-run'] : []), '--atomic', 'origin', 'HEAD:refs/heads/main', `refs/tags/${tag}`], { cwd, env: gitEnv, timeout: 300_000 }),
    // Back to the base commit after a dry run's rehearsal: the bump commit and its local tag are dropped.
    rewind: (sha, tag) => { git(['reset', '--quiet', '--hard', sha]); attempt('git', ['tag', '-d', tag], { cwd, env: gitEnv }); },
    apply: patch => {
      const dir = mkdtempSync(join(tmpdir(), 'hub-bump-'));
      try {
        const file = join(dir, 'bump.patch');
        writeFileSync(file, patch);
        git(['apply', '--check', file]);
        git(['apply', file]);
      } finally { rmSync(dir, { recursive: true, force: true }); }
    },
  };
}

const short = sha => (sha ?? '').slice(0, 8);

// The bump, with the race handled. main gets many commits a day, so the bump is built on the newest tip and a
// rejected push (main moved between the fetch and the push) fetches again, re-bumps and retries.
//
// A dry run rehearses everything a real run does up to the push: it commits (the machine's pre-commit guard runs),
// tags, and runs `git push --dry-run --atomic` with the same token (the pre-push guard runs and GitHub checks write
// access), then rewinds the checkout to the base commit. It returns the patch the later jobs apply to their own
// checkouts. Nothing reaches the remote: --dry-run sends no objects and updates no ref.
export async function bumpTransaction({ git, level, dryRun, onMain = true, readVersion, runBump, beforeCommit, message, maxAttempts = 3, log = console.log }) {
  if (git.shallow()) throw new Error('the plan checkout is shallow; the bump needs full history (actions/checkout fetch-depth: 0), because the pre-push guard cannot verify a shallow push');
  for (let round = 1; round <= maxAttempts; round += 1) {
    let base;
    if (round > 1) git.discard();
    if (onMain) {
      base = git.fetchMain();
      git.checkout(base);
    } else {
      base = git.head();
    }
    const dirty = git.changed();
    if (dirty.length > 0) throw new Error(`the checkout is not clean before the bump: ${dirty.slice(0, 5).join(', ')}`);
    const current = readVersion();
    const bumped = runBump(level);
    checkBump(current, bumped, level);
    const changed = git.changed();
    if (!sameFiles(changed, bumped.files)) throw new Error(`version.bump listed ${bumped.files.join(', ')} but changed ${changed.join(', ') || 'nothing'}; the listed files must be exactly the diff`);
    const tag = `v${bumped.version}`;
    const existing = git.remoteTag(tag);
    if (existing) {
      const remote = onMain ? git.remoteMain() : base;
      if (onMain && remote !== base && round < maxAttempts) { log(`HUB_BUMP_RACE ${tag} appeared on origin while main moved ${short(base)} -> ${short(remote)}; retrying on the new tip (${round}/${maxAttempts})`); continue; }
      throw new Error(`tag ${tag} already exists on origin (at ${short(existing.commit)}); a version is never reused. Bump past it, or delete the tag if that version never shipped`);
    }
    if (beforeCommit) await beforeCommit({ current, bumped, tag });
    git.add(bumped.files);
    const patch = git.diffCached();
    git.commit(message({ current, bumped, tag, level }));
    git.tag(tag, `${tag}`);
    if (dryRun) {
      const rehearsed = git.push(tag, { dryRun: true });
      git.rewind(base, tag);
      if (!rehearsed.ok) {
        const why = `${rehearsed.stdout}${rehearsed.stderr}`.trim().split('\n').slice(-6).join('\n');
        throw new Error(`the rehearsal \`git push --dry-run --atomic\` of the bump commit and ${tag} failed${rehearsed.timedOut ? ' (timed out)' : ''}; a real deploy would stop here:\n${why}`);
      }
      log(`HUB_PUSH_REHEARSED ${tag}: commit, tag and git push --dry-run --atomic passed (guards and write access); rewound to ${short(base)}`);
      return { base, sha: base, current, next: bumped, tag, files: bumped.files, patch, committed: false, rehearsed: true, attempts: round };
    }
    const pushed = git.push(tag);
    if (pushed.ok) {
      const sha = git.head();
      log(`HUB_BUMPED ${current.version} -> ${bumped.version} ${tag} at ${short(sha)} (base ${short(base)}, attempt ${round})`);
      return { base, sha, current, next: bumped, tag, files: bumped.files, patch, committed: true, attempts: round };
    }
    git.deleteTag(tag);
    const why = `${pushed.stdout}${pushed.stderr}`.trim().split('\n').slice(-6).join('\n');
    const remote = onMain ? git.remoteMain() : base;
    if (!onMain || remote === base) throw new Error(`git push of the bump commit and ${tag} failed${pushed.timedOut ? ' (timed out)' : ''}:\n${why}`);
    log(`HUB_BUMP_RACE main moved ${short(base)} -> ${short(remote)} before the push; fetching and bumping again (${round}/${maxAttempts})`);
  }
  throw new Error(`main kept moving: the bump push was rejected ${maxAttempts} times; run the deploy again`);
}
