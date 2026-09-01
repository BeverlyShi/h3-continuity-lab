import { useCallback, useRef } from 'react'
import { createFalVideoGenerator } from '../services/falVideoGenerator'
import { generateSceneVideoSegments } from '../services/sceneVideoGenerator'
import type { GameScene, SceneVideoClip } from '../types/game'
import type { VideoGenerationRequest } from '../types/story'
import type { VideoCharacterReference } from '../types/video'

type UseSceneVideoParams = {
  apiKey: string
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
      'status' | 'videoUrl' | 'startImageUrl' | 'tailFrameUrl' | 'error'
    >>,
  ) => void
  onVideoRetry: (sceneId: string, startSequence: number, endSequence?: number) => void
}

export function useSceneVideo({
  apiKey,
  onVideoPlan,
  onVideoClipUpdate,
  onVideoRetry,
}: UseSceneVideoParams) {
  const submittedScenes = useRef(new Set<string>())

  const runGeneration = useCallback((
    sceneId: string,
    request: VideoGenerationRequest,
    startSequence = 1,
    initialTailFrameUrl?: string,
    endSequence?: number,
    characterReferences: Record<string, VideoCharacterReference> = {},
  ) => {
    void generateSceneVideoSegments(
      createFalVideoGenerator(apiKey),
      request,
      (result) => {
        onVideoClipUpdate(sceneId, result.sequence, {
          status: result.status,
          videoUrl: result.videoUrl,
          startImageUrl: result.startImageUrl,
          tailFrameUrl: result.tailFrameUrl,
          error: result.status === 'failed' ? result.error : undefined,
        })
      },
      { startSequence, endSequence, initialTailFrameUrl, characterReferences },
    )
  }, [apiKey, onVideoClipUpdate])

  const submitSceneVideo = useCallback((
    sceneId: string,
    request: VideoGenerationRequest,
    characterReferences: Record<string, VideoCharacterReference>,
  ) => {
    if (!apiKey) return
    if (submittedScenes.current.has(sceneId)) return
    submittedScenes.current.add(sceneId)

    onVideoPlan(sceneId, request, 'generating')
    runGeneration(sceneId, request, 1, undefined, undefined, characterReferences)
  }, [apiKey, onVideoPlan, runGeneration])

  const retrySceneVideo = useCallback((
    scene: GameScene,
    characterReferences: Record<string, VideoCharacterReference>,
  ) => {
    if (!scene.videoRequest || !scene.videoClips?.length || !apiKey) return
    const clips = [...scene.videoClips].sort((left, right) => left.sequence - right.sequence)
    const blockedIndex = clips.findIndex((clip) => clip.status === 'failed' || clip.status === 'skipped')
    let startIndex = blockedIndex >= 0 ? blockedIndex : 0
    while (startIndex > 0
      && clips[startIndex].transitionFromPrevious === 'continuous'
      && !clips[startIndex - 1].tailFrameUrl) {
      startIndex -= 1
    }
    const startSequence = clips[startIndex].sequence
    const initialTailFrameUrl = startIndex > 0 ? clips[startIndex - 1].tailFrameUrl : undefined
    const nextCut = clips.slice(startIndex + 1).find((clip) => clip.transitionFromPrevious === 'cut')
    const endSequence = nextCut ? nextCut.sequence - 1 : clips.at(-1)?.sequence

    submittedScenes.current.add(scene.id)
    onVideoRetry(scene.id, startSequence, endSequence)
    runGeneration(
      scene.id,
      scene.videoRequest,
      startSequence,
      initialTailFrameUrl,
      endSequence,
      characterReferences,
    )
  }, [apiKey, onVideoRetry, runGeneration])

  return { submitSceneVideo, retrySceneVideo }
}
