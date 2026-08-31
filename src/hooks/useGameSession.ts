import { useCallback, useRef, useState } from 'react'
import { clearGameSession, loadGameSession, saveGameSession } from '../services/gameStorage'
import { palaceStory } from '../stories/palace'
import type { DirectorTurnContext, GameScene, GameSession } from '../types/game'
import type { StoryChoice, StoryInput, StoryScene } from '../types/story'

const now = () => Date.now()

const toTurnContext = (session: GameSession): DirectorTurnContext | null => session.pendingInput
  ? { ok: true, sessionId: session.id, turn: session.turn, input: session.pendingInput }
  : null

const makeNewSession = (): GameSession => {
  const createdAt = now()
  return {
    schemaVersion: 4,
    id: crypto.randomUUID(),
    storyId: palaceStory.id,
    status: 'awaiting_agent',
    turn: 1,
    createdAt,
    updatedAt: createdAt,
    sceneHistory: [],
    pendingInput: { type: 'start' },
  }
}

export function useGameSession() {
  const [session, setSession] = useState<GameSession | null>(loadGameSession)
  const sessionRef = useRef(session)

  const replaceSession = useCallback((next: GameSession | null) => {
    sessionRef.current = next
    setSession(next)
    if (next) saveGameSession(next)
    else clearGameSession()
  }, [])

  const startStory = useCallback(() => {
    if (sessionRef.current) return null
    const next = makeNewSession()
    replaceSession(next)
    return toTurnContext(next)
  }, [replaceSession])

  const queueInput = useCallback((input: StoryInput) => {
    const current = sessionRef.current
    if (!current || current.status !== 'awaiting_action') return null
    const next: GameSession = {
      ...current,
      status: 'awaiting_agent',
      updatedAt: now(),
      pendingInput: input,
    }
    replaceSession(next)
    return toTurnContext(next)
  }, [replaceSession])

  const submitChoice = useCallback((choice: StoryChoice) => {
    const current = sessionRef.current
    const isCurrentChoice = current?.currentScene?.choices.some((candidate) =>
      candidate.id === choice.id,
    )
    if (!isCurrentChoice) return null
    return queueInput({ type: 'choice', choice })
  }, [queueInput])

  const submitFreeform = useCallback((text: string) => {
    const cleanText = text.trim()
    if (!cleanText) return null
    return queueInput({ type: 'freeform', text: cleanText })
  }, [queueInput])

  const publishScene = useCallback((published: StoryScene) => {
    const current = sessionRef.current
    if (!current || current.status !== 'awaiting_agent' || !current.pendingInput) return null
    const scene = {
      ...published,
      id: crypto.randomUUID(),
      turn: current.turn,
    }
    replaceSession({
      ...current,
      status: 'awaiting_action',
      turn: current.turn + 1,
      updatedAt: now(),
      currentScene: scene,
      sceneHistory: [...current.sceneHistory, scene],
      pendingInput: undefined,
    })
    return scene.id
  }, [replaceSession])

  const attachSceneVideo = useCallback((
    sceneId: string,
    patch: {
      videoStatus: GameScene['videoStatus']
      videoUrl?: string
      videoError?: string
      videoRequest?: GameScene['videoRequest']
    },
  ) => {
    const current = sessionRef.current
    if (!current) return
    const applyPatch = (scene: GameScene): GameScene => scene.id === sceneId
      ? { ...scene, ...patch }
      : scene
    replaceSession({
      ...current,
      currentScene: current.currentScene ? applyPatch(current.currentScene) : current.currentScene,
      sceneHistory: current.sceneHistory.map(applyPatch),
    })
  }, [replaceSession])

  const getPendingContext = useCallback(() => {
    const current = sessionRef.current
    return current ? toTurnContext(current) : null
  }, [])

  const restart = useCallback(() => replaceSession(null), [replaceSession])

  return {
    session,
    startStory,
    submitChoice,
    submitFreeform,
    publishScene,
    attachSceneVideo,
    getPendingContext,
    restart,
  }
}
