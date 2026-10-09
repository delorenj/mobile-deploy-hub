#!/usr/bin/env node
// Mobile Deploy Hub tool. The reusable workflow (.github/workflows/mobile-deploy.yml) calls one command per
// job through actions/hub; the same commands run locally from an app checkout.
//
// v3 (manifest schema 2): every deploy bumps the version, installs on the S26 and the iPad, reads the version back
// and sends one Bloodbank event.
//   preflight-ios  Mac: iPad reachable, development identity usable (signing probe), profile, disk, store refs
//   plan           Linux: S26 reachable, event contract, the bump (real: commit, tag, atomic push to main)
//   android        Linux: build the APK, signer and version checks, install on the S26 and read it back
//   play           AAB to Play (real --play runs only)
//   release        the private GitHub Release vX.Y.Z (real runs only, after the S26 readback)
//   ios-export     Linux half (Tower): Godot's Xcode projects, handed to the Mac over the LAN
//   ios            Mac: the app's ios.device build, export, IPA checks, install on the iPad and read it back;
//                  TestFlight with --testflight
//   announce       the event (real) or `bb-emit --check` of it (dry run)
//
// v2 (manifest schema 1) still runs the v2 way for callers that have not moved: plan, android (export and signer),
// release, play, ios-export and ios-upload (TestFlight). No bump, no installs, no event.
//
// Hooks come from the app's committed manifest and run under bash in the app root. Nothing here reads a
// hook, a ref or a command from an event payload.
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { copyFile, mkdir, readFile, stat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { homedir, tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAdb, findPhone } from './lib/adb.mjs';
import { apkIdentity, verifySigner } from './lib/android.mjs';
import { bbEmit, bloodbankTree, correlationFor, deploymentEvent, scopeOf } from './lib/announce.mjs';
import { devProfile, exportIpa, freeGiB, identities, inspectIpa, installedProfiles, signingProbe } from './lib/apple.mjs';
import { hookEnvironment, parseConfig } from './lib/config.mjs';
import { loadDevices } from './lib/devices.mjs';
import { createDevicectl, createIpad } from './lib/devicectl.mjs';
import { hook, hookOutput, run } from './lib/exec.mjs';
import { bumpTransaction, createGit } from './lib/git.mjs';
import { exportGodot } from './lib/godot.mjs';
import { receiveHandoff, sendHandoff } from './lib/handoff.mjs';
import { withLock } from './lib/lock.mjs';
import { loadManifest } from './lib/manifest.mjs';
import { uploadBundle } from './lib/play.mjs';
import { buildReceipt, setOutputs, sha256File, writeReceipt } from './lib/receipt.mjs';
import { parseVersionInfo } from './lib/version.mjs';

const semver = /^\d+\.\d+\.\d+$/;
const exists = async path => stat(path).then(info => info.isFile() && info.size > 0, () => false);
const short = sha => (sha ?? '').slice(0, 8);
const firstLine = message => String(message ?? '').split('\n').find(line => line.trim()) ?? 'failed';

export function parseVersion(stdout, { needAndroid = false } = {}) {
  const line = stdout.trim().split('\n').pop() ?? '';
  let value;
  try { value = JSON.parse(line); } catch { throw new Error(`the version hook must print one line of JSON, got "${line.slice(0, 120)}"`); }
  if (!semver.test(value?.version ?? '')) throw new Error(`the version hook returned version "${value?.version}", expected X.Y.Z`);
  if (value.android_code !== undefined && !(Number.isSafeInteger(value.android_code) && value.android_code > 0)) throw new Error('the version hook returned a bad android_code');
  if (needAndroid && value.android_code === undefined) throw new Error('the version hook must return android_code for an Android deploy');
  return { version: value.version, android_code: value.android_code };
}

export function tagVersion(env) {
  if (env.GITHUB_REF_TYPE !== 'tag') return undefined;
  const match = /^v(\d+\.\d+\.\d+)$/.exec(env.GITHUB_REF_NAME ?? '');
  if (!match) throw new Error(`tag "${env.GITHUB_REF_NAME}" must look like vX.Y.Z to deploy`);
  return match[1];
}

const wants = (config, platform) => config.platform === 'both' || config.platform === platform;

// A v3 lane writes its receipt on failure too: the stage it reached and a one-line reason, for announce.
async function guarded(lane, dir, config, env, fn) {
  const track = { stage: 'preflight', receipt: {} };
  try {
    return await fn(track);
  } catch (error) {
    try {
      await writeReceipt(dir, buildReceipt({ lane, config, env, ...track.receipt, outcome: 'failure', stage: track.stage, reason: firstLine(error.message).replace(/^::error::/, '').slice(0, 500) }), env);
    } catch { /* the lane's own error is the one to report */ }
    throw error;
  }
}

// ---------------------------------------------------------------------------------------------------- plan

async function planV2(config, manifest, { env }) {
  const android = wants(config, 'android');
  const ios = wants(config, 'ios');
  if (android && !manifest.android) throw new Error('platform includes android but the manifest has no android section');
  if (ios && !manifest.ios) throw new Error('platform includes ios but the manifest has no ios section');
  if (android && config.channel === 'play') {
    if (!manifest.android.bundle) throw new Error(`android_channel=play needs an android.bundle hook and ${manifest.android.package} declares none; Play stays blocked on the release keystore, Gradle template and versionCode decisions. Use android_channel=sideload.`);
    if (!config.dryRun && (!env.HUB_WIF_PROVIDER || !env.HUB_PLAY_SA)) throw new Error('a real Play run needs wif_provider and play_sa (the caller passes vars.GCP_WIF_PROVIDER and vars.PLAY_SA_EMAIL)');
  }
  const found = parseVersion(run('bash', ['-eo', 'pipefail', '-c', manifest.version], { cwd: config.cwd, env: hookEnvironment(config, env) }), { needAndroid: android });
  const tag = tagVersion(env);
  if (tag && tag !== found.version) throw new Error(`tag v${tag} differs from the version ${found.version} in the presets; bump the presets or move the tag`);
  const outputs = {
    version: found.version,
    android_code: found.android_code ?? '',
    run_android: android,
    run_ios: ios,
    dry_run: config.dryRun,
    channel: config.channel,
    schema: 1,
    run_ios_export: ios,
    build_sha: env.GITHUB_SHA ?? '',
    bump_patch: '',
    play_lane: android && config.channel === 'play',
    release_lane: android && config.channel === 'sideload',
  };
  await setOutputs(outputs, env);
  console.log(`HUB_PLAN version=${found.version} android_code=${found.android_code ?? '-'} platform=${config.platform} channel=${config.channel} dry_run=${config.dryRun} (manifest schema 1: v2 run, no bump, no installs, no event)`);
  return outputs;
}

// A representative completed event for this app, held to the schema before any version is spent.
function sampleEvent({ manifest, devices, scope, version, androidCode, commit, env }) {
  const needs = { plan: { result: 'success' }, android: { result: 'success' }, ios: { result: 'success' }, 'ios-export': { result: 'success' } };
  const receipts = {
    android: { delivery: { platform: 'android', target: devices.android.model, version, build: String(androidCode ?? 1), sha256: '0'.repeat(64), verified: true } },
    ios: { delivery: { platform: 'ios', target: devices.ios.model, version, build: '1', sha256: '0'.repeat(64), verified: true } },
  };
  return deploymentEvent({ manifest, devices, scope, needs, receipts, version, androidCode, commit, env });
}

// bb-emit validates against the live bloodbank checkout, so the contract it enforces must be committed there, and
// the event this deploy will send must pass it. A real run stops here, before any version is spent; a dry run
// records the gap and goes on to prove the device lanes, and its announce job still fails on the same check.
async function eventPreflight({ config, manifest, devices, scope, version, androidCode, commit, env, home, notes }) {
  const tree = bloodbankTree({ env, home });
  const problems = [];
  if (tree.commit && tree.dirty && tree.dirty.length > 0) problems.push(`the Bloodbank contract files bb-emit validates against are uncommitted in ${basename(tree.root)} (${tree.dirty.slice(0, 4).join(', ')}); commit the schema edit so the contract is reproducible`);
  const sample = sampleEvent({ manifest, devices, scope, version, androidCode, commit, env });
  try {
    bbEmit({ type: sample.type, data: sample.data, correlation: correlationFor(env), check: true, env, home });
    notes.push(`event contract: ${sample.type} passes bb-emit --check${tree.commit ? ` (bloodbank ${short(tree.commit)})` : ''}`);
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

async function planV3(config, manifest, { env, home, track }) {
  const devices = loadDevices(env);
  const scope = scopeOf({ platform: config.platform, manifest });
  // both means every lane the manifest declares; naming one platform needs that section.
  if (config.platform === 'android' && !manifest.android) throw new Error('platform android but the manifest has no android section');
  if (config.platform === 'ios' && !manifest.ios) throw new Error('platform ios but the manifest has no ios section');
  if (config.testflight && !scope.ios) throw new Error('--testflight needs the iOS lane (platform both or ios)');
  if (config.testflight && !manifest.ios.store) throw new Error(`--testflight is for an app with ios.store; ${manifest.project.slug} has no App Store Connect app in its manifest`);
  if (config.play) {
    if (!scope.android) throw new Error('--play needs the Android lane (platform both or android)');
    if (!manifest.android.bundle) throw new Error(`--play needs an android.bundle hook and ${manifest.android.package} declares none; Play stays blocked on the Play launch spec`);
    if (!config.dryRun && (!env.HUB_WIF_PROVIDER || !env.HUB_PLAY_SA)) throw new Error('a real Play run needs wif_provider and play_sa (the caller passes vars.GCP_WIF_PROVIDER and vars.PLAY_SA_EMAIL)');
  }
  const onMain = env.GITHUB_REF === 'refs/heads/main';
  if (!config.dryRun && !onMain) throw new Error(`a real deploy bumps main, so it must be dispatched on main (this run is on ${env.GITHUB_REF ?? 'no ref'})`);
  if (scope.ios && !config.ipadVersion) throw new Error('the iPad state is unknown: preflight-ios must run before plan when iOS is in scope');
  await setOutputs({
    schema: 2,
    project_slug: manifest.project.slug,
    run_android: scope.android,
    run_ios: scope.ios,
    run_ios_export: scope.ios && Boolean(manifest.ios.export),
    play_lane: scope.android && config.play,
    release_lane: scope.android,
  }, env);

  const notes = [];
  const hooks = hookEnvironment(config, env, { HUB_TEAM: devices.apple.team });
  const readVersion = () => parseVersionInfo(hookOutput('version.read', manifest.version.read, { cwd: config.cwd, env: hooks }), { needAndroid: scope.android });

  // Device preflight, before any version is spent.
  track.stage = 'preflight';
  let phone = null;
  if (scope.android) {
    phone = await withLock('adb', async () => {
      const adb = createAdb({ env, home });
      const id = await findPhone(adb, { serial: devices.android.serial, model: devices.android.model, waitMs: Number(env.HUB_ADB_WAIT_MS) || 180_000 });
      return adb.installed(id, manifest.android.package);
    }, { env, timeoutMs: 20 * 60_000 });
    notes.push(`S26 ${devices.android.model}: ${phone ? `${manifest.android.package} ${phone.versionName} (${phone.versionCode}) installed` : `${manifest.android.package} not installed`}`);
  }
  if (scope.ios) notes.push(`iPad ${devices.ios.model}: ${config.ipadVersion === 'absent' ? `${manifest.ios.bundle} not installed` : `${manifest.ios.bundle} ${config.ipadVersion} (${config.ipadBuild || '-'}) installed`}`);

  const current = readVersion();
  track.receipt = { version: current.version, androidCode: current.android_code };
  const tree = await eventPreflight({ config, manifest, devices, scope, version: current.version, androidCode: current.android_code, commit: env.GITHUB_SHA || '0000000', env, home, notes });

  track.stage = 'version';
  const git = createGit({ cwd: config.cwd, env, token: env.GH_TOKEN });
  const runUrl = env.GITHUB_RUN_ID ? `${env.GITHUB_SERVER_URL ?? 'https://github.com'}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}` : 'a local run';
  const result = await bumpTransaction({
    git,
    level: config.bump,
    dryRun: config.dryRun,
    onMain,
    readVersion,
    runBump: level => parseVersionInfo(hookOutput('version.bump', manifest.version.bump, { cwd: config.cwd, env: hooks, args: [level] }), { hook: 'version.bump', needAndroid: scope.android, needFiles: true }),
    beforeCommit: ({ bumped }) => {
      if (phone && bumped.android_code !== undefined && bumped.android_code <= phone.versionCode) {
        track.stage = 'preflight';
        throw new Error(`the S26 already has ${manifest.android.package} versionCode ${phone.versionCode}, at or above the planned ${bumped.android_code}; Android would refuse the update. Bump past it (--bump minor) or find out what installed that build`);
      }
    },
    message: ({ current: from, bumped, level }) => `chore(release): v${bumped.version}\n\nVersion ${from.version} -> ${bumped.version} (${level}) by mobile-deploy-hub, ${runUrl}.`,
  });
  const next = result.next;

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
  };
  await setOutputs(outputs, env);
  track.receipt = { version: next.version, androidCode: next.android_code };
  const bump = { level: config.bump, from: result.current.version, to: next.version, tag: result.tag, files: result.files, committed: result.committed, rehearsed: result.rehearsed === true, attempts: result.attempts, base: result.base };
  notes.push(result.committed ? `bumped ${result.current.version} -> ${next.version}, pushed ${result.tag} at ${short(result.sha)}` : `dry run: would bump ${result.current.version} -> ${next.version} (${result.files.join(', ')}); commit, tag and git push --dry-run rehearsed, then rewound: nothing reached the remote`);
  await writeReceipt(join(config.out, 'plan'), buildReceipt({
    lane: 'plan', config: { ...config, buildSha: result.sha }, env, version: next.version, androidCode: next.android_code, build: next.ios_build, notes,
    bump, devices: { s26: phone, ipad: scope.ios ? { version: config.ipadVersion, build: config.ipadBuild || null } : null }, bloodbank: { commit: tree.commit, clean: tree.dirty ? tree.dirty.length === 0 : null },
  }), env);
  console.log(`HUB_PLAN version=${result.current.version} next=${next.version} android_code=${next.android_code ?? '-'} platform=${config.platform} bump=${config.bump} dry_run=${config.dryRun} build_sha=${short(result.sha)}`);
  return { ...outputs, schema: 2, run_android: scope.android, run_ios: scope.ios };
}

export async function plan(config, { env = process.env, home = homedir() } = {}) {
  const manifest = await loadManifest(config.cwd, config.manifest);
  if (manifest.schema === 1) return planV2(config, manifest, { env });
  return guarded('plan', join(config.out, 'plan'), config, env, track => planV3(config, manifest, { env, home, track }));
}

// ---------------------------------------------------------------------------------------------------- shared

// The app's own receipt names the version it built; it must be the version the plan announced.
async function checkAppReceipt(path, config, label) {
  const receipt = JSON.parse(await readFile(path, 'utf8'));
  if (config.version && receipt.version && receipt.version !== config.version) throw new Error(`${label} says version ${receipt.version} but the plan says ${config.version}`);
  if (config.androidCode && receipt.version_code !== undefined && String(receipt.version_code) !== config.androidCode) throw new Error(`${label} says versionCode ${receipt.version_code} but the plan says ${config.androidCode}`);
  return receipt;
}

// A dry run builds the next version without committing it: the plan's bump, applied to this job's checkout.
function applyBump(config, env) {
  if (!config.dryRun || !config.bumpPatch) return false;
  createGit({ cwd: config.cwd, env }).apply(Buffer.from(config.bumpPatch, 'base64'));
  console.log('HUB_BUMP_APPLIED the plan\'s version bump, to this checkout only (dry run)');
  return true;
}

function requirePlan(config) {
  if (!semver.test(config.version)) throw new Error('this lane needs the plan\'s version (HUB_VERSION)');
}

// ---------------------------------------------------------------------------------------------------- android

async function androidV2(config, manifest, { env, home }) {
  const spec = manifest.android ?? (() => { throw new Error('the manifest has no android section'); })();
  const out = join(config.out, 'android');
  await mkdir(out, { recursive: true });
  const hooks = hookEnvironment(config, env);
  if (spec.prepare) hook('android.prepare', spec.prepare, { cwd: config.cwd, env: hooks });

  const bundle = config.channel === 'play';
  const relative = bundle ? spec.bundle_artifact : spec.artifact;
  if (bundle) {
    if (!spec.bundle) throw new Error('android_channel=play needs an android.bundle hook');
    hook('android.bundle', spec.bundle, { cwd: config.cwd, env: hooks });
  } else if (spec.export) {
    hook('android.export', spec.export, { cwd: config.cwd, env: hooks });
  } else {
    await exportGodot({ project: join(config.cwd, spec.godot.path), preset: spec.godot.preset, output: join(config.cwd, relative), env: hooks });
  }

  const built = join(config.cwd, relative);
  if (!await exists(built)) throw new Error(`the export hook did not produce ${relative}`);
  const copy = join(out, basename(relative));
  await copyFile(built, copy);
  const artifacts = [{ name: basename(relative), sha256: await sha256File(copy) }];

  let signer;
  if (!bundle) {
    signer = verifySigner({ apk: built, expected: spec.signer_sha256, env, home }).signer_sha256;
    console.log(`APK_SIGNER_OK ${signer}`);
  }
  if (spec.receipt && await exists(join(config.cwd, spec.receipt))) {
    await checkAppReceipt(join(config.cwd, spec.receipt), config, spec.receipt);
    await copyFile(join(config.cwd, spec.receipt), join(out, basename(spec.receipt)));
  }
  const notes = [`${bundle ? 'AAB for Play' : 'debug-signed APK for sideload'}; ${config.dryRun ? 'dry run, nothing is published' : 'real run'}`];
  await writeReceipt(out, buildReceipt({ lane: 'android', config, env, version: config.version, androidCode: config.androidCode, artifacts, signer, notes }), env);
  console.log(`HUB_ANDROID_BUILT ${basename(relative)} sha256=${artifacts[0].sha256}`);
  return { out, artifact: copy, sha256: artifacts[0].sha256, signer };
}

async function androidV3(config, manifest, { env, home, track }) {
  const spec = manifest.android ?? (() => { throw new Error('the manifest has no android section'); })();
  const devices = loadDevices(env);
  requirePlan(config);
  const out = join(config.out, 'android');
  await mkdir(out, { recursive: true });
  track.receipt = { version: config.version, androidCode: config.androidCode };

  track.stage = 'build';
  applyBump(config, env);
  const hooks = hookEnvironment(config, env, { HUB_TEAM: devices.apple.team });
  if (spec.prepare) hook('android.prepare', spec.prepare, { cwd: config.cwd, env: hooks });
  if (spec.export) hook('android.export', spec.export, { cwd: config.cwd, env: hooks });
  else await exportGodot({ project: join(config.cwd, spec.godot.path), preset: spec.godot.preset, output: join(config.cwd, spec.artifact), env: hooks });
  const built = join(config.cwd, spec.artifact);
  if (!await exists(built)) throw new Error(`the export hook did not produce ${spec.artifact}`);
  const apk = join(out, basename(spec.artifact));
  await copyFile(built, apk);
  const sha256 = await sha256File(apk);
  const artifacts = [{ name: basename(spec.artifact), sha256 }];
  track.receipt.artifacts = artifacts;
  const signer = verifySigner({ apk, expected: spec.signer_sha256, env, home }).signer_sha256;
  console.log(`APK_SIGNER_OK ${signer}`);
  const identity = apkIdentity({ apk, env, home });
  if (identity.package !== spec.package) throw new Error(`the APK is ${identity.package}, the manifest pins ${spec.package}`);
  if (identity.versionName !== config.version || String(identity.versionCode) !== config.androidCode) throw new Error(`the APK carries ${identity.versionName} (${identity.versionCode}) but the plan says ${config.version} (${config.androidCode}); the bump did not reach the export`);
  if (spec.receipt && await exists(join(config.cwd, spec.receipt))) {
    await checkAppReceipt(join(config.cwd, spec.receipt), config, spec.receipt);
    await copyFile(join(config.cwd, spec.receipt), join(out, basename(spec.receipt)));
  }
  if (config.play) {
    hook('android.bundle', spec.bundle, { cwd: config.cwd, env: hooks });
    const aab = join(config.cwd, spec.bundle_artifact);
    if (!await exists(aab)) throw new Error(`the bundle hook did not produce ${spec.bundle_artifact}`);
    await copyFile(aab, join(out, basename(spec.bundle_artifact)));
    artifacts.push({ name: basename(spec.bundle_artifact), sha256: await sha256File(join(out, basename(spec.bundle_artifact))) });
  }
  console.log(`HUB_ANDROID_BUILT ${basename(spec.artifact)} ${config.version} (${config.androidCode}) sha256=${sha256}`);

  const planned = Number(config.androidCode);
  const delivery = { platform: 'android', target: devices.android.model, version: config.version, build: String(planned), sha256, verified: false };
  track.receipt.delivery = delivery;
  const notes = [];
  track.stage = 'preflight';
  await withLock('adb', async () => {
    const adb = createAdb({ env, home });
    const id = await findPhone(adb, { serial: devices.android.serial, model: devices.android.model, waitMs: Number(env.HUB_ADB_WAIT_MS) || 180_000 });
    const before = adb.installed(id, spec.package);
    const was = before ? `${before.versionName} (${before.versionCode})` : 'nothing';
    if (before && before.versionCode > planned) throw new Error(`the S26 has versionCode ${before.versionCode}, above the planned ${planned}; Android would refuse the update (the hub never downgrades)`);
    if (before && before.versionCode === planned) {
      // Only "Re-run failed jobs" of this deploy gets here: the plan refuses a code the phone already has, and the
      // version is new. An earlier attempt installed it; the same bytes are verified, other bytes reinstall in place.
      if (before.versionName !== config.version) throw new Error(`the S26 has versionCode ${planned} as ${before.versionName}, not ${config.version}; something else installed that code`);
      const onDevice = adb.sha256(id, adb.baseApk(id, spec.package));
      if (onDevice === sha256) {
        delivery.verified = true;
        notes.push(`rerun: the S26 already runs ${was} with this APK (base.apk sha256 matches); not installed again`);
        console.log(`HUB_S26_CURRENT ${was} sha256 verified`);
        return;
      }
      notes.push(`rerun: the S26 runs ${was} from an earlier attempt's build; this attempt's APK replaces it in place`);
    }
    if (config.dryRun) {
      notes.push(`dry run: would install ${config.version} (${planned}) over ${was} on the S26`);
      console.log(`HUB_S26_DRY_RUN would install ${config.version} (${planned}) over ${was}`);
      return;
    }
    track.stage = 'install';
    adb.install(id, apk);
    track.stage = 'verify';
    const after = adb.installed(id, spec.package);
    if (!after || after.versionCode !== planned || after.versionName !== config.version) throw new Error(`readback: the S26 reports ${after ? `${after.versionName} (${after.versionCode})` : 'no package'} after the install, expected ${config.version} (${planned})`);
    const onDevice = adb.sha256(id, adb.baseApk(id, spec.package));
    if (onDevice !== sha256) throw new Error(`readback: base.apk on the S26 has sha256 ${onDevice}, the built APK has ${sha256}`);
    delivery.verified = true;
    notes.push(`installed on the S26 over ${was}; readback ${config.version} (${planned}), base.apk sha256 matches`);
    console.log(`HUB_S26_INSTALLED ${config.version} (${planned}) over ${was}, sha256 verified`);
  }, { env, timeoutMs: 20 * 60_000 });

  await writeReceipt(out, buildReceipt({ lane: 'android', config, env, version: config.version, androidCode: config.androidCode, artifacts, signer, notes, delivery }), env);
  return { out, artifact: apk, sha256, signer, delivery };
}

export async function android(config, { env = process.env, home = homedir() } = {}) {
  const manifest = await loadManifest(config.cwd, config.manifest);
  if (manifest.schema === 1) return androidV2(config, manifest, { env, home });
  return guarded('android', join(config.out, 'android'), config, env, track => androidV3(config, manifest, { env, home, track }));
}

// ---------------------------------------------------------------------------------------------------- play and release

export async function play(config, { env = process.env, fetchImpl } = {}) {
  if (config.dryRun) throw new Error('refusing to contact Play on a dry run');
  const manifest = await loadManifest(config.cwd, config.manifest);
  if (manifest.schema === 1 ? config.channel !== 'play' : !config.play) throw new Error(manifest.schema === 1 ? 'the play command needs android_channel=play' : 'the play command needs --play true');
  const spec = manifest.android;
  if (!spec?.bundle_artifact) throw new Error('the manifest declares no android.bundle_artifact');
  return uploadBundle({
    pkg: spec.package,
    track: config.track,
    aab: join(config.out, 'android', basename(spec.bundle_artifact)),
    token: env.PLAY_TOKEN,
    expectedCode: config.androidCode ? Number(config.androidCode) : undefined,
    status: config.playStatus,
    fetchImpl,
  });
}

export function releaseArguments({ tag, repo, sha, title, notes, assets, verifyTag = false }) {
  return ['release', 'create', tag, ...assets, '--repo', repo, '--target', sha, '--title', title, '--notes', notes, ...(verifyTag ? ['--verify-tag'] : [])];
}

export async function release(config, { env = process.env } = {}) {
  if (config.dryRun) throw new Error('refusing to publish a release on a dry run');
  const manifest = await loadManifest(config.cwd, config.manifest);
  if (manifest.schema === 1 && config.channel !== 'sideload') throw new Error('only the sideload channel publishes a GitHub Release');
  if (!semver.test(config.version)) throw new Error('release needs the plan version');
  if (!env.GH_TOKEN) throw new Error('GH_TOKEN is empty; the caller must grant contents: write');
  const spec = manifest.android ?? (() => { throw new Error('the manifest has no android section'); })();
  const out = join(config.out, 'android');
  const assets = [basename(spec.artifact), ...(spec.receipt ? [basename(spec.receipt)] : []), 'hub-receipt-android.json'].map(name => join(out, name));
  for (const asset of assets) if (!await exists(asset)) throw new Error(`release asset missing: ${asset}`);
  const tag = `v${config.version}`;
  const repo = env.GITHUB_REPOSITORY;
  if (!repo) throw new Error('GITHUB_REPOSITORY is not set');
  // The commit the APK was built from: the bump commit on a v3 run, never the commit before it.
  const sha = config.buildSha || env.GITHUB_SHA || 'HEAD';
  const digest = await sha256File(join(out, basename(spec.artifact)));
  const notes = [`Android sideload build ${config.version}${config.androidCode ? ` (versionCode ${config.androidCode})` : ''}.`, `Commit ${sha}, run ${env.GITHUB_RUN_ID ?? 'local'}.`, `${basename(spec.artifact)} sha256 ${digest}.`, 'Debug-signed with the pinned key, so it installs over the previous build. Install: gh release download ' + tag + ' -p "*.apk" -D artifacts --clobber && mise run android:install'].join('\n');
  const existing = spawnSync('gh', ['release', 'view', tag, '--repo', repo], { env, stdio: 'ignore' });
  if (existing.status === 0) {
    // v3: the plan never reuses a version, so the Release of this tag came from an earlier attempt of this deploy
    // ("Re-run failed jobs"). Its assets are replaced by this attempt's, which is what the S26 now runs.
    if (manifest.schema === 2) {
      run('gh', ['release', 'upload', tag, ...assets, '--repo', repo, '--clobber'], { env, cwd: config.cwd });
      console.log(`HUB_RELEASE_UPDATED ${tag} ${repo}: an earlier attempt published it; assets replaced by this attempt's`);
      return { tag, repo, assets, updated: true };
    }
    throw new Error(`release ${tag} already exists in ${repo}; bump the version or delete that release first`);
  }
  run('gh', releaseArguments({ tag, repo, sha, title: `Android ${config.version}`, notes, assets, verifyTag: manifest.schema === 2 }), { env, cwd: config.cwd });
  console.log(`HUB_RELEASED ${tag} ${repo}`);
  return { tag, repo, assets };
}

// ---------------------------------------------------------------------------------------------------- ios export (Linux)

async function iosExportV2(config, manifest, { env }) {
  const spec = manifest.ios ?? (() => { throw new Error('the manifest has no ios section'); })();
  const out = join(config.out, 'ios');
  await mkdir(out, { recursive: true });
  const hooks = hookEnvironment(config, env);
  if (spec.prepare) hook('ios.prepare', spec.prepare, { cwd: config.cwd, env: hooks });
  hook('ios.export', spec.export, { cwd: config.cwd, env: hooks });
  const archive = join(out, spec.archive);
  const receiptFile = join(out, spec.receipt);
  if (!await exists(archive)) throw new Error(`the export hook did not produce ${spec.archive} in $HUB_OUT/ios`);
  if (!await exists(receiptFile)) throw new Error(`the export hook did not produce ${spec.receipt} in $HUB_OUT/ios`);
  const receipt = await checkAppReceipt(receiptFile, config, spec.receipt);
  if (receipt.bundle && receipt.bundle !== spec.bundle) throw new Error(`${spec.receipt} names bundle ${receipt.bundle}, the manifest pins ${spec.bundle}`);
  const digest = await sha256File(archive);
  if (receipt.tarball_sha256 && receipt.tarball_sha256 !== digest) throw new Error(`${spec.archive} sha256 ${digest} differs from the receipt ${receipt.tarball_sha256}`);
  const artifacts = [{ name: spec.archive, sha256: digest }];
  await writeReceipt(out, buildReceipt({ lane: 'ios-export', config, env, version: receipt.version ?? config.version, build: receipt.build, artifacts, notes: ['Xcode project exported on Linux; nothing is uploaded'] }), env);
  console.log(`HUB_IOS_EXPORTED ${spec.archive} sha256=${digest}`);
  return { out, sha256: digest, receipt };
}

// One exported Xcode project: present, for this bundle and version, and the distribution it claims. The iPad's
// project must be the PRIVATE staging: a store staging (Tower's bundled_only feature) turns off remote packs.
async function checkExport(out, archiveName, receiptName, { config, spec, distribution }) {
  const archive = join(out, archiveName);
  const receiptFile = join(out, receiptName);
  if (!await exists(archive)) throw new Error(`the export hook did not produce ${archiveName} in $HUB_OUT/ios`);
  if (!await exists(receiptFile)) throw new Error(`the export hook did not produce ${receiptName} in $HUB_OUT/ios`);
  const receipt = await checkAppReceipt(receiptFile, config, receiptName);
  if (receipt.bundle && receipt.bundle !== spec.bundle) throw new Error(`${receiptName} names bundle ${receipt.bundle}, the manifest pins ${spec.bundle}`);
  if (distribution === 'private' && receipt.distribution !== 'private') throw new Error(`${receiptName} must say "distribution": "private": the iPad gets the private staging, never the store one (bundled_only hides remote packs), got ${JSON.stringify(receipt.distribution)}`);
  if (distribution === 'store' && receipt.distribution !== undefined && receipt.distribution !== 'store') throw new Error(`${receiptName} says distribution ${receipt.distribution}; TestFlight takes the store staging`);
  const digest = await sha256File(archive);
  if (receipt.tarball_sha256 && receipt.tarball_sha256 !== digest) throw new Error(`${archiveName} sha256 ${digest} differs from the receipt ${receipt.tarball_sha256}`);
  return [{ name: archiveName, sha256: digest }, { name: receiptName, sha256: await sha256File(receiptFile) }];
}

async function iosExportV3(config, manifest, { env, track }) {
  const spec = manifest.ios ?? (() => { throw new Error('the manifest has no ios section'); })();
  if (!spec.export) throw new Error(`${manifest.project.slug} has no ios.export; its iPad build happens on the Mac (ios.device)`);
  const devices = loadDevices(env);
  requirePlan(config);
  const out = join(config.out, 'ios');
  await mkdir(out, { recursive: true });
  track.receipt = { version: config.version };
  track.stage = 'build';
  applyBump(config, env);
  const hooks = hookEnvironment(config, env, { HUB_TEAM: devices.apple.team });
  if (spec.prepare) hook('ios.prepare', spec.prepare, { cwd: config.cwd, env: hooks });
  hook('ios.export', spec.export, { cwd: config.cwd, env: hooks });
  const artifacts = await checkExport(out, spec.archive, spec.receipt, { config, spec, distribution: 'private' });
  if (config.testflight) artifacts.push(...await checkExport(out, spec.store.archive, spec.store.receipt, { config, spec, distribution: 'store' }));
  track.receipt.artifacts = artifacts;
  const notes = [`Xcode projects exported on Linux: ${artifacts.filter(item => item.name.endsWith('.tgz')).map(item => item.name).join(', ')}`];
  if (!config.dryRun || config.dryHandoff) {
    track.stage = 'build';
    const sent = sendHandoff({ host: devices.mac.host, base: devices.mac.handoff_dir, files: artifacts.map(item => join(out, item.name)), env });
    notes.push(`handed to ${devices.mac.host}:${sent} over the LAN (no artifact quota)`);
  } else {
    notes.push('handoff skipped: a dry run ships the Xcode project to the Mac only with dry_handoff=true, so the iPad build is not checked');
  }
  await writeReceipt(out, buildReceipt({ lane: 'ios-export', config, env, version: config.version, build: config.iosBuild || null, artifacts, notes, handoff: !config.dryRun || config.dryHandoff }), env);
  console.log(`HUB_IOS_EXPORTED ${artifacts.map(item => `${item.name}=${short(item.sha256)}`).join(' ')}`);
  return { out, artifacts };
}

export async function iosExport(config, { env = process.env } = {}) {
  const manifest = await loadManifest(config.cwd, config.manifest);
  if (manifest.schema === 1) return iosExportV2(config, manifest, { env });
  return guarded('ios-export', join(config.out, 'ios'), config, env, track => iosExportV3(config, manifest, { env, track }));
}

// ---------------------------------------------------------------------------------------------------- Mac: secrets, preflight

// Reads one reference and discards the value. stderr goes to a file, not a pipe: `op read` leaves an `op daemon`
// behind that keeps a pipe open, and spawnSync would wait on it even after the timeout killed `op read`.
function readSecretRef(ref, { env, timeout }) {
  const dir = mkdtempSync(join(tmpdir(), 'hub-op-'));
  const file = join(dir, 'stderr');
  const fd = openSync(file, 'w');
  try {
    const read = spawnSync('op', ['read', '--no-newline', ref], { env, stdio: ['ignore', 'ignore', fd], timeout, killSignal: 'SIGKILL' });
    closeSync(fd);
    const stderr = readFileSync(file, 'utf8');
    if (read.error?.code === 'ETIMEDOUT') return { ok: false, timedOut: true, stderr };
    return { ok: !read.error && read.status === 0, timedOut: false, stderr: stderr || read.error?.message || '' };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

// Each reference must resolve; values are discarded unread and only reference names are printed. A strict run (a
// real one, or a dry run left at the default) fails when 1Password does not answer; only strict=false warns.
function checkSecrets(refs, { config, env, notes }) {
  const opTimeout = Number(env.HUB_OP_TIMEOUT_MS) > 0 ? Number(env.HUB_OP_TIMEOUT_MS) : 45_000;
  let verified = 0;
  for (const ref of refs) {
    const read = readSecretRef(ref, { env, timeout: opTimeout });
    if (read.timedOut) {
      const why = `op did not answer within ${opTimeout / 1000}s reading ${ref}: 1Password is waiting for a person on the Mac (screen locked, or the app wants approval). Unlock the Mac, approve 1Password and run again.`;
      if (!config.dryRun || config.strict) throw new Error(why);
      console.log(`::warning::${why}`);
      notes.push(`UNVERIFIED: ${refs.length - verified} secret references were not checked (${why})`);
      return false;
    }
    if (!read.ok) throw new Error(`op could not read ${ref}: ${read.stderr.trim().slice(0, 300)}`);
    verified += 1;
  }
  if (refs.length > 0) notes.push(`${refs.length} secret references resolve (values not read into the log)`);
  return true;
}

// v2 Mac preflight. Reads only: checks the handoff, the toolchain, the signing identity and the secret references.
async function iosPreflightV2(config, spec, { env }) {
  const out = join(config.out, 'ios');
  const receiptFile = join(out, spec.receipt);
  if (!await exists(receiptFile)) throw new Error(`${spec.receipt} is missing from the downloaded ios-receipt artifact`);
  const receipt = await checkAppReceipt(receiptFile, config, spec.receipt);
  if (receipt.bundle && receipt.bundle !== spec.bundle) throw new Error(`${spec.receipt} names bundle ${receipt.bundle}, the manifest pins ${spec.bundle}`);
  const archive = join(out, spec.archive);
  const notes = [];
  if (await exists(archive)) {
    const digest = await sha256File(archive);
    if (receipt.tarball_sha256 !== digest) throw new Error(`${spec.archive} sha256 ${digest} differs from the receipt ${receipt.tarball_sha256}`);
    const listing = run('tar', ['-tzf', archive], { env });
    if (!/(^|\/)[^/\n]+\.xcodeproj\//m.test(listing)) throw new Error(`${spec.archive} holds no .xcodeproj`);
    notes.push(`handoff verified: ${spec.archive} sha256 matches the receipt and holds an .xcodeproj`);
  } else if (config.dryRun && !config.dryHandoff) {
    notes.push('handoff not exercised: the dry run skipped the archive (set dry_handoff=true to ship it to the Mac)');
  } else {
    throw new Error(`${spec.archive} is missing from the downloaded xcode-project artifact`);
  }
  console.log(run('xcodebuild', ['-version'], { env }).trim());
  const found = run('security', ['find-identity', '-v', '-p', 'codesigning'], { env });
  if (spec.signer_sha1 && !found.toUpperCase().includes(spec.signer_sha1)) throw new Error(`the pinned signing identity ${spec.signer_sha1} is not a valid codesigning identity in this keychain`);
  notes.push(`signing identity ${spec.signer_sha1 ?? 'present'} is valid in the keychain`);
  checkSecrets(spec.secrets ?? [], { config, env, notes });
  return { receipt, notes };
}

export async function iosUpload(config, { env = process.env } = {}) {
  const manifest = await loadManifest(config.cwd, config.manifest);
  if (manifest.schema !== 1) throw new Error('ios-upload is the v2 TestFlight lane; a schema 2 manifest deploys with the ios command');
  const spec = manifest.ios ?? (() => { throw new Error('the manifest has no ios section'); })();
  const out = join(config.out, 'ios');
  const { receipt, notes } = await iosPreflightV2(config, spec, { env });
  if (config.dryRun) {
    notes.push('dry run: upload and assign were not called');
    console.log('HUB_IOS_DRY_RUN upload and assign skipped');
  } else {
    const hooks = hookEnvironment(config, env);
    hook('ios.upload', spec.upload, { cwd: config.cwd, env: hooks });
    hook('ios.assign', spec.assign, { cwd: config.cwd, env: hooks });
    notes.push('uploaded and assigned by the app hooks (Owner Testing only)');
  }
  // upload rewrites the receipt with the build number it really used, so read it again.
  const final = config.dryRun ? receipt : JSON.parse(await readFile(join(out, spec.receipt), 'utf8'));
  await writeReceipt(out, buildReceipt({ lane: 'ios-upload', config, env, version: final.version ?? config.version, build: final.build, notes }), env);
  return { out, notes };
}

function checkDisk(path, devices) {
  const free = freeGiB(path);
  if (free < devices.mac.min_free_gib) throw new Error(`the Mac has ${free.toFixed(1)} GiB free; an iOS build needs ${devices.mac.min_free_gib} GiB. Free space (old Xcode archives, DerivedData) and run again`);
  return free;
}

// Mac preflight for v3, before the plan spends a version: the iPad answers, the development identity signs, a
// profile covers the iPad for 30+ days, the disk has room, and with --testflight the store refs resolve.
export async function preflightIos(config, { env = process.env, home = homedir() } = {}) {
  const manifest = await loadManifest(config.cwd, config.manifest);
  if (manifest.schema === 1) {
    console.log('HUB_PREFLIGHT_IOS skipped: manifest schema 1 (v2 run); the Mac checks run in the ios job');
    await setOutputs({ ipad_version: '', ipad_build: '' }, env);
    return { skipped: true };
  }
  if (!manifest.ios) {
    // The workflow cannot read the manifest before this job, so an app without an iPad lane (both = every declared
    // lane) passes here and the plan leaves the iOS jobs out. Only asking for ios by name is an error.
    if (config.platform === 'ios') throw new Error('platform ios but the manifest has no ios section');
    console.log('HUB_PREFLIGHT_IOS skipped: the manifest declares no ios section (no iPad lane)');
    await setOutputs({ ipad_version: '', ipad_build: '' }, env);
    return { skipped: true };
  }
  return guarded('preflight-ios', join(config.out, 'preflight'), config, env, async track => {
    track.stage = 'preflight';
    const spec = manifest.ios;
    const devices = loadDevices(env);
    const notes = [];
    const free = checkDisk(home, devices);
    notes.push(`${free.toFixed(1)} GiB free`);
    console.log(run('xcodebuild', ['-version'], { env }).trim());
    const signer = devices.apple.dev_signer_sha1;
    const valid = identities({ env });
    if (!valid.has(signer)) throw new Error(`the development identity ${signer.slice(0, 8)} is not a valid codesigning identity in this Mac's keychain`);
    signingProbe({ signer, env, timeoutMs: Number(env.HUB_SIGNING_TIMEOUT_MS) || 60_000 });
    notes.push(`signing probe passed with ${signer.slice(0, 8)} (the runner can use the private key)`);
    const profile = devProfile(installedProfiles({ env, home }), { team: devices.apple.team, udid: devices.ios.udid, signer, bundle: spec.bundle, minDays: devices.apple.profile_min_days });
    notes.push(`profile "${profile.name}" covers the iPad until ${profile.expires_at.slice(0, 10)}`);
    const ipad = createIpad({ devicectl: createDevicectl({ env }), udid: devices.ios.udid, model: devices.ios.model });
    const found = ipad.find();
    const installed = ipad.installed(spec.bundle);
    notes.push(`iPad ${devices.ios.model} (iOS ${found.os ?? '?'}, ${found.transport ?? '?'}): ${installed ? `${spec.bundle} ${installed.version} (${installed.build})` : `${spec.bundle} not installed`}`);
    if (config.testflight) {
      if (!spec.store) throw new Error(`--testflight is for an app with ios.store; ${manifest.project.slug} has none`);
      if (spec.store.signer_sha1 && !valid.has(spec.store.signer_sha1)) throw new Error(`the App Store identity ${spec.store.signer_sha1.slice(0, 8)} is not in this Mac's keychain`);
      checkSecrets(spec.store.secrets ?? [], { config, env, notes });
    }
    await setOutputs({ ipad_version: installed?.version || 'absent', ipad_build: installed?.build || 'absent' }, env);
    await writeReceipt(join(config.out, 'preflight'), buildReceipt({ lane: 'preflight-ios', config, env, notes, ipad: installed, profile: { name: profile.name, expires_at: profile.expires_at } }), env);
    console.log(`HUB_PREFLIGHT_IOS ok iPad=${installed ? `${installed.version}(${installed.build})` : 'absent'} profile=${profile.expires_at.slice(0, 10)}`);
    return { installed, profile, notes };
  });
}

// ---------------------------------------------------------------------------------------------------- Mac: the iPad

async function iosV3(config, manifest, { env, home, track }) {
  const spec = manifest.ios ?? (() => { throw new Error('the manifest has no ios section'); })();
  const devices = loadDevices(env);
  requirePlan(config);
  const out = join(config.out, 'ios');
  await mkdir(out, { recursive: true });
  track.receipt = { version: config.version };
  const notes = [];
  const delivery = { platform: 'ios', target: devices.ios.model, version: config.version, build: null, sha256: null, verified: false };
  track.receipt.delivery = delivery;

  track.stage = 'build';
  applyBump(config, env);
  const hooks = hookEnvironment(config, env, { HUB_TEAM: devices.apple.team });
  const handoff = Boolean(spec.export) && (!config.dryRun || config.dryHandoff);
  if (handoff) {
    const exportReceiptFile = join(out, 'hub-receipt-ios-export.json');
    if (!existsSync(exportReceiptFile)) throw new Error('hub-receipt-ios-export.json is missing (the ios-receipt artifact): the Mac cannot check the handoff');
    const exportReceipt = JSON.parse(readFileSync(exportReceiptFile, 'utf8'));
    const expected = Object.fromEntries((exportReceipt.artifacts ?? []).map(item => [item.name, item.sha256]));
    const names = [spec.archive, spec.receipt, ...(config.testflight ? [spec.store.archive, spec.store.receipt] : [])];
    await receiveHandoff({ names, expected, base: devices.mac.handoff_dir, into: out, env, home });
  }
  const canBuild = !spec.export || handoff;
  let ipa = null;

  await withLock('mac-ios', async () => {
    track.stage = 'preflight';
    checkDisk(home, devices);
    const ipad = createIpad({ devicectl: createDevicectl({ env }), udid: devices.ios.udid, model: devices.ios.model });
    ipad.find();
    const before = ipad.installed(spec.bundle);
    const was = before ? `${before.version} (${before.build})` : 'nothing';
    if (!canBuild) {
      notes.push('dry run without dry_handoff: the Xcode project stayed on big-chungus, so the iPad build and its IPA checks did not run');
      console.log('HUB_IPAD_SKIPPED dry run without dry_handoff');
      return;
    }
    track.stage = 'build';
    hook('ios.device', spec.device, { cwd: config.cwd, env: hooks });
    const artifact = join(out, spec.device_artifact);
    if (!existsSync(artifact)) throw new Error(`the ios.device hook did not leave ${spec.device_artifact} in $HUB_OUT/ios`);
    const ipaPath = spec.device_artifact.endsWith('.xcarchive')
      ? exportIpa({ archive: artifact, out: join(out, 'device-export'), team: devices.apple.team, env, timeoutMs: Number(env.HUB_EXPORT_TIMEOUT_MS) || 900_000 })
      : artifact;
    if (!statSync(ipaPath).isFile()) throw new Error(`${spec.device_artifact} is not an .ipa file`);
    const facts = inspectIpa({ ipa: ipaPath, into: join(out, 'ipa-check'), bundle: spec.bundle, version: config.version, team: devices.apple.team, udid: devices.ios.udid, signer: devices.apple.dev_signer_sha1, env });
    const sha256 = await sha256File(ipaPath);
    ipa = { verified: true, sha256, build: facts.build, signer: facts.signer, profile: facts.profile };
    Object.assign(delivery, { build: facts.build, sha256 });
    console.log(`HUB_IPA_OK ${facts.bundle} ${facts.version} (${facts.build}) signer=${facts.signer.slice(0, 8)} profile=${facts.profile.name}`);
    if (config.dryRun) {
      notes.push(`dry run: would install ${facts.version} (${facts.build}) over ${was} on the iPad`);
      console.log(`HUB_IPAD_DRY_RUN would install ${facts.version} (${facts.build}) over ${was}`);
      return;
    }
    track.stage = 'install';
    ipad.install(facts.app);
    track.stage = 'verify';
    const after = ipad.installed(spec.bundle);
    if (!after || after.version !== facts.version || after.build !== facts.build) throw new Error(`readback: the iPad reports ${after ? `${after.version} (${after.build})` : 'no app'} after the install, expected ${facts.version} (${facts.build})`);
    delivery.verified = true;
    notes.push(`installed on the iPad over ${was}; readback ${after.version} (${after.build})`);
    console.log(`HUB_IPAD_INSTALLED ${after.version} (${after.build}) over ${was}`);
  }, { env, timeoutMs: 40 * 60_000 });

  let testflight = null;
  if (config.testflight) {
    track.stage = 'install';
    if (config.dryRun) {
      testflight = 'dry run: upload and assign were not called';
    } else {
      hook('ios.store.upload', spec.store.upload, { cwd: config.cwd, env: hooks });
      hook('ios.store.assign', spec.store.assign, { cwd: config.cwd, env: hooks });
      testflight = 'uploaded and assigned to Owner Testing by the app hooks';
    }
    notes.push(`TestFlight: ${testflight}`);
  }
  await writeReceipt(out, buildReceipt({ lane: 'ios', config, env, version: config.version, build: delivery.build, notes, delivery, ipa, testflight }), env);
  return { out, delivery, ipa, notes };
}

export async function ios(config, { env = process.env, home = homedir() } = {}) {
  const manifest = await loadManifest(config.cwd, config.manifest);
  if (manifest.schema === 1) return iosUpload(config, { env });
  return guarded('ios', join(config.out, 'ios'), config, env, track => iosV3(config, manifest, { env, home, track }));
}

// ---------------------------------------------------------------------------------------------------- announce

function readReceipts(dir) {
  const found = {};
  const walk = folder => {
    let entries = [];
    try { entries = readdirSync(folder, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const path = join(folder, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/^hub-receipt-[\w-]+\.json$/.test(entry.name)) {
        try { const receipt = JSON.parse(readFileSync(path, 'utf8')); if (receipt?.lane) found[receipt.lane] = receipt; } catch { /* a torn receipt adds no detail */ }
      }
    }
  };
  walk(dir);
  return found;
}

function parseNeeds(text) {
  if (!text) return {};
  try { const needs = JSON.parse(text); return needs && typeof needs === 'object' ? needs : {}; } catch { throw new Error('HUB_NEEDS is not JSON (the workflow passes toJSON(needs))'); }
}

export async function announce(config, { env = process.env, home = homedir() } = {}) {
  const manifest = await loadManifest(config.cwd, config.manifest);
  if (manifest.schema === 1) {
    console.log('HUB_ANNOUNCE skipped: manifest schema 1 (v2 run) sends no event');
    return { skipped: true };
  }
  const devices = loadDevices(env);
  const scope = scopeOf({ platform: config.platform, manifest });
  const needs = parseNeeds(env.HUB_NEEDS);
  const receipts = readReceipts(env.HUB_RECEIPTS || join(config.out, 'receipts'));
  const planReceipt = receipts.plan;
  const planOutputs = needs.plan?.outputs ?? {};
  let version = planReceipt?.version || planOutputs.version || config.version || '';
  let androidCode = planReceipt?.android_code || planOutputs.android_code || '';
  if (!semver.test(version)) {
    // The plan stopped before it named the next version: the event names the version main is at.
    const current = parseVersionInfo(hookOutput('version.read', manifest.version.read, { cwd: config.cwd, env: hookEnvironment(config, env) }));
    version = current.version;
    androidCode = current.android_code ?? '';
  }
  const commit = planReceipt?.sha || planOutputs.build_sha || env.GITHUB_SHA || '';
  if (!/^[0-9a-f]{7,40}$/.test(commit)) throw new Error('announce cannot name the commit (no plan receipt and no GITHUB_SHA)');
  const extras = [];
  if (receipts.ios?.testflight && !config.dryRun && /uploaded/.test(receipts.ios.testflight)) extras.push('TestFlight');
  const event = deploymentEvent({ manifest, devices, scope, needs, receipts, version, androidCode: androidCode ? String(androidCode) : '', commit, env, extras });
  const correlation = correlationFor(env);
  bbEmit({ type: event.type, data: event.data, correlation, check: true, env, home });
  if (config.dryRun) {
    console.log(`HUB_EVENT_CHECKED ${event.type}: ${event.data.summary} (dry run, not sent)`);
    return { ...event, sent: false, correlation };
  }
  bbEmit({ type: event.type, data: event.data, correlation, check: false, env, home });
  console.log(`HUB_EVENT_SENT ${event.type}: ${event.data.summary}`);
  return { ...event, sent: true, correlation };
}

// ---------------------------------------------------------------------------------------------------- CLI

export async function main(argv = process.argv.slice(2), env = process.env) {
  const config = parseConfig(argv, env);
  const commands = { plan, android, play, release, 'ios-export': iosExport, 'ios-upload': iosUpload, 'preflight-ios': preflightIos, ios, announce };
  return commands[config.command](config, { env });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    const [first, ...rest] = error.message.split('\n');
    console.error(`::error::${first}`);
    if (rest.length > 0) console.error(rest.join('\n'));
    process.exitCode = 1;
  });
}
