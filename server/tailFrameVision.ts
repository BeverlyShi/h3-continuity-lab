import { Check } from 'typebox/value'
import {
  tailFrameVisualStateSchema,
  type SceneCharacter,
  type TailFrameVisualState,
} from '../src/types/story.ts'

export const DEEPSEEK_VISION_MODEL = 'deepseek-v4-flash-vision-exp'
const DEEPSEEK_CHAT_URL = 'https://api.deepseek.com/chat/completions'
const REQUEST_TIMEOUT_MS = 45_000
const MAX_ATTEMPTS = 3

type VisionResponse = {
  choices?: Array<{ message?: { content?: string | null } }>
  error?: { message?: string }
}

const buildVisionPrompt = (characters: SceneCharacter[]) => `请分析这张视频尾帧，只描述画面中实际可见的内容，并输出 json。

本幕登记人物：${characters.map((character) => `${character.id}=${character.name}`).join('；') || '无'}。
characters.id 只能使用上述登记 ID。无法确认身份的人物不要加入 characters；画面无人时返回空数组。

严格输出以下结构，不要 Markdown，不要补充说明：
{
  "shot_size": "远景|全景|中景|中近景|近景|特写",
  "shot_position": "镜头相对人物的方位和高度",
  "shot_content": {
    "characters": [{
      "id": "登记人物ID",
      "facing": "朝向",
      "position_in_frame": "画面位置",
      "pose": "姿势",
      "expression": "表情",
      "holding": null,
      "appearance_notes": null
    }],
    "scene": {
      "location": "地点",
      "visible_elements": "可见场景元素",
      "lighting": "光线",
      "time_of_day": "时间"
    },
    "key_props": []
  },
  "frame_quality": "清晰稳定|轻微模糊|不可用"
}`

export type AnalyzeTailFrameInput = {
  apiKey: string
  imageUrl: string
  characters: SceneCharacter[]
  signal?: AbortSignal
}

export async function analyzeTailFrame({
  apiKey,
  imageUrl,
  characters,
  signal,
}: AnalyzeTailFrameInput): Promise<TailFrameVisualState> {
  const knownIds = new Set(characters.map((character) => character.id))
  let lastError: unknown

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      const response = await fetch(DEEPSEEK_CHAT_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: DEEPSEEK_VISION_MODEL,
          messages: [{
            role: 'user',
            content: [
              { type: 'text', text: buildVisionPrompt(characters) },
              { type: 'image_url', image_url: { url: imageUrl, detail: 'original' } },
            ],
          }],
          response_format: { type: 'json_object' },
          max_tokens: 1_200,
        }),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      })
      const payload = await response.json() as VisionResponse
      if (!response.ok) {
        throw new Error(payload.error?.message ?? `DeepSeek Vision 请求失败（${response.status}）。`)
      }
      const content = payload.choices?.[0]?.message?.content
      if (!content?.trim()) throw new Error('DeepSeek Vision 返回了空内容。')
      const state = JSON.parse(content) as TailFrameVisualState
      if (!Check(tailFrameVisualStateSchema, state)) {
        throw new Error('DeepSeek Vision 返回的尾帧状态不符合 schema。')
      }
      const unknownId = state.shot_content.characters.find((character) => !knownIds.has(character.id))?.id
      if (unknownId) throw new Error(`DeepSeek Vision 返回了未登记人物 ${unknownId}。`)
      return state
    } catch (error) {
      lastError = error
    }
  }

  throw lastError instanceof Error ? lastError : new Error('尾帧视觉识别失败。')
}
