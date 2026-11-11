// dsh-breeze — host route test.
//
// The panel's workshop talks to three routes that did not exist before
// (/voices/save, /voices/<id>, /voice probes), and "the panel renders" says
// nothing about whether a save actually reaches Breeze as a multipart upload.
//
// So this starts a fake Breeze server that records what it receives, mounts the
// plugin's route handler against a stub web server, and drives it with fabricated
// requests. No network, no model, nothing written to the real server.
//
// Usage: node tools/routes-selftest.mjs

import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

let failures = 0;
let checks = 0;
const ok = (label, detail = '') => { checks += 1; console.log(`  PASS  ${label}${detail ? ` — ${detail}` : ''}`); };
const bad = (label, detail = '') => { checks += 1; failures += 1; console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`); };
const expect = (condition, label, detail = '') => (condition ? ok(label, detail) : bad(label, detail));

// ---------------------------------------------------------------- fake Breeze

const seen = { saves: [], deletes: [], bodies: [] };

const fake = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    const url = req.url || '/';

    if (req.method === 'GET' && url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', sample_rate: 24000, ws_port: 8081 }));
      return;
    }
    if (req.method === 'GET' && url === '/v1/voices') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify([{ id: 'female_001', frames: 110, seconds: 8.8, saved: true, ref_text: 'hi', description: '' }]));
      return;
    }
    if (req.method === 'POST' && url === '/v1/voices') {
      seen.bodies.push(body);
      const text = body.toString('latin1');
      const nameMatch = text.match(/name="name"\r\n\r\n([^\r]*)/);
      // The transcript may be multi-byte UTF-8: keep the raw bytes and let the
      // assertions compare buffers instead of a lossy latin1 view.
      const refStart = text.indexOf('name="ref_text"\r\n\r\n');
      const refText = refStart > -1 ? body.subarray(refStart + 'name="ref_text"\r\n\r\n'.length, text.indexOf('\r\n', refStart + 'name="ref_text"\r\n\r\n'.length)) : Buffer.alloc(0);
      seen.saves.push({ name: nameMatch ? nameMatch[1] : '', refText, bytes: body.length });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: nameMatch ? nameMatch[1] : 'unknown' }));
      return;
    }
    if (req.method === 'DELETE' && url.startsWith('/v1/voices/')) {
      seen.deletes.push(decodeURIComponent(url.slice('/v1/voices/'.length)));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ deleted: decodeURIComponent(url.slice('/v1/voices/'.length)), file_kept: true }));
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  });
});

await new Promise((resolve) => fake.listen(0, '127.0.0.1', resolve));
const fakePort = fake.address().port;

// ---------------------------------------------------------------- plugin routes

const home = path.join(os.tmpdir(), `dsh-breeze-routes-${process.pid}`);
fs.rmSync(home, { recursive: true, force: true });
fs.mkdirSync(home, { recursive: true });
fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({
  baseUrl: `http://127.0.0.1:${fakePort}`,
  token: '',
  format: 'wav',
}), 'utf8');
process.env.DSH_BREEZE_HOME = home;

const { registerRoutes } = await import('../lib/routes.mjs');

let handler = null;
const webServer = {
  register(spec) {
    if (!handler) handler = spec.handler;
    return () => {};
  },
};
const ctx = { effect: (fn) => fn() };
registerRoutes(ctx, webServer);

/** Fabricate a request the route can iterate and a response it can write to. */
function makeReq({ method = 'GET', url = '/', body = null, remote = '127.0.0.1' }) {
  const payload = body === null ? [] : [Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8')];
  return {
    method,
    url,
    headers: {},
    socket: { remoteAddress: remote },
    async *[Symbol.asyncIterator]() {
      for (const chunk of payload) yield chunk;
    },
  };
}

function makeRes() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    headersSent: false,
    writeHead(code, headers) {
      this.statusCode = code;
      Object.assign(this.headers, headers || {});
      this.headersSent = true;
    },
    end(chunk) {
      if (chunk) this.body += String(chunk);
    },
  };
}

async function call(spec) {
  const req = makeReq(spec);
  const res = makeRes();
  await handler(req, res);
  let json = null;
  try { json = JSON.parse(res.body); } catch { json = null; }
  return { status: res.statusCode, headers: res.headers, body: res.body, json };
}

console.log('\n[1/4] read routes');
{
  const status = await call({ url: '/dsh-breeze-api/status' });
  expect(status.status === 200, 'GET /status answers', String(status.status));
  expect(status.json && status.json.reachable === true, 'status reports the fake server as reachable');
  expect(status.json && status.json.wsPort === 8081, 'status carries ws_port', String(status.json && status.json.wsPort));

  const voices = await call({ url: '/dsh-breeze-api/voices' });
  expect(voices.status === 200 && voices.json.voices.length === 1, 'GET /voices lists what Breeze returned', String(voices.status));
  expect(voices.json.voices[0].id === 'female_001', 'voice row passthrough', voices.json.voices[0].id);
}

