// Who may read what in the build directory (MOBI-17, docs/private-device-builds.md). One model, generated from
// tools/ci/policy.json, used three ways so they cannot disagree:
//   bucketPolicy   the MinIO bucket policy of `builds` (committed as tools/ci/bucket-policy.json, applied and checked by
//                  tools/bucket-policy.mjs): the ONLY place access is enforced
//   isAnonymous    whether a key is anonymously readable under it (pages, links and cache headers follow it)
//   publicText     the write-time guard: an anonymous object never carries a presigned link, and never a link to a device
//                  APK that is not public
//
// The rule: nothing is anonymous unless the policy says why.
//   - a public edition (apps.<repo>.android.editions.<name>.public)   builds/<slug>/editions/<name>/*        (MOBI-14)
//   - a public device edition (apps.<repo>.android.public)            builds/<slug>/*                       (opt-in)
//   - an app with an iOS lane: what the iPad and the Mac's catch-up read without a key (D4): the over-the-air manifest,
//     IPAs and icons, the app page with its Install on iPad button
//   - every app's two pointers, latest.json and inflight.json: they name a build and never grant it (the bucket policy
//     refuses the APK they name). Anonymous so the catch-up's two-minute pass reads them without 1Password, whose
//     account allows 1000 service-account reads a day; a signed read every pass would spend 1440
//   - the root index (builds/index.html, index.json), rendered with only anonymous links
// Everything else needs the hub's credentials or a presigned link: device APKs, their checksums, receipts and release
// notes, an Android-only app's page. No one lists the bucket anonymously.
import { presignedMark } from './sigv4.mjs';

const slugPattern = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// What one app's policy entry opens. A device edition is public only when the policy says so, and an app that sells a
// public edition can never also publish its device edition (the parser refuses it; this holds even for a policy built
// in a test).
export function accessOf(app) {
  const editions = Object.entries(app?.android?.editions ?? {}).filter(([, pin]) => pin?.public === true).map(([name]) => name).sort();
  const devicePublic = app?.android?.public === true && editions.length === 0;
  const ios = Array.isArray(app?.lanes) && app.lanes.includes('ios');
  return Object.freeze({
    slug: app?.slug,
    devicePublic,
    ios,
    publicEditions: Object.freeze(editions),
    // The app page: anonymous where an anonymous reader needs it (the S26 of a friend or a client for a public device
    // edition; the iPad for an iOS lane).
    pageOpen: devicePublic || ios,
    // The pointers name a build and never grant it, so they are anonymous for every app (see the header).
    pointersOpen: true,
  });
}

export const accessFor = (policy, slug) => accessOf(Object.values(policy.apps).find(app => app.slug === slug));

const arn = (bucket, key) => `arn:aws:s3:::${bucket}/${key}`;

// The bucket policy, deterministic (apps in slug order), so a diff of the committed file means a real change.
export function bucketPolicy(policy) {
  const { bucket } = policy.delivery.s3;
  const apps = Object.values(policy.apps).map(accessOf).sort((a, b) => (a.slug < b.slug ? -1 : 1));
  for (const access of apps) if (!slugPattern.test(access.slug ?? '')) throw new Error(`bad slug "${access.slug}"`);
  const statement = (sid, keys) => (keys.length === 0 ? null : { Sid: sid, Effect: 'Allow', Principal: { AWS: ['*'] }, Action: ['s3:GetObject'], Resource: keys.map(key => arn(bucket, key)) });
  const statements = [
    statement('PublicEditions', apps.flatMap(access => access.publicEditions.map(name => `${access.slug}/editions/${name}/*`))),
    statement('PublicDeviceEditions', apps.filter(access => access.devicePublic).map(access => `${access.slug}/*`)),
    statement('Pointers', apps.filter(access => access.pointersOpen && !access.devicePublic).flatMap(access => [`${access.slug}/latest.json`, `${access.slug}/inflight.json`])),
    statement('IpadOverTheAir', apps.filter(access => access.ios && !access.devicePublic).flatMap(access => [
      `${access.slug}/index.html`, `${access.slug}/ios/manifest.plist`,
      `${access.slug}/*.ipa`, `${access.slug}/*/icon-57.png`, `${access.slug}/*/icon-512.png`,
    ])),
    statement('BuildIndex', ['index.html', 'index.json']),
  ].filter(Boolean);
  return { Version: '2012-10-17', Statement: statements };
}

