// The Hub API's one track socket (Story 8.3, AD-35, AD-19): a single `host:track-devices-l` stream on the hub's adb server, read through
// adb-wire.mjs's `trackDevices`, that feeds every pushed listing into the two caches every reader already uses. The host snapshot's adb
// half (`snapshot.track`) makes `/status`, `/discovery` and the readings probe live; the readings cache (`readings.track`) makes
// `/resources` and Pool matching live and is the single writer of the `reachability` events (the one appender is lock.mjs's
// `noteReachability`). No reader gains a path: a push is mapped by the same function a probe uses (claims.mjs `adbStateOf`).
//
// `ensure()` is the only thing that opens the socket, and it opens one only when there is no handle, the service is not stopped, `open`
// is set and the snapshot's inventory lists an adb server on the hub port (never a server this started: there is no start here). The
// service calls it after the first gather and on every request. A socket that closes is never reopened by a timer, a backoff or a loop:
// the next `ensure()` (a request) is what reopens it. When a socket that had opened closes, the snapshot returns to its gathers and the
// readings cache writes one `track-lost` event per live Resource and falls back to the probe. A socket that never opened writes
// nothing, and `stop()` closes the socket and writes nothing. An `open` or a callback that throws is one `HUB_API_TRACK_FAILED <why>`
// line and never reaches a request.
//
// The deploy path never imports this directory (tools/deploy-path.test.mjs).
import { adbStateOf, phonesOf } from '../device/claims.mjs';
import { phoneReachability } from '../registry/reachability.mjs';

const oneLine = value => String(value?.message ?? value).replace(/\s+/g, ' ').trim();
// `log` is a line function, or the service's `{out, err}` pair (its `err` is used).
const lineLog = log => (typeof log === 'function' ? log : typeof log?.err === 'function' ? log.err : () => {});
const ENDPOINT_ID = /^[^:\s]+:\d+$/;

export function createTrack({ env = process.env, now = Date.now, hostKey, records = () => [], snapshot, readings, open, log } = {}) {
  const say = lineLog(log);
  const failed = error => { try { say(`HUB_API_TRACK_FAILED ${oneLine(error)}`); } catch { /* the log is best effort */ } };
  const guarded = work => { try { return work(); } catch (error) { failed(error); return undefined; } };
  let session = null;    // the open (or opening) socket: {close, listed}; null when there is none
  let stopped = false;

  // adb phones live on the `linux` host; a host key that says anything else (or that cannot be read) has nothing to track.
  const onLinux = () => {
    if (typeof hostKey !== 'function') return true;
    try { return hostKey({ env }) === 'linux'; } catch { return false; }
  };

  // The listing mapped to Reachability for each own-host phone Resource, handed to the readings cache. A `device`-state `host:port` id
  // whose serial the last gather did not read starts one snapshot refresh (that is how an `adb connect` endpoint is tied to its phone),
  // and the listing is mapped again once it settles, unless a newer listing has arrived. A serial that stays unreadable reads absent:
  // the second mapping never asks again.
  function map(mine, listed, { chase }) {
    const serials = snapshot.read()?.adb?.serials ?? new Map();
    const adb = { note: null, listed, serials };
    const entries = [];
    for (const record of records()) {
      const phone = phonesOf([record])[0];
      if (phone === undefined) continue;
      entries.push({ id: record.id, state: phoneReachability(adbStateOf(adb, phone.serial)) });
    }
    // The mapping is computed first: a failure changes neither cache, so /status and /resources never disagree.
    snapshot.track(listed);
    readings.track(entries, { at: now() });
    if (chase && listed.some(entry => entry.state === 'device' && ENDPOINT_ID.test(entry.id) && !serials.get(entry.id))) {
      Promise.resolve(snapshot.refresh()).then(() => {
        if (session === mine && !stopped && mine.listed === listed) guarded(() => map(mine, listed, { chase: false }));
      }, failed);
    }
  }

  function onDevices(mine, listed) {
    if (session !== mine || stopped) return;
    mine.listed = listed;
    map(mine, listed, { chase: true });
  }

  function onClose(mine, { opened } = {}) {
    if (session !== mine) return;
    session = null;
    if (stopped || !opened) return;
    guarded(() => snapshot.untrack());
    guarded(() => readings.trackLost({ at: now() }));
  }

  function ensure() {
    try {
      if (session !== null || stopped || typeof open !== 'function') return;
      const found = snapshot.read();
      const port = Number(env.HUB_ADB_SERVER_PORT) || 5037;
      if (!found?.inventory?.adb_servers?.some(server => server.port === port)) return;
      if (!onLinux()) return;
      const mine = { close: null, listed: null };
      session = mine;
      try {
        const handle = open(port, { onDevices: listed => guarded(() => onDevices(mine, listed)), onClose: info => guarded(() => onClose(mine, info)) });
        mine.close = typeof handle?.close === 'function' ? () => handle.close() : null;
      } catch (error) {
        if (session === mine) session = null;
        failed(error);
      }
    } catch (error) { failed(error); }
  }

  // Closes the socket and writes nothing: the handle is cleared first, so the close's own callback is ignored.
  function stop() {
    stopped = true;
    const mine = session;
    session = null;
    if (mine !== null) guarded(() => mine.close?.());
  }

  return { ensure, stop, isOpen: () => session !== null };
}
