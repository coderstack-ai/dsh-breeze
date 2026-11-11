// dsh-breeze — WebSocket client + endpoint-resolution test.
//
// The socket client is ~300 lines of hand-written RFC 6455, so "it parses" is not
// a verdict. This spins up two local listeners that behave like the real thing:
//
//   listener A  accepts only "/"        ← the upstream Breeze listener (root path)
//   listener B  accepts only "/ws"      ← what a reverse proxy rewrite exposes
//   listener B  also answers /health    ← so ws_port discovery can be exercised
//
// and then asserts, in order:
//   1. candidate derivation puts the original shape first
//   2. an explicit wsUrl overrides everything
//   3. a dead ws_port falls back to the proxy path (the case behind a nginx like
//      breeze.0444.top, where 8081 is not exposed at all)
//   4. the full speech flow: handshake → ready → start/text/end → speaking +
//      binary audio + done → a valid WAV
//   5. a wrong path reports a message that names the actual cause
//
// Zero network access, zero model calls. Usage: node tools/ws-selftest.mjs

import crypto from 'node:crypto';
import http from 'node:http';

import { FrameReader, encodeFrame, forgetWsEndpoint, openSocket, resolveWsEndpoint, waitForReady, wsCandidates } from '../lib/ws.mjs';
import { speakWs } from '../lib/speech-ws.mjs';
import { wavInfo } from '../lib/wav.mjs';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

let failures = 0;
let checks = 0;
const ok = (label, detail = '') => { checks += 1; console.log(`  PASS  ${label}${detail ? ` — ${detail}` : ''}`); };
const bad = (label, detail = '') => { checks += 1; failures += 1; console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`); };
const expect = (condition, label, detail = '') => (condition ? ok(label, detail) : bad(label, detail));

// ---------------------------------------------------------------- a fake Breeze listener

/** Server frames are never masked (RFC 6455 §5.1). */
function serverFrame(opcode, payload) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload ?? ''), 'utf8');
  let header;
  if (body.length < 126) {
    header = Buffer.alloc(2);
    header[1] = body.length;
  } else if (body.length < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(body.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(body.length), 2);
  }
  header[0] = 0x80 | opcode;
  return Buffer.concat([header, body]);
}

/**
 * @param {string} acceptPath  only this upgrade path is honored
 * @param {{ health?: () => object, audioBytes?: number }} behaviour
 */
function startFakeBreeze(acceptPath, behaviour = {}) {
  const state = { messages: [], binarySent: 0, upgrades: 0, rejectedPaths: [] };
  const server = http.createServer((req, res) => {
    if (req.url && req.url.startsWith('/health')) {
      const body = behaviour.health ? behaviour.health() : { status: 'ok', sample_rate: 24000, ws_port: 0 };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  });

  server.on('upgrade', (req, socket) => {
    const path = (req.url || '/').split('?')[0];
    if (path !== acceptPath) {
      state.rejectedPaths.push(path);
      socket.write('HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    const key = req.headers['sec-websocket-key'] || '';
    const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n'
      + 'Upgrade: websocket\r\n'
      + 'Connection: Upgrade\r\n'
      + `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    state.upgrades += 1;

    const reader = new FrameReader();
    let audioSent = false;
    const sendJson = (value) => socket.write(serverFrame(0x1, JSON.stringify(value)));

    sendJson({ type: 'ready', sample_rate: 24000, format: 's16le' });

    socket.on('data', (chunk) => {
      for (const message of reader.push(chunk)) {
        if (message.opcode !== 0x1) continue;
        let value = null;
        try {
          value = JSON.parse(message.data.toString('utf8'));
        } catch {
          continue;
        }
        state.messages.push(value);
        if (value.type === 'start') sendJson({ type: 'started', voice_id: value.voice_id || null });
        if (value.type === 'text') sendJson({ type: 'speaking', text: String(value.text || '').slice(0, 40) });
        if (value.type === 'end' && !audioSent) {
          audioSent = true;
          // Two binary frames, to prove fragmentation handling over multiple reads.
          const total = Number(behaviour.audioBytes || 4800);
          const first = Math.floor(total / 2);
          const pcmA = Buffer.alloc(first, 0x11);
          const pcmB = Buffer.alloc(total - first, 0x22);
          socket.write(serverFrame(0x2, pcmA));
          socket.write(serverFrame(0x2, pcmB));
          state.binarySent = total;
          sendJson({ type: 'done' });
        }
      }
    });
    socket.on('error', () => {});
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port, state });
    });
  });
}

// ---------------------------------------------------------------- 1. derivation

console.log('\n[1/5] candidate derivation (original shape first)');

