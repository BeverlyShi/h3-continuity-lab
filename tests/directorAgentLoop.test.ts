import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import test from 'node:test'
import { JsonlSessionRepo, NodeExecutionEnv, type Entry } from '@earendil-works/pi-agent-core/node'
import { SCENE_PUBLISH_ARGUMENTS_EXAMPLE } from '../server/publishSceneTool.ts'
import { WRITE_SEGMENT_ARGUMENTS_EXAMPLE_FIRST, WRITE_SEGMENT_ARGUMENTS_EXAMPLE_NEXT } from '../server/writeSegmentTool.ts'
import { findAwaitingUpload, findUnresolvedToolCall } from '../server/directorTurnState.ts'
import type { CastableActor } from '../src/types/actor.ts'
import type { DirectorStreamEvent } from '../src/types/director.ts'
import type { TailFrameVisualState } from '../src/types/story.ts'
import { installScriptedProvider, messageText, type ScriptedStep } from './helpers/scriptedProvider.ts'

const scene = JSON.parse(SCENE_PUBLISH_ARGUMENTS_EXAMPLE)
const write1 = JSON.parse(WRITE_SEGMENT_ARGUMENTS_EXAMPLE_FIRST)
const write2 = JSON.parse(WRITE_SEGMENT_ARGUMENTS_EXAMPLE_NEXT)
const actors: CastableActor[] = [
  { id: 'actor-young', name: '演员甲', gender: 'female', minAge: 16, maxAge: 22, hasImage: true },
  { id: 'actor-elder', name: '演员乙', gender: 'female', minAge: 40, maxAge: 55, hasImage: true },
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

test('a full segment loop: write/generate pause the turn, resume feeds the measured state back, finish_turn compiles the plan', async () => {
  await withTempTraces(async ({ runDirectorAgent, resumeDirectorAgent }) => {
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
      const events: DirectorStreamEvent[] = []
      const outcome = await runDirectorAgent({
        apiKey: 'test-key', modelId: 'deepseek-v4-flash',
        context: { ok: true, sessionId: 'loop-segment', turn: 1, input: { type: 'start' } },
        actors, castings: [], traceId: 'trace-1', videoMode: 'manual',
        send: (event) => events.push(event),
      })

      assert.equal(outcome.paused, true)
      assert.equal(provider.requests.length, 4)
      for (const request of provider.requests) {
        assert.deepEqual(requestTools(request), ['publish_scene', 'cast_scene', 'write_segment', 'generate_segment', 'finish_turn'])
      }
      const types = events.map((event) => event.type)
      assert.ok(types.includes('awaiting_upload'))
      assert.equal(types.includes('done'), false)
      const awaiting1 = events.find((event) => event.type === 'awaiting_upload')
      assert.ok(awaiting1?.type === 'awaiting_upload')
      assert.equal(awaiting1.sequence, 1)
      assert.deepEqual(awaiting1.referenceImages, [
        { type: 'character', characterId: 'heroine', actorId: 'actor-young' },
        { type: 'character', characterId: 'steward', actorId: 'actor-elder' },
      ])
      const trace1 = events.findLast((event) => event.type === 'harness_trace')
      assert.ok(trace1?.type === 'harness_trace')
      assert.equal(trace1.trace.outcome, 'suspended')

      const entriesAfterPause = await readEntries('loop-segment')
      const unresolved = findUnresolvedToolCall(entriesAfterPause)
      assert.equal(unresolved?.toolCallId, awaiting1.toolCallId)
      assert.equal(unresolved?.toolName, 'generate_segment')
      const awaitingState = findAwaitingUpload(entriesAfterPause)
      assert.equal(awaitingState?.pending.toolCallId, awaiting1.toolCallId)

      // 恢复第 1 段：注入假 VLM，检查请求里最后一条 tool 消息带回原 toolCallId 和实测状态。
      const state1 = makeVisualState('廊下-1')
      const resumeEvents1: DirectorStreamEvent[] = []
      const outcome1 = await resumeDirectorAgent({
        sessionId: 'loop-segment', sequence: 1, toolCallId: awaiting1.toolCallId,
        tailFrameDataUrl: 'data:image/png;base64,AAAA', durationSeconds: 5.4,
        apiKey: 'test-key', deepseekKey: 'test-deepseek-key',
        send: (event) => resumeEvents1.push(event),
        analyze: async () => state1,
      })

      assert.equal(outcome1.paused, true)
      assert.equal(provider.requests.length, 6)
      const continueRequest = provider.requests[4]
      const lastToolMessage = continueRequest.body.messages.filter((message) => message.role === 'tool').at(-1)
      assert.ok(lastToolMessage)
      assert.equal((lastToolMessage as unknown as { tool_call_id: string }).tool_call_id, awaiting1.toolCallId)
      assert.match(messageText(lastToolMessage), /廊下-1/)
      assert.ok(resumeEvents1.some((event) => event.type === 'segment_generated' && event.sequence === 1))

      const awaiting2 = resumeEvents1.find((event) => event.type === 'awaiting_upload')
      assert.ok(awaiting2?.type === 'awaiting_upload')
      assert.equal(awaiting2.sequence, 2)
      assert.deepEqual(awaiting2.referenceImages, [{ type: 'start_frame', sequence: 1 }])
      const trace2 = resumeEvents1.findLast((event) => event.type === 'harness_trace')
      assert.ok(trace2?.type === 'harness_trace')
      assert.equal(trace2.trace.outcome, 'suspended')

      // 恢复第 2 段（最后一段）：完成回合，收到 video_plan、scene_visual_state、done。
      const state2 = makeVisualState('廊下-2')
      const resumeEvents2: DirectorStreamEvent[] = []
      const outcome2 = await resumeDirectorAgent({
        sessionId: 'loop-segment', sequence: 2, toolCallId: awaiting2.toolCallId,
        tailFrameDataUrl: 'data:image/png;base64,BBBB', durationSeconds: 9.8,
        apiKey: 'test-key', deepseekKey: 'test-deepseek-key',
        send: (event) => resumeEvents2.push(event),
        analyze: async () => state2,
      })

      assert.equal(provider.remaining(), 0)
      assert.equal(outcome2.paused, false)
      assert.equal(outcome2.video?.videoPrompts.length, 2)
      assert.equal(outcome2.video?.totalDuration, 15)
      const types2 = resumeEvents2.map((event) => event.type)
      assert.ok(types2.indexOf('video_plan') < types2.indexOf('scene_visual_state'))
      assert.ok(types2.indexOf('scene_visual_state') < types2.indexOf('done'))
      const visualStateEvent = resumeEvents2.find((event) => event.type === 'scene_visual_state')
      assert.ok(visualStateEvent?.type === 'scene_visual_state')
      assert.deepEqual(visualStateEvent.visualState, state2)
      const trace3 = resumeEvents2.findLast((event) => event.type === 'harness_trace')
      assert.ok(trace3?.type === 'harness_trace')
      assert.equal(trace3.trace.outcome, 'completed')
    } finally {
      provider.restore()
    }
  })
})

