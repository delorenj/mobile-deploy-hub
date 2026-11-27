// GRUV-184, one level up (every hub app with android.bundle): the Play lane's checksum evidence, the exact-build
// retention, and the read-only readback.
//
//   - uploadBundle hashes the exact bytes it sends and holds Play's own upload answer to them (HUB_PLAY_BUNDLE_VERIFIED);
//     a mismatch fails before any track write or commit and the edit is deleted (HUB_PLAY_BUNDLE_MISMATCH).
//   - the play command refuses a bundle that changed since the android lane staged it, retains the exact AAB beside its
//     receipt, and the release lane attaches it (and its .sha256) to the app's private Release — or holds it for the
//     play-bundle run artifact when the repo is public.
//   - the play-readback command opens an edit only to read and deletes it again (never commits), downloads the
//     Google-generated universal APK, and cross-checks the retained evidence against what Play reports.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseConfig } from './lib/config.mjs';
import { readBack, readOnlyRequest, universalApkOf, uploadBundle } from './lib/play.mjs';
import { play, release } from './commands/android.mjs';
import { playReadback } from './commands/readback.mjs';
import { hermetic, makeBundle } from './test-fixtures.mjs';

hermetic(); // offline and outside any workflow job, on every host (test-fixtures.mjs)

const readJson = async file => JSON.parse(await readFile(file, 'utf8'));

const manifestText = JSON.stringify({
  schema: 2,
  project: { slug: 'example-app', name: 'Example App' },
  version: { read: 'node tools/version.mjs', bump: 'node tools/version.mjs bump' },
  android: {
    package: 'io.example.app',
    export: 'mkdir -p artifacts && printf apk > artifacts/App.apk',
    artifact: 'artifacts/App.apk',
    signer_sha256: '2d4954863dabb5da86d69ce4b60b3e400e73669b50a80658b0941440a7941a97',
    bundle: 'mkdir -p artifacts && cp "$STORE_AAB" artifacts/App.aab',
    bundle_artifact: 'artifacts/App.aab',
  },
});

// A throwaway app checkout with the manifest, a prepared bundle staged where the android lane left it, a fake gh and an
// output folder. gh.log records every gh invocation; "release view" answers FAKE_RELEASE_EXISTS; the private probe
// answers GH_PRIVATE (default true, like every real app repo).
async function fixture({ bundle = { package: 'io.example.app', versionCode: 4 } } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'hub-play-evidence-'));
  const app = join(root, 'app');
  const out = join(root, 'out');
  const bin = join(root, 'bin');
  await Promise.all([app, out, bin, join(out, 'android')].map(path => mkdir(path, { recursive: true })));
  await writeFile(join(app, 'mobile-deploy.json'), manifestText);
  const aab = makeBundle(bundle);
  await writeFile(join(out, 'android/App.aab'), aab);
  await writeFile(join(root, 'store.aab'), aab);
  await writeFile(join(root, 'github-output.txt'), '');
  await writeFile(join(bin, 'gh'), `#!/bin/sh\necho "gh $*" >> "${root}/gh.log"\n[ "$1 $2" = "release view" ] && exit "\${FAKE_RELEASE_EXISTS:-1}"\ncase "$*" in "api "*" --jq .private") echo "\${GH_PRIVATE:-true}";; esac\nexit 0\n`);
  await chmod(join(bin, 'gh'), 0o755);
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    GITHUB_OUTPUT: join(root, 'github-output.txt'),
    GITHUB_REPOSITORY: 'delorenj/example-app',
    GITHUB_SHA: 'abc123',
    GITHUB_RUN_ID: '42',
    HUB_OUT: undefined, GH_TOKEN: undefined, PLAY_TOKEN: undefined,
  };
  delete env.HUB_OUT; delete env.GH_TOKEN; delete env.PLAY_TOKEN;
  const configure = (command, extra = [], more = {}) => ({ ...parseConfig([command, '--out', out, '--version', '0.3.0', '--android-code', '4', ...extra], { ...env, ...more }), cwd: app });
  const cleanup = () => rm(root, { recursive: true, force: true });
  return { root, app, out, env, configure, cleanup, ghLog: () => readFile(join(root, 'gh.log'), 'utf8').catch(() => '') };
}

