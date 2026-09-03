import assert from 'node:assert/strict'
import test from 'node:test'
import {
  assertValidVideoDraft,
  collectVideoPlanIssues,
  createWriteVideoPromptTool,
  normalizeVideoPlan,
  prepareVideoPlanArguments,
} from '../server/videoPlanTool.ts'
import { compileVideoPlan } from '../server/videoPromptCompiler.ts'
import type { SceneCharacter, VideoPlan } from '../src/types/story.ts'

const characters: SceneCharacter[] = [
  { id: 'heroine', name: '沈清禾', gender: 'female', minAge: 16, maxAge: 20 },
  { id: 'steward', name: '掌事姑姑', gender: 'female', minAge: 40, maxAge: 50 },
]

const plan: VideoPlan = {
  visualContext: {
    style: '写实电影质感，暖色柔光，稳定自然的宫廷叙事风格。',
    scene: '清晨宫门内的朱红宫墙甬道，地面铺着整齐青石砖。',
    layout: '画面左侧为宫墙，中央是甬道，右后方是已经关闭的宫门。',
  },
  videoPrompts: [
    {
      characterIds: ['heroine'],
      beats: [
        { visual: '固定中景，少女站在队伍末尾，回头望向缓缓关闭的宫门。' },
        {
          visual: '镜头缓慢推近，少女合拢手中名册，重新望向甬道前方。',
          dialogue: [{ characterId: 'heroine', text: '我叫沈清禾。' }],
        },
      ],
      endFrame: '中近景，沈清禾把名册抱在胸前，面向甬道站定不动。',
      audio: '晨钟、脚步声和衣料摩擦声。',
    },
    {
      characterIds: ['heroine', 'steward'],
      beats: [{
        visual: '硬切到甬道侧面中景，掌事姑姑走到少女面前停下，少女挺直脊背。',
        dialogue: [{ characterId: 'steward', text: '跟紧队伍。' }],
      }],
      endFrame: '中景，掌事姑姑与沈清禾相对站定，二人保持静止。',
      audio: '逐渐靠近后停止的脚步声。',
    },
  ],
}

test('derives a continuous 15 second timeline and terminates the tool', async () => {
  let published: { video: ReturnType<typeof normalizeVideoPlan> } | undefined
  const tool = createWriteVideoPromptTool(characters, (value) => { published = value })
  const result = await tool.execute('tool-1', plan)

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
  assert.match(result.details?.video.videoPrompts[0].prompt ?? '', /heroine说“我叫沈清禾。”/)
  assert.deepEqual(published, result.details)
})

test('accepts and unwraps the legacy video envelope around the simplified draft', () => {
  assert.deepEqual(prepareVideoPlanArguments({ video: plan }), plan)
})

test('reports multiple schema errors without echoing the submitted payload', () => {
  assert.throws(
    () => prepareVideoPlanArguments({
      visualContext: plan.visualContext,
      videoPrompts: plan.videoPrompts.map((segment) => ({
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

test('collects all character-reference problems in one validation result', () => {
  const invalid: VideoPlan = {
    ...plan,
    videoPrompts: [
      {
        ...plan.videoPrompts[0],
        characterIds: ['unknown'],
        beats: [{
          visual: '固定中景，陌生人物站在甬道中央开口说话。',
          dialogue: [{ characterId: 'heroine', text: '你是谁？' }],
        }],
      },
      {
        ...plan.videoPrompts[1],
        beats: [{
          visual: '掌事姑姑回头望向画面外另一个没有登记的人物。',
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

test('rejects only genuinely overlong segment content', () => {
  const overlong: VideoPlan = {
    ...plan,
    videoPrompts: plan.videoPrompts.map((segment, index) => index === 0
      ? {
          ...segment,
          beats: [{
            visual: '固定近景，少女一口气说出一段明显无法放进十秒镜头的长台词。',
            dialogue: [{ characterId: 'heroine', text: '这是一段故意写得非常非常长而且完全不应该被强行塞进十秒镜头里面的测试台词内容' }],
          }],
        }
      : segment),
  }

  assert.throws(() => assertValidVideoDraft(overlong, characters), /超过单段 10 秒上限/)
})

test('compiles predicted end-frame text into the next segment opening', () => {
  const normalized = normalizeVideoPlan(plan)
  const compiled = compileVideoPlan(normalized, characters, undefined, new Set(['heroine']))

  assert.match(compiled.videoPrompts[0].prompt, /严格保持人物参考图一致/)
  assert.match(compiled.videoPrompts[0].prompt, /【结尾状态】中近景，沈清禾把名册抱在胸前/)
  assert.match(compiled.videoPrompts[1].prompt, /【开场状态】中近景，沈清禾把名册抱在胸前/)
  assert.match(compiled.videoPrompts[1].prompt, /无音乐，无旁白/)
})

test('requires publish_scene characters before compiling a prompt', async () => {
  const tool = createWriteVideoPromptTool([])
  await assert.rejects(() => tool.execute('tool-no-scene', plan), /必须先通过 publish_scene/)
})
