import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { SCENE_PUBLISH_ARGUMENTS_EXAMPLE } from '../server/publishSceneTool.ts'
import { VIDEO_PLAN_ARGUMENTS_EXAMPLE } from '../server/videoPlanTool.ts'
import type { CastableActor } from '../src/types/actor.ts'
import type { DirectorStreamEvent } from '../src/types/director.ts'
import { installScriptedProvider, messageText, type ScriptedStep } from './helpers/scriptedProvider.ts'

const scene = JSON.parse(SCENE_PUBLISH_ARGUMENTS_EXAMPLE)
const plan = JSON.parse(VIDEO_PLAN_ARGUMENTS_EXAMPLE)
const actors: CastableActor[] = [
  { id: 'actor-young', name: '演员甲', gender: 'female', minAge: 16, maxAge: 22 },
  { id: 'actor-elder', name: '演员乙', gender: 'female', minAge: 40, maxAge: 55 },
  { id: 'actor-man', name: '演员丙', gender: 'male', minAge: 30, maxAge: 40 },
]

const withTempTraces = async (run: (runDirectorAgent: typeof import('../server/directorAgent.ts')['runDirectorAgent']) => Promise<void>) => {
  const previousCwd = process.cwd()
  const directory = await mkdtemp(join(tmpdir(), 'director-loop-'))
  process.chdir(directory)
  try {
    const { runDirectorAgent } = await import('../server/directorAgent.ts')
    await run(runDirectorAgent)
  } finally {
    process.chdir(previousCwd)
    await rm(directory, { recursive: true, force: true })
  }
}

const requestTools = (request: { body: { tools?: Array<{ function: { name: string } }> } }) =>
  request.body.tools?.map((tool) => tool.function.name) ?? []

const lastToolResult = (request: { body: { messages: Array<{ role: string; content: string | Array<{ type: string; text?: string }> | null }> } }) =>
  messageText(request.body.messages.filter((message) => message.role === 'tool').at(-1))

