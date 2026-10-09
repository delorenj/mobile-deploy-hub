// The catch-up's reads of the build directory (design-hub-v1.1.md C): anonymous GETs of the pointers, and verified
// downloads of a build. The bucket is public, so no read needs a key. big-chungus reads through MinIO's loopback port,
// the Mac through https://s3.delo.sh (Cloudflare caps uploads at 100 MB, not downloads). The one write the catch-up
// makes, builds/<slug>/latest.json, goes through the hub's builds writer (tools/ci/lib/s3.mjs) on big-chungus.
import { createWriteStream, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { inflightKey, latestKey } from '../ci/lib/latest.mjs';
import { sha256File } from '../ci/lib/receipt.mjs';

const maxJsonBytes = 1_000_000;

// GET a small JSON object. null when it does not exist (nothing published yet). With a cache file, the request
// carries If-None-Match and a 304 reuses the cached body, so a pass over a metered link costs headers only.
//
// The tag must be the strong one: Cloudflare compresses a response for a client that accepts br or gzip and then
// answers with a weak W/"..." tag, and MinIO never matches a weak tag, so every pass downloaded the file again. The
// pointers are asked for uncompressed (they are a few KB), and any W/ left is stripped before it is sent back.
export const strongTag = tag => (typeof tag === 'string' && tag ? tag.replace(/^W\//, '') : null);

export async function readJson(url, { fetchImpl = globalThis.fetch, timeoutMs = 20_000, cacheFile } = {}) {
  let cached = null;
  if (cacheFile) {
    try { cached = JSON.parse(readFileSync(cacheFile, 'utf8')); } catch { cached = null; }
  }
  const headers = { 'accept-encoding': 'identity', ...(strongTag(cached?.etag) ? { 'if-none-match': strongTag(cached.etag) } : {}) };
  const response = await fetchImpl(url, { headers, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
  if (response.status === 304 && cached) return { value: cached.value, etag: cached.etag, lastModified: cached.lastModified ?? null, cached: true };
  if (response.status === 404) {
    await response.body?.cancel?.();
    if (cacheFile) rmSync(cacheFile, { force: true });
    return null;
  }
  if (!response.ok) {
    await response.body?.cancel?.();
    throw new Error(`GET ${url}: HTTP ${response.status}`);
  }
  const text = await response.text();
  if (text.length > maxJsonBytes) throw new Error(`GET ${url}: ${text.length} bytes is not a pointer file`);
  let value;
  try { value = JSON.parse(text); } catch { throw new Error(`GET ${url}: not JSON`); }
  const result = { value, etag: strongTag(response.headers.get('etag')), lastModified: response.headers.get('last-modified'), cached: false };
  if (cacheFile && result.etag) {
    mkdirSync(dirname(cacheFile), { recursive: true });
    writeFileSync(cacheFile, JSON.stringify({ etag: result.etag, lastModified: result.lastModified, value }));
  }
  return result;
}

// Streams a build to `dest` through a .part file and keeps it only when its size and sha256 equal what latest.json
// promised. A file already at `dest` with the right sha256 is reused, so a retry downloads nothing twice.
export async function downloadVerified(url, dest, { bytes, sha256, fetchImpl = globalThis.fetch, timeoutMs = 30 * 60_000 }) {
  if (!/^[0-9a-f]{64}$/.test(sha256 ?? '')) throw new Error(`no sha256 to check ${basename(url)} against`);
  try {
    if (statSync(dest).isFile() && await sha256File(dest) === sha256) return { path: dest, downloaded: 0 };
  } catch { /* not there yet */ }
  mkdirSync(dirname(dest), { recursive: true });
  const part = `${dest}.part`;
  rmSync(part, { force: true });
  const response = await fetchImpl(url, { redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok || !response.body) {
    await response.body?.cancel?.();
    throw new Error(`GET ${url}: HTTP ${response.status}`);
  }
  try {
    await pipeline(Readable.fromWeb(response.body), createWriteStream(part, { mode: 0o644 }));
    const size = statSync(part).size;
    if (Number.isSafeInteger(bytes) && size !== bytes) throw new Error(`${basename(url)} is ${size} bytes, latest.json says ${bytes}`);
    const digest = await sha256File(part);
    if (digest !== sha256) throw new Error(`${basename(url)} has sha256 ${digest.slice(0, 12)}..., latest.json says ${sha256.slice(0, 12)}...`);
    renameSync(part, dest);
    return { path: dest, downloaded: size };
  } finally {
    rmSync(part, { force: true });
  }
}

// The bucket as a pass sees it. `root` is the bucket's URL where reads go (http://127.0.0.1:9012/builds on
// big-chungus, https://s3.delo.sh/builds on the Mac); `writer` exists only on big-chungus.
export function createStore({ root, writer = null, fetchImpl = globalThis.fetch, cacheDir = null }) {
  const url = key => `${root.replace(/\/$/, '')}/${key}`;
  return {
    url,
    latest: async (slug, { fresh = false } = {}) => (await readJson(url(latestKey(slug)), { fetchImpl, cacheFile: !fresh && cacheDir ? join(cacheDir, `${slug}-latest.json`) : undefined }))?.value ?? null,
    inflight: async slug => {
      const found = await readJson(url(inflightKey(slug)), { fetchImpl, cacheFile: cacheDir ? join(cacheDir, `${slug}-inflight.json`) : undefined });
      return found ? { ...found.value, lastModified: found.lastModified } : null;
    },
    writeLatest: async (slug, latest) => {
      if (!writer) throw new Error('this host has no builds writer (only big-chungus writes latest.json)');
      await writer.putJson(latestKey(slug), latest);
    },
  };
}
