import assert from 'node:assert/strict'
import test from 'node:test'
import { createBrowserSessionStore } from '../src/director/browserSessionStore.ts'
import {
  rewriteDirectorSegment,
  runDirectorAgent,
  type DirectorAgentRequest,
  type RewriteDirectorRequest,
} from '../src/director/directorAgent.ts'
import { SCENE_PUBLISH_ARGUMENTS_EXAMPLE } from '../src/director/publishSceneTool.ts'
import { createMemoryKeyValueStore } from '../src/director/virtualFileSystem.ts'
import { WRITE_SCENE_VIDEO_ARGUMENTS_EXAMPLE } from '../src/director/writeSceneVideoTool.ts'
import {
  streamDirectorRewrite,
  streamDirectorTurn,
  type DirectorRuntime,
} from '../src/services/directorClient.ts'
import type { DirectorStreamEvent } from '../src/types/director.ts'
import type { TailFrameVisualState } from '../src/types/story.ts'
import { installScriptedProvider } from './helpers/scriptedProvider.ts'

const scene = {
  title: '宫门初雪',
  narrative: '宫门在身后缓缓合拢，沈清禾第一次听见深宫里的晨钟。细雪落在朱红宫墙下，教引嬷嬷催促秀女们向前，她却发现同行少女悄悄塞来一方绣帕。绣帕角落绣着禁军纹样，远处又有人停步回望。沈清禾把手藏进袖中，前方嬷嬷忽然点到她的名字，身旁少女低声让她千万别交出去。队伍即将转过宫门，再迟一步便会被人看见，她必须立刻决定如何应对。',
  choices: [
    { id: '1', text: '把绣帕交给嬷嬷' },
    { id: '2', text: '替少女暂时藏好' },
    { id: '3', text: '假装失手丢在雪中' },
  ],
}

const characters = [
  { id: 'heroine', name: '沈清禾', gender: 'female' as const, minAge: 16, maxAge: 20 },
]

const video = {
  totalDuration: 15,
  style: '冷色写实，宫灯暖光，细雪飘落。',
  videoPrompts: [
    { sequence: 1, startTime: 0, endTime: 5, characterIds: ['heroine'], prompt: '宫门缓缓关闭，沈清禾站在队伍末尾回头凝望，固定中景镜头。' },
    { sequence: 2, startTime: 5, endTime: 15, characterIds: ['heroine'], prompt: '开场延续上一画面，沈清禾保持回头姿势，随后跟上向前移动的队伍。' },
  ],
}

const references = [
  [{ type: 'character' as const, characterId: 'heroine', actorId: 'actor-a' }],
  [{ type: 'start_frame' as const, sequence: 1 }],
]

const startContext = (sessionId = 'session-1') => ({ ok: true as const, sessionId, turn: 1, input: { type: 'start' as const } })

// 假导演：记录收到的请求，按脚本依次发出事件；脚本里的 Error 会被抛出。
const createFakeRuntime = (script: Array<DirectorStreamEvent | Error> = [
  { type: 'scene', scene, characters },
  { type: 'video_plan', video, references, fromSequence: 1 },
  { type: 'done' },
]) => {
  const turns: DirectorAgentRequest[] = []
  const rewrites: RewriteDirectorRequest[] = []
  const play = async (send: (event: DirectorStreamEvent) => void) => {
    for (const step of script) {
      if (step instanceof Error) throw step
      send(step)
    }
  }
  const runtime: DirectorRuntime = {
    store: createBrowserSessionStore(createMemoryKeyValueStore()),
    runDirectorAgent: async (request) => { turns.push(request); await play(request.send) },
    rewriteDirectorSegment: async (request) => { rewrites.push(request); await play(request.send) },
  }
  return { runtime, turns, rewrites }
}

