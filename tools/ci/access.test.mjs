// MOBI-17 (docs/private-device-builds.md): device-edition APKs stay private. The model (lib/access.mjs), SigV4
// (lib/sigv4.mjs), the write guard and cache headers (lib/s3.mjs), the pages, the notification links (lib/links.mjs),
// the policy parser, and the bucket policy tool (tools/bucket-policy.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { accessFor, accessOf, anonymousListing, anonymousResources, assertPublicText, bucketPolicy, cacheControlFor, isAnonymous, linkCacheControl, linkLifetimeS, privateApkPattern, publicTextProblem, renderBucketPolicy, wildcard } from './lib/access.mjs';
import { linksFor } from './lib/announce.mjs';
import { validateLatest } from './lib/latest.mjs';
import { linkable } from './lib/links.mjs';
import { appPage, indexData, indexPage } from './lib/pages.mjs';
import { loadPolicy, parsePolicy } from './lib/policy.mjs';
import { cacheControlOf, createS3, jobCredentials, publishPages, readObject } from './lib/s3.mjs';
import { amzDate, maxPresignS, presign, presignedFacts, signedHeaders } from './lib/sigv4.mjs';
import { accessMarker, adminRefs, callerRef, check, committedFile, documentDiff, fileProblem, main as bucketMain, normalize, probe, probePlan, probeResults, readiness, rerenderPages, applyDocument, liveDocument } from '../bucket-policy.mjs';
import { deviceRidesRelease } from './commands/android.mjs';

const { policy } = loadPolicy();
const policySource = readFileSync(fileURLToPath(new URL('./policy.json', import.meta.url)), 'utf8');
const keys = { access: 'mobile-deploy-hub', secret: 'Wr1ter-secret-for-tests-only' };
const at = new Date('2026-11-19T12:00:00Z');
const clone = () => structuredClone(policy);
const appOf = (p, slug) => Object.values(p.apps).find(app => app.slug === slug);

// ---------------------------------------------------------------------------------------------------------- SigV4

