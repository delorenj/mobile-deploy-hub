// Argument handling. Inputs arrive as HUB_* environment variables (the composite action maps its inputs
// there, so no workflow expression is ever spliced into a shell line) and flags override them for local use.
// Every default is the safe one: dry run, sideload, no build override, no store lanes.
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { levels } from './version.mjs';

export const commands = Object.freeze(['plan', 'android', 'play', 'release', 'ios-export', 'ios-upload', 'preflight-ios', 'ios', 'announce']);
export const platforms = Object.freeze(['both', 'android', 'ios']);
export const channels = Object.freeze(['sideload', 'play']);
export const playStatuses = Object.freeze(['draft', 'completed', 'inProgress', 'halted']);

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
    cwd: process.cwd(),
  };
}

// Every variable that can mint or carry a credential. The runner puts the OIDC pair in each step's environment
// whenever the job holds id-token: write (the android job always does, dry runs included), and they can mint a
// federated Google token, so they stop here with the store and GitHub tokens.
export const credentialVariables = Object.freeze([
  'PLAY_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN',
  'ACTIONS_ID_TOKEN_REQUEST_URL', 'ACTIONS_ID_TOKEN_REQUEST_TOKEN', 'ACTIONS_RUNTIME_TOKEN',
]);

// The environment every hook sees. Nothing from an event payload; only values validated above.
// Store, GitHub and OIDC tokens never reach a hook.
export function hookEnvironment(config, base = process.env, extra = {}) {
  const rest = { ...base };
  for (const name of credentialVariables) delete rest[name];
  for (const name of Object.keys(rest)) if (/^GIT_CONFIG_(COUNT|KEY_\d+|VALUE_\d+)$/.test(name)) delete rest[name];
  return {
    ...rest,
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
