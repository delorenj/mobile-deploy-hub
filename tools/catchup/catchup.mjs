#!/usr/bin/env node
// Catch-up installers (docs/design-hub-v1.1.md, section E). A deploy publishes every build even when a device is
// away and marks that device `pending` in builds/<slug>/latest.json. These passes finish the job when it comes back:
//   android  big-chungus, candybar mobile-deploy-hub-catchup every 120 s (runs the .service): the dedicated QA phones on the hub's own
//            adb servers (MOBI-48, below), then the S26 on this host's adb server
//   ios      the Mac, LaunchAgent in gui/502, kickstarted every 300 s by candybar mobile-deploy-hub-ios-catchup: the iPad through devicectl, from the Mac's IPA outbox
//   record   big-chungus: one device's new status into latest.json, under the s3-<slug> lock, and the one event
//            (the Mac calls it over ssh)
//   retry    big-chungus: a device that gave up goes back to pending
//   mode     watch | live. A pass in watch mode reads everything and logs what it would do; it installs nothing,
//            writes nothing and sends nothing. A host without a mode file is in watch mode.
//
// The guarantees are a deploy's: installs are in place only (adb install -r, devicectl device install app), never
// over a newer build, only after the bytes match latest.json (sha256) and the policy's pins (on Android the package and
// the signer, on iOS the bundle: a latest.json that disagrees with the policy is refused, whoever wrote it), and every
// install is read back. One event per status change, none for a device the deploy itself installed.
//
// v1.2.35 (TOLT-152): a build the deploy installed can be replaced later by another channel with the same bundle id (a
// TestFlight build over the development build is the known case). The iPad pass also reads each app whose ios block
// is not pending; a device holding an OLDER build than latest.json is repaired in place, once, by the same install a
// pending build gets (the "displaced" repair). A newer or missing app is never touched, watch mode only logs, and a
// device that keeps being displaced is repaired at most iosRepairsPerDay times per day per app.
//
// v1.1.3: a deploy in flight holds every pending build of that app at or below its version, on both passes (an older
// build is never installed minutes before the deploy installs a newer one); a device in use waits for the next pass
// (the S26 while the app is on top with the screen on; the iPad while the app runs, for up to 45 minutes, since
// devicectl cannot tell the foreground); the Mac reads its pointers with a strong ETag (a weak one never revalidates)
// and over ssh from big-chungus when https://s3.delo.sh does not answer.
//
// latest.json is the hub's contract (tools/ci/lib/latest.mjs parses, validates and updates it); the rules come from
// tools/ci/policy.json at the code this runs; writes go through the hub's builds writer (tools/ci/lib/s3.mjs).
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { accessOf, isAnonymous, linkCacheControl, linkLifetimeS } from '../ci/lib/access.mjs';
import { createAdb, findPhone } from '../ci/lib/adb.mjs';
import { apkIdentity, verifySigner } from '../ci/lib/android.mjs';
import { sanitizeReason } from '../ci/lib/announce.mjs';
import { loadDevices } from '../ci/lib/devices.mjs';
import { createDevicectl, createIpad } from '../ci/lib/devicectl.mjs';
import { runBounded } from '../ci/lib/exec.mjs';
import { apkKey, compareRelease, compareSemver, inflightKey, ipaKey, isBusyPending, latestKey, platforms, serializeLatest, updateDevice, validateLatest } from '../ci/lib/latest.mjs';
import { checkDelivery, deliveryPendingEvent, leaseHoldersSince, noteRefused, withLock } from '../ci/lib/lock.mjs';
import { loadPolicy } from '../ci/lib/policy.mjs';
import { sha256File } from '../ci/lib/receipt.mjs';
import { awayHint, dedicatedPhones, foreignHolders, qaAdbEnv, reapIfFree, reapQaServer } from '../ci/lib/qa-phones.mjs';
import { createS3, publishPages, writerCredentials } from '../ci/lib/s3.mjs';
import { presign } from '../ci/lib/sigv4.mjs';
import { catchupEvent, sendCatchupEvent } from './report.mjs';
import { createStore, downloadVerified } from './store.mjs';

export { platforms };

const semver = /^\d+\.\d+\.\d+$/;
const sha256Pattern = /^[0-9a-f]{64}$/;
const slugPattern = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const buildPattern = /^[0-9][0-9.]{0,39}$/;
const reasonPattern = /^[\w .,:;()+=#@%<>-]{1,300}$/;
const inflightStaleMs = 6 * 3600_000;
// How long the iPad pass waits while the app runs (devicectl cannot tell a game on screen from a suspended one).
export const iosBusyCapMs = 45 * 60_000;
// The flap guard: a device displaced again and again (a TestFlight auto-update fighting the hub) is repaired this many
// times per UTC day per app, then only logged.
export const iosRepairsPerDay = 3;
// The watchdog stops a pass at passLimitMs. The reserve is what a pass still needs after it wins the lock (download, install,
// readback, record), so a long wait never runs into the watchdog.
export const passLimitMs = 45 * 60_000;
export const passReserveMs = 10 * 60_000;

const stamp = date => date.toISOString().replace(/\.\d{3}Z$/, 'Z');
const oneLine = error => sanitizeReason(error?.message ?? error, 'failed').replace(/\s+/g, ' ').slice(0, 240);
export const buildOf = (block, platform) => String(platform === 'android' ? block.code : block.build);
const describe = (version, build) => `${version} (${build})`;
const releaseOf = (platform, version, build) => (platform === 'android' ? { version, code: Number(build) } : { version, build: String(build) });

// ---------------------------------------------------------------------------------------------------- settings

// The policy's values the catch-up uses (A1), from a policy the hub's parser accepted.
export function settingsFrom(policy) {
  const { s3 } = policy.delivery;
  return {
    // Each app's pins (android: package, signer_sha256; ios: bundle) come with it: latest.json must agree with them.
    apps: Object.entries(policy.apps).map(([repo, app]) => ({ repo, slug: app.slug, lanes: app.lanes, android: app.android ?? null, ios: app.ios ?? null })),
    policy,
    bucket: s3.bucket,
    publicRoot: s3.public,
    write: s3.write,
    loopbackRoot: `${s3.write}/${s3.bucket}`,
    maxFailures: policy.catch_up.max_failures,
    lanCidr: policy.mac.lan_cidr,
    // A1 event.catch_up: whether a catch-up install sends its event at all.
    events: policy.event.catch_up !== false,
    // Story 3.3 (AD-11): the short attempt every pass makes, and how long a contention-pending build stays in line for its turn.
    attemptMs: policy.queue.catchup_attempt_s * 1000,
    pendingWaitMs: policy.queue.catchup_pending_wait_min * 60_000,
  };
}

export function loadSettings() {
  const { policy, short } = loadPolicy();
  return { ...settingsFrom(policy), digest: short };
}

const ipv4 = text => {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text ?? '');
  if (!match) return null;
  const parts = match.slice(1).map(Number);
  return parts.some(part => part > 255) ? null : parts.reduce((total, part) => total * 256 + part, 0);
};

export function inCidr(address, cidr) {
  const value = ipv4(address);
  const [network, bits] = String(cidr ?? '').split('/');
  const base = ipv4(network);
  if (value === null || base === null || !/^\d{1,2}$/.test(bits ?? '') || Number(bits) > 32) return false;
  const size = 2 ** (32 - Number(bits));
  return Math.floor(value / size) === Math.floor(base / size);
}

// ---------------------------------------------------------------------------------------------------- latest.json

// The hub's validator, plus what the catch-up needs on top: each key names exactly that release's file (the
// download URL is built from the key, never taken from the url field), and the package, signer and bundle are the
// policy's pins (`app`), so a latest.json written by anyone else cannot point a device at another app or another key.
export function latestProblems(latest, slug, base, app = null) {
  try {
    validateLatest(latest, { slug, base });
  } catch (error) {
    return [String(error.message).replace(/^latest\.json: /, '').slice(0, 200)];
  }
  const problems = [];
  if (latest.android && latest.android.key !== apkKey(slug, latest.android.version, latest.android.code)) problems.push('android.key does not name this release\'s APK');
  if (latest.ios?.key && latest.ios.key !== ipaKey(slug, latest.ios.version, latest.ios.build)) problems.push('ios.key does not name this release\'s IPA');
  if (app && latest.android) {
    if (!app.android) problems.push('the policy pins no Android package for this app');
    else {
      if (latest.android.package !== app.android.package) problems.push(`android.package ${latest.android.package} is not the policy's ${app.android.package}`);
      if (latest.android.signer_sha256 !== app.android.signer_sha256) problems.push('android.signer_sha256 is not the policy\'s signer');
    }
  }
  if (app && latest.ios) {
    if (!app.ios) problems.push('the policy pins no iOS bundle for this app');
    else if (latest.ios.bundle !== app.ios.bundle) problems.push(`ios.bundle ${latest.ios.bundle} is not the policy's ${app.ios.bundle}`);
  }
  return problems;
}

// ---------------------------------------------------------------------------------------------------- decisions

// What the S26 pass does for one pending build, from the installed package (E2's table: the codes decide).
// `compare-bytes` means the codes are equal: the base.apk sha256 tells a person's install of these bytes from other
// bytes of the same code.
export function androidPlan(installed, block) {
  if (!installed) return { action: 'install', was: 'nothing' };
  const was = describe(installed.versionName, installed.versionCode);
  if (installed.versionCode > block.code) return { action: 'ahead', was };
  if (installed.versionCode < block.code) return { action: 'install', was };
  if (installed.versionName !== block.version) return { action: 'conflict', was };
  return { action: 'compare-bytes', was };
}

// E3: the version as semver first, then the build (a number, or a dotted version like Gruvato's "0.2.5"). 1, 0 or -1
// for installed vs published; null when the installed build cannot be compared.
export function compareIos(installed, block) {
  if (!installed) return -1;
  try {
    return compareRelease('ios', { version: installed.version, build: installed.build }, block);
  } catch {
    return null;
  }
}

export function iosPlan(installed, block) {
  const was = installed ? describe(installed.version, installed.build) : 'nothing';
  const order = compareIos(installed, block);
  if (order === null) return { action: 'conflict', was };
  if (order > 0) return { action: 'ahead', was };
  if (order === 0) return { action: 'confirm', was };
  return { action: 'install', was };
}

// ---------------------------------------------------------------------------------------------------- host state

// The mode lives outside the code (which every real run replaces), one file per host. No file means watch.
export const modeFile = (env = process.env, home = homedir()) => join(env.XDG_CONFIG_HOME || join(home, '.config'), 'mobile-deploy-hub/catchup.json');

export function readMode({ env = process.env, home = homedir() } = {}) {
  try { return JSON.parse(readFileSync(modeFile(env, home), 'utf8'))?.mode === 'live' ? 'live' : 'watch'; } catch { return 'watch'; }
}

function writeAtomic(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  const part = `${path}.${process.pid}.part`;
  writeFileSync(part, text);
  renameSync(part, path);
}

