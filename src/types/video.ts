export type VideoClipStatus =
  | 'queued'
  | 'generating'
  | 'ready'
  | 'playing'
  | 'completed'
  | 'failed'

export const VIDEO_DURATION = 5

export type VideoClip = {
  id: string
  prompt: string
  duration: number
  retryCount?: number
  status: VideoClipStatus
  videoUrl?: string
  thumbnailUrl?: string
  error?: string
}

export type VideoProject = {
  id: string
  name: string
  clips: VideoClip[]
  createdAt: number
  updatedAt: number
}

export type GeneratedVideo = {
  videoUrl: string
  thumbnailUrl?: string
}

export type VideoCharacterReference = {
  characterName: string
  actorId: string
  imageUrl: string
}

export type VideoGenerationConditioning = {
  startImageUrl?: string
  characterReferences?: VideoCharacterReference[]
}

// character 参考图只持久化 actorId，imageUrl 在运行时按演员库解析。
export type VideoInputReferenceImage = {
  type: 'start_frame' | 'character'
  imageUrl?: string
  label: string
  actorId?: string
}

export interface VideoGenerator {
  generate(
    prompt: string,
    duration: number,
    sequence: number,
    conditioning?: VideoGenerationConditioning,
  ): Promise<GeneratedVideo>
  createTailFrameUrl(videoUrl: string): Promise<string>
}
