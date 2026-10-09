// The APK signer check. A debug-signed sideload APK only updates in place when its signer matches the
// installed one, so a mismatch fails the job. apksigner execs bare `java`, and the runner service has no
// JAVA_HOME or ANDROID_HOME (java is a mise shim that refuses an untrusted mise.toml inside _work), so the
// tool finds both itself, the way the app's own tools/project.mjs does.
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { run } from './exec.mjs';

const version = name => name.split('.').map(part => Number.parseInt(part, 10) || 0);

function newerFirst(a, b) {
  const [x, y] = [version(a), version(b)];
  for (let index = 0; index < Math.max(x.length, y.length); index += 1) if ((x[index] ?? 0) !== (y[index] ?? 0)) return (y[index] ?? 0) - (x[index] ?? 0);
  return 0;
}

export function androidSdk(env = process.env, home = homedir()) {
  return env.ANDROID_HOME || env.ANDROID_SDK_ROOT || join(home, 'Android/Sdk');
}

export function javaHome(env = process.env, home = homedir()) {
  if (env.JAVA_HOME) return env.JAVA_HOME;
  const mise = join(home, '.local/share/mise/installs/java/17.0.2');
  return existsSync(join(mise, 'bin/java')) ? mise : undefined;
}

export function findBuildTool(name, env = process.env, home = homedir()) {
  const tools = join(androidSdk(env, home), 'build-tools');
  let names = [];
  try { names = readdirSync(tools); } catch { /* reported below */ }
  const found = names.sort(newerFirst).map(entry => join(tools, entry, name)).find(path => existsSync(path));
  if (!found) throw new Error(`${name} not found under ${tools}; install Android build-tools or set ANDROID_HOME`);
  return found;
}

export const findApksigner = (env = process.env, home = homedir()) => findBuildTool('apksigner', env, home);

// `aapt2 dump badging`: the package line names the id, versionCode and versionName the APK really carries.
export function parseBadging(output) {
  const line = output.split('\n').find(entry => entry.startsWith('package: ')) ?? '';
  const field = name => new RegExp(`\\b${name}='([^']*)'`).exec(line)?.[1];
  const code = field('versionCode');
  return { package: field('name') ?? null, versionCode: code === undefined ? null : Number(code), versionName: field('versionName') ?? null };
}

// The built APK must be the planned version: a bump that did not reach the export would ship the old one.
export function apkIdentity({ apk, env = process.env, home = homedir() }) {
  return parseBadging(run(findBuildTool('aapt2', env, home), ['dump', 'badging', apk], { env }));
}

export function parseSigners(output) {
  return [...output.matchAll(/^Signer #\d+ certificate SHA-256 digest: ([0-9a-f]{64})\s*$/gim)].map(match => match[1].toLowerCase());
}

export function signerEnvironment(env = process.env, home = homedir()) {
  const java = javaHome(env, home);
  if (!java) return env;
  return { ...env, JAVA_HOME: java, PATH: `${join(java, 'bin')}${delimiter}${env.PATH ?? ''}` };
}

export function verifySigner({ apk, expected, env = process.env, home = homedir() }) {
  const output = run(findApksigner(env, home), ['verify', '--print-certs', apk], { env: signerEnvironment(env, home) });
  const signers = parseSigners(output);
  if (signers.length !== 1) throw new Error(`${apk} must carry exactly one signer, found ${signers.length}`);
  if (signers[0] !== expected.toLowerCase()) {
    throw new Error(`APK signer ${signers[0]} differs from the pinned ${expected}; phones could not update in place. Sign with the same keystore as the installed build.`);
  }
  return { signer_sha256: signers[0] };
}
