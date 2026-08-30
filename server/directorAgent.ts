import {
  Agent,
  buildSessionContext,
  compact as compactSession,
  convertToLlm,
  DEFAULT_COMPACTION_SETTINGS,
  estimateContextTokens,
  InMemoryTelemetryContext,
  JsonlSessionRepo,
  NodeExecutionEnv,
  prepareCompaction,
  shouldCompact,
  uuidv7,
  type AgentMessage,
  type CompactionEntry,
  type Entry,
  type JsonlSessionMetadata,
  type Session,
} from '@earendil-works/pi-agent-core/node'
import { createModels, type Api, type Model, type Models } from '@earendil-works/pi-ai'
import { deepseekProvider } from '@earendil-works/pi-ai/providers/deepseek'
import { resolve } from 'node:path'
import type { DirectorBoard, AgentTraceEntry, DirectorStreamEvent, HarnessTraceSnapshot } from '../src/types/director.ts'
import type { DirectorTurnContext } from '../src/types/game.ts'
import { DIRECTOR_COMPACTION_INSTRUCTIONS, DIRECTOR_SYSTEM_PROMPT } from './directorPrompt.ts'
import { createDirectorTools, EMPTY_DIRECTOR_BOARD } from './directorTools.ts'
import { summarizeAssistantUsage, toDurableMessage, toDurableValue } from './directorTrace.ts'

