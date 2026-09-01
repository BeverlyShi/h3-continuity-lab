import type { AgentTool } from '@earendil-works/pi-agent-core/node'
import {
  videoPlanSchema,
  type SceneCharacter,
  type VideoGenerationRequest,
  type VideoPlan,
} from '../src/types/story.ts'

export const assertValidVideoPlan = (video: VideoGenerationRequest, characters: SceneCharacter[]) => {
  const hasContinuousSegments = video.videoPrompts.every((segment, index) => {
    const previous = video.videoPrompts[index - 1]
    return segment.sequence === index + 1
      && segment.startTime === (previous?.endTime ?? 0)
      && (index === 0
        ? segment.transitionFromPrevious === undefined
        : segment.transitionFromPrevious === 'continuous' || segment.transitionFromPrevious === 'cut')
      && segment.endTime - segment.startTime >= 5
      && segment.endTime - segment.startTime <= 10
  })
  const matchesTotalDuration = video.videoPrompts.at(-1)?.endTime === video.totalDuration
  if (!hasContinuousSegments || !matchesTotalDuration) {
    throw new Error('视频片段必须从 0 秒开始连续排列，每段为 5–10 秒，并结束于 totalDuration。')
  }

  const characterIds = new Set(characters.map((character) => character.id))
  const unknownCharacterId = video.videoPrompts
    .flatMap((segment) => segment.characterIds)
    .find((characterId) => !characterIds.has(characterId))
  if (unknownCharacterId) throw new Error(`视频片段引用了未声明的人物 ${unknownCharacterId}。`)
}

export const createVideoPlanTool = (
  characters: SceneCharacter[],
  onPublish?: (plan: VideoPlan) => void | Promise<void>,
): AgentTool<typeof videoPlanSchema, VideoPlan> => ({
  name: 'submit_video_plan',
  label: '提交视频计划',
  description: '为已发布的场景提交视频计划。本工具会本地启动视频生成，每回合只调用一次。',
  parameters: videoPlanSchema,
  executionMode: 'sequential',
  execute: async (_toolCallId, plan) => {
    assertValidVideoPlan(plan.video, characters)
    await onPublish?.(plan)
    return {
      content: [{ type: 'text', text: '视频计划已提交。' }],
      details: plan,
      terminate: true,
    }
  },
})