test('runs the director in-process with the selected model key and resolves with scene, cast and plan', async () => {
  const casting = { castings: [{ characterId: 'heroine', actorId: 'actor-a' }], unmatchedCharacterIds: [] }
  const { runtime, turns } = createFakeRuntime([
    { type: 'scene', scene, characters },
    { type: 'cast', casting },
    { type: 'video_plan', video, references, fromSequence: 1 },
    { type: 'done' },
  ])
  const received: string[] = []
  const actors = [{ id: 'actor-a', name: '演员甲', gender: 'female' as const, minAge: 16, maxAge: 24, hasImage: true }]
  const castings = [{ characterId: 'heroine', actorId: 'actor-a' }]
  const result = await streamDirectorTurn({
    openRouterApiKey: ' sk-or-test ',
    context: startContext(),
    traceId: 'trace-1',
    actors,
    castings,
    videoMode: 'comfy',
    model: 'google/gemini-2.5-flash-lite',
    onEvent: (event) => { received.push(event.type) },
    runtime,
  })

  assert.equal(turns.length, 1)
  const request = turns[0]
  assert.equal(request.store, runtime.store)
  assert.equal(request.apiKey, 'sk-or-test')
  assert.equal(request.visionKey, undefined)
  assert.equal(request.modelId, 'google/gemini-2.5-flash-lite')
  assert.equal(request.thinkingEnabled, false)
  assert.equal(request.videoMode, 'comfy')
  assert.equal(request.traceId, 'trace-1')
  assert.deepEqual(request.actors, actors)
  assert.deepEqual(request.castings, castings)
  assert.ok(request.signal instanceof AbortSignal)
  assert.deepEqual(received, ['scene', 'cast', 'video_plan', 'done'])
  assert.deepEqual(result, { scene, characters, casting, video })
})

test('picks the API key by model provider and passes the DeepSeek key for frame inspection', async () => {
  const keys = { openRouterApiKey: 'sk-or-test', deepseekApiKey: 'sk-ds-test', bigModelApiKey: 'sk-bigmodel-test' }
  for (const [model, expected] of [
    ['deepseek-v4-flash', 'sk-ds-test'],
    ['google/gemini-2.5-flash-lite', 'sk-or-test'],
    ['openai/gpt-oss-20b', 'sk-or-test'],
    ['z-ai/glm-5.3-flash', 'sk-bigmodel-test'],
  ] as const) {
    for (const thinkingEnabled of [undefined, false, true]) {
      const { runtime, turns } = createFakeRuntime()
      await streamDirectorTurn({ ...keys, context: startContext(), traceId: 't', model, thinkingEnabled, onEvent: () => {}, runtime })
      assert.equal(turns[0].apiKey, expected)
      assert.equal(turns[0].visionKey, 'sk-ds-test')
      assert.equal(turns[0].modelId, model)
      assert.equal(turns[0].thinkingEnabled, thinkingEnabled ?? false)
    }
  }
})

test('rejects with the configuration hint when the provider key is missing', async () => {
  for (const [model, keys, hint] of [
    ['deepseek-v4-flash', { openRouterApiKey: 'sk-or', bigModelApiKey: 'sk-bm' }, /请先配置 DEEPSEEK_API_KEY/],
    ['google/gemini-2.5-flash-lite', { deepseekApiKey: 'sk-ds', bigModelApiKey: 'sk-bm' }, /请先配置 OPENROUTER_API_KEY/],
    ['z-ai/glm-5.3-flash', { openRouterApiKey: 'sk-or', deepseekApiKey: 'sk-ds', bigModelApiKey: '  ' }, /请先配置 BIGMODEL_API_KEY/],
  ] as const) {
    const { runtime, turns } = createFakeRuntime()
    const received: DirectorStreamEvent[] = []
    await assert.rejects(streamDirectorTurn({
      ...keys, context: startContext(), traceId: 't', model, onEvent: (event) => { received.push(event) }, runtime,
    }), hint)
    assert.equal(turns.length, 0)
    assert.equal(received.length, 1)
    assert.equal(received[0].type, 'error')
  }
})

test('rejects removed video modes and a previous frame that is not an image data URL', async () => {
  for (const videoMode of ['sometimes', 'manual', 'off']) {
    const { runtime, turns } = createFakeRuntime()
    await assert.rejects(streamDirectorTurn({
      deepseekApiKey: 'k', context: startContext(), traceId: 't', model: 'deepseek-v4-flash',
      videoMode: videoMode as 'auto', onEvent: () => {}, runtime,
    }), /视频模式设置无效/)
    assert.equal(turns.length, 0)
  }

  const { runtime, turns } = createFakeRuntime()
  await assert.rejects(streamDirectorTurn({
    deepseekApiKey: 'k',
    context: { ...startContext(), turn: 2, previousScene: { tailFrameDataUrl: 'https://example.com/frame.jpg', characters: [] } },
    traceId: 't', model: 'deepseek-v4-flash', onEvent: () => {}, runtime,
  }), /故事输入无效/)
  assert.equal(turns.length, 0)

  const previousScene = { tailFrameDataUrl: 'data:image/jpeg;base64,AAAA', characters }
  const ok = createFakeRuntime()
  await streamDirectorTurn({
    deepseekApiKey: 'k', context: { ...startContext(), turn: 2, previousScene }, traceId: 't', model: 'deepseek-v4-flash', onEvent: () => {}, runtime: ok.runtime,
  })
  assert.deepEqual(ok.turns[0].context.previousScene, previousScene)
})

