// ios-export (Linux, Tower) and ios (Mac). v1.1: the Xcode handoff is a delta into a cache on the Mac; the IPA goes to
// the Mac outbox (real runs; the iPad catch-up installs from there) and back to big-chungus for deliver only when the
// iPad will need it over the air or the link is not metered; an unreachable iPad is pending, a newer one is refused.
import { copyFileSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { exportIpa, inspectIpa } from '../lib/apple.mjs';
import { hookEnvironment } from '../lib/config.mjs';
import { createDevicectl, createIpad } from '../lib/devicectl.mjs';
import { loadDevices } from '../lib/devices.mjs';
import { hook, runBounded } from '../lib/exec.mjs';
import { handoffFolder, receiveHandoff, repoFolder, sendHandoffDelta } from '../lib/handoff.mjs';
import { compareBuild, compareSemver, ipaName } from '../lib/latest.mjs';
import { withLock } from '../lib/lock.mjs';
import { loadManifest } from '../lib/manifest.mjs';
import { parseRsyncStats } from '../lib/metered.mjs';
import { buildReceipt, sha256File, writeReceipt } from '../lib/receipt.mjs';
import { applyBump, checkAppReceipt, checkDisk, exists, firstLine, guarded, installCurrent, policyBanner, reachIpad, requirePlan, short } from './common.mjs';

// ---------------------------------------------------------------------------------------------------- ios-export (Linux)

// One exported Xcode project: present, for this bundle and version, and the distribution it claims. The iPad's project
// must be the PRIVATE staging: a store staging (Tower's bundled_only feature) turns off remote packs.
async function checkExport(out, archiveName, receiptName, { config, spec, distribution }) {
  const archive = join(out, archiveName);
  const receiptFile = join(out, receiptName);
  if (!exists(archive)) throw new Error(`the export hook did not produce ${archiveName} in $HUB_OUT/ios`);
  if (!exists(receiptFile)) throw new Error(`the export hook did not produce ${receiptName} in $HUB_OUT/ios`);
  const receipt = await checkAppReceipt(receiptFile, config, receiptName);
  if (receipt.bundle && receipt.bundle !== spec.bundle) throw new Error(`${receiptName} names bundle ${receipt.bundle}, the manifest pins ${spec.bundle}`);
  if (distribution === 'private' && receipt.distribution !== 'private') throw new Error(`${receiptName} must say "distribution": "private": the iPad gets the private staging, never the store one (bundled_only hides remote packs), got ${JSON.stringify(receipt.distribution)}`);
  if (distribution === 'store' && receipt.distribution !== undefined && receipt.distribution !== 'store') throw new Error(`${receiptName} says distribution ${receipt.distribution}; TestFlight takes the store staging`);
  const digest = await sha256File(archive);
  if (receipt.tarball_sha256 && receipt.tarball_sha256 !== digest) throw new Error(`${archiveName} sha256 ${digest} differs from the receipt ${receipt.tarball_sha256}`);
  return [{ name: archiveName, sha256: digest }, { name: receiptName, sha256: await sha256File(receiptFile) }];
}

export async function iosExport(config, { env = process.env, log = console.log, runner = runBounded } = {}) {
  policyBanner(log);
  const manifest = await loadManifest(config.cwd, config.manifest);
  return guarded('ios-export', join(config.out, 'ios'), config, env, async track => {
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
    let handoff = null;
    if (!config.dryRun || config.dryHandoff) {
      const archives = [{ name: spec.archive, tgz: join(out, spec.archive) }, ...(config.testflight ? [{ name: spec.store.archive, tgz: join(out, spec.store.archive) }] : [])];
      const receipts = [join(out, spec.receipt), ...(config.testflight ? [join(out, spec.store.receipt)] : [])];
      handoff = await sendHandoffDelta({ host: devices.mac.host, base: devices.mac.handoff_dir, cache: devices.mac.handoff_cache, archives, receipts, unpackInto: join(config.out, 'handoff-trees'), env, runner, log });
      notes.push(`handed to ${devices.mac.host}:${handoff.folder} as a delta: ${handoff.mac_bytes.in} bytes in, ${handoff.mac_bytes.out} out (${handoff.archives.map(item => `${item.name} ${item.mode}`).join(', ')})`);
    } else {
      notes.push('handoff skipped: a dry run hands the Xcode project to the Mac only with dry_handoff=true, so the iPad build is not checked');
    }
    await writeReceipt(out, buildReceipt({ lane: 'ios-export', config, env, version: config.version, build: config.iosBuild || null, artifacts, notes, handoff, mac_bytes: handoff?.mac_bytes ?? null }), env);
    log(`HUB_IOS_EXPORTED ${artifacts.map(item => `${item.name}=${short(item.sha256)}`).join(' ')}`);
    return { out, artifacts, handoff };
  });
}

// ---------------------------------------------------------------------------------------------------- ios (Mac)

const sshOptions = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=20', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=4'];

