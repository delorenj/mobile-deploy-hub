#!/usr/bin/env node
// The front door for every app: `mise run deploy` in Tower, Green In Between and Gruvato fetches THIS file with
// `gh api` at the hub ref named in the app's deploy.yml `uses:` line (v1) and runs it, so all three deploy the same
// way. Self-contained on purpose (node builtins only): it runs from a temp folder, from any machine with gh.
//
//   node deploy.mjs [--dry-run true|false] [--bump patch|minor|major] [--platform both|android|ios]
//                   [--testflight true|false] [--play true|false] [--dry-handoff true|false] [--metered auto|allow]
//                   [--workflow deploy.yml] [--hub-ref REF] [--repo owner/repo] [--print]
//   node deploy.mjs train [--dry-run true|false] [...]     Tower, Green In Between, Gruvato, Navi, Earshot, then Shortwave; stops at a red run
//   node deploy.mjs ship [--bump patch|minor|major] [--metered auto|allow] [--abandon RUN_ID] [--hub-ref REF] [--repo owner/repo]
//                                                           one command: recover a red last real run, else dry run, then the
//                                                           real run on the same commit, then the completion verdict
//
// A dry run is the default. It dispatches the app's deploy.yml on main, watches only the run it started, and after a
// green real run pulls the bump commit (`git pull --ff-only`) in the app's checkout. Nothing here refuses a deploy:
// the hub's gate holds every run to the policy, whoever dispatches it. An away S26 or an offline Mac only earns a
// note (the S26 delivery will be pending; the iPad lane skipped), and a red last real run earns an offer of
// `gh run rerun <id> --failed`.
//
// `ship` (TOWE-76) judges the targets configured in the pinned hub policy's optional `completion` block.
// With no block, the deployed v1.2.25 defaults apply: no required devices or TestFlight, unavailable lanes skip,
// and red runs require an explicit same-version rerun. `deploy` remains the primitive for narrowed runs.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { homedir, hostname, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
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
export const train = Object.freeze(['delorenj/tower-of-lost-things', 'delorenj/green-in-between', 'delorenj/gruvato', 'AutomaticAI-io/navi', 'delorenj/earshot', 'delorenj/shortwave']);
const usage = 'Usage: deploy.mjs [train] [--dry-run true|false] [--bump patch|minor|major] [--platform both|android|ios] [--testflight true|false] [--play true|false] [--dry-handoff true|false] [--metered auto|allow] [--workflow deploy.yml] [--hub-ref REF] [--repo owner/repo] [--print]\n       deploy.mjs ship [--bump patch|minor|major] [--metered auto|allow] [--abandon RUN_ID] [--workflow deploy.yml] [--hub-ref REF] [--repo owner/repo]';
// What ship never takes: it never narrows a run or skips its dry run. TestFlight is opt-in via deploy on the
// deployed policy; a future explicit completion block may require it for store apps.
const notForShip = Object.freeze(['--dry-run', '--platform', '--testflight', '--play', '--dry-handoff', '--print']);

function flag(name, value, fallback) {
  if (value === undefined || value === '') return fallback;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`${name} must be true or false, got "${value}"`);
}

