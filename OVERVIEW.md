# H3 Continuity Lab 项目概览

本项目包含两个相互独立的验证工作区：连续视频生成与带场景视频的互动文字故事。两者共享同一个 React 页面外壳，但拥有各自的数据、模型和运行流程。

## 视频生成工作区

视频工作区保留原有连续视频生产流程：

- 使用 fal API 生成视频片段。
- 按项目保存 Prompt、片段状态和时间轴。
- 支持片段播放、下载和浏览器内合并。
- 视频生成状态不会参与互动故事的剧情判断。

## 《后宫》互动故事验证版

互动故事讲述一名秀女初入宫闱后的经历。Pi Agent 担任故事导演，主动决定开场、创建人物与事件，并根据玩家反馈继续推进剧情。

每个回合由一个 Pi Agent 在同一个 Session 里通过工具调用完成：

```text
玩家开始、选择选项或输入自由行动
                ↓
输入作为 user message 进入同一 Pi Session（附上一幕尾帧实测状态与本局视频模式）
                ↓
agent 调用 publish_scene 发布正文、三个选项、人物与台词清单
                ↓
有新人物时 agent 调用 search_actors 查候选，再调用 cast_scene 提交选角决定
                ↓
agent 调用 write_video_prompt 提交 2～3 段分镜，程序校验台词、时间块与秒数
                ↓
agent 调用 finish_turn 结束回合，程序把选角与视频计划推给页面
                ↓
页面生成或上传视频片段，DeepSeek Vision 识别最终尾帧
                ↓
开放新选择；下一回合读取用户选择与尾帧实测状态
```

### Agent 边界

- 只有一个 Agent 实例、一个持久 Session。模型自己决定调用顺序，程序通过工具前置条件拦截跳步：未发布场景不能写分镜，未完成选角不能写分镜，未提交视频计划（或未说明跳过原因）不能结束回合。不使用强制 `tool_choice`。
- 工具共五个：`publish_scene`、`search_actors`、`cast_scene`、`write_video_prompt`、`finish_turn`。视频模式为“仅文字”时不提供 `write_video_prompt`。
- 选角由模型决定，程序保证连续性：老角色的演员绑定由程序沿用，模型更换必须显式 `recast: true`；同一幕两个人物不能使用同一演员；演员图片仍由前端按演员 ID 从本地演员库解析。
- `write_video_prompt` 只提交 `style` 与每段的 `characters`、`seconds`、`prompt`。prompt 由 `0–4秒：` 形式的时间块组成，台词处写 `{{line_1}}` 占位符。程序替换为人物姓名与原文，校验每句台词恰好按序使用一次、时间块从 0 开始首尾相接、每段 5～10 秒且不低于台词所需、整幕 15～30 秒、正文不泄漏人物 ID。
- 同一工具连续 3 次校验失败则结束回合；模型停下却没有调用 `finish_turn` 时程序提醒一次，再不行按已有结果降级为纯文字。
- 同一幕片段按顺序生成，后续片段以及下一幕首段使用上一尾帧作为首帧参考。
- `inspect_tail_frame` 只调用 DeepSeek Vision，将整幕最终尾帧转换成下一回合使用的实测视觉状态。
- 可在 DeepSeek V4 Flash、Gemini 2.5 Flash-Lite、GPT-OSS 20B 与 GLM-5.3-Flash 之间切换；DeepSeek V4 Flash 默认关闭思考模式，可通过模型下方的开关开启 high 模式。
- GLM-5.3-Flash 使用独立 `BIGMODEL_API_KEY` 直连智谱官方通用按量 API，不支持完全关闭思考，默认使用 low，可通过开关切换 high。

### 会话与连续性

- 同一局游戏持续使用同一个 Pi JSONL Session。
- 玩家输入、Assistant 工具调用和 ToolResult 都写入 Session。
- 上下文接近窗口限制时使用 Pi Compaction，摘要保留女主处境、人物关系、关键事件、地点和未解决伏笔。
- 浏览器 `localStorage` 保存页面恢复所需的当前场景、幕次历史、视频计划和片段状态。

验证版不包含导演台账、宿籍或数值系统，也不执行外围确定性剧情裁决。故事连续性直接来自 Pi Session、工具结果和 Compaction 摘要。

## Trace

Trace 页面用于查看互动故事 Agent 的运行详情，包括：

- System Prompt 与玩家输入。
- 同一回合内 `publish_scene`、`search_actors`、`cast_scene`、`write_video_prompt`、`finish_turn` 的调用与结果。
- ToolResult 的结构化场景、选角与视频计划数据。
- Pi Compaction、Token、耗时、停止原因和错误。

Trace 数据来自本地 `.agent-traces` 中的 Pi JSONL Session，不与视频工作区状态混合。
