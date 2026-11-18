// Read, diff and write an app's App Store listing through the App Store Connect API (TOLT-153).
//
//   node tools/listing.mjs pull <app-repo-dir>             snapshot the listing into store/apple/listing.json
//   node tools/listing.mjs push <app-repo-dir> [--apply]   print a field-by-field diff; --apply writes it, then reads it back
//
// The app is found from the hub policy: the repo's `owner/name` (from its git remote, or --repo) names an apps entry,
// and its ios.store_bundle (else ios.bundle) is the App Store bundle id. Screenshots are PNGs under
// store/apple/screenshots/<DISPLAY_TYPE>/ (kept out of git; the app's own script makes them). Keys come from 1Password at call
// time; HUB_ASC_KEY=admin picks the Admin key. This never touches builds, TestFlight, pricing or review submission.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ascClient, opRead } from './ci/lib/asc.mjs';
import {
  categoryKeys, checkScreenshots, desiredState, diffState, formatChange, md5, parseListing, planCalls,
  repoFromRemote, resolveRefs, screenshotDiff, snapshotToListing, storeBundleFor,
} from './ci/lib/listing.mjs';
import { loadPolicy } from './ci/lib/policy.mjs';

const editable = ['PREPARE_FOR_SUBMISSION', 'DEVELOPER_REJECTED', 'REJECTED', 'METADATA_REJECTED', 'INVALID_BINARY'];
const sleep = ms => new Promise(r => setTimeout(r, ms));
const attrs = r => r?.attributes ?? {};

// Everything the listing covers, read back from App Store Connect, in the shape the diff reads.
export async function readActual(client, bundle, { versionString, locale }) {
  const found = await client.get(`/v1/apps?filter[bundleId]=${encodeURIComponent(bundle)}&fields[apps]=name,bundleId,contentRightsDeclaration`);
  const app = found.data[0];
  if (!app) throw new Error(`no App Store Connect app has bundle id ${bundle}`);
  const versions = (await client.get(`/v1/apps/${app.id}/appStoreVersions?filter[platform]=IOS&limit=20`)).data;
  const version = versions.find(v => versionString ? attrs(v).versionString === versionString : editable.includes(attrs(v).appStoreState));
  if (!version) throw new Error(`no iOS version ${versionString ?? '(editable)'} on ${bundle}`);
  if (!editable.includes(attrs(version).appStoreState)) throw new Error(`iOS version ${attrs(version).versionString} is ${attrs(version).appStoreState}; its listing is not editable`);
  const infos = (await client.get(`/v1/apps/${app.id}/appInfos`)).data;
  const infoRef = infos.find(i => editable.includes(attrs(i).state ?? attrs(i).appStoreState)) ?? infos[0];
  const info = (await client.get(`/v1/appInfos/${infoRef.id}?include=${categoryKeys.join(',')}`)).data;
  const infoLoc = (await client.get(`/v1/appInfos/${infoRef.id}/appInfoLocalizations`)).data.find(l => attrs(l).locale === locale);
  const verLoc = (await client.get(`/v1/appStoreVersions/${version.id}/appStoreVersionLocalizations`)).data.find(l => attrs(l).locale === locale);
  const age = (await client.get(`/v1/appInfos/${infoRef.id}/ageRatingDeclaration`)).data;
  const review = (await client.get(`/v1/appStoreVersions/${version.id}/appStoreReviewDetail`)).data;
  const builds = (await client.get(`/v1/builds?filter[app]=${app.id}&sort=-uploadedDate&limit=1&fields[builds]=version,usesNonExemptEncryption`)).data;
  const state = {
    app: { contentRights: attrs(app).contentRightsDeclaration },
    info: Object.fromEntries(categoryKeys.map(k => [k, info.relationships?.[k]?.data?.id ?? null])),
    infoLocalization: attrs(infoLoc),
    version: { versionString: attrs(version).versionString, copyright: attrs(version).copyright },
    versionLocalization: attrs(verLoc),
    review: attrs(review),
    ageRating: attrs(age),
  };
  const ids = { app: app.id, info: infoRef.id, infoLocalization: infoLoc?.id, version: version.id, versionLocalization: verLoc?.id, ageRating: age.id, review: review?.id, locale };
  return { state, ids, latestBuild: builds[0] ? { version: attrs(builds[0]).version, usesNonExemptEncryption: attrs(builds[0]).usesNonExemptEncryption } : null };
}

