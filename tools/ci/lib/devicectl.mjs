// The iPad through the Mac's devicectl. Every call has a deadline (devicectl's own --timeout plus a hard kill), so
// an iPad that drops off the network fails the step instead of holding the Mac runner. The hub installs in place
// with `device install app` (same team and bundle, so data stays) and never removes an app.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runBounded } from './exec.mjs';

export function createDevicectl({ env = process.env, runner = runBounded, xcrun = env.HUB_XCRUN || 'xcrun' } = {}) {
  return (args, timeoutSec = 60) => {
    const dir = mkdtempSync(join(tmpdir(), 'hub-devicectl-'));
    try {
      const file = join(dir, 'out.json');
      runner(xcrun, ['devicectl', '--timeout', String(timeoutSec), ...args, '--json-output', file], { env, timeout: (timeoutSec + 30) * 1000, label: `devicectl ${args.slice(0, 3).join(' ')}` });
      let document;
      try { document = JSON.parse(readFileSync(file, 'utf8')); } catch { throw new Error(`devicectl ${args.slice(0, 3).join(' ')} wrote no JSON result`); }
      if (document?.info?.outcome !== 'success') throw new Error(`devicectl ${args.slice(0, 3).join(' ')} did not succeed (${document?.info?.outcome ?? 'no outcome'})`);
      return document;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

// The approved iPad: physical, the pinned model, paired, Developer Mode on.
export function pickIpad(document, { udid, model }) {
  const devices = document?.result?.devices ?? [];
  const matches = devices.filter(device => (device.hardwareProperties ?? device.properties?.hardware ?? {}).udid === udid);
  if (matches.length !== 1) throw new Error(`the iPad ${model} (UDID ${udid}) is not listed by devicectl on this Mac; wake it, keep it on the same Wi-Fi and check \`xcrun devicectl list devices\``);
  const [device] = matches;
  const hardware = device.hardwareProperties ?? {};
  const connection = device.connectionProperties ?? {};
  const properties = device.deviceProperties ?? {};
  // devicectl can list the iPad by UDID with the hardware details it reads live left out (a run logged "undefined
  // iPad14,5" and failed the whole deploy, 2026-10-24; seen with the iPad away, the record's cause is not captured).
  // An unproven identity is never reachable: it is reported as tunnel 'unavailable', which reachIpad and the catch-up
  // treat as pending. A state the record states explicitly and wrongly (unpaired, Developer Mode off, simulated,
  // another model) stays a hard error.
  if (hardware.reality === undefined && (hardware.productType === undefined || hardware.productType === model)) {
    if (connection.pairingState !== undefined && connection.pairingState !== 'paired') throw new Error(`the iPad is not paired with this Mac (pairingState ${connection.pairingState})`);
    if (properties.developerModeStatus && properties.developerModeStatus !== 'enabled') throw new Error('Developer Mode is off on the iPad (Settings > Privacy & Security > Developer Mode)');
    return { identifier: device.identifier, name: properties.name ?? null, os: properties.osVersionNumber ?? null, transport: connection.transportType ?? null, tunnel: 'unavailable' };
  }
  if (hardware.reality !== 'physical' || hardware.productType !== model) throw new Error(`devicectl lists ${udid} as ${hardware.reality} ${hardware.productType}, not the physical ${model}`);
  if (connection.pairingState !== 'paired') throw new Error(`the iPad is not paired with this Mac (pairingState ${connection.pairingState})`);
  if (properties.developerModeStatus && properties.developerModeStatus !== 'enabled') throw new Error('Developer Mode is off on the iPad (Settings > Privacy & Security > Developer Mode)');
  return { identifier: device.identifier, name: properties.name ?? null, os: properties.osVersionNumber ?? null, transport: connection.transportType ?? null, tunnel: connection.tunnelState ?? null };
}

export function pickApp(document, bundle) {
  const app = (document?.result?.apps ?? []).find(entry => entry.bundleIdentifier === bundle);
  return app ? { version: app.version ?? null, build: app.bundleVersion === undefined ? null : String(app.bundleVersion), developer: app.builtByDeveloper === true } : null;
}

// Whether the app is running on the iPad: a process whose executable lives in the app's own bundle folder. devicectl
// cannot tell the foreground from a suspended app, so a caller treats this as "maybe in use".
export function appRunning(appsDocument, processesDocument, bundle) {
  const url = (appsDocument?.result?.apps ?? []).find(entry => entry.bundleIdentifier === bundle)?.url;
  if (typeof url !== 'string' || url.length < 8) return false;
  const folder = url.endsWith('/') ? url : `${url}/`;
  return (processesDocument?.result?.runningProcesses ?? []).some(process => String(process.executable ?? '').startsWith(folder));
}

export function createIpad({ devicectl, udid, model }) {
  return {
    find: () => pickIpad(devicectl(['list', 'devices'], 30), { udid, model }),
    installed: bundle => pickApp(devicectl(['device', 'info', 'apps', '--device', udid, '--bundle-id', bundle], 60), bundle),
    running: bundle => appRunning(devicectl(['device', 'info', 'apps', '--device', udid, '--bundle-id', bundle], 60), devicectl(['device', 'info', 'processes', '--device', udid], 60), bundle),
    // An .app bundle path: in place over the installed build, data kept.
    install: app => devicectl(['device', 'install', 'app', '--device', udid, app], 300),
  };
}
