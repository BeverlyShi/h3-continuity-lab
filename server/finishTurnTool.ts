import type { AgentTool } from '@earendil-works/pi-agent-core/node'
import { Type, type Static } from 'typebox'

export const finishTurnSchema = Type.Object({
  skipVideo: Type.Optional(Type.Object({
    reason: Type.String({ minLength: 1, maxLength: 200, description: '本幕不生成视频的原因。' }),
  }, { additionalProperties: false })),
}, { additionalProperties: false })

export type FinishTurnInput = Static<typeof finishTurnSchema>

export type FinishTurnToolOptions = {
  // 返回非空字符串时拒绝结束回合，并把缺少的步骤告诉模型。
  check: (input: FinishTurnInput) => string | null
  onFinish?: (input: FinishTurnInput) => void | Promise<void>
}

export const createFinishTurnTool = ({ check, onFinish }: FinishTurnToolOptions): AgentTool<typeof finishTurnSchema, FinishTurnInput> => ({
  name: 'finish_turn',
  label: '结束本回合',
  description: '宣告本回合完成。场景必须已发布；需要视频时必须已提交视频计划，或通过 skipVideo.reason 说明本幕跳过视频。通过后选项开放给玩家。',
  parameters: finishTurnSchema,
  executionMode: 'sequential',
  execute: async (_toolCallId, input) => {
    const blocked = check(input)
    if (blocked) throw new Error(blocked)
    await onFinish?.(input)
    return {
      content: [{ type: 'text', text: '回合已结束。' }],
      details: input,
      terminate: true,
    }
  },
})
