import type { Actor, CharacterCasting } from '../types/actor'
import type { SceneCharacter } from '../types/story'
import type { VideoCharacterReference } from '../types/video'

const rangesOverlap = (
  left: Pick<SceneCharacter, 'minAge' | 'maxAge'>,
  right: Pick<Actor, 'minAge' | 'maxAge'>,
) => left.minAge <= right.maxAge && left.maxAge >= right.minAge

export const resolveCharacterCastings = (
  characters: SceneCharacter[],
  actors: Actor[],
  existing: CharacterCasting[],
) => {
  const resolved = [...existing]
  const usedActorIds = new Set(existing.map((casting) => casting.actorId))
  const castCharacterIds = new Set(existing.map((casting) => casting.characterId))

  for (const character of characters) {
    if (castCharacterIds.has(character.id)) continue
    const actor = actors.find((candidate) => candidate.gender === character.gender
      && rangesOverlap(character, candidate)
      && !usedActorIds.has(candidate.id))
    if (!actor) continue
    resolved.push({ characterId: character.id, actorId: actor.id })
    castCharacterIds.add(character.id)
    usedActorIds.add(actor.id)
  }

  return resolved
}

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
