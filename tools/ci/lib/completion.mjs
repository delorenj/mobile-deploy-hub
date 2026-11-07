// The completion verdict (TOWE-76) judges only targets required by the loaded policy. With the deployed policy's
// absent `completion` block, no device or TestFlight target is mandatory; the stricter contract below is deferred.
// An explicit future completion block can require each lane's device and store TestFlight:
//
//   - a device lane (S26 for android, iPad for ios) is installed, or pending where pending is durable: latest.json
//     (read after deliver) names this exact version for that device as pending, and the catch-up on the device's host
//     is live. Anything else (skipped, a pending nobody will install, failed) is owed;
//   - TestFlight, for a store app (its manifest declares ios.store), is uploaded and assigned to Owner Testing within
//     the run. Slice 2 adds a durable store pass; until then an upload that only processes is owed too.
//
// COMPLETE: every required target is satisfied. INCOMPLETE: the run is not red, and something is owed (each owed
// target names the exact command that pays it). RED: the run failed, or a required target failed.
//
// A dry run is judged the same way on what it proved: a required target whose lane built and checked is `checked`, one
// whose lane would not run is `skipped` (INCOMPLETE: a real run would leave it owed, so `ship` stops before spending a
// version). The announce job writes the verdict as the completion-out artifact; `deploy.mjs ship` reads it.
import { requiredTargets } from './policy.mjs';

export const verdicts = Object.freeze(['COMPLETE', 'INCOMPLETE', 'RED']);
export const targetStatuses = Object.freeze(['installed', 'pending', 'assigned', 'uploaded', 'checked', 'skipped', 'missing', 'failed']);

const iosSkips = Object.freeze({
  'skip-offline': 'the Mac was offline, so the iPad build was not made',
  'skip-metered': 'the Mac was on a metered link and the iPad build would have gone over its data budget',
  'skip-lost': 'the Mac went offline after the gate, so the iPad build was not made',
  'skip-platform': 'the run\'s --platform left the iOS lane out',
});

// The catch-up's own commands, as the README gives them (big-chungus for the S26, the Mac for the iPad).
const catchupBin = '~/.local/share/mobile-deploy-hub/current/tools/catchup/catchup.mjs';
export const catchupCommand = (platform, args) => (platform === 'android'
  ? `node ${catchupBin} ${args}`
  : `ssh hub-mac '~/.local/share/mise/installs/node/24/bin/node ${catchupBin} ${args}'`);
const hostOf = platform => (platform === 'android' ? 'big-chungus' : 'the Mac');

// TestFlight as this run did it, from the ios receipt: null when the run did not owe it (the gate did not derive it).
// `store` is the v1.3 receipt's own record; older receipts only had a note, or a failure at stage deliver.
export function testflightOf({ testflight, iosLane = 'run', needs = {}, receipts = {}, dryRun = false }) {
  if (!testflight) return null;
  if (iosLane && iosLane !== 'run') return { status: 'skipped', reason: iosSkips[iosLane] ?? `the iOS lane did not run (${iosLane})` };
  const ios = receipts.ios;
  if (!ios) {
    const result = needs.ios?.result;
    if (result === 'failure' || result === 'cancelled') return { status: 'failed', reason: `the ios job ${result === 'cancelled' ? 'was cancelled' : 'failed'} before TestFlight` };
    return { status: 'skipped', reason: 'the ios job did not run' };
  }
  const store = ios.store;
  if (store && typeof store === 'object') {
    if (store.status === 'assigned') return { status: 'assigned', reason: store.uploaded === 'earlier' ? 'already in App Store Connect; assigned to Owner Testing' : 'uploaded and assigned to Owner Testing', build: store.build ?? null };
    if (store.status === 'failed') return { status: 'failed', reason: store.reason ?? ios.reason ?? 'the TestFlight step failed', build: store.build ?? null };
    if (store.status === 'checked' && dryRun) return { status: 'checked', reason: ios.testflight ?? 'dry run: upload and assign were not called', build: store.build ?? null };
  }
  if (typeof ios.testflight === 'string') {
    if (/uploaded and assigned|assigned to Owner Testing/.test(ios.testflight)) return { status: 'assigned', reason: ios.testflight };
    if (/^dry run/.test(ios.testflight) && dryRun) return { status: 'checked', reason: ios.testflight };
  }
  if (ios.outcome === 'failure') return { status: 'failed', reason: ios.stage === 'deliver' ? (ios.reason ?? 'the TestFlight step failed') : `the ios lane stopped at ${ios.stage ?? 'an unknown stage'} before TestFlight (${ios.reason ?? 'no reason'})` };
  return { status: 'missing', reason: 'the ios lane did not record TestFlight' };
}

