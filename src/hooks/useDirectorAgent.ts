import { useCallback, useRef, useState } from 'react'
import {
  fetchDirectorTurnState,
  resumeDirectorTurn,
  streamDirectorTurn,
  type DirectorVideoMode,
} from '../services/directorClient'
import { resolveReferenceDescriptors } from '../services/sessionSegments'
import { getDirectorModelProvider, type DirectorModelId } from '../config/directorModels'
import { describeStoryInput } from '../stories/palace'
import type {
  AgentTraceUpdate,
  DirectorChatMessage,
  DirectorStatus,
  DirectorStreamEvent,
} from '../types/director'
import type { DirectorTurnContext, SceneVideoClip } from '../types/game'
import type { StoryChoice } from '../types/story'
import type { Actor, CreatedActor } from '../types/actor'
import type { VideoCharacterReference } from '../types/video'
import type { useGameSession } from './useGameSession'

type GameController = ReturnType<typeof useGameSession>

// 返回一个非空字符串时，useDirectorAgent 会把它作为错误消息追加到对话记录（例如 auto 模式缺少 fal key）。
export type OnAwaitingUpload = (sceneId: string, clip: SceneVideoClip) => string | void

const makeMessage = (
  role: DirectorChatMessage['role'],
  text: string,
): DirectorChatMessage => ({ id: crypto.randomUUID(), role, text, createdAt: Date.now() })

