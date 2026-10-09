// Quickdrop (design v1.1, D): the newest APK of each app in ~/quickdrop/builds on big-chungus, which Syncthing carries
// to Jarad's phones (on the S26 it is "already there" when it is back on Wi-Fi). Only the android job of a real run
// writes it. The APK is written under Syncthing's own temporary name (.syncthing.<name>.tmp, never synced), flushed,
// then renamed into place, and must be a regular file: a Syncthing symlink breaks an APK install. One APK per app;
// the folder's other files are Jarad's and are never touched.
//
// v1.1.3: never over a newer APK (a rerun of an older run leaves a newer one alone, and only older ones are removed),
// and only while big-chungus's Syncthing sees the S26 connected from the LAN. Syncthing on the phone pulls a new APK at
// once, and on cellular that is metered data (it was seen syncing over Verizon); away from home the S3 link is the
// "now" channel and the catch-up installs the build when the phone is back.
import { closeSync, copyFileSync, fsyncSync, lstatSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { inCidr } from './metered.mjs';

const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export const hubApk = slug => new RegExp(`^${escape(slug)}-(\\d+)\\.(\\d+)\\.(\\d+)-(\\d+)\\.apk$`);

function fsyncPath(path, flags = 'r') {
  const fd = openSync(path, flags);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

// [major, minor, patch, code] order of two hub APK names of one app.
function compareParts(x, y) {
  for (let index = 0; index < 4; index += 1) if (x[index] !== y[index]) return x[index] - y[index];
  return 0;
}

export function dropApk({ apk, dir, name, slug, maxBytes, keep = 1, log = console.log }) {
  const pattern = hubApk(slug);
  if (!pattern.test(name)) throw new Error(`quickdrop: ${name} is not a hub APK name for ${slug}`);
  const bytes = statSync(apk).size;
  if (bytes > maxBytes) {
    log(`HUB_QUICKDROP_SKIPPED ${bytes} bytes: ${name} is over the ${Math.round(maxBytes / 1e6)} MB cap (the S3 link still has it)`);
    return { status: 'skipped', reason: `over the ${Math.round(maxBytes / 1e6)} MB cap`, bytes, path: null, removed: [] };
  }
  const order = file => pattern.exec(file).slice(1).map(Number);
  const mine = order(name);
  let present = [];
  try { present = readdirSync(dir).filter(file => pattern.test(file) && file !== name); } catch { /* the folder is made below */ }
  const newer = present.filter(file => compareParts(order(file), mine) > 0);
  if (newer.length > 0) {
    log(`HUB_QUICKDROP_SKIPPED ${name}: Quickdrop already holds the newer ${newer.join(', ')}; an older build never replaces it`);
    return { status: 'skipped', reason: `Quickdrop holds the newer ${newer.join(', ')}`, bytes, path: null, removed: [] };
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
  // Older hub APKs of this app, newest first; the folder's other files (and anything newer) are left alone.
  const older = present.filter(file => compareParts(order(file), mine) < 0).sort((a, b) => compareParts(order(b), order(a)));
  const removed = older.slice(Math.max(0, keep - 1));
  for (const file of removed) rmSync(join(dir, file), { force: true });
  log(`HUB_QUICKDROP ${name} ${bytes} bytes${removed.length > 0 ? `; removed ${removed.join(', ')}` : ''}`);
  return { status: 'written', bytes, path: final, removed };
}

// big-chungus's Syncthing GUI (address and API key) from its own config, read at call time and used only for one
// loopback request; never logged.
export function syncthingGui({ home, read = path => readFileSync(path, 'utf8') }) {
  for (const path of [join(home, '.local/state/syncthing/config.xml'), join(home, '.config/syncthing/config.xml')]) {
    let text;
    try { text = read(path); } catch { continue; }
    const gui = /<gui\b([^>]*)>([\s\S]*?)<\/gui>/.exec(text);
    const address = gui && /<address>([^<]+)<\/address>/.exec(gui[2])?.[1]?.trim();
    const key = gui && /<apikey>([^<]+)<\/apikey>/.exec(gui[2])?.[1]?.trim();
    if (!address || !key) continue;
    const match = /^(.*):(\d+)$/.exec(address);
    if (!match) continue;
    const host = ['0.0.0.0', '', '[::]'].includes(match[1]) ? '127.0.0.1' : match[1];
    return { base: `${/\btls="true"/.test(gui[1]) ? 'https' : 'http'}://${host}:${match[2]}`, key };
  }
  return null;
}

// Whether the S26 would pull a Quickdrop APK for free right now: connected to big-chungus's Syncthing from inside the
// LAN. Anything else (not connected, a relay, the tailnet, a WAN address, Syncthing not answering) defers.
export async function s26OnLan({ deviceId, lanCidr, home, fetchImpl = fetch, gui = undefined }) {
  if (!deviceId) return { onLan: false, reason: 'devices.json names no Syncthing device for the S26' };
  const where = gui === undefined ? syncthingGui({ home }) : gui;
  if (!where) return { onLan: false, reason: "big-chungus's Syncthing config is not readable" };
  try {
    const response = await fetchImpl(`${where.base}/rest/system/connections`, { headers: { 'X-API-Key': where.key }, signal: AbortSignal.timeout(10_000) });
    if (!response.ok) return { onLan: false, reason: `Syncthing answered ${response.status}` };
    const entry = (await response.json())?.connections?.[deviceId];
    if (!entry?.connected) return { onLan: false, reason: 'the S26 is not connected to Syncthing' };
    const ip = /^([0-9.]+):\d+$/.exec(entry.address ?? '')?.[1] ?? null;
    if (ip && inCidr(ip, lanCidr)) return { onLan: true, reason: `the S26 syncs from ${ip} on the LAN` };
    return { onLan: false, reason: `the S26 syncs from ${entry.address || 'a relay'}, outside the LAN (Syncthing on the phone would pull it over cellular)` };
  } catch (error) {
    return { onLan: false, reason: `Syncthing did not answer (${String(error?.message ?? error).split('\n')[0].slice(0, 120)})` };
  }
}
