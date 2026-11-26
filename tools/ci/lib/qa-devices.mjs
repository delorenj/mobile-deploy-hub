// The private QA file (never committed): the phones a person donated to the hub as dedicated QA devices, declared once in
// ~/.config/mobile-deploy-hub/qa-devices.json (or $HUB_QA_DEVICES):
//   {"schema":1,"devices":[{"name":"S24","model":"SM-S928U","serial":"<ro.serialno>","dedicated":true,"allowed_users":[0]}]}
// `allowed_users` are the Android users the hub may install to on that phone (adb install -r --user N); everything else on the
// phone, the owner's profiles and apps, is never touched.
//
// Two readers share this file. The Registry seed (tools/registry/seed.mjs) keeps name, model and serial and drops the rest. The
// catch-up (tools/catchup) needs the users, and it may not import the Registry (tools/deploy-path.test.mjs), so the one parser lives here.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const QA_DEVICES_FILE = '.config/mobile-deploy-hub/qa-devices.json';
export const qaDevicesPath = (env = process.env, home = env.HOME || homedir()) => env.HUB_QA_DEVICES || join(home, QA_DEVICES_FILE);

const SERIAL = /^[A-Za-z0-9]+$/;
const broken = (file, reason) => Object.assign(new Error(`${file}: ${reason}`), { code: 'HUB_QA_DEVICES' });

// The QA file's devices as [{name, model, serial, allowed_users}]; a missing file is []. `allowed_users` is the file's own array
// (or null when it is absent or malformed: the catch-up refuses such a phone, the Registry never looks). A broken file throws
// HUB_QA_DEVICES naming the file and the entry index, never a serial and never the parser's own message (which can quote the text it choked on).
export function readQaEntries({ env = process.env, home = env.HOME || homedir(), readFile = readFileSync } = {}) {
  const file = qaDevicesPath(env, home);
  let text;
  try { text = String(readFile(file, 'utf8')); } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw broken(file, `cannot read it (${error?.code ?? 'read error'})`);
  }
  let parsed;
  try { parsed = JSON.parse(text); } catch { throw broken(file, 'not valid JSON'); }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed) || parsed.schema !== 1) throw broken(file, 'schema must be 1');
  if (!Array.isArray(parsed.devices)) throw broken(file, '"devices" must be an array');
  return parsed.devices.map((entry, index) => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) throw broken(file, `devices[${index}] must be an object`);
    if (typeof entry.serial !== 'string' || !SERIAL.test(entry.serial)) throw broken(file, `devices[${index}].serial must be letters and digits`);
    if (typeof entry.name !== 'string' || entry.name.trim() === '') throw broken(file, `devices[${index}].name must be a non-empty string`);
    const users = Array.isArray(entry.allowed_users) && entry.allowed_users.length > 0 && entry.allowed_users.every(user => Number.isSafeInteger(user) && user >= 0) ? [...new Set(entry.allowed_users)] : null;
    return { name: entry.name, model: typeof entry.model === 'string' ? entry.model : null, serial: entry.serial, dedicated: entry.dedicated === true, allowed_users: users };
  });
}
