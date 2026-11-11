// dsh-breeze — HTTP surface for the web UI and for anything that would rather
// talk HTTP than call a tool: status, settings, voices, one-shot speech, and
// playback of the audio this plugin wrote.
//
// DSH's webServer keys its route table by (kind, path) and ignores the method,
// so a second register on the same path throws and takes the whole plugin down
// with it. Everything therefore lives under ONE prefix route and dispatches on
// req.method internally.

import fs from 'node:fs';
import path from 'node:path';

import * as breeze from './breeze-client.mjs';
import { audioDir, configPath, readConfig, writeConfig } from './config.mjs';
import { writeAudio } from './output.mjs';
import { probe } from './server-manager.mjs';
import { probeWs, summariseWsError } from './ws-probe.mjs';

const PREFIX = '/dsh-breeze-api';

/**
 * This prefix sits in front of the harness's own session auth: named routes are
 * dispatched before the fallback that checks it. So the guard is ours to write.
 * Loopback only — the same rule breeze-server's own documentation recommends
 * (it has no auth either), and matching what a local web GUI needs.
 */
function isLoopback(req) {
  const address = (req.socket && (req.socket.remoteAddress || (req.socket._socket && req.socket._socket.remoteAddress))) || '';
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  // A proxy that rewrites the peer address would defeat a socket-only check, but
  // trusting X-Forwarded-For from a non-loopback peer is worse. Judge the socket.
  void forwarded;
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1' || address.startsWith('127.');
}

function sendJson(res, status, value) {
  const body = `${JSON.stringify(value)}\n`;
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function sendText(res, status, value) {
  const body = `${value}\n`;
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

async function readJsonBody(req, limit = 8 * 1024 * 1024) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > limit) throw new Error('request body too large');
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return {};
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('JSON body must be an object');
  return parsed;
}

const MIME = { '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.pcm': 'audio/pcm' };

/** Serve one file from the audio directory, refusing anything that escapes it. */
function serveAudio(res, dir, name) {
  const base = path.basename(String(name || ''));
  if (!base || base !== String(name || '')) {
    sendJson(res, 400, { error: 'invalid file name' });
    return;
  }
  const file = path.join(dir, base);
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    sendJson(res, 404, { error: 'no such audio file' });
    return;
  }
  if (!stat.isFile()) {
    sendJson(res, 404, { error: 'not a file' });
    return;
  }
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
    'Content-Length': stat.size,
    'Cache-Control': 'no-store',
  });
  fs.createReadStream(file).pipe(res);
}

/**
 * Register the prefix route and return its disposer.
 * @param ctx plugin context (for effect ownership)
 * @param webServer the dsh-host-webserver service
 */
