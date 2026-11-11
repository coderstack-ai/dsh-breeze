// dsh-breeze — self-test.
//
// Three layers, because "it looks right" is not a verdict:
//   1. static  — every module parses, every tool definition fits the registry's
//                supported JSON-Schema subset and declares what register() requires
//   2. wiring  — apply() runs against a stub ctx and registers every tool
//   3. live    — against a real breeze-server: /health, /v1/voices, one short
//                synthesis, then the WAV we wrote is parsed back and checked
//
// Usage:
//   node tools/selftest.mjs                     # static + wiring only
//   node tools/selftest.mjs --live              # plus a real synthesis
//   DSH_BREEZE_BASE=... DSH_BREEZE_TOKEN=... node tools/selftest.mjs --live
//
// The live layer writes its settings into a throwaway DSH_BREEZE_HOME so it
// never touches the real config, and it leaves one audio file behind on purpose:
// that file is the evidence.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

let failures = 0;
let checks = 0;

function ok(label, detail = '') {
  checks += 1;
  console.log(`  PASS  ${label}${detail ? ` — ${detail}` : ''}`);
}

function bad(label, detail = '') {
  checks += 1;
  failures += 1;
  console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
}

function expect(condition, label, detail = '') {
  if (condition) ok(label, detail);
  else bad(label, detail);
}

// ---------------------------------------------------------------- 1. static

console.log('\n[1/3] static');

const modules = ['index.mjs', 'tools.mjs', 'routes.mjs', 'config.mjs', 'breeze-client.mjs', 'wav.mjs', 'output.mjs', 'server-manager.mjs', 'ws.mjs', 'ws-probe.mjs', 'speech-ws.mjs'];
for (const file of modules) {
  const full = path.join(ROOT, 'lib', file);
  try {
    execFileSync(process.execPath, ['--check', full], { stdio: 'pipe' });
    ok(`parse lib/${file}`);
  } catch (error) {
    bad(`parse lib/${file}`, String(error.stderr || error.message).split('\n')[0]);
  }
}