// mise passes every flag, with "" for the ones left unset, so blank means the default.
export function parseArguments(argv) {
  const known = ['--dry-run', '--bump', '--platform', '--testflight', '--play', '--dry-handoff', '--metered', '--workflow', '--hub-ref', '--repo', '--abandon'];
  const values = {};
  let print = false;
  let mode = 'deploy';
  const args = [...argv];
  if (args[0] === 'train' || args[0] === 'ship') mode = args.shift();
  for (let index = 0; index < args.length; index += 1) {
    const name = args[index];
    if (mode === 'ship' && notForShip.includes(name) && (name === '--print' || (args[index + 1] ?? '') !== '')) throw new Error(`ship takes no ${name}: it never narrows, never skips its dry run and never turns TestFlight off; use \`deploy\` for that`);
    if (name === '--print') { print = true; continue; }
    if (!known.includes(name)) throw new Error(`Unknown option ${name}. ${usage}`);
    if (name === '--abandon' && mode !== 'ship') throw new Error('--abandon is a ship option');
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
  const abandon = values['--abandon'] ?? '';
  if (abandon !== '' && !/^\d{1,20}$/.test(abandon)) throw new Error(`--abandon takes the red real run's id, got "${abandon}"`);
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
    abandon,
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

// The exit status of a watch that never saw the run finish. Not red: red is 1, green is 0, and this is "we do not know".
export const unknownStatus = 3;

// What a person types to finish a watch the front door gave up on.
export const finishByHand = (id, R) => `gh run watch ${id} ${R.join(' ')} --interval 30 --exit-status`.replace(/ {2,}/g, ' ');

// How long to sit out GitHub's primary rate limit: `gh api rate_limit` is not itself metered, so it is cheap to ask.
// Null when the core budget is not spent (a secondary limit, a dropped connection) or the answer is unreadable.
export function rateLimitWaitMs(gh, now = Date.now) {
  try {
    const core = JSON.parse(gh(['api', 'rate_limit'])).resources?.core;
    if (core && core.remaining < 1 && core.reset * 1000 > now()) return core.reset * 1000 - now() + 2000;
  } catch { /* unreadable: back off blind */ }
  return null;
}

// Wait for a run to report `completed`, and say what it concluded. The old watch was `gh run watch --exit-status`, which
// polls every 3 s (a run and its jobs and each job's annotations: about 2,300 requests in 25 minutes) and exits non-zero
// both for a red run and when gh cannot talk to GitHub (a rate limit shared with every other agent, a dropped
// connection). That second exit is no verdict, and reporting it red once rolled a hub release back over a green dry run
// (v1.2.14, Gruvato) and again turned a green green-in-between run red (2026-10-19). So: one `gh api` read of the run
// every `intervalMs`, backing off (to `backoffMaxMs`, or to the rate limit's reset) while GitHub cannot be read, until
// the run says `completed`: 0 for success, 1 for any other conclusion. Only `capMs` of no verdict ends it, as
// `unknownStatus`, never as red.
export async function watchRun(gh, id, R, {
  sleep, log = console.log, now = Date.now,
  intervalMs = 30_000, backoffMaxMs = 300_000, capMs = 6 * 3_600_000, heartbeatMs = 300_000,
} = {}) {
  const path = `repos/${R[1] ?? '{owner}/{repo}'}/actions/runs/${id}`;
  const began = now();
  let failures = 0;
  let seen = null;
  let lastSaid = began;
  for (;;) {
    let state = null;
    let why = '';
    try { state = JSON.parse(gh(['api', path, '--jq', '{status,conclusion}'])); } catch (error) { why = error.message.split('\n')[0]; }
    if (state && typeof state.status !== 'string') { state = null; why = 'GitHub answered without a status'; }
    if (state?.status === 'completed') return state.conclusion === 'success' ? 0 : 1;
    const elapsed = now() - began;
    if (elapsed >= capMs) return unknownStatus;
    let wait = intervalMs;
    if (state) {
      failures = 0;
      if (state.status !== seen || now() - lastSaid >= heartbeatMs) {
        log(`DEPLOY_WATCH run ${id}: ${state.status} (${Math.round(elapsed / 60_000)} min)`);
        seen = state.status;
        lastSaid = now();
      }
    } else {
      failures += 1;
      const limited = rateLimitWaitMs(gh, now);
      wait = limited ?? Math.min(backoffMaxMs, intervalMs * 2 ** failures);
      wait = Math.min(wait, Math.max(capMs - elapsed, 1));
      log(`DEPLOY_WATCH_RETRY run ${id}: no verdict yet (${why || 'GitHub unreachable or rate limited'}); asking again in ${Math.round(wait / 1000)}s${limited ? ' (the rate limit resets then)' : ''}`);
    }
    await sleep(wait);
  }
}

// The line that ends a watch, and the status it settles on.
export function verdictLine(status, id, kind, url, R) {
  if (status === 0) return `DEPLOY_GREEN run ${id} ${kind} ${url}`;
  if (status === unknownStatus) return `DEPLOY_UNKNOWN run ${id} ${kind} ${url}: no verdict from GitHub, so this is neither green nor red; finish by hand: ${finishByHand(id, R)}`;
  return `DEPLOY_RED run ${id} ${kind} ${url}`;
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
  sleep = ms => new Promise(done => setTimeout(done, ms)), log = console.log, timeoutMs = 120_000, pollMs = 3000, now = Date.now, watch = {},
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
        const status = await watchRun(gh, last.databaseId, R, { sleep, log, now, ...watch });
        log(verdictLine(status, last.databaseId, 'rerun', last.url, R));
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
  if (started.length > 1) throw new Error(`more than one new run started (${started.map(run => run.url).join(', ')}); another dispatch raced this one, watch the right one by hand: gh run watch <id> --interval 30 --exit-status`);

  const [run] = started;
  log(`DEPLOY_RUN ${run.databaseId} ${run.url}`);
  const status = await watchRun(gh, run.databaseId, R, { sleep, log, now, ...watch });
  log(verdictLine(status, run.databaseId, options.dryRun ? 'dry run' : 'real run', run.url, R));

  if (status === 0 && !options.dryRun) pullBump(git, options, log);
  return { run, status };
}

// After a real run that bumped: the bump commit into the app's checkout (this one, or ~/code/<name> for --repo).
export function pullBump(git, options, log, prefix = 'DEPLOY') {
  try {
    const target = options.repo ? { cwd: join(homedir(), 'code', options.repo.split('/')[1]) } : {};
    if (git(['rev-parse', '--abbrev-ref', 'HEAD'], target).trim() === 'main') {
      git(['pull', '--ff-only', 'origin', 'main'], target);
      log(`${prefix}_PULLED the bump commit (git pull --ff-only)`);
    } else {
      log(`${prefix}_NOTE that checkout is not on main; pull the bump commit there: git pull --ff-only`);
    }
  } catch (error) {
    log(`${prefix}_NOTE git pull --ff-only did not run (${error.message.split('\n')[0]}); pull the bump commit by hand`);
  }
}

// Tower, Green In Between, Gruvato, Navi, Earshot, then Shortwave, one at a time; the first red run stops the train.
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
      log(`DEPLOY_TRAIN stopped at ${repo}: run ${result.run?.databaseId ?? '?'} is ${result.status === unknownStatus ? 'unknown (no verdict from GitHub)' : 'red'}; the apps after it were not dispatched`);
      return { results, stopped: repo, status: result.status };
    }
  }
  log(`DEPLOY_TRAIN done: ${apps.join(', ')} green`);
  return { results, stopped: null, status: 0 };
}

