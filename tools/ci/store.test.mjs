// The Mac-only store lane: a manifest whose ios.store has a build hook and no Linux export, the pins on the App Store
// bundle, the checks on the App Store IPA, and the build step the ios lane runs (a dry run included) before upload.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectStoreIpa, storeProfileProblems } from './lib/apple.mjs';
import { parseManifest } from './lib/manifest.mjs';
import { loadPolicy, parsePolicy, policyFile } from './lib/policy.mjs';
import { buildStoreIpa, storeBundleOf } from './lib/store.mjs';
import { checkPins } from './commands/gate.mjs';

const sha1 = 'F8A5C5309FC1B6C7DD7662A28EA822BE3309C351';
const team = 'YJ7W7Z36FP';

const macOnly = (change = () => {}) => {
  const manifest = {
    schema: 2,
    project: { slug: 'example-game', name: 'Example Game' },
    version: { read: 'node v.mjs', bump: 'node v.mjs bump' },
    android: { package: 'io.example.game', export: 'true', artifact: 'out/Game.apk', signer_sha256: 'a'.repeat(64) },
    ios: {
      bundle: 'io.example.game.dev',
      device: 'build-device',
      device_artifact: 'Game.xcarchive',
      store: {
        bundle: 'io.example.game',
        build: 'build-store',
        artifact: 'Game-store.ipa',
        upload: 'upload-store',
        assign: 'assign-store',
        signer_sha1: sha1,
        secrets: ['op://Vault/Item/key_id'],
      },
    },
  };
  change(manifest);
  return JSON.stringify(manifest);
};

test('a Mac-only app declares ios.store.build and artifact instead of the Linux archive', () => {
  const manifest = parseManifest(macOnly());
  assert.equal(storeBundleOf(manifest.ios), 'io.example.game');
  const sameBundle = parseManifest(macOnly(m => { delete m.ios.store.bundle; }));
  assert.equal(storeBundleOf(sameBundle.ios), 'io.example.game.dev', 'no store bundle means the device bundle');
  const bad = {
    'no build hook': m => { delete m.ios.store.build; },
    'no artifact': m => { delete m.ios.store.artifact; },
    'artifact is not an ipa': m => { m.ios.store.artifact = 'Game.xcarchive'; },
    'artifact in a folder': m => { m.ios.store.artifact = 'out/Game.ipa'; },
    'no signer pin': m => { delete m.ios.store.signer_sha1; },
    'a Linux archive without ios.export': m => { m.ios.store.archive = 'a.tgz'; m.ios.store.receipt = 'a.json'; },
    'bad store bundle': m => { m.ios.store.bundle = 'not a bundle'; },
    'no upload hook': m => { delete m.ios.store.upload; },
  };
  for (const [name, change] of Object.entries(bad)) assert.throws(() => parseManifest(macOnly(change)), /mobile-deploy\.json/, name);
});

test('a store lane with ios.export keeps the Linux archive and refuses the Mac-only keys', () => {
  const withLinux = change => macOnly(m => {
    m.ios.export = 'linux-export';
    m.ios.archive = 'Game-ipad.tgz';
    m.ios.receipt = 'ipad-export.json';
    delete m.ios.store.build;
    delete m.ios.store.artifact;
    m.ios.store.archive = 'Game-xcode.tgz';
    m.ios.store.receipt = 'testflight-export.json';
    change(m);
  });
  assert.doesNotThrow(() => parseManifest(withLinux(() => {})));
  assert.throws(() => parseManifest(withLinux(m => { m.ios.store.build = 'x'; })), /ios\.store\.build is for an app without ios\.export/);
  assert.throws(() => parseManifest(withLinux(m => { m.ios.store.artifact = 'x.ipa'; })), /ios\.store\.artifact is for an app without ios\.export/);
});

