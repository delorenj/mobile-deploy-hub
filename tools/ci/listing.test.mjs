// The listing tool: parse, diff, plan and the push flow against a fake App Store Connect. No network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, verify } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { token, ascClient } from './lib/asc.mjs';
import {
  ageRatingQuestions, checkScreenshots, desiredState, diffState, formatChange, md5, normalizeField, parseListing, planCalls,
  pngSize, repoFromRemote, resolveRefs, screenshotDiff, snapshotToListing, storeBundleFor,
} from './lib/listing.mjs';
import { loadPolicy } from './lib/policy.mjs';
import { pull, push } from '../listing.mjs';

const allNo = Object.fromEntries(Object.entries(ageRatingQuestions).map(([k, v]) => [k, v.includes('true') ? false : v[0]]));
const base = (change = f => f) => change({
  schema: 1, locale: 'en-US',
  app: { contentRights: 'DOES_NOT_USE_THIRD_PARTY_CONTENT' },
  info: { primaryCategory: 'GAMES', primarySubcategoryOne: 'GAMES_FAMILY', secondaryCategory: null },
  infoLocalization: { name: 'Example Game', subtitle: 'A short line', privacyPolicyUrl: 'https://example.com/privacy' },
  version: { versionString: '1.0', copyright: '2026 Example Studio' },
  versionLocalization: { description: 'Plain text.', keywords: 'one,two', supportUrl: 'https://example.com/support', promotionalText: 'Promo' },
  review: { contactFirstName: 'A', contactPhone: 'op://v/i/phone', demoAccountRequired: false, notes: 'No login.' },
  ageRating: { ...allNo, kidsAgeBand: 'FIVE_AND_UNDER' },
  exportCompliance: { usesNonExemptEncryption: false },
});

test('parseListing accepts a complete file and names the first problem in a bad one', () => {
  assert.ok(parseListing(JSON.stringify(base())));
  const bad = (change, pattern) => assert.throws(() => parseListing(base(change)), pattern);
  bad(f => { f.infoLocalization.name = 'x'.repeat(31); return f; }, /name is 31 characters; the limit is 30/);
  bad(f => { f.versionLocalization.promotionalText = 'x'.repeat(171); return f; }, /promotionalText is 171/);
  bad(f => { f.versionLocalization.keywords = 'one, two'; return f; }, /no space after a comma/);
  bad(f => { f.versionLocalization.supportUrl = 'http://example.com'; return f; }, /https URL/);
  bad(f => { delete f.ageRating.gambling; return f; }, /ageRating.gambling is not answered/);
  bad(f => { f.ageRating.violenceRealistic = 'LOTS'; return f; }, /violenceRealistic must be one of/);
  bad(f => { f.app.contentRights = 'MAYBE'; return f; }, /contentRights/);
  bad(f => { f.surprise = 1; return f; }, /unknown key "surprise"/);
  bad(f => { f.review.contactSecret = 'x'; return f; }, /not a field the tool manages/);
  bad(f => { f.exportCompliance = { usesNonExemptEncryption: 'no' }; return f; }, /exportCompliance/);
});

test('op:// references resolve at push time and a phone becomes +digits', () => {
  const resolved = resolveRefs(base(), ref => { assert.equal(ref, 'op://v/i/phone'); return '1 (555) 123-4567\n'; });
  assert.equal(resolved.review.contactPhone, '+15551234567');
  assert.equal(normalizeField('contactEmail', 'a@b.c'), 'a@b.c');
  assert.equal(normalizeField('contactPhone', '(215) 555-0100'), '+12155550100');
  assert.equal(normalizeField('contactPhone', '+44 20 7946 0000'), '+442079460000');
});

test('desiredState turns bool answers into booleans and keeps null as a clear', () => {
  const d = desiredState(base());
  assert.equal(d.ageRating.gambling, false);
  assert.equal(d.info.secondaryCategory, null);
  assert.equal(d.review.demoAccountRequired, false);
});