// A Play API fake whose upload answer honestly reports the bytes it got (sha1/sha256 of the request body). tamper
// swaps the stored digests, as a byte-changed copy would produce.
function playApi({ bundles = [], apks = [], uploadedCode = 4, tamper = false, generated = true } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const parsed = new URL(url);
    calls.push({ method: init.method, url: parsed.toString(), path: parsed.pathname, body: init.body });
    const reply = value => ({ ok: true, status: 200, headers: { get: name => (name === 'content-type' ? 'application/json' : null) }, json: async () => value, text: async () => JSON.stringify(value), arrayBuffer: async () => Buffer.from(JSON.stringify(value)) });
    if (parsed.pathname.endsWith('/edits') && init.method === 'POST') return reply({ id: 'E1' });
    if (parsed.pathname.endsWith('/bundles') && init.method === 'GET') return reply({ bundles });
    if (parsed.pathname.endsWith('/apks')) return reply({ apks });
    if (parsed.pathname.endsWith('/bundles') && init.method === 'POST') {
      const body = Buffer.isBuffer(init.body) ? init.body : Buffer.from(String(init.body ?? ''));
      const sha256 = createHash('sha256').update(body).digest('hex');
      const sha1 = createHash('sha1').update(body).digest('hex');
      return reply({ versionCode: uploadedCode, sha256: tamper ? '0'.repeat(64) : sha256, sha1: tamper ? '0'.repeat(40) : sha1 });
    }
    if (/\/generatedApks\/\d+$/.test(parsed.pathname)) return reply(generated ? { generatedApks: [{ generatedUniversalApk: { downloadId: 'D1', certificateSha256Hash: 'ab'.repeat(32) } }] } : { generatedApks: [] });
    if (/\/generatedApks\/\d+\/downloads\//.test(parsed.pathname)) return { ok: true, status: 200, headers: { get: name => (name === 'content-type' ? 'application/octet-stream' : null) }, json: async () => ({}), text: async () => '', arrayBuffer: async () => Buffer.from('the universal apk bytes') };
    return reply({});
  };
  return { fetchImpl, calls };
}

test('the upload is checked byte for byte: Play stores the same sha256/sha1 the hub hashed, and the receipt carries both', async () => {
  const f = await fixture();
  try {
    const api = playApi({ uploadedCode: 4 });
    const logs = [];
    const result = await uploadBundle({ pkg: 'io.example.app', aab: join(f.out, 'android/App.aab'), token: 'tok', expectedCode: 4, fetchImpl: api.fetchImpl, log: line => logs.push(line) });
    const sha256 = createHash('sha256').update(await readFile(join(f.out, 'android/App.aab'))).digest('hex');
    assert.equal(result.bundle.sha256, sha256);
    assert.equal(result.bundle.play_sha256, sha256);
    assert.ok(logs.some(line => new RegExp(`^HUB_PLAY_BUNDLE_VERIFIED io\\.example\\.app versionCode=4 sha256=${sha256} play_sha256=${sha256} bytes=\\d+$`).test(line)), logs.join('\n'));
    assert.ok(api.calls.some(call => call.url.endsWith(':commit')), 'a match commits as before');
  } finally { await f.cleanup(); }
});

test('a byte mismatch fails before any track write or commit, and the edit is deleted', async () => {
  const f = await fixture();
  try {
    const api = playApi({ uploadedCode: 4, tamper: true });
    const logs = [];
    await assert.rejects(
      uploadBundle({ pkg: 'io.example.app', aab: join(f.out, 'android/App.aab'), token: 'tok', expectedCode: 4, fetchImpl: api.fetchImpl, log: line => logs.push(line) }),
      error => {
        assert.match(error.message, /^HUB_PLAY_BUNDLE_MISMATCH io\.example\.app versionCode=4: /);
        assert.match(error.message, /the edit is deleted and nothing was committed/);
        return true;
      });
    assert.ok(!api.calls.some(call => call.url.endsWith(':commit')), 'nothing committed');
    assert.ok(!api.calls.some(call => call.method === 'PUT'), 'no track write');
    assert.ok(api.calls.some(call => call.method === 'DELETE' && call.path.endsWith('/edits/E1')), 'the edit was deleted');
    assert.ok(logs.some(line => /^PLAY_EDIT_DELETED E1$/.test(line)), logs.join('\n'));
  } finally { await f.cleanup(); }
});

