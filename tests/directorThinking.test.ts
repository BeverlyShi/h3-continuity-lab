import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer as createHttpServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createServer } from 'vite'
import { narrativeSources } from '../server/narrativeReview.ts'
import { SCENE_PUBLISH_ARGUMENTS_EXAMPLE } from '../server/publishSceneTool.ts'

test('the thinking switch reaches both providers and both phases in Pi and Simple', async () => {
  const originalFetch = globalThis.fetch
  const previousCwd = process.cwd()
  const directory = await mkdtemp(join(tmpdir(), 'director-thinking-'))
  process.chdir(directory)
  const { directorPlugin } = await import('../server/directorPlugin.ts')
  const vite = await createServer({ configFile: false, plugins: [directorPlugin()], server: { middlewareMode: true }, appType: 'custom' })
  const http = createHttpServer(vite.middlewares)
  const draft = {
    visualContext: { style: '写实古装宫廷剧，清晨自然光照亮人物侧脸。', scene: '宫门内侧石阶下的一小块平台，背景是朱红宫墙。' },
    videoPrompts: [1, 2].map((sequence) => ({
      characterIds: ['heroine', 'steward'],
      beats: [{ dialogueIds: sequence === 1 ? ['line_1'] : [], visual: '固定双人中景，女主站在画面左侧，抬头看向右侧的掌事姑姑。' + (sequence === 1 ? '{{line_1}}。' : ''), audio: '背景只有轻微风声。' }],
      endFrame: '双人中景，女主站在画面左侧，抬头看向右侧的掌事姑姑。',
    })),
  }
  try {
    await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve))
    const address = http.address()
    assert.ok(address && typeof address !== 'string')
    for (const agent of ['pi', 'simple']) {
      for (const model of ['deepseek-v4-flash', 'z-ai/glm-5.3-flash']) {
        // Reuse the session while turning thinking on and back off.
        for (const thinkingEnabled of [undefined, true, false]) {
          const calls: string[] = []
          globalThis.fetch = async (url, init) => {
            const request = JSON.parse(String(init?.body))
            const isGlm = model === 'z-ai/glm-5.3-flash'
            assert.equal(String(url), isGlm ? 'https://open.bigmodel.cn/api/paas/v4/chat/completions' : 'https://api.deepseek.com/chat/completions')
            assert.equal(request.thinking.type, isGlm || thinkingEnabled ? 'enabled' : 'disabled')
            assert.equal(request.reasoning_effort, thinkingEnabled ? 'high' : isGlm ? 'low' : undefined)
            if (isGlm) assert.equal(request.thinking.clear_thinking, false)
            const name = request.tools[0].function.name
            calls.push(name)
            const toolCall = { id: `call-${thinkingEnabled}-${calls.length}`, type: 'function', function: {
              name, arguments: name === 'publish_scene' ? SCENE_PUBLISH_ARGUMENTS_EXAMPLE : name === 'review_narrative' ? JSON.stringify((() => {
                const input = JSON.parse(request.messages.at(-1).content)
                return { issues: [], coverage: input.finalVideo ? narrativeSources(input.scene.narrative).map((item) => ({ sourceId: item.id, status: 'shown', evidence: input.finalVideo.videoPrompts[0].prompt })) : [] }
              })()) : JSON.stringify(draft),
            } }
            if (agent === 'simple') {
              return new Response(JSON.stringify({ choices: [{ message: { tool_calls: [toolCall] } }] }))
            }
            const chunks = [
              { choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, ...toolCall }] } }] },
              { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
            ]
            return new Response(chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n', {
              headers: { 'Content-Type': 'text/event-stream' },
            })
          }
          const response = await originalFetch(`http://127.0.0.1:${address.port}/api/director/turn`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-DeepSeek-Key': 'test-key', 'X-BigModel-Key': 'test-key' },
            body: JSON.stringify({ agent, model, thinkingEnabled, traceId: `${agent}-${model}-${thinkingEnabled}`, actors: [], castings: [], context: {
              ok: true, sessionId: `${agent}-${model.replaceAll('/', '-')}`, turn: 1, input: { type: 'start' },
            } }),
          })
          const events = (await response.text()).trim().split('\n').map((line) => JSON.parse(line))
          assert.deepEqual(events.filter((event) => event.type === 'error' || event.type === 'video_plan_error'), [])
          assert.deepEqual(calls, ['publish_scene', 'review_narrative', 'write_video_prompt', 'review_narrative'])
          assert.ok(events.some((event) => event.type === 'video_plan'))
          assert.equal(events.at(-1).type, 'done')
        }
      }
    }
  } finally {
    globalThis.fetch = originalFetch
    await new Promise<void>((resolve, reject) => http.close((error) => error ? reject(error) : resolve()))
    await vite.close()
    process.chdir(previousCwd)
    await rm(directory, { recursive: true, force: true })
  }
})
