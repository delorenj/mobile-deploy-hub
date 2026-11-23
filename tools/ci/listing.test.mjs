// The listing tool: parse, diff, plan and the push flow against a fake App Store Connect. No network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, verify } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { token, ascClient } from './lib/asc.mjs';
import {
  ageRatingQuestions, availabilityBody, checkScreenshots, desiredState, diffState, formatChange, md5, normalizeField, parseListing, planCalls,
  pngSize, repoFromRemote, resolveRefs, screenshotDiff, snapshotToListing, storeBundleFor,
} from './lib/listing.mjs';
import { loadPolicy } from './lib/policy.mjs';
import { findPricePoint, pull, push, readAvailability, readPrice } from '../listing.mjs';

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
  assert.equal(storeBundleFor(policy, 'delorenj/tower-of-lost-things'), 'io.lasertoast.tolt');
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
    app: { id: 'APP', attributes: { name: 'Example', bundleId: 'io.lasertoast.tolt', contentRightsDeclaration: null } },
    version: { id: 'VER', attributes: { versionString: '1.0', platform: 'IOS', appStoreState: 'PREPARE_FOR_SUBMISSION', copyright: null } },
    info: { id: 'INFO', attributes: { state: 'PREPARE_FOR_SUBMISSION' }, cats: { primaryCategory: 'GAMES' } },
    infoLoc: { id: 'IL', attributes: { locale: 'en-US', name: 'Example Game', subtitle: null, privacyPolicyUrl: null } },
    verLoc: { id: 'VL', attributes: { locale: 'en-US', description: null, keywords: null, supportUrl: null, promotionalText: null, marketingUrl: null, whatsNew: null } },
    age: { id: 'AGE', attributes: { ...allNo, advertising: true } },
    review: null, sets: {}, shots: {}, writes: [],
    price: null, avail: null, adminWrites: [],
  };
  let n = 0;
  const data = r => ({ type: 'x', id: r.id, attributes: r.attributes });
  const point = (territory, p, customerPrice) => ({ type: 'appPricePoints', id: Buffer.from(JSON.stringify({ s: 'APP', t: territory, p })).toString('base64url'), attributes: { customerPrice } });
  const territoryCodes = ['USA', 'CAN', 'AUS', 'NZL', 'GBR', 'FRA'];
  const notFound = () => Object.assign(new Error('ASC 404'), { status: 404 });
  const build = which => ({
    which,
    async get(path) {
      const [p] = path.split('?');
      if (/appPriceSchedule|appPricePoints|ppAvailab|territoryAvailabilities/.test(p) && which !== 'admin') throw Object.assign(new Error('ASC 403'), { status: 403 });
      if (p === '/v1/apps/APP/appPriceSchedule') { if (!db.price) throw notFound(); return { data: { id: 'SCH', relationships: { baseTerritory: { data: { id: db.price.base } } } } }; }
      if (p === '/v1/appPriceSchedules/SCH/manualPrices') {
        if (!db.price.point) throw notFound();
        const old = { id: 'OLDP', attributes: { startDate: '2020-01-01', endDate: '2021-01-01' }, relationships: { appPricePoint: { data: { id: point(db.price.base, 'old', '9.99').id } } } };
        return { data: [old, { id: 'P1', attributes: { startDate: null, endDate: null }, relationships: { appPricePoint: { data: { id: db.price.point.id } } } }], included: [point(db.price.base, 'old', '9.99'), db.price.point] };
      }
      if (p === '/v1/apps/APP/appPricePoints') {
        const t = /filter\[territory\]=(\w+)/.exec(path)?.[1] ?? 'USA';
        if (path.includes('page=2')) return { data: [point(t, '10599', '0.99'), point(t, '10600', '4.99')] };
        return { data: [point(t, '10000', '0.0')], links: { next: `/v1/apps/APP/appPricePoints?page=2&filter[territory]=${t}` } };
      }
      if (p === '/v1/territories') return { data: territoryCodes.map(id => ({ type: 'territories', id })) };
      if (p === '/v1/apps/APP/appAvailabilityV2') { if (!db.avail) throw notFound(); return { data: { id: 'AV', attributes: { availableInNewTerritories: db.avail.newT } } }; }
      if (p === '/v2/appAvailabilities/AV/territoryAvailabilities') return { data: territoryCodes.map(t => ({ id: `TA-${t}`, attributes: { available: !!db.avail.territories[t] }, relationships: { territory: { data: { id: t } } } })) };
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
      if (/^\/v1\/territoryAvailabilities\//.test(path)) { if (which !== 'admin') throw new Error('403'); db.adminWrites.push(path); db.avail.territories[path.split('/').pop().slice(3)] = d.attributes.available; return { data: d }; }
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
      if (path === '/v1/appPriceSchedules') {
        if (which !== 'admin') throw new Error('403');
        db.adminWrites.push(path);
        const included = body.included[0];
        db.price = { base: d.relationships.baseTerritory.data.id, point: point(d.relationships.baseTerritory.data.id, 'x', null) };
        db.price.point.id = included.relationships.appPricePoint.data.id;
        const decoded = JSON.parse(Buffer.from(db.price.point.id, 'base64url').toString());
        db.price.point.attributes.customerPrice = { 10000: '0.0', 10600: '4.99' }[decoded.p] ?? '0.99';
        return { data: { id: 'SCH' } };
      }
      if (path === '/v2/appAvailabilities') {
        if (which !== 'admin') throw new Error('403');
        db.adminWrites.push(path);
        if (body.included.length !== territoryCodes.length) throw Object.assign(new Error('ASC 409: every territory must be included'), { status: 409 });
        db.avail = { newT: d.attributes.availableInNewTerritories, territories: Object.fromEntries(body.included.filter(i => i.attributes.available).map(i => [i.relationships.territory.data.id, true])) };
        return { data: { id: 'AV' } };
      }
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
  });
  return { db, client: build('manager'), adminClient: build('admin') };
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
  const admin = { which: 'admin', calls: [], patch: async (path, body) => { admin.calls.push(path); return client.patch(path, body); }, post: client.post };
  const result = await push({ dir, repo, apply: true, client, adminClient: admin, read, log: out.log });
  assert.equal(result.clean, true);
  assert.deepEqual(admin.calls, ['/v1/apps/APP'], 'content rights, and only it, goes through the Admin key');
  assert.equal(db.app.attributes.contentRightsDeclaration, 'DOES_NOT_USE_THIRD_PARTY_CONTENT');
  assert.equal(db.age.attributes.advertising, false);
  assert.equal(db.review.attributes.contactPhone, '+15551234567');
  assert.equal(db.info.cats.primarySubcategoryOne, 'GAMES_FAMILY');
  assert.equal(Object.values(db.sets)[0].shots.length, 2);
  assert.ok(out.lines.some(l => l.startsWith('verified:')));
  const before = db.writes.length;
  const again = quiet();
  const second = await push({ dir, repo, apply: true, client, adminClient: admin, read, log: again.log });
  assert.equal(second.clean, true);
  assert.equal(db.writes.length, before, 'idempotent: no write on the second run');
  assert.ok(again.lines.some(l => l.includes('nothing to write')));
});