test('the play command refuses a bundle that changed since the android lane staged it, before contacting Play', async () => {
  const f = await fixture();
  try {
    const real = f.configure('play', ['--dry-run', 'false', '--play', 'true']);
    const staged = { lane: 'android', play: { package: 'io.example.app', versionCode: 4, upload_sha256: null, sha256: 'f'.repeat(64), bytes: 3 } };
    await mkdir(join(f.out, 'receipts/android'), { recursive: true });
    await writeFile(join(f.out, 'receipts/android/hub-receipt-android.json'), JSON.stringify(staged));
    const api = playApi();
    await assert.rejects(play(real, { env: { ...f.env, PLAY_TOKEN: 'tok', HUB_RECEIPTS: join(f.out, 'receipts') }, fetchImpl: api.fetchImpl }), /HUB_PLAY_BUNDLE_REFUSED changed: .*staged sha256=f{64}.*this step reads sha256=/);
    assert.deepEqual(api.calls, [], 'Play was never contacted');
  } finally { await f.cleanup(); }
});

test('readOnlyRequest allows exactly the readback verbs and refuses everything else, commits first', async () => {
  const ok = [
    ['POST', 'https://androidpublisher.googleapis.com/androidpublisher/v3/applications/io.example.app/edits'],
    ['GET', 'https://androidpublisher.googleapis.com/androidpublisher/v3/applications/io.example.app/edits/E1/bundles'],
    ['DELETE', 'https://androidpublisher.googleapis.com/androidpublisher/v3/applications/io.example.app/edits/E1'],
    ['GET', 'https://androidpublisher.googleapis.com/androidpublisher/v3/applications/io.example.app/generatedApks/4'],
    ['GET', 'https://androidpublisher.googleapis.com/androidpublisher/v3/applications/io.example.app/generatedApks/4/downloads/D1:download?alt=media'],
  ];
  for (const [method, url] of ok) assert.equal(readOnlyRequest(method, url, 'io.example.app'), url, `${method} ${url}`);
  const refused = [
    ['POST', 'https://androidpublisher.googleapis.com/androidpublisher/v3/applications/io.example.app/edits/E1:commit'],
    ['PUT', 'https://androidpublisher.googleapis.com/androidpublisher/v3/applications/io.example.app/edits/E1/tracks/internal'],
    ['POST', 'https://androidpublisher.googleapis.com/upload/androidpublisher/v3/applications/io.example.app/edits/E1/bundles?uploadType=media'],
    ['POST', 'https://androidpublisher.googleapis.com/androidpublisher/v3/applications/io.example.app/edits/E1/validate'],
    ['GET', 'https://androidpublisher.googleapis.com/androidpublisher/v3/applications/io.example.app/edits'],
    ['GET', 'https://androidpublisher.googleapis.com/androidpublisher/v3/applications/other.app/edits/E1/bundles'],
    ['GET', 'https://androidpublisher.googleapis.com/androidpublisher/v3/applications/io.example.app/edits/E1/apks'],
    ['GET', 'https://example.com/androidpublisher/v3/applications/io.example.app/edits/E1/bundles'],
    ['DELETE', 'https://androidpublisher.googleapis.com/androidpublisher/v3/applications/io.example.app/edits/E1?force=true'],
  ];
  for (const [method, url] of refused) assert.throws(() => readOnlyRequest(method, url, 'io.example.app'), /^Error: HUB_PLAY_READBACK_REFUSED /, `${method} ${url}`);
});

