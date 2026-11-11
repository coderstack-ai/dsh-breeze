// dsh-breeze — WebSocket client for Breeze, with no dependencies.
//
// Why hand-written: the plugin is installed as a `link:` package, so it cannot
// depend on the `ws` package (pnpm does not install a linked package's
// dependencies). Node's global WebSocket exists but refuses custom headers, and
// a Breeze behind a reverse proxy needs `Authorization: Bearer …` at handshake
// time. So this module speaks RFC 6455 directly: upgrade, masked client frames,
// fragmentation, ping/pong, close.
//
// The endpoint rule is "original first", because the upstream listener has no
// path handling at all:
//
//   1. an explicit `wsUrl` wins outright
//   2. ws(s)://<baseUrl host>:<health.ws_port>   ← the original shape, root path
//   3. wss?://<baseUrl host>[:port]/ws           ← what a reverse proxy rewrites
//
// Every candidate is verified with a real handshake before it is used, and the
// first one that answers 101 wins. `/ws` is therefore a fallback for deployments
// that had to invent a path, never an assumption.

import crypto from 'node:crypto';
import http from 'node:http';
import https from 'node:https';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const DEFAULT_TIMEOUT = 10000;

const OP_CONT = 0x0;
const OP_TEXT = 0x1;
const OP_BINARY = 0x2;
const OP_CLOSE = 0x8;
const OP_PING = 0x9;
const OP_PONG = 0xa;

// ---------------------------------------------------------------- endpoint derivation

/**
 * Candidate WebSocket URLs for one configuration, original shape first.
 * Pure: no I/O, so it can be asserted in tests.
 *
 * Order:
 *   1. an explicit `wsUrl` — used alone, no fallback
 *   2. `ws(s)://<host>:<wsPort><wsPath>` — wsPort defaults to 8081 and wsPath to
 *      `/`, which IS the upstream listener's own shape
 *   3. the same origin with `/ws`, for deployments whose proxy had to invent a
 *      path (only when it differs from candidate 2)
 *
 * @param {{ baseUrl: string, token?: string, wsUrl?: string, wsPort?: number, wsPath?: string }} config
 * @param {{ wsPort?: number }} [health] `/health`'s discovery hint, used only when the settings leave the port at 0
 * @returns {Array<{ url: string, source: string }>}
 */
export function wsCandidates(config, health = {}) {
  const out = [];
  const explicit = String(config.wsUrl || '').trim();
  if (explicit) return [{ url: normaliseWsUrl(explicit), source: 'wsUrl' }];

  let base = null;
  try {
    base = new URL(String(config.baseUrl || ''));
  } catch {
    base = null;
  }
  if (!base) return out;

  const scheme = base.protocol === 'https:' ? 'wss' : 'ws';
  const configuredPort = Number(config.wsPort);
  const healthPort = Number(health.wsPort || 0);
  const port = Number.isInteger(configuredPort) && configuredPort > 0
    ? configuredPort
    : (Number.isInteger(healthPort) && healthPort > 0 ? healthPort : 8081);
  const path = normalisePath(config.wsPath);

  out.push({
    url: buildWsUrl(scheme, base.hostname, port, path),
    source: Number.isInteger(configuredPort) && configuredPort > 0 ? 'wsPort' : 'ws_port',
  });

  // A proxy that rewrites a public path onto the listener's `/`, on the same
  // origin the HTTP API uses. Written with that origin's port (and the scheme's
  // default left implicit) so `wss://host:443/ws` and `wss://host/ws` do not end
  // up as two candidates for the same socket.
  const originPort = Number(base.port) || (scheme === 'wss' ? 443 : 80);
  const proxyUrl = buildWsUrl(scheme, base.hostname, originPort, '/ws');
  if (proxyUrl !== out[0].url) out.push({ url: proxyUrl, source: 'proxy_path' });

  return out;
}

/** One WebSocket URL; the scheme's default port is left implicit. */
function buildWsUrl(scheme, host, port, path) {
  const authority = port === (scheme === 'wss' ? 443 : 80) ? formatHost(host) : `${formatHost(host)}:${port}`;
  return `${scheme}://${authority}${path}`;
}

/** '/' when empty, otherwise ensure a single leading slash. */
function normalisePath(raw) {
  const value = String(raw ?? '').trim();
  if (!value || value === '/') return '/';
  return value.startsWith('/') ? value : `/${value}`;
}

function formatHost(host) {
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
}

