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
import { createWriteSegmentTool, describeReferenceImages } from './writeSegmentTool.ts'
import { buildResumedGenerationSummary, createGenerateSegmentTool, MAX_GENERATE_ATTEMPTS } from './generateSegmentTool.ts'
import { createFinishTurnTool } from './finishTurnTool.ts'
import { compileVideoPlan } from './videoPromptCompiler.ts'
import { inspectRawToolArguments, summarizeAssistantUsage, toDurableMessage, toDurableValue } from './directorTrace.ts'
import { withDirectorSession } from './directorSession.ts'
import { bigmodelProvider } from './bigmodelProvider.ts'
import { analyzeTailFrame } from './tailFrameVision.ts'
import { projectHistory } from './directorContext.ts'
import {
  findAwaitingUpload,
  findUnresolvedToolCall,
  persistTurnState,
  readLatestTurnState,
  type DirectorTurnState,
} from './directorTurnState.ts'

export type DirectorTurnStatusResponse =
  | { status: 'idle' }
  | {
    status: 'awaiting_upload'
    awaiting: {
      sequence: number
      toolCallId: string
      prompt: string
      seconds: number
      referenceImages: ReturnType<typeof describeReferenceImages>
      traceId: string
    }
  }

// 供 /api/director/resume 内部选择 provider key：resume 请求不带 model 字段，由已存的回合状态决定。
export async function getAwaitingModelId(sessionId: string): Promise<DirectorModelId | undefined> {
  const session = await getOrCreateSession(sessionId)
  const entries = await session.findEntries({ order: 'oldestFirst' })
  return findAwaitingUpload(entries)?.state.modelId
}

// 供 GET /api/director/turn-state 只读查询：不加锁、不跑 Agent，只看最新持久化状态。
export async function getDirectorTurnStatus(sessionId: string): Promise<DirectorTurnStatusResponse> {
  const session = await getOrCreateSession(sessionId)
  const entries = await session.findEntries({ order: 'oldestFirst' })
  const awaiting = findAwaitingUpload(entries)
  if (!awaiting) return { status: 'idle' }

  const segment = awaiting.state.video.segments.find((candidate) => candidate.sequence === awaiting.pending.sequence)
  const book = awaiting.state.castingBook
    ? importCastingBook(awaiting.state.castingBook)
    : createCastingBook(awaiting.state.actors, awaiting.state.castings)
  const referenceImages = describeReferenceImages(awaiting.pending.sequence, segment?.characters ?? [], {
    hasPreviousTailFrame: awaiting.state.context.hasPreviousTailFrame ?? Boolean(awaiting.state.context.previousVisualState),
    lookupActor: (characterId) => lookupCastingBookActor(book, characterId),
  })
  return {
    status: 'awaiting_upload',
    awaiting: {
      sequence: awaiting.pending.sequence,
      toolCallId: awaiting.pending.toolCallId,
      prompt: segment?.prompt ?? '',
      seconds: segment?.seconds ?? 0,
      referenceImages,
      traceId: awaiting.state.traceId,
    },
  }
}

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
  paused: boolean
}

type RunAgentSessionOptions = {
  state: DirectorTurnState
  session: Session<JsonlSessionMetadata>
  entries: Entry[]
  apiKey: string
  signal?: AbortSignal
  send: (event: DirectorStreamEvent) => void
  initialMessages: AgentMessage[]
  // 只有新回合需要：字符串会走 agent.prompt(text)；省略时走 agent.continue()（恢复流程）。
  promptText?: string
}

