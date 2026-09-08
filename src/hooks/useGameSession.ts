import { useCallback, useEffect, useRef, useState } from 'react'
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
import { applyManualClip, invalidateManualClipsFrom, prepareManualScene } from '../services/manualSceneVideo'
import { deleteUploadedVideo, loadUploadedVideo } from '../services/uploadedVideoStorage'
import { ALLOW_CHOICE_BEFORE_MEDIA } from '../config/debugFlags'

const now = () => Date.now()

const uploadIds = (session: GameSession | null) => [...new Set((session?.sceneHistory ?? []).flatMap((scene) =>
  (scene.videoClips ?? []).flatMap((clip) => clip.uploadId ? [clip.uploadId] : [])))]

const toTurnContext = (session: GameSession): DirectorTurnContext | null => session.pendingInput
  ? {
      ok: true,
      sessionId: session.id,
      turn: session.turn,
      input: session.pendingInput,
      previousVisualState: session.currentScene?.tailVisualState,
      hasPreviousTailFrame: Boolean(session.currentScene?.tailFrameUrl),
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
  const [session, setSession] = useState<GameSession | null>(null)
  const sessionRef = useRef<GameSession | null>(null)
  const [loading, setLoading] = useState(true)
  const [storageError, setStorageError] = useState('')
  const [storageNotice, setStorageNotice] = useState('')
  const [restoringVideos, setRestoringVideos] = useState(false)
  // 保存串行执行，避免并发写入把旧会话覆盖回 localStorage。
  const saveQueue = useRef<Promise<unknown>>(Promise.resolve())
  const objectUrls = useRef<string[]>([])

  const persistSession = useCallback((next: GameSession | null) => {
    const task = saveQueue.current
      .catch(() => {})
      .then(() => next
        ? saveGameSession(next)
        : clearGameSession().then(() => ({ degraded: false, droppedScenes: 0 })))
    saveQueue.current = task.catch(() => {})
    return task.then((result) => {
      setStorageError('')
      setStorageNotice(result.degraded
        ? `本地空间紧张，已释放最早 ${result.droppedScenes} 幕的图片。`
        : '')
    }, (error: unknown) => {
      setStorageError(error instanceof Error ? error.message : '无法保存当前场景。')
      throw error
    })
  }, [])

  const replaceSession = useCallback((next: GameSession | null, requirePersistence = false) => {
    const apply = () => {
      sessionRef.current = next
      setSession(next)
    }
    if (requirePersistence) return persistSession(next).then(apply)
    apply()
    return persistSession(next).catch(() => {})
  }, [persistSession])

  const retrySaveSession = useCallback(() => replaceSession(sessionRef.current), [replaceSession])

  const restoreUploadedVideos = useCallback(async () => {
    const stored = sessionRef.current
    const ids = uploadIds(stored)
    if (!stored || !ids.length) return
    const results = await Promise.allSettled(ids.map((id) => loadUploadedVideo(id)))
    if (sessionRef.current?.id !== stored.id) return
    const assets = new Map(results.map((result, index) => {
      const asset = result.status === 'fulfilled' ? result.value : undefined
      const videoUrl = asset ? URL.createObjectURL(asset.file) : undefined
      if (videoUrl) objectUrls.current.push(videoUrl)
      return [ids[index], { asset, videoUrl }]
    }))
    const current: GameSession = JSON.parse(JSON.stringify(sessionRef.current), (_key, value) =>
      typeof value === 'string' && value.startsWith('upload-tail:')
        ? assets.get(value.slice('upload-tail:'.length))?.asset?.tailFrameUrl : value)
    const patch = (item: GameScene): GameScene => ({
      ...item,
      videoClips: item.videoClips?.map((clip) => {
        if (!clip.uploadId) return clip
        const saved = assets.get(clip.uploadId)
        const interrupted = ['extracting', 'analyzing'].includes(clip.status)
        return {
          ...clip,
          videoUrl: saved?.videoUrl,
          status: !saved?.asset || interrupted ? 'failed' : clip.status,
          error: !saved?.asset ? '本地视频无法读取，请重新上传。'
            : interrupted ? '处理已中断，请重试尾帧识别或重新上传。' : clip.error,
        }
      }),
    })
    void replaceSession({ ...current, currentScene: current.currentScene ? patch(current.currentScene) : undefined, sceneHistory: current.sceneHistory.map(patch) })
    setRestoringVideos(false)
  }, [replaceSession])

  const boot = async () => {
    const stored = await loadGameSession()
    sessionRef.current = stored
    setSession(stored)
    setLoading(false)
    if (uploadIds(stored).length) setRestoringVideos(true)
  }

  // 首次渲染就开始读存档，图片改由 IndexedDB 异步取回。
  const booted = useRef<Promise<void> | null>(null)
  booted.current ??= boot().catch(() => {
    setLoading(false)
    setRestoringVideos(false)
  })

  useEffect(() => {
    let cancelled = false
    void booted.current?.then(() => cancelled ? undefined : restoreUploadedVideos())
    return () => {
      cancelled = true
      objectUrls.current.forEach((url) => URL.revokeObjectURL(url))
      objectUrls.current = []
    }
  }, [restoreUploadedVideos])

  const startStory = useCallback(() => {
    if (sessionRef.current) return null
    const next = makeNewSession()
    replaceSession(next)
    return toTurnContext(next)
  }, [replaceSession])

  const queueInput = useCallback((input: StoryInput) => {
    const current = sessionRef.current
    if (!current) return null
    const canAct = current.status === 'awaiting_action'
      || (ALLOW_CHOICE_BEFORE_MEDIA && current.status === 'awaiting_media')
    if (!canAct) return null
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

  const publishTurn = useCallback((published: Pick<ScenePublish, 'scene' | 'characters'>) => {
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
      'status' | 'videoUrl' | 'startImageUrl' | 'referenceImages' | 'tailFrameUrl' | 'error' | 'uploadId' | 'actualDuration'
    >>,
  ) => {
    const current = sessionRef.current
    if (!current) return
    const applyPatch = (scene: GameScene): GameScene => scene.id === sceneId
      ? scene.videoMode === 'manual' ? applyManualClip(scene, sequence, patch) : {
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

  const prepareManualVideo = useCallback((sceneId: string, references: ReturnType<typeof buildCharacterReferences>) => {
    const current = sessionRef.current
    if (!current || current.currentScene?.id !== sceneId || current.status === 'awaiting_agent') return
    const index = current.sceneHistory.findIndex((scene) => scene.id === sceneId)
    const prepared = prepareManualScene(current.currentScene, references, current.sceneHistory[index - 1]?.tailFrameUrl)
    replaceSession({
      ...current,
      status: prepared.videoClips?.every((clip) => clip.status === 'ready') ? 'awaiting_action' : 'awaiting_media',
      currentScene: prepared,
      sceneHistory: current.sceneHistory.map((scene) => scene.id === sceneId ? prepared : scene),
    })
  }, [replaceSession])

  const completeManualUpload = useCallback(async (
    sceneId: string,
    sequence: number,
    clip: Required<Pick<SceneVideoClip, 'uploadId' | 'videoUrl' | 'tailFrameUrl' | 'actualDuration'>>,
  ) => {
    const current = sessionRef.current
    if (!current || current.currentScene?.id !== sceneId || current.status === 'awaiting_agent') return false
    const scene = applyManualClip(invalidateManualClipsFrom(current.currentScene, sequence), sequence, {
      ...clip, status: 'ready', error: undefined,
    })
    await replaceSession({
      ...current,
      status: 'awaiting_media',
      currentScene: scene,
      sceneHistory: current.sceneHistory.map((item) => item.id === sceneId ? scene : item),
    }, true)
    return true
  }, [replaceSession])

  const resetSceneVideoFrom = useCallback((sceneId: string, startSequence: number, endSequence = Number.POSITIVE_INFINITY) => {
    const current = sessionRef.current
    if (!current) return
    const applyPatch = (scene: GameScene): GameScene => scene.id === sceneId
      ? {
          ...scene,
          tailFrameUrl: undefined,
          tailVisualState: undefined,
          visualAnalysisError: undefined,
          videoMode: 'auto',
          videoClips: scene.videoClips?.map((clip) => clip.sequence < startSequence || clip.sequence > endSequence
            ? clip
            : {
                ...clip,
                status: clip.sequence === startSequence ? 'generating' : 'waiting',
                videoUrl: undefined,
                uploadId: undefined,
                actualDuration: undefined,
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

  const restart = useCallback(() => {
    for (const scene of sessionRef.current?.sceneHistory ?? []) {
      for (const clip of scene.videoClips ?? []) {
        if (clip.uploadId) void deleteUploadedVideo(clip.uploadId).catch(() => {})
        if (clip.videoUrl?.startsWith('blob:')) URL.revokeObjectURL(clip.videoUrl)
      }
    }
    void replaceSession(null)
  }, [replaceSession])

  return {
    session,
    loading,
    storageError,
    storageNotice,
    retrySaveSession,
    restoringVideos,
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
    prepareManualVideo,
    completeManualUpload,
    getPendingContext,
    getCastings,
    restart,
  }
}
