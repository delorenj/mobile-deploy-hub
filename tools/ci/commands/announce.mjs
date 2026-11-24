// announce (Linux, always): one event per run attempt from the job results and the receipts, with each delivery's
// status, the download links the deliver jobs published and trigger: deploy. A dry run only checks it.
// v1.3 (TOWE-76): it also writes the completion verdict (lib/completion.mjs) to $HUB_OUT/completion/completion.json,
// which the workflow uploads as the completion-out artifact `deploy.mjs ship` reads, and a run that owes TestFlight
// carries it as a delivery.
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { bbEmit, correlationFor, deploymentEvent } from '../lib/announce.mjs';
import { completionOf, testflightDelivery, testflightOf } from '../lib/completion.mjs';
import { hookEnvironment } from '../lib/config.mjs';
import { loadDevices } from '../lib/devices.mjs';
import { hookOutput, runBounded } from '../lib/exec.mjs';
import { latestKey, parseLatest } from '../lib/latest.mjs';
import { loadManifest } from '../lib/manifest.mjs';
import { notesKey, notesText, validateNotes } from '../lib/release-notes.mjs';
import { linkable } from '../lib/links.mjs';
import { releaseReservation, runKey } from '../lib/lock.mjs';
import { jobContext, jobCredentials, readObject } from '../lib/s3.mjs';
import { parseVersionInfo } from '../lib/version.mjs';
import { firstLine, parseNeeds, policyBanner, readReceipts, releaseFor, runOf, semver } from './common.mjs';

export const completionFile = out => join(out, 'completion', 'completion.json');

async function writeCompletion(out, completion, log) {
  const file = completionFile(out);
  await mkdir(join(out, 'completion'), { recursive: true });
  await writeFile(file, `${JSON.stringify(completion, null, 2)}\n`);
  log(`HUB_COMPLETION ${completion.verdict} ${completion.summary}`);
  return file;
}

