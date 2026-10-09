// Apple signing on the Mac for the iPad's development build: the export recipe, the IPA checks, the provisioning
// profile match and the signing probe.
//
// Recipe (proven by Tower build 4): the app's ios.device hook leaves an UNSIGNED archive (CODE_SIGNING_ALLOWED=NO,
// the team set), and the hub exports it with method `debugging` and signingStyle `automatic`, using the
// Xcode-managed profile and the development identity already on the Mac. The export never asks Xcode to create or
// refresh profiles (no provisioning-update flag): a refreshed wildcard profile changes its UUID under every app.
// Profiles are matched by team, iPad and certificate, never by UUID.
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statfsSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { runBounded } from './exec.mjs';

const pythonPlist = `
import base64, datetime, json, plistlib, sys
def conv(v):
    if isinstance(v, bytes): return {'$data': base64.b64encode(v).decode()}
    if isinstance(v, datetime.datetime):
        return {'$date': (v if v.tzinfo else v.replace(tzinfo=datetime.timezone.utc)).isoformat()}
    if isinstance(v, dict): return {k: conv(x) for k, x in v.items()}
    if isinstance(v, list): return [conv(x) for x in v]
    return v
with open(sys.argv[1], 'rb') as f:
    print(json.dumps(conv(plistlib.loads(f.read()))))
`;

const python = env => env.HUB_PYTHON || (existsSync('/usr/bin/python3') ? '/usr/bin/python3' : 'python3');

// Any plist (XML or binary) to JSON; data becomes {$data: base64}, dates {$date: ISO}. plutil cannot do this:
// its JSON output refuses data and dates, and a profile is full of both.
export function plistFile(path, { env = process.env, runner = runBounded } = {}) {
  return JSON.parse(runner(python(env), ['-I', '-c', pythonPlist, path], { env, timeout: 60_000, label: 'plist decode' }));
}