export function writeMode(mode, { env = process.env, home = homedir(), now = new Date() } = {}) {
  if (!['watch', 'live'].includes(mode)) throw new Error(`mode must be watch or live, got "${mode}"`);
  writeAtomic(modeFile(env, home), `${JSON.stringify({ mode, changed_at: stamp(now) })}\n`);
  return mode;
}

// What this host installed itself. When the recording of an install was lost (the bus or MinIO was down), the next
// pass finds the build installed and the journal tells it the catch-up did that, not a person.
export const journalFile = (env = process.env, home = homedir()) => join(env.XDG_STATE_HOME || join(home, '.local/state'), 'mobile-deploy-hub/catchup-journal.json');

export function createJournal({ env = process.env, home = homedir(), now = () => new Date() } = {}) {
  const path = journalFile(env, home);
  const read = () => { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return {}; } };
  return {
    mine(slug, platform, block) {
      const entry = read().installs?.[`${slug}/${platform}`];
      return Boolean(entry) && entry.version === block.version && entry.build === buildOf(block, platform) && entry.sha256 === block.sha256;
    },
    put(slug, platform, block) {
      const document = read();
      document.installs = { ...document.installs, [`${slug}/${platform}`]: { version: block.version, build: buildOf(block, platform), sha256: block.sha256, at: stamp(now()) } };
      if (document.busy) delete document.busy[`${slug}/${platform}`];
      writeAtomic(path, `${JSON.stringify(document, null, 2)}\n`);
    },
    // The displaced-build repairs this host made today (UTC), per app: the flap guard's memory.
    repairsToday(slug, platform) {
      const entry = read().repairs?.[`${slug}/${platform}`];
      return entry && entry.day === stamp(now()).slice(0, 10) && Number.isSafeInteger(entry.count) ? entry.count : 0;
    },
    repairAttempt(slug, platform) {
      const document = read();
      const day = stamp(now()).slice(0, 10);
      const key = `${slug}/${platform}`;
      const count = (document.repairs?.[key]?.day === day && Number.isSafeInteger(document.repairs[key].count) ? document.repairs[key].count : 0) + 1;
      document.repairs = { ...document.repairs, [key]: { day, count } };
      writeAtomic(path, `${JSON.stringify(document, null, 2)}\n`);
      return count;
    },
    // When this build was first found in use on the device (kept until it is installed), in milliseconds.
    busySince(slug, platform, block) {
      const document = read();
      const key = `${slug}/${platform}`;
      const entry = document.busy?.[key];
      if (entry && entry.version === block.version && entry.build === buildOf(block, platform) && Number.isFinite(Date.parse(entry.since))) return Date.parse(entry.since);
      document.busy = { ...document.busy, [key]: { version: block.version, build: buildOf(block, platform), since: stamp(now()) } };
      writeAtomic(path, `${JSON.stringify(document, null, 2)}\n`);
      return now().getTime();
    },
  };
}

export function defaultLog(env = process.env) {
  // journald stamps its own lines; the Mac's log file does not.
  const stamped = !env.INVOCATION_ID;
  return line => console.log(stamped ? `${stamp(new Date())} ${line}` : line);
}

// ---------------------------------------------------------------------------------------------------- outcomes

const markerOf = { installed: 'HUB_CATCHUP_INSTALLED', confirmed: 'HUB_CATCHUP_CONFIRMED', repaired: 'HUB_CATCHUP_REPAIRED' };
const statusOf = { installed: 'installed', confirmed: 'installed', repaired: 'repaired', ahead: 'skipped', failure: 'failure' };

function outcome(item, platform, kind, fields) {
  const { app, latest, block } = item;
  return { kind, slug: app.slug, repo: app.repo, platform, latest, block, version: block.version, build: buildOf(block, platform), ...fields };
}

const stageError = (stage, message) => Object.assign(new Error(message), { stage });

function failure(item, platform, error, fallbackStage = 'install') {
  const adbFailure = /Failure \[[A-Z_]+[^\]]*\]/.exec(error?.message ?? '')?.[0];
  const reason = adbFailure ? `adb install -r refused it: ${adbFailure}` : oneLine(error);
  return outcome(item, platform, 'failure', { stage: error?.stage ?? fallbackStage, reason: reason.slice(0, 200) });
}

// What record needs to know about a result: the release it acted on and the deploy that published that release (each
// block carries its own run, correlation and commit; a deploy that skipped a platform kept that platform's block).
export function factsOf(result) {
  const { block, latest } = result;
  return {
    slug: result.slug,
    platform: result.platform,
    version: result.version,
    build: result.build,
    sha256: block.sha256,
    status: statusOf[result.kind],
    by: result.kind === 'installed' || result.kind === 'repaired' ? 'catch-up' : result.kind === 'confirmed' ? 'manual' : null,
    reason: result.reason ?? null,
    stage: result.stage ?? null,
    commit: block.commit,
    run: { ...block.run },
    correlation: block.correlation,
    hub_ref: block.run.id === latest.run.id ? latest.hub_ref : null,
    name: latest.name,
  };
}

// How far before a build's `device.since` the deploy's `delivery-pending` timeout is looked for (FR-30): the deploy waits its budget
// before it marks the device pending, so the event is minutes earlier; six hours is far more than any wait.
export const pendingLookbackMs = 6 * 3600_000;
// The Queued lock each platform's device sits behind.
const lockOf = { android: 'adb', ios: 'mac-ios' };

// Who put the newer build on the device (AD-15, FR-30): the Lease holders on the device's lock since the build went pending, read
// from this host's Event Log. The window starts at the deploy's `delivery-pending` timeout for this build when the log has one,
// else at latest.json's `device.since`. Never throws: an unreadable log reads as no holders. Names stay in the Event Log and the
// host's own log line; never in latest.json, the pages or a bus event.
export function whoInstalled(ctx, result) {
  const lock = lockOf[result.platform] ?? null;
  let delivery = null;
  try { delivery = checkDelivery({ repo: result.repo, run: String(result.block.run.id), version: result.block.version }); } catch { delivery = null; }
  const sinceDevice = Date.parse(result.block?.device?.since);
  const nowMs = ctx.now().getTime();
  const fallback = Number.isFinite(sinceDevice) ? sinceDevice : nowMs;
  let since = fallback;
  let from = 'latest.json';
  let holders = [];
  try {
    const pending = delivery ? deliveryPendingEvent(lock, delivery, { env: ctx.env, since: fallback - pendingLookbackMs, log: () => {} }) : null;
    const pendingAt = Date.parse(pending?.ts);
    if (Number.isFinite(pendingAt)) { since = pendingAt; from = 'pending-event'; }
    holders = leaseHoldersSince(lock, since, { env: ctx.env, log: () => {} });
  } catch { holders = []; }
  return { lock, delivery, since, from, holders };
}

const installedByText = who => `installed by ${who.holders.length > 0 ? who.holders.map(hold => `${hold.holder ?? 'someone'} (lease ${hold.lease_id})`).join(', ') : 'unknown'} (Leases on ${who.lock} since ${new Date(who.since).toISOString()})`;

// Logs one result; in live mode also records it. Returns false when something went wrong that the logs must show.
async function settle(ctx, result) {
  const where = `${result.slug} ${result.platform} ${describe(result.version, result.build)}`;
  if (result.kind === 'idle') { ctx.log(`HUB_CATCHUP_IDLE ${where}: ${result.message}`); return true; }
  // A checked build that needs nothing (the iPad holds it, or something newer) is summed up once per pass, not recorded.
  if (result.kind === 'quiet') return true;
  // A repair that failed changes nothing in latest.json (the build is installed there); it is logged, counted by the
  // flap guard and tried again on a later pass.
  if (result.kind === 'repair-failed') { ctx.log(`HUB_CATCHUP_REPAIR_FAILED ${where}: attempt failed at ${result.stage}: ${result.reason}`); return false; }
  // A refusal names who put the newer build there (FR-30); the names go to the log line and the Event Log only.
  const who = result.kind === 'ahead' ? whoInstalled(ctx, result) : null;
  const named = who ? `; ${installedByText(who)}` : '';
  if (ctx.mode !== 'live') {
    const would = { installed: 'record installed (HUB_CATCHUP_INSTALLED)', confirmed: 'record installed by a person (HUB_CATCHUP_CONFIRMED)', ahead: `record skipped (${result.marker})`, failure: 'count a failed attempt', 'would-install': 'install', 'would-repair': 'repair the displaced build (reinstall in place)' }[result.kind];
    ctx.log(`HUB_CATCHUP_WATCH ${where}: would ${would}: ${result.message ?? result.reason}${named}`);
    return true;
  }
  if (result.kind === 'failure') ctx.log(`HUB_CATCHUP_PENDING ${where}: attempt failed at ${result.stage}: ${result.reason}`);
  else ctx.log(`${result.marker ?? markerOf[result.kind]} ${where}: ${result.message}${named}`);
  let recorded;
  try {
    recorded = await ctx.record(factsOf(result));
  } catch (error) {
    ctx.log(`HUB_CATCHUP_ERROR ${where}: could not record it (${oneLine(error)}); the next pass finds it again`);
    return false;
  }
  // Written unless record reports `changed: false` (latest.json already said it). A moved pointer still counts: the device does run a
  // newer build. The Mac's ssh record reports nothing and counts as taken; a repeat there is unreachable, since a skipped build never
  // comes back as `ahead`.
  if (who && recorded?.changed !== false) {
    try {
      noteRefused(who.lock, { delivery: who.delivery, installed: result.was, installedBy: who.holders, since: who.since, from: who.from }, { env: ctx.env });
    } catch { /* the Event Log is never fatal (AD-9) */ }
  }
  return result.kind !== 'failure';
}

// ---------------------------------------------------------------------------------------------------- reading

// The "nothing pending" summary never reads as a healthy empty pass while a manifest went unreadable: those apps are
// unseen this pass (their own HUB_CATCHUP_ERROR lines say why), so the idle line names them instead of "no apps".
function idleSummary(quiet, unreadable) {
  const parts = quiet.length > 0 ? [quiet.join(', ')] : [];
  if (unreadable.length > 0) parts.push(`${unreadable.join(', ')} unreadable this pass`);
  return parts.join('; ') || 'no apps';
}

