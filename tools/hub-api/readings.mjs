// A service's Reachability readings (AD-35): the cache a host's API serves from and the one rule for refreshing it. Generic over the
// host's own probe, so the Hub API passes the adb one (claims.phoneReadings) and the Host Agent (Epic 7) passes its devicectl one and
// gets the same behaviour.
//
// `read(records)` is synchronous and never waits for a probe: it answers every record from the cache (the served form, `serve`) and,
// when an own-host phone's reading is missing or stale, starts ONE async refresh (at most one in flight). The only thing that starts
// a refresh is a read: there is no timer here (tools/clock.test.mjs). A refresh stores what the probe said and writes one `reachability`
// event per state that differs from the last this cache logged (the Event Log's one appender is lock.mjs's `noteReachability`). A
// probe or note that throws is one `HUB_API_REACHABILITY_FAILED` line on `log` and never reaches a request.
//
// The deploy path never imports this directory (tools/deploy-path.test.mjs).
import { noteReachability } from '../ci/lib/lock.mjs';
import { sleep as realSleep } from '../ci/lib/pause.mjs';
import { hostKey as realHostKey, phoneReadings, phonesOf } from '../device/claims.mjs';
import { isReachability, present, serve, stamp } from '../registry/reachability.mjs';

const oneLine = value => String(value?.message ?? value).replace(/\s+/g, ' ').trim();

// The context the Claims library's read-only device calls take (`phoneReadings`, `discover`), from a service context's seams.
export function deviceCtx(ctx = {}) {
  const env = ctx.env ?? process.env;
  const { adbWire, inventory, devicectl } = ctx;
  const warn = line => { try { ctx.log?.err?.(line); } catch { /* a broken log seam never changes an answer */ } };
  return { env, timing: { sleep: ctx.sleep ?? realSleep, now: ctx.now ?? Date.now }, adbWire, inventory, devicectl, warn };
}

// `log` is a line function, or the service's `{out, err}` pair (its `err` is used).
const lineLog = log => (typeof log === 'function' ? log : typeof log?.err === 'function' ? log.err : () => {});

export function createReadings({ env = process.env, policy, now = Date.now, hostId, log, hostKey, probe, note = noteReachability, ...seams } = {}) {
  const say = lineLog(log);
  const failed = error => { try { say(`HUB_API_REACHABILITY_FAILED ${oneLine(error)}`); } catch { /* the log is best effort */ } };
  const keyOf = () => (typeof hostKey === 'function' ? hostKey : realHostKey)({ env });
  const ask = probe ?? (phones => phoneReadings(phones, deviceCtx({ env, now, log: { err: say }, ...seams })));
  const stored = new Map();    // Resource id -> stored reading
  const logged = new Map();    // Resource id -> the last state this cache wrote an event for
  let inflight = null;

  const hostKeyOrNull = () => { try { return keyOf() ?? null; } catch { return null; } };

  async function refresh(own) {
    // Stamped when adb was asked, not when it answered: a slow probe must not make its reading look fresher than it is.
    const at = now();
    let states;
    try { states = await ask(phonesOf(own)); } catch (error) { failed(error); return; }
    for (const record of own) {
      try {
        const state = states?.get?.(record.name) ?? states?.get?.(record.id);
        if (!isReachability(state)) continue;
        const reading = { ...stamp(state, { checkedAt: at, receivedAt: at }), source: 'probe' };
        stored.set(record.id, reading);
        if (logged.get(record.id) === state) continue;
        const noted = note({ resource: record.id, from: logged.get(record.id) ?? null, to: state, checked_at: reading.checked_at, reason: 'probe' }, { env, now, hostId, log: say });
        if (noted === true) logged.set(record.id, state);
      } catch (error) { failed(error); }
    }
  }

  function read(records = []) {
    const at = now();
    const maxAgeS = policy?.registry?.reachability_max_age_s;
    const key = hostKeyOrNull();
    const served = new Map();
    const own = [];
    let needed = false;
    for (const record of records) {
      const reading = stored.get(record.id) ?? null;
      served.set(record.id, serve(reading, { now: at }));
      if (key !== null && record.kind === 'phone' && record.host === key) {
        own.push(record);
        if (present(reading, { now: at, maxAgeS }).stale) needed = true;
      }
    }
    if (needed && inflight === null) {
      inflight = refresh(own).catch(failed).finally(() => { inflight = null; });
    }
    return served;
  }

  return { read, settled: () => inflight ?? Promise.resolve() };
}
