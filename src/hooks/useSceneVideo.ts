import { useCallback, useRef, useState } from 'react'
import { fetchComfyVideo, getComfySegment, submitComfySegment } from '../services/comfyClient'
import { createFalVideoGenerator } from '../services/falVideoGenerator'
import { readVideoTailFrame } from '../services/videoTailFrame'
import { deleteUploadedVideo, saveUploadedVideo } from '../services/uploadedVideoStorage'
import { buildClipPrompt } from '../services/videoReferencePrompt'
import type { GameScene, SceneVideoClip } from '../types/game'
import type { VideoInputReferenceImage } from '../types/video'
import type { useGameSession } from './useGameSession'

type GameController = ReturnType<typeof useGameSession>

type ResumeTurn = (input: { sequence: number; tailFrameDataUrl: string; durationSeconds: number }) => Promise<boolean>

type UseSceneVideoParams = {
  falApiKey: string
  comfyApiKey: string
  videoMode: NonNullable<GameScene['videoMode']>
  game: GameController
  resumeTurn: ResumeTurn
}

const blobToDataUrl = (blob: Blob) => new Promise<string>((resolve, reject) => {
  const reader = new FileReader()
  reader.onload = () => resolve(String(reader.result))
  reader.onerror = () => reject(new Error('无法读取尾帧图片。'))
  reader.readAsDataURL(blob)
})

const COMFY_POLL_INTERVAL_MS = 5_000
const COMFY_POLL_TIMEOUT_MS = 15 * 60_000

// Comfy 任务本身失败（区别于网络/本地服务出错）：任务 ID 作废，重试时要重新提交。
class ComfyJobFailedError extends Error {}

// 首帧/参考图可能是 blob:、fal 地址或 data URL，统一转成 data URL 交给服务端上传到 Comfy。
const toDataUrl = async (url: string) => url.startsWith('data:image/') ? url : urlToDataUrl(url)

// fal 的尾帧是上传后的公开 URL（下一段生成需要可抓取的地址），resume 接口则要求 data:image/ 内联图片，两者都要保留。
const urlToDataUrl = async (url: string) => {
  const response = await fetch(url)
  if (!response.ok) throw new Error('无法读取尾帧图片。')
  return blobToDataUrl(await response.blob())
}

const findClip = (game: GameController, sceneId: string, sequence: number): SceneVideoClip | undefined => {
  const session = game.getSessionSnapshot()
  const scene = session?.currentScene?.id === sceneId ? session.currentScene : undefined
  return scene?.videoClips?.find((clip) => clip.sequence === sequence)
}

