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
import { getDirectorApiModelId, getDirectorModelLabel, getDirectorModelProvider, type DirectorModelId } from '../src/config/directorModels.ts'
import type { CastableActor, CharacterCasting, SceneCastingResult } from '../src/types/actor.ts'
import type { AgentTraceEntry, DirectorStreamEvent, HarnessTraceSnapshot } from '../src/types/director.ts'
import type { DirectorTurnContext } from '../src/types/game.ts'
import type { ScenePublish, VideoGenerationRequest } from '../src/types/story.ts'
import {
  buildStoryInputMessage,
  buildVideoInputMessage,
  DIRECTOR_COMPACTION_INSTRUCTIONS,
  DIRECTOR_SYSTEM_PROMPT,
  DIRECTOR_VIDEO_SYSTEM_PROMPT,
} from './directorPrompt.ts'
import { createCastSceneTool } from './castSceneTool.ts'
import { createPublishSceneTool } from './publishSceneTool.ts'
import { createWriteVideoPromptTool } from './videoPlanTool.ts'
import { compileVideoPlan } from './videoPromptCompiler.ts'
import { inspectRawToolArguments, summarizeAssistantUsage, toDurableMessage, toDurableValue } from './directorTrace.ts'

import { assertNarrativeReview, narrativeReviewToolDefinition, narrativeSources, NARRATIVE_REVIEW_PROMPT } from './narrativeReview.ts'
import { withDirectorSession } from './directorSession.ts'
import { bigmodelProvider } from './bigmodelProvider.ts'

const MAX_DIRECTOR_OUTPUT_TOKENS = 4_096
const DIRECTOR_TIMEOUT_MS = 45_000
// 每个确定性阶段允许有限次定向修复，避免完整内容反复重写。
const MAX_TOOL_ATTEMPTS = 3
const traceEnvironment = new NodeExecutionEnv({ cwd: process.cwd() })
const traceRepo = new JsonlSessionRepo({
  fs: traceEnvironment,
  sessionsRoot: resolve(process.cwd(), '.agent-traces'),
})

type DirectorStreamPolicy = Pick<SimpleStreamOptions, 'maxTokens' | 'reasoning' | 'samplingParams'>