// The TestFlight delivery the event carries next to the S26 and the iPad (the Bloodbank delivery shape: assigned is
// installed for testers, a dry run's check is pending).
export function testflightDelivery(tf, { version, build }) {
  const status = { assigned: 'installed', failed: 'failed', skipped: 'skipped' }[tf.status] ?? 'pending';
  const delivery = { platform: 'ios', target: 'TestFlight Owner Testing', device: 'TestFlight', version, build: build === null || build === undefined || build === '' ? null : String(build), sha256: null, verified: tf.status === 'assigned', status };
  if (status === 'installed') delivery.by = 'deploy';
  else if (tf.reason) delivery.reason = String(tf.reason).slice(0, 300);
  if (status === 'failed') delivery.stage = 'deliver';
  return delivery;
}

function deviceTarget({ platform, delivery, dryRun, latest, latestUnread = false, version, androidCode, iosBuild, catchup, runRed }) {
  const target = platform === 'android' ? 'S26' : 'iPad';
  if (!delivery) return { target, platform, status: 'missing', durable: false, why: `this run has no ${target} delivery` };
  const reason = delivery.reason ?? null;
  if (delivery.status === 'failed') return { target, platform, status: 'failed', durable: false, why: reason ?? `the ${target} refused the build` };
  if (delivery.status === 'skipped') return { target, platform, status: 'skipped', durable: false, why: reason ?? `the ${target} lane did not run` };
  if (dryRun) return { target, platform, status: 'checked', durable: null, why: reason ?? 'built and checked (dry run)' };
  if (delivery.status === 'installed') return { target, platform, status: 'installed', durable: true, why: 'installed and read back in the run' };
  // pending: durable only when latest.json names this version for this device and the catch-up there is live.
  const block = latest?.[platform] ?? null;
  const build = platform === 'android' ? androidCode : (delivery.build ?? iosBuild);
  const names = Boolean(block) && block.version === version && (platform === 'android' ? String(block.code) === String(build) : String(block.build) === String(build));
  if (names && block.device?.status === 'installed') return { target, platform, status: 'installed', durable: true, why: `installed by ${block.device.by ?? 'the catch-up'} since the run` };
  if (names && block.device?.status === 'failed') return { target, platform, status: 'failed', durable: false, why: `the catch-up gave up on ${version}: ${block.device.reason ?? 'no reason'}`, catchupFailed: true };
  const mode = catchup?.[platform] ?? null;
  if (!block && latestUnread) return { target, platform, status: 'pending', durable: false, why: 'pending, but latest.json could not be read after deliver, so it cannot be shown durable', unread: true };
  if (!names) {
    const said = block ? `${block.version} (${platform === 'android' ? block.code : block.build})` : 'nothing';
    return { target, platform, status: 'pending', durable: false, why: `pending, but latest.json names ${said} for the ${target}, not ${version} (${build ?? '-'})${runRed ? ': the run did not publish it' : ''}`, unpublished: true };
  }
  if (mode !== 'live') return { target, platform, status: 'pending', durable: false, why: `pending, but the catch-up on ${hostOf(platform)} is ${mode ?? 'unknown'}, not live`, catchupOff: true };
  return { target, platform, status: 'pending', durable: true, why: `pending: latest.json names ${version}${reason ? ` (${reason})` : ''} and the catch-up on ${hostOf(platform)} is live` };
}

function testflightTarget({ tf, dryRun, platform }) {
  const target = 'TestFlight';
  if (!tf) return { target, platform: 'testflight', status: 'missing', durable: false, why: platform !== 'both' && platform !== 'ios' ? `--platform ${platform} left the iOS lane, and TestFlight with it, out` : 'this run did not do TestFlight (a hub before v1.3, or the caller narrowed it)' };
  if (tf.status === 'checked' && !dryRun) return { target, platform: 'testflight', status: 'missing', durable: false, why: tf.reason };
  const durable = tf.status === 'assigned' ? true : (dryRun && tf.status === 'checked' ? null : false);
  return { target, platform: 'testflight', status: tf.status, durable, why: tf.reason ?? null };
}

const satisfied = (target, dryRun) => (dryRun ? target.status === 'checked' : (target.status === 'installed' || target.status === 'assigned' || (target.status === 'pending' && target.durable === true)));

