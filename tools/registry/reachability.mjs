// Reachability (AD-35): the one enum a Resource's reading is told in, and the one mapper per transport that produces it. An
// agent that reads `unknown` knows nobody checked (or the transport could not say); it is never shown as `reachable`. Pure: no
// timers, no I/O beyond the `list` a caller injects to `readIpad`. A reading carries its age, computed on the reader's clock
// (`present`), and its staleness is derived when a view is built and never stored.
//
// The deploy path never imports this directory (tools/deploy-path.test.mjs).
import { idMatchesSerial } from '../ci/lib/adb.mjs';
import { inspectIpad } from '../ci/lib/devicectl.mjs';

export const REACHABILITY = Object.freeze({
  reachable: 'reachable',
  unauthorized: 'unauthorized',
  offline: 'offline',
  absent: 'absent',
  unknown: 'unknown',
});
const STATES = new Set(Object.values(REACHABILITY));
export const isReachability = value => STATES.has(value);

// ---- the mappers ----

// An adb phone: the state adb lists it in, or null when the server does not list it. `device` is reachable, `unauthorized` and
// `offline` say themselves, a phone the server does not list is absent, and anything else (`no adb server`, `adb did not
// answer`, `recovery`, `no`, undefined) is unknown: the transport could not say.
export function phoneReachability(observed) {
  if (observed === null) return REACHABILITY.absent;
  switch (observed) {
    case 'device': return REACHABILITY.reachable;
    case 'unauthorized': return REACHABILITY.unauthorized;
    case 'offline': return REACHABILITY.offline;
    default: return REACHABILITY.unknown;
  }
}

// The iPad, from `inspectIpad`: pass `{result}` (what it returned) or `{error}` (what it threw). The verdict never reads
// `tunnel`: the tunnel is the transport's own state, not the iPad's. A devicectl failure or timeout carries no `reason` and a
// record of the wrong model is `identity`; both are unknown.
export function ipadReachability({ result, error } = {}) {
  if (error !== undefined && error !== null) {
    switch (error.reason) {
      case 'not-listed': return REACHABILITY.absent;
      case 'unpaired':
      case 'developer-mode': return REACHABILITY.unauthorized;
      default: return REACHABILITY.unknown;
    }
  }
  if (!result || typeof result !== 'object') return REACHABILITY.unknown;
  if (result.proven !== true) return REACHABILITY.unknown;
  if (typeof result.boot_state === 'string' && result.boot_state !== 'booted') return REACHABILITY.offline;
  return REACHABILITY.reachable;
}

// Asks devicectl (`list()` returns its `list devices` document, or a promise of it, and may throw) and maps the iPad's record.
export async function readIpad({ list, udid, model }) {
  let document;
  try { document = await list(); } catch { return REACHABILITY.unknown; }
  try { return ipadReachability({ result: inspectIpad(document, { udid, model }) }); } catch (error) { return ipadReachability({ error }); }
}

// ---- the adb wire query (the one read-only question every consumer asks of the hub's adb server) ----

export const NO_SERVER = 'no adb server';
export const NO_ANSWER = 'adb did not answer';
const PROBE_MS = 5000;
const SERIAL_READ_MS = 1500;

// What is on the hub's adb server, read over the wire and never through the adb client: `host:version`, then `host:devices-l`, plus one
// `host:transport:<id>` + `shell:getprop ro.serialno` for each `host:port` id in `device` state, which is how a bare endpoint (what a
// manual `adb connect` leaves) is tied back to its phone. An id that cannot be read (unauthorized, offline, a read that fails or hangs)
// has no serial. `running` is the caller's own proof that the hub's server is already up (its inventory shows it): false opens no wire
// at all, so this can never start a server. `wire` is the `adbWire(port, {signal})` factory, always injected. Each serial read is
// bounded at 1.5 s, the whole query at 5 s, and its abort closes every socket at once. Returns `{port, note, listed, serials}`:
// `note` is null, `no adb server` or `adb did not answer` (a wedged or foreign server is an answer, never a failure); `listed` is the
// `devices-l` entries; `serials` maps a `host:port` id to the serial read from it.
async function readWire(wire, { sleep, signal }) {
  await wire.version();
  const listed = await wire.devicesLong();
  const serials = new Map();
  await Promise.all(listed.filter(entry => entry.state === 'device' && /^[^:\s]+:\d+$/.test(entry.id)).map(async entry => {
    const read = Promise.resolve().then(() => wire.shell(entry.id, 'getprop ro.serialno')).then(text => String(text).trim(), () => null);
    const serial = await Promise.race([read, sleep(SERIAL_READ_MS, signal).then(() => null)]);
    if (serial) serials.set(entry.id, serial);
  }));
  return { listed, serials };
}

