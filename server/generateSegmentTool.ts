import type { AgentTool } from '@earendil-works/pi-agent-core/node'
import { generateSegmentSchema, type TailFrameVisualState } from '../src/types/story.ts'

export const MAX_GENERATE_ATTEMPTS = 3

export const GENERATE_SEGMENT_DESCRIPTION = `触发本段视频生成，程序会暂停回合等待玩家上传生成结果。该段必须已经通过 write_segment 写好；第 2 段起，上一段必须已经生成。每段最多重拍 ${MAX_GENERATE_ATTEMPTS} 次，超过后请改用 write_segment 重写本段，或在 finish_turn 中通过 skipVideo.reason 说明后结束。`

export type SegmentGenerationLookup = {
  sequence: number
  generated?: unknown
  generateAttempts: number
}

export type GenerateSegmentToolOptions = {
  getSegments: () => SegmentGenerationLookup[]
  onGenerate: (input: { sequence: number; toolCallId: string }) => void | Promise<void>
}

export const createGenerateSegmentTool = (
  { getSegments, onGenerate }: GenerateSegmentToolOptions,
): AgentTool<typeof generateSegmentSchema, { pending: true }> => ({
  name: 'generate_segment',
  label: '生成本段视频',
  description: GENERATE_SEGMENT_DESCRIPTION,
  parameters: generateSegmentSchema,
  executionMode: 'sequential',
  execute: async (toolCallId, input) => {
    const segments = getSegments()
    const segment = segments.find((candidate) => candidate.sequence === input.sequence)
    if (!segment) throw new Error(`尚未编写第 ${input.sequence} 段，请先调用 write_segment。`)
    if (input.sequence >= 2) {
      const previous = segments.find((candidate) => candidate.sequence === input.sequence - 1)
      if (!previous?.generated) {
        throw new Error(`第 ${input.sequence - 1} 段尚未生成，请先调用 generate_segment({ sequence: ${input.sequence - 1} })。`)
      }
    }
    if (segment.generateAttempts >= MAX_GENERATE_ATTEMPTS) {
      throw new Error(`第 ${input.sequence} 段已重拍 ${MAX_GENERATE_ATTEMPTS} 次仍未通过，请改用 write_segment 重写本段，或在 finish_turn 中通过 skipVideo.reason 说明原因后结束。`)
    }
    await onGenerate({ sequence: input.sequence, toolCallId })
    return {
      content: [{ type: 'text', text: '等待玩家上传本段视频。' }],
      details: { pending: true },
      terminate: false,
    }
  },
})

export type ResumedGenerationSummaryInput = {
  sequence: number
  isLast: boolean
  plannedSeconds: number
  durationSeconds: number
  visualState: TailFrameVisualState
  remainingAttempts: number
}

// 恢复流程用它拼出 generate_segment 的最终 toolResult 文本；工具本身的 execute 不会再跑一遍。
export const buildResumedGenerationSummary = ({
  sequence,
  isLast,
  plannedSeconds,
  durationSeconds,
  visualState,
  remainingAttempts,
}: ResumedGenerationSummaryInput): string => {
  const nextStep = isLast
    ? '全部段已生成，调用 finish_turn。'
    : `调用 write_segment 写第 ${sequence + 1} 段，首镜构图必须以上述状态为准。`
  const lines = [
    `第 ${sequence} 段已生成：实际时长 ${durationSeconds} 秒（计划 ${plannedSeconds} 秒）。`,
    `尾帧 VLM 实测视觉状态：${JSON.stringify(visualState)}`,
  ]
  if (Math.abs(durationSeconds - plannedSeconds) > 2) {
    lines.push('实际时长与计划相差超过 2 秒，请注意时长变化对后续镜头衔接的影响。')
  }
  lines.push(`判断：若 frame_quality 为“不可用”、人物缺失或与选角外观不符，可重新调用 generate_segment 重拍（本段还可重拍 ${remainingAttempts} 次），或用 write_segment 重写本段；否则${nextStep}`)
  return lines.join('\n')
}
