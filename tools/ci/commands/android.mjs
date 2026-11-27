// android (Linux): build and check the APK as v3 did, stage it on big-chungus for deliver, then look for the S26 for
// 30 s: present means `adb install -r` and readback (installed), away means pending. Then Quickdrop (real runs, and
// only while the S26 syncs from the LAN; never over a newer APK). play and release publish after the build checks, S26
// or not; since v1.1.3 each writes its own receipt, so a failed upload is reported at stage deliver and never turns
// the S26's delivery into a failure.
//
// MOBI-14: an app may declare more signed editions (android.editions). Each one is built with its own hook (HUB_EDITION
// names it), checked against its own package, signer pin and the planned version, staged in its own folder and given
// its own receipt (lane android-edition-<name>), all before the S26 is looked at, so a broken edition fails a dry run
// and a real run at stage build. Only the device edition (the top-level android block) is ever installed or dropped in
// Quickdrop; the extra editions go to the private Release, and a public one to its edition page in deliver.
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { accessFor } from '../lib/access.mjs';
import { createAdb, findPhone } from '../lib/adb.mjs';
import { checkBundleIdentity, verifyPlayBundle } from '../lib/aab.mjs';
import { apkIdentity, verifySigner } from '../lib/android.mjs';
import { hookEnvironment } from '../lib/config.mjs';
import { loadDevices } from '../lib/devices.mjs';
import { hook, run } from '../lib/exec.mjs';
import { exportGodot } from '../lib/godot.mjs';
import { apkName, busyReason } from '../lib/latest.mjs';
import { holdsOf, releaseReservation, withLock } from '../lib/lock.mjs';
import { editionApkName, editionLane, isPublicEdition } from '../lib/editions.mjs';
import { editionsOf, loadManifest } from '../lib/manifest.mjs';
import { editionPinOf, loadPolicy, tagOf } from '../lib/policy.mjs';
import { bundleFileName, digestOf, playHookEnv, uploadBundle } from '../lib/play.mjs';
import { playTargetOf } from '../lib/policy.mjs';
import { dropApk, s26OnLan } from '../lib/quickdrop.mjs';
import { buildReceipt, setOutputs, sha256File, writeReceipt } from '../lib/receipt.mjs';
import { notesKey, notesText, validateNotes } from '../lib/release-notes.mjs';
import { readObject } from '../lib/s3.mjs';
import { applyBump, checkAppReceipt, exists, guarded, policyBanner, readReceipts, requirePlan, semver, stagingDir } from './common.mjs';

// Away is the code findPhone attaches, never its wording: the message names the reason (absent, unauthorized, offline).
const notOnAdb = error => error?.code === 'HUB_PHONE_AWAY';