export const renderBucketPolicy = policy => `${JSON.stringify(bucketPolicy(policy), null, 2)}\n`;

// MinIO's resource match: '*' is any run of characters ('/' included), '?' is one.
export function wildcard(pattern, text) {
  const regex = new RegExp(`^${pattern.split('').map(char => (char === '*' ? '.*' : char === '?' ? '.' : escape(char))).join('')}$`, 's');
  return regex.test(text);
}

// The anonymous GetObject resources of a bucket policy document, as keys relative to the bucket.
export function anonymousResources(doc, bucket) {
  const prefix = `arn:aws:s3:::${bucket}/`;
  const out = [];
  for (const item of doc?.Statement ?? []) {
    const principal = item.Principal === '*' || [].concat(item.Principal?.AWS ?? []).includes('*');
    const actions = [].concat(item.Action ?? []);
    if (item.Effect !== 'Allow' || !principal || !actions.some(action => action === 's3:GetObject' || action === 's3:*' || action === '*')) continue;
    for (const resource of [].concat(item.Resource ?? [])) if (resource.startsWith(prefix)) out.push(resource.slice(prefix.length));
  }
  return out.sort();
}

// Whether the anonymous public may list the bucket under a policy document (it never may under the hub's).
export function anonymousListing(doc) {
  return (doc?.Statement ?? []).some(item => item.Effect === 'Allow' && (item.Principal === '*' || [].concat(item.Principal?.AWS ?? []).includes('*'))
    && [].concat(item.Action ?? []).some(action => ['s3:ListBucket', 's3:ListBucketVersions', 's3:ListBucketMultipartUploads', 's3:*', '*'].includes(action)));
}

export function isAnonymous(policy, key) {
  return anonymousResources(bucketPolicy(policy), policy.delivery.s3.bucket).some(pattern => wildcard(pattern, key));
}

// A device APK of an app whose device edition is not public, anywhere in a text (a key or a full URL).
export function privateApkPattern(policy) {
  const slugs = Object.values(policy.apps).map(accessOf).filter(access => !access.devicePublic).map(access => escape(access.slug));
  if (slugs.length === 0) return null;
  return new RegExp(`(?:^|[^A-Za-z0-9._-])(${slugs.join('|')})/\\d+\\.\\d+\\.\\d+/\\1-\\d+\\.\\d+\\.\\d+-\\d+\\.apk`);
}

// latest.json and inflight.json name the device APK's key (the pointer the catch-up follows), never grant it: they are
// anonymous for every app, and the bucket policy is what refuses the APK itself.
const pointerKey = key => /^[a-z0-9][a-z0-9-]*\/(latest|inflight)\.json$/.test(key);

// The write-time guard (createS3.putText): what an anonymous object may never carry.
export function publicTextProblem(policy, key, text) {
  if (!isAnonymous(policy, key)) return null;
  if (presignedMark.test(text)) return `${key} is anonymously readable and would carry a presigned link`;
  const pattern = privateApkPattern(policy);
  const hit = pattern && !pointerKey(key) ? pattern.exec(text) : null;
  if (hit) return `${key} is anonymously readable and would link a private device APK (${hit[0].replace(/^[^A-Za-z0-9]/, '')})`;
  return null;
}

export function assertPublicText(policy, key, text) {
  const problem = publicTextProblem(policy, key, String(text));
  if (problem) throw new Error(`HUB_ACCESS_REFUSED ${problem}; nothing was written (docs/private-device-builds.md)`);
}

// Cache headers by access: an object only the hub or a presigned link may read is `private`, so no shared cache
// (Cloudflare in front of https://s3.delo.sh) ever keeps a copy it could hand to someone else.
export function cacheControlFor(mutable, anonymous) {
  if (anonymous) return mutable ? 'no-cache' : 'public, max-age=31536000, immutable';
  return mutable ? 'private, no-cache' : 'private, max-age=31536000, immutable';
}

// How long a presigned link lives: the most SigV4 allows, so a notification stays useful for a week.
export const linkLifetimeS = 7 * 24 * 3600;
// What a presigned answer tells every cache.
export const linkCacheControl = 'private, no-store';