test('push --only screenshots replaces the sets and never writes a text field', async () => {
  const { db, client } = fakeAsc();
  const dir = appDir({ shots: true });
  const out = quiet();
  const result = await push({ dir, repo, apply: true, only: 'screenshots', client, adminClient: client, read, log: out.log });
  assert.equal(result.clean, true);
  assert.equal(Object.values(db.sets)[0].shots.length, 2);
  assert.ok(db.writes.every(w => /appScreenshot/.test(w)), `only screenshot calls: ${db.writes.join(', ')}`);
  assert.equal(db.age.attributes.advertising, true, 'the age rating the file would change is left alone');
  await assert.rejects(push({ dir, repo, only: 'nope', client, read, log: () => {} }), /--only takes/);
});

test('a screenshot delete the App Manager key may not make is retried once with the Admin key', async () => {
  const { db, client } = fakeAsc();
  const dir = appDir({ shots: true });
  await push({ dir, repo, apply: true, only: 'screenshots', client, adminClient: client, read, log: () => {} });
  writeFileSync(join(dir, 'store/apple/screenshots/APP_IPHONE_67/01.png'), png(1320, 2868));
  const manager = { ...client, which: 'manager', delete: async path => { throw new Error(`ASC DELETE ${path} -> 403 (FORBIDDEN_ERROR)`); } };
  const admin = { ...client, which: 'admin', deletes: [], delete: async path => { admin.deletes.push(path); return client.delete(path); } };
  const result = await push({ dir, repo, apply: true, only: 'screenshots', client: manager, adminClient: admin, read, log: () => {} });
  assert.equal(result.clean, true);
  assert.equal(admin.deletes.length, 2);
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
  await push({ dir, repo, apply: true, client, adminClient: client, read, log: () => {} });
  const file = await pull({ dir, repo, client, log: () => {} });
  assert.equal(file.review.contactPhone, 'op://v/i/phone');
  assert.equal(file.review.contactFirstName, undefined);
  assert.equal(file.ageRating.advertising, false);
  assert.equal(JSON.parse(readFileSync(join(dir, 'store/apple/listing.json'), 'utf8')).locale, 'en-US');
  assert.ok(md5(Buffer.from('a')).length === 32);
});