export async function queryAdb({ port, running, wire, sleep }) {
  if (!running) return { port, note: NO_SERVER, listed: [], serials: new Map() };
  const unanswered = () => ({ port, note: NO_ANSWER, listed: [], serials: new Map() });
  const stopQuery = new AbortController();   // closes the wire's sockets the moment the query is done with them
  const giveUp = new AbortController();      // clears the race's timer once it settles
  try {
    const asked = readWire(wire(port, { signal: stopQuery.signal }), { sleep, signal: giveUp.signal });
    asked.catch(() => {});   // the race below may stop waiting first
    const answer = await Promise.race([asked.then(read => read, () => null), sleep(PROBE_MS, giveUp.signal).then(() => null)]);
    return answer === null ? unanswered() : { port, note: null, listed: answer.listed, serials: answer.serials };
  } catch {
    return unanswered();
  } finally {
    giveUp.abort();
    stopQuery.abort();
  }
}

// ---- discovery (FR-4): what the host can see that no Resource names ----

export const NO_DEVICECTL = 'devicectl did not answer';
const EMULATOR_ID = /^emulator-\d+$/;
const WIRELESS_ID = /^adb-(.+)-[^-]+\._adb-tls-connect\._tcp\.?$/;
const ENDPOINT_ID = /^[^:\s]+:\d+$/;

// The serial a listed id stands for: the `ro.serialno` read for a `host:port` id (null when unreadable or not read), the serial inside
// an mDNS id, else the id itself (over USB the id is the serial).
function serialOf(entry, serials) {
  if (ENDPOINT_ID.test(entry.id)) return serials.get(entry.id) || null;
  return WIRELESS_ID.exec(entry.id)?.[1] ?? entry.id;
}

// The devices the host can see that a seeded Resource does not name. Pure over its inputs: `seed` is a `seed()` result or a resources
// array, `host` is `linux` (adb: the `queryAdb` result) or `mac` (ipads: `{document}`, devicectl's `list devices` result, or `{error}`).
// Returns `{format: 1, port, devices, host, via, note}`, each device `{serial, model, id, state}`. Linux skips `emulator-<n>` ids (the
// emulator Pool names emulators) and every device a phone Resource names; the Mac lists every devicectl record whose UDID is not seeded.
export function discover({ seed, host, adb, ipads } = {}) {
  const resources = Array.isArray(seed) ? seed : seed?.resources ?? [];
  if (host === 'mac') {
    const udids = new Set(resources.map(resource => resource?.identity?.udid).filter(udid => typeof udid === 'string'));
    const records = ipads?.document?.result?.devices;
    const answered = ipads?.error === undefined && ipads?.document !== undefined && ipads?.document !== null && (records === undefined || Array.isArray(records));
    const devices = answered ? (records ?? []).filter(record => !udids.has(record?.hardwareProperties?.udid)).map(record => ({
      serial: record?.hardwareProperties?.udid ?? null,
      model: record?.hardwareProperties?.productType ?? null,
      id: record?.identifier ?? null,
      state: record?.connectionProperties?.pairingState ?? null,
    })) : [];
    return { format: 1, port: null, devices, host: 'mac', via: 'devicectl', note: answered ? null : NO_DEVICECTL };
  }
  const serials = resources.filter(resource => resource?.kind === 'phone' && typeof resource.identity?.serial === 'string').map(resource => resource.identity.serial);
  const read = adb.serials ?? new Map();
  const devices = [];
  for (const entry of adb.listed ?? []) {
    if (EMULATOR_ID.test(entry.id)) continue;
    const serial = serialOf(entry, read);
    if (serials.some(known => idMatchesSerial(entry.id, known) || (Boolean(read.get(entry.id)) && read.get(entry.id) === known))) continue;
    devices.push({ serial, model: entry.model ?? null, id: entry.id, state: entry.state });
  }
  return { format: 1, port: adb.port, devices, host: 'linux', via: 'adb', note: adb.note ?? null };
}