test('diffState reports only fields that differ, treats null and empty as the same, and hides passwords', () => {
  const desired = desiredState(base());
  const actual = {
    app: { contentRights: 'DOES_NOT_USE_THIRD_PARTY_CONTENT' },
    info: { primaryCategory: 'GAMES', primarySubcategoryOne: null, secondaryCategory: null },
    infoLocalization: { name: 'Example Game', subtitle: 'Old', privacyPolicyUrl: null },
    version: { versionString: '1.0', copyright: null },
    versionLocalization: { description: 'Plain text.', keywords: null, supportUrl: '', promotionalText: 'Promo' },
    review: {}, ageRating: { ...allNo, advertising: true, kidsAgeBand: 'FIVE_AND_UNDER' },
  };
  const fields = diffState(desired, actual).map(c => `${c.group}.${c.field}`);
  assert.deepEqual(fields, ['info.primarySubcategoryOne', 'infoLocalization.subtitle', 'infoLocalization.privacyPolicyUrl', 'version.copyright',
    'versionLocalization.keywords', 'versionLocalization.supportUrl', 'review.contactFirstName', 'review.contactPhone', 'review.demoAccountRequired', 'review.notes', 'ageRating.advertising']);
  assert.equal(formatChange({ group: 'review', field: 'contactPhone', from: '+1', to: '+2' }), 'review.contactPhone: set -> (hidden)');
  assert.equal(formatChange({ group: 'review', field: 'demoAccountPassword', from: null, to: 'hunter2' }), 'review.demoAccountPassword: empty -> (hidden)');
  assert.deepEqual(diffState(desired, { ...actual, ...Object.fromEntries(Object.entries(desired).map(([g, f]) => [g, f])) }), []);
});

test('planCalls patches existing resources and creates missing ones', () => {
  const changes = diffState(desiredState(base()), { app: {}, info: {}, infoLocalization: {}, version: { versionString: '1.0' }, versionLocalization: {}, review: {}, ageRating: {} });
  const calls = planCalls(changes, { app: 'A', info: 'I', infoLocalization: 'IL', version: 'V', versionLocalization: null, ageRating: 'AR', review: null, locale: 'en-US' });
  const by = label => calls.find(c => c.label === label);
  assert.equal(by('content rights').path, '/v1/apps/A');
  assert.equal(by('content rights').body.data.attributes.contentRightsDeclaration, 'DOES_NOT_USE_THIRD_PARTY_CONTENT');
  assert.deepEqual(by('categories').body.data.relationships.primaryCategory, { data: { type: 'appCategories', id: 'GAMES' } });
  assert.equal(by('app name and privacy URL').method, 'PATCH');
  assert.equal(by('version').body.data.attributes.versionString, undefined, 'the version string is the key, never an edit');
  assert.equal(by('store text').method, 'POST');
  assert.equal(by('store text').body.data.relationships.appStoreVersion.data.id, 'V');
  assert.equal(by('review contact and notes').method, 'POST');
  assert.equal(by('age rating').path, '/v1/ageRatingDeclarations/AR');
});

// A PNG header with a size, enough for the size check.
const png = (w, h, tail = 'x') => { const b = Buffer.alloc(33); b.writeUInt32BE(0x89504e47, 0); b.write('IHDR', 12, 'ascii'); b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20); return Buffer.concat([b, Buffer.from(tail)]); };

