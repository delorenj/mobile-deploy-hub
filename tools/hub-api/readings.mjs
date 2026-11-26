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
// The track socket (Story 8.3, AD-35) is the second writer of this cache and shares its `logged` map, so the Event Log still has one
// writer per state change. `track(entries, {at})` stores `source: 'track'` readings for the Resources it names and marks them live;
// `read()` serves a live reading as current, stamped at the read's own `now` (the socket pushes every change, so a silent one means the
// state still holds; the stamp is derived when served and never stored), and a live reading never starts a probe. A probe never
// overwrites a live reading. `trackLost({at})` (the socket closed) writes one `reachability` event per live id, `to: 'unknown'`, drops
// those readings and clears the live set, so the next read probes. Nothing here opens a socket or starts a timer.
//
// A pushing host is the third writer (Story 9.5, AD-49): `remote(entries, {at})` stores what a Host Agent's push carried for the Resources
// on its host, each `receive`d on this service's clock (`at`), so a reader's clock and the sender's never decide how old one looks. A pushed
// reading is never probed, never live and never written to the Event Log: only a host's own service logs a `reachability` event.
//
// The deploy path never imports this directory (tools/deploy-path.test.mjs).
import { noteReachability } from '../ci/lib/lock.mjs';
import { sleep as realSleep } from '../ci/lib/pause.mjs';
import { hostKey as realHostKey, phoneReadings, phonesOf } from '../device/claims.mjs';
import { isReachability, present, receive, serve, stamp } from '../registry/reachability.mjs';

const oneLine = value => String(value?.message ?? value).replace(/\s+/g, ' ').trim();

// The context the Claims library's read-only device calls take (`phoneReadings`, `discover`), from a service context's seams.
export function deviceCtx(ctx = {}) {
  const env = ctx.env ?? process.env;
  const { adbWire, inventory, devicectl, adbQuery, processStart, liveStart } = ctx;
  const warn = line => { try { ctx.log?.err?.(line); } catch { /* a broken log seam never changes an answer */ } };
  return { env, timing: { sleep: ctx.sleep ?? realSleep, now: ctx.now ?? Date.now }, adbWire, inventory, devicectl, adbQuery, processStart, liveStart, warn };
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
  const live = new Set();      // Resource ids the track socket is reporting on right now
  let inflight = null;

  const hostKeyOrNull = () => { try { return keyOf() ?? null; } catch { return null; } };

  // Writes one `reachability` event when `state` differs from the last this cache logged (the one rule for the probe and the socket;
  // `always` is a loss of the socket, which is written for every live id).
  function noteChange(id, state, checkedAt, reason, { always = false } = {}) {
    if (!always && logged.get(id) === state) return;
    const noted = note({ resource: id, from: logged.get(id) ?? null, to: state, checked_at: checkedAt, reason }, { env, now, hostId, log: say });
    if (noted === true) logged.set(id, state);
  }

  async function refresh(own) {
    // Stamped when adb was asked, not when it answered: a slow probe must not make its reading look fresher than it is.
    const at = now();
    let states;
    try { states = await ask(phonesOf(own)); } catch (error) { failed(error); return; }
    for (const record of own) {
      try {
        const state = states?.get?.(record.name) ?? states?.get?.(record.id);
        if (!isReachability(state)) continue;
        if (live.has(record.id)) continue;   // the socket's word is newer than a probe that started before it
        const reading = { ...stamp(state, { checkedAt: at, receivedAt: at }), source: 'probe' };
        stored.set(record.id, reading);
        noteChange(record.id, state, reading.checked_at, 'probe');
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
      const isLive = live.has(record.id) && stored.has(record.id);
      // A live reading is as old as this read: the socket would have said otherwise.
      const reading = isLive ? { ...stamp(stored.get(record.id).state, { checkedAt: at, receivedAt: at }), source: 'track' } : stored.get(record.id) ?? null;
      served.set(record.id, serve(reading, { now: at }));
      if (key !== null && record.kind === 'phone' && record.host === key) {
        own.push(record);
        if (!isLive && present(reading, { now: at, maxAgeS }).stale) needed = true;
      }
    }
    if (needed && inflight === null) {
      inflight = refresh(own).catch(failed).finally(() => { inflight = null; });
    }
    return served;
  }

  // The socket's listing, mapped: `entries` are `{id, state}` (a Resource id and its Reachability) for the own-host phones it covers.
  // Ids the socket no longer covers (a retired Resource) stop being live and fall back to the probe.
  function track(entries = [], { at = now() } = {}) {
    const covered = new Set();
    for (const entry of entries) {
      try {
        if (!isReachability(entry?.state)) continue;
        const reading = { ...stamp(entry.state, { checkedAt: at, receivedAt: at }), source: 'track' };
        stored.set(entry.id, reading);
        covered.add(entry.id);
        live.add(entry.id);
        noteChange(entry.id, entry.state, reading.checked_at, 'track');
      } catch (error) { failed(error); }
    }
    for (const id of [...live]) if (!covered.has(id)) { live.delete(id); stored.delete(id); }
  }

  // The socket closed: nobody is watching any more. One event per live id (`to: 'unknown'`), then the readings go and the next read probes.
  function trackLost({ at = now() } = {}) {
    for (const id of [...live]) {
      try { noteChange(id, 'unknown', at, 'track-lost', { always: true }); } catch (error) { failed(error); }
      stored.delete(id);
    }
    live.clear();
  }

  // A pushed host's readings: `entries` are `{id, served}` (a Resource id and its reading in the served form). `receive` re-stamps each one with
  // `at`; a reading nobody could take (`unknown`) drops the stored one, so the row reads as missing again. A Resource this service tracks live
  // is never overwritten (it is on this host: nothing pushes for it).
  function remote(entries = [], { at = now() } = {}) {
    for (const entry of entries) {
      try {
        if (live.has(entry.id)) continue;
        const reading = receive(entry.served, { now: at });
        if (reading === null) stored.delete(entry.id);
        else stored.set(entry.id, reading);
      } catch (error) { failed(error); }
    }
  }

  return { read, track, trackLost, remote, settled: () => inflight ?? Promise.resolve() };
}
