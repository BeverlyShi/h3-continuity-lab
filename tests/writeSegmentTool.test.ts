import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createWriteSegmentTool,
  describeReferenceImages,
  prepareWriteSegment,
  prepareWriteSegmentArguments,
  WRITE_SEGMENT_ARGUMENTS_EXAMPLE_FIRST,
  WRITE_SEGMENT_ARGUMENTS_EXAMPLE_NEXT,
  type ExistingSegment,
} from '../server/writeSegmentTool.ts'
import type { SceneCharacter, SceneDialogue } from '../src/types/story.ts'

const characters: SceneCharacter[] = [
  { id: 'li_gonggong', name: '李公公', gender: 'male', minAge: 45, maxAge: 55 },
  { id: 'heroine', name: '沈知微', gender: 'female', minAge: 16, maxAge: 16 },
]
const dialogues: SceneDialogue[] = [
  { id: 'line_1', characterId: 'li_gonggong', text: '下车吧，规矩记牢。' },
  { id: 'line_2', characterId: 'heroine', text: '知道了。' },
]

const segment1Prompt = '0–5秒：固定双人中景，机位与人物视线齐平。李公公站在画面左侧，面朝右侧车门开口说话，{{line_1}}。沈知微从车门向他看来。背景只有轻微风声。\n\n5–7秒：硬切至沈知微近景，镜头固定。她扶着车门框停住，望向画外左侧。安静。'
const segment2Prompt = '0–8秒：固定双人中景，李公公仍在画面左侧，沈知微踩下车凳站到台阶前，低头答话，{{line_2}}。鞋底轻擦石阶。'

const noExisting: ExistingSegment[] = []

test('writes the first segment, computing cumulative seconds and remaining lines', () => {
  const { segment, cumulativeSeconds, remainingLines } = prepareWriteSegment({
    sequence: 1,
    characters: ['li_gonggong', 'heroine'],
    seconds: 7,
    style: '写实古装宫廷剧，清晨冷色光线从画面右侧照入。',
    isLast: false,
    prompt: segment1Prompt,
  }, { characters, dialogues, existingSegments: noExisting })

  assert.equal(cumulativeSeconds, 7)
  assert.deepEqual(remainingLines, [dialogues[1]])
  assert.ok(segment.prompt.includes('李公公说：“下车吧，规矩记牢。”'))
  assert.deepEqual(segment.lineIds, ['line_1'])
})

test('rejects a skipped sequence number', () => {
  assert.throws(() => prepareWriteSegment({
    sequence: 2,
    characters: ['li_gonggong', 'heroine'],
    seconds: 8,
    isLast: true,
    prompt: segment2Prompt,
  }, { characters, dialogues, existingSegments: noExisting }), /sequence 必须是 1/)
})

test('rejects writing the next segment before the previous one is generated', () => {
  const existing: ExistingSegment[] = [{ sequence: 1, seconds: 7, lineIds: ['line_1'] }]
  assert.throws(() => prepareWriteSegment({
    sequence: 2,
    characters: ['li_gonggong', 'heroine'],
    seconds: 8,
    isLast: true,
    prompt: segment2Prompt,
  }, { characters, dialogues, existingSegments: existing }), /第 1 段尚未生成/)
})

test('requires style on the first segment and isLast on the third', () => {
  assert.throws(() => prepareWriteSegment({
    sequence: 1,
    characters: ['li_gonggong', 'heroine'],
    seconds: 7,
    isLast: false,
    prompt: segment1Prompt,
  }, { characters, dialogues, existingSegments: noExisting }), /第 1 段必须提交 style/)

  const existingTwo: ExistingSegment[] = [
    { sequence: 1, seconds: 7, lineIds: ['line_1'], generated: {} },
    { sequence: 2, seconds: 8, lineIds: [], generated: {} },
  ]
  assert.throws(() => prepareWriteSegment({
    sequence: 3,
    characters: ['heroine'],
    seconds: 8,
    isLast: false,
    prompt: '0–8秒：沈知微近景，平视，固定。她站在台阶前，望向画面右侧。{{line_2}}',
  }, { characters, dialogues, existingSegments: existingTwo }), /第 3 段必须是本幕最后一段/)
})

test('enforces the dialogue prefix rule: must continue in order, no gaps, no repeats', () => {
  const outOfOrder = prepareWriteSegment.bind(null, {
    sequence: 1,
    characters: ['li_gonggong', 'heroine'],
    seconds: 7,
    style: '写实古装宫廷剧，清晨冷色光线从画面右侧照入。',
    isLast: false,
    prompt: segment1Prompt.replace('{{line_1}}', '{{line_2}}'),
  }, { characters, dialogues, existingSegments: noExisting })
  assert.throws(outOfOrder, /必须紧接此前已写段落之后、按原顺序使用/)
})

