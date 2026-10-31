// The emulator pool behind `hub-device lease|run emulator`: throwaway Android emulators on big-chungus, at most a few at a
// time, each one a lease like the S26's. A request queues first in, first out on the `emulator` lock (the gate); the head
// of the queue takes the first free slot lock (`emulator-1` .. `emulator-<pool>`), claims its ports by writing its record,
// and lets the gate go. It then makes everything it will run: its own AVD from a profile (in its own AVD home, never
// ~/.android/avd), its own adb server on a free 150xx port, and the emulator on a free console port, headless, wiped and
// without snapshots, until sys.boot_completed=1.
//
// The record (`<lock dir>/emulators/<lease_id>.json`) names every process the lease started, each with its start time
// (pid reuse), and every path it made. Teardown signals exactly those processes, after checking each is still the same
// process, SIGTERM and then SIGKILL after a grace; it never kills by name, pattern or process group. Helpers the emulator
// daemonizes (crashpad_handler, netsimd) are found by the lease's own marker in their environment
// (HUB_EMULATOR_LEASE=<lease_id>.<nonce>, the nonce kept in the record), recorded, and stopped the same way. The emulator
// runs with its own TMPDIR and XDG_RUNTIME_DIR, so it never shares a netsimd or discovery file with somebody else's emulator.
//
// There is no timer: every hub-device invocation first reaps the records whose lease expired, whose holder is gone, or
// whose slot no longer holds them.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, hostname, tmpdir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { adbEnv, adbPath } from '../ci/lib/adb.mjs';
import { androidSdk, javaHome } from '../ci/lib/android.mjs';
import { MAX_LEASE_MS, acquireLease, isLease, lockDir, processStart, readOwner, releaseLease, updateLease, withLock } from '../ci/lib/lock.mjs';
import { pause, sleep as realSleep } from '../ci/lib/pause.mjs';
import { createAdbWire } from './adb-wire.mjs';
import { inventory } from './inventory.mjs';

export const GATE = 'emulator';
export const slotName = k => `emulator-${k}`;
export const isEmulatorLock = name => name === GATE || /^emulator-\d+$/.test(name);
export const DEFAULT_POOL = 2;
export const MAX_POOL = 8;
const REAPER = 'emulator-reaper';
// Console ports stay above 5585: every adb server scans 5555-5585 for emulators, and one that scanned ours would attach it.
const CONSOLE_PORTS = [5600, 5698];
const ADB_SERVER_PORTS = [15000, 15099];

// A profile is what the throwaway AVD is made from: exactly one installed system image, never a fallback to another and
// never a download.
const PHONE = { api: 36, abi: 'x86_64', width: 1080, height: 2400, density: 420, ram_mb: 2048, cores: 4, data_partition: '6G' };
export const PROFILES = {
  default: { ...PHONE, tag: 'google_apis' },
  playstore: { ...PHONE, tag: 'google_apis_playstore' },
};

const failure = (code, message) => Object.assign(new Error(message), { code });
const homeOf = env => env.HOME || homedir();

export function resolveImage(profileName, { env = process.env, home = homeOf(env) } = {}) {
  const profile = PROFILES[profileName];
  if (!profile) throw failure('HUB_EMULATOR_USAGE', `unknown emulator profile "${profileName}" (known: ${Object.keys(PROFILES).join(', ')})`);
  const sdk = androidSdk(env, home);
  const sysdir = `system-images/android-${profile.api}/${profile.tag}/${profile.abi}/`;
  const image = `system-images;android-${profile.api};${profile.tag};${profile.abi}`;
  if (existsSync(join(sdk, sysdir, 'source.properties')) || existsSync(join(sdk, sysdir, 'package.xml'))) return { profile, sdk, tag: profile.tag, sysdir, package: image };
  throw failure('HUB_EMULATOR_NO_IMAGE', `emulator profile "${profileName}" needs ${image}, which is not installed under ${join(sdk, 'system-images')}; install it with sdkmanager "${image}"`);
}

// The pool's size is the host's: $HUB_EMULATOR_POOL, else the number in <lock dir>/emulator-pool, else 2. A request may only
// ask for fewer.
export function hostPool(env = process.env) {
  let text = env.HUB_EMULATOR_POOL;
  let source = 'HUB_EMULATOR_POOL';
  if (text === undefined || text === '') {
    try { text = readFileSync(join(lockDir(env), 'emulator-pool'), 'utf8').trim(); source = join(lockDir(env), 'emulator-pool'); } catch { return DEFAULT_POOL; }
  }
  const pool = Number(text);
  if (!Number.isSafeInteger(pool) || pool < 1 || pool > MAX_POOL) throw failure('HUB_EMULATOR_USAGE', `${source}: the emulator pool is 1 to ${MAX_POOL} emulators, not "${text}"`);
  return pool;
}

