import assert from 'node:assert/strict'
import test from 'node:test'
import { SCENE_PUBLISH_ARGUMENTS_EXAMPLE } from '../server/publishSceneTool.ts'
import { compileVideoPrompt } from '../server/videoPromptCompiler.ts'
import {
  createWriteSceneVideoTool,
  describeSegmentReferences,
  prepareSceneVideo,
  WRITE_SCENE_VIDEO_ARGUMENTS_EXAMPLE,
} from '../server/writeSceneVideoTool.ts'

const scene = JSON.parse(SCENE_PUBLISH_ARGUMENTS_EXAMPLE)
const storyboard = JSON.parse(WRITE_SCENE_VIDEO_ARGUMENTS_EXAMPLE)
const ctx = { characters: scene.characters, dialogues: scene.dialogues }

test('a whole-scene storyboard compiles every segment with names, lines and running times', () => {
  const result = prepareSceneVideo(storyboard, ctx)
  assert.ok(result.kind === 'plan')
  assert.equal(result.draft.opening, 'new_shot')
  assert.deepEqual(result.segments.map((segment) => [segment.sequence, segment.startTime, segment.endTime]), [[1, 0, 5], [2, 5, 15]])
  assert.deepEqual(result.segments[0].lineIds, ['line_1'])
  assert.match(result.segments[0].prompt, /掌事姑姑说：“你识字吗？”/)
  assert.doesNotMatch(result.segments[0].prompt, /\{\{/)
})

test('a whole-scene write must name the opening, the style and the segments', () => {
  assert.throws(() => prepareSceneVideo({ ...storyboard, opening: undefined }, ctx), /必须提交 opening/)
  assert.throws(() => prepareSceneVideo({ opening: 'new_shot', segments: storyboard.segments }, ctx), /必须提交 style/)
  assert.throws(() => prepareSceneVideo({ ...storyboard, rewriteSequence: 1 }, ctx), /只有玩家要求重写某段时才能使用 rewriteSequence/)
})

test('the whole scene is checked at once: segment count, time blocks, line order and total length', () => {
  const [first, second] = storyboard.segments
  assert.throws(() => prepareSceneVideo({ ...storyboard, segments: [first] }, ctx), /整场至少 2 段/)
  assert.throws(() => prepareSceneVideo({ ...storyboard, segments: [{ ...first, seconds: 6 }, second] }, ctx), /第 1 段最后一个时间块结束于 5 秒，与 seconds=6 不一致/)
  assert.throws(
    () => prepareSceneVideo({ ...storyboard, segments: [{ ...first, prompt: first.prompt.replace('{{line_1}}', '') }, second] }, ctx),
    /尚未安排 line_1/,
  )
  assert.throws(
    () => prepareSceneVideo({ ...storyboard, segments: [first, { ...second, seconds: 5, prompt: second.prompt.replace('4–10秒', '4–5秒') }] }, ctx),
    /各段秒数合计 10 秒/,
  )
  assert.throws(
    () => prepareSceneVideo({ ...storyboard, segments: [first, { ...second, prompt: `${second.prompt}steward 退下。` }] }, ctx),
    /内部人物 ID steward/,
  )
})

test('skipping the video takes only a reason', () => {
  assert.deepEqual(prepareSceneVideo({ skipVideo: { reason: '本场次只有内心独白' } }, ctx), { kind: 'skip', reason: '本场次只有内心独白' })
  assert.throws(() => prepareSceneVideo({ ...storyboard, skipVideo: { reason: 'x' } }, ctx), /跳过视频时不要同时提交 segments/)
})

test('rewriting one segment keeps the others and re-validates the whole scene', () => {
  const draft = { opening: 'new_shot' as const, style: storyboard.style, segments: storyboard.segments }
  const replacement = { ...storyboard.segments[1], prompt: storyboard.segments[1].prompt.replace('双手把包袱抱得更紧', '轻轻吸了口气') }
  const result = prepareSceneVideo({ rewriteSequence: 2, segments: [replacement] }, { ...ctx, rewrite: { sequence: 2, draft } })
  assert.ok(result.kind === 'rewrite')
  assert.equal(result.sequence, 2)
  assert.equal(result.draft.segments[0], storyboard.segments[0])
  assert.match(result.segments[1].prompt, /轻轻吸了口气/)

  const rewrite = { sequence: 2, draft }
  assert.throws(() => prepareSceneVideo({ rewriteSequence: 1, segments: [replacement] }, { ...ctx, rewrite }), /要求重写第 2 段/)
  assert.throws(() => prepareSceneVideo({ rewriteSequence: 2, segments: storyboard.segments }, { ...ctx, rewrite }), /只含被重写的那一段/)
  // 第 2 段抢走第 1 段的台词，整场校验会发现重复。
  const stealing = { ...replacement, prompt: replacement.prompt.replace('安静。', '{{line_1}}') }
  assert.throws(() => prepareSceneVideo({ rewriteSequence: 2, segments: [stealing] }, { ...ctx, rewrite }), /台词 line_1 重复安排/)
})

test('segment references: the first segment follows the opening, later segments start from the previous one', () => {
  const segments = [{ sequence: 1, characterIds: ['heroine', 'steward', 'extra'] }, { sequence: 2, characterIds: ['heroine'] }]
  const lookup = (id: string) => id === 'extra' ? undefined : { actorId: `actor-${id}` }
  assert.deepEqual(describeSegmentReferences('new_shot', segments, lookup), [
    [{ type: 'character', characterId: 'heroine', actorId: 'actor-heroine' }, { type: 'character', characterId: 'steward', actorId: 'actor-steward' }],
    [{ type: 'start_frame', sequence: 1 }],
  ])
  assert.deepEqual(describeSegmentReferences('continue', segments, lookup)[0], [{ type: 'previous_scene_tail_frame' }])
})

test('the compiled prompt puts style, cast appearances and the shots together', () => {
  const prompt = compileVideoPrompt(
    { sequence: 1, startTime: 0, endTime: 5, characterIds: ['heroine', 'steward', 'extra'], prompt: '0–5秒：两人对视。' },
    '写实古装画面。',
    (id) => id === 'heroine' ? { name: '女主', appearance: '十七岁，素色襦裙。' } : id === 'steward' ? { name: '掌事姑姑', appearance: '四十余岁，深青宫装' } : undefined,
  )
  assert.equal(prompt, '写实古装画面。\n\n人物外观：女主——十七岁，素色襦裙；掌事姑姑——四十余岁，深青宫装。\n\n0–5秒：两人对视。无音乐，无旁白。')
})

test('the tool refuses to run until its precondition is met and reports the plan in one line per segment', async () => {
  let blocked: string | null = '以下人物尚未选角：女主（heroine）；请先调用 cast_scene。'
  const written: unknown[] = []
  const tool = createWriteSceneVideoTool({
    getCharacters: () => scene.characters,
    getDialogues: () => scene.dialogues,
    precondition: () => blocked,
    onWrite: (result) => { written.push(result) },
  })
  await assert.rejects(() => tool.execute('call-1', storyboard), /请先调用 cast_scene/)
  blocked = null
  const result = await tool.execute('call-2', storyboard)
  const text = result.content.map((item) => item.type === 'text' ? item.text : '').join('')
  assert.match(text, /分镜已交付，开场方式 new_shot，共 2 段 15 秒/)
  assert.match(text, /第 1 段 0–5 秒（line_1）/)
  assert.doesNotMatch(text, /下一步/)
  assert.equal(written.length, 1)
})