// `skip(app, block)` (a dedicated QA phone's pass) names why a build needs nothing from this device, or returns null when it does;
// without it a build is work when its one device (the S26, the iPad) is pending.
async function readApps(ctx, platform, { skip = null } = {}) {
  const work = [];
  const quiet = [];
  const resend = [];
  const settled = [];
  const unreadable = [];
  let errors = 0;
  for (const app of ctx.settings.apps) {
    // MOBI-17: the Mac's pass is the iPad's; an Android-only app has nothing for it, and is big-chungus's to read.
    if (platform === 'ios' && !app.lanes.includes('ios')) { quiet.push(`${app.slug} no ios build`); continue; }
    let latest;
    try {
      latest = await ctx.store.latest(app.slug);
    } catch (error) {
      errors += 1;
      unreadable.push(app.slug);
      ctx.log(`HUB_CATCHUP_ERROR ${app.slug}: cannot read latest.json (${oneLine(error)})`);
      continue;
    }
    if (!latest) { quiet.push(`${app.slug} unpublished`); continue; }
    const problems = latestProblems(latest, app.slug, ctx.settings.publicRoot, app);
    if (problems.length > 0) {
      errors += 1;
      unreadable.push(app.slug);
      ctx.log(`HUB_CATCHUP_ERROR ${app.slug}: latest.json refused (${problems.join('; ')})`);
      continue;
    }
    for (const each of platforms) if (latest[each]?.device?.event_pending) resend.push({ app, platform: each });
    const block = latest[platform];
    if (!app.lanes.includes(platform) || !block) { quiet.push(`${app.slug} no ${platform} build`); continue; }
    const settledAs = skip ? skip(app, block) : (block.device.status !== 'pending' ? block.device.status : null);
    if (settledAs !== null) {
      quiet.push(`${app.slug} ${describe(block.version, buildOf(block, platform))} ${settledAs}`);
      // The iPad pass still looks at an installed (or skipped) build once: something else may have replaced it. A
      // failed one gave up on purpose and stays silent until `retry`.
      if (platform === 'ios' && ['installed', 'skipped'].includes(block.device.status)) settled.push({ app, latest, block, settled: true });
      continue;
    }
    work.push({ app, latest, block });
  }
  return { work, quiet, unreadable, errors, resend, settled };
}

// ---------------------------------------------------------------------------------------------------- the S26 pass

async function androidApp(ctx, item, id) {
  const { block } = item;
  const pkg = block.package;
  let installed;
  try {
    installed = ctx.adb.installed(id, pkg);
  } catch (error) {
    return outcome(item, 'android', 'idle', { message: `the S26 did not answer (${oneLine(error)})` });
  }
  const plan = androidPlan(installed, block);
  try {
    if (plan.action === 'ahead') return outcome(item, 'android', 'ahead', { marker: 'HUB_CATCHUP_AHEAD', was: plan.was, reason: `the S26 runs ${plan.was}, ahead of this build`, message: `the S26 runs ${plan.was}; not touched` });
    if (plan.action === 'conflict') throw stageError('install', `the S26 has versionCode ${block.code} as ${installed.versionName}, not ${block.version}; something else installed that code`);
    let reinstall = false;
    if (plan.action === 'compare-bytes') {
      const onDevice = ctx.adb.sha256(id, ctx.adb.baseApk(id, pkg));
      if (onDevice === block.sha256) {
        const mine = ctx.journal.mine(item.app.slug, 'android', block);
        return outcome(item, 'android', mine ? 'installed' : 'confirmed', { message: `the S26 already runs ${plan.was}, base.apk sha256 matches${mine ? ' (installed by an earlier catch-up pass)' : ' (installed from the link or Quickdrop)'}` });
      }
      reinstall = true;
    }
    const over = reinstall ? `${plan.was} (other bytes of the same code, replaced in place)` : plan.was;
    // adb install -r closes a running app: a kid playing (the app on top, the screen on) waits for the next pass.
    let playing = false;
    try { playing = typeof ctx.adb.inUse === 'function' && ctx.adb.inUse(id, pkg) === true; } catch { playing = false; }
    if (playing) return outcome(item, 'android', 'idle', { message: `${pkg} is on screen on the S26; the install waits for a pass when it is not in use` });
    if (ctx.mode !== 'live') return outcome(item, 'android', 'would-install', { message: `${describe(block.version, block.code)} over ${over} from ${ctx.store.url(block.key)} (${block.bytes} bytes), after sha256 and signer checks` });
    const apk = await ctx.fetchApk(item.app.slug, block);
    ctx.checkApk(apk, block, item.app);
    try { ctx.adb.install(id, apk); } catch (error) { throw stageError('install', error.message); }
    const after = ctx.adb.installed(id, pkg);
    if (!after || after.versionCode !== block.code || after.versionName !== block.version) throw stageError('verify', `readback: the S26 reports ${after ? describe(after.versionName, after.versionCode) : 'no package'}, expected ${describe(block.version, block.code)}`);
    const onDevice = ctx.adb.sha256(id, ctx.adb.baseApk(id, pkg));
    if (onDevice !== block.sha256) throw stageError('verify', `readback: base.apk on the S26 has sha256 ${String(onDevice).slice(0, 12)}, the build has ${block.sha256.slice(0, 12)}`);
    ctx.journal.put(item.app.slug, 'android', block);
    return outcome(item, 'android', 'installed', { message: `installed over ${over}; readback ${describe(block.version, block.code)}, base.apk sha256 matches` });
  } catch (error) {
    return failure(item, 'android', error);
  }
}

// A deploy between its plan and its deliver owns the app's device on the platforms it builds: every pending build at or
// below its version waits (an older build is never installed minutes before the deploy installs the newer one). An
// inflight file left by a deploy that died more than six hours ago no longer holds the device back.
export function inflightHolds(inflight, block, now, platform) {
  if (!inflight || !semver.test(inflight.version ?? '')) return false;
  if (Array.isArray(inflight.platforms) && platform && !inflight.platforms.includes(platform)) return false;
  let atOrBelow = false;
  try { atOrBelow = compareSemver(block.version, inflight.version) <= 0; } catch { return false; }
  if (!atOrBelow) return false;
  const since = Date.parse(inflight.started_at ?? inflight.lastModified ?? '');
  return !Number.isFinite(since) || now.getTime() - since < inflightStaleMs;
}

// How long, and for which delivery, a pass waits in the Queue (FR-30, AD-15). A contention-pending build (Story 3.2: `S26 busy`)
// stays in line for its turn, up to the policy's pending wait and never past the pass limit less its reserve. Anything else gets
// the short attempt. The ticket names one delivery: the contention-pending build, else the first build that is not settled.
export function catchupWait(work, { settings, elapsedMs = 0, attemptMs = settings.attemptMs } = {}) {
  const pending = work.find(item => isBusyPending(item.block?.device)) ?? null;
  const named = pending ?? work.find(item => !item.settled) ?? null;
  let delivery = null;
  if (named) {
    try { delivery = checkDelivery({ repo: named.app.repo, run: String(named.block.run.id), version: named.block.version }); } catch { delivery = null; }
  }
  const ms = pending ? Math.max(attemptMs, Math.min(settings.pendingWaitMs, passLimitMs - passReserveMs - elapsedMs)) : attemptMs;
  return { ms, pending, delivery };
}

const waitText = ms => (ms >= 60_000 ? `${Math.round(ms / 60_000)} min` : `${Math.round(ms / 1000)} s`);

// The lock options a pass waits with, and the line that says a contention-pending build is staying in line.
function queueWait(ctx, work, { platform, lock }) {
  const wait = catchupWait(work, { settings: ctx.settings, elapsedMs: ctx.now().getTime() - ctx.startedAt, attemptMs: ctx.lockWaitMs ?? ctx.settings.attemptMs });
  if (wait.pending) ctx.log(`HUB_CATCHUP_WAIT ${platform} ${wait.pending.app.slug} ${wait.pending.block.version}: contention-pending; waiting up to ${waitText(wait.ms)} for its turn on ${lock}`);
  return { wait, options: { timeoutMs: wait.ms, pollMs: 100, delivery: wait.delivery, timeoutReason: 'catchup-idle' } };
}

// A wait that ended without the lock is not an error: the pass is idle and the next one tries again (AD-5: by code, never text).
// Anything else is rethrown. The timeout's event is already written, and the ticket already gone, by the lock.
function idleOnQueue(ctx, error, { platform, lock, items, waitedMs }) {
  if (error?.code === 'HUB_LOCK_TIMEOUT') {
    const holder = error.holds?.[0];
    const who = holder ? `${holder.kind}${holder.holder ? ` ${holder.holder}` : ''}` : 'another holder';
    ctx.log(`HUB_CATCHUP_IDLE ${platform} ${ctx.mode}: ${items} pending; ${lock} stayed held for ${waitText(waitedMs)} (${who}); next pass`);
    return true;
  }
  if (error?.code === 'HUB_LEASE_CANCELLED') {
    ctx.log(`HUB_CATCHUP_IDLE ${platform} ${ctx.mode}: ${items} pending; its place in the ${lock} queue was released; next pass`);
    return true;
  }
  return false;
}

// The pending builds no deploy is publishing right now; the others are logged and left for a later pass.
async function notInFlight(ctx, listed, platform) {
  const work = [];
  let errors = 0;
  for (const item of listed) {
    let inflight;
    try {
      inflight = await ctx.store.inflight(item.app.slug);
    } catch (error) {
      errors += 1;
      ctx.log(`HUB_CATCHUP_ERROR ${item.app.slug}: cannot read inflight.json (${oneLine(error)}); not touching it this pass`);
      continue;
    }
    if (inflightHolds(inflight, item.block, ctx.now(), platform)) {
      ctx.log(`HUB_CATCHUP_IDLE ${item.app.slug} ${platform} ${describe(item.block.version, buildOf(item.block, platform))}: deploy run ${inflight.run?.id ?? inflight.run ?? '?'} is publishing ${inflight.version}`);
      continue;
    }
    work.push(item);
  }
  return { work, errors };
}

export async function androidPass(ctx) {
  const { work: listed, quiet, errors: readErrors, resend, unreadable } = await readApps(ctx, 'android');
  let errors = readErrors;
  for (const { app, platform } of resend) if (!await resendEvent(ctx, app, platform)) errors += 1;
  const held = await notInFlight(ctx, listed, 'android');
  const { work } = held;
  errors += held.errors;
  if (work.length === 0) {
    if (listed.length === 0) ctx.log(`HUB_CATCHUP_IDLE android ${ctx.mode}: nothing pending (${idleSummary(quiet, unreadable)})`);
    return { errors, results: [] };
  }
  let results = null;
  const { wait, options } = queueWait(ctx, work, { platform: 'android', lock: 'adb' });
  try {
    results = await ctx.lock('adb', async () => {
      let id;
      try {
        id = await ctx.findPhone();
      } catch (error) {
        ctx.log(`HUB_CATCHUP_IDLE android ${ctx.mode}: ${work.map(item => `${item.app.slug} ${describe(item.block.version, item.block.code)}`).join(', ')} pending; the S26 is away (${oneLine(error).slice(0, 120)})`);
        return null;
      }
      // A long wait can outlast a deploy that started meanwhile: read inflight.json again before installing an older build.
      let todo = work;
      if (wait.ms > (ctx.lockWaitMs ?? ctx.settings.attemptMs)) {
        const again = await notInFlight(ctx, work, 'android');
        errors += again.errors;
        todo = again.work;
        if (todo.length === 0) return [];
      }
      const found = [];
      for (const item of todo) found.push(await androidApp(ctx, item, id));
      return found;
    }, options);
  } catch (error) {
    const items = work.map(item => `${item.app.slug} ${describe(item.block.version, item.block.code)}`).join(', ');
    if (!idleOnQueue(ctx, error, { platform: 'android', lock: 'adb', items, waitedMs: wait.ms })) throw error;
    return { errors, results: [] };
  }
  if (!results) return { errors, results: [] };
  for (const result of results) if (!await settle(ctx, result)) errors += 1;
  return { errors, results };
}

