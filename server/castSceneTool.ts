import type { AgentTool } from '@earendil-works/pi-agent-core/node'
import { Type, type Static } from 'typebox'
import type { CastableActor, CharacterCasting, CreatedActor, SceneCastingResult } from '../src/types/actor.ts'
import type { SceneCharacter } from '../src/types/story.ts'
import { buildActorImagePrompt } from './actorPortraitPrompt.ts'

export const MAX_CANDIDATES_PER_CHARACTER = 8

// 本局的选角账本：绑定表由程序持有，跨场次沿用，模型只对新人物做决定。
export type CastingBook = {
  actors: CastableActor[]
  // 本场次新建、等待用户生成参考图的演员。
  createdActors: CreatedActor[]
  bindings: Map<string, string>
  // 本场次已经显式决定“不给参考图”的人物。
  declined: Set<string>
  // 跨场次沿用的绑定：只有这些人物更换演员才需要 recast。
  lockedCharacterIds: Set<string>
  // 本场次有台词的人物：必须有参考图，不能设为 null。
  speakingCharacterIds: Set<string>
}

export const createCastingBook = (
  actors: CastableActor[],
  existing: CharacterCasting[],
  speakingCharacterIds?: Iterable<string>,
): CastingBook => {
  const actorIds = new Set(actors.map((actor) => actor.id))
  const validExisting = existing.filter((casting) => actorIds.has(casting.actorId))
  return {
    actors,
    createdActors: [],
    bindings: new Map(validExisting.map((casting) => [casting.characterId, casting.actorId])),
    declined: new Set(),
    lockedCharacterIds: new Set(validExisting.map((casting) => casting.characterId)),
    speakingCharacterIds: new Set(speakingCharacterIds ?? []),
  }
}

// 场次结束时把账本存进 director_turn_state，重写某段时据此重建一个等价的 CastingBook。
export type CastingBookSnapshot = {
  actors: CastableActor[]
  createdActors: CreatedActor[]
  bindings: Array<[string, string]>
  declined: string[]
  lockedCharacterIds: string[]
  speakingCharacterIds: string[]
}

export const exportCastingBook = (book: CastingBook): CastingBookSnapshot => ({
  actors: book.actors,
  createdActors: book.createdActors,
  bindings: [...book.bindings.entries()],
  declined: [...book.declined],
  lockedCharacterIds: [...book.lockedCharacterIds],
  speakingCharacterIds: [...book.speakingCharacterIds],
})

export const importCastingBook = (snapshot: CastingBookSnapshot): CastingBook => ({
  actors: snapshot.actors,
  createdActors: snapshot.createdActors,
  bindings: new Map(snapshot.bindings),
  declined: new Set(snapshot.declined),
  lockedCharacterIds: new Set(snapshot.lockedCharacterIds),
  speakingCharacterIds: new Set(snapshot.speakingCharacterIds),
})

// 分镜首段附参考图时用：某个人物当前绑定的演员及其是否已有参考图。
export const lookupCastingBookActor = (book: CastingBook, characterId: string) => {
  const actorId = book.bindings.get(characterId)
  if (!actorId) return undefined
  const actor = book.actors.find((candidate) => candidate.id === actorId)
  return actor ? { actorId, hasImage: actor.hasImage } : undefined
}

const actorLabel = (actor: CastableActor) =>
  `${actor.name}（${actor.id}，${actor.minAge}–${actor.maxAge}${actor.appearance ? `，${actor.appearance}` : ''}）`

const rangesOverlap = (
  left: { minAge: number; maxAge: number },
  right: { minAge: number; maxAge: number },
) => left.minAge <= right.maxAge && left.maxAge >= right.minAge

const ageCenter = (range: { minAge: number; maxAge: number }) => (range.minAge + range.maxAge) / 2

export type CastingCandidate = CastableActor & { ageMatch: boolean; usedBy?: string }

const toCastableActor = (actor: CreatedActor): CastableActor => ({
  id: actor.id,
  name: actor.name,
  gender: actor.gender,
  minAge: actor.minAge,
  maxAge: actor.maxAge,
  appearance: actor.appearance,
  hasImage: false,
})

// 为待选角人物列出候选演员：同性别，年龄相符的排在前面，都按年龄区间中心距离升序，最多 8 个。
export const listCastingCandidates = (book: CastingBook, character: SceneCharacter, characters: SceneCharacter[]): CastingCandidate[] => {
  const characterNames = new Map(characters.map((item) => [item.id, item.name]))
  const usedBy = new Map<string, string>()
  for (const [characterId, actorId] of book.bindings) {
    usedBy.set(actorId, characterNames.get(characterId) ?? characterId)
  }
  const sameGender = book.actors.filter((actor) => actor.gender === character.gender)
  const byDistance = (left: CastableActor, right: CastableActor) =>
    Math.abs(ageCenter(left) - ageCenter(character)) - Math.abs(ageCenter(right) - ageCenter(character))
  const matched = sameGender.filter((actor) => rangesOverlap(character, actor)).sort(byDistance)
  const unmatched = sameGender.filter((actor) => !rangesOverlap(character, actor)).sort(byDistance)
  const candidates = [...matched, ...unmatched].slice(0, MAX_CANDIDATES_PER_CHARACTER)
  return candidates.map((actor) => ({
    ...actor,
    ageMatch: rangesOverlap(character, actor),
    ...(usedBy.has(actor.id) ? { usedBy: usedBy.get(actor.id) } : {}),
  }))
}

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
    ...(book.createdActors.length ? { createdActors: book.createdActors } : {}),
  }
}

