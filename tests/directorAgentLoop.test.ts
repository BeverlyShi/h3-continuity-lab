import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import test from 'node:test'
import { JsonlSessionRepo, NodeExecutionEnv, type Entry } from '@earendil-works/pi-agent-core/node'
import { SCENE_PUBLISH_ARGUMENTS_EXAMPLE } from '../server/publishSceneTool.ts'
import { WRITE_SCENE_VIDEO_ARGUMENTS_EXAMPLE } from '../server/writeSceneVideoTool.ts'
import { findRewritableScene } from '../server/directorTurnState.ts'
import type { CastableActor } from '../src/types/actor.ts'
import type { DirectorStreamEvent } from '../src/types/director.ts'
import type { TailFrameVisualState } from '../src/types/story.ts'
import { installScriptedProvider, messageText } from './helpers/scriptedProvider.ts'

const scene = JSON.parse(SCENE_PUBLISH_ARGUMENTS_EXAMPLE)
const storyboard = JSON.parse(WRITE_SCENE_VIDEO_ARGUMENTS_EXAMPLE)
const actors: CastableActor[] = [
  { id: 'actor-young', name: '演员甲', gender: 'female', minAge: 16, maxAge: 22, hasImage: true },
  { id: 'actor-elder', name: '演员乙', gender: 'female', minAge: 40, maxAge: 55, hasImage: true, appearance: '四十余岁，深青宫装，发髻一丝不乱。' },
]
const castAssignments = { assignments: [
  { characterId: 'heroine', actorId: 'actor-young', reason: '年龄相符' },
  { characterId: 'steward', actorId: 'actor-elder', reason: '四十多岁，面相端严' },
] }

// directorAgent.ts 在模块顶层按导入时的 cwd 固定了 traceRepo 的根目录；每个用例都要拿到
// 独立的临时目录，所以用查询串绕开 ESM 的模块缓存，强制每次重新加载模块。
let freshImportCounter = 0
const withTempTraces = async (
  run: (mod: typeof import('../server/directorAgent.ts')) => Promise<void>,
) => {
  const previousCwd = process.cwd()
  const directory = await mkdtemp(join(tmpdir(), 'director-loop-'))
  process.chdir(directory)
  freshImportCounter += 1
  try {
    const mod = await import(`../server/directorAgent.ts?fresh=${freshImportCounter}`)
    await run(mod)
  } finally {
    process.chdir(previousCwd)
    await rm(directory, { recursive: true, force: true })
  }
}

const readEntries = async (sessionId: string): Promise<Entry[]> => {
  const repo = new JsonlSessionRepo({ fs: new NodeExecutionEnv({ cwd: process.cwd() }), sessionsRoot: resolve(process.cwd(), '.agent-traces') })
  const list = await repo.list({ cwd: process.cwd() })
  const metadata = list.find((entry) => entry.id === sessionId)
  if (!metadata) return []
  const session = await repo.open(metadata)
  return session.findEntries({ order: 'oldestFirst' })
}

const requestTools = (request: { body: { tools?: Array<{ function: { name: string } }> } }) =>
  request.body.tools?.map((tool) => tool.function.name) ?? []

const makeVisualState = (locationLabel: string): TailFrameVisualState => ({
  shot_size: '中景',
  shot_position: '人物正前方',
  shot_content: {
    characters: [],
    scene: { location: locationLabel, visible_elements: '木廊', lighting: '柔光', time_of_day: '白天' },
    key_props: [],
  },
  frame_quality: '清晰稳定',
})

const castings = [{ characterId: 'heroine', actorId: 'actor-young' }, { characterId: 'steward', actorId: 'actor-elder' }]

