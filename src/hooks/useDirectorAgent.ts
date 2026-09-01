import { useCallback, useRef, useState } from 'react'
import { streamDirectorTurn, type DirectorAgentKind } from '../services/directorClient'
import { getDirectorModelProvider, type DirectorModelId } from '../config/directorModels'
import { describeStoryInput } from '../stories/palace'
import type {
  AgentTraceUpdate,
  DirectorChatMessage,
  DirectorStatus,
  DirectorStreamEvent,
} from '../types/director'
import type { DirectorTurnContext } from '../types/game'
import type { StoryChoice, VideoGenerationRequest } from '../types/story'
import type { Actor } from '../types/actor'
import type { VideoCharacterReference } from '../types/video'
import type { useGameSession } from './useGameSession'

type GameController = ReturnType<typeof useGameSession>

type SubmitSceneVideo = (
  sceneId: string,
  request: VideoGenerationRequest,
  characterReferences: Record<string, VideoCharacterReference>,
) => void

const makeMessage = (
  role: DirectorChatMessage['role'],
  text: string,
): DirectorChatMessage => ({ id: crypto.randomUUID(), role, text, createdAt: Date.now() })

export function useDirectorAgent(
  game: GameController,
  openRouterApiKey: string,
  deepseekApiKey: string,
  onTraceUpdate: (update: AgentTraceUpdate) => void,
  agentKind: DirectorAgentKind,
  modelId: DirectorModelId,
  actors: Actor[],
  submitSceneVideo?: SubmitSceneVideo,
) {
  const [messages, setMessages] = useState<DirectorChatMessage[]>([])
  const [status, setStatus] = useState<DirectorStatus>('idle')
  const runningRef = useRef(false)

  const append = useCallback((role: DirectorChatMessage['role'], text: string) => {
    setMessages((current) => [...current, makeMessage(role, text)])
  }, [])

  const runTurn = useCallback(async (context: DirectorTurnContext) => {
    if (runningRef.current) return false
    const provider = getDirectorModelProvider(modelId)
    const requiredApiKey = provider === 'deepseek' ? deepseekApiKey : openRouterApiKey
    if (!requiredApiKey) {
      setStatus('error')
      append('error', provider === 'deepseek' ? '缺少 DeepSeek API Key，请先打开 API 设置。' : '缺少 OpenRouter API Key，请先打开 API 设置。')
      return false
    }

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
    let publishedSceneId: string | null = null
    let publishedCharacterReferences: Record<string, VideoCharacterReference> = {}
    let scenePublished = false

    const handleEvent = (event: DirectorStreamEvent) => {
      if (event.type === 'status') append('status', event.text)
      if (event.type === 'scene') {
        setStatus('publishing')
        const published = game.publishTurn({ scene: event.scene, characters: event.characters }, actors)
        publishedSceneId = published?.sceneId ?? null
        publishedCharacterReferences = published?.characterReferences ?? {}
        if (published) {
          scenePublished = true
          append('agent', event.scene.narrative)
          append('status', '下一幕已经发布，请作出选择。')
          setStatus('idle')
        }
      }
      if (event.type === 'video_plan' && publishedSceneId) {
        submitSceneVideo?.(publishedSceneId, event.video, publishedCharacterReferences)
      }
      if (event.type === 'video_plan_error') {
        append('error', `视频计划生成失败：${event.message}`)
      }
      if (event.type === 'harness_trace') {
        onTraceUpdate({ type: 'harness', traceId, snapshot: event.trace })
      }
    }

    try {
      await streamDirectorTurn({ openRouterApiKey, deepseekApiKey, context, traceId, agent: agentKind, model: modelId, onEvent: handleEvent })
      if (!scenePublished) throw new Error('当前回合已经变化，无法发布这个场景。')
      onTraceUpdate({ type: 'complete', traceId, endedAt: Date.now() })
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
  }, [actors, openRouterApiKey, deepseekApiKey, agentKind, append, game, modelId, onTraceUpdate, submitSceneVideo])

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

  return { messages, status, startStory, submitChoice, submitFreeform, retry, reset }
}
