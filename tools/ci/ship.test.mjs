// `ship` (hub v1.3, TOWE-76): the one command, driven through a fake gh that keeps a little GitHub (runs, attempts,
// artifacts, the app's files, compare). Nothing is dispatched for real. Every branch of the state machine: busy, dry
// red, the Mac unavailable (runner, dry verdict, real gate), complete, incomplete, red -> rerun -> complete, a red last
// real run recovered first (no terminal needed), frozen tools blocked, reruns exhausted, unknown, main moving.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { failedHook, frozenTools, hookScripts, parseArguments, ship, shipExit } from '../deploy.mjs';
import { policyFile } from './lib/policy.mjs';

const repo = 'delorenj/tower-of-lost-things';
const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const C = '3832680b'.padEnd(40, 'c');
const policyText = readFileSync(policyFile, 'utf8');
// The old ship contract remains testable without activating it in the released policy.
const strictPolicyText = JSON.stringify({ ...JSON.parse(policyText), completion: { required: { devices: 'lanes', testflight: 'store' }, lane_unavailable: 'refuse', reruns: 1 } });
const workflowText = '    uses: delorenj/mobile-deploy-hub/.github/workflows/mobile-deploy.yml@v1\n    with:\n      manifest: tools/ci/mobile-deploy.json\n';
const appManifest = upload => ({ schema: 2, android: {}, ios: { store: { upload, assign: 'node tools/testflight.mjs assign "$HUB_OUT/ios/testflight-export.json"' } } });

// A completion-out as announce writes it.
const verdict = (kind, extra = {}) => ({
  schema: 1, verdict: kind, dry_run: false, repo, slug: 'tower-of-lost-things', version: '0.3.20', commit: A, bumped: kind !== 'RED' || extra.bumped !== false, blocked: false, failure: null, targets: [], owed: [],
  summary: `tower-of-lost-things 0.3.20 (25): ${kind === 'COMPLETE' ? 'S26 installed, iPad pending (durable), TestFlight assigned' : 'S26 installed, iPad skipped, TestFlight missing; owed iPad: mise run ship; TestFlight: mise run ship'}`,
  ...extra,
});
const dryOk = () => ({ conclusion: 'success', completion: verdict('COMPLETE', { dry_run: true, bumped: false }) });

