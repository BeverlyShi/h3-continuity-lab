import { useCallback, useRef, useState } from 'react'
import { blobToDataUrl, toImageDataUrl } from '../services/dataUrl'
import { getBackendForJob, getBackendForMode, JobFailedError } from '../services/generationBackend'
import { resolveReferenceDescriptors } from '../services/sessionSegments'
import { readVideoTailFrame } from '../services/videoTailFrame'
import { deleteUploadedVideo, saveUploadedVideo } from '../services/uploadedVideoStorage'
import { buildClipGenerationInput } from '../services/videoReferencePrompt'
import type { Actor } from '../types/actor'
import type { GameScene, SceneVideoClip } from '../types/game'
import type { useGameSession } from './useGameSession'

type GameController = ReturnType<typeof useGameSession>

type UseSceneVideoParams = {
  falApiKey: string
  comfyApiKey: string
  videoMode: NonNullable<GameScene['videoMode']>
  // 新分镜到达时是否自动整场生成：auto 恒为 true，comfy 取玩家的「自动生成」开关。
  autoGenerate: boolean
  game: GameController
  getActors: () => Actor[]
  // 提交前等这些演员的参考图生成结束：图出来了这一段就用图，失败则按文字外观生成。
  preparePortraits: (actorIds: Iterable<string>) => Promise<void>
}

const POLL_INTERVAL_MS = 5_000
const POLL_TIMEOUT_MS = 15 * 60_000

const findClip = (game: GameController, sceneId: string, sequence: number): SceneVideoClip | undefined => {
  const session = game.getSessionSnapshot()
  const scene = session?.sceneHistory.find((item) => item.id === sceneId)
  return scene?.videoClips?.find((clip) => clip.sequence === sequence)
}

