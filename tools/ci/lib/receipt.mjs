// Receipts. Each lane writes hub-receipt-<lane>.json next to its artifacts and into the step summary.
// A receipt holds identity and checksums only: never a token, a key or a credential value.
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export async function sha256File(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

// The ref the runner fetched the hub at, so a Release or a TestFlight build traces back to the code that made it.
// The composite action passes github.action_ref as HUB_REF; the runner's own layout names it too
// (_actions/<owner>/<repo>/<ref>/tools/ci/lib/receipt.mjs). `main` is bring-up only, a tag is what a real run should show.
export function hubRef(env = process.env, file = fileURLToPath(import.meta.url)) {
  if (env.HUB_REF) return env.HUB_REF;
  return /[\\/]_actions[\\/][^\\/]+[\\/][^\\/]+[\\/]([^\\/]+)[\\/]tools[\\/]ci[\\/]lib[\\/]receipt\.mjs$/.exec(file)?.[1] ?? null;
}

export function buildReceipt({ lane, config, env = process.env, version, androidCode, build, artifacts = [], signer, notes = [] }) {
  return {
    schema: 1,
    lane,
    repo: env.GITHUB_REPOSITORY ?? null,
    sha: env.GITHUB_SHA ?? null,
    ref: env.GITHUB_REF ?? null,
    run_id: env.GITHUB_RUN_ID ?? null,
    run_attempt: env.GITHUB_RUN_ATTEMPT ?? null,
    dry_run: config.dryRun,
    channel: config.channel,
    hub_ref: hubRef(env),
    version: version ?? null,
    android_code: androidCode ?? null,
    build: build ?? null,
    artifacts,
    signer: signer ?? null,
    notes,
    created_at: new Date().toISOString(),
  };
}

export function summaryMarkdown(receipt) {
  const rows = [
    ['lane', receipt.lane], ['dry run', receipt.dry_run], ['hub ref', receipt.hub_ref], ['version', receipt.version], ['android code', receipt.android_code],
    ['build', receipt.build], ['sha', receipt.sha], ['run', receipt.run_id], ['signer', receipt.signer],
  ].filter(([, value]) => value !== null && value !== undefined && value !== '');
  const lines = [`### Hub receipt: ${receipt.lane}`, '', '| field | value |', '|---|---|', ...rows.map(([key, value]) => `| ${key} | \`${value}\` |`)];
  if (receipt.artifacts.length > 0) lines.push('', '| artifact | sha256 |', '|---|---|', ...receipt.artifacts.map(item => `| ${item.name} | \`${item.sha256}\` |`));
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
