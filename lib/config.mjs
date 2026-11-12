// dsh-breeze — host-side settings store.
//
// One source of truth on disk, shared by the agent (via the breeze_* tools)
// and by anything else that reads the same file. Nothing is cached in memory,
// so a write from either side is visible on the very next read.
//
// Location: <home>/.dsh/dsh-breeze/config.json
// Overrides: DSH_BREEZE_HOME (directory) or DSH_BREEZE_CFG (exact file).
// The override exists because a DSH started as SYSTEM sees a different home
// than the person editing the file: they would fix the config in the right
// place and the service would read a different one.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Every field the plugin understands, with its out-of-the-box value. */
export const DEFAULTS = Object.freeze({
  version: 1,
  /** Breeze server origin, no trailing slash. */
  baseUrl: 'http://127.0.0.1:8080',
  /** Optional bearer token; a reverse proxy in front of breeze-server may need one. */
  token: '',
  /** Default output container: wav | mp3 | pcm. */
  format: 'wav',
  /** Default voice id (a saved voice, e.g. "female_001"). Empty means voice design. */
  voice: '',
  /** Default voice description / delivery direction. */
  instruction: 'Speak clearly and naturally.',
  /** Classifier-free guidance. 1 = off; 2..3 makes vocal event tags actually fire. */
  cfgScale: 1,
  /** RNG seed. */
  seed: 42,
  /** Speech request timeout in milliseconds. */
  timeoutMs: 180000,
  /** Where generated audio lands. Empty means <state>/audio. */
  outputDir: '',
  /** Start a local breeze-server on demand when the endpoint is unreachable. */
  autostart: false,
  /** Command used for autostart, e.g. C:\\breeze\\breeze-server.exe */
  serverCommand: '',
  /** Arguments for serverCommand, e.g. ["model.gguf", "--port", "8080"] */
  serverArgs: [],
  /** Working directory for serverCommand. */
  serverCwd: '',
  /** How long autostart waits for /health to answer, in milliseconds. */
  startupTimeoutMs: 180000,
});

/** Fields a caller may write. Anything else is ignored rather than stored. */
export const WRITABLE = Object.freeze([
  'baseUrl',
  'token',
  'format',
  'voice',
  'instruction',
  'cfgScale',
  'seed',
  'timeoutMs',
  'outputDir',
  'autostart',
  'serverCommand',
  'serverArgs',
  'serverCwd',
  'startupTimeoutMs',
]);

/** State directory for this plugin. */
export function stateHome() {
  const override = process.env.DSH_BREEZE_HOME;
  if (override && override.trim()) return path.resolve(override.trim());
  return path.join(os.homedir(), '.dsh', 'dsh-breeze');
}

/** Absolute path of the settings file actually in use. */
export function configPath() {
  const override = process.env.DSH_BREEZE_CFG;
  if (override && override.trim()) return path.resolve(override.trim());
  return path.join(stateHome(), 'config.json');
}

/** Absolute directory generated audio is written to. */
export function audioDir(config) {
  const dir = config && config.outputDir ? String(config.outputDir) : '';
  return dir.trim() ? path.resolve(dir.trim()) : path.join(stateHome(), 'audio');
}

/** Coerce one field to its declared type; throws on input we would silently mangle. */
function coerce(key, value) {
  switch (key) {
    case 'baseUrl': {
      const raw = String(value ?? '').trim();
      if (!raw) throw new Error('baseUrl must not be empty');
      const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`;
      const url = new URL(withScheme);
      if (!/^https?:$/.test(url.protocol)) throw new Error(`baseUrl must be http(s), got ${url.protocol}`);
      return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
    }
    case 'token':
    case 'voice':
    case 'instruction':
    case 'outputDir':
    case 'serverCommand':
    case 'serverCwd':
      return value == null ? '' : String(value);
    case 'format': {
      const f = String(value ?? '').toLowerCase().trim();
      if (!['wav', 'mp3', 'pcm'].includes(f)) throw new Error(`format must be wav, mp3 or pcm (got ${JSON.stringify(value)})`);
      return f;
    }
    case 'cfgScale': {
      const n = Number(value);
      if (!Number.isFinite(n) || n < 1 || n > 10) throw new Error(`cfgScale must be a number in 1..10 (got ${JSON.stringify(value)})`);
      return n;
    }
    case 'seed': {
      const n = Number(value);
      if (!Number.isInteger(n) || n < 0) throw new Error(`seed must be a non-negative integer (got ${JSON.stringify(value)})`);
      return n;
    }
    case 'timeoutMs':
    case 'startupTimeoutMs': {
      const n = Number(value);
      if (!Number.isFinite(n) || n < 1000) throw new Error(`${key} must be a number of milliseconds >= 1000 (got ${JSON.stringify(value)})`);
      return Math.round(n);
    }
    case 'autostart':
      return value === true || value === 'true' || value === 1 || value === '1';
    case 'serverArgs': {
      if (value == null) return [];
      const list = Array.isArray(value) ? value : [value];
      return list.map((v) => String(v));
    }
    default:
      return value;
  }
}

/** Merge a persisted object over the defaults, coercing each known key. */
function normalize(raw) {
  const out = { ...DEFAULTS };
  if (!raw || typeof raw !== 'object') return out;
  for (const key of Object.keys(DEFAULTS)) {
    if (key === 'version') continue;
    if (!Object.prototype.hasOwnProperty.call(raw, key)) continue;
    try {
      out[key] = coerce(key, raw[key]);
    } catch {
      // A hand-edited file with one bad value must not take the whole plugin
      // down: keep the default for that field and let the caller see why.
      out[`${key}Invalid`] = raw[key];
    }
  }
  out.version = DEFAULTS.version;
  return out;
}

/** Read the settings file, falling back to defaults when it is absent or broken. */
export function readConfig() {
  const file = configPath();
  let raw = null;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    const missing = error && (error.code === 'ENOENT' || error.code === 'ENOTDIR');
    return { ...normalize(null), file, exists: false, ...(missing ? {} : { readError: String(error && error.message ? error.message : error) }) };
  }
  return { ...normalize(raw), file, exists: true };
}

/**
 * Write settings: read the file as it is on disk, overwrite only the keys the
 * caller names, and replace the file atomically. Reading first means a field
 * somebody else added by hand is never dropped by our write.
 */
export function writeConfig(patch) {
  if (!patch || typeof patch !== 'object') throw new Error('writeConfig expects an object of fields');
  const file = configPath();
  let disk = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) disk = parsed;
  } catch {
    disk = {};
  }
  const applied = {};
  const ignored = [];
  for (const [key, value] of Object.entries(patch)) {
    if (!WRITABLE.includes(key)) {
      ignored.push(key);
      continue;
    }
    if (value === undefined) continue;
    if (value === null || value === '') {
      // "clear this field" means: fall back to the default, not store "".
      applied[key] = DEFAULTS[key];
      continue;
    }
    applied[key] = coerce(key, value);
  }
  const next = { ...disk, ...applied, version: DEFAULTS.version };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
  return { applied, ignored, config: normalize(next), file };
}

/** A compact, secret-free description of the current endpoint for tool output. */
export function describeEndpoint(config) {
  return {
    baseUrl: config.baseUrl,
    auth: config.token ? 'bearer' : 'none',
    outputDir: audioDir(config),
    file: configPath(),
  };
}
