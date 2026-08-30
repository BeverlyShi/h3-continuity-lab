import {
  Agent,
  InMemoryTelemetryContext,
  JsonlSessionRepo,
  NodeExecutionEnv,
  type AgentTool,
  type Entry,
} from '@earendil-works/pi-agent-core/node'
import { createModels } from '@earendil-works/pi-ai'
import { deepseekProvider } from '@earendil-works/pi-ai/providers/deepseek'
import { resolve } from 'node:path'
import { Type } from 'typebox'
import type { DirectorResolutionInput } from '../src/types/game.ts'
import type {
  AgentTraceEntry,
  DirectorStreamEvent,
  HarnessTraceSnapshot,
} from '../src/types/director.ts'
import { summarizeAssistantUsage, toDurableMessage } from './directorTrace.ts'

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

const SYSTEM_PROMPT = `你是互动文字游戏《无籍之城》的世界导演。
你的任务是读取完整世界状态和玩家本回合行动，给出公平、克制、可持续互动的裁决。

必须遵守：
1. coreRules 是不可变规则，不得为了迎合玩家而修改。
2. 角色秘密只有在行动和既有事件合理揭示后，才能进入玩家可见叙事。
3. 数值变化必须有明确因果，单项通常在 -15 到 +15；戏剧性后果也不得超过 -25 到 +25。
4. 宿籍初次分配可由老板决定；已经分配后的流转只能由持有人自愿提出、双方接受且有人见证。
5. narrative 是玩家立刻看到的本回合文字结果；sceneDirection 继续描述可见场面，供诊断连续性使用。
6. nextOptions 必须是两个真实分叉，不得只是同一行动的换句话说。
7. 你必须且只能调用一次 commit_turn 工具完成裁决。不要使用 Markdown，不要在工具调用后继续解释。`

const MAX_DIRECTOR_OUTPUT_TOKENS = 2_500
const DIRECTOR_TIMEOUT_MS = 45_000
const traceEnvironment = new NodeExecutionEnv({ cwd: process.cwd() })
const traceRepo = new JsonlSessionRepo({
  fs: traceEnvironment,
  sessionsRoot: resolve(process.cwd(), '.agent-traces'),
})

const entryId = (traceId: string, entry: Entry, suffix: string) => `${traceId}:${entry.id}:${suffix}`

const textFromContent = (content: unknown) => Array.isArray(content)
  ? content.flatMap((item) => {
    if (!item || typeof item !== 'object' || !('type' in item)) return []
    if (item.type === 'text' && 'text' in item && typeof item.text === 'string') return [item.text]
    return []
  }).join('\n')
  : typeof content === 'string' ? content : ''

const projectTraceEntries = (traceId: string, entries: Entry[]): AgentTraceEntry[] => {
  const projected: AgentTraceEntry[] = []

  for (const entry of entries) {
    if (entry.type !== 'message') continue
    const message = entry.message

    if (message.role === 'user') {
      projected.push({
        id: entryId(traceId, entry, 'input'),
        kind: 'input',
        title: '完整模型输入（包含导演上下文）',
        timestamp: message.timestamp,
        text: textFromContent(message.content),
      })
      continue
    }

    if (message.role === 'assistant') {
      message.content.forEach((content, index) => {
        if (content.type === 'thinking') {
          projected.push({
            id: entryId(traceId, entry, `thinking-${index}`),
            kind: 'thinking',
            title: content.redacted ? '模型推理（已脱敏）' : '模型推理',
            timestamp: message.timestamp,
            text: content.redacted ? '提供方返回了已脱敏的推理内容。' : content.thinking,
          })
        }
        if (content.type === 'text') {
          projected.push({
            id: entryId(traceId, entry, `assistant-${index}`),
            kind: 'assistant',
            title: 'Assistant 输出',
            timestamp: message.timestamp,
            text: content.text,
          })
        }
        if (content.type === 'toolCall') {
          projected.push({
            id: entryId(traceId, entry, `tool-call-${index}`),
            kind: 'tool_call',
            title: `调用工具 · ${content.name}`,
            timestamp: message.timestamp,
            data: content.arguments,
          })
        }
      })
      continue
    }

    if (message.role === 'toolResult') {
      projected.push({
        id: entryId(traceId, entry, 'tool-result'),
        kind: 'tool_result',
        title: `工具结果 · ${message.toolName}`,
        timestamp: message.timestamp,
        text: textFromContent(message.content),
        data: message.details,
        isError: message.isError,
      })
    }
  }

  return projected
}

