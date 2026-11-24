// deliver (design v1.1, B2 and C): publishes what the lanes built and checked to the build directory, under the host
// lock s3-<slug>, in an order that never lets a reader see a pointer to bytes that are not there yet: the versioned
// objects (APK, IPA, icons, receipt), then manifest.plist, then latest.json, then the pages. Then it prunes old
// versions and clears this run's platform from inflight.json. Pointers only move forward. A dry run checks
// everything and writes nothing.
//
// v1.1.3: two jobs run it. deliver-android (scope android) needs only the plan and the android lane, so the APK, its
// latest.json block, the pages and the S26's catch-up never wait for the Mac; deliver-ios (scope ios) publishes the
// IPA when the ios job ends. A device's status comes from its lane's own receipt: a failed Release, Play or TestFlight
// step never turns a pending or installed device into a failure. A lane that succeeded without a receipt the job can
// read is a failure here, not a silent "pending". The slug, the package and the signer are the policy's.
//
// MOBI-14: an extra Android edition never touches latest.json, the app page, the history or the catch-up. deliver-android
// publishes one only when the manifest opts it in (android.editions.<name>.public) AND the policy allows it
// (apps.<repo>.android.editions.<name>.public), after checking its staged APK against the policy's pins for that edition,
// to builds/<slug>/editions/<name>/ (lib/editions.mjs). A private edition is never written to the bucket, nor named in the
// device's public receipt. An edition never holds the device back: its checks and its publication run per edition, the
// publication after the device's pointer, pages and inflight.json; a failed edition is reported (pointer "failed") and
// fails this job only at the very end, once the device's delivery stands, so "Re-run failed jobs" retries it in place.
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { correlationFor } from '../lib/announce.mjs';
import { apkIdentity, verifySigner } from '../lib/android.mjs';
import { refusal } from '../lib/caller.mjs';
import { loadDevices } from '../lib/devices.mjs';
import { apkKey, compareSemver, inflightKey, installUrl, ipaKey, latestKey, manifestKey, mayReplace, pageKey, parseLatest, publicUrl, serializeLatest, versionKey } from '../lib/latest.mjs';
import { withLock } from '../lib/lock.mjs';
import { checksumLine, editionApkKey, editionApkName, editionLane, editionLatestKey, editionPageKey, editionReceiptKey, editionShaKey, isEditionLane, isPublicEdition, mayReplaceEdition, parseEditionPointer, pruneEdition, serializeEditionPointer } from '../lib/editions.mjs';
import { editionsOf, loadManifest } from '../lib/manifest.mjs';
import { manifestPlist, resizeIcon } from '../lib/ota.mjs';
import { appPage, editionPage, indexPage } from '../lib/pages.mjs';
import { appFor, editionPinOf } from '../lib/policy.mjs';
import { buildReceipt, sha256File, writeReceipt } from '../lib/receipt.mjs';
import { notesKey, persistedNotes, validateNotes } from '../lib/release-notes.mjs';
import { jobWriter, publishPages, pruneVersions, readObject } from '../lib/s3.mjs';
import { catchupNote, firstLine, guarded, installCurrent, isoNow, parseNeeds, policyBanner, publicCopy, pruneStaging, readReceipts, requirePlan, runOf, stagingDir } from './common.mjs';

// A device's state in latest.json, from its lane's own receipt: a lane that failed (the build, the device's checks, the
// install or the readback) is failed; a lane that finished keeps the delivery it recorded (installed, pending), even
// when a later step of the job (the Release, Play, TestFlight) failed.
export function deviceOf(device, receipt, { stamp, catchup = null, host = 'this host' }) {
  const delivery = receipt?.delivery;
  const failed = receipt?.outcome === 'failure' && receipt.stage !== 'deliver';
  const status = failed ? 'failed' : ['installed', 'pending', 'skipped', 'failed'].includes(delivery?.status) ? delivery.status : 'pending';
  let why = failed ? receipt.reason ?? delivery?.reason : delivery?.reason;
  if (status === 'pending') why = catchupNote(why, catchup, host);
  return { name: device.name, model: device.model, status, since: stamp, by: status === 'installed' ? 'deploy' : null, reason: why ? String(why).slice(0, 300) : null, failures: 0 };
}

