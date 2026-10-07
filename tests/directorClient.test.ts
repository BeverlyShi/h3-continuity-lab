import assert from 'node:assert/strict'
import test from 'node:test'
import {
  parseDirectorEvent,
  readDirectorStream,
  streamDirectorRewrite,
  streamDirectorTurn,
} from '../src/services/directorClient.ts'

const scene = {
  title: '宫门初雪',
  narrative: '宫门在身后缓缓合拢，沈清禾第一次听见深宫里的晨钟。细雪落在朱红宫墙下，教引嬷嬷催促秀女们向前，她却发现同行少女悄悄塞来一方绣帕。绣帕角落绣着禁军纹样，远处又有人停步回望。沈清禾把手藏进袖中，前方嬷嬷忽然点到她的名字，身旁少女低声让她千万别交出去。队伍即将转过宫门，再迟一步便会被人看见，她必须立刻决定如何应对。',
  choices: [
    { id: '1', text: '把绣帕交给嬷嬷' },
    { id: '2', text: '替少女暂时藏好' },
    { id: '3', text: '假装失手丢在雪中' },
  ],
} as const

const characters = [
  { id: 'heroine', name: '沈清禾', gender: 'female', minAge: 16, maxAge: 20 },
] as const

const video = {
  totalDuration: 15,
  style: '冷色写实，宫灯暖光，细雪飘落。',
  videoPrompts: [
    { sequence: 1, startTime: 0, endTime: 5, characterIds: ['heroine'], prompt: '宫门缓缓关闭，沈清禾站在队伍末尾回头凝望，固定中景镜头。' },
    { sequence: 2, startTime: 5, endTime: 15, characterIds: ['heroine'], prompt: '开场延续上一画面，沈清禾保持回头姿势，随后跟上向前移动的队伍。' },
  ],
} as const

const references = [
  [{ type: 'character', characterId: 'heroine', actorId: 'actor-a' }],
  [{ type: 'start_frame', sequence: 1 }],
] as const

test('parses a streamed scene event', () => {
  const event = parseDirectorEvent(JSON.stringify({
    type: 'scene',
    scene,
    characters,
  }))

  assert.equal(event.type, 'scene')
  if (event.type === 'scene') assert.equal(event.scene.choices.length, 3)
})

test('rejects a malformed director stream value', () => {
  assert.throws(() => parseDirectorEvent('[]'), /无法识别/)
})

