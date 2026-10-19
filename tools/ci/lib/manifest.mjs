// The app's mobile-deploy.json: hook commands and identity pins, read from the committed file at the built ref.
// Strict on purpose: an unknown key is a typo, and a hook that is not a plain string never reaches a shell.
//
// Schema 2 is the only contract (version bump, device installs and delivery, one event). The v2 (schema 1) path is
// gone: the gate refuses a schema 1 manifest before any version is spent (HUB_GATE_REFUSED manifest schema 1).
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const topKeys = ['schema', 'project', 'version', 'android', 'ios'];
const androidKeys = ['package', 'prepare', 'export', 'godot', 'bundle', 'bundle_artifact', 'artifact', 'receipt', 'signer_sha256'];
const iosKeys = ['bundle', 'prepare', 'export', 'archive', 'receipt', 'device', 'device_artifact', 'store'];
// Two shapes of one store lane. With ios.export (Tower, Navi) the Linux half writes the App Store Xcode project: archive and
// receipt name it, and the app's upload hook signs and uploads it on the Mac. Without ios.export (a Mac-only app, Green In
// Between) the Mac builds the App Store IPA itself: `build` is the hook (it runs in a dry run too, so the signing is proven
// before a version is spent) and `artifact` the IPA it leaves in $HUB_OUT/ios, which the hub checks (bundle, version, build,
// signer, an App Store profile) before upload and assign are called. `bundle` names a store bundle id that differs from the
// iPad's development one; the policy pins it (apps.<repo>.ios.store_bundle).
const storeKeys = ['bundle', 'archive', 'receipt', 'build', 'artifact', 'upload', 'assign', 'signer_sha1', 'secrets'];

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

function androidSection(android) {
  exactKeys('android', android, androidKeys);
  const pkg = text('android', android, 'package', { required: true });
  if (!/^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/.test(pkg)) fail('android.package must be a reverse-DNS package name');
  text('android', android, 'prepare');
  relativePath('android', android, 'receipt');
  const sideload = text('android', android, 'export') ?? android.godot;
  if (android.godot !== undefined) {
    exactKeys('android.godot', android.godot, ['path', 'preset']);
    text('android.godot', android.godot, 'path', { required: true });
    text('android.godot', android.godot, 'preset', { required: true });
    if (android.export !== undefined) fail('android declares both export and godot; pick one');
  }
  // Every deploy installs the sideload APK on the S26, so the APK lane is required; Play's AAB is extra.
  if (sideload === undefined) fail('android needs an export hook or a godot section: every deploy installs the APK on the S26');
  relativePath('android', android, 'artifact', { suffix: '.apk', required: true });
  if (!/^[0-9a-f]{64}$/.test(android.signer_sha256 ?? '')) fail('android.signer_sha256 must be a lowercase hex SHA-256 digest');
  if (android.bundle !== undefined) {
    text('android', android, 'bundle');
    relativePath('android', android, 'bundle_artifact', { suffix: '.aab', required: true });
  } else if (android.bundle_artifact !== undefined) {
    fail('android.bundle_artifact needs android.bundle');
  }
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
  if (manifest.ios !== undefined) iosSection(manifest.ios);
  return manifest;
}

export async function loadManifest(cwd, path) {
  let source;
  try { source = await readFile(join(cwd, path), 'utf8'); } catch (error) { fail(`cannot read ${path} (${error.code ?? error.message})`); }
  return parseManifest(source);
}
