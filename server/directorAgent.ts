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
import type { SceneCharacter, StoryScene, VideoGenerationRequest } from '../src/types/story.ts'
import {
  buildRewriteMessage,
  buildStoryInputMessage,
  DIRECTOR_COMPACTION_INSTRUCTIONS,
  DIRECTOR_SYSTEM_PROMPT,
  type DirectorVideoMode,
} from './directorPrompt.ts'
import {
  createCastingBook,
  createCastSceneTool,
  describeCastingStatus,
  exportCastingBook,
  importCastingBook,
  isCastingComplete,
  lookupCastingBookActor,
  pendingCastingCharacters,
  resolveSceneCasting,
} from './castSceneTool.ts'
import { createPublishSceneTool } from './publishSceneTool.ts'
import { createWriteSceneVideoTool, describeSegmentReferences, validateSceneSegments } from './writeSceneVideoTool.ts'
import { createInspectLastFrameTool } from './inspectLastFrameTool.ts'
import { compileVideoPlan } from './videoPromptCompiler.ts'
import { inspectRawToolArguments, summarizeAssistantUsage, toDurableMessage, toDurableValue } from './directorTrace.ts'
import { withDirectorSession } from './directorSession.ts'
import { bigmodelProvider } from './bigmodelProvider.ts'
import { analyzeTailFrame } from './tailFrameVision.ts'
import { projectHistory } from './directorContext.ts'
import {
  findRewritableScene,
  findUnresolvedToolCall,
  persistTurnState,
  type DirectorTurnState,
} from './directorTurnState.ts'

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

export type DirectorTurnOutcome = {
  scene?: StoryScene
  characters?: SceneCharacter[]
  casting?: SceneCastingResult
  video?: VideoGenerationRequest
}

// scene：写一个新场次；rewrite：玩家要求重写本场次第 sequence 段，只开放 write_scene_video。
type RunMode = { kind: 'scene' } | { kind: 'rewrite'; sequence: number }

type RunAgentSessionOptions = {
  state: DirectorTurnState
  session: Session<JsonlSessionMetadata>
  entries: Entry[]
  apiKey: string
  visionKey?: string
  analyze?: typeof analyzeTailFrame
  signal?: AbortSignal
  send: (event: DirectorStreamEvent) => void
  initialMessages: AgentMessage[]
  promptText: string
  mode: RunMode
}

