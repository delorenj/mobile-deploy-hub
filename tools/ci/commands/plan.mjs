// preflight-ios (Mac, no checkout) and plan (Linux, the bump). v1.1: an absent device is pending, not a stop. The Mac
// preflight still fails on signing, profile or disk; an unreachable iPad is ipad_version=unreachable. The plan waits
// for the S26 (android_wait_s), then goes ahead without it; it refuses a planned Android code at or below the phone's
// or the newest published one (latest.json), and an iPad that already runs something newer, before any bump.
// v1.1.3: inside a job it hashes the caller again (it spends the version), refuses a manifest that changed on main
// since the dispatched commit (the bump lands on main's newest tip, which the gate never saw), and probes the Mac once
// more right before the iPad lane: a Mac that went away after the gate turns the lane into skip-lost instead of a job
// that waits 24 hours for its runner.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { createAdb, findPhone } from '../lib/adb.mjs';
import { bbEmit, bloodbankTree, correlationFor, deploymentEvent, scopeOf } from '../lib/announce.mjs';
import { devProfile, identities, installedProfiles, signingProbe } from '../lib/apple.mjs';
import { hookEnvironment } from '../lib/config.mjs';
import { createDevicectl, createIpad } from '../lib/devicectl.mjs';
import { loadDevices } from '../lib/devices.mjs';
import { hookOutput, run } from '../lib/exec.mjs';
import { bumpTransaction, createGit } from '../lib/git.mjs';
import { compareBuild, compareSemver, inflightKey, latestKey, parseLatest } from '../lib/latest.mjs';
import { withLock } from '../lib/lock.mjs';
import { loadManifest } from '../lib/manifest.mjs';
import { buildReceipt, setOutputs, writeReceipt } from '../lib/receipt.mjs';
import { jobWriter, readObject } from '../lib/s3.mjs';
import { parseVersionInfo } from '../lib/version.mjs';
import { checkCaller, refusal } from '../lib/caller.mjs';
import { checkDisk, checkSecrets, firstLine, guarded, isoNow, policyBanner, reachIpad, readMacLink, runOf, short } from './common.mjs';
import { callerReader, checkPins } from './gate.mjs';

// ---------------------------------------------------------------------------------------------------- preflight-ios

export async function preflightIos(config, { env = process.env, home = homedir(), log = console.log, sleep, now } = {}) {
  const { policy } = policyBanner(log);
  const dir = join(config.out, 'preflight');
  if (!config.bundle) throw new Error('preflight-ios needs the bundle id from the gate (HUB_BUNDLE); it has no checkout');
  const emit = async receipt => setOutputs({ receipt: Buffer.from(JSON.stringify(receipt)).toString('base64') }, env);
  const track = { stage: 'preflight' };
  try {
    const devices = loadDevices(env);
    const notes = [];
    const free = checkDisk(home, devices);
    notes.push(`${free.toFixed(1)} GiB free`);
    log(run('xcodebuild', ['-version'], { env }).trim());
    const signer = devices.apple.dev_signer_sha1;
    const valid = identities({ env });
    if (!valid.has(signer)) throw new Error(`the development identity ${signer.slice(0, 8)} is not a valid codesigning identity in this Mac's keychain`);
    signingProbe({ signer, env, timeoutMs: Number(env.HUB_SIGNING_TIMEOUT_MS) || 60_000 });
    notes.push(`signing probe passed with ${signer.slice(0, 8)} (the runner can use the private key)`);
    const profile = devProfile(installedProfiles({ env, home }), { team: devices.apple.team, udid: devices.ios.udid, signer, bundle: config.bundle, minDays: devices.apple.profile_min_days });
    notes.push(`profile "${profile.name}" covers the iPad until ${profile.expires_at.slice(0, 10)}`);
    if (config.testflight) {
      if (!config.iosStore) throw new Error(`--testflight is for an app with ios.store; ${config.slug || config.bundle} has none`);
      if (config.iosStore.signer_sha1 && !valid.has(config.iosStore.signer_sha1)) throw new Error(`the App Store identity ${config.iosStore.signer_sha1.slice(0, 8)} is not in this Mac's keychain`);
      checkSecrets(config.iosStore.secrets ?? [], { config, env, notes });
    }
    const ipad = createIpad({ devicectl: createDevicectl({ env }), udid: devices.ios.udid, model: devices.ios.model });
    const waitMs = Number(env.HUB_IPAD_WAIT_MS) || policy.devices.ipad_wait_s * 1000;
    const reach = await reachIpad(ipad, { waitMs, ...(sleep ? { sleep } : {}), ...(now ? { now } : {}) });
    let installed = null;
    let state = 'unreachable';
    if (reach.reachable) {
      try {
        installed = ipad.installed(config.bundle);
        state = installed ? 'installed' : 'absent';
      } catch (error) {
        reach.reason = `devicectl could not read its apps (${firstLine(error.message).slice(0, 160)})`;
      }
    }
    if (state === 'unreachable') {
      log(`HUB_IPAD_PENDING ${reach.detail ?? reach.reason}; the run goes on and the iPad delivery will be pending`);
      notes.push(`iPad ${devices.ios.model}: unreachable (${reach.detail ?? reach.reason}); pending`);
    } else {
      notes.push(`iPad ${devices.ios.model} (iOS ${reach.found.os ?? '?'}, ${reach.found.transport ?? '?'}): ${installed ? `${config.bundle} ${installed.version} (${installed.build})` : `${config.bundle} not installed`}`);
    }
    const version = state === 'installed' ? installed.version || 'absent' : state;
    const build = state === 'installed' ? installed.build || 'absent' : state;
    const receipt = buildReceipt({ lane: 'preflight-ios', config, env, notes, ipad: { state, version: installed?.version ?? null, build: installed?.build ?? null, reason: state === 'unreachable' ? reach.reason : null }, profile: { name: profile.name, expires_at: profile.expires_at } });
    await setOutputs({ ipad_version: version, ipad_build: build }, env);
    await emit(receipt);
    await writeReceipt(dir, receipt, env);
    log(`HUB_PREFLIGHT_IOS ok iPad=${state === 'installed' ? `${installed.version}(${installed.build})` : state} profile=${profile.expires_at.slice(0, 10)}`);
    return { state, installed, profile, notes };
  } catch (error) {
    const receipt = buildReceipt({ lane: 'preflight-ios', config, env, outcome: 'failure', stage: track.stage, reason: firstLine(error.message).replace(/^::error::/, '').slice(0, 500) });
    try { await emit(receipt); await writeReceipt(dir, receipt, env); } catch { /* the preflight's own error is the one to report */ }
    throw error;
  }
}

