#!/usr/bin/env node
// Mobile Deploy Hub tool. The reusable workflow (.github/workflows/mobile-deploy.yml) calls one command per job
// through actions/hub; the same commands run locally from an app checkout. Design: docs/design-hub-v1.1.md.
//
//   gate           Linux, first: the policy (tools/ci/policy.json) on this run, the caller, the Mac's link, the S26,
//                  the build directory's write probe; decides the iPad lane (run, or skipped: offline or metered)
//   preflight-ios  Mac, no checkout: signing, profile, disk; the iPad's version, or unreachable (pending)
//   plan           Linux: the S26 (away is pending), the event contract, downgrade guards, the bump (real: commit,
//                  tag, atomic push to main) and inflight.json
//   android        Linux: build and check the APK, stage it for deliver, Quickdrop (real), install on the S26 or pending
//   play           AAB to Play (real --play runs only)
//   release        the private GitHub Release vX.Y.Z (real runs only, after the build checks)
//   ios-export     Linux half (Tower): Godot's Xcode projects, handed to the Mac as a delta
//   ios            Mac: the app's ios.device build, export, IPA checks, outbox, install on the iPad or pending
//   deliver        Linux: the build directory on S3 (versioned objects, manifest.plist, latest.json, pages), retention
//   announce       the event (real) or `bb-emit --check` of it (dry run), with statuses and download links
//
// Hooks come from the app's committed manifest and run under bash in the app root. Nothing here reads a hook, a ref
// or a command from an event payload, and no rule comes from an input: the policy is the file at the hub tag.
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { android, play, release, releaseArguments } from './commands/android.mjs';
import { announce } from './commands/announce.mjs';
import { deliver, mergeLatest } from './commands/deliver.mjs';
import { checkManifest, checkRun, gate } from './commands/gate.mjs';
import { ios, iosExport, keepInOutbox, newerOnDevice } from './commands/ios.mjs';
import { plan, preflightIos, sampleEvent } from './commands/plan.mjs';
import { parseConfig } from './lib/config.mjs';

export { android, announce, checkManifest, checkRun, deliver, gate, ios, iosExport, keepInOutbox, mergeLatest, newerOnDevice, plan, play, preflightIos, release, releaseArguments, sampleEvent };

export async function main(argv = process.argv.slice(2), env = process.env) {
  const config = parseConfig(argv, env);
  const commands = { gate, 'preflight-ios': preflightIos, plan, android, play, release, 'ios-export': iosExport, ios, deliver, announce };
  return commands[config.command](config, { env });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    const [first, ...rest] = error.message.split('\n');
    console.error(`::error::${first}`);
    if (rest.length > 0) console.error(rest.join('\n'));
    process.exitCode = 1;
  });
}
