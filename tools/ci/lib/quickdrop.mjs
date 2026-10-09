// Quickdrop (design v1.1, D): the newest APK of each app in ~/quickdrop/builds on big-chungus, which Syncthing carries
// to Jarad's phones (on the S26 it is "already there" when it is back on Wi-Fi). Only the android job of a real run
// writes it. The APK is written under Syncthing's own temporary name (.syncthing.<name>.tmp, never synced), flushed,
// then renamed into place, and must be a regular file: a Syncthing symlink breaks an APK install. One APK per app;
// the folder's other files are Jarad's and are never touched.
import { closeSync, copyFileSync, fsyncSync, lstatSync, openSync, readdirSync, renameSync, rmSync, statSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export const hubApk = slug => new RegExp(`^${escape(slug)}-(\\d+)\\.(\\d+)\\.(\\d+)-(\\d+)\\.apk$`);

function fsyncPath(path, flags = 'r') {
  const fd = openSync(path, flags);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

export function dropApk({ apk, dir, name, slug, maxBytes, keep = 1, log = console.log }) {
  if (!hubApk(slug).test(name)) throw new Error(`quickdrop: ${name} is not a hub APK name for ${slug}`);
  const bytes = statSync(apk).size;
  if (bytes > maxBytes) {
    log(`HUB_QUICKDROP_SKIPPED ${bytes} bytes: ${name} is over the ${Math.round(maxBytes / 1e6)} MB cap (the S3 link still has it)`);
    return { status: 'skipped', bytes, path: null, removed: [] };
  }
  mkdirSync(dir, { recursive: true });
  const temp = join(dir, `.syncthing.${name}.tmp`);
  const final = join(dir, name);
  rmSync(temp, { force: true });
  try {
    copyFileSync(apk, temp);
    fsyncPath(temp, 'r+');
    renameSync(temp, final);
  } finally {
    rmSync(temp, { force: true });
  }
  try { fsyncPath(dir); } catch { /* a directory fsync is best effort on some filesystems */ }
  const info = lstatSync(final);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`quickdrop: ${final} is not a regular file after the rename`);
  if (info.size !== bytes) throw new Error(`quickdrop: ${final} has ${info.size} bytes, the APK has ${bytes}`);
  // Older hub APKs of this app, newest first by version and code; the folder's other files are left alone.
  const pattern = hubApk(slug);
  const order = file => pattern.exec(file).slice(1).map(Number);
  const mine = readdirSync(dir).filter(file => pattern.test(file) && file !== name)
    .sort((a, b) => { const [x, y] = [order(a), order(b)]; for (let i = 0; i < 4; i += 1) if (x[i] !== y[i]) return y[i] - x[i]; return 0; });
  const removed = mine.slice(Math.max(0, keep - 1));
  for (const file of removed) rmSync(join(dir, file), { force: true });
  log(`HUB_QUICKDROP ${name} ${bytes} bytes${removed.length > 0 ? `; removed ${removed.join(', ')}` : ''}`);
  return { status: 'written', bytes, path: final, removed };
}
