import type { DirectorModelId } from '../config/directorModels'
import type { CastableActor, CharacterCasting, SceneCastingResult } from '../types/actor'
import type { DirectorStreamEvent } from '../types/director'
import type { DirectorTurnContext } from '../types/game'
import type { SceneCharacter, StoryScene, VideoGenerationRequest } from '../types/story'

export function parseDirectorEvent(line: string): DirectorStreamEvent {
  const event = JSON.parse(line) as DirectorStreamEvent
  if (!event || typeof event !== 'object' || typeof event.type !== 'string') {
    throw new Error('导演返回了无法识别的数据。')
  }
  return event
}

export type StreamedDirectorTurn = {
  scene: StoryScene
  characters: SceneCharacter[]
  casting?: SceneCastingResult
  video?: VideoGenerationRequest
}

export type DirectorVideoMode = 'auto' | 'comfy'

// 流结束时没有 done，说明连接被意外打断（网络中断、代理超时等）。
export async function readDirectorStream(
  response: Response,
  onEvent: (event: DirectorStreamEvent) => void,
): Promise<void> {
  if (!response.body) throw new Error('浏览器不支持导演流式响应。')

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let done = false
  let streamError = ''

  const consumeLine = (line: string) => {
    if (!line.trim()) return
    const event = parseDirectorEvent(line)
    onEvent(event)
    if (event.type === 'done') done = true
    if (event.type === 'error') streamError = event.error
  }

  while (true) {
    const { done: streamDone, value } = await reader.read()
    buffer += decoder.decode(value, { stream: !streamDone })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    lines.forEach(consumeLine)
    if (streamDone) break
  }
  consumeLine(buffer)

  if (streamError) throw new Error(streamError)
  if (!done) throw new Error('导演连接意外中断，请重试。')
}

type StreamDirectorTurnOptions = {
  openRouterApiKey?: string
  deepseekApiKey?: string
  bigModelApiKey?: string
  context: DirectorTurnContext
  traceId: string
  actors?: CastableActor[]
  castings?: CharacterCasting[]
  videoMode?: DirectorVideoMode
  model: DirectorModelId
  thinkingEnabled?: boolean
  signal?: AbortSignal
  onEvent: (event: DirectorStreamEvent) => void
}

const buildDirectorHeaders = (keys: {
  openRouterApiKey?: string
  deepseekApiKey?: string
  bigModelApiKey?: string
}) => {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (keys.openRouterApiKey) headers['X-OpenRouter-Key'] = keys.openRouterApiKey
  if (keys.deepseekApiKey) headers['X-DeepSeek-Key'] = keys.deepseekApiKey
  if (keys.bigModelApiKey) headers['X-BigModel-Key'] = keys.bigModelApiKey
  return headers
}

const readErrorBody = async (response: Response, fallback: string) => {
  const body = await response.json().catch(() => ({})) as { error?: string }
  return body.error ?? fallback
}

export async function streamDirectorTurn({
  openRouterApiKey,
  deepseekApiKey,
  bigModelApiKey,
  context,
  traceId,
  actors = [],
  castings = [],
  videoMode,
  model,
  thinkingEnabled = false,
  signal,
  onEvent,
}: StreamDirectorTurnOptions): Promise<StreamedDirectorTurn> {
  const response = await fetch('/api/director/turn', {
    method: 'POST',
    headers: buildDirectorHeaders({ openRouterApiKey, deepseekApiKey, bigModelApiKey }),
    body: JSON.stringify({ context, traceId, actors, castings, model, thinkingEnabled, videoMode }),
    signal,
  })

  if (!response.ok) throw new Error(await readErrorBody(response, `导演服务请求失败（${response.status}）。`))

  let scene: StoryScene | undefined
  let characters: SceneCharacter[] | undefined
  let casting: SceneCastingResult | undefined
  let video: VideoGenerationRequest | undefined

  await readDirectorStream(response, (event) => {
    if (event.type === 'scene') {
      scene = event.scene
      characters = event.characters
    }
    if (event.type === 'cast') casting = event.casting
    if (event.type === 'video_plan') video = event.video
    onEvent(event)
  })

  if (!scene || !characters) throw new Error('Pi Agent 没有发布故事场景。')
  return { scene, characters, ...(casting ? { casting } : {}), video }
}

type StreamDirectorRewriteOptions = {
  openRouterApiKey?: string
  deepseekApiKey?: string
  bigModelApiKey?: string
  sessionId: string
  sequence: number
  reason: string
  traceId: string
  actors?: CastableActor[]
  model: DirectorModelId
  thinkingEnabled?: boolean
  signal?: AbortSignal
  onEvent: (event: DirectorStreamEvent) => void
}

// 让导演重写当前场次第 sequence 段；成功时流里只有一次 video_plan（fromSequence = sequence）。
export async function streamDirectorRewrite({
  openRouterApiKey,
  deepseekApiKey,
  bigModelApiKey,
  sessionId,
  sequence,
  reason,
  traceId,
  actors = [],
  model,
  thinkingEnabled = false,
  signal,
  onEvent,
}: StreamDirectorRewriteOptions): Promise<{ video?: VideoGenerationRequest }> {
  const response = await fetch('/api/director/rewrite', {
    method: 'POST',
    headers: buildDirectorHeaders({ openRouterApiKey, deepseekApiKey, bigModelApiKey }),
    body: JSON.stringify({ sessionId, sequence, reason, traceId, actors, model, thinkingEnabled }),
    signal,
  })

  if (!response.ok) throw new Error(await readErrorBody(response, `导演重写请求失败（${response.status}）。`))

  let video: VideoGenerationRequest | undefined
  await readDirectorStream(response, (event) => {
    if (event.type === 'video_plan') video = event.video
    onEvent(event)
  })
  return { video }
}