// ---- price and availability (Admin key only) ----

const priced = f => { f.price = { baseTerritory: 'USA', customerPrice: '0.00' }; f.availability = { territories: ['USA', 'CAN', 'AUS', 'NZL'], availableInNewTerritories: false }; return f; };

const pricingOnly = d => ({ price: d.price, availability: d.availability });

test('parseListing checks price and availability', () => {
  assert.ok(parseListing(base(priced)));
  const bad = (change, pattern) => assert.throws(() => parseListing(base(f => change(priced(f)))), pattern);
  bad(f => { f.price.customerPrice = 'free'; return f; }, /customerPrice must be text like/);
  bad(f => { f.price.customerPrice = 0; return f; }, /customerPrice must be text like/);
  bad(f => { f.price.baseTerritory = 'us'; return f; }, /baseTerritory must be a three-letter/);
  bad(f => { delete f.price.baseTerritory; return f; }, /baseTerritory/);
  bad(f => { f.availability.territories = []; return f; }, /territories must be a list/);
  bad(f => { f.availability.territories = ['USA', 'USA']; return f; }, /twice/);
  bad(f => { f.availability.availableInNewTerritories = 'no'; return f; }, /true or false/);
  bad(f => { f.availability.territories = ['CAN']; return f; }, /baseTerritory USA must be one of availability.territories/);
  bad(f => { f.price.tier = 1; return f; }, /price.tier is not a field/);
});

test('price and availability: desired state is normalized and the diff compares territories as a set', () => {
  const desired = pricingOnly(desiredState(base(f => { priced(f); f.price.customerPrice = '4.9'; f.availability.territories = ['NZL', 'USA', 'CAN']; return f; })));
  assert.deepEqual(desired.price, { baseTerritory: 'USA', customerPrice: '4.90' });
  assert.deepEqual(desired.availability.territories, ['CAN', 'NZL', 'USA']);
  assert.deepEqual(diffState(desired, { price: { baseTerritory: 'USA', customerPrice: '4.90' }, availability: { territories: ['USA', 'CAN', 'NZL'], availableInNewTerritories: false } }), []);
  const changes = diffState(desired, { price: { baseTerritory: null, customerPrice: null }, availability: { territories: ['USA'], availableInNewTerritories: null } });
  assert.deepEqual(changes.map(c => `${c.group}.${c.field}`), ['price.baseTerritory', 'price.customerPrice', 'availability.territories', 'availability.availableInNewTerritories']);
  assert.match(formatChange(changes[2]), /availability.territories: \["USA"\] -> \["CAN","NZL","USA"\]/);
});

