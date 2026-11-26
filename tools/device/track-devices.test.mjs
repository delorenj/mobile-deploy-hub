// Story 8.3 (AD-35): `trackDevices`, the streaming `host:track-devices-l` transport of adb-wire.mjs. Hermetic: a fake socket through the
// `connect` seam for every framing rule, and one real loopback socket (`fakeAdbServer`) for the proof that this is the only request sent.
// No adb server on 5037 is touched.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { hermetic } from '../ci/test-fixtures.mjs';
import { createAdbWire, trackDevices } from './adb-wire.mjs';
import { fakeAdbServer } from './wire-fixtures.mjs';

hermetic();

const hex4 = number => number.toString(16).padStart(4, '0');
const payload = text => Buffer.from(`${hex4(Buffer.byteLength(text))}${text}`);
const LIST_A = 'R5CX1234567 device usb:1-1 product:e3qxeea model:SM_S948U device:e3q transport_id:1\n';
const LIST_B = 'R5CX1234567 unauthorized usb:1-1 transport_id:1\n10.0.0.5:5555 device product:p model:SM_S928U device:d transport_id:2\n';
const settle = (ms = 0) => new Promise(done => setTimeout(done, ms));

// A socket the test drives: it records every write and is `destroy`ed like a real one.
function rig(options = {}) {
  const socket = Object.assign(new EventEmitter(), {
    writes: [], destroyed: false, unrefs: 0,
    write(chunk) { this.writes.push(String(chunk)); return true; },
    destroy() { this.destroyed = true; this.emit('close'); },
    unref() { this.unrefs += 1; return this; },
  });
  const dials = [];
  const lists = [];
  const closes = [];
  const handle = trackDevices(5037, {
    connect: target => { dials.push(target); return socket; },
    onDevices: list => lists.push(list),
    onClose: info => closes.push(info),
    ...options,
  });
  return { socket, dials, lists, closes, handle };
}

test('one request frame goes to 127.0.0.1:<port>; payloads split across chunks, or several in one chunk, are each parsed', () => {
  const r = rig();
  assert.deepEqual(r.dials, [{ host: '127.0.0.1', port: 5037 }]);
  assert.deepEqual(r.socket.writes, ['0014host:track-devices-l']);
  assert.equal(r.socket.unrefs, 1, 'the socket never holds a process open');
  const a = payload(LIST_A);
  const b = payload(LIST_B);
  r.socket.emit('data', Buffer.concat([Buffer.from('OKAY'), a.subarray(0, 5)]));
  assert.deepEqual(r.lists, [], 'half a payload is not a listing');
  r.socket.emit('data', Buffer.concat([a.subarray(5), b.subarray(0, 9)]));
  assert.equal(r.lists.length, 1);
  r.socket.emit('data', b.subarray(9));
  assert.equal(r.lists.length, 2);
  assert.deepEqual(r.lists[0].map(entry => [entry.id, entry.state, entry.model]), [['R5CX1234567', 'device', 'SM_S948U']]);
  assert.deepEqual(r.lists[1].map(entry => [entry.id, entry.state]), [['R5CX1234567', 'unauthorized'], ['10.0.0.5:5555', 'device']]);
  r.socket.emit('data', Buffer.concat([a, payload(''), b]));
  assert.deepEqual(r.lists.slice(2).map(list => list.length), [1, 0, 2], 'several payloads in one chunk, and an empty listing, are each delivered');
  assert.deepEqual(r.socket.writes, ['0014host:track-devices-l'], 'still exactly one write');
  assert.deepEqual(r.closes, []);
});

test('OKAY itself may arrive in pieces, and the close after it says it had opened', () => {
  const r = rig();
  r.socket.emit('data', Buffer.from('OK'));
  r.socket.emit('data', Buffer.from('AY'));
  r.socket.emit('data', payload(LIST_A));
  assert.equal(r.lists.length, 1);
  r.socket.emit('close');
  r.socket.emit('close');
  assert.deepEqual(r.closes, [{ opened: true, error: null }], 'onClose is called exactly once');
});

test('FAIL closes the socket: opened false, ADB_FAIL, once', () => {
  const r = rig();
  const message = 'unknown host service';
  r.socket.emit('data', Buffer.from(`FAIL${hex4(message.length)}${message}`));
  assert.equal(r.closes.length, 1);
  assert.equal(r.closes[0].opened, false);
  assert.equal(r.closes[0].error.code, 'ADB_FAIL');
  assert.match(r.closes[0].error.message, /unknown host service/);
  assert.equal(r.socket.destroyed, true);
  assert.deepEqual(r.lists, []);
});

test('a malformed answer, or a malformed frame after OKAY, closes the socket', () => {
  const before = rig();
  before.socket.emit('data', Buffer.from('WHAT'));
  assert.deepEqual(before.closes.map(info => info.opened), [false]);
  assert.match(before.closes[0].error.message, /unexpected answer/);
  const after = rig();
  after.socket.emit('data', Buffer.concat([Buffer.from('OKAY'), payload(LIST_A), Buffer.from('zzzz')]));
  assert.equal(after.lists.length, 1, 'the good frame before it was delivered');
  assert.deepEqual(after.closes.map(info => info.opened), [true]);
  assert.match(after.closes[0].error.message, /malformed frame/);
});