console.log('\n[2/4] saving a voice (design flow: a file this plugin wrote)');
{
  const sample = path.join(home, 'sample.wav');
  const pcm = Buffer.alloc(4800, 0x41);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(24000, 24);
  header.writeUInt32LE(48000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(pcm.length, 40);
  fs.writeFileSync(sample, Buffer.concat([header, pcm]));

  seen.saves.length = 0;
  seen.bodies.length = 0;
  const saved = await call({
    method: 'POST',
    url: '/dsh-breeze-api/voices/save',
    body: JSON.stringify({ name: 'narrator2', refText: '晚风起来了，我们回去吧。', audioPath: sample, description: 'calm young woman' }),
  });
  expect(saved.status === 200, 'POST /voices/save answers 200', String(saved.status));
  expect(saved.json && saved.json.id === 'narrator2', 'saved id echoed back', String(saved.json && saved.json.id));
  expect(Array.isArray(saved.json && saved.json.voices), 'saved response refreshes the voice list');
  expect(seen.saves.length === 1, 'Breeze received exactly one save', String(seen.saves.length));
  const record = seen.saves[0] || {};
  expect(record.name === 'narrator2', 'multipart carries name', record.name);
  expect(record.refText.equals(Buffer.from('晚风起来了，我们回去吧。', 'utf8')), 'multipart carries the exact transcript (UTF-8)');
  const designBody = seen.bodies[0] ? seen.bodies[0].toString('latin1') : '';
  expect(designBody.includes('ref_audio'), 'multipart carries the reference clip field');
  expect(designBody.includes('calm young woman'), 'multipart carries the description');
}

console.log('\n[3/4] saving a voice (clone flow: base64 upload)');
{
  seen.saves.length = 0;
  seen.bodies.length = 0;
  const payload = Buffer.alloc(600, 0x42);
  const saved = await call({
    method: 'POST',
    url: '/dsh-breeze-api/voices/save',
    body: JSON.stringify({
      name: 'cloned_one',
      refText: 'This is the reference transcript.',
      audioBase64: payload.toString('base64'),
      filename: 'take.wav',
      mime: 'audio/wav',
    }),
  });
  expect(saved.status === 200, 'base64 upload saves', String(saved.status));
  expect(seen.saves.length === 1 && seen.saves[0].name === 'cloned_one', 'upload reached Breeze', String(seen.saves[0] && seen.saves[0].name));
  const body = seen.bodies[0] ? seen.bodies[0].toString('latin1') : '';
  expect(body.includes('filename="take.wav"'), 'upload keeps the original filename');
  expect(body.includes('B'.repeat(64)), 'the uploaded bytes are in the multipart body');
}

console.log('\n[4/4] refusals, deletes and the loopback guard');
{
  const noName = await call({ method: 'POST', url: '/dsh-breeze-api/voices/save', body: JSON.stringify({ refText: 'x', audioBase64: 'QQ==' }) });
  expect(noName.status === 400 && /name is required/.test(noName.json.error), 'missing name is refused', noName.json && noName.json.error);

  const badName = await call({ method: 'POST', url: '/dsh-breeze-api/voices/save', body: JSON.stringify({ name: '../etc/passwd', refText: 'x', audioBase64: 'QQ==' }) });
  expect(badName.status === 400 && /letters, digits/.test(badName.json.error), 'a path-like name is refused before it can become a filename');

  const getSave = await call({ url: '/dsh-breeze-api/voices/save' });
  expect(getSave.status === 405, 'GET on a POST-only route is refused', String(getSave.status));

  seen.deletes.length = 0;
  const del = await call({ method: 'DELETE', url: '/dsh-breeze-api/voices/female_001' });
  expect(del.status === 200, 'DELETE /voices/<id> answers 200', String(del.status));
  expect(seen.deletes[0] === 'female_001', 'delete reached Breeze', String(seen.deletes[0]));
  expect(del.json && del.json.fileKept === true, 'file_kept surfaces to the panel');

  const remote = await call({ url: '/dsh-breeze-api/status', remote: '10.1.2.3' });
  expect(remote.status === 403, 'a non-loopback caller is refused', String(remote.status));

  const unknown = await call({ url: '/dsh-breeze-api/nope' });
  expect(unknown.status === 404, 'unknown route is 404', String(unknown.status));
}

// Keep-alive sockets from undici's fetch would outlive the server; close them and
// let the process end on its own. process.exit() here trips a libuv assertion on
// Windows (`!(handle->flags & UV_HANDLE_CLOSING)`) and reports a false failure.
await new Promise((resolve) => {
  fake.closeAllConnections?.();
  fake.close(resolve);
});
fs.rmSync(home, { recursive: true, force: true });

console.log(`\n${failures === 0 ? 'OK' : 'FAILED'} — ${checks - failures}/${checks} checks passed`);
process.exitCode = failures === 0 ? 0 : 1;
