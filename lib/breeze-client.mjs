// dsh-breeze 鈥?HTTP client for a Breeze-TTS-2.cpp server.
//
// Two request shapes, and the server treats them differently:
//
//   form  (multipart)  native endpoint: text / instruction (singular) /
//                      voice_id / ref_audio / ref_text / cfg_scale / seed /
//                      sampling fields. Streams headerless s16le PCM.
//   json  (OpenAI)     input / instructions (PLURAL) / voice /
//                      response_format. Streams mp3, wav or pcm.
//
// The field-name asymmetry is not a guess: sending `instruction` in a JSON body
// is silently ignored by the server (200 OK, audio still returned, direction
// dropped). We therefore route speech through the form path whenever possible,
// because it carries every sampling field, accepts a reference clip, and hands
// back raw PCM that we wrap into a strictly valid WAV ourselves.
//
// mp3 is only reachable through the JSON path, so that one case uses JSON.

import { fixWav, pcmToWav, pcmDuration, wavInfo } from './wav.mjs';

/** A failed Breeze call, carrying the server's own message when it had one. */
export class BreezeError extends Error {
  constructor(message, { status = 0, code = '', body = '' } = {}) {
    super(message);
    this.name = 'BreezeError';
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

function trimBase(baseUrl) {
  return String(baseUrl || '').replace(/\/+$/, '');
}

function headersFor(config, extra) {
  const headers = { ...(extra || {}) };
  const token = String(config.token || '').trim();
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

function timeoutSignal(ms) {
  const budget = Number(ms);
  if (!Number.isFinite(budget) || budget <= 0) return undefined;
  return AbortSignal.timeout(Math.round(budget));
}

/** Turn a fetch failure into the reason a person can act on (ECONNREFUSED, DNS, TLS). */
function describeFetchError(error) {
  if (!error) return 'unknown error';
  const cause = error.cause;
  const code = cause && (cause.code || cause.errno);
  const detail = cause && cause.message ? cause.message : error.message;
  if (code === 'ECONNREFUSED') return 'connection refused: nothing is listening on that host/port';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'host not found: check the baseUrl host name';
  if (code === 'ECONNRESET') return 'connection reset by the server';
  if (code === 'CERT_HAS_EXPIRED' || (cause && /certificate/i.test(String(cause.message)))) return `TLS certificate problem: ${detail}`;
  if (error.name === 'TimeoutError') return 'the request timed out';
  return code ? `${code}: ${detail}` : String(detail || error);
}

/** Parse a non-2xx answer into a BreezeError with the most specific message available. */
async function toError(response) {
  let text = '';
  try {
    text = await response.text();
  } catch {
    text = '';
  }
  let message = '';
  let code = '';
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object') {
      if (parsed.error && typeof parsed.error === 'object') {
        message = String(parsed.error.message || '');
        code = String(parsed.error.code || parsed.error.type || '');
      } else if (typeof parsed.error === 'string') {
        message = parsed.error;
      }
      if (!message && typeof parsed.message === 'string') message = parsed.message;
    }
  } catch {
    // not JSON: keep the raw text below
  }
  if (!message) message = text.trim().slice(0, 400);
  const hint = response.status === 409 ? ' (server is busy: every generation slot is taken, retry shortly)'
    : response.status === 404 ? ' (unknown voice id, or no route at that path)'
      : response.status === 401 ? ' (endpoint wants a token: set `token` in the breeze config)'
        : '';
  return new BreezeError(`breeze ${response.status} ${response.statusText || ''}`.trim() + hint + (message ? `: ${message}` : ''), {
    status: response.status,
    code,
    body: text.slice(0, 2000),
  });
}

// ---------------------------------------------------------------- health

/** `GET /health` 鈫?{ ok, sampleRate, wsPort, status, ms }. */
export async function health(config, { timeoutMs = 8000 } = {}) {
  const started = Date.now();
  let response;
  try {
    response = await fetch(`${trimBase(config.baseUrl)}/health`, {
      headers: headersFor(config),
      signal: timeoutSignal(timeoutMs),
    });
  } catch (error) {
    throw new BreezeError(`cannot reach breeze at ${config.baseUrl} — ${describeFetchError(error)}`, { code: 'unreachable' });
  }
  if (!response.ok) throw await toError(response);
  let body = {};
  try {
    body = await response.json();
  } catch {
    body = { status: 'ok' };
  }
  return {
    ok: true,
    status: String(body.status || 'ok'),
    sampleRate: Number(body.sample_rate || body.sampleRate || 24000) || 24000,
    wsPort: Number(body.ws_port ?? body.wsPort ?? 0) || 0,
    ms: Date.now() - started,
  };
}

// ---------------------------------------------------------------- voices

/** `GET /v1/voices` 鈫?[{ id, seconds, saved, refText, description, metadata }]. */
export async function listVoices(config, { timeoutMs = 15000 } = {}) {
  let response;
  try {
    response = await fetch(`${trimBase(config.baseUrl)}/v1/voices`, {
      headers: headersFor(config),
      signal: timeoutSignal(timeoutMs),
    });
  } catch (error) {
    throw new BreezeError(`list voices failed at ${config.baseUrl} — ${describeFetchError(error)}`, { code: 'unreachable' });
  }
  if (!response.ok) throw await toError(response);
  const body = await response.json();
  const rows = Array.isArray(body) ? body : Array.isArray(body && body.voices) ? body.voices : [];
  return rows.map((row) => ({
    id: String(row.id ?? row.voice_id ?? ''),
    seconds: Number(row.seconds ?? 0) || 0,
    frames: Number(row.frames ?? 0) || 0,
    saved: row.saved === true,
    refText: String(row.ref_text ?? row.refText ?? ''),
    description: String(row.description ?? ''),
    metadata: row.metadata && typeof row.metadata === 'object' ? row.metadata : {},
  })).filter((row) => row.id);
}

// ---------------------------------------------------------------- speech

/**
 * Synthesize speech.
 *
 * @returns {Promise<{ buffer: Buffer, format: string, sampleRate: number, durationSec: number, contentType: string, ms: number }>}
 */
export async function speak(config, options) {
  const {
    text,
    voice = '',
    instruction = '',
    cfgScale,
    seed,
    format = 'wav',
    refAudio = null,
    refText = '',
    temperature,
    topK,
    topP,
    repetitionPenalty,
    splitChars,
    maxNewTokens,
    timeoutMs,
  } = options;

  if (!text || !String(text).trim()) throw new BreezeError('text is required', { code: 'invalid' });
  const container = String(format || 'wav').toLowerCase();
  const started = Date.now();
  const base = trimBase(config.baseUrl);

  if (container === 'mp3') {
    const body = {
      model: 'tts-1',
      input: text,
      response_format: 'mp3',
      stream_format: 'audio',
    };
    const spoken = String(voice || '').trim();
    if (spoken) body.voice = spoken;
    const direction = String(instruction || '').trim();
    if (direction) body.instructions = direction; // PLURAL on the JSON path
    if (Number.isFinite(Number(cfgScale))) body.cfg_scale = Number(cfgScale);
    if (Number.isFinite(Number(seed))) body.seed = Number(seed);
    if (Number.isFinite(Number(temperature))) body.temperature = Number(temperature);
    if (Number.isFinite(Number(topK))) body.top_k = Number(topK);
    if (Number.isFinite(Number(topP))) body.top_p = Number(topP);
    if (Number.isFinite(Number(repetitionPenalty))) body.repetition_penalty = Number(repetitionPenalty);
    if (Number.isFinite(Number(splitChars))) body.split_chars = Number(splitChars);
    if (Number.isFinite(Number(maxNewTokens))) body.max_new_tokens = Number(maxNewTokens);

    const response = await fetchWithBusyRetry(`${base}/v1/audio/speech`, {
      method: 'POST',
      headers: headersFor(config, { 'Content-Type': 'application/json' }),
      body: JSON.stringify(body),
      signal: timeoutSignal(timeoutMs),
    });
    if (!response.ok) throw await toError(response);
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length === 0) throw new BreezeError('breeze returned an empty audio body', { code: 'empty' });
    const contentType = response.headers.get('content-type') || 'audio/mpeg';
    // A build without the MP3 encoder may answer WAV for an mp3 request.
    const isWav = buffer.length > 12 && buffer.toString('ascii', 0, 4) === 'RIFF';
    const fixed = isWav ? fixWav(buffer) : buffer;
    const info = isWav ? wavInfo(fixed) : { valid: false };
    // MP3 has no cheap frame parser here; upstream encodes 80 kbps mono, so a
    // bitrate estimate is within a fraction of a second and beats reporting 0.
    const estimated = buffer.length > 0 ? Number(((buffer.length * 8) / 80000).toFixed(3)) : 0;
    return {
      buffer: fixed,
      format: isWav ? 'wav' : 'mp3',
      sampleRate: Number(response.headers.get('x-sample-rate') || info.sampleRate || 48000) || 48000,
      durationSec: info.valid ? info.durationSec : estimated,
      contentType: isWav ? 'audio/wav' : contentType,
      ms: Date.now() - started,
    };
  }