// ---- ports ----

// The host's TCP sockets from /proc/net/tcp and tcp6: local port, state (0A is LISTEN) and socket inode.
function tcpSockets(procRoot = '/proc') {
  const sockets = [];
  for (const file of ['net/tcp', 'net/tcp6']) {
    let text = '';
    try { text = readFileSync(join(procRoot, file), 'utf8'); } catch { continue; }
    for (const line of text.split('\n').slice(1)) {
      const fields = line.trim().split(/\s+/);
      const port = fields[1] ? Number.parseInt(fields[1].slice(fields[1].lastIndexOf(':') + 1), 16) : NaN;
      if (Number.isSafeInteger(port) && port > 0) sockets.push({ port, state: fields[3] ?? null, inode: fields[9] ?? null });
    }
  }
  return sockets;
}

// Every local TCP port with a socket on it (listening or not).
export const portsInUse = (procRoot = '/proc') => new Set(tcpSockets(procRoot).map(socket => socket.port));

// An override of a port range (tests, a crowded host). A console range may never reach down into 5554-5585, the ports
// every adb server scans for emulators.
function range(env, name, fallback, floor) {
  const text = env[name];
  if (text === undefined || text === '') return fallback;
  const match = /^(\d+)-(\d+)$/.exec(text);
  const [low, high] = match ? [Number(match[1]), Number(match[2])] : [NaN, NaN];
  if (!(low >= floor && high > low && high <= 65535)) throw failure('HUB_EMULATOR_USAGE', `${name}=${text}: a port range LOW-HIGH with LOW at least ${floor} and HIGH at most 65535`);
  return [low, high];
}

// A console port is even and its adb port is the next one; neither may be in use, claimed by another lease, or a port of
// a running emulator, so a pair never overlaps anybody's pair. 5554 (the default emulator) and 5037 (the default adb server)
// are never chosen.
export function choosePorts({ inUse = new Set(), claimed = [], emulators = [], adbServers = [], consoleRange = CONSOLE_PORTS, adbRange = ADB_SERVER_PORTS } = {}) {
  const taken = new Set([...inUse, ...claimed]);
  for (const emulator of emulators) {
    if (Number.isSafeInteger(emulator.console_port)) { taken.add(emulator.console_port); taken.add(emulator.console_port + 1); }
    if (Number.isSafeInteger(emulator.adb_server)) taken.add(emulator.adb_server);
  }
  for (const server of adbServers) if (Number.isSafeInteger(server.port)) taken.add(server.port);
  let console = null;
  for (let port = consoleRange[0] + (consoleRange[0] % 2); port < consoleRange[1]; port += 2) {
    if (port === 5554 || taken.has(port) || taken.has(port + 1)) continue;
    console = port;
    break;
  }
  let adbServer = null;
  for (let port = adbRange[0]; port <= adbRange[1]; port += 1) {
    if (port === 5037 || taken.has(port)) continue;
    adbServer = port;
    break;
  }
  if (console === null) throw failure('HUB_EMULATOR_NO_PORT', `no free console port pair in ${consoleRange.join('-')}`);
  if (adbServer === null) throw failure('HUB_EMULATOR_NO_PORT', `no free adb server port in ${adbRange.join('-')}`);
  return { console, adb: console + 1, adbServer };
}

// ---- processes ----

// The start time of a live process (lock.mjs's processStart, the identity its leases record), or null when it is gone
// or a zombie. A pid plus this is one process lifetime.
export function liveStart(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return null;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    if (/^[ZX]/.test(stat.slice(stat.lastIndexOf(')') + 2))) return null;
  } catch { return null; }
  return processStart(pid);
}

const sameProcess = entry => Boolean(entry.start) && liveStart(entry.pid) === entry.start;

// The processes carrying exactly this marker (`<lease_id>.<nonce>`, from the record) in their environment, with their
// start times.
export function markedProcesses(marker, procRoot = '/proc') {
  const found = [];
  if (!/^[a-z0-9][a-z0-9-]*\.[0-9a-f]{16}$/.test(marker ?? '')) return found;
  const entryWanted = `HUB_EMULATOR_LEASE=${marker}`;
  let entries = [];
  try { entries = readdirSync(procRoot).filter(entry => /^\d+$/.test(entry)); } catch { return found; }
  for (const entry of entries) {
    let environ;
    try { environ = readFileSync(join(procRoot, entry, 'environ'), 'utf8'); } catch { continue; }
    if (!environ.split('\0').includes(entryWanted)) continue;
    const pid = Number(entry);
    const start = liveStart(pid);
    if (!start) continue;
    let program = null;
    try { program = basename(readFileSync(join(procRoot, entry, 'cmdline'), 'utf8').split('\0')[0]) || null; } catch { /* gone */ }
    found.push({ pid, start, program });
  }
  return found;
}

