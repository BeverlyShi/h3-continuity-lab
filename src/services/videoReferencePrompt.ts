import type { SceneVideoClip } from '../types/game.ts'
import type { VideoInputReferenceImage } from '../types/video.ts'

export const buildVideoReferencePrompt = (prompt: string, references: VideoInputReferenceImage[]) => {
  if (!references.length) return prompt
  const firstShot = /^\d+–\d+秒：[^\n]*/m
  if (references[0].type === 'start_frame') {
    const instruction = '本镜头以图1为起始画面，保持图中人物外观和起始构图。'
    return firstShot.test(prompt)
      ? prompt.replace(firstShot, (shot) => `${shot}${instruction}`)
      : `${instruction}\n\n${prompt}`
  }
  const characterText = references.map((reference, index) =>
    `${reference.label.replace('人物参考 · ', '')}外观与图${index + 1}一致。`,
  ).join('')
  const shotIndex = prompt.search(firstShot)
  return shotIndex >= 0
    ? `${prompt.slice(0, shotIndex)}${characterText}\n\n${prompt.slice(shotIndex)}`
    : `${characterText}\n\n${prompt}`
}

export const buildClipPrompt = (clip: SceneVideoClip) =>
  buildVideoReferencePrompt(clip.prompt, clip.referenceImages ?? [])