test('a malformed FAIL length is a malformed FAIL, not a length', () => {
  const r = rig();
  r.socket.emit('data', Buffer.from('FAIL12zzunknown host service'));
  assert.equal(r.closes.length, 1);
  assert.equal(r.closes[0].opened, false);
  assert.match(r.closes[0].error.message, /malformed FAIL/);
});

test('a socket that closes before OKAY is an error, not a clean close', () => {
  const r = rig();
  r.socket.emit('close');
  assert.equal(r.closes.length, 1);
  assert.equal(r.closes[0].opened, false);
  assert.match(r.closes[0].error.message, /closed the connection before answering host:track-devices-l/);
});

test('a refused connection is opened false, once', () => {
  const r = rig();
  r.socket.emit('error', Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5037'), { code: 'ECONNREFUSED' }));
  r.socket.emit('close');
  assert.equal(r.closes.length, 1);
  assert.equal(r.closes[0].opened, false);
  assert.equal(r.closes[0].error.code, 'ECONNREFUSED');
});

test('a server that never answers is closed after handshakeMs: opened false, once', async () => {
  const r = rig({ handshakeMs: 20 });
  await settle(60);
  assert.equal(r.closes.length, 1);
  assert.equal(r.closes[0].opened, false);
  assert.match(r.closes[0].error.message, /did not answer host:track-devices-l/);
  assert.equal(r.socket.destroyed, true);
});

test('an answer inside handshakeMs stops the bound; close() ends the socket and calls onClose once', async () => {
  const r = rig({ handshakeMs: 20 });
  r.socket.emit('data', Buffer.from('OKAY'));
  await settle(60);
  assert.deepEqual(r.closes, [], 'OKAY cleared the bound');
  r.handle.close();
  r.handle.close();
  assert.deepEqual(r.closes, [{ opened: true, error: null }]);
  assert.equal(r.socket.destroyed, true);
  r.socket.emit('data', payload(LIST_A));
  assert.deepEqual(r.lists, [], 'nothing is delivered after close()');
});

test('a handler that throws never ends the stream or escapes the socket', () => {
  const lists = [];
  const closes = [];
  const r = rig({ onDevices: list => { lists.push(list); throw new Error('boom'); }, onClose: info => { closes.push(info); throw new Error('boom'); } });
  r.socket.emit('data', Buffer.concat([Buffer.from('OKAY'), payload(LIST_A), payload(LIST_B)]));
  assert.equal(lists.length, 2);
  r.socket.emit('close');
  assert.equal(closes.length, 1);
});

test('a connect that throws is one onClose, opened false', () => {
  const closes = [];
  const handle = trackDevices(5037, { connect: () => { throw new Error('no socket'); }, onClose: info => closes.push(info) });
  assert.deepEqual(closes.map(info => [info.opened, info.error.message]), [[false, 'no socket']]);
  handle.close();
  assert.equal(closes.length, 1);
});

test('against a real loopback socket: the only request sent is host:track-devices-l, pushes arrive, and a dropped socket closes it', async () => {
  const server = await fakeAdbServer({ listed: [{ id: 'R5CX1234567', state: 'device', model: 'SM_S948U' }] });
  const lists = [];
  const closes = [];
  const wire = createAdbWire(server.port);
  const handle = wire.trackDevices({ onDevices: list => lists.push(list), onClose: info => closes.push(info) });
  const until = async condition => { for (let i = 0; i < 200 && !condition(); i += 1) await settle(10); assert.ok(condition(), 'timed out'); };
  try {
    await until(() => lists.length === 1);
    assert.deepEqual(lists[0].map(entry => [entry.id, entry.state, entry.model]), [['R5CX1234567', 'device', 'SM_S948U']]);
    server.push([{ id: 'R5CX1234567', state: 'unauthorized' }]);
    await until(() => lists.length === 2);
    assert.equal(lists[1][0].state, 'unauthorized');
    server.push([]);
    await until(() => lists.length === 3);
    assert.deepEqual(lists[2], []);
    assert.deepEqual(server.requests, ['host:track-devices-l']);
    server.dropTracks();
    await until(() => closes.length === 1);
    assert.equal(closes[0].opened, true);
    handle.close();
    assert.equal(closes.length, 1);
  } finally {
    handle.close();
    await server.close();
  }
});

test('refused by a real port nobody listens on: opened false, and no server is started', async () => {
  const server = await fakeAdbServer();
  const port = server.port;
  await server.close();
  const closes = [];
  trackDevices(port, { onClose: info => closes.push(info) });
  for (let i = 0; i < 200 && closes.length === 0; i += 1) await settle(10);
  assert.equal(closes.length, 1);
  assert.equal(closes[0].opened, false);
});

test('adb-wire.mjs imports no node:child_process: a socket starts nothing', () => {
  const source = readFileSync(new URL('./adb-wire.mjs', import.meta.url), 'utf8');
  assert.ok(!/child_process/.test(source));
});
