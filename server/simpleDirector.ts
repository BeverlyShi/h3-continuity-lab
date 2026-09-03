import { Check } from 'typebox/value'
import type { TSchema } from 'typebox'
import { getDirectorModelLabel, getDirectorModelProvider, type DirectorModelId } from '../src/config/directorModels.ts'
import type { CastableActor, CharacterCasting, SceneCastingResult } from '../src/types/actor.ts'
import type { DirectorStreamEvent, HarnessTraceSnapshot } from '../src/types/director.ts'
import type { DirectorTurnContext } from '../src/types/game.ts'
import {
  scenePublishSchema,
  videoPlanSchema,
  type ScenePublish,
  type SceneCharacter,
  type VideoGenerationRequest,
  type VideoPlan,
} from '../src/types/story.ts'
import {
  buildStoryInputMessage,
  DIRECTOR_SYSTEM_PROMPT,
  DIRECTOR_VIDEO_SYSTEM_PROMPT,
} from './directorPrompt.ts'
import { createCastSceneTool } from './castSceneTool.ts'
import { assertValidScenePublish } from './publishSceneTool.ts'
import {
  assertValidVideoDraft,
  assertValidVideoPlan,
  normalizeVideoPlan,
  prepareVideoPlanArguments,
} from './videoPlanTool.ts'
import { compileVideoPlan } from './videoPromptCompiler.ts'

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions'
const DEEPSEEK_URL = 'https://api.deepseek.com/chat/completions'
const MAX_OUTPUT_TOKENS = 4_096
const REQUEST_TIMEOUT_MS = 45_000
const MAX_HISTORY_TURNS = 20
// 每个阶段最多尝试 2 次模型调用（1 次初始 + 1 次定向修复）。
const MAX_TOOL_ATTEMPTS = 2

type ApiMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: OpenRouterToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string }

type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string }

type OpenRouterToolCall = { id?: string; type?: string; function?: { name?: string; arguments?: string } }

type OpenRouterResponse = {
  choices?: Array<{
    message?: {
      content?: string | null
      tool_calls?: OpenRouterToolCall[]
    }
  }>
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    total_tokens?: number
    prompt_cache_hit_tokens?: number
  }
  error?: { message?: string }
}

// 会话历史仅存于 dev server 内存：重启后丢失连续性，属实验性 agent 的已知取舍。
const sessionHistories = new Map<string, ChatMessage[]>()

const publishSceneToolDefinition = {
  type: 'function',
  function: {
    name: 'publish_scene',
    description: '提交当前回合的场景和主要人物。本工具会本地发布场景，每回合只调用一次。',
    parameters: scenePublishSchema,
  },
} as const

const submitVideoPlanToolDefinition = {
  type: 'function',
  function: {
    name: 'write_video_prompt',
    description: '根据已发布场景和上一幕实测视觉状态，按模板编译本幕视频 Prompt。',
    parameters: videoPlanSchema,
  },
} as const

type ToolCallOutcome<T> = {
  result: T
  usage: OpenRouterResponse['usage']
  requestMs: number
  messages: ApiMessage[]
}

async function requestToolCall<T>(
  apiKey: string,
  modelId: DirectorModelId,
  toolDefinition: { type: 'function'; function: { name: string; description: string; parameters: unknown } },
  schema: TSchema,
  validate: (value: T) => void,
  initialMessages: ApiMessage[],
  signal: AbortSignal | undefined,
  prepareArguments?: (value: unknown) => T,
): Promise<ToolCallOutcome<T>> {
  const toolName = toolDefinition.function.name
  const provider = getDirectorModelProvider(modelId)
  const requestUrl = provider === 'deepseek' ? DEEPSEEK_URL : OPENROUTER_URL
  let messages = initialMessages
  let totalRequestMs = 0
  let lastUsage: OpenRouterResponse['usage']

  for (let attempt = 1; attempt <= MAX_TOOL_ATTEMPTS; attempt += 1) {
    const startedAt = Date.now()
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    const response = await fetch(requestUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: modelId,
        ...(provider === 'openrouter' ? { reasoning: { effort: 'none' } } : {}),
        messages,
        tools: [toolDefinition],
        tool_choice: { type: 'function', function: { name: toolName } },
        max_tokens: MAX_OUTPUT_TOKENS,
      }),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    })

    const payload = await response.json() as OpenRouterResponse
    totalRequestMs += Date.now() - startedAt
    lastUsage = payload.usage
    if (!response.ok) {
      throw new Error(payload.error?.message ?? `${provider === 'deepseek' ? 'DeepSeek' : 'OpenRouter'} 请求失败（${response.status}）。`)
    }

    const assistantMessage = payload.choices?.[0]?.message
    const toolCall = assistantMessage?.tool_calls?.find((call) => call.function?.name === toolName)
    if (!toolCall?.function?.arguments) throw new Error(`模型没有调用 ${toolName}。`)

    try {
      const raw = JSON.parse(toolCall.function.arguments) as unknown
      const parsed = prepareArguments ? prepareArguments(raw) : raw as T
      if (!Check(schema, parsed)) throw new Error(`模型输出的 ${toolName} 参数不符合 schema。`)
      validate(parsed)
      return { result: parsed, usage: lastUsage, requestMs: totalRequestMs, messages }
    } catch (error) {
      if (attempt >= MAX_TOOL_ATTEMPTS) throw error
      const message = error instanceof Error ? error.message : String(error)
      messages = [
        ...messages,
        { role: 'assistant', content: assistantMessage?.content ?? null, tool_calls: assistantMessage?.tool_calls },
        { role: 'tool', tool_call_id: toolCall.id ?? toolName, content: message },
      ]
    }
  }

  throw new Error(`模型没有调用 ${toolName}。`)
}