function world({ main = A, runs = [], outcomes = [], runners = [{ name: 'carries-macbook-air', status: 'online', labels: ['self-hosted', 'macOS'] }], files = {}, compare = [], policy = strictPolicyText } = {}) {
  let clock = Date.parse('2026-11-02T20:00:00Z');
  let nextId = 41_600_000_000;
  const state = { main, runs: runs.map(run => ({ run_attempt: 1, event: 'workflow_dispatch', url: `https://github.com/${repo}/actions/runs/${run.databaseId}`, ...run })), calls: [], dispatched: [], reruns: [], pulls: 0 };
  const byId = id => state.runs.find(run => run.databaseId === Number(id));
  const appFiles = { '.github/workflows/deploy.yml': workflowText, 'tools/ci/mobile-deploy.json': JSON.stringify({ schema: 2, android: {}, ios: {} }), ...files };
  const gh = args => {
    state.calls.push(args.join(' '));
    const [verb, sub] = args;
    if (verb === 'repo') return `${repo}\n`;
    if (verb === 'run' && sub === 'list') return JSON.stringify(state.runs.map(({ databaseId, headSha, event, status, conclusion, createdAt, url, displayTitle }) => ({ databaseId, headSha, event, status, conclusion, createdAt, url, displayTitle })));
    if (verb === 'workflow' && sub === 'run') {
      const dry = args.includes('dry_run=true');
      const outcome = outcomes.shift() ?? { conclusion: 'success', completion: verdict('COMPLETE') };
      nextId += 1;
      state.runs.push({ databaseId: nextId, headSha: state.main, event: 'workflow_dispatch', status: 'queued', conclusion: null, createdAt: new Date(clock).toISOString(), url: `https://github.com/${repo}/actions/runs/${nextId}`, displayTitle: dry ? 'Deploy (dry run) both bump=patch' : 'Deploy REAL both bump=patch', run_attempt: 1, outcome, reruns: outcome.reruns ?? [] });
      state.dispatched.push({ kind: dry ? 'dry' : 'real', sha: state.main, args: args.join(' ') });
      outcome.onDispatch?.(state);
      return '';
    }
    if (verb === 'run' && sub === 'rerun') {
      const run = byId(args[2]);
      state.reruns.push(run.databaseId);
      run.outcome = run.reruns.shift() ?? { conclusion: 'failure' };
      run.run_attempt += 1;
      run.status = 'queued';
      run.conclusion = null;
      return '';
    }
    if (verb === 'run' && sub === 'download') {
      const run = byId(args[2]);
      const name = args[args.indexOf('-n') + 1];
      const dir = args[args.indexOf('-D') + 1];
      const artifacts = { ...(run.outcome?.artifacts ?? run.artifacts ?? {}), ...(run.outcome?.completion ? { 'completion-out': { 'completion.json': run.outcome.completion } } : {}) };
      if (!artifacts[name]) throw new Error('gh run download failed: no valid artifacts found to download');
      for (const [file, content] of Object.entries(artifacts[name])) writeFileSync(join(dir, file), typeof content === 'string' ? content : JSON.stringify(content));
      return '';
    }
    if (verb === 'api') {
      const path = args.find(arg => /^repos\//.test(arg)) ?? '';
      if (path.endsWith('/commits/main')) return `${state.main}\n`;
      if (path.endsWith('/actions/runners')) return JSON.stringify(runners);
      if (path.startsWith('repos/delorenj/mobile-deploy-hub/contents/tools/ci/policy.json')) { if (policy === null) throw new Error('HTTP 404'); return policy; }
      const content = /\/contents\/(.+)\?ref=(.+)$/.exec(path);
      if (content) { const found = appFiles[`${content[2]}:${content[1]}`] ?? appFiles[content[1]]; if (found === undefined) throw new Error('gh api failed: HTTP 404'); return typeof found === 'string' ? found : JSON.stringify(found); }
      if (/\/compare\//.test(path)) return JSON.stringify(compare);
      const runPath = /\/actions\/runs\/(\d+)(\/jobs)?/.exec(path);
      if (runPath?.[2]) return JSON.stringify(byId(runPath[1]).jobs ?? []);
      if (runPath) {
        const run = byId(runPath[1]);
        if (run.status !== 'completed' && run.outcome?.conclusion) Object.assign(run, { status: 'completed', conclusion: run.outcome.conclusion });
        else if (run.status === 'queued') run.status = 'in_progress';
        return JSON.stringify({ status: run.status, conclusion: run.conclusion, run_attempt: run.run_attempt });
      }
    }
    throw new Error(`unexpected gh ${args.join(' ')}`);
  };
  const git = args => { if (args[0] === 'pull') state.pulls += 1; return args[0] === 'rev-parse' ? 'main\n' : ''; };
  const logs = [];
  const deps = { gh, git, log: line => logs.push(line), sleep: async ms => { clock += ms; }, now: () => clock, timeoutMs: 30_000, pollMs: 1000, watch: { capMs: 3_600_000 } };
  const go = (flags = []) => ship(parseArguments(['ship', '--repo', repo, ...flags]), deps);
  const last = () => logs.at(-1);
  return { state, logs, go, last, clock: () => clock };
}

// A red real run of an older hub (no completion-out): what 0.3.19 (41445863722) left behind.
const redOldRun = ({ id = 41_445_863_722, createdAt = '2026-11-02T12:34:00Z', ios = { lane: 'ios', outcome: 'failure', stage: 'deliver', reason: 'hook ios.store.upload failed (exit 1)' }, reruns = [] } = {}) => ({
  databaseId: id, headSha: '7ba686a4'.padEnd(40, '0'), status: 'completed', conclusion: 'failure', createdAt, displayTitle: 'Deploy REAL both bump=patch',
  jobs: [{ name: 'deploy / gate', conclusion: 'success' }, { name: 'deploy / plan', conclusion: 'success' }, { name: 'deploy / ios', conclusion: 'failure' }],
  artifacts: { 'plan-out': { 'hub-receipt-plan.json': { lane: 'plan', outcome: 'success', version: '0.3.19', sha: C, bump: { committed: true, to: '0.3.19' } } }, 'ios-out': { 'hub-receipt-ios.json': ios } },
  reruns,
});

test('ship takes no narrowing: --platform, --testflight, --dry-run, --play and --dry-handoff are refused; blanks from mise are fine', () => {
  for (const [flag, value] of [['--platform', 'android'], ['--testflight', 'false'], ['--dry-run', 'false'], ['--play', 'true'], ['--dry-handoff', 'false']]) {
    assert.throws(() => parseArguments(['ship', flag, value]), /ship takes no --[\w-]+: it never narrows/, flag);
  }
  assert.throws(() => parseArguments(['ship', '--print']), /ship takes no --print/);
  assert.deepEqual(parseArguments(['ship', '--bump', '', '--metered', 'auto', '--abandon', '', '--hub-ref', 'v1']).mode, 'ship');
  assert.throws(() => parseArguments(['--abandon', '12']), /--abandon is a ship option/);
  assert.throws(() => parseArguments(['ship', '--abandon', 'last']), /--abandon takes the red real run's id/);
  assert.deepEqual(shipExit, { COMPLETE: 0, RED: 1, UNKNOWN: 3, INCOMPLETE: 4, RECOVERY_BLOCKED: 4, BUSY: 5, BLOCKED: 5 });
});

test('a real run already queued or in progress: SHIP_BUSY (5), nothing dispatched', async () => {
  const w = world({ runs: [{ databaseId: 9, headSha: A, status: 'in_progress', conclusion: null, createdAt: '2026-11-02T19:00:00Z', displayTitle: 'Deploy REAL both bump=patch' }] });
  const result = await w.go();
  assert.equal(result.status, 5);
  assert.match(w.last(), /^SHIP_BUSY delorenj\/tower-of-lost-things: real run 9 is in_progress .*gh run watch 9 --repo delorenj\/tower-of-lost-things --interval 30 --exit-status$/);
  assert.deepEqual(w.state.dispatched, []);
});

test('complete: a dry run with the Mac handoff, then the real run on the same commit, then SHIP_COMPLETE (0) and the pull', async () => {
  const w = world({ outcomes: [dryOk(), { conclusion: 'success', completion: verdict('COMPLETE') }] });
  const result = await w.go(['--bump', 'minor']);
  assert.equal(result.status, 0);
  assert.deepEqual(w.state.dispatched.map(d => [d.kind, d.sha]), [['dry', A], ['real', A]]);
  assert.match(w.state.dispatched[0].args, /-f platform=both -f dry_run=true -f bump=minor .*-f dry_handoff=true -f metered=auto$/);
  assert.match(w.state.dispatched[1].args, /-f platform=both -f dry_run=false -f bump=minor .*-f dry_handoff=false/);
  assert.match(w.last(), /^SHIP_COMPLETE tower-of-lost-things 0\.3\.20 \(25\): S26 installed, iPad pending \(durable\), TestFlight assigned \(run \d+\)$/);
  assert.equal(w.state.pulls, 1);
  assert.ok(w.state.calls.some(call => /^run download \d+ --repo delorenj\/tower-of-lost-things -n completion-out -D /.test(call)), 'the verdict comes from the run\'s completion-out');
});

test('incomplete: a green real run that owes a target is SHIP_INCOMPLETE (4) with the owed command, never shipped', async () => {
  const w = world({ outcomes: [dryOk(), { conclusion: 'success', completion: verdict('INCOMPLETE') }] });
  const result = await w.go();
  assert.equal(result.status, 4);
  assert.match(w.last(), /^SHIP_INCOMPLETE tower-of-lost-things 0\.3\.20 \(25\): .*owed iPad: mise run ship; TestFlight: mise run ship \(run \d+\)$/);
  assert.equal(w.state.pulls, 1, 'the version was bumped: its commit is pulled');
});

test('a red dry run is SHIP_RED stage=dry (1): no real run, no version spent', async () => {
  const w = world({ outcomes: [{ conclusion: 'failure', completion: verdict('RED', { dry_run: true, bumped: false, failure: { job: 'preflight-ios', stage: 'preflight', reason: 'hook ios.store.preflight failed (exit 1)' } }) }] });
  const result = await w.go();
  assert.equal(result.status, 1);
  assert.match(w.last(), /^SHIP_RED stage=dry delorenj\/tower-of-lost-things run \d+ \S+: preflight-ios failed at preflight: hook ios\.store\.preflight failed \(exit 1\); no version was spent$/);
  assert.deepEqual(w.state.dispatched.map(d => d.kind), ['dry']);
});

test('the Mac unavailable stops ship before a version is spent: GitHub shows it offline, the dry run cannot reach it, or the real gate refuses', async () => {
  const offline = world({ runners: [{ name: 'carries-macbook-air', status: 'offline', labels: ['self-hosted', 'macOS'] }] });
  assert.equal((await offline.go()).status, 5);
  assert.match(offline.last(), /^SHIP_BLOCKED delorenj\/tower-of-lost-things: the Mac runner \(carries-macbook-air\) is offline, .*No version was spent$/);
  assert.deepEqual(offline.state.dispatched, [], 'not even a dry run');
  const orgRunner = world({ runners: [], outcomes: [dryOk(), { conclusion: 'success', completion: verdict('COMPLETE') }] });
  assert.equal((await orgRunner.go()).status, 0, 'no Mac runner listed (an organisation runner) is not proof: the gate decides');
  assert.ok(orgRunner.logs.some(line => /^SHIP_NOTE .*lists no macOS runner of its own; the gate decides/.test(line)));

  const skipped = verdict('INCOMPLETE', { dry_run: true, bumped: false, ios_lane: 'skip-metered', owed: [{ target: 'iPad', status: 'skipped', why: 'the Mac was on a metered link and the iPad build would have gone over its data budget', command: 'mise run ship --metered allow' }, { target: 'TestFlight', status: 'skipped', why: 'the Mac was on a metered link', command: 'mise run ship --metered allow' }] });
  const metered = world({ outcomes: [{ conclusion: 'success', completion: skipped }] });
  assert.equal((await metered.go()).status, 5);
  assert.match(metered.last(), /^SHIP_BLOCKED delorenj\/tower-of-lost-things dry run \d+: a real run would leave required targets owed: iPad skipped: .*\(mise run ship --metered allow\); TestFlight .*No version was spent$/);
  assert.deepEqual(metered.state.dispatched.map(d => d.kind), ['dry']);

  const refused = verdict('RED', { bumped: false, blocked: true, failure: { job: 'gate', stage: 'preflight', reason: 'HUB_GATE_REFUSED lane_unavailable: the Mac is offline (tailscale), so the iPad and TestFlight would not be delivered' } });
  const late = world({ outcomes: [dryOk(), { conclusion: 'failure', completion: refused }] });
  assert.equal((await late.go()).status, 5);
  assert.match(late.last(), /^SHIP_BLOCKED delorenj\/tower-of-lost-things real run \d+: the gate refused it \(HUB_GATE_REFUSED lane_unavailable: the Mac is offline .*\)\. No version was spent$/);
  assert.deepEqual(late.state.reruns, [], 'a refusal is never rerun');
});

test('red after the bump -> rerun (same version) -> complete; reruns are capped by the policy', async () => {
  const red = verdict('RED', { bumped: true, failure: { job: 'ios', stage: 'build', reason: 'rsync IPA to big-chungus failed (exit 255)' } });
  const w = world({ outcomes: [dryOk(), { conclusion: 'failure', completion: red, reruns: [{ conclusion: 'success', completion: verdict('COMPLETE') }] }] });
  const result = await w.go();
  assert.equal(result.status, 0);
  assert.equal(w.state.reruns.length, 1);
  assert.ok(w.logs.some(line => /^SHIP_RERUN delorenj\/tower-of-lost-things run \d+ failed jobs re-run \(1\/1; same version 0\.3\.20, same commit\)$/.test(line)), w.logs.join('\n'));
  assert.match(w.last(), /^SHIP_COMPLETE .*recovered by rerun 1\)$/);
  assert.deepEqual(w.state.dispatched.map(d => d.kind), ['dry', 'real'], 'never a second bump');

  const stubborn = world({ outcomes: [dryOk(), { conclusion: 'failure', completion: red, reruns: [{ conclusion: 'failure', completion: red }] }] });
  assert.equal((await stubborn.go()).status, 1);
  assert.match(stubborn.last(), /^SHIP_RED delorenj\/tower-of-lost-things 0\.3\.20 run (\d+) \S+: ios failed at build: rsync IPA .*still red after 1 automatic rerun \(same version, same commit\)\. Owed: gh run rerun \1 --repo delorenj\/tower-of-lost-things --failed$/);
  assert.equal(stubborn.state.reruns.length, 1, 'policy completion.reruns is 1');

  const none = world({ policy: JSON.stringify({ ...JSON.parse(strictPolicyText), completion: { ...JSON.parse(strictPolicyText).completion, reruns: 0 } }), outcomes: [dryOk(), { conclusion: 'failure', completion: red }] });
  assert.equal((await none.go()).status, 1);
  assert.match(none.last(), /the policy allows no automatic rerun/);
  assert.deepEqual(none.state.reruns, []);
});

test('a red real run before the bump is SHIP_RED with nothing spent, and is never rerun', async () => {
  const w = world({ outcomes: [dryOk(), { conclusion: 'failure', completion: verdict('RED', { bumped: false, failure: { job: 'plan', stage: 'preflight', reason: 'HUB_PLAN_REFUSED planned code 25 is not above the published 25' } }) }] });
  assert.equal((await w.go()).status, 1);
  assert.match(w.last(), /^SHIP_RED .*plan failed at preflight: HUB_PLAN_REFUSED .*before the bump; no version was spent$/);
  assert.deepEqual(w.state.reruns, []);
});

test('a red last real run that spent its version is recovered first, with no terminal and no prompt, and nothing new is bumped', async () => {
  const w = world({ runs: [redOldRun({ ios: { lane: 'ios', outcome: 'failure', stage: 'build', reason: 'the Mac stayed unreachable during the Xcode handoff' }, reruns: [{ conclusion: 'success', completion: verdict('COMPLETE', { version: '0.3.19', commit: C }) }] })] });
  const result = await w.go();
  assert.equal(result.status, 0);
  assert.deepEqual(w.state.dispatched, [], 'no dry, no real: the spent version is finished instead');
  assert.deepEqual(w.state.reruns, [41_445_863_722]);
  assert.ok(w.logs.some(line => /^SHIP_RECOVER delorenj\/tower-of-lost-things run 41445863722 spent 0\.3\.19 and is red \(ios at build: .*\): finishing that version first, no new bump$/.test(line)), w.logs.join('\n'));
  assert.match(w.last(), /^SHIP_COMPLETE .*recovered by rerun 1\)$/);
  assert.ok(!w.state.calls.some(call => /prompt/.test(call)));
});

test('frozen tools: 0.3.19\'s upload hook failed and its files changed on main, so ship blocks the futile rerun (4) and names both ways on', async () => {
  const w = world({
    runs: [redOldRun()],
    files: { [`${C}:tools/ci/mobile-deploy.json`]: appManifest('node tools/testflight.mjs upload "$HUB_OUT/ios/TowerOfLostThings-xcode.tgz"'), [`${A}:tools/ci/mobile-deploy.json`]: appManifest('node tools/testflight.mjs upload "$HUB_OUT/ios/TowerOfLostThings-xcode.tgz"') },
    compare: ['tools/ios.mjs', 'tools/testflight.mjs', 'docs/ios.md', 'tests/ios.test.mjs'],
  });
  const result = await w.go();
  assert.equal(result.status, 4);
  assert.match(w.last(), /^SHIP_RECOVERY_BLOCKED delorenj\/tower-of-lost-things 0\.3\.19 run 41445863722: hook ios\.store\.upload failed at 3832680b and tools\/ios\.mjs, tools\/testflight\.mjs changed on main since \(aaaaaaaa\), so a rerun would run the same tools again\. Two ways on: \(1\) the hub's same-version recover .*slice 2.*\(2\) ship a new version that carries main's tools: mise run ship --abandon 41445863722$/);
  assert.deepEqual([w.state.reruns, w.state.dispatched], [[], []]);
  assert.ok(w.state.calls.includes(`api repos/${repo}/compare/${C}...${A} --jq [.files[].filename]`));

  // --abandon names that run: it is left alone and a new version ships (dry, then real).
  const abandoned = world({ runs: [redOldRun()], outcomes: [dryOk(), { conclusion: 'success', completion: verdict('COMPLETE') }] });
  assert.equal((await abandoned.go(['--abandon', '41445863722'])).status, 0);
  assert.deepEqual(abandoned.state.dispatched.map(d => d.kind), ['dry', 'real']);
  assert.ok(abandoned.logs.some(line => /^SHIP_ABANDON .*run 41445863722 is left as it is/.test(line)));
});

test('a red last real run past the 7-day window, or red before its bump, is not recovered: a new version ships', async () => {
  const old = world({ runs: [redOldRun({ createdAt: '2026-10-20T12:00:00Z' })], outcomes: [dryOk(), { conclusion: 'success', completion: verdict('COMPLETE') }] });
  assert.equal((await old.go()).status, 0);
  assert.ok(old.logs.some(line => /^SHIP_NOTE .*run 41445863722 is red and 13 days old, past the 7-day window/.test(line)));
  const early = redOldRun();
  early.jobs[1].conclusion = 'failure';
  early.artifacts = { 'plan-out': { 'hub-receipt-plan.json': { lane: 'plan', outcome: 'failure', stage: 'version', reason: 'push refused' } } };
  const unspent = world({ runs: [early], outcomes: [dryOk(), { conclusion: 'success', completion: verdict('COMPLETE') }] });
  assert.equal((await unspent.go()).status, 0);
  assert.ok(unspent.logs.some(line => /red before its bump \(nothing was spent\)/.test(line)));
  assert.deepEqual(unspent.state.reruns, []);
});

test('unknown: a real run GitHub never finishes reporting is SHIP_UNKNOWN (3), neither shipped nor red', async () => {
  const w = world({ outcomes: [dryOk(), { conclusion: null }] });
  const result = await w.go();
  assert.equal(result.status, 3);
  assert.match(w.last(), /^SHIP_UNKNOWN delorenj\/tower-of-lost-things real run \d+ \S+: no verdict from GitHub, so this is neither shipped nor red; finish by hand: gh run watch \d+ --repo delorenj\/tower-of-lost-things --interval 30 --exit-status$/);
  const lost = world({ outcomes: [{ conclusion: 'success', completion: null }] });
  assert.equal((await lost.go()).status, 3, 'a green dry run whose verdict cannot be read is not a go');
  assert.deepEqual(lost.state.dispatched.map(d => d.kind), ['dry']);
});

test('main moving after the dry run is proved again before the real run, which builds only a proven commit', async () => {
  const moving = { ...dryOk(), onDispatch: state => { state.main = B; } };
  const w = world({ outcomes: [moving, dryOk(), { conclusion: 'success', completion: verdict('COMPLETE') }] });
  assert.equal((await w.go()).status, 0);
  assert.deepEqual(w.state.dispatched.map(d => [d.kind, d.sha]), [['dry', A], ['dry', B], ['real', B]]);
  assert.ok(w.logs.some(line => /^SHIP_REDRY main moved from aaaaaaaa to bbbbbbbb/.test(line)));
});

test('frozenTools: the hook\'s scripts and their sibling modules, or a changed command; failedHook reads the failure', () => {
  assert.deepEqual(hookScripts('node tools/testflight.mjs upload "$HUB_OUT/ios/x.tgz" && bash scripts/ci/a.sh'), ['tools/testflight.mjs', 'scripts/ci/a.sh']);
  assert.equal(failedHook('hook ios.store.upload failed (exit 1)'), 'ios.store.upload');
  assert.equal(failedHook('the Mac stayed unreachable'), null);
  const before = 'node tools/testflight.mjs upload';
  assert.deepEqual(frozenTools({ hook: 'ios.store.upload', before, after: before, changed: ['tools/ios.mjs', 'docs/ios.md'] }), { hook: 'ios.store.upload', touched: ['tools/ios.mjs'] });
  assert.equal(frozenTools({ hook: 'ios.store.upload', before, after: before, changed: ['docs/ios.md', 'tools/ci/other.mjs'] }), null, 'only the hook\'s own folder');
  assert.deepEqual(frozenTools({ hook: 'ios.store.upload', before, after: 'node tools/upload.mjs', changed: [] }).touched, ['the ios.store.upload command in the manifest']);
});

// ---------------------------------------------------------------------------------------------------- the app-side task

import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { checkApp, checkShipTask, miseTasks, shipTemplateFile } from '../conformance.mjs';
import { templateFile } from './lib/caller.mjs';
import { loadPolicy } from './lib/policy.mjs';

const hubRoot = fileURLToPath(new URL('../../', import.meta.url));
const shipTemplate = readFileSync(shipTemplateFile, 'utf8');
const runText = /\nrun = '''\n([\s\S]*?)\n'''/.exec(shipTemplate)[1];

test('templates/mise-ship.toml fetches deploy.mjs at the pinned ref exactly as the deploy task does, then runs ship', () => {
  const [task] = miseTasks(shipTemplate);
  assert.equal(task.name, 'ship');
  assert.match(runText, /^ref="\$\(sed -n 's#\^ \*uses: delorenj\/mobile-deploy-hub\/\\\.github\/workflows\/mobile-deploy\\\.yml@\\\(\[A-Za-z0-9\._\/-\]\*\\\)\$#\\1#p' \.github\/workflows\/deploy\.yml\)"$/m);
  assert.match(runText, /^gh api -H 'Accept: application\/vnd\.github\.raw' "repos\/delorenj\/mobile-deploy-hub\/contents\/tools\/deploy\.mjs\?ref=\$ref" > "\$tool\/deploy\.mjs"$/m);
  assert.match(runText, /^node "\$tool\/deploy\.mjs" ship --bump "\$usage_bump" --metered "\$usage_metered" --abandon "\$usage_abandon" --hub-ref "\$ref"$/m);
  assert.doesNotMatch(shipTemplate, /--platform|--testflight|--dry-run/, 'ship never narrows');
  // What mise hands it, blanks included, parses.
  assert.equal(parseArguments(['ship', '--bump', '', '--metered', 'auto', '--abandon', '', '--hub-ref', 'v1']).mode, 'ship');
});

test('the task text, run as mise runs it against a fake gh, fetches the hub\'s deploy.mjs and exits with ship\'s status', () => {
  const root = mkdtempSync(join(tmpdir(), 'hub-ship-task-'));
  try {
    const app = join(root, 'app');
    const bin = join(root, 'bin');
    mkdirSync(join(app, '.github/workflows'), { recursive: true });
    mkdirSync(bin);
    writeFileSync(join(app, '.github/workflows/deploy.yml'), readFileSync(templateFile, 'utf8'));
    const busy = JSON.stringify([{ databaseId: 9, headSha: A, event: 'workflow_dispatch', status: 'in_progress', conclusion: null, createdAt: '2026-11-02T19:00:00Z', url: `https://github.com/${repo}/actions/runs/9`, displayTitle: 'Deploy REAL both bump=patch' }]);
    writeFileSync(join(bin, 'gh'), `#!/bin/sh
echo "gh $*" >> "${root}/gh.log"
case "$*" in
  *"mobile-deploy-hub/contents/tools/deploy.mjs?ref=v1") cat "${hubRoot}tools/deploy.mjs" ;;
  *"mobile-deploy-hub/contents/tools/ci/policy.json?ref=v1") cat "${hubRoot}tools/ci/policy.json" ;;
  *"contents/.github/workflows/deploy.yml?ref=main") cat "${app}/.github/workflows/deploy.yml" ;;
  *"contents/tools/ci/mobile-deploy.json?ref=main") echo '{"schema":2,"android":{},"ios":{}}' ;;
  "repo view"*) echo ${repo} ;;
  "run list"*) echo '${busy}' ;;
  *) echo "fake gh: unexpected $*" >&2; exit 1 ;;
esac
`);
    chmodSync(join(bin, 'gh'), 0o755);
    const result = spawnSync('sh', ['-c', runText], { cwd: app, encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, usage_bump: '', usage_metered: 'auto', usage_abandon: '' } });
    assert.equal(result.status, 5, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /^SHIP_BUSY delorenj\/tower-of-lost-things: real run 9 is in_progress/m);
    const calls = readFileSync(join(root, 'gh.log'), 'utf8');
    assert.match(calls, /^gh api -H Accept: application\/vnd\.github\.raw repos\/delorenj\/mobile-deploy-hub\/contents\/tools\/deploy\.mjs\?ref=v1$/m, 'the ref deploy.yml pins');
    assert.doesNotMatch(calls, /workflow run|run rerun/, 'busy dispatches nothing');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('conformance accepts the template ship task and does not yet require it; a ship task that is not the template is refused', () => {
  const { policy } = loadPolicy();
  const app = policy.apps[repo];
  const tower = { schema: 2, project: { slug: 'tower-of-lost-things', name: 'Tower' }, version: { read: 'true', bump: 'true' }, android: { package: app.android.package, export: 'true', artifact: 'a/App.apk', signer_sha256: app.android.signer_sha256 }, ios: { bundle: app.ios.bundle, device: 'true', device_artifact: 'A.xcarchive' } };
  const deployTask = '[tasks."deploy"]\nrun = \'\'\'\nnode "$tool/deploy.mjs" --dry-run "$usage_dry_run"\n\'\'\'\n';
  const files = mise => ({ '.github/workflows/deploy.yml': readFileSync(templateFile, 'utf8'), 'tools/ci/mobile-deploy.json': JSON.stringify(tower), 'mise.toml': mise });
  const open = mise => ({ read: path => { const all = files(mise); if (!(path in all)) throw Object.assign(new Error('404'), { code: 'ENOENT' }); return all[path]; }, list: () => ['.github/workflows/deploy.yml'] });
  assert.deepEqual(checkApp({ repo, app, policy, ...open(`${deployTask}\n# Tower's own words about shipping\n${shipTemplate.replace(/^# .*\n/gm, '')}`) }), [], 'the template, comments aside');
  assert.deepEqual(checkApp({ repo, app, policy, ...open(deployTask) }), [], 'not required yet');
  const edited = shipTemplate.replace('--metered "$usage_metered" ', '');
  assert.deepEqual(checkShipTask(repo, edited), [`${repo} mise task ship: not the hub's ship task (templates/mise-ship.toml); copy it verbatim, only comments may differ`]);
  assert.ok(checkApp({ repo, app, policy, ...open(`${deployTask}${edited}`) }).some(problem => /mise task ship: not the hub's ship task/.test(problem)));
});
