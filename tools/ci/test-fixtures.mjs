// Shared test fixtures (not a test file: node --test runs only *.test.mjs).
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { apkKey, installUrl, ipaKey, publicUrl } from './lib/latest.mjs';

export const base = 'https://s3.delo.sh/builds';
export const run = { repo: 'delorenj/tower-of-lost-things', id: '37940000000', attempt: 1, url: 'https://github.com/delorenj/tower-of-lost-things/actions/runs/37940000000' };
export const correlation = '6f1c2b44-0d1e-5a7b-9c3d-2e4f5a6b7c8d';
export const device = (name, model, status, extra = {}) => ({ name, model, status, since: '2026-10-09T20:00:00Z', by: status === 'installed' ? 'deploy' : null, reason: status === 'pending' ? "not on big-chungus's adb" : null, failures: 0, ...extra });

// A lane test runs the way a person at a shell does: offline, and outside any workflow job.
//
// Offline: the build directory, GitHub's API and Play are reached only through the fetchImpl a test injects. Without
// this, a lane that forgot its seam read the live bucket over 127.0.0.1:9012 and the test's verdict was the bucket's:
// 404 (passes) while the bucket was anonymous, 403 once MOBI-17 made release-notes.json private (four tests red on
// big-chungus), ECONNREFUSED on a hosted runner. Now the same miss is red on every host, naming the URL. A lane's
// `fetchImpl = fetch` default is looked up per call, so it sees the replacement.
//
// Outside a job: the runner's own GITHUB_ACTIONS, GITHUB_WORKFLOW_REF, GITHUB_STEP_SUMMARY... (and a shell's exported
// HUB_S3_LOCAL or HUB_ADB) are dropped from process.env, so a fixture that spreads process.env is the same on a GitHub
// runner as at a shell: the plan does not refuse the test as a foreign caller (the runner's check.yml), readObject does
// not ask 1Password for the writer's keys, and receipts do not land in the check job's summary. A test that wants job
// context sets it on the env it passes, as before. Call once at the top of a test file.
//
// The Event Log: lock transitions on Queued names append to HUB_EVENT_DIR, which defaults to the real
// ~/.local/state. hermetic() points it at a per-process temp dir, so a test that spreads process.env (or a child that
// inherits it) never writes host history. A test that builds its env from scratch still passes its own HUB_EVENT_DIR.
const jobVariable = name => /^(GITHUB_|RUNNER_|ACTIONS_|HUB_)/.test(name) || name === 'CI' || name === 'GH_TOKEN';
//
// The QA file is scratched too (HUB_QA_DEVICES, an empty qa-devices.json).
//
// The lock directory is scratched the same way: a gate or preflight-ios under test reserves a device (Story 2.5), and a lane
// that forgot its own HUB_LOCK_DIR must never write ~/.cache/mobile-deploy-hub/locks.
//
// `heavy`: the emulator spawn seam wraps every emulator and adb server it launches in `heavy` when `heavy` is on PATH (Linux). A
// test must never open a real systemd scope, so hermetic() puts a fake first on PATH (see heavyShim). A fixture that builds its
// own env from scratch puts a heavyShim on its own PATH, or has no heavy and spawns the command unchanged.
let eventScratch = null;
let heavyScratch = null;
let lockScratch = null;
let qaScratch = null;
// A fake `heavy` in `dir`: it appends its arguments to `<dir>/heavy.log` and execs them, which is all the real one does to the pid
// (systemd-run --scope execs the command). Returns `dir`, ready to go on the front of a PATH.
export function heavyShim(dir) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'heavy'), `#!/bin/sh\necho "$*" >> "${join(dir, 'heavy.log')}"\nexec "$@"\n`);
  chmodSync(join(dir, 'heavy'), 0o755);
  return dir;
}

export function hermetic() {
  for (const name of Object.keys(process.env)) if (jobVariable(name)) delete process.env[name];
  if (!eventScratch) {
    eventScratch = mkdtempSync(join(tmpdir(), 'hub-test-events-'));
    process.on('exit', () => { try { rmSync(eventScratch, { recursive: true, force: true }); } catch { /* temp */ } });
  }
  process.env.HUB_EVENT_DIR = eventScratch;
  if (!heavyScratch) {
    heavyScratch = mkdtempSync(join(tmpdir(), 'hub-test-heavy-'));
    heavyShim(heavyScratch);
    process.on('exit', () => { try { rmSync(heavyScratch, { recursive: true, force: true }); } catch { /* temp */ } });
    process.env.PATH = `${heavyScratch}:${process.env.PATH ?? ''}`;
  }
  if (!lockScratch) {
    lockScratch = mkdtempSync(join(tmpdir(), 'hub-test-locks-'));
    process.on('exit', () => { try { rmSync(lockScratch, { recursive: true, force: true }); } catch { /* temp */ } });
  }
  process.env.HUB_LOCK_DIR = lockScratch;
  // The Registry seed reads the private QA file only through its loader; point it at an empty one so a test never opens the real path.
  if (!qaScratch) {
    qaScratch = mkdtempSync(join(tmpdir(), 'hub-test-qa-'));
    writeFileSync(join(qaScratch, 'qa-devices.json'), '{"schema":1,"devices":[]}\n');
    process.on('exit', () => { try { rmSync(qaScratch, { recursive: true, force: true }); } catch { /* temp */ } });
  }
  process.env.HUB_QA_DEVICES = join(qaScratch, 'qa-devices.json');
  globalThis.fetch = async input => { throw new Error(`a test reached the network (${typeof input === 'string' ? input : input?.url ?? String(input)}); inject fetchImpl instead`); };
}

