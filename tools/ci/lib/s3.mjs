// The build directory on MinIO (design v1.1, C). Only big-chungus writes it, over the loopback port the MinIO stack
// publishes (policy delivery.s3.write), as the MinIO user mobile-deploy-hub, whose policy can touch the builds bucket
// only. Its keys come from 1Password at call time and reach exactly one place: the MC_HOST_builds variable in the
// environment of the `mc` child process. Never argv, never a file, never GITHUB_ENV, never a log line. Everyone reads
// anonymously: phones and the iPad through https://s3.delo.sh/builds, this host through the loopback port.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isCredentialVariable } from './config.mjs';
import { attempt } from './exec.mjs';
import { compareBuild, compareSemver, latestKey, pageKey, parseLatest, publicUrl, serializeLatest } from './latest.mjs';
import { withLock } from './lock.mjs';
import { appPage, indexData, indexPage } from './pages.mjs';

// DeLoSecrets item "MinIO builds writer (mobile-deploy-hub)", by UUID (titles are not unique in the vault).
export const writerItem = 'op://DeLoSecrets/dfch6zwvscl3ootrcbkwbfelka';
export const writerRefs = Object.freeze({ access: `${writerItem}/username`, secret: `${writerItem}/credential` });
export const alias = 'builds';

export const contentTypes = Object.freeze({
  '.apk': 'application/vnd.android.package-archive',
  '.ipa': 'application/octet-stream',
  '.plist': 'text/xml',
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
});

export function contentTypeOf(key) {
  const match = /\.[a-z]+$/.exec(key);
  const type = match && contentTypes[match[0]];
  if (!type) throw new Error(`no content type for ${key}; the build directory holds only ${Object.keys(contentTypes).join(' ')}`);
  return type;
}

// Pointers and pages are revalidated on every read; versioned objects never change.
export const mutableKey = key => /(^|\/)(index\.html|index\.json|latest\.json|inflight\.json|manifest\.plist)$/.test(key) || key.startsWith('.probe/');
export const cacheControlOf = key => (mutableKey(key) ? 'no-cache' : 'public, max-age=31536000, immutable');

// mc --attr: ';' separates attributes, so values are double-quoted (Content-Type carries "; charset=utf-8").
export const attrOf = ({ contentType, cacheControl }) => `Content-Type="${contentType}";Cache-Control="${cacheControl}"`;

// One `op read` with a deadline. Asynchronous on purpose: an `op daemon` that inherits the stdout pipe would make a
// synchronous spawn wait on it; here the exit event settles the read even if the pipe stays open.
export function readSecret(ref, { env = process.env, timeoutMs = 45_000, spawnImpl = spawn } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try { child = spawnImpl('op', ['read', '--no-newline', ref], { env, stdio: ['ignore', 'pipe', 'pipe'] }); } catch (error) { reject(error); return; }
    let out = '';
    let err = '';
    let done = false;
    const finish = (error, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.stdout?.destroy();
      child.stderr?.destroy();
      if (error) reject(error); else resolve(value);
    };
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } finish(new Error(`op read ${ref} did not answer within ${Math.round(timeoutMs / 1000)}s`)); }, timeoutMs);
    child.stdout?.on('data', chunk => { out += chunk; });
    child.stderr?.on('data', chunk => { err += chunk; });
    child.on('error', error => finish(new Error(`op read ${ref} could not start (${error.code ?? error.message})`)));
    const settle = code => (code === 0 && out !== '' ? finish(null, out) : finish(new Error(`op read ${ref} failed: ${err.trim().split('\n').pop()?.slice(0, 200) || `exit ${code}`}`)));
    child.on('close', settle);
    child.on('exit', code => setTimeout(() => settle(code), 100));
  });
}

export async function writerCredentials({ env = process.env, read = readSecret } = {}) {
  const [access, secret] = await Promise.all([read(writerRefs.access, { env }), read(writerRefs.secret, { env })]);
  if (!/^[A-Za-z0-9._-]{3,128}$/.test(access) || secret.length < 8 || /[\s]/.test(secret)) throw new Error(`the 1Password item ${writerItem} does not hold a usable MinIO access key and secret`);
  return Object.freeze({ access, secret });
}