test('the readback opens an edit, reads the bundle, deletes the edit and downloads the universal APK; nothing is committed', async () => {
  const f = await fixture();
  try {
    const api = playApi({ bundles: [{ versionCode: 4, sha256: 'a'.repeat(64), sha1: 'b'.repeat(40) }] });
    const apkPath = join(f.out, 'play-readback', 'example-app-4-universal.apk');
    await mkdir(join(f.out, 'play-readback'), { recursive: true });
    const logs = [];
    const read = await readBack({ pkg: 'io.example.app', versionCode: '4', token: 'tok', apkPath, fetchImpl: api.fetchImpl, log: line => logs.push(line) });
    assert.equal(read.bundle.sha256, 'a'.repeat(64));
    assert.equal(read.edit, 'E1');
    assert.equal(read.edit_deleted, true);
    assert.equal(read.apk.sha256, createHash('sha256').update(Buffer.from('the universal apk bytes')).digest('hex'));
    assert.equal(read.apk.download_id, 'D1');
    assert.equal((await readFile(apkPath)).toString(), 'the universal apk bytes', 'the APK is on disk for the artifact upload');
    assert.deepEqual(api.calls.map(call => `${call.method} ${call.path}`), [
      'POST /androidpublisher/v3/applications/io.example.app/edits',
      'GET /androidpublisher/v3/applications/io.example.app/edits/E1/bundles',
      'DELETE /androidpublisher/v3/applications/io.example.app/edits/E1',
      'GET /androidpublisher/v3/applications/io.example.app/generatedApks/4',
      'GET /androidpublisher/v3/applications/io.example.app/generatedApks/4/downloads/D1:download',
    ], 'exactly the five readback calls, in order');
    assert.ok(!api.calls.some(call => call.url.includes(':commit') || call.method === 'PUT'), 'nothing committed, no track touched');
    assert.ok(logs.some(line => /^HUB_PLAY_READBACK_EDIT E1: opened read-only/.test(line)));
    assert.ok(logs.some(line => /^HUB_PLAY_READBACK_EDIT_DELETED E1: nothing was committed$/.test(line)));
  } finally { await f.cleanup(); }
});

test('the readback deletes its edit even when the listing fails, and refuses a versionCode Play does not hold', async () => {
  const f = await fixture();
  try {
    const api = playApi({ bundles: [{ versionCode: 7, sha256: 'a'.repeat(64), sha1: 'b'.repeat(40) }] });
    await assert.rejects(
      readBack({ pkg: 'io.example.app', versionCode: '4', token: 'tok', apkPath: join(f.out, 'x.apk'), fetchImpl: api.fetchImpl, log() {} }),
      /^Error: HUB_PLAY_READBACK_ABSENT io\.example\.app versionCode=4: .*known: 7/);
    assert.ok(api.calls.some(call => call.method === 'DELETE'), 'the edit was deleted even after the refusal');
    assert.ok(!api.calls.some(call => call.url.includes('generatedApks')), 'no generated-APK call after the refusal');
  } finally { await f.cleanup(); }
});

test('a versionCode whose universal APK Google has not generated yet says so and fails honestly', async () => {
  const f = await fixture();
  try {
    const api = playApi({ bundles: [{ versionCode: 4, sha256: 'a'.repeat(64), sha1: 'b'.repeat(40) }], generated: false });
    await assert.rejects(
      readBack({ pkg: 'io.example.app', versionCode: '4', token: 'tok', apkPath: join(f.out, 'x.apk'), fetchImpl: api.fetchImpl, log() {} }),
      /^Error: HUB_PLAY_READBACK_PENDING io\.example\.app versionCode=4: /);
  } finally { await f.cleanup(); }
});

test('universalApkOf picks the universal entry', () => {
  assert.equal(universalApkOf({ generatedApks: [{ generatedSplitApk: { downloadId: 'S1' } }, { generatedUniversalApk: { downloadId: 'U1' } }] }).downloadId, 'U1');
  assert.equal(universalApkOf({ generatedApks: [{ generatedSplitApk: { downloadId: 'S1' } }] }), null);
});

// ---- the play-readback command end to end ----

