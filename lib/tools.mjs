// dsh-breeze — the model-facing tools.
//
// Each entry is a registry-ready definition: JSON Schema parameters (the
// supported subset), a declared output schema, a pure render for the transcript,
// and an execute body. Nothing here imports a DSH package: the plugin only talks
// to ctx services, which keeps it loadable from a linked directory.

import fs from 'node:fs';
import path from 'node:path';

import * as breeze from './breeze-client.mjs';
import { DEFAULTS, audioDir, configPath, describeEndpoint, readConfig, stateHome, writeConfig } from './config.mjs';
import { assertReadableFile, writeAudio } from './output.mjs';
import { ensureServer, probe } from './server-manager.mjs';
import { pcmToWav, pcmDuration } from './wav.mjs';

const text = (value) => [{ type: 'text', text: value }];

function fail(error) {
  const message = error && error.message ? error.message : String(error);
  throw new Error(message);
}

/** Resolve an agent-supplied path against cwd, then the plugin state directory. */
function resolveInput(file) {
  const raw = String(file || '').trim();
  if (!raw) throw new Error('a file path is required');
  if (path.isAbsolute(raw)) return assertReadableFile(raw);
  const fromCwd = path.resolve(process.cwd(), raw);
  try {
    return assertReadableFile(fromCwd);
  } catch {
    return assertReadableFile(path.resolve(stateHome(), raw));
  }
}

function readAudioInput(file) {
  const resolved = resolveInput(file);
  const ext = path.extname(resolved.path).toLowerCase();
  const type = ext === '.mp3' ? 'audio/mpeg' : ext === '.pcm' ? 'audio/pcm' : 'audio/wav';
  return { buffer: fs.readFileSync(resolved.path), filename: path.basename(resolved.path), type, path: resolved.path, bytes: resolved.size };
}

