import assert from 'node:assert/strict'
import test from 'node:test'
import {
  assertValidVideoDraft,
  autoSplitVideoDraft,
  collectVideoPlanIssues,
  createWriteVideoPromptTool,
  normalizeVideoPlan,
  prepareVideoPlanArguments,
  resolveVideoDialogues,
} from '../server/videoPlanTool.ts'
import { compileVideoPlan } from '../server/videoPromptCompiler.ts'
import type { SceneCharacter, SceneDialogue, VideoPromptDraft, ResolvedVideoPromptDraft as VideoPlan } from '../src/types/story.ts'

const characters: SceneCharacter[] = [
  { id: 'heroine', name: '沈清禾', gender: 'female', minAge: 16, maxAge: 20 },
  { id: 'steward', name: '掌事姑姑', gender: 'female', minAge: 40, maxAge: 50 },
]

const plan: VideoPlan = {
  visualContext: {
    style: '写实电影质感，暖色柔光，稳定自然的宫廷叙事风格。',
    scene: '清晨宫门内的朱红宫墙甬道，地面铺着整齐青石砖。',
  },
  videoPrompts: [
    {
      characterIds: ['heroine'],
      beats: [
        { visual: '固定中景，少女站在队伍末尾，回头望向缓缓关闭的宫门。', audio: '轻微风声。' },
        {
          visual: '镜头缓慢推近，少女合拢手中名册，重新望向甬道前方。', audio: '轻微风声。',
          dialogue: [{ characterId: 'heroine', text: '我叫沈清禾。' }],
        },
      ],
      endFrame: '中近景，沈清禾把名册抱在胸前，面向甬道站定不动。',
    },
    {
      characterIds: ['heroine', 'steward'],
      beats: [{
        visual: '硬切到甬道侧面中景，掌事姑姑走到少女面前停下，少女挺直脊背。', audio: '轻微风声。',
        dialogue: [{ characterId: 'steward', text: '跟紧队伍。' }],
      }],
      endFrame: '中景，掌事姑姑与沈清禾相对站定，二人保持静止。',
    },
  ],
}

const submission = (plan: VideoPlan) => {
  const dialogues: SceneDialogue[] = []
  const draft: VideoPromptDraft = {
    ...plan,
    videoPrompts: plan.videoPrompts.map((segment) => ({
      ...segment,
      beats: segment.beats.map((beat) => {
        const dialogueIds = (beat.dialogue ?? []).map((line) => {
          const id = `line_${dialogues.length + 1}`
          dialogues.push({ id, characterId: line.characterId, text: line.text })
          return id
        })
        return {
          audio: beat.audio, actionSeconds: beat.actionSeconds, endFrame: beat.endFrame,
          visual: beat.visual + dialogueIds.map((id) => `{{${id}}}。`).join(''),
          dialogueIds,
        }
      }),
    })),
  }
  return { draft, dialogues }
}

test('derives a continuous 15 second timeline and terminates the tool', async () => {
  let published: { video: ReturnType<typeof normalizeVideoPlan> } | undefined
  const tool = createWriteVideoPromptTool(characters, submission(plan).dialogues, (value) => { published = value })
  const result = await tool.execute('tool-1', submission(plan).draft)

  assert.equal(tool.name, 'write_video_prompt')
  assert.equal(result.terminate, true)
  assert.equal(result.details?.video.totalDuration, 15)
  assert.deepEqual(
    result.details?.video.videoPrompts.map(({ sequence, startTime, endTime }) => ({ sequence, startTime, endTime })),
    [
      { sequence: 1, startTime: 0, endTime: 8 },
      { sequence: 2, startTime: 8, endTime: 15 },
    ],
  )
  assert.match(result.details?.video.videoPrompts[0].prompt ?? '', /^0–2秒：/)
  assert.match(result.details?.video.videoPrompts[0].prompt ?? '', /沈清禾说：“我叫沈清禾。”/)
  assert.deepEqual(published, result.details)
})

test('accepts and unwraps the legacy video envelope around the simplified draft', () => {
  assert.deepEqual(prepareVideoPlanArguments({ video: submission(plan).draft }), submission(plan).draft)
})

test('reports multiple schema errors without echoing the submitted payload', () => {
  assert.throws(
    () => prepareVideoPlanArguments({
      visualContext: plan.visualContext,
      videoPrompts: submission(plan).draft.videoPrompts.map((segment) => ({
        ...segment,
        expectedEndState_invalid: '',
      })),
    }),
    (error: unknown) => error instanceof Error
      && /write_video_prompt 参数不符合 schema/.test(error.message)
      && error.message.match(/additional properties/g)?.length === 2
      && !error.message.includes(plan.visualContext.style),
  )
})

