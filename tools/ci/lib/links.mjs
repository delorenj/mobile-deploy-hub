// The download links a person gets (MOBI-17, docs/private-device-builds.md). A link to something anonymous readers
// can fetch stays the plain public URL. A link to something they cannot (a device APK that is not public, the page of
// an Android-only app) becomes a presigned URL, signed with the hub writer's keys, valid for the most SigV4 allows
// (seven days) and answered with `Cache-Control: private, no-store`. It exists only here, in the notification and the
// event, never in an object anyone can read (lib/access.mjs refuses that at the write). Without keys a private link is
// dropped, never replaced by a URL that answers 403.
import { accessFor, linkCacheControl, linkLifetimeS } from './access.mjs';
import { presign } from './sigv4.mjs';

const sign = (url, { credentials, now }) => presign({ credentials, url, expiresS: linkLifetimeS, now, responseCacheControl: linkCacheControl });

// `published` is what deliver recorded (canonical public URLs). Returns the copy the notification may use, and what
// happened to each private link: { published, minted: ['apk', 'page'], dropped: [...] }.
export function linkable({ policy, slug, published, credentials = null, now = new Date() }) {
  if (!published) return { published, minted: [], dropped: [] };
  const access = accessFor(policy, slug);
  const out = { ...published };
  const minted = [];
  const dropped = [];
  const handle = (field, open) => {
    if (!published[field] || open) return;
    if (!credentials) { out[field] = null; dropped.push(field); return; }
    out[field] = sign(published[field], { credentials, now });
    minted.push(field);
  };
  handle('apk', access.devicePublic);
  handle('page', access.pageOpen);
  return { published: out, minted, dropped };
}
