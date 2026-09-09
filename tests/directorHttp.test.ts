import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer as createHttpServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createServer, type ViteDevServer } from 'vite'
import { SCENE_PUBLISH_ARGUMENTS_EXAMPLE } from '../server/publishSceneTool.ts'
import { WRITE_SEGMENT_ARGUMENTS_EXAMPLE_FIRST, WRITE_SEGMENT_ARGUMENTS_EXAMPLE_NEXT } from '../server/writeSegmentTool.ts'
import type { TailFrameVisualState } from '../src/types/story.ts'
import { installScriptedProvider, type ScriptedStep } from './helpers/scriptedProvider.ts'

const fakeVisualState: TailFrameVisualState = {
  shot_size: '中景',
  shot_position: '人物正前方',
  shot_content: {
    characters: [],
    scene: { location: '宫廊', visible_elements: '木廊', lighting: '柔光', time_of_day: '白天' },
    key_props: [],
  },
  frame_quality: '清晰稳定',
}

const scene = JSON.parse(SCENE_PUBLISH_ARGUMENTS_EXAMPLE)
const write1 = JSON.parse(WRITE_SEGMENT_ARGUMENTS_EXAMPLE_FIRST)
const write2 = JSON.parse(WRITE_SEGMENT_ARGUMENTS_EXAMPLE_NEXT)

// directorPlugin.ts 通过 directorAgent.ts 在模块顶层按导入时的 cwd 固定 trace 根目录；
// 每个用例都用独立临时目录，所以用查询串绕开 ESM 模块缓存，强制每次重新加载。
let freshImportCounter = 0
const withServer = async (
  run: (ctx: { baseUrl: string; fetch: typeof globalThis.fetch }) => Promise<void>,
) => {
  const previousCwd = process.cwd()
  const directory = await mkdtemp(join(tmpdir(), 'director-http-'))
  process.chdir(directory)
  freshImportCounter += 1
  // 保存真实 fetch：installScriptedProvider 会整体替换 globalThis.fetch 来拦截服务端对 AI provider 的请求，
  // 测试自己对本地 vite server 的请求必须绕开这个 mock。
  const realFetch = globalThis.fetch
  const { directorPlugin } = await import(`../server/directorPlugin.ts?fresh=${freshImportCounter}`)
  let vite: ViteDevServer | undefined
  let http: Server | undefined
  try {
    vite = await createServer({ configFile: false, plugins: [directorPlugin({ analyzeTailFrame: async () => fakeVisualState })], server: { middlewareMode: true }, appType: 'custom' })
    http = createHttpServer(vite.middlewares)
    await new Promise<void>((res) => http!.listen(0, '127.0.0.1', res))
    const address = http.address()
    assert.ok(address && typeof address !== 'string')
    await run({ baseUrl: `http://127.0.0.1:${address.port}`, fetch: realFetch })
  } finally {
    globalThis.fetch = realFetch
    if (http) await new Promise<void>((res, reject) => http!.close((error) => (error ? reject(error) : res())))
    if (vite) await vite.close()
    process.chdir(previousCwd)
    await rm(directory, { recursive: true, force: true })
  }
}

const readNdjson = async (response: Response) =>
  (await response.text()).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))

