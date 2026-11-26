#!/usr/bin/env node
// mise run hosts:install (design v1.1, C1, D, E1, F1, F2): the hosts' half of the hub, run on big-chungus. Idempotent.
//   - the build directory answers on the loopback port, and has an index (an empty one until the first deploy);
//   - the hub-mac ssh alias reaches the Mac (tailscale nc, on and off the LAN);
//   - the Mac's quickdrop .stignore holds /builds, so APKs never cross its link;
//   - the Mac's handoff cache is seeded from the newest handoff tarball already there (0 bytes over the link);
//   - each host's key (AD-47), `linux` on big-chungus and `mac` on the Mac, in ~/.config/mobile-deploy-hub/host-key, read back;
//   - the catch-up units, CATCHUP's tools/catchup/units/install.sh, on big-chungus and (through hub-mac) on the Mac;
//   - the Hub API on big-chungus (Story 6.11, AD-45): tools/hosts/units/install.sh renders its unit for this release, then the
//     service is enabled, restarted and /health read back (at most 10 s, one invocation) until it answers as this release;
//   - the Host Agent on the Mac (Story 9.7, AD-45): the same installer, run on the Mac over ssh, renders and bootstraps its
//     LaunchAgent (sh.delo.mobile-deploy-hub.host-agent) for this release, and its /health is read back through hub-client (at most
//     20 s) until it answers as this release;
//   - the two services agree: /health is read once from each, and the step fails when their `contract` or `hub_version` differ.
//     A release directory is never removed or replaced by any step: when releases/<ref> already exists on a host the installers run
//     from that copy (on the Mac it is copied only when missing, into <ref>.part and then moved), so a same-ref reinstall never
//     swaps the tree a running service reads. The services switch only at the installer's own restart or bootout and bootstrap.
// Writes to the bucket use the hub writer's keys from 1Password, as deliver does.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { accessFor } from './ci/lib/access.mjs';
import { loadDevices } from './ci/lib/devices.mjs';
import { latestKey, parseLatest } from './ci/lib/latest.mjs';
import { indexData, indexPage } from './ci/lib/pages.mjs';
import { pause, sleep as realSleep } from './ci/lib/pause.mjs';
import { loadPolicy } from './ci/lib/policy.mjs';
import { createS3, readObject, writerCredentials } from './ci/lib/s3.mjs';
import { HOST_KEY_FILE, HOST_PLATFORMS, hostKey as claimsHostKey } from './device/claims.mjs';
import { HOST_AGENT_SERVICE, HUB_API_CONTRACT, HUB_API_SERVICE, request } from './hub-client.mjs';

const hubRoot = fileURLToPath(new URL('..', import.meta.url));
const ssh = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=20'];

function sh(command, args, { input, timeout = 120_000 } = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', input, timeout, cwd: hubRoot });
  return { ok: !result.error && result.status === 0, out: `${result.stdout ?? ''}${result.stderr ?? ''}`.trim() };
}

