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
  retryCount: number
  status: VideoClipStatus
  videoUrl?: string
  thumbnailUrl?: string
  error?: string
}

export type GeneratedVideo = {
  videoUrl: string
  thumbnailUrl?: string
}

export interface VideoGenerator {
  generate(prompt: string, duration: number, sequence: number): Promise<GeneratedVideo>
}
