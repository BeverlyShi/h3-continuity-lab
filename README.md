# H3 Continuity Lab

H3 Continuity Lab is an interactive story game where an AI director writes each scene of a palace drama and turns it into a continuous, multi-segment video. You pick one of three choices (or type your own action), the director publishes the next scene, casts actors from your local actor library, and writes shot-by-shot prompts that are rendered with MiniMax H3 via fal or Comfy Cloud, each segment continuing from the last frame of the previous one. It is bring-your-own-key: your API keys stay in your browser, and the director agent runs entirely client-side. Built with React, TypeScript and Vite.

## 项目简介

一个「互动剧情 + AI 导演 + 连续场景视频」的实验项目。故事是《后宫》：玩家扮演一名初入宫闱的秀女，导演 agent 根据玩家的每次选择推进剧情，并把每个场次拍成一段连续的视频。

术语：

- **场次**：导演发布的一段剧情（narrative），附带三个选项。
- **段**：一个视频 prompt，提交一次生成得到一个视频文件；每个场次 2～3 段。
- **镜头**：段内两次硬切之间的连续画面。

## 玩法

1. 打开右上角设置，填写 API Key（见下一节）。
2. 在「演员库」里上传演员三视图（可选）。导演选角时找不到合适演员，会自己新建演员并给出一条生图 prompt，你在外部生成图片后上传即可；没有图片时按文字外观生成。
3. 在「游戏互动」里选择视频生成方式（API 生成 = fal，ComfyUI 生成 = Comfy Cloud），点击开始。
4. 导演每个场次交付三样东西：剧情与选项、选角、整场 2～3 段分镜。页面按段依次生成视频，第 N 段以第 N−1 段的最后一帧作为画面参考，所以段与段之间是接着拍的；下一场次开始时，导演可以查看上一场次最后一帧，决定接着拍还是换场景。
5. 整场视频完成后选择选项或输入自由行动，进入下一场次；也可以「跳过视频，直接选择」。某一段不满意时可以重新生成，或写一句原因「让导演重写」这一段。
6. 已发生的场次可以随时回看，回看不会推进剧情或调用 API。

右侧导演面板可切换导演模型；DeepSeek V4 Flash 与 GLM-5.3-Flash 有思考强度开关。ComfyUI 生成默认由你点击「生成本场次视频」后才提交（按秒消耗 Comfy 积分），可打开「自动生成」。

## 需要哪些 Key

**导演模型：至少填一个**

| Key | 用途 | 申请 |
| --- | --- | --- |
| DeepSeek | 导演模型 DeepSeek V4 Flash；同时用于尾帧识别（查看上一场次最后一帧，决定下一场次能否接着拍）。没有 DeepSeek Key 时，每个场次只能换新画面开场 | https://platform.deepseek.com |
| OpenRouter | 导演模型 Gemini 2.5 Flash-Lite、GPT-OSS 20B | https://openrouter.ai |
| 智谱 BigModel | 导演模型 GLM-5.3-Flash | https://open.bigmodel.cn |

**视频生成：fal 或 Comfy Cloud 二选一**

| Key | 用途 | 申请 |
| --- | --- | --- |
| fal | 「API 生成」：调用 fal 上的 MiniMax H3 Max（有参考图用参考生视频，没有用文生视频），分镜写好后自动逐段生成 | https://fal.ai |
| Comfy Cloud | 「ComfyUI 生成」：在你的 Comfy Cloud 订阅上运行 H3 官方工作流，按秒消耗积分 | https://platform.comfy.org |

## 隐私与 Key 说明

本项目没有账号体系，也没有存储用户数据的服务端。

