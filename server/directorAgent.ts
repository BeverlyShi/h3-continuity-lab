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
  DIRECTOR_COMPACTION_INSTRUCTIONS,
  DIRECTOR_SYSTEM_PROMPT,
  type DirectorVideoMode,
} from './directorPrompt.ts'
import {
  createCastingBook,
  createCastSceneTool,
  createSearchActorsTool,
  describeCastingStatus,
  isCastingComplete,
  pendingCastingCharacters,
  resolveSceneCasting,
} from './castSceneTool.ts'
import { createPublishSceneTool } from './publishSceneTool.ts'
import { createWriteVideoPromptTool } from './videoPlanTool.ts'
import { createFinishTurnTool } from './finishTurnTool.ts'
import { compileVideoPlan } from './videoPromptCompiler.ts'
import { inspectRawToolArguments, summarizeAssistantUsage, toDurableMessage, toDurableValue } from './directorTrace.ts'
import { withDirectorSession } from './directorSession.ts'
import { bigmodelProvider } from './bigmodelProvider.ts'

const MAX_DIRECTOR_OUTPUT_TOKENS = 4_096
const DIRECTOR_TIMEOUT_MS = 45_000
// 工具连续校验失败达到该次数后结束回合，避免模型反复重写。
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
  videoMode?: DirectorVideoMode
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
  videoMode = 'auto',
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

  const directorStreamFn = (
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

  const orchestrationTraceEntries: AgentTraceEntry[] = []
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
      entries: [
        {
          id: `${traceId}:system-prompt`,
          kind: 'input' as const,
          title: `Pi 导演 System Prompt · ${modelId}`,
          timestamp: startedAt,
          text: DIRECTOR_SYSTEM_PROMPT,
        },
        ...projectTraceEntries(traceId, entries),
        ...orchestrationTraceEntries,
      ].sort((left, right) => left.timestamp - right.timestamp),
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

  // 单个 agent 的回合状态：工具只在这里写入，程序据此守住前置条件。
  const videoEnabled = videoMode !== 'off'
  const book = createCastingBook(actors, castings)
  let scenePublish: ScenePublish | undefined
  let castingResult: SceneCastingResult | undefined
  let videoDraft: VideoGenerationRequest | undefined
  let finished = false
  let skipVideoReason: string | undefined
  let lastToolError: string | undefined
  const sceneCharacters = () => scenePublish?.characters ?? []

  const publishSceneTool = createPublishSceneTool((turn) => {
    scenePublish = toDurableValue(turn)
    send({ type: 'scene', scene: scenePublish.scene, characters: scenePublish.characters })
    send({ type: 'status', text: '场景已发布，正在确定人物参考素材。' })
  }, {
    isPublished: () => Boolean(scenePublish),
    describeCasting: (turn) => {
      const status = describeCastingStatus(book, turn.characters)
      const next = pendingCastingCharacters(book, turn.characters).length
        ? ''
        : `\n下一步：${videoEnabled ? '调用 write_video_prompt 编写分镜。' : '本局为仅文字模式，调用 finish_turn 结束回合。'}`
      return `${status}${next}`
    },
  })
  const searchActorsTool = createSearchActorsTool(book, sceneCharacters)
  const castSceneTool = createCastSceneTool(book, sceneCharacters, (result) => {
    castingResult = toDurableValue(result)
    send({ type: 'status', text: '选角已确定，正在编写分镜。' })
  })
  const videoPlanTool = createWriteVideoPromptTool({
    getCharacters: sceneCharacters,
    getDialogues: () => scenePublish?.dialogues ?? [],
    precondition: () => {
      if (!scenePublish) return '必须先通过 publish_scene 发布场景。'
      const pending = pendingCastingCharacters(book, scenePublish.characters)
      return pending.length
        ? `以下人物尚未选角：${pending.map((character) => `${character.name}（${character.id}）`).join('、')}；请先用 search_actors 查询候选并调用 cast_scene。`
        : null
    },
    onPublish: (plan) => {
      videoDraft = toDurableValue(plan.video)
      send({ type: 'status', text: '分镜已提交，等待导演确认。' })
    },
  })
  const finishTurnTool = createFinishTurnTool({
    check: (input) => {
      if (!scenePublish) return '尚未发布场景，请先调用 publish_scene。'
      if (!isCastingComplete(book, scenePublish.characters)) {
        return `以下人物尚未选角：${pendingCastingCharacters(book, scenePublish.characters).map((character) => character.name).join('、')}；请先调用 cast_scene。`
      }
      if (videoEnabled && !videoDraft && !input.skipVideo) {
        return '尚未编写分镜，请先调用 write_video_prompt；无法完成时通过 skipVideo.reason 说明原因后再结束。'
      }
      return null
    },
    onFinish: (input) => {
      finished = true
      skipVideoReason = input.skipVideo?.reason
    },
  })

  const agent = new Agent({
    initialState: {
      systemPrompt: DIRECTOR_SYSTEM_PROMPT,
      model,
      tools: [
        publishSceneTool,
        searchActorsTool,
        castSceneTool,
        ...(videoEnabled ? [videoPlanTool] : []),
        finishTurnTool,
      ],
      messages: context.input.type === 'start' ? [] : buildSessionContext(stripTrailingFailedTurns(persistedEntries)).messages,
      thinkingLevel: getDirectorStreamPolicy(modelId, thinkingEnabled).reasoning ?? 'off',
    },
    convertToLlm,
    streamFn: directorStreamFn,
    sessionId: metadata.id,
    maxRetryDelayMs: 5_000,
    shouldStopAfterTurn: (() => {
      const retrying = createRetryingStopCondition(
        MAX_TOOL_ATTEMPTS,
        () => finished,
        (message) => { lastToolError = message },
      )
      return (turn: ShouldStopAfterTurnContext) => {
        if (!turn.toolResults.some((result) => result.isError)) lastToolError = undefined
        return retrying(turn)
      }
    })(),
  })

  signal?.addEventListener('abort', () => agent.abort(), { once: true })
  subscribeForPersistence(agent)

  const agentRunStartedAt = Date.now()
  try {
    await agent.prompt(buildStoryInputMessage(context.input, context.previousVisualState, {
      videoMode,
      hasPreviousTailFrame: context.hasPreviousTailFrame ?? Boolean(context.previousVisualState),
    }))
    if (agent.state.errorMessage) throw new Error(agent.state.errorMessage)

    // 模型停下来却没有结束回合：不是校验失败导致的就提醒一次，再不行按已有结果降级。
    if (!finished && scenePublish && !lastToolError) {
      const missing = videoEnabled && !videoDraft ? '还没有编写分镜' : '还没有调用 finish_turn'
      send({ type: 'status', text: '导演尚未结束回合，正在提醒继续。' })
      await agent.prompt(`本回合尚未结束：${missing}。请继续调用工具完成剩余步骤，最后调用 finish_turn。`)
      if (agent.state.errorMessage) throw new Error(agent.state.errorMessage)
    }

    if (!scenePublish) {
      throw new Error(lastToolError
        ? `publish_scene 连续 ${MAX_TOOL_ATTEMPTS} 次未通过校验，最后一次错误：${lastToolError}`
        : 'Pi Agent 没有调用 publish_scene 发布场景。')
    }

    castingResult = toDurableValue(resolveSceneCasting(book, scenePublish.characters))
    orchestrationTraceEntries.push({
      id: `${traceId}:cast-result`,
      kind: 'tool_result',
      title: '本幕最终选角',
      timestamp: Date.now(),
      data: castingResult,
    })
    send({ type: 'cast', casting: castingResult })

    let videoPlan: VideoGenerationRequest | undefined
    if (videoDraft) {
      videoPlan = toDurableValue(compileVideoPlan(videoDraft))
      send({ type: 'video_plan', video: videoPlan })
    } else if (videoEnabled) {
      const message = skipVideoReason
        ? `导演跳过了本幕视频：${skipVideoReason}`
        : lastToolError
          ? `视频计划连续 ${MAX_TOOL_ATTEMPTS} 次未通过校验，最后一次错误：${lastToolError}`
          : '导演没有编写本幕视频计划。'
      orchestrationTraceEntries.push({
        id: `${traceId}:video-plan-error`,
        kind: 'error',
        title: '视频计划未完成',
        timestamp: Date.now(),
        text: message,
        isError: true,
      })
      send({ type: 'video_plan_error', message })
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
    const completed = finished && (!videoEnabled || Boolean(videoPlan))
    await sendTrace(completed ? 'completed' : 'degraded')
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