test('planCalls writes a price schedule and an availability whole, and flips single territories when only those change', () => {
  const desired = pricingOnly(desiredState(base(priced)));
  const fresh = planCalls(diffState(desired, { price: { baseTerritory: null, customerPrice: null }, availability: { territories: [], availableInNewTerritories: null } }), { app: 'APP', pricePoint: 'PT', allTerritories: ['AUS', 'CAN', 'FRA', 'GBR', 'NZL', 'USA'] }, desired);
  assert.deepEqual(fresh.map(c => `${c.method} ${c.path}`), ['POST /v1/appPriceSchedules', 'POST /v2/appAvailabilities']);
  assert.ok(fresh.every(c => c.admin));
  const price = fresh[0].body;
  assert.equal(price.data.relationships.baseTerritory.data.id, 'USA');
  assert.equal(price.included[0].relationships.appPricePoint.data.id, 'PT');
  assert.equal(price.data.relationships.manualPrices.data[0].id, price.included[0].id);
  const avail = fresh[1].body;
  assert.equal(avail.data.attributes.availableInNewTerritories, false);
  assert.deepEqual(avail.included.map(i => `${i.relationships.territory.data.id}:${i.attributes.available}`), ['AUS:true', 'CAN:true', 'FRA:false', 'GBR:false', 'NZL:true', 'USA:true'], 'every territory is sent, the wanted ones available');
  assert.deepEqual(avail.data.relationships.territoryAvailabilities.data.map(d => d.id), avail.included.map(i => i.id));
  assert.deepEqual(availabilityBody('APP', desired.availability, ['AUS', 'CAN', 'FRA', 'GBR', 'NZL', 'USA']), avail);
  assert.throws(() => availabilityBody('APP', desired.availability, ['USA']), /does not know the territory AUS, CAN, NZL/);
  // existing availability, only the territory list differs: one PATCH per territory that flips
  const have = { territories: ['USA', 'GBR'], availableInNewTerritories: false };
  const flips = planCalls(diffState({ availability: desired.availability }, { availability: have }), { app: 'APP', availability: 'AV', territoryAvailabilities: { USA: 'TA-USA', GBR: 'TA-GBR', CAN: 'TA-CAN', AUS: 'TA-AUS', NZL: 'TA-NZL' } }, { availability: desired.availability });
  assert.deepEqual(flips.map(c => `${c.path} ${c.body.data.attributes.available}`), ['/v1/territoryAvailabilities/TA-AUS true', '/v1/territoryAvailabilities/TA-CAN true', '/v1/territoryAvailabilities/TA-NZL true', '/v1/territoryAvailabilities/TA-GBR false']);
  assert.throws(() => planCalls(diffState({ availability: desired.availability }, { availability: have }), { app: 'APP', availability: 'AV', territoryAvailabilities: {} }, { availability: desired.availability }), /does not know the territory/);
  // existing availability, new-territories flag differs: Apple has no call for it, so the plan says so
  assert.throws(() => planCalls(diffState({ availability: desired.availability }, { availability: { ...desired.availability, availableInNewTerritories: true } }), { app: 'APP', availability: 'AV' }, { availability: desired.availability }), /change it in App Store Connect/);
});

test('reading price and availability: none yet, the price in force, price points across pages', async () => {
  const { db, adminClient } = fakeAsc();
  assert.deepEqual(await readPrice(adminClient, 'APP'), { baseTerritory: null, customerPrice: null });
  assert.deepEqual((await readAvailability(adminClient, 'APP')).state, { territories: [], availableInNewTerritories: null });
  db.price = { base: 'USA', point: null };
  assert.deepEqual(await readPrice(adminClient, 'APP'), { baseTerritory: 'USA', customerPrice: null }, 'a stub schedule with no prices reads as unpriced');
  db.price = { base: 'USA', point: { type: 'appPricePoints', id: Buffer.from(JSON.stringify({ t: 'USA', p: '10000' })).toString('base64url'), attributes: { customerPrice: '0.0' } } };
  assert.deepEqual(await readPrice(adminClient, 'APP', '2026-11-18'), { baseTerritory: 'USA', customerPrice: '0.00' }, 'an ended price is ignored');
  assert.equal(JSON.parse(Buffer.from(await findPricePoint(adminClient, 'APP', 'USA', '0.00'), 'base64url')).p, '10000');
  assert.equal(JSON.parse(Buffer.from(await findPricePoint(adminClient, 'APP', 'CAN', '4.99'), 'base64url')).p, '10600', 'found on the second page');
  await assert.rejects(findPricePoint(adminClient, 'APP', 'USA', '7.77'), /no USA price point costs 7.77/);
});

