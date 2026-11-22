// The app's mobile-deploy.json: hook commands and identity pins, read from the committed file at the built ref.
// Strict on purpose: an unknown key is a typo, and a hook that is not a plain string never reaches a shell.
//
// Schema 2 is the only contract (version bump, device installs and delivery, one event). The v2 (schema 1) path is
// gone: the gate refuses a schema 1 manifest before any version is spent (HUB_GATE_REFUSED manifest schema 1).
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const topKeys = ['schema', 'project', 'version', 'android', 'ios'];
const androidKeys = ['package', 'prepare', 'export', 'godot', 'bundle', 'bundle_artifact', 'bundle_signing', 'artifact', 'receipt', 'signer_sha256', 'editions'];
// MOBI-14: more signed Android editions of one app (docs/multi-edition-android.md). The top-level android block is the
// device edition, the one APK the S26, Quickdrop and the catch-up ever see. Each entry of android.editions is another
// signed APK of the same version (its own package, hook, artifact, receipt and signer pin) that the android job builds
// and verifies beside it and never installs. `public` opts it into the anonymous edition page; the policy must allow it.
const editionKeys = ['package', 'prepare', 'export', 'godot', 'artifact', 'receipt', 'signer_sha256', 'public'];
const publicKeys = ['title'];
export const editionName = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
// "device" names the top-level block in receipts and docs, so no extra edition may take it.
export const reservedEditions = Object.freeze(['device']);
export const maxEditions = 8;
const iosKeys = ['bundle', 'prepare', 'export', 'archive', 'receipt', 'device', 'device_artifact', 'store'];
// Two shapes of one store lane. With ios.export (Tower, Navi) the Linux half writes the App Store Xcode project: archive and
// receipt name it, and the app's upload hook signs and uploads it on the Mac. Without ios.export (a Mac-only app, Green In
// Between) the Mac builds the App Store IPA itself: `build` is the hook (it runs in a dry run too, so the signing is proven
// before a version is spent) and `artifact` the IPA it leaves in $HUB_OUT/ios, which the hub checks (bundle, version, build,
// signer, an App Store profile) before upload and assign are called. `bundle` names a store bundle id that differs from the
// iPad's development one; the policy pins it (apps.<repo>.ios.store_bundle).
// Two optional hooks (hub v1.3, TOWE-76): `preflight` runs on the Mac in preflight-ios, before plan spends a version, so a
// stale store toolchain (an Xcode pin the Mac no longer has) fails a dry run and a real run before the bump; `state`
// answers whether App Store Connect already has the planned (version, build), so a rerun never uploads it twice.
// A third (JIMB-466), `review`, runs after assign and says where Apple's beta review of the build stands, which the
// receipt records; it is information and never fails a deploy.
const storeKeys = ['bundle', 'archive', 'receipt', 'build', 'artifact', 'upload', 'assign', 'signer_sha1', 'secrets', 'preflight', 'state', 'review'];

const fail = message => { throw new Error(`mobile-deploy.json: ${message}`); };

function exactKeys(section, value, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${section} must be an object`);
  for (const key of Object.keys(value)) if (!allowed.includes(key)) fail(`${section} has unknown key "${key}"`);
}

function text(section, value, key, { required = false } = {}) {
  const found = value[key];
  if (found === undefined) {
    if (required) fail(`${section}.${key} is required`);
    return undefined;
  }
  if (typeof found !== 'string' || found.trim() === '' || found.includes('\0')) fail(`${section}.${key} must be a non-empty string`);
  return found;
}

// A path inside the app checkout (artifact, receipt, icon) or a bare file name inside the hub output folder.
function relativePath(section, value, key, { suffix, bare = false, required = false } = {}) {
  const found = text(section, value, key, { required });
  if (found === undefined) return undefined;
  if (found.startsWith('/') || found.split('/').includes('..') || found.includes('\\')) fail(`${section}.${key} must stay inside the app checkout`);
  if (bare && found.includes('/')) fail(`${section}.${key} must be a bare file name`);
  const suffixes = [suffix].flat().filter(Boolean);
  if (suffixes.length > 0 && !suffixes.some(end => found.endsWith(end))) fail(`${section}.${key} must end in ${suffixes.join(' or ')}`);
  return found;
}

function secrets(section, value) {
  if (value.secrets === undefined) return;
  if (!Array.isArray(value.secrets) || value.secrets.some(ref => typeof ref !== 'string' || !ref.startsWith('op://'))) fail(`${section}.secrets must list op:// references`);
}

