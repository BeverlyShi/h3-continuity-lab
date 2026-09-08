import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createCastingBook,
  createCastSceneTool,
  describeCastingStatus,
  isCastingComplete,
  listCastingCandidates,
  resolveSceneCasting,
} from '../server/castSceneTool.ts'
import type { CastableActor } from '../src/types/actor.ts'
import type { SceneCharacter } from '../src/types/story.ts'

const actors: CastableActor[] = [
  { id: 'actor-a', name: '演员甲', gender: 'female', minAge: 16, maxAge: 24, hasImage: true },
  { id: 'actor-b', name: '演员乙', gender: 'male', minAge: 35, maxAge: 50, hasImage: true },
  { id: 'actor-c', name: '演员丙', gender: 'female', minAge: 40, maxAge: 55, hasImage: true },
]

const characters: SceneCharacter[] = [
  { id: 'heroine', name: '沈清禾', gender: 'female', minAge: 17, maxAge: 20 },
  { id: 'emperor', name: '皇帝', gender: 'male', minAge: 30, maxAge: 42 },
]

const textOf = (result: { content: Array<{ type: string; text?: string }> }) => result.content[0].text ?? ''

test('listCastingCandidates filters by gender, ranks age-matched candidates by distance, backfills unmatched ones and caps at 8', () => {
  const book = createCastingBook(actors, [{ characterId: 'emperor', actorId: 'actor-b' }])
  const heroineCandidates = listCastingCandidates(book, characters[0], characters)
  assert.deepEqual(heroineCandidates.map((candidate) => [candidate.id, candidate.ageMatch]), [
    ['actor-a', true],
    ['actor-c', false],
  ])

  const manyActors: CastableActor[] = Array.from({ length: 10 }, (_, index) => ({
    id: `actor-${index}`,
    name: `演员${index}`,
    gender: 'female',
    minAge: 16 + index,
    maxAge: 20 + index,
    hasImage: true,
  }))
  const bigBook = createCastingBook(manyActors, [])
  const capped = listCastingCandidates(bigBook, characters[0], characters)
  assert.equal(capped.length, 8)

  const noneMatchingGender = listCastingCandidates(book, { id: 'x', name: '甲', gender: 'male', minAge: 60, maxAge: 70 }, characters)
  assert.deepEqual(noneMatchingGender.map((candidate) => candidate.id), ['actor-b'])
  assert.equal(noneMatchingGender[0].ageMatch, false)

  const withUsage = listCastingCandidates(book, characters[1], characters)
  const emperorEntry = withUsage.find((candidate) => candidate.id === 'actor-b')
  assert.equal(emperorEntry?.usedBy, '皇帝')
})

test('cast_scene records the model decision for every scene character and reports reference availability', async () => {
  const book = createCastingBook(actors, [])
  let published: unknown
  const tool = createCastSceneTool(book, () => characters, (result) => { published = result })
  assert.equal(tool.name, 'cast_scene')
  const result = await tool.execute('cast-1', { assignments: [
    { characterId: 'heroine', actorId: 'actor-a', reason: '年龄相符' },
    { characterId: 'emperor', actorId: null, reason: '没有合适的男演员' },
  ] })
  assert.equal(result.terminate, false)
  assert.deepEqual(result.details, { castings: [{ characterId: 'heroine', actorId: 'actor-a' }], unmatchedCharacterIds: ['emperor'] })
  assert.deepEqual(published, result.details)
  assert.match(textOf(result), /沈清禾：演员甲，有参考图/)
  assert.match(textOf(result), /皇帝：无参考图/)
  assert.equal(isCastingComplete(book, characters), true)
})

test('cast_scene allows overriding its own decision within the same turn, but cross-turn bindings need recast', async () => {
  const book = createCastingBook(actors, [{ characterId: 'heroine', actorId: 'actor-a' }])
  const tool = createCastSceneTool(book, () => [characters[0]])
  assert.equal(isCastingComplete(book, [characters[0]]), true)

  // 跨回合绑定：无 recast 直接拒绝。
  await assert.rejects(() => tool.execute('cast-recast', { assignments: [{ characterId: 'heroine', actorId: 'actor-c', reason: '换个人' }] }),
    /沈清禾 已绑定演员 演员甲，不能更换；确需更换请设置 recast: true/)
  assert.equal(book.bindings.get('heroine'), 'actor-a')

  // 显式 recast 后，本回合内可以再次覆盖，无需重复设置 recast。
  const recast = await tool.execute('cast-recast-ok', { assignments: [{ characterId: 'heroine', actorId: 'actor-c', reason: '剧情需要', recast: true }] })
  assert.deepEqual(recast.details.castings, [{ characterId: 'heroine', actorId: 'actor-c' }])
  assert.match(textOf(recast), /年龄区间不重叠/)
})

