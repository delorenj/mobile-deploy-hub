// The App Store listing as data (tools/listing.mjs). Pure functions only, no network: parse and check an app's
// store/apple/listing.json, diff it against what App Store Connect holds, and turn the difference into API calls.
// The shape is the same for every hub app, so a new app gets its listing by writing one file.
import { createHash } from 'node:crypto';

const fail = message => { throw new Error(`listing.json: ${message}`); };
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export const levels = Object.freeze(['NONE', 'INFREQUENT_OR_MILD', 'FREQUENT_OR_INTENSE']);
const bool = Object.freeze(['true', 'false']);
// Every age rating question, with its allowed answers. The file must answer all of them: a default left in App Store
// Connect (it ships "advertising: yes") is how a wrong rating gets submitted.
export const ageRatingQuestions = Object.freeze({
  advertising: bool, alcoholTobaccoOrDrugUseOrReferences: levels, contests: levels, gambling: bool, gamblingSimulated: levels,
  gunsOrOtherWeapons: levels, healthOrWellnessTopics: bool, kidsAgeBand: ['FIVE_AND_UNDER', 'SIX_TO_EIGHT', 'NINE_TO_ELEVEN'],
  lootBox: bool, medicalOrTreatmentInformation: levels, messagingAndChat: bool, parentalControls: bool, profanityOrCrudeHumor: levels,
  ageAssurance: bool, sexualContentGraphicAndNudity: levels, sexualContentOrNudity: levels, socialMedia: bool, socialMediaAgeRestricted: bool,
  horrorOrFearThemes: levels, matureOrSuggestiveThemes: levels, unrestrictedWebAccess: bool, userGeneratedContent: bool,
  violenceCartoonOrFantasy: levels, violenceRealisticProlongedGraphicOrSadistic: levels, violenceRealistic: levels,
});

const limits = {
  infoLocalization: { name: 30, subtitle: 30, privacyPolicyUrl: 255 },
  versionLocalization: { description: 4000, keywords: 100, marketingUrl: 255, promotionalText: 170, supportUrl: 255, whatsNew: 4000 },
  version: { copyright: 200 },
  review: { contactFirstName: 100, contactLastName: 100, contactEmail: 255, contactPhone: 40, notes: 4000, demoAccountName: 100, demoAccountPassword: 100 },
};
const urlFields = new Set(['privacyPolicyUrl', 'marketingUrl', 'supportUrl']);
export const categoryKeys = Object.freeze(['primaryCategory', 'primarySubcategoryOne', 'primarySubcategoryTwo', 'secondaryCategory', 'secondarySubcategoryOne', 'secondarySubcategoryTwo']);
export const contentRights = Object.freeze(['DOES_NOT_USE_THIRD_PARTY_CONTENT', 'USES_THIRD_PARTY_CONTENT']);
// Screenshot folders are named for the App Store Connect display type. The sizes are portrait pixels Apple accepts.
export const displayTypes = Object.freeze({
  APP_IPHONE_67: ['1290x2796', '1320x2868'],
  APP_IPAD_PRO_3GEN_129: ['2048x2732', '2064x2752'],
});
export const screenshotMax = 10;

const groups = {
  app: ['contentRights'],
  info: categoryKeys,
  infoLocalization: Object.keys(limits.infoLocalization),
  version: ['versionString', 'copyright'],
  versionLocalization: Object.keys(limits.versionLocalization),
  review: [...Object.keys(limits.review), 'demoAccountRequired'],
  ageRating: Object.keys(ageRatingQuestions),
};

// The `op://` references a file may hold in place of a personal value (a review phone number). They are resolved at push
// time and never written back.
export const isRef = value => typeof value === 'string' && value.startsWith('op://');