function sha1(section, value) {
  if (value.signer_sha1 !== undefined && !/^[0-9A-F]{40}$/.test(value.signer_sha1)) fail(`${section}.signer_sha1 must be an uppercase hex SHA-1 fingerprint`);
}

// The APK half every edition shares: the package, the optional prepare hook, the export hook (or a Godot preset), the
// artifact, the optional app receipt and the signer pin. `why` finishes the message for a block with no APK lane.
function apkLane(section, value, why) {
  const pkg = text(section, value, 'package', { required: true });
  if (!/^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/.test(pkg)) fail(`${section}.package must be a reverse-DNS package name`);
  text(section, value, 'prepare');
  relativePath(section, value, 'receipt');
  const sideload = text(section, value, 'export') ?? value.godot;
  if (value.godot !== undefined) {
    exactKeys(`${section}.godot`, value.godot, ['path', 'preset']);
    text(`${section}.godot`, value.godot, 'path', { required: true });
    text(`${section}.godot`, value.godot, 'preset', { required: true });
    if (value.export !== undefined) fail(`${section} declares both export and godot; pick one`);
  }
  if (sideload === undefined) fail(`${section} needs an export hook or a godot section: ${why}`);
  relativePath(section, value, 'artifact', { suffix: '.apk', required: true });
  if (!/^[0-9a-f]{64}$/.test(value.signer_sha256 ?? '')) fail(`${section}.signer_sha256 must be a lowercase hex SHA-256 digest`);
}

// MOBI-18: where the bundle hook finds the key that signs the Play bundle, as op:// references. The hub passes the
// references on (HUB_PLAY_SIGNING_*_REF) and never resolves one; the hook reads them with `op read`. A reference to
// anything but a vault is refused, so a raw password or a path can never ride in the manifest.
export const signingRefKeys = ['key_ref', 'alias_ref', 'password_ref'];
export const signingRef = /^op:\/\/[^\r\n\0/]+\/[^\r\n\0/]+\/[^\r\n\0]+$/;

function bundleSigning(android) {
  if (android.bundle_signing === undefined) return;
  if (android.bundle === undefined) fail('android.bundle_signing needs android.bundle');
  exactKeys('android.bundle_signing', android.bundle_signing, signingRefKeys);
  for (const key of signingRefKeys) {
    const ref = text('android.bundle_signing', android.bundle_signing, key, { required: true });
    if (!signingRef.test(ref)) fail(`android.bundle_signing.${key} must be an op://vault/item/field reference, never a value`);
  }
}

function androidSection(android) {
  exactKeys('android', android, androidKeys);
  // Every deploy installs the sideload APK on the S26, so the APK lane is required; Play's AAB is extra.
  apkLane('android', android, 'every deploy installs the APK on the S26');
  if (android.bundle !== undefined) {
    text('android', android, 'bundle');
    relativePath('android', android, 'bundle_artifact', { suffix: '.aab', required: true });
  } else if (android.bundle_artifact !== undefined) {
    fail('android.bundle_artifact needs android.bundle');
  }
  bundleSigning(android);
  if (android.editions !== undefined) editionsSection(android);
}

