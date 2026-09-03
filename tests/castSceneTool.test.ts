import assert from 'node:assert/strict'
import test from 'node:test'
import { createCastSceneTool } from '../server/castSceneTool.ts'
import type { CastableActor } from '../src/types/actor.ts'
import type { SceneCharacter } from '../src/types/story.ts'

const actors: CastableActor[] = [
  { id: 'actor-a', name: '演员甲', gender: 'female', minAge: 16, maxAge: 24 },
  { id: 'actor-b', name: '演员乙', gender: 'male', minAge: 35, maxAge: 50 },
]

const characters: SceneCharacter[] = [
  { id: 'heroine', name: '沈清禾', gender: 'female', minAge: 17, maxAge: 20 },
  { id: 'emperor', name: '皇帝', gender: 'male', minAge: 30, maxAge: 42 },
]

test('casts published scene characters from the actor library', async () => {
  const tool = createCastSceneTool(characters, actors, [])
  const result = await tool.execute('cast-1', {})

  assert.equal(tool.name, 'cast_scene')
  assert.equal(tool.executionMode, 'parallel')
  assert.equal(result.terminate, true)
  assert.deepEqual(result.details, {
    castings: [
      { characterId: 'heroine', actorId: 'actor-a' },
      { characterId: 'emperor', actorId: 'actor-b' },
    ],
    unmatchedCharacterIds: [],
  })
})

test('reuses an existing actor binding for a recurring character', async () => {
  const tool = createCastSceneTool(
    [characters[0]],
    actors,
    [{ characterId: 'heroine', actorId: 'actor-a' }],
  )

  const result = await tool.execute('cast-2', {})
  assert.deepEqual(result.details.castings, [
    { characterId: 'heroine', actorId: 'actor-a' },
  ])
})

test('reports characters that have no compatible unused actor', async () => {
  const tool = createCastSceneTool(
    [characters[0]],
    actors,
    [{ characterId: 'other-character', actorId: 'actor-a' }],
  )

  const result = await tool.execute('cast-3', {})
  assert.deepEqual(result.details, {
    castings: [],
    unmatchedCharacterIds: ['heroine'],
  })
})

test('requires publish_scene characters before casting', async () => {
  const tool = createCastSceneTool([], actors, [])
  await assert.rejects(() => tool.execute('cast-empty', {}), /必须先通过 publish_scene/)
})
