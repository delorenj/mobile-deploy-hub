#!/usr/bin/env node
// mise run release -- X.Y.Z (design v1.1, D1): ships a hub release and moves the floating tag the callers pin.
//   1. the work tree is clean and equal to origin/main, `mise run check` passes, and every app conforms;
//   2. the workflow's inner actions/hub@ refs flip to vX.Y.Z in one commit, which is tagged vX.Y.Z and pushed;
//   3. v1 is force-moved to that tag (GitHub Free has no tag protection);
//   4. one strict dry run with --dry-handoff true per app, in Jarad's order (Tower, Green In Between, Gruvato): this is
//      the iPad proof the old front-door ledger kept, now once per hub version and from any machine;
//   5. red: v1 moves back to where it was (or goes away if it was new) and the release says so. Green: the run ids go
//      into the annotation of vX.Y.Z.
// The release notes: the `## vX.Y.Z` section of docs/hub-releases.md, when there is one, is put into every annotation of
// vX.Y.Z (pending, green, red or unknown), between the header and the dry-run lines. A release with no section is annotated
// as before.
// The rollback: every annotation of vX.Y.Z also carries a `Roll back:` line (logged as RELEASE_ROLLBACK), after the notes and
// before the dry-run lines. It is computed from where the major tag (v1) pointed before this release started, never from "the
// previous version number": a red release moves v1 back, so a tag can exist that v1 never stood on (v1.2.47, v1.2.49 and
// v1.2.50 were rolled back).
// A release that adds a service (a tools/hosts/units/*.service that the rollback target does not have) also says to stop it, before the
// target's hosts:install: the old tag's installer knows no such unit, so the service would otherwise keep running from the new
// release. Stopping first is right either way: a target that does install the unit enables and restarts it again.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deploy, finishByHand, parseArguments, realGh, realGit, unknownStatus } from './deploy.mjs';
import { check as checkBucketPolicy } from './bucket-policy.mjs';
import { conformance } from './conformance.mjs';
import { loadPolicy } from './ci/lib/policy.mjs';

const hubRoot = fileURLToPath(new URL('..', import.meta.url));
const workflowPath = resolve(hubRoot, '.github/workflows/mobile-deploy.yml');
export const notesPath = resolve(hubRoot, 'docs/hub-releases.md');
const coAuthor = 'Co-Authored-By: Claude Code <noreply@anthropic.com>';

// The notes of one release: the lines after its `## vX.Y.Z` heading (the heading may go on, `## v1.2.46 (2026-11-24)`) up to
// the next `## ` heading or the end, trimmed. null when the file has no such section or the section is empty. Notes can never
// break a release: CRLF files read like LF ones (a `\r` would hide the heading), a NUL (which cannot go in an argument) is
// dropped, and a section past notesMaxBytes (one argument is capped near 128 KiB) is cut with a line saying so.
export const notesMaxBytes = 60_000;
export function releaseNotes(text, tag) {
  const lines = String(text ?? '').replaceAll('\0', '').split(/\r\n|\r|\n/);
  const start = lines.findIndex(line => line === `## ${tag}` || line.startsWith(`## ${tag} `));
  if (start === -1) return null;
  const end = lines.findIndex((line, index) => index > start && line.startsWith('## '));
  const body = lines.slice(start + 1, end === -1 ? lines.length : end).join('\n').trim();
  if (body === '') return null;
  if (Buffer.byteLength(body) <= notesMaxBytes) return body;
  return `${Buffer.from(body).subarray(0, notesMaxBytes).toString('utf8').replace(/\uFFFD+$/, '').trimEnd()}\n\n(the notes were cut here: the whole ${tag} section is in docs/hub-releases.md)`;
}

// The annotation of a release tag: the header, the release's notes when it has any, then what its dry runs said.
// The rollback line, when there is one, sits between the notes and the status.
export const tagMessage = (tag, status, notes = null, rollback = null) => `mobile-deploy-hub ${tag}\n\n${notes ? `${notes}\n\n` : ''}${rollback ? `${rollback}\n\n` : ''}${status}`;

// The release tag a commit stands for: the highest vX.Y.Z of the names given (numeric, not lexical; other names such as `v1`
// or `foo` are ignored), null when none is a release tag.
export function pinTag(names) {
  const versions = (names ?? []).filter(name => /^v\d+\.\d+\.\d+$/.test(name)).map(name => ({ name, parts: name.slice(1).split('.').map(Number) }));
  versions.sort((a, b) => b.parts[0] - a.parts[0] || b.parts[1] - a.parts[1] || b.parts[2] - a.parts[2]);
  return versions[0]?.name ?? null;
}

