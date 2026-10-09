// One Bloodbank event per v3 deploy: bloodbank.project.deployment.completed or .failed, sent by the final announce
// job with bb-emit (NATS on big-chungus). The outcome comes from the jobs' own results (needs.<job>.result); the
// receipts only add detail, so a job that timed out or was cancelled still turns into a failed delivery. A dry run
// builds the would-be event and holds it to the schema with `bb-emit --check`, and never sends it: the schema has
// no dry-run flag, and ntfy would push a deploy that did not happen.
//
// "Re-run failed jobs" re-runs announce too, so one deploy can send .failed (attempt 1) and then .completed
// (attempt 2). Both carry the same correlation (UUIDv5 of repo and run id) and data.run.attempt, so (run.id,
// run.attempt) tells them apart.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { credentialVariables } from './config.mjs';
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

export const stages = Object.freeze(['preflight', 'version', 'build', 'install', 'verify']);

// The lanes a deploy covers, and the device line an event names.
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

// The deliveries and the outcome, from the job results first and the receipts second.
export function deliveriesFrom({ scope, devices, needs, receipts, version }) {
  const result = job => needs?.[job]?.result;
  const upstream = [
    broke(result('preflight-ios')) && failureOf('preflight-ios', result('preflight-ios'), receipts['preflight-ios'], 'preflight'),
    broke(result('plan')) && failureOf('plan', result('plan'), receipts.plan, 'preflight'),
  ].find(Boolean);
  const exportFailure = broke(result('ios-export')) && failureOf('ios-export', result('ios-export'), receipts['ios-export'], 'build');
  const lane = (platform, job, model) => {
    const receipt = receipts[job];
    const from = receipt?.delivery ?? {};
    const base = { platform, target: model, version: from.version ?? version, build: from.build === undefined || from.build === null ? null : String(from.build), sha256: from.sha256 ?? null, verified: from.verified === true };
    if (ok(result(job))) return { delivery: base };
    let failure;
    if (broke(result(job))) failure = failureOf(job, result(job), receipt, 'install');
    else failure = (platform === 'ios' && exportFailure) || upstream || { job, stage: 'preflight', reason: `the ${job} job did not run` };
    return { delivery: { ...base, verified: false, stage: failure.stage, reason: failure.reason }, failure };
  };
  const lanes = [
    ...(scope.android ? [lane('android', 'android', devices.android.model)] : []),
    ...(scope.ios ? [lane('ios', 'ios', devices.ios.model)] : []),
  ];
  const planFailure = ok(result('plan')) ? null : (upstream || { job: 'plan', stage: 'preflight', reason: 'the plan job did not run' });
  const failure = planFailure || (scope.ios && exportFailure) || lanes.find(entry => entry.failure)?.failure || null;
  return { deliveries: lanes.map(entry => entry.delivery), failure };
}

export function deploymentEvent({ manifest, devices, scope, needs, receipts, version, androidCode, commit, env = process.env, now = new Date(), extras = [] }) {
  const { deliveries, failure } = deliveriesFrom({ scope, devices, needs, receipts, version });
  const target = targetOf(scope, devices);
  const single = deliveries.length === 1 ? deliveries[0] : null;
  const kind = scope.android && scope.ios ? 'mobile-app' : scope.android ? 'android-apk' : 'ios-app';
  const verified = deliveries.length > 0 && deliveries.every(delivery => delivery.verified === true);
  const label = `${manifest.project.name} v${version}${androidCode ? ` (${androidCode})` : ''}`;
  const data = {
    schema_version: 1,
    summary: '',
    project: { slug: manifest.project.slug, name: manifest.project.name },
    artifact: { kind, name: manifest.project.name, version, version_code: androidCode ? Number(androidCode) : null, commit, dirty: false, variant: 'debug', sha256: single?.sha256 ?? null },
    target,
    deliveries,
    run: { id: String(env.GITHUB_RUN_ID ?? '0'), attempt: Number(env.GITHUB_RUN_ATTEMPT ?? 1), url: env.GITHUB_RUN_ID ? `${env.GITHUB_SERVER_URL ?? 'https://github.com'}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}` : null, hub_ref: env.HUB_REF || null },
  };
  const stamp = now.toISOString().replace(/\.\d{3}Z$/, 'Z');
  if (failure) {
    data.summary = `${label} deploy to ${target.name} failed at ${failure.stage}: ${failure.reason}`.slice(0, 200);
    Object.assign(data, { stage: failure.stage, reason: failure.reason, failed_at: stamp });
    return { type: 'bloodbank.project.deployment.failed', data, failure };
  }
  data.summary = `${label} ${commit.slice(0, 7)} installed on ${target.name}${verified ? ', verified' : ''}${extras.length > 0 ? ` + ${extras.join(' + ')}` : ''}`.slice(0, 200);
  Object.assign(data, { verified, deployed_at: stamp });
  return { type: 'bloodbank.project.deployment.completed', data, failure: null };
}

export const bbEmitPath = (env = process.env, home = homedir()) => env.HUB_BB_EMIT || join(home, '.local/bin/bb-emit');

// bb-emit is a python script; run it with the system interpreter so a mise shim in the app checkout cannot break it.
function command(bin) {
  let first = '';
  try { first = readFileSync(bin, 'utf8').split('\n', 1)[0]; } catch { /* reported by the caller */ }
  return /python/.test(first) && existsSync('/usr/bin/python3') ? ['/usr/bin/python3', [bin]] : [bin, []];
}

export function emitArgs({ type, correlation, check }) {
  return ['--type', type, '--source', 'urn:33god:service:mobile-deploy-hub', '--producer', 'mobile-deploy-hub', '--service', 'mobile-deploy-hub', '--correlation', correlation, check ? '--check' : '--strict'];
}

// --check holds the envelope to its JSON Schema and publishes nothing; --strict publishes and fails on a dead bus.
export function bbEmit({ type, data, correlation, check, env = process.env, home = homedir(), runner = attempt }) {
  const bin = bbEmitPath(env, home);
  if (!existsSync(bin)) throw new Error(`bb-emit is not installed at ${bin}`);
  const [program, prefix] = command(bin);
  const clean = { ...env };
  for (const name of credentialVariables) delete clean[name];
  const result = runner(program, [...prefix, ...emitArgs({ type, correlation, check })], { env: clean, input: JSON.stringify(data), timeout: 30_000 });
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