test('one agent drives publish → search → cast → write → finish, self-corrects on tool errors and streams the scene early', async () => {
  await withTempTraces(async (runDirectorAgent) => {
    const malformedScene = { scene: { ...scene.scene, choices: scene.scene.choices.slice(0, 1), characters: scene.characters } }
    const missingLine = { ...plan, segments: plan.segments.map((segment: { prompt: string }) => ({ ...segment, prompt: segment.prompt.replace('{{line_1}}', '姑姑开口问话') })) }
    const script: ScriptedStep[] = [
      { tool: 'publish_scene', args: malformedScene },
      { tool: 'publish_scene', args: scene, reasoning: '先发布场景。' },
      { tool: 'cast_scene', args: { assignments: [
        { characterId: 'heroine', actorId: 'actor-young', reason: '年龄相符' },
        { characterId: 'steward', actorId: 'actor-elder', reason: '四十多岁，面相端严' },
      ] } },
      { tool: 'write_video_prompt', args: missingLine },
      { tool: 'write_video_prompt', args: plan },
      { tool: 'finish_turn', args: {} },
    ]
    const provider = installScriptedProvider(script)
    const events: DirectorStreamEvent[] = []
    try {
      const result = await runDirectorAgent({
        apiKey: 'test-key', modelId: 'deepseek-v4-flash',
        context: { ok: true, sessionId: 'loop-happy', turn: 1, input: { type: 'start' } },
        actors, castings: [], traceId: 'loop-happy-1', videoMode: 'manual',
        send: (event) => { events.push(event) },
      })

      assert.equal(provider.remaining(), 0)
      const requests = provider.requests
      assert.equal(requests.length, 6)
      for (const request of requests) {
        assert.equal(request.url, 'https://api.deepseek.com/chat/completions')
        assert.deepEqual(requestTools(request), ['publish_scene', 'cast_scene', 'write_video_prompt', 'finish_turn'])
        assert.equal('tool_choice' in request.body, false)
      }
      assert.match(messageText(requests[0].body.messages.at(-1)), /本局视频模式：上传视频/)
      assert.match(messageText(requests[0].body.messages.at(-1)), /没有起始尾帧/)
      assert.match(lastToolResult(requests[1]), /characters 必须位于顶层/)
      assert.match(lastToolResult(requests[2]), /待选角人物：/)
      assert.match(lastToolResult(requests[2]), /掌事姑姑（steward，女 40–50）：候选 演员乙（actor-elder，40–55）/)
      assert.match(lastToolResult(requests[2]), /女主（heroine，女 16–20）：候选 演员甲（actor-young，16–22）/)
      assert.match(lastToolResult(requests[3]), /女主：演员甲，有参考图/)
      assert.match(lastToolResult(requests[4]), /尚未安排 line_1/)
      assert.match(lastToolResult(requests[5]), /掌事姑姑说：“你识字吗？”/)
      assert.match(lastToolResult(requests[5]), /下一步：确认无误后调用 finish_turn/)

      const types = events.map((event) => event.type)
      assert.ok(types.indexOf('scene') < types.indexOf('cast'))
      assert.ok(types.indexOf('cast') < types.indexOf('video_plan'))
      assert.equal(types.filter((type) => type === 'scene').length, 1)
      assert.equal(types.at(-1), 'done')
      assert.equal(types.includes('video_plan_error'), false)
      const castEvent = events.find((event) => event.type === 'cast')
      assert.ok(castEvent?.type === 'cast')
      assert.deepEqual(castEvent.casting, {
        castings: [{ characterId: 'heroine', actorId: 'actor-young' }, { characterId: 'steward', actorId: 'actor-elder' }],
        unmatchedCharacterIds: [],
      })
      assert.equal(result.video?.videoPrompts.length, 2)
      assert.equal(result.video?.totalDuration, 15)
      assert.ok(result.video!.videoPrompts[0].prompt.startsWith(plan.style))
      assert.match(result.video!.videoPrompts[0].prompt, /掌事姑姑说：“你识字吗？”/)
      assert.match(result.video!.videoPrompts[1].prompt, /无音乐，无旁白。$/)
      const trace = events.findLast((event) => event.type === 'harness_trace')
      assert.ok(trace?.type === 'harness_trace')
      assert.equal(trace.trace.outcome, 'completed')
      assert.equal(trace.trace.entries.filter((entry) => entry.kind === 'tool_call').length, 6)
      assert.equal(trace.trace.entries.filter((entry) => entry.kind === 'thinking').length, 1)
    } finally {
      provider.restore()
    }

    // 第二回合：老角色沿用绑定，历史进入上下文，模型无需再选角。
    const second = installScriptedProvider([
      { tool: 'publish_scene', args: scene },
      { tool: 'write_video_prompt', args: plan },
      { tool: 'finish_turn', args: {} },
    ])
    const secondEvents: DirectorStreamEvent[] = []
    try {
      const result = await runDirectorAgent({
        apiKey: 'test-key', modelId: 'deepseek-v4-flash',
        context: { ok: true, sessionId: 'loop-happy', turn: 2, input: { type: 'choice', choice: scene.scene.choices[0] }, hasPreviousTailFrame: true },
        actors, castings: [{ characterId: 'heroine', actorId: 'actor-young' }, { characterId: 'steward', actorId: 'actor-elder' }],
        traceId: 'loop-happy-2', videoMode: 'manual',
        send: (event) => { secondEvents.push(event) },
      })
      assert.equal(second.remaining(), 0)
      const first = second.requests[0].body.messages
      assert.ok(first.some((message) => message.role === 'tool'), '上一回合的工具往返应进入本回合上下文')
      assert.match(messageText(first.at(-1)), /以上一幕尾帧为起始画面/)
      assert.match(lastToolResult(second.requests[1]), /沿用已有选角：女主 → 演员甲；掌事姑姑 → 演员乙/)
      assert.match(lastToolResult(second.requests[1]), /无需调用 cast_scene/)
      assert.deepEqual(result.casting, {
        castings: [{ characterId: 'heroine', actorId: 'actor-young' }, { characterId: 'steward', actorId: 'actor-elder' }],
        unmatchedCharacterIds: [],
      })
      assert.equal(secondEvents.at(-1)?.type, 'done')
    } finally {
      second.restore()
    }
  })
})

test('text-only mode removes write_video_prompt and finishes right after publishing', async () => {
  await withTempTraces(async (runDirectorAgent) => {
    const provider = installScriptedProvider([
      { tool: 'publish_scene', args: scene },
      { tool: 'cast_scene', args: { assignments: [
        { characterId: 'heroine', actorId: null, reason: '仅文字模式' },
        { characterId: 'steward', actorId: null, reason: '仅文字模式' },
      ] } },
      { tool: 'finish_turn', args: {} },
    ])
    const events: DirectorStreamEvent[] = []
    try {
      const result = await runDirectorAgent({
        apiKey: 'test-key', modelId: 'deepseek-v4-flash',
        context: { ok: true, sessionId: 'loop-text-only', turn: 1, input: { type: 'start' } },
        actors, castings: [], traceId: 'loop-text-only', videoMode: 'off',
        send: (event) => { events.push(event) },
      })
      assert.deepEqual(requestTools(provider.requests[0]), ['publish_scene', 'cast_scene', 'finish_turn'])
      assert.match(messageText(provider.requests[0].body.messages.at(-1)), /仅文字/)
      assert.equal(result.video, undefined)
      assert.deepEqual(result.casting, { castings: [], unmatchedCharacterIds: ['heroine', 'steward'] })
      const types = events.map((event) => event.type)
      assert.equal(types.includes('video_plan'), false)
      assert.equal(types.includes('video_plan_error'), false)
      const trace = events.findLast((event) => event.type === 'harness_trace')
      assert.ok(trace?.type === 'harness_trace')
      assert.equal(trace.trace.outcome, 'completed')
    } finally {
      provider.restore()
    }
  })
})