  // wav / pcm: the native form path, one field name per documented row.
  const form = new FormData();
  form.append('text', text);
  const direction = String(instruction || '').trim();
  if (direction) form.append('instruction', direction); // singular on the form path
  const spoken = String(voice || '').trim();
  if (spoken) form.append('voice_id', spoken);
  if (refAudio && refAudio.buffer) {
    form.append('ref_audio', new Blob([refAudio.buffer], { type: refAudio.type || 'audio/wav' }), refAudio.filename || 'reference.wav');
    if (!String(refText || '').trim()) {
      throw new BreezeError('ref_text is required whenever a reference clip is sent', { code: 'invalid' });
    }
    form.append('ref_text', String(refText));
  }
  if (Number.isFinite(Number(cfgScale))) form.append('cfg_scale', String(Number(cfgScale)));
  if (Number.isFinite(Number(seed))) form.append('seed', String(Number(seed)));
  if (Number.isFinite(Number(temperature))) form.append('temperature', String(Number(temperature)));
  if (Number.isFinite(Number(topK))) form.append('top_k', String(Number(topK)));
  if (Number.isFinite(Number(topP))) form.append('top_p', String(Number(topP)));
  if (Number.isFinite(Number(repetitionPenalty))) form.append('repetition_penalty', String(Number(repetitionPenalty)));
  if (Number.isFinite(Number(splitChars))) form.append('split_chars', String(Number(splitChars)));
  if (Number.isFinite(Number(maxNewTokens))) form.append('max_new_tokens', String(Number(maxNewTokens)));

