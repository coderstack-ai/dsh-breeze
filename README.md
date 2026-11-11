# dsh-breeze

把 [Breeze-TTS-2.cpp](https://github.com/HoppouAI/Breeze-TTS-2.cpp) 接进 DeepSeek Harness：**让 agent 真的开口说话**。

> 仓库：<https://github.com/coderstack-ai/dsh-breeze> · 许可 MIT · 后端是可选的 Breeze-TTS-2.cpp（权重非商业）

装上之后，agent 有 7 个工具：把文字变成音频文件、列出/保存/删除音色、声音转换、报告服务状态、读写自己的配置。所有设置落在一个 JSON 文件里，**agent 自己就能配完，不用重启、不用点界面**。

```
breeze_speak  ── 文字 → 音频文件（wav / mp3 / pcm）
breeze_voices ── 列出音色（含参考文本与描述）
breeze_voice_save   ── 把一段参考音频存成可复用音色
breeze_voice_delete ── 从服务内存里卸载音色
breeze_convert      ── 换声：保留表演，只换音色（上游 experimental）
breeze_status       ── 服务通不通、当前默认值是什么
breeze_config       ── 读/写插件设置
```

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

4. 浏览器开 <http://127.0.0.1:8080/> 看到 web UI 就说明活了；或者：

```bash
curl http://127.0.0.1:8080/health
# {"status":"ok","sample_rate":24000,"ws_port":8081}
```

**B. 已经有现成的服务**（远程、Docker、别人给你搭的）—— 只要有 URL，能过 `/health` 就行。服务端若在反向代理后面加了鉴权，把 token 一起给插件。

> ⚠️ Breeze 服务端**自己没有鉴权、没有限速**（上游原话）。要么绑 `127.0.0.1`，要么前面挂一层带鉴权的反代。

---

## 二、装插件

仓库：<https://github.com/coderstack-ai/dsh-breeze>

**从 GitHub 装**（推荐，装完即可用）：

```bash
plugin_manager install_bundle  target = https://github.com/coderstack-ai/dsh-breeze.git
```

**从本地 checkout 装**（改代码时用；`link:` 装的是目录本身，改完不用重新安装）：

```bash
plugin_manager install_bundle  target = link:<这个仓库在你机器上的绝对路径>
```

改了源码要让它生效，重新启用一次插件行即可（HMR 在时不用重启 DSH）：

```
plugin_manager set_plugin target=include:breeze enabled=false
plugin_manager set_plugin target=include:breeze enabled=true
```

装完 DSH 里就有 `breeze_*` 工具了。

---


## 三、配一次

**最省事：让 agent 自己配。**

> 帮我把 breeze 接到 `https://breeze.0444.top`，token 是 `<TOKEN>`，默认音色 `female_001`。

agent 会调 `breeze_config` 写入，然后 `breeze_status` 验证，把结果贴给你。

**或者手写配置文件** —— 唯一真源在：

```
<home>/.dsh/dsh-breeze/config.json
```

```json
{
  "version": 1,
  "baseUrl": "http://127.0.0.1:8080",
  "wsUrl": "",
  "wsPort": 8081,
  "wsPath": "/",
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
| `wsUrl` | 完整 WebSocket URL，填了就只用它（不再推导、不回退）。适合地址和 HTTP 完全不同的部署 |
| `wsPort` | WebSocket 监听端口，默认 **8081**（上游就是 HTTP 端口 + 1）。`0` = 跟随 `/health` 的 `ws_port` |
| `wsPath` | WebSocket 路径，默认 **`/`** —— 这就是上游 listener 原始形态；只有反代改写过路径时才需要填别的（比如 `/ws`） |
| `token` | 可选 Bearer；反代加了鉴权就填（nginx 与鉴权写法见第四节） |
| `format` | `wav`（默认，严格 24 kHz 单声道 16 bit）/ `mp3`（80 kbps 单声道 48 kHz）/ `pcm`（无头 s16le） |
| `voice` | 默认音色 id；留空表示靠 `instruction` 现场设计音色 |
| `instruction` | 默认音色描述/表演指令 |
| `cfgScale` | 1 = 关闭引导；**2~3 才能让括号里的语气事件真的生效**；超过 3 会发糙 |
| `seed` | 随机种子；同文本+音色+指令+种子 = 同一段音频 |
| `outputDir` | 音频落盘目录，留空 = `<home>/.dsh/dsh-breeze/audio` |
| `autostart` + `serverCommand`/`serverArgs`/`serverCwd` | 服务没起时自动拉起本地 `breeze-server`（只对它自己起的进程负责） |

改完**不用重启**：下一次工具调用就生效（每次调用都读磁盘）。

跨机或上公网要走反代时，别跳过下一节：Breeze 自己没有鉴权，`baseUrl` 换成一个裸的 https 域名而不配 `token`，等于把模型端口公开。

**Docker / 服务以 SYSTEM 账户跑时**：`os.homedir()` 指向 `C:\Windows\System32\config\systemprofile`，和你看的不是同一个 home。这时用环境变量指死：

```
DSH_BREEZE_HOME=<状态目录>            # 目录
DSH_BREEZE_CFG=<配置文件的完整路径>   # 或直接指定文件
```

---

## 四、走 nginx 反向代理与鉴权

Breeze 服务端**自己没有鉴权、也没有限速**（上游 README 原话）。想跨机或上公网，就得在前面挡一层。插件对两种形态都支持：

| 形态 | 配置 | 适用 |
| --- | --- | --- |
| 直连 | `baseUrl=http://127.0.0.1:8080`，`token` 留空 | 本机或内网 |
| 反代 + 鉴权 | `baseUrl=https://breeze.example.com`，`token=<TOKEN>` | 跨机、公网、多客户端共享 |

插件在**每一个** HTTP 请求和 WebSocket 握手请求上都带 `Authorization: Bearer <token>`，所以反代只要认这个头就行。

### 4.1 插件侧要填的四个字段

| 字段 | 说明 |
| --- | --- |
| `baseUrl` | 反代的 https 地址，**不要**结尾斜杠 |
| `token` | 反代要求的 Bearer token；面板里是明文输入框，也可用 `breeze_config` 写 |
| `wsPort` | WebSocket 端口。反代通常把 WS 也放在 443 上，就填 `443` |
| `wsPath` | WebSocket 路径。**原始 listener 只认 `/`**；反代改写过路径时填那个路径（例如 `/ws`） |

`wsPort` / `wsPath` 决定候选顺序：先试 `wss://<host>:<wsPort><wsPath>`，不通再试同源 `/ws`。填对第一个能省一次失败探测。

### 4.2 nginx 参考配置

Breeze 的 WebSocket 是**第二个监听器**（cpp-httplib 没有 WS 支持，所以另开一个端口手写 RFC 6455），它**不认任何路径前缀**。因此 nginx 必须：

1. 把某个公开路径**重写**到 `/`（`proxy_pass` 末尾那个斜杠）
2. 放行 `Upgrade` / `Connection` 头
3. 给长会话足够的超时

```nginx
# http{} 层：WebSocket 升级所需的变量，全局只能定义一次
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}

server {
    listen 443 ssl;
    server_name breeze.example.com;

    ssl_certificate     /path/to/fullchain.pem;
    ssl_certificate_key /path/to/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;

    # ---------- HTTP（普通合成 / 音色管理 / 转换）----------
    location / {
        # 鉴权：认 Bearer 头（下面 4.3 有其它做法）
        if ($http_authorization != "Bearer <TOKEN>") {
            return 401;
        }

        proxy_pass http://127.0.0.1:8080;   # 注意：这里不要加末尾斜杠
        proxy_http_version 1.1;

        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;

        # 音频是 chunked 流：不关缓冲，客户端要等整段生成完才开始播
        proxy_buffering off;

        # 参考音频上传（POST /v1/voices、/v1/audio/convert）
        client_max_body_size 32m;

        proxy_read_timeout 300s;
    }

    # ---------- WebSocket（流式合成）----------
    # ^~ 让 /ws、/ws/、/ws/xxx 都进这里，优先于 location /
    location ^~ /ws {
        if ($http_authorization != "Bearer <TOKEN>") {
            return 401;
        }

        # ★ 末尾的斜杠把 /ws 重写成 /，因为上游 listener 只认根路径
        proxy_pass http://127.0.0.1:8081/;

        proxy_http_version 1.1;
        proxy_set_header Upgrade    $http_upgrade;
        proxy_set_header Connection $connection_upgrade;

        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;

        # 一个会话要跨很多轮，空闲可能很久；300s 会把长会话掐断
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
        proxy_buffering    off;
    }
}
```

> **端口对不上是常态。** `/health` 里的 `ws_port` 是**进程内视角**（例如容器里的 8080+1=8081），对外它可能是 9005、也可能根本没暴露。插件不拿它当真理：`wsPort` 由你在配置里指定，插件只把 `/health` 的值当作 `wsPort=0` 时的兜底。

### 4.3 鉴权的三种做法

| 做法 | 谁能用 | 说明 |
| --- | --- | --- |
| **Bearer 头**（推荐） | agent、curl、Node/Python 客户端 | 插件默认就这么发；nginx 用 `$http_authorization` 判定 |
| **query 参数** | 浏览器页面里的 `WebSocket` | 浏览器 WebSocket **不能设置请求头**，只能把 token 放 URL |
| **Cookie** | 同域浏览器页面 | 适合已经有登录态的前端 |

**浏览器 WebSocket 那条限制值得单独记住**：`new WebSocket('wss://host/ws')` 没有第二个参数能塞 header。所以只要你的前端要在页面里连 WS，鉴权就不能只认 Bearer 头，得额外放行一种带外凭证：

```nginx
# 允许 ?token=... 连 WS；token 建议用足够长的随机串，并且只给 WS 用
map $arg_token $ws_query_ok {
    default 0;
    "<TOKEN>" 1;
}

location ^~ /ws {
    if ($http_authorization != "Bearer <TOKEN>") {
        set $ws_auth "";
    }
    # 头或 query 任一通过即可
    if ($ws_auth = "") {
        if ($ws_query_ok = 0) {
            return 401;
        }
    }
    ...
}
```

> nginx 的 `if` 嵌套限制多，实际部署更稳的写法是用 `map` 合成一个变量，或者干脆给 WS 单独一个子域（`ws.breeze.example.com`），鉴权规则分开写。

### 4.4 排错：症状 → 原因

插件把失败原因直接说出来，对照着看就行：

| 症状 | 原因 |
| --- | --- |
| `401` | 没带 token、token 写错，或 nginx 的判定变量没生效 |
| `404`（访问 `/ws`） | `location` 没配，或 `proxy_pass` 没加末尾斜杠（路径没重写成 `/`） |
| `200`（访问 `/ws`） | `Upgrade`/`Connection` 头没透传，或这个路径被转去了 HTTP 端口 |
| 超时、无响应 | 端口没在防火墙/安全组放行（连 `ECONNREFUSED` 都没有，是丢包） |
| 握手 101 但收不到 `ready` | 对端不是 Breeze 的 WS listener（比如转到了别的服务） |
| HTTP 能用、WS 一直不行 | `wsPort` 填的是容器内端口，对外并不可达 |

### 4.5 验证

```bash
# 面板「状态行」里那一行（绿=可达 / 红=原因）
# 工具里的候选列表与配置
breeze_status

# 只做握手 + 读 ready，不生成音频、不花 GPU
BREEZE_TOKEN=<TOKEN> node tools/check-ws.mjs wss://breeze.example.com/ws
```

`check-ws.mjs` 成功时打印：

```
PASS  handshake 101 + Sec-WebSocket-Accept verified
PASS  ready frame  sample_rate=24000 format=s16le
```

失败时会明确说是 `401`（鉴权）、`404`（路径没重写）、`200`（Upgrade 头丢了）还是超时。

---

## 五、设置界面

装了插件之后，DSH 的 **设置 → 内置插件** 里会多一个 **「Breeze 语音」** 标签页（order 40，排在只读清单后面）：

自上而下四块：

| 顺序 | 区块 | 能做什么 |
| --- | --- | --- |
| 1 | 状态行 | 服务可不可达、采样率、鉴权方式；**下面独立一行显示 WebSocket 状态**（灰色=探测中 / 绿色=可达并给出 URL·端口·路径·握手耗时 / 红色=不可达并给出原因：`404` 路径没重写、超时 端口没暴露、`401` token 不对）；再下面是配置文件路径；带「刷新」。WS 探测单独异步跑，不拖慢主状态 |
| 2 | 连接设置 | 服务地址、Bearer Token、**WebSocket 端口（8081）**、**WebSocket 路径（`/`）**、输出格式、cfgScale、seed；「保存」写回 JSON |
| 3 | 音色工坊 | 顶部一个**下拉**选动作：**设计新音色**（描述 + 朗读文本 → 试听 → 「保存为音色」把刚试听那段存下来）/ **克隆参考音频**（选本地 WAV + 逐字转录 → 「保存音色」）。名字允许字母数字、`-`、`_`（会变成服务端文件名）。保存成功后**自动切换到新音色**，不用再去音色库点一次 |
| 4 | 音色库 | 一个**下拉**只列真实存在的音色（saved/cached + 时长），选中项下面显示时长与描述；**选完立即写回配置生效**，不用再按保存。造新声音是音色工坊的事，这里不提供「无音色 / 现场设计」入口；确实没选音色时显示一行不可选的「（未选择音色）」 |
| 5 | 试听 | 一段话 + **一段本次试听专用的表演描述**（留空就用配置文件里那条），点「合成并试听」，页面里直接出 `<audio>` 播放器 |

**输出目录与全局描述不在面板上**：两者都是低频项，仍可用 `breeze_config` 工具或直接改 `config.json` 设置（`outputDir` / `instruction`）。面板上的描述输入移到了「试听」卡里，只影响那一次合成，不会被保存；工坊有自己的描述框。

音色工坊的两个模式都不需要 agent 参与：设计模式先合成一段样本给你**听完再决定**要不要存，克隆模式把本地文件读成 base64 交给 host，由 host 转成 multipart 发给 Breeze（浏览器不直连服务端）。

两点设计约束：

- **Bearer Token 没有默认值，也不预填**。输入框初始为空；你敲进去的内容**明文显示**（不遮点）；保存时按你填的原样写入，把框删空再保存 = 删除已存的 token。`GET /dsh-breeze-api/config` 仍然只回 `***`，页面拿不到已存的凭据。
- **面板只走同源** `/dsh-breeze-api/*`，不直连 Breeze，也不带跨域。

**看不到这个标签页？**

1. 刷新一次页面（`Ctrl+R`）。启动图里新增的客户端 bundle 要重新取一次 index 才认得。
2. 还不行就完全退出并重启 DSH。首次注册客户端半侧属于"新增一行启动图"，热替换只能改已存在的行。
3. 打开 DevTools Console，搜 `dsh-breeze`：
   - `could not load "dsh-breeze": ... loaded without registering "dsh-breeze"` ⇒ bundle 里的 `id` 和包名不一致（本插件已保证一致，出现即说明文件被改过）。
   - `unexpected require("…")` ⇒ 用了 `dsh.client.external` 之外的模块。

---

## 六、怎么用

### 说一句话

> 用女声说一句「今天的会议推迟到下午三点」，温柔一点，然后放给我听。

agent 调 `breeze_speak`，拿到路径后再用 `present` 给你。

### 克隆一个音色

1. 准备一段参考音频（24 kHz 单声道 WAV 编码效果最好）+ **逐字准确的转写文本**。
2. 保存：

> 把 `voices/me.wav` 存成音色 `myself`，内容是「今天天气不错，我们出去走走吧」。

3. 之后只要 `voice: "myself"`，不用再传参考音频 —— 省掉每次约 550 ms 的编码。

### 设计音色（不需要参考音频）

> 用「一个温柔、语速偏慢的年轻女声」这个描述说一句「晚风起来了」。

`instruction` 写清五件事（年龄/性别/音色/语速/情绪），一句话说完，**语言要和朗读文本一致**——官方原文：`Match the instruction language to the target text.`

### 语气事件（笑、叹气、咳嗽）

文本里用圆括号标：

```
(sigh) 我本来不想说的。
(laugh) 你可算来了。
```

**必须把 `cfgScale` 提到 2~3**，否则模型多半按中性朗读处理（官方说明：`1.0` 时它把 tag 当建议）。词表是**开放**的，`(nervous chuckle)`、`(whispering)` 也常能用。

### 换声（experimental）

> 把 `recordings/take.wav` 换成 `female_001` 的声音，原文是「……」

保表演、换音色；音高会按目标声音的声区重生成，所以唱的可能跑调半个八度。**给 `text` 上传源文本很重要**，官方实测：同一段清唱，不给文本听成「Does it pinch I?」，给了才听成原词。

---

## 七、HTTP 接口

插件在 DSH 宿主端口上挂了一条前缀路由（给 UI 或脚本用）：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/dsh-breeze-api/status` | 服务可达性 + 当前默认值 |
| GET/PUT | `/dsh-breeze-api/config` | 读（token 已脱敏）/ 写设置 |
| GET | `/dsh-breeze-api/voices` | 音色列表 |
| POST | `/dsh-breeze-api/speak` | `{ text, voice?, instruction?, cfgScale?, seed?, format? }` → 音频 URL |
| POST | `/dsh-breeze-api/voices/save` | 存音色。两种来源：`audioPath`（插件刚生成的文件）+ `refText`，或 `audioBase64` + `filename` + `refText`；都可带 `description` |
| DELETE | `/dsh-breeze-api/voices/<id>` | 从服务端内存卸载音色（`.breeze` 文件保留，重启会回来） |
| GET | `/dsh-breeze-api/ws` | WebSocket 探测：`{ reachable, url, source, candidates, error, ms }` |
| GET | `/dsh-breeze-api/audio/<file>` | 播放/下载生成的音频（路径穿越已挡） |

> DSH 的路由表按 `(kind, path)` 判重、**不看 method**。所以同一条路径的 GET 与 PUT 必须在**一次** `register` 里按 `req.method` 分发 —— 拆成两次会让整个 apply 抛错，表现为「页面还在、功能全死」。本插件所有路由都在这一个前缀下分发。

---

## 八、自检

```bash
# 静态 + 接线（不联网）
node tools/selftest.mjs

# 宿主路由：起一个假 Breeze，验证存音色真的发出了合法的 multipart
node tools/routes-selftest.mjs

# WebSocket 客户端与端点回退：本地起两个模拟 listener，不联网
node tools/ws-selftest.mjs

# 面板渲染：用真 react 跑客户端 bundle，断言卡片顺序与控件
npm install --no-save react@18 react-dom@18 && node tools/ui-smoke.mjs

# 反代连通性：只握手 + 读 ready，不生成音频、不花 GPU
BREEZE_TOKEN=<TOKEN> node tools/check-ws.mjs wss://breeze.example.com/ws

# 再加一层真机：/health、/v1/voices、真合成一段、回读 WAV 头
DSH_BREEZE_BASE=https://breeze.example.com DSH_BREEZE_TOKEN=<TOKEN> \
  node tools/selftest.mjs --live
```

自检跑到临时目录里，**不碰你的真实配置**；live 那一层会故意留下一个 wav 作为证据。

---

## 九、已知边界

| 项 | 说明 |
| --- | --- |
| 没有设置面板 UI | 本版只做 host 侧能力（工具 + 路由）。配置走 `breeze_config` 或改 JSON，都能被 agent 完成 |
| 不会替你装服务 | 要下几 GB 权重、可能要装显卡驱动 —— 这只能人来做 |
| 不判断好不好听 | 程序只能证明「出了一段合法 wav」，音色好不好只能人听 |
| 音色名不支持中文 | 服务端的限制（名字要变文件名），不是插件能改的 |
| 卸载音色 ≠ 删文件 | `DELETE /v1/voices/<id>` 只从内存摘掉，`.breeze` 文件还在，重启就回来 |
| `mp3` 在没编 MP3 的构建上会变 WAV | 上游：`-DBREEZE_MP3=OFF` 时请求 mp3 返回 wav；插件会自己认出来并按 wav 处理 |

---

## 十、许可

插件本体 MIT（见 [LICENSE](LICENSE)）。模型权重是**非商业许可**，服务的部署与使用由部署者负责；克隆任何人的声音前先取得同意。来源与细节见 [NOTICE.md](NOTICE.md)。
