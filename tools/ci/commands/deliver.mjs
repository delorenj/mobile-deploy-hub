// deliver (design v1.1, B2 and C): publishes what the lanes built and checked to the build directory, under the host
// lock s3-<slug>, in an order that never lets a reader see a pointer to bytes that are not there yet: the versioned
// objects (APK, IPA, icons, receipt), then manifest.plist, then latest.json, then the pages. Then it prunes old
// versions and clears inflight.json. Pointers only move forward. A dry run checks everything and writes nothing.
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { correlationFor } from '../lib/announce.mjs';
import { apkIdentity, verifySigner } from '../lib/android.mjs';
import { loadDevices } from '../lib/devices.mjs';
import { apkKey, compareSemver, inflightKey, installUrl, ipaKey, latestKey, manifestKey, mayReplace, pageKey, parseLatest, publicUrl, serializeLatest, versionKey } from '../lib/latest.mjs';
import { withLock } from '../lib/lock.mjs';
import { loadManifest } from '../lib/manifest.mjs';
import { manifestPlist, resizeIcon } from '../lib/ota.mjs';
import { appPage, indexPage } from '../lib/pages.mjs';
import { buildReceipt, sha256File, writeReceipt } from '../lib/receipt.mjs';
import { createS3, publishPages, pruneVersions, readObject, writerCredentials } from '../lib/s3.mjs';
import { firstLine, guarded, installCurrent, isoNow, parseNeeds, policyBanner, publicCopy, pruneStaging, readReceipts, requirePlan, runOf, stagingDir } from './common.mjs';

function deviceOf(device, delivery, { stamp, failed, reason }) {
  const status = failed ? 'failed' : ['installed', 'pending', 'skipped', 'failed'].includes(delivery?.status) ? delivery.status : 'pending';
  const why = failed ? reason : delivery?.reason;
  return { name: device.name, model: device.model, status, since: stamp, by: status === 'installed' ? 'deploy' : null, reason: why ? String(why).slice(0, 300) : null, failures: 0 };
}

// The new latest.json: each built platform replaces its block only when mayReplace says so; a rerun of the same release
// keeps a device state the run did not observe (a catch-up may have installed it since). The top level moves forward only.
export function mergeLatest({ current, candidates, top, stamp, log = console.log }) {
  const latest = current ? structuredClone(current) : { schema: 1, ...top, updated_at: stamp, android: null, ios: null };
  const pointer = {};
  for (const platform of ['android', 'ios']) {
    const next = candidates[platform];
    if (!next) { pointer[platform] = latest[platform] ? 'kept (not built in this run)' : 'none'; continue; }
    const verdict = mayReplace(platform, latest[platform], next);
    if (!verdict.replace) {
      pointer[platform] = 'kept';
      log(`HUB_POINTER ${verdict.reason}`);
      continue;
    }
    const before = latest[platform];
    const rerun = before && before.version === next.version && (platform === 'android' ? before.code === next.code : before.build === next.build);
    latest[platform] = rerun && !['installed', 'failed'].includes(next.device.status) ? { ...next, device: before.device } : next;
    pointer[platform] = 'replaced';
  }
  if (!current || compareSemver(top.version, current.version) >= 0) {
    const { mac_bytes: macBytes, ...rest } = top;
    Object.assign(latest, rest);
    if (macBytes !== undefined && macBytes !== null) latest.mac_bytes = macBytes;
  }
  latest.updated_at = stamp;
  if (!latest.android && !latest.ios) return { latest: null, pointer };
  return { latest, pointer };
}

