import type { AgentTool } from '@earendil-works/pi-agent-core'
import { Type } from 'typebox'
import type { SceneCharacter, TailFrameVisualState } from '../types/story.ts'
import type { analyzeTailFrame } from './tailFrameVision.ts'

export const inspectLastFrameSchema = Type.Object({}, { additionalProperties: false })

export type InspectLastFrameToolOptions = {
  getPreviousScene: () => { tailFrameDataUrl: string; characters: SceneCharacter[] } | undefined
  visionKey?: string
  analyze: typeof analyzeTailFrame
  signal?: AbortSignal
  onInspect: (state: TailFrameVisualState) => void
}

export const INSPECT_LAST_FRAME_DESCRIPTION = '查看上一场次视频的最后一帧，返回画面里的人物、位置、朝向、景别、光线和画面是否可用。只在本场次要接着上一场次画面拍（opening: continue）时调用；场次内部各段之间不需要调用。结果只用于镜头衔接，剧情事实以已发生的剧情为准。'

export const createInspectLastFrameTool = ({
  getPreviousScene,
  visionKey,
  analyze,
  signal,
  onInspect,
}: InspectLastFrameToolOptions): AgentTool<typeof inspectLastFrameSchema, { state?: TailFrameVisualState }> => ({
  name: 'inspect_last_frame',
  label: '查看上一场次最后一帧',
  description: INSPECT_LAST_FRAME_DESCRIPTION,
  parameters: inspectLastFrameSchema,
  executionMode: 'sequential',
  execute: async () => {
    const previous = getPreviousScene()
    // 没有可接的画面或看不了都不算工具失败：如实告诉导演，由它改用换场景开场。
    const unavailable = !previous
      ? '上一场次没有可接的视频画面，本场次第 1 段只能用 opening: "new_shot"。'
      : !visionKey
        ? '未配置 DeepSeek Key，无法查看上一场次画面，本场次第 1 段只能用 opening: "new_shot"。'
        : undefined
    if (unavailable || !previous || !visionKey) {
      return { content: [{ type: 'text', text: unavailable! }], details: {}, terminate: false }
    }
    const state = await analyze({
      apiKey: visionKey,
      imageUrl: previous.tailFrameDataUrl,
      characters: previous.characters,
      signal,
    })
    onInspect(state)
    return {
      content: [{ type: 'text', text: `上一场次最后一帧：${JSON.stringify(state)}\n只用于镜头衔接，剧情事实以已发生的剧情为准。` }],
      details: { state },
      terminate: false,
    }
  },
})
