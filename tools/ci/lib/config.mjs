// Argument handling. Inputs arrive as HUB_* environment variables (the composite action maps its inputs there, so no
// workflow expression is ever spliced into a shell line) and flags override them for local use. Every default is the
// safe one: dry run, strict, no store lanes, the policy's runners and manifest.
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { levels } from './version.mjs';

export const commands = Object.freeze(['gate', 'preflight-ios', 'plan', 'android', 'play', 'release', 'ios-export', 'ios', 'deliver', 'announce']);
export const platforms = Object.freeze(['both', 'android', 'ios']);
export const channels = Object.freeze(['sideload', 'play']);
export const playStatuses = Object.freeze(['draft', 'completed', 'inProgress', 'halted']);
export const meteredModes = Object.freeze(['auto', 'allow']);
// The gate's verdict on the iPad lane: run it, or skip it because the Mac is offline, over its data budget on a
// metered link, or out of the platform's scope.
export const iosLanes = Object.freeze(['run', 'skip-offline', 'skip-metered', 'skip-platform']);
export const macLinks = Object.freeze(['home', 'metered', 'offline', 'unknown']);

const flags = Object.freeze({
  '--manifest': 'manifest',
  '--platform': 'platform',
  '--channel': 'channel',
  '--track': 'track',
  '--play-status': 'playStatus',
  '--build': 'build',
  '--dry-run': 'dryRun',
  '--dry-handoff': 'dryHandoff',
  '--strict': 'strict',
  '--out': 'out',
  '--version': 'version',
  '--android-code': 'androidCode',
  '--ios-build': 'iosBuild',
  '--bump': 'bump',
  '--testflight': 'testflight',
  '--play': 'play',
  '--build-sha': 'buildSha',
  '--bump-patch': 'bumpPatch',
  '--ipad-version': 'ipadVersion',
  '--ipad-build': 'ipadBuild',
  '--metered': 'metered',
  '--ios-lane': 'iosLane',
  '--mac-link': 'macLink',
  '--bundle': 'bundle',
  '--slug': 'slug',
  '--ios-store': 'iosStore',
  '--linux-runner': 'linuxRunner',
  '--mac-runner': 'macRunner',
});

const environment = Object.freeze({
  manifest: 'HUB_MANIFEST',
  platform: 'HUB_PLATFORM',
  channel: 'HUB_CHANNEL',
  track: 'HUB_TRACK',
  playStatus: 'HUB_PLAY_STATUS',
  build: 'HUB_BUILD',
  dryRun: 'HUB_DRY_RUN',
  dryHandoff: 'HUB_DRY_HANDOFF',
  strict: 'HUB_STRICT',
  out: 'HUB_OUT',
  version: 'HUB_VERSION',
  androidCode: 'HUB_ANDROID_CODE',
  iosBuild: 'HUB_IOS_BUILD',
  bump: 'HUB_BUMP',
  testflight: 'HUB_TESTFLIGHT',
  play: 'HUB_PLAY',
  buildSha: 'HUB_BUILD_SHA',
  bumpPatch: 'HUB_BUMP_PATCH',
  ipadVersion: 'HUB_IPAD_VERSION',
  ipadBuild: 'HUB_IPAD_BUILD',
  metered: 'HUB_METERED',
  iosLane: 'HUB_IOS_LANE',
  macLink: 'HUB_MAC_LINK',
  bundle: 'HUB_BUNDLE',
  slug: 'HUB_SLUG',
  iosStore: 'HUB_IOS_STORE',
  linuxRunner: 'HUB_LINUX_RUNNER',
  macRunner: 'HUB_MAC_RUNNER',
});

function bool(name, value, fallback) {
  if (value === undefined || value === '') return fallback;
  if (value === 'true' || value === true) return true;
  if (value === 'false' || value === false) return false;
  throw new Error(`${name} must be true or false, got "${value}"`);
}

function oneOf(name, value, allowed) {
  if (!allowed.includes(value)) throw new Error(`${name} must be one of ${allowed.join(', ')}, got "${value}"`);
  return value;
}