// The extra editions, refused before any version is spent when they are malformed or collide: a bad name, the reserved
// device name, a `device` flag (the device edition is the top-level block, so there is exactly one), a package another
// edition already is, or an artifact or receipt path another edition (or the device edition) already writes.
function editionsSection(android) {
  const editions = android.editions;
  if (!editions || typeof editions !== 'object' || Array.isArray(editions)) fail('android.editions must be an object of named editions');
  const names = Object.keys(editions);
  if (names.length === 0) fail('android.editions names no edition; leave it out for a single-edition app');
  if (names.length > maxEditions) fail(`android.editions names ${names.length} editions; at most ${maxEditions}`);
  const packages = new Map([[android.package, 'the device edition (android.package)']]);
  const paths = new Map();
  const claim = (path, where) => {
    if (path === undefined) return;
    if (paths.has(path)) fail(`${where} is ${path}, which ${paths.get(path)} already writes; every edition needs its own artifact and receipt`);
    paths.set(path, where);
  };
  claim(android.artifact, 'android.artifact');
  claim(android.receipt, 'android.receipt');
  claim(android.bundle_artifact, 'android.bundle_artifact');
  for (const name of names) {
    const section = `android.editions.${name}`;
    if (!editionName.test(name) || name.length > 32) fail(`android.editions: "${name}" is not an edition name (lowercase letters, digits and single dashes, starting with a letter, at most 32 characters)`);
    if (reservedEditions.includes(name)) fail(`android.editions: "${name}" is reserved for the device edition, which is the top-level android block`);
    const spec = editions[name];
    if (spec && typeof spec === 'object' && !Array.isArray(spec) && 'device' in spec) fail(`${section}.device: the device edition is the top-level android block; an extra edition never installs on a device`);
    exactKeys(section, spec, editionKeys);
    apkLane(section, spec, 'the hub builds and signs every declared edition');
    if (packages.has(spec.package)) fail(`${section}.package ${spec.package} is already ${packages.get(spec.package)}; every edition is its own package`);
    packages.set(spec.package, section);
    claim(spec.artifact, `${section}.artifact`);
    claim(spec.receipt, `${section}.receipt`);
    if (spec.public !== undefined) {
      exactKeys(`${section}.public`, spec.public, publicKeys);
      const title = text(`${section}.public`, spec.public, 'title');
      if (title !== undefined && (title.length > 80 || /[\r\n]/.test(title))) fail(`${section}.public.title must be one line of at most 80 characters`);
    }
  }
}

// JSON.parse keeps the last of two equal keys, so a copied edition block whose name was not changed would silently
// replace the first. The manifest has already parsed, so this walk only has to find object keys, and only reports the
// ones under `under` (android.editions): a duplicate elsewhere keeps its pre-MOBI-14 meaning.
export function duplicateKeys(source, under = ['android', 'editions']) {
  let at = 0;
  const found = [];
  const space = () => { while (at < source.length && ' \t\n\r'.includes(source[at])) at += 1; };
  const string = () => {
    const start = at;
    at += 1;
    while (source[at] !== '"') at += source[at] === '\\' ? 2 : 1;
    at += 1;
    return JSON.parse(source.slice(start, at));
  };
  const inside = path => path.length >= under.length && under.every((key, index) => path[index] === key);
  const value = path => {
    space();
    const head = source[at];
    if (head === '{') {
      at += 1;
      const seen = new Set();
      space();
      if (source[at] === '}') { at += 1; return; }
      for (;;) {
        space();
        const key = string();
        space();
        at += 1;
        if (seen.has(key) && inside(path)) found.push([...path, key].join('.'));
        seen.add(key);
        value([...path, key]);
        space();
        if (source[at++] === ',') continue;
        return;
      }
    }
    if (head === '[') {
      at += 1;
      space();
      if (source[at] === ']') { at += 1; return; }
      for (let index = 0; ; index += 1) {
        value([...path, String(index)]);
        space();
        if (source[at++] === ',') continue;
        return;
      }
    }
    if (head === '"') { string(); return; }
    while (at < source.length && !',]} \t\n\r'.includes(source[at])) at += 1;
  };
  value([]);
  return found;
}

function bundleId(section, value) {
  const bundle = text(section, value, 'bundle', { required: true });
  if (!/^[A-Za-z][A-Za-z0-9-]*(\.[A-Za-z][A-Za-z0-9-]*)+$/.test(bundle)) fail(`${section}.bundle must be a reverse-DNS bundle id`);
}