function normaliseWsUrl(raw) {
  let url = String(raw).trim();
  if (/^https?:\/\//i.test(url)) url = url.replace(/^http/i, 'ws');
  if (!/^wss?:\/\//i.test(url)) url = `ws://${url}`;
  return url;
}

// ---------------------------------------------------------------- frames

/** One masked client frame. Client frames MUST be masked (RFC 6455 §5.3). */
export function encodeFrame(opcode, payload) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload ?? ''), 'utf8');
  const mask = crypto.randomBytes(4);
  let header;
  if (body.length < 126) {
    header = Buffer.alloc(2);
    header[1] = 0x80 | body.length;
  } else if (body.length < 65536) {
    header = Buffer.alloc(4);
    header[1] = 0x80 | 126;
    header.writeUInt16BE(body.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(body.length), 2);
  }
  header[0] = 0x80 | opcode;
  const masked = Buffer.allocUnsafe(body.length);
  for (let i = 0; i < body.length; i += 1) masked[i] = body[i] ^ mask[i & 3];
  return Buffer.concat([header, mask, masked]);
}

/**
 * Incremental frame reader. Frames arrive split across TCP reads, and a single
 * `data` event can hold several of them, so parsing has to be a state machine
 * over an accumulator rather than "parse one buffer".
 */
export class FrameReader {
  constructor() {
    this.buffer = Buffer.alloc(0);
    this.fragments = null; // { opcode, parts } while a fragmented message is open
  }

  /** Feed bytes; returns complete messages as { opcode, data }. */
  push(chunk) {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    const messages = [];
    for (;;) {
      if (this.buffer.length < 2) break;
      const first = this.buffer[0];
      const fin = (first & 0x80) !== 0;
      const opcode = first & 0x0f;
      const masked = (this.buffer[1] & 0x80) !== 0;
      let length = this.buffer[1] & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (this.buffer.length < 4) break;
        length = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (this.buffer.length < 10) break;
        length = Number(this.buffer.readBigUInt64BE(2));
        offset = 10;
      }
      let maskKey = null;
      if (masked) {
        if (this.buffer.length < offset + 4) break;
        maskKey = this.buffer.subarray(offset, offset + 4);
        offset += 4;
      }
      if (this.buffer.length < offset + length) break;
      let payload = Buffer.from(this.buffer.subarray(offset, offset + length));
      if (maskKey) {
        for (let i = 0; i < payload.length; i += 1) payload[i] ^= maskKey[i & 3];
      }
      this.buffer = this.buffer.subarray(offset + length);

      if (opcode === OP_CLOSE || opcode === OP_PING || opcode === OP_PONG) {
        messages.push({ opcode, data: payload });
        continue;
      }
      if (opcode === OP_TEXT || opcode === OP_BINARY) {
        if (!fin) {
          this.fragments = { opcode, parts: [payload] };
          continue;
        }
        messages.push({ opcode, data: payload });
        continue;
      }
      if (opcode === OP_CONT) {
        if (!this.fragments) continue; // stray continuation: ignore
        this.fragments.parts.push(payload);
        if (fin) {
          messages.push({ opcode: this.fragments.opcode, data: Buffer.concat(this.fragments.parts) });
          this.fragments = null;
        }
        continue;
      }
      // Unknown opcode: drop it rather than desynchronise the stream.
    }
    return messages;
  }
}

// ---------------------------------------------------------------- client

