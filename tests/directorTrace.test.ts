import assert from 'node:assert/strict'
import test from 'node:test'
import { assertJsonSerializable, type AgentMessage } from '@earendil-works/pi-agent-core'
import { summarizeAssistantUsage, toDurableMessage, toDurableValue } from '../server/directorTrace.ts'

test('removes undefined properties before persisting an agent message', () => {
  const message = {
    role: 'toolResult',
    toolCallId: 'tool-1',
    toolName: 'publish_scene',
    content: [{ type: 'text', text: 'ok' }],
    details: { outcome: 'success' },
    usage: undefined,
    isError: false,
    timestamp: 1,
  } as AgentMessage

  const durable = toDurableMessage(message)

  assert.throws(() => assertJsonSerializable(message), /contains undefined/)
  assert.doesNotThrow(() => assertJsonSerializable(durable))
  assert.equal(Object.hasOwn(durable, 'usage'), false)
  assert.deepEqual(durable, {
    role: 'toolResult',
    toolCallId: 'tool-1',
    toolName: 'publish_scene',
    content: [{ type: 'text', text: 'ok' }],
    details: { outcome: 'success' },
    isError: false,
    timestamp: 1,
  })
})

test('removes undefined values from arbitrary durable session data', () => {
  const durable = toDurableValue({ nextBeat: undefined, foreshadowing: ['missing seal'] })
  assert.deepEqual(durable, { foreshadowing: ['missing seal'] })
  assert.doesNotThrow(() => assertJsonSerializable(durable))
})

test('keeps real usage when a later synthetic error message has zero tokens', () => {
  const successful = {
    role: 'assistant',
    content: [],
    api: 'openai-completions',
    provider: 'deepseek',
    model: 'deepseek-v4-flash',
    usage: {
      input: 2089,
      output: 657,
      reasoning: 247,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2746,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.00047642 },
    },
    stopReason: 'toolUse',
    timestamp: 1,
  } as AgentMessage
  const syntheticError = {
    role: 'assistant',
    content: [{ type: 'text', text: '' }],
    api: 'openai-completions',
    provider: 'deepseek',
    model: 'deepseek-v4-flash',
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'error',
    errorMessage: 'trace write failed',
    timestamp: 2,
  } as AgentMessage

  assert.deepEqual(summarizeAssistantUsage([successful, syntheticError]), {
    input: 2089,
    output: 657,
    reasoning: 247,
    cacheRead: 0,
    totalTokens: 2746,
    cost: 0.00047642,
  })
})