async function androidLane(config, manifest, { env, home, track, policy, log, quickdropLink, lockOptions }) {
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
  if (!exists(built)) throw new Error(`the export hook did not produce ${spec.artifact}`);
  const apk = join(out, basename(spec.artifact));
  await copyFile(built, apk);
  const sha256 = await sha256File(apk);
  const artifacts = [{ name: basename(spec.artifact), sha256 }];
  track.receipt.artifacts = artifacts;
  const signer = verifySigner({ apk, expected: spec.signer_sha256, env, home }).signer_sha256;
  log(`APK_SIGNER_OK ${signer}`);
  const identity = apkIdentity({ apk, env, home });
  if (identity.package !== spec.package) throw new Error(`the APK is ${identity.package}, the manifest pins ${spec.package}`);
  if (identity.versionName !== config.version || String(identity.versionCode) !== config.androidCode) throw new Error(`the APK carries ${identity.versionName} (${identity.versionCode}) but the plan says ${config.version} (${config.androidCode}); the bump did not reach the export`);
  if (spec.receipt && exists(join(config.cwd, spec.receipt))) {
    await checkAppReceipt(join(config.cwd, spec.receipt), config, spec.receipt);
    await copyFile(join(config.cwd, spec.receipt), join(out, basename(spec.receipt)));
  }
  if (config.play) {
    // The Play upload goes to the policy's store package (the device package when the app has no separate Play app).
    // The hook builds and signs with what the hub tells it; the hub then reads the copy it will upload.
    const target = playTargetOf(policy.apps[env.GITHUB_REPOSITORY ?? ''], spec.package);
    log(`HUB_PLAY_TARGET ${target.package}${target.split ? ` (store package; the device app is ${spec.package})` : ' (the device package)'}`);
    hook('android.bundle', spec.bundle, { cwd: config.cwd, env: playHookEnv(hooks, target, spec.bundle_signing) });
    const aab = join(config.cwd, spec.bundle_artifact);
    if (!exists(aab)) throw new Error(`the bundle hook did not produce ${spec.bundle_artifact}`);
    const stagedAab = join(out, basename(spec.bundle_artifact));
    await copyFile(aab, stagedAab);
    const aabSha256 = await sha256File(stagedAab);
    const { size: aabBytes } = statSync(stagedAab);
    if (target.split) {
      const facts = verifyPlayBundle({ aab: stagedAab, expect: { package: target.package, versionCode: config.androidCode, uploadSha256: target.uploadSha256 }, env, home });
      log(`HUB_PLAY_BUNDLE_OK ${facts.package} versionCode=${facts.versionCode} upload_sha256=${facts.upload_sha256}`);
      track.receipt.play = { package: facts.package, versionCode: facts.versionCode, upload_sha256: facts.upload_sha256, sha256: aabSha256, bytes: aabBytes };
    } else {
      // No store split is pinned, so the signer is Play's to judge — but the package and the planned versionCode are
      // read out of the bundle all the same, and the upload is checked byte for byte against Play's own sha256.
      const facts = checkBundleIdentity({ aab: stagedAab, expect: { package: target.package, versionCode: config.androidCode } });
      log(`HUB_PLAY_BUNDLE_READ ${facts.package} versionCode=${facts.versionCode}: no store split is pinned, so the signer is Play's to judge; the upload is checked byte for byte`);
      track.receipt.play = { package: facts.package, versionCode: facts.versionCode, upload_sha256: null, sha256: aabSha256, bytes: aabBytes };
    }
    log(`HUB_PLAY_BUNDLE_STAGED ${basename(spec.bundle_artifact)} sha256=${aabSha256} bytes=${aabBytes}`);
    artifacts.push({ name: basename(spec.bundle_artifact), sha256: aabSha256 });
  }
  const { size: bytes } = statSync(apk);
  log(`HUB_ANDROID_BUILT ${basename(spec.artifact)} ${config.version} (${config.androidCode}) sha256=${sha256} bytes=${bytes}`);

  // Staging: deliver publishes from here (dry runs too, so deliver's checks run; it removes a dry run's folder).
  const name = apkName(manifest.project.slug, config.version, config.androidCode);
  const stageDir = join(stagingDir(env, devices, home), 'android');
  mkdirSync(stageDir, { recursive: true });
  copyFileSync(apk, join(stageDir, name));
  const staged = { name, bytes, sha256 };
  track.receipt.staged = staged;
  log(`HUB_STAGED ${name} ${bytes} bytes for deliver`);

  // The extra editions, built and verified before the S26 step; none of them is ever an install candidate.
  const editions = [];
  for (const edition of editionsOf(manifest)) editions.push(await buildEdition(config, manifest, edition, { env, home, hooks, out, stageDir, log }));
  if (editions.length > 0) track.receipt.editions = editions.map(({ edition, package: pkg, staged: copy }) => ({ edition, package: pkg, staged: copy }));

  const planned = Number(config.androidCode);
  const delivery = { platform: 'android', target: devices.android.model, device: devices.android.name, version: config.version, build: String(planned), sha256, verified: false, status: 'pending', reason: null };
  track.receipt.delivery = delivery;
  const notes = [];
  track.stage = 'preflight';
  // `entered` tells a timeout of the wait for the S26 from an error raised while the lane holds it: only the wait going pending is
  // a busy device (FR-30); anything the held step throws still fails the lane.
  let entered = false;
  try {
    await withLock('adb', async () => {
      entered = true;
      const adb = createAdb({ env, home });
      let id;
      try {
        id = await findPhone(adb, { serial: devices.android.serial, model: devices.android.model, waitMs: Number(env.HUB_ADB_LANE_WAIT_MS) || 30_000 });
      } catch (error) {
        if (!notOnAdb(error)) throw error;
        delivery.reason = "not on big-chungus's adb";
        notes.push('the S26 is away: pending; the build is published for Install APK, Quickdrop and the catch-up');
        log(`HUB_S26_PENDING ${config.version} (${planned}) is published for a later install`);
        return;
      }
      const before = adb.installed(id, spec.package);
      const was = before ? `${before.versionName} (${before.versionCode})` : 'nothing';
      if (before && before.versionCode > planned) throw new Error(`the S26 has versionCode ${before.versionCode}, above the planned ${planned}; Android would refuse the update (the hub never downgrades)`);
      if (before && before.versionCode === planned) {
        // Only "Re-run failed jobs" of this deploy gets here (or a person who installed it from the link): the same
        // bytes are verified, other bytes reinstall in place.
        if (before.versionName !== config.version) throw new Error(`the S26 has versionCode ${planned} as ${before.versionName}, not ${config.version}; something else installed that code`);
        const onDevice = adb.sha256(id, adb.baseApk(id, spec.package));
        if (onDevice === sha256) {
          Object.assign(delivery, { verified: true, status: 'installed', reason: null });
          notes.push(`the S26 already runs ${was} with this APK (base.apk sha256 matches); not installed again`);
          log(`HUB_S26_CURRENT ${was} sha256 verified`);
          return;
        }
        notes.push(`the S26 runs ${was} with other bytes; this APK replaces it in place`);
      }
      if (config.dryRun) {
        delivery.reason = `dry run: would install over ${was}`;
        notes.push(`dry run: would install ${config.version} (${planned}) over ${was} on the S26`);
        log(`HUB_S26_DRY_RUN would install ${config.version} (${planned}) over ${was}`);
        return;
      }
      track.stage = 'install';
      adb.install(id, apk);
      track.stage = 'verify';
      const after = adb.installed(id, spec.package);
      if (!after || after.versionCode !== planned || after.versionName !== config.version) throw new Error(`readback: the S26 reports ${after ? `${after.versionName} (${after.versionCode})` : 'no package'} after the install, expected ${config.version} (${planned})`);
      const onDevice = adb.sha256(id, adb.baseApk(id, spec.package));
      if (onDevice !== sha256) throw new Error(`readback: base.apk on the S26 has sha256 ${onDevice}, the built APK has ${sha256}`);
      Object.assign(delivery, { verified: true, status: 'installed', reason: null });
      notes.push(`installed on the S26 over ${was}; readback ${config.version} (${planned}), base.apk sha256 matches`);
      log(`HUB_S26_INSTALLED ${config.version} (${planned}) over ${was}, sha256 verified`);
    }, { env, timeoutMs: 20 * 60_000, endsReservation: true, timeoutReason: 'delivery-pending', ...lockOptions });
  } catch (error) {
    if (entered || error?.code !== 'HUB_LOCK_TIMEOUT') throw error;
    // The wait for the S26 ran out (FR-30, AD-14): the build is good, so the delivery goes pending for the catch-up and the run
    // stays green. The lock wrote the one `timeout` event (reason delivery-pending). Who blocked it goes to this receipt, the
    // summary and the log, never to the public delivery reason, notes or latest.json.
    delivery.reason = busyReason(devices.android.name);
    track.receipt.contention = { lock: 'adb', reason: 'delivery-pending', blocked_by: error.holds ?? holdsOf(error.owner) };
    notes.push(`the ${devices.android.name} stayed busy past the wait: pending; the build is published for Install APK, Quickdrop and the catch-up`);
    log(`HUB_S26_BUSY ${config.version} (${planned}) is published and the catch-up installs it: ${String(error.message).replace(/\s*Another deploy is using the device; run again when it finishes\.\s*$/, '')}`);
    const ended = releaseReservation('adb', { env, reason: 'delivery-pending' });
    if (ended.status === 'released') log(`HUB_RESERVATION_RELEASED adb ${ended.key}`);
  }

  // Quickdrop: real runs only (a dry run writes nothing a phone could pick up), after the S26's own checks, and only
  // while the S26 syncs from the LAN.
  let quickdrop = { status: 'skipped', reason: 'dry run' };
  if (!config.dryRun) {
    const link = quickdropLink ? await quickdropLink() : await s26OnLan({ deviceId: devices.android.syncthing, lanCidr: policy.mac.lan_cidr, home });
    if (!link.onLan) {
      quickdrop = { status: 'deferred', bytes, name: null, reason: link.reason };
      log(`HUB_QUICKDROP_DEFERRED ${name}: ${link.reason}; Install APK (S3) and the catch-up deliver it`);
    } else {
      const dropped = dropApk({ apk, dir: join(home, policy.delivery.quickdrop.dir), name, slug: manifest.project.slug, maxBytes: policy.delivery.quickdrop.max_mb * 1_000_000, keep: policy.delivery.quickdrop.keep, log });
      quickdrop = { status: dropped.status, bytes: dropped.bytes, name: dropped.status === 'written' ? name : null, reason: dropped.reason ?? null };
    }
  }
  track.receipt.quickdrop = quickdrop;

  for (const built of editions) {
    await writeReceipt(out, buildReceipt({
      lane: editionLane(built.edition), config, env, version: config.version, androidCode: config.androidCode,
      artifacts: [{ name: built.staged.name, sha256: built.sha256 }], signer: built.signer,
      notes: [`edition ${built.edition} (${built.package}): built and verified; never installed on a device${built.public ? '; deliver publishes it if the policy allows' : '; private (Release only)'}`],
      edition: { name: built.edition, package: built.package, device: false, public: built.public }, staged: built.staged,
    }), env);
  }
  await writeReceipt(out, buildReceipt({ lane: 'android', config, env, version: config.version, androidCode: config.androidCode, artifacts, signer, notes, delivery, staged, quickdrop, ...(track.receipt.contention ? { contention: track.receipt.contention } : {}), ...(track.receipt.play ? { play: track.receipt.play } : {}), ...(editions.length > 0 ? { editions: editions.map(({ edition, package: pkg, staged: copy, public: open }) => ({ edition, package: pkg, staged: copy, public: open })) } : {}) }), env);
  return { out, artifact: apk, sha256, signer, delivery, staged, quickdrop, editions };
}

