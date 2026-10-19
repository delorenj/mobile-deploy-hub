#!/usr/bin/env node
// The front door for every app: `mise run deploy` in Tower, Green In Between and Gruvato fetches THIS file with
// `gh api` at the hub ref named in the app's deploy.yml `uses:` line (v1) and runs it, so all three deploy the same
// way. Self-contained on purpose (node builtins only): it runs from a temp folder, from any machine with gh.
//
//   node deploy.mjs [--dry-run true|false] [--bump patch|minor|major] [--platform both|android|ios]
//                   [--testflight true|false] [--play true|false] [--dry-handoff true|false] [--metered auto|allow]
//                   [--workflow deploy.yml] [--hub-ref REF] [--repo owner/repo] [--print]
//   node deploy.mjs train [--dry-run true|false] [...]     Tower, Green In Between, Gruvato, then Navi; stops at a red run
//
// A dry run is the default. It dispatches the app's deploy.yml on main, watches only the run it started, and after a
// green real run pulls the bump commit (`git pull --ff-only`) in the app's checkout. Nothing here refuses a deploy:
// the hub's gate holds every run to the policy, whoever dispatches it. An away S26 or an offline Mac only earns a
// note (the S26 delivery will be pending; the iPad lane skipped), and a red last real run earns an offer of
// `gh run rerun <id> --failed`.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

export const platforms = Object.freeze(['both', 'android', 'ios']);
// The S26 as tools/ci/devices.json names it (a hub test keeps the two equal). The Android lanes run on big-chungus,
// whose adb server holds the phone's wireless pairing.
export const phone = Object.freeze({ serial: 'R5GL43A7PCH', model: 'SM-S948U', host: 'big-chungus' });
// Every deploy bumps (patch unless told otherwise). There is no "none": a deploy that failed after its bump is
// finished with `gh run rerun <id> --failed`, which keeps the version and the commit.
export const levels = Object.freeze(['patch', 'minor', 'major']);
export const meteredModes = Object.freeze(['auto', 'allow']);
// Jarad's order, the hub policy's apps (a hub test keeps the two equal).
export const train = Object.freeze(['delorenj/tower-of-lost-things', 'delorenj/green-in-between', 'delorenj/gruvato', 'AutomaticAI-io/navi']);
const usage = 'Usage: deploy.mjs [train] [--dry-run true|false] [--bump patch|minor|major] [--platform both|android|ios] [--testflight true|false] [--play true|false] [--dry-handoff true|false] [--metered auto|allow] [--workflow deploy.yml] [--hub-ref REF] [--repo owner/repo] [--print]';

function flag(name, value, fallback) {
  if (value === undefined || value === '') return fallback;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`${name} must be true or false, got "${value}"`);
}

// mise passes every flag, with "" for the ones left unset, so blank means the default.
export function parseArguments(argv) {
  const known = ['--dry-run', '--bump', '--platform', '--testflight', '--play', '--dry-handoff', '--metered', '--workflow', '--hub-ref', '--repo'];
  const values = {};
  let print = false;
  let mode = 'deploy';
  const args = [...argv];
  if (args[0] === 'train') { mode = 'train'; args.shift(); }
  for (let index = 0; index < args.length; index += 1) {
    const name = args[index];
    if (name === '--print') { print = true; continue; }
    if (!known.includes(name)) throw new Error(`Unknown option ${name}. ${usage}`);
    if (args[index + 1] === undefined) throw new Error(`${name} needs a value`);
    values[name] = args[index + 1];
    index += 1;
  }
  const platform = values['--platform'] || 'both';
  if (!platforms.includes(platform)) throw new Error(`platform must be one of ${platforms.join(', ')}, got "${platform}"`);
  const bump = values['--bump'] || 'patch';
  if (!levels.includes(bump)) throw new Error(`bump must be one of ${levels.join(', ')}, got "${bump}"`);
  const metered = values['--metered'] || 'auto';
  if (!meteredModes.includes(metered)) throw new Error(`metered must be one of ${meteredModes.join(', ')}, got "${metered}"`);
  const workflow = values['--workflow'] || 'deploy.yml';
  if (!/^[\w.-]+\.ya?ml$/.test(workflow)) throw new Error(`workflow must be a file name in .github/workflows, got "${workflow}"`);
  const hubRef = values['--hub-ref'] ?? '';
  if (hubRef !== '' && !/^[\w./-]+$/.test(hubRef)) throw new Error(`hub ref "${hubRef}" is not a ref`);
  const repo = values['--repo'] ?? '';
  if (repo !== '' && !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) throw new Error(`repo must be owner/repo, got "${repo}"`);
  if (mode === 'train' && repo) throw new Error('the train deploys every app in order; drop --repo');
  return {
    mode,
    dryRun: flag('dry-run', values['--dry-run'], true),
    bump,
    bumpGiven: Boolean(values['--bump']),
    platform,
    testflight: flag('testflight', values['--testflight'], false),
    play: flag('play', values['--play'], false),
    dryHandoff: flag('dry-handoff', values['--dry-handoff'], false),
    metered,
    workflow,
    hubRef,
    repo,
    print,
  };
}