// preflight-ios has no artifact: its receipt travels as a job output (base64 JSON).
function preflightReceipt(needs) {
  const encoded = needs?.['preflight-ios']?.outputs?.receipt;
  if (!encoded) return null;
  try { return JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')); } catch { return null; }
}

// A Mac job that was cancelled before any runner picked it up: the Mac went away after the gate, and the host watchdog
// (tools/ci/macwatch.mjs) or a person cancelled the run that waited for it. GitHub's record of the run says so (no
// runner name), read through the host's gh login. null when nothing was lost, or GitHub could not be asked.
export function findLostMac({ env, needs, policy, runner = runBounded }) {
  const cancelled = ['preflight-ios', 'ios'].filter(job => needs?.[job]?.result === 'cancelled');
  if (cancelled.length === 0 || !/^\d+$/.test(env.GITHUB_RUN_ID ?? '') || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(env.GITHUB_REPOSITORY ?? '')) return null;
  const clean = { ...env };
  delete clean.GH_TOKEN;
  delete clean.GITHUB_TOKEN;
  let jobs;
  try {
    jobs = JSON.parse(runner('gh', ['api', `repos/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}/attempts/${Number(env.GITHUB_RUN_ATTEMPT ?? 1)}/jobs?per_page=100`, '--jq', '[.jobs[] | {name, conclusion, runner_name}]'], { env: clean, timeout: 30_000, label: 'gh api jobs' }));
  } catch { return null; }
  for (const job of cancelled) {
    const entry = jobs.find(item => new RegExp(`(^|/ )${job}$`).test(item.name ?? ''));
    if (entry && entry.conclusion === 'cancelled' && !entry.runner_name) {
      const limit = policy.mac.queue_limit_min;
      return {
        job,
        reason: job === 'ios'
          ? `the Mac went offline after the gate: the ios job waited ${limit}+ minutes and no runner took it; Re-run failed jobs when it is back`
          : `the Mac went offline after the gate: preflight-ios waited ${limit}+ minutes and no runner took it; nothing was bumped. Deploy again (the gate skips the iPad lane while the Mac is offline)`,
      };
    }
  }
  return null;
}

// The Mac's installed hub-device wrapper (tools/catchup/units/install.sh writes it with an absolute node and release path, so
// the ssh session's bare PATH does not matter); `~` is the Mac user's home, expanded by the remote shell.
export const MAC_HUB_DEVICE = '~/.local/bin/hub-device';

// A lane that ended well has no later job that takes its device, so its Reservation is released here as the backstop of the
// lane's own release (Story 2.6, AD-7): android and ios `success` (a pending S26 or iPad is a successful job). A failed,
// cancelled or skipped lane releases nothing: grace and the ceiling end it, and a rerun keeps its place. `adb` is released on
// this host through lock.mjs. `mac-ios` is on the Mac's disk, so it goes over `ssh hub-mac` running the installed hub-device
// at its absolute path, never `rm`; a Mac without the verb, or one that does not answer, is logged and left to the ceiling.
export function releaseFinished({ env, needs, devices, releaser = releaseReservation, runner = runBounded, log = console.log }) {
  const key = runKey(env);
  if (key === null) return [];
  const done = [];
  if (needs?.android?.result === 'success') done.push(['adb', releaseFor('adb', { releaser, env, log })?.status ?? 'failed']);
  if (needs?.ios?.result === 'success') {
    const host = devices?.mac?.host;
    let status;
    try {
      const out = runner('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', host, `${MAC_HUB_DEVICE} reservation release --run ${key} --name mac-ios`], { env, timeout: 40_000, label: `ssh ${host}` });
      status = /HUB_DEVICE_RESERVATION_RELEASED/.test(out) ? 'released' : 'none';
      if (status === 'released') log(`HUB_RESERVATION_RELEASED mac-ios ${key} (on the Mac)`);
    } catch (error) {
      const text = String(error?.message ?? error);
      // An older hub-device on the Mac answers a verb it does not know with its usage (exit 2), a missing wrapper with 127.
      const verbMissing = /usage:|exit 2\b|exit 127\b|not found/i.test(text);
      status = verbMissing ? 'skipped' : 'failed';
      log(verbMissing
        ? `HUB_RESERVATION_RELEASE_SKIPPED mac-ios ${key}: the Mac's hub-device has no reservation release verb yet; the Reservation's ceiling ends it`
        : `HUB_RESERVATION_RELEASE_FAILED mac-ios ${key}: ${firstLine(text)}; the Reservation's ceiling ends it`);
    }
    done.push(['mac-ios', status]);
  }
  return done;
}

