// dsh-breeze — client bundle smoke test.
//
// The browser half cannot be exercised through adb or a headless page here, so
// this runs the real bundle under a stubbed `window.__ModuleLoader__` and asserts
// the three things that actually decide whether a settings tab appears:
//
//   1. loader contract — one `load()` call, `id` === package name, factory returns
//      `inject` + `apply`
//   2. slot wiring     — apply(ctx) injects `settings.plugins.tab` and registers a
//      tab descriptor with the id/order/label the settings shell needs
//   3. rendering       — `BreezePanelView` renders with real react and produces the
//      markup a person would see, in both the loading and the loaded state
//
// Requires react + react-dom (dev-only, never shipped):
//   npm install --no-save react@18 react-dom@18
//
// Usage: node tools/ui-smoke.mjs

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

let failures = 0;
let checks = 0;
const ok = (label, detail = '') => { checks += 1; console.log(`  PASS  ${label}${detail ? ` — ${detail}` : ''}`); };
const bad = (label, detail = '') => { checks += 1; failures += 1; console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`); };
const expect = (condition, label, detail = '') => (condition ? ok(label, detail) : bad(label, detail));

let React;
let renderToStaticMarkup;
let resolvedFrom = '';
// react is a dev-only dependency; it may sit in the repo itself or in the
// throwaway .tools install used during development.
for (const base of [path.join(ROOT, 'package.json'), path.join(ROOT, '.tools', 'package.json')]) {
  try {
    const local = createRequire(base);
    React = local('react');
    ({ renderToStaticMarkup } = local('react-dom/server'));
    resolvedFrom = base;
    break;
  } catch {
    // try the next base
  }
}
if (!React || !renderToStaticMarkup) {
  console.log('react / react-dom not installed; run: npm install --no-save react@18 react-dom@18');
  process.exit(2);
}
console.log(`  info  react from ${resolvedFrom === path.join(ROOT, 'package.json') ? 'project root' : '.tools'}`);

console.log('\n[1/3] loader contract');
const src = fs.readFileSync(path.join(ROOT, 'lib', 'client.js'), 'utf8');

const loads = [];
const sandbox = { window: { __ModuleLoader__: { load: (entry) => loads.push(entry) } }, console };
vm.createContext(sandbox);
try {
  new vm.Script(src, { filename: 'lib/client.js' }).runInContext(sandbox);
  ok('bundle executes as a classic script');
} catch (error) {
  bad('bundle executes as a classic script', String(error.message || error));
}

expect(loads.length === 1, 'exactly one __ModuleLoader__.load() call', String(loads.length));
const entry = loads[0] || {};
expect(entry.id === 'dsh-breeze', 'loader id equals the package name', String(entry.id));
expect(typeof entry.factory === 'function', 'factory is a function');

let bundle = null;
try {
  bundle = entry.factory((name) => {
    if (name === 'react') return React;
    throw new Error(`unexpected require("${name}") — must be declared in dsh.client.external`);
  });
  ok('factory materialises with only the platform react');
} catch (error) {
  bad('factory materialises with only the platform react', String(error.message || error));
}

if (bundle) {
  expect(Array.isArray(bundle.inject) && bundle.inject.includes('slots'), 'exports.inject includes slots', JSON.stringify(bundle.inject));
  expect(typeof bundle.apply === 'function', 'exports.apply is a function');
  expect(typeof bundle.BreezePanelView === 'function', 'exports.BreezePanelView is renderable');
}

console.log('\n[2/3] slot wiring');
const registrations = [];
const slots = {
  inject(name, callback) { if (name === 'settings.plugins.tab') callback(); },
  register(descriptor, component) { registrations.push({ descriptor, component }); return () => {}; },
};
if (bundle) {
  let threw = null;
  try {
    bundle.apply({ get: (service) => (service === 'slots' ? slots : undefined) });
  } catch (error) {
    threw = error;
  }
  expect(!threw, 'apply(ctx) runs', threw ? String(threw.message) : '');
  expect(registrations.length === 1, 'one tab registered', String(registrations.length));
  const { descriptor, component } = registrations[0] || {};
  if (descriptor) {
    expect(descriptor.name === 'settings.plugins.tab', 'slot name', descriptor.name);
    expect(typeof descriptor.id === 'string' && descriptor.id.length > 0, 'tab id present', descriptor.id);
    expect(typeof descriptor.order === 'number', 'tab order is numeric', String(descriptor.order));
    expect(typeof descriptor.label === 'function' && typeof descriptor.label() === 'string', 'label resolves to text', descriptor.label && descriptor.label());
  }
  expect(typeof component === 'function', 'registered component is a function');
}

console.log('\n[3/3] rendering');
if (bundle && bundle.BreezePanelView) {
  const noop = () => {};
  const defaultWorkshop = {
    mode: 'design', name: '',
    instruction: "A soft, bright young girl's voice, high and slightly nasal with a childish lilt, unhurried short sentences with small pauses, intimate and close-mic, with a light playful sweetness.",
    text: '爸爸，你回来啦。拖鞋我摆好了，桌上有一杯温水。你坐下歇一会儿，我给你捶捶背。今天累不累呀？',
    refText: '',
    audioPath: '', audioUrl: '', fileName: '', fileBytes: 0, fileReady: false,
    busy: '', message: null,
  };
  const baseProps = {
    value: (key, fallback) => ({ voice: 'female_001', baseUrl: 'https://breeze.example', format: 'wav', cfgScale: 1, seed: 42, outputDir: '', instruction: 'calm' }[key] ?? fallback),
    set: noop,
    onRefresh: noop,
    onSave: noop,
    onReset: noop,
    onSpeak: noop,
    setProbe: noop,
    probeInstruction: '',
    setProbeInstruction: noop,
    onChooseVoice: noop,
    voicesBusy: false,
    onWorkshop: noop,
    onWorkshopPreview: noop,
    onWorkshopSave: noop,
    onWorkshopFile: noop,
    workshop: defaultWorkshop,
  };

  let loading = '';
  try {
    loading = renderToStaticMarkup(React.createElement(bundle.BreezePanelView, Object.assign({}, baseProps, { status: null, config: null })));
    ok('loading state renders', `${loading.length} bytes`);
  } catch (error) {
    bad('loading state renders', String(error.message || error));
  }
  expect(loading.includes('正在读取 Breeze 设置'), 'loading state shows a reading message');

  const status = { reachable: true, baseUrl: 'https://breeze.example', sampleRate: 24000, wsPort: 8081, auth: 'bearer' };
  const config = { file: 'C:\\Users\\x\\.dsh\\dsh-breeze\\config.json', config: { baseUrl: 'https://breeze.example', tokenSet: true, format: 'wav', voice: 'female_001', instruction: 'calm', cfgScale: 1, seed: 42, outputDir: '' } };
  const voices = [
    { id: 'female_001', saved: true, seconds: 8.8, description: 'warm narrator' },
    { id: 'cached_02', saved: false, seconds: 4.2, description: '' },
  ];

  let markup = '';
  try {
    markup = renderToStaticMarkup(React.createElement(bundle.BreezePanelView, Object.assign({}, baseProps, {
      status, config, voices, busy: '', message: { kind: 'ok', text: '已保存：voice' }, draft: {}, probe: '你好', probeAudio: '/dsh-breeze-api/audio/x.wav?t=1',
      ws: undefined, // still probing
    })));
    ok('loaded state renders', `${markup.length} bytes`);
  } catch (error) {
    bad('loaded state renders', String(error.message || error));
  }

  for (const [needle, label] of [
    ['服务可达', 'status line reports reachable'],
    ['24000 Hz', 'sample rate shown'],
    ['Bearer', 'auth mode shown'],
    ['连接设置', 'connection card present'],
    ['Bearer Token', 'token field is labelled Bearer Token'],
    ['WebSocket 端口', 'ws port field present'],
    ['WebSocket 路径', 'ws path field present'],
    ['音色库', 'voice card present'],
    ['female_001', 'voice row rendered'],
    ['cached_02', 'cached voice rendered'],
    ['saved · 8.8s', 'voice metadata rendered'],
    ['warm narrator', 'voice description rendered'],
    ['合成并试听', 'preview action present'],
    ['<audio', 'audio element present when a clip exists'],
    ['已保存：voice', 'message rendered'],
  ]) {
    expect(markup.includes(needle), label, needle);
  }
  // The tab label lives in the slot descriptor, not in the panel markup.
  expect(src.includes('Breeze 语音'), 'tab label constant present in bundle', 'Breeze 语音');
  expect(markup.includes('WebSocket'), 'a WebSocket status row exists');
  expect(markup.includes('检测中'), 'the socket row says it is still probing');

  // Card order is part of the request: 连接设置 → 音色工坊 → 音色库 → 试听.
  // Located by their data-breeze marker: "试听" also appears inside the workshop's
  // own preview button, so plain text offsets would lie.
  const iConn = markup.indexOf('data-breeze="settings"');
  const iShop = markup.indexOf('data-breeze="workshop"');
  const iLib = markup.indexOf('data-breeze="voices"');
  const iPreview = markup.indexOf('data-breeze="preview"');
  expect(iConn > -1 && iShop > iConn && iLib > iShop, 'card order: 连接设置 → 音色工坊 → 音色库', `${iConn}/${iShop}/${iLib}`);
  expect(iPreview > iLib, '试听 card stays last', `${iLib}/${iPreview}`);

  // The connection card carries only connection + synthesis settings: the output
  // directory, the voice description and even the voice picker moved out.
  const settingsCard = markup.slice(iConn, iShop);
  expect(!settingsCard.includes('输出目录'), 'connection card no longer offers an output directory');
  expect(!settingsCard.includes('音色描述'), 'connection card no longer offers a voice description');
  expect(!settingsCard.includes('>音色<'), 'connection card no longer offers a voice picker');
  expect(settingsCard.includes('服务地址') && settingsCard.includes('Bearer Token'), 'connection card keeps its own fields');
  expect(settingsCard.includes('WebSocket 端口') && settingsCard.includes('WebSocket 路径'), 'connection card keeps the socket settings');
  expect(settingsCard.includes('引导强度') && settingsCard.includes('随机种子'), 'connection card keeps the synthesis knobs');
  // The global direction lives here; the preview card has its own one-shot copy.
  expect(settingsCard.includes('表演描述（全局）'), 'connection card offers the global performance description');
  expect(settingsCard.includes('Speak clearly and naturally.'), 'the global description shows its default value');

  // The library is a dropdown now, and the chosen voice's details show underneath.
  const voicesCard = markup.slice(iLib, iPreview);
  expect(voicesCard.includes('<select'), 'the voice library is a dropdown');
  expect(voicesCard.includes('female_001'), 'the dropdown lists the voices');
  expect(voicesCard.includes('cached_02'), 'the dropdown also lists cached voices');
  expect(!voicesCard.includes('按描述现场设计'), 'the dropdown no longer offers a design-from-description entry');
  expect(voicesCard.includes('saved · 8.8s · warm narrator'), 'the chosen voice shows its details below the dropdown');
  expect(!voicesCard.includes('选用'), 'the old per-row 选用 buttons are gone');

  // With nothing selected, a disabled row says so instead of offering a way back.
  const noVoice = renderToStaticMarkup(React.createElement(bundle.BreezePanelView, Object.assign({}, baseProps, {
    status, config, voices, busy: '', message: null, draft: {}, probe: '', probeAudio: '',
    value: (key, fallback) => ({ voice: '', baseUrl: 'https://breeze.example', format: 'wav', cfgScale: 1, seed: 42, outputDir: '', instruction: 'calm' }[key] ?? fallback),
  })));
  expect(noVoice.includes('（未选择音色）'), 'an unselected library shows a disabled placeholder');
  expect(/<option[^>]*disabled[^>]*>（未选择音色）/.test(noVoice), 'the placeholder is not selectable');

  // The preview card gained its own per-preview direction field.
  const previewCard = markup.slice(iPreview);
  expect(previewCard.includes('表演描述（本次试听用）'), 'preview card offers a per-preview direction');
  expect(previewCard.includes('留空就用配置文件里的描述'), 'preview direction explains the fallback');

  // Both preview inputs ship with editable starting values, not just placeholders.
  expect(src.includes('你好，这是我现在的声音'), 'the preview text ships with a default sentence');
  expect(src.includes('probeInstructionSeeded'), 'the preview direction is seeded from the configured description');

  // The workshop's action picker is a dropdown with both modes.
  expect(markup.includes('要做什么'), 'workshop has an action picker');
  expect(markup.includes('设计新音色'), 'picker offers the design mode');
  expect(markup.includes('克隆参考音频'), 'picker offers the clone mode');
  expect(/<select[^>]*>[\s\S]*设计新音色[\s\S]*克隆参考音频[\s\S]*<\/select>/.test(markup), 'both modes are options of one <select>');

  // Design mode: preview first, save only what was previewed.
  expect(markup.includes('试听这段'), 'design mode offers a preview button');
  expect(markup.includes('保存为音色'), 'design mode offers a save button');
  expect(markup.includes('先试听一段'), 'design mode explains the preview-first rule');
  // The voice-description slot carries a real, usable example (a loli voice), and
  // states the upstream rule that the description language must match the text.
  expect(markup.includes('稚嫩清亮的萝莉音'), 'the description slot shows the loli-voice example');
  expect(markup.includes('描述语言与朗读文本保持一致'), 'the panel states the language-matching rule');
  expect(markup.includes("A soft, bright young girl"), 'an English equivalent is offered alongside');
  // The reading text starts pre-filled with a daughter-to-father line, as an
  // editable value (not a placeholder), so it can be rewritten on the spot.
  expect(markup.includes('爸爸，你回来啦'), 'the reading text is pre-filled with the father line');
  expect(markup.includes('我给你捶捶背'), 'the pre-filled line is its own text, not the reference sample');
  expect(markup.includes('今天累不累呀'), 'the pre-filled line closes on a caring question');
  expect(/<textarea[^>]*>爸爸，你回来啦/.test(markup), 'the reading text is a textarea value, not a placeholder');
  expect(markup.includes('placeholder="用一句话试试这个声音'), 'an empty reading text still shows a prompt');

  // Clone mode: file picker + transcript.
  const cloneMarkup = renderToStaticMarkup(React.createElement(bundle.BreezePanelView, Object.assign({}, baseProps, {
    status, config, voices, busy: '', message: null, draft: {}, probe: '', probeAudio: '',
    workshop: Object.assign({}, defaultWorkshop, { mode: 'clone' }),
  })));
  expect(cloneMarkup.includes('type="file"'), 'clone mode offers a file input');
  expect(cloneMarkup.includes('转录文本'), 'clone mode asks for the transcript');
  expect(cloneMarkup.includes('保存音色'), 'clone mode offers a save button');
  expect(!cloneMarkup.includes('试听这段'), 'clone mode hides the design-only preview');

  // Reachable socket: URL, port, path and latency are all shown.
  const wsUp = renderToStaticMarkup(React.createElement(bundle.BreezePanelView, Object.assign({}, baseProps, {
    status, config, voices, busy: '', message: null, draft: {}, probe: '', probeAudio: '',
    ws: { reachable: true, url: 'wss://breeze.example:8081/', source: 'wsPort', wsPort: 8081, wsPath: '/', ms: 42, error: '' },
  })));
  expect(wsUp.includes('wss://breeze.example:8081/'), 'reachable socket shows its URL');
  expect(wsUp.includes('端口 8081'), 'reachable socket shows the port');
  expect(wsUp.includes('路径 /'), 'reachable socket shows the path');
  expect(wsUp.includes('42 ms'), 'reachable socket shows the probe latency');

  // Unreachable socket: the reason replaces the URL.
  const wsDown = renderToStaticMarkup(React.createElement(bundle.BreezePanelView, Object.assign({}, baseProps, {
    status, config, voices, busy: '', message: null, draft: {}, probe: '', probeAudio: '',
    ws: { reachable: false, url: '', error: 'wss://breeze.example:8081/ 10s 无响应 · wss://breeze.example/ws HTTP 404', ms: 1200 },
  })));
  expect(wsDown.includes('HTTP 404'), 'unreachable socket shows the reason');
  expect(!/wss:\/\/breeze\.example:8081\/ · 端口/.test(wsDown), 'unreachable socket does not pretend to be up');
  // No "default values" framing anywhere in the panel copy.
  expect(!markup.includes('默认'), 'panel copy no longer talks about default values');
  expect(!markup.includes('type="password"'), 'no field masks its input');
  expect(markup.includes('Bearer Token'), 'token row keeps its explicit label');

  // A value the person typed is shown as typed, in plain text.
  const typed = renderToStaticMarkup(React.createElement(bundle.BreezePanelView, Object.assign({}, baseProps, {
    status, config, voices, busy: '', message: null, draft: { token: 'typed-in-clear' }, probe: '', probeAudio: '',
  })));
  expect(typed.includes('typed-in-clear'), 'a typed token is rendered in plain text');
  expect(!/type="password"/.test(typed), 'typing a token does not switch the field to masked');

  // The page must never receive the server-side token: it is only ever typed in.
  const tokenLeak = /(?:3367ee|6e31e91|Bearer [A-Za-z0-9]{8,})/.test(markup);
  expect(!tokenLeak, 'no credential appears in rendered markup');

  // Unreachable state must say so and must disable synthesis.
  const down = renderToStaticMarkup(React.createElement(bundle.BreezePanelView, Object.assign({}, baseProps, {
    status: { reachable: false, baseUrl: 'http://127.0.0.1:8080', error: 'connection refused: nothing is listening on that host/port' },
    config, voices: [], busy: '', message: null, draft: {},
  })));
  expect(down.includes('服务不可达'), 'unreachable state reports down');
  expect(down.includes('connection refused'), 'unreachable state carries the reason');
  expect(down.includes('还没有音色'), 'empty voice library explains itself');
  expect(/disabled=""/.test(down) || down.includes('disabled'), 'synthesis is disabled while unreachable');
}

console.log(`\n${failures === 0 ? 'OK' : 'FAILED'} — ${checks - failures}/${checks} checks passed`);
process.exit(failures === 0 ? 0 : 1);