// Signals exactly these processes, each only while it is still the recorded process (pid and start time): SIGTERM, then
// SIGKILL to whatever outlived graceMs. Never a process group, a name or a pattern. Returns who was signalled and who survived.
export async function stopProcesses(entries, { graceMs = 15_000, sleep = realSleep, now = Date.now, log = () => {} } = {}) {
  const send = (entry, signal) => {
    if (!sameProcess(entry)) return false;
    try { process.kill(entry.pid, signal); return true; } catch { return false; }
  };
  const signalled = entries.filter(entry => send(entry, 'SIGTERM')).map(entry => entry.pid);
  const deadline = now() + graceMs;
  while (entries.some(sameProcess) && now() < deadline) await sleep(100);
  for (const entry of entries) if (send(entry, 'SIGKILL')) log(`HUB_EMULATOR_SIGKILL ${entry.role} pid ${entry.pid} outlived SIGTERM by ${Math.round(graceMs / 1000)}s`);
  const settled = now() + 5000;
  while (entries.some(sameProcess) && now() < settled) await sleep(50);
  return { signalled, survivors: entries.filter(sameProcess).map(entry => entry.pid) };
}

// The exit-handler version: no waiting is possible there, so the recorded processes that are still themselves get SIGKILL.
export function stopProcessesNow(entries) {
  for (const entry of entries) if (sameProcess(entry)) { try { process.kill(entry.pid, 'SIGKILL'); } catch { /* gone */ } }
}

// ---- records ----

const recordsDir = env => join(lockDir(env), 'emulators');
const recordPath = (env, id) => join(recordsDir(env), `${id}.json`);
export const runtimeRoot = (env = process.env) => env.HUB_EMULATOR_DIR || join(dirname(lockDir(env)), 'emulators');

const readOwnerOf = (name, env) => readOwner(join(lockDir(env), `${name}.lock`));

function writeRecord(env, record) {
  mkdirSync(recordsDir(env), { recursive: true });
  const path = recordPath(env, record.lease_id);
  writeFileSync(`${path}.${process.pid}.tmp`, JSON.stringify(record, null, 2));
  renameSync(`${path}.${process.pid}.tmp`, path);
}

export function readRecord(env, id) {
  try {
    const record = JSON.parse(readFileSync(recordPath(env, id), 'utf8'));
    return record?.lease_id === id && Array.isArray(record.pids) ? record : null;
  } catch { return null; }
}

export function listRecords(env = process.env) {
  let files = [];
  try { files = readdirSync(recordsDir(env)).filter(file => /^[a-z0-9][a-z0-9-]*\.json$/.test(file)).sort(); } catch { return []; }
  return files.map(file => readRecord(env, file.slice(0, -'.json'.length))).filter(Boolean);
}

// What the lease record (the slot's owner.json) carries about its emulator: every pid with its start time.
const summary = record => ({
  profile: record.profile, image: record.image, serial: record.serial, console_port: record.console_port, adb_port: record.adb_port,
  adb_server_port: record.adb_server_port, avd: record.avd.name, pids: record.pids,
});

// Adds processes to the record (and to the lease record). False when the slot no longer holds this lease.
function recordPids(env, record, entries) {
  const known = new Set(record.pids.map(entry => entry.pid));
  const fresh = entries.filter(entry => !known.has(entry.pid));
  if (fresh.length > 0) {
    record.pids.push(...fresh);
    writeRecord(env, record);
  }
  return fresh.length === 0 || updateLease(record.slot, record.lease_id, { emulator: summary(record) }, { env });
}

// A record names only paths inside its own folders: its AVD home under <runtime>/<lease_id>, and a hub-emu-* temp folder.
function removeFiles(record) {
  const root = resolve(record.dir ?? '');
  const own = basename(root) === record.lease_id;
  const inside = path => typeof path === 'string' && resolve(path).startsWith(root + sep);
  if (own && /^hub-[a-z0-9-]+$/.test(record.avd?.name ?? '')) {
    if (inside(record.avd.ini)) rmSync(record.avd.ini, { force: true });
    if (inside(record.avd.dir)) rmSync(record.avd.dir, { recursive: true, force: true });
  }
  if (own) rmSync(root, { recursive: true, force: true });
  if (typeof record.tmp === 'string' && /^hub-emu-[A-Za-z0-9]+$/.test(basename(record.tmp))) rmSync(record.tmp, { recursive: true, force: true });
}

