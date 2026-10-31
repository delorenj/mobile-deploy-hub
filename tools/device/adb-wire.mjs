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

export function createAdbWire(port, { signal } = {}) {
  return {
    port,
    // The server's protocol version (a hex string); throws when nothing adb-like listens on the port.
    version: async () => payload(await exchange(port, ['host:version'], { signal, timeout: 5000 })),
    // [{id, state}] for every device this server knows.
    devices: async () => payload(await exchange(port, ['host:devices'], { signal })).split('\n').map(line => line.trim()).filter(Boolean)
      .map(line => { const [id, state] = line.split(/\s+/); return { id, state }; }),
    // Tells the server an emulator listens on adbPort (what the emulator itself does at start); the server sends no reply.
    registerEmulator: adbPort => exchange(port, [`host:emulator:${adbPort}`], { signal, noReply: true, timeout: 5000 }),
    // Runs a shell command on one device and returns its output.
    shell: async (serial, command) => (await exchange(port, [`host:transport:${serial}`, `shell:${command}`], { signal, timeout: 15_000 })).replace(/\r/g, ''),
  };
}