function iosSection(ios) {
  exactKeys('ios', ios, iosKeys);
  bundleId('ios', ios);
  text('ios', ios, 'prepare');
  // The Linux export is optional (Tower's Godot export); its archive is the PRIVATE Xcode project for the iPad.
  const linux = text('ios', ios, 'export');
  for (const key of ['archive', 'receipt']) {
    const suffix = key === 'archive' ? '.tgz' : '.json';
    if (linux) relativePath('ios', ios, key, { suffix, bare: true, required: true });
    else if (ios[key] !== undefined) fail(`ios.${key} needs ios.export (the Linux half that writes it)`);
  }
  if (ios.prepare !== undefined && !linux) fail('ios.prepare runs before the Linux export; without ios.export do the work in ios.device');
  text('ios', ios, 'device', { required: true });
  relativePath('ios', ios, 'device_artifact', { suffix: ['.xcarchive', '.ipa'], bare: true, required: true });
  if (ios.store !== undefined) {
    exactKeys('ios.store', ios.store, storeKeys);
    if (ios.store.bundle !== undefined) bundleId('ios.store', ios.store);
    if (linux) {
      relativePath('ios.store', ios.store, 'archive', { suffix: '.tgz', bare: true, required: true });
      relativePath('ios.store', ios.store, 'receipt', { suffix: '.json', bare: true, required: true });
      if (ios.store.archive === ios.archive) fail('ios.store.archive must differ from ios.archive: the iPad gets the private project, TestFlight the store one');
      for (const key of ['build', 'artifact']) if (ios.store[key] !== undefined) fail(`ios.store.${key} is for an app without ios.export (the Mac builds the store IPA); this one hands the store project over in ios.store.archive`);
    } else {
      for (const key of ['archive', 'receipt']) if (ios.store[key] !== undefined) fail(`ios.store.${key} needs ios.export: the Linux export writes the App Store Xcode project. A Mac-only app declares ios.store.build and ios.store.artifact instead`);
      text('ios.store', ios.store, 'build', { required: true });
      relativePath('ios.store', ios.store, 'artifact', { suffix: '.ipa', bare: true, required: true });
      if (ios.store.signer_sha1 === undefined) fail('ios.store.signer_sha1 is required without ios.export: the hub checks the store IPA against it');
    }
    for (const key of ['upload', 'assign']) text('ios.store', ios.store, key, { required: true });
    for (const key of ['preflight', 'state', 'review']) text('ios.store', ios.store, key);
    sha1('ios.store', ios.store);
    secrets('ios.store', ios.store);
  }
}

export function parseManifest(source) {
  let manifest;
  try { manifest = JSON.parse(source); } catch (error) { fail(`not valid JSON (${error.message})`); }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) fail('manifest must be an object');
  if (manifest.schema === 1) fail('schema 1 (the v2 contract) is gone; move the manifest to schema 2 (README "The manifest")');
  if (manifest.schema !== 2) fail(`schema must be 2, got ${JSON.stringify(manifest.schema)}`);
  exactKeys('manifest', manifest, topKeys);
  if (!manifest.android && !manifest.ios) fail('declare at least one of android or ios');
  // project.icon (optional): a square PNG in the checkout; deliver resizes it for the iPad's install prompt.
  exactKeys('project', manifest.project, ['slug', 'name', 'icon']);
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(manifest.project.slug ?? '')) fail('project.slug must be the pjangler slug (lowercase, digits, dashes)');
  const name = text('project', manifest.project, 'name', { required: true });
  if (name.length > 120) fail('project.name must be at most 120 characters');
  relativePath('project', manifest.project, 'icon', { suffix: '.png' });
  exactKeys('version', manifest.version, ['read', 'bump']);
  text('version', manifest.version, 'read', { required: true });
  text('version', manifest.version, 'bump', { required: true });
  if (manifest.android !== undefined) androidSection(manifest.android);
  if (manifest.android?.editions !== undefined) {
    const twice = duplicateKeys(source);
    if (twice.length > 0) fail(`${twice[0]} is declared twice; JSON keeps only the last, so an edition would vanish`);
  }
  if (manifest.ios !== undefined) iosSection(manifest.ios);
  return manifest;
}

export async function loadManifest(cwd, path) {
  let source;
  try { source = await readFile(join(cwd, path), 'utf8'); } catch (error) { fail(`cannot read ${path} (${error.code ?? error.message})`); }
  return parseManifest(source);
}

// The extra editions in declaration order: [{name, spec}]. An app without android.editions has none (single edition).
export function editionsOf(manifest) {
  return Object.entries(manifest?.android?.editions ?? {}).map(([name, spec]) => ({ name, spec }));
}