const candidateLabel = (candidate: CastingCandidate) =>
  `${actorLabel(candidate)}${candidate.hasImage ? '' : '，待生成图片'}${candidate.usedBy ? `，已扮演：${candidate.usedBy}` : ''}`

// 演员库为空时，没有台词的人物直接记为无参考图；有台词的人物仍要通过 cast_scene 新建演员。
export const describeCastingStatus = (book: CastingBook, characters: SceneCharacter[]) => {
  if (!book.actors.length) {
    for (const character of pendingCastingCharacters(book, characters)) {
      if (!book.speakingCharacterIds.has(character.id)) book.declined.add(character.id)
    }
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
    lines.push('待选角人物：')
    for (const character of pending) {
      const candidates = listCastingCandidates(book, character, characters)
      const matched = candidates.filter((candidate) => candidate.ageMatch)
      const unmatched = candidates.filter((candidate) => !candidate.ageMatch)
      const genderLabel = character.gender === 'female' ? '女' : '男'
      const body = matched.length && unmatched.length
        ? `候选 ${matched.map(candidateLabel).join('、')}；年龄不重叠的备选 ${unmatched.map(candidateLabel).join('、')}`
        : matched.length
          ? `候选 ${matched.map(candidateLabel).join('、')}`
          : unmatched.length
            ? `无年龄相符的${genderLabel}演员；年龄不重叠的备选 ${unmatched.map(candidateLabel).join('、')}；不合适可用 create 新建`
            : '无同性别演员，请用 create { name, appearance } 新建演员'
      const speaking = book.speakingCharacterIds.has(character.id) ? '（有台词）' : ''
      lines.push(`- ${speaking}${character.name}（${character.id}，${genderLabel} ${character.minAge}–${character.maxAge}）：${body}`)
    }
    lines.push('请调用 cast_scene 为每个待选角人物做出决定：从候选中指定 actorId、用 create { name, appearance } 新建演员，或对没有台词的背景人物设为 null；有台词的人物必须有参考图。同一场次两个人物不能使用同一演员。')
  } else if (book.actors.length) {
    lines.push('本场次人物均已有选角决定，无需调用 cast_scene。')
  } else {
    lines.push('演员库为空，本场次人物均无台词且无参考图；无需调用 cast_scene。')
  }
  return lines.join('\n')
}

