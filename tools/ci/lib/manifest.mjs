// The app's mobile-deploy.json: hook commands and identity pins, read from the committed file at the built ref.
// Strict on purpose: an unknown key is a typo, and a hook that is not a plain string never reaches a shell.
//
// Schema 2 is the v3 contract (version bump, device installs, one event). Schema 1 is v2's and still parses so a
// v2 caller keeps working until it moves; the hub runs a schema 1 manifest the v2 way (no bump, no installs, no event).
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const topKeys = { 1: ['schema', 'version', 'android', 'ios'], 2: ['schema', 'project', 'version', 'android', 'ios'] };
const androidKeys = ['package', 'prepare', 'export', 'godot', 'bundle', 'bundle_artifact', 'artifact', 'receipt', 'signer_sha256'];
const iosKeys = {
  1: ['bundle', 'prepare', 'export', 'archive', 'receipt', 'upload', 'assign', 'secrets', 'signer_sha1'],
  2: ['bundle', 'prepare', 'export', 'archive', 'receipt', 'device', 'device_artifact', 'store'],
};
const storeKeys = ['archive', 'receipt', 'upload', 'assign', 'signer_sha1', 'secrets'];

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

// A path inside the app checkout (artifact, receipt) or a bare file name inside the hub output folder.
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
  if (sideload !== undefined) {
    relativePath('android', android, 'artifact', { suffix: '.apk', required: true });
    if (!/^[0-9a-f]{64}$/.test(android.signer_sha256 ?? '')) fail('android.signer_sha256 must be a lowercase hex SHA-256 digest');
  } else if (android.artifact !== undefined || android.signer_sha256 !== undefined) {
    fail('android.artifact and android.signer_sha256 need an export hook or a godot section');
  }
  if (android.bundle !== undefined) {
    text('android', android, 'bundle');
    relativePath('android', android, 'bundle_artifact', { suffix: '.aab', required: true });
  } else if (android.bundle_artifact !== undefined) {
    fail('android.bundle_artifact needs android.bundle');
  }
  return sideload;
}

function bundleId(section, value) {
  const bundle = text(section, value, 'bundle', { required: true });
  if (!/^[A-Za-z][A-Za-z0-9-]*(\.[A-Za-z][A-Za-z0-9-]*)+$/.test(bundle)) fail(`${section}.bundle must be a reverse-DNS bundle id`);
}

function schemaOne(manifest) {
  text('manifest', manifest, 'version', { required: true });
  if (manifest.android !== undefined) {
    const sideload = androidSection(manifest.android);
    if (sideload === undefined && manifest.android.bundle === undefined) fail('android needs an export hook, a godot section or a bundle hook');
  }
  if (manifest.ios !== undefined) {
    const ios = manifest.ios;
    exactKeys('ios', ios, iosKeys[1]);
    bundleId('ios', ios);
    text('ios', ios, 'prepare');
    for (const key of ['export', 'upload', 'assign']) text('ios', ios, key, { required: true });
    relativePath('ios', ios, 'archive', { suffix: '.tgz', bare: true, required: true });
    relativePath('ios', ios, 'receipt', { suffix: '.json', bare: true, required: true });
    sha1('ios', ios);
    secrets('ios', ios);
  }
}

function schemaTwo(manifest) {
  exactKeys('project', manifest.project, ['slug', 'name']);
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(manifest.project.slug ?? '')) fail('project.slug must be the pjangler slug (lowercase, digits, dashes)');
  const name = text('project', manifest.project, 'name', { required: true });
  if (name.length > 120) fail('project.name must be at most 120 characters');
  exactKeys('version', manifest.version, ['read', 'bump']);
  text('version', manifest.version, 'read', { required: true });
  text('version', manifest.version, 'bump', { required: true });
  if (manifest.android !== undefined) {
    // Every v3 deploy installs the sideload APK on the S26, so the APK lane is required; Play's AAB is extra.
    if (androidSection(manifest.android) === undefined) fail('android needs an export hook or a godot section: every deploy installs the APK on the S26');
  }
  if (manifest.ios !== undefined) {
    const ios = manifest.ios;
    exactKeys('ios', ios, iosKeys[2]);
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
      if (!linux) fail('ios.store needs ios.export: the Linux export writes the App Store Xcode project');
      relativePath('ios.store', ios.store, 'archive', { suffix: '.tgz', bare: true, required: true });
      relativePath('ios.store', ios.store, 'receipt', { suffix: '.json', bare: true, required: true });
      if (ios.store.archive === ios.archive) fail('ios.store.archive must differ from ios.archive: the iPad gets the private project, TestFlight the store one');
      for (const key of ['upload', 'assign']) text('ios.store', ios.store, key, { required: true });
      sha1('ios.store', ios.store);
      secrets('ios.store', ios.store);
    }
  }
}

export function parseManifest(source) {
  let manifest;
  try { manifest = JSON.parse(source); } catch (error) { fail(`not valid JSON (${error.message})`); }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) fail('manifest must be an object');
  if (manifest.schema !== 1 && manifest.schema !== 2) fail(`schema must be 2 (or 1 for a v2 caller), got ${JSON.stringify(manifest.schema)}`);
  exactKeys('manifest', manifest, topKeys[manifest.schema]);
  if (!manifest.android && !manifest.ios) fail('declare at least one of android or ios');
  if (manifest.schema === 1) schemaOne(manifest);
  else schemaTwo(manifest);
  return manifest;
}

export async function loadManifest(cwd, path) {
  let source;
  try { source = await readFile(join(cwd, path), 'utf8'); } catch (error) { fail(`cannot read ${path} (${error.code ?? error.message})`); }
  return parseManifest(source);
}
