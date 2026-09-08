import assert from 'node:assert/strict'
import test from 'node:test'
import type { Entry, ShouldStopAfterTurnContext } from '@earendil-works/pi-agent-core/node'
import {
  createRetryingStopCondition,
  getDirectorStreamPolicy,
  stripTrailingFailedTurns,
} from '../server/directorAgent.ts'

const usage = {
  input: 1,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
}

const userEntry = (seq: number, text = `user-${seq}`): Entry => ({
  type: 'message',
  id: `entry-${seq}`,
  seq,
  parentId: seq > 1 ? `entry-${seq - 1}` : null,
  timestamp: seq,
  message: {
    role: 'user',
    content: [{ type: 'text', text }],
    timestamp: seq,
  },
})

const assistantEntry = (
  seq: number,
  stopReason: 'stop' | 'length' | 'error' | 'toolUse',
): Entry => ({
  type: 'message',
  id: `entry-${seq}`,
  seq,
  parentId: seq > 1 ? `entry-${seq - 1}` : null,
  timestamp: seq,
  message: {
    role: 'assistant',
    content: [],
    api: 'openai-completions',
    provider: 'openrouter',
    model: 'test-model',
    usage,
    stopReason,
    timestamp: seq,
  },
})

test('disables Gemini thinking with a larger output budget', () => {
  assert.deepEqual(getDirectorStreamPolicy('google/gemini-2.5-flash-lite'), {
    maxTokens: 4_096,
    samplingParams: { reasoning: { max_tokens: 0 } },
  })
})

test('uses low reasoning and avoids Darkbloom for GPT-OSS', () => {
  assert.deepEqual(getDirectorStreamPolicy('openai/gpt-oss-20b'), {
    maxTokens: 4_096,
    reasoning: 'low',
    samplingParams: {
      provider: {
        ignore: ['darkbloom'],
        allow_fallbacks: true,
      },
    },
  })
})

test('enables DeepSeek reasoning with room for thinking and structured tool arguments', () => {
  assert.deepEqual(getDirectorStreamPolicy('deepseek-v4-flash', true), {
    maxTokens: 16_384,
    reasoning: 'high',
  })
})

test('removes one trailing failed user and assistant turn', () => {
  const successfulHistory = [userEntry(1), assistantEntry(2, 'stop')]
  const entries = [...successfulHistory, userEntry(3), assistantEntry(4, 'length')]

  assert.deepEqual(stripTrailingFailedTurns(entries), successfulHistory)
})

test('removes multiple consecutive trailing failed turns', () => {
  const successfulHistory = [userEntry(1), assistantEntry(2, 'stop')]
  const entries = [
    ...successfulHistory,
    userEntry(3),
    assistantEntry(4, 'length'),
    userEntry(5),
    assistantEntry(6, 'error'),
  ]

  assert.deepEqual(stripTrailingFailedTurns(entries), successfulHistory)
})

test('keeps successful trailing history unchanged', () => {
  const entries = [userEntry(1), assistantEntry(2, 'stop')]

  assert.strictEqual(stripTrailingFailedTurns(entries), entries)
})

const toolResultContext = (isError: boolean): ShouldStopAfterTurnContext => ({
  message: {
    role: 'assistant',
    content: [],
    api: 'openai-completions',
    provider: 'openrouter',
    model: 'test-model',
    usage,
    stopReason: 'toolUse',
    timestamp: 0,
  },
  toolResults: [{
    role: 'toolResult',
    toolCallId: 'call-1',
    toolName: 'publish_scene',
    content: [{ type: 'text', text: isError ? 'invalid' : 'ok' }],
    details: {},
    isError,
    timestamp: 0,
  }],
  context: { systemPrompt: '', messages: [] },
  newMessages: [],
})

test('retries a failed tool call up to the configured attempt count before stopping', () => {
  const shouldStop = createRetryingStopCondition(3, () => false)

  assert.equal(shouldStop(toolResultContext(true)), false, 'first failure should retry')
  assert.equal(shouldStop(toolResultContext(true)), false, 'second failure should retry once more')
  assert.equal(shouldStop(toolResultContext(true)), true, 'third failure exhausts retries and stops')
})

test('surfaces the failing tool result text through onToolError before exhausting retries', () => {
  const receivedErrors: string[] = []
  const shouldStop = createRetryingStopCondition(3, () => false, (message) => receivedErrors.push(message))

  assert.equal(shouldStop(toolResultContext(true)), false)
  assert.equal(shouldStop(toolResultContext(true)), false)
  assert.equal(shouldStop(toolResultContext(true)), true, 'stops after the third consecutive failure')
  assert.deepEqual(receivedErrors, ['invalid', 'invalid', 'invalid'])
})

test('continues after publish_scene and stops after the whole agent turn is complete', () => {
  let complete = false
  const shouldStop = createRetryingStopCondition(3, () => complete)

  assert.equal(shouldStop(toolResultContext(true)), false, 'first failure should retry')
  assert.equal(shouldStop(toolResultContext(false)), false, 'publishing the scene keeps the tool loop running')
  complete = true
  assert.equal(shouldStop(toolResultContext(false)), true, 'the completed video plan stops the loop')
})

test('keeps a non-trailing failed turn', () => {
  const entries = [
    userEntry(1),
    assistantEntry(2, 'error'),
    userEntry(3),
    assistantEntry(4, 'toolUse'),
  ]

  assert.strictEqual(stripTrailingFailedTurns(entries), entries)
})

test('enables GLM thinking with enough output budget', () => {
  assert.deepEqual(getDirectorStreamPolicy('z-ai/glm-5.3-flash', true), { maxTokens: 16_384, reasoning: 'high' })
})

for (const modelId of ['deepseek-v4-flash', 'z-ai/glm-5.3-flash'] as const) {
  test(`${modelId} defaults to its fastest supported thinking mode`, () => {
    assert.deepEqual(getDirectorStreamPolicy(modelId), { maxTokens: 16_384, reasoning: modelId === 'z-ai/glm-5.3-flash' ? 'low' : undefined })
    assert.deepEqual(getDirectorStreamPolicy(modelId, false), getDirectorStreamPolicy(modelId))
  })
}