export const castSceneSchema = Type.Object({
  assignments: Type.Array(Type.Object({
    characterId: Type.String({ minLength: 1, maxLength: 50 }),
    actorId: Type.Optional(Type.Union([Type.String({ minLength: 1, maxLength: 100 }), Type.Null()], { description: '选定的演员 ID；null 表示该人物不使用参考图。与 create 二选一。' })),
    create: Type.Optional(Type.Object({
      name: Type.String({ minLength: 1, maxLength: 30, description: '新演员姓名。' }),
      appearance: Type.String({ minLength: 10, maxLength: 300, description: '人物外观：年龄、脸型、发式、服饰、标志物、气质；不写构图、背景、光线' }),
    }, { additionalProperties: false, description: '演员库没有合适人选时新建演员；与 actorId 二选一。' })),
    reason: Type.String({ minLength: 1, maxLength: 200, description: '选择、放弃或新建该演员的理由。' }),
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
  description: '为每个待选角人物从 publish_scene 结果列出的候选中提交 actorId（或 null）和理由。演员库没有合适人选时，可通过 create { name, appearance } 新建演员，程序会生成三视图 prompt 交给用户生成图片；只写人物身份层外观。老角色的演员由程序沿用，不必重复提交；同一场次两个人物不能用同一演员；本场次内可以重新提交覆盖自己的决定，更换此前场次已绑定的演员必须设置 recast: true。有台词的人物必须指定演员或新建，不能设为 null。提交后本场次所有人物都必须有选角决定。',
  parameters: castSceneSchema,
  executionMode: 'sequential',
  execute: async (_toolCallId, input) => {
    const characters = getCharacters()
    if (!characters.length) throw new Error('必须先通过 publish_scene 发布本场次人物。')
    const charactersById = new Map(characters.map((character) => [character.id, character]))
    const actorsById = new Map(book.actors.map((actor) => [actor.id, actor]))
    const issues: string[] = []
    const warnings: string[] = []
    const nextBindings = new Map(book.bindings)
    const nextDeclined = new Set(book.declined)
    const seenCharacterIds = new Set<string>()
    const createRequests: Array<{ character: SceneCharacter; create: { name: string; appearance: string } }> = []
    const created: CreatedActor[] = []

    for (const assignment of input.assignments) {
      const character = charactersById.get(assignment.characterId)
      if (!character) {
        issues.push(`人物 ${assignment.characterId} 不在本场次 characters 中`)
        continue
      }
      if (seenCharacterIds.has(character.id)) {
        issues.push(`人物 ${character.name} 被重复提交`)
        continue
      }
      seenCharacterIds.add(character.id)
      if ((assignment.actorId === undefined) === (assignment.create === undefined)) {
        issues.push(`人物 ${character.name} 必须提供 actorId（或 null）或 create 之一`)
        continue
      }
      const existingActorId = book.bindings.get(character.id)
      if (existingActorId && existingActorId !== assignment.actorId && book.lockedCharacterIds.has(character.id) && !assignment.recast) {
        issues.push(`人物 ${character.name} 已绑定演员 ${actorsById.get(existingActorId)?.name ?? existingActorId}，不能更换；确需更换请设置 recast: true 并说明理由`)
        continue
      }
      if (assignment.create) {
        // 新建的绑定推迟到全部 actorId 落定后再判断候选是否真的都不可用。
        nextBindings.delete(character.id)
        nextDeclined.delete(character.id)
        createRequests.push({ character, create: assignment.create })
        continue
      }
      if (assignment.actorId === null) {
        if (book.speakingCharacterIds.has(character.id)) {
          issues.push(`人物 ${character.name} 有台词，必须有参考图：请从候选中选择演员，或用 create { name, appearance } 新建；null 只能用于没有台词的背景人物`)
          continue
        }
        nextBindings.delete(character.id)
        nextDeclined.add(character.id)
        continue
      }
      const actor = actorsById.get(assignment.actorId!)
      if (!actor) {
        issues.push(`演员 ${assignment.actorId} 不存在，请从 publish_scene 结果列出的候选中选择`)
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

    for (const { character, create } of createRequests) {
      const occupied = new Set(characters.flatMap((other) => {
        if (other.id === character.id) return []
        const actorId = nextBindings.get(other.id)
        return actorId ? [actorId] : []
      }))
      const available = listCastingCandidates(book, character, characters)
        .filter((candidate) => candidate.ageMatch && !occupied.has(candidate.id))
      if (available.length) {
        issues.push(`人物 ${character.name} 已有年龄相符的候选演员 ${available.map((candidate) => candidate.name).join('、')}，请从中选择；确实都不合适请在 reason 中说明并把 actorId 设为 null`)
        continue
      }
      const actor: CreatedActor = {
        id: crypto.randomUUID(),
        name: create.name,
        gender: character.gender,
        minAge: character.minAge,
        maxAge: character.maxAge,
        appearance: create.appearance,
        imagePrompt: buildActorImagePrompt({
          name: create.name,
          gender: character.gender,
          minAge: character.minAge,
          maxAge: character.maxAge,
          appearance: create.appearance,
        }),
      }
      created.push(actor)
      actorsById.set(actor.id, toCastableActor(actor))
      nextBindings.set(character.id, actor.id)
    }

    const actorUsage = new Map<string, string[]>()
    for (const character of characters) {
      const actorId = nextBindings.get(character.id)
      if (!actorId) continue
      actorUsage.set(actorId, [...(actorUsage.get(actorId) ?? []), character.name])
    }
    for (const [actorId, names] of actorUsage) {
      if (names.length > 1) issues.push(`演员 ${actorsById.get(actorId)?.name ?? actorId} 同时分配给了 ${names.join('、')}，同一场次不能撞脸`)
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
    // 本场次新建后又被覆盖的演员不再需要参考图，从账本里撤掉。
    const boundActorIds = new Set(book.bindings.values())
    const survivingCreated = [...book.createdActors, ...created].filter((actor) => boundActorIds.has(actor.id))
    const survivingIds = new Set(survivingCreated.map((actor) => actor.id))
    const droppedIds = new Set([...book.createdActors, ...created]
      .filter((actor) => !survivingIds.has(actor.id))
      .map((actor) => actor.id))
    book.actors = [
      ...book.actors.filter((actor) => !droppedIds.has(actor.id)),
      ...created.filter((actor) => survivingIds.has(actor.id)).map(toCastableActor),
    ]
    book.createdActors = survivingCreated

    const result = resolveSceneCasting(book, characters)
    await onCast?.(result)
    const createdIds = new Set(book.createdActors.map((actor) => actor.id))
    const table = characters.map((character) => {
      const actorId = book.bindings.get(character.id)
      const actor = actorId ? actorsById.get(actorId) : undefined
      if (!actor) return `- ${character.name}：无参考图`
      if (actor.hasImage) return `- ${character.name}：${actor.name}，有参考图`
      return `- ${character.name}：${createdIds.has(actor.id) ? '新演员 ' : ''}${actor.name}，待生成参考图`
    })
    const text = [
      '选角已确定：',
      ...table,
      ...(warnings.length ? [`提示：${warnings.join('；')}。`] : []),
      '已选演员的外观由程序拼进其出场各段的 prompt，分镜正文只用人物姓名。',
    ].join('\n')
    return {
      content: [{ type: 'text', text }],
      details: result,
      terminate: false,
    }
  },
})