/** A Breeze WebSocket session: text frames are JSON control, binary frames are PCM. */
export class BreezeSocket {
  constructor({ socket, response, url }) {
    this.socket = socket;
    this.response = response;
    this.url = url;
    this.reader = new FrameReader();
    this.closed = false;
    this.error = null;
    // A listener sends `ready` the instant the handshake completes — usually in
    // the same TCP packet as the 101, which lands before the caller has had a
    // chance to assign a handler. Dropping that frame is exactly the bug this
    // backlog prevents; assigning a handler drains it in arrival order.
    this._onText = null;
    this._onBinary = null;
    this._onClose = null;
    this.textBacklog = [];
    this.binaryBacklog = [];

    socket.on('data', (chunk) => this.feed(chunk));
    socket.on('error', (error) => this.#finish(error));
    socket.on('close', () => this.#finish(null));
  }

  get onText() { return this._onText; }
  set onText(handler) {
    this._onText = typeof handler === 'function' ? handler : null;
    if (this._onText) this.#drain();
  }

  get onBinary() { return this._onBinary; }
  set onBinary(handler) {
    this._onBinary = typeof handler === 'function' ? handler : null;
    if (this._onBinary) this.#drain();
  }

  // `onClose` deliberately has no setter: a close that arrives during setup must
  // not be replayed to a handler that was installed afterwards.
  get onClose() { return this._onClose; }
  set onClose(handler) { this._onClose = typeof handler === 'function' ? handler : null; }

  /** Parse and dispatch bytes; safe to call before any handler exists. */
  feed(chunk) {
    for (const message of this.reader.push(chunk)) {
      if (message.opcode === OP_PING) {
        this.#write(encodeFrame(OP_PONG, message.data));
        continue;
      }
      if (message.opcode === OP_CLOSE) {
        this.#finish(null);
        return;
      }
      if (message.opcode === OP_TEXT) {
        let parsed = null;
        try {
          parsed = JSON.parse(message.data.toString('utf8'));
        } catch {
          parsed = { type: 'raw', text: message.data.toString('utf8') };
        }
        if (this._onText) this._onText(parsed);
        else this.textBacklog.push(parsed);
        continue;
      }
      if (message.opcode === OP_BINARY) {
        if (this._onBinary) this._onBinary(message.data);
        else this.binaryBacklog.push(message.data);
      }
    }
  }

  #drain() {
    while (this._onText && this.textBacklog.length) this._onText(this.textBacklog.shift());
    while (this._onBinary && this.binaryBacklog.length) this._onBinary(this.binaryBacklog.shift());
  }

  #write(frame) {
    if (this.closed) return;
    try {
      this.socket.write(frame);
    } catch (error) {
      this.#finish(error);
    }
  }

  #finish(error) {
    if (this.closed) return;
    this.closed = true;
    this.error = error || this.error;
    try { this.socket.end(); } catch { /* already gone */ }
    if (this.onClose) this.onClose(this.error);
  }

  /** Send one JSON control message. */
  send(message) {
    this.#write(encodeFrame(OP_TEXT, JSON.stringify(message)));
  }

  close(code = 1000) {
    if (this.closed) return;
    const payload = Buffer.alloc(2);
    payload.writeUInt16BE(code, 0);
    this.#write(encodeFrame(OP_CLOSE, payload));
    this.#finish(null);
  }
}

/**
 * Open one WebSocket connection. Resolves with the socket after the handshake,
 * rejects with a message that names the failure stage.
 *
 * @returns {Promise<BreezeSocket>}
 */
export function openSocket(url, { token = '', timeoutMs = DEFAULT_TIMEOUT, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch (error) {
      reject(new Error(`invalid WebSocket URL ${url}: ${error.message}`));
      return;
    }
    const secure = parsed.protocol === 'wss:' || parsed.protocol === 'https:';
    if (!secure && parsed.protocol !== 'ws:' && parsed.protocol !== 'http:') {
      reject(new Error(`unsupported WebSocket protocol ${parsed.protocol} in ${url}`));
      return;
    }

    const key = crypto.randomBytes(16).toString('base64');
    const expected = crypto.createHash('sha1').update(key + GUID).digest('base64');
    const requestHeaders = {
      Connection: 'Upgrade',
      Upgrade: 'websocket',
      'Sec-WebSocket-Key': key,
      'Sec-WebSocket-Version': '13',
      Host: parsed.host,
      ...headers,
    };
    if (token) requestHeaders.Authorization = `Bearer ${token}`;

    const transport = secure ? https : http;
    const request = transport.request({
      method: 'GET',
      hostname: parsed.hostname,
      port: parsed.port || (secure ? 443 : 80),
      path: `${parsed.pathname || '/'}${parsed.search || ''}`,
      headers: requestHeaders,
      ...(secure ? { servername: parsed.hostname, rejectUnauthorized: true } : {}),
    });

    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      request.destroy();
      reject(new Error(`handshake to ${url} timed out after ${timeoutMs} ms`));
    }, Math.max(1000, Number(timeoutMs) || DEFAULT_TIMEOUT));

    const fail = (message) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { request.destroy(); } catch { /* ignore */ }
      reject(new Error(message));
    };

    request.on('response', (response) => {
      const status = response.statusCode || 0;
      const hint = status === 401 ? ' (handshake rejected: token missing or wrong)'
        : status === 404 ? ' (no WebSocket listener at that path: the upstream listener only answers /, a proxy path must be rewritten to it)'
          : status === 200 ? ' (answered as plain HTTP: the Upgrade headers were not honored, or the path went to the HTTP port)'
            : '';
      fail(`handshake to ${url} answered HTTP ${status} instead of 101${hint}`);
    });

    request.on('upgrade', (response, socket, head) => {
      if (response.statusCode !== 101) return fail(`handshake to ${url} answered ${response.statusCode}`);
      const accept = response.headers['sec-websocket-accept'];
      if (accept !== expected) return fail(`handshake to ${url} returned a bad Sec-WebSocket-Accept (not a Breeze listener?)`);
      settled = true;
      clearTimeout(timer);
      socket.setNoDelay(true);
      const ws = new BreezeSocket({ socket, response, url });
      // Bytes that rode along with the 101 belong to the same stream.
      if (head && head.length) ws.feed(head);
      resolve(ws);
    });

    request.on('error', (error) => {
      const code = error && error.code ? error.code : '';
      const hint = code === 'ECONNREFUSED' ? ' (nothing listening on that host/port)'
        : code === 'ENOTFOUND' ? ' (host does not resolve)'
          : code === 'ECONNRESET' ? ' (connection reset before the handshake finished)'
            : /certificate/i.test(String(error.message)) ? ' (TLS certificate rejected)' : '';
      fail(`handshake to ${url} failed — ${code || error.message}${hint}`);
    });

    request.end();
  });
}

