import type { AgentTool } from '@earendil-works/pi-agent-core/node'
import { Type, type Static } from 'typebox'
import type { CastableActor, CharacterCasting, SceneCastingResult } from '../src/types/actor.ts'
import type { SceneCharacter } from '../src/types/story.ts'

const MAX_SEARCH_RESULTS = 8

// 本局的选角账本：绑定表由程序持有，跨回合沿用，模型只对新人物做决定。
export type CastingBook = {
  actors: CastableActor[]
  bindings: Map<string, string>
  // 本幕已经显式决定“不给参考图”的人物。
  declined: Set<string>
}

export const createCastingBook = (actors: CastableActor[], existing: CharacterCasting[]): CastingBook => {
  const actorIds = new Set(actors.map((actor) => actor.id))
  return {
    actors,
    bindings: new Map(existing.filter((casting) => actorIds.has(casting.actorId)).map((casting) => [casting.characterId, casting.actorId])),
    declined: new Set(),
  }
}

const actorLabel = (actor: CastableActor) => `${actor.name}（${actor.id}，${actor.gender === 'female' ? '女' : '男'}，${actor.minAge}–${actor.maxAge} 岁）`

const rangesOverlap = (
  left: { minAge: number; maxAge: number },
  right: { minAge: number; maxAge: number },
) => left.minAge <= right.maxAge && left.maxAge >= right.minAge

export const pendingCastingCharacters = (book: CastingBook, characters: SceneCharacter[]) =>
  characters.filter((character) => !book.bindings.has(character.id) && !book.declined.has(character.id))

export const isCastingComplete = (book: CastingBook, characters: SceneCharacter[]) =>
  pendingCastingCharacters(book, characters).length === 0

export const resolveSceneCasting = (book: CastingBook, characters: SceneCharacter[]): SceneCastingResult => {
  const castings = characters.flatMap((character) => {
    const actorId = book.bindings.get(character.id)
    return actorId ? [{ characterId: character.id, actorId }] : []
  })
  return {
    castings,
    unmatchedCharacterIds: characters
      .filter((character) => !book.bindings.has(character.id))
      .map((character) => character.id),
  }
}

// 演员库为空时没有可挑的对象，直接把待选角人物记为无参考图，省去一次无意义的 cast_scene。
export const describeCastingStatus = (book: CastingBook, characters: SceneCharacter[]) => {
  if (!book.actors.length) {
    for (const character of pendingCastingCharacters(book, characters)) book.declined.add(character.id)
  }
  const actorsById = new Map(book.actors.map((actor) => [actor.id, actor]))
  const reused = characters.flatMap((character) => {
    const actorId = book.bindings.get(character.id)
    const actor = actorId ? actorsById.get(actorId) : undefined
    return actor ? [`${character.name} → ${actor.name}`] : []
  })
  const pending = pendingCastingCharacters(book, characters)
  const lines: string[] = []
  if (reused.length) lines.push(`沿用已有选角：${reused.join('；')}。`)
  if (pending.length) {
    lines.push(`待选角人物：${pending.map((character) => `${character.name}（${character.id}）`).join('、')}。请先用 search_actors 查看候选演员，再用 cast_scene 为每个待选角人物指定演员或设为 null。`)
  } else if (book.actors.length) {
    lines.push('本幕人物均已有选角决定，无需调用 cast_scene。')
  } else {
    lines.push('演员库为空，本幕人物均无参考图；无需调用 cast_scene。')
  }
  return lines.join('\n')
}

export const searchActorsSchema = Type.Object({
  gender: Type.Optional(Type.Union([Type.Literal('female'), Type.Literal('male')])),
  minAge: Type.Optional(Type.Integer({ minimum: 0, maximum: 100 })),
  maxAge: Type.Optional(Type.Integer({ minimum: 0, maximum: 100 })),
  keywords: Type.Optional(Type.String({ maxLength: 100, description: '按演员姓名或描述做包含匹配的关键词。' })),
}, { additionalProperties: false })

