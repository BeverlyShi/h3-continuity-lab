import type { VideoGenerationRequest, VideoPromptSegment } from '../src/types/story.ts'

export const compileVideoPrompt = (
  segment: VideoPromptSegment,
  request: VideoGenerationRequest,
) => [
  request.visualContext.style,
  request.visualContext.scene,
  `${segment.prompt.trim()}无音乐，无旁白。`,
].join('\n\n')

export const compileVideoPlan = (request: VideoGenerationRequest): VideoGenerationRequest => ({
  ...request,
  videoPrompts: request.videoPrompts.map((segment) => ({
    ...segment,
    prompt: compileVideoPrompt(segment, request),
  })),
})
