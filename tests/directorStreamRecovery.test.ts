import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { narrativeSources } from '../server/narrativeReview.ts'
import { SCENE_PUBLISH_ARGUMENTS_EXAMPLE } from '../server/publishSceneTool.ts'
import type { DirectorStreamEvent } from '../src/types/director.ts'

test('Pi official providers replay thinking and retry malformed scene arguments and retains raw JSON before the SDK reduces it to an empty object', async () => {
  const previousCwd = process.cwd()
  const originalFetch = globalThis.fetch
  const directory = await mkdtemp(join(tmpdir(), 'director-stream-recovery-'))
  process.chdir(directory)
  try {
    const { runDirectorAgent } = await import('../server/directorAgent.ts')
    for (const modelId of ['deepseek-v4-flash', 'z-ai/glm-5.3-flash'] as const) {
      const scene = JSON.parse(SCENE_PUBLISH_ARGUMENTS_EXAMPLE)
      const malformedScene = JSON.stringify({ scene: { ...scene.scene, choices: scene.scene.choices.slice(0, 1), characters: scene.characters } })
      const invalidJson = `not-json:${SCENE_PUBLISH_ARGUMENTS_EXAMPLE}`
      const draft = {
        visualContext: { style: '写实古装宫廷剧，清晨自然光照亮人物侧脸。', scene: '宫门内侧石阶下的一小块平台，背景是朱红宫墙。' },
        videoPrompts: [1, 2].map((sequence) => ({
          characterIds: ['heroine', 'steward'],
          beats: [{ dialogueIds: sequence === 1 ? ['line_1'] : [], visual: '固定双人中景，机位与人物视线齐平，从两人侧面拍摄。女主站在画面左侧，抬头看向右侧的掌事姑姑。' + (sequence === 1 ? '{{line_1}}。' : ''), audio: '背景只有轻微风声。' }],
          endFrame: '双人中景，女主站在画面左侧，抬头看向右侧的掌事姑姑。',
        })),
      }
      const missingDialogue = {
        ...draft,
        videoPrompts: draft.videoPrompts.map((segment) => ({
          ...segment, beats: segment.beats.map((beat) => ({ ...beat, dialogueIds: [] })),
        })),
      }
      const responses = [malformedScene, invalidJson, SCENE_PUBLISH_ARGUMENTS_EXAMPLE, JSON.stringify(missingDialogue), JSON.stringify(draft)]
      const requests: Array<{ tools: Array<{ function: { name: string; parameters: { required: string[] } } }>; messages: Array<{ role: string; content: string }> }> = []
      globalThis.fetch = async (url, init) => {
        const isGlm = modelId === 'z-ai/glm-5.3-flash'
        assert.equal(String(url), isGlm ? 'https://open.bigmodel.cn/api/paas/v4/chat/completions' : 'https://api.deepseek.com/chat/completions')
        assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer test-key')
        const request = JSON.parse(String(init?.body))
        if (request.thinking?.type === 'enabled' && 'tool_choice' in request) {
          return new Response(JSON.stringify({ error: { message: 'Thinking mode does not support this tool_choice', type: 'invalid_request_error' } }), { status: 400 })
        }
        assert.equal(request.model, isGlm ? 'glm-5.3-flash' : modelId)
        assert.equal(request.thinking.type, 'enabled')
        if (isGlm) {
          assert.equal(request.thinking.clear_thinking, false)
          assert.equal(request.tool_stream, true)
        }
        assert.equal(request.reasoning_effort, 'high')
        assert.equal(request.max_tokens, 16_384)
        for (const message of request.messages.filter((message: { role: string }) => message.role === 'assistant')) {
          assert.equal(message.reasoning_content, 'Test reasoning for tool arguments.')
        }
        requests.push(request)
        const name = request.tools[0].function.name
        const raw = name === 'review_narrative' ? JSON.stringify((() => {
          const input = JSON.parse(request.messages.at(-1).content)
          return { issues: [], coverage: input.finalVideo ? narrativeSources(input.scene.narrative).map((item) => ({ sourceId: item.id, status: 'shown', evidence: input.finalVideo.videoPrompts[0].prompt })) : [] }
        })()) : responses.shift()
        assert.ok(raw, 'unexpected provider request')
        const id = `call-${requests.length}`
        const midpoint = Math.floor(raw.length / 2)
        const chunks = [
          { choices: [{ index: 0, delta: { reasoning_content: 'Test reasoning for tool arguments.' } }] },
          { choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: raw.slice(0, midpoint) } }] } }] },
          { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: raw.slice(midpoint) } }] } }] },
          { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 100, completion_tokens: 440, total_tokens: 540 } },
        ]
        return new Response(chunks.map((chunk) => `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', model: request.model, ...chunk })}\n\n`).join('') + 'data: [DONE]\n\n', {
          headers: { 'Content-Type': 'text/event-stream' },
        })
      }
      const events: DirectorStreamEvent[] = []
      const result = await runDirectorAgent({
        apiKey: 'test-key', modelId, thinkingEnabled: true,
        context: { ok: true, sessionId: `stream-recovery-${modelId.replaceAll('/', '-')}`, turn: 1, input: { type: 'start' } },
        actors: [], castings: [], traceId: `stream-recovery-test-${modelId}`, send: (event) => { events.push(event) },
      })
      assert.deepEqual(requests.map((request) => request.tools[0].function.name), ['publish_scene', 'publish_scene', 'publish_scene', 'review_narrative', 'write_video_prompt', 'write_video_prompt', 'review_narrative'])
      assert.deepEqual(requests[0].tools[0].function.parameters.required, ['scene', 'characters', 'dialogues'])
      assert.match(requests[1].messages.findLast((message) => message.role === 'tool')!.content, /characters 必须位于顶层/)
      assert.match(requests[2].messages.findLast((message) => message.role === 'tool')!.content, /收到空参数对象/)
      assert.match(requests[5].messages.findLast((message) => message.role === 'tool')!.content, /尚未安排 line_1.*你识字吗/)
      assert.deepEqual(result.scene, scene.scene)
      assert.equal(result.video?.videoPrompts.length, 2)
      assert.match(result.video!.videoPrompts[0].prompt, /掌事姑姑说：“你识字吗？”/)
      const traceEvent = events.findLast((event) => event.type === 'harness_trace')
      assert.ok(traceEvent?.type === 'harness_trace')
      assert.equal(traceEvent.trace.outcome, 'completed')
      assert.equal(traceEvent.trace.entries.filter((entry) => entry.kind === 'thinking').length, 5)
      const diagnostics = traceEvent.trace.entries.filter((entry) => entry.title === '原始工具参数与 JSON 解析诊断')
        .map((entry) => entry.data as { rawArguments: string; jsonParseError: string | null })
      assert.equal(diagnostics.length, 5)
      assert.equal(diagnostics[0].rawArguments, malformedScene)
      assert.equal(diagnostics[0].jsonParseError, null)
      assert.equal(diagnostics[1].rawArguments, invalidJson)
      assert.ok(diagnostics[1].jsonParseError)
      assert.equal(diagnostics[2].jsonParseError, null)
    }
  } finally {
    globalThis.fetch = originalFetch
    process.chdir(previousCwd)
    await rm(directory, { recursive: true, force: true })
  }
})