export function plistText(text, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'hub-plist-'));
  try {
    const file = join(dir, 'doc.plist');
    writeFileSync(file, text);
    return plistFile(file, options);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

const sha1 = bytes => createHash('sha1').update(bytes).digest('hex').toUpperCase();

export function profileFacts(profile) {
  const entitlements = profile.Entitlements ?? {};
  return {
    uuid: profile.UUID ?? null,
    name: profile.Name ?? null,
    team: profile.TeamIdentifier ?? [],
    expires_at: profile.ExpirationDate?.$date ?? null,
    devices: profile.ProvisionedDevices ?? [],
    provisions_all: profile.ProvisionsAllDevices === true,
    certificate_sha1s: (profile.DeveloperCertificates ?? []).map(cert => sha1(Buffer.from(cert.$data ?? '', 'base64'))),
    application_identifier: entitlements['application-identifier'] ?? null,
    get_task_allow: entitlements['get-task-allow'] === true,
    xcode_managed: profile.IsXcodeManaged === true,
  };
}

// application-identifier patterns: "TEAM.*", "TEAM.com.example.*" or an exact "TEAM.com.example.app".
export function appIdMatches(pattern, appId) {
  if (typeof pattern !== 'string') return false;
  const regex = new RegExp(`^${pattern.split('*').map(part => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
  return regex.test(appId);
}

// Why a profile cannot sign the iPad's development build of this bundle; empty when it can.
export function devProfileProblems(facts, { team, udid, signer, bundle, minDays = 0, now = Date.now() }) {
  const problems = [];
  if (facts.team.length !== 1 || facts.team[0] !== team) problems.push(`team ${facts.team.join(',') || '-'} is not ${team}`);
  if (!facts.devices.includes(udid)) problems.push('does not list the iPad');
  if (!facts.certificate_sha1s.includes(signer)) problems.push(`does not include the development certificate ${signer.slice(0, 8)}`);
  if (!facts.get_task_allow) problems.push('is not a development profile');
  if (bundle && !appIdMatches(facts.application_identifier, `${team}.${bundle}`)) problems.push(`application-identifier ${facts.application_identifier} does not cover ${bundle}`);
  const expires = Date.parse(facts.expires_at ?? '');
  if (!Number.isFinite(expires)) problems.push('has no expiry');
  else if (expires - now < minDays * 86_400_000) problems.push(`expires ${facts.expires_at.slice(0, 10)}, under ${minDays} days away`);
  return problems;
}

export const profileDirs = (home = homedir()) => [join(home, 'Library/Developer/Xcode/UserData/Provisioning Profiles'), join(home, 'Library/MobileDevice/Provisioning Profiles')];

export function installedProfiles({ env = process.env, home = homedir(), runner = runBounded } = {}) {
  const found = [];
  for (const dir of profileDirs(home)) {
    let names = [];
    try { names = readdirSync(dir).filter(name => name.endsWith('.mobileprovision')); } catch { continue; }
    for (const name of names) {
      try {
        found.push(profileFacts(plistText(runner('security', ['cms', '-D', '-i', join(dir, name)], { env, timeout: 30_000, label: 'security cms' }), { env, runner })));
      } catch { /* an unreadable profile cannot sign anything; the match below reports what is missing */ }
    }
  }
  return found;
}

// The development profile the export will use, chosen like Xcode would: team, iPad, certificate, bundle.
export function devProfile(profiles, criteria) {
  const usable = profiles.filter(facts => devProfileProblems(facts, criteria).length === 0);
  if (usable.length > 0) return usable.sort((a, b) => Date.parse(b.expires_at) - Date.parse(a.expires_at))[0];
  const reasons = profiles.map(facts => `${facts.name ?? facts.uuid}: ${devProfileProblems(facts, criteria).join('; ')}`);
  throw new Error(`no provisioning profile on this Mac can sign ${criteria.bundle} for the iPad with ${criteria.signer.slice(0, 8)} for ${criteria.minDays}+ days. Open the project in Xcode once to refresh the team profile.${reasons.length > 0 ? `\n${reasons.join('\n')}` : ' No profiles found.'}`);
}

export function identities({ env = process.env, runner = runBounded } = {}) {
  return new Set([...runner('security', ['find-identity', '-v', '-p', 'codesigning'], { env, timeout: 30_000, label: 'security find-identity' }).matchAll(/\b([0-9A-F]{40})\b/g)].map(match => match[1]));
}

// find-identity says the certificate is there; only signing proves the runner can use its private key. A locked
// login keychain or a key that wants an "allow" click makes codesign wait, so the probe has a deadline.
export function signingProbe({ signer, env = process.env, runner = runBounded, timeoutMs = 60_000, source = '/usr/bin/true' }) {
  const dir = mkdtempSync(join(tmpdir(), 'hub-signing-probe-'));
  try {
    const probe = join(dir, 'signing-probe');
    copyFileSync(source, probe);
    try {
      runner('codesign', ['--force', '--sign', signer, '--timestamp=none', probe], { env, timeout: timeoutMs, label: 'codesign signing probe' });
      runner('codesign', ['--verify', '--strict', probe], { env, timeout: 30_000, label: 'codesign verify probe' });
    } catch (error) {
      throw new Error(`the runner cannot sign with ${signer.slice(0, 8)}${error.timedOut ? `: codesign waited ${Math.round(timeoutMs / 1000)}s` : ''}. The login keychain is locked or the key wants an "Always Allow" for codesign: log in on the Mac, allow codesign on the key in Keychain Access, run again.\n${error.message.split('\n').slice(0, 4).join('\n')}`);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

export function freeGiB(path) {
  const stats = statfsSync(path);
  return (Number(stats.bavail) * Number(stats.bsize)) / 2 ** 30;
}

export function exportOptionsPlist({ team }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>method</key><string>debugging</string>
  <key>destination</key><string>export</string>
  <key>signingStyle</key><string>automatic</string>
  <key>teamID</key><string>${team}</string>
  <key>stripSwiftSymbols</key><true/>
  <key>manageAppVersionAndBuildNumber</key><false/>
</dict>
</plist>
`;
}

export function exportArgs({ archive, exportPath, optionsPlist }) {
  return ['-exportArchive', '-archivePath', archive, '-exportPath', exportPath, '-exportOptionsPlist', optionsPlist];
}

// The unsigned .xcarchive to a development-signed .ipa, with a deadline.
export function exportIpa({ archive, out, team, env = process.env, runner = runBounded, timeoutMs = 900_000 }) {
  const exportPath = join(out, 'export');
  mkdirSync(exportPath, { recursive: true });
  const optionsPlist = join(out, 'ExportOptions.plist');
  writeFileSync(optionsPlist, exportOptionsPlist({ team }));
  runner('xcodebuild', exportArgs({ archive, exportPath, optionsPlist }), { env, timeout: timeoutMs, label: 'xcodebuild -exportArchive' });
  const ipas = readdirSync(exportPath).filter(name => name.endsWith('.ipa'));
  if (ipas.length !== 1) throw new Error(`the export left ${ipas.length} .ipa files, expected one`);
  return join(exportPath, ipas[0]);
}

// Unpacks the IPA into `into` (kept: the install uses the .app) and checks it is the planned development build:
// bundle id, version, signature, entitlements, the embedded profile and the signer.
export function inspectIpa({ ipa, into, bundle, version, team, udid, signer, env = process.env, runner = runBounded, now = Date.now() }) {
  rmSync(into, { recursive: true, force: true });
  mkdirSync(into, { recursive: true });
  runner('unzip', ['-q', '-o', ipa, '-d', into], { env, timeout: 300_000, label: 'unzip ipa' });
  const payload = join(into, 'Payload');
  const apps = existsSync(payload) ? readdirSync(payload).filter(name => name.endsWith('.app')) : [];
  if (apps.length !== 1) throw new Error(`the IPA holds ${apps.length} apps in Payload, expected one`);
  const app = join(payload, apps[0]);
  const info = plistFile(join(app, 'Info.plist'), { env, runner });
  if (info.CFBundleIdentifier !== bundle) throw new Error(`the IPA is ${info.CFBundleIdentifier}, the manifest pins ${bundle}`);
  if (version && info.CFBundleShortVersionString !== version) throw new Error(`the IPA says version ${info.CFBundleShortVersionString} but the plan says ${version}`);
  if (!info.CFBundleVersion) throw new Error('the IPA has no CFBundleVersion');
  runner('codesign', ['--verify', '--deep', '--strict', app], { env, timeout: 180_000, label: 'codesign verify' });
  const entitlements = plistText(runner('codesign', ['-d', '--entitlements', ':-', app], { env, timeout: 60_000, label: 'codesign entitlements' }), { env, runner });
  if (entitlements['application-identifier'] !== `${team}.${bundle}`) throw new Error(`signed application-identifier ${entitlements['application-identifier']} is not ${team}.${bundle}`);
  if (entitlements['com.apple.developer.team-identifier'] !== team) throw new Error(`signed team ${entitlements['com.apple.developer.team-identifier']} is not ${team}`);
  if (entitlements['get-task-allow'] !== true) throw new Error('the IPA is not a development build (get-task-allow is not true); the iPad build must be exported with method debugging');
  const profile = profileFacts(plistText(runner('security', ['cms', '-D', '-i', join(app, 'embedded.mobileprovision')], { env, timeout: 30_000, label: 'security cms' }), { env, runner }));
  const certs = join(into, 'signer');
  runner('codesign', ['-d', `--extract-certificates=${certs}`, app], { env, timeout: 60_000, label: 'codesign extract certificates' });
  if (!existsSync(`${certs}0`)) throw new Error('codesign extracted no signing certificate');
  const actual = sha1(readFileSync(`${certs}0`));
  if (actual !== signer) throw new Error(`the IPA is signed by ${actual.slice(0, 8)}, not the development identity ${signer.slice(0, 8)}`);
  const problems = devProfileProblems(profile, { team, udid, signer, bundle, minDays: 0, now });
  if (problems.length > 0) throw new Error(`the embedded profile ${profile.name ?? profile.uuid} ${problems.join('; ')}`);
  return {
    app,
    bundle: info.CFBundleIdentifier,
    version: info.CFBundleShortVersionString,
    build: String(info.CFBundleVersion),
    signer: actual,
    profile: { uuid: profile.uuid, name: profile.name, expires_at: profile.expires_at, xcode_managed: profile.xcode_managed },
  };
}
