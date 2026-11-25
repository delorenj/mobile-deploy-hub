// The Registry seed (AD-30, FR-29): every Resource devices.json declares, as an in-memory record shaped like the spine's Registry
// record, plus the `phone` Pool and the `dedicated_qa` marks. It is the one derivation from devices.json (`claims.fleetOf` projects
// it); lock.mjs keeps its own pure name maps (SEED_RESOURCES, DEPLOY_TARGETS) because it must not import the Registry, and
// seed.test.mjs keeps them equal to what this derives. Pure: nothing here writes, and the one read is the `qaDevices` loader a
// caller passes (default `loadQaDevices`, the only code in the hub that opens the private QA file).
//
// The deploy path never imports this directory (tools/deploy-path.test.mjs).
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { nameRefusal } from '../ci/lib/lock.mjs';

// The `phone` word's order: the S24 first (the one a lease should take), then the deploy phone.
export const PHONE_POOL_SEED = Object.freeze(['s24', 's26']);

// The private QA file (never committed): devices a person dedicated to QA. Only name, model and serial are ever read from it;
// its `allowed_users` and every other key are dropped here, so nothing downstream can import them.
export const QA_DEVICES_FILE = '.config/mobile-deploy-hub/qa-devices.json';
export const qaDevicesPath = (env = process.env, home = env.HOME || homedir()) => env.HUB_QA_DEVICES || join(home, QA_DEVICES_FILE);

const SERIAL = /^[A-Za-z0-9]+$/;
const broken = (file, reason) => Object.assign(new Error(`${file}: ${reason}`), { code: 'HUB_QA_DEVICES' });

// The QA file's devices as [{name, model, serial}]; a missing file is []. A broken one throws HUB_QA_DEVICES naming the file and
// the entry index, never a serial and never the parser's own message (which can quote the text it choked on).
export function loadQaDevices({ env = process.env, home = env.HOME || homedir(), readFile = readFileSync } = {}) {
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
    return { name: entry.name, model: typeof entry.model === 'string' ? entry.model : null, serial: entry.serial };
  });
}

const record = fields => ({
  id: null, lock: null, name: null, words: [], display_name: null, kind: null, host: null, identity: null,
  capabilities: {}, deploy_target: false, seeded: true, ...fields,
});

// The seed of one devices.json: `{resources, pools, warnings}`. `devices` is never mutated. Resources, in order: each android_extra
// phone, the deploy phone (id `s26`, lock `adb`), the iPad lane (`ios-lane`, lock `mac-ios`) and the emulator Pool. A `qaDevices()`
// entry is matched to a phone by serial and marks it `dedicated_qa`; the deploy phone is never marked, and an entry that matches
// no phone becomes a runtime record `res-<slug>`. Warnings name an entry by its name, never by its serial.
export function seed(devices, { qaDevices = loadQaDevices } = {}) {
  const resources = [];
  for (const entry of devices.android_extra ?? []) {
    const id = entry.name.toLowerCase();
    // The same name rule parseDevices applies (lock.mjs), so a seed built from hand-made devices never carries a reserved word that is not seeded.
    const refusal = nameRefusal(id);
    if (refusal) throw new Error(`devices.json: android_extra[].name may not be "${id}" (${refusal})`);
    resources.push(record({ id, lock: id, name: id, display_name: entry.name, kind: 'phone', host: 'linux', identity: { serial: entry.serial, model: entry.model } }));
  }
  const { android, ios } = devices;
  resources.push(record({ id: 's26', lock: 'adb', name: 's26', display_name: android.name, kind: 'phone', host: 'linux', identity: { serial: android.serial, model: android.model }, deploy_target: true }));
  resources.push(record({ id: 'ios-lane', lock: 'mac-ios', name: 'ios-lane', words: ['ipad', 'mac'], display_name: ios.name, kind: 'ios-lane', host: 'mac', identity: { udid: ios.udid, model: ios.model }, deploy_target: true }));
  resources.push(record({ id: 'emulator', lock: 'emulator', name: 'emulator', display_name: 'Emulator pool', kind: 'emulator-pool', host: 'linux' }));

  const warnings = [];
  const entries = qaDevices();
  for (const [index, raw] of (Array.isArray(entries) ? entries : []).entries()) {
    // Only these three keys are ever read; whatever else a loader returned (allowed_users) stops here.
    const name = typeof raw?.name === 'string' ? raw.name : '';
    const serial = typeof raw?.serial === 'string' ? raw.serial : '';
    const label = `qa-devices entry ${index}${name ? ` ("${name}")` : ''}`;
    const phone = serial ? resources.find(resource => resource.kind === 'phone' && resource.identity?.serial === serial) : undefined;
    if (phone) {
      if (phone.deploy_target) warnings.push(`${label} names the deploy phone, which can never be dedicated; skipped`);
      else phone.capabilities.dedicated_qa = true;
      continue;
    }
    const slug = name.toLowerCase();
    const refusal = nameRefusal(slug);
    if (refusal) { warnings.push(`${label} skipped: "${name}" ${refusal}`); continue; }
    const id = `res-${slug}`;
    if (resources.some(resource => resource.id === id || resource.lock === id || resource.id === slug || resource.lock === slug)) {
      warnings.push(`${label} skipped: "${name}" is already a Resource`);
      continue;
    }
    resources.push(record({
      id, lock: id, name: slug, display_name: name, kind: 'phone', host: 'linux',
      identity: { serial, model: typeof raw.model === 'string' ? raw.model : null },
      capabilities: { dedicated_qa: true }, seeded: false,
    }));
  }

  const ids = new Set(resources.map(resource => resource.id));
  return {
    resources,
    pools: { phone: { members: PHONE_POOL_SEED.filter(id => ids.has(id)), named: true }, emulator: { gate: 'emulator' } },
    warnings,
  };
}

const resourcesOf = seeded => (Array.isArray(seeded) ? seeded : seeded?.resources ?? []);

// The ids a service caller passes as `qa_ids` (AD-41): every Resource marked dedicated_qa.
export const dedicatedQaIds = seeded => resourcesOf(seeded).filter(resource => resource.capabilities?.dedicated_qa === true).map(resource => resource.id);

// The deploy targets, as ids (a Set) and as the locks deploys take (in seed order).
export const deployTargetIds = seeded => new Set(resourcesOf(seeded).filter(resource => resource.deploy_target === true).map(resource => resource.id));
export const deployTargetLocks = seeded => resourcesOf(seeded).filter(resource => resource.deploy_target === true).map(resource => resource.lock);
