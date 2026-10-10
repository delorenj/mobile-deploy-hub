// Catch-up tests (design-hub-v1.1.md K, catch-up): pending only and the inflight version skipped; idle with no event
// when a device is away; the AHEAD, CONFIRMED, INSTALLED and equal-code reinstall branches; sha256 and signer checks
// before an install; one event per status change and none for a device the deploy installed; the third failure sends
// .failed, then silence; record leaves a newer pointer alone; the locks are the deploy jobs' locks; watch mode
// changes nothing. The S26 is a fake adb binary over a state folder, the build tools read a fake APK, S3 is a fake
// fetch over a Map, and the iPad is a fake devicectl object.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bbEmitPath, uuidv5 } from '../ci/lib/announce.mjs';
import { loadDevices } from '../ci/lib/devices.mjs';
import { withLock } from '../ci/lib/lock.mjs';
import { compareBuild, validateLatest } from '../ci/lib/latest.mjs';
import { loadPolicy } from '../ci/lib/policy.mjs';
import {
  androidPass, androidPlan, compareIos, hubWriter, inCidr, iosPass, iosPlan, latestProblems, linuxContext,
  loadSettings, macContext, parseRecordArgs, readMode, reasonText, record, recordArgs, retry, serviceAccountEnv, settingsFrom, sshRecordCommand, withFallback, writeMode,
} from './catchup.mjs';
import { catchupEvent, producer, sendCatchupEvent } from './report.mjs';
import { downloadVerified, readJson } from './store.mjs';

const hubRoot = fileURLToPath(new URL('../../', import.meta.url));
const devices = loadDevices({});
const signer = '2d4954863dabb5da86d69ce4b60b3e400e73669b50a80658b0941440a7941a97';
const sha = text => createHash('sha256').update(text).digest('hex');
const slug = 'tower-of-lost-things';
const pkg = 'io.automaticai.towerofdumbthings';
const commit = '1a2b3c4d'.repeat(5);
const runId = '37940000000';
const repo = 'delorenj/tower-of-lost-things';
const now = () => new Date('2026-10-10T12:00:00Z');
const policy = loadPolicy().policy;
const runOf = id => ({ repo, id, attempt: 1, url: `https://github.com/${repo}/actions/runs/${id}` });
const correlationOf = id => uuidv5(`mobile-deploy:${repo}:${id}`);

// ---------------------------------------------------------------------------------------------------- fixtures

// A fake APK is one line the fake phone and build tools read: package, versionName, versionCode, signer, salt.
const apkText = ({ version = '0.2.2', code = 4, signerSha = signer, salt = '' } = {}) => `${pkg} ${version} ${code} ${signerSha} ${salt}`;
// A fake IPA: bundle, version, build, salt.
const ipaText = ({ version = '0.2.2', build = '4', salt = '' } = {}) => `${pkg} ${version} ${build} ${salt}`;

function androidBlock({ version = '0.2.2', code = 4, text = apkText({ version, code }), status = 'pending', by = null, failures = 0, device = {}, id = runId } = {}) {
  return {
    package: pkg, version, code,
    key: `${slug}/${version}/${slug}-${version}-${code}.apk`,
    url: `https://s3.delo.sh/builds/${slug}/${version}/${slug}-${version}-${code}.apk`,
    bytes: Buffer.byteLength(text), sha256: sha(text), signer_sha256: signer,
    quickdrop: `builds/${slug}-${version}-${code}.apk`,
    device: { name: 'S26', model: 'SM-S948U', status, since: '2026-10-09T20:00:00Z', by, reason: status === 'pending' ? "not on big-chungus's adb" : null, failures, ...device },
    run: runOf(id), correlation: correlationOf(id), commit,
  };
}

function iosBlock({ version = '0.2.2', build = '4', text = ipaText({ version, build }), status = 'pending', by = null, failures = 0, id = runId } = {}) {
  return {
    bundle: pkg, version, build,
    key: `${slug}/${version}/${slug}-${version}-${build}.ipa`,
    url: `https://s3.delo.sh/builds/${slug}/${version}/${slug}-${version}-${build}.ipa`,
    bytes: Buffer.byteLength(text), sha256: sha(text),
    manifest_url: `https://s3.delo.sh/builds/${slug}/ios/manifest.plist`,
    install_url: `itms-services://?action=download-manifest&url=https://s3.delo.sh/builds/${slug}/ios/manifest.plist`,
    device: { name: 'iPad', model: 'iPad14,5', status, since: '2026-10-09T20:00:00Z', by, reason: status === 'pending' ? 'the iPad was unreachable' : null, failures },
    run: runOf(id), correlation: correlationOf(id), commit,
  };
}

function latestDoc({ android = androidBlock(), ios = null, id = runId } = {}) {
  return validateLatest({
    schema: 1, slug, name: 'Tower of Lost Things', version: android?.version ?? ios?.version ?? '0.2.2', commit, hub_ref: 'v1.1.0',
    run: runOf(id), correlation: correlationOf(id), updated_at: '2026-10-09T20:00:00Z',
    android, ios,
  }, { slug, base: 'https://s3.delo.sh/builds' });
}

// S3 as a Map of keys under the builds bucket. Every request is recorded; ETags make 304s possible.
function fakeS3() {
  const objects = new Map();
  const requests = [];
  const roots = ['http://127.0.0.1:9012/builds/', 'https://s3.delo.sh/builds/'];
  const fetchImpl = async (url, options = {}) => {
    const root = roots.find(prefix => url.startsWith(prefix));
    assert.ok(root, `the catch-up only reads the builds bucket, not ${url}`);
    const key = url.slice(root.length);
    const ifNoneMatch = options.headers?.['if-none-match'];
    requests.push({ url, key, ifNoneMatch });
    const object = objects.get(key);
    if (!object) return new Response('<Error><Code>NoSuchKey</Code></Error>', { status: 404 });
    const etag = `"${sha(object.body).slice(0, 16)}"`;
    if (ifNoneMatch && ifNoneMatch === etag) return new Response(null, { status: 304, headers: { etag } });
    return new Response(object.body, { status: 200, headers: { etag, 'last-modified': object.lastModified ?? 'Fri, 09 Oct 2026 20:00:00 GMT' } });
  };
  return {
    objects, requests, fetchImpl,
    put: (key, body, lastModified) => objects.set(key, { body: typeof body === 'string' ? body : JSON.stringify(body), lastModified }),
    json: key => (objects.has(key) ? JSON.parse(objects.get(key).body) : null),
    writer: { writes: [], putJson(key, value) { this.writes.push({ key, value: structuredClone(value) }); objects.set(key, { body: JSON.stringify(value) }); } },
  };
}

function script(path, body) {
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
}

// The S26 as a shell script over a folder: apps/<package>.apk is what is installed; `away` hides the phone;
// `refuse` makes every install fail the way Android refuses another signer. Every call is logged.
const fakeAdb = state => `echo "$*" >> "${state}/calls.log"
[ "$1" = "-s" ] && shift 2
case "$1" in
  start-server|connect) exit 0 ;;
  mdns) exit 0 ;;
  devices) printf 'List of devices attached\\n'; [ -f "${state}/away" ] || printf 'adb-R5GL43A7PCH-zz._adb-tls-connect._tcp\\tdevice\\n'; exit 0 ;;
  install)
    shift; [ "$1" = "-r" ] || { echo "fake adb: refuses $*"; exit 1; }
    apk="$2"
    [ -f "${state}/refuse" ] && { echo "Failure [INSTALL_FAILED_UPDATE_INCOMPATIBLE: Package signatures do not match]"; exit 1; }
    set -- $(cat "$apk"); cp "$apk" "${state}/apps/$1.apk"; echo Success; exit 0 ;;
  shell)
    shift
    case "$1 $2" in
      "getprop ro.serialno") echo R5GL43A7PCH ;;
      "getprop ro.product.model") echo SM-S948U ;;
      "dumpsys package") f="${state}/apps/$3.apk"; [ -f "$f" ] || exit 0; set -- $(cat "$f"); printf 'Packages:\\n  Package [%s] (1):\\n    versionCode=%s minSdk=24\\n    versionName=%s\\n' "$1" "$3" "$2" ;;
      "pm path") echo "package:/data/app/$3/base.apk" ;;
      "dumpsys activity") if [ -f "${state}/playing" ]; then echo "  topResumedActivity=ActivityRecord{1a2b u0 $(cat "${state}/playing")/com.godot.game.GodotApp t9}"; else echo "  topResumedActivity=ActivityRecord{1a2b u0 com.android.launcher3/.Launcher t1}"; fi ;;
      "dumpsys power") if [ -f "${state}/asleep" ]; then echo "  mWakefulness=Asleep"; else echo "  mWakefulness=Awake"; fi ;;
      "sha256sum /data/app/"*) p=\${2#/data/app/}; p=\${p%/base.apk}; sha256sum "${state}/apps/$p.apk" | cut -d' ' -f1 | sed "s#\\$#  $2#" ;;
      *) echo "fake adb: unknown shell $*" >&2; exit 1 ;;
    esac ;;
  *) echo "fake adb: unknown $*" >&2; exit 1 ;;
esac`;