export function parseListing(source) {
  let file;
  try { file = typeof source === 'string' ? JSON.parse(source) : source; } catch (error) { fail(`not valid JSON (${error.message})`); }
  if (!isObject(file)) fail('must be an object');
  for (const key of Object.keys(file)) if (!['schema', 'locale', 'exportCompliance', ...Object.keys(groups)].includes(key)) fail(`unknown key "${key}"`);
  if (file.schema !== 1) fail('schema must be 1');
  if (typeof file.locale !== 'string' || !/^[a-z]{2}(-[A-Z][A-Za-z]+)?$/.test(file.locale)) fail('locale must look like en-US');
  for (const [group, keys] of Object.entries(groups)) {
    if (!(group in file)) continue;
    if (!isObject(file[group])) fail(`${group} must be an object`);
    for (const key of Object.keys(file[group])) if (!keys.includes(key)) fail(`${group}.${key} is not a field the tool manages`);
  }
  for (const [group, fields] of Object.entries(limits)) {
    for (const [key, max] of Object.entries(fields)) {
      const value = file[group]?.[key];
      if (value === undefined || isRef(value)) continue;
      if (typeof value !== 'string') fail(`${group}.${key} must be text`);
      if ([...value].length > max) fail(`${group}.${key} is ${[...value].length} characters; the limit is ${max}`);
      if (urlFields.has(key) && !/^https:\/\/[^\s]+$/.test(value)) fail(`${group}.${key} must be an https URL`);
    }
  }
  if (file.app?.contentRights !== undefined && !contentRights.includes(file.app.contentRights)) fail(`app.contentRights must be one of ${contentRights.join(', ')}`);
  for (const key of categoryKeys) {
    const value = file.info?.[key];
    if (value !== undefined && value !== null && !/^[A-Z][A-Z0-9_]+$/.test(value)) fail(`info.${key} must be an App Store category id like GAMES_FAMILY, or null`);
  }
  if (file.version && 'versionString' in file.version && !/^\d+(\.\d+){1,2}$/.test(file.version.versionString)) fail('version.versionString must look like 1.0');
  if (file.versionLocalization?.keywords !== undefined && /,\s/.test(file.versionLocalization.keywords)) fail('versionLocalization.keywords: no space after a comma; the 100 characters are precious');
  if ('ageRating' in file) {
    for (const [question, allowed] of Object.entries(ageRatingQuestions)) {
      if (!(question in file.ageRating)) fail(`ageRating.${question} is not answered; every age rating question needs a deliberate answer`);
      if (!allowed.includes(String(file.ageRating[question]))) fail(`ageRating.${question} must be one of ${allowed.join(', ')}`);
    }
  }
  if (file.review && 'demoAccountRequired' in file.review && typeof file.review.demoAccountRequired !== 'boolean') fail('review.demoAccountRequired must be true or false');
  if (file.exportCompliance !== undefined && (!isObject(file.exportCompliance) || typeof file.exportCompliance.usesNonExemptEncryption !== 'boolean' || Object.keys(file.exportCompliance).length !== 1)) fail('exportCompliance must be {"usesNonExemptEncryption": true|false}');
  return file;
}

// Replaces op:// references with their values. `read` is injected so a test never touches 1Password.
export function resolveRefs(file, read) {
  const out = structuredClone(file);
  for (const group of Object.values(out)) {
    if (!isObject(group)) continue;
    for (const [key, value] of Object.entries(group)) if (isRef(value)) group[key] = normalizeField(key, read(value).trim());
  }
  return out;
}

// A phone number goes to Apple as +<digits>. A bare 10-digit number is read as North American (+1), the way a US
// contact card stores it; any other number must carry its country code.
export function normalizeField(key, value) {
  if (key === 'contactPhone') {
    const digits = value.replace(/\D/g, '');
    if (!digits) return value;
    return `+${digits.length === 10 && !value.trim().startsWith('+') ? `1${digits}` : digits}`;
  }
  return value;
}

// The fields the file sets, as {group: {field: value}}. Absent fields are not managed; null clears.
export function desiredState(file) {
  const out = {};
  for (const group of Object.keys(groups)) if (isObject(file[group])) out[group] = Object.fromEntries(Object.entries(file[group]).map(([k, v]) => [k, v === null ? null : normalizeField(k, v)]));
  if (out.ageRating) out.ageRating = Object.fromEntries(Object.entries(out.ageRating).map(([k, v]) => [k, ageRatingQuestions[k] === bool ? v === true || v === 'true' : v]));
  return out;
}

