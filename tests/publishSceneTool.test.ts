import assert from 'node:assert/strict'
import test from 'node:test'
import { createPublishSceneTool } from '../server/publishSceneTool.ts'
import type { ScenePublish } from '../src/types/story.ts'

const turn: ScenePublish = {
  scene: {
    title: '宫门初雪',
    narrative: '宫门在身后缓缓合拢，沈清禾第一次听见深宫里的晨钟，队伍已经向前移动。',
    choices: [
      { id: 'A', text: '捡起绣帕' },
      { id: 'B', text: '跟上队伍' },
    ],
  },
  characters: [
    { id: 'heroine', name: '沈清禾', gender: 'female', minAge: 16, maxAge: 20 },
  ],
}

test('publishes the scene in tool details and terminates the agent turn', async () => {
  let published: ScenePublish | undefined
  const tool = createPublishSceneTool((value) => { published = value })
  const result = await tool.execute('tool-1', turn)

  assert.equal(tool.name, 'publish_scene')
  assert.equal(result.terminate, true)
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
