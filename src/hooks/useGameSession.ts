import { useCallback, useRef, useState } from 'react'
import { clearGameSession, loadGameSession, saveGameSession } from '../services/gameStorage'
import { palaceStory } from '../stories/palace'
import type { DirectorTurnContext, GameScene, GameSession, SceneVideoClip } from '../types/game'
import type {
  ScenePublish,
  StoryChoice,
  StoryInput,
  VideoGenerationRequest,
} from '../types/story'
import type { Actor } from '../types/actor'
import { buildCharacterReferences, resolveCharacterCastings } from '../services/casting'

const now = () => Date.now()

const toTurnContext = (session: GameSession): DirectorTurnContext | null => session.pendingInput
  ? { ok: true, sessionId: session.id, turn: session.turn, input: session.pendingInput }
  : null

const makeNewSession = (): GameSession => {
  const createdAt = now()
  return {
    schemaVersion: 7,
    id: crypto.randomUUID(),
    storyId: palaceStory.id,
    status: 'awaiting_agent',
    turn: 1,
    createdAt,
    updatedAt: createdAt,
    sceneHistory: [],
    characters: [],
    castings: [],
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

  const publishTurn = useCallback((published: ScenePublish, actors: Actor[]) => {
    const current = sessionRef.current
    if (!current || current.status !== 'awaiting_agent' || !current.pendingInput) return null
    const charactersById = new Map(current.characters.map((character) => [character.id, character]))
    published.characters.forEach((character) => charactersById.set(character.id, character))
    const characters = [...charactersById.values()]
    const castings = resolveCharacterCastings(characters, actors, current.castings)
    const scene = {
      ...published.scene,
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
      characters,
      castings,
      pendingInput: undefined,
    })
    return {
      sceneId: scene.id,
      characterReferences: buildCharacterReferences(characters, actors, castings),
    }
  }, [replaceSession])

  const getCharacterReferences = useCallback((actors: Actor[]) => {
    const current = sessionRef.current
    return current ? buildCharacterReferences(current.characters, actors, current.castings) : {}
  }, [])

  const setSceneVideoPlan = useCallback((
    sceneId: string,
    request: VideoGenerationRequest,
    status: SceneVideoClip['status'],
  ) => {
    const current = sessionRef.current
    if (!current) return
    const videoClips: SceneVideoClip[] = request.videoPrompts.map((segment) => ({
      ...segment,
      status: status === 'generating' && segment.sequence > 1 ? 'waiting' : status,
    }))
    const applyPatch = (scene: GameScene): GameScene => scene.id === sceneId
      ? { ...scene, videoRequest: request, videoClips }
      : scene
    replaceSession({
      ...current,
      currentScene: current.currentScene ? applyPatch(current.currentScene) : current.currentScene,
      sceneHistory: current.sceneHistory.map(applyPatch),
    })
  }, [replaceSession])

  const updateSceneVideoClip = useCallback((
    sceneId: string,
    sequence: number,
    patch: Partial<Pick<
      SceneVideoClip,
      'status' | 'videoUrl' | 'startImageUrl' | 'tailFrameUrl' | 'error'
    >>,
  ) => {
    const current = sessionRef.current
    if (!current) return
    const applyPatch = (scene: GameScene): GameScene => scene.id === sceneId
      ? {
          ...scene,
          videoClips: scene.videoClips?.map((clip) => clip.sequence === sequence
            ? { ...clip, ...patch }
            : clip),
        }
      : scene
    replaceSession({
      ...current,
      currentScene: current.currentScene ? applyPatch(current.currentScene) : current.currentScene,
      sceneHistory: current.sceneHistory.map(applyPatch),
    })
  }, [replaceSession])

  const resetSceneVideoFrom = useCallback((sceneId: string, startSequence: number, endSequence = Number.POSITIVE_INFINITY) => {
    const current = sessionRef.current
    if (!current) return
    const applyPatch = (scene: GameScene): GameScene => scene.id === sceneId
      ? {
          ...scene,
          videoClips: scene.videoClips?.map((clip) => clip.sequence < startSequence || clip.sequence > endSequence
            ? clip
            : {
                ...clip,
                status: clip.sequence === startSequence ? 'generating' : 'waiting',
                videoUrl: undefined,
                startImageUrl: undefined,
                tailFrameUrl: undefined,
                error: undefined,
              }),
        }
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
    publishTurn,
    getCharacterReferences,
    setSceneVideoPlan,
    updateSceneVideoClip,
    resetSceneVideoFrom,
    getPendingContext,
    restart,
  }
}