export type DirectorAgentRequest = {
  apiKey: string
  context: unknown
  traceId: string
  signal?: AbortSignal
  send: (event: DirectorStreamEvent) => void
}

export async function runDirectorAgent({
  apiKey,
  context,
  traceId,
  signal,
  send,
}: DirectorAgentRequest) {
  let resolution: DirectorResolutionInput | undefined
  const persistenceErrors: Array<{ message: string; timestamp: number }> = []
  const startedAt = Date.now()
  const session = await traceRepo.create({
    id: traceId,
    cwd: process.cwd(),
    metadata: { kind: 'unregistered-city-director-turn' },
  })
  const metadata = await session.getMetadata()
  const telemetry = new InMemoryTelemetryContext()

  const commitTool: AgentTool<typeof resolutionSchema, DirectorResolutionInput> = {
    name: 'commit_turn',
    label: '提交本回合裁决',
    description: '提交唯一的结构化回合裁决。字段将继续经过游戏确定性规则引擎校验。',
    parameters: resolutionSchema,
    executionMode: 'sequential',
    execute: async (_toolCallId, params) => {
      resolution = params
      send({ type: 'tool', name: 'commit_turn', text: '导演完成推演，正在提交裁决。' })
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
        apiKey,
        maxTokens: MAX_DIRECTOR_OUTPUT_TOKENS,
        maxRetries: 0,
        timeoutMs: DIRECTOR_TIMEOUT_MS,
        telemetryContext: telemetry,
      },
    ),
    maxRetryDelayMs: 5_000,
    toolExecution: 'sequential',
    shouldStopAfterTurn: ({ toolResults }) => toolResults.length > 0,
  })

  signal?.addEventListener('abort', () => agent.abort(), { once: true })
  agent.subscribe(async (event) => {
    if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta') {
      send({ type: 'delta', text: event.assistantMessageEvent.delta })
    }
    if (event.type === 'message_end') {
      try {
        await session.appendMessage(toDurableMessage(event.message))
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        persistenceErrors.push({ message, timestamp: Date.now() })
        console.error('Agent trace persistence failed:', message)
      }
    }
  })

  send({ type: 'trace_started', traceId, harnessSessionId: metadata.id, startedAt })
  send({ type: 'status', text: 'Pi Agent 正在读取行动与世界状态。' })

  const sendTrace = async (outcome: HarnessTraceSnapshot['outcome']) => {
    let entries: Entry[] = []
    try {
      entries = await session.findEntries({ order: 'oldestFirst' })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      persistenceErrors.push({ message, timestamp: Date.now() })
      console.error('Agent trace read failed:', message)
    }
    const endedAt = Date.now()
    const finalMessage = [...agent.state.messages].reverse().find((message) => message.role === 'assistant')
    const trace: HarnessTraceSnapshot = {
      traceId,
      harnessSessionId: metadata.id,
      startedAt,
      endedAt,
      durationMs: endedAt - startedAt,
      outcome,
      stopReason: finalMessage?.role === 'assistant' ? finalMessage.stopReason : undefined,
      usage: summarizeAssistantUsage(agent.state.messages),
      entries: projectTraceEntries(traceId, entries),
    }
    persistenceErrors.forEach((error, index) => {
      trace.entries.push({
        id: `${traceId}:persistence-error-${index}`,
        kind: 'error',
        title: 'Trace 持久化警告',
        timestamp: error.timestamp,
        text: error.message,
        isError: true,
      })
    })
    const telemetrySpans = telemetry.getSpans()
    if (telemetrySpans.length) {
      trace.entries.push({
        id: `${traceId}:telemetry`,
        kind: 'assistant',
        title: 'Pi Telemetry',
        timestamp: endedAt,
        data: telemetrySpans,
      })
    }
    send({ type: 'harness_trace', trace })
  }

  try {
    await agent.prompt(`请裁决以下游戏状态：\n${JSON.stringify(context)}`)
    if (agent.state.errorMessage) throw new Error(agent.state.errorMessage)
    if (!resolution) throw new Error('导演没有提交结构化裁决，请重试。')
    await sendTrace('completed')
    send({ type: 'done' })
    return resolution
  } catch (error) {
    await sendTrace(signal?.aborted ? 'aborted' : 'failed')
    throw error
  }
}
