// dsh-breeze — speech over Breeze's WebSocket listener.
//
// Why this exists next to the HTTP path:
//   * every generation slot being taken is a `409` over HTTP, but a queued
//     `queued` notice over the socket — the socket waits its turn instead of
//     refusing
//   * one session encodes the reference voice once, so a long piece does not pay
//     that cost per split
//   * first audio arrives while the rest of the text is still being generated
//
// The endpoint resolution (and its "original shape first" rule) lives in ws.mjs.

import * as breeze from './breeze-client.mjs';
import { openSocket, resolveWsEndpoint, waitForReady } from './ws.mjs';

/**
 * Synthesize one text over the socket and return the same shape the HTTP path
 * returns, so callers do not care which transport ran.
 *
 * @returns {Promise<{ pcm: Buffer, sampleRate: number, wsUrl: string, wsSource: string, ms: number, notes: string[] }>}
 */
export async function speakWs(config, options) {
  const {
    text,
    voice = '',
    instruction = '',
    cfgScale,
    seed,
    temperature,
    topK,
    splitChars,
    timeoutMs,
  } = options;

  if (!text || !String(text).trim()) throw new Error('text is required');
  const budget = Math.max(5000, Number(timeoutMs) || 180000);
  const started = Date.now();
  const notes = [];

  // The listener's port is only advertised by /health, so ask first; a failure
  // here is not fatal (wsUrl or the proxy path may still work).
  let healthInfo = {};
  try {
    healthInfo = await breeze.health(config, { timeoutMs: 8000 });
  } catch (error) {
    notes.push(`health probe failed (${error && error.message ? error.message : error}); continuing without ws_port`);
  }

  const endpoint = await resolveWsEndpoint(config, healthInfo, { timeoutMs: 5000 });
  if (endpoint.cached) notes.push(`endpoint cached from an earlier call (${endpoint.source})`);

  const socket = await openSocket(endpoint.url, { token: config.token, timeoutMs: 8000 });
  let sampleRate = 24000;
  try {
    const ready = await waitForReady(socket, 8000);
    sampleRate = ready.sampleRate;
  } catch (error) {
    socket.close();
    throw error;
  }

  return await new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      socket.close();
      reject(new Error(`WebSocket synthesis timed out after ${budget} ms (${bytes} PCM bytes received)`));
    }, budget);

    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.onText = null;
      socket.onBinary = null;
      socket.onClose = null;
      try { socket.close(); } catch { /* already closed */ }
      if (error) {
        reject(error);
        return;
      }
      if (bytes === 0) {
        reject(new Error('the socket finished without sending any audio (check voice id and text)'));
        return;
      }
      resolve({
        pcm: Buffer.concat(chunks, bytes),
        sampleRate,
        wsUrl: endpoint.url,
        wsSource: endpoint.source,
        ms: Date.now() - started,
        notes,
      });
    };

    socket.onBinary = (payload) => {
      chunks.push(payload);
      bytes += payload.length;
    };

    socket.onText = (message) => {
      if (!message || typeof message !== 'object') return;
      if (message.type === 'done') return finish(null);
      if (message.type === 'cancelled') return finish(new Error('the server cancelled the session'));
      if (message.type === 'error') return finish(new Error(`breeze: ${message.message || 'unspecified socket error'}`));
      if (message.type === 'queued') notes.push('every generation slot was taken; the socket queued instead of refusing');
      if (message.type === 'speaking' && message.text) notes.push(`spoke: ${String(message.text).slice(0, 80)}`);
    };

    socket.onClose = (error) => {
      finish(error ? new Error(`socket closed early: ${error.message}`) : new Error('socket closed before `done`'));
    };

    // `start` opens the session (and encodes the reference once); `text` then
    // adds the whole piece, and `end` flushes and asks for `done`.
    socket.send({
      type: 'start',
      ...(String(voice || '').trim() ? { voice_id: String(voice).trim() } : {}),
      ...(String(instruction || '').trim() ? { instruction: String(instruction).trim() } : {}),
      ...(Number.isFinite(Number(cfgScale)) ? { cfg_scale: Number(cfgScale) } : {}),
      ...(Number.isFinite(Number(seed)) ? { seed: Number(seed) } : {}),
      ...(Number.isFinite(Number(temperature)) ? { temperature: Number(temperature) } : {}),
      ...(Number.isFinite(Number(topK)) ? { top_k: Number(topK) } : {}),
      ...(Number.isFinite(Number(splitChars)) ? { split_chars: Number(splitChars) } : {}),
    });
    socket.send({ type: 'text', text: String(text) });
    socket.send({ type: 'end' });
  });
}
