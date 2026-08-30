import assert from 'node:assert/strict'
import test from 'node:test'
import { parseDirectorEvent } from '../src/services/directorClient.ts'

test('parses a streamed director resolution event', () => {
  const event = parseDirectorEvent(JSON.stringify({
    type: 'resolution',
    resolution: {
      outcome: 'success',
      narrative: '守门人接过木牌，站到风沙里的门槛前。',
      reason: '玩家的分配符合身份能力，也没有触发流转限制。',
      nextOptions: ['询问书吏的来历', '检查灯夫的包袱'],
      sceneDirection: '黄昏近景，守门人握紧刻字木牌，驿站灯火在身后点亮。',
    },
  }))

  assert.equal(event.type, 'resolution')
  if (event.type === 'resolution') assert.equal(event.resolution.outcome, 'success')
})

test('rejects a malformed director stream value', () => {
  assert.throws(() => parseDirectorEvent('[]'), /无法识别/)
})
