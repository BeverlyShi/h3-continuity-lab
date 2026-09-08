import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import type { ScenePublish, VideoBeat, VideoPromptDraft } from '../src/types/story.ts'
import { assertNarrativeReview, narrativeSources } from '../server/narrativeReview.ts'
import { createPublishSceneTool } from '../server/publishSceneTool.ts'
import { autoSplitVideoDraft, createWriteVideoPromptTool, prepareVideoPlan, resolveVideoDialogues } from '../server/videoPlanTool.ts'
import { buildVideoInputMessage } from '../server/directorPrompt.ts'
import { withDirectorSession } from '../server/directorSession.ts'

const fixture = (id: string): { source: ScenePublish; draft: VideoPromptDraft } =>
  JSON.parse(readFileSync(new URL(`./fixtures/${id}.json`, import.meta.url), 'utf8'))
const palace = fixture('d69be8be-d5a0-4e72-bf5c-103e58c24b03')
const chamber = fixture('dc2ecdec-3aca-4906-b2d7-a2522dd502b0')

const shot = (visual: string, endFrame: string, actionSeconds: number, dialogueIds: string[] = [], audio = '安静。'): VideoBeat =>
  ({ visual, endFrame, actionSeconds, dialogueIds, audio })
const segment = (characterIds: string[], beats: VideoBeat[]) =>
  ({ characterIds, beats, endFrame: beats.at(-1)!.endFrame! })

// 根据 trace 原文手工整理的回归预期，不调用模型，也不复用其有问题的动作描述。
const correctedPalace: VideoPromptDraft = {
  visualContext: { style: '写实古装宫廷剧，夜色渐沉，门内灯火照亮人物。', scene: '寿安宫侧门、宫廊及尽头朱门前，镜头随本幕已发生的行程转场。' },
  videoPrompts: [
    segment(['heroine', 'cuifu', 'suwt'], [
      shot('固定三人中景，平视，从三人侧面拍摄。沈知意在左，苏晚棠在右，崔姑姑在中央稍后。沈知意望着苏晚棠，咬了咬嘴唇，{{line_1}}。', '三人中景，沈知意仍在左侧望着右侧的苏晚棠，崔姑姑在中央稍后。', 0.5, ['line_1']),
      shot('硬切至崔姑姑近景，平视，从沈知意一侧拍摄。崔姑姑眸光一动，转向画外右侧的苏晚棠，{{line_2}}。', '近景，崔姑姑朝向画外右侧的苏晚棠。', 0.3, ['line_2']),
    ]),
    segment(['heroine', 'cuifu', 'suwt'], [
      shot('硬切至苏晚棠近景，平视，从崔姑姑一侧拍摄。苏晚棠脸色微沉，却仍挂着笑，{{line_3}}。', '近景，苏晚棠仍挂着笑，面朝画外的崔姑姑。', 0.3, ['line_3']),
      shot('硬切至崔姑姑近景，平视，镜头固定。崔姑姑不置可否地嗯了一声，{{line_4}}。', '近景，崔姑姑仍处于原位，朝向两名秀女所在的画外。', 0.7, ['line_4'], '崔姑姑先嗯一声，随后说话。'),
      shot('硬切至两名秀女侧面中景，平视，镜头固定。苏晚棠落后沈知意半步，低声对沈知意说话，{{line_5}}。', '双人中景，苏晚棠仍落后沈知意半步。', 0.3, ['line_5']),
    ]),
    segment(['heroine', 'cuifu', 'suwt', 'elder'], [
      shot('硬切至宫廊后方全景，平视，镜头固定。夜色渐沉，两名秀女随崔姑姑穿过宫廊，走向尽头的朱门。', '全景，崔姑姑及两名秀女已到宫廊尽头的朱门前。', 3),
      shot('硬切至朱门正面中景，平视，镜头固定。朱门缓缓推开，门内灯火通明，一位衣绣暗纹的年长内侍负手而立。', '中景，朱门已打开，灯火通明的门内，年长内侍负手而立。', 3),
    ]),
  ],
}

