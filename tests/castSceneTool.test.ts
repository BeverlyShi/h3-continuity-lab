import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createCastingBook,
  createCastSceneTool,
  createSearchActorsTool,
  describeCastingStatus,
  isCastingComplete,
  resolveSceneCasting,
} from '../server/castSceneTool.ts'
import type { CastableActor } from '../src/types/actor.ts'
import type { SceneCharacter } from '../src/types/story.ts'

const actors: CastableActor[] = [
  { id: 'actor-a', name: '演员甲', gender: 'female', minAge: 16, maxAge: 24 },
  { id: 'actor-b', name: '演员乙', gender: 'male', minAge: 35, maxAge: 50 },
  { id: 'actor-c', name: '演员丙', gender: 'female', minAge: 40, maxAge: 55 },
]

const characters: SceneCharacter[] = [
  { id: 'heroine', name: '沈清禾', gender: 'female', minAge: 17, maxAge: 20 },
  { id: 'emperor', name: '皇帝', gender: 'male', minAge: 30, maxAge: 42 },
]

const textOf = (result: { content: Array<{ type: string; text?: string }> }) => result.content[0].text ?? ''

test('search_actors filters by gender and age, marks actors already bound to a character and caps results', async () => {
  const book = createCastingBook(actors, [{ characterId: 'heroine', actorId: 'actor-a' }])
  const tool = createSearchActorsTool(book, () => characters)
  assert.equal(tool.name, 'search_actors')
  const women = await tool.execute('search-1', { gender: 'female' })
  assert.deepEqual(women.details.actors.map((actor) => [actor.id, actor.usedBy]), [['actor-c', undefined], ['actor-a', '沈清禾']])
  assert.match(textOf(women), /演员甲（actor-a，女，16–24 岁），已扮演：沈清禾/)
  const elders = await tool.execute('search-2', { minAge: 45, maxAge: 60 })
  assert.deepEqual(elders.details.actors.map((actor) => actor.id), ['actor-b', 'actor-c'])
  const none = await tool.execute('search-3', { gender: 'male', maxAge: 20 })
  assert.deepEqual(none.details.actors, [])
  assert.match(textOf(none), /没有符合条件的演员/)
  await assert.rejects(() => tool.execute('search-4', { minAge: 50, maxAge: 20 }), /minAge 不能大于 maxAge/)
  assert.equal(women.terminate, false)
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

test('cast_scene keeps existing bindings, blocks silent recasts and allows an explicit recast', async () => {
  const book = createCastingBook(actors, [{ characterId: 'heroine', actorId: 'actor-a' }])
  const tool = createCastSceneTool(book, () => [characters[0]])
  assert.equal(isCastingComplete(book, [characters[0]]), true)
  await assert.rejects(() => tool.execute('cast-recast', { assignments: [{ characterId: 'heroine', actorId: 'actor-c', reason: '换个人' }] }),
    /沈清禾 已绑定演员 演员甲，不能更换；确需更换请设置 recast: true/)
  assert.equal(book.bindings.get('heroine'), 'actor-a')
  const empty = await tool.execute('cast-empty', { assignments: [] })
  assert.deepEqual(empty.details.castings, [{ characterId: 'heroine', actorId: 'actor-a' }])
  const recast = await tool.execute('cast-recast-ok', { assignments: [{ characterId: 'heroine', actorId: 'actor-c', reason: '剧情需要', recast: true }] })
  assert.deepEqual(recast.details.castings, [{ characterId: 'heroine', actorId: 'actor-c' }])
  assert.match(textOf(recast), /年龄区间不重叠/)
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

test('describes casting status after publishing and resolves the final scene casting from the book', () => {
  const book = createCastingBook(actors, [{ characterId: 'heroine', actorId: 'actor-a' }, { characterId: 'old', actorId: 'removed-actor' }])
  assert.equal(book.bindings.has('old'), false, '指向已删除演员的旧绑定被忽略')
  const status = describeCastingStatus(book, characters)
  assert.match(status, /沿用已有选角：沈清禾 → 演员甲/)
  assert.match(status, /待选角人物：皇帝（emperor）/)
  assert.match(status, /先用 search_actors 查看候选演员/)
  assert.deepEqual(resolveSceneCasting(book, characters), { castings: [{ characterId: 'heroine', actorId: 'actor-a' }], unmatchedCharacterIds: ['emperor'] })
  assert.match(describeCastingStatus(createCastingBook([], []), characters), /演员库为空/)
})
