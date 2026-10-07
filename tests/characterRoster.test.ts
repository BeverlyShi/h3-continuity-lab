import assert from 'node:assert/strict'
import test from 'node:test'
import type { Entry } from '@earendil-works/pi-agent-core'
import {
  CHARACTER_ROSTER_HEADING,
  describeCharacterRoster,
  findRosterConflicts,
  stripCharacterRoster,
} from '../src/director/characterRoster.ts'
import { projectHistory } from '../src/director/directorContext.ts'
import { buildStoryInputMessage } from '../src/director/directorPrompt.ts'
import { createPublishSceneTool } from '../src/director/publishSceneTool.ts'
import type { CastableActor, CharacterCasting } from '../src/types/actor.ts'
import type { SceneCharacter, ScenePublish } from '../src/types/story.ts'

const known: SceneCharacter[] = [
  { id: 'heroine', name: '沈清禾', gender: 'female', minAge: 16, maxAge: 20 },
  { id: 'li_guifei', name: '李贵妃', gender: 'female', minAge: 22, maxAge: 26 },
  { id: 'maid_1', name: '宫女', gender: 'female', minAge: 15, maxAge: 18 },
]
const actors: CastableActor[] = [
  { id: 'actor-a', name: '沈清', gender: 'female', minAge: 16, maxAge: 22, hasImage: true },
  { id: 'actor-b', name: '小禾', gender: 'female', minAge: 20, maxAge: 28, hasImage: false },
]
const castings: CharacterCasting[] = [
  { characterId: 'heroine', actorId: 'actor-a' },
  { characterId: 'li_guifei', actorId: 'actor-b' },
]

test('the roster lists every known character with its id and actor', () => {
  const roster = describeCharacterRoster(known, castings, actors)!
  assert.ok(roster.startsWith(CHARACTER_ROSTER_HEADING))
  assert.match(roster, /- heroine｜沈清禾｜女 16–20｜演员：沈清/)
  assert.match(roster, /- li_guifei｜李贵妃｜女 22–26｜演员：小禾/)
  assert.match(roster, /- maid_1｜宫女｜女 15–18｜无演员/)
  assert.equal(describeCharacterRoster([], castings, actors), undefined)
})

test('a new id reusing the name of a cast character is a conflict; uncast namesakes and kept ids are not', () => {
  const published: SceneCharacter[] = [
    { id: 'consort_li', name: '李贵妃', gender: 'female', minAge: 22, maxAge: 26 },
    { id: 'maid_2', name: '宫女', gender: 'female', minAge: 15, maxAge: 18 },
    { id: 'heroine', name: '沈清禾', gender: 'female', minAge: 16, maxAge: 20 },
    { id: 'li_guifei_new', name: '李嫔', gender: 'female', minAge: 22, maxAge: 26 },
  ]
  const conflicts = findRosterConflicts(published, known, castings, actors)
  assert.equal(conflicts.length, 1)
  assert.match(conflicts[0], /consort_li/)
  assert.match(conflicts[0], /沿用 id li_guifei/)
  assert.match(conflicts[0], /小禾/)
})

test('the roster goes into the player input as its own paragraph and only there', () => {
  const roster = describeCharacterRoster(known, castings, actors)!
  const message = buildStoryInputMessage({ type: 'freeform', text: '走向宫门' }, { hasPreviousFrame: false, roster })
  assert.ok(message.endsWith(roster))
  assert.equal(stripCharacterRoster(message).includes(CHARACTER_ROSTER_HEADING), false)
  assert.ok(stripCharacterRoster(message).startsWith('玩家决定自由行动：走向宫门'))
  assert.equal(buildStoryInputMessage({ type: 'start' }).includes(CHARACTER_ROSTER_HEADING), false)
})

test('publish_scene rejects a renamed returning character before publishing', async () => {
  let published = false
  const turn: ScenePublish = {
    scene: {
      title: '御花园',
      narrative: '沈清禾在御花园遇见李贵妃，贵妃停下脚步打量她，身旁宫人都屏住了呼吸，她只得低头行礼。',
      choices: [{ id: '1', text: '低头行礼' }, { id: '2', text: '抬头直视' }, { id: '3', text: '转身回避' }],
    },
    characters: [
      { id: 'heroine', name: '沈清禾', gender: 'female', minAge: 16, maxAge: 20 },
      { id: 'consort_li', name: '李贵妃', gender: 'female', minAge: 22, maxAge: 26 },
    ],
    dialogues: [],
  }
  const tool = createPublishSceneTool(() => { published = true }, {
    checkCharacters: (value) => findRosterConflicts(value.characters, known, castings, actors),
  })
  await assert.rejects(tool.execute('call-1', turn), /人物 id 与已登场人物名册冲突[\s\S]*沿用 id li_guifei/)
  assert.equal(published, false)

  const fixed = { ...turn, characters: [turn.characters[0], { ...turn.characters[1], id: 'li_guifei' }] }
  await tool.execute('call-2', fixed)
  assert.equal(published, true)
})

test('history projection drops old rosters but keeps the current one', () => {
  let seq = 0
  const entry = (value: Omit<Extract<Entry, { type: 'custom' }>, 'id' | 'seq' | 'parentId' | 'timestamp'> | { type: 'message'; message: unknown }): Entry => {
    seq += 1
    return { ...value, id: `entry-${seq}`, seq, parentId: null, timestamp: seq } as Entry
  }
  const roster = describeCharacterRoster(known, castings, actors)!
  const userText = (text: string) => ({ type: 'message' as const, message: { role: 'user', content: [{ type: 'text', text }], timestamp: 1 } })
  const entries = [
    entry({ type: 'custom', customType: 'director_trace', data: { traceId: 't1' } }),
    entry(userText(`玩家选择了：\nID：1\n\n${roster}`)),
    entry({ type: 'custom', customType: 'director_trace', data: { traceId: 't2' } }),
    entry({ type: 'message', message: { role: 'user', content: `玩家选择了：\nID：2\n\n${roster}`, timestamp: 2 } }),
  ]
  const projected = projectHistory(entries) as Array<Extract<Entry, { type: 'message' }>>
  const history = projected[1].message as { content: Array<{ text: string }> }
  assert.equal(history.content[0].text, '玩家选择了：\nID：1')
  const current = projected[3].message as { content: string }
  assert.ok(current.content.includes(CHARACTER_ROSTER_HEADING))
})
