// Shared test fixtures (not a test file: node --test runs only *.test.mjs).
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
const jobVariable = name => /^(GITHUB_|RUNNER_|ACTIONS_|HUB_)/.test(name) || name === 'CI' || name === 'GH_TOKEN';
export function hermetic() {
  for (const name of Object.keys(process.env)) if (jobVariable(name)) delete process.env[name];
  globalThis.fetch = async input => { throw new Error(`a test reached the network (${typeof input === 'string' ? input : input?.url ?? String(input)}); inject fetchImpl instead`); };
}

export function sampleLatest(overrides = {}) {
  const slug = 'tower-of-lost-things';
  const android = {
    package: 'io.automaticai.towerofdumbthings', version: '0.2.2', code: 4,
    key: apkKey(slug, '0.2.2', 4), url: publicUrl(base, apkKey(slug, '0.2.2', 4)), bytes: 72_300_000, sha256: 'a'.repeat(64), signer_sha256: 'c'.repeat(64),
    quickdrop: 'builds/tower-of-lost-things-0.2.2-4.apk', device: device('S26', 'SM-S948U', 'pending'), run, correlation, commit: 'b'.repeat(40),
  };
  const manifestUrl = `${base}/${slug}/ios/manifest.plist`;
  const ios = {
    bundle: 'io.automaticai.towerofdumbthings', version: '0.2.2', build: '4',
    key: ipaKey(slug, '0.2.2', '4'), url: publicUrl(base, ipaKey(slug, '0.2.2', '4')), bytes: 27_300_000, sha256: 'd'.repeat(64),
    manifest_url: manifestUrl, install_url: installUrl(manifestUrl), device: device('iPad', 'iPad14,5', 'installed'), run, correlation, commit: 'b'.repeat(40),
  };
  return { schema: 1, slug, name: 'Tower of Lost Things', version: '0.2.2', commit: 'b'.repeat(40), hub_ref: 'v1.1.0', run, correlation, updated_at: '2026-10-09T20:00:00Z', android, ios, mac_bytes: 31_000_000, ...overrides };
}

