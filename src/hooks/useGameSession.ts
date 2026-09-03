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
import type { SceneCastingResult } from '../types/actor'
import { buildCharacterReferences } from '../services/casting'

const now = () => Date.now()

const toTurnContext = (session: GameSession): DirectorTurnContext | null => session.pendingInput
  ? {
      ok: true,
      sessionId: session.id,
      turn: session.turn,
      input: session.pendingInput,
      previousVisualState: session.currentScene?.tailVisualState,
    }
  : null

const makeNewSession = (): GameSession => {
  const createdAt = now()
  return {
    schemaVersion: 8,
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

  const publishTurn = useCallback((published: ScenePublish) => {
    const current = sessionRef.current
    if (!current || current.status !== 'awaiting_agent' || !current.pendingInput) return null
    const charactersById = new Map(current.characters.map((character) => [character.id, character]))
    published.characters.forEach((character) => charactersById.set(character.id, character))
    const characters = [...charactersById.values()]
    const scene = {
      ...published.scene,
      id: crypto.randomUUID(),
      turn: current.turn,
      characterIds: published.characters.map((character) => character.id),
      castingStatus: 'selecting' as const,
    }
    const previousTailFrameUrl = current.currentScene?.tailFrameUrl
    replaceSession({
      ...current,
      status: 'awaiting_media',
      turn: current.turn + 1,
      updatedAt: now(),
      currentScene: scene,
      sceneHistory: [...current.sceneHistory, scene],
      characters,
      castings: current.castings,
      pendingInput: undefined,
    })
    return {
      sceneId: scene.id,
      previousTailFrameUrl,
    }
  }, [replaceSession])

  const applySceneCasting = useCallback((
    sceneId: string,
    result: SceneCastingResult,
    actors: Actor[],
  ) => {
    const current = sessionRef.current
    if (!current) return null
    const castingsByCharacterId = new Map(
      current.castings.map((casting) => [casting.characterId, casting]),
    )
    result.castings.forEach((casting) => castingsByCharacterId.set(casting.characterId, casting))
    const castings = [...castingsByCharacterId.values()]
    const applyPatch = (scene: GameScene): GameScene => scene.id === sceneId
      ? {
          ...scene,
          castingStatus: result.unmatchedCharacterIds.length ? 'partial' : 'ready',
          castings: result.castings,
          unmatchedCharacterIds: result.unmatchedCharacterIds,
          castingError: undefined,
        }
      : scene
    replaceSession({
      ...current,
      castings,
      currentScene: current.currentScene ? applyPatch(current.currentScene) : current.currentScene,
      sceneHistory: current.sceneHistory.map(applyPatch),
    })
    return {
      characterReferences: buildCharacterReferences(current.characters, actors, castings),
    }
  }, [replaceSession])

  const setSceneCastingError = useCallback((sceneId: string, message: string) => {
    const current = sessionRef.current
    if (!current) return
    const applyPatch = (scene: GameScene): GameScene => scene.id === sceneId
      ? { ...scene, castingStatus: 'failed', castingError: message }
      : scene
    replaceSession({
      ...current,
      currentScene: current.currentScene ? applyPatch(current.currentScene) : current.currentScene,
      sceneHistory: current.sceneHistory.map(applyPatch),
    })
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
    const nextStatus = status === 'skipped' && current.currentScene?.id === sceneId
      ? 'awaiting_action'
      : current.status
    replaceSession({
      ...current,
      status: nextStatus,
      currentScene: current.currentScene ? applyPatch(current.currentScene) : current.currentScene,
      sceneHistory: current.sceneHistory.map(applyPatch),
    })
  }, [replaceSession])

  const completeTailFrameAnalysis = useCallback((
    sceneId: string,
    tailFrameUrl: string,
    state?: GameScene['tailVisualState'],
    error?: string,
  ) => {
    const current = sessionRef.current
    if (!current) return
    const applyPatch = (scene: GameScene): GameScene => scene.id === sceneId
      ? {
          ...scene,
          tailFrameUrl,
          tailVisualState: state,
          visualAnalysisError: error,
        }
      : scene
    replaceSession({
      ...current,
      status: current.currentScene?.id === sceneId ? 'awaiting_action' : current.status,
      currentScene: current.currentScene ? applyPatch(current.currentScene) : current.currentScene,
      sceneHistory: current.sceneHistory.map(applyPatch),
      updatedAt: now(),
    })
  }, [replaceSession])

  const releaseSceneChoices = useCallback((sceneId: string, error?: string) => {
    const current = sessionRef.current
    if (!current || current.currentScene?.id !== sceneId) return
    const applyPatch = (scene: GameScene): GameScene => scene.id === sceneId
      ? { ...scene, visualAnalysisError: error }
      : scene
    replaceSession({
      ...current,
      status: 'awaiting_action',
      currentScene: applyPatch(current.currentScene),
      sceneHistory: current.sceneHistory.map(applyPatch),
      updatedAt: now(),
    })
  }, [replaceSession])

  const updateSceneVideoClip = useCallback((
    sceneId: string,
    sequence: number,
    patch: Partial<Pick<
      SceneVideoClip,
      'status' | 'videoUrl' | 'startImageUrl' | 'referenceImages' | 'tailFrameUrl' | 'error'
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
                referenceImages: undefined,
                tailFrameUrl: undefined,
                error: undefined,
              }),
        }
      : scene
    replaceSession({
      ...current,
      status: current.currentScene?.id === sceneId ? 'awaiting_media' : current.status,
      currentScene: current.currentScene ? applyPatch(current.currentScene) : current.currentScene,
      sceneHistory: current.sceneHistory.map(applyPatch),
    })
  }, [replaceSession])

  const getPendingContext = useCallback(() => {
    const current = sessionRef.current
    return current ? toTurnContext(current) : null
  }, [])

  const getCastings = useCallback(() => [...(sessionRef.current?.castings ?? [])], [])

  const restart = useCallback(() => replaceSession(null), [replaceSession])

  return {
    session,
    startStory,
    submitChoice,
    submitFreeform,
    publishTurn,
    applySceneCasting,
    setSceneCastingError,
    getCharacterReferences,
    setSceneVideoPlan,
    updateSceneVideoClip,
    completeTailFrameAnalysis,
    releaseSceneChoices,
    resetSceneVideoFrom,
    getPendingContext,
    getCastings,
    restart,
  }
}