test('one scene runs straight through: publish, cast, whole-scene storyboard, then stops without an extra model call', async () => {
  await withTempTraces(async ({ runDirectorAgent }) => {
    const provider = installScriptedProvider([
      { tool: 'publish_scene', args: scene },
      { tool: 'cast_scene', args: castAssignments },
      { tool: 'write_scene_video', args: storyboard },
    ])
    try {
      const events: DirectorStreamEvent[] = []
      const outcome = await runDirectorAgent({
        apiKey: 'test-key', modelId: 'deepseek-v4-flash',
        context: { ok: true, sessionId: 'loop-scene', turn: 1, input: { type: 'start' } },
        actors, castings: [], traceId: 'trace-1', videoMode: 'comfy',
        send: (event) => events.push(event),
      })

      assert.equal(provider.remaining(), 0)
      assert.equal(provider.requests.length, 3)
      for (const request of provider.requests) {
        assert.deepEqual(requestTools(request), ['publish_scene', 'cast_scene', 'inspect_last_frame', 'write_scene_video'])
      }
      assert.match(messageText(provider.requests[0].body.messages.at(-1)), /上一场次没有可接的视频画面/)
      const types = events.map((event) => event.type)
      assert.ok(types.indexOf('scene') < types.indexOf('cast'))
      assert.ok(types.indexOf('cast') < types.indexOf('video_plan'))
      assert.equal(types.at(-1), 'done')

      const plan = events.find((event) => event.type === 'video_plan')
      assert.ok(plan?.type === 'video_plan')
      assert.equal(plan.fromSequence, 1)
      assert.equal(plan.video.totalDuration, 15)
      const cast = [
        { type: 'character', characterId: 'heroine', actorId: 'actor-young' },
        { type: 'character', characterId: 'steward', actorId: 'actor-elder' },
      ]
      assert.deepEqual(plan.references, [cast, [...cast, { type: 'start_frame', sequence: 1 }]])
      const first = plan.video.videoPrompts[0].prompt
      assert.ok(first.startsWith(storyboard.style))
      assert.doesNotMatch(first, /人物外观|四十余岁/, '人物行由前端在生成时拼接')
      assert.match(first, /掌事姑姑说：“你识字吗？”/)
      assert.match(first, /无音乐，无旁白。$/)
      assert.equal(outcome.video?.videoPrompts.length, 2)

      const trace = events.findLast((event) => event.type === 'harness_trace')
      assert.ok(trace?.type === 'harness_trace')
      assert.equal(trace.trace.outcome, 'completed')

      const saved = findRewritableScene(await readEntries('loop-scene'))
      assert.equal(saved?.video?.opening, 'new_shot')
      assert.equal(saved?.video?.segments.length, 2)
    } finally {
      provider.restore()
    }
  })
})

test('continuing from the previous scene requires inspecting its last frame first', async () => {
  await withTempTraces(async ({ runDirectorAgent }) => {
    const continuing = { ...storyboard, opening: 'continue' }
    const provider = installScriptedProvider([
      { tool: 'publish_scene', args: scene },
      { tool: 'write_scene_video', args: continuing },
      { tool: 'inspect_last_frame', args: {} },
      { tool: 'write_scene_video', args: continuing },
    ])
    try {
      const inspected: unknown[] = []
      const events: DirectorStreamEvent[] = []
      const previousScene = { tailFrameDataUrl: 'data:image/jpeg;base64,AAAA', characters: scene.characters }
      await runDirectorAgent({
        apiKey: 'test-key', modelId: 'deepseek-v4-flash',
        context: { ok: true, sessionId: 'loop-continue', turn: 2, input: { type: 'choice', choice: scene.scene.choices[0] }, previousScene },
        actors, castings, traceId: 'trace-continue', videoMode: 'manual',
        visionKey: 'test-deepseek-key',
        analyze: async (input) => {
          inspected.push(input)
          return makeVisualState('廊下')
        },
        send: (event) => events.push(event),
      })

      assert.equal(provider.remaining(), 0)
      assert.match(messageText(provider.requests[0].body.messages.at(-1)), /可以调用 inspect_last_frame/)
      const rejected = provider.requests[2].body.messages.filter((message) => message.role === 'tool').at(-1)
      assert.match(messageText(rejected), /必须先调用 inspect_last_frame/)
      assert.equal(inspected.length, 1)
      assert.deepEqual(inspected[0], { apiKey: 'test-deepseek-key', imageUrl: previousScene.tailFrameDataUrl, characters: scene.characters, signal: undefined })
      const plan = events.find((event) => event.type === 'video_plan')
      assert.ok(plan?.type === 'video_plan')
      assert.deepEqual(plan.references[0].at(-1), { type: 'previous_scene_tail_frame' })

      // 上一场次尾帧图片不写进 session；看过的画面状态留着供重写。
      const saved = findRewritableScene(await readEntries('loop-continue'))
      assert.equal(saved?.context.previousScene, undefined)
      assert.equal(saved?.inspected?.shot_content.scene.location, '廊下')
    } finally {
      provider.restore()
    }
  })
})

