// The Host Agent process (Story 9.2, AD-25, AD-45): the Hub API's generic start (`startService`: the Node check, the bind on 127.0.0.1, the
// EADDRINUSE singleton, SIGTERM and SIGINT, the lease-wait registry) with the agent's route table (tools/host-agent/routes.mjs), on the
// policy's `api.host_agent_port`. It boots no emulator, so `heavy` is not required. The start work after the bind is one
// request for the Registry's resources (`known.refresh`), never awaited: a failed one is one stderr line and the seed answers; and the push
// machinery (Story 9.5, AD-49): the watcher over the hub's lock and event dirs, and one poke, so the Hub API hears of this host within 250 ms of
// its start. After that the agent pushes only on a change: a lock or event dir write, an iPad Reachability change seen on a request, or the next
// request after a failed push. There is no timer, interval or poll anywhere under tools/host-agent/ (tools/clock.test.mjs): the one one-shot
// debounce is `trailing` in tools/hub-api/stream.mjs.
//
// `main({argv})` takes only `--launchd`: under launchd a second instance (the port is taken) exits 0, so `KeepAlive {SuccessfulExit: false}`
// does not respawn it. Every other argument prints the usage on stderr and exits 2. The deploy path never imports this file.
import { mkdirSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { hostId as realHostId, eventDir } from '../ci/lib/events.mjs';
import { lockDir } from '../ci/lib/lock.mjs';
import { loadPolicy } from '../ci/lib/policy.mjs';
import { withoutDeployIdentity, exitCodeOf, hostKey as realHostKey } from '../device/claims.mjs';
import { startService, watchFor } from '../hub-api/server.mjs';
import { mintBoot } from '../hub-api/stream.mjs';
import { HOST_AGENT_SERVICE, request as hubRequest } from '../hub-client.mjs';
import { AGENT_ROUTES, agentStatus } from './routes.mjs';
import { createKnown } from './known.mjs';
import { createPusher, laneReadings } from './push.mjs';
import { createAgentWatch, observeDevicectl } from './watch.mjs';

export const USAGE = 'usage: node tools/host-agent/server.mjs [--launchd]';

const oneLine = value => String(value?.message ?? value).replace(/\s+/g, ' ').trim();
const defaultLog = () => ({ out: line => console.log(line), err: line => console.error(line) });

// Starts the agent: the policy's port, the context the routes read (`known`, and the device seams `hostKey`, `devicectl`, `inventory`,
// `processStart`, `liveStart`), then `startService`. Test seams: `request` (the one Hub API transport: `known.refresh` and every push go through it;
// default `hub-client.request`), `known`, `routes`, and every `startService` seam (`createServer`, `versions`, `signals`). The push's: `watch`
// (`fs.watch`, a fake, or null for none; a faked host, one with an injected `inventory` or `devicectl`, runs no real watcher: the Hub API's rule,
// `watchFor`), `timers` (the debounce's), `hostId` (a function or a value; default `events.mjs` `hostId`) and `boot` (default `mintBoot()`, once per start).
export async function startHostAgent({ policy, env: given = process.env, log = defaultLog(), now, devices, qaDevices, hostKey, devicectl, inventory, processStart, liveStart, request, known: injected, routes = AGENT_ROUTES, watch: injectedWatch, timers, hostId: injectedHostId, boot = mintBoot(), ...seams } = {}) {
  const env = withoutDeployIdentity(given);
  const resolved = policy ?? loadPolicy().policy;
  const known = injected ?? createKnown({ env, devices, qaDevices, log });
  const send = request ?? (args => hubRequest(args, { policy: resolved, ...(hostKey ? { hostKey: () => hostKey({ env }) } : {}), ...(devices ? { devices } : {}) }));
  const keyOf = () => (hostKey ?? realHostKey)({ env });
  // The push's own reads (`agentStatus` and the lane readings) use the RAW devicectl, so a push never looks like a request-path read.
  const pushCtx = { env, policy: resolved, now, devices, qaDevices, hostKey, devicectl, inventory, processStart, liveStart, known, request: send, log };
  const pusher = createPusher({
    policy: resolved, env, hostKey: keyOf, hostId: typeof injectedHostId === 'function' ? injectedHostId : injectedHostId !== undefined ? () => injectedHostId : () => realHostId(),
    boot, now: now ?? Date.now, send, status: () => agentStatus(pushCtx), readings: () => laneReadings(pushCtx), log,
  });
  const watch = watchFor({ watch: injectedWatch, faked: inventory !== undefined || devicectl !== undefined });
  const pushes = createAgentWatch({ env, watch, push: pusher.push, timers, log });
  // The request path's devicectl: an iPad state that differs from the one the last push carried is a change, so it pokes.
  const observed = observeDevicectl(devicectl, {
    env,
    onState: state => { const carried = pusher.carried(); if (carried === null || [...carried.values()].some(held => held !== state)) pushes.poke(); },
  });
  const ctx = {
    ...pushCtx, devicectl: observed,
    // A request to the agent pokes when the last push failed: the failed one is not retried on a timer, so this is the next chance.
    onRequest: () => { if (pusher.owed()) pushes.poke(); },
    // `POST /agent/sync` (Story 10.1): hands the agent the Hub API's replica sizes and makes it push from them.
    sync: replica => pusher.sync(replica),
  };
  // After the bind has won: one request for the Registry's resources, started and never waited for (`refresh` never rejects), then the watchers
  // (the directories exist first: a watch needs them, and a writer creates them lazily; only when a watcher really runs) and the one start poke.
  const afterBind = () => {
    known.refresh({ request: send });
    if (watch) {
      for (const [dir, options] of [[lockDir(env), { recursive: true }], [eventDir(env), { recursive: true, mode: 0o700 }]]) {
        try { mkdirSync(dir, options); } catch (error) { log.err(`HUB_API_WATCH_FAILED ${dir} ${oneLine(error)}`); }
      }
    }
    pushes.start();
  };
  return startService({ ...seams, service: HOST_AGENT_SERVICE, port: resolved.api.host_agent_port, routes, ctx, heavy: false, afterBind, onStop: () => pushes.close(), env, log });
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