test('push --apply sets price and availability through the Admin key only, reads them back, and is idempotent', async () => {
  const { db, client, adminClient } = fakeAsc();
  const dir = appDir();
  writeFileSync(join(dir, 'store/apple/listing.json'), JSON.stringify(base(priced)));
  const dry = quiet();
  await push({ dir, repo, client, adminClient, read, log: dry.log });
  assert.deepEqual(db.writes, [], 'a dry run writes nothing');
  assert.ok(dry.lines.some(l => l.includes('price.customerPrice: null -> "0.00"')));
  assert.ok(dry.lines.some(l => l.includes('availability.territories: [] -> ["AUS","CAN","NZL","USA"]')));
  const out = quiet();
  const result = await push({ dir, repo, apply: true, client, adminClient, read, log: out.log });
  assert.equal(result.clean, true);
  assert.deepEqual(db.adminWrites, ['/v1/appPriceSchedules', '/v2/appAvailabilities']);
  assert.equal(db.price.base, 'USA');
  assert.deepEqual(Object.keys(db.avail.territories).sort(), ['AUS', 'CAN', 'NZL', 'USA']);
  assert.equal(db.avail.newT, false);
  assert.ok(out.lines.some(l => l.includes('read back price: {"baseTerritory":"USA","customerPrice":"0.00"}')));
  assert.ok(out.lines.some(l => l.includes('read back availability: {"territories":["AUS","CAN","NZL","USA"],"availableInNewTerritories":false}')));
  const before = db.writes.length;
  const again = quiet();
  assert.equal((await push({ dir, repo, apply: true, client, adminClient, read, log: again.log })).clean, true);
  assert.equal(db.writes.length, before);
  // widening later: only the new territory flips
  writeFileSync(join(dir, 'store/apple/listing.json'), JSON.stringify(base(f => { priced(f); f.availability.territories.push('GBR'); return f; })));
  await push({ dir, repo, apply: true, client, adminClient, read, log: () => {} });
  assert.equal(db.adminWrites.at(-1), '/v1/territoryAvailabilities/TA-GBR');
  assert.equal(db.avail.territories.GBR, true);
});

test('a listing without price or availability never touches the Admin key for them', async () => {
  const { db, client } = fakeAsc();
  const guard = { which: 'admin', get() { throw new Error('admin used'); } };
  await push({ dir: appDir(), repo, client, adminClient: guard, read, log: () => {} });
  assert.deepEqual(db.writes, []);
});

test('pull keeps price and availability only when the file already manages them', async () => {
  const { client, adminClient, db } = fakeAsc();
  const dir = appDir();
  writeFileSync(join(dir, 'store/apple/listing.json'), JSON.stringify(base(priced)));
  await push({ dir, repo, apply: true, client, adminClient, read, log: () => {} });
  const file = await pull({ dir, repo, client, adminClient, log: () => {} });
  assert.deepEqual(file.price, { baseTerritory: 'USA', customerPrice: '0.00' });
  assert.deepEqual(file.availability, { territories: ['AUS', 'CAN', 'NZL', 'USA'], availableInNewTerritories: false });
  void db;
});

test('a field write the App Manager key gets 403 on is retried once with the Admin key', async () => {
  const { client } = fakeAsc();
  const dir = appDir({});
  const manager = { ...client, which: 'manager', patch: async (path, body) => { if (path.startsWith('/v1/appInfos/')) throw new Error(`ASC PATCH ${path} -> 403 (FORBIDDEN_ERROR)`); return client.patch(path, body); } };
  const admin = { ...client, which: 'admin', patches: [], patch: async (path, body) => { admin.patches.push(path); return client.patch(path, body); } };
  const result = await push({ dir, repo, apply: true, only: 'fields', client: manager, adminClient: admin, read, log: () => {} });
  assert.equal(result.clean, true);
  assert.ok(admin.patches.some(p => p.startsWith('/v1/appInfos/')), 'the refused appInfos write went through the Admin key');
});