// One extra edition: its hook (with HUB_EDITION and HUB_EDITION_PACKAGE), then the same checks as the device APK (one
// signer and it is the pin, the package, the planned version and code), its own copy under out/android/editions/<name>/
// and staging/android/editions/<name>/, named <slug>-<edition>-<X.Y.Z>-<code>.apk so no two editions can share a file.
async function buildEdition(config, manifest, { name, spec }, { env, home, hooks, out, stageDir, log }) {
  const where = `android.editions.${name}`;
  const fault = message => new Error(`edition ${name}: ${message}`);
  const editionHooks = { ...hooks, HUB_EDITION: name, HUB_EDITION_PACKAGE: spec.package };
  if (spec.prepare) hook(`${where}.prepare`, spec.prepare, { cwd: config.cwd, env: editionHooks });
  if (spec.export) hook(`${where}.export`, spec.export, { cwd: config.cwd, env: editionHooks });
  else await exportGodot({ project: join(config.cwd, spec.godot.path), preset: spec.godot.preset, output: join(config.cwd, spec.artifact), env: editionHooks });
  const built = join(config.cwd, spec.artifact);
  if (!exists(built)) throw fault(`the export hook did not produce ${spec.artifact}`);
  const apkFile = editionApkName(manifest.project.slug, name, config.version, config.androidCode);
  const dir = join(out, 'editions', name);
  await mkdir(dir, { recursive: true });
  const apk = join(dir, apkFile);
  await copyFile(built, apk);
  const sha256 = await sha256File(apk);
  let signer;
  try { signer = verifySigner({ apk, expected: spec.signer_sha256, env, home }).signer_sha256; } catch (error) { throw fault(error.message); }
  const identity = apkIdentity({ apk, env, home });
  if (identity.package !== spec.package) throw fault(`the APK is ${identity.package}, the manifest pins ${spec.package}`);
  if (identity.versionName !== config.version || String(identity.versionCode) !== config.androidCode) throw fault(`the APK carries ${identity.versionName} (${identity.versionCode}) but the plan says ${config.version} (${config.androidCode}); the bump did not reach the export`);
  if (spec.receipt && exists(join(config.cwd, spec.receipt))) {
    await checkAppReceipt(join(config.cwd, spec.receipt), config, `${where}.receipt`);
    await copyFile(join(config.cwd, spec.receipt), join(dir, basename(spec.receipt)));
  }
  const { size: bytes } = statSync(apk);
  const stage = join(stageDir, 'editions', name);
  mkdirSync(stage, { recursive: true });
  copyFileSync(apk, join(stage, apkFile));
  log(`HUB_EDITION_BUILT ${name} ${spec.package} ${config.version} (${config.androidCode}) sha256=${sha256} bytes=${bytes} signer=${signer}; staged, never installed`);
  return { edition: name, package: spec.package, apk, sha256, signer, bytes, staged: { name: apkFile, bytes, sha256 }, public: Boolean(spec.public) };
}

