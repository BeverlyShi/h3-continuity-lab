import type { AgentTool } from '@earendil-works/pi-agent-core/node'
import { videoGenerationRequestSchema, type VideoGenerationRequest } from '../src/types/story.ts'

export const createGenerateVideoTool = (
  onRequest?: (request: VideoGenerationRequest) => void | Promise<void>,
): AgentTool<typeof videoGenerationRequestSchema, VideoGenerationRequest> => ({
  name: 'generate_video',
  label: '生成场景视频',
  description: '提交一段文生视频任务：输入总时长和按时间分段描述的画面 prompt，任务异步生成，调用后立即返回。',
  parameters: videoGenerationRequestSchema,
  executionMode: 'sequential',
  execute: async (_toolCallId, request) => {
    await onRequest?.(request)
    return {
      content: [{ type: 'text', text: '视频生成任务已提交，正在后台生成。请继续调用 publish_scene 发布场景。' }],
      details: request,
      terminate: false,
    }
  },
})
