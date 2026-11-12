// dsh-breeze — client half: one settings section (not a tab inside 内置插件).
//
// Hand-written in the harness module-loader format: `require` answers the frozen
// platform table (react), everything else is inlined. Two loader rules:
//   1. `id` MUST equal the npm package name, or the host reports
//      `loaded without registering "<pkg>"`.
//   2. Only `exports.inject` / `exports.apply` matter to the harness.
//
// `BreezePanelView` is exported for the smoke test: it is a pure function of props,
// so it can be rendered with real react without a browser.

window.__ModuleLoader__.load({
  id: 'dsh-breeze',
  factory: require => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    var react = require('react');
    var h = react.createElement;
    var useState = react.useState;
    var useEffect = react.useEffect;
    var useCallback = react.useCallback;
    var useRef = react.useRef;

    var API = '/dsh-breeze-api';

    // ------------------------------------------------------------ styling
    var S = {
      root: { display: 'flex', flexDirection: 'column', gap: 16, padding: '4px 2px 24px', fontSize: 13, lineHeight: 1.55 },
      card: { border: '1px solid var(--dsh-border, rgba(128,128,128,.25))', borderRadius: 10, padding: '12px 14px' },
      head: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 8 },
      title: { fontWeight: 600, fontSize: 13 },
      sub: { opacity: 0.65, fontSize: 12 },
      dot: function (on) {
        var colour = on === null || on === undefined ? '#9aa0a6' : (on ? '#22b573' : '#b9382f');
        return { width: 8, height: 8, borderRadius: 8, background: colour, flex: '0 0 auto' };
      },
      grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: '10px 16px' },
      field: { display: 'flex', flexDirection: 'column', gap: 4 },
      fieldSpaced: { display: 'flex', flexDirection: 'column', gap: 4, marginTop: 10 },
      label: { fontSize: 12, opacity: 0.75 },
      input: { width: '100%', boxSizing: 'border-box', padding: '6px 8px', borderRadius: 6, border: '1px solid var(--dsh-border, rgba(128,128,128,.35))', background: 'transparent', color: 'inherit', font: 'inherit' },
      row: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 10 },
      btn: { padding: '6px 12px', borderRadius: 6, border: '1px solid var(--dsh-border, rgba(128,128,128,.35))', background: 'transparent', color: 'inherit', font: 'inherit', cursor: 'pointer' },
      btnPrimary: { padding: '6px 12px', borderRadius: 6, border: '1px solid transparent', background: 'var(--dsh-accent, #4c6ef5)', color: '#fff', font: 'inherit', cursor: 'pointer' },
      ghost: { padding: '4px 10px', borderRadius: 6, border: '1px solid var(--dsh-border, rgba(128,128,128,.35))', background: 'transparent', color: 'inherit', font: 'inherit', cursor: 'pointer', fontSize: 12 },
      mono: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 11, wordBreak: 'break-all', opacity: 0.7 },
      audioWrap: { marginTop: 10 },
      msg: function (kind) {
        return {
          padding: '6px 10px',
          borderRadius: 6,
          fontSize: 12,
          background: kind === 'error' ? 'rgba(185,56,47,.12)' : kind === 'ok' ? 'rgba(34,181,115,.12)' : 'rgba(128,128,128,.12)',
        };
      },
    };

    // ------------------------------------------------------------ helpers

    async function call(path, init) {
      var response = await fetch(API + path, init);
      var payload = null;
      try { payload = await response.json(); } catch (_) { payload = null; }
      if (!response.ok) throw new Error(payload && payload.error ? payload.error : ('HTTP ' + response.status));
      return payload || {};
    }

    function field(label, control) {
      return h('label', { style: S.field }, h('span', { style: S.label }, label), control);
    }

    function input(props) {
      return h('input', Object.assign({ style: S.input, spellCheck: false }, props));
    }

    function select(props, options) {
      return h('select', Object.assign({ style: S.input }, props),
        options.map(function (option) {
          return h('option', { key: option.value, value: option.value, disabled: option.disabled === true }, option.label);
        }));
    }

    function textarea(props) {
      return h('textarea', Object.assign({ style: Object.assign({}, S.input, { minHeight: 56, resize: 'vertical', fontFamily: 'inherit' }) }, props));
    }

    var FORMAT_OPTIONS = [
      { value: 'wav', label: 'wav（24 kHz 单声道，推荐）' },
      { value: 'mp3', label: 'mp3（80 kbps）' },
      { value: 'pcm', label: 'pcm（无头 s16le）' },
    ];

    // ------------------------------------------------------------ view

    function BreezePanelView(props) {
      var status = props.status;
      var config = props.config;
      var voices = props.voices || [];
      var busy = props.busy || '';
      var message = props.message || null;
      var draft = props.draft || {};
      var probe = props.probe || '';
      var probeInstruction = props.probeInstruction || '';
      var probeAudio = props.probeAudio || '';
      var workshop = props.workshop || {
        mode: 'design', name: '',
        instruction: "A soft, bright young girl's voice, high and slightly nasal with a childish lilt, unhurried short sentences with small pauses, intimate and close-mic, with a light playful sweetness.",
        text: '爸爸，你回来啦。拖鞋我摆好了，桌上有一杯温水。你坐下歇一会儿，我给你捶捶背。今天累不累呀？',
        refText: '', audioPath: '', audioUrl: '', fileName: '', fileBytes: 0, fileReady: false, busy: '', message: null,
      };

      if (!config) {
        return h('div', { style: S.root }, h('div', { style: S.sub }, '正在读取 Breeze 设置…'));
      }

      var reachable = status && status.reachable === true;
      var endpointNote = status && (status.error || status.note) ? (status.error || status.note) : '';
      var currentVoice = String(props.value('voice', '') || '');
      var voiceOptions = voices.map(function (row) {
        return { value: row.id, label: row.id + (row.saved ? '' : '（缓存）') + (row.seconds ? ' · ' + row.seconds + 's' : '') };
      });
      if (!currentVoice) {
        voiceOptions.unshift({ value: '', label: '（未选择音色）', disabled: true });
      } else if (!voices.some(function (row) { return row.id === currentVoice; })) {
        voiceOptions.unshift({ value: currentVoice, label: currentVoice + '（服务端当前没有）', disabled: true });
      }
      var selectedVoice = voices.filter(function (row) { return row.id === currentVoice; })[0] || null;
      var dirty = Object.keys(draft).length;

      return h('div', { style: S.root },

        // ---- status
        h('div', { style: S.card, 'data-breeze': 'status' },
          h('div', { style: S.head },
            h('span', { style: S.dot(reachable) }),
            h('span', { style: S.title }, reachable ? '服务可达' : '服务不可达'),
            h('span', { style: S.sub }, (status && status.baseUrl) || ''),
            reachable
              ? h('span', { style: S.sub }, '· ' + (status.sampleRate || '?') + ' Hz · 鉴权 ' + (status.auth === 'bearer' ? 'Bearer' : '无'))
              : null,
            h('button', { style: S.ghost, onClick: props.onRefresh, disabled: busy === 'refresh' }, busy === 'refresh' ? '刷新中…' : '刷新'),
          ),
          endpointNote ? h('div', { style: S.msg('error') }, endpointNote) : null,
          h('div', { style: S.mono }, '配置文件 ' + (config.file || '(未创建)')),
        ),

        // ---- connection
        h('div', { style: S.card, 'data-breeze': 'settings' },
          h('div', { style: S.head }, h('span', { style: S.title }, '连接设置')),
          h('div', { style: S.grid },
            field('服务地址', input({ value: String(props.value('baseUrl', '') || ''), onChange: function (event) { props.set('baseUrl', event.target.value); }, placeholder: 'http://127.0.0.1:8080' })),
            field('Bearer Token', input({ value: String(draft.token || ''), onChange: function (event) { props.set('token', event.target.value); } })),
            field('输出格式', select({ value: String(props.value('format', 'wav')), onChange: function (event) { props.set('format', event.target.value); } }, FORMAT_OPTIONS)),
            field('引导强度 cfgScale（2~3 才让语气事件生效）', input({ type: 'number', min: 1, max: 10, step: 0.5, value: String(props.value('cfgScale', 1)), onChange: function (event) { props.set('cfgScale', Number(event.target.value)); } })),
            field('随机种子 seed', input({ type: 'number', min: 0, step: 1, value: String(props.value('seed', 42)), onChange: function (event) { props.set('seed', Number(event.target.value)); } })),
          ),
          h('div', { style: S.fieldSpaced },
            h('span', { style: S.label }, '表演描述（全局）'),
            textarea({
              value: String(props.value('instruction', '') || ''),
              onChange: function (event) { props.set('instruction', event.target.value); },
              placeholder: 'Speak clearly and naturally.',
            }),
            h('span', { style: S.mono }, 'agent 不指定描述时用它；语言要和朗读文本一致。点下面的「保存」写回配置文件。'),
          ),
          h('div', { style: S.row },
            h('button', { style: S.btnPrimary, onClick: props.onSave, disabled: busy === 'save' }, busy === 'save' ? '保存中…' : '保存'),
            h('button', { style: S.btn, onClick: props.onReset }, '放弃改动'),
            dirty ? h('span', { style: S.sub }, dirty + ' 处未保存') : null,
          ),
        ),

        // ---- workshop
        h('div', { style: S.card, 'data-breeze': 'workshop' },
          h('div', { style: S.head },
            h('span', { style: S.title }, '音色工坊'),
            h('span', { style: S.sub }, workshop.mode === 'clone'
              ? '用一段参考录音克隆一个声音'
              : '描述一个声音，试听满意后存成音色'),
          ),
          h('div', { style: S.grid },
            field('要做什么', select({
              value: workshop.mode,
              onChange: function (event) { props.onWorkshop({ mode: event.target.value }); },
            }, [
              { value: 'design', label: '设计新音色（用描述生成）' },
              { value: 'clone', label: '克隆参考音频（上传 WAV）' },
            ])),
            field('音色名称（字母数字、- 和 _）', input({
              value: workshop.name,
              onChange: function (event) { props.onWorkshop({ name: event.target.value }); },
              placeholder: '例如 narrator2',
            })),
          ),

          workshop.mode === 'design' ? h('div', {},
            h('div', { style: S.fieldSpaced },
              h('span', { style: S.label }, '音色描述（会存成这个音色的说明）'),
              textarea({
                value: workshop.instruction,
                onChange: function (event) { props.onWorkshop({ instruction: event.target.value }); },
                placeholder: '一个稚嫩清亮的萝莉音，音调偏高、带一点奶气和鼻音，语速偏慢，短句、句间有小停顿，声音贴近麦克风，亲密又带一点撒娇的甜。',
              }),
              h('span', { style: S.mono }, '上面这段可以直接改；描述语言与朗读文本保持一致（英文文本配英文描述，中文文本配中文描述）。'),
            ),
            h('div', { style: S.fieldSpaced },
              h('span', { style: S.label }, '朗读文本（这段音频同时作为参考转录）'),
              textarea({
                value: workshop.text,
                onChange: function (event) { props.onWorkshop({ text: event.target.value }); },
                placeholder: '用一句话试试这个声音，比如：晚风起来了，我们回去吧。',
              }),
            ),
            h('div', { style: S.row },
              h('button', { style: S.btn, onClick: props.onWorkshopPreview, disabled: workshop.busy === 'preview' || !reachable }, workshop.busy === 'preview' ? '生成中…' : '试听这段'),
              h('button', { style: S.btnPrimary, onClick: props.onWorkshopSave, disabled: workshop.busy === 'save' || !workshop.audioPath }, workshop.busy === 'save' ? '保存中…' : '保存为音色'),
              !workshop.audioPath ? h('span', { style: S.sub }, '先试听一段，满意再保存') : null,
            ),
            workshop.audioUrl ? h('div', { style: S.audioWrap }, h('audio', { src: workshop.audioUrl, controls: true, style: { width: '100%' } })) : null,
          ) : h('div', {},
            h('div', { style: S.fieldSpaced },
              h('span', { style: S.label }, '参考音频（24 kHz 单声道 WAV 编码效果最好）'),
              h('input', {
                type: 'file',
                accept: 'audio/wav,audio/x-wav,audio/mpeg,audio/mp3,.wav,.mp3',
                style: Object.assign({}, S.input, { padding: '5px 6px' }),
                onChange: function (event) {
                  var file = event.target.files && event.target.files[0];
                  if (file) props.onWorkshopFile(file);
                },
              }),
              workshop.fileName ? h('span', { style: S.mono }, '已选择 ' + workshop.fileName + (workshop.fileBytes ? ' · ' + Math.round(workshop.fileBytes / 1024) + ' KB' : '')) : null,
            ),
            h('div', { style: S.fieldSpaced },
              h('span', { style: S.label }, '转录文本（必须与录音逐字一致）'),
              textarea({
                value: workshop.refText,
                onChange: function (event) { props.onWorkshop({ refText: event.target.value }); },
                placeholder: '参考音频里说的每一句，一字不差',
              }),
            ),
            h('div', { style: S.row },
              h('button', { style: S.btnPrimary, onClick: props.onWorkshopSave, disabled: workshop.busy === 'save' || !workshop.fileReady }, workshop.busy === 'save' ? '保存中…' : '保存音色'),
            ),
          ),

          workshop.message ? h('div', { style: S.msg(workshop.message.kind) }, workshop.message.text) : null,
        ),

        // ---- voice library
        h('div', { style: S.card, 'data-breeze': 'voices' },
          h('div', { style: S.head },
            h('span', { style: S.title }, '音色库'),
            h('span', { style: S.sub }, voices.length ? voices.length + ' 个' : '服务端没有音色'),
          ),
          voices.length === 0
            ? h('div', { style: S.sub }, '还没有音色。可以在上面的音色工坊里造一个，或让 agent 用 breeze_voice_save 保存参考音频。')
            : h('div', { style: S.grid },
              field('音色', select({
                value: currentVoice,
                onChange: function (event) { props.onChooseVoice(event.target.value); },
                disabled: props.voicesBusy === true,
              }, voiceOptions)),
            ),
          selectedVoice
            ? h('div', { style: S.fieldSpaced },
              h('span', { style: S.mono }, `${selectedVoice.saved ? 'saved' : 'cached'}${selectedVoice.seconds ? ' · ' + selectedVoice.seconds + 's' : ''}${selectedVoice.description ? ' · ' + selectedVoice.description : ''}`),
            )
            : null,
          props.voicesBusy === true ? h('div', { style: S.sub }, '切换中…') : null,
        ),

        // ---- preview
        h('div', { style: S.card, 'data-breeze': 'preview' },
          h('div', { style: S.head }, h('span', { style: S.title }, '试听')),
          textarea({
            value: probe,
            onChange: function (event) { props.setProbe(event.target.value); },
            placeholder: '写一句要念的话，比如：(sigh) 插件装好了，现在我能直接开口说话。',
          }),
          h('div', { style: S.fieldSpaced },
            h('span', { style: S.label }, '表演描述（本次试听用）'),
            textarea({
              value: probeInstruction,
              onChange: function (event) { props.setProbeInstruction(event.target.value); },
              placeholder: '留空就用配置文件里的描述；这里填什么只影响这一次试听，不会保存',
            }),
          ),
          h('div', { style: S.row },
            h('button', { style: S.btnPrimary, onClick: props.onSpeak, disabled: busy === 'speak' || !reachable }, busy === 'speak' ? '合成中…' : '合成并试听'),
            !reachable ? h('span', { style: S.sub }, '服务不可达时不能合成') : null,
          ),
          probeAudio ? h('div', { style: S.audioWrap }, h('audio', { src: probeAudio, controls: true, style: { width: '100%' } })) : null,
        ),

        message ? h('div', { style: S.msg(message.kind) }, message.text) : null,
      );
    }

    // ------------------------------------------------------------ stateful panel

    function BreezePanel() {
      var [status, setStatus] = useState(null);
      var [config, setConfig] = useState(null);
      var [voices, setVoices] = useState([]);
      var [busy, setBusy] = useState('');
      var [message, setMessage] = useState(null);
      var [draft, setDraft] = useState({});
      var [probe, setProbe] = useState('你好，这是我现在的声音。听起来怎么样？');
      var [probeInstruction, setProbeInstruction] = useState('');
      var [probeAudio, setProbeAudio] = useState('');
      var [voicesBusy, setVoicesBusy] = useState(false);
      var [workshop, setWorkshop] = useState({
        mode: 'design',
        name: '',
        instruction: "A soft, bright young girl's voice, high and slightly nasal with a childish lilt, unhurried short sentences with small pauses, intimate and close-mic, with a light playful sweetness.",
        text: '爸爸，你回来啦。拖鞋我摆好了，桌上有一杯温水。你坐下歇一会儿，我给你捶捶背。今天累不累呀？',
        refText: '',
        audioPath: '', audioUrl: '', fileName: '', fileBytes: 0, fileReady: false,
        busy: '', message: null,
      });
      var workshopUpload = useRef(null);
      var probeInstructionSeeded = useRef(false);
      var generation = useRef(0);

      var refresh = useCallback(async function (options) {
        var silent = options && options.silent;
        var token = ++generation.current;
        if (!silent) setBusy('refresh');
        try {
          var results = await Promise.all([
            call('/status').catch(function (error) { return { reachable: false, baseUrl: '', note: String(error.message || error) }; }),
            call('/config').catch(function () { return { file: '', config: {} }; }),
            call('/voices').then(function (value) { return value.voices || []; }).catch(function () { return []; }),
          ]);
          if (token !== generation.current) return;
          setStatus(results[0]);
          setConfig(results[1]);
          setVoices(results[2]);
          if (!silent) setMessage(null);
        } finally {
          if (!silent) setBusy('');
        }
      }, []);

      useEffect(function () { refresh(); }, [refresh]);

      // Seed the per-preview direction from the configured one, once.
      useEffect(function () {
        if (probeInstructionSeeded.current) return;
        var stored = config && config.config && typeof config.config.instruction === 'string' ? config.config.instruction : '';
        if (!stored) return;
        probeInstructionSeeded.current = true;
        setProbeInstruction(stored);
      }, [config]);

      var value = useCallback(function (key, fallback) {
        if (Object.prototype.hasOwnProperty.call(draft, key)) return draft[key];
        var cfg = config && config.config ? config.config : {};
        if (key === 'token') return '';
        if (Object.prototype.hasOwnProperty.call(cfg, key)) return cfg[key];
        return fallback;
      }, [draft, config]);

      function set(key, next) {
        setDraft(function (current) { return Object.assign({}, current, { [key]: next }); });
      }

      async function save() {
        setBusy('save');
        setMessage(null);
        try {
          var payload = {};
          Object.keys(draft).forEach(function (key) {
            if (key === 'token') {
              payload.token = String(draft.token || '').trim();
              return;
            }
            payload[key] = draft[key];
          });
          if (Object.keys(payload).length === 0) {
            setMessage({ kind: 'info', text: '没有改动。' });
            return;
          }
          var saved = await call('/config', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          });
          var applied = saved.applied || {};
          setDraft({});
          setMessage({ kind: 'ok', text: '已保存：' + (Object.keys(applied).join('、') || '（无变化）') });
          await refresh({ silent: true });
        } catch (error) {
          setMessage({ kind: 'error', text: '保存失败：' + String(error.message || error) });
        } finally {
          setBusy('');
        }
      }

      async function chooseVoice(id) {
        var next = String(id || '').trim();
        setVoicesBusy(true);
        setMessage(null);
        setDraft(function (current) {
          var copy = Object.assign({}, current);
          delete copy.voice;
          return copy;
        });
        try {
          await call('/config', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ voice: next }),
          });
          setConfig(function (current) {
            if (!current) return current;
            return Object.assign({}, current, { config: Object.assign({}, current.config, { voice: next }) });
          });
          setMessage({ kind: 'ok', text: next ? `已切换到音色「${next}」` : '已取消音色选择' });
          await refresh({ silent: true });
        } catch (error) {
          setMessage({ kind: 'error', text: '切换失败：' + String(error.message || error) });
        } finally {
          setVoicesBusy(false);
        }
      }

      async function speakPreview() {
        var text = String(probe || '').trim();
        if (!text) {
          setMessage({ kind: 'error', text: '先写一句要念的话。' });
          return;
        }
        setBusy('speak');
        setMessage(null);
        try {
          var result = await call('/speak', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              text: text,
              voice: value('voice', ''),
              instruction: String(probeInstruction || '').trim() || value('instruction', ''),
              cfgScale: Number(value('cfgScale', 1)),
              format: value('format', 'wav'),
            }),
          });
          setProbeAudio(result.url + '?t=' + Date.now());
          setMessage({ kind: 'ok', text: '生成了 ' + (result.durationSec ? result.durationSec + 's' : '一段音频') + '，' + Math.round(result.bytes / 1024) + ' KB' });
        } catch (error) {
          setMessage({ kind: 'error', text: '合成失败：' + String(error.message || error) });
        } finally {
          setBusy('');
        }
      }

      function patchWorkshop(patch) {
        setWorkshop(function (current) { return Object.assign({}, current, patch); });
      }

      function workshopPickFile(file) {
        var reader = new FileReader();
        reader.onload = function () {
          var dataUrl = String(reader.result || '');
          var comma = dataUrl.indexOf(',');
          workshopUpload.current = {
            base64: comma > -1 ? dataUrl.slice(comma + 1) : dataUrl,
            filename: file.name,
            mime: file.type || 'audio/wav',
          };
          patchWorkshop({ fileName: file.name, fileBytes: file.size, fileReady: true, message: null });
        };
        reader.onerror = function () {
          patchWorkshop({ message: { kind: 'error', text: '读取本地文件失败' } });
        };
        reader.readAsDataURL(file);
      }

      async function workshopPreview() {
        var text = String(workshop.text || '').trim();
        if (!text) {
          patchWorkshop({ message: { kind: 'error', text: '先写一句要念的话。' } });
          return;
        }
        patchWorkshop({ busy: 'preview', message: null });
        try {
          var result = await call('/speak', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              text: text,
              voice: '',
              instruction: String(workshop.instruction || '').trim(),
              cfgScale: Number(value('cfgScale', 1)),
              format: 'wav',
            }),
          });
          patchWorkshop({
            busy: '',
            audioPath: result.path,
            audioUrl: result.url + '?t=' + Date.now(),
            message: { kind: 'ok', text: `生成了 ${result.durationSec ? result.durationSec + 's' : '一段'}样本，满意就保存为音色` },
          });
        } catch (error) {
          patchWorkshop({ busy: '', message: { kind: 'error', text: '生成失败：' + String(error.message || error) } });
        }
      }

      async function workshopSave() {
        var name = String(workshop.name || '').trim();
        if (!name) {
          patchWorkshop({ message: { kind: 'error', text: '先给音色起个名字（字母数字、- 和 _）。' } });
          return;
        }
        var payload;
        if (workshop.mode === 'clone') {
          if (!workshopUpload.current) {
            patchWorkshop({ message: { kind: 'error', text: '先选一个参考音频。' } });
            return;
          }
          if (!String(workshop.refText || '').trim()) {
            patchWorkshop({ message: { kind: 'error', text: '转录文本必须填，而且要跟录音逐字一致。' } });
            return;
          }
          payload = {
            name: name,
            refText: String(workshop.refText).trim(),
            audioBase64: workshopUpload.current.base64,
            filename: workshopUpload.current.filename,
            mime: workshopUpload.current.mime,
          };
        } else {
          if (!workshop.audioPath) {
            patchWorkshop({ message: { kind: 'error', text: '先试听一段，再保存。' } });
            return;
          }
          payload = {
            name: name,
            refText: String(workshop.text || '').trim(),
            audioPath: workshop.audioPath,
            description: String(workshop.instruction || '').trim(),
          };
        }
        patchWorkshop({ busy: 'save', message: null });
        try {
          var saved = await call('/voices/save', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          });
          if (saved.voices) setVoices(saved.voices);
          else refresh({ silent: true });
          workshopUpload.current = null;
          patchWorkshop({
            busy: '',
            name: '',
            fileReady: false,
            fileName: '',
            fileBytes: 0,
            message: { kind: 'ok', text: `已保存音色「${saved.id}」并切换过去` },
          });
          await chooseVoice(saved.id);
        } catch (error) {
          patchWorkshop({ busy: '', message: { kind: 'error', text: '保存失败：' + String(error.message || error) } });
        }
      }

      return BreezePanelView({
        status: status,
        config: config,
        voices: voices,
        busy: busy,
        message: message,
        draft: draft,
        probe: probe,
        probeInstruction: probeInstruction,
        probeAudio: probeAudio,
        workshop: workshop,
        voicesBusy: voicesBusy,
        value: value,
        set: set,
        onRefresh: function () { refresh(); },
        onSave: save,
        onReset: function () { setDraft({}); setMessage(null); },
        onSpeak: speakPreview,
        setProbe: setProbe,
        setProbeInstruction: setProbeInstruction,
        onChooseVoice: chooseVoice,
        onWorkshop: patchWorkshop,
        onWorkshopPreview: workshopPreview,
        onWorkshopSave: workshopSave,
        onWorkshopFile: workshopPickFile,
      });
    }

    // ------------------------------------------------------------ inline player
    // A speech tool call gets its own card with a real <audio> element, instead of a
    // file chip the person has to download and open elsewhere. The tool declares
    // `presentationMeta` (same-origin url + facts), which arrives here as block.meta.

    function SpeechCard(props) {
      var block = (props && props.block) || {};
      var meta = (block && typeof block.meta === 'object' && block.meta) || {};
      var running = block.kind !== 'tool-result';

      if (running) {
        return h('div', { style: S.card },
          h('div', { style: S.head },
            h('span', { style: S.dot(null) }),
            h('span', { style: S.title }, 'Breeze 合成中…'),
          ),
        );
      }
      if (block.isError === true) {
        return h('div', { style: S.card },
          h('div', { style: S.head },
            h('span', { style: S.dot(false) }),
            h('span', { style: S.title }, '合成失败'),
          ),
          h('div', { style: S.sub }, String((block.error && block.error.name) || 'error').slice(0, 200)),
        );
      }
      if (!meta.url) {
        return h('div', { style: S.card }, h('span', { style: S.sub }, '没有可播放的音频'));
      }

      var facts = [];
      if (meta.durationSec) facts.push(meta.durationSec + 's');
      if (meta.format) facts.push(meta.format);
      if (meta.bytes) facts.push(Math.round(meta.bytes / 1024) + ' KB');
      facts.push(meta.voice ? ('音色 ' + meta.voice) : '按描述生成');

      return h('div', { style: S.card, 'data-breeze': 'speech-card' },
        h('div', { style: S.head },
          h('span', { style: S.dot(true) }),
          h('span', { style: S.title }, 'Breeze 语音'),
          h('span', { style: S.sub }, facts.join(' · ')),
        ),
        meta.text ? h('div', { style: S.sub }, '「' + meta.text + '」') : null,
        h('div', { style: S.audioWrap },
          h('audio', { src: meta.url, controls: true, preload: 'metadata', style: { width: '100%' } }),
        ),
      );
    }

    // ------------------------------------------------------------ wiring

    var apply = function (ctx) {
      // Same access shape as the plugin that demonstrably works (comfyui): read the
      // `slots` service off the context directly. `tool.call.toolview` is declared by
      // ui-tool later than `settings.section` is by ui-settings, so its inject
      // callback runs on a different tick — reading the service the way the working
      // example does is what makes that deferred callback actually fire.
      var slots = ctx.slots;
      if (!slots && typeof ctx.get === 'function') slots = ctx.get('slots');
      if (!slots || typeof slots.inject !== 'function') return;

      slots.inject('settings.section', function () {
        return slots.register({
          name: 'settings.section',
          id: 'breeze',
          order: 26,
          label: function () { return 'Breeze 语音'; },
        }, BreezePanel);
      });

      // Speech tool calls render their own card with an inline player.
      slots.inject('tool.call.toolview', function () {
        return slots.register({ name: 'tool.call.toolview', key: 'breeze_speak' }, SpeechCard);
      });
      slots.inject('tool.call.toolview', function () {
        return slots.register({ name: 'tool.call.toolview', key: 'breeze_convert' }, SpeechCard);
      });
    };

    exports.inject = ['slots'];
    exports.apply = apply;
    exports.BreezePanel = BreezePanel;
    exports.BreezePanelView = BreezePanelView;
    exports.SpeechCard = SpeechCard;
    return module.exports;
  },
});
