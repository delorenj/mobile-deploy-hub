// The Mac's link (design v1.1, F1). The gate reads `tailscale status --json` on big-chungus and finds the Mac's peer:
// offline when tailscale says so, when this app's own runner process is missing (checked over the hub-mac ssh alias, a
// few hundred bytes), when GitHub shows that runner offline, or when the ssh got no answer on a link that is not the
// LAN; home when its current address is inside the LAN; metered for anything else (another network, a phone hotspot,
// a DERP relay). Three runners share the one Mac and only an app's own runner takes its jobs, so a live process of
// another app's runner proves nothing. Accepted blind spot: a remote network that also uses the LAN's range reads as
// home.
import { runBounded } from './exec.mjs';

export function ipv4(text) {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text ?? '');
  if (!match) return null;
  const parts = match.slice(1).map(Number);
  if (parts.some(part => part > 255)) return null;
  return ((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3];
}

export function inCidr(ip, cidr) {
  const [base, bits] = cidr.split('/');
  const address = ipv4(ip);
  const network = ipv4(base);
  const width = Number(bits);
  if (address === null || network === null || !(width >= 0 && width <= 32)) return false;
  const mask = width === 0 ? 0 : (0xffffffff << (32 - width)) >>> 0;
  return ((address & mask) >>> 0) === ((network & mask) >>> 0);
}

// "76.98.73.87:11349", "[fd7a::1]:41641" or "" (a DERP relay): the IP alone.
export function addressOf(curAddr) {
  if (!curAddr) return null;
  const v6 = /^\[([^\]]+)\]:\d+$/.exec(curAddr);
  if (v6) return v6[1];
  const v4 = /^([\d.]+):\d+$/.exec(curAddr);
  return v4 ? v4[1] : null;
}

// The Mac's peer, by its MagicDNS name (carries-macbook-air), not its display name.
export function findPeer(status, peer) {
  const peers = Object.values(status?.Peer ?? {});
  return peers.find(entry => (entry.DNSName ?? '').toLowerCase().split('.')[0] === peer.toLowerCase()) ?? null;
}

// probe: () => {runner: 'alive'|'missing', catchup: 'live'|'watch'} or null when the ssh got no answer.
// github: () => {status: 'online'|'offline', busy} or null when GitHub could not be asked.
export function macLink({ status, peer, lanCidr, probe = null, github = null, runnerName = 'the Mac runner' }) {
  const entry = findPeer(status, peer);
  if (!entry) return { link: 'offline', addr: null, reason: `${peer} is not a peer in tailscale status`, catchup: null };
  if (entry.Online !== true) return { link: 'offline', addr: null, reason: `${peer} is offline on the tailnet`, catchup: null };
  const addr = addressOf(entry.CurAddr);
  const home = Boolean(addr && inCidr(addr, lanCidr));
  const seen = probe ? probe() : undefined;
  if (seen?.runner === 'missing') return { link: 'offline', addr, reason: `no Runner.Listener of ${runnerName} on ${peer}`, catchup: seen.catchup ?? null };
  // Off the LAN, an ssh that gets no answer is a Mac that is going or gone (a closed lid, a dropped hotspot).
  if (probe && seen === null && !home) return { link: 'offline', addr, reason: `${peer} did not answer over ssh on a ${addr ? 'remote' : 'relayed'} link`, catchup: null };
  const gh = github ? github() : null;
  if (gh?.status === 'offline') return { link: 'offline', addr, reason: `GitHub shows ${runnerName} offline`, catchup: seen?.catchup ?? null };
  const catchup = seen?.catchup ?? null;
  if (home) return { link: 'home', addr, reason: `direct on the LAN (${addr})`, catchup };
  return { link: 'metered', addr, reason: addr ? `${addr} is outside ${lanCidr}` : `relayed through DERP ${entry.Relay || ''}`.trim(), catchup };
}

export function tailscaleStatus({ env = process.env, runner = runBounded } = {}) {
  return JSON.parse(runner('tailscale', ['status', '--json'], { env, timeout: 20_000, label: 'tailscale status' }));
}