export async function announce(config, { env = process.env, home = homedir(), fetchImpl = fetch, log = console.log, lostMac = undefined, credentials = undefined, credentialsFor = null, now = () => new Date(), releaser = releaseReservation, runner = runBounded } = {}) {
  const { policy } = policyBanner(log);
  const devices = loadDevices(env);
  const needs = parseNeeds(env.HUB_NEEDS);
  const receipts = readReceipts(env.HUB_RECEIPTS || join(config.out, 'receipts'));
  try { releaseFinished({ env, needs, devices, releaser, runner, log }); } catch (error) { log(`HUB_RESERVATION_RELEASE_FAILED ${firstLine(error?.message)}; the ceiling ends it`); }
  const preflight = preflightReceipt(needs);
  if (preflight && !receipts['preflight-ios']) receipts['preflight-ios'] = preflight;

  // The project from the policy (its slug is the one the build directory uses) and the manifest's name; a gate that
  // refused a broken manifest still gets its event from the policy.
  let manifest = null;
  try { manifest = await loadManifest(config.cwd, config.manifest); } catch (error) { log(`HUB_ANNOUNCE_MANIFEST ${error.message.split('\n')[0]}`); }
  const app = policy.apps[env.GITHUB_REPOSITORY ?? ''];
  const slug = app?.slug ?? manifest?.project?.slug ?? (env.GITHUB_REPOSITORY ?? 'unknown/app').split('/').pop().toLowerCase().replace(/[^a-z0-9-]/g, '-');
  if (app && manifest?.project && manifest.project.slug !== app.slug) log(`HUB_ANNOUNCE_SLUG the manifest says ${manifest.project.slug}; the event uses the policy's ${app.slug}`);
  const project = { slug, name: manifest?.project?.name ?? app?.slug ?? 'unknown app' };
  const declared = manifest ? { android: Boolean(manifest.android), ios: Boolean(manifest.ios) } : { android: (app?.lanes ?? ['android']).includes('android'), ios: (app?.lanes ?? []).includes('ios') };

  // MOBI-17: the notification's links to private objects are presigned with the job's keys (never stored anywhere); the
  // logs and receipts keep the plain URLs. No keys (a test, a shell outside a job) means those links are dropped.
  // The same keys sign every read of a private object below.
  // A failed read of the keys is asked once more (jobCredentials forgets a failure) before the links are given up.
  let keys = credentials;
  if (keys === undefined) {
    keys = null;
    for (let tries = 1; tries <= 2 && keys === null && jobContext(env); tries += 1) {
      try { keys = await (credentialsFor ?? jobCredentials)(env); } catch (error) { log(`::warning::no keys to sign download links, try ${tries} of 2 (${firstLine(error.message)})`); }
    }
  }
  const planReceipt = receipts.plan;
  const planOutputs = needs.plan?.outputs ?? {};
  let version = planReceipt?.version || planOutputs.version || config.version || '';
  let androidCode = planReceipt?.android_code || planOutputs.android_code || '';
  if (!semver.test(version) && manifest) {
    // The plan stopped before it named the next version: the event names the version main is at.
    try {
      const current = parseVersionInfo(hookOutput('version.read', manifest.version.read, { cwd: config.cwd, env: hookEnvironment(config, env) }));
      version = current.version;
      androidCode = current.android_code ?? '';
    } catch (error) { log(`HUB_ANNOUNCE_VERSION ${error.message.split('\n')[0]}`); }
  }
  if (!semver.test(version)) {
    // No manifest and no plan: the newest published version, else 0.0.0 (the event says why it stopped).
    try { const text = await readObject(policy, latestKey(project.slug), { fetchImpl, env, credentials: keys }); version = text ? parseLatest(text).version : '0.0.0'; } catch { version = '0.0.0'; }
  }
  const commit = planReceipt?.sha || planOutputs.build_sha || env.GITHUB_SHA || '';
  if (!/^[0-9a-f]{7,40}$/.test(commit)) throw new Error('announce cannot name the commit (no plan receipt and no GITHUB_SHA)');
  // The plan has the last word on the iPad lane (it probes the Mac again right before it), else the gate (its receipt
  // too: a gate that refused a lane still recorded what it read).
  const gateFacts = receipts.gate?.gate ?? {};
  const iosLane = planOutputs.ios_lane || needs.gate?.outputs?.ios_lane || gateFacts.ios_lane || config.iosLane || 'run';
  // TestFlight is the gate's derived decision (config.testflight is its output), a delivery of its own in the event.
  const iosBuild = receipts.plan?.build || planOutputs.ios_build || '';
  const tf = testflightOf({ testflight: config.testflight, iosLane, needs, receipts, dryRun: config.dryRun });
  const extraDeliveries = tf ? [testflightDelivery(tf, { version: receipts.ios?.store?.version ?? version, build: receipts.ios?.store?.build ?? receipts.ios?.delivery?.build ?? iosBuild, ...(Array.isArray(receipts.ios?.store?.groups) && receipts.ios.store.groups.length > 0 ? { groups: receipts.ios.store.groups } : {}) })] : [];
  // What the deliver jobs published: the APK half (deliver-android), the IPA half (deliver-ios), or one deliver (v1.1).
  const published = { apk: null, apk_bytes: null, ota: null, ipa_bytes: null, page: null, manifest: null, any: false };
  for (const job of ['deliver', 'deliver-android', 'deliver-ios']) {
    const done = needs[job]?.result === 'success' || (config.dryRun && receipts[job]);
    const from = done ? receipts[job]?.published : null;
    if (!from) continue;
    for (const key of ['apk', 'apk_bytes', 'ota', 'ipa_bytes', 'page', 'manifest']) if (from[key] !== null && from[key] !== undefined && published[key] === null) published[key] = from[key];
    published.any = published.any || Boolean(from.any);
  }
  const lost = lostMac === undefined ? findLostMac({ env, needs, policy }) : lostMac;
  if (lost) log(`HUB_MAC_LOST ${lost.job}: ${lost.reason}`);
  const linked = linkable({ policy, slug: project.slug, published: published.page ? published : null, credentials: keys, now: now() });
  if (linked.minted.length > 0) log(`HUB_LINKS_PRESIGNED ${linked.minted.join(', ')}: valid 7 days, sent only in the notification`);
  if (linked.dropped.length > 0) log(`::warning::HUB_LINKS_DROPPED ${linked.dropped.join(', ')}: private, and there were no keys to sign a link`);
  // The notification says a private link is missing, so nobody waits for an Install APK button that will not come.
  const withheld = linked.dropped.length > 0 ? [`${linked.dropped.map(field => (field === 'apk' ? 'Install APK' : 'Builds')).join(' and ')} link withheld (no signing keys)`] : [];
  const event = deploymentEvent({ project, declared, platform: config.platform, devices, needs, receipts, version, androidCode: androidCode ? String(androidCode) : '', commit, iosLane, published: linked.published, env, lostMac: lost, extraDeliveries, extras: withheld });
  // The page and Release both reference this immutable per-version record. Notification text stays a short
  // operational status (the Bloodbank schema caps it); its page button opens the full authored notes.
  if (published.page && !config.dryRun) {
    try {
      const raw = await readObject(policy, notesKey(project.slug, version), { fetchImpl, env, credentials: keys });
      if (raw) {
        const canonical = validateNotes(JSON.parse(raw), { current: version, commit });
        if (canonical.status === 'authored') log(`HUB_RELEASE_NOTES ${notesText(canonical).split('\n')[0]}: ${published.page}`);
      }
    } catch (error) { log(`::warning::release notes unavailable for notification (${firstLine(error.message)}); the build page remains the canonical link`); }
  }

  // The completion verdict, written before the event goes out so a dead bus still leaves it (rewritten red below).
  let latest = null;
  let latestUnread = false;
  if (!config.dryRun) {
    try { const text = await readObject(policy, latestKey(project.slug), { fetchImpl, env, credentials: keys }); latest = text ? parseLatest(text, { slug: project.slug }) : null; } catch (error) { latestUnread = true; log(`HUB_COMPLETION_LATEST ${firstLine(error.message)}: a pending device cannot be shown durable`); }
  }
  const run = runOf(env);
  const judge = failure => completionOf({
    policy, repo: env.GITHUB_REPOSITORY ?? '', slug: project.slug, store: Boolean(manifest?.ios?.store), required: gateFacts.completion?.required ?? null,
    dryRun: config.dryRun, platform: config.platform, iosLane, catchup: gateFacts.catchup ?? {}, deliveries: event.data.deliveries, testflight: tf, latest, latestUnread,
    version, androidCode: androidCode ? String(androidCode) : null, iosBuild, failure, bumped: !config.dryRun && receipts.plan?.bump?.committed === true,
    run: { id: run.id, attempt: run.attempt, url: run.url }, commit,
  });
  await writeCompletion(config.out, judge(event.failure), log);

  const correlation = correlationFor(env);
  try {
    bbEmit({ type: event.type, data: event.data, correlation, check: true, env, home });
    if (!config.dryRun) bbEmit({ type: event.type, data: event.data, correlation, check: false, env, home });
  } catch (error) {
    await writeCompletion(config.out, judge(event.failure ?? { job: 'announce', stage: 'deliver', reason: firstLine(error.message).slice(0, 300) }), log);
    throw error;
  }
  if (config.dryRun) {
    log(`HUB_EVENT_CHECKED ${event.type}: ${event.data.summary} (dry run, not sent; ${event.data.links?.length ?? 0} links)`);
    return { ...event, sent: false, correlation };
  }
  log(`HUB_EVENT_SENT ${event.type}: ${event.data.summary}`);
  return { ...event, sent: true, correlation };
}
