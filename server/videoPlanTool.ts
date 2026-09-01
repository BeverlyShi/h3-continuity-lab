import type { AgentTool } from '@earendil-works/pi-agent-core/node'
import {
  videoPlanSchema,
  type SceneCharacter,
  type VideoGenerationRequest,
  type VideoPlan,
} from '../src/types/story.ts'

// 模型偶尔会把分镜的 sequence 编重、编乱，这类机械性错误自动修复后再校验，
// 避免为此触发一次本可避免的模型重试。真正的内容问题（时长、连续性、
// 人物引用）仍然交给 assertValidVideoPlan 报错。
export const normalizeVideoPlan = (video: VideoGenerationRequest): VideoGenerationRequest => {
  const sortedSegments = [...video.videoPrompts].sort((a, b) => a.startTime - b.startTime)
  const videoPrompts = sortedSegments.map((segment, index) => {
    const normalized = { ...segment, sequence: index + 1 }
    if (index === 0) delete normalized.transitionFromPrevious
    return normalized
  })
  return { ...video, videoPrompts }
}

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
    const normalizedPlan: VideoPlan = { video: normalizeVideoPlan(plan.video) }
    assertValidVideoPlan(normalizedPlan.video, characters)
    await onPublish?.(normalizedPlan)
    return {
      content: [{ type: 'text', text: '视频计划已提交。' }],
      details: normalizedPlan,
      terminate: true,
    }
  },
})
