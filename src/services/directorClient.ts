import { getDirectorModelProvider, type DirectorModelId } from '../config/directorModels.ts'
import type {
  DirectorAgentRequest,
  DirectorSessionStore,
  RewriteDirectorRequest,
} from '../director/directorAgent.ts'
import type { CastableActor, CharacterCasting, SceneCastingResult } from '../types/actor'
import type { DirectorStreamEvent } from '../types/director'
import type { DirectorTurnContext } from '../types/game'
import type { SceneCharacter, StoryScene, VideoGenerationRequest } from '../types/story'

export type StreamedDirectorTurn = {
  scene: StoryScene
  characters: SceneCharacter[]
  casting?: SceneCastingResult
  video?: VideoGenerationRequest
}

// 导演在浏览器里运行；测试可注入假的导演函数或内存会话存储。
export type DirectorRuntime = {
  store: DirectorSessionStore
  runDirectorAgent: (request: DirectorAgentRequest) => Promise<unknown>
  rewriteDirectorSegment: (request: RewriteDirectorRequest) => Promise<unknown>
}

let runtimePromise: Promise<DirectorRuntime> | undefined

// 导演模块（pi-agent-core / pi-ai / OpenAI SDK）第一次用到时才加载，不进首屏包。
const loadDirectorRuntime = () => runtimePromise ??= Promise.all([
  import('../director/directorAgent.ts'),
  import('../director/browserSessionStore.ts'),
]).then(([agent, sessions]) => ({
  store: sessions.createBrowserSessionStore(),
  runDirectorAgent: agent.runDirectorAgent,
  rewriteDirectorSegment: agent.rewriteDirectorSegment,
}), (error: unknown) => {
  runtimePromise = undefined
  throw error
})

type DirectorKeys = {
  openRouterApiKey?: string
  deepseekApiKey?: string
  bigModelApiKey?: string
}

const requireModelKey = (modelId: DirectorModelId, keys: DirectorKeys) => {
  const provider = getDirectorModelProvider(modelId)
  const apiKey = { deepseek: keys.deepseekApiKey, openrouter: keys.openRouterApiKey, bigmodel: keys.bigModelApiKey }[provider]?.trim()
  if (!apiKey) {
    throw new Error(`请先在设置里填写 ${{ deepseek: 'DeepSeek', openrouter: 'OpenRouter', bigmodel: '智谱 BigModel' }[provider]} API Key。`)
  }
  return apiKey
}

const optionalKey = (key: string | undefined) => key?.trim() || undefined

// 事件按 JSON 复制一份再交给前端（与原先的 NDJSON 传输等价），前端状态不与导演内部对象共享引用。
// 出错时补发 error 事件并以该错误结束；正常结束必须收到 done。
const runDirector = async (
  signal: AbortSignal | undefined,
  onEvent: (event: DirectorStreamEvent) => void,
  fallbackError: string,
  runtime: DirectorRuntime | undefined,
  run: (runtime: DirectorRuntime, send: (event: DirectorStreamEvent) => void, signal: AbortSignal) => Promise<unknown>,
): Promise<void> => {
  const controller = new AbortController()
  const abort = () => controller.abort(signal?.reason)
  if (signal?.aborted) abort()
  else signal?.addEventListener('abort', abort, { once: true })

  let done = false
  let streamError = ''
  let listenerFailed = false
  let listenerError: unknown

  const send = (event: DirectorStreamEvent) => {
    if (listenerFailed) return
    const copy = JSON.parse(JSON.stringify(event)) as DirectorStreamEvent
    if (copy.type === 'done') done = true
    if (copy.type === 'error') streamError = copy.error
    try {
      onEvent(copy)
    } catch (error) {
      // 前端处理事件出错时停止导演，相当于原先浏览器断开连接。
      listenerFailed = true
      listenerError = error
      controller.abort()
    }
  }

  try {
    await run(runtime ?? await loadDirectorRuntime(), send, controller.signal)
  } catch (error) {
    send({ type: 'error', error: error instanceof Error ? error.message : fallbackError })
  } finally {
    signal?.removeEventListener('abort', abort)
  }

  if (listenerFailed) throw listenerError
  if (streamError) throw new Error(streamError)
  if (!done) throw new Error('导演连接意外中断，请重试。')
}

