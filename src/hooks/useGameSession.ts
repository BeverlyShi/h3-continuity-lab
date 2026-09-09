import { useCallback, useEffect, useRef, useState } from 'react'
import { clearGameSession, loadGameSession, saveGameSession } from '../services/gameStorage'
import { palaceStory } from '../stories/palace'
import type { DirectorTurnStateResponse } from '../services/directorClient'
import {
  addWrittenSegment as addWrittenSegmentReducer,
  adoptServerTurnState as adoptServerTurnStateReducer,
  commitSegmentMedia as commitSegmentMediaReducer,
  completeSegment as completeSegmentReducer,
  failSegment as failSegmentReducer,
  finishTurn as finishTurnReducer,
  markAwaitingUpload as markAwaitingUploadReducer,
  setSceneVideoPlan as setSceneVideoPlanReducer,
  setSceneVisualState as setSceneVisualStateReducer,
  type CommitSegmentMediaInput,
  type CompleteSegmentInput,
  type MarkAwaitingUploadInput,
  type ResolveReferenceContext,
  type ResolvedSegmentReferences,
} from '../services/sessionSegments'
import type { DirectorTurnContext, GameScene, GameSession, SceneVideoClip } from '../types/game'
import type {
  ScenePublish,
  StoryChoice,
  StoryInput,
  TailFrameVisualState,
  VideoGenerationRequest,
  VideoPromptSegment,
  VideoReferenceDescriptor,
} from '../types/story'
import type { Actor } from '../types/actor'
import type { SceneCastingResult } from '../types/actor'
import { buildCharacterReferences } from '../services/casting'
import { deleteUploadedVideo, loadUploadedVideo } from '../services/uploadedVideoStorage'

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
    schemaVersion: 9,
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
        const interrupted = clip.status === 'generating' || clip.status === 'analyzing'
        return {
          ...clip,
          videoUrl: saved?.videoUrl,
          status: !saved?.asset || interrupted ? 'failed' : clip.status,
          error: !saved?.asset ? '本地视频无法读取，请重新上传。'
            : interrupted ? '处理已中断，请重试。' : clip.error,
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
    replaceSession({
      ...current,
      status: 'awaiting_agent',
      turn: current.turn + 1,
      updatedAt: now(),
      currentScene: scene,
      sceneHistory: [...current.sceneHistory, scene],
      characters,
      castings: current.castings,
      pendingInput: undefined,
    })
    return { sceneId: scene.id }
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

  const getPreviousSceneTailFrameUrl = useCallback((sceneId: string) => {
    const history = sessionRef.current?.sceneHistory ?? []
    const index = history.findIndex((scene) => scene.id === sceneId)
    return index > 0 ? history[index - 1].tailFrameUrl : undefined
  }, [])

  const getSessionSnapshot = useCallback(() => sessionRef.current, [])

  // 通用的 clip 字段补丁，用于 fal 生成过程中的过渡状态（如 'generating'），不经过纯函数 reducer。
  const updateSceneVideoClip = useCallback((
    sceneId: string,
    sequence: number,
    patch: Partial<SceneVideoClip>,
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

  const addWrittenSegment = useCallback((
    sceneId: string,
    segment: VideoPromptSegment,
    descriptors: VideoReferenceDescriptor[],
    references: ResolvedSegmentReferences,
  ) => {
    const current = sessionRef.current
    if (!current) return
    replaceSession(addWrittenSegmentReducer(current, sceneId, segment, descriptors, references))
  }, [replaceSession])

  const markAwaitingUpload = useCallback((sceneId: string, input: MarkAwaitingUploadInput) => {
    const current = sessionRef.current
    if (!current) return
    replaceSession(markAwaitingUploadReducer(current, sceneId, input))
  }, [replaceSession])

  const commitSegmentMedia = useCallback((sceneId: string, sequence: number, input: CommitSegmentMediaInput) => {
    const current = sessionRef.current
    if (!current) return Promise.resolve()
    // 上传成功一定要落盘：失败要抛错，让调用方回滚刚保存的本地视频。
    return replaceSession(commitSegmentMediaReducer(current, sceneId, sequence, input), true)
  }, [replaceSession])

  const failSegment = useCallback((sceneId: string, sequence: number, error: string) => {
    const current = sessionRef.current
    if (!current) return
    replaceSession(failSegmentReducer(current, sceneId, sequence, error))
  }, [replaceSession])

  const completeSegment = useCallback((sceneId: string, sequence: number, input: CompleteSegmentInput) => {
    const current = sessionRef.current
    if (!current) return
    replaceSession(completeSegmentReducer(current, sceneId, sequence, input))
  }, [replaceSession])

  const setSceneVideoPlan = useCallback((sceneId: string, video: VideoGenerationRequest) => {
    const current = sessionRef.current
    if (!current) return
    replaceSession(setSceneVideoPlanReducer(current, sceneId, video))
  }, [replaceSession])

  const setSceneVisualState = useCallback((sceneId: string, visualState: TailFrameVisualState) => {
    const current = sessionRef.current
    if (!current) return
    replaceSession(setSceneVisualStateReducer(current, sceneId, visualState))
  }, [replaceSession])

  const finishTurn = useCallback((sceneId: string, skippedReason?: string) => {
    const current = sessionRef.current
    if (!current) return
    replaceSession(finishTurnReducer(current, sceneId, skippedReason))
  }, [replaceSession])

  const adoptServerTurnState = useCallback((
    serverState: DirectorTurnStateResponse,
    references: Omit<ResolveReferenceContext, 'currentClips'>,
  ) => {
    const current = sessionRef.current
    if (!current) return { needsRetry: false }
    const result = adoptServerTurnStateReducer(current, serverState, references)
    if (result.session !== current) replaceSession(result.session)
    return { needsRetry: result.needsRetry }
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
    getPreviousSceneTailFrameUrl,
    getSessionSnapshot,
    updateSceneVideoClip,
    addWrittenSegment,
    markAwaitingUpload,
    commitSegmentMedia,
    failSegment,
    completeSegment,
    setSceneVideoPlan,
    setSceneVisualState,
    finishTurn,
    adoptServerTurnState,
    getPendingContext,
    getCastings,
    restart,
  }
}
