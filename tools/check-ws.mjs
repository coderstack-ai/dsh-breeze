// dsh-breeze — verify a Breeze WebSocket endpoint through whatever proxy sits in
// front of it (nginx, Caddy, frp…), without generating any audio.
//
// Breeze runs its WebSocket listener on a SECOND port with no path handling, so a
// reverse proxy has to rewrite some public path onto `/`. This script proves that
// rewrite end to end: TCP + TLS + HTTP Upgrade + 101 + the `ready` frame the
// server sends before any text is submitted. No model work, no GPU, no cost.
//
// Usage:
//   node tools/check-ws.mjs                                  # wss://breeze.0444.top/ws
//   node tools/check-ws.mjs wss://host/ws                    # explicit endpoint
//   BREEZE_TOKEN=... node tools/check-ws.mjs wss://host/ws   # send a bearer header
//   node tools/check-ws.mjs ws://127.0.0.1:9005              # straight at the listener
//
// Exit code 0 only when the handshake verifies AND a `ready` frame parses.

import crypto from 'node:crypto';
import http from 'node:http';
import https from 'node:https';

const target = process.argv[2] || 'wss://breeze.0444.top/ws';
const token = process.env.BREEZE_TOKEN || process.env.DSH_BREEZE_TOKEN || '';
const TIMEOUT_MS = Number(process.env.WS_TIMEOUT_MS || 10000);

const url = new URL(target);
const secure = url.protocol === 'wss:' || url.protocol === 'https:';
if (!/^(wss?|https?):$/.test(url.protocol)) {
  console.error(`unsupported protocol ${url.protocol}; use ws:// or wss://`);
  process.exit(2);
}

const key = crypto.randomBytes(16).toString('base64');
const expectedAccept = crypto.createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');

const headers = {
  Connection: 'Upgrade',
  Upgrade: 'websocket',
  'Sec-WebSocket-Key': key,
  'Sec-WebSocket-Version': '13',
  Host: url.host,
};
if (token) headers.Authorization = `Bearer ${token}`;

console.log(`target   ${target}`);
console.log(`protocol ${secure ? 'wss (TLS)' : 'ws (clear)'}  host ${url.hostname}:${url.port || (secure ? 443 : 80)}  path ${url.pathname}`);
console.log(`auth     ${token ? 'Bearer sent' : 'none'}`);

const transport = secure ? https : http;
const request = transport.request({
  method: 'GET',
  hostname: url.hostname,
  port: url.port || (secure ? 443 : 80),
  path: `${url.pathname}${url.search}`,
  headers,
  servername: url.hostname,
});

let settled = false;
const fail = (message) => {
  if (settled) return;
  settled = true;
  console.error(`FAIL  ${message}`);
  process.exit(1);
};

const timer = setTimeout(() => fail(`no response within ${TIMEOUT_MS} ms`), TIMEOUT_MS);

request.on('response', (response) => {
  // A normal HTTP answer instead of 101 means the upgrade never reached Breeze:
  // wrong location, wrong port, or the proxy stripped the Upgrade headers.
  const status = response.statusCode || 0;
  const hint = status === 401 ? ' (proxy rejected the request: check the access variable / token)'
    : status === 404 ? ' (no such location in the proxy, or the path was not rewritten to /)'
      : status === 200 ? ' (answered as plain HTTP: the Upgrade headers did not survive, or / was routed to the HTTP port instead of the WS port)'
        : '';
  fail(`server answered HTTP ${status} instead of 101${hint}`);
});

request.on('upgrade', (response, socket) => {
  const status = response.statusCode || 0;
  if (status !== 101) return fail(`upgrade answered ${status}`);

  const accept = response.headers['sec-websocket-accept'];
  if (accept !== expectedAccept) {
    return fail(`bad Sec-WebSocket-Accept (${accept || 'missing'}); something other than Breeze completed the handshake`);
  }
  console.log('PASS  handshake 101 + Sec-WebSocket-Accept verified');

  const chunks = [];
  let buffer = Buffer.alloc(0);

  const onData = (data) => {
    buffer = Buffer.concat([buffer, data]);
    while (buffer.length >= 2) {
      const first = buffer[0];
      const opcode = first & 0x0f;
      const masked = (buffer[1] & 0x80) !== 0;
      let length = buffer[1] & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (buffer.length < 4) return;
        length = buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (buffer.length < 10) return;
        length = Number(buffer.readBigUInt64BE(2));
        offset = 10;
      }
      if (masked) offset += 4; // server frames are not masked, but be explicit
      if (buffer.length < offset + length) return;
      const payload = buffer.subarray(offset, offset + length);
      buffer = buffer.subarray(offset + length);
      chunks.push({ opcode, payload });
    }

    for (const frame of chunks.splice(0)) {
      if (frame.opcode === 0x1) {
        let message = null;
        try {
          message = JSON.parse(frame.payload.toString('utf8'));
        } catch {
          return fail(`first text frame is not JSON: ${frame.payload.toString('utf8').slice(0, 120)}`);
        }
        if (message.type !== 'ready') {
          return fail(`first text frame is "${message.type}", expected "ready"`);
        }
        console.log(`PASS  ready frame  sample_rate=${message.sample_rate} format=${message.format}`);
        console.log(`\nOK — ${target} reaches a live Breeze WebSocket listener.`);
        console.log(`Connect from a client with:  ${target}`);
        clearTimeout(timer);
        settled = true;
        socket.destroy();
        process.exit(0);
      }
      if (frame.opcode === 0x8) return fail('server closed the socket before sending `ready`');
      if (frame.opcode === 0x9) return; // ping: ignoring is fine for a probe
    }
  };

  socket.on('data', onData);
  socket.on('error', (error) => fail(`socket error after upgrade: ${error.message}`));
  socket.on('close', () => fail('socket closed before a `ready` frame arrived'));
});

request.on('error', (error) => {
  const code = error && error.code ? error.code : '';
  const hint = code === 'ECONNREFUSED' ? ' (nothing listening on that host/port)'
    : code === 'ENOTFOUND' ? ' (DNS does not resolve)'
      : code === 'ECONNRESET' ? ' (connection reset: likely the proxy closed it)'
        : '';
  fail(`${code || 'request failed'}: ${error.message}${hint}`);
});

request.end();
