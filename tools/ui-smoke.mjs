// dsh-breeze — client bundle smoke test.
//
// The panel is a settings SECTION now (its own navigation item), not a tab inside
// the built-in plugin inventory. That distinction is exactly what broke before, so
// it is asserted here rather than eyeballed.
//
// Requires react + react-dom (dev-only):
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
for (const base of [path.join(ROOT, 'package.json'), path.join(ROOT, '.tools', 'package.json')]) {
  try {
    const local = createRequire(base);
    React = local('react');
    ({ renderToStaticMarkup } = local('react-dom/server'));
    break;
  } catch {
    // next candidate
  }
}
if (!React || !renderToStaticMarkup) {
  console.log('react / react-dom not installed; run: npm install --no-save react@18 react-dom@18');
  process.exit(2);
}

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
expect(loads.length === 1, 'exactly one load() call', String(loads.length));
const entry = loads[0] || {};
expect(entry.id === 'dsh-breeze', 'loader id equals the package name', String(entry.id));

let bundle = null;
try {
  bundle = entry.factory((name) => {
    if (name === 'react') return React;
    throw new Error(`unexpected require("${name}")`);
  });
  ok('factory materialises with only the platform react');
} catch (error) {
  bad('factory materialises with only the platform react', String(error.message || error));
}
expect(bundle && Array.isArray(bundle.inject) && bundle.inject.includes('slots'), 'exports.inject includes slots');
expect(bundle && typeof bundle.apply === 'function', 'exports.apply is a function');

console.log('\n[2/3] slot wiring');
const registrations = [];
const slots = {
  inject(name, callback) {
    // settings section + the per-tool cards.
    if (name === 'settings.section' || name === 'tool.call.toolview') callback();
  },
  register(descriptor, component) { registrations.push({ descriptor, component }); return () => {}; },
};
{
  let threw = null;
  try {
    bundle.apply({ slots });
  } catch (error) {
    threw = error;
  }
  expect(!threw, 'apply(ctx) runs', threw ? String(threw.message) : '');
  expect(registrations.length === 3, 'a settings section plus two tool cards', String(registrations.length));

  const section = registrations.filter((r) => r.descriptor.name === 'settings.section')[0] || {};
  expect(section.descriptor && section.descriptor.name === 'settings.section', 'it contributes to settings.section (a top-level section)', section.descriptor && section.descriptor.name);
  expect(section.descriptor && section.descriptor.id === 'breeze', 'section id', section.descriptor && section.descriptor.id);
  expect(section.descriptor && typeof section.descriptor.order === 'number', 'section order is numeric', String(section.descriptor && section.descriptor.order));
  expect(section.descriptor && typeof section.descriptor.label === 'function' && section.descriptor.label() === 'Breeze 语音', 'section label', section.descriptor && section.descriptor.label && section.descriptor.label());
  expect(!src.includes('settings.plugins.tab'), 'no longer registers inside 内置插件');

  const cardKeys = registrations.filter((r) => r.descriptor.name === 'tool.call.toolview').map((r) => r.descriptor.key);
  expect(cardKeys.join(',') === 'breeze_speak,breeze_convert', 'a card is registered for each speech tool', cardKeys.join(','));
  expect(typeof bundle.SpeechCard === 'function', 'exports.SpeechCard is renderable');
}