// ---------------------------------------------------------------------------------------------------- dedicated QA phones (MOBI-48)

// A dedicated QA phone (lib/qa-phones.mjs: declared in the owner's private QA file, an extra phone of devices.json) is a catch-up target of its
// own. The deploy knows nothing of it: its latest.json device block is the S26's, and a block an older hub validates cannot carry
// another device. This host remembers what each QA phone was brought to (`qa-delivery.json`, beside the journal), so the pass finds
// what is behind by comparing that record with latest.json's android block, and every status change sends one event.
//
// The pass takes the phone's own lock (`s24`) with a short attempt like the S26's: a phone someone leases, or away, is just idle (the
// build is still pending for it, the run is never failed), and the next pass converges it. The hold also owns the hub's adb server
// for that phone, which is started when the phone is looked for and stopped when the hold ends. Installs are `adb install -r --user N`
// for the phone's allowed Android users only, after the same sha256, signer and no-downgrade checks as the S26. It never uninstalls,
// clears data or touches another user.
export const qaStateFile = (env = process.env, home = homedir()) => join(env.XDG_STATE_HOME || join(home, '.local/state'), 'mobile-deploy-hub/qa-delivery.json');

export function createQaState({ env = process.env, home = homedir() } = {}) {
  const path = qaStateFile(env, home);
  const read = () => { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return {}; } };
  const keyOf = (phone, slug) => `${phone.lock}/${slug}`;
  const write = deliveries => writeAtomic(path, `${JSON.stringify({ deliveries }, null, 2)}\n`);
  return {
    get: (phone, slug) => read().deliveries?.[keyOf(phone, slug)] ?? null,
    put(phone, slug, entry) { write({ ...read().deliveries, [keyOf(phone, slug)]: entry }); },
    drop(phone, slug) { const { [keyOf(phone, slug)]: _gone, ...rest } = read().deliveries ?? {}; write(rest); },
  };
}

const qaSame = (entry, block) => Boolean(entry) && entry.version === block.version && entry.build === String(block.code) && entry.sha256 === block.sha256;

// Why a build needs nothing from the phone, or null when it does.
const qaSkip = (ctx, phone) => (app, block) => {
  const entry = ctx.qaState.get(phone, app.slug);
  if (!qaSame(entry, block)) return null;
  if (entry.status === 'installed') return `on the ${phone.name}`;
  if (entry.status === 'skipped') return `skipped on the ${phone.name} (it runs a newer build)`;
  if (entry.status === 'failed') return `failed on the ${phone.name} (gave up; catchup.mjs qa-retry ${phone.lock} ${app.slug})`;
  return null;
};

// The device a QA phone's event names, in the shape the S26's `devices.android` has.
const qaKnown = phone => ({ name: phone.name, model: phone.model, serial: phone.serial });

async function qaApp(ctx, phone, adb, item, id) {
  const { block } = item;
  const pkg = block.package;
  const name = phone.name;
  const asked = `${name} (users ${phone.users.join(', ')})`;
  let installed;
  let missing;
  try {
    installed = adb.installed(id, pkg);
    missing = phone.users.filter(user => !adb.baseApk(id, pkg, user));
  } catch (error) {
    return outcome(item, 'android', 'idle', { message: `the ${name} did not answer (${oneLine(error)})` });
  }
  const plan = androidPlan(installed, block);
  try {
    if (plan.action === 'ahead') return outcome(item, 'android', 'ahead', { marker: 'HUB_CATCHUP_AHEAD', was: plan.was, reason: `the ${name} runs ${plan.was}, ahead of this build`, message: `the ${name} runs ${plan.was}; not touched` });
    if (plan.action === 'conflict') throw stageError('install', `the ${name} has versionCode ${block.code} as ${installed.versionName}, not ${block.version}; something else installed that code`);
    let reinstall = false;
    if (plan.action === 'compare-bytes' && missing.length === 0) {
      const onDevice = adb.sha256(id, adb.baseApk(id, pkg, phone.users[0]));
      if (onDevice === block.sha256) {
        const mine = qaSame(ctx.qaState.get(phone, item.app.slug), block);
        return outcome(item, 'android', mine ? 'installed' : 'confirmed', { message: `the ${name} already runs ${plan.was}, base.apk sha256 matches${mine ? ' (installed by an earlier catch-up pass)' : ' (installed from the link or by hand)'}` });
      }
      reinstall = true;
    }
    const over = reinstall ? `${plan.was} (other bytes of the same code, replaced in place)` : plan.was;
    let playing = false;
    try { playing = typeof adb.inUse === 'function' && adb.inUse(id, pkg) === true; } catch { playing = false; }
    if (playing) return outcome(item, 'android', 'idle', { message: `${pkg} is on screen on the ${name}; the install waits for a pass when it is not in use` });
    if (ctx.mode !== 'live') return outcome(item, 'android', 'would-install', { message: `${describe(block.version, block.code)} over ${over} on ${asked} from ${ctx.store.url(block.key)} (${block.bytes} bytes), after sha256 and signer checks` });
    const apk = await ctx.fetchApk(item.app.slug, block);
    ctx.checkApk(apk, block, item.app);
    for (const user of phone.users) {
      try { adb.install(id, apk, user); } catch (error) { throw stageError('install', error.message); }
    }
    const after = adb.installed(id, pkg);
    if (!after || after.versionCode !== block.code || after.versionName !== block.version) throw stageError('verify', `readback: the ${name} reports ${after ? describe(after.versionName, after.versionCode) : 'no package'}, expected ${describe(block.version, block.code)}`);
    for (const user of phone.users) {
      const onDevice = adb.sha256(id, adb.baseApk(id, pkg, user));
      if (onDevice !== block.sha256) throw stageError('verify', `readback: base.apk on the ${name} (user ${user}) has sha256 ${String(onDevice).slice(0, 12)}, the build has ${block.sha256.slice(0, 12)}`);
    }
    return outcome(item, 'android', 'installed', { message: `installed over ${over} on ${asked}; readback ${describe(block.version, block.code)}, base.apk sha256 matches` });
  } catch (error) {
    return failure(item, 'android', error);
  }
}

// One event for a QA phone's status change, then the mark is cleared. A refused event stays marked: the next pass sends it.
async function qaSend(ctx, phone, slug, block, entry, { name, hubRef }) {
  if (!ctx.settings.events || !entry.event) {
    if (entry.event) ctx.qaState.put(phone, slug, { ...entry, event: null });
    return true;
  }
  const failed = entry.event.status === 'failed';
  const device = failed ? { status: 'failed', reason: entry.reason } : { status: 'installed', by: entry.event.by };
  const event = await eventFor({ ...ctx, devices: { ...ctx.devices, android: qaKnown(phone) } }, { name, slug, platform: 'android', block, device, hubRef });
  try {
    ctx.emit(event);
  } catch (error) {
    ctx.log(`HUB_CATCHUP_REPORTED ${slug} android on the ${phone.name}: ${event.type} not sent (${oneLine(error).slice(0, 160)}); the next pass sends it`);
    return false;
  }
  ctx.qaState.put(phone, slug, { ...entry, event: null });
  ctx.log(`HUB_CATCHUP_REPORTED ${slug} android on the ${phone.name}: ${event.type} sent: ${event.data.summary}`);
  return true;
}

// Records one result for a QA phone and sends its event. Returns false when something went wrong that the logs must show.
async function qaSettle(ctx, phone, result) {
  const where = `${result.slug} android ${describe(result.version, result.build)} on the ${phone.name}`;
  if (result.kind === 'idle') { ctx.log(`HUB_CATCHUP_IDLE ${where}: ${result.message}`); return true; }
  if (ctx.mode !== 'live') {
    const would = { installed: 'record installed (HUB_CATCHUP_INSTALLED)', confirmed: 'record installed by a person (HUB_CATCHUP_CONFIRMED)', ahead: `record skipped (${result.marker})`, failure: 'count a failed attempt', 'would-install': 'install' }[result.kind];
    ctx.log(`HUB_CATCHUP_WATCH ${where}: would ${would}: ${result.message ?? result.reason}`);
    return true;
  }
  if (result.kind === 'failure') ctx.log(`HUB_CATCHUP_PENDING ${where}: attempt failed at ${result.stage}: ${result.reason}`);
  else ctx.log(`${result.marker ?? markerOf[result.kind]} ${where}: ${result.message}`);
  const facts = factsOf(result);
  const prior = ctx.qaState.get(phone, result.slug);
  const since = stamp(ctx.now());
  const same = qaSame(prior, result.block);
  const base = { version: result.version, build: result.build, sha256: result.block.sha256 };
  let entry;
  if (facts.status === 'installed') {
    entry = { ...base, status: 'installed', failures: 0, since, by: facts.by, reason: null, event: { status: 'installed', by: facts.by } };
  } else if (facts.status === 'skipped') {
    entry = { ...base, status: 'skipped', failures: 0, since, by: null, reason: String(result.reason ?? 'skipped').slice(0, 300), event: null };
  } else {
    const failures = (same && Number.isSafeInteger(prior.failures) ? prior.failures : 0) + 1;
    const stage = facts.stage === 'verify' ? 'verify' : 'install';
    if (failures >= ctx.settings.maxFailures) {
      const reason = `catch-up failed ${failures} times at ${stage}: ${facts.reason ?? 'no reason given'}`.slice(0, 300);
      ctx.log(`HUB_CATCHUP_FAILED ${where}: ${reason}; no more attempts on this build (catchup.mjs qa-retry ${phone.lock} ${result.slug} starts over)`);
      entry = { ...base, status: 'failed', failures, since, by: null, reason, event: { status: 'failed' } };
    } else {
      entry = { ...base, status: 'pending', failures, since: same ? prior.since : since, by: null, reason: `catch-up attempt ${failures} of ${ctx.settings.maxFailures} failed at ${stage}: ${facts.reason ?? 'no reason given'}`.slice(0, 300), event: null };
    }
  }
  ctx.qaState.put(phone, result.slug, entry);
  const sent = await qaSend(ctx, phone, result.slug, result.block, entry, { name: facts.name, hubRef: facts.hub_ref });
  return result.kind !== 'failure' && sent;
}

