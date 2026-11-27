// Play Console upload over the Google Play Developer HTTP API. The bearer token comes from the caller's
// keyless OIDC exchange (google-github-actions/auth); no service-account key exists anywhere.
//
// Safety rails: it refuses a versionCode at or below the Console maximum, it deletes its edit on any failure,
// and the release status defaults to `completed` on the internal track (testers get it at once) and to `draft` on every
// other track. Google refuses a non-draft release on an app that has never been published ("draft app"): when the
// status came from that default, the upload is retried once in the same edit as a draft and says so. An explicit
// status from a caller is never softened, and no other error is swallowed.
//
// Chain of custody: the hub hashes the exact bytes it uploads, and Play's own upload answer carries sha1/sha256 of
// what it stored. They must match or the lane fails (HUB_PLAY_BUNDLE_MISMATCH) and the edit is deleted — nothing is
// committed. The same digest pair goes into the receipt so the retention step and the readback can re-verify later.
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const api = 'https://androidpublisher.googleapis.com/androidpublisher/v3/applications';
const upload = 'https://androidpublisher.googleapis.com/upload/androidpublisher/v3/applications';

// What the app's android.bundle hook may rely on (MOBI-18), the same for every app that ships a Play bundle:
//   HUB_PLAY_PACKAGE          the application id Play serves (policy store_package, else the device package)
//   HUB_PLAY_UPLOAD_SHA256    the Play upload certificate the bundle must be signed with (policy store_upload_sha256);
//                             absent for an app that uploads under its device package
//   HUB_PLAY_SIGNING_KEY_REF / _ALIAS_REF / _PASSWORD_REF
//                             the op:// references of the manifest's android.bundle_signing, when it declares them
// References, never values: the hub does not read the secret and the hook does its own `op read`. The hub sets exactly
// these names on the bundle hook and clears them everywhere else, so a stale one in the runner's environment never
// reaches a hook. After the hook the hub reads the bundle itself (lib/aab.mjs) and trusts none of it.
export const playHookVariables = Object.freeze(['HUB_PLAY_PACKAGE', 'HUB_PLAY_UPLOAD_SHA256', 'HUB_PLAY_SIGNING_KEY_REF', 'HUB_PLAY_SIGNING_ALIAS_REF', 'HUB_PLAY_SIGNING_PASSWORD_REF']);

export function playHookEnv(base, target, signing) {
  const env = { ...base };
  for (const name of playHookVariables) delete env[name];
  env.HUB_PLAY_PACKAGE = target.package;
  if (target.uploadSha256) env.HUB_PLAY_UPLOAD_SHA256 = target.uploadSha256;
  if (signing) Object.assign(env, { HUB_PLAY_SIGNING_KEY_REF: signing.key_ref, HUB_PLAY_SIGNING_ALIAS_REF: signing.alias_ref, HUB_PLAY_SIGNING_PASSWORD_REF: signing.password_ref });
  return env;
}

export function defaultPlayStatus(track) {
  return track === 'internal' ? 'completed' : 'draft';
}

// Google's text (HTTP 400, also seen at the :commit step): "Only releases with status draft may be created on draft app."
export function isDraftAppRefusal(error) {
  return /only\s+releases\s+with\s+status\s+draft\s+may\s+be\s+created\s+on\s+draft\s+app/i.test(String(error?.message ?? error));
}

export function highestVersionCode(...listings) {
  return Math.max(0, ...listings.flatMap(listing => [...(listing?.bundles ?? []), ...(listing?.apks ?? [])].map(item => Number(item.versionCode)).filter(Number.isSafeInteger)));
}

// sha1/sha256/byte count of the exact buffer that goes on the wire. The receipt and Play's answer both speak these.
export function digestOf(bytes) {
  return { sha256: createHash('sha256').update(bytes).digest('hex'), sha1: createHash('sha1').update(bytes).digest('hex'), bytes: bytes.length };
}

// The name the exact AAB is retained under (a GitHub Release asset or a run-artifact file): app slug + semver + code.
export function bundleFileName(slug, version, code) {
  return `${slug}-${version}-${code}.aab`;
}

