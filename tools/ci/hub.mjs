#!/usr/bin/env node
// Mobile Deploy Hub tool. The reusable workflow (.github/workflows/mobile-deploy.yml) calls one command per
// job through actions/hub; the same commands run locally from an app checkout:
//
//   plan        read the manifest, validate inputs, check the tag against the presets version
//   android     prepare, export (APK for sideload, AAB for play), verify the signer, write receipts
//   play        upload the AAB to Play (real runs only)
//   release     publish the APK to a private GitHub Release (real sideload runs only)
//   ios-export  Linux half: run the app's export hook and check what it produced
//   ios-upload  Mac half: verify the handoff and toolchain; upload and assign only on a real run
//
// Hooks come from the app's committed manifest and run under bash in the app root. Nothing here reads a
// hook, a ref or a command from an event payload.
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs';
import { copyFile, mkdir, readFile, stat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifySigner } from './lib/android.mjs';
import { hookEnvironment, parseConfig } from './lib/config.mjs';
import { hook, run } from './lib/exec.mjs';
import { exportGodot } from './lib/godot.mjs';
import { loadManifest } from './lib/manifest.mjs';
import { uploadBundle } from './lib/play.mjs';
import { buildReceipt, setOutputs, sha256File, writeReceipt } from './lib/receipt.mjs';

const semver = /^\d+\.\d+\.\d+$/;
const exists = async path => stat(path).then(info => info.isFile() && info.size > 0, () => false);

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

export async function plan(config, { env = process.env } = {}) {
  const manifest = await loadManifest(config.cwd, config.manifest);
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
  };
  await setOutputs(outputs, env);
  console.log(`HUB_PLAN version=${found.version} android_code=${found.android_code ?? '-'} platform=${config.platform} channel=${config.channel} dry_run=${config.dryRun}`);
  return outputs;
}

// The app's own receipt names the version it built; it must be the version the plan announced.
async function checkAppReceipt(path, config, label) {
  const receipt = JSON.parse(await readFile(path, 'utf8'));
  if (config.version && receipt.version && receipt.version !== config.version) throw new Error(`${label} says version ${receipt.version} but the plan says ${config.version}`);
  if (config.androidCode && receipt.version_code !== undefined && String(receipt.version_code) !== config.androidCode) throw new Error(`${label} says versionCode ${receipt.version_code} but the plan says ${config.androidCode}`);
  return receipt;
}

