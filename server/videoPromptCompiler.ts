import type { VideoGenerationRequest, VideoPromptSegment } from '../src/types/story.ts'

export const compileVideoPrompt = (
  segment: VideoPromptSegment,
  request: VideoGenerationRequest,
) => `${request.style.trim()}\n\n${segment.prompt.trim()}无音乐，无旁白。`

export const compileVideoPlan = (request: VideoGenerationRequest): VideoGenerationRequest => ({
  ...request,
  videoPrompts: request.videoPrompts.map((segment) => ({
    ...segment,
    prompt: compileVideoPrompt(segment, request),
  })),
})