function matching(name, value, pattern, what) {
  const found = value ?? '';
  if (found !== '' && !pattern.test(found)) throw new Error(`${name} must be ${what}, got "${String(found).slice(0, 40)}"`);
  return found;
}

function labels(name, value, fallback) {
  const text = value === undefined || value === '' ? fallback : value;
  let parsed;
  try { parsed = JSON.parse(text); } catch { throw new Error(`${name} must be a JSON array of runner labels`); }
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.some(label => typeof label !== 'string' || !/^[A-Za-z0-9_.-]+$/.test(label))) throw new Error(`${name} must be a JSON array of runner labels`);
  return parsed;
}

// The testflight half of the manifest the gate hands preflight-ios (which has no checkout): signer and op:// refs.
function iosStore(value) {
  if (value === undefined || value === '') return null;
  let store;
  try { store = JSON.parse(value); } catch { throw new Error('ios store must be JSON'); }
  if (store === null) return null;
  if (typeof store !== 'object' || Array.isArray(store)) throw new Error('ios store must be an object');
  for (const key of Object.keys(store)) if (!['signer_sha1', 'secrets'].includes(key)) throw new Error(`ios store has unknown key "${key}"`);
  if (store.signer_sha1 !== undefined && store.signer_sha1 !== null && !/^[0-9A-F]{40}$/.test(store.signer_sha1)) throw new Error('ios store signer_sha1 must be an uppercase SHA-1');
  // 1Password references may hold spaces (op://DeLoSecrets/App Store Connect API Key/key_id); never a line break.
  if (!Array.isArray(store.secrets ?? []) || (store.secrets ?? []).some(ref => typeof ref !== 'string' || !/^op:\/\/[^\r\n\0]+$/.test(ref))) throw new Error('ios store secrets must be op:// references');
  return { signer_sha1: store.signer_sha1 ?? null, secrets: store.secrets ?? [] };
}

export function parseConfig(argv, env = process.env) {
  const [command, ...rest] = argv;
  if (!commands.includes(command)) throw new Error(`Usage: hub.mjs <${commands.join('|')}> [${Object.keys(flags).join(' <value>] [')} <value>]`);
  const raw = {};
  for (const [key, name] of Object.entries(environment)) if (env[name] !== undefined) raw[key] = env[name];
  for (let index = 0; index < rest.length; index += 2) {
    const key = flags[rest[index]];
    if (!key) throw new Error(`Unknown option ${rest[index]}`);
    if (rest[index + 1] === undefined) throw new Error(`${rest[index]} needs a value`);
    raw[key] = rest[index + 1];
  }
  const build = raw.build ?? '';
  if (build !== '' && !/^[1-9]\d{0,8}$/.test(build)) throw new Error(`build must be a positive integer, got "${build}"`);
  const track = raw.track || 'internal';
  if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(track)) throw new Error(`track must be a Play track name, got "${track}"`);
  const manifest = raw.manifest || 'mobile-deploy.json';
  if (manifest.startsWith('/') || manifest.split('/').includes('..')) throw new Error('manifest must be a path inside the app checkout');
  const androidCode = raw.androidCode ?? '';
  if (androidCode !== '' && !/^[1-9]\d{0,9}$/.test(androidCode)) throw new Error(`android code must be a positive integer, got "${androidCode}"`);
  const bumpPatch = matching('bump_patch', raw.bumpPatch, /^[A-Za-z0-9+/=]{0,700000}$/, 'base64');
  return {
    command,
    manifest,
    platform: oneOf('platform', raw.platform || 'both', platforms),
    channel: oneOf('android channel', raw.channel || 'sideload', channels),
    track,
    playStatus: oneOf('play status', raw.playStatus || 'draft', playStatuses),
    build,
    dryRun: bool('dry_run', raw.dryRun, true),
    dryHandoff: bool('dry_handoff', raw.dryHandoff, false),
    strict: bool('strict', raw.strict, true),
    bump: oneOf('bump', raw.bump || 'patch', levels),
    testflight: bool('testflight', raw.testflight, false),
    play: bool('play', raw.play, false),
    out: raw.out || join(env.RUNNER_TEMP || tmpdir(), 'hub-out'),
    version: matching('version', raw.version, /^\d+\.\d+\.\d+$/, 'X.Y.Z'),
    androidCode,
    iosBuild: matching('ios build', raw.iosBuild, /^[1-9]\d{0,8}$|^\d+\.\d+(\.\d+)?$/, 'a build number'),
    buildSha: matching('build sha', raw.buildSha, /^[0-9a-f]{40}$/, 'a 40-character commit sha'),
    bumpPatch,
    ipadVersion: matching('ipad version', raw.ipadVersion, /^[0-9A-Za-z.+-]{1,40}$/, 'a version'),
    ipadBuild: matching('ipad build', raw.ipadBuild, /^[0-9A-Za-z.+-]{1,40}$/, 'a build'),
    metered: oneOf('metered', raw.metered || 'auto', meteredModes),
    iosLane: raw.iosLane ? oneOf('ios lane', raw.iosLane, iosLanes) : '',
    macLink: raw.macLink ? oneOf('mac link', raw.macLink, macLinks) : '',
    bundle: matching('bundle', raw.bundle, /^[A-Za-z][A-Za-z0-9-]*(\.[A-Za-z][A-Za-z0-9-]*)+$/, 'a reverse-DNS bundle id'),
    slug: matching('slug', raw.slug, /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/, 'a pjangler slug'),
    iosStore: iosStore(raw.iosStore),
    linuxRunner: labels('linux_runner', raw.linuxRunner, '["self-hosted","Linux"]'),
    macRunner: labels('mac_runner', raw.macRunner, '["self-hosted","macOS"]'),
    cwd: process.cwd(),
  };
}

