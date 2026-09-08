import { Check } from 'typebox/value'
import type { TSchema } from 'typebox'
import { getDirectorApiModelId, getDirectorModelLabel, getDirectorModelProvider, type DirectorModelId } from '../src/config/directorModels.ts'
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
  buildVideoInputMessage,
  DIRECTOR_SYSTEM_PROMPT,
  DIRECTOR_VIDEO_SYSTEM_PROMPT,
} from './directorPrompt.ts'
import { createCastSceneTool } from './castSceneTool.ts'
import { assertValidScenePublish, PUBLISH_SCENE_DESCRIPTION, prepareScenePublishArguments } from './publishSceneTool.ts'
import {
  prepareVideoPlan,
  prepareVideoPlanArguments,
  WRITE_VIDEO_PROMPT_DESCRIPTION,
} from './videoPlanTool.ts'
import { compileVideoPlan } from './videoPromptCompiler.ts'

import { assertNarrativeReview, narrativeReviewToolDefinition, narrativeReviewSchema, narrativeSources, NARRATIVE_REVIEW_PROMPT, type NarrativeReview } from './narrativeReview.ts'
import { withDirectorSession } from './directorSession.ts'
import { BIGMODEL_BASE_URL } from './bigmodelProvider.ts'

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions'
const DEEPSEEK_URL = 'https://api.deepseek.com/chat/completions'
const MAX_OUTPUT_TOKENS = 4_096
const REQUEST_TIMEOUT_MS = 45_000
const MAX_HISTORY_TURNS = 20
// 每个阶段最多尝试 2 次模型调用（1 次初始 + 1 次定向修复）。
const MAX_TOOL_ATTEMPTS = 2

type ApiMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; reasoning_content?: string; tool_calls?: OpenRouterToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string }

type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string; reasoning_content?: string }

type OpenRouterToolCall = { id?: string; type?: string; function?: { name?: string; arguments?: string } }

