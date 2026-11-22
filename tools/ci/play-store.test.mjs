// MOBI-18, the Play store split: an app whose Play listing is a different app from its device build pins
// android.store_package and android.store_upload_sha256 in the policy, declares android.bundle_signing (op:// references)
// in its manifest, gets generic HUB_PLAY_* variables in its bundle hook, and has its bundle read by the hub before any
// upload. The lane end to end (hook, verification, upload to the store package) is in v3.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bundleIdentity, bundleSigners, parseBundleManifest, parseJarSigners, verifyPlayBundle, zipEntry } from './lib/aab.mjs';
import { parseManifest } from './lib/manifest.mjs';
import { playHookEnv, playHookVariables } from './lib/play.mjs';
import { loadPolicy, parsePolicy, playTargetOf, policyFile } from './lib/policy.mjs';
import { hermetic, makeBundle, protoManifest } from './test-fixtures.mjs';

hermetic();

const source = readFileSync(policyFile, 'utf8');
const GIB = 'delorenj/green-in-between';
const GRUVATO = 'delorenj/gruvato';
const UPLOAD = '6a1cda1cfa3eb35b950dc0fd6bc73030bd105823af3aafd9222797c4e307bae1';
const edit = change => { const copy = JSON.parse(source); change(copy); return JSON.stringify(copy); };

// ---------------------------------------------------------------------------------------------------- policy

test('Green In Between pins its Play app and upload certificate; apps that upload under the device id pin nothing', () => {
  const { policy } = loadPolicy();
  const gib = policy.apps[GIB].android;
  assert.equal(gib.package, 'io.lasertoast.greeninbetween.spike', 'the device APK stays the .spike app');
  assert.equal(gib.store_package, 'io.lasertoast.gib');
  assert.equal(gib.store_upload_sha256, UPLOAD);
  assert.notEqual(gib.store_upload_sha256, gib.signer_sha256, 'the Play upload key is not the debug device signer');
  for (const [repo, app] of Object.entries(policy.apps)) {
    if (repo === GIB || !app.android) continue;
    assert.equal(app.android.store_package, undefined, `${repo} uploads to Play under its device package, as before`);
  }
});

test('the Play target is the store package when the policy pins one, else the device package', () => {
  const { policy } = loadPolicy();
  assert.deepEqual(playTargetOf(policy.apps[GIB]), { package: 'io.lasertoast.gib', split: true, uploadSha256: UPLOAD });
  assert.deepEqual(playTargetOf(policy.apps[GRUVATO]), { package: 'sh.delo.gruvato', split: false, uploadSha256: null });
  assert.deepEqual(playTargetOf(null, 'io.example.app'), { package: 'io.example.app', split: false, uploadSha256: null }, 'a repository the policy does not list falls back to the manifest package');
});

test('store_package and store_upload_sha256 are validated, together', () => {
  assert.doesNotThrow(() => parsePolicy(source));
  const bad = {
    'store_package is the device package': [p => { p.apps[GIB].android.store_package = p.apps[GIB].android.package; }, /store_package .* is the device package/],
    'store_package is not a package name': [p => { p.apps[GIB].android.store_package = 'not a package'; }, /store_package must be an Android package name/],
    'store_package without the upload certificate': [p => { delete p.apps[GIB].android.store_upload_sha256; }, /store_upload_sha256 is required with store_package/],
    'upload certificate without a store_package': [p => { delete p.apps[GIB].android.store_package; }, /store_upload_sha256 needs .*store_package/],
    'upload certificate is the device signer': [p => { p.apps[GIB].android.store_upload_sha256 = p.apps[GIB].android.signer_sha256; }, /is the device signer/],
    'upload certificate is not a lowercase sha256': [p => { p.apps[GIB].android.store_upload_sha256 = UPLOAD.toUpperCase(); }, /lowercase sha256 of the Play upload certificate/],
    'upload certificate is short': [p => { p.apps[GIB].android.store_upload_sha256 = UPLOAD.slice(2); }, /lowercase sha256/],
    'store_package is an edition package': [p => { p.apps['delorenj/earshot'].android.store_package = 'io.automaticai.earshot'; p.apps['delorenj/earshot'].android.store_upload_sha256 = UPLOAD; }, /package of the beta edition/],
    'unknown store key': [p => { p.apps[GIB].android.store_track = 'beta'; }, /unknown key "store_track"/],
  };
  for (const [name, [change, expected]] of Object.entries(bad)) assert.throws(() => parsePolicy(edit(change)), expected, name);
});