export function dispatchArguments({ workflow, dryRun, bump, platform, testflight, play, dryHandoff, metered = 'auto', repo = '' }) {
  return [
    'workflow', 'run', workflow, '--ref', 'main',
    ...(repo ? ['--repo', repo] : []),
    '-f', `platform=${platform}`,
    '-f', `dry_run=${dryRun}`,
    '-f', `bump=${bump}`,
    '-f', `testflight=${testflight}`,
    '-f', `play=${play}`,
    '-f', `dry_handoff=${dryHandoff}`,
    '-f', `metered=${metered}`,
  ];
}

// The runs a dispatch of ours can have started: newer than the newest run recorded before it, on the sha we meant.
export function newRuns(runs, { after, sha }) {
  return runs
    .filter(run => run.event === 'workflow_dispatch' && run.databaseId > after && run.headSha === sha)
    .sort((a, b) => a.databaseId - b.databaseId);
}

export const newestId = runs => runs.reduce((newest, run) => Math.max(newest, run.databaseId), 0);

// The lanes the app declares (its manifest, at the path deploy.yml passes). Unreadable means assume both.
export function lanesFrom(workflowText, read) {
  const path = /^\s+manifest:\s*(\S+)\s*$/m.exec(workflowText ?? '')?.[1] ?? 'mobile-deploy.json';
  try {
    const manifest = JSON.parse(read(path));
    return { android: Boolean(manifest.android), ios: Boolean(manifest.ios), manifest: path };
  } catch {
    return { android: true, ios: true, manifest: null };
  }
}

// The hub ref an app pins, read from its caller's `uses:` line.
export function hubRefFrom(workflowText) {
  return /uses:\s*delorenj\/mobile-deploy-hub\/\.github\/workflows\/mobile-deploy\.yml@([\w./-]+)/.exec(workflowText ?? '')?.[1] ?? null;
}

// The caller's run-name puts REAL in a real run's title, which is how a later deploy can tell the two apart.
export const lastRealRun = runs => runs.filter(run => /\bREAL\b/.test(run.displayTitle ?? '')).sort((a, b) => b.databaseId - a.databaseId)[0] ?? null;

const listFields = 'databaseId,headSha,event,status,conclusion,createdAt,url,displayTitle';

// `gh run watch --exit-status` exits non-zero for a red run, and also when gh itself cannot talk to GitHub (a rate limit
// shared with every other agent, a dropped connection): that is no verdict, and reporting it red once rolled a hub
// release back over a green dry run (v1.2.14, Gruvato). Ask the run itself, and watch again while it is unfinished.
export async function watchRun(gh, id, R, { sleep, log = console.log, attempts = 30, waitMs = 60_000 } = {}) {
  for (let attempt = 1; ; attempt += 1) {
    const status = gh(['run', 'watch', String(id), ...R, '--exit-status'], { inherit: true });
    if (status === 0) return 0;
    let state = null;
    try { state = JSON.parse(gh(['run', 'view', String(id), ...R, '--json', 'status,conclusion'])); } catch { /* unreadable: not a verdict */ }
    if (state?.status === 'completed') return state.conclusion === 'success' ? 0 : status;
    if (attempt >= attempts) return status;
    log(`DEPLOY_WATCH_RETRY run ${id}: the watch ended without a verdict (${state ? state.status : 'GitHub unreachable or rate limited'}); watching again in ${waitMs / 1000}s`);
    await sleep(waitMs);
  }
}

