// The catch-up's event (design-hub-v1.1.md G3): one bloodbank.project.deployment.completed when a pending build
// reaches its device (installed by the catch-up, or found already installed by a person), and one .failed when the
// catch-up gives up after its last failed attempt. It names the run and correlation of the deploy that published that
// build (each latest.json block carries its own), so a deploy and its catch-up group together. data.trigger is
// catch-up and data.links points at the build page, which ntfy turns into the notification's click.
import { bbEmit, correlationFor, sanitizeReason } from '../ci/lib/announce.mjs';
import { attempt } from '../ci/lib/exec.mjs';

export const producer = 'mobile-deploy-hub-catchup';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const stamp = date => date.toISOString().replace(/\.\d{3}Z$/, 'Z');
const buildOf = (block, platform) => String(platform === 'android' ? block.code : block.build);

// A failed device's reason reads "catch-up failed N times at <stage>: <why>"; the event's stage comes from it.
export const failureStage = reason => (/\bat verify\b/.test(reason ?? '') ? 'verify' : 'install');

// block: the release the catch-up acted on (version, code or build, sha256). device: its new state. run, commit and
// correlation: the deploy that published it.
export function catchupEvent({ name, slug, platform, block, device, run, commit, hubRef, correlation, devices, publicBase, now = new Date() }) {
  const android = platform === 'android';
  const known = devices[platform];
  const build = buildOf(block, platform);
  const failed = device.status === 'failed';
  const reason = sanitizeReason(device.reason, failed ? 'the catch-up install failed' : 'installed');
  const delivery = {
    platform,
    target: known.model,
    version: block.version,
    build,
    sha256: block.sha256 ?? null,
    verified: !failed,
    status: failed ? 'failed' : 'installed',
    device: known.name,
    ...(failed ? { stage: failureStage(device.reason), reason } : { by: device.by === 'manual' ? 'manual' : 'catch-up' }),
  };
  const runUrl = typeof run?.url === 'string' && /^https:\/\//.test(run.url) ? run.url : null;
  const page = `${publicBase.replace(/\/$/, '')}/${slug}/index.html`;
  const label = `${name} ${block.version} (${build}) ${String(commit).slice(0, 7)}`;
  const data = {
    schema_version: 1,
    summary: '',
    project: { slug, name },
    artifact: { kind: android ? 'android-apk' : 'ios-app', name, version: block.version, version_code: android ? Number(block.code) : null, commit, dirty: false, variant: 'debug', sha256: block.sha256 ?? null },
    target: android ? { kind: 'android-device', name: known.model, id: known.serial } : { kind: 'ios-device', name: known.model, id: known.udid },
    deliveries: [delivery],
    run: { id: String(run.id), attempt: Number(run.attempt ?? 1), url: runUrl, hub_ref: hubRef ?? null },
    trigger: 'catch-up',
    // G1: catch-up .completed links the build page; catch-up .failed the page and the run.
    links: [{ rel: 'page', label: 'Builds', url: page }, ...(failed && runUrl ? [{ rel: 'run', label: 'Run', url: runUrl }] : [])],
  };
  if (failed) {
    data.summary = `${label}: ${known.name} catch-up failed at ${delivery.stage}: ${reason}`.slice(0, 200);
    Object.assign(data, { stage: delivery.stage, reason, failed_at: stamp(now) });
  } else {
    data.summary = `${label}: ${known.name} installed by ${delivery.by}, verified`.slice(0, 200);
    Object.assign(data, { verified: true, deployed_at: stamp(now) });
  }
  const derived = run.repo ? correlationFor({ GITHUB_REPOSITORY: run.repo, GITHUB_RUN_ID: String(run.id) }) : null;
  return {
    type: failed ? 'bloodbank.project.deployment.failed' : 'bloodbank.project.deployment.completed',
    data,
    correlation: uuid.test(correlation ?? '') ? correlation : derived,
  };
}

// The hub's bbEmit names the producer; the argument is also set on its way out, so an older bbEmit names it too.
const asProducer = runner => (program, args, options) => runner(program, args.map((arg, index) => (args[index - 1] === '--producer' ? producer : arg)), options);

export function sendCatchupEvent({ event, check = false, env = process.env, home, runner = attempt }) {
  if (!uuid.test(event.correlation ?? '')) throw new Error('the catch-up event has no correlation (the original deploy\'s run)');
  return bbEmit({ type: event.type, data: event.data, correlation: event.correlation, check, env, home, runner: asProducer(runner), producer });
}