export type SearchActorsInput = Static<typeof searchActorsSchema>

export type SearchActorsResult = {
  actors: Array<CastableActor & { usedBy?: string }>
}

export const createSearchActorsTool = (
  book: CastingBook,
  getCharacters: () => SceneCharacter[],
): AgentTool<typeof searchActorsSchema, SearchActorsResult> => ({
  name: 'search_actors',
  label: '查询候选演员',
  description: `按性别和年龄区间查询演员库，返回最多 ${MAX_SEARCH_RESULTS} 个候选，并标注已经扮演过哪个角色。为待选角人物挑选演员前先调用；结果为空时可放宽条件，或在 cast_scene 中把该人物设为 null。`,
  parameters: searchActorsSchema,
  executionMode: 'parallel',
  execute: async (_toolCallId, input) => {
    if (input.minAge !== undefined && input.maxAge !== undefined && input.minAge > input.maxAge) {
      throw new Error('minAge 不能大于 maxAge。')
    }
    const characterNames = new Map(getCharacters().map((character) => [character.id, character.name]))
    const usedBy = new Map<string, string>()
    for (const [characterId, actorId] of book.bindings) {
      usedBy.set(actorId, characterNames.get(characterId) ?? characterId)
    }
    const keyword = input.keywords?.trim().toLowerCase()
    const matches = book.actors
      .filter((actor) => !input.gender || actor.gender === input.gender)
      .filter((actor) => rangesOverlap(
        { minAge: input.minAge ?? 0, maxAge: input.maxAge ?? 100 },
        actor,
      ))
      .filter((actor) => !keyword || actor.name.toLowerCase().includes(keyword))
      .sort((left, right) => Number(usedBy.has(left.id)) - Number(usedBy.has(right.id)))
      .slice(0, MAX_SEARCH_RESULTS)
      .map((actor) => ({ ...actor, ...(usedBy.has(actor.id) ? { usedBy: usedBy.get(actor.id) } : {}) }))
    const text = matches.length
      ? `找到 ${matches.length} 位候选演员：\n${matches.map((actor) =>
        `- ${actorLabel(actor)}${actor.usedBy ? `，已扮演：${actor.usedBy}` : ''}`).join('\n')}\n请用 cast_scene 提交决定；同一幕两个人物不能使用同一演员。`
      : '没有符合条件的演员。可放宽性别或年龄条件再查，或在 cast_scene 中把该人物的 actorId 设为 null。'
    return {
      content: [{ type: 'text', text }],
      details: { actors: matches },
      terminate: false,
    }
  },
})

export const castSceneSchema = Type.Object({
  assignments: Type.Array(Type.Object({
    characterId: Type.String({ minLength: 1, maxLength: 50 }),
    actorId: Type.Union([Type.String({ minLength: 1, maxLength: 100 }), Type.Null()], { description: '选定的演员 ID；null 表示该人物不使用参考图。' }),
    reason: Type.String({ minLength: 1, maxLength: 200, description: '选择或放弃该演员的理由。' }),
    recast: Type.Optional(Type.Boolean({ description: '仅在确需更换已绑定演员时设为 true。' })),
  }, { additionalProperties: false }), { maxItems: 8 }),
}, { additionalProperties: false })

export type CastSceneInput = Static<typeof castSceneSchema>