// An event the bus refused is sent by the next pass, exactly once, while latest.json still names that release.
async function qaResend(ctx, phone) {
  let errors = 0;
  for (const app of ctx.settings.apps) {
    const entry = ctx.qaState.get(phone, app.slug);
    if (!entry?.event) continue;
    try {
      const latest = await ctx.store.latest(app.slug);
      const block = latest?.android;
      if (!block || !qaSame(entry, block) || latestProblems(latest, app.slug, ctx.settings.publicRoot, app).length > 0) {
        ctx.qaState.put(phone, app.slug, { ...entry, event: null });
        ctx.log(`HUB_CATCHUP_REPORTED ${app.slug} android on the ${phone.name}: the unsent ${entry.event.status} event is dropped (latest.json names another build now)`);
        continue;
      }
      if (ctx.mode !== 'live') { ctx.log(`HUB_CATCHUP_WATCH ${app.slug} android on the ${phone.name}: would send the unsent catch-up event`); continue; }
      if (!await qaSend(ctx, phone, app.slug, block, entry, { name: latest.name, hubRef: hubRefOf(latest, block) })) errors += 1;
    } catch (error) {
      errors += 1;
      ctx.log(`HUB_CATCHUP_ERROR ${app.slug} android on the ${phone.name}: could not resend the event (${oneLine(error)})`);
    }
  }
  return errors;
}

// One dedicated phone's pass. Never throws for a phone that is away or busy.
async function qaPhonePass(ctx, phone) {
  // Nobody holds the phone's lock: whatever hub QA server is still up is a leftover (a lease that expired, a pass that was killed).
  ctx.qaReapIfFree(phone);
  let errors = await qaResend(ctx, phone);
  const { work: listed, quiet, errors: readErrors, unreadable } = await readApps(ctx, 'android', { skip: qaSkip(ctx, phone) });
  errors += readErrors;
  const held = await notInFlight(ctx, listed, 'android');
  errors += held.errors;
  const work = held.work;
  if (work.length === 0) {
    if (listed.length === 0) ctx.log(`HUB_CATCHUP_IDLE qa ${phone.name} ${ctx.mode}: nothing pending (${idleSummary(quiet, unreadable)})`);
    return { errors, results: [] };
  }
  const items = work.map(item => `${item.app.slug} ${describe(item.block.version, item.block.code)}`).join(', ');
  const waitMs = ctx.lockWaitMs ?? ctx.settings.attemptMs;
  let results;
  try {
    results = await ctx.lock(phone.lock, async () => {
      const adb = ctx.qaAdb(phone);
      try {
        let id;
        try {
          id = await ctx.qaFindPhone(phone, adb);
        } catch (error) {
          const hint = awayHint(phone, ctx.qaForeignHolders(phone));
          ctx.log(`HUB_CATCHUP_IDLE qa ${phone.name} ${ctx.mode}: ${items} pending; the ${phone.name} is away (${oneLine(error).slice(0, 120)})${hint}`.slice(0, 700));
          return null;
        }
        const found = [];
        for (const item of work) found.push(await qaApp(ctx, phone, adb, item, id));
        return found;
      } finally {
        ctx.qaReap(phone);
      }
    }, { timeoutMs: waitMs, pollMs: 100, timeoutReason: 'catchup-idle' });
  } catch (error) {
    if (!idleOnQueue(ctx, error, { platform: `qa ${phone.name}`, lock: phone.lock, items, waitedMs: waitMs })) throw error;
    return { errors, results: [] };
  }
  if (!results) return { errors, results: [] };
  for (const result of results) if (!await qaSettle(ctx, phone, result)) errors += 1;
  return { errors, results };
}

// Every dedicated QA phone, one after the other, each under its own lock. A phone that cannot be served by its declaration is an error
// line (and a non-zero pass), never silence.
export async function qaPass(ctx) {
  let errors = 0;
  const results = [];
  let declared;
  try {
    declared = ctx.qaPhones();
  } catch (error) {
    ctx.log(`HUB_CATCHUP_ERROR dedicated QA phones: ${oneLine(error)}`);
    return { errors: 1, results };
  }
  for (const problem of declared.problems) { errors += 1; ctx.log(`HUB_CATCHUP_ERROR dedicated QA phones: ${problem}`); }
  for (const phone of declared.phones) {
    try {
      const done = await qaPhonePass(ctx, phone);
      errors += done.errors;
      results.push(...done.results);
    } catch (error) {
      errors += 1;
      ctx.log(`HUB_CATCHUP_ERROR qa ${phone.name}: ${oneLine(error)}`);
    }
  }
  return { errors, results };
}

// A QA phone that gave up goes back to pending: the next pass tries that build again.
export function qaRetry(ctx, lock, slug) {
  const phone = ctx.qaPhones().phones.find(entry => entry.lock === lock);
  if (!phone) throw new Error(`${lock} is not a dedicated QA phone here`);
  if (!ctx.settings.apps.some(app => app.slug === slug)) throw new Error(`${slug} is not an app in the policy`);
  const entry = ctx.qaState.get(phone, slug);
  if (!entry || !['failed', 'pending'].includes(entry.status)) throw new Error(`${slug} on the ${phone.name} is ${entry?.status ?? 'not recorded'}; qa-retry starts over a failed or pending build only`);
  ctx.qaState.drop(phone, slug);
  ctx.log(`HUB_CATCHUP_REPORTED ${slug} android on the ${phone.name}: back to pending; the next pass tries again`);
  return true;
}

// ---------------------------------------------------------------------------------------------------- the iPad pass

// `item.settled` marks a build latest.json already calls installed (or skipped): the pass only checks that the iPad still
// holds it, and repairs it in place when another channel replaced it with an older build (TOLT-152).
async function iosApp(ctx, item) {
  const { block, app } = item;
  const repair = item.settled === true;
  let installed;
  try {
    installed = ctx.ipad.installed(block.bundle);
  } catch (error) {
    return outcome(item, 'ios', 'idle', { message: `the iPad did not answer (${oneLine(error)})` });
  }
  const plan = iosPlan(installed, block);
  const wouldKind = repair ? 'would-repair' : 'would-install';
  try {
    if (repair) {
      // Only an OLDER build on the iPad is displaced. A newer one is a person's choice, a missing app a person's
      // deletion, an equal one is the healthy case; none of them is touched.
      if (!installed) return outcome(item, 'ios', 'idle', { message: `${block.bundle} is not on the iPad (removed on purpose?); not reinstalled` });
      if (plan.action === 'ahead') return outcome(item, 'ios', 'idle', { message: `the iPad runs ${plan.was}, newer than latest.json; not touched` });
      if (plan.action === 'conflict') return outcome(item, 'ios', 'idle', { message: `the iPad runs ${plan.was}, which cannot be compared with ${describe(block.version, block.build)}; not touched` });
      if (plan.action === 'confirm') return outcome(item, 'ios', 'quiet', { message: `the iPad runs ${plan.was}` });
      const repairs = ctx.journal.repairsToday(app.slug, 'ios');
      if (repairs >= iosRepairsPerDay) return outcome(item, 'ios', 'idle', { message: `the iPad was displaced by ${plan.was} again; already repaired ${repairs} times today (the limit), only logging` });
    }
    if (plan.action === 'ahead') return outcome(item, 'ios', 'ahead', { marker: 'HUB_IPAD_NEWER', was: plan.was, reason: `the iPad runs ${plan.was}, newer than this build`, message: `the iPad runs ${plan.was}; not touched` });
    if (plan.action === 'conflict') throw stageError('install', `the iPad runs ${plan.was}, which cannot be compared with ${describe(block.version, block.build)}`);
    if (plan.action === 'confirm') {
      const mine = ctx.journal.mine(app.slug, 'ios', block);
      return outcome(item, 'ios', mine ? 'installed' : 'confirmed', { message: `the iPad already runs ${plan.was}${mine ? ' (installed by an earlier catch-up pass)' : ' (installed over the air)'}` });
    }
    // The Mac's outbox first: the deploy's ios job left the IPA there, so this costs no network bytes.
    let ipa = ctx.outboxIpa(app.slug, block);
    let from = 'the outbox';
    if (ipa && await ctx.sha256(ipa) !== block.sha256) {
      ctx.log(`HUB_CATCHUP_IDLE ${app.slug} ios: the outbox IPA ${basename(ipa)} is other bytes than latest.json names; not using it`);
      ipa = null;
    }
    if (!ipa) {
      if (!block.key) return outcome(item, 'ios', 'idle', { message: 'no IPA in the outbox and none published; waiting for the next deploy' });
      if (ctx.metered()) return outcome(item, 'ios', 'idle', { message: `the IPA is not in the outbox and the link is metered; it downloads on a home network (${block.bytes ?? '?'} bytes)` });
      from = ctx.store.url(block.key);
      if (ctx.mode !== 'live') return outcome(item, 'ios', wouldKind, { message: `${describe(block.version, block.build)} over ${plan.was}, after downloading ${from} (${block.bytes ?? '?'} bytes)` });
      ipa = await ctx.fetchIpa(app.slug, block);
    }
    // devicectl install closes a running app, and devicectl cannot tell a game on screen from a suspended one: while the
    // app runs, wait (up to iosBusyCapMs from the first sighting, so a suspended app cannot hold the iPad forever).
    let running = false;
    try { running = typeof ctx.ipad.running === 'function' && ctx.ipad.running(block.bundle) === true; } catch { running = false; }
    if (running && ctx.mode === 'live') {
      const waited = ctx.now().getTime() - ctx.journal.busySince(app.slug, 'ios', block);
      if (waited < iosBusyCapMs) return outcome(item, 'ios', 'idle', { message: `${block.bundle} is running on the iPad; the install waits for a pass when it is closed (${Math.floor(waited / 60_000)} of ${iosBusyCapMs / 60_000} minutes)` });
      ctx.log(`HUB_CATCHUP_BUSY ${app.slug} ios: ${block.bundle} has been running for ${Math.floor(waited / 60_000)} minutes; installing now`);
    }
    if (ctx.mode !== 'live') return outcome(item, 'ios', wouldKind, { message: `${describe(block.version, block.build)} over ${plan.was} from ${from} (sha256 matches)${running ? '; it would wait while the app runs' : ''}` });
    // The flap guard counts the attempt, whether or not the install then works.
    if (repair) ctx.journal.repairAttempt(app.slug, 'ios');
    const unpacked = ctx.unpackIpa(ipa);
    try {
      if (unpacked.bundle !== block.bundle || unpacked.version !== block.version || unpacked.build !== block.build) throw stageError('install', `the IPA is ${unpacked.bundle} ${describe(unpacked.version, unpacked.build)}, latest.json names ${block.bundle} ${describe(block.version, block.build)}`);
      // Read again right before the install: never over a newer build.
      const now = iosPlan(ctx.ipad.installed(block.bundle), block);
      if (now.action !== 'install') throw stageError('install', `the iPad changed to ${now.was} during the pass`);
      try { ctx.ipad.install(unpacked.app); } catch (error) { throw stageError('install', error.message); }
    } finally {
      unpacked.cleanup();
    }
    const after = ctx.ipad.installed(block.bundle);
    if (!after || after.version !== block.version || after.build !== block.build) throw stageError('verify', `readback: the iPad reports ${after ? describe(after.version, after.build) : 'no app'}, expected ${describe(block.version, block.build)}`);
    ctx.journal.put(app.slug, 'ios', block);
    if (repair) return outcome(item, 'ios', 'repaired', { reason: `repaired: displaced by ${plan.was}`, message: `displaced by ${plan.was}; reinstalled in place from ${from}; readback ${describe(after.version, after.build)}` });
    return outcome(item, 'ios', 'installed', { message: `installed over ${plan.was} from ${from}; readback ${describe(after.version, after.build)}` });
  } catch (error) {
    const failed = failure(item, 'ios', error);
    return repair ? { ...failed, kind: 'repair-failed' } : failed;
  }
}