test('an error event ends the turn with that error', async () => {
  const { runtime } = createFakeRuntime([
    { type: 'status', text: '导演正在构思' },
    { type: 'error', error: '模型请求失败' },
  ])
  const received: string[] = []
  await assert.rejects(streamDirectorTurn({
    deepseekApiKey: 'k', context: startContext(), traceId: 't', model: 'deepseek-v4-flash', onEvent: (event) => { received.push(event.type) }, runtime,
  }), /模型请求失败/)
  assert.deepEqual(received, ['status', 'error'])
})

test('a thrown director error is surfaced as an error event and rejects', async () => {
  const { runtime } = createFakeRuntime([
    { type: 'status', text: '导演正在构思' },
    new Error('DeepSeek 返回 401'),
  ])
  const received: DirectorStreamEvent[] = []
  await assert.rejects(streamDirectorTurn({
    deepseekApiKey: 'k', context: startContext(), traceId: 't', model: 'deepseek-v4-flash', onEvent: (event) => { received.push(event) }, runtime,
  }), /DeepSeek 返回 401/)
  assert.deepEqual(received.at(-1), { type: 'error', error: 'DeepSeek 返回 401' })
})

test('throws when the director finishes without a done event', async () => {
  const { runtime } = createFakeRuntime([
    { type: 'scene', scene, characters },
    { type: 'video_plan', video, references, fromSequence: 1 },
  ])
  await assert.rejects(streamDirectorTurn({
    deepseekApiKey: 'k', context: startContext(), traceId: 't', model: 'deepseek-v4-flash', onEvent: () => {}, runtime,
  }), /导演连接意外中断，请重试/)
})

test('resolves once the scene arrives even if the video plan fails', async () => {
  const { runtime } = createFakeRuntime([
    { type: 'scene', scene, characters },
    { type: 'video_plan_error', message: '视频计划生成失败' },
    { type: 'done' },
  ])
  const result = await streamDirectorTurn({
    deepseekApiKey: 'k', context: startContext(), traceId: 't', model: 'deepseek-v4-flash', onEvent: () => {}, runtime,
  })
  assert.deepEqual(result, { scene, characters, video: undefined })
})

test('hands the frontend copies of events and aborts the director when the frontend handler throws', async () => {
  const published = { type: 'scene' as const, scene: structuredClone(scene), characters: structuredClone(characters) }
  let received: DirectorStreamEvent | undefined
  let runSignal: AbortSignal | undefined
  const runtime: DirectorRuntime = {
    ...createFakeRuntime().runtime,
    runDirectorAgent: async (request) => {
      runSignal = request.signal
      request.send(published)
      published.scene.title = '导演内部改动'
      request.send({ type: 'done' })
    },
  }
  await streamDirectorTurn({
    deepseekApiKey: 'k', context: startContext(), traceId: 't', model: 'deepseek-v4-flash',
    onEvent: (event) => { received ??= event }, runtime,
  })
  assert.equal(received?.type === 'scene' && received.scene.title, '宫门初雪')
  assert.equal(runSignal?.aborted, false)

  await assert.rejects(streamDirectorTurn({
    deepseekApiKey: 'k', context: startContext(), traceId: 't', model: 'deepseek-v4-flash',
    onEvent: (event) => { if (event.type === 'scene') throw new Error('发布场景失败') },
    runtime: {
      ...runtime,
      runDirectorAgent: async (request) => {
        runSignal = request.signal
        request.send({ type: 'scene', scene, characters })
        request.send({ type: 'done' })
      },
    },
  }), /发布场景失败/)
  assert.equal(runSignal?.aborted, true)
})

test('aborting the caller signal aborts the director run', async () => {
  const controller = new AbortController()
  let runSignal: AbortSignal | undefined
  const runtime: DirectorRuntime = {
    ...createFakeRuntime().runtime,
    runDirectorAgent: async (request) => {
      runSignal = request.signal
      controller.abort()
      throw new Error('请求已取消。')
    },
  }
  await assert.rejects(streamDirectorTurn({
    deepseekApiKey: 'k', context: startContext(), traceId: 't', model: 'deepseek-v4-flash', signal: controller.signal, onEvent: () => {}, runtime,
  }), /请求已取消/)
  assert.equal(runSignal?.aborted, true)
})

