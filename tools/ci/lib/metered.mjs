// The Mac's link (design v1.1, F1). The gate reads `tailscale status --json` on big-chungus and finds the Mac's peer:
// offline when tailscale says so or the runner process is missing (checked over the hub-mac ssh alias, a few hundred
// bytes), home when its current address is inside the LAN, metered for anything else (another network, a phone
// hotspot, a DERP relay). Accepted blind spot: a remote network that also uses the LAN's range reads as home.
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

export function macLink({ status, peer, lanCidr, runnerAlive }) {
  const entry = findPeer(status, peer);
  if (!entry) return { link: 'offline', addr: null, reason: `${peer} is not a peer in tailscale status` };
  if (entry.Online !== true) return { link: 'offline', addr: null, reason: `${peer} is offline on the tailnet` };
  const addr = addressOf(entry.CurAddr);
  if (runnerAlive) {
    const alive = runnerAlive();
    if (alive === false) return { link: 'offline', addr, reason: `no Runner.Listener process on ${peer}` };
  }
  if (addr && inCidr(addr, lanCidr)) return { link: 'home', addr, reason: `direct on the LAN (${addr})` };
  return { link: 'metered', addr, reason: addr ? `${addr} is outside ${lanCidr}` : `relayed through DERP ${entry.Relay || ''}`.trim() };
}

export function tailscaleStatus({ env = process.env, runner = runBounded } = {}) {
  return JSON.parse(runner('tailscale', ['status', '--json'], { env, timeout: 20_000, label: 'tailscale status' }));
}

// true, false, or null when the check itself could not run (ssh failed): the gate then trusts tailscale alone.
export function runnerAliveOver(host, { env = process.env, runner = runBounded } = {}) {
  return () => {
    try {
      const out = runner('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', host, 'pgrep -f Runner.Listener >/dev/null && echo alive || echo missing'], { env, timeout: 40_000, label: `ssh ${host}` });
      if (/\balive\b/.test(out)) return true;
      if (/\bmissing\b/.test(out)) return false;
      return null;
    } catch { return null; }
  };
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