const correctedChamber: VideoPromptDraft = {
  visualContext: { style: '写实古装宫廷剧，储秀宫檐下灯火初明，室内有暖炉。', scene: '储秀宫门槛内侧、灯下与窗边暖炉旁，人物位于同一屋内。' },
  videoPrompts: [
    segment(['heroine', 'steward', 'rival', 'silent_candidate'], [
      shot('固定全景，平视，从屋内侧面拍摄。沈知意抱着包袱跨过右侧门槛，屋中已有两名秀女守着左侧暖炉，掌事姑姑崔氏立在中央灯下。', '全景，沈知意抱包袱位于门内，两名秀女在暖炉旁，崔氏在灯下。', 2),
      shot('保持固定全景。掌事姑姑崔氏扫视众人，{{line_1}}。这句话尚未说完时，靠窗的绿衣秀女低低一哼。', '全景，崔氏仍在灯下，沈知意抱包袱位于门内，两名秀女仍在暖炉旁。', 0, ['line_1'], '崔氏话音未落时，绿衣秀女低哼一声。'),
    ]),
    segment(['heroine', 'steward'], [
      shot('硬切至双人中景，平视，从门内侧面拍摄。崔氏脚步一顿，从灯下走到抱着包袱的沈知意跟前。', '双人中景，崔氏在左，抱着包袱的沈知意在右，两人相对。', 2),
      shot('保持固定双人中景。崔氏在左，面向右侧抱着包袱的沈知意，{{line_2}}。', '双人中景，崔氏与抱包袱的沈知意相对。', 0, ['line_2']),
      shot('硬切至沈知意中近景，平视，镜头固定。沈知意抱着包袱欠身，{{line_3}}。', '中近景，沈知意仍抱着包袱，面朝画外的崔氏。', 0.5, ['line_3']),
    ]),
    segment(['steward', 'rival'], [
      shot('硬切至崔氏近景，平视，从沈知意一侧拍摄，镜头固定。崔氏眯起眼睛，{{line_4}}。', '近景，崔氏眯着眼睛，面向画外的沈知意。', 0, ['line_4']),
      shot('硬切至绿衣秀女近景，平视，从窗前拍摄，镜头固定。绿衣秀女掩唇低笑，屋中随即安静。', '近景，绿衣秀女仍在窗边，手掩在唇前。', 2, [], '绿衣秀女低笑，随后安静。'),
    ]),
  ],
}

test('both original traces are rejected instead of silently appending dialogue after completed actions', () => {
  for (const { source, draft } of [palace, chamber]) {
    assert.throws(() => prepareVideoPlan(draft, source.characters, source.dialogues), /实际说话位置/)
  }
})