type OpenRouterResponse = {
  choices?: Array<{
    message?: {
      content?: string | null
      reasoning_content?: string
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
    description: PUBLISH_SCENE_DESCRIPTION,
    parameters: scenePublishSchema,
  },
} as const

const submitVideoPlanToolDefinition = {
  type: 'function',
  function: {
    name: 'write_video_prompt',
    description: WRITE_VIDEO_PROMPT_DESCRIPTION,
    parameters: videoPlanSchema,
  },
} as const

type ToolCallOutcome<T> = {
  result: T
  usage: OpenRouterResponse['usage']
  requestMs: number
  messages: ApiMessage[]
  reasoningContent?: string
}

async function requestToolCall<T>(
  apiKey: string,
  modelId: DirectorModelId,
  thinkingEnabled: boolean,
  toolDefinition: { type: 'function'; function: { name: string; description: string; parameters: unknown } },
  schema: TSchema,
  validate: (value: T) => void | Promise<void>,
  initialMessages: ApiMessage[],
  signal: AbortSignal | undefined,
  prepareArguments?: (value: unknown) => T,
): Promise<ToolCallOutcome<T>> {
  const toolName = toolDefinition.function.name
  const provider = getDirectorModelProvider(modelId)
  const requestUrl = { deepseek: DEEPSEEK_URL, openrouter: OPENROUTER_URL, bigmodel: `${BIGMODEL_BASE_URL}/chat/completions` }[provider]
  let messages = initialMessages
  let totalRequestMs = 0
  let lastUsage: OpenRouterResponse['usage']

  for (let attempt = 1; attempt <= MAX_TOOL_ATTEMPTS; attempt += 1) {
    const startedAt = Date.now()
    const timeout = AbortSignal.timeout(provider !== 'openrouter' ? 120_000 : REQUEST_TIMEOUT_MS)
    const response = await fetch(requestUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: getDirectorApiModelId(modelId),
        ...(provider === 'openrouter' ? { reasoning: { effort: 'none' } } : {}),
        ...(provider === 'deepseek' ? { thinking: { type: thinkingEnabled ? 'enabled' : 'disabled' } } : {}),
        // GLM-5.3-Flash 不支持关闭思考，用 low/high 对比耗时。
        ...(provider === 'bigmodel' ? { thinking: { type: 'enabled', clear_thinking: false }, reasoning_effort: thinkingEnabled ? 'high' : 'low' } : {}),
        ...(provider === 'deepseek' && thinkingEnabled ? { reasoning_effort: 'high' } : {}),
        messages: provider !== 'openrouter'
          ? messages.map((message) => message.role === 'assistant'
            ? { ...message, reasoning_content: message.reasoning_content ?? '' }
            : message)
          : messages,
        tools: [toolDefinition],
        // 官方思考接口由模型选择工具；每个阶段只提供对应工具。
        ...(provider !== 'openrouter' ? {} : {
          tool_choice: { type: 'function', function: { name: toolName } },
        }),
        max_tokens: provider !== 'openrouter' ? 16_384 : MAX_OUTPUT_TOKENS,
      }),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    })

    const payload = await response.json() as OpenRouterResponse
    totalRequestMs += Date.now() - startedAt
    lastUsage = payload.usage
    if (!response.ok) {
      throw new Error(payload.error?.message ?? `${{ deepseek: 'DeepSeek', openrouter: 'OpenRouter', bigmodel: '智谱 BigModel' }[provider]} 请求失败（${response.status}）。`)
    }

    const assistantMessage = payload.choices?.[0]?.message
    const toolCall = assistantMessage?.tool_calls?.find((call) => call.function?.name === toolName)
    if (!toolCall?.function?.arguments) throw new Error(`模型没有调用 ${toolName}。`)

    try {
      const raw = JSON.parse(toolCall.function.arguments) as unknown
      const parsed = prepareArguments ? prepareArguments(raw) : raw as T
      if (!Check(schema, parsed)) throw new Error(`模型输出的 ${toolName} 参数不符合 schema。`)
      await validate(parsed)
      return { result: parsed, usage: lastUsage, requestMs: totalRequestMs, messages, reasoningContent: assistantMessage?.reasoning_content }
    } catch (error) {
      if (attempt >= MAX_TOOL_ATTEMPTS) throw error
      const message = error instanceof Error ? error.message : String(error)
      messages = [
        ...messages,
        { role: 'assistant', content: assistantMessage?.content ?? null, reasoning_content: assistantMessage?.reasoning_content, tool_calls: assistantMessage?.tool_calls },
        { role: 'tool', tool_call_id: toolCall.id ?? toolName, content: message },
      ]
    }
  }

  throw new Error(`模型没有调用 ${toolName}。`)
}

