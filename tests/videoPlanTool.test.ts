import assert from 'node:assert/strict'
import test from 'node:test'
import { createVideoPlanTool } from '../server/videoPlanTool.ts'
import type { SceneCharacter, VideoPlan } from '../src/types/story.ts'

const characters: SceneCharacter[] = [
  { id: 'heroine', name: '沈清禾', gender: 'female', minAge: 16, maxAge: 20 },
]

const plan: VideoPlan = {
  video: {
    totalDuration: 15,
    videoPrompts: [
      {
        sequence: 1,
        startTime: 0,
        endTime: 5,
        characterIds: ['heroine'],
        prompt: '宫门在晨雾中缓缓关闭，少女站在队伍末尾，固定中景镜头。',
      },
      {
        sequence: 2,
        startTime: 5,
        endTime: 15,
        transitionFromPrevious: 'continuous',
        characterIds: ['heroine'],
        prompt: '镜头跟随秀女队伍沿甬道前行，少女回头望向关闭的宫门。',
      },
    ],
  },
}

test('publishes the video plan in tool details and terminates the agent turn', async () => {
  let published: VideoPlan | undefined
  const tool = createVideoPlanTool(characters, (value) => { published = value })
  const result = await tool.execute('tool-1', plan)

  assert.equal(tool.name, 'submit_video_plan')
  assert.equal(result.terminate, true)
  assert.deepEqual(result.details, plan)
  assert.deepEqual(published, plan)
  assert.match(result.content[0].type === 'text' ? result.content[0].text : '', /视频计划已提交/)
})

test('rejects missing transitions and unknown character references', async () => {
  const tool = createVideoPlanTool(characters)
  await assert.rejects(() => tool.execute('tool-transition', {
    video: {
      ...plan.video,
      videoPrompts: plan.video.videoPrompts.map((segment) => segment.sequence === 2
        ? { ...segment, transitionFromPrevious: undefined }
        : segment),
    },
  }), /视频片段必须/)

  await assert.rejects(() => tool.execute('tool-character', {
    video: {
      ...plan.video,
      videoPrompts: plan.video.videoPrompts.map((segment) => segment.sequence === 2
        ? { ...segment, characterIds: ['unknown'] }
        : segment),
    },
  }), /未声明的人物/)
})

test('rejects sequences outside the 5–10 second range', async () => {
  const tool = createVideoPlanTool(characters)

  await assert.rejects(() => tool.execute('tool-2', {
    video: {
      ...plan.video,
      videoPrompts: plan.video.videoPrompts.map((segment, index) => index === 0
        ? { ...segment, endTime: 11 }
        : { ...segment, startTime: 11 }),
    },
  }), /每段为 5–10 秒/)
})
