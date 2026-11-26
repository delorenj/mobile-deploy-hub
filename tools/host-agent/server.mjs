// The Host Agent process (Story 9.2, AD-25, AD-45): the Hub API's generic start (`startService`: the Node check, the bind on 127.0.0.1, the
// EADDRINUSE singleton, SIGTERM and SIGINT, the lease-wait registry) with the agent's route table (tools/host-agent/routes.mjs), on the
// policy's `api.host_agent_port`. It boots no emulator, so `heavy` is not required. The only start work after the bind is one
// request for the Registry's resources (`known.refresh`), never awaited: a failed one is one stderr line and the seed answers. There is
// no timer, interval or poll anywhere under tools/host-agent/ (tools/clock.test.mjs).
//
// `main({argv})` takes only `--launchd`: under launchd a second instance (the port is taken) exits 0, so `KeepAlive {SuccessfulExit: false}`
// does not respawn it. Every other argument prints the usage on stderr and exits 2. The deploy path never imports this file.
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { loadPolicy } from '../ci/lib/policy.mjs';
import { withoutDeployIdentity, exitCodeOf } from '../device/claims.mjs';
import { startService } from '../hub-api/server.mjs';
import { HOST_AGENT_SERVICE, request as hubRequest } from '../hub-client.mjs';
import { AGENT_ROUTES } from './routes.mjs';
import { createKnown } from './known.mjs';

export const USAGE = 'usage: node tools/host-agent/server.mjs [--launchd]';

const oneLine = value => String(value?.message ?? value).replace(/\s+/g, ' ').trim();
const defaultLog = () => ({ out: line => console.log(line), err: line => console.error(line) });

// Starts the agent: the policy's port, the context the routes read (`known`, and the device seams `hostKey`, `devicectl`, `inventory`,
// `processStart`, `liveStart`), then `startService`. Test seams: `request` (the Hub API call `known.refresh` makes; default
// `hub-client.request`), `known`, `routes`, and every `startService` seam (`createServer`, `versions`, `signals`).
export async function startHostAgent({ policy, env: given = process.env, log = defaultLog(), now, devices, qaDevices, hostKey, devicectl, inventory, processStart, liveStart, request, known: injected, routes = AGENT_ROUTES, ...seams } = {}) {
  const env = withoutDeployIdentity(given);
  const resolved = policy ?? loadPolicy().policy;
  const known = injected ?? createKnown({ env, devices, qaDevices, log });
  const send = request ?? (args => hubRequest(args, { policy: resolved, ...(hostKey ? { hostKey: () => hostKey({ env }) } : {}), ...(devices ? { devices } : {}) }));
  const ctx = { policy: resolved, now, devices, qaDevices, hostKey, devicectl, inventory, processStart, liveStart, known };
  // After the bind has won, one request for the Registry's resources, started and never waited for (`refresh` never rejects).
  const afterBind = () => { known.refresh({ request: send }); };
  return startService({ ...seams, service: HOST_AGENT_SERVICE, port: resolved.api.host_agent_port, routes, ctx, heavy: false, afterBind, env, log });
}

// The process entry: 0 after a stop; an error prints `<CODE> <message>` on stderr and returns its `exit`.
export async function main({ argv = process.argv.slice(2), log = defaultLog(), ...opts } = {}) {
  if (argv.some(argument => argument !== '--launchd')) {
    log.err(USAGE);
    return 2;
  }
  try {
    const running = await startHostAgent({ log, ...opts });
    await running.stopped;
    return 0;
  } catch (error) {
    log.err(`${error?.code ?? 'HUB_API_ERROR'} ${oneLine(error)}`);
    if (argv.includes('--launchd') && error?.code === 'HUB_API_ALREADY_RUNNING') return 0;
    return Number.isInteger(error?.exit) ? error.exit : exitCodeOf(error);
  }
}

const entry = process.argv[1] ? pathToFileURL(realpathSync(process.argv[1])).href : null;
if (entry === import.meta.url) main().then(code => { process.exitCode = code; });
