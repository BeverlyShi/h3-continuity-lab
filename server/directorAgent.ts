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
  type ShouldStopAfterTurnContext,
} from '@earendil-works/pi-agent-core/node'
import {
  createModels,
  type Api,
  type Model,
  type Models,
  type SimpleStreamOptions,
} from '@earendil-works/pi-ai'
import { deepseekProvider } from '@earendil-works/pi-ai/providers/deepseek'
import { openrouterProvider } from '@earendil-works/pi-ai/providers/openrouter'
import { resolve } from 'node:path'
import { getDirectorModelLabel, getDirectorModelProvider, type DirectorModelId } from '../src/config/directorModels.ts'
import type { AgentTraceEntry, DirectorStreamEvent, HarnessTraceSnapshot } from '../src/types/director.ts'
import type { DirectorTurnContext } from '../src/types/game.ts'
import type { ScenePublish, VideoGenerationRequest } from '../src/types/story.ts'
import {
  buildStoryInputMessage,
  DIRECTOR_COMPACTION_INSTRUCTIONS,
  DIRECTOR_SYSTEM_PROMPT,
  DIRECTOR_VIDEO_PLAN_USER_MESSAGE,
  DIRECTOR_VIDEO_TOOL_INSTRUCTIONS,
} from './directorPrompt.ts'
import { createPublishSceneTool } from './publishSceneTool.ts'
import { createVideoPlanTool } from './videoPlanTool.ts'
import { summarizeAssistantUsage, toDurableMessage, toDurableValue } from './directorTrace.ts'

const MAX_DIRECTOR_OUTPUT_TOKENS = 2_500
const DIRECTOR_TIMEOUT_MS = 45_000
// 场景/视频计划两阶段各自最多尝试 3 次模型调用（1 次初始 + 2 次重试），
// 工具校验失败时把错误反馈回模型重试，而不是让整个回合作废。
const MAX_TOOL_ATTEMPTS = 3
const traceEnvironment = new NodeExecutionEnv({ cwd: process.cwd() })
const traceRepo = new JsonlSessionRepo({
  fs: traceEnvironment,
  sessionsRoot: resolve(process.cwd(), '.agent-traces'),
})
const activeGameSessions = new Set<string>()

type DirectorStreamPolicy = Pick<SimpleStreamOptions, 'maxTokens' | 'reasoning' | 'samplingParams'>

export const getDirectorStreamPolicy = (modelId: DirectorModelId): DirectorStreamPolicy => {
  if (modelId === 'google/gemini-2.5-flash-lite') {
    return {
      maxTokens: 4_096,
      samplingParams: { reasoning: { max_tokens: 0 } },
    }
  }

  if (modelId === 'openai/gpt-oss-20b') {
    return {
      maxTokens: 4_096,
      reasoning: 'low',
      samplingParams: {
        provider: {
          ignore: ['darkbloom'],
          allow_fallbacks: true,
        },
      },
    }
  }

  return { maxTokens: MAX_DIRECTOR_OUTPUT_TOKENS }
}

export const stripTrailingFailedTurns = (entries: Entry[]): Entry[] => {
  let retainedCount = entries.length

  while (retainedCount >= 2) {
    const userEntry = entries[retainedCount - 2]
    const assistantEntry = entries[retainedCount - 1]
    const isFailedAssistant = assistantEntry.type === 'message'
      && assistantEntry.message.role === 'assistant'
      && (assistantEntry.message.stopReason === 'error' || assistantEntry.message.stopReason === 'length')
    const isPrecededByUser = userEntry.type === 'message' && userEntry.message.role === 'user'

    if (!isFailedAssistant || !isPrecededByUser) break
    retainedCount -= 2
  }

  return retainedCount === entries.length ? entries : entries.slice(0, retainedCount)
}

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

// 工具校验失败时（toolResults 中含 isError）让 Agent 循环自动把错误反馈给模型重试；
// 只有工具成功、或已经用尽尝试次数时才停止当前阶段。
export const createRetryingStopCondition = (maxAttempts: number) => {
  let attempts = 0
  return ({ toolResults }: ShouldStopAfterTurnContext) => {
    attempts += 1
    const hasToolError = toolResults.some((result) => result.isError)
    return !hasToolError || attempts >= maxAttempts
  }
}

