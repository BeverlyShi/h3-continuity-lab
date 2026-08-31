# H3 Continuity Lab 项目概览

本项目包含两个相互独立的验证工作区：连续视频生成与互动文字故事。两者共享同一个 React 页面外壳，但拥有各自的数据、模型和运行流程。

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
Pi Agent 调用 DeepSeek 续写故事
                ↓
Agent 调用 publish_scene
                ↓
页面展示场景、人物、物体、叙事和 2～3 个新选择
```

### Agent 边界

- Agent 只注册一个工具：`publish_scene`。
- 工具使用 TypeBox 校验场景结构，并要求每回合提供两个或三个选择。
- 工具成功后以结构化 `details` 返回场景，并通过 `terminate: true` 结束当前工具回合。
- DeepSeek thinking 保持关闭。
- 如果模型没有调用工具，Agent 会追加一次简短纠正消息；仍未发布则明确报错。

### 会话与连续性

- 同一局游戏持续使用同一个 Pi JSONL Session。
- 玩家输入、Assistant 工具调用和 ToolResult 都写入 Session。
- 上下文接近窗口限制时使用 Pi Compaction，摘要保留女主处境、人物关系、关键事件、地点和未解决伏笔。
- 浏览器 `localStorage` 只保存页面恢复所需的当前场景与幕次历史。

验证版不包含导演台账、宿籍或数值系统，也不执行外围确定性剧情裁决。故事连续性直接来自 Pi Session、工具结果和 Compaction 摘要。

## Trace

Trace 页面用于查看互动故事 Agent 的运行详情，包括：

- System Prompt 与玩家输入。
- Assistant 输出和 `publish_scene` Tool Call。
- ToolResult 的结构化场景数据。
- Pi Compaction、Token、耗时、停止原因和错误。

Trace 数据来自本地 `.agent-traces` 中的 Pi JSONL Session，不与视频工作区状态混合。