// releases: the JSON the releases listing returns. An asset may carry a `content` field: the gh fake answers it for
// the raw octet-stream fetch of that asset id.
function readbackFixture(f, { releases = [] } = {}) {
  const gh = async args => {
    const line = args.join(' ');
    await writeFile(join(f.root, 'gh.log'), `${await f.ghLog()}gh ${line}\n`);
    if (/^api repos\/delorenj\/example-app\/releases\?per_page=100$/.test(line)) return JSON.stringify(releases);
    const asset = /releases\/assets\/(\d+)/.exec(line)?.[1];
    if (asset) {
      const found = releases.flatMap(release => release.assets ?? []).find(entry => `${entry.id}` === asset);
      return found?.content ?? '';
    }
    return '';
  };
  const identity = () => ({ package: 'io.example.app', versionCode: 4, versionName: '0.3.0' });
  const signers = () => ['cd'.repeat(32)];
  const options = config => ({ env: { ...f.env, PLAY_TOKEN: 'tok', GH_TOKEN: 'gh-tok' }, fetchImpl: null, gh, readApkIdentity: identity, apkSigners: signers });
  return { gh, identity, signers, options };
}

test('the play-readback command writes its receipt with the bundle, the APK and the deleted edit; the universal APK and receipts are the artifact', async () => {
  const sha256 = 'a'.repeat(64);
  const f = await fixture();
  const { gh, identity, signers } = readbackFixture(f, { releases: [{ tag_name: 'v0.3.0', assets: [{ name: 'example-app-0.3.0-4.aab', digest: `sha256:${sha256}`, id: 1 }, { name: 'example-app-0.3.0-4.aab.sha256', id: 2, content: `${sha256}  example-app-0.3.0-4.aab\n` }] }] });
  try {
    const api = playApi({ bundles: [{ versionCode: 4, sha256, sha1: 'b'.repeat(40) }] });
    const logs = [];
    const config = f.configure('play-readback', ['--play-readback', '4']);
    await playReadback(config, { env: { ...f.env, PLAY_TOKEN: 'tok', GH_TOKEN: 'gh-tok' }, fetchImpl: api.fetchImpl, gh, readApkIdentity: identity, apkSigners: signers, log: line => logs.push(line) });
    const receipt = await readJson(join(f.out, 'play-readback/hub-receipt-play-readback.json'));
    assert.equal(receipt.play.package, 'io.example.app');
    assert.equal(receipt.play.versionCode, 4);
    assert.equal(receipt.play.edit, 'E1');
    assert.equal(receipt.play.edit_deleted, true);
    assert.equal(receipt.play.committed, false);
    assert.equal(receipt.bundle.sha256, sha256);
    assert.equal(receipt.universal_apk.name, 'example-app-4-universal.apk');
    assert.equal(receipt.universal_apk.package, 'io.example.app');
    assert.equal(receipt.universal_apk.signer_sha256, 'cd'.repeat(32));
    assert.equal(receipt.universal_apk.certificate_matches, false, 'Google says it re-signed with its own certificate');
    assert.deepEqual(receipt.retained, { release: 'v0.3.0', asset: 'example-app-0.3.0-4.aab', api_digest: sha256, sha256_file: 'example-app-0.3.0-4.aab.sha256', matches: true });
    assert.equal(receipt.outcome, 'success');
    assert.ok(logs.some(line => new RegExp(`^HUB_PLAY_READBACK_OK io\\.example\\.app versionCode=4 bundle_sha256=${sha256} universal_apk=example-app-4-universal\\.apk apk_sha256=[0-9a-f]{64} bytes=23$`).test(line)), logs.join('\n'));
    assert.ok(logs.some(line => /^HUB_PLAY_READBACK_RETAINED example-app-0\.3\.0-4\.aab on Release v0\.3\.0: /.test(line)), logs.join('\n'));
  } finally { await f.cleanup(); }
});

