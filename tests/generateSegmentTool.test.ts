import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildResumedGenerationSummary,
  createGenerateSegmentTool,
  MAX_GENERATE_ATTEMPTS,
  type SegmentGenerationLookup,
} from '../server/generateSegmentTool.ts'

const makeSegments = (): SegmentGenerationLookup[] => [
  { sequence: 1, generateAttempts: 0 },
  { sequence: 2, generateAttempts: 0 },
]

test('rejects generating a segment that has not been written yet', async () => {
  const segments: SegmentGenerationLookup[] = []
  const tool = createGenerateSegmentTool({ getSegments: () => segments, onGenerate: () => {} })
  await assert.rejects(() => tool.execute('call-1', { sequence: 1 }), /尚未编写第 1 段，请先调用 write_segment/)
})

test('rejects generating the next segment before the previous one is generated', async () => {
  const segments = makeSegments()
  const tool = createGenerateSegmentTool({ getSegments: () => segments, onGenerate: () => {} })
  await assert.rejects(() => tool.execute('call-1', { sequence: 2 }), /第 1 段尚未生成，请先调用 generate_segment/)
})

test('pauses the turn on success, recording the pending sequence and tool call id', async () => {
  const segments = makeSegments()
  const calls: Array<{ sequence: number; toolCallId: string }> = []
  const tool = createGenerateSegmentTool({ getSegments: () => segments, onGenerate: (input) => calls.push(input) })
  const result = await tool.execute('call-1', { sequence: 1 })
  assert.deepEqual(calls, [{ sequence: 1, toolCallId: 'call-1' }])
  assert.deepEqual(result.details, { pending: true })
  assert.equal(result.terminate, false)
})

test('rejects a fourth attempt and enforces the reshoot cap', async () => {
  const segments: SegmentGenerationLookup[] = [{ sequence: 1, generateAttempts: MAX_GENERATE_ATTEMPTS }]
  const tool = createGenerateSegmentTool({ getSegments: () => segments, onGenerate: () => {} })
  await assert.rejects(
    () => tool.execute('call-1', { sequence: 1 }),
    /第 1 段已重拍 3 次仍未通过，请改用 write_segment 重写本段/,
  )
})

test('regenerating a segment invalidates its own and every later segment\'s generated state', async () => {
  const segments: Array<SegmentGenerationLookup & { generated?: unknown }> = [
    { sequence: 1, generateAttempts: 1, generated: { durationSeconds: 7, visualState: {} } },
    { sequence: 2, generateAttempts: 1, generated: { durationSeconds: 8, visualState: {} } },
  ]
  const tool = createGenerateSegmentTool({
    getSegments: () => segments,
    onGenerate: ({ sequence }) => {
      for (const segment of segments) {
        if (segment.sequence === sequence) segment.generateAttempts += 1
        if (segment.sequence >= sequence) segment.generated = undefined
      }
    },
  })
  await tool.execute('call-2', { sequence: 1 })
  assert.equal(segments[0].generated, undefined)
  assert.equal(segments[1].generated, undefined)
  assert.equal(segments[0].generateAttempts, 2)
})

test('builds the resumed generate_segment result text for a non-final and a final segment', () => {
  const visualState = {
    shot_size: '中景' as const,
    shot_position: '人物正前方',
    shot_content: { characters: [], scene: { location: '甬道', visible_elements: '宫墙', lighting: '柔光', time_of_day: '清晨' }, key_props: [] },
    frame_quality: '清晰稳定' as const,
  }

  const middle = buildResumedGenerationSummary({
    sequence: 1, isLast: false, plannedSeconds: 8, durationSeconds: 8.4, visualState, remainingAttempts: 2,
  })
  assert.match(middle, /第 1 段已生成：实际时长 8\.4 秒（计划 8 秒）/)
  assert.match(middle, /调用 write_segment 写第 2 段，首镜构图必须以上述状态为准/)
  assert.doesNotMatch(middle, /相差超过 2 秒/)

  const final = buildResumedGenerationSummary({
    sequence: 2, isLast: true, plannedSeconds: 8, durationSeconds: 11, visualState, remainingAttempts: 1,
  })
  assert.match(final, /相差超过 2 秒/)
  assert.match(final, /全部段已生成，调用 finish_turn/)
})
