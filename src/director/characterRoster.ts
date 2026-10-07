import type { CastableActor, CharacterCasting } from '../types/actor.ts'
import type { SceneCharacter } from '../types/story.ts'

// 每回合随玩家输入附上的人物名册：老人物复用 id 靠查表，不靠模型从压缩过的历史里回忆。
export const CHARACTER_ROSTER_HEADING = '已登场人物名册'

const actorNames = (castings: CharacterCasting[], actors: CastableActor[]) => {
  const namesById = new Map(actors.map((actor) => [actor.id, actor.name]))
  return new Map(castings.flatMap((casting) => {
    const name = namesById.get(casting.actorId)
    return name ? [[casting.characterId, name] as const] : []
  }))
}

export const describeCharacterRoster = (
  characters: SceneCharacter[],
  castings: CharacterCasting[],
  actors: CastableActor[],
): string | undefined => {
  if (!characters.length) return undefined
  const actorByCharacterId = actorNames(castings, actors)
  const lines = characters.map((character) => {
    const actorName = actorByCharacterId.get(character.id)
    const gender = character.gender === 'female' ? '女' : '男'
    return `- ${character.id}｜${character.name}｜${gender} ${character.minAge}–${character.maxAge}｜${actorName ? `演员：${actorName}` : '无演员'}`
  })
  return [
    `${CHARACTER_ROSTER_HEADING}（老人物再次出场必须沿用这里的 id；称谓变了也沿用原 id，只改 name；只有新登场的人物才用新 id）：`,
    ...lines,
  ].join('\n')
}

// 新 id 与名册里已绑定演员的人物同名，多半是老人物换了 id：放过去就会被重新选角、换脸。
// 只查已绑定演员的人物：没有演员的背景人物（宫女、太监等泛称）重名不影响画面。
export const findRosterConflicts = (
  published: SceneCharacter[],
  known: SceneCharacter[],
  castings: CharacterCasting[],
  actors: CastableActor[],
): string[] => {
  const knownIds = new Set(known.map((character) => character.id))
  const actorByCharacterId = actorNames(castings, actors)
  return published.flatMap((character) => {
    if (knownIds.has(character.id)) return []
    const name = character.name.trim()
    const match = known.find((item) => item.name.trim() === name && actorByCharacterId.has(item.id))
    if (!match) return []
    return [`人物「${character.name}」（${character.id}）与名册中的 ${match.id} 同名，${match.id} 由演员 ${actorByCharacterId.get(match.id)} 饰演：是同一人请沿用 id ${match.id}；不是同一人请换一个能区分的称谓`]
  })
}

// 历史场次里的旧名册已经过时，投影时去掉，只留当前回合的那一份。
export const stripCharacterRoster = (text: string) =>
  text.split('\n\n').filter((part) => !part.startsWith(CHARACTER_ROSTER_HEADING)).join('\n\n')