// ---------------------------------------------------------------------------------------------------- plan

// A representative completed event for this app, held to the schema before any version is spent: one device
// installed, one pending, with the links the notification renders.
export function sampleEvent({ manifest, devices, version, androidCode, commit, env }) {
  const declared = { android: Boolean(manifest.android), ios: Boolean(manifest.ios) };
  const needs = { gate: { result: 'success' }, plan: { result: 'success' }, android: { result: 'success' }, ios: { result: 'success' }, 'ios-export': { result: 'success' }, deliver: { result: 'success' } };
  const receipts = {
    android: { delivery: { platform: 'android', target: devices.android.model, version, build: String(androidCode ?? 1), sha256: '0'.repeat(64), verified: false, status: 'pending', reason: "not on big-chungus's adb" } },
    ios: { delivery: { platform: 'ios', target: devices.ios.model, version, build: '1', sha256: '0'.repeat(64), verified: true, status: 'installed' } },
  };
  const base = 'https://s3.delo.sh/builds';
  const slug = manifest.project.slug;
  const published = { apk: `${base}/${slug}/${version}/${slug}-${version}-${androidCode ?? 1}.apk`, ota: `itms-services://?action=download-manifest&url=${base}/${slug}/ios/manifest.plist`, page: `${base}/${slug}/index.html` };
  return deploymentEvent({ project: manifest.project, declared, devices, needs, receipts, version, androidCode, commit, published, env: { ...env, GITHUB_RUN_ID: env.GITHUB_RUN_ID || '1' } });
}

// bb-emit validates against the live bloodbank checkout, so the contract it enforces must be committed there, and
// the event this deploy will send must pass it. A real run stops here, before any version is spent; a dry run records
// the gap and goes on to prove the device lanes, and its announce job still fails on the same check.
async function eventPreflight({ config, manifest, devices, version, androidCode, commit, env, home, notes }) {
  const tree = bloodbankTree({ env, home });
  const problems = [];
  if (tree.commit && tree.dirty && tree.dirty.length > 0) problems.push(`the Bloodbank contract files bb-emit validates against are uncommitted in ${basename(tree.root)} (${tree.dirty.slice(0, 4).join(', ')}); commit the schema edit so the contract is reproducible`);
  const sample = sampleEvent({ manifest, devices, version, androidCode, commit, env });
  try {
    bbEmit({ type: sample.type, data: sample.data, correlation: correlationFor(env), check: true, env, home });
    notes.push(`event contract: ${sample.type} with statuses and links passes bb-emit --check${tree.commit ? ` (bloodbank ${short(tree.commit)})` : ''}`);
  } catch (error) {
    console.log(error.message);
    problems.push(`the ${sample.type} event this deploy sends fails its contract (${firstLine(error.message)})`);
  }
  if (problems.length > 0) {
    if (!config.dryRun) throw new Error(`${problems.join('; ')}. Nothing was bumped.`);
    for (const problem of problems) {
      console.log(`::warning::${problem}`);
      notes.push(`UNVERIFIED: ${problem}`);
    }
  }
  return tree;
}