test('the director endpoint runs the single agent for both official providers with the thinking switch applied to every call', async () => {
  await withServer(async ({ baseUrl, fetch }) => {
    for (const model of ['deepseek-v4-flash', 'z-ai/glm-5.3-flash'] as const) {
      const isGlm = model === 'z-ai/glm-5.3-flash'
      for (const thinkingEnabled of [undefined, true, false]) {
        const provider = installScriptedProvider([
          { tool: 'publish_scene', args: scene, reasoning: '构思场景。' },
          { tool: 'cast_scene', args: { assignments: [{ characterId: 'steward', create: { name: '崔姑姑', appearance: '四十五岁上下，面容清瘦端严，乌发圆髻，深青窄袖宫装' }, reason: '演员库为空' }] }, reasoning: '新建演员。' },
          { tool: 'finish_turn', args: {}, reasoning: '结束。' },
        ])
        try {
          const response = await fetch(`${baseUrl}/api/director/turn`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-DeepSeek-Key': 'test-key', 'X-BigModel-Key': 'test-key' },
            body: JSON.stringify({ model, thinkingEnabled, videoMode: 'off', traceId: `${model}-${thinkingEnabled}`, actors: [], castings: [], context: {
              ok: true, sessionId: `http-${model.replaceAll('/', '-')}`, turn: 1, input: { type: 'start' },
            } }),
          })
          const events = await readNdjson(response)
          assert.deepEqual(events.filter((event) => event.type === 'error' || event.type === 'video_plan_error'), [])
          assert.deepEqual(events.map((event) => event.type).filter((type) => ['scene', 'cast', 'done'].includes(type)), ['scene', 'cast', 'done'])
          assert.equal(provider.remaining(), 0)
          for (const request of provider.requests) {
            assert.equal(request.url, isGlm ? 'https://open.bigmodel.cn/api/paas/v4/chat/completions' : 'https://api.deepseek.com/chat/completions')
            assert.equal(request.headers.get('Authorization'), 'Bearer test-key')
            assert.equal(request.body.model, isGlm ? 'glm-5.3-flash' : model)
            assert.equal(request.body.thinking?.type, isGlm || thinkingEnabled ? 'enabled' : 'disabled')
            assert.equal(request.body.reasoning_effort, thinkingEnabled ? 'high' : isGlm ? 'low' : undefined)
            if (isGlm) assert.equal(request.body.thinking?.clear_thinking, false)
            assert.equal(request.body.max_tokens, 16_384)
            assert.equal('tool_choice' in request.body, false)
            assert.deepEqual(request.body.tools?.map((tool) => tool.function.name), ['publish_scene', 'cast_scene', 'finish_turn'])
          }
          // 同一回合内后续请求回放了此前的思考内容。
          const assistants = provider.requests[2].body.messages.filter((message) => message.role === 'assistant')
          assert.equal(assistants.length, 2)
        } finally {
          provider.restore()
        }
      }
    }

    const invalid = await fetch(`${baseUrl}/api/director/turn`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-DeepSeek-Key': 'test-key' },
      body: JSON.stringify({ model: 'deepseek-v4-flash', videoMode: 'sometimes', traceId: 'invalid-mode', actors: [], castings: [], context: {
        ok: true, sessionId: 'http-invalid-mode', turn: 1, input: { type: 'start' },
      } }),
    })
    assert.match(await invalid.text(), /视频模式设置无效/)

    for (const actor of [
      { id: 'actor-a', name: '演员甲', gender: 'female', minAge: 16, maxAge: 24 },
      { id: 'actor-a', name: '演员甲', gender: 'female', minAge: 16, maxAge: 24, hasImage: 'yes' },
    ]) {
      const badActors = await fetch(`${baseUrl}/api/director/turn`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-DeepSeek-Key': 'test-key' },
        body: JSON.stringify({ model: 'deepseek-v4-flash', videoMode: 'manual', traceId: 'invalid-actors', actors: [actor], castings: [], context: {
          ok: true, sessionId: 'http-invalid-actors', turn: 1, input: { type: 'start' },
        } }),
      })
      assert.match(await badActors.text(), /演员库数据无效/)
    }
  })
})

const castAssignments = { assignments: [
  { characterId: 'heroine', actorId: 'actor-young', reason: '年龄相符' },
  { characterId: 'steward', actorId: 'actor-elder', reason: '四十多岁，面相端严' },
] }
const actors = [
  { id: 'actor-young', name: '演员甲', gender: 'female', minAge: 16, maxAge: 22, hasImage: true },
  { id: 'actor-elder', name: '演员乙', gender: 'female', minAge: 40, maxAge: 55, hasImage: true },
]

