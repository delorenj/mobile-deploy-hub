// AWS Signature Version 4 for the build directory (MOBI-17, docs/private-device-builds.md): the two forms the hub needs,
// with nothing but node:crypto.
//   signedHeaders  an authenticated GET (the hub's own reads of private objects, over the loopback port)
//   presign        a time-limited GET link (the "Install APK" button of a device edition that is not public), against
//                  the public host https://s3.delo.sh so a phone away from home can open it
// MinIO speaks the same protocol. The bucket has no region of its own, so the scope is us-east-1, MinIO's default.
// A presigned URL carries the access key id (never the secret) and is a capability until it expires: it goes only into
// the notification and the event, never into an object anyone can read (lib/access.mjs refuses that at the write).
import { createHash, createHmac } from 'node:crypto';

export const region = 'us-east-1';
// SigV4's own ceiling for a presigned URL: seven days.
export const maxPresignS = 7 * 24 * 3600;
export const emptySha256 = createHash('sha256').update('').digest('hex');

const sha256Hex = text => createHash('sha256').update(text, 'utf8').digest('hex');
const hmac = (key, text) => createHmac('sha256', key).update(text, 'utf8').digest();

// RFC 3986 unreserved characters stay; everything else is %XX (upper case), as SigV4 requires. A path keeps its '/'.
export const encode = text => encodeURIComponent(String(text)).replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
const encodePath = path => path.split('/').map(encode).join('/');

export const amzDate = date => date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');

function checkCredentials(credentials) {
  if (!credentials || typeof credentials.access !== 'string' || typeof credentials.secret !== 'string' || credentials.access === '' || credentials.secret === '') throw new Error('signing needs an access key and a secret');
}

export function signingKey(secret, day, where = region) {
  return hmac(hmac(hmac(hmac(`AWS4${secret}`, day), where), 's3'), 'aws4_request');
}

// The canonical request of one GET: path, sorted query, the signed headers (lower case, sorted), the payload hash.
function canonical({ method, url, query, headers, payload }) {
  const names = Object.keys(headers).map(name => name.toLowerCase()).sort();
  const lowered = Object.fromEntries(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), String(value).trim().replace(/\s+/g, ' ')]));
  const canonicalQuery = [...query].map(([name, value]) => [encode(name), encode(value)]).sort(([a, x], [b, y]) => (a < b ? -1 : a > b ? 1 : x < y ? -1 : x > y ? 1 : 0)).map(([name, value]) => `${name}=${value}`).join('&');
  const request = [method, encodePath(decodeURIComponent(url.pathname)), canonicalQuery, names.map(name => `${name}:${lowered[name]}\n`).join(''), names.join(';'), payload].join('\n');
  return { request, signed: names.join(';') };
}

function signature({ credentials, date, request, where }) {
  const day = amzDate(date).slice(0, 8);
  const scope = `${day}/${where}/s3/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate(date), scope, sha256Hex(request)].join('\n');
  return { scope, value: createHmac('sha256', signingKey(credentials.secret, day, where)).update(toSign, 'utf8').digest('hex') };
}

// Headers for an authenticated GET of `url`. `extra` are more headers to sign (the tests use AWS's own Range example).
export function signedHeaders({ credentials, url, method = 'GET', now = new Date(), extra = {}, where = region }) {
  checkCredentials(credentials);
  const target = new URL(url);
  const headers = { host: target.host, 'x-amz-content-sha256': emptySha256, 'x-amz-date': amzDate(now), ...extra };
  const { request, signed } = canonical({ method, url: target, query: target.searchParams, headers, payload: emptySha256 });
  const { scope, value } = signature({ credentials, date: now, request, where });
  const { host: _host, ...rest } = headers;
  return { ...rest, authorization: `AWS4-HMAC-SHA256 Credential=${credentials.access}/${scope}, SignedHeaders=${signed}, Signature=${value}` };
}

// A presigned GET link to `url`, valid for `expiresS` seconds from `now` (1 second to 7 days). `responseCacheControl`
// rides in the signed query as response-cache-control, so the answer to the link tells every cache (Cloudflare
// included) not to keep it, whatever the object's own metadata says.
export function presign({ credentials, url, expiresS, now = new Date(), responseCacheControl = null, where = region }) {
  checkCredentials(credentials);
  if (!Number.isSafeInteger(expiresS) || expiresS < 1 || expiresS > maxPresignS) throw new Error(`a presigned link lives 1 second to 7 days, not ${expiresS} seconds`);
  const target = new URL(url);
  if (target.protocol !== 'https:' && target.hostname !== '127.0.0.1') throw new Error(`refusing to presign ${target.protocol}//${target.host}: links are https`);
  if (target.search !== '' || target.username !== '' || target.password !== '') throw new Error('presign takes a plain object URL');
  const day = amzDate(now).slice(0, 8);
  const query = new URLSearchParams();
  query.set('X-Amz-Algorithm', 'AWS4-HMAC-SHA256');
  query.set('X-Amz-Credential', `${credentials.access}/${day}/${where}/s3/aws4_request`);
  query.set('X-Amz-Date', amzDate(now));
  query.set('X-Amz-Expires', String(expiresS));
  query.set('X-Amz-SignedHeaders', 'host');
  if (responseCacheControl) query.set('response-cache-control', responseCacheControl);
  const { request } = canonical({ method: 'GET', url: target, query, headers: { host: target.host }, payload: 'UNSIGNED-PAYLOAD' });
  const { value } = signature({ credentials, date: now, request, where });
  const pairs = [...query].map(([name, value_]) => `${encode(name)}=${encode(value_)}`);
  return `${target.origin}${encodePath(decodeURIComponent(target.pathname))}?${pairs.join('&')}&X-Amz-Signature=${value}`;
}

// What a presigned link says about itself: when it was signed, how long it lives, when it ends. null for a plain URL.
export function presignedFacts(url) {
  let target;
  try { target = new URL(url); } catch { return null; }
  const date = target.searchParams.get('X-Amz-Date');
  const expires = Number(target.searchParams.get('X-Amz-Expires'));
  if (!target.searchParams.get('X-Amz-Signature') || !/^\d{8}T\d{6}Z$/.test(date ?? '') || !Number.isSafeInteger(expires)) return null;
  const signedAt = new Date(`${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}T${date.slice(9, 11)}:${date.slice(11, 13)}:${date.slice(13, 15)}Z`);
  return { signedAt, expiresS: expires, endsAt: new Date(signedAt.getTime() + expires * 1000), key: decodeURIComponent(target.pathname) };
}

// The marks every presigned URL carries; an anonymous object must never hold one.
export const presignedMark = /X-Amz-(Signature|Credential)=/i;