// 新场次与重写某段共用：模型与工具搭建、持久化订阅、compaction、交齐判定、结束处理。
async function runAgentSession({
  state,
  session,
  entries,
  apiKey,
  signal,
  send,
  initialMessages,
  promptText,
  mode,
  visionKey,
  analyze = analyzeTailFrame,
}: RunAgentSessionOptions): Promise<DirectorTurnOutcome> {
  const persistenceErrors: Array<{ message: string; timestamp: number }> = []
  const metadata = await session.getMetadata()
  const telemetry = new InMemoryTelemetryContext()
  const phaseTimings = {
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

  const modelSetupStartedAt = Date.now()
  const provider = getDirectorModelProvider(state.modelId)
  const models = createModels()
  models.setProvider({ deepseek: deepseekProvider, openrouter: openrouterProvider, bigmodel: bigmodelProvider }[provider]())
  const model = models.getModel(provider, getDirectorApiModelId(state.modelId))
  if (!model) throw new Error(`Pi 未找到 ${provider} 模型 ${state.modelId}。`)

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
    const policy = getDirectorStreamPolicy(state.modelId, state.thinkingEnabled)
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
    if (await maybeCompact({ session, entries, models, model, signal })) {
      entries = await session.findEntries({ order: 'oldestFirst' })
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
        traceId: state.traceId,
        modelId: state.modelId,
        ...phaseTimings,
        providerTurns,
        toolCalls,
        totalMs: Date.now() - state.startedAt,
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
    let traceEntries: Entry[] = []
    try {
      traceEntries = await session.findEntries({
        order: 'oldestFirst',
        cursor: { afterSeq: state.startSeq },
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      persistenceErrors.push({ message, timestamp: Date.now() })
      console.error('Agent trace read failed:', message)
    }
    const endedAt = Date.now()
    const currentRunMessages = traceEntries.flatMap((entry): AgentMessage[] =>
      entry.type === 'message' ? [entry.message] : [],
    )
    const finalMessage = [...currentRunMessages].reverse().find((message) => message.role === 'assistant')
    const trace: HarnessTraceSnapshot = {
      traceId: state.traceId,
      harnessSessionId: metadata.id,
      startedAt: state.startedAt,
      endedAt,
      durationMs: endedAt - state.startedAt,
      outcome,
      stopReason: finalMessage?.role === 'assistant' ? finalMessage.stopReason : undefined,
      usage: summarizeAssistantUsage(currentRunMessages),
      entries: [
        {
          id: `${state.traceId}:system-prompt`,
          kind: 'input' as const,
          title: `Pi 导演 System Prompt · ${state.modelId}`,
          timestamp: state.startedAt,
          text: DIRECTOR_SYSTEM_PROMPT,
        },
        ...projectTraceEntries(state.traceId, traceEntries),
        ...orchestrationTraceEntries,
      ].sort((left, right) => left.timestamp - right.timestamp),
    }
    persistenceErrors.forEach((error, index) => {
      trace.entries.push({
        id: `${state.traceId}:persistence-error-${index}`,
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
        id: `${state.traceId}:telemetry`,
        kind: 'assistant',
        title: 'Pi Telemetry',
        timestamp: endedAt,
        data: telemetrySpans,
      })
    }
    send({ type: 'harness_trace', trace })
  }

  send({ type: 'trace_started', traceId: state.traceId, harnessSessionId: metadata.id, startedAt: state.startedAt })
  send({ type: 'status', text: mode.kind === 'rewrite'
    ? `Pi 故事导演正在通过 ${getDirectorModelLabel(state.modelId)} 重写第 ${mode.sequence} 段。`
    : `Pi 故事导演正在通过 ${getDirectorModelLabel(state.modelId)} 构思下一个场次。` })

  // 一次运行的状态：工具只在这里写入 state，程序据此守住依赖、判断是否交齐。
  const videoEnabled = state.videoMode !== 'off'
  const rewrite = mode.kind === 'rewrite' ? mode : undefined
  const book = state.castingBook ? importCastingBook(state.castingBook) : createCastingBook(state.actors, state.castings)
  if (state.scenePublish) book.speakingCharacterIds = new Set(state.scenePublish.dialogues.map((dialogue) => dialogue.characterId))
  let lastToolError: string | undefined
  let rewritten = false
  const sceneCharacters = () => state.scenePublish?.characters ?? []
  const lookupActor = (characterId: string) => lookupCastingBookActor(book, characterId)

  // 交齐即停：剧情、选角、分镜（或跳过视频的理由）都有了就结束，不再多花一次模型调用。
  const isComplete = () => {
    if (rewrite) return rewritten
    if (!state.scenePublish || !isCastingComplete(book, state.scenePublish.characters)) return false
    return !videoEnabled || Boolean(state.video) || Boolean(state.skipVideoReason)
  }

  const publishSceneTool = createPublishSceneTool((turn) => {
    state.scenePublish = toDurableValue(turn)
    book.speakingCharacterIds = new Set(turn.dialogues.map((dialogue) => dialogue.characterId))
    send({ type: 'scene', scene: state.scenePublish.scene, characters: state.scenePublish.characters })
    send({ type: 'status', text: '剧情已发布，正在确定人物选角。' })
  }, {
    isPublished: () => Boolean(state.scenePublish),
    describeCasting: (turn) => describeCastingStatus(book, turn.characters),
  })

  const castSceneTool = createCastSceneTool(book, sceneCharacters, () => {
    send({ type: 'status', text: videoEnabled ? '选角已确定，正在编写本场次分镜。' : '选角已确定。' })
  })

  const inspectLastFrameTool = createInspectLastFrameTool({
    getPreviousScene: () => state.context.previousScene,
    visionKey,
    analyze,
    signal,
    onInspect: (visualState) => {
      state.inspected = visualState
      send({ type: 'status', text: '导演查看了上一场次的最后一帧。' })
    },
  })

  const writeSceneVideoTool = createWriteSceneVideoTool({
    getCharacters: sceneCharacters,
    getDialogues: () => state.scenePublish?.dialogues ?? [],
    getRewrite: () => rewrite && state.video ? { sequence: rewrite.sequence, draft: state.video } : undefined,
    precondition: (input) => {
      if (!state.scenePublish) return '必须先通过 publish_scene 发布场景。'
      const pending = pendingCastingCharacters(book, state.scenePublish.characters)
      if (pending.length) {
        return `以下人物尚未选角：${pending.map((character) => `${character.name}（${character.id}）`).join('、')}；请先调用 cast_scene。`
      }
      if (!rewrite && input.opening === 'continue') {
        if (!state.context.previousScene) return '上一场次没有可接的视频画面，第 1 段只能用 opening: "new_shot"。'
        if (!state.inspected) return '要接着上一场次画面拍（opening: continue），必须先调用 inspect_last_frame 查看上一场次最后一帧。'
      }
      return null
    },
    onWrite: (result) => {
      if (result.kind === 'skip') {
        state.video = undefined
        state.skipVideoReason = result.reason
        send({ type: 'status', text: `导演决定本场次不生成视频：${result.reason}` })
        return
      }
      state.video = toDurableValue(result.draft)
      state.skipVideoReason = undefined
      if (result.kind === 'rewrite') rewritten = true
      send({
        type: 'status',
        text: result.kind === 'rewrite' ? `第 ${result.sequence} 段已重写。` : `本场次分镜已写好，共 ${result.segments.length} 段。`,
      })
    },
  })

  const agent = new Agent({
    initialState: {
      systemPrompt: DIRECTOR_SYSTEM_PROMPT,
      model,
      tools: rewrite
        ? [writeSceneVideoTool]
        : [
            publishSceneTool,
            castSceneTool,
            ...(videoEnabled ? [inspectLastFrameTool, writeSceneVideoTool] : []),
          ],
      messages: initialMessages,
      thinkingLevel: getDirectorStreamPolicy(state.modelId, state.thinkingEnabled).reasoning ?? 'off',
    },
    convertToLlm,
    streamFn: directorStreamFn,
    sessionId: metadata.id,
    maxRetryDelayMs: 5_000,
    shouldStopAfterTurn: createRetryingStopCondition(
      MAX_TOOL_ATTEMPTS,
      isComplete,
      (message) => { lastToolError = message },
    ),
  })

  signal?.addEventListener('abort', () => agent.abort(), { once: true })
  subscribeForPersistence(agent)

  const agentRunStartedAt = Date.now()

  const describeMissing = () => {
    if (rewrite) return `还没有重写第 ${rewrite.sequence} 段（write_scene_video，rewriteSequence: ${rewrite.sequence}）`
    if (state.scenePublish && !isCastingComplete(book, state.scenePublish.characters)) return '还有人物没有选角（cast_scene）'
    return '还没有提交本场次分镜（write_scene_video）'
  }

  try {
    await agent.prompt(promptText)
    if (agent.state.errorMessage) throw new Error(agent.state.errorMessage)

    // 模型停下却没交齐：不是校验失败导致的就提醒一次，再不行按已有结果降级。
    if (!isComplete() && !lastToolError && (rewrite || state.scenePublish)) {
      send({ type: 'status', text: '导演尚未交齐，正在提醒继续。' })
      await agent.prompt(`本场次尚未完成：${describeMissing()}。请继续调用工具。`)
      if (agent.state.errorMessage) throw new Error(agent.state.errorMessage)
    }

    if (rewrite && !rewritten) {
      throw new Error(lastToolError
        ? `重写第 ${rewrite.sequence} 段连续 ${MAX_TOOL_ATTEMPTS} 次未通过校验，最后一次错误：${lastToolError}`
        : `导演没有重写第 ${rewrite.sequence} 段。`)
    }
    if (!state.scenePublish) {
      throw new Error(lastToolError
        ? `publish_scene 连续 ${MAX_TOOL_ATTEMPTS} 次未通过校验，最后一次错误：${lastToolError}`
        : 'Pi Agent 没有调用 publish_scene 发布场景。')
    }

    let castingResult: SceneCastingResult | undefined
    if (!rewrite) {
      castingResult = toDurableValue(resolveSceneCasting(book, state.scenePublish.characters))
      orchestrationTraceEntries.push({
        id: `${state.traceId}:cast-result`,
        kind: 'tool_result',
        title: '本场次最终选角',
        timestamp: Date.now(),
        data: castingResult,
      })
      send({ type: 'cast', casting: castingResult })
    }

    let videoPlan: VideoGenerationRequest | undefined
    if (videoEnabled && state.video) {
      const segments = validateSceneSegments(state.video.segments, state.scenePublish.characters, state.scenePublish.dialogues)
      const videoPrompts = segments.map((segment) => ({
        sequence: segment.sequence,
        startTime: segment.startTime,
        endTime: segment.endTime,
        characterIds: segment.characterIds,
        prompt: segment.prompt,
      }))
      const request: VideoGenerationRequest = {
        totalDuration: videoPrompts.at(-1)?.endTime ?? 0,
        style: state.video.style,
        videoPrompts,
      }
      videoPlan = toDurableValue(compileVideoPlan(request))
      send({
        type: 'video_plan',
        video: videoPlan,
        references: describeSegmentReferences(state.video.opening, videoPrompts, lookupActor),
        fromSequence: rewrite?.sequence ?? 1,
      })
    } else if (videoEnabled) {
      const message = state.skipVideoReason
        ? `导演跳过了本场次视频：${state.skipVideoReason}`
        : lastToolError
          ? `分镜连续 ${MAX_TOOL_ATTEMPTS} 次未通过校验，最后一次错误：${lastToolError}`
          : '导演没有编写本场次分镜。'
      orchestrationTraceEntries.push({
        id: `${state.traceId}:video-plan-error`,
        kind: 'error',
        title: '本场次分镜未完成',
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
    await persistTurnState(session, { ...state, status: 'finished', castingBook: exportCastingBook(book) })
    await sendTrace(isComplete() ? 'completed' : 'degraded')
    send({ type: 'done' })
    return {
      scene: state.scenePublish.scene,
      characters: state.scenePublish.characters,
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

// 上一次运行中断（或旧版暂停回合）留下没有结果的工具调用时补一条失败结果，否则模型 API 会拒绝这段历史。
const closeUnresolvedToolCall = async (session: Session<JsonlSessionMetadata>, entries: Entry[]) => {
  const unresolved = findUnresolvedToolCall(entries)
  if (!unresolved) return entries
  await session.appendMessage({
    role: 'toolResult',
    toolCallId: unresolved.toolCallId,
    toolName: unresolved.toolName,
    content: [{ type: 'text', text: '上次运行已中断，这次工具调用作废。' }],
    details: {},
    isError: true,
    timestamp: Date.now(),
  })
  return session.findEntries({ order: 'oldestFirst' })
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
  // inspect_last_frame 用 DeepSeek Vision；没配时导演只能换场景开场。
  visionKey?: string
  analyze?: typeof analyzeTailFrame
  signal?: AbortSignal
  send: (event: DirectorStreamEvent) => void
}

export async function runDirectorAgent(request: DirectorAgentRequest): Promise<DirectorTurnOutcome> {
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
  visionKey,
  analyze,
  signal,
  send,
}: DirectorAgentRequest): Promise<DirectorTurnOutcome> {
  const startedAt = Date.now()
  const session = await getOrCreateSession(context.sessionId)
  let persistedEntries = await closeUnresolvedToolCall(session, await session.findEntries({ order: 'oldestFirst' }))

  const startSeq = lastSequence(persistedEntries)
  await session.appendCustomEntry('director_trace', { traceId, modelId, thinkingEnabled, startedAt })
  persistedEntries = await session.findEntries({ order: 'oldestFirst' })

  const state: DirectorTurnState = {
    status: 'running',
    traceId,
    modelId,
    thinkingEnabled,
    videoMode,
    context,
    actors,
    castings,
    startSeq,
    startedAt,
  }

  const initialMessages = context.input.type === 'start'
    ? []
    : buildSessionContext(stripTrailingFailedTurns(projectHistory(persistedEntries))).messages

  return runAgentSession({
    state,
    session,
    entries: persistedEntries,
    apiKey,
    visionKey,
    analyze,
    signal,
    send,
    initialMessages,
    promptText: buildStoryInputMessage(context.input, { videoMode, hasPreviousFrame: Boolean(context.previousScene) }),
    mode: { kind: 'scene' },
  })
}

export type RewriteDirectorRequest = {
  sessionId: string
  sequence: number
  reason: string
  apiKey: string
  modelId: DirectorModelId
  thinkingEnabled?: boolean
  // 最新演员库：玩家可能刚补了参考图或改了外观。
  actors: CastableActor[]
  traceId: string
  signal?: AbortSignal
  send: (event: DirectorStreamEvent) => void
}

export async function rewriteDirectorSegment(request: RewriteDirectorRequest): Promise<DirectorTurnOutcome> {
  return withDirectorSession(request.sessionId, () => runRewriteDirector(request))
}

async function runRewriteDirector({
  sessionId,
  sequence,
  reason,
  apiKey,
  modelId,
  thinkingEnabled = false,
  actors,
  traceId,
  signal,
  send,
}: RewriteDirectorRequest): Promise<DirectorTurnOutcome> {
  const startedAt = Date.now()
  const session = await getOrCreateSession(sessionId)
  let entries = await session.findEntries({ order: 'oldestFirst' })
  const scene = findRewritableScene(entries)
  if (!scene?.video) throw new Error('当前场次没有可重写的分镜。')
  if (sequence > scene.video.segments.length) throw new Error(`本场次只有 ${scene.video.segments.length} 段。`)
  entries = await closeUnresolvedToolCall(session, entries)

  const startSeq = lastSequence(entries)
  await session.appendCustomEntry('director_trace', { traceId, modelId, thinkingEnabled, startedAt, rewriteSequence: sequence })
  entries = await session.findEntries({ order: 'oldestFirst' })

  const latestActors = new Map(actors.map((actor) => [actor.id, actor]))
  const castingBook = scene.castingBook && {
    ...scene.castingBook,
    actors: scene.castingBook.actors.map((actor) => latestActors.get(actor.id) ?? actor),
  }
  const state: DirectorTurnState = {
    ...scene,
    status: 'running',
    traceId,
    modelId,
    thinkingEnabled,
    startSeq,
    startedAt,
    castingBook,
  }

  return runAgentSession({
    state,
    session,
    entries,
    apiKey,
    signal,
    send,
    initialMessages: buildSessionContext(stripTrailingFailedTurns(projectHistory(entries))).messages,
    promptText: buildRewriteMessage(sequence, reason, scene.video),
    mode: { kind: 'rewrite', sequence },
  })
}
