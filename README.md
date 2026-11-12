# dsh-breeze

把 [Breeze-TTS-2.cpp](https://github.com/HoppouAI/Breeze-TTS-2.cpp) 接进 DeepSeek Harness：**让 agent 真的开口说话**。

> 仓库：<https://github.com/coderstack-ai/dsh-breeze> · 许可 MIT · 后端是可选的 Breeze-TTS-2.cpp（权重非商业）

一个 DSH 插件，两半：

| 一半 | 内容 |
| --- | --- |
| **工具**（模型调用） | 7 个 `breeze_*`：合成语音、列出/保存/删除音色、换声、查状态、改配置 |
| **设置分区**（人操作） | 设置里的独立一项 **「Breeze 语音」**：连接、音色工坊、音色库、试听 |

不含 WebSocket 客户端，不含自动朗读。音频写成本地文件，路径交给模型；要听就播放。

---

## 一、先有一个 Breeze 服务端

插件不含模型，只连服务端。两种方式：

**A. 用预编译包（推荐）**

1. 到 [releases](https://github.com/HoppouAI/Breeze-TTS-2.cpp/releases) 下 Windows/Linux 预编译包（Vulkan，NVIDIA/AMD/Intel 都行，没显卡自动退 CPU）。
2. 到 [HuggingFace](https://huggingface.co/HoppouAI/Breeze-TTS-2.cpp) 下 GGUF 权重（含 `audio_tokenizer/` 目录）。Q8_0 约 3.3 GB，建议 4 GB 显存起。
3. 起服务：

```bash
breeze-server breeze-tts-2-q8_0.gguf --host 127.0.0.1 --port 8080 --webui
```

4. 验证：

```bash
curl http://127.0.0.1:8080/health
# {"status":"ok","sample_rate":24000,"ws_port":8081}
```

> `ws_port` 是服务端自己的 WebSocket 端口，**本插件不用它**，可以忽略。

**B. 已经有现成的服务** —— 只要有 URL，能过 `/health` 就行；服务端在反代后面加了鉴权就把 token 一起给插件。

> ⚠️ Breeze 服务端**自己没有鉴权、没有限速**（上游原话）。要么绑 `127.0.0.1`，要么前面挂一层带鉴权的反代 —— 见第四节。

---

## 二、装插件

```bash
# 从 GitHub 装（推荐，装完即可用）
plugin_manager install_bundle  target = https://github.com/coderstack-ai/dsh-breeze.git

# 从本地 checkout 装（改代码时用；link: 装的是目录本身，改完不用重新安装）
plugin_manager install_bundle  target = link:<这个仓库在你机器上的绝对路径>
```

改了源码要让它生效，重新启用一次插件行（HMR 在时不用重启 DSH）：

```
plugin_manager set_plugin target=include:breeze enabled=false
plugin_manager set_plugin target=include:breeze enabled=true
```

装完 DSH 里就有 `breeze_*` 工具，设置里多一项「Breeze 语音」。

---

## 三、配置

**最省事：让 agent 自己配。**

> 帮我把 breeze 接到 `https://breeze.example.com`，token 是 `<TOKEN>`。

agent 会调 `breeze_config` 写入，再用 `breeze_status` 验证。

**或者手写配置文件** —— 唯一真源在：

```
<home>/.dsh/dsh-breeze/config.json
```

```json
{
  "version": 1,
  "baseUrl": "http://127.0.0.1:8080",
  "token": "",
  "format": "wav",
  "voice": "",
  "instruction": "Speak clearly and naturally.",
  "cfgScale": 1,
  "seed": 42,
  "timeoutMs": 180000,
  "outputDir": "",
  "autostart": false,
  "serverCommand": "",
  "serverArgs": [],
  "serverCwd": "",
  "startupTimeoutMs": 180000
}
```

| 字段 | 说明 |
| --- | --- |
| `baseUrl` | 服务端地址，不要结尾斜杠 |
| `token` | 可选 Bearer；反代加了鉴权就填 |
| `format` | `wav`（默认，严格 24 kHz 单声道 16 bit）/ `mp3`（80 kbps 单声道 48 kHz）/ `pcm`（无头 s16le） |
| `voice` | 默认音色 id；留空表示靠 `instruction` 现场设计音色 |
| `instruction` | 默认表演描述；agent 调用时不传 `instruction` 就用它 |
| `cfgScale` | 1 = 关闭引导；**2~3 才能让括号里的语气事件真的生效**；超过 3 会发糙 |
| `seed` | 随机种子；同文本+音色+描述+种子 = 同一段音频 |
| `outputDir` | 音频落盘目录，留空 = `<home>/.dsh/dsh-breeze/audio` |
| `autostart` + `serverCommand`/`serverArgs`/`serverCwd` | 服务没起时自动拉起本地 `breeze-server`（只对它自己起的进程负责） |

改完**不用重启**：下一次工具调用就生效（每次调用都读磁盘）。

**Docker / 服务以 SYSTEM 账户跑时**：`os.homedir()` 指向 `C:\Windows\System32\config\systemprofile`，和你看的不是同一个 home。这时用环境变量指死：

```
DSH_BREEZE_HOME=<状态目录>            # 目录
DSH_BREEZE_CFG=<配置文件的完整路径>   # 或直接指定文件
```

---

## 四、走 nginx 反向代理与鉴权

Breeze 服务端自己没有鉴权。跨机或上公网时，反代要挡住两件事：**访问控制**和**上传体积**（参考音频）。

插件在**每个** HTTP 请求上带 `Authorization: Bearer <token>`，反代认这个头就行：

```nginx
server {
    listen 443 ssl;
    server_name breeze.example.com;

    ssl_certificate     /path/to/fullchain.pem;
    ssl_certificate_key /path/to/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;

    location / {
        # 只放行带正确 Bearer 的请求
        if ($http_authorization != "Bearer <TOKEN>") {
            return 401;
        }

        proxy_pass http://127.0.0.1:8080;   # 注意：不要加末尾斜杠
        proxy_http_version 1.1;

        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;

        # 音频是 chunked 流：不关缓冲，客户端要等整段生成完才开始播
        proxy_buffering off;

        # 参考音频上传（POST /v1/voices、POST /v1/audio/convert）
        client_max_body_size 32m;

        proxy_read_timeout 300s;
    }
}
```

排错：症状 → 原因

| 症状 | 原因 |
| --- | --- |
| `401` | 没带 token、token 写错，或 `if` 里的判定没生效 |
| `502` | nginx 连不上上游 —— `ss -ltnp \| grep <端口>` 看进程，`sudo tail /var/log/nginx/error.log` 看原话 |
| 超时无响应 | 端口没在防火墙/安全组放行 |

> 本插件**只用 HTTP**。Breeze 另有一个 WebSocket 监听器（默认 HTTP+1），插件不连它。

---

## 五、设置分区

设置 → 左侧导航 → **「Breeze 语音」**（独立分区，不在「内置插件」里）。自上而下五块：

| 顺序 | 区块 | 能做什么 |
| --- | --- | --- |
| 1 | 状态行 | 服务可不可达、采样率、鉴权方式、配置文件路径；带「刷新」 |
| 2 | 连接设置 | 服务地址、Bearer Token、输出格式、cfgScale、seed、表演描述（全局）；「保存」写回 JSON |
| 3 | 音色工坊 | 下拉选动作：**设计新音色**（描述 + 朗读文本 → 试听 → 保存）/ **克隆参考音频**（本地 WAV + 逐字转录 → 保存）。保存后自动切过去 |
| 4 | 音色库 | 一个下拉列出全部音色（saved/cached + 时长），选中项下面显示描述；**选完立即写盘生效** |
| 5 | 试听 | 一段话 + 一段本次试听专用的表演描述，合成后**页面里直接出播放器** |

几个刻意设计：

- **Bearer Token 不预填**：输入框初始为空，敲进去的内容明文显示；保存时按原样写入，删空再保存 = 删除已存的 token。`GET /dsh-breeze-api/config` 只回 `***`。
- **音色只在音色库选**：造声音是工坊的事，音色库只列真实存在的音色。
- **工坊保存后自动选中**：造完就能用，不用再点一次。

---

## 六、怎么用

### 说一句话

> 用女声说一句「今天的会议推迟到下午三点」，温柔一点。

agent 调 `breeze_speak`，拿到路径。音频就写在你配置的输出目录里。

### 克隆一个音色

1. 准备一段参考音频（24 kHz 单声道 WAV 编码效果最好）+ **逐字准确的转写文本**。
2. 设置 → Breeze 语音 → 音色工坊 → 克隆参考音频 → 选文件、填转录、起名、保存。
3. 之后只要 `voice: "<名字>"`，不用再传参考音频 —— 省掉每次约 550 ms 的编码。

### 设计音色（不需要参考音频）

在工坊的「设计新音色」里：填描述、填一句朗读文本、点「试听这段」，满意再「保存为音色」。

描述写清五件事（年龄/性别/音色/语速/情绪），并且**语言和朗读文本一致** —— 官方原文：`Match the instruction language to the target text.`

### 语气事件（笑、叹气、咳嗽）

文本里用圆括号标：

```
(sigh) 我本来不想说的。
(laugh) 你可算来了。
```

**必须把 `cfgScale` 提到 2~3**，否则模型多半按中性朗读处理。词表是**开放**的，`(nervous chuckle)`、`(whispering)` 也常能用。

### 换声（experimental）

> 把 `recordings/take.wav` 换成 `female_001` 的声音，原文是「……」

保表演、换音色；音高会按目标声音的声区重生成，所以唱的可能跑调半个八度。**给 `text` 上传源文本很重要**：同一段清唱，不给文本听成「Does it pinch I?」，给了才听成原词。

### 怎么听生成的结果

| 方式 | 点击 | 说明 |
| --- | --- | --- |
| 设置 → 试听 | 页面里直接有播放器 | 手动试听用 |
| 播放页链接 | 1 次 | `http://<宿主>/dsh-breeze-api/player/<文件>` 返回一个小页面，内嵌播放器并自动播 |
| 对话里的工具卡片 | 2 次 | 展开工具调用行 → 内嵌播放器（展开与否由宿主决定，插件改不了） |

> **对话正文里嵌不了播放器**：DSH 的 markdown 只把 `![]()` 渲染成图片，没有针对 `<audio>` 的通道（原始 HTML 只在启动占位处放行）。所以正文里最多给一个播放页链接。

---

## 七、HTTP 接口

挂在 DSH 宿主端口上，**只应答本机回环**客户端（其它来源 403）。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/dsh-breeze-api/status` | 可达性 + 当前默认值 |
| GET/PUT | `/dsh-breeze-api/config` | 读（token 脱敏）/ 写设置 |
| GET | `/dsh-breeze-api/voices` | 音色列表 |
| POST | `/dsh-breeze-api/voices/save` | 存音色：`audioPath`（插件刚写的文件）或 `audioBase64` + `filename`，都要 `refText` |
| DELETE | `/dsh-breeze-api/voices/<id>` | 从服务端内存卸载音色（`.breeze` 文件保留） |
| POST | `/dsh-breeze-api/speak` | `{ text, voice?, instruction?, cfgScale?, seed?, format? }` → 音频 URL |
| GET | `/dsh-breeze-api/audio/<file>` | 音频本体（`audio/wav` 等） |
| GET | `/dsh-breeze-api/player/<file>` | 一个内嵌播放器的小页面 |

> DSH 的路由表按 `(kind, path)` 判重、**不看 method**。同一条路径的 GET 与 PUT 必须在**一次** `register` 里按 `req.method` 分发 —— 拆成两次会让整个 apply 抛错。

---

## 八、自检

```bash
# 静态 + 接线（不联网）：工具定义、schema 子集、apply、路由、配置读写、WAV 头
node tools/selftest.mjs

# 面板渲染：用真 react 跑客户端 bundle，断言分区注册与卡片顺序
npm install --no-save react@18 react-dom@18 && node tools/ui-smoke.mjs

# 真机：/health、/v1/voices、真合成一段、回读 WAV 头
DSH_BREEZE_BASE=https://breeze.example.com DSH_BREEZE_TOKEN=<TOKEN> \
  node tools/selftest.mjs --live
```

自检跑到临时目录里，**不碰你的真实配置**；live 那一层会故意留下一个 wav 作为证据。

---

## 九、已知边界

| 项 | 说明 |
| --- | --- |
| 对话正文里没有内嵌播放器 | DSH 的 markdown 不支持 `<audio>`，只能给播放页链接或展开工具卡片 |
| 工具卡片默认折叠 | 宿主行为（`open = expanded && expandable`），插件无法让它默认展开 |
| 没有自动朗读 | 已移除。要边生成边播需要流式文本事件，DSH 不向插件暴露 |
| 不会替你装服务 | 要下几 GB 权重、可能要装显卡驱动 —— 这只能人来做 |
| 不判断好不好听 | 程序只能证明「出了一段合法 wav」，音色好不好只能人听 |
| 音色名不支持中文 | 服务端的限制（名字要变文件名） |
| 卸载音色 ≠ 删文件 | `DELETE /v1/voices/<id>` 只从内存摘掉，`.breeze` 文件还在，重启就回来 |
| `mp3` 在没编 MP3 的构建上会变 WAV | 上游：`-DBREEZE_MP3=OFF` 时请求 mp3 返回 wav；插件会认出来并按 wav 处理 |

---

## 十、许可

插件本体 MIT（见 [LICENSE](LICENSE)）。模型权重是**非商业许可**，服务的部署与使用由部署者负责；克隆任何人的声音前先取得同意。来源与细节见 [NOTICE.md](NOTICE.md)。