export const createCastSceneTool = (
  book: CastingBook,
  getCharacters: () => SceneCharacter[],
  onCast?: (result: SceneCastingResult) => void | Promise<void>,
): AgentTool<typeof castSceneSchema, SceneCastingResult> => ({
  name: 'cast_scene',
  label: '为场景选择演员',
  description: '为本幕待选角人物提交演员决定：每项包含 characterId、actorId（或 null）和 reason。已绑定的老角色由程序沿用，不必重复提交；要更换必须设置 recast: true。提交后本幕所有人物都必须有选角决定。',
  parameters: castSceneSchema,
  executionMode: 'sequential',
  execute: async (_toolCallId, input) => {
    const characters = getCharacters()
    if (!characters.length) throw new Error('必须先通过 publish_scene 发布本幕人物。')
    const charactersById = new Map(characters.map((character) => [character.id, character]))
    const actorsById = new Map(book.actors.map((actor) => [actor.id, actor]))
    const issues: string[] = []
    const warnings: string[] = []
    const nextBindings = new Map(book.bindings)
    const nextDeclined = new Set(book.declined)
    const seenCharacterIds = new Set<string>()

    for (const assignment of input.assignments) {
      const character = charactersById.get(assignment.characterId)
      if (!character) {
        issues.push(`人物 ${assignment.characterId} 不在本幕 characters 中`)
        continue
      }
      if (seenCharacterIds.has(character.id)) {
        issues.push(`人物 ${character.name} 被重复提交`)
        continue
      }
      seenCharacterIds.add(character.id)
      const existingActorId = book.bindings.get(character.id)
      if (existingActorId && existingActorId !== assignment.actorId && !assignment.recast) {
        issues.push(`人物 ${character.name} 已绑定演员 ${actorsById.get(existingActorId)?.name ?? existingActorId}，不能更换；确需更换请设置 recast: true 并说明理由`)
        continue
      }
      if (assignment.actorId === null) {
        nextBindings.delete(character.id)
        nextDeclined.add(character.id)
        continue
      }
      const actor = actorsById.get(assignment.actorId)
      if (!actor) {
        issues.push(`演员 ${assignment.actorId} 不存在，请先用 search_actors 查询`)
        continue
      }
      if (actor.gender !== character.gender) {
        issues.push(`演员 ${actor.name} 的性别与人物 ${character.name} 不符`)
        continue
      }
      if (!rangesOverlap(character, actor)) {
        warnings.push(`演员 ${actor.name}（${actor.minAge}–${actor.maxAge} 岁）与人物 ${character.name}（${character.minAge}–${character.maxAge} 岁）年龄区间不重叠`)
      }
      nextBindings.set(character.id, actor.id)
      nextDeclined.delete(character.id)
    }

    const actorUsage = new Map<string, string[]>()
    for (const character of characters) {
      const actorId = nextBindings.get(character.id)
      if (!actorId) continue
      actorUsage.set(actorId, [...(actorUsage.get(actorId) ?? []), character.name])
    }
    for (const [actorId, names] of actorUsage) {
      if (names.length > 1) issues.push(`演员 ${actorsById.get(actorId)?.name ?? actorId} 同时分配给了 ${names.join('、')}，同一幕不能撞脸`)
    }
    const undecided = characters.filter((character) => !nextBindings.has(character.id) && !nextDeclined.has(character.id))
    if (undecided.length) {
      issues.push(`以下人物尚未做出选角决定：${undecided.map((character) => `${character.name}（${character.id}）`).join('、')}；请指定演员或设为 null`)
    }
    if (issues.length) throw new Error(`选角未通过：\n- ${issues.join('\n- ')}`)

    book.bindings.clear()
    for (const [characterId, actorId] of nextBindings) book.bindings.set(characterId, actorId)
    book.declined.clear()
    for (const characterId of nextDeclined) book.declined.add(characterId)

    const result = resolveSceneCasting(book, characters)
    await onCast?.(result)
    const table = characters.map((character) => {
      const actorId = book.bindings.get(character.id)
      const actor = actorId ? actorsById.get(actorId) : undefined
      return `- ${character.name}：${actor ? `${actor.name}，有参考图` : '无参考图'}`
    })
    const text = [
      '选角已确定：',
      ...table,
      ...(warnings.length ? [`提示：${warnings.join('；')}。`] : []),
      '下一步：调用 write_video_prompt 编写分镜；首段只为有参考图的人物附图。',
    ].join('\n')
    return {
      content: [{ type: 'text', text }],
      details: result,
      terminate: false,
    }
  },
})