export async function android(config, { env = process.env, home = homedir(), log = console.log, quickdropLink = null, policyFile, lockOptions = {} } = {}) {
  const { policy } = policyBanner(log, policyFile);
  const manifest = await loadManifest(config.cwd, config.manifest);
  return guarded('android', join(config.out, 'android'), config, env, track => androidLane(config, manifest, { env, home, track, policy, log, quickdropLink, lockOptions }));
}

// The Play upload and the Release run as later steps of the android job. Each writes its own receipt (lane android-play,
// android-release), so a failure there is reported at stage deliver while the android lane's receipt keeps the S26's
// real delivery (installed or pending).
export async function play(config, { env = process.env, fetchImpl, policyFile, log = console.log } = {}) {
  return guarded('android-play', join(config.out, 'android'), config, env, async track => {
    track.stage = 'deliver';
    if (config.dryRun) throw new Error('refusing to contact Play on a dry run');
    const { policy } = policyBanner(log, policyFile);
    const manifest = await loadManifest(config.cwd, config.manifest);
    if (!config.play) throw new Error('the play command needs --play true');
    const spec = manifest.android;
    if (!spec?.bundle_artifact) throw new Error('the manifest declares no android.bundle_artifact');
    // Edits, bundle upload and track all name the store package; the policy, never the manifest, says which it is.
    const target = playTargetOf(policy.apps[env.GITHUB_REPOSITORY ?? ''], spec.package);
    const aab = join(config.out, 'android', basename(spec.bundle_artifact));
    // The android job verified this file; it is read again here because the artifact travels between jobs and the next
    // call is the one that spends the version on Play. For an app with no store split the package and versionCode are
    // still read out of the bundle.
    if (target.split) {
      const facts = verifyPlayBundle({ aab, expect: { package: target.package, versionCode: config.androidCode, uploadSha256: target.uploadSha256 }, env, home: homedir() });
      log(`HUB_PLAY_BUNDLE_OK ${facts.package} versionCode=${facts.versionCode} upload_sha256=${facts.upload_sha256}`);
    } else {
      const facts = checkBundleIdentity({ aab, expect: { package: target.package, versionCode: config.androidCode } });
      log(`HUB_PLAY_BUNDLE_READ ${facts.package} versionCode=${facts.versionCode}: no store split is pinned, so the signer is Play's to judge; the upload is checked byte for byte`);
    }
    // Chain of custody across the artifact hop: the android lane's receipt records the staged bundle's sha256, and the
    // file this step is about to upload must be exactly those bytes. The receipt sits where the android lane wrote it —
    // this job's hub-out/android, uploaded as the android-out artifact (hub-out/receipts holds only downloaded
    // artifacts, and the plan-out download lands after this step). A real run with no staged sha256 to check against is
    // a refusal, not a silent skip.
    const staged = readReceipts(join(config.out, 'android')).android?.play;
    const stagedSha = staged?.sha256;
    if (!stagedSha) throw new Error(`HUB_PLAY_BUNDLE_REFUSED missing-stage: the android lane's receipt under ${join(config.out, 'android')} names no staged bundle sha256 for ${basename(spec.bundle_artifact)}; refusing to upload bytes nobody staged and checked`);
    const here = await sha256File(aab);
    if (here !== stagedSha) throw new Error(`HUB_PLAY_BUNDLE_REFUSED changed: the android lane staged sha256=${stagedSha} for ${basename(spec.bundle_artifact)} but this step reads sha256=${here}; the bundle changed between jobs`);
    const uploaded = await uploadBundle({
      pkg: target.package,
      track: config.track,
      aab,
      token: env.PLAY_TOKEN,
      expectedCode: config.androidCode ? Number(config.androidCode) : undefined,
      status: config.playStatusExplicit ? config.playStatus : undefined,
      fetchImpl,
      log,
    });
    // Retention of the exact uploaded bytes: the AAB is copied out under its release asset name with a sha256sum file
    // beside it; the release lane attaches both to the app's private Release, and the workflow's fallback keeps them as
    // a run artifact when there is no release lane (or the Release is not private).
    const name = bundleFileName(manifest.project.slug, config.version, uploaded.versionCode);
    const retainedPath = join(config.out, 'android', name);
    await copyFile(aab, retainedPath);
    const digest = digestOf(await readFile(retainedPath));
    if (digest.sha256 !== uploaded.bundle.sha256) throw new Error(`retained copy of ${name} has sha256=${digest.sha256}, the upload had ${uploaded.bundle.sha256}`);
    const digestFile = `${name}.sha256`;
    await writeFile(join(config.out, 'android', digestFile), `${digest.sha256}  ${name}\n`);
    const hasRelease = Boolean(loadPolicy().policy.delivery?.release);
    const retained = hasRelease
      ? { via: 'release', name, sha256_file: digestFile, fallback: { artifact: 'play-bundle', retention_days: 30 } }
      : { via: 'run-artifact', artifact: 'play-bundle', retention_days: 30, reason: 'the policy runs no release lane for this app', name, sha256_file: digestFile };
    log(`HUB_PLAY_BUNDLE_RETAINED ${name} sha256=${digest.sha256} bytes=${digest.bytes}${hasRelease ? ' (for the private Release)' : ' (run artifact: the policy runs no release lane)'}`);
    await setOutputs({ play_bundle: name }, env);
    await writeReceipt(join(config.out, 'android'), buildReceipt({
      lane: 'android-play', config, env, version: config.version, androidCode: config.androidCode,
      play: { package: target.package, track: uploaded.track, status: uploaded.status, versionCode: uploaded.versionCode, edit: uploaded.edit, bundle: { name, bytes: digest.bytes, sha256: digest.sha256, sha1: uploaded.bundle.sha1, play_sha256: uploaded.bundle.play_sha256, play_sha1: uploaded.bundle.play_sha1 }, retained },
      artifacts: [{ name, sha256: digest.sha256 }],
      notes: [`Play ${target.package} ${config.track}: uploaded versionCode ${uploaded.versionCode} as ${uploaded.status}; the exact AAB (${digest.bytes} bytes) is retained as ${name} (sha256 matched Play's at upload)`],
    }), env);
    return uploaded;
  });
}