// The screenshot sets of the version's localization: {displayType: {id, shots: [{id, md5, fileName}]}}.
export async function readScreenshots(client, localizationId) {
  if (!localizationId) return {};
  const body = await client.get(`/v1/appStoreVersionLocalizations/${localizationId}/appScreenshotSets?include=appScreenshots&limit[appScreenshots]=50`);
  const shots = Object.fromEntries((body.included ?? []).map(s => [s.id, s]));
  return Object.fromEntries(body.data.map(set => [attrs(set).screenshotDisplayType, {
    id: set.id,
    shots: (set.relationships?.appScreenshots?.data ?? []).map(r => ({ id: r.id, md5: attrs(shots[r.id]).sourceFileChecksum, fileName: attrs(shots[r.id]).fileName })),
  }]));
}

export function localScreenshots(dir) {
  const out = {};
  if (!existsSync(dir)) return out;
  for (const type of readdirSync(dir).sort()) {
    const folder = join(dir, type);
    const names = readdirSync(folder).filter(n => n.endsWith('.png')).sort();
    if (names.length) out[type] = names.map(name => { const bytes = readFileSync(join(folder, name)); return { name, bytes, md5: md5(bytes) }; });
  }
  return out;
}

async function uploadScreenshot(client, setId, { name, bytes, md5: sum }) {
  const made = (await client.post('/v1/appScreenshots', { data: { type: 'appScreenshots', attributes: { fileName: name, fileSize: bytes.length }, relationships: { appScreenshotSet: { data: { type: 'appScreenshotSets', id: setId } } } } })).data;
  await client.putParts(made.attributes.uploadOperations, bytes);
  await client.patch(`/v1/appScreenshots/${made.id}`, { data: { type: 'appScreenshots', id: made.id, attributes: { uploaded: true, sourceFileChecksum: sum } } });
  for (let i = 0; i < 40; i++) {
    const state = attrs((await client.get(`/v1/appScreenshots/${made.id}`)).data).assetDeliveryState;
    if (state?.state === 'COMPLETE') return made.id;
    if (state?.state === 'FAILED') throw new Error(`Apple rejected ${name}: ${(state.errors ?? []).map(e => e.description).join('; ')}`);
    await sleep(1500);
  }
  throw new Error(`${name} did not finish processing in time`);
}

export async function applyScreenshots(client, localizationId, local, remote, types, log = console.log) {
  for (const { type } of types) {
    let set = remote[type];
    if (!set) {
      const made = (await client.post('/v1/appScreenshotSets', { data: { type: 'appScreenshotSets', attributes: { screenshotDisplayType: type }, relationships: { appStoreVersionLocalization: { data: { type: 'appStoreVersionLocalizations', id: localizationId } } } } })).data;
      set = { id: made.id, shots: [] };
    }
    for (const shot of set.shots) await client.delete(`/v1/appScreenshots/${shot.id}`);
    const ids = [];
    for (const file of local[type]) { ids.push(await uploadScreenshot(client, set.id, file)); log(`  uploaded ${type}/${file.name}`); }
    await client.patch(`/v1/appScreenshotSets/${set.id}/relationships/appScreenshots`, { data: ids.map(id => ({ type: 'appScreenshots', id })) });
  }
}

function appContext(dir, repoFlag) {
  const root = resolve(dir);
  const repo = repoFlag ?? repoFromRemote(execFileSync('git', ['-C', root, 'remote', 'get-url', 'origin'], { encoding: 'utf8' }));
  const bundle = storeBundleFor(loadPolicy().policy, repo);
  const file = join(root, 'store/apple/listing.json');
  return { root, repo, bundle, file, shots: join(root, 'store/apple/screenshots') };
}

const readFileOrNull = file => (existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null);

export async function pull({ dir, repo, client = ascClient(), log = console.log }) {
  const ctx = appContext(dir, repo);
  const previous = readFileOrNull(ctx.file) ?? {};
  const locale = previous.locale ?? 'en-US';
  const { state, latestBuild } = await readActual(client, ctx.bundle, { versionString: previous.version?.versionString, locale });
  const file = snapshotToListing(state, { locale, previous });
  parseListing(file);
  mkdirSync(join(ctx.root, 'store/apple'), { recursive: true });
  writeFileSync(ctx.file, `${JSON.stringify(file, null, 2)}\n`);
  log(`wrote ${ctx.file} from ${ctx.bundle} (latest build ${latestBuild?.version ?? 'none'}, usesNonExemptEncryption=${latestBuild?.usesNonExemptEncryption ?? 'unknown'})`);
  return file;
}

