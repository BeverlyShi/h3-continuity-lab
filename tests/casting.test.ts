import assert from 'node:assert/strict'
import test from 'node:test'
import { buildCharacterReferences, resolveCharacterCastings } from '../src/services/casting.ts'
import type { Actor } from '../src/types/actor.ts'
import type { SceneCharacter } from '../src/types/story.ts'

const actors: Actor[] = [
  {
    id: 'actor-young-woman',
    name: '演员甲',
    gender: 'female',
    minAge: 15,
    maxAge: 22,
    referenceImageUrl: 'three-view-a',
    createdAt: 1,
  },
  {
    id: 'actor-older-woman',
    name: '演员乙',
    gender: 'female',
    minAge: 30,
    maxAge: 45,
    referenceImageUrl: 'three-view-b',
    createdAt: 2,
  },
]

const characters: SceneCharacter[] = [
  { id: 'girl', name: '圆脸少女', gender: 'female', minAge: 15, maxAge: 18 },
  { id: 'matron', name: '教引嬷嬷', gender: 'female', minAge: 40, maxAge: 55 },
]

test('matches unused actors by gender and overlapping age range', () => {
  assert.deepEqual(resolveCharacterCastings(characters, actors, []), [
    { characterId: 'girl', actorId: 'actor-young-woman' },
    { characterId: 'matron', actorId: 'actor-older-woman' },
  ])
})

test('keeps an existing casting and does not reuse its actor', () => {
  const existing = [{ characterId: 'heroine', actorId: 'actor-young-woman' }]
  assert.deepEqual(resolveCharacterCastings(characters, actors, existing), [
    ...existing,
    { characterId: 'matron', actorId: 'actor-older-woman' },
  ])
})

test('builds one composite three-view reference for each cast character', () => {
  const references = buildCharacterReferences(characters, actors, [
    { characterId: 'girl', actorId: 'actor-young-woman' },
  ])
  assert.deepEqual(references, {
    girl: {
      characterName: '圆脸少女',
      imageUrl: 'three-view-a',
    },
  })
})