export function newerOnDevice(before, facts) {
  try {
    const byVersion = compareSemver(before.version, facts.version);
    if (byVersion !== 0) return byVersion > 0;
  } catch { /* a non-semver version on the device: the build decides */ }
  try { return compareBuild(before.build, facts.build) > 0; } catch { return false; }
}

// The Mac outbox (B5): the newest two IPAs per app, which the iPad catch-up installs from without a download.
export function keepInOutbox({ ipa, home, devices, slug, version, build, keep = 2, log = console.log }) {
  const dir = join(home, devices.mac.outbox, slug);
  mkdirSync(dir, { recursive: true });
  const name = `${version}-${build}.ipa`;
  copyFileSync(ipa, join(dir, name));
  const parse = file => /^(\d+\.\d+\.\d+)-([0-9.]+)\.ipa$/.exec(file);
  const files = readdirSync(dir).filter(parse).sort((a, b) => {
    const [x, y] = [parse(a), parse(b)];
    return compareSemver(y[1], x[1]) || compareBuild(y[2], x[2]);
  });
  for (const old of files.slice(keep)) rmSync(join(dir, old), { force: true });
  log(`HUB_OUTBOX_KEPT ${slug}/${name} (${files.slice(0, keep).join(', ')})`);
  return join(dir, name);
}

// The IPA back to big-chungus's staging for deliver, over ssh from the Mac (openrsync as the sender).
function sendIpa({ ipa, name, devices, env, runner }) {
  const folder = `${devices.linux.staging_dir}/${repoFolder(env)}/${handoffFolder(env).split('/')[1]}/ios`;
  runner('ssh', [...sshOptions, devices.linux.host, `mkdir -p '${folder}'`], { env, timeout: 90_000, label: `ssh ${devices.linux.host}` });
  const out = runner('rsync', ['--stats', '-t', '-e', `ssh ${sshOptions.join(' ')}`, ipa, `${devices.linux.host}:${folder}/${name}`], { env, timeout: 30 * 60_000, label: `rsync IPA to ${devices.linux.host}` });
  const stats = parseRsyncStats(out);
  return { out: stats.sent ?? statSync(ipa).size, in: stats.received ?? 0 };
}

