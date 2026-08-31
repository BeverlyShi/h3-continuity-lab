import assert from 'node:assert/strict'
import test from 'node:test'
import { createPublishSceneTool } from '../server/publishSceneTool.ts'
import type { StoryScene } from '../src/types/story.ts'

const scene: StoryScene = {
  title: '宫门初雪',
  narrative: '宫门在身后缓缓合拢，沈清禾第一次听见深宫里的晨钟，队伍已经向前移动。',
  choices: [
    { id: 'A', text: '捡起绣帕' },
    { id: 'B', text: '跟上队伍' },
  ],
}

test('publishes the scene in tool details and terminates the agent turn', async () => {
  let published: StoryScene | undefined
  const tool = createPublishSceneTool((value) => { published = value })
  const result = await tool.execute('tool-1', scene)

  assert.equal(tool.name, 'publish_scene')
  assert.equal(result.terminate, true)
  assert.deepEqual(result.details, scene)
  assert.deepEqual(published, scene)
  assert.match(result.content[0].type === 'text' ? result.content[0].text : '', /成功发布/)
})
