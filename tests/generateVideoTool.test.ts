import assert from 'node:assert/strict'
import test from 'node:test'
import { createGenerateVideoTool } from '../server/generateVideoTool.ts'
import type { VideoGenerationRequest } from '../src/types/story.ts'

const request: VideoGenerationRequest = {
  duration: 6,
  prompt: '0-2秒，宫墙暮色场景，镜头缓慢推进朱红宫墙；2-6秒，偏院室内场景，少女攥紧袖口，烛光摇曳',
}

test('hands the video request to the caller without terminating the turn', async () => {
  let received: VideoGenerationRequest | undefined
  const tool = createGenerateVideoTool((value) => { received = value })
  const result = await tool.execute('tool-1', request)

  assert.equal(tool.name, 'generate_video')
  assert.equal(result.terminate, false)
  assert.deepEqual(result.details, request)
  assert.deepEqual(received, request)
  assert.match(result.content[0].type === 'text' ? result.content[0].text : '', /已提交/)
})

test('works without an onRequest callback', async () => {
  const tool = createGenerateVideoTool()
  const result = await tool.execute('tool-2', request)

  assert.equal(result.terminate, false)
  assert.match(result.content[0].type === 'text' ? result.content[0].text : '', /publish_scene/)
})
