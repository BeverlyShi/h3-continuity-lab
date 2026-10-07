import type { VideoGenerationRequest, VideoPromptSegment } from '../types/story.ts'

// 最终 prompt = 场次画面风格 + 分镜正文。人物行（参考图号或外貌描写）由前端在生成时按演员库拼接：参考图可能在分镜写完后才补上。
export const compileVideoPrompt = (segment: VideoPromptSegment, style: string) =>
  [style.trim(), `${segment.prompt.trim()}无音乐，无旁白。`].filter(Boolean).join('\n\n')

export const compileVideoPlan = (request: VideoGenerationRequest): VideoGenerationRequest => ({
  ...request,
  videoPrompts: request.videoPrompts.map((segment) => ({
    ...segment,
    prompt: compileVideoPrompt(segment, request.style),
  })),
})
