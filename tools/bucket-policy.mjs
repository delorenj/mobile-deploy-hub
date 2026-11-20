#!/usr/bin/env node
// mise run bucket-policy / bucket-policy:apply (MOBI-17, docs/private-device-builds.md): the MinIO bucket policy of the
// `builds` bucket is generated from tools/ci/policy.json (lib/access.mjs), committed as tools/ci/bucket-policy.json, and
// applied from here. Nothing else in the hub grants an anonymous read, so this is the one place access is enforced.
//
//   node tools/bucket-policy.mjs check [--offline]   the committed file equals the rendered one, and (unless --offline) the
//                                                    live bucket answers every anonymous probe as the policy says: no
//                                                    listing, no private device APK, receipt, notes or page, and every
//                                                    public object still open. Needs no credential. Exit 1 on drift.
//   node tools/bucket-policy.mjs write               re-render tools/ci/bucket-policy.json after a policy.json change
//   node tools/bucket-policy.mjs diff                the live policy against the committed one (admin keys)
//   node tools/bucket-policy.mjs apply [--dry-run]   set the live policy from the committed file (idempotent), then check
//
// The admin keys come from 1Password at call time (the refs below) into the mc child's MC_HOST_builds only, over the
// loopback port, like the writer's. apply replaces the bucket's anonymous policy as one document; running it twice
// changes nothing the second time.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { accessOf, anonymousListing, renderBucketPolicy } from './ci/lib/access.mjs';
import { attempt } from './ci/lib/exec.mjs';
import { loadPolicy } from './ci/lib/policy.mjs';
import { alias, mcEnvironment, readSecret } from './ci/lib/s3.mjs';

const hubRoot = fileURLToPath(new URL('..', import.meta.url));
export const committedFile = resolve(hubRoot, 'tools/ci/bucket-policy.json');
export const adminItem = 'op://DeLoSecrets/hwatizsoschtnq5oleume6kdpu';
export const adminRefs = Object.freeze({ access: `${adminItem}/username`, secret: `${adminItem}/password` });

// ------------------------------------------------------------------------------------------------------ the document

// The statements as a set, order and Sid ignored, so a live document MinIO re-serialised compares equal to ours.
export function normalize(doc) {
  const list = value => [].concat(value ?? []).map(String).sort();
  const principals = principal => (principal === '*' ? ['*'] : list(principal?.AWS));
  return (doc?.Statement ?? []).map(item => JSON.stringify({ effect: item.Effect, principal: principals(item.Principal), actions: list(item.Action), resources: list(item.Resource) })).sort();
}

export function documentDiff(want, have) {
  const wanted = normalize(want);
  const had = normalize(have);
  return { missing: wanted.filter(item => !had.includes(item)), extra: had.filter(item => !wanted.includes(item)) };
}

export function fileProblem(policy, text) {
  const rendered = renderBucketPolicy(policy);
  if (text === rendered) return null;
  return 'tools/ci/bucket-policy.json is not what tools/ci/policy.json renders (run: node tools/bucket-policy.mjs write, and commit it)';
}

// ------------------------------------------------------------------------------------------------------ the probes

// What an anonymous reader must get for keys that do not exist (so a probe never touches a real object): 403 where the
// policy denies, 404 (the key is missing, not forbidden) where it allows. Only a key that exists answers 200.
export function probePlan(policy) {
  const { public: base } = policy.delivery.s3;
  const allowed = open => (open ? [404, 200] : [403]);
  const plan = [
    { url: `${base}/?list-type=2`, expect: [403], why: 'no anonymous listing' },
    { url: `${base}/index.html`, expect: [404, 200], why: 'the root index is public' },
    { url: `${base}/index.json`, expect: [404, 200], why: 'the root index is public' },
  ];
  for (const app of Object.values(policy.apps)) {
    const access = accessOf(app);
    const { slug } = access;
    const object = (key, open, why) => plan.push({ url: `${base}/${key}`, expect: allowed(open), why: `${slug}: ${why}` });
    object(`${slug}/0.0.0/${slug}-0.0.0-0.apk`, access.devicePublic, access.devicePublic ? 'its device APK is public (android.public)' : 'its device APK is private');
    object(`${slug}/0.0.0/${slug}-0.0.0-0.apk.sha256`, access.devicePublic, 'device APK checksum');
    object(`${slug}/0.0.0/receipt.json`, access.devicePublic, 'device receipt');
    object(`${slug}/0.0.0/release-notes.json`, access.devicePublic, 'release notes');
    object(`${slug}/index.html`, access.pageOpen, 'app page');
    object(`${slug}/latest.json`, access.pointersOpen, 'latest.json');
    object(`${slug}/inflight.json`, access.pointersOpen, 'inflight.json');
    object(`${slug}/ios/manifest.plist`, access.ios || access.devicePublic, 'over-the-air manifest');
    object(`${slug}/0.0.0/${slug}-0.0.0-1.ipa`, access.ios || access.devicePublic, 'IPA');
    for (const name of access.publicEditions) {
      object(`${slug}/editions/${name}/latest.json`, true, `public edition ${name} pointer`);
      object(`${slug}/editions/${name}/0.0.0/${slug}-${name}-0.0.0-0.apk`, true, `public edition ${name} APK`);
    }
  }
  return plan;
}

