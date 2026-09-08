import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createWriteVideoPromptTool,
  minimumSegmentSeconds,
  prepareVideoPlan,
  prepareVideoPlanArguments,
  VIDEO_PLAN_ARGUMENTS_EXAMPLE,
} from '../server/videoPlanTool.ts'
import { compileVideoPlan } from '../server/videoPromptCompiler.ts'
import type { SceneCharacter, SceneDialogue, VideoPlan } from '../src/types/story.ts'

const characters: SceneCharacter[] = [
  { id: 'li_gonggong', name: '李公公', gender: 'male', minAge: 45, maxAge: 55 },
  { id: 'heroine', name: '沈知微', gender: 'female', minAge: 16, maxAge: 16 },
]
const dialogues: SceneDialogue[] = [
  { id: 'line_1', characterId: 'li_gonggong', text: '下车吧，进了这道门，规矩就得记牢。' },
  { id: 'line_2', characterId: 'heroine', text: '知道了。' },
]
const plan: VideoPlan = {
  style: '写实古装宫廷剧，清晨冷色光线从画面右侧照入。',
  segments: [
    {
      characters: ['li_gonggong', 'heroine'],
      seconds: 7,
      prompt: '0–5秒：固定双人中景，机位与人物视线齐平，从马车侧面拍摄。李公公站在画面左侧，面朝右侧车门开口说话，{{line_1}}。沈知微从车门向他看来。背景只有轻微风声。\n\n5–7秒：硬切至沈知微近景，镜头固定。她扶着车门框停住，望向画外左侧。安静。',
    },
    {
      characters: ['li_gonggong', 'heroine'],
      seconds: 8,
      prompt: '0–8秒：固定双人中景，李公公仍在画面左侧，沈知微踩下车凳站到台阶前，低头答话，{{line_2}}。鞋底轻擦石阶。',
    },
  ],
}

const withSegments = (patch: (segment: VideoPlan['segments'][number], index: number) => Partial<VideoPlan['segments'][number]>): VideoPlan => ({
  ...plan,
  segments: plan.segments.map((segment, index) => ({ ...segment, ...patch(segment, index) })),
})

