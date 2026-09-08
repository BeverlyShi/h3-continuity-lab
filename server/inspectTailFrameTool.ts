import type { AgentTool } from '@earendil-works/pi-agent-core/node'
import { Type, type Static } from 'typebox'
import { sceneCharacterSchema, type TailFrameVisualState } from '../src/types/story.ts'
import { analyzeTailFrame } from './tailFrameVision.ts'

export const inspectTailFrameSchema = Type.Object({
  imageUrl: Type.String({ minLength: 1, maxLength: 1_000_000 }),
  characters: Type.Array(sceneCharacterSchema, { maxItems: 8 }),
}, { additionalProperties: false })

type InspectTailFrameInput = Static<typeof inspectTailFrameSchema>
type InspectTailFrameResult = { state: TailFrameVisualState }

export const createInspectTailFrameTool = (
  deepSeekApiKey: string,
): AgentTool<typeof inspectTailFrameSchema, InspectTailFrameResult> => ({
  name: 'inspect_tail_frame',
  label: '识别视频尾帧',
  description: '仅使用 DeepSeek Vision 把一张视频尾帧转换成结构化视觉状态。',
  parameters: inspectTailFrameSchema,
  executionMode: 'sequential',
  execute: async (_toolCallId, input: InspectTailFrameInput) => {
    const state = await analyzeTailFrame({
      apiKey: deepSeekApiKey,
      imageUrl: input.imageUrl,
      characters: input.characters,
    })
    return {
      content: [{ type: 'text', text: JSON.stringify(state) }],
      details: { state },
      terminate: true,
    }
  },
})
