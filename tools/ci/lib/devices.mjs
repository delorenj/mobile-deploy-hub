// The devices every deploy targets, kept once in tools/ci/devices.json: the S26 on big-chungus's adb server, the
// iPad behind the Mac's devicectl, the Apple team and development signer, and the Mac the Xcode handoff goes to.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const defaultFile = fileURLToPath(new URL('../devices.json', import.meta.url));
const fail = message => { throw new Error(`devices.json: ${message}`); };

export function parseDevices(source) {
  let devices;
  try { devices = JSON.parse(source); } catch (error) { fail(`not valid JSON (${error.message})`); }
  if (devices?.schema !== 1) fail('schema must be 1');
  const { android, ios, apple, mac } = devices;
  if (!/^[A-Za-z0-9]+$/.test(android?.serial ?? '')) fail('android.serial must be the ro.serialno of the phone');
  if (!/^[A-Za-z0-9_-]+$/.test(android?.model ?? '')) fail('android.model must be the ro.product.model');
  if (!/^[0-9A-F]{8}-[0-9A-F]{16}$|^[0-9a-f]{40}$/.test(ios?.udid ?? '')) fail('ios.udid must be the device UDID');
  if (!/^[A-Za-z]+\d+,\d+$/.test(ios?.model ?? '')) fail('ios.model must be a product type like iPad14,5');
  if (!/^[A-Z0-9]{10}$/.test(apple?.team ?? '')) fail('apple.team must be a 10-character team id');
  if (!/^[0-9A-F]{40}$/.test(apple?.dev_signer_sha1 ?? '')) fail('apple.dev_signer_sha1 must be an uppercase SHA-1');
  if (!Number.isSafeInteger(apple?.profile_min_days) || apple.profile_min_days < 0) fail('apple.profile_min_days must be a whole number');
  if (!/^[A-Za-z0-9.-]+$/.test(mac?.host ?? '')) fail('mac.host must be a host name');
  if (!/^[A-Za-z0-9._/-]+$/.test(mac?.handoff_dir ?? '') || mac.handoff_dir.startsWith('/') || mac.handoff_dir.split('/').includes('..')) fail('mac.handoff_dir must be a path under the Mac home');
  if (!(Number(mac?.min_free_gib) > 0)) fail('mac.min_free_gib must be positive');
  return devices;
}

export function loadDevices(env = process.env) {
  return parseDevices(readFileSync(env.HUB_DEVICES || defaultFile, 'utf8'));
}