// Whether GitHub says the repository is private; anything else (public, internal, an error) is not.
export function repoIsPrivate(repo, env) {
  const answer = spawnSync('gh', ['api', `repos/${repo}`, '--jq', '.private'], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  return answer.status === 0 && String(answer.stdout).trim() === 'true';
}

// MOBI-17: the device APK rides the Release when the Release is private, or when the policy publishes it anyway.
export const deviceRidesRelease = ({ privateRepo, access }) => privateRepo === true || access?.devicePublic === true;

export function releaseArguments({ tag, repo, sha, title, notes, assets, verifyTag = false }) {
  return ['release', 'create', tag, ...assets, '--repo', repo, '--target', sha, '--title', title, '--notes', notes, ...(verifyTag ? ['--verify-tag'] : [])];
}

// fetchImpl reaches the build directory (the saved release notes), like plan, deliver and announce: the one read here
// that a test must be able to answer, since an un-injected read gets whatever the live bucket says (403 for a private
// object since MOBI-17, ECONNREFUSED on a host with no MinIO).
export function release(config, { env = process.env, fetchImpl = fetch } = {}) {
  return guarded('android-release', join(config.out, 'android'), config, env, async track => {
    track.stage = 'deliver';
    const done = await releaseLane(config, { env, fetchImpl });
    const playBundle = done.play_bundle ? { ...done.play_bundle, tag: done.tag } : undefined;
    await writeReceipt(join(config.out, 'android'), buildReceipt({ lane: 'android-release', config, env, version: config.version, androidCode: config.androidCode, notes: [`${done.updated ? 'updated' : 'published'} the private Release ${done.tag}${playBundle ? `; the exact uploaded Play bundle ${playBundle.name} rides it` : ''}`], ...(playBundle ? { play_bundle: playBundle } : {}) }), env);
    return done;
  });
}

async function releaseLane(config, { env, fetchImpl }) {
  if (config.dryRun) throw new Error('refusing to publish a release on a dry run');
  const manifest = await loadManifest(config.cwd, config.manifest);
  if (!semver.test(config.version)) throw new Error('release needs the plan version');
  if (!env.GH_TOKEN) throw new Error('GH_TOKEN is empty; the caller must grant contents: write');
  const spec = manifest.android ?? (() => { throw new Error('the manifest has no android section'); })();
  const out = join(config.out, 'android');
  const repo = env.GITHUB_REPOSITORY;
  if (!repo) throw new Error('GITHUB_REPOSITORY is not set');
  // A Release is as public as its repository: the repository must say it is private (an unreadable answer counts as
  // public). MOBI-17: the device APK and its receipts ride a public repository's Release only when the policy publishes
  // the device edition (lib/access.mjs), so a public repo never hands out what the bucket keeps private.
  const privateRepo = repoIsPrivate(repo, env);
  const deviceOpen = deviceRidesRelease({ privateRepo, access: accessFor(loadPolicy().policy, manifest.project.slug) });
  const assets = deviceOpen ? [basename(spec.artifact), ...(spec.receipt ? [basename(spec.receipt)] : []), 'hub-receipt-android.json'].map(name => join(out, name)) : [];
  if (!deviceOpen) console.log(`HUB_RELEASE_DEVICE_HELD ${repo} is not a private repository and the policy keeps the device edition private, so its APK and receipts stay off the Release`);
  // GRUV-184 (level up: every hub app): the exact AAB the play step uploaded rides the Release only when the Release
  // is private — a public repository must not publish a store-signed bundle. The play receipt carries the name and the
  // sha256; both are re-read from disk so a stale or tampered copy fails here, not silently.
  const playReceiptFile = join(out, 'hub-receipt-android-play.json');
  const playReceipt = JSON.parse(await readFile(playReceiptFile, 'utf8').catch(() => 'null'));
  let playBundle = null;
  let playBundleHeld = false;
  let playBundleNote = '';
  if (playReceipt?.outcome === 'success' && playReceipt?.play?.bundle?.name && playReceipt?.play?.retained?.via === 'release') {
    const { name, sha256: expectedSha, bytes } = playReceipt.play.bundle;
    const digestFile = `${name}.sha256`;
    const file = join(out, name);
    const fileDigestFile = join(out, digestFile);
    if (!exists(file) || !exists(fileDigestFile)) throw new Error(`the play receipt names the retained bundle ${name}, but ${file} or its .sha256 is missing from ${out}`);
    const digest = digestOf(await readFile(file));
    const recorded = (await readFile(fileDigestFile, 'utf8')).trim();
    if (digest.sha256 !== expectedSha) throw new Error(`the retained Play bundle ${name} has sha256=${digest.sha256}, the play receipt says ${expectedSha}`);
    if (recorded !== `${expectedSha}  ${name}`) throw new Error(`${digestFile} reads "${recorded}", expected "${expectedSha}  ${name}"`);
    if (privateRepo) {
      assets.push(file, fileDigestFile);
      playBundle = { name, sha256: digest.sha256, bytes, retained: 'release' };
      playBundleNote = `\nPlay bundle: ${name} sha256 ${digest.sha256} (${bytes} bytes; Play's sha256 matched at upload).`;
      console.log(`HUB_RELEASE_PLAY_BUNDLE ${name} sha256=${digest.sha256} bytes=${bytes}: the exact uploaded AAB rides the private Release ${repo}`);
    } else {
      playBundleHeld = true;
      playBundleNote = `\nPlay bundle ${name} (sha256 ${digest.sha256}, ${bytes} bytes; Play's sha256 matched at upload) stays off this public Release; it is kept as the play-bundle run artifact (30 days).`;
      console.log(`HUB_RELEASE_PLAY_BUNDLE_HELD ${repo} is not a private repository, so the retained Play bundle ${name} stays off the Release; the play-bundle run artifact keeps it (30 days)`);
      // The play receipt said retained.via 'release' from the policy alone (the policy runs a release lane for every
      // app); this repository is public and the Release holds the bundle off, so rewrite the receipt to record the
      // artifact fallback truthfully before the android-out upload carries it.
      playReceipt.play.retained = { via: 'run-artifact', artifact: 'play-bundle', retention_days: 30, reason: `${repo} is not a private repository, so the Release holds the bundle off`, name, sha256_file: digestFile };
      await writeFile(playReceiptFile, JSON.stringify(playReceipt, null, 2) + '\n');
    }
  }
  // Every extra edition rides the Release too (its APK and its hub receipt), under names no other asset has, but a
  // private edition only when the Release is private. On a public repository only the editions the manifest and the
  // policy both made public ride along.
  const declared = editionsOf(manifest);
  for (const { name, spec: edition } of declared) {
    if (!privateRepo && !isPublicEdition(edition, editionPinOf(loadPolicy().policy.apps[repo], name))) {
      console.log(`HUB_RELEASE_EDITION_HELD ${name}: ${repo} is not a private repository, so the private ${name} edition stays off its Release`);
      continue;
    }
    assets.push(join(out, 'editions', name, editionApkName(manifest.project.slug, name, config.version, config.androidCode)), join(out, `hub-receipt-${editionLane(name)}.json`));
  }
  const names = assets.map(asset => basename(asset));
  const clash = names.find((name, index) => names.indexOf(name) !== index);
  if (clash) throw new Error(`two Release assets are both named ${clash}; rename the app's artifact or receipt`);
  for (const asset of assets) if (!exists(asset)) throw new Error(`release asset missing: ${asset}`);
  const tag = tagOf(loadPolicy().policy.apps[repo], config.version);
  // The commit the APK was built from: the bump commit, never the commit before it.
  const sha = config.buildSha || env.GITHUB_SHA || 'HEAD';
  const digest = await sha256File(join(out, basename(spec.artifact)));
  const buildLine = `\n\nBuild: ${basename(spec.artifact)} sha256 ${digest}.`;
  const planNotes = readReceipts(env.HUB_RECEIPTS || join(config.out, 'receipts')).plan?.release_notes;
  const policy = loadPolicy().policy;
  const saved = await readObject(policy, notesKey(manifest.project.slug, config.version), { env, fetchImpl });
  const canonical = saved ? validateNotes(JSON.parse(saved), { current: config.version, commit: sha }) : planNotes ? validateNotes(planNotes, { current: config.version, commit: sha }) : null;
  // MOBI-17: the Release text is read by anyone who can see the repo's Releases; a private page's URL would only answer 403.
  const pageLine = accessFor(policy, manifest.project.slug).pageOpen ? `\nBuild page: https://s3.delo.sh/builds/${manifest.project.slug}/index.html` : '';
  const notes = `${canonical ? `${notesText(canonical)}${buildLine}` : `No author-written release notes were supplied for this build.\nCommit ${sha}; run ${env.GITHUB_RUN_ID ?? 'local'}.`}${playBundleNote}${pageLine}`;
  const existing = spawnSync('gh', ['release', 'view', tag, '--repo', repo], { env, stdio: 'ignore' });
  if (existing.status === 0) {
    // The plan never reuses a version, so the Release of this tag came from an earlier attempt of this deploy
    // ("Re-run failed jobs"). Its assets are replaced by this attempt's.
    if (assets.length > 0) run('gh', ['release', 'upload', tag, ...assets, '--repo', repo, '--clobber'], { env, cwd: config.cwd });
    run('gh', ['release', 'edit', tag, '--repo', repo, '--notes', notes], { env, cwd: config.cwd });
    console.log(`HUB_RELEASE_UPDATED ${tag} ${repo}: an earlier attempt published it; assets replaced by this attempt's`);
    await setOutputs({ play_bundle_release: playBundle ? 'true' : '' }, env);
    return { tag, repo, assets, updated: true, play_bundle: playBundle, play_bundle_held: playBundleHeld };
  }
  run('gh', releaseArguments({ tag, repo, sha, title: `Android ${config.version}`, notes, assets, verifyTag: true }), { env, cwd: config.cwd });
  console.log(`HUB_RELEASED ${tag} ${repo}`);
  await setOutputs({ play_bundle_release: playBundle ? 'true' : '' }, env);
  return { tag, repo, assets, play_bundle: playBundle, play_bundle_held: playBundleHeld };
}