// Stops the record's processes (the emulator and its helpers first, its adb server last), deletes its AVD and folders, and
// drops the record. A survivor keeps the record, so its slot stays out of the pool and the next reap tries again.
export async function teardown(record, { env = process.env, log = () => {}, graceMs, sleep, now } = {}) {
  const marked = () => markedProcesses(record.marker).map(entry => ({ ...entry, role: 'helper' }));
  recordPids(env, record, marked());
  const first = await stopProcesses(record.pids.filter(entry => entry.role !== 'adb-server'), { graceMs, sleep, now, log });
  const last = await stopProcesses(record.pids.filter(entry => entry.role === 'adb-server'), { graceMs, sleep, now, log });
  // A helper started while the emulator shut down carries the marker too: record it and stop it the same way.
  const known = new Set(record.pids.map(entry => entry.pid));
  const late = marked().filter(entry => !known.has(entry.pid));
  recordPids(env, record, late);
  const stragglers = await stopProcesses(late, { graceMs, sleep, now, log });
  const signalled = [...first.signalled, ...last.signalled, ...stragglers.signalled];
  const survivors = [...new Set([...first.survivors, ...last.survivors, ...stragglers.survivors, ...marked().map(entry => entry.pid)])];
  if (survivors.length > 0) return { ok: false, signalled, survivors };
  removeFiles(record);
  rmSync(recordPath(env, record.lease_id), { force: true });
  return { ok: true, signalled, survivors };
}

// The exit handler's teardown: SIGKILL to the recorded processes, then the same file cleanup.
export function teardownNow(record, { env = process.env } = {}) {
  stopProcessesNow(record.pids);
  if (record.pids.some(sameProcess)) return false;
  removeFiles(record);
  rmSync(recordPath(env, record.lease_id), { force: true });
  return true;
}

// Why a record must go, or null while its lease stands: its slot no longer holds it, its lease expired, or the process the
// lease is tied to is gone (or is now another process).
export function doomed(record, owner, now = Date.now()) {
  if (record.host !== hostname()) return null;
  if (!isLease(owner) || owner.lease_id !== record.lease_id) return 'orphaned';
  if (!(Date.parse(owner.expires_at) > now)) return 'expired';
  if (Number.isSafeInteger(owner.holder_pid) && owner.host === hostname()) {
    const start = liveStart(owner.holder_pid);
    if (!start || (owner.holder_process_start && start !== owner.holder_process_start)) return 'holder gone';
  }
  return null;
}

const describePids = pids => (pids.length ? pids.join(',') : 'none');

// The lazy reaper every hub-device invocation runs first. Reapers take turns on the emulator-reaper lock; with wait false a
// reaper that finds the lock busy leaves the work to the one holding it.
export async function reap({ env = process.env, log = () => {}, graceMs, sleep, now = Date.now, wait = true } = {}) {
  const victims = () => listRecords(env).map(record => ({ record, why: doomed(record, readOwnerOf(record.slot, env), now()) })).filter(victim => victim.why);
  if (victims().length === 0) return [];
  try {
    return await withLock(REAPER, async () => {
      const results = [];
      for (const { record, why } of victims()) {
        const result = await teardown(record, { env, log, graceMs, sleep, now });
        if (result.ok) {
          releaseLease(record.slot, record.lease_id, { env });
          log(`HUB_EMULATOR_REAPED ${record.lease_id} ${record.slot} (${why}): stopped pids ${describePids(result.signalled)}, deleted AVD ${record.avd?.name}, freed ports ${record.console_port},${record.adb_port},${record.adb_server_port}`);
        } else {
          log(`HUB_EMULATOR_REAP_FAILED ${record.lease_id} ${record.slot} (${why}): pids ${describePids(result.survivors)} would not stop; ${record.slot} stays out of the pool`);
        }
        results.push({ lease_id: record.lease_id, why, ...result });
      }
      return results;
    }, { env, log: () => {}, timeoutMs: wait ? 120_000 : 0, pollMs: 200 });
  } catch (error) {
    if (!wait && /host lock emulator-reaper/.test(error.message)) return [];
    throw error;
  }
}

// The slot a lease id holds right now, if any.
function slotHolding(env, id) {
  let entries = [];
  try { entries = readdirSync(lockDir(env)).filter(entry => /^emulator-\d+\.lock$/.test(entry)); } catch { return null; }
  const found = entries.find(entry => readOwnerOf(entry.slice(0, -'.lock'.length), env)?.lease_id === id);
  return found ? found.slice(0, -'.lock'.length) : null;
}

// Whether an id is an emulator lease at all: a record, a slot, the gate or a ticket in its queue.
export function isEmulatorLease(env, id) {
  if (!id) return false;
  if (readRecord(env, id) || slotHolding(env, id) || readOwnerOf(GATE, env)?.lease_id === id) return true;
  try {
    const dir = join(lockDir(env), `${GATE}.queue`);
    return readdirSync(dir).some(file => { try { return JSON.parse(readFileSync(join(dir, file), 'utf8')).lease_id === id; } catch { return false; } });
  } catch { return false; }
}

export const LEASE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

