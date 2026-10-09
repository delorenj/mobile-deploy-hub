#!/usr/bin/env node
// mise run hosts:install (design v1.1, C1, D, E1, F1, F2): the hosts' half of the hub, run on big-chungus. Idempotent.
//   - the build directory answers on the loopback port, and has an index (an empty one until the first deploy);
//   - the hub-mac ssh alias reaches the Mac (tailscale nc, on and off the LAN);
//   - the Mac's quickdrop .stignore holds /builds, so APKs never cross its link;
//   - the Mac's handoff cache is seeded from the newest handoff tarball already there (0 bytes over the link);
//   - the catch-up units, CATCHUP's tools/catchup/units/install.sh, on big-chungus and (through hub-mac) on the Mac.
// Writes to the bucket use the hub writer's keys from 1Password, as deliver does.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDevices } from './ci/lib/devices.mjs';
import { latestKey, parseLatest } from './ci/lib/latest.mjs';
import { indexData, indexPage } from './ci/lib/pages.mjs';
import { loadPolicy } from './ci/lib/policy.mjs';
import { createS3, readObject, writerCredentials } from './ci/lib/s3.mjs';

const hubRoot = fileURLToPath(new URL('..', import.meta.url));
const ssh = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=20'];

function sh(command, args, { input, timeout = 120_000 } = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', input, timeout, cwd: hubRoot });
  return { ok: !result.error && result.status === 0, out: `${result.stdout ?? ''}${result.stderr ?? ''}`.trim() };
}

export function releaseName() {
  const tag = sh('git', ['describe', '--exact-match', '--tags', '--match', 'v[0-9]*.[0-9]*.[0-9]*', 'HEAD']);
  if (tag.ok && /^v\d+\.\d+\.\d+$/.test(tag.out)) return tag.out;
  const head = sh('git', ['rev-parse', '--short=7', 'HEAD']);
  return `main-${head.out}`;
}

// The Mac side of the seed: for each app folder, the newest run's tarballs unpacked into the cache, and kept beside
// it as the basis for the tarball fallback. Only where the cache is still empty.
export function seedScript({ base, cache }) {
  return `set -e
cd "$HOME"
[ -d '${base}' ] || { echo "seed: no handoff folder yet"; exit 0; }
for repo in '${base}'/*/; do
  repo=\${repo%/}; name=\${repo##*/}
  newest=$(ls -1t "$repo" 2>/dev/null | head -n 1)
  [ -n "$newest" ] || continue
  for tgz in "$repo/$newest"/*.tgz; do
    [ -f "$tgz" ] || continue
    file=\${tgz##*/}; stem=\${file%.tgz}
    dest='${cache}'/"$name"/"$stem"
    if [ -d "$dest" ] && [ -n "$(ls -A "$dest")" ]; then echo "seed: $name/$stem already cached"; continue; fi
    mkdir -p "$dest"
    tar -xzf "$tgz" -C "$dest"
    cp -c "$tgz" '${cache}'/"$name"/"$file" 2>/dev/null || cp "$tgz" '${cache}'/"$name"/"$file"
    echo "seed: $name/$stem from $newest ($(du -sh "$dest" | cut -f1))"
  done
done`;
}

