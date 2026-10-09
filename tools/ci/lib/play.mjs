// Play Console upload over the Google Play Developer HTTP API. The bearer token comes from the caller's
// keyless OIDC exchange (google-github-actions/auth); no service-account key exists anywhere.
//
// Safety rails: it refuses a versionCode at or below the Console maximum, it deletes its edit on any failure,
// and the release status defaults to draft, because a `completed` release on an app that has never been
// released is likely rejected (unverified).
import { readFile } from 'node:fs/promises';

const api = 'https://androidpublisher.googleapis.com/androidpublisher/v3/applications';
const upload = 'https://androidpublisher.googleapis.com/upload/androidpublisher/v3/applications';

export function highestVersionCode(...listings) {
  return Math.max(0, ...listings.flatMap(listing => [...(listing?.bundles ?? []), ...(listing?.apks ?? [])].map(item => Number(item.versionCode)).filter(Number.isSafeInteger)));
}

export async function uploadBundle({ pkg, track = 'internal', aab, token, expectedCode, status = 'draft', fetchImpl = fetch, log = console.log }) {
  if (!token) throw new Error('PLAY_TOKEN is empty; the keyless auth step did not run or failed');
  if (!/^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/.test(pkg)) throw new Error(`"${pkg}" is not a package name`);
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
    await call('PUT', `${api}/${pkg}/edits/${edit}/tracks/${track}`, { body: JSON.stringify({ track, releases: [{ versionCodes: [String(code)], status }] }) });
    await call('POST', `${api}/${pkg}/edits/${edit}:commit`);
    log(`PLAY_COMMITTED ${pkg} track=${track} status=${status} versionCode=${code}`);
    return { edit, versionCode: code, track, status };
  } catch (error) {
    try { await call('DELETE', `${api}/${pkg}/edits/${edit}`); log(`PLAY_EDIT_DELETED ${edit}`); } catch { /* the edit expires on its own */ }
    throw error;
  }
}
