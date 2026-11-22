#!/usr/bin/env node
// Candybar mobile-deploy-hub-ios-catchup: the iPad catch-up's clock. Candybar fires this on big-chungus every 5
// minutes (policy catch_up.ios_every_s); this runs the pass on the Mac by kickstarting its LaunchAgent, which no longer
// has a StartInterval of its own (two clocks would double-run a pass that can install a build on the iPad). devicectl
// and the keychain work only inside the logged-in GUI session, so the pass cannot be started by ssh directly:
// `launchctl kickstart gui/<uid>/<label>` is the supported way to run a GUI-domain job on demand from outside it.
//
// One invocation: read the job, kick it, wait (bounded) until it has run and stopped, report its `last exit code`.
//   job already running   exit 0, "HUB_MAC_BUSY": a pass in flight (a slow install) is never kicked twice or waited on
//                         by a pile of invocations; the one that started it owns the verdict.
//   Mac unreachable       exit 0, "HUB_MAC_AWAY": a hotspot, a DERP relay and a sleeping lid are normal for this Mac
//                         (handoff.mjs). The hub already treats them as not-a-failure; a red run every 5 minutes for an
//                         hour of lid-closed would bury a real failure. The message lands in `candybar history`.
//   pass exited nonzero   exit 1: a real catch-up failure.
// The verdict also goes to CANDYBAR_RESULT_FILE (AD-8), so history shows the message, not just an exit code.
// `--check` reads and prints the job's state and kicks nothing (hand test, no side effect).
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { connectionError } from '../../tools/ci/lib/handoff.mjs';

const HOST = process.env.HUB_MAC_HOST ?? 'hub-mac';
const LABEL = 'sh.delo.mobile-deploy-hub.catchup';
const WAIT_MS = Number(process.env.HUB_KICK_WAIT_MS ?? 20 * 60_000);
const START_GRACE_MS = 60_000;
// The same ssh options handoff.mjs uses for this host.
const SSH = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=30', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=4'];
const PRINT = `launchctl print gui/$(id -u)/${LABEL}`;

// `launchctl print` output -> what matters. The job's own `state =` is the first one; the coalition blocks below it
// carry their own `state = active`. `last exit code` reads "(never exited)" before the first run.
export function parseJob(text) {
  const state = /^\s*state = (.+)$/m.exec(text)?.[1].trim() ?? null;
  const runs = /^\s*runs = (\d+)$/m.exec(text)?.[1];
  const exit = /^\s*last exit code = (-?\d+)$/m.exec(text)?.[1];
  const signal = /^\s*last terminating signal = (.+)$/m.exec(text)?.[1].trim() ?? null;
  return { state, running: state === 'running', runs: runs === undefined ? null : Number(runs), lastExit: exit === undefined ? null : Number(exit), signal };
}

// Before/after readings -> a verdict. `kind` is what the caller does: pass (exit 0), fail (exit 1), wait (poll again).
export function verdict(before, after, { elapsedMs = 0, graceMs = START_GRACE_MS } = {}) {
  if (after.running) return { kind: 'wait' };
  if (after.runs === before.runs) return elapsedMs >= graceMs ? { kind: 'fail', message: `kickstart started no pass within ${Math.round(graceMs / 1000)}s (runs stayed ${after.runs})` } : { kind: 'wait' };
  if (after.lastExit === 0 && !after.signal) return { kind: 'pass', message: `iPad catch-up pass ok (run ${after.runs})` };
  return { kind: 'fail', message: `iPad catch-up pass failed: last exit code ${after.lastExit}${after.signal ? `, ${after.signal}` : ''} (run ${after.runs}); see ~/Library/Logs/mobile-deploy-hub/catchup.log on the Mac` };
}

const sleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// One ssh command on the Mac. A transport failure throws an Error whose text connectionError() recognises.
function remote(command) {
  const result = spawnSync('ssh', [...SSH, HOST, command], { encoding: 'utf8', timeout: 90_000 });
  if (result.error) throw new Error(`ssh ${HOST}: ${result.error.message} (timed out)`);
  if (result.status === 255) throw new Error(`ssh ${HOST} exit 255: ${result.stderr.trim().split('\n').pop()}`);
  return result;
}

function read() {
  const result = remote(PRINT);
  if (result.status !== 0) throw Object.assign(new Error(`${LABEL} is not loaded in the Mac's GUI session (launchctl exit ${result.status}): ${result.stderr.trim().split('\n').pop()}. Re-run mise run hosts:install`), { notLoaded: true });
  return parseJob(result.stdout);
}

function finish(kind, message) {
  const status = kind === 'fail' ? 'fail' : 'success';
  console.log(`${kind === 'fail' ? 'HUB_IOS_CATCHUP_FAIL' : 'HUB_IOS_CATCHUP'} ${message}`);
  if (process.env.CANDYBAR_RESULT_FILE) writeFileSync(process.env.CANDYBAR_RESULT_FILE, JSON.stringify({ status, message }));
  process.exitCode = status === 'fail' ? 1 : 0;
}

export function main(argv = process.argv.slice(2)) {
  try {
    const before = read();
    if (argv.includes('--check')) { console.log(JSON.stringify(before)); return; }
    if (before.running) return finish('pass', `HUB_MAC_BUSY ${LABEL} is already running (run ${before.runs}); not kicked again`);
    const kicked = remote(`launchctl kickstart gui/$(id -u)/${LABEL}`);
    if (kicked.status !== 0) return finish('fail', `launchctl kickstart exit ${kicked.status}: ${(kicked.stderr || kicked.stdout).trim().split('\n').pop()}`);
    const began = Date.now();
    for (let step = 0; ; step += 1) {
      const after = read();
      const elapsedMs = Date.now() - began;
      const outcome = verdict(before, after, { elapsedMs });
      if (outcome.kind !== 'wait') return finish(outcome.kind, outcome.message);
      if (elapsedMs >= WAIT_MS) return finish('fail', `the pass was still running after ${Math.round(WAIT_MS / 60_000)} min (run ${after.runs})`);
      sleep(step < 6 ? 2_000 : 10_000);
    }
  } catch (error) {
    if (!error.notLoaded && connectionError(error)) return finish('pass', `HUB_MAC_AWAY ${HOST} unreachable, the pass will be kicked at the next fire: ${String(error.message).split('\n')[0].slice(0, 200)}`);
    finish('fail', String(error.message).split('\n')[0].slice(0, 300));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