// The environment of one mc child: no runner token, no other MC_HOST_*, and the writer alias for the loopback endpoint.
export function mcEnvironment(base, credentials, endpoint) {
  const env = {};
  for (const [name, value] of Object.entries(base)) if (!isCredentialVariable(name)) env[name] = value;
  const url = new URL(endpoint);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1') throw new Error(`the build directory is written over loopback only, not ${endpoint}`);
  env[`MC_HOST_${alias}`] = `http://${encodeURIComponent(credentials.access)}:${encodeURIComponent(credentials.secret)}@${url.host}`;
  env.MC_NO_COLOR = '1';
  env.MC_DISABLE_PAGER = '1';
  return env;
}

// mc's own errors can echo its endpoint; the secret is cut out of anything that reaches a log or an exception.
const redact = (text, credentials) => (credentials?.secret ? String(text).split(credentials.secret).join('<redacted>') : String(text));

export function createS3({ policy, credentials, env = process.env, runner = attempt }) {
  const { bucket, write: endpoint } = policy.delivery.s3;
  const childEnv = mcEnvironment(env, credentials, endpoint);
  const target = key => {
    if (typeof key !== 'string' || key === '' || key.startsWith('/') || key.split('/').includes('..') || /[\s"'\\]/.test(key)) throw new Error(`bad object key "${key}"`);
    return `${alias}/${bucket}/${key}`;
  };
  const mc = (args, { timeout = 120_000, label } = {}) => {
    const result = runner('mc', ['--quiet', '--no-color', '--disable-pager', ...args], { env: childEnv, timeout });
    const output = redact(`${result.stdout ?? ''}${result.stderr ?? ''}`, credentials).trim();
    if (result.timedOut) throw new Error(`mc ${label ?? args[0]} timed out after ${Math.round(timeout / 1000)}s`);
    if (!result.ok) throw new Error(`mc ${label ?? args[0]} failed (exit ${result.status}): ${output.split('\n').slice(-3).join(' ').slice(0, 400)}`);
    return redact(result.stdout ?? '', credentials);
  };
  const api = {
    bucket,
    endpoint,
    // A file to one key, with its content type and cache policy set explicitly.
    put(file, key, { contentType = contentTypeOf(key), cacheControl = cacheControlOf(key), timeout = 30 * 60_000 } = {}) {
      mc(['cp', '--attr', attrOf({ contentType, cacheControl }), file, target(key)], { timeout, label: `cp ${key}` });
    },
    putText(text, key, options = {}) {
      const dir = mkdtempSync(join(tmpdir(), 'hub-s3-'));
      try {
        const file = join(dir, key.split('/').pop());
        writeFileSync(file, text);
        api.put(file, key, options);
      } finally { rmSync(dir, { recursive: true, force: true }); }
    },
    remove(key) { mc(['rm', '--force', target(key)], { label: `rm ${key}` }); },
    // Every object under a prefix: [{key, size, modified}], keys relative to the bucket.
    list(prefix) {
      if (!/^[a-z0-9][a-z0-9.-]*\/$/.test(prefix) && prefix !== '.probe/') throw new Error(`bad prefix "${prefix}"`);
      const out = mc(['ls', '--json', '--recursive', target(prefix)], { label: `ls ${prefix}` });
      return out.split('\n').filter(Boolean).map(line => JSON.parse(line)).filter(entry => entry.type === 'file' && typeof entry.key === 'string')
        .map(entry => ({ key: `${prefix}${entry.key}`, size: Number(entry.size) || 0, modified: entry.lastModified ?? null }));
    },
  };
  return api;
}

// The deploy jobs' writer. They write the real bucket only from a workflow job (or on purpose with HUB_S3_LOCAL=1): a
// test or a local hub command that forgot its fake must not reach 1Password and MinIO just because this host can.
// The catch-up reporter (a systemd unit, not a job) builds its own writer with writerCredentials and createS3.
export function assertJobContext(env = process.env) {
  if (env.GITHUB_ACTIONS === 'true' || env.HUB_S3_LOCAL === '1') return;
  throw new Error('the deploy jobs write the build directory only inside a workflow job; set HUB_S3_LOCAL=1 to do it from this shell on purpose');
}

export async function jobWriter(policy, env = process.env) {
  assertJobContext(env);
  return createS3({ policy, credentials: await writerCredentials({ env }), env });
}

// Anonymous reads over the loopback port (the bucket is public-read). A missing object is null.
export async function readObject(policy, key, { fetchImpl = fetch, base = policy.delivery.s3.write, timeoutMs = 20_000 } = {}) {
  const url = `${base.replace(/\/+$/, '')}/${policy.delivery.s3.bucket}/${key}`;
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs), headers: { 'Cache-Control': 'no-cache' } });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`GET ${key} from the build directory answered ${response.status}`);
  return response.text();
}

