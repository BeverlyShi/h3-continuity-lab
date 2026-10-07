import { useCallback, useRef, useState } from 'react'
import {
  streamDirectorRewrite,
  streamDirectorTurn,
  type DirectorVideoMode,
} from '../services/directorClient'
import { toImageDataUrl } from '../services/dataUrl'
import { getDirectorModelProvider, type DirectorModelId } from '../config/directorModels'
import { describeStoryInput } from '../stories/palace'
import type {
  AgentTraceUpdate,
  DirectorChatMessage,
  DirectorStatus,
  DirectorStreamEvent,
} from '../types/director'
import type { DirectorTurnContext } from '../types/game'
import type { StoryChoice } from '../types/story'
import type { Actor, CreatedActor } from '../types/actor'
import type { useGameSession } from './useGameSession'

type GameController = ReturnType<typeof useGameSession>

// 导演交出（或重写出）分镜、流已正常结束时调用；返回非空字符串时作为错误消息追加到对话记录（例如缺少视频 Key）。
export type OnVideoPlanReady = (sceneId: string, fromSequence: number) => string | void

const makeMessage = (
  role: DirectorChatMessage['role'],
  text: string,
): DirectorChatMessage => ({ id: crypto.randomUUID(), role, text, createdAt: Date.now() })

const apiKeyLabels = { deepseek: 'DeepSeek', openrouter: 'OpenRouter', bigmodel: '智谱 BigModel' } as const

export const MAX_REWRITE_REASON_LENGTH = 200

