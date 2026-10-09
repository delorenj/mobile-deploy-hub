// builds/<slug>/latest.json: the delivery contract (design v1.1, C3). The deploy's deliver job and the catch-up
// reporter write it (both on big-chungus, under the s3-<slug> host lock); the catch-up installers, the plan's
// downgrade check and the pages read it. One parser and validator, here; the catch-up code imports it.
//
// The top level names the newest deploy (version, commit, run, correlation). Each platform block names the newest
// artifact for that platform and its device, and carries the run and correlation that produced it: a deploy that
// skipped a platform keeps that platform's previous block, so the two blocks can come from different runs.
//
// Pointers only move forward: a block is replaced only by a greater version (Android: then a greater code; iOS: then a
// greater build), or by the same version from the same run or with the same bytes (a rerun).
const semverPattern = /^(\d+)\.(\d+)\.(\d+)$/;
const sha256Pattern = /^[0-9a-f]{64}$/;
const slugPattern = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const isoPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const keyPattern = /^[a-z0-9][a-z0-9.-]*\/\d+\.\d+\.\d+\/[A-Za-z0-9._-]+$/;

export const statuses = Object.freeze(['installed', 'pending', 'skipped', 'failed']);
export const installers = Object.freeze(['deploy', 'catch-up', 'manual']);
export const platforms = Object.freeze(['android', 'ios']);

const fail = message => { throw new Error(`latest.json: ${message}`); };
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function exactKeys(where, value, required, optional = []) {
  if (!isObject(value)) fail(`${where} must be an object`);
  for (const key of Object.keys(value)) if (!required.includes(key) && !optional.includes(key)) fail(`${where} has unknown key "${key}"`);
  for (const key of required) if (!(key in value)) fail(`${where}.${key} is required`);
}

