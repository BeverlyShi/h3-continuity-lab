import type { Actor, CharacterCasting } from '../types/actor.ts'
import type { SceneCharacter } from '../types/story.ts'
import type { VideoCharacterReference } from '../types/video.ts'

export const buildCharacterReferences = (
  characters: SceneCharacter[],
  actors: Actor[],
  castings: CharacterCasting[],
) => {
  const actorsById = new Map(actors.map((actor) => [actor.id, actor]))
  const castingsByCharacterId = new Map(castings.map((casting) => [casting.characterId, casting.actorId]))
  return Object.fromEntries(characters.flatMap((character) => {
    const actorId = castingsByCharacterId.get(character.id)
    const actor = actorId ? actorsById.get(actorId) : undefined
    if (!actor) return []
    const reference: VideoCharacterReference = {
      characterName: character.name,
      imageUrl: actor.referenceImageUrl,
    }
    return [[character.id, reference]]
  }))
}