test('a non-last segment may leave dialogue for later, but the last segment must use it all', () => {
  const existingOne: ExistingSegment[] = [{ sequence: 1, seconds: 7, lineIds: ['line_1'], generated: {} }]

  // 第 2 段不是最后一段，可以先不用完剩余台词。
  const silent = prepareWriteSegment({
    sequence: 2,
    characters: ['li_gonggong', 'heroine'],
    seconds: 8,
    isLast: false,
    prompt: segment2Prompt.replace('，{{line_2}}', ''),
  }, { characters, dialogues, existingSegments: existingOne })
  assert.deepEqual(silent.remainingLines, [dialogues[1]])

  // isLast 时必须用完全部剩余台词。
  assert.throws(() => prepareWriteSegment({
    sequence: 2,
    characters: ['li_gonggong', 'heroine'],
    seconds: 8,
    isLast: true,
    prompt: segment2Prompt.replace('，{{line_2}}', ''),
  }, { characters, dialogues, existingSegments: existingOne }), /必须用完全部剩余台词/)

  const complete = prepareWriteSegment({
    sequence: 2,
    characters: ['li_gonggong', 'heroine'],
    seconds: 8,
    isLast: true,
    prompt: segment2Prompt,
  }, { characters, dialogues, existingSegments: existingOne })
  assert.equal(complete.remainingLines.length, 0)
})

test('enforces per-segment and whole-scene time budgets', () => {
  const existingOne: ExistingSegment[] = [{ sequence: 1, seconds: 40, lineIds: ['line_1'], generated: {} }]
  // 累计超过 45 秒上限
  assert.throws(() => prepareWriteSegment({
    sequence: 2,
    characters: ['li_gonggong', 'heroine'],
    seconds: 10,
    isLast: true,
    prompt: segment2Prompt,
  }, { characters, dialogues, existingSegments: existingOne }), /累计秒数 50 秒，超过整幕上限 45 秒/)

  // 最后一段累计不足 15 秒
  assert.throws(() => prepareWriteSegment({
    sequence: 1,
    characters: ['li_gonggong', 'heroine'],
    seconds: 5,
    style: '写实古装宫廷剧，清晨冷色光线从画面右侧照入。',
    isLast: true,
    prompt: '0–5秒：固定双人中景。李公公开口，{{line_1}}沈知微低头答话，{{line_2}}',
  }, { characters, dialogues, existingSegments: noExisting }), /最后一段必须满足累计不少于 15 秒且至少 2 段/)
})

test('describes reference images for the three cases', () => {
  const lookupActor = (characterId: string) => (characterId === 'li_gonggong' ? { actorId: 'actor-a', hasImage: true } : undefined)

  assert.deepEqual(
    describeReferenceImages(1, ['li_gonggong', 'heroine'], { hasPreviousTailFrame: true, lookupActor }),
    [{ type: 'previous_scene_tail_frame' }],
  )
  assert.deepEqual(
    describeReferenceImages(1, ['li_gonggong', 'heroine'], { hasPreviousTailFrame: false, lookupActor }),
    [{ type: 'character', characterId: 'li_gonggong', actorId: 'actor-a' }],
  )
  assert.deepEqual(
    describeReferenceImages(2, ['li_gonggong', 'heroine'], { hasPreviousTailFrame: false, lookupActor }),
    [{ type: 'start_frame', sequence: 1 }],
  )
})

test('schema errors include the two-segment example and structure guidance', () => {
  assert.throws(() => prepareWriteSegmentArguments({ sequence: 1, characters: [], seconds: 7, isLast: false, prompt: segment1Prompt, extra: true }), (error: unknown) => {
    assert.ok(error instanceof Error)
    assert.match(error.message, /write_segment 参数不符合 schema/)
    assert.match(error.message, /每次只提交一段/)
    assert.ok(error.message.includes(WRITE_SEGMENT_ARGUMENTS_EXAMPLE_FIRST))
    assert.ok(error.message.includes(WRITE_SEGMENT_ARGUMENTS_EXAMPLE_NEXT))
    return true
  })
})

test('rewriting a segment through the tool truncates every later written segment', async () => {
  const segments: Array<{ sequence: number; characters: string[]; seconds: number; isLast: boolean; prompt: string; lineIds: string[]; generated?: unknown }> = []
  const tool = createWriteSegmentTool({
    getCharacters: () => characters,
    getDialogues: () => dialogues,
    getExistingSegments: () => segments,
    getHasPreviousTailFrame: () => false,
    lookupActor: () => undefined,
    onWrite: (result) => {
      const truncated = segments.filter((segment) => segment.sequence < result.segment.sequence)
      segments.length = 0
      segments.push(...truncated, { ...result.segment, generated: undefined })
    },
  })

  await tool.execute('call-1', {
    sequence: 1,
    characters: ['li_gonggong', 'heroine'],
    seconds: 7,
    style: '写实古装宫廷剧，清晨冷色光线从画面右侧照入。',
    isLast: false,
    prompt: segment1Prompt,
  })
  segments[0].generated = { durationSeconds: 7, visualState: {} }
  await tool.execute('call-2', {
    sequence: 2,
    characters: ['li_gonggong', 'heroine'],
    seconds: 8,
    isLast: true,
    prompt: segment2Prompt,
  })
  assert.equal(segments.length, 2)

  // 重写第 1 段：第 2 段应当被丢弃。
  await tool.execute('call-3', {
    sequence: 1,
    characters: ['li_gonggong', 'heroine'],
    seconds: 6,
    style: '写实古装宫廷剧，色调偏暖。',
    isLast: false,
    prompt: '0–6秒：固定双人中景。李公公站在画面左侧，面朝右侧车门开口说话，{{line_1}}。沈知微从车门向他看来。安静。',
  })
  assert.equal(segments.length, 1)
  assert.equal(segments[0].seconds, 6)
})
