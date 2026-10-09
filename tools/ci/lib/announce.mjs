// One Bloodbank event per deploy run attempt: bloodbank.project.deployment.completed or .failed, sent by the final
// announce job with bb-emit (NATS on big-chungus). The outcome comes from the jobs' own results (needs.<job>.result);
// the receipts add detail, so a job that timed out or was cancelled still turns into a failed delivery. A dry run
// builds the would-be event and holds it to the schema with `bb-emit --check`, and never sends it: the schema has no
// dry-run flag, and ntfy would push a deploy that did not happen.
//
// v1.1: every delivery has a status. installed (read back in this run), pending (built, checked and published, the
// device was away: a catch-up installs it later), skipped (not built: the Mac offline or over its data budget, or
// --platform narrowed it) or failed. Only a failed delivery, or a failed plan, build or deliver, makes the event
// .failed. The event carries download links (data.links) for the notification and data.trigger: deploy.
//
// "Re-run failed jobs" re-runs announce too, so one deploy can send .failed (attempt 1) and then .completed
// (attempt 2). Both carry the same correlation (UUIDv5 of repo and run id) and data.run.attempt.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { isCredentialVariable } from './config.mjs';
import { attempt } from './exec.mjs';

const urlNamespace = '6ba7b811-9dad-11d1-80b4-00c04fd430c8';