const same = (a, b) => (a ?? null) === (b ?? null) || (a === '' && b == null) || (a == null && b === '');

// One entry per field whose value differs: {group, field, from, to}.
export function diffState(desired, actual) {
  const changes = [];
  for (const [group, fields] of Object.entries(desired)) {
    for (const [field, to] of Object.entries(fields)) {
      const from = actual[group]?.[field];
      if (!same(from, to)) changes.push({ group, field, from: from ?? null, to });
    }
  }
  return changes;
}

// Personal or secret values never reach a log: the diff says only that they change.
const SECRET_FIELDS = new Set(['demoAccountPassword', 'demoAccountName', 'contactEmail', 'contactPhone']);
const clip = value => { const text = JSON.stringify(value ?? null); return text.length > 70 ? `${text.slice(0, 67)}...` : text; };
export const formatChange = ({ group, field, from, to }) => SECRET_FIELDS.has(field) ? `${group}.${field}: ${from ? 'set' : 'empty'} -> (hidden)` : `${group}.${field}: ${clip(from)} -> ${clip(to)}`;

// The API calls that make `actual` match `changes`. `ids` is what the readback found: app, info, infoLocalization,
// version, versionLocalization, ageRating, review (null when the resource does not exist yet).
export function planCalls(changes, ids) {
  const by = group => Object.fromEntries(changes.filter(c => c.group === group).map(c => [c.field, c.to]));
  const calls = [];
  const attributes = (type, id, attrs, label) => calls.push({ label, method: 'PATCH', path: `/v1/${type}/${id}`, body: { data: { type, id, attributes: attrs } } });
  const app = by('app');
  if ('contentRights' in app) attributes('apps', ids.app, { contentRightsDeclaration: app.contentRights }, 'content rights');
  const info = by('info');
  if (Object.keys(info).length) calls.push({ label: 'categories', method: 'PATCH', path: `/v1/appInfos/${ids.info}`, body: { data: { type: 'appInfos', id: ids.info, relationships: Object.fromEntries(Object.entries(info).map(([k, v]) => [k, { data: v ? { type: 'appCategories', id: v } : null }])) } } });
  const infoLoc = by('infoLocalization');
  if (Object.keys(infoLoc).length) {
    if (ids.infoLocalization) attributes('appInfoLocalizations', ids.infoLocalization, infoLoc, 'app name and privacy URL');
    else calls.push({ label: 'app name and privacy URL', method: 'POST', path: '/v1/appInfoLocalizations', body: { data: { type: 'appInfoLocalizations', attributes: { locale: ids.locale, ...infoLoc }, relationships: { appInfo: { data: { type: 'appInfos', id: ids.info } } } } } });
  }
  const version = by('version');
  delete version.versionString;
  if (Object.keys(version).length) attributes('appStoreVersions', ids.version, version, 'version');
  const verLoc = by('versionLocalization');
  if (Object.keys(verLoc).length) {
    if (ids.versionLocalization) attributes('appStoreVersionLocalizations', ids.versionLocalization, verLoc, 'store text');
    else calls.push({ label: 'store text', method: 'POST', path: '/v1/appStoreVersionLocalizations', body: { data: { type: 'appStoreVersionLocalizations', attributes: { locale: ids.locale, ...verLoc }, relationships: { appStoreVersion: { data: { type: 'appStoreVersions', id: ids.version } } } } } });
  }
  const age = by('ageRating');
  if (Object.keys(age).length) attributes('ageRatingDeclarations', ids.ageRating, age, 'age rating');
  const review = by('review');
  if (Object.keys(review).length) {
    if (ids.review) attributes('appStoreReviewDetails', ids.review, review, 'review contact and notes');
    else calls.push({ label: 'review contact and notes', method: 'POST', path: '/v1/appStoreReviewDetails', body: { data: { type: 'appStoreReviewDetails', attributes: review, relationships: { appStoreVersion: { data: { type: 'appStoreVersions', id: ids.version } } } } } });
  }
  return calls;
}

