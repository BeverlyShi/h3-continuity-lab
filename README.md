# H3 Continuity Lab

一个同时验证连续视频生成与 Agent 互动故事场景视频体验的 React 前端原型。

## 本地运行

需要 Node.js 20 或更高版本。

```bash
npm install
npm run dev
```

浏览器打开 Vite 输出的本地地址（通常为 `http://localhost:5173`）。

## 验证

```bash
npm run lint
npm run build
```

## 当前交互

页面顶部提供两个独立工作区：

- **视频生成**：保留连续视频生产工作流。
- **游戏互动**：运行《后宫》互动故事验证版，并可根据每幕 narrative 调用 fal 生成连续场景视频。
- **Trace**：查看 Pi Agent、工具调用、持久 Session 与上下文压缩轨迹。

### 视频生成

- 在左侧创建、切换项目；每个项目拥有独立的 Prompt 与视频时间轴。
- 输入首个 Prompt 后，时间轴立即加入“生成中”片段，fal 完成后自动播放。
- 后续 Prompt 会依次加入时间轴，完成后成为可播放片段。
- 当前片段结束时，如果下一段已就绪则自动续播；否则停留等待，并在下一段就绪时自动继续。
- 用户主动暂停不会被生成完成事件打断。
- 点击已完成的时间轴片段可以回看，右侧当前 Prompt 会同步切换。
- 单个片段可下载；项目可通过浏览器内 FFmpeg 按时间轴顺序合并为一个 MP4。
- 项目元数据、片段地址和 fal API Key 会保存在当前浏览器的 `localStorage` 中。

### 游戏互动（Pi 导演与场景视频）

- 游戏初始页展示《后宫》的简单背景与玩家身份。
- 点击“请开始故事”后，Pi Agent 会主动决定女主、入宫缘由和第一幕，并在视频开关开启时提交 fal 场景视频。
- 故事续写需要 `OPENROUTER_API_KEY`；开启场景视频后还需要 `FAL_KEY`。
- 每一幕提供两个或三个选择，也支持自由行动；玩家输入会直接作为下一条 user message 进入同一 Pi Session。
- 页面内置 Pi Agent Core，并通过本地 `/api/director/turn` 调用 OpenRouter；右侧下拉框可选择 DeepSeek V4 Flash、Gemini 2.5 Flash-Lite、GPT-OSS 20B 或 GLM-5.3-Flash，模型 thinking 保持关闭。
- Agent 每回合只调用一次 `publish_scene`，在同一组参数中提交叙事、选项、人物和视频计划。
- 每幕视频由 2～3 个 5～10 秒的片段组成，总时长 15～30 秒；片段按顺序生成，后一片段使用前一片段尾帧作为首帧参考。
- 游戏播放器下方的时间轴按真实时长展示片段、生成状态、尾帧依赖和对应 Prompt。
- 不存在导演台账、宿籍数值或外围确定性裁决链；长对话由 Pi JSONL Session 与原生 Compaction 保持连续。
- 右侧“Pi 故事导演”面板会显示运行进度，也可作为自由行动输入框；失败时可从当前回合重试。
- 文字场景下方保留全部幕次，可随时回看；回看不会推进剧情或调用 API。
- OpenRouter 单次导演请求最多输出 2,500 tokens、关闭自动重试并设置 45 秒超时。
- 当前场景、幕次历史、视频计划和片段状态保存在当前浏览器的 `localStorage` 中。

### Trace

- 同一局游戏持续使用同一个 Pi Session，并在本地 `.agent-traces` 写入 JSONL 记录。
- Trace 页面按回合展示完整模型输入、所选模型与 thinking、Tool Call、Tool Result、Token、耗时与停止原因。
- `publish_scene` 的场景、视频计划和工具结果会直接出现在 Trace 中；正常回合只有一次 Assistant Tool Call。
- 当前锁定的 `pi-agent-core@0.84.4` 尚未实现 `AgentHarness.prompt()`；本版本使用可运行的基础 `Agent`，并接入同包的 JSONL Session 与 Telemetry。待 Harness 执行层发布后可在服务端单点替换。

## API 接入边界

当前版本是本地验证 MVP。`FAL_KEY` 和 `OPENROUTER_API_KEY` 会以明文形式保存在当前设备的浏览器存储中；OpenRouter Key 只传给本机 Vite 导演接口。Harness Trace 会在本地记录完整导演上下文，可能包含剧情秘密。正式产品应把密钥和 Trace 都迁移到有鉴权、访问隔离的服务端。

项目视频仍引用 fal 返回的远程地址，远程资源过期后无法恢复。项目合并依赖浏览器内存和 FFmpeg WebAssembly，长视频或大量片段可能受到设备内存、跨域策略及浏览器下载策略限制。