// How to undo a release: put the callers' pin (the major tag) and the hosts' tools back on what the major tag named before.
// `previous` is remoteTag(major) read before the first tag of the release ({object, commit} or null when the major is new);
// `previousTag` is pinTag of the tags on that commit. Without a tag the full commit is named (a short form can be ambiguous).
export function rollbackLine({ major, previous, previousTag = null, stopUnits = [], stopAgents = [] }) {
  if (!previous) return `Roll back: none: ${major} is new with this release.`;
  const ref = previousTag ?? previous.commit;
  // What this release added that the target's installer does not know: a systemd unit on big-chungus, a LaunchAgent on the Mac (`<label>.plist`).
  const stops = [];
  if (stopUnits?.length > 0) stops.push(`systemctl --user disable --now ${stopUnits.join(' ')} on big-chungus`);
  if (stopAgents?.length > 0) {
    // One remote command, single-quoted so `$(id -u)` and `~` expand on the Mac, not on big-chungus.
    const labels = stopAgents.map(file => file.replace(/\.plist$/, ''));
    stops.push(`on the Mac, run ssh hub-mac '${labels.map(label => `launchctl bootout gui/$(id -u)/${label}; rm -f ~/Library/LaunchAgents/${label}.plist`).join('; ')}'`);
  }
  const stop = stops.length > 0 ? `then stop what this release added and ${ref} does not install (${stops.join('; ')}), ` : '';
  return `Roll back: move ${major} back to ${ref} (git tag -f ${major} '${ref}^{commit}' && git push -f origin refs/tags/${major}), ${stop}then run mise run hosts:install on big-chungus from a clean checkout at ${ref} (it installs the Mac through hub-mac).`;
}

// The rollback line of a release at HEAD: the units and LaunchAgents HEAD adds that the rollback target (`previous.commit`) lacks, then `rollbackLine`.
export function rollbackFor({ major, previous, previousTag = null, run = git }) {
  const stopUnits = previous ? stopUnitsOf('HEAD', previous.commit, run) : [];
  const stopAgents = previous ? stopUnitsOf('HEAD', previous.commit, run, '.plist') : [];
  return rollbackLine({ major, previous, previousTag, stopUnits, stopAgents });
}

// The files ending in `suffix` (`.service`, a systemd unit; `.plist`, a LaunchAgent) of a `git ls-tree --name-only <commit> tools/hosts/units/` listing, as
// sorted basenames. It takes the output text (or the `{ok, out}` the git helper returns); a failed lookup (null, undefined or `ok: false`) is null,
// never an empty list.
export function unitsIn(listing, suffix = '.service') {
  const text = listing !== null && typeof listing === 'object' ? (listing.ok ? listing.out : null) : listing;
  if (typeof text !== 'string') return null;
  return text.split(/\r?\n/).map(line => line.trim().split('/').pop()).filter(name => name.endsWith(suffix)).sort();
}

// The units to stop on a rollback: the files ending in `suffix` at `head` that `previousCommit` does not have. When the previous lookup fails every
// one at `head` is listed (stopping first is always safe); when the lookup at `head` fails there is nothing to name.
export function stopUnitsOf(head, previousCommit, run = git, suffix = '.service') {
  const at = commit => unitsIn(run(['ls-tree', '--name-only', commit, 'tools/hosts/units/'], { allowFail: true }), suffix);
  const added = at(head);
  if (added === null) return [];
  const before = at(previousCommit);
  return before === null ? added : added.filter(name => !before.includes(name));
}

// `git tag` strips `#` lines from a message by default; whitespace cleanup keeps a notes heading.
export const tagArgs = (tag, commit, message, { force = false } = {}) => ['tag', ...(force ? ['-f'] : []), '-a', '--cleanup=whitespace', tag, ...(commit ? [commit] : []), '-m', message];

function git(args, { allowFail = false } = {}) {
  const result = spawnSync('git', args, { cwd: hubRoot, encoding: 'utf8' });
  if (!allowFail && (result.error || result.status !== 0)) throw new Error(`git ${args.slice(0, 3).join(' ')} failed: ${(result.stderr || result.error?.message || '').trim().slice(-400)}`);
  return { ok: result.status === 0, out: (result.stdout ?? '').trim() };
}