export async function android(config, { env = process.env, home } = {}) {
  const manifest = await loadManifest(config.cwd, config.manifest);
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

export async function play(config, { env = process.env, fetchImpl } = {}) {
  if (config.dryRun) throw new Error('refusing to contact Play on a dry run');
  if (config.channel !== 'play') throw new Error('the play command needs android_channel=play');
  const manifest = await loadManifest(config.cwd, config.manifest);
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

export function releaseArguments({ tag, repo, sha, title, notes, assets }) {
  return ['release', 'create', tag, ...assets, '--repo', repo, '--target', sha, '--title', title, '--notes', notes];
}

export async function release(config, { env = process.env } = {}) {
  if (config.dryRun) throw new Error('refusing to publish a release on a dry run');
  if (config.channel !== 'sideload') throw new Error('only the sideload channel publishes a GitHub Release');
  if (!semver.test(config.version)) throw new Error('release needs the plan version');
  if (!env.GH_TOKEN) throw new Error('GH_TOKEN is empty; the caller must grant contents: write');
  const manifest = await loadManifest(config.cwd, config.manifest);
  const spec = manifest.android ?? (() => { throw new Error('the manifest has no android section'); })();
  const out = join(config.out, 'android');
  const assets = [basename(spec.artifact), ...(spec.receipt ? [basename(spec.receipt)] : []), 'hub-receipt-android.json'].map(name => join(out, name));
  for (const asset of assets) if (!await exists(asset)) throw new Error(`release asset missing: ${asset}`);
  const tag = `v${config.version}`;
  const repo = env.GITHUB_REPOSITORY;
  if (!repo) throw new Error('GITHUB_REPOSITORY is not set');
  const digest = await sha256File(join(out, basename(spec.artifact)));
  const notes = [`Android sideload build ${config.version}${config.androidCode ? ` (versionCode ${config.androidCode})` : ''}.`, `Commit ${env.GITHUB_SHA ?? 'unknown'}, run ${env.GITHUB_RUN_ID ?? 'local'}.`, `${basename(spec.artifact)} sha256 ${digest}.`, 'Debug-signed with the pinned key, so it installs over the previous build. Install: gh release download ' + tag + ' -p "*.apk" -D artifacts --clobber && mise run android:install'].join('\n');
  const existing = spawnSync('gh', ['release', 'view', tag, '--repo', repo], { env, stdio: 'ignore' });
  if (existing.status === 0) throw new Error(`release ${tag} already exists in ${repo}; bump the version or delete that release first`);
  run('gh', releaseArguments({ tag, repo, sha: env.GITHUB_SHA ?? 'HEAD', title: `Android ${config.version}`, notes, assets }), { env, cwd: config.cwd });
  console.log(`HUB_RELEASED ${tag} ${repo}`);
  return { tag, repo, assets };
}

export async function iosExport(config, { env = process.env } = {}) {
  const manifest = await loadManifest(config.cwd, config.manifest);
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

// Mac preflight. Reads only: checks the handoff, the toolchain, the signing identity and that each secret reference
// resolves. Values are discarded unread; only the reference names are printed.
async function iosPreflight(config, spec, { env }) {
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
  const identities = run('security', ['find-identity', '-v', '-p', 'codesigning'], { env });
  if (spec.signer_sha1 && !identities.toUpperCase().includes(spec.signer_sha1)) throw new Error(`the pinned signing identity ${spec.signer_sha1} is not a valid codesigning identity in this keychain`);
  notes.push(`signing identity ${spec.signer_sha1 ?? 'present'} is valid in the keychain`);
  // The desktop-app integration waits for a human when the Mac's screen is locked or the app wants approval, and
  // an unbounded `op read` then holds the runner until the job timeout. Bound it and say what is wrong.
  const opTimeout = Number(env.HUB_OP_TIMEOUT_MS) > 0 ? Number(env.HUB_OP_TIMEOUT_MS) : 45_000;
  const secrets = spec.secrets ?? [];
  let verified = 0;
  for (const ref of secrets) {
    const read = readSecretRef(ref, { env, timeout: opTimeout });
    if (read.timedOut) {
      const why = `op did not answer within ${opTimeout / 1000}s reading ${ref}: 1Password is waiting for a person on the Mac (screen locked, or the app wants approval). Unlock the Mac and run again.`;
      // A real run must stop before anything is uploaded. A dry run proves the pipeline, and a locked screen is a
      // condition of the Mac, not a defect of the pipeline, so it warns, records the gap and does not claim the check passed.
      if (!config.dryRun) throw new Error(why);
      console.log(`::warning::${why}`);
      notes.push(`UNVERIFIED: ${secrets.length - verified} secret references were not checked (${why})`);
      return { receipt, notes };
    }
    if (!read.ok) throw new Error(`op could not read ${ref}: ${read.stderr.trim().slice(0, 300)}`);
    verified += 1;
  }
  if (secrets.length > 0) notes.push(`${secrets.length} secret references resolve (values not read into the log)`);
  return { receipt, notes };
}

export async function iosUpload(config, { env = process.env } = {}) {
  const manifest = await loadManifest(config.cwd, config.manifest);
  const spec = manifest.ios ?? (() => { throw new Error('the manifest has no ios section'); })();
  const out = join(config.out, 'ios');
  const { receipt, notes } = await iosPreflight(config, spec, { env });
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

export async function main(argv = process.argv.slice(2), env = process.env) {
  const config = parseConfig(argv, env);
  const commands = { plan, android, play, release, 'ios-export': iosExport, 'ios-upload': iosUpload };
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