test('rewriting one segment only offers write_scene_video and re-emits the plan from that segment', async () => {
  await withTempTraces(async ({ runDirectorAgent, rewriteDirectorSegment }) => {
    const rewritten = {
      characters: ['heroine', 'steward'],
      seconds: 10,
      prompt: '0–5秒：承接上一段画面，镜头缓缓推近。女主抬眼看向掌事姑姑。安静。\n\n5–10秒：镜头硬切为女主近景，平视，固定。她把包袱放到身侧。画外传来轻微风声。',
    }
    const provider = installScriptedProvider([
      { tool: 'publish_scene', args: scene },
      { tool: 'cast_scene', args: castAssignments },
      { tool: 'write_scene_video', args: storyboard },
      { tool: 'write_scene_video', args: { rewriteSequence: 2, segments: [rewritten] } },
    ])
    try {
      await runDirectorAgent({
        apiKey: 'test-key', modelId: 'deepseek-v4-flash',
        context: { ok: true, sessionId: 'loop-rewrite', turn: 1, input: { type: 'start' } },
        actors, castings: [], traceId: 'trace-rewrite-1', videoMode: 'comfy',
        send: () => {},
      })

      const events: DirectorStreamEvent[] = []
      const outcome = await rewriteDirectorSegment({
        sessionId: 'loop-rewrite', sequence: 2, reason: '女主突然换了站位',
        apiKey: 'test-key', modelId: 'deepseek-v4-flash', actors, traceId: 'trace-rewrite-2',
        send: (event) => events.push(event),
      })

      assert.equal(provider.remaining(), 0)
      const request = provider.requests[3]
      assert.deepEqual(requestTools(request), ['write_scene_video'])
      assert.match(messageText(request.body.messages.at(-1)), /要求重写第 2 段。原因：女主突然换了站位/)
      const plan = events.find((event) => event.type === 'video_plan')
      assert.ok(plan?.type === 'video_plan')
      assert.equal(plan.fromSequence, 2)
      assert.match(plan.video.videoPrompts[1].prompt, /她把包袱放到身侧/)
      assert.match(plan.video.videoPrompts[0].prompt, /你识字吗？/)
      assert.equal(events.some((event) => event.type === 'cast' || event.type === 'scene'), false)
      assert.equal(events.at(-1)?.type, 'done')
      assert.equal(outcome.video?.totalDuration, 15)

      const saved = findRewritableScene(await readEntries('loop-rewrite'))
      assert.equal(saved?.video?.segments[1].prompt, rewritten.prompt)
    } finally {
      provider.restore()
    }
  })
})

test('rewriting is rejected when the session has no finished storyboard', async () => {
  await withTempTraces(async ({ rewriteDirectorSegment }) => {
    await assert.rejects(() => rewriteDirectorSegment({
      sessionId: 'loop-empty', sequence: 1, reason: '不满意',
      apiKey: 'test-key', modelId: 'deepseek-v4-flash', actors: [], traceId: 'trace-empty',
      send: () => {},
    }), /没有可重写的分镜/)
  })
})