export async function iosPass(ctx) {
  const { work: pendingListed, settled, quiet, errors: readErrors, unreadable } = await readApps(ctx, 'ios');
  let errors = readErrors;
  if (pendingListed.length === 0 && settled.length === 0) {
    ctx.log(`HUB_CATCHUP_IDLE ios ${ctx.mode}: nothing pending (${idleSummary(quiet, unreadable)})`);
    return { errors, results: [] };
  }
  // Pending builds first; then the installed ones, which only get looked at on the iPad (the displaced-build repair).
  const listed = [...pendingListed, ...settled];
  const held = await notInFlight(ctx, listed, 'ios');
  const { work } = held;
  errors += held.errors;
  if (work.length === 0) return { errors, results: [] };
  const describeItems = items => items.map(item => `${item.app.slug} ${describe(item.block.version, item.block.build)}`).join(', ');
  const waiting = work.some(item => !item.settled) ? `${describeItems(work.filter(item => !item.settled))} pending` : `${describeItems(work)} to check`;
  let results = null;
  const { wait, options } = queueWait(ctx, work, { platform: 'ios', lock: 'mac-ios' });
  try {
    results = await ctx.lock('mac-ios', async () => {
      let found;
      try {
        found = ctx.ipad.find();
      } catch (error) {
        ctx.log(`HUB_CATCHUP_IDLE ios ${ctx.mode}: ${waiting}; the iPad is not listed (${oneLine(error).slice(0, 120)})`);
        return null;
      }
      if (found.tunnel === 'unavailable') {
        ctx.log(`HUB_CATCHUP_IDLE ios ${ctx.mode}: ${waiting}; the iPad is unavailable to devicectl (away or asleep)`);
        return null;
      }
      let todo = work;
      if (wait.ms > (ctx.lockWaitMs ?? ctx.settings.attemptMs)) {
        const again = await notInFlight(ctx, work, 'ios');
        errors += again.errors;
        todo = again.work;
        if (todo.length === 0) return [];
      }
      const done = [];
      for (const item of todo) done.push(await iosApp(ctx, item));
      return done;
    }, options);
  } catch (error) {
    if (!idleOnQueue(ctx, error, { platform: 'ios', lock: 'mac-ios', items: waiting.replace(/ (pending|to check)$/, ''), waitedMs: wait.ms })) throw error;
    return { errors, results: [] };
  }
  if (!results) return { errors, results: [] };
  for (const result of results) if (!await settle(ctx, result)) errors += 1;
  const fine = results.filter(result => result.kind === 'quiet');
  if (fine.length > 0 && fine.length === results.length) ctx.log(`HUB_CATCHUP_IDLE ios ${ctx.mode}: nothing pending (${fine.map(result => `${result.slug} ${describe(result.version, result.build)} on the iPad`).join(', ')})`);
  return { errors, results };
}

// ---------------------------------------------------------------------------------------------------- record (big-chungus)

// MOBI-17: the event's page link is the plain URL when anonymous readers can open that page, otherwise a presigned link
// (seven days, signed with the hub writer's keys, never stored), otherwise none.
async function pageLink(ctx, slug) {
  const app = ctx.settings.apps.find(entry => entry.slug === slug);
  const open = accessOf(app).pageOpen;
  if (open || typeof ctx.credentials !== 'function') return open ? null : false;
  try {
    return presign({ credentials: await ctx.credentials(), url: `${ctx.settings.publicRoot.replace(/\/$/, '')}/${slug}/index.html`, expiresS: linkLifetimeS, now: ctx.now(), responseCacheControl: linkCacheControl });
  } catch (error) {
    ctx.log(`::warning::HUB_CATCHUP_LINKS ${slug}: no presigned page link (${oneLine(error)})`);
    return false;
  }
}

async function eventFor(ctx, { name, slug, platform, block, device, hubRef }) {
  return catchupEvent({ name, slug, platform, block, device, run: block.run, commit: block.commit, hubRef, correlation: block.correlation, devices: ctx.devices, publicBase: ctx.settings.publicRoot, pageUrl: await pageLink(ctx, slug), now: ctx.now() });
}

const hubRefOf = (latest, block) => (block.run.id === latest.run.id ? latest.hub_ref : null);

// Sends the event a device block is marked for, then clears the mark. Called under the s3-<slug> lock.
async function flushEvent(ctx, slug, latest, platform) {
  const block = latest[platform];
  const event = await eventFor(ctx, { name: latest.name, slug, platform, block, device: block.device, hubRef: hubRefOf(latest, block) });
  try {
    ctx.emit(event);
  } catch (error) {
    ctx.log(`HUB_CATCHUP_REPORTED ${slug} ${platform}: ${event.type} not sent (${oneLine(error).slice(0, 160)}); the next S26 pass sends it`);
    return false;
  }
  const { event_pending: _sent, ...device } = block.device;
  const next = validateLatest({ ...latest, [platform]: { ...block, device } });
  await ctx.store.writeLatest(slug, next);
  Object.assign(latest, next);
  ctx.log(`HUB_CATCHUP_REPORTED ${slug} ${platform}: ${event.type} sent: ${event.data.summary}`);
  return true;
}

// The device change for a recorded result, or null when latest.json already says it (record is idempotent). Only
// device fields change, and the field set stays the contract's.
export function transition(device, facts, { maxFailures, now }) {
  const since = stamp(now);
  // A build latest.json calls installed (or skipped as newer) was found displaced by an older one and reinstalled.
  if (facts.status === 'repaired') {
    if (!['installed', 'skipped'].includes(device.status)) return null;
    return { change: { status: 'installed', since, by: 'catch-up', reason: String(facts.reason ?? 'repaired: displaced by an older build').slice(0, 300), event_pending: true }, event: true };
  }
  if (facts.status === 'installed') {
    if (device.status === 'installed') return null;
    return { change: { status: 'installed', since, by: facts.by, reason: null, event_pending: true }, event: true };
  }
  if (device.status !== 'pending') return null;
  if (facts.status === 'skipped') return { change: { status: 'skipped', since, by: null, reason: String(facts.reason ?? 'skipped').slice(0, 300) }, event: false };
  const failures = (Number.isSafeInteger(device.failures) ? device.failures : 0) + 1;
  const stage = facts.stage === 'verify' ? 'verify' : 'install';
  const why = facts.reason ?? 'no reason given';
  if (failures >= maxFailures) {
    return { change: { status: 'failed', since, by: null, failures, reason: `catch-up failed ${failures} times at ${stage}: ${why}`.slice(0, 300), event_pending: true }, event: true, gaveUp: true };
  }
  return { change: { failures, reason: `catch-up attempt ${failures} of ${maxFailures} failed at ${stage}: ${why}`.slice(0, 300) }, event: false };
}

export async function record(ctx, facts) {
  const app = ctx.settings.apps.find(entry => entry.slug === facts.slug);
  if (!app) throw new Error(`${facts.slug} is not an app in the policy`);
  return ctx.lock(`s3-${facts.slug}`, async () => {
    const where = `${facts.slug} ${facts.platform} ${describe(facts.version, facts.build)}`;
    const latest = await ctx.store.latest(facts.slug, { fresh: true });
    if (!latest) throw new Error(`builds/${latestKey(facts.slug)} is gone`);
    const problems = latestProblems(latest, facts.slug, ctx.settings.publicRoot, app);
    if (problems.length > 0) throw new Error(`builds/${latestKey(facts.slug)} refused (${problems.join('; ')})`);
    const block = latest[facts.platform];
    const sameRelease = Boolean(block) && block.version === facts.version && buildOf(block, facts.platform) === String(facts.build);
    if (!sameRelease || (facts.sha256 && block.sha256 !== facts.sha256)) {
      // A newer deploy moved the pointer (or a rerun replaced the bytes) while this pass worked. The install still
      // happened, so its event goes out (best effort: there is no block left to mark); the block is left alone.
      ctx.log(`HUB_CATCHUP_REPORTED ${where} ${facts.status}: latest.json now names ${block ? `${describe(block.version, buildOf(block, facts.platform))}${sameRelease ? ' with other bytes' : ''}` : 'no build'}; that block is left alone`);
      if (facts.status !== 'installed' || !ctx.settings.events) return { moved: true, sent: false };
      const run = facts.run ?? {};
      const repo = run.repo ?? app.repo;
      if (!/^\d{1,20}$/.test(String(run.id ?? '')) || !/^[0-9a-f]{7,40}$/.test(facts.commit ?? '') || !sha256Pattern.test(facts.sha256 ?? '')) {
        ctx.log(`HUB_CATCHUP_REPORTED ${where}: no event (the report did not name its run, commit and bytes)`);
        return { moved: true, sent: false };
      }
      const old = {
        ...releaseOf(facts.platform, facts.version, facts.build),
        sha256: facts.sha256,
        commit: facts.commit,
        run: { repo, id: String(run.id), attempt: Number(run.attempt ?? 1), url: run.url ?? `https://github.com/${repo}/actions/runs/${run.id}` },
        correlation: facts.correlation ?? null,
      };
      const event = await eventFor(ctx, { name: facts.name ?? latest.name, slug: facts.slug, platform: facts.platform, block: old, device: { status: 'installed', by: facts.by }, hubRef: facts.hub_ref ?? null });
      try {
        ctx.emit(event);
        ctx.log(`HUB_CATCHUP_REPORTED ${where}: ${event.type} sent: ${event.data.summary}`);
        return { moved: true, sent: true };
      } catch (error) {
        ctx.log(`HUB_CATCHUP_REPORTED ${where}: ${event.type} not sent (${oneLine(error).slice(0, 160)})`);
        return { moved: true, sent: false };
      }
    }
    const next = transition(block.device, facts, { maxFailures: ctx.settings.maxFailures, now: ctx.now() });
    if (next && !ctx.settings.events) {
      delete next.change.event_pending;
      next.event = false;
    }
    if (!next) {
      ctx.log(`HUB_CATCHUP_REPORTED ${where}: latest.json already says ${block.device.status}${block.device.by ? ` by ${block.device.by}` : ''}; nothing to change`);
      return { moved: false, changed: false };
    }
    const { doc, updated } = updateDevice(latest, facts.platform, releaseOf(facts.platform, facts.version, facts.build), next.change);
    if (!updated) throw new Error(`latest.json did not take the ${facts.platform} device change`);
    await ctx.store.writeLatest(facts.slug, doc);
    const device = doc[facts.platform].device;
    if (next.gaveUp) ctx.log(`HUB_CATCHUP_FAILED ${where}: ${device.reason}; no more attempts on this build (catchup.mjs retry ${facts.slug} ${facts.platform} starts over)`);
    ctx.log(`HUB_CATCHUP_REPORTED ${where}: device ${device.status}${device.by ? ` by ${device.by}` : ''}${device.status === 'pending' ? ` (${device.failures} failed)` : ''}`);
    try { await ctx.pages(facts.slug, doc); } catch (error) { ctx.log(`HUB_CATCHUP_PAGES ${facts.slug}: not re-rendered (${oneLine(error).slice(0, 160)})`); }
    const sent = next.event ? await flushEvent(ctx, facts.slug, doc, facts.platform) : false;
    return { moved: false, changed: true, device: doc[facts.platform].device, sent };
  }, { timeoutMs: 120_000, pollMs: 250 });
}

