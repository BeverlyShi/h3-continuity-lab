export type VideoCharacterReference = {
  characterName: string
  actorId: string
  // 没有即演员参考图待生成，按 appearance 文字描述。
  imageUrl?: string
}

// character：label 是人物姓名，参考图只持久化 actorId，imageUrl 在运行时按演员库解析。
// start_frame：上一段或上一场次的最后一帧，作为画面参考图排在人物图之后。
export type VideoInputReferenceImage = {
  type: 'start_frame' | 'character'
  imageUrl?: string
  label: string
  actorId?: string
}
