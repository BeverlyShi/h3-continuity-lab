import { useCallback, useRef, useState } from 'react'
import { applyDirectorResolution, INITIAL_PERMITS } from '../engine/gameRules'
import { compileScenePrompt } from '../engine/promptCompiler'
import { clearGameSession, loadGameSession, saveGameSession } from '../services/gameStorage'
import { unregisteredCity } from '../stories/unregisteredCity'
import type {
  DirectorResolutionInput,
  GameEvent,
  GameScene,
  GameSession,
  PlayerAction,
} from '../types/game'

const now = () => Date.now()
const makeEvent = (turn: number, type: GameEvent['type'], text: string): GameEvent => ({
  id: crypto.randomUUID(), turn, type, text, createdAt: now(),
})

const makeNewSession = (): GameSession => ({
  schemaVersion: 3,
  id: crypto.randomUUID(),
  storyId: unregisteredCity.id,
  status: 'awaiting_action',
  turn: 1,
  createdAt: now(),
  updatedAt: now(),
  stats: { ...unregisteredCity.initialStats },
  permits: INITIAL_PERMITS.map((permit) => ({ ...permit })),
  currentScene: {
    id: crypto.randomUUID(),
    turn: 0,
    title: unregisteredCity.openingTitle,
    narrative: unregisteredCity.openingNarrative,
    prompt: unregisteredCity.openingPrompt,
    options: unregisteredCity.initialOptions,
  },
  sceneHistory: [],
  events: [],
})

export function useGameSession() {
  const [session, setSession] = useState<GameSession | null>(loadGameSession)
  const sessionRef = useRef(session)

  const replaceSession = useCallback((next: GameSession | null) => {
    sessionRef.current = next
    setSession(next)
    if (next) saveGameSession(next)
    else clearGameSession()
  }, [])

  const generateOpening = useCallback(() => {
    const openingSession = makeNewSession()
    openingSession.sceneHistory = [openingSession.currentScene!]
    replaceSession(openingSession)
    return { ok: true }
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
    return {
      ok: true,
      resolutionId: resolution.id,
      appliedStats: decision.appliedStats,
      ending: decision.ending,
      trace: {
        statsBefore: current.stats,
        statsAfter: decision.stats,
        permitsBefore: current.permits,
        permitsAfter: decision.permits,
      },
    }
  }, [replaceSession])

  const publishTurn = useCallback(() => {
    const current = sessionRef.current
    const resolution = current?.pendingResolution
    if (!current || current.status !== 'resolved' || !resolution) {
      return { ok: false, error: '当前没有可发布的文字裁决。' }
    }
    const scene: GameScene = {
      id: crypto.randomUUID(),
      turn: current.turn,
      title: resolution.ending?.title ?? `第 ${current.turn + 1} 幕`,
      narrative: resolution.input.narrative,
      prompt: resolution.compiledPrompt,
      options: resolution.input.nextOptions,
      ending: resolution.ending,
    }
    replaceSession({
      ...current,
      status: resolution.ending ? 'ended' : 'awaiting_action',
      turn: resolution.ending ? current.turn : current.turn + 1,
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
        ? '裁决 pendingAction，然后依次调用 commit_resolution、publish_turn。'
        : `当前阶段是 ${current.status}，不要提交新的裁决。`,
    }
  }, [])

  const getGenerationStatus = useCallback(() => {
    const current = sessionRef.current
    return {
      ok: Boolean(current),
      status: current?.status ?? 'not_started',
      turn: current?.turn ?? 0,
      hasResolution: Boolean(current?.pendingResolution),
    }
  }, [])

  const restart = useCallback(() => replaceSession(null), [replaceSession])

  return {
    session,
    generateOpening,
    submitAction,
    commitResolution,
    getTurnContext,
    getGenerationStatus,
    publishTurn,
    restart,
  }
}