export type SimpleDirectorRequest = {
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

export async function runSimpleDirector(request: SimpleDirectorRequest) {
  return withDirectorSession(request.context.sessionId, () => runSimpleDirectorTurn(request))
}

async function runSimpleDirectorTurn({
  apiKey,
  modelId,
  thinkingEnabled = false,
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

  const reviewUsage: NonNullable<OpenRouterResponse['usage']>[] = []
  const reviewNarrative = async (source: ScenePublish, finalVideo?: VideoGenerationRequest, referenceInput?: string) => {
    const input = {
      phase: finalVideo ? 'video' : 'scene', ...source,
      playerInput: context.input, sources: narrativeSources(source.scene.narrative),
      previousVisualState: context.hasPreviousTailFrame === false ? undefined : context.previousVisualState,
      finalVideo, referenceInput,
    }
    send({ type: 'status', text: finalVideo ? '正在逐条核对最终分镜与本幕原文。' : '正在核对出场人物与剧情边界。' })
    const reviewId = `${traceId}:review-${traceEntries.length}`
    traceEntries.push({ id: `${reviewId}:input`, kind: 'input', title: '原文一致性核对输入', timestamp: Date.now(), data: input, text: NARRATIVE_REVIEW_PROMPT })
    const outcome = await requestToolCall<NarrativeReview>(
      apiKey, modelId, thinkingEnabled, narrativeReviewToolDefinition, narrativeReviewSchema,
      () => {}, [
        { role: 'system', content: NARRATIVE_REVIEW_PROMPT },
        { role: 'user', content: JSON.stringify(input) },
      ], signal,
    )
    if (outcome.usage) reviewUsage.push(outcome.usage)
    traceEntries.push({ id: reviewId, kind: 'tool_result', title: '原文一致性核对结果', timestamp: Date.now(), data: { result: outcome.result, usage: outcome.usage, durationMs: outcome.requestMs } })
    assertNarrativeReview(outcome.result, source, finalVideo)
  }

  try {
    const sceneOutcome = await requestToolCall<ScenePublish>(
      apiKey,
      modelId,
      thinkingEnabled,
      publishSceneToolDefinition,
      scenePublishSchema,
      async (source) => {
        assertValidScenePublish(source)
        await reviewNarrative(source)
      },
      sceneMessages,
      signal,
      prepareScenePublishArguments,
    )
    const scenePublish = sceneOutcome.result
    history.push(userMessage, { role: 'assistant', content: JSON.stringify(scenePublish), reasoning_content: sceneOutcome.reasoningContent })
    sessionHistories.set(context.sessionId, history)

    traceEntries.push({
      id: `${traceId}:scene-tool-call`,
      kind: 'tool_call',
      title: '调用工具 · publish_scene',
      timestamp: Date.now(),
      data: scenePublish,
    })

    send({ type: 'scene', scene: scenePublish.scene, characters: scenePublish.characters })
    send({ type: 'status', text: '场景已发布，正在准备人物参考素材。' })

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

    const [castingOutcome] = await Promise.allSettled([castingPromise])
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
    const videoInputMessage = buildVideoInputMessage(
      scenePublish.characters, castingResult, actors, scenePublish.dialogues,
      context.previousVisualState, context.hasPreviousTailFrame, scenePublish.scene,
    )
    send({ type: 'status', text: '参考素材已确认，正在编写分镜。' })

    traceEntries.push({
      id: `${traceId}:video-input`,
      kind: 'input',
      title: '视频参考素材',
      timestamp: Date.now(),
      text: videoInputMessage,
    })
    const videoPromise = (async () => {
      const videoMessages: ApiMessage[] = [
        { role: 'system', content: DIRECTOR_VIDEO_SYSTEM_PROMPT },
        { role: 'user', content: videoInputMessage },
      ]
      const videoOutcome = await requestToolCall<VideoPlan>(
        apiKey,
        modelId,
        thinkingEnabled,
        submitVideoPlanToolDefinition,
        videoPlanSchema,
        async (plan) => {
          const prepared = prepareVideoPlan(plan, scenePublish.characters, scenePublish.dialogues).video
          await reviewNarrative(scenePublish, compileVideoPlan(prepared), videoInputMessage)
          videoDraft = prepared
        },
        videoMessages,
        signal,
        prepareVideoPlanArguments,
      )
      videoRequestMs = videoOutcome.requestMs
      traceEntries.push({
        id: `${traceId}:video-system-prompt`,
        kind: 'input',
        title: `Simple Agent 视频计划阶段 System Prompt · ${modelId}`,
        timestamp: Date.now(),
        text: DIRECTOR_VIDEO_SYSTEM_PROMPT,
      })
    })()

    const [videoOutcome] = await Promise.allSettled([videoPromise])
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
      videoPlan = compileVideoPlan(videoDraft)
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
        thinkingEnabled,
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
        input: (sceneOutcome.usage?.prompt_tokens ?? 0) + reviewUsage.reduce((sum, usage) => sum + (usage.prompt_tokens ?? 0), 0),
        output: (sceneOutcome.usage?.completion_tokens ?? 0) + reviewUsage.reduce((sum, usage) => sum + (usage.completion_tokens ?? 0), 0),
        cacheRead: (sceneOutcome.usage?.prompt_cache_hit_tokens ?? 0) + reviewUsage.reduce((sum, usage) => sum + (usage.prompt_cache_hit_tokens ?? 0), 0),
        totalTokens: (sceneOutcome.usage?.total_tokens ?? 0) + reviewUsage.reduce((sum, usage) => sum + (usage.total_tokens ?? 0), 0),
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