export function useDirectorAgent(
  game: GameController,
  openRouterApiKey: string,
  deepseekApiKey: string,
  bigModelApiKey: string,
  onTraceUpdate: (update: AgentTraceUpdate) => void,
  videoMode: DirectorVideoMode,
  modelId: DirectorModelId,
  thinkingEnabled: boolean,
  actors: Actor[],
  onActorsCreated: (created: CreatedActor[]) => Promise<void> | void,
  onVideoPlanReady?: OnVideoPlanReady,
) {
  const [messages, setMessages] = useState<DirectorChatMessage[]>([])
  const [status, setStatus] = useState<DirectorStatus>('idle')
  const runningRef = useRef(false)

  const append = useCallback((role: DirectorChatMessage['role'], text: string) => {
    setMessages((current) => [...current, makeMessage(role, text)])
  }, [])

  // rewriteSceneId 存在时是重写请求：不发布场景，done 也不改变会话状态。
  const createEventHandler = useCallback((traceId: string, rewriteSceneId?: string) => {
    let videoSkipReason: string | undefined
    let scenePublished = false
    let videoPlan: { sceneId: string; fromSequence: number } | undefined

    const getSceneId = () => rewriteSceneId ?? game.getSessionSnapshot()?.currentScene?.id ?? null

    const handleEvent = (event: DirectorStreamEvent) => {
      if (event.type === 'status') append('status', event.text)

      if (event.type === 'scene' && !rewriteSceneId) {
        setStatus('publishing')
        const published = game.publishTurn({ scene: event.scene, characters: event.characters })
        if (published) {
          scenePublished = true
          append('agent', event.scene.narrative)
        }
      }

      if (event.type === 'cast') {
        const sceneId = getSceneId()
        const created = event.casting.createdActors ?? []
        if (created.length) {
          void (async () => { await onActorsCreated(created) })().catch((reason: unknown) => {
            append('error', `新建演员入库失败：${reason instanceof Error ? reason.message : '未知错误'}`)
          })
          append('status', `新建演员 ${created.map((actor) => actor.name).join('、')}，待生成参考图，请到演员库复制 prompt 生成后上传。`)
        }
        if (sceneId) game.applySceneCasting(sceneId, event.casting, actors)
        append(
          'status',
          event.casting.unmatchedCharacterIds.length
            ? `选角完成，${event.casting.unmatchedCharacterIds.length} 个人物暂无匹配演员。`
            : '本场次选角完成。',
        )
      }

      if (event.type === 'cast_error') {
        append('error', `场景选角失败：${event.message}`)
        videoSkipReason = event.message
        const sceneId = getSceneId()
        if (sceneId) game.setSceneCastingError(sceneId, event.message)
      }

      if (event.type === 'video_plan') {
        const sceneId = getSceneId()
        if (sceneId) {
          game.applyVideoPlan(sceneId, event, {
            characterReferences: game.getCharacterReferences(actors),
            previousSceneTailFrameUrl: game.getPreviousSceneTailFrameUrl(sceneId),
          })
          videoPlan = { sceneId, fromSequence: event.fromSequence }
        }
        append('status', rewriteSceneId
          ? `导演重写了第 ${event.fromSequence} 段，第 ${event.fromSequence} 段起需要重新生成。`
          : `导演写好本场次 ${event.video.videoPrompts.length} 段分镜（共 ${event.video.totalDuration} 秒）。`)
      }

      if (event.type === 'video_plan_error') {
        videoSkipReason = event.message
        append('error', rewriteSceneId ? `重写失败：${event.message}` : `本场次不生成视频：${event.message}`)
      }

      if (event.type === 'done' && !rewriteSceneId) {
        const sceneId = getSceneId()
        if (sceneId) game.finishDirectorRun(sceneId, { hasVideoPlan: Boolean(videoPlan), skippedReason: videoSkipReason })
      }

      if (event.type === 'harness_trace') {
        onTraceUpdate({ type: 'harness', traceId, snapshot: event.trace })
      }
    }

    return {
      handleEvent,
      isScenePublished: () => scenePublished,
      getVideoPlan: () => videoPlan,
      getSkipReason: () => videoSkipReason,
    }
  }, [actors, append, game, onActorsCreated, onTraceUpdate])

  const notifyVideoPlanReady = useCallback((plan: { sceneId: string; fromSequence: number } | undefined) => {
    if (!plan) return
    const warning = onVideoPlanReady?.(plan.sceneId, plan.fromSequence)
    if (warning) append('error', warning)
  }, [append, onVideoPlanReady])

  const requireApiKey = useCallback(() => {
    const provider = getDirectorModelProvider(modelId)
    const requiredApiKey = { deepseek: deepseekApiKey, openrouter: openRouterApiKey, bigmodel: bigModelApiKey }[provider]
    if (requiredApiKey) return requiredApiKey
    setStatus('error')
    append('error', `缺少 ${apiKeyLabels[provider]} API Key，请先打开 API 设置。`)
    return null
  }, [append, bigModelApiKey, deepseekApiKey, modelId, openRouterApiKey])

  const castableActors = useCallback(() => actors.map(({ id, name, gender, minAge, maxAge, appearance, referenceImageUrl }) => ({
    id,
    name,
    gender,
    minAge,
    maxAge,
    ...(appearance ? { appearance } : {}),
    hasImage: Boolean(referenceImageUrl),
  })), [actors])

  // 上一场次有完整视频时附上最后一帧；读不到图片就不附，导演只能换场景开场，不让场次失败。
  const attachPreviousScene = useCallback(async (context: DirectorTurnContext): Promise<DirectorTurnContext> => {
    const session = game.getSessionSnapshot()
    const previous = session?.currentScene
    if (!session || !previous?.tailFrameUrl) return context
    try {
      const tailFrameDataUrl = await toImageDataUrl(previous.tailFrameUrl)
      const characterIds = new Set(previous.characterIds ?? [])
      const characters = session.characters.filter((character) => characterIds.has(character.id))
      return { ...context, previousScene: { tailFrameDataUrl, characters } }
    } catch {
      return context
    }
  }, [game])

  const runTurn = useCallback(async (baseContext: DirectorTurnContext) => {
    if (runningRef.current) return false
    const requiredApiKey = requireApiKey()
    if (!requiredApiKey) return false

    const traceId = crypto.randomUUID()
    onTraceUpdate({
      type: 'start',
      run: {
        id: traceId,
        gameSessionId: baseContext.sessionId,
        turn: baseContext.turn,
        action: describeStoryInput(baseContext.input),
        startedAt: Date.now(),
        status: 'running',
        entries: [],
      },
    })

    runningRef.current = true
    setStatus('thinking')
    const handler = createEventHandler(traceId)

    try {
      const context = await attachPreviousScene(baseContext)
      await streamDirectorTurn({
        openRouterApiKey,
        deepseekApiKey,
        bigModelApiKey,
        context,
        traceId,
        actors: castableActors(),
        castings: game.getCastings(),
        videoMode,
        model: modelId,
        thinkingEnabled,
        onEvent: handler.handleEvent,
      })
      if (!handler.isScenePublished()) throw new Error('当前场次已经变化，无法发布这个场景。')
      setStatus('idle')
      onTraceUpdate({ type: 'complete', traceId, endedAt: Date.now() })
      notifyVideoPlanReady(handler.getVideoPlan())
      return true
    } catch (error) {
      const message = error instanceof Error ? error.message : '导演执行失败。'
      setStatus('error')
      append('error', message)
      onTraceUpdate({ type: 'error', traceId, endedAt: Date.now(), message })
      // 场景已经发布、玩家输入已消耗，无法再重试：按已收到的分镜收尾，避免卡在导演写作中。
      const sceneId = game.getSessionSnapshot()?.currentScene?.id
      if (handler.isScenePublished() && sceneId) {
        const videoPlan = handler.getVideoPlan()
        game.finishDirectorRun(sceneId, {
          hasVideoPlan: Boolean(videoPlan),
          skippedReason: handler.getSkipReason() ?? `导演连接中断：${message}`,
        })
        notifyVideoPlanReady(videoPlan)
      }
      return false
    } finally {
      runningRef.current = false
    }
  }, [append, attachPreviousScene, bigModelApiKey, castableActors, createEventHandler, deepseekApiKey, game, modelId, notifyVideoPlanReady, onTraceUpdate, openRouterApiKey, requireApiKey, thinkingEnabled, videoMode])

  const rewriteSegment = useCallback(async (sceneId: string, sequence: number, reason: string) => {
    if (runningRef.current) return false
    const session = game.getSessionSnapshot()
    const scene = session?.currentScene
    const cleanReason = reason.trim()
    if (!session || scene?.id !== sceneId || session.status !== 'awaiting_video') return false
    if (!cleanReason || cleanReason.length > MAX_REWRITE_REASON_LENGTH) return false
    if (!scene.videoClips?.some((clip) => clip.sequence === sequence)) return false
    const requiredApiKey = requireApiKey()
    if (!requiredApiKey) return false

    const traceId = crypto.randomUUID()
    onTraceUpdate({
      type: 'start',
      run: {
        id: traceId,
        gameSessionId: session.id,
        turn: scene.turn,
        action: `重写第 ${sequence} 段：${cleanReason}`,
        startedAt: Date.now(),
        status: 'running',
        entries: [],
      },
    })
    append('player', `请重写第 ${sequence} 段：${cleanReason}`)

    runningRef.current = true
    setStatus('thinking')
    const handler = createEventHandler(traceId, sceneId)

    try {
      await streamDirectorRewrite({
        openRouterApiKey,
        deepseekApiKey,
        bigModelApiKey,
        sessionId: session.id,
        sequence,
        reason: cleanReason,
        traceId,
        actors: castableActors(),
        model: modelId,
        thinkingEnabled,
        onEvent: handler.handleEvent,
      })
      setStatus('idle')
      onTraceUpdate({ type: 'complete', traceId, endedAt: Date.now() })
      notifyVideoPlanReady(handler.getVideoPlan())
      return true
    } catch (error) {
      const message = error instanceof Error ? error.message : '导演重写失败。'
      setStatus('error')
      append('error', message)
      onTraceUpdate({ type: 'error', traceId, endedAt: Date.now(), message })
      return false
    } finally {
      runningRef.current = false
    }
  }, [append, bigModelApiKey, castableActors, createEventHandler, deepseekApiKey, game, modelId, notifyVideoPlanReady, onTraceUpdate, openRouterApiKey, requireApiKey, thinkingEnabled])

  const startStory = useCallback(() => {
    if (runningRef.current) return false
    const context = game.startStory()
    if (!context) return false
    append('player', '请开始故事')
    void runTurn(context)
    return true
  }, [append, game, runTurn])

  const submitChoice = useCallback((choice: StoryChoice) => {
    if (runningRef.current) return false
    const context = game.submitChoice(choice)
    if (!context) return false
    append('player', choice.text)
    void runTurn(context)
    return true
  }, [append, game, runTurn])

  const submitFreeform = useCallback((text: string) => {
    if (runningRef.current) return false
    const context = game.submitFreeform(text)
    if (!context) return false
    append('player', text.trim())
    void runTurn(context)
    return true
  }, [append, game, runTurn])

  const retry = useCallback(async () => {
    const context = game.getPendingContext()
    return context ? runTurn(context) : false
  }, [game, runTurn])

  const reset = useCallback(() => {
    if (runningRef.current) return false
    setMessages([])
    setStatus('idle')
    return true
  }, [])

  return { messages, status, startStory, submitChoice, submitFreeform, rewriteSegment, retry, reset }
}
