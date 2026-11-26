// The few adb host requests the emulator broker needs, spoken straight to its private adb server over the socket. The adb
// client binary starts a server of its own on that port whenever none answers, and that server would be a process the
// lease never recorded; a socket never starts anything. Each request is a 4-hex-digit length and the request; the server
// answers OKAY or FAIL (FAIL carries a length-prefixed message).
import { connect } from 'node:net';
import { aborted } from './async-adb.mjs';

const frame = text => `${Buffer.byteLength(text).toString(16).padStart(4, '0')}${text}`;

// Opens a socket to the server, writes the requests in order (each must be answered OKAY), and resolves with whatever the
// server sends after the last OKAY until it closes. `noReply` sends one request that the server answers with nothing.
function exchange(port, requests, { signal, timeout = 10_000, noReply = false } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(aborted(signal)); return; }
    const socket = connect({ host: '127.0.0.1', port });
    let buffer = Buffer.alloc(0);
    let step = 0;
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      socket.destroy();
      if (error) reject(error); else resolve(value);
    };
    const onAbort = () => finish(aborted(signal));
    const timer = setTimeout(() => finish(new Error(`adb server on ${port} did not answer ${requests.at(-1)} within ${Math.round(timeout / 1000)}s`)), timeout);
    signal?.addEventListener('abort', onAbort, { once: true });
    socket.on('error', error => finish(error));
    socket.on('connect', () => {
      if (noReply) { socket.end(frame(requests[0]), () => finish(null, '')); return; }
      socket.write(frame(requests[0]));
    });
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      while (step < requests.length && buffer.length >= 4) {
        const status = buffer.subarray(0, 4).toString('latin1');
        if (status === 'FAIL') {
          if (buffer.length < 8) return;
          const length = Number.parseInt(buffer.subarray(4, 8).toString('latin1'), 16);
          if (buffer.length < 8 + length) return;
          finish(Object.assign(new Error(`adb ${requests[step]}: ${buffer.subarray(8, 8 + length).toString('utf8')}`), { code: 'ADB_FAIL' }));
          return;
        }
        if (status !== 'OKAY') { finish(new Error(`adb ${requests[step]}: unexpected answer ${JSON.stringify(status)}`)); return; }
        buffer = buffer.subarray(4);
        step += 1;
        if (step < requests.length) socket.write(frame(requests[step]));
      }
    });
    socket.on('close', () => {
      if (step === requests.length) finish(null, buffer.toString('utf8'));
      else finish(new Error(`adb server on ${port} closed the connection during ${requests[step]}`));
    });
  });
}

// A length-prefixed payload (host:version, host:devices).
const payload = text => {
  const length = Number.parseInt(text.slice(0, 4), 16);
  if (!Number.isFinite(length)) throw new Error(`adb: malformed reply ${JSON.stringify(text.slice(0, 16))}`);
  return text.slice(4, 4 + length);
};

// `host:devices-l`: one line per device, `<id> <state> [usb:..] [product:..] [model:..] [device:..] [transport_id:..]`. A key that is
// absent (an unauthorized phone shows no model) is null. The id is the first word and the state the second, so the long state
// `no permissions (...)` reads as `no` and is never taken for `device`.
export function parseDevicesLong(text) {
  return String(text ?? '').split('\n').map(line => line.trim()).filter(Boolean).map(line => {
    const [id, state, ...rest] = line.split(/\s+/);
    const keys = new Map(rest.filter(word => word.includes(':')).map(word => [word.slice(0, word.indexOf(':')), word.slice(word.indexOf(':') + 1)]));
    return { id, state: state ?? '', model: keys.get('model') ?? null, product: keys.get('product') ?? null, device: keys.get('device') ?? null, transport_id: keys.get('transport_id') ?? null };
  });
}