test('a model that stops before delivering the storyboard is reminded once', async () => {
  await withTempTraces(async ({ runDirectorAgent }) => {
    const provider = installScriptedProvider([
      { tool: 'publish_scene', args: scene },
      { text: '好了。' },
      { tool: 'write_scene_video', args: storyboard },
    ])
    try {
      const events: DirectorStreamEvent[] = []
      await runDirectorAgent({
        apiKey: 'test-key', modelId: 'deepseek-v4-flash',
        context: { ok: true, sessionId: 'loop-remind', turn: 2, input: { type: 'choice', choice: scene.scene.choices[0] } },
        actors, castings, traceId: 'trace-remind', videoMode: 'manual',
        send: (event) => events.push(event),
      })
      assert.equal(provider.remaining(), 0)
      assert.match(messageText(provider.requests[2].body.messages.at(-1)), /还没有提交本场次分镜/)
      assert.ok(events.some((event) => event.type === 'video_plan'))
    } finally {
      provider.restore()
    }
  })
})

test('text-only mode offers no video tools and ends after publishing and casting', async () => {
  await withTempTraces(async ({ runDirectorAgent }) => {
    const provider = installScriptedProvider([
      { tool: 'publish_scene', args: scene },
      { tool: 'cast_scene', args: castAssignments },
    ])
    try {
      const events: DirectorStreamEvent[] = []
      await runDirectorAgent({
        apiKey: 'test-key', modelId: 'deepseek-v4-flash',
        context: { ok: true, sessionId: 'loop-text', turn: 1, input: { type: 'start' } },
        actors, castings: [], traceId: 'trace-text', videoMode: 'off',
        send: (event) => events.push(event),
      })
      assert.equal(provider.remaining(), 0)
      assert.deepEqual(requestTools(provider.requests[0]), ['publish_scene', 'cast_scene'])
      assert.equal(events.some((event) => event.type === 'video_plan' || event.type === 'video_plan_error'), false)
      assert.equal(events.at(-1)?.type, 'done')
    } finally {
      provider.restore()
    }
  })
})

test('a dangling tool call left by an interrupted run is closed before the next scene', async () => {
  await withTempTraces(async ({ runDirectorAgent }) => {
    const repo = new JsonlSessionRepo({ fs: new NodeExecutionEnv({ cwd: process.cwd() }), sessionsRoot: resolve(process.cwd(), '.agent-traces') })
    const session = await repo.create({ id: 'loop-dangling', cwd: process.cwd(), metadata: { kind: 'palace-story-director', storyId: 'palace-validation' } })
    await session.appendMessage({ role: 'user', content: [{ type: 'text', text: '请开始故事' }], timestamp: 1 })
    await session.appendMessage({
      role: 'assistant',
      content: [{ type: 'toolCall', id: 'call-old', name: 'generate_segment', arguments: { sequence: 1 } }],
      api: 'openai-completions', provider: 'deepseek', model: 'm',
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: 'toolUse', timestamp: 2,
    })

    const provider = installScriptedProvider([
      { tool: 'publish_scene', args: scene },
    ])
    try {
      await runDirectorAgent({
        apiKey: 'test-key', modelId: 'deepseek-v4-flash',
        context: { ok: true, sessionId: 'loop-dangling', turn: 2, input: { type: 'choice', choice: scene.scene.choices[0] } },
        actors, castings, traceId: 'trace-dangling', videoMode: 'off',
        send: () => {},
      })
      const entries = await readEntries('loop-dangling')
      const closed = entries.find((entry) =>
        entry.type === 'message' && entry.message.role === 'toolResult' && entry.message.toolCallId === 'call-old' && entry.message.isError)
      assert.ok(closed)
    } finally {
      provider.restore()
    }
  })
})