// ---- readings ----

const isoOf = value => {
  const ms = typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(ms)) throw new TypeError(`stamp: ${JSON.stringify(value)} is not a time`);
  return new Date(ms).toISOString();
};

// What is stored of one reading: the state, when it was checked (`checked_at`), and the age it already had when this reader
// received it (`age_ms_at_receipt`, 0 for a reading this reader took itself) with the reader's own clock at receipt
// (`received_at`, ms). A state outside the enum is refused.
export function stamp(state, { checkedAt, receivedAt, ageMsAtReceipt = 0 }) {
  if (!isReachability(state)) throw new TypeError(`stamp: "${state}" is not a Reachability (${Object.values(REACHABILITY).join(', ')})`);
  if (!Number.isFinite(receivedAt)) throw new TypeError('stamp: receivedAt is the reader\'s clock in ms');
  if (!Number.isFinite(ageMsAtReceipt) || ageMsAtReceipt < 0) throw new TypeError('stamp: ageMsAtReceipt is 0 or more ms');
  return { state, checked_at: isoOf(checkedAt), age_ms_at_receipt: ageMsAtReceipt, received_at: receivedAt };
}

// A row with no reading: nobody checked.
export const MISSING = Object.freeze({ state: REACHABILITY.unknown, checked_at: null, age_ms: null, stale: true });

// A stored reading as a row shows it: `age_ms` is the age at receipt plus the time since receipt on THIS clock, so a sender's
// clock never decides it. `stale` is derived here: true for no reading, for a limit that is unavailable (no policy), and for an
// age over the limit (exactly the limit is still current). It is never written anywhere.
export function present(stored, { now, maxAgeS } = {}) {
  if (!stored || !isReachability(stored.state) || !Number.isFinite(stored.received_at) || !Number.isFinite(stored.age_ms_at_receipt)) return { ...MISSING };
  const age = Math.max(0, stored.age_ms_at_receipt + now - stored.received_at);
  const limited = Number.isSafeInteger(maxAgeS) && maxAgeS > 0;
  return { state: stored.state, checked_at: stored.checked_at ?? null, age_ms: age, stale: !limited || age > maxAgeS * 1000 };
}

// ---- crossing a boundary: serve and receive ----

// The served form of "nobody checked": every field of a reading, null but the state.
export const NO_READING = Object.freeze({ state: REACHABILITY.unknown, checked_at: null, age_ms_at_receipt: null, received_at: null, source: null });

const isReading = stored => Boolean(stored) && isReachability(stored.state) && Number.isFinite(stored.received_at) && Number.isFinite(stored.age_ms_at_receipt);

// A stored reading as a service answers a request for it, on the service's clock `now` (ms): the age it has AS OF THIS RESPONSE
// (`age_ms_at_receipt` plus the time since the service stored it) and `received_at` the service's own `now`. A reader on the same
// host computes `age_ms_at_receipt + now - received_at` exactly; a reader on another host re-stamps with `receive` first, so neither
// clock can make the reading look fresher than it is. `stale` is never served (a reader derives it); no reading is `NO_READING`.
export function serve(stored, { now } = {}) {
  if (!isReading(stored)) return { ...NO_READING };
  const age = Math.max(0, stored.age_ms_at_receipt + now - stored.received_at);
  return { state: stored.state, checked_at: stored.checked_at ?? null, age_ms_at_receipt: age, received_at: now, source: stored.source ?? 'probe' };
}

// A served reading as the reader stores it: the age it was served with stays, `received_at` becomes the READER's clock `now` (ms), so
// `present(receive(x, {now: t}), {now: t + d})` has `age_ms = x.age_ms_at_receipt + d` whatever either clock says. An unknown or empty
// reading (nobody checked, or nobody could say) is null: a reader shows it as the missing reading.
export function receive(served, { now } = {}) {
  if (!isReading(served) || served.state === REACHABILITY.unknown) return null;
  return { state: served.state, checked_at: served.checked_at ?? null, age_ms_at_receipt: served.age_ms_at_receipt, received_at: now, source: served.source ?? 'probe' };
}