export async function deliver(config, { env = process.env, home = homedir(), fetchImpl = fetch, s3Factory = null, log = console.log, now = () => new Date() } = {}) {
  const { policy } = policyBanner(log);
  const manifest = await loadManifest(config.cwd, config.manifest);
  return guarded('deliver', join(config.out, 'deliver'), config, env, async track => {
    track.stage = 'deliver';
    requirePlan(config);
    const devices = loadDevices(env);
    const slug = manifest.project.slug;
    const base = policy.delivery.s3.public;
    const needs = parseNeeds(env.HUB_NEEDS);
    const receipts = readReceipts(env.HUB_RECEIPTS || join(config.out, 'receipts'));
    const staging = stagingDir(env, devices, home);
    const run = runOf(env);
    const correlation = correlationFor(env);
    const stamp = isoNow(now());
    const commit = config.buildSha || receipts.plan?.sha || env.GITHUB_SHA;
    if (!/^[0-9a-f]{7,40}$/.test(commit ?? '')) throw new Error('deliver cannot name the commit the build came from');
    const uploads = [];
    const candidates = { android: null, ios: null };
    const notes = [];

    // The APK: staged by the android job after its checks; checked again here before it is published.
    const androidReceipt = receipts.android;
    if (manifest.android && androidReceipt?.staged && androidReceipt.version === config.version) {
      const file = join(staging, 'android', androidReceipt.staged.name);
      if (!existsSync(file)) throw new Error(`the staged APK ${androidReceipt.staged.name} is missing from big-chungus staging`);
      const sha256 = await sha256File(file);
      if (sha256 !== androidReceipt.staged.sha256) throw new Error(`the staged APK has sha256 ${sha256}, the android receipt says ${androidReceipt.staged.sha256}`);
      const signer = verifySigner({ apk: file, expected: manifest.android.signer_sha256, env, home }).signer_sha256;
      const identity = apkIdentity({ apk: file, env, home });
      if (identity.package !== manifest.android.package || identity.versionName !== config.version || String(identity.versionCode) !== String(config.androidCode)) throw new Error(`the staged APK is ${identity.package} ${identity.versionName} (${identity.versionCode}), not ${manifest.android.package} ${config.version} (${config.androidCode})`);
      const key = apkKey(slug, config.version, Number(config.androidCode));
      const failed = needs.android?.result === 'failure' || needs.android?.result === 'cancelled';
      candidates.android = {
        package: manifest.android.package, version: config.version, code: Number(config.androidCode), key, url: publicUrl(base, key), bytes: statSync(file).size, sha256, signer_sha256: signer,
        quickdrop: androidReceipt.quickdrop?.status === 'written' && androidReceipt.quickdrop.name ? `builds/${androidReceipt.quickdrop.name}` : null,
        device: deviceOf(devices.android, androidReceipt.delivery, { stamp, failed, reason: androidReceipt.reason }), run, correlation, commit,
      };
      uploads.push({ platform: 'android', file, key });
    }

    // The IPA: back from the Mac when the iPad needs it over the air (or the link was free); otherwise no OTA copy.
    const iosReceipt = receipts.ios;
    if (manifest.ios && iosReceipt?.ipa?.verified && iosReceipt.version === config.version) {
      const ipa = iosReceipt.ipa;
      const failed = needs.ios?.result === 'failure' || needs.ios?.result === 'cancelled';
      const block = { bundle: manifest.ios.bundle, version: config.version, build: String(ipa.build), key: null, url: null, bytes: ipa.bytes ?? null, sha256: ipa.sha256, manifest_url: null, install_url: null, device: deviceOf(devices.ios, iosReceipt.delivery, { stamp, failed, reason: iosReceipt.reason }), run, correlation, commit };
      const withKey = () => {
        const key = ipaKey(slug, config.version, String(ipa.build));
        const manifestUrl = publicUrl(base, manifestKey(slug));
        Object.assign(block, { key, url: publicUrl(base, key), manifest_url: manifestUrl, install_url: installUrl(manifestUrl) });
        return key;
      };
      if (ipa.sent && ipa.staged_name) {
        const file = join(staging, 'ios', ipa.staged_name);
        if (!existsSync(file)) throw new Error(`the IPA ${ipa.staged_name} the Mac sent is missing from big-chungus staging`);
        const sha256 = await sha256File(file);
        if (sha256 !== ipa.sha256) throw new Error(`the staged IPA has sha256 ${sha256}, the ios receipt says ${ipa.sha256}`);
        block.bytes = statSync(file).size;
        uploads.push({ platform: 'ios', file, key: withKey() });
        candidates.ios = block;
      } else if (block.device.status === 'installed' || config.dryRun) {
        if (config.dryRun) withKey();
        candidates.ios = block;
        if (block.device.status === 'installed' && !config.dryRun) notes.push('the iPad installed the IPA over a metered link; no over-the-air copy is published');
      } else {
        notes.push('the IPA did not come back from the Mac and the iPad does not have it; the iPad keeps the previous build directory entry');
      }
    }

    // The OTA images, from the app's optional project.icon.
    const icons = {};
    if (manifest.project.icon && candidates.ios?.key) {
      const source = join(config.cwd, manifest.project.icon);
      if (existsSync(source)) {
        const dir = mkdtempSync(join(tmpdir(), 'hub-icons-'));
        for (const size of [57, 512]) {
          const file = resizeIcon({ source, size, target: join(dir, `icon-${size}.png`), env });
          const key = versionKey(slug, config.version, `icon-${size}.png`);
          uploads.push({ platform: 'ios', file, key });
          icons[size] = publicUrl(base, key);
        }
      } else notes.push(`project.icon ${manifest.project.icon} is missing; manifest.plist goes without images`);
    }

    const iosMac = receipts.ios?.mac_bytes;
    const top = { slug, name: manifest.project.name, version: config.version, commit, hub_ref: env.HUB_REF || null, run, correlation, mac_bytes: iosMac ? (iosMac.in ?? 0) + (iosMac.out ?? 0) : undefined };
    const deliveries = ['android', 'ios'].map(platform => candidates[platform] && { device: candidates[platform].device.name, status: candidates[platform].device.status, reason: candidates[platform].device.reason }).filter(Boolean);
    const published = {
      apk: candidates.android?.url ?? null,
      ota: candidates.ios?.install_url ?? null,
      page: publicUrl(base, pageKey(slug)),
      manifest: candidates.ios?.manifest_url ?? null,
      any: Boolean(candidates.android || candidates.ios),
    };

    if (config.dryRun) {
      const currentText = await readObject(policy, latestKey(slug), { fetchImpl });
      const current = currentText ? parseLatest(currentText, { slug }) : null;
      const merged = mergeLatest({ current, candidates, top, stamp, log });
      if (merged.latest) {
        serializeLatest(merged.latest);
        appPage({ latest: merged.latest, deliveries });
        indexPage([merged.latest]);
      }
      if (candidates.ios?.key) manifestPlist({ ipaUrl: candidates.ios.url, bundle: candidates.ios.bundle, version: candidates.ios.version, title: manifest.project.name, displayImage: icons[57] ?? null, fullSizeImage: icons[512] ?? null });
      rmSync(staging, { recursive: true, force: true });
      log(`HUB_PUBLISH_DRY_RUN would publish ${uploads.map(item => item.key).join(', ') || 'no build'}${merged.latest ? `, ${latestKey(slug)} (android ${merged.pointer.android}, ios ${merged.pointer.ios}), the pages` : ''}; nothing was written`);
      await writeReceipt(join(config.out, 'deliver'), buildReceipt({ lane: 'deliver', config, env, version: config.version, androidCode: config.androidCode, notes: [...notes, 'dry run: checked and rendered, nothing written'], published: { ...published, dry_run: true }, pointer: merged.pointer }), env);
      return { published, pointer: merged.pointer, dryRun: true };
    }

    const s3 = s3Factory ? await s3Factory() : createS3({ policy, credentials: await writerCredentials({ env }), env });
    let pointer = {};
    await withLock(`s3-${slug}`, async () => {
      const currentText = await readObject(policy, latestKey(slug), { fetchImpl });
      const current = currentText ? parseLatest(currentText, { slug }) : null;
      const merged = mergeLatest({ current, candidates, top, stamp, log });
      pointer = merged.pointer;
      if (!merged.latest) { log('HUB_PUBLISHED nothing: no lane staged a build'); return; }
      // 1. versioned objects, for the blocks this run moves (an older run's bytes are not uploaded over a newer pointer)
      for (const upload of uploads) if (pointer[upload.platform] === 'replaced') s3.put(upload.file, upload.key);
      s3.putText(`${JSON.stringify(publicCopy({ run, correlation, hub_ref: env.HUB_REF || null, receipts }), null, 2)}\n`, versionKey(slug, config.version, 'receipt.json'));
      // 2. the one OTA manifest, always the newest IPA (or none: OTA allows downgrades, so an older IPA is never offered)
      if (pointer.ios === 'replaced') {
        if (merged.latest.ios.key) s3.putText(manifestPlist({ ipaUrl: merged.latest.ios.url, bundle: merged.latest.ios.bundle, version: merged.latest.ios.version, title: manifest.project.name, displayImage: icons[57] ?? null, fullSizeImage: icons[512] ?? null }), manifestKey(slug));
        else { try { s3.remove(manifestKey(slug)); } catch { /* none yet */ } }
      }
      // 3. the pointer, 4. the pages
      s3.putText(serializeLatest(merged.latest), latestKey(slug));
      await publishPages({ s3, policy, slug, latest: merged.latest, deliveries, fetchImpl, env });
      // 5. retention, 6. the deploy is no longer in flight
      const removed = pruneVersions({ s3, policy, slug, latest: merged.latest });
      if (removed.length > 0) notes.push(`pruned ${removed.length} old objects`);
      try { s3.remove(inflightKey(slug)); } catch { /* the plan's write was best effort */ }
      log(`HUB_PUBLISHED ${slug} ${config.version}: ${uploads.filter(item => pointer[item.platform] === 'replaced').map(item => item.key).join(', ') || 'no new build'}; ${latestKey(slug)} android ${pointer.android}, ios ${pointer.ios}; ${pageKey(slug)}, index.html`);
    }, { env, timeoutMs: 30 * 60_000 });

    try { installCurrent({ hubRef: env.HUB_REF, home, log }); } catch (error) { log(`::warning::could not refresh the catch-up code (${firstLine(error.message)})`); }
    pruneStaging(devices, { home });
    if (pointer.android !== 'replaced') published.apk = null;
    if (pointer.ios !== 'replaced') published.ota = null;
    await writeReceipt(join(config.out, 'deliver'), buildReceipt({ lane: 'deliver', config, env, version: config.version, androidCode: config.androidCode, notes, published, pointer }), env);
    return { published, pointer, dryRun: false };
  });
}