// big-chungus: fake adb and build tools, a lock folder the "deploy" shares, and a linux context over the fake S3.
function linuxHost({ mode = 'live', s3 = fakeS3(), emit, writer, pages = async () => {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'hub-catchup-'));
  const state = join(root, 'phone');
  const bin = join(root, 'bin');
  const tools = join(root, 'sdk/build-tools/35.0.0');
  for (const dir of [join(state, 'apps'), bin, tools]) mkdirSync(dir, { recursive: true });
  script(join(bin, 'adb'), fakeAdb(state));
  script(join(tools, 'apksigner'), 'set -- $(cat "$3")\necho "Signer #1 certificate SHA-256 digest: $4"');
  script(join(tools, 'aapt2'), 'set -- $(cat "$3")\necho "package: name=\'$1\' versionCode=\'$3\' versionName=\'$2\' platformBuildVersionName=\'15\'"');
  const env = { PATH: process.env.PATH, HUB_ADB: join(bin, 'adb'), ANDROID_HOME: join(root, 'sdk'), JAVA_HOME: join(root, 'java'), HUB_LOCK_DIR: join(root, 'locks'), XDG_CONFIG_HOME: join(root, 'config'), XDG_STATE_HOME: join(root, 'state') };
  if (mode === 'live') writeMode('live', { env, home: root });
  const logs = [];
  const events = [];
  const bus = { down: false };
  const ctx = linuxContext({
    env, home: root, log: line => logs.push(line), now, devices, fetchImpl: s3.fetchImpl, writer: writer ? writer({ env, home: root }) : s3.writer,
    settings: settingsFrom(policy),
    emit: emit ?? (event => { if (bus.down) throw new Error('bb-emit --strict refused the event:\nNATS 127.0.0.1:4222 refused the connection'); events.push(event); }),
    pages: pages ?? undefined, adbWaitMs: 300, lockWaitMs: 300,
  });
  const phone = {
    install: text => writeFileSync(join(state, 'apps', `${text.split(' ')[0]}.apk`), text),
    installed: () => { try { return readFileSync(join(state, 'apps', `${pkg}.apk`), 'utf8'); } catch { return null; } },
    away: () => writeFileSync(join(state, 'away'), ''),
    back: () => rmSync(join(state, 'away'), { force: true }),
    refuse: on => (on ? writeFileSync(join(state, 'refuse'), '') : rmSync(join(state, 'refuse'), { force: true })),
    playing: name => (name ? writeFileSync(join(state, 'playing'), name) : rmSync(join(state, 'playing'), { force: true })),
    asleep: on => (on ? writeFileSync(join(state, 'asleep'), '') : rmSync(join(state, 'asleep'), { force: true })),
    calls: () => { try { return readFileSync(join(state, 'calls.log'), 'utf8'); } catch { return ''; } },
    clearCalls: () => rmSync(join(state, 'calls.log'), { force: true }),
  };
  const lines = pattern => logs.filter(line => pattern.test(line));
  return { root, env, ctx, s3, logs, lines, events, bus, phone, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

// Publishes a build the way deliver does: the versioned bytes, then latest.json.
function publish(s3, { latest, apk, ipa }) {
  if (apk) s3.put(latest.android.key, apk);
  if (ipa && latest.ios?.key) s3.put(latest.ios.key, ipa);
  s3.put(`${latest.slug}/latest.json`, latest);
}

const latestOf = s3 => s3.json(`${slug}/latest.json`);

// ---------------------------------------------------------------------------------------------------- decisions

test('versions: semver first, then the build as a number or a dotted version; unknown shapes cannot be compared', () => {
  assert.equal(compareBuild('10', '9'), 1);
  assert.equal(compareBuild('0.2.5', '0.2.10'), -1, "Gruvato's iOS build is a dotted version");
  assert.equal(compareIos({ version: '0.2.2', build: '4' }, { version: '0.2.2', build: '4' }), 0);
  assert.equal(compareIos({ version: '0.2.10', build: '1' }, { version: '0.2.9', build: '99' }), 1);
  assert.equal(compareIos({ version: '0.2.2', build: '3' }, { version: '0.2.2', build: '4' }), -1);
  assert.equal(compareIos(null, { version: '0.2.2', build: '4' }), -1, 'nothing installed is older');
  assert.equal(compareIos({ version: 'preview-17', build: '17' }, { version: '0.0.20', build: '20' }), null);
  assert.deepEqual(iosPlan({ version: 'preview-17', build: '17' }, { version: '0.0.20', build: '20' }).action, 'conflict');
  assert.deepEqual(iosPlan({ version: '0.3.0', build: '1' }, { version: '0.2.2', build: '4' }).action, 'ahead');
  const block = { version: '0.2.2', code: 4 };
  assert.equal(androidPlan(null, block).action, 'install');
  assert.equal(androidPlan({ versionName: '0.2.1', versionCode: 3 }, block).action, 'install');
  assert.equal(androidPlan({ versionName: '0.2.9', versionCode: 9 }, block).action, 'ahead');
  assert.equal(androidPlan({ versionName: '0.2.2', versionCode: 4 }, block).action, 'compare-bytes');
  assert.equal(androidPlan({ versionName: 'preview-4', versionCode: 4 }, block).action, 'conflict');
  assert.ok(inCidr('192.168.1.23', '192.168.1.0/24'));
  assert.ok(!inCidr('172.30.235.16', '192.168.1.0/24'), "a phone hotspot's gateway is metered");
  assert.ok(!inCidr(undefined, '192.168.1.0/24'), 'no gateway reads as metered');
});

test('latest.json is held to the contract before anything acts on it', () => {
  const good = latestDoc({ ios: iosBlock() });
  assert.deepEqual(latestProblems(good, slug), []);
  const bad = {
    'another app': { ...good, slug: 'gruvato' },
    'schema 2': { ...good, schema: 2 },
    'a key outside the version folder': { ...good, android: { ...good.android, key: `${slug}/../gruvato/x.apk` } },
    'no signer pin': { ...good, android: { ...good.android, signer_sha256: 'nope' } },
    'a status nobody defined': { ...good, android: { ...good.android, device: { ...good.android.device, status: 'maybe' } } },
    'an iOS build as a number': { ...good, ios: { ...good.ios, build: 4 } },
    'no run': { ...good, run: { id: 'abc' } },
    'a device field the contract does not know': { ...good, android: { ...good.android, device: { ...good.android.device, mood: 'sad' } } },
    'a key that names another release': { ...good, android: { ...good.android, key: `${slug}/0.2.2/${slug}-0.2.2-3.apk`, url: `https://s3.delo.sh/builds/${slug}/0.2.2/${slug}-0.2.2-3.apk` } },
    'a url that is not the key\'s': { ...good, android: { ...good.android, url: 'https://evil.example/x.apk' } },
  };
  for (const [name, latest] of Object.entries(bad)) assert.notDeepEqual(latestProblems(latest, slug, 'https://s3.delo.sh/builds'), [], name);
  const settings = loadSettings();
  assert.deepEqual(settings.apps.map(app => app.slug), ['tower-of-lost-things', 'green-in-between', 'gruvato']);
  assert.deepEqual([settings.loopbackRoot, settings.publicRoot, settings.maxFailures, settings.lanCidr], ['http://127.0.0.1:9012/builds', 'https://s3.delo.sh/builds', 3, '192.168.1.0/24']);
  assert.match(settings.digest, /^[0-9a-f]{8}$/, 'read from tools/ci/policy.json through the hub\'s strict parser');
});

// ---------------------------------------------------------------------------------------------------- the S26 pass

test('only pending builds are acted on; a build the deploy installed is never touched; a deploy in flight holds every older pending build', async () => {
  const host = linuxHost();
  try {
    publish(host.s3, { latest: latestDoc({ android: androidBlock({ status: 'installed', by: 'deploy' }) }), apk: apkText() });
    host.phone.install(apkText({ version: '0.2.1', code: 3 }));
    await androidPass(host.ctx);
    assert.equal(host.phone.calls(), '', 'no adb call at all');
    assert.deepEqual([host.events.length, host.s3.writer.writes.length], [0, 0], 'no event, no write for a device the run installed');
    assert.match(host.lines(/HUB_CATCHUP_IDLE android live/)[0], /tower-of-lost-things 0\.2\.2 \(4\) installed, green-in-between unpublished, gruvato unpublished/);

    publish(host.s3, { latest: latestDoc(), apk: apkText() });
    host.s3.put(`${slug}/inflight.json`, { version: '0.2.2', run: runId, started_at: '2026-10-10T11:50:00Z' });
    await androidPass(host.ctx);
    assert.equal(host.phone.calls(), '', 'a deploy is publishing this version: hands off');
    assert.equal(host.lines(/HUB_CATCHUP_IDLE tower-of-lost-things android 0\.2\.2 \(4\): deploy run 37940000000 is publishing 0\.2\.2/).length, 1);

    // A newer deploy in flight holds the older pending build too: it would be replaced minutes later (v1.1.3).
    host.s3.put(`${slug}/inflight.json`, { version: '0.2.3', run: '37950000000', started_at: '2026-10-10T11:50:00Z', platforms: ['android', 'ios'] });
    await androidPass(host.ctx);
    assert.equal(host.phone.calls(), '', 'an older pending build waits for the deploy of 0.2.3');
    assert.equal(host.lines(/deploy run 37950000000 is publishing 0\.2\.3/).length, 1);

    // That deploy's APK half is published (deliver-android took android off inflight.json): the S26 is free again.
    host.s3.put(`${slug}/inflight.json`, { version: '0.2.3', run: '37950000000', started_at: '2026-10-10T11:50:00Z', platforms: ['ios'] });
    await androidPass(host.ctx);
    assert.match(host.phone.installed(), /^io\.automaticai\.towerofdumbthings 0\.2\.2 4 /, 'a deploy that is only building the iPad does not hold the S26');
  } finally { host.cleanup(); }
});

test('an absent S26 is idle: no event, no write, no failure counted', async () => {
  const host = linuxHost();
  try {
    publish(host.s3, { latest: latestDoc(), apk: apkText() });
    host.phone.away();
    await androidPass(host.ctx);
    assert.doesNotMatch(host.phone.calls(), /install/);
    assert.deepEqual([host.events.length, host.s3.writer.writes.length], [0, 0]);
    assert.match(host.lines(/HUB_CATCHUP_IDLE/)[0], /tower-of-lost-things 0\.2\.2 \(4\) pending; the S26 is away/);
    assert.equal(host.s3.requests.filter(request => request.key.endsWith('.apk')).length, 0, 'nothing downloaded for an absent phone');
  } finally { host.cleanup(); }
});

test('a pass that cannot read any latest.json says so in its idle line and counts as failed, not healthy-empty', async () => {
  const host = linuxHost();
  try {
    publish(host.s3, { latest: latestDoc(), apk: apkText() });
    // Both of the Mac's paths down at once (the https fetch and the ssh fallback): the store itself throws.
    host.ctx.store = { ...host.ctx.store, latest: async () => { throw new Error('ssh big-chungus curl failed (exit 255)'); } };
    const result = await androidPass(host.ctx);
    assert.ok(result.errors >= 1, 'the pass exits non-zero through its error count');
    assert.equal(host.phone.calls(), '', 'a blind pass touches nothing');
    assert.equal(host.lines(/HUB_CATCHUP_ERROR tower-of-lost-things: cannot read latest\.json/).length, 1);
    assert.match(host.lines(/HUB_CATCHUP_IDLE android live/)[0], /nothing pending \(tower-of-lost-things, green-in-between, gruvato unreadable this pass\)/);
  } finally { host.cleanup(); }
});

test('INSTALLED: fetched over loopback, sha256 and signer checked, installed in place, read back, one event', async () => {
  const host = linuxHost();
  try {
    publish(host.s3, { latest: latestDoc(), apk: apkText() });
    host.phone.install(apkText({ version: '0.2.1', code: 3 }));
    const result = await androidPass(host.ctx);
    assert.equal(result.errors, 0);
    assert.match(host.phone.calls(), /install -r \S+\/\.cache\/mobile-deploy-hub\/catchup\/tower-of-lost-things\/tower-of-lost-things-0\.2\.2-4\.apk/);
    assert.equal(host.phone.installed(), apkText());
    assert.equal(host.lines(/^HUB_CATCHUP_INSTALLED tower-of-lost-things android 0\.2\.2 \(4\): installed over 0\.2\.1 \(3\); readback 0\.2\.2 \(4\), base\.apk sha256 matches/).length, 1);
    const device = latestOf(host.s3).android.device;
    assert.deepEqual([device.status, device.by, device.reason, device.event_pending], ['installed', 'catch-up', null, undefined]);
    assert.equal(host.events.length, 1);
    const [event] = host.events;
    assert.equal(event.type, 'bloodbank.project.deployment.completed');
    assert.equal(event.correlation, latestDoc().correlation, "the original deploy's correlation");
    assert.deepEqual([event.data.trigger, event.data.run.id, event.data.target.kind, event.data.target.id], ['catch-up', runId, 'android-device', 'R5GL43A7PCH']);
    assert.deepEqual(event.data.deliveries, [{ platform: 'android', target: 'SM-S948U', version: '0.2.2', build: '4', sha256: sha(apkText()), verified: true, status: 'installed', device: 'S26', by: 'catch-up' }]);
    assert.deepEqual(event.data.links, [{ rel: 'page', label: 'Builds', url: `https://s3.delo.sh/builds/${slug}/index.html` }]);
    assert.match(event.data.summary, /^Tower of Lost Things 0\.2\.2 \(4\) 1a2b3c4: S26 installed by catch-up, verified$/);

    // The next pass finds nothing to do and says nothing new.
    host.phone.clearCalls();
    await androidPass(host.ctx);
    assert.equal(host.phone.calls(), '');
    assert.equal(host.events.length, 1, 'one event per status change');
  } finally { host.cleanup(); }
});

test('the event names the deploy that published the block, not the newest deploy', async () => {
  const host = linuxHost();
  try {
    // The newest deploy (run 37950000000) built only the iPad; the Android block is still the one run 37940000000 published.
    const newest = '37950000000';
    publish(host.s3, { latest: latestDoc({ android: androidBlock(), ios: iosBlock({ version: '0.2.3', build: '5', status: 'installed', by: 'deploy', id: newest }), id: newest }), apk: apkText() });
    host.phone.install(apkText({ version: '0.2.1', code: 3 }));
    await androidPass(host.ctx);
    assert.equal(host.events.length, 1);
    const [event] = host.events;
    assert.deepEqual([event.data.run.id, event.correlation, event.data.run.hub_ref], [runId, correlationOf(runId), null]);
    assert.notEqual(event.correlation, correlationOf(newest));
    assert.equal(latestOf(host.s3).ios.device.status, 'installed', 'the other block is untouched');
    assert.equal(latestOf(host.s3).ios.run.id, newest);
  } finally { host.cleanup(); }
});

test('CONFIRMED: the same bytes are already on the S26 (from the link or Quickdrop): recorded as manual, nothing installed', async () => {
  const host = linuxHost();
  try {
    publish(host.s3, { latest: latestDoc(), apk: apkText() });
    host.phone.install(apkText());
    await androidPass(host.ctx);
    assert.doesNotMatch(host.phone.calls(), /\binstall -r\b/);
    assert.equal(host.s3.requests.filter(request => request.key.endsWith('.apk')).length, 0, 'nothing downloaded');
    assert.equal(host.lines(/^HUB_CATCHUP_CONFIRMED /).length, 1);
    assert.deepEqual([latestOf(host.s3).android.device.status, latestOf(host.s3).android.device.by], ['installed', 'manual']);
    assert.equal(host.events[0].data.deliveries[0].by, 'manual');
  } finally { host.cleanup(); }
});

test('equal code with other bytes is replaced in place; a newer S26 is never touched (AHEAD, no event)', async () => {
  const host = linuxHost();
  try {
    publish(host.s3, { latest: latestDoc(), apk: apkText() });
    host.phone.install(apkText({ salt: 'attempt-1' }));
    await androidPass(host.ctx);
    assert.match(host.phone.calls(), /install -r /);
    assert.equal(host.phone.installed(), apkText(), 'the published bytes replaced the other bytes of 0.2.2 (4)');
    assert.equal(latestOf(host.s3).android.device.by, 'catch-up');

    const ahead = linuxHost();
    try {
      publish(ahead.s3, { latest: latestDoc(), apk: apkText() });
      ahead.phone.install(apkText({ version: '0.2.9', code: 9 }));
      await androidPass(ahead.ctx);
      assert.doesNotMatch(ahead.phone.calls(), /\binstall -r\b/);
      assert.equal(ahead.phone.installed(), apkText({ version: '0.2.9', code: 9 }));
      assert.equal(ahead.lines(/^HUB_CATCHUP_AHEAD tower-of-lost-things android 0\.2\.2 \(4\): the S26 runs 0\.2\.9 \(9\); not touched/).length, 1);
      const device = latestOf(ahead.s3).android.device;
      assert.deepEqual([device.status, device.reason], ['skipped', 'the S26 runs 0.2.9 (9), ahead of this build']);
      assert.equal(ahead.events.length, 0, 'AHEAD sends no event');
    } finally { ahead.cleanup(); }
  } finally { host.cleanup(); }
});

test('the bytes are checked before any install: a wrong sha256 or a wrong signer never reaches the S26', async () => {
  const host = linuxHost();
  try {
    // Same size, other bytes: only the sha256 can tell.
    publish(host.s3, { latest: latestDoc({ android: androidBlock({ text: apkText({ salt: 'original' }) }) }), apk: apkText({ salt: 'tampered' }) });
    host.phone.install(apkText({ version: '0.2.1', code: 3 }));
    await androidPass(host.ctx);
    assert.doesNotMatch(host.phone.calls(), /\binstall -r\b/);
    assert.equal(host.lines(/HUB_CATCHUP_PENDING .*tower-of-lost-things-0\.2\.2-4\.apk has sha256 [0-9a-f]{12}\.\.\., latest\.json says [0-9a-f]{12}\.\.\./).length, 1);
    assert.deepEqual([latestOf(host.s3).android.device.status, latestOf(host.s3).android.device.failures], ['pending', 1]);
    assert.equal(readdirSync(join(host.root, '.cache/mobile-deploy-hub/catchup', slug)).length, 0, 'the bad download is not kept');
    assert.equal(host.events.length, 0);
  } finally { host.cleanup(); }

  const other = linuxHost();
  try {
    const foreign = apkText({ signerSha: 'f'.repeat(64) });
    publish(other.s3, { latest: latestDoc({ android: androidBlock({ text: foreign }) }), apk: foreign });
    other.phone.install(apkText({ version: '0.2.1', code: 3 }));
    await androidPass(other.ctx);
    assert.doesNotMatch(other.phone.calls(), /\binstall -r\b/);
    assert.equal(other.lines(/HUB_CATCHUP_PENDING .*APK signer f{64} differs from the pinned/).length, 1);
  } finally { other.cleanup(); }
});

test('the third failure gives up with one .failed event, then silence; retry starts over', async () => {
  const host = linuxHost();
  try {
    publish(host.s3, { latest: latestDoc(), apk: apkText() });
    host.phone.install(apkText({ version: '0.2.1', code: 3 }));
    host.phone.refuse(true);
    for (const attempt of [1, 2]) {
      await androidPass(host.ctx);
      const device = latestOf(host.s3).android.device;
      assert.deepEqual([device.status, device.failures], ['pending', attempt]);
      assert.match(device.reason, new RegExp(`^catch-up attempt ${attempt} of 3 failed at install: adb install -r refused it: Failure \\[INSTALL_FAILED_UPDATE_INCOMPATIBLE`));
    }
    assert.equal(host.events.length, 0, 'no event while it is still trying');
    await androidPass(host.ctx);
    const failed = latestOf(host.s3).android.device;
    assert.deepEqual([failed.status, failed.failures, failed.event_pending], ['failed', 3, undefined]);
    assert.equal(host.lines(/^HUB_CATCHUP_FAILED tower-of-lost-things android 0\.2\.2 \(4\): catch-up failed 3 times at install/).length, 1);
    assert.equal(host.events.length, 1);
    const [event] = host.events;
    assert.equal(event.type, 'bloodbank.project.deployment.failed');
    assert.deepEqual([event.data.stage, event.data.trigger, event.data.deliveries[0].status], ['install', 'catch-up', 'failed']);
    assert.deepEqual(event.data.links.map(link => link.rel), ['page', 'run']);

    host.phone.clearCalls();
    await androidPass(host.ctx);
    assert.equal(host.phone.calls(), '', 'a failed device is left alone');
    assert.equal(host.events.length, 1, 'then silence');

    host.phone.refuse(false);
    const device = await retry(host.ctx, slug, 'android');
    assert.deepEqual([device.status, device.failures], ['pending', 0]);
    await androidPass(host.ctx);
    assert.equal(latestOf(host.s3).android.device.status, 'installed');
    assert.equal(host.events.length, 2);
  } finally { host.cleanup(); }
});

test('a dead bus keeps the device update and the next pass sends the event exactly once', async () => {
  const host = linuxHost();
  try {
    publish(host.s3, { latest: latestDoc(), apk: apkText() });
    host.phone.install(apkText({ version: '0.2.1', code: 3 }));
    host.bus.down = true;
    await androidPass(host.ctx);
    let device = latestOf(host.s3).android.device;
    assert.deepEqual([device.status, device.event_pending], ['installed', true]);
    assert.equal(host.lines(/HUB_CATCHUP_REPORTED .*not sent .*the next S26 pass sends it/).length, 1);
    assert.equal(host.events.length, 0);

    host.bus.down = false;
    host.phone.clearCalls();
    await androidPass(host.ctx);
    assert.equal(host.phone.calls(), '', 'the resend does not touch the phone');
    device = latestOf(host.s3).android.device;
    assert.deepEqual([device.status, device.event_pending], ['installed', undefined]);
    assert.equal(host.events.length, 1);
    await androidPass(host.ctx);
    assert.equal(host.events.length, 1, 'exactly once');
  } finally { host.cleanup(); }
});

test('policy event.catch_up false: the device is still recorded, and no event is sent or marked', async () => {
  const host = linuxHost();
  try {
    host.ctx.settings = { ...host.ctx.settings, events: false };
    publish(host.s3, { latest: latestDoc(), apk: apkText() });
    host.phone.install(apkText({ version: '0.2.1', code: 3 }));
    await androidPass(host.ctx);
    const device = latestOf(host.s3).android.device;
    assert.deepEqual([device.status, device.by, device.event_pending], ['installed', 'catch-up', undefined]);
    assert.equal(host.events.length, 0);
    assert.equal(settingsFrom(policy).events, policy.event.catch_up);
  } finally { host.cleanup(); }
});

test('record leaves a newer pointer alone, and still reports the install it was told about', async () => {
  const host = linuxHost();
  try {
    publish(host.s3, { latest: latestDoc({ android: androidBlock({ version: '0.2.3', code: 5 }), id: '37950000000' }), apk: apkText({ version: '0.2.3', code: 5 }) });
    const before = JSON.stringify(latestOf(host.s3));
    const facts = { slug, platform: 'android', version: '0.2.2', build: '4', status: 'installed', by: 'catch-up', sha256: sha(apkText()), commit, run: { id: runId, attempt: 1 } };
    const result = await record(host.ctx, parseRecordArgs(recordArgs(facts)));
    assert.deepEqual([result.moved, result.sent], [true, true]);
    assert.equal(JSON.stringify(latestOf(host.s3)), before, 'the newer block is untouched');
    assert.equal(host.s3.writer.writes.length, 0);
    assert.equal(host.events.length, 1);
    assert.deepEqual([host.events[0].data.artifact.version, host.events[0].data.run.id, host.events[0].correlation], ['0.2.2', runId, uuidv5(`mobile-deploy:${repo}:${runId}`)]);
    const skipped = await record(host.ctx, { ...facts, status: 'skipped', reason: 'ahead' });
    assert.deepEqual([skipped.moved, skipped.sent], [true, false]);
  } finally { host.cleanup(); }
});

test('the locks are the deploy jobs\' locks: a held adb lock idles the pass, record waits for s3-<slug>', async () => {
  const host = linuxHost();
  try {
    publish(host.s3, { latest: latestDoc(), apk: apkText() });
    host.phone.install(apkText({ version: '0.2.1', code: 3 }));
    let release;
    const held = withLock('adb', () => new Promise(done => { release = done; }), { env: host.env, log: () => {} });
    while (!release) await new Promise(done => setTimeout(done, 10));
    await androidPass(host.ctx);
    assert.equal(host.phone.calls(), '', 'the deploy has the S26');
    assert.equal(host.lines(/HUB_CATCHUP_IDLE android live: a deploy is using the S26 \(adb lock\)/).length, 1);
    release();
    await held;

    let releaseS3;
    const deliver = withLock(`s3-${slug}`, () => new Promise(done => { releaseS3 = done; }), { env: host.env, log: () => {} });
    while (!releaseS3) await new Promise(done => setTimeout(done, 10));
    setTimeout(() => releaseS3(), 300);
    await androidPass(host.ctx);
    await deliver;
    assert.ok(host.lines(/HUB_LOCK_WAIT s3-tower-of-lost-things/).length >= 1, 'record waited for deliver');
    assert.equal(latestOf(host.s3).android.device.status, 'installed');
    assert.equal(existsSync(join(host.env.HUB_LOCK_DIR, 'adb.lock')), false, 'every lock is released');
  } finally { host.cleanup(); }
});

test('watch mode reads and logs what it would do: no download, no install, no write, no event', async () => {
  const host = linuxHost({ mode: 'watch' });
  try {
    assert.equal(readMode({ env: host.env, home: host.root }), 'watch', 'a host without a mode file watches');
    publish(host.s3, { latest: latestDoc(), apk: apkText() });
    host.phone.install(apkText({ version: '0.2.1', code: 3 }));
    await androidPass(host.ctx);
    assert.match(host.lines(/^HUB_CATCHUP_WATCH /)[0], /tower-of-lost-things android 0\.2\.2 \(4\): would install: 0\.2\.2 \(4\) over 0\.2\.1 \(3\) from http:\/\/127\.0\.0\.1:9012\/builds\/tower-of-lost-things\/0\.2\.2\/tower-of-lost-things-0\.2\.2-4\.apk/);
    assert.doesNotMatch(host.phone.calls(), /\binstall\b/);
    assert.equal(host.s3.requests.filter(request => request.key.endsWith('.apk')).length, 0);
    assert.deepEqual([host.s3.writer.writes.length, host.events.length], [0, 0]);

    host.phone.install(apkText());
    await androidPass(host.ctx);
    assert.match(host.lines(/^HUB_CATCHUP_WATCH /)[1], /would record installed by a person \(HUB_CATCHUP_CONFIRMED\)/);
    assert.deepEqual([host.s3.writer.writes.length, host.events.length], [0, 0]);

    writeMode('live', { env: host.env, home: host.root });
    assert.equal(readMode({ env: host.env, home: host.root }), 'live');
    assert.throws(() => writeMode('yolo', { env: host.env, home: host.root }), /watch or live/);
  } finally { host.cleanup(); }
});

// ---------------------------------------------------------------------------------------------------- the iPad pass

// The Mac: a fake iPad behind devicectl, the outbox the ios job fills, and record reached through the same argument
// round trip the ssh call makes.
function macHost({ mode = 'live', linux = linuxHost(), metered = true, tunnel = 'connected' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'hub-catchup-mac-'));
  const env = { PATH: process.env.PATH, HUB_LOCK_DIR: join(root, 'locks'), XDG_CONFIG_HOME: join(root, 'config'), XDG_STATE_HOME: join(root, 'state') };
  if (mode === 'live') writeMode('live', { env, home: root });
  const ipadState = { tunnel, installed: null, calls: [] };
  const ipad = {
    find: () => { ipadState.calls.push('list devices'); return { identifier: 'x', tunnel: ipadState.tunnel, transport: ipadState.tunnel === 'unavailable' ? null : 'localNetwork' }; },
    installed: bundle => { ipadState.calls.push(`info apps ${bundle}`); return ipadState.installed; },
    install: app => {
      ipadState.calls.push(`install ${app}`);
      const [, version, build] = readFileSync(app, 'utf8').split(' ');
      ipadState.installed = { version, build, developer: true };
    },
    running: () => { ipadState.calls.push('processes'); return ipadState.running === true; },
  };
  const unpack = ipa => {
    const [bundle, version, build] = readFileSync(ipa, 'utf8').split(' ');
    return { app: ipa, bundle, version, build, cleanup: () => {} };
  };
  const reports = [];
  const logs = [];
  const link = { metered };
  const ctx = macContext({
    env, home: root, log: line => logs.push(line), now, devices, fetchImpl: linux.s3.fetchImpl, settings: settingsFrom(policy),
    ipad, metered: () => link.metered, unpack, lockWaitMs: 300,
    report: async facts => {
      const args = recordArgs(facts);
      reports.push(args);
      await record(linux.ctx, parseRecordArgs(args));
    },
  });
  const outbox = (text, { version = '0.2.2', build = '4' } = {}) => {
    const dir = join(root, 'Library/Caches/mobile-deploy-hub/outbox', slug);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${version}-${build}.ipa`), text);
  };
  return { root, env, ctx, linux, ipadState, reports, logs, link, outbox, lines: pattern => logs.filter(line => pattern.test(line)), cleanup: () => { rmSync(root, { recursive: true, force: true }); linux.cleanup(); } };
}

test('iPad: unavailable is idle; an older build is installed from the outbox, read back and reported over the record arguments', async () => {
  const mac = macHost({ tunnel: 'unavailable' });
  try {
    publish(mac.linux.s3, { latest: latestDoc({ android: androidBlock({ status: 'installed', by: 'deploy' }), ios: iosBlock() }), ipa: ipaText() });
    mac.ipadState.installed = { version: '0.2.1', build: '4' };
    mac.outbox(ipaText());
    await iosPass(mac.ctx);
    assert.deepEqual(mac.ipadState.calls, ['list devices'], 'nothing asked of an unavailable iPad');
    assert.match(mac.lines(/HUB_CATCHUP_IDLE ios live/)[0], /0\.2\.2 \(4\) pending; the iPad is unavailable/);
    assert.equal(mac.reports.length, 0);

    mac.ipadState.tunnel = 'disconnected';
    await iosPass(mac.ctx);
    assert.ok(mac.ipadState.calls.some(call => call.startsWith('install ')), 'installed in place with devicectl');
    assert.deepEqual(mac.ipadState.installed, { version: '0.2.2', build: '4', developer: true });
    assert.equal(mac.lines(/^HUB_CATCHUP_INSTALLED tower-of-lost-things ios 0\.2\.2 \(4\): installed over 0\.2\.1 \(4\) from the outbox; readback 0\.2\.2 \(4\)/).length, 1);
    assert.deepEqual(mac.reports[0].slice(0, 12), ['--slug', slug, '--platform', 'ios', '--version', '0.2.2', '--build', '4', '--status', 'installed', '--by', 'catch-up']);
    assert.equal(mac.linux.s3.requests.filter(request => request.key.endsWith('.ipa')).length, 0, 'the outbox cost no network bytes');
    const device = latestOf(mac.linux.s3).ios.device;
    assert.deepEqual([device.status, device.by], ['installed', 'catch-up']);
    assert.equal(mac.linux.events.length, 1);
    assert.deepEqual([mac.linux.events[0].data.target.kind, mac.linux.events[0].data.target.id, mac.linux.events[0].data.deliveries[0].device], ['ios-device', '00008112-000138390CFB401E', 'iPad']);
  } finally { mac.cleanup(); }
});

test('iPad: an equal build is confirmed, a newer one is never touched, and a metered link waits for the outbox', async () => {
  const mac = macHost();
  try {
    publish(mac.linux.s3, { latest: latestDoc({ android: null, ios: iosBlock() }), ipa: ipaText() });
    mac.ipadState.installed = { version: '0.2.2', build: '4' };
    await iosPass(mac.ctx);
    assert.equal(mac.lines(/^HUB_CATCHUP_CONFIRMED tower-of-lost-things ios 0\.2\.2 \(4\): the iPad already runs 0\.2\.2 \(4\) \(installed over the air\)/).length, 1);
    assert.deepEqual([latestOf(mac.linux.s3).ios.device.status, latestOf(mac.linux.s3).ios.device.by], ['installed', 'manual']);
    assert.equal(mac.linux.events[0].data.deliveries[0].by, 'manual');
  } finally { mac.cleanup(); }

  const newer = macHost();
  try {
    publish(newer.linux.s3, { latest: latestDoc({ android: null, ios: iosBlock() }), ipa: ipaText() });
    newer.ipadState.installed = { version: '0.3.0', build: '1' };
    newer.outbox(ipaText());
    await iosPass(newer.ctx);
    assert.ok(!newer.ipadState.calls.some(call => call.startsWith('install ')));
    assert.equal(newer.lines(/^HUB_IPAD_NEWER tower-of-lost-things ios 0\.2\.2 \(4\): the iPad runs 0\.3\.0 \(1\); not touched/).length, 1);
    assert.equal(latestOf(newer.linux.s3).ios.device.status, 'skipped');
    assert.equal(newer.linux.events.length, 0);
  } finally { newer.cleanup(); }

  const away = macHost({ metered: true });
  try {
    publish(away.linux.s3, { latest: latestDoc({ android: null, ios: iosBlock() }), ipa: ipaText() });
    away.ipadState.installed = { version: '0.2.1', build: '4' };
    await iosPass(away.ctx);
    assert.equal(away.lines(/HUB_CATCHUP_IDLE .*the IPA is not in the outbox and the link is metered/).length, 1);
    assert.equal(away.linux.s3.requests.filter(request => request.key.endsWith('.ipa')).length, 0, 'no IPA over a metered link');
    assert.equal(latestOf(away.linux.s3).ios.device.failures, 0, 'waiting is not a failure');

    // At home (gateway in the LAN) the IPA comes from S3 into the catch-up's cache, never the deploy's outbox.
    away.link.metered = false;
    await iosPass(away.ctx);
    assert.equal(away.linux.s3.requests.filter(request => request.key.endsWith('.ipa')).length, 1);
    assert.ok(existsSync(join(away.root, `Library/Caches/mobile-deploy-hub/catchup/ipa/${slug}-0.2.2-4.ipa`)));
    assert.ok(!existsSync(join(away.root, 'Library/Caches/mobile-deploy-hub/outbox')));
    assert.deepEqual(away.ipadState.installed, { version: '0.2.2', build: '4', developer: true });
  } finally { away.cleanup(); }
});

test('iPad: other bytes in the outbox are never installed; watch mode installs nothing; latest.json is re-read with If-None-Match', async () => {
  const mac = macHost({ metered: true });
  try {
    publish(mac.linux.s3, { latest: latestDoc({ android: null, ios: iosBlock() }), ipa: ipaText() });
    mac.ipadState.installed = { version: '0.2.1', build: '4' };
    mac.outbox(ipaText({ salt: 'a rebuilt IPA' }));
    await iosPass(mac.ctx);
    assert.ok(!mac.ipadState.calls.some(call => call.startsWith('install ')));
    assert.equal(mac.lines(/the outbox IPA 0\.2\.2-4\.ipa is other bytes than latest\.json names; not using it/).length, 1);
    const reads = mac.linux.s3.requests.filter(request => request.key === `${slug}/latest.json`);
    assert.equal(reads.length, 1);
    await iosPass(mac.ctx);
    const again = mac.linux.s3.requests.filter(request => request.key === `${slug}/latest.json`);
    assert.ok(again[1].ifNoneMatch, 'the second read asks for a 304');
  } finally { mac.cleanup(); }

  const watch = macHost({ mode: 'watch' });
  try {
    publish(watch.linux.s3, { latest: latestDoc({ android: null, ios: iosBlock() }), ipa: ipaText() });
    watch.ipadState.installed = { version: '0.2.1', build: '4' };
    watch.outbox(ipaText());
    await iosPass(watch.ctx);
    assert.match(watch.lines(/^HUB_CATCHUP_WATCH /)[0], /would install: 0\.2\.2 \(4\) over 0\.2\.1 \(4\) from the outbox \(sha256 matches\)/);
    assert.ok(!watch.ipadState.calls.some(call => call.startsWith('install ')));
    assert.deepEqual([watch.reports.length, watch.linux.s3.writer.writes.length, watch.linux.events.length], [0, 0, 0]);
  } finally { watch.cleanup(); }
});

// ---------------------------------------------------------------------------------------------------- record, event, store

test('record arguments are patterns, not shell: the ssh command quotes each one and the far side refuses anything else', () => {
  const facts = { slug, platform: 'ios', version: '0.2.2', build: '4', status: 'failure', by: null, reason: "devicectl said 'no' at /Users/delorenj/x; $(rm -rf ~)", stage: 'install', sha256: sha('x'), commit, run: { id: runId, attempt: 2 } };
  const args = recordArgs(facts);
  assert.deepEqual(parseRecordArgs(args), { ...facts, reason: reasonText(facts.reason), run: { id: runId, attempt: 2 }, by: null });
  assert.doesNotMatch(reasonText(facts.reason), /['$/`]/, 'no quote, dollar, slash or backtick crosses');
  assert.match(reasonText(facts.reason), /<path>/, 'workstation paths are dropped');
  const command = sshRecordCommand(facts, 'big-chungus');
  assert.deepEqual(command.slice(0, 7), ['-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=20', '-o', 'ServerAliveInterval=15']);
  assert.equal(command[7], 'big-chungus');
  assert.match(command[8], /tools\/catchup\/catchup\.mjs" record '--slug' 'tower-of-lost-things' '--platform' 'ios' /);
  assert.throws(() => sshRecordCommand(facts, 'big-chungus; rm -rf ~'), /not a host name/);
  for (const bad of [{ slug: 'Tower;rm' }, { version: '0.2' }, { build: '4 4' }, { status: 'deleted' }, { sha256: 'abc' }]) assert.throws(() => recordArgs({ ...facts, ...bad }), /does not match its pattern/);
  assert.throws(() => parseRecordArgs(['--slug', slug, '--evil', 'x']), /unknown option/);
  assert.throws(() => parseRecordArgs(['--slug', slug, '--platform', 'ios', '--version', '0.2.2', '--build', '4', '--status', 'installed']), /needs --by/);
});

