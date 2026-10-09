// announce (Linux, always): one event per run attempt from the job results and the receipts, with each delivery's
// status, the download links deliver published and trigger: deploy. A dry run only checks it.
import { homedir } from 'node:os';
import { join } from 'node:path';
import { bbEmit, correlationFor, deploymentEvent } from '../lib/announce.mjs';
import { hookEnvironment } from '../lib/config.mjs';
import { loadDevices } from '../lib/devices.mjs';
import { hookOutput } from '../lib/exec.mjs';
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

export async function announce(config, { env = process.env, home = homedir(), fetchImpl = fetch, log = console.log } = {}) {
  const { policy } = policyBanner(log);
  const devices = loadDevices(env);
  const needs = parseNeeds(env.HUB_NEEDS);
  const receipts = readReceipts(env.HUB_RECEIPTS || join(config.out, 'receipts'));
  const preflight = preflightReceipt(needs);
  if (preflight && !receipts['preflight-ios']) receipts['preflight-ios'] = preflight;

  // The project from the manifest; a gate that refused a broken manifest still gets its event from the policy.
  let manifest = null;
  try { manifest = await loadManifest(config.cwd, config.manifest); } catch (error) { log(`HUB_ANNOUNCE_MANIFEST ${error.message.split('\n')[0]}`); }
  const app = policy.apps[env.GITHUB_REPOSITORY ?? ''];
  const project = manifest?.project ? { slug: manifest.project.slug, name: manifest.project.name } : { slug: app?.slug ?? (env.GITHUB_REPOSITORY ?? 'unknown/app').split('/').pop().toLowerCase().replace(/[^a-z0-9-]/g, '-'), name: app?.slug ?? 'unknown app' };
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
  const iosLane = needs.gate?.outputs?.ios_lane || config.iosLane || 'run';
  const published = needs.deliver?.result === 'success' || config.dryRun ? receipts.deliver?.published ?? null : null;
  const event = deploymentEvent({ project, declared, platform: config.platform, devices, needs, receipts, version, androidCode: androidCode ? String(androidCode) : '', commit, iosLane, published, env, extras });
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
