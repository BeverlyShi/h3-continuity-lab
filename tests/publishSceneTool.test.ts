import assert from 'node:assert/strict'
import test from 'node:test'
import { createPublishSceneTool } from '../server/publishSceneTool.ts'
import type { ScenePublish } from '../src/types/story.ts'

const turn: ScenePublish = {
  scene: {
    title: '宫门初雪',
    narrative: '宫门在身后缓缓合拢，沈清禾第一次听见深宫里的晨钟。细雪落在朱红宫墙下，教引嬷嬷催促秀女们向前，她却发现同行少女悄悄塞来一方绣帕。绣帕角落绣着禁军纹样，远处又有人停步回望。沈清禾把手藏进袖中，前方嬷嬷忽然点到她的名字，身旁少女低声让她千万别交出去。队伍即将转过宫门，再迟一步便会被人看见，她必须立刻决定如何应对。',
    choices: [
      { id: '1', text: '把绣帕交给嬷嬷' },
      { id: '2', text: '替少女暂时藏好' },
      { id: '3', text: '假装失手丢在雪中' },
    ],
  },
  characters: [
    { id: 'heroine', name: '沈清禾', gender: 'female', minAge: 16, maxAge: 20 },
  ],
}

test('publishes the scene without terminating the wider media turn', async () => {
  let published: ScenePublish | undefined
  const tool = createPublishSceneTool((value) => { published = value })
  const result = await tool.execute('tool-1', turn)

  assert.equal(tool.name, 'publish_scene')
  assert.equal(result.terminate, false)
  assert.deepEqual(result.details, turn)
  assert.deepEqual(published, turn)
  assert.match(result.content[0].type === 'text' ? result.content[0].text : '', /场景已发布/)
})

test('rejects duplicate character ids', async () => {
  const tool = createPublishSceneTool()
  await assert.rejects(() => tool.execute('tool-duplicate', {
    ...turn,
    characters: [...turn.characters, { ...turn.characters[0] }],
  }), /重复/)
})

test('rejects an invalid character age range', async () => {
  const tool = createPublishSceneTool()
  await assert.rejects(() => tool.execute('tool-age', {
    ...turn,
    characters: [{ ...turn.characters[0], minAge: 30, maxAge: 20 }],
  }), /年龄区间无效/)
})

test('requires choice ids 1, 2 and 3 exactly once', async () => {
  const tool = createPublishSceneTool()
  await assert.rejects(() => tool.execute('tool-choice-ids', {
    ...turn,
    scene: {
      ...turn.scene,
      choices: turn.scene.choices.map((choice) => ({ ...choice, id: '1' })),
    },
  }), /各使用一次 ID 1、2、3/)
})