test('starting a new turn after an unresolved pause abandons it with an isError tool result and runs normally', async () => {
  await withTempTraces(async ({ runDirectorAgent }) => {
    const provider = installScriptedProvider([
      { tool: 'publish_scene', args: scene },
      { tool: 'cast_scene', args: castAssignments },
      { tool: 'write_segment', args: write1 },
      { tool: 'generate_segment', args: { sequence: 1 } },
      { tool: 'publish_scene', args: scene },
      { tool: 'finish_turn', args: {} },
    ])
    try {
      const outcome1 = await runDirectorAgent({
        apiKey: 'test-key', modelId: 'deepseek-v4-flash',
        context: { ok: true, sessionId: 'loop-abandon', turn: 1, input: { type: 'start' } },
        actors, castings: [], traceId: 'trace-abandon-1', videoMode: 'manual',
        send: () => {},
      })
      assert.equal(outcome1.paused, true)

      const events2: DirectorStreamEvent[] = []
      const outcome2 = await runDirectorAgent({
        apiKey: 'test-key', modelId: 'deepseek-v4-flash',
        context: { ok: true, sessionId: 'loop-abandon', turn: 2, input: { type: 'choice', choice: scene.scene.choices[0] } },
        actors,
        castings: [{ characterId: 'heroine', actorId: 'actor-young' }, { characterId: 'steward', actorId: 'actor-elder' }],
        traceId: 'trace-abandon-2', videoMode: 'off',
        send: (event) => events2.push(event),
      })
      assert.equal(provider.remaining(), 0)
      assert.equal(outcome2.paused, false)
      assert.equal(events2.at(-1)?.type, 'done')

      const entries = await readEntries('loop-abandon')
      const abandoned = entries.find((entry) =>
        entry.type === 'message' && entry.message.role === 'toolResult' && entry.message.isError
        && messageTextOf(entry.message.content).includes('玩家未上传该段视频，本次 generate_segment 作废'))
      assert.ok(abandoned)
    } finally {
      provider.restore()
    }
  })
})

