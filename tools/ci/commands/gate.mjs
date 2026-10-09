// gate (design v1.1, A2 and B2): the first job, on Linux, before the Mac is touched and before any version is spent.
// It holds the run to tools/ci/policy.json (the repo is listed, the manifest is schema 2 and declares every lane, the
// caller is the hub's template, strict and the runners and manifest are the policy's, a real run is released hub
// code on main), then reads the state of things (the Mac's link, the S26, the build directory) and decides the iPad
// lane: run it, or skip it because the Mac is offline or a metered link would go over the data budget.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createAdb, findPhone } from '../lib/adb.mjs';
import { checkCaller, refusal } from '../lib/caller.mjs';
import { loadDevices } from '../lib/devices.mjs';
import { attempt } from '../lib/exec.mjs';
import { latestKey, parseLatest } from '../lib/latest.mjs';
import { loadManifest } from '../lib/manifest.mjs';
import { macEstimate, macLink, runnerAliveOver, tailscaleStatus } from '../lib/metered.mjs';
import { appFor } from '../lib/policy.mjs';
import { buildReceipt, setOutputs, writeReceipt } from '../lib/receipt.mjs';
import { jobWriter, probe, readObject } from '../lib/s3.mjs';
import { guarded, policyBanner, releaseRef } from './common.mjs';

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// The caller file at the commit the run was started from (GITHUB_WORKFLOW_SHA), read from the gate's checkout.
function callerReader(config, env) {
  return path => {
    const sha = env.GITHUB_WORKFLOW_SHA;
    if (sha && /^[0-9a-f]{40}$/.test(sha)) {
      const head = attempt('git', ['rev-parse', 'HEAD'], { cwd: config.cwd, env });
      if (head.ok && head.stdout.trim() !== sha) {
        const shown = attempt('git', ['show', `${sha}:${path}`], { cwd: config.cwd, env });
        if (!shown.ok) throw Object.assign(new Error(`git show ${sha.slice(0, 8)}:${path} failed`), { code: 'ENOENT' });
        return shown.stdout;
      }
    }
    return readFileSync(join(config.cwd, path), 'utf8');
  };
}

// The policy's rules on this run's inputs and caller. Each refusal names what to fix; nothing has been spent yet.
export function checkRun({ policy, config, env, read }) {
  const repo = env.GITHUB_REPOSITORY ?? '';
  const app = appFor(policy, repo);
  if (!config.strict) throw refusal('inputs', 'strict must stay true: a dry run fails, as a real run does, when a check could not be made');
  if (config.manifest !== policy.callers.manifest) throw refusal('inputs', `the manifest must be ${policy.callers.manifest}, not ${config.manifest}`);
  if (!same(config.linuxRunner, policy.runners.linux)) throw refusal('inputs', `linux_runner must be ${JSON.stringify(policy.runners.linux)}, not ${JSON.stringify(config.linuxRunner)}`);
  if (!same(config.macRunner, policy.runners.mac)) throw refusal('inputs', `mac_runner must be ${JSON.stringify(policy.runners.mac)}, not ${JSON.stringify(config.macRunner)}`);
  if (config.channel !== 'sideload' || config.build !== '') throw refusal('inputs', 'android_channel and build are v2 inputs; leave them at their defaults (v2 removes them)');
  if (!policy.bump.levels.includes(config.bump)) throw refusal('bump', `bump ${config.bump} is not one of ${policy.bump.levels.join(', ')}`);
  const caller = checkCaller({ policy, env, read });
  if (!config.dryRun) {
    if (!releaseRef.test(env.HUB_REF ?? '')) throw refusal('hub_ref main', `a real run uses released hub code (a vX.Y.Z tag), not ${env.HUB_REF || 'an unknown ref'}; callers pin @v1`);
    if (env.GITHUB_REF !== 'refs/heads/main') throw refusal('ref', `a real deploy bumps main, so it is dispatched on main, not ${env.GITHUB_REF ?? 'no ref'}`);
  }
  return { app, caller };
}

export async function checkManifest({ policy, app, config }) {
  let manifest;
  try {
    manifest = await loadManifest(config.cwd, config.manifest);
  } catch (error) {
    if (/schema 1/.test(error.message)) throw refusal('manifest schema 1', 'the v2 contract is gone; move the manifest to schema 2');
    throw refusal('manifest', error.message);
  }
  if (!policy.manifest_schema.includes(manifest.schema)) throw refusal(`manifest schema ${manifest.schema}`, `the policy accepts schema ${policy.manifest_schema.join(', ')}`);
  if (manifest.project.slug !== app.slug) throw refusal('slug', `the manifest's project.slug is ${manifest.project.slug}; the policy lists this repository as ${app.slug}`);
  const missing = app.lanes.filter(lane => !manifest[lane]);
  if (missing.length > 0) throw refusal('lanes', `the policy has this app ship ${app.lanes.join(' and ')}, and the manifest declares no ${missing.join(' or ')} section; an app cannot narrow "both" by dropping a section`);
  return manifest;
}