// On big-chungus, look for the S26 before dispatching. Information only: away means the S26 delivery is pending.
export async function checkPhone({ adb, log = console.log, sleep = ms => new Promise(done => setTimeout(done, ms)), waitMs = 20_000, pollMs = 2000, now = Date.now }) {
  try { adb(['start-server']); } catch (error) { return { found: false, why: `adb could not start (${error.message.split('\n')[0]})` }; }
  const deadline = now() + waitMs;
  for (;;) {
    const ids = adb(['devices']).split('\n').map(line => line.trim().split(/\s+/)).filter(([id, state]) => id && state === 'device' && id !== 'List').map(([id]) => id);
    for (const id of ids) {
      let serial = '';
      try { serial = adb(['-s', id, 'shell', 'getprop', 'ro.serialno']).trim(); } catch { continue; }
      if (serial === phone.serial) { log(`DEPLOY_S26 ${phone.model} on adb as ${id}`); return { found: true, id }; }
    }
    if (now() >= deadline) return { found: false, why: `the ${phone.model} (serial ${phone.serial}) is not on this host's adb server` };
    await sleep(pollMs);
  }
}

// A real run's receipts (artifacts) and big-chungus staging last 7 days; a rerun after that would publish nothing.
export const rerunWindowDays = 7;

export async function deploy(options, {
  gh, git, adb = null, host = hostname(), prompt = null, cwd = process.cwd(),
  sleep = ms => new Promise(done => setTimeout(done, ms)), log = console.log, timeoutMs = 120_000, pollMs = 3000, now = Date.now,
}) {
  const dispatch = dispatchArguments(options);
  if (options.print) {
    log(`gh ${dispatch.join(' ')}`);
    return { printed: true };
  }
  const R = options.repo ? ['--repo', options.repo] : [];
  const api = path => path.replace('{owner}/{repo}', options.repo || '{owner}/{repo}');
  const runs = () => JSON.parse(gh(['run', 'list', ...R, '--workflow', options.workflow, '--event', 'workflow_dispatch', '--limit', '30', '--json', listFields]) || '[]');
  const repo = options.repo || gh(['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner']).trim();

  // The hub deploys main as GitHub has it (and bumps on its newest tip), so a local checkout elsewhere only means this
  // machine is behind or ahead: worth a note, not a stop.
  const sha = gh(['api', api('repos/{owner}/{repo}/commits/main'), '--jq', '.sha']).trim();
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`could not read main from GitHub (got "${sha.slice(0, 60)}")`);
  let head = '';
  if (!options.repo) { try { head = git(['rev-parse', 'HEAD']).trim(); } catch { /* not a checkout */ } }
  if (!options.repo && head !== sha) log(`DEPLOY_WARNING local HEAD ${head.slice(0, 8) || '-'} is not main on GitHub (${sha.slice(0, 8)}); the deploy builds main, not this checkout`);

  // The caller and the manifest: from this checkout, or from GitHub's main when deploying another repo.
  const readRemote = path => gh(['api', '-H', 'Accept: application/vnd.github.raw', api(`repos/{owner}/{repo}/contents/${path}?ref=main`)]);
  const read = options.repo ? readRemote : path => readFileSync(join(cwd, path), 'utf8');
  let workflowText = '';
  try { workflowText = read(`.github/workflows/${options.workflow}`); } catch { /* checked below where it matters */ }
  const lanes = lanesFrom(workflowText, read);
  if (options.platform === 'ios' && !lanes.ios) throw new Error(`${lanes.manifest} declares no ios section, so there is no iPad lane to deploy`);
  if (options.platform === 'android' && !lanes.android) throw new Error(`${lanes.manifest} declares no android section, so there is no S26 lane to deploy`);
  const ios = options.platform !== 'android' && lanes.ios;
  const android = options.platform !== 'ios' && lanes.android;
  if (ios) {
    try {
      const runners = JSON.parse(gh(['api', api('repos/{owner}/{repo}/actions/runners'), '--jq', '[.runners[] | {name, status, labels: [.labels[].name]}]']) || '[]');
      const macs = runners.filter(runner => runner.labels.some(label => label.toLowerCase() === 'macos'));
      if (macs.length === 0) log(`DEPLOY_NOTE ${repo} has no macOS runner registered; the iPad lane will be skipped`);
      else if (!macs.some(runner => runner.status === 'online')) log(`DEPLOY_NOTE the iPad lane will be skipped: ${macs.map(runner => runner.name).join(', ')} offline`);
    } catch (error) {
      log(`DEPLOY_NOTE could not read the runners of ${repo} (${error.message.split('\n')[0]}); the gate decides the iPad lane`);
    }
  }
  if (android && adb && host === phone.host) {
    const seen = await checkPhone({ adb, log, sleep });
    if (!seen.found) log(`DEPLOY_NOTE the S26 is away; it will be pending (${seen.why}). It installs from the notification's Install APK, Quickdrop, or the catch-up when it is back`);
  }

  const before = runs();
  if (!options.dryRun) {
    const last = lastRealRun(before);
    const ageDays = last ? (now() - Date.parse(last.createdAt ?? '')) / 86_400_000 : 0;
    if (last && last.status === 'completed' && last.conclusion !== 'success' && !(ageDays < rerunWindowDays)) {
      log(`DEPLOY_LAST_REAL_RED ${last.databaseId} ${last.conclusion} ${last.url}: ${Number.isFinite(ageDays) ? `${Math.floor(ageDays)} days old` : 'of unknown age'}, past the ${rerunWindowDays}-day window of its receipts and staging, so a rerun would publish nothing; this deploy is a new version`);
    } else if (last && last.status === 'completed' && last.conclusion !== 'success') {
      log(`DEPLOY_LAST_REAL_RED ${last.databaseId} ${last.conclusion} ${last.url}: \`gh run rerun ${last.databaseId} --failed\` finishes it (same version, same commit); the catch-up converges the devices either way`);
      const rerun = prompt ? /^y(es)?$/i.test((await prompt(`The last real deploy (${last.url}) is red. Re-run its failed jobs instead of a new deploy? [y/N] `)).trim()) : false;
      if (rerun) {
        gh(['run', 'rerun', String(last.databaseId), ...R, '--failed']);
        log(`DEPLOY_RERUN ${last.databaseId} failed jobs re-run (same version, same commit)`);
        await sleep(pollMs);
        const status = await watchRun(gh, last.databaseId, R, { sleep, log });
        log(`${status === 0 ? 'DEPLOY_GREEN' : 'DEPLOY_RED'} run ${last.databaseId} rerun ${last.url}`);
        return { run: last, status, rerun: true };
      }
    }
  }

  const after = newestId(before);
  log(`DEPLOY_DISPATCH ${repo} ${options.dryRun ? 'dry run' : 'REAL run'} bump=${options.bump} platform=${options.platform}${options.testflight ? ' testflight' : ''}${options.play ? ' play' : ''}${options.dryHandoff ? ' dry_handoff' : ''} metered=${options.metered} main=${sha.slice(0, 8)} hub=${options.hubRef || hubRefFrom(workflowText) || '?'} (newest earlier run: ${after || 'none'})`);
  gh(dispatch);

  const deadline = Date.now() + timeoutMs;
  let started = [];
  while (started.length === 0 && Date.now() < deadline) {
    await sleep(pollMs);
    started = newRuns(runs(), { after, sha });
  }
  if (started.length === 0) throw new Error(`no new ${options.workflow} run appeared within ${timeoutMs / 1000}s of the dispatch; look at the Actions tab, do not trust an older run`);
  if (started.length > 1) throw new Error(`more than one new run started (${started.map(run => run.url).join(', ')}); another dispatch raced this one, watch the right one by hand: gh run watch <id> --exit-status`);

  const [run] = started;
  log(`DEPLOY_RUN ${run.databaseId} ${run.url}`);
  const status = await watchRun(gh, run.databaseId, R, { sleep, log });
  log(`${status === 0 ? 'DEPLOY_GREEN' : 'DEPLOY_RED'} run ${run.databaseId} ${options.dryRun ? 'dry run' : 'real run'} ${run.url}`);

  if (status === 0 && !options.dryRun) {
    try {
      const target = options.repo ? { cwd: join(homedir(), 'code', options.repo.split('/')[1]) } : {};
      if (git(['rev-parse', '--abbrev-ref', 'HEAD'], target).trim() === 'main') {
        git(['pull', '--ff-only', 'origin', 'main'], target);
        log('DEPLOY_PULLED the bump commit (git pull --ff-only)');
      } else {
        log('DEPLOY_NOTE that checkout is not on main; pull the bump commit there: git pull --ff-only');
      }
    } catch (error) {
      log(`DEPLOY_NOTE git pull --ff-only did not run (${error.message.split('\n')[0]}); pull the bump commit by hand`);
    }
  }
  return { run, status };
}