// Every variable that can mint or carry a credential. The runner puts the OIDC pair in each step's environment
// whenever the job holds id-token: write (the android job always does, dry runs included), and they can mint a
// federated Google token, so they stop here with the store and GitHub tokens. MC_HOST_* (an mc alias with its keys)
// is a credential wherever it appears: only the hub's own mc child ever gets one.
export const credentialVariables = Object.freeze([
  'PLAY_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN',
  'ACTIONS_ID_TOKEN_REQUEST_URL', 'ACTIONS_ID_TOKEN_REQUEST_TOKEN', 'ACTIONS_RUNTIME_TOKEN',
]);
export const isCredentialVariable = name => credentialVariables.includes(name) || /^MC_HOST_/.test(name);

// Files the runner reads back after a step: an app hook gets throwaway copies, so it cannot set job outputs, add
// environment variables or change PATH for the hub's own later steps.
export const jobControlFiles = Object.freeze(['GITHUB_ENV', 'GITHUB_OUTPUT', 'GITHUB_PATH', 'GITHUB_STATE']);

const sinks = new Map();
function sinkFiles(out) {
  if (!sinks.has(out)) {
    const dir = join(out, '.hook-sink', String(process.pid));
    mkdirSync(dir, { recursive: true });
    const files = Object.fromEntries(jobControlFiles.map(name => {
      const file = join(dir, name.toLowerCase());
      writeFileSync(file, '');
      return [name, file];
    }));
    sinks.set(out, files);
  }
  return sinks.get(out);
}

// The environment every hook sees. Nothing from an event payload; only values validated above. Store, GitHub, OIDC
// and MinIO credentials never reach a hook, and the job-control files are throwaway copies.
export function hookEnvironment(config, base = process.env, extra = {}) {
  const rest = {};
  for (const [name, value] of Object.entries(base)) if (!isCredentialVariable(name) && !/^GIT_CONFIG_(COUNT|KEY_\d+|VALUE_\d+)$/.test(name)) rest[name] = value;
  return {
    ...rest,
    ...sinkFiles(config.out),
    HUB_OUT: config.out,
    HUB_BUILD: config.build,
    HUB_DRY_RUN: String(config.dryRun),
    HUB_CHANNEL: config.channel,
    HUB_VERSION: config.version ?? '',
    HUB_ANDROID_CODE: config.androidCode ?? '',
    HUB_IOS_BUILD: config.iosBuild ?? '',
    HUB_TESTFLIGHT: String(config.testflight ?? false),
    ...extra,
  };
}
