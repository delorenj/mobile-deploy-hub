// Test doubles for the adb wire (adb-wire.mjs), shared by the hub-device and status tests. `fakeWire` is the injected `adbWire`
// seam: it records every request the wire would send and answers from a listing. `fakeAdbServer` is a real TCP server that speaks
// the same protocol (4-hex-digit length, then the request; OKAY or FAIL back) for the tests that run `hub-device` as a child
// process. Neither starts, connects or reaches a real adb server (5037), and neither is part of the deploy path.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:net';

const hex4 = number => number.toString(16).padStart(4, '0');

// One line of `host:devices-l` for a listed device: {id, state, model}.
export const longLine = (entry, index) => `${entry.id.padEnd(24)} ${entry.state} ${entry.state === 'device' ? `usb:1-${index + 1} product:fake model:${entry.model ?? 'Fake'} device:fake ` : ''}transport_id:${index + 1}`;

const read = value => (typeof value === 'function' ? value() : value);

// The `adbWire(port, {signal})` seam. `listed` is an array of {id, state, model} (or a function giving one), `serials` maps an id to its
// ro.serialno, `hangShell` lists ids whose serial read never answers (until aborted), `fail` makes `version` ('version') or `devicesLong` ('devices') reject, `hang` makes `version` never answer (until aborted).
export function fakeWire({ listed = [], serials = {}, fail = null, hang = false, hangShell = [] } = {}) {
  const requests = [];
  const opened = [];
  const factory = (port, { signal } = {}) => {
    opened.push({ port, signal });
    return {
      port,
      version: () => {
        requests.push('host:version');
        if (hang) return new Promise((_, reject) => signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
        return fail === 'version' ? Promise.reject(new Error('adb server refused')) : Promise.resolve('0041');
      },
      devicesLong: async () => {
        requests.push('host:devices-l');
        if (fail === 'devices') throw new Error('adb server hung up');
        return read(listed).map((entry, index) => ({ id: entry.id, state: entry.state, model: entry.model ?? null, product: null, device: null, transport_id: String(index + 1) }));
      },
      shell: async (id, command) => {
        requests.push(`host:transport:${id}`, `shell:${command}`);
        if (hangShell.includes(id)) return new Promise((_, reject) => signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
        const serial = read(serials)[id];
        if (serial === undefined) throw new Error(`adb host:transport:${id}: device unreachable`);
        return `${serial}\n`;
      },
    };
  };
  return Object.assign(factory, { requests, opened });
}

// A real adb-protocol server on a free loopback port. `requests` lists every request frame received, in order.
export async function fakeAdbServer({ listed = [], serials = {} } = {}) {
  const requests = [];
  const sockets = new Set();
  const server = createServer(socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    let buffer = Buffer.alloc(0);
    let transport = null;
    const fail = message => socket.end(`FAIL${hex4(Buffer.byteLength(message))}${message}`);
    const answer = request => {
      if (request === 'host:version') { socket.end(`OKAY${hex4(4)}0041`); return; }
      if (request === 'host:devices-l') {
        const text = `${read(listed).map(longLine).join('\n')}\n`;
        socket.end(`OKAY${hex4(Buffer.byteLength(text))}${text}`);
        return;
      }
      if (request.startsWith('host:transport:')) { transport = request.slice('host:transport:'.length); socket.write('OKAY'); return; }
      if (request === 'shell:getprop ro.serialno' && transport !== null) { socket.end(`OKAY${read(serials)[transport] ?? ''}\r\n`); return; }
      fail(`unsupported request ${request}`);
    };
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4) {
        const length = Number.parseInt(buffer.subarray(0, 4).toString('latin1'), 16);
        if (buffer.length < 4 + length) return;
        const request = buffer.subarray(4, 4 + length).toString('utf8');
        buffer = buffer.subarray(4 + length);
        requests.push(request);
        answer(request);
      }
    });
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  return {
    port: server.address().port,
    requests,
    close: () => new Promise(done => { for (const socket of sockets) socket.destroy(); server.close(() => done()); }),
  };
}

// What a child-process `hub-device status` needs to see an adb server on the hub port: the TCP fake above, and a decoy process
// posing as `adb ... server` with ANDROID_ADB_SERVER_PORT set to it (the inventory reads /proc). `stop()` ends both.
export async function fakeHub(options) {
  const server = await fakeAdbServer(options);
  const decoy = spawn('/bin/sh', ['-c', 'while :; do sleep 5; done', 'server'], { argv0: 'adb', env: { ...process.env, ANDROID_ADB_SERVER_PORT: String(server.port) }, stdio: 'ignore' });
  for (let i = 0; i < 200; i += 1) {
    let cmdline = '';
    try { cmdline = readFileSync(`/proc/${decoy.pid}/cmdline`, 'utf8'); } catch { /* not yet */ }
    if (/^adb\0.*server\0/.test(cmdline)) break;
    await new Promise(done => setTimeout(done, 10));
  }
  return { server, decoy, stop: async () => { decoy.kill('SIGKILL'); await server.close(); } };
}
