import assert from 'node:assert/strict'
import test from 'node:test'
import { parseDirectorEvent } from '../src/services/directorClient.ts'

test('parses a streamed story scene event', () => {
  const event = parseDirectorEvent(JSON.stringify({
    type: 'scene',
    scene: {
      title: '宫门初雪',
      narrative: '宫门在身后缓缓合拢，沈清禾第一次听见深宫里的晨钟。',
      choices: [
        { id: 'A', text: '跟上教引嬷嬷' },
        { id: 'B', text: '回头看一眼宫门' },
      ],
    },
  }))

  assert.equal(event.type, 'scene')
  if (event.type === 'scene') assert.equal(event.scene.choices.length, 2)
})

test('rejects a malformed director stream value', () => {
  assert.throws(() => parseDirectorEvent('[]'), /无法识别/)
})