test('streamDirectorRewrite passes the rewrite request and resolves with the new plan', async () => {
  const rewritePlan = { type: 'video_plan' as const, video, references, fromSequence: 2 }
  const { runtime, rewrites } = createFakeRuntime([rewritePlan, { type: 'done' }])
  const received: unknown[] = []
  const actors = [{ id: 'actor-a', name: '演员甲', gender: 'female' as const, minAge: 16, maxAge: 24, hasImage: false }]
  const result = await streamDirectorRewrite({
    openRouterApiKey: 'sk-or-test',
    deepseekApiKey: 'sk-ds-test',
    sessionId: 'session-1',
    sequence: 2,
    reason: '  人物站位和上一段对不上 ',
    traceId: 'trace-rewrite',
    actors,
    model: 'deepseek-v4-flash',
    thinkingEnabled: true,
    onEvent: (event) => { received.push(event) },
    runtime,
  })

  const request = rewrites[0]
  assert.equal(request.store, runtime.store)
  assert.equal(request.apiKey, 'sk-ds-test')
  assert.equal(request.sessionId, 'session-1')
  assert.equal(request.sequence, 2)
  assert.equal(request.reason, '人物站位和上一段对不上')
  assert.equal(request.traceId, 'trace-rewrite')
  assert.deepEqual(request.actors, actors)
  assert.equal(request.modelId, 'deepseek-v4-flash')
  assert.equal(request.thinkingEnabled, true)
  assert.deepEqual(received, [rewritePlan, { type: 'done' }])
  assert.deepEqual(result, { video })
})

test('streamDirectorRewrite validates its parameters and the provider key', async () => {
  const valid = { deepseekApiKey: 'k', sessionId: 's', sequence: 1, reason: '不满意', traceId: 't', model: 'deepseek-v4-flash' as const, onEvent: () => {} }
  for (const [overrides, message] of [
    [{ sequence: 4 }, /段号无效/],
    [{ sequence: 0 }, /段号无效/],
    [{ reason: '  ' }, /请写明重写原因/],
    [{ reason: '长'.repeat(201) }, /请写明重写原因/],
    [{ deepseekApiKey: '' }, /DEEPSEEK_API_KEY/],
  ] as const) {
    const { runtime, rewrites } = createFakeRuntime()
    await assert.rejects(streamDirectorRewrite({ ...valid, ...overrides, runtime }), message)
    assert.equal(rewrites.length, 0)
  }

  const { runtime } = createFakeRuntime([new Error('当前场次没有可重写的分镜。')])
  await assert.rejects(streamDirectorRewrite({ ...valid, runtime }), /没有可重写的分镜/)
})

// 以下用真实导演 + 内存会话存储 + 脚本化模型，端到端走一遍浏览器内的调用链。
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

const createRealRuntime = (): DirectorRuntime => ({
  store: createBrowserSessionStore(createMemoryKeyValueStore()),
  runDirectorAgent: (request) => runDirectorAgent({ ...request, analyze: async () => fakeVisualState }),
  rewriteDirectorSegment,
})

const publishedScene = JSON.parse(SCENE_PUBLISH_ARGUMENTS_EXAMPLE)
const storyboard = JSON.parse(WRITE_SCENE_VIDEO_ARGUMENTS_EXAMPLE)

test('the in-browser director runs the single agent for both official providers with the thinking switch applied to every call', async () => {
  const runtime = createRealRuntime()
  for (const model of ['deepseek-v4-flash', 'z-ai/glm-5.3-flash'] as const) {
    const isGlm = model === 'z-ai/glm-5.3-flash'
    for (const thinkingEnabled of [undefined, true, false]) {
      const provider = installScriptedProvider([
        { tool: 'publish_scene', args: publishedScene, reasoning: '构思场景。' },
        { tool: 'cast_scene', args: { assignments: [{ characterId: 'steward', create: { name: '崔姑姑', appearance: '四十五岁上下，面容清瘦端严，乌发圆髻，深青窄袖宫装' }, reason: '演员库为空' }] }, reasoning: '新建演员。' },
        { tool: 'write_scene_video', args: storyboard, reasoning: '编写分镜。' },
      ])
      try {
        const events: DirectorStreamEvent[] = []
        await streamDirectorTurn({
          deepseekApiKey: 'test-key', bigModelApiKey: 'test-key', model, thinkingEnabled, videoMode: 'comfy',
          traceId: `${model}-${thinkingEnabled}`, actors: [], castings: [],
          context: startContext(`browser-${model.replaceAll('/', '-')}-${thinkingEnabled}`),
          onEvent: (event) => { events.push(event) },
          runtime,
        })
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
          assert.deepEqual(request.body.tools?.map((tool) => tool.function.name), ['publish_scene', 'cast_scene', 'inspect_last_frame', 'write_scene_video'])
        }
        // 交齐即停：分镜写好后不再多发一次请求；同一场次内后续请求回放了此前的思考内容。
        assert.equal(provider.requests.length, 3)
        const assistants = provider.requests[1].body.messages.filter((message) => message.role === 'assistant')
        assert.equal(assistants.length, 1)
      } finally {
        provider.restore()
      }
    }
  }
})