async function quickS26({ env, home, devices, adbFactory }) {
  try {
    await findPhone(adbFactory({ env, home }), { serial: devices.android.serial, model: devices.android.model, waitMs: Number(env.HUB_GATE_ADB_WAIT_MS) || 6000, pollMs: 2000, nudgeEvery: 2, log: () => {} });
    return 'present';
  } catch (error) {
    if (/is not on this host's adb server/.test(error.message)) return 'away';
    throw error;
  }
}

export async function gate(config, {
  env = process.env, home = homedir(), fetchImpl = fetch, log = console.log, s3Factory = null,
  tailscale = () => tailscaleStatus({ env }), runnerAlive = null, adbFactory = createAdb,
} = {}) {
  const loaded = policyBanner(log);
  const { policy } = loaded;
  const makeS3 = s3Factory ?? (() => jobWriter(policy, env));
  const out = join(config.out, 'gate');
  return guarded('gate', out, config, env, async track => {
    track.stage = 'preflight';
    const devices = loadDevices(env);
    const { app, caller } = checkRun({ policy, config, env, read: callerReader(config, env) });
    const manifest = await checkManifest({ policy, app, config });
    const scope = { android: config.platform !== 'ios', ios: config.platform !== 'android' };

    // The newest published state, for the metered estimate (and, in plan, the downgrade check).
    let latest = null;
    try {
      const text = await readObject(policy, latestKey(app.slug), { fetchImpl });
      latest = text === null ? null : parseLatest(text, { slug: app.slug });
    } catch (error) {
      throw refusal('s3', `the build directory's ${latestKey(app.slug)} cannot be read or is invalid (${error.message}); deliver and the catch-up depend on it`);
    }

    const s26 = scope.android ? await quickS26({ env, home, devices, adbFactory }) : 'n/a';
    let link = { link: 'n/a', addr: null, reason: 'the iPad is out of scope' };
    let iosLane = 'skip-platform';
    if (scope.ios) {
      try {
        link = macLink({ status: tailscale(), peer: devices.mac.peer, lanCidr: policy.mac.lan_cidr, runnerAlive: runnerAlive ?? runnerAliveOver(devices.mac.host, { env }) });
      } catch (error) {
        link = { link: 'offline', addr: null, reason: `tailscale status failed (${error.message.split('\n')[0]})` };
      }
      log(`HUB_MAC_LINK ${link.link} peer=${devices.mac.peer} addr=${link.addr ?? '-'} (${link.reason})`);
      iosLane = 'run';
      if (link.link === 'offline') {
        iosLane = 'skip-offline';
        log(`HUB_IOS_SKIPPED offline: ${link.reason}; the iPad delivery is skipped, the S26 lane goes on`);
      } else if (link.link === 'metered') {
        const budget = policy.mac.metered_budget_mib * 1024 * 1024;
        const estimate = macEstimate({ latest, budgetMib: policy.mac.metered_budget_mib });
        if (estimate.bytes > budget && config.metered === 'auto') {
          iosLane = 'skip-metered';
          log(`HUB_IOS_DEFERRED estimate ${estimate.bytes} bytes (${estimate.source}) is over the ${policy.mac.metered_budget_mib} MiB budget on a metered link; pass --metered allow to build it anyway`);
        } else {
          log(`HUB_MAC_BUDGET estimate ${estimate.bytes} bytes (${estimate.source}) within ${policy.mac.metered_budget_mib} MiB${config.metered === 'allow' ? ' (metered: allow)' : ''}`);
        }
      }
    }

    // The write path, before any version is spent: put and delete builds/.probe/<run> as the writer.
    let s3 = 'ok';
    try {
      probe(await makeS3(), env.GITHUB_RUN_ID ?? 'local');
    } catch (error) {
      s3 = 'failed';
      throw refusal('s3', `the build directory write probe failed (${error.message.split('\n')[0]}); deliver would fail after the bump`);
    }

    const store = manifest.ios?.store ? { signer_sha1: manifest.ios.store.signer_sha1 ?? null, secrets: manifest.ios.store.secrets ?? [] } : null;
    const outputs = {
      ios_lane: iosLane,
      metered: link.link === 'metered',
      mac_link: scope.ios ? link.link : 'unknown',
      bundle: manifest.ios?.bundle ?? '',
      slug: app.slug,
      ios_store: store ? JSON.stringify(store) : '',
      policy: loaded.short,
    };
    await setOutputs(outputs, env);
    await writeReceipt(out, buildReceipt({
      lane: 'gate', config, env, notes: [`caller ${caller.hash.slice(0, 12)} accepted`, `mac ${link.link}: ${link.reason}`, `s26 ${s26}`, `s3 ${s3}`],
      gate: { ios_lane: iosLane, mac_link: outputs.mac_link, mac_addr: link.addr, s26, s3, caller: caller.hash, latest: latest ? { version: latest.version, mac_bytes: latest.mac_bytes ?? null } : null },
    }), env);
    log(`HUB_GATE ok policy=${loaded.short} mac=${scope.ios ? link.link : 'n/a'} s26=${s26} s3=${s3} ios_lane=${iosLane}`);
    return outputs;
  });
}