test('screenshots: sizes are checked locally and the diff is by checksum and order', () => {
  assert.deepEqual(pngSize(png(1290, 2796)), { width: 1290, height: 2796 });
  assert.equal(pngSize(Buffer.from('not a png at all, just some text here')), null);
  assert.deepEqual(checkScreenshots({ APP_IPHONE_67: [{ name: 'a.png', bytes: png(1290, 2796) }], APP_IPAD_PRO_3GEN_129: [{ name: 'b.png', bytes: png(2064, 2752) }] }), []);
  assert.match(checkScreenshots({ APP_IPHONE_67: [{ name: 'a.png', bytes: png(1242, 2688) }] })[0], /1242x2688; APP_IPHONE_67 takes 1290x2796 or 1320x2868/);
  assert.match(checkScreenshots({ APP_TV: [] })[0], /not a display type/);
  const local = { APP_IPHONE_67: [{ name: 'a', md5: '1' }, { name: 'b', md5: '2' }] };
  assert.deepEqual(screenshotDiff(local, { APP_IPHONE_67: { id: 's', shots: [{ id: 'x', md5: '1' }, { id: 'y', md5: '2' }] } }), []);
  assert.deepEqual(screenshotDiff(local, { APP_IPHONE_67: { id: 's', shots: [{ id: 'y', md5: '2' }, { id: 'x', md5: '1' }] } }), [{ type: 'APP_IPHONE_67', from: 2, to: 2, replace: true }]);
  assert.deepEqual(screenshotDiff(local, {}), [{ type: 'APP_IPHONE_67', from: 0, to: 2, replace: false }]);
});

test('snapshotToListing never writes review contact fields and keeps op:// references', () => {
  const actual = { review: { contactFirstName: 'A', contactPhone: '+1555', demoAccountRequired: false, notes: 'n' }, versionLocalization: { description: 'd', keywords: null }, ageRating: allNo };
  const file = snapshotToListing(actual, { locale: 'en-US', previous: { review: { contactPhone: 'op://v/i/phone' }, exportCompliance: { usesNonExemptEncryption: false } } });
  assert.deepEqual(file.review, { contactPhone: 'op://v/i/phone', demoAccountRequired: false, notes: 'n' });
  assert.deepEqual(file.versionLocalization, { description: 'd' });
  assert.ok(parseListing(file));
});

test('the hub policy maps an app repo to its App Store bundle', () => {
  const { policy } = loadPolicy();
  assert.equal(storeBundleFor(policy, 'delorenj/tower-of-lost-things'), 'io.automaticai.towerofdumbthings');
  assert.equal(storeBundleFor(policy, 'delorenj/green-in-between'), 'io.lasertoast.greeninbetween');
  assert.throws(() => storeBundleFor(policy, 'delorenj/earshot'), /no iOS lane/);
  assert.throws(() => storeBundleFor(policy, 'x/y'), /not listed/);
  assert.equal(repoFromRemote('git@github.com:delorenj/gruvato.git\n'), 'delorenj/gruvato');
  assert.equal(repoFromRemote('https://github.com/AutomaticAI-io/navi'), 'AutomaticAI-io/navi');
});

