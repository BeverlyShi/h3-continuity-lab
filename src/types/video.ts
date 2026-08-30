export type VideoClipStatus =
  | 'queued'
  | 'generating'
  | 'ready'
  | 'playing'
  | 'completed'
  | 'failed'

export const MIN_VIDEO_DURATION = 5
export const MAX_VIDEO_DURATION = 15

export type VideoClip = {
  id: string
  prompt: string
  duration: number
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

export interface VideoGenerator {
  generate(prompt: string, duration: number, sequence: number): Promise<GeneratedVideo>
}
