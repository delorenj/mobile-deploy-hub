#!/usr/bin/env node
// Obtainium check for any hub public edition (MOBI-14 index page). Proves, on an EMULATOR, that a buyer who adds the
// edition's index page to Obtainium gets the version the page advertises, the same APK a direct download gives, and that
// Obtainium follows the page (the source) instead of one pinned APK.
//
//   node tools/verify/obtainium-check.mjs <index-url> <package> <expected-version> --serial emulator-5554
//        [--out DIR] [--obtainium-apk FILE] [--signer SHA256HEX] [--keep-obtainium-data] [--name "Shown name"]
//
// It uninstalls <package> first, so the install it later reads back is Obtainium's own. It refuses any serial that is not
// an emulator (name emulator-NNNN and ro.kernel.qemu=1): a physical phone is never touched. Set ANDROID_ADB_SERVER_PORT to
// use a private adb server. Exit 0 = every check passed, 1 = a check failed, 2 = usage or setup error.
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { pathToFileURL } from 'node:url';

export const OBTAINIUM = { pkg: 'dev.imranr.obtainium', repo: 'ImranR98/Obtainium', signer: 'b353601f6a1d5fd6603ae2f50be80cf301367b86b6ab8b1f66243da96cd57362' };

// ---- pure helpers (unit-tested) ------------------------------------------------------------------------------------
export function apkLinks(html, base) {
  const out = [];
  for (const m of html.matchAll(/<a\b[^>]*\bhref\s*=\s*["']([^"']+)["']/gi)) {
    const href = m[1].replace(/&amp;/g, '&');
    let url; try { url = new URL(href, base); } catch { continue; }
    if (/\.apk$/i.test(url.pathname)) out.push(url.href);
  }
  return [...new Set(out)];
}

// The version sits in the APK file name ("...-0.1.11-1011.apk"). The lookahead keeps the whole match equal to the version, so
// Obtainium needs no "match group" setting (a plain capture group without that setting returns the whole match, dashes and all).
export function versionRegex(expectedVersion) {
  return String.raw`\d+\.\d+\.\d+(?=-\d+\.apk)`;
}

export function appLink({ url, pkg, name, author = 'Hub edition' }) {
  const app = { id: pkg, url, author, name, additionalSettings: JSON.stringify({ versionExtractionRegEx: versionRegex() }) };
  return 'obtainium://app/' + encodeURIComponent(JSON.stringify(app));
}

export function addLink(url) { return 'obtainium://add/' + url; }

export function parseNodes(xml) {
  const nodes = [];
  for (const m of xml.matchAll(/<node\b([^>]*?)\/?>/g)) {
    const attrs = {};
    for (const a of m[1].matchAll(/([\w-]+)="([^"]*)"/g)) attrs[a[1]] = a[2].replace(/&#10;/g, '\n').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
    const b = /\[(\d+),(\d+)\]\[(\d+),(\d+)\]/.exec(attrs.bounds || '');
    if (b) { attrs.cx = (+b[1] + +b[3]) >> 1; attrs.cy = (+b[2] + +b[4]) >> 1; }
    attrs.label = attrs.text || attrs['content-desc'] || '';
    nodes.push(attrs);
  }
  return nodes;
}

// "Not installed\n0.1.11 Latest" -> "0.1.11"; "0.1.11 Latest" after install, too.
export function resolvedVersion(nodes) {
  for (const n of nodes) { const m = /(?:^|\n)(\S+) Latest\s*$/.exec(n.label); if (m) return m[1]; }
  return null;
}