const derived = wsCandidates({ baseUrl: 'http://127.0.0.1:8080', wsUrl: '' }, { wsPort: 8081 });
expect(derived.length >= 2, 'several candidates', String(derived.length));
expect(derived[0].url === 'ws://127.0.0.1:8081/', 'first candidate is host:ws_port at root', derived[0].url);
expect(derived[0].source === 'ws_port', 'first candidate reports its source', derived[0].source);
expect(derived[1].url === 'ws://127.0.0.1:8080/ws', 'second candidate is the proxy path', derived[1].url);

const httpsDerived = wsCandidates({ baseUrl: 'https://breeze.0444.top', wsUrl: '' }, { wsPort: 8081 });
expect(httpsDerived[0].url === 'wss://breeze.0444.top:8081/', 'https base derives wss', httpsDerived[0].url);
expect(httpsDerived[1].url === 'wss://breeze.0444.top/ws', 'proxy candidate keeps the public host', httpsDerived[1].url);

const explicit = wsCandidates({ baseUrl: 'https://breeze.0444.top', wsUrl: 'wss://edge.example/tts' }, { wsPort: 8081 });
expect(explicit[0].url === 'wss://edge.example/tts', 'explicit wsUrl wins outright', explicit[0].url);
expect(explicit[0].source === 'wsUrl', 'explicit source recorded', explicit[0].source);

const defaults = wsCandidates({ baseUrl: 'http://127.0.0.1:8080', wsUrl: '' }, {});
expect(defaults[0].url === 'ws://127.0.0.1:8081/', 'defaults are the upstream listener shape (8081 + "/")', defaults[0].url);
expect(defaults[0].source === 'ws_port', 'default port reports discovery source', defaults[0].source);

const configured = wsCandidates({ baseUrl: 'https://breeze.0444.top', wsUrl: '', wsPort: 9005, wsPath: 'tts' }, { wsPort: 8081 });
expect(configured[0].url === 'wss://breeze.0444.top:9005/tts', 'configured wsPort + wsPath win over discovery', configured[0].url);
expect(configured[0].source === 'wsPort', 'configured port reports its source', configured[0].source);

const zeroPort = wsCandidates({ baseUrl: 'http://127.0.0.1:8080', wsUrl: '', wsPort: 0, wsPath: '/' }, { wsPort: 9005 });
expect(zeroPort[0].url === 'ws://127.0.0.1:9005/', 'wsPort 0 defers to /health', zeroPort[0].url);

const rootPath = wsCandidates({ baseUrl: 'http://127.0.0.1:8080', wsUrl: '', wsPort: 8081, wsPath: '' }, {});
expect(rootPath[0].url === 'ws://127.0.0.1:8081/', 'an empty wsPath normalises to "/"', rootPath[0].url);

// The default port of the scheme must not be spelled out, or the same socket is
// offered twice (this is what a 443 + /ws configuration produced before).
const viaDefaultPort = wsCandidates({ baseUrl: 'https://breeze.0444.top', wsUrl: '', wsPort: 443, wsPath: '/ws' }, { wsPort: 8081 });
expect(viaDefaultPort.length === 1, 'port 443 + path /ws collapses to one candidate', String(viaDefaultPort.length));
expect(viaDefaultPort[0].url === 'wss://breeze.0444.top/ws', 'default port is left implicit', viaDefaultPort[0].url);

// ---------------------------------------------------------------- 2. handshake

console.log('\n[2/5] handshake');

const upstream = await startFakeBreeze('/'); // the original listener
const proxy = await startFakeBreeze('/ws', { health: () => ({ status: 'ok', sample_rate: 24000, ws_port: 8081 }) });

