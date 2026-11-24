// checkDisk frees the Mac's stale per-project DerivedData before it refuses an iOS build (v1.2.48).
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkDisk, derivedDataDir, pruneDerivedData, pruneHeadroomGiB } from './commands/common.mjs';

const day = 86_400_000;
const now = Date.UTC(2026, 10, 24, 12);
const devices = { mac: { min_free_gib: 15 } };

function fixture(folders) {
  const home = mkdtempSync(join(tmpdir(), 'mdh-dd-'));
  const root = derivedDataDir(home);
  for (const [name, ageDays, { plist = true, size = 1 } = {}] of folders) {
    const dir = join(root, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'blob'), String(size));
    const at = new Date(now - ageDays * day);
    if (plist) { writeFileSync(join(dir, 'info.plist'), '<plist/>'); utimesSync(join(dir, 'info.plist'), at, at); }
    utimesSync(dir, at, at);
  }
  return { home, root, done: () => rmSync(home, { recursive: true, force: true }) };
}

const proj = (name, letters) => `${name}-${letters.repeat(28).slice(0, 28)}`;

test('pruneDerivedData removes only per-project folders unused for a day, oldest first, until enough', () => {
  const f = fixture([
    [proj('TowerOfLostThings', 'a'), 10],
    [proj('TowerOfLostThings', 'b'), 3],
    [proj('GibIosDrive', 'c'), 5, { plist: false }],
    [proj('Navi', 'd'), 0.2],
    ['ModuleCache.noindex', 30],
    ['SDKStatCaches.noindex', 30],
  ]);
  try {
    let calls = 0;
    const removed = pruneDerivedData({ home: f.home, now, enough: () => calls++ >= 2 });
    assert.deepEqual(removed, [proj('TowerOfLostThings', 'a'), proj('GibIosDrive', 'c')]);
    assert.ok(existsSync(join(f.root, proj('TowerOfLostThings', 'b'))));
    assert.ok(existsSync(join(f.root, proj('Navi', 'd'))), 'a folder used within a day stays');
    assert.ok(existsSync(join(f.root, 'ModuleCache.noindex')), 'shared caches stay');
    const rest = pruneDerivedData({ home: f.home, now });
    assert.deepEqual(rest, [proj('TowerOfLostThings', 'b')]);
    assert.ok(existsSync(join(f.root, proj('Navi', 'd'))));
    assert.ok(existsSync(join(f.root, 'SDKStatCaches.noindex')));
  } finally { f.done(); }
});

test('pruneDerivedData with no DerivedData folder does nothing', () => {
  assert.deepEqual(pruneDerivedData({ home: join(tmpdir(), 'mdh-dd-missing-home'), now }), []);
});

test('checkDisk with room prunes nothing', () => {
  const f = fixture([[proj('Tower', 'a'), 10]]);
  try {
    const lines = [];
    assert.equal(checkDisk(f.home, devices, { freeOf: () => 40, now, log: line => lines.push(line) }), 40);
    assert.ok(existsSync(join(f.root, proj('Tower', 'a'))));
    assert.deepEqual(lines, []);
  } finally { f.done(); }
});

test('checkDisk short of room prunes stale folders to the headroom and passes', () => {
  const f = fixture([[proj('Tower', 'a'), 10], [proj('Tower', 'b'), 8], [proj('Tower', 'c'), 6], [proj('Tower', 'd'), 0.1]]);
  try {
    const lines = [];
    // the fake disk: each stale folder removed frees 3 GiB, so two of them leave 20.9 >= 15 + the headroom
    assert.equal(pruneHeadroomGiB, 5);
    const gone = () => ['a', 'b', 'c'].filter(x => !existsSync(join(f.root, proj('Tower', x)))).length;
    const result = checkDisk(f.home, devices, { now, log: line => lines.push(line), freeOf: () => Math.round((14.9 + gone() * 3) * 10) / 10 });
    assert.equal(result, 20.9);
    assert.ok(!existsSync(join(f.root, proj('Tower', 'a'))));
    assert.ok(!existsSync(join(f.root, proj('Tower', 'b'))));
    assert.ok(existsSync(join(f.root, proj('Tower', 'c'))));
    assert.ok(existsSync(join(f.root, proj('Tower', 'd'))));
    assert.match(lines.join('\n'), /^HUB_DISK_PRUNED 2 DerivedData folder\(s\) unused for a day; 20\.9 GiB free now$/);
  } finally { f.done(); }
});

test('checkDisk still refuses when pruning cannot make room', () => {
  const f = fixture([[proj('Tower', 'a'), 0.1]]);
  try {
    assert.throws(() => checkDisk(f.home, devices, { now, freeOf: () => 14.9, log: () => {} }), /the Mac has 14\.9 GiB free; an iOS build needs 15 GiB/);
    assert.ok(existsSync(join(f.root, proj('Tower', 'a'))), 'a fresh folder is never removed');
  } finally { f.done(); }
});