// ---- screenshots ----

export const md5 = bytes => createHash('md5').update(bytes).digest('hex');

// Width and height of a PNG from its header, or null when it is not one.
export function pngSize(bytes) {
  if (bytes.length < 24 || bytes.readUInt32BE(0) !== 0x89504e47 || bytes.toString('ascii', 12, 16) !== 'IHDR') return null;
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

// files: {APP_IPHONE_67: [{name, bytes}]}. Refuses a size Apple would refuse, so the upload does not find out.
export function checkScreenshots(files) {
  const problems = [];
  for (const [type, list] of Object.entries(files)) {
    if (!displayTypes[type]) { problems.push(`${type} is not a display type this tool knows (${Object.keys(displayTypes).join(', ')})`); continue; }
    if (list.length < 1 || list.length > screenshotMax) problems.push(`${type} has ${list.length} screenshots; Apple takes 1 to ${screenshotMax}`);
    for (const { name, bytes } of list) {
      const size = pngSize(bytes);
      if (!size) problems.push(`${type}/${name} is not a PNG`);
      else if (!displayTypes[type].includes(`${size.width}x${size.height}`)) problems.push(`${type}/${name} is ${size.width}x${size.height}; ${type} takes ${displayTypes[type].join(' or ')}`);
    }
  }
  return problems;
}

// Compare the local files with the sets App Store Connect holds. Same checksums in the same order means nothing to do.
// local: {type: [{name, md5}]}; remote: {type: {id, shots: [{id, md5}]}|undefined}. Returns the types to rebuild.
export function screenshotDiff(local, remote) {
  const out = [];
  for (const [type, list] of Object.entries(local)) {
    const have = remote[type]?.shots ?? [];
    const wantSums = list.map(s => s.md5);
    if (have.length !== wantSums.length || have.some((s, i) => s.md5 !== wantSums[i])) out.push({ type, from: have.length, to: list.length, replace: have.length > 0 });
  }
  return out;
}

// ---- pull: the ASC readback as a listing file ----

// `actual` is the same {group: {field: value}} the diff reads. The review contact fields are personal data, so a pull
// leaves them to the author (an op:// reference), and the age rating is written whole.
export function snapshotToListing(actual, { locale, previous = {} } = {}) {
  const file = { schema: 1, locale };
  for (const [group, keys] of Object.entries(groups)) {
    const values = actual[group];
    if (!values) continue;
    const kept = previous[group] ?? {};
    const out = {};
    for (const key of keys) {
      if (isRef(kept[key])) { out[key] = kept[key]; continue; }
      if (group === 'review' && key.startsWith('contact')) continue;
      if (group === 'review' && key.startsWith('demoAccount') && key !== 'demoAccountRequired') continue;
      const value = values[key];
      if (value === undefined || value === null || value === '') continue;
      out[key] = value;
    }
    if (Object.keys(out).length) file[group] = out;
  }
  if (previous.exportCompliance) file.exportCompliance = previous.exportCompliance;
  return file;
}

// The hub policy entry for an app repo and the App Store bundle id its record carries.
export function storeBundleFor(policy, repo) {
  const app = policy.apps?.[repo];
  if (!app) throw new Error(`${repo} is not listed in the hub policy (tools/ci/policy.json apps)`);
  if (!app.ios) throw new Error(`${repo} has no iOS lane in the hub policy`);
  return app.ios.store_bundle ?? app.ios.bundle;
}

// "owner/name" from a git remote url.
export function repoFromRemote(url) {
  const match = /github\.com[:/]([^/\s]+\/[^/\s]+?)(?:\.git)?\s*$/.exec(url.trim());
  if (!match) throw new Error(`cannot read owner/name from remote ${url}`);
  return match[1];
}
