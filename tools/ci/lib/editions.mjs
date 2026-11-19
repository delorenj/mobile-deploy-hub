// Extra signed Android editions (MOBI-14, docs/multi-edition-android.md): where an edition's APK is staged and
// published, the pointer a public edition keeps, and its retention. The device edition (the manifest's top-level
// android block) keeps every pre-MOBI-14 path: latest.json, the app page, Quickdrop and the catch-up know nothing else.
//
// An extra edition lives in its own folder, so it can never reach the device edition's keys, history or catch-up:
//   staging   <run staging>/android/editions/<edition>/<slug>-<edition>-<X.Y.Z>-<code>.apk
//   public    builds/<slug>/editions/<edition>/<X.Y.Z>/<slug>-<edition>-<X.Y.Z>-<code>.apk   (+ .apk.sha256, receipt.json)
//             builds/<slug>/editions/<edition>/latest.json   the current version, for scripts
//             builds/<slug>/editions/<edition>/index.html    one APK link and its checksum, for Obtainium and people
// Only an edition the policy marks public AND the manifest opts in (android.editions.<name>.public) is ever written to
// the bucket; any other edition stays in staging and the private Release.
import { compareRelease, describeRelease, publicUrl } from './latest.mjs';

const slugPattern = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
const editionPattern = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const semverPattern = /^(\d+)\.(\d+)\.(\d+)$/;
const sha256Pattern = /^[0-9a-f]{64}$/;
const packagePattern = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/;
const isoPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const httpsUrl = /^https:\/\/[^\s"<>]+$/;

export const editionLane = name => `android-edition-${name}`;
export const isEditionLane = lane => /^android-edition-/.test(lane ?? '');

function checkParts(slug, edition, version) {
  if (!slugPattern.test(slug ?? '')) throw new Error(`bad slug "${slug}"`);
  if (!editionPattern.test(edition ?? '') || edition.length > 32) throw new Error(`bad edition "${edition}"`);
  if (version !== undefined && !semverPattern.test(version ?? '')) throw new Error(`bad version "${version}"`);
}

export const editionApkName = (slug, edition, version, code) => {
  checkParts(slug, edition, version);
  if (!/^\d+$/.test(String(code ?? ''))) throw new Error(`bad versionCode "${code}"`);
  return `${slug}-${edition}-${version}-${code}.apk`;
};
export const editionPrefix = (slug, edition) => { checkParts(slug, edition); return `${slug}/editions/${edition}/`; };
export const editionVersionKey = (slug, edition, version, file) => {
  checkParts(slug, edition, version);
  if (!/^[A-Za-z0-9._-]+$/.test(file ?? '') || file.startsWith('.')) throw new Error(`bad file name "${file}"`);
  return `${editionPrefix(slug, edition)}${version}/${file}`;
};
export const editionApkKey = (slug, edition, version, code) => editionVersionKey(slug, edition, version, editionApkName(slug, edition, version, code));
export const editionShaKey = (slug, edition, version, code) => `${editionApkKey(slug, edition, version, code)}.sha256`;
export const editionReceiptKey = (slug, edition, version) => editionVersionKey(slug, edition, version, 'receipt.json');
export const editionLatestKey = (slug, edition) => `${editionPrefix(slug, edition)}latest.json`;
export const editionPageKey = (slug, edition) => `${editionPrefix(slug, edition)}index.html`;

// The checksum file, in sha256sum's own format, so `sha256sum -c` verifies a download next to it.
export const checksumLine = (sha256, name) => `${sha256}  ${name}\n`;

// Whether an edition is published anonymously: the app asks (the manifest's public block) AND the policy allows it.
export const isPublicEdition = (spec, pin) => Boolean(spec?.public) && pin?.public === true;

// ---------------------------------------------------------------------------------------------------- the pointer

const fail = message => { throw new Error(`edition latest.json: ${message}`); };
const pointerKeys = ['schema', 'slug', 'app', 'edition', 'title', 'package', 'version', 'code', 'key', 'url', 'bytes', 'sha256', 'sha256_url', 'signer_sha256', 'commit', 'run', 'correlation', 'updated_at'];

function textOf(where, value, { max = 300, pattern } = {}) {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) fail(`${where} must be a string of 1 to ${max} characters`);
  if (pattern && !pattern.test(value)) fail(`${where} is malformed: ${JSON.stringify(value.slice(0, 80))}`);
}

