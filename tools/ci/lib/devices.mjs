// The devices every deploy targets, kept once in tools/ci/devices.json: the S26 on big-chungus's adb server, the
// iPad behind the Mac's devicectl, the Apple team and development signer, the Mac (its ssh alias on big-chungus, its
// tailscale peer, the handoff folders and the IPA outbox) and big-chungus (its ssh alias on the Mac, the staging folder).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const defaultFile = fileURLToPath(new URL('../devices.json', import.meta.url));
const fail = message => { throw new Error(`devices.json: ${message}`); };

export function parseDevices(source) {
  let devices;
  try { devices = JSON.parse(source); } catch (error) { fail(`not valid JSON (${error.message})`); }
  if (devices?.schema !== 1) fail('schema must be 1');
  const { android, ios, apple, mac, linux } = devices;
  if (!/^[A-Za-z0-9]+$/.test(android?.serial ?? '')) fail('android.serial must be the ro.serialno of the phone');
  if (!/^[A-Za-z0-9_-]+$/.test(android?.model ?? '')) fail('android.model must be the ro.product.model');
  if (!/^[0-9A-F]{8}-[0-9A-F]{16}$|^[0-9a-f]{40}$/.test(ios?.udid ?? '')) fail('ios.udid must be the device UDID');
  if (!/^[A-Za-z]+\d+,\d+$/.test(ios?.model ?? '')) fail('ios.model must be a product type like iPad14,5');
  if (!/^[A-Z0-9]{10}$/.test(apple?.team ?? '')) fail('apple.team must be a 10-character team id');
  if (!/^[0-9A-F]{40}$/.test(apple?.dev_signer_sha1 ?? '')) fail('apple.dev_signer_sha1 must be an uppercase SHA-1');
  if (!Number.isSafeInteger(apple?.profile_min_days) || apple.profile_min_days < 0) fail('apple.profile_min_days must be a whole number');
  if (!/^[A-Za-z0-9.-]+$/.test(mac?.host ?? '')) fail('mac.host must be a host name (an ssh alias on big-chungus)');
  if (!/^[a-z0-9-]+$/.test(mac?.peer ?? '')) fail('mac.peer must be the Mac\'s tailscale MagicDNS name');
  const under = path => /^[A-Za-z0-9._/-]+$/.test(path ?? '') && !path.startsWith('/') && !path.split('/').includes('..');
  for (const key of ['handoff_dir', 'handoff_cache', 'outbox']) if (!under(mac?.[key])) fail(`mac.${key} must be a path under the Mac home`);
  if (!(Number(mac?.min_free_gib) > 0)) fail('mac.min_free_gib must be positive');
  // Each app's own Mac runner (its GitHub name and its folder under the Mac home): three runners share the one Mac, and
  // only an app's own runner can take that app's iPad jobs, so the gate and the watchdog check that one.
  if (mac?.runners !== undefined) {
    if (mac.runners === null || typeof mac.runners !== 'object' || Array.isArray(mac.runners)) fail('mac.runners must map owner/repo to {name, dir}');
    for (const [repo, entry] of Object.entries(mac.runners)) {
      if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) fail(`mac.runners key "${repo}" must be owner/repo`);
      if (!/^[A-Za-z0-9._-]+$/.test(entry?.name ?? '')) fail(`mac.runners.${repo}.name must be the runner's GitHub name`);
      if (!under(entry?.dir)) fail(`mac.runners.${repo}.dir must be a path under the Mac home`);
    }
  }
  if (android?.syncthing !== undefined && !/^[A-Z0-9]{7}(-[A-Z0-9]{7}){7}$/.test(android.syncthing)) fail('android.syncthing must be the S26\'s Syncthing device ID');
  if (!/^[A-Za-z0-9.-]+$/.test(linux?.host ?? '')) fail('linux.host must be a host name (an ssh alias on the Mac)');
  if (!under(linux?.staging_dir)) fail('linux.staging_dir must be a path under the big-chungus home');
  return devices;
}

export function loadDevices(env = process.env) {
  return parseDevices(readFileSync(env.HUB_DEVICES || defaultFile, 'utf8'));
}