export async function hostsInstall({ log = console.log } = {}) {
  const { policy } = loadPolicy();
  const devices = loadDevices();
  const failures = [];
  const step = async (name, fn) => {
    try { log(`HOSTS ${name}: ${await fn()}`); } catch (error) { failures.push(name); log(`HOSTS_FAILED ${name}: ${error.message.split('\n')[0]}`); }
  };
  const ref = releaseName();
  const host = devices.mac.host;

  await step('build directory', async () => {
    const health = await fetch(`${policy.delivery.s3.write}/minio/health/live`, { signal: AbortSignal.timeout(10_000) });
    if (!health.ok) throw new Error(`MinIO on ${policy.delivery.s3.write} answered ${health.status}`);
    const existing = await readObject(policy, 'index.html');
    if (existing) return `${policy.delivery.s3.public}/index.html exists`;
    const apps = [];
    for (const app of Object.values(policy.apps)) {
      const text = await readObject(policy, latestKey(app.slug));
      if (text) apps.push(parseLatest(text, { slug: app.slug }));
    }
    const s3 = createS3({ policy, credentials: await writerCredentials() });
    s3.putText(`${JSON.stringify(indexData(apps), null, 2)}\n`, 'index.json');
    s3.putText(indexPage(apps), 'index.html');
    return `rendered ${policy.delivery.s3.public}/index.html (${apps.length} apps)`;
  });

  await step('hub-mac', async () => {
    const result = sh('ssh', [...ssh, host, 'echo ok']);
    if (!result.ok || !/\bok\b/.test(result.out)) throw new Error(`ssh ${host} failed: ${result.out.slice(-200)} (add the alias: Host ${host}, ProxyCommand tailscale nc ${devices.mac.peer} %p)`);
    return `ssh ${host} reaches ${devices.mac.peer}`;
  });

  await step('quickdrop .stignore', async () => {
    const result = sh('ssh', [...ssh, host, 'f="$HOME/quickdrop/.stignore"; [ -d "$HOME/quickdrop" ] || { echo "no quickdrop folder"; exit 0; }; touch "$f"; grep -qx "/builds" "$f" || printf "%s\\n" "// mobile-deploy-hub APKs stay off this Mac (often on a metered link)." "/builds" >> "$f"; grep -c "^/builds$" "$f"']);
    if (!result.ok) throw new Error(result.out.slice(-200));
    return `the Mac's quickdrop ignores /builds (${result.out.split('\n').pop()})`;
  });

  await step('handoff cache', async () => {
    const result = sh('ssh', [...ssh, host, 'bash -s'], { input: seedScript({ base: devices.mac.handoff_dir, cache: devices.mac.handoff_cache }), timeout: 15 * 60_000 });
    if (!result.ok) throw new Error(result.out.slice(-300));
    return result.out.split('\n').join('; ') || 'nothing to seed';
  });

  const installer = resolve(hubRoot, 'tools/catchup/units/install.sh');
  if (!existsSync(installer)) {
    log('HOSTS catch-up: tools/catchup/units/install.sh is not in this checkout yet (CATCHUP); skipped');
  } else {
    await step('catch-up on big-chungus', async () => {
      const result = sh('bash', [installer, ref], { timeout: 5 * 60_000 });
      if (!result.ok) throw new Error(result.out.slice(-300));
      return `${ref}: ${result.out.split('\n').slice(-2).join('; ')}`;
    });
    await step('catch-up on the Mac', async () => {
      const target = `.local/share/mobile-deploy-hub/releases/${ref}/tools/`;
      const mk = sh('ssh', [...ssh, host, `mkdir -p '${target}'`]);
      if (!mk.ok) throw new Error(mk.out.slice(-200));
      const copy = sh('rsync', ['-az', '--delete', '--stats', '-e', `ssh ${ssh.join(' ')}`, `${resolve(hubRoot, 'tools')}/`, `${host}:${target}`], { timeout: 10 * 60_000 });
      if (!copy.ok) throw new Error(copy.out.slice(-300));
      const sent = /Total bytes sent:\s*([\d,]+)/.exec(copy.out)?.[1] ?? '?';
      const install = sh('ssh', [...ssh, host, `bash '.local/share/mobile-deploy-hub/releases/${ref}/tools/catchup/units/install.sh' '${ref}'`], { timeout: 5 * 60_000 });
      if (!install.ok) throw new Error(install.out.slice(-300));
      return `${ref} (${sent} bytes sent): ${install.out.split('\n').slice(-2).join('; ')}`;
    });
  }
  if (failures.length > 0) throw new Error(`hosts:install: ${failures.join(', ')} failed`);
  log(`HOSTS_OK ${ref}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  hostsInstall().catch(error => { console.error(`::error::${error.message}`); process.exitCode = 1; });
}
