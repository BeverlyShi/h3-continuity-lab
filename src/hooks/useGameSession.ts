import { useCallback, useEffect, useRef, useState } from 'react'
import { applyDirectorResolution, INITIAL_PERMITS } from '../engine/gameRules'
import { compileScenePrompt } from '../engine/promptCompiler'
import { createFalVideoGenerator } from '../services/falVideoGenerator'
import { clearGameSession, loadGameSession, saveGameSession } from '../services/gameStorage'
import { unregisteredCity } from '../stories/unregisteredCity'
import type {
  DirectorResolutionInput,
  GameEvent,
  GameScene,
  GameSession,
  PlayerAction,
} from '../types/game'
import { VIDEO_DURATION } from '../types/video'

const now = () => Date.now()
const makeEvent = (turn: number, type: GameEvent['type'], text: string): GameEvent => ({
  id: crypto.randomUUID(), turn, type, text, createdAt: now(),
})

const makeNewSession = (): GameSession => ({
  schemaVersion: 2,
  id: crypto.randomUUID(),
  storyId: unregisteredCity.id,
  status: 'generating_opening',
  turn: 0,
  createdAt: now(),
  updatedAt: now(),
  stats: { ...unregisteredCity.initialStats },
  permits: INITIAL_PERMITS.map((permit) => ({ ...permit })),
  sceneHistory: [],
  events: [],
})