// Teardowns take turns on the reaper lock; one that waited out the lock says what that means for this lease.
async function underReaper(id, fn, env) {
  try {
    return await withLock(REAPER, fn, { env, log: () => {}, timeoutMs: 120_000, pollMs: 200 });
  } catch (error) {
    if (!/^host lock emulator-reaper /.test(error.message)) throw error;
    throw new Error(`emulator ${id}: another teardown held the pool's emulator-reaper lock for 2 min; ${id} is released and the next hub-device run tears it down`);
  }
}

// Releases an emulator lease by id: a request still waiting is cancelled; a held one is torn down and its slot freed.
// Returns {outcome: released|cancelled|none|stuck, slot, record, result}. Only a lease id is accepted: lock.mjs reads an
// empty id as "whichever lease", which is never what releasing one emulator means.
export async function releaseEmulator(id, { env = process.env, log = () => {}, graceMs, sleep, now } = {}) {
  if (typeof id !== 'string' || !LEASE_ID.test(id)) throw failure('HUB_EMULATOR_USAGE', `release emulator needs a lease id (lowercase letters, digits and dashes), not "${id ?? ''}"`);
  const queued = releaseLease(GATE, id, { env });
  const record = readRecord(env, id);
  const slot = record?.slot ?? slotHolding(env, id);
  if (!record && !slot) return { outcome: queued.released || queued.cancelled ? 'cancelled' : 'none' };
  // The slot goes first, so a process still making this emulator sees its lease is gone before its processes stop. The
  // record keeps the slot out of the pool until the teardown below has finished.
  if (slot) releaseLease(slot, id, { env });
  let result = { ok: true, signalled: [], survivors: [] };
  if (record) result = await underReaper(id, () => teardown(record, { env, log, graceMs, sleep, now }), env);
  if (!result.ok) return { outcome: 'stuck', slot, record, result };
  return { outcome: 'released', slot, record, result };
}

// The pool as status shows it: each record with whether each of its processes is still alive.
export function emulatorStatus(env = process.env) {
  return listRecords(env).map(record => ({
    lease_id: record.lease_id, slot: record.slot, profile: record.profile, serial: record.serial, console_port: record.console_port,
    adb_server_port: record.adb_server_port, avd: record.avd?.name ?? null, created_at: record.created_at,
    pids: record.pids.map(entry => ({ ...entry, alive: sameProcess(entry) })),
  }));
}

// ---- provisioning ----

const oneLine = text => String(text ?? '').split('\n').map(line => line.trim()).filter(Boolean).slice(-4).join(' | ').slice(0, 600);
const tail = path => { try { return oneLine(readFileSync(path, 'utf8')); } catch { return ''; } };
// An emulator that cannot start its renderer, or panics, keeps running without ever booting: its log says so at once.
const fatal = path => {
  let text = '';
  try { text = readFileSync(path, 'utf8'); } catch { return null; }
  return oneLine(text.split('\n').filter(line => /^(?:PANIC|FATAL)\b|Could not start renderer/.test(line.trim())).join('\n')).replace(/[ \t]+/g, ' ') || null;
};
const cancelled = id => failure('HUB_LEASE_CANCELLED', `lease ${id} was released while its emulator was being made`);

// A short tool (avdmanager) with its output collected; killed on abort or timeout.
function runTool(command, args, { env, input = '', signal, timeout = 180_000 }) {
  return new Promise((done, fail) => {
    if (signal?.aborted) { fail(signal.reason); return; }
    const child = spawn(command, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    child.stdin.on('error', () => {});
    const stop = () => child.kill('SIGKILL');
    const timer = setTimeout(stop, timeout);
    signal?.addEventListener('abort', stop, { once: true });
    const settle = () => { clearTimeout(timer); signal?.removeEventListener('abort', stop); };
    child.on('error', error => { settle(); fail(new Error(`cannot run ${command}: ${error.message}`)); });
    child.on('close', code => { settle(); if (signal?.aborted) fail(signal.reason); else done({ code, output }); });
    child.stdin.end(input);
  });
}

// A long-lived process of the lease: its own session (a terminal's ^C never reaches it), output to a log file, and not
// waited for, so `lease` can return while it runs. Resolves with its pid once it has started.
async function launch(command, args, env, logFile) {
  const out = openSync(logFile, 'a');
  let child;
  try { child = spawn(command, args, { env, detached: true, stdio: ['ignore', out, out] }); } finally { closeSync(out); }
  await new Promise((done, fail) => {
    child.once('spawn', done);
    child.once('error', error => fail(new Error(`cannot start ${command}: ${error.message}`)));
  });
  child.on('error', () => {});
  child.unref();
  return child.pid;
}

// Whether the socket listening on this port is one of this process's own (so a server that answers is ours, not a
// stranger's that took the port first).
export function listenerOwnedBy(port, pid, procRoot = '/proc') {
  const inodes = new Set(tcpSockets(procRoot).filter(socket => socket.state === '0A' && socket.port === port).map(socket => socket.inode));
  if (inodes.size === 0) return false;
  let fds = [];
  try { fds = readdirSync(join(procRoot, String(pid), 'fd')); } catch { return false; }
  return fds.some(fd => {
    try { return inodes.has(/^socket:\[(\d+)\]$/.exec(readlinkSync(join(procRoot, String(pid), 'fd', fd)))?.[1]); } catch { return false; }
  });
}

function configure(path, values) {
  const entries = new Map();
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const at = line.indexOf('=');
    if (at > 0) entries.set(line.slice(0, at).trim(), line.slice(at + 1).trim());
  }
  for (const [key, value] of Object.entries(values)) entries.set(key, String(value));
  writeFileSync(path, `${[...entries].map(([key, value]) => `${key}=${value}`).join('\n')}\n`);
}