function messageTextOf(content: Array<{ type: string; text?: string }>) {
  return content.flatMap((item) => (item.type === 'text' && item.text ? [item.text] : [])).join('\n')
}

test('rejects resuming with a mismatched sequence or tool call id, and does not touch the session', async () => {
  await withTempTraces(async ({ runDirectorAgent, resumeDirectorAgent }) => {
    const provider = installScriptedProvider([
      { tool: 'publish_scene', args: scene },
      { tool: 'cast_scene', args: castAssignments },
      { tool: 'write_segment', args: write1 },
      { tool: 'generate_segment', args: { sequence: 1 } },
    ])
    try {
      const events: DirectorStreamEvent[] = []
      await runDirectorAgent({
        apiKey: 'test-key', modelId: 'deepseek-v4-flash',
        context: { ok: true, sessionId: 'loop-mismatch', turn: 1, input: { type: 'start' } },
        actors, castings: [], traceId: 'trace-mismatch', videoMode: 'manual',
        send: (event) => events.push(event),
      })
      const awaiting = events.find((event) => event.type === 'awaiting_upload')
      assert.ok(awaiting?.type === 'awaiting_upload')
      const before = await readEntries('loop-mismatch')

      await assert.rejects(() => resumeDirectorAgent({
        sessionId: 'loop-mismatch', sequence: 2, toolCallId: awaiting.toolCallId,
        tailFrameDataUrl: 'data:image/png;base64,AAAA', durationSeconds: 5,
        apiKey: 'test-key', deepseekKey: 'test-deepseek-key',
        send: () => {},
        analyze: async () => makeVisualState('x'),
      }))
      await assert.rejects(() => resumeDirectorAgent({
        sessionId: 'loop-mismatch', sequence: 1, toolCallId: 'wrong-call-id',
        tailFrameDataUrl: 'data:image/png;base64,AAAA', durationSeconds: 5,
        apiKey: 'test-key', deepseekKey: 'test-deepseek-key',
        send: () => {},
        analyze: async () => makeVisualState('x'),
      }))

      const after = await readEntries('loop-mismatch')
      assert.equal(after.length, before.length)
    } finally {
      provider.restore()
    }
  })
})

test('does not touch the session when tail-frame vision analysis fails', async () => {
  await withTempTraces(async ({ runDirectorAgent, resumeDirectorAgent }) => {
    const provider = installScriptedProvider([
      { tool: 'publish_scene', args: scene },
      { tool: 'cast_scene', args: castAssignments },
      { tool: 'write_segment', args: write1 },
      { tool: 'generate_segment', args: { sequence: 1 } },
    ])
    try {
      const events: DirectorStreamEvent[] = []
      await runDirectorAgent({
        apiKey: 'test-key', modelId: 'deepseek-v4-flash',
        context: { ok: true, sessionId: 'loop-vlm-fail', turn: 1, input: { type: 'start' } },
        actors, castings: [], traceId: 'trace-vlm-fail', videoMode: 'manual',
        send: (event) => events.push(event),
      })
      const awaiting = events.find((event) => event.type === 'awaiting_upload')
      assert.ok(awaiting?.type === 'awaiting_upload')
      const before = await readEntries('loop-vlm-fail')

      await assert.rejects(() => resumeDirectorAgent({
        sessionId: 'loop-vlm-fail', sequence: 1, toolCallId: awaiting.toolCallId,
        tailFrameDataUrl: 'data:image/png;base64,AAAA', durationSeconds: 5,
        apiKey: 'test-key', deepseekKey: 'test-deepseek-key',
        send: () => {},
        analyze: async () => { throw new Error('DeepSeek Vision 请求失败。') },
      }), /DeepSeek Vision 请求失败/)

      const after = await readEntries('loop-vlm-fail')
      assert.equal(after.length, before.length)
    } finally {
      provider.restore()
    }
  })
})
