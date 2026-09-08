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

每个回合的流程为：

```text
玩家开始、选择选项或输入自由行动
                ↓
输入作为 user message 进入同一 Pi Session
                ↓
Pi Agent 通过 OpenRouter 调用用户选择的模型续写故事
                ↓
场景阶段只调用 publish_scene
                ↓
程序选角与视频草稿阶段并行执行并汇合
                ↓
页面生成 2～3 个视频片段，DeepSeek Vision 识别最终尾帧
                ↓
开放新选择；下一回合读取用户选择与尾帧实测状态
```

### Agent 边界

- 每回合使用确定性的两阶段编排：场景模型只调用 `publish_scene`，随后程序选角与视频模型的 `write_video_prompt` 并行执行。
- `cast_scene` 只接收演员库元数据，根据性别、年龄和已有绑定完成选角；演员图片仍由前端根据演员 ID 从本地演员库解析，避免把大型图片数据发送给 Director 服务。
- 前端等待选角结果与视频计划同时就绪后才提交生成，并把匹配演员的参考图传给 fal。
- 视频计划根据 narrative 规划 15～30 秒的场景视频，拆成 2～3 个 5～10 秒的连续片段。
- 视频模型只提交镜头节拍、结构化台词和预测性的 `endFrame` 文字；程序按台词长度生成每个时间块、sequence、起止时间与总时长。
- 同一幕片段按顺序生成，后续片段以及下一幕首段使用上一尾帧作为首帧参考。
- `inspect_tail_frame` 只调用 DeepSeek Vision，将整幕最终尾帧转换成下一回合使用的实测视觉状态。
- 工具使用 TypeBox 校验场景结构，并要求每回合提供三个选择。
- 工具成功后以结构化 `details` 返回场景与模板编译结果。
- 可在 DeepSeek V4 Flash、Gemini 2.5 Flash-Lite、GPT-OSS 20B 与 GLM-5.3-Flash 之间切换；DeepSeek V4 Flash 在 Pi 和极简导演中均默认关闭思考模式，可通过模型下方的开关开启 high 模式。
- GLM-5.3-Flash 使用独立 `BIGMODEL_API_KEY` 直连智谱官方通用按量 API，GLM-5.3-Flash 不支持完全关闭思考，Pi 与极简导演默认使用 low，可通过开关切换 high。
- 工具参数不符合 schema 时会把错误反馈给模型，并在有限次数内重试。

### 会话与连续性

- 同一局游戏持续使用同一个 Pi JSONL Session。
- 玩家输入、Assistant 工具调用和 ToolResult 都写入 Session。
- 上下文接近窗口限制时使用 Pi Compaction，摘要保留女主处境、人物关系、关键事件、地点和未解决伏笔。
- 浏览器 `localStorage` 保存页面恢复所需的当前场景、幕次历史、视频计划和片段状态。

验证版不包含导演台账、宿籍或数值系统，也不执行外围确定性剧情裁决。故事连续性直接来自 Pi Session、工具结果和 Compaction 摘要。

## Trace

Trace 页面用于查看互动故事 Agent 的运行详情，包括：

- System Prompt 与玩家输入。
- 场景阶段的 `publish_scene`、程序选角，以及视频阶段的 `write_video_prompt` 调用与结果。
- ToolResult 的结构化场景与视频计划数据。
- Pi Compaction、Token、耗时、停止原因和错误。

Trace 数据来自本地 `.agent-traces` 中的 Pi JSONL Session，不与视频工作区状态混合。