// ---- adb ---------------------------------------------------------------------------------------------------------
function main() {
  const args = process.argv.slice(2);
  const opt = (name, dflt) => { const i = args.indexOf(name); if (i < 0) return dflt; const v = args[i + 1]; args.splice(i, 2); return v; };
  const flag = name => { const i = args.indexOf(name); if (i < 0) return false; args.splice(i, 1); return true; };
  const serial = opt('--serial'); const out = opt('--out', join(process.cwd(), 'obtainium-check')); const obtApk = opt('--obtainium-apk');
  const signerPin = opt('--signer'); const name = opt('--name'); const keepData = flag('--keep-obtainium-data');
  const [indexUrl, pkg, expected] = args;
  const usage = 'usage: obtainium-check.mjs <index-url> <package> <expected-version> --serial emulator-NNNN [--out DIR] [--obtainium-apk FILE] [--signer SHA256] [--name NAME] [--keep-obtainium-data]';
  if (!indexUrl || !pkg || !expected || !serial) { console.error(usage); process.exit(2); }
  if (!/^emulator-\d+$/.test(serial)) { console.error(`refusing ${serial}: only emulator-NNNN serials are accepted`); process.exit(2); }
  mkdirSync(out, { recursive: true });

  const adbRaw = (a, o = {}) => spawnSync('adb', ['-s', serial, ...a], { encoding: o.binary ? 'buffer' : 'utf8', maxBuffer: 1 << 28, timeout: o.timeout ?? 120_000 });
  const adb = (...a) => { const r = adbRaw(a); if (r.status !== 0) throw new Error(`adb ${a.join(' ')}: ${r.stderr || r.stdout}`); return r.stdout; };
  const sh = cmd => adbRaw(['shell', cmd]).stdout.replace(/\r/g, '');
  const sleep = s => new Promise(r => setTimeout(r, s * 1000));
  const results = [];
  const check = (id, ok, detail) => { results.push({ id, ok: !!ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'} ${id}: ${detail}`); return ok; };
  const shot = file => writeFileSync(join(out, file), adbRaw(['exec-out', 'screencap', '-p'], { binary: true }).stdout);
  const focus = () => (/mCurrentFocus=Window\{\S+ \S+ ([^}\s]+)/.exec(sh('dumpsys window | grep mCurrentFocus')) || [])[1] || '';
  const dump = () => { for (let i = 0; i < 4; i++) { const r = sh('uiautomator dump /sdcard/oc.xml'); if (!/ERROR/.test(r)) return parseNodes(sh('cat /sdcard/oc.xml')); } return []; };
  const tap = n => adb('shell', 'input', 'tap', String(n.cx), String(n.cy));
  const find = (nodes, re) => nodes.find(n => re.test(n.label));
  const fire = uri => adb('shell', `am start -a android.intent.action.VIEW -d '${uri}' ${OBTAINIUM.pkg}`);
  const waitFor = async (re, secs = 30, then) => { const end = Date.now() + secs * 1000; while (Date.now() < end) { const nodes = dump(); const n = find(nodes, re); if (n) { if (then) then(n, nodes); return n; } await sleep(1.5); } return null; };

  return (async () => {
    // guards
    const devs = spawnSync('adb', ['devices'], { encoding: 'utf8' }).stdout;
    if (!new RegExp(`^${serial}\\s+device`, 'm').test(devs)) { console.error(`${serial} is not attached`); process.exit(2); }
    if (sh('getprop ro.kernel.qemu').trim() !== '1') { console.error(`${serial} is not an emulator (ro.kernel.qemu != 1)`); process.exit(2); }
    const abi = sh('getprop ro.product.cpu.abi').trim();

    // 1. what the page advertises and what a direct download gives (command execution, no phone)
    const html = await (await fetch(indexUrl)).text();
    const links = apkLinks(html, indexUrl);
    if (!check('index-one-apk-link', links.length === 1, `${links.length} .apk link(s) on the index page`)) return finish();
    const apkUrl = links[0]; const apkName = basename(new URL(apkUrl).pathname);
    const direct = Buffer.from(await (await fetch(apkUrl)).arrayBuffer());
    const directSha = createHash('sha256').update(direct).digest('hex');
    writeFileSync(join(out, 'direct.apk'), direct);
    check('index-apk-name-has-version', apkName.includes(`-${expected}-`), `${apkName} expected to carry -${expected}-`);
    const badging = spawnSync('aapt2', ['dump', 'badging', join(out, 'direct.apk')], { encoding: 'utf8' }).stdout || '';
    if (badging) check('direct-apk-identity', badging.includes(`name='${pkg}'`) && badging.includes(`versionName='${expected}'`), (badging.split('\n')[0] || '').slice(0, 120));
    check('regex-matches-link', new RegExp(versionRegex()).exec(apkName)?.[0] === expected, `regex ${versionRegex()} on ${apkName}`);

    // 2. Obtainium on the emulator
    if (!sh(`pm list packages ${OBTAINIUM.pkg}`).includes(OBTAINIUM.pkg)) {
      let apk = obtApk;
      if (!apk) {
        const rel = await (await fetch(`https://api.github.com/repos/${OBTAINIUM.repo}/releases/latest`)).json();
        const want = `app-${abi === 'arm64-v8a' ? 'arm64-v8a' : abi === 'armeabi-v7a' ? 'armeabi-v7a' : 'x86_64'}-release.apk`;
        const asset = rel.assets.find(a => a.name === want); const sha = rel.assets.find(a => a.name === `${want}.sha256`);
        if (!asset || !sha) { console.error(`no ${want} in Obtainium ${rel.tag_name}`); process.exit(2); }
        apk = join(out, want);
        const bytes = Buffer.from(await (await fetch(asset.browser_download_url)).arrayBuffer());
        const rsha = (await (await fetch(sha.browser_download_url)).text()).trim().split(/\s+/)[0];
        if (createHash('sha256').update(bytes).digest('hex') !== rsha) { console.error('Obtainium download does not match its .sha256'); process.exit(2); }
        writeFileSync(apk, bytes);
        console.log(`obtainium ${rel.tag_name} downloaded, sha256 matches the release`);
      }
      const cert = spawnSync('apksigner', ['verify', '--print-certs', apk], { encoding: 'utf8' }).stdout || '';
      if (cert && !cert.includes(OBTAINIUM.signer)) { console.error('Obtainium APK signer is not the pinned one'); process.exit(2); }
      adb('install', '-r', apk);
    }
    const obtVersion = (/versionName=(\S+)/.exec(sh(`dumpsys package ${OBTAINIUM.pkg}`)) || [])[1];
    check('obtainium-installed', !!obtVersion, `${OBTAINIUM.pkg} ${obtVersion}`);

    // 3. clean slate: the target must not be installed, and Obtainium starts fresh unless told otherwise
    adb('uninstall', pkg);
    if (!keepData) sh(`pm clear ${OBTAINIUM.pkg}`);
    sh('settings put global package_verifier_user_consent -1'); // emulator-only: no Play Protect scan dialog (it is a buyer-side step, see docs)
    sh(`am start -n ${OBTAINIUM.pkg}/.MainActivity`);
    await sleep(6);
    // first-run dialogs (Welcome, Note) and the notification prompt
    for (let i = 0; i < 6; i++) {
      const nodes = dump();
      const n = find(nodes, /^(Okay|Allow)$/);
      if (!n) { if (find(nodes, /^Apps$/)) break; await sleep(1.5); continue; }
      tap(n); await sleep(1.5);
    }
    shot('01-obtainium-ready.png');

    // 4a. the store's planned link: opens Add app with the URL filled in
    fire(addLink(indexUrl)); await sleep(5);
    const addNodes = dump();
    check('add-link-prefills-url', !!addNodes.find(n => n.label === indexUrl || n.label.startsWith(indexUrl)), 'Add app shows the index URL');
    check('add-link-html-options', !!find(addNodes, /Additional options for HTML/), 'Obtainium picked the HTML source type');
    shot('02-add-link.png');
    sh('input keyevent KEYCODE_BACK'); await sleep(1.5);

    // 4b. import link that carries the version rule
    const appName = name || `${pkg} (hub edition)`;
    fire(appLink({ url: indexUrl, pkg, name: appName })); 
    const imp = await waitFor(/^Continue$/, 20); if (!check('import-dialog', !!imp, 'Import app dialog appeared')) return finish();
    tap(imp); await sleep(3);
    fire(`obtainium://refresh?id=${pkg}`); await sleep(10);
    const tile = await waitFor(new RegExp(appName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 15); if (!check('app-listed', !!tile, `${appName} is in the app list`)) return finish();
    tap(tile); await sleep(3);
    const page = dump();
    const version = resolvedVersion(page); const apkLabel = page.find(n => /\.apk$/.test(n.label))?.label;
    shot('03-app-page-resolved.png');
    check('resolved-version', version === expected, `Obtainium resolved "${version}" (expected ${expected})`);
    check('selected-apk', !!apkLabel && apkLabel.endsWith(apkName), `Obtainium selected "${apkLabel}" (index page link: ${apkName})`);
    check('tracks-source', !!page.find(n => n.label === indexUrl) && !page.some(n => /^https?:.*\.apk$/.test(n.label)), 'app page shows the index page as its source, not an APK URL');

    // 5. install through Obtainium
    const inst = find(page, /^Install$/); if (!check('install-button', !!inst, 'Install button present')) return finish();
    tap(inst);
    const end = Date.now() + 120_000; let done = false;
    while (Date.now() < end && !done) {
      await sleep(2);
      const f = focus();
      if (sh(`pm list packages ${pkg}`).includes(pkg)) { done = true; break; }
      const nodes = dump();
      if (/PackageInstaller/i.test(f)) { const b = nodes.find(n => n.label === 'Install'); if (b) tap(b); }
      else if (/ManageAppExternalSources|ExternalSources|InstallUnknown/i.test(f) || find(nodes, /Allow from this source/)) {
        const sw = nodes.find(n => /Switch/.test(n.class || '') || /Allow from this source/.test(n.label)); if (sw) tap(sw); await sleep(1); sh('input keyevent KEYCODE_BACK');
      }
    }
    shot('04-after-install.png');
    check('installed', done, `${pkg} present on ${serial}`);

    // 6. read back what Android recorded
    const pk = sh(`dumpsys package ${pkg}`);
    const versionName = (/versionName=(\S+)/.exec(pk) || [])[1]; const installer = (/installerPackageName=(\S+)/.exec(pk) || [])[1];
    check('installed-versionName', versionName === expected, `dumpsys versionName=${versionName}`);
    check('installed-by-obtainium', installer === OBTAINIUM.pkg, `installerPackageName=${installer}`);
    const path = sh(`pm path ${pkg}`).trim().replace(/^package:/, '').split('\n')[0];
    const pulled = join(out, 'installed-base.apk'); adb('pull', path, pulled);
    const installedSha = createHash('sha256').update(readFileSync(pulled)).digest('hex');
    check('installed-apk-equals-direct-download', installedSha === directSha, `installed ${installedSha.slice(0, 16)}... direct ${directSha.slice(0, 16)}...`);
    const cert = spawnSync('apksigner', ['verify', '--print-certs', pulled], { encoding: 'utf8' }).stdout || '';
    const signer = (/certificate SHA-256 digest: ([0-9a-f]+)/i.exec(cert) || [])[1];
    if (signerPin) check('installed-signer', signer === signerPin.toLowerCase(), `signer ${signer}`); else console.log(`INFO installed-signer: ${signer || 'apksigner not available'}`);
    return finish({ obtainium: obtVersion, apkUrl, directSha, version, apkLabel, versionName, installer, signer });

    function finish(extra = {}) {
      const ok = results.length > 0 && results.every(r => r.ok);
      writeFileSync(join(out, 'result.json'), JSON.stringify({ ok, indexUrl, pkg, expected, serial, at: new Date().toISOString(), ...extra, checks: results }, null, 2));
      console.log(ok ? 'OBTAINIUM_CHECK_PASS' : 'OBTAINIUM_CHECK_FAIL');
      process.exit(ok ? 0 : 1);
    }
  })();
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main();
