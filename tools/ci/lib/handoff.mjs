// The Xcode handoff from big-chungus to the Mac (Tower's Linux export). It never goes through GitHub artifacts (500 MB
// of shared quota on the Free plan), and since v1.1 it is a delta, because the Mac may be on a metered link:
//
// 1. Linux unpacks the export's tarball and rsyncs the tree (-z, --checksum, --delete) into a persistent cache on the
//    Mac, ~/Library/Caches/mobile-deploy-hub/handoff-cache/<owner>-<repo>/<stem>/. Only what changed crosses (mostly
//    the PCK; libgodot and MoltenVK do not change). `hosts:install` seeds the cache from a tarball already on the Mac.
// 2. Still inside the ios-export job (one per repo at a time), it clones that tree on the Mac into the run's folder,
//    handoff/<owner>-<repo>/<run>/<stem>.tree (APFS clonefile: instant and free), so a later run cannot change it.
// 3. The Mac's ios job checks the tree against tree_sha256, a sha256 over the sorted "sha256  path" lines that the
//    ios-export receipt carries (through GitHub, as before), and packs it back into the tarball the app's hook expects.
//
// If the tree delta fails, the fallbacks are Homebrew's rsync on the Mac when it exists, then the tarball itself sent
// with rsync against the previous one (the app writes it with sorted entries, a pinned mtime and gzip --rsyncable).
// Every transfer logs HUB_MAC_BYTES from rsync --stats, and the receipt keeps the numbers.
import { createHash } from 'node:crypto';
import { copyFileSync, createReadStream, existsSync, linkSync, lstatSync, mkdirSync, readdirSync, readlinkSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { runBounded } from './exec.mjs';
import { parseRsyncStats } from './metered.mjs';
import { sha256File } from './receipt.mjs';

const safe = /^[A-Za-z0-9._-]+$/;
const safePath = /^[A-Za-z0-9._/-]+$/;

// <owner>-<repo>/<run id>, relative to the handoff base on the Mac.
export function handoffFolder(env = process.env) {
  const [owner, repo] = (env.GITHUB_REPOSITORY ?? '').split('/');
  const run = env.GITHUB_RUN_ID ?? '';
  if (!safe.test(owner ?? '') || !safe.test(repo ?? '') || !/^\d+$/.test(run)) throw new Error('the handoff needs GITHUB_REPOSITORY and GITHUB_RUN_ID');
  return `${owner}-${repo}/${run}`;
}

export const repoFolder = env => handoffFolder(env).split('/')[0];
export const stemOf = archive => archive.replace(/\.tgz$/, '');

// Regular files and symlinks under dir, as sorted "sha256  path" lines (symlinks hash their target), and the sha256
// of those lines. The same function runs on both hosts, so the two digests agree byte for byte.
export async function treeDigest(dir) {
  const entries = [];
  const walk = relative => {
    for (const entry of readdirSync(join(dir, relative), { withFileTypes: true })) {
      const path = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() || entry.isSymbolicLink()) entries.push(path);
    }
  };
  walk('');
  entries.sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  const lines = [];
  let bytes = 0;
  for (const path of entries) {
    const full = join(dir, path);
    const info = lstatSync(full);
    if (info.isSymbolicLink()) {
      lines.push(`${createHash('sha256').update(`symlink:${readlinkSync(full)}`).digest('hex')}  ${path}`);
    } else {
      bytes += info.size;
      const hash = createHash('sha256');
      for await (const chunk of createReadStream(full)) hash.update(chunk);
      lines.push(`${hash.digest('hex')}  ${path}`);
    }
  }
  const text = lines.map(line => `${line}\n`).join('');
  return { sha256: createHash('sha256').update(text).digest('hex'), files: entries.length, bytes };
}

const sshOptions = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=30', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=4'];

