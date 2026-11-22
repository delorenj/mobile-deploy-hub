// Play Console upload over the Google Play Developer HTTP API. The bearer token comes from the caller's
// keyless OIDC exchange (google-github-actions/auth); no service-account key exists anywhere.
//
// Safety rails: it refuses a versionCode at or below the Console maximum, it deletes its edit on any failure,
// and the release status defaults to `completed` on the internal track (testers get it at once) and to `draft` on every
// other track. Google refuses a non-draft release on an app that has never been published ("draft app"): when the
// status came from that default, the upload is retried once in the same edit as a draft and says so. An explicit
// status from a caller is never softened, and no other error is swallowed.
import { readFile } from 'node:fs/promises';

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

  const edit = (await call('POST', `${api}/${pkg}/edits`, { body: '{}' })).id;
  log(`PLAY_EDIT ${edit}`);
  try {
    const max = highestVersionCode(await call('GET', `${api}/${pkg}/edits/${edit}/bundles`), await call('GET', `${api}/${pkg}/edits/${edit}/apks`));
    if (expectedCode !== undefined && expectedCode <= max) throw new Error(`versionCode ${expectedCode} is not above the Console maximum ${max}; bump version/code first`);
    const uploaded = await call('POST', `${upload}/${pkg}/edits/${edit}/bundles?uploadType=media`, { body: await readFile(aab), contentType: 'application/octet-stream' });
    const code = Number(uploaded.versionCode);
    if (!Number.isSafeInteger(code) || code <= max) throw new Error(`uploaded versionCode ${uploaded.versionCode} is not above the Console maximum ${max}`);
    if (expectedCode !== undefined && code !== expectedCode) throw new Error(`the bundle carries versionCode ${code} but the presets say ${expectedCode}`);
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
    return { edit, versionCode: code, track, status: released };
  } catch (error) {
    try { await call('DELETE', `${api}/${pkg}/edits/${edit}`); log(`PLAY_EDIT_DELETED ${edit}`); } catch { /* the edit expires on its own */ }
    throw error;
  }
}
