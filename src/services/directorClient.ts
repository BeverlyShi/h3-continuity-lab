import type { DirectorStreamEvent } from '../types/director'
import type { DirectorTurnContext } from '../types/game'
import type { StoryScene } from '../types/story'

export function parseDirectorEvent(line: string): DirectorStreamEvent {
  const event = JSON.parse(line) as DirectorStreamEvent
  if (!event || typeof event !== 'object' || typeof event.type !== 'string') {
    throw new Error('导演返回了无法识别的数据。')
  }
  return event
}

export type DirectorAgentKind = 'pi' | 'simple'

type StreamDirectorTurnOptions = {
  apiKey: string
  context: DirectorTurnContext
  traceId: string
  agent?: DirectorAgentKind
  signal?: AbortSignal
  onEvent: (event: DirectorStreamEvent) => void
}

export async function streamDirectorTurn({
  apiKey,
  context,
  traceId,
  agent = 'pi',
  signal,
  onEvent,
}: StreamDirectorTurnOptions): Promise<StoryScene> {
  const response = await fetch('/api/director/turn', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-DeepSeek-Key': apiKey,
    },
    body: JSON.stringify({ context, traceId, agent }),
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
  let streamError = ''

  const consumeLine = (line: string) => {
    if (!line.trim()) return
    const event = parseDirectorEvent(line)
    onEvent(event)
    if (event.type === 'scene') scene = event.scene
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
  if (!scene) throw new Error('Pi Agent 没有发布故事场景。')
  return scene
}
