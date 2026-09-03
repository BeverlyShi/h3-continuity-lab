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

export type DirectorAgentKind = 'pi' | 'simple'

type StreamDirectorTurnOptions = {
  openRouterApiKey?: string
  deepseekApiKey?: string
  context: DirectorTurnContext
  traceId: string
  actors?: CastableActor[]
  castings?: CharacterCasting[]
  agent?: DirectorAgentKind
  model: DirectorModelId
  signal?: AbortSignal
  onEvent: (event: DirectorStreamEvent) => void
}

export async function streamDirectorTurn({
  openRouterApiKey,
  deepseekApiKey,
  context,
  traceId,
  actors = [],
  castings = [],
  agent = 'pi',
  model,
  signal,
  onEvent,
}: StreamDirectorTurnOptions): Promise<StreamedDirectorTurn> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (openRouterApiKey) headers['X-OpenRouter-Key'] = openRouterApiKey
  if (deepseekApiKey) headers['X-DeepSeek-Key'] = deepseekApiKey

  const response = await fetch('/api/director/turn', {
    method: 'POST',
    headers,
    body: JSON.stringify({ context, traceId, actors, castings, agent, model }),
    signal,
  })

  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { error?: string }
    throw new Error(body.error ?? `导演服务请求失败（${response.status}）。`)
  }
  if (!response.body) throw new Error('浏览器不支持导演流式响应。')

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let scene: StoryScene | undefined
  let characters: SceneCharacter[] | undefined
  let casting: SceneCastingResult | undefined
  let video: VideoGenerationRequest | undefined
  let streamError = ''

  const consumeLine = (line: string) => {
    if (!line.trim()) return
    const event = parseDirectorEvent(line)
    onEvent(event)
    if (event.type === 'scene') {
      scene = event.scene
      characters = event.characters
    }
    if (event.type === 'cast') casting = event.casting
    if (event.type === 'video_plan') video = event.video
    if (event.type === 'error') streamError = event.error
  }

  while (true) {
    const { done, value } = await reader.read()
    buffer += decoder.decode(value, { stream: !done })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    lines.forEach(consumeLine)
    if (done) break
  }
  consumeLine(buffer)

  if (streamError) throw new Error(streamError)
  if (!scene || !characters) throw new Error('Pi Agent 没有发布故事场景。')
  return { scene, characters, ...(casting ? { casting } : {}), video }
}