export type DirectorAgentRequest = {
  apiKey: string
  modelId: DirectorModelId
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
  modelId,
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

  const provider = getDirectorModelProvider(modelId)
  const models = createModels()
  models.setProvider(provider === 'deepseek' ? deepseekProvider() : openrouterProvider())
  const model = models.getModel(provider, modelId)
  if (!model) throw new Error(`Pi 未找到${provider === 'deepseek' ? ' DeepSeek' : ' OpenRouter'}模型 ${modelId}。`)

  const completeSimple = models.completeSimple.bind(models)
  models.completeSimple = (compactModel, compactContext, options) => completeSimple(
    compactModel,
    compactContext,
    { ...options, apiKey },
  )

  // pi-ai 的 ToolChoice 类型只声明了 auto/none，但底层 OpenAI 兼容适配器会把
  // samplingParams 原样合并进请求体，因此用它强制模型直接调用指定工具，
  // 避免在工具调用之前输出闲聊文字（观测到的延迟大头）。
  const createDirectorStreamFn = (forcedToolName: string) => (
    streamModel: Model<Api>,
    streamContext: Parameters<Models['streamSimple']>[1],
    options?: SimpleStreamOptions,
  ) => {
    const policy = getDirectorStreamPolicy(modelId)
    return models.streamSimple(
      streamModel,
      streamContext,
      {
        ...options,
        ...policy,
        samplingParams: {
          ...policy.samplingParams,
          tool_choice: { type: 'function', function: { name: forcedToolName } },
        },
        apiKey,
        maxRetries: 2,
        timeoutMs: DIRECTOR_TIMEOUT_MS,
        telemetryContext: telemetry,
      },
    )
  }

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

  const subscribeForPersistence = (agentInstance: Agent) => agentInstance.subscribe(async (event) => {
    if (event.type !== 'message_end') return
    try {
      await session.appendMessage(toDurableMessage(event.message))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      persistenceErrors.push({ message, timestamp: Date.now() })
      console.error('Agent trace persistence failed:', message)
    }
  })

  let videoPhaseStarted = false
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
    const systemPromptEntries: AgentTraceEntry[] = [{
      id: `${traceId}:system-prompt`,
      kind: 'input',
      title: `Pi 场景阶段 System Prompt · ${modelId}`,
      timestamp: startedAt,
      text: DIRECTOR_SYSTEM_PROMPT,
    }]
    if (videoPhaseStarted) {
      systemPromptEntries.push({
        id: `${traceId}:video-system-prompt`,
        kind: 'input',
        title: `Pi 视频计划阶段 System Prompt · ${modelId}`,
        timestamp: startedAt,
        text: DIRECTOR_VIDEO_TOOL_INSTRUCTIONS,
      })
    }
    const trace: HarnessTraceSnapshot = {
      traceId,
      harnessSessionId: metadata.id,
      startedAt,
      endedAt,
      durationMs: endedAt - startedAt,
      outcome,
      stopReason: finalMessage?.role === 'assistant' ? finalMessage.stopReason : undefined,
      usage: summarizeAssistantUsage(currentRunMessages),
      entries: [...systemPromptEntries, ...projectTraceEntries(traceId, entries)],
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

  send({ type: 'trace_started', traceId, harnessSessionId: metadata.id, startedAt })
  send({ type: 'status', text: `Pi 故事导演正在通过 ${getDirectorModelLabel(modelId)} 构思下一幕。` })

  let scenePublish: ScenePublish | undefined
  const publishSceneTool = createPublishSceneTool((turn) => {
    scenePublish = toDurableValue(turn)
  })
  const sceneAgent = new Agent({
    initialState: {
      systemPrompt: DIRECTOR_SYSTEM_PROMPT,
      model,
      tools: [publishSceneTool],
      messages: buildSessionContext(stripTrailingFailedTurns(persistedEntries)).messages,
      thinkingLevel: 'off',
    },
    convertToLlm,
    streamFn: createDirectorStreamFn('publish_scene'),
    sessionId: metadata.id,
    maxRetryDelayMs: 5_000,
    shouldStopAfterTurn: createRetryingStopCondition(MAX_TOOL_ATTEMPTS),
  })

  signal?.addEventListener('abort', () => sceneAgent.abort(), { once: true })
  subscribeForPersistence(sceneAgent)

  try {
    await sceneAgent.prompt(buildStoryInputMessage(context.input))
    if (sceneAgent.state.errorMessage) throw new Error(sceneAgent.state.errorMessage)
    if (!scenePublish) throw new Error('Pi Agent 没有调用 publish_scene 发布场景。')

    send({ type: 'scene', scene: scenePublish.scene, characters: scenePublish.characters })
    send({ type: 'status', text: '场景已发布，正在生成视频计划。' })

    let videoPlan: VideoGenerationRequest | undefined
    try {
      videoPhaseStarted = true
      const videoPlanEntries = await session.findEntries({ order: 'oldestFirst' })
      const videoPlanTool = createVideoPlanTool(scenePublish.characters, (plan) => {
        videoPlan = toDurableValue(plan.video)
      })
      const videoAgent = new Agent({
        initialState: {
          systemPrompt: DIRECTOR_VIDEO_TOOL_INSTRUCTIONS,
          model,
          tools: [videoPlanTool],
          messages: buildSessionContext(videoPlanEntries).messages,
          thinkingLevel: 'off',
        },
        convertToLlm,
        streamFn: createDirectorStreamFn('submit_video_plan'),
        sessionId: metadata.id,
        maxRetryDelayMs: 5_000,
        shouldStopAfterTurn: createRetryingStopCondition(MAX_TOOL_ATTEMPTS),
      })

      signal?.addEventListener('abort', () => videoAgent.abort(), { once: true })
      subscribeForPersistence(videoAgent)

      await videoAgent.prompt(DIRECTOR_VIDEO_PLAN_USER_MESSAGE)
      if (videoAgent.state.errorMessage) throw new Error(videoAgent.state.errorMessage)
      if (!videoPlan) throw new Error('Pi Agent 没有调用 submit_video_plan 提交视频计划。')

      send({ type: 'video_plan', video: videoPlan })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      send({ type: 'video_plan_error', message })
    }

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
    return { scene: scenePublish.scene, characters: scenePublish.characters, video: videoPlan }
  } catch (error) {
    await sendTrace(signal?.aborted ? 'aborted' : 'failed')
    throw error
  }
}