export function registerRoutes(ctx, webServer) {
  const disposer = webServer.register({
    kind: 'prefix',
    path: PREFIX,
    async handler(req, res) {
      const url = new URL(req.url || '/', 'http://localhost');
      const route = url.pathname.slice(PREFIX.length) || '/';
      const method = (req.method || 'GET').toUpperCase();
      try {
        if (!isLoopback(req)) {
          return sendJson(res, 403, { error: 'dsh-breeze-api only answers loopback clients; drive it from the DSH host' });
        }
        if (route === '/status' || route === '/') {
          if (method !== 'GET' && method !== 'HEAD') return sendJson(res, 405, { error: 'GET only' });
          const config = readConfig();
          const health = await probe(config, { timeoutMs: 6000 });
          return sendJson(res, 200, {
            reachable: health.reachable === true,
            baseUrl: config.baseUrl,
            auth: config.token ? 'bearer' : 'none',
            sampleRate: health.sampleRate || 0,
            wsPort: health.wsPort || 0,
            format: config.format,
            voice: config.voice,
            instruction: config.instruction,
            cfgScale: config.cfgScale,
            seed: config.seed,
            outputDir: audioDir(config),
            configFile: configPath(),
            autostart: config.autostart === true,
            error: health.reachable ? undefined : health.error,
          });
        }

        if (route === '/ws' || route === '/ws-probe') {
          if (method !== 'GET' && method !== 'HEAD') return sendJson(res, 405, { error: 'GET only' });
          const config = readConfig();
          let health = {};
          try {
            health = await probe(config, { timeoutMs: 4000 });
          } catch {
            health = {};
          }
          const result = await probeWs(config, health, { timeoutMs: 2000 });
          return sendJson(res, 200, {
            reachable: result.reachable,
            url: result.url,
            source: result.source,
            candidates: result.candidates,
            error: result.reachable ? '' : summariseWsError(result.error),
            detail: result.reachable ? '' : result.error,
            wsPort: config.wsPort,
            wsPath: config.wsPath,
            ms: result.ms,
          });
        }

        if (route === '/config') {
          if (method === 'GET' || method === 'HEAD') {
            const config = readConfig();
            // The settings route is reachable from any page the web GUI serves,
            // so a bearer token never leaves this process in clear text.
            const redacted = { ...config, token: config.token ? '***' : '', tokenSet: Boolean(config.token) };
            return sendJson(res, 200, { file: configPath(), config: redacted });
          }
          if (method === 'PUT' || method === 'POST') {
            const body = await readJsonBody(req);
            const result = writeConfig(body);
            return sendJson(res, 200, { file: result.file, applied: result.applied, ignored: result.ignored, config: result.config });
          }
          return sendJson(res, 405, { error: 'GET or PUT' });
        }

        if (route === '/voices') {
          if (method !== 'GET' && method !== 'HEAD') return sendJson(res, 405, { error: 'GET only' });
          const config = readConfig();
          const voices = await breeze.listVoices(config);
          return sendJson(res, 200, { baseUrl: config.baseUrl, voices });
        }

        // Save a voice from either a file this plugin already wrote (the design
        // flow: generate a sample, listen, keep it) or a base64 upload (the clone
        // flow: the person picks a WAV). Both end in the same multipart POST to
        // Breeze, so the panel never speaks the server's protocol itself.
        if (route === '/voices/save') {
          if (method !== 'POST') return sendJson(res, 405, { error: 'POST only' });
          const body = await readJsonBody(req, 16 * 1024 * 1024);
          const config = readConfig();
          const name = String(body.name || '').trim();
          const refText = String(body.refText || '').trim();
          if (!name) return sendJson(res, 400, { error: 'name is required' });
          if (!/^[A-Za-z0-9_-]{1,64}$/.test(name)) {
            return sendJson(res, 400, { error: 'name allows letters, digits, dash and underscore only (it becomes a filename)' });
          }
          if (!refText) return sendJson(res, 400, { error: 'refText (the exact transcript of the clip) is required' });

          let audio = null;
          let filename = 'reference.wav';
          let type = 'audio/wav';
          if (body.audioPath) {
            const file = path.resolve(String(body.audioPath));
            let stat;
            try {
              stat = fs.statSync(file);
            } catch {
              return sendJson(res, 400, { error: `audioPath not found: ${file}` });
            }
            if (!stat.isFile() || stat.size === 0) return sendJson(res, 400, { error: `audioPath is not a usable file: ${file}` });
            audio = fs.readFileSync(file);
            filename = path.basename(file);
            type = filename.toLowerCase().endsWith('.mp3') ? 'audio/mpeg' : 'audio/wav';
          } else if (body.audioBase64) {
            audio = Buffer.from(String(body.audioBase64), 'base64');
            if (audio.length === 0) return sendJson(res, 400, { error: 'audioBase64 decoded to zero bytes' });
            filename = String(body.filename || 'reference.wav');
            type = String(body.mime || 'audio/wav');
          } else {
            return sendJson(res, 400, { error: 'pass either audioPath (a file this plugin wrote) or audioBase64 (an upload)' });
          }

          const saved = await breeze.saveVoice(config, {
            audio,
            filename,
            type,
            name,
            refText,
            description: String(body.description || ''),
          });
          const voices = await breeze.listVoices(config).catch(() => []);
          return sendJson(res, 200, { id: saved.id, voices });
        }

        if (route.startsWith('/voices/')) {
          const id = decodeURIComponent(route.slice('/voices/'.length));
          if (!id || id === 'save') return sendJson(res, 404, { error: 'a voice id is required' });
          if (method !== 'DELETE') return sendJson(res, 405, { error: 'DELETE only' });
          const config = readConfig();
          const result = await breeze.deleteVoice(config, id);
          const voices = await breeze.listVoices(config).catch(() => []);
          return sendJson(res, 200, { deleted: result.deleted || id, fileKept: result.file_kept === true, voices });
        }

        if (route === '/speak') {
          if (method !== 'POST') return sendJson(res, 405, { error: 'POST only' });
          const body = await readJsonBody(req);
          const config = readConfig();
          if (!body || !String(body.text || '').trim()) return sendJson(res, 400, { error: 'text is required' });
          const result = await breeze.speak(config, {
            text: String(body.text),
            voice: body.voice ?? config.voice,
            instruction: body.instruction ?? config.instruction,
            cfgScale: body.cfgScale ?? config.cfgScale,
            seed: body.seed ?? config.seed,
            format: body.format ?? config.format,
            timeoutMs: config.timeoutMs,
          });
          const written = writeAudio(config, result.buffer, { ext: result.format, text: String(body.text) });
          return sendJson(res, 200, {
            url: `${PREFIX}/audio/${encodeURIComponent(path.basename(written.path))}`,
            path: written.path,
            bytes: written.bytes,
            durationSec: result.durationSec,
            sampleRate: result.sampleRate,
            format: result.format,
          });
        }

        if (route.startsWith('/audio/')) {
          if (method !== 'GET' && method !== 'HEAD') return sendJson(res, 405, { error: 'GET only' });
          const config = readConfig();
          return serveAudio(res, audioDir(config), decodeURIComponent(route.slice('/audio/'.length)));
        }

        return sendJson(res, 404, { error: `no route for ${route}` });
      } catch (error) {
        const message = error && error.message ? error.message : String(error);
        const status = error && error.status && Number.isInteger(error.status) ? error.status : 500;
        if (!res.headersSent) sendJson(res, status >= 400 && status < 600 ? status : 500, { error: message });
      }
    },
  });
  ctx.effect(() => disposer, 'dsh-breeze: api route');
  return disposer;
}