export function flipInnerRefs(text, tag) {
  return text.replace(/(uses: delorenj\/mobile-deploy-hub\/actions\/hub@)\S+/g, `$1${tag}`);
}

// null only when the lookup succeeded and lists no such ref; a lookup that itself fails (network, auth) throws, so a release
// never reads "could not ask" as "v1 is new" (which would delete v1 on a red dry run) or "the tag is free".
export function remoteTag(name, run = git) {
  const found = run(['ls-remote', '--tags', 'origin', `refs/tags/${name}`, `refs/tags/${name}^{}`], { allowFail: true });
  if (!found.ok) throw new Error(`git ls-remote for ${name} failed; cannot tell whether it exists on origin`);
  const line = found.out;
  let object = null;
  let commit = null;
  for (const entry of line.split('\n').filter(Boolean)) {
    const [sha, ref] = entry.split(/\s+/);
    if (ref === `refs/tags/${name}`) object = sha;
    if (ref === `refs/tags/${name}^{}`) commit = sha;
  }
  return object ? { object, commit: commit ?? object } : null;
}

export async function release(version, { log = console.log, dryRuns = true } = {}) {
  if (!/^\d+\.\d+\.\d+$/.test(version ?? '')) throw new Error('usage: mise run release -- X.Y.Z');
  const tag = `v${version}`;
  const major = `v${version.split('.')[0]}`;
  if (git(['status', '--porcelain']).out !== '') throw new Error('the hub work tree is not clean; commit or stash first');
  if (git(['rev-parse', '--abbrev-ref', 'HEAD']).out !== 'main') throw new Error('release from main');
  git(['fetch', '-q', 'origin', 'main', '--tags']);
  if (git(['rev-parse', 'HEAD']).out !== git(['rev-parse', 'origin/main']).out) throw new Error('main is not origin/main; pull or push first');
  if (remoteTag(tag)) throw new Error(`${tag} already exists on origin; a release is never reused`);

  log('RELEASE_CHECK mise run check');
  const check = spawnSync('mise', ['run', 'check'], { cwd: hubRoot, stdio: 'inherit' });
  if (check.status !== 0) throw new Error('mise run check is red');
  log('RELEASE_CHECK mise run conformance');
  const problems = conformance({ policy: loadPolicy().policy, log });
  if (problems.length > 0) throw new Error(`${problems.length} conformance problems`);
  // MOBI-17 (docs/private-device-builds.md, "Applying it"): the live bucket must not be more closed than policy.json says
  // (no listing, every public key readable). It may still be more open: a change that makes something private is applied
  // after this release and hosts:install, so the hub that reads it with keys ships first, and a red dry run that moves
  // v1 back meets the bucket the old code reads. The strict check (mise run bucket-policy) follows the apply.
  log('RELEASE_CHECK mise run bucket-policy -- --pending-ok');
  const access = await checkBucketPolicy({ policy: loadPolicy().policy, log, pendingOk: true });
  if (access.length > 0) throw new Error(`${access.length} bucket policy problems (a public key closed, listing open, or the committed file stale; apply what opens before the release)`);

  const text = readFileSync(workflowPath, 'utf8');
  const flipped = flipInnerRefs(text, tag);
  if (flipped !== text) {
    writeFileSync(workflowPath, flipped);
    git(['commit', '-q', '-m', `feat(hub): ${tag}: the workflow's inner actions/hub refs pin ${tag}`, '-m', coAuthor, '--', '.github/workflows/mobile-deploy.yml']);
  }
  const commit = git(['rev-parse', 'HEAD']).out;
  // Where the major tag stands before this release touches anything: the rollback target (read before the first tag).
  const previous = remoteTag(major);
  const previousTag = previous ? pinTag(git(['tag', '--list', 'v*', '--points-at', previous.commit], { allowFail: true }).out.split('\n').filter(Boolean)) : null;
  const rollback = rollbackFor({ major, previous, previousTag });
  log(`RELEASE_ROLLBACK ${rollback}`);
  let notes = null;
  try { notes = existsSync(notesPath) ? releaseNotes(readFileSync(notesPath, 'utf8'), tag) : null; } catch (error) { log(`RELEASE_NOTES ${tag}: docs/hub-releases.md unreadable (${error.code ?? error.message}); tagging without notes`); }
  log(notes ? `RELEASE_NOTES ${tag}: ${notes.split('\n').length} lines from docs/hub-releases.md` : `RELEASE_NOTES ${tag}: none (no section in docs/hub-releases.md)`);
  git(tagArgs(tag, null, tagMessage(tag, 'Release dry runs pending.', notes, rollback)));
  git(['push', '-q', '--atomic', 'origin', 'HEAD:refs/heads/main', `refs/tags/${tag}`]);
  log(`RELEASE_TAGGED ${tag} at ${commit.slice(0, 8)}`);

  git(['tag', '-f', major, commit]);
  git(['push', '-q', '-f', 'origin', `refs/tags/${major}`]);
  log(`RELEASE_MOVED ${major} -> ${tag}${previous ? ` (was ${previous.commit.slice(0, 8)})` : ' (new)'}`);
  if (!dryRuns) return { tag, commit, runs: [] };

  const runs = [];
  let red = null;
  let unknown = null;
  for (const repo of Object.keys(loadPolicy().policy.apps)) {
    log(`RELEASE_DRY_RUN ${repo} at ${major} (${tag})`);
    try {
      const result = await deploy({ ...parseArguments(['--dry-run', 'true', '--dry-handoff', 'true', '--repo', repo, '--hub-ref', major]) }, { gh: realGh, git: realGit, log });
      runs.push({ repo, id: result.run?.databaseId ?? null, url: result.run?.url ?? null, status: result.status });
      if (result.status === unknownStatus) { unknown = { repo, id: result.run?.databaseId, url: result.run?.url }; break; }
      if (result.status !== 0) { red = repo; break; }
    } catch (error) {
      runs.push({ repo, id: null, url: null, status: 1, error: error.message.split('\n')[0] });
      red = repo;
      break;
    }
  }
  const lines = runs.map(item => `${item.repo}: ${item.status === 0 ? 'green' : item.status === unknownStatus ? 'UNKNOWN' : 'RED'} ${item.id ?? ''} ${item.url ?? item.error ?? ''}`.trim());
  if (unknown) {
    // No verdict is not red: v1 stays where it is, the release stays unproven, and a person finishes the watch.
    git(tagArgs(tag, commit, tagMessage(tag, `Release dry runs: UNKNOWN at ${unknown.repo} (GitHub gave no verdict); ${major} was moved and not rolled back.\n${lines.join('\n')}`, notes, rollback), { force: true }));
    git(['push', '-q', '-f', 'origin', `refs/tags/${tag}`]);
    throw new Error(`the release dry run of ${unknown.repo} has no verdict (${unknown.url ?? 'no run'}); ${major} stays on ${tag}, unproven, not rolled back. Finish by hand: ${finishByHand(unknown.id, ['--repo', unknown.repo])}`);
  }
  if (red) {
    if (previous) {
      git(['tag', '-f', major, previous.commit]);
      git(['push', '-q', '-f', 'origin', `refs/tags/${major}`]);
      log(`RELEASE_ROLLED_BACK ${major} -> ${previous.commit.slice(0, 8)}: the dry run of ${red} is red`);
    } else {
      git(['push', '-q', 'origin', `:refs/tags/${major}`], { allowFail: true });
      git(['tag', '-d', major], { allowFail: true });
      log(`RELEASE_ROLLED_BACK ${major} removed (it was new): the dry run of ${red} is red`);
    }
    git(tagArgs(tag, commit, tagMessage(tag, `Release dry runs: RED at ${red}; ${major} not moved.\n${lines.join('\n')}`, notes, rollback), { force: true }));
    git(['push', '-q', '-f', 'origin', `refs/tags/${tag}`]);
    throw new Error(`the release dry run of ${red} is red; ${major} is back where it was. Fix it and release the next patch`);
  }
  git(tagArgs(tag, commit, tagMessage(tag, `Release dry runs (strict, --dry-handoff true, at ${major}), all green:\n${lines.join('\n')}`, notes, rollback), { force: true }));
  git(['push', '-q', '-f', 'origin', `refs/tags/${tag}`]);
  log(`RELEASE_DONE ${tag}: ${major} points at it; ${lines.join('; ')}`);
  return { tag, commit, runs };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [version, ...rest] = process.argv.slice(2);
  release(version?.replace(/^v/, ''), { dryRuns: !rest.includes('--no-dry-runs') }).catch(error => { console.error(`::error::${error.message}`); process.exitCode = 1; });
}
