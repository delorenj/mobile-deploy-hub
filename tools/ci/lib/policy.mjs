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

// The TestFlight block an app may carry (JIMB-466). It never switches TestFlight on or off: an app is a TestFlight app
// because its manifest declares ios.store, under the one rule. The block only says WHERE a store build goes and how
// its iOS marketing version moves, and an app without it behaves exactly as before:
//   groups  the beta groups the app's assign hook gives each build to, by name (internal and external alike; the
//           hub only passes them on, as HUB_TESTFLIGHT_GROUPS, and records them in the receipt). Default Owner Testing.
//   train   how the iOS marketing version moves. patch (default): it is the deploy's version, as always. minor: it
//           moves only on a minor or major bump (0.3.7 ships as 0.3.0) while the build number keeps climbing, so Apple's
//           Beta App Review, which is per marketing version, is not repeated for every patch deploy. Android keeps its
//           patch versions either way.
export const defaultGroups = Object.freeze(['Owner Testing']);
export const trains = Object.freeze(['patch', 'minor']);
// A group name is one line of plain words: it travels comma-separated in HUB_TESTFLIGHT_GROUPS, so no comma.
export const groupName = /^[A-Za-z0-9][A-Za-z0-9 ._()&'-]{0,63}$/;

function testflight(where, block, app) {
  exact(where, block, [], ['groups', 'train']);
  if (!app.lanes.includes('ios')) fail(`${where} is for an app with an iOS lane`);
  if ('groups' in block) {
    const groups = block.groups;
    if (!Array.isArray(groups) || groups.length === 0 || groups.length > 8) fail(`${where}.groups must list 1 to 8 beta group names`);
    for (const name of groups) if (typeof name !== 'string' || !groupName.test(name) || name !== name.trim()) fail(`${where}.groups has a bad group name ${JSON.stringify(name)} (letters, digits, spaces and . _ ( ) & ' -; no comma; at most 64 characters)`);
    if (new Set(groups.map(name => name.toLowerCase())).size !== groups.length) fail(`${where}.groups names a group twice`);
  }
  if ('train' in block && !trains.includes(block.train)) fail(`${where}.train must be one of ${trains.join(', ')}`);
}

// MOBI-15, the bundle-split rule. An app whose iPad development build (devicectl) and TestFlight build share one bundle id
// has one app slot on the iPad, so TestFlight can put an older build over the hub's (Tower, 2026-11-02). The rule: an app
// with an iOS device lane AND a store lane pins ios.store_bundle, and it differs from ios.bundle. The device (dev) bundle
// is the one that changes and takes the suffix; store_bundle keeps the App Store Connect record id, which Apple never
// lets change (Green In Between: device io.lasertoast.greeninbetween.spike, store io.lasertoast.greeninbetween).
//
// How the hub knows an app has a store lane, two signals, either one is enough:
//   1. the app's manifest declares ios.store (the hub's one definition of "a TestFlight app", see the testflight block
//      note above). Only the gate sees the manifest, so the gate carries this half.
//   2. the policy's own testflight block (it only exists for an app that ships to TestFlight). The parser carries this
//      half, so a policy edit that adds such an app without a split bundle never reaches a release.
// Staged: shared_bundle_allowlist names, by repository, each app that has not migrated yet, with the date it was listed
// and why. The gate logs one HUB_POLICY warning for it and goes on. The entry leaves when the migration lands.
export const bundleDate = /^\d{4}-\d{2}-\d{2}$/;

function bundleSplitRules(policy) {
  if (!('shared_bundle_allowlist' in policy)) policy.shared_bundle_allowlist = {};
  const list = policy.shared_bundle_allowlist;
  if (!isObject(list)) fail('shared_bundle_allowlist must be an object keyed by owner/repo');
  for (const [repo, entry] of Object.entries(list)) {
    const where = `shared_bundle_allowlist.${repo}`;
    if (!policy.apps[repo]?.lanes.includes('ios')) fail(`${where} must name an app in apps with an iOS lane`);
    exact(where, entry, ['since', 'reason']);
    const day = new Date(`${entry.since}T00:00:00Z`);
    if (typeof entry.since !== 'string' || !bundleDate.test(entry.since) || Number.isNaN(day.getTime()) || day.toISOString().slice(0, 10) !== entry.since) fail(`${where}.since must be the date it was listed (YYYY-MM-DD)`);
    if (typeof entry.reason !== 'string' || entry.reason.trim() === '' || entry.reason.length > 300 || /[\r\n]/.test(entry.reason)) fail(`${where}.reason must be one line of plain words (at most 300 characters)`);
  }
  for (const [repo, app] of Object.entries(policy.apps)) {
    if (!app.ios) continue;
    const { bundle, store_bundle: store } = app.ios;
    if (typeof store === 'string' && store.startsWith(`${bundle}.`)) fail(`apps.${repo}.ios.store_bundle ${store} is the device bundle plus a suffix: the device bundle takes the suffix, and store_bundle keeps the App Store Connect id`);
    if ('testflight' in app && (store ?? bundle) === bundle && !(repo in list)) fail(`apps.${repo} ships to TestFlight (testflight block) on its device bundle ${bundle}: pin ios.store_bundle to the App Store id and give the device bundle a suffix, or list the repository in shared_bundle_allowlist`);
  }
}

// What the rule says about one app. `manifest` is the app's loaded manifest when the gate has it. status:
//   no-store-lane   nothing to split: no ios.store in the manifest and no testflight block
//   split           the store bundle differs from the device bundle: the rule is met
//   refused         shared id, not allowlisted
//   allowlisted     shared id, allowlisted: a warning
//   stale-allowlist allowlisted but already split: the entry can go
export function bundleSplitOf(policy, repo, app, manifest = null) {
  const device = app?.ios?.bundle ?? null;
  const allowed = policy.shared_bundle_allowlist?.[repo] ?? null;
  const store = device ? (app.ios.store_bundle ?? device) : null;
  const storeLane = Boolean(device) && (Boolean(manifest?.ios?.store) || Boolean(app.testflight));
  const shared = storeLane && store === device;
  const status = !storeLane ? 'no-store-lane' : shared ? (allowed ? 'allowlisted' : 'refused') : (allowed ? 'stale-allowlist' : 'split');
  return { status, device, store, allowed, repo };
}

// MOBI-14: the extra Android editions an app may build (docs/multi-edition-android.md). The top-level package and signer
// stay the device edition's, the only APK a device, Quickdrop or the catch-up may receive; each named edition pins its own
// package and signer, so the gate and deliver hold every edition's APK to the policy and never to a manifest alone.
// `public: true` is the hub's half of the opt-in to the anonymous edition page (the manifest's `public` block is the
// app's half); without it an edition stays private (built, verified, attached to the private Release, never published).
// MOBI-17: the bucket policy (lib/access.mjs, tools/ci/bucket-policy.json) is generated from these pins, so a new public
// edition is anonymous only once that file is regenerated and applied (tools/bucket-policy.mjs).
export const editionNamePattern = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

function androidEditions(where, android) {
  const editions = android.editions;
  if (!isObject(editions) || Object.keys(editions).length === 0) fail(`${where} must name at least one edition`);
  const packages = new Set([android.package]);
  for (const [name, edition] of Object.entries(editions)) {
    if (!editionNamePattern.test(name) || name.length > 32 || name === 'device') fail(`${where} has a bad edition name ${JSON.stringify(name)} (lowercase letters, digits and dashes; "device" is the top-level block)`);
    exact(`${where}.${name}`, edition, ['package', 'signer_sha256'], ['public']);
    if (!/^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/.test(edition.package ?? '')) fail(`${where}.${name}.package must be an Android package name`);
    if (packages.has(edition.package)) fail(`${where}.${name}.package ${edition.package} is already pinned for this app; every edition is its own package`);
    packages.add(edition.package);
    if (!/^[0-9a-f]{64}$/.test(edition.signer_sha256 ?? '')) fail(`${where}.${name}.signer_sha256 must be the lowercase sha256 of the signing certificate`);
    if ('public' in edition && typeof edition.public !== 'boolean') fail(`${where}.${name}.public must be true or false`);
  }
}

// The Play store split, Android's half of MOBI-15. An app whose device build (the sideload APK the S26 gets) and Play
// listing are different apps pins both halves of the Play side: android.store_package, the application id Play serves
// (Green In Between: device io.lasertoast.greeninbetween.spike, Play io.lasertoast.gib), and android.store_upload_sha256,
// the certificate of the key that signs the bundle for Play. That is the Play UPLOAD key, never the device signer: the
// device signer is a debug key that no store accepts. An app without store_package uploads under its device package, as
// before (Gruvato), and the hub holds nothing about its bundle's signer. A split app's bundle is read by the hub before any
// upload (lib/aab.mjs) and refused unless it is the store package, the planned versionCode and signed by exactly that key.
export const packagePattern = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/;

function androidStore(where, android) {
  const has = key => key in android;
  if (has('store_upload_sha256') && !has('store_package')) fail(`${where}.store_upload_sha256 needs ${where}.store_package: an app that uploads under its device package has no separate Play key to pin`);
  if (!has('store_package')) return;
  if (!packagePattern.test(android.store_package ?? '')) fail(`${where}.store_package must be an Android package name`);
  if (android.store_package === android.package) fail(`${where}.store_package ${android.store_package} is the device package: leave store_package out when the Play app and the device app are one id`);
  for (const [name, edition] of Object.entries(android.editions ?? {})) {
    if (edition.package === android.store_package) fail(`${where}.store_package ${android.store_package} is the package of the ${name} edition; the Play app is its own id`);
  }
  if (!/^[0-9a-f]{64}$/.test(android.store_upload_sha256 ?? '')) fail(`${where}.store_upload_sha256 is required with store_package: the lowercase sha256 of the Play upload certificate`);
  if (android.store_upload_sha256 === android.signer_sha256) fail(`${where}.store_upload_sha256 is the device signer: the Play upload key is a different key from the sideload one`);
}

// Where the Play upload goes and what its bundle is held to: the policy's store package and upload certificate, else the
// device package (nothing pinned about the signer). `app` may be null for a repository the policy does not list (a local
// run); the manifest's own package then stands in.
export function playTargetOf(app, fallbackPackage = null) {
  const android = app?.android;
  const split = typeof android?.store_package === 'string';
  return { package: split ? android.store_package : (android?.package ?? fallbackPackage), split, uploadSha256: split ? android.store_upload_sha256 : null };
}

// The policy's pin for one extra edition of an app, or null.
export const editionPinOf = (app, name) => app?.android?.editions?.[name] ?? null;

export function parsePolicy(source) {
  let policy;
  try { policy = JSON.parse(source); } catch (error) { fail(`not valid JSON (${error.message})`); }
  exact('policy', policy, ['schema', 'bump', 'event', 'manifest_schema', 'apps', 'callers', 'runners', 'devices', 'delivery', 'mac', 'catch_up', 'queue'], ['completion', 'shared_bundle_allowlist']);
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
    exact(`apps.${repo}`, app, ['slug', 'lanes', ...app.lanes], ['tag_prefix', 'version', 'testflight']);
    if ('testflight' in app) testflight(`apps.${repo}.testflight`, app.testflight, app);
    if ('tag_prefix' in app && !/^[a-z][a-z0-9-]*v$/.test(app.tag_prefix ?? '')) fail(`apps.${repo}.tag_prefix must be lowercase and end in "v" (v, navi-v)`);
    if ('version' in app && !['commit', 'tag'].includes(app.version)) fail(`apps.${repo}.version must be "commit" or "tag"`);
    if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(app.slug ?? '')) fail(`apps.${repo}.slug must be a pjangler slug`);
    if (slugs.has(app.slug)) fail(`apps: slug ${app.slug} is used twice`);
    slugs.add(app.slug);
    if (app.lanes.includes('android')) {
      exact(`apps.${repo}.android`, app.android, ['package', 'signer_sha256'], ['editions', 'public', 'store_package', 'store_upload_sha256']);
      if (!/^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/.test(app.android.package ?? '')) fail(`apps.${repo}.android.package must be an Android package name`);
      if (!/^[0-9a-f]{64}$/.test(app.android.signer_sha256 ?? '')) fail(`apps.${repo}.android.signer_sha256 must be the lowercase sha256 of the signing certificate`);
      if ('editions' in app.android) androidEditions(`apps.${repo}.android.editions`, app.android);
      androidStore(`apps.${repo}.android`, app.android);
      // MOBI-17: the device edition is private unless the policy publishes it (its APKs, pointers and page anonymous, as
      // before MOBI-17). An app that sells a public edition can never publish its device edition: that would be a free
      // copy one folder up (docs/private-device-builds.md).
      if ('public' in app.android) {
        if (typeof app.android.public !== 'boolean') fail(`apps.${repo}.android.public must be true or false`);
        const selling = Object.entries(app.android.editions ?? {}).filter(([, pin]) => pin.public === true).map(([name]) => name);
        if (app.android.public && selling.length > 0) fail(`apps.${repo}.android.public cannot be true: the app publishes the ${selling.join(' and ')} edition${selling.length > 1 ? 's' : ''}, so its device edition stays private`);
      }
    }
    if (app.lanes.includes('ios')) {
      // store_bundle: the App Store bundle id, when it differs from the iPad's development one (Green In Between's
      // dev builds are `.spike`, its TestFlight app is the clean id, so both live on the iPad side by side).
      exact(`apps.${repo}.ios`, app.ios, ['bundle'], ['store_bundle']);
      if (!/^[A-Za-z][A-Za-z0-9-]*(\.[A-Za-z][A-Za-z0-9-]*)+$/.test(app.ios.bundle ?? '')) fail(`apps.${repo}.ios.bundle must be a reverse-DNS bundle id`);
      if ('store_bundle' in app.ios && !/^[A-Za-z][A-Za-z0-9-]*(\.[A-Za-z][A-Za-z0-9-]*)+$/.test(app.ios.store_bundle ?? '')) fail(`apps.${repo}.ios.store_bundle must be a reverse-DNS bundle id`);
    }
  }

  bundleSplitRules(policy);

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

  queueBlock(policy.queue);

  // What "shipped" means, for every app at once (TOWE-76): the required targets, what the gate does when a required
  // lane cannot run, and how many same-version reruns `ship` may do on its own. No per-app switch exists on purpose:
  // an app is a TestFlight app because its manifest declares ios.store, never because the policy names it.
  // The completion contract is optional for v1.2-compatible releases. An absent block keeps the exact deployed
  // v1.2.25 behavior: away lanes skip, TestFlight is opt-in, and ship does not rerun automatically.
  if (!('completion' in policy)) policy.completion = {
    required: { devices: 'never', testflight: 'never' }, lane_unavailable: 'skip', reruns: 0,
  };
  exact('completion', policy.completion, ['required', 'lane_unavailable', 'reruns']);
  exact('completion.required', policy.completion.required, ['devices', 'testflight']);
  if (!completionDevices.includes(policy.completion.required.devices)) fail(`completion.required.devices must be one of ${completionDevices.join(', ')}`);
  if (!completionTestflight.includes(policy.completion.required.testflight)) fail(`completion.required.testflight must be one of ${completionTestflight.join(', ')} (store: every app whose manifest declares ios.store owes TestFlight)`);
  if (!laneUnavailable.includes(policy.completion.lane_unavailable)) fail(`completion.lane_unavailable must be one of ${laneUnavailable.join(', ')}`);
  if (!Number.isSafeInteger(policy.completion.reruns) || policy.completion.reruns < 0 || policy.completion.reruns > maxReruns) fail(`completion.reruns must be a whole number from 0 to ${maxReruns}`);
  return policy;
}

