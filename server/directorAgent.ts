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
import type { AgentTraceEntry, DirectorStreamEvent, HarnessTraceSnapshot } from '../src/types/director.ts'
import type { DirectorTurnContext } from '../src/types/game.ts'
import type { StoryScene, VideoGenerationRequest } from '../src/types/story.ts'
import {
  buildStoryInputMessage,
  DIRECTOR_COMPACTION_INSTRUCTIONS,
  DIRECTOR_SYSTEM_PROMPT,
  DIRECTOR_VIDEO_TOOL_INSTRUCTIONS,
} from './directorPrompt.ts'
import { createGenerateVideoTool } from './generateVideoTool.ts'
import { createPublishSceneTool } from './publishSceneTool.ts'
import { summarizeAssistantUsage, toDurableMessage, toDurableValue } from './directorTrace.ts'

const DIRECTOR_AGENT_SYSTEM_PROMPT = `${DIRECTOR_SYSTEM_PROMPT}\n\n${DIRECTOR_VIDEO_TOOL_INSTRUCTIONS}`
const MAX_DIRECTOR_OUTPUT_TOKENS = 2_500
const DIRECTOR_TIMEOUT_MS = 45_000
const MAX_PUBLISH_ATTEMPTS = 2
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
        title: '玩家输入',
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
        if (content.type === 'text' && content.text.trim()) {
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
      kind: 'palace-story-director',
      storyId: 'palace-validation',
    },
  })
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
  const gameSessionId = request.context.sessionId
  if (activeGameSessions.has(gameSessionId)) throw new Error('故事导演正在处理这个会话的上一项行动。')

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
  const session = await getOrCreateSession(context.sessionId)
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

  let publishedScene: StoryScene | undefined
  let videoRequest: VideoGenerationRequest | undefined
  const publishSceneTool = createPublishSceneTool((scene) => {
    publishedScene = toDurableValue(scene)
  })
  const generateVideoTool = createGenerateVideoTool((request) => {
    videoRequest = toDurableValue(request)
  })
  const agent = new Agent({
    initialState: {
      systemPrompt: DIRECTOR_AGENT_SYSTEM_PROMPT,
      model,
      tools: [generateVideoTool, publishSceneTool],
      messages: buildSessionContext(persistedEntries).messages,
      thinkingLevel: 'off',
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
  })

  signal?.addEventListener('abort', () => agent.abort(), { once: true })
  agent.subscribe(async (event) => {
    if (event.type !== 'message_end') return
    try {
      await session.appendMessage(toDurableMessage(event.message))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      persistenceErrors.push({ message, timestamp: Date.now() })
      console.error('Agent trace persistence failed:', message)
    }
  })

  send({ type: 'trace_started', traceId, harnessSessionId: metadata.id, startedAt })
  send({ type: 'status', text: 'Pi 故事导演正在构思下一幕。' })

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
    const trace: HarnessTraceSnapshot = {
      traceId,
      harnessSessionId: metadata.id,
      startedAt,
      endedAt,
      durationMs: endedAt - startedAt,
      outcome,
      stopReason: finalMessage?.role === 'assistant' ? finalMessage.stopReason : undefined,
      usage: summarizeAssistantUsage(currentRunMessages),
      entries: [{
        id: `${traceId}:system-prompt`,
        kind: 'input',
        title: 'Pi Agent System Prompt',
        timestamp: startedAt,
        text: DIRECTOR_AGENT_SYSTEM_PROMPT,
      }, ...projectTraceEntries(traceId, entries)],
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
    for (let attempt = 0; attempt < MAX_PUBLISH_ATTEMPTS && !publishedScene; attempt += 1) {
      const prompt = attempt === 0
        ? buildStoryInputMessage(context.input)
        : '你还没有发布场景。请立即调用 publish_scene，完整发布当前回合，不要只回复普通文字。'
      await agent.prompt(prompt)
      if (agent.state.errorMessage) throw new Error(agent.state.errorMessage)
      if (!publishedScene && attempt + 1 < MAX_PUBLISH_ATTEMPTS) {
        send({ type: 'status', text: '导演尚未发布场景，Pi Agent 正在继续执行。' })
      }
    }
    if (!publishedScene) throw new Error('Pi Agent 没有调用 publish_scene 发布场景。')

    send({ type: 'status', text: 'publish_scene 已完成，正在展示下一幕。' })
    if (videoRequest) send({ type: 'video_request', request: videoRequest })
    send({ type: 'scene', scene: publishedScene })

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
    return publishedScene
  } catch (error) {
    await sendTrace(signal?.aborted ? 'aborted' : 'failed')
    throw error
  }
}
