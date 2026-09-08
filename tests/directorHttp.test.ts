import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer as createHttpServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createServer } from 'vite'
import { SCENE_PUBLISH_ARGUMENTS_EXAMPLE } from '../server/publishSceneTool.ts'
import { VIDEO_PLAN_ARGUMENTS_EXAMPLE } from '../server/videoPlanTool.ts'
import { installScriptedProvider } from './helpers/scriptedProvider.ts'

const scene = JSON.parse(SCENE_PUBLISH_ARGUMENTS_EXAMPLE)
const plan = JSON.parse(VIDEO_PLAN_ARGUMENTS_EXAMPLE)

test('the director endpoint runs the single agent for both official providers with the thinking switch applied to every call', async () => {
  const previousCwd = process.cwd()
  const directory = await mkdtemp(join(tmpdir(), 'director-http-'))
  process.chdir(directory)
  const { directorPlugin } = await import('../server/directorPlugin.ts')
  const vite = await createServer({ configFile: false, plugins: [directorPlugin()], server: { middlewareMode: true }, appType: 'custom' })
  const http = createHttpServer(vite.middlewares)
  const realFetch = globalThis.fetch
  try {
    await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve))
    const address = http.address()
    assert.ok(address && typeof address !== 'string')
    for (const model of ['deepseek-v4-flash', 'z-ai/glm-5.3-flash'] as const) {
      const isGlm = model === 'z-ai/glm-5.3-flash'
      for (const thinkingEnabled of [undefined, true, false]) {
        const provider = installScriptedProvider([
          { tool: 'publish_scene', args: scene, reasoning: '构思场景。' },
          { tool: 'write_video_prompt', args: plan, reasoning: '编写分镜。' },
          { tool: 'finish_turn', args: {}, reasoning: '结束。' },
        ])
        try {
          const response = await realFetch(`http://127.0.0.1:${address.port}/api/director/turn`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-DeepSeek-Key': 'test-key', 'X-BigModel-Key': 'test-key' },
            body: JSON.stringify({ model, thinkingEnabled, videoMode: 'manual', traceId: `${model}-${thinkingEnabled}`, actors: [], castings: [], context: {
              ok: true, sessionId: `http-${model.replaceAll('/', '-')}`, turn: 1, input: { type: 'start' },
            } }),
          })
          const events = (await response.text()).trim().split('\n').map((line) => JSON.parse(line))
          assert.deepEqual(events.filter((event) => event.type === 'error' || event.type === 'video_plan_error'), [])
          assert.deepEqual(events.map((event) => event.type).filter((type) => ['scene', 'cast', 'video_plan', 'done'].includes(type)), ['scene', 'cast', 'video_plan', 'done'])
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
            assert.deepEqual(request.body.tools?.map((tool) => tool.function.name), ['publish_scene', 'cast_scene', 'write_video_prompt', 'finish_turn'])
          }
          // 同一回合内后续请求回放了此前的思考内容。
          const assistants = provider.requests[2].body.messages.filter((message) => message.role === 'assistant')
          assert.equal(assistants.length, 2)
        } finally {
          provider.restore()
        }
      }
    }

    const invalid = await realFetch(`http://127.0.0.1:${address.port}/api/director/turn`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-DeepSeek-Key': 'test-key' },
      body: JSON.stringify({ model: 'deepseek-v4-flash', videoMode: 'sometimes', traceId: 'invalid-mode', actors: [], castings: [], context: {
        ok: true, sessionId: 'http-invalid-mode', turn: 1, input: { type: 'start' },
      } }),
    })
    assert.match(await invalid.text(), /视频模式设置无效/)
  } finally {
    globalThis.fetch = realFetch
    await new Promise<void>((resolve, reject) => http.close((error) => error ? reject(error) : resolve()))
    await vite.close()
    process.chdir(previousCwd)
    await rm(directory, { recursive: true, force: true })
  }
})