function numberOrUndefined(value) {
  if (value === undefined || value === null || value === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

/** Retry once through a configured local autostart when the endpoint was down. */
async function withServerRetry(config, signal, run) {
  try {
    return await run();
  } catch (error) {
    const unreachable = error instanceof breeze.BreezeError && (error.code === 'unreachable' || error.status === 0);
    if (!unreachable || !config.autostart) throw error;
    const started = await ensureServer(config, { signal });
    if (!started.reachable) throw error;
    return run();
  }
}

function renderSpeech(args, value) {
  const bits = [
    `Spoke ${value.durationSec ? `${value.durationSec}s` : 'a clip'} at ${value.sampleRate} Hz.`,
    `File: ${value.path}`,
    `Voice: ${value.voice || '(designed from the instruction)'}`,
  ];
  if (value.instruction) bits.push(`Direction: ${value.instruction}`);
  bits.push(`Format: ${value.format} · ${value.bytes} bytes · ${value.ms} ms`);
  if (value.note) bits.push(value.note);
  return text(bits.join('\n'));
}

// ---------------------------------------------------------------- definitions

export const speakTool = {
  name: 'breeze_speak',
  description:
    'Turn text into speech with a Breeze-TTS-2 server and write it to an audio file. '
    + 'Use it to actually say something out loud, to produce narration or dialogue audio, or to render a voice design. '
    + 'Vocal event tags in round brackets are honoured, e.g. "(sigh) We need to talk." — but they generally only fire at cfgScale 2 to 3, '
    + 'and the tag vocabulary is free form, so (whispering) or (nervous chuckle) often work. '
    + 'Cloning needs both a reference clip (refAudioPath) and its exact transcript (refText); with a saved voice id just pass voice. '
    + 'The returned path can be handed to the present tool so the person can play it.',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      text: { type: 'string', description: 'Text to speak, UTF-8. Vocal event tags in round brackets are allowed.' },
      voice: { type: 'string', description: 'A saved or cached voice id (see breeze_voices). omit to design a voice from `instruction`.' },
      instruction: { type: 'string', description: 'Voice description when designing, delivery direction when cloning. Match this language to the spoken text.' },
      format: { type: 'string', enum: ['wav', 'mp3', 'pcm'], description: 'Output container. wav (default) is a strict 24 kHz mono 16-bit file; mp3 is 80 kbps mono 48 kHz; pcm is headerless s16le.' },
      cfgScale: { type: 'number', description: 'Classifier-free guidance. 1 (default) is off; 2 to 3 makes vocal events fire and pushes harder toward the instruction. Above 3 turns harsh.' },
      seed: { type: 'number', description: 'RNG seed (default 42). The same text, voice, instruction and seed reproduce the same audio.' },
      refAudioPath: { type: 'string', description: 'Absolute or workspace-relative path to a reference clip for cloning. Requires refText.' },
      refText: { type: 'string', description: 'Exact transcript of refAudioPath. Required whenever refAudioPath is given.' },
      temperature: { type: 'number', description: 'Sampling temperature; 0 keeps the model default.' },
      topK: { type: 'number', description: 'Sampling top-k; 0 keeps the model default.' },
      topP: { type: 'number', description: 'Sampling top-p; 0 keeps the model default.' },
      repetitionPenalty: { type: 'number', description: 'Repetition penalty; 0 keeps the model default.' },
      splitChars: { type: 'number', description: 'Long text is split near this many characters. 0 disables splitting (only for short lines).' },
      maxNewTokens: { type: 'number', description: 'Frame cap per split piece (12.5 frames per second of audio). 0 uses the model default of 750.' },
    },
    required: ['text'],
  },
  output: {
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        path: { type: 'string' },
        bytes: { type: 'number' },
        durationSec: { type: 'number' },
        sampleRate: { type: 'number' },
        format: { type: 'string' },
        voice: { type: 'string' },
        instruction: { type: 'string' },
        cfgScale: { type: 'number' },
        seed: { type: 'number' },
        baseUrl: { type: 'string' },
        ms: { type: 'number' },
        note: { type: 'string' },
      },
      required: ['path', 'bytes', 'format', 'sampleRate', 'baseUrl'],
    },
    render: renderSpeech,
    // The web client turns this into an inline player: same-origin URL, no absolute
    // path, so it can point an <audio> element straight at the file.
    presentationMeta: (args, value) => ({
      kind: 'speech',
      url: `/dsh-breeze-api/audio/${encodeURIComponent(String(value.path || '').split(/[\\/]/).pop() || '')}`,
      durationSec: Number(value.durationSec) || 0,
      bytes: Number(value.bytes) || 0,
      format: String(value.format || ''),
      voice: String(value.voice || ''),
      text: String(args.text || '').slice(0, 200),
    }),
  },
  presentCall(args) {
    return {
      card: 'generic',
      title: 'Breeze: speak',
      kind: 'other',
      rawInput: { text: args.text, voice: args.voice, format: args.format, cfgScale: args.cfgScale },
    };
  },
  async execute(args, exec) {
    const config = readConfig();
    const format = args.format || config.format || 'wav';
    const voice = (args.voice ?? config.voice ?? '').trim();
    const instruction = (args.instruction ?? config.instruction ?? '').trim();
    const resolvedCfgScale = numberOrUndefined(args.cfgScale) ?? Number(config.cfgScale) ?? DEFAULTS.cfgScale;
    const resolvedSeed = numberOrUndefined(args.seed) ?? Number(config.seed) ?? DEFAULTS.seed;

    const refAudio = args.refAudioPath ? readAudioInput(args.refAudioPath) : null;
    if (refAudio && !String(args.refText || '').trim()) throw new Error('refText is required when refAudioPath is given: it must be the exact transcript of the clip');
    try {
      const result = await withServerRetry(config, exec && exec.signal, () => breeze.speak(config, {
        text: args.text,
        voice,
        instruction,
        cfgScale: resolvedCfgScale,
        seed: resolvedSeed,
        format,
        refAudio,
        refText: args.refText || '',
        temperature: numberOrUndefined(args.temperature),
        topK: numberOrUndefined(args.topK),
        topP: numberOrUndefined(args.topP),
        repetitionPenalty: numberOrUndefined(args.repetitionPenalty),
        splitChars: numberOrUndefined(args.splitChars),
        maxNewTokens: numberOrUndefined(args.maxNewTokens),
        timeoutMs: config.timeoutMs,
      }));
      const written = writeAudio(config, result.buffer, { ext: result.format, text: args.text });
      return {
        path: written.path,
        bytes: written.bytes,
        durationSec: result.durationSec,
        sampleRate: result.sampleRate,
        format: result.format,
        voice,
        instruction,
        cfgScale: resolvedCfgScale,
        seed: resolvedSeed,
        baseUrl: config.baseUrl,
        ms: result.ms,
      };
    } catch (error) {
      fail(error);
    }
  },
};