type StreamDirectorTurnOptions = DirectorKeys & {
  context: DirectorTurnContext
  traceId: string
  actors?: CastableActor[]
  castings?: CharacterCasting[]
  knownCharacters?: SceneCharacter[]
  model: DirectorModelId
  thinkingEnabled?: boolean
  signal?: AbortSignal
  onEvent: (event: DirectorStreamEvent) => void
  runtime?: DirectorRuntime
}

export async function streamDirectorTurn({
  openRouterApiKey,
  deepseekApiKey,
  bigModelApiKey,
  context,
  traceId,
  actors = [],
  castings = [],
  knownCharacters = [],
  model,
  thinkingEnabled = false,
  signal,
  onEvent,
  runtime,
}: StreamDirectorTurnOptions): Promise<StreamedDirectorTurn> {
  let scene: StoryScene | undefined
  let characters: SceneCharacter[] | undefined
  let casting: SceneCastingResult | undefined
  let video: VideoGenerationRequest | undefined

  await runDirector(signal, (event) => {
    if (event.type === 'scene') {
      scene = event.scene
      characters = event.characters
    }
    if (event.type === 'cast') casting = event.casting
    if (event.type === 'video_plan') video = event.video
    onEvent(event)
  }, '导演请求失败。', runtime, async (director, send, runSignal) => {
    // 本地存档里可能残留旧版尾帧地址，这里拦下以免把坏数据交给导演。
    if (context.previousScene && !context.previousScene.tailFrameDataUrl.startsWith('data:image/')) {
      throw new Error('故事输入无效。')
    }
    await director.runDirectorAgent({
      store: director.store,
      apiKey: requireModelKey(model, { openRouterApiKey, deepseekApiKey, bigModelApiKey }),
      modelId: model,
      thinkingEnabled,
      context,
      actors,
      castings,
      knownCharacters,
      traceId,
      visionKey: optionalKey(deepseekApiKey),
      signal: runSignal,
      send,
    })
  })

  if (!scene || !characters) throw new Error('导演没有发布故事场景。')
  return { scene, characters, ...(casting ? { casting } : {}), video }
}

type StreamDirectorRewriteOptions = DirectorKeys & {
  sessionId: string
  sequence: number
  reason: string
  traceId: string
  actors?: CastableActor[]
  model: DirectorModelId
  thinkingEnabled?: boolean
  signal?: AbortSignal
  onEvent: (event: DirectorStreamEvent) => void
  runtime?: DirectorRuntime
}

// 让导演重写当前场次第 sequence 段；成功时事件里只有一次 video_plan（fromSequence = sequence）。
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
  runtime,
}: StreamDirectorRewriteOptions): Promise<{ video?: VideoGenerationRequest }> {
  let video: VideoGenerationRequest | undefined
  await runDirector(signal, (event) => {
    if (event.type === 'video_plan') video = event.video
    onEvent(event)
  }, '重写分镜失败。', runtime, async (director, send, runSignal) => {
    if (!Number.isInteger(sequence) || sequence < 1 || sequence > 3) throw new Error('段号无效。')
    const cleanReason = reason.trim()
    if (!cleanReason || cleanReason.length > 200) throw new Error('请写明重写原因（200 字以内）。')
    await director.rewriteDirectorSegment({
      store: director.store,
      sessionId,
      sequence,
      reason: cleanReason,
      apiKey: requireModelKey(model, { openRouterApiKey, deepseekApiKey, bigModelApiKey }),
      modelId: model,
      thinkingEnabled,
      actors,
      traceId,
      signal: runSignal,
      send,
    })
  })
  return { video }
}
