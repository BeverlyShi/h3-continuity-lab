import type { Actor } from '../types/actor'
import type { VideoInputReferenceImage } from '../types/video'

export type ClipReferenceImage = { imageUrl: string; label: string }

export type ClipGenerationInput = {
  prompt: string
  // 顺序即 prompt 里的图号：本段人物参考图在前，画面参考帧在最后。
  images: ClipReferenceImage[]
  // 已选演员但没有参考图的人物：actorMissing 表示演员已从演员库删除。
  textOnlyCharacters: { name: string; actorMissing: boolean }[]
}

const FIRST_TIME_BLOCK = /^\d+\s*[–—-]\s*\d+\s*秒[：:]/m

// 生成和展示共用：人物有参考图写“人物形象参考图N”并传图，没有就写演员 appearance；参考帧排在最后。
// 参考图按演员库实时解析，玩家补图后再生成就会改用图。
export const buildClipGenerationInput = (
  prompt: string,
  references: VideoInputReferenceImage[],
  findActor: (actorId: string) => Actor | undefined,
): ClipGenerationInput => {
  const images: ClipReferenceImage[] = []
  const castLines: string[] = []
  const textOnlyCharacters: ClipGenerationInput['textOnlyCharacters'] = []

  for (const reference of references) {
    if (reference.type !== 'character') continue
    const name = reference.label.replace('人物参考 · ', '')
    const actor = reference.actorId ? findActor(reference.actorId) : undefined
    const imageUrl = actor?.referenceImageUrl ?? reference.imageUrl
    if (imageUrl) {
      images.push({ imageUrl, label: name })
      castLines.push(`${name}——人物形象参考图${images.length}`)
      continue
    }
    textOnlyCharacters.push({ name, actorMissing: Boolean(reference.actorId) && !actor })
    const appearance = actor?.appearance?.trim().replace(/[。；;.]+$/, '')
    if (appearance) castLines.push(`${name}——${appearance}`)
  }

  const header = castLines.length ? [`人物：${castLines.join('；')}。`] : []
  const frame = references.find((reference) => reference.type === 'start_frame' && reference.imageUrl)
  if (frame) {
    images.push({ imageUrl: frame.imageUrl!, label: frame.label })
    header.push(`画面参考图${images.length}：${frame.label}，本段从这个画面接着拍。`)
  }

  if (!header.length) return { prompt, images, textOnlyCharacters }
  const headerText = header.join('\n')
  const shotIndex = prompt.search(FIRST_TIME_BLOCK)
  return {
    prompt: shotIndex >= 0
      ? `${prompt.slice(0, shotIndex)}${headerText}\n\n${prompt.slice(shotIndex)}`
      : `${headerText}\n\n${prompt}`,
    images,
    textOnlyCharacters,
  }
}
