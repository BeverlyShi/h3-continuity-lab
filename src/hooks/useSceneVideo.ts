import { useCallback, useRef } from 'react'
import { createFalVideoGenerator } from '../services/falVideoGenerator'
import type { GameScene } from '../types/game'
import type { VideoGenerationRequest } from '../types/story'

type SceneVideoPatch = {
  videoStatus: GameScene['videoStatus']
  videoUrl?: string
  videoError?: string
  videoRequest?: VideoGenerationRequest
}

type UseSceneVideoParams = {
  apiKey: string
  onVideoUpdate: (sceneId: string, patch: SceneVideoPatch) => void
}

const durationForVideoRequest = (duration: number) => (duration <= 7 ? 5 : 10)

export function useSceneVideo({ apiKey, onVideoUpdate }: UseSceneVideoParams) {
  const submittedScenes = useRef(new Set<string>())

  const submitSceneVideo = useCallback((sceneId: string, request: VideoGenerationRequest) => {
    if (!apiKey) return
    if (submittedScenes.current.has(sceneId)) return
    submittedScenes.current.add(sceneId)

    onVideoUpdate(sceneId, { videoStatus: 'generating', videoRequest: request })

    createFalVideoGenerator(apiKey)
      .generate(request.prompt, durationForVideoRequest(request.duration), 0)
      .then((result) => {
        onVideoUpdate(sceneId, { videoStatus: 'ready', videoUrl: result.videoUrl })
      })
      .catch((error: unknown) => {
        console.warn('场景视频生成失败：', error)
        const detail = error instanceof Error && error.message ? error.message : ''
        const body = (error as { body?: { detail?: unknown } } | null)?.body?.detail
        const bodyDetail = body ? JSON.stringify(body) : ''
        onVideoUpdate(sceneId, {
          videoStatus: 'failed',
          videoError: [detail, bodyDetail].filter(Boolean).join(' · ') || '未知错误',
        })
      })
  }, [apiKey, onVideoUpdate])

  const retrySceneVideo = useCallback((sceneId: string, request: VideoGenerationRequest) => {
    submittedScenes.current.delete(sceneId)
    submitSceneVideo(sceneId, request)
  }, [submitSceneVideo])

  return { submitSceneVideo, retrySceneVideo }
}