// The Queue's tuning (AD-11), one strict block that each Queue story grows by its own keys and no others. Story 2.4 adds the wait
// deadline's two inputs: the margin that keeps a waiting job's own report ahead of GitHub's `timeout-minutes` kill, and the
// minutes each job that waits for a device still needs once it has the device (ios takes `mac-ios` up to twice). Every value is
// a positive whole number of minutes; the allowance names exactly the jobs that wait (plan, android, ios).
export const queueJobs = Object.freeze(['plan', 'android', 'ios']);
function queueBlock(queue) {
  exact('queue', queue, ['wait_margin_min', 'hold_allowance_min']);
  positive('queue.wait_margin_min', queue.wait_margin_min);
  exact('queue.hold_allowance_min', queue.hold_allowance_min, queueJobs);
  for (const job of queueJobs) positive(`queue.hold_allowance_min.${job}`, queue.hold_allowance_min[job]);
}

export const completionDevices = Object.freeze(['lanes', 'never']);
export const completionTestflight = Object.freeze(['store', 'never']);
// refuse: a real run whose required lane would not run (the Mac offline, or a metered link over budget) stops at the
// gate, before any version is spent. skip: the deployed v1.2 behaviour (the lane is skipped and the run goes on).
export const laneUnavailable = Object.freeze(['refuse', 'skip']);
export const maxReruns = 3;

