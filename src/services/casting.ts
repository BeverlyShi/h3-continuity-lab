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
    // 参考图待生成的演员也列出：生成时按 appearance 文字描述，补上参考图后改用图。
    const reference: VideoCharacterReference = {
      characterName: character.name,
      actorId: actor.id,
      ...(actor.referenceImageUrl ? { imageUrl: actor.referenceImageUrl } : {}),
    }
    return [[character.id, reference]]
  }))
}
