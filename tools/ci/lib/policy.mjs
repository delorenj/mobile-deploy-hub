// tools/ci/policy.json: the deploy rules every mobile deployer obeys (design v1.1, A1). The jobs read it from the
// action path at the exact hub tag; it is never taken from an input, an environment variable, the app manifest or a
// hook. A policy change is a hub release. Parsed strictly: an unknown key is refused, and "none" can never be a bump
// level. Every job logs HUB_POLICY sha256=<8> and every receipt records the full digest.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const policyFile = fileURLToPath(new URL('../policy.json', import.meta.url));
const fail = message => { throw new Error(`policy.json: ${message}`); };
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function exact(where, value, keys, optional = []) {
  if (!isObject(value)) fail(`${where} must be an object`);
  for (const key of Object.keys(value)) if (!keys.includes(key) && !optional.includes(key)) fail(`${where} has unknown key "${key}"`);
  for (const key of keys) if (!(key in value)) fail(`${where}.${key} is required`);
}
const positive = (where, value) => { if (!Number.isSafeInteger(value) || value <= 0) fail(`${where} must be a positive whole number`); };
const labels = (where, value) => {
  if (!Array.isArray(value) || value.length === 0 || value.some(label => typeof label !== 'string' || !/^[A-Za-z0-9_.-]+$/.test(label))) fail(`${where} must list runner labels`);
  if (!value.includes('self-hosted')) fail(`${where} must be self-hosted runners (private repos: no billed hosted minutes)`);
};

