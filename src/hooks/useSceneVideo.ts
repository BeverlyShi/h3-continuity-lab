import { useCallback, useRef, useState } from 'react'
import { createFalVideoGenerator } from '../services/falVideoGenerator'
import { generateSceneVideoSegments } from '../services/sceneVideoGenerator'
import type { GameScene, SceneVideoClip } from '../types/game'
import type { VideoGenerationRequest } from '../types/story'
import type { SceneCharacter, TailFrameVisualState } from '../types/story'
import type { VideoCharacterReference } from '../types/video'
import { inspectTailFrame } from '../services/tailFrameVision'
import { readVideoTailFrame } from '../services/videoTailFrame'
import { deleteUploadedVideo, saveUploadedVideo } from '../services/uploadedVideoStorage'

type UseSceneVideoParams = {
  apiKey: string
  deepSeekApiKey: string
  onVideoPlan: (
    sceneId: string,
    request: VideoGenerationRequest,
    status: SceneVideoClip['status'],
  ) => void
  onVideoClipUpdate: (
    sceneId: string,
    sequence: number,
    patch: Partial<Pick<
      SceneVideoClip,
      'status' | 'videoUrl' | 'startImageUrl' | 'referenceImages' | 'tailFrameUrl' | 'error' | 'uploadId' | 'actualDuration'
    >>,
  ) => void
  onVideoRetry: (sceneId: string, startSequence: number, endSequence?: number) => void
  onManualUploadComplete: (
    sceneId: string,
    sequence: number,
    clip: Required<Pick<SceneVideoClip, 'uploadId' | 'videoUrl' | 'tailFrameUrl' | 'actualDuration'>>,
  ) => boolean
  onTailFrameAnalyzed: (
    sceneId: string,
    tailFrameUrl: string,
    state?: TailFrameVisualState,
    error?: string,
  ) => void
}