// AWS's own worked examples (docs.aws.amazon.com, "Signature Calculations for the Authorization Header" and "Authenticating
// Requests: Using Query Parameters"), so the signer is checked against the reference and not only against itself.
const awsKeys = { access: 'AKIAIOSFODNN7EXAMPLE', secret: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY' };
const awsDate = new Date('2013-05-24T00:00:00Z');

test('sigv4: AWS reference vectors (presigned GET and the Range header GET)', () => {
  const url = presign({ credentials: awsKeys, url: 'https://examplebucket.s3.amazonaws.com/test.txt', expiresS: 86400, now: awsDate });
  assert.match(url, /X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404$/);
  const headers = signedHeaders({ credentials: awsKeys, url: 'https://examplebucket.s3.amazonaws.com/test.txt', now: awsDate, extra: { range: 'bytes=0-9' } });
  assert.match(headers.authorization, /SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41$/);
  assert.equal(headers['x-amz-date'], '20130524T000000Z');
  assert.equal(amzDate(awsDate), '20130524T000000Z');
});

test('sigv4: a presigned link has the SigV4 query form, lives at most seven days, and never carries the secret', () => {
  const url = presign({ credentials: keys, url: 'https://s3.delo.sh/builds/tower-of-lost-things/1.2.3/tower-of-lost-things-1.2.3-9.apk', expiresS: linkLifetimeS, now: at, responseCacheControl: linkCacheControl });
  const parsed = new URL(url);
  assert.equal(parsed.origin, 'https://s3.delo.sh');
  assert.equal(parsed.pathname, '/builds/tower-of-lost-things/1.2.3/tower-of-lost-things-1.2.3-9.apk');
  assert.equal(parsed.searchParams.get('X-Amz-Algorithm'), 'AWS4-HMAC-SHA256');
  assert.equal(parsed.searchParams.get('X-Amz-Credential'), 'mobile-deploy-hub/20261119/us-east-1/s3/aws4_request');
  assert.equal(parsed.searchParams.get('X-Amz-Expires'), '604800');
  assert.equal(parsed.searchParams.get('X-Amz-SignedHeaders'), 'host');
  assert.equal(parsed.searchParams.get('response-cache-control'), 'private, no-store');
  assert.match(parsed.searchParams.get('X-Amz-Signature'), /^[0-9a-f]{64}$/);
  assert.ok(!url.includes(keys.secret));
  assert.ok(url.length <= 600, `a notification link is at most 600 characters, this one is ${url.length}`);
  const facts = presignedFacts(url);
  assert.deepEqual([facts.signedAt.toISOString(), facts.expiresS, facts.endsAt.toISOString(), facts.key], ['2026-11-19T12:00:00.000Z', 604800, '2026-11-26T12:00:00.000Z', '/builds/tower-of-lost-things/1.2.3/tower-of-lost-things-1.2.3-9.apk']);
  assert.equal(presignedFacts('https://s3.delo.sh/builds/x/latest.json'), null);
});

test('sigv4: expiry outside 1 second to 7 days, plain http, a query and a missing key are refused', () => {
  const base = { credentials: keys, url: 'https://s3.delo.sh/builds/a/b.apk', now: at };
  assert.equal(maxPresignS, 604800);
  for (const expiresS of [0, -1, 604801, 1.5, Number.NaN, undefined]) assert.throws(() => presign({ ...base, expiresS }), /1 second to 7 days/);
  assert.doesNotThrow(() => presign({ ...base, expiresS: 1 }));
  assert.doesNotThrow(() => presign({ ...base, expiresS: 604800 }));
  assert.throws(() => presign({ ...base, url: 'http://s3.delo.sh/builds/a/b.apk', expiresS: 60 }), /links are https/);
  assert.throws(() => presign({ ...base, url: 'https://s3.delo.sh/builds/a/b.apk?x=1', expiresS: 60 }), /plain object URL/);
  assert.throws(() => presign({ ...base, credentials: { access: 'a' }, expiresS: 60 }), /needs an access key and a secret/);
});

test('sigv4: a signed read never puts the secret in a header, and signs the loopback host', () => {
  const headers = signedHeaders({ credentials: keys, url: 'http://127.0.0.1:9012/builds/tower-of-lost-things/latest.json', now: at });
  assert.ok(!JSON.stringify(headers).includes(keys.secret));
  assert.match(headers.authorization, /^AWS4-HMAC-SHA256 Credential=mobile-deploy-hub\/20261119\/us-east-1\/s3\/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/);
  assert.equal(headers.host, undefined, 'fetch sets Host itself');
});

// ---------------------------------------------------------------------------------------------------- the model

test('access: the real policy opens public editions, two public device editions and the iPad lane, and nothing else', () => {
  const by = Object.fromEntries(Object.values(policy.apps).map(app => [app.slug, accessOf(app)]));
  assert.deepEqual(Object.keys(by).sort(), ['earshot', 'gruvato', 'green-in-between', 'navi', 'shortwave', 'tower-of-lost-things'].sort());
  assert.deepEqual(by.earshot.publicEditions, ['beta']);
  assert.equal(by.earshot.devicePublic, false, 'an app that sells a public edition keeps its device edition private');
  assert.equal(by['green-in-between'].devicePublic, true);
  assert.equal(by.navi.devicePublic, true);
  for (const slug of ['shortwave', 'earshot', 'tower-of-lost-things', 'gruvato']) assert.equal(by[slug].devicePublic, false, slug);
  assert.equal(by['tower-of-lost-things'].ios, true);
  assert.equal(by.shortwave.pageOpen, false);
});

test('access: no anonymous listing, no private device APK, receipt, notes or page; public objects stay public', () => {
  const doc = bucketPolicy(policy);
  assert.equal(anonymousListing(doc), false);
  const open = key => isAnonymous(policy, key);
  // D1 + D2: a private app's device edition and everything beside it
  for (const slug of ['shortwave', 'earshot', 'tower-of-lost-things', 'gruvato']) {
    assert.equal(open(`${slug}/1.0.0/${slug}-1.0.0-3.apk`), false, `${slug} apk`);
    assert.equal(open(`${slug}/1.0.0/${slug}-1.0.0-3.apk.sha256`), false);
    assert.equal(open(`${slug}/1.0.0/receipt.json`), false);
    assert.equal(open(`${slug}/1.0.0/receipt-android.json`), false);
    assert.equal(open(`${slug}/1.0.0/release-notes.json`), false);
  }
  assert.equal(open('shortwave/index.html'), false);
  assert.equal(open('earshot/index.html'), false);
  // every app's pointers name a build and never grant it: anonymous, so the catch-up's idle pass needs no 1Password read
  for (const slug of ['shortwave', 'earshot', 'tower-of-lost-things', 'gruvato']) {
    assert.equal(open(`${slug}/latest.json`), true, `${slug} latest.json`);
    assert.equal(open(`${slug}/inflight.json`), true, `${slug} inflight.json`);
  }
  assert.equal(open('earshot/latest.jsonx'), false);
  assert.equal(open('earshot/0.1.10/latest.json'), false, 'only the app-level pointer');
  // D3: the public edition stays anonymous, in its own folder only
  for (const key of ['earshot/editions/beta/index.html', 'earshot/editions/beta/latest.json', 'earshot/editions/beta/1.0.0/earshot-beta-1.0.0-3.apk', 'earshot/editions/beta/1.0.0/receipt.json']) assert.equal(open(key), true, key);
  assert.equal(open('earshot/editions/pro/latest.json'), false, 'only the editions the policy pins public');
  // D4: the iPad lane
  for (const key of ['tower-of-lost-things/index.html', 'tower-of-lost-things/latest.json', 'tower-of-lost-things/inflight.json', 'tower-of-lost-things/ios/manifest.plist', 'tower-of-lost-things/0.2.2/tower-of-lost-things-0.2.2-4.ipa', 'tower-of-lost-things/0.2.2/icon-57.png', 'tower-of-lost-things/0.2.2/icon-512.png']) assert.equal(open(key), true, key);
  assert.equal(open('tower-of-lost-things/0.2.2/receipt.json'), false);
  // an opted-in device edition (the friend beta, the client app)
  assert.equal(open('green-in-between/1.0.0/green-in-between-1.0.0-3.apk'), true);
  assert.equal(open('navi/latest.json'), true);
  // the root index
  assert.equal(open('index.html'), true);
  assert.equal(open('index.json'), true);
  assert.equal(open('somewhere-else.txt'), false);
  assert.equal(open('.probe/x'), false);
});

test('access: a single-edition app (device only) is private; a multi-edition app opens exactly its public editions', () => {
  const single = clone();
  const multi = clone();
  const app = appOf(multi, 'shortwave');
  app.android.editions = { beta: { package: 'sh.delo.shortwave.beta', signer_sha256: 'a'.repeat(64), public: true }, internal: { package: 'sh.delo.shortwave.internal', signer_sha256: 'b'.repeat(64) } };
  assert.equal(isAnonymous(single, 'shortwave/editions/beta/latest.json'), false);
  assert.equal(isAnonymous(multi, 'shortwave/editions/beta/latest.json'), true);
  assert.equal(isAnonymous(multi, 'shortwave/editions/beta/1.0.0/shortwave-beta-1.0.0-1.apk'), true);
  assert.equal(isAnonymous(multi, 'shortwave/editions/internal/1.0.0/shortwave-internal-1.0.0-1.apk'), false);
  assert.equal(isAnonymous(multi, 'shortwave/1.0.0/shortwave-1.0.0-1.apk'), false, 'the device edition stays private beside a public edition');
  assert.equal(anonymousListing(bucketPolicy(multi)), false);
});

test('access: the device edition is public only by explicit opt-in, and never beside a public edition', () => {
  const opt = clone();
  appOf(opt, 'shortwave').android.public = true;
  assert.equal(isAnonymous(opt, 'shortwave/1.0.0/shortwave-1.0.0-1.apk'), true);
  const both = clone();
  const earshot = appOf(both, 'earshot');
  earshot.android.public = true;
  assert.equal(accessOf(earshot).devicePublic, false, 'a public edition wins: the device edition stays private');
  assert.equal(isAnonymous(both, 'earshot/1.0.0/earshot-1.0.0-1.apk'), false);
  // the parser refuses the same combination at the source
  const doc = JSON.parse(policySource);
  doc.apps['delorenj/earshot'] ??= Object.entries(doc.apps).find(([, app]) => app.slug === 'earshot')?.[1];
  const repo = Object.entries(doc.apps).find(([, app]) => app.slug === 'earshot')?.[0] ?? Object.keys(doc.apps)[0];
  doc.apps[repo].android.public = true;
  assert.throws(() => parsePolicy(JSON.stringify(doc)), /android\.public cannot be true: the app publishes the beta edition/);
  const bad = JSON.parse(policySource);
  appOfRaw(bad, 'shortwave').android.public = 'yes';
  assert.throws(() => parsePolicy(JSON.stringify(bad)), /public/);
});

function appOfRaw(doc, slug) { return Object.values(doc.apps).find(app => app.slug === slug); }

test('access: wildcard follows MinIO (star crosses slashes)', () => {
  assert.equal(wildcard('a/*.ipa', 'a/1.0.0/x.ipa'), true);
  assert.equal(wildcard('a/*/icon-57.png', 'a/1.0.0/icon-57.png'), true);
  assert.equal(wildcard('a/*.ipa', 'b/x.ipa'), false);
  assert.equal(wildcard('a/index.html', 'a/index.htmlx'), false);
  assert.deepEqual(anonymousResources({ Statement: [{ Effect: 'Allow', Principal: { AWS: ['*'] }, Action: ['s3:GetObject'], Resource: ['arn:aws:s3:::builds/x/*'] }, { Effect: 'Deny', Principal: '*', Action: 's3:GetObject', Resource: 'arn:aws:s3:::builds/y' }] }, 'builds'), ['x/*']);
  assert.equal(anonymousListing({ Statement: [{ Effect: 'Allow', Principal: '*', Action: 's3:ListBucket', Resource: 'arn:aws:s3:::builds' }] }), true);
});

test('access: the committed bucket policy is exactly what policy.json renders', () => {
  const committed = readFileSync(committedFile, 'utf8');
  assert.equal(committed, renderBucketPolicy(policy), 'run: node tools/bucket-policy.mjs write');
  assert.equal(fileProblem(policy, committed), null);
  assert.match(fileProblem(policy, committed.replace('builds/navi/*', 'builds/nav1/*')), /not what tools\/ci\/policy\.json renders/);
  assert.equal(committed.endsWith('}\n'), true);
});

test('access: no secret, token or credential lives in the committed policy files', () => {
  const text = `${readFileSync(committedFile, 'utf8')}${policySource}`;
  assert.doesNotMatch(text, /AKIA|secret_key|password|token|X-Amz-Signature|BEGIN [A-Z ]*PRIVATE KEY/i);
  assert.match(adminRefs.access, /^op:\/\/DeLoSecrets\/[a-z0-9]{26}\/username$/);
  assert.match(adminRefs.secret, /^op:\/\/DeLoSecrets\/[a-z0-9]{26}\/password$/);
});

// ----------------------------------------------------------------------------------------- the write guard and headers

const runnerCapture = captured => (command, args) => {
  if (args.includes('cp')) {
    const file = args.at(-2);
    captured.push({ key: args.at(-1).replace(/^builds\/builds\//, ''), attr: args[args.indexOf('--attr') + 1], text: readFileSync(file, 'utf8') });
  }
  return { ok: true, status: 0, stdout: '', stderr: '' };
};

test('guard: an anonymous object never carries a presigned link or a private device APK link', () => {
  const captured = [];
  const s3 = createS3({ policy, credentials: keys, env: {}, runner: runnerCapture(captured) });
  const presigned = presign({ credentials: keys, url: 'https://s3.delo.sh/builds/shortwave/1.0.0/shortwave-1.0.0-1.apk', expiresS: 3600, now: at });
  const apkUrl = 'https://s3.delo.sh/builds/shortwave/1.0.0/shortwave-1.0.0-1.apk';
  // anonymous keys refuse both
  assert.throws(() => s3.putText(`<a href="${presigned}">x</a>`, 'index.html'), /HUB_ACCESS_REFUSED index\.html is anonymously readable and would carry a presigned link/);
  assert.throws(() => s3.putText(`<a href="${apkUrl}">x</a>`, 'index.html'), /would link a private device APK \(shortwave\/1\.0\.0\/shortwave-1\.0\.0-1\.apk\)/);
  assert.throws(() => s3.putText(`<a href="${apkUrl}">x</a>`, 'tower-of-lost-things/index.html'), /private device APK/);
  assert.throws(() => s3.putText(`X-Amz-Credential=a`, 'earshot/editions/beta/index.html'), /presigned link/);
  assert.equal(captured.length, 0, 'nothing was written');
  // a private object may name its own APK (the pointer the catch-up follows, and the private page that is not anonymous)
  assert.doesNotThrow(() => s3.putText(`{"url":"${apkUrl}"}`, 'shortwave/latest.json'));
  assert.doesNotThrow(() => s3.putText(`<a href="${apkUrl}">x</a>`, 'shortwave/index.html'));
  // the pointer of an iOS-lane app is anonymous and names its device APK: names, never grants (the policy denies the read)
  assert.doesNotThrow(() => s3.putText('{"url":"https://s3.delo.sh/builds/tower-of-lost-things/0.2.2/tower-of-lost-things-0.2.2-4.apk"}', 'tower-of-lost-things/latest.json'));
  // a public device edition links its own APK freely
  assert.doesNotThrow(() => s3.putText('<a href="https://s3.delo.sh/builds/navi/1.0.0/navi-1.0.0-1.apk">x</a>', 'navi/index.html'));
  assert.equal(publicTextProblem(policy, 'shortwave/index.html', presigned), null, 'a private object is not anonymous, so only the cache header keeps it private');
  assert.throws(() => assertPublicText(policy, 'index.json', presigned), /nothing was written/);
  assert.notEqual(privateApkPattern(policy), null);
});

test('headers: objects anonymous readers cannot get are private in every cache; public ones keep the old headers', () => {
  const captured = [];
  const s3 = createS3({ policy, credentials: keys, env: {}, runner: runnerCapture(captured) });
  s3.putText('{}', 'shortwave/latest.json');
  s3.putText('<p>x</p>', 'shortwave/index.html');
  s3.putText('{}', 'tower-of-lost-things/latest.json');
  s3.putText('{}', 'earshot/editions/beta/latest.json');
  s3.putText('{}', 'shortwave/1.0.0/receipt.json');
  s3.putText('x', 'earshot/editions/beta/1.0.0/receipt.json');
  const attrs = Object.fromEntries(captured.map(item => [item.key, item.attr.split('Cache-Control=')[1]]));
  assert.equal(attrs['shortwave/latest.json'], '"no-cache"', 'a pointer is anonymous');
  assert.equal(attrs['shortwave/index.html'], '"private, no-cache"', 'an Android-only app page is not');
  assert.equal(attrs['tower-of-lost-things/latest.json'], '"no-cache"');
  assert.equal(attrs['earshot/editions/beta/latest.json'], '"no-cache"');
  assert.equal(attrs['shortwave/1.0.0/receipt.json'], '"private, max-age=31536000, immutable"');
  assert.equal(attrs['earshot/editions/beta/1.0.0/receipt.json'], '"public, max-age=31536000, immutable"');
  assert.equal(cacheControlOf('x/latest.json'), 'no-cache');
  assert.equal(cacheControlOf('x/1.0.0/a.apk'), 'public, max-age=31536000, immutable');
  assert.equal(cacheControlFor(true, false), 'private, no-cache');
});

// ------------------------------------------------------------------------------------------------ credentialed reads

test('readObject: signed with the keys when given them, anonymous for null, job keys only inside a job', async () => {
  const seen = [];
  const fetchImpl = async (url, options) => { seen.push({ url, headers: options.headers }); return new Response('{}', { status: 200 }); };
  await readObject(policy, 'shortwave/latest.json', { fetchImpl, credentials: keys, now: () => at });
  assert.equal(seen[0].url, 'http://127.0.0.1:9012/builds/shortwave/latest.json');
  assert.match(seen[0].headers.authorization, /^AWS4-HMAC-SHA256 Credential=mobile-deploy-hub\/20261119\//);
  assert.ok(!JSON.stringify(seen[0].headers).includes(keys.secret));
  await readObject(policy, 'shortwave/latest.json', { fetchImpl, credentials: null });
  assert.equal(seen[1].headers.authorization, undefined);
  await readObject(policy, 'shortwave/latest.json', { fetchImpl, env: { PATH: '/bin' } });
  assert.equal(seen[2].headers.authorization, undefined, 'outside a job (a test, a shell) the read is anonymous');
  const denied = async () => new Response('', { status: 403 });
  await assert.rejects(readObject(policy, 'shortwave/latest.json', { fetchImpl: denied, credentials: null }), /answered 403 \(a private object read without the hub's keys\)/);
  await assert.rejects(readObject(policy, 'shortwave/latest.json', { fetchImpl: denied, credentials: keys }), error => /answered 403$/.test(error.message));
  assert.equal(await readObject(policy, 'x/latest.json', { fetchImpl: async () => new Response('', { status: 404 }), credentials: keys }), null);
  await assert.rejects(jobCredentials({ PATH: '/bin' }), /only inside a workflow job/);
});

// --------------------------------------------------------------------------------------------------------- pages

const apkOf = slug => ({
  package: 'sh.delo.test', version: '1.2.3', code: 9, key: `${slug}/1.2.3/${slug}-1.2.3-9.apk`, url: `https://s3.delo.sh/builds/${slug}/1.2.3/${slug}-1.2.3-9.apk`,
  bytes: 5_000_000, sha256: 'a'.repeat(64), signer_sha256: 'b'.repeat(64), quickdrop: `builds/${slug}-1.2.3-9.apk`,
  device: { name: 'S26', model: 'SM-S948U', status: 'pending', since: '2026-11-19T11:00:00Z', by: null, reason: 'away', failures: 0 },
  run: { repo: 'x/y', id: '1', attempt: 1, url: 'https://github.com/x/y/actions/runs/1' }, correlation: '11111111-1111-5111-8111-111111111111', commit: 'c'.repeat(40),
});
const latestFor = (slug, name = slug) => validateLatest({
  schema: 1, slug, name, version: '1.2.3', commit: 'c'.repeat(40), hub_ref: 'v1.4.0', run: { repo: 'x/y', id: '1', attempt: 1, url: 'https://github.com/x/y/actions/runs/1' },
  correlation: '11111111-1111-5111-8111-111111111111', updated_at: '2026-11-19T11:00:00Z', android: apkOf(slug), ios: null,
}, { slug, base: 'https://s3.delo.sh/builds' });

test('pages: a page links the device APK only for a device-public app; otherwise it says the build is private', () => {
  const latest = latestFor('shortwave');
  const history = [{ version: '1.0.0', code: 3, bytes: 4_000_000, url: 'https://s3.delo.sh/builds/shortwave/1.0.0/shortwave-1.0.0-3.apk' }];
  const privatePage = appPage({ latest, history, access: accessFor(policy, 'shortwave') });
  assert.doesNotMatch(privatePage, /\.apk/);
  assert.doesNotMatch(privatePage, /Install APK|Download retained APK/);
  assert.match(privatePage, /The Android build is private/);
  assert.match(privatePage, /Build history/);
  const open = appPage({ latest: latestFor('navi'), history: history.map(item => ({ ...item, url: item.url.replace('shortwave', 'navi') })), access: accessFor(policy, 'navi') });
  assert.match(open, /Install APK \(5\.0 MB\)/);
  assert.match(open, /Download retained APK/);
  assert.doesNotMatch(open, /The Android build is private/);
  assert.doesNotMatch(appPage({ latest }), /Install APK/, 'a page rendered without an access model is the private one');
});

test('pages: the root index carries a device APK URL or a page link only for apps that publish them', () => {
  const apps = [latestFor('shortwave'), latestFor('navi'), latestFor('tower-of-lost-things')];
  const access = slug => accessFor(policy, slug);
  const data = indexData(apps, { access, now: at });
  const by = Object.fromEntries(data.apps.map(app => [app.slug, app]));
  assert.equal(by.shortwave.page, null);
  assert.equal('url' in by.shortwave.android, false);
  assert.equal(by.navi.page, 'navi/index.html');
  assert.match(by.navi.android.url, /navi-1\.2\.3-9\.apk$/);
  assert.equal(by['tower-of-lost-things'].page, 'tower-of-lost-things/index.html');
  assert.equal('url' in by['tower-of-lost-things'].android, false);
  const html = indexPage(apps, { access });
  assert.doesNotMatch(html, /shortwave[^"<]*\.apk|shortwave\/index\.html|tower-of-lost-things[^"<]*\.apk/);
  assert.match(html, /navi-1\.2\.3-9\.apk/);
  assert.equal(JSON.stringify(data).includes('X-Amz'), false);
});

test('publishPages: nothing the hub renders for a private device edition names its APK in an anonymous object', async () => {
  for (const slug of ['shortwave', 'earshot', 'tower-of-lost-things', 'gruvato', 'navi', 'green-in-between']) {
    const captured = [];
    const s3 = createS3({ policy, credentials: keys, env: {}, runner: (command, args) => (args.includes('ls') ? { ok: true, status: 0, stdout: '', stderr: '' } : runnerCapture(captured)(command, args)) });
    const fetchImpl = async () => new Response('', { status: 404 });
    await publishPages({ s3, policy, slug, latest: latestFor(slug), fetchImpl, credentials: keys, env: { HUB_LOCK_DIR: '/tmp/mobi17-locks' } });
    const written = Object.fromEntries(captured.map(item => [item.key, item.text]));
    assert.deepEqual(Object.keys(written).sort(), [`${slug}/index.html`, 'index.html', 'index.json'].sort(), slug);
    for (const [key, text] of Object.entries(written)) {
      assert.equal(/X-Amz-(Signature|Credential)=/i.test(text), false, `${slug}: ${key} carries a presigned link`);
      if (isAnonymous(policy, key) && !accessFor(policy, slug).devicePublic) assert.equal(new RegExp(`${slug}/\\d+\\.\\d+\\.\\d+/${slug}-\\d+\\.\\d+\\.\\d+-\\d+\\.apk`).test(text), false, `${slug}: anonymous ${key} names its device APK`);
    }
    assert.equal(/\.apk/.test(written['index.json']) && !accessFor(policy, slug).devicePublic, false, `${slug}: the root index names no private APK`);
    if (accessFor(policy, slug).devicePublic) assert.match(written[`${slug}/index.html`], /Install APK/);
    else assert.doesNotMatch(written[`${slug}/index.html`], /Install APK/);
  }
});

// ------------------------------------------------------------------------------------------ links in notifications

test('links: private links are presigned for 7 days with a private no-store answer; public ones stay plain; no keys drops them', () => {
  const published = (slug, extra = {}) => ({ apk: `https://s3.delo.sh/builds/${slug}/1.2.3/${slug}-1.2.3-9.apk`, apk_bytes: 5_000_000, ota: null, ipa_bytes: null, page: `https://s3.delo.sh/builds/${slug}/index.html`, manifest: null, any: true, ...extra });
  const shortwave = linkable({ policy, slug: 'shortwave', published: published('shortwave'), credentials: keys, now: at });
  assert.deepEqual(shortwave.minted, ['apk', 'page']);
  for (const field of ['apk', 'page']) {
    const facts = presignedFacts(shortwave.published[field]);
    assert.equal(facts.expiresS, 604800, field);
    assert.equal(new URL(shortwave.published[field]).searchParams.get('response-cache-control'), 'private, no-store');
  }
  const navi = linkable({ policy, slug: 'navi', published: published('navi'), credentials: keys, now: at });
  assert.deepEqual([navi.minted, navi.published.apk, navi.published.page], [[], published('navi').apk, published('navi').page], 'a public device edition keeps its plain links');
  const tower = linkable({ policy, slug: 'tower-of-lost-things', published: published('tower-of-lost-things', { ota: 'itms-services://?action=download-manifest&url=https://s3.delo.sh/builds/tower-of-lost-things/ios/manifest.plist' }), credentials: keys, now: at });
  assert.deepEqual(tower.minted, ['apk'], 'the iPad page is anonymous, the device APK is not');
  assert.equal(tower.published.page, published('tower-of-lost-things').page);
  assert.match(tower.published.ota, /^itms-services:/);
  const none = linkable({ policy, slug: 'shortwave', published: published('shortwave'), credentials: null, now: at });
  assert.deepEqual([none.published.apk, none.published.page, none.dropped], [null, null, ['apk', 'page']]);
  assert.deepEqual(linkable({ policy, slug: 'shortwave', published: null, credentials: keys }).published, null);
});

test('links: the notification keeps the Install APK and Builds buttons, with presigned URLs that fit the event', () => {
  const published = { apk: 'https://s3.delo.sh/builds/shortwave/1.2.3/shortwave-1.2.3-9.apk', apk_bytes: 74_700_000, ota: null, ipa_bytes: null, page: 'https://s3.delo.sh/builds/shortwave/index.html', manifest: null, any: true };
  const linked = linkable({ policy, slug: 'shortwave', published, credentials: keys, now: at }).published;
  const links = linksFor({ type: 'bloodbank.project.deployment.completed', published: linked, runUrl: 'https://github.com/x/y/actions/runs/1', deliveries: [] });
  assert.deepEqual(links.map(link => link.rel), ['apk', 'page', 'run'], 'both presigned links survive the 600 character filter');
  assert.match(links[0].url, /X-Amz-Signature=/);
  const dropped = linksFor({ type: 'bloodbank.project.deployment.completed', published: linkable({ policy, slug: 'shortwave', published, credentials: null }).published, runUrl: 'https://github.com/x/y/actions/runs/1', deliveries: [] });
  assert.deepEqual(dropped.map(link => link.rel), ['run'], 'without keys the private links are dropped, never replaced by a URL that answers 403');
});

// ---------------------------------------------------------------------------------------------- the bucket policy tool

test('bucket-policy: the probe plan expects 403 for what is private and 404 or 200 for what is public, and a listing is always 403', () => {
  const plan = probePlan(policy);
  const expectOf = url => plan.find(item => item.url === `https://s3.delo.sh/builds/${url}`)?.expect;
  assert.deepEqual(plan[0], { url: 'https://s3.delo.sh/builds/?list-type=2', expect: [403], why: 'no anonymous listing' });
  assert.deepEqual(expectOf('shortwave/0.0.0/shortwave-0.0.0-0.apk'), [403]);
  assert.deepEqual(expectOf('shortwave/index.html'), [403]);
  assert.deepEqual(expectOf('earshot/0.0.0/receipt.json'), [403]);
  assert.deepEqual(expectOf('earshot/editions/beta/latest.json'), [404, 200]);
  assert.deepEqual(expectOf('tower-of-lost-things/ios/manifest.plist'), [404, 200]);
  assert.deepEqual(expectOf('tower-of-lost-things/0.0.0/tower-of-lost-things-0.0.0-0.apk'), [403]);
  assert.deepEqual(expectOf('navi/0.0.0/navi-0.0.0-0.apk'), [404, 200]);
  assert.deepEqual(expectOf('index.html'), [404, 200]);
  assert.deepEqual(expectOf('earshot/latest.json'), [404, 200]);
  assert.deepEqual(expectOf('shortwave/inflight.json'), [404, 200]);
  assert.deepEqual(expectOf('earshot/0.0.0/earshot-0.0.0-0.apk.sha256'), [403]);
});

test('bucket-policy: the release check (pending ok) warns on a private key that still answers, and fails on listing, a closed public key or no answer', async () => {
  const text = readFileSync(committedFile, 'utf8');
  const old = { Statement: [{ Effect: 'Allow', Principal: { AWS: ['*'] }, Action: ['s3:GetObject'], Resource: ['arn:aws:s3:::builds/*'] }] };
  const logs = [];
  assert.deepEqual(await check({ policy, text, pendingOk: true, fetchImpl: bucketFetch(old), log: line => logs.push(line) }), [], 'the old public-read bucket is only pending');
  assert.ok(logs.some(line => /^::warning::BUCKET_POLICY_PENDING .*shortwave-0\.0\.0-0\.apk answered 404, expected 403/.test(line)));
  assert.match(logs.at(-1), /^BUCKET_POLICY_PENDING .*private keys? still answer anonymously: after this release, mise run hosts:install, then mise run bucket-policy:apply$/);
  assert.ok((await check({ policy, text, fetchImpl: bucketFetch(old), log: () => {} })).length > 0, 'the strict check still fails on it');
  const listing = async url => (url.includes('list-type') ? new Response('', { status: 200 }) : bucketFetch(JSON.parse(text))(url));
  assert.equal((await check({ policy, text, pendingOk: true, fetchImpl: listing, log: () => {} })).length, 1, 'listing is never pending');
  const closed = async url => (url.includes('editions/beta') ? new Response('', { status: 403 }) : bucketFetch(old)(url));
  assert.ok((await check({ policy, text, pendingOk: true, fetchImpl: closed, log: () => {} })).some(problem => /editions\/beta.*answered 403, expected 404 or 200/.test(problem)), 'a public edition answering 403 fails the release');
  assert.equal((await check({ policy, text, pendingOk: true, fetchImpl: async () => { throw new Error('ECONNREFUSED'); }, log: () => {} })).length, probePlan(policy).length);
  const kinds = new Set((await probeResults({ policy, fetchImpl: bucketFetch(old) })).map(problem => problem.kind));
  assert.deepEqual([...kinds], ['open']);
});

test('bucket-policy: apply is refused while v1 or the installed catch-up predates MOBI-17, and nothing reaches mc', async () => {
  const fake = ({ v1 = true, fetchOk = true } = {}) => args => {
    if (args[0] === 'fetch') return { ok: fetchOk, out: fetchOk ? '' : 'fatal: unable to access' };
    if (args[0] === 'cat-file') return { ok: v1 && args[2] === `FETCH_HEAD:${accessMarker}`, out: '' };
    throw new Error(`unexpected git ${args.join(' ')}`);
  };
  const home = '/home/h';
  const installed = '/home/h/.local/share/mobile-deploy-hub/current';
  const has = paths => path => paths.includes(path);
  assert.deepEqual(readiness({ home, git: fake(), exists: has([installed, `${installed}/${accessMarker}`]) }), []);
  assert.deepEqual(readiness({ home, git: fake(), exists: has([]) }), [], 'a host with no catch-up has none to break');
  assert.match(readiness({ home, git: fake({ v1: false }), exists: has([]) })[0], /^v1, the hub version every app's deploy runs, predates MOBI-17.*release the hub first/);
  assert.match(readiness({ home, git: fake(), exists: has([installed]) })[0], /catch-up installed on this host .* predates MOBI-17.*hosts:install/);
  assert.match(readiness({ home, git: fake({ fetchOk: false }), exists: has([]) })[0], /cannot read v1 from origin/);
  assert.equal(callerRef, 'v1');
  const calls = [];
  const logs = [];
  const code = await bucketMain(['apply'], { log: line => logs.push(line), readiness: () => ['v1 predates MOBI-17'], runner: (...args) => { calls.push(args); return { ok: true, status: 0, stdout: '', stderr: '' }; }, read: async () => 'x' });
  assert.equal(code, 1);
  assert.equal(calls.length, 0, 'nothing was applied');
  assert.match(logs.at(-1), /^BUCKET_POLICY_NOT_READY nothing was applied$/);
});

test('bucket-policy: a ready apply sets the policy, re-renders every page, then runs the strict check', async () => {
  const text = readFileSync(committedFile, 'utf8');
  const order = [];
  const runner = (command, args) => { order.push(args.includes('set-json') ? 'set-json' : 'get-json'); return { ok: true, status: 0, stdout: args.includes('get-json') ? text : '', stderr: '' }; };
  const rerender = async () => { order.push('pages'); return []; };
  const fetchImpl = async url => { if (!order.includes('probe')) order.push('probe'); return bucketFetch(JSON.parse(text))(url); };
  const logs = [];
  const code = await bucketMain(['apply'], { log: line => logs.push(line), readiness: () => [], runner, read: async ref => (ref.endsWith('/username') ? 'admin' : 'Admin-secret-for-tests'), rerender, fetchImpl });
  assert.equal(code, 0, logs.join('\n'));
  assert.deepEqual(order, ['set-json', 'get-json', 'pages', 'probe']);
  assert.ok(logs.includes('BUCKET_POLICY_APPLIED the live policy equals the committed file'));
  assert.match(logs.at(-1), /^BUCKET_POLICY_OK /);
  const failedPages = await bucketMain(['apply'], { log: () => {}, readiness: () => [], runner, read: async () => 'Admin-secret-for-tests', rerender: async () => ['earshot'], fetchImpl });
  assert.equal(failedPages, 1, 'a page that could not be re-rendered fails the apply');
});

test('bucket-policy: pages re-renders each app with a latest.json under its own lock, and reports the ones that failed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mobi17-pages-'));
  try {
    const published = [];
    const readLatest = async (_policy, key) => (key.startsWith('shortwave/') ? null : key.startsWith('gruvato/') ? '{not json' : JSON.stringify(latestFor(key.split('/')[0])));
    const publish = async ({ slug, latest, credentials }) => { published.push(slug); assert.equal(latest.slug, slug); assert.deepEqual(credentials, keys); };
    const logs = [];
    const failed = await rerenderPages({ policy, env: { HUB_LOCK_DIR: dir }, credentials: keys, s3: {}, publish, readLatest, log: line => logs.push(line) });
    assert.deepEqual(failed, ['gruvato']);
    assert.deepEqual(published.sort(), ['earshot', 'green-in-between', 'navi', 'tower-of-lost-things']);
    assert.ok(logs.some(line => line === 'BUCKET_POLICY_PAGES shortwave: no latest.json, no page'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('release: the device APK rides a Release only when the repository is private or the policy publishes the device edition', () => {
  assert.equal(deviceRidesRelease({ privateRepo: true, access: accessFor(policy, 'earshot') }), true);
  assert.equal(deviceRidesRelease({ privateRepo: false, access: accessFor(policy, 'earshot') }), false, 'a public repo never hands out a private device APK');
  assert.equal(deviceRidesRelease({ privateRepo: false, access: accessFor(policy, 'shortwave') }), false);
  assert.equal(deviceRidesRelease({ privateRepo: false, access: accessFor(policy, 'navi') }), true, 'a device-public app already publishes it');
  assert.equal(deviceRidesRelease({ privateRepo: undefined, access: null }), false, 'an unreadable answer counts as public');
});

// A live bucket that follows the bucket policy: anonymous reads of an allowed key are 404 (or 200), the rest 403.
const bucketFetch = (doc, { exists = () => false } = {}) => async url => {
  const target = new URL(url);
  if (target.searchParams.has('list-type')) return new Response('', { status: 403 });
  const key = target.pathname.replace(/^\/builds\//, '');
  const open = anonymousResources(doc, 'builds').some(pattern => wildcard(pattern, key));
  return new Response('', { status: open ? (exists(key) ? 200 : 404) : 403 });
};

test('bucket-policy: the check passes against a bucket that follows the committed policy and fails when the old public-read policy is live', async () => {
  const committed = JSON.parse(readFileSync(committedFile, 'utf8'));
  assert.deepEqual(await probe({ policy, fetchImpl: bucketFetch(committed) }), []);
  const logs = [];
  assert.deepEqual(await check({ policy, text: readFileSync(committedFile, 'utf8'), fetchImpl: bucketFetch(committed), log: line => logs.push(line) }), []);
  assert.match(logs.at(-1), /^BUCKET_POLICY_OK /);
  const old = { Statement: [{ Effect: 'Allow', Principal: { AWS: ['*'] }, Action: ['s3:GetObject'], Resource: ['arn:aws:s3:::builds/*'] }] };
  const problems = await probe({ policy, fetchImpl: bucketFetch(old) });
  assert.ok(problems.some(problem => /shortwave\/0\.0\.0\/shortwave-0\.0\.0-0\.apk answered 404, expected 403/.test(problem)), 'the old policy leaks a private APK key');
  const listing = await probe({ policy, fetchImpl: async url => new Response('', { status: url.includes('list-type') ? 200 : 404 }) });
  assert.ok(listing.some(problem => /answered 200, expected 403 \(no anonymous listing\)/.test(problem)));
  const down = await probe({ policy, fetchImpl: async () => { throw new Error('connect ECONNREFUSED'); } });
  assert.equal(down.length, probePlan(policy).length, 'a check that cannot look does not pass');
  const drifted = await check({ policy, text: readFileSync(committedFile, 'utf8').replace('builds/navi/*', 'builds/nav1/*'), offline: true, log: () => {} });
  assert.equal(drifted.length > 0, true);
});

test('bucket-policy: statements compare as a set, so MinIO re-serialising the live document is not drift', () => {
  const committed = JSON.parse(readFileSync(committedFile, 'utf8'));
  const live = { Version: '2012-10-17', Statement: [...committed.Statement].reverse().map(({ Sid: _sid, ...item }) => ({ ...item, Resource: [...item.Resource].reverse(), Principal: { AWS: ['*'] } })) };
  assert.deepEqual(documentDiff(committed, live), { missing: [], extra: [] });
  const withExtra = { Statement: [...live.Statement, { Effect: 'Allow', Principal: { AWS: ['*'] }, Action: ['s3:GetObject'], Resource: ['arn:aws:s3:::builds/*'] }] };
  assert.equal(documentDiff(committed, withExtra).extra.length, 1);
  assert.equal(documentDiff(committed, { Statement: [] }).missing.length, committed.Statement.length);
  assert.equal(normalize({ Statement: [{ Effect: 'Allow', Principal: '*', Action: 's3:GetObject', Resource: 'a' }] })[0], normalize({ Statement: [{ Effect: 'Allow', Principal: { AWS: ['*'] }, Action: ['s3:GetObject'], Resource: ['a'] }] })[0]);
});

test('bucket-policy: apply sets the policy through mc with the admin keys in the child environment only', async () => {
  const secret = 'Admin-secret-for-tests';
  const calls = [];
  const reads = [];
  const read = async ref => { reads.push(ref); return ref.endsWith('/username') ? 'admin-user' : secret; };
  const runner = (command, args, options) => {
    const file = args.find(arg => arg.endsWith('policy.json'));
    calls.push({ command, args, env: options.env, body: file ? readFileSync(file, 'utf8') : null });
    return { ok: true, status: 0, stdout: args.includes('get-json') ? readFileSync(committedFile, 'utf8') : '', stderr: '' };
  };
  const text = readFileSync(committedFile, 'utf8');
  await applyDocument({ policy, text, env: { PATH: '/bin', GH_TOKEN: 'gh-secret' }, runner, read });
  assert.deepEqual(reads, [adminRefs.access, adminRefs.secret]);
  assert.equal(calls[0].command, 'mc');
  assert.deepEqual(calls[0].args.filter(arg => !arg.endsWith('policy.json')), ['--quiet', '--no-color', '--disable-pager', 'anonymous', 'set-json', 'builds/builds']);
  assert.equal(calls[0].body, text);
  assert.equal(calls[0].env.MC_HOST_builds, `http://admin-user:${secret}@127.0.0.1:9012`);
  assert.equal(calls[0].env.GH_TOKEN, undefined);
  assert.ok(!calls[0].args.join(' ').includes(secret));
  const live = await liveDocument({ policy, env: {}, runner, read });
  assert.deepEqual(documentDiff(JSON.parse(text), live), { missing: [], extra: [] });
  assert.deepEqual(calls[1].args.slice(-3), ['anonymous', 'get-json', 'builds/builds']);
  const failing = () => ({ ok: false, status: 1, stdout: '', stderr: `mc: http://admin-user:${secret}@127.0.0.1:9012 refused` });
  await assert.rejects(applyDocument({ policy, text, env: {}, runner: failing, read }), error => !error.message.includes(secret) && /<redacted>/.test(error.message));
});
