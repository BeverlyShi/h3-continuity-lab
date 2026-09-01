export type ActorGender = 'female' | 'male'

export type Actor = {
  id: string
  name: string
  gender: ActorGender
  minAge: number
  maxAge: number
  referenceImageUrl: string
  createdAt: number
}

export type ActorDraft = Omit<Actor, 'id' | 'createdAt'>

export type CharacterCasting = {
  characterId: string
  actorId: string
}