try {
  const socket = await openSocket(`ws://127.0.0.1:${upstream.port}/`, { token: '' });
  ok('upgrade to the original listener', `101, ${upstream.state.upgrades} upgrade(s)`);
  const ready = await waitForReady(socket, 3000);
  expect(ready.sampleRate === 24000, 'ready frame parsed', `${ready.sampleRate} Hz / ${ready.format}`);
  socket.close();

  // A proxy path that was NOT rewritten onto / must fail loudly.
  forgetWsEndpoint();
  let wrongPath = null;
  try {
    await openSocket(`ws://127.0.0.1:${upstream.port}/ws`, { token: '' });
  } catch (error) {
    wrongPath = error;
  }
  expect(wrongPath !== null, 'a stray path is refused by the original listener');
  expect(/404/.test(String(wrongPath && wrongPath.message)) && /only answers \//.test(String(wrongPath && wrongPath.message)),
    'refusal names the real cause', String(wrongPath && wrongPath.message).split('\n')[0]);

  // ------------------------------------------------------------ 3. fallback

  console.log('\n[3/5] endpoint resolution and fallback');
  forgetWsEndpoint();

  const deadPort = 1; // nothing listens here; forces the fallback path
  const chosen = await resolveWsEndpoint(
    { baseUrl: `http://127.0.0.1:${proxy.port}`, wsUrl: '', token: '' },
    { wsPort: deadPort },
    { timeoutMs: 2000 },
  );
  expect(chosen.source === 'proxy_path', 'dead ws_port falls back to the proxy path', chosen.source);
  expect(chosen.url === `ws://127.0.0.1:${proxy.port}/ws`, 'fallback URL', chosen.url);
  expect(chosen.attempts.length === 1, 'the dead port is recorded as an attempt', String(chosen.attempts.length));
  expect(/ECONNREFUSED|nothing listening/.test(chosen.attempts[0].error), 'attempt error is actionable', chosen.attempts[0].error.slice(0, 80));

  const again = await resolveWsEndpoint(
    { baseUrl: `http://127.0.0.1:${proxy.port}`, wsUrl: '', token: '' },
    { wsPort: deadPort },
    { timeoutMs: 2000 },
  );
  expect(again.cached === true, 'the winning endpoint is cached for later calls');

  const explicitChoice = await resolveWsEndpoint(
    { baseUrl: `http://127.0.0.1:${proxy.port}`, wsUrl: `ws://127.0.0.1:${upstream.port}/`, token: '' },
    { wsPort: deadPort },
    { timeoutMs: 2000 },
  );
  expect(explicitChoice.source === 'wsUrl' && explicitChoice.url === `ws://127.0.0.1:${upstream.port}/`,
    'an explicit wsUrl is used without falling back', explicitChoice.url);

  // ------------------------------------------------------------ 4. speech flow

  console.log('\n[4/5] speech over the socket');
  forgetWsEndpoint();
  upstream.state.messages.length = 0;

  const speech = await speakWs(
    { baseUrl: `http://127.0.0.1:${upstream.port}`, wsUrl: `ws://127.0.0.1:${upstream.port}/`, token: '', timeoutMs: 15000 },
    { text: 'Hello there, this is a socket test.', voice: 'female_001', instruction: 'calm', cfgScale: 2, seed: 7 },
  );
  expect(speech.pcm.length === 4800, 'both binary frames were collected', `${speech.pcm.length} bytes`);
  expect(speech.sampleRate === 24000, 'sample rate came from the ready frame', String(speech.sampleRate));
  expect(speech.wsSource === 'wsUrl', 'transport reported its endpoint source', speech.wsSource);

  const sent = upstream.state.messages.map((m) => m.type);
  expect(sent[0] === 'start' && sent[1] === 'text' && sent[2] === 'end', 'client sent start → text → end', sent.join(','));
  const startMessage = upstream.state.messages[0];
  expect(startMessage.voice_id === 'female_001', 'start uses snake_case voice_id', String(startMessage.voice_id));
  expect(startMessage.cfg_scale === 2, 'start uses snake_case cfg_scale', String(startMessage.cfg_scale));
  expect(startMessage.seed === 7, 'start carries the seed', String(startMessage.seed));
  expect(/spoke: Hello there/.test(speech.notes.join(' · ')), 'speaking notices were recorded', speech.notes[0] || '');

  const { pcmToWav } = await import('../lib/wav.mjs');
  const info = wavInfo(pcmToWav(speech.pcm, { sampleRate: speech.sampleRate }));
  expect(info.valid && Math.abs(info.durationSec - 0.1) < 0.02, 'the PCM becomes a valid WAV', `${info.durationSec}s`);

  // ------------------------------------------------------------ 5. failure surface

  console.log('\n[5/5] failure surface');
  forgetWsEndpoint();
  let unreachable = null;
  try {
    await resolveWsEndpoint(
      { baseUrl: 'http://127.0.0.1:1', wsUrl: '', token: '' },
      { wsPort: 1 },
      { timeoutMs: 1200 },
    );
  } catch (error) {
    unreachable = error;
  }
  expect(unreachable !== null, 'an unreachable endpoint throws');
  expect(/no reachable Breeze WebSocket endpoint/.test(String(unreachable && unreachable.message)),
    'the error lists every attempt', String(unreachable && unreachable.message).split('\n')[0]);
  expect(/wsUrl/.test(String(unreachable && unreachable.message)), 'the error says how to fix it (set wsUrl)');
} finally {
  upstream.server.close();
  proxy.server.close();
}

console.log(`\n${failures === 0 ? 'OK' : 'FAILED'} — ${checks - failures}/${checks} checks passed`);
process.exit(failures === 0 ? 0 : 1);