// Every anonymous probe against the live host; the mismatches, as text. A probe that cannot be answered is a mismatch
// too: a check that cannot look must not pass.
export async function probe({ policy, fetchImpl = fetch, timeoutMs = 20_000 }) {
  const problems = [];
  for (const item of probePlan(policy)) {
    try {
      const response = await fetchImpl(item.url, { redirect: 'manual', headers: { 'Cache-Control': 'no-cache' }, signal: AbortSignal.timeout(timeoutMs) });
      await response.body?.cancel?.();
      if (!item.expect.includes(response.status)) problems.push(`${item.url.replace(/\?.*$/, '')} answered ${response.status}, expected ${item.expect.join(' or ')} (${item.why})`);
    } catch (error) {
      problems.push(`${item.url} could not be probed (${error.message}); ${item.why}`);
    }
  }
  return problems;
}

// ------------------------------------------------------------------------------------------------------ admin (mc)

async function adminMc({ policy, args, input, env = process.env, runner = attempt, read = readSecret }) {
  const credentials = Object.freeze({ access: await read(adminRefs.access, { env }), secret: await read(adminRefs.secret, { env }) });
  const childEnv = mcEnvironment(env, credentials, policy.delivery.s3.write);
  const result = runner('mc', ['--quiet', '--no-color', '--disable-pager', ...args], { env: childEnv, timeout: 60_000, ...(input ? { input } : {}) });
  const text = `${result.stdout ?? ''}${result.stderr ?? ''}`.split(credentials.secret).join('<redacted>').trim();
  if (!result.ok) throw new Error(`mc ${args.slice(0, 2).join(' ')} failed: ${text.split('\n').slice(-3).join(' ').slice(0, 300)}`);
  return (result.stdout ?? '').split(credentials.secret).join('<redacted>');
}

export async function liveDocument(options) {
  const out = await adminMc({ ...options, args: ['anonymous', 'get-json', `${alias}/${options.policy.delivery.s3.bucket}`] });
  try { return JSON.parse(out); } catch { throw new Error('the live bucket policy is not JSON (is any policy set?)'); }
}

export async function applyDocument({ policy, text, ...options }) {
  const dir = mkdtempSync(join(tmpdir(), 'bucket-policy-'));
  const file = join(dir, 'policy.json');
  try {
    writeFileSync(file, text, { mode: 0o600 });
    await adminMc({ ...options, policy, args: ['anonymous', 'set-json', file, `${alias}/${policy.delivery.s3.bucket}`] });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ------------------------------------------------------------------------------------------------------ commands

export async function check({ policy, text = readFileSync(committedFile, 'utf8'), offline = false, fetchImpl = fetch, log = console.log } = {}) {
  const problems = [];
  const drift = fileProblem(policy, text);
  if (drift) problems.push(drift);
  try { if (anonymousListing(JSON.parse(text))) problems.push('the committed bucket policy lets the anonymous public list the bucket'); } catch { problems.push('tools/ci/bucket-policy.json is not JSON'); }
  if (!offline) problems.push(...await probe({ policy, fetchImpl }));
  for (const problem of problems) log(`::error::BUCKET_POLICY_DRIFT ${problem}`);
  log(problems.length === 0 ? `BUCKET_POLICY_OK ${offline ? 'the committed file matches policy.json (live probes skipped)' : `the committed file matches policy.json and the live bucket answers ${probePlan(policy).length} anonymous probes as it says`}` : `BUCKET_POLICY_DRIFT ${problems.length} problem${problems.length === 1 ? '' : 's'}`);
  return problems;
}

export async function main(argv = process.argv.slice(2), { log = console.log, ...options } = {}) {
  const [command = 'check', ...flags] = argv;
  const { policy } = loadPolicy();
  let text = '';
  try { text = readFileSync(committedFile, 'utf8'); } catch { /* `write` creates it; every other command reports the drift */ }
  if (command === 'write') {
    writeFileSync(committedFile, renderBucketPolicy(policy));
    log(`wrote ${committedFile}`);
    return 0;
  }
  if (command === 'check') return (await check({ policy, text, offline: flags.includes('--offline'), log, ...options })).length === 0 ? 0 : 1;
  const drift = fileProblem(policy, text);
  if (drift) { log(`::error::${drift}`); return 1; }
  if (command === 'diff') {
    const { missing, extra } = documentDiff(JSON.parse(text), await liveDocument({ policy, ...options }));
    for (const item of missing) log(`+ ${item}`);
    for (const item of extra) log(`- ${item}`);
    log(missing.length + extra.length === 0 ? 'BUCKET_POLICY_SAME the live policy equals the committed one' : `BUCKET_POLICY_DIFFERS ${missing.length} statement(s) to add, ${extra.length} to remove`);
    return missing.length + extra.length === 0 ? 0 : 1;
  }
  if (command === 'apply') {
    if (flags.includes('--dry-run')) {
      const { missing, extra } = documentDiff(JSON.parse(text), await liveDocument({ policy, ...options }).catch(() => ({ Statement: [] })));
      log(`BUCKET_POLICY_DRY_RUN would ${missing.length + extra.length === 0 ? 'change nothing' : `add ${missing.length} and remove ${extra.length} statement(s)`}; nothing was applied`);
      return 0;
    }
    await applyDocument({ policy, text, ...options });
    const { missing, extra } = documentDiff(JSON.parse(text), await liveDocument({ policy, ...options }));
    if (missing.length + extra.length > 0) { log('::error::BUCKET_POLICY_APPLY the live policy still differs after set-json'); return 1; }
    log('BUCKET_POLICY_APPLIED the live policy equals the committed file');
    return (await check({ policy, text, log, ...options })).length === 0 ? 0 : 1;
  }
  log(`unknown command "${command}": check, write, diff or apply`);
  return 2;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(code => { process.exitCode = code; }, error => { console.error(`::error::${error.message}`); process.exitCode = 1; });
}