export function releaseName(run = sh) {
  const tag = run('git', ['describe', '--exact-match', '--tags', '--match', 'v[0-9]*.[0-9]*.[0-9]*', 'HEAD']);
  if (tag.ok && /^v\d+\.\d+\.\d+$/.test(tag.out)) return tag.out;
  const head = run('git', ['rev-parse', '--short=7', 'HEAD']);
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

// The host key's writer (AD-47), run as `sh -s` here and over ssh on the Mac. The key is the host block being installed;
// `uname` only refuses to write `mac` onto a Linux box. Written through a `.part` rename, then printed back as a `HOST_KEY=<key>` line (ssh may add its own notices around it).
export function hostKeyScript(key) {
  if (!Object.hasOwn(HOST_PLATFORMS, key)) throw new Error(`hostKeyScript: unknown host key "${key}" (${Object.keys(HOST_PLATFORMS).join(', ')})`);
  const file = `$HOME/${HOST_KEY_FILE}`;
  return `set -e
platform=$(uname -s | tr 'A-Z' 'a-z')
[ "$platform" = '${HOST_PLATFORMS[key]}' ] || { echo "host-key: '${key}' is a ${HOST_PLATFORMS[key]} host but this is $platform" >&2; exit 1; }
mkdir -p "$(dirname "${file}")"
printf '%s\\n' '${key}' > "${file}.part"
mv "${file}.part" "${file}"
printf 'HOST_KEY=%s\\n' "$(cat "${file}")"
`;
}

export const HUB_API_UNIT = 'mobile-deploy-hub-api.service';
export const HOST_AGENT_LABEL = 'sh.delo.mobile-deploy-hub.host-agent';
export const HOST_AGENT_ERR_LOG = '~/Library/Logs/mobile-deploy-hub/host-agent.err.log';
export const READBACK_MS = 10_000;
export const AGENT_READBACK_MS = 20_000;
export const AGREE_MS = 10_000;
const READBACK_RETRY_MS = 500;
const releasesDir = home => join(home, '.local/share/mobile-deploy-hub/releases');

// One line for why a read failed: a transport's cause code, a host that did not answer (`reason: detail`), or the error's own first line.
const whyOf = error => String(error?.cause?.code ?? (error?.reason ? `${error.reason}: ${error.message}` : error?.message ?? error)).split('\n')[0];

// The one /health readback, for either service: `read(signal)` makes one attempt and returns a `Response` (a loopback `fetch`, or `request` for the
// other host). Retried in this one call, within `windowMs` by the injected clock (AD-19: no timer outlives it), each attempt bounded by an abort
// signal of `attemptMs` and never past the deadline; no attempt starts after the deadline. An answer is `ok`, `service` the one named, `hub_version`
// equal to `ref` and `contract` equal to HUB_API_CONTRACT. `onWait(last)` hears each miss. Returns `{body}` for an answer, `{last}` (why the final attempt
// missed) for none.
async function readBack({ read, service, ref, windowMs, attemptMs = 2000, sleep, now, onWait = () => {} }) {
  const deadline = now() + windowMs;
  let last = 'no answer';
  for (;;) {
    try {
      const response = await read(AbortSignal.timeout(Math.max(1, Math.min(attemptMs, deadline - now()))));
      const body = response.ok ? await response.json() : null;
      if (body?.ok === true && body.service === service && body.hub_version === ref && body.contract === HUB_API_CONTRACT) return { body };
      last = body ? `hub_version ${body.hub_version ?? 'missing'}, service ${body.service ?? 'missing'}, contract ${body.contract ?? 'missing'}` : `HTTP ${response.status}`;
    } catch (error) {
      last = whyOf(error);
    }
    onWait(last);
    if (now() >= deadline) break;
    await pause(READBACK_RETRY_MS, { sleep });
    if (now() >= deadline) break;
  }
  return { last };
}

// The Hub API on this host (Story 6.11): the units installer from the release copy (rendered unit + daemon-reload only), then
// enable, restart, and a bounded readback of /health: ok, service HUB_API_SERVICE (the name the server answers with) and hub_version equal to `ref` and `contract` equal to HUB_API_CONTRACT (the service runs from
// releases/<ref>, so its answer names the release). The retry is one loop in this call, within READBACK_MS (see `readBack`).
// Returns a one-line summary or throws.
export async function installHubApi({ ref, run = sh, fetchImpl = fetch, sleep = realSleep, now = Date.now, home = homedir(), port, log = () => {} } = {}) {
  const installer = join(releasesDir(home), ref, 'tools/hosts/units/install.sh');
  if (!existsSync(installer)) throw new Error(`release copy missing: ${installer} (the catch-up step puts releases/${ref} there)`);
  const installed = run('bash', [installer, ref], { timeout: 2 * 60_000 });
  if (!installed.ok) throw new Error(installed.out.slice(-300));
  for (const verb of ['enable', 'restart']) {
    const result = run('systemctl', ['--user', verb, HUB_API_UNIT], { timeout: 2 * 60_000 });
    if (!result.ok) throw new Error(`systemctl --user ${verb} ${HUB_API_UNIT}: ${result.out.slice(-200)}`);
  }
  const read = signal => fetchImpl(`http://127.0.0.1:${port}/health`, { signal, headers: { 'Cache-Control': 'no-cache' } });
  const { body, last } = await readBack({ read, service: HUB_API_SERVICE, ref, windowMs: READBACK_MS, sleep, now, onWait: why => log(`HOSTS hub api: not ready yet (${why})`) });
  if (body) return `${ref} serves 127.0.0.1:${port}, contract ${body.contract} (${installed.out.split('\n').slice(-1)[0]})`;
  throw new Error(`/health on 127.0.0.1:${port} did not report ${HUB_API_SERVICE} ${ref} within ${READBACK_MS / 1000}s (last: ${last}); see journalctl --user -u ${HUB_API_UNIT}`);
}

// The Host Agent on the Mac (Story 9.7): the units installer from the Mac's release copy, run there over ssh (it renders the LaunchAgent and
// bootstraps it into the GUI session), then /health read back through `hub-client` `request` until the agent answers as this release (`readBack`,
// AGENT_READBACK_MS). `seams` are `request`'s (policy, devices, hostKey, fetchImpl, sshImpl, timers). Returns a one-line summary or throws.
export async function installHostAgent({ ref, host, run = sh, seams = {}, sleep = realSleep, now = Date.now, port, log = () => {} } = {}) {
  const installed = run('ssh', [...ssh, host, `bash '.local/share/mobile-deploy-hub/releases/${ref}/tools/hosts/units/install.sh' '${ref}'`], { timeout: 2 * 60_000 });
  if (!installed.ok) throw new Error(installed.out.slice(-300));
  const read = signal => request({ host: 'mac', path: '/health', signal }, seams);
  const { body, last } = await readBack({ read, service: HOST_AGENT_SERVICE, ref, windowMs: AGENT_READBACK_MS, attemptMs: 8000, sleep, now, onWait: why => log(`HOSTS host agent: not ready yet (${why})`) });
  if (body) return `${ref} serves 127.0.0.1:${port} on mac, contract ${body.contract} (${installed.out.split('\n').slice(-1)[0]})`;
  throw new Error(`/health on the Mac (127.0.0.1:${port}, through ssh ${host}) did not report ${HOST_AGENT_SERVICE} ${ref} within ${AGENT_READBACK_MS / 1000}s (last: ${last}); see ${HOST_AGENT_ERR_LOG} on the Mac`);
}

// The two services run one release: /health read once from each, through `request` (a loopback fetch for this host's own service, ssh for the other's,
// so the same check works from either host), each bounded at AGREE_MS. Each must name its own service; `contract` and `hub_version` must be equal.
export async function servicesAgree({ seams = {} } = {}) {
  const services = { linux: HUB_API_SERVICE, mac: HOST_AGENT_SERVICE };
  const read = async host => {
    try {
      const response = await request({ host, path: '/health', signal: AbortSignal.timeout(AGREE_MS) }, seams);
      const body = response.ok ? await response.json() : null;
      if (!body) return { host, problem: `HTTP ${response.status}` };
      if (body.ok !== true || body.service !== services[host]) return { host, problem: `answered ok ${body.ok}, service ${body.service ?? 'missing'}, not ${services[host]}` };
      return { host, body };
    } catch (error) {
      return { host, problem: whyOf(error) };
    }
  };
  const answers = await Promise.all(Object.keys(services).map(read));
  const missing = answers.filter(answer => !answer.body);
  if (missing.length > 0) throw new Error(missing.map(answer => `${answer.host} did not give a ${services[answer.host]} /health (${answer.problem})`).join('; '));
  const [first, second] = answers;
  const differ = ['contract', 'hub_version'].filter(key => first.body[key] !== second.body[key]);
  if (differ.length > 0) throw new Error(`${differ.map(key => `${key} ${first.body[key] ?? 'missing'} on ${first.host} but ${second.body[key] ?? 'missing'} on ${second.host}`).join('; ')}; the two services must run one release`);
  return `contract ${first.body.contract}, hub_version ${first.body.hub_version} on ${first.host} and ${second.host}`;
}

export async function hostsInstall({ log = console.log, run = sh, fetchImpl = fetch, sleep = realSleep, now = Date.now, home = homedir(), credentials = writerCredentials, sshImpl, hostKey = () => claimsHostKey({ home }), timers } = {}) {
  const { policy } = loadPolicy();
  const devices = loadDevices();
  const failures = [];
  const step = async (name, fn) => {
    try { log(`HOSTS ${name}: ${await fn()}`); } catch (error) { failures.push(name); log(`HOSTS_FAILED ${name}: ${error.message.split('\n')[0]}`); }
  };
  const ref = releaseName(run);
  const host = devices.mac.host;
  // The seams `request` takes (hub-client): the Mac is reached over ssh, this host's own service by a loopback fetch.
  const seams = { policy, devices, hostKey, fetchImpl, ...(sshImpl ? { sshImpl } : {}), ...(timers ? { timers } : {}) };

  await step('build directory', async () => {
    const health = await fetchImpl(`${policy.delivery.s3.write}/minio/health/live`, { signal: AbortSignal.timeout(10_000) });
    if (!health.ok) throw new Error(`MinIO on ${policy.delivery.s3.write} answered ${health.status}`);
    // MOBI-17: the pointers of a private app are not anonymous, so the hub reads them with the writer's keys.
    const keys = await credentials();
    const existing = await readObject(policy, 'index.html', { credentials: keys, fetchImpl });
    if (existing) return `${policy.delivery.s3.public}/index.html exists`;
    const apps = [];
    for (const app of Object.values(policy.apps)) {
      const text = await readObject(policy, latestKey(app.slug), { credentials: keys, fetchImpl });
      if (text) apps.push(parseLatest(text, { slug: app.slug }));
    }
    const s3 = createS3({ policy, credentials: keys });
    const access = slug => accessFor(policy, slug);
    s3.putText(`${JSON.stringify(indexData(apps, { access }), null, 2)}\n`, 'index.json');
    s3.putText(indexPage(apps, { access }), 'index.html');
    return `rendered ${policy.delivery.s3.public}/index.html (${apps.length} apps)`;
  });

  await step('hub-mac', async () => {
    const result = run('ssh', [...ssh, host, 'echo ok']);
    if (!result.ok || !/\bok\b/.test(result.out)) throw new Error(`ssh ${host} failed: ${result.out.slice(-200)} (add the alias: Host ${host}, ProxyCommand tailscale nc ${devices.mac.peer} %p)`);
    return `ssh ${host} reaches ${devices.mac.peer}`;
  });

  const writeKey = async (where, key, command, args) => {
    const result = run(command, args, { input: hostKeyScript(key) });
    if (!result.ok) throw new Error(result.out.slice(-200));
    const back = result.out.split('\n').map(line => /^HOST_KEY=(.*)$/.exec(line.trim())?.[1]).filter(value => value !== undefined).at(-1);
    if (back !== key) throw new Error(`read back ${back === undefined ? 'nothing' : `"${back.slice(-40)}"`}, not "${key}"`);
    return `${where} is "${key}" (${HOST_KEY_FILE})`;
  };
  await step('host key on big-chungus', () => writeKey('big-chungus', 'linux', 'sh', ['-s']));
  await step('host key on the Mac', () => writeKey(host, 'mac', 'ssh', [...ssh, host, 'sh -s']));

  await step('quickdrop .stignore', async () => {
    const result = run('ssh', [...ssh, host, 'f="$HOME/quickdrop/.stignore"; [ -d "$HOME/quickdrop" ] || { echo "no quickdrop folder"; exit 0; }; touch "$f"; grep -qx "/builds" "$f" || printf "%s\\n" "// mobile-deploy-hub APKs stay off this Mac (often on a metered link)." "/builds" >> "$f"; grep -c "^/builds$" "$f"']);
    if (!result.ok) throw new Error(result.out.slice(-200));
    return `the Mac's quickdrop ignores /builds (${result.out.split('\n').pop()})`;
  });

  await step('handoff cache', async () => {
    const result = run('ssh', [...ssh, host, 'bash -s'], { input: seedScript({ base: devices.mac.handoff_dir, cache: devices.mac.handoff_cache }), timeout: 15 * 60_000 });
    if (!result.ok) throw new Error(result.out.slice(-300));
    return result.out.split('\n').join('; ') || 'nothing to seed';
  });

  // The release copy when it already exists: the installer replaces releases/<ref> whenever it runs from another tree, and a
  // running Hub API reads its code from there.
  const checkoutInstaller = resolve(hubRoot, 'tools/catchup/units/install.sh');
  const releaseInstaller = join(releasesDir(home), ref, 'tools/catchup/units/install.sh');
  const installer = existsSync(releaseInstaller) ? releaseInstaller : checkoutInstaller;
  if (!existsSync(installer)) {
    log('HOSTS catch-up: tools/catchup/units/install.sh is not in this checkout yet (CATCHUP); skipped');
  } else {
    await step('catch-up on big-chungus', async () => {
      const result = run('bash', [installer, ref], { timeout: 5 * 60_000 });
      if (!result.ok) throw new Error(result.out.slice(-300));
      return `${ref}: ${result.out.split('\n').slice(-2).join('; ')}`;
    });
  }
  // Always runs, after the big-chungus catch-up step (which puts releases/<ref> in place): a missing release copy fails loudly here.
  await step('hub api on big-chungus', () => installHubApi({ ref, run, fetchImpl, sleep, now, home, port: policy.api.hub_api_port, log }));
  if (existsSync(installer)) {
    await step('catch-up on the Mac', async () => {
      const release = `.local/share/mobile-deploy-hub/releases/${ref}`;
      // The Mac's release copy is made only when it is missing: a running Host Agent reads its code from there, and rsync --delete into
      // that tree can remove a module it imports later. A new copy is built beside it (<ref>.part) and moved in.
      const probe = run('ssh', [...ssh, host, `if [ -e '${release}/tools' ]; then echo RELEASE_PRESENT; else echo RELEASE_MISSING; fi`]);
      if (!probe.ok) throw new Error(probe.out.slice(-200));
      let copied = 'release copy already on the Mac, not copied';
      if (!/\bRELEASE_PRESENT\b/.test(probe.out)) {
        const mk = run('ssh', [...ssh, host, `mkdir -p '${release}.part/tools'`]);
        if (!mk.ok) throw new Error(mk.out.slice(-200));
        const copy = run('rsync', ['-az', '--delete', '--stats', '-e', `ssh ${ssh.join(' ')}`, `${resolve(hubRoot, 'tools')}/`, `${host}:${release}.part/tools/`], { timeout: 10 * 60_000 });
        if (!copy.ok) throw new Error(copy.out.slice(-300));
        const move = run('ssh', [...ssh, host, `[ -e '${release}' ] || mv '${release}.part' '${release}'`]);
        if (!move.ok) throw new Error(move.out.slice(-200));
        copied = `${/Total bytes sent:\s*([\d,]+)/.exec(copy.out)?.[1] ?? '?'} bytes sent`;
      }
      const install = run('ssh', [...ssh, host, `bash '${release}/tools/catchup/units/install.sh' '${ref}'`], { timeout: 5 * 60_000 });
      if (!install.ok) throw new Error(install.out.slice(-300));
      return `${ref} (${copied}): ${install.out.split('\n').slice(-2).join('; ')}`;
    });
  }
  // Always run: a Mac with no release copy fails loudly here (the installer is not there), and the agreement step reports what it can read.
  await step('host agent on the Mac', () => installHostAgent({ ref, host, run, seams, sleep, now, port: policy.api.host_agent_port, log }));
  await step('services agree', () => servicesAgree({ seams }));
  if (failures.length > 0) throw new Error(`hosts:install: ${failures.join(', ')} failed`);
  log(`HOSTS_OK ${ref}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  hostsInstall().catch(error => { console.error(`::error::${error.message}`); process.exitCode = 1; });
}