export function useSceneVideo({
  apiKey,
  deepSeekApiKey,
  onVideoPlan,
  onVideoClipUpdate,
  onVideoRetry,
  onManualUploadComplete,
  onTailFrameAnalyzed,
}: UseSceneVideoParams) {
  const submittedScenes = useRef(new Set<string>())
  const manualBusyRef = useRef(false)
  const [manualBusy, setManualBusy] = useState(false)
  const [autoBusy, setAutoBusy] = useState(false)

  const analyzeUploadedTail = useCallback(async (sceneId: string, sequence: number, tailFrameUrl: string, characters: SceneCharacter[]) => {
    onVideoClipUpdate(sceneId, sequence, { status: 'analyzing', error: undefined })
    try {
      if (!deepSeekApiKey) throw new Error('尾帧视觉识别需要 DeepSeek API Key；视频已保存，设置后可重试识别。')
      const state = await inspectTailFrame(deepSeekApiKey, tailFrameUrl, characters)
      onVideoClipUpdate(sceneId, sequence, { status: 'ready', error: undefined })
      onTailFrameAnalyzed(sceneId, tailFrameUrl, state)
    } catch (error) {
      const message = error instanceof Error ? error.message : '尾帧识别失败'
      onVideoClipUpdate(sceneId, sequence, { status: 'ready', error: message })
      onTailFrameAnalyzed(sceneId, tailFrameUrl, undefined, message)
    }
  }, [deepSeekApiKey, onTailFrameAnalyzed, onVideoClipUpdate])

  const uploadSceneVideo = useCallback(async (scene: GameScene, sequence: number, file: File, characters: SceneCharacter[]) => {
    if (manualBusyRef.current) throw new Error('请等待当前视频处理完成。')
    const clip = scene.videoClips?.find((item) => item.sequence === sequence)
    if (!clip || (sequence > 1 && !clip.startImageUrl)) throw new Error('请先上传上一片段并完成尾帧提取。')
    if (!file.size || (file.type && !file.type.startsWith('video/'))) throw new Error('请选择可播放的视频文件。')
    manualBusyRef.current = true
    setManualBusy(true)
    const videoUrl = URL.createObjectURL(file)
    const uploadId = crypto.randomUUID()
    let committed = false
    try {
      const { frame, duration } = await readVideoTailFrame(videoUrl, 960)
      const tailFrameUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(String(reader.result))
        reader.onerror = () => reject(new Error('无法读取视频尾帧'))
        reader.readAsDataURL(frame)
      })
      await saveUploadedVideo(uploadId, file, tailFrameUrl)
      if (!onManualUploadComplete(scene.id, sequence, {
        uploadId, videoUrl, actualDuration: duration, tailFrameUrl,
      })) throw new Error('当前幕次已变化，请返回当前幕上传。')
      committed = true
      for (const old of scene.videoClips ?? []) {
        if (old.sequence < sequence) continue
        if (old.uploadId) void deleteUploadedVideo(old.uploadId).catch(() => {})
        if (old.videoUrl?.startsWith('blob:')) URL.revokeObjectURL(old.videoUrl)
      }
      const finalSequence = Math.max(...(scene.videoClips ?? []).map((item) => item.sequence))
      if (sequence === finalSequence) await analyzeUploadedTail(scene.id, sequence, tailFrameUrl, characters)
    } finally {
      if (!committed) {
        URL.revokeObjectURL(videoUrl)
        void deleteUploadedVideo(uploadId).catch(() => {})
      }
      manualBusyRef.current = false
      setManualBusy(false)
    }
  }, [analyzeUploadedTail, onManualUploadComplete])

  const retryUploadedTail = useCallback(async (scene: GameScene, characters: SceneCharacter[]) => {
    const last = [...(scene.videoClips ?? [])].sort((a, b) => a.sequence - b.sequence).at(-1)
    if (!last?.tailFrameUrl || manualBusyRef.current) return
    manualBusyRef.current = true
    setManualBusy(true)
    try { await analyzeUploadedTail(scene.id, last.sequence, last.tailFrameUrl, characters) }
    finally { manualBusyRef.current = false; setManualBusy(false) }
  }, [analyzeUploadedTail])

  const runGeneration = useCallback((
    sceneId: string,
    request: VideoGenerationRequest,
    startSequence = 1,
    initialTailFrameUrl?: string,
    endSequence?: number,
    characterReferences: Record<string, VideoCharacterReference> = {},
    characters: SceneCharacter[] = [],
  ) => {
    setAutoBusy(true)
    void generateSceneVideoSegments(
      createFalVideoGenerator(apiKey),
      request,
      (result) => {
        onVideoClipUpdate(sceneId, result.sequence, {
          status: result.status,
          videoUrl: result.videoUrl,
          startImageUrl: result.startImageUrl,
          referenceImages: result.referenceImages,
          tailFrameUrl: result.tailFrameUrl,
          error: result.status === 'failed' ? result.error : undefined,
        })
        if (result.visualState && result.tailFrameUrl) {
          onTailFrameAnalyzed(sceneId, result.tailFrameUrl, result.visualState)
        } else if (result.status === 'failed' && result.tailFrameUrl) {
          onTailFrameAnalyzed(sceneId, result.tailFrameUrl, undefined, result.error)
        }
      },
      {
        startSequence,
        endSequence,
        initialTailFrameUrl,
        characterReferences,
        analyzeTailFrame: (imageUrl) => {
          if (!deepSeekApiKey) throw new Error('尾帧视觉识别需要 DEEPSEEK_API_KEY。')
          return inspectTailFrame(deepSeekApiKey, imageUrl, characters)
        },
      },
    ).finally(() => setAutoBusy(false))
  }, [apiKey, deepSeekApiKey, onTailFrameAnalyzed, onVideoClipUpdate])

  const submitSceneVideo = useCallback((
    sceneId: string,
    request: VideoGenerationRequest,
    characterReferences: Record<string, VideoCharacterReference>,
    characters: SceneCharacter[],
    previousTailFrameUrl?: string,
  ) => {
    if (!apiKey) return
    if (submittedScenes.current.has(sceneId)) return
    submittedScenes.current.add(sceneId)

    onVideoPlan(sceneId, request, 'generating')
    runGeneration(
      sceneId,
      request,
      1,
      previousTailFrameUrl,
      undefined,
      characterReferences,
      characters,
    )
  }, [apiKey, onVideoPlan, runGeneration])

  const retrySceneVideo = useCallback((
    scene: GameScene,
    characterReferences: Record<string, VideoCharacterReference>,
    characters: SceneCharacter[],
  ) => {
    if (!scene.videoRequest || !scene.videoClips?.length || !apiKey) return
    const clips = [...scene.videoClips].sort((left, right) => left.sequence - right.sequence)
    const blockedIndex = clips.findIndex((clip) => clip.status !== 'ready')
    let startIndex = blockedIndex >= 0 ? blockedIndex : 0
    while (startIndex > 0 && !clips[startIndex - 1].tailFrameUrl) {
      startIndex -= 1
    }
    const startSequence = clips[startIndex].sequence
    const initialTailFrameUrl = startIndex > 0 ? clips[startIndex - 1].tailFrameUrl : clips[0].startImageUrl
    const endSequence = clips.at(-1)?.sequence

    submittedScenes.current.add(scene.id)
    onVideoRetry(scene.id, startSequence, endSequence)
    runGeneration(
      scene.id,
      scene.videoRequest,
      startSequence,
      initialTailFrameUrl,
      endSequence,
      characterReferences,
      characters,
    )
  }, [apiKey, onVideoRetry, runGeneration])

  return { submitSceneVideo, retrySceneVideo, uploadSceneVideo, retryUploadedTail, manualBusy, autoBusy }
}
