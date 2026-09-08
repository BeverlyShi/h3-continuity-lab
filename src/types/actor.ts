export type ActorGender = 'female' | 'male'

export type Actor = {
  id: string
  name: string
  gender: ActorGender
  minAge: number
  maxAge: number
  // 没有参考图即“待生成”：外部生成三视图后再回填。
  referenceImageUrl?: string
  appearance?: string
  imagePrompt?: string
  createdAt: number
}

export type ActorDraft = Omit<Actor, 'id' | 'createdAt'>

export type CharacterCasting = {
  characterId: string
  actorId: string
}

export type CastableActor = Pick<Actor, 'id' | 'name' | 'gender' | 'minAge' | 'maxAge' | 'appearance'> & {
  hasImage: boolean
}

export type CreatedActor = {
  id: string
  name: string
  gender: ActorGender
  minAge: number
  maxAge: number
  appearance: string
  imagePrompt: string
}

export type SceneCastingResult = {
  castings: CharacterCasting[]
  unmatchedCharacterIds: string[]
  createdActors?: CreatedActor[]
}
