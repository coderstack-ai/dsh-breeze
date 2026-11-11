// dsh-breeze — a probe that reports the WebSocket endpoint's real state.
//
// Kept apart from `resolveWsEndpoint`'s cache on purpose: this answers "what is
// true right now" for the settings panel, while the speech path wants the cheap
// cached answer. Short per-candidate timeout so a dead port does not make the
// whole panel feel stuck.

import { resolveWsEndpoint, wsCandidates } from './ws.mjs';

/**
 * @param {object} config
 * @param {{ wsPort?: number }} health
 * @param {{ timeoutMs?: number, signal?: AbortSignal }} [options]
 * @returns {Promise<{ reachable: boolean, url: string, source: string, candidates: string[], error: string, attempts: Array<{url:string,source:string,error:string}>, ms: number }>}
 */
export async function probeWs(config, health = {}, { timeoutMs = 2000, signal } = {}) {
  const started = Date.now();
  const candidates = wsCandidates(config, health).map((candidate) => candidate.url);
  try {
    const resolved = await resolveWsEndpoint(config, health, { timeoutMs, noCache: true, signal });
    return {
      reachable: true,
      url: resolved.url,
      source: resolved.source,
      candidates,
      error: '',
      attempts: resolved.attempts,
      ms: Date.now() - started,
    };
  } catch (error) {
    const message = String(error && error.message ? error.message : error);
    return {
      reachable: false,
      url: '',
      source: '',
      candidates,
      error: message,
      attempts: [],
      ms: Date.now() - started,
    };
  }
}

/** One-line summary of a multi-line probe error, for a status row. */
export function summariseWsError(error, limit = 160) {
  const flat = String(error || '').replace(/\s*\n\s*/g, ' ').replace(/\s+/g, ' ').trim();
  if (flat.length <= limit) return flat;
  return `${flat.slice(0, limit - 1)}…`;
}