test('nudges a model that stops early, and degrades to text when it skips the video with a reason', async () => {
  await withTempTraces(async (runDirectorAgent) => {
    const provider = installScriptedProvider([
      { tool: 'publish_scene', args: scene },
      { text: '场景写好了。' },
      { tool: 'cast_scene', args: { assignments: [
        { characterId: 'heroine', actorId: 'actor-young', reason: '年龄相符' },
        { characterId: 'steward', actorId: 'actor-elder', reason: '年龄相符' },
      ] } },
      { tool: 'finish_turn', args: { skipVideo: { reason: '本幕台词过长，装不进三段。' } } },
    ])
    const events: DirectorStreamEvent[] = []
    try {
      const result = await runDirectorAgent({
        apiKey: 'test-key', modelId: 'deepseek-v4-flash',
        context: { ok: true, sessionId: 'loop-nudge', turn: 1, input: { type: 'start' } },
        actors, castings: [], traceId: 'loop-nudge', videoMode: 'auto',
        send: (event) => { events.push(event) },
      })
      assert.equal(provider.remaining(), 0)
      assert.match(messageText(provider.requests[2].body.messages.at(-1)), /本回合尚未结束：还没有编写分镜/)
      assert.equal(result.video, undefined)
      const videoError = events.find((event) => event.type === 'video_plan_error')
      assert.ok(videoError?.type === 'video_plan_error')
      assert.match(videoError.message, /本幕台词过长/)
      const trace = events.findLast((event) => event.type === 'harness_trace')
      assert.ok(trace?.type === 'harness_trace')
      assert.equal(trace.trace.outcome, 'degraded')
      assert.equal(events.at(-1)?.type, 'done')
    } finally {
      provider.restore()
    }
  })
})

test('refuses to skip steps: finishing before casting and writing shots before publishing are rejected with guidance', async () => {
  await withTempTraces(async (runDirectorAgent) => {
    const provider = installScriptedProvider([
      { tool: 'write_video_prompt', args: plan },
      { tool: 'publish_scene', args: scene },
      { tool: 'finish_turn', args: {} },
      { tool: 'cast_scene', args: { assignments: [
        { characterId: 'heroine', actorId: 'actor-young', reason: '年龄相符' },
        { characterId: 'steward', actorId: 'actor-young', reason: '同一人' },
      ] } },
      { tool: 'cast_scene', args: { assignments: [
        { characterId: 'heroine', actorId: 'actor-young', reason: '年龄相符' },
        { characterId: 'steward', actorId: null, reason: '没有合适的年长演员' },
      ] } },
      { tool: 'write_video_prompt', args: plan },
      { tool: 'finish_turn', args: {} },
    ])
    try {
      const result = await runDirectorAgent({
        apiKey: 'test-key', modelId: 'deepseek-v4-flash',
        context: { ok: true, sessionId: 'loop-guardrails', turn: 1, input: { type: 'start' } },
        actors, castings: [], traceId: 'loop-guardrails', videoMode: 'auto', send: () => {},
      })
      assert.equal(provider.remaining(), 0)
      assert.match(lastToolResult(provider.requests[1]), /必须先通过 publish_scene 发布场景/)
      assert.match(lastToolResult(provider.requests[3]), /以下人物尚未选角：女主、掌事姑姑；请先调用 cast_scene/)
      assert.match(lastToolResult(provider.requests[4]), /同一幕不能撞脸/)
      assert.match(lastToolResult(provider.requests[5]), /掌事姑姑：无参考图/)
      assert.deepEqual(result.casting, { castings: [{ characterId: 'heroine', actorId: 'actor-young' }], unmatchedCharacterIds: ['steward'] })
      assert.equal(result.video?.videoPrompts.length, 2)
    } finally {
      provider.restore()
    }
  })
})

test('gives up after three consecutive failed publish attempts and reports the last error', async () => {
  await withTempTraces(async (runDirectorAgent) => {
    const malformed = { scene: { ...scene.scene, choices: scene.scene.choices.slice(0, 1) }, characters: scene.characters, dialogues: [] }
    const provider = installScriptedProvider([
      { tool: 'publish_scene', args: malformed },
      { tool: 'publish_scene', args: malformed },
      { tool: 'publish_scene', args: malformed },
    ])
    const events: DirectorStreamEvent[] = []
    try {
      await assert.rejects(() => runDirectorAgent({
        apiKey: 'test-key', modelId: 'deepseek-v4-flash',
        context: { ok: true, sessionId: 'loop-give-up', turn: 1, input: { type: 'start' } },
        actors, castings: [], traceId: 'loop-give-up', videoMode: 'auto', send: (event) => { events.push(event) },
      }), /publish_scene 连续 3 次未通过校验/)
      assert.equal(provider.remaining(), 0)
      const trace = events.findLast((event) => event.type === 'harness_trace')
      assert.ok(trace?.type === 'harness_trace')
      assert.equal(trace.trace.outcome, 'failed')
    } finally {
      provider.restore()
    }
  })
})
