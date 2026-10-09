// Shared test fixtures (not a test file: node --test runs only *.test.mjs).
import { apkKey, installUrl, ipaKey, publicUrl } from './lib/latest.mjs';

export const base = 'https://s3.delo.sh/builds';
export const run = { repo: 'delorenj/pile-of-dumb-things', id: '37940000000', attempt: 1, url: 'https://github.com/delorenj/pile-of-dumb-things/actions/runs/37940000000' };
export const correlation = '6f1c2b44-0d1e-5a7b-9c3d-2e4f5a6b7c8d';
export const device = (name, model, status, extra = {}) => ({ name, model, status, since: '2026-10-09T20:00:00Z', by: status === 'installed' ? 'deploy' : null, reason: status === 'pending' ? "not on big-chungus's adb" : null, failures: 0, ...extra });

export function sampleLatest(overrides = {}) {
  const slug = 'tower-of-dumb-things';
  const android = {
    package: 'io.automaticai.towerofdumbthings', version: '0.2.2', code: 4,
    key: apkKey(slug, '0.2.2', 4), url: publicUrl(base, apkKey(slug, '0.2.2', 4)), bytes: 72_300_000, sha256: 'a'.repeat(64), signer_sha256: 'c'.repeat(64),
    quickdrop: 'builds/tower-of-dumb-things-0.2.2-4.apk', device: device('S26', 'SM-S948U', 'pending'), run, correlation, commit: 'b'.repeat(40),
  };
  const manifestUrl = `${base}/${slug}/ios/manifest.plist`;
  const ios = {
    bundle: 'io.automaticai.towerofdumbthings', version: '0.2.2', build: '4',
    key: ipaKey(slug, '0.2.2', '4'), url: publicUrl(base, ipaKey(slug, '0.2.2', '4')), bytes: 27_300_000, sha256: 'd'.repeat(64),
    manifest_url: manifestUrl, install_url: installUrl(manifestUrl), device: device('iPad', 'iPad14,5', 'installed'), run, correlation, commit: 'b'.repeat(40),
  };
  return { schema: 1, slug, name: 'Tower of Lost Things', version: '0.2.2', commit: 'b'.repeat(40), hub_ref: 'v1.1.0', run, correlation, updated_at: '2026-10-09T20:00:00Z', android, ios, mac_bytes: 31_000_000, ...overrides };
}