export function parsePolicy(source) {
  let policy;
  try { policy = JSON.parse(source); } catch (error) { fail(`not valid JSON (${error.message})`); }
  exact('policy', policy, ['schema', 'bump', 'event', 'manifest_schema', 'apps', 'callers', 'runners', 'devices', 'delivery', 'mac', 'catch_up']);
  if (policy.schema !== 1) fail('schema must be 1');

  exact('bump', policy.bump, ['levels', 'default']);
  const allowed = ['patch', 'minor', 'major'];
  if (!Array.isArray(policy.bump.levels) || policy.bump.levels.length === 0 || policy.bump.levels.some(level => !allowed.includes(level))) fail(`bump.levels must be some of ${allowed.join(', ')}; every deploy bumps, there is no "none"`);
  if (!policy.bump.levels.includes(policy.bump.default)) fail('bump.default must be one of bump.levels');

  exact('event', policy.event, ['per', 'strict', 'catch_up', 'types']);
  if (policy.event.per !== 'run-attempt') fail('event.per must be run-attempt');
  if (policy.event.strict !== true) fail('event.strict must be true: a dead bus turns the run red');
  if (typeof policy.event.catch_up !== 'boolean') fail('event.catch_up must be true or false');
  const types = ['bloodbank.project.deployment.completed', 'bloodbank.project.deployment.failed'];
  if (!Array.isArray(policy.event.types) || policy.event.types.join() !== types.join()) fail(`event.types must be ${types.join(', ')}`);

  if (!Array.isArray(policy.manifest_schema) || policy.manifest_schema.length === 0 || policy.manifest_schema.some(schema => schema !== 2)) fail('manifest_schema must be [2]: the v2 (schema 1) path is gone');

  if (!isObject(policy.apps) || Object.keys(policy.apps).length === 0) fail('apps must name at least one repository');
  const slugs = new Set();
  for (const [repo, app] of Object.entries(policy.apps)) {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) fail(`apps key "${repo}" must be owner/repo`);
    if (!isObject(app) || !Array.isArray(app.lanes)) fail(`apps.${repo} must be an object with lanes`);
    if (app.lanes.length === 0 || app.lanes.some(lane => !['android', 'ios'].includes(lane)) || new Set(app.lanes).size !== app.lanes.length) fail(`apps.${repo}.lanes must list android and/or ios`);
    // Each lane pins what a device may receive (v1.1.3): the package and the signer on Android, the bundle on iOS. The
    // gate, deliver and the catch-up hold every build to these, never to a manifest or latest.json alone.
    // v1.2: an app that shares its repository's tags with other things names its own tag prefix (a monorepo's
    // `navi-v1.2.3` beside the repository's `v2.0.0`), and an app whose main takes only reviewed pull requests keeps
    // its version in those tags alone (`version: "tag"`): the bump pushes the tag and commits nothing.
    exact(`apps.${repo}`, app, ['slug', 'lanes', ...app.lanes], ['tag_prefix', 'version']);
    if ('tag_prefix' in app && !/^[a-z][a-z0-9-]*v$/.test(app.tag_prefix ?? '')) fail(`apps.${repo}.tag_prefix must be lowercase and end in "v" (v, navi-v)`);
    if ('version' in app && !['commit', 'tag'].includes(app.version)) fail(`apps.${repo}.version must be "commit" or "tag"`);
    if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(app.slug ?? '')) fail(`apps.${repo}.slug must be a pjangler slug`);
    if (slugs.has(app.slug)) fail(`apps: slug ${app.slug} is used twice`);
    slugs.add(app.slug);
    if (app.lanes.includes('android')) {
      exact(`apps.${repo}.android`, app.android, ['package', 'signer_sha256']);
      if (!/^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/.test(app.android.package ?? '')) fail(`apps.${repo}.android.package must be an Android package name`);
      if (!/^[0-9a-f]{64}$/.test(app.android.signer_sha256 ?? '')) fail(`apps.${repo}.android.signer_sha256 must be the lowercase sha256 of the signing certificate`);
    }
    if (app.lanes.includes('ios')) {
      exact(`apps.${repo}.ios`, app.ios, ['bundle']);
      if (!/^[A-Za-z][A-Za-z0-9-]*(\.[A-Za-z][A-Za-z0-9-]*)+$/.test(app.ios.bundle ?? '')) fail(`apps.${repo}.ios.bundle must be a reverse-DNS bundle id`);
    }
  }

  exact('callers', policy.callers, ['workflow', 'manifest', 'accept']);
  if (!/^\.github\/workflows\/[\w.-]+\.ya?ml$/.test(policy.callers.workflow ?? '')) fail('callers.workflow must be a file in .github/workflows');
  if (typeof policy.callers.manifest !== 'string' || policy.callers.manifest.startsWith('/') || policy.callers.manifest.split('/').includes('..') || !policy.callers.manifest.endsWith('.json')) fail('callers.manifest must be a .json path inside the app checkout');
  if (!Array.isArray(policy.callers.accept) || policy.callers.accept.length === 0 || policy.callers.accept.some(hash => !/^[0-9a-f]{64}$/.test(hash))) fail('callers.accept must list sha256 digests of accepted caller templates');

  exact('runners', policy.runners, ['linux', 'mac']);
  labels('runners.linux', policy.runners.linux);
  labels('runners.mac', policy.runners.mac);

  exact('devices', policy.devices, ['absent', 'android_wait_s', 'ipad_wait_s']);
  if (policy.devices.absent !== 'pending') fail('devices.absent must be pending');
  positive('devices.android_wait_s', policy.devices.android_wait_s);
  positive('devices.ipad_wait_s', policy.devices.ipad_wait_s);

  exact('delivery', policy.delivery, ['s3', 'quickdrop', 'release']);
  exact('delivery.s3', policy.delivery.s3, ['bucket', 'public', 'write', 'keep_apk', 'keep_ipa']);
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(policy.delivery.s3.bucket ?? '')) fail('delivery.s3.bucket must be a bucket name');
  if (!/^https:\/\/[A-Za-z0-9.-]+(\/[A-Za-z0-9._-]+)*$/.test(policy.delivery.s3.public ?? '') || !policy.delivery.s3.public.endsWith(`/${policy.delivery.s3.bucket}`)) fail('delivery.s3.public must be the https URL of the bucket');
  if (!/^http:\/\/127\.0\.0\.1:\d{2,5}$/.test(policy.delivery.s3.write ?? '')) fail('delivery.s3.write must be a loopback endpoint (writes never cross Cloudflare or Traefik)');
  positive('delivery.s3.keep_apk', policy.delivery.s3.keep_apk);
  positive('delivery.s3.keep_ipa', policy.delivery.s3.keep_ipa);
  exact('delivery.quickdrop', policy.delivery.quickdrop, ['dir', 'max_mb', 'keep']);
  if (!/^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/.test(policy.delivery.quickdrop.dir ?? '') || policy.delivery.quickdrop.dir.split('/').includes('..')) fail('delivery.quickdrop.dir must be a path under the home folder');
  positive('delivery.quickdrop.max_mb', policy.delivery.quickdrop.max_mb);
  positive('delivery.quickdrop.keep', policy.delivery.quickdrop.keep);
  if (typeof policy.delivery.release !== 'boolean') fail('delivery.release must be true or false');

  exact('mac', policy.mac, ['lan_cidr', 'metered_budget_mib', 'queue_limit_min']);
  if (!/^\d{1,3}(\.\d{1,3}){3}\/\d{1,2}$/.test(policy.mac.lan_cidr ?? '')) fail('mac.lan_cidr must be an IPv4 CIDR');
  positive('mac.metered_budget_mib', policy.mac.metered_budget_mib);
  // How long a Mac job may sit queued for its runner before the host watchdog (tools/ci/macwatch.mjs) gives the
  // iPad up for that run: GitHub keeps a self-hosted job queued for 24 hours otherwise.
  positive('mac.queue_limit_min', policy.mac.queue_limit_min);

  exact('catch_up', policy.catch_up, ['android_every_s', 'ios_every_s', 'max_failures']);
  positive('catch_up.android_every_s', policy.catch_up.android_every_s);
  positive('catch_up.ios_every_s', policy.catch_up.ios_every_s);
  positive('catch_up.max_failures', policy.catch_up.max_failures);
  return policy;
}

export function loadPolicy(file = policyFile) {
  const source = readFileSync(file, 'utf8');
  const policy = parsePolicy(source);
  const sha256 = createHash('sha256').update(source).digest('hex');
  return { policy, sha256, short: sha256.slice(0, 8) };
}

// The tag a version is released under, and whether the bump commits a version file or only pushes that tag.
export const tagPrefixOf = app => app?.tag_prefix ?? 'v';
export const tagOf = (app, version) => `${tagPrefixOf(app)}${version}`;
export const tagOnlyOf = app => app?.version === 'tag';

// The app a repository deploys, or a refusal: only the repositories the policy lists deploy through the hub.
export function appFor(policy, repo) {
  const app = policy.apps[repo];
  if (!app) throw new Error(`HUB_GATE_REFUSED repo: ${repo || 'this repository'} is not listed in the hub policy (tools/ci/policy.json apps); a policy change is a hub release`);
  return app;
}