test('cast_scene lets a fresh binding made this turn be overridden or nulled without recast', async () => {
  const book = createCastingBook(actors, [])
  const tool = createCastSceneTool(book, () => [characters[0]])
  const first = await tool.execute('cast-fresh-1', { assignments: [{ characterId: 'heroine', actorId: 'actor-a', reason: '初次决定' }] })
  assert.deepEqual(first.details.castings, [{ characterId: 'heroine', actorId: 'actor-a' }])

  const overridden = await tool.execute('cast-fresh-2', { assignments: [{ characterId: 'heroine', actorId: 'actor-c', reason: '改变主意' }] })
  assert.deepEqual(overridden.details.castings, [{ characterId: 'heroine', actorId: 'actor-c' }])

  const nulled = await tool.execute('cast-fresh-3', { assignments: [{ characterId: 'heroine', actorId: null, reason: '还是不用参考图' }] })
  assert.deepEqual(nulled.details.castings, [])
})

test('cast_scene validates actors, gender, duplicates and completeness before changing the book', async () => {
  const book = createCastingBook(actors, [])
  const tool = createCastSceneTool(book, () => characters)
  await assert.rejects(() => tool.execute('cast-bad', { assignments: [
    { characterId: 'heroine', actorId: 'actor-b', reason: '试试' },
    { characterId: 'ghost', actorId: 'actor-a', reason: '不存在的人物' },
    { characterId: 'emperor', actorId: 'actor-z', reason: '不存在的演员' },
  ] }), (error: unknown) => {
    assert.ok(error instanceof Error)
    assert.match(error.message, /演员 演员乙 的性别与人物 沈清禾 不符/)
    assert.match(error.message, /人物 ghost 不在本幕 characters 中/)
    assert.match(error.message, /演员 actor-z 不存在/)
    return true
  })
  await assert.rejects(() => tool.execute('cast-partial', { assignments: [{ characterId: 'heroine', actorId: 'actor-a', reason: '年龄相符' }] }),
    /以下人物尚未做出选角决定：皇帝（emperor）/)
  assert.equal(book.bindings.size, 0)
  await assert.rejects(() => tool.execute('cast-dupe', { assignments: [
    { characterId: 'heroine', actorId: 'actor-a', reason: '年龄相符' },
    { characterId: 'emperor', actorId: 'actor-a', reason: '重复', recast: true },
  ] }), /性别与人物 皇帝 不符/)
  await assert.rejects(() => tool.execute('cast-empty-scene', { assignments: [] }).then(() => {
    throw new Error('should not reach')
  }), /尚未做出选角决定/)
  const emptyScene = createCastSceneTool(createCastingBook(actors, []), () => [])
  await assert.rejects(() => emptyScene.execute('cast-none', { assignments: [] }), /必须先通过 publish_scene/)
})

test('describes casting status with candidates for each pending character and resolves the final scene casting from the book', () => {
  const book = createCastingBook(actors, [{ characterId: 'heroine', actorId: 'actor-a' }, { characterId: 'old', actorId: 'removed-actor' }])
  assert.equal(book.bindings.has('old'), false, '指向已删除演员的旧绑定被忽略')
  const status = describeCastingStatus(book, characters)
  assert.match(status, /沿用已有选角：沈清禾 → 演员甲/)
  assert.match(status, /待选角人物：/)
  assert.match(status, /- 皇帝（emperor，男 30–42）：候选 演员乙（actor-b，35–50）/)
  assert.match(status, /请调用 cast_scene 为每个待选角人物指定演员或设为 null；同一幕两个人物不能使用同一演员。/)
  assert.deepEqual(resolveSceneCasting(book, characters), { castings: [{ characterId: 'heroine', actorId: 'actor-a' }], unmatchedCharacterIds: ['emperor'] })
  assert.match(describeCastingStatus(createCastingBook([], []), characters), /演员库为空/)
})

test('describes casting status with no age-matched candidates and a fallback of unmatched ones', () => {
  const elderOnly: CastableActor[] = [{ id: 'actor-c', name: '演员丙', gender: 'female', minAge: 40, maxAge: 55, hasImage: true }]
  const teens: SceneCharacter[] = [{ id: 'steward', name: '掌事姑姑', gender: 'female', minAge: 15, maxAge: 18 }]
  const book = createCastingBook(elderOnly, [])
  const status = describeCastingStatus(book, teens)
  assert.match(status, /- 掌事姑姑（steward，女 15–18）：无年龄相符的女演员；年龄不重叠的备选 演员丙（actor-c，40–55）/)
})

