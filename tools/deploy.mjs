#!/usr/bin/env node
// The front door for every app: `mise run deploy` in Tower, Green In Between and Gruvato fetches THIS file with
// `gh api` at the hub ref named in the app's deploy.yml `uses:` line and runs it, so all three deploy the same way.
// Self-contained on purpose (node builtins only): it runs from a temp folder.
//
//   node deploy.mjs [--dry-run true|false] [--bump patch|minor|major] [--platform both|android|ios]
//                   [--testflight true|false] [--play true|false] [--dry-handoff true|false]
//                   [--workflow deploy.yml] [--hub-ref REF] [--print]
//
// A dry run is the default. It dispatches the app's deploy.yml on main, watches only the run it started, and after
// a green real run pulls the bump commit (`git pull --ff-only`). Before a real run it checks what would make the
// run fail late or burn a version for nothing: an offline Mac runner, a red previous real run (offered a
// "re-run failed jobs" instead), and, for the iPad, that a dry run already built and checked this app's IPA.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, hostname, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

export const platforms = Object.freeze(['both', 'android', 'ios']);
// The S26 as tools/ci/devices.json names it (a hub test keeps the two equal). The Android lanes run on big-chungus,
// whose adb server holds the phone's wireless pairing.
export const phone = Object.freeze({ serial: 'R5GL43A7PCH', model: 'SM-S948U', host: 'big-chungus' });
const wirelessHint = 'Turn on Wireless debugging on the S26 (the quick-settings tile; it turns itself off after a reboot or a Wi-Fi change), then run again';
// Every deploy bumps (patch unless told otherwise). There is no "none": a deploy that failed after its bump is
// finished with `gh run rerun <id> --failed`, which keeps the version and the commit.
export const levels = Object.freeze(['patch', 'minor', 'major']);
const usage = 'Usage: deploy.mjs [--dry-run true|false] [--bump patch|minor|major] [--platform both|android|ios] [--testflight true|false] [--play true|false] [--dry-handoff true|false] [--workflow deploy.yml] [--hub-ref REF] [--print]';

function flag(name, value, fallback) {
  if (value === undefined || value === '') return fallback;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`${name} must be true or false, got "${value}"`);
}

// mise passes every flag, with "" for the ones left unset, so blank means the default.
export function parseArguments(argv) {
  const known = ['--dry-run', '--bump', '--platform', '--testflight', '--play', '--dry-handoff', '--workflow', '--hub-ref'];
  const values = {};
  let print = false;
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (name === '--print') { print = true; continue; }
    if (!known.includes(name)) throw new Error(`Unknown option ${name}. ${usage}`);
    if (argv[index + 1] === undefined) throw new Error(`${name} needs a value`);
    values[name] = argv[index + 1];
    index += 1;
  }
  const platform = values['--platform'] || 'both';
  if (!platforms.includes(platform)) throw new Error(`platform must be one of ${platforms.join(', ')}, got "${platform}"`);
  const bump = values['--bump'] || 'patch';
  if (!levels.includes(bump)) throw new Error(`bump must be one of ${levels.join(', ')}, got "${bump}"`);
  const workflow = values['--workflow'] || 'deploy.yml';
  if (!/^[\w.-]+\.ya?ml$/.test(workflow)) throw new Error(`workflow must be a file name in .github/workflows, got "${workflow}"`);
  const hubRef = values['--hub-ref'] ?? '';
  if (hubRef !== '' && !/^[\w./-]+$/.test(hubRef)) throw new Error(`hub ref "${hubRef}" is not a ref`);
  return {
    dryRun: flag('dry-run', values['--dry-run'], true),
    bump,
    bumpGiven: Boolean(values['--bump']),
    platform,
    testflight: flag('testflight', values['--testflight'], false),
    play: flag('play', values['--play'], false),
    dryHandoff: flag('dry-handoff', values['--dry-handoff'], false),
    workflow,
    hubRef,
    print,
  };
}

export function dispatchArguments({ workflow, dryRun, bump, platform, testflight, play, dryHandoff }) {
  return [
    'workflow', 'run', workflow, '--ref', 'main',
    '-f', `platform=${platform}`,
    '-f', `dry_run=${dryRun}`,
    '-f', `bump=${bump}`,
    '-f', `testflight=${testflight}`,
    '-f', `play=${play}`,
    '-f', `dry_handoff=${dryHandoff}`,
  ];
}

// The runs a dispatch of ours can have started: newer than the newest run recorded before it, on the sha we meant.
export function newRuns(runs, { after, sha }) {
  return runs
    .filter(run => run.event === 'workflow_dispatch' && run.databaseId > after && run.headSha === sha)
    .sort((a, b) => a.databaseId - b.databaseId);
}

export const newestId = runs => runs.reduce((newest, run) => Math.max(newest, run.databaseId), 0);

