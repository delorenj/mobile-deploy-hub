// The deploy path never reaches v1b code (AD-25, FR-22): nothing under tools/ci/commands or tools/catchup may import, directly or
// through anything it imports, the Claims library, the Registry, the Hub API, the Host Agent or the hub client. A service that is
// down, wrong or absent can then never touch a deploy. The two tables are exported data: a later story adds its own path to
// FORBIDDEN (or a directory to DEPLOY_PATH) and the one check below covers it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Directories whose non-test .mjs files are the deploy path's entry points (relative to the repo root).
export const DEPLOY_PATH = Object.freeze(['tools/ci/commands', 'tools/catchup']);
// What the deploy path must never reach: a file, or a directory (trailing slash) with everything under it.
export const FORBIDDEN = Object.freeze(['tools/device/claims.mjs', 'tools/registry/', 'tools/hub-api/', 'tools/host-agent/', 'tools/hub-client.mjs']);

const repoRoot = resolve(fileURLToPath(new URL('../', import.meta.url)));

// Relative specifiers of static imports, re-exports and literal dynamic imports (with or without an options argument). A computed dynamic import is not a literal
// and cannot be followed; the deploy path has none.
export function importsOf(source) {
  const found = new Set();
  const patterns = [/\b(?:import|export)\s+(?:[^'"()]*?\s+from\s+)?['"]([^'"]+)['"]/g, /\bimport\s*\(\s*['"]([^'"]+)['"]\s*[,)]/g];
  for (const pattern of patterns) for (const match of source.matchAll(pattern)) if (match[1].startsWith('.')) found.add(match[1]);
  return [...found];
}

const isFile = path => { try { return statSync(path).isFile(); } catch { return false; } };
const entriesOf = (root, dir) => {
  try { return readdirSync(join(root, dir)).filter(name => name.endsWith('.mjs') && !name.endsWith('.test.mjs')).map(name => join(root, dir, name)); } catch { return []; }
};
const forbiddenHit = (root, path, forbidden) => {
  const rel = relative(root, path).split('\\').join('/');
  return forbidden.find(item => (item.endsWith('/') ? rel.startsWith(item) : rel === item)) ?? null;
};

// Every file reachable from the deploy path's entry points that is FORBIDDEN, with the chain of imports that reaches it.
export function violations(root, { deployPath = DEPLOY_PATH, forbidden = FORBIDDEN } = {}) {
  const found = [];
  const seen = new Set();
  const queue = deployPath.flatMap(dir => entriesOf(root, dir)).map(file => ({ file, chain: [relative(root, file)] }));
  while (queue.length > 0) {
    const { file, chain } = queue.shift();
    if (seen.has(file)) continue;
    seen.add(file);
    let source;
    try { source = readFileSync(file, 'utf8'); } catch { continue; }
    for (const specifier of importsOf(source)) {
      // A `?query` or `#hash` names the same file.
      const target = resolve(dirname(file), specifier.replace(/[?#].*$/, ''));
      const hit = forbiddenHit(root, target, forbidden);
      if (hit) { found.push({ forbidden: hit, chain: [...chain, relative(root, target)] }); continue; }
      if (isFile(target)) queue.push({ file: target, chain: [...chain, relative(root, target)] });
    }
  }
  return found;
}

test('the deploy path tables are frozen data that name the v1b code', () => {
  assert.ok(Object.isFrozen(DEPLOY_PATH) && Object.isFrozen(FORBIDDEN));
  assert.deepEqual([...DEPLOY_PATH], ['tools/ci/commands', 'tools/catchup']);
  for (const path of ['tools/device/claims.mjs', 'tools/registry/', 'tools/hub-api/', 'tools/host-agent/', 'tools/hub-client.mjs']) assert.ok(FORBIDDEN.includes(path), path);
});

test('the live deploy path imports nothing forbidden, directly or transitively', () => {
  const root = repoRoot;
  assert.ok(DEPLOY_PATH.every(dir => existsSync(join(root, dir))), 'every scanned directory exists');
  assert.ok(DEPLOY_PATH.flatMap(dir => entriesOf(root, dir)).length > 5, 'the scan sees the deploy commands');
  assert.deepEqual(violations(root), []);
});

test('importsOf reads static, re-export, side-effect and literal dynamic imports, relative only', () => {
  const source = `import a from './a.mjs';\nimport { b } from "../b.mjs";\nimport './c.mjs';\nexport * from './d.mjs';\nexport { e } from './e.mjs';\nconst f = await import('./f.mjs');\nconst j = await import('./j.json', { with: { type: 'json' } });\nimport k from './k.mjs?v=1';\nimport fs from 'node:fs';\nimport pkg from 'pkg';\nimport {\n  g,\n  h,\n} from './g.mjs';\n`;
  assert.deepEqual(importsOf(source).sort(), ['../b.mjs', './a.mjs', './c.mjs', './d.mjs', './e.mjs', './f.mjs', './g.mjs', './j.json', './k.mjs?v=1']);
});

function fixture(files) {
  const root = mkdtempSync(join(tmpdir(), 'deploy-path-'));
  for (const [path, source] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), source);
  }
  return root;
}

test('a fixture that reaches a forbidden path is caught: directly, through a lib, by a dynamic import, in a directory', () => {
  const cases = {
    direct: { 'tools/ci/commands/a.mjs': "import { take } from '../../device/claims.mjs';\n", 'tools/device/claims.mjs': 'export const take = 1;\n' },
    transitive: { 'tools/ci/commands/a.mjs': "import { x } from '../lib/x.mjs';\n", 'tools/ci/lib/x.mjs': "import { y } from '../../device/y.mjs';\nexport const x = y;\n", 'tools/device/y.mjs': "export { take as y } from './claims.mjs';\n", 'tools/device/claims.mjs': 'export const take = 1;\n' },
    dynamic: { 'tools/catchup/c.mjs': "const mod = await import('../hub-client.mjs');\n" },
    options: { 'tools/catchup/c.mjs': "const mod = await import('../hub-client.mjs', { with: { type: 'javascript' } });\n" },
    query: { 'tools/catchup/c.mjs': "import '../hub-client.mjs?cache=1';\n" },
    hash: { 'tools/ci/commands/a.mjs': "import { take } from '../../device/claims.mjs#x';\n", 'tools/device/claims.mjs': 'export const take = 1;\n' },
    directory: { 'tools/catchup/c.mjs': "import '../registry/match.mjs';\n" },
    api: { 'tools/ci/commands/a.mjs': "import '../../hub-api/server.mjs';\n" },
    agent: { 'tools/ci/commands/a.mjs': "import '../../host-agent/agent.mjs';\n" },
  };
  for (const [name, files] of Object.entries(cases)) {
    const root = fixture(files);
    try {
      const found = violations(root);
      assert.equal(found.length, 1, name);
      assert.ok(found[0].chain.length >= 2, `${name}: the chain names how it got there`);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});

test('a clean fixture passes, a test file or an unscanned directory is not an entry point, and a table can be extended', () => {
  const root = fixture({
    'tools/ci/commands/a.mjs': "import { x } from '../lib/x.mjs';\nimport fs from 'node:fs';\n",
    'tools/ci/lib/x.mjs': 'export const x = 1;\n',
    'tools/ci/commands/a.test.mjs': "import '../../device/claims.mjs';\n",
    'tools/device/hub-device.mjs': "import './claims.mjs';\n",
    'tools/device/claims.mjs': 'export const take = 1;\n',
  });
  try {
    assert.deepEqual(violations(root), []);
    // A later story adds a path: the same check covers it.
    writeFileSync(join(root, 'tools/ci/lib/x.mjs'), "import '../../newthing/z.mjs';\n");
    assert.deepEqual(violations(root), []);
    assert.equal(violations(root, { forbidden: [...FORBIDDEN, 'tools/newthing/'] }).length, 1);
    assert.equal(violations(root, { deployPath: ['tools/device'] }).length, 1, 'a directory added to DEPLOY_PATH is scanned');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