const eunuch: SceneCharacter = { id: 'eunuch', name: '李公公', gender: 'male', minAge: 60, maxAge: 70 }

test('cast_scene refuses to create an actor while an unused age-matched candidate is available', async () => {
  const book = createCastingBook(actors, [])
  const tool = createCastSceneTool(book, () => characters)
  await assert.rejects(() => tool.execute('cast-create-refused', { assignments: [
    { characterId: 'heroine', create: { name: '新人甲', appearance: '十七八岁，鹅蛋脸，垂鬟分肖髻，浅碧襦裙' }, reason: '想要更贴合的长相' },
    { characterId: 'emperor', actorId: null, reason: '背景人物' },
  ] }), /人物 沈清禾 已有年龄相符的候选演员 演员甲，请从中选择；确实都不合适请在 reason 中说明并把 actorId 设为 null/)
  assert.equal(book.createdActors.length, 0)
  assert.equal(book.actors.length, 3)
})

test('cast_scene creates an actor with a generated three-view prompt when no candidate fits', async () => {
  const book = createCastingBook(actors, [])
  const scene = [characters[0], eunuch]
  const tool = createCastSceneTool(book, () => scene)
  const appearance = '六十余岁，清瘦长脸，灰白鬓发，藏青太监常服，垂手而立'
  const result = await tool.execute('cast-create', { assignments: [
    { characterId: 'heroine', actorId: 'actor-a', reason: '年龄相符' },
    { characterId: 'eunuch', create: { name: '演员丁', appearance }, reason: '库中没有六十岁以上的男演员' },
  ] })
  const created = result.details.createdActors ?? []
  assert.equal(created.length, 1)
  assert.ok(created[0].id)
  assert.equal(created[0].name, '演员丁')
  assert.equal(created[0].gender, 'male')
  assert.equal(created[0].appearance, appearance)
  assert.match(created[0].imagePrompt, /16:9/)
  assert.match(created[0].imagePrompt, /三视图/)
  assert.match(created[0].imagePrompt, /纯白背景/)
  assert.ok(created[0].imagePrompt.includes(appearance))
  assert.match(created[0].imagePrompt, /男，60–70 岁/)
  assert.equal(book.bindings.get('eunuch'), created[0].id)
  assert.deepEqual(book.createdActors, created)
  assert.equal(book.actors.length, 4)
  assert.match(textOf(result), /李公公：新演员 演员丁，待生成参考图/)
  assert.match(textOf(result), /沈清禾：演员甲，有参考图/)
  assert.match(textOf(result), /无参考图人物的外观（分镜每段重复使用）：/)
  assert.match(textOf(result), new RegExp(`演员丁：${appearance}`))
  assert.equal(isCastingComplete(book, scene), true)

  // 同回合改主意：新建的演员不再被使用，连同待生成 prompt 一起撤掉。
  const dropped = await tool.execute('cast-create-drop', { assignments: [
    { characterId: 'heroine', actorId: 'actor-a', reason: '不变' },
    { characterId: 'eunuch', actorId: null, reason: '还是不给参考图' },
  ] })
  assert.equal(dropped.details.createdActors, undefined)
  assert.deepEqual(book.createdActors, [])
  assert.equal(book.actors.length, 3)
  assert.doesNotMatch(textOf(dropped), /无参考图人物的外观/)
})

test('cast_scene requires exactly one of actorId and create per assignment', async () => {
  const book = createCastingBook(actors, [])
  const tool = createCastSceneTool(book, () => [eunuch])
  const create = { name: '演员丁', appearance: '六十余岁，清瘦长脸，藏青太监常服' }
  await assert.rejects(() => tool.execute('cast-both', { assignments: [
    { characterId: 'eunuch', actorId: 'actor-b', create, reason: '两个都给' },
  ] }), /人物 李公公 必须提供 actorId（或 null）或 create 之一/)
  await assert.rejects(() => tool.execute('cast-neither', { assignments: [
    { characterId: 'eunuch', reason: '什么都不给' },
  ] }), /人物 李公公 必须提供 actorId（或 null）或 create 之一/)
  assert.equal(book.createdActors.length, 0)
})

test('candidate labels carry the appearance text and mark actors whose reference image is still pending', () => {
  const pending: CastableActor[] = [
    { id: 'actor-d', name: '演员丁', gender: 'male', minAge: 60, maxAge: 70, appearance: '清瘦长脸，藏青太监常服', hasImage: false },
  ]
  const status = describeCastingStatus(createCastingBook(pending, []), [eunuch])
  assert.match(status, /候选 演员丁（actor-d，60–70，清瘦长脸，藏青太监常服），待生成图片/)
})