// The registry accepts exactly this subset of keywords; anything else is a load
// failure at register() time, not at call time, so check it here.
const CONSTRAINTS = new Set(['type', 'oneOf', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const']);
const ANNOTATIONS = new Set(['description', 'title']);

function checkSchema(node, at, out) {
  if (!node || typeof node !== 'object' || Array.isArray(node)) {
    out.push(`${at} must be a schema object`);
    return;
  }
  for (const key of Object.keys(node)) {
    if (CONSTRAINTS.has(key) || ANNOTATIONS.has(key)) continue;
    out.push(`${at}.${key} is not in the supported subset`);
  }
  if (node.description !== undefined && typeof node.description !== 'string') out.push(`${at}.description must be a string`);
  if (node.type === 'object' && node.properties) {
    for (const [key, child] of Object.entries(node.properties)) checkSchema(child, `${at}.properties.${key}`, out);
  }
  if (node.type === 'array' && node.items) checkSchema(node.items, `${at}.items`, out);
  if (Array.isArray(node.oneOf)) node.oneOf.forEach((child, index) => checkSchema(child, `${at}.oneOf[${index}]`, out));
  if (node.required !== undefined && (!Array.isArray(node.required) || node.required.some((v) => typeof v !== 'string'))) {
    out.push(`${at}.required must be an array of strings`);
  }
  if (node.enum !== undefined && !Array.isArray(node.enum)) out.push(`${at}.enum must be an array`);
}

const { TOOLS } = await import(new URL('../lib/tools.mjs', import.meta.url));

expect(Array.isArray(TOOLS) && TOOLS.length > 0, 'tools.mjs exports a non-empty TOOLS list', `${TOOLS.length} tools`);
const seen = new Set();
for (const tool of TOOLS) {
  const label = `tool ${tool.name}`;
  const problems = [];
  if (!tool.name || typeof tool.name !== 'string') problems.push('name missing');
  if (!tool.description || typeof tool.description !== 'string') problems.push('description missing');
  if (seen.has(tool.name)) problems.push('duplicate tool name');
  seen.add(tool.name);
  const params = tool.parameters;
  if (!params || params.type !== 'object') problems.push('parameters must be an object-rooted schema');
  if (tool.output === undefined || typeof tool.output.render !== 'function') problems.push('output.render missing');
  checkSchema(params, 'parameters', problems);
  checkSchema(tool.output.schema, 'output.schema', problems);
  if (params && Array.isArray(params.required)) {
    for (const key of params.required) {
      if (!params.properties || !params.properties[key]) problems.push(`required "${key}" is not declared in properties`);
    }
  }
  if (tool.presentCall !== undefined && typeof tool.presentCall !== 'function') problems.push('presentCall must be a function');
  if (problems.length) bad(label, problems.join('; '));
  else ok(label, `${Object.keys(params.properties || {}).length} params`);
}

// config defaults must all be writable-or-known, and every writable key must exist
const { DEFAULTS, WRITABLE } = await import(new URL('../lib/config.mjs', import.meta.url));
for (const key of WRITABLE) expect(Object.prototype.hasOwnProperty.call(DEFAULTS, key), `config key "${key}" has a default`);

// ---------------------------------------------------------------- 2. wiring

console.log('\n[2/3] wiring');

const tmpHome = path.join(os.tmpdir(), `dsh-breeze-selftest-${process.pid}`);
fs.rmSync(tmpHome, { recursive: true, force: true });
fs.mkdirSync(tmpHome, { recursive: true });
process.env.DSH_BREEZE_HOME = tmpHome;

const liveBase = process.env.DSH_BREEZE_BASE || process.env.BREEZE_URL || '';
const liveToken = process.env.DSH_BREEZE_TOKEN || process.env.BREEZE_TOKEN || '';
const cfgFile = path.join(tmpHome, 'config.json');
fs.writeFileSync(cfgFile, JSON.stringify({
  baseUrl: liveBase || 'http://127.0.0.1:8080',
  token: liveToken,
  format: 'wav',
}, null, 2));

const plugin = await import(new URL('../lib/index.mjs', import.meta.url));
expect(plugin.name === 'dsh-breeze', 'entry exports name', plugin.name);
expect(Array.isArray(plugin.inject) && plugin.inject.includes('tools'), 'entry injects tools', JSON.stringify(plugin.inject));

const registered = [];
const routes = [];
const stubCtx = {
  tools: { register: (definition) => { registered.push(definition); return () => {}; } },
  get: (service) => (service === 'webServer'
    ? { register: (route) => { routes.push(route); return () => {}; } }
    : undefined),
  effect: (fn) => { fn(); },
  logger: { info: () => {}, warn: (m) => console.log(`  warn  ${m}`) },
};

let applyThrew = null;
try {
  plugin.apply(stubCtx);
} catch (error) {
  applyThrew = error;
}
expect(!applyThrew, 'apply() completes against a stub ctx', applyThrew ? String(applyThrew.message) : '');
expect(registered.length === TOOLS.length, 'every tool reaches the registry', `${registered.length}/${TOOLS.length}`);
expect(routes.length === 1, 'exactly one route registered', `${routes.length}`);
if (routes[0]) {
  expect(routes[0].kind === 'prefix', 'route kind is prefix', routes[0].kind);
  expect(routes[0].path === '/dsh-breeze-api', 'route path', routes[0].path);
  expect(typeof routes[0].handler === 'function', 'route has a handler');
}

// config store round trip
const { writeConfig, readConfig } = await import(new URL('../lib/config.mjs', import.meta.url));
const wrote = writeConfig({ voice: 'selftest-voice', cfgScale: 2.5 });
expect(wrote.applied.voice === 'selftest-voice', 'writeConfig applies voice', wrote.applied.voice);
expect(wrote.applied.cfgScale === 2.5, 'writeConfig applies cfgScale', String(wrote.applied.cfgScale));
const reread = readConfig();
expect(reread.voice === 'selftest-voice', 'readConfig sees the write without a restart');
expect(reread.format === 'wav', 'writeConfig preserves untouched fields', reread.format);
let rejected = false;
try {
  writeConfig({ format: 'flac' });
} catch {
  rejected = true;
}
expect(rejected, 'writeConfig rejects an unsupported format');
expect(Array.isArray(wrote.ignored), 'writeConfig reports ignored fields');

// wav round trip: build, corrupt the sizes the way the server streams them, repair
const { pcmToWav, fixWav, wavInfo } = await import(new URL('../lib/wav.mjs', import.meta.url));
const frames = 24000; // one second at 24 kHz mono s16
const pcm = Buffer.alloc(frames * 2);
for (let i = 0; i < frames; i += 1) pcm.writeInt16LE(Math.round(Math.sin((i / 24000) * 2 * Math.PI * 440) * 8000), i * 2);
const wav = pcmToWav(pcm, { sampleRate: 24000 });
const info = wavInfo(wav);
expect(info.valid === true, 'pcmToWav writes a parseable WAV');
expect(Math.abs(info.durationSec - 1) < 0.01, 'duration of 1 s of PCM', `${info.durationSec}s`);
expect(wav.length === 44 + pcm.length, 'header is exactly 44 bytes', `${wav.length} bytes`);
const streamed = Buffer.from(wav);
streamed.writeUInt32LE(0xffffffff, 4);
streamed.writeUInt32LE(0xffffffff, 40);
const repaired = fixWav(streamed);
expect(repaired.readUInt32LE(4) === repaired.length - 8, 'fixWav repairs the RIFF size', `${repaired.readUInt32LE(4)}`);
expect(repaired.readUInt32LE(40) === pcm.length, 'fixWav repairs the data size', `${repaired.readUInt32LE(40)}`);
expect(wavInfo(repaired).durationSec > 0.99, 'repaired WAV still parses');

// ---------------------------------------------------------------- 3. live

console.log('\n[3/3] live');
const live = process.argv.includes('--live');
if (!live) {
  console.log('  SKIP  live layer (pass --live, and DSH_BREEZE_BASE / DSH_BREEZE_TOKEN as needed)');
} else {
  const client = await import(new URL('../lib/breeze-client.mjs', import.meta.url));
  const liveConfig = readConfig();
  console.log(`  info  endpoint ${liveConfig.baseUrl}${liveConfig.token ? ' (bearer)' : ''}`);

  try {
    const health = await client.health(liveConfig);
    ok('GET /health', `${health.sampleRate} Hz, ws ${health.wsPort || 'disabled'}, ${health.ms} ms`);
    let voices = [];
    try {
      voices = await client.listVoices(liveConfig);
      ok('GET /v1/voices', `${voices.length} voice(s)${voices.length ? `: ${voices.map((v) => v.id).join(', ')}` : ''}`);
    } catch (error) {
      bad('GET /v1/voices', String(error.message || error));
    }
    const voice = voices.length ? voices[0].id : '';
    const said = 'Breeze TTS 插件自检：这句话是从服务端真实生成的。';
    const started = Date.now();
    const speech = await client.speak(liveConfig, {
      text: said,
      voice,
      instruction: 'A calm young woman with a clear delivery.',
      cfgScale: 1,
      seed: 42,
      format: 'wav',
      timeoutMs: 180000,
    });
    ok('POST /v1/audio/speech', `${speech.durationSec}s, ${speech.buffer.length} bytes, ${Date.now() - started} ms wall`);
    const parsed = wavInfo(speech.buffer);
    expect(parsed.valid === true, 'returned audio is a valid WAV');
    expect(parsed.sampleRate === 24000, 'sample rate is 24 kHz', `${parsed.sampleRate}`);
    expect(parsed.channels === 1, 'mono', `${parsed.channels}`);
    expect(parsed.durationSec > 0.5, 'audio is non-trivial', `${parsed.durationSec}s`);
    expect(speech.buffer.readUInt32LE(4) === speech.buffer.length - 8, 'RIFF size matches the payload', `${speech.buffer.readUInt32LE(4)} vs ${speech.buffer.length - 8}`);

    const { writeAudio } = await import(new URL('../lib/output.mjs', import.meta.url));
    const written = writeAudio(liveConfig, speech.buffer, { ext: 'wav', text: said });
    ok('audio written', written.path);
    console.log(`  info  play it: ${written.path}`);

    const header = speech.buffer.subarray(0, 44).toString('hex');
    console.log(`  info  wav header ${header}`);
  } catch (error) {
    bad('live synthesis', String(error && error.stack ? error.stack.split('\n')[0] : error));
  }
}

// ---------------------------------------------------------------- verdict

console.log(`\n${failures === 0 ? 'OK' : 'FAILED'} — ${checks - failures}/${checks} checks passed`);
if (live) console.log(`state dir used by this run: ${tmpHome}`);
process.exit(failures === 0 ? 0 : 1);
