import { Agent, type AgentTool } from '@earendil-works/pi-agent-core'
import { createModels } from '@earendil-works/pi-ai'
import { deepseekProvider } from '@earendil-works/pi-ai/providers/deepseek'
import { Type } from 'typebox'
import type { DirectorResolutionInput } from '../src/types/game.ts'
import type { DirectorStreamEvent } from '../src/types/director.ts'

const resolutionSchema = Type.Object({
  outcome: Type.Union([
    Type.Literal('impossible'),
    Type.Literal('failed'),
    Type.Literal('costly_success'),
    Type.Literal('success'),
    Type.Literal('major_success'),
  ]),
  narrative: Type.String({ minLength: 20, maxLength: 500 }),
  reason: Type.String({ minLength: 10, maxLength: 300 }),
  statChanges: Type.Optional(Type.Object({
    innOrder: Type.Optional(Type.Number()),
    officialSuspicion: Type.Optional(Type.Number()),
    guestTrust: Type.Optional(Type.Number()),
  })),
  permitChanges: Type.Optional(Type.Array(Type.Object({
    permitId: Type.Union([
      Type.Literal('gatekeeper'),
      Type.Literal('lamplighter'),
      Type.Literal('scribe'),
    ]),
    holderId: Type.String(),
    kind: Type.Union([
      Type.Literal('initial_assignment'),
      Type.Literal('voluntary_transfer'),
    ]),
    voluntary: Type.Optional(Type.Boolean()),
    accepted: Type.Optional(Type.Boolean()),
    witnessed: Type.Optional(Type.Boolean()),
  }))),
  nextOptions: Type.Tuple([
    Type.String({ minLength: 4, maxLength: 100 }),
    Type.String({ minLength: 4, maxLength: 100 }),
  ]),
  sceneDirection: Type.String({ minLength: 20, maxLength: 700 }),
})

const SYSTEM_PROMPT = `你是互动影像游戏《无籍之城》的世界导演。
你的任务是读取完整世界状态和玩家本回合行动，给出公平、克制、可连续拍摄的裁决。

必须遵守：
1. coreRules 是不可变规则，不得为了迎合玩家而修改。
2. 角色秘密只有在行动和既有事件合理揭示后，才能进入玩家可见叙事。
3. 数值变化必须有明确因果，单项通常在 -15 到 +15；戏剧性后果也不得超过 -25 到 +25。
4. 宿籍初次分配可由老板决定；已经分配后的流转只能由持有人自愿提出、双方接受且有人见证。
5. narrative 是玩家立刻看到的本回合结果；sceneDirection 是下一段 5 秒视频的具体镜头，不写抽象评价。
6. nextOptions 必须是两个真实分叉，不得只是同一行动的换句话说。
7. 你必须且只能调用一次 commit_turn 工具完成裁决。不要使用 Markdown，不要在工具调用后继续解释。`

const MAX_DIRECTOR_OUTPUT_TOKENS = 2_500
const DIRECTOR_TIMEOUT_MS = 45_000

export type DirectorAgentRequest = {
  apiKey: string
  context: unknown
  signal?: AbortSignal
  send: (event: DirectorStreamEvent) => void
}

export async function runDirectorAgent({ apiKey, context, signal, send }: DirectorAgentRequest) {
  let resolution: DirectorResolutionInput | undefined
  const commitTool: AgentTool<typeof resolutionSchema, DirectorResolutionInput> = {
    name: 'commit_turn',
    label: '提交本回合裁决',
    description: '提交唯一的结构化回合裁决。字段将继续经过游戏确定性规则引擎校验。',
    parameters: resolutionSchema,
    executionMode: 'sequential',
    execute: async (_toolCallId, params) => {
      resolution = params
      send({ type: 'resolution', resolution: params })
      return {
        content: [{ type: 'text', text: '裁决已记录并交给确定性规则引擎。' }],
        details: params,
        terminate: true,
      }
    },
  }

  const models = createModels()
  models.setProvider(deepseekProvider())
  const model = models.getModel('deepseek', 'deepseek-v4-flash')
  if (!model) throw new Error('Pi 未找到 deepseek-v4-flash 模型。')

  const agent = new Agent({
    initialState: {
      systemPrompt: SYSTEM_PROMPT,
      model,
      tools: [commitTool],
      thinkingLevel: 'low',
    },
    streamFn: (streamModel, streamContext, options) => models.streamSimple(
      streamModel,
      streamContext,
      {
        ...options,
        maxTokens: MAX_DIRECTOR_OUTPUT_TOKENS,
        maxRetries: 0,
        timeoutMs: DIRECTOR_TIMEOUT_MS,
      },
    ),
    getApiKey: (provider) => provider === 'deepseek' ? apiKey : undefined,
    maxRetryDelayMs: 5_000,
    toolExecution: 'sequential',
    shouldStopAfterTurn: ({ toolResults }) => toolResults.length > 0,
  })

  signal?.addEventListener('abort', () => agent.abort(), { once: true })
  agent.subscribe((event) => {
    if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta') {
      send({ type: 'delta', text: event.assistantMessageEvent.delta })
    }
    if (event.type === 'tool_execution_start') {
      send({ type: 'tool', name: event.toolName, text: '导演完成推演，正在提交裁决。' })
    }
  })

  send({ type: 'status', text: 'DeepSeek 正在读取行动与世界状态。' })
  await agent.prompt(`请裁决以下游戏状态：\n${JSON.stringify(context)}`)
  if (agent.state.errorMessage) throw new Error(agent.state.errorMessage)
  if (!resolution) throw new Error('导演没有提交结构化裁决，请重试。')
  send({ type: 'done' })
  return resolution
}