test('corrected trace drafts keep exact named dialogue, the revealed attendant, overlapping hum and held bundle', () => {
  const first = prepareVideoPlan(correctedPalace, [...palace.source.characters, { id: 'elder', name: '年长内侍', gender: 'male', minAge: 50, maxAge: 65 }], palace.source.dialogues).video
  const second = prepareVideoPlan(correctedChamber, [...chamber.source.characters, { id: 'silent_candidate', name: '另一名秀女', gender: 'female', minAge: 16, maxAge: 20 }], chamber.source.dialogues).video
  for (const [video, source] of [[first, palace.source], [second, chamber.source]] as const) {
    const text = video.videoPrompts.map((part) => part.prompt).join('\n')
    assert.deepEqual([...text.matchAll(/“([^”]*)”/g)].map((match) => match[1]), source.dialogues.map((line) => line.text))
    assert.doesNotMatch(text, /\{\{|heroine|steward|cuifu|suwt|帕角|问话后|双手交握/)
    assert.ok(video.totalDuration <= 30)
  }
  assert.match(first.videoPrompts.at(-1)!.prompt, /朱门缓缓推开.*年长内侍负手而立/)
  assert.match(first.videoPrompts[1].prompt, /嗯了一声/)
  assert.match(second.videoPrompts[0].prompt, /崔氏说：“从今儿起.*尚未说完时.*低低一哼/)
  const answer = second.videoPrompts[1].prompt
  assert.ok(answer.indexOf('抱着包袱欠身') < answer.indexOf('沈知意说：“父亲沈缙'))
})

test('dialogue slots reject duplicates, unknown ids, misplaced slots and leaked role ids without modifying original speech', () => {
  for (const visual of ['{{line_1}}{{line_1}}', '{{unknown}}', '{{line_1}', 'steward发问，{{line_1}}']) {
    const draft = structuredClone(correctedChamber)
    draft.videoPrompts[0].beats[1].visual = '固定全景，掌事姑姑立在灯下。' + visual
    assert.throws(() => prepareVideoPlan(draft, [...chamber.source.characters, { id: 'silent_candidate', name: '另一名秀女', gender: 'female', minAge: 16, maxAge: 20 }], chamber.source.dialogues), /占位符|实际说话位置|泄漏/)
  }
})

test('silent motion budgets affect duration and auto splitting requires the boundary shot final state', () => {
  const resolved = resolveVideoDialogues(correctedPalace, palace.source.dialogues)
  resolved.videoPrompts = resolved.videoPrompts.slice(0, 2)
  resolved.videoPrompts[0].beats[0].actionSeconds = 4
  const split = autoSplitVideoDraft(resolved)
  assert.equal(split.draft.videoPrompts.length, 3)
  assert.equal(split.draft.videoPrompts[0].endFrame, resolved.videoPrompts[0].beats[0].endFrame)
  assert.notEqual(split.draft.videoPrompts[0].endFrame, resolved.videoPrompts[0].beats[0].visual)
  delete resolved.videoPrompts[0].beats[0].endFrame
  assert.equal(autoSplitVideoDraft(resolved).draft.videoPrompts.length, 2)
  const overlong = structuredClone(correctedPalace)
  overlong.videoPrompts[2].beats[0].actionSeconds = 10
  assert.throws(() => prepareVideoPlan(overlong, [...palace.source.characters, { id: 'elder', name: '年长内侍', gender: 'male', minAge: 50, maxAge: 65 }], palace.source.dialogues), /时长冲突/)
})

test('source checks reject missing endings, invented evidence and reported narrative contradictions before publishing', async () => {
  const characters = [...palace.source.characters, { id: 'elder', name: '年长内侍', gender: 'male' as const, minAge: 50, maxAge: 65 }]
  let published = false
  const tool = createWriteVideoPromptTool(characters, palace.source.dialogues, () => { published = true }, async (video) => {
    assert.ok(video.videoPrompts[0].prompt.startsWith(correctedPalace.visualContext.style))
    const coverage = narrativeSources(palace.source.scene.narrative).map((item) => ({ sourceId: item.id, status: 'shown' as const, evidence: video.videoPrompts[0].prompt.slice(0, 60) }))
    assert.throws(() => assertNarrativeReview({ coverage: coverage.slice(0, -1), issues: [] }, palace.source, video), /全部 sources/)
    assert.throws(() => assertNarrativeReview({ coverage: coverage.map((item) => ({ ...item, evidence: '不在最终提示词里的证据' })), issues: [] }, palace.source, video), /覆盖证据/)
    assert.throws(() => assertNarrativeReview({ coverage: coverage.map((item, index) => index === coverage.length - 1 ? { ...item, status: 'missing', evidence: '朱门打开、内侍出现未呈现' } : item), issues: [] }, palace.source, video), /内侍出现/)
    assertNarrativeReview({ coverage, issues: ['手帕和攥帕动作没有原文依据'] }, palace.source, video)
  })
  await assert.rejects(() => tool.execute('review-gate', correctedPalace), /手帕/)
  assert.equal(published, false)
  const publish = createPublishSceneTool(() => { published = true }, async (source) => {
    assertNarrativeReview({ coverage: [], issues: ['结尾出场的年长内侍未列入 characters'] }, source)
  })
  await assert.rejects(() => publish.execute('cast-review', palace.source), /年长内侍/)
  assert.equal(published, false)
})

test('video input explicitly binds the current narrative and unchosen choices even without images', () => {
  const input = JSON.parse(buildVideoInputMessage(palace.source.characters, undefined, [], palace.source.dialogues, undefined, false, palace.source.scene).split('\n')[1])
  assert.equal(input.narrative, palace.source.scene.narrative)
  assert.deepEqual(input.unchosenChoices, palace.source.scene.choices)
  assert.ok(narrativeSources(input.narrative).at(-1)!.text.includes('年长内侍'))
})

test('session exclusion survives module reload, allows other games, and releases failed requests', async () => {
  let release!: () => void
  const first = withDirectorSession('same-game', () => new Promise<void>((resolve) => { release = resolve }))
  try {
    const reloaded = await import('../server/directorSession.ts?reload')
    await assert.rejects(() => reloaded.withDirectorSession('same-game', async () => {}), /上一项行动/)
    assert.equal(await withDirectorSession('other-game', async () => 42), 42)
  } finally {
    release()
    await first
  }
  await assert.rejects(() => withDirectorSession('same-game', async () => { throw new Error('failed') }), /failed/)
  assert.equal(await withDirectorSession('same-game', async () => 'released'), 'released')
})