/** Read the `ready` frame that a fresh Breeze listener sends before any text. */
export function waitForReady(socket, timeoutMs = DEFAULT_TIMEOUT) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`no "ready" message within ${timeoutMs} ms (is this really a Breeze WebSocket listener?)`));
    }, Math.max(1000, Number(timeoutMs) || DEFAULT_TIMEOUT));

    const previousText = socket.onText;
    const previousClose = socket.onClose;

    function cleanup() {
      clearTimeout(timer);
      socket.onText = previousText;
      socket.onClose = previousClose;
    }

    socket.onText = (message) => {
      if (message && message.type === 'ready') {
        cleanup();
        resolve({ sampleRate: Number(message.sample_rate || 24000) || 24000, format: String(message.format || 's16le') });
        return;
      }
      if (previousText) previousText(message);
    };
    socket.onClose = (error) => {
      cleanup();
      if (previousClose) previousClose(error);
      reject(error ? new Error(`socket closed while waiting for ready: ${error.message}`) : new Error('socket closed while waiting for ready'));
    };
  });
}

/**
 * Resolve a usable WebSocket endpoint, verifying each candidate with a real
 * handshake. The winning URL is cached for `ttlMs` so a long turn does not
 * re-probe on every call.
 */
export async function resolveWsEndpoint(config, health, { timeoutMs = 5000, ttlMs = 300000, signal, noCache = false } = {}) {
  const candidates = wsCandidates(config, health || {});
  if (candidates.length === 0) {
    throw new Error('cannot derive a WebSocket endpoint: baseUrl is not a valid URL and wsUrl is empty');
  }
  // Cache is keyed by the candidate list itself: changing baseUrl, wsPort, wsPath
  // or wsUrl must invalidate it, otherwise an explicit wsUrl would be ignored
  // while a stale fallback is still in the cache.
  const fingerprint = candidates.map((candidate) => candidate.url).join('|');
  const now = Date.now();
  // `noCache` is for diagnostics: report what is true right now without letting
  // the answer overwrite the endpoint a speech call is about to use.
  if (!noCache && cached.url && cached.expires > now && cached.fingerprint === fingerprint) {
    return { url: cached.url, source: cached.source, cached: true, attempts: [] };
  }

  const attempts = [];
  for (const candidate of candidates) {
    if (signal && signal.aborted) throw new Error('aborted while resolving the WebSocket endpoint');
    try {
      const socket = await openSocket(candidate.url, { token: config.token, timeoutMs });
      socket.onClose = null;
      socket.close();
      if (!noCache) cached = { url: candidate.url, source: candidate.source, expires: now + ttlMs, fingerprint };
      return { url: candidate.url, source: candidate.source, cached: false, attempts };
    } catch (error) {
      attempts.push({ url: candidate.url, source: candidate.source, error: String(error && error.message ? error.message : error) });
    }
  }
  const detail = attempts.map((a) => `  - ${a.url} (${a.source}): ${a.error}`).join('\n');
  throw new Error(`no reachable Breeze WebSocket endpoint. Tried:\n${detail}\nSet \`wsUrl\`, \`wsPort\` or \`wsPath\` in the breeze config to override, e.g. wss://host/ws`);
}

let cached = { url: '', source: '', expires: 0, fingerprint: '' };

/** Drop the cached endpoint (call after a failure, or when settings change). */
export function forgetWsEndpoint() {
  cached = { url: '', source: '', expires: 0, fingerprint: '' };
}