const MAX_DIRECTOR_OUTPUT_TOKENS = 2_500
const DIRECTOR_TIMEOUT_MS = 45_000
const traceEnvironment = new NodeExecutionEnv({ cwd: process.cwd() })
const traceRepo = new JsonlSessionRepo({
  fs: traceEnvironment,
  sessionsRoot: resolve(process.cwd(), '.agent-traces'),
})
const activeGameSessions = new Set<string>()

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
    if (entry.type === 'custom' && entry.customType === 'director_board') {
      projected.push({
        id: entryId(traceId, entry, 'director-board'),
        kind: 'assistant',
        title: '导演台账更新',
        timestamp: entry.timestamp,
        data: entry.data,
      })
      continue
    }

    if (entry.type === 'compaction') {
      projected.push({
        id: entryId(traceId, entry, 'compaction'),
        kind: 'assistant',
        title: 'Pi Context Compaction',
        timestamp: entry.timestamp,
        text: entry.summary,
        data: {
          tokensBefore: entry.tokensBefore,
          retainedMessages: entry.retainedTail.length,
          usage: entry.usage,
        },
      })
      continue
    }

    if (entry.type !== 'message') continue
    const message = entry.message

    if (message.role === 'user') {
      projected.push({
        id: entryId(traceId, entry, 'input'),
        kind: 'input',
        title: '本回合模型输入',
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

const getOrCreateSession = async (gameSessionId: string) => {
  const existing = (await traceRepo.list({ cwd: process.cwd() }))
    .find((metadata) => metadata.id === gameSessionId)
  if (existing) return traceRepo.open(existing)

  return traceRepo.create({
    id: gameSessionId,
    cwd: process.cwd(),
    metadata: {
      kind: 'unregistered-city-director',
      storyId: 'unregistered-city-quick',
    },
  })
}

const readDirectorBoard = (entries: Entry[]): DirectorBoard => {
  const boardEntry = [...entries].reverse().find((entry) =>
    entry.type === 'custom' && entry.customType === 'director_board',
  )
  if (!boardEntry || boardEntry.type !== 'custom' || !boardEntry.data || typeof boardEntry.data !== 'object') {
    return toDurableValue(EMPTY_DIRECTOR_BOARD)
  }

  const stored = boardEntry.data as Partial<DirectorBoard>
  return {
    ...(typeof stored.dramaticGoal === 'string' ? { dramaticGoal: stored.dramaticGoal } : {}),
    ...(typeof stored.nextBeat === 'string' ? { nextBeat: stored.nextBeat } : {}),
    foreshadowing: Array.isArray(stored.foreshadowing) ? stored.foreshadowing : [],
    revealedSecrets: Array.isArray(stored.revealedSecrets) ? stored.revealedSecrets : [],
    characterIntentions: stored.characterIntentions && typeof stored.characterIntentions === 'object'
      ? stored.characterIntentions
      : {},
  }
}

const lastSequence = (entries: Entry[]) => entries.reduce((latest, entry) => Math.max(latest, entry.seq), 0)

const maybeCompact = async ({
  session,
  entries,
  models,
  model,
  signal,
}: {
  session: Session<JsonlSessionMetadata>
  entries: Entry[]
  models: Models
  model: Model<Api>
  signal?: AbortSignal
}) => {
  const contextMessages = buildSessionContext(entries).messages
  const contextTokens = estimateContextTokens(contextMessages).tokens
  if (!shouldCompact(contextTokens, model.contextWindow, DEFAULT_COMPACTION_SETTINGS)) return false

  const preparation = prepareCompaction(entries, DEFAULT_COMPACTION_SETTINGS)
  if (!preparation.ok) throw preparation.error
  if (!preparation.value) return false

  const result = await compactSession(
    preparation.value,
    models,
    model,
    DIRECTOR_COMPACTION_INSTRUCTIONS,
    signal,
    'off',
  )
  if (!result.ok) throw result.error

  const compacted = result.value
  const entry: Omit<CompactionEntry, 'parentId' | 'seq' | 'timestamp'> = {
    type: 'compaction',
    id: uuidv7(),
    summary: compacted.summary,
    retainedTail: toDurableValue(compacted.retainedTail),
    tokensBefore: compacted.tokensBefore,
    ...(compacted.details === undefined ? {} : { details: toDurableValue(compacted.details) }),
    ...(compacted.usage === undefined ? {} : { usage: toDurableValue(compacted.usage) }),
  }
  await session.appendEntry(entry, 'main')
  return true
}

export type DirectorAgentRequest = {
  apiKey: string
  context: DirectorTurnContext
  traceId: string
  signal?: AbortSignal
  send: (event: DirectorStreamEvent) => void
}

export async function runDirectorAgent(request: DirectorAgentRequest) {
  const gameSessionId = request.context.session.id
  if (!request.context.session.pendingAction) throw new Error('当前没有等待导演裁决的玩家行动。')
  if (activeGameSessions.has(gameSessionId)) throw new Error('导演正在处理这个游戏会话的上一项行动。')

  activeGameSessions.add(gameSessionId)
  try {
    return await runPersistentDirector(request)
  } finally {
    activeGameSessions.delete(gameSessionId)
  }
}

async function runPersistentDirector({
  apiKey,
  context,
  traceId,
  signal,
  send,
}: DirectorAgentRequest) {
  const persistenceErrors: Array<{ message: string; timestamp: number }> = []
  const startedAt = Date.now()
  const session = await getOrCreateSession(context.session.id)
  const metadata = await session.getMetadata()
  let persistedEntries = await session.findEntries({ order: 'oldestFirst' })
  const startSeq = lastSequence(persistedEntries)
  const telemetry = new InMemoryTelemetryContext()

  const models = createModels()
  models.setProvider(deepseekProvider())
  const model = models.getModel('deepseek', 'deepseek-v4-flash')
  if (!model) throw new Error('Pi 未找到 deepseek-v4-flash 模型。')

  const completeSimple = models.completeSimple.bind(models)
  models.completeSimple = (compactModel, compactContext, options) => completeSimple(
    compactModel,
    compactContext,
    { ...options, apiKey },
  )

  try {
    if (await maybeCompact({ session, entries: persistedEntries, models, model, signal })) {
      persistedEntries = await session.findEntries({ order: 'oldestFirst' })
    }
  } catch (error) {
    persistenceErrors.push({
      message: `Pi Compaction 预检查失败：${error instanceof Error ? error.message : String(error)}`,
      timestamp: Date.now(),
    })
  }

  const sessionContext = buildSessionContext(persistedEntries)
  const initialBoard = readDirectorBoard(persistedEntries)
  const toolRuntime = createDirectorTools({ context, session, initialBoard, send })
  const agent = new Agent({
    initialState: {
      systemPrompt: DIRECTOR_SYSTEM_PROMPT,
      model,
      tools: toolRuntime.tools,
      messages: sessionContext.messages,
      thinkingLevel: 'low',
    },
    convertToLlm,
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
    sessionId: metadata.id,
    maxRetryDelayMs: 5_000,
    toolExecution: 'sequential',
    shouldStopAfterTurn: () => toolRuntime.isPublished(),
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
  send({ type: 'status', text: '持久导演正在规划本回合并自主调用工具。' })

  const sendTrace = async (outcome: HarnessTraceSnapshot['outcome']) => {
    let entries: Entry[] = []
    try {
      entries = await session.findEntries({
        order: 'oldestFirst',
        cursor: { afterSeq: startSeq },
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      persistenceErrors.push({ message, timestamp: Date.now() })
      console.error('Agent trace read failed:', message)
    }
    const endedAt = Date.now()
    const currentRunMessages = entries.flatMap((entry): AgentMessage[] =>
      entry.type === 'message' ? [entry.message] : [],
    )
    const finalMessage = [...currentRunMessages].reverse().find((message) => message.role === 'assistant')
    const traceEntries: AgentTraceEntry[] = [{
      id: `${traceId}:system-prompt`,
      kind: 'input',
      title: '主 Agent System Prompt（完整世界观）',
      timestamp: startedAt,
      text: DIRECTOR_SYSTEM_PROMPT,
    }, ...projectTraceEntries(traceId, entries)]
    const trace: HarnessTraceSnapshot = {
      traceId,
      harnessSessionId: metadata.id,
      startedAt,
      endedAt,
      durationMs: endedAt - startedAt,
      outcome,
      stopReason: finalMessage?.role === 'assistant' ? finalMessage.stopReason : undefined,
      usage: summarizeAssistantUsage(currentRunMessages),
      entries: traceEntries,
    }
    persistenceErrors.forEach((error, index) => {
      trace.entries.push({
        id: `${traceId}:persistence-error-${index}`,
        kind: 'error',
        title: 'Pi Session 警告',
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
    const action = context.session.pendingAction
    if (!action) throw new Error('当前没有等待导演裁决的玩家行动。')
    await agent.prompt(
      `第 ${context.session.turn} 回合，玩家行动：${action.text}\n` +
      '请继续导演工作。根据需要自由调用工具，并以 publish_turn 成功结束本回合。',
    )
    if (agent.state.errorMessage) throw new Error(agent.state.errorMessage)
    if (!toolRuntime.isPublished()) {
      await agent.prompt(
        '本回合尚未发布。请继续使用工具完成必要校验，并以 publish_turn 成功结束；不要只输出说明。',
      )
    }
    if (agent.state.errorMessage) throw new Error(agent.state.errorMessage)
    const resolution = toolRuntime.getResolution()
    if (!resolution || !toolRuntime.isPublished()) throw new Error('导演没有成功发布本回合裁决，请重试。')

    try {
      const allEntries = await session.findEntries({ order: 'oldestFirst' })
      await maybeCompact({ session, entries: allEntries, models, model, signal })
    } catch (error) {
      persistenceErrors.push({
        message: `Pi Compaction 后处理失败：${error instanceof Error ? error.message : String(error)}`,
        timestamp: Date.now(),
      })
    }

    await sendTrace('completed')
    send({ type: 'done' })
    return resolution
  } catch (error) {
    await sendTrace(signal?.aborted ? 'aborted' : 'failed')
    throw error
  }
}
