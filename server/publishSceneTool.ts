import type { AgentTool } from '@earendil-works/pi-agent-core/node'
import {
  scenePublishSchema,
  type ScenePublish,
} from '../src/types/story.ts'

export const assertValidScenePublish = (turn: ScenePublish) => {
  const choiceIds = new Set(turn.scene.choices.map((choice) => choice.id))
  if (choiceIds.size !== 3 || !(['1', '2', '3'] as const).every((id) => choiceIds.has(id))) {
    throw new Error('剧情选项必须各使用一次 ID 1、2、3。')
  }

  const characterIds = new Set<string>()
  for (const character of turn.characters) {
    if (characterIds.has(character.id)) throw new Error(`人物 ID ${character.id} 重复。`)
    if (character.minAge > character.maxAge) throw new Error(`人物 ${character.name} 的年龄区间无效。`)
    characterIds.add(character.id)
  }
}

export const createPublishSceneTool = (
  onPublish?: (turn: ScenePublish) => void | Promise<void>,
): AgentTool<typeof scenePublishSchema, ScenePublish> => ({
  name: 'publish_scene',
  label: '发布故事场景',
  description: '提交当前回合的场景和主要人物。本工具会本地发布场景，每回合只调用一次。',
  parameters: scenePublishSchema,
  executionMode: 'sequential',
  execute: async (_toolCallId, turn) => {
    assertValidScenePublish(turn)
    await onPublish?.(turn)
    return {
      content: [{ type: 'text', text: '场景已发布。' }],
      details: turn,
      terminate: false,
    }
  },
})
