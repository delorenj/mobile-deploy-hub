#!/usr/bin/env node
// mise run conformance (design v1.1, A3): every app the policy lists still deploys only through the hub. Read through
// `gh api` at each app's main, so it works from any machine with gh:
//   - the caller (.github/workflows/deploy.yml) is an accepted copy of templates/deploy.yml (policy callers.accept);
//   - the manifest is schema 2 and declares every lane the policy gives the app;
//   - no other workflow uploads builds (gh release create or upload, altool, TestFlight uploads, APK/IPA artifacts);
//   - no mise task tags v*, bumps the version or announces a deploy (the task's run text and the scripts it runs).
// GitHub Free has no rulesets for these private repos, so this, the global pre-commit guard and the event's hub_ref
// are what make a deploy around the hub visible. Exceptions are listed below with the reason and when they end.
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { callerHash } from './ci/lib/caller.mjs';
import { parseManifest } from './ci/lib/manifest.mjs';
import { loadPolicy } from './ci/lib/policy.mjs';

export const exceptions = Object.freeze({
  'delorenj/pile-of-dumb-things': {
    '.github/workflows/testflight.yml': 'the pre-hub TestFlight fallback; deleted after the first hub --testflight run (design A3)',
    'task testflight': 'dispatches testflight.yml (above); deleted with it',
  },
  'delorenj/gruvato': {
    'task ios:simulator announce': 'announces its own simulator event, which is not a device deploy (design A3)',
  },
});

export const uploadPatterns = Object.freeze([
  [/gh\s+release\s+(create|upload)/, 'gh release create/upload'],
  [/\baltool\b/, 'xcrun altool'],
  [/upload-testflight|testflight\.mjs\s+upload|pilot\s+upload/, 'a TestFlight upload'],
  [/upload-artifact[\s\S]{0,300}?\.(apk|ipa|aab)\b/, 'an APK/IPA/AAB artifact upload'],
]);

export const taskPatterns = Object.freeze([
  [/\bgit\s+tag\b|refs\/tags\/|git\s+push[^\n]*--tags/, 'tag'],
  [/versioning\.sh'?\s+(bump|sync)\b|bump-build-version|bump-version\.sh|\bversion:bump|npm\s+version\s/, 'bump'],
  [/\bbb-emit\b|emit-deploy-event|announce-deploy/, 'announce'],
  [/gh\s+release\s+(create|upload)/, 'release upload'],
]);

// [tasks.<name>] blocks of a mise.toml: name and body (run text and everything else in the block).
export function miseTasks(text) {
  const tasks = [];
  const lines = String(text ?? '').split('\n');
  let current = null;
  for (const line of lines) {
    const header = /^\[tasks\.(?:"([^"]+)"|([\w:.-]+))\]\s*$/.exec(line);
    if (header) { current = { name: header[1] ?? header[2], body: '' }; tasks.push(current); continue; }
    if (/^\[[^\]]+\]\s*$/.test(line) || /^\[\[/.test(line)) { current = null; continue; }
    if (current) current.body += `${line}\n`;
  }
  return tasks;
}

// The repo scripts a task runs (one level deep): scripts/…, tools/…, .mise/scripts/….
export const scriptsOf = body => [...new Set([...String(body).matchAll(/(?:^|[\s'"/}])((?:scripts|tools|\.mise\/scripts|native\/tools)\/[\w./-]+\.(?:sh|mjs|js|py))/g)].map(match => match[1]))];

export function checkWorkflow(repo, path, text) {
  if (path === '.github/workflows/deploy.yml') return [];
  if (exceptions[repo]?.[path]) return [];
  return uploadPatterns.filter(([pattern]) => pattern.test(text)).map(([, what]) => `${repo} ${path}: ${what} outside the hub`);
}

export function checkTasks(repo, mise, readScript) {
  const problems = [];
  for (const task of miseTasks(mise)) {
    if (exceptions[repo]?.[`task ${task.name}`]) continue;
    const sources = [['the task', task.body]];
    // The scaffold's generic scripts (.mise/scripts: versioning, links, env) have bump and tag paths behind
    // subcommands; the task text above already shows which subcommand a task runs.
    // Tests are skipped too: they name these commands to assert their absence.
    for (const script of scriptsOf(task.body).filter(path => !path.startsWith('.mise/scripts/') && !/\.test\.(m?js|py)$/.test(path))) {
      let text = '';
      try { text = readScript(script); } catch { continue; }
      sources.push([script, text]);
    }
    for (const [where, text] of sources) {
      for (const [pattern, what] of taskPatterns) {
        if (!pattern.test(text)) continue;
        if (exceptions[repo]?.[`task ${task.name} ${what}`]) continue;
        problems.push(`${repo} mise task ${task.name}: ${where} would ${what} outside the hub`);
      }
    }
  }
  return problems;
}

export function checkApp({ repo, app, policy, read, list }) {
  const problems = [];
  try {
    const hash = callerHash(read(policy.callers.workflow));
    if (!policy.callers.accept.includes(hash)) problems.push(`${repo} ${policy.callers.workflow}: not an accepted copy of templates/deploy.yml (normalized sha256 ${hash.slice(0, 12)})`);
  } catch (error) { problems.push(`${repo} ${policy.callers.workflow}: ${error.message.split('\n')[0]}`); }
  try {
    const manifest = parseManifest(read(policy.callers.manifest));
    const missing = app.lanes.filter(lane => !manifest[lane]);
    if (missing.length > 0) problems.push(`${repo} ${policy.callers.manifest}: declares no ${missing.join(' or ')} section`);
    if (manifest.project.slug !== app.slug) problems.push(`${repo} ${policy.callers.manifest}: project.slug ${manifest.project.slug}, the policy says ${app.slug}`);
  } catch (error) { problems.push(`${repo} ${policy.callers.manifest}: ${error.message.split('\n')[0]}`); }
  for (const path of list('.github/workflows').filter(name => /\.ya?ml$/.test(name))) {
    try { problems.push(...checkWorkflow(repo, path, read(path))); } catch (error) { problems.push(`${repo} ${path}: ${error.message.split('\n')[0]}`); }
  }
  let mise = '';
  try { mise = read('mise.toml'); } catch { /* an app without mise tasks has nothing to check */ }
  problems.push(...checkTasks(repo, mise, read));
  return problems;
}

function gh(args) {
  const result = spawnSync('gh', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error(`gh ${args.slice(0, 3).join(' ')} failed: ${(result.stderr || result.error?.message || '').trim().slice(-300)}`);
  return result.stdout;
}

export function remoteRepo(repo, ref = 'main') {
  return {
    read: path => gh(['api', '-H', 'Accept: application/vnd.github.raw', `repos/${repo}/contents/${path}?ref=${ref}`]),
    list: dir => JSON.parse(gh(['api', `repos/${repo}/contents/${dir}?ref=${ref}`])).filter(entry => entry.type === 'file').map(entry => entry.path),
  };
}

export function conformance({ policy = loadPolicy().policy, open = remoteRepo, log = console.log } = {}) {
  const problems = [];
  for (const [repo, app] of Object.entries(policy.apps)) {
    const found = checkApp({ repo, app, policy, ...open(repo) });
    log(found.length === 0 ? `CONFORMANCE_OK ${repo}` : found.map(problem => `CONFORMANCE_FAIL ${problem}`).join('\n'));
    problems.push(...found);
  }
  return problems;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const problems = conformance();
  if (problems.length > 0) {
    console.error(`::error::${problems.length} conformance problems; every app deploys only through the hub (mise run deploy)`);
    process.exitCode = 1;
  }
}