export const voicesTool = {
  name: 'breeze_voices',
  description: 'List the voices the Breeze server knows: saved ones (files) and cached ones (in memory). Each row carries the reference transcript and description, which is what you need to pick a voice for breeze_speak.',
  parameters: { type: 'object', additionalProperties: false, properties: {} },
  output: {
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        baseUrl: { type: 'string' },
        count: { type: 'number' },
        voices: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              id: { type: 'string' },
              seconds: { type: 'number' },
              saved: { type: 'boolean' },
              refText: { type: 'string' },
              description: { type: 'string' },
            },
            required: ['id'],
          },
        },
      },
      required: ['baseUrl', 'count', 'voices'],
    },
    render: (_args, value) => {
      if (value.count === 0) return text(`No voices on ${value.baseUrl}. Pass an instruction to breeze_speak to design one, or save a clip with breeze_voice_save.`);
      const lines = value.voices.map((row) => {
        const parts = [`- ${row.id}`, row.saved ? 'saved' : 'cached'];
        if (row.seconds) parts.push(`${row.seconds}s`);
        if (row.description) parts.push(`"${row.description}"`);
        return parts.join('  ');
      });
      return text(`${value.count} voice(s) on ${value.baseUrl}:\n${lines.join('\n')}`);
    },
  },
  async execute(_args, exec) {
    const config = readConfig();
    try {
      const voices = await withServerRetry(config, exec && exec.signal, () => breeze.listVoices(config));
      return { baseUrl: config.baseUrl, count: voices.length, voices: voices.map((row) => ({ id: row.id, seconds: row.seconds, saved: row.saved, refText: row.refText, description: row.description })) };
    } catch (error) {
      fail(error);
    }
  },
};

export const saveVoiceTool = {
  name: 'breeze_voice_save',
  description:
    'Save a reference clip as a reusable Breeze voice, so later breeze_speak calls only need the voice id. '
    + 'The transcript must be exact: the model conditions on it, and a wrong transcript produces the wrong voice. '
    + 'Names allow letters, digits, dash and underscore, and become filenames on the server.',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      name: { type: 'string', description: 'Voice id to save as, e.g. "narrator". Letters, digits, dash and underscore only.' },
      refAudioPath: { type: 'string', description: 'Path to the reference clip. 24 kHz mono 16-bit WAV encodes best.' },
      refText: { type: 'string', description: 'Exact transcript of the clip.' },
      description: { type: 'string', description: 'Optional one-line description of the voice, for later selection.' },
    },
    required: ['name', 'refAudioPath', 'refText'],
  },
  output: {
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: { type: 'string' },
        baseUrl: { type: 'string' },
        sourcePath: { type: 'string' },
      },
      required: ['id', 'baseUrl'],
    },
    render: (_args, value) => text(`Saved voice "${value.id}" on ${value.baseUrl}. Use it with breeze_speak({ voice: "${value.id}" }).`),
  },
  async execute(args, exec) {
    const config = readConfig();
    const audio = readAudioInput(args.refAudioPath);
    try {
      const saved = await withServerRetry(config, exec && exec.signal, () => breeze.saveVoice(config, {
        audio: audio.buffer,
        filename: audio.filename,
        type: audio.type,
        name: args.name,
        refText: args.refText,
        description: args.description || '',
      }));
      return { id: saved.id, baseUrl: config.baseUrl, sourcePath: audio.path };
    } catch (error) {
      fail(error);
    }
  },
};