export function uuidv5(name, namespace = urlNamespace) {
  const space = Buffer.from(namespace.replaceAll('-', ''), 'hex');
  const hash = createHash('sha1').update(Buffer.concat([space, Buffer.from(name, 'utf8')])).digest();
  hash[6] = (hash[6] & 0x0f) | 0x50;
  hash[8] = (hash[8] & 0x3f) | 0x80;
  const hex = hash.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export const correlationFor = env => uuidv5(`mobile-deploy:${env.GITHUB_REPOSITORY ?? 'local'}:${env.GITHUB_RUN_ID ?? '0'}`);

// Bloodbank refuses workstation paths anywhere in a project payload; a reason keeps its words, not its paths.
export function sanitizeReason(text, fallback = 'the job stopped') {
  const line = String(text ?? '').split('\n').map(part => part.replace(/^::error::/, '').trim()).find(Boolean) ?? fallback;
  return line.replace(/(?<![\w.])\/(?:home|Users|root|tmp|var|etc|opt|srv|mnt|private)\/[^\s)\]'",;]*/g, '<path>').slice(0, 300);
}

export const stages = Object.freeze(['preflight', 'version', 'build', 'install', 'verify', 'deliver']);
export const deliveryStatuses = Object.freeze(['installed', 'pending', 'skipped', 'failed']);

// The lanes an app declares, and the ones this run's platform covers.
export function scopeOf({ platform, manifest }) {
  return { android: platform !== 'ios' && Boolean(manifest.android), ios: platform !== 'android' && Boolean(manifest.ios) };
}

export function targetOf(scope, devices) {
  if (scope.android && scope.ios) return { kind: 'device-set', name: `${devices.android.model} + ${devices.ios.model}`, id: null };
  if (scope.android) return { kind: 'android-device', name: devices.android.model, id: devices.android.serial };
  return { kind: 'ios-device', name: devices.ios.model, id: devices.ios.udid };
}

const ok = result => result === 'success';
const broke = result => result === 'failure' || result === 'cancelled';

function failureOf(job, result, receipt, fallbackStage) {
  return { job, stage: stages.includes(receipt?.stage) ? receipt.stage : fallbackStage, reason: sanitizeReason(receipt?.reason, `the ${job} job ${result === 'cancelled' ? 'was cancelled or timed out' : 'failed'}`) };
}

export const iosSkipReasons = Object.freeze({
  'skip-offline': 'the Mac was offline, so the iPad build was not made',
  'skip-metered': 'the Mac was on a metered link and the iPad build would have gone over its data budget',
});

// The deliveries and the outcome, from the job results first and the receipts second. `declared` is every lane the
// app declares; a lane the run's platform leaves out is listed as skipped.
export function deliveriesFrom({ declared, platform = 'both', devices, needs, receipts, version, iosLane = 'run' }) {
  const result = job => needs?.[job]?.result;
  const gateFailure = broke(result('gate')) && failureOf('gate', result('gate'), receipts.gate, 'preflight');
  const preflightFailure = broke(result('preflight-ios')) && failureOf('preflight-ios', result('preflight-ios'), receipts['preflight-ios'], 'preflight');
  const planFailure = broke(result('plan')) && failureOf('plan', result('plan'), receipts.plan, 'preflight');
  const exportFailure = broke(result('ios-export')) && failureOf('ios-export', result('ios-export'), receipts['ios-export'], 'build');
  // A refused gate, a failed Mac preflight or a failed plan stops every lane.
  const upstream = gateFailure || preflightFailure || planFailure;
  const lane = (name, job, device) => {
    const receipt = receipts[job];
    const from = receipt?.delivery ?? {};
    const base = {
      platform: name, target: device.model, device: device.name ?? (name === 'android' ? 'S26' : 'iPad'),
      version: from.version ?? version, build: from.build === undefined || from.build === null ? null : String(from.build), sha256: from.sha256 ?? null, verified: false,
    };
    if (platform !== 'both' && platform !== name) return { delivery: { ...base, status: 'skipped', reason: `--platform ${platform}` } };
    if (name === 'ios' && iosSkipReasons[iosLane] && !gateFailure) return { delivery: { ...base, status: 'skipped', reason: iosSkipReasons[iosLane] } };
    if (ok(result(job))) {
      const status = deliveryStatuses.includes(from.status) ? from.status : (from.verified === true ? 'installed' : 'pending');
      const delivery = { ...base, status, verified: status === 'installed' };
      if (from.reason && status !== 'installed') delivery.reason = sanitizeReason(from.reason);
      if (status === 'installed') delivery.by = 'deploy';
      return { delivery };
    }
    let failure;
    if (broke(result(job))) failure = failureOf(job, result(job), receipt, 'install');
    else failure = (name === 'ios' && exportFailure) || upstream || { job, stage: 'preflight', reason: `the ${job} job did not run` };
    return { delivery: { ...base, status: 'failed', stage: failure.stage, reason: failure.reason }, failure };
  };
  const lanes = [
    ...(declared.android ? [lane('android', 'android', devices.android)] : []),
    ...(declared.ios ? [lane('ios', 'ios', devices.ios)] : []),
  ];
  const deliverFailure = broke(result('deliver')) && failureOf('deliver', result('deliver'), receipts.deliver, 'deliver');
  const failure = upstream || exportFailure || lanes.find(entry => entry.failure)?.failure || deliverFailure || null;
  return { deliveries: lanes.map(entry => entry.delivery), failure };
}

// G1: what the notification can offer, from what deliver published.
export function linksFor({ type, published, runUrl, deliveries, trigger = 'deploy' }) {
  const links = [];
  const ipad = deliveries.find(item => item.platform === 'ios');
  if (type.endsWith('.completed')) {
    if (trigger === 'deploy') {
      if (published?.apk) links.push({ rel: 'apk', label: 'Install APK', url: published.apk });
      if (published?.ota && ipad?.status !== 'installed') links.push({ rel: 'ota', label: 'Install on iPad', url: published.ota });
    }
    if (published?.page) links.push({ rel: 'page', label: 'Builds', url: published.page });
    if (runUrl && trigger === 'deploy') links.push({ rel: 'run', label: 'Run', url: runUrl });
  } else {
    if (runUrl) links.push({ rel: 'run', label: trigger === 'deploy' ? 'Open run' : 'Run', url: runUrl });
    if (published?.page && (published.apk || published.ota || published.any)) links.push({ rel: 'page', label: 'Builds', url: published.page });
  }
  return links.filter(link => /^(https|itms-services):\/\/[^\s"<>]+$/.test(link.url) && link.url.length <= 600).slice(0, 6);
}

const statusPhrase = delivery => (delivery.status === 'installed' ? 'installed' : delivery.status);

// G2: one line that works on its own, at most 200 characters.
export function summaryOf({ name, version, androidCode, commit, deliveries, verified, failure }) {
  const label = `${name} ${version}${androidCode ? ` (${androidCode})` : ''}`;
  const devices = deliveries.map(item => `${item.device} ${statusPhrase(item)}`).join(', ');
  const line = failure
    ? `${label} deploy failed at ${failure.stage}: ${failure.reason}${devices ? `; ${devices}` : ''}`
    : `${label} ${String(commit).slice(0, 7)}: ${devices}, verified=${verified}`;
  return line.length > 200 ? `${line.slice(0, 199)}…` : line;
}

export function deploymentEvent({ project, declared, platform = 'both', devices, needs, receipts, version, androidCode, commit, iosLane = 'run', published = null, env = process.env, now = new Date(), extras = [] }) {
  const { deliveries, failure } = deliveriesFrom({ declared, platform, devices, needs, receipts, version, iosLane });
  const scope = { android: deliveries.some(item => item.platform === 'android'), ios: deliveries.some(item => item.platform === 'ios') };
  const built = { android: declared.android && (platform === 'both' || platform === 'android'), ios: declared.ios && (platform === 'both' || platform === 'ios') };
  const target = targetOf(scope.android || scope.ios ? scope : { android: true, ios: false }, devices);
  const kind = built.android && built.ios ? 'mobile-app' : built.android ? 'android-apk' : 'ios-app';
  const single = built.android !== built.ios ? deliveries.find(item => item.platform === (built.android ? 'android' : 'ios')) : null;
  const inScope = deliveries.filter(item => !(item.status === 'skipped' && /^--platform /.test(item.reason ?? '')));
  const verified = inScope.length > 0 && inScope.every(item => item.status === 'installed');
  const runUrl = env.GITHUB_RUN_ID ? `${env.GITHUB_SERVER_URL ?? 'https://github.com'}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}` : null;
  const data = {
    schema_version: 1,
    summary: '',
    project: { slug: project.slug, name: project.name },
    artifact: { kind, name: project.name, version, version_code: androidCode ? Number(androidCode) : null, commit, dirty: false, variant: 'debug', sha256: single?.sha256 ?? null },
    target,
    deliveries,
    run: { id: String(env.GITHUB_RUN_ID ?? '0'), attempt: Number(env.GITHUB_RUN_ATTEMPT ?? 1), url: runUrl, hub_ref: env.HUB_REF || null },
    trigger: 'deploy',
  };
  const stamp = now.toISOString().replace(/\.\d{3}Z$/, 'Z');
  const type = failure ? 'bloodbank.project.deployment.failed' : 'bloodbank.project.deployment.completed';
  const links = linksFor({ type, published, runUrl, deliveries });
  if (links.length > 0) data.links = links;
  data.summary = summaryOf({ name: project.name, version, androidCode, commit, deliveries, verified, failure });
  if (extras.length > 0 && !failure) data.summary = `${data.summary} + ${extras.join(' + ')}`.slice(0, 200);
  if (failure) {
    Object.assign(data, { stage: failure.stage, reason: failure.reason, failed_at: stamp });
    return { type, data, failure };
  }
  Object.assign(data, { verified, deployed_at: stamp });
  return { type, data, failure: null };
}

export const bbEmitPath = (env = process.env, home = homedir()) => env.HUB_BB_EMIT || join(home, '.local/bin/bb-emit');

// bb-emit is a python script; run it with the system interpreter so a mise shim in the app checkout cannot break it.
function command(bin) {
  let first = '';
  try { first = readFileSync(bin, 'utf8').split('\n', 1)[0]; } catch { /* reported by the caller */ }
  return /python/.test(first) && existsSync('/usr/bin/python3') ? ['/usr/bin/python3', [bin]] : [bin, []];
}

export function emitArgs({ type, correlation, check, producer = 'mobile-deploy-hub' }) {
  return ['--type', type, '--source', 'urn:33god:service:mobile-deploy-hub', '--producer', producer, '--service', 'mobile-deploy-hub', '--correlation', correlation, check ? '--check' : '--strict'];
}

// --check holds the envelope to its JSON Schema and publishes nothing; --strict publishes and fails on a dead bus.
// producer: mobile-deploy-hub for a deploy, mobile-deploy-hub-catchup for a catch-up install (G3).
export function bbEmit({ type, data, correlation, check, env = process.env, home = homedir(), runner = attempt, producer }) {
  const bin = bbEmitPath(env, home);
  if (!existsSync(bin)) throw new Error(`bb-emit is not installed at ${bin}`);
  const [program, prefix] = command(bin);
  const clean = {};
  for (const [name, value] of Object.entries(env)) if (!isCredentialVariable(name)) clean[name] = value;
  const result = runner(program, [...prefix, ...emitArgs({ type, correlation, check, producer })], { env: clean, input: JSON.stringify(data), timeout: 30_000 });
  const detail = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
  if (result.timedOut) throw new Error(`bb-emit ${check ? '--check' : '--strict'} timed out`);
  if (!result.ok) throw new Error(`bb-emit ${check ? '--check' : '--strict'} refused the ${type} event:\n${detail.split('\n').slice(-6).join('\n')}`);
  return detail;
}

// Where bb-emit really lives (it is a symlink into the bloodbank checkout), and whether the files that decide what
// it accepts are committed there. bb-emit validates against that working tree, so an uncommitted schema edit
// would let a deploy pass a contract nobody can reproduce.
export const contractPaths = Object.freeze(['bin/bb-emit', 'schemas/_common', 'schemas/bloodbank/project', 'services/agent-hooks/core']);

export function bloodbankTree({ env = process.env, home = homedir(), runner = attempt } = {}) {
  const bin = bbEmitPath(env, home);
  let real;
  try { real = realpathSync(bin); } catch { return { root: null, commit: null, dirty: null }; }
  const root = basename(dirname(real)) === 'bin' ? dirname(dirname(real)) : dirname(real);
  const head = runner('git', ['-C', root, 'rev-parse', 'HEAD'], { env, timeout: 15_000 });
  if (!head.ok) return { root, commit: null, dirty: null };
  const status = runner('git', ['-C', root, 'status', '--porcelain', '--', ...contractPaths], { env, timeout: 15_000 });
  return { root, commit: head.stdout.trim(), dirty: status.ok ? status.stdout.split('\n').map(line => line.slice(3).trim()).filter(Boolean) : null };
}