export function useSceneVideo({ falApiKey, comfyApiKey, videoMode, game, resumeTurn }: UseSceneVideoParams) {
  const busyRef = useRef(false)
  const [mediaBusy, setMediaBusy] = useState(false)

  // 上传与 Comfy 共用：抽尾帧 → 存本地 → 提交 clip 媒体，返回 resume 所需的尾帧与时长。
  // resume 要在调用方释放 busy 之后再做：续跑中导演会发出下一段的 awaiting_upload，busy 未释放会让自动生成被跳过。
  const storeVideoFile = useCallback(async (sceneId: string, sequence: number, file: File) => {
    const videoUrl = URL.createObjectURL(file)
    const uploadId = crypto.randomUUID()
    let committed = false
    try {
      const previousClip = findClip(game, sceneId, sequence)
      const { frame, duration } = await readVideoTailFrame(videoUrl, 960)
      const tailFrameUrl = await blobToDataUrl(frame)
      await saveUploadedVideo(uploadId, file, tailFrameUrl)
      try {
        await game.commitSegmentMedia(sceneId, sequence, { uploadId, videoUrl, tailFrameUrl, actualDuration: duration })
      } catch (error) {
        await deleteUploadedVideo(uploadId).catch(() => {})
        throw error
      }
      committed = true
      if (previousClip?.uploadId && previousClip.uploadId !== uploadId) {
        void deleteUploadedVideo(previousClip.uploadId).catch(() => {})
        if (previousClip.videoUrl?.startsWith('blob:')) URL.revokeObjectURL(previousClip.videoUrl)
      }
      return { sequence, tailFrameDataUrl: tailFrameUrl, durationSeconds: duration }
    } finally {
      if (!committed) {
        URL.revokeObjectURL(videoUrl)
        void deleteUploadedVideo(uploadId).catch(() => {})
      }
    }
  }, [game])

  const uploadSegmentVideo = useCallback(async (sceneId: string, sequence: number, file: File) => {
    if (busyRef.current) throw new Error('请等待当前视频处理完成。')
    const session = game.getSessionSnapshot()
    if (session?.pendingUpload?.sceneId !== sceneId || session.pendingUpload.sequence !== sequence) {
      throw new Error('导演当前不在等待这一段视频，请刷新后重试。')
    }
    if (!file.size || (file.type && !file.type.startsWith('video/'))) throw new Error('请选择可播放的视频文件。')

    busyRef.current = true
    setMediaBusy(true)
    let stored: Awaited<ReturnType<typeof storeVideoFile>>
    try {
      stored = await storeVideoFile(sceneId, sequence, file)
    } finally {
      busyRef.current = false
      setMediaBusy(false)
    }
    // resume 失败时 clip 已被标为 failed（但媒体已保存），可以用 retryPendingSegment 重试，不需要在这里再抛错。
    await resumeTurn(stored)
  }, [game, resumeTurn, storeVideoFile])

  // clip 已有 comfyJobId（刷新前提交过）时只接着查原任务，不重复提交扣费。
  const generateSegmentWithComfy = useCallback(async (sceneId: string, sequence: number) => {
    if (busyRef.current || !comfyApiKey) return
    const session = game.getSessionSnapshot()
    if (session?.pendingUpload?.sceneId !== sceneId || session.pendingUpload.sequence !== sequence) return
    const clip = findClip(game, sceneId, sequence)
    if (!clip) return

    busyRef.current = true
    setMediaBusy(true)
    game.updateSceneVideoClip(sceneId, sequence, { status: 'generating', error: undefined })
    let stored: Awaited<ReturnType<typeof storeVideoFile>> | undefined
    try {
      let jobId = clip.comfyJobId
      if (!jobId) {
        const startImage = clip.startImageUrl ? await toDataUrl(clip.startImageUrl) : undefined
        const referenceImages = startImage ? [] : await Promise.all((clip.referenceImages ?? [])
          .filter((reference) => reference.type === 'character' && reference.imageUrl)
          .map((reference) => toDataUrl(reference.imageUrl!)))
        const submitted = await submitComfySegment(comfyApiKey, {
          prompt: buildClipPrompt(clip),
          seconds: clip.endTime - clip.startTime,
          ...(startImage ? { startImage } : {}),
          ...(referenceImages.length ? { referenceImages } : {}),
        })
        jobId = submitted.jobId
        game.updateSceneVideoClip(sceneId, sequence, { comfyJobId: jobId })
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
      const file = new File([blob], `comfy-${sequence}.mp4`, { type: blob.type || 'video/mp4' })
      stored = await storeVideoFile(sceneId, sequence, file)
    } catch (error) {
      if (error instanceof ComfyJobFailedError) game.updateSceneVideoClip(sceneId, sequence, { comfyJobId: undefined })
      game.failSegment(sceneId, sequence, error instanceof Error ? error.message : 'Comfy 视频生成失败。')
    } finally {
      busyRef.current = false
      setMediaBusy(false)
    }
    if (stored) await resumeTurn(stored)
  }, [comfyApiKey, game, resumeTurn, storeVideoFile])

  const generateSegmentWithFal = useCallback(async (sceneId: string, sequence: number) => {
    if (busyRef.current || !falApiKey) return
    const session = game.getSessionSnapshot()
    if (session?.pendingUpload?.sceneId !== sceneId || session.pendingUpload.sequence !== sequence) return
    const clip = findClip(game, sceneId, sequence)
    if (!clip) return

    busyRef.current = true
    setMediaBusy(true)
    game.updateSceneVideoClip(sceneId, sequence, { status: 'generating', error: undefined })
    let resume: Parameters<ResumeTurn>[0] | undefined
    try {
      const characterReferences = (clip.referenceImages ?? [])
        .filter((reference): reference is VideoInputReferenceImage & { type: 'character' } => reference.type === 'character')
        .map((reference) => ({
          characterName: reference.label.replace('人物参考 · ', ''),
          actorId: reference.actorId ?? '',
          imageUrl: reference.imageUrl ?? '',
        }))
      const generator = createFalVideoGenerator(falApiKey)
      const result = await generator.generate(clip.prompt, clip.endTime - clip.startTime, sequence, {
        startImageUrl: clip.startImageUrl,
        characterReferences,
      })
      const tailFrameUrl = await generator.createTailFrameUrl(result.videoUrl)
      const tailFrameDataUrl = await urlToDataUrl(tailFrameUrl)
      const actualDuration = clip.endTime - clip.startTime
      await game.commitSegmentMedia(sceneId, sequence, { videoUrl: result.videoUrl, tailFrameUrl, actualDuration })
      resume = { sequence, tailFrameDataUrl, durationSeconds: actualDuration }
    } catch (error) {
      game.failSegment(sceneId, sequence, error instanceof Error ? error.message : '视频生成失败。')
    } finally {
      busyRef.current = false
      setMediaBusy(false)
    }
    // 释放 busy 后再续跑，导演续跑中发出的下一段 awaiting_upload 才能触发自动生成。
    if (resume) await resumeTurn(resume)
  }, [falApiKey, game, resumeTurn])

  const retryPendingSegment = useCallback(async (sceneId: string) => {
    if (busyRef.current) return
    const session = game.getSessionSnapshot()
    const pendingUpload = session?.pendingUpload
    if (!pendingUpload || pendingUpload.sceneId !== sceneId) return
    const clip = findClip(game, sceneId, pendingUpload.sequence)
    if (!clip) return

    if (clip.tailFrameUrl && clip.actualDuration !== undefined) {
      busyRef.current = true
      setMediaBusy(true)
      let tailFrameDataUrl: string | undefined
      try {
        tailFrameDataUrl = clip.tailFrameUrl.startsWith('data:image/')
          ? clip.tailFrameUrl
          : await urlToDataUrl(clip.tailFrameUrl)
      } catch (error) {
        game.failSegment(sceneId, pendingUpload.sequence, error instanceof Error ? error.message : '重试失败。')
      } finally {
        busyRef.current = false
        setMediaBusy(false)
      }
      if (tailFrameDataUrl) await resumeTurn({ sequence: pendingUpload.sequence, tailFrameDataUrl, durationSeconds: clip.actualDuration })
      return
    }

    if (videoMode === 'auto') await generateSegmentWithFal(sceneId, pendingUpload.sequence)
    if (videoMode === 'comfy') await generateSegmentWithComfy(sceneId, pendingUpload.sequence)
    // manual 模式没有已保存的视频：clip 保持 failed，提示玩家重新选择文件上传即可。
  }, [game, generateSegmentWithComfy, generateSegmentWithFal, resumeTurn, videoMode])

  return { uploadSegmentVideo, generateSegmentWithFal, generateSegmentWithComfy, retryPendingSegment, mediaBusy }
}