const notOnAdb = error => /is not on this host's adb server/.test(error.message);

export async function plan(config, { env = process.env, home = homedir(), fetchImpl = fetch, s3Factory = null, log = console.log, macLinkNow = null } = {}) {
  const { policy } = policyBanner(log);
  const manifest = await loadManifest(config.cwd, config.manifest);
  // The manifest as dispatched (github.sha): the bump must land on a main whose manifest the gate checked.
  const dispatchedManifest = readFileSync(join(config.cwd, config.manifest), 'utf8');
  return guarded('plan', join(config.out, 'plan'), config, env, async track => {
    const devices = loadDevices(env);
    const app = policy.apps[env.GITHUB_REPOSITORY ?? ''] ?? null;
    if (env.GITHUB_ACTIONS === 'true') {
      // The plan spends the version, so it holds the run to the template caller again (a deploy.yml that skipped the
      // gate, or one that is not the template, stops here).
      checkCaller({ policy, env, read: callerReader(config, env) });
      if (!app) throw refusal('repo', `${env.GITHUB_REPOSITORY || 'this repository'} is not listed in the hub policy`);
    }
    if (app) {
      if (manifest.project.slug !== app.slug) throw refusal('slug', `the manifest's project.slug is ${manifest.project.slug}; the policy lists this repository as ${app.slug}`);
      checkPins({ app, manifest });
    }
    if (!policy.bump.levels.includes(config.bump)) throw new Error(`HUB_GATE_REFUSED bump: ${config.bump} is not one of ${policy.bump.levels.join(', ')}`);
    const declared = scopeOf({ platform: config.platform, manifest });
    // The iPad lane runs only when the gate said so (the Mac online and within its data budget).
    const iosLane = config.iosLane || 'run';
    const scope = { android: declared.android, ios: declared.ios && iosLane === 'run' };
    if (config.platform === 'android' && !manifest.android) throw new Error('platform android but the manifest has no android section');
    if (config.platform === 'ios' && !manifest.ios) throw new Error('platform ios but the manifest has no ios section');
    if (config.testflight && !scope.ios) throw new Error(`--testflight needs the iOS lane (platform both or ios, and the Mac reachable; the gate said ${iosLane})`);
    if (config.testflight && !manifest.ios.store) throw new Error(`--testflight is for an app with ios.store; ${manifest.project.slug} has no App Store Connect app in its manifest`);
    if (config.play) {
      if (!scope.android) throw new Error('--play needs the Android lane (platform both or android)');
      if (!manifest.android.bundle) throw new Error(`--play needs an android.bundle hook and ${manifest.android.package} declares none; Play stays blocked on the Play launch spec`);
      if (!config.dryRun && (!env.HUB_WIF_PROVIDER || !env.HUB_PLAY_SA)) throw new Error('a real Play run needs wif_provider and play_sa (the caller passes vars.GCP_WIF_PROVIDER and vars.PLAY_SA_EMAIL)');
    }
    const onMain = env.GITHUB_REF === 'refs/heads/main';
    if (!config.dryRun && !onMain) throw new Error(`a real deploy bumps main, so it must be dispatched on main (this run is on ${env.GITHUB_REF ?? 'no ref'})`);
    if (scope.ios && !config.ipadVersion) throw new Error('the iPad state is unknown: preflight-ios must run before plan when the iOS lane runs');
    await setOutputs({
      schema: 2,
      project_slug: manifest.project.slug,
      run_android: scope.android,
      run_ios: scope.ios,
      run_ios_export: scope.ios && Boolean(manifest.ios.export),
      play_lane: scope.android && config.play,
      release_lane: scope.android && policy.delivery.release,
    }, env);

    const notes = [];
    const hooks = hookEnvironment(config, env, { HUB_TEAM: devices.apple.team });
    const readVersion = () => parseVersionInfo(hookOutput('version.read', manifest.version.read, { cwd: config.cwd, env: hooks }), { needAndroid: scope.android });

    // The newest published builds: the planned Android code must be above them too.
    track.stage = 'preflight';
    const latestText = await readObject(policy, latestKey(manifest.project.slug), { fetchImpl });
    const latest = latestText === null ? null : parseLatest(latestText, { slug: manifest.project.slug });

    // The S26, waited for; away is pending, not a stop. A wrong device still stops the run.
    let phone = null;
    let s26 = 'n/a';
    if (scope.android) {
      try {
        phone = await withLock('adb', async () => {
          const adb = createAdb({ env, home });
          const id = await findPhone(adb, { serial: devices.android.serial, model: devices.android.model, waitMs: Number(env.HUB_ADB_WAIT_MS) || policy.devices.android_wait_s * 1000 });
          return adb.installed(id, manifest.android.package);
        }, { env, timeoutMs: 20 * 60_000 });
        s26 = 'present';
        notes.push(`S26 ${devices.android.model}: ${phone ? `${manifest.android.package} ${phone.versionName} (${phone.versionCode}) installed` : `${manifest.android.package} not installed`}`);
      } catch (error) {
        if (!notOnAdb(error)) throw error;
        s26 = 'away';
        log(`HUB_S26_PENDING the S26 is not on big-chungus's adb after ${policy.devices.android_wait_s}s; the bump goes ahead and the S26 delivery will be pending`);
        notes.push('S26: away (pending); the build is published for a later install');
      }
    }
    const ipadKnown = scope.ios && !['', 'unreachable', 'absent'].includes(config.ipadVersion);
    if (scope.ios) notes.push(`iPad ${devices.ios.model}: ${config.ipadVersion === 'unreachable' ? 'unreachable (pending)' : config.ipadVersion === 'absent' ? `${manifest.ios.bundle} not installed` : `${manifest.ios.bundle} ${config.ipadVersion} (${config.ipadBuild || '-'}) installed`}`);

    const current = readVersion();
    track.receipt = { version: current.version, androidCode: current.android_code };
    const tree = await eventPreflight({ config, manifest, devices, version: current.version, androidCode: current.android_code, commit: env.GITHUB_SHA || '0000000', env, home, notes });

    track.stage = 'version';
    const git = createGit({ cwd: config.cwd, env, token: env.GH_TOKEN });
    const runUrl = runOf(env).url ?? 'a local run';
    const result = await bumpTransaction({
      git,
      level: config.bump,
      dryRun: config.dryRun,
      onMain,
      readVersion,
      runBump: level => parseVersionInfo(hookOutput('version.bump', manifest.version.bump, { cwd: config.cwd, env: hooks, args: [level] }), { hook: 'version.bump', needAndroid: scope.android, needFiles: true }),
      beforeCommit: ({ bumped }) => {
        track.stage = 'preflight';
        // The bump lands on main's newest tip. Its manifest must be the one the gate checked at the dispatched commit:
        // lanes and deliver read the manifest at the bump commit, and a renamed slug or a new lane would publish under
        // rules nobody checked.
        let base = null;
        try { base = readFileSync(join(config.cwd, config.manifest), 'utf8'); } catch { /* reported below */ }
        if (base !== dispatchedManifest) throw refusal('manifest', `${config.manifest} changed on main since the dispatched commit ${short(env.GITHUB_SHA ?? '')}; dispatch the deploy again so the gate checks it. Nothing was bumped`);
        if (phone && bumped.android_code !== undefined && bumped.android_code <= phone.versionCode) {
          throw new Error(`the S26 already has ${manifest.android.package} versionCode ${phone.versionCode}, at or above the planned ${bumped.android_code}; Android would refuse the update. Bump past it (--bump minor) or find out what installed that build`);
        }
        if (scope.android && latest?.android && bumped.android_code !== undefined && bumped.android_code <= latest.android.code) {
          log(`HUB_PLAN_REFUSED planned code ${bumped.android_code} is not above the published ${latest.android.code}`);
          throw new Error(`HUB_PLAN_REFUSED the build directory already published ${manifest.android.package} ${latest.android.version} (${latest.android.code}), at or above the planned ${bumped.android_code}; phones would refuse it as a downgrade. Bump past it`);
        }
        if (ipadKnown) {
          const byVersion = compareSemver(config.ipadVersion, bumped.version);
          const newer = byVersion > 0 || (byVersion === 0 && bumped.ios_build !== undefined && config.ipadBuild && compareBuild(config.ipadBuild, bumped.ios_build) > 0);
          if (newer) {
            log(`HUB_IPAD_NEWER the iPad runs ${config.ipadVersion} (${config.ipadBuild}), newer than the planned ${bumped.version} (${bumped.ios_build ?? '-'})`);
            throw new Error(`HUB_IPAD_NEWER the iPad already runs ${manifest.ios.bundle} ${config.ipadVersion} (${config.ipadBuild}), newer than the planned ${bumped.version}; the hub never downgrades it. Bump past it`);
          }
        }
        track.stage = 'version';
      },
      message: ({ current: from, bumped, level }) => `chore(release): v${bumped.version}\n\nVersion ${from.version} -> ${bumped.version} (${level}) by mobile-deploy-hub, ${runUrl}.`,
    });
    const next = result.next;

    // The Mac once more, right before the iPad lane: the S26 wait and the bump can take minutes, and a Mac that left in
    // between (a closed lid, a dropped hotspot) would hold the iPad job, and announce, in GitHub's queue for 24 hours.
    let laneNow = iosLane;
    if (scope.ios && (macLinkNow || env.GITHUB_ACTIONS === 'true')) {
      const link = macLinkNow ? macLinkNow() : readMacLink({ policy, devices, env });
      if (link.link === 'offline') {
        laneNow = 'skip-lost';
        scope.ios = false;
        log(`HUB_IOS_SKIPPED lost: the Mac went offline after the gate (${link.reason}); the iPad delivery is skipped, the S26 lane goes on`);
        notes.push(`iPad lane skipped: the Mac went offline after the gate (${link.reason})`);
      } else {
        log(`HUB_MAC_LINK ${link.link} (again, before the iPad lane: ${link.reason})`);
      }
    }

    // A real run is now between plan and deliver: the catch-up leaves this version alone on the platforms this run
    // builds, until each deliver clears its own.
    if (result.committed) {
      try {
        const s3 = s3Factory ? await s3Factory() : await jobWriter(policy, env);
        const platforms = ['android', 'ios'].filter(platform => scope[platform]);
        s3.putText(`${JSON.stringify({ version: next.version, run: runOf(env), started_at: isoNow(), platforms })}\n`, inflightKey(manifest.project.slug));
        notes.push(`inflight.json names ${next.version} (${platforms.join(', ')})`);
      } catch (error) {
        log(`::warning::could not write ${inflightKey(manifest.project.slug)} (${firstLine(error.message)}); deliver still publishes`);
      }
    }

    const outputs = {
      version: next.version,
      android_code: next.android_code ?? '',
      ios_build: next.ios_build ?? '',
      previous_version: result.current.version,
      tag: result.tag,
      build_sha: result.sha,
      base_sha: result.base,
      bump_patch: config.dryRun && result.patch ? Buffer.from(result.patch).toString('base64') : '',
      bumped: result.committed,
      s26,
      // The last word on the iPad lane (the later value of a key wins in GITHUB_OUTPUT).
      ios_lane: laneNow,
      run_ios: scope.ios,
      run_ios_export: scope.ios && Boolean(manifest.ios?.export),
    };
    await setOutputs(outputs, env);
    track.receipt = { version: next.version, androidCode: next.android_code };
    const bump = { level: config.bump, from: result.current.version, to: next.version, tag: result.tag, files: result.files, committed: result.committed, rehearsed: result.rehearsed === true, attempts: result.attempts, base: result.base };
    notes.push(result.committed ? `bumped ${result.current.version} -> ${next.version}, pushed ${result.tag} at ${short(result.sha)}` : `dry run: would bump ${result.current.version} -> ${next.version} (${result.files.join(', ')}); commit, tag and git push --dry-run rehearsed, then rewound: nothing reached the remote`);
    await writeReceipt(join(config.out, 'plan'), buildReceipt({
      lane: 'plan', config: { ...config, buildSha: result.sha }, env, version: next.version, androidCode: next.android_code, build: next.ios_build, notes,
      bump, devices: { s26: phone, s26_state: s26, ipad: declared.ios && iosLane === 'run' ? { version: config.ipadVersion, build: config.ipadBuild || null } : null, ios_lane: laneNow },
      published: latest ? { android: latest.android ? { version: latest.android.version, code: latest.android.code } : null, ios: latest.ios ? { version: latest.ios.version, build: latest.ios.build } : null } : null,
      bloodbank: { commit: tree.commit, clean: tree.dirty ? tree.dirty.length === 0 : null },
    }), env);
    log(`HUB_PLAN version=${result.current.version} next=${next.version} android_code=${next.android_code ?? '-'} platform=${config.platform} bump=${config.bump} dry_run=${config.dryRun} s26=${s26} ios_lane=${laneNow} build_sha=${short(result.sha)}`);
    return { ...outputs, schema: 2, run_android: scope.android, run_ios: scope.ios };
  });
}
