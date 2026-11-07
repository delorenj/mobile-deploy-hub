// A version's authored product notes are captured at plan time and carried by its receipt. Git history is
// provenance, not a substitute for product language. The versioned S3 copy is immutable across reruns.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { compareSemver, versionKey } from './latest.mjs';

export const notesKey = (slug, version) => versionKey(slug, version, 'release-notes.json');
const revision = value => typeof value === 'string' && /^[0-9a-f]{7,40}$/.test(value);
const version = value => typeof value === 'string' && /^\d+\.\d+\.\d+$/.test(value);
const list = (value, where) => {
  if (!Array.isArray(value) || value.length > 20 || value.some(line => typeof line !== 'string' || !line.trim() || line.length > 500 || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(line))) throw new Error(`${where} must be an array of up to 20 nonempty lines (max 500 characters each)`);
  return value;
};
const keys = (obj, allowed, where) => {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj) || Object.keys(obj).some(key => !allowed.includes(key))) throw new Error(`${where} has an invalid shape or unknown key`);
};
export function authoredNotes(cwd, { current, previous = null, previousCommit = null, commit }) {
  if (!version(current) || (previous !== null && !version(previous)) || !revision(commit) || (previousCommit !== null && !revision(previousCommit))) throw new Error('release notes need a version and source revisions');
  const path = join(cwd, 'tools/ci/release-notes.json');
  let entries = {};
  if (existsSync(path)) {
    let input;
    try { input = JSON.parse(readFileSync(path, 'utf8')); } catch { throw new Error('tools/ci/release-notes.json must be valid JSON'); }
    keys(input, ['schema', 'releases'], path);
    if (input.schema !== 1) throw new Error(`${path}: schema must be 1`);
    keys(input.releases, Object.keys(input.releases ?? {}), `${path}.releases`);
    if (Object.keys(input.releases).length > 500) throw new Error(`${path}: too many release entries`);
    entries = input.releases;
    for (const [v, entry] of Object.entries(entries)) {
      if (!version(v)) throw new Error(`${path}: invalid version ${v}`);
      keys(entry, ['kind', 'whats_new', 'try', 'limitations'], `${path} ${v}`);
      if (!['app', 'maintenance'].includes(entry.kind)) throw new Error(`${path} ${v}: kind must be app or maintenance`);
      for (const field of ['whats_new', 'try', 'limitations']) list(entry[field], `${path} ${v}.${field}`);
      if (entry.kind === 'maintenance' && (entry.whats_new.length || entry.try.length)) throw new Error(`${path} ${v}: maintenance cannot claim app-visible changes`);
    }
  }
  const prior = previous && compareSemver(previous, current) < 0 ? previous : null;
  const included = Object.keys(entries).filter(v => compareSemver(v, current) <= 0 && (!prior || compareSemver(v, prior) > 0)).sort(compareSemver);
  // A stale latest pointer can be ahead of a candidate; the plan's own downgrade guard decides whether
  // that candidate is legal. Do not make notes generation a second version authority.
  return validateNotes({ schema: 1, version: current, commit, previous_version: prior, previous_commit: prior ? previousCommit : null, status: included.length ? 'authored' : 'missing', entries: included.map(v => ({ version: v, ...entries[v] })) });
}

export function validateNotes(doc, { current, commit } = {}) {
  keys(doc, ['schema', 'version', 'commit', 'previous_version', 'previous_commit', 'status', 'entries'], 'release notes');
  if (doc.schema !== 1 || !version(doc.version) || !revision(doc.commit) || (doc.previous_version !== null && !version(doc.previous_version)) || (doc.previous_commit !== null && !revision(doc.previous_commit))) throw new Error('release notes have invalid provenance');
  if ((current && doc.version !== current) || (commit && doc.commit !== commit)) throw new Error('release notes do not match the build version and revision');
  if (!['authored', 'missing'].includes(doc.status) || !Array.isArray(doc.entries) || doc.entries.length > 100 || (doc.status === 'missing') !== (doc.entries.length === 0)) throw new Error('release notes status disagrees with entries');
  if (doc.previous_version && compareSemver(doc.previous_version, doc.version) >= 0) throw new Error('release notes previous version must precede this build');
  let last = doc.previous_version;
  for (const entry of doc.entries) {
    keys(entry, ['version', 'kind', 'whats_new', 'try', 'limitations'], 'release notes entry');
    if (!version(entry.version) || compareSemver(entry.version, doc.version) > 0 || (last && compareSemver(entry.version, last) <= 0)) throw new Error('release notes entries must be ordered inside the published range');
    if (!['app', 'maintenance'].includes(entry.kind)) throw new Error('release notes entry kind is invalid');
    for (const field of ['whats_new', 'try', 'limitations']) list(entry[field], `release notes ${field}`);
    if (entry.kind === 'maintenance' && (entry.whats_new.length || entry.try.length)) throw new Error('maintenance notes cannot claim app-visible changes');
    last = entry.version;
  }
  return doc;
}

export function persistedNotes(saved, candidate, { current, commit }) {
  // Existing bytes win for this app/version on a failed-job rerun or the second platform's delivery.
  // A different build revision under that version cannot silently acquire the earlier release's notes.
  return saved ? validateNotes(JSON.parse(saved), { current, commit }) : validateNotes(candidate, { current, commit });
}

export function notesText(doc) {
  validateNotes(doc);
  const range = doc.previous_version ? `${doc.previous_version} → ${doc.version}` : `first published build → ${doc.version}`;
  const lines = [`Release notes for ${doc.version}`, `Source ${doc.previous_commit ?? 'unknown'}..${doc.commit} (${range})`, ''];
  if (doc.status === 'missing') lines.push('No author-written release notes were supplied for this build. See the source range and run for details.');
  else {
    for (const entry of doc.entries) {
      lines.push(`${entry.version} — ${entry.kind === 'app' ? 'App-visible' : 'Backend / maintenance'}`);
      for (const [field, title] of [['whats_new', "What's new"], ['try', 'What to try'], ['limitations', 'Known limitations']]) if (entry[field].length) lines.push(`${title}:`, ...entry[field].map(line => `- ${line}`));
      lines.push('');
    }
    lines.push('These are explicitly authored entries in the published range; unannotated changes may also exist.');
  }
  return lines.join('\n');
}