export async function uploadBundle({ pkg, track = 'internal', aab, token, expectedCode, status, fetchImpl = fetch, log = console.log }) {
  if (!token) throw new Error('PLAY_TOKEN is empty; the keyless auth step did not run or failed');
  if (!/^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/.test(pkg)) throw new Error(`"${pkg}" is not a package name`);
  const defaulted = status === undefined || status === '';
  let released = defaulted ? defaultPlayStatus(track) : status;
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const call = async (method, url, { body, contentType } = {}) => {
    const response = await fetchImpl(url, { method, headers: contentType ? { ...headers, 'Content-Type': contentType } : headers, body });
    if (!response.ok) throw new Error(`Play ${method} ${new URL(url).pathname}:${response.status} ${(await response.text()).slice(0, 600)}`);
    return response.status === 204 ? null : response.json();
  };

  const bytes = await readFile(aab);
  const digest = digestOf(bytes);
  const edit = (await call('POST', `${api}/${pkg}/edits`, { body: '{}' })).id;
  log(`PLAY_EDIT ${edit}`);
  try {
    const max = highestVersionCode(await call('GET', `${api}/${pkg}/edits/${edit}/bundles`), await call('GET', `${api}/${pkg}/edits/${edit}/apks`));
    if (expectedCode !== undefined && expectedCode <= max) throw new Error(`versionCode ${expectedCode} is not above the Console maximum ${max}; bump version/code first`);
    const uploaded = await call('POST', `${upload}/${pkg}/edits/${edit}/bundles?uploadType=media`, { body: bytes, contentType: 'application/octet-stream' });
    const code = Number(uploaded.versionCode);
    if (!Number.isSafeInteger(code) || code <= max) throw new Error(`uploaded versionCode ${uploaded.versionCode} is not above the Console maximum ${max}`);
    if (expectedCode !== undefined && code !== expectedCode) throw new Error(`the bundle carries versionCode ${code} but the presets say ${expectedCode}`);
    // Play's answer carries sha1/sha256 of what it stored (same hex form sha256sum prints). A mismatch means the bytes
    // Play received are not the bytes the hub hashed and retains, so the lane fails here — before any track/commit.
    const playSha256 = String(uploaded.sha256 ?? '').toLowerCase();
    const playSha1 = String(uploaded.sha1 ?? '').toLowerCase();
    if (playSha256 !== digest.sha256 || (playSha1 && playSha1 !== digest.sha1)) {
      throw new Error(`HUB_PLAY_BUNDLE_MISMATCH ${pkg} versionCode=${code}: the hub hashed sha256=${digest.sha256} sha1=${digest.sha1} of the exact ${digest.bytes}-byte AAB it sent, but Play stored sha256=${playSha256 || '(absent)'} sha1=${playSha1 || '(absent)'}; the edit is deleted and nothing was committed`);
    }
    log(`HUB_PLAY_BUNDLE_VERIFIED ${pkg} versionCode=${code} sha256=${digest.sha256} play_sha256=${playSha256} bytes=${digest.bytes}`);
    log(`PLAY_UPLOADED versionCode=${code}`);
    const assign = state => call('PUT', `${api}/${pkg}/edits/${edit}/tracks/${track}`, { body: JSON.stringify({ track, releases: [{ versionCodes: [String(code)], status: state }] }) });
    try {
      await assign(released);
      await call('POST', `${api}/${pkg}/edits/${edit}:commit`);
    } catch (error) {
      if (!defaulted || released !== 'completed' || !isDraftAppRefusal(error)) throw error;
      released = 'draft';
      log(`PLAY_DRAFT_APP ${pkg} track=${track} versionCode=${code} Google refuses a completed release on a draft app; released as draft, roll out in Play Console`);
      await assign(released);
      await call('POST', `${api}/${pkg}/edits/${edit}:commit`);
    }
    log(`PLAY_COMMITTED ${pkg} track=${track} status=${released} versionCode=${code}`);
    return { edit, versionCode: code, track, status: released, bundle: { sha256: digest.sha256, sha1: digest.sha1, bytes: digest.bytes, play_sha256: playSha256, play_sha1: playSha1 || null } };
  } catch (error) {
    try { await call('DELETE', `${api}/${pkg}/edits/${edit}`); log(`PLAY_EDIT_DELETED ${edit}`); } catch { /* the edit expires on its own */ }
    throw error;
  }
}

// ---------------------------------------------------------------------------------------------------- read-only readback

const readbackRefuse = detail => new Error(`HUB_PLAY_READBACK_REFUSED ${detail}`);

// Every request the readback may make, decided from method + path before any fetch. Anything else — a commit, a track
// write, an upload, a different host — is refused by construction, so a future edit of this file cannot quietly widen it.
export function readOnlyRequest(method, url, pkg) {
  let parsed;
  try { parsed = new URL(url); } catch { throw readbackRefuse(url); }
  if (parsed.origin !== 'https://androidpublisher.googleapis.com') throw readbackRefuse(`${method} ${parsed.origin} is not the Play API host`);
  const m = method.toUpperCase();
  const base = '/androidpublisher/v3/applications';
  const edits = `${base}/${pkg}/edits`;
  if (m === 'POST' && parsed.pathname === edits && parsed.search === '') return parsed.toString();
  const tail = parsed.pathname.startsWith(`${edits}/`) ? parsed.pathname.slice(`${edits}/`.length) : null;
  if (tail && parsed.search === '') {
    // Exactly the two read verbs on an edit id: its bundles listing and its deletion.
    if (m === 'GET' && /^[^/]+\/bundles$/.test(tail)) return parsed.toString();
    if (m === 'DELETE' && /^[^/]+$/.test(tail)) return parsed.toString();
    throw readbackRefuse(`${method} ${parsed.pathname}: the readback opens an edit only to list its bundles and delete it again`);
  }
  const generated = `${base}/${pkg}/generatedApks`;
  const code = parsed.pathname.startsWith(`${generated}/`) && /^\d+$/.test(parsed.pathname.slice(`${generated}/`.length)) ? parsed.pathname.slice(`${generated}/`.length) : null;
  if (m === 'GET' && code && parsed.search === '') return parsed.toString();
  const download = parsed.pathname.startsWith(`${generated}/`) ? new RegExp(`^(\\d+)/downloads/([^/]+):download$`).exec(parsed.pathname.slice(`${generated}/`.length)) : null;
  if (m === 'GET' && download && parsed.search === '?alt=media') return `${api}/${pkg}/generatedApks/${download[1]}/downloads/${download[2]}:download?alt=media`;
  throw readbackRefuse(`${method} ${parsed.pathname}${parsed.search}`);
}