export function useSceneVideo({ falApiKey, comfyApiKey, videoMode, autoGenerate, game, getActors, preparePortraits }: UseSceneVideoParams) {
  const busyRef = useRef(false)
  const [mediaBusy, setMediaBusy] = useState(false)
  // 自动生成时新分镜到达可能还有上一段在生成：记下场次，等手上的任务结束后接着生成。
  const queuedSceneRef = useRef<string | null>(null)

  const setBusy = useCallback((busy: boolean) => {
    busyRef.current = busy
    setMediaBusy(busy)
  }, [])

  const findActor = useCallback((actorId: string) => getActors().find((actor) => actor.id === actorId), [getActors])

  // 演员参考图按演员库实时解析：参考图生成好或玩家在演员库补上后，再生成就会用上。
  const resolveClipReferences = useCallback((sceneId: string, clip: SceneVideoClip) => {
    const scene = game.getSessionSnapshot()?.sceneHistory.find((item) => item.id === sceneId)
    return resolveReferenceDescriptors(clip.referenceDescriptors ?? [], {
      characterReferences: game.getCharacterReferences(getActors()),
      currentClips: scene?.videoClips ?? [],
      previousSceneTailFrameUrl: game.getPreviousSceneTailFrameUrl(sceneId),
    })
  }, [game, getActors])

  // 生成完成后存视频：抽尾帧 → 存本地 → 提交该段媒体。
  const storeVideoFile = useCallback(async (sceneId: string, sequence: number, file: File) => {
    const videoUrl = URL.createObjectURL(file)
    const uploadId = crypto.randomUUID()
    let committed = false
    try {
      const { frame, duration } = await readVideoTailFrame(videoUrl, 960)
      const tailFrameUrl = await blobToDataUrl(frame)
      await saveUploadedVideo(uploadId, file, tailFrameUrl)
      await game.commitClipMedia(sceneId, sequence, { uploadId, videoUrl, tailFrameUrl, actualDuration: duration })
      committed = true
    } finally {
      if (!committed) {
        URL.revokeObjectURL(videoUrl)
        void deleteUploadedVideo(uploadId).catch(() => {})
      }
    }
  }, [game])

  // clip 已有 jobId（刷新前提交过或上次超时）时按前缀找回原后端接着查，不重复提交扣费；没有才按当前模式提交。
  const runClip = useCallback(async (sceneId: string, clip: SceneVideoClip) => {
    const keys = { falApiKey, comfyApiKey }
    const backend = clip.jobId ? getBackendForJob(clip.jobId, keys) : getBackendForMode(videoMode, keys)
    if (!backend) throw new Error('未配置当前视频模式的 API Key，请先在设置里配置。')
    let jobId = clip.jobId
    if (!jobId) {
      const input = buildClipGenerationInput(clip.prompt, clip.referenceImages ?? [], findActor)
      const referenceImages = await Promise.all(input.images.map((image) => toImageDataUrl(image.imageUrl)))
      jobId = await backend.submitVideo({ prompt: input.prompt, seconds: clip.endTime - clip.startTime, referenceImages })
      game.setClipJob(sceneId, clip.sequence, jobId)
    }

    const deadline = Date.now() + POLL_TIMEOUT_MS
    for (;;) {
      const state = await backend.getStatus(jobId)
      if (state.status === 'completed') break
      if (state.status === 'failed') throw new JobFailedError(state.error ?? '视频生成失败。')
      // 超时不作废任务 ID：任务可能还在排队，重试时继续查同一个任务，不重复扣费。
      if (Date.now() > deadline) throw new Error('视频生成超过 15 分钟仍未完成，点重试会继续等待同一个任务。')
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
    }

    const blob = await backend.fetchResult(jobId, 'video')
    const file = new File([blob], `clip-${clip.sequence}.mp4`, { type: blob.type || 'video/mp4' })
    await storeVideoFile(sceneId, clip.sequence, file)
  }, [comfyApiKey, falApiKey, findActor, game, storeVideoFile, videoMode])

  // 生成单段：成功返回 true；新提交时 auto 走 fal，comfy 走 Comfy Cloud。
  const generateClip = useCallback(async (sceneId: string, sequence: number) => {
    if (busyRef.current) return false
    const existing = findClip(game, sceneId, sequence)
    if (!existing || existing.status === 'waiting' || existing.status === 'generating') return false
    // 已提交过的段按任务前缀续查，当前模式的 key 没配也要能查。
    if (!existing.jobId && !getBackendForMode(videoMode, { falApiKey, comfyApiKey })) return false

    setBusy(true)
    try {
      await preparePortraits((existing.referenceDescriptors ?? []).flatMap((descriptor) =>
        descriptor.type === 'character' ? [descriptor.actorId] : []))
      game.markClipGenerating(sceneId, sequence, resolveClipReferences(sceneId, existing))
      const clip = findClip(game, sceneId, sequence)
      if (!clip) return false
      await runClip(sceneId, clip)
      return true
    } catch (error) {
      game.failClip(sceneId, sequence, error instanceof Error ? error.message : '视频生成失败。', {
        dropJob: error instanceof JobFailedError,
      })
      return false
    } finally {
      setBusy(false)
    }
  }, [comfyApiKey, falApiKey, game, resolveClipReferences, runClip, setBusy, videoMode, preparePortraits])

  // 整场生成：从第一个未就绪的段开始依次生成，遇到失败、玩家跳过或场次变化就停。
  const generateScene = useCallback(async (sceneId: string) => {
    if (busyRef.current) {
      if (autoGenerate) queuedSceneRef.current = sceneId
      return
    }
    let target: string | null = sceneId
    while (target) {
      for (;;) {
        const session = game.getSessionSnapshot()
        if (session?.currentScene?.id !== target || session.status !== 'awaiting_video') break
        const clip = [...(session.currentScene.videoClips ?? [])]
          .sort((left, right) => left.sequence - right.sequence)
          .find((item) => item.status !== 'ready')
        if (!clip || clip.status === 'waiting') break
        if (!await generateClip(target, clip.sequence)) break
      }
      const queued: string | null = queuedSceneRef.current
      queuedSceneRef.current = null
      target = queued !== target ? queued : null
    }
  }, [autoGenerate, game, generateClip])

  return { generateClip, generateScene, mediaBusy }
}