test('identifies misplaced segment and beat fields so one repair can fix the whole structure', () => {
  const { draft } = submission(plan)
  const misplaced = {
    ...draft,
    videoPrompts: draft.videoPrompts.map(({ endFrame, ...segment }) => ({
      ...segment,
      audio: '轻微风声。',
      beats: segment.beats.map((beat) => ({
        visual: beat.visual, dialogueIds: beat.dialogueIds, characterIds: segment.characterIds, endFrame,
      })),
    })),
  }
  assert.throws(() => prepareVideoPlanArguments(misplaced), (error: unknown) => {
    assert.ok(error instanceof Error)
    assert.match(error.message, /\/videoPrompts\/0 must not have additional properties: audio/)
    assert.match(error.message, /\/videoPrompts\/0\/beats\/0 must not have additional properties: characterIds/)
    assert.match(error.message, /\/videoPrompts\/0\/beats\/0 must have required properties audio/)
    assert.match(error.message, /重新提交完整 JSON/)
    return true
  })
})

test('collects all character-reference problems in one validation result', () => {
  const invalid: VideoPlan = {
    ...plan,
    videoPrompts: [
      {
        ...plan.videoPrompts[0],
        characterIds: ['unknown'],
        beats: [{
          visual: '固定中景，陌生人物站在甬道中央开口说话。', audio: '轻微风声。',
          dialogue: [{ characterId: 'heroine', text: '你是谁？' }],
        }],
      },
      {
        ...plan.videoPrompts[1],
        beats: [{
          visual: '掌事姑姑回头望向画面外另一个没有登记的人物。', audio: '轻微风声。',
          dialogue: [{ characterId: 'another_unknown', text: '站住。' }],
        }],
      },
    ],
  }

  const issues = collectVideoPlanIssues(invalid, characters)
  assert.equal(issues.length, 3)
  assert.match(issues.join('\n'), /未声明的人物 unknown/)
  assert.match(issues.join('\n'), /说话人物 heroine 未列入 characterIds/)
  assert.match(issues.join('\n'), /未声明人物 another_unknown/)
  assert.throws(() => assertValidVideoDraft(invalid, characters), /\n- .*\n- .*\n-/s)
})

test('reports overlong original dialogue as a timing conflict without suggesting word deletion', () => {
  const overlong: VideoPlan = {
    ...plan,
    videoPrompts: plan.videoPrompts.map((segment, index) => index === 0
      ? {
          ...segment,
          beats: [{
            visual: '固定近景，少女一口气说出一段明显无法放进十秒镜头的长台词。', audio: '轻微风声。',
            dialogue: [{ characterId: 'heroine', text: '这是一段故意写得非常非常长而且完全不应该被强行塞进十秒镜头里面的测试台词内容' }],
          }],
        }
      : segment),
  }

  assert.throws(
    () => assertValidVideoDraft(overlong, characters),
    /第 1 段估算 12 秒（第 1 拍 38 字≈11\.4 秒），超过 10 秒上限；已发布台词不可删改/,
  )
})

test('splits a two-beat 16+21 Han character segment (the real failing trace) into two segments under the 10s cap', async () => {
  const overlongTwoBeat: VideoPlan = {
    ...plan,
    videoPrompts: [
      plan.videoPrompts[0],
      {
        ...plan.videoPrompts[1],
        beats: [
          { visual: '固定中景，掌事姑姑压低声音说话。', endFrame: '中景，掌事姑姑闭口站在少女面前。', audio: '轻微风声。', dialogue: [{ characterId: 'steward', text: '沈'.repeat(16) }] },
          { visual: '镜头转向少女的反应。', audio: '轻微风声。', dialogue: [{ characterId: 'heroine', text: '清'.repeat(21) }] },
        ],
      },
    ],
  }

  const { draft, notes } = autoSplitVideoDraft(overlongTwoBeat)
  assert.equal(draft.videoPrompts.length, 3)
  assert.match(notes.join('\n'), /第 2 段估算 13 秒，已自动拆为第 2、3 段/)

  const { draft: input, dialogues } = submission(overlongTwoBeat)
  const tool = createWriteVideoPromptTool(characters, dialogues)
  const result = await tool.execute('tool-autosplit', input)
  assert.match(result.content[0].type === 'text' ? result.content[0].text : '', /已自动拆为/)
})

