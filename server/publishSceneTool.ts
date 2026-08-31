import type { AgentTool } from '@earendil-works/pi-agent-core/node'
import { storySceneSchema, type StoryScene } from '../src/types/story.ts'

export const createPublishSceneTool = (
  onPublish?: (scene: StoryScene) => void | Promise<void>,
): AgentTool<typeof storySceneSchema, StoryScene> => ({
  name: 'publish_scene',
  label: '发布故事场景',
  description: '向玩家发布当前回合的场景标题、叙事和 2–3 个选择。每回合必须调用一次。',
  parameters: storySceneSchema,
  executionMode: 'sequential',
  execute: async (_toolCallId, scene) => {
    await onPublish?.(scene)
    return {
      content: [{ type: 'text', text: '场景已成功发布给玩家。' }],
      details: scene,
      terminate: true,
    }
  },
})
