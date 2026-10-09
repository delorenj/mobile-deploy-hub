// The app's mobile-deploy.json: hook commands and identity pins, read from the committed file at the built ref.
// Strict on purpose: an unknown key is a typo, and a hook that is not a plain string never reaches a shell.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const topKeys = ['schema', 'version', 'android', 'ios'];
const androidKeys = ['package', 'prepare', 'export', 'godot', 'bundle', 'bundle_artifact', 'artifact', 'receipt', 'signer_sha256'];
const iosKeys = ['bundle', 'prepare', 'export', 'archive', 'receipt', 'upload', 'assign', 'secrets', 'signer_sha1'];

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
  if (suffix && !found.endsWith(suffix)) fail(`${section}.${key} must end in ${suffix}`);
  return found;
}

export function parseManifest(source) {
  let manifest;
  try { manifest = JSON.parse(source); } catch (error) { fail(`not valid JSON (${error.message})`); }
  exactKeys('manifest', manifest, topKeys);
  if (manifest.schema !== 1) fail(`schema must be 1, got ${JSON.stringify(manifest.schema)}`);
  text('manifest', manifest, 'version', { required: true });
  if (!manifest.android && !manifest.ios) fail('declare at least one of android or ios');

  if (manifest.android !== undefined) {
    const android = manifest.android;
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
    if (sideload === undefined && android.bundle === undefined) fail('android needs an export hook, a godot section or a bundle hook');
  }

  if (manifest.ios !== undefined) {
    const ios = manifest.ios;
    exactKeys('ios', ios, iosKeys);
    const bundle = text('ios', ios, 'bundle', { required: true });
    if (!/^[A-Za-z][A-Za-z0-9-]*(\.[A-Za-z][A-Za-z0-9-]*)+$/.test(bundle)) fail('ios.bundle must be a reverse-DNS bundle id');
    text('ios', ios, 'prepare');
    for (const key of ['export', 'upload', 'assign']) text('ios', ios, key, { required: true });
    relativePath('ios', ios, 'archive', { suffix: '.tgz', bare: true, required: true });
    relativePath('ios', ios, 'receipt', { suffix: '.json', bare: true, required: true });
    if (ios.signer_sha1 !== undefined && !/^[0-9A-F]{40}$/.test(ios.signer_sha1)) fail('ios.signer_sha1 must be an uppercase hex SHA-1 fingerprint');
    if (ios.secrets !== undefined) {
      if (!Array.isArray(ios.secrets) || ios.secrets.some(ref => typeof ref !== 'string' || !ref.startsWith('op://'))) fail('ios.secrets must list op:// references');
    }
  }
  return manifest;
}

export async function loadManifest(cwd, path) {
  let source;
  try { source = await readFile(join(cwd, path), 'utf8'); } catch (error) { fail(`cannot read ${path} (${error.code ?? error.message})`); }
  return parseManifest(source);
}
