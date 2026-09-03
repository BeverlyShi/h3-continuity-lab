import { useCallback, useRef } from 'react'
import { createFalVideoGenerator } from '../services/falVideoGenerator'
import { generateSceneVideoSegments } from '../services/sceneVideoGenerator'
import type { GameScene, SceneVideoClip } from '../types/game'
import type { VideoGenerationRequest } from '../types/story'
import type { SceneCharacter, TailFrameVisualState } from '../types/story'
import type { VideoCharacterReference } from '../types/video'
import { inspectTailFrame } from '../services/tailFrameVision'

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
      'status' | 'videoUrl' | 'startImageUrl' | 'referenceImages' | 'tailFrameUrl' | 'error'
    >>,
  ) => void
  onVideoRetry: (sceneId: string, startSequence: number, endSequence?: number) => void
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
  onTailFrameAnalyzed,
}: UseSceneVideoParams) {
  const submittedScenes = useRef(new Set<string>())

  const runGeneration = useCallback((
    sceneId: string,
    request: VideoGenerationRequest,
    startSequence = 1,
    initialTailFrameUrl?: string,
    endSequence?: number,
    characterReferences: Record<string, VideoCharacterReference> = {},
    characters: SceneCharacter[] = [],
  ) => {
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
    )
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
    const blockedIndex = clips.findIndex((clip) => clip.status === 'failed' || clip.status === 'skipped')
    let startIndex = blockedIndex >= 0 ? blockedIndex : 0
    while (startIndex > 0 && !clips[startIndex - 1].tailFrameUrl) {
      startIndex -= 1
    }
    const startSequence = clips[startIndex].sequence
    const initialTailFrameUrl = startIndex > 0 ? clips[startIndex - 1].tailFrameUrl : undefined
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

  return { submitSceneVideo, retrySceneVideo }
}