const apiKeyLabels = { deepseek: 'DeepSeek', openrouter: 'OpenRouter', bigmodel: '智谱 BigModel' } as const

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
  onAwaitingUpload?: OnAwaitingUpload,
) {
  const [messages, setMessages] = useState<DirectorChatMessage[]>([])
  const [status, setStatus] = useState<DirectorStatus>('idle')
  const runningRef = useRef(false)
  // 选角结果按人物 ID 缓存，供后续段落把 character 描述符解析成实际图片。
  const characterReferencesRef = useRef<Record<string, VideoCharacterReference>>({})

  const append = useCallback((role: DirectorChatMessage['role'], text: string) => {
    setMessages((current) => [...current, makeMessage(role, text)])
  }, [])

  const createEventHandler = useCallback((traceId: string) => {
    let videoSkipReason: string | undefined
    let scenePublished = false

    const getSceneId = () => game.getSessionSnapshot()?.currentScene?.id ?? null

    const handleEvent = (event: DirectorStreamEvent) => {
      if (event.type === 'status') append('status', event.text)

      if (event.type === 'scene') {
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
        if (sceneId) {
          const applied = game.applySceneCasting(sceneId, event.casting, actors)
          characterReferencesRef.current = applied?.characterReferences ?? {}
        }
        append(
          'status',
          event.casting.unmatchedCharacterIds.length
            ? `选角完成，${event.casting.unmatchedCharacterIds.length} 个人物暂无匹配演员。`
            : '本幕选角完成。',
        )
      }

      if (event.type === 'cast_error') {
        append('error', `场景选角失败：${event.message}`)
        const sceneId = getSceneId()
        if (sceneId) {
          game.setSceneCastingError(sceneId, event.message)
          game.finishTurn(sceneId, event.message)
        }
      }

      if (event.type === 'segment_written') {
        const sceneId = getSceneId()
        if (sceneId) {
          const resolved = resolveReferenceDescriptors(event.referenceImages, {
            characterReferences: characterReferencesRef.current,
            currentClips: game.getSessionSnapshot()?.currentScene?.videoClips ?? [],
            previousSceneTailFrameUrl: game.getPreviousSceneTailFrameUrl(sceneId),
          })
          game.addWrittenSegment(sceneId, event.segment, event.referenceImages, resolved)
        }
        append('status', `导演写好第 ${event.segment.sequence} 段（累计 ${event.cumulativeSeconds} 秒）。`)
      }

      if (event.type === 'awaiting_upload') {
        const sceneId = getSceneId()
        if (sceneId) {
          const resolved = resolveReferenceDescriptors(event.referenceImages, {
            characterReferences: characterReferencesRef.current,
            currentClips: game.getSessionSnapshot()?.currentScene?.videoClips ?? [],
            previousSceneTailFrameUrl: game.getPreviousSceneTailFrameUrl(sceneId),
          })
          game.markAwaitingUpload(sceneId, {
            sequence: event.sequence,
            toolCallId: event.toolCallId,
            traceId,
            prompt: event.prompt,
            seconds: event.seconds,
            descriptors: event.referenceImages,
            references: resolved,
          })
          append('status', `等待第 ${event.sequence} 段视频${videoMode === 'auto' || videoMode === 'comfy' ? '生成' : '上传'}。`)
          const clip = game.getSessionSnapshot()?.currentScene?.videoClips?.find((item) => item.sequence === event.sequence)
          const warning = clip ? onAwaitingUpload?.(sceneId, clip) : undefined
          if (warning) append('error', warning)
        }
      }

      if (event.type === 'segment_generated') {
        const sceneId = getSceneId()
        if (sceneId) {
          game.completeSegment(sceneId, event.sequence, {
            durationSeconds: event.durationSeconds,
            visualState: event.visualState,
          })
        }
        append('status', `第 ${event.sequence} 段实测 ${event.durationSeconds.toFixed(1)} 秒，导演继续。`)
      }

      if (event.type === 'video_plan') {
        const sceneId = getSceneId()
        if (sceneId) game.setSceneVideoPlan(sceneId, event.video)
      }

      if (event.type === 'scene_visual_state') {
        const sceneId = getSceneId()
        if (sceneId) game.setSceneVisualState(sceneId, event.visualState)
      }

      if (event.type === 'video_plan_error') {
        videoSkipReason = event.message
        append('error', `视频计划生成失败：${event.message}`)
      }

      if (event.type === 'done') {
        const sceneId = getSceneId()
        if (sceneId) game.finishTurn(sceneId, videoSkipReason)
      }

      if (event.type === 'harness_trace') {
        onTraceUpdate({ type: 'harness', traceId, snapshot: event.trace })
      }
    }

    return { handleEvent, isScenePublished: () => scenePublished }
  }, [actors, append, game, onActorsCreated, onAwaitingUpload, onTraceUpdate, videoMode])

  const requireApiKey = useCallback(() => {
    const provider = getDirectorModelProvider(modelId)
    const requiredApiKey = { deepseek: deepseekApiKey, openrouter: openRouterApiKey, bigmodel: bigModelApiKey }[provider]
    if (requiredApiKey) return requiredApiKey
    setStatus('error')
    append('error', `缺少 ${apiKeyLabels[provider]} API Key，请先打开 API 设置。`)
    return null
  }, [append, bigModelApiKey, deepseekApiKey, modelId, openRouterApiKey])

  const runTurn = useCallback(async (context: DirectorTurnContext) => {
    if (runningRef.current) return false
    const requiredApiKey = requireApiKey()
    if (!requiredApiKey) return false

    const traceId = crypto.randomUUID()
    onTraceUpdate({
      type: 'start',
      run: {
        id: traceId,
        gameSessionId: context.sessionId,
        turn: context.turn,
        action: describeStoryInput(context.input),
        startedAt: Date.now(),
        status: 'running',
        entries: [],
      },
    })

    runningRef.current = true
    setStatus('thinking')
    const handler = createEventHandler(traceId)

    try {
      const result = await streamDirectorTurn({
        openRouterApiKey,
        deepseekApiKey,
        bigModelApiKey,
        context,
        traceId,
        actors: actors.map(({ id, name, gender, minAge, maxAge, appearance, referenceImageUrl }) => ({
          id,
          name,
          gender,
          minAge,
          maxAge,
          ...(appearance ? { appearance } : {}),
          hasImage: Boolean(referenceImageUrl),
        })),
        castings: game.getCastings(),
        videoMode,
        model: modelId,
        thinkingEnabled,
        onEvent: handler.handleEvent,
      })
      if (!handler.isScenePublished()) throw new Error('当前回合已经变化，无法发布这个场景。')
      setStatus('idle')
      if (!result.paused) onTraceUpdate({ type: 'complete', traceId, endedAt: Date.now() })
      return true
    } catch (error) {
      const message = error instanceof Error ? error.message : '导演执行失败。'
      setStatus('error')
      append('error', message)
      onTraceUpdate({ type: 'error', traceId, endedAt: Date.now(), message })
      return false
    } finally {
      runningRef.current = false
    }
  }, [actors, append, bigModelApiKey, createEventHandler, deepseekApiKey, game, modelId, onTraceUpdate, openRouterApiKey, requireApiKey, thinkingEnabled, videoMode])

  const resumeTurn = useCallback(async ({ sequence, tailFrameDataUrl, durationSeconds }: {
    sequence: number
    tailFrameDataUrl: string
    durationSeconds: number
  }) => {
    if (runningRef.current) return false
    const session = game.getSessionSnapshot()
    const pendingUpload = session?.pendingUpload
    const sceneId = session?.currentScene?.id
    if (!session || !pendingUpload || !sceneId || pendingUpload.sequence !== sequence) return false
    const requiredApiKey = requireApiKey()
    if (!requiredApiKey) return false

    runningRef.current = true
    setStatus('thinking')
    const traceId = pendingUpload.traceId
    const handler = createEventHandler(traceId)

    try {
      const result = await resumeDirectorTurn({
        sessionId: session.id,
        sequence,
        toolCallId: pendingUpload.toolCallId,
        tailFrameDataUrl,
        durationSeconds,
        openRouterApiKey,
        deepseekApiKey,
        bigModelApiKey,
        onEvent: handler.handleEvent,
      })
      setStatus('idle')
      if (!result.paused) onTraceUpdate({ type: 'complete', traceId, endedAt: Date.now() })
      return true
    } catch (error) {
      const message = error instanceof Error ? error.message : '恢复导演回合失败。'
      game.failSegment(sceneId, sequence, message)
      setStatus('error')
      append('error', message)
      onTraceUpdate({ type: 'error', traceId, endedAt: Date.now(), message })
      return false
    } finally {
      runningRef.current = false
    }
  }, [append, bigModelApiKey, createEventHandler, deepseekApiKey, game, onTraceUpdate, openRouterApiKey, requireApiKey])

  const syncTurnState = useCallback(async () => {
    const session = game.getSessionSnapshot()
    if (!session || session.status === 'awaiting_action') return { needsRetry: false }
    try {
      const serverState = await fetchDirectorTurnState(session.id)
      return game.adoptServerTurnState(serverState, { characterReferences: characterReferencesRef.current })
    } catch {
      return { needsRetry: false }
    }
  }, [game])

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
    const sync = await syncTurnState()
    if (!sync.needsRetry) return false
    const context = game.getPendingContext()
    return context ? runTurn(context) : false
  }, [game, runTurn, syncTurnState])

  const reset = useCallback(() => {
    if (runningRef.current) return false
    setMessages([])
    setStatus('idle')
    return true
  }, [])

  return { messages, status, startStory, submitChoice, submitFreeform, resumeTurn, syncTurnState, retry, reset }
}
