import { useCallback, useRef, useState } from 'react'
import { fetchComfyVideo, getComfySegment, submitComfySegment } from '../services/comfyClient'
import { blobToDataUrl, toImageDataUrl } from '../services/dataUrl'
import { createFalVideoGenerator } from '../services/falVideoGenerator'
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
  actors: Actor[]
}

const COMFY_POLL_INTERVAL_MS = 5_000
const COMFY_POLL_TIMEOUT_MS = 15 * 60_000

// Comfy 任务本身失败（区别于网络/本地服务出错）：任务 ID 作废，重试时要重新提交。
class ComfyJobFailedError extends Error {}

const findClip = (game: GameController, sceneId: string, sequence: number): SceneVideoClip | undefined => {
  const session = game.getSessionSnapshot()
  const scene = session?.sceneHistory.find((item) => item.id === sceneId)
  return scene?.videoClips?.find((clip) => clip.sequence === sequence)
}

export function useSceneVideo({ falApiKey, comfyApiKey, videoMode, autoGenerate, game, actors }: UseSceneVideoParams) {
  const busyRef = useRef(false)
  const [mediaBusy, setMediaBusy] = useState(false)
  // 自动生成时新分镜到达可能还有上一段在生成：记下场次，等手上的任务结束后接着生成。
  const queuedSceneRef = useRef<string | null>(null)

  const setBusy = useCallback((busy: boolean) => {
    busyRef.current = busy
    setMediaBusy(busy)
  }, [])

  const findActor = useCallback((actorId: string) => actors.find((actor) => actor.id === actorId), [actors])

  // 演员参考图按演员库实时解析：玩家在演员库补上参考图后，再生成就会用上。
  const resolveClipReferences = useCallback((sceneId: string, clip: SceneVideoClip) => {
    const scene = game.getSessionSnapshot()?.sceneHistory.find((item) => item.id === sceneId)
    return resolveReferenceDescriptors(clip.referenceDescriptors ?? [], {
      characterReferences: game.getCharacterReferences(actors),
      currentClips: scene?.videoClips ?? [],
      previousSceneTailFrameUrl: game.getPreviousSceneTailFrameUrl(sceneId),
    })
  }, [actors, game])

  // Comfy 生成后存视频：抽尾帧 → 存本地 → 提交该段媒体。
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

  // clip 已有 comfyJobId（刷新前提交过或上次超时）时只接着查原任务，不重复提交扣费。
  const runComfy = useCallback(async (sceneId: string, clip: SceneVideoClip) => {
    let jobId = clip.comfyJobId
    if (!jobId) {
      const input = buildClipGenerationInput(clip.prompt, clip.referenceImages ?? [], findActor)
      const referenceImages = await Promise.all(input.images.map((image) => toImageDataUrl(image.imageUrl)))
      const submitted = await submitComfySegment(comfyApiKey, {
        prompt: input.prompt,
        seconds: clip.endTime - clip.startTime,
        ...(referenceImages.length ? { referenceImages } : {}),
      })
      jobId = submitted.jobId
      game.setClipComfyJob(sceneId, clip.sequence, jobId)
    }

    const deadline = Date.now() + COMFY_POLL_TIMEOUT_MS
    for (;;) {
      const state = await getComfySegment(comfyApiKey, jobId)
      if (state.status === 'completed') break
      if (state.status === 'failed') throw new ComfyJobFailedError(state.error)
      // 超时不作废任务 ID：任务可能还在排队，重试时继续查同一个任务，不重复扣费。
      if (Date.now() > deadline) throw new Error('Comfy 生成超过 15 分钟仍未完成，点重试会继续等待同一个任务。')
      await new Promise((resolve) => setTimeout(resolve, COMFY_POLL_INTERVAL_MS))
    }

    const blob = await fetchComfyVideo(comfyApiKey, jobId)
    const file = new File([blob], `comfy-${clip.sequence}.mp4`, { type: blob.type || 'video/mp4' })
    await storeVideoFile(sceneId, clip.sequence, file)
  }, [comfyApiKey, findActor, game, storeVideoFile])

  const runFal = useCallback(async (sceneId: string, clip: SceneVideoClip) => {
    const input = buildClipGenerationInput(clip.prompt, clip.referenceImages ?? [], findActor)
    const generator = createFalVideoGenerator(falApiKey)
    const result = await generator.generate(input.prompt, clip.endTime - clip.startTime, clip.sequence, {
      referenceImageUrls: input.images.map((image) => image.imageUrl),
    })
    const tailFrameUrl = await generator.createTailFrameUrl(result.videoUrl)
    await game.commitClipMedia(sceneId, clip.sequence, {
      videoUrl: result.videoUrl,
      tailFrameUrl,
      actualDuration: clip.endTime - clip.startTime,
    })
  }, [falApiKey, findActor, game])

  // 生成单段：成功返回 true；auto 走 fal，comfy 走 Comfy Cloud。
  const generateClip = useCallback(async (sceneId: string, sequence: number) => {
    if (busyRef.current) return false
    const mode = videoMode === 'auto' ? (falApiKey ? 'fal' : null) : (comfyApiKey ? 'comfy' : null)
    const existing = findClip(game, sceneId, sequence)
    if (!mode || !existing || existing.status === 'waiting' || existing.status === 'generating') return false

    setBusy(true)
    try {
      game.markClipGenerating(sceneId, sequence, resolveClipReferences(sceneId, existing))
      const clip = findClip(game, sceneId, sequence)
      if (!clip) return false
      if (mode === 'fal') await runFal(sceneId, clip)
      else await runComfy(sceneId, clip)
      return true
    } catch (error) {
      const fallback = mode === 'fal' ? '视频生成失败。' : 'Comfy 视频生成失败。'
      game.failClip(sceneId, sequence, error instanceof Error ? error.message : fallback, {
        dropComfyJob: error instanceof ComfyJobFailedError,
      })
      return false
    } finally {
      setBusy(false)
    }
  }, [comfyApiKey, falApiKey, game, resolveClipReferences, runComfy, runFal, setBusy, videoMode])

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