test('a segment turn pauses over HTTP; GET turn-state reports it and POST resume drives it to completion', async () => {
  await withServer(async ({ baseUrl, fetch }) => {
    const script: ScriptedStep[] = [
      { tool: 'publish_scene', args: scene },
      { tool: 'cast_scene', args: castAssignments },
      { tool: 'write_segment', args: write1 },
      { tool: 'generate_segment', args: { sequence: 1 } },
      { tool: 'write_segment', args: write2 },
      { tool: 'generate_segment', args: { sequence: 2 } },
      { tool: 'finish_turn', args: {} },
    ]
    const provider = installScriptedProvider(script)
    try {
      const idle = await fetch(`${baseUrl}/api/director/turn-state?sessionId=http-segment`)
      assert.deepEqual(await idle.json(), { status: 'idle' })

      const turnResponse = await fetch(`${baseUrl}/api/director/turn`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-DeepSeek-Key': 'test-key' },
        body: JSON.stringify({
          model: 'deepseek-v4-flash', videoMode: 'manual', traceId: 'http-segment-1', actors, castings: [],
          context: { ok: true, sessionId: 'http-segment', turn: 1, input: { type: 'start' } },
        }),
      })
      const events = await readNdjson(turnResponse)
      assert.equal(events.some((event) => event.type === 'awaiting_upload'), true)
      assert.equal(events.some((event) => event.type === 'done'), false)
      const awaiting1 = events.find((event) => event.type === 'awaiting_upload')

      const turnState = await fetch(`${baseUrl}/api/director/turn-state?sessionId=http-segment`)
      const turnStateBody = await turnState.json()
      assert.equal(turnStateBody.status, 'awaiting_upload')
      assert.equal(turnStateBody.awaiting.sequence, 1)
      assert.equal(turnStateBody.awaiting.toolCallId, awaiting1.toolCallId)

      const resume1 = await fetch(`${baseUrl}/api/director/resume`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-DeepSeek-Key': 'test-key' },
        body: JSON.stringify({
          sessionId: 'http-segment', sequence: 1, toolCallId: awaiting1.toolCallId,
          tailFrameDataUrl: 'data:image/png;base64,AAAA', durationSeconds: 5.2,
        }),
      })
      const resumeEvents1 = await readNdjson(resume1)
      assert.equal(resumeEvents1.filter((event) => event.type === 'error').length, 0)
      const awaiting2 = resumeEvents1.find((event) => event.type === 'awaiting_upload')
      assert.ok(awaiting2)
      assert.equal(awaiting2.sequence, 2)

      const resume2 = await fetch(`${baseUrl}/api/director/resume`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-DeepSeek-Key': 'test-key' },
        body: JSON.stringify({
          sessionId: 'http-segment', sequence: 2, toolCallId: awaiting2.toolCallId,
          tailFrameDataUrl: 'data:image/png;base64,BBBB', durationSeconds: 9.9,
        }),
      })
      const resumeEvents2 = await readNdjson(resume2)
      assert.equal(resumeEvents2.filter((event) => event.type === 'error').length, 0)
      assert.equal(resumeEvents2.some((event) => event.type === 'video_plan'), true)
      assert.equal(resumeEvents2.some((event) => event.type === 'scene_visual_state'), true)
      assert.equal(resumeEvents2.at(-1)?.type, 'done')
      assert.equal(provider.remaining(), 0)

      const idleAgain = await fetch(`${baseUrl}/api/director/turn-state?sessionId=http-segment`)
      assert.deepEqual(await idleAgain.json(), { status: 'idle' })
    } finally {
      provider.restore()
    }
  })
})

test('validates the resume endpoint parameters', async () => {
  await withServer(async ({ baseUrl, fetch }) => {
    const post = (body: unknown, headers: Record<string, string> = { 'X-DeepSeek-Key': 'test-key' }) =>
      fetch(`${baseUrl}/api/director/resume`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(body),
      })

    assert.match((await readNdjson(await post({})))[0].error, /缺少会话 ID/)
    assert.match((await readNdjson(await post({ sessionId: 's', sequence: 0, toolCallId: 't', tailFrameDataUrl: 'data:image/png;base64,A', durationSeconds: 1 })))[0].error, /段号无效/)
    assert.match((await readNdjson(await post({ sessionId: 's', sequence: 1, tailFrameDataUrl: 'data:image/png;base64,A', durationSeconds: 1 })))[0].error, /缺少工具调用 ID/)
    assert.match((await readNdjson(await post({ sessionId: 's', sequence: 1, toolCallId: 't', tailFrameDataUrl: 'not-a-data-url', durationSeconds: 1 })))[0].error, /data:image\//)
    assert.match((await readNdjson(await post({ sessionId: 's', sequence: 1, toolCallId: 't', tailFrameDataUrl: 'data:image/png;base64,A', durationSeconds: 0 })))[0].error, /视频实际时长无效/)
    assert.match(
      (await readNdjson(await post({ sessionId: 's', sequence: 1, toolCallId: 't', tailFrameDataUrl: 'data:image/png;base64,A', durationSeconds: 1 }, {})))[0].error,
      /DEEPSEEK_API_KEY/,
    )
    assert.match(
      (await readNdjson(await post({ sessionId: 'no-such-session', sequence: 1, toolCallId: 't', tailFrameDataUrl: 'data:image/png;base64,A', durationSeconds: 1 })))[0].error,
      /当前没有等待上传的视频段/,
    )
  })
})

test('validates the turn-state endpoint and reports idle for unknown sessions', async () => {
  await withServer(async ({ baseUrl, fetch }) => {
    const missing = await fetch(`${baseUrl}/api/director/turn-state`)
    assert.equal(missing.status, 400)
    assert.match((await missing.json()).error, /缺少会话 ID/)

    const unknown = await fetch(`${baseUrl}/api/director/turn-state?sessionId=never-created`)
    assert.equal(unknown.status, 200)
    assert.deepEqual(await unknown.json(), { status: 'idle' })
  })
})
