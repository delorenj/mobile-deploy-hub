// Receipts. Each lane writes hub-receipt-<lane>.json next to its artifacts and into the step summary, on success and
// on failure (stage and a one-line reason), and the workflow uploads them with if: always(). A receipt holds identity
// and checksums only: never a token, a key or a credential value.
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { busyReason } from './latest.mjs';
import { loadPolicy } from './policy.mjs';

export async function sha256File(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

// The ref the runner fetched the hub at, so a Release or a TestFlight build traces back to the code that made it.
// The composite action passes github.action_ref as HUB_REF; the runner's own layout names it too
// (_actions/<owner>/<repo>/<ref>/tools/ci/lib/receipt.mjs). `main` is bring-up only, a tag is what a real run should show.
// The catch-up and hub-device run from an installed release (~/.local/share/mobile-deploy-hub/releases/<ref>/tools/...),
// which names its ref the same way (AD-10). This is the one hub-version resolver: the Event Log imports it, and nothing
// reads the app's version for it. Order: HUB_REF, the _actions path, the release-dir name, null.
const actionsLayout = /[\\/]_actions[\\/][^\\/]+[\\/][^\\/]+[\\/]([^\\/]+)[\\/]tools[\\/]ci[\\/]lib[\\/]receipt\.mjs$/;
const releaseLayout = /[\\/]mobile-deploy-hub[\\/]releases[\\/]([^\\/]+)[\\/]tools[\\/]ci[\\/]lib[\\/]receipt\.mjs$/;
export function hubRef(env = process.env, file = fileURLToPath(import.meta.url)) {
  if (env.HUB_REF) return env.HUB_REF;
  return actionsLayout.exec(file)?.[1] ?? releaseLayout.exec(file)?.[1] ?? null;
}

// The digest of the policy this hub ran with, recorded in every receipt (design v1.1, A1).
let digest;
export function policyDigest() {
  if (digest === undefined) { try { digest = loadPolicy().sha256; } catch { digest = null; } }
  return digest;
}

// sha is the commit the lane built: the bump commit on a real v3 run, else the dispatched commit.
export function buildReceipt({ lane, config, env = process.env, version, androidCode, build, artifacts = [], signer, notes = [], outcome = 'success', stage, reason, ...extra }) {
  return {
    schema: 1,
    lane,
    repo: env.GITHUB_REPOSITORY ?? null,
    sha: config.buildSha || env.GITHUB_SHA || null,
    dispatch_sha: env.GITHUB_SHA ?? null,
    ref: env.GITHUB_REF ?? null,
    run_id: env.GITHUB_RUN_ID ?? null,
    run_attempt: env.GITHUB_RUN_ATTEMPT ?? null,
    dry_run: config.dryRun,
    channel: config.channel,
    hub_ref: hubRef(env),
    policy: policyDigest(),
    outcome,
    ...(stage ? { stage } : {}),
    ...(reason ? { reason } : {}),
    version: version ?? null,
    android_code: androidCode ?? null,
    build: build ?? null,
    artifacts,
    signer: signer ?? null,
    notes,
    ...extra,
    created_at: new Date().toISOString(),
  };
}

// The one public wording of a lane receipt's `reason` (AD-22). A lane whose failure was a device wait that ran out keeps the
// lock's own message (it names the holder and the waiters ahead) in its receipt, the job summary and the log; every public copy
// (the bucket receipts, the Bloodbank event) says only which lock was busy. Keyed on the AD-5 message prefix, so a lane that
// recorded `contention` and then failed for another reason keeps that reason.
export function publicReason(receipt) {
  const lock = receipt?.contention?.lock;
  if (typeof lock === 'string' && lock !== '' && typeof receipt.reason === 'string' && receipt.reason.startsWith(`host lock ${lock} is held`)) {
    return `${busyReason(lock)}: the wait for it ran out (HUB_LOCK_TIMEOUT); the run summary names who held it`;
  }
  return receipt?.reason;
}

export function summaryMarkdown(receipt) {
  const rows = [
    ['lane', receipt.lane], ['outcome', receipt.outcome], ['stage', receipt.stage], ['reason', receipt.reason], ['dry run', receipt.dry_run], ['hub ref', receipt.hub_ref],
    ['version', receipt.version], ['android code', receipt.android_code], ['build', receipt.build], ['sha', receipt.sha], ['run', receipt.run_id], ['signer', receipt.signer],
  ].filter(([, value]) => value !== null && value !== undefined && value !== '');
  const lines = [`### Hub receipt: ${receipt.lane}`, '', '| field | value |', '|---|---|', ...rows.map(([key, value]) => `| ${key} | \`${String(value).replaceAll('|', '/').replaceAll('`', "'")}\` |`)];
  if (receipt.artifacts.length > 0) lines.push('', '| artifact | sha256 |', '|---|---|', ...receipt.artifacts.map(item => `| ${item.name} | \`${item.sha256}\` |`));
  if (receipt.delivery) {
    const d = receipt.delivery;
    lines.push('', `- delivery: ${d.platform} ${d.target} ${d.version ?? '-'} (${d.build ?? '-'}) ${d.verified ? 'verified' : 'not verified'}${d.note ? `: ${d.note}` : ''}`);
  }
  if (receipt.contention) {
    const c = receipt.contention;
    const holds = (c.blocked_by ?? []).map(hold => `${hold.role} ${hold.kind ?? '-'} ${hold.holder ?? hold.lease_id ?? '-'}${hold.until ? ` until ${hold.until}` : ''}`);
    lines.push('', `- contention on ${c.lock} (${c.reason}): ${holds.length > 0 ? holds.join('; ') : 'no holder named'}`);
  }
  for (const note of receipt.notes) lines.push('', `- ${note}`);
  return `${lines.join('\n')}\n`;
}

export async function writeReceipt(dir, receipt, env = process.env) {
  await mkdir(dir, { recursive: true });
  const file = join(dir, `hub-receipt-${receipt.lane}.json`);
  await writeFile(file, JSON.stringify(receipt, null, 2) + '\n');
  if (env.GITHUB_STEP_SUMMARY) await appendFile(env.GITHUB_STEP_SUMMARY, summaryMarkdown(receipt));
  return file;
}

// Appends key=value lines to $GITHUB_OUTPUT. A value with a newline would forge a second output.
export async function setOutputs(values, env = process.env) {
  const lines = Object.entries(values).map(([key, value]) => {
    const text = String(value ?? '');
    if (/[\r\n]/.test(text)) throw new Error(`output ${key} contains a line break`);
    return `${key}=${text}`;
  });
  if (env.GITHUB_OUTPUT) await appendFile(env.GITHUB_OUTPUT, lines.join('\n') + '\n');
  return lines;
}