// 新回合与恢复流程共用：模型与工具搭建、持久化订阅、compaction、暂停判定、结束处理。
async function runAgentSession({
  state,
  session,
  entries,
  apiKey,
  signal,
  send,
  initialMessages,
  promptText,
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
      // generate_segment 暂停时的占位 toolResult 不落盘，让 JSONL 停在带未决工具调用的 assistant 消息。
      if (event.message.role === 'toolResult' && (event.message.details as { pending?: boolean } | undefined)?.pending === true) {
        return
      }
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
  send({ type: 'status', text: `Pi 故事导演正在通过 ${getDirectorModelLabel(state.modelId)} 构思下一幕。` })

  // 单个 agent 的回合状态：工具只在这里写入 state，程序据此守住前置条件。
  const videoEnabled = state.videoMode !== 'off'
  const book = state.castingBook ? importCastingBook(state.castingBook) : createCastingBook(state.actors, state.castings)
  if (state.scenePublish) book.speakingCharacterIds = new Set(state.scenePublish.dialogues.map((dialogue) => dialogue.characterId))
  let lastToolError: string | undefined
  const sceneCharacters = () => state.scenePublish?.characters ?? []
  const hasPreviousTailFrame = () => state.context.hasPreviousTailFrame ?? Boolean(state.context.previousVisualState)
  const lookupActor = (characterId: string) => lookupCastingBookActor(book, characterId)

  const describePendingUpload = () => {
    if (!state.pending) return undefined
    const segment = state.video.segments.find((candidate) => candidate.sequence === state.pending!.sequence)
    const referenceImages = describeReferenceImages(state.pending.sequence, segment?.characters ?? [], {
      hasPreviousTailFrame: hasPreviousTailFrame(),
      lookupActor,
    })
    return {
      sequence: state.pending.sequence,
      toolCallId: state.pending.toolCallId,
      prompt: segment?.prompt ?? '',
      seconds: segment?.seconds ?? 0,
      referenceImages,
    }
  }

  const publishSceneTool = createPublishSceneTool((turn) => {
    state.scenePublish = toDurableValue(turn)
    book.speakingCharacterIds = new Set(turn.dialogues.map((dialogue) => dialogue.characterId))
    send({ type: 'scene', scene: state.scenePublish.scene, characters: state.scenePublish.characters })
    send({ type: 'status', text: '场景已发布，正在确定人物参考素材。' })
  }, {
    isPublished: () => Boolean(state.scenePublish),
    describeCasting: (turn) => {
      const status = describeCastingStatus(book, turn.characters)
      const next = pendingCastingCharacters(book, turn.characters).length
        ? ''
        : `\n下一步：${videoEnabled ? '调用 write_segment 编写第 1 段分镜。' : '本局为仅文字模式，调用 finish_turn 结束回合。'}`
      return `${status}${next}`
    },
  })

  const castSceneTool = createCastSceneTool(book, sceneCharacters, () => {
    send({ type: 'status', text: '选角已确定，正在编写分镜。' })
  })

  const writeSegmentTool = createWriteSegmentTool({
    getCharacters: sceneCharacters,
    getDialogues: () => state.scenePublish?.dialogues ?? [],
    getExistingSegments: () => state.video.segments,
    getHasPreviousTailFrame: hasPreviousTailFrame,
    lookupActor,
    precondition: () => {
      if (!state.scenePublish) return '必须先通过 publish_scene 发布场景。'
      const pending = pendingCastingCharacters(book, state.scenePublish.characters)
      return pending.length
        ? `以下人物尚未选角：${pending.map((character) => `${character.name}（${character.id}）`).join('、')}；请先调用 cast_scene。`
        : null
    },
    onWrite: (result) => {
      state.video.segments = state.video.segments.filter((segment) => segment.sequence < result.segment.sequence)
      if (result.segment.style) state.video.style = result.segment.style
      state.video.segments.push({
        sequence: result.segment.sequence,
        characters: result.segment.characters,
        seconds: result.segment.seconds,
        isLast: result.segment.isLast,
        prompt: result.segment.prompt,
        lineIds: result.segment.lineIds,
        style: result.segment.style,
        generateAttempts: 0,
      })
      state.video.segments.sort((left, right) => left.sequence - right.sequence)
      const priorSeconds = result.cumulativeSeconds - result.segment.seconds
      const referenceImages = describeReferenceImages(result.segment.sequence, result.segment.characters, {
        hasPreviousTailFrame: hasPreviousTailFrame(),
        lookupActor,
      })
      send({
        type: 'segment_written',
        segment: {
          sequence: result.segment.sequence,
          startTime: priorSeconds,
          endTime: result.cumulativeSeconds,
          characterIds: result.segment.characters,
          prompt: result.segment.prompt,
        },
        referenceImages,
        cumulativeSeconds: result.cumulativeSeconds,
      })
      send({ type: 'status', text: `第 ${result.segment.sequence} 段分镜已写好。` })
    },
  })

  const generateSegmentTool = createGenerateSegmentTool({
    getSegments: () => state.video.segments,
    onGenerate: ({ sequence, toolCallId }) => {
      for (const segment of state.video.segments) {
        if (segment.sequence === sequence) segment.generateAttempts += 1
        if (segment.sequence >= sequence) segment.generated = undefined
      }
      state.pending = { sequence, toolCallId }
      send({ type: 'status', text: `第 ${sequence} 段等待生成与上传。` })
    },
  })

  const finishTurnTool = createFinishTurnTool({
    check: (input) => {
      if (!state.scenePublish) return '尚未发布场景，请先调用 publish_scene。'
      if (!isCastingComplete(book, state.scenePublish.characters)) {
        return `以下人物尚未选角：${pendingCastingCharacters(book, state.scenePublish.characters).map((character) => character.name).join('、')}；请先调用 cast_scene。`
      }
      if (videoEnabled && !input.skipVideo) {
        const written = state.video.segments
        if (written.length < 2) {
          return '至少需要写完并生成 2 段视频才能结束；请继续调用 write_segment / generate_segment，或通过 skipVideo.reason 说明原因后结束。'
        }
        const last = written[written.length - 1]
        if (!last.isLast) {
          return '最后一段还没有标记为本幕最后一段（isLast），请先完成分镜；或通过 skipVideo.reason 说明原因后结束。'
        }
        const notGenerated = written.find((segment) => !segment.generated)
        if (notGenerated) {
          return `第 ${notGenerated.sequence} 段还没有生成，请先调用 generate_segment；或通过 skipVideo.reason 说明原因后结束。`
        }
      }
      return null
    },
    onFinish: (input) => {
      state.finished = true
      state.skipVideoReason = input.skipVideo?.reason
    },
  })

  const agent = new Agent({
    initialState: {
      systemPrompt: DIRECTOR_SYSTEM_PROMPT,
      model,
      tools: [
        publishSceneTool,
        castSceneTool,
        ...(videoEnabled ? [writeSegmentTool, generateSegmentTool] : []),
        finishTurnTool,
      ],
      messages: initialMessages,
      thinkingLevel: getDirectorStreamPolicy(state.modelId, state.thinkingEnabled).reasoning ?? 'off',
    },
    convertToLlm,
    streamFn: directorStreamFn,
    sessionId: metadata.id,
    maxRetryDelayMs: 5_000,
    shouldStopAfterTurn: (() => {
      const retrying = createRetryingStopCondition(
        MAX_TOOL_ATTEMPTS,
        () => state.finished,
        (message) => { lastToolError = message },
      )
      return (turn: ShouldStopAfterTurnContext) => {
        if (!turn.toolResults.some((result) => result.isError)) lastToolError = undefined
        // generate_segment 触发的暂停：立刻停止，不计入校验失败重试次数。
        if (state.pending) return true
        return retrying(turn)
      }
    })(),
  })

  signal?.addEventListener('abort', () => agent.abort(), { once: true })
  subscribeForPersistence(agent)

  const agentRunStartedAt = Date.now()

  const handlePotentialPause = async (): Promise<boolean> => {
    if (!state.pending) return false
    phaseTimings.agentRunMs = Date.now() - agentRunStartedAt
    await persistTiming()
    state.status = 'awaiting_upload'
    state.castingBook = exportCastingBook(book)
    await persistTurnState(session, state)
    const pendingInfo = describePendingUpload()
    if (pendingInfo) send({ type: 'awaiting_upload', ...pendingInfo })
    await sendTrace('suspended')
    return true
  }

  try {
    if (promptText !== undefined) {
      await agent.prompt(promptText)
    } else {
      await agent.continue()
    }
    if (agent.state.errorMessage) throw new Error(agent.state.errorMessage)
    if (await handlePotentialPause()) {
      return { scene: state.scenePublish?.scene, characters: state.scenePublish?.characters, paused: true }
    }

    // 模型停下来却没有结束回合：不是校验失败导致的就提醒一次，再不行按已有结果降级。
    if (!state.finished && state.scenePublish && !lastToolError) {
      const videoIncomplete = videoEnabled && !state.video.segments.some((segment) => segment.isLast && segment.generated)
      const missing = videoIncomplete ? '还没有完成分镜' : '还没有调用 finish_turn'
      send({ type: 'status', text: '导演尚未结束回合，正在提醒继续。' })
      await agent.prompt(`本回合尚未结束：${missing}。请继续调用工具完成剩余步骤，最后调用 finish_turn。`)
      if (agent.state.errorMessage) throw new Error(agent.state.errorMessage)
      if (await handlePotentialPause()) {
        return { scene: state.scenePublish?.scene, characters: state.scenePublish?.characters, paused: true }
      }
    }

    if (!state.scenePublish) {
      throw new Error(lastToolError
        ? `publish_scene 连续 ${MAX_TOOL_ATTEMPTS} 次未通过校验，最后一次错误：${lastToolError}`
        : 'Pi Agent 没有调用 publish_scene 发布场景。')
    }

    const castingResult = toDurableValue(resolveSceneCasting(book, state.scenePublish.characters))
    orchestrationTraceEntries.push({
      id: `${state.traceId}:cast-result`,
      kind: 'tool_result',
      title: '本幕最终选角',
      timestamp: Date.now(),
      data: castingResult,
    })
    send({ type: 'cast', casting: castingResult })

    const videoReady = videoEnabled && state.finished && !state.skipVideoReason && state.video.segments.length > 0
    let videoPlan: VideoGenerationRequest | undefined
    if (videoReady) {
      let start = 0
      const videoPrompts = [...state.video.segments]
        .sort((left, right) => left.sequence - right.sequence)
        .map((segment) => {
          const normalized = {
            sequence: segment.sequence,
            startTime: start,
            endTime: start + segment.seconds,
            characterIds: segment.characters,
            prompt: segment.prompt,
          }
          start = normalized.endTime
          return normalized
        })
      const request: VideoGenerationRequest = { totalDuration: start, style: state.video.style ?? '', videoPrompts }
      videoPlan = toDurableValue(compileVideoPlan(request))
      send({ type: 'video_plan', video: videoPlan })
      const lastSegment = state.video.segments.find((segment) => segment.isLast)
      if (lastSegment?.generated) send({ type: 'scene_visual_state', visualState: lastSegment.generated.visualState })
    } else if (videoEnabled) {
      const message = state.skipVideoReason
        ? `导演跳过了本幕视频：${state.skipVideoReason}`
        : lastToolError
          ? `视频计划连续 ${MAX_TOOL_ATTEMPTS} 次未通过校验，最后一次错误：${lastToolError}`
          : '导演没有编写本幕视频计划。'
      orchestrationTraceEntries.push({
        id: `${state.traceId}:video-plan-error`,
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
    await persistTurnState(session, { status: 'finished', traceId: state.traceId })
    const completed = state.finished && (!videoEnabled || videoReady)
    await sendTrace(completed ? 'completed' : 'degraded')
    send({ type: 'done' })
    return {
      scene: state.scenePublish.scene,
      characters: state.scenePublish.characters,
      casting: castingResult,
      video: videoPlan,
      paused: false,
    }
  } catch (error) {
    phaseTimings.agentRunMs ||= Date.now() - agentRunStartedAt
    await persistTiming()
    await sendTrace(signal?.aborted ? 'aborted' : 'failed')
    throw error
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
  signal,
  send,
}: DirectorAgentRequest): Promise<DirectorTurnOutcome> {
  const startedAt = Date.now()
  const session = await getOrCreateSession(context.sessionId)
  let persistedEntries = await session.findEntries({ order: 'oldestFirst' })

  // 上一回合暂停后玩家没有上传就开了新回合：作废那次未决的 generate_segment。
  const priorTurnState = readLatestTurnState(persistedEntries)
  const unresolved = findUnresolvedToolCall(persistedEntries)
  if (unresolved) {
    await session.appendMessage({
      role: 'toolResult',
      toolCallId: unresolved.toolCallId,
      toolName: unresolved.toolName,
      content: [{ type: 'text', text: '玩家未上传该段视频，本次 generate_segment 作废。' }],
      details: {},
      isError: true,
      timestamp: Date.now(),
    })
    await persistTurnState(session, {
      status: 'abandoned',
      traceId: priorTurnState && 'traceId' in priorTurnState ? priorTurnState.traceId : traceId,
    })
    persistedEntries = await session.findEntries({ order: 'oldestFirst' })
  }

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
    video: { segments: [] },
    finished: false,
  }

  const initialMessages = context.input.type === 'start'
    ? []
    : buildSessionContext(stripTrailingFailedTurns(projectHistory(persistedEntries))).messages

  const promptText = buildStoryInputMessage(context.input, context.previousVisualState, {
    videoMode,
    hasPreviousTailFrame: context.hasPreviousTailFrame ?? Boolean(context.previousVisualState),
  })

  return runAgentSession({
    state,
    session,
    entries: persistedEntries,
    apiKey,
    signal,
    send,
    initialMessages,
    promptText,
  })
}

export type ResumeDirectorAgentRequest = {
  sessionId: string
  sequence: number
  toolCallId: string
  tailFrameDataUrl: string
  durationSeconds: number
  apiKey: string
  deepseekKey: string
  signal?: AbortSignal
  send: (event: DirectorStreamEvent) => void
  analyze?: typeof analyzeTailFrame
}

export async function resumeDirectorAgent(request: ResumeDirectorAgentRequest): Promise<DirectorTurnOutcome> {
  return withDirectorSession(request.sessionId, () => runResumedDirector(request))
}

async function runResumedDirector({
  sessionId,
  sequence,
  toolCallId,
  tailFrameDataUrl,
  durationSeconds,
  apiKey,
  deepseekKey,
  signal,
  send,
  analyze = analyzeTailFrame,
}: ResumeDirectorAgentRequest): Promise<DirectorTurnOutcome> {
  const session = await getOrCreateSession(sessionId)
  const entries = await session.findEntries({ order: 'oldestFirst' })
  const awaiting = findAwaitingUpload(entries)
  if (!awaiting || awaiting.pending.sequence !== sequence || awaiting.pending.toolCallId !== toolCallId) {
    throw new Error('当前没有等待上传的视频段，或段号、工具调用 ID 与当前状态不一致。')
  }
  const state = awaiting.state
  const segment = state.video.segments.find((candidate) => candidate.sequence === sequence)
  if (!segment) throw new Error(`未找到第 ${sequence} 段的分镜数据。`)

  // VLM 失败直接抛错，不写 session；前端可以重试上传。
  const visualState = await analyze({
    apiKey: deepseekKey,
    imageUrl: tailFrameDataUrl,
    characters: state.scenePublish?.characters ?? [],
    signal,
  })

  segment.generated = { durationSeconds, visualState }
  state.pending = undefined
  state.status = 'resumed'

  const remainingAttempts = Math.max(0, MAX_GENERATE_ATTEMPTS - segment.generateAttempts)
  const summaryText = buildResumedGenerationSummary({
    sequence,
    isLast: segment.isLast,
    plannedSeconds: segment.seconds,
    durationSeconds,
    visualState,
    remainingAttempts,
  })

  await session.appendMessage({
    role: 'toolResult',
    toolCallId,
    toolName: 'generate_segment',
    content: [{ type: 'text', text: summaryText }],
    details: { durationSeconds, visualState },
    isError: false,
    timestamp: Date.now(),
  })
  await persistTurnState(session, state)
  await session.appendCustomEntry('director_resume', { traceId: state.traceId, sequence })
  send({ type: 'segment_generated', sequence, durationSeconds, visualState })

  const resumedEntries = await session.findEntries({ order: 'oldestFirst' })
  const initialMessages = buildSessionContext(stripTrailingFailedTurns(projectHistory(resumedEntries))).messages

  return runAgentSession({
    state,
    session,
    entries: resumedEntries,
    apiKey,
    signal,
    send,
    initialMessages,
  })
}