test('the readback fails when the retained release asset does not match what Play reports', async () => {
  const f = await fixture();
  const { gh, identity, signers } = readbackFixture(f, { releases: [{ tag_name: 'v0.3.0', assets: [{ name: 'example-app-0.3.0-4.aab', digest: `sha256:${'9'.repeat(64)}`, id: 1 }, { name: 'example-app-0.3.0-4.aab.sha256', id: 2, content: `${'9'.repeat(64)}  example-app-0.3.0-4.aab\n` }] }] });
  try {
    const api = playApi({ bundles: [{ versionCode: 4, sha256: 'a'.repeat(64), sha1: 'b'.repeat(40) }] });
    const config = f.configure('play-readback', ['--play-readback', '4']);
    await assert.rejects(
      playReadback(config, { env: { ...f.env, PLAY_TOKEN: 'tok', GH_TOKEN: 'gh-tok' }, fetchImpl: api.fetchImpl, gh, readApkIdentity: identity, apkSigners: signers, log() {} }),
      /^Error: HUB_PLAY_READBACK_MISMATCH retained: /);
    const receipt = await readJson(join(f.out, 'play-readback/hub-receipt-play-readback.json'));
    assert.equal(receipt.outcome, 'failure');
    assert.match(receipt.reason, /^HUB_PLAY_READBACK_MISMATCH/);
  } finally { await f.cleanup(); }
});

test('the readback fails when the universal APK is not the asked package or code', async () => {
  const f = await fixture();
  const { gh, signers } = readbackFixture(f);
  try {
    const api = playApi({ bundles: [{ versionCode: 4, sha256: 'a'.repeat(64), sha1: 'b'.repeat(40) }] });
    const config = f.configure('play-readback', ['--play-readback', '4']);
    await assert.rejects(
      playReadback(config, { env: { ...f.env, PLAY_TOKEN: 'tok', GH_TOKEN: 'gh-tok' }, fetchImpl: api.fetchImpl, gh, readApkIdentity: () => ({ package: 'io.example.other', versionCode: 4 }), apkSigners: signers, log() {} }),
      /^Error: HUB_PLAY_READBACK_MISMATCH package: /);
    await assert.rejects(
      playReadback(config, { env: { ...f.env, PLAY_TOKEN: 'tok', GH_TOKEN: 'gh-tok' }, fetchImpl: api.fetchImpl, gh, readApkIdentity: () => ({ package: 'io.example.app', versionCode: 5 }), apkSigners: signers, log() {} }),
      /^Error: HUB_PLAY_READBACK_MISMATCH versionCode: /);
  } finally { await f.cleanup(); }
});

test('a readback with no retained evidence records none instead of inventing one', async () => {
  const f = await fixture();
  const { gh, identity, signers } = readbackFixture(f);
  try {
    const api = playApi({ bundles: [{ versionCode: 4, sha256: 'a'.repeat(64), sha1: 'b'.repeat(40) }] });
    const logs = [];
    const config = f.configure('play-readback', ['--play-readback', '4']);
    await playReadback(config, { env: { ...f.env, PLAY_TOKEN: 'tok', GH_TOKEN: 'gh-tok' }, fetchImpl: api.fetchImpl, gh, readApkIdentity: identity, apkSigners: signers, log: line => logs.push(line) });
    const receipt = await readJson(join(f.out, 'play-readback/hub-receipt-play-readback.json'));
    assert.equal(receipt.retained, null);
    assert.ok(logs.some(line => /^HUB_PLAY_READBACK_RETAINED none: /.test(line)), logs.join('\n'));
  } finally { await f.cleanup(); }
});

// ---- the release lane attaches the retained AAB (or holds it on a public repo) ----

// The play step's output as the release step finds it: the retained copy and its sha256 file beside the play receipt,
// whose retained.via 'release' names the name. ghPrivate answers the repo-privacy probe.
async function releaseFixture({ ghPrivate = 'true' } = {}) {
  const f = await fixture();
  const bytes = await readFile(join(f.out, 'android/App.aab'));
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const name = 'example-app-0.3.0-4.aab';
  // The device APK and its lane receipt, as the android lane left them: a private repo's Release carries them too.
  await writeFile(join(f.out, 'android/App.apk'), 'apk');
  await writeFile(join(f.out, 'android/hub-receipt-android.json'), JSON.stringify({ lane: 'android', outcome: 'success' }));
  await writeFile(join(f.out, `android/${name}`), bytes);
  await writeFile(join(f.out, `android/${name}.sha256`), `${sha256}  ${name}\n`);
  const playReceipt = {
    lane: 'android-play', outcome: 'success',
    play: { package: 'io.example.app', versionCode: 4, bundle: { name, bytes: bytes.length, sha256 }, retained: { via: 'release', name, sha256_file: `${name}.sha256` } },
  };
  await writeFile(join(f.out, 'android/hub-receipt-android-play.json'), JSON.stringify(playReceipt));
  const noLatest = async () => ({ ok: false, status: 404, json: async () => ({}), text: async () => '' });
  return { f, sha256, name, env: { ...f.env, GH_TOKEN: 'token', GH_PRIVATE: ghPrivate }, fetchImpl: noLatest };
}

