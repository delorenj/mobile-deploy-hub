// When the Host Agent pushes (Story 9.5, AD-49, NFR-3): on a change, never on a clock. Three sources, one trailing debounce:
//   - the agent's own start (`start()` pokes once);
//   - a notification of the watch set over `hubPaths(env)` (the lock dir, `emulators/`, every `.lock`, `.queue` and `.reservations` dir and the
//     event dir, re-armed on every notification by `createWatchSet`): a Hold written by `hub-device`, a deploy job or a service route;
//   - a Reachability change seen on the request path (`observeDevicectl`, below).
// The debounce is `trailing` from tools/hub-api/stream.mjs, the hub's one clock file: its single one-shot timer starts when the first poke of a
// burst lands and the push runs once, `CHANGE_DEBOUNCE_MS` later, so a burst of writes is one push. A poke during a push marks it dirty and the
// run's end pokes once more: two pushes never overlap and no change is lost. Nothing arms without a poke, and nothing here retries a failed
// push (the pusher leaves it owed; the next notification or request pushes).
//
// `createAgentWatch({env, watch, push, timers, log})` -> `{start, poke, settled, close}`. `watch` is `fs.watch`, a test's fake, or null (no
// watcher: only a poke pushes). `timers` is the test seam of `trailing`. `start()` arms the watchers (synchronously) and pokes once.
import { createWatchSet, hubPaths } from '../hub-api/changes.mjs';
import { CHANGE_DEBOUNCE_MS, trailing } from '../hub-api/stream.mjs';
import { laneReachability } from '../device/claims.mjs';
import { createDevicectl } from '../ci/lib/devicectl.mjs';

const oneLine = value => String(value?.message ?? value).replace(/\s+/g, ' ').trim();

export function createAgentWatch({ env = process.env, watch = null, push, timers, log = {} } = {}) {
  const say = line => { try { log.err?.(line); } catch { /* a broken log seam never stops a watch */ } };
  const debounce = trailing(push, {
    delayMs: CHANGE_DEBOUNCE_MS,
    ...(timers ? { timers } : {}),
    onError: error => say(`HUB_AGENT_PUSH_FAILED ${oneLine(error)}`),
  });
  const set = watch ? createWatchSet({ paths: () => hubPaths(env), watch, onNotify: () => debounce.poke(), log: say }) : null;
  return {
    start() {
      try { set?.sync(); } catch (error) { say(`HUB_API_WATCH_FAILED sync ${oneLine(error)}`); }
      debounce.poke();
    },
    poke: debounce.poke,
    settled: debounce.settled,
    close() {
      set?.close();
      debounce.close();
    },
  };
}

// The request path's devicectl (`devicectl(args, timeout)`, sync or async, may throw): every `list devices` answer, or the throw, is mapped to the
// iPad's Reachability the way the readings are (`laneReachability`), and `onState(state)` hears it before the answer goes on unchanged. This is the
// only time the agent can see the iPad change (it reads it on a request, AD-35): `GET /status` and a lane take's `require_reachable` gate both
// read through it. The push's own read goes around it (the raw seam), so a push never triggers itself. Any other devicectl call passes through.
export function observeDevicectl(devicectl, { env = process.env, onState } = {}) {
  const real = devicectl ?? createDevicectl({ env });
  return async (args, ...rest) => {
    let document;
    let error;
    let threw = false;
    try { document = await real(args, ...rest); } catch (caught) { threw = true; error = caught; }
    if (Array.isArray(args) && args[0] === 'list' && args[1] === 'devices') {
      try { onState?.(await laneReachability({ env, devicectl: () => { if (threw) throw error; return document; } })); } catch { /* an observer never changes an answer */ }
    }
    if (threw) throw error;
    return document;
  };
}