- **Key 只存在你的浏览器里**（localStorage），不会保存到本站。
- **模型请求和 fal 请求由浏览器直连厂商**（DeepSeek、OpenRouter、智谱、fal），不经过本站。
- **Comfy 请求经本站转发**：Comfy Cloud 不允许浏览器跨域访问，所以页面把请求发到同源的 `/api/comfy/*`，转发层只把请求原样转给 Comfy Cloud，不存储、不记录 Key 和内容。
- **导演会话与游戏存档都在浏览器本地**（IndexedDB / localStorage）。设置弹窗里的「清理本地视频与存档」会删除游戏存档、导演会话历史和本地视频（保留 Key、模型设置和演员库）；「清除 Keys」会删除所有 Key。
- 建议为本项目单独创建 Key，并在厂商控制台设置额度上限。在公用电脑上用完请点「清除 Keys」。

## 架构

```text
浏览器（纯静态页面）
├── 页面（React）：游戏、演员库、设置
├── 导演 agent（src/director）：Pi Agent Core 运行在浏览器里
│     ├── 直连 DeepSeek / OpenRouter / 智谱 ── 生成剧情、选角、分镜
│     └── 直连 DeepSeek Vision ─────────────── 尾帧识别
├── 视频生成
│     ├── fal：浏览器直连 fal
│     └── Comfy：src/comfy 组装工作流 ──→ 同源 /api/comfy/* ──→ Comfy Cloud
└── 本地存储：localStorage（Key、设置、存档）、IndexedDB（导演会话、视频、图片、演员库）

转发层（worker/comfyProxy.ts）
└── 只放行少数几个 Comfy 接口，透传 X-API-Key，不存储、不记录
    开发时由 server/comfyPlugin.ts 挂到 Vite 开发服务器；上线后跑在 Cloudflare Worker 里
```

### 导演 agent

- 一个 agent、一个持久会话。每个场次由同一个 agent 一次跑完，用四个工具交付：
  - `publish_scene`：发布剧情、三个选项、人物和台词清单。
  - `cast_scene`：为新人物选角，或在演员库没有合适人选时新建演员。
  - `inspect_last_frame`：查看上一场次最后一帧（只在要接着上一场次画面拍时调用）。
  - `write_scene_video`：一次写完整场 2～3 段分镜。
- 程序只拦截真实依赖（先发布才能选角，选完角才能写分镜，接着拍之前必须看过上一场次画面），不规定调用顺序。三样交齐即结束；同一工具连续 3 次校验失败则本次运行失败。
- 选角由模型决定，程序保证不漂移：老角色沿用已绑定的演员，更换必须显式说明；同一场次两个人物不能用同一演员。
- 分镜由「0–4秒：」这样的时间块组成（视频模型要求），每段 5～15 秒；程序整场校验时长、台词顺序与覆盖等，并逐段指出问题。分镜写法见 `skills/video-shot-prompt/SKILL.md`。
- 长对话靠会话历史与上下文压缩保持连续；历史场次进入上下文时，剧情、人物、台词、选角原样保留，分镜压成一行。

### 目录

| 目录 | 说明 |
| --- | --- |
| `src/director` | 浏览器里的导演 agent：提示词、四个工具、模型接入、尾帧识别、会话存储（IndexedDB） |
| `src/comfy` | Comfy Cloud 客户端与 H3 工作流模板 |
| `src/components`、`src/pages`、`src/hooks`、`src/services` | 页面、交互状态与本地存储 |
| `worker` | Comfy 转发层，开发服务器与 Cloudflare Worker 共用 |
| `server` | Vite 开发服务器插件，把转发层挂到 `/api/comfy/*` |
| `skills` | 导演加载的分镜写作规范 |
| `tests` | Node 内置测试（`node --test`） |

开发环境下顶部还有一个 Trace 页，用来查看每次导演运行的完整输入、工具调用、Token 与耗时；生产构建里不包含这个页面。

## 本地开发

需要 Node.js 24。

```bash
npm install
npm run dev     # 启动开发服务器（含 /api/comfy/* 转发）
npm test        # 运行测试
npm run lint    # 代码检查
npm run build   # 类型检查并构建到 dist/
```

注意：Comfy 转发层只挂在 `npm run dev` 的开发服务器上，`npm run preview` 预览构建产物时无法使用 ComfyUI 生成。

## 部署

部署到 Cloudflare Workers 的说明见后续。

## 许可证

[MIT](LICENSE) © 2026 BeverlyShi