const text = (where, value, { max = 300, nullable = false, pattern } = {}) => {
  if (value === null && nullable) return;
  if (typeof value !== 'string' || value.length === 0 || value.length > max) fail(`${where} must be a string of 1 to ${max} characters`);
  if (pattern && !pattern.test(value)) fail(`${where} is malformed: ${JSON.stringify(value.slice(0, 80))}`);
};
const count = (where, value, { nullable = false, min = 0 } = {}) => {
  if (value === null && nullable) return;
  if (!Number.isSafeInteger(value) || value < min) fail(`${where} must be a whole number >= ${min}`);
};
const httpsUrl = /^https:\/\/[^\s"<>]+$/;

// ---------------------------------------------------------------------------------------------------- ordering

export function compareSemver(a, b) {
  const x = semverPattern.exec(a ?? '');
  const y = semverPattern.exec(b ?? '');
  if (!x || !y) throw new Error(`cannot compare versions "${a}" and "${b}" (expected X.Y.Z)`);
  for (let index = 1; index <= 3; index += 1) {
    const diff = Number(x[index]) - Number(y[index]);
    if (diff !== 0) return Math.sign(diff);
  }
  return 0;
}

// iOS builds: numbers when both are numbers (Tower, Green In Between), otherwise dotted versions (Gruvato's build is
// its version string, 0.2.5).
export function compareBuild(a, b) {
  const x = String(a ?? '');
  const y = String(b ?? '');
  if (/^\d+$/.test(x) && /^\d+$/.test(y)) return Math.sign(Number(x) - Number(y));
  const parts = value => value.split('.').map(part => (/^\d+$/.test(part) ? Number(part) : Number.NaN));
  const [p, q] = [parts(x), parts(y)];
  if (p.some(Number.isNaN) || q.some(Number.isNaN)) throw new Error(`cannot compare builds "${a}" and "${b}"`);
  for (let index = 0; index < Math.max(p.length, q.length); index += 1) {
    const diff = (p[index] ?? 0) - (q[index] ?? 0);
    if (diff !== 0) return Math.sign(diff);
  }
  return 0;
}

// Android: the version, then the versionCode. iOS: the version, then the build.
export function compareRelease(platform, a, b) {
  const byVersion = compareSemver(a.version, b.version);
  if (byVersion !== 0) return byVersion;
  return platform === 'android' ? Math.sign(Number(a.code) - Number(b.code)) : compareBuild(a.build, b.build);
}

export const describeRelease = (platform, block) => (block ? `${block.version} (${platform === 'android' ? block.code : block.build})` : 'nothing');

// ---------------------------------------------------------------------------------------------------- layout

// Bucket-relative keys (C2). Every part is validated, so a key can never climb out of the app's folder.
export function versionKey(slug, version, file) {
  if (!slugPattern.test(slug ?? '')) throw new Error(`bad slug "${slug}"`);
  if (!semverPattern.test(version ?? '')) throw new Error(`bad version "${version}"`);
  if (!/^[A-Za-z0-9._-]+$/.test(file ?? '') || file.startsWith('.')) throw new Error(`bad file name "${file}"`);
  return `${slug}/${version}/${file}`;
}
export const apkName = (slug, version, code) => `${slug}-${version}-${code}.apk`;
export const ipaName = (slug, version, build) => `${slug}-${version}-${build}.ipa`;
export const apkKey = (slug, version, code) => versionKey(slug, version, apkName(slug, version, code));
export const ipaKey = (slug, version, build) => versionKey(slug, version, ipaName(slug, version, build));
export const latestKey = slug => `${slug}/latest.json`;
export const inflightKey = slug => `${slug}/inflight.json`;
export const manifestKey = slug => `${slug}/ios/manifest.plist`;
export const pageKey = slug => `${slug}/index.html`;
export const publicUrl = (base, key) => `${base.replace(/\/+$/, '')}/${key}`;
// Apple's own form: not percent-encoded. URL(string:) on iPadOS accepts it.
export const installUrl = manifestUrl => `itms-services://?action=download-manifest&url=${manifestUrl}`;

// ---------------------------------------------------------------------------------------------------- validation

function validateRun(where, run) {
  exactKeys(where, run, ['repo', 'id', 'attempt', 'url']);
  text(`${where}.repo`, run.repo, { max: 140, pattern: /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/ });
  text(`${where}.id`, run.id, { max: 20, pattern: /^\d{1,20}$/ });
  count(`${where}.attempt`, run.attempt, { min: 1 });
  text(`${where}.url`, run.url, { max: 300, nullable: true, pattern: httpsUrl });
}

export function validateDevice(where, device) {
  // event_pending is the catch-up reporter's marker (an event to resend on its next pass); its shape is its own.
  exactKeys(where, device, ['name', 'model', 'status', 'since', 'by', 'reason', 'failures'], ['event_pending']);
  text(`${where}.name`, device.name, { max: 40 });
  text(`${where}.model`, device.model, { max: 120 });
  if (!statuses.includes(device.status)) fail(`${where}.status must be one of ${statuses.join(', ')}`);
  text(`${where}.since`, device.since, { max: 40, pattern: isoPattern });
  if (device.by !== null && !installers.includes(device.by)) fail(`${where}.by must be null or one of ${installers.join(', ')}`);
  text(`${where}.reason`, device.reason, { max: 300, nullable: true });
  count(`${where}.failures`, device.failures);
}

function validateBlockRun(where, block) {
  validateRun(`${where}.run`, block.run);
  text(`${where}.correlation`, block.correlation, { pattern: uuidPattern });
  text(`${where}.commit`, block.commit, { pattern: /^[0-9a-f]{7,40}$/ });
}

export function validateAndroid(where, block, base) {
  exactKeys(where, block, ['package', 'version', 'code', 'key', 'url', 'bytes', 'sha256', 'signer_sha256', 'quickdrop', 'device', 'run', 'correlation', 'commit']);
  text(`${where}.package`, block.package, { max: 200, pattern: /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/ });
  text(`${where}.version`, block.version, { pattern: semverPattern });
  count(`${where}.code`, block.code, { min: 1 });
  text(`${where}.key`, block.key, { max: 300, pattern: keyPattern });
  if (!block.key.endsWith('.apk')) fail(`${where}.key must name an .apk`);
  text(`${where}.url`, block.url, { max: 600, pattern: httpsUrl });
  if (base && block.url !== publicUrl(base, block.key)) fail(`${where}.url must be the public URL of ${where}.key`);
  count(`${where}.bytes`, block.bytes, { min: 1 });
  text(`${where}.sha256`, block.sha256, { pattern: sha256Pattern });
  text(`${where}.signer_sha256`, block.signer_sha256, { pattern: sha256Pattern });
  text(`${where}.quickdrop`, block.quickdrop, { max: 300, nullable: true, pattern: /^builds\/[A-Za-z0-9._-]+\.apk$/ });
  validateDevice(`${where}.device`, block.device);
  validateBlockRun(where, block);
}

export function validateIos(where, block, base) {
  exactKeys(where, block, ['bundle', 'version', 'build', 'key', 'url', 'bytes', 'sha256', 'manifest_url', 'install_url', 'device', 'run', 'correlation', 'commit']);
  text(`${where}.bundle`, block.bundle, { max: 200, pattern: /^[A-Za-z][A-Za-z0-9-]*(\.[A-Za-z][A-Za-z0-9-]*)+$/ });
  text(`${where}.version`, block.version, { pattern: semverPattern });
  text(`${where}.build`, block.build, { max: 40, pattern: /^[0-9][0-9.]*$/ });
  text(`${where}.sha256`, block.sha256, { pattern: sha256Pattern });
  // No over-the-air copy (the iPad installed it in the run over a metered link): key, url and the OTA links are null.
  if (block.key === null) {
    for (const key of ['url', 'manifest_url', 'install_url']) if (block[key] !== null) fail(`${where}.${key} must be null when ${where}.key is null`);
    count(`${where}.bytes`, block.bytes, { nullable: true, min: 1 });
  } else {
    text(`${where}.key`, block.key, { max: 300, pattern: keyPattern });
    if (!block.key.endsWith('.ipa')) fail(`${where}.key must name an .ipa`);
    text(`${where}.url`, block.url, { max: 600, pattern: httpsUrl });
    if (base && block.url !== publicUrl(base, block.key)) fail(`${where}.url must be the public URL of ${where}.key`);
    count(`${where}.bytes`, block.bytes, { min: 1 });
    text(`${where}.manifest_url`, block.manifest_url, { max: 600, pattern: httpsUrl });
    text(`${where}.install_url`, block.install_url, { max: 700, pattern: /^itms-services:\/\/\?action=download-manifest&url=https:\/\/[^\s"<>]+$/ });
    if (block.install_url !== installUrl(block.manifest_url)) fail(`${where}.install_url must point at ${where}.manifest_url`);
  }
  validateDevice(`${where}.device`, block.device);
  validateBlockRun(where, block);
}

export function validateLatest(doc, { base, slug } = {}) {
  exactKeys('latest', doc, ['schema', 'slug', 'name', 'version', 'commit', 'hub_ref', 'run', 'correlation', 'updated_at', 'android', 'ios'], ['mac_bytes']);
  if (doc.schema !== 1) fail('schema must be 1');
  text('slug', doc.slug, { max: 80, pattern: slugPattern });
  if (slug && doc.slug !== slug) fail(`slug is ${doc.slug}, expected ${slug}`);
  text('name', doc.name, { max: 120 });
  text('version', doc.version, { pattern: semverPattern });
  text('commit', doc.commit, { pattern: /^[0-9a-f]{7,40}$/ });
  text('hub_ref', doc.hub_ref, { max: 100, nullable: true });
  validateRun('run', doc.run);
  text('correlation', doc.correlation, { pattern: uuidPattern });
  text('updated_at', doc.updated_at, { max: 40, pattern: isoPattern });
  if (doc.mac_bytes !== undefined) count('mac_bytes', doc.mac_bytes, { nullable: true });
  if (doc.android !== null) validateAndroid('android', doc.android, base);
  if (doc.ios !== null) validateIos('ios', doc.ios, base);
  if (doc.android === null && doc.ios === null) fail('at least one of android and ios must be a block');
  for (const platform of platforms) {
    const block = doc[platform];
    if (block && block.key !== null && !block.key.startsWith(`${doc.slug}/`)) fail(`${platform}.key must live under ${doc.slug}/`);
  }
  return doc;
}

export function parseLatest(source, options = {}) {
  let doc;
  try { doc = JSON.parse(source); } catch (error) { fail(`not valid JSON (${error.message})`); }
  return validateLatest(doc, options);
}

export const serializeLatest = doc => `${JSON.stringify(validateLatest(doc), null, 2)}\n`;

// ---------------------------------------------------------------------------------------------------- forward-only

// Whether a deploy's new block may replace the current one: a greater release, or the same release from the same run
// or with the same bytes (Re-run failed jobs). Anything else keeps the current block.
export function mayReplace(platform, current, next) {
  if (!current) return { replace: true, reason: 'no earlier block' };
  const order = compareRelease(platform, next, current);
  if (order > 0) return { replace: true, reason: `${describeRelease(platform, next)} is newer than ${describeRelease(platform, current)}` };
  if (order === 0 && (next.sha256 === current.sha256 || next.run.id === current.run.id)) return { replace: true, reason: `a rerun of ${describeRelease(platform, current)}` };
  return { replace: false, reason: `kept ${describeRelease(platform, current)}: ${describeRelease(platform, next)} is ${order === 0 ? 'the same release with other bytes from another run' : 'older'}` };
}

// The catch-up reporter's one change: the device fields of a block that still names the release it installed. A
// pointer that moved forward is left alone (updated: false); the event is still the reporter's to send.
export function updateDevice(doc, platform, release, change) {
  if (!platforms.includes(platform)) throw new Error(`bad platform "${platform}"`);
  const block = doc[platform];
  const same = block && block.version === release.version && (platform === 'android' ? Number(block.code) === Number(release.code) : String(block.build) === String(release.build));
  if (!same) return { doc, updated: false };
  const device = { ...block.device, ...change };
  validateDevice(`${platform}.device`, device);
  const next = { ...doc, [platform]: { ...block, device } };
  return { doc: validateLatest(next), updated: true };
}

// The newest published Android code and iOS release, for the plan's downgrade check.
export function publishedFloor(doc) {
  return {
    android: doc?.android ? { version: doc.android.version, code: doc.android.code } : null,
    ios: doc?.ios ? { version: doc.ios.version, build: doc.ios.build } : null,
  };
}
