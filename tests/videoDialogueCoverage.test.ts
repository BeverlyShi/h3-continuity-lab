import assert from 'node:assert/strict'
import test from 'node:test'
import { createWriteVideoPromptTool, prepareVideoPlan } from '../server/videoPlanTool.ts'
import type { SceneCharacter, SceneDialogue, VideoPromptDraft } from '../src/types/story.ts'

const characters: SceneCharacter[] = [
  { id: 'li_gonggong', name: '李公公', gender: 'male', minAge: 45, maxAge: 55 },
  { id: 'heroine', name: '沈知微', gender: 'female', minAge: 16, maxAge: 16 },
]
const dialogues: SceneDialogue[] = [
  { id: 'line_1', characterId: 'li_gonggong', text: '下车吧，进了这道门，规矩就得记牢。' },
  { id: 'line_2', characterId: 'heroine', text: '知道了。' },
]
const draft: VideoPromptDraft = {
  visualContext: { style: '写实古装宫廷剧，清晨冷色光线从画面右侧照入。', scene: '宫门外侧石阶下的一小块空地，马车停在台阶前。' },
  videoPrompts: dialogues.map((line) => ({
    characterIds: ['li_gonggong', 'heroine'],
    beats: [{ visual: `固定双人中景，机位与人物视线齐平，从马车侧面拍摄。李公公站在画面左侧，面朝右侧车门开口说话。沈知微从车门向他看来。{{${line.id}}}。`, dialogueIds: [line.id], audio: '背景只有轻微风声。' }],
    endFrame: '固定双人中景，李公公仍在画面左侧，沈知微从车门望向他。',
  })),
}

test('retains every word, punctuation mark and speaker from d1087476 when rendering a dialogue id', () => {
  const { video } = prepareVideoPlan(draft, characters, dialogues)
  assert.ok(video.videoPrompts[0].prompt.includes(`李公公说：“${dialogues[0].text}”`))
  assert.ok(video.videoPrompts[1].prompt.includes(`沈知微说：“${dialogues[1].text}”`))
  assert.equal(video.totalDuration, 15)
  assert.deepEqual(draft.videoPrompts[0].beats[0].dialogueIds, ['line_1'])
})

test('rejects omitted, unknown, duplicate and reordered dialogue references before publishing', async () => {
  for (const [ids, expected] of [
    [[[], ['line_2']], /尚未安排 line_1.*下车吧/],
    [[['missing'], ['line_2']], /未知台词 missing/],
    [[['line_1', 'line_1'], ['line_2']], /line_1 重复安排/],
    [[['line_2'], ['line_1']], /台词顺序必须与 narrative 一致/],
  ] as Array<[string[][], RegExp]>) {
    let published = false
    const tool = createWriteVideoPromptTool(characters, dialogues, () => { published = true })
    await assert.rejects(() => tool.execute('coverage', {
      ...draft,
      videoPrompts: draft.videoPrompts.map((segment, index) => ({
        ...segment, beats: [{ ...segment.beats[0], dialogueIds: ids[index] }],
      })),
    }), expected)
    assert.equal(published, false)
  }
})

test('cannot override source text or speaker and must include the source speaker in the segment cast', () => {
  assert.throws(() => prepareVideoPlan({
    ...draft,
    videoPrompts: draft.videoPrompts.map((segment) => ({
      ...segment, beats: [{ ...segment.beats[0], dialogue: [{ characterId: 'heroine', text: '进了这道门。' }] }],
    })),
  }, characters, dialogues), /参数不符合 schema/)
  assert.throws(() => prepareVideoPlan({
    ...draft, videoPrompts: draft.videoPrompts.map((segment) => ({ ...segment, characterIds: ['heroine'] })),
  }, characters, dialogues), /说话人物 li_gonggong 未列入 characterIds/)
})

test('uses the complete source text for timing and reports conflicts instead of shortening it', () => {
  const longer = [{ ...dialogues[0], text: '沈'.repeat(31) }, dialogues[1]]
  const { video } = prepareVideoPlan(draft, characters, longer)
  assert.equal(video.videoPrompts[0].endTime, 10)
  assert.ok(video.videoPrompts[0].prompt.includes(longer[0].text))
  assert.throws(() => prepareVideoPlan(draft, characters, [{ ...dialogues[0], text: '沈'.repeat(40) }, dialogues[1]]), (error: unknown) => {
    assert.ok(error instanceof Error)
    assert.match(error.message, /台词不可删改.*时长冲突/)
    assert.doesNotMatch(error.message, /删减至少/)
    return true
  })
})

test('keeps identical words spoken by different people as distinct source lines', () => {
  const repeated = dialogues.map((line) => ({ ...line, text: '站住。' }))
  const { video } = prepareVideoPlan(draft, characters, repeated)
  assert.match(video.videoPrompts[0].prompt, /李公公说：“站住。”/)
  assert.match(video.videoPrompts[1].prompt, /沈知微说：“站住。”/)
})

test('accepts a silent narrative without inventing dialogue', () => {
  const { video } = prepareVideoPlan({
    ...draft, videoPrompts: draft.videoPrompts.map((segment) => ({
      ...segment, beats: [{ ...segment.beats[0], visual: segment.beats[0].visual.replace(/\{\{[^{}]+\}\}/g, ''), dialogueIds: [] }],
    })),
  }, characters, [])
  assert.doesNotMatch(video.videoPrompts.map((segment) => segment.prompt).join('\n'), /说“/)
})