// ---------------------------------------------------------------------------------------------------- ship

// ship's one-line verdicts and their exit statuses. 4 and 5 are neither green nor red: something is owed (4), or ship
// would not start because something has to happen first (5: a real run in flight, or a required lane that cannot run).
export const shipExit = Object.freeze({ COMPLETE: 0, RED: 1, UNKNOWN: 3, INCOMPLETE: 4, RECOVERY_BLOCKED: 4, BUSY: 5, BLOCKED: 5 });
export const hubRepo = 'delorenj/mobile-deploy-hub';
const short = sha => String(sha ?? '').slice(0, 8);

// The paths a hook command names (node tools/testflight.mjs upload ... -> tools/testflight.mjs).
export const hookScripts = command => [...new Set([...String(command ?? '').matchAll(/(?:^|[\s'"=])((?:[\w.-]+\/)+[\w.-]+\.(?:mjs|cjs|js|ts|sh|py|rb))\b/g)].map(match => match[1]).filter(path => !path.startsWith('/') && !path.split('/').includes('..')))];

// The hook a failure names ("hook ios.store.upload failed (exit 1)"), and its command in a manifest.
export const failedHook = reason => /\bhook ([a-z]+(?:\.[a-z_]+)+) failed\b/.exec(String(reason ?? ''))?.[1] ?? null;
export const hookCommand = (manifest, name) => { const found = String(name).split('.').reduce((node, key) => (node && typeof node === 'object' ? node[key] : undefined), manifest); return typeof found === 'string' ? found : null; };

// A frozen-tools failure: the hook that failed runs files that changed on main since the commit the run built. A rerun
// checks that commit out again, so it would run the same broken tools. The files a hook runs are the scripts its command
// names and their sibling modules (the same folder), and the command itself when the manifest changed it.
export function frozenTools({ hook, before, after, changed }) {
  if (!hook || !before) return null;
  const scripts = hookScripts(before);
  const folders = new Set(scripts.map(path => dirname(path)));
  const touched = (changed ?? []).filter(file => scripts.includes(file) || folders.has(dirname(file)));
  if (after !== null && after !== undefined && after !== before) touched.push(`the ${hook} command in the manifest`);
  return touched.length > 0 ? { hook, touched: [...new Set(touched)] } : null;
}

// The policy's completion rules at the hub ref this app pins. An absent block means the v1.2.25 skip/no-rerun
// contract, not a strict refusal.
export function readShipPolicy(gh, hubRef) {
  try {
    const policy = JSON.parse(gh(['api', '-H', 'Accept: application/vnd.github.raw', `repos/${hubRepo}/contents/tools/ci/policy.json?ref=${hubRef}`]));
    const completion = policy?.completion;
    const reruns = Number.isSafeInteger(completion?.reruns) && completion.reruns >= 0 && completion.reruns <= 3 ? completion.reruns : 0;
    return { reruns, laneUnavailable: completion?.lane_unavailable === 'refuse' ? 'refuse' : 'skip', read: true };
  } catch (error) {
    return { reruns: 0, laneUnavailable: 'refuse', read: false, why: error.message.split('\n')[0] };
  }
}

function findFile(dir, name) {
  let entries = [];
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return null; }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isFile() && entry.name === name) return path;
    if (entry.isDirectory()) { const found = findFile(path, name); if (found) return found; }
  }
  return null;
}

function receiptsIn(dir, found = {}) {
  let entries = [];
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return found; }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) receiptsIn(path, found);
    else if (/^hub-receipt-[\w-]+\.json$/.test(entry.name)) { try { const receipt = JSON.parse(readFileSync(path, 'utf8')); if (receipt?.lane) found[receipt.lane] = receipt; } catch { /* a torn receipt adds nothing */ } }
  }
  return found;
}