test('the policy pins the App Store bundle, and a manifest cannot name another', () => {
  const { policy } = loadPolicy();
  const gib = policy.apps['delorenj/green-in-between'];
  assert.equal(gib.ios.bundle, 'io.lasertoast.greeninbetween.spike');
  assert.equal(gib.ios.store_bundle, 'io.lasertoast.greeninbetween');
  const app = { ios: { bundle: 'io.example.game.dev', store_bundle: 'io.example.game' } };
  assert.doesNotThrow(() => checkPins({ app, manifest: parseManifest(macOnly()) }));
  assert.throws(() => checkPins({ app, manifest: parseManifest(macOnly(m => { m.ios.store.bundle = 'io.example.other'; })) }), /HUB_GATE_REFUSED pins: .*App Store bundle is io\.example\.other.*pins io\.example\.game/);
  assert.throws(() => checkPins({ app, manifest: parseManifest(macOnly(m => { delete m.ios.store.bundle; })) }), /HUB_GATE_REFUSED pins: .*App Store bundle is io\.example\.game\.dev/);
  // Without a store_bundle the device bundle is the store's too (Tower).
  assert.doesNotThrow(() => checkPins({ app: { ios: { bundle: 'io.example.game.dev' } }, manifest: parseManifest(macOnly(m => { delete m.ios.store.bundle; })) }));
  const copy = structuredClone(JSON.parse(readFileSync(policyFile, 'utf8')));
  copy.apps['delorenj/green-in-between'].ios.store_bundle = 'not a bundle';
  assert.throws(() => parsePolicy(JSON.stringify(copy)), /store_bundle must be a reverse-DNS bundle id/);
});

// ---------------------------------------------------------------------------------------------------- the App Store IPA

const certBytes = Buffer.from('distribution-certificate');
const signer = createHash('sha1').update(certBytes).digest('hex').toUpperCase();
const plist = body => `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">${body}</plist>\n`;
const strings = pairs => `<dict>${Object.entries(pairs).map(([key, value]) => `<key>${key}</key>${value}`).join('')}</dict>`;
const str = value => `<string>${value}</string>`;

function profileXml({ devices = [], taskAllow = false, certs = [certBytes], appId = `${team}.io.example.game`, expires = '2099-01-01T00:00:00Z' } = {}) {
  return plist(strings({
    Name: str('Example App Store'),
    UUID: str('11111111-2222-3333-4444-555555555555'),
    TeamIdentifier: `<array>${str(team)}</array>`,
    ExpirationDate: `<date>${expires}</date>`,
    ...(devices.length > 0 ? { ProvisionedDevices: `<array>${devices.map(str).join('')}</array>` } : {}),
    DeveloperCertificates: `<array>${certs.map(cert => `<data>${cert.toString('base64')}</data>`).join('')}</array>`,
    Entitlements: strings({ 'application-identifier': str(appId), 'get-task-allow': taskAllow ? '<true/>' : '<false/>' }),
  }));
}