// The one Google-generated APK a phone would get for this versionCode (deviceTargeting.universalApk per the API docs).
export function universalApkOf(listing) {
  for (const entry of listing?.generatedApks ?? []) {
    const apk = entry?.generatedUniversalApk;
    if (apk?.downloadId) return apk;
  }
  return null;
}

// Read-only proof of what Play serves for one versionCode: open an edit, read the bundle listing (never commit),
// delete the edit again whatever happens, then list + download the Google-generated universal APK (no edit needed).
// apkPath is where the downloaded APK is written. Returns the facts; the caller writes the receipt.
export async function readBack({ pkg, versionCode, token, apkPath, fetchImpl = fetch, log = console.log }) {
  if (!token) throw new Error('PLAY_TOKEN is empty; the keyless auth step did not run or failed');
  if (!/^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/.test(pkg)) throw new Error(`"${pkg}" is not a package name`);
  if (!/^[1-9]\d{0,9}$/.test(String(versionCode))) throw new Error(`"${versionCode}" is not a versionCode`);
  const code = Number(versionCode);
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const call = async (method, url, { body } = {}) => {
    const allowed = readOnlyRequest(method, url, pkg);
    const response = await fetchImpl(allowed, { method, headers, body });
    if (!response.ok) throw new Error(`Play ${method} ${new URL(allowed).pathname}:${response.status} ${(await response.text()).slice(0, 600)}`);
    if (response.status === 204) return null;
    if (String(response.headers?.get?.('content-type') ?? '').includes('application/json')) return response.json();
    return Buffer.from(await response.arrayBuffer());
  };

  let result = null;
  const edit = (await call('POST', `${api}/${pkg}/edits`, { body: '{}' })).id;
  log(`HUB_PLAY_READBACK_EDIT ${edit}: opened read-only (bundles listing only; it is deleted again, never committed)`);
  let editDeleted = false;
  try {
    const listing = await call('GET', `${api}/${pkg}/edits/${edit}/bundles`);
    const bundle = (listing?.bundles ?? []).find(item => Number(item.versionCode) === code);
    if (!bundle) throw new Error(`HUB_PLAY_READBACK_ABSENT ${pkg} versionCode=${code}: Play holds no bundle with that versionCode (known: ${(listing?.bundles ?? []).map(item => item.versionCode).join(', ') || 'none'})`);
    result = { bundle: { versionCode: code, sha256: String(bundle.sha256 ?? '').toLowerCase() || null, sha1: String(bundle.sha1 ?? '').toLowerCase() || null } };
  } finally {
    try { await call('DELETE', `${api}/${pkg}/edits/${edit}`); editDeleted = true; log(`HUB_PLAY_READBACK_EDIT_DELETED ${edit}: nothing was committed`); }
    catch (error) { log(`HUB_PLAY_READBACK_EDIT_DELETED ${edit}: DELETE failed (${String(error?.message ?? error).slice(0, 200)}); the edit expires on its own and was never committed`); }
  }
  const generated = await call('GET', `${api}/${pkg}/generatedApks/${code}`);
  const universal = universalApkOf(generated);
  if (!universal) throw new Error(`HUB_PLAY_READBACK_PENDING ${pkg} versionCode=${code}: Google has not generated the universal APK yet; re-run the readback in a few minutes`);
  const bytes = await call('GET', `${api}/${pkg}/generatedApks/${code}/downloads/${universal.downloadId}:download?alt=media`);
  if (!Buffer.isBuffer(bytes)) throw new Error(`the universal APK download for ${pkg} ${code} did not return bytes`);
  await mkdir(dirname(apkPath), { recursive: true });
  await writeFile(apkPath, bytes);
  const digest = digestOf(bytes);
  return {
    ...result,
    edit,
    edit_deleted: editDeleted,
    apk: {
      download_id: universal.downloadId,
      bytes: digest.bytes,
      sha256: digest.sha256,
      sha1: digest.sha1,
      certificate_sha256: String(universal.certificateSha256Hash ?? '').toLowerCase() || null,
      path: apkPath,
    },
  };
}