// Tower, Green In Between, Gruvato, then Navi, one at a time; the first red run stops the train.
export async function deployTrain(options, deps, { apps = train, log = deps.log ?? console.log } = {}) {
  const results = [];
  for (const repo of apps) {
    log(`DEPLOY_TRAIN ${repo} (${results.length + 1}/${apps.length}) ${options.dryRun ? 'dry run' : 'REAL'}`);
    let result;
    try {
      result = await deploy({ ...options, mode: 'deploy', repo }, deps);
    } catch (error) {
      log(`DEPLOY_TRAIN stopped at ${repo}: ${error.message.split('\n')[0]}`);
      return { results, stopped: repo, status: 1 };
    }
    results.push({ repo, ...result });
    if ((result.status ?? 0) !== 0) {
      log(`DEPLOY_TRAIN stopped at ${repo}: run ${result.run?.databaseId ?? '?'} is red; the apps after it were not dispatched`);
      return { results, stopped: repo, status: result.status };
    }
  }
  log(`DEPLOY_TRAIN done: ${apps.join(', ')} green`);
  return { results, stopped: null, status: 0 };
}

// gh and git as child processes. `inherit` streams the watch to the terminal and returns the exit status; everything
// else returns stdout and throws with the tail of stderr.
export function realGh(args, { inherit = false } = {}) {
  if (inherit) return spawnSync('gh', args, { stdio: 'inherit' }).status ?? 1;
  const result = spawnSync('gh', args, { encoding: 'utf8' });
  if (result.error || result.status !== 0) throw new Error(`gh ${args.slice(0, 2).join(' ')} failed: ${result.error?.message ?? result.stderr.trim().slice(-400)}`);
  return result.stdout;
}

export function realAdb(args) {
  const result = spawnSync(process.env.HUB_ADB || join(homedir(), 'Android/Sdk/platform-tools/adb'), args, { encoding: 'utf8', timeout: 30_000 });
  if (result.error || result.status !== 0) throw new Error(`adb ${args[0]} failed: ${result.error?.message ?? result.stderr.trim().slice(-200)}`);
  return result.stdout;
}

export function realGit(args, { cwd } = {}) {
  const result = spawnSync('git', args, { encoding: 'utf8', cwd });
  if (result.error || result.status !== 0) throw new Error(`git ${args[0]} failed: ${result.error?.message ?? result.stderr.trim().slice(-400)}`);
  return result.stdout;
}

async function terminalPrompt(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try { return await rl.question(question); } finally { rl.close(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseArguments(process.argv.slice(2));
    const deps = { gh: realGh, git: realGit, adb: realAdb, prompt: process.stdin.isTTY ? terminalPrompt : null };
    const result = options.mode === 'train' ? await deployTrain(options, deps) : await deploy(options, deps);
    process.exitCode = result.status ?? 0;
  } catch (error) {
    console.error(`::error::${error.message}`);
    process.exitCode = 1;
  }
}