// One ssh round trip: this app's own Runner.Listener (by its folder: ~/actions-runner, ~/actions-runner/gib, ...) and
// the catch-up's mode on the Mac (no mode file is watch, as catchup.mjs reads it).
export function macProbeScript(runnerDir = null) {
  if (runnerDir !== null && (!/^[A-Za-z0-9._/-]+$/.test(runnerDir) || runnerDir.startsWith('/') || runnerDir.split('/').includes('..'))) throw new Error(`bad runner folder "${runnerDir}"`);
  const pattern = runnerDir ? `^$HOME/${runnerDir}/bin/Runner.Listener` : 'Runner.Listener';
  return `if pgrep -f "${pattern}" >/dev/null; then echo runner=alive; else echo runner=missing; fi; case "$(cat "$HOME/.config/mobile-deploy-hub/catchup.json" 2>/dev/null)" in *'"live"'*) echo catchup=live ;; *) echo catchup=watch ;; esac`;
}

export function parseMacProbe(output) {
  const runner = /\brunner=(alive|missing)\b/.exec(output ?? '')?.[1];
  if (!runner) return null;
  return { runner, catchup: /\bcatchup=(live|watch)\b/.exec(output)?.[1] ?? null };
}

// Two tries: the first banner exchange over a DERP relay sometimes times out (design build log, HUB_MAC_RETRY).
export function macProbeOver(host, { runnerDir = null, env = process.env, runner = runBounded, tries = 2 } = {}) {
  return () => {
    for (let attempt = 1; attempt <= tries; attempt += 1) {
      try {
        const seen = parseMacProbe(runner('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', host, macProbeScript(runnerDir)], { env, timeout: 40_000, label: `ssh ${host}` }));
        if (seen) return seen;
      } catch { /* the next try, or null */ }
    }
    return null;
  };
}

// GitHub's own view of one runner, through the host's gh login (the job token cannot list runners): online or
// offline, and busy. null when it could not be asked. The job's GH_TOKEN is left out so gh uses that login.
export function runnerStatusOver(repo, name, { env = process.env, runner = runBounded } = {}) {
  return () => {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo ?? '') || !/^[A-Za-z0-9._-]+$/.test(name ?? '')) return null;
    const clean = { ...env };
    delete clean.GH_TOKEN;
    delete clean.GITHUB_TOKEN;
    try {
      const out = runner('gh', ['api', `repos/${repo}/actions/runners`, '--jq', `.runners[] | select(.name == "${name}") | "\\(.status) \\(.busy)"`], { env: clean, timeout: 30_000, label: 'gh api runners' });
      const [status, busy] = out.trim().split(/\s+/);
      return ['online', 'offline'].includes(status) ? { status, busy: busy === 'true' } : null;
    } catch { return null; }
  };
}

// The Mac's link from the Mac itself, for a decision made on the Mac (the ios job's IPA send): home only when its
// default gateway is inside the LAN. Behind the S26's hotspot that reads metered even when the phone is on home Wi-Fi,
// which errs on the side of not spending.
export function macGatewayLink({ lanCidr, env = process.env, runner = runBounded }) {
  try {
    const gateway = /gateway:\s*(\S+)/.exec(runner('/sbin/route', ['-n', 'get', 'default'], { env, timeout: 10_000, label: 'route get default' }))?.[1] ?? null;
    return { link: gateway && inCidr(gateway, lanCidr) ? 'home' : 'metered', gateway };
  } catch (error) {
    return { link: 'metered', gateway: null, reason: error.message.split('\n')[0] };
  }
}

// The gate's estimate of a run's Mac bytes on a metered link: the previous run's measurement, or the whole budget.
export function macEstimate({ latest, budgetMib }) {
  const measured = Number(latest?.mac_bytes);
  if (Number.isSafeInteger(measured) && measured > 0) return { bytes: measured, source: `the previous run (${latest.version})` };
  return { bytes: budgetMib * 1024 * 1024, source: 'no history: the whole budget' };
}

// rsync --stats: "Total bytes sent: 2,250" and "Total bytes received: 12,434" (GNU) or without commas (openrsync).
export function parseRsyncStats(output) {
  const number = name => {
    const match = new RegExp(`Total bytes ${name}:\\s*([\\d,.]+)`).exec(output ?? '');
    return match ? Number(match[1].replace(/[,.]/g, '')) : null;
  };
  return { sent: number('sent'), received: number('received') };
}