// A Mac on a hotspot behind a DERP relay sometimes drops the first ssh banner exchange while tailscale finds a path:
// a connection step is tried three times before it counts as a failure.
export function retried(fn, { attempts = 3, log = () => {}, label = 'ssh' } = {}) {
  let last;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try { return fn(); } catch (error) {
      last = error;
      if (attempt < attempts) log(`HUB_MAC_RETRY ${label} (${attempt}/${attempts}): ${error.message.split('\n')[0].slice(0, 160)}`);
    }
  }
  throw last;
}
const sshCommand = `ssh ${sshOptions.join(' ')}`;

function check({ host, base, cache }) {
  if (!safe.test(host)) throw new Error(`bad Mac host "${host}"`);
  for (const path of [base, cache]) if (!safePath.test(path) || path.startsWith('/') || path.split('/').includes('..')) throw new Error(`bad handoff path "${path}"`);
}

function rsync(args, { env, runner, timeout = 30 * 60_000, label }) {
  const out = runner('rsync', ['--stats', '-e', sshCommand, ...args], { env, timeout, label });
  return parseRsyncStats(out);
}

// Linux side. archives: [{ name, tgz }] (the export's tarballs); receipts: small JSON files sent alongside.
export async function sendHandoffDelta({ host, base, cache, archives, receipts = [], unpackInto, env = process.env, runner = runBounded, log = console.log }) {
  check({ host, base, cache });
  for (const file of [...archives.map(item => item.tgz), ...receipts]) if (!safe.test(basename(file))) throw new Error(`bad handoff file name ${basename(file)}`);
  const folder = handoffFolder(env);
  const repo = repoFolder(env);
  const remoteRun = `${base}/${folder}`;
  const remoteCache = `${cache}/${repo}`;
  const total = { in: 0, out: 0 };
  const add = stats => { total.in += stats.sent ?? 0; total.out += stats.received ?? 0; };
  try {
    // Every value here is validated (host, fixed bases, owner/repo/run id), so the remote shell sees no input.
    retried(() => runner('ssh', [...sshOptions, host, `find '${base}' -mindepth 2 -maxdepth 2 -type d -mtime +3 -exec rm -rf {} + 2>/dev/null; mkdir -p '${remoteRun}' '${remoteCache}'`], { env, timeout: 90_000, label: `ssh ${host}` }), { log, label: `ssh ${host}` });
  } catch (error) {
    throw new Error(`could not reach ${host} for the Xcode handoff (ssh as the runner user, BatchMode): ${error.message.split('\n')[0]}`);
  }
  let homebrew = null;
  const results = [];
  for (const { name, tgz } of archives) {
    const stem = stemOf(name);
    const tree = join(unpackInto, `${stem}.tree`);
    rmSync(tree, { recursive: true, force: true });
    mkdirSync(tree, { recursive: true });
    runner('tar', ['-xzf', tgz, '-C', tree], { env, timeout: 10 * 60_000, label: `tar -x ${name}` });
    const digest = await treeDigest(tree);
    const attempt = rsyncPath => {
      add(rsync(['-rlpt', '-z', '--checksum', '--delete', ...(rsyncPath ? [`--rsync-path=${rsyncPath}`] : []), `${tree}/`, `${host}:${remoteCache}/${stem}/`], { env, runner, label: `rsync ${stem} to ${host}` }));
      runner('ssh', [...sshOptions, host, `rm -rf '${remoteRun}/${stem}.tree' && (cp -cR '${remoteCache}/${stem}' '${remoteRun}/${stem}.tree' 2>/dev/null || cp -R '${remoteCache}/${stem}' '${remoteRun}/${stem}.tree')`], { env, timeout: 10 * 60_000, label: `ssh ${host} clone ${stem}` });
    };
    let mode = 'tree';
    try {
      retried(() => attempt(null), { attempts: 2, log, label: `rsync ${stem}` });
    } catch (first) {
      log(`HUB_HANDOFF_FALLBACK ${stem}: the tree delta failed (${first.message.split('\n')[0].slice(0, 160)})`);
      if (homebrew === null) {
        try { homebrew = /yes/.test(runner('ssh', [...sshOptions, host, 'test -x /opt/homebrew/bin/rsync && echo yes || echo no'], { env, timeout: 60_000, label: `ssh ${host}` })); } catch { homebrew = false; }
      }
      try {
        if (!homebrew) throw first;
        attempt('/opt/homebrew/bin/rsync');
        mode = 'tree';
      } catch {
        // The tarball against the previous one: the app writes it sorted, mtime-pinned and gzip --rsyncable.
        add(rsync(['-t', '-z', tgz, `${host}:${remoteCache}/${name}`], { env, runner, label: `rsync ${name} to ${host}` }));
        runner('ssh', [...sshOptions, host, `rm -f '${remoteRun}/${name}' && (cp -c '${remoteCache}/${name}' '${remoteRun}/${name}' 2>/dev/null || cp '${remoteCache}/${name}' '${remoteRun}/${name}')`], { env, timeout: 10 * 60_000, label: `ssh ${host} clone ${name}` });
        mode = 'tgz';
      }
    }
    results.push({ name, mode, tree_sha256: digest.sha256, files: digest.files, bytes: digest.bytes });
    rmSync(tree, { recursive: true, force: true });
  }
  if (receipts.length > 0) add(retried(() => rsync(['-t', ...receipts, `${host}:${remoteRun}/`], { env, runner, label: `rsync receipts to ${host}` }), { log, label: 'rsync receipts' }));
  log(`HUB_MAC_BYTES in=${total.in} out=${total.out} (Xcode handoff to ${host})`);
  log(`HUB_HANDOFF_DELTA bytes=${total.in + total.out} ${results.map(item => `${item.name}=${item.mode}`).join(' ')} -> ${host}:${remoteRun}`);
  return { host, folder: remoteRun, archives: results, receipts: receipts.map(file => basename(file)), mac_bytes: total };
}