export const deleteVoiceTool = {
  name: 'breeze_voice_delete',
  description:
    'Drop a voice from the Breeze server memory. A saved voice keeps its .breeze file on the server and comes back on the next restart, '
    + 'so this is how you unload a voice, not how you delete it permanently.',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: { id: { type: 'string', description: 'Voice id to drop.' } },
    required: ['id'],
  },
  output: {
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: { type: 'string' },
        fileKept: { type: 'boolean' },
        note: { type: 'string' },
      },
      required: ['id'],
    },
    render: (_args, value) => text(`Dropped voice "${value.id}".${value.fileKept ? ' Its .breeze file stays on the server, so it returns on restart.' : ''}`),
  },
  async execute(args, exec) {
    const config = readConfig();
    try {
      const result = await withServerRetry(config, exec && exec.signal, () => breeze.deleteVoice(config, args.id));
      return { id: String(result.deleted || args.id), fileKept: result.file_kept === true, note: result.note ? String(result.note) : '' };
    } catch (error) {
      fail(error);
    }
  },
};

export const convertTool = {
  name: 'breeze_convert',
  description:
    'Respeak an existing recording in another voice (experimental upstream). Timing, phrasing and rhythm survive; only speaker identity changes. '
    + 'Pitch is regenerated rather than copied, so a sung source can land in another register. Runs at roughly realtime.',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      sourcePath: { type: 'string', description: 'Recording to convert.' },
      voice: { type: 'string', description: 'Target voice id. Alternative to refAudioPath.' },
      refAudioPath: { type: 'string', description: 'Target voice clip, used instead of a saved voice id.' },
      refText: { type: 'string', description: 'Exact transcript of refAudioPath.' },
      text: { type: 'string', description: 'Transcript of the source recording. Strongly recommended: it lines the backbone up with the forced codes.' },
      seed: { type: 'number', description: 'RNG seed (default 42).' },
    },
    required: ['sourcePath'],
  },
  output: {
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        path: { type: 'string' },
        bytes: { type: 'number' },
        durationSec: { type: 'number' },
        sampleRate: { type: 'number' },
        voice: { type: 'string' },
        baseUrl: { type: 'string' },
        ms: { type: 'number' },
      },
      required: ['path', 'bytes', 'sampleRate', 'baseUrl'],
    },
    render: (_args, value) => text(`Converted ${value.durationSec ? `${value.durationSec}s` : 'the clip'} into "${value.voice || 'a reference voice'}" at ${value.sampleRate} Hz.\nFile: ${value.path}`),
    presentationMeta: (_args, value) => ({
      kind: 'speech',
      url: `/dsh-breeze-api/audio/${encodeURIComponent(String(value.path || '').split(/[\\/]/).pop() || '')}`,
      durationSec: Number(value.durationSec) || 0,
      bytes: Number(value.bytes) || 0,
      format: 'wav',
      voice: String(value.voice || ''),
      text: 'converted',
    }),
  },
  async execute(args, exec) {
    const config = readConfig();
    const source = readAudioInput(args.sourcePath);
    const refAudio = args.refAudioPath ? readAudioInput(args.refAudioPath) : null;
    try {
      const result = await withServerRetry(config, exec && exec.signal, () => breeze.convert(config, {
        source: source.buffer,
        filename: source.filename,
        type: source.type,
        text: args.text || '',
        voice: args.voice || '',
        refAudio,
        refText: args.refText || '',
        seed: numberOrUndefined(args.seed),
        cfgScale: Number(config.cfgScale) || 1,
        timeoutMs: config.timeoutMs,
      }));
      const written = writeAudio(config, result.buffer, { ext: 'wav', text: 'converted' });
      return {
        path: written.path,
        bytes: written.bytes,
        durationSec: result.durationSec,
        sampleRate: result.sampleRate,
        voice: args.voice || '',
        baseUrl: config.baseUrl,
        ms: result.ms,
      };
    } catch (error) {
      fail(error);
    }
  },
};

