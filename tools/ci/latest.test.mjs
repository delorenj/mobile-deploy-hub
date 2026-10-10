// latest.json (design v1.1, C3): the parser and validator the deliver job, the plan and the catch-up share, the
// ordering rules, the key layout, and the forward-only pointer.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  apkKey, compareBuild, compareRelease, compareSemver, installUrl, ipaKey, mayReplace, parseLatest, publicUrl,
  publishedFloor, serializeLatest, updateDevice, validateLatest, versionKey,
} from './lib/latest.mjs';

import { base, run, sampleLatest } from './test-fixtures.mjs';

test('a complete latest.json parses, and its text round-trips', () => {
  const doc = sampleLatest();
  assert.equal(validateLatest(doc, { base, slug: 'tower-of-lost-things' }), doc);
  assert.deepEqual(parseLatest(serializeLatest(doc)), doc);
  assert.equal(doc.ios.install_url, 'itms-services://?action=download-manifest&url=https://s3.delo.sh/builds/tower-of-lost-things/ios/manifest.plist', 'not percent-encoded, as Apple documents it');
});

test('latest.json is strict: unknown keys, bad statuses, foreign keys and mismatched URLs are refused', () => {
  const cases = {
    'unknown top key': doc => { doc.extra = 1; },
    'schema 2': doc => { doc.schema = 2; },
    'bad status': doc => { doc.android.device.status = 'away'; },
    'bad installer': doc => { doc.ios.device.by = 'robot'; },
    'key of another app': doc => { doc.android.key = 'gruvato/0.2.2/gruvato-0.2.2-4.apk'; doc.android.url = publicUrl(base, doc.android.key); },
    'url not the key': doc => { doc.android.url = `${base}/elsewhere.apk`; },
    'http url': doc => { doc.ios.url = doc.ios.url.replace('https', 'http'); },
    'install url elsewhere': doc => { doc.ios.install_url = installUrl('https://evil.example/manifest.plist'); },
    'no blocks': doc => { doc.android = null; doc.ios = null; },
    'bad sha': doc => { doc.android.sha256 = 'A'.repeat(64); },
    'quickdrop outside builds': doc => { doc.android.quickdrop = '../x.apk'; },
    'negative failures': doc => { doc.android.device.failures = -1; },
  };
  for (const [name, change] of Object.entries(cases)) {
    const doc = structuredClone(sampleLatest());
    change(doc);
    assert.throws(() => validateLatest(doc, { base }), /latest\.json/, name);
  }
  assert.throws(() => parseLatest('{'), /not valid JSON/);
  assert.throws(() => validateLatest(sampleLatest(), { slug: 'gruvato' }), /expected gruvato/);
});

test('an iPad installed over a metered link has no over-the-air copy: key, url and the OTA links are null together', () => {
  const doc = structuredClone(sampleLatest());
  Object.assign(doc.ios, { key: null, url: null, bytes: null, manifest_url: null, install_url: null });
  validateLatest(doc, { base });
  doc.ios.install_url = installUrl(`${base}/x/ios/manifest.plist`);
  assert.throws(() => validateLatest(doc, { base }), /must be null when ios\.key is null/);
});

test('the catch-up marker event_pending is the reporter\'s own and is allowed on a device', () => {
  const doc = structuredClone(sampleLatest());
  doc.android.device.event_pending = { type: 'bloodbank.project.deployment.completed' };
  validateLatest(doc);
});

test('versions compare as semver; iOS builds as numbers when both are numbers, else as dotted versions', () => {
  assert.equal(compareSemver('0.2.10', '0.2.9'), 1);
  assert.equal(compareSemver('1.0.0', '1.0.0'), 0);
  assert.throws(() => compareSemver('preview-17', '0.0.1'), /X\.Y\.Z/);
  assert.equal(compareBuild('10', '9'), 1, 'numerically, not as text');
  assert.equal(compareBuild('0.2.5', '0.2.10'), -1, 'Gruvato builds are versions');
  assert.equal(compareBuild('4', '4'), 0);
  assert.equal(compareRelease('android', { version: '0.2.2', code: 5 }, { version: '0.2.2', code: 4 }), 1);
  assert.equal(compareRelease('ios', { version: '0.2.3', build: '1' }, { version: '0.2.2', build: '9' }), 1, 'the version decides first');
});

test('the pointer only moves forward: a newer release or a rerun replaces, an older one is kept', () => {
  const current = sampleLatest().android;
  assert.equal(mayReplace('android', null, current).replace, true);
  assert.equal(mayReplace('android', current, { ...current, version: '0.2.3', code: 5 }).replace, true);
  assert.equal(mayReplace('android', current, { ...current }).replace, true, 'same bytes: a rerun');
  assert.equal(mayReplace('android', current, { ...current, sha256: 'e'.repeat(64) }).replace, true, 'same run, rebuilt bytes: Re-run failed jobs');
  const older = mayReplace('android', current, { ...current, version: '0.2.1', code: 3, run: { ...run, id: '1' } });
  assert.equal(older.replace, false);
  assert.match(older.reason, /kept 0\.2\.2 \(4\): 0\.2\.1 \(3\) is older/);
  assert.equal(mayReplace('android', current, { ...current, sha256: 'e'.repeat(64), run: { ...run, id: '2' } }).replace, false, 'same release, other bytes, another run');
});

test('the reporter changes only device fields, and only while the block names the release it installed', () => {
  const doc = sampleLatest();
  const done = updateDevice(doc, 'android', { version: '0.2.2', code: 4 }, { status: 'installed', by: 'catch-up', reason: null, since: '2026-10-09T21:00:00Z' });
  assert.equal(done.updated, true);
  assert.equal(done.doc.android.device.status, 'installed');
  assert.equal(done.doc.android.sha256, doc.android.sha256);
  assert.equal(doc.android.device.status, 'pending', 'the input is not mutated');
  const moved = updateDevice(doc, 'android', { version: '0.2.1', code: 3 }, { status: 'installed' });
  assert.equal(moved.updated, false);
  assert.throws(() => updateDevice(doc, 'android', { version: '0.2.2', code: 4 }, { status: 'gone' }), /status/);
  assert.deepEqual(publishedFloor(doc), { android: { version: '0.2.2', code: 4 }, ios: { version: '0.2.2', build: '4' } });
  assert.deepEqual(publishedFloor(null), { android: null, ios: null });
});

test('keys stay inside the app folder', () => {
  assert.equal(apkKey('gruvato', '0.2.5', 2005), 'gruvato/0.2.5/gruvato-0.2.5-2005.apk');
  assert.equal(ipaKey('gruvato', '0.2.5', '0.2.5'), 'gruvato/0.2.5/gruvato-0.2.5-0.2.5.ipa');
  for (const [slug, version, file] of [['../x', '0.1.0', 'a'], ['gruvato', '0.1', 'a'], ['gruvato', '0.1.0', '../a'], ['gruvato', '0.1.0', '.hidden']]) assert.throws(() => versionKey(slug, version, file), undefined, `${slug} ${version} ${file}`);
});