// Ports, folders and the record, made while the gate is held so two leases never pick the same ports.
function claim({ env, id, slot, image, profileName }) {
  if (readRecord(env, id)) throw failure('HUB_EMULATOR_USAGE', `lease id ${id} already names an emulator`);
  const found = inventory({ lockRoot: lockDir(env) });
  const records = listRecords(env);
  const ports = choosePorts({
    inUse: portsInUse(), claimed: records.flatMap(record => [record.console_port, record.adb_port, record.adb_server_port]),
    emulators: found.emulators, adbServers: found.adb_servers,
    consoleRange: range(env, 'HUB_EMULATOR_CONSOLE_PORTS', CONSOLE_PORTS, 5586), adbRange: range(env, 'HUB_EMULATOR_ADB_PORTS', ADB_SERVER_PORTS, 1024),
  });
  const dir = join(runtimeRoot(env), id);
  mkdirSync(join(dir, 'avd'), { recursive: true });
  const tmp = mkdtempSync(join(env.TMPDIR || tmpdir(), 'hub-emu-'));
  mkdirSync(join(tmp, 'run'), { mode: 0o700 });
  const name = `hub-${id}`;
  const record = {
    schema: 1, lease_id: id, marker: `${id}.${randomBytes(8).toString('hex')}`, slot, host: hostname(), profile: profileName, image: image.package, serial: `emulator-${ports.console}`,
    console_port: ports.console, adb_port: ports.adb, adb_server_port: ports.adbServer, dir, tmp,
    avd: { name, home: join(dir, 'avd'), ini: join(dir, 'avd', `${name}.ini`), dir: join(dir, 'avd', `${name}.avd`) },
    pids: [], created_at: new Date().toISOString(),
  };
  writeRecord(env, record);
  if (!updateLease(slot, id, { emulator: summary(record) }, { env })) {
    removeFiles(record);
    rmSync(recordPath(env, id), { force: true });
    throw cancelled(id);
  }
  return record;
}