export function validateEditionPointer(doc, { base, slug, edition } = {}) {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) fail('must be an object');
  for (const key of Object.keys(doc)) if (!pointerKeys.includes(key)) fail(`unknown key "${key}"`);
  for (const key of pointerKeys) if (!(key in doc)) fail(`${key} is required`);
  if (doc.schema !== 1) fail('schema must be 1');
  textOf('slug', doc.slug, { max: 80, pattern: slugPattern });
  if (slug && doc.slug !== slug) fail(`slug is ${doc.slug}, expected ${slug}`);
  textOf('edition', doc.edition, { max: 32, pattern: editionPattern });
  if (edition && doc.edition !== edition) fail(`edition is ${doc.edition}, expected ${edition}`);
  textOf('app', doc.app, { max: 120 });
  textOf('title', doc.title, { max: 80 });
  textOf('package', doc.package, { max: 200, pattern: packagePattern });
  textOf('version', doc.version, { pattern: semverPattern });
  if (!Number.isSafeInteger(doc.code) || doc.code < 1) fail('code must be a whole number >= 1');
  if (doc.key !== editionApkKey(doc.slug, doc.edition, doc.version, doc.code)) fail('key must name this release\'s edition APK');
  textOf('url', doc.url, { max: 600, pattern: httpsUrl });
  textOf('sha256_url', doc.sha256_url, { max: 620, pattern: httpsUrl });
  if (base && doc.url !== publicUrl(base, doc.key)) fail('url must be the public URL of key');
  if (base && doc.sha256_url !== publicUrl(base, `${doc.key}.sha256`)) fail('sha256_url must be the public URL of the checksum file');
  if (!Number.isSafeInteger(doc.bytes) || doc.bytes < 1) fail('bytes must be a whole number >= 1');
  textOf('sha256', doc.sha256, { pattern: sha256Pattern });
  textOf('signer_sha256', doc.signer_sha256, { pattern: sha256Pattern });
  textOf('commit', doc.commit, { pattern: /^[0-9a-f]{7,40}$/ });
  if (!doc.run || typeof doc.run !== 'object' || !/^\d{1,20}$/.test(String(doc.run.id ?? ''))) fail('run must name the run that published it');
  textOf('correlation', doc.correlation, { pattern: uuidPattern });
  textOf('updated_at', doc.updated_at, { max: 40, pattern: isoPattern });
  return doc;
}

export function parseEditionPointer(source, options = {}) {
  let doc;
  try { doc = JSON.parse(source); } catch (error) { fail(`not valid JSON (${error.message})`); }
  return validateEditionPointer(doc, options);
}

export const serializeEditionPointer = doc => `${JSON.stringify(validateEditionPointer(doc), null, 2)}\n`;

// Forward only, like latest.json's android block: a greater version (then code) replaces the pointer, and so does the
// same release from the same run or with the same bytes (Re-run failed jobs); anything else keeps it.
export function mayReplaceEdition(current, next) {
  if (!current) return { replace: true, reason: 'no earlier edition build' };
  const order = compareRelease('android', next, current);
  if (order > 0) return { replace: true, reason: `${describeRelease('android', next)} is newer than ${describeRelease('android', current)}` };
  if (order === 0 && (next.sha256 === current.sha256 || String(next.run.id) === String(current.run.id))) return { replace: true, reason: `a rerun of ${describeRelease('android', current)}` };
  return { replace: false, reason: `kept ${describeRelease('android', current)}: ${describeRelease('android', next)} is ${order === 0 ? 'the same release with other bytes from another run' : 'older'}` };
}

// ---------------------------------------------------------------------------------------------------- retention

// The newest keep_apk versions of one edition, and whatever its pointer names, stay; older version folders go. Only
// keys under builds/<slug>/editions/<edition>/ are ever touched (the device edition has its own pruneVersions).
export function pruneEdition({ s3, policy, slug, edition, pointer, listing = null }) {
  const prefix = editionPrefix(slug, edition);
  const objects = (listing ?? s3.list(`${slug}/`)).filter(item => item.key.startsWith(prefix));
  const folderOf = key => key.slice(prefix.length).split('/')[0];
  const versions = [...new Set(objects.map(item => folderOf(item.key)).filter(folder => semverPattern.test(folder)))]
    .sort((a, b) => compareRelease('android', { version: b, code: 0 }, { version: a, code: 0 }));
  const keep = new Set([...versions.slice(0, policy.delivery.s3.keep_apk), pointer?.version].filter(Boolean));
  const removed = [];
  for (const { key } of objects) {
    const folder = folderOf(key);
    if (!semverPattern.test(folder) || keep.has(folder) || key === pointer?.key) continue;
    s3.remove(key);
    removed.push(key);
  }
  return removed;
}