// ---------------------------------------------------------------------------------------------------- manifest

const manifest = (change = () => {}) => {
  const value = {
    schema: 2,
    project: { slug: 'example-app', name: 'Example App' },
    version: { read: 'true', bump: 'true' },
    android: {
      package: 'io.example.app', export: 'true', artifact: 'a.apk', signer_sha256: 'a'.repeat(64),
      bundle: 'true', bundle_artifact: 'a.aab',
      bundle_signing: { key_ref: 'op://DeLoSecrets/item/keystore', alias_ref: 'op://DeLoSecrets/item/key_alias', password_ref: 'op://DeLoSecrets/Play upload key/store_password' },
    },
  };
  change(value);
  return JSON.stringify(value);
};

test('android.bundle_signing is op:// references to three fields, and nothing else', () => {
  const parsed = parseManifest(manifest());
  assert.deepEqual(Object.keys(parsed.android.bundle_signing), ['key_ref', 'alias_ref', 'password_ref']);
  assert.doesNotThrow(() => parseManifest(manifest(m => { delete m.android.bundle_signing; })), 'optional: an app may sign by its own means');
  const bad = {
    'a raw password': [m => { m.android.bundle_signing.password_ref = 'hunter2'; }, /password_ref must be an op:\/\/vault\/item\/field reference, never a value/],
    'a file path': [m => { m.android.bundle_signing.key_ref = '/home/me/upload.jks'; }, /key_ref must be an op:\/\//],
    'a reference with no field': [m => { m.android.bundle_signing.alias_ref = 'op://DeLoSecrets/item'; }, /alias_ref must be an op:\/\//],
    'a line break': [m => { m.android.bundle_signing.alias_ref = 'op://V/i/f\nx'; }, /alias_ref must be an op:\/\//],
    'a missing ref': [m => { delete m.android.bundle_signing.alias_ref; }, /bundle_signing\.alias_ref is required/],
    'an unknown key': [m => { m.android.bundle_signing.password = 'x'; }, /bundle_signing has unknown key "password"/],
    'no bundle hook': [m => { delete m.android.bundle; delete m.android.bundle_artifact; }, /bundle_signing needs android\.bundle/],
    'not an object': [m => { m.android.bundle_signing = 'op://a/b/c'; }, /bundle_signing must be an object/],
  };
  for (const [name, [change, expected]] of Object.entries(bad)) assert.throws(() => parseManifest(manifest(change)), expected, name);
});

// ---------------------------------------------------------------------------------------------------- hook environment

test('the bundle hook gets the generic HUB_PLAY_* variables, references only, and stale ones never leak', () => {
  const signing = { key_ref: 'op://V/i/keystore', alias_ref: 'op://V/i/alias', password_ref: 'op://V/i/password' };
  const stale = Object.fromEntries(playHookVariables.map(name => [name, 'stale']));
  const split = playHookEnv({ ...stale, KEEP: '1' }, { package: 'io.example.store', split: true, uploadSha256: UPLOAD }, signing);
  assert.deepEqual(Object.fromEntries(Object.entries(split).filter(([name]) => playHookVariables.includes(name))), {
    HUB_PLAY_PACKAGE: 'io.example.store', HUB_PLAY_UPLOAD_SHA256: UPLOAD,
    HUB_PLAY_SIGNING_KEY_REF: 'op://V/i/keystore', HUB_PLAY_SIGNING_ALIAS_REF: 'op://V/i/alias', HUB_PLAY_SIGNING_PASSWORD_REF: 'op://V/i/password',
  });
  assert.equal(split.KEEP, '1');
  const plain = playHookEnv({ ...stale }, { package: 'sh.delo.gruvato', split: false, uploadSha256: null }, undefined);
  assert.deepEqual(Object.fromEntries(Object.entries(plain).filter(([name]) => playHookVariables.includes(name))), { HUB_PLAY_PACKAGE: 'sh.delo.gruvato' }, 'no certificate and no references unless the policy and the manifest give them');
  for (const value of Object.values(split)) assert.doesNotMatch(String(value), /BEGIN|PRIVATE KEY/);
});

// ---------------------------------------------------------------------------------------------------- bundle reader

const planned = { package: 'io.lasertoast.gib', versionCode: 153, uploadSha256: UPLOAD };
const keytoolFor = (...digests) => digests.map((digest, index) => `Signer #${index + 1}:\n\nCertificate #1:\nOwner: CN=Upload\nCertificate fingerprints:\n\t SHA1: ${'AA:'.repeat(19)}AA\n\t SHA256: ${digest.toUpperCase().match(/../g).join(':')}\nSignature algorithm name: SHA384withRSA\n\n`).join('');
const exec = ({ jar = 'jar verified.\n\nWarning:\nself-signed.\n', signers = [UPLOAD] } = {}) => (command) => (command === 'jarsigner' ? jar : keytoolFor(...signers));

async function bundleFile(manifestFields, extra) {
  const dir = await mkdtemp(join(tmpdir(), 'hub-aab-'));
  const aab = join(dir, 'app.aab');
  await writeFile(aab, makeBundle(manifestFields, extra));
  return { aab, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

test('the hub reads the base manifest of a bundle: package, versionCode (string or compiled int), versionName', async () => {
  for (const asNumber of [false, true]) {
    const f = await bundleFile({ package: 'io.lasertoast.gib', versionCode: 153, versionName: '0.0.153', asNumber });
    try { assert.deepEqual(bundleIdentity(f.aab), { package: 'io.lasertoast.gib', versionCode: 153, versionName: '0.0.153' }, `asNumber ${asNumber}`); } finally { await f.cleanup(); }
  }
  assert.throws(() => parseBundleManifest(protoManifest({ package: 'x.y', versionCode: 1, root: 'application' })), /root is <application>/);
  const bare = makeBundle({ package: 'x.y', versionCode: 1 }).subarray(0, 40);
  assert.throws(() => zipEntry(bare, 'x'), /not a zip archive/);
  assert.equal(zipEntry(makeBundle({ package: 'x.y', versionCode: 1 }), 'nope'), null);
  const noManifest = await mkdtemp(join(tmpdir(), 'hub-aab-'));
  try {
    await writeFile(join(noManifest, 'a.aab'), Buffer.from('PK'));
    assert.throws(() => bundleIdentity(join(noManifest, 'a.aab')), /HUB_PLAY_BUNDLE_REFUSED zip/);
  } finally { await rm(noManifest, { recursive: true, force: true }); }
});

test('keytool output yields one fingerprint per signer, the leaf certificate\'s', () => {
  assert.deepEqual(parseJarSigners(keytoolFor(UPLOAD)), [UPLOAD]);
  assert.deepEqual(parseJarSigners(keytoolFor(UPLOAD, 'b'.repeat(64))), [UPLOAD, 'b'.repeat(64)]);
  assert.deepEqual(parseJarSigners('Not a signed jar file\n'), []);
});

test('a bundle that is the store package, the planned versionCode and signed by the upload key passes', async () => {
  const f = await bundleFile({ package: 'io.lasertoast.gib', versionCode: 153 });
  try {
    assert.deepEqual(verifyPlayBundle({ aab: f.aab, expect: planned, exec: exec() }), { package: 'io.lasertoast.gib', versionCode: 153, versionName: '1.0.0', upload_sha256: UPLOAD });
    assert.deepEqual(verifyPlayBundle({ aab: f.aab, expect: { ...planned, versionCode: '153' }, exec: exec() }).versionCode, 153, 'the plan\'s code is text in the config');
  } finally { await f.cleanup(); }
});

test('every wrong bundle is refused with a HUB_PLAY_BUNDLE_REFUSED marker, before Play is contacted', async () => {
  const good = { package: 'io.lasertoast.gib', versionCode: 153 };
  const cases = [
    ['the device (.spike) package', { ...good, package: 'io.lasertoast.greeninbetween.spike' }, exec(), /REFUSED package: the bundle is io\.lasertoast\.greeninbetween\.spike, the policy says Play serves io\.lasertoast\.gib/],
    ['a package from before the re-key', { ...good, package: 'io.lasertoast.greeninbetween' }, exec(), /REFUSED package: /],
    ['a stale versionCode', { ...good, versionCode: 152 }, exec(), /REFUSED versionCode: the bundle carries versionCode 152 but the plan says 153/],
    ['the debug device signer', good, exec({ signers: ['d9d0253a4ce5bfb8a18d01efddc042e8828c3f73b04da41b4c3358e125c5222a'] }), /REFUSED signer: the bundle is signed with d9d0253a.*not the Play upload certificate 6a1cda1c/],
    ['two signers', good, exec({ signers: [UPLOAD, 'b'.repeat(64)] }), /REFUSED signer: .* exactly one signer, found 2/],
    ['no signer', good, exec({ signers: [] }), /REFUSED signer: .* found 0/],
    ['an unsigned jar', good, exec({ jar: 'jar is unsigned.\n' }), /REFUSED signature: the bundle is not a verified signed jar/],
    ['entries the signature does not cover', good, exec({ jar: 'jar verified.\n\nWarning:\nThis jar contains unsigned entries which have not been integrity-checked.\n' }), /REFUSED signature: .* do not cover|REFUSED signature: .*does not cover/],
  ];
  for (const [name, fields, run, expected] of cases) {
    const f = await bundleFile(fields);
    try { assert.throws(() => verifyPlayBundle({ aab: f.aab, expect: planned, exec: run }), expected, name); } finally { await f.cleanup(); }
  }
  const tampered = await bundleFile(good);
  try {
    const failing = () => { throw new Error('jarsigner verify failed (exit 1)\njarsigner: java.lang.SecurityException: SHA-256 digest error for base/dex/classes.dex'); };
    assert.throws(() => bundleSigners({ aab: tampered.aab, exec: failing }), /REFUSED signature: jarsigner could not verify .*digest error/);
  } finally { await tampered.cleanup(); }
});

// A real keystore, a real jarsigner and a real keytool over a bundle the hub built the same way the test did: the parser
// meets the JDK's actual output (skipped on a host with no JDK).
const hasJdk = spawnSync('keytool', ['-help'], { stdio: 'ignore' }).status === 0 && spawnSync('jarsigner', ['-help'], { stdio: 'ignore' }).status === 0;

test('a bundle signed with a real upload key verifies against that key\'s certificate, and not against another', { skip: !hasJdk && 'no JDK on this host' }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hub-jdk-'));
  try {
    const keystore = join(dir, 'upload.jks');
    const password = 'test-only-throwaway';
    const alias = 'upload';
    execFileSync('keytool', ['-genkeypair', '-keystore', keystore, '-storepass', password, '-keypass', password, '-alias', alias, '-keyalg', 'RSA', '-keysize', '2048', '-validity', '30', '-dname', 'CN=Hub Test Upload'], { stdio: 'ignore' });
    execFileSync('keytool', ['-exportcert', '-keystore', keystore, '-storepass', password, '-alias', alias, '-file', join(dir, 'upload.der')], { stdio: 'ignore' });
    const digest = createHash('sha256').update(await readFile(join(dir, 'upload.der'))).digest('hex');
    const unsigned = join(dir, 'unsigned.aab');
    const signed = join(dir, 'signed.aab');
    await writeFile(unsigned, makeBundle({ package: 'io.lasertoast.gib', versionCode: 153 }));
    assert.throws(() => verifyPlayBundle({ aab: unsigned, expect: { ...planned, uploadSha256: digest } }), /REFUSED signature: the bundle is not a verified signed jar/, 'an unsigned bundle');
    execFileSync('jarsigner', ['-keystore', keystore, '-storepass', password, '-keypass', password, '-digestalg', 'SHA-256', '-signedjar', signed, unsigned, alias], { stdio: 'ignore' });
    assert.deepEqual(verifyPlayBundle({ aab: signed, expect: { ...planned, uploadSha256: digest } }).upload_sha256, digest);
    assert.throws(() => verifyPlayBundle({ aab: signed, expect: planned }), /REFUSED signer: the bundle is signed with .*not the Play upload certificate 6a1cda1c/, 'signed by a key the policy does not pin');
    // A byte changed after signing no longer verifies.
    const bytes = await readFile(signed);
    const at = bytes.indexOf(Buffer.from('config'));
    bytes[at] = 0x43;
    const tampered = join(dir, 'tampered.aab');
    await writeFile(tampered, bytes);
    assert.throws(() => verifyPlayBundle({ aab: tampered, expect: { ...planned, uploadSha256: digest } }), /REFUSED signature/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