test('reports a timing conflict when splitting would exceed the 3-segment schema limit', async () => {
  const threeSegmentDraft: VideoPlan = {
    ...plan,
    videoPrompts: [
      plan.videoPrompts[0],
      {
        ...plan.videoPrompts[1],
        beats: [
          { visual: '固定中景，掌事姑姑压低声音说话。', endFrame: '中景，掌事姑姑闭口站在少女面前。', audio: '轻微风声。', dialogue: [{ characterId: 'steward', text: '沈'.repeat(16) }] },
          { visual: '镜头转向少女的反应。', audio: '轻微风声。', dialogue: [{ characterId: 'heroine', text: '清'.repeat(21) }] },
        ],
      },
      plan.videoPrompts[1],
    ],
  }

  const issues = collectVideoPlanIssues(threeSegmentDraft, characters)
  const issueText = issues.join('\n')
  assert.match(issueText, /第 2 段估算 13 秒（第 1 拍 16 字≈5\.1 秒，第 2 拍 21 字≈6\.5 秒），超过 10 秒上限；已发布台词不可删改/)

  const { draft: input, dialogues } = submission(threeSegmentDraft)
  const tool = createWriteVideoPromptTool(characters, dialogues)
  await assert.rejects(
    () => tool.execute('tool-no-split', input),
    /时长冲突/,
  )
})

test('does not suggest splitting a single overlong beat into a new segment', () => {
  const singleBeatOverlong: VideoPlan = {
    ...plan,
    videoPrompts: plan.videoPrompts.map((segment, index) => index === 0
      ? {
          ...segment,
          beats: [{
            visual: '固定近景，少女独白。', audio: '轻微风声。',
            dialogue: [{ characterId: 'heroine', text: '沈'.repeat(40) }],
          }],
        }
      : segment),
  }

  const issues = collectVideoPlanIssues(singleBeatOverlong, characters)
  assert.match(issues.join('\n'), /台词不可删改/)
  assert.doesNotMatch(issues.join('\n'), /拆到新一段/)
})

test('compiles only style, scene and timed shots while keeping predicted tails internal', () => {
  const normalized = normalizeVideoPlan(resolveVideoDialogues(submission(plan).draft, submission(plan).dialogues), characters)
  const compiled = compileVideoPlan(normalized)

  assert.ok(compiled.videoPrompts[0].prompt.startsWith(plan.visualContext.style))
  assert.match(compiled.videoPrompts[0].prompt, /0–2秒：/)
  assert.match(compiled.videoPrompts[1].prompt, /0–7秒：/)
  assert.doesNotMatch(compiled.videoPrompts[0].prompt, /【|角色ID|三视图/)
  assert.ok(!compiled.videoPrompts[0].prompt.includes(plan.videoPrompts[0].endFrame))
  assert.ok(!compiled.videoPrompts[1].prompt.includes(plan.videoPrompts[0].endFrame))
  assert.equal(compiled.videoPrompts[0].endFrame, plan.videoPrompts[0].endFrame)
  assert.match(compiled.videoPrompts[1].prompt, /无音乐，无旁白/)
})

test('keeps each sound with its own timed shot and does not repeat it after splitting', () => {
  const draft = structuredClone(plan)
  draft.videoPrompts[0].beats[0].audio = '合门时木门闷响。'
  draft.videoPrompts[0].beats[1].audio = '名册合拢时纸页摩擦。'
  const prompt = compileVideoPlan(normalizeVideoPlan(resolveVideoDialogues(submission(draft).draft, submission(draft).dialogues), characters)).videoPrompts[0].prompt
  const shots = prompt.split(/\n\n(?=\d+–\d+秒：)/).slice(1)
  assert.equal(shots.length, 2)
  assert.match(shots[0], /木门闷响/)
  assert.doesNotMatch(shots[0], /纸页摩擦/)
  assert.match(shots[1], /纸页摩擦/)
  assert.doesNotMatch(shots[1], /木门闷响/)

  draft.videoPrompts[0].beats[0].endFrame = '中景，少女仍然站在已经合拢的宫门前。'
  draft.videoPrompts[0].beats[0].dialogue = [{ characterId: 'heroine', text: '沈'.repeat(16) }]
  draft.videoPrompts[0].beats[1].dialogue = [{ characterId: 'heroine', text: '清'.repeat(21) }]
  const split = compileVideoPlan(normalizeVideoPlan(autoSplitVideoDraft(resolveVideoDialogues(submission(draft).draft, submission(draft).dialogues)).draft, characters))
  assert.equal(split.videoPrompts.length, 3)
  assert.doesNotMatch(split.videoPrompts[0].prompt, /纸页摩擦/)
  assert.doesNotMatch(split.videoPrompts[1].prompt, /木门闷响/)
})

test('requires publish_scene characters before compiling a prompt', async () => {
  const tool = createWriteVideoPromptTool([], [])
  await assert.rejects(() => tool.execute('tool-no-scene', submission(plan).draft), /必须先通过 publish_scene/)
})
