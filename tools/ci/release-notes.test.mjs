import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { authoredNotes, notesKey, notesText, persistedNotes, validateNotes } from './lib/release-notes.mjs';
import { appPage } from './lib/pages.mjs';
import { publishPages } from './lib/s3.mjs';
import { sampleLatest } from './test-fixtures.mjs';
import { loadPolicy } from './lib/policy.mjs';

const sha = 'a'.repeat(40);
const prev = 'b'.repeat(40);
const note = (version, kind = 'app') => ({ version, kind, whats_new: ['New <p> & more'], try: ['Try the new screen'], limitations: ['No offline mode'] });
const full = () => ({ schema: 1, version: '1.2.0', commit: sha, previous_version: '1.0.0', previous_commit: prev, status: 'authored', entries: [note('1.1.0'), note('1.2.0', 'maintenance')] });

test('authored input covers the full published range without inventing missing versions or mixing apps', () => {
  const root = mkdtempSync(join(tmpdir(), 'hub-notes-'));
  const other = mkdtempSync(join(tmpdir(), 'hub-notes-'));
  try {
    for (const dir of [root, other]) mkdirSync(join(dir, 'tools/ci'), { recursive: true });
    writeFileSync(join(root, 'tools/ci/release-notes.json'), JSON.stringify({ schema: 1, releases: {
      '1.0.0': { kind: 'app', whats_new: ['old'], try: [], limitations: [] },
      '1.1.0': { kind: 'app', whats_new: ['new'], try: ['check'], limitations: [] },
      '1.2.0': { kind: 'maintenance', whats_new: [], try: [], limitations: ['Backend only'] },
      '1.3.0': { kind: 'app', whats_new: ['future'], try: [], limitations: [] },
    } }));
    const one = authoredNotes(root, { current: '1.2.0', previous: '1.0.0', previousCommit: prev, commit: sha });
    assert.deepEqual(one.entries.map(entry => entry.version), ['1.1.0', '1.2.0']);
    assert.equal(one.previous_commit, prev);
    assert.match(notesText(one), /Backend \/ maintenance/);
    assert.deepEqual(authoredNotes(other, { current: '1.2.0', previous: '1.0.0', commit: sha }).entries, []);
    assert.equal(authoredNotes(other, { current: '1.2.0', previous: '1.0.0', commit: sha }).status, 'missing');
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(other, { recursive: true, force: true }); }
});

test('invalid notes and dishonest maintenance claims are rejected; absent authors are safe', () => {
  const root = mkdtempSync(join(tmpdir(), 'hub-notes-invalid-'));
  try {
    assert.equal(authoredNotes(root, { current: '1.2.0', commit: sha }).status, 'missing');
    mkdirSync(join(root, 'tools/ci'), { recursive: true });
    const path = join(root, 'tools/ci/release-notes.json');
    for (const data of ['not json', JSON.stringify({ schema: 1, releases: { '1.2.0': { kind: 'maintenance', whats_new: ['Feature'], try: [], limitations: [] } } }), JSON.stringify({ schema: 1, releases: { '1.2.0': { kind: 'app', whats_new: 'not an array', try: [], limitations: [] } } })]) {
      writeFileSync(path, data);
      assert.throws(() => authoredNotes(root, { current: '1.2.0', commit: sha }));
    }
    assert.throws(() => validateNotes({ ...full(), entries: [note('1.2.0'), note('1.1.0')] }));
    assert.throws(() => validateNotes(full(), { current: '1.2.0', commit: prev }), /match/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('the first published version owns the immutable note snapshot across platform deliveries and reruns', () => {
  const original = { ...full(), entries: [note('1.1.0'), { ...note('1.2.0'), whats_new: ['Original words'] }] };
  const rerun = { ...full(), entries: [note('1.1.0'), { ...note('1.2.0'), whats_new: ['Later words'] }] };
  assert.deepEqual(persistedNotes(JSON.stringify(original), rerun, { current: '1.2.0', commit: sha }), original);
  assert.deepEqual(persistedNotes(null, rerun, { current: '1.2.0', commit: sha }), rerun);
  assert.throws(() => persistedNotes(JSON.stringify(original), rerun, { current: '1.2.0', commit: prev }), /match/);
});

test('page escapes hostile content and refuses unsafe URLs while showing prior notes', () => {
  const latest = sampleLatest();
  const releaseNotes = { [latest.version]: { ...full(), version: latest.version, entries: [note(latest.version)] }, '0.0.1': { ...full(), version: '0.0.1', previous_version: null, entries: [note('0.0.1')] } };
  const page = appPage({ latest, history: [{ version: '0.0.1', code: 1, url: 'javascript:alert(1)', bytes: 100 }], releaseNotes });
  assert.match(page, /New &lt;p&gt; &amp; more/);
  assert.match(page, /What to try/);
  assert.match(page, /Known limitations/);
  assert.match(page, /Build history/);
  assert.doesNotMatch(page, /href="javascript:/);
  assert.match(page, /href="#"/);
  assert.equal(notesKey('my-app', '1.2.0'), 'my-app/1.2.0/release-notes.json');
});

test('page regeneration reads immutable versioned notes, including retained history, without cross-app reads', async () => {
  const policy = loadPolicy().policy;
  const latest = sampleLatest();
  const slug = latest.slug;
  const canonical = { ...full(), version: latest.version, previous_version: null, entries: [note(latest.version)] };
  const objects = new Map([[notesKey(slug, latest.version), JSON.stringify(canonical)], [notesKey(slug, '0.0.1'), JSON.stringify({ ...full(), version: '0.0.1', previous_version: null, entries: [note('0.0.1')] })]]);
  const writes = [];
  const s3 = { list: () => [{ key: `${slug}/0.0.1/${slug}-0.0.1-1.apk`, size: 500 }], putText: (text, key) => writes.push({ text, key }) };
  const urls = [];
  const fetchImpl = async url => { urls.push(String(url)); const key = String(url).split('/builds/')[1]; return objects.has(key) ? { ok: true, text: async () => objects.get(key) } : { status: 404 }; };
  await publishPages({ s3, policy, slug, latest, fetchImpl, env: { HUB_LOCK_DIR: mkdtempSync(join(tmpdir(), 'hub-notes-lock-')) } });
  assert.match(writes.find(item => item.key === `${slug}/index.html`).text, /New &lt;p&gt; &amp; more/);
  assert.ok(urls.some(url => url.includes(notesKey(slug, '0.0.1'))));
  assert.ok(urls.filter(url => url.includes('release-notes.json')).every(url => url.includes(`/${slug}/`)));
});