// `host:track-devices-l`: the one long-lived request. The server answers OKAY, then sends one length-prefixed `devices-l` listing now
// and another every time a device appears, changes state or goes (Story 8.3, AD-35). The socket is never a poll: it is `unref()`ed so it
// never holds a process open, it never reconnects (its owner decides when to open another) and it starts nothing, because a socket to
// a port nobody listens on is refused.
//
// `onDevices(list)` gets each pushed listing parsed (`parseDevicesLong`), whether a payload arrives whole, split across chunks, or
// several to a chunk. `onClose({opened, error})` is called exactly once: `opened` is true once OKAY arrived, `error` is why the socket
// ended when it was not a clean close (FAIL carries `code: 'ADB_FAIL'`; a malformed frame, a refused connection and a server that does
// not answer within `handshakeMs` are errors too). Returns `{close()}`, which ends the socket and still calls `onClose` once.
// `connect` is the socket seam, and `handshakeMs` the bound on the OKAY.
export function trackDevices(port, { onDevices = () => {}, onClose = () => {}, connect: dial = connect, handshakeMs = 5000 } = {}) {
  const request = 'host:track-devices-l';
  let socket = null;
  let buffer = Buffer.alloc(0);
  let opened = false;
  let closed = false;
  let timer = null;
  const finish = error => {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    try { socket?.destroy(); } catch { /* already gone */ }
    try { onClose({ opened, error: error ?? null }); } catch { /* a handler that throws never reaches the socket's owner */ }
  };
  const drain = () => {
    while (!closed) {
      if (!opened) {
        if (buffer.length < 4) return;
        const status = buffer.subarray(0, 4).toString('latin1');
        if (status === 'FAIL') {
          if (buffer.length < 8) return;
          const head = buffer.subarray(4, 8).toString('latin1');
          if (!/^[0-9a-fA-F]{4}$/.test(head)) { finish(new Error(`adb ${request}: malformed FAIL`)); return; }
          const length = Number.parseInt(head, 16);
          if (buffer.length < 8 + length) return;
          finish(Object.assign(new Error(`adb ${request}: ${buffer.subarray(8, 8 + length).toString('utf8')}`), { code: 'ADB_FAIL' }));
          return;
        }
        if (status !== 'OKAY') { finish(new Error(`adb ${request}: unexpected answer ${JSON.stringify(status)}`)); return; }
        buffer = buffer.subarray(4);
        opened = true;
        clearTimeout(timer);
        continue;
      }
      if (buffer.length < 4) return;
      const head = buffer.subarray(0, 4).toString('latin1');
      const length = /^[0-9a-fA-F]{4}$/.test(head) ? Number.parseInt(head, 16) : NaN;
      if (!Number.isFinite(length)) { finish(new Error(`adb ${request}: malformed frame ${JSON.stringify(head)}`)); return; }
      if (buffer.length < 4 + length) return;
      const text = buffer.subarray(4, 4 + length).toString('utf8');
      buffer = buffer.subarray(4 + length);
      try { onDevices(parseDevicesLong(text)); } catch { /* a handler that throws never ends the stream */ }
    }
  };
  try {
    socket = dial({ host: '127.0.0.1', port });
    socket.unref?.();
    timer = setTimeout(() => finish(new Error(`adb server on ${port} did not answer ${request} within ${handshakeMs} ms`)), handshakeMs);
    timer.unref?.();
    socket.on('error', error => finish(error));
    socket.on('close', () => finish(opened ? null : new Error(`adb server on ${port} closed the connection before answering ${request}`)));
    socket.on('data', chunk => { buffer = Buffer.concat([buffer, chunk]); drain(); });
    socket.write(frame(request));
  } catch (error) {
    finish(error);
  }
  return { close: () => finish(null) };
}

export function createAdbWire(port, { signal } = {}) {
  return {
    port,
    // The server's protocol version (a hex string); throws when nothing adb-like listens on the port.
    version: async () => payload(await exchange(port, ['host:version'], { signal, timeout: 5000 })),
    // [{id, state}] for every device this server knows.
    devices: async () => payload(await exchange(port, ['host:devices'], { signal })).split('\n').map(line => line.trim()).filter(Boolean)
      .map(line => { const [id, state] = line.split(/\s+/); return { id, state }; }),
    // [{id, state, model, product, device, transport_id}] with the model details (what status reads); a read-only query, 5s.
    devicesLong: async () => parseDevicesLong(payload(await exchange(port, ['host:devices-l'], { signal, timeout: 5000 }))),
    // Tells the server an emulator listens on adbPort (what the emulator itself does at start); the server sends no reply.
    registerEmulator: adbPort => exchange(port, [`host:emulator:${adbPort}`], { signal, noReply: true, timeout: 5000 }),
    // Streams the track-devices listings to the handlers; see `trackDevices` (a plain socket: it never starts a server).
    trackDevices: handlers => trackDevices(port, handlers),
    // Runs a shell command on one device and returns its output.
    shell: async (serial, command) => (await exchange(port, [`host:transport:${serial}`, `shell:${command}`], { signal, timeout: 15_000 })).replace(/\r/g, ''),
  };
}
