// play-readback (GRUV-184, one level up: every hub app with android.bundle). A dispatched deploy.yml run with
// play_readback=<versionCode> runs only this job: read-only proof of what Play serves for that versionCode — the bundle
// listing (its sha256/sha1) and the Google-generated universal APK, downloaded as a short-retention run artifact. An
// edit is opened only to read and deleted again whatever happens; it is never committed. The API allowlist in
// lib/play.mjs refuses every other request by construction, so this lane cannot commit an edit, change a track or
// upload anything.
//
// The receipt cross-checks the deploy-time evidence too: the play-bundle release asset the retention lane published
// (if any) must carry the same sha256 Play reports for that bundle.
import { homedir } from 'node:os';
import { join } from 'node:path';
import { apkIdentity, parseSigners, signerEnvironment, findApksigner } from '../lib/android.mjs';
import { run } from '../lib/exec.mjs';
import { loadManifest } from '../lib/manifest.mjs';
import { loadPolicy, playTargetOf } from '../lib/policy.mjs';
import { readBack } from '../lib/play.mjs';
import { buildReceipt, writeReceipt } from '../lib/receipt.mjs';
import { callerReader } from './gate.mjs';
import { guarded, policyBanner } from './common.mjs';
import { checkCaller } from '../lib/caller.mjs';

// The play-bundle asset the retention lane published for this versionCode, if any: <slug>-<version>-<code>.aab on one
// of the app's Releases, with its .sha256 sibling and GitHub's own per-asset digest. Both must equal what Play reports.
async function retainedEvidence({ repo, slug, code, gh }) {
  const releases = JSON.parse(await gh(['api', `repos/${repo}/releases?per_page=100`]));
  for (const release of releases) {
    for (const asset of release.assets ?? []) {
      const match = new RegExp(`^${slug.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&')}-\\d+\\.\\d+\\.\\d+-${code}\\.aab$`).exec(asset.name ?? '');
      if (!match) continue;
      const digestAsset = (release.assets ?? []).find(entry => entry.name === `${asset.name}.sha256`);
      const apiDigest = String(asset.digest ?? '').toLowerCase().replace(/^sha256:/, '');
      return {
        release: release.tag_name ?? null,
        asset: asset.name,
        api_digest: apiDigest || null,
        sha256_file: digestAsset?.name ?? null,
        content: digestAsset ? String((await gh(['api', `repos/${repo}/releases/assets/${digestAsset.id}`, '-H', 'Accept: application/octet-stream']))).trim() : null,
      };
    }
  }
  return null;
}