// The gate's write probe: put and delete builds/.probe/<run>, as the writer, before any version is spent.
export function probe(s3, run) {
  const key = `.probe/${String(run).replace(/[^0-9A-Za-z-]/g, '') || 'local'}`;
  s3.putText(`mobile-deploy-hub write probe ${new Date().toISOString()}\n`, key, { contentType: 'application/json', cacheControl: 'no-cache' });
  s3.remove(key);
  return key;
}

// ---------------------------------------------------------------------------------------------------- pages and retention

const semverFolder = /^\d+\.\d+\.\d+$/;

// The APK history an app page lists, newest first: [{version, code, url, bytes}].
export function historyOf(listing, policy, slug) {
  const pattern = new RegExp(`^${slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/(\\d+\\.\\d+\\.\\d+)/[^/]+-(\\d+)\\.apk$`);
  return listing.map(item => ({ item, match: pattern.exec(item.key) })).filter(entry => entry.match)
    .map(({ item, match }) => ({ version: match[1], code: Number(match[2]), url: publicUrl(policy.delivery.s3.public, item.key), bytes: item.size }))
    .sort((a, b) => compareSemver(b.version, a.version) || b.code - a.code)
    .slice(0, policy.delivery.s3.keep_apk);
}

// The app page, then (under the s3-index lock, shared by every app) index.json and index.html from every app's
// latest.json. deliver and the catch-up reporter both call this after they write latest.json, so the page always
// shows latest.json's device states (a per-run list would vanish on a catch-up re-render).
export async function publishPages({ s3, policy, slug, latest, fetchImpl = fetch, env = process.env }) {
  const history = historyOf(s3.list(`${slug}/`), policy, slug);
  s3.putText(appPage({ latest, history }), pageKey(slug));
  await withLock('s3-index', async () => {
    const apps = [];
    for (const app of Object.values(policy.apps)) {
      // Another app's unreadable pointer leaves that app off the index; it never stops this app's publish.
      try {
        const text = app.slug === slug ? serializeLatest(latest) : await readObject(policy, latestKey(app.slug), { fetchImpl });
        if (text) apps.push(parseLatest(text, { slug: app.slug }));
      } catch (error) {
        if (app.slug === slug) throw error;
        console.log(`::warning::${latestKey(app.slug)} is left off the index (${error.message.split('\n')[0]})`);
      }
    }
    s3.putText(`${JSON.stringify(indexData(apps), null, 2)}\n`, 'index.json');
    s3.putText(indexPage(apps), 'index.html');
  }, { env, timeoutMs: 10 * 60_000 });
}

// Retention (C2): the newest keep_apk APK versions per app and the newest keep_ipa IPAs (1: only the one latest.json
// names, so an older IPA URL is a 404 and OTA can never offer a downgrade). Version folders outside that set go
// entirely. Whatever latest.json names is never removed.
export function pruneVersions({ s3, policy, slug, latest, listing = null }) {
  const objects = listing ?? s3.list(`${slug}/`);
  const folderOf = key => key.split('/')[1];
  const apkVersions = [...new Set(objects.filter(item => item.key.endsWith('.apk')).map(item => folderOf(item.key)).filter(folder => semverFolder.test(folder)))]
    .sort((a, b) => compareSemver(b, a));
  const keep = new Set([...apkVersions.slice(0, policy.delivery.s3.keep_apk), latest.android?.version, latest.ios?.version].filter(Boolean));
  const ipaOrder = key => /-([0-9][0-9.]*)\.ipa$/.exec(key)?.[1] ?? '0';
  const ipas = objects.filter(item => item.key.endsWith('.ipa')).map(item => item.key)
    .sort((a, b) => compareSemver(folderOf(b), folderOf(a)) || compareBuild(ipaOrder(b), ipaOrder(a)));
  const keepIpas = new Set([latest.ios?.key, ...ipas.slice(0, Math.max(0, policy.delivery.s3.keep_ipa - (latest.ios?.key ? 1 : 0)))].filter(Boolean));
  const named = new Set([latest.android?.key, latest.ios?.key].filter(Boolean));
  const removed = [];
  for (const { key } of objects) {
    const folder = folderOf(key);
    if (!semverFolder.test(folder ?? '') || named.has(key)) continue;
    if (!keep.has(folder) || (key.endsWith('.ipa') && !keepIpas.has(key))) { s3.remove(key); removed.push(key); }
  }
  return removed;
}