export type SimpleDirectorRequest = {
  apiKey: string
  modelId: DirectorModelId
  context: DirectorTurnContext
  actors: CastableActor[]
  castings: CharacterCasting[]
  traceId: string
  signal?: AbortSignal
  send: (event: DirectorStreamEvent) => void
}

export async function runSimpleDirector({
  apiKey,
  modelId,
  context,
  actors,
  castings,
  traceId,
  signal,
  send,
}: SimpleDirectorRequest): Promise<{
  scene: ScenePublish['scene']
  characters: SceneCharacter[]
  casting?: SceneCastingResult
  video?: VideoGenerationRequest
}> {
  const startedAt = Date.now()
  if (context.input.type === 'start') sessionHistories.delete(context.sessionId)
  const history = sessionHistories.get(context.sessionId) ?? []

  const userMessage: ChatMessage = {
    role: 'user',
    content: buildStoryInputMessage(context.input, context.previousVisualState),
  }
  const sceneMessages: ApiMessage[] = [
    { role: 'system', content: DIRECTOR_SYSTEM_PROMPT },
    ...history.slice(-MAX_HISTORY_TURNS * 2),
    userMessage,
  ]

  send({ type: 'trace_started', traceId, harnessSessionId: `simple:${context.sessionId}`, startedAt })
  send({ type: 'status', text: `极简导演正在通过 ${getDirectorModelLabel(modelId)} 构思下一幕。` })

  const traceEntries: HarnessTraceSnapshot['entries'] = [
    {
      id: `${traceId}:scene-system-prompt`,
      kind: 'input',
      title: `Simple Agent 场景阶段 System Prompt · ${modelId}`,
      timestamp: startedAt,
      text: DIRECTOR_SYSTEM_PROMPT,
    },
    {
      id: `${traceId}:input`,
      kind: 'input',
      title: '玩家输入',
      timestamp: startedAt,
      text: userMessage.content,
    },
  ]

  try {
    const sceneOutcome = await requestToolCall<ScenePublish>(
      apiKey,
      modelId,
      publishSceneToolDefinition,
      scenePublishSchema,
      assertValidScenePublish,
      sceneMessages,
      signal,
    )
    const scenePublish = sceneOutcome.result
    history.push(userMessage, { role: 'assistant', content: JSON.stringify(scenePublish) })
    sessionHistories.set(context.sessionId, history)

    traceEntries.push({
      id: `${traceId}:scene-tool-call`,
      kind: 'tool_call',
      title: '调用工具 · publish_scene',
      timestamp: Date.now(),
      data: scenePublish,
    })

    send({ type: 'scene', scene: scenePublish.scene, characters: scenePublish.characters })
    send({ type: 'status', text: '场景已发布，正在并行选角和生成视频计划。' })

    let castingResult: SceneCastingResult | undefined
    let videoDraft: VideoGenerationRequest | undefined
    let videoPlan: VideoGenerationRequest | undefined
    let castingRequestMs = 0
    let videoRequestMs = 0
    const castingStartedAt = Date.now()
    traceEntries.push({
      id: `${traceId}:cast-tool-call`,
      kind: 'tool_call',
      title: '调用工具 · cast_scene',
      timestamp: castingStartedAt,
      data: {},
    })
    const castingPromise = createCastSceneTool(scenePublish.characters, actors, castings)
      .execute(`${traceId}:cast-scene`, {})
      .then((result) => {
        castingRequestMs = Date.now() - castingStartedAt
        castingResult = result.details
        traceEntries.push({
          id: `${traceId}:cast-tool-result`,
          kind: 'tool_result',
          title: '工具结果 · cast_scene',
          timestamp: Date.now(),
          data: castingResult,
        })
        send({ type: 'cast', casting: castingResult })
      })

    const videoPromise = (async () => {
      const videoMessages: ApiMessage[] = [
        { role: 'system', content: DIRECTOR_VIDEO_SYSTEM_PROMPT },
        ...sceneOutcome.messages.filter((message) => message.role !== 'system'),
        { role: 'assistant', content: JSON.stringify(scenePublish) },
        { role: 'user', content: '场景已发布，请调用 write_video_prompt 提交本幕视频计划。' },
      ]
      const videoOutcome = await requestToolCall<VideoPlan>(
        apiKey,
        modelId,
        submitVideoPlanToolDefinition,
        videoPlanSchema,
        (plan) => {
          assertValidVideoDraft(plan, scenePublish.characters)
          assertValidVideoPlan(normalizeVideoPlan(plan), scenePublish.characters)
        },
        videoMessages,
        signal,
        prepareVideoPlanArguments,
      )
      videoDraft = normalizeVideoPlan(videoOutcome.result)
      videoRequestMs = videoOutcome.requestMs
      traceEntries.push({
        id: `${traceId}:video-system-prompt`,
        kind: 'input',
        title: `Simple Agent 视频计划阶段 System Prompt · ${modelId}`,
        timestamp: Date.now(),
        text: DIRECTOR_VIDEO_SYSTEM_PROMPT,
      })
    })()

    const [castingOutcome, videoOutcome] = await Promise.allSettled([castingPromise, videoPromise])
    if (castingOutcome.status === 'rejected') {
      const message = castingOutcome.reason instanceof Error
        ? castingOutcome.reason.message
        : String(castingOutcome.reason)
      traceEntries.push({
        id: `${traceId}:cast-error`,
        kind: 'error',
        title: '场景选角失败',
        timestamp: Date.now(),
        text: message,
        isError: true,
      })
      send({ type: 'cast_error', message })
    }
    if (videoOutcome.status === 'rejected') {
      const error = videoOutcome.reason
      const message = error instanceof Error ? error.message : String(error)
      traceEntries.push({
        id: `${traceId}:video-plan-error`,
        kind: 'error',
        title: '视频计划生成失败',
        timestamp: Date.now(),
        text: message,
        isError: true,
      })
      send({ type: 'video_plan_error', message })
    } else if (videoDraft) {
      const matchedCharacterIds = new Set(
        castingResult?.castings.map((casting) => casting.characterId) ?? [],
      )
      videoPlan = compileVideoPlan(
        videoDraft,
        scenePublish.characters,
        context.previousVisualState,
        matchedCharacterIds,
      )
      traceEntries.push({
        id: `${traceId}:video-tool-call`,
        kind: 'tool_call',
        title: '调用工具 · write_video_prompt',
        timestamp: Date.now(),
        data: videoPlan,
      })
      send({ type: 'video_plan', video: videoPlan })
    }

    const endedAt = Date.now()
    traceEntries.push({
      id: `${traceId}:timing`,
      kind: 'assistant',
      title: 'Simple Agent 计时',
      timestamp: endedAt,
      data: {
        sceneRequestMs: sceneOutcome.requestMs,
        castingRequestMs,
        videoRequestMs,
        modelId,
        totalMs: endedAt - startedAt,
      },
    })

    const trace: HarnessTraceSnapshot = {
      traceId,
      harnessSessionId: `simple:${context.sessionId}`,
      startedAt,
      endedAt,
      durationMs: endedAt - startedAt,
      outcome: castingResult && videoPlan ? 'completed' : 'degraded',
      stopReason: 'toolUse',
      usage: {
        input: (sceneOutcome.usage?.prompt_tokens ?? 0),
        output: (sceneOutcome.usage?.completion_tokens ?? 0),
        cacheRead: (sceneOutcome.usage?.prompt_cache_hit_tokens ?? 0),
        totalTokens: (sceneOutcome.usage?.total_tokens ?? 0),
        cost: 0,
      },
      entries: traceEntries,
    }
    send({ type: 'harness_trace', trace })
    send({ type: 'done' })
    return {
      scene: scenePublish.scene,
      characters: scenePublish.characters,
      casting: castingResult,
      video: videoPlan,
    }
  } catch (error) {
    const endedAt = Date.now()
    const message = error instanceof Error ? error.message : String(error)
    traceEntries.push({
      id: `${traceId}:scene-error`,
      kind: 'error',
      title: '场景生成失败',
      timestamp: endedAt,
      text: message,
      isError: true,
    })
    send({
      type: 'harness_trace',
      trace: {
        traceId,
        harnessSessionId: `simple:${context.sessionId}`,
        startedAt,
        endedAt,
        durationMs: endedAt - startedAt,
        outcome: signal?.aborted ? 'aborted' : 'failed',
        entries: traceEntries,
      },
    })
    throw error
  }
}