export async function ios(config, { env = process.env, home = homedir(), log = console.log, runner = runBounded, sleep, now } = {}) {
  const { policy } = policyBanner(log);
  const manifest = await loadManifest(config.cwd, config.manifest);
  return guarded('ios', join(config.out, 'ios'), config, env, async track => {
    const spec = manifest.ios ?? (() => { throw new Error('the manifest has no ios section'); })();
    const devices = loadDevices(env);
    requirePlan(config);
    const out = join(config.out, 'ios');
    await mkdir(out, { recursive: true });
    track.receipt = { version: config.version };
    const notes = [];
    const delivery = { platform: 'ios', target: devices.ios.model, device: devices.ios.name, version: config.version, build: null, sha256: null, verified: false, status: 'pending', reason: null };
    track.receipt.delivery = delivery;
    const macBytes = { in: 0, out: 0 };

    track.stage = 'build';
    applyBump(config, env);
    const hooks = hookEnvironment(config, env, { HUB_TEAM: devices.apple.team });
    const handoff = Boolean(spec.export) && (!config.dryRun || config.dryHandoff);
    if (handoff) {
      let exportReceipt;
      try { exportReceipt = JSON.parse(readFileSync(join(out, 'hub-receipt-ios-export.json'), 'utf8')); } catch { throw new Error('hub-receipt-ios-export.json is missing (the ios-receipt artifact): the Mac cannot check the handoff'); }
      const expected = Object.fromEntries((exportReceipt.artifacts ?? []).map(item => [item.name, item.sha256]));
      const names = [spec.archive, spec.receipt, ...(config.testflight ? [spec.store.archive, spec.store.receipt] : [])];
      await receiveHandoff({ names, expected, archives: exportReceipt.handoff?.archives ?? [], base: devices.mac.handoff_dir, into: out, env, home, runner, log });
      if (exportReceipt.handoff?.mac_bytes) { macBytes.in += exportReceipt.handoff.mac_bytes.in ?? 0; macBytes.out += exportReceipt.handoff.mac_bytes.out ?? 0; }
    }
    const canBuild = !spec.export || handoff;
    let ipa = null;
    let facts = null;

    await withLock('mac-ios', async () => {
      track.stage = 'preflight';
      checkDisk(home, devices);
      if (!canBuild) {
        delivery.reason = 'dry run without dry_handoff: the IPA was not built';
        notes.push('dry run without dry_handoff: the Xcode project stayed on big-chungus, so the iPad build and its IPA checks did not run');
        log('HUB_IPAD_SKIPPED dry run without dry_handoff');
        return;
      }
      track.stage = 'build';
      hook('ios.device', spec.device, { cwd: config.cwd, env: hooks });
      const artifact = join(out, spec.device_artifact);
      let ipaPath;
      try { statSync(artifact); } catch { throw new Error(`the ios.device hook did not leave ${spec.device_artifact} in $HUB_OUT/ios`); }
      ipaPath = spec.device_artifact.endsWith('.xcarchive')
        ? exportIpa({ archive: artifact, out: join(out, 'device-export'), team: devices.apple.team, env, timeoutMs: Number(env.HUB_EXPORT_TIMEOUT_MS) || 900_000 })
        : artifact;
      if (!statSync(ipaPath).isFile()) throw new Error(`${spec.device_artifact} is not an .ipa file`);
      facts = inspectIpa({ ipa: ipaPath, into: join(out, 'ipa-check'), bundle: spec.bundle, version: config.version, team: devices.apple.team, udid: devices.ios.udid, signer: devices.apple.dev_signer_sha1, env });
      const sha256 = await sha256File(ipaPath);
      const bytes = statSync(ipaPath).size;
      ipa = { verified: true, sha256, bytes, build: facts.build, signer: facts.signer, profile: facts.profile, path: ipaPath, sent: false, staged_name: null };
      Object.assign(delivery, { build: facts.build, sha256 });
      log(`HUB_IPA_OK ${facts.bundle} ${facts.version} (${facts.build}) signer=${facts.signer.slice(0, 8)} profile=${facts.profile.name} bytes=${bytes}`);
      if (!config.dryRun) ipa.outbox = keepInOutbox({ ipa: ipaPath, home, devices, slug: manifest.project.slug, version: facts.version, build: facts.build, log });

      track.stage = 'preflight';
      const ipad = createIpad({ devicectl: createDevicectl({ env }), udid: devices.ios.udid, model: devices.ios.model });
      const reach = await reachIpad(ipad, { waitMs: Number(env.HUB_IPAD_WAIT_MS) || policy.devices.ipad_wait_s * 1000, ...(sleep ? { sleep } : {}), ...(now ? { now } : {}) });
      if (!reach.reachable) {
        delivery.reason = reach.reason;
        notes.push(`the iPad is away (${reach.reason}): pending; Install on iPad and the catch-up deliver it later`);
        log(`HUB_IPAD_PENDING ${facts.version} (${facts.build}): ${reach.reason}`);
        return;
      }
      let before;
      try { before = ipad.installed(spec.bundle); } catch (error) {
        delivery.reason = `devicectl could not read the iPad's apps (${firstLine(error.message).slice(0, 120)})`;
        log(`HUB_IPAD_PENDING ${delivery.reason}`);
        return;
      }
      const was = before ? `${before.version} (${before.build})` : 'nothing';
      if (before && newerOnDevice(before, facts)) {
        log(`HUB_IPAD_NEWER the iPad runs ${was}, newer than ${facts.version} (${facts.build})`);
        throw new Error(`HUB_IPAD_NEWER the iPad runs ${spec.bundle} ${was}, newer than this build ${facts.version} (${facts.build}); the hub never downgrades it`);
      }
      if (config.dryRun) {
        delivery.reason = `dry run: would install over ${was}`;
        notes.push(`dry run: would install ${facts.version} (${facts.build}) over ${was} on the iPad`);
        log(`HUB_IPAD_DRY_RUN would install ${facts.version} (${facts.build}) over ${was}`);
        return;
      }
      track.stage = 'install';
      ipad.install(facts.app);
      track.stage = 'verify';
      const after = ipad.installed(spec.bundle);
      if (!after || after.version !== facts.version || after.build !== facts.build) throw new Error(`readback: the iPad reports ${after ? `${after.version} (${after.build})` : 'no app'} after the install, expected ${facts.version} (${facts.build})`);
      Object.assign(delivery, { verified: true, status: 'installed', reason: null });
      notes.push(`installed on the iPad over ${was}; readback ${after.version} (${after.build})`);
      log(`HUB_IPAD_INSTALLED ${after.version} (${after.build}) over ${was}`);
    }, { env, timeoutMs: 40 * 60_000 });

    // The IPA goes back to big-chungus when the iPad will need it over the air, or when the link costs nothing.
    if (ipa) {
      const home_ = config.macLink === 'home';
      const needsOta = !config.dryRun && delivery.status === 'pending';
      if ((needsOta || home_) && !(config.dryRun && !home_)) {
        track.stage = 'build';
        const name = ipaName(manifest.project.slug, config.version, ipa.build);
        const sent = sendIpa({ ipa: ipa.path, name, devices, env, runner });
        macBytes.out += sent.out;
        macBytes.in += sent.in;
        Object.assign(ipa, { sent: true, staged_name: name });
        log(`HUB_OUTBOX_SENT ${name} ${ipa.bytes} bytes to ${devices.linux.host} (${needsOta ? 'the iPad needs it over the air' : 'the link is not metered'}${config.dryRun ? '; dry run' : ''})`);
      } else {
        const why = config.dryRun ? `dry run on a ${config.macLink || 'unknown'} link` : 'the iPad has it and the link is metered';
        log(`HUB_OUTBOX_SKIPPED ${why}`);
        notes.push(`IPA not sent to big-chungus: ${why}`);
      }
    }
    log(`HUB_MAC_BYTES in=${macBytes.in} out=${macBytes.out} (this run's measured transfers: handoff and IPA)`);

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
    if (!config.dryRun) {
      try { installCurrent({ hubRef: env.HUB_REF, home, log }); } catch (error) { log(`::warning::could not refresh the catch-up code (${firstLine(error.message)})`); }
    }
    const { path: _path, outbox: _outbox, ...ipaReceipt } = ipa ?? {};
    await writeReceipt(out, buildReceipt({ lane: 'ios', config, env, version: config.version, build: delivery.build, notes, delivery, ipa: ipa ? ipaReceipt : null, testflight, mac_bytes: macBytes }), env);
    return { out, delivery, ipa, notes, macBytes };
  });
}