export function useGameSession(savedApiKey: string) {
  const [session, setSession] = useState<GameSession | null>(loadGameSession)
  const sessionRef = useRef(session)
  const apiKeyRef = useRef(savedApiKey)
  const activeGenerationId = useRef('')

  useEffect(() => { apiKeyRef.current = savedApiKey }, [savedApiKey])

  const replaceSession = useCallback((next: GameSession | null) => {
    sessionRef.current = next
    setSession(next)
    if (next) saveGameSession(next)
    else clearGameSession()
  }, [])

  const generateOpening = useCallback(async () => {
    if (!apiKeyRef.current || activeGenerationId.current) return { ok: false, error: '请先配置 FAL_KEY。' }
    const generatingSession = makeNewSession()
    activeGenerationId.current = generatingSession.id
    replaceSession(generatingSession)
    try {
      const result = await createFalVideoGenerator(apiKeyRef.current).generate(
        unregisteredCity.openingPrompt,
        VIDEO_DURATION,
        0,
      )
      const openingScene: GameScene = {
        id: crypto.randomUUID(),
        turn: 0,
        title: unregisteredCity.openingTitle,
        narrative: unregisteredCity.openingNarrative,
        prompt: unregisteredCity.openingPrompt,
        videoUrl: result.videoUrl,
        options: unregisteredCity.initialOptions,
      }
      replaceSession({
        ...generatingSession,
        status: 'playing',
        updatedAt: now(),
        currentScene: openingScene,
        sceneHistory: [openingScene],
        error: undefined,
        failureStep: undefined,
      })
      return { ok: true }
    } catch (error) {
      replaceSession({
        ...generatingSession,
        status: 'failed',
        updatedAt: now(),
        failureStep: 'opening',
        error: error instanceof Error ? error.message : '开场视频生成失败，请重试。',
      })
      return { ok: false, error: '开场视频生成失败。' }
    } finally {
      activeGenerationId.current = ''
    }
  }, [replaceSession])

  const submitAction = useCallback((text: string, source: PlayerAction['source']) => {
    const current = sessionRef.current
    const cleanText = text.trim()
    if (!current || current.status !== 'awaiting_action' || !cleanText) return false
    const action: PlayerAction = { text: cleanText, source, submittedAt: now() }
    replaceSession({
      ...current,
      status: 'awaiting_director',
      updatedAt: now(),
      pendingAction: action,
      events: [...current.events, makeEvent(current.turn, 'player_action', cleanText)],
    })
    return true
  }, [replaceSession])

  const completeScenePlayback = useCallback(() => {
    const current = sessionRef.current
    if (!current || current.status !== 'playing') return
    if (current.currentScene?.ending) {
      replaceSession({ ...current, status: 'ended', updatedAt: now() })
    } else {
      replaceSession({
        ...current,
        status: 'awaiting_action',
        turn: current.turn + 1,
        updatedAt: now(),
      })
    }
  }, [replaceSession])

  const commitResolution = useCallback((input: DirectorResolutionInput) => {
    const current = sessionRef.current
    if (!current) return { ok: false, errors: ['游戏尚未开始。'] }
    const decision = applyDirectorResolution(current, unregisteredCity, input)
    if (!decision.ok) return decision
    const resolution = {
      id: crypto.randomUUID(),
      input,
      appliedStats: decision.appliedStats,
      appliedPermits: decision.permits,
      compiledPrompt: compileScenePrompt(
        unregisteredCity, current, input, decision.permits, decision.ending,
      ),
      ending: decision.ending,
    }
    replaceSession({
      ...current,
      status: 'resolved',
      updatedAt: now(),
      stats: decision.stats,
      permits: decision.permits,
      pendingResolution: resolution,
      events: [...current.events, makeEvent(current.turn, 'resolution', input.narrative)],
    })
    return { ok: true, resolutionId: resolution.id, appliedStats: decision.appliedStats, ending: decision.ending }
  }, [replaceSession])

  const requestVideo = useCallback(async () => {
    const current = sessionRef.current
    if (!current?.pendingResolution || !['resolved', 'failed'].includes(current.status)) {
      return { ok: false, error: '当前没有已经通过规则校验的裁决。' }
    }
    if (current.status === 'failed' && current.failureStep !== 'next_scene') {
      return { ok: false, error: '当前失败不属于下一镜生成。' }
    }
    if (!apiKeyRef.current) return { ok: false, error: '玩家尚未配置 FAL_KEY。' }
    if (activeGenerationId.current) return { ok: false, error: '已有视频正在生成。' }

    const resolutionId = current.pendingResolution.id
    activeGenerationId.current = resolutionId
    replaceSession({ ...current, status: 'generating_video', updatedAt: now(), error: undefined })
    try {
      const result = await createFalVideoGenerator(apiKeyRef.current).generate(
        current.pendingResolution.compiledPrompt,
        VIDEO_DURATION,
        current.turn,
      )
      const latest = sessionRef.current
      if (!latest?.pendingResolution || latest.pendingResolution.id !== resolutionId) {
        return { ok: false, error: '回合已变化，生成结果未发布。' }
      }
      const pendingResolution = { ...latest.pendingResolution, videoUrl: result.videoUrl, videoError: undefined }
      replaceSession({
        ...latest,
        status: 'ready_to_publish',
        updatedAt: now(),
        pendingResolution,
        failureStep: undefined,
      })
      return { ok: true, status: 'ready_to_publish' }
    } catch (error) {
      const latest = sessionRef.current ?? current
      const message = error instanceof Error ? error.message : '下一幕视频生成失败，请重试。'
      replaceSession({
        ...latest,
        status: 'failed',
        updatedAt: now(),
        failureStep: 'next_scene',
        error: message,
        pendingResolution: latest.pendingResolution
          ? { ...latest.pendingResolution, videoError: message }
          : latest.pendingResolution,
      })
      return { ok: false, error: message }
    } finally {
      activeGenerationId.current = ''
    }
  }, [replaceSession])

  const publishTurn = useCallback(() => {
    const current = sessionRef.current
    const resolution = current?.pendingResolution
    if (!current || current.status !== 'ready_to_publish' || !resolution?.videoUrl) {
      return { ok: false, error: '下一幕视频尚未生成完成。' }
    }
    const scene: GameScene = {
      id: crypto.randomUUID(),
      turn: current.turn,
      title: resolution.ending?.title ?? `第 ${current.turn + 1} 幕`,
      narrative: resolution.input.narrative,
      prompt: resolution.compiledPrompt,
      videoUrl: resolution.videoUrl,
      options: resolution.input.nextOptions,
      ending: resolution.ending,
    }
    replaceSession({
      ...current,
      status: 'playing',
      updatedAt: now(),
      currentScene: scene,
      sceneHistory: [...current.sceneHistory, scene],
      pendingAction: undefined,
      pendingResolution: undefined,
      events: [...current.events, makeEvent(current.turn, 'scene_published', scene.title)],
    })
    return { ok: true, sceneId: scene.id, ending: scene.ending }
  }, [replaceSession])

  const getTurnContext = useCallback(() => {
    const current = sessionRef.current
    if (!current) return { ok: false, error: '游戏尚未开始。' }
    return {
      ok: true,
      story: {
        id: unregisteredCity.id,
        title: unregisteredCity.title,
        coreRules: unregisteredCity.coreRules,
        maxTurns: unregisteredCity.maxTurns,
        characters: unregisteredCity.characters,
      },
      session: current,
      directorInstruction: current.status === 'awaiting_director'
        ? '裁决 pendingAction，然后依次调用 commit_resolution、request_video、publish_turn。'
        : `当前阶段是 ${current.status}，不要提交新的裁决。`,
    }
  }, [])

  const getGenerationStatus = useCallback(() => {
    const current = sessionRef.current
    return {
      ok: Boolean(current),
      status: current?.status ?? 'not_started',
      turn: current?.turn ?? 0,
      error: current?.error,
      hasVideo: Boolean(current?.pendingResolution?.videoUrl),
    }
  }, [])

  const restart = useCallback(() => replaceSession(null), [replaceSession])

  return {
    session,
    generateOpening,
    submitAction,
    completeScenePlayback,
    commitResolution,
    requestVideo,
    getTurnContext,
    getGenerationStatus,
    publishTurn,
    restart,
  }
}