test('token is an ES256 JWT that the matching public key verifies', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwt = token({ id: 'KID', issuer: 'ISS', key: privateKey.export({ type: 'pkcs8', format: 'pem' }) }, 1_000);
  const [h, p, s] = jwt.split('.');
  assert.deepEqual(JSON.parse(Buffer.from(h, 'base64url')), { alg: 'ES256', kid: 'KID', typ: 'JWT' });
  assert.deepEqual(JSON.parse(Buffer.from(p, 'base64url')), { iss: 'ISS', iat: 1000, exp: 2200, aud: 'appstoreconnect-v1' });
  assert.ok(verify('sha256', Buffer.from(`${h}.${p}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(s, 'base64url')));
  assert.throws(() => ascClient({ which: 'nope' }), /HUB_ASC_KEY/);
});

// ---- a fake App Store Connect, enough for push and pull ----
function fakeAsc() {
  const db = {
    app: { id: 'APP', attributes: { name: 'Example', bundleId: 'io.automaticai.towerofdumbthings', contentRightsDeclaration: null } },
    version: { id: 'VER', attributes: { versionString: '1.0', platform: 'IOS', appStoreState: 'PREPARE_FOR_SUBMISSION', copyright: null } },
    info: { id: 'INFO', attributes: { state: 'PREPARE_FOR_SUBMISSION' }, cats: { primaryCategory: 'GAMES' } },
    infoLoc: { id: 'IL', attributes: { locale: 'en-US', name: 'Example Game', subtitle: null, privacyPolicyUrl: null } },
    verLoc: { id: 'VL', attributes: { locale: 'en-US', description: null, keywords: null, supportUrl: null, promotionalText: null, marketingUrl: null, whatsNew: null } },
    age: { id: 'AGE', attributes: { ...allNo, advertising: true } },
    review: null, sets: {}, shots: {}, writes: [],
  };
  let n = 0;
  const data = r => ({ type: 'x', id: r.id, attributes: r.attributes });
  const client = {
    async get(path) {
      const [p] = path.split('?');
      if (p === '/v1/apps') return { data: [data(db.app)] };
      if (p === '/v1/apps/APP/appStoreVersions') return { data: [data(db.version)] };
      if (p === '/v1/apps/APP/appInfos') return { data: [data(db.info)] };
      if (p === '/v1/appInfos/INFO') return { data: { id: 'INFO', relationships: Object.fromEntries(Object.entries(db.info.cats).map(([k, v]) => [k, { data: v ? { id: v } : null }])) } };
      if (p === '/v1/appInfos/INFO/appInfoLocalizations') return { data: [data(db.infoLoc)] };
      if (p === '/v1/appStoreVersions/VER/appStoreVersionLocalizations') return { data: [data(db.verLoc)] };
      if (p === '/v1/appInfos/INFO/ageRatingDeclaration') return { data: data(db.age) };
      if (p === '/v1/appStoreVersions/VER/appStoreReviewDetail') return { data: db.review ? data(db.review) : null };
      if (p === '/v1/builds') return { data: [{ id: 'B', attributes: { version: '11', usesNonExemptEncryption: false } }] };
      if (p === '/v1/appStoreVersionLocalizations/VL/appScreenshotSets') {
        const sets = Object.values(db.sets);
        return { data: sets.map(s => ({ id: s.id, attributes: { screenshotDisplayType: s.type }, relationships: { appScreenshots: { data: s.shots.map(id => ({ id })) } } })), included: sets.flatMap(s => s.shots.map(id => ({ id, attributes: db.shots[id] }))) };
      }
      const shot = /^\/v1\/appScreenshots\/(.+)$/.exec(p);
      if (shot) return { data: { id: shot[1], attributes: { assetDeliveryState: { state: 'COMPLETE' } } } };
      throw new Error(`fake: GET ${path}`);
    },
    async patch(path, body) {
      db.writes.push(`PATCH ${path}`);
      const d = body.data;
      const target = { '/v1/apps/APP': db.app, '/v1/appStoreVersions/VER': db.version, '/v1/appInfoLocalizations/IL': db.infoLoc, '/v1/appStoreVersionLocalizations/VL': db.verLoc, '/v1/ageRatingDeclarations/AGE': db.age }[path];
      if (target) Object.assign(target.attributes, d.attributes);
      else if (path === '/v1/appInfos/INFO') for (const [k, v] of Object.entries(d.relationships)) db.info.cats[k] = v.data?.id ?? null;
      else if (/relationships\/appScreenshots$/.test(path)) { const set = Object.values(db.sets).find(s => path.includes(s.id)); set.shots = d.map(x => x.id); }
      else if (/^\/v1\/appScreenshots\//.test(path)) db.shots[d.id].sourceFileChecksum = d.attributes.sourceFileChecksum;
      else throw new Error(`fake: PATCH ${path}`);
      return { data: d };
    },
    async post(path, body) {
      db.writes.push(`POST ${path}`);
      const d = body.data;
      if (path === '/v1/appStoreReviewDetails') { db.review = { id: 'REV', attributes: d.attributes }; return { data: { id: 'REV' } }; }
      if (path === '/v1/appScreenshotSets') { const id = `SET${++n}`; db.sets[id] = { id, type: d.attributes.screenshotDisplayType, shots: [] }; return { data: { id } }; }
      if (path === '/v1/appScreenshots') {
        const id = `SH${++n}`; db.shots[id] = { fileName: d.attributes.fileName };
        db.sets[d.relationships.appScreenshotSet.data.id].shots.push(id);
        return { data: { id, attributes: { uploadOperations: [] } } };
      }
      throw new Error(`fake: POST ${path}`);
    },
    async delete(path) { db.writes.push(`DELETE ${path}`); const id = path.split('/').pop(); delete db.shots[id]; for (const s of Object.values(db.sets)) s.shots = s.shots.filter(x => x !== id); },
    async putParts() {},
  };
  return { db, client };
}

function appDir({ shots = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'listing-test-'));
  mkdirSync(join(dir, 'store/apple'), { recursive: true });
  writeFileSync(join(dir, 'store/apple/listing.json'), JSON.stringify(base(f => { f.info.primarySubcategoryOne = 'GAMES_FAMILY'; return f; })));
  if (shots) { mkdirSync(join(dir, 'store/apple/screenshots/APP_IPHONE_67'), { recursive: true }); writeFileSync(join(dir, 'store/apple/screenshots/APP_IPHONE_67/01.png'), png(1290, 2796)); writeFileSync(join(dir, 'store/apple/screenshots/APP_IPHONE_67/02.png'), png(1290, 2796, 'y')); }
  return dir;
}
const quiet = () => { const lines = []; return { lines, log: line => lines.push(line) }; };
const repo = 'delorenj/tower-of-lost-things';
const read = ref => { assert.equal(ref, 'op://v/i/phone'); return '1 (555) 123-4567'; };

test('push without --apply prints the diff and writes nothing', async () => {
  const { db, client } = fakeAsc();
  const out = quiet();
  const result = await push({ dir: appDir(), repo, client, read, log: out.log });
  assert.equal(result.applied, false);
  assert.deepEqual(db.writes, []);
  assert.ok(out.lines.some(l => l.includes('ageRating.advertising: true -> false')));
  assert.ok(out.lines.some(l => l.includes('dry run')));
});

test('push --apply writes the listing, reads it back equal, and a second push is a no-op', async () => {
  const { db, client } = fakeAsc();
  const dir = appDir({ shots: true });
  const out = quiet();
  const result = await push({ dir, repo, apply: true, client, read, log: out.log });
  assert.equal(result.clean, true);
  assert.equal(db.app.attributes.contentRightsDeclaration, 'DOES_NOT_USE_THIRD_PARTY_CONTENT');
  assert.equal(db.age.attributes.advertising, false);
  assert.equal(db.review.attributes.contactPhone, '+15551234567');
  assert.equal(db.info.cats.primarySubcategoryOne, 'GAMES_FAMILY');
  assert.equal(Object.values(db.sets)[0].shots.length, 2);
  assert.ok(out.lines.some(l => l.startsWith('verified:')));
  const before = db.writes.length;
  const again = quiet();
  const second = await push({ dir, repo, apply: true, client, read, log: again.log });
  assert.equal(second.clean, true);
  assert.equal(db.writes.length, before, 'idempotent: no write on the second run');
  assert.ok(again.lines.some(l => l.includes('nothing to write')));
});

test('push refuses a screenshot of the wrong size before any call', async () => {
  const { db, client } = fakeAsc();
  const dir = appDir({ shots: true });
  writeFileSync(join(dir, 'store/apple/screenshots/APP_IPHONE_67/03.png'), png(100, 100));
  await assert.rejects(push({ dir, repo, apply: true, client, read, log: () => {} }), /03.png is 100x100/);
  assert.deepEqual(db.writes, []);
});

test('pull writes a listing without the contact fields and keeps the op:// phone', async () => {
  const { client } = fakeAsc();
  const dir = appDir();
  await push({ dir, repo, apply: true, client, read, log: () => {} });
  const file = await pull({ dir, repo, client, log: () => {} });
  assert.equal(file.review.contactPhone, 'op://v/i/phone');
  assert.equal(file.review.contactFirstName, undefined);
  assert.equal(file.ageRating.advertising, false);
  assert.equal(JSON.parse(readFileSync(join(dir, 'store/apple/listing.json'), 'utf8')).locale, 'en-US');
  assert.ok(md5(Buffer.from('a')).length === 32);
});
