import { useCallback, useRef, useState } from 'react'
import { createFalVideoGenerator } from '../services/falVideoGenerator'
import { readVideoTailFrame } from '../services/videoTailFrame'
import { deleteUploadedVideo, saveUploadedVideo } from '../services/uploadedVideoStorage'
import type { SceneVideoClip } from '../types/game'
import type { VideoInputReferenceImage } from '../types/video'
import type { useGameSession } from './useGameSession'

type GameController = ReturnType<typeof useGameSession>

type ResumeTurn = (input: { sequence: number; tailFrameDataUrl: string; durationSeconds: number }) => Promise<boolean>

type UseSceneVideoParams = {
  falApiKey: string
  game: GameController
  resumeTurn: ResumeTurn
}

const blobToDataUrl = (blob: Blob) => new Promise<string>((resolve, reject) => {
  const reader = new FileReader()
  reader.onload = () => resolve(String(reader.result))
  reader.onerror = () => reject(new Error('无法读取尾帧图片。'))
  reader.readAsDataURL(blob)
})

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

export function useSceneVideo({ falApiKey, game, resumeTurn }: UseSceneVideoParams) {
  const busyRef = useRef(false)
  const [mediaBusy, setMediaBusy] = useState(false)

  const uploadSegmentVideo = useCallback(async (sceneId: string, sequence: number, file: File) => {
    if (busyRef.current) throw new Error('请等待当前视频处理完成。')
    const session = game.getSessionSnapshot()
    if (session?.pendingUpload?.sceneId !== sceneId || session.pendingUpload.sequence !== sequence) {
      throw new Error('导演当前不在等待这一段视频，请刷新后重试。')
    }
    if (!file.size || (file.type && !file.type.startsWith('video/'))) throw new Error('请选择可播放的视频文件。')

    busyRef.current = true
    setMediaBusy(true)
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
      // resume 失败时 clip 已被标为 failed（但媒体已保存），可以用 retryPendingSegment 重试，不需要在这里再抛错。
      await resumeTurn({ sequence, tailFrameDataUrl: tailFrameUrl, durationSeconds: duration })
    } finally {
      if (!committed) {
        URL.revokeObjectURL(videoUrl)
        void deleteUploadedVideo(uploadId).catch(() => {})
      }
      busyRef.current = false
      setMediaBusy(false)
    }
  }, [game, resumeTurn])

  const generateSegmentWithFal = useCallback(async (sceneId: string, sequence: number) => {
    if (busyRef.current || !falApiKey) return
    const session = game.getSessionSnapshot()
    if (session?.pendingUpload?.sceneId !== sceneId || session.pendingUpload.sequence !== sequence) return
    const clip = findClip(game, sceneId, sequence)
    if (!clip) return

    busyRef.current = true
    setMediaBusy(true)
    game.updateSceneVideoClip(sceneId, sequence, { status: 'generating', error: undefined })
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
      await resumeTurn({ sequence, tailFrameDataUrl, durationSeconds: actualDuration })
    } catch (error) {
      game.failSegment(sceneId, sequence, error instanceof Error ? error.message : '视频生成失败。')
    } finally {
      busyRef.current = false
      setMediaBusy(false)
    }
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
      try {
        const tailFrameDataUrl = clip.tailFrameUrl.startsWith('data:image/')
          ? clip.tailFrameUrl
          : await urlToDataUrl(clip.tailFrameUrl)
        await resumeTurn({ sequence: pendingUpload.sequence, tailFrameDataUrl, durationSeconds: clip.actualDuration })
      } catch (error) {
        game.failSegment(sceneId, pendingUpload.sequence, error instanceof Error ? error.message : '重试失败。')
      } finally {
        busyRef.current = false
        setMediaBusy(false)
      }
      return
    }

    const scene = session?.currentScene?.id === sceneId ? session.currentScene : undefined
    if (scene?.videoMode === 'auto') {
      await generateSegmentWithFal(sceneId, pendingUpload.sequence)
    }
    // manual 模式没有已保存的视频：clip 保持 failed，提示玩家重新选择文件上传即可。
  }, [game, generateSegmentWithFal, resumeTurn])

  return { uploadSegmentVideo, generateSegmentWithFal, retryPendingSegment, mediaBusy }
}
