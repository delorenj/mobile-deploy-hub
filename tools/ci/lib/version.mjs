// Version rules for the v3 bump. The app's `version.read` hook prints {version, android_code, ios_build}; its
// `version.bump <level>` hook rewrites the app's version authority files (no git) and prints the same plus `files`.
// The hub, not the hook, decides whether the result is the exact semver increment. Every deploy bumps: there is no
// "none". A deploy that failed after its bump is finished with "Re-run failed jobs" (same version, same commit).
export const levels = Object.freeze(['patch', 'minor', 'major']);
const semver = /^(\d+)\.(\d+)\.(\d+)$/;

export function nextVersion(version, level) {
  const match = semver.exec(version ?? '');
  if (!match) throw new Error(`version "${version}" is not X.Y.Z`);
  const [major, minor, patch] = match.slice(1).map(Number);
  if (level === 'patch') return `${major}.${minor}.${patch + 1}`;
  if (level === 'minor') return `${major}.${minor + 1}.0`;
  if (level === 'major') return `${major + 1}.0.0`;
  throw new Error(`bump must be one of ${levels.join(', ')}, got "${level}"`);
}

// One line of JSON on the hook's last stdout line. android_code is required when the Android lane runs.
export function parseVersionInfo(stdout, { hook = 'version.read', needAndroid = false, needFiles = false } = {}) {
  const line = stdout.trim().split('\n').pop() ?? '';
  let value;
  try { value = JSON.parse(line); } catch { throw new Error(`${hook} must print one line of JSON, got "${line.slice(0, 120)}"`); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${hook} must print a JSON object`);
  if (!semver.test(value.version ?? '')) throw new Error(`${hook} returned version "${value.version}", expected X.Y.Z`);
  if (value.android_code !== undefined && !(Number.isSafeInteger(value.android_code) && value.android_code > 0)) throw new Error(`${hook} returned a bad android_code`);
  if (needAndroid && value.android_code === undefined) throw new Error(`${hook} must return android_code for an Android deploy`);
  let iosBuild;
  if (value.ios_build !== undefined) {
    iosBuild = String(value.ios_build);
    if (!/^[1-9]\d{0,8}$|^\d+\.\d+(\.\d+)?$/.test(iosBuild)) throw new Error(`${hook} returned a bad ios_build "${value.ios_build}"`);
  }
  const info = { version: value.version, android_code: value.android_code, ios_build: iosBuild };
  if (needFiles) {
    if (!Array.isArray(value.files) || value.files.length === 0) throw new Error(`${hook} must list the files it changed in "files"`);
    for (const file of value.files) {
      if (typeof file !== 'string' || file === '' || file.startsWith('/') || file.split('/').includes('..') || /[\0\n\r]/.test(file)) throw new Error(`${hook} listed a file outside the checkout: ${JSON.stringify(file)}`);
    }
    info.files = [...new Set(value.files)].sort();
  }
  return info;
}

// The bump's result must be the increment Jarad asked for: exact semver, a strictly larger Android code and a
// build number that did not go backwards.
export function checkBump(current, bumped, level) {
  const expected = nextVersion(current.version, level);
  if (bumped.version !== expected) throw new Error(`version.bump ${level} produced ${bumped.version}; ${current.version} bumped ${level} is ${expected}`);
  if (current.android_code !== undefined) {
    if (bumped.android_code === undefined) throw new Error('version.bump dropped android_code');
    if (!(bumped.android_code > current.android_code)) throw new Error(`version.bump left android_code at ${bumped.android_code} (was ${current.android_code}); it must grow or the S26 refuses the update`);
  }
  return expected;
}

export const sameFiles = (a, b) => a.length === b.length && [...a].sort().every((file, index) => file === [...b].sort()[index]);