console.log('\n[3/3] rendering');
{
  const noop = () => {};
  const baseProps = {
    value: (key, fallback) => ({ voice: 'female_001', baseUrl: 'https://breeze.example', format: 'wav', cfgScale: 1, seed: 42, instruction: 'calm' }[key] ?? fallback),
    set: noop, onRefresh: noop, onSave: noop, onReset: noop, onSpeak: noop,
    setProbe: noop, setProbeInstruction: noop, onChooseVoice: noop, voicesBusy: false,
    onWorkshop: noop, onWorkshopPreview: noop, onWorkshopSave: noop, onWorkshopFile: noop,
    probeInstruction: '', workshop: undefined,
  };
  const loading = renderToStaticMarkup(React.createElement(bundle.BreezePanelView, Object.assign({}, baseProps, { status: null, config: null })));
  expect(loading.includes('正在读取 Breeze 设置'), 'loading state renders');

  const status = { reachable: true, baseUrl: 'https://breeze.example', sampleRate: 24000, auth: 'bearer' };
  const config = { file: 'C:\\x\\config.json', config: { baseUrl: 'https://breeze.example', tokenSet: true, format: 'wav', voice: 'female_001', instruction: 'calm', cfgScale: 1, seed: 42 } };
  const voices = [
    { id: 'female_001', saved: true, seconds: 8.8, description: 'warm narrator' },
    { id: 'cached_02', saved: false, seconds: 4.2, description: '' },
  ];
  const markup = renderToStaticMarkup(React.createElement(bundle.BreezePanelView, Object.assign({}, baseProps, {
    status, config, voices, busy: '', message: null, draft: {}, probe: '', probeAudio: '',
  })));

  for (const [needle, label] of [
    ['服务可达', 'status line'],
    ['连接设置', 'connection card'],
    ['Bearer Token', 'token field'],
    ['表演描述（全局）', 'global direction'],
    ['音色工坊', 'workshop card'],
    ['音色库', 'voice library'],
    ['合成并试听', 'preview card'],
  ]) {
    expect(markup.includes(needle), label, needle);
  }

  const order = ['data-breeze="settings"', 'data-breeze="workshop"', 'data-breeze="voices"', 'data-breeze="preview"'].map((m) => markup.indexOf(m));
  expect(order.every((index, i) => index > 0 && (i === 0 || index > order[i - 1])), 'card order: 连接设置 → 音色工坊 → 音色库 → 试听', order.join('/'));

  // Everything websocket / auto-read related must be gone from the panel. ("朗读"
  // alone still appears in 朗读文本 — the workshop's reading-text label — so the
  // assertion names the control's own wording instead.)
  for (const [needle, label] of [
    ['WebSocket', 'no websocket row'],
    ['朗读 关', 'no read-aloud mode control'],
    ['自动朗读', 'no auto-read copy'],
    ['readTransport', 'no transport setting'],
  ]) {
    expect(!markup.includes(needle), label, needle);
  }

  // ---- the inline speech card
  const settled = renderToStaticMarkup(React.createElement(bundle.SpeechCard, {
    block: {
      kind: 'tool-result',
      meta: { kind: 'speech', url: '/dsh-breeze-api/audio/a.wav', durationSec: 4.4, bytes: 211244, format: 'wav', voice: 'female_002', text: '你好' },
    },
  }));
  expect(settled.includes('<audio'), 'the speech card embeds an audio element');
  expect(settled.includes('/dsh-breeze-api/audio/a.wav'), 'the player points at the same-origin url', '/dsh-breeze-api/audio/a.wav');
  expect(settled.includes('4.4s') && settled.includes('female_002'), 'the card shows duration and voice');
  expect(settled.includes('你好'), 'the card echoes the spoken text');

  const running = renderToStaticMarkup(React.createElement(bundle.SpeechCard, { block: { kind: 'tool-call' } }));
  expect(running.includes('合成中'), 'a running call shows a working state');
  expect(!running.includes('<audio'), 'nothing playable while it is still running');

  const failed = renderToStaticMarkup(React.createElement(bundle.SpeechCard, {
    block: { kind: 'tool-result', isError: true, error: { name: 'breeze 502 Bad Gateway' } },
  }));
  expect(failed.includes('合成失败') && failed.includes('502'), 'a failed call shows the reason');
}

console.log(`\n${failures === 0 ? 'OK' : 'FAILED'} — ${checks - failures}/${checks} checks passed`);
process.exitCode = failures === 0 ? 0 : 1;
