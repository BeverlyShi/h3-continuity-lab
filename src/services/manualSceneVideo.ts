import type { GameScene, SceneVideoClip } from '../types/game.ts'
import type { VideoCharacterReference, VideoInputReferenceImage } from '../types/video.ts'
import { buildVideoReferencePrompt } from './videoReferencePrompt.ts'

export const prepareManualScene = (
  scene: GameScene,
  characterReferences: Record<string, VideoCharacterReference>,
  previousTailFrameUrl?: string,
): GameScene => {
  const clips = [...(scene.videoClips ?? [])].sort((a, b) => a.sequence - b.sequence)
  return {
    ...scene,
    videoMode: 'manual',
    videoClips: clips.map((clip, index) => {
      if (clip.videoUrl || clip.uploadId) return clip
      const startImageUrl = index === 0 ? previousTailFrameUrl : clips[index - 1].tailFrameUrl
      const referenceImages: VideoInputReferenceImage[] = startImageUrl
        ? [{ type: 'start_frame', imageUrl: startImageUrl, label: '起始尾帧' }]
        : index === 0 ? clip.characterIds.flatMap((id) => {
            const reference = characterReferences[id]
            return reference ? [{ type: 'character' as const, imageUrl: reference.imageUrl, label: `人物参考 · ${reference.characterName}`, actorId: reference.actorId }] : []
          }) : []
      return { ...clip, status: index === 0 || startImageUrl ? 'awaiting_upload' : 'waiting', startImageUrl, referenceImages, error: undefined }
    }),
  }
}

export const invalidateManualClipsFrom = (scene: GameScene, sequence: number): GameScene => ({
  ...scene,
  videoMode: 'manual',
  tailFrameUrl: undefined,
  tailVisualState: undefined,
  visualAnalysisError: undefined,
  videoClips: scene.videoClips?.map((clip): SceneVideoClip => clip.sequence < sequence ? clip : ({
    ...clip,
    status: clip.sequence === sequence ? 'extracting' : 'waiting',
    uploadId: undefined,
    actualDuration: undefined,
    videoUrl: undefined,
    tailFrameUrl: undefined,
    startImageUrl: clip.sequence === sequence ? clip.startImageUrl : undefined,
    referenceImages: clip.sequence === sequence ? clip.referenceImages : [],
    error: undefined,
  })),
})

export const applyManualClip = (scene: GameScene, sequence: number, patch: Partial<SceneVideoClip>): GameScene => ({
  ...scene,
  videoClips: scene.videoClips?.map((clip) => {
    if (clip.sequence === sequence) return { ...clip, ...patch }
    if (clip.sequence === sequence + 1 && patch.tailFrameUrl) {
      return {
        ...clip,
        status: 'awaiting_upload',
        startImageUrl: patch.tailFrameUrl,
        referenceImages: [{ type: 'start_frame', imageUrl: patch.tailFrameUrl, label: '起始尾帧' }],
      }
    }
    return clip
  }),
})

export const buildManualPrompt = (clip: SceneVideoClip) =>
  buildVideoReferencePrompt(clip.prompt, clip.referenceImages ?? [])
