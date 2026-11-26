// MOBI-51: install.sh moves `current` forward only. It records the commit it installs (releases/<ref>/.hub-commit) and refuses an
// ancestor of the installed commit unless --allow-downgrade. Hermetic: a throwaway git repo holding a minimal tools/ tree, a
// fake HOME with a node 24 stub, and a systemctl shim.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const hubRoot = fileURLToPath(new URL('../..', import.meta.url));
const linux = { skip: process.platform !== 'linux' };

function git(cwd, ...args) {
  const done = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' });
  assert.equal(done.status, 0, `git ${args.join(' ')}: ${done.stderr}`);
  return done.stdout.trim();
}

// A repo with three commits of a minimal tools/ tree (the installer's own check wants catchup.mjs and adb.mjs) and a fake host.
function world() {
  const root = mkdtempSync(join(tmpdir(), 'hub-install-forward-'));
  const repo = join(root, 'repo');
  const home = join(root, 'home');
  const tools = join(repo, 'tools');
  mkdirSync(join(tools, 'catchup'), { recursive: true });
  mkdirSync(join(tools, 'ci/lib'), { recursive: true });
  writeFileSync(join(tools, 'catchup/catchup.mjs'), '// c\n');
  writeFileSync(join(tools, 'ci/lib/adb.mjs'), '// a\n');
  cpSync(join(hubRoot, 'tools/catchup/units'), join(tools, 'catchup/units'), { recursive: true });
  git(repo.replace(/repo$/, ''), 'init', '-q', repo);
  const shas = [];
  for (const n of [1, 2, 3]) {
    writeFileSync(join(tools, 'catchup/catchup.mjs'), `// c${n}\n`);
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', `c${n}`);
    shas.push(git(repo, 'rev-parse', 'HEAD'));
  }
  const installs = join(home, '.local/share/mise/installs/node');
  mkdirSync(join(installs, '24.15.0/bin'), { recursive: true });
  writeFileSync(join(installs, '24.15.0/bin/node'), '#!/bin/sh\necho "mode: watch"\n');
  chmodSync(join(installs, '24.15.0/bin/node'), 0o755);
  symlinkSync('24.15.0', join(installs, '24'));
  const shims = join(home, 'shims');
  mkdirSync(shims, { recursive: true });
  writeFileSync(join(shims, 'systemctl'), '#!/bin/sh\nexit 0\n');
  chmodSync(join(shims, 'systemctl'), 0o755);
  const env = { PATH: `${shims}:${process.env.PATH}`, HOME: home };
  const share = join(home, '.local/share/mobile-deploy-hub');
  return {
    repo, home, shas, share, root,
    at: index => git(repo, 'checkout', '-q', shas[index]),
    install: (args, script = join(tools, 'catchup/units/install.sh'), extra = {}) => spawnSync('bash', [script, ...args], { env: { ...env, ...extra }, encoding: 'utf8' }),
    current: () => readlinkSync(join(share, 'current')),
    record: ref => readFileSync(join(share, 'releases', ref, '.hub-commit'), 'utf8'),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

test('a forward install records its commit and moves current; an equal re-install is fine', linux, () => {
  const w = world();
  try {
    w.at(0);
    const first = w.install(['main-c1']);
    assert.equal(first.status, 0, first.stdout + first.stderr);
    assert.equal(w.current(), 'releases/main-c1');
    assert.equal(w.record('main-c1'), `commit=${w.shas[0]}\ncount=1\n`);
    w.at(1);
    const forward = w.install(['main-c2']);
    assert.equal(forward.status, 0, forward.stdout + forward.stderr);
    assert.equal(w.current(), 'releases/main-c2');
    assert.equal(w.record('main-c2'), `commit=${w.shas[1]}\ncount=2\n`);
    const same = w.install(['main-c2']);
    assert.equal(same.status, 0, same.stdout + same.stderr);
    assert.equal(w.current(), 'releases/main-c2');
    // Run from the release copy itself (no .git there): the recorded commit is the same one, so it is still an equal install.
    const copy = w.install(['main-c2'], join(w.share, 'releases/main-c2/tools/catchup/units/install.sh'));
    assert.equal(copy.status, 0, copy.stdout + copy.stderr);
    assert.doesNotMatch(copy.stdout + copy.stderr, /HUB_INSTALL_(REFUSED|DOWNGRADE|UNVERIFIED)/);
  } finally { w.cleanup(); }
});

test('an install of an ancestor is refused (exit 3) naming both refs, and changes nothing', linux, () => {
  const w = world();
  try {
    w.at(2);
    assert.equal(w.install(['v1.2.60']).status, 0);
    w.at(0);
    const refused = w.install(['v1.2.58']);
    assert.equal(refused.status, 3, refused.stdout + refused.stderr);
    assert.match(refused.stderr, /HUB_INSTALL_REFUSED current stays on v1\.2\.60 \(/);
    assert.match(refused.stderr, /v1\.2\.58 \(/);
    assert.match(refused.stderr, /--allow-downgrade/);
    assert.equal(w.current(), 'releases/v1.2.60');
    assert.ok(!existsSync(join(w.share, 'releases/v1.2.58')), 'nothing was copied');
  } finally { w.cleanup(); }
});

test('--allow-downgrade (or HUB_ALLOW_DOWNGRADE=1) moves current back on purpose and says so', linux, () => {
  const w = world();
  try {
    w.at(2);
    assert.equal(w.install(['v1.2.60']).status, 0);
    w.at(0);
    const flagged = w.install(['--allow-downgrade', 'v1.2.58']);
    assert.equal(flagged.status, 0, flagged.stdout + flagged.stderr);
    assert.match(flagged.stdout, /HUB_INSTALL_DOWNGRADE current moves back from v1\.2\.60 \(.*\) to v1\.2\.58/);
    assert.equal(w.current(), 'releases/v1.2.58');
    w.at(2);
    assert.equal(w.install(['v1.2.60']).status, 0, 'forward again');
    w.at(1);
    const env = w.install(['main-c2'], undefined, { HUB_ALLOW_DOWNGRADE: '1' });
    assert.equal(env.status, 0, env.stdout + env.stderr);
    assert.equal(w.current(), 'releases/main-c2');
  } finally { w.cleanup(); }
});

test('a legacy install with no record is ordered by its ref name: main-<sha> and a tag both count', linux, () => {
  const w = world();
  try {
    w.at(0);
    const early = w.shas[0].slice(0, 7);
    // current points at a legacy release copy named for commit 3, with no .hub-commit.
    mkdirSync(join(w.share, 'releases', `main-${w.shas[2].slice(0, 7)}`), { recursive: true });
    symlinkSync(`releases/main-${w.shas[2].slice(0, 7)}`, join(w.share, 'current'));
    const refused = w.install([`main-${early}`]);
    assert.equal(refused.status, 3, refused.stdout + refused.stderr);
    assert.match(refused.stderr, new RegExp(`current stays on main-${w.shas[2].slice(0, 7)} `));
    git(w.repo, 'tag', 'v9.9.9', w.shas[2]);
    unlinkSync(join(w.share, 'current'));
    mkdirSync(join(w.share, 'releases/v9.9.9'), { recursive: true });
    symlinkSync('releases/v9.9.9', join(w.share, 'current'));
    assert.equal(w.install([`main-${early}`]).status, 3, 'a tag names its commit too');
  } finally { w.cleanup(); }
});

test('without git on the installing side, the recorded commit counts order the install', linux, () => {
  const w = world();
  try {
    w.at(2);
    assert.equal(w.install(['main-c3']).status, 0);
    // A release copy with no git (like the Mac's) that says it is commit 1 of 1 and was never installed.
    const old = join(w.share, 'releases/v1.2.58');
    cpSync(join(w.repo, 'tools'), join(old, 'tools'), { recursive: true });
    writeFileSync(join(old, '.hub-commit'), `commit=${'0'.repeat(40)}\ncount=1\n`);
    // HOME is not a repo and HUB_REPO is not set, so ancestry cannot be asked: the counts decide.
    const refused = w.install(['v1.2.58'], join(old, 'tools/catchup/units/install.sh'), { HUB_REPO: join(w.root, 'nowhere') });
    assert.equal(refused.status, 3, refused.stdout + refused.stderr);
    assert.equal(w.current(), 'releases/main-c3');
  } finally { w.cleanup(); }
});

test('when neither side can be ordered it installs, and says it could not check', linux, () => {
  const w = world();
  try {
    mkdirSync(join(w.share, 'releases/mystery'), { recursive: true });
    symlinkSync('releases/mystery', join(w.share, 'current'));
    w.at(0);
    const done = w.install(['main-c1']);
    assert.equal(done.status, 0, done.stdout + done.stderr);
    assert.match(done.stderr, /HUB_INSTALL_UNVERIFIED/);
    assert.equal(w.current(), 'releases/main-c1');
  } finally { w.cleanup(); }
});
