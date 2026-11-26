// A service's host snapshot (Story 8.2; AD-44): the slow observations of the host a read needs (the /proc inventory, the adb listing and the
// process start of every pid the lock dir names), gathered off the main thread (tools/device/observe-thread.mjs) and answered from memory,
// so one slow read or a lease wait that is spinning never stalls another request. Generic over the host's own `observe`, built the way
// readings.mjs is, so the Host Agent (Epic 9) reuses it.
//
// A snapshot is plain data: `{taken_at, inventory, adb, starts, live_starts}`. `adb` is the `queryAdb` result ({port, note, listed,
// serials}); `starts` and `live_starts` are Map(pid -> value). It holds only observations of the HOST. The lock dir, `registry.json` and the
// Event Log are read from disk on every request, and anything that passes with time (`stale`, `expected_end`, grace) is derived from `now`
// by the reader, never held here.
//
// The accessors answer at once from the last gather and start ONE `refresh()` when it is missing or older than `maxAgeMs` (a read starts
// it, a timer never does: tools/clock.test.mjs); at most one gather is ever in flight. Only `ready()` and `refresh()` await a gather.
// A failed gather is one `HUB_API_OBSERVE_FAILED <why>` line, keeps the last snapshot and never reaches a request; before any success
// it leaves an empty snapshot (`taken_at: null`, `adb.note` "the host could not be observed"), so the next read retries.
//
// A process start is trusted from the snapshot only while the snapshot is younger than `maxAgeMs` (one pass, JOB_POLL_MS). Otherwise,
// and for a pid the snapshot never saw, one shared cached reader answers (`cachedProcessStart`: one read per pid per pass), so a pid reused
// between a gather and a take never reads as gone for longer than that cache allows.
import { JOB_POLL_MS, cachedProcessStart, processStart } from '../ci/lib/lock.mjs';
import { liveStart } from '../device/emulator.mjs';
import { observeOffThread } from '../device/observe-thread.mjs';

export const NOT_OBSERVED = 'the host could not be observed';

const oneLine = value => String(value?.message ?? value).replace(/\s+/g, ' ').trim();
// `log` is a line function, or the service's `{out, err}` pair (its `err` is used).
const lineLog = log => (typeof log === 'function' ? log : typeof log?.err === 'function' ? log.err : () => {});

const emptySnapshot = env => ({
  taken_at: null,
  inventory: { adb_servers: [], emulators: [], xvfb: [] },
  adb: { port: Number(env?.HUB_ADB_SERVER_PORT) || 5037, note: NOT_OBSERVED, listed: [], serials: new Map() },
  starts: new Map(),
  live_starts: new Map(),
});

export function createSnapshot({ env = process.env, now = Date.now, maxAgeMs = JOB_POLL_MS, observe = observeOffThread, startOf = processStart, liveStartOf = liveStart, log } = {}) {
  const say = lineLog(log);
  const failed = error => { try { say(`HUB_API_OBSERVE_FAILED ${oneLine(error)}`); } catch { /* the log is best effort */ } };
  const fallbackStart = cachedProcessStart({ startOf, now: () => now(), ttlMs: maxAgeMs });
  const fallbackLive = cachedProcessStart({ startOf: liveStartOf, now: () => now(), ttlMs: maxAgeMs });
  let current = null;    // the last snapshot; null until the first gather has settled
  let inflight = null;

  async function gather() {
    // Stamped when the host was asked, not when it answered: a slow gather must not make its snapshot look fresher than it is.
    const at = now();
    try {
      const seen = await observe({ env });
      current = {
        taken_at: at,
        inventory: seen.inventory,
        adb: seen.adb,
        starts: new Map(seen.starts ?? []),
        live_starts: new Map(seen.live_starts ?? []),
      };
    } catch (error) {
      failed(error);
      current ??= emptySnapshot(env);
    }
  }

  // Joins the gather in flight, or starts one. Never rejects.
  const refresh = () => {
    if (inflight === null) {
      const run = gather().finally(() => { if (inflight === run) inflight = null; });
      inflight = run;
    }
    return inflight;
  };

  const ageOf = () => (current === null || current.taken_at === null ? Infinity : now() - current.taken_at);
  const young = () => { const age = ageOf(); return age >= 0 && age < maxAgeMs; };
  // The one rule every accessor follows: a missing or old snapshot starts one refresh; nothing here awaits it.
  const touch = () => { if (!young()) refresh(); };

  // pid -> when a gather was asked for it. A gather started after that ask that still lacks the pid has shown the host cannot observe
  // it, so it is not asked again: a pid nobody records never makes every poll start a worker.
  const chased = { starts: new Map(), live_starts: new Map() };
  const startFrom = (pid, key, fallback) => {
    if (young() && current[key].has(pid)) { chased[key].delete(pid); return current[key].get(pid); }
    // An old snapshot, or a pid it never saw (a new owner since the gather): one refresh, and this read goes through the shared cache.
    const asked = chased[key].get(pid);
    const settled = asked !== undefined && current?.taken_at != null && current.taken_at >= asked;
    if (!young()) refresh();
    // The first ask is the one a gather must postdate: a later ask while that chase is open never moves it, or a gather already in
    // flight could never settle it and every poll would start another.
    else if (!settled) { if (asked === undefined) chased[key].set(pid, now()); refresh(); }
    return fallback(pid);
  };

  return {
    read: () => current,
    ready: () => {
      touch();
      return current === null ? refresh() : Promise.resolve();
    },
    refresh,
    // A copy: a reader that marks the inventory's entries (status marks the pool's own processes) never changes the snapshot.
    inventory: () => {
      touch();
      return structuredClone((current ?? emptySnapshot(env)).inventory);
    },
    adbQuery: async () => {
      touch();
      if (current === null) await refresh();
      return { ...current.adb, checked_at: current.taken_at };
    },
    processStart: pid => startFrom(pid, 'starts', fallbackStart),
    liveStart: pid => startFrom(pid, 'live_starts', fallbackLive),
  };
}
