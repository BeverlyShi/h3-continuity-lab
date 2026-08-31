import { Check } from 'typebox/value'
import type { DirectorStreamEvent, HarnessTraceSnapshot } from '../src/types/director.ts'
import type { DirectorTurnContext } from '../src/types/game.ts'
import { storySceneSchema, type StoryScene } from '../src/types/story.ts'
import { buildStoryInputMessage, DIRECTOR_SYSTEM_PROMPT } from './directorPrompt.ts'

const DEEPSEEK_URL = 'https://api.deepseek.com/chat/completions'
const DEEPSEEK_MODEL = 'deepseek-v4-flash'
const MAX_OUTPUT_TOKENS = 1_200
const REQUEST_TIMEOUT_MS = 45_000
const MAX_ATTEMPTS = 2
const MAX_HISTORY_TURNS = 20

type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string }

type DeepSeekResponse = {
  choices?: Array<{
    message?: {
      content?: string | null
      tool_calls?: Array<{ function?: { name?: string; arguments?: string } }>
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
    description: '向玩家发布当前回合的场景标题、叙事和 2–3 个选择。每回合必须调用一次。',
    parameters: storySceneSchema,
  },
} as const

const compactSceneForHistory = (scene: StoryScene) => JSON.stringify({
  title: scene.title,
  narrative: scene.narrative,
  choices: scene.choices,
})

async function requestScene(
  apiKey: string,
  messages: ChatMessage[],
  signal: AbortSignal | undefined,
): Promise<{ scene: StoryScene; usage: DeepSeekResponse['usage']; requestMs: number }> {
  const startedAt = Date.now()
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  const response = await fetch(DEEPSEEK_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: DEEPSEEK_MODEL,
      thinking: { type: 'disabled' },
      messages,
      tools: [publishSceneToolDefinition],
      tool_choice: { type: 'function', function: { name: 'publish_scene' } },
      max_tokens: MAX_OUTPUT_TOKENS,
    }),
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  })

  const payload = await response.json() as DeepSeekResponse
  if (!response.ok) {
    throw new Error(payload.error?.message ?? `DeepSeek 请求失败（${response.status}）。`)
  }

  const toolCall = payload.choices?.[0]?.message?.tool_calls?.find(
    (call) => call.function?.name === 'publish_scene',
  )
  if (!toolCall?.function?.arguments) throw new Error('模型没有调用 publish_scene。')

  const scene = JSON.parse(toolCall.function.arguments) as StoryScene
  if (!Check(storySceneSchema, scene)) throw new Error('模型输出的场景不符合 schema。')

  return { scene, usage: payload.usage, requestMs: Date.now() - startedAt }
}

export type SimpleDirectorRequest = {
  apiKey: string
  context: DirectorTurnContext
  traceId: string
  signal?: AbortSignal
  send: (event: DirectorStreamEvent) => void
}

export async function runSimpleDirector({
  apiKey,
  context,
  traceId,
  signal,
  send,
}: SimpleDirectorRequest): Promise<StoryScene> {
  const startedAt = Date.now()
  if (context.input.type === 'start') sessionHistories.delete(context.sessionId)
  const history = sessionHistories.get(context.sessionId) ?? []

  const userMessage: ChatMessage = { role: 'user', content: buildStoryInputMessage(context.input) }
  const messages: ChatMessage[] = [
    { role: 'system', content: DIRECTOR_SYSTEM_PROMPT },
    ...history.slice(-MAX_HISTORY_TURNS * 2),
    userMessage,
  ]

  send({ type: 'trace_started', traceId, harnessSessionId: `simple:${context.sessionId}`, startedAt })
  send({ type: 'status', text: '极简导演正在请求 DeepSeek。' })

  let lastError: unknown
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    try {
      const { scene, usage, requestMs } = await requestScene(apiKey, messages, signal)
      history.push(userMessage, { role: 'assistant', content: compactSceneForHistory(scene) })
      sessionHistories.set(context.sessionId, history)

      send({ type: 'scene', scene })

      const endedAt = Date.now()
      const trace: HarnessTraceSnapshot = {
        traceId,
        harnessSessionId: `simple:${context.sessionId}`,
        startedAt,
        endedAt,
        durationMs: endedAt - startedAt,
        outcome: 'completed',
        stopReason: 'toolUse',
        usage: {
          input: usage?.prompt_tokens ?? 0,
          output: usage?.completion_tokens ?? 0,
          cacheRead: usage?.prompt_cache_hit_tokens ?? 0,
          totalTokens: usage?.total_tokens ?? 0,
          cost: 0,
        },
        entries: [
          {
            id: `${traceId}:system-prompt`,
            kind: 'input',
            title: 'Simple Agent System Prompt',
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
          {
            id: `${traceId}:tool-call`,
            kind: 'tool_call',
            title: '调用工具 · publish_scene',
            timestamp: endedAt,
            data: scene,
          },
          {
            id: `${traceId}:timing`,
            kind: 'assistant',
            title: 'Simple Agent 计时',
            timestamp: endedAt,
            data: {
              attempt: attempt + 1,
              deepseekRequestMs: requestMs,
              totalMs: endedAt - startedAt,
              historyMessages: messages.length,
            },
          },
        ],
      }
      send({ type: 'harness_trace', trace })
      send({ type: 'done' })
      return scene
    } catch (error) {
      lastError = error
      if (signal?.aborted) break
      if (attempt + 1 < MAX_ATTEMPTS) {
        send({ type: 'status', text: '极简导演首次请求失败，正在重试。' })
      }
    }
  }

  throw lastError instanceof Error ? lastError : new Error('极简导演请求失败。')
}
