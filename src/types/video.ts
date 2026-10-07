export type GeneratedVideo = {
  videoUrl: string
  thumbnailUrl?: string
}

export type VideoCharacterReference = {
  characterName: string
  actorId: string
  // 没有即演员参考图待生成，按 appearance 文字描述。
  imageUrl?: string
}

export type VideoGenerationConditioning = {
  // 按 prompt 里的图号顺序传入；有图走参考图生成，没有走文生视频。
  referenceImageUrls?: string[]
}

// character：label 是人物姓名，参考图只持久化 actorId，imageUrl 在运行时按演员库解析。
// start_frame：上一段或上一场次的最后一帧，作为画面参考图排在人物图之后。
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