test('renders dialogue placeholders with the speaker name and exact source text, then derives a continuous timeline', () => {
  const { video, summary } = prepareVideoPlan(plan, characters, dialogues)
  assert.ok(video.videoPrompts[0].prompt.includes(`李公公说：“${dialogues[0].text}”`))
  assert.ok(video.videoPrompts[1].prompt.includes(`沈知微说：“${dialogues[1].text}”`))
  assert.deepEqual(video.videoPrompts.map((segment) => [segment.sequence, segment.startTime, segment.endTime]), [[1, 0, 7], [2, 7, 15]])
  assert.equal(video.totalDuration, 15)
  assert.equal(video.style, plan.style)
  assert.match(summary, /共 2 段 15 秒/)
  assert.match(summary, /第 1 段 0–7 秒（line_1）/)
  assert.match(summary, /line_1、line_2 已全部按原顺序安排/)
  assert.doesNotMatch(JSON.stringify(video), /\{\{|li_gonggong说|heroine说/)
})

test('the system prompt example passes validation against the publish example', () => {
  const scene = JSON.parse('{"characters":[{"id":"heroine","name":"女主","gender":"female","minAge":16,"maxAge":20},{"id":"steward","name":"掌事姑姑","gender":"female","minAge":40,"maxAge":50}],"dialogues":[{"id":"line_1","characterId":"steward","text":"你识字吗？"}]}')
  const { video } = prepareVideoPlan(JSON.parse(VIDEO_PLAN_ARGUMENTS_EXAMPLE), scene.characters, scene.dialogues)
  assert.equal(video.totalDuration, 15)
  assert.match(video.videoPrompts[0].prompt, /掌事姑姑说：“你识字吗？”/)
})

test('rejects omitted, unknown, duplicate and reordered dialogue references', () => {
  const cases: Array<[VideoPlan, RegExp]> = [
    [withSegments((segment, index) => index === 0 ? { prompt: segment.prompt.replace('{{line_1}}', '开口说话') } : {}), /尚未安排 line_1：李公公“下车吧/],
    [withSegments((segment, index) => index === 0 ? { prompt: segment.prompt.replace('{{line_1}}', '{{missing}}') } : {}), /未知台词 missing/],
    [withSegments((segment, index) => index === 1 ? { prompt: segment.prompt.replace('{{line_2}}', '{{line_1}}') } : {}), /line_1 重复安排/],
    [withSegments((segment, index) => ({ prompt: segment.prompt.replace(index === 0 ? '{{line_1}}' : '{{line_2}}', index === 0 ? '{{line_2}}' : '{{line_1}}') })), /台词顺序必须与 narrative 一致：line_1 → line_2/],
  ]
  for (const [candidate, expected] of cases) {
    assert.throws(() => prepareVideoPlan(candidate, characters, dialogues), expected)
  }
})

test('cannot write dialogue outside placeholders, leak character ids or omit the speaker from the segment cast', () => {
  assert.throws(() => prepareVideoPlan(withSegments((segment, index) => index === 1
    ? { prompt: segment.prompt.replace('低头答话', '低头说：“知道了。”') } : {}), characters, dialogues), /不能在占位符之外另写对白/)
  assert.throws(() => prepareVideoPlan(withSegments((segment, index) => index === 0
    ? { prompt: segment.prompt.replace('李公公站在', 'li_gonggong站在') } : {}), characters, dialogues), /内部人物 ID li_gonggong/)
  assert.throws(() => prepareVideoPlan(withSegments((segment, index) => index === 0
    ? { characters: ['heroine'] } : {}), characters, dialogues), /说话人物 李公公（li_gonggong）未列入 characters/)
  assert.throws(() => prepareVideoPlan(withSegments(() => ({ characters: ['ghost', 'heroine'] })), characters, dialogues), /未声明的人物 ghost/)
})

test('validates time blocks: present, starting at zero, contiguous and ending at seconds', () => {
  const cases: Array<[string, RegExp]> = [
    ['固定双人中景，没有时间块的正文，李公公开口说话，{{line_1}}。', /必须由“0–7秒：”形式的时间块组成/],
    ['1–5秒：固定双人中景，李公公开口说话，{{line_1}}。\n\n5–7秒：硬切至沈知微近景。', /第一个时间块必须从 0 秒开始/],
    ['0–4秒：固定双人中景，李公公开口说话，{{line_1}}。\n\n5–7秒：硬切至沈知微近景。', /5–7秒 与上一块 0–4秒 不衔接/],
    ['0–4秒：固定双人中景，李公公开口说话，{{line_1}}。\n\n4–6秒：硬切至沈知微近景。', /结束于 6 秒，与 seconds=7 不一致/],
  ]
  for (const [prompt, expected] of cases) {
    assert.throws(() => prepareVideoPlan(withSegments((_, index) => index === 0 ? { prompt } : {}), characters, dialogues), expected)
  }
  const { video } = prepareVideoPlan(withSegments((segment, index) => index === 0
    ? { prompt: segment.prompt.replace('0–5秒：', '0-5秒:').replace('5–7秒：', '5—7 秒：') } : {}), characters, dialogues)
  assert.equal(video.videoPrompts[0].endTime, 7)
})

test('requires seconds to cover the spoken text and keeps the scene within 15–30 seconds', () => {
  assert.equal(minimumSegmentSeconds(0), 0)
  assert.equal(minimumSegmentSeconds(14), 5)
  assert.equal(minimumSegmentSeconds(22), 8)
  const longLine = [{ ...dialogues[0], text: '下车吧，进了这道门，宫里头的规矩就得一条条都记牢。' }, dialogues[1]]
  assert.throws(() => prepareVideoPlan(plan, characters, longLine), /第 1 段台词共 22 字，至少需要 8 秒，当前 seconds=7/)
  assert.throws(() => prepareVideoPlan(withSegments((segment, index) => index === 1
    ? { seconds: 6, prompt: segment.prompt.replace('0–8秒', '0–6秒') } : {}), characters, dialogues), /合计 13 秒，必须在 15–30 秒之间/)
})

test('reports schema problems with structure guidance instead of echoing the payload', () => {
  assert.throws(() => prepareVideoPlanArguments({ style: plan.style, segments: [{ characters: [], seconds: 7, prompt: plan.segments[0].prompt, endFrame: '多余字段' }, plan.segments[1]] }), (error: unknown) => {
    assert.ok(error instanceof Error)
    assert.match(error.message, /write_video_prompt 参数不符合 schema/)
    assert.match(error.message, /additionalProperties: endFrame|endFrame/)
    assert.match(error.message, /顶层只包含 style 和 segments/)
    assert.doesNotMatch(error.message, /李公公站在画面左侧/)
    return true
  })
  assert.throws(() => prepareVideoPlanArguments({ visualContext: {}, videoPrompts: [] }), /write_video_prompt 参数不符合 schema/)
})

test('compiles style, timed shots and the fixed audio suffix', () => {
  const { video } = prepareVideoPlan(plan, characters, dialogues)
  const compiled = compileVideoPlan(video)
  assert.ok(compiled.videoPrompts[0].prompt.startsWith(`${plan.style}\n\n0–5秒：`))
  assert.ok(compiled.videoPrompts[1].prompt.endsWith('无音乐，无旁白。'))
  assert.equal(video.videoPrompts[0].prompt.startsWith('0–5秒：'), true)
})

test('the tool enforces its precondition, publishes once valid and never terminates the turn', async () => {
  let blocked: string | null = '必须先通过 publish_scene 发布场景。'
  let published: unknown
  const tool = createWriteVideoPromptTool({
    getCharacters: () => characters,
    getDialogues: () => dialogues,
    precondition: () => blocked,
    onPublish: (prepared) => { published = prepared.video },
  })
  assert.equal(tool.name, 'write_video_prompt')
  await assert.rejects(() => tool.execute('video-blocked', plan), /必须先通过 publish_scene/)
  assert.equal(published, undefined)
  blocked = null
  const result = await tool.execute('video-ok', plan)
  assert.equal(result.terminate, false)
  assert.ok(published)
  const text = result.content[0].type === 'text' ? result.content[0].text : ''
  assert.match(text, /最终发送的 prompt/)
  assert.match(text, /李公公说：“下车吧/)
  assert.match(text, /下一步：确认无误后调用 finish_turn/)
})

test('accepts a silent narrative without inventing dialogue', () => {
  const silent = withSegments((segment) => ({ prompt: segment.prompt.replace(/，\{\{line_\d\}\}/g, '') }))
  const { video, summary } = prepareVideoPlan(silent, characters, [])
  assert.equal(video.videoPrompts.length, 2)
  assert.match(summary, /本幕无台词/)
  assert.doesNotMatch(JSON.stringify(video), /“/)
})