test('a scene continues from the previous frame in the browser, and a rewrite re-emits the plan from one segment', async () => {
  const runtime = createRealRuntime()
  const actors = [
    { id: 'actor-young', name: '演员甲', gender: 'female' as const, minAge: 16, maxAge: 22, hasImage: true },
    { id: 'actor-elder', name: '演员乙', gender: 'female' as const, minAge: 40, maxAge: 55, hasImage: true },
  ]
  const castAssignments = { assignments: [
    { characterId: 'heroine', actorId: 'actor-young', reason: '年龄相符' },
    { characterId: 'steward', actorId: 'actor-elder', reason: '四十多岁，面相端严' },
  ] }
  const rewritten = {
    characters: ['heroine', 'steward'],
    seconds: 10,
    prompt: '0–5秒：承接上一段画面，镜头缓缓推近。女主抬眼看向掌事姑姑。安静。\n\n5–10秒：镜头硬切为女主近景，平视，固定。她把包袱放到身侧。画外传来轻微风声。',
  }
  const provider = installScriptedProvider([
    { tool: 'publish_scene', args: publishedScene },
    { tool: 'cast_scene', args: castAssignments },
    { tool: 'inspect_last_frame', args: {} },
    { tool: 'write_scene_video', args: { ...storyboard, opening: 'continue' } },
    { tool: 'write_scene_video', args: { rewriteSequence: 2, segments: [rewritten] } },
  ])
  try {
    const events: DirectorStreamEvent[] = []
    await streamDirectorTurn({
      deepseekApiKey: 'test-key', model: 'deepseek-v4-flash', videoMode: 'comfy', traceId: 'browser-scene-1', actors, castings: [],
      context: {
        ok: true, sessionId: 'browser-scene', turn: 2, input: { type: 'choice', choice: publishedScene.scene.choices[0] },
        previousScene: { tailFrameDataUrl: 'data:image/jpeg;base64,AAAA', characters: publishedScene.characters },
      },
      onEvent: (event) => { events.push(event) },
      runtime,
    })
    const plan = events.find((event) => event.type === 'video_plan')
    assert.ok(plan?.type === 'video_plan')
    assert.deepEqual(plan.references[0].at(-1), { type: 'previous_scene_tail_frame' })
    assert.equal(plan.fromSequence, 1)
    assert.equal(events.at(-1)?.type, 'done')

    const rewriteEvents: DirectorStreamEvent[] = []
    const result = await streamDirectorRewrite({
      deepseekApiKey: 'test-key', sessionId: 'browser-scene', sequence: 2, reason: '人物走位跳了', traceId: 'browser-scene-2', actors, model: 'deepseek-v4-flash',
      onEvent: (event) => { rewriteEvents.push(event) },
      runtime,
    })
    const replan = rewriteEvents.find((event) => event.type === 'video_plan')
    assert.ok(replan?.type === 'video_plan')
    assert.equal(replan.fromSequence, 2)
    assert.match(replan.video.videoPrompts[1].prompt, /她把包袱放到身侧/)
    assert.deepEqual(result.video, replan.video)
    assert.equal(rewriteEvents.at(-1)?.type, 'done')
    assert.equal(provider.remaining(), 0)

    await assert.rejects(streamDirectorRewrite({
      deepseekApiKey: 'test-key', sessionId: 'never-created', sequence: 1, reason: '不满意', traceId: 't', model: 'deepseek-v4-flash', onEvent: () => {}, runtime,
    }), /没有可重写的分镜/)
  } finally {
    provider.restore()
  }
})