  const response = await fetchWithBusyRetry(`${base}/v1/audio/speech`, {
    method: 'POST',
    headers: headersFor(config),
    body: form,
    signal: timeoutSignal(timeoutMs),
  });
  if (!response.ok) throw await toError(response);
  const pcm = Buffer.from(await response.arrayBuffer());
  if (pcm.length === 0) throw new BreezeError('breeze returned an empty PCM body', { code: 'empty' });
  const sampleRate = Number(response.headers.get('x-sample-rate') || 24000) || 24000;
  if (container === 'pcm') {
    return {
      buffer: pcm,
      format: 'pcm',
      sampleRate,
      durationSec: pcmDuration(pcm, sampleRate),
      contentType: 'audio/pcm',
      ms: Date.now() - started,
    };
  }
  const wav = pcmToWav(pcm, { sampleRate });
  return {
    buffer: wav,
    format: 'wav',
    sampleRate,
    durationSec: wavInfo(wav).durationSec,
    contentType: 'audio/wav',
    ms: Date.now() - started,
  };
}

/** Retry only the documented "every slot is taken" answer, with a short backoff. */
async function fetchWithBusyRetry(url, init, { attempts = 4 } = {}) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    let response;
    try {
      response = await fetch(url, init);
    } catch (error) {
      throw new BreezeError(`request to ${url} failed — ${describeFetchError(error)}`, { code: 'unreachable' });
    }
    if (response.status !== 409 || attempt === attempts - 1) return response;
    try {
      await response.arrayBuffer();
    } catch {
      // drain best effort
    }
    lastError = attempt;
    await new Promise((resolve) => setTimeout(resolve, 800 * (attempt + 1)));
  }
  return lastError;
}

// ---------------------------------------------------------------- voice library

/** `POST /v1/voices` 鈥?save a reference clip as a reusable voice. */
export async function saveVoice(config, { audio, filename = 'reference.wav', type = 'audio/wav', name, refText, description = '', metadata = null, timeoutMs = 120000 }) {
  if (!audio || !Buffer.isBuffer(audio) || audio.length === 0) throw new BreezeError('a reference audio buffer is required', { code: 'invalid' });
  const voiceName = String(name || '').trim();
  if (!voiceName) throw new BreezeError('name is required to save a voice', { code: 'invalid' });
  if (!String(refText || '').trim()) throw new BreezeError('ref_text (the exact transcript of the clip) is required', { code: 'invalid' });

  const form = new FormData();
  form.append('ref_audio', new Blob([audio], { type }), filename);
  form.append('ref_text', String(refText));
  form.append('name', voiceName);
  if (description) form.append('description', String(description));
  if (metadata && typeof metadata === 'object') form.append('metadata', JSON.stringify(metadata));

  const response = await fetch(`${trimBase(config.baseUrl)}/v1/voices`, {
    method: 'POST',
    headers: headersFor(config),
    body: form,
    signal: timeoutSignal(timeoutMs || config.timeoutMs),
  });
  if (!response.ok) throw await toError(response);
  const body = await response.json().catch(() => ({}));
  return { id: String(body.id ?? voiceName), raw: body };
}