export const statusTool = {
  name: 'breeze_status',
  description:
    'Report whether the configured Breeze server answers, and what the plugin is currently configured to do (endpoint, auth, default format/voice/instruction, output directory, config file). '
    + 'Call this first when a speech call failed, to tell "server down" apart from "wrong voice id".',
  parameters: { type: 'object', additionalProperties: false, properties: {} },
  output: {
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        reachable: { type: 'boolean' },
        baseUrl: { type: 'string' },
        auth: { type: 'string' },
        sampleRate: { type: 'number' },
        format: { type: 'string' },
        voice: { type: 'string' },
        instruction: { type: 'string' },
        cfgScale: { type: 'number' },
        seed: { type: 'number' },
        outputDir: { type: 'string' },
        configFile: { type: 'string' },
        autostart: { type: 'boolean' },
        serverCommand: { type: 'string' },
        note: { type: 'string' },
      },
      required: ['reachable', 'baseUrl', 'configFile'],
    },
    render: (_args, value) => {
      const lines = [
        `Endpoint: ${value.baseUrl} (auth: ${value.auth}) — ${value.reachable ? `up, ${value.sampleRate} Hz` : 'NOT reachable'}`,
        `Defaults: format ${value.format} · cfgScale ${value.cfgScale} · seed ${value.seed}`,
        `Voice: ${value.voice || '(none: voices are designed from the instruction)'}`,
        `Instruction: ${value.instruction || '(empty)'}`,
      ];
      lines.push(`Output: ${value.outputDir}`);
      lines.push(`Config: ${value.configFile}`);
      lines.push(`Autostart: ${value.autostart ? `on (${value.serverCommand || 'no command'})` : 'off'}`);
      if (value.note) lines.push(`Note: ${value.note}`);
      return text(lines.join('\n'));
    },
  },
  async execute(_args, exec) {
    const config = readConfig();
    const probeResult = await probe(config, { timeoutMs: 6000 });
    return {
      reachable: probeResult.reachable === true,
      baseUrl: config.baseUrl,
      auth: config.token ? 'bearer' : 'none',
      sampleRate: probeResult.sampleRate || 0,
      format: config.format,
      voice: config.voice,
      instruction: config.instruction,
      cfgScale: Number(config.cfgScale),
      seed: Number(config.seed),
      outputDir: audioDir(config),
      configFile: configPath(),
      autostart: config.autostart === true,
      serverCommand: config.serverCommand || '',
      note: probeResult.reachable ? '' : String(probeResult.error || ''),
    };
  },
};

export const configTool = {
  name: 'breeze_config',
  description:
    'Read or change the breeze plugin settings. action "get" returns every field; action "set" applies only the fields you pass and returns what changed. '
    + 'Writable fields: baseUrl, token, format, voice, instruction, cfgScale, seed, timeoutMs, outputDir, autostart, serverCommand, serverArgs, serverCwd, startupTimeoutMs. '
    + 'The file is the single source of truth, so a change takes effect on the next tool call with no restart. '
    + 'Passing null or "" resets a field to its default.',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      action: { type: 'string', enum: ['get', 'set'], description: 'get reads the settings, set writes the ones you pass.' },
      fields: { type: 'object', description: 'For action "set": the fields to write, e.g. {"baseUrl":"http://127.0.0.1:8080","voice":"female_001"}.' },
    },
    required: ['action'],
  },
  output: {
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        file: { type: 'string' },
        config: { type: 'object' },
        applied: { type: 'object' },
        ignored: { type: 'array', items: { type: 'string' } },
      },
      required: ['file', 'config'],
    },
    render: (args, value) => {
      if (args.action === 'set') {
        const keys = Object.keys(value.applied || {});
        const ignored = (value.ignored || []).length ? ` Ignored unknown field(s): ${value.ignored.join(', ')}.` : '';
        return text(`${keys.length ? `Wrote ${keys.join(', ')}` : 'Nothing changed'} in ${value.file}.${ignored}\nCurrent: ${JSON.stringify(value.config, null, 2)}`);
      }
      return text(`${value.file}\n${JSON.stringify(value.config, null, 2)}`);
    },
  },
  async execute(args) {
    if (args.action === 'get') {
      const config = readConfig();
      return { file: configPath(), config, applied: {}, ignored: [] };
    }
    if (args.action !== 'set') throw new Error('action must be "get" or "set"');
    const fields = args.fields && typeof args.fields === 'object' && !Array.isArray(args.fields) ? args.fields : {};
    if (Object.keys(fields).length === 0) throw new Error('action "set" needs a `fields` object with at least one field');
    const result = writeConfig(fields);
    return { file: result.file, config: result.config, applied: result.applied, ignored: result.ignored };
  },
};

export const TOOLS = [speakTool, voicesTool, saveVoiceTool, deleteVoiceTool, convertTool, statusTool, configTool];
