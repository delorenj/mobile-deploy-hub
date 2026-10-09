// The Xcode handoff from big-chungus to the Mac goes over the LAN, not through GitHub artifacts: artifact storage
// is 500 MB shared by every repo on the Free plan, and one ~100 MB Xcode project per run would fail the iOS lane on
// quota after the version was already bumped. The Linux job copies the tarballs to the Mac with scp (as Tower's
// tools/ios.mjs does); the receipts, which carry their sha256, still travel as a small artifact, so the Mac checks
// the LAN copy against what GitHub carried. A run's folder stays for "Re-run failed jobs" and is pruned after 3 days.
import { copyFileSync, existsSync, linkSync, mkdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { runBounded } from './exec.mjs';
import { sha256File } from './receipt.mjs';

const safe = /^[A-Za-z0-9._-]+$/;

// <owner>-<repo>/<run id>, relative to the handoff base on the Mac.
export function handoffFolder(env = process.env) {
  const [owner, repo] = (env.GITHUB_REPOSITORY ?? '').split('/');
  const run = env.GITHUB_RUN_ID ?? '';
  if (!safe.test(owner ?? '') || !safe.test(repo ?? '') || !/^\d+$/.test(run)) throw new Error('the handoff needs GITHUB_REPOSITORY and GITHUB_RUN_ID');
  return `${owner}-${repo}/${run}`;
}

const sshOptions = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15'];

export function sendArgs({ host, base, folder, files }) {
  const remote = `${base}/${folder}`;
  return {
    // Every value here is validated (host, a fixed base, owner/repo/run id), so the remote shell sees no input.
    prepare: [...sshOptions, host, `find '${base}' -mindepth 2 -maxdepth 2 -type d -mtime +3 -exec rm -rf {} + 2>/dev/null; mkdir -p '${remote}'`],
    copy: [...sshOptions, '-q', ...files, `${host}:${remote}/`],
  };
}

// Linux side: copy the tarballs (and their app receipts) to the Mac.
export function sendHandoff({ host, base, files, env = process.env, runner = runBounded, log = console.log }) {
  if (!safe.test(host)) throw new Error(`bad Mac host "${host}"`);
  if (!/^[A-Za-z0-9._/-]+$/.test(base) || base.startsWith('/') || base.split('/').includes('..')) throw new Error(`bad handoff base "${base}"`);
  for (const file of files) if (!safe.test(basename(file))) throw new Error(`bad handoff file name ${basename(file)}`);
  const folder = handoffFolder(env);
  const args = sendArgs({ host, base, folder, files });
  try {
    runner('ssh', args.prepare, { env, timeout: 60_000, label: `ssh ${host}` });
    runner('scp', args.copy, { env, timeout: 15 * 60_000, label: `scp to ${host}` });
  } catch (error) {
    throw new Error(`could not hand the Xcode project to ${host} over the LAN (ssh as the runner user, BatchMode): ${error.message.split('\n')[0]}`);
  }
  log(`HUB_HANDOFF_SENT ${files.map(file => basename(file)).join(' ')} -> ${host}:${base}/${folder}`);
  return `${base}/${folder}`;
}

// Mac side: find each file the Linux job sent, check it against the sha256 GitHub carried, copy it into `into`.
export async function receiveHandoff({ names, expected, base, into, env = process.env, home = homedir(), log = console.log }) {
  const folder = join(home, base, handoffFolder(env));
  mkdirSync(into, { recursive: true });
  for (const name of names) {
    const source = join(folder, name);
    if (!existsSync(source)) throw new Error(`${name} did not arrive in ~/${base}/${handoffFolder(env)} on this Mac; the ios-export job sends it over ssh from big-chungus`);
    const digest = await sha256File(source);
    if (!expected[name]) throw new Error(`no checksum for ${name} in the ios-export receipt`);
    if (digest !== expected[name]) throw new Error(`${name} on the Mac has sha256 ${digest}, the ios-export receipt says ${expected[name]}`);
    // A hard link when the runner's temp folder is on the same volume: the Mac's disk is nearly full.
    const target = join(into, name);
    rmSync(target, { force: true });
    try { linkSync(source, target); } catch { copyFileSync(source, target); }
  }
  log(`HUB_HANDOFF_RECEIVED ${names.join(' ')} (sha256 match the ios-export receipt)`);
}