// The command that pays one owed target.
function owedCommand(target, { repo, slug, run, runRed, bumped, iosLane, dryRun, latestUrl }) {
  const rerun = run?.id ? `gh run rerun ${run.id} --repo ${repo} --failed` : null;
  const ship = iosLane === 'skip-metered' && (target.platform === 'ios' || target.platform === 'testflight') ? 'mise run ship --metered allow' : 'mise run ship';
  if (target.catchupFailed) return catchupCommand(target.platform, `retry ${slug} ${target.platform}`);
  if (target.catchupOff) return catchupCommand(target.platform, 'mode live');
  if (target.unread && latestUrl) return `curl -fsS ${latestUrl}`;
  if (dryRun) return ship;
  if ((target.status === 'failed' || target.unpublished || target.status === 'uploaded') && runRed && bumped && rerun) return rerun;
  return ship;
}

export function completionOf({
  policy, repo, slug, store = false, dryRun = false, platform = 'both', iosLane = 'run', catchup = {}, deliveries = [], testflight = null,
  latest = null, latestUnread = false, version = null, androidCode = null, iosBuild = null, failure = null, bumped = false, run = {}, required: givenRequired = null, commit = null,
}) {
  const app = policy.apps[repo] ?? null;
  const required = givenRequired ?? requiredTargets(policy, app ?? { lanes: [] }, { store });
  const runRed = Boolean(failure);
  const device = platformName => deliveries.find(item => item.platform === platformName && item.device !== 'TestFlight') ?? null;
  const targets = [];
  if (required.android) targets.push(deviceTarget({ platform: 'android', delivery: device('android'), dryRun, latest, latestUnread, version, androidCode, iosBuild, catchup, runRed }));
  if (required.ios) targets.push(deviceTarget({ platform: 'ios', delivery: device('ios'), dryRun, latest, latestUnread, version, androidCode, iosBuild, catchup, runRed }));
  if (required.testflight) targets.push(testflightTarget({ tf: testflight, dryRun, platform }));

  const blocked = runRed && failure.job === 'gate' && /HUB_GATE_REFUSED lane_unavailable/.test(failure.reason ?? '');
  const red = runRed || targets.some(target => target.status === 'failed');
  const verdict = red ? 'RED' : targets.every(target => satisfied(target, dryRun)) ? 'COMPLETE' : 'INCOMPLETE';
  const context = { repo, slug: slug ?? app?.slug ?? null, run, runRed, bumped, iosLane, dryRun };
  context.latestUrl = context.slug ? `${policy.delivery.s3.public}/${context.slug}/latest.json` : null;
  const owed = targets.filter(target => !satisfied(target, dryRun)).map(target => ({ target: target.target, status: target.status, why: target.why, command: owedCommand(target, context) }));
  // A red run that spent its version owes its rerun even when every target is otherwise fine (a deliver step failed).
  if (runRed && bumped && owed.length === 0 && run?.id) owed.push({ target: 'run', status: 'failed', why: `${failure.job} failed at ${failure.stage}: ${failure.reason}`, command: `gh run rerun ${run.id} --repo ${repo} --failed` });
  if (runRed && !bumped && owed.length === 0) owed.push({ target: 'run', status: 'failed', why: `${failure.job} failed at ${failure.stage} before the bump (nothing was spent): ${failure.reason}`, command: blocked ? (iosLane === 'skip-metered' ? 'mise run ship --metered allow' : 'mise run ship') : 'mise run ship' });
  const clean = targets.map(({ catchupFailed: _a, catchupOff: _b, unpublished: _c, unread: _d, ...rest }) => rest);
  const result = {
    schema: 1, verdict, dry_run: dryRun, repo, slug: context.slug, version, android_code: androidCode === null || androidCode === undefined || androidCode === '' ? null : String(androidCode), ios_build: iosBuild || null,
    commit: commit || null, run: { id: run?.id ?? null, attempt: run?.attempt ?? null, url: run?.url ?? null }, platform, ios_lane: iosLane, bumped: Boolean(bumped), blocked,
    failure: failure ? { job: failure.job, stage: failure.stage, reason: failure.reason } : null,
    required: Object.entries(required).filter(([, owes]) => owes).map(([name]) => ({ android: 'S26', ios: 'iPad', testflight: 'TestFlight' }[name])),
    reruns: policy.completion.reruns,
    targets: clean, owed,
  };
  result.summary = completionSummary(result);
  return result;
}

// One line: the version, then each required target's state, then what is owed.
export function completionSummary(completion) {
  const label = `${completion.slug ?? completion.repo} ${completion.version ?? '?'}${completion.android_code ? ` (${completion.android_code})` : ''}`;
  const parts = completion.targets.map(target => `${target.target} ${target.status}${target.status === 'pending' ? (target.durable ? ' (durable)' : ' (not durable)') : ''}`);
  const owed = completion.owed.map(item => `${item.target}: ${item.command}`);
  return `${label}: ${parts.join(', ') || 'no required targets'}${owed.length > 0 ? `; owed ${owed.join('; ')}` : ''}`;
}
