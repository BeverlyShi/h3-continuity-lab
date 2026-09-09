import assert from 'node:assert/strict'
import test from 'node:test'
import {
  fetchDirectorTurnState,
  parseDirectorEvent,
  resumeDirectorTurn,
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
  videoPrompts: [
    { sequence: 1, startTime: 0, endTime: 5, characterIds: ['heroine'], prompt: '宫门缓缓关闭，沈清禾站在队伍末尾回头凝望，固定中景镜头。' },
    { sequence: 2, startTime: 5, endTime: 15, characterIds: ['heroine'], prompt: '开场延续上一画面，沈清禾保持回头姿势，随后跟上向前移动的队伍。' },
  ],
} as const

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
    assert.deepEqual(result, { scene, characters, video, paused: false })
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
    JSON.stringify({ type: 'video_plan', video }),
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

    assert.deepEqual(result, { scene, characters, casting, video, paused: false })
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

    assert.deepEqual(result, { scene, characters, video: undefined, paused: false })
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

test('reports paused=true and stops without done when the stream ends on awaiting_upload', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => new Response([
    JSON.stringify({ type: 'scene', scene, characters }),
    JSON.stringify({ type: 'awaiting_upload', sequence: 1, toolCallId: 'call-1', prompt: '第一段', seconds: 5, referenceImages: [] }),
  ].join('\n') + '\n', { status: 200 })

  try {
    const result = await streamDirectorTurn({
      context: { ok: true, sessionId: 'session-paused', turn: 1, input: { type: 'start' } },
      traceId: 'trace-paused',
      model: 'google/gemini-2.5-flash-lite',
      onEvent: () => {},
    })
    assert.equal(result.paused, true)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('throws when the stream ends without done or awaiting_upload', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => new Response(
    JSON.stringify({ type: 'scene', scene, characters }) + '\n',
    { status: 200 },
  )

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

test('resumeDirectorTurn posts the tail frame to /api/director/resume with the expected headers and body', async () => {
  const originalFetch = globalThis.fetch
  let requestUrl = ''
  let requestHeaders = new Headers()
  let requestBody: Record<string, unknown> = {}
  globalThis.fetch = async (input, init) => {
    requestUrl = String(input)
    requestHeaders = new Headers(init?.headers)
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>
    return new Response([
      JSON.stringify({ type: 'video_plan', video }),
      JSON.stringify({ type: 'done' }),
    ].join('\n') + '\n', { status: 200 })
  }

  try {
    const receivedEvents: string[] = []
    const result = await resumeDirectorTurn({
      sessionId: 'session-1',
      sequence: 2,
      toolCallId: 'call-2',
      tailFrameDataUrl: 'data:image/jpeg;base64,AAAA',
      durationSeconds: 9.5,
      deepseekApiKey: 'sk-ds-test',
      onEvent: (event) => { receivedEvents.push(event.type) },
    })

    assert.equal(requestUrl, '/api/director/resume')
    assert.equal(requestHeaders.get('X-DeepSeek-Key'), 'sk-ds-test')
    assert.deepEqual(requestBody, {
      sessionId: 'session-1', sequence: 2, toolCallId: 'call-2',
      tailFrameDataUrl: 'data:image/jpeg;base64,AAAA', durationSeconds: 9.5,
    })
    assert.deepEqual(receivedEvents, ['video_plan', 'done'])
    assert.deepEqual(result, { paused: false, video })
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('resumeDirectorTurn reports paused=true when the turn pauses again on the next segment', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => new Response(
    JSON.stringify({ type: 'awaiting_upload', sequence: 3, toolCallId: 'call-3', prompt: '第三段', seconds: 5, referenceImages: [] }) + '\n',
    { status: 200 },
  )

  try {
    const result = await resumeDirectorTurn({
      sessionId: 'session-1',
      sequence: 2,
      toolCallId: 'call-2',
      tailFrameDataUrl: 'data:image/jpeg;base64,AAAA',
      durationSeconds: 9.5,
      onEvent: () => {},
    })
    assert.deepEqual(result, { paused: true, video: undefined })
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('fetchDirectorTurnState requests the sessionId and returns the parsed status', async () => {
  const originalFetch = globalThis.fetch
  let requestUrl = ''
  globalThis.fetch = async (input) => {
    requestUrl = String(input)
    return new Response(JSON.stringify({ status: 'awaiting_upload', awaiting: { sequence: 1, toolCallId: 'call-1', prompt: 'p', seconds: 5, referenceImages: [], traceId: 't-1' } }), { status: 200 })
  }

  try {
    const result = await fetchDirectorTurnState('session-42')
    assert.equal(requestUrl, '/api/director/turn-state?sessionId=session-42')
    assert.equal(result.status, 'awaiting_upload')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('fetchDirectorTurnState throws the server error message on failure', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => new Response(JSON.stringify({ error: '缺少会话 ID。' }), { status: 400 })

  try {
    await assert.rejects(fetchDirectorTurnState(''), /缺少会话 ID/)
  } finally {
    globalThis.fetch = originalFetch
  }
})