// The hub ref an app pins, read from its caller's `uses:` line.
export function hubRefFrom(workflowText) {
  return /uses:\s*delorenj\/mobile-deploy-hub\/\.github\/workflows\/mobile-deploy\.yml@([\w./-]+)/.exec(workflowText ?? '')?.[1] ?? null;
}

// The caller's run-name puts REAL in a real run's title, which is how a later deploy can tell the two apart.
export const lastRealRun = runs => runs.filter(run => /\bREAL\b/.test(run.displayTitle ?? '')).sort((a, b) => b.databaseId - a.databaseId)[0] ?? null;

// Proof that this app's iPad build was built and checked by a dry run at this hub ref, recorded after a green dry run.
export const ledgerPath = (home = homedir()) => join(home, '.local/state/mobile-deploy-hub/ipad-proofs.json');

export function readLedger(path) {
  try { const ledger = JSON.parse(readFileSync(path, 'utf8')); return ledger && typeof ledger === 'object' ? ledger : {}; } catch { return {}; }
}

export function recordProof(path, repo, proof) {
  const ledger = readLedger(path);
  ledger[repo] = { ...(ledger[repo] ?? {}), [proof.hub_ref]: proof };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(ledger, null, 2)}\n`);
}

export const proofFor = (ledger, repo, hubRef) => ledger?.[repo]?.[hubRef] ?? null;

const listFields = 'databaseId,headSha,event,status,conclusion,createdAt,url,displayTitle';

// On big-chungus, look for the S26 before dispatching: without it the run's plan job fails anyway (before any bump),
// just later. Elsewhere this host's adb says nothing about big-chungus's, so the check is skipped.
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

export async function deploy(options, {
  gh, git, adb = null, host = hostname(), prompt = null, home = homedir(), cwd = process.cwd(),
  sleep = ms => new Promise(done => setTimeout(done, ms)), log = console.log, timeoutMs = 120_000, pollMs = 3000,
}) {
  const dispatch = dispatchArguments(options);
  if (options.print) {
    log(`gh ${dispatch.join(' ')}`);
    return { printed: true };
  }
  const runs = () => JSON.parse(gh(['run', 'list', '--workflow', options.workflow, '--event', 'workflow_dispatch', '--limit', '30', '--json', listFields]) || '[]');
  const repo = gh(['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner']).trim();

  // The hub deploys main as GitHub has it (and bumps on its newest tip), so a local checkout elsewhere only means
  // this machine is behind or ahead: worth a warning, not a stop.
  const sha = gh(['api', 'repos/{owner}/{repo}/commits/main', '--jq', '.sha']).trim();
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`could not read main from GitHub (got "${sha.slice(0, 60)}")`);
  let head = '';
  try { head = git(['rev-parse', 'HEAD']).trim(); } catch { /* not a checkout */ }
  if (head !== sha) log(`DEPLOY_WARNING local HEAD ${head.slice(0, 8) || '-'} is not main on GitHub (${sha.slice(0, 8)}); the deploy builds main, not this checkout`);

  const ios = options.platform !== 'android';
  if (ios) {
    let macs = null;
    try {
      const runners = JSON.parse(gh(['api', 'repos/{owner}/{repo}/actions/runners', '--jq', '[.runners[] | {name, status, labels: [.labels[].name]}]']) || '[]');
      macs = runners.filter(runner => runner.labels.some(label => label.toLowerCase() === 'macos'));
    } catch (error) {
      log(`DEPLOY_WARNING could not read the runners of ${repo} (${error.message.split('\n')[0]}); not checking the Mac`);
    }
    if (macs && macs.length === 0) throw new Error(`${repo} has no macOS runner registered; the iPad lane cannot run. Deploy with --platform android`);
    if (macs && !macs.some(runner => runner.status === 'online')) throw new Error(`the Mac runner of ${repo} (${macs.map(runner => runner.name).join(', ')}) is offline: log in on the Mac (runners start at login), or deploy with --platform android`);
  }

  if (options.platform !== 'ios' && adb && host === phone.host) {
    const seen = await checkPhone({ adb, log, sleep });
    if (!seen.found) {
      if (!options.dryRun) throw new Error(`${seen.why}. ${wirelessHint}`);
      log(`DEPLOY_WARNING ${seen.why}; this dry run's plan job will fail at the S26 check. ${wirelessHint}`);
    }
  }

  const before = runs();
  if (!options.dryRun) {
    const last = lastRealRun(before);
    if (last && last.status === 'completed' && last.conclusion !== 'success') {
      log(`DEPLOY_LAST_REAL_RED ${last.databaseId} ${last.conclusion} ${last.url}`);
      const rerun = prompt ? /^y(es)?$/i.test((await prompt(`The last real deploy (${last.url}) is red. Re-run its failed jobs instead of a new deploy? [y/N] `)).trim()) : false;
      if (rerun) {
        gh(['run', 'rerun', String(last.databaseId), '--failed']);
        log(`DEPLOY_RERUN ${last.databaseId} failed jobs re-run (same version, same commit)`);
        await sleep(pollMs);
        const status = gh(['run', 'watch', String(last.databaseId), '--exit-status'], { inherit: true });
        log(`${status === 0 ? 'DEPLOY_GREEN' : 'DEPLOY_RED'} run ${last.databaseId} rerun ${last.url}`);
        return { run: last, status, rerun: true };
      }
      if (!options.bumpGiven) throw new Error(`the last real deploy ${last.url} is red, so a new version could leave the S26 and the iPad on different versions. Finish it: gh run rerun ${last.databaseId} --failed (same version, same commit, while its artifacts last: 7 days), or pass --bump patch to deploy a new version anyway`);
    }
  }

  let hubRef = options.hubRef;
  if (!hubRef) {
    try { hubRef = hubRefFrom(readFileSync(join(cwd, '.github/workflows', options.workflow), 'utf8')); } catch { hubRef = null; }
  }
  const ledger = ledgerPath(home);
  if (!options.dryRun && ios) {
    if (!hubRef) throw new Error(`cannot find the mobile-deploy-hub ref in .github/workflows/${options.workflow}`);
    if (!proofFor(readLedger(ledger), repo, hubRef)) throw new Error(`no dry run has built and checked ${repo}'s iPad IPA at hub ${hubRef} yet (proof ledger ${ledger}). Run \`mise run deploy --dry-handoff true\` first; a green one records the proof`);
  }

  const after = newestId(before);
  log(`DEPLOY_DISPATCH ${options.dryRun ? 'dry run' : 'REAL run'} bump=${options.bump} platform=${options.platform}${options.testflight ? ' testflight' : ''}${options.play ? ' play' : ''}${options.dryHandoff ? ' dry_handoff' : ''} main=${sha.slice(0, 8)} (newest earlier run: ${after || 'none'})`);
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
  const status = gh(['run', 'watch', String(run.databaseId), '--exit-status'], { inherit: true });
  const verdict = status === 0 ? 'DEPLOY_GREEN' : 'DEPLOY_RED';
  log(`${verdict} run ${run.databaseId} ${options.dryRun ? 'dry run' : 'real run'} ${run.url}`);

  if (status === 0 && options.dryRun && ios) {
    const dir = mkdtempSync(join(tmpdir(), 'deploy-receipts-'));
    try {
      gh(['run', 'download', String(run.databaseId), '-n', 'ios-out', '-D', dir]);
      const file = readdirSync(dir).find(name => name === 'hub-receipt-ios.json');
      const receipt = file ? JSON.parse(readFileSync(join(dir, file), 'utf8')) : null;
      if (receipt?.ipa?.verified === true && receipt.dry_run === true) {
        recordProof(ledger, repo, { run: run.databaseId, sha, hub_ref: receipt.hub_ref ?? hubRef, at: new Date().toISOString() });
        log(`DEPLOY_PROOF iPad IPA built and checked; recorded for ${repo} at hub ${receipt.hub_ref ?? hubRef}`);
      } else {
        log('DEPLOY_NOTE the iPad IPA was not built in this dry run (pass --dry-handoff true for an app whose Xcode project comes from Linux); no proof recorded');
      }
    } catch (error) {
      log(`DEPLOY_WARNING could not read the ios-out receipt (${error.message.split('\n')[0]}); no proof recorded`);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
  if (status === 0 && !options.dryRun) {
    try {
      if (git(['rev-parse', '--abbrev-ref', 'HEAD']).trim() === 'main') {
        git(['pull', '--ff-only', 'origin', 'main']);
        log('DEPLOY_PULLED the bump commit (git pull --ff-only)');
      } else {
        log('DEPLOY_NOTE this checkout is not on main; pull the bump commit there: git pull --ff-only');
      }
    } catch (error) {
      log(`DEPLOY_WARNING git pull --ff-only failed (${error.message.split('\n')[0]}); pull the bump commit by hand`);
    }
  }
  return { run, status };
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

export function realGit(args) {
  const result = spawnSync('git', args, { encoding: 'utf8' });
  if (result.error || result.status !== 0) throw new Error(`git ${args[0]} failed: ${result.error?.message ?? result.stderr.trim().slice(-400)}`);
  return result.stdout;
}

async function terminalPrompt(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try { return await rl.question(question); } finally { rl.close(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await deploy(parseArguments(process.argv.slice(2)), { gh: realGh, git: realGit, adb: realAdb, prompt: process.stdin.isTTY ? terminalPrompt : null });
    process.exitCode = result.status ?? 0;
  } catch (error) {
    console.error(`::error::${error.message}`);
    process.exitCode = 1;
  }
}
