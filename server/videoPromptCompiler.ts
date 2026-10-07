import type { VideoGenerationRequest, VideoPromptSegment } from '../src/types/story.ts'

export type CharacterAppearance = { name: string; appearance: string }

// 最终 prompt = 场次画面风格 + 本段出场人物外观 + 分镜正文。人物外观由程序按选角拼接，不靠导演每段重抄。
export const compileVideoPrompt = (
  segment: VideoPromptSegment,
  style: string,
  lookupAppearance: (characterId: string) => CharacterAppearance | undefined = () => undefined,
) => {
  const appearances = segment.characterIds.flatMap((characterId) => {
    const found = lookupAppearance(characterId)
    return found?.appearance.trim() ? [`${found.name}——${found.appearance.trim().replace(/[。；;.]+$/, '')}`] : []
  })
  return [
    style.trim(),
    appearances.length ? `人物外观：${appearances.join('；')}。` : '',
    `${segment.prompt.trim()}无音乐，无旁白。`,
  ].filter(Boolean).join('\n\n')
}

export const compileVideoPlan = (
  request: VideoGenerationRequest,
  lookupAppearance?: (characterId: string) => CharacterAppearance | undefined,
): VideoGenerationRequest => ({
  ...request,
  videoPrompts: request.videoPrompts.map((segment) => ({
    ...segment,
    prompt: compileVideoPrompt(segment, request.style, lookupAppearance),
  })),
})