// Takes a place in the pool and makes the emulator. Resolves with {lease, record} once sys.boot_completed=1, the lease
// tied to holderPid (null: until release or expiry). Throws HUB_LOCK_TIMEOUT when no slot frees within waitMs,
// HUB_LEASE_CANCELLED when released meanwhile, HUB_EMULATOR_NO_IMAGE before taking anything; anything it started is
// torn down on every failure.
export async function provision({
  id, holder, why, forMs, waitMs = 120_000, holderPid = null, profileName = 'default', pool = DEFAULT_POOL, env = process.env,
  log = () => {}, signal, sleep = realSleep, now = Date.now, pollMs = 1000, graceMs = 15_000, bootTimeoutMs = 360_000, bootPollMs = 2000,
} = {}) {
  if (process.platform !== 'linux') throw failure('HUB_EMULATOR_HOST', 'the emulator pool runs on Linux (big-chungus) only');
  const image = resolveImage(profileName, { env });
  const { profile } = image;
  const deadline = now() + waitMs;
  // hub-device's main() has just reaped; the gate loop below reaps again without waiting on another reaper.
  try {
    await acquireLease(GATE, { id, holder, why: `next for an emulator: ${why}`, forMs: Math.min(MAX_LEASE_MS, waitMs + 600_000), waitMs, holderPid: process.pid, env, log, pollMs, sleep, now, signal });
  } catch (error) {
    if (error.code !== 'HUB_LOCK_TIMEOUT') throw error;
    throw failure('HUB_LOCK_TIMEOUT', `the emulator pool is full, with other requests ahead of ${id} (${error.message})`);
  }
  let slot = null;
  let record = null;
  try {
    try {
      let waiting = false;
      for (;;) {
        signal?.throwIfAborted();
        if (readOwnerOf(GATE, env)?.lease_id !== id) throw failure('HUB_LEASE_CANCELLED', `lease ${id} was released while it waited for an emulator`);
        await reap({ env, log, graceMs, sleep, now, wait: false });
        const unreaped = new Set(listRecords(env).map(entry => entry.slot));
        for (let k = 1; k <= pool && !slot; k += 1) {
          if (unreaped.has(slotName(k))) continue;
          try {
            await acquireLease(slotName(k), { id, holder, why, forMs: Math.min(MAX_LEASE_MS, bootTimeoutMs + forMs + 120_000), waitMs: 0, holderPid: process.pid, env, log, pollMs, sleep, now, signal });
            slot = slotName(k);
          } catch (error) {
            if (error.code !== 'HUB_LOCK_TIMEOUT') throw error;
          }
        }
        if (slot) break;
        const held = Array.from({ length: pool }, (_, k) => readOwnerOf(slotName(k + 1), env)).map(owner => (isLease(owner) ? `${owner.lease_id} of ${owner.holder}` : 'being torn down')).join('; ');
        if (now() >= deadline) throw failure('HUB_LOCK_TIMEOUT', `the emulator pool is full (${pool} of ${pool}: ${held}); gave up after ${Math.round(waitMs / 1000)}s`);
        if (!waiting) { log(`HUB_EMULATOR_WAIT the pool is full (${held}); ${id} is next`); waiting = true; }
        await pause(pollMs, { signal, sleep });
      }
      record = claim({ env, id, slot, image, profileName });
    } finally {
      releaseLease(GATE, id, { env });
    }

    const base = {
      ...adbEnv(env), ANDROID_SDK_ROOT: image.sdk, ANDROID_HOME: image.sdk, ANDROID_AVD_HOME: record.avd.home,
      ANDROID_ADB_SERVER_PORT: String(record.adb_server_port), ADB_LOCAL_TRANSPORT_MAX_PORT: '5553', ADB_MDNS: '0', ADB_MDNS_AUTO_CONNECT: '0',
      ADB_USB: '0', HUB_MANAGED: '1', HUB_EMULATOR_LEASE: record.marker, RUNNER_TRACKING_ID: '',
    };
    for (const name of ['ANDROID_SERIAL', 'ADB_SERVER_SOCKET', 'ANDROID_ADB_SERVER_ADDRESS']) delete base[name];
    // Released, reaped, expired or holder gone: the lease is no longer ours to finish.
    const stillOurs = () => { if (doomed(record, readOwnerOf(slot, env), now()) || !readRecord(env, id)) throw cancelled(id); };
    // A process of ours that is gone may have been stopped by a release or a reap: then the lease was cancelled.
    const lost = (entry, message) => { if (!sameProcess(entry)) { stillOurs(); throw new Error(message()); } };

    // The AVD, in the lease's own AVD home.
    const java = javaHome(env, homeOf(env));
    const avdmanager = env.HUB_AVDMANAGER || join(image.sdk, 'cmdline-tools/latest/bin/avdmanager');
    const made = await runTool(avdmanager, ['create', 'avd', '-n', record.avd.name, '-k', image.package, '--force'], { env: java ? { ...base, JAVA_HOME: java } : base, input: 'no\n', signal });
    if (made.code !== 0 || !existsSync(record.avd.ini) || !existsSync(join(record.avd.dir, 'config.ini'))) throw new Error(`avdmanager could not create ${record.avd.name} from ${image.package}: ${oneLine(made.output)}`);
    configure(join(record.avd.dir, 'config.ini'), {
      'image.sysdir.1': image.sysdir, 'hw.lcd.width': profile.width, 'hw.lcd.height': profile.height, 'hw.lcd.density': profile.density,
      'hw.ramSize': profile.ram_mb, 'hw.cpu.ncore': profile.cores, 'disk.dataPartition.size': profile.data_partition, 'hw.keyboard': 'yes',
      'hw.gpu.enabled': 'yes', 'hw.gpu.mode': 'swangle_indirect', 'showDeviceFrame': 'no', 'fastboot.forceColdBoot': 'yes', 'fastboot.forceFastBoot': 'no',
    });
    log(`HUB_EMULATOR_AVD ${record.avd.name} from ${image.package} (${profile.width}x${profile.height}) in ${record.avd.home}`);

    // Its own adb server, on its own port, that never scans the shared emulator ports and never connects over mDNS.
    const adb = adbPath(env, homeOf(env));
    const serverPid = await launch(adb, ['-L', `tcp:localhost:${record.adb_server_port}`, 'server', 'nodaemon'], base, join(record.dir, 'adb-server.log'));
    const server = { pid: serverPid, start: liveStart(serverPid), role: 'adb-server', program: basename(adb) };
    if (!recordPids(env, record, [server])) throw cancelled(id);
    const wire = createAdbWire(record.adb_server_port, { signal });
    for (const serverDeadline = now() + 30_000; ;) {
      signal?.throwIfAborted();
      lost(server, () => `the adb server for port ${record.adb_server_port} exited: ${tail(join(record.dir, 'adb-server.log'))}`);
      if (listenerOwnedBy(record.adb_server_port, serverPid) && await wire.version().then(() => true, () => false)) break;
      if (now() >= serverDeadline) throw new Error(`the adb server for port ${record.adb_server_port} did not answer within 30s`);
      await pause(100, { signal, sleep });
    }

    // The emulator: headless, wiped, no snapshots, with its own temp and runtime folders.
    const emulatorBin = env.HUB_EMULATOR || join(image.sdk, 'emulator/emulator');
    const args = ['-avd', record.avd.name, '-port', String(record.console_port), '-no-window', '-no-audio', '-gpu', 'swangle_indirect', '-no-snapshot', '-wipe-data', '-no-boot-anim', '-no-metrics', '-memory', String(profile.ram_mb), '-cores', String(profile.cores)];
    // No display either: with the caller's DISPLAY or WAYLAND_DISPLAY (whose socket is not in the private XDG_RUNTIME_DIR) the
    // emulator tries a window renderer and never boots.
    const emulatorEnv = { ...base, TMPDIR: record.tmp, XDG_RUNTIME_DIR: join(record.tmp, 'run') };
    for (const name of ['DISPLAY', 'WAYLAND_DISPLAY', 'XAUTHORITY']) delete emulatorEnv[name];
    const emulatorPid = await launch(emulatorBin, args, emulatorEnv, join(record.dir, 'emulator.log'));
    const emulator = { pid: emulatorPid, start: liveStart(emulatorPid), role: 'emulator', program: basename(emulatorBin) };
    if (!recordPids(env, record, [emulator])) throw cancelled(id);
    log(`HUB_EMULATOR_START ${record.serial} pid ${emulatorPid}, adb server ${record.adb_server_port} pid ${serverPid}, ${slot}`);

    const helpers = () => markedProcesses(record.marker).map(entry => ({ ...entry, role: entry.pid === serverPid ? 'adb-server' : entry.pid === emulatorPid ? 'emulator' : 'helper' }));
    let registered = -Infinity;
    for (const bootDeadline = now() + bootTimeoutMs; ;) {
      signal?.throwIfAborted();
      stillOurs();
      if (!recordPids(env, record, helpers())) throw cancelled(id);
      lost(emulator, () => `the emulator exited while booting: ${tail(join(record.dir, 'emulator.log'))}`);
      if (fatal(join(record.dir, 'emulator.log'))) throw new Error(`the emulator failed while booting: ${fatal(join(record.dir, 'emulator.log'))}`);
      lost(server, () => `the adb server for port ${record.adb_server_port} exited while the emulator booted`);
      let booted = false;
      try {
        const listed = (await wire.devices()).find(device => device.id === record.serial);
        if (!listed && now() - registered >= 5000) { await wire.registerEmulator(record.adb_port); registered = now(); }
        if (listed?.state === 'device') booted = (await wire.shell(record.serial, 'getprop sys.boot_completed')).trim() === '1';
      } catch (error) {
        if (signal?.aborted) throw signal.reason;
      }
      if (booted) break;
      if (now() >= bootDeadline) throw new Error(`${record.serial} did not finish booting within ${Math.round(bootTimeoutMs / 1000)}s: ${tail(join(record.dir, 'emulator.log'))}`);
      await pause(bootPollMs, { signal, sleep });
    }
    if (!recordPids(env, record, helpers())) throw cancelled(id);
    const holderStart = Number.isSafeInteger(holderPid) ? liveStart(holderPid) : null;
    stillOurs();
    // The lease held the slot through the boot; its --for runs from now, when the emulator is ready.
    const fields = { emulator: summary(record), holder_pid: holderPid, holder_process_start: holderStart, expires_at: new Date(now() + forMs).toISOString() };
    if (!updateLease(slot, id, fields, { env })) throw cancelled(id);
    log(`HUB_EMULATOR_READY ${record.serial} adb server ${record.adb_server_port} pids ${record.pids.map(entry => `${entry.role}:${entry.pid}`).join(',')}`);
    return { lease: readOwnerOf(slot, env), record };
  } catch (error) {
    if (record) {
      await underReaper(id, () => teardown(readRecord(env, id) ?? record, { env, log, graceMs, sleep, now }), env).catch(error => log(`hub-device: ${error.message}`));
    }
    if (slot) releaseLease(slot, id, { env });
    throw error;
  }
}

export function exportsOf(record, envSerial = []) {
  const vars = { HUB_LEASE_ID: record.lease_id, ANDROID_ADB_SERVER_PORT: String(record.adb_server_port), ANDROID_SERIAL: record.serial };
  for (const name of envSerial) vars[name] = record.serial;
  return vars;
}