// A real zip holding Payload/Game.app/Info.plist; every Apple tool is a canned answer.
function fixture({ bundle = 'io.example.game', version = '1.2.3', build = '55', profile = profileXml(), cert = certBytes, taskAllow = false, teamId = team } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'hub-store-'));
  const app = join(root, 'src/Payload/Game.app');
  mkdirSync(app, { recursive: true });
  writeFileSync(join(app, 'Info.plist'), plist(strings({ CFBundleIdentifier: str(bundle), CFBundleShortVersionString: str(version), CFBundleVersion: str(build) })));
  const ipa = join(root, 'Game-store.ipa');
  execFileSync('zip', ['-q', '-r', ipa, 'Payload'], { cwd: join(root, 'src') });
  const entitlements = plist(strings({ 'application-identifier': str(`${team}.${bundle}`), 'com.apple.developer.team-identifier': str(teamId), 'get-task-allow': taskAllow ? '<true/>' : '<false/>' }));
  const calls = [];
  const runner = (command, args) => {
    calls.push([command, ...args].join(' '));
    if (command === 'unzip' || /python3$/.test(command)) return execFileSync(command, args, { encoding: 'utf8' });
    if (command === 'codesign' && args[0] === '--verify') return '';
    if (command === 'codesign' && args[1] === '--entitlements') return entitlements;
    if (command === 'codesign' && args[1].startsWith('--extract-certificates=')) { writeFileSync(`${args[1].split('=')[1]}0`, cert); return ''; }
    if (command === 'security') return profile;
    throw new Error(`unexpected ${command} ${args.join(' ')}`);
  };
  return { root, ipa, runner, calls, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const inspect = (f, change = {}) => inspectStoreIpa({ ipa: f.ipa, into: join(f.root, 'check'), bundle: 'io.example.game', version: '1.2.3', build: '55', team, signer, env: process.env, runner: f.runner, ...change });

test('the store IPA is the planned bundle, version and build, signed with the distribution identity and an App Store profile', () => {
  const f = fixture();
  try {
    const facts = inspect(f);
    assert.deepEqual({ bundle: facts.bundle, version: facts.version, build: facts.build, signer: facts.signer }, { bundle: 'io.example.game', version: '1.2.3', build: '55', signer });
    assert.equal(facts.profile.name, 'Example App Store');
  } finally { f.cleanup(); }
});

test('the store IPA is refused when it is the wrong build, a development build, signed by someone else, or has a development profile', () => {
  const cases = {
    'another bundle': [{ bundle: 'io.example.other' }, {}, /the IPA is io\.example\.other, the manifest pins io\.example\.game/],
    'another version': [{ version: '9.9.9' }, {}, /says version 9\.9\.9 but the plan says 1\.2\.3/],
    'another build': [{ build: '54' }, {}, /build is 54 but the plan says 55/],
    'get-task-allow': [{ taskAllow: true }, {}, /development build \(get-task-allow is true\)/],
    'another signer': [{ cert: Buffer.from('someone-else') }, {}, /signed by .*not the distribution identity/],
    'a profile with devices': [{ profile: profileXml({ devices: ['00008112-000138390CFB401E'] }) }, {}, /is not an App Store profile/],
    'a profile without the certificate': [{ profile: profileXml({ certs: [Buffer.from('other')] }) }, {}, /does not include the distribution certificate/],
    'a profile for another app': [{ profile: profileXml({ appId: `${team}.io.example.other` }) }, {}, /application-identifier .* does not cover io\.example\.game/],
    'an expired profile': [{ profile: profileXml({ expires: '2020-01-01T00:00:00Z' }) }, {}, /expired 2020-01-01/],
    'another team': [{ teamId: 'AAAAAAAAAA' }, {}, /signed team AAAAAAAAAA is not YJ7W7Z36FP/],
  };
  for (const [name, [make, change, pattern]] of Object.entries(cases)) {
    const f = fixture(make);
    try { assert.throws(() => inspect(f, change), pattern, name); } finally { f.cleanup(); }
  }
});

test('storeProfileProblems names every way a profile cannot sign an App Store build', () => {
  const facts = { team: [team], certificate_sha1s: [signer], devices: [], provisions_all: false, get_task_allow: false, application_identifier: `${team}.io.example.game`, expires_at: '2099-01-01T00:00:00Z' };
  assert.deepEqual(storeProfileProblems(facts, { team, signer, bundle: 'io.example.game' }), []);
  assert.equal(storeProfileProblems({ ...facts, provisions_all: true }, { team, signer, bundle: 'io.example.game' }).length, 1);
  assert.equal(storeProfileProblems({ ...facts, application_identifier: `${team}.*` }, { team, signer, bundle: 'io.example.game' }).length, 0, 'a wildcard covers the bundle');
});

// ---------------------------------------------------------------------------------------------------- the build step

test('the ios lane builds and checks the store IPA through the hook; a hook that leaves nothing is an error', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hub-store-build-'));
  try {
    const spec = parseManifest(macOnly()).ios;
    const config = { cwd: root, version: '1.2.3', iosBuild: '55' };
    const calls = [];
    const facts = { app: join(root, 'x'), bundle: 'io.example.game', version: '1.2.3', build: '55', signer: sha1, profile: { uuid: 'u', name: 'Example App Store', expires_at: '2099-01-01T00:00:00Z', xcode_managed: false } };
    const inspect = args => { calls.push(['inspect', args.bundle, args.version, args.build, args.signer, args.team]); return facts; };
    await assert.rejects(buildStoreIpa({ spec, config, out: root, team, hooks: {}, log: () => {}, runHook: (name, command) => calls.push([name, command]), inspect }), /did not leave Game-store\.ipa in \$HUB_OUT\/ios/);
    writeFileSync(join(root, 'Game-store.ipa'), 'ipa bytes');
    const built = await buildStoreIpa({ spec, config, out: root, team, hooks: {}, log: () => {}, runHook: (name, command) => calls.push([name, command]), inspect });
    assert.deepEqual(calls.at(-2), ['ios.store.build', 'build-store']);
    assert.deepEqual(calls.at(-1), ['inspect', 'io.example.game', '1.2.3', '55', sha1, team]);
    assert.equal(built.bytes, 9);
    assert.equal(built.sha256, createHash('sha256').update('ipa bytes').digest('hex'));
    assert.equal(built.name, 'Game-store.ipa');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------------------------------- the watch

import { deploy, finishByHand, parseArguments, unknownStatus, verdictLine, watchRun } from '../deploy.mjs';

// A fake gh with a clock: `script` answers each read of the run (a state object, or a string for an error that gh
// would throw), `sleep` advances the clock, and every call is recorded.
function watchRig(script, { rateLimit = null } = {}) {
  let clock = 1_000_000;
  const calls = [];
  const waits = [];
  const logs = [];
  const gh = args => {
    calls.push(args.join(' '));
    if (args[0] === 'api' && args[1] === 'rate_limit') {
      if (!rateLimit) throw new Error('gh api failed: HTTP 403');
      return JSON.stringify({ resources: { core: rateLimit(clock) } });
    }
    if (args[0] === 'api' && /actions\/runs\/7$/.test(args[1])) {
      const next = typeof script === 'function' ? script(calls.filter(call => /actions\/runs\/7 /.test(call)).length, clock) : script.shift();
      if (typeof next === 'string') throw new Error(`gh api failed: ${next}`);
      return JSON.stringify(next);
    }
    throw new Error(`unexpected ${args.join(' ')}`);
  };
  const options = { sleep: async ms => { waits.push(ms); clock += ms; }, now: () => clock, log: line => logs.push(line) };
  return { gh, calls, waits, logs, options, reads: () => calls.filter(call => /actions\/runs\/7 /.test(call)).length };
}

const R = ['--repo', 'delorenj/green-in-between'];
const limited = 'HTTP 403: API rate limit exceeded';

test('a run that is green while GitHub fails every read is GREEN once the API recovers, never red', async () => {
  // every watch and view fails for a long stretch (the secondary limit), then the run reports it finished green
  const rig = watchRig((read) => (read <= 40 ? limited : read <= 41 ? { status: 'in_progress', conclusion: null } : { status: 'completed', conclusion: 'success' }));
  assert.equal(await watchRun(rig.gh, 7, R, rig.options), 0);
  assert.equal(rig.logs.filter(line => /^DEPLOY_WATCH_RETRY run 7/.test(line)).length, 40);
  assert.ok(rig.waits.every(ms => ms <= 300_000), 'the backoff stops at five minutes');
  assert.ok(rig.waits.slice(0, 3).every((ms, index, all) => index === 0 || ms >= all[index - 1]), 'and grows until then');
  assert.equal(rig.waits.at(-1), 30_000, 'a good read goes back to the 30 s poll');
});

test('GitHub failing for the whole cap ends UNKNOWN with the run and the command to finish by hand, never red', async () => {
  const rig = watchRig(() => limited);
  const status = await watchRun(rig.gh, 7, R, { ...rig.options, capMs: 3_600_000 });
  assert.equal(status, unknownStatus);
  assert.notEqual(status, 0);
  assert.notEqual(status, 1);
  const line = verdictLine(status, 7, 'dry run', 'https://github.com/x/actions/runs/7', R);
  assert.match(line, /^DEPLOY_UNKNOWN run 7 dry run https:\/\/github\.com\/x\/actions\/runs\/7/);
  assert.ok(line.includes('gh run watch 7 --repo delorenj/green-in-between --interval 30 --exit-status'), line);
  assert.ok(!/DEPLOY_RED/.test(line));
  assert.ok(rig.waits.reduce((sum, ms) => sum + ms, 0) <= 3_600_000 + 1, 'it never sleeps past the cap');
});

test('a run that never finishes within the cap is UNKNOWN too, not red', async () => {
  const rig = watchRig(() => ({ status: 'in_progress', conclusion: null }));
  assert.equal(await watchRun(rig.gh, 7, R, { ...rig.options, capMs: 600_000 }), unknownStatus);
  assert.equal(rig.reads(), 21, 'one read per 30 s, not one per 3 s');
});

test('a genuinely red run still ends RED, and a green one GREEN, on the first completed read', async () => {
  for (const conclusion of ['failure', 'cancelled', 'timed_out']) {
    const red = watchRig([{ status: 'in_progress', conclusion: null }, { status: 'completed', conclusion }]);
    assert.equal(await watchRun(red.gh, 7, R, red.options), 1, conclusion);
    assert.deepEqual(red.waits, [30_000]);
    assert.match(verdictLine(1, 7, 'real run', 'u', R), /^DEPLOY_RED run 7 real run u$/);
  }
  const green = watchRig([{ status: 'completed', conclusion: 'success' }]);
  assert.equal(await watchRun(green.gh, 7, R, green.options), 0);
  assert.deepEqual(green.waits, []);
  assert.match(verdictLine(0, 7, 'real run', 'u', R), /^DEPLOY_GREEN run 7 real run u$/);
  // red after a stretch of rate limiting is still red, once the run says so
  const late = watchRig([limited, limited, { status: 'completed', conclusion: 'failure' }]);
  assert.equal(await watchRun(late.gh, 7, R, late.options), 1);
});

test('a spent core budget is waited out to its reset (read from the unmetered rate_limit), not hammered', async () => {
  const reset = 1_000 + 900; // seconds; the rig clock starts at 1_000_000 ms = 1000 s
  const rig = watchRig([limited, { status: 'completed', conclusion: 'success' }], { rateLimit: () => ({ remaining: 0, reset }) });
  assert.equal(await watchRun(rig.gh, 7, R, rig.options), 0);
  assert.deepEqual(rig.waits, [900_000 + 2000]);
  assert.ok(rig.logs.some(line => /rate limit resets then/.test(line)));
});

test('a watch costs one request per 30 s: 51 for a 25 minute run, against about 2,300 for gh run watch', async () => {
  const rig = watchRig((read) => (read <= 50 ? { status: 'in_progress', conclusion: null } : { status: 'completed', conclusion: 'success' }));
  assert.equal(await watchRun(rig.gh, 7, R, rig.options), 0);
  assert.equal(rig.reads(), 51);
  assert.ok(rig.calls.every(call => call.startsWith('api repos/delorenj/green-in-between/actions/runs/7 ')), 'one api read, no watch, no jobs, no annotations');
  assert.ok(rig.calls.every(call => !/run watch/.test(call)));
  assert.ok(rig.logs.filter(line => /^DEPLOY_WATCH run 7/.test(line)).length <= 7, 'a heartbeat every five minutes, not a line per poll');
});

test('finishByHand names the repo when there is one and works without', () => {
  assert.equal(finishByHand(9, ['--repo', 'a/b']), 'gh run watch 9 --repo a/b --interval 30 --exit-status');
  assert.equal(finishByHand(9, []), 'gh run watch 9 --interval 30 --exit-status');
});

test('the front door ends DEPLOY_UNKNOWN (exit status 3) when GitHub never gives a verdict,', async () => {
  const runs = (extra = []) => [...extra, { databaseId: 21, headSha: 'a'.repeat(40), event: 'workflow_dispatch', status: 'in_progress', url: 'https://x/21', displayTitle: 'Deploy (dry run)' }];
  let dispatched = false;
  const calls = [];
  let clock = Date.now();
  const gh = args => {
    calls.push(args.join(' '));
    if (args[0] === 'run' && args[1] === 'list') return JSON.stringify(dispatched ? runs() : []);
    if (args[0] === 'repo') return 'delorenj/green-in-between\n';
    if (args[0] === 'api' && args.some(arg => /commits\/main$/.test(arg))) return `${'a'.repeat(40)}\n`;
    if (args[0] === 'api' && args.some(arg => /actions\/runners$/.test(arg))) return '[]';
    if (args[0] === 'api' && args.includes('Accept: application/vnd.github.raw')) return '';
    if (args[0] === 'workflow' && args[1] === 'run') { dispatched = true; return ''; }
    throw new Error('HTTP 403: API rate limit exceeded');
  };
  const logs = [];
  const result = await deploy(parseArguments(['--dry-run', 'true', '--repo', 'delorenj/green-in-between', '--platform', 'android']), {
    gh, git: () => 'main\n', log: line => logs.push(line), sleep: async ms => { clock += ms; }, now: () => clock, timeoutMs: 5000, pollMs: 1, watch: { capMs: 7_200_000 },
  });
  assert.equal(result.status, unknownStatus);
  assert.ok(logs.some(line => /^DEPLOY_UNKNOWN run 21 dry run https:\/\/x\/21: .*gh run watch 21 --repo delorenj\/green-in-between --interval 30 --exit-status/.test(line)), logs.join('\n'));
  assert.ok(!logs.some(line => /DEPLOY_RED/.test(line)), 'never red');
  assert.ok(!calls.some(call => /^run watch/.test(call)));
});
