import assert from 'node:assert/strict'
import test from 'node:test'
import { parseDirectorEvent, streamDirectorTurn } from '../src/services/directorClient.ts'

const scene = {
  title: '宫门初雪',
  narrative: '宫门在身后缓缓合拢，沈清禾第一次听见深宫里的晨钟。',
  choices: [
    { id: 'A', text: '跟上教引嬷嬷' },
    { id: 'B', text: '回头看一眼宫门' },
  ],
} as const

const characters = [
  { id: 'heroine', name: '沈清禾', gender: 'female', minAge: 16, maxAge: 20 },
] as const

const video = {
  totalDuration: 15,
  videoPrompts: [
    { sequence: 1, startTime: 0, endTime: 5, characterIds: ['heroine'], prompt: '宫门缓缓关闭，沈清禾站在队伍末尾回头凝望，固定中景镜头。' },
    { sequence: 2, startTime: 5, endTime: 15, transitionFromPrevious: 'continuous', characterIds: ['heroine'], prompt: '开场延续上一画面，沈清禾保持回头姿势，随后跟上向前移动的队伍。' },
  ],
} as const

test('parses a streamed scene event', () => {
  const event = parseDirectorEvent(JSON.stringify({
    type: 'scene',
    scene,
    characters,
  }))

  assert.equal(event.type, 'scene')
  if (event.type === 'scene') assert.equal(event.scene.choices.length, 2)
})

test('rejects a malformed director stream value', () => {
  assert.throws(() => parseDirectorEvent('[]'), /无法识别/)
})

test('sends the selected model and OpenRouter key, resolving with the scene and video plan', async () => {
  const originalFetch = globalThis.fetch
  let requestHeaders = new Headers()
  let requestBody: { model?: string } = {}
  globalThis.fetch = async (_input, init) => {
    requestHeaders = new Headers(init?.headers)
    requestBody = JSON.parse(String(init?.body)) as { model?: string }
    return new Response([
      JSON.stringify({ type: 'scene', scene, characters }),
      JSON.stringify({ type: 'video_plan', video }),
      JSON.stringify({ type: 'done' }),
    ].join('\n') + '\n', { status: 200 })
  }

  try {
    const receivedEvents: string[] = []
    const result = await streamDirectorTurn({
      openRouterApiKey: 'sk-or-test',
      context: {
        ok: true,
        sessionId: 'session-1',
        turn: 1,
        input: { type: 'start' },
      },
      traceId: 'trace-1',
      model: 'google/gemini-2.5-flash-lite',
      onEvent: (event) => { receivedEvents.push(event.type) },
    })

    assert.equal(requestHeaders.get('X-OpenRouter-Key'), 'sk-or-test')
    assert.equal(requestHeaders.get('X-DeepSeek-Key'), null)
    assert.equal(requestBody.model, 'google/gemini-2.5-flash-lite')
    assert.deepEqual(receivedEvents, ['scene', 'video_plan', 'done'])
    assert.deepEqual(result, { scene, characters, video })
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('resolves once the scene arrives even if the video plan fails', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => new Response([
    JSON.stringify({ type: 'scene', scene, characters }),
    JSON.stringify({ type: 'video_plan_error', message: '视频计划生成失败' }),
    JSON.stringify({ type: 'done' }),
  ].join('\n') + '\n', { status: 200 })

  try {
    const result = await streamDirectorTurn({
      openRouterApiKey: 'sk-or-test',
      context: {
        ok: true,
        sessionId: 'session-1',
        turn: 1,
        input: { type: 'start' },
      },
      traceId: 'trace-1',
      model: 'google/gemini-2.5-flash-lite',
      onEvent: () => {},
    })

    assert.deepEqual(result, { scene, characters, video: undefined })
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('sends the DeepSeek key when the selected model routes through DeepSeek', async () => {
  const originalFetch = globalThis.fetch
  let requestHeaders = new Headers()
  let requestBody: { model?: string } = {}
  globalThis.fetch = async (_input, init) => {
    requestHeaders = new Headers(init?.headers)
    requestBody = JSON.parse(String(init?.body)) as { model?: string }
    return new Response([
      JSON.stringify({ type: 'scene', scene, characters }),
      JSON.stringify({ type: 'done' }),
    ].join('\n') + '\n', { status: 200 })
  }

  try {
    await streamDirectorTurn({
      openRouterApiKey: 'sk-or-test',
      deepseekApiKey: 'sk-ds-test',
      context: {
        ok: true,
        sessionId: 'session-1',
        turn: 1,
        input: { type: 'start' },
      },
      traceId: 'trace-1',
      model: 'deepseek-v4-flash',
      onEvent: () => {},
    })

    assert.equal(requestHeaders.get('X-OpenRouter-Key'), 'sk-or-test')
    assert.equal(requestHeaders.get('X-DeepSeek-Key'), 'sk-ds-test')
    assert.equal(requestBody.model, 'deepseek-v4-flash')
  } finally {
    globalThis.fetch = originalFetch
  }
})