// Mac side: the run's folder holds a tree (checked against tree_sha256, then packed into the tarball the hook reads)
// or a tarball (checked against its sha256), and the receipts (checked against theirs). Everything lands in `into`.
export async function receiveHandoff({ names, expected, archives = [], base, into, env = process.env, home = homedir(), runner = runBounded, log = console.log }) {
  const folder = join(home, base, handoffFolder(env));
  mkdirSync(into, { recursive: true });
  const modes = Object.fromEntries(archives.map(item => [item.name, item]));
  for (const name of names) {
    const target = join(into, name);
    rmSync(target, { force: true });
    const archive = modes[name];
    if (archive?.mode === 'tree') {
      const tree = join(folder, `${stemOf(name)}.tree`);
      if (!existsSync(tree)) throw new Error(`${stemOf(name)}.tree did not arrive in ~/${base}/${handoffFolder(env)} on this Mac; the ios-export job sends it from big-chungus`);
      const digest = await treeDigest(tree);
      if (digest.sha256 !== archive.tree_sha256) throw new Error(`the ${stemOf(name)} tree on the Mac has tree_sha256 ${digest.sha256}, the ios-export receipt says ${archive.tree_sha256}`);
      runner('tar', ['-czf', target, '-C', tree, '.'], { env, timeout: 10 * 60_000, label: `tar -c ${name}` });
      continue;
    }
    const source = join(folder, name);
    if (!existsSync(source)) throw new Error(`${name} did not arrive in ~/${base}/${handoffFolder(env)} on this Mac; the ios-export job sends it over ssh from big-chungus`);
    const digest = await sha256File(source);
    if (!expected[name]) throw new Error(`no checksum for ${name} in the ios-export receipt`);
    if (digest !== expected[name]) throw new Error(`${name} on the Mac has sha256 ${digest}, the ios-export receipt says ${expected[name]}`);
    // A hard link when the runner's temp folder is on the same volume: the Mac's disk is nearly full.
    try { linkSync(source, target); } catch { copyFileSync(source, target); }
  }
  log(`HUB_HANDOFF_RECEIVED ${names.join(' ')} (${archives.some(item => item.mode === 'tree') ? 'tree_sha256 and ' : ''}sha256 match the ios-export receipt)`);
}
