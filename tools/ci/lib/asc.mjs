// A small App Store Connect API client for the listing tool (tools/listing.mjs). It signs the ES256 token itself,
// retries the calls Apple says to retry, and reads the key from 1Password at call time: nothing here (or anywhere in
// the hub) writes a key to a file. Two keys exist: the App Manager key reads and edits a listing; a few calls
// (price schedule, availability) need the Admin key, so HUB_ASC_KEY=admin picks that one.
import { spawnSync } from 'node:child_process';
import { createPrivateKey, sign } from 'node:crypto';

// op:// references only, never values. The hub's own TestFlight lane uses its own copy of the App Manager key.
export const keyRefs = Object.freeze({
  manager: { id: 'op://DeLoSecrets/App Store Connect API Key/key_id', issuer: 'op://DeLoSecrets/App Store Connect API Key/issuer_id', key: 'op://DeLoSecrets/App Store Connect API Key/credential' },
  admin: { id: 'op://DeLoSecrets/App Store Connect/mainAPIKey', issuer: 'op://DeLoSecrets/App Store Connect/Issuer ID', key: 'op://DeLoSecrets/App Store Connect/privateKeyP8_K435TNCV7Z' },
});

export function opRead(ref, { run = spawnSync } = {}) {
  const result = run('op', ['read', '-n', ref], { encoding: 'utf8' });
  if (result.status !== 0 || !result.stdout) throw new Error(`could not read ${ref} from 1Password`);
  return result.stdout;
}

const b64 = value => Buffer.from(JSON.stringify(value)).toString('base64url');

export function token({ id, issuer, key }, now = Math.floor(Date.now() / 1000)) {
  const head = `${b64({ alg: 'ES256', kid: id, typ: 'JWT' })}.${b64({ iss: issuer, iat: now, exp: now + 1200, aud: 'appstoreconnect-v1' })}`;
  return `${head}.${sign('sha256', Buffer.from(head), { key: createPrivateKey(key), dsaEncoding: 'ieee-p1363' }).toString('base64url')}`;
}

export class AscError extends Error {
  constructor(status, method, path, body) {
    const detail = (() => { try { return JSON.parse(body).errors?.slice(0, 3).map(e => `${e.code}: ${e.detail ?? e.title}`).join('; ').slice(0, 600); } catch { return ''; } })();
    super(`ASC ${method} ${path} -> ${status}${detail ? ` (${detail})` : ''}`);
    this.status = status;
  }
}

export function ascClient({ which = process.env.HUB_ASC_KEY || 'manager', read = opRead, fetchImpl = fetch, base = 'https://api.appstoreconnect.apple.com' } = {}) {
  const refs = keyRefs[which];
  if (!refs) throw new Error(`HUB_ASC_KEY must be one of ${Object.keys(keyRefs).join(', ')}`);
  let auth = null;
  const bearer = () => {
    if (!auth) auth = { id: read(refs.id).trim(), issuer: read(refs.issuer).trim(), key: read(refs.key) };
    return token(auth);
  };
  async function call(method, path, body) {
    for (let attempt = 0; ; attempt++) {
      const response = await fetchImpl(path.startsWith('http') ? path : `${base}${path}`, {
        method,
        headers: { Authorization: `Bearer ${bearer()}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      if (response.ok) return response.status === 204 ? null : response.json();
      if ((response.status === 429 || response.status >= 500) && attempt < 3) { await new Promise(r => setTimeout(r, 1000 * 2 ** attempt)); continue; }
      throw new AscError(response.status, method, path, (await response.text()).slice(0, 20000));
    }
  }
  return {
    which,
    get: path => call('GET', path),
    post: (path, body) => call('POST', path, body),
    patch: (path, body) => call('PATCH', path, body),
    delete: path => call('DELETE', path),
    // A bare GET that does not fail on 403/404: the caller wants "not allowed" or "not there" as an answer.
    probe: async path => { try { return { ok: true, body: await call('GET', path) }; } catch (error) { if (error instanceof AscError) return { ok: false, status: error.status }; throw error; } },
    // Uploads one asset the way Apple's reservation flow wants: the operations it hands back, in order, then the commit.
    async putParts(operations, bytes) {
      for (const op of operations) {
        const headers = Object.fromEntries((op.requestHeaders ?? []).map(h => [h.name, h.value]));
        const response = await fetchImpl(op.url, { method: op.method, headers, body: bytes.subarray(op.offset, op.offset + op.length) });
        if (!response.ok) throw new Error(`asset upload part failed: ${response.status}`);
      }
    },
  };
}