/** `DELETE /v1/voices/<id>` 鈥?drop a voice from memory (the .breeze file stays). */
export async function deleteVoice(config, id, { timeoutMs = 20000 } = {}) {
  const voiceId = String(id || '').trim();
  if (!voiceId) throw new BreezeError('voice id is required', { code: 'invalid' });
  const response = await fetch(`${trimBase(config.baseUrl)}/v1/voices/${encodeURIComponent(voiceId)}`, {
    method: 'DELETE',
    headers: headersFor(config),
    signal: timeoutSignal(timeoutMs),
  });
  if (!response.ok) throw await toError(response);
  return response.json().catch(() => ({ deleted: voiceId }));
}

/** `PATCH /v1/voices/<id>` 鈥?change description or metadata fields. */
export async function patchVoice(config, id, { description, metadata, timeoutMs = 20000 } = {}) {
  const voiceId = String(id || '').trim();
  if (!voiceId) throw new BreezeError('voice id is required', { code: 'invalid' });
  const body = {};
  if (description !== undefined) body.description = description;
  if (metadata !== undefined) body.metadata = metadata;
  const response = await fetch(`${trimBase(config.baseUrl)}/v1/voices/${encodeURIComponent(voiceId)}`, {
    method: 'PATCH',
    headers: headersFor(config, { 'Content-Type': 'application/json' }),
    body: JSON.stringify(body),
    signal: timeoutSignal(timeoutMs),
  });
  if (!response.ok) throw await toError(response);
  return response.json().catch(() => ({}));
}

// ---------------------------------------------------------------- conversion

/**
 * `POST /v1/audio/convert` 鈥?respeak an existing recording in another voice.
 * Experimental upstream; returns one PCM body (not streamed).
 */
export async function convert(config, { source, filename = 'source.wav', type = 'audio/wav', text = '', voice = '', refAudio = null, refText = '', temperature, topK, cfgScale, keepAcoustic, seed, timeoutMs }) {
  if (!source || !Buffer.isBuffer(source) || source.length === 0) throw new BreezeError('a source recording is required', { code: 'invalid' });
  const spoken = String(voice || '').trim();
  if (!spoken && !(refAudio && refAudio.buffer)) {
    throw new BreezeError('either a target voice_id or a reference clip is required', { code: 'invalid' });
  }
  const form = new FormData();
  form.append('source', new Blob([source], { type }), filename);
  if (spoken) form.append('voice_id', spoken);
  if (refAudio && refAudio.buffer) {
    form.append('ref_audio', new Blob([refAudio.buffer], { type: refAudio.type || 'audio/wav' }), refAudio.filename || 'reference.wav');
    if (!String(refText || '').trim()) throw new BreezeError('ref_text is required with a reference clip', { code: 'invalid' });
    form.append('ref_text', String(refText));
  }
  if (text) form.append('text', String(text));
  if (Number.isFinite(Number(temperature))) form.append('temperature', String(Number(temperature)));
  if (Number.isFinite(Number(topK))) form.append('top_k', String(Number(topK)));
  if (Number.isFinite(Number(cfgScale))) form.append('cfg_scale', String(Number(cfgScale)));
  if (Number.isFinite(Number(keepAcoustic))) form.append('keep_acoustic', String(Number(keepAcoustic)));
  if (Number.isFinite(Number(seed))) form.append('seed', String(Number(seed)));

  const started = Date.now();
  const response = await fetchWithBusyRetry(`${trimBase(config.baseUrl)}/v1/audio/convert`, {
    method: 'POST',
    headers: headersFor(config),
    body: form,
    signal: timeoutSignal(timeoutMs),
  });
  if (!response.ok) throw await toError(response);
  const pcm = Buffer.from(await response.arrayBuffer());
  const sampleRate = Number(response.headers.get('x-sample-rate') || 24000) || 24000;
  return {
    buffer: pcmToWav(pcm, { sampleRate }),
    sampleRate,
    durationSec: pcmDuration(pcm, sampleRate),
    ms: Date.now() - started,
  };
}