// The targets an app owes under an explicitly configured completion policy. Absent completion requires none;
// caller-requested TestFlight is added to the gate's per-run required set when selected.
export function requiredTargets(policy, app, { store = false } = {}) {
  const lanes = app?.lanes ?? [];
  return {
    android: policy.completion.required.devices === 'lanes' && lanes.includes('android'),
    ios: policy.completion.required.devices === 'lanes' && lanes.includes('ios'),
    testflight: policy.completion.required.testflight === 'store' && Boolean(store) && lanes.includes('ios'),
  };
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

// What the policy says about this app's TestFlight builds, defaults filled in (an unlisted repo, a local run and an app
// with no block all get the v1.2 behaviour: Owner Testing, the deploy's own version).
export function testflightPolicyOf(app) {
  const block = app?.testflight ?? {};
  return { groups: [...(block.groups ?? defaultGroups)], train: block.train ?? 'patch' };
}

// The iOS marketing version of a deploy. An explicit one (HUB_IOS_VERSION on a local run) wins; else the app's train:
// patch is the deploy's version, minor is X.Y.0 of it, so it changes only when a minor or major bump moves X or Y.
export function iosVersionOf(app, version, explicit = '') {
  if (explicit) return explicit;
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version ?? '');
  if (!match) throw new Error(`cannot derive an iOS version from "${version}" (expected X.Y.Z)`);
  return testflightPolicyOf(app).train === 'minor' ? `${match[1]}.${match[2]}.0` : version;
}

// The comma-separated list the app's assign hook reads (HUB_TESTFLIGHT_GROUPS).
export const groupsLabel = groups => groups.join(', ');

// The app a repository deploys, or a refusal: only the repositories the policy lists deploy through the hub.
export function appFor(policy, repo) {
  const app = policy.apps[repo];
  if (!app) throw new Error(`HUB_GATE_REFUSED repo: ${repo || 'this repository'} is not listed in the hub policy (tools/ci/policy.json apps); a policy change is a hub release`);
  return app;
}
