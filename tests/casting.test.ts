import assert from 'node:assert/strict'
import test from 'node:test'
import { buildCharacterReferences } from '../src/services/casting.ts'
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

test('builds one composite three-view reference for each cast character', () => {
  const references = buildCharacterReferences(characters, actors, [
    { characterId: 'girl', actorId: 'actor-young-woman' },
  ])
  assert.deepEqual(references, {
    girl: {
      characterName: '圆脸少女',
      actorId: 'actor-young-woman',
      imageUrl: 'three-view-a',
    },
  })
})

test('an actor still waiting for a reference image is listed without one, to be described in text', () => {
  const pending: Actor = { id: 'actor-pending', name: '演员丙', gender: 'female', minAge: 40, maxAge: 55, appearance: '四十余岁', createdAt: 3 }
  const references = buildCharacterReferences(characters, [...actors, pending], [
    { characterId: 'matron', actorId: 'actor-pending' },
  ])
  assert.deepEqual(references, { matron: { characterName: '教引嬷嬷', actorId: 'actor-pending' } })
})