test('sends the selected model and OpenRouter key, resolving with the scene and video plan', async () => {
  const originalFetch = globalThis.fetch
  let requestHeaders = new Headers()
  let requestBody: { model?: string; actors?: unknown[]; castings?: unknown[] } = {}
  globalThis.fetch = async (_input, init) => {
    requestHeaders = new Headers(init?.headers)
    requestBody = JSON.parse(String(init?.body)) as { model?: string }
    return new Response([
      JSON.stringify({ type: 'scene', scene, characters }),
      JSON.stringify({ type: 'video_plan', video, references, fromSequence: 1 }),
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
      actors: [{ id: 'actor-a', name: '演员甲', gender: 'female', minAge: 16, maxAge: 24 }],
      castings: [{ characterId: 'heroine', actorId: 'actor-a' }],
      model: 'google/gemini-2.5-flash-lite',
      onEvent: (event) => { receivedEvents.push(event.type) },
    })

    assert.equal(requestHeaders.get('X-OpenRouter-Key'), 'sk-or-test')
    assert.equal(requestHeaders.get('X-DeepSeek-Key'), null)
    assert.equal(requestBody.model, 'google/gemini-2.5-flash-lite')
    assert.equal(requestBody.actors?.length, 1)
    assert.equal(requestBody.castings?.length, 1)
    assert.deepEqual(receivedEvents, ['scene', 'video_plan', 'done'])
    assert.deepEqual(result, { scene, characters, video })
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('streams a cast result for the frontend to resolve actor reference images', async () => {
  const originalFetch = globalThis.fetch
  const casting = {
    castings: [{ characterId: 'heroine', actorId: 'actor-a' }],
    unmatchedCharacterIds: [],
  }
  globalThis.fetch = async () => new Response([
    JSON.stringify({ type: 'scene', scene, characters }),
    JSON.stringify({ type: 'cast', casting }),
    JSON.stringify({ type: 'video_plan', video, references, fromSequence: 1 }),
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
      traceId: 'trace-cast',
      model: 'google/gemini-2.5-flash-lite',
      onEvent: () => {},
    })

    assert.deepEqual(result, { scene, characters, casting, video })
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

test('sends an independent BigModel key for the official GLM route', async () => {
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
      bigModelApiKey: 'sk-bigmodel-test',
      context: {
        ok: true,
        sessionId: 'session-1',
        turn: 1,
        input: { type: 'start' },
      },
      traceId: 'trace-1',
      model: 'z-ai/glm-5.3-flash',
      onEvent: () => {},
    })

    assert.equal(requestHeaders.get('X-OpenRouter-Key'), 'sk-or-test')
    assert.equal(requestHeaders.get('X-DeepSeek-Key'), 'sk-ds-test')
    assert.equal(requestHeaders.get('X-BigModel-Key'), 'sk-bigmodel-test')
    assert.equal(requestBody.model, 'z-ai/glm-5.3-flash')
  } finally {
    globalThis.fetch = originalFetch
  }
})

for (const thinkingEnabled of [undefined, false, true]) {
  test(`forwards the thinking setting ${thinkingEnabled}, defaulting to off`, async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = async (_url, init) => {
      assert.equal(JSON.parse(String(init?.body)).thinkingEnabled, thinkingEnabled ?? false)
      return new Response([
        JSON.stringify({ type: 'scene', scene, characters }),
        JSON.stringify({ type: 'done' }),
      ].join('\n') + '\n')
    }
    try {
      await streamDirectorTurn({
        model: 'deepseek-v4-flash', thinkingEnabled,
        context: { ok: true, sessionId: 'thinking-setting', turn: 1, input: { type: 'start' } },
        traceId: 'thinking-setting', onEvent: () => {},
      })
    } finally {
      globalThis.fetch = originalFetch
    }
  })
}

test('forwards the previous scene tail frame in the turn context', async () => {
  const originalFetch = globalThis.fetch
  let requestBody: { context?: { previousScene?: unknown } } = {}
  globalThis.fetch = async (_input, init) => {
    requestBody = JSON.parse(String(init?.body)) as typeof requestBody
    return new Response([
      JSON.stringify({ type: 'scene', scene, characters }),
      JSON.stringify({ type: 'done' }),
    ].join('\n') + '\n')
  }
  const previousScene = { tailFrameDataUrl: 'data:image/jpeg;base64,AAAA', characters: [...characters] }

  try {
    await streamDirectorTurn({
      context: { ok: true, sessionId: 'session-previous', turn: 2, input: { type: 'start' }, previousScene },
      traceId: 'trace-previous',
      model: 'google/gemini-2.5-flash-lite',
      onEvent: () => {},
    })
    assert.deepEqual(requestBody.context?.previousScene, previousScene)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('throws when the stream ends without done', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => new Response([
    JSON.stringify({ type: 'scene', scene, characters }),
    JSON.stringify({ type: 'video_plan', video, references, fromSequence: 1 }),
  ].join('\n') + '\n', { status: 200 })

  try {
    await assert.rejects(streamDirectorTurn({
      context: { ok: true, sessionId: 'session-broken', turn: 1, input: { type: 'start' } },
      traceId: 'trace-broken',
      model: 'google/gemini-2.5-flash-lite',
      onEvent: () => {},
    }), /意外中断/)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('readDirectorStream surfaces a streamed error event', async () => {
  const response = new Response([
    JSON.stringify({ type: 'status', text: '导演正在构思' }),
    JSON.stringify({ type: 'error', error: '模型请求失败' }),
  ].join('\n'))
  const received: string[] = []
  await assert.rejects(readDirectorStream(response, (event) => { received.push(event.type) }), /模型请求失败/)
  assert.deepEqual(received, ['status', 'error'])
})

test('readDirectorStream accepts a final done line without a trailing newline', async () => {
  const response = new Response([
    JSON.stringify({ type: 'status', text: '导演正在构思' }),
    JSON.stringify({ type: 'done' }),
  ].join('\n'))
  await readDirectorStream(response, () => {})
})

test('streamDirectorRewrite posts the rewrite request and resolves with the new plan', async () => {
  const originalFetch = globalThis.fetch
  let requestUrl = ''
  let requestHeaders = new Headers()
  let requestBody: Record<string, unknown> = {}
  const rewritePlan = { type: 'video_plan', video, references, fromSequence: 2 }
  globalThis.fetch = async (input, init) => {
    requestUrl = String(input)
    requestHeaders = new Headers(init?.headers)
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>
    return new Response([
      JSON.stringify(rewritePlan),
      JSON.stringify({ type: 'done' }),
    ].join('\n') + '\n', { status: 200 })
  }

  try {
    const received: unknown[] = []
    const result = await streamDirectorRewrite({
      deepseekApiKey: 'sk-ds-test',
      sessionId: 'session-1',
      sequence: 2,
      reason: '人物站位和上一段对不上',
      traceId: 'trace-rewrite',
      actors: [{ id: 'actor-a', name: '演员甲', gender: 'female', minAge: 16, maxAge: 24 }],
      model: 'deepseek-v4-flash',
      thinkingEnabled: true,
      onEvent: (event) => { received.push(event) },
    })

    assert.equal(requestUrl, '/api/director/rewrite')
    assert.equal(requestHeaders.get('X-DeepSeek-Key'), 'sk-ds-test')
    assert.deepEqual(requestBody, {
      sessionId: 'session-1',
      sequence: 2,
      reason: '人物站位和上一段对不上',
      traceId: 'trace-rewrite',
      actors: [{ id: 'actor-a', name: '演员甲', gender: 'female', minAge: 16, maxAge: 24 }],
      model: 'deepseek-v4-flash',
      thinkingEnabled: true,
    })
    assert.deepEqual(received, [rewritePlan, { type: 'done' }])
    assert.deepEqual(result, { video })
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('streamDirectorRewrite throws the server error message on failure', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => new Response(JSON.stringify({ error: '当前场次没有可重写的分镜。' }), { status: 409 })

  try {
    await assert.rejects(streamDirectorRewrite({
      sessionId: 'session-1',
      sequence: 1,
      reason: '换个开场',
      traceId: 'trace-rewrite-error',
      model: 'deepseek-v4-flash',
      onEvent: () => {},
    }), /没有可重写的分镜/)
  } finally {
    globalThis.fetch = originalFetch
  }
})