export const getDirectorStreamPolicy = (modelId: DirectorModelId, thinkingEnabled = false): DirectorStreamPolicy => {
  if (modelId === 'z-ai/glm-5.3-flash') {
    // GLM-5.3-Flash 强制思考，关闭增强思考时使用最低的 low 档。
    return { maxTokens: 16_384, reasoning: thinkingEnabled ? 'high' : 'low' }
  }
  if (modelId === 'deepseek-v4-flash') {
    return { maxTokens: 16_384, reasoning: thinkingEnabled ? 'high' : undefined }
  }

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
    if (entry.type === 'custom' && entry.customType === 'director_tool_arguments') {
      projected.push({
        id: entryId(traceId, entry, 'raw-arguments'),
        kind: 'assistant',
        title: '原始工具参数与 JSON 解析诊断',
        timestamp: entry.timestamp,
        data: entry.data,
      })
      continue
    }

    if (entry.type === 'custom' && entry.customType === 'director_trace') {
      projected.push({
        id: entryId(traceId, entry, 'trace'),
        kind: 'input',
        title: 'Pi Run 标识',
        timestamp: entry.timestamp,
        data: entry.data,
      })
      continue
    }

    if (entry.type === 'custom' && entry.customType === 'narrative_review') {
      projected.push({ id: entryId(traceId, entry, 'review'), kind: 'tool_result', title: '原文一致性核对', timestamp: entry.timestamp, data: entry.data })
      continue
    }

    if (entry.type === 'custom' && entry.customType === 'director_timing') {
      projected.push({
        id: entryId(traceId, entry, 'timing'),
        kind: 'assistant',
        title: 'Pi 阶段耗时',
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

// 工具校验失败时把完整问题列表反馈给当前阶段；目标成功或用尽尝试次数后停止。
export const createRetryingStopCondition = (
  maxAttempts: number,
  isComplete: () => boolean,
  onToolError?: (message: string) => void,
) => {
  let attempts = 0
  return ({ toolResults }: ShouldStopAfterTurnContext) => {
    const errorResult = toolResults.find((result) => result.isError)
    if (!errorResult) {
      attempts = 0
      return isComplete()
    }
    const errorText = errorResult.content.find((item) => item.type === 'text')?.text ?? '未知错误'
    onToolError?.(errorText)
    attempts += 1
    if (attempts < maxAttempts) return false
    attempts = 0
    return true
  }
}

export type DirectorAgentRequest = {
  apiKey: string
  modelId: DirectorModelId
  thinkingEnabled?: boolean
  context: DirectorTurnContext
  actors: CastableActor[]
  castings: CharacterCasting[]
  traceId: string
  signal?: AbortSignal
  send: (event: DirectorStreamEvent) => void
}

export async function runDirectorAgent(request: DirectorAgentRequest) {
  return withDirectorSession(request.context.sessionId, () => runPersistentDirector(request))
}

async function runPersistentDirector({
  apiKey,
  modelId,
  thinkingEnabled = false,
  context,
  actors,
  castings,
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
  const phaseTimings = {
    sessionSetupMs: Date.now() - startedAt,
    traceStartPersistenceMs: 0,
    modelSetupMs: 0,
    compactionPrecheckMs: 0,
    agentRunMs: 0,
    postCompactionMs: 0,
  }
  const providerTurns: Array<{
    turn: number
    startedAt: number
    responseStartedAt?: number
    firstTokenAt?: number
    endedAt?: number
    ttftMs?: number
    responseStartMs?: number
    durationMs?: number
    stopReason?: string
  }> = []
  const toolCalls: Array<{
    toolCallId: string
    toolName: string
    startedAt: number
    endedAt?: number
    durationMs?: number
    isError?: boolean
  }> = []
  let activeProviderTurn: typeof providerTurns[number] | undefined
  const activeToolCalls = new Map<string, typeof toolCalls[number]>()

  const traceStartPersistenceStartedAt = Date.now()
  try {
    await session.appendCustomEntry('director_trace', { traceId, modelId, thinkingEnabled, startedAt })
  } catch (error) {
    persistenceErrors.push({
      message: `Pi Trace ID 持久化失败：${error instanceof Error ? error.message : String(error)}`,
      timestamp: Date.now(),
    })
  } finally {
    phaseTimings.traceStartPersistenceMs = Date.now() - traceStartPersistenceStartedAt
  }

  const modelSetupStartedAt = Date.now()
  const provider = getDirectorModelProvider(modelId)
  const models = createModels()
  models.setProvider({ deepseek: deepseekProvider, openrouter: openrouterProvider, bigmodel: bigmodelProvider }[provider]())
  const model = models.getModel(provider, getDirectorApiModelId(modelId))
  if (!model) throw new Error(`Pi 未找到 ${provider} 模型 ${modelId}。`)

  const completeSimple = models.completeSimple.bind(models)
  models.completeSimple = (compactModel, compactContext, options) => completeSimple(
    compactModel,
    compactContext,
    { ...options, apiKey },
  )

  const createDirectorStreamFn = (forcedToolName: string) => (
    streamModel: Model<Api>,
    streamContext: Parameters<Models['streamSimple']>[1],
    options?: SimpleStreamOptions,
  ) => {
    activeProviderTurn = { turn: providerTurns.length + 1, startedAt: Date.now() }
    providerTurns.push(activeProviderTurn)
    const policy = getDirectorStreamPolicy(modelId, thinkingEnabled)
    return models.streamSimple(
      streamModel,
      streamContext,
      {
        ...options,
        ...policy,
        samplingParams: {
          ...policy.samplingParams,
          // 官方思考接口由模型选择工具；每个阶段只提供对应工具。
          ...(provider !== 'openrouter' ? {} : {
            tool_choice: { type: 'function', function: { name: forcedToolName } },
          }),
        },
        apiKey,
        maxRetries: 2,
        timeoutMs: provider !== 'openrouter' ? 120_000 : DIRECTOR_TIMEOUT_MS,
        telemetryContext: telemetry,
      },
    )
  }
  phaseTimings.modelSetupMs = Date.now() - modelSetupStartedAt

  const compactionPrecheckStartedAt = Date.now()
  try {
    if (await maybeCompact({ session, entries: persistedEntries, models, model, signal })) {
      persistedEntries = await session.findEntries({ order: 'oldestFirst' })
    }
  } catch (error) {
    persistenceErrors.push({
      message: `Pi Compaction 预检查失败：${error instanceof Error ? error.message : String(error)}`,
      timestamp: Date.now(),
    })
  } finally {
    phaseTimings.compactionPrecheckMs = Date.now() - compactionPrecheckStartedAt
  }

  const rawToolArguments = new Map<number, string>()
  const subscribeForPersistence = (agentInstance: Agent) => agentInstance.subscribe(async (event) => {
    const timestamp = Date.now()
    if (event.type === 'message_start' && event.message.role === 'assistant') {
      rawToolArguments.clear()
      if (!activeProviderTurn) {
        activeProviderTurn = { turn: providerTurns.length + 1, startedAt: timestamp }
        providerTurns.push(activeProviderTurn)
      }
      activeProviderTurn.responseStartedAt = timestamp
      activeProviderTurn.responseStartMs = timestamp - activeProviderTurn.startedAt
    }
    if (event.type === 'message_update' && event.message.role === 'assistant' && activeProviderTurn) {
      activeProviderTurn.firstTokenAt ??= timestamp
      activeProviderTurn.ttftMs ??= timestamp - activeProviderTurn.startedAt
    }
    if (event.type === 'message_update' && event.assistantMessageEvent.type === 'toolcall_delta') {
      const { contentIndex, delta } = event.assistantMessageEvent
      rawToolArguments.set(contentIndex, (rawToolArguments.get(contentIndex) ?? '') + delta)
    }
    if (event.type === 'message_end' && event.message.role === 'assistant' && activeProviderTurn) {
      activeProviderTurn.endedAt = timestamp
      activeProviderTurn.durationMs = timestamp - activeProviderTurn.startedAt
      activeProviderTurn.stopReason = event.message.stopReason
      activeProviderTurn = undefined
    }
    if (event.type === 'tool_execution_start') {
      const timing = {
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        startedAt: timestamp,
      }
      toolCalls.push(timing)
      activeToolCalls.set(event.toolCallId, timing)
    }
    if (event.type === 'tool_execution_end') {
      const timing = activeToolCalls.get(event.toolCallId)
      if (timing) {
        timing.endedAt = timestamp
        timing.durationMs = timestamp - timing.startedAt
        timing.isError = event.isError
        activeToolCalls.delete(event.toolCallId)
      }
    }
    if (event.type === 'message_end') {
      const argumentDiagnostics = event.message.role === 'assistant'
        ? event.message.content.flatMap((content, index) => {
            const raw = rawToolArguments.get(index)
            return content.type === 'toolCall' && raw !== undefined
              ? [{ toolCallId: content.id, toolName: content.name, ...inspectRawToolArguments(raw) }]
              : []
          })
        : []
      try {
        await session.appendMessage(toDurableMessage(event.message))
        for (const diagnostic of argumentDiagnostics) {
          await session.appendCustomEntry('director_tool_arguments', diagnostic)
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        persistenceErrors.push({ message, timestamp: Date.now() })
        console.error('Agent trace persistence failed:', message)
      }
    }
  })

  let timingPersisted = false
  const persistTiming = async () => {
    if (timingPersisted) return
    timingPersisted = true
    try {
      await session.appendCustomEntry('director_timing', toDurableValue({
        traceId,
        modelId,
        ...phaseTimings,
        providerTurns,
        toolCalls,
        totalMs: Date.now() - startedAt,
      }))
    } catch (error) {
      persistenceErrors.push({
        message: `Pi 阶段耗时持久化失败：${error instanceof Error ? error.message : String(error)}`,
        timestamp: Date.now(),
      })
    }
  }

  let videoPhaseStarted = false
  const orchestrationTraceEntries: AgentTraceEntry[] = []
  const reviewMessages: AgentMessage[] = []
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
        title: `Pi 视频阶段 System Prompt · ${modelId}`,
        timestamp: startedAt,
        text: DIRECTOR_VIDEO_SYSTEM_PROMPT,
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
      usage: summarizeAssistantUsage([...currentRunMessages, ...reviewMessages]),
      entries: [...systemPromptEntries, ...projectTraceEntries(traceId, entries), ...orchestrationTraceEntries]
        .sort((left, right) => left.timestamp - right.timestamp),
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

  const reviewNarrative = async (source: ScenePublish, finalVideo?: VideoGenerationRequest, referenceInput?: string) => {
    const input = {
      phase: finalVideo ? 'video' : 'scene',
      ...source,
      playerInput: context.input,
      sources: narrativeSources(source.scene.narrative),
      previousVisualState: context.hasPreviousTailFrame === false ? undefined : context.previousVisualState,
      finalVideo, referenceInput,
    }
    send({ type: 'status', text: finalVideo ? '正在逐条核对最终分镜与本幕原文。' : '正在核对出场人物与剧情边界。' })
    const reviewStartedAt = Date.now()
    const result = await models.completeSimple(model, {
      systemPrompt: NARRATIVE_REVIEW_PROMPT,
      messages: [{ role: 'user', content: JSON.stringify(input), timestamp: Date.now() }],
      tools: [narrativeReviewToolDefinition.function],
    }, {
      ...getDirectorStreamPolicy(modelId, thinkingEnabled), apiKey, signal,
      timeoutMs: provider !== 'openrouter' ? 120_000 : DIRECTOR_TIMEOUT_MS, maxRetries: 0,
      telemetryContext: telemetry,
    })
    reviewMessages.push(result)
    const call = result.content.find((item) => item.type === 'toolCall' && item.name === 'review_narrative')
    await session.appendCustomEntry('narrative_review', toDurableValue({
      traceId, input, systemPrompt: NARRATIVE_REVIEW_PROMPT,
      result: call?.type === 'toolCall' ? call.arguments : null,
      usage: result.usage, durationMs: Date.now() - reviewStartedAt,
    }))
    if (result.stopReason === 'error' || result.stopReason === 'aborted') throw new Error(result.errorMessage ?? '原文核对调用失败。')
    assertNarrativeReview(call?.type === 'toolCall' ? call.arguments : undefined, source, finalVideo)
  }

  let scenePublish: ScenePublish | undefined
  let lastPublishError: string | undefined
  const publishSceneTool = createPublishSceneTool((turn) => {
    scenePublish = toDurableValue(turn)
  }, (turn) => reviewNarrative(turn))
  const sceneAgent = new Agent({
    initialState: {
      systemPrompt: DIRECTOR_SYSTEM_PROMPT,
      model,
      tools: [publishSceneTool],
      messages: context.input.type === 'start' ? [] : buildSessionContext(stripTrailingFailedTurns(persistedEntries)).messages,
      thinkingLevel: getDirectorStreamPolicy(modelId, thinkingEnabled).reasoning ?? 'off',
    },
    convertToLlm,
    streamFn: createDirectorStreamFn('publish_scene'),
    sessionId: metadata.id,
    maxRetryDelayMs: 5_000,
    shouldStopAfterTurn: createRetryingStopCondition(
      MAX_TOOL_ATTEMPTS,
      () => Boolean(scenePublish),
      (message) => { lastPublishError = message },
    ),
  })

  signal?.addEventListener('abort', () => sceneAgent.abort(), { once: true })
  subscribeForPersistence(sceneAgent)

  const agentRunStartedAt = Date.now()
  try {
    await sceneAgent.prompt(buildStoryInputMessage(context.input, context.previousVisualState))
    if (sceneAgent.state.errorMessage) throw new Error(sceneAgent.state.errorMessage)
    if (!scenePublish) {
      throw new Error(lastPublishError
        ? `publish_scene 连续 ${MAX_TOOL_ATTEMPTS} 次未通过校验，最后一次错误：${lastPublishError}`
        : 'Pi Agent 没有调用 publish_scene 发布场景。')
    }

    send({ type: 'scene', scene: scenePublish.scene, characters: scenePublish.characters })
    send({ type: 'status', text: '场景已发布，正在准备人物参考素材。' })

    let castingResult: SceneCastingResult | undefined
    let videoDraft: VideoGenerationRequest | undefined
    let videoPlan: VideoGenerationRequest | undefined

    const castStartedAt = Date.now()
    const castTiming = {
      toolCallId: `${traceId}:cast-scene`,
      toolName: 'cast_scene',
      startedAt: castStartedAt,
    }
    toolCalls.push(castTiming)
    orchestrationTraceEntries.push({
      id: `${traceId}:cast-call`,
      kind: 'tool_call',
      title: '调用工具 · cast_scene',
      timestamp: castStartedAt,
      data: {},
    })
    const castingPromise = createCastSceneTool(scenePublish.characters, actors, castings)
      .execute(`${traceId}:cast-scene`, {})
      .then((result) => {
        const endedAt = Date.now()
        Object.assign(castTiming, {
          endedAt,
          durationMs: endedAt - castStartedAt,
          isError: false,
        })
        castingResult = toDurableValue(result.details)
        orchestrationTraceEntries.push({
          id: `${traceId}:cast-result`,
          kind: 'tool_result',
          title: '工具结果 · cast_scene',
          timestamp: Date.now(),
          data: castingResult,
        })
        send({ type: 'cast', casting: castingResult })
      }, (error) => {
        const endedAt = Date.now()
        Object.assign(castTiming, {
          endedAt,
          durationMs: endedAt - castStartedAt,
          isError: true,
        })
        throw error
      })

    const [castingOutcome] = await Promise.allSettled([castingPromise])
    if (castingOutcome.status === 'rejected') {
      const message = castingOutcome.reason instanceof Error
        ? castingOutcome.reason.message
        : String(castingOutcome.reason)
      orchestrationTraceEntries.push({
        id: `${traceId}:cast-error`,
        kind: 'error',
        title: '场景选角失败',
        timestamp: Date.now(),
        text: message,
        isError: true,
      })
      send({ type: 'cast_error', message })
    }
    const videoInputMessage = buildVideoInputMessage(
      scenePublish.characters, castingResult, actors, scenePublish.dialogues,
      context.previousVisualState, context.hasPreviousTailFrame, scenePublish.scene,
    )
    send({ type: 'status', text: '参考素材已确认，正在编写分镜。' })

    videoPhaseStarted = true
    let lastVideoError: string | undefined
    const videoPlanTool = createWriteVideoPromptTool(scenePublish.characters, scenePublish.dialogues, (plan) => {
      videoDraft = toDurableValue(plan.video)
    }, (video) => reviewNarrative(scenePublish!, video, videoInputMessage))
    const videoAgent = new Agent({
      initialState: {
        systemPrompt: DIRECTOR_VIDEO_SYSTEM_PROMPT,
        model,
        tools: [videoPlanTool],
        messages: [],
        thinkingLevel: getDirectorStreamPolicy(modelId, thinkingEnabled).reasoning ?? 'off',
      },
      convertToLlm,
      streamFn: createDirectorStreamFn('write_video_prompt'),
      sessionId: metadata.id,
      maxRetryDelayMs: 5_000,
      shouldStopAfterTurn: createRetryingStopCondition(
        MAX_TOOL_ATTEMPTS,
        () => Boolean(videoDraft),
        (message) => { lastVideoError = message },
      ),
    })
    signal?.addEventListener('abort', () => videoAgent.abort(), { once: true })
    subscribeForPersistence(videoAgent)

    const videoPromise = videoAgent.prompt(videoInputMessage).then(() => {
      if (videoAgent.state.errorMessage) throw new Error(videoAgent.state.errorMessage)
      if (!videoDraft) {
        throw new Error(lastVideoError
          ? `write_video_prompt 连续 ${MAX_TOOL_ATTEMPTS} 次未通过校验，最后一次错误：${lastVideoError}`
          : 'Pi Agent 没有调用 write_video_prompt 编写视频 Prompt。')
      }
    })

    const [videoOutcome] = await Promise.allSettled([videoPromise])
    if (videoOutcome.status === 'rejected') {
      const message = videoOutcome.reason instanceof Error
        ? videoOutcome.reason.message
        : String(videoOutcome.reason)
      send({ type: 'video_plan_error', message })
    } else if (videoDraft) {
      videoPlan = toDurableValue(compileVideoPlan(videoDraft))
      send({ type: 'video_plan', video: videoPlan })
    }

    phaseTimings.agentRunMs = Date.now() - agentRunStartedAt

    const postCompactionStartedAt = Date.now()
    try {
      const allEntries = await session.findEntries({ order: 'oldestFirst' })
      await maybeCompact({ session, entries: allEntries, models, model, signal })
    } catch (error) {
      persistenceErrors.push({
        message: `Pi Compaction 后处理失败：${error instanceof Error ? error.message : String(error)}`,
        timestamp: Date.now(),
      })
    } finally {
      phaseTimings.postCompactionMs = Date.now() - postCompactionStartedAt
    }

    await persistTiming()
    await sendTrace(castingResult && videoPlan ? 'completed' : 'degraded')
    send({ type: 'done' })
    return {
      scene: scenePublish.scene,
      characters: scenePublish.characters,
      casting: castingResult,
      video: videoPlan,
    }
  } catch (error) {
    phaseTimings.agentRunMs ||= Date.now() - agentRunStartedAt
    await persistTiming()
    await sendTrace(signal?.aborted ? 'aborted' : 'failed')
    throw error
  }
}