// E4.5: an event the bus refused is sent by the next S26 pass, exactly once (the mark is cleared after the send).
async function resendEvent(ctx, app, platform) {
  if (ctx.mode !== 'live') {
    ctx.log(`HUB_CATCHUP_WATCH ${app.slug} ${platform}: would send the unsent catch-up event`);
    return true;
  }
  try {
    return await ctx.lock(`s3-${app.slug}`, async () => {
      const latest = await ctx.store.latest(app.slug, { fresh: true });
      if (!latest?.[platform]?.device?.event_pending || latestProblems(latest, app.slug, ctx.settings.publicRoot, app).length > 0) return true;
      return flushEvent(ctx, app.slug, latest, platform);
    }, { timeoutMs: 60_000, pollMs: 250 });
  } catch (error) {
    ctx.log(`HUB_CATCHUP_ERROR ${app.slug} ${platform}: could not resend the event (${oneLine(error)})`);
    return false;
  }
}

export async function retry(ctx, slug, platform) {
  if (!ctx.settings.apps.some(app => app.slug === slug)) throw new Error(`${slug} is not an app in the policy`);
  if (!platforms.includes(platform)) throw new Error('retry <slug> <android|ios>');
  return ctx.lock(`s3-${slug}`, async () => {
    const latest = await ctx.store.latest(slug, { fresh: true });
    const block = latest?.[platform];
    if (!block) throw new Error(`builds/${latestKey(slug)} has no ${platform} build`);
    if (!['failed', 'pending'].includes(block.device.status)) throw new Error(`${slug} ${platform} is ${block.device.status}; retry starts over a failed or pending device only`);
    const { event_pending: unsent, ...device } = block.device;
    if (unsent) ctx.log(`HUB_CATCHUP_REPORTED ${slug} ${platform}: the unsent ${device.status} event is dropped by the retry`);
    const next = validateLatest({ ...latest, [platform]: { ...block, device: { ...device, status: 'pending', since: stamp(ctx.now()), by: null, reason: 'catch-up retry requested', failures: 0 } } });
    await ctx.store.writeLatest(slug, next);
    ctx.log(`HUB_CATCHUP_REPORTED ${slug} ${platform} ${describe(block.version, buildOf(block, platform))}: back to pending; the next pass tries again`);
    try { await ctx.pages(slug, next); } catch (error) { ctx.log(`HUB_CATCHUP_PAGES ${slug}: not re-rendered (${oneLine(error).slice(0, 160)})`); }
    return next[platform].device;
  }, { timeoutMs: 120_000, pollMs: 250 });
}

// ---------------------------------------------------------------------------------------------------- record over ssh

const argPatterns = Object.freeze({
  slug: slugPattern,
  platform: /^(android|ios)$/,
  version: semver,
  build: buildPattern,
  status: /^(installed|repaired|skipped|failure)$/,
  by: /^(catch-up|manual)$/,
  reason: reasonPattern,
  stage: /^(install|verify)$/,
  sha256: sha256Pattern,
  commit: /^[0-9a-f]{7,40}$/,
  'run-id': /^\d{1,20}$/,
  'run-attempt': /^[1-9]\d{0,3}$/,
});

// A reason travels as plain words: anything outside the pattern's characters becomes a space.
export const reasonText = text => sanitizeReason(text, 'no reason given').replace(/[^\w .,:;()+=#@%<>-]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 280) || 'no reason given';

export function recordArgs(facts) {
  const values = {
    slug: facts.slug,
    platform: facts.platform,
    version: facts.version,
    build: facts.build === undefined || facts.build === null ? undefined : String(facts.build),
    status: facts.status,
    by: facts.by ?? undefined,
    reason: facts.reason ? reasonText(facts.reason) : undefined,
    stage: facts.stage ?? undefined,
    sha256: facts.sha256 ?? undefined,
    commit: facts.commit ?? undefined,
    'run-id': facts.run?.id === undefined || facts.run?.id === null ? undefined : String(facts.run.id),
    'run-attempt': facts.run?.attempt === undefined || facts.run?.attempt === null ? undefined : String(facts.run.attempt),
  };
  const args = [];
  for (const [name, value] of Object.entries(values)) {
    if (value === undefined || value === '') continue;
    if (!argPatterns[name].test(value)) throw new Error(`record --${name} "${String(value).slice(0, 40)}" does not match its pattern`);
    args.push(`--${name}`, value);
  }
  return args;
}

export function parseRecordArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = /^--([a-z0-9-]+)$/.exec(argv[index] ?? '')?.[1];
    if (!name || !argPatterns[name]) throw new Error(`record: unknown option ${String(argv[index]).slice(0, 40)}`);
    const value = argv[index + 1];
    if (value === undefined || !argPatterns[name].test(value)) throw new Error(`record --${name}: "${String(value ?? '').slice(0, 40)}" does not match its pattern`);
    values[name] = value;
  }
  for (const name of ['slug', 'platform', 'version', 'build', 'status']) if (!values[name]) throw new Error(`record needs --${name}`);
  if (['installed', 'repaired'].includes(values.status) && !values.by) throw new Error(`record --status ${values.status} needs --by catch-up|manual`);
  return {
    slug: values.slug,
    platform: values.platform,
    version: values.version,
    build: values.build,
    status: values.status,
    by: values.by ?? null,
    reason: values.reason ?? null,
    stage: values.stage ?? null,
    sha256: values.sha256 ?? null,
    commit: values.commit ?? null,
    run: values['run-id'] ? { id: values['run-id'], attempt: Number(values['run-attempt'] ?? 1) } : null,
  };
}

// The node on big-chungus that runs the hub (the ssh session's own PATH has only the system node).
const remoteRecord = 'n="$HOME/.local/share/mise/installs/node/24/bin/node"; [ -x "$n" ] || n=node; exec "$n" "$HOME/.local/share/mobile-deploy-hub/current/tools/catchup/catchup.mjs" record';

export function sshRecordCommand(facts, host) {
  if (!/^[A-Za-z0-9.-]+$/.test(host ?? '')) throw new Error(`the Linux host "${host}" is not a host name`);
  const args = recordArgs(facts);
  return ['-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=20', '-o', 'ServerAliveInterval=15', host, `${remoteRecord} ${args.map(arg => `'${arg}'`).join(' ')}`];
}

// ---------------------------------------------------------------------------------------------------- host contexts

function base({ env, home, log, now, settings, devices, lockWaitMs }) {
  return {
    env,
    home,
    log,
    now,
    settings,
    devices,
    lockWaitMs,
    startedAt: now().getTime(),
    mode: readMode({ env, home }),
    journal: createJournal({ env, home, now }),
    // The catch-up is a hub job, never a deploy: its holds and short attempts are recorded as `hub-job` (FR-7).
    lock: (name, fn, options = {}) => withLock(name, fn, { env, log, kind: 'hub-job', ...options }),
    sha256: path => sha256File(path),
  };
}

// The runners' 1Password service account (runsvc-op.sh reads the same file), for `op read` only: the systemd unit and
// the Mac's ssh call carry no token of their own.
export function serviceAccountEnv(env = process.env, home = homedir()) {
  if (env.OP_SERVICE_ACCOUNT_TOKEN) return env;
  try {
    return { ...env, OP_SERVICE_ACCOUNT_TOKEN: readFileSync(join(home, '.config/op/service-account-token'), 'utf8').trim() };
  } catch {
    return env;
  }
}

// The hub's builds writer (C1): keys from 1Password at the first write, into the mc child's MC_HOST_builds only.
// open() hands the same writer to the hub's publishPages.
// credentials() hands the same keys to the catch-up's signed reads (MOBI-17); a failed read is asked again next time.
export function hubWriter({ settings, env = process.env, home = homedir(), read, runner }) {
  let s3 = null;
  let keys = null;
  const credentials = () => {
    if (!keys) keys = writerCredentials({ env: serviceAccountEnv(env, home), ...(read ? { read } : {}) }).catch(error => { keys = null; throw error; });
    return keys;
  };
  const open = async () => {
    if (!s3) s3 = createS3({ policy: settings.policy, credentials: await credentials(), env, ...(runner ? { runner } : {}) });
    return s3;
  };
  return {
    open,
    credentials,
    async putJson(key, value) {
      const text = serializeLatest(value);
      (await open()).putText(text, key);
    },
  };
}