// The new latest.json: each built platform replaces its block only when mayReplace says so. A rerun of the same release
// keeps an install the rerun did not see (an earlier attempt, the catch-up or a person installed it); any other earlier
// state gives way to the rerun's own, so a fresh pending resets an earlier failure and the catch-up tries again. The top
// level moves forward only, and only with a block.
export function mergeLatest({ current, candidates, top, stamp, log = console.log }) {
  const latest = current ? structuredClone(current) : { schema: 1, ...top, updated_at: stamp, android: null, ios: null };
  const pointer = {};
  let moved = false;
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
    const keep = rerun && before.device.status === 'installed' && ['pending', 'skipped'].includes(next.device.status);
    latest[platform] = keep ? { ...next, device: before.device } : next;
    pointer[platform] = 'replaced';
    moved = true;
  }
  if (!current) {
    if (top.mac_bytes === undefined || top.mac_bytes === null) delete latest.mac_bytes;
  } else if (moved && compareSemver(top.version, current.version) >= 0) {
    const { mac_bytes: macBytes, ...rest } = top;
    Object.assign(latest, rest);
    if (macBytes !== undefined && macBytes !== null) latest.mac_bytes = macBytes;
  }
  if (moved || !current) latest.updated_at = stamp;
  if (!latest.android && !latest.ios) return { latest: null, pointer, moved };
  return { latest, pointer, moved };
}

// inflight.json after this deliver: this run's platform is done. Another run's file is left alone.
export function inflightAfter(inflight, run, platforms) {
  if (!inflight || String(inflight.run?.id ?? inflight.run ?? '') !== String(run.id)) return { action: 'keep' };
  const left = (Array.isArray(inflight.platforms) ? inflight.platforms : ['android', 'ios']).filter(platform => !platforms.includes(platform));
  return left.length === 0 ? { action: 'remove' } : { action: 'write', inflight: { ...inflight, platforms: left } };
}