export async function push({ dir, repo, apply = false, screenshots, client = ascClient(), read = opRead, log = console.log }) {
  const ctx = appContext(dir, repo);
  const file = parseListing(readFileSync(ctx.file, 'utf8'));
  const desired = desiredState(resolveRefs(file, read));
  const actual = await readActual(client, ctx.bundle, { versionString: file.version?.versionString, locale: file.locale });
  const changes = diffState(desired, actual.state);

  const local = localScreenshots(screenshots ?? ctx.shots);
  const problems = checkScreenshots(local);
  if (problems.length) throw new Error(`screenshots: ${problems.join('; ')}`);
  const remote = Object.keys(local).length ? await readScreenshots(client, actual.ids.versionLocalization) : {};
  const shotChanges = screenshotDiff(local, remote);

  log(`${ctx.repo} -> ${ctx.bundle} (iOS ${actual.state.version.versionString}, ${file.locale})`);
  for (const change of changes) log(`  ${formatChange(change)}`);
  for (const s of shotChanges) log(`  screenshots.${s.type}: ${s.from} -> ${s.to}${s.replace ? ' (replace)' : ''}`);
  if (file.exportCompliance && actual.latestBuild && actual.latestBuild.usesNonExemptEncryption !== file.exportCompliance.usesNonExemptEncryption) log(`  CHECK exportCompliance: build ${actual.latestBuild.version} says usesNonExemptEncryption=${actual.latestBuild.usesNonExemptEncryption}, listing says ${file.exportCompliance.usesNonExemptEncryption} (the tool never edits builds)`);
  if (!changes.length && !shotChanges.length) { log('listing already matches; nothing to write'); return { changes, applied: false, clean: true }; }
  if (!apply) { log('dry run: pass --apply to write'); return { changes, applied: false, clean: false }; }

  if (!actual.ids.versionLocalization && shotChanges.length && !changes.some(c => c.group === 'versionLocalization')) throw new Error('the version has no localization to attach screenshots to');
  const calls = planCalls(changes, actual.ids);
  for (const call of calls) {
    const result = await (call.method === 'POST' ? client.post(call.path, call.body) : client.patch(call.path, call.body));
    if (call.method === 'POST' && call.path.endsWith('appStoreVersionLocalizations')) actual.ids.versionLocalization = result.data.id;
    log(`  wrote ${call.label}`);
  }
  if (shotChanges.length) await applyScreenshots(client, actual.ids.versionLocalization, local, remote, shotChanges, log);

  const after = await readActual(client, ctx.bundle, { versionString: file.version?.versionString, locale: file.locale });
  const left = diffState(desired, after.state);
  const shotsLeft = screenshotDiff(local, Object.keys(local).length ? await readScreenshots(client, after.ids.versionLocalization) : {});
  if (left.length || shotsLeft.length) {
    for (const c of left) log(`  STILL DIFFERENT ${formatChange(c)}`);
    for (const s of shotsLeft) log(`  STILL DIFFERENT screenshots.${s.type}`);
    throw new Error('readback does not match the listing');
  }
  log(`verified: ${changes.length} field(s) and ${shotChanges.length} screenshot set(s) read back equal`);
  return { changes, applied: true, clean: true };
}

function parseArgs(argv) {
  const [cmd, dir, ...rest] = argv;
  const flags = { apply: false };
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--apply') flags.apply = true;
    else if (rest[i] === '--repo') flags.repo = rest[++i];
    else if (rest[i] === '--screenshots') flags.screenshots = resolve(rest[++i]);
    else throw new Error(`unknown argument ${rest[i]}`);
  }
  return { cmd, dir, ...flags };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (!['pull', 'push'].includes(args.cmd) || !args.dir) throw new Error('usage: node tools/listing.mjs pull|push <app-repo-dir> [--apply] [--repo owner/name] [--screenshots dir]');
    if (args.cmd === 'pull') await pull(args); else await push(args);
  } catch (error) { console.error(`listing: ${error.message}`); process.exit(1); }
}