test('the catch-up events hold to the Bloodbank contract and carry this producer', async t => {
  const latest = latestDoc({ ios: iosBlock({ status: 'installed', by: 'manual' }) });
  const publicBase = 'https://s3.delo.sh/builds';
  const at = new Date('2026-10-10T12:00:00Z');
  const installed = catchupEvent({ name: latest.name, slug, platform: 'android', block: latest.android, device: { status: 'installed', by: 'catch-up' }, run: latest.run, commit, hubRef: 'v1.1.0', correlation: latest.correlation, devices, publicBase, now: at });
  const manual = catchupEvent({ name: latest.name, slug, platform: 'ios', block: latest.ios, device: latest.ios.device, run: latest.run, commit, hubRef: 'v1.1.0', correlation: latest.correlation, devices, publicBase, now: at });
  const failed = catchupEvent({ name: latest.name, slug, platform: 'android', block: latest.android, device: { status: 'failed', reason: 'catch-up failed 3 times at verify: readback: base.apk differs' }, run: latest.run, commit, hubRef: 'v1.1.0', correlation: null, devices, publicBase, now: at });
  assert.equal(failed.correlation, latest.correlation, 'derived from the run when latest.json has none');
  assert.deepEqual([failed.type, failed.data.stage, failed.data.deliveries[0].stage], ['bloodbank.project.deployment.failed', 'verify', 'verify']);
  assert.equal(manual.data.artifact.version_code, null);

  // Through the hub's bbEmit with a recording bb-emit: this producer, the original correlation, --strict.
  const root = mkdtempSync(join(tmpdir(), 'hub-catchup-emit-'));
  try {
    script(join(root, 'bb-emit'), `cat > "${root}/data.json"\necho "$*" > "${root}/args"`);
    sendCatchupEvent({ event: installed, env: { PATH: process.env.PATH, HUB_BB_EMIT: join(root, 'bb-emit') } });
    const args = readFileSync(join(root, 'args'), 'utf8').trim().split(' ');
    assert.equal(args[args.indexOf('--producer') + 1], producer);
    assert.equal(args[args.indexOf('--correlation') + 1], latest.correlation);
    assert.equal(args.at(-1), '--strict');
    assert.deepEqual(JSON.parse(readFileSync(join(root, 'data.json'), 'utf8')), installed.data);
  } finally { rmSync(root, { recursive: true, force: true }); }

  const realBbEmit = bbEmitPath({}, process.env.HOME);
  if (!existsSync(realBbEmit)) { t.skip('bb-emit is not installed on this host'); return; }
  for (const event of [installed, manual, failed]) {
    const result = spawnSync(realBbEmit, ['--type', event.type, '--source', 'urn:33god:service:mobile-deploy-hub', '--producer', producer, '--service', 'mobile-deploy-hub', '--correlation', event.correlation, '--check'], { input: JSON.stringify(event.data), encoding: 'utf8', timeout: 30_000 });
    assert.equal(result.status, 0, `${event.type}: ${result.stdout}${result.stderr}`);
  }
});

