import type { AgentTool } from '@earendil-works/pi-agent-core/node'
import { Type } from 'typebox'
import { resolveCharacterCastings } from '../src/services/casting.ts'
import type {
  CastableActor,
  CharacterCasting,
  SceneCastingResult,
} from '../src/types/actor.ts'
import type { SceneCharacter } from '../src/types/story.ts'

const castSceneParameters = Type.Object({}, { additionalProperties: false })

export const createCastSceneTool = (
  characterSource: SceneCharacter[] | (() => SceneCharacter[]),
  actors: CastableActor[],
  existingCastings: CharacterCasting[],
  onPublish?: (result: SceneCastingResult) => void | Promise<void>,
): AgentTool<typeof castSceneParameters, SceneCastingResult> => ({
  name: 'cast_scene',
  label: '为场景选择演员',
  description: '根据 publish_scene 已发布的人物，从演员库匹配演员并保持已有角色的演员连续性。无需参数。',
  parameters: castSceneParameters,
  executionMode: 'parallel',
  execute: async () => {
    const characters = typeof characterSource === 'function' ? characterSource() : characterSource
    if (!characters.length) throw new Error('必须先通过 publish_scene 发布本幕人物。')

    const characterIds = new Set(characters.map((character) => character.id))
    const resolved = resolveCharacterCastings(characters, actors, existingCastings)
    const castings = resolved.filter((casting) => characterIds.has(casting.characterId))
    const castCharacterIds = new Set(castings.map((casting) => casting.characterId))
    const result: SceneCastingResult = {
      castings,
      unmatchedCharacterIds: characters
        .filter((character) => !castCharacterIds.has(character.id))
        .map((character) => character.id),
    }

    await onPublish?.(result)
    return {
      content: [{
        type: 'text',
        text: result.unmatchedCharacterIds.length
          ? `选角完成，${result.unmatchedCharacterIds.length} 个人物暂无匹配演员。`
          : '选角完成。',
      }],
      details: result,
      terminate: true,
    }
  },
})
