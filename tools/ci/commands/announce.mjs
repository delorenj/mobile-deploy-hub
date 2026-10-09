// announce (Linux, always): one event per run attempt from the job results and the receipts, with each delivery's
// status, the download links the deliver jobs published and trigger: deploy. A dry run only checks it.
import { homedir } from 'node:os';
import { join } from 'node:path';
import { bbEmit, correlationFor, deploymentEvent } from '../lib/announce.mjs';
import { hookEnvironment } from '../lib/config.mjs';
import { loadDevices } from '../lib/devices.mjs';
import { hookOutput, runBounded } from '../lib/exec.mjs';
import { latestKey, parseLatest } from '../lib/latest.mjs';
import { loadManifest } from '../lib/manifest.mjs';
import { readObject } from '../lib/s3.mjs';
import { parseVersionInfo } from '../lib/version.mjs';
import { parseNeeds, policyBanner, readReceipts, semver } from './common.mjs';

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

export async function announce(config, { env = process.env, home = homedir(), fetchImpl = fetch, log = console.log, lostMac = undefined } = {}) {
  const { policy } = policyBanner(log);
  const devices = loadDevices(env);
  const needs = parseNeeds(env.HUB_NEEDS);
  const receipts = readReceipts(env.HUB_RECEIPTS || join(config.out, 'receipts'));
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
    try { const text = await readObject(policy, latestKey(project.slug), { fetchImpl }); version = text ? parseLatest(text).version : '0.0.0'; } catch { version = '0.0.0'; }
  }
  const commit = planReceipt?.sha || planOutputs.build_sha || env.GITHUB_SHA || '';
  if (!/^[0-9a-f]{7,40}$/.test(commit)) throw new Error('announce cannot name the commit (no plan receipt and no GITHUB_SHA)');
  const extras = [];
  if (receipts.ios?.testflight && !config.dryRun && /uploaded/.test(receipts.ios.testflight)) extras.push('TestFlight');
  // The plan has the last word on the iPad lane (it probes the Mac again right before it), else the gate.
  const iosLane = planOutputs.ios_lane || needs.gate?.outputs?.ios_lane || config.iosLane || 'run';
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
  const event = deploymentEvent({ project, declared, platform: config.platform, devices, needs, receipts, version, androidCode: androidCode ? String(androidCode) : '', commit, iosLane, published: published.page ? published : null, env, extras, lostMac: lost });
  const correlation = correlationFor(env);
  bbEmit({ type: event.type, data: event.data, correlation, check: true, env, home });
  if (config.dryRun) {
    log(`HUB_EVENT_CHECKED ${event.type}: ${event.data.summary} (dry run, not sent; ${event.data.links?.length ?? 0} links)`);
    return { ...event, sent: false, correlation };
  }
  bbEmit({ type: event.type, data: event.data, correlation, check: false, env, home });
  log(`HUB_EVENT_SENT ${event.type}: ${event.data.summary}`);
  return { ...event, sent: true, correlation };
}
