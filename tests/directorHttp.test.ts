import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer as createHttpServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createServer, type ViteDevServer } from 'vite'
import { SCENE_PUBLISH_ARGUMENTS_EXAMPLE } from '../server/publishSceneTool.ts'
import { WRITE_SCENE_VIDEO_ARGUMENTS_EXAMPLE } from '../server/writeSceneVideoTool.ts'
import type { TailFrameVisualState } from '../src/types/story.ts'
import { installScriptedProvider } from './helpers/scriptedProvider.ts'

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
const storyboard = JSON.parse(WRITE_SCENE_VIDEO_ARGUMENTS_EXAMPLE)

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
            assert.deepEqual(request.body.tools?.map((tool) => tool.function.name), ['publish_scene', 'cast_scene'])
          }
          // 交齐即停：选角完成后不再多发一次请求；同一场次内后续请求回放了此前的思考内容。
          assert.equal(provider.requests.length, 2)
          const assistants = provider.requests[1].body.messages.filter((message) => message.role === 'assistant')
          assert.equal(assistants.length, 1)
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

test('a scene continues from the previous frame over HTTP, and the rewrite endpoint re-emits the plan from one segment', async () => {
  await withServer(async ({ baseUrl, fetch }) => {
    const rewritten = {
      characters: ['heroine', 'steward'],
      seconds: 10,
      prompt: '0–5秒：承接上一段画面，镜头缓缓推近。女主抬眼看向掌事姑姑。安静。\n\n5–10秒：镜头硬切为女主近景，平视，固定。她把包袱放到身侧。画外传来轻微风声。',
    }
    const provider = installScriptedProvider([
      { tool: 'publish_scene', args: scene },
      { tool: 'cast_scene', args: castAssignments },
      { tool: 'inspect_last_frame', args: {} },
      { tool: 'write_scene_video', args: { ...storyboard, opening: 'continue' } },
      { tool: 'write_scene_video', args: { rewriteSequence: 2, segments: [rewritten] } },
    ])
    try {
      const turnResponse = await fetch(`${baseUrl}/api/director/turn`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-DeepSeek-Key': 'test-key' },
        body: JSON.stringify({
          model: 'deepseek-v4-flash', videoMode: 'comfy', traceId: 'http-scene-1', actors, castings: [],
          context: {
            ok: true, sessionId: 'http-scene', turn: 2, input: { type: 'choice', choice: scene.scene.choices[0] },
            previousScene: { tailFrameDataUrl: 'data:image/jpeg;base64,AAAA', characters: scene.characters },
          },
        }),
      })
      const events = await readNdjson(turnResponse)
      assert.equal(events.filter((event) => event.type === 'error').length, 0)
      const plan = events.find((event) => event.type === 'video_plan')
      assert.deepEqual(plan.references[0].at(-1), { type: 'previous_scene_tail_frame' })
      assert.equal(plan.fromSequence, 1)
      assert.equal(events.at(-1)?.type, 'done')

      const rewriteResponse = await fetch(`${baseUrl}/api/director/rewrite`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-DeepSeek-Key': 'test-key' },
        body: JSON.stringify({ sessionId: 'http-scene', sequence: 2, reason: '人物走位跳了', traceId: 'http-scene-2', actors, model: 'deepseek-v4-flash' }),
      })
      const rewriteEvents = await readNdjson(rewriteResponse)
      assert.equal(rewriteEvents.filter((event) => event.type === 'error').length, 0)
      const replan = rewriteEvents.find((event) => event.type === 'video_plan')
      assert.equal(replan.fromSequence, 2)
      assert.match(replan.video.videoPrompts[1].prompt, /她把包袱放到身侧/)
      assert.equal(rewriteEvents.at(-1)?.type, 'done')
      assert.equal(provider.remaining(), 0)
    } finally {
      provider.restore()
    }
  })
})

test('validates the turn context frame and the rewrite endpoint parameters', async () => {
  await withServer(async ({ baseUrl, fetch }) => {
    const badFrame = await fetch(`${baseUrl}/api/director/turn`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-DeepSeek-Key': 'test-key' },
      body: JSON.stringify({ model: 'deepseek-v4-flash', videoMode: 'manual', traceId: 't', actors: [], castings: [], context: {
        ok: true, sessionId: 'http-bad-frame', turn: 2, input: { type: 'start' },
        previousScene: { tailFrameDataUrl: 'https://example.com/frame.jpg', characters: [] },
      } }),
    })
    assert.match(await badFrame.text(), /故事输入无效/)

    const post = (body: unknown, headers: Record<string, string> = { 'X-DeepSeek-Key': 'test-key' }) =>
      fetch(`${baseUrl}/api/director/rewrite`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(body),
      })
    const valid = { sessionId: 's', sequence: 1, reason: '不满意', traceId: 't', actors: [], model: 'deepseek-v4-flash' }

    assert.match((await readNdjson(await post({})))[0].error, /缺少会话 ID/)
    assert.match((await readNdjson(await post({ ...valid, sequence: 4 })))[0].error, /段号无效/)
    assert.match((await readNdjson(await post({ ...valid, reason: '  ' })))[0].error, /请写明重写原因/)
    assert.match((await readNdjson(await post({ ...valid, model: 'nope' })))[0].error, /不支持该模型/)
    assert.match((await readNdjson(await post(valid, {})))[0].error, /DEEPSEEK_API_KEY/)
    assert.match((await readNdjson(await post({ ...valid, sessionId: 'never-created' })))[0].error, /没有可重写的分镜/)
  })
})