export async function playReadback(config, {
  env = process.env,
  home = homedir(),
  fetchImpl,
  gh = async args => run('gh', args, { env }),
  readApkIdentity = ({ apk }) => apkIdentity({ apk, env, home }),
  apkSigners = ({ apk }) => parseSigners(run(findApksigner(env, home), ['verify', '--print-certs', apk], { env: signerEnvironment(env, home) })),
  log = console.log,
} = {}) {
  const out = join(config.out, 'play-readback');
  return guarded('play-readback', out, config, env, async track => {
    track.stage = 'readback';
    const { policy } = policyBanner(log);
    if (!config.playReadback) throw new Error('the play-readback command needs --play-readback <versionCode> (HUB_PLAY_READBACK); nothing else on a readback run');
    if (!env.GH_TOKEN && !env.GITHUB_TOKEN) throw new Error('GH_TOKEN is empty; the caller must grant contents: read');
    // Inside a workflow the run must have been started by the app's own accepted copy of templates/deploy.yml, exactly
    // as the gate checks it — a second workflow at any ref runs no readback. Outside Actions this is a no-op.
    if (env.GITHUB_ACTIONS === 'true') checkCaller({ policy, env, read: callerReader(config, env) });
    const manifest = await loadManifest(config.cwd, config.manifest);
    const spec = manifest.android ?? (() => { throw new Error('the manifest has no android section'); })();
    if (!spec.bundle_artifact) throw new Error('the manifest declares no android.bundle_artifact; there is no Play bundle to read back');
    const repo = env.GITHUB_REPOSITORY ?? '';
    const target = playTargetOf(policy.apps[repo], spec.package);
    const code = config.playReadback;
    const apkName = `${manifest.project.slug}-${code}-universal.apk`;
    const apkPath = join(out, apkName);
    const read = await readBack({ pkg: target.package, versionCode: code, token: env.PLAY_TOKEN, apkPath, fetchImpl, log });
    // What the APK itself says it is: package + versionCode must be the asked one. The signer is recorded (it is
    // Play's own re-signing), and the readback answers whether it is the certificate Google said it used.
    const apkFacts = readApkIdentity({ apk: apkPath });
    if (apkFacts.package !== target.package) throw new Error(`HUB_PLAY_READBACK_MISMATCH package: the universal APK is ${apkFacts.package}, the policy says Play serves ${target.package}`);
    if (Number(apkFacts.versionCode) !== Number(code)) throw new Error(`HUB_PLAY_READBACK_MISMATCH versionCode: the universal APK carries ${apkFacts.versionCode}, the readback asked for ${code}`);
    const signer = await Promise.resolve().then(() => apkSigners({ apk: apkPath })).then(list => list[0] ?? null, error => { log(`HUB_PLAY_READBACK_SIGNER_UNREAD ${String(error?.message ?? error).split('\n')[0]}`); return null; });
    const certificateMatches = signer !== null && read.apk.certificate_sha256 !== null ? signer === read.apk.certificate_sha256 : null;
    // The retained deploy-time evidence must agree with what Play reports now, when there is any.
    const evidence = await retainedEvidence({ repo, slug: manifest.project.slug, code, gh }).then(found => found, error => { log(`HUB_PLAY_READBACK_RETAINED_UNREAD ${String(error?.message ?? error).split('\n')[0]}`); return null; });
    const playSha = read.bundle.sha256;
    let retained = null;
    if (evidence) {
      const expected = `${playSha}  ${evidence.asset}`;
      if (evidence.api_digest && evidence.api_digest !== playSha) throw new Error(`HUB_PLAY_READBACK_MISMATCH retained: GitHub's digest of ${evidence.asset} is ${evidence.api_digest}, Play reports sha256=${playSha} for versionCode=${code}`);
      if (evidence.content !== null && evidence.content !== expected) throw new Error(`HUB_PLAY_READBACK_MISMATCH retained: ${evidence.sha256_file} reads "${evidence.content}", expected "${expected}" (Play's sha256 for versionCode=${code})`);
      retained = { release: evidence.release, asset: evidence.asset, api_digest: evidence.api_digest || null, sha256_file: evidence.sha256_file ?? null, matches: true };
      log(`HUB_PLAY_READBACK_RETAINED ${evidence.asset} on Release ${evidence.release}: its sha256 equals what Play reports for versionCode=${code}`);
    } else {
      log(`HUB_PLAY_READBACK_RETAINED none: no play-bundle release asset names versionCode=${code} (nothing to cross-check)`);
    }
    log(`HUB_PLAY_READBACK_OK ${target.package} versionCode=${code} bundle_sha256=${read.bundle.sha256} universal_apk=${apkName} apk_sha256=${read.apk.sha256} bytes=${read.apk.bytes}`);
    await writeReceipt(out, buildReceipt({
      lane: 'play-readback', config, env,
      // A readback builds and deploys nothing, so the deploy defaults the dispatched run's config carries would lie:
      // dry_run true, channel sideload, an empty version/code and sha = the dispatch sha. Record the truth instead,
      // with a readback marker; dispatch_sha keeps the dispatch commit, honestly named.
      version: null, androidCode: null, dry_run: false, channel: 'play-readback', readback: true, sha: null,
      // Bind the receipt to the build it proves without the evidence file: the retained deploy asset, when there is one.
      candidate_hint: retained ? { release: retained.release, asset: retained.asset } : null,
      play: { package: target.package, versionCode: Number(code), edit: read.edit, edit_deleted: read.edit_deleted, committed: false },
      bundle: read.bundle,
      universal_apk: { name: apkName, bytes: read.apk.bytes, sha256: read.apk.sha256, sha1: read.apk.sha1, download_id: read.apk.download_id, package: apkFacts.package, versionCode: apkFacts.versionCode, versionName: apkFacts.versionName, signer_sha256: signer, certificate_sha256: read.apk.certificate_sha256, certificate_matches: certificateMatches },
      retained,
      artifacts: [{ name: apkName, sha256: read.apk.sha256 }],
      notes: [`Play ${target.package} versionCode ${code}: bundle sha256=${read.bundle.sha256}; the Google-generated universal APK (${read.apk.bytes} bytes, sha256 ${read.apk.sha256}) rides the play-readback run artifact. The edit was opened read-only and deleted again; nothing was committed.`],
    }), env);
    return read;
  });
}