// The one command (TOWE-76). Exit statuses: shipExit. Nothing here prompts: running ship is the consent to recover a red
// last real run with `gh run rerun --failed`, so an agent without a terminal gets the same behaviour as a person.
export async function ship(options, {
  gh, git, sleep = ms => new Promise(done => setTimeout(done, ms)), log = console.log, now = Date.now, timeoutMs = 120_000, pollMs = 3000, watch = {},
  scratch = () => mkdtempSync(join(tmpdir(), 'hub-ship-')),
}) {
  const repo = options.repo || gh(['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner']).trim();
  const R = ['--repo', repo];
  const finish = (verdict, line, extra = {}) => { log(line); return { status: shipExit[verdict], verdict, line, ...extra }; };
  const mainSha = () => {
    const sha = gh(['api', `repos/${repo}/commits/main`, '--jq', '.sha']).trim();
    if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`could not read main from GitHub (got "${sha.slice(0, 60)}")`);
    return sha;
  };
  const readRemote = (path, ref = 'main') => gh(['api', '-H', 'Accept: application/vnd.github.raw', `repos/${repo}/contents/${path}?ref=${ref}`]);
  const listRuns = () => JSON.parse(gh(['run', 'list', ...R, '--workflow', options.workflow, '--event', 'workflow_dispatch', '--limit', '30', '--json', listFields]) || '[]');
  const download = (id, artifact, consume) => {
    const dir = scratch();
    try {
      gh(['run', 'download', String(id), ...R, '-n', artifact, '-D', dir]);
      return consume(dir);
    } catch { return null; } finally { rmSync(dir, { recursive: true, force: true }); }
  };
  const completionOf = id => download(id, 'completion-out', dir => { const file = findFile(dir, 'completion.json'); return file ? JSON.parse(readFileSync(file, 'utf8')) : null; });
  const state = { realDispatched: false };

  let workflowText = '';
  try { workflowText = readRemote(`.github/workflows/${options.workflow}`); } catch { /* the gate holds the caller to the template */ }
  const hubRef = options.hubRef || hubRefFrom(workflowText) || 'v1';
  const manifestPath = /^\s+manifest:\s*(\S+)\s*$/m.exec(workflowText)?.[1] ?? 'tools/ci/mobile-deploy.json';
  const policy = readShipPolicy(gh, hubRef);
  if (!policy.read) log(`SHIP_NOTE could not read the completion policy at ${hubRepo}@${hubRef}${policy.why ? ` (${policy.why})` : ''}: no automatic reruns this time`);

  // What a run left behind: from its completion-out (hub v1.3), else from its plan, lane and deliver receipts and the
  // plan job's result (a run of an older hub).
  const inspect = id => {
    const completion = completionOf(id);
    if (completion) return { completion, bumped: completion.bumped === true, buildSha: completion.commit ?? null, version: completion.version, failure: completion.failure };
    let jobs = [];
    try { jobs = JSON.parse(gh(['api', `repos/${repo}/actions/runs/${id}/jobs?per_page=100`, '--jq', '[.jobs[] | {name, conclusion}]']) || '[]'); } catch { /* the receipts may still say */ }
    const planJob = jobs.find(job => /(^|\/ )plan$/.test(job.name ?? ''));
    const receipts = {};
    for (const artifact of ['plan-out', 'ios-out', 'android-out', 'deliver-ios-out', 'deliver-android-out']) download(id, artifact, dir => receiptsIn(dir, receipts));
    const plan = receipts.plan;
    const bumped = plan?.bump?.committed === true || (plan?.outcome !== 'failure' && planJob?.conclusion === 'success');
    const failed = ['ios', 'android', 'android-release', 'android-play', 'ios-export', 'deliver-ios', 'deliver-android', 'plan', 'gate'].map(lane => receipts[lane]).find(receipt => receipt?.outcome === 'failure');
    return { completion: null, bumped, buildSha: plan?.sha ?? null, version: plan?.version ?? null, failure: failed ? { job: failed.lane, stage: failed.stage ?? null, reason: failed.reason ?? null } : null };
  };

  // The verdict of a finished run, from its completion-out.
  const settle = (run, completion, how = '', older = false) => {
    if (!completion) return finish('UNKNOWN', `SHIP_UNKNOWN ${repo} run ${run.databaseId} ${run.url}: the run is green but its completion verdict could not be read (gh run download ${run.databaseId} --repo ${repo} -n completion-out)${how}`);
    if (completion.verdict === 'COMPLETE' || completion.verdict === 'INCOMPLETE') {
      if (completion.bumped) pullBump(git, options, log, 'SHIP');
      if (older) log(`SHIP_NOTE ${repo} ${completion.version ?? ''} was recovered; anything newer on main ships with the next \`mise run ship\``);
      return finish(completion.verdict, `SHIP_${completion.verdict} ${completion.summary} (run ${run.databaseId}${how})`, { run, completion });
    }
    return finish('RED', `SHIP_RED ${completion.summary} (run ${run.databaseId}${how})`, { run, completion });
  };

  // RECOVER: a red real run that spent its version is finished before anything new is shipped (never a second bump for
  // one failure). A rerun checks the run's own commit out again, so a failure in an app hook whose files changed on main
  // since is not rerun: the same tools would fail the same way.
  const recover = async (run, facts, { older = false } = {}) => {
    const id = run.databaseId;
    let current = facts;
    for (let attempt = 1; ; attempt += 1) {
      const hook = failedHook(current.failure?.reason);
      if (hook && current.buildSha) {
        const main = mainSha();
        let before = null;
        let after = null;
        let changed = null;
        try { before = hookCommand(JSON.parse(readRemote(manifestPath, current.buildSha)), hook); } catch { /* unreadable: judged below */ }
        try { after = hookCommand(JSON.parse(readRemote(manifestPath, main)), hook); } catch { /* unreadable: not a difference we can show */ }
        try { changed = JSON.parse(gh(['api', `repos/${repo}/compare/${current.buildSha}...${main}`, '--jq', '[.files[].filename]']) || '[]'); } catch (error) { log(`SHIP_NOTE could not compare ${short(current.buildSha)}...${short(main)} (${error.message.split('\n')[0]}); rerunning`); }
        const frozen = frozenTools({ hook, before, after, changed });
        if (frozen) {
          return finish('RECOVERY_BLOCKED', `SHIP_RECOVERY_BLOCKED ${repo} ${current.version ?? '?'} run ${id}: hook ${hook} failed at ${short(current.buildSha)} and ${frozen.touched.join(', ')} changed on main since (${short(main)}), so a rerun would run the same tools again. Two ways on: (1) the hub's same-version recover with repaired tools (mobile-deploy-hub slice 2, not released yet), or (2) ship a new version that carries main's tools: mise run ship --abandon ${id}`, { run, facts: current });
        }
      }
      if (attempt > policy.reruns) {
        const owed = `gh run rerun ${id} --repo ${repo} --failed`;
        const why = current.failure ? `${current.failure.job} failed at ${current.failure.stage ?? '?'}: ${current.failure.reason ?? 'no reason'}` : 'it is red';
        return finish('RED', `SHIP_RED ${repo} ${current.version ?? '?'} run ${id} ${run.url}: ${why}; ${policy.reruns === 0 ? 'the policy allows no automatic rerun' : `still red after ${policy.reruns} automatic rerun${policy.reruns === 1 ? '' : 's'}`} (same version, same commit). Owed: ${owed}`, { run, facts: current });
      }
      let before = 1;
      try { before = Number(JSON.parse(gh(['api', `repos/${repo}/actions/runs/${id}`, '--jq', '{status,conclusion,run_attempt}'])).run_attempt) || 1; } catch { /* the rerun still happens */ }
      gh(['run', 'rerun', String(id), ...R, '--failed']);
      state.realDispatched = true;
      log(`SHIP_RERUN ${repo} run ${id} failed jobs re-run (${attempt}/${policy.reruns}; same version ${current.version ?? '?'}, same commit)`);
      // Wait for GitHub to start the new attempt, so the watch does not read the old attempt's verdict.
      let restarted = false;
      for (let tries = Math.max(1, Math.ceil(timeoutMs / Math.max(pollMs, 1))); tries > 0 && !restarted; tries -= 1) {
        await sleep(pollMs);
        try {
          const seen = JSON.parse(gh(['api', `repos/${repo}/actions/runs/${id}`, '--jq', '{status,conclusion,run_attempt}']));
          restarted = Number(seen.run_attempt) > before || seen.status !== 'completed';
        } catch { /* ask again */ }
      }
      if (!restarted) return finish('UNKNOWN', `SHIP_UNKNOWN ${repo} run ${id}: the rerun was asked for, but GitHub shows no new attempt within ${Math.round(timeoutMs / 1000)}s; look at ${run.url}`);
      const status = await watchRun(gh, id, R, { sleep, log, now, ...watch });
      if (status === unknownStatus) return finish('UNKNOWN', `SHIP_UNKNOWN ${repo} run ${id} ${run.url}: no verdict from GitHub on the rerun; finish by hand: ${finishByHand(id, R)}`);
      if (status === 0) return settle(run, completionOf(id), `, recovered by rerun ${attempt}`, older);
      current = inspect(id);
    }
  };

  // ---- 0. precheck: one real run at a time, and a red one that spent its version is recovered first
  const before = listRuns();
  const busy = before.filter(run => /\bREAL\b/.test(run.displayTitle ?? '') && run.status !== 'completed').sort((a, b) => b.databaseId - a.databaseId)[0];
  if (busy) return finish('BUSY', `SHIP_BUSY ${repo}: real run ${busy.databaseId} is ${busy.status} (${busy.url}); ship again when it ends: ${finishByHand(busy.databaseId, R)}`);
  const last = lastRealRun(before);
  if (last && last.status === 'completed' && last.conclusion !== 'success') {
    const ageDays = (now() - Date.parse(last.createdAt ?? '')) / 86_400_000;
    if (String(last.databaseId) === options.abandon) {
      log(`SHIP_ABANDON ${repo} run ${last.databaseId} is left as it is (--abandon); this ship is a new version`);
    } else if (!(ageDays < rerunWindowDays)) {
      log(`SHIP_NOTE ${repo} run ${last.databaseId} is red and ${Number.isFinite(ageDays) ? `${Math.floor(ageDays)} days old` : 'of unknown age'}, past the ${rerunWindowDays}-day window of its receipts and staging; this ship is a new version`);
    } else {
      const facts = inspect(last.databaseId);
      if (facts.bumped) {
        log(`SHIP_RECOVER ${repo} run ${last.databaseId} spent ${facts.version ?? 'its version'} and is red${facts.failure ? ` (${facts.failure.job} at ${facts.failure.stage ?? '?'}: ${facts.failure.reason ?? '-'})` : ''}: finishing that version first, no new bump`);
        try { return await recover(last, facts, { older: true }); } catch (error) {
          if (state.realDispatched) return finish('UNKNOWN', `SHIP_UNKNOWN ${repo} run ${last.databaseId}: ${error.message.split('\n')[0]}`);
          throw error;
        }
      }
      log(`SHIP_NOTE ${repo} run ${last.databaseId} is red before its bump (nothing was spent); this ship is a new version`);
    }
  }

  // A Mac that GitHub shows offline makes the gate skip the iPad lane; with lane_unavailable: refuse there is no point
  // in a dry run that would only prove it.
  const lanes = lanesFrom(workflowText, path => readRemote(path));
  if (lanes.ios && policy.laneUnavailable === 'refuse') {
    try {
      const runners = JSON.parse(gh(['api', `repos/${repo}/actions/runners`, '--jq', '[.runners[] | {name, status, labels: [.labels[].name]}]']) || '[]');
      const macs = runners.filter(runner => runner.labels.some(label => label.toLowerCase() === 'macos'));
      // Only a Mac runner GitHub lists for this repository and shows offline is proof; none listed may be an
      // organisation's runner this call cannot see, so the gate decides.
      if (macs.length > 0 && !macs.some(runner => runner.status === 'online')) {
        return finish('BLOCKED', `SHIP_BLOCKED ${repo}: the Mac runner (${macs.map(runner => runner.name).join(', ')}) is offline, so the iPad lane would not run and the iPad (and TestFlight, for a store app) would be owed; bring the Mac online and ship again. No version was spent`);
      }
      if (macs.length === 0) log(`SHIP_NOTE ${repo} lists no macOS runner of its own; the gate decides the iPad lane`);
    } catch (error) {
      log(`SHIP_NOTE could not read the runners of ${repo} (${error.message.split('\n')[0]}); the gate decides the iPad lane`);
    }
  }

  // One dispatch on main, the run it started, and its verdict.
  const dispatchAndWatch = async ({ dryRun, sha }) => {
    const after = newestId(listRuns());
    log(`SHIP_DISPATCH ${repo} ${dryRun ? 'dry run (dry_handoff)' : 'REAL run'} bump=${options.bump} metered=${options.metered} main=${short(sha)} hub=${hubRef} (TestFlight: caller opt-in or explicit completion policy)`);
    gh(dispatchArguments({ workflow: options.workflow, dryRun, bump: options.bump, platform: 'both', testflight: false, play: false, dryHandoff: dryRun, metered: options.metered, repo }));
    if (!dryRun) state.realDispatched = true;
    let started = [];
    for (let tries = Math.max(1, Math.ceil(timeoutMs / Math.max(pollMs, 1))); tries > 0 && started.length === 0; tries -= 1) {
      await sleep(pollMs);
      started = newRuns(listRuns(), { after, sha });
    }
    if (started.length === 0) throw new Error(`no new ${options.workflow} run on ${short(sha)} appeared within ${Math.round(timeoutMs / 1000)}s of the ${dryRun ? 'dry' : 'real'} dispatch (did main move?); look at the Actions tab`);
    if (started.length > 1) throw new Error(`more than one new run started (${started.map(run => run.url).join(', ')}); another dispatch raced this one`);
    const [run] = started;
    log(`SHIP_RUN ${run.databaseId} ${dryRun ? 'dry run' : 'real run'} ${run.url}`);
    const status = await watchRun(gh, run.databaseId, R, { sleep, log, now, ...watch });
    log(verdictLine(status, run.databaseId, dryRun ? 'dry run' : 'real run', run.url, R));
    return { run, status };
  };

  try {
    // ---- 1. dry: the whole run on main's tip with the Mac handoff, nothing spent; again if main moves before the real run
    let sha = mainSha();
    for (let round = 1; ; round += 1) {
      const dry = await dispatchAndWatch({ dryRun: true, sha });
      const id = dry.run.databaseId;
      if (dry.status === unknownStatus) return finish('UNKNOWN', `SHIP_UNKNOWN ${repo} dry run ${id} ${dry.run.url}: no verdict from GitHub; no version was spent. Finish by hand: ${finishByHand(id, R)}`);
      const proof = completionOf(id);
      if (dry.status !== 0) return finish('RED', `SHIP_RED stage=dry ${repo} run ${id} ${dry.run.url}: ${proof?.failure ? `${proof.failure.job} failed at ${proof.failure.stage}: ${proof.failure.reason}` : 'the dry run is red'}; no version was spent`, { run: dry.run, completion: proof });
      if (!proof) return finish('UNKNOWN', `SHIP_UNKNOWN ${repo} dry run ${id} ${dry.run.url}: green, but its completion verdict could not be read (gh run download ${id} --repo ${repo} -n completion-out); no version was spent`);
      if (proof.verdict !== 'COMPLETE') {
        const owed = (proof.owed ?? []).map(item => `${item.target} ${item.status}: ${item.why} (${item.command})`).join('; ');
        return finish('BLOCKED', `SHIP_BLOCKED ${repo} dry run ${id}: a real run would leave required targets owed: ${owed || proof.summary}. No version was spent`, { run: dry.run, completion: proof });
      }
      const tip = mainSha();
      if (tip === sha) break;
      if (round >= 3) return finish('BLOCKED', `SHIP_BLOCKED ${repo}: main moved during each of ${round} dry runs (now ${short(tip)}); ship again when it settles. No version was spent`);
      log(`SHIP_REDRY main moved from ${short(sha)} to ${short(tip)} after dry run ${id}; the real run builds only a proven commit, so it is proved again`);
      sha = tip;
    }

    // ---- 2. real, on the commit the dry run proved
    const real = await dispatchAndWatch({ dryRun: false, sha });
    const id = real.run.databaseId;
    if (real.status === unknownStatus) return finish('UNKNOWN', `SHIP_UNKNOWN ${repo} real run ${id} ${real.run.url}: no verdict from GitHub, so this is neither shipped nor red; finish by hand: ${finishByHand(id, R)}`);
    if (real.status === 0) return settle(real.run, completionOf(id));
    const facts = inspect(id);
    if (facts.completion?.blocked) return finish('BLOCKED', `SHIP_BLOCKED ${repo} real run ${id}: the gate refused it (${facts.failure?.reason ?? 'a required lane would not run'}). No version was spent`, { run: real.run, completion: facts.completion });
    if (!facts.bumped) return finish('RED', `SHIP_RED ${repo} real run ${id} ${real.run.url}: ${facts.failure ? `${facts.failure.job} failed at ${facts.failure.stage ?? '?'}: ${facts.failure.reason ?? '-'}` : 'it is red'}, before the bump; no version was spent`, { run: real.run, completion: facts.completion });
    log(`SHIP_RECOVER ${repo} real run ${id} spent ${facts.version ?? 'its version'} and is red: recovering it`);
    return await recover(real.run, facts);
  } catch (error) {
    if (state.realDispatched) return finish('UNKNOWN', `SHIP_UNKNOWN ${repo}: ${error.message.split('\n')[0]}; a real run may be in flight, look at the Actions tab before shipping again`);
    throw error;
  }
}

// gh and git as child processes: stdout back, and a throw with the tail of stderr.
export function realGh(args) {
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
    const result = options.mode === 'train' ? await deployTrain(options, deps) : options.mode === 'ship' ? await ship(options, deps) : await deploy(options, deps);
    process.exitCode = result.status ?? 0;
  } catch (error) {
    console.error(`::error::${error.message}`);
    process.exitCode = 1;
  }
}
