// The Mac-only store lane (an app whose manifest has ios.store.build and no ios.export): the app's build hook leaves a
// signed App Store IPA in $HUB_OUT/ios, and the hub checks it before upload and assign are ever called. Tower and Navi
// keep their Linux handoff; this is the same TestFlight lane for an app whose whole iOS build happens on the Mac.
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { inspectStoreIpa } from './apple.mjs';
import { hook } from './exec.mjs';
import { sha256File } from './receipt.mjs';

// The App Store bundle id: the store section's own, else the iPad's (Tower's is one id).
export const storeBundleOf = spec => spec.store?.bundle ?? spec.bundle;

// Runs ios.store.build (a dry run too: signing is the thing to prove before a version is spent) and checks the IPA it
// left against the plan: bundle, version, build number, the pinned distribution signer, an App Store profile.
export async function buildStoreIpa({ spec, config, out, team, hooks, env = process.env, runner, log = console.log, runHook = hook, inspect = inspectStoreIpa }) {
  runHook('ios.store.build', spec.store.build, { cwd: config.cwd, env: hooks });
  const ipa = join(out, spec.store.artifact);
  let bytes;
  try {
    const stat = statSync(ipa);
    if (!stat.isFile()) throw new Error('not a file');
    bytes = stat.size;
  } catch { throw new Error(`the ios.store.build hook did not leave ${spec.store.artifact} in $HUB_OUT/ios`); }
  const bundle = storeBundleOf(spec);
  const facts = inspect({ ipa, into: join(out, 'store-check'), bundle, version: config.version, build: config.iosBuild, team, signer: spec.store.signer_sha1, env, ...(runner ? { runner } : {}) });
  const sha256 = await sha256File(ipa);
  log(`HUB_STORE_IPA_OK ${facts.bundle} ${facts.version} (${facts.build}) signer=${facts.signer.slice(0, 8)} profile=${facts.profile.name} bytes=${bytes}`);
  return { path: ipa, name: spec.store.artifact, bytes, sha256, bundle: facts.bundle, version: facts.version, build: facts.build, signer: facts.signer, profile: facts.profile };
}

// What the receipt keeps of the store IPA (no Mac paths).
export const receiptStoreIpa = ({ path: _path, ...rest }) => ({ ...rest });