export function sampleLatest(overrides = {}) {
  const slug = 'tower-of-lost-things';
  const android = {
    package: 'io.lasertoast.tolt', version: '0.2.2', code: 4,
    key: apkKey(slug, '0.2.2', 4), url: publicUrl(base, apkKey(slug, '0.2.2', 4)), bytes: 72_300_000, sha256: 'a'.repeat(64), signer_sha256: 'c'.repeat(64),
    quickdrop: 'builds/tower-of-lost-things-0.2.2-4.apk', device: device('S26', 'SM-S948U', 'pending'), run, correlation, commit: 'b'.repeat(40),
  };
  const manifestUrl = `${base}/${slug}/ios/manifest.plist`;
  const ios = {
    bundle: 'io.lasertoast.tolt', version: '0.2.2', build: '4',
    key: ipaKey(slug, '0.2.2', '4'), url: publicUrl(base, ipaKey(slug, '0.2.2', '4')), bytes: 27_300_000, sha256: 'd'.repeat(64),
    manifest_url: manifestUrl, install_url: installUrl(manifestUrl), device: device('iPad', 'iPad14,5', 'installed'), run, correlation, commit: 'b'.repeat(40),
  };
  return { schema: 1, slug, name: 'Tower of Lost Things', version: '0.2.2', commit: 'b'.repeat(40), hub_ref: 'v1.1.0', run, correlation, updated_at: '2026-10-09T20:00:00Z', android, ios, mac_bytes: 31_000_000, ...overrides };
}


// ---------------------------------------------------------------------------------------------------- app bundles (MOBI-18)
// A minimal Android App Bundle for the Play-bundle checks: a zip whose base/manifest/AndroidManifest.xml is aapt2's proto
// XmlNode, exactly the shape lib/aab.mjs reads from a real bundle. Unsigned; a test that needs a real signature runs
// jarsigner over it. `compress` deflates the manifest member (real bundles do); `code` as `number` writes the attribute
// as a compiled int, as aapt2 does for numeric attributes, and as a string otherwise.
const varint = number => {
  const bytes = [];
  let rest = BigInt(number);
  do { const low = Number(rest & 0x7fn); rest >>= 7n; bytes.push(rest > 0n ? low | 0x80 : low); } while (rest > 0n);
  return Buffer.from(bytes);
};
const field = (number, payload) => Buffer.concat([varint((number << 3) | 2), varint(payload.length), payload]);
const text = value => Buffer.from(value, 'utf8');

export function protoManifest({ package: pkg, versionCode, versionName = '1.0.0', asNumber = false, root = 'manifest' }) {
  const attribute = (namespace, name, value, compiled) => Buffer.concat([field(1, text(namespace)), field(2, text(name)), ...(value === undefined ? [] : [field(3, text(value))]), ...(compiled === undefined ? [] : [field(6, field(7, Buffer.concat([varint(6 << 3), varint(compiled)])))])]);
  const android = 'http://schemas.android.com/apk/res/android';
  const attributes = [
    attribute('', 'package', pkg),
    asNumber ? attribute(android, 'versionCode', undefined, versionCode) : attribute(android, 'versionCode', String(versionCode)),
    attribute(android, 'versionName', versionName),
  ];
  const element = Buffer.concat([field(3, text(root)), ...attributes.map(item => field(4, item))]);
  return field(1, element);
}

const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = buffer => { let c = 0xffffffff; for (const byte of buffer) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };

export function zipOf(entries) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const { name, data, deflate = false } of entries) {
    const raw = Buffer.from(data);
    const body = deflate ? deflateRawSync(raw) : raw;
    const nameBytes = text(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(deflate ? 8 : 0, 8);
    local.writeUInt32LE(crc32(raw), 14); local.writeUInt32LE(body.length, 18); local.writeUInt32LE(raw.length, 22); local.writeUInt16LE(nameBytes.length, 26);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0); entry.writeUInt16LE(20, 4); entry.writeUInt16LE(20, 6); entry.writeUInt16LE(deflate ? 8 : 0, 10);
    entry.writeUInt32LE(crc32(raw), 16); entry.writeUInt32LE(body.length, 20); entry.writeUInt32LE(raw.length, 24); entry.writeUInt16LE(nameBytes.length, 28); entry.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, body);
    central.push(entry, nameBytes);
    offset += 30 + nameBytes.length + body.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

export const makeBundle = (manifest, extra = []) => zipOf([
  { name: 'BundleConfig.pb', data: 'config' },
  { name: 'base/manifest/AndroidManifest.xml', data: protoManifest(manifest), deflate: true },
  { name: 'base/dex/classes.dex', data: 'dex' },
  ...extra,
]);
