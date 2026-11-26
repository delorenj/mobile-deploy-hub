// The Registry seed (AD-30, FR-29): every Resource devices.json declares, as an in-memory record shaped like the spine's Registry
// record, plus the `phone` Pool and the `dedicated_qa` marks. It is the one derivation from devices.json (`claims.fleetOf` projects
// it); lock.mjs keeps its own pure name maps (SEED_RESOURCES, DEPLOY_TARGETS) because it must not import the Registry, and
// seed.test.mjs keeps them equal to what this derives. Pure: nothing here writes, and the one read is the `qaDevices` loader a
// caller passes (default `loadQaDevices`, the only code in the hub that opens the private QA file).
//
// The deploy path never imports this directory (tools/deploy-path.test.mjs).
import { nameRefusal } from '../ci/lib/lock.mjs';
import { QA_DEVICES_FILE, qaDevicesPath, readQaEntries } from '../ci/lib/qa-devices.mjs';

// The `phone` word's order: the S24 first (the one a lease should take), then the deploy phone.
export const PHONE_POOL_SEED = Object.freeze(['s24', 's26']);

// The private QA file (never committed): devices a person dedicated to QA. The Registry reads only name, model and serial from
// it; `allowed_users` and every other key are dropped here, so nothing in the Registry can import them. The file itself is read
// by tools/ci/lib/qa-devices.mjs, which the catch-up also uses (it must install to the allowed users and may not import this directory).
export { QA_DEVICES_FILE, qaDevicesPath };

// The QA file's devices as [{name, model, serial}]; a missing file is []. A broken one throws HUB_QA_DEVICES naming the file and
// the entry index, never a serial and never the parser's own message (which can quote the text it choked on).
export const loadQaDevices = options => readQaEntries(options).map(({ name, model, serial }) => ({ name, model, serial }));

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

// ---- re-seed (AD-30) ----

const SEED_FIELDS = ['lock', 'name', 'words', 'display_name', 'kind', 'host', 'identity', 'deploy_target', 'seeded'];
const poolArray = pools => (Array.isArray(pools) ? pools : Object.entries(pools ?? {}).map(([name, rest]) => ({ name, ...rest })));

// What the seed of `devices` makes of a Registry file's content: `{resources, pools (the file's array form), warnings}`, to be written
// at the file's `if_rev`. `current` is `{resources, pools}` (pools as an array or keyed by name) or `null` for no file yet.
//   - null (first creation): the whole seed, with the QA file's phones (`qaDevices`), each record stamped `created_at` (`now()`, ms).
//   - a file: the QA loader is never called. A seeded record the seed still derives takes every seed field from it and loses
//     `seed_missing`; Capabilities, `created_at`, `retired_at` and any other key stay. A seeded record the seed no longer derives is
//     kept with `seed_missing: true`, never deleted. A runtime record is never touched. A new record is appended with `created_at`.
//     Each derived Pool overwrites its own keys; other keys and other Pools stay. File order is kept.
// `current` is never mutated. A new seeded record whose name a runtime record already carries adds one warning naming both ids
// (resolution is id-first, so it is harmless).
export function reseed(current, devices, { qaDevices = loadQaDevices, now = Date.now } = {}) {
  const stamp = () => new Date(now()).toISOString();
  if (current === null || current === undefined) {
    const first = seed(devices, { qaDevices });
    const created_at = stamp();
    return { resources: first.resources.map(entry => ({ ...entry, created_at })), pools: poolArray(first.pools), warnings: first.warnings };
  }
  const derived = seed(devices, { qaDevices: () => [] });
  const wanted = new Map(derived.resources.map(entry => [entry.id, entry]));
  const resources = structuredClone(current.resources ?? []);
  const warnings = [];
  const present = new Set();
  for (const [index, entry] of resources.entries()) {
    present.add(entry.id);
    if (entry.seeded !== true) continue;
    const from = wanted.get(entry.id);
    if (from) {
      const { seed_missing: _gone, ...kept } = entry;
      resources[index] = { ...kept, ...Object.fromEntries(SEED_FIELDS.map(key => [key, structuredClone(from[key])])) };
    } else if (entry.seed_missing !== true) {
      resources[index] = { ...entry, seed_missing: true };
    }
  }
  const created_at = stamp();
  for (const entry of derived.resources) {
    if (present.has(entry.id)) continue;
    const clash = resources.find(other => other.seeded === false && other.name === entry.name);
    if (clash) warnings.push(`the new seeded Resource "${entry.id}" shares the name "${entry.name}" with the runtime Resource "${clash.id}"; the id wins`);
    resources.push({ ...entry, created_at });
  }
  const pools = structuredClone(poolArray(current.pools));
  for (const [name, rest] of Object.entries(derived.pools)) {
    const at = pools.findIndex(pool => pool.name === name);
    if (at === -1) pools.push({ name, ...rest }); else pools[at] = { ...pools[at], ...rest, name };
  }
  return { resources, pools, warnings };
}

const resourcesOf = seeded => (Array.isArray(seeded) ? seeded : seeded?.resources ?? []);

// The ids a service caller passes as `qa_ids` (AD-41): every Resource marked dedicated_qa.
export const dedicatedQaIds = seeded => resourcesOf(seeded).filter(resource => resource.capabilities?.dedicated_qa === true).map(resource => resource.id);

// The deploy targets, as ids (a Set) and as the locks deploys take (in seed order).
export const deployTargetIds = seeded => new Set(resourcesOf(seeded).filter(resource => resource.deploy_target === true).map(resource => resource.id));
export const deployTargetLocks = seeded => resourcesOf(seeded).filter(resource => resource.deploy_target === true).map(resource => resource.lock);