test('the release lane attaches the exact uploaded AAB and its .sha256 to the private Release, and says so in the notes and receipt', async () => {
  const { f, sha256, name, env, fetchImpl } = await releaseFixture();
  try {
    const result = await release(f.configure('release', ['--dry-run', 'false']), { env, fetchImpl });
    assert.equal(result.play_bundle.name, name);
    assert.equal(result.play_bundle.sha256, sha256);
    assert.equal(result.play_bundle.retained, 'release');
    const log = await f.ghLog();
    const assets = /gh release create v0\.3\.0 (.*?) --repo /.exec(log)?.[1].split(' ').map(path => path.split('/').pop()) ?? [];
    assert.deepEqual(assets, ['App.apk', 'hub-receipt-android.json', name, `${name}.sha256`], log);
    assert.match(log, /--verify-tag\n$/);
    assert.match(log, new RegExp(`Play bundle: ${name.replaceAll('.', '\\.')} sha256 ${sha256} \\(\\d+ bytes; Play's sha256 matched at upload\\)\\.`));
    const receipt = await readJson(join(f.out, 'android/hub-receipt-android-release.json'));
    assert.equal(receipt.play_bundle.name, name);
    assert.equal(receipt.play_bundle.sha256, sha256);
    assert.equal(receipt.play_bundle.retained, 'release');
    assert.equal(receipt.play_bundle.tag, 'v0.3.0');
    assert.match(await readFile(f.env.GITHUB_OUTPUT, 'utf8'), /^play_bundle_release=true$/m);
  } finally { await f.cleanup(); }
});

test('a public repo holds the retained AAB off the Release: the play-bundle run artifact keeps it, the notes say so', async () => {
  const { f, sha256, name, env, fetchImpl } = await releaseFixture({ ghPrivate: 'false' });
  try {
    const result = await release(f.configure('release', ['--dry-run', 'false']), { env, fetchImpl });
    assert.equal(result.play_bundle, null);
    assert.equal(result.play_bundle_held, true);
    const log = await f.ghLog();
    assert.match(log, /gh release create v0\.3\.0 --repo/, 'the public Release still publishes (no assets ride it)');
    assert.doesNotMatch(log, new RegExp(`/android/${name.replaceAll('.', '\\.')} `), 'the AAB itself never lands on a public Release (the notes only name its sha256)');
    const receipt = await readJson(join(f.out, 'android/hub-receipt-android-release.json'));
    assert.equal(receipt.play_bundle, undefined);
    assert.match(log, new RegExp(`--notes [\\s\\S]*Play bundle ${name.replaceAll('.', '\\.')} \\(sha256 ${sha256}, \\d+ bytes; Play's sha256 matched at upload\\) stays off this public Release; it is kept as the play-bundle run artifact \\(30 days\\)\\.`), log);
    assert.match(await readFile(f.env.GITHUB_OUTPUT, 'utf8'), /^play_bundle_release=$/m, 'empty: the workflow\'s fallback uploads the play-bundle artifact');
  } finally { await f.cleanup(); }
});

test('a play receipt that names a retained bundle whose file no longer matches fails the release lane', async () => {
  const { f, name, env, fetchImpl } = await releaseFixture();
  try {
    await writeFile(join(f.out, `android/${name}`), 'tampered');
    await assert.rejects(
      release(f.configure('release', ['--dry-run', 'false']), { env, fetchImpl }),
      new RegExp(`^Error: the retained Play bundle ${name.replaceAll('.', '\\.')} has sha256=[0-9a-f]{64}, the play receipt says`));
    assert.equal((await f.ghLog()).includes('release create'), false, 'no Release was made');
  } finally { await f.cleanup(); }
});