// big-chungus: the S26 pass and the record side. Every outside dependency can be handed in (the tests do).
export function linuxContext({
  env = process.env,
  home = homedir(),
  log = defaultLog(env),
  now = () => new Date(),
  settings = loadSettings(),
  devices = loadDevices(env),
  fetchImpl = globalThis.fetch,
  writer = hubWriter({ settings, env, home }),
  emit = event => sendCatchupEvent({ event, env, home }),
  pages,
  adbWaitMs = 20_000,
  lockWaitMs,
} = {}) {
  // A read of what the bucket policy keeps private (a device APK) is signed with the writer's keys; the pointers are
  // anonymous, so an idle pass never asks 1Password for them (lib/access.mjs).
  const credentials = typeof writer.credentials === 'function' ? () => writer.credentials() : null;
  const store = createStore({ root: settings.loopbackRoot, writer, fetchImpl, credentials, signs: key => !isAnonymous(settings.policy, key) });
  const cache = join(home, '.cache/mobile-deploy-hub/catchup');
  const adb = createAdb({ env, home });
  const ctx = {
    ...base({ env, home, log, now, settings, devices, lockWaitMs }),
    store,
    credentials,
    adb,
    // E2: 20 s by serial, with at most one mDNS nudge in that window.
    findPhone: () => findPhone(adb, { serial: devices.android.serial, model: devices.android.model, waitMs: adbWaitMs, pollMs: Math.min(2_000, adbWaitMs), nudgeEvery: 5, log }),
    fetchApk: async (slug, block) => {
      const dir = join(cache, slug);
      const dest = join(dir, basename(block.key));
      const got = await downloadVerified(store.url(block.key), dest, { bytes: block.bytes, sha256: block.sha256, fetchImpl, auth: store.auth });
      for (const name of readdirSync(dir)) if (name !== basename(dest)) rmSync(join(dir, name), { force: true });
      if (got.downloaded > 0) log(`HUB_CATCHUP_FETCHED ${slug} android ${basename(dest)} ${got.downloaded} bytes over loopback, sha256 matches`);
      return got.path;
    },
    // The signer and the package are the policy's pins, never latest.json's alone: whoever can write latest.json cannot
    // point the S26 at an APK signed with another key.
    checkApk: (apk, block, app) => {
      const pin = app?.android ?? settings.apps.find(entry => entry.package === block.package)?.android ?? null;
      if (!pin) throw stageError('install', `the policy pins no Android package and signer for ${block.package}`);
      if (block.package !== pin.package || block.signer_sha256 !== pin.signer_sha256) throw stageError('install', `latest.json names ${block.package} and a signer that are not the policy's pins`);
      try {
        verifySigner({ apk, expected: pin.signer_sha256, env, home });
      } catch (error) {
        throw stageError('install', error.message);
      }
      const identity = apkIdentity({ apk, env, home });
      if (identity.package !== pin.package || identity.versionCode !== block.code || identity.versionName !== block.version) throw stageError('install', `the APK is ${identity.package} ${describe(identity.versionName, identity.versionCode)}, the policy and latest.json name ${pin.package} ${describe(block.version, block.code)}`);
    },
    emit,
    // Dedicated QA phones (MOBI-48): each has the hub's own adb server on its own port, held by the phone's lock and stopped with it.
    qaState: createQaState({ env, home }),
    qaPhones: () => dedicatedPhones({ devices, env, home }),
    qaAdb: phone => createAdb({ env: qaAdbEnv(env, phone.port), home }),
    qaFindPhone: (phone, qaAdb) => findPhone(qaAdb, { serial: phone.serial, model: phone.model, waitMs: adbWaitMs, pollMs: Math.min(2_000, adbWaitMs), nudgeEvery: 5, label: 'HUB_QA', log }),
    qaReap: phone => reapQaServer({ port: phone.port, env, home }),
    qaReapIfFree: phone => reapIfFree(phone, { env, home }),
    qaForeignHolders: phone => foreignHolders(phone, { env, home }),
  };
  // E4.3: the app page and the index, re-rendered by the hub's own publishPages (deliver calls it the same way).
  ctx.pages = pages ?? (async (slug, latest) => {
    await publishPages({ s3: await writer.open(), policy: settings.policy, slug, latest, fetchImpl, env, credentials: credentials ? await credentials() : null });
    log(`HUB_CATCHUP_PAGES ${slug}: app page and index re-rendered`);
  });
  ctx.record = facts => record(ctx, facts);
  return ctx;
}

// The Mac's link: metered unless its default gateway is inside the home LAN (F1's blind spot applies).
export function macMetered({ lanCidr, run = runBounded, env = process.env }) {
  try {
    const gateway = /gateway:\s*(\S+)/.exec(run('/sbin/route', ['-n', 'get', 'default'], { env, timeout: 10_000, label: 'route get default' }))?.[1];
    return !inCidr(gateway, lanCidr);
  } catch {
    return true;
  }
}

export function unpackIpa(ipa, { run = runBounded, env = process.env } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'hub-catchup-ipa-'));
  try {
    run('unzip', ['-q', '-o', ipa, '-d', dir], { env, timeout: 300_000, label: 'unzip ipa' });
    const payload = join(dir, 'Payload');
    const apps = existsSync(payload) ? readdirSync(payload).filter(name => name.endsWith('.app')) : [];
    if (apps.length !== 1) throw new Error(`the IPA holds ${apps.length} apps in Payload, expected one`);
    const app = join(payload, apps[0]);
    const info = key => run('/usr/bin/plutil', ['-extract', key, 'raw', '-o', '-', join(app, 'Info.plist')], { env, timeout: 30_000, label: `plutil ${key}` }).trim();
    return { app, bundle: info('CFBundleIdentifier'), version: info('CFBundleShortVersionString'), build: info('CFBundleVersion'), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}

// A pointer read over ssh from big-chungus: `curl` of its loopback MinIO, with the HTTP status on the last line. null for
// a missing object, as the https read gives.
export function readOverSsh({ host, url, run = runBounded, env = process.env }) {
  if (!/^[A-Za-z0-9.-]+$/.test(host ?? '') || !/^http:\/\/127\.0\.0\.1:\d+\/[a-z0-9.-]+\/[a-z0-9][a-z0-9-]*\/(latest|inflight)\.json$/.test(url)) throw new Error(`refusing to read ${url} over ssh`);
  const out = run('/usr/bin/ssh', ['-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=20', host, `curl -s --max-time 20 -w '\\n%{http_code}' '${url}'`], { env, timeout: 60_000, label: `ssh ${host} curl` });
  const lines = String(out).replace(/\n+$/, '').split('\n');
  const code = lines.pop();
  if (code === '404') return null;
  if (code !== '200') throw new Error(`${host} read ${url}: HTTP ${code}`);
  return JSON.parse(lines.join('\n'));
}

// The store's pointer reads, with a second path when the first one fails (not when it answers 404).
export function withFallback(store, { read, log, host }) {
  const fallback = async (key, error) => {
    log(`HUB_CATCHUP_FALLBACK ${key}: ${oneLine(error).slice(0, 120)}; reading it over ssh from ${host}`);
    return read(key);
  };
  return {
    ...store,
    latest: async (slug, options) => { try { return await store.latest(slug, options); } catch (error) { return fallback(latestKey(slug), error); } },
    inflight: async slug => { try { return await store.inflight(slug); } catch (error) { return fallback(inflightKey(slug), error); } },
  };
}

// The Mac: the iPad pass. It reads through https://s3.delo.sh, installs from the outbox the ios job filled, and
// reports to big-chungus over ssh (only big-chungus writes latest.json and talks to the bus).
export function macContext({
  env = process.env,
  home = homedir(),
  log = defaultLog(env),
  now = () => new Date(),
  settings = loadSettings(),
  devices = loadDevices(env),
  fetchImpl = globalThis.fetch,
  run = runBounded,
  ipad = createIpad({ devicectl: createDevicectl({ env }), udid: devices.ios.udid, model: devices.ios.model }),
  metered = () => macMetered({ lanCidr: settings.lanCidr, run, env }),
  unpack = ipa => unpackIpa(ipa, { run, env }),
  report,
  lockWaitMs,
} = {}) {
  const cache = join(home, 'Library/Caches/mobile-deploy-hub/catchup');
  const outbox = join(home, devices.mac?.outbox ?? 'Library/Caches/mobile-deploy-hub/outbox');
  const linuxHost = devices.linux?.host ?? 'big-chungus';
  // When https://s3.delo.sh does not answer (Cloudflare or the home WAN down, both devices at home), the same pointer
  // is read over ssh from big-chungus's loopback port.
  const store = withFallback(createStore({ root: settings.publicRoot, fetchImpl, cacheDir: cache }), {
    read: key => readOverSsh({ host: linuxHost, url: `${settings.loopbackRoot}/${key}`, run, env }),
    log,
    host: linuxHost,
  });
  return {
    ...base({ env, home, log, now, settings, devices, lockWaitMs }),
    store,
    ipad,
    metered,
    outboxIpa: (slug, block) => {
      const path = join(outbox, slug, `${block.version}-${block.build}.ipa`);
      try { return statSync(path).isFile() ? path : null; } catch { return null; }
    },
    // Only off a metered link (the caller checks): into the catch-up's own cache, never the deploy's outbox.
    fetchIpa: async (slug, block) => {
      const dir = join(cache, 'ipa');
      const dest = join(dir, `${slug}-${block.version}-${block.build}.ipa`);
      const got = await downloadVerified(store.url(block.key), dest, { bytes: block.bytes ?? undefined, sha256: block.sha256, fetchImpl });
      for (const name of readdirSync(dir)) if (name.startsWith(`${slug}-`) && name !== basename(dest)) rmSync(join(dir, name), { force: true });
      if (got.downloaded > 0) log(`HUB_CATCHUP_FETCHED ${slug} ios ${basename(dest)} ${got.downloaded} bytes, sha256 matches`);
      return got.path;
    },
    unpackIpa: unpack,
    record: report ?? (facts => {
      const output = run('/usr/bin/ssh', sshRecordCommand(facts, linuxHost), { env, timeout: 300_000, label: `ssh ${linuxHost} catchup record` });
      for (const line of output.split('\n').filter(Boolean)) log(`  ${linuxHost}: ${line}`);
    }),
  };
}

// ---------------------------------------------------------------------------------------------------- CLI

const usage = 'usage: catchup.mjs android | ios | record --slug S --platform P --version V --build B --status S [...] | retry <slug> <android|ios> | qa-retry <phone lock, e.g. s24> <slug> | mode [watch|live]';

function requireHost(name, command) {
  if (process.platform !== name) throw new Error(`catchup.mjs ${command} runs on ${name === 'linux' ? 'big-chungus' : 'the Mac'}, not ${process.platform}`);
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const [command, ...rest] = argv;
  const home = homedir();
  if (command === 'mode') {
    if (rest.length === 0) { console.log(`catch-up mode on this host: ${readMode({ env, home })} (${modeFile(env, home)})`); return 0; }
    const mode = writeMode(rest[0], { env, home });
    console.log(`catch-up mode on this host: ${mode}${mode === 'live' ? ' (passes install pending builds)' : ' (passes only log what they would do)'}`);
    return 0;
  }
  const watchdog = setTimeout(() => { console.error(`catchup.mjs: a pass ran for ${passLimitMs / 60_000} minutes; stopping it`); process.exit(3); }, passLimitMs);
  watchdog.unref();
  if (command === 'android') {
    requireHost('linux', command);
    const ctx = linuxContext({ env });
    // The dedicated QA phones first: their passes are short attempts, and the S26's may wait in line for most of the pass limit.
    let qaErrors = 0;
    try { qaErrors = (await qaPass(ctx)).errors; } catch (error) { qaErrors = 1; ctx.log(`HUB_CATCHUP_ERROR qa pass: ${oneLine(error)}`); }
    return (await androidPass(ctx)).errors + qaErrors > 0 ? 1 : 0;
  }
  if (command === 'ios') {
    requireHost('darwin', command);
    return (await iosPass(macContext({ env }))).errors > 0 ? 1 : 0;
  }
  if (command === 'record') {
    requireHost('linux', command);
    await record(linuxContext({ env }), parseRecordArgs(rest));
    return 0;
  }
  if (command === 'qa-retry') {
    requireHost('linux', command);
    qaRetry(linuxContext({ env }), rest[0], rest[1]);
    return 0;
  }
  if (command === 'retry') {
    requireHost('linux', command);
    await retry(linuxContext({ env }), rest[0], rest[1]);
    return 0;
  }
  throw new Error(usage);
}

// The units start it through ~/.local/share/mobile-deploy-hub/current, a symlink: compare real paths.
const invoked = path => { try { return realpathSync(resolve(path)); } catch { return null; } };
if (process.argv[1] && invoked(process.argv[1]) === invoked(fileURLToPath(import.meta.url))) {
  main().then(code => { process.exitCode = code; }, error => {
    console.error(`HUB_CATCHUP_ERROR ${String(error?.message ?? error).split('\n')[0]}`);
    process.exitCode = 1;
  });
}