test('the store: a missing pointer is null, a download is kept only with the promised size and sha256', async () => {
  const s3 = fakeS3();
  const root = mkdtempSync(join(tmpdir(), 'hub-catchup-store-'));
  try {
    assert.equal(await readJson('http://127.0.0.1:9012/builds/gruvato/latest.json', { fetchImpl: s3.fetchImpl }), null);
    s3.put('gruvato/1.apk', 'abc');
    const dest = join(root, 'cache/1.apk');
    await assert.rejects(downloadVerified('http://127.0.0.1:9012/builds/gruvato/1.apk', dest, { bytes: 3, sha256: sha('abd'), fetchImpl: s3.fetchImpl }), /has sha256/);
    await assert.rejects(downloadVerified('http://127.0.0.1:9012/builds/gruvato/1.apk', dest, { bytes: 4, sha256: sha('abc'), fetchImpl: s3.fetchImpl }), /is 3 bytes, latest\.json says 4/);
    assert.deepEqual(readdirSync(join(root, 'cache')), [], 'no partial file is left');
    assert.deepEqual(await downloadVerified('http://127.0.0.1:9012/builds/gruvato/1.apk', dest, { bytes: 3, sha256: sha('abc'), fetchImpl: s3.fetchImpl }), { path: dest, downloaded: 3 });
    assert.deepEqual(await downloadVerified('http://127.0.0.1:9012/builds/gruvato/1.apk', dest, { bytes: 3, sha256: sha('abc'), fetchImpl: s3.fetchImpl }), { path: dest, downloaded: 0 }, 'a verified copy is reused');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('the builds writer: the token goes only to op, the MinIO keys only into the mc child, and only a valid latest.json is written', async () => {
  const home = mkdtempSync(join(tmpdir(), 'hub-catchup-writer-'));
  try {
    mkdirSync(join(home, '.config/op'), { recursive: true });
    writeFileSync(join(home, '.config/op/service-account-token'), 'ops_test-token\n');
    assert.equal(serviceAccountEnv({ PATH: '/usr/bin' }, home).OP_SERVICE_ACCOUNT_TOKEN, 'ops_test-token');
    assert.equal(serviceAccountEnv({ OP_SERVICE_ACCOUNT_TOKEN: 'mine' }, home).OP_SERVICE_ACCOUNT_TOKEN, 'mine', 'an existing token is kept');
    const reads = [];
    const read = async (ref, { env }) => { reads.push({ ref, token: env.OP_SERVICE_ACCOUNT_TOKEN }); return ref.endsWith('/username') ? 'mobile-deploy-hub' : 's3cr3t+/=long'; };
    const calls = [];
    const runner = (program, args, options) => { calls.push({ program, args, env: options.env, body: readFileSync(args.at(-2), 'utf8') }); return { ok: true, status: 0, stdout: '', stderr: '' }; };
    const writer = hubWriter({ settings: settingsFrom(policy), env: { PATH: '/usr/bin', GH_TOKEN: 'x', MC_HOST_other: 'y' }, home, read, runner });
    const doc = latestDoc();
    await writer.putJson(`${slug}/latest.json`, doc);
    assert.deepEqual(reads.map(entry => entry.token), ['ops_test-token', 'ops_test-token'], 'op reads with the service account');
    assert.match(reads[0].ref, /^op:\/\/DeLoSecrets\/[a-z0-9]{26}\/username$/, 'the writer item, by UUID');
    const [call] = calls;
    assert.equal(call.program, 'mc');
    assert.ok(!call.args.join(' ').includes('s3cr3t'), 'no key in argv');
    assert.equal(call.args.at(-1), `builds/builds/${slug}/latest.json`);
    assert.ok(call.args.includes('Content-Type="application/json";Cache-Control="no-cache"'));
    assert.equal(call.env.MC_HOST_builds, 'http://mobile-deploy-hub:s3cr3t%2B%2F%3Dlong@127.0.0.1:9012');
    assert.deepEqual([call.env.OP_SERVICE_ACCOUNT_TOKEN, call.env.GH_TOKEN, call.env.MC_HOST_other], [undefined, undefined, undefined], 'mc gets no token and no other alias');
    assert.deepEqual(JSON.parse(call.body), doc);
    await assert.rejects(writer.putJson(`${slug}/latest.json`, { ...doc, android: { ...doc.android, device: { ...doc.android.device, status: 'maybe' } } }), /status must be one of/);
    assert.equal(calls.length, 1, 'an invalid latest.json never reaches mc');
  } finally { rmSync(home, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------------------------------- guards and units

test('the catch-up never removes an app, clears its data or downgrades: its only installs are adb install -r and devicectl', () => {
  const forbidden = [/\buninstall\b/i, /\bpm\b["'\s,]+clear\b/, /["']install["'](?:\s*,\s*["']-[a-z]+["'])*\s*,\s*["']-[a-z]*d[a-z]*["']/, /\binstall(?:\s+-[a-z]+)*\s+-[a-z]*d\b/, /--downgrade|install-multiple/];
  const files = [];
  const walk = dir => { for (const entry of readdirSync(dir, { withFileTypes: true })) { const path = join(dir, entry.name); if (entry.isDirectory()) walk(path); else if (!entry.name.endsWith('.test.mjs')) files.push(path); } };
  walk(join(hubRoot, 'tools/catchup'));
  assert.ok(files.length >= 7);
  const hits = files.flatMap(file => readFileSync(file, 'utf8').split('\n').flatMap((line, index) => forbidden.filter(pattern => pattern.test(line)).map(() => `${relative(hubRoot, file)}:${index + 1}`)));
  assert.deepEqual(hits, []);
  const source = readFileSync(join(hubRoot, 'tools/catchup/catchup.mjs'), 'utf8');
  assert.deepEqual(source.match(/\.install\([^)]*\)/g), ['.install(id, apk)', '.install(unpacked.app)'], 'the frozen hub calls: adb install -r and devicectl device install app');
});

test('record writes through the hub\'s builds writer and re-renders the app page and the index with its publishPages', async () => {
  const s3 = fakeS3();
  const mcCalls = [];
  // mc as the hub's createS3 drives it: cp <file> builds/builds/<key>, ls --json --recursive builds/builds/<prefix>, rm.
  const mc = (program, args) => {
    const [command, ...rest] = args.filter(arg => !['--quiet', '--no-color', '--disable-pager'].includes(arg));
    mcCalls.push(`${command} ${rest.at(-1)}`);
    const key = rest.at(-1).replace(/^builds\/builds\//, '');
    if (command === 'cp') s3.put(key, readFileSync(rest.at(-2), 'utf8'));
    if (command === 'ls') return { ok: true, status: 0, stdout: [...s3.objects.keys()].filter(name => name.startsWith(key)).map(name => JSON.stringify({ status: 'success', type: 'file', key: name.slice(key.length), size: s3.objects.get(name).body.length })).join('\n'), stderr: '' };
    return { ok: true, status: 0, stdout: '', stderr: '' };
  };
  const read = async ref => (ref.endsWith('/username') ? 'mobile-deploy-hub' : 'a-long-writer-secret');
  const host = linuxHost({ s3, writer: ({ env, home }) => hubWriter({ settings: settingsFrom(policy), env, home, read, runner: mc }), pages: null });
  try {
    publish(host.s3, { latest: latestDoc(), apk: apkText() });
    host.phone.install(apkText({ version: '0.2.1', code: 3 }));
    await androidPass(host.ctx);
    assert.equal(latestOf(s3).android.device.status, 'installed');
    assert.ok(mcCalls.includes(`cp builds/builds/${slug}/latest.json`), 'latest.json through mc cp');
    assert.ok(mcCalls.includes(`cp builds/builds/${slug}/index.html`) && mcCalls.includes('cp builds/builds/index.json') && mcCalls.includes('cp builds/builds/index.html'), mcCalls.join(', '));
    assert.equal(s3.json('index.json').apps[0].android.device, 'installed', 'the index shows the catch-up');
    assert.match(s3.objects.get(`${slug}/index.html`).body, /installed/);
    assert.equal(host.lines(/^HUB_CATCHUP_PAGES tower-of-lost-things: app page and index re-rendered$/).length, 1);
    assert.equal(host.events.length, 1);
  } finally { host.cleanup(); }
});

test('the CLI runs through the `current` symlink the units start it by, and mode defaults to watch', () => {
  const root = mkdtempSync(join(tmpdir(), 'hub-catchup-cli-'));
  try {
    symlinkSync(join(hubRoot, 'tools'), join(root, 'tools'));
    const env = { PATH: process.env.PATH, HOME: root, XDG_CONFIG_HOME: join(root, 'config') };
    const cli = join(root, 'tools/catchup/catchup.mjs');
    const shown = spawnSync(process.execPath, [cli, 'mode'], { env, encoding: 'utf8' });
    assert.equal(shown.status, 0, shown.stderr);
    assert.match(shown.stdout, /^catch-up mode on this host: watch /);
    const live = spawnSync(process.execPath, [cli, 'mode', 'live'], { env, encoding: 'utf8' });
    assert.match(live.stdout, /mode on this host: live/);
    assert.equal(JSON.parse(readFileSync(join(root, 'config/mobile-deploy-hub/catchup.json'), 'utf8')).mode, 'live');
    const bad = spawnSync(process.execPath, [cli, 'bogus'], { env, encoding: 'utf8' });
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /^HUB_CATCHUP_ERROR usage: catchup\.mjs android \| ios/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('units: the S26 pass every 2 minutes under systemd, the iPad pass every 5 in the GUI session; install.sh never goes live', () => {
  const unit = name => readFileSync(join(hubRoot, 'tools/catchup/units', name), 'utf8');
  const service = unit('mobile-deploy-hub-catchup.service');
  assert.match(service, /^Type=oneshot$/m);
  assert.match(service, /^Environment=HOME=%h$/m);
  assert.match(service, /^ExecStart=%h\/\.local\/share\/mise\/installs\/node\/24\/bin\/node %h\/\.local\/share\/mobile-deploy-hub\/current\/tools\/catchup\/catchup\.mjs android$/m);
  assert.match(service, /^KillMode=process$/m, 'an adb server the pass starts survives it');
  const timer = unit('mobile-deploy-hub-catchup.timer');
  assert.match(timer, /^OnCalendar=\*:0\/2$/m);
  assert.match(timer, /^Persistent=true$/m);
  assert.match(timer, /^WantedBy=timers\.target$/m);
  const plist = unit('sh.delo.mobile-deploy-hub.catchup.plist');
  assert.match(plist, /<key>Label<\/key>\s*<string>sh\.delo\.mobile-deploy-hub\.catchup<\/string>/);
  assert.match(plist, /<key>StartInterval<\/key>\s*<integer>300<\/integer>/);
  assert.match(plist, /<string>@HOME@\/\.local\/share\/mobile-deploy-hub\/current\/tools\/catchup\/catchup\.mjs<\/string>\s*<string>ios<\/string>/);
  assert.match(plist, /<key>LimitLoadToSessionType<\/key>\s*<string>Aqua<\/string>/);
  assert.match(plist, /@HOME@\/Library\/Logs\/mobile-deploy-hub\/catchup\.log/);
  const install = unit('install.sh');
  assert.match(install, /launchctl bootstrap "\$domain" "\$plist"/);
  assert.match(install, /domain="gui\/\$\(id -u\)"/);
  assert.match(install, /systemctl --user enable --now mobile-deploy-hub-catchup\.timer/);
  assert.match(install, /if \[\[ ! -f \$config \]\]; then[\s\S]*"mode":"watch"/, 'a new host watches');
  assert.doesNotMatch(install, /"mode":"live"|mode live"/, 'going live is never the installer\'s call');
  if (spawnSync('plutil', ['-help']).status === 0 || existsSync('/usr/bin/plutil')) assert.equal(spawnSync('plutil', ['-lint', join(hubRoot, 'tools/catchup/units/sh.delo.mobile-deploy-hub.catchup.plist')]).status, 0);
  if (existsSync('/usr/bin/systemd-analyze')) {
    const result = spawnSync('systemd-analyze', ['--user', 'verify', join(hubRoot, 'tools/catchup/units/mobile-deploy-hub-catchup.timer')], { encoding: 'utf8' });
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, /mobile-deploy-hub-catchup\.(timer|service):\d+:/, 'systemd accepts the units');
  }
});

// ---------------------------------------------------------------------------------------------------- v1.1.3

test('pins: a latest.json whose package, signer or bundle is not the policy\'s is refused before anything is fetched', async () => {
  const host = linuxHost();
  try {
    const foreign = androidBlock();
    foreign.signer_sha256 = 'f'.repeat(64);
    publish(host.s3, { latest: latestDoc({ android: foreign }), apk: apkText({ signerSha: 'f'.repeat(64) }) });
    host.phone.install(apkText({ version: '0.2.1', code: 3 }));
    await androidPass(host.ctx);
    assert.equal(host.lines(/^HUB_CATCHUP_ERROR tower-of-lost-things: latest\.json refused \(android\.signer_sha256 is not the policy's signer\)/).length, 1, host.logs.join('\n'));
    assert.doesNotMatch(host.phone.calls(), /\binstall\b/);
    assert.equal(host.s3.requests.filter(request => request.key.endsWith('.apk')).length, 0, 'nothing fetched');
    const app = settingsFrom(policy).apps.find(entry => entry.slug === slug);
    const ios = iosBlock();
    ios.bundle = 'io.example.other';
    assert.match(latestProblems(latestDoc({ android: null, ios }), slug, 'https://s3.delo.sh/builds', app).join(' '), /ios\.bundle io\.example\.other is not the policy's/);
    assert.deepEqual(latestProblems(latestDoc(), slug, 'https://s3.delo.sh/builds', app), []);
  } finally { host.cleanup(); }
});

test('the S26 is not updated under a kid: the app on top with the screen on waits; with the screen off it installs', async () => {
  const host = linuxHost();
  try {
    publish(host.s3, { latest: latestDoc(), apk: apkText() });
    host.phone.install(apkText({ version: '0.2.1', code: 3 }));
    host.phone.playing(pkg);
    await androidPass(host.ctx);
    assert.equal(host.lines(/^HUB_CATCHUP_IDLE tower-of-lost-things android 0\.2\.2 \(4\): io\.automaticai\.towerofdumbthings is on screen on the S26/).length, 1, host.logs.join('\n'));
    assert.doesNotMatch(host.phone.calls(), /\binstall\b/);
    assert.deepEqual([host.events.length, host.s3.writer.writes.length], [0, 0], 'waiting is not a failed attempt');
    host.phone.asleep(true);
    await androidPass(host.ctx);
    assert.match(host.phone.installed(), /^io\.automaticai\.towerofdumbthings 0\.2\.2 4 /);
  } finally { host.cleanup(); }
});

test('iPad: while the app runs the install waits, up to 45 minutes from the first sighting, then goes ahead', async () => {
  const mac = macHost();
  try {
    publish(mac.linux.s3, { latest: latestDoc({ android: null, ios: iosBlock() }), ipa: ipaText() });
    mac.ipadState.installed = { version: '0.2.1', build: '4' };
    mac.outbox(ipaText());
    mac.ipadState.running = true;
    await iosPass(mac.ctx);
    assert.ok(!mac.ipadState.calls.some(call => call.startsWith('install ')), 'not under a kid');
    assert.match(mac.lines(/^HUB_CATCHUP_IDLE tower-of-lost-things ios/)[0], /is running on the iPad; the install waits .* \(0 of 45 minutes\)/);
    // An app that stays suspended in the background must not hold the iPad forever.
    const journal = join(mac.env.XDG_STATE_HOME, 'mobile-deploy-hub/catchup-journal.json');
    const document = JSON.parse(readFileSync(journal, 'utf8'));
    document.busy[`${slug}/ios`].since = '2026-10-10T11:00:00Z';
    writeFileSync(journal, JSON.stringify(document));
    await iosPass(mac.ctx);
    assert.ok(mac.ipadState.calls.some(call => call.startsWith('install ')));
    assert.equal(mac.lines(/^HUB_CATCHUP_BUSY tower-of-lost-things ios: .* running for 60 minutes; installing now/).length, 1);
  } finally { mac.cleanup(); }
});

test('iPad: a deploy in flight holds the older pending build too (both passes read inflight.json)', async () => {
  const mac = macHost();
  try {
    publish(mac.linux.s3, { latest: latestDoc({ android: null, ios: iosBlock() }), ipa: ipaText() });
    mac.ipadState.installed = { version: '0.2.1', build: '4' };
    mac.outbox(ipaText());
    mac.linux.s3.put(`${slug}/inflight.json`, { version: '0.2.3', run: { id: '37950000000' }, started_at: '2026-10-10T11:50:00Z', platforms: ['android', 'ios'] });
    await iosPass(mac.ctx);
    assert.deepEqual(mac.ipadState.calls, [], 'not even devicectl: the deploy owns the iPad');
    assert.equal(mac.lines(/^HUB_CATCHUP_IDLE tower-of-lost-things ios 0\.2\.2 \(4\): deploy run 37950000000 is publishing 0\.2\.3/).length, 1);
  } finally { mac.cleanup(); }
});

test('the Mac revalidates its pointers with the strong tag, uncompressed, and reads over ssh when https fails', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hub-catchup-etag-'));
  try {
    const seen = [];
    const fetchImpl = async (url, options) => {
      seen.push(options.headers);
      if (options.headers['if-none-match'] === '"abc"') return new Response(null, { status: 304 });
      return new Response('{"a":1}', { status: 200, headers: { etag: 'W/"abc"' } });
    };
    const cacheFile = join(dir, 'x.json');
    assert.deepEqual((await readJson('https://s3.delo.sh/builds/x/latest.json', { fetchImpl, cacheFile })).value, { a: 1 });
    const again = await readJson('https://s3.delo.sh/builds/x/latest.json', { fetchImpl, cacheFile });
    assert.equal(again.cached, true, 'a 304: headers only');
    assert.deepEqual(seen[1], { 'accept-encoding': 'identity', 'if-none-match': '"abc"' }, 'never the weak W/ tag MinIO cannot match');
    assert.equal(seen[0]['accept-encoding'], 'identity');
  } finally { rmSync(dir, { recursive: true, force: true }); }

  const reads = [];
  const store = withFallback({ latest: async () => { throw new Error('GET https://s3.delo.sh/builds/x/latest.json: HTTP 522'); }, inflight: async () => null }, { read: key => { reads.push(key); return { ok: true }; }, log: () => {}, host: 'big-chungus' });
  assert.deepEqual(await store.latest('tower-of-lost-things'), { ok: true });
  assert.deepEqual(reads, ['tower-of-lost-things/latest.json']);
  assert.equal(await store.inflight('tower-of-lost-things'), null, 'a missing object is not a failure: no fallback');
});