export async function deliver(config, { env = process.env, home = homedir(), fetchImpl = fetch, s3Factory = null, log = console.log, now = () => new Date(), policyFile = undefined } = {}) {
  // policyFile exists only for tests (a synthetic policy); the jobs always read the policy at the action's own tag.
  const { policy } = policyBanner(log, policyFile);
  const manifest = await loadManifest(config.cwd, config.manifest);
  const scope = config.scope === 'both' ? ['android', 'ios'] : [config.scope];
  const lane = config.scope === 'both' ? 'deliver' : `deliver-${config.scope}`;
  return guarded(lane, join(config.out, 'deliver'), config, env, async track => {
    track.stage = 'deliver';
    requirePlan(config);
    const devices = loadDevices(env);
    const app = appFor(policy, env.GITHUB_REPOSITORY ?? '');
    // The policy's slug, never the manifest's alone: a manifest renamed on main after the gate cannot open a new folder.
    if (manifest.project.slug !== app.slug) throw refusal('slug', `the manifest at the build commit says project.slug ${manifest.project.slug}; the policy lists this repository as ${app.slug}`);
    const slug = app.slug;
    const base = policy.delivery.s3.public;
    const needs = parseNeeds(env.HUB_NEEDS);
    const receipts = readReceipts(env.HUB_RECEIPTS || join(config.out, 'receipts'));
    const staging = stagingDir(env, devices, home);
    const run = runOf(env);
    const correlation = correlationFor(env);
    const stamp = isoNow(now());
    const commit = config.buildSha || receipts.plan?.sha || env.GITHUB_SHA;
    if (!/^[0-9a-f]{7,40}$/.test(commit ?? '')) throw new Error('deliver cannot name the commit the build came from');
    const catchup = receipts.gate?.gate?.catchup ?? {};
    const uploads = [];
    const candidates = { android: null, ios: null };
    const notes = [];
    const releaseNotes = receipts.plan?.release_notes
      ? validateNotes(receipts.plan.release_notes, { current: config.version, commit })
      : validateNotes({ schema: 1, version: config.version, commit, previous_version: null, previous_commit: null, status: 'missing', entries: [] }); // old plan receipts

    // A lane that succeeded always leaves a receipt for this version; one this job cannot read (an artifact that did
    // not download, or expired before a rerun) would publish nothing and still look green.
    const laneReceipt = platform => {
      const receipt = receipts[platform];
      const result = needs[platform]?.result;
      if (receipt && receipt.version === config.version) return receipt;
      if (result === 'success') throw new Error(`the ${platform} job succeeded but its receipt for ${config.version} is ${receipt ? `for ${receipt.version}` : 'missing'} (the ${platform === 'android' ? 'android-out' : 'ios-out'} artifact did not download, or expired); nothing was published. Re-run the ${platform} job, or deploy a new version`);
      return null;
    };

    // The APK: staged by the android job after its checks; checked again here, against the policy's pins.
    if (scope.includes('android') && manifest.android) {
      const androidReceipt = laneReceipt('android');
      if (androidReceipt?.staged) {
        const file = join(staging, 'android', androidReceipt.staged.name);
        if (!existsSync(file)) throw new Error(`the staged APK ${androidReceipt.staged.name} is missing from big-chungus staging`);
        const sha256 = await sha256File(file);
        if (sha256 !== androidReceipt.staged.sha256) throw new Error(`the staged APK has sha256 ${sha256}, the android receipt says ${androidReceipt.staged.sha256}`);
        const signer = verifySigner({ apk: file, expected: app.android.signer_sha256, env, home }).signer_sha256;
        const identity = apkIdentity({ apk: file, env, home });
        if (identity.package !== app.android.package || identity.versionName !== config.version || String(identity.versionCode) !== String(config.androidCode)) throw new Error(`the staged APK is ${identity.package} ${identity.versionName} (${identity.versionCode}), not ${app.android.package} ${config.version} (${config.androidCode})`);
        const key = apkKey(slug, config.version, Number(config.androidCode));
        candidates.android = {
          package: app.android.package, version: config.version, code: Number(config.androidCode), key, url: publicUrl(base, key), bytes: statSync(file).size, sha256, signer_sha256: signer,
          quickdrop: androidReceipt.quickdrop?.status === 'written' && androidReceipt.quickdrop.name ? `builds/${androidReceipt.quickdrop.name}` : null,
          device: deviceOf(devices.android, androidReceipt, { stamp, catchup: catchup.android, host: devices.linux.host }), run, correlation, commit,
        };
        uploads.push({ platform: 'android', file, key });
      } else if (androidReceipt && needs.android?.result === 'success') {
        throw new Error('the android job succeeded but its receipt names no staged APK; nothing was published');
      }
    }

    // The extra Android editions: checked here again, against the policy's pins for each, and published only when public.
    const editions = scope.includes('android') && manifest.android ? await editionCandidates({ manifest, app, slug, base, receipts, staging, config, env, home, run, correlation, commit, stamp, notes, log }) : [];

    // The IPA: back from the Mac when the iPad needs it over the air (or the link was free); otherwise no OTA copy.
    if (scope.includes('ios') && manifest.ios) {
      const iosReceipt = laneReceipt('ios');
      if (iosReceipt?.ipa?.verified) {
        const ipa = iosReceipt.ipa;
        const block = { bundle: app.ios.bundle, version: config.version, build: String(ipa.build), key: null, url: null, bytes: ipa.bytes ?? null, sha256: ipa.sha256, manifest_url: null, install_url: null, device: deviceOf(devices.ios, iosReceipt, { stamp, catchup: catchup.ios, host: 'the Mac' }), run, correlation, commit };
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

    const iosMac = scope.includes('ios') ? receipts.ios?.mac_bytes : null;
    const top = { slug, name: manifest.project.name, version: config.version, commit, hub_ref: env.HUB_REF || null, run, correlation, mac_bytes: iosMac ? (iosMac.in ?? 0) + (iosMac.out ?? 0) : undefined };
    const published = {
      apk: candidates.android?.url ?? null,
      apk_bytes: candidates.android?.bytes ?? null,
      ota: candidates.ios?.install_url ?? null,
      ipa_bytes: candidates.ios?.key ? candidates.ios.bytes : null,
      page: publicUrl(base, pageKey(slug)),
      manifest: candidates.ios?.manifest_url ?? null,
      any: Boolean(candidates.android || candidates.ios),
    };

    if (config.dryRun) {
      const currentText = await readObject(policy, latestKey(slug), { fetchImpl, env });
      const current = currentText ? parseLatest(currentText, { slug }) : null;
      const merged = mergeLatest({ current, candidates, top, stamp, log });
      if (merged.latest) {
        serializeLatest(merged.latest);
        appPage({ latest: merged.latest });
        indexPage([merged.latest]);
      }
      if (candidates.ios?.key) manifestPlist({ ipaUrl: candidates.ios.url, bundle: candidates.ios.bundle, version: candidates.ios.version, title: manifest.project.name, displayImage: icons[57] ?? null, fullSizeImage: icons[512] ?? null });
      for (const edition of editions.filter(item => item.candidate)) {
        try {
          const text = await readObject(policy, editionLatestKey(slug, edition.name), { fetchImpl, env });
          const current = text ? parseEditionPointer(text, { slug, edition: edition.name }) : null;
          const verdict = mayReplaceEdition(current, edition.candidate);
          serializeEditionPointer(edition.candidate);
          editionPage(edition.candidate);
          edition.pointer = verdict.replace ? 'would replace' : 'kept';
          log(`HUB_EDITION_DRY_RUN ${edition.name} would publish ${verdict.replace ? `${edition.candidate.key}, its checksum, receipt, ${editionLatestKey(slug, edition.name)} and ${editionPageKey(slug, edition.name)}` : `nothing (${verdict.reason})`}; nothing was written`);
        } catch (error) { failEdition(edition, error, notes, log); }
      }
      // Only this scope's staging: the other deliver job may still need its own half.
      for (const platform of scope) rmSync(join(staging, platform), { recursive: true, force: true });
      log(`HUB_PUBLISH_DRY_RUN would publish ${uploads.map(item => item.key).join(', ') || 'no build'}${merged.moved ? `, ${latestKey(slug)} (android ${merged.pointer.android}, ios ${merged.pointer.ios}), the pages` : ''}; nothing was written`);
      await writeReceipt(join(config.out, 'deliver'), buildReceipt({ lane, config, env, version: config.version, androidCode: config.androidCode, notes: [...notes, 'dry run: checked and rendered, nothing written'], published: { ...published, dry_run: true }, pointer: merged.pointer, ...editionReport(editions) }), env);
      editionVerdict(editions, track, { published: { ...published, dry_run: true }, pointer: merged.pointer, notes, ...editionReport(editions) });
      return { published, pointer: merged.pointer, dryRun: true, editions: editionReport(editions).editions ?? [] };
    }

    const s3 = s3Factory ? await s3Factory() : await jobWriter(policy, env);
    let pointer = {};
    await withLock(`s3-${slug}`, async () => {
      const currentText = await readObject(policy, latestKey(slug), { fetchImpl, env });
      const current = currentText ? parseLatest(currentText, { slug }) : null;
      const merged = mergeLatest({ current, candidates, top, stamp, log });
      pointer = merged.pointer;
      if (merged.latest && merged.moved) {
        const key = notesKey(slug, config.version);
        const saved = merged.latest.version === config.version ? await readObject(policy, key, { fetchImpl, env }) : null;
        // A version already published (including the other platform's earlier delivery) owns its notes.
        // An old release without notes stays missing; never silently rewrite its record from newer sources.
        const canonical = persistedNotes(saved, releaseNotes, { current: config.version, commit });
        if (!saved && merged.latest.version === config.version) s3.putText(`${JSON.stringify(canonical, null, 2)}\n`, key);
        // 1. versioned objects, for the blocks this run moves (an older run's bytes are not uploaded over a newer pointer)
        for (const upload of uploads) if (pointer[upload.platform] === 'replaced') s3.put(upload.file, upload.key);
        // The device edition's receipt file names no extra edition: a private one is not even mentioned publicly.
        const deviceReceipts = publicReceipts(receipts);
        s3.putText(`${JSON.stringify(publicCopy({ run, correlation, hub_ref: env.HUB_REF || null, receipts: deviceReceipts }), null, 2)}\n`, versionKey(slug, config.version, `receipt${config.scope === 'both' ? '' : `-${config.scope}`}.json`));
        // 2. the one OTA manifest, always the newest IPA (or none: OTA allows downgrades, so an older IPA is never offered)
        if (pointer.ios === 'replaced') {
          if (merged.latest.ios.key) s3.putText(manifestPlist({ ipaUrl: merged.latest.ios.url, bundle: merged.latest.ios.bundle, version: merged.latest.ios.version, title: manifest.project.name, displayImage: icons[57] ?? null, fullSizeImage: icons[512] ?? null }), manifestKey(slug));
          else { try { s3.remove(manifestKey(slug)); } catch { /* none yet */ } }
        }
        // 3. the pointer, 4. the pages
        s3.putText(serializeLatest(merged.latest), latestKey(slug));
        await publishPages({ s3, policy, slug, latest: merged.latest, currentNotes: merged.latest.version === config.version ? canonical : null, fetchImpl, env });
        // 5. retention
        const removed = pruneVersions({ s3, policy, slug, latest: merged.latest });
        if (removed.length > 0) notes.push(`pruned ${removed.length} old objects`);
        log(`HUB_PUBLISHED ${slug} ${config.version}: ${uploads.filter(item => pointer[item.platform] === 'replaced').map(item => item.key).join(', ') || 'no new build'}; ${latestKey(slug)} android ${pointer.android}, ios ${pointer.ios}; ${pageKey(slug)}, index.html`);
      } else {
        log(`HUB_PUBLISHED nothing for ${scope.join(' and ')}: ${Object.values(candidates).some(Boolean) ? `the pointer stays (android ${pointer.android}, ios ${pointer.ios})` : 'no lane staged a build in this scope'}`);
      }
      // 6. this run's platform is no longer in flight
      try {
        const text = await readObject(policy, inflightKey(slug), { fetchImpl, env });
        const next = inflightAfter(text ? JSON.parse(text) : null, run, scope);
        if (next.action === 'remove') s3.remove(inflightKey(slug));
        else if (next.action === 'write') s3.putText(`${JSON.stringify(next.inflight)}\n`, inflightKey(slug));
      } catch (error) { log(`::warning::could not update ${inflightKey(slug)} (${firstLine(error.message)}); the catch-up treats it as stale after 6 hours`); }
      // 7. each public edition, in its own folder with its own pointer, after everything the device needs: a failure here
      // is that edition's alone.
      for (const edition of editions.filter(item => item.candidate)) {
        try { await publishEdition({ s3, policy, slug, edition, receipts, run, correlation, env, fetchImpl, log, notes }); } catch (error) { failEdition(edition, error, notes, log); }
      }
    }, { env, timeoutMs: 30 * 60_000 });

    try { installCurrent({ hubRef: env.HUB_REF, home, log }); } catch (error) { log(`::warning::could not refresh the catch-up code (${firstLine(error.message)})`); }
    pruneStaging(devices, { home });
    if (pointer.android !== 'replaced') { published.apk = null; published.apk_bytes = null; }
    if (pointer.ios !== 'replaced') { published.ota = null; published.ipa_bytes = null; }
    await writeReceipt(join(config.out, 'deliver'), buildReceipt({ lane, config, env, version: config.version, androidCode: config.androidCode, notes, published, pointer, ...editionReport(editions) }), env);
    editionVerdict(editions, track, { published, pointer, notes, ...editionReport(editions) });
    return { published, pointer, dryRun: false, editions: editionReport(editions).editions ?? [] };
  });
}

// The receipts as the build directory may show them: no edition lane, and no editions list in the android lane's own
// receipt. A private edition's package, file name and checksum never leave the private side; a public one is described
// by its own receipt.json in its own folder.
export function publicReceipts(receipts) {
  const kept = Object.fromEntries(Object.entries(receipts).filter(([name]) => !isEditionLane(name)));
  for (const [name, receipt] of Object.entries(kept)) {
    if (receipt && typeof receipt === 'object' && ('editions' in receipt || 'contention' in receipt)) { const { editions: _editions, contention: _contention, ...rest } = receipt; kept[name] = rest; }
  }
  return kept;
}

function failEdition(edition, error, notes, log) {
  edition.pointer = 'failed';
  edition.candidate = null;
  edition.reason = firstLine(error.message).replace(/^::error::/, '').slice(0, 300);
  notes.push(`edition ${edition.name} failed: ${edition.reason}`);
  log(`::error::edition ${edition.name} (${edition.package}) was not published: ${edition.reason}; the device's delivery stands`);
}

// After the device's delivery is written: a failed edition fails the job (announce reports stage deliver, the device's
// delivery standing), and the failure receipt keeps what was published.
function editionVerdict(editions, track, receipt) {
  const failed = editions.filter(item => item.pointer === 'failed');
  if (failed.length === 0) return;
  track.receipt = receipt;
  throw new Error(`the ${failed.map(item => item.name).join(' and ')} edition${failed.length > 1 ? 's were' : ' was'} not published (${failed.map(item => `${item.name}: ${item.reason}`).join('; ')}); the device's delivery stands. Fix the cause, then Re-run failed jobs (no new version)`);
}

// The extra editions of this deploy, each held to the policy: [{name, package, public, candidate, file, pointer}].
// A private edition (no manifest opt-in, or the policy does not allow it) gets no candidate and is never written. A
// public one needs its own receipt for this version and its staged APK, which must be the receipt's bytes, signed by the
// policy's pin for that edition, of the policy's package at the planned version and code.
async function editionCandidates({ manifest, app, slug, base, receipts, staging, config, env, home, run, correlation, commit, stamp, notes, log = console.log }) {
  const declared = editionsOf(manifest);
  if (declared.length === 0) return [];
  const device = receipts.android;
  const deviceOk = device && device.version === config.version && device.outcome === 'success';
  const result = [];
  for (const { name, spec } of declared) {
    const pin = editionPinOf(app, name);
    const open = isPublicEdition(spec, pin);
    const entry = { name, package: pin?.package ?? spec.package, public: open, candidate: null, file: null, pointer: open ? 'none' : 'private', page: open ? publicUrl(base, editionPageKey(slug, name)) : null };
    result.push(entry);
    // Each edition is checked on its own: one that fails is reported and published nowhere, and never holds back the
    // device edition or another edition.
    try { await editionCandidate({ entry, name, spec, pin, open, manifest, slug, base, receipts, staging, config, env, home, run, correlation, commit, stamp, notes, deviceOk }); } catch (error) { failEdition(entry, error, notes, log); }
  }
  return result;
}

async function editionCandidate({ entry, name, spec, pin, open, manifest, slug, base, receipts, staging, config, env, home, run, correlation, commit, stamp, notes, deviceOk }) {
  if (!pin) throw refusal('pins', `the manifest at the build commit declares the Android edition ${name}; the policy pins no such edition`);
  if (spec.package !== pin.package || spec.signer_sha256 !== pin.signer_sha256) throw refusal('pins', `the manifest's android.editions.${name} differs from the policy's pins (${pin.package})`);
  if (spec.public && pin.public !== true) throw refusal('pins', `the manifest asks to publish the ${name} edition publicly; the policy does not allow it`);
  if (!open) { notes.push(`edition ${name} (${pin.package}) is private: built and verified, never published to the build directory`); return; }
  if (!deviceOk) { notes.push(`edition ${name}: the android lane did not finish ${config.version}, so the edition is not published`); entry.pointer = 'not built'; return; }
  const receipt = receipts[editionLane(name)];
  if (!receipt || receipt.version !== config.version || receipt.outcome !== 'success' || !receipt.staged) throw new Error(`the android job succeeded but the ${name} edition's receipt for ${config.version} is ${receipt ? 'incomplete' : 'missing'}; nothing of it was published`);
  const expected = editionApkName(slug, name, config.version, config.androidCode);
  if (receipt.staged.name !== expected) throw new Error(`the ${name} edition's receipt names ${receipt.staged.name}, not ${expected}`);
  const file = join(staging, 'android', 'editions', name, expected);
  if (!existsSync(file)) throw new Error(`the staged ${name} edition APK ${expected} is missing from big-chungus staging`);
  const sha256 = await sha256File(file);
  if (sha256 !== receipt.staged.sha256) throw new Error(`the staged ${name} edition APK has sha256 ${sha256}, its receipt says ${receipt.staged.sha256}`);
  const signer = verifySigner({ apk: file, expected: pin.signer_sha256, env, home }).signer_sha256;
  const identity = apkIdentity({ apk: file, env, home });
  if (identity.package !== pin.package || identity.versionName !== config.version || String(identity.versionCode) !== String(config.androidCode)) throw new Error(`the staged ${name} edition APK is ${identity.package} ${identity.versionName} (${identity.versionCode}), not ${pin.package} ${config.version} (${config.androidCode})`);
  const key = editionApkKey(slug, name, config.version, Number(config.androidCode));
  entry.file = file;
  entry.candidate = {
    schema: 1, slug, app: manifest.project.name, edition: name, title: spec.public.title ?? `${name} edition`, package: pin.package,
    version: config.version, code: Number(config.androidCode), key, url: publicUrl(base, key), bytes: statSync(file).size, sha256,
    sha256_url: publicUrl(base, editionShaKey(slug, name, config.version, Number(config.androidCode))), signer_sha256: signer, commit, run, correlation, updated_at: stamp,
  };
}

// Inside the s3-<slug> lock: the bytes (APK, checksum, receipt) first, then the pointer, then the page, then retention.
// The pointer moves forward only; an older or foreign build of the same release leaves it alone.
async function publishEdition({ s3, policy, slug, edition, receipts, run, correlation, env, fetchImpl, log, notes }) {
  const text = await readObject(policy, editionLatestKey(slug, edition.name), { fetchImpl, env });
  const current = text ? parseEditionPointer(text, { slug, edition: edition.name }) : null;
  const verdict = mayReplaceEdition(current, edition.candidate);
  if (!verdict.replace) { edition.pointer = 'kept'; log(`HUB_EDITION_POINTER ${edition.name} ${verdict.reason}`); return; }
  const next = edition.candidate;
  s3.put(edition.file, next.key);
  s3.putText(checksumLine(next.sha256, next.key.split('/').pop()), `${next.key}.sha256`);
  s3.putText(`${JSON.stringify(publicCopy({ run, correlation, hub_ref: env.HUB_REF || null, receipt: receipts[editionLane(edition.name)] }), null, 2)}\n`, editionReceiptKey(slug, edition.name, next.version));
  s3.putText(serializeEditionPointer(next), editionLatestKey(slug, edition.name));
  s3.putText(editionPage(next), editionPageKey(slug, edition.name));
  const removed = pruneEdition({ s3, policy, slug, edition: edition.name, pointer: next });
  if (removed.length > 0) notes.push(`pruned ${removed.length} old ${edition.name} edition objects`);
  edition.pointer = 'replaced';
  log(`HUB_EDITION_PUBLISHED ${edition.name} ${next.package} ${next.version} (${next.code}): ${next.url} sha256=${next.sha256}; ${editionPageKey(slug, edition.name)}`);
}

function editionReport(editions) {
  if (editions.length === 0) return {};
  return { editions: editions.map(item => ({ name: item.name, package: item.package, public: item.public, pointer: item.pointer, url: item.pointer === 'replaced' ? item.candidate.url : null, page: item.page, ...(item.reason ? { reason: item.reason } : {}) })) };
}
